/**
 * acpEvents.js — 纯函数：把 ACP 事件解析为对 OpenAI 转换有意义的片段。
 *
 * 这是 streaming 与 non-streaming 两条路径共用的唯一解析点：
 * 新增事件类型只需在这里加一次处理。
 */

/**
 * 从 agent_message_chunk / agent_thought_chunk 的 content 中提取文本。
 * content 可能是 string 或 {type, text} 对象。
 */
export function contentToText(content) {
  if (typeof content === 'string') return content;
  if (content && typeof content === 'object' && typeof content.text === 'string') {
    return content.text;
  }
  return '';
}

/**
 * 检测文本是否是 DSML 格式的工具调用（某些模型会把工具调用以文本形式输出）。
 * 格式示例：<| | DSML | | calls> <| | DSML | | invoke name="WebFetch"> ...
 *
 * 为减少误伤（用户消息恰好包含这些字符串），要求 DSML 出现在行首或文本开头。
 * @param {string} text
 * @returns {boolean}
 */
export function isDsmToolCall(text) {
  if (typeof text !== 'string') return false;
  // DSML 标签通常在行首或文本开头出现
  const trimmed = text.trimStart();
  return (trimmed.startsWith('<|') || trimmed.includes('\n<|'))
    && text.includes('DSML')
    && (text.includes('calls>') || text.includes('invoke'));
}

/**
 * 解析单个 ACP session/update 事件，返回规范化片段。
 *
 * @param {object} event 原始 ACP 事件（已 JSON.parse）
 * @returns {{type: 'delta'|'reasoning'|'usage'|'progress'|'other', text?, usage?, reason?, progress?, phase?} | null}
 *   - type 'delta':     agent_message_chunk，text 为内容增量
 *   - type 'reasoning': agent_thought_chunk，text 为思考增量
 *   - type 'usage':     usage_update，usage 为 {prompt_tokens, completion_tokens}
 *   - type 'progress':  session_info_update 中的进度/阶段信息
 *   - type 'other':     其他 session/update 子事件
 *   - null:             不是 session/update 事件
 */
export function parseAcpUpdate(event) {
  if (!event || event.method !== 'session/update') return null;
  const update = event.params?.update;
  if (!update) return null;

  switch (update.sessionUpdate) {
    case 'agent_message_chunk': {
      const text = contentToText(update.content);
      // 某些模型（如 deepseek-v4.1-flash）会把工具调用以 DSML 文本形式输出，
      // 而不是走标准的 _codebuddy.ai/delegateTool 事件。过滤掉这种"伪文本"。
      if (text && isDsmToolCall(text)) {
        return { type: 'other', reason: 'DSM tool call text' };
      }
      return text ? { type: 'delta', text } : { type: 'other' };
    }
    case 'agent_thought_chunk': {
      const text = contentToText(update.content);
      return text ? { type: 'reasoning', text } : { type: 'other' };
    }
    case 'usage_update': {
      const usage = update._meta?.usage;
      if (usage && typeof usage === 'object') {
        // 缓存命中/未命中：prompt_tokens 的大头（工具定义 + 系统提示等固定前缀）
        // 几乎全部命中前缀缓存，实际计费只按 miss 部分。
        //
        // 关键坑：CLI 实测会上报 cached_tokens: 0（是数值 0 而非缺省），同时把
        // 真实命中量放在 prompt_cache_miss_tokens 里。若直接采信 cached_tokens，
        // 整段被命中的前缀会被记成未命中——表现就是"每条请求都烧 2.3 万 token"。
        // 因此显式命中字段仅在为正时采用，否则由 prompt - miss 推导。
        let cachedTokens = usage.prompt_cache_hit_tokens ?? usage.cached_tokens;
        const missTokens = usage.prompt_cache_miss_tokens;
        if (!cachedTokens && typeof usage.prompt_tokens === 'number' && typeof missTokens === 'number') {
          cachedTokens = Math.max(0, usage.prompt_tokens - missTokens);
        }
        return {
          type: 'usage',
          usage: {
            prompt_tokens: usage.prompt_tokens,
            completion_tokens: usage.completion_tokens,
            ...(cachedTokens != null ? { cached_tokens: cachedTokens } : {}),
            ...(missTokens != null ? { cache_miss_tokens: missTokens } : {}),
            // credit 计费额（网关 usage.credit，单位同账号余额）
            ...(usage.credit != null ? { credit: usage.credit } : {}),
            // 网关若在 usage 里报告实际模型 id（字段名随版本可能是 model /
            // modelId），透传给 token 统计；拿不到则由调用方回落到请求参数
            ...(usage.model || usage.modelId ? { model: usage.model || usage.modelId } : {})
          }
        };
      }
      return { type: 'other' };
    }
    case 'session_info_update': {
      const meta = update._meta || {};
      const phase = meta['codebuddy.ai/agentPhase']?.phase;
      // progress 字段可能是字符串，也可能是 {text, ...} 对象，也可能为 null
      const rawProgress = meta['codebuddy.ai/progress'];
      const progress = rawProgress != null
        ? (typeof rawProgress === 'string' ? rawProgress : contentToText(rawProgress))
        : null;

      if (progress || phase) {
        return { type: 'progress', progress, phase };
      }
      return { type: 'other' };
    }
    default:
      return { type: 'other' };
  }
}

/**
 * 从模型选项的 description 解析计费系数。
 * 网关用 "x0.79" 这样的倍数标注各模型价格，x0.00 即免费。
 *
 * @returns {number|null} 系数；网关未标注（如 auto）或不可解析时为 null
 */
export function parseModelCoefficient(description) {
  if (typeof description !== 'string') return null;
  const m = description.trim().match(/^x\s*(\d+(?:\.\d+)?)$/i);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

/**
 * 从 session/new 的 result.configOptions 中提取模型列表。
 * WorkBuddy 的 configOptions 中 id === 'model' 的 select 项携带全部可用模型。
 *
 * 计费系数（coefficient/free）只在网关标注时附带：**缺省不等于免费**，
 * 例如 auto 没有标注，但仍按它实际路由到的模型计费。
 *
 * @returns {Array<{id: string, name: string, coefficient?: number, free?: boolean}>}
 *          模型列表，解析失败时为空数组
 */
export function extractModelsFromSessionResult(result) {
  if (!result || !Array.isArray(result.configOptions)) return [];
  const modelOption = result.configOptions.find(opt => opt?.id === 'model');
  if (!modelOption || !Array.isArray(modelOption.options)) return [];
  const models = modelOption.options
    .filter(opt => opt && typeof opt.value === 'string')
    .map(opt => {
      const entry = { id: opt.value, name: opt.name || opt.value };
      const coefficient = parseModelCoefficient(opt.description);
      if (coefficient != null) {
        entry.coefficient = coefficient;
        entry.free = coefficient === 0;
      }
      return entry;
    });
  // currentValue（会话默认模型）不一定出现在 options 里（如 glm-5.3-flash 是
  // 隐藏默认项：不在下拉列表但 setModel 可用）。缺了会让 /v1/models 漏报实际可用的模型。
  const current = modelOption.currentValue;
  if (typeof current === 'string' && current && !models.some(m => m.id === current)) {
    models.unshift({ id: current, name: current });
  }
  return models;
}

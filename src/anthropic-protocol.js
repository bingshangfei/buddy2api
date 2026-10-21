/**
 * anthropic-protocol.js — Anthropic Messages API → 内部消息形状的翻译（纯函数）。
 *
 * 设计要点：**翻译而不是分支**。
 *
 * Anthropic 与 OpenAI 的差异集中在两处，翻译层各自消解一次：
 *   1. 顶层 `system` 参数 → 内部 `{role:'system'}` 消息（OpenAI 的 system 本来就在 messages 里）
 *   2. `tool_result` / `tool_use` 块 → 内部 `{role:'tool'}` / `{role:'assistant', tool_calls}`
 *
 * 消解之后，工具续跑判定（`messages.some(m => m.role === 'tool')`）、
 * 前缀亲和（`_conversationId` 用首条 user 消息指纹）、`buildPrompt` 的
 * `[Tool result for …]` / `[Assistant tool call: …]` 格式化**全部原样复用**。
 *
 * 不这样做的话有两条坏路：要么在 prompt-builder 里加协议分支（污染 OpenAI 路径），
 * 要么在 handler 里到处判协议。现状是 contentToAcpBlocks 对 Anthropic 的
 * tool_result / tool_use 块**静默丢弃**（不报错不留日志），照搬会把工具闭环
 * 表现成「模型收不到结果于是重复调用」——极难排查。
 */

import { contentPartToAcpBlock } from './prompt-builder.js';
import { resolveDefaultModel } from './model-policy.js';

/**
 * `claude-*` 前缀判定：Anthropic 客户端（workbuddy / anthropic SDK）必然发这类 id，
 * 而网关没有这些 id。OpenAI 路径的「原样透传 + 告警 + 会话留在默认模型」对
 * Anthropic 客户端等于每请求都告警且默认烧积分，故单独映射。
 */
export function isClaudeModelId(id) {
  return typeof id === 'string' && /^claude/i.test(id);
}

/**
 * 解析 Anthropic 请求的模型 id。
 *
 * - `claude-*` → 映射到代理默认模型（客户端以为在用 Claude，实际用免费的默认模型）
 * - 其他 id → 原样透传（与 OpenAI 路径一致，网关不认识的隐藏 id 仍可尝试）
 * - 缺省 / `auto` / `default` → 代理默认模型（Anthropic 规范要求 model 必填，
 *   但缺省时报错会让请求整个失败，回落更友好）
 *
 * 映射目标用 `BUDDY2API_ANTHROPIC_MODEL` 覆盖。
 * 注意：**响应仍回显客户端原始请求名**（见 response-builder 的 echoModel），
 * 客户端契约不受影响。
 */
export function resolveAnthropicModel(requested, env = process.env) {
  const fallback = env.BUDDY2API_ANTHROPIC_MODEL || resolveDefaultModel(env);
  if (!requested || requested === 'auto' || requested === 'default') return fallback;
  if (isClaudeModelId(requested)) return fallback;
  return requested;
}

/**
 * thinking 回落默认（默认关闭，显式 `BUDDY2API_ANTHROPIC_THINKING=1` 才开）。
 *
 * 语义自 2026-09-17 起**收窄为「请求未携带 thinking 时的默认值」**——正常路径
 * 由客户端的 `thinking.type` 决定（见 resolveAnthropicThinking）。
 */
export function anthropicThinkingEnabled(env = process.env) {
  return env.BUDDY2API_ANTHROPIC_THINKING === '1';
}

/**
 * 请求驱动 thinking 决策：Anthropic 规范里思考的可见性是**按请求 opt-in** 的
 * 契约（`thinking.type`），不是一个进程级开关——同一个代理要服务多个客户端，
 * 全局环境变量在架构上无法表达「A 客户端要、B 客户端不要」。
 *
 * 取值口径（宽容解析，规范仍在演进）：
 *   - `enabled`  → 开（经典形态，常伴 `budget_tokens`）
 *   - `adaptive` → 开（新形态，配合 `output_config.effort`）
 *   - `disabled` → 关（**压过环境变量**：客户端显式说不要就是不要）
 *   - 缺失 / 未知 type / 非对象 / null → 回落 `anthropicThinkingEnabled(env)`
 *
 * `display` 也参与判断（SDK 1.6.0 `ThinkingConfigEnabledParam.display:
 * Optional[Literal['summarized','omitted']]`）：`omitted` 表示「不回思考正文、
 * 只留签名」。本代理产不出真签名，照发就等于无视客户端的显式省略请求，
 * 因此唯一诚实的动作是**按不可见处理**。`summarized`（默认）与未知值都照发。
 *
 * 未知值一律回落而不报 400：规范新增取值时，旧代理不该把请求打死。
 * `budget_tokens` 只作为「开启」的伴随字段出现——上游 ACP 不支持按 token
 * 预算分配，本代理不实现真实预算控制（见 README 取舍说明）。
 *
 * @param {unknown} thinking 请求体里的 `thinking` 字段（任意类型都不得抛错）
 * @param {object} [env]
 * @returns {boolean}
 */
export function resolveAnthropicThinking(thinking, env = process.env) {
  const fallback = anthropicThinkingEnabled(env);
  if (!thinking || typeof thinking !== 'object' || Array.isArray(thinking)) return fallback;
  if (thinking.type === 'disabled') return false;
  if (thinking.type !== 'enabled' && thinking.type !== 'adaptive') return fallback;
  if (thinking.display === 'omitted') return false;
  return true;
}

/** 顶层 system（字符串或块数组）→ 纯文本。 */
function systemToText(system) {
  if (typeof system === 'string') return system;
  if (Array.isArray(system)) {
    return system
      .filter(b => b && typeof b.text === 'string')
      .map(b => b.text)
      .filter(Boolean)
      .join('\n\n');
  }
  return '';
}

/**
 * tool_result 块 → 内部 tool 消息的文本。
 *
 * Anthropic 的 `content` 既可能是字符串，也可能是块数组；`is_error` 表示这次
 * 工具执行失败。三者都必须让模型看得出来，否则它会把失败当成成功继续编。
 */
function toolResultToText(block) {
  const inner = block.content;
  let text = '';
  if (typeof inner === 'string') {
    text = inner;
  } else if (Array.isArray(inner)) {
    text = inner
      .filter(b => b && b.type === 'text' && typeof b.text === 'string')
      .map(b => b.text)
      .join('\n');
  }
  if (block.is_error) return text ? `[error] ${text}` : '[error]';
  return text || '(empty tool result)';
}

/**
 * Anthropic 图片块中**来源为远程 URL** 的那种 → OpenAI 的 `image_url` 形状，
 * 由 handler 里带 SSRF 守卫的 `_resolveRemoteImages` 抓成 data URL（ACP 只吃 base64）。
 *
 * base64 来源与 ACP 原生形状**不在这里判断**：`contentPartToAcpBlock`
 * （prompt-builder）已原生支持两者，是 ACP 图像块形状的唯一构造点——在此重复一遍
 * 只会让同一种形状有两个来源，改一处漏一处。
 *
 * @returns {{type:'image_url', image_url:{url:string}}|null} 非远程 URL 一律 null
 */
function anthropicRemoteImagePart(block) {
  if (!block || block.type !== 'image') return null;
  const src = block.source;
  if (src && src.type === 'url' && typeof src.url === 'string') {
    return { type: 'image_url', image_url: { url: src.url } };
  }
  return null;
}

/**
 * Anthropic 工具定义 → OpenAI function 形状（acp-client.delegateTools 吃后者）。
 * 缺 `input_schema` 时补空 object schema——网关不接受 undefined parameters。
 *
 * Q1 非目标：**服务端工具一律忽略**。Anthropic 的服务端工具用 `type` 判别且
 * 没有 `input_schema`（`web_search_20250305` / `computer_use_20250124` /
 * `bash_20250124` / `text_editor_20250124` …），语义是「由 Anthropic 后端执行」。
 * 本代理是自建网关，没有对应的服务端执行器；若不滤掉，它们会被注册成**委托
 * 工具**交给客户端模型去调，客户端拿到一个自己没声明过的工具调用（协议上不
 * 违规但语义完全不同，且 `input_schema` 缺失让我们补出空 schema → 调用必然
 * 无参数）。滤掉后请求退化成「无工具」的纯对话，是唯一诚实的降级。
 *
 * 只接受 Anthropic 的用户自定义工具两种写法：`{name, input_schema}`
 * （无 type）与 `{type: 'custom', name, input_schema}`。
 */
export function translateAnthropicTools(tools) {
  if (!Array.isArray(tools)) return undefined;
  const out = tools
    .filter(t => t && typeof t.name === 'string' && (!t.type || t.type === 'custom'))
    .map(t => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description || '',
        parameters: t.input_schema || { type: 'object', properties: {} }
      }
    }));
  return out.length > 0 ? out : undefined;
}

/**
 * Anthropic 请求体 → 内部请求形状（handleChatCompletions 直接消费）。
 *
 * 返回对象与 OpenAI 请求同形（messages / tools / model / stream），额外带
 * `protocol: 'anthropic'` 供 handler 选择 wire（sink / 响应构造），以及
 * `thinkingEnabled`——**thinking 决策的唯一产生点**：在这里读一次请求参数 +
 * 环境变量，决策结果随请求对象下行、存进 state 并随挂起表透传，续跑不重读。
 *
 * Q5：`max_tokens` / `temperature` / `top_p` / `top_k` / `stop_sequences` /
 * `tool_choice` / `metadata` 一律**接受但忽略语义**——`max_tokens` 是 Anthropic
 * 的必填字段，报错会让所有请求失败（代价见 README：客户端以为有硬上限，实际没有）。
 *
 * @param {object} body 原始 Anthropic 请求体
 * @returns {{protocol:'anthropic', messages:Array, tools:Array|undefined, model:any, stream:boolean, thinkingEnabled:boolean}}
 */
export function translateAnthropicRequest(body = {}) {
  const messages = [];

  const sys = systemToText(body.system);
  if (sys) messages.push({ role: 'system', content: sys });

  const source = Array.isArray(body.messages) ? body.messages : [];
  for (const msg of source) {
    if (!msg) continue;
    const role = msg.role === 'assistant' ? 'assistant' : 'user';
    const blocks = Array.isArray(msg.content)
      ? msg.content
      : [{ type: 'text', text: typeof msg.content === 'string' ? msg.content : '' }];

    if (role === 'assistant') {
      const content = [];
      const toolCalls = [];
      for (const b of blocks) {
        if (!b) continue;
        if (b.type === 'tool_use') {
          toolCalls.push({
            id: b.id,
            type: 'function',
            function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) }
          });
        } else if (b.type === 'thinking' || b.type === 'redacted_thinking') {
          // thinking 不回灌：规范要求 thinking 块带 signature 才能下一轮回传，
          // 代理产不出真 signature，回灌只会给模型喂噪音（Q4 同类取舍）。
          continue;
        } else if (b.type === 'text' || (!b.type && typeof b.text === 'string')) {
          if (b.text) content.push({ type: 'text', text: b.text });
        } else {
          const img = anthropicRemoteImagePart(b) || contentPartToAcpBlock(b);
          if (img) content.push(img);
        }
      }
      const out = { role: 'assistant', content };
      // tool_calls 只在非空时挂，否则 buildPrompt 会打出空的 [Assistant tool call]
      if (toolCalls.length > 0) out.tool_calls = toolCalls;
      messages.push(out);
      continue;
    }

    // user：文本/图片 与 tool_result 必须拆成不同内部消息（角色不同），
    // 但**保持原顺序**——buildPrompt 按消息顺序拼接，顺序错会让模型对错结果。
    let group = [];
    const flush = () => {
      if (group.length > 0) {
        messages.push({ role: 'user', content: group });
        group = [];
      }
    };
    for (const b of blocks) {
      if (!b) continue;
      if (b.type === 'tool_result') {
        flush();
        messages.push({
          role: 'tool',
          tool_call_id: b.tool_use_id,
          content: toolResultToText(b)
        });
      } else if (b.type === 'text' || (!b.type && typeof b.text === 'string')) {
        if (b.text) group.push({ type: 'text', text: b.text });
      } else {
        const img = anthropicRemoteImagePart(b) || contentPartToAcpBlock(b);
        if (img) group.push(img);
      }
    }
    flush();
  }

  return {
    protocol: 'anthropic',
    messages,
    tools: translateAnthropicTools(body.tools),
    model: body.model,
    stream: body.stream === true,
    thinkingEnabled: resolveAnthropicThinking(body.thinking)
  };
}

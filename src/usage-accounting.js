/**
 * usage-accounting.js — token 估算口径的唯一 module interface（架构深化第 8 批 C2）。
 *
 * 从 token-stats.js 出仓：估算口径此前散在 4 个文件（token-stats / anthropic-sink /
 * response-builder / openai-handler），每处独立对全上下文跑正则 match——match 返回
 * 全量匹配数组只为取 length，大上下文下每次 ~MB 级垃圾。本模块单遍码元循环（零
 * 中间分配），并把 prompt 估算按**引用**缓存：一次 HTTP 请求内 message_start /
 * message_delta / 非流式收尾 / 记账四类消费点共用同一份 state.prompt 引用，扫一遍
 * 即可；续写更新 state.prompt 是整体换引用（openai-handler.js 续写段），WeakMap
 * 自然失效——缓存的失效机制就是引用本身，无需任何手动清理。
 *
 * 口径契约（与旧实现逐码元等价，tests/usage-accounting.test.js 锁定）：
 *   CJK（汉字 \u3400-\u4dbf\u4e00-\u9fff + CJK 标点 \u3000-\u303f + 全角 \uff00-\uffef）
 *   按 1 token/字；其余按 4 字符/token；向上取整。
 *   CJK 区间全在 BMP（1 码元/字），故按 UTF-16 码元分类与旧正则 match 完全等价——
 *   emoji 等代理对字符（2 码元，非 CJK）两侧都落入 other 侧按 2 计，无口径漂移。
 *
 * 双口径（调用方按语义选择，不许一个函数包打）：
 *   - **纯估算**：estimatePromptTokens / estimateTokens / estimateOutputTokens
 *   - **reported 优先**：调用方先取 usage 上报值，`Number(x) || estimate…` 兜底
 *     （message_start 的 input_tokens 是现状**无条件**估算，与 message_delta /
 *     非流式的 `reported || estimate` 口径并存——这是在案差异，勿"统一"）。
 *   - output 侧**刻意不缓存**：content/reasoning 是持续累加的字符串，消费时点现算
 *     才与旧口径一致（message_start / finish / record 三处时点语义不同）。
 */

/**
 * 粗略 token 估算（网关不回传 usage 时的兜底口径）：单遍码元循环，零中间分配。
 *
 * @param {string} text
 * @returns {number}
 */
export function estimateTokens(text) {
  if (!text) return 0;
  let cjk = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if ((code >= 0x3400 && code <= 0x4dbf) || (code >= 0x4e00 && code <= 0x9fff)
      || (code >= 0x3000 && code <= 0x303f) || (code >= 0xff00 && code <= 0xffef)) {
      cjk++;
    }
  }
  const other = text.length - cjk;
  return Math.ceil(cjk + other / 4);
}

/**
 * 输出侧两段估算：content + reasoning 分别扫描、合并一次取整。
 * 与旧口径 `estimateTokens((content || '') + (reasoning || ''))` 等价
 * （拼接保序、逐码元分类与拼接无关），但省掉整段拼接的字符串分配。
 * 前置条件：入参为 string | undefined | null（种子恒为字符串；非字符串真值
 * 的强转计数差异不在等价承诺内，勿传）。
 *
 * @param {string|undefined|null} content
 * @param {string|undefined|null} reasoning
 * @returns {number}
 */
export function estimateOutputTokens(content, reasoning) {
  let cjk = 0;
  let other = 0;
  for (const part of [content, reasoning]) {
    if (!part) continue;
    for (let i = 0; i < part.length; i++) {
      const code = part.charCodeAt(i);
      if ((code >= 0x3400 && code <= 0x4dbf) || (code >= 0x4e00 && code <= 0x9fff)
        || (code >= 0x3000 && code <= 0x303f) || (code >= 0xff00 && code <= 0xffef)) {
        cjk++;
      } else {
        other++;
      }
    }
  }
  return Math.ceil(cjk + other / 4);
}

/**
 * ACP prompt 内容块的文本 token 估算（只算 text 块；图片 base64 无法按文本估，
 * 且图片 token 数模型相关，忽略——图片请求的统计会偏低）。
 *
 * @param {Array|object|string} prompt ACP prompt（content blocks 或字符串）
 * @returns {number}
 */
export function estimatePromptTokens(prompt) {
  if (typeof prompt === 'string') return estimateTokens(prompt);
  if (!Array.isArray(prompt)) return 0;
  return prompt.reduce((sum, block) =>
    sum + (block?.type === 'text' && typeof block.text === 'string' ? estimateTokens(block.text) : 0), 0);
}

// prompt 估算的引用缓存（模块级 WeakMap：条目随 prompt 对象一起被 GC）
const promptCache = new WeakMap();

/**
 * state.prompt 消费点的缓存入口：同一 prompt **引用**重复消费（同一请求内
 * message_start / finish / record 等 3-5 处）只扫一遍。字符串 prompt（如
 * count_tokens 的 buildPrompt 产物走 estimatePromptTokens 纯函数路径）与
 * 非对象直通计算。
 *
 * @param {Array|object|string|null} prompt
 * @returns {number}
 */
export function observePromptTokens(prompt) {
  if (prompt && typeof prompt === 'object') {
    const hit = promptCache.get(prompt);
    if (hit !== undefined) return hit;
    const value = estimatePromptTokens(prompt);
    promptCache.set(prompt, value);
    return value;
  }
  return estimatePromptTokens(prompt);
}

/**
 * response-builder.js — OpenAI / Anthropic 响应对象构造（纯函数，从 openai-handler.js 拆出）。
 *
 * Anthropic 变体（buildAnthropicMessage / buildAnthropicToolUseResponse）与
 * OpenAI 变体并列：形状差异大（content blocks + stop_reason + input/output_tokens），
 * 强行归一反而两边都不像，所以各自独立构造，由 handler 的薄包装按 protocol 分派。
 */

import { observePromptTokens, estimateOutputTokens } from './usage-accounting.js';
import { messageEnvelope } from './anthropic-wire.js';

/**
 * 思考回显的开关口径：`!== false`（缺省 = 开）。
 *
 * 与 Anthropic 侧的 `=== true` **不同**，是有意的方向差异——两侧「未携带时的
 * 默认值」相反（OpenAI 既有行为是始终回显），故缺省兜底方向也相反。用
 * `=== true` 会让 router 之外的直接调用方（测试/脚本，其 state 可能不带该字段）
 * 静默失去思考，与「默认开」契约符号相反。
 *
 * ⚠ 未来不要为了"两协议统一"把这里改成 `=== true`。
 */
function reasoningVisible(state) {
  return Boolean(state?.reasoning) && state?.thinkingEnabled !== false;
}

/**
 * 构造非流式 tool_calls 挂起响应（工具调用 → 暂停等客户端执行）。
 */
export function buildToolCallResponse(state, toolEvent, completionId, created, model) {
  const message = {
    role: 'assistant',
    content: state.content || null,
    tool_calls: [{
      id: toolEvent.toolCallId, type: 'function',
      function: { name: toolEvent.name, arguments: JSON.stringify(toolEvent.args) }
    }]
  };
  // 与自然结束同口径：同一请求参数下，「是否调工具」不该决定客户端能否看到思考。
  if (reasoningVisible(state)) message.reasoning_content = state.reasoning;
  return {
    id: completionId, object: 'chat.completion', created, model,
    choices: [{ index: 0, message, finish_reason: 'tool_calls' }],
    usage: buildUsage(state.usage)
  };
}

/**
 * 构造非流式最终响应（含可选 reasoning_content 回显）。
 */
export function buildFinalResponse(state, completionId, created, model) {
  const message = { role: 'assistant', content: state.content };
  if (reasoningVisible(state)) message.reasoning_content = state.reasoning;
  return {
    id: completionId, object: 'chat.completion', created, model,
    choices: [{ index: 0, message, finish_reason: 'stop' }],
    usage: buildUsage(state.usage)
  };
}

/**
 * 归一化 usage 字段。
 *
 * 网关上报了缓存信息时补 `prompt_tokens_details.cached_tokens`（OpenAI 标准
 * 字段），让客户端一眼看出 PROMPT 里绝大多数是命中前缀缓存的部分——否则
 * 只看 prompt_tokens 会以为每条请求都在烧两三万 token。
 */
export function buildUsage(usage) {
  const u = usage || {};
  const promptTokens = u.prompt_tokens || 0;
  const completionTokens = u.completion_tokens || 0;
  const result = {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens
  };
  if (typeof u.cached_tokens === 'number') {
    result.prompt_tokens_details = { cached_tokens: u.cached_tokens };
  }
  return result;
}

// ===== Anthropic Messages API =====

/**
 * Anthropic usage 形状：input_tokens / output_tokens（不是 prompt_/completion_）。
 *
 * 网关不报 usage 时按文本估算，和 OpenAI 路径同口径——不能回 0，
 * 否则客户端把每次请求都显示成"0 token"。
 */
export function buildAnthropicUsage(state) {
  const u = state?.usage || {};
  return {
    input_tokens: Number(u.prompt_tokens) || observePromptTokens(state?.prompt),
    output_tokens: Number(u.completion_tokens) || estimateOutputTokens(state?.content, state?.reasoning)
  };
}

/**
 * 响应回显的模型名：客户端**原始**请求值（如 `claude-sonnet-4-5-…`）。
 * 映射到代理默认模型是内部行为，不能把映射结果漏给客户端——否则客户端的
 * 模型路由/埋点会拿到一个它不认识的 id。
 */
function echoModelOf(state, model) {
  return state?.echoModel || model || 'unknown';
}

/**
 * thinking 块的**初始载荷**（流式 `content_block_start` 用：正文随后由
 * `thinking_delta` 逐片填充）。签名口径与 `buildThinkingBlock` 共用此处，
 * 全局只定义一次——三处各抄一份字面量早晚会漂移成"合法但判别符不符"的帧。
 */
export function thinkingBlockStart() {
  return { type: 'thinking', thinking: '', signature: '' };
}

/**
 * thinking 块（`thinkingEnabled` 时随响应返回）。
 *
 * `signature` **必须给**（取空串）：Anthropic SDK 的 `ThinkingBlock.signature`
 * 是必填字段、无默认值，**省略**会让严格校验模式（`_strict_response_validation`）
 * 抛 `APIResponseValidationError`——原注释把因果说反了，"不发"才崩。空串是
 * 诚实语义（本代理不产真签名），也是主流商业实现的做法（DashScope 官方文档：
 * 「`content.signature`：thinking 类型时的签名，当前固定为空字符串」）。
 */
function buildThinkingBlock(state, enabled) {
  if (!enabled || !state?.reasoning) return [];
  return [{ ...thinkingBlockStart(), thinking: state.reasoning }];
}

/**
 * 构造非流式 Anthropic message（自然结束）。
 *
 * content 至少含一个块——空数组会被 SDK 视为非法消息。
 */
export function buildAnthropicMessage(state, messageId, model, thinkingEnabled = false) {
  const content = buildThinkingBlock(state, thinkingEnabled);
  content.push({ type: 'text', text: state?.content || '' });
  return messageEnvelope({
    id: messageId,
    model: echoModelOf(state, model),
    content,
    stopReason: 'end_turn',
    usage: buildAnthropicUsage(state)
  });
}

/**
 * 构造非流式 Anthropic 工具挂起响应（`stop_reason: 'tool_use'`）。
 * 挂起前已产生的文本作为前置 text 块保留（与 OpenAI 路径的 content 一致）。
 */
export function buildAnthropicToolUseResponse(state, toolEvent, messageId, model, thinkingEnabled = false) {
  const content = buildThinkingBlock(state, thinkingEnabled);
  if (state?.content) content.push({ type: 'text', text: state.content });
  content.push({
    type: 'tool_use',
    id: toolEvent.toolCallId,
    name: toolEvent.name,
    input: toolEvent.args || {}
  });
  return messageEnvelope({
    id: messageId,
    model: echoModelOf(state, model),
    content,
    stopReason: 'tool_use',
    usage: buildAnthropicUsage(state)
  });
}

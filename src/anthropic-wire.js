/**
 * anthropic-wire.js — Anthropic Messages 的帧词汇唯一 module interface
 * （零依赖叶，无 import；帧只在本文件拼装。架构深化第 8 批批B）。
 *
 * 与 openai-wire.js 对称：此前 Anthropic 帧字节散在 4 个文件（anthropicEvent
 * 编码器住 stream-driver、sink 内联拼 payload、非流式信封在 response-builder、
 * HTTP 错误体在 router/index 两处），改 C1-C6 事件序要跳 4 处——本模块把它们
 * 收敛为 1 个定义点。
 *
 * 红线（与 openai-wire 同款 + 审视 F7b/F8 边界）：
 *   - 本模块只回答「帧长什么样」，不回答「何时发哪帧」：C1-C6 事件序、
 *     message_start 惰性、start/stop 配对、收尾幂等全留 anthropic-sink。
 *   - **块 index 状态机不进本模块**：索引游标 / 开块句柄 / 收尾标志留 sink
 *     （tests/anthropic-wire.test.js 有 grep 断言，勿在注释里复述其名字）。
 *   - **content 组装与 usage 计算不进本模块**：非流式 message 走哑信封
 *     （messageEnvelope，content/usage 作参数）——thinking 初始载荷的唯一
 *     来源与 usage 估算留 response-builder / usage-accounting（anthropic.md
 *     钉死 8 按来源位置点名），零依赖叶不被拖入 state 形状。
 *   - 流内错误载荷按协议分派（first-token-guard.md「错误形状必须按协议分派」）
 *     留调用点；本模块只供 Anthropic 侧形状。
 *
 * 字节面由 tests/anthropic-wire.test.js 与 anthropic-response 锚定用例钉死，
 * 任何形状改动都会红。
 */

/**
 * 构造一条 Anthropic 命名事件帧（`event: <type>` + 带 type 的 data 行）。
 *
 * 与 OpenAI 的 `data: {...}` 裸帧并列——Anthropic Messages 流靠**事件名**驱动
 * SDK 的状态机解析（message_start / content_block_start / content_block_delta /
 * content_block_stop / message_delta / message_stop），事件名或顺序错即崩。
 * 另注意：Anthropic 流**没有** `data: [DONE]` 哨兵，收尾靠 message_stop。
 */
export function anthropicEvent(type, payload) {
  return `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
}

/**
 * C1：message_start 帧（必须是流内第一个事件，惰性语义归 sink）。
 * input_tokens 在此刻网关还没报 usage，由调用方传入估算值。
 */
export function messageStart(id, model, inputTokens) {
  return anthropicEvent('message_start', {
    type: 'message_start',
    message: {
      id,
      type: 'message',
      role: 'assistant',
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: inputTokens, output_tokens: 0 }
    }
  });
}

/** C3：content_block_start 帧（index 由 sink 的状态机分配） */
export function contentBlockStart(index, block) {
  return anthropicEvent('content_block_start', {
    type: 'content_block_start',
    index,
    content_block: block
  });
}

/** C2：content_block_delta 帧（index 必须指向当前开启的块——配对归 sink） */
export function contentBlockDelta(index, delta) {
  return anthropicEvent('content_block_delta', {
    type: 'content_block_delta',
    index,
    delta
  });
}

/** C3：content_block_stop 帧（与 start 严格成对，配对归 sink） */
export function contentBlockStop(index) {
  return anthropicEvent('content_block_stop', {
    type: 'content_block_stop',
    index
  });
}

/** C4：message_delta 帧（携带 stop_reason 与最终 output_tokens） */
export function messageDelta(stopReason, outputTokens) {
  return anthropicEvent('message_delta', {
    type: 'message_delta',
    delta: { stop_reason: stopReason, stop_sequence: null },
    usage: { output_tokens: outputTokens }
  });
}

/** C5：message_stop 帧（其后不得再有 data: 行——幂等闸归 sink） */
export function messageStop() {
  return anthropicEvent('message_stop', { type: 'message_stop' });
}

/**
 * tool_use 块的 content_block_start 初始载荷（流式工具挂起）。
 * 真实参数经 input_json_delta 逐片送达（sink 派发），start 载荷的 input 恒空对象。
 */
export function toolUseBlock(id, name) {
  return { type: 'tool_use', id, name, input: {} };
}

/**
 * C6：流内错误帧（`event: error` 并终止流——终止时机归 sink）。
 * 顶层 `type` 判别符是 SDK union 校验的字节锚，缺了报 invalid_union。
 */
export function errorEvent(message) {
  return anthropicEvent('error', {
    type: 'error',
    error: { type: 'api_error', message }
  });
}

/**
 * 非流式 Anthropic message 的**哑信封**（id/type/role/model/stop_reason/
 * stop_sequence + content/usage 原样装入）。content 的块组装与 usage 计算
 * 归调用方（response-builder）——见文件头红线。
 *
 * @param {{id: string, model: string, content: Array, stopReason: string, usage: object}} parts
 * @returns {object} 完整 message 对象（非流式响应体）
 */
export function messageEnvelope({ id, model, content, stopReason, usage }) {
  return {
    id,
    type: 'message',
    role: 'assistant',
    model,
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage
  };
}

/**
 * Anthropic 错误响应体形状（HTTP JSON 层，非流内帧；SDK 按
 * {type:'error', error:{type,message}} 解析）。
 */
export function anthropicError(type, message) {
  return { type: 'error', error: { type, message } };
}

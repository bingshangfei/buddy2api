/**
 * openai-wire.js — OpenAI Chat Completions 的 SSE 帧词汇唯一 module interface
 * （零依赖叶，无 import；帧只在本文件拼装）。
 *
 * 批4（独立审视 F5 缩形）：原始编码器自 stream-driver 迁入（事件消费引擎不再
 * owns 对方协议的帧编码），复合终态帧（error 帧 / tool_calls 帧对）自 sink-factory
 * 的闭包提为纯函数——帧形状 4 个定义点收敛为 1 个，与 anthropic-sink 对称。
 * sink-factory 退化为纯装配（写入机制 + res.end 时机归它，「帧长什么样」归这里）。
 *
 * 红线：本模块只回答「帧长什么样」，不回答「何时发哪帧」——soft-timeout 文案
 * 三路径互异是在案取舍（布尔开关方案两次否决），分派留调用点；`_writeStreamFinish`
 * 因含 anthropic 分支留 handler。字节面由 handler-path-contract / sink-factory.test
 * 钉死，任何形状改动都会红。
 */

/**
 * 构造一条 SSE chat.completion.chunk 数据行（流式响应共用格式）。
 */
export function sseChunk(completionId, created, model, delta, finishReason = null) {
  return `data: ${JSON.stringify({
    id: completionId,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }]
  })}\n\n`;
}

export const SSE_DONE = 'data: [DONE]\n\n';

/**
 * 构造流式响应末尾的 usage chunk（stream_options.include_usage 时发送）。
 * OpenAI 语义：choices 为空数组，usage 字段携带最终 token 统计。
 */
export function sseUsageChunk(completionId, created, model, usage) {
  return `data: ${JSON.stringify({
    id: completionId,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [],
    usage
  })}\n\n`;
}

/**
 * 构造终态错误帧（abortWithError 的载荷；`type: 'server_error'` 是字节锚）。
 */
export function errorFrame(message) {
  return `data: ${JSON.stringify({ error: { message, type: 'server_error' } })}\n\n`;
}

/**
 * 构造工具挂起帧三元组（tool_calls 帧对 + [DONE]；原 _suspendForToolCall 内联帧
 * 逐字形状，refactor-20260928-arch-deepening2 批3 起在 sink-factory，批4 入本模块）。
 * 调用方负责按序写出后 res.end()。
 *
 * @returns {string[]} 三个帧，按序写
 */
export function toolSuspendFrames(toolEvent, completionId, created, model) {
  return [
    sseChunk(completionId, created, model, {
      tool_calls: [{
        index: 0, id: toolEvent.toolCallId, type: 'function',
        function: { name: toolEvent.name, arguments: JSON.stringify(toolEvent.args) }
      }]
    }),
    sseChunk(completionId, created, model, {}, 'tool_calls'),
    SSE_DONE
  ];
}

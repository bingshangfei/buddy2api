/**
 * anthropic-sink.js — Anthropic Messages 流的 sink 实现（与 sink-factory.js 并列）。
 *
 * 为什么是"并列的第二个工厂"而不是给 createSink 加协议参数：StreamDriver 是
 * 协议无关的单事件循环，两条消费路径的差异全部由 sink 表达（见 stream-driver.js
 * 头注释与 sink-factory.js）。Anthropic 的 wire 状态（块 index、块的开启/闭合配对）
 * 比 OpenAI 的裸 delta chunk 复杂得多，塞进同一个工厂会把两边都搅浑。
 *
 * 与 OpenAI sink 的关键差异：
 *   - 事件是**命名的**（event: message_start …），且没有 `data: [DONE]` 哨兵
 *   - `message_start` **惰性发送**：首个可见输出到达时才开流。首 token 假死是
 *     零输出，此时什么都没写 → handler 的换后端重试不会让客户端看到两条
 *     message_start（OpenAI 路径靠 `retrying` 标志跳过 role chunk，Anthropic
 *     靠惰性，两处语义等价）
 *   - content block 必须 start / delta / stop 严格配对，index 单调递进（C1-C6）
 *   - 流式收尾（finish / writeToolUse / abortWithError）由本 sink 拥有，
 *     因为块 index 状态在这里——handler 只负责记账与挂起表
 *
 * 台账（firstOutputAt / reasoning 无条件累加 / progress 去重 / onUsage / onError）
 * 在 sink-base.js；本文件的 finished 前置门经 hooks.isClosed 注入——注意门在
 * firstOutputAt 置位**之前**（收尾竞态的迟到事件不留痕），这是现状口径，勿与
 * OpenAI 侧"统一"。onUsage 现状无门（两侧一致），见 tests/sink-ledger.test.js。
 */

import { resWriter } from './http-utils.js';
import {
  messageStart, contentBlockStart, contentBlockDelta, contentBlockStop,
  messageDelta, messageStop, errorEvent, toolUseBlock
} from './anthropic-wire.js';
import { createBaseSink } from './sink-base.js';
import { buildAnthropicUsage, thinkingBlockStart } from './response-builder.js';
import { observePromptTokens } from './usage-accounting.js';

/**
 * @param {object} opts 与 createSink 同形（同一个调用点可无差别传入）
 * @param {'stream'|'accumulate'} opts.emit
 * @param {object} opts.state 消费状态（content/reasoning/usage/prompt/echoModel/thinkingEnabled）
 * @param {string} opts.key 会话隔离键（日志用）
 * @param {string} opts.completionId Anthropic message id（`msg_…`）
 * @param {string} opts.model 实际使用的模型（echoModel 缺省时的回退）
 * @param {object} opts.res 原始 HTTP 响应（流式写 SSE）
 * @param {Function} [opts.onToolCall] 工具调用到达（StreamDriver 调用，返回挂起响应）
 * @param {Function} [opts.onTimeout] 超时（StreamDriver 调用）
 * @param {Function} [opts.onDone] 自然结束（StreamDriver 调用）
 */
export function createAnthropicSink({
  emit = 'accumulate',
  state,
  key,
  completionId,
  model,
  res,
  onToolCall,
  onTimeout,
  onDone
}) {
  const stream = emit === 'stream';
  // thinking 是否对客户端可见：**只消费 state 上已定的决策**，不在这里读环境变量。
  // 决策在翻译层做一次（anthropic-protocol.resolveAnthropicThinking），随 state
  // 存进挂起表——续跑复用同一个 state，所以不会出现「首轮关、续跑开」的漂移。
  // ⚠ `=== true` 与 OpenAI 侧的 `!== false` 方向相反是有意的（anthropic.md 钉死9）。
  const emitThinking = stream && state?.thinkingEnabled === true;

  // wire 写出（流式收尾与块状态机用；台账侧的 write 由 sink-base 自建，两者等价）
  const write = stream ? resWriter(res) : () => {};

  let started = false;
  let finished = false;
  let nextIndex = 0;
  let openBlock = null; // { index, type }

  /** C1：message_start 必须是第一个事件——惰性发，保证零输出场景不写两条 */
  const ensureStarted = () => {
    if (!stream || started) return;
    started = true;
    // 标记「流已对客户端开启」：模型回退重试守卫（_prepareModelFallback）据此判断
    // 能否安全重试——message_start 已发出再重试会发第二条，违反 C1。
    // 必须在这里标记而不是在 write() 里：心跳（SSE 注释行）也走 write，但它不开流，
    // 标记在那儿会让「首 token 假死后自愈重试」被误禁（等待期间一直在发心跳）。
    if (state) state.streamEmitted = true;
    // input_tokens 在 message_start 里就得给：此刻网关还没报 usage，用 prompt
    // 估算值（与 _recordUsage 的估算口径同一函数；引用缓存——同一请求内与
    // message_delta / 记账共用一次扫描）
    write(messageStart(
      completionId,
      state?.echoModel || model || 'unknown',
      observePromptTokens(state?.prompt)
    ));
  };

  /** 开一个 content block，返回其 index */
  const openBlockOf = (type, block) => {
    ensureStarted();
    const index = nextIndex++;
    openBlock = { index, type };
    write(contentBlockStart(index, block));
    return index;
  };

  /** C3：闭合当前块（与 start 成对） */
  const closeBlock = () => {
    if (!openBlock) return;
    write(contentBlockStop(openBlock.index));
    openBlock = null;
  };

  /** 确保当前开着的是指定类型的块（类型切换时闭合旧的、开新的） */
  const ensureBlock = (type, initialBlock) => {
    if (openBlock?.type !== type) {
      closeBlock();
      openBlockOf(type, initialBlock);
    }
    return openBlock.index;
  };

  /** C4 + C5：message_delta（带 stop_reason）→ message_stop，之后不再写任何 data 行 */
  const finishStream = (stopReason, notice) => {
    if (!stream || finished) return;
    if (notice) {
      ensureBlock('text', { type: 'text', text: '' });
      write(contentBlockDelta(openBlock.index, { type: 'text_delta', text: notice }));
    }
    ensureStarted();
    // 零输出（模型没吐任何东西）：给一个空 text 块，别产出 content: [] 的非法消息
    if (nextIndex === 0) openBlockOf('text', { type: 'text', text: '' });
    closeBlock();
    write(messageDelta(stopReason, buildAnthropicUsage(state).output_tokens));
    write(messageStop());
    finished = true;
    res.end();
  };

  const base = createBaseSink({
    emit,
    state,
    key,
    res,
    onToolCall,
    onTimeout,
    onDone,
    hooks: {
      isClosed: () => finished, // C5：message_stop 之后不得再写任何 data 行（先于 firstOutputAt）
      writeDelta: (text, write, stream) => {
        if (!stream) return;
        const index = ensureBlock('text', { type: 'text', text: '' });
        write(contentBlockDelta(index, { type: 'text_delta', text }));
      },
      writeReasoning: (text, write) => {
        if (!emitThinking) return;
        // signature 随块初始载荷给出（空串语义见 response-builder.thinkingBlockStart）。
        // 放 start 而不是发 signature_delta：SDK 累积时 start 的 payload 被整体复制进
        // 累积块，字段必然存在；signature_delta 只在需要真签名时有意义。
        const index = ensureBlock('thinking', thinkingBlockStart());
        write(contentBlockDelta(index, { type: 'thinking_delta', thinking: text }));
      },
      writeProgress: (text, phase, write) => {
        if (!emitThinking) return;
        const index = ensureBlock('thinking', thinkingBlockStart());
        write(contentBlockDelta(index, { type: 'thinking_delta', thinking: text }));
      }
    }
  });

  return {
    ...base,

    /**
     * 流式收尾（handler 的 onDone / 软超时 onTimeout 调用）。
     * @param {{stopReason?: string, notice?: string}} [opts] notice 作为文本增量发出
     */
    finish: ({ stopReason = 'end_turn', notice = null } = {}) => finishStream(stopReason, notice),

    /**
     * 工具挂起：发 tool_use 块（B-2 形态）并收尾。块 index 状态在本 sink，
     * 所以由 sink 发射而不是 handler 拼字符串。
     */
    writeToolUse: (toolEvent) => {
      if (!stream || finished) return;
      ensureStarted();
      closeBlock();
      const index = openBlockOf('tool_use', toolUseBlock(toolEvent.toolCallId, toolEvent.name));
      write(contentBlockDelta(index, { type: 'input_json_delta', partial_json: JSON.stringify(toolEvent.args || {}) }));
      closeBlock();
      write(messageDelta('tool_use', buildAnthropicUsage(state).output_tokens));
      write(messageStop());
      finished = true;
      res.end();
    },

    /**
     * C6：错误必须发 `event: error` 并**终止流**——只报错不终止会让 SDK 永远
     * 等下一个事件，客户端表现为挂死（比报错更糟）。
     */
    abortWithError: (message) => {
      if (!stream || finished) return;
      closeBlock();
      write(errorEvent(message));
      finished = true;
      res.end();
    }
  };
}

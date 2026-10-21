/**
 * Anthropic 切片 P1/P2/P6：响应构造与 SSE 事件序单测（node:test，零依赖）。
 *
 * 覆盖测试矩阵 M-10~M-16（非流式 message / 模型回显 / count_tokens / 事件序 C1-C6）
 * 与 M-26、M-27（thinking 通路）、M-14（reasoning 累加不被静默空结果检测误杀）。
 *
 * 事件序是**对外契约**：SDK 靠它做状态机解析，顺序错即崩（不是"降级可用"
 * 而是"完全不可用"）。断言点见 evidence/state-machine.md §2 的 C1-C6。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAnthropicSink } from '../src/anthropic-sink.js';
import { buildAnthropicMessage, buildAnthropicToolUseResponse, buildAnthropicUsage } from '../src/response-builder.js';
import { anthropicEvent } from '../src/anthropic-wire.js';

/** 解析 Anthropic SSE 文本为 [{event, data}] */
function parseEvents(chunks) {
  return chunks
    .filter(c => c.startsWith('event:'))
    .map(c => {
      const m = /^event: (.+)\ndata: (.+)\n\n$/s.exec(c);
      assert.ok(m, `非法 SSE 帧: ${JSON.stringify(c)}`);
      return { event: m[1], data: JSON.parse(m[2]) };
    });
}

function fakeRes() {
  const chunks = [];
  let ended = false;
  return {
    chunks,
    get ended() { return ended; },
    get writableEnded() { return ended; },
    write(c) { chunks.push(c); return true; },
    end() { ended = true; }
  };
}

/**
 * 录音式 res 替身：**收尾后仍记录** write 调用。
 *
 * 为什么需要它：sink 通过 resWriter 写 wire，而 resWriter 会在
 * `res.writableEnded === true` 时**静默丢弃**所有 chunk。用普通 fakeRes 断言
 * "收尾后不得再写"是恒真的——即使 sink 完全没有自己的守卫，resWriter 也会
 * 把多余的 chunk 吃掉，测试照样过（断言实际只由 resWriter 满足）。
 * 这个替身故意让 `writableEnded` 恒为 false（模拟"传输层还肯写"），
 * 于是能写出 wire 的只剩 sink 自身的 `finished` 守卫——测的正是它。
 */
function recordingRes() {
  const chunks = [];
  let ended = false;
  return {
    chunks,
    get ended() { return ended; },
    get writableEnded() { return false; }, // 故意恒 false：见上方注释
    write(c) { chunks.push(c); return true; },
    end() { ended = true; }
  };
}

function makeSink({ state, res, ...rest } = {}) {
  // state 必须原样传引用：sink 就地累加到调用方的 state 上，测试断言的是同一个对象
  const sinkState = state || {
    content: '', reasoning: '', usage: {},
    prompt: [{ type: 'text', text: '你好世界' }]
  };
  return createAnthropicSink({
    emit: 'stream',
    state: sinkState,
    key: 'k1',
    completionId: 'msg_test_1',
    created: 1,
    model: 'hy4-preview-f',
    res: res || fakeRes(),
    onToolCall: () => null,
    onTimeout: () => null,
    onDone: () => null,
    ...rest
  });
}

// ---------- M-10：非流式 message 形状 ----------

test('M-10: 非流式响应字段齐全（id/type/role/model/content/stop_reason/usage）', () => {
  const state = {
    content: '你好',
    reasoning: '',
    usage: { prompt_tokens: 120, completion_tokens: 8 },
    prompt: [{ type: 'text', text: 'hi' }],
    protocol: 'anthropic'
  };
  const msg = buildAnthropicMessage(state, 'msg_1', 'hy4-preview-f');

  assert.equal(msg.id, 'msg_1');
  assert.equal(msg.type, 'message');
  assert.equal(msg.role, 'assistant');
  assert.equal(msg.model, 'hy4-preview-f');
  assert.deepEqual(msg.content, [{ type: 'text', text: '你好' }]);
  assert.equal(msg.stop_reason, 'end_turn');
  assert.equal(msg.stop_sequence, null);
  assert.equal(msg.usage.input_tokens, 120);
  assert.equal(msg.usage.output_tokens, 8);
});

test('M-10 边界: 无 usage 事件时按 prompt/文本估算（input_tokens 不能是 0）', () => {
  const state = { content: '回答', reasoning: '', usage: {}, prompt: [{ type: 'text', text: '一段中文问题' }] };
  const usage = buildAnthropicUsage(state);
  assert.ok(usage.input_tokens > 0, 'input_tokens 必须是正数（否则客户端显示 0 token）');
  assert.ok(usage.output_tokens > 0);
});

test('M-10 边界: 模型零输出 → content 仍有一个空 text 块（不能是空数组）', () => {
  const msg = buildAnthropicMessage({ content: '', reasoning: '', usage: {} }, 'msg_2', 'm');
  assert.equal(msg.content.length, 1);
  assert.equal(msg.content[0].type, 'text');
});

// ---------- M-11：模型回显原始请求名 ----------

test('M-11: 请求 claude-* 时响应回显原始请求名（不暴露映射后的 id）', () => {
  const state = {
    content: 'ok', reasoning: '', usage: {}, echoModel: 'claude-sonnet-4-5-20250929', protocol: 'anthropic'
  };
  assert.equal(buildAnthropicMessage(state, 'msg_3', 'hy4-preview-f').model, 'claude-sonnet-4-5-20250929');
});

// ---------- M-21（非流式形态）：tool_use 挂起响应 ----------

test('M-21: 非流式挂起 → tool_use 块 + stop_reason=tool_use', () => {
  const state = { content: '', reasoning: '', usage: {}, echoModel: 'claude-x' };
  const resp = buildAnthropicToolUseResponse(
    state,
    { name: 'get_weather', args: { city: 'SF' }, toolCallId: 'toolu_1' },
    'msg_4',
    'hy4-preview-f'
  );

  assert.equal(resp.stop_reason, 'tool_use');
  assert.equal(resp.model, 'claude-x');
  assert.equal(resp.content.length, 1);
  assert.deepEqual(resp.content[0], {
    type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: { city: 'SF' }
  });
});

test('M-21 边界: 挂起前已有文本 → 文本块在前、tool_use 块在后', () => {
  const resp = buildAnthropicToolUseResponse(
    { content: '我先查一下', reasoning: '', usage: {} },
    { name: 't', args: {}, toolCallId: 'toolu_2' },
    'msg_5',
    'm'
  );
  assert.deepEqual(resp.content.map(b => b.type), ['text', 'tool_use']);
});

// ---------- T8 / T9 / T11：非流式 thinking 块（请求驱动 + signature 修复） ----------

test('T8: 非流式自然结束 + thinkingEnabled → content[0] 为带 signature:"" 的 thinking 块', () => {
  const state = { content: '答案', reasoning: '我的推理', usage: {}, protocol: 'anthropic' };
  const msg = buildAnthropicMessage(state, 'msg_t8', 'hy4-preview-f', true);

  assert.deepEqual(msg.content.map(b => b.type), ['thinking', 'text']);
  assert.deepEqual(
    Object.keys(msg.content[0]).sort(), ['signature', 'thinking', 'type'],
    'thinking 块必须含 signature 键（省略 → 严格客户端 APIResponseValidationError）'
  );
  assert.equal(msg.content[0].signature, '', '空串语义 = 诚实的「无签名」');
  assert.equal(msg.content[0].thinking, '我的推理');
});

test('T8 回归: thinkingEnabled 缺省(false) → 无 thinking 块（既有行为不变）', () => {
  const msg = buildAnthropicMessage({ content: '答案', reasoning: '推理', usage: {} }, 'msg_t8b', 'm');
  assert.deepEqual(msg.content.map(b => b.type), ['text']);
});

test('T9: 非流式工具挂起 + thinkingEnabled → content[0] thinking（带 signature）→ tool_use 块保留', () => {
  const resp = buildAnthropicToolUseResponse(
    { content: '', reasoning: '推理', usage: {} },
    { name: 't', args: {}, toolCallId: 'toolu_t9' },
    'msg_t9', 'm', true
  );
  assert.deepEqual(resp.content.map(b => b.type), ['thinking', 'tool_use']);
  assert.equal(resp.content[0].signature, '');
  assert.equal(resp.content[0].thinking, '推理');
  assert.equal(resp.content[1].id, 'toolu_t9', 'tool_use 块不得被 thinking 块挤掉');
});

test('T11: reasoning 为空时不发 thinking 块（即使 thinkingEnabled=true）', () => {
  const msg = buildAnthropicMessage({ content: '答案', reasoning: '', usage: {} }, 'msg_t11', 'm', true);
  assert.deepEqual(msg.content.map(b => b.type), ['text'], '空 thinking 块比没有更糟：客户端会渲染一个空思考框');
});

// ---------- M-12 / C1-C5：纯文本流式事件序 ----------

test('M-12: 纯文本流式事件序 = C1→C2→C3→C4→C5', () => {
  const res = fakeRes();
  const sink = makeSink({ res });

  sink.onDelta('你');
  sink.onDelta('好');
  sink.finish({ stopReason: 'end_turn' });

  const events = parseEvents(res.chunks);
  assert.deepEqual(events.map(e => e.event), [
    'message_start',
    'content_block_start',
    'content_block_delta',
    'content_block_delta',
    'content_block_stop',
    'message_delta',
    'message_stop'
  ]);

  // C1：message_start 必须第一个
  assert.equal(events[0].data.message.role, 'assistant');
  assert.equal(events[0].data.message.id, 'msg_test_1');
  assert.deepEqual(events[0].data.message.content, []);
  assert.ok(events[0].data.message.usage.input_tokens > 0, 'input_tokens 应在 message_start 给出');

  // C2：delta 的 index 落在已 start 未 stop 的块上
  assert.equal(events[1].data.index, 0);
  assert.equal(events[1].data.content_block.type, 'text');
  assert.deepEqual(events[2].data.delta, { type: 'text_delta', text: '你' });
  assert.deepEqual(events[3].data.delta, { type: 'text_delta', text: '好' });
  assert.equal(events[2].data.index, 0);

  // C3：stop 成对且在所有 delta 之后
  assert.equal(events[4].data.index, 0);

  // C4：message_delta 带 stop_reason 且在 message_stop 之前
  assert.equal(events[5].data.delta.stop_reason, 'end_turn');
  assert.equal(events[5].data.delta.stop_sequence, null);
  assert.ok(events[5].data.usage.output_tokens > 0);

  // C5：message_stop 是最后一个事件，之后无任何 data 行
  assert.equal(events[6].data.type, 'message_stop');
  assert.equal(res.ended, true);
});

test('C5 边界: 流中不含 OpenAI 的 data: [DONE] 哨兵（Anthropic 无此约定）', () => {
  const res = fakeRes();
  const sink = makeSink({ res });
  sink.onDelta('a');
  sink.finish({});
  assert.equal(res.chunks.filter(c => c.includes('[DONE]')).length, 0);
});

test('C5 边界: message_stop 之后到达的 delta/reasoning/progress 一律丢弃（不得再写 data 行）', () => {
  // 真实来源：finish() 之后底层生成器仍可能再吐一两个事件（收尾竞态）。
  // 此时再写 content_block_delta → 客户端已在 message_stop 上结束状态机，
  // 后续事件要么被忽略要么让严格解析器报错，且 index 会指向已关闭的块（违反 C2）。
  const res = recordingRes();
  const state = { content: '', reasoning: '', usage: {}, prompt: [{ type: 'text', text: '你好' }] };
  const sink = makeSink({ res, state });
  sink.onDelta('正文');
  sink.finish({ stopReason: 'end_turn' });
  const afterFinish = res.chunks.length;

  sink.onDelta('迟到的 delta');
  sink.onReasoning('迟到的 thinking');
  sink.onProgress('迟到的进度', 'compacting');

  assert.equal(res.chunks.length, afterFinish, '收尾后不得再写任何 SSE 帧');
  assert.ok(!res.chunks.some(c => c.includes('迟到 delta')), '迟到 delta 不得出现在 wire 上');
  // 收尾后 sink 整体惰性（wire 与 state 都不再变）：此时 usage 已记、响应已 end，
  // 再累加 state 没有任何消费者，只会让日志/断言误以为收到过内容。
  assert.equal(state.content, '正文', '收尾后 content 不再累加');
  assert.equal(state.reasoning, '', '收尾后 reasoning 不再累加');
});

test('C5 边界: finish 之后重复 finish / writeToolUse / abortWithError 均不得再写（幂等）', () => {
  // 收尾是"多路径可能都触发"的：onDone 与软超时可能都在同一个请求上跑过一次，
  // 客户端断开还会追一次 abort。非幂等收尾会产出第二条 message_stop（违反 C5）。
  // ⚠ 必须用 recordingRes：普通 fakeRes 会让 resWriter 替 sink 挡掉多余 chunk，
  // 使这条断言恒真（见 recordingRes 注释）。
  const res = recordingRes();
  const sink = makeSink({ res });
  sink.onDelta('x');
  sink.finish({ stopReason: 'end_turn' });
  const afterFirst = res.chunks.length;

  sink.finish({ stopReason: 'end_turn' });
  sink.writeToolUse({ toolCallId: 'toolu_late', name: 'late_tool', args: {} });
  sink.abortWithError('迟到的错误');

  assert.equal(res.chunks.length, afterFirst, '第二次收尾必须整体 no-op');
  assert.equal(res.chunks.filter(c => c.startsWith('event: message_stop')).length, 1,
    'message_stop 只能出现一次');
  assert.equal(res.chunks.filter(c => c.startsWith('event: error')).length, 0,
    '已正常收尾的流不得再补发 event: error');
  assert.equal(res.chunks.filter(c => c.startsWith('event: message_delta')).length, 1,
    'message_delta 也只能一次（重复的 stop_reason 会覆盖客户端状态）');
});

test('abortWithError 幂等: 错误后到达的收尾与增量一律丢弃（C5/C6 不得自相矛盾）', () => {
  const res = recordingRes();
  const sink = makeSink({ res });
  sink.onDelta('半截');
  sink.abortWithError('上游炸了');
  const afterError = res.chunks.length;

  sink.onDelta('迟到');
  sink.finish({ stopReason: 'end_turn' }); // 已出错的流不得再"正常收尾"
  sink.abortWithError('再来一次');

  assert.equal(res.chunks.length, afterError, '错误收尾后必须整体惰性');
  assert.equal(res.chunks.filter(c => c.startsWith('event: message_stop')).length, 0,
    '已 error 收尾的流不得再发 message_stop（两种终态互斥）');
  assert.equal(res.chunks.filter(c => c.startsWith('event: error')).length, 1, 'error 恰好一次');
});

test('M-12 边界: 空 delta 序列（模型零输出）→ 仍发完整 C1-C5 事件序', () => {
  const res = fakeRes();
  const sink = makeSink({ res });
  sink.finish({ stopReason: 'end_turn' });

  const events = parseEvents(res.chunks);
  assert.equal(events[0].event, 'message_start');
  assert.equal(events[events.length - 1].event, 'message_stop');
  assert.ok(events.some(e => e.event === 'message_delta'), 'message_delta 不能省');
  assert.equal(res.ended, true);
});

// ---------- M-13：多块 index 单调且不重叠 ----------

test('M-13: 文本 + 工具调用 → 块 index 递进（0 文本、1 tool_use）且各自成对', () => {
  const res = fakeRes();
  const sink = makeSink({ res });

  sink.onDelta('我先查一下');
  sink.writeToolUse({ name: 'get_weather', args: { city: 'SF' }, toolCallId: 'toolu_1' });

  const events = parseEvents(res.chunks);
  const starts = events.filter(e => e.event === 'content_block_start');
  const stops = events.filter(e => e.event === 'content_block_stop');

  assert.deepEqual(starts.map(e => e.data.index), [0, 1]);
  assert.deepEqual(starts.map(e => e.data.content_block.type), ['text', 'tool_use']);
  assert.deepEqual(stops.map(e => e.data.index), [0, 1], 'start 与 stop 必须成对');

  // 每个 delta 的 index 都必须是已 start 未 stop 的块
  const open = new Set();
  for (const e of events) {
    if (e.event === 'content_block_start') open.add(e.data.index);
    else if (e.event === 'content_block_stop') { assert.ok(open.has(e.data.index)); open.delete(e.data.index); }
    else if (e.event === 'content_block_delta') assert.ok(open.has(e.data.index), `delta index ${e.data.index} 未在开启的块上`);
  }
  assert.equal(open.size, 0);
});

test('M-13 边界: 无文本直接工具调用 → tool_use 就是 index 0', () => {
  const res = fakeRes();
  const sink = makeSink({ res });
  sink.writeToolUse({ name: 't', args: {}, toolCallId: 'toolu_9' });

  const events = parseEvents(res.chunks);
  const start = events.find(e => e.event === 'content_block_start');
  assert.equal(start.data.index, 0);
  assert.equal(start.data.content_block.type, 'tool_use');
  assert.equal(start.data.content_block.id, 'toolu_9');
  assert.equal(start.data.content_block.name, 't');
});

test('M-21（流式形态）: tool_use delta 为 input_json_delta 且 stop_reason=tool_use', () => {
  const res = fakeRes();
  const sink = makeSink({ res });
  sink.writeToolUse({ name: 'get_weather', args: { city: 'SF' }, toolCallId: 'toolu_1' });

  const events = parseEvents(res.chunks);
  const delta = events.find(e => e.event === 'content_block_delta');
  assert.equal(delta.data.delta.type, 'input_json_delta');
  assert.deepEqual(JSON.parse(delta.data.delta.partial_json), { city: 'SF' });

  const md = events.find(e => e.event === 'message_delta');
  assert.equal(md.data.delta.stop_reason, 'tool_use');
  assert.equal(events[events.length - 1].event, 'message_stop');
  assert.equal(res.ended, true);
});

// ---------- M-14：reasoning 必须累加（否则被静默空结果检测判空 → 重试 → 重复计费） ----------

test('M-14: 仅产出 reasoning（thinking 默认关）→ state.reasoning 累加且不发射 thinking 块', () => {
  const res = fakeRes();
  const state = { content: '', reasoning: '', usage: {}, prompt: [] };
  const sink = makeSink({ state, res });

  sink.onReasoning('先想一想');
  sink.finish({ stopReason: 'end_turn' });

  assert.equal(state.reasoning, '先想一想', 'reasoning 必须累加：静默空结果检测按四项判定，丢了会被判空结果触发重试');
  const events = parseEvents(res.chunks);
  assert.equal(events.filter(e => e.data.content_block?.type === 'thinking').length, 0);
  assert.equal(events.filter(e => e.data.delta?.type === 'thinking_delta').length, 0);
  assert.equal(events[0].event, 'message_start');
  assert.equal(events[events.length - 1].event, 'message_stop');
});

test('M-14 边界: reasoning 到达也算首输出（首 token 守卫口径与既有 sink 一致）', () => {
  const state = { content: '', reasoning: '', usage: {}, prompt: [] };
  const sink = makeSink({ state });
  assert.ok(!state.firstOutputAt);
  sink.onReasoning('x');
  assert.ok(state.firstOutputAt > 0);
});

// ---------- M-26 / M-27：thinking 通路 ----------

test('M-26: 默认不发射 thinking 块（含 progress 阶段信息）', () => {
  const res = fakeRes();
  const sink = makeSink({ res });
  sink.onReasoning('思考');
  sink.onProgress('正在压缩上下文', 'compacting');
  sink.finish({});

  const events = parseEvents(res.chunks);
  assert.equal(events.filter(e => e.data.content_block?.type === 'thinking').length, 0);
  assert.equal(events.filter(e => e.data.delta?.type === 'thinking_delta').length, 0);
});

test('M-27: thinkingEnabled=true → 发射 thinking 块与 thinking_delta；块初始载荷带 signature:""', () => {
  const res = fakeRes();
  const state = { content: '', reasoning: '', usage: {}, prompt: [], thinkingEnabled: true };
  // 迁移说明（2026-09-17 请求驱动）：不再靠 BUDDY2API_ANTHROPIC_THINKING 触发，
  // 改为在 state 上带 thinkingEnabled——决策由请求驱动、由翻译层算一次，
  // sink 只消费 state 上已定的决策（I4：随挂起表透传，续跑不重读）。
  const sink = makeSink({ state, res });

  sink.onReasoning('推理一');
  sink.onReasoning('推理二');
  sink.onDelta('答案');
  sink.finish({});

  const events = parseEvents(res.chunks);
  const thinkingStart = events.find(e => e.data.content_block?.type === 'thinking');
  assert.ok(thinkingStart, '应发 thinking 块');
  // T1：块初始载荷必须带 signature 键——省略会让 Anthropic SDK（严格模式）
  // 抛 APIResponseValidationError（ThinkingBlock.signature 是必填字段，无默认值）
  assert.deepEqual(
    Object.keys(thinkingStart.data.content_block).sort(),
    ['signature', 'thinking', 'type'],
    'thinking 块必须含 type/thinking/signature 三键（缺 signature → 严格客户端崩溃）'
  );
  assert.equal(thinkingStart.data.content_block.signature, '', 'signature 取空串（对齐 DashScope「当前固定为空字符串」）');
  const thinkingDeltas = events.filter(e => e.data.delta?.type === 'thinking_delta');
  assert.deepEqual(thinkingDeltas.map(e => e.data.delta.thinking), ['推理一', '推理二']);
  assert.equal(events.filter(e => e.data.delta?.type === 'signature_delta').length, 0, 'signature 随块初始载荷给出，不发 signature_delta');

  // thinking 块与 text 块各自成对且 index 递进
  const starts = events.filter(e => e.event === 'content_block_start');
  assert.deepEqual(starts.map(e => e.data.content_block.type), ['thinking', 'text']);
  const stops = events.filter(e => e.event === 'content_block_stop');
  assert.deepEqual(stops.map(e => e.data.index), [0, 1]);
  assert.equal(state.reasoning, '推理一推理二', '对外发射时同样必须累加到 state');
});

test('T3（sink）: thinkingEnabled=false 时即使 BUDDY2API_ANTHROPIC_THINKING=1 也不发射（请求参数压过环境变量）', () => {
  const prev = process.env.BUDDY2API_ANTHROPIC_THINKING;
  process.env.BUDDY2API_ANTHROPIC_THINKING = '1'; // 环境变量开着，但请求说 disabled
  try {
    const res = fakeRes();
    const state = { content: '', reasoning: '', usage: {}, prompt: [], thinkingEnabled: false };
    const sink = makeSink({ state, res });

    sink.onReasoning('思考');
    sink.onProgress('正在压缩上下文', 'compacting');
    sink.finish({});

    const events = parseEvents(res.chunks);
    assert.equal(events.filter(e => e.data.content_block?.type === 'thinking').length, 0, '请求显式 disabled 必须压过环境变量');
    assert.equal(events.filter(e => e.data.delta?.type === 'thinking_delta').length, 0);
    assert.equal(state.reasoning, '思考', '不发射也必须累加（I1：静默空结果检测不误判）');
  } finally {
    if (prev === undefined) delete process.env.BUDDY2API_ANTHROPIC_THINKING;
    else process.env.BUDDY2API_ANTHROPIC_THINKING = prev;
  }
});

test('T5（sink）: thinkingEnabled=true 时 progress 阶段信息也走 thinking 块', () => {
  const res = fakeRes();
  const state = { content: '', reasoning: '', usage: {}, prompt: [], thinkingEnabled: true };
  const sink = makeSink({ state, res });
  sink.onProgress('正在压缩上下文', 'compacting');
  sink.finish({});

  const events = parseEvents(res.chunks);
  const thinkingStart = events.find(e => e.data.content_block?.type === 'thinking');
  assert.ok(thinkingStart, 'progress 属思考可见内容');
  assert.equal(thinkingStart.data.content_block.signature, '');
  assert.deepEqual(
    events.filter(e => e.data.delta?.type === 'thinking_delta').map(e => e.data.delta.thinking),
    ['正在压缩上下文']
  );
});

// ---------- C6：错误必须发 event: error 并终止流 ----------

test('C6: 错误 → 发 event: error 且终止流（不得让 SDK 永久等待）', () => {
  const res = fakeRes();
  const sink = makeSink({ res });

  sink.onDelta('部分');
  sink.abortWithError('WorkBuddy 429');

  const events = parseEvents(res.chunks);
  const last = events[events.length - 1];
  assert.equal(last.event, 'error');
  assert.equal(last.data.type, 'error');
  assert.equal(last.data.error.message, 'WorkBuddy 429');
  assert.equal(res.ended, true, 'error 之后必须结束响应');
  assert.equal(res.chunks.filter(c => c.includes('[DONE]')).length, 0);
});

test('C6 边界: 零输出即出错 → 也要终止（message_start 后直接 error 也合法）', () => {
  const res = fakeRes();
  const sink = makeSink({ res });
  sink.abortWithError('boom');
  const events = parseEvents(res.chunks);
  assert.equal(events[events.length - 1].event, 'error');
  assert.equal(res.ended, true);
});

// ---------- 软超时收尾 ----------

test('超时收尾: notice 作为文本 delta 发出后正常走 C4/C5', () => {
  const res = fakeRes();
  const sink = makeSink({ res });
  sink.onDelta('已有内容');
  sink.finish({ stopReason: 'end_turn', notice: '\n\n[WorkBuddy 响应超时]' });

  const events = parseEvents(res.chunks);
  const textDeltas = events.filter(e => e.data.delta?.type === 'text_delta').map(e => e.data.delta.text);
  assert.deepEqual(textDeltas, ['已有内容', '\n\n[WorkBuddy 响应超时]']);
  assert.equal(events[events.length - 1].event, 'message_stop');
});

// ---------- 非流式 sink ----------

test('非流式 sink: 不写任何 SSE 帧，只累加 state', () => {
  const res = fakeRes();
  const state = { content: '', reasoning: '', usage: {}, prompt: [] };
  const sink = makeSink({ state, res, emit: 'accumulate' });

  sink.onDelta('hi');
  sink.onReasoning('think');
  sink.onUsage({ prompt_tokens: 5, completion_tokens: 2 });
  sink.onProgress('阶段', 'p');
  sink.finish({});

  assert.equal(res.chunks.length, 0);
  assert.equal(res.ended, false);
  assert.equal(state.content, 'hi');
  assert.equal(state.reasoning, 'think');
  assert.deepEqual(state.usage, { prompt_tokens: 5, completion_tokens: 2 });
});

// ---------- heartbeat 保活 ----------

test('heartbeat: 流式写 SSE 注释行（客户端自动忽略），非流式为 undefined', () => {
  const res = fakeRes();
  const sink = makeSink({ res });
  sink.heartbeat();
  assert.equal(res.chunks[0], ': keep-alive\n\n');
  sink.heartbeat(': 排队中，已等待 3s');
  assert.equal(res.chunks[1], ': 排队中，已等待 3s\n\n');

  const accSink = makeSink({ emit: 'accumulate' });
  assert.equal(typeof accSink.heartbeat, 'undefined');
});

test('heartbeat 不得置 state.streamEmitted（否则首 token 假死后自愈重试被误禁）', () => {
  // 这个区分是 _prepareModelFallback 重试守卫的正确性前提：
  // 等待期间一直在发心跳，若心跳也算"流已开"，首 token 假死的自愈重试就永远不会触发。
  const res = fakeRes();
  const state = { content: '', reasoning: '', usage: {}, prompt: [] };
  const sink = makeSink({ res, state });

  sink.heartbeat();
  sink.heartbeat();
  assert.equal(state.streamEmitted, undefined, '心跳不开流，不得置位');

  sink.onDelta('正文');
  assert.equal(state.streamEmitted, true, '首个可见输出（message_start 发出）才置位');
});

test('非流式 sink 不得置 state.streamEmitted（非流式无可重试的 wire）', () => {
  const state = { content: '', reasoning: '', usage: {}, prompt: [] };
  const sink = makeSink({ state, res: fakeRes(), emit: 'accumulate' });
  sink.onDelta('hi');
  assert.equal(state.streamEmitted, undefined);
});

// ---------- 事件构造器 ----------

test('anthropicEvent: 输出命名事件帧（event + 带 type 的 data）', () => {
  const frame = anthropicEvent('ping', { type: 'ping' });
  assert.equal(frame, 'event: ping\ndata: {"type":"ping"}\n\n');
});

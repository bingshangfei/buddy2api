/**
 * _suspendForToolCall（工具挂起单一 seam）单测（node:test，零依赖）。
 * 三条路径（首轮流式 / 首轮非流式 / 工具续跑）都收敛到这一个方法，
 * 这里验证它的两种形态（流式写 SSE / 非流式返回响应）与 pending 挂起语义。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OpenAiHandler, buildRequestContext } from '../src/openai-handler.js';
import { createSink } from '../src/sink-factory.js';

/** 构造 handler 实例，stub 掉超时与响应构建，聚焦挂起逻辑本身 */
function makeHandler() {
  const handler = new OpenAiHandler('http://127.0.0.1:1');
  handler._armPendingTimeout = () => {};
  handler._buildToolCallResponse = (state, toolEvent, completionId, created, model) => ({
    marker: 'tool-call-response',
    toolCallId: toolEvent.toolCallId,
    content: state.content
  });
  return handler;
}

/** 流式 sink（帧写出已下沉 sink-factory，批3）——挂起帧经 sink.writeToolSuspend 写出 */
function makeStreamSink(res, state) {
  return createSink({
    emit: 'stream', state, key: 'test',
    completionId: 'cmpl-1', created: 1, model: 'auto', res,
    onToolCall: () => {}, onTimeout: () => {}, onDone: () => {}
  });
}

/** 捕获 SSE 写入的 fake res */
function fakeRes() {
  const chunks = [];
  let ended = false;
  return {
    chunks,
    get ended() { return ended; },
    get writableEnded() { return ended; },
    write(chunk) { chunks.push(chunk); return true; },
    end() { ended = true; }
  };
}

const toolEvent = {
  reqId: 'req-1',
  name: 'my_tool',
  args: { a: 1 },
  toolCallId: 'tc-1'
};

const ctx = { ...buildRequestContext({ key: 'test' }), completionId: 'cmpl-1', created: 1, model: 'auto' };

test('流式：写 tool_calls chunk + finish tool_calls + [DONE]，返回 null，pending 挂起', () => {
  const handler = makeHandler();
  const res = fakeRes();
  const state = { content: 'partial', toolCall: null, timer: null };
  const sink = makeStreamSink(res, state);

  const ret = handler._suspendForToolCall(state, toolEvent, { stream: true, sink, ctx: { ...ctx, res } });

  assert.equal(ret, null);
  assert.equal(state.toolCall, toolEvent);
  assert.equal(handler.pending.get('test'), state, '状态应挂到 pending 表等待工具结果回传');

  // 三个 SSE 数据段：tool_calls delta、finish_reason=tool_calls、[DONE]
  assert.equal(res.chunks.length, 3);
  const parsed = JSON.parse(res.chunks[0].slice(6).trim());
  assert.equal(parsed.choices[0].delta.tool_calls[0].function.name, 'my_tool');
  assert.equal(JSON.parse(parsed.choices[0].delta.tool_calls[0].function.arguments).a, 1);
  assert.equal(JSON.parse(res.chunks[1].slice(6).trim()).choices[0].finish_reason, 'tool_calls');
  assert.equal(res.chunks[2], 'data: [DONE]\n\n');
  assert.equal(res.ended, true, '流式响应应已结束');
});

test('非流式：返回 tool_calls 挂起响应，pending 挂起，不写 SSE', () => {
  const handler = makeHandler();
  const res = fakeRes();
  const state = { content: 'partial', toolCall: null, timer: null };

  const ret = handler._suspendForToolCall(state, toolEvent, { stream: false, ctx: { ...ctx, res } });

  assert.deepEqual(ret, { marker: 'tool-call-response', toolCallId: 'tc-1', content: 'partial' });
  assert.equal(state.toolCall, toolEvent);
  assert.equal(handler.pending.get('test'), state);
  assert.equal(res.chunks.length, 0, '非流式不写 SSE');
  assert.equal(res.ended, false);
});

test('流式：客户端已断开（writableEnded）时写操作不抛错', () => {
  const handler = makeHandler();
  const res = fakeRes();
  res.end(); // 标记已结束，模拟客户端断开
  const state = { content: '', toolCall: null, timer: null };
  const sink = makeStreamSink(res, state);

  assert.doesNotThrow(() => {
    handler._suspendForToolCall(state, toolEvent, { stream: true, sink, ctx: { ...ctx, res } });
  });
});

// ---------- _onPendingTimeout：超时回调的守卫（串台隐患回归测试） ----------
//
// 之前的守卫是 `s && !s.toolCall`——条目缺失（工具流程已正常完成）时反而继续
// 执行 invalidate(key, undefined)，_resolvePool 会按 key 定位到**其他请求正在
// 占用的连接**并销毁之。完成后 5 分钟才引爆，极难排查。

test('超时回调：pending 条目已删除（正常完成）→ 不做任何清理', () => {
  const handler = makeHandler();
  const destroyed = [];
  handler.sessions = { invalidate: (key, poolId) => destroyed.push({ key, poolId }) };

  handler._onPendingTimeout('k1', undefined); // 从未挂起过
  handler.pending.set('k2', { toolCall: null, poolId: 'pool-2' });
  handler._onPendingTimeout('k2', handler.pending.get('k2')); // 已删除前先放一个无 toolCall 的条目

  assert.deepEqual(destroyed, [], '条目缺失或已在回传中时不得 invalidate 任何连接');
});

test('超时回调：条目缺失时不命中同 key 其他忙碌连接（回归：_resolvePool 按 key 兜底）', () => {
  const handler = makeHandler();
  const destroyed = [];
  handler.sessions = { invalidate: (key, poolId) => destroyed.push(poolId) };
  // 模拟 5 分钟后同一 key 上有新请求占着连接：invalidate 若被调用会传 undefined，
  // 真实 _resolvePool 会兜底找到忙碌连接——所以断言 invalidate 根本不被调用。
  handler._onPendingTimeout('k1', undefined);
  assert.deepEqual(destroyed, []);
});

test('超时回调：真挂起超时 → 取消、清 pending、invalidate 对应连接', async () => {
  const handler = makeHandler();
  const calls = { cancelled: [], invalidated: [] };
  handler.sessions = {
    invalidate: (key, poolId) => calls.invalidated.push(poolId)
  };
  const state = {
    toolCall: { toolCallId: 'tc-1' },
    sessionId: 'sess-1',
    poolId: 'pool-9',
    client: { cancelPrompt: async (sid) => { calls.cancelled.push(sid); } },
    iterator: { return: async () => {} },
    timer: null
  };
  handler.pending.set('k1', state);

  handler._onPendingTimeout('k1', state);

  assert.deepEqual(calls.cancelled, ['sess-1'], '应取消后端任务');
  assert.deepEqual(calls.invalidated, ['pool-9'], '应只 invalidate 自己的连接');
  assert.equal(handler.pending.has('k1'), false, '应清除挂起条目');
});

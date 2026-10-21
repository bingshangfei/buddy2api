/**
 * 跨请求资源回合边界清理回归测试（bugfix-20261019-cross-request-cleanup）。
 *
 * 覆盖两个缺陷：
 *   A. 挂起工具调用定时器：条目被删除/覆盖时，其 timer 必须被清除；旧 timer
 *      即使触发也不能误杀同 key 的新条目。
 *   B. standalone SSE 合并迭代器：回合结束后不残留等待者；推送事件归属当前
 *      回合；竞速输给 POST result 的事件回队而不是丢失。
 *
 * 两个用例在修复前应为红（A：PendingTable 不存在 / 旧 timer 误杀；B：waiters 泄漏）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PendingTable } from '../src/pending-expiry.js';
import { AcpClient } from '../src/acp-client.js';
import { OpenAiHandler } from '../src/openai-handler.js';

/** 假时钟：捕获 setTimeout/clearTimeout，手动 fire。 */
function fakeClock() {
  const timers = [];
  const cleared = [];
  return {
    timers,
    cleared,
    setTimeoutFn: (fn, ms) => { const t = { fn, ms }; timers.push(t); return t; },
    clearTimeoutFn: (t) => { if (t) { cleared.push(t); t.__cleared = true; } },
    fireAll() { for (const t of timers.splice(0)) if (!t.__cleared) t.fn(); }
  };
}

function tableWith(clock) {
  return new PendingTable({ clearTimeoutFn: clock.clearTimeoutFn });
}

// ─────────────────────────── A. 挂起定时器 ───────────────────────────

test('A1: delete 条目时清除其 timer（7 个出口零改动即覆盖）', () => {
  const clock = fakeClock();
  const table = tableWith(clock);
  const state = { timer: { id: 't1' } };
  table.set('k', state);
  table.delete('k');
  assert.deepEqual(clock.cleared, [state.timer], 'delete 必须 clearTimeout 该条目的 timer');
  assert.equal(table.has('k'), false);
});

test('A2: set 覆盖同 key 旧条目时清除旧 timer（不存在孤立 timer）', () => {
  const clock = fakeClock();
  const table = tableWith(clock);
  const first = { timer: { id: 't1' } };
  const second = { timer: { id: 't2' } };
  table.set('k', first);
  table.set('k', second);
  assert.deepEqual(clock.cleared, [first.timer], '覆盖前必须清掉旧条目的 timer');
  assert.equal(table.get('k'), second);
});

test('A3: clear() 逐条清除 timer', () => {
  const clock = fakeClock();
  const table = tableWith(clock);
  const a = { timer: { id: 'a' } };
  const b = { timer: { id: 'b' } };
  table.set('a', a);
  table.set('b', b);
  table.clear();
  assert.deepEqual(clock.cleared.sort((x, y) => x.id.localeCompare(y.id)), [a.timer, b.timer]);
  assert.equal(table.size, 0);
});

test('A4: 旧 timer 触发不误杀同 key 的新条目（真实 handler 守卫）', () => {
  const calls = [];
  const handler = Object.create(OpenAiHandler.prototype);
  handler.pending = new PendingTable();
  handler.sessions = { invalidate: (key, poolId) => calls.push(['invalidate', poolId]) };
  const first = {
    toolCall: { reqId: 1 }, sessionId: 's1', poolId: 'p1',
    client: { cancelPrompt: async () => calls.push(['cancel', 's1']) }
  };
  const second = {
    toolCall: { reqId: 2 }, sessionId: 's2', poolId: 'p2',
    client: { cancelPrompt: async () => calls.push(['cancel', 's2']) }
  };
  handler.pending.set('k', first);
  handler.pending.set('k', second); // 覆盖：PendingTable 清掉 first.timer
  handler._onPendingTimeout('k', first); // 模拟旧 timer 仍然触发
  assert.deepEqual(calls, [], '旧 timer 不得对 second 执行 cancelPrompt/invalidate');
  assert.equal(handler.pending.get('k'), second, 'second 必须仍在挂起表内');

  // 当前条目的到期仍然正常（identity 相等 → 执行销毁序列）
  handler._onPendingTimeout('k', second);
  assert.deepEqual(calls, [['cancel', 's2'], ['invalidate', 'p2']]);
  assert.equal(handler.pending.has('k'), false);
});

// ─────────────────────────── B. SSE 合并迭代器 ───────────────────────────

function makeClient() {
  const client = new AcpClient('http://127.0.0.1:1');
  client._eventStreamOpen = true;
  client._fakeResponse = { destroy() { this.destroyed = true; } };
  return client;
}

test('B1: 回合结束后不残留等待者，下一回合能收到推送事件', async () => {
  const client = makeClient();
  client._iterSse = async function* () {
    yield { jsonrpc: '2.0', method: 'session/update', params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hi' } } } };
    yield { jsonrpc: '2.0', id: 'p1', result: { stopReason: 'end_turn' } };
  };
  for await (const ev of client._iterSseMerged(client._fakeResponse, 'p1')) {
    if ('result' in ev) break;
  }
  assert.equal(client._pushedWaiters.length, 0, '回合结束必须回收等待者（修复前为 1）');

  let release;
  const gate = new Promise((r) => { release = r; });
  client._iterSse = async function* () {
    await gate;
    yield { jsonrpc: '2.0', id: 'p2', result: {} };
  };
  const it = client._iterSseMerged(client._fakeResponse, 'p2');
  const next = it.next();
  client._dispatchPushedEvent({ jsonrpc: '2.0', id: 99, method: '_codebuddy.ai/delegateTool', params: { toolId: 'x', toolCallId: 't' } });
  const got = await Promise.race([
    next.then((r) => r.value?.id ?? 'done'),
    new Promise((r) => setTimeout(() => r('TIMEOUT'), 300))
  ]);
  assert.equal(got, 99, '下一回合必须收到属于自己的推送事件（修复前被死等待者吞掉）');
  release();
  await it.return();
  assert.equal(client._pushedWaiters.length, 0, '主动 return 后也不得残留等待者');
});

test('B2: cancel() 精确移除本回合等待者，不影响其他等待者', async () => {
  const client = makeClient();
  const a = client._nextPushed();
  const b = client._nextPushed();
  assert.equal(client._pushedWaiters.length, 2);
  a.cancel();
  assert.equal(client._pushedWaiters.length, 1);
  // 投递事件应落到 b（唯一存活等待者）
  client._dispatchPushedEvent({ jsonrpc: '2.0', id: 7, method: 'x' });
  const r = await b.promise;
  assert.equal(r.value.id, 7);
  b.cancel(); // 已结算，cancel 应幂等
  assert.equal(client._pushedWaiters.length, 0);
});

test('B3: 已结算但输给 POST result 的推送事件回队，不丢失', async () => {
  const client = makeClient();
  // POST 流立即产出 result；push 事件安排在 POST 结算后的下一个微任务
  // （it.next() 先入队 POST 的解析，queueMicrotask 后入队推送解析 → POST 赢得 race）。
  client._iterSse = async function* () {
    yield { jsonrpc: '2.0', id: 'p1', result: { stopReason: 'end_turn' } };
  };
  const it = client._iterSseMerged(client._fakeResponse, 'p1');
  const pending = it.next();
  queueMicrotask(() => client._dispatchPushedEvent({ jsonrpc: '2.0', id: 55, method: '_codebuddy.ai/delegateTool', params: { toolId: 'y', toolCallId: 't2' } }));
  const r = await pending;
  assert.ok('result' in r.value, 'POST result 先胜出');
  await it.return();
  assert.equal(client._pushedEvents[0]?.id, 55, '竞速输给 POST 的事件必须回队首（修复前直接丢失）');
});

test('B4: 工具挂起丢弃迭代器时不泄漏等待者（主路径）', async () => {
  const client = makeClient();
  client._iterSse = async function* () {
    yield { jsonrpc: '2.0', id: 5, method: '_codebuddy.ai/delegateTool', params: { toolId: 'x', toolCallId: 't' } };
    await new Promise(() => {}); // 挂起后永不恢复
  };
  const it = client._iterSseMerged(client._fakeResponse, 'p1');
  const first = await it.next();
  assert.equal(first.value.method, '_codebuddy.ai/delegateTool');
  // 消费方（StreamDriver）在工具挂起处直接返回，且按设计不调用 iterator.return
  assert.equal(client._pushedWaiters.length, 0, '挂起时不得残留推送等待者（修复前为 1）');

  // 下一回合的推送事件不得被旧等待者吞掉
  client._iterSse = async function* () { await new Promise(() => {}); };
  const it2 = client._iterSseMerged(client._fakeResponse, 'p2');
  const next2 = it2.next();
  client._dispatchPushedEvent({ jsonrpc: '2.0', id: 77, method: 'x' });
  const got = await Promise.race([
    next2.then((r) => r.value?.id),
    new Promise((r) => setTimeout(() => r('TIMEOUT'), 300))
  ]);
  assert.equal(got, 77, '下一回合必须收到自己的事件');
  await it2.return();
});

test('B5: 挂起 detach 时已结算的推送事件回队（第二轮 CR 窗口 1）', async () => {
  const client = makeClient();
  client._iterSse = async function* () {
    yield { jsonrpc: '2.0', id: 5, method: '_codebuddy.ai/delegateTool', params: { toolId: 'x', toolCallId: 't' } };
    await new Promise(() => {});
  };
  const it = client._iterSseMerged(client._fakeResponse, 'p1');
  const pending = it.next();
  // POST 先结算；推送在紧随其后的微任务结算 —— detach 时它已 settled
  queueMicrotask(() => client._dispatchPushedEvent({ jsonrpc: '2.0', id: 88, method: 'x' }));
  const first = await pending;
  assert.equal(first.value.method, '_codebuddy.ai/delegateTool');
  assert.equal(client._pushedWaiters.length, 0, '挂起后零等待者');
  assert.equal(client._pushedEvents[0]?.id, 88, 'detach 时已结算的事件必须回队首');
});

test('B6: 挂起后若被恢复，推送等待者重新注册', async () => {
  const client = makeClient();
  client._iterSse = async function* () {
    yield { jsonrpc: '2.0', id: 5, method: '_codebuddy.ai/delegateTool', params: { toolId: 'x', toolCallId: 't' } };
    yield { jsonrpc: '2.0', method: 'session/update', params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'more' } } } };
    await new Promise(() => {});
  };
  const it = client._iterSseMerged(client._fakeResponse, 'p1');
  await it.next(); // 挂起 → detach
  assert.equal(client._pushedWaiters.length, 0);
  await it.next(); // 恢复 → rearm，再消费下一个 POST 事件
  assert.equal(client._pushedWaiters.length, 1, '恢复后必须重新注册推送等待者');
  await it.return();
  assert.equal(client._pushedWaiters.length, 0);
});

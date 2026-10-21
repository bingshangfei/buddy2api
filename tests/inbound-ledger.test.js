/**
 * inbound-ledger 单测（node:test，零依赖，假 sendError + 假时钟直测——批5 交付面）。
 *
 * 两态语义是行为锚（2026-09-22 生产 trace + 评审 K3/R11）：
 *   - awaiting 兜底锚点 = 注册时刻，不被 touch 滑动；
 *   - confirming（sent=true）随事件滑动重置；
 *   - clearInboundWindows 只清 sent=true；
 *   - sendError 失败重试恰好一次（W8）。
 * AcpClient 侧的接线（委托/迟到绑定/幂等集合）由 delegate-reply-timeout.test 钉死。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createInboundLedger } from '../src/inbound-ledger.js';

/** 假时钟：捕获 setTimeout，手动 fire；返回 { clock, fired } */
function fakeClock() {
  const pending = [];
  let seq = 0;
  const setTimeoutFn = (fn, ms) => { const t = { id: ++seq, fn, ms, cleared: false }; pending.push(t); return t; };
  const clearTimeoutFn = (t) => { if (t) t.cleared = true; };
  const fireOne = () => {
    const t = pending.find((x) => !x.cleared);
    if (!t) return false;
    t.cleared = true;
    t.fn();
    return true;
  };
  return { setTimeoutFn, clearTimeoutFn, fireOne, pendingCount: () => pending.filter((x) => !x.cleared).length, pending };
}

function makeLedger({ timeoutMs = 60000, clock = fakeClock(), errors = [] } = {}) {
  const ledger = createInboundLedger({
    sendError: async (id, code, message) => { errors.push({ id, code, message }); },
    getTimeoutMs: () => timeoutMs,
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn
  });
  return { ledger, clock, errors };
}

test('register：委托域请求入表并武装 awaiting 定时器；幂等（重复注册只一条日志一次武装）', () => {
  const { ledger, clock } = makeLedger();
  ledger.registerInbound({ id: 7, method: '_codebuddy.ai/delegateTool' });
  assert.equal(clock.pendingCount(), 1);
  ledger.registerInbound({ id: 7, method: '_codebuddy.ai/delegateTool' });
  assert.equal(clock.pendingCount(), 1, '幂等：不重复武装');
  ledger.registerInbound({ id: 7, method: 'session/request_permission' });
  assert.equal(clock.pendingCount(), 1, '同 id 第二通道到达仍幂等');
});

test('register：非委托事件 / 无 id 通知不入表', () => {
  const { ledger, clock } = makeLedger();
  ledger.registerInbound({ id: 1, method: 'session/update' });
  ledger.registerInbound({ method: '_codebuddy.ai/delegateTool' });
  assert.equal(clock.pendingCount(), 0);
});

test('awaiting 到点未被消费 → error 兜底单发（R11：与回合状态无关）', () => {
  const { ledger, clock, errors } = makeLedger();
  ledger.registerInbound({ id: 7, method: '_codebuddy.ai/delegateTool' });
  clock.fireOne();
  assert.equal(errors.length, 1);
  assert.equal(errors[0].id, 7);
  assert.equal(errors[0].code, -32001);
  assert.match(errors[0].message, /dropped before delivery/);
});

test('K3 锚：touch 不滑动 awaiting——定时器不重置（锚点保持注册时刻）', () => {
  const { ledger, clock } = makeLedger();
  ledger.registerInbound({ id: 7, method: 'session/request_permission' });
  const before = clock.pendingCount();
  ledger.touchInbound();
  ledger.touchInbound();
  assert.equal(clock.pendingCount(), before, 'awaiting 条目不被 touch 触碰');
});

test('confirming：markInboundSent 后 touch 重置确认窗；clearInboundWindows 清 sent=true', () => {
  const { ledger, clock } = makeLedger();
  const event = { id: 9, method: 'session/request_permission' };
  ledger.registerInbound(event);
  assert.equal(ledger.markInboundSent(event), true, '命中在途注册');
  const armedBefore = clock.pendingCount();
  ledger.touchInbound();
  ledger.touchInbound();
  assert.ok(clock.pendingCount() >= armedBefore, '确认窗随事件滑动重置（重武装不累积为多定时器）');
  ledger.clearInboundWindows();
  assert.equal(clock.pendingCount(), 0, 'sent=true 条目被清窗');
});

test('F11 加固锚：clearInboundWindows 不动 awaiting（推送丢失的兜底节奏与回合状态无关）', () => {
  const { ledger, clock, errors } = makeLedger();
  ledger.registerInbound({ id: 7, method: '_codebuddy.ai/delegateTool' }); // awaiting
  const permission = { id: 9, method: 'session/request_permission' };
  ledger.registerInbound(permission);
  ledger.markInboundSent(permission); // confirming
  ledger.clearInboundWindows();
  clock.fireOne();
  assert.equal(errors.length, 1, 'awaiting 条目到点仍须兜底（smoke S1 场景）');
  assert.equal(errors[0].id, 7);
});

test('ack：出表且定时器清；miss 为 no-op 返 false', () => {
  const { ledger, clock } = makeLedger();
  ledger.registerInbound({ id: 7, method: '_codebuddy.ai/delegateTool' });
  assert.equal(ledger.ackInbound({ id: 7, method: '_codebuddy.ai/delegateTool' }), true);
  assert.equal(clock.pendingCount(), 0);
  assert.equal(ledger.ackInbound({ id: 7, method: '_codebuddy.ai/delegateTool' }), false, '已出表 = miss');
  assert.equal(ledger.ackInbound({ method: '_codebuddy.ai/delegateTool' }), false, '无 id = miss');
});

test('confirming 到点零活动 → 兜底 + 恰好重试一次（W8）', async () => {
  const calls = [];
  const clock = fakeClock();
  let failFirst = true;
  const ledger = createInboundLedger({
    sendError: async () => {
      calls.push(1);
      if (failFirst) { failFirst = false; throw new Error('POST boom'); }
    },
    getTimeoutMs: () => 60000,
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn
  });
  const event = { id: 9, method: 'session/request_permission' };
  ledger.registerInbound(event);
  ledger.markInboundSent(event);
  clock.fireOne(); // confirming 到点 → 第一次 sendError 抛错
  await new Promise((r) => setImmediate(r)); // 让 catch 里的重试排程执行
  assert.equal(calls.length, 2, '失败后恰好重试一次');
});

test('getTimeoutMs 迟到绑定（F6）：getter 每次武装时求值，改字段后按新值武装', () => {
  let timeoutMs = 60000;
  const clock = fakeClock();
  const ledger = createInboundLedger({
    sendError: async () => {},
    getTimeoutMs: () => timeoutMs,
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn
  });
  ledger.registerInbound({ id: 1, method: 'session/request_permission' });
  // 第一条武装按 60000
  const first = clock.pending.find((t) => !t.cleared);
  assert.equal(first.ms, 60000);
  timeoutMs = 40; // 构造后改字段（delegate-reply-timeout 测试的用法）
  const permission = { id: 2, method: 'session/request_permission' };
  ledger.registerInbound(permission);
  const second = clock.pending.filter((t) => !t.cleared).pop();
  assert.equal(second.ms, 40, '新武装按新值（快照注入会让短超时用例退化 60s 真等）');
});

test('clearAll：全清（含 awaiting）——连接销毁出口', () => {
  const { ledger, clock } = makeLedger();
  ledger.registerInbound({ id: 7, method: '_codebuddy.ai/delegateTool' });
  const permission = { id: 9, method: 'session/request_permission' };
  ledger.registerInbound(permission);
  ledger.markInboundSent(permission);
  ledger.clearAll();
  assert.equal(clock.pendingCount(), 0);
  assert.equal(ledger.size(), 0);
});

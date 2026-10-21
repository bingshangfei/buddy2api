/**
 * pending-expiry 单测（node:test，零依赖，假时钟直测——批2 交付面）。
 *
 * 覆盖：武装定时器（默认 TTL / 重复武装幂等 / null 兜底）与到期守卫矩阵
 * （串台事故回归锚：resuming / 缺 toolCall / 缺条目 必须跳过销毁）。
 * 销毁序列本身是被测试钉死的行为锚，留 handler `_onPendingTimeout`（不在此测）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { armPendingTimer, pendingExpiryNoop, DEFAULT_PENDING_TTL_MS } from '../src/pending-expiry.js';

/** 假时钟：捕获 setTimeout/clearTimeout，手动 fire。 */
function fakeClock() {
  const timers = [];
  const cleared = [];
  return {
    timers,
    cleared,
    setTimeoutFn: (fn, ms) => { const t = { fn, ms }; timers.push(t); return t; },
    clearTimeoutFn: (t) => { if (t) cleared.push(t); },
    fire() { for (const t of timers.splice(0)) t.fn(); }
  };
}

test('武装：timer 挂在条目上，默认 TTL = 5 分钟', () => {
  const clock = fakeClock();
  const state = {};
  armPendingTimer(state, () => {}, { setTimeoutFn: clock.setTimeoutFn, clearTimeoutFn: clock.clearTimeoutFn });
  assert.equal(state.timer, clock.timers[0]);
  assert.equal(clock.timers[0].ms, DEFAULT_PENDING_TTL_MS);
  assert.equal(DEFAULT_PENDING_TTL_MS, 5 * 60 * 1000);
});

test('武装：重复武装幂等——旧 timer 先清、新 timer 顶替', () => {
  const clock = fakeClock();
  const state = {};
  armPendingTimer(state, () => {}, { setTimeoutFn: clock.setTimeoutFn, clearTimeoutFn: clock.clearTimeoutFn });
  const first = state.timer;
  armPendingTimer(state, () => {}, { setTimeoutFn: clock.setTimeoutFn, clearTimeoutFn: clock.clearTimeoutFn });
  assert.deepEqual(clock.cleared, [first]);
  assert.equal(state.timer, clock.timers[1]);
  assert.notEqual(state.timer, first);
});

test('武装：null 条目 no-op（handler set 后才 arm 的守卫兜底）', () => {
  const clock = fakeClock();
  armPendingTimer(null, () => {}, { setTimeoutFn: clock.setTimeoutFn, clearTimeoutFn: clock.clearTimeoutFn });
  assert.equal(clock.timers.length, 0);
});

test('武装：到期触发 onExpire 恰好一次', () => {
  const clock = fakeClock();
  let fired = 0;
  const state = {};
  armPendingTimer(state, () => { fired++; }, { setTimeoutFn: clock.setTimeoutFn, clearTimeoutFn: clock.clearTimeoutFn });
  clock.fire();
  assert.equal(fired, 1);
  assert.equal(clock.timers.length, 0);
});

test('到期守卫矩阵：缺条目/缺 toolCall/resuming 中 → 无可取消（串台事故回归锚）', () => {
  // 缺条目：历史上 `s && !s.toolCall` 反向漏判 → invalidate(undefined) 误销其他请求连接
  assert.equal(pendingExpiryNoop(null), true);
  assert.equal(pendingExpiryNoop(undefined), true);
  // 流程已正常完成/被回传：toolCall 已清
  assert.equal(pendingExpiryNoop({}), true);
  // 已在回传中：续跑期间 toolCall 保留，必须靠 resuming 跳过
  assert.equal(pendingExpiryNoop({ toolCall: { name: 'x' }, resuming: true }), true);
  // 真挂起：无可取消为 false → 销毁序列应执行
  assert.equal(pendingExpiryNoop({ toolCall: { name: 'x' }, resuming: false }), false);
});

/**
 * finalizer.js 直测（refactor-20260928-arch-deepening2 批4）。
 *
 * 三条消费路径 catch 段的头/尾处置簇收进本模块后，这里从**窄接口**断言
 * 「错误类别 → 资源处置」的映射与调用序；路径侧的整条序列仍由
 * handler-path-contract（BC-7）钉死，两者互补。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { disposeConnError, releaseAfterError, disposeWedge } from '../src/finalizer.js';

/** 替身：记录方法调用序 */
function fakeDeps() {
  const calls = [];
  return {
    calls,
    pending: { delete: (k) => calls.push(`pending.delete:${k}`) },
    sessions: {
      discardPool: (k, p) => calls.push(`discardPool:${p}`),
      reportAccountHealth: (a, h) => calls.push(`health:${a}:${h.ok ? 'ok' : 'fail'}`),
      invalidate: (k, p) => calls.push(`invalidate:${p}`)
    }
  };
}

const wedgeErr = () => Object.assign(new Error('首 token 超时'), { name: 'FirstTokenTimeoutError' });

test('disposeConnError：连接类错误 → 丢弃死后端 + 清挂起，不上报账号健康（不冷却）', () => {
  const deps = fakeDeps();
  const r = disposeConnError({
    pending: deps.pending, sessions: deps.sessions, key: 'k1', poolId: 'p1',
    error: new Error('connect ECONNREFUSED 127.0.0.1:1')
  });
  assert.deepEqual(r, { wedge: false, connError: true });
  assert.deepEqual(deps.calls, ['pending.delete:k1', 'discardPool:p1'],
    '头簇次序 = 先清挂起再丢后端（三 catch 现状逐字平移）');
});

test('disposeConnError：假死视同连接类（不冷却账号）；普通错误不触发处置', () => {
  const deps = fakeDeps();
  const r = disposeConnError({ pending: deps.pending, sessions: deps.sessions, key: 'k', poolId: 'p', error: wedgeErr() });
  assert.deepEqual(r, { wedge: true, connError: true }, 'wedge ⊆ connError（不冷却口径）');
  assert.deepEqual(deps.calls, ['pending.delete:k', 'discardPool:p']);

  const deps2 = fakeDeps();
  const r2 = disposeConnError({ pending: deps2.pending, sessions: deps2.sessions, key: 'k', poolId: 'p', error: new Error('upstream model failed') });
  assert.deepEqual(r2, { wedge: false, connError: false });
  assert.deepEqual(deps2.calls, [], '非连接类错误在头簇不做任何处置');
});

test('releaseAfterError：非连接类 → 清挂起 + 上报账号失败 + invalidate（次序钉死）', () => {
  const deps = fakeDeps();
  releaseAfterError({
    pending: deps.pending, sessions: deps.sessions, key: 'k1', poolId: 'p1',
    accountId: 'acc-1', error: new Error('upstream model failed'), connError: false
  });
  assert.deepEqual(deps.calls, ['pending.delete:k1', 'health:acc-1:fail', 'invalidate:p1']);
});

test('releaseAfterError：连接类 → 只清挂起 + invalidate，不冷却账号', () => {
  const deps = fakeDeps();
  releaseAfterError({
    pending: deps.pending, sessions: deps.sessions, key: 'k1', poolId: 'p1',
    accountId: 'acc-1', error: new Error('socket hang up'), connError: true
  });
  assert.deepEqual(deps.calls, ['pending.delete:k1', 'invalidate:p1'],
    '连接类不得上报账号失败（误冷却会放大故障面）');
});

// ===== 楔形尾（refactor-20261013-arch-deepening9 #8）=====

test('disposeWedge：取消先于丢弃 + 置 wedgeReason + 返回 reason（三路径共用的处置序）', () => {
  const order = [];
  const state = {};
  const r = disposeWedge({
    cancel: () => order.push('cancel'),
    discardBackend: (url) => order.push(`discard:${url}`),
    url: 'p1', reason: 'mid-stream', state
  });
  assert.deepEqual(order, ['cancel', 'discard:p1'], '取消（停止上游）必须先于从池中摘除');
  assert.equal(state.wedgeReason, 'mid-stream', 'wedgeReason 随处置一并置位（汇总日志诊断字段）');
  assert.equal(r, 'mid-stream', '返回归一化 reason 供错误工厂使用');
});

test('disposeWedge：可缺省 cancel/discardBackend/state（窄接口容忍，不抛）', () => {
  assert.doesNotThrow(() => disposeWedge({ url: 'p', reason: 'first-token' }));
  const state = {};
  // 只给 state：仍应置 wedgeReason，且不因缺处理函数抛错
  const r = disposeWedge({ url: 'p', reason: 'first-token', state });
  assert.equal(state.wedgeReason, 'first-token');
  assert.equal(r, 'first-token');
});

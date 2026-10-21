/**
 * 账号池单测（node:test，零依赖）。
 *
 * 覆盖：轮转、冷却跳过、全部冷却时挑最快恢复、失败分类、连续失败加倍冷却，
 * 以及凭据存取（导入/列出/删除）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AccountPool, classifyFailure, COOLDOWN_MS } from '../src/account-pool.js';

/** 造一个临时账号目录并注入环境变量，返回 { dir, restore } */
function withTempAccounts(records) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'buddy2api-acc-'));
  for (const r of records) {
    fs.writeFileSync(path.join(dir, `${r.id}.json`), JSON.stringify(r), 'utf8');
  }
  const prev = process.env.BUDDY2API_ACCOUNTS_DIR;
  process.env.BUDDY2API_ACCOUNTS_DIR = dir;
  return {
    dir,
    restore() {
      if (prev === undefined) delete process.env.BUDDY2API_ACCOUNTS_DIR;
      else process.env.BUDDY2API_ACCOUNTS_DIR = prev;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
}

function acc(id, nickname, expiresAt = Date.now() + 86_400_000) {
  return { id, nickname, uid: id, accessToken: `tok-${id}`, expiresAt };
}

test('AccountPool: 无账号时 pick 返回 null', () => {
  const h = withTempAccounts([]);
  try {
    const pool = new AccountPool();
    assert.equal(pool.pick(), null);
  } finally { h.restore(); }
});

test('AccountPool: 单账号时每次都选它', () => {
  const h = withTempAccounts([acc('a', '账号A')]);
  try {
    const pool = new AccountPool();
    assert.equal(pool.pick().account.id, 'a');
    assert.equal(pool.pick().account.id, 'a');
  } finally { h.restore(); }
});

test('AccountPool: 多账号轮转（round-robin）', () => {
  const h = withTempAccounts([acc('a', '账号A'), acc('b', '账号B'), acc('c', '账号C')]);
  try {
    const pool = new AccountPool();
    const picked = [pool.pick(), pool.pick(), pool.pick(), pool.pick()].map((r) => r.account.id);
    assert.deepEqual(picked.slice(0, 3), ['a', 'b', 'c'], '前三次应依次轮转');
    assert.equal(picked[3], 'a', '第四次回到开头');
  } finally { h.restore(); }
});

test('AccountPool: 冷却中的账号被跳过', () => {
  const h = withTempAccounts([acc('a', '账号A'), acc('b', '账号B')]);
  try {
    const pool = new AccountPool();
    pool.reportFailure('a', 'rate-limit');
    const picks = [pool.pick(), pool.pick(), pool.pick()].map((r) => r.account.id);
    assert.ok(picks.every((id) => id === 'b'), 'A 冷却期间只应选 B');
  } finally { h.restore(); }
});

test('AccountPool: 全部冷却时挑最快恢复的，并标记 coolingDown', () => {
  const h = withTempAccounts([acc('a', '账号A'), acc('b', '账号B')]);
  try {
    const pool = new AccountPool();
    const now = Date.now();
    pool.reportFailure('a', 'error', { now });          // 冷却 1 分钟
    pool.reportFailure('b', 'rate-limit', { now });     // 冷却 10 分钟
    const p = pool.pick({ now: now + 1000 });
    assert.equal(p.account.id, 'a', '应挑最快恢复的 A');
    assert.equal(p.coolingDown, true, '应标记为冷却中');
    assert.ok(p.cooldownMs > 0, '应给出剩余等待时间');
  } finally { h.restore(); }
});

test('AccountPool: 连续失败时冷却时间递增（上限 4 倍）', () => {
  const h = withTempAccounts([acc('a', '账号A')]);
  try {
    const pool = new AccountPool();
    const now = Date.now();
    const r1 = pool.reportFailure('a', 'error', { now });
    const r2 = pool.reportFailure('a', 'error', { now });
    const r3 = pool.reportFailure('a', 'error', { now });
    const r5 = pool.reportFailure('a', 'error', { now }); // 第 4 次起封顶
    const r6 = pool.reportFailure('a', 'error', { now });
    assert.equal(r1.cooldownMs, COOLDOWN_MS.error * 1);
    assert.equal(r2.cooldownMs, COOLDOWN_MS.error * 2);
    assert.equal(r3.cooldownMs, COOLDOWN_MS.error * 3);
    assert.equal(r5.cooldownMs, COOLDOWN_MS.error * 4);
    assert.equal(r6.cooldownMs, COOLDOWN_MS.error * 4, '冷却上限为 4 倍');
  } finally { h.restore(); }
});

test('AccountPool: reportSuccess 清除冷却与失败计数', () => {
  const h = withTempAccounts([acc('a', '账号A')]);
  try {
    const pool = new AccountPool();
    pool.reportFailure('a', 'rate-limit');
    assert.equal(pool.status()[0].coolingDown, true);
    pool.reportSuccess('a');
    assert.equal(pool.status()[0].coolingDown, false);
    assert.equal(pool.status()[0].failures, 0);
  } finally { h.restore(); }
});

test('classifyFailure: 429/频控 → rate-limit；401/认证 → auth；其他 → error', () => {
  assert.equal(classifyFailure('429 rate limited'), 'rate-limit');
  assert.equal(classifyFailure('WorkBuddy 排队中，资源紧张'), 'rate-limit');
  assert.equal(classifyFailure('配额已用尽'), 'rate-limit');
  assert.equal(classifyFailure('401 Unauthorized'), 'auth');
  assert.equal(classifyFailure('登录态被拒绝（HTTP 401）'), 'auth');
  assert.equal(classifyFailure('socket hang up'), 'error');
});

test('AccountPool: 过期账号不参与轮转', () => {
  const h = withTempAccounts([
    acc('a', '有效', Date.now() + 86_400_000),
    acc('b', '已过期', Date.now() - 1000)
  ]);
  try {
    const pool = new AccountPool();
    const ids = [pool.pick(), pool.pick(), pool.pick()].map((r) => r.account.id);
    assert.ok(ids.every((id) => id === 'a'), '过期账号不应被选中');
  } finally { h.restore(); }
});

// ===== 余额感知选择（feature-20260918-credit-aware-account-pick）=====
// 矩阵见 .trellis/tasks/feature-20260918-credit-aware-account-pick/evidence/test-matrix.md

/**
 * 可注入余额的池：fetchBalance 桩（按 uid 返回 state.map 中的余额，
 * uid 在 state.failIds 中则抛错），关闭定时器。
 */
function poolWithStub(initialEntries) {
  const state = {
    map: new Map(initialEntries),
    failIds: new Set(),
    calls: 0
  };
  const pool = new AccountPool({
    refreshIntervalMs: 0,
    accountRefreshMs: 0,
    fetchBalance: async (opts) => {
      state.calls += 1;
      if (state.failIds.has(opts.uid)) throw new Error('billing unavailable');
      const b = state.map.get(opts.uid);
      if (!b) throw new Error(`no stub for ${opts.uid}`);
      return { remaining: b.remaining, total: b.total, used: b.total - b.remaining, unit: 'credits' };
    }
  });
  return { pool, state };
}

test('AccountPool: 默认余额刷新间隔为 2 小时', async () => {
  const { BALANCE_REFRESH_INTERVAL_MS } = await import('../src/account-pool.js');
  assert.equal(BALANCE_REFRESH_INTERVAL_MS, 2 * 60 * 60 * 1000);
});

test('AccountPool: 余额已知且>0 时优先余额最大者（矩阵2）', async () => {
  const h = withTempAccounts([acc('a', '账号A'), acc('b', '账号B')]);
  try {
    const { pool } = poolWithStub([
      ['a', { remaining: 100, total: 200 }],
      ['b', { remaining: 50, total: 200 }]
    ]);
    await pool.refreshBalances();
    const picks = [pool.pick(), pool.pick(), pool.pick()].map((r) => r.account.id);
    assert.deepEqual(picks, ['a', 'a', 'a'], '应连续选余额最大的 a');
  } finally { h.restore(); }
});

test('AccountPool: 余额被消耗下降后切换到更大者（自平衡，矩阵3）', async () => {
  const h = withTempAccounts([acc('a', '账号A'), acc('b', '账号B')]);
  try {
    const { pool, state } = poolWithStub([
      ['a', { remaining: 100, total: 200 }],
      ['b', { remaining: 50, total: 200 }]
    ]);
    await pool.refreshBalances();
    assert.equal(pool.pick().account.id, 'a');
    state.map.set('a', { remaining: 40, total: 200 }); // a 被消耗到 40
    await pool.refreshBalances();
    assert.equal(pool.pick().account.id, 'b', 'a 低于 b 后应改选 b');
  } finally { h.restore(); }
});

test('AccountPool: 余额持平按游标交替，不死磕一个（矩阵4）', async () => {
  const h = withTempAccounts([acc('a', '账号A'), acc('b', '账号B')]);
  try {
    const { pool } = poolWithStub([
      ['a', { remaining: 100, total: 200 }],
      ['b', { remaining: 100, total: 200 }]
    ]);
    await pool.refreshBalances();
    const picks = [pool.pick(), pool.pick(), pool.pick(), pool.pick()].map((r) => r.account.id);
    assert.deepEqual(picks, ['a', 'b', 'a', 'b'], '并列最高应在两者间交替');
  } finally { h.restore(); }
});

test('AccountPool: 已知余额>0 优先于未知（矩阵5）', async () => {
  const h = withTempAccounts([acc('a', '账号A'), acc('b', '账号B')]);
  try {
    const { pool } = poolWithStub([['a', { remaining: 100, total: 200 }]]);
    await pool.refreshBalances(); // b 桩缺失 → 未知
    const picks = [pool.pick(), pool.pick()].map((r) => r.account.id);
    assert.deepEqual(picks, ['a', 'a'], '已知>0 的 a 应优先于未知的 b');
  } finally { h.restore(); }
});

test('AccountPool: 无已知>0 时（耗尽+未知）全部按游标轮转（矩阵6）', async () => {
  const h = withTempAccounts([acc('a', '账号A'), acc('b', '账号B')]);
  try {
    const { pool } = poolWithStub([['a', { remaining: 0, total: 200 }]]);
    await pool.refreshBalances(); // a 耗尽，b 未知
    const picks = [pool.pick(), pool.pick(), pool.pick(), pool.pick()].map((r) => r.account.id);
    assert.deepEqual(picks, ['a', 'b', 'a', 'b'], '耗尽+未知同层，应轮转兜底');
  } finally { h.restore(); }
});

test('AccountPool: 余额耗尽的排在有余额者之后（矩阵7）', async () => {
  const h = withTempAccounts([acc('a', '账号A'), acc('b', '账号B')]);
  try {
    const { pool } = poolWithStub([
      ['a', { remaining: 0, total: 200 }],
      ['b', { remaining: 50, total: 200 }]
    ]);
    await pool.refreshBalances();
    const picks = [pool.pick(), pool.pick(), pool.pick()].map((r) => r.account.id);
    assert.deepEqual(picks, ['b', 'b', 'b'], '应优先还有余额的 b');
  } finally { h.restore(); }
});

test('AccountPool: 全部耗尽时仍兜底可用（矩阵8）', async () => {
  const h = withTempAccounts([acc('a', '账号A'), acc('b', '账号B')]);
  try {
    const { pool } = poolWithStub([
      ['a', { remaining: 0, total: 200 }],
      ['b', { remaining: 0, total: 200 }]
    ]);
    await pool.refreshBalances();
    const picks = [pool.pick(), pool.pick(), pool.pick()].map((r) => r.account.id);
    assert.deepEqual(picks, ['a', 'b', 'a'], '全耗尽应轮转兜底而不是无账号可用');
    assert.equal(pool.pick().coolingDown, false);
  } finally { h.restore(); }
});

test('AccountPool: 余额最高者冷却中 → 剩余就绪集内取最大（矩阵9）', async () => {
  const h = withTempAccounts([acc('a', '账号A'), acc('b', '账号B')]);
  try {
    const { pool } = poolWithStub([
      ['a', { remaining: 100, total: 200 }],
      ['b', { remaining: 50, total: 200 }]
    ]);
    await pool.refreshBalances();
    pool.reportFailure('a', 'rate-limit');
    const picks = [pool.pick(), pool.pick()].map((r) => r.account.id);
    assert.deepEqual(picks, ['b', 'b'], 'a 冷却后应在就绪集内选余额最大的 b');
  } finally { h.restore(); }
});

test('AccountPool: pick 零网络调用（同步性，矩阵12）', async () => {
  const h = withTempAccounts([acc('a', '账号A'), acc('b', '账号B')]);
  try {
    const { pool, state } = poolWithStub([
      ['a', { remaining: 100, total: 200 }],
      ['b', { remaining: 50, total: 200 }]
    ]);
    await pool.refreshBalances();
    const before = state.calls;
    for (let i = 0; i < 5; i++) pool.pick();
    assert.equal(state.calls, before, 'pick 不得发起任何网络调用');
  } finally { h.restore(); }
});

test('AccountPool: status 暴露余额字段，未知账号无该键（矩阵13）', async () => {
  const h = withTempAccounts([acc('a', '账号A'), acc('b', '账号B')]);
  try {
    const { pool } = poolWithStub([['a', { remaining: 100, total: 200 }]]);
    await pool.refreshBalances();
    const list = pool.status();
    const sa = list.find((s) => s.id === 'a');
    const sb = list.find((s) => s.id === 'b');
    assert.equal(sa.balance.remaining, 100);
    assert.equal(sa.balance.total, 200);
    assert.equal(sa.balance.unit, 'credits');
    assert.equal(typeof sa.balance.at, 'number', '应带采样时间戳');
    assert.equal('balance' in sb, false, '未知余额的账号不应有 balance 键');
  } finally { h.restore(); }
});

test('AccountPool: validateAll 成功写入余额缓存（矩阵15）', async () => {
  const h = withTempAccounts([acc('a', '账号A'), acc('b', '账号B')]);
  try {
    const { pool } = poolWithStub([
      ['a', { remaining: 100, total: 200 }],
      ['b', { remaining: 50, total: 200 }]
    ]);
    const r = await pool.validateAll();
    assert.equal(r.healthy.length, 2);
    const picks = [pool.pick(), pool.pick()].map((x) => x.account.id);
    assert.deepEqual(picks, ['a', 'a'], 'validateAll 之后 pick 应感知余额');
    assert.equal(pool.status()[0].balance.remaining, 100);
  } finally { h.restore(); }
});

test('AccountPool: 刷新失败保留旧值，成功者更新（矩阵16/R3）', async () => {
  const h = withTempAccounts([acc('a', '账号A'), acc('b', '账号B')]);
  try {
    const { pool, state } = poolWithStub([
      ['a', { remaining: 100, total: 200 }],
      ['b', { remaining: 50, total: 200 }]
    ]);
    await pool.refreshBalances({ now: 1_000_000 });
    state.failIds.add('a'); // a 探活开始失败
    state.map.set('b', { remaining: 70, total: 200 });
    await pool.refreshBalances({ now: 1_005_000 });
    const sa = pool.status().find((s) => s.id === 'a');
    const sb = pool.status().find((s) => s.id === 'b');
    assert.equal(sa.balance.remaining, 100, '失败者应保留旧值');
    assert.equal(sa.balance.at, 1_000_000, '失败者采样时间不应更新');
    assert.equal(sb.balance.remaining, 70, '成功者应更新');
    assert.equal(sb.balance.at, 1_005_000, '成功者采样时间应更新');
  } finally { h.restore(); }
});

test('AccountPool: 定时刷新按注入间隔执行，dispose 后停止（矩阵17/A9）', async () => {
  const h = withTempAccounts([acc('a', '账号A')]);
  const { mock } = await import('node:test');
  let calls = 0;
  let live;
  mock.timers.enable({ apis: ['setInterval'] });
  try {
    live = new AccountPool({
      refreshIntervalMs: 30,
      accountRefreshMs: 0,
      fetchBalance: async () => {
        calls += 1;
        return { remaining: 100, total: 200, used: 100, unit: 'credits' };
      }
    });
    const flush = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)); };
    mock.timers.tick(60); // 两个 30ms 间隔
    await flush();
    assert.ok(calls >= 2, `60ms 内 30ms 间隔应至少刷新 2 次（实际 ${calls}）`);
    assert.equal(live.status()[0].balance?.remaining, 100, '定时器路径应真实写入余额缓存（A9）');
    live.dispose();
    mock.timers.tick(80);
    await flush();
    assert.equal(calls, 2, 'dispose 后应停止刷新');
  } finally {
    live?.dispose();
    mock.timers.reset();
    h.restore();
  }
});

test('AccountPool: validateAll 进行中 pick 正常轮转（启动竞态 R1/R2，矩阵18）', async () => {
  const h = withTempAccounts([acc('a', '账号A'), acc('b', '账号B')]);
  try {
    const { pool } = poolWithStub([
      ['a', { remaining: 100, total: 200 }],
      ['b', { remaining: 50, total: 200 }]
    ]);
    const pending = pool.validateAll(); // 不等待：模拟启动窗口
    try {
      const picks = [pool.pick(), pool.pick(), pool.pick()].map((r) => r.account.id);
      assert.deepEqual(picks, ['a', 'b', 'a'], '余额未就绪时应纯轮转');
      const p = pool.pick();
      assert.equal(typeof p.account.id, 'string');
      assert.equal(p.coolingDown, false, '返回形状必须完整（无部分读）');
    } finally { await pending; }
  } finally { h.restore(); }
});

// ---------- 损坏记录（非 string token）读侧收口 ----------

test('AccountPool: 损坏记录（对象 token）不进入账号列表/选择/状态', () => {
  const h = withTempAccounts([
    acc('good', '好账号'),
    { id: 'bad', uid: 'bad', nickname: { $wbEncrypted: 1, envelope: 'x' }, accessToken: { $wbEncrypted: 1, envelope: 'x' }, expiresAt: Date.now() + 86_400_000 }
  ]);
  try {
    const pool = new AccountPool();
    const ids = pool.accounts({ force: true }).map((a) => a.id);
    assert.deepEqual(ids, ['good'], '损坏记录不得进入轮转集');
    for (let i = 0; i < 4; i++) assert.equal(pool.pick().account.id, 'good');
    assert.equal(pool.status().every((s) => s.id !== 'bad'), true, 'status 不得暴露损坏记录');
  } finally { h.restore(); }
});

test('AccountPool: 全部记录损坏 → 等价于无账号（pick 返回 null）', () => {
  const h = withTempAccounts([
    { id: 'bad1', uid: 'bad1', nickname: { $wbEncrypted: 1 }, accessToken: { $wbEncrypted: 1 }, expiresAt: Date.now() + 86_400_000 }
  ]);
  try {
    const pool = new AccountPool();
    assert.equal(pool.pick(), null);
    assert.equal(pool.status().length, 0);
  } finally { h.restore(); }
});

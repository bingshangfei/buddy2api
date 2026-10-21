/**
 * 后端池 env 配置（容量 / 队列超时 / STATE_DIR）与 warmup 预热数 单测。
 *
 * 对应 evidence/test-matrix.md：
 *   A 组（A1-A15）容量可配 + 钳制 + 预热数（拍板④）
 *   B 组（B1-B3）STATE_DIR 隔离（拍板③）
 *
 * 两个隔离前提：
 *   1. 把 os.tmpdir() 指向临时目录——被测模块在加载时会 restoreState() 探活真实
 *      池文件（%TEMP%/buddy2api/backends.json），不隔离会把测试后端写进用户的池。
 *   2. 账号目录指向临时目录——否则 warmup 会读到真实 data/accounts。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

// 必须在动态 import 被测模块**之前**设好（模块加载时读 os.tmpdir()）
const ISOLATED_TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'buddy2api-cfg-root-'));
process.env.TEMP = ISOLATED_TMP;
process.env.TMP = ISOLATED_TMP;
process.env.TMPDIR = ISOLATED_TMP;

const GW_FILE = fileURLToPath(new URL('../src/gateway-discovery.js', import.meta.url));
const GW_URL = pathToFileURL(GW_FILE).href;
const gw = await import('../src/gateway-discovery.js');

const NEW_ENV_KEYS = ['BUDDY2API_MAX_BACKENDS', 'BUDDY2API_QUEUE_TIMEOUT_MS', 'BUDDY2API_STATE_DIR'];

/** 在子进程中加载模块并回读 env 派生常量：真源 = 全新进程 + 全新模块实例 */
function readConstsInChild(extraEnv = {}) {
  const env = { ...process.env, ...extraEnv };
  for (const k of NEW_ENV_KEYS) if (!(k in extraEnv)) delete env[k];
  const script =
    `const m = await import(${JSON.stringify(GW_URL)});\n` +
    `console.log('__CFG__' + JSON.stringify({ maxBackends: m.MAX_BACKENDS, queueTimeoutMs: m.QUEUE_TIMEOUT_MS, poolFile: m.POOL_FILE }));`;
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], { env, encoding: 'utf8' });
  const line = out.split('\n').find((l) => l.startsWith('__CFG__'));
  assert.ok(line, `子进程未输出常量（输出：${out.slice(0, 400)}）`);
  return JSON.parse(line.slice('__CFG__'.length));
}

/** 捕获 console.warn（断言"非法值必须告警"） */
function captureWarn(fn) {
  const orig = console.warn;
  const warns = [];
  console.warn = (...a) => { warns.push(a.map(String).join(' ')); };
  try {
    return { result: fn(), warns };
  } finally {
    console.warn = orig;
  }
}

function resolve(env) {
  assert.equal(typeof gw.resolvePoolConfig, 'function', 'gateway-discovery 应导出 env 解析助手 resolvePoolConfig');
  return captureWarn(() => gw.resolvePoolConfig(env));
}

/** 造临时账号目录并注入 env（同 account-pool.test.js 范式） */
function withTempAccounts(records) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'buddy2api-cfg-acc-'));
  for (const r of records) fs.writeFileSync(path.join(dir, `${r.id}.json`), JSON.stringify(r), 'utf8');
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

function acc(id, nickname) {
  return { id, nickname, uid: id, accessToken: `tok-${id}`, expiresAt: Date.now() + 86_400_000 };
}

/** 替换模块单例的 spawnNew/saveState/backends，记录预热目标 */
function stubWarmupPool(maxBackends) {
  const pool = gw.backendPool;
  const orig = { spawnNew: pool.spawnNew, saveState: pool.saveState, backends: pool.backends, maxBackends: pool.maxBackends };
  pool.backends = new Map();
  pool.maxBackends = maxBackends;
  pool.saveState = () => {}; // 不落盘
  const spawned = [];
  let n = 0;
  pool.spawnNew = async (account, spawnOpts = {}) => {
    n += 1;
    spawned.push({ accountId: account?.id || null, toolsEnabled: spawnOpts.toolsEnabled });
    return { url: `http://127.0.0.1:${9400 + n}`, pid: 5000 + n, child: null, startedAt: Date.now(), accountId: account?.id || null, toolsEnabled: spawnOpts.toolsEnabled };
  };
  return {
    spawned,
    restore() {
      Object.assign(pool, orig);
      fs.rmSync(path.join(ISOLATED_TMP, 'buddy2api'), { recursive: true, force: true });
    }
  };
}

/** 造一个不启动真实进程的池子（覆写 spawnNew / isHealthy / saveState）
 *  默认把 stateDir 指向隔离目录：否则池实例的 saveState 会写到**共享**默认路径，
 *  污染后续 B 组「不得触碰共享路径」的断言。 */
let poolSeq = 0;
function makePool(opts = {}) {
  const pool = new gw.BackendPool({
    stateDir: path.join(ISOLATED_TMP, 'pools', `p${++poolSeq}`),
    ...opts
  });
  if (pool.cleanupTimer) { clearInterval(pool.cleanupTimer); pool.cleanupTimer = null; }
  pool.backends = new Map();
  let n = 0;
  pool.spawnNew = async () => {
    if (opts.healthDelayMs) await new Promise((r) => setTimeout(r, opts.healthDelayMs));
    n += 1;
    return { url: `http://127.0.0.1:${9500 + n}`, pid: 6000 + n, child: null, startedAt: Date.now() };
  };
  pool.isHealthy = async () => true;
  return pool;
}

// ---------------------------------------------------------------- A. 容量可配 + 钳制

test('A1 不设任何新 env → 容量 5 / 队列 120000（逐字不变）', () => {
  const { result: cfg, warns } = resolve({});
  assert.equal(cfg.maxBackends, 5);
  assert.equal(cfg.queueTimeoutMs, 120000);
  assert.equal(warns.length, 0, '未设 env 不该产生告警');
});

test('A1w 模块加载时从 process.env 读一次（子进程实测）', () => {
  const base = readConstsInChild();
  assert.equal(base.maxBackends, 5, '不设 env 的子进程应得到默认 5');
  assert.equal(base.queueTimeoutMs, 120000, '不设 env 的子进程应得到默认 120000');

  const over = readConstsInChild({
    BUDDY2API_MAX_BACKENDS: '3',
    BUDDY2API_QUEUE_TIMEOUT_MS: '5000',
    BUDDY2API_STATE_DIR: path.join(ISOLATED_TMP, 'child-state')
  });
  assert.equal(over.maxBackends, 3, 'env 应覆盖默认值');
  assert.equal(over.queueTimeoutMs, 5000, 'env 应覆盖默认值');
  assert.equal(over.poolFile, path.join(ISOLATED_TMP, 'child-state', 'backends.json'), 'STATE_DIR 应决定池文件位置');
});

test('A2 BUDDY2API_MAX_BACKENDS=3 → 最多 3 个后端，第 4 路进队列', async () => {
  const pool = makePool({ maxBackends: 3, healthDelayMs: 3 });
  try {
    const held = await Promise.all([pool.acquire(), pool.acquire(), pool.acquire()]);
    assert.equal(pool.backends.size, 3, '应封顶在配置的 3 个后端');

    let fourth = null;
    const pending = pool.acquire().then((u) => { fourth = u; return u; });
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(fourth, null, '第 4 路应排队等待而不是新建后端');
    assert.equal(pool.waiters.length, 1, '应有一个等待者入队');

    pool.release(held[0]);
    assert.equal(await pending, held[0], '排队者应复用刚归还的后端');
    assert.equal(pool.backends.size, 3, '仍不得超过配置上限');
    for (const u of held.slice(1)) pool.release(u);
  } finally {
    await pool.shutdownAll();
  }
});

test('A3 MAX_BACKENDS="0" → 回落 5 + warn（不受旧式 || 的 falsy 误判）', () => {
  const { result: cfg, warns } = resolve({ BUDDY2API_MAX_BACKENDS: '0' });
  assert.equal(cfg.maxBackends, 5);
  assert.ok(warns.length >= 1, '非法值必须告警');
});

test('A4 MAX_BACKENDS="-1" → 回落 5 + warn，且不会造成永久排队', async () => {
  const { result: cfg, warns } = resolve({ BUDDY2API_MAX_BACKENDS: '-1' });
  assert.equal(cfg.maxBackends, 5, '负数容量必须回落默认而不是"恒 false 的容量判定"');
  assert.ok(warns.length >= 1, '非法值必须告警');

  // F7 复现：若容量判定恒 false，acquire 会走到第 5 步排队 → 拿到配置容量后不得挂起
  const pool = makePool({ maxBackends: cfg.maxBackends });
  try {
    const url = await pool.acquire();
    assert.ok(url, 'acquire 必须正常返回');
  } finally {
    await pool.shutdownAll();
  }
});

test('A5 MAX_BACKENDS="abc" / "2.5" → 回落 5 + warn（要求整数）', () => {
  const abc = resolve({ BUDDY2API_MAX_BACKENDS: 'abc' });
  assert.equal(abc.result.maxBackends, 5);
  assert.ok(abc.warns.length >= 1, '"abc" 必须告警');

  const frac = resolve({ BUDDY2API_MAX_BACKENDS: '2.5' });
  assert.equal(frac.result.maxBackends, 5, '非整数必须回落默认');
  assert.ok(frac.warns.length >= 1, '"2.5" 必须告警');
});

test('A6 MAX_BACKENDS="99" → 钳制到 16 + warn（防启动风暴）', () => {
  const { result: cfg, warns } = resolve({ BUDDY2API_MAX_BACKENDS: '99' });
  assert.equal(cfg.maxBackends, 16);
  assert.ok(warns.length >= 1, '超上界必须告警');
});

test('A7 QUEUE_TIMEOUT_MS="100" → 钳制到 1000（防忙轮询）', () => {
  const { result: cfg, warns } = resolve({ BUDDY2API_QUEUE_TIMEOUT_MS: '100' });
  assert.equal(cfg.queueTimeoutMs, 1000);
  assert.ok(warns.length >= 1, '低于下界必须告警');
});

test('A8 QUEUE_TIMEOUT_MS="99999999" → 钳制到 600000', () => {
  const { result: cfg, warns } = resolve({ BUDDY2API_QUEUE_TIMEOUT_MS: '99999999' });
  assert.equal(cfg.queueTimeoutMs, 600000);
  assert.ok(warns.length >= 1, '超上界必须告警');
});

test('A9 warmup 在容量 2 且已有 1 个后端时 → capacity = 1（不越界）', async () => {
  const h = withTempAccounts([acc('a', '账号A'), acc('b', '账号B')]);
  const stub = stubWarmupPool(2);
  try {
    gw.backendPool.backends.set('http://127.0.0.1:9301', {
      url: 'http://127.0.0.1:9301', pid: 1, child: null, status: 'idle',
      toolsEnabled: true, accountId: 'a', startedAt: Date.now(), lastUsedAt: Date.now()
    });
    await gw.warmup(null, { toolsEnabled: true });
    assert.equal(stub.spawned.length, 1, '容量 2 - 已有 1 = 只补 1 个');
  } finally {
    stub.restore();
    h.restore();
  }
});

test('A10 单账号 → 预热 2 个后端（拍板④；旧行为为 1）', async () => {
  const h = withTempAccounts([acc('a', '账号A')]);
  const stub = stubWarmupPool(5);
  try {
    await gw.warmup(null, { toolsEnabled: true });
    assert.equal(stub.spawned.length, 2, '单账号应预热 2 个（消除并发第 2 路 2.6s 冷 spawn）');
    assert.deepEqual(stub.spawned.map((s) => s.accountId), ['a', 'a'], '两个都应绑定该账号');
  } finally {
    stub.restore();
    h.restore();
  }
});

test('A11 多账号（≥2）→ 每账号 1 个，且风味逐位沿用调用方默认（拍板④只改单账号分支）', async () => {
  const h = withTempAccounts([acc('a', '账号A'), acc('b', '账号B')]);
  const stub = stubWarmupPool(5);
  try {
    await gw.warmup(null, { toolsEnabled: true });
    assert.equal(stub.spawned.length, 2, '多账号仍是每账号 1 个');
    assert.deepEqual(stub.spawned.map((s) => s.accountId).sort(), ['a', 'b'], '每账号各 1 个');
    assert.deepEqual(
      stub.spawned.map((s) => s.toolsEnabled),
      [true, true],
      '多账号每账号只有 1 个名额，交错只会把某个账号唯一的后端翻成另一种风味——属未授权的行为偏移'
    );
  } finally {
    stub.restore();
    h.restore();
  }
});

test('A12 单账号且已绑定 1 个后端 → 补到 2（只补缺，不重建）', async () => {
  const h = withTempAccounts([acc('a', '账号A')]);
  const stub = stubWarmupPool(5);
  try {
    gw.backendPool.backends.set('http://127.0.0.1:9302', {
      url: 'http://127.0.0.1:9302', pid: 2, child: null, status: 'idle',
      toolsEnabled: true, accountId: 'a', startedAt: Date.now(), lastUsedAt: Date.now()
    });
    await gw.warmup(null, { toolsEnabled: true });
    assert.equal(stub.spawned.length, 1, '已有 1 个 → 只补 1 个');
    assert.equal(stub.spawned[0].accountId, 'a');
  } finally {
    stub.restore();
    h.restore();
  }
});

test('A13 warmup(1)（POOL_WARM_COUNT=1 的显式覆盖）→ 预热 1 个，优先于默认', async () => {
  const h = withTempAccounts([acc('a', '账号A')]);
  const stub = stubWarmupPool(5);
  try {
    await gw.warmup(1, { toolsEnabled: true });
    assert.equal(stub.spawned.length, 1, '显式 count 应覆盖默认预热数');
    assert.equal(stub.spawned[0].accountId, null, '固定数量模式走默认登录态后端');
  } finally {
    stub.restore();
    h.restore();
  }
});

test('A14 单账号 → 预热的 2 个覆盖两种风味（1 精简 + 1 全量），进程数不增', async () => {
  const h = withTempAccounts([acc('a', '账号A')]);
  const stub = stubWarmupPool(5);
  try {
    await gw.warmup(null, { toolsEnabled: true });
    assert.equal(stub.spawned.length, 2, '仍是 2 个进程——风味覆盖必须是代价中性的');
    assert.deepEqual(
      stub.spawned.map((s) => s.toolsEnabled).sort(),
      [false, true],
      '必须同时覆盖精简风味（纯聊天主路径）与全量风味（带工具）'
    );
  } finally {
    stub.restore();
    h.restore();
  }
});

test('A14b 单账号且已绑定 1 个全量后端 → 补缺名额必须补精简（A12×A14 组合）', async () => {
  const h = withTempAccounts([acc('a', '账号A')]);
  const stub = stubWarmupPool(5);
  try {
    gw.backendPool.backends.set('http://127.0.0.1:9303', {
      url: 'http://127.0.0.1:9303', pid: 3, child: null, status: 'idle',
      toolsEnabled: true, accountId: 'a', startedAt: Date.now(), lastUsedAt: Date.now()
    });
    await gw.warmup(null, { toolsEnabled: true });
    assert.equal(stub.spawned.length, 1, '只补 1 个（不重建已绑定的那个）');
    assert.equal(stub.spawned[0].toolsEnabled, false,
      '已有全量 → 补缺名额必须补精简；否则 2 全量 0 精简，纯聊天首请求仍要付 2.6s 冷 spawn');
    const flavors = [true, ...stub.spawned.map((s) => s.toolsEnabled)].sort();
    assert.deepEqual(flavors, [false, true], '补缺后池内应同时覆盖精简与全量');
  } finally {
    stub.restore();
    h.restore();
  }
});

test('A14c 单账号且已绑定 1 个精简后端 → 补缺名额必须补全量（A14b 的反方向）', async () => {
  const h = withTempAccounts([acc('a', '账号A')]);
  const stub = stubWarmupPool(5);
  try {
    gw.backendPool.backends.set('http://127.0.0.1:9304', {
      url: 'http://127.0.0.1:9304', pid: 4, child: null, status: 'idle',
      toolsEnabled: false, accountId: 'a', startedAt: Date.now(), lastUsedAt: Date.now()
    });
    await gw.warmup(null, { toolsEnabled: true });
    assert.equal(stub.spawned.length, 1, '只补 1 个');
    assert.equal(stub.spawned[0].toolsEnabled, true,
      '已有精简 → 补缺名额必须补全量，否则带工具的首请求仍要冷 spawn');
    const flavors = [false, ...stub.spawned.map((s) => s.toolsEnabled)].sort();
    assert.deepEqual(flavors, [false, true], '补缺后池内应同时覆盖精简与全量');
  } finally {
    stub.restore();
    h.restore();
  }
});

test('A15 多账号（≥2）→ 风味不交错：原样透传调用方默认（false 时不得有账号被翻成 true）', async () => {
  const h = withTempAccounts([acc('a', '账号A'), acc('b', '账号B')]);
  const stub = stubWarmupPool(5);
  try {
    await gw.warmup(null, { toolsEnabled: false });
    assert.equal(stub.spawned.length, 2, '多账号仍每账号 1 个（进程数不变）');
    assert.deepEqual(
      stub.spawned.map((s) => s.toolsEnabled),
      [false, false],
      '风味必须来自调用方默认，不能按账号迭代位置推算（否则结果依赖账号列表顺序）'
    );
  } finally {
    stub.restore();
    h.restore();
  }
});

// ---------------------------------------------------------------- B. STATE_DIR 隔离

test('B1 不设 BUDDY2API_STATE_DIR → 池文件仍是 os.tmpdir()/buddy2api/backends.json', () => {
  const { result: cfg } = resolve({});
  assert.equal(cfg.stateDir, path.join(os.tmpdir(), 'buddy2api'));
  assert.equal(cfg.poolFile, path.join(os.tmpdir(), 'buddy2api', 'backends.json'));
  assert.equal(gw.POOL_FILE, path.join(ISOLATED_TMP, 'buddy2api', 'backends.json'), '模块导出常量应与默认口径一致');
});

test('B2 设 BUDDY2API_STATE_DIR → 池文件落在指定目录，不触碰共享路径', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'buddy2api-state-'));
  const shared = path.join(ISOLATED_TMP, 'buddy2api', 'backends.json');
  const pool = makePool({ stateDir: dir });
  try {
    pool.backends.set('http://127.0.0.1:9311', {
      url: 'http://127.0.0.1:9311', pid: 311, child: null, status: 'idle',
      toolsEnabled: true, accountId: null, startedAt: Date.now(), lastUsedAt: Date.now()
    });
    pool.saveState();
    const expected = path.join(dir, 'backends.json');
    assert.ok(fs.existsSync(expected), `池文件应落在指定 STATE_DIR（${expected}）`);
    assert.equal(JSON.parse(fs.readFileSync(expected, 'utf8')).length, 1);
    assert.equal(fs.existsSync(shared), false, '不得写入共享默认路径');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('B3 两实例（不同 STATE_DIR）互不收养对方后端（Phase 0 实测缺陷的锁修复）', async () => {
  const dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'buddy2api-state-a-'));
  const dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'buddy2api-state-b-'));
  const entry = (url, pid) => ({
    url, pid, child: null, status: 'idle', toolsEnabled: true, accountId: null,
    startedAt: Date.now(), lastUsedAt: Date.now()
  });
  try {
    const a = makePool({ stateDir: dirA });
    a.backends.set('http://127.0.0.1:9321', entry('http://127.0.0.1:9321', 321));
    a.saveState();

    const b = makePool({ stateDir: dirB });
    b.isProcessAlive = async () => true;
    await b.restoreState();
    assert.equal(b.backends.size, 0, '不同 STATE_DIR 的实例不得收养对方 spawn 的后端');

    const c = makePool({ stateDir: dirA });
    c.isProcessAlive = async () => true;
    await c.restoreState();
    assert.equal(c.backends.size, 1, '同 STATE_DIR 应能正常恢复（隔离而非禁用了恢复）');
  } finally {
    fs.rmSync(dirA, { recursive: true, force: true });
    fs.rmSync(dirB, { recursive: true, force: true });
  }
});

/**
 * 多后端进程池的并发隔离单测（node:test，零依赖）。
 *
 * 覆盖两个真实踩过的竞态：
 *   1. acquire() 的健康检查带 await，若先检查再占位，两个并发请求会
 *      同时选中同一个 idle 后端（实测：setModel 报 Internal error、输出串台）。
 *   2. 并发 spawn 时各自看到 size 未达上限，一起启动新后端，突破 MAX_BACKENDS。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BackendPool } from '../src/gateway-discovery.js';
import { accountPool } from '../src/account-pool.js';

// 这些用例针对"单账号"下的后端复用/排队语义。
// 必须把账号目录指向一个空临时目录，否则会读进真实的 data/accounts，
// 账号池开始轮转、后端按 accountId 绑定，复用断言就不成立了。
const EMPTY_ACCOUNTS = fs.mkdtempSync(path.join(os.tmpdir(), 'buddy2api-empty-acc-'));
process.env.BUDDY2API_ACCOUNTS_DIR = EMPTY_ACCOUNTS;

/** 造一个不启动真实进程的池子（覆写 spawnNew / isHealthy） */
function makePool({ healthDelayMs = 0, unhealthy = new Set() } = {}) {
  const pool = new BackendPool();
  pool.backends = new Map();
  pool.spawning = 0;
  if (pool.cleanupTimer) { clearInterval(pool.cleanupTimer); pool.cleanupTimer = null; }

  let n = 0;
  pool.spawnNew = async () => {
    if (healthDelayMs) await new Promise((r) => setTimeout(r, healthDelayMs));
    n += 1;
    // 从 9100 起编号，避开测试里手工预置的 9001 等端口
    return { url: `http://127.0.0.1:${9100 + n}`, pid: 1000 + n, child: null, startedAt: Date.now() };
  };
  pool.isHealthy = async (url) => {
    if (healthDelayMs) await new Promise((r) => setTimeout(r, healthDelayMs));
    return !unhealthy.has(url);
  };
  pool.saveState = () => {}; // 不落盘
  return pool;
}

test('BackendPool.acquire: 空闲后端被复用（串行）', async () => {
  const pool = makePool();
  const a = await pool.acquire();
  pool.release(a);
  const b = await pool.acquire();
  assert.equal(a, b, '串行请求应复用同一个空闲后端');
  await pool.shutdownAll();
});

test('BackendPool.acquire: 并发请求各拿一个后端，不共享（占位先于健康检查）', async () => {
  // healthDelayMs 模拟真实健康检查的 await 窗口——这是竞态的触发条件
  const pool = makePool({ healthDelayMs: 5 });
  const [a, b, c] = await Promise.all([pool.acquire(), pool.acquire(), pool.acquire()]);
  assert.equal(new Set([a, b, c]).size, 3, '三个并发请求必须拿到三个不同后端');
  assert.equal(pool.backends.size, 3, '池中应有 3 个后端');
  await pool.shutdownAll();
});

test('BackendPool.acquire: 池满时排队等待，归还后放行（不超上限、不失败）', async () => {
  const pool = makePool({ healthDelayMs: 2 });

  // 先占满 5 个后端
  const held = await Promise.all(Array.from({ length: 5 }, () => pool.acquire()));
  assert.equal(pool.backends.size, 5, '应先占满 5 个后端');

  // 第 6 个请求会排队（不立即返回）
  let sixth = null;
  const pending = pool.acquire().then((u) => { sixth = u; return u; });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(sixth, null, '池满时第 6 个请求应排队等待，而不是立刻拿到后端');
  assert.equal(pool.waiters.length, 1, '应有一个等待者入队');

  // 归还一个 → 排队的请求被唤醒并复用该后端
  pool.release(held[0]);
  const url = await pending;
  assert.equal(url, held[0], '排队者应复用刚归还的后端');
  assert.equal(pool.backends.size, 5, '不应因排队而创建第 6 个后端');

  for (const u of held.slice(1)) pool.release(u);
  await pool.shutdownAll();
});

test('BackendPool.acquire: 池中已有不健康后端 → 丢弃并另取，不复用坏连接', async () => {
  const pool = makePool();
  // 预置一个"不健康"的后端在池中（模拟进程已死但状态未清理）
  const dead = 'http://127.0.0.1:9001';
  pool.backends.set(dead, { url: dead, pid: 999, child: null, status: 'idle', lastUsedAt: Date.now() });
  pool.isHealthy = async (u) => u !== dead;

  const a = await pool.acquire();
  assert.notEqual(a, dead, '不该把不健康后端交给请求');
  assert.equal(pool.backends.has(dead), false, '不健康后端应从池中移除');
  await pool.shutdownAll();
});

/** 造一个记录 spawn 风味、可复用现有 makePool 断言的池子 */
function makeFlavorPool() {
  const pool = makePool();
  const spawned = [];
  let n = 0;
  pool.spawnNew = async (account, opts = {}) => {
    n += 1;
    spawned.push(opts.toolsEnabled);
    return { url: `http://127.0.0.1:${9100 + n}`, pid: 1000 + n, child: null, startedAt: Date.now(), accountId: null };
  };
  return { pool, spawned };
}

test('BackendPool.acquire: 工具风味不同的后端不互相复用', async () => {
  const { pool, spawned } = makeFlavorPool();

  const chat = await pool.acquire({ needsTools: false });
  pool.release(chat);
  const tool = await pool.acquire({ needsTools: true });
  assert.notEqual(tool, chat, '带工具的请求不应复用精简后端');
  assert.deepEqual(spawned, [false, true], 'spawnNew 应收到对应风味');
  assert.equal(pool.backends.get(chat).toolsEnabled, false);
  assert.equal(pool.backends.get(tool).toolsEnabled, true);

  pool.release(tool);
  const chat2 = await pool.acquire({ needsTools: false });
  assert.equal(chat2, chat, '纯聊天应复用同风味的精简后端');
  await pool.shutdownAll();
});

test('BackendPool.acquire: 池满且只有错误风味的空闲后端时淘汰之，而非死等', async () => {
  const { pool } = makeFlavorPool();

  const held = await Promise.all(Array.from({ length: 5 }, () => pool.acquire({ needsTools: false })));
  assert.equal(pool.backends.size, 5, '应先占满 5 个精简后端');

  const victim = held[0];
  pool.release(victim); // 留一个空闲的精简后端

  const tool = await pool.acquire({ needsTools: true });
  assert.notEqual(tool, victim, '不应把精简后端交给带工具的请求');
  assert.equal(pool.backends.has(victim), false, '空闲的错误风味后端应被淘汰腾位');
  assert.equal(pool.backends.get(tool).toolsEnabled, true, '新后端应是全量风味');
  assert.equal(pool.backends.size, 5, '总数仍受上限约束');

  for (const u of held.slice(1)) pool.release(u);
  await pool.shutdownAll();
});

test('BackendPool.release: 归还后状态变 idle', async () => {
  const pool = makePool();
  const url = await pool.acquire();
  assert.equal(pool.backends.get(url).status, 'busy');
  pool.release(url);
  assert.equal(pool.backends.get(url).status, 'idle');
  await pool.shutdownAll();
});

test('BackendPool.release: 对空闲后端重复归还是无害 no-op（不重复唤醒等待者）', async () => {
  const pool = makePool();
  const url = await pool.acquire();
  pool.release(url);
  assert.equal(pool.backends.get(url).status, 'idle');
  pool.release(url); // 上层的重复归还（幂等守卫应拦截）
  assert.equal(pool.backends.get(url).status, 'idle', '重复归还后仍是空闲');
  assert.equal(pool.waiters.length, 0, '重复归还不得唤醒等待者');
  await pool.shutdownAll();
});

test('BackendPool.acquire: 池满且首选账号无空闲 → 兜底复用其他账号的同风味空闲后端', async () => {
  const { pool } = makeFlavorPool();
  // stub 账号池单例：两个账号，亲和偏好 acc-A
  const orig = {
    accounts: accountPool.accounts,
    isCoolingDown: accountPool.isCoolingDown,
    pick: accountPool.pick
  };
  accountPool.accounts = () => [{ id: 'acc-A', nickname: 'A' }, { id: 'acc-B', nickname: 'B' }];
  accountPool.isCoolingDown = () => false;
  accountPool.pick = () => ({ account: { id: 'acc-B', nickname: 'B' }, coolingDown: false, cooldownMs: 0 });
  try {
    // 池满：4 个 acc-B 占用 + 1 个 acc-B 空闲（全量风味）
    for (let i = 1; i <= 5; i++) {
      const url = `http://127.0.0.1:${9200 + i}`;
      pool.backends.set(url, {
        url, pid: 2000 + i, child: null, status: i <= 4 ? 'busy' : 'idle',
        toolsEnabled: true, accountId: 'acc-B', lastUsedAt: Date.now()
      });
    }

    // 亲和 acc-A 的请求：A 无空闲后端、池满 → 应复用 B 的空闲后端而不是排队
    const url = await pool.acquire({ needsTools: true, preferredAccountId: 'acc-A' });
    assert.equal(url, 'http://127.0.0.1:9205', '应兜底复用其他账号的空闲后端');
    assert.equal(pool.backends.get(url).status, 'busy');
  } finally {
    Object.assign(accountPool, orig);
    await pool.shutdownAll();
  }
});

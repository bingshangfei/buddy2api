/**
 * 会话级账号亲和测试（node:test，零依赖）。
 *
 * 同一会话的请求尽量粘住同一账号（后端与账号绑定 → 命中云端按账号计的
 * 前缀缓存）；**粒度是会话而不是 API key**——zcode 这类客户端所有会话
 * 共用一个 key，按 key 粘会把所有会话压到同一个账号上。
 *
 * 会话标识优先级：request.user（OpenAI 标准字段）> 首条 user 消息指纹
 * （OpenAI 协议每轮重发全量历史，首条 user 消息跨轮稳定）> 回退 API key。
 * 不用 system prompt 做指纹——同一 agent 的所有会话 system prompt 相同。
 *
 * 覆盖：
 *   1. resolveAccountForAcquire：偏好账号未冷却 → 粘住且不推进轮转游标；
 *      冷却/不存在 → 回退 round-robin
 *   2. handler：同会话（同首条消息）粘住；同 key 不同会话互不干扰；
 *      user 字段优先；映射有上限裁剪
 *   3. AccountPool.isCoolingDown 公开方法
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { OpenAiHandler } from '../src/openai-handler.js';
import { AccountPool } from '../src/account-pool.js';
import { resolveAccountForAcquire } from '../src/gateway-discovery.js';

// ---------- resolveAccountForAcquire ----------

function fakePool(accounts, coolingIds = new Set()) {
  const calls = { pick: 0 };
  return {
    calls,
    accounts: () => accounts,
    isCoolingDown: (id) => coolingIds.has(id),
    pick() {
      calls.pick++;
      const ready = accounts.filter((a) => !coolingIds.has(a.id));
      const list = ready.length > 0 ? ready : accounts;
      return { account: list[0] || null, coolingDown: ready.length === 0, cooldownMs: ready.length === 0 ? 60_000 : 0 };
    }
  };
}

const accA = { id: 'acc-A', nickname: 'A' };
const accB = { id: 'acc-B', nickname: 'B' };

test('resolveAccountForAcquire: 偏好账号未冷却 → 粘住，不调 pick（不推进轮转游标）', () => {
  const pool = fakePool([accA, accB]);
  const r = resolveAccountForAcquire('acc-A', pool);
  assert.equal(r.account.id, 'acc-A');
  assert.equal(r.fromAffinity, true);
  assert.equal(pool.calls.pick, 0, '亲和命中不应推进轮转游标');
});

test('resolveAccountForAcquire: 偏好账号冷却中 → 回退 round-robin', () => {
  const pool = fakePool([accA, accB], new Set(['acc-A']));
  const r = resolveAccountForAcquire('acc-A', pool);
  assert.equal(r.account.id, 'acc-B');
  assert.equal(r.fromAffinity, false);
});

test('resolveAccountForAcquire: 偏好不存在/为空 → round-robin', () => {
  const pool = fakePool([accA, accB]);
  for (const preferred of [null, undefined, 'acc-gone']) {
    const r = resolveAccountForAcquire(preferred, pool);
    assert.equal(r.fromAffinity, false);
    assert.ok(r.account, '应从账号池选出一个账号');
  }
});

test('resolveAccountForAcquire: 无任何账号 → account 为 null（调用方回退单凭据）', () => {
  const pool = fakePool([]);
  const r = resolveAccountForAcquire('acc-A', pool);
  assert.equal(r.account, null);
  assert.equal(r.fromAffinity, false);
});

// ---------- handler 的会话→账号 亲和映射 ----------

function fakeRes() {
  return {
    writableEnded: false,
    on() {}, off() {},
    write() { return true; }, end() {}
  };
}

/** acquire 桩：记录 opts，按队列依次返回预设的 accountId */
function makeHandler(accountIds) {
  const handler = new OpenAiHandler('http://127.0.0.1:1');
  const calls = { acquireOpts: [] };
  let n = 0;
  handler.sessions = {
    async acquire(key, opts) {
      calls.acquireOpts.push({ key, opts });
      const id = accountIds[Math.min(n, accountIds.length - 1)] ?? null;
      n++;
      const poolId = `pool-${n}`;
      return {
        sessionId: `sess-${n}`,
        client: { setModel: async () => {}, delegateTools: async () => {} },
        models: [], poolId, backendUrl: 'x', accountId: id
      };
    },
    acquireExisting() { return null; },
    release() {},
    invalidate() {},
    reportAccountHealth() {},
    getModels() { return []; },
    hasPool() { return false; }
  };
  // 入口签名为具名参数对象（refactor S4），桩按同一形状解构
  const respond = async ({ prompt, ctx }) => {
    ctx.outcome.completed = true;
    return { prompt };
  };
  handler._handleNonStreamingResponse = respond;
  handler._handleStreamingResponse = respond;
  return { handler, calls };
}

const user = (t) => ({ role: 'user', content: t });

test('handler 亲和：同一会话（同首条消息，历史增长）粘住同一账号', async () => {
  const { handler, calls } = makeHandler(['acc-A', 'acc-B']);

  // 会话第 1 轮
  await handler.handleChatCompletions(
    { messages: [user('帮我修一个登录 bug')], apiKey: 'local' }, fakeRes());
  // 第 2 轮：OpenAI 协议重发全量历史，首条 user 消息不变
  await handler.handleChatCompletions(
    { messages: [user('帮我修一个登录 bug'), { role: 'assistant', content: '好的' }, user('继续')], apiKey: 'local' }, fakeRes());

  assert.equal(calls.acquireOpts[0].opts.preferredAccountId ?? null, null, '首次无偏好');
  assert.equal(calls.acquireOpts[1].opts.preferredAccountId, 'acc-A', '第 2 轮应粘住第 1 轮的账号');
});

test('handler 亲和：同 key 不同会话（不同首条消息）互不干扰', async () => {
  const { handler, calls } = makeHandler(['acc-A', 'acc-B', 'acc-A']);
  await handler.handleChatCompletions(
    { messages: [user('任务一')], apiKey: 'local' }, fakeRes());
  await handler.handleChatCompletions(
    { messages: [user('任务二')], apiKey: 'local' }, fakeRes());
  await handler.handleChatCompletions(
    { messages: [user('任务一'), { role: 'assistant', content: 'ok' }, user('继续')], apiKey: 'local' }, fakeRes());

  assert.equal(calls.acquireOpts[1].opts.preferredAccountId ?? null, null, '会话二首次无偏好');
  assert.equal(calls.acquireOpts[2].opts.preferredAccountId, 'acc-A', '会话一仍粘住自己的账号');
});

test('handler 亲和：user 字段优先于消息指纹', async () => {
  const { handler, calls } = makeHandler(['acc-A', 'acc-B']);
  // 同一 user 标识、消息内容不同 → 仍视为同一会话
  await handler.handleChatCompletions(
    { messages: [user('第一轮')], user: 'zcode-session-9', apiKey: 'local' }, fakeRes());
  await handler.handleChatCompletions(
    { messages: [user('第二轮，内容完全不同')], user: 'zcode-session-9', apiKey: 'local' }, fakeRes());
  // 不同 user 标识、消息内容相同 → 不同会话
  await handler.handleChatCompletions(
    { messages: [user('第一轮')], user: 'zcode-session-10', apiKey: 'local' }, fakeRes());

  assert.equal(calls.acquireOpts[1].opts.preferredAccountId, 'acc-A', '同 user 标识应粘住');
  assert.equal(calls.acquireOpts[2].opts.preferredAccountId ?? null, null, '不同 user 标识是不同会话');
});

test('handler 亲和：无 user 消息（如纯图片首消息）回退到 API key 粒度', async () => {
  const { handler, calls } = makeHandler(['acc-A', 'acc-B']);
  const imagePart = { type: 'image_url', image_url: { url: 'data:image/png;base64,xyz' } };
  await handler.handleChatCompletions(
    { messages: [{ role: 'user', content: [imagePart] }], apiKey: 'local' }, fakeRes());
  await handler.handleChatCompletions(
    { messages: [{ role: 'user', content: [imagePart] }], apiKey: 'local' }, fakeRes());

  assert.equal(calls.acquireOpts[0].opts.preferredAccountId ?? null, null);
  assert.equal(calls.acquireOpts[1].opts.preferredAccountId, 'acc-A', '回退到 key 粒度后仍粘住');
});

test('handler 亲和：后端未绑定账号（accountId null）不写入映射', async () => {
  const { handler, calls } = makeHandler([null, 'acc-B']);
  await handler.handleChatCompletions(
    { messages: [user('任务一')], apiKey: 'k1' }, fakeRes());
  await handler.handleChatCompletions(
    { messages: [user('任务一'), user('继续')], apiKey: 'k1' }, fakeRes());
  assert.equal(calls.acquireOpts[1].opts.preferredAccountId ?? null, null);
});

test('handler 亲和：映射有上限，超限淘汰最旧的会话', () => {
  const { handler } = makeHandler([]);
  for (let i = 0; i < 600; i++) handler._setConvAccount(`c${i}`, 'acc-A');
  assert.ok(handler.convAccounts.size <= 500, `映射应被裁剪，实际 ${handler.convAccounts.size}`);
  assert.equal(handler.convAccounts.has('c0'), false, '最旧的会话应被淘汰');
  assert.equal(handler.convAccounts.has('c599'), true, '最新的会话应保留');
});

// ---------- AccountPool.isCoolingDown 公开方法 ----------

test('AccountPool.isCoolingDown: reportFailure 后为 true，冷却过期后为 false', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'buddy2api-aff-'));
  fs.writeFileSync(path.join(dir, 'a1.json'), JSON.stringify({ id: 'a1', nickname: 'A', uid: 'a1', accessToken: 't', expiresAt: Date.now() + 86_400_000 }), 'utf8');
  const prev = process.env.BUDDY2API_ACCOUNTS_DIR;
  process.env.BUDDY2API_ACCOUNTS_DIR = dir;
  try {
    const pool = new AccountPool();
    const now = Date.now();
    assert.equal(pool.isCoolingDown('a1', now), false);
    pool.reportFailure('a1', 'rate-limit', { now });
    assert.equal(pool.isCoolingDown('a1', now + 1000), true, '冷却期内应为 true');
    assert.equal(pool.isCoolingDown('a1', now + 11 * 60 * 1000), false, '冷却期后应为 false');
  } finally {
    if (prev === undefined) delete process.env.BUDDY2API_ACCOUNTS_DIR;
    else process.env.BUDDY2API_ACCOUNTS_DIR = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------- SessionManager 池级会话亲和（_takeIdlePool） ----------
//
// 池按 API key 复用，若不认识会话，串行时同 key 的任意空闲池都会被拿走，
// 会话在账号之间随机穿越。_takeIdlePool 需优先复用本会话上次的池。

import { SessionManager } from '../src/session-manager.js';

function mkPool(id, key, { busy = false, tools = true } = {}) {
  return { id, key, busy, toolsEnabled: tools, url: `http://b-${id}`, models: [], lastUsedAt: Date.now(), client: {} };
}

test('池级亲和：同会话优先取自己上次的空闲池', () => {
  const sm = new SessionManager('http://x');
  const p1 = mkPool('p1', 'local');
  const p2 = mkPool('p2', 'local');
  sm.pools.set('p1', p1);
  sm.pools.set('p2', p2);
  sm.convPools.set('convA', 'p1');
  // p2 在 Map 里排在 p1 后面；若无亲和，_takeIdlePool 会取到 p1（第一个空闲），
  // 断言 convA 确实拿到 p1 无法区分"亲和命中"和"顺序命中" → 让 p1 排后面
  const sm2 = new SessionManager('http://x');
  sm2.pools.set('p2', p2);
  sm2.pools.set('p1', p1);
  sm2.convPools.set('convA', 'p1');
  const got = sm2._takeIdlePool('local', true, 'convA');
  assert.equal(got.id, 'p1', '应跳过排在前面的 p2、优先取会话自己的 p1');
});

test('池级亲和：首选池忙 → 取任意空闲并改换门庭', () => {
  const sm = new SessionManager('http://x');
  const p1 = mkPool('p1', 'local', { busy: true });
  const p2 = mkPool('p2', 'local');
  sm.pools.set('p1', p1);
  sm.pools.set('p2', p2);
  sm.convPools.set('convA', 'p1');

  const got = sm._takeIdlePool('local', true, 'convA');
  assert.equal(got.id, 'p2', '自己的池忙时取任意空闲池');
  assert.equal(sm.convPools.get('convA'), 'p2', '亲和指向应跟着实际用的池走');
});

test('池级亲和：指向已失效的池 → 清理指向，走通用选择', () => {
  const sm = new SessionManager('http://x');
  const p2 = mkPool('p2', 'local');
  sm.pools.set('p2', p2);
  sm.convPools.set('convA', 'p-gone');

  const got = sm._takeIdlePool('local', true, 'convA');
  assert.equal(got.id, 'p2');
  assert.equal(sm.convPools.get('convA'), 'p2', '失效指向应被替换');
});

test('池级亲和：无会话标识时行为不变（取第一个空闲）', () => {
  const sm = new SessionManager('http://x');
  const p1 = mkPool('p1', 'local');
  sm.pools.set('p1', p1);
  const got = sm._takeIdlePool('local', true, null);
  assert.equal(got.id, 'p1');
  assert.equal(sm.convPools.size, 0, '无 convId 不写亲和映射');
});

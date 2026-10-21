/**
 * 会话亲和复用集成测试（node:test，零依赖）。
 *
 * 验证 handleChatCompletions 的复用决策：多轮纯文本请求复用同一后端会话、
 * 只发增量；带工具/图片/换模型/失败等场景安全回退新建会话。
 * 用假的 SessionManager + 桩掉响应处理器，聚焦编排逻辑本身。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OpenAiHandler } from '../src/openai-handler.js';
import { needsTools } from '../src/session-prepare.js';

function fakeRes() {
  return {
    writableEnded: false,
    on() {}, off() {},
    write() { return true; }, end() {}
  };
}

function makeHandler() {
  const handler = new OpenAiHandler('http://127.0.0.1:1');
  const calls = { acquire: 0, acquireExisting: 0, prompts: [], failNext: false, released: 0, acquireOpts: [] };
  let poolCounter = 0;
  const live = new Set();

  handler.sessions = {
    async acquire(key, opts) {
      calls.acquire++;
      calls.acquireOpts.push(opts);
      const poolId = `pool-${++poolCounter}`;
      live.add(poolId);
      return {
        sessionId: `sess-${poolCounter}`,
        client: { setModel: async () => {}, delegateTools: async () => {} },
        models: [], poolId, backendUrl: 'x', accountId: null
      };
    },
    acquireExisting(key, poolId, sessionId) {
      calls.acquireExisting++;
      if (!live.has(poolId)) return null;
      return {
        sessionId,
        client: { setModel: async () => {}, delegateTools: async () => {} },
        models: [], poolId, backendUrl: 'x', accountId: null
      };
    },
    release() { calls.released++; },
    invalidate() {},
    reportAccountHealth() {},
    getModels() { return []; },
    hasPool(id) { return live.has(id); }
  };

  // 桩：记录实际发出的 prompt；默认标记成功完成
  // 入口签名为具名参数对象（refactor S4），桩按同一形状解构
  const respond = async ({ prompt, ctx }) => {
    calls.prompts.push(prompt);
    if (calls.failNext) { calls.failNext = false; throw new Error('boom'); }
    ctx.outcome.completed = true;
    return { prompt };
  };
  handler._handleNonStreamingResponse = respond;
  handler._handleStreamingResponse = respond;

  return { handler, calls };
}

const sys = (t) => ({ role: 'system', content: t });
const user = (t) => ({ role: 'user', content: t });
const asst = (t) => ({ role: 'assistant', content: t });

test('多轮纯文本：第二轮回传全量历史时复用会话、只发增量', async () => {
  const { handler, calls } = makeHandler();
  const res = fakeRes();

  await handler.handleChatCompletions({ messages: [sys('SYS'), user('你好')], model: 'auto', apiKey: 'k' }, res);
  assert.equal(calls.acquire, 1);
  const first = calls.prompts[0][0].text;
  assert.match(first, /\[User\]\n你好/);

  await handler.handleChatCompletions(
    { messages: [sys('SYS'), user('你好'), asst('你好！'), user('再讲一个')], model: 'auto', apiKey: 'k' },
    res
  );
  assert.equal(calls.acquire, 1, '第二跳不应新建会话');
  assert.equal(calls.acquireExisting, 1, '第二跳应复用既有会话');
  const delta = calls.prompts[1];
  assert.equal(delta.length, 1);
  assert.equal(delta[0].text, '\n\n[Assistant previous reply]\n你好！\n\n[User]\n再讲一个');
  assert.ok(!delta[0].text.includes('SYS'), '增量不应重复携带系统前缀');
});

test('带 tools 的请求不参与复用（每轮新建）', async () => {
  const { handler, calls } = makeHandler();
  const res = fakeRes();
  const tools = [{ type: 'function', function: { name: 'f', parameters: {} } }];

  await handler.handleChatCompletions({ messages: [sys('SYS'), user('a')], model: 'auto', apiKey: 'k', tools }, res);
  await handler.handleChatCompletions({ messages: [sys('SYS'), user('a'), user('b')], model: 'auto', apiKey: 'k', tools }, res);

  assert.equal(calls.acquire, 2);
  assert.equal(calls.acquireExisting, 0);
});

test('含图片的请求不参与复用', async () => {
  const { handler, calls } = makeHandler();
  const res = fakeRes();
  const img = { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } };

  await handler.handleChatCompletions({ messages: [{ role: 'user', content: [img] }], model: 'auto', apiKey: 'k' }, res);
  await handler.handleChatCompletions({ messages: [{ role: 'user', content: [img] }], model: 'auto', apiKey: 'k' }, res);

  assert.equal(calls.acquire, 2);
  assert.equal(calls.acquireExisting, 0);
});

test('换模型 → 不复用，新建会话', async () => {
  const { handler, calls } = makeHandler();
  const res = fakeRes();

  await handler.handleChatCompletions({ messages: [sys('SYS'), user('a')], model: 'glm-5.1', apiKey: 'k' }, res);
  await handler.handleChatCompletions({ messages: [sys('SYS'), user('a'), user('b')], model: 'deepseek-v4.1-flash', apiKey: 'k' }, res);

  assert.equal(calls.acquire, 2);
  assert.equal(calls.acquireExisting, 0);
});

test('不同 API key 之间不串会话', async () => {
  const { handler, calls } = makeHandler();
  const res = fakeRes();

  await handler.handleChatCompletions({ messages: [sys('SYS'), user('a')], model: 'auto', apiKey: 'keyA' }, res);
  await handler.handleChatCompletions({ messages: [sys('SYS'), user('a'), user('b')], model: 'auto', apiKey: 'keyB' }, res);

  assert.equal(calls.acquireExisting, 0);
});

test('上一轮失败 → 不复用（丢弃条目，下轮新建）', async () => {
  const { handler, calls } = makeHandler();
  const res = fakeRes();

  await handler.handleChatCompletions({ messages: [sys('SYS'), user('a')], model: 'auto', apiKey: 'k' }, res);

  calls.failNext = true;
  await assert.rejects(
    handler.handleChatCompletions({ messages: [sys('SYS'), user('a'), user('b')], model: 'auto', apiKey: 'k' }, res)
  );

  await handler.handleChatCompletions({ messages: [sys('SYS'), user('a'), user('b'), user('c')], model: 'auto', apiKey: 'k' }, res);
  // 第 1 跳 acquire=1；失败那一跳是复用（acquireExisting=1）；失败后条目被丢弃，
  // 第 3 跳只能新建 → acquire=2
  assert.equal(calls.acquire, 2);
});

test('BUDDY2API_SESSION_REUSE=0 时完全关闭复用', async () => {
  const prev = process.env.BUDDY2API_SESSION_REUSE;
  process.env.BUDDY2API_SESSION_REUSE = '0';
  try {
    const { handler, calls } = makeHandler();
    const res = fakeRes();
    await handler.handleChatCompletions({ messages: [sys('SYS'), user('a')], model: 'auto', apiKey: 'k' }, res);
    await handler.handleChatCompletions({ messages: [sys('SYS'), user('a'), user('b')], model: 'auto', apiKey: 'k' }, res);
    assert.equal(calls.acquireExisting, 0);
    assert.equal(calls.acquire, 2);
  } finally {
    if (prev === undefined) delete process.env.BUDDY2API_SESSION_REUSE;
    else process.env.BUDDY2API_SESSION_REUSE = prev;
  }
});

test('needsTools: 自动按请求、可用 BUDDY2API_TOOLS 覆盖', () => {
  // 批3 起 needsTools 归 session-prepare.js；本用例改直连（调用期读 env 的锚，
  // delete/恢复 process.env 的舞步不变）
  const prev = process.env.BUDDY2API_TOOLS;
  try {
    delete process.env.BUDDY2API_TOOLS;
    assert.equal(needsTools(false), false, '纯聊天 → 精简后端');
    assert.equal(needsTools(true), true, '带 tools → 全量后端');

    process.env.BUDDY2API_TOOLS = 'on';
    assert.equal(needsTools(false), true, 'on 强制全量（旧行为）');

    process.env.BUDDY2API_TOOLS = 'off';
    assert.equal(needsTools(true), false, 'off 强制精简');
  } finally {
    if (prev === undefined) delete process.env.BUDDY2API_TOOLS;
    else process.env.BUDDY2API_TOOLS = prev;
  }
});

test('纯聊天请求走精简后端、带 tools 请求走全量后端', async () => {
  const prev = process.env.BUDDY2API_TOOLS;
  delete process.env.BUDDY2API_TOOLS;
  try {
    const { handler, calls } = makeHandler();
    const res = fakeRes();
    const tools = [{ type: 'function', function: { name: 'f', parameters: {} } }];

    await handler.handleChatCompletions({ messages: [user('你好')], model: 'auto', apiKey: 'k' }, res);
    await handler.handleChatCompletions({ messages: [user('你好')], model: 'auto', apiKey: 'k', tools }, res);

    // convId 是会话标识（同消息 → 同会话），两次请求相同
    const convId = handler._conversationId({ messages: [user('你好')] }, 'k');
    assert.deepEqual(calls.acquireOpts, [
      { needsTools: false, preferredAccountId: null, convId },
      { needsTools: true, preferredAccountId: null, convId }
    ]);
  } finally {
    if (prev === undefined) delete process.env.BUDDY2API_TOOLS;
    else process.env.BUDDY2API_TOOLS = prev;
  }
});

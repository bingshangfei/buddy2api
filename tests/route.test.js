/**
 * route() 路由矩阵单测（node:test，零依赖）。
 * route 是无 HTTP 依赖的纯路由（src/router.js）；handler 单例方法在此打桩。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { route, handler, accountProvider } from '../src/router.js';
import { tokenStats } from '../src/token-stats.js';

/** 打桩 handler 的两个入口，记录调用并返回可控结果 */
function stubHandler({ models = [], chat = {} } = {}) {
  const calls = { listModels: [], chatCompletions: [] };
  handler.handleListModels = async (key) => {
    calls.listModels.push(key);
    return { object: 'list', data: models };
  };
  handler.handleChatCompletions = async (request, res) => {
    calls.chatCompletions.push({ request, res });
    if (chat.throw) throw chat.throw;
    return chat.result !== undefined ? chat.result : { id: 'test', choices: [] };
  };
  return calls;
}

test('route: GET / 返回健康检查', async () => {
  const r = await route('GET', '/', {});
  assert.equal(r.status, 200);
  assert.equal(r.body.service, 'buddy2api');
  assert.equal(r.body.status, 'ok');
});

test('route: GET /v1/models 透传 handler 结果与 key', async () => {
  const calls = stubHandler({ models: [{ id: 'auto' }] });
  const r = await route('GET', '/v1/models', {}, { key: 'k1' });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.data, [{ id: 'auto' }]);
  assert.deepEqual(calls.listModels, ['k1'], '应把 ctx.key 传给 handleListModels');
});

test('route: POST chat/completions 缺 messages → 400', async () => {
  stubHandler();
  for (const body of [{}, { messages: 'not-an-array' }, { messages: null }]) {
    const r = await route('POST', '/v1/chat/completions', body);
    assert.equal(r.status, 400);
    assert.match(r.body.error.message, /messages is required/);
  }
});

test('route: POST chat/completions 非流式 → 200 + 注入 apiKey', async () => {
  const fakeRes = { writableEnded: false };
  const calls = stubHandler({ chat: { result: { id: 'cmpl-1', choices: [] } } });
  const body = { messages: [{ role: 'user', content: 'hi' }], model: 'auto' };

  const r = await route('POST', '/v1/chat/completions', body, { key: 'k2', res: fakeRes });

  assert.equal(r.status, 200);
  assert.equal(r.body.id, 'cmpl-1');
  assert.equal(calls.chatCompletions.length, 1);
  assert.equal(calls.chatCompletions[0].request.apiKey, 'k2', 'ctx.key 应注入 request.apiKey');
  assert.equal(calls.chatCompletions[0].res, fakeRes, 'res 应透传（断连取消依赖它）');
});

test('route: POST chat/completions stream:true → 流式标记，不产生 JSON body', async () => {
  const fakeRes = { writableEnded: false };
  const calls = stubHandler();
  const body = { messages: [{ role: 'user', content: 'hi' }], stream: true };

  const r = await route('POST', '/v1/chat/completions', body, { key: 'k3', res: fakeRes });

  assert.equal(r.status, null);
  assert.equal(r.stream, true);
  assert.equal(r.res, fakeRes);
  assert.equal(r.request.apiKey, 'k3');
  assert.equal(calls.chatCompletions.length, 0, '流式分支在 route 层不调 handler，由外层写响应');
});

test('route: handler 返回 null（流式已写完）→ alreadyWritten 标记', async () => {
  stubHandler({ chat: { result: null } });
  const body = { messages: [{ role: 'user', content: 'hi' }] };

  const r = await route('POST', '/v1/chat/completions', body, { key: 'k4' });

  assert.equal(r.status, null);
  assert.equal(r.alreadyWritten, true);
  assert.equal(r.stream, true);
});

test('route: 未知路径 → 404', async () => {
  stubHandler();
  const r = await route('POST', '/v2/unknown', {});
  assert.equal(r.status, 404);
  assert.match(r.body.error.message, /Unknown endpoint/);
});

test('route: handler 抛错 → 向上传播（由 handleRequest 兜底 500）', async () => {
  stubHandler({ chat: { throw: new Error('WorkBuddy down') } });
  const body = { messages: [{ role: 'user', content: 'hi' }] };

  await assert.rejects(
    () => route('POST', '/v1/chat/completions', body),
    /WorkBuddy down/
  );
});

// ---------- /v1/usage token 消耗统计 ----------

test('route: GET /v1/usage 返回汇总，model/key 过滤与 detail 透传', async () => {
  const calls = [];
  const orig = { summary: tokenStats.summary, detail: tokenStats.detail };
  try {
    tokenStats.summary = (f) => {
      calls.push(['summary', f]);
      return { total: { requests: 1, prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 }, models: [], keys: [] };
    };
    tokenStats.detail = (o) => {
      calls.push(['detail', o]);
      return [{ ts: '2026-09-05T00:00:00.000Z', model: 'glm-5.3-flash', total_tokens: 12 }];
    };

    const r = await route('GET', '/v1/usage', {}, { query: { detail: '1', model: 'glm-5.3-flash', limit: '5' } });

    assert.equal(r.status, 200);
    assert.equal(r.body.object, 'token_usage');
    assert.equal(r.body.total.total_tokens, 12);
    assert.equal(r.body.records.length, 1);
    assert.deepEqual(calls[0], ['summary', { model: 'glm-5.3-flash', key: undefined }]);
    assert.deepEqual(calls[1], ['detail', { limit: 5, model: 'glm-5.3-flash', key: undefined }]);
  } finally {
    tokenStats.summary = orig.summary;
    tokenStats.detail = orig.detail;
  }
});

test('route: GET /v1/usage 无 detail → 不含 records 字段', async () => {
  const orig = tokenStats.summary;
  try {
    tokenStats.summary = () => ({ total: { requests: 0, prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }, models: [], keys: [] });
    const r = await route('GET', '/v1/usage', {}, { query: {} });
    assert.equal(r.status, 200);
    assert.equal(r.body.records, undefined);
  } finally {
    tokenStats.summary = orig;
  }
});

test('route: DELETE /v1/usage 重置统计', async () => {
  const orig = tokenStats.reset;
  let reset = false;
  tokenStats.reset = () => { reset = true; };
  try {
    const r = await route('DELETE', '/v1/usage', {});
    assert.equal(r.status, 200);
    assert.equal(r.body.status, 'ok');
    assert.equal(reset, true);
  } finally {
    tokenStats.reset = orig;
  }
});

// ---------- /v1/account 账户 + 余额 ----------

test('route: GET /v1/account 透传账户与余额', async () => {
  const orig = accountProvider.get;
  accountProvider.get = async () => ({
    ok: true,
    account: { nickname: '测试账号', uid: 'u-1' },
    balance: { remaining: 2508.23, total: 3630, used: 1121.77, unit: 'credits' }
  });
  try {
    const r = await route('GET', '/v1/account', {});
    assert.equal(r.status, 200);
    assert.equal(r.body.object, 'account');
    assert.equal(r.body.account.nickname, '测试账号');
    assert.equal(r.body.balance.remaining, 2508.23);
  } finally {
    accountProvider.get = orig;
  }
});

test('route: GET /v1/account 查询失败 → 200 且 ok:false 带 error', async () => {
  const orig = accountProvider.get;
  accountProvider.get = async () => ({ ok: false, account: null, balance: null, error: '未找到登录态文件' });
  try {
    const r = await route('GET', '/v1/account', {});
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, false);
    assert.match(r.body.error, /未找到登录态文件/);
  } finally {
    accountProvider.get = orig;
  }
});

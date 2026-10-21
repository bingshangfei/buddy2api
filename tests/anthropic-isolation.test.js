/**
 * Anthropic 切片 P5：隔离与会话键单测（node:test，零依赖）。
 *
 * 覆盖测试矩阵 M-01~M-04（clientKey 增读 x-api-key / CORS 允许头）与
 * M-24、M-25、R-1、R-6（不同 x-api-key 的挂起状态必须互不覆盖）。
 *
 * 背景（Q6 必修项）：clientKey 是 this.pending / this.convAccounts /
 * this.conversations 三处索引的唯一构造点。Anthropic 客户端发 x-api-key，
 * 若不读它，所有 Anthropic 客户端会塌缩成同一个 key 'default' → 互相顶掉
 * 挂起工具调用、抢同一账号、复用他人上下文（本项目历史上反复吃亏的串台）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clientKey, CORS_ALLOW_HEADERS } from '../src/router.js';
import { OpenAiHandler, buildRequestContext } from '../src/openai-handler.js';

// request-context（批C）：attempt 级身份（completionId/created/model）以展开覆盖
const sctx = (key, over = {}) => ({ ...buildRequestContext({ key }), ...over });

/** 极简 req 桩：clientKey 只读 headers.host/url/authorization */
function req({ headers = {}, url = '/' } = {}) {
  return { headers: { host: 'localhost:8000', ...headers }, url };
}

/** 构造 handler 实例，stub 掉超时与响应构建，聚焦挂起表语义 */
function makeHandler() {
  const handler = new OpenAiHandler('http://127.0.0.1:1');
  handler._armPendingTimeout = () => {};
  handler._buildToolCallResponse = (state, toolEvent) => ({ suspended: true, toolCallId: toolEvent.toolCallId });
  return handler;
}

const TOOL_EVENT = { reqId: 'req-1', name: 'my_tool', args: { a: 1 }, toolCallId: 'tc-1' };

// ---------- M-01 ~ M-03：clientKey 鉴权头优先级 ----------

test('M-01: 仅带 x-api-key → 返回该 key', () => {
  assert.equal(clientKey(req({ headers: { 'x-api-key': 'sk-ant-k1' } })), 'sk-ant-k1');
});

test('M-02: Bearer 与 x-api-key 同时存在 → Bearer 优先', () => {
  const key = clientKey(req({
    headers: { authorization: 'Bearer bearer-wins', 'x-api-key': 'sk-ant-loses' }
  }));
  assert.equal(key, 'bearer-wins', 'Authorization: Bearer 优先级高于 x-api-key');
});

test('M-03: 无任何鉴权头 → default（回归）', () => {
  assert.equal(clientKey(req()), 'default');
});

test('M-02 边界: x-api-key 空白值不覆盖 ?apiKey= 查询参数', () => {
  assert.equal(clientKey(req({ headers: { 'x-api-key': '   ' }, url: '/v1/messages?apiKey=q-key' })), 'q-key');
});

test('M-01 边界: x-api-key 两端空白被裁剪', () => {
  assert.equal(clientKey(req({ headers: { 'x-api-key': '  sk-trim  ' } })), 'sk-trim');
});

// ---------- M-04：CORS 允许头（浏览器侧 Anthropic 客户端预检） ----------

test('M-04: CORS 允许头含 x-api-key 与 anthropic-version', () => {
  assert.match(CORS_ALLOW_HEADERS, /x-api-key/);
  assert.match(CORS_ALLOW_HEADERS, /anthropic-version/);
  // 既有允许头不得被覆盖（回归）
  assert.match(CORS_ALLOW_HEADERS, /Content-Type/i);
  assert.match(CORS_ALLOW_HEADERS, /Authorization/i);
});

// ---------- M-24 / R-1：不同 x-api-key 的挂起状态互不覆盖 ----------

test('M-24: 两个不同 x-api-key 并发挂起 → pending 两条独立条目（Q6 核心）', () => {
  const handler = makeHandler();

  const keyA = clientKey(req({ headers: { 'x-api-key': 'sk-A' } }));
  const keyB = clientKey(req({ headers: { 'x-api-key': 'sk-B' } }));
  assert.notEqual(keyA, keyB, '两个客户端的隔离键必须不同');

  const stateA = { protocol: 'anthropic', content: '', toolCall: null, timer: null };
  const stateB = { protocol: 'anthropic', content: '', toolCall: null, timer: null };

  handler._suspendForToolCall(stateA, TOOL_EVENT, {
    stream: false, ctx: sctx(keyA, { completionId: 'msg-1', created: 1, model: 'm' })
  });
  handler._suspendForToolCall(stateB, TOOL_EVENT, {
    stream: false, ctx: sctx(keyB, { completionId: 'msg-2', created: 1, model: 'm' })
  });

  assert.equal(handler.pending.size, 2, '两条挂起条目应共存，互不覆盖');
  assert.equal(handler.pending.get(keyA), stateA);
  assert.equal(handler.pending.get(keyB), stateB);
});

test('M-24 反证: 不带 x-api-key 时二者塌缩同一 key（记录现状，不伪造已隔离）', () => {
  const a = clientKey(req());
  const b = clientKey(req());
  assert.equal(a, b, 'R-2：无鉴权头时塌缩为同一个 default key —— 既有设计限制，断言记录现状');
});

// ---------- M-25 / R-6：同 key 跨协议挂起各自记录 protocol ----------

test('M-25: 同 key 先挂 OpenAI 再挂 Anthropic → 各自记录 protocol，续跑不串协议', () => {
  const handler = makeHandler();
  const key = 'sk-shared';

  const openaiState = { protocol: 'openai', content: '', toolCall: null, timer: null };
  handler._suspendForToolCall(openaiState, TOOL_EVENT, {
    stream: false, ctx: sctx(key, { completionId: 'cmpl-1', created: 1, model: 'm' })
  });
  assert.equal(handler.pending.get(key).protocol, 'openai');

  const anthropicState = { protocol: 'anthropic', content: '', toolCall: null, timer: null };
  handler._suspendForToolCall(anthropicState, TOOL_EVENT, {
    stream: false, ctx: sctx(key, { completionId: 'msg-1', created: 1, model: 'm' })
  });

  assert.equal(handler.pending.get(key).protocol, 'anthropic', '同 key 后挂者顶替，但 protocol 随条目走');
  assert.equal(handler.pending.size, 1, 'R-3 已知限制：pending 按 key 不按 convId 索引');
});

/**
 * OpenAiHandler 构造期依赖注入契约（批9 #3）。
 *
 * 固化两点：
 *   1. **缺省零行为变化**——不传 deps 时，各协作者仍是各自的 `new` 实例
 *      （sessions/conversations/convAccounts 类型与旧一致，pending 为 Map）。
 *   2. **注入即采用**——传入的 deps 逐字挂到实例上（同一引用），测试/嵌入方
 *      无需构造后再逐个属性赋值。
 *
 * 背景：生产装配 `router.js` 使用 `new OpenAiHandler()`（无 deps），此路径必须
 * 与重构前逐字一致；deps 只是**新增可选面**，不改变默认行为。
 */

process.env.FIRST_TOKEN_TIMEOUT_MS = '600000';
process.env.STREAM_STALL_TIMEOUT_MS = '600000';

const { OpenAiHandler } = await import('../src/openai-handler.js');
const { SessionManager } = await import('../src/session-manager.js');
const { ConversationCache } = await import('../src/conversation-cache.js');
const { ConvAccountMap } = await import('../src/conv-account-map.js');
import assert from 'node:assert/strict';
import { test } from 'node:test';

test('缺省：不传 deps 时各协作者为各自的 new 实例（行为零变化）', () => {
  const h = new OpenAiHandler();
  assert.ok(h.sessions instanceof SessionManager, 'sessions 默认为 SessionManager');
  assert.ok(h.conversations instanceof ConversationCache, 'conversations 默认为 ConversationCache');
  assert.ok(h.convAccounts instanceof ConvAccountMap, 'convAccounts 默认为 ConvAccountMap');
  assert.ok(h.pending instanceof Map, 'pending 默认为 Map');
  assert.ok(h.disconnectCancels instanceof Map, 'disconnectCancels 默认为 Map');
});

test('缺省：gatewayUrl 透传给 SessionManager', () => {
  const h = new OpenAiHandler('http://127.0.0.1:9999');
  assert.ok(h.sessions instanceof SessionManager);
});

test('注入：deps 中的协作者按同一引用采用', () => {
  const sessions = { acquire() {}, release() {} };
  const conversations = { get: () => null, set() {} };
  const convAccounts = { get: () => null, set() {} };
  const pending = new Map([['k', { x: 1 }]]);
  const disconnectCancels = new Map();

  const h = new OpenAiHandler(null, { sessions, conversations, convAccounts, pending, disconnectCancels });

  assert.equal(h.sessions, sessions);
  assert.equal(h.conversations, conversations);
  assert.equal(h.convAccounts, convAccounts);
  assert.equal(h.pending, pending);
  assert.equal(h.disconnectCancels, disconnectCancels);
  assert.equal(h.pending.get('k').x, 1, '预置的 pending 条目应保留');
});

test('注入：仅给部分 deps 时其余回落默认 new', () => {
  const sessions = { acquire() {} };
  const h = new OpenAiHandler('http://x', { sessions });
  assert.equal(h.sessions, sessions, '注入的 sessions 被采用');
  assert.ok(h.conversations instanceof ConversationCache, '未注入的 conversations 回落默认');
  assert.ok(h.convAccounts instanceof ConvAccountMap, '未注入的 convAccounts 回落默认');
  assert.ok(h.pending instanceof Map, '未注入的 pending 回落默认');
});

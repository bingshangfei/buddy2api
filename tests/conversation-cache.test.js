/**
 * ConversationCache 单测（node:test，零依赖）。
 * 会话亲和的前缀匹配/增量切片/淘汰语义——这是"复用后端会话稳定命中前缀缓存"
 * 的正确性核心，必须严格覆盖边界。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConversationCache } from '../src/conversation-cache.js';

const ref = (sessionId, poolId = 'pool-1', model = 'auto') => ({ sessionId, poolId, model });

test('空缓存 lookup 返回 null', () => {
  const c = new ConversationCache();
  assert.equal(c.lookup('k', 'hello', 'auto'), null);
});

test('remember 后，文本严格扩展 → 命中并返回正确增量', () => {
  const c = new ConversationCache();
  c.remember('k', ref('s1'), 'SYS\n\n[User]\nu1', 1000);
  const hit = c.lookup('k', 'SYS\n\n[User]\nu1\n\n[User]\nu2', 'auto', 1001);
  assert.ok(hit);
  assert.equal(hit.entry.sessionId, 's1');
  assert.equal(hit.delta, '\n\n[User]\nu2');
});

test('文本完全相同（多为重试）→ 不复用', () => {
  const c = new ConversationCache();
  c.remember('k', ref('s1'), 'same', 1000);
  assert.equal(c.lookup('k', 'same', 'auto', 1001), null);
});

test('文本不是前缀 → 不复用', () => {
  const c = new ConversationCache();
  c.remember('k', ref('s1'), 'AAA', 1000);
  assert.equal(c.lookup('k', 'BBB-longer', 'auto', 1001), null);
});

test('key 隔离：不同 key 不互相命中', () => {
  const c = new ConversationCache();
  c.remember('k1', ref('s1'), 'SYS-u1', 1000);
  assert.equal(c.lookup('k2', 'SYS-u1-u2', 'auto', 1001), null);
});

test('模型不一致 → 不复用', () => {
  const c = new ConversationCache();
  c.remember('k', ref('s1', 'pool-1', 'glm-5.1'), 'SYS-u1', 1000);
  assert.equal(c.lookup('k', 'SYS-u1-u2', 'deepseek-v4.1-flash', 1001), null);
});

test('超过 TTL → 不复用', () => {
  const c = new ConversationCache({ ttlMs: 1000 });
  c.remember('k', ref('s1'), 'SYS-u1', 1000);
  assert.equal(c.lookup('k', 'SYS-u1-u2', 'auto', 2001), null);
  assert.ok(c.lookup('k', 'SYS-u1-u2', 'auto', 1999));
});

test('同 sessionId 复用 → 原地更新并累加轮次', () => {
  const c = new ConversationCache();
  c.remember('k', ref('s1'), 'A', 1000);
  c.remember('k', ref('s1'), 'A-B', 1001);
  c.remember('k', ref('s1'), 'A-B-C', 1002);
  assert.equal(c.size(), 1);
  const hit = c.lookup('k', 'A-B-C-D', 'auto', 1003);
  assert.equal(hit.delta, '-D');
  assert.equal(hit.entry.turns, 3);
});

test('达到 maxTurns → 条目被丢弃，下一轮冷启动', () => {
  const c = new ConversationCache({ maxTurns: 2 });
  c.remember('k', ref('s1'), 'A', 1000);        // turns=1
  const e = c.remember('k', ref('s1'), 'A-B', 1001); // turns=2 → 丢弃
  assert.equal(e, null);
  assert.equal(c.size(), 0);
  assert.equal(c.lookup('k', 'A-B-C', 'auto', 1002), null);
});

test('新会话覆盖旧会话：旧文本是本次前缀时清掉旧条目', () => {
  const c = new ConversationCache();
  c.remember('k', ref('s1'), 'A-B', 1000);
  c.remember('k', ref('s2'), 'A-B-C', 1001); // 新会话，旧条目被覆盖
  assert.equal(c.size(), 1);
  const hit = c.lookup('k', 'A-B-C-D', 'auto', 1002);
  assert.equal(hit.entry.sessionId, 's2');
});

test('多对话并存：取最长匹配的前缀条目', () => {
  const c = new ConversationCache();
  c.remember('k', ref('s1'), 'X', 1000);
  c.remember('k', ref('s2'), 'SYS-answer', 1001); // 与 s1 无关，保留
  const hit = c.lookup('k', 'X-more', 'auto', 1002);
  assert.equal(hit.entry.sessionId, 's1');
  assert.equal(hit.delta, '-more');
  assert.equal(c.size(), 2);
});

test('forget(poolId) 移除该连接上的条目', () => {
  const c = new ConversationCache();
  c.remember('k', ref('s1', 'pool-1'), 'A', 1000);
  c.remember('k', ref('s2', 'pool-2'), 'B', 1001);
  c.forget('k', 'pool-1');
  assert.equal(c.size(), 1);
  assert.equal(c.lookup('k', 'B-x', 'auto', 1002).entry.sessionId, 's2');
});

test('maxEntriesPerKey：超出上限淘汰最久未用', () => {
  const c = new ConversationCache({ maxEntriesPerKey: 2 });
  c.remember('k', ref('s1'), 'A', 1000);
  c.remember('k', ref('s2'), 'B', 1001);
  c.remember('k', ref('s3'), 'C', 1002);
  assert.equal(c.size(), 2);
  // 最久未用的 s1（A）被淘汰
  assert.equal(c.lookup('k', 'A-more', 'auto', 1003), null);
  assert.ok(c.lookup('k', 'C-more', 'auto', 1003));
});

test('purge 清理过期条目', () => {
  const c = new ConversationCache({ ttlMs: 100 });
  c.remember('k', ref('s1'), 'A', 1000);
  c.purge(1200);
  assert.equal(c.size(), 0);
});

/**
 * ConvPoolMap（池级亲和映射，refactor-20260928-arch-deepening2 批5）直测。
 *
 * 补界是本任务**唯一申报的行为变化点**（requirements D6）：此前 convPools 是
 * 无界 Map（affinity.md「刻意不做」被申报重开）。这里锁：界 500、淘汰批 20%、
 * **死条目优先**（先删指向已销毁池的条目，审视 F8）、淘汰回调可观测。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConvPoolMap, ConvAccountMap } from '../src/conv-account-map.js';

test('补界：超过 maxEntries 后 size 回落，最旧条目被淘汰（与 convAccounts 同语义）', () => {
  const m = new ConvPoolMap({ maxEntries: 10, evictCount: 2 });
  for (let i = 0; i < 10; i++) m.set(`c${i}`, `p${i}`);
  assert.equal(m.size, 10);
  m.set('c10', 'p10'); // 新键触发淘汰 2 条：10 - 2 + 1 = 9
  assert.equal(m.size, 9, '淘汰 2 条后落入 1 条，size 回到界内');
  assert.equal(m.has('c0'), false, '最旧条目先被淘汰');
  assert.equal(m.has('c1'), false);
  assert.equal(m.has('c10'), true);
});

test('死条目优先：淘汰批内死指向先走，活亲和保住（审视 F8）', () => {
  const livePools = new Set(['p3', 'p4']); // p1/p2 已销毁
  const evicted = [];
  const m = new ConvPoolMap({
    maxEntries: 4, evictCount: 2,
    isDead: (poolId) => !livePools.has(poolId),
    onEvict: (convId, poolId, dead) => evicted.push([convId, poolId, dead])
  });
  m.set('a', 'p1'); // 最旧，且死
  m.set('b', 'p2'); // 次旧，且死
  m.set('c', 'p3'); // 活
  m.set('d', 'p4'); // 活
  m.set('e', 'p5'); // 新键 → 触发淘汰 2 条

  assert.deepEqual(evicted, [['a', 'p1', true], ['b', 'p2', true]],
    '必须先淘汰两条死指向，活亲和（c/d）一条不动');
  assert.equal(m.has('c'), true);
  assert.equal(m.has('d'), true);
});

test('死条目不足额时，剩余名额按插入顺序淘汰最旧活条目（打日志可观测）', () => {
  const livePools = new Set(['p2', 'p3', 'p4']);
  const evicted = [];
  const m = new ConvPoolMap({
    maxEntries: 4, evictCount: 3,
    isDead: (poolId) => !livePools.has(poolId),
    onEvict: (convId, poolId, dead) => evicted.push([convId, dead])
  });
  m.set('a', 'p1'); // 死
  m.set('b', 'p2'); // 活，最旧
  m.set('c', 'p3'); // 活
  m.set('d', 'p4'); // 活
  m.set('e', 'p5');

  assert.deepEqual(evicted, [['a', true], ['b', false], ['c', false]],
    '死条目 1 条先走，另 2 条名额按最旧序落活条目');
  assert.equal(m.has('d'), true);
});

test('无 isDead 时退化为纯 LRU（与 ConvAccountMap 同构）', () => {
  const m = new ConvPoolMap({ maxEntries: 3, evictCount: 1 });
  m.set('a', 'p1'); m.set('b', 'p2'); m.set('c', 'p3');
  m.set('d', 'p4');
  assert.equal(m.has('a'), false);
  assert.equal(m.has('b'), true);
  // 写刷新：set 已有键刷新插入顺序
  m.set('b', 'p2'); // 刷新
  m.set('e', 'p5'); // 淘汰最旧 = c（b 已刷新）
  assert.equal(m.has('c'), false);
  assert.equal(m.has('b'), true);
});

test('ConvAccountMap 既有语义不回归：上限/淘汰/写刷新（行为锁对照）', () => {
  const m = new ConvAccountMap({ maxEntries: 2, evictCount: 1 });
  m.set('a', 'acc1'); m.set('b', 'acc2');
  m.set('a', 'acc1'); // 写刷新（插入顺序变为 b, a）
  m.set('c', 'acc3'); // 新键且已满 → 淘汰最旧 = b
  assert.equal(m.has('b'), false);
  assert.equal(m.has('a'), true);
  assert.equal(m.get('a'), 'acc1');
});

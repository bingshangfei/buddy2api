/**
 * attempt.js state 归属原语的特征测试（批9 #4）。
 *
 * 固化"收敛后的边界"：attempt state 的写入语义集中在本模块——
 *   - markFirstOutput 幂等（仅首次置值，不覆盖）
 *   - appendContent / appendReasoning 先置位（幂等）后累加
 *   - setUsage 覆盖 vs mergeUsage 求和（F6 硬约束：两条语义不得互相冒充）
 *   - setIterator / clearIterator 迭代器挂起与归还
 *
 * 这些原语的调用方（sink-base / queue-policy / openai-handler）行为由既有集成
 * 测试锁定（sink-ledger / handler-path-contract / attempt-state-seed），本文件
 * 只锁原语自身的语义边界。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  markFirstOutput, appendContent, appendReasoning,
  setUsage, mergeUsage, setIterator, clearIterator,
  addUsage, EMPTY_USAGE,
  setContinuationContext, incrementContinued
} from '../src/attempt.js';
import { bindConnection } from '../src/connection-state.js';

test('markFirstOutput：幂等，仅首次生效（后续不覆盖已置的时间戳）', () => {
  const state = { startedAt: 0 };
  markFirstOutput(state);
  const first = state.firstOutputAt;
  assert.equal(typeof first, 'number', '必须置为数值时间戳');
  markFirstOutput(state);
  assert.equal(state.firstOutputAt, first, '再次调用不得覆盖首输出时间戳');
});

test('appendContent：先置首输出（若未置）再累加正文', () => {
  const state = { content: '' };
  appendContent(state, 'he');
  appendContent(state, 'llo');
  assert.equal(state.content, 'hello');
  assert.equal(typeof state.firstOutputAt, 'number');
});

test('appendContent：已有 firstOutputAt 时不被改写', () => {
  const state = { content: '', firstOutputAt: 111 };
  appendContent(state, 'x');
  assert.equal(state.firstOutputAt, 111);
  assert.equal(state.content, 'x');
});

test('appendReasoning：无条件累加（即使 thinking 关闭路径也不跳过），并置首输出', () => {
  const state = { reasoning: '' };
  appendReasoning(state, '思');
  appendReasoning(state, '考');
  assert.equal(state.reasoning, '思考', 'reasoning 必须无条件累加（anthropic.md 钉死1）');
  assert.equal(typeof state.firstOutputAt, 'number');
});

test('setUsage：覆盖语义（整体替换，非累加）', () => {
  const state = { usage: { ...EMPTY_USAGE } };
  setUsage(state, { prompt_tokens: 5, completion_tokens: 7, model: 'm' });
  assert.deepEqual(state.usage, { prompt_tokens: 5, completion_tokens: 7, model: 'm' });
  setUsage(state, { prompt_tokens: 1, completion_tokens: 2 });
  assert.deepEqual(state.usage, { prompt_tokens: 1, completion_tokens: 2 }, '第二次覆盖第一次，不累加');
});

test('mergeUsage：求和语义，且不污染入参 first', () => {
  const state = { usage: { prompt_tokens: 3, completion_tokens: 4 } };
  const first = { prompt_tokens: 3, completion_tokens: 4 };
  mergeUsage(state, first, { prompt_tokens: 5, completion_tokens: 6 });
  assert.deepEqual(state.usage, { prompt_tokens: 8, completion_tokens: 10 });
  assert.deepEqual(first, { prompt_tokens: 3, completion_tokens: 4 }, 'first 不得被就地改写');
});

test('mergeUsage 与 addUsage 同源：结果与 addUsage 逐字一致', () => {
  const a = { prompt_tokens: 1, completion_tokens: 2, model: 'x' };
  const b = { prompt_tokens: 10, completion_tokens: 20 };
  const s = { usage: null };
  mergeUsage(s, a, b);
  assert.deepEqual(s.usage, addUsage(a, b));
});

test('setUsage 与 mergeUsage 语义不同（F6：覆盖 vs 求和不得合并）', () => {
  const s1 = { usage: null };
  const s2 = { usage: null };
  setUsage(s1, { prompt_tokens: 1, completion_tokens: 1 });
  mergeUsage(s2, { prompt_tokens: 1, completion_tokens: 1 }, { prompt_tokens: 1, completion_tokens: 1 });
  assert.notDeepEqual(s1.usage, s2.usage, '覆盖与求和必须在同一入参下产出不同结果');
});

test('setIterator / clearIterator：挂起与归还', () => {
  const state = {};
  const it = { next() {} };
  setIterator(state, it);
  assert.equal(state.iterator, it);
  clearIterator(state);
  assert.equal(state.iterator, null);
});

test('bindConnection：会话定位三件套整体替换（旧池已被 discard 后的续写定位）', () => {
  const state = { client: 'old', sessionId: 'old-s', poolId: 'old-p', accountId: 'acc-1' };
  bindConnection(state, { client: 'new', sessionId: 'new-s', poolId: 'new-p', accountId: 'acc-2' });
  assert.equal(state.client, 'new');
  assert.equal(state.sessionId, 'new-s');
  assert.equal(state.poolId, 'new-p');
  assert.equal(state.accountId, 'acc-2');
});

test('bindConnection：accountId 缺省时保留旧值（新会话无账号持续上报）', () => {
  const state = { client: 'old', sessionId: 'old-s', poolId: 'old-p', accountId: 'acc-1' };
  bindConnection(state, { client: 'new', sessionId: 'new-s', poolId: 'new-p' });
  assert.equal(state.accountId, 'acc-1', 'accountId 未提供不得清空既有值');
});

test('setContinuationContext：prompt 与 rawMessages 同步替换为续写版', () => {
  const state = { prompt: 'old-prompt', rawMessages: ['old'] };
  setContinuationContext(state, { prompt: 'new-prompt', rawMessages: ['new'] });
  assert.equal(state.prompt, 'new-prompt');
  assert.deepEqual(state.rawMessages, ['new']);
});

test('incrementContinued：续写次数 +1（无论成败）', () => {
  const state = { continuedCount: 0 };
  incrementContinued(state);
  incrementContinued(state);
  assert.equal(state.continuedCount, 2);
});

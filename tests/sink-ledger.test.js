/**
 * sink 台账锚定（refactor-20260926-arch-deepening）。
 *
 * 锁定台账收拢（sink-base.js）后两协议的现状口径——特别是文档与代码不一致处
 * （brainstorm 审视 F12）：anthropic.md 钉死4 说「收尾后 wire 与 state 都不再变」，
 * 但 onUsage 两侧现状**都没有** finished 门。本文件按**代码现状**锁定：
 * base 抽取若顺手给 usage 补门（对齐文档）或改变 finished 门的覆盖面，这里变红。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createAnthropicSink } from '../src/anthropic-sink.js';
import { createSink } from '../src/sink-factory.js';

function fakeStreamRes() {
  return { write: () => {}, end: () => {} };
}

test('anthropic 收尾后 onUsage 仍更新 state.usage（现状无门，勿顺手补）', () => {
  const state = { prompt: [], content: '', reasoning: '', thinkingEnabled: true };
  const sink = createAnthropicSink({
    emit: 'stream',
    state,
    key: 'k',
    completionId: 'msg_1',
    model: 'm',
    res: fakeStreamRes()
  });
  sink.onDelta('hi');
  sink.finish();
  const u = { prompt_tokens: 1, completion_tokens: 2 };
  sink.onUsage(u);
  assert.equal(state.usage, u, 'usage 在 finished 后必须仍被记录（现状口径）');
});

test('openai 流式 sink 无收尾门：delta 无 finished 概念，usage 恒更新', () => {
  const state = { prompt: [], content: '', reasoning: '', thinkingEnabled: false };
  const sink = createSink({
    emit: 'stream',
    state,
    key: 'k',
    completionId: 'chatcmpl-1',
    created: 1,
    model: 'm',
    res: fakeStreamRes()
  });
  sink.onDelta('a');
  assert.ok(state.firstOutputAt > 0, 'firstOutputAt 必须被置位');
  const u = { prompt_tokens: 3, completion_tokens: 4 };
  sink.onUsage(u);
  assert.equal(state.usage, u);
});

test('非流式（accumulate）sink 的 heartbeat 必须是 undefined（queue-retry 契约，F13）', () => {
  const state = { prompt: [], content: '', reasoning: '', thinkingEnabled: false };
  const openai = createSink({ emit: 'accumulate', state, key: 'k', completionId: 'c', created: 1, model: 'm', res: {} });
  const anthropic = createAnthropicSink({ emit: 'accumulate', state, key: 'k', completionId: 'msg_1', model: 'm', res: {} });
  assert.equal(openai.heartbeat, undefined);
  assert.equal(anthropic.heartbeat, undefined);
});

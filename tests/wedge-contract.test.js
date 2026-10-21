/**
 * 停滞契约类型化锚定（refactor-20260926-arch-deepening 候选②）。
 *
 * 锁定：① 假死错误带 err.code = BACKEND_WEDGE 且**只在 firstTokenTimeoutError
 * 工厂单点设置**（F11：勿出现第三真相源）；② queue-policy 对带 code 的错误永不
 * 退避重试（typed 优先判定）；③ 措辞契约仍成立（消息不命中 isRateLimited——
 * 历史兜底保留）；④ STALL_REASON 枚举字面值不变（测试与日志依赖）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { STALL_REASON, WEDGE_ERROR_CODE } from '../src/stream-driver.js';
import { firstTokenTimeoutError, isWedgeError, isRateLimited } from '../src/openai-handler.js';
import { runWithRateLimitRetry } from '../src/queue-policy.js';

test('firstTokenTimeoutError 带 BACKEND_WEDGE code，两态 reason 均如此', () => {
  for (const reason of [STALL_REASON.FIRST_TOKEN, STALL_REASON.MID_STREAM]) {
    const err = firstTokenTimeoutError(false, reason);
    assert.equal(err.name, 'FirstTokenTimeoutError');
    assert.equal(err.code, WEDGE_ERROR_CODE);
    assert.equal(isWedgeError(err), true);
  }
});

test('STALL_REASON 枚举字面值是契约（勿改）', () => {
  assert.deepEqual({ ...STALL_REASON }, { FIRST_TOKEN: 'first-token', MID_STREAM: 'mid-stream', SOFT: 'soft' });
});

test('promoteWedgeReason 基态与 STALL_REASON.MID_STREAM 一致（attempt 叶子模块的字面量锁）', async () => {
  const { promoteWedgeReason } = await import('../src/attempt.js');
  const state = { wedgeReason: STALL_REASON.MID_STREAM };
  promoteWedgeReason(state, 'mid-stream-continued');
  assert.equal(state.wedgeReason, 'mid-stream-continued');
  const done = { wedgeReason: 'mid-stream-failed' };
  promoteWedgeReason(done, 'mid-stream-continued');
  assert.equal(done.wedgeReason, 'mid-stream-failed', '失败收尾后不得被改报为续写成功');
});

test('假死错误消息不命中 isRateLimited（措辞契约仍是兜底）', () => {
  for (const reason of [STALL_REASON.FIRST_TOKEN, STALL_REASON.MID_STREAM]) {
    assert.equal(isRateLimited(firstTokenTimeoutError(true, reason).message), false, reason);
  }
});

test('queue-policy 对 BACKEND_WEDGE 错误不退避重试（typed 短路）', async () => {
  let calls = 0;
  const wedgeErr = new Error('WorkBuddy 首 token 超时（120s 零输出，疑似后端假死，已回收该后端）');
  wedgeErr.name = 'FirstTokenTimeoutError';
  wedgeErr.code = WEDGE_ERROR_CODE;
  const client = {
    sendPrompt() {
      calls++;
      const iterator = (async function* () {
        yield { jsonrpc: '2.0', id: 1, error: { code: -32000, message: wedgeErr.message } };
      })();
      return { [Symbol.asyncIterator]: () => iterator };
    }
  };
  const sink = {
    onError: (message) => { throw wedgeErr; } // 带上 code，模拟 handler 工厂产出的假死错误
  };
  const state = { content: '', reasoning: '', usage: null, toolCall: null, iterator: null };
  await assert.rejects(
    runWithRateLimitRetry({
      key: 'k', client, sessionId: 's', prompt: [], isAborted: () => false, sink, state,
      hasPending: () => false,
      delayMsFn: () => 1
    }),
    /首 token 超时/
  );
  assert.equal(calls, 1, '带 WEDGE_ERROR_CODE 的错误必须立即抛出、不得退避重试');
});

test('queue-policy 对真频控错误仍照常退避重试（正则路径未受 code 短路影响）', async () => {
  let calls = 0;
  const client = {
    sendPrompt() {
      calls++;
      const iterator = (async function* () {
        if (calls === 1) yield { jsonrpc: '2.0', id: 1, error: { code: -32000, message: '429 rate limit' } };
        yield { jsonrpc: '2.0', id: 2, result: {} };
      })();
      return { [Symbol.asyncIterator]: () => iterator };
    }
  };
  const seen = [];
  const sink = {
    onError: (message) => { throw new Error(message); },
    onDone: () => { seen.push('done'); return 'DONE'; }
  };
  const state = { content: 'x', reasoning: '', usage: null, toolCall: null, iterator: null };
  const r = await runWithRateLimitRetry({
    key: 'k', client, sessionId: 's', prompt: [], isAborted: () => false, sink, state,
    hasPending: () => false,
    delayMsFn: () => 1
  });
  assert.equal(r, 'DONE');
  assert.equal(calls, 2, '无 code 的频控错误仍走正则判定与退避重试');
});

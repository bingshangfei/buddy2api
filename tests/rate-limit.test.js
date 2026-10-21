/**
 * 频控（429）退避重试单测（node:test，零依赖）。
 * 覆盖 isRateLimited / rateLimitDelayMs 纯函数与 OpenAiHandler._runWithRateLimitRetry。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OpenAiHandler, buildRequestContext } from '../src/openai-handler.js';
import { isRateLimited, rateLimitDelayMs, parseQuotaResetAt } from '../src/queue-policy.js';

// request-context（批C）：key/isAborted 经 ctx 携带
const rctx = (over = {}) => buildRequestContext({ key: 'test', isAborted: () => false, ...over });

// ---------- isRateLimited ----------

test('isRateLimited: 识别 WorkBuddy 429 频控消息', () => {
  assert.equal(isRateLimited('429 您的使用量已超出频率限制，将在 2026-08-20 09:08:51 UTC+8 重置'), true);
  assert.equal(isRateLimited('Request failed with status code 429'), true);
  assert.equal(isRateLimited('rate limit exceeded'), true);
  assert.equal(isRateLimited('Too many requests, please retry later'), true);
  assert.equal(isRateLimited('quota exceeded'), true);
});

test('isRateLimited: 识别热门模型排队/资源紧张提示', () => {
  assert.equal(isRateLimited('当前模型资源紧张，请等候。前方约 5127 位用户排队'), true);
  assert.equal(isRateLimited('模型繁忙，请稍后重试'), true);
  assert.equal(isRateLimited('service busy, please try again later'), true);
  assert.equal(isRateLimited('server overloaded'), true);
});

test('isRateLimited: 不误判普通错误', () => {
  assert.equal(isRateLimited('Tool TodoWrite not found in agent cli.'), false);
  assert.equal(isRateLimited('Request timeout after 30000ms'), false);
  assert.equal(isRateLimited(''), false);
  assert.equal(isRateLimited(undefined), false);
  assert.equal(isRateLimited(null), false);
});

// ---------- rateLimitDelayMs ----------

test('rateLimitDelayMs: 指数退避 10s → 20s → 40s → 80s → 120s，120s 封顶', () => {
  assert.equal(rateLimitDelayMs(1), 10 * 1000);
  assert.equal(rateLimitDelayMs(2), 20 * 1000);
  assert.equal(rateLimitDelayMs(3), 40 * 1000);
  assert.equal(rateLimitDelayMs(4), 80 * 1000);
  assert.equal(rateLimitDelayMs(5), 120 * 1000, '第 5 次起封顶 120s');
  assert.equal(rateLimitDelayMs(10), 120 * 1000, '第 10 次仍是封顶值');
});

// ---------- parseQuotaResetAt（配额耗尽短路） ----------

test('parseQuotaResetAt: 解析带 UTC+8 标记的重置时刻', () => {
  // 2026-08-20 09:08:51 UTC+8 == 2026-08-20 01:08:51 UTC
  const expected = Date.UTC(2026, 7, 20, 1, 8, 51);
  assert.equal(
    parseQuotaResetAt('429 您的使用量已超出频率限制，将在 2026-08-20 09:08:51 UTC+8 重置'),
    expected
  );
});

test('parseQuotaResetAt: 解析带 UTC+0 / 负偏移标记', () => {
  assert.equal(
    parseQuotaResetAt('quota exceeded, resets at 2026-08-20 09:08:51 UTC+0'),
    Date.UTC(2026, 7, 20, 9, 8, 51)
  );
  assert.equal(
    parseQuotaResetAt('quota exceeded, resets at 2026-08-20 09:08:51 UTC-5'),
    Date.UTC(2026, 7, 20, 14, 8, 51)
  );
});

test('parseQuotaResetAt: 无偏移标记时按本机时区解析', () => {
  const offsetMs = -new Date(2026, 7, 20).getTimezoneOffset() * 60 * 1000;
  assert.equal(
    parseQuotaResetAt('rate limited until 2026-08-20 09:08:51'),
    Date.UTC(2026, 7, 20, 9, 8, 51) - offsetMs
  );
});

test('parseQuotaResetAt: 排队类消息无重置时刻 → null', () => {
  assert.equal(parseQuotaResetAt('当前模型资源紧张，请等候。前方约 5127 位用户排队'), null);
  assert.equal(parseQuotaResetAt('service busy, please try again later'), null);
  assert.equal(parseQuotaResetAt(''), null);
  assert.equal(parseQuotaResetAt(undefined), null);
  assert.equal(parseQuotaResetAt(null), null);
});

// ---------- _runWithRateLimitRetry ----------

/**
 * 构造 fake client：第 n 次 sendPrompt 产生 error 事件（onError 抛错），
 * 第 n+1 次起产生正常 result。
 * 真实 sink 的 onError 会抛错，这里模拟同样的行为。
 */
function fakeClient(errorEvents = ['429 您的使用量已超出频率限制']) {
  let calls = 0;
  return {
    calls: () => calls,
    sendPrompt() {
      calls++;
      const idx = calls;
      return {
        [Symbol.asyncIterator]() {
          return {
            async next() {
              if (idx <= errorEvents.length) {
                return { value: { jsonrpc: '2.0', id: 'p', error: { message: errorEvents[idx - 1] } }, done: false };
              }
              // 成功路径：先产出一个内容 chunk，再产出 result（模拟真实 WorkBuddy 行为）
              if (!this._sentContent) {
                this._sentContent = true;
                return { value: { method: 'session/update', params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hello' } } } }, done: false };
              }
              return { value: { jsonrpc: '2.0', id: 'p', result: { stopReason: 'end_turn' } }, done: false };
            }
          };
        }
      };
    }
  };
}

const throwingSink = (state) => ({
  onError: (message) => { throw new Error(message); },
  onDelta: (text) => { state.content += text; },
  onReasoning: (text) => { state.reasoning += text; },
  onUsage: (usage) => { state.usage = usage; },
  onDone: () => 'DONE-RET',
  heartbeat: () => {}
});

test('_runWithRateLimitRetry: 429 后退避重试并最终成功', async () => {
  const handler = new OpenAiHandler('http://127.0.0.1:1');
  handler._rateLimitDelayMs = () => 1; // 注入极短退避，测试不等待真实 30s
  const client = fakeClient(['429 您的使用量已超出频率限制']);
  const state = { iterator: null, content: '', reasoning: '', usage: {} };

  const result = await handler._runWithRateLimitRetry({
    client,
    sessionId: 's1',
    prompt: 'hi',
    sink: throwingSink(state),
    state,
    ctx: rctx()
  });

  assert.equal(result, 'DONE-RET');
  assert.equal(client.calls(), 2, '429 后应重试一次，共发起 2 次 prompt');
  assert.ok(state.iterator, 'run 结束后 state.iterator 指向最后一次的迭代器');
});

test('_runWithRateLimitRetry: 非频控错误立即抛出，不重试', async () => {
  const handler = new OpenAiHandler('http://127.0.0.1:1');
  handler._rateLimitDelayMs = () => 1;
  const client = fakeClient(['Tool TodoWrite not found in agent cli.']);
  const state = { iterator: null, content: '', reasoning: '', usage: {} };

  await assert.rejects(
    () => handler._runWithRateLimitRetry({
      client, sessionId: 's1', prompt: 'x',
      sink: throwingSink(state), state, ctx: rctx()
    }),
    /Tool TodoWrite/
  );
  assert.equal(client.calls(), 1, '非频控错误不应重试');
});

test('_runWithRateLimitRetry: 连续 429 超过重试上限（10次）后抛错', async () => {
  const handler = new OpenAiHandler('http://127.0.0.1:1');
  handler._rateLimitDelayMs = () => 1;
  const client = fakeClient(Array.from({ length: 11 }, () => '429 rate limit'));
  const state = { iterator: null, content: '', reasoning: '', usage: {} };

  await assert.rejects(
    () => handler._runWithRateLimitRetry({
      client, sessionId: 's1', prompt: 'x',
      sink: throwingSink(state), state, ctx: rctx()
    }),
    /429 rate limit/
  );
  // 1 次初始 + 10 次重试上限（QUEUE_MAX_RETRIES，与官方桌面版排队等候对齐）
  assert.equal(client.calls(), 11);
});

test('_runWithRateLimitRetry: 排队 10 次以内重试成功（对齐官方排队行为）', async () => {
  const handler = new OpenAiHandler('http://127.0.0.1:1');
  handler._rateLimitDelayMs = () => 1;
  // 前 10 次调用 429（排队中），第 11 次成功
  const client = fakeClient(Array.from({ length: 10 }, () => '429 rate limit'));
  const state = { iterator: null, content: '', reasoning: '', usage: {} };

  const result = await handler._runWithRateLimitRetry({
    client, sessionId: 's1', prompt: 'x',
    sink: throwingSink(state), state, ctx: rctx()
  });
  assert.equal(result, 'DONE-RET');
  assert.equal(client.calls(), 11, '10 次 429 后第 11 次成功');
});

test('_runWithRateLimitRetry: 客户端断开时立即停止等待并抛错', async () => {
  const handler = new OpenAiHandler('http://127.0.0.1:1');
  handler._rateLimitDelayMs = () => 200;
  const client = fakeClient(['429 rate limit']);
  const state = { iterator: null, content: '', reasoning: '', usage: {} };
  let aborted = false;

  const promise = handler._runWithRateLimitRetry({
    client, sessionId: 's1', prompt: 'x',
    sink: throwingSink(state), state, ctx: rctx({ isAborted: () => aborted })
  });

  // 等待循环开始后标记断开，退避等待应提前终止
  setTimeout(() => { aborted = true; }, 30);
  await assert.rejects(() => promise, /429 rate limit/);
  assert.equal(client.calls(), 1, '断开后不应发起新的重试');
});

// ---------- 配额耗尽短路（_runWithRateLimitRetry 集成） ----------

/**
 * 构造 parseQuotaResetAt 可解析的时间戳：'YYYY-MM-DD HH:MM:SS UTC+0'。
 * 用 UTC 分量 + 显式 UTC+0 标记，保证断言不受本机时区影响。
 */
function utcStamp(date) {
  const p = (n) => String(n).padStart(2, '0');
  return (
    `${date.getUTCFullYear()}-${p(date.getUTCMonth() + 1)}-${p(date.getUTCDate())} ` +
    `${p(date.getUTCHours())}:${p(date.getUTCMinutes())}:${p(date.getUTCSeconds())} UTC+0`
  );
}

test('_runWithRateLimitRetry: 配额重置时刻在远端 → 立即失败，不排队干等', async () => {
  const handler = new OpenAiHandler('http://127.0.0.1:1');
  handler._rateLimitDelayMs = () => 1;
  // 重置时刻在 2 小时后，远大于本次退避（注入的 1ms）→ 应短路
  const resetDate = new Date(Date.now() + 2 * 60 * 60 * 1000);
  const msg = `429 您的使用量已超出频率限制，将在 ${utcStamp(resetDate)} 重置`;

  const client = fakeClient([msg, msg, msg, msg, msg]); // 给足次数，若未短路会一直重试
  const state = { iterator: null, content: '', reasoning: '', usage: {} };

  await assert.rejects(
    () => handler._runWithRateLimitRetry({
      client, sessionId: 's1', prompt: 'x',
      sink: throwingSink(state), state, ctx: rctx()
    }),
    /配额已用尽/
  );
  assert.equal(client.calls(), 1, '重置时刻在远端时应立即失败，只发起 1 次 prompt');
});

test('_runWithRateLimitRetry: 配额重置时刻已过 → 不短路，走正常重试', async () => {
  const handler = new OpenAiHandler('http://127.0.0.1:1');
  handler._rateLimitDelayMs = () => 1;
  // 重置时刻在 1 分钟前（untilResetMs 为负）→ 等一轮就过去，应正常重试
  const pastDate = new Date(Date.now() - 60 * 1000);
  const msg = `429 您的使用量已超出频率限制，将在 ${utcStamp(pastDate)} 重置`;

  const client = fakeClient([msg]);
  const state = { iterator: null, content: '', reasoning: '', usage: {} };

  const result = await handler._runWithRateLimitRetry({
    client, sessionId: 's1', prompt: 'x',
    sink: throwingSink(state), state, ctx: rctx()
  });

  assert.equal(result, 'DONE-RET');
  assert.equal(client.calls(), 2, '重置时刻已过时应正常重试，共 2 次 prompt');
});

// ---------- 断开延迟取消（disconnectCancels） ----------

test('_scheduleDisconnectCancel: 宽限期后取消 WorkBuddy 任务', async () => {
  const handler = new OpenAiHandler('http://127.0.0.1:1');
  let cancelled = false;
  const client = { cancelPrompt: async () => { cancelled = true; } };

  handler._scheduleDisconnectCancel('k1', client, 's1', 30);
  assert.equal(handler.disconnectCancels.size, 1, '断开后应登记延迟取消');

  await new Promise(r => setTimeout(r, 60)); // 超过注入的 30ms 宽限期
  assert.equal(cancelled, true, '宽限期后应取消 WorkBuddy 任务');
  assert.equal(handler.disconnectCancels.size, 0, '取消后应清空登记');
});

test('_scheduleDisconnectCancel: 重连撤销取消（同 key 新请求）', async () => {
  const handler = new OpenAiHandler('http://127.0.0.1:1');
  let cancelled = false;
  const client = { cancelPrompt: async () => { cancelled = true; } };

  handler._scheduleDisconnectCancel('k2', client, 's1');
  // 模拟 handleChatCompletions 入口的重连撤销逻辑
  const prev = handler.disconnectCancels.get('k2');
  if (prev) {
    clearTimeout(prev.timer);
    handler.disconnectCancels.delete('k2');
  }
  assert.equal(handler.disconnectCancels.size, 0, '重连后应撤销取消登记');
  await new Promise(r => setTimeout(r, 50));
  assert.equal(cancelled, false, '撤销后不应取消 WorkBuddy 任务');
});

test('_scheduleDisconnectCancel: close() 清理未触发的延迟取消', async () => {
  const handler = new OpenAiHandler('http://127.0.0.1:1');
  const cancelled = [];
  const client = { cancelPrompt: async () => cancelled.push('x') };

  handler._scheduleDisconnectCancel('k3', client, 's1');
  handler._scheduleDisconnectCancel('k4', client, 's2');
  assert.equal(handler.disconnectCancels.size, 2);

  await handler.close();
  assert.equal(handler.disconnectCancels.size, 0, 'close 后应清空所有延迟取消');
  assert.equal(cancelled.length, 2, 'close 时未触发的延迟取消应直接取消任务');
});

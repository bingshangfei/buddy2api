/**
 * wedge 处置恢复单测（bugfix-20261020-hydrate-stall，node:test 零依赖）。
 *
 * 事故（2026-10-19 hydrate-trace）：A 路径（续跑）wedge ①文案谎称「已自动换后端重试 1 次」
 * （该路径从不重试，openai-handler.js 硬编码 final=true）；②零自愈而 B 路径有三段续写链；
 * ③送达看门狗满窗只回 error（打进已死 CLI = 无操作），无任何处置升级。
 *
 * 修复：F-fix1 文案诚实化（resumeWedgeTimeoutError）；F-fix2 满窗提前楔形信号
 * （ledger onConfirmExpired → client.onDeliveryExpired → driver 强制停滞到期）；
 * F-fix3 A 路径一次性续写自愈（换进程重放，含工具结果，上限 1 不递归）。
 *
 * 本文件必须在 import 被测模块之前设置超时 env（stream-driver 模块加载时读取），
 * 故使用动态 import。
 */

process.env.FIRST_TOKEN_TIMEOUT_MS = '40';
process.env.STREAM_STALL_TIMEOUT_MS = '40';

const { OpenAiHandler, buildRequestContext } = await import('../src/openai-handler.js');
const { AcpClient } = await import('../src/acp-client.js');
const { createInboundLedger } = await import('../src/inbound-ledger.js');
const { StreamDriver } = await import('../src/stream-driver.js');
const { isRateLimited } = await import('../src/queue-policy.js');
import assert from 'node:assert/strict';
import { test } from 'node:test';

const KEY = 'resume-key';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- 夹具（与 first-token-guard.test.js / anthropic-resume.test.js 同款） ----------

function messageChunk(text) {
  return {
    method: 'session/update',
    params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } }
  };
}

function fakeRes() {
  return {
    writableEnded: false,
    headersSent: false,
    written: '',
    writeHead() { this.headersSent = true; return this; },
    write(chunk) { this.written += chunk; return true; },
    end(chunk) { if (chunk) this.written += chunk; this.writableEnded = true; },
    on() {},
    off() {}
  };
}

/**
 * 从 SSE 写出物里取「错误文案」做频控判定。
 * 直接对整条 SSE 喂 isRateLimited 会假阳性：chunk id（chatcmpl-<ms 随机串>）与
 * created 秒级时间戳常含 "429" 字面，会让用例随机翻红。契约本身只约束文案。
 */
function errorMessageOf(written) {
  const m = written.match(/"error":\{"message":("(?:[^"\\]|\\.)*")/);
  return m ? JSON.parse(m[1]) : '';
}

/** 中途停滞假死客户端：先产出一段内容再永久静默（800ms 兜底 done 防测试挂死） */
function midStreamWedgedClient(log) {
  return {
    defaultModel: 'auto',
    cancelPrompt: async (sid) => { log.push(['cancel', sid]); },
    setModel: async () => {},
    destroy: async () => {},
    hasInflightPrompt: () => false,
    respondToToolCall: async () => {},
    sendPrompt: () => ({
      [Symbol.asyncIterator]: () => (async function* () {
        yield messageChunk('partial then silence');
        await new Promise(() => {}); // 永久静默 = 假死
      })()
    })
  };
}

function healthyClient(log, tag = 'hello from fresh backend') {
  return {
    defaultModel: 'auto',
    cancelPrompt: async (sid) => { log.push(['cancel', sid]); },
    setModel: async () => {},
    destroy: async () => {},
    hasInflightPrompt: () => false,
    respondToToolCall: async () => {},
    sendPrompt: () => ({
      [Symbol.asyncIterator]: () => (async function* () {
        yield messageChunk(tag);
        yield { jsonrpc: '2.0', id: 'p-1', result: { stopReason: 'end_turn' } };
      })()
    })
  };
}

function fakeSessions(sessionsByCall) {
  const log = { acquire: [], discardPool: [], invalidate: [], release: [], health: [] };
  let n = 0;
  return {
    _log: log,
    async acquire(key) {
      const s = sessionsByCall[Math.min(n++, sessionsByCall.length - 1)];
      log.acquire.push([key, s.poolId]);
      return s;
    },
    discardPool: (key, poolId) => log.discardPool.push([key, poolId]),
    invalidate: (key, poolId) => log.invalidate.push([key, poolId]),
    release: (key, poolId) => log.release.push([key, poolId]),
    reportAccountHealth: (accountId, r) => log.health.push([accountId, r.ok]),
    getModels: () => []
  };
}

function makeSession(client, poolId) {
  return {
    sessionId: `sid-${poolId}`,
    client,
    models: [],
    poolId,
    backendUrl: 'http://127.0.0.1:1',
    accountId: 'acc-1'
  };
}

function makeState(client, extra = {}) {
  return {
    key: KEY,
    protocol: 'openai',
    client,
    sessionId: 'sid-1',
    clientModel: 'auto',
    poolId: 'pool-1',
    accountId: 'acc-1',
    prompt: [{ type: 'text', text: '继续' }],
    iterator: null,
    startedAt: Date.now(),
    content: '',
    reasoning: '',
    usage: { prompt_tokens: 0, completion_tokens: 0 },
    toolCall: null,
    toolCallCount: 0,
    timer: null,
    ...extra
  };
}

const actxFor = (res, over = {}) => buildRequestContext({ key: KEY, res, isAborted: () => false, protocol: 'openai', ...over });

// ---------- F-fix1：A 路径 wedge 文案诚实化 ----------

test('F1: A 路径中途停滞（无自愈素材）→ 文案不含「已自动换后端」，含诚实口径，不命中 isRateLimited', async () => {
  const log = [];
  const handler = new OpenAiHandler('http://127.0.0.1:1');
  handler.sessions = fakeSessions(); // acquire 全抛（续跑不应新建会话）
  const res = fakeRes();
  const state = makeState(midStreamWedgedClient(log)); // 无 originalRawMessages / toolCall.resultText
  handler.pending.set(KEY, state);

  await handler._consumePending({ state, model: 'hy4-preview-f', stream: true, ctx: actxFor(res) });

  assert.ok(res.written.includes('中途停滞'), '停滞报错必须到达客户端');
  assert.ok(!res.written.includes('已自动换后端'), `不得谎称换后端重试，实得：${res.written.slice(-300)}`);
  assert.ok(res.written.includes('续跑回合不做自动重试'), '必须含诚实口径');
  assert.equal(isRateLimited(errorMessageOf(res.written)), false, '文案不得命中 isRateLimited 识别词');
  assert.ok(handler.sessions._log.discardPool.some(([, p]) => p === 'pool-1'), '假死后端必须被 discardPool');
  assert.equal(handler.pending.has(KEY), false, '报错收尾必须清挂起');
});

// ---------- F-fix3：A 路径一次性续写自愈 ----------

test('F3a: A 路径停滞（有重放素材）→ 一次性换进程自愈，续写段内容到达客户端，旧池被丢弃', async () => {
  const log = [];
  const handler = new OpenAiHandler('http://127.0.0.1:1');
  handler.sessions = fakeSessions([makeSession(healthyClient(log), 'pool-2')]);
  const res = fakeRes();
  const state = makeState(midStreamWedgedClient(log), {
    content: 'partial then silence',
    originalRawMessages: [{ role: 'user', content: [{ type: 'text', text: '原始问题' }] }],
    toolCall: { reqId: 'd-1', name: 'browser', toolCallId: 't-1', resultText: 'tool result text' }
  });
  handler.pending.set(KEY, state);

  await handler._consumePending({ state, model: 'hy4-preview-f', stream: true, ctx: actxFor(res) });

  assert.equal(handler.sessions._log.acquire.length, 1, '恰好自愈一次（acquire 新会话）');
  assert.ok(handler.sessions._log.discardPool.some(([, p]) => p === 'pool-1'), '假死旧池必须被 discardPool');
  assert.ok(res.written.includes('hello from fresh backend'), '自愈段内容到达客户端（同一条流）');
  assert.ok(!res.written.includes('中途停滞'), '自愈成功不得报错');
  assert.equal(handler.pending.has(KEY), false, '自然收尾清挂起');
  assert.equal(state.wedgeResumed, true, '一次性自愈闩必须置位');
});

test('F3b: 自愈段再停滞 → 不第二次自愈（一次性闩），诚实报错', async () => {
  const log = [];
  const handler = new OpenAiHandler('http://127.0.0.1:1');
  handler.sessions = fakeSessions([makeSession(midStreamWedgedClient(log), 'pool-2')]);
  const res = fakeRes();
  const state = makeState(midStreamWedgedClient(log), {
    content: 'partial then silence',
    originalRawMessages: [{ role: 'user', content: [{ type: 'text', text: '原始问题' }] }],
    toolCall: { reqId: 'd-1', name: 'browser', toolCallId: 't-1', resultText: 'tool result text' }
  });
  handler.pending.set(KEY, state);

  await handler._consumePending({ state, model: 'hy4-preview-f', stream: true, ctx: actxFor(res) });

  assert.equal(handler.sessions._log.acquire.length, 1, '不得第二次自愈');
  assert.ok(res.written.includes('中途停滞'), '二次停滞必须报错');
  assert.ok(!res.written.includes('已自动换后端'), '文案不得谎称换后端重试');
  assert.ok(handler.sessions._log.discardPool.some(([, p]) => p === 'pool-2'), '自愈段的假死池也必须被丢弃');
  assert.equal(handler.pending.has(KEY), false, '报错收尾清挂起');
});

test('F3c: 自愈 acquire 失败 → 诚实报错，无未捕获异常', async () => {
  const log = [];
  const handler = new OpenAiHandler('http://127.0.0.1:1');
  const failing = fakeSessions();
  failing.acquire = async () => { throw new Error('pool exhausted'); };
  handler.sessions = failing;
  const res = fakeRes();
  const state = makeState(midStreamWedgedClient(log), {
    content: 'partial then silence',
    originalRawMessages: [{ role: 'user', content: [{ type: 'text', text: '原始问题' }] }],
    toolCall: { reqId: 'd-1', name: 'browser', toolCallId: 't-1', resultText: 'tool result text' }
  });
  handler.pending.set(KEY, state);

  await handler._consumePending({ state, model: 'hy4-preview-f', stream: true, ctx: actxFor(res) });

  assert.ok(res.written.includes('中途停滞'), 'acquire 失败必须报错收尾');
  assert.ok(!res.written.includes('已自动换后端'), '文案不得谎称换后端重试');
  assert.equal(handler.pending.has(KEY), false, '报错收尾清挂起');
});

test('F3d: _continuePending 回传工具结果时把 resultText 存入挂起态（自愈重放素材）', async () => {
  const log = [];
  const handler = new OpenAiHandler('http://127.0.0.1:1');
  handler.sessions = fakeSessions();
  const res = fakeRes();
  const state = makeState(healthyClient(log), {
    toolCall: { reqId: 'd-1', name: 'browser', toolCallId: 't-1' }
  });
  handler.pending.set(KEY, state);
  const messages = [
    { role: 'user', content: 'q' },
    { role: 'tool', tool_call_id: 't-1', content: 'the tool result' }
  ];
  await handler._continuePending(KEY, messages, 'hy4-preview-f', false, res);
  assert.equal(state.toolCall?.resultText, 'the tool result', 'resultText 必须入挂起态供自愈重放');
});

// ---------- F-fix2：送达确认窗满窗 → 提前楔形信号 ----------

test('F2a: ledger confirming 满窗 → onConfirmExpired 恰好回调一次（含 id/method），error 兜底照旧', async () => {
  const expired = [];
  const sent = [];
  const ledger = createInboundLedger({
    sendError: async (id, code, message) => { sent.push({ id, code, message }); },
    getTimeoutMs: () => 40,
    onConfirmExpired: (info) => expired.push(info)
  });
  const perm = { id: 'p-9', method: 'session/request_permission' };
  ledger.registerInbound(perm);
  assert.equal(ledger.markInboundSent(perm), true, '批准发出转确认窗');
  await sleep(120);
  assert.deepEqual(expired, [{ id: 'p-9', method: 'session/request_permission' }], '满窗必须通知楔形信号');
  assert.equal(sent.length, 1, 'error 兜底语义保留');
  assert.equal(ledger.markInboundSent(perm), false, '兜底后条目出表（幂等）');
});

test('F2b: awaiting 满窗不触发 onConfirmExpired（信号只属于确认窗）', async () => {
  const expired = [];
  const ledger = createInboundLedger({
    sendError: async () => {},
    getTimeoutMs: () => 40,
    onConfirmExpired: (info) => expired.push(info)
  });
  ledger.registerInbound({ id: 'd-1', method: '_codebuddy.ai/delegateTool' });
  await sleep(120);
  assert.equal(expired.length, 0, 'awaiting 兜底不冒充楔形信号');
});

test('F2c: client.onDeliveryExpired 订阅在确认窗满窗时触发，退订后不再触发', async () => {
  const client = new AcpClient('http://127.0.0.1:1');
  client.delegateReplyTimeoutMs = 40;
  client._post = async (_path, body) => { JSON.parse(body); return {}; };
  const seen = [];
  const off = client.onDeliveryExpired((info) => seen.push(info));
  const perm = { id: 'p-1', method: 'session/request_permission' };
  client._registerInbound(perm);
  client.markInboundSent(perm);
  await sleep(120);
  assert.deepEqual(seen, [{ id: 'p-1', method: 'session/request_permission' }], '满窗必须触达订阅者');
  off();
  client._registerInbound({ id: 'p-2', method: 'session/request_permission' });
  client.markInboundSent({ id: 'p-2', method: 'session/request_permission' });
  await sleep(120);
  assert.equal(seen.length, 1, '退订后不得再触发');
});

test('F2d: driver 收到满窗信号 → 提前触发 onTimeout（停滞语义），正常收尾后信号失联', async () => {
  const seen = [];
  const client = {
    onDeliveryExpired(fn) { seen.push(fn); return () => { const i = seen.indexOf(fn); if (i >= 0) seen.splice(i, 1); }; },
    clearInboundWindows: () => {},
    touchInbound: () => {}
  };
  const timeouts = [];
  const driver = new StreamDriver({
    iterator: { next: () => new Promise(() => {}), return: async () => {} }, // 永不产出
    client,
    sink: { onTimeout: (reason) => timeouts.push(reason) },
    idleTimeoutMs: 30,
    softTimeoutMs: 5_000,
    firstTokenTimeoutMs: 0,    // 禁用首 token 守卫：只有满窗信号能触发
    stallTimeoutMs: 0          // 禁用停滞守卫：只有满窗信号能触发
  });
  driver._gotOutput = true; // 已有输出 → 信号按 mid-stream 语义触发
  driver._lastOutputAt = Date.now();
  const runP = driver.run();
  await sleep(60);
  assert.equal(seen.length, 1, 'run 期间必须订阅满窗信号');
  seen[0]({ id: 'p-1', method: 'session/request_permission' });
  const reason = await Promise.race([runP, sleep(500).then(() => 'TIMEOUT')]);
  assert.deepEqual(timeouts, ['mid-stream'], '满窗信号必须以停滞语义触发 onTimeout');
  assert.notEqual(reason, 'TIMEOUT', 'run 必须在信号触发后返回');
});

test('F2e: run 自然结束后退订满窗信号（防活过请求的监听器）', async () => {
  let registry = [];
  const client = {
    onDeliveryExpired(fn) { registry.push(fn); return () => { registry = registry.filter((f) => f !== fn); }; },
    clearInboundWindows: () => {},
    touchInbound: () => {}
  };
  const driver = new StreamDriver({
    iterator: (async function* () { yield messageChunk('hi'); yield { jsonrpc: '2.0', id: 'p-1', result: {} }; })(),
    client,
    sink: { onDelta: () => {}, onDone: () => 'done' },
    idleTimeoutMs: 30,
    softTimeoutMs: 5_000,
    firstTokenTimeoutMs: 0,
    stallTimeoutMs: 0
  });
  await driver.run();
  assert.equal(registry.length, 0, 'run 结束必须退订');
});

test('F2f: 信号订阅者抛异常 → 不悬挂、error 兜底照常（fire-and-forget 边界）', async () => {
  const sent = [];
  const ledger = createInboundLedger({
    sendError: async (id, code, message) => { sent.push({ id, message }); },
    getTimeoutMs: () => 40,
    onConfirmExpired: () => { throw new Error('listener exploded'); }
  });
  const perm = { id: 'p-7', method: 'session/request_permission' };
  ledger.registerInbound(perm);
  ledger.markInboundSent(perm);
  await sleep(120);
  assert.equal(sent.length, 1, '订阅者抛错不得吞掉兜底');
});

test('F2g: 连接销毁（_clearInbound）清空满窗订阅（监听器不活过 destroy）', async () => {
  const client = new AcpClient('http://127.0.0.1:1');
  client.delegateReplyTimeoutMs = 40;
  client._post = async () => ({});
  const seen = [];
  client.onDeliveryExpired((info) => seen.push(info));
  client._clearInbound();
  const perm = { id: 'p-3', method: 'session/request_permission' };
  client._registerInbound(perm);
  client.markInboundSent(perm);
  await sleep(120);
  assert.equal(seen.length, 0, 'destroy 后订阅必须已清空');
});

test('F3e: 自愈段 usage 事件走合并语义（首段 usage 不被覆盖）', async () => {
  const log = [];
  const handler = new OpenAiHandler('http://127.0.0.1:1');
  // 自愈后端：产出一段内容 + usage + 正常结束
  const usageClient = {
    defaultModel: 'auto',
    cancelPrompt: async () => {},
    setModel: async () => {},
    destroy: async () => {},
    hasInflightPrompt: () => false,
    sendPrompt: () => ({
      [Symbol.asyncIterator]: () => (async function* () {
        yield messageChunk('resumed tail');
        yield {
          jsonrpc: '2.0', method: 'session/update',
          params: { update: { sessionUpdate: 'usage_update', _meta: { usage: { prompt_tokens: 100, completion_tokens: 50 } } } }
        };
        yield { jsonrpc: '2.0', id: 'p-1', result: { stopReason: 'end_turn' } };
      })()
    })
  };
  handler.sessions = fakeSessions([makeSession(usageClient, 'pool-2')]);
  const res = fakeRes();
  const state = makeState(midStreamWedgedClient(log), {
    content: 'partial then silence',
    usage: { prompt_tokens: 30, completion_tokens: 20 },
    originalRawMessages: [{ role: 'user', content: [{ type: 'text', text: '原始问题' }] }],
    toolCall: { reqId: 'd-1', name: 'browser', toolCallId: 't-1', resultText: 'tool result text' }
  });
  handler.pending.set(KEY, state);

  await handler._consumePending({ state, model: 'hy4-preview-f', stream: true, ctx: actxFor(res) });

  assert.equal(state.usage.prompt_tokens, 130, 'prompt_tokens 必须首段+自愈段合并（30+100）');
  assert.equal(state.usage.completion_tokens, 70, 'completion_tokens 必须合并（20+50）');
});

test('F3f: 自愈失败的两档措辞——已自愈路径报「已尝试换进程自愈」，仍不命中 isRateLimited', async () => {
  const log = [];
  const handler = new OpenAiHandler('http://127.0.0.1:1');
  handler.sessions = fakeSessions([makeSession(midStreamWedgedClient(log), 'pool-2')]);
  const res = fakeRes();
  const state = makeState(midStreamWedgedClient(log), {
    content: 'partial then silence',
    originalRawMessages: [{ role: 'user', content: [{ type: 'text', text: '原始问题' }] }],
    toolCall: { reqId: 'd-1', name: 'browser', toolCallId: 't-1', resultText: 'tool result text' }
  });
  handler.pending.set(KEY, state);

  await handler._consumePending({ state, model: 'hy4-preview-f', stream: true, ctx: actxFor(res) });

  assert.ok(res.written.includes('已尝试换进程自愈 1 次仍失败'), `自愈失败必须如实报告，实得：${res.written.slice(-300)}`);
  assert.ok(!res.written.includes('已自动换后端'), '不得复用 B 路径的失实口径');
  assert.equal(isRateLimited(errorMessageOf(res.written)), false, '文案不得命中 isRateLimited 识别词');
  assert.equal(state.wedgeReason, 'mid-stream-failed', '自愈失败必须升格 wedgeReason（JSONL 检索面）');
});

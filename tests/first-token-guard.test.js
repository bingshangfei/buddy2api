/**
 * 首 token 守卫 + 假死后端回收自愈 单测（node:test，零依赖）。
 *
 * 本文件必须在 import 被测模块**之前**设置 FIRST_TOKEN_TIMEOUT_MS（stream-driver
 * 在模块加载时读取 env），因此使用动态 import。
 *
 * 覆盖（对应 prd.md AC-1~AC-5）：
 * - 假死错误消息不命中 isRateLimited（防止被误当频控退避 17.5 分钟）
 * - _prepareModelFallback 对假死按后端类错误处置：同模型换新后端、仅未输出时重试一次
 * - 端到端：首次假死 → discardPool + 同模型自愈重试一次 → 客户端拿到正常响应
 * - 端到端：二次假死 → 不再第三次重试，客户端收到明确错误
 * - 分段耗时汇总日志（req done … acquireMs/firstOutputMs/totalMs）
 */

process.env.FIRST_TOKEN_TIMEOUT_MS = '40';
process.env.STREAM_STALL_TIMEOUT_MS = '40';

const { OpenAiHandler, buildRequestContext } = await import('../src/openai-handler.js');
const { isRateLimited } = await import('../src/queue-policy.js');
import assert from 'node:assert/strict';
import { test } from 'node:test';

const KEY = 'local';

// request-context（批C）：key/isAborted/clientModel/protocol/thinkingEnabled 等经 ctx 携带
const rctx = (over = {}) => buildRequestContext({ key: KEY, isAborted: () => false, ...over });

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

/** 假死客户端：sendPrompt 后事件流永不产出 */
function wedgedClient(log) {
  return {
    defaultModel: 'auto',
    cancelPrompt: async (sid) => { log.push(['cancel', sid]); },
    setModel: async () => {},
    destroy: async () => {},
    hasInflightPrompt: () => false,
    sendPrompt: () => ({
      [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) })
    })
  };
}

/** 中途停滞假死客户端：先产出一段内容再永久静默（800ms 兜底 done 防测试挂死） */
function midStreamWedgedClient(log) {
  return {
    defaultModel: 'auto',
    cancelPrompt: async (sid) => { log.push(['cancel', sid]); },
    setModel: async () => {},
    destroy: async () => {},
    hasInflightPrompt: () => false,
    sendPrompt: () => ({
      [Symbol.asyncIterator]: () => {
        let first = true;
        return {
          next: () => new Promise((resolve) => {
            if (first) {
              first = false;
              setTimeout(() => resolve({ value: messageChunk('partial then silence'), done: false }), 1);
            } else {
              setTimeout(() => resolve({ value: undefined, done: true }), 800);
            }
          })
        };
      }
    })
  };
}

/** 健康客户端：产出一段内容后正常结束 */
function healthyClient(log) {
  return {
    defaultModel: 'auto',
    cancelPrompt: async (sid) => { log.push(['cancel', sid]); },
    setModel: async () => {},
    destroy: async () => {},
    hasInflightPrompt: () => false,
    sendPrompt: () => ({
      [Symbol.asyncIterator]: () => (async function* () {
        yield messageChunk('hello from fresh backend');
        yield { jsonrpc: '2.0', id: 'p-1', result: { stopReason: 'end_turn' } };
      })()
    })
  };
}

/** 健康且带推理的客户端：思考 + 正文 + 正常结束（验自愈重试后 thinking 决策是否沿用） */
function reasoningHealthyClient(log) {
  return {
    defaultModel: 'auto',
    cancelPrompt: async (sid) => { log.push(['cancel', sid]); },
    setModel: async () => {},
    destroy: async () => {},
    hasInflightPrompt: () => false,
    sendPrompt: () => ({
      [Symbol.asyncIterator]: () => (async function* () {
        yield {
          method: 'session/update',
          params: { update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: '重试后的推理' } } }
        };
        yield messageChunk('hello from fresh backend');
        yield { jsonrpc: '2.0', id: 'p-1', result: { stopReason: 'end_turn' } };
      })()
    })
  };
}

/** sessions 桩：acquire 按预设次序返回会话；discard/invalidate/release/health 全记录 */
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

test('假死错误消息不命中 isRateLimited（否则会被误当频控退避重试）', async () => {
  const nonFinal = new Error('WorkBuddy 首 token 超时（120s 零输出，疑似后端假死，已回收该后端）');
  assert.equal(isRateLimited(nonFinal.message), false);
  // final 变体（二次假死交付客户端的文案）同样不得命中——曾因「请稍后」踩坑
  const final = new Error(
    'WorkBuddy 首 token 超时（120s 零输出，疑似后端假死，已回收该后端）；已自动换后端重试 1 次仍失败，可调大 FIRST_TOKEN_TIMEOUT_MS 后让客户端重试。'
  );
  assert.equal(isRateLimited(final.message), false);
});

test('_prepareModelFallback：假死按后端类错误处置（同模型换新后端）', async () => {
  const handler = new OpenAiHandler('http://127.0.0.1:1');
  const log = [];
  handler.sessions = fakeSessions([makeSession(wedgedClient(log), 'pool-new')]);
  const err = new Error('WorkBuddy 首 token 超时（40s 零输出，疑似后端假死，已回收该后端）');
  err.name = 'FirstTokenTimeoutError';
  const outcome = { modelFallbackUsed: false }; // 请求级盒（批4 迁移：标记挂 outcome 不挂 res）
  const fallback = await handler._prepareModelFallback(
    { content: '', reasoning: '', accountId: 'acc-1' }, 'hy4-preview-f', err, outcome, KEY
  );
  assert.ok(fallback, '假死应触发自愈重试');
  assert.equal(fallback.model, 'hy4-preview-f', '假死与模型无关：必须同模型换新后端');
  assert.equal(outcome.modelFallbackUsed, true, '每请求只自愈一次');
});

test('_prepareModelFallback：换新会话必须重注册委托工具（按 sessionId 注册，不注册则重试段调不到客户端工具）', async () => {
  const log = [];
  const calls = [];
  const retryClient = healthyClient(log);
  retryClient.delegateTools = async (sid, tools) => { calls.push([sid, tools]); };
  const handler = new OpenAiHandler('http://127.0.0.1:1');
  handler.sessions = fakeSessions([makeSession(retryClient, 'pool-2')]);
  const err = new Error('WorkBuddy 首 token 超时（40s 零输出，疑似后端假死，已回收该后端）');
  err.name = 'FirstTokenTimeoutError';
  const tools = [{ name: 'read_file', description: 'x', input_schema: {} }];

  const fallback = await handler._prepareModelFallback(
    { content: '', reasoning: '', accountId: 'acc-1', stream: true, tools }, 'hy4-preview-f', err, {}, KEY
  );

  assert.ok(fallback, '前置：假死触发换新后端重试');
  assert.equal(calls.length, 1, '重试会话必须重注册委托工具（恰好一次）');
  assert.equal(calls[0][0], 'sid-pool-2', '注册必须针对重试会话 sessionId');
  assert.deepEqual(calls[0][1], tools);
});

test('端到端（非流式）：自愈重试换新会话必须重注册委托工具（state.tools 须随 state 透传）', async () => {
  // 回归：_handleNonStreamingResponse 曾接收 tools 参数却不写入 state →
  // _prepareModelFallback 读不到 state.tools → 重试会话不重注册 delegateTools，
  // 带工具的非流式请求在首轮假死后静默退化为纯文本（无报错）。
  // 与流式孪生方法的不对称即本用例的靶子（见 first-token-guard.md:77 契约）。
  const log = [];
  const calls = [];
  const retryClient = healthyClient(log);
  retryClient.delegateTools = async (sid, tools) => { calls.push([sid, tools]); };
  const handler = new OpenAiHandler('http://127.0.0.1:1');
  handler.sessions = fakeSessions([makeSession(retryClient, 'pool-2')]);
  const res = fakeRes();
  const tools = [{ name: 'read_file', description: 'x', input_schema: {} }];

  // 首轮中途停滞：非流式此时尚未向客户端输出 → 抛错走 _prepareModelFallback 自愈
  await handler._handleNonStreamingResponse({
    session: makeSession(midStreamWedgedClient(log), 'pool-1'), prompt: [{ type: 'text', text: 'p' }],
    model: 'hy4-preview-f',
    ctx: rctx({ clientModel: 'auto', res, outcome: { completed: false }, protocol: 'openai', thinkingEnabled: true, tools })
  });

  assert.equal(handler.sessions._log.acquire.length, 1, '前置：恰好自愈重试一次');
  assert.equal(calls.length, 1, '非流式重试会话必须重注册委托工具（恰好一次）');
  assert.equal(calls[0][0], 'sid-pool-2', '注册必须针对重试会话 sessionId');
  assert.deepEqual(calls[0][1], tools);
});

test('C 回退递归：具名实参逐项锁定（S4 后漏传属性不再错位，本用例是唯一防线）', async () => {
  // 靶子：S4 把 `_handleNonStreamingResponse` 的 11 个**位置参数**改成具名对象后，
  // 递归调用漏传某个属性**不会**像位置参数那样整体错位，而是**静默取默认值**——
  // PRD §D-R4 点名的最坏后果：漏传 thinkingEnabled → 默认 `protocol !== 'anthropic'`
  // → 直接调用方**静默失去思考**；PRD §D「次风险」也预言「对象化后首形参错位可能仍显示为绿」。
  // 上一条用例只断言 `_prepareModelFallback` 的重注册，**不覆盖递归实参**（CR Skeptic 轴实测：
  // 删掉递归的 `thinkingEnabled:` / `tools:` / `protocol` 三项，全量套件仍 532/0 绿）。
  // 故此处直接 spy 递归入口收到的对象，逐项钉死映射。
  const log = [];
  const handler = new OpenAiHandler('http://127.0.0.1:1');
  const retrySession = makeSession(healthyClient(log), 'pool-2');
  handler.sessions = fakeSessions([retrySession]);
  const tools = [{ name: 'read_file', description: 'x', input_schema: {} }];

  const seen = [];
  const firstRound = handler._handleNonStreamingResponse.bind(handler);
  let n = 0;
  handler._handleNonStreamingResponse = async (opts) => {
    if (++n === 1) return firstRound(opts); // 首轮真实跑（内部触发回退）
    seen.push(opts); // 递归：只记录实参，不真跑
    return { intercepted: true };
  };

  await handler._handleNonStreamingResponse({
    session: makeSession(midStreamWedgedClient(log), 'pool-1'), prompt: [{ type: 'text', text: 'p' }],
    model: 'hy4-preview-f',
    ctx: rctx({ clientModel: 'auto', res: fakeRes(), outcome: { completed: false }, protocol: 'openai', thinkingEnabled: false, tools })
  });

  assert.equal(seen.length, 1, '前置：必须恰好发生一次回退递归');
  const a = seen[0];
  assert.equal(a.session, retrySession, '递归必须换用回退会话（换新会话）');
  assert.equal(a.model, 'hy4-preview-f', '后端类错误：同模型换新后端（模型不变）');
  assert.equal(a.ctx.protocol, 'openai', '协议必须随递归显式透传');
  // thinkingEnabled=false 与**默认值**（openai ⇒ true）相反 → 漏传必红（非恒真，同 A8 用例的构造）
  assert.equal(a.ctx.thinkingEnabled, false, 'BC-12：回退必须沿用首轮决策，不得退回形参默认值（否则静默丢思考）');
  assert.deepEqual(a.ctx.tools, tools, 'BC-8：工具必须随递归透传（换新会话须重注册委托工具）');
});

test('_prepareModelFallback：已输出内容时不自愈（防重复输出；流式才有客户端可见输出）', async () => {
  const handler = new OpenAiHandler('http://127.0.0.1:1');
  handler.sessions = fakeSessions([]);
  const err = new Error('WorkBuddy 首 token 超时（40s 零输出）');
  err.name = 'FirstTokenTimeoutError';
  const fallback = await handler._prepareModelFallback(
    { stream: true, content: 'partial', reasoning: '', accountId: null }, 'm', err, {}, KEY
  );
  assert.equal(fallback, null);
});

test('端到端：首次假死 → 回收后端 + 同模型自愈一次 → 客户端拿到正常响应', async () => {
  const log = [];
  const handler = new OpenAiHandler('http://127.0.0.1:1');
  handler.sessions = fakeSessions([
    makeSession(healthyClient(log), 'pool-2') // 自愈 acquire：健康后端
  ]);
  const res = fakeRes();
  // 直接驱动首轮流式路径：传入的 session1 假死 → onTimeout 抛 → catch 自愈换 pool-2
  await handler._handleStreamingResponse({
    session: makeSession(wedgedClient(log), 'pool-1'), prompt: [{ type: 'text', text: 'p' }],
    model: 'hy4-preview-f',
    ctx: rctx({ clientModel: 'auto', res, outcome: { completed: false } })
  });
  assert.equal(handler.sessions._log.acquire.length, 1, '恰好自愈重试一次');
  assert.ok(
    handler.sessions._log.discardPool.some(([, p]) => p === 'pool-1'),
    '假死后端必须被 discardPool 物理丢弃'
  );
  assert.ok(log.some(([op, sid]) => op === 'cancel' && sid === 'sid-pool-1'), '假死 attempt 的上游任务被取消');
  assert.ok(res.written.includes('hello from fresh backend'), '自愈后的健康后端产出到达客户端');
  assert.ok(res.writableEnded, '响应已正常收尾');
});

test('端到端：二次假死 → 不再第三次重试，客户端收到明确错误', async () => {
  const log = [];
  const handler = new OpenAiHandler('http://127.0.0.1:1');
  handler.sessions = fakeSessions([
    makeSession(wedgedClient(log), 'pool-2') // 自愈后的后端仍然假死
  ]);
  const res = fakeRes();
  await handler._handleStreamingResponse({
    session: makeSession(wedgedClient(log), 'pool-1'), prompt: [{ type: 'text', text: 'p' }],
    model: 'hy4-preview-f',
    ctx: rctx({ clientModel: 'auto', res, outcome: { completed: false } })
  });
  assert.equal(handler.sessions._log.acquire.length, 1, '只自愈一次，不得第三次重试');
  assert.ok(res.written.includes('首 token 超时'), '客户端收到明确的首 token 超时错误');
  assert.ok(res.writableEnded);
});

test('端到端：工具续跑路径假死且无工具结果素材 → 丢弃假死后端（禁止归还）+ error 事件收尾，不自愈', async () => {
  const log = [];
  const handler = new OpenAiHandler('http://127.0.0.1:1');
  handler.sessions = fakeSessions([makeSession(wedgedClient(log), 'pool-x')]);
  const res = fakeRes();
  const baseState = {
    key: KEY, client: wedgedClient(log), sessionId: 'sid-pool-x', clientModel: 'auto',
    poolId: 'pool-x', accountId: 'acc-1', prompt: [], iterator: null,
    startedAt: Date.now(), content: '', reasoning: '',
    usage: { prompt_tokens: 0, completion_tokens: 0 },
    toolCall: null, toolCallCount: 0, timer: null
  };
  handler.pending.set(KEY, baseState);
  await handler._consumePending({ state: baseState, model: 'hy4-preview-f', stream: true, ctx: rctx({ res }) });
  assert.ok(handler.sessions._log.discardPool.some(([, p]) => p === 'pool-x'), '假死后端必须被物理丢弃');
  assert.equal(handler.sessions._log.release.length, 0, '禁止把假死后端 release 归还空闲池');
  assert.ok(!handler.pending.has(KEY), '挂起表已清理');
  assert.ok(res.written.includes('首 token 超时'), '客户端收到明确错误');
  assert.ok(res.writableEnded, '流已收尾');
});

test('分段耗时汇总日志：req done 行包含 acquireMs / firstOutputMs / totalMs', async () => {
  const log = [];
  const handler = new OpenAiHandler('http://127.0.0.1:1');
  handler.sessions = fakeSessions([makeSession(healthyClient(log), 'pool-ok')]);
  const res = fakeRes();
  const origLog = console.log;
  const lines = [];
  console.log = (...a) => { lines.push(a.join(' ')); };
  try {
    await handler.handleChatCompletions({
      model: 'hy4-preview-f', stream: true,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]
    }, res);
  } finally {
    console.log = origLog;
  }
  const summary = lines.find((l) => l.includes('req done key=default'));
  assert.ok(summary, '必须输出 req done 汇总行');
  assert.match(summary, /acquireMs=\d+/);
  assert.match(summary, /firstOutputMs=\d+ms/);
  assert.match(summary, /totalMs=\d+ms/);
  assert.match(summary, /status=completed/);
});

// ===== 中途停滞守卫（bugfix-20260916-mid-stream-stall-guard）=====

test('中途停滞错误消息不命中 isRateLimited（否则会被误当频控退避重试）', async () => {
  const nonFinal = 'WorkBuddy 响应中途停滞（180s 无输出，疑似后端假死，已回收该后端）';
  assert.equal(isRateLimited(nonFinal), false);
  const final = 'WorkBuddy 响应中途停滞（180s 无输出，疑似后端假死，已回收该后端）；已自动换后端重试 1 次仍失败，可调大 STREAM_STALL_TIMEOUT_MS 后让客户端重试。';
  assert.equal(isRateLimited(final), false);
});

test('端到端（流式）：中途停滞（首次）→ 续写式自愈，客户端不断连、无重复内容', async () => {
  // 行为变更（tdd-20260918-delegate-deadwait-fix）：原「流式已输出 → 不自愈报错」
  // 改为「续写式自愈一次」——已流出内容作为半成品重放，续写段增量写回同一条流。
  const log = [];
  const handler = new OpenAiHandler('http://127.0.0.1:1');
  handler.sessions = fakeSessions([makeSession(healthyClient(log), 'pool-2')]);
  const res = fakeRes();
  await handler._handleStreamingResponse({
    session: makeSession(midStreamWedgedClient(log), 'pool-1'), prompt: [{ type: 'text', text: 'p' }],
    model: 'hy4-preview-f',
    ctx: rctx({ clientModel: 'auto', res, outcome: { completed: false } })
  });
  assert.equal(handler.sessions._log.acquire.length, 1, '首次停滞必须续写自愈（acquire 新会话一次）');
  assert.ok(handler.sessions._log.discardPool.some(([, p]) => p === 'pool-1'), '假死后端必须被 discardPool 物理丢弃');
  assert.equal(handler.sessions._log.release.length, 0, '禁止把假死后端 release 归还空闲池');
  assert.ok(log.some(([op, sid]) => op === 'cancel' && sid === 'sid-pool-1'), '假死 attempt 的上游任务被取消');
  assert.ok(res.written.includes('partial then silence'), '已产出的部分内容保留');
  assert.ok(res.written.includes('hello from fresh backend'), '续写段内容到达客户端（同一条流）');
  assert.ok(!res.written.includes('中途停滞'), '首次停滞不得报错——客户端不应看到断流错误');
  assert.ok(res.writableEnded, '响应正常收尾');
});

test('端到端（非流式）：中途停滞 → 客户端尚无输出，同模型自愈一次 → 拿到完整干净响应', async () => {
  const log = [];
  const handler = new OpenAiHandler('http://127.0.0.1:1');
  handler.sessions = fakeSessions([
    makeSession(healthyClient(log), 'pool-2') // 自愈 acquire：健康后端
  ]);
  const res = fakeRes();
  // 非流式响应体是本方法的返回值（由 handleChatCompletions 统一写给客户端）
  const result = await handler._handleNonStreamingResponse({
    session: makeSession(midStreamWedgedClient(log), 'pool-1'), prompt: [{ type: 'text', text: 'p' }],
    model: 'hy4-preview-f',
    ctx: rctx({ clientModel: 'auto', res, outcome: { completed: false } })
  });
  assert.equal(handler.sessions._log.acquire.length, 1, '恰好自愈重试一次');
  assert.ok(handler.sessions._log.discardPool.some(([, p]) => p === 'pool-1'), '假死后端必须被物理丢弃');
  const body = JSON.stringify(result);
  assert.ok(body.includes('hello from fresh backend'), '自愈后的健康后端产出到达客户端');
  assert.ok(!body.includes('partial then silence'), '假死 attempt 的部分内容不得泄露给客户端');
});

test('端到端（非流式）：二次中途停滞 → 不再第三次重试，客户端收到明确错误', async () => {
  const log = [];
  const handler = new OpenAiHandler('http://127.0.0.1:1');
  handler.sessions = fakeSessions([
    makeSession(midStreamWedgedClient(log), 'pool-2') // 自愈后的后端仍然中途停滞
  ]);
  const res = fakeRes();
  // 非流式最终失败：handler 抛错（statusCode=504），由 handleChatCompletions 外层写 JSON 错误响应
  let thrown = null;
  try {
    await handler._handleNonStreamingResponse({
      session: makeSession(midStreamWedgedClient(log), 'pool-1'), prompt: [{ type: 'text', text: 'p' }],
      model: 'hy4-preview-f',
      ctx: rctx({ clientModel: 'auto', res, outcome: { completed: false } })
    });
  } catch (e) { thrown = e; }
  assert.ok(thrown, '最终失败必须向调用方抛错');
  assert.match(thrown.message, /中途停滞/, '客户端收到明确的中途停滞错误');
  assert.equal(thrown.statusCode, 504);
  assert.equal(handler.sessions._log.acquire.length, 1, '只自愈一次，不得第三次重试');
});

test('端到端（续跑）：中途停滞且无工具结果素材 → 丢弃假死后端（禁止归还）+ error 事件收尾，不自愈', async () => {
  const log = [];
  const handler = new OpenAiHandler('http://127.0.0.1:1');
  handler.sessions = fakeSessions([makeSession(midStreamWedgedClient(log), 'pool-x')]);
  const res = fakeRes();
  const baseState = {
    key: KEY, client: midStreamWedgedClient(log), sessionId: 'sid-pool-x', clientModel: 'auto',
    poolId: 'pool-x', accountId: 'acc-1', prompt: [], iterator: null,
    startedAt: Date.now(), content: '', reasoning: '',
    usage: { prompt_tokens: 0, completion_tokens: 0 },
    toolCall: null, toolCallCount: 0, timer: null
  };
  handler.pending.set(KEY, baseState);
  await handler._consumePending({ state: baseState, model: 'hy4-preview-f', stream: true, ctx: rctx({ res }) });
  assert.ok(handler.sessions._log.discardPool.some(([, p]) => p === 'pool-x'), '假死后端必须被物理丢弃');
  assert.equal(handler.sessions._log.release.length, 0, '禁止把假死后端 release 归还空闲池');
  assert.ok(!handler.pending.has(KEY), '挂起表已清理');
  assert.ok(res.written.includes('中途停滞'), '客户端收到明确错误');
  assert.ok(res.writableEnded, '流已收尾');
});

// ===== T15/T16：中途停滞的错误形状必须按协议分派（2026-09-17 真机故障） =====

/** 提取 SSE 的 data: 载荷（跳过心跳注释与 [DONE] 哨兵） */
function dataPayloads(written) {
  return written
    .split('\n')
    .filter((l) => l.startsWith('data: '))
    .map((l) => l.slice(6).trim())
    .filter((p) => p && p !== '[DONE]')
    .map((p) => JSON.parse(p));
}

test('T15: Anthropic 中途停滞（续写后仍停滞）→ 合法 event:error（每个载荷带顶层 type），不得写 OpenAI 形状', async () => {
  // 真机故障复刻：客户端 Anthropic SDK 报 `invalid_union` / `No matching discriminator: type`。
  // 根因：停滞分支（首轮流式路径）**无条件**写 OpenAI 形状 `{error:{…}}`，
  // 而 Anthropic 流的每个 SSE 载荷都必须带顶层 `type` 判别符（SDK 按 union 逐帧校验）。
  // 行为变更（tdd-20260918）：首次停滞走续写自愈；**二次停滞**才报错——本用例覆盖后者。
  const log = [];
  const handler = new OpenAiHandler('http://127.0.0.1:1');
  handler.sessions = fakeSessions([
    makeSession(midStreamWedgedClient(log), 'pool-2'), // 三次续写段全部停滞
    makeSession(midStreamWedgedClient(log), 'pool-3'),
    makeSession(midStreamWedgedClient(log), 'pool-4')
  ]);
  const res = fakeRes();

  await handler._handleStreamingResponse({
    session: makeSession(midStreamWedgedClient(log), 'pool-1'), prompt: [{ type: 'text', text: 'p' }],
    model: 'hy4-preview-f',
    ctx: rctx({ clientModel: 'auto', res, outcome: { completed: false }, protocol: 'anthropic' })
  });

  assert.equal(handler.sessions._log.acquire.length, 3, '前置：3 次续写全停滞（触达上限门禁后才报错）');
  for (const payload of dataPayloads(res.written)) {
    assert.equal(
      typeof payload.type, 'string',
      `Anthropic 流每个载荷必须有顶层 type 判别符，实得：${JSON.stringify(payload)}`
    );
  }
  assert.match(res.written, /^event: error$/m, '必须以 event: error 终止（C6）');
  const err = dataPayloads(res.written).find((p) => p.type === 'error');
  assert.ok(err, '必须有 type=error 的载荷');
  assert.equal(typeof err.error?.type, 'string', 'error.type 必须是字符串（SDK 必填）');
  assert.match(err.error.message, /已尝试续写 3 次仍失败/, '错误文案保留诊断信息与实际续写次数');
  assert.ok(res.written.includes('partial then silence'), '已产出的部分内容保留');
  assert.ok(res.writableEnded, '流已收尾');
  assert.ok(handler.sessions._log.discardPool.some(([, p]) => p === 'pool-1'), '假死后端仍须被丢弃');
});

test('T16: OpenAI 中途停滞（续写后仍停滞）→ 仍写 server_error 载荷 + [DONE]（形状不变）', async () => {
  const log = [];
  const handler = new OpenAiHandler('http://127.0.0.1:1');
  handler.sessions = fakeSessions([
    makeSession(midStreamWedgedClient(log), 'pool-2'),
    makeSession(midStreamWedgedClient(log), 'pool-3'),
    makeSession(midStreamWedgedClient(log), 'pool-4')
  ]);
  const res = fakeRes();

  await handler._handleStreamingResponse({
    session: makeSession(midStreamWedgedClient(log), 'pool-1'), prompt: [{ type: 'text', text: 'p' }],
    model: 'hy4-preview-f',
    ctx: rctx({ clientModel: 'auto', res, outcome: { completed: false } })
    // protocol 缺省 = 'openai'（ctx 工厂的 BC-12 协议感知默认）
  });

  assert.equal(handler.sessions._log.acquire.length, 3, '前置：3 次续写全停滞');
  assert.match(res.written, /"type":"server_error"/, 'OpenAI 客户端继续收 OpenAI 形状错误');
  assert.ok(res.written.includes('data: [DONE]'), 'OpenAI 流以 [DONE] 收尾');
  assert.ok(!/^event: /m.test(res.written), 'OpenAI 流不得出现命名事件行（那是 Anthropic wire）');
  assert.match(res.written, /中途停滞/);
  assert.ok(res.writableEnded);
});

test('A8 补强（CR 三轴共同发现）: 流式自愈重试必须沿用 thinkingEnabled，不得静默丢思考', async () => {
  // 攻击路径：Anthropic 客户端 thinking:{type:'enabled'} + 首轮零输出假死 →
  // _prepareModelFallback 放行自愈 → 重试 attempt **新建 state**。若第 12 参漏传，
  // 新 state 取默认 false，客户端显式 opt-in 却拿不到任何 thinking 块，且无告警。
  const log = [];
  const handler = new OpenAiHandler('http://127.0.0.1:1');
  handler.sessions = fakeSessions([makeSession(reasoningHealthyClient(log), 'pool-2')]);
  const res = fakeRes();

  await handler._handleStreamingResponse({
    session: makeSession(wedgedClient(log), 'pool-1'), prompt: [{ type: 'text', text: 'p' }],
    model: 'hy4-preview-f',
    // thinkingEnabled：客户端显式 opt-in（ctx 携带，随递归透传）
    ctx: rctx({ clientModel: 'claude-x', res, outcome: { completed: false }, protocol: 'anthropic', thinkingEnabled: true })
  });

  assert.equal(handler.sessions._log.acquire.length, 1, '确实发生了自愈重试（否则本用例没测到该路径）');
  assert.ok(
    handler.sessions._log.discardPool.some(([, p]) => p === 'pool-1'),
    '假死后端被丢弃（证明走的是自愈重试而非首次成功）'
  );
  assert.ok(
    res.written.includes('thinking_delta'),
    '重试 attempt 必须沿用首轮 thinking 决策——漏传会让显式 opt-in 的客户端静默拿不到思考'
  );
  const start = res.written.match(/^data: (\{"type":"content_block_start".*"content_block":\{[^}]*\}\})$/m);
  assert.ok(start && JSON.parse(start[1]).content_block.signature === '',
    '重试后的 thinking 块同样必须带 signature:""');
  assert.ok(res.written.includes('hello from fresh backend'), '自愈后的正文到达客户端');
});

/**
 * Anthropic 续跑与首轮流式的**编排层**测试（node:test，零依赖）。
 *
 * 为什么单独一份：anthropic-tool-loop.test.js 把 `_consumePending` 打桩以聚焦
 * 「pending 命中 → 回传」的判定，导致 `_consumePending` / `_handleStreamingResponse`
 * 里本次新增的 Anthropic 分支（协议随挂起条目走、msg_ 前缀、流首不发 role chunk、
 * finish/abortWithError 收尾）在真实代码上**零覆盖**——单测只验了 sink 本身，
 * 没验 handler 把它们接对了。本文件补这一段。
 *
 * 首 token 超时用例需要在 import 之前设 FIRST_TOKEN_TIMEOUT_MS（stream-driver 在
 * 模块加载时读取 env），故用动态 import。
 */
process.env.FIRST_TOKEN_TIMEOUT_MS = '150';

const { OpenAiHandler, buildRequestContext } = await import('../src/openai-handler.js');

// request-context（批C）：A 路径直调时按挂起条目构造 ctx（protocol 随条目走）
const actxFor = (res, over = {}) => buildRequestContext({ key: KEY, res, isAborted: () => false, protocol: 'anthropic', ...over });
import assert from 'node:assert/strict';
import { test } from 'node:test';

const KEY = 'resume-key';

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
    end() { this.writableEnded = true; },
    on() {},
    off() {}
  };
}

function healthyClient(log) {
  return {
    defaultModel: 'auto',
    cancelPrompt: async (sid) => { log.push(['cancel', sid]); },
    setModel: async () => {},
    destroy: async () => {},
    hasInflightPrompt: () => false,
    sendPrompt: () => ({
      [Symbol.asyncIterator]: () => (async function* () {
        yield messageChunk('续跑结果');
        yield { jsonrpc: '2.0', id: 'p-1', result: { stopReason: 'end_turn' } };
      })()
    })
  };
}

/** 推理客户端：先产出一段思考，再产出正文并正常结束（T10 用） */
function reasoningClient() {
  return {
    defaultModel: 'auto',
    cancelPrompt: async () => {},
    setModel: async () => {},
    destroy: async () => {},
    hasInflightPrompt: () => false,
    sendPrompt: () => ({
      [Symbol.asyncIterator]: () => (async function* () {
        yield {
          method: 'session/update',
          params: { update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: '续跑中的推理' } } }
        };
        yield messageChunk('续跑结果');
        yield { jsonrpc: '2.0', id: 'p-1', result: { stopReason: 'end_turn' } };
      })()
    })
  };
}

/** 假死客户端：事件流永不产出（触发 first-token 守卫） */
function wedgedClient(log) {
  return {
    defaultModel: 'auto',
    cancelPrompt: async (sid) => { log.push(['cancel', sid]); },
    setModel: async () => {},
    destroy: async () => {},
    hasInflightPrompt: () => false,
    sendPrompt: () => ({ [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }) })
  };
}

function fakeSessions() {
  const log = { discardPool: [], invalidate: [], release: [], health: [] };
  return {
    _log: log,
    async acquire() { throw new Error('续跑不应新建会话'); },
    discardPool: (k, p) => log.discardPool.push([k, p]),
    invalidate: (k, p) => log.invalidate.push([k, p]),
    release: (k, p) => log.release.push([k, p]),
    reportAccountHealth: (a, r) => log.health.push([a, r.ok]),
    getModels: () => []
  };
}

function makeHandler() {
  const handler = new OpenAiHandler('http://127.0.0.1:1');
  handler.sessions = fakeSessions();
  return handler;
}

function makeState(client, extra = {}) {
  return {
    key: KEY,
    protocol: 'anthropic',
    client,
    sessionId: 'sid-1',
    clientModel: 'claude-sonnet-4-5',
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

/** 提取 SSE 帧中的 Anthropic 事件名序列 */
function eventNames(written) {
  return [...written.matchAll(/^event: (.+)$/gm)].map(m => m[1]);
}

// ---------- 续跑：健康结束 → Anthropic C1-C5 收尾 ----------

test('续跑流式（anthropic）：走 Anthropic wire 收尾，不发 OpenAI chunk 与 [DONE]', async () => {
  const log = [];
  const handler = makeHandler();
  const res = fakeRes();
  const state = makeState(healthyClient(log));

  await handler._consumePending({ state, model: 'hy4-preview-f', stream: true, ctx: actxFor(res) });

  const names = eventNames(res.written);
  assert.equal(names[0], 'message_start', 'Anthropic 流必须以 message_start 开头');
  assert.ok(names.includes('content_block_delta'), '应发文本增量');
  assert.equal(names[names.length - 1], 'message_stop', '必须以 message_stop 收尾');
  assert.ok(res.written.includes('续跑结果'), '续跑内容到达客户端');

  assert.ok(!res.written.includes('"choices"'), '不得混入 OpenAI chunk');
  assert.ok(!res.written.includes('[DONE]'), 'Anthropic 流无 [DONE] 哨兵');
  // 流首不发 OpenAI 的 role chunk：Anthropic 的 message_start 由 sink 惰性发
  assert.ok(!/"delta":\{"role":"assistant"\}/.test(res.written), '不得发 OpenAI role chunk');
  assert.ok(res.writableEnded, '流已收尾');
});

test('续跑流式（anthropic）：消息 id 使用 msg_ 前缀', async () => {
  const log = [];
  const handler = makeHandler();
  const res = fakeRes();
  await handler._consumePending({ state: makeState(healthyClient(log)), model: 'hy4-preview-f', stream: true, ctx: actxFor(res) });

  const m = /"id":"([^"]+)"/.exec(res.written);
  assert.ok(m, 'message_start 必须带 id');
  assert.match(m[1], /^msg_/, `Anthropic 消息 id 应为 msg_ 前缀，实际 ${m[1]}`);
});

// ---------- 续跑：假死 → 必须发 event: error 并终止（C6） ----------

test('续跑流式（anthropic）：首 token 假死 → event: error 并终止流，不自愈', async () => {
  const log = [];
  const handler = makeHandler();
  const res = fakeRes();
  const state = makeState(wedgedClient(log));
  handler.pending.set(KEY, state);

  await handler._consumePending({ state, model: 'hy4-preview-f', stream: true, ctx: actxFor(res) });

  const names = eventNames(res.written);
  assert.equal(names[names.length - 1], 'error', 'Anthropic 必须以 event: error 终止（SDK 否则永久等待）');
  assert.ok(res.written.includes('首 token 超时'), '错误文案保留可诊断信息');
  assert.ok(!res.written.includes('[DONE]'), '不得发 OpenAI 的 [DONE]');
  assert.ok(res.writableEnded, '错误后必须结束响应');

  assert.ok(handler.sessions._log.discardPool.some(([, p]) => p === 'pool-1'), '假死后端物理丢弃');
  assert.equal(handler.sessions._log.release.length, 0, '禁止归还假死后端');
  assert.ok(!handler.pending.has(KEY), '挂起表已清理');
});

// ---------- 续跑：流内**非假死**错误也必须以 event: error 终止（C6/CR C-1） ----------

test('续跑流式（anthropic）：流内非假死错误 → event: error 终止，不得静默截断（C6/CR C-1）', async () => {
  // 与上一个用例的区别：错误**不是** first-token 假死（走 onTimeout），而是普通
  // 上游异常冒泡到 _consumePending 的 catch。修复前该 catch 只 throw 不
  // abortWithError → 异常冒到 index.js 的裸 res.end()（index.js:114-117），
  // 客户端收到的是「HTTP 200 + 干净截断的 SSE」：SDK 既不报错也不返回，表现为挂死。
  const log = [];
  const failing = {
    defaultModel: 'auto',
    cancelPrompt: async () => {},
    setModel: async () => {},
    destroy: async () => {},
    hasInflightPrompt: () => false,
    sendPrompt: () => ({
      [Symbol.asyncIterator]: () => (async function* () {
        yield messageChunk('续跑中途');
        throw new Error('boom during resume');
      })()
    })
  };
  const handler = makeHandler();
  const res = fakeRes();
  const state = makeState(failing);
  handler.pending.set(KEY, state);

  await assert.rejects(
    () => handler._consumePending({ state, model: 'hy4-preview-f', stream: true, ctx: actxFor(res) }),
    /boom during resume/,
    '原错误仍要冒泡（记账/健康上报依赖它）'
  );

  const names = eventNames(res.written);
  assert.equal(names[names.length - 1], 'error',
    '⚠ C6：续跑路径的流内错误必须发 event: error，否则 SDK 永久等待');
  assert.ok(res.written.includes('boom during resume'), '错误原因要传给客户端');
  assert.ok(!res.written.includes('[DONE]'), '不得发 OpenAI 的 [DONE]');
  assert.ok(!res.written.includes('"choices"'), '不得混入 OpenAI chunk');
  assert.ok(res.writableEnded, '错误后必须结束响应');
  assert.ok(!res.written.includes('message_stop'), '错误收尾不得再补一条 message_stop');
});

test('续跑流式（anthropic）零输出即出错 → 也要终止流（message_start 之后直接 error 合法）', async () => {
  const failing = {
    defaultModel: 'auto',
    cancelPrompt: async () => {},
    setModel: async () => {},
    destroy: async () => {},
    hasInflightPrompt: () => false,
    sendPrompt: () => ({
      [Symbol.asyncIterator]: () => (async function* () {
        throw new Error('immediate failure');
      })()
    })
  };
  const handler = makeHandler();
  const res = fakeRes();
  const state = makeState(failing);
  handler.pending.set(KEY, state);

  await assert.rejects(() => handler._consumePending({ state, model: 'm', stream: true, ctx: actxFor(res) }), /immediate failure/);

  assert.equal(eventNames(res.written).pop(), 'error', '零输出错误同样必须以 error 终止');
  assert.ok(res.writableEnded);
});

// ---------- 续跑 catch 段的错误分类（A 路径；与首轮回退用例 BC-7 同口径） ----------
//
// 为什么补这一条：三条消费路径的 catch 段共用**同一套**分类规则，但改动前只有首轮
// 流式路径（B）有分类断言。把 A 站点的分类结果人为钉死（恒判非后端类）整个测试套件
// 仍全绿——即 A 站的分类接线此前**无任何运行时覆盖**，正是"重构后无人察觉"的温床。

test('续跑（A 路径）catch 段：连接类 → discardPool 且不上报账号失败；非连接类 → 上报失败且不丢后端', async () => {
  const cases = [
    { msg: 'connect ECONNREFUSED 127.0.0.1:1', conn: true, why: 'ECONNREFUSED 命中后端连接类词表' },
    { msg: 'boom during resume', conn: false, why: '普通上游错误该归因到账号' }
  ];

  for (const c of cases) {
    const failing = {
      defaultModel: 'auto',
      cancelPrompt: async () => {},
      setModel: async () => {},
      destroy: async () => {},
      hasInflightPrompt: () => false,
      sendPrompt: () => ({
        [Symbol.asyncIterator]: () => (async function* () {
          yield messageChunk('续跑中途');
          throw new Error(c.msg);
        })()
      })
    };
    const handler = makeHandler();
    const res = fakeRes();
    const state = makeState(failing);
    handler.pending.set(KEY, state);

    await assert.rejects(
      () => handler._consumePending({ state, model: 'hy4-preview-f', stream: true, ctx: actxFor(res) }),
      (e) => { assert.ok(e.message.includes(c.msg), '原错误仍要冒泡（记账/健康上报依赖它）'); return true; }
    );

    const log = handler.sessions._log;
    assert.deepEqual(log.discardPool, c.conn ? [[KEY, 'pool-1']] : [],
      c.conn
        ? `连接类错误必须物理丢弃死后端（${c.why}）——归还会让客户端重试确定性落回同一死连接`
        : `非连接类错误不得丢弃后端（${c.why}）——后端是好的，问题在账号/模型`);
    assert.deepEqual(log.health, c.conn ? [] : [['acc-1', false]],
      c.conn
        ? `连接类错误**不得**上报账号失败（${c.why}）——误冷却 60s 会让后续请求全部改道，放大故障面`
        : `非连接类错误必须上报账号失败（${c.why}）`);
    assert.deepEqual(log.invalidate, [[KEY, 'pool-1']], 'invalidate 是无条件的（回收器竞态下定位失败自然 no-op）');
  }
});

test('续跑（A 路径）catch 段：首 token 假死 → 错误带 statusCode=504；普通错误不得带（反向对照）', async () => {
  // 触发面：客户端以 stream:false 回传 tool_result 续跑（stream 来自请求体，是活路径）。
  // 此时 headers 尚未发出，statusCode 会真的交付给客户端——故这条赋值不是装饰。
  const cases = [
    { name: 'FirstTokenTimeoutError', msg: '首 token 超时', expect504: true },
    { name: 'Error', msg: 'boom during resume', expect504: false }
  ];

  for (const c of cases) {
    const failing = {
      defaultModel: 'auto',
      cancelPrompt: async () => {},
      setModel: async () => {},
      destroy: async () => {},
      hasInflightPrompt: () => false,
      sendPrompt: () => ({
        [Symbol.asyncIterator]: () => (async function* () {
          const e = new Error(c.msg);
          e.name = c.name;
          throw e;
        })()
      })
    };
    const handler = makeHandler();
    const state = makeState(failing);
    handler.pending.set(KEY, state);

    await assert.rejects(
      () => handler._consumePending({ state, model: 'hy4-preview-f', stream: false, ctx: actxFor(fakeRes()) }),
      (e) => {
        if (c.expect504) {
          assert.equal(e.statusCode, 504,
            '首 token 假死对非流式续跑须交付 504 语义（假死是网关侧超时，不是请求本身错误）');
        } else {
          assert.notEqual(e.statusCode, 504,
            '普通上游错误不得借用 504——否则 5xx 语义被滥用，客户端会去重试一个必失败请求');
        }
        return true;
      }
    );
  }
});

// ---------- 重试守卫：流已开（message_start 发出）后不得重试（C1/CR I-1） ----------

test('CR I-1: state.streamEmitted 为真 → _prepareModelFallback 拒绝重试（否则发第二条 message_start）', async () => {
  const handler = makeHandler();
  // ⚠ 必须让"除 streamEmitted 外一切条件都满足重试"：有候选模型 + 可 acquire。
  // 否则重试会因为别的原因失败，本用例退化成恒真（不设防的守卫也能过）。
  handler.sessions.getModels = () => [{ id: 'm2', name: 'alt' }];
  handler.sessions.acquire = async () => ({
    sessionId: 's', client: { setModel: async () => {} }, models: [], poolId: 'p', accountId: null
  });
  // streamEmitted=true 模拟 message_start 已发出；content/reasoning 仍为空
  // （progress 只写 thinking 块、有意不累加 reasoning，老守卫看不到）
  const state = makeState(healthyClient([]), { streamEmitted: true });
  const outcome = { modelFallbackUsed: false }; // 请求级盒（批4 迁移）

  const out = await handler._prepareModelFallback(state, 'm1', new Error('boom'), outcome, KEY);

  assert.equal(out, null, 'message_start 已发出的流不可重试（C1 只允许一条 message_start）');
  assert.ok(!outcome.modelFallbackUsed, '不得消耗唯一一次回退机会');
});

test('CR I-1 反向对照: 同一条件下仅去掉 streamEmitted → 守卫放行（证明上面拦的正是这个标志）', async () => {
  const handler = makeHandler();
  handler.sessions.getModels = () => [{ id: 'm2', name: 'alt' }];
  handler.sessions.acquire = async () => ({
    sessionId: 's', client: { setModel: async () => {} }, models: [], poolId: 'p', accountId: null
  });
  const state = makeState(healthyClient([])); // 同样的零输出，只差 streamEmitted
  const outcome = { modelFallbackUsed: false }; // 批4 迁移

  const out = await handler._prepareModelFallback(state, 'm1', new Error('boom'), outcome, KEY);

  assert.ok(out, '零输出且流未开必须仍可自愈（对照组证明上一条不是恒真）');
  assert.equal(out.model, 'm2');
});

test('CR I-1: thinkingEnabled=true 下 progress 已开流，之后出错 → 不重试、只留一条 message_start', async () => {
  // 这是 I-1 的原始场景：progress 只写 thinking_delta、有意不累加进 state.reasoning，
  // 所以 content/reasoning 两个老守卫都看不到"已有输出"，而 message_start 已经发出。
  // 迁移说明（2026-09-17 请求驱动）：不再靠环境变量触发，改为显式传 thinkingEnabled。
  const progressEvent = {
    method: 'session/update',
    params: {
      update: {
        sessionUpdate: 'session_info_update',
        _meta: { 'codebuddy.ai/progress': '正在压缩上下文', 'codebuddy.ai/agentPhase': { phase: 'compacting' } }
      }
    }
  };
  const failing = {
    defaultModel: 'auto',
    cancelPrompt: async () => {},
    setModel: async () => {},
    destroy: async () => {},
    hasInflightPrompt: () => false,
    sendPrompt: () => ({
      [Symbol.asyncIterator]: () => (async function* () {
        yield progressEvent; // 产出阶段进度 → sink 发 thinking 块（流已开）
        throw new Error('boom after progress');
      })()
    })
  };
  const handler = makeHandler();
  // ⚠ 让重试路径真的能走通（有候选模型 + 可 acquire）：否则重试因别的原因失败，
  // 用例就验不到"重试会发第二条 message_start"这个被防的风险。
  handler.sessions.getModels = () => [{ id: 'hy4-alt', name: '备选' }];
  handler.sessions.acquire = async () => ({
    sessionId: 'sid-retry', client: failing, models: [], poolId: 'pool-retry', accountId: 'acc-1'
  });
  const res = fakeRes();
  const session = {
    sessionId: 'sid-9', client: failing, models: [], poolId: 'pool-9',
    backendUrl: 'http://127.0.0.1:1', accountId: 'acc-1'
  };

  await handler._handleStreamingResponse({
    session, prompt: [{ type: 'text', text: 'p' }], model: 'hy4-preview-f',
    ctx: actxFor(res, { clientModel: 'claude-x', thinkingEnabled: true }) // thinkingEnabled
  });

  const names = eventNames(res.written);
  assert.equal(names.filter(n => n === 'message_start').length, 1,
    '⚠ 只有一条 message_start（重试会发第二条 → C1 违反，严格 SDK 解析失败）');
  assert.ok(res.written.includes('thinking_delta'),
    '前置进度确实按 thinking 块发出了（否则本用例没测到 I-1 场景）');
  assert.equal(names[names.length - 1], 'error', '仍必须以 event: error 终止');
  assert.equal(handler.sessions._log.health.filter(([, ok]) => ok === true).length, 0,
    '未发生重试，不应有成功健康上报');
});

// ---------- T10：续跑按 state 决策，不重读环境变量（I4 不变式） ----------

test('T10: 首轮决定为「关」，续跑期间 env 被改成 1 → 续跑仍不发射（不重读环境变量）', async () => {
  const prev = process.env.BUDDY2API_ANTHROPIC_THINKING;
  const handler = makeHandler();
  const state = makeState(reasoningClient(), { thinkingEnabled: false });
  process.env.BUDDY2API_ANTHROPIC_THINKING = '1'; // 跨实例漂移源：续跑期间环境变了
  try {
    const res = fakeRes();
    await handler._consumePending({ state, model: 'hy4-preview-f', stream: true, ctx: actxFor(res) });

    assert.equal(
      eventNames(res.written).filter(n => n === 'content_block_start').length, 1,
      '只有 text 块一个 content_block_start——续跑不得因 env 变化凭空多出 thinking 块'
    );
    assert.ok(!res.written.includes('thinking_delta'), '续跑必须沿用首轮决策（I4：决策只做一次）');
    assert.equal(state.reasoning, '续跑中的推理', '不发射也必须累加（静默空结果检测不误判）');
  } finally {
    if (prev === undefined) delete process.env.BUDDY2API_ANTHROPIC_THINKING;
    else process.env.BUDDY2API_ANTHROPIC_THINKING = prev;
  }
});

test('T10 反向对照: 首轮决定为「开」→ 续跑发射 thinking 块（证明上一条不是恒真）', async () => {
  const handler = makeHandler();
  const state = makeState(reasoningClient(), { thinkingEnabled: true });
  const res = fakeRes();

  await handler._consumePending({ state, model: 'hy4-preview-f', stream: true, ctx: actxFor(res) });

  assert.ok(res.written.includes('thinking_delta'), '对照组：决策为开时续跑必须发射');
  const starts = [...res.written.matchAll(/^event: content_block_start$/gm)];
  assert.equal(starts.length, 2, 'thinking + text 两个块');
});

// ---------- 续跑：非流式 → Anthropic message 形状 ----------

test('续跑非流式（anthropic）：返回 Anthropic message（无 choices）', async () => {
  const log = [];
  const handler = makeHandler();
  const res = fakeRes();
  const state = makeState(healthyClient(log));

  const out = await handler._consumePending({ state, model: 'hy4-preview-f', stream: false, ctx: actxFor(res) });

  assert.equal(out.type, 'message', '续跑非流式必须是 Anthropic message');
  assert.equal(out.role, 'assistant');
  assert.equal(out.choices, undefined, '不得混入 OpenAI choices');
  assert.equal(res.written, '', '非流式不写 SSE 帧');
});

// ---------- 首轮流式：protocol 传递到 wire 层 ----------

test('首轮流式（anthropic）：不发 role 前置块，事件序为 Anthropic', async () => {
  const log = [];
  const handler = makeHandler();
  const res = fakeRes();
  const session = {
    sessionId: 'sid-2', client: healthyClient(log), models: [], poolId: 'pool-2',
    backendUrl: 'http://127.0.0.1:1', accountId: 'acc-1'
  };

  await handler._handleStreamingResponse({
    session, prompt: [{ type: 'text', text: 'p' }], model: 'hy4-preview-f',
    ctx: actxFor(res, { clientModel: 'claude-sonnet-4-5', outcome: { completed: false } })
  });

  const names = eventNames(res.written);
  assert.equal(names[0], 'message_start', '首轮流式以 message_start 开头');
  assert.equal(names[names.length - 1], 'message_stop', '以 message_stop 收尾');
  assert.ok(!res.written.includes('"choices"'));
  assert.ok(!/"delta":\{"role":"assistant"\}/.test(res.written), 'Anthropic 路径不得写 OpenAI role chunk');
});

test('首轮流式（anthropic）：上游错误 → event: error 终止（不是 OpenAI error chunk）', async () => {
  const log = [];
  const handler = makeHandler();
  const res = fakeRes();
  const failing = {
    defaultModel: 'auto',
    cancelPrompt: async () => {},
    setModel: async () => {},
    destroy: async () => {},
    hasInflightPrompt: () => false,
    sendPrompt: () => ({
      [Symbol.asyncIterator]: () => (async function* () {
        yield messageChunk('部分');
        throw new Error('boom upstream');
      })()
    })
  };
  const session = {
    sessionId: 'sid-3', client: failing, models: [], poolId: 'pool-3',
    backendUrl: 'http://127.0.0.1:1', accountId: 'acc-1'
  };

  await handler._handleStreamingResponse({
    session, prompt: [{ type: 'text', text: 'p' }], model: 'hy4-preview-f',
    ctx: actxFor(res, { clientModel: 'claude-x' })
  });

  const names = eventNames(res.written);
  assert.equal(names[names.length - 1], 'error', 'Anthropic 错误必须走 event: error');
  assert.ok(res.written.includes('boom upstream'), '错误原因传递给客户端');
  assert.ok(res.writableEnded);
});

/**
 * 三条消费路径的**行为契约**刻画（characterization）单测。
 *
 * 目的：为 refactor-20260920-handler-path-convergence 的「行为不变性重构」提供
 * 重构前的**行为锁**。与既有用例的分工：
 *   - 既有用例断言的是**最终结果**（写了什么 / 计数几次）；
 *   - 本文件断言**调用次序**与**逐字文案 / chunk 个数**——即重构时最容易被
 *     「测试全绿」掩盖的那批契约（PRD §D-R1/R2）。
 *
 * 观测手段：一个**共享的有序序列**（seq）。既有夹具把 acquire/discardPool/
 * invalidate/release/health 各记一个独立数组，release 与 reportAccountHealth
 * 的先后因此不可观测；本文件把它们与记账一起压进同一条序列，次序才是可断言的。
 *
 * ⚠ 已知刻画边界（如实登记，见 evidence/characterization-tests.md）：
 * soft 超时的**触发**（StreamDriver 15min 软超时）不走真实 driver——`STREAM_SOFT_TIMEOUT_MS`
 * 硬编码且 `runWithRateLimitRetry` 不透传 `softTimeoutMs`。本文件改为**捕获 sink 的
 * 处理器对象后直接调用其分支体**，刻画的正是重构要搬动的那段代码。触发时机不在本次
 * 重构范围内，故不刻画。
 *
 * env 必须在 import 被测模块前设置（stream-driver 模块加载时读），故用动态 import。
 */

// 自然完成路径不受影响；手动调分支体的用例里这两个定时器不应抢先触发。
process.env.FIRST_TOKEN_TIMEOUT_MS = '600000';
process.env.STREAM_STALL_TIMEOUT_MS = '600000';

const { OpenAiHandler, buildRequestContext } = await import('../src/openai-handler.js');

// request-context（批C）：key/isAborted/clientModel 等请求身份经 ctx 携带
const rctx = (over = {}) => buildRequestContext({ key: KEY, isAborted: () => false, ...over });
const { tokenStats, TokenStats } = await import('../src/token-stats.js');
import assert from 'node:assert/strict';
import { test } from 'node:test';

const KEY = 'local';
const MODEL = 'hy4-preview-f';

// ===== 事件构造 =====

function messageChunk(text) {
  return {
    method: 'session/update',
    params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } }
  };
}
function resultEvent() {
  return { jsonrpc: '2.0', id: 'p-1', result: { stopReason: 'end_turn' } };
}

// ===== 夹具 =====

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

/** 共享有序序列：把池操作与记账压进同一条时间线，使「谁先谁后」可断言。 */
function makeSeq() {
  const events = [];
  return {
    events,
    push(tag) { events.push(tag); },
    /** 只保留只读快照，避免断言后继续被写入 */
    snapshot() { return events.slice(); }
  };
}

/**
 * 记录池操作的 sessions 桩——**所有操作写同一个 seq**（这是与既有夹具的关键差别）。
 * 同时保留分方法视图，便于既有风格的计数断言。
 */
function sequencedSessions(sessions, seq) {
  const byOp = { acquire: [], discardPool: [], invalidate: [], release: [], health: [] };
  let n = 0;
  return {
    _byOp: byOp,
    async acquire(key) {
      const s = sessions[Math.min(n++, sessions.length - 1)];
      byOp.acquire.push([key, s.poolId]);
      seq.push(`acquire:${s.poolId}`);
      return s;
    },
    discardPool(key, poolId) { byOp.discardPool.push([key, poolId]); seq.push(`discardPool:${poolId}`); },
    invalidate(key, poolId) { byOp.invalidate.push([key, poolId]); seq.push(`invalidate:${poolId}`); },
    release(key, poolId) { byOp.release.push([key, poolId]); seq.push(`release:${poolId}`); },
    reportAccountHealth(accountId, r) { byOp.health.push([accountId, r.ok]); seq.push(`reportAccountHealth:${r.ok}`); },
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

/** 健康客户端：产出正文 + 正常结束（驱动自然 onDone） */
function healthyClient() {
  return {
    defaultModel: 'auto',
    cancelPrompt: async () => {},
    setModel: async () => {},
    destroy: async () => {},
    hasInflightPrompt: () => false,
    sendPrompt: () => ({
      [Symbol.asyncIterator]: () => (async function* () {
        yield messageChunk('hello');
        yield resultEvent();
      })()
    })
  };
}

/** 立即结束的空流客户端：让 driver 迅速收敛，不干扰手动调用的分支体 */
function emptyClient() {
  return {
    defaultModel: 'auto',
    cancelPrompt: async () => {},
    setModel: async () => {},
    destroy: async () => {},
    hasInflightPrompt: () => false,
    sendPrompt: () => ({
      [Symbol.asyncIterator]: () => ({
        next: async () => ({ value: undefined, done: true }),
        return: async () => ({ value: undefined, done: true })
      })
    })
  };
}

/** 迭代器直接抛错的客户端（驱动 catch 段） */
function errorClient(err) {
  return {
    defaultModel: 'auto',
    cancelPrompt: async () => {},
    setModel: async () => {},
    destroy: async () => {},
    hasInflightPrompt: () => false,
    sendPrompt: () => ({
      [Symbol.asyncIterator]: () => ({
        next: async () => { throw err; },
        return: async () => ({ value: undefined, done: true })
      })
    })
  };
}

/**
 * 建环境：handler + 共享 seq + 记账观测。
 * 记账观测走**公开模块 API** `tokenStats.record`（而非 handler 的私有方法名），
 * 这样重构改名不会误伤本用例。
 */
function setup({ client, poolId = 'pool-1' } = {}) {
  const seq = makeSeq();
  const handler = new OpenAiHandler('http://127.0.0.1:1');
  const sessions = sequencedSessions([makeSession(client, poolId)], seq);
  handler.sessions = sessions;

  const recorded = [];
  const realRecord = tokenStats.record;
  tokenStats.record = (entry) => {
    const rec = realRecord.call(tokenStats, entry);
    recorded.push(rec);
    seq.push(`recordUsage:${rec.status}`);
    return rec;
  };
  const restore = () => { tokenStats.record = realRecord; };

  return { handler, seq, sessions, recorded, restore };
}

/**
 * 捕获 handler 内部装配给 StreamDriver 的 sink 处理器对象。
 * 三条路径都在**同步段**里调用 `_createSink`（首次 await 之前），因此调用
 * 目标方法后立刻就能拿到处理器，无需等 driver 跑完。
 */
function captureSink(handler) {
  const orig = handler._createSink.bind(handler);
  let captured = null;
  handler._createSink = (protocol, opts) => { captured = opts; return orig(protocol, opts); };
  return () => captured;
}

/** OpenAI 收尾 chunk 中 finish_reason='stop' 的个数 */
function stopChunkCount(written) {
  return written.split('data: ').filter((s) => s.includes('"finish_reason":"stop"')).length;
}

/**
 * 取出 SSE 中所有 `choices[].delta.content` 的**解码值**（真实文本）。
 * 直接对 `res.written` 做字符串匹配会撞上 JSON 转义——真实换行在载荷里是
 * 两字符序列 `\` + `n`，拿真实换行去 includes 恒 false。解码后比对才是逐字口径。
 */
function deltaContents(written) {
  return written.split('data: ').slice(1)
    .map((s) => s.split('\n\n')[0])
    .filter((s) => s && s !== '[DONE]')
    .flatMap((s) => {
      try {
        return (JSON.parse(s).choices || [])
          .map((c) => c.delta?.content)
          .filter((c) => typeof c === 'string');
      } catch { return []; }
    });
}

/**
 * 出口事件的**种类**序列——只保留结构（谁先谁后），载荷文本不入列。
 * 用于断言收尾帧的相对次序（S3′ 的验收面；PRD §D-R5：`grep -c` 口径恒真，
 * 须逐出口核对 `[DONE]` 有无 + 内容 + 相对次序）。
 */
function sseKinds(written) {
  return written.split('data: ').slice(1)
    .map((s) => s.split('\n\n')[0])
    .filter(Boolean)
    .map((p) => {
      if (p === '[DONE]') return 'done';
      let j; try { j = JSON.parse(p); } catch { return 'other'; }
      const c = j.choices?.[0];
      if (j.usage) return 'usage';
      if (typeof c?.delta?.content === 'string') return 'content';
      if (c?.finish_reason) return 'stop';
      if (c?.delta?.role) return 'role';
      return 'other';
    });
}

function makePendingState(client, poolId, overrides = {}) {
  return {
    key: KEY, protocol: 'openai', client, sessionId: `sid-${poolId}`, clientModel: 'auto',
    poolId, accountId: 'acc-1', prompt: [{ type: 'text', text: 'p' }], iterator: null,
    startedAt: Date.now(), content: '', reasoning: '',
    usage: { prompt_tokens: 0, completion_tokens: 0 },
    toolCall: null, toolCallCount: 0, timer: null, stream: true,
    ...overrides
  };
}

// ═══════════════════════════════════════════════════════════════════
// BC-5：onDone 的记账/上报**次序**（三条路径三分）
// BC-4：释放归属
// ═══════════════════════════════════════════════════════════════════

test('BC-5-B / BC-4-B：首轮流式 onDone 次序 = 记账 → 上报；且不在路径内 release', async () => {
  const { handler, seq, sessions, restore } = setup({ client: healthyClient(), poolId: 'pool-B' });
  try {
    const res = fakeRes();
    await handler._handleStreamingResponse({
      session: makeSession(healthyClient(), 'pool-B'), prompt: [{ type: 'text', text: 'p' }],
      model: MODEL,
      ctx: rctx({ clientModel: 'auto', res, outcome: { completed: false } })
    });

    assert.equal(sessions._byOp.release.length, 0, 'BC-4-B：路径内禁止 release（由外层 finally 统一收）');
    assert.deepEqual(seq.snapshot(), ['recordUsage:completed', 'reportAccountHealth:true'],
      'BC-5-B：次序必须是 记账 → 上报');
  } finally { restore(); }
});

test('BC-5-C / BC-4-C：首轮非流式 onDone 次序 = 上报 → 记账；且不在路径内 release', async () => {
  const { handler, seq, sessions, restore } = setup({ client: healthyClient(), poolId: 'pool-C' });
  try {
    await handler._handleNonStreamingResponse({
      session: makeSession(healthyClient(), 'pool-C'), prompt: [{ type: 'text', text: 'p' }],
      model: MODEL,
      ctx: rctx({ clientModel: 'auto', res: fakeRes(), outcome: { completed: false } })
    });

    assert.equal(sessions._byOp.release.length, 0, 'BC-4-C：路径内禁止 release');
    assert.deepEqual(seq.snapshot(), ['reportAccountHealth:true', 'recordUsage:completed'],
      'BC-5-C：次序必须是 上报 → 记账（与流式路径相反）');
  } finally { restore(); }
});

test('BC-5-A / BC-4-A：续跑 onDone 次序 = 上报 → release → 记账（路径内必须自带 release）', async () => {
  const { handler, seq, sessions, restore } = setup({ client: healthyClient(), poolId: 'pool-A' });
  try {
    const state = makePendingState(healthyClient(), 'pool-A');
    handler.pending.set(KEY, state);
    await handler._consumePending({ state, model: MODEL, stream: true, ctx: rctx({ res: fakeRes() }) });

    assert.equal(sessions._byOp.release.length, 1, 'BC-4-A：续跑路径内必须 release 恰好一次（外层 finally 不覆盖续跑分派）');
    assert.deepEqual(seq.snapshot(),
      ['reportAccountHealth:true', 'release:pool-A', 'recordUsage:completed'],
      'BC-5-A：次序必须是 上报 → release → 记账（第三条不同的次序）');
  } finally { restore(); }
});

// ═══════════════════════════════════════════════════════════════════
// BC-2：soft 超时文案三条互不相同且逐字
// BC-3：OpenAI 内容 chunk 的条件性 + 个数
// ═══════════════════════════════════════════════════════════════════

test('BC-2-A / BC-3-A：续跑 soft 超时——文案无「请重试」，内容非空时发 2 个 stop chunk', async () => {
  const { handler, seq, sessions, restore } = setup({ client: emptyClient(), poolId: 'pool-A' });
  try {
    const getSink = captureSink(handler);
    const state = makePendingState(emptyClient(), 'pool-A', { content: '已有半成品' });
    handler.pending.set(KEY, state);
    const res = fakeRes();
    const run = handler._consumePending({ state, model: MODEL, stream: true, ctx: rctx({ res }) });
    const opts = getSink();
    assert.ok(opts, '同步段内必须已装配 sink');

    opts.onTimeout('soft');
    await run;

    assert.deepEqual(deltaContents(res.written), ['\n\n[WorkBuddy 响应超时]'],
      'BC-2-A：文案逐字（尾部不得带「请重试」）');
    assert.equal(stopChunkCount(res.written), 2,
      'BC-3-A：内容非空 → 内容 chunk + 恒发的空 stop chunk = 2 个 stop chunk');
    assert.ok(seq.snapshot().includes('release:pool-A'), 'BC-4-A（soft 分支）：soft 超时同样在路径内 release');
    assert.deepEqual(seq.snapshot().filter((e) => e.startsWith('recordUsage')), ['recordUsage:timeout'],
      'BC-11-A：soft 超时记的是 timeout');
  } finally { restore(); }
});

test('BC-3-A：续跑 soft 超时——内容为空时只发 1 个 stop chunk（恒发的那个空 chunk）', async () => {
  const { handler, restore } = setup({ client: emptyClient(), poolId: 'pool-A' });
  try {
    const getSink = captureSink(handler);
    const state = makePendingState(emptyClient(), 'pool-A', { content: '' });
    handler.pending.set(KEY, state);
    const res = fakeRes();
    const run = handler._consumePending({ state, model: MODEL, stream: true, ctx: rctx({ res }) });

    getSink().onTimeout('soft');
    await run;

    assert.equal(stopChunkCount(res.written), 1,
      'BC-3-A：内容为空 → 仅恒发的空 stop chunk = 1 个（条件性内容 chunk 被跳过）');
    assert.deepEqual(deltaContents(res.written), [],
      'BC-3-A：空内容路径不得混入任何内容 chunk');
  } finally { restore(); }
});

test('BC-2-B / BC-3-B：首轮流式 soft 超时——文案带「请重试」，恒 1 个 stop chunk', async () => {
  const { handler, seq, sessions, restore } = setup({ client: emptyClient(), poolId: 'pool-B' });
  try {
    const getSink = captureSink(handler);
    const res = fakeRes();
    const run = handler._handleStreamingResponse({
      session: makeSession(emptyClient(), 'pool-B'), prompt: [{ type: 'text', text: 'p' }],
      model: MODEL,
      ctx: rctx({ clientModel: 'auto', res, outcome: null })
    });
    getSink().onTimeout('soft');
    await run;

    assert.deepEqual(deltaContents(res.written), ['\n\n[WorkBuddy 响应超时，请重试]'],
      'BC-2-B：文案逐字（带「请重试」）');
    assert.equal(stopChunkCount(res.written), 1, 'BC-3-B：恒 1 个 stop chunk（无「恒发空 chunk」）');
    assert.equal(sessions._byOp.release.length, 0, 'BC-4-B：soft 超时也不得在路径内 release');
    assert.deepEqual(seq.snapshot().filter((e) => e.startsWith('recordUsage')), ['recordUsage:timeout']);
  } finally { restore(); }
});

test('BC-2-C：首轮非流式 soft 超时——抛错文案逐字（分钟数由常量推导）', async () => {
  const { handler, seq, recorded, restore } = setup({ client: emptyClient(), poolId: 'pool-C' });
  try {
    const getSink = captureSink(handler);
    const res = fakeRes();
    const run = handler._handleNonStreamingResponse({
      session: makeSession(emptyClient(), 'pool-C'), prompt: [{ type: 'text', text: 'p' }],
      model: MODEL,
      ctx: rctx({ clientModel: 'auto', res, outcome: null })
    });
    const opts = getSink();

    let thrown = null;
    try { opts.onTimeout('soft'); } catch (e) { thrown = e; }
    await run;

    assert.ok(thrown, 'BC-2-C：非流式 soft 超时向调用方抛错（不是写在响应里）');
    assert.match(thrown.message, /^WorkBuddy 响应超时（\d+分钟无事件，可能是上下文压缩过慢）$/,
      'BC-2-C：文案逐字（第三条不同的文案）');
    assert.deepEqual(seq.snapshot().filter((e) => e.startsWith('recordUsage')), ['recordUsage:timeout']);
    assert.equal(recorded[0].stream, false, 'BC-2-C：非流式记账 stream=false');
  } finally { restore(); }
});

// ═══════════════════════════════════════════════════════════════════
// 出口形状：收尾帧的**相对次序**（S3′ 的验收面；PRD §D-R5）
// ═══════════════════════════════════════════════════════════════════

test('出口形状-B（openai + usage）：tail 次序 = 内容 → 空 stop → usage → [DONE]，且必须 end', async () => {
  // 靶子：`_writeStreamFinish` 是 A/B 共用的收尾单点（S3′）。此前的验收靠临时探针，
  // 探针不随仓库常驻；本用例把「usage 不得落在 [DONE] 之后」变成可复跑的断言。
  const { handler, restore } = setup({ client: healthyClient(), poolId: 'pool-B' });
  try {
    const res = fakeRes();
    await handler._handleStreamingResponse({
      session: makeSession(healthyClient(), 'pool-B'), prompt: [{ type: 'text', text: 'p' }],
      model: MODEL,
      ctx: rctx({ clientModel: 'auto', res, includeUsage: true, outcome: { completed: false } })
    });

    const kinds = sseKinds(res.written);
    assert.deepEqual(kinds.slice(-4), ['content', 'stop', 'usage', 'done'],
      '收尾次序必须是 内容 → 空 stop → usage → [DONE]（usage 与 [DONE] 互换即违反出口形状）');
    assert.equal(res.writableEnded, true, '收尾必须 res.end()，否则客户端挂住');
  } finally { restore(); }
});

/** Anthropic 出口：事件名序列 + 文本增量拼接（载荷文本是 `event:`/`data:` 两行） */
function anthropicKinds(written) {
  const names = [];
  const texts = [];
  for (const block of written.split('\n\n')) {
    const ev = /(?:^|\n)event: (\S+)/.exec(block);
    if (ev) names.push(ev[1]);
    const m = /(?:^|\n)data: (\{.*\})/s.exec(block);
    if (m) {
      try {
        const j = JSON.parse(m[1]);
        const d = j.delta;
        if (d?.type === 'text_delta' && typeof d.text === 'string') texts.push(d.text);
      } catch { /* 非 JSON 载荷忽略 */ }
    }
  }
  return { names, texts };
}

test('出口形状-B（anthropic 自然收尾）：不得追加 notice 文本，且以 message_stop 收尾', async () => {
  // 靶子：`_writeStreamFinish` 的 anthropic 分支是 `sink.finish({ stopReason: 'end_turn' })`，
  // **不带 notice**（soft 超时才带，且那条路径刻意未收拢）。若被「顺手统一」成带 notice，
  // anthropic-sink 会把 notice 当一个 text_delta 发出去——每次正常收尾都多一段假文本。
  const { handler, restore } = setup({ client: healthyClient(), poolId: 'pool-Ba' });
  try {
    const res = fakeRes();
    await handler._handleStreamingResponse({
      session: makeSession(healthyClient(), 'pool-Ba'), prompt: [{ type: 'text', text: 'p' }],
      model: MODEL,
      ctx: rctx({ clientModel: 'auto', res, outcome: { completed: false }, protocol: 'anthropic', thinkingEnabled: false })
    });

    const { names, texts } = anthropicKinds(res.written);
    assert.equal(names.at(-1), 'message_stop', 'anthropic 自然收尾必须以 message_stop 结束');
    assert.deepEqual(texts, ['hello'],
      'anthropic 自然收尾不得追加 notice/超时文本（必须**逐字**只有上游正文）');
  } finally { restore(); }
});

// ═══════════════════════════════════════════════════════════════════
// BC-11：记账「首写胜出」闩锁（含 R2 零 token 场景）
// ═══════════════════════════════════════════════════════════════════

test('BC-11：soft 超时先记 timeout，随后 catch 的 error 被闩锁吞掉（首写胜出）', async () => {
  const { handler, recorded, restore } = setup({ client: emptyClient(), poolId: 'pool-C' });
  try {
    const getSink = captureSink(handler);
    const state = makePendingState(emptyClient(), 'pool-C', { stream: false, prompt: [{ type: 'text', text: 'p' }] });
    const run = handler._handleNonStreamingResponse({
      session: makeSession(emptyClient(), 'pool-C'), prompt: state.prompt, model: MODEL,
      ctx: rctx({ clientModel: 'auto', res: fakeRes(), outcome: null })
    });
    const opts = getSink();
    try { opts.onTimeout('soft'); } catch { /* 分支体故意抛错 */ }
    await run.catch(() => {});

    // 模拟 catch 段随后记 error（真实流程里 catch 会调 _recordUsage）
    handler._recordUsage(opts.state, MODEL, { stream: false, status: 'error', error: 'later' });

    assert.equal(recorded.length, 1, 'BC-11：一次请求只记一笔——后写必须被吞');
    assert.equal(recorded[0].status, 'timeout', 'BC-11：胜出的是 timeout，不得被翻成 error');
  } finally { restore(); }
});

test('BC-11（R2）：零 token 的 error 会置位闩锁却不写记录，后续终态一并被吞', async () => {
  const { handler, recorded, restore } = setup({ client: emptyClient() });
  try {
    const state = makePendingState(emptyClient(), 'pool-X', {
      prompt: [], content: '', reasoning: '',
      usage: { prompt_tokens: 0, completion_tokens: 0 }
    });

    handler._recordUsage(state, MODEL, { stream: true, status: 'error', error: 'boom' });

    assert.equal(state.usageRecorded, true, 'BC-11：闩锁必须已置位（置位早于零 token 早退）');
    assert.equal(recorded.length, 0, 'BC-11：零 token 的 error 不写记录');

    // 闩锁已吞掉后续所有记账——这正是"零输出楔死"场景下 JSONL 丢记录的原因
    handler._recordUsage(state, MODEL, { stream: true, status: 'completed' });
    assert.equal(recorded.length, 0, 'BC-11：后续终态被已置位的闩锁吞掉（既有行为，本次重构不得改变）');
  } finally { restore(); }
});

// ═══════════════════════════════════════════════════════════════════
// BC-7：catch 段清理次序与条件
// ═══════════════════════════════════════════════════════════════════

test('BC-7：连接类错误 → discardPool 且**不**上报账号失败；非连接类 → 上报失败 + invalidate', async () => {
  // 连接类：ECONNREFUSED 命中 _isBackendConnError
  const conn = setup({ client: errorClient(new Error('connect ECONNREFUSED 127.0.0.1:1')), poolId: 'pool-conn' });
  try {
    const res = fakeRes();
    const outcome = { modelFallbackUsed: true }; // 隔离回退重试（请求级盒，批4 迁移），直接进 catch 分类
    await handler_runStreaming(conn.handler, errorClient(new Error('connect ECONNREFUSED 127.0.0.1:1')), 'pool-conn', res, outcome);

    const snap = conn.seq.snapshot();
    // 次序契约（PRD §D-R1）：不只是**集合**，还有**相对次序**——倒序同样改变对外处置，
    // 而「只断言集合成员」会漏掉倒序（CR Skeptic 轴实测：把 recordUsage 挪到 report 之后，
    // 原 includes 式断言全绿）。故此处钉死整条序列。
    assert.deepEqual(snap, ['discardPool:pool-conn', 'recordUsage:error', 'invalidate:pool-conn'],
      'BC-7：连接类错误的清理次序 = 丢后端 → 记账 → invalidate；且**不得**上报账号失败（误冷却会放大故障面）');
  } finally { conn.restore(); }

  // 非连接类：普通上游错误
  const other = setup({ client: errorClient(new Error('upstream model failed')), poolId: 'pool-err' });
  try {
    const res = fakeRes();
    const outcome = { modelFallbackUsed: true }; // 隔离回退重试（批4 迁移）
    await handler_runStreaming(other.handler, errorClient(new Error('upstream model failed')), 'pool-err', res, outcome);

    const snap = other.seq.snapshot();
    assert.deepEqual(snap, ['recordUsage:error', 'reportAccountHealth:false', 'invalidate:pool-err'],
      'BC-7：非连接类错误的清理次序 = 记账 → 上报失败 → invalidate；且不得丢弃后端');
  } finally { other.restore(); }
});

/** 小助手：驱动首轮流式到 catch 段 */
function handler_runStreaming(handler, client, poolId, res, outcome = null) {
  return handler._handleStreamingResponse({
    session: makeSession(client, poolId), prompt: [{ type: 'text', text: 'p' }],
    model: MODEL,
    ctx: rctx({ clientModel: 'auto', res, outcome })
  }).catch(() => { /* 错误由 catch 段内消化或抛给调用方，此处只关心副作用 */ });
}

// ═══════════════════════════════════════════════════════════════════
// BC-12：thinkingEnabled 的跨形参默认值（载荷，不是便利）
// ═══════════════════════════════════════════════════════════════════

test('BC-12：thinkingEnabled 缺省时随 protocol 变化（openai→true / anthropic→false）', async () => {
  // openai 缺省
  const a = setup({ client: healthyClient(), poolId: 'pool-12a' });
  try {
    const getSink = captureSink(a.handler);
    const run = a.handler._handleStreamingResponse({
      session: makeSession(healthyClient(), 'pool-12a'), prompt: [{ type: 'text', text: 'p' }],
      model: MODEL,
      ctx: rctx({ clientModel: 'auto', res: fakeRes(), outcome: null })
    });
    assert.equal(getSink().state.thinkingEnabled, true, 'BC-12：缺省 protocol=openai 时必须为 true');
    await run.catch(() => {});
  } finally { a.restore(); }

  // anthropic 缺省
  const b = setup({ client: healthyClient(), poolId: 'pool-12b' });
  try {
    const getSink = captureSink(b.handler);
    const run = b.handler._handleStreamingResponse({
      session: makeSession(healthyClient(), 'pool-12b'), prompt: [{ type: 'text', text: 'p' }],
      model: MODEL,
      ctx: rctx({ clientModel: 'auto', res: fakeRes(), outcome: null, protocol: 'anthropic' }) // protocol='anthropic'，thinkingEnabled 故意缺省
    });
    assert.equal(getSink().state.thinkingEnabled, false, 'BC-12：缺省 protocol=anthropic 时必须为 false');
    await run.catch(() => {});
  } finally { b.restore(); }
});

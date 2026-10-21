/**
 * OpenAI 续跑 / 跨实例 / 竞态测试（node:test，零依赖）。
 *
 * 覆盖测试矩阵 F1 / F2 / R1–R4。为什么单独一份：本任务的真实故障形态是
 * **「决策在首轮做一次，之后被多条非理想路径复用」**——理想序单点开关全绿
 * 并不能证明续跑（新 sink 实例 + 同一 state）、自愈重试、env 变更这些非理想序
 * 下不漂移（教训来源：!278/!279）。I-3 不变式（决策只做一次）违反后不报错，
 * 只表现为「同一次会话两半行为不一致」。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OpenAiHandler, buildRequestContext } from '../src/openai-handler.js';
import { createSink } from '../src/sink-factory.js';
import { resolveOpenAiThinking } from '../src/openai-protocol.js';

const KEY = 'resume-key';
const ENV_VAR = 'BUDDY2API_OPENAI_REASONING_DEFAULT';

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

const thoughtChunk = (text) => ({
  method: 'session/update',
  params: { update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text } } }
});

const textChunk = (text) => ({
  method: 'session/update',
  params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } }
});

/** 续跑客户端：先思考、再正文、正常结束 */
function reasoningClient(log = []) {
  return {
    defaultModel: 'auto',
    setModel: async () => {},
    delegateTools: async () => {},
    cancelPrompt: async () => {},
    destroy: async () => {},
    hasInflightPrompt: () => false,
    respondToToolCall: async (reqId, text) => { log.push(['respond', reqId, text]); },
    sendPrompt: () => ({
      [Symbol.asyncIterator]: () => (async function* () {
        yield thoughtChunk('续跑中的思考');
        yield textChunk('续跑结果');
        yield { jsonrpc: '2.0', id: 'p-1', result: { stopReason: 'end_turn' } };
      })()
    })
  };
}

function makeHandler(client) {
  const calls = { acquire: 0, invalidate: [], release: [] };
  const handler = new OpenAiHandler('http://127.0.0.1:1');
  handler.sessionReuse = false;
  handler._armPendingTimeout = () => {};
  handler.sessions = {
    async acquire() {
      calls.acquire++;
      return { sessionId: `sess-${calls.acquire}`, client, models: [], poolId: `pool-${calls.acquire}`, accountId: 'acc-1' };
    },
    acquireExisting: () => null,
    release: (k, p) => calls.release.push([k, p]),
    invalidate: (k, p) => calls.invalidate.push([k, p]),
    discardPool() {},
    reportAccountHealth() {},
    getModels: () => [],
    hasPool: () => false
  };
  return { handler, calls };
}

/** 把首轮挂起条目放进 pending 表（模拟「上一轮已 tool_calls 挂起」） */
function suspend(handler, key, client, thinkingEnabled) {
  const state = {
    key,
    protocol: 'openai',
    echoModel: null,
    thinkingEnabled,
    stream: true,
    client,
    sessionId: `sid-${key}`,
    clientModel: 'auto',
    poolId: `pool-${key}`,
    accountId: 'acc-1',
    prompt: [{ type: 'text', text: '首轮' }],
    iterator: null,
    startedAt: Date.now(),
    content: '',
    reasoning: '',
    usage: {},
    toolCall: null,
    toolCallCount: 0,
    timer: null
  };
  handler._suspendForToolCall(state, { reqId: 'req-1', name: 'get_weather', args: { city: 'SF' }, toolCallId: 'call_1' }, {
    stream: true, ctx: { ...buildRequestContext({ key }), completionId: 'cmpl-1', created: 1, model: 'hy4-preview-f', res: fakeRes() }
  });
  return state;
}

/** 客户端回传工具结果（**故意不再带任何 thinking/reasoning 参数**，复刻最真实的非理想序） */
function toolResultRequest(extra = {}) {
  return {
    messages: [
      { role: 'user', content: '今天天气？' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'call_1', content: '晴，22 度' }
    ],
    apiKey: KEY,
    model: 'auto',
    stream: true,
    ...extra
  };
}

/**
 * 兼容 router 契约：请求对象由 route() 产出 thinkingEnabled。
 *
 * ⚠ **必须走真实决策函数**，不得手填。手填成与首轮 state 相同的值会让本文件
 * 整体变成恒真断言——那样即使实现退化成「续跑重读请求参数」，用例照绿
 * （`request.thinkingEnabled` 与 `state.thinkingEnabled` 相等时两条路径无法区分）。
 * 故此处用真实 `resolveOpenAiThinking(body)`，让请求侧的决策**与首轮 state 相反**，
 * 用例断言的才是「state 胜出」。
 */
const routed = (body) => ({ ...body, thinkingEnabled: resolveOpenAiThinking(body) });

/**
 * 用例前提自检：请求侧决策必须与首轮 state 相反。
 * 没有这条，未来把 body 改成别的内容（导致两侧重新对齐）时会静默退化为恒真断言，
 * 而这正是本文件要防的失效模式。失败信息直指"判别力"而非"行为"。
 */
function assertDisagrees(req, state, label) {
  assert.notEqual(
    req.thinkingEnabled, state.thinkingEnabled,
    `${label}: 用例前提不成立——请求侧决策(${req.thinkingEnabled})与首轮 state(${state.thinkingEnabled})相同，`
    + '无法据此证伪「续跑重读了请求参数」'
  );
}

// ============ F1：续跑时客户端参数变了 → 沿用首轮决策 ============

test('F1: 首轮显式开 → 续跑客户端改口说 none 也仍发射思考', async () => {
  const log = [];
  const { handler } = makeHandler(reasoningClient(log));
  const state = suspend(handler, KEY, reasoningClient(log), true);

  const res = fakeRes();
  const req = routed(toolResultRequest({ reasoning_effort: 'none' })); // 客户端这一轮改口说 none
  assertDisagrees(req, state, 'F1');
  assert.equal(req.thinkingEnabled, false, '前置：改口后的请求侧决策确实是「关」');
  await handler.handleChatCompletions(req, res);

  assert.ok(log.some(([op]) => op === 'respond'), '前置：工具结果确实回传给了 WorkBuddy');
  assert.match(
    res.written, /"reasoning_content":"续跑中的思考"/,
    '⚠ I-3：续跑不得重读请求参数——首轮定开就必须续跑也开（否则同一次会话两半行为不一致）'
  );
});

// ============ F2：续跑期间 env 被改 → 不重读 env ============

test('F2: 首轮决定为关 → 续跑期间 env 被改成 1，续跑仍不发射（决策随 state 走）', async () => {
  const prev = process.env[ENV_VAR];
  const log = [];
  const { handler } = makeHandler(reasoningClient(log));
  const state = suspend(handler, KEY, reasoningClient(log), false);
  process.env[ENV_VAR] = '1'; // 跨实例漂移源：续跑期间环境变了
  try {
    const res = fakeRes();
    const req = routed(toolResultRequest()); // 不表态 → 真实路由按 env='1' 判为「开」
    assertDisagrees(req, state, 'F2');
    assert.equal(req.thinkingEnabled, true, '前置：env 变更后请求侧决策已翻成「开」');
    await handler.handleChatCompletions(req, res);

    assert.ok(!res.written.includes('"reasoning_content"'), '⚠ I-3：续跑不得重读 env');
    assert.ok(res.written.includes('续跑结果'), '正文仍正常到达（证明本用例不是因别的原因恒真）');
  } finally {
    if (prev === undefined) delete process.env[ENV_VAR];
    else process.env[ENV_VAR] = prev;
  }
});

test('F2 反向对照: 首轮决定为开 → 同一 env（=0）下续跑仍发射（证明上一条拦的是决策而非 env）', async () => {
  const prev = process.env[ENV_VAR];
  const log = [];
  const { handler } = makeHandler(reasoningClient(log));
  const state = suspend(handler, KEY, reasoningClient(log), true);
  process.env[ENV_VAR] = '0';
  try {
    const res = fakeRes();
    const req = routed(toolResultRequest()); // env='0' → 真实路由判为「关」
    assertDisagrees(req, state, 'F2 反向对照');
    await handler.handleChatCompletions(req, res);
    assert.match(res.written, /"reasoning_content":"续跑中的思考"/);
  } finally {
    if (prev === undefined) delete process.env[ENV_VAR];
    else process.env[ENV_VAR] = prev;
  }
});

// ============ R1：跨实例不漂移（首轮 sink 与续跑 sink 是两个实例、同一 state） ============

test('R1: 续跑 sink 是新实例、共享同一 state → 发射行为与首轮决策一致（不漂移）', async () => {
  const prev = process.env[ENV_VAR];
  const log = [];
  const { handler } = makeHandler(reasoningClient(log));
  const state = suspend(handler, KEY, reasoningClient(log), false);
  process.env[ENV_VAR] = '1'; // 显式钉住请求侧决策，避免用例受运行环境残留 env 影响
  try {
    const res = fakeRes();
    const req = routed(toolResultRequest()); // 不表态 → 真实路由判为「开」，与首轮 state 相反
    assertDisagrees(req, state, 'R1');
    await handler.handleChatCompletions(req, res);

    assert.equal(state.reasoning, '续跑中的思考', '同一条 state 被续跑 sink 继续累加（证明复用而非新建）');
    assert.ok(!res.written.includes('"reasoning_content"'), '续跑实例必须与首轮决策同向');
  } finally {
    if (prev === undefined) delete process.env[ENV_VAR];
    else process.env[ENV_VAR] = prev;
  }
});

test('R1 反向对照: 同一 harness 改成 thinkingEnabled=true → 续跑发射（证明上面拦的正是决策值）', async () => {
  const prev = process.env[ENV_VAR];
  const log = [];
  const { handler } = makeHandler(reasoningClient(log));
  const state = suspend(handler, KEY, reasoningClient(log), true);
  process.env[ENV_VAR] = '0'; // 让请求侧判为「关」，与 state 相反
  try {
    const res = fakeRes();
    const req = routed(toolResultRequest());
    assertDisagrees(req, state, 'R1 反向对照');
    await handler.handleChatCompletions(req, res);

    assert.match(res.written, /"reasoning_content":"续跑中的思考"/);
  } finally {
    if (prev === undefined) delete process.env[ENV_VAR];
    else process.env[ENV_VAR] = prev;
  }
});

// ============ R2：陈旧 TTL 超时不得取消正在跑的续跑 ============

test('R2: resuming=true 的挂起条目 → 陈旧 TTL 回调不得清理/取消（既有契约回归保护）', () => {
  const log = [];
  const { handler, calls } = makeHandler(reasoningClient(log));
  const state = suspend(handler, KEY, reasoningClient(log), true);
  state.resuming = true; // 续跑进行中

  handler._onPendingTimeout(KEY, state);

  assert.ok(handler.pending.has(KEY), '「回传中」必须靠 resuming 显式判断——按 toolCall 判断会把正在跑的续跑取消掉');
  assert.equal(calls.invalidate.length, 0, '不得 invalidate 其他请求正在占用的连接（历史串台源）');
});

test('R2 反向对照: 同一状态下仅把 resuming 置 false → 超时正常清理（证明守卫条件就是它）', () => {
  const log = [];
  const { handler, calls } = makeHandler(reasoningClient(log));
  const state = suspend(handler, KEY, reasoningClient(log), true);
  state.resuming = false;

  handler._onPendingTimeout(KEY, state);

  assert.ok(!handler.pending.has(KEY), '无人认领的挂起必须被清理');
  assert.equal(calls.invalidate.length, 1);
});

// ============ R3：同 key 隔离 ============

test('R3: 不同 clientKey 的挂起互不影响（决策按 key 隔离）', async () => {
  const log = [];
  const { handler } = makeHandler(reasoningClient(log));
  const stateA = suspend(handler, 'key-a', reasoningClient(log), true);
  const stateB = suspend(handler, 'key-b', reasoningClient(log), false);

  const res = fakeRes();
  // 请求侧带上 none → 真实路由判为「关」，与 A 的首轮 state（开）相反：
  // 一条用例同时压两个风险（A 发射 = state 胜出 = 未被 B 污染）
  const req = { ...routed(toolResultRequest({ reasoning_effort: 'none' })), apiKey: 'key-a' };
  assertDisagrees(req, stateA, 'R3');
  await handler.handleChatCompletions(req, res);

  assert.match(res.written, /"reasoning_content":"续跑中的思考"/, 'A 的续跑按 A 的决策发射');
  assert.ok(handler.pending.has('key-b'), 'B 的挂起条目不得被 A 的续跑消费掉');
  assert.equal(stateB.thinkingEnabled, false, 'B 的决策未被 A 污染');
  assert.ok(stateA.reasoning.length > 0);
});

// ============ R4：迟到事件不污染新 sink 的 wire（回归保护：无新增写点） ============

test('R4: 首轮 sink 的迟到 progress 与续跑 sink 并存 → 决策不串、wire 结构完整', () => {
  const res = fakeRes();
  // 首轮（已被重试取代的）sink 与续跑 sink：两个实例、两份 state、同一个 res
  const oldState = { content: '', reasoning: '', usage: {}, thinkingEnabled: false };
  const newState = { content: '', reasoning: '', usage: {}, thinkingEnabled: false };
  const oldSink = createSink({ emit: 'stream', state: oldState, res, key: 'k', completionId: 'cmpl-1', created: 1, model: 'auto', onToolCall: () => null, onTimeout: () => null, onDone: () => null });
  const newSink = createSink({ emit: 'stream', state: newState, res, key: 'k', completionId: 'cmpl-2', created: 2, model: 'auto', onToolCall: () => null, onTimeout: () => null, onDone: () => null });

  oldSink.onProgress('迟到的阶段', 'late'); // 首轮 sink 迟到事件
  newSink.onReasoning('思考');

  assert.ok(!res.written.includes('"reasoning_content"'), '迟到的 progress 不得借道新 sink 的决策把思考放出去');
  const lines = res.written.split('\n').filter(Boolean);
  assert.ok(
    lines.every(l => l.startsWith('data: ') || l.startsWith(':')),
    `wire 结构必须完整（每行只能是 data 帧或注释），实际：${JSON.stringify(lines)}`
  );
  assert.equal(newState.reasoning, '思考', '新 sink 的 state 独立累加');
  assert.equal(oldState.reasoning, '', 'progress 有意不累加进 reasoning（既有设计）');
});

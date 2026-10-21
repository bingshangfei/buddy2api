/**
 * `_seedAttemptState` 的契约断言（S1″ / `refactor-plan.md` §步骤 4）。
 *
 * 断言口径（计划明文，逐条对应到用例）：
 *   1. **不锁键序**——键序在内部对象上不可观察，只断言**键集合 + 逐字段取值**。
 *   2. B / C 的差异必须**可枚举**：断言两侧键集合之差**恰好**等于已知差异集，
 *      多一个少一个都要报（这正是"两处 20 行字面量各自漂移"要防的）。
 *   3. 差异**不得藏进种子**：`stream` 必须是调用点上具名的实参（表里可读出来），
 *      B 的三件套必须写在种子之外。
 *   4. **A（`_consumePending`）必须仍是同一对象引用**——它复用 pending 表里的活条目，
 *      不是新建 state。本文件用「传入对象被就地改写」来观测。
 *
 * 观测手段：B / C 的 `outcome.state` 在**同步段**就位（首次 await 之前），
 * 因此无需驱动完整请求即可拿到真实产出的 state。
 */

process.env.FIRST_TOKEN_TIMEOUT_MS = '600000';
process.env.STREAM_STALL_TIMEOUT_MS = '600000';

const { OpenAiHandler, buildRequestContext } = await import('../src/openai-handler.js');
import assert from 'node:assert/strict';
import { test } from 'node:test';

const KEY = 'local';
const MODEL = 'hy4-preview-f';

function messageChunk(text) {
  return { method: 'session/update', params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } } };
}
function resultEvent() { return { jsonrpc: '2.0', id: 'p-1', result: { stopReason: 'end_turn' } }; }

function fakeRes() {
  return {
    writableEnded: false, headersSent: false, written: '',
    writeHead() { this.headersSent = true; return this; },
    write(chunk) { this.written += chunk; return true; },
    end(chunk) { if (chunk) this.written += chunk; this.writableEnded = true; },
    on() {}, off() {}
  };
}
function makeSession(client, poolId) {
  return { sessionId: `sid-${poolId}`, client, models: [], poolId, backendUrl: 'http://127.0.0.1:1', accountId: 'acc-1' };
}
function healthyClient() {
  return {
    defaultModel: 'auto', cancelPrompt: async () => {}, setModel: async () => {}, destroy: async () => {},
    hasInflightPrompt: () => false,
    sendPrompt: () => ({
      [Symbol.asyncIterator]: () => (async function* () { yield messageChunk('hello'); yield resultEvent(); })()
    })
  };
}
/** 只做记账、不做网络：本文件只关心同步段产出的 state 形状 */
function stubSessions(session) {
  return {
    async acquire() { return session; },
    release() {}, discardPool() {}, invalidate() {}, reportAccountHealth() {},
    getModels: () => []
  };
}
function makeHandler(session) {
  const handler = new OpenAiHandler('http://127.0.0.1:1');
  handler.sessions = stubSessions(session);
  return handler;
}

/**
 * 驱动 B / C 到 `outcome.state` 就位，返回**同步段的快照**。
 *
 * 为什么必须快照而不能等请求跑完：`outcome.state` 在首次 await 之前就位，而请求
 * 跑完后 state 上会多出运行期字段（`finalized` / `firstOutputAt` / `usageRecorded`…）。
 * 那些字段不是种子产出的，纳进键集合断言会把种子的契约与运行期写入混为一谈。
 *
 * 同一 `session` 实例供 B/C 复用，否则 `client` / `sessionId` / `poolId` 的取值
 * 天然不同，共有字段的"同值"断言会退化成恒 false。
 */
async function produce(kind, session, fields = {}) {
  const handler = makeHandler(session);
  const outcome = { completed: false };
  const args = {
    session, prompt: [{ type: 'text', text: 'p' }], model: MODEL,
    ctx: buildRequestContext({ key: KEY, clientModel: 'auto', res: fakeRes(), isAborted: () => false, outcome, ...fields }),
    ...fields
  };
  const call = kind === 'B'
    ? handler._handleStreamingResponse(args)
    : handler._handleNonStreamingResponse(args);

  const state = outcome.state;
  assert.ok(state, `${kind}：outcome.state 必须在同步段就位（首次 await 之前）`);
  const snapshot = { keys: Object.keys(state).sort(), values: { ...state }, state };

  await call.catch(() => { /* 本文件只看同步段产出的形状，不看请求结果 */ });
  return snapshot;
}

/** 两路径共有的**全部**键（种子字段 ∪ 契约要求字段）——键集合断言的基线 */
const SHARED_KEYS = [
  'key', 'protocol', 'echoModel', 'thinkingEnabled', 'stream',
  'client', 'sessionId', 'clientModel', 'poolId', 'accountId', 'prompt', 'tools',
  'iterator', 'startedAt', 'content', 'reasoning', 'usage', 'toolCall', 'toolCallCount', 'timer'
];
/** B 独有（C 无「续写自愈」）——差异集必须**恰好**是这三个 */
const B_ONLY_KEYS = ['rawMessages', 'originalRawMessages', 'continuedCount'];
/**
 * 取值必然（或天然）不相同的共有字段，分三类——混为一谈会让断言失去指向：
 *   - `CALL_SITE_ARG`：差异来自**调用点具名实参**（种子里没有它的常量）
 *   - `PER_ATTEMPT`：种子里是**同一表达式**，但按 attempt 取值，故天然不同
 *   - `RUN_WRITTEN`：种子里给了初值，但**请求在同步段就把它改写了**，快照里已不是种子值
 *     （`iterator` 由 `queue-policy` 在第一次 await 之前写入；见 `src/queue-policy.js:95`）
 */
const CALL_SITE_ARG = ['stream'];
const PER_ATTEMPT = ['startedAt'];
const RUN_WRITTEN = ['iterator'];
const EXEMPT = [...CALL_SITE_ARG, ...PER_ATTEMPT, ...RUN_WRITTEN];

test('B/C 产出的 state：共有键集合逐字相同，差异集恰好 = B 独有三件套', async () => {
  const session = makeSession(healthyClient(), 'pool-1');
  const b = await produce('B', session);
  const c = await produce('C', session);

  assert.deepEqual(c.keys, SHARED_KEYS.slice().sort(), 'C 的键集合必须恰好 = 共有集');
  assert.deepEqual(b.keys, [...SHARED_KEYS, ...B_ONLY_KEYS].sort(), 'B 的键集合必须恰好 = 共有集 + 三件套');

  const onlyB = b.keys.filter((k) => !c.keys.includes(k));
  const onlyC = c.keys.filter((k) => !b.keys.includes(k));
  assert.deepEqual(onlyB, B_ONLY_KEYS.slice().sort(),
    'B 相对 C 多出的键必须恰好是续写素材三件套——多一个（漏进种子）或少一个（忘了传）都要报');
  assert.deepEqual(onlyC, [], 'C 不得有任何 B 没有的键');
});

test('B/C 共有键的取值逐一同值，除三类已登记差异外', async () => {
  const session = makeSession(healthyClient(), 'pool-1');
  const b = (await produce('B', session)).values;
  const c = (await produce('C', session)).values;

  for (const k of SHARED_KEYS) {
    if (EXEMPT.includes(k)) continue;
    assert.deepEqual(b[k], c[k], `共有键 ${k} 在 B/C 上必须同值（差异只允许出现在 ${EXEMPT.join(' / ')}）`);
  }

  // CALL_SITE_ARG：差异来自调用点具名实参，而不是种子里的常量
  assert.equal(b.stream, true, 'B 的 stream 必须为 true（调用点实参）');
  assert.equal(c.stream, false, 'C 的 stream 必须为 false（调用点实参）');

  // PER_ATTEMPT：同表达式、按 attempt 取值
  for (const k of PER_ATTEMPT) {
    assert.equal(typeof b[k], 'number', `B.${k} 必须是数值（缺了它 token 统计的耗时列会变 NaN）`);
    assert.equal(typeof c[k], 'number', `C.${k} 必须是数值`);
    assert.ok(b[k] <= Date.now() && c[k] <= Date.now(), `${k} 必须是本次 attempt 的挂钟时间`);
  }

  // usage 必须是**独立副本**：共享引用会让一条路径的滚动合并污染另一条
  assert.notEqual(b.usage, c.usage, 'usage 不得共享同一对象引用');
  assert.ok(b.usage && typeof b.usage === 'object' && Object.keys(b.usage).length > 0, 'usage 必须已初始化');
});

test('种子的初值单点：运行期字段被强制初始化，且**不可**被调用点 fields 覆盖', async () => {
  const handler = makeHandler(makeSession(healthyClient(), 'pool-1'));

  // 种子在 fields 之后落初值 → 调用点误传也污染不了这批字段
  const seed = handler._seedAttemptState({
    key: KEY,
    iterator: 'CALLER-TRIED-TO-INJECT',
    content: 'CALLER-TRIED-TO-INJECT',
    usage: { prompt_tokens: 999 },
    toolCallCount: 999
  });

  assert.deepEqual(
    { iterator: seed.iterator, content: seed.content, reasoning: seed.reasoning,
      toolCall: seed.toolCall, toolCallCount: seed.toolCallCount, timer: seed.timer },
    { iterator: null, content: '', reasoning: '', toolCall: null, toolCallCount: 0, timer: null },
    '这些字段必须每次 attempt 从干净初值开始（脏初值 = 上一条请求的内容/工具状态串到下一条）'
  );
  assert.notDeepEqual(seed.usage, { prompt_tokens: 999 }, 'usage 必须重置为 EMPTY_USAGE 的副本');
  assert.equal(seed.key, KEY, 'fields 里的普通字段必须照常透传');
});

test('B/C 产出的 state：协议相关字段（echoModel / thinkingEnabled）随 protocol 取值', async () => {
  const cases = [
    { protocol: 'openai', echoModel: null, thinkingEnabled: true },
    { protocol: 'anthropic', echoModel: 'claude-sonnet-4-5', thinkingEnabled: false }
  ];

  for (const c of cases) {
    for (const kind of ['B', 'C']) {
      const session = makeSession(healthyClient(), 'pool-1');
      const s = (await produce(kind, session, { protocol: c.protocol, clientModel: 'claude-sonnet-4-5' })).values;
      assert.equal(s.echoModel, c.echoModel,
        `${kind}/${c.protocol}：echoModel 应回显客户端原始名（openai 下为 null）`);
      assert.equal(s.thinkingEnabled, c.thinkingEnabled,
        `${kind}/${c.protocol}：thinkingEnabled 应为 Boolean(protocol !== 'anthropic')（BC-12 的落点）`);
    }
  }
});

test('A（_consumePending）不参与种子：复用传入的活条目，产出就地累加、终态就地置位', async () => {
  const client = healthyClient();
  const handler = makeHandler(makeSession(client, 'pool-A'));
  // 刻意**只**给 pending 条目应有的字段：不带种子会初始化的那些扩展字段也照样能跑
  // （A 的 state 来自挂起条目，不经过种子）。
  const state = {
    key: KEY, protocol: 'openai', client, sessionId: 'sid-pool-A', clientModel: 'auto',
    poolId: 'pool-A', accountId: 'acc-1', prompt: [{ type: 'text', text: 'p' }], iterator: null,
    startedAt: Date.now(), content: '', reasoning: '',
    usage: { prompt_tokens: 0, completion_tokens: 0 },
    toolCall: null, toolCallCount: 0, timer: null, stream: true
  };
  handler.pending.set(KEY, state);

  await handler._consumePending({
    state, model: MODEL, stream: true,
    ctx: buildRequestContext({ key: KEY, res: fakeRes(), isAborted: () => false, protocol: 'openai' })
  });

  // 可观测面（如实登记）：`state.finalized = true` 与 content 累加都写在**传入的那个对象**上。
  // ⚠ 本用例能证伪的是「A 改为新建 state 接收产出」这一类回归（产出会落到另一个对象上，
  // 传入对象既无 finalized 也无 content）；**不能**证伪「`baseState` 被浅拷贝」——
  // 浅拷贝与同一引用在现有可观测面上不可区分。后者属结构约束，靠 CR 守护（见 behavior-diff）。
  assert.equal(state.finalized, true,
    'A 必须复用 pending 表里的同一对象（终态写在传入对象上）');
  assert.ok(state.content.includes('hello'),
    'A 必须把产出累加进传入对象——新建 state 会让续跑结果落到另一个对象上而丢失');
  assert.equal(handler.pending.has(KEY), false, 'A 收尾必须清掉 pending 条目（否则挂起表泄漏）');
});

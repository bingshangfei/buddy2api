/**
 * mid-stream 停滞续写自愈单测（node:test，零依赖）。
 *
 * 背景：停滞时部分内容已流给客户端，原实现直接报错断流（用户截图事故）。
 * 新行为：首次停滞 → discard 假死后端 → acquire 新会话 → 以
 * 「原始 messages + 已流出半成品 + 续写指令」重放 → 增量续写**同一条 SSE 流**；
 * 续写上限 3 次（continuedCount 门禁）：每次续写段停滞则再续写，第 3 次续写段停滞才报错；
 * 多次续写 prompt 一律基于 originalRawMessages + 累积 content（无指令嵌套）。
 *
 * env 必须在 import 被测模块前设置（stream-driver 模块加载时读），故用动态 import。
 * 覆盖：test-matrix C1..C11 / X1 / F1..F2。
 */

process.env.FIRST_TOKEN_TIMEOUT_MS = '40';
process.env.STREAM_STALL_TIMEOUT_MS = '40';

const { OpenAiHandler, buildRequestContext } = await import('../src/openai-handler.js');
const { isRateLimited } = await import('../src/queue-policy.js');
import assert from 'node:assert/strict';
import { test } from 'node:test';

const KEY = 'local';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function messageChunk(text) {
  return {
    method: 'session/update',
    params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } }
  };
}
function thoughtChunk(text) {
  return {
    method: 'session/update',
    params: { update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text } } }
  };
}
function usageEvent(p, c) {
  return {
    method: 'session/update',
    params: { update: { sessionUpdate: 'usage_update', _meta: { usage: { prompt_tokens: p, completion_tokens: c } } } }
  };
}
function resultEvent() {
  return { jsonrpc: '2.0', id: 'p-1', result: { stopReason: 'end_turn' } };
}
function delegateToolEvent() {
  return {
    jsonrpc: '2.0', id: 'deleg-1', method: '_codebuddy.ai/delegateTool',
    params: { sessionId: 's1', toolCallId: 'tc-1', toolId: 'read_file', input: { path: 'a.txt' } }
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

/** 首段：按序产出（thinking?/正文?/usage?）后永久静默；300ms 兜底 done 防测试挂死 */
function stalledClient(log, { firstText = 'partial then silence', usage = null, thinking = null } = {}) {
  const items = [];
  if (thinking) items.push(thoughtChunk(thinking));
  if (firstText) items.push(messageChunk(firstText));
  if (usage) items.push(usageEvent(usage[0], usage[1]));
  return {
    defaultModel: 'auto',
    cancelPrompt: async (sid) => { log.push(['cancel', sid]); },
    setModel: async () => {},
    destroy: async () => {},
    hasInflightPrompt: () => false,
    sendPrompt: () => ({
      [Symbol.asyncIterator]: () => {
        let i = 0;
        return {
          next: () => new Promise((resolve) => {
            if (i < items.length) { resolve({ value: items[i++], done: false }); return; }
            setTimeout(() => resolve({ value: undefined, done: true }), 300);
          })
        };
      }
    })
  };
}

/** 续写段：产出内容 + usage + 正常结束；记录收到的 prompt / sessionId */
function continuationClient(log, { text = 'hello from fresh backend', usage = null, record = null, thinking = null } = {}) {
  return {
    defaultModel: 'auto',
    cancelPrompt: async (sid) => { log.push(['cancel', sid]); },
    setModel: async () => {},
    destroy: async () => {},
    hasInflightPrompt: () => false,
    sendPrompt: (prompt, sessionId) => {
      record?.push({ prompt, sessionId });
      return {
        [Symbol.asyncIterator]: () => (async function* () {
          if (thinking) yield thoughtChunk(thinking);
          yield messageChunk(text);
          if (usage) yield usageEvent(usage[0], usage[1]);
          yield resultEvent();
        })()
      };
    }
  };
}

function fakeSessions(sessionsByCall) {
  const log = { acquire: [], discardPool: [], invalidate: [], release: [], health: [] };
  let n = 0;
  return {
    _log: log,
    async acquire(key, opts) {
      log.acquire.push([key, opts?.modelId]);
      if (typeof sessionsByCall === 'function') return sessionsByCall(n++, opts);
      const s = sessionsByCall[Math.min(n++, sessionsByCall.length - 1)];
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

const RAW_MESSAGES = [
  { role: 'system', content: 'be helpful' },
  { role: 'user', content: '帮我写一段代码' }
];

/** 驱动首轮流式路径（`rawMessages` 为续写重放素材；`thinkingEnabled` 为思考可见性决策。批C 后请求身份经 ctx） */
function runFirstRound(handler, session, res, { protocol = 'openai', aborted = () => false, outcome = null, prompt = [{ type: 'text', text: 'p' }], tools = null, thinkingEnabled = false } = {}) {
  return handler._handleStreamingResponse({
    session, prompt, model: 'hy4-preview-f',
    ctx: buildRequestContext({ key: KEY, res, isAborted: aborted, clientModel: 'auto', protocol, thinkingEnabled, outcome, tools }),
    rawMessages: RAW_MESSAGES
  });
}

// ===== C14：与「思考可见性」（!7）的组合面——两特性在同一条 SSE 流上相交 =====

test('C14（组合）：思考开 × 中途停滞续写 —— 续写段沿用首轮决策，两段推理都发射', async () => {
  const log = [];
  const handler = new OpenAiHandler('http://127.0.0.1:1');
  const contClient = continuationClient(log, { text: '续写段正文', thinking: '续写段推理' });
  handler.sessions = fakeSessions([makeSession(contClient, 'pool-2')]);
  const res = fakeRes();

  await runFirstRound(
    handler,
    makeSession(stalledClient(log, { firstText: '半成品', thinking: '首段推理' }), 'pool-1'),
    res,
    { thinkingEnabled: true }
  );

  const out = res.written;
  assert.equal(handler.sessions._log.acquire.length, 1, '前置：确实走了续写段');
  assert.match(out, /"reasoning_content":"首段推理"/, '首段推理必须发射');
  assert.match(out, /"reasoning_content":"续写段推理"/, '续写段推理必须发射（同一 state.thinkingEnabled 随续写透传，续写不重算）');
  assert.ok(out.includes('续写段正文'), '续写段正文到达客户端');
});

test('C14b（组合反向）：思考关 × 中途停滞续写 —— 两段推理都不得出现在 wire 上', async () => {
  const log = [];
  const handler = new OpenAiHandler('http://127.0.0.1:1');
  const contClient = continuationClient(log, { text: '续写段正文', thinking: '续写段推理' });
  handler.sessions = fakeSessions([makeSession(contClient, 'pool-2')]);
  const res = fakeRes();

  await runFirstRound(
    handler,
    makeSession(stalledClient(log, { firstText: '半成品', thinking: '首段推理' }), 'pool-1'),
    res,
    { thinkingEnabled: false }
  );

  const out = res.written;
  assert.equal(handler.sessions._log.acquire.length, 1, '前置：确实走了续写段（反向不是靠"没续写"蒙对）');
  assert.ok(!out.includes('reasoning_content'), '关思考时 wire 上不得出现 reasoning_content');
  assert.ok(
    !out.includes('首段推理') && !out.includes('续写段推理'),
    '推理文本不得以任何形式（含注释行）泄漏到 wire'
  );
  assert.ok(out.includes('续写段正文'), '正文不受影响');
});

// ===== C1/C3/F1：主路径 =====

test('C1/C3/F1: 流式中途停滞（首次）→ 续写自愈：discard + acquire + 同流续写 + 不报错', async () => {
  const log = [];
  const handler = new OpenAiHandler('http://127.0.0.1:1');
  const contClient = continuationClient(log);
  handler.sessions = fakeSessions([makeSession(contClient, 'pool-2')]);
  const res = fakeRes();
  const outcome = { completed: false };

  await runFirstRound(handler, makeSession(stalledClient(log), 'pool-1'), res, { outcome });

  assert.equal(handler.sessions._log.acquire.length, 1, '停滞必须触发续写 acquire（恰好一次）');
  assert.ok(handler.sessions._log.discardPool.some(([, p]) => p === 'pool-1'), '假死后端必须被物理丢弃');
  assert.equal(handler.sessions._log.release.length, 0, '禁止把假死后端 release 归还空闲池');
  assert.ok(res.written.includes('partial then silence'), '首段已产出内容保留');
  assert.ok(res.written.includes('hello from fresh backend'), '续写段内容续写进同一条流');
  assert.ok(!res.written.includes('中途停滞'), '首次停滞不得报错（这正是本次要消灭的行为）');
  assert.ok(res.writableEnded, '流正常收尾');

  const state = outcome.state;
  assert.equal(state.continuedCount, 1, '续写计数已置位');
  assert.equal(state.client, contClient, 'state.client 必须指向新会话客户端（旧会话已 discard）');
  assert.equal(state.content, 'partial then silence' + 'hello from fresh backend',
    'state.content 续写累加（不清空不回退）');
  assert.equal(state.poolId, 'pool-2', 'state.poolId 必须替换为新会话（旧池已 discard）');
  assert.equal(state.sessionId, 'sid-pool-2', 'state.sessionId 必须替换为新会话');
  assert.equal(state.wedgeReason, 'mid-stream-continued', '汇总日志标明续写自愈');
});

test('C2: 续写 prompt = 原始 messages + assistant 半成品 + 续写指令', async () => {
  const log = [];
  const record = [];
  const handler = new OpenAiHandler('http://127.0.0.1:1');
  handler.sessions = fakeSessions([makeSession(continuationClient(log, { record }), 'pool-2')]);
  const res = fakeRes();

  await runFirstRound(handler, makeSession(stalledClient(log), 'pool-1'), res);

  assert.equal(record.length, 1, '续写必须发起一次新 prompt');
  const text = JSON.stringify(record[0].prompt);
  assert.ok(text.includes('partial then silence'), '半成品内容必须进入续写 prompt（作为 assistant 前文）');
  assert.ok(text.includes('帮我写一段代码'), '原始用户消息必须重放（新后端无上下文）');
  assert.ok(/continue|resume/i.test(text), '必须携带续写指令（要求模型接着写）');
  assert.ok(/not repeat|do not repeat|without repeating/i.test(text), '续写指令必须含「不要重复已有内容」约束');
});

test('C2b: content 为空（仅 thinking）时续写 prompt 省略 assistant 半成品段', async () => {
  const log = [];
  const record = [];
  const handler = new OpenAiHandler('http://127.0.0.1:1');
  handler.sessions = fakeSessions([makeSession(continuationClient(log, { record }), 'pool-2')]);
  const res = fakeRes();

  // 只有 thinking 输出（content 仍为空）后停滞
  await runFirstRound(handler, makeSession(stalledClient(log, { firstText: '', thinking: '思考中…' }), 'pool-1'), res);

  assert.equal(record.length, 1, '仍然触发续写');
  const text = JSON.stringify(record[0].prompt);
  assert.ok(!text.includes('[Assistant previous reply]'), '无正文半成品时不得伪造 assistant 段');
});

test('C4: 续写流正常结束 → usage 两段相加', async () => {
  const log = [];
  const handler = new OpenAiHandler('http://127.0.0.1:1');
  handler.sessions = fakeSessions([
    makeSession(continuationClient(log, { usage: [20, 7] }), 'pool-2')
  ]);
  const res = fakeRes();
  const outcome = { completed: false };

  await runFirstRound(handler, makeSession(stalledClient(log, { usage: [10, 5] }), 'pool-1'), res, { outcome });

  assert.equal(outcome.state.usage.prompt_tokens, 30, 'usage = 首段 10 + 续写段 20');
  assert.equal(outcome.state.usage.completion_tokens, 12, 'usage = 首段 5 + 续写段 7');
});

test('C9: OpenAI 协议续写 → role chunk 恰一次、delta 可拼接', async () => {
  const log = [];
  const handler = new OpenAiHandler('http://127.0.0.1:1');
  handler.sessions = fakeSessions([makeSession(continuationClient(log), 'pool-2')]);
  const res = fakeRes();

  await runFirstRound(handler, makeSession(stalledClient(log), 'pool-1'), res);

  assert.equal(handler.sessions._log.acquire.length, 1, '前置：必须发生续写（否则本用例测不到目标路径）');
  const roleCount = (res.written.match(/"role":"assistant"/g) || []).length;
  assert.equal(roleCount, 1, 'role chunk 必须恰好一次（续写不得重发）');
  assert.ok(res.written.includes('data: [DONE]'), 'OpenAI 流以 [DONE] 收尾');
});

test('C5b: 第 2 次续写的 prompt 无指令嵌套（= 原始 messages + 累积 content + 指令×1）', async () => {
  const log = [];
  const records = [];
  const handler = new OpenAiHandler('http://127.0.0.1:1');
  // 续写1停滞、续写2成功；两段续写 prompt 都记录下来。
  // 第 1 次续写段要"停滞"，需要 stalledClient；记录 prompt 靠包装 sendPrompt
  const stall1 = stalledClient(log, { firstText: 'cont-1 stalls' });
  const origSend1 = stall1.sendPrompt;
  stall1.sendPrompt = (prompt, sid) => { records.push({ tag: 'cont-1', prompt }); return origSend1(prompt, sid); };
  const cont2 = continuationClient(log);
  const origSend2 = cont2.sendPrompt;
  cont2.sendPrompt = (prompt, sid) => { records.push({ tag: 'cont-2', prompt }); return origSend2(prompt, sid); };

  handler.sessions = fakeSessions([
    makeSession(stall1, 'pool-2'),
    makeSession(cont2, 'pool-3')
  ]);
  const res = fakeRes();

  await runFirstRound(handler, makeSession(stalledClient(log), 'pool-1'), res);

  const cont1 = records.find(r => r.tag === 'cont-1');
  const cont2r = records.find(r => r.tag === 'cont-2');
  assert.ok(cont1 && cont2r, '前置：两段续写 prompt 均已发出');
  const count = (t) => (t.match(/Continue exactly from where it stopped/g) || []).length;
  assert.equal(count(JSON.stringify(cont1.prompt)), 1, '第 1 次续写：指令恰 1 次');
  assert.equal(count(JSON.stringify(cont2r.prompt)), 1, '第 2 次续写：指令仍恰 1 次（无嵌套）');
  // 第 2 次续写的 content 是「首段 + 续写1 段」累积：应同时含两段文本
  const c2text = JSON.stringify(cont2r.prompt);
  assert.ok(c2text.includes('partial then silence'), '累积 content 含首段');
  assert.ok(c2text.includes('cont-1 stalls'), '累积 content 含续写 1 段');
  // 原始用户消息保留
  assert.ok(c2text.includes('帮我写一段代码'), '原始 messages 保留');
});

test('C7b: 三段续写 usage 滚动合并（首段 + 3 次续写段之和）', async () => {
  const log = [];
  const handler = new OpenAiHandler('http://127.0.0.1:1');
  const mkCont = (u) => {
    const c = continuationClient(log, { usage: u });
    return c;
  };
  handler.sessions = fakeSessions([
    makeSession(stalledClient(log, { firstText: 'c1', usage: [10, 1] }), 'pool-2'),
    makeSession(stalledClient(log, { firstText: 'c2', usage: [20, 2] }), 'pool-3'),
    makeSession(mkCont([30, 3]), 'pool-4')
  ]);
  const res = fakeRes();
  const outcome = { completed: false };

  await runFirstRound(handler, makeSession(stalledClient(log, { usage: [5, 5] }), 'pool-1'), res, { outcome });

  assert.equal(outcome.state.usage.prompt_tokens, 5 + 10 + 20 + 30, 'prompt_tokens 四段之和');
  assert.equal(outcome.state.usage.completion_tokens, 5 + 1 + 2 + 3, 'completion_tokens 四段之和');
  assert.ok(res.written.includes('hello from fresh backend'), '第 3 段成功到达客户端');
});

test('C6b: 第 2 次续写 acquire 失败 → 文案含实际次数「续写 2 次」', async () => {
  const log = [];
  const handler = new OpenAiHandler('http://127.0.0.1:1');
  let acquireCalled = 0;
  handler.sessions = {
    acquire: async () => {
      acquireCalled += 1;
      if (acquireCalled === 1) return makeSession(stalledClient(log, { firstText: 'c1 stalls' }), 'pool-2');
      throw new Error('no backend for 2nd continuation');
    },
    discardPool() {}, invalidate() {}, release() {},
    reportAccountHealth() {}, getModels: () => []
  };
  const res = fakeRes();
  const outcome = { completed: false };

  await runFirstRound(handler, makeSession(stalledClient(log), 'pool-1'), res, { outcome });

  assert.equal(acquireCalled, 2, '前置：第 2 次续写 acquire 失败');
  assert.ok(res.written.includes('已尝试续写 2 次仍失败'), '文案次数 = 已发生的续写次数（非固定 3）');
  assert.ok(res.written.includes('中途停滞'), 'acquire 失败明确报错收尾');
  assert.equal(outcome.state.finalized, true);
});

// ===== C5/F2：二次停滞 =====

test('C5/F2: 续写段停滞 → 第 2 次续写（上限内），成功救回', async () => {
  const log = [];
  const handler = new OpenAiHandler('http://127.0.0.1:1');
  // 第 1 个 acquire（续写1）停滞，第 2 个 acquire（续写2）成功
  handler.sessions = fakeSessions([
    makeSession(stalledClient(log, { firstText: 'continuation-1 stalls' }), 'pool-2'),
    makeSession(continuationClient(log), 'pool-3')
  ]);
  const res = fakeRes();
  const outcome = { completed: false };

  await runFirstRound(handler, makeSession(stalledClient(log), 'pool-1'), res, { outcome });

  assert.equal(handler.sessions._log.acquire.length, 2, '续写段停滞 → 第 2 次续写（acquire=2）');
  assert.ok(res.written.includes('continuation-1 stalls'), '续写 1 的部分内容保留');
  assert.ok(res.written.includes('hello from fresh backend'), '续写 2 的内容到达客户端');
  assert.ok(!res.written.includes('中途停滞'), '上限内不得报错');
  assert.ok(res.written.includes('data: [DONE]'), 'OpenAI 形状收尾');
  assert.equal(outcome.state.finalized, true);
  assert.equal(outcome.state.wedgeReason, 'mid-stream-continued');
  assert.equal(outcome.state.continuedCount, 2, '续写计数 = 2');
});

test('C5c: 连续 3 次续写全停滞 → 第 3 次后报错（上限门禁），文案含次数', async () => {
  const log = [];
  const handler = new OpenAiHandler('http://127.0.0.1:1');
  // 3 个 acquire 全部停滞（fakeSessions 越界取最后一个，覆盖任意次数）
  handler.sessions = fakeSessions([
    makeSession(stalledClient(log, { firstText: 'cont-1' }), 'pool-2'),
    makeSession(stalledClient(log, { firstText: 'cont-2' }), 'pool-3'),
    makeSession(stalledClient(log, { firstText: 'cont-3' }), 'pool-4')
  ]);
  const res = fakeRes();
  const outcome = { completed: false };

  await runFirstRound(handler, makeSession(stalledClient(log), 'pool-1'), res, { outcome });

  assert.equal(handler.sessions._log.acquire.length, 3, '恰好续写 3 次：第 3 次停滞不得第 4 次 acquire');
  assert.ok(res.written.includes('cont-3'), '第 3 段部分内容保留');
  assert.ok(res.written.includes('中途停滞'), '超出上限必须明确报错收尾');
  assert.ok(res.written.includes('已尝试续写 3 次仍失败'), '文案含实际续写次数');
  assert.ok(res.written.includes('data: [DONE]'), 'OpenAI 形状收尾');
  assert.equal(outcome.state.finalized, true);
  assert.equal(outcome.state.wedgeReason, 'mid-stream-failed');
  assert.equal(outcome.state.continuedCount, 3);
  assert.equal(isRateLimited('WorkBuddy 响应中途停滞（40s 无输出，疑似后端假死，已回收该后端）；已尝试续写 3 次仍失败，请重试。'), false,
    '动态次数文案不得命中 isRateLimited（防被误当频控退避）');
});

test('C3: 续写 2 停滞 → 第 3 次续写成功（上限边缘）', async () => {
  const log = [];
  const handler = new OpenAiHandler('http://127.0.0.1:1');
  handler.sessions = fakeSessions([
    makeSession(stalledClient(log, { firstText: 'cont-1 stalls' }), 'pool-2'),
    makeSession(stalledClient(log, { firstText: 'cont-2 stalls' }), 'pool-3'),
    makeSession(continuationClient(log), 'pool-4')
  ]);
  const res = fakeRes();
  const outcome = { completed: false };

  await runFirstRound(handler, makeSession(stalledClient(log), 'pool-1'), res, { outcome });

  assert.equal(handler.sessions._log.acquire.length, 3, '续写 2 停滞 → 第 3 次续写（acquire=3）');
  assert.ok(res.written.includes('hello from fresh backend'), '第 3 段内容到达客户端');
  assert.ok(!res.written.includes('中途停滞'), '上限边缘成功不得报错');
  assert.equal(outcome.state.wedgeReason, 'mid-stream-continued');
  assert.equal(outcome.state.continuedCount, 3);
});

test('C8: Anthropic 协议续写 → 全程恰一条 message_start，无 [DONE]', async () => {
  const log = [];
  const handler = new OpenAiHandler('http://127.0.0.1:1');
  handler.sessions = fakeSessions([makeSession(continuationClient(log), 'pool-2')]);
  const res = fakeRes();

  await runFirstRound(handler, makeSession(stalledClient(log), 'pool-1'), res, { protocol: 'anthropic' });

  const starts = (res.written.match(/"type":"message_start"/g) || []).length;
  assert.equal(starts, 1, 'Anthropic 续写不得重发 message_start（违反 C1）');
  assert.ok(!res.written.includes('data: [DONE]'), 'Anthropic 流无 [DONE] 哨兵');
  assert.ok(res.written.includes('hello from fresh backend'), '续写内容到达客户端');
  assert.ok(res.writableEnded, '流已收尾');
});

test('C8b: Anthropic 协议二次停滞 → 合法 event:error（每个载荷带顶层 type）', async () => {
  const log = [];
  const handler = new OpenAiHandler('http://127.0.0.1:1');
  handler.sessions = fakeSessions([
    makeSession(stalledClient(log), 'pool-2'),
    makeSession(stalledClient(log, { firstText: 'again' }), 'pool-3'),
    makeSession(stalledClient(log, { firstText: 'again-3' }), 'pool-4')
  ]);
  const res = fakeRes();

  await runFirstRound(handler, makeSession(stalledClient(log), 'pool-1'), res, { protocol: 'anthropic' });

  assert.equal(handler.sessions._log.acquire.length, 3, '前置：3 次续写全停滞（否则未触达上限门禁）');
  const payloads = res.written.split('\n').filter((l) => l.startsWith('data: '))
    .map((l) => l.slice(6).trim()).filter((p) => p && p !== '[DONE]').map((p) => JSON.parse(p));
  for (const p of payloads) {
    assert.equal(typeof p.type, 'string', `Anthropic 每个载荷必须有顶层 type，实得：${JSON.stringify(p)}`);
  }
  assert.match(res.written, /^event: error$/m, '必须以 event: error 终止（C6）');
});

// ===== C6/C7/X1：失败与断开路径 =====

test('C6: 停滞但 acquire 失败 → 报错收尾，无未捕获异常', async () => {
  const log = [];
  const handler = new OpenAiHandler('http://127.0.0.1:1');
  let acquireCalled = false;
  handler.sessions = {
    acquire: async () => { acquireCalled = true; throw new Error('no backend available'); },
    discardPool() {}, invalidate() {}, release() {},
    reportAccountHealth() {}, getModels: () => []
  };
  const res = fakeRes();
  const outcome = { completed: false };

  await runFirstRound(handler, makeSession(stalledClient(log), 'pool-1'), res, { outcome });

  assert.equal(acquireCalled, true, '前置：停滞必须尝试续写 acquire（当前实现不 acquire）');
  assert.ok(res.written.includes('partial then silence'), '首段内容保留');
  assert.ok(res.written.includes('中途停滞'), 'acquire 失败必须报错收尾');
  assert.ok(res.writableEnded, '流已收尾（不得挂起）');
  assert.equal(outcome.state.finalized, true);
});

test('C7: 停滞时客户端已断开 → 不发起续写，静默退出', async () => {
  const log = [];
  const handler = new OpenAiHandler('http://127.0.0.1:1');
  handler.sessions = fakeSessions([makeSession(continuationClient(log), 'pool-2')]);
  const res = fakeRes();
  let aborted = false;
  const outcome = { completed: false };

  // 首段产出后把 aborted 置真：停滞触发时客户端已断开
  const session = makeSession(stalledClient(log), 'pool-1');
  const abortedFn = () => aborted;
  setTimeout(() => { aborted = true; }, 5);

  await runFirstRound(handler, session, res, { aborted: abortedFn, outcome });

  assert.equal(handler.sessions._log.acquire.length, 0, '客户端已断开：不得再 acquire 新会话（防幽灵请求）');
  assert.ok(!res.written.includes('中途停滞'), '客户端已走：无需报错');
});

test('X1: 续写 acquire 期间客户端断开 → 不发起续写 prompt', async () => {
  const log = [];
  const record = [];
  const handler = new OpenAiHandler('http://127.0.0.1:1');
  handler.sessions = fakeSessions(async (n) => {
    if (n === 0) return makeSession(continuationClient(log, { record }), 'pool-2');
    return makeSession(continuationClient(log, { record }), 'pool-3');
  });
  // acquire 慢：80ms 才返回（停滞 ~40ms 触发，acquire 窗口 ~40-120ms）；
  // 断开在窗口内（50ms）发生 → 复刻「acquire 期间客户端断开」
  const origAcquire = handler.sessions.acquire;
  handler.sessions.acquire = async (k, o) => { await sleep(80); return origAcquire(k, o); };

  const res = fakeRes();
  let aborted = false;
  setTimeout(() => { aborted = true; }, 50);

  await runFirstRound(handler, makeSession(stalledClient(log), 'pool-1'), res, { aborted: () => aborted });

  assert.ok(handler.sessions._log.acquire.length >= 1, '前置：停滞必须发起 acquire');
  assert.equal(record.length, 0, 'acquire 期间断开：不得再发续写 prompt');
  assert.ok(handler.sessions._log.discardPool.some(([, p]) => p === 'pool-2'),
    'acquire 到的会话在断开后必须被丢弃（不得留着空转烧积分）');
});

// ===== C10：续写段又调工具 =====

test('C10: 续写段调用工具 → 挂起（既有路径），state 三件套为新会话', async () => {
  const log = [];
  const handler = new OpenAiHandler('http://127.0.0.1:1');
  const toolClient = {
    defaultModel: 'auto',
    cancelPrompt: async () => {},
    setModel: async () => {},
    destroy: async () => {},
    hasInflightPrompt: () => false,
    sendPrompt: () => ({
      [Symbol.asyncIterator]: () => (async function* () {
        yield messageChunk('let me look');
        yield delegateToolEvent();
      })()
    })
  };
  handler.sessions = fakeSessions([makeSession(toolClient, 'pool-2')]);
  const res = fakeRes();
  const outcome = { completed: false };

  await runFirstRound(handler, makeSession(stalledClient(log), 'pool-1'), res, { outcome });

  assert.ok(handler.pending.has(KEY), '续写段调工具必须挂起（既有语义）');
  const pending = handler.pending.get(KEY);
  assert.equal(pending.client, toolClient, '挂起条目必须绑定新会话客户端');
  assert.equal(pending.sessionId, 'sid-pool-2', '挂起条目 sessionId 必须是新会话');
  assert.ok(res.written.includes('tool_calls'), '客户端收到 tool_calls');
  handler.pending.delete(KEY);
  clearTimeout(pending.timer);
});

// ===== C13：续写段委托工具重注册（怀疑者轴 High） =====

test('C13: 续写段必须在新会话重注册委托工具（工具按 sessionId 注册，不注册则续写段调不到）', async () => {
  const log = [];
  const calls = [];
  const contClient = continuationClient(log);
  contClient.delegateTools = async (sid, tools) => { calls.push([sid, tools]); };
  const handler = new OpenAiHandler('http://127.0.0.1:1');
  handler.sessions = fakeSessions([makeSession(contClient, 'pool-2')]);
  const res = fakeRes();
  const tools = [{ name: 'read_file', description: 'x', input_schema: {} }];

  await runFirstRound(handler, makeSession(stalledClient(log), 'pool-1'), res, { tools });

  assert.equal(calls.length, 1, '续写段必须在新会话注册委托工具（恰好一次）');
  assert.equal(calls[0][0], 'sid-pool-2', '注册必须针对新会话 sessionId');
  assert.deepEqual(calls[0][1], tools, '注册的工具集必须与客户端请求一致');
});

test('C13b: 无 tools 的请求不触发 delegateTools（不空注册）', async () => {
  const log = [];
  const calls = [];
  const contClient = continuationClient(log);
  contClient.delegateTools = async (...a) => { calls.push(a); };
  const handler = new OpenAiHandler('http://127.0.0.1:1');
  handler.sessions = fakeSessions([makeSession(contClient, 'pool-2')]);
  const res = fakeRes();

  await runFirstRound(handler, makeSession(stalledClient(log), 'pool-1'), res, { tools: null });

  assert.equal(calls.length, 0, '无 tools 请求不得调用 delegateTools');
});

// ===== C14：断开早退的记账与终结（怀疑者轴 High） =====

test('C14: 停滞时客户端已断开 → 记账 + finalized（防 queue-policy 幽灵重跑）', async () => {
  const log = [];
  const handler = new OpenAiHandler('http://127.0.0.1:1');
  handler.sessions = fakeSessions([makeSession(continuationClient(log), 'pool-2')]);
  const res = fakeRes();
  const outcome = { completed: false };
  let aborted = false;
  setTimeout(() => { aborted = true; }, 5);

  await runFirstRound(handler, makeSession(stalledClient(log), 'pool-1'), res, {
    aborted: () => aborted, outcome
  });

  assert.equal(handler.sessions._log.acquire.length, 0, '不发起续写');
  assert.equal(outcome.state.finalized, true, '必须置 finalized（否则空结果检测会对已断开的请求合成 429 → 幽灵重跑 + 误冷却账号）');
  assert.equal(outcome.state.usageRecorded, true, '必须记账（不得丢 JSONL 记录）');
});

test('C14b: acquire 期间断开 → 同样记账 + finalized', async () => {
  const log = [];
  const handler = new OpenAiHandler('http://127.0.0.1:1');
  handler.sessions = fakeSessions([makeSession(continuationClient(log), 'pool-2')]);
  const origAcquire = handler.sessions.acquire;
  handler.sessions.acquire = async (k, o) => { await sleep(80); return origAcquire(k, o); };
  const res = fakeRes();
  const outcome = { completed: false };
  let aborted = false;
  setTimeout(() => { aborted = true; }, 50);

  await runFirstRound(handler, makeSession(stalledClient(log), 'pool-1'), res, {
    aborted: () => aborted, outcome
  });

  assert.equal(outcome.state.finalized, true, 'acquire 期间断开同样必须终结 + 记账');
  assert.equal(outcome.state.usageRecorded, true);
});

// ===== X3：续写段停滞 + 客户端断开 =====

test('X3: 续写段停滞与客户端断开同时 → isAborted 优先，不写 error', async () => {
  const log = [];
  const handler = new OpenAiHandler('http://127.0.0.1:1');
  handler.sessions = fakeSessions([
    makeSession(stalledClient(log, { firstText: 'cont part' }), 'pool-2')
  ]);
  const res = fakeRes();
  let aborted = false;
  // 首段停滞 ~40ms → 续写段启动并立即产出 → 续写段停滞 ~80ms；
  // 断开发生在续写段停滞之前（55ms）→ 复刻「两者同时」的竞态
  setTimeout(() => { aborted = true; }, 55);

  await runFirstRound(handler, makeSession(stalledClient(log), 'pool-1'), res, { aborted: () => aborted });

  assert.equal(handler.sessions._log.acquire.length, 1, '前置：已进入续写（否则测不到该分支）');
  assert.ok(!res.written.includes('中途停滞'), '客户端已断开：不得再写 error（isAborted 优先）');
});

// ===== S4：续写段非停滞错误 → 后端口径处置 =====

test('S4: 续写段因非停滞错误失败 → 报错收尾 + invalidate 新池 + 账号记负例', async () => {
  const log = [];
  const handler = new OpenAiHandler('http://127.0.0.1:1');
  const failing = {
    defaultModel: 'auto', cancelPrompt: async () => {}, setModel: async () => {},
    destroy: async () => {}, hasInflightPrompt: () => false,
    sendPrompt: () => ({
      [Symbol.asyncIterator]: () => ({
        next: async () => { throw new Error('upstream exploded'); }
      })
    })
  };
  handler.sessions = fakeSessions([makeSession(failing, 'pool-2')]);
  const res = fakeRes();
  const outcome = { completed: false };

  await runFirstRound(handler, makeSession(stalledClient(log), 'pool-1'), res, { outcome });

  assert.equal(handler.sessions._log.acquire.length, 1, '前置：进入续写');
  assert.ok(
    handler.sessions._log.invalidate.some(([, p]) => p === 'pool-2'),
    '非连接类失败必须 invalidate 新池（否则 finally 会把它当健康资源 release）'
  );
  assert.ok(
    handler.sessions._log.health.some(([, ok]) => ok === false),
    '非连接类失败必须记账号负例'
  );
  assert.ok(res.written.includes('中途停滞'), '客户端收到明确错误');
  assert.ok(res.writableEnded);
});

// ===== C12：资源归属（自审发现的泄漏点回归保护）=====

test('C12: 续写成功后 finally 释放的是新会话池（旧池已 discard 不得 release）', async () => {
  const log = [];
  const released = [];
  const handler = new OpenAiHandler('http://127.0.0.1:1');
  let n = 0;
  handler.sessions = {
    async acquire() {
      return n++ === 0
        ? makeSession(stalledClient(log), 'pool-1')
        : makeSession(continuationClient(log), 'pool-2');
    },
    discardPool: (k, p) => released.push(`discard:${p}`),
    invalidate: (k, p) => released.push(`invalidate:${p}`),
    release: (k, p) => released.push(`release:${p}`),
    reportAccountHealth() {}, getModels: () => []
  };
  const res = fakeRes();

  await handler.handleChatCompletions({
    model: 'hy4-preview-f', stream: true,
    messages: [{ role: 'user', content: 'hi' }]
  }, res);

  assert.ok(released.includes('release:pool-2'), '必须释放续写后的新池（否则新后端永久 busy 到空闲回收）');
  assert.ok(!released.includes('release:pool-1'), '旧池已被 discard，不得再 release（归属错误）');
  assert.ok(res.written.includes('hello from fresh backend'), '续写内容到达客户端');
  assert.ok(!res.written.includes('中途停滞'), '首次停滞不报错');
});

test('C11: 续写相关错误文案不命中 isRateLimited', () => {
  assert.equal(isRateLimited('WorkBuddy 响应中途停滞（180s 无输出，疑似后端假死，已回收该后端）'), false);
  assert.equal(isRateLimited('WorkBuddy 响应中途停滞（180s 无输出，已续写 1 次仍失败）'), false);
});

// ===== 降级续写（bugfix-20260922-stall-rootcure，D 组）=====
// 契约：末次续写（continuedCount 将达 MAX_CONTINUATIONS）不再带工具重试（!8 真机证明
// 同向量重试无出路），改为「needsTools:false（--tools "" 独立风味，委托+内置工具双除）
// + 不注册委托工具 + 专用降级指令（明示工具不可用、禁止虚构工具结果）」。
// 前 MAX-1 次续写行为逐字不变。

/** 记录每次 acquire 完整 opts 的会话桩（D 组专用：needsTools 断言需要） */
function optsRecordingSessions(sessions) {
  const log = { acquire: [], discardPool: [], invalidate: [], release: [], health: [] };
  let n = 0;
  return {
    _log: log,
    _opts: [],
    async acquire(key, opts) {
      this._opts.push(opts);
      log.acquire.push([key, opts?.modelId]);
      return sessions[Math.min(n++, sessions.length - 1)];
    },
    discardPool: (key, poolId) => log.discardPool.push([key, poolId]),
    invalidate: (key, poolId) => log.invalidate.push([key, poolId]),
    release: (key, poolId) => log.release.push([key, poolId]),
    reportAccountHealth: (accountId, r) => log.health.push([accountId, r.ok]),
    getModels: () => []
  };
}

const promptText = (record) => (record[0]?.prompt || []).map((b) => b?.text || '').join('');

/** 续写段停滞桩：记录 prompt/delegateTools、产出一段内容后再次静默停滞（驱动下一次 wedge） */
function stallingContinueClient(log, { text = 'more partial', record = null, calls = null } = {}) {
  const client = {
    defaultModel: 'auto',
    cancelPrompt: async (sid) => { log.push(['cancel', sid]); },
    setModel: async () => {},
    destroy: async () => {},
    hasInflightPrompt: () => false,
    delegateTools: async (sid, tools) => { calls?.push([sid, tools]); },
    sendPrompt: (prompt, sessionId) => {
      record?.push({ prompt, sessionId });
      return {
        [Symbol.asyncIterator]: () => {
          let i = 0;
          return {
            next: () => new Promise((resolve) => {
              if (i === 0) { i += 1; resolve({ value: messageChunk(text), done: false }); return; }
              setTimeout(() => resolve({ value: undefined, done: true }), 300); // 300ms 兜底 done 防挂死
            })
          };
        }
      };
    }
  };
  return client;
}

test('D1/D2/D3(+D7): 第 1/2 次续写带工具重注册原指令；第 3 次（末次）降级：needsTools:false + 不注册 + 专用指令', async () => {
  const log = [];
  const calls = { c1: [], c2: [], c3: [] };
  const prompts = { c1: [], c2: [], c3: [] };
  // runFirstRound 直传首轮 session（不经 acquire）→ acquire #1 即续写 #1：
  // sessions[0]=续写1（带工具停滞）、[1]=续写2（带工具停滞）、[2]=续写3（降级，完成）
  const cont1 = stallingContinueClient(log, { text: 'c1 body', record: prompts.c1, calls: calls.c1 });
  const cont2 = stallingContinueClient(log, { text: 'c2 body', record: prompts.c2, calls: calls.c2 });
  const cont3 = continuationClient(log, { text: 'c3 degraded body', record: prompts.c3 });
  cont3.delegateTools = async (sid, t) => calls.c3.push([sid, t]);

  const handler = new OpenAiHandler('http://127.0.0.1:1');
  handler.sessions = optsRecordingSessions([
    makeSession(cont1, 'pool-2'),
    makeSession(cont2, 'pool-3'),
    makeSession(cont3, 'pool-4')
  ]);
  const res = fakeRes();
  const tools = [{ name: 'read_file', description: 'x', input_schema: {} }];

  await runFirstRound(handler, makeSession(stalledClient(log), 'pool-1'), res, { tools });

  assert.equal(handler.sessions._opts.length, 3, '前置：恰好三次续写 acquire（首段 + 3 次续写 = 4 段）');
  // D1/D2：前两次带工具（现状回归）
  assert.equal(handler.sessions._opts[0].needsTools, true, '第 1 次续写 needsTools:true（现状）');
  assert.equal(handler.sessions._opts[1].needsTools, true, '第 2 次续写 needsTools:true（现状）');
  assert.equal(calls.c1.length, 1, '第 1 次续写注册委托工具（C13 现状）');
  assert.equal(calls.c2.length, 1, '第 2 次续写注册委托工具（现状）');
  assert.ok(promptText(prompts.c1).includes('Continue exactly from where it stopped'), '第 1 次续写用原指令');
  assert.ok(promptText(prompts.c2).includes('Continue exactly from where it stopped'), '第 2 次续写用原指令');
  // D3：末次降级
  assert.equal(handler.sessions._opts[2].needsTools, false, '第 3 次（末次）续写必须 needsTools:false（--tools "" 独立风味，双除工具）');
  assert.equal(calls.c3.length, 0, '降级续写段不得注册委托工具（委托链路即停滞向量）');
  const degradedPrompt = promptText(prompts.c3);
  assert.ok(degradedPrompt.includes('Tool calling is unavailable'), '降级段必须使用专用降级指令（明示工具不可用、禁止虚构工具结果）');
  assert.ok(!degradedPrompt.includes('Continue exactly from where it stopped'), '降级段不得使用原续写指令');
  assert.ok(res.written.includes('c3 degraded body'), '降级段内容进同一条流');
  // D4（帧序不变性，C9 同口径）：降级段复用同一 sink，role chunk 仍恰一次
  assert.equal(
    (res.written.match(/"role":"assistant"/g) || []).length, 1,
    '降级续写不得重复发射 role chunk（同流不重复契约）'
  );
  // D7：三段假死后端全部物理丢弃（活真相三件套随续写替换——C12 语义在降级段同样成立）
  assert.ok(handler.sessions._log.discardPool.some(([, p]) => p === 'pool-1'));
  assert.ok(handler.sessions._log.discardPool.some(([, p]) => p === 'pool-2'));
  assert.ok(handler.sessions._log.discardPool.some(([, p]) => p === 'pool-3'));
  assert.equal(handler.sessions._log.release.length, 0, '假死后端禁止 release 归还');
});

test('D5: 降级段再停滞 → 报错收尾（无第 4 次尝试，OpenAI 错误形状协议分派）', async () => {
  const log = [];
  const handler = new OpenAiHandler('http://127.0.0.1:1');
  handler.sessions = optsRecordingSessions([
    makeSession(stalledClient(log), 'pool-2'),
    makeSession(stalledClient(log), 'pool-3'),
    makeSession(stalledClient(log), 'pool-4') // 降级段（续写 #3）也停滞 → 收尾
  ]);
  const res = fakeRes();
  const tools = [{ name: 'read_file', description: 'x', input_schema: {} }];

  await runFirstRound(handler, makeSession(stalledClient(log), 'pool-1'), res, { tools });

  assert.equal(handler.sessions._opts.length, 3, '前置：降级段就是第 3 次续写');
  assert.ok(res.written.includes('server_error'), 'OpenAI 错误形状（不得错成 Anthropic 形状）');
  assert.ok(res.written.includes('已尝试续写 3 次'), '文案如实报告续写次数');
  assert.ok(res.written.includes('[DONE]'), '流正常收尾（客户端不挂住）');
});

test('D6: 降级段 acquire 失败 → 报错收尾（同 C6 口径，无未捕获异常）', async () => {
  const log = [];
  const handler = new OpenAiHandler('http://127.0.0.1:1');
  const log2 = { acquire: [], discardPool: [], invalidate: [], release: [], health: [] };
  let n = 0;
  handler.sessions = {
    _log: log2,
    async acquire(key, opts) {
      log2.acquire.push([key, opts?.modelId]);
      n += 1;
      if (n >= 3) throw new Error('no tools-free backend available');
      return makeSession(stalledClient(log), `pool-${n}`);
    },
    discardPool: (key, poolId) => log2.discardPool.push([key, poolId]),
    invalidate: (key, poolId) => log2.invalidate.push([key, poolId]),
    release: (key, poolId) => log2.release.push([key, poolId]),
    reportAccountHealth: (a, r) => log2.health.push([a, r.ok]),
    getModels: () => []
  };
  const res = fakeRes();
  const tools = [{ name: 'read_file', description: 'x', input_schema: {} }];

  await runFirstRound(handler, makeSession(stalledClient(log), 'pool-1'), res, { tools });

  assert.equal(log2.acquire.length, 3, '前置：第 3 次（降级）acquire 抛错');
  assert.ok(res.written.includes('server_error'), '报错收尾（OpenAI 形状）');
  assert.ok(res.written.includes('[DONE]'), '流正常收尾');
});

// D9（结构，AS-4）：降级段无委托工具注册 → _consumePending 挂起路径结构性不可达。
// 无独立运行期用例：D3 的 calls.c3.length===0（无注册）即「无 delegateTool 推送」
// 的充分条件断言；评审 K9-②/S4 指出占位 assert.ok(true) 为恒真坏味道，改为本注释
// 承载矩阵映射（test-matrix D9 行同步登记）。

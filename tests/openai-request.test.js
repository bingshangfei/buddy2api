/**
 * OpenAI 切片 P1/P2/P5：思考可见性决策单测（node:test，零依赖）。
 *
 * 覆盖测试矩阵 M1–M17（决策纯函数 + 路由接线）、M32（缺字段告警）、
 * M34/M35（写点缺省口径）与 F3/F4（自愈重试沿用决策 / 关思考仍累加）。
 *
 * 为什么必须表驱动穷举（state-machine.md SM-1）：仲裁方向（fail-closed）、
 * 回落默认（开）与"不表态"三者互相牵制，单点用例证明不了整张转换表；
 * 而 INV-2.1/2.4/2.7 违反后**不报错、只多扣积分**，只有用例能钉死。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OpenAiHandler, buildRequestContext } from '../src/openai-handler.js';

// request-context（批C）：请求身份经 ctx 携带
const rctx = (over = {}) => buildRequestContext({ isAborted: () => false, ...over });
import { route } from '../src/router.js';
import { resolveOpenAiThinking } from '../src/openai-protocol.js';

const ENV_VAR = 'BUDDY2API_OPENAI_REASONING_DEFAULT';

/** 表驱动用例里给"未设 env"用的空环境（避免开发机真实 env 污染断言） */
const NO_ENV = {};

/**
 * 临时设 env 跑一段，结束还原（router 只认 process.env，无法注入）。
 * 必须 await 回调结果——同步 finally 会在 async 回调真正执行前就把 env 还原，
 * 断言会以「未设 env」的口径静默通过（假绿）。
 */
async function withEnv(value, fn) {
  const prev = process.env[ENV_VAR];
  if (value === undefined) delete process.env[ENV_VAR];
  else process.env[ENV_VAR] = value;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env[ENV_VAR];
    else process.env[ENV_VAR] = prev;
  }
}

// ============ 切片 P1：决策纯函数（M1–M14） ============

test('M1–M14 表驱动: 请求字段 → 可见性决策（含归一化 / 仲裁 / 回落 / 宽容）', () => {
  const cases = [
    // [body, env, expected, 说明]
    [{}, NO_ENV, true, 'M1：未携带任何推理字段 + env 未设 → 开（默认不回归，既有客户端行为）'],
    [{ reasoning_effort: 'none' }, NO_ENV, false, 'M2：reasoning_effort=none → 关'],
    [{ reasoning_effort: 'NONE' }, NO_ENV, false, 'M3：归一化大小写不敏感'],
    [{ reasoning_effort: ' none ' }, NO_ENV, false, 'M3：归一化去空白'],
    [{ reasoning_effort: 'high' }, NO_ENV, true, 'M4：非 none 值「不表态」→ 回落默认（开）'],
    [{ reasoning_effort: 'minimal' }, NO_ENV, true, 'M4：任意非 none 值同处理'],
    [{ thinking: { type: 'disabled' } }, NO_ENV, false, 'M5：thinking.type=disabled → 关'],
    [{ thinking: { type: 'enabled' } }, NO_ENV, true, 'M6：thinking.type=enabled → 开'],
    [{ thinking: { type: 'adaptive' } }, NO_ENV, true, 'M7：thinking.type=adaptive → 开'],
    [
      { thinking: { type: 'enabled', display: 'omitted' } }, NO_ENV, false,
      'M8：display=omitted（只留签名不回正文）= 不可见。本代理产不出真签名，照发等于无视客户端的显式省略请求'
    ],
    [
      { reasoning_effort: 'none', thinking: { type: 'enabled' } }, NO_ENV, false,
      'M9：fail-closed 仲裁——本 wire 原生旋钮（reasoning_effort）说「别发」不得被外来字段静默压过'
    ],
    [{ reasoning_effort: 'high' }, { [ENV_VAR]: '0' }, false, 'M10：不表态 + env=0 → 回落 env'],
    [
      { thinking: { type: 'enabled' } }, { [ENV_VAR]: '0' }, true,
      'M11：显式开压过 env=0（env **不是** kill switch，README 必须写明）'
    ],
    [{}, { [ENV_VAR]: '0' }, false, 'M12：未携带 + env=0 → 关'],
    [{ thinking: null }, NO_ENV, true, 'M13：null（畸形）→ 回落，不抛错'],
    [{ thinking: 'enabled' }, NO_ENV, true, 'M13：字符串（畸形）→ 回落，不得被当对象解引用'],
    [{ thinking: 42 }, NO_ENV, true, 'M13：数字（畸形）→ 回落'],
    [{ thinking: { type: 'foo' } }, NO_ENV, true, 'M13：未知 type → 回落（规范演进容忍），不报 400'],
    [{ reasoning_effort: 'off' }, NO_ENV, true, 'M14：近似拼写 fail-open（已知取舍，不做同义词映射）'],
    [{ reasoning_effort: 'disable' }, NO_ENV, true, 'M14：同上'],
    [{ reasoning_effort: 'NONE_ish' }, NO_ENV, true, 'M14：同上（前缀不匹配即不表态）'],
    [{ reasoning_effort: 'none' }, { [ENV_VAR]: '1' }, false, '显式关压过 env=1'],
    [{ thinking: { type: 'disabled' } }, { [ENV_VAR]: '1' }, false, '同上（thinking 侧）'],
    [{ reasoning_effort: 'none' }, { [ENV_VAR]: '0' }, false, '关 + env=0 → 关'],
    [{}, { [ENV_VAR]: '1' }, true, '未携带 + env=1 → 开'],
    [{}, { [ENV_VAR]: 'weird' }, true, 'env 非 0 的任意值 → 视为未关（只有字面 0 才关闭）']
  ];
  for (const [body, env, expected, why] of cases) {
    assert.equal(resolveOpenAiThinking(body, env), expected, why);
  }
});

test('M13 边界: body 本身为 null/undefined/非对象 → 回落默认，不抛错', () => {
  for (const body of [null, undefined, 42, 'x', [], true]) {
    assert.equal(resolveOpenAiThinking(body, NO_ENV), true, `body=${JSON.stringify(body)} 必须回落默认而不是抛错`);
  }
});

test('M1 反向对照: env=0 时同一 body 决策翻转（证明 M1 断的是真实决策而非恒真）', () => {
  assert.equal(resolveOpenAiThinking({}, { [ENV_VAR]: '0' }), false);
  assert.equal(resolveOpenAiThinking({}, NO_ENV), true);
});

// ============ 切片 P2：路由接线（M15–M17） ============

/** 走流式分支（router 在此之前就返回 request，不触发 handler 副作用） */
function routedRequest(body) {
  return route('POST', '/v1/chat/completions', { messages: [{ role: 'user', content: 'hi' }], stream: true, ...body }, { key: 'k1' });
}

test('M15: /v1/chat/completions 不带推理字段 → request.thinkingEnabled === true（默认开）', async () => {
  await withEnv(undefined, async () => {
    const r = await routedRequest({});
    assert.equal(r.stream, true, '前置：必须走流式分支才不触发 handler');
    assert.equal(r.request.thinkingEnabled, true);
  });
});

test('M16: /v1/chat/completions 带 reasoning_effort:none → request.thinkingEnabled === false', async () => {
  await withEnv(undefined, async () => {
    const r = await routedRequest({ reasoning_effort: 'none' });
    assert.equal(r.request.thinkingEnabled, false);
  });
});

test('M17: 客户端自带 thinkingEnabled:false → 仍为 true（router 计算值必须在 spread 之后）', async () => {
  await withEnv(undefined, async () => {
    const r = await routedRequest({ thinkingEnabled: false });
    assert.equal(
      r.request.thinkingEnabled, true,
      '客户端可自带同名字段覆盖决策 → 计算值必须在 {...body} 之后赋值'
    );
  });
});

test('M17 反向对照: 客户端自带 thinkingEnabled:true 也不能把请求驱动的「关」翻回开', async () => {
  await withEnv(undefined, async () => {
    const r = await routedRequest({ thinkingEnabled: true, reasoning_effort: 'none' });
    assert.equal(r.request.thinkingEnabled, false);
  });
});

test('M10/M12 路由: env=0 且不表态/未携带 → request.thinkingEnabled === false', async () => {
  await withEnv('0', async () => {
    assert.equal((await routedRequest({})).request.thinkingEnabled, false);
    assert.equal((await routedRequest({ reasoning_effort: 'high' })).request.thinkingEnabled, false);
  });
});

test('M11 路由: env=0 + thinking.type=enabled → true（env 仅回落默认，非 kill switch）', async () => {
  await withEnv('0', async () => {
    assert.equal((await routedRequest({ thinking: { type: 'enabled' } })).request.thinkingEnabled, true);
  });
});

// ============ 切片 P5：写点缺省口径（M34/M35）+ 告警（M32） ============

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

/** 只产思考不产正文的客户端：思考必须先落到 state.reasoning，即使不发给客户端 */
function reasoningOnlyClient(text = '内部推理') {
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
          params: { update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text } } }
        };
        yield { jsonrpc: '2.0', id: 'p-1', result: { stopReason: 'end_turn' } };
      })()
    })
  };
}

function makeHandler() {
  const calls = { acquire: 0, release: [], invalidate: [], discardPool: [] };
  const handler = new OpenAiHandler('http://127.0.0.1:1');
  handler.sessionReuse = false;
  handler._armPendingTimeout = () => {};
  handler.sessions = {
    async acquire() {
      calls.acquire++;
      return { sessionId: `sess-${calls.acquire}`, client: reasoningOnlyClient(), models: [], poolId: `pool-${calls.acquire}`, accountId: 'acc-1' };
    },
    acquireExisting: () => null,
    release: (k, p) => calls.release.push([k, p]),
    invalidate: (k, p) => calls.invalidate.push([k, p]),
    discardPool: (k, p) => calls.discardPool.push([k, p]),
    reportAccountHealth() {},
    getModels: () => [],
    hasPool: () => false
  };
  return { handler, calls };
}

test('M34: 直接调用（不传 thinkingEnabled、不传 protocol）→ 缺省为「开」，思考仍发射（既有行为不回归）', async () => {
  const { handler } = makeHandler();
  const res = fakeRes();
  const outcome = { completed: false, state: null };
  const session = { sessionId: 'sid-1', client: reasoningOnlyClient(), models: [], poolId: 'pool-1', accountId: 'acc-1' };

  await handler._handleStreamingResponse({
    session, prompt: [{ type: 'text', text: 'p' }], model: 'hy4-preview-f',
    ctx: rctx({ key: 'k-default', clientModel: 'auto', res, outcome })
  });

  assert.equal(
    outcome.state.thinkingEnabled, true,
    '写点是 Boolean(thinkingEnabled) 而签名默认值若为 false，会把「未提供」折成显式 false → 直接调用方静默失去思考（未被授权行为变更）'
  );
  assert.match(res.written, /"reasoning_content"/, '缺省开 → 必须发射');
});

test('M35: 同一调用点显式 protocol="anthropic" 且不传 thinkingEnabled → 缺省仍为 false（Anthropic 行为不变）', async () => {
  const { handler } = makeHandler();
  const res = fakeRes();
  const outcome = { completed: false, state: null };
  const session = { sessionId: 'sid-2', client: reasoningOnlyClient(), models: [], poolId: 'pool-2', accountId: 'acc-1' };

  await handler._handleStreamingResponse({
    session, prompt: [{ type: 'text', text: 'p' }], model: 'hy4-preview-f',
    ctx: rctx({ key: 'k-anthropic', clientModel: 'claude-x', res, outcome, protocol: 'anthropic' })
  });

  assert.equal(outcome.state.thinkingEnabled, false, 'Anthropic 侧默认值不得因本次改动而翻转');
  assert.ok(!res.written.includes('thinking_delta'), 'Anthropic 缺省关 → 不发 thinking 块');
});

test('M34 非流式: 同一缺省补正对 _handleNonStreamingResponse 同样生效', async () => {
  const { handler } = makeHandler();
  const outcome = { completed: false, state: null };
  const session = { sessionId: 'sid-3', client: reasoningOnlyClient(), models: [], poolId: 'pool-3', accountId: 'acc-1' };

  const result = await handler._handleNonStreamingResponse({
    session, prompt: [{ type: 'text', text: 'p' }], model: 'hy4-preview-f',
    ctx: rctx({ key: 'k-ns', clientModel: 'auto', res: fakeRes(), outcome })
  });

  assert.equal(outcome.state.thinkingEnabled, true);
  assert.equal(result.choices[0].message.reasoning_content, '内部推理', '缺省开 → 非流式仍回显');
});

test('M32: request.thinkingEnabled 缺失（非 router 调用方）→ 打一次告警且行为不变（仍发射）', async () => {
  const { handler } = makeHandler();
  const warns = [];
  const origWarn = console.warn;
  console.warn = (...args) => { warns.push(args.join(' ')); };
  try {
    await handler.handleChatCompletions(
      { messages: [{ role: 'user', content: 'hi' }], apiKey: 'k-warn' },
      fakeRes()
    );
  } finally {
    console.warn = origWarn;
  }

  const hits = warns.filter(w => w.includes('thinkingEnabled'));
  assert.equal(hits.length, 1, `字段缺失必须恰好告警一次（实际 ${hits.length} 次）：${JSON.stringify(warns)}`);
});

test('M32 反向对照: router 正常产出的请求不得触发该告警（否则告警常态噪声化）', async () => {
  const { handler } = makeHandler();
  const warns = [];
  const origWarn = console.warn;
  console.warn = (...args) => { warns.push(args.join(' ')); };
  try {
    await handler.handleChatCompletions(
      { messages: [{ role: 'user', content: 'hi' }], apiKey: 'k-ok', thinkingEnabled: true },
      fakeRes()
    );
  } finally {
    console.warn = origWarn;
  }

  assert.equal(warns.filter(w => w.includes('thinkingEnabled')).length, 0);
});

// ============ 切片 P5：文档一致性（M33） ============

test('M33: README 的 OpenAI 思考内容契约与实现一致（含「非 kill switch」与「不省 token」纪律）', async () => {
  const { readFileSync } = await import('node:fs');
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');

  assert.match(readme, /BUDDY2API_OPENAI_REASONING_DEFAULT/, 'env 变量必须进环境变量表');
  assert.match(readme, /## OpenAI 思考内容/, '需要一节与 Anthropic 侧对称的契约说明');
  assert.match(
    readme, /kill switch/, '必须写明 env 只作回落默认、显式开启仍会压过它——否则会被当成总开关使用'
  );
  assert.match(
    readme, /不(会)?减少上游|只控制转发/,
    '必须写明「只控制转发、不减少上游生成与计费」——否则文档会暗示能省 token'
  );

  // 文档承诺的默认值必须与代码默认值同向（文档说默认回显 → 未携带任何字段时必须为真）
  const envRow = readme.split('\n').find(l => l.includes(`\`${ENV_VAR}\``));
  assert.ok(envRow, `环境变量表必须有 ${ENV_VAR} 一行`);
  assert.match(envRow.trim(), /\|\s*`1`\s*\|$/, `env 表默认值应为 1，实际：${envRow}`);
  assert.equal(resolveOpenAiThinking({}, {}), true, '文档默认值 1 必须与代码一致');
});

// ============ 故障模式复刻：F3（自愈重试沿用决策）/ F4（关思考仍累加 → 不重试） ============


/** 第一次调用立即抛错（零输出），用于触发自愈重试 */
function failingClient() {
  return {
    defaultModel: 'auto',
    cancelPrompt: async () => {},
    setModel: async () => {},
    destroy: async () => {},
    hasInflightPrompt: () => false,
    sendPrompt: () => ({
      [Symbol.asyncIterator]: () => (async function* () { throw new Error('boom'); })()
    })
  };
}

function retryCapableHandler(fallbackClient) {
  const calls = { acquire: 0 };
  const handler = new OpenAiHandler('http://127.0.0.1:1');
  handler.sessionReuse = false;
  handler._armPendingTimeout = () => {};
  handler.sessions = {
    async acquire() {
      calls.acquire++;
      return { sessionId: `sess-${calls.acquire}`, client: fallbackClient, models: [], poolId: `pool-${calls.acquire}`, accountId: 'acc-1' };
    },
    acquireExisting: () => null,
    release() {}, invalidate() {}, discardPool() {}, reportAccountHealth() {},
    getModels: () => [{ id: 'alt-model', name: '备选' }],
    hasPool: () => false
  };
  return { handler, calls };
}

test('F3: 自愈重试沿用首轮决策——thinkingEnabled=false 时重试不得突然冒出思考', async () => {
  const { handler, calls } = retryCapableHandler(reasoningOnlyClient('重试里才出现的思考'));
  const res = fakeRes();
  const session = { sessionId: 'sid-f3', client: failingClient(), models: [], poolId: 'pool-f3', accountId: 'acc-1' };

  const outcome = { modelFallbackUsed: false }; // 请求级盒（批4 迁移）
  await handler._handleStreamingResponse({
    session, prompt: [{ type: 'text', text: 'p' }], model: 'hy4-preview-f',
    ctx: rctx({ key: 'k-f3', clientModel: 'auto', res, outcome, thinkingEnabled: false })
  });

  assert.ok(outcome.modelFallbackUsed, '前置：本用例必须真的走到了自愈重试（否则断言恒真）');
  assert.ok(calls.acquire >= 1, '前置：重试确实换了新后端');
  assert.ok(!res.written.includes('"reasoning_content"'), '重试不得退回参数默认值（静默丢/加思考都算漂移）');
});

test('F3 反向对照: 同一路径 thinkingEnabled=true → 重试仍发射（证明上一条拦的是决策而非别的原因）', async () => {
  const { handler } = retryCapableHandler(reasoningOnlyClient('重试里的思考'));
  const res = fakeRes();
  const session = { sessionId: 'sid-f3b', client: failingClient(), models: [], poolId: 'pool-f3b', accountId: 'acc-1' };

  const outcome = { modelFallbackUsed: false }; // 请求级盒（批4 迁移）
  await handler._handleStreamingResponse({
    session, prompt: [{ type: 'text', text: 'p' }], model: 'hy4-preview-f',
    ctx: rctx({ key: 'k-f3b', clientModel: 'auto', res, outcome, thinkingEnabled: true })
  });

  assert.ok(outcome.modelFallbackUsed);
  assert.match(res.written, /"reasoning_content":"重试里的思考"/);
});

test('F4: 关思考 + 上游只产思考随后报错 → state.reasoning 已累加 → 不得重试（否则重复计费）', async () => {
  const failingAfterThought = {
    defaultModel: 'auto',
    cancelPrompt: async () => {},
    setModel: async () => {},
    destroy: async () => {},
    hasInflightPrompt: () => false,
    sendPrompt: () => ({
      [Symbol.asyncIterator]: () => (async function* () {
        yield {
          method: 'session/update',
          params: { update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: '一段内部推理' } } }
        };
        throw new Error('boom after thought');
      })()
    })
  };
  const { handler, calls } = retryCapableHandler(reasoningOnlyClient('重试里的思考'));
  const res = fakeRes();
  const outcome = { completed: false, state: null };
  const session = { sessionId: 'sid-f4', client: failingAfterThought, models: [], poolId: 'pool-f4', accountId: 'acc-1' };

  await handler._handleStreamingResponse({
    session, prompt: [{ type: 'text', text: 'p' }], model: 'hy4-preview-f',
    ctx: rctx({ key: 'k-f4', clientModel: 'auto', res, outcome, thinkingEnabled: false })
  });

  assert.equal(
    outcome.state.reasoning, '一段内部推理',
    '⚠ INV-2.1：累加必须在 gate 之前。若把 gate 提到累加前，这里会是空串 → 静默空结果误判 → 退避重试 → 重复计费'
  );
  assert.ok(!res.written.includes('"reasoning_content"'), '关思考 → 不发 reasoning_content 帧');
  assert.ok(!outcome.modelFallbackUsed, '有思考产出 → hasReasoning 为真 → 不得自愈重试');
  assert.equal(calls.acquire, 0, '不得换后端重发（重发 = 同一份 prompt 计费两次）');
});

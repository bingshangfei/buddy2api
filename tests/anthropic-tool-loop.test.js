/**
 * Anthropic 切片 P4：工具闭环 + 路由/端到端编排单测（node:test，零依赖）。
 *
 * 覆盖测试矩阵 M-16（count_tokens）、M-20~M-23（tool_use 挂起 → tool_result 续跑
 * → 二次响应仍为 Anthropic 形状）与故障模式行 F-1/F-2/F-4（非理想序输入）。
 *
 * 关键背景（requirements.md 契约消费方清单）：工具续跑判定当前是
 * `messages.some(m => m.role === 'tool')`，对 Anthropic 的 tool_result **块**
 * 恒为 false。翻译层把 tool_result 块转成 role:'tool' 消息后该判定自然成立，
 * 因此不引入协议分支；真正需要守的是「pending 已在回传中」这个非理想序。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OpenAiHandler, buildRequestContext } from '../src/openai-handler.js';
import { route, handler as routerHandler } from '../src/router.js';
import { translateAnthropicRequest } from '../src/anthropic-protocol.js';

function fakeRes() {
  return {
    writableEnded: false,
    on() {}, off() {},
    write() { return true; }, end() {}
  };
}

/** 假 SessionManager + 记录调用；_consumePending 打桩以聚焦续跑编排 */
function makeHandler() {
  const calls = { acquire: 0, respondToToolCall: [], consumed: [] };
  let poolCounter = 0;

  // 挂起状态上必须挂着 client：续跑要把工具结果回传给 WorkBuddy（respondToToolCall）
  const client = {
    setModel: async () => {},
    delegateTools: async () => {},
    defaultModel: 'hy4-preview-f',
    respondToToolCall: async (reqId, text) => { calls.respondToToolCall.push({ reqId, text }); },
    cancelPrompt: async () => {}
  };

  const handler = new OpenAiHandler('http://127.0.0.1:1');
  handler._armPendingTimeout = () => {};
  handler.sessions = {
    async acquire() {
      calls.acquire++;
      const poolId = `pool-${++poolCounter}`;
      return { sessionId: `sess-${poolCounter}`, client, models: [], poolId, accountId: null };
    },
    acquireExisting: () => null,
    release() {}, invalidate() {}, reportAccountHealth() {},
    getModels() { return []; }, hasPool() { return false; },
    discardPool() {}
  };

  handler._handleNonStreamingResponse = async ({ model, ctx }) => {
    return { marker: 'final', model, clientModel: ctx.clientModel };
  };
  handler._handleStreamingResponse = async () => null;
  handler._consumePending = async ({ state, model, stream, ctx }) => {
    calls.consumed.push({ key: ctx.key, protocol: state.protocol, model, stream });
    if (stream) return null;
    return handler._buildFinalResponse(state, 'msg_resumed', 1, model);
  };

  return { handler, calls, client };
}

const TOOL_EVENT = { reqId: 'req-1', name: 'get_weather', args: { city: 'SF' }, toolCallId: 'toolu_1' };

/** 挂起一个 Anthropic 工具调用，返回 state */
function suspend(handler, key, { content = '', client = null } = {}) {
  const state = {
    protocol: 'anthropic', content, reasoning: '', usage: {}, prompt: [],
    toolCall: null, timer: null, clientModel: 'claude-sonnet-4-5', client
  };
  handler._suspendForToolCall(state, TOOL_EVENT, {
    stream: false, ctx: { ...buildRequestContext({ key }), completionId: 'msg_1', created: 1, model: 'hy4-preview-f' }
  });
  return state;
}

// ---------- M-20：tool_result 块触发续跑 ----------

test('M-20: 翻译后 tool_result 块 → role:tool 消息（续跑判定恒真的根因修复）', () => {
  const translated = translateAnthropicRequest({
    messages: [{
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: '晴，22 度' }]
    }]
  });
  assert.equal(translated.messages.some(m => m.role === 'tool'), true,
    '判定条件必须成立，否则 Anthropic 工具闭环永远走新建会话分支');
});

test('M-20: pending 命中 → 走续跑分支并把工具结果回传给 WorkBuddy', async () => {
  const { handler, calls, client } = makeHandler();
  suspend(handler, 'sk-a', { client });

  const translated = translateAnthropicRequest({
    messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: '晴，22 度' }] }]
  });
  translated.apiKey = 'sk-a';

  await handler.handleChatCompletions(translated, fakeRes());

  assert.equal(calls.respondToToolCall.length, 1, '必须把结果回传给挂起的 delegateTool 请求');
  assert.equal(calls.respondToToolCall[0].reqId, 'req-1');
  assert.match(calls.respondToToolCall[0].text, /晴，22 度/);
  assert.equal(calls.acquire, 0, '续跑不得新建会话');
  assert.equal(calls.consumed.length, 1);
});

test('M-22: 续跑时按挂起时记录的 protocol 消费', async () => {
  const { handler, calls, client } = makeHandler();
  suspend(handler, 'sk-a', { client });

  const translated = translateAnthropicRequest({
    messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'x' }] }]
  });
  translated.apiKey = 'sk-a';
  await handler.handleChatCompletions(translated, fakeRes());

  assert.equal(calls.consumed[0].protocol, 'anthropic');
});

// ---------- M-23：二次响应仍为 Anthropic 形状 ----------

test('M-23: 续跑后的二次响应仍是 Anthropic message（不回退 OpenAI 形状）', async () => {
  const { handler, client } = makeHandler();
  const state = suspend(handler, 'sk-a', { content: '查到结果：', client });

  const translated = translateAnthropicRequest({
    messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: '晴' }] }]
  });
  translated.apiKey = 'sk-a';

  const resp = await handler.handleChatCompletions(translated, fakeRes());

  assert.equal(resp.type, 'message', '二次响应必须是 Anthropic message');
  assert.equal(resp.role, 'assistant');
  assert.equal(resp.stop_reason, 'end_turn');
  assert.ok(Array.isArray(resp.content));
  assert.equal(resp.choices, undefined, '不得混入 OpenAI choices');
  // 回传中的标记是 resuming，**不是**清空 toolCall。toolCall 必须保留：
  // queue-policy 的静默空结果检测把它当作"本次有产出"的证据，续跑期间置空会让
  // 一次正常续跑被误判成频控空结果 → 退避重试 → 重复计费（CR I-1 关联）。
  assert.equal(state.resuming, true, '回传中：resuming 置位');
  assert.equal(state.toolCall?.reqId, 'req-1', 'toolCall 保留（queue-policy 空结果检测依赖）');
});

// ---------- F-1：无 pending 的 tool_result 不得被误判为续跑 ----------

test('F-1: tool_result 到达但该 key 无 pending → 走新建会话，不回传', async () => {
  const { handler, calls, client } = makeHandler();

  const translated = translateAnthropicRequest({
    messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_ghost', content: '旧结果' }] }]
  });
  translated.apiKey = 'sk-none';

  const resp = await handler.handleChatCompletions(translated, fakeRes());

  assert.equal(calls.respondToToolCall.length, 0, '无挂起时不得回传');
  assert.equal(calls.acquire, 1, '应走正常新建会话分支');
  assert.equal(resp.marker, 'final');
  assert.equal(resp.model, 'hy4-preview-f', '缺省 model 回落到代理默认模型');
});

// ---------- F-2：pending 已被 TTL 清理后回传 ----------

test('F-2: pending 被 TTL 清理后 tool_result 才到达 → 不崩，走新建会话', async () => {
  const { handler, calls, client } = makeHandler();
  const state = suspend(handler, 'sk-a', { client });
  // 模拟挂起超时清理
  handler._onPendingTimeout('sk-a', state);
  assert.equal(handler.pending.has('sk-a'), false);

  const translated = translateAnthropicRequest({
    messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: '迟到的结果' }] }]
  });
  translated.apiKey = 'sk-a';

  await assert.doesNotReject(() => handler.handleChatCompletions(translated, fakeRes()));
  assert.equal(calls.respondToToolCall.length, 0);
  assert.equal(calls.acquire, 1);
});

// ---------- F-4：重复回传同一 tool_result（客户端重试） ----------

test('F-4: 同一 tool_result 重复回传 → 409 明确拒绝，不重复回传、不双记账', async () => {
  const { handler, calls, client } = makeHandler();
  const state = suspend(handler, 'sk-a', { client });

  const translated = translateAnthropicRequest({
    messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: '晴' }] }]
  });
  translated.apiKey = 'sk-a';

  await handler.handleChatCompletions(translated, fakeRes());
  assert.equal(calls.respondToToolCall.length, 1);
  assert.equal(state.resuming, true, '首次回传后进入"回传中"状态');

  // 第二次：pending 条目仍在（真实的 _consumePending 尚未结束时客户端就重试了）
  const err = await handler.handleChatCompletions(translated, fakeRes()).then(() => null, (e) => e);
  assert.ok(err, '⚠ 重复回传必须"明确失败"——静默处理把响的故障换成不响的重复计费');
  assert.equal(err.statusCode, 409);
  assert.match(err.message, /already being submitted/i);
  assert.equal(calls.respondToToolCall.length, 1, '不得重复回传（重复的 JSON-RPC result 会双记账）');
  // 关键断言：必须在续跑守卫处就拦下，绝不落到"正常路径"——正常路径会新建会话
  // 重新 sendPrompt，而旧 ACP 流仍在跑，同一份输入计费两次。
  assert.equal(calls.acquire, 0, '不得新建会话（否则同一 prompt 双计费）');
});

// ---------- M-16：count_tokens ----------

test('M-16: POST /v1/messages/count_tokens → {input_tokens: >0}', async () => {
  const r = await route('POST', '/v1/messages/count_tokens', {
    model: 'claude-sonnet-4-5',
    system: '你是助手',
    messages: [{ role: 'user', content: '请帮我分析这段中文文本的语义' }]
  });

  assert.equal(r.status, 200);
  assert.ok(r.body.input_tokens > 0, 'input_tokens 必须为正数');
  assert.equal(typeof r.body.input_tokens, 'number');
});

test('M-16 边界: count_tokens 缺 messages → 400 而非崩溃', async () => {
  const r = await route('POST', '/v1/messages/count_tokens', { model: 'claude-x' });
  assert.equal(r.status, 400);
  assert.equal(r.body.type, 'error');
});

// ---------- 路由：/v1/messages ----------

test('route: POST /v1/messages 缺 messages → 400 Anthropic 形状错误', async () => {
  for (const body of [{}, { messages: 'nope' }, { messages: null }]) {
    const r = await route('POST', '/v1/messages', body);
    assert.equal(r.status, 400);
    assert.equal(r.body.type, 'error', 'Anthropic 客户端按 {type:error,error:{…}} 解析');
    assert.match(r.body.error.message, /messages/);
  }
});

test('route: POST /v1/messages 空 messages 数组 → 400（CR S-4：放行会拿空 prompt 打后端）', async () => {
  // Anthropic 官方要求 messages 非空。放行的后果不是"空查询"而是后端把空 prompt
  // 当"继续上一轮"处理——一次冤枉计费，而客户端拿到 200 毫不知情。
  let called = 0;
  routerHandler.handleChatCompletions = async () => { called++; return { ok: true }; };

  const r = await route('POST', '/v1/messages', { model: 'claude-x', max_tokens: 10, messages: [] }, { key: 'k' });

  assert.equal(r.status, 400);
  assert.equal(r.body.type, 'error');
  assert.equal(r.body.error.type, 'invalid_request_error');
  assert.match(r.body.error.message, /at least one/i);
  assert.equal(called, 0, '不得把空 messages 交给 handler（会产出零内容 prompt）');
});

test('route: POST /v1/messages 非流式 → 200 且请求被翻译为内部形状', async () => {
  const seen = [];
  routerHandler.handleChatCompletions = async (request) => {
    seen.push(request);
    return { id: 'msg_1', type: 'message', content: [] };
  };

  const r = await route('POST', '/v1/messages', {
    model: 'claude-sonnet-4-5',
    max_tokens: 100,
    system: 'SYS',
    messages: [{ role: 'user', content: 'hi' }]
  }, { key: 'sk-route' });

  assert.equal(r.status, 200);
  assert.equal(r.body.type, 'message');
  assert.equal(seen[0].protocol, 'anthropic');
  assert.equal(seen[0].apiKey, 'sk-route');
  assert.equal(seen[0].messages[0].role, 'system', '顶层 system 应翻译为内部 system 消息');
});

test('route: POST /v1/messages stream=true → 交给 index.js 走流式路径', async () => {
  routerHandler.handleChatCompletions = async () => { throw new Error('流式不应在此调用'); };
  const res = fakeRes();
  const r = await route('POST', '/v1/messages', {
    model: 'claude-x', stream: true, messages: [{ role: 'user', content: 'hi' }]
  }, { key: 'k', res });

  assert.equal(r.stream, true);
  assert.equal(r.status, null);
  assert.equal(r.request.protocol, 'anthropic');
  assert.equal(r.res, res);
});

test('route: GET /v1/messages → 404（只支持 POST）', async () => {
  const r = await route('GET', '/v1/messages', {});
  assert.equal(r.status, 404);
});

// ---------- M-15：claude-* 映射必须留痕 ----------

test('M-15: claude-* 映射到默认模型时打告警，且告警含实际使用的模型名', async () => {
  const { handler } = makeHandler();
  const warns = [];
  const orig = console.warn;
  console.warn = (...a) => warns.push(a.join(' '));
  try {
    await handler.handleChatCompletions({
      protocol: 'anthropic',
      model: 'claude-sonnet-4-5-20250929',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      apiKey: 'sk-warn'
    }, fakeRes());
  } finally {
    console.warn = orig;
  }

  const line = warns.find(w => w.includes('claude-sonnet-4-5-20250929'));
  assert.ok(line, 'claude-* 被换模型时必须告警，否则用户不知道实际在用哪个模型');
  // spec index.md §Convention 模型 id：隐藏/未公布 id 必须显式告警，且必须写出实际使用的模型名
  assert.ok(line.includes('hy4-preview-f'), `告警须含实际使用的默认模型名，实际: ${line}`);
});

test('M-15 边界: 非 claude 前缀 id 不打「网关不存在」告警（不制造噪音）', async () => {
  const { handler } = makeHandler();
  const warns = [];
  const orig = console.warn;
  console.warn = (...a) => warns.push(a.join(' '));
  try {
    await handler.handleChatCompletions({
      protocol: 'anthropic',
      model: 'glm-5.3',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      apiKey: 'sk-warn2'
    }, fakeRes());
  } finally {
    console.warn = orig;
  }
  assert.equal(warns.filter(w => w.includes('网关不存在')).length, 0, '非 claude id 不应触发映射告警');
});

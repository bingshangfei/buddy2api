/**
 * 集成冒烟（tdd-20260918-delegate-deadwait-fix 阶段 3.5）。
 * 覆盖单测盲区：
 *  S1 注册表真实 HTTP 路径：mock gateway + 真实 AcpClient，POST 流送 delegateTool
 *     请求 → 未被消费 → 超时兜底 JSON-RPC error 真实发出（单测 stub 了 _post）。
 *  S2 请求入口透传：走 handleChatCompletions 入口（而非直接调内部方法），验证
 *     state.rawMessages 从 messages 正确透传到续写 prompt（新增调用点单测未覆盖）。
 *
 * 运行：node --test tests/smoke-integration.test.js
 */

process.env.FIRST_TOKEN_TIMEOUT_MS = '40';
process.env.STREAM_STALL_TIMEOUT_MS = '40';
process.env.DELEGATE_REPLY_TIMEOUT_MS = '60';

const { AcpClient } = await import('../src/acp-client.js');
const { OpenAiHandler } = await import('../src/openai-handler.js');
import assert from 'node:assert/strict';
import http from 'node:http';
import { test } from 'node:test';

// ===== S1：注册表真实 HTTP 路径 =====

test('S1: 真实 HTTP：入站 delegateTool 未消费 → 超时兜底 error 到达 gateway', async () => {
  const received = [];
  let promptFlushed = null;
  const flush = () => promptFlushed?.();

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => body += c);
    req.on('end', () => {
      if (req.url === '/api/v1/acp/connect') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ connectionId: 'conn-smoke', sessionToken: 'tok' }));
        return;
      }
      if (req.method === 'GET' && req.url === '/api/v1/acp') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.end(': ok\n\n');
        return;
      }
      let parsed = {};
      try { parsed = JSON.parse(body || '{}'); } catch { /* ignore */ }
      received.push(parsed);

      // 对 hello（initialize）直接回 result；对 prompt 回「一个 delegateTool 请求 + 挂住」
      if (parsed.method === 'session/prompt') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        // 服务端主动请求：delegateTool（带 id），随后不再有事件（挂起）
        res.write(`data: ${JSON.stringify({
          jsonrpc: '2.0', id: 'srv-1', method: '_codebuddy.ai/delegateTool',
          params: { sessionId: 's1', toolCallId: 'tc-1', toolId: 'read_file', input: {} }
        })}\n\n`);
        promptFlushed = () => res.end();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ jsonrpc: '2.0', id: parsed.id, result: { ok: true } })}\n\n`);
      res.end();
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  const client = new AcpClient(`http://127.0.0.1:${port}`);
  client.delegateReplyTimeoutMs = 60;
  await client.connect();
  await client.initialize();
  client.sessionId = 's1';

  // 消费 prompt 流的第一条事件（delegateTool 请求）后**不 ack**（模拟 driver 已退出）
  let firstEvent = null;
  try {
    for await (const evt of client.sendPrompt([{ type: 'text', text: 'hi' }]) ) {
      firstEvent = evt;
      break; // 立即退出消费循环：请求留在注册表里
    }
  } catch { /* 流被提前退出 */ }
  assert.equal(firstEvent?.method, '_codebuddy.ai/delegateTool', '前置：收到真实 delegateTool 请求事件');

  await new Promise((r) => setTimeout(r, 150)); // 等超时兜底（阈值 60ms）

  const answer = received.find((m) => m.id === 'srv-1' && m.error);
  assert.ok(answer, '真实 HTTP 路径：超时兜底 error 必须送达 gateway，实得：' + JSON.stringify(received.map((m) => m.id)));
  assert.equal(typeof answer.error.code, 'number');
  assert.match(answer.error.message, /dropped/i);

  flush();
  client.destroy();
  await new Promise((r) => server.close(r));
});

// ===== S2：请求入口 rawMessages 透传 =====

test('S2: handleChatCompletions 入口 → 停滞续写 prompt 含客户端原始消息（入口透传验证）', async () => {
  const captures = {};
  const res = {
    writableEnded: false, headersSent: false, written: '',
    writeHead() { this.headersSent = true; return this; },
    write(c) { this.written += c; return true; },
    end(c) { if (c) this.written += c; this.writableEnded = true; },
    on() {}, off() {}
  };

  const stalled = {
    defaultModel: 'auto', cancelPrompt: async () => {}, setModel: async () => {},
    destroy: async () => {}, hasInflightPrompt: () => false,
    sendPrompt: () => ({
      [Symbol.asyncIterator]: () => {
        let first = true;
        return { next: () => new Promise((r) => {
          if (first) { first = false; r({ value: { method: 'session/update', params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'cut off here' } } } }, done: false }); return; }
          setTimeout(() => r({ value: undefined, done: true }), 300);
        }) };
      }
    })
  };
  const continuation = {
    defaultModel: 'auto', cancelPrompt: async () => {}, setModel: async () => {},
    destroy: async () => {}, hasInflightPrompt: () => false,
    sendPrompt: (prompt) => {
      captures.prompt = prompt;
      return { [Symbol.asyncIterator]: () => (async function* () {
        yield { method: 'session/update', params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'rest of answer' } } } };
        yield { jsonrpc: '2.0', id: 'p-1', result: { stopReason: 'end_turn' } };
      })() };
    }
  };
  const mkSession = (client, poolId) => ({ sessionId: `sid-${poolId}`, client, models: [], poolId, backendUrl: 'x', accountId: 'acc-1' });
  let n = 0;
  const handler = new OpenAiHandler('http://127.0.0.1:1');
  handler.sessions = {
    async acquire() { return n++ === 0 ? mkSession(continuation, 'pool-2') : mkSession(continuation, 'pool-3'); },
    discardPool() {}, invalidate() {}, release() {}, reportAccountHealth() {}, getModels: () => [],
    // 首轮直接给停滞会话：由 handleChatCompletions 内部 acquire 拿到的会话不可控，
    // 因此这里把 handleChatCompletions 的入口会话也路由到 stalled。
  };
  const origAcquire = handler.sessions.acquire;
  handler.sessions.acquire = async () => (n++ === 0 ? mkSession(stalled, 'pool-1') : origAcquire());

  await handler.handleChatCompletions({
    model: 'hy4-preview-f', stream: true,
    messages: [
      { role: 'system', content: 'sys-prompt' },
      { role: 'user', content: '客户端原始问题-UNIQUE' }
    ]
  }, res);

  assert.ok(captures.prompt, '续写 prompt 已发出（前置：停滞自愈发生）');
  const text = JSON.stringify(captures.prompt);
  assert.ok(text.includes('客户端原始问题-UNIQUE'), '入口透传：续写 prompt 必须含客户端原始消息');
  assert.ok(text.includes('cut off here'), '入口透传：续写 prompt 含已流出半成品');
  assert.ok(res.written.includes('rest of answer'), '续写内容到达客户端');
  assert.ok(!res.written.includes('中途停滞'), '首次停滞不报错');
});

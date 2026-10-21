/**
 * acp-client 传输层单测（node:test，零依赖）。
 * 用本地 mock gateway 服务器验证统一传输层：
 * connect / _sendJsonRpc（单结果） / _sendJsonRpcStream（SSE 流） /
 * _sendJsonRpcResult / _sendNotification / JSON-RPC error 抛出。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AcpClient } from '../src/acp-client.js';

/**
 * 起一个 mock WorkBuddy gateway：
 *  - POST /api/v1/acp/connect → JSON { connectionId, sessionToken }
 *  - POST /api/v1/acp → 按请求体 method 返回 SSE 流
 *
 * @param {(body: object) => (string | { events?: object[], error?: object })} [handler]
 *        自定义响应逻辑；缺省按 method 返回默认响应。
 */
function startMockGateway(handler) {
  const received = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      if (req.url === '/api/v1/acp/connect') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ connectionId: 'conn-1', sessionToken: 'tok-1' }));
        return;
      }

      // GET standalone SSE（事件合并源）：真实网关只往一条流写事件——
      // POST 流活跃时事件走 POST，standalone 只有心跳。mock 模拟该行为：
      // GET 返回空 SSE 立即结束，不产生事件（避免与 POST 流重复）。
      if (req.method === 'GET' && req.url === '/api/v1/acp') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.end(': ok\n\n');
        return;
      }

      let parsed = null;
      try { parsed = JSON.parse(body || '{}'); } catch { parsed = {}; }
      received.push({ url: req.url, body: parsed, headers: req.headers });

      let events;
      if (handler) {
        const out = handler(parsed);
        if (typeof out === 'string') {
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          res.end(out);
          return;
        }
        if (out?.error) {
          events = [{ jsonrpc: '2.0', id: parsed.id, error: out.error }];
        } else {
          events = out?.events;
        }
      }

      if (!events) {
        const method = parsed.method;
        if (method === 'session/prompt') {
          events = [
            { jsonrpc: '2.0', method: 'session/update', params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hi' } } } },
            { jsonrpc: '2.0', id: parsed.id, result: { stopReason: 'end_turn' } }
          ];
        } else {
          events = [{ jsonrpc: '2.0', id: parsed.id, result: { ok: true } }];
        }
      }

      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      for (const evt of events) {
        res.write(`data: ${JSON.stringify(evt)}\n\n`);
      }
      res.end();
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        url: `http://127.0.0.1:${server.address().port}`,
        received,
        close: () => new Promise(r => server.close(r))
      });
    });
  });
}

test('connect: 返回 connectionId/sessionToken 并缓存到实例', async () => {
  const gw = await startMockGateway();
  const client = new AcpClient(gw.url);
  try {
    const res = await client.connect();
    assert.equal(res.connectionId, 'conn-1');
    assert.equal(res.sessionToken, 'tok-1');
    assert.equal(client.connectionId, 'conn-1');
    assert.equal(client.sessionToken, 'tok-1');
  } finally {
    await gw.close();
  }
});

test('_sendJsonRpc: 从 SSE 流中提取匹配 id 的单个 result', async () => {
  const gw = await startMockGateway();
  const client = new AcpClient(gw.url);
  try {
    await client.connect();
    const result = await client._sendJsonRpc('initialize', { protocolVersion: 1 });
    assert.deepEqual(result, { ok: true });
    // 请求带 acp-connection-id 且 Accept 正确
    const req = gw.received[0];
    assert.equal(req.headers['acp-connection-id'], 'conn-1');
    assert.ok(req.headers.accept.includes('text/event-stream'));
  } finally {
    await gw.close();
  }
});

test('_sendJsonRpc: 服务端返回 error → 抛出异常而非静默返回 null', async () => {
  const gw = await startMockGateway(() => ({
    error: { code: -32602, message: 'Invalid params' }
  }));
  const client = new AcpClient(gw.url);
  try {
    await client.connect();
    await assert.rejects(
      () => client._sendJsonRpc('session/new', {}),
      /Invalid params/
    );
  } finally {
    await gw.close();
  }
});

test('_sendJsonRpcStream: 产出全部 SSE 事件，命中匹配 id 的 result 后停止', async () => {
  const gw = await startMockGateway();
  const client = new AcpClient(gw.url);
  try {
    await client.connect();
    const events = [];
    for await (const evt of client._sendJsonRpcStream('session/prompt', { sessionId: 's1', prompt: [] })) {
      events.push(evt);
    }
    assert.equal(events.length, 2);
    assert.equal(events[0].method, 'session/update');
    assert.deepEqual(events[1].result, { stopReason: 'end_turn' });
  } finally {
    await gw.close();
  }
});

test('_sendJsonRpcStream: 事件流中间出现 error → 抛出并终止', async () => {
  const gw = await startMockGateway((body) => {
    if (body.method === 'session/prompt') {
      return {
        events: [
          { jsonrpc: '2.0', method: 'session/update', params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'partial' } } } },
          { jsonrpc: '2.0', id: body.id, error: { message: 'mid-stream failure' } }
        ]
      };
    }
  });
  const client = new AcpClient(gw.url);
  try {
    await client.connect();
    const events = [];
    await assert.rejects(
      (async () => {
        for await (const evt of client._sendJsonRpcStream('session/prompt', { sessionId: 's1', prompt: [] })) {
          events.push(evt);
        }
      })(),
      /mid-stream failure/
    );
    assert.equal(events.length, 1, 'error 前的事件应已产出');
  } finally {
    await gw.close();
  }
});

test('_sendJsonRpcResult: 发送 result（响应体为空也能正常完成）', async () => {
  let captured = null;
  const gw = await startMockGateway((body) => {
    captured = body;
    return ''; // 空响应体：JSON-RPC result 的响应不返回内容
  });
  const client = new AcpClient(gw.url);
  try {
    await client.connect();
    await client._sendJsonRpcResult(42, { status: 'success', output: 'done' });
    assert.equal(captured.jsonrpc, '2.0');
    assert.equal(captured.id, 42);
    assert.deepEqual(captured.result, { status: 'success', output: 'done' });
  } finally {
    await gw.close();
  }
});

test('respondPermission: 应答 request_permission（JSON-RPC result 包装）', async () => {
  let captured = null;
  const gw = await startMockGateway((body) => {
    captured = body;
    return '';
  });
  const client = new AcpClient(gw.url);
  try {
    await client.connect();
    const sent = await client.respondPermission(77, { outcome: 'selected', optionId: 'allow' });
    assert.equal(sent, true);
    assert.equal(captured.jsonrpc, '2.0');
    assert.equal(captured.id, 77);
    assert.deepEqual(captured.result, { outcome: { outcome: 'selected', optionId: 'allow' } });
  } finally {
    await gw.close();
  }
});

test('_sendNotification: 发送无 id 的通知', async () => {
  let captured = null;
  const gw = await startMockGateway((body) => {
    captured = body;
    return '';
  });
  const client = new AcpClient(gw.url);
  try {
    await client.connect();
    await client._sendNotification('session/update', { x: 1 });
    assert.equal(captured.method, 'session/update');
    assert.equal(captured.id, undefined);
    assert.deepEqual(captured.params, { x: 1 });
  } finally {
    await gw.close();
  }
});

test('initialize + createSession: 完整连接链路（不再发送多余的 set_config_option）', async () => {
  const gw = await startMockGateway((body) => {
    if (body?.method === 'session/new') {
      return { events: [{ jsonrpc: '2.0', id: body.id, result: { sessionId: 'sess-fa-1' } }] };
    }
    return { events: [{ jsonrpc: '2.0', id: body.id, result: { ok: true } }] };
  });
  const client = new AcpClient(gw.url);
  try {
    await client.initialize();
    assert.equal(client.initialized, true);

    await client.createSession('/cwd');
    assert.equal(client.sessionId, 'sess-fa-1');
    const sessionReq = gw.received.find(r => r.body?.method === 'session/new');
    assert.ok(sessionReq, '应发送过 session/new');
    assert.equal(sessionReq.body.params.cwd, '/cwd');

    // fullAccess 是 WorkBuddy session/new 的默认 mode（实测 currentValue 即
    // fullAccess），旧代码的 set_config_option 参数格式还错了（optionId 应为
    // configId），已删除——此处断言不再发送，避免每次刷 Invalid params 警告。
    const cfgReq = gw.received.find(r => r.body?.method === 'session/set_config_option');
    assert.equal(cfgReq, undefined, '不应再发送 session/set_config_option');
  } finally {
    await gw.close();
  }
});

test('sendPrompt: 产出事件流直到最终 result', async () => {
  const gw = await startMockGateway();
  const client = new AcpClient(gw.url);
  try {
    await client.connect();
    const events = [];
    for await (const evt of client.sendPrompt([{ type: 'text', text: 'hi' }], 'sess-1')) {
      events.push(evt);
    }
    assert.equal(events.length, 2);
    const promptReq = gw.received.find(r => r.body?.method === 'session/prompt');
    assert.equal(promptReq.body.params.sessionId, 'sess-1');
    assert.deepEqual(promptReq.body.params.prompt, [{ type: 'text', text: 'hi' }]);
  } finally {
    await gw.close();
  }
});

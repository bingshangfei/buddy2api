/**
 * 在飞 prompt 检测单测（node:test，零依赖）。
 *
 * 背景：buddy2api 曾在同一 ACP 连接上并发两个 session/prompt（请求 A 挂起在
 * 工具回传、请求 B 复用同一连接又发新 prompt），导致 WorkBuddy 的
 * interceptorGate 反复重试（"输出被丢弃后重新生成"）。本测试验证：
 *   1. AcpClient.hasInflightPrompt() 正确反映"连接上有未结束的 prompt"
 *   2. SessionManager.acquire 遇到有在飞 prompt 的连接时重建，不复用
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AcpClient } from '../src/acp-client.js';
import { SessionManager } from '../src/session-manager.js';

/**
 * mock gateway：session/prompt 发一个事件后保持连接打开（模拟挂起/长流），
 * 其余方法返回 result。connect 返回固定 connectionId。
 */
function startHoldingGateway() {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      // GET standalone SSE：返回空流（无推送事件，见 acp-client.test.js 同款说明）
      if (req.method === 'GET' && req.url === '/api/v1/acp') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.end(': ok\n\n');
        return;
      }
      if (req.url === '/api/v1/acp/connect') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ connectionId: 'conn-1', sessionToken: 'tok-1' }));
        return;
      }
      const parsed = JSON.parse(body || '{}');
      if (parsed.method === 'session/prompt') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({
          jsonrpc: '2.0', method: 'session/update',
          params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hi' } } }
        })}\n\n`);
        // 保持连接打开 —— 流未结束，prompt 仍"在飞"
        req.on('close', () => res.destroy());
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end(`data: ${JSON.stringify({ jsonrpc: '2.0', id: parsed.id, result: { ok: true } })}\n\n`);
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        url: `http://127.0.0.1:${server.address().port}`,
        close: () => new Promise(r => server.close(r))
      });
    });
  });
}

/**
 * mock gateway：每次 connect 返回递增的 connectionId，session/new 返回
 * 对应的 sessionId。用于验证 acquire 重建出全新连接。
 */
function startCountingGateway() {
  let connectCount = 0;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      // GET standalone SSE：返回空流（无推送事件，见 acp-client.test.js 同款说明）
      if (req.method === 'GET' && req.url === '/api/v1/acp') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.end(': ok\n\n');
        return;
      }
      if (req.url === '/api/v1/acp/connect') {
        connectCount++;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ connectionId: `conn-${connectCount}`, sessionToken: 'tok' }));
        return;
      }
      const parsed = JSON.parse(body || '{}');
      if (parsed.method === 'session/new') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.end(`data: ${JSON.stringify({ jsonrpc: '2.0', id: parsed.id, result: { sessionId: `sess-${connectCount}` } })}\n\n`);
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end(`data: ${JSON.stringify({ jsonrpc: '2.0', id: parsed.id, result: { ok: true } })}\n\n`);
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        url: `http://127.0.0.1:${server.address().port}`,
        close: () => new Promise(r => server.close(r))
      });
    });
  });
}

test('hasInflightPrompt: 初始 false，流挂起期间 true，return 后回到 false', async () => {
  const gw = await startHoldingGateway();
  const client = new AcpClient(gw.url);
  try {
    await client.connect();
    assert.equal(client.hasInflightPrompt(), false);

    const it = client.sendPrompt([{ type: 'text', text: 'hi' }], 's1')[Symbol.asyncIterator]();
    const first = await it.next();
    assert.equal(first.done, false);
    assert.ok(first.value.method === 'session/update');
    // 流仍打开（prompt 在飞）
    assert.equal(client.hasInflightPrompt(), true);

    // return() 关闭被放弃的流 → 连接标记为空闲
    await it.return();
    assert.equal(client.hasInflightPrompt(), false);
  } finally {
    await gw.close();
  }
});

test('hasInflightPrompt: 流正常结束（收到 result）后回到 false', async () => {
  const gw = await startHoldingGateway();
  const client = new AcpClient(gw.url);
  try {
    await client.connect();
    // 覆盖 mock：这次在第一个事件后直接结束流（模拟正常完成的 prompt）
    const it = client.sendPrompt([{ type: 'text', text: 'hi' }], 's1')[Symbol.asyncIterator]();
    await it.next();
    assert.equal(client.hasInflightPrompt(), true);
    await it.return(); // 流被消费者主动关闭
    assert.equal(client.hasInflightPrompt(), false);
  } finally {
    await gw.close();
  }
});

test('SessionManager.acquire: 连接有在飞 prompt → 重建连接不复用', async () => {
  const gw = await startCountingGateway();
  const mgr = new SessionManager(gw.url);
  try {
    const a = await mgr.acquire('k');
    const poolA = mgr.pools.get(a.poolId);
    assert.ok(poolA, '首次 acquire 应建池');
    assert.equal(poolA.client.connectionId, 'conn-1', '首次连接应是 conn-1');
    assert.ok(a.sessionId, '首次应拿到 sessionId');

    // 模拟：连接上仍有未结束的 prompt（挂起的工具回传）
    poolA.client._inflightPrompts = 1;

    const b = await mgr.acquire('k');
    const poolB = mgr.pools.get(b.poolId);
    assert.notEqual(poolB.client, poolA.client, '连接忙碌时必须重建，不能复用旧 client');
    assert.ok(poolB.client.connectionId.startsWith('conn-'), '新连接应有新的 connectionId');
    assert.ok(b.sessionId, '新连接也应能创建会话');
  } finally {
    await mgr.close();
    await gw.close();
  }
});

test('SessionManager.acquire: 并发请求占用不同连接（占位语义，不等 prompt 开始）', async () => {
  const gw = await startCountingGateway();
  const mgr = new SessionManager(gw.url);
  try {
    // 同时发起两个 acquire，都不等 prompt 开始
    const [a, b] = await Promise.all([mgr.acquire('k'), mgr.acquire('k')]);
    assert.notEqual(a.poolId, b.poolId, '并发请求必须拿到不同的连接池，禁止复用同一连接');
    assert.notEqual(a.client, b.client, '两条连接不能是同一个 client 实例');
    assert.ok(a.sessionId && b.sessionId, '两个会话都应创建成功');

    // 释放后再 acquire，应能复用其中一条（串行场景不必新建连接）
    mgr.release('k', a.poolId);
    mgr.release('k', b.poolId);
    const c = await mgr.acquire('k');
    assert.ok([a.poolId, b.poolId].includes(c.poolId), '串行请求应复用已释放的连接');
  } finally {
    await mgr.close();
    await gw.close();
  }
});

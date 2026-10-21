/**
 * token 消耗记账端到端单测（node:test，零依赖）。
 *
 * mock 网关回放完整 ACP 流（delta + usage_update + result），
 * 验证 openai-handler 在终态把 usage 记入 tokenStats：
 *   1. 非流式：响应带 usage，且记账一条（auto 请求归因到代理默认模型）
 *   2. 客户端指定 model → 记账模型为指定值
 *   3. usage 事件带 model 字段 → 归因以 usage 报告为准
 *   4. 流式 stream_options.include_usage → 末尾追加 usage chunk
 * 记账走 tokenStats 单例，测试期替换 record 捕获，不落真实文件。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { PassThrough } from 'node:stream';
import { OpenAiHandler } from '../src/openai-handler.js';
import { resolveDefaultModel } from '../src/model-policy.js';
import { tokenStats, TokenStats } from '../src/token-stats.js';

/**
 * mock gateway：
 *  - connect/session/new（session/new 带 configOptions 模型 currentValue）
 *  - session/prompt 流：delta → usage_update（可带 model）→ result
 */
function startGateway({ usageModel = undefined, withUsage = true, usageExtra = {} } = {}) {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
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
      if (parsed.method === 'session/new') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.end(`data: ${JSON.stringify({
          jsonrpc: '2.0', id: parsed.id,
          result: {
            sessionId: 'sess-1',
            configOptions: [{ id: 'model', currentValue: 'glm-5.3-flash', options: [] }]
          }
        })}\n\n`);
        return;
      }
      if (parsed.method === 'session/prompt') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        const send = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
        send({ jsonrpc: '2.0', method: 'session/update', params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hello' } } } });
        if (withUsage) {
          send({
            jsonrpc: '2.0', method: 'session/update',
            params: { update: { sessionUpdate: 'usage_update', _meta: { usage: { prompt_tokens: 100, completion_tokens: 7, ...(usageModel ? { model: usageModel } : {}), ...usageExtra } } } }
          });
        }
        res.end(`data: ${JSON.stringify({ jsonrpc: '2.0', id: parsed.id, result: { stopReason: 'end_turn' } })}\n\n`);
        return;
      }
      // set_model / delegateToolsChanged 等一律 result ok
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

/** 捕获 tokenStats.record：走真实 TokenStats 归一化逻辑，但不落真实持久化文件 */
async function captureRecords(fn) {
  const recorded = [];
  const sink = new TokenStats({ file: 'off', load: false });
  const orig = tokenStats.record;
  tokenStats.record = (entry) => { recorded.push(sink.record(entry)); };
  try {
    const out = await fn();
    return { recorded, out };
  } finally {
    tokenStats.record = orig;
  }
}

test('非流式：终态记账一条，auto 请求归因到代理默认模型（requestedModel 保留原值）', async () => {
  const gw = await startGateway();
  const handler = new OpenAiHandler(gw.url);
  try {
    const { recorded, out } = await captureRecords(() =>
      handler.handleChatCompletions({
        messages: [{ role: 'user', content: 'hi' }],
        model: 'auto',
        apiKey: 'test-stats-key'
      }, null)
    );

    assert.equal(out.usage.prompt_tokens, 100);
    assert.equal(out.usage.total_tokens, 107);

    assert.equal(recorded.length, 1, '终态应记账恰好一条');
    const rec = recorded[0];
    // auto 不再直通网关，而是回落到代理默认模型（默认免费），
    // 归因走 setModel 后同步的 client.defaultModel。
    assert.equal(rec.model, resolveDefaultModel(), 'auto 请求应归因到代理默认模型');
    assert.equal(rec.requestedModel, 'auto', 'requestedModel 应保留客户端原始请求值');
    assert.equal(rec.prompt_tokens, 100);
    assert.equal(rec.total_tokens, 107);
    assert.equal(rec.status, 'completed');
    assert.equal(rec.stream, false);
    assert.equal(rec.key, 'test-stats-key');
  } finally {
    await handler.close();
    await gw.close();
  }
});

test('客户端指定 model → 记账使用指定模型', async () => {
  const gw = await startGateway();
  const handler = new OpenAiHandler(gw.url);
  try {
    const { recorded } = await captureRecords(() =>
      handler.handleChatCompletions({
        messages: [{ role: 'user', content: 'hi' }],
        model: 'hy4-preview',
        apiKey: 'test-stats-key'
      }, null)
    );

    assert.equal(recorded.length, 1);
    assert.equal(recorded[0].model, 'hy4-preview');
    assert.equal(recorded[0].requestedModel, 'hy4-preview');
  } finally {
    await handler.close();
    await gw.close();
  }
});

test('usage 事件自带 model → 归因以 usage 报告为准', async () => {
  const gw = await startGateway({ usageModel: 'real-model-x' });
  const handler = new OpenAiHandler(gw.url);
  try {
    const { recorded } = await captureRecords(() =>
      handler.handleChatCompletions({
        messages: [{ role: 'user', content: 'hi' }],
        model: 'auto',
        apiKey: 'test-stats-key'
      }, null)
    );

    assert.equal(recorded[0].model, 'real-model-x');
  } finally {
    await handler.close();
    await gw.close();
  }
});

test('网关不上报 usage（如真实网关 62735）→ 按文本估算并标记 estimated', async () => {
  const gw = await startGateway({ withUsage: false });
  const handler = new OpenAiHandler(gw.url);
  try {
    const { recorded, out } = await captureRecords(() =>
      handler.handleChatCompletions({
        messages: [{ role: 'user', content: '你好，世界' }],
        model: 'auto',
        apiKey: 'test-stats-key'
      }, null)
    );

    const rec = recorded[0];
    assert.equal(rec.usage_source, 'estimated');
    // prompt '你好，世界'：5 个 CJK 字符（含全角逗号）→ 5 tokens
    assert.ok(rec.prompt_tokens >= 4, `prompt 估算应 ≥4（实际 ${rec.prompt_tokens}）`);
    // completion 'Hello'：5 个 ASCII 字符 → ceil(5/4)=2
    assert.ok(rec.completion_tokens >= 1 && rec.completion_tokens <= 3,
      `completion 估算应 ~2（实际 ${rec.completion_tokens}）`);
    assert.ok(rec.total_tokens > 0, '估算口径下统计不应为 0');
    // 标准 OpenAI usage 字段保持网关上报口径（0），不混入估算
    assert.equal(out.usage.prompt_tokens, 0);
  } finally {
    await handler.close();
    await gw.close();
  }
});

test('usage 只报 prompt_cache_miss_tokens（cached_tokens=0）→ 反推命中量，不当成全额未命中', async () => {
  // 实测 CLI 行为：cached_tokens 报 0，真实命中量在 prompt_cache_miss_tokens 里。
  // 若直接采信 cached_tokens=0，会把 100-12=88 个命中 token 误记为未命中。
  const gw = await startGateway({
    usageExtra: { cached_tokens: 0, prompt_cache_miss_tokens: 12 }
  });
  const handler = new OpenAiHandler(gw.url);
  try {
    const { recorded, out } = await captureRecords(() =>
      handler.handleChatCompletions({
        messages: [{ role: 'user', content: 'hi' }],
        model: 'auto',
        apiKey: 'test-stats-key'
      }, null)
    );

    const rec = recorded[0];
    assert.equal(rec.prompt_tokens, 100);
    assert.equal(rec.cache_miss_tokens, 12, 'miss 应取网关上报值');
    assert.equal(rec.cached_tokens, 88, '命中量应由 prompt - miss 反推，而非采信上报的 0');

    // 响应侧用 OpenAI 标准字段暴露缓存明细
    assert.deepEqual(out.usage.prompt_tokens_details, { cached_tokens: 88 });
  } finally {
    await handler.close();
    await gw.close();
  }
});

/** 流式测试用假 res：PassThrough + writeHead 桩（handler 要写 SSE 响应头） */
function fakeStreamRes() {  const res = new PassThrough();
  res.writeHead = () => {};
  return res;
}

test('流式 + stream_options.include_usage → 末尾追加 usage chunk', async () => {
  const gw = await startGateway();
  const handler = new OpenAiHandler(gw.url);
  try {
    const { recorded, out } = await captureRecords(async () => {
      const res = fakeStreamRes();
      await handler.handleChatCompletions({
        messages: [{ role: 'user', content: 'hi' }],
        model: 'auto',
        stream: true,
        stream_options: { include_usage: true },
        apiKey: 'test-stats-key'
      }, res);
      res.end();
      let raw = '';
      for await (const chunk of res) raw += chunk.toString();
      return raw;
    });

    const chunks = out.split('\n\n')
      .filter(l => l.startsWith('data: ') && l !== 'data: [DONE]')
      .map(l => JSON.parse(l.slice(6)));
    const usageChunk = chunks.find(c => Array.isArray(c.choices) && c.choices.length === 0 && c.usage);
    assert.ok(usageChunk, '应有一个 choices 为空且带 usage 的收尾 chunk');
    assert.equal(usageChunk.usage.total_tokens, 107);
    assert.equal(recorded.length, 1, '流式终态也应记账一条');
    assert.equal(recorded[0].stream, true);
  } finally {
    await handler.close();
    await gw.close();
  }
});

test('流式未开 include_usage → 不追加 usage chunk（向后兼容）', async () => {
  const gw = await startGateway();
  const handler = new OpenAiHandler(gw.url);
  try {
    const raw = await captureRecords(async () => {
      const res = fakeStreamRes();
      await handler.handleChatCompletions({
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
        apiKey: 'test-stats-key'
      }, res);
      res.end();
      let raw = '';
      for await (const chunk of res) raw += chunk.toString();
      return raw;
    }).then(r => r.out);

    const chunks = raw.split('\n\n')
      .filter(l => l.startsWith('data: ') && l !== 'data: [DONE]')
      .map(l => JSON.parse(l.slice(6)));
    assert.ok(!chunks.some(c => c.usage), '不应出现 usage chunk');
    assert.ok(chunks.some(c => c.choices?.[0]?.finish_reason === 'stop'), '正常收尾仍存在');
  } finally {
    await handler.close();
    await gw.close();
  }
});

test('连接恰好释放一次（双重归还串台回归）', async () => {
  const gw = await startGateway();
  const handler = new OpenAiHandler(gw.url);
  try {
    let releases = 0;
    const orig = handler.sessions.release.bind(handler.sessions);
    handler.sessions.release = (...args) => { releases++; return orig(...args); };

    await captureRecords(() =>
      handler.handleChatCompletions({
        messages: [{ role: 'user', content: 'hi' }],
        model: 'auto',
        apiKey: 'release-count-key'
      }, null)
    );

    assert.equal(releases, 1, `每请求应恰好释放一次连接，实际 ${releases} 次`);
  } finally {
    await handler.close();
    await gw.close();
  }
});

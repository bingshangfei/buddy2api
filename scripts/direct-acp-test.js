// 直连 WorkBuddy gateway 的裸 ACP 测试：绕过 buddy2api 全部封装
// 用法: node scripts/direct-acp-test.js [gatewayUrl] [prompt]

import http from 'node:http';

const GW = process.argv[2] || 'http://127.0.0.1:57710';
const PROMPT = process.argv[3] || '回复两个字：正常';

function post(path, body, { headers = {}, stream = false } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, GW);
    const req = http.request({
      method: 'POST',
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      headers
    }, (res) => {
      if (stream) { resolve(res); return; }
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch { resolve(data); }
      });
    });
    req.on('error', reject);
    req.setTimeout(30000, () => req.destroy(new Error('timeout ' + path)));
    if (body) req.write(body);
    req.end();
  });
}

async function* sse(response) {
  let buffer = '';
  for await (const chunk of response) {
    buffer += chunk.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      try { yield JSON.parse(line.slice(6)); } catch { /* skip */ }
    }
  }
}

const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);

const conn = await post('/api/v1/acp/connect', null, {
  headers: { 'Content-Type': 'application/json', 'x-codebuddy-request': '1' }
});
log('1. connect ->', JSON.stringify(conn).slice(0, 200));

const H = () => ({
  'Content-Type': 'application/json',
  'Accept': 'application/json, text/event-stream',
  'acp-connection-id': conn.connectionId
});

async function rpc(method, params) {
  const id = `${method}-${Date.now()}`;
  const res = await post('/api/v1/acp', JSON.stringify({ jsonrpc: '2.0', id, method, params }), {
    headers: H(), stream: true
  });
  for await (const ev of sse(res)) {
    if (ev.id !== id) continue;
    if (ev.error) throw new Error(ev.error.message);
    if (ev.result) return ev.result;
  }
  throw new Error('no result for ' + method);
}

const init = await rpc('initialize', {
  protocolVersion: 1, capabilities: {},
  clientInfo: { name: 'direct-test', version: '1.0.0' }
});
log('2. initialize ->', JSON.stringify(init).slice(0, 300));

const sess = await rpc('session/new', {
  workingDirectory: process.cwd(), cwd: process.cwd(), mcpServers: []
});
log('3. session/new ->', JSON.stringify(sess).slice(0, 200));

const sid = sess.sessionId;

// 4. prompt（流式）
const pid = `prompt-${Date.now()}`;
const res = await post('/api/v1/acp', JSON.stringify({
  jsonrpc: '2.0', id: pid, method: 'session/prompt',
  params: { sessionId: sid, prompt: [{ type: 'text', text: PROMPT }] }
}), { headers: H(), stream: true });
log('4. session/prompt sent (stream opened)');

let text = '';
let thought = '';
let stopReason = null;
let eventTypes = new Set();
const events = [];

for await (const ev of sse(res)) {
  if (ev.id) eventTypes.add('id:' + ev.id);
  if (ev.method) events.push(ev.method);
  const u = ev.params?.update;
  if (u?.sessionUpdate === 'agent_message_chunk' && u.content?.text) text += u.content.text;
  if (u?.sessionUpdate === 'agent_thought_chunk' && u.content?.text) thought += u.content.text;
  if (ev.id === pid && ev.result) { stopReason = ev.result.stopReason; break; }
  if (ev.id === pid && ev.error) { console.log('ERROR:', ev.error); break; }
}

log('5. events seen ->', JSON.stringify([...new Set(events)]).slice(0, 400));
log('   stopReason ->', stopReason);
log('   TEXT  ->', JSON.stringify(text));
log('   THOUGHT ->', JSON.stringify(thought.slice(0, 200)));

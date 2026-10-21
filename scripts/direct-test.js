/**
 * 直连测试：绕过 buddy2api HTTP 层，直接用 AcpClient 走完整 ACP 流程。
 * 用法：node scripts/direct-test.js [model] [prompt]
 */
import { AcpClient } from '../src/acp-client.js';
import { discoverGatewayUrl } from '../src/gateway-discovery.js';
import { parseAcpUpdate, extractModelsFromSessionResult } from '../src/acp-events.js';

const MODEL = process.argv[2] || 'glm-5.3-flash';
const PROMPT = process.argv[3] || '回复两个字：正常';

const t = (label) => console.log(`[${(Date.now() - start).toString().padStart(6)}ms] ${label}`);
const start = Date.now();

const url = await discoverGatewayUrl();
console.log(`\n=== 直连 ACP 测试 ===`);
console.log(`gateway: ${url}`);
console.log(`model:   ${MODEL}`);
console.log(`prompt:  ${PROMPT}\n`);

const client = new AcpClient(url);

// 1. connect
const conn = await client.connect();
console.log(`1. connect       ✅ connectionId=${conn.connectionId?.slice(0, 8)}…`);

// 2. initialize
await client.initialize();
t('2. initialize    ✅');

// 3. session/new
const sess = await client.createSession(process.cwd());
const models = extractModelsFromSessionResult(sess);
console.log(`3. session/new   ✅ sessionId=${client.sessionId?.slice(0, 8)}… models=${models.length}`);

// 4. set_model
try {
  await client.setModel(MODEL);
  console.log(`4. set_model     ✅ ${MODEL}`);
} catch (e) {
  console.log(`4. set_model     ❌ ${e.message}`);
}

// 5. prompt
console.log(`5. prompt        … streaming`);
let text = '';
let reasoning = '';
let usage = null;
let events = 0;
let stopReason = null;
let firstDeltaMs = null;

for await (const ev of client.sendPrompt(PROMPT)) {
  events++;
  if (ev.result) {
    stopReason = ev.result.stopReason;
    continue;
  }
  if (ev.error) {
    console.log(`   ❌ error: ${ev.error.message}`);
    break;
  }
  const p = parseAcpUpdate(ev);
  if (!p) continue;
  if (p.type === 'delta') {
    if (firstDeltaMs === null) firstDeltaMs = Date.now() - start;
    text += p.text;
  } else if (p.type === 'reasoning') {
    reasoning += p.text;
  } else if (p.type === 'usage') {
    usage = p.usage;
  }
}

console.log(`\n--- 结果 ---`);
console.log(`事件总数:   ${events}`);
console.log(`首字延迟:   ${firstDeltaMs ?? 'N/A'}ms`);
console.log(`总耗时:     ${Date.now() - start}ms`);
console.log(`stopReason: ${stopReason}`);
console.log(`usage:      ${JSON.stringify(usage)}`);
console.log(`正文:       ${JSON.stringify(text)}`);
console.log(`推理(截断): ${JSON.stringify(reasoning.slice(0, 120))}${reasoning.length > 120 ? '…' : ''}`);

process.exit(0);

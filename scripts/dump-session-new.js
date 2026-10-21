/**
 * dump-session-new.js — 直连网关，打印 session/new 完整响应。
 * 目的：对比顶层 models 字段与 configOptions[id=model].options 的差异，
 * 核实 /v1/models 应该取哪个来源。
 * 用法：node scripts/dump-session-new.js [gatewayUrl]
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { AcpClient } from '../src/acp-client.js';

function activeGateway() {
  const dir = path.join(os.homedir(), '.workbuddy', 'sessions');
  if (!fs.existsSync(dir)) return null;
  const now = Date.now();
  let best = null;
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    try {
      const d = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      const url = d.endpoint || d.url;
      if (url && now - (d.lastHeartbeat || 0) < 10 * 60 * 1000) {
        if (!best || (d.lastHeartbeat || 0) > best.hb) best = { url, hb: d.lastHeartbeat || 0 };
      }
    } catch { /* ignore */ }
  }
  return best?.url || null;
}

const url = process.argv[2] || activeGateway();
if (!url) {
  console.error('未找到活跃网关，可显式传入: node scripts/dump-session-new.js http://127.0.0.1:PORT');
  process.exit(1);
}

console.log(`[dump] gateway: ${url}`);
const client = new AcpClient(url);
await client.connect();
await client.initialize();
const sess = await client.createSession(process.cwd());

console.log('\n=== session/new 顶层字段 ===');
console.log(Object.keys(sess));

console.log('\n=== 顶层 models 字段 ===');
console.log(JSON.stringify(sess.models, null, 2));

console.log('\n=== configOptions[id=model] ===');
const opt = (sess.configOptions || []).find(o => o?.id === 'model');
console.log(JSON.stringify(opt, null, 2));

console.log('\n=== 对比 ===');
const topLevel = Array.isArray(sess.models) ? sess.models.map(m => (typeof m === 'string' ? m : m.id ?? m.value ?? JSON.stringify(m))) : [];
const configOpts = (opt?.options || []).map(o => o.value);
console.log(`顶层 models (${topLevel.length}):`, topLevel);
console.log(`configOptions (${configOpts.length}):`, configOpts);
console.log(`顶层独有:`, topLevel.filter(m => !configOpts.includes(m)));
console.log(`configOptions 独有:`, configOpts.filter(m => !topLevel.includes(m)));

try { await client.destroy?.(); } catch { /* ignore */ }
process.exit(0);

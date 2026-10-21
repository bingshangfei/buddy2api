/**
 * 探测指定网关（或全部活跃网关）的模型配置。
 * 用法：
 *   node scripts/probe-models.js              # 探测所有活跃 session 的 endpoint
 *   node scripts/probe-models.js http://127.0.0.1:56545
 *
 * 模型列表来自 session/new 的 configOptions[id=model].options，
 * 这是每个 WorkBuddy 会话各自的配置，不是全局目录。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { AcpClient } from '../src/acp-client.js';
import { extractModelsFromSessionResult } from '../src/acp-events.js';

function activeGateways(withinMs = 10 * 60 * 1000) {
  const dir = path.join(os.homedir(), '.workbuddy', 'sessions');
  if (!fs.existsSync(dir)) return [];
  const now = Date.now();
  const out = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    try {
      const d = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      const url = d.endpoint || d.url;
      if (url && now - (d.lastHeartbeat || 0) < withinMs) {
        out.push({ url, pid: d.pid, version: d.version, hbAge: Math.round((now - d.lastHeartbeat) / 1000) });
      }
    } catch { /* ignore bad json */ }
  }
  return out.sort((a, b) => a.hbAge - b.hbAge);
}

async function probe(gw) {
  const label = gw.url ? gw.url : String(gw);
  const meta = gw.version ? ` (pid=${gw.pid} v${gw.version} hb=${gw.hbAge}s ago)` : '';
  console.log(`\n=== ${label}${meta} ===`);
  const client = new AcpClient(gw.url || gw);
  try {
    await client.connect();
    await client.initialize();
    const sess = await client.createSession(process.cwd());
    const models = extractModelsFromSessionResult(sess);

    const modelOpt = (sess.configOptions || []).find(o => o?.id === 'model');
    console.log(`currentValue: ${modelOpt?.currentValue ?? '(none)'}`);
    console.log(`models (${models.length}):`);
    for (const m of models) console.log(`  ${m.id.padEnd(32)} ${m.name}`);
    client.disconnect?.();
    return models;
  } catch (e) {
    console.log(`  ❌ ${e.message}`);
    return null;
  }
}

const targets = process.argv[2] ? [process.argv[2]] : activeGateways();
if (!targets.length) {
  console.log('No active gateways found (no session heartbeat within 10 min).');
  process.exit(0);
}
console.log(`Probing ${targets.length} gateway(s)…`);
for (const t of targets) await probe(t);
process.exit(0);

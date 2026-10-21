/**
 * 一次性诊断：dump session/new 完整返回结构，定位真实模型列表字段。
 *   node scripts/dump-session.js
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
        const hbAge = now - (d.lastHeartbeat || 0);
        if (!best || hbAge < best.hbAge) best = { url, hbAge };
      }
    } catch { /* ignore */ }
  }
  return best;
}

const gw = activeGateway();
if (!gw) { console.log('No active gateway'); process.exit(1); }
console.log(`Gateway: ${gw.url} (hb ${Math.round(gw.hbAge / 1000)}s ago)`);

const client = new AcpClient(gw.url);
await client.connect();
await client.initialize();
const sess = await client.createSession(process.cwd());

console.log('\n--- top-level keys:', Object.keys(sess));
console.log('--- sess.models (if any):', JSON.stringify(sess.models, null, 2)?.slice(0, 3000));
console.log('--- sess.modes (if any):', JSON.stringify(sess.modes, null, 2)?.slice(0, 3000));

const opts = sess.configOptions || [];
console.log(`\n--- configOptions: ${opts.length} entries`);
for (const o of opts) {
  console.log(`  id=${o.id} kind=${o.kind || o.type || '?'} entries=${Array.isArray(o.options) ? o.options.length : '-'}`);
  if (Array.isArray(o.options)) {
    for (const item of o.options.slice(0, 40)) {
      console.log(`      value=${item?.value}  name=${item?.name}`);
    }
  }
}
client.disconnect?.();
process.exit(0);

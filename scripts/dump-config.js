/**
 * 诊断：直连网关 dump session/new 的原始 configOptions，
 * 看 WorkBuddy 真实暴露了哪些配置组与模型值。
 * 用法：node scripts/dump-config.js
 */
import { AcpClient } from '../src/acp-client.js';
import { discoverGatewayUrl } from '../src/gateway-discovery.js';

const url = await discoverGatewayUrl();
const client = new AcpClient(url);

await client.connect();
await client.initialize();
const sess = await client.createSession(process.cwd());

console.log(`gateway: ${url}\n`);
console.log(`session/new 顶层字段: ${Object.keys(sess || {}).join(', ')}\n`);

// 顶层 models 字段（可能是完整模型清单，与 configOptions 的下拉可选项不同）
const topModels = sess?.models;
if (Array.isArray(topModels)) {
  console.log(`── 顶层 models 字段：${topModels.length} 项`);
  console.log(JSON.stringify(topModels, null, 2).slice(0, 3000));
  console.log('');
}

for (const opt of sess?.configOptions || []) {
  const vals = Array.isArray(opt.options) ? opt.options : [];
  console.log(`── configOption id=${opt.id}  (${opt.name || '-'})  category=${opt.category || '-'}  current=${JSON.stringify(opt.currentValue)}  options=${vals.length}`);
  for (const v of vals) {
    console.log(`     value=${JSON.stringify(v.value)}  name=${JSON.stringify(v.name)}`);
  }
  console.log('');
}

#!/usr/bin/env node
/**
 * models.js — 列出可配置的模型 id 及其计费。
 *
 * 数据取自代理的 /v1/models，最终来自网关 session/new 的 configOptions：
 * 每个模型的 description 标注了计费系数（x0.00 = 免费，x0.79 = 计费倍数）。
 * 因此这份清单随账号套餐自动更新，**不需要在代码里硬编码价格表**。
 *
 * 用法：
 *   node scripts/models.js          完整表格 + 各 agent 接入配置（控制台 [6]）
 *   node scripts/models.js --guide  仅打印接入配置（服务没启动也能看）
 *   node scripts/models.js --brief  简短摘要（启动器用）
 *   node scripts/models.js --json   原始 JSON
 */

import http from 'node:http';
import { agentGuideLines } from '../src/agent-guide.js';

const PORT = Number(process.env.PORT) || 8000;
const argv = new Set(process.argv.slice(2));
const MODE = argv.has('--json') ? 'json' : argv.has('--brief') ? 'brief' : argv.has('--guide') ? 'guide' : 'table';

/** 终端显示宽度：CJK 全角字符占 2 列，否则对齐会错位。 */
function displayWidth(s) {
  let n = 0;
  for (const ch of String(s)) {
    n += /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]/.test(ch) ? 2 : 1;
  }
  return n;
}

function pad(s, width) {
  const text = String(s ?? '');
  return text + ' '.repeat(Math.max(0, width - displayWidth(text)));
}

/** 按显示宽度折行，只在分隔符处断开（用于 MsgBox 这类宽度受限的场景）。 */
function wrapItems(items, width, sep = '、') {
  const lines = [];
  let line = '';
  for (const item of items) {
    const candidate = line ? line + sep + item : item;
    if (line && displayWidth(candidate) > width) { lines.push(line); line = item; }
    else line = candidate;
  }
  if (line) lines.push(line);
  return lines;
}

function fetchModels(timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const req = http.get(
      { hostname: '127.0.0.1', port: PORT, path: '/v1/models', timeout: timeoutMs },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { body += c; });
        res.on('end', () => {
          if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
          try {
            const json = JSON.parse(body);
            resolve(Array.isArray(json.data) ? json.data : []);
          } catch (e) { reject(new Error('响应不是合法 JSON')); }
        });
      }
    );
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('超时')); });
  });
}

/** 查询服务根端点，拿当前代理默认模型（失败不影响主流程，返回 null）。 */
function fetchServiceInfo(timeoutMs = 5000) {
  return new Promise((resolve) => {
    const req = http.get(
      { hostname: '127.0.0.1', port: PORT, path: '/', timeout: timeoutMs },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { body += c; });
        res.on('end', () => {
          try { resolve(JSON.parse(body)); } catch { resolve(null); }
        });
      }
    );
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

/** 排序：免费在前 → 收费按系数升序 → 网关未标注（不等于免费）。 */
function sortModels(models) {
  const rank = (m) => (m.pricing?.free ? 0 : m.pricing?.coefficient != null ? 1 : 2);
  return models
    .map((m, i) => ({ m, i }))
    .sort((a, b) => {
      const ra = rank(a.m), rb = rank(b.m);
      if (ra !== rb) return ra - rb;
      if (ra === 1) {
        const d = a.m.pricing.coefficient - b.m.pricing.coefficient;
        if (d !== 0) return d;
      }
      return a.i - b.i;
    })
    .map((x) => x.m);
}

/** 计费列文案：免费 / 系数 / 未标注 */
function billingOf(m) {
  if (m.pricing?.free) return { kind: '免费', coeff: `x${m.pricing.coefficient.toFixed(2)}` };
  if (m.pricing?.coefficient != null) return { kind: '收费', coeff: `x${m.pricing.coefficient.toFixed(2)}` };
  return { kind: '未标注', coeff: '—' };
}

let models;
let serviceInfo = null;
let fetchError = null;
const BASE_URL = `http://127.0.0.1:${PORT}/v1`;
try {
  if (MODE === 'table' || MODE === 'brief') {
    process.stderr.write('  正在查询模型列表…\n');
  }
  models = sortModels(await fetchModels());
  serviceInfo = await fetchServiceInfo();
} catch (e) {
  // 接入指南不依赖模型清单——服务没起也先把三件套教给用户
  if (MODE !== 'guide') {
    const msg = e.code === 'ECONNREFUSED'
      ? `服务未启动（127.0.0.1:${PORT} 无响应）。先启动服务再查看模型清单。`
      : `查询模型列表失败：${e.message}`;
    if (MODE === 'json') console.log(JSON.stringify({ ok: false, error: msg }, null, 2));
    else console.log(`  ${msg}`);
    process.exit(1);
  }
  fetchError = e;
}

const defaultModel = serviceInfo?.default_model || null;

// 接入配置指南：表格末尾追加；--guide 单独打印
function printGuide() {
  for (const line of agentGuideLines({ baseUrl: BASE_URL, defaultModel })) console.log(line);
}

if (MODE === 'guide') {
  if (fetchError) {
    const why = fetchError.code === 'ECONNREFUSED'
      ? `服务未启动（127.0.0.1:${PORT} 无响应）`
      : fetchError.message;
    console.log(`  ⚠️  实时模型清单取不到（${why}），以下按默认端口生成。`);
    console.log('');
  }
  printGuide();
  process.exit(0);
}

if (MODE === 'json') {
  console.log(JSON.stringify({ ok: true, count: models.length, default_model: defaultModel, data: models }, null, 2));
  process.exit(0);
}

const free = models.filter((m) => m.pricing?.free);
const paid = models.filter((m) => m.pricing?.coefficient != null && !m.pricing.free);
const unmarked = models.filter((m) => m.pricing?.coefficient == null);

if (MODE === 'brief') {
  // 启动器 MsgBox：只给结论，明细留给控制台 [6]
  const fmt = (m) => `${m.id}(x${m.pricing.coefficient.toFixed(2)})`;
  const lines = [`可用模型共 ${models.length} 个（完整清单与各 agent 接入配置：控制台 [6]）`];
  if (defaultModel) lines.push(`代理默认模型：${defaultModel}（客户端不指定 model 时使用）`);
  lines.push(free.length ? `免费：${free.map((m) => m.id).join('、')}` : '免费：无');
  if (paid.length) {
    const items = paid.map(fmt);
    items[0] = `收费：${items[0]}`;
    lines.push(...wrapItems(items, 56));
  }
  if (unmarked.length) {
    const items = unmarked.map((m) => m.id);
    items[0] = `未标注（按实际路由模型计费）：${items[0]}`;
    lines.push(...wrapItems(items, 56));
  }
  console.log(lines.join('\n'));
  process.exit(0);
}

// 完整表格
const idW = Math.max(displayWidth('模型 id'), ...models.map((m) => displayWidth(m.id)));
const nameW = Math.max(displayWidth('名称'), ...models.map((m) => displayWidth(m.name || '')));

console.log('');
console.log(`  ${pad('模型 id', idW)}  ${pad('名称', nameW)}  ${pad('计费', 6)}  系数`);
console.log(`  ${'-'.repeat(idW)}  ${'-'.repeat(nameW)}  ${'-'.repeat(6)}  ------`);
for (const m of models) {
  const b = billingOf(m);
  const mark = m.id === defaultModel ? '  ← 代理默认' : '';
  console.log(`  ${pad(m.id, idW)}  ${pad(m.name || '', nameW)}  ${pad(b.kind, 6)}  ${b.coeff}${mark}`);
}
console.log('');
console.log(`  共 ${models.length} 个：免费 ${free.length}、收费 ${paid.length}、未标注 ${unmarked.length}`);
if (defaultModel) {
  console.log(`  代理默认模型：${defaultModel}（客户端不指定 model 时使用，改 BUDDY2API_DEFAULT_MODEL 可换）`);
}
console.log('');
console.log('  说明：');
console.log('    · 系数是网关标注的相对倍数，x0.00 表示不消耗积分。');
console.log('    · 「未标注」不等于免费——auto 按它实际路由到的模型计费。');
console.log('    · 配置方式：客户端把 model 字段设为上面的任意 id，代理原样透传给网关。');
console.log('');
printGuide();

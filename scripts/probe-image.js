/**
 * probe-image.js — 实测 WorkBuddy 网关是否接受 ACP image content block。
 *
 * 目的：验证 image block 的字段名/格式（data+mimeType 还是 source{...}），
 * 以及当前默认模型是否真的能"看到"图。规范是猜的，这里实测。
 *
 * 用法：node scripts/probe-image.js [gatewayUrl]
 */
import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { AcpClient } from '../src/acp-client.js';

// ---------- 最小 PNG 编码器（无第三方依赖） ----------
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** 生成一张左红右蓝的 PNG，便于判断模型是否真的看到了像素内容。 */
function makePng(w = 64, h = 64) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 2;  // color type: truecolor RGB
  const raw = Buffer.alloc(h * (1 + w * 3));
  let o = 0;
  for (let y = 0; y < h; y++) {
    raw[o++] = 0; // filter: none
    for (let x = 0; x < w; x++) {
      const left = x < w / 2;
      raw[o++] = left ? 220 : 20;
      raw[o++] = 20;
      raw[o++] = left ? 20 : 220;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

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
  console.error('未找到活跃网关，可显式传入: node scripts/probe-image.js http://127.0.0.1:PORT');
  process.exit(1);
}

const png = makePng();
const b64 = png.toString('base64');
console.log(`[probe] gateway: ${url}`);
console.log(`[probe] 生成测试图 ${png.length} bytes (base64 ${b64.length} chars)`);

const client = new AcpClient(url);
await client.connect();
await client.initialize();
const sess = await client.createSession(process.cwd());

// 候选格式：ACP 规范的 data+mimeType。若网关报错，日志会暴露期望字段。
const variants = {
  'ACP 规范 (data+mimeType)': { type: 'image', data: b64, mimeType: 'image/png' },
  'source 嵌套格式': {
    type: 'image',
    source: { type: 'base64', media_type: 'image/png', data: b64 }
  }
};

for (const [label, block] of Object.entries(variants)) {
  console.log(`\n${'='.repeat(60)}\n[probe] 尝试: ${label}`);
  console.log(`[probe] block keys: ${Object.keys(block).join(', ')}`);

  const prompt = [
    { type: 'text', text: '这张图片左半部分和右半部分分别是什么颜色？只回答颜色，不要解释。' },
    block
  ];

  let sawAny = false;
  let answer = '';
  let err = null;
  try {
    for await (const ev of client.sendPrompt(prompt, sess.sessionId)) {
      if (ev?.error) {
        err = ev.error;
        break;
      }
      const u = ev?.params?.update;
      if (u?.sessionUpdate === 'agent_message_chunk') {
        sawAny = true;
        answer += typeof u.content === 'string' ? u.content : (u.content?.text || '');
      }
      if (u?.sessionUpdate === 'agent_thought_chunk') {
        const t = typeof u.content === 'string' ? u.content : (u.content?.text || '');
        if (t) answer += ` [思考] ${t}`;
      }
    }
  } catch (e) {
    err = { message: e.message };
  }

  if (err) {
    console.log(`[probe] ❌ 网关报错: ${JSON.stringify(err).slice(0, 600)}`);
  } else if (!sawAny) {
    console.log('[probe] ⚠️  流结束但没有任何内容（空结果 / 被丢弃）');
  } else {
    console.log(`[probe] ✅ 有回复: ${answer.slice(0, 400)}`);
    console.log(`[probe] 判定: ${/红|蓝|left|right|red|blue/i.test(answer) ? '模型看到了图像内容' : '模型未识别出图像内容（可能无视觉能力）'}`);
  }
}

try { await client.destroy?.(); } catch { /* ignore */ }
process.exit(0);

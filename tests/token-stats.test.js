/**
 * token-stats.js 单测（node:test，零依赖）。
 * 覆盖：record→summary 聚合、model/key 过滤、detail 倒序截断、
 * JSONL 持久化（写入 + 重启回放）、reset、关闭持久化。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TokenStats, estimateTokens, estimatePromptTokens, normalizeCache } from '../src/token-stats.js';

/** 建立独立临时目录，避免测试污染真实 data/token-usage.jsonl */
function tmpFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'token-stats-')), 'usage.jsonl');
}

const REC = (over = {}) => ({
  model: 'glm-5.3-flash',
  requestedModel: 'auto',
  promptTokens: 100,
  completionTokens: 20,
  key: 'k1',
  stream: true,
  ...over
});

describe('record → summary 聚合', () => {
  test('总量与按模型/按 key 聚合正确', () => {
    const s = new TokenStats({ file: 'off' });
    s.record(REC({ model: 'glm-5.3-flash', key: 'k1' }));
    s.record(REC({ model: 'glm-5.3-flash', key: 'k1' }));
    s.record(REC({ model: 'hy4-preview', promptTokens: 50, completionTokens: 10, key: 'k2' }));

    const sum = s.summary();
    assert.equal(sum.total.requests, 3);
    assert.equal(sum.total.prompt_tokens, 250);
    assert.equal(sum.total.completion_tokens, 50);
    assert.equal(sum.total.total_tokens, 300);

    const models = Object.fromEntries(sum.models.map(m => [m.model, m]));
    assert.equal(models['glm-5.3-flash'].requests, 2);
    assert.equal(models['glm-5.3-flash'].total_tokens, 240);
    assert.equal(models['hy4-preview'].total_tokens, 60);
    assert.ok(models['glm-5.3-flash'].last_used_at, '应有最后使用时间');

    const keys = Object.fromEntries(sum.keys.map(k => [k.key, k]));
    assert.equal(keys.k1.requests, 2);
    assert.equal(keys.k2.requests, 1);
  });

  test('usage 缺失按 0 计，不抛错', () => {
    const s = new TokenStats({ file: 'off' });
    const rec = s.record({ model: 'glm-5.3', key: 'k1' });
    assert.equal(rec.total_tokens, 0);
    assert.equal(rec.status, 'completed');
    assert.equal(rec.stream, false);
    assert.equal(rec.tool_calls, 0);
  });

  test('models 按 total_tokens 降序', () => {
    const s = new TokenStats({ file: 'off' });
    s.record(REC({ model: 'small', promptTokens: 10 }));
    s.record(REC({ model: 'big', promptTokens: 900 }));
    s.record(REC({ model: 'mid', promptTokens: 100 }));
    assert.deepEqual(s.summary().models.map(m => m.model), ['big', 'mid', 'small']);
  });
});

describe('summary/detail 过滤', () => {
  test('model 过滤同时匹配实际模型与请求模型', () => {
    const s = new TokenStats({ file: 'off' });
    s.record(REC({ model: 'glm-5.3-flash', requestedModel: 'auto' })); // 隐藏默认模型归因
    s.record(REC({ model: 'hy4-preview', requestedModel: 'hy4-preview' }));

    assert.equal(s.summary({ model: 'glm-5.3-flash' }).total.requests, 1);
    // requestedModel === 'glm-5.3-flash' 的记录也应命中（客户端视角）
    s.record(REC({ model: 'unknown', requestedModel: 'glm-5.3-flash', promptTokens: 1 }));
    assert.equal(s.summary({ model: 'glm-5.3-flash' }).total.requests, 2);
    assert.equal(s.summary({ model: 'hy4-preview' }).total.requests, 1);
  });

  test('key 过滤', () => {
    const s = new TokenStats({ file: 'off' });
    s.record(REC({ key: 'k1' }));
    s.record(REC({ key: 'k2', promptTokens: 5 }));
    assert.equal(s.summary({ key: 'k1' }).total.requests, 1);
    assert.equal(s.summary({ key: 'k1' }).total.prompt_tokens, 100);
  });

  test('detail 倒序 + limit + 过滤', () => {
    const s = new TokenStats({ file: 'off' });
    for (let i = 0; i < 5; i++) s.record(REC({ model: i % 2 ? 'a' : 'b' }));
    const all = s.detail({ limit: 10 });
    assert.equal(all.length, 5);
    assert.deepEqual(all.map(r => r.model), ['b', 'a', 'b', 'a', 'b'], '最新在前');

    const onlyA = s.detail({ limit: 2, model: 'a' });
    assert.equal(onlyA.length, 2);
    assert.ok(onlyA.every(r => r.model === 'a'));
  });
});

describe('estimateTokens 估算器', () => {
  test('CJK 1 字 ≈ 1 token，ASCII 4 字符 ≈ 1 token', () => {
    assert.equal(estimateTokens('你好世界'), 4);          // 4 CJK → 4
    assert.equal(estimateTokens('Hello'), 2);             // 5 ASCII → ceil(1.25)=2
    assert.equal(estimateTokens('你好 world'), 4);        // 2 CJK + 6 ASCII（含空格）→ 2+2=4
    assert.equal(estimateTokens(''), 0);
    assert.equal(estimateTokens(null), 0);
    assert.equal(estimateTokens('你好，世界。'), 6);      // CJK 标点也按 1 token
  });

  test('estimatePromptTokens 只算 text 块，跳过图片 base64', () => {
    const prompt = [
      { type: 'text', text: '看这张图' },
      { type: 'image', data: 'a'.repeat(10000), mimeType: 'image/png' },
      { type: 'text', text: 'Hello' }
    ];
    // '看这张图' 4 + 'Hello' 2 = 6；图片 base64 不计入
    assert.equal(estimatePromptTokens(prompt), 6);
    assert.equal(estimatePromptTokens('纯字符串'), 4);
    assert.equal(estimatePromptTokens(null), 0);
  });
});

describe('JSONL 持久化', () => {
  test('record 追加写文件，新实例回放恢复', async () => {
    const file = tmpFile();
    const s1 = new TokenStats({ file, load: false });
    s1.record(REC({ promptTokens: 111 }));
    s1.record(REC({ promptTokens: 222 }));
    await s1.flush(); // 异步串行写：落盘后再读

    const raw = fs.readFileSync(file, 'utf8').trim().split('\n');
    assert.equal(raw.length, 2);

    const s2 = new TokenStats({ file }); // load=true 默认回放
    assert.equal(s2.summary().total.requests, 2);
    assert.equal(s2.summary().total.prompt_tokens, 333);
  });

  test('load 截断到 cap，只保留最近记录', () => {
    const file = tmpFile();
    const lines = [];
    for (let i = 0; i < 10; i++) lines.push(JSON.stringify(REC({ promptTokens: i })));
    fs.writeFileSync(file, lines.join('\n') + '\n');

    const s = new TokenStats({ file, cap: 4 });
    assert.equal(s.detail({ limit: 100 }).length, 4);
    // 保留的是最近 4 条（prompt 6..9）
    assert.equal(s.summary().total.prompt_tokens, 6 + 7 + 8 + 9);
  });

  test("file='off' 不产生任何文件", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'token-stats-off-'));
    const before = fs.readdirSync(dir);
    const s = new TokenStats({ file: 'off', load: false });
    s.record(REC());
    s.reset();
    assert.deepEqual(fs.readdirSync(dir), before);
  });

  test('reset 清空内存并清空文件', async () => {
    const file = tmpFile();
    const s = new TokenStats({ file, load: false });
    s.record(REC());
    s.reset();
    await s.flush(); // 清空走写入链：等挂起的追加 + 截断完成
    assert.equal(s.summary().total.requests, 0);
    assert.equal(fs.readFileSync(file, 'utf8'), '');
  });

  test('文件目录不存在时自动创建', async () => {
    const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'token-stats-mk-')), 'nested/deeper');
    const file = path.join(dir, 'usage.jsonl');
    const s = new TokenStats({ file, load: false });
    s.record(REC());
    await s.flush();
    assert.ok(fs.existsSync(file));
  });
});

describe('normalizeCache 缓存口径归一化', () => {
  test('只报 cached → 由 prompt - cached 推 miss', () => {
    assert.deepEqual(normalizeCache(100, 88, undefined), { cached: 88, miss: 12 });
  });

  test('只报 miss → 由 prompt - miss 推 cached', () => {
    assert.deepEqual(normalizeCache(100, undefined, 12), { cached: 88, miss: 12 });
  });

  test('cached 误报 0 而 miss 准确 → 反推命中量', () => {
    assert.deepEqual(normalizeCache(22666, 0, 177), { cached: 22489, miss: 177 });
  });

  test('无缓存信息 → cached 0、miss = prompt（全量未命中口径）', () => {
    assert.deepEqual(normalizeCache(100, undefined, undefined), { cached: 0, miss: 100 });
  });

  test('全量命中（miss=0）→ cached = prompt', () => {
    assert.deepEqual(normalizeCache(100, 0, 0), { cached: 100, miss: 0 });
  });

  test('不变式：cached + miss == prompt', () => {
    for (const [p, c, m] of [[100, 88, undefined], [100, undefined, 12], [22666, 0, 177], [50, 0, 50]]) {
      const r = normalizeCache(p, c, m);
      assert.equal(r.cached + r.miss, p, `prompt=${p} cached=${c} miss=${m}`);
    }
  });
});

// ---------- 目录事后被删的自愈（架构深化第 8 批微修② / CR K1） ----------

test('目录事后被删 → 下一条记录自愈重建目录并落盘（CR K1）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'token-stats-k1-'));
  const file = path.join(dir, 'data', 'usage.jsonl');
  const ts = new TokenStats({ file, load: false });
  try {
    ts.record({ model: 'm', promptTokens: 1, completionTokens: 1 });
    await ts.flush();
    assert.ok(fs.existsSync(file), '前置：首条已落盘');

    fs.rmSync(path.join(dir, 'data'), { recursive: true, force: true }); // 模拟清理器删目录

    ts.record({ model: 'm', promptTokens: 2, completionTokens: 2 });
    await ts.flush();
    // 旧文件随目录一起被删；自愈重建后的文件只含本次记录（历史条目不可恢复，
    // 与旧行为「目录被删后全部静默丢弃」相比，损失从无界降为该一次删除窗口）
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
    assert.equal(lines.length, 1, '目录被删后下一条记录必须自愈重建并落盘（不得静默丢弃）');
    assert.equal(JSON.parse(lines[0]).prompt_tokens, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
/**
 * line-framer 特征测试（批9 #1）。
 *
 * 固化"收敛后的边界"：帧器切分结果必须与旧实现 `buffer.split('\n')` （每次
 * 追加后整串重扫、pop 掉不完整末行）逐字等价——只是把 O(n²) 降到 O(n)。
 * 覆盖：显式分片、随机分片等价、不完整末行保留、空/多行、\r\n 保留。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLineFramer } from '../src/line-framer.js';

/** 旧实现（openEventStream 原语义）参考实现。 */
function referenceFrame(chunks) {
  const out = [];
  let buffer = '';
  for (const chunk of chunks) {
    buffer += chunk;
    const parts = buffer.split('\n');
    buffer = parts.pop() || '';
    for (const p of parts) out.push(p);
  }
  return out;
}

function frameAll(chunks) {
  const framer = createLineFramer();
  const out = [];
  for (const chunk of chunks) out.push(...framer.push(chunk));
  return out;
}

test('line-framer：单 chunk 多行 → 全量切分、无残留', () => {
  assert.deepEqual(frameAll(['a\nb\nc\n']), ['a', 'b', 'c']);
});

test('line-framer：不完整末行保留到下一次 push 拼接', () => {
  const framer = createLineFramer();
  assert.deepEqual(framer.push('Endpoint http://127.0.0.'), []);
  assert.deepEqual(framer.push('1:50211\n'), ['Endpoint http://127.0.0.1:50211']);
});

test('line-framer：空 chunk 与末尾无换行均为 no-op', () => {
  const framer = createLineFramer();
  assert.deepEqual(framer.push(''), []);
  assert.deepEqual(framer.push('partial'), []);
  assert.deepEqual(framer.push(''), []);
});

test('line-framer：\\r\\n 时保留 \\r（与 split(\\n) 旧语义逐字一致）', () => {
  assert.deepEqual(frameAll(['a\r\nb\r\n']), ['a\r', 'b\r']);
});

test('line-framer：data: 前缀行整体透传（不剥离、不解析）', () => {
  assert.deepEqual(
    frameAll(['data: {"id":1}\ndata: {"id":2}\n']),
    ['data: {"id":1}', 'data: {"id":2}']
  );
});

test('line-framer：随机分片与旧实现逐字等价（确定性 LCG）', () => {
  let seed = 0x12345678;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;

  for (let iter = 0; iter < 200; iter++) {
    // 构造含多个换行的随机文本
    const total = 5 + Math.floor(rnd() * 60);
    let text = '';
    for (let i = 0; i < total; i++) {
      const r = rnd();
      text += r < 0.25 ? '\n' : r < 0.3 ? '\r' : String.fromCharCode(97 + Math.floor(rnd() * 26));
    }
    // 随机切成若干 chunk（含空 chunk）
    const chunks = [];
    let idx = 0;
    while (idx < text.length) {
      const n = Math.floor(rnd() * 5); // 可能为 0 → 空 chunk
      chunks.push(text.slice(idx, idx + n));
      idx += n;
      if (n === 0) { chunks.push(text[idx] || ''); idx += 1; }
    }
    chunks.push(''); // 收尾空 chunk

    assert.deepEqual(frameAll(chunks), referenceFrame(chunks), `iter=${iter} seed-state=${seed}`);
  }
});

test('line-framer：多实例相互隔离（各自游标独立）', () => {
  const a = createLineFramer();
  const b = createLineFramer();
  assert.deepEqual(a.push('x\ny'), ['x']);
  assert.deepEqual(b.push('p\nq'), ['p']);
  assert.deepEqual(a.push('\n'), ['y']);
  assert.deepEqual(b.push('\n'), ['q']);
});

/**
 * body-parser.test.js — 请求体解析（架构深化第 8 批 C6 出仓 + Buffer 化）。
 *
 * 白名单差异②（prd 验收 1）的行为钉：跨 chunk 分割的多字节 UTF-8 必须正确
 * 解码（旧字符串累加实现会在 chunk 边界产出 U+FFFD）。此测试同时是「防止
 * 将来被当回归 revert 回字符串累加」的守卫。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { parseBody, MAX_BODY_BYTES } from '../src/body-parser.js';

/** 模拟 req：按给定分片依次发 data，最后 end */
function fakeReq(chunks) {
  const req = new EventEmitter();
  req.destroy = () => { req.destroyed = true; };
  queueMicrotask(() => {
    for (const c of chunks) req.emit('data', Buffer.from(c));
    req.emit('end');
  });
  return req;
}

describe('parseBody', () => {
  test('白名单差异②：跨 chunk 分割的多字节 UTF-8 正确解码', async () => {
    const obj = { message: '你好世界', emoji: '🇨🇳👍', mixed: '中文abc🌍def' };
    const raw = Buffer.from(JSON.stringify(obj), 'utf8');
    // 在多字节序列中间切开（每个字节一片，最恶劣的分片方式）
    const slices = [];
    for (const b of raw) slices.push(Buffer.from([b]));
    const body = await parseBody(fakeReq(slices));
    assert.deepEqual(body, obj);
    assert.equal(body.message, '你好世界');
    assert.ok(!JSON.stringify(body).includes('\uFFFD'), '不得出现 U+FFFD 替换符');
  });

  test('常规单 chunk JSON 解析不变', async () => {
    const body = await parseBody(fakeReq([JSON.stringify({ a: 1, b: '文本' })]));
    assert.deepEqual(body, { a: 1, b: '文本' });
  });

  test('空体 → {}（既有口径）', async () => {
    assert.deepEqual(await parseBody(fakeReq([])), {});
  });

  test('非法 JSON → Invalid JSON body', async () => {
    await assert.rejects(
      () => parseBody(fakeReq(['{oops'])),
      /Invalid JSON body/
    );
  });

  test('超过 MAX_BODY_BYTES 上限 → 拒绝并销毁连接（既有口径）', async () => {
    const req = new EventEmitter();
    req.destroy = () => { req.destroyed = true; };
    const big = Buffer.alloc(MAX_BODY_BYTES + 1, 0x61); // 'a' * (上限+1)
    const p = parseBody(req);
    req.emit('data', big);
    await assert.rejects(p, /Request body too large/);
    assert.equal(req.destroyed, true, '超限必须断开连接');
  });

  test('请求错误透传 reject（既有口径）', async () => {
    const req = new EventEmitter();
    req.destroy = () => {};
    const p = parseBody(req);
    req.emit('error', new Error('boom'));
    await assert.rejects(p, /boom/);
  });
});

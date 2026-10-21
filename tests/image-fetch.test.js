/**
 * image-fetch.js 的 SSRF 防御矩阵（refactor-20260928-arch-deepening2 批2）。
 *
 * 该能力此前埋在 openai-handler 内且零测试；出仓后首批单测全部用**替身注入**
 * （dnsLookup / fetchImpl），不真联网。断言的是行为（拒绝/放行/错误消息），
 * 与实现形态无关。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertImageUrlAllowed, fetchImageAsDataUrl, resolveRemoteImages, MAX_REMOTE_IMAGE_BYTES } from '../src/image-fetch.js';

/** 替身 DNS：返回给定的地址表（或抛错模拟解析失败）。 */
function fakeDns(map) {
  return async (host) => {
    if (!(host in map)) throw new Error(`getaddrinfo ENOTFOUND ${host}`);
    return map[host].map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
  };
}

test('协议白名单：仅 http/https 放行，其余连 DNS 都不查', async () => {
  let lookedUp = false;
  const dnsLookup = async () => { lookedUp = true; return []; };
  await assert.rejects(() => assertImageUrlAllowed('ftp://example.com/x', { dnsLookup }),
    /仅允许 http\/https/);
  await assert.rejects(() => assertImageUrlAllowed('file:///etc/passwd', { dnsLookup }),
    /仅允许 http\/https/);
  assert.equal(lookedUp, false, '协议拒绝必须发生在 DNS 解析之前');
});

test('字面私网/环回/metadata 段拒绝', async () => {
  const dnsLookup = fakeDns({});
  for (const url of [
    'http://10.0.0.1/a.png',
    'http://127.0.0.1/a.png',
    'http://169.254.169.254/latest/meta-data/',
    'http://172.16.0.1/a.png',
    'http://172.31.255.255/a.png',
    'http://192.168.1.1/a.png',
    'http://0.0.0.0/a.png',
    'http://localhost/a.png'
  ]) {
    await assert.rejects(() => assertImageUrlAllowed(url, { dnsLookup }),
      /Blocked image host/, `${url} 应被拦截`);
  }
  // 边界：172.15 / 172.32 不在私网段
  await assertImageUrlAllowed('http://172.15.0.1/a.png', { dnsLookup: fakeDns({ '172.15.0.1': ['172.15.0.1'] }) });
});

test('DNS rebinding 防御：域名解析结果含私网地址即拒绝（含 IPv4-mapped IPv6 归一）', async () => {
  await assert.rejects(() => assertImageUrlAllowed('http://evil.example/a.png',
    { dnsLookup: fakeDns({ 'evil.example': ['93.184.216.34', '10.0.0.5'] }) }),
    /resolves to private/);
  await assert.rejects(() => assertImageUrlAllowed('http://evil.example/a.png',
    { dnsLookup: fakeDns({ 'evil.example': ['::ffff:192.168.0.1'] }) }),
    /→ ::ffff:192\.168\.0\.1/, 'IPv4-mapped IPv6 必须剥前缀后再判段');
  // 全部解析结果都是公网 → 放行
  await assertImageUrlAllowed('http://ok.example/a.png',
    { dnsLookup: fakeDns({ 'ok.example': ['93.184.216.34'] }) });
});

test('解析失败 → 明确报错（不静默放行）', async () => {
  await assert.rejects(() => assertImageUrlAllowed('http://nonexistent.example/a.png',
    { dnsLookup: fakeDns({}) }),
    /cannot be resolved/);
});

test('fetchImageAsDataUrl：成功路径转 data URL（content-type 归一 + base64）', async () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    arrayBuffer: async () => png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength),
    headers: { get: (k) => (k === 'content-type' ? 'image/png; charset=binary' : null) }
  });
  const dataUrl = await fetchImageAsDataUrl('http://ok.example/a.png',
    { fetchImpl, dnsLookup: fakeDns({ 'ok.example': ['93.184.216.34'] }) });
  assert.match(dataUrl, /^data:image\/png;base64,/);
});

test('fetchImageAsDataUrl：HTTP 错误 / 超限 / SSRF 拒绝三条失败路径', async () => {
  const dnsLookup = fakeDns({ 'ok.example': ['93.184.216.34'] });
  await assert.rejects(() => fetchImageAsDataUrl('http://ok.example/a.png',
    { fetchImpl: async () => ({ ok: false, status: 404, headers: { get: () => null } }), dnsLookup }),
    /HTTP 404/);

  const big = new ArrayBuffer(MAX_REMOTE_IMAGE_BYTES + 1);
  await assert.rejects(() => fetchImageAsDataUrl('http://ok.example/a.png',
    { fetchImpl: async () => ({ ok: true, status: 200, arrayBuffer: async () => big, headers: { get: () => 'image/png' } }), dnsLookup }),
    /超过上限/);

  await assert.rejects(() => fetchImageAsDataUrl('http://10.0.0.1/a.png',
    { fetchImpl: async () => { throw new Error('不应发起抓取'); } }),
    /Blocked image host/, 'SSRF 拦截必须发生在 fetch 之前');
});

test('resolveRemoteImages：http(s) image_url 就地换 data URL；无远程图零改动', async () => {
  const dnsLookup = fakeDns({ 'ok.example': ['93.184.216.34'] });
  const fetchImpl = async () => ({
    ok: true, status: 200,
    arrayBuffer: async () => new ArrayBuffer(4),
    headers: { get: () => 'image/webp' }
  });

  const messages = [{
    role: 'user',
    content: [
      { type: 'text', text: '看图' },
      { type: 'image_url', image_url: { url: 'http://ok.example/a.webp' } }
    ]
  }];
  const out = await resolveRemoteImages(messages, { fetchImpl, dnsLookup });
  assert.equal(out, messages, '就地变换：返回同一数组');
  assert.match(out[0].content[1].image_url.url, /^data:image\/webp;base64,/);

  const plain = [{ role: 'user', content: [{ type: 'text', text: '纯文本' }] }];
  assert.equal(await resolveRemoteImages(plain, { fetchImpl, dnsLookup }), plain);
  assert.equal(plain[0].content[0].type, 'text', '无远程图时不改动输入');

  // 非 http(s) 的 image_url（data: URL 已内联）不抓取
  const inline = [{ role: 'user', content: [{ type: 'image_url', image_url: 'data:image/png;base64,AAAA' }] }];
  await resolveRemoteImages(inline, { fetchImpl, dnsLookup });
  assert.equal(inline[0].content[0].image_url, 'data:image/png;base64,AAAA');
});

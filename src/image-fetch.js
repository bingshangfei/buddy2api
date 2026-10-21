/**
 * image-fetch.js — 远程图片抓取与 SSRF 防御（从 openai-handler.js 整体搬出，
 * refactor-20260928-arch-deepening2 批2；生产行为逐字节不变）。
 *
 * 模块自具一个完整能力：把 OpenAI image_url 块里的公网 http(s) 图片取回并转成
 * data URL（ACP image 块只接受 base64，uri 字段仅作显示名）。安全策略是本模块
 * 的核心职责：
 *   - 协议白名单（仅 http/https）
 *   - 字面私网/环回/链路本地/云 metadata 段拦截
 *   - DNS 全解析结果校验（防 DNS Rebinding / 域名指向内网 IP 绕过字面检查）
 *   - 单图大小上限 + 抓取超时
 *
 * 可测试性：`fetch` 与 `dns.lookup` 作可选参数注入（默认 = 全局实现，生产路径
 * 零行为差异）；单测用本地替身覆盖 SSRF 矩阵，不真联网。
 */

import dns from 'node:dns';

// 远程图片抓取上限：超时 15s、单图 10MB，避免把 WorkBuddy 的 prompt 撑爆
export const REMOTE_IMAGE_TIMEOUT_MS = 15 * 1000;
export const MAX_REMOTE_IMAGE_BYTES = 10 * 1024 * 1024;

// 私网/环回/链路本地/云 metadata 段：image_url 打这些地址等于把内网探测结果
// 回传给调用方（SSRF）。CORS 为 * 且支持 0.0.0.0 监听，网页可对本地监听器
// 发起 CSRF。确需抓内网图片：设 BUDDY2API_UNSAFE_ALLOW_PRIVATE_URLS=1。
const BLOCKED_IMAGE_HOST_RE = /^10\.|^127\.|^169\.254\.|^172\.(1[6-9]|2\d|3[01])\.|^192\.168\.|^0\.0\.0\.0$|^::1$|^f[cd][0-9a-f]:|^fe80/i;

/**
 * 校验图片 URL 的目标地址：仅允许公网 http(s)。
 * 先拦协议与字面私网地址，再解析 DNS 校验全部解析结果（防 DNS Rebinding /
 * 域名指向内网 IP 绕过字面检查）。
 *
 * @param {string} url
 * @param {{ dnsLookup?: Function }} [deps] 测试注入（默认 node:dns.promises.lookup）
 */
export async function assertImageUrlAllowed(url, { dnsLookup } = {}) {
  let u;
  try { u = new URL(url); } catch { throw new Error(`Invalid image URL: ${url}`); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error(`Blocked image URL scheme "${u.protocol}"（仅允许 http/https）`);
  }
  if (process.env.BUDDY2API_UNSAFE_ALLOW_PRIVATE_URLS === '1') return;
  const literalHost = /^[\d.]+$/.test(u.hostname) && BLOCKED_IMAGE_HOST_RE.test(u.hostname);
  if (literalHost || u.hostname.toLowerCase() === 'localhost') {
    throw new Error(`Blocked image host (private/loopback): ${u.hostname}`);
  }
  const lookup = dnsLookup || ((host, opts) => dns.promises.lookup(host, opts));
  let addrs;
  try {
    addrs = await lookup(u.hostname, { all: true });
  } catch {
    throw new Error(`Image host cannot be resolved: ${u.hostname}`);
  }
  for (const { address } of addrs) {
    const a = address.replace(/^::ffff:/, ''); // IPv4-mapped IPv6
    if (BLOCKED_IMAGE_HOST_RE.test(a)) {
      throw new Error(`Blocked image host (resolves to private/loopback/link-local): ${u.hostname} → ${address}`);
    }
  }
}

/**
 * 抓回远程图片并转成 data URL。
 * ACP image 块只接受 base64，uri 字段仅作显示名（WorkBuddy 不会去下载），
 * 所以客户端传 http(s) 图片时必须在这里取回。
 *
 * @param {string} url
 * @param {{ fetchImpl?: Function, dnsLookup?: Function }} [deps] 测试注入（默认全局 fetch / node:dns）
 * @throws 抓取失败/非图片/超限/目标为私网地址——让客户端看到明确原因，而不是让模型对着"看不见的图"瞎猜
 */
export async function fetchImageAsDataUrl(url, { fetchImpl, dnsLookup } = {}) {
  await assertImageUrlAllowed(url, { dnsLookup });
  const doFetch = fetchImpl || fetch;
  const res = await doFetch(url, { signal: AbortSignal.timeout(REMOTE_IMAGE_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_REMOTE_IMAGE_BYTES) {
    throw new Error(`图片 ${buf.length} 字节，超过上限 ${MAX_REMOTE_IMAGE_BYTES}`);
  }

  const mimeType = res.headers.get('content-type')?.split(';')[0]?.trim() || 'image/png';
  return `data:${mimeType};base64,${buf.toString('base64')}`;
}

/**
 * 把 content 中的远程图片 URL（http/https）就地换成 data URL。无远程图片时
 * 原样返回（零开销，也不改动输入）。失败直接抛出：图片是用户明确要求模型看
 * 的内容，抓不到就该报错——若静默丢弃会让模型在看不见图的情况下作答。
 *
 * @param {Array} messages OpenAI 消息数组（就地变换）
 * @param {{ fetchImpl?: Function, dnsLookup?: Function }} [deps] 测试注入
 */
export async function resolveRemoteImages(messages, deps = {}) {
  if (!Array.isArray(messages)) return messages;

  const pending = [];
  for (const msg of messages) {
    if (!msg || !Array.isArray(msg.content)) continue;
    for (const part of msg.content) {
      if (part?.type !== 'image_url') continue;
      const url = typeof part.image_url === 'string' ? part.image_url : part.image_url?.url;
      if (typeof url === 'string' && /^https?:\/\//i.test(url)) {
        pending.push({ part, url });
      }
    }
  }
  if (pending.length === 0) return messages;

  await Promise.all(pending.map(async ({ part, url }) => {
    const dataUrl = await fetchImageAsDataUrl(url, deps);
    if (typeof part.image_url === 'string') part.image_url = { url: dataUrl };
    else part.image_url.url = dataUrl;
  }));

  return messages;
}

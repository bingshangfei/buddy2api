/**
 * billing.js — CodeBuddy 计费网关余额查询 + 账户汇总。
 *
 * 从 account-info.js 拆出（refactor-20260926-arch-deepening 候选⑤）；
 * 凭据定位在 auth-credentials.js（本模块按需 import）。
 *
 * 余额来源：POST https://copilot.tencent.com/billing/meter/get-user-resource-summary
 *      Authorization: Bearer <accessToken>
 *    返回 data.Packages[]，每项含 CycleTotalCapacity / CycleRemainCapacity /
 *    CycleUsedCapacity / CapacityUnit。汇总即为"余额/总额/已用"。
 *
 * 所有网络/磁盘失败都收敛为 { ok:false, error }，绝不向上抛——
 * 账户信息只是启动时的展示，不应影响服务启动。
 */

import fs from 'node:fs';
import { authStatePath, parseAuthState, credentialOf, strOrNull } from './auth-credentials.js';

// 计费网关（个人用户余额）；可用 env 覆盖以便测试/私有部署
const DEFAULT_ENDPOINT = 'https://copilot.tencent.com';
// 余额查询超时（ms）
const BILLING_TIMEOUT_MS = 8_000;

/**
 * 汇总计费网关返回的 Packages（纯函数）。
 *
 * @param {object} data get-user-resource-summary 的 data 字段
 * @returns {{remaining: number, total: number, used: number, unit: string,
 *            isPaid: boolean, packages: Array<object>}}
 */
export function parseResourceSummary(data) {
  const packages = Array.isArray(data?.Packages) ? data.Packages : [];
  let remaining = 0;
  let total = 0;
  let used = 0;
  let unit = 'credits';
  const out = [];

  for (const p of packages) {
    const r = num(p?.CycleRemainCapacity);
    const t = num(p?.CycleTotalCapacity);
    const u = num(p?.CycleUsedCapacity);
    remaining += r;
    total += t;
    used += u;
    if (p?.CapacityUnit) unit = String(p.CapacityUnit);
    out.push({ code: String(p?.PackageCode ?? ''), remaining: round(r), total: round(t), used: round(u) });
  }

  return {
    remaining: round(remaining),
    total: round(total),
    // 已用优先用网关给出的值；缺失时用 总额-剩余 兜底
    used: round(used || Math.max(0, total - remaining)),
    unit,
    isPaid: Boolean(data?.IsPaidUser),
    packages: out
  };
}

/**
 * 查询账户 + 余额。
 *
 * @param {object} [opts]
 * @param {string} [opts.file] 登录态文件路径覆盖
 * @param {number} [opts.timeoutMs]
 * @param {typeof fetch} [opts.fetchImpl] 注入 fetch（测试用）
 * @param {number} [opts.now] 当前时间戳（测试用）
 * @returns {Promise<{ok: boolean, account: object|null, balance: object|null,
 *                    error?: string, fetchedAt: string}>}
 */
export async function getAccountSummary(opts = {}) {
  const file = opts.file || authStatePath();
  const fetchedAt = new Date(opts.now ?? Date.now()).toISOString();

  let state;
  try {
    state = parseAuthState(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    const reason = e?.code === 'ENOENT' ? '未找到登录态文件（尚未登录？）' : `读取登录态失败：${e.message}`;
    return { ok: false, account: null, balance: null, error: reason, reason: 'no-auth-file', authFile: file, fetchedAt };
  }

  // 展示字段归一：非 string（加密信封对象等）一律归 null——HTTP（/v1/account）
  // 与展示层共用本投影，避免对象字段外泄成 [object Object]。
  const account = state.account
    ? {
        uid: strOrNull(state.account.uid),
        nickname: strOrNull(state.account.nickname),
        uin: strOrNull(state.account.uin),
        type: strOrNull(state.account.type),
        enterpriseId: strOrNull(state.account.enterpriseId),
        enterpriseName: strOrNull(state.account.enterpriseName)
      }
    : null;

  // 凭据可用性判定（单点：auth-credentials.credentialOf）；加密格式在此早退、
  // 不发任何网络请求，并给机器可读的 reason（banner/脚本按 reason 分流文案）。
  const { token, reason: credReason } = credentialOf(state);
  if (credReason !== 'ok') {
    const error = credReason === 'encrypted'
      ? '登录态为加密格式（桌面端写入），当前版本暂不支持读取；如需刷新凭据请用 CLI 登录（node scripts/login.js）'
      : credReason === 'missing'
        ? '登录态缺少 accessToken'
        : '登录态 accessToken 类型异常（非字符串）';
    return { ok: false, account, balance: null, error, reason: credReason, authFile: file, fetchedAt };
  }

  const expiresAt = Number(state.auth?.expiresAt) || 0;
  if (expiresAt && (opts.now ?? Date.now()) >= expiresAt) {
    return { ok: false, account, balance: null, error: '登录态已过期，请在 CodeBuddy 中重新登录', reason: 'expired', authFile: file, fetchedAt };
  }

  try {
    const balance = await fetchBalance({ token, uid: account?.uid, ...opts });
    return { ok: true, account, balance, reason: 'ok', authFile: file, fetchedAt };
  } catch (e) {
    return { ok: false, account, balance: null, error: `余额查询失败：${e.message}`, reason: 'gateway', authFile: file, fetchedAt };
  }
}

/**
 * 调用计费网关拉取余额。
 *
 * @param {object} opts
 * @param {string} opts.token accessToken
 * @param {string} [opts.uid] 作为 X-User-Id 头（部分部署要求）
 * @param {string} [opts.endpoint]
 * @param {number} [opts.timeoutMs]
 * @param {typeof fetch} [opts.fetchImpl]
 */
export async function fetchBalance(opts) {
  const endpoint = (opts.endpoint || process.env.BUDDY2API_BILLING_ENDPOINT || DEFAULT_ENDPOINT).replace(/\/+$/, '');
  const fetchImpl = opts.fetchImpl || fetch;
  const timeoutMs = opts.timeoutMs ?? BILLING_TIMEOUT_MS;

  const headers = {
    'Authorization': `Bearer ${opts.token}`,
    'Accept-Language': 'zh',
    'Content-Type': 'application/json'
  };
  if (opts.uid) headers['X-User-Id'] = encodeURIComponent(opts.uid);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res;
  try {
    res = await fetchImpl(`${endpoint}/billing/meter/get-user-resource-summary`, {
      method: 'POST',
      headers,
      body: '{}',
      signal: ctrl.signal
    });
  } finally {
    clearTimeout(timer);
  }

  if (res.status === 401 || res.status === 403) {
    throw new Error(`登录态被拒绝（HTTP ${res.status}），请重新登录`);
  }
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }

  const body = await res.json();
  if (body?.code !== 0 || !body?.data) {
    throw new Error(`网关返回 code=${body?.code} msg=${body?.msg ?? ''}`);
  }
  return parseResourceSummary(body.data);
}

/**
 * 人类可读的账户 + 余额文本块（启动横幅 / 启动器 MsgBox 共用）。
 */
export function formatAccountSummary(summary) {
  const lines = [];
  const acc = summary?.account;
  if (acc) {
    lines.push(`账户：${typeof acc.nickname === 'string' && acc.nickname ? acc.nickname : '(未知)'}`);
    if (acc.uid) lines.push(`UID：${acc.uid}`);
    if (acc.type) lines.push(`类型：${acc.type}${acc.enterpriseName ? ` · ${acc.enterpriseName}` : ''}`);
  } else {
    lines.push('账户：未登录');
  }

  const b = summary?.balance;
  if (b) {
    lines.push(`余额：${b.remaining} / ${b.total} ${b.unit}（已用 ${b.used}）`);
  } else if (summary?.error) {
    lines.push(`余额：${summary.error}`);
  }
  return lines.join('\n');
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

// 保留两位小数，去掉浮点噪声（2008.23000068 → 2008.23）
function round(n) {
  return Math.round(n * 100) / 100;
}

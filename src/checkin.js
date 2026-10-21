/**
 * checkin.js — 每日签到领积分（多账号）。
 *
 * 接口（实测确认，来自 WorkBuddy 桌面端实现）：
 *   POST {endpoint}/billing/meter/checkin-activity-status   查询签到状态
 *   POST {endpoint}/billing/meter/daily-checkin             领取当日积分
 *   鉴权：Authorization: Bearer <accessToken>（与模型调用同一份凭据）
 *
 * 响应语义：
 *   code === 0      成功（领取时 data 含 credit / streak_days / is_streak_day）
 *   code === 10001  今天已签到（msg「今天已签到，请明天再来」）—— 正常情况，非错误
 *
 * 所有网络/协议失败都收敛为结果对象，不向上抛——签到是后台任务，
 * 单个账号失败不应影响其他账号。
 */

import { listAccounts } from './account-store.js';

/** 签到网关（与计费接口同域）；可用 env 覆盖以便测试/私有部署 */
const DEFAULT_ENDPOINT = 'https://copilot.tencent.com';
const TIMEOUT_MS = 15_000;

/** 「今天已签到」的业务码 */
export const ALREADY_CLAIMED_CODE = 10001;

function endpoint() {
  return (process.env.BUDDY2API_CHECKIN_ENDPOINT || DEFAULT_ENDPOINT).replace(/\/+$/, '');
}

function headersFor(account) {
  const h = {
    'Authorization': `Bearer ${account.accessToken}`,
    'Content-Type': 'application/json',
    'Accept-Language': 'zh'
  };
  if (account.uid) h['X-User-Id'] = encodeURIComponent(account.uid);
  return h;
}

/**
 * 底层 POST（统一超时与错误收敛）。
 *
 * @returns {Promise<{httpStatus: number, body: object|null, error: string|null}>}
 */
async function postJson(pathname, account, { timeoutMs = TIMEOUT_MS, fetchImpl = fetch } = {}) {
  try {
    const res = await fetchImpl(`${endpoint()}${pathname}`, {
      method: 'POST',
      headers: headersFor(account),
      body: '{}',
      signal: AbortSignal.timeout(timeoutMs)
    });
    const text = await res.text();
    let body = null;
    try { body = JSON.parse(text); } catch { /* 非 JSON */ }
    if (!body) return { httpStatus: res.status, body: null, error: `响应非 JSON（HTTP ${res.status}）: ${text.slice(0, 120)}` };
    return { httpStatus: res.status, body, error: null };
  } catch (e) {
    return { httpStatus: 0, body: null, error: e?.message || String(e) };
  }
}

/**
 * 把接口返回的签到状态归一化成 camelCase。
 */
export function normalizeStatus(d) {
  if (!d) return null;
  return {
    active: d.active ?? false,
    todayCheckedIn: d.today_checked_in ?? false,
    streakDays: d.streak_days ?? 0,
    dailyCredit: d.daily_credit ?? 0,
    todayCredit: d.today_credit ?? 0,
    isStreakDay: d.is_streak_day ?? false,
    nextStreakDay: d.next_streak_day ?? 0,
    streakBonusCredit: d.streak_bonus_credit ?? 0,
    totalCredits: d.total_credits ?? null,
    activityName: d.activity_name ?? null,
    checkinDates: Array.isArray(d.checkin_dates) ? d.checkin_dates : []
  };
}

/**
 * 查询单个账号的签到状态。
 *
 * @returns {Promise<{ok: boolean, status: object|null, error: string|null}>}
 */
export async function fetchCheckinStatus(account, opts = {}) {
  const { body, error } = await postJson('/billing/meter/checkin-activity-status', account, opts);
  if (error) return { ok: false, status: null, error };
  if (body.code !== 0 || !body.data) {
    return { ok: false, status: null, error: `code=${body.code} ${body.msg ?? ''}`.trim() };
  }
  return { ok: true, status: normalizeStatus(body.data), error: null };
}

/**
 * 领取当日签到积分。
 *
 * @returns {Promise<{ok: boolean, claimed: boolean, alreadyClaimed: boolean,
 *                    credit: number, streakDays: number, isStreakDay: boolean,
 *                    error: string|null}>}
 */
export async function claimDailyCheckin(account, opts = {}) {
  const { body, error, httpStatus } = await postJson('/billing/meter/daily-checkin', account, opts);
  const miss = (msg) => ({
    ok: false, claimed: false, alreadyClaimed: false, credit: 0, streakDays: 0, isStreakDay: false, error: msg
  });

  if (error) return miss(error);
  if (!body) return miss(`HTTP ${httpStatus} 空响应`);

  if (body.code === ALREADY_CLAIMED_CODE || /已签到/.test(body.msg || '')) {
    return { ok: true, claimed: false, alreadyClaimed: true, credit: 0, streakDays: 0, isStreakDay: false, error: null };
  }
  if (body.code !== 0) {
    return miss(`code=${body.code} ${body.msg ?? ''}`.trim());
  }

  const d = body.data ?? body;
  return {
    ok: true,
    claimed: true,
    alreadyClaimed: false,
    credit: d.credit ?? d.today_credit ?? 0,
    streakDays: d.streak_days ?? 0,
    isStreakDay: d.is_streak_day ?? false,
    error: null
  };
}

/**
 * 对一组账号执行签到（已签到的跳过）。
 *
 * 先用状态接口判断，避免无谓的领取请求；状态查不到时仍尝试领取
 * （宁可多试一次，也不要因为状态接口抖动而漏签）。
 *
 * @param {object} [opts]
 * @param {Array} [opts.accounts] 账号列表（默认读账号池）
 * @returns {Promise<Array<{account, claimed, alreadyClaimed, credit, streakDays, error}>>}
 */
export async function checkinAll({ accounts = null, ...opts } = {}) {
  const list = accounts || listAccounts();
  const results = [];

  for (const account of list) {
    const label = account.nickname || account.id;
    try {
      const st = await fetchCheckinStatus(account, opts);
      if (st.ok && st.status?.todayCheckedIn) {
        results.push({
          account: label,
          claimed: false,
          alreadyClaimed: true,
          credit: st.status.todayCredit,
          streakDays: st.status.streakDays,
          error: null
        });
        continue;
      }
      if (st.ok && st.status?.active === false) {
        results.push({ account: label, claimed: false, alreadyClaimed: false, credit: 0, streakDays: 0, error: '签到活动未开启' });
        continue;
      }

      const claim = await claimDailyCheckin(account, opts);
      results.push({
        account: label,
        claimed: claim.claimed,
        alreadyClaimed: claim.alreadyClaimed,
        credit: claim.credit,
        streakDays: claim.streakDays,
        error: claim.error
      });
    } catch (e) {
      results.push({ account: label, claimed: false, alreadyClaimed: false, credit: 0, streakDays: 0, error: e?.message || String(e) });
    }
  }

  return results;
}

/**
 * 人类可读的签到结果。
 */
export function formatCheckinResults(results) {
  if (!results.length) return '（没有可签到的账号）';
  const lines = [];
  let got = 0;

  for (const r of results) {
    if (r.error) {
      lines.push(`   ❌ ${r.account} — ${r.error}`);
    } else if (r.claimed) {
      got += r.credit;
      const bonus = r.streakDays ? `，连续 ${r.streakDays} 天` : '';
      lines.push(`   ✅ ${r.account} — 领取 ${r.credit} 积分${bonus}`);
    } else if (r.alreadyClaimed) {
      lines.push(`   ⏭️  ${r.account} — 今日已签到${r.streakDays ? `（连续 ${r.streakDays} 天）` : ''}`);
    }
  }
  if (got > 0) lines.push(`   合计新增 ${got} 积分`);
  return lines.join('\n');
}

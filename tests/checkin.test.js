/**
 * 签到模块单测（node:test，零依赖）。
 *
 * 通过注入 fetchImpl 隔离网络；覆盖：状态解析、正常领取、重复领取（code 10001）、
 * 接口报错、活动未开启、多账号聚合、结果格式化。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeStatus,
  fetchCheckinStatus,
  claimDailyCheckin,
  checkinAll,
  formatCheckinResults,
  ALREADY_CLAIMED_CODE
} from '../src/checkin.js';

const ACC = { id: 'u1', nickname: '测试账号', uid: 'u1', accessToken: 'tok' };

/** 造一个按路径返回预设响应的 fetch 假实现 */
function mockFetch(routes) {
  return async (url) => {
    for (const [pattern, resp] of Object.entries(routes)) {
      if (url.includes(pattern)) {
        const status = resp.httpStatus ?? 200;
        const body = typeof resp.body === 'string' ? resp.body : JSON.stringify(resp.body);
        return { status, ok: status >= 200 && status < 300, text: async () => body };
      }
    }
    throw new Error(`unmocked url: ${url}`);
  };
}

test('normalizeStatus: 下划线字段转 camelCase 并补默认值', () => {
  const s = normalizeStatus({ active: true, today_checked_in: true, streak_days: 7, today_credit: 100 });
  assert.equal(s.active, true);
  assert.equal(s.todayCheckedIn, true);
  assert.equal(s.streakDays, 7);
  assert.equal(s.todayCredit, 100);
  assert.equal(s.isStreakDay, false, '缺失字段应补默认值');
  assert.deepEqual(s.checkinDates, []);
});

test('fetchCheckinStatus: code=0 时有状态', async () => {
  const r = await fetchCheckinStatus(ACC, {
    fetchImpl: mockFetch({
      'checkin-activity-status': {
        body: { code: 0, msg: 'OK', data: { active: true, today_checked_in: false, streak_days: 3, today_credit: 100 } }
      }
    })
  });
  assert.equal(r.ok, true);
  assert.equal(r.status.todayCheckedIn, false);
  assert.equal(r.status.streakDays, 3);
});

test('fetchCheckinStatus: code!=0 → ok:false 带错误信息', async () => {
  const r = await fetchCheckinStatus(ACC, {
    fetchImpl: mockFetch({ 'checkin-activity-status': { body: { code: 500, msg: '服务异常' } } })
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /500/);
});

test('fetchCheckinStatus: 网络异常 → ok:false 不抛出', async () => {
  const r = await fetchCheckinStatus(ACC, {
    fetchImpl: async () => { throw new Error('socket hang up'); }
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /socket hang up/);
});

test('claimDailyCheckin: code=0 → claimed 并带积分与连续天数', async () => {
  const r = await claimDailyCheckin(ACC, {
    fetchImpl: mockFetch({ 'daily-checkin': { body: { code: 0, data: { credit: 100, streak_days: 11, is_streak_day: false } } } })
  });
  assert.equal(r.ok, true);
  assert.equal(r.claimed, true);
  assert.equal(r.credit, 100);
  assert.equal(r.streakDays, 11);
});

test('claimDailyCheckin: code=10001（今天已签到）→ 视为成功但未领取', async () => {
  const r = await claimDailyCheckin(ACC, {
    fetchImpl: mockFetch({
      'daily-checkin': { httpStatus: 400, body: { code: ALREADY_CLAIMED_CODE, msg: '今天已签到，请明天再来' } }
    })
  });
  assert.equal(r.ok, true, '已签到不是错误');
  assert.equal(r.claimed, false);
  assert.equal(r.alreadyClaimed, true);
  assert.equal(r.error, null);
});

test('claimDailyCheckin: 文案含「已签到」也识别为已签到（不依赖 code）', async () => {
  const r = await claimDailyCheckin(ACC, {
    fetchImpl: mockFetch({ 'daily-checkin': { httpStatus: 400, body: { code: 99999, msg: '今天已签到' } } })
  });
  assert.equal(r.alreadyClaimed, true);
  assert.equal(r.ok, true);
});

test('claimDailyCheckin: 其他业务错误 → ok:false 带原因', async () => {
  const r = await claimDailyCheckin(ACC, {
    fetchImpl: mockFetch({ 'daily-checkin': { body: { code: 403, msg: '账号无权限' } } })
  });
  assert.equal(r.ok, false);
  assert.equal(r.claimed, false);
  assert.match(r.error, /无权限/);
});

test('checkinAll: 已签到账号跳过、未签到账号领取', async () => {
  const accounts = [
    { id: 'a', nickname: 'A', uid: 'a', accessToken: 't' },
    { id: 'b', nickname: 'B', uid: 'b', accessToken: 't' }
  ];
  let claims = 0;
  const fetchImpl = async (url, init) => {
    // 用 token 区分账号
    const isA = url.includes('checkin-activity-status') && init.headers['X-User-Id'] === 'a';
    if (url.includes('checkin-activity-status')) {
      return {
        status: 200, ok: true,
        text: async () => JSON.stringify({
          code: 0,
          data: { active: true, today_checked_in: isA, streak_days: isA ? 5 : 0, today_credit: 100 }
        })
      };
    }
    claims++;
    return { status: 200, ok: true, text: async () => JSON.stringify({ code: 0, data: { credit: 100, streak_days: 1 } }) };
  };

  const results = await checkinAll({ accounts, fetchImpl });
  assert.equal(results.length, 2);
  assert.equal(results[0].alreadyClaimed, true, 'A 已签到应跳过');
  assert.equal(results[1].claimed, true, 'B 未签到应领取');
  assert.equal(claims, 1, '只应对 B 发起领取请求');
});

test('checkinAll: 活动未开启时不尝试领取', async () => {
  let claims = 0;
  const fetchImpl = async (url) => {
    if (url.includes('checkin-activity-status')) {
      return { status: 200, ok: true, text: async () => JSON.stringify({ code: 0, data: { active: false } }) };
    }
    claims++;
    return { status: 200, ok: true, text: async () => JSON.stringify({ code: 0, data: {} }) };
  };
  const results = await checkinAll({ accounts: [ACC], fetchImpl });
  assert.equal(claims, 0, '活动未开启不应发起领取');
  assert.match(results[0].error, /未开启/);
});

test('checkinAll: 状态接口异常时仍尝试领取（避免漏签）', async () => {
  let claims = 0;
  const fetchImpl = async (url) => {
    if (url.includes('checkin-activity-status')) {
      return { status: 500, ok: false, text: async () => 'boom' };
    }
    claims++;
    return { status: 200, ok: true, text: async () => JSON.stringify({ code: 0, data: { credit: 100, streak_days: 2 } }) };
  };
  const results = await checkinAll({ accounts: [ACC], fetchImpl });
  assert.equal(claims, 1, '状态查不到也应尝试领取');
  assert.equal(results[0].claimed, true);
});

test('formatCheckinResults: 汇总新增积分，跳过的不计入', () => {
  const txt = formatCheckinResults([
    { account: 'A', claimed: true, alreadyClaimed: false, credit: 100, streakDays: 11, error: null },
    { account: 'B', claimed: false, alreadyClaimed: true, credit: 0, streakDays: 3, error: null },
    { account: 'C', claimed: false, alreadyClaimed: false, credit: 0, streakDays: 0, error: '登录态过期' }
  ]);
  assert.match(txt, /A — 领取 100 积分，连续 11 天/);
  assert.match(txt, /B — 今日已签到/);
  assert.match(txt, /C — 登录态过期/);
  assert.match(txt, /合计新增 100 积分/);
});

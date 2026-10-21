#!/usr/bin/env node
/**
 * checkin.js — 每日签到 CLI。
 *
 * 用法：
 *   node scripts/checkin.js              对账号池里所有账号签到（已签到自动跳过）
 *   node scripts/checkin.js --status     只查询状态，不领取
 *   node scripts/checkin.js --json       JSON 输出（供计划任务/监控消费）
 *
 * 退出码：0 = 全部成功（含"已签到"）；1 = 有账号签到失败
 *
 * 自动签到：
 *   npm run checkin:install-task    注册 Windows 计划任务，每天定时自动签到
 *   npm run checkin:remove-task     移除计划任务
 */

import { listAccounts } from '../src/account-store.js';
import {
  fetchCheckinStatus,
  checkinAll,
  formatCheckinResults
} from '../src/checkin.js';

const asJson = process.argv.includes('--json');
const statusOnly = process.argv.includes('--status');

const accounts = listAccounts();

if (accounts.length === 0) {
  if (asJson) {
    process.stdout.write(JSON.stringify({ ok: false, error: '账号池为空', results: [] }, null, 2) + '\n');
  } else {
    console.error('账号池为空。先运行：node scripts/accounts.js import');
  }
  process.exit(1);
}

const stamp = new Date().toLocaleString('zh-CN', { hour12: false });

if (statusOnly) {
  const out = [];
  for (const a of accounts) {
    const r = await fetchCheckinStatus(a);
    out.push({
      account: a.nickname || a.id,
      ok: r.ok,
      todayCheckedIn: r.status?.todayCheckedIn ?? null,
      streakDays: r.status?.streakDays ?? null,
      todayCredit: r.status?.todayCredit ?? null,
      error: r.error
    });
  }

  if (asJson) {
    process.stdout.write(JSON.stringify({ at: stamp, status: out }, null, 2) + '\n');
  } else {
    console.log(`签到状态（${stamp}）`);
    console.log('');
    for (const s of out) {
      if (!s.ok) {
        console.log(`   ❌ ${s.account} — ${s.error}`);
      } else {
        console.log(`   ${s.todayCheckedIn ? '✅ 今日已签到' : '⏳ 今日未签到'}  ${s.account}${s.streakDays ? ` — 连续 ${s.streakDays} 天` : ''}`);
      }
    }
  }
  process.exit(out.every((s) => s.ok) ? 0 : 1);
}

// 执行签到
const results = await checkinAll({ accounts });
const failed = results.filter((r) => r.error);

if (asJson) {
  process.stdout.write(JSON.stringify({
    at: stamp,
    ok: failed.length === 0,
    totalCredit: results.reduce((s, r) => s + (r.credit || 0), 0),
    results
  }, null, 2) + '\n');
} else {
  console.log(`每日签到（${stamp}）`);
  console.log('');
  console.log(formatCheckinResults(results));
}

process.exit(failed.length === 0 ? 0 : 1);

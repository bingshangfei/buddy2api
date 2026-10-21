#!/usr/bin/env node
/**
 * status.js — 控制台顶部的一行式状态概览。
 *
 * 输出紧凑（控制台菜单上方展示），所有数据都是本地/轻量查询：
 *   服务状态 · 后端进程数 · 账号池摘要 · 签到状态
 *
 * 设计约束：不能慢。账号余额探活要联网，这里**不查余额**（那是 accounts 命令的事），
 * 只用本地已存的信息，保证控制台秒开。
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { listAccounts } from '../src/account-store.js';

const PORT = Number(process.env.PORT) || 8000;
const POOL_FILE = path.join(os.tmpdir(), 'buddy2api', 'backends.json');

// 版本号：从 package.json 读取（scripts/status.js → 上一级是项目根）
function getVersion() {
  try {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    return JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version || 'unknown';
  } catch { return 'unknown'; }
}
const VERSION = getVersion();

function checkService(timeoutMs = 1200) {
  return new Promise((resolve) => {
    const req = http.get({ hostname: '127.0.0.1', port: PORT, path: '/', timeout: timeoutMs }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

function backendCount() {
  try {
    const arr = JSON.parse(fs.readFileSync(POOL_FILE, 'utf8'));
    return Array.isArray(arr) ? arr.length : 0;
  } catch { return 0; }
}

const running = await checkService();
const accounts = listAccounts();

// 服务状态
console.log(`   版本   : v${VERSION}`);
console.log(`   服务   : ${running ? `运行中  http://127.0.0.1:${PORT}/v1` : '未运行'}`);

// 后端
if (running) {
  const n = backendCount();
  console.log(`   后端   : ${n > 0 ? `${n} 个进程（并发请求各占一个）` : '空闲（首个请求时拉起）'}`);
}

// 账号池
if (accounts.length === 0) {
  console.log('   账号   : 未配置（使用当前登录态）');
} else {
  const names = accounts.map((a) => a.nickname || a.id).join('、');
  console.log(`   账号   : ${accounts.length} 个 — ${names}`);
}

// 签到：从日志抓最近一次执行的时间，判断是不是今天
try {
  const logFile = path.join(os.tmpdir(), 'buddy2api-checkin.log');
  if (fs.existsSync(logFile)) {
    const lines = fs.readFileSync(logFile, 'utf8').trim().split(/\r?\n/);
    const stamps = lines.filter((l) => l.includes('每日签到（'));
    const last = stamps.slice(-1)[0];
    if (last) {
      const m = last.match(/每日签到（(.+?)）/);
      const when = m ? m[1] : '';
      const today = new Date().toLocaleDateString('zh-CN');
      const isToday = when.includes(today);
      console.log(`   签到   : ${isToday ? '今日已执行' : '今日尚未执行'}（最近 ${when}）`);
    }
  }
} catch { /* 签到日志读不到就不显示 */ }

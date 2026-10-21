#!/usr/bin/env node
/**
 * account.js — 查询并打印账户信息 + 积分余额后退出。
 *
 * 用途：启动器（scripts/start.vbs）同步调用，把结果展示在弹窗里；
 * 也可手动运行查看当前余额。
 *
 *   node scripts/account.js          人类可读文本
 *   node scripts/account.js --json   JSON（含 packages 明细）
 *
 * 独立于 src/index.js：不加载 HTTP 服务 / 会话管理 / 统计，输出干净。
 * 退出码：0 = 查询成功，1 = 查询失败（未登录 / 过期 / 网络错误）。
 */

import { getAccountSummary, formatAccountSummary } from '../src/account-info.js';

const summary = await getAccountSummary();

if (process.argv.includes('--json')) {
  process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
} else {
  process.stdout.write(formatAccountSummary(summary) + '\n');
}

process.exit(summary.ok ? 0 : 1);

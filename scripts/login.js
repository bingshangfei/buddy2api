#!/usr/bin/env node
/**
 * login.js — 登录状态检查与登录引导。
 *
 * 场景：在一台**没装 WorkBuddy 桌面端**的新电脑上部署 buddy2api。
 * 后端 CLI（vendor/codebuddy-cli，约 94MB）由安装向导或 `npm run vendor:update`
 * 从本机 WorkBuddy 拷贝就位（不入 git 仓库），CLI 可用后缺的只是登录态（账号凭据）。
 *
 * 用法：
 *   node scripts/login.js            检查登录状态；未登录时打印引导
 *   node scripts/login.js --open     未登录时直接拉起交互式 CLI 登录
 *   node scripts/login.js --json     输出 JSON（供启动器解析）
 *
 * 退出码：0 = 已登录可用；2 = 未登录（需要登录）；1 = 其他错误
 *
 * 登录原理：
 *   CLI 的登录入口是**交互式终端**里的 `/login` 命令（非交互模式会直接报
 *   "Authentication required. Please use /login command"）。登录成功后凭据写入
 *   CodeBuddyExtension/Data/Public/auth/workbuddy-desktop*.info。
 *   buddy2api 与该 CLI 共用这份凭据，所以登录一次即可。
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getAccountSummary, authDir, authStatePath } from '../src/account-info.js';
import { findCli } from '../src/cli-paths.js';
import { accountPool } from '../src/account-pool.js';
import fs from 'node:fs';

const projectRoot = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const asJson = process.argv.includes('--json');
const shouldOpen = process.argv.includes('--open');

/**
 * 登录引导文案。
 */
function guidance(cliPath, reason = null) {
  const lines = [];
  if (reason === 'encrypted') {
    lines.push('⚠️  登录态为加密格式（桌面端新版写入），当前版本无法读取。');
    lines.push('');
    lines.push('这不是「未登录」——但要让本工具读取/刷新凭据，需要一次 CLI 登录（会写出明文凭据）：');
  } else {
    lines.push('⚠️  尚未登录 — 无法调用模型。');
    lines.push('');
    lines.push('登录方法（不需要安装 WorkBuddy 桌面端）：');
  }
  lines.push('');
  lines.push('  方式 1：运行下面的命令，在弹出的界面里输入 /login');
  lines.push('');
  if (cliPath) {
    lines.push(`    "${process.execPath}" "${cliPath}"`);
  } else {
    lines.push('    （未找到 codebuddy CLI，请先检查 vendor/ 目录）');
  }
  lines.push('');
  lines.push('  方式 2：用本脚本直接拉起登录界面');
  lines.push('');
  lines.push('    node scripts/login.js --open');
  lines.push('');
  lines.push('  方式 3：从另一台已登录的机器复制凭据文件（仅限 CLI 登录产出的明文凭据）');
  lines.push('');
  lines.push(`    源：<已登录机器>/${path.join('CodeBuddyExtension', 'Data', 'Public', 'auth', 'workbuddy-desktop.info')}`);
  lines.push(`    目标：${authDir()}`);
  lines.push('');
  lines.push('登录完成后重新运行本脚本，或直接启动服务。');
  return lines.join('\n');
}

/**
 * 已登录时提示账号池能力：用户往往不知道可以配多个账号摊配额。
 */
function printPoolHint() {
  try {
    const pool = accountPool.accounts({ force: true });
    process.stdout.write('\n');
    if (pool.length === 0) {
      process.stdout.write('💡 可以把账号加入账号池，支持多账号轮转与自动故障转移：\n');
      process.stdout.write(`     node "${path.join(projectRoot, 'scripts', 'accounts.js')}" import\n`);
    } else if (pool.length === 1) {
      process.stdout.write(`💡 账号池当前只有 1 个账号。再添加一个即可：\n`);
      process.stdout.write('     · 摊开配额 —— 多个账号轮流使用，可支撑更高请求量\n');
      process.stdout.write('     · 故障转移 —— 某账号频控(429)或额度用尽时自动切换，服务不中断\n');
      process.stdout.write(`     node "${path.join(projectRoot, 'scripts', 'accounts.js')}" add\n`);
    } else {
      process.stdout.write(`💡 账号池已配置 ${pool.length} 个账号，请求会轮流使用。\n`);
      process.stdout.write(`     node "${path.join(projectRoot, 'scripts', 'accounts.js')}"        # 查看账号与余额\n`);
    }
  } catch { /* 提示失败不影响主流程 */ }
}

// --- main ---

const summary = await getAccountSummary();

if (summary.ok) {
  if (asJson) {
    process.stdout.write(JSON.stringify({ loggedIn: true, ...summary }, null, 2) + '\n');
  } else {
    process.stdout.write('✅ 已登录\n\n');
    process.stdout.write(`   账户：${summary.account?.nickname ?? '(未知)'}\n`);
    if (summary.account?.uid) process.stdout.write(`   UID：${summary.account.uid}\n`);
    if (summary.balance) {
      process.stdout.write(`   余额：${summary.balance.remaining} / ${summary.balance.total} ${summary.balance.unit}（已用 ${summary.balance.used}）\n`);
    }
    process.stdout.write(`\n   凭据：${summary.authFile}\n`);
    printPoolHint();
  }
  process.exit(0);
}

// 未登录 / 不可读
const cliPath = findCli();
const isMissingAuth = !fs.existsSync(summary.authFile);

if (asJson) {
  process.stdout.write(JSON.stringify({
    loggedIn: false,
    missingAuthFile: isMissingAuth,
    reason: summary.reason ?? null,
    error: summary.error,
    authFile: summary.authFile,
    authDir: authDir(),
    cliPath
  }, null, 2) + '\n');
} else {
  process.stdout.write(guidance(cliPath, summary.reason) + '\n');
  if (summary.error && summary.reason !== 'encrypted') {
    process.stdout.write(`   （原因：${summary.error}）\n`);
  }
}

if (shouldOpen) {
  if (!cliPath) {
    process.stderr.write('\n❌ 找不到 codebuddy CLI，无法自动拉起登录。\n');
    process.exit(1);
  }
  process.stdout.write(`\n正在启动 CLI 登录界面…（在界面里输入 /login，完成后关闭窗口）\n`);
  process.stdout.write(`CLI: ${cliPath}\n\n`);

  // 在独立窗口里启动交互式 CLI（stdio: inherit 让用户可以真正交互）
  const child = spawn(process.execPath, [cliPath], {
    cwd: projectRoot,
    stdio: 'inherit',
    env: process.env
  });

  child.on('exit', async (code) => {
    // 登录完成后复查
    const after = await getAccountSummary();
    if (after.ok) {
      process.stdout.write(`\n✅ 登录成功：${after.account?.nickname ?? '(未知)'}\n`);
      process.exit(0);
    }
    if (after.reason === 'encrypted') {
      process.stdout.write('\n⚠️  仍未检测到可读登录态：当前凭据为加密格式（桌面端写入）。\n');
      process.stdout.write('   桌面端若在运行，可能刚把凭据文件改写回加密格式；可关闭它后重试。\n');
    } else {
      process.stdout.write('\n⚠️  仍未检测到有效登录态。\n');
    }
    process.stdout.write(`   凭据目录：${authDir()}\n`);
    process.exit(2);
  });

  child.on('error', (e) => {
    process.stderr.write(`\n❌ 启动 CLI 失败：${e.message}\n`);
    process.exit(1);
  });
} else {
  process.exit(2);
}

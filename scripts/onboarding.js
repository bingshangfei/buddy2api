#!/usr/bin/env node
/**
 * onboarding.js — 安装后的初始化向导（安装包完成页自动拉起，也可随时手动运行）。
 *
 * 流程：
 *   1. 环境自检（Node 运行时、端口 8000）
 *   2. 后端 CLI 就位（从本机 WorkBuddy 拷贝 codebuddy CLI 到安装目录并钉死）
 *   3. 登录账号（未登录时拉起交互式 CLI，在界面里输入 /login 完成登录）
 *   4. 启动服务并验证 http://127.0.0.1:8000
 *   5. 可选自动化：开机自动启动、每日自动签到（领积分）
 *
 * 用法：
 *   node scripts/onboarding.js           交互式向导
 *   node scripts/onboarding.js --yes     非交互模式（静默安装用，自动化项按默认启用）
 *
 * 退出码：0 = 完成（允许带非致命警告）；1 = 服务未能启动等硬失败。
 *
 * 复用关系：CLI 拷贝走 scripts/vendor-cli.js（含拷贝后完整性自检）、登录走
 * scripts/login.js --open（含登录后复查）、启动走 scripts/service.js start
 * （含端口就绪等待），这里只做编排与文案。
 */

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import readline from 'node:readline/promises';
import { getAccountSummary } from '../src/account-info.js';
import { findSystemCliSource } from '../src/cli-paths.js';

const projectRoot = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const Scripts = path.join(projectRoot, 'scripts');
const yesMode = process.argv.includes('--yes');
const interactive = !yesMode && Boolean(process.stdin.isTTY);

function hr() { return '─'.repeat(52); }
function step(n, title) {
  process.stdout.write(`\n${hr()}\n  第 ${n} 步 / 共 5 步：${title}\n${hr()}\n\n`);
}
function ok(msg) { process.stdout.write(`  ✅ ${msg}\n`); }
function warn(msg) { process.stdout.write(`  ⚠️  ${msg}\n`); }
function fail(msg) { process.stdout.write(`  ❌ ${msg}\n`); }

async function ask(question, defaultValue = true) {
  if (!interactive) return defaultValue;
  const hint = defaultValue ? '[Y/n]' : '[y/N]';
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const ans = (await rl.question(`  ${question} ${hint}: `))?.trim() ?? '';
    if (!ans) return defaultValue;
    return /^[Yy]/.test(ans);
  } finally { rl.close(); }
}

/** 探测服务是否已在本机 8000 端口运行 */
function serviceRunning(timeoutMs = 1200) {
  return new Promise((resolve) => {
    const req = http.get({ hostname: '127.0.0.1', port: 8000, path: '/', timeout: timeoutMs }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

/** 运行 scripts/ 下某个 node 脚本（继承 stdio，返回退出码） */
function runNode(script, args = []) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(Scripts, script), ...args], {
      cwd: projectRoot, stdio: 'inherit', env: process.env
    });
    child.on('exit', (code) => resolve(code ?? 1));
    child.on('error', () => resolve(1));
  });
}

/** 运行 scripts/ 下某个 PowerShell 脚本 */
function runPowerShell(script, args = []) {
  const r = spawnSync('powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(Scripts, script), ...args],
    { cwd: projectRoot, stdio: 'inherit' });
  return r.status ?? 1;
}

/**
 * 把系统 WorkBuddy 的 CLI 拷贝到安装目录 vendor/（复用 scripts/vendor-cli.js：
 * staging 换位 + 完整性自检，自检失败以非零退出且旧副本不受影响）。
 * 只在 vendor 副本不存在时被调用——就位判定是纯存在性检查（用户决策：
 * 不做版本/健康检测，损坏场景由控制台 [C] 检测与升级兜底修复）。
 * systemBin：系统侧 CLI 二进制路径（findSystemCliSource 所得）。
 * 返回 true = vendor 副本已就位；false = 跳过/失败——此时回退使用系统副本
 * （cli-paths 的回退保证服务仍可启动，只是副本会随 WorkBuddy 升级漂移）。
 */
async function provisionCli(systemBin) {
  const srcDir = path.dirname(path.dirname(systemBin));
  if (await serviceRunning()) {
    // 拷贝换位时要 rename vendor 目录，服务占用文件会 EPERM——先停服
    const stopIt = interactive ? await ask('检测到服务正在运行。为钉死 CLI 副本需先停止服务，继续吗？') : true;
    if (!stopIt) {
      warn('已跳过拷贝：本次回退使用系统 WorkBuddy 副本（会随 WorkBuddy 升级漂移）。');
      return false;
    }
    const stopCode = await runNode('service.js', ['stop']);
    if (stopCode !== 0) {
      warn('服务停止失败（可能由其他方式启动）——仍尝试拷贝，若因文件占用失败会走回退。');
    }
  }
  process.stdout.write('  正在从 WorkBuddy 拷贝后端 CLI（约 94MB，需要几秒）...\n');
  const code = await runNode('vendor-cli.js', ['--from', srcDir]);
  if (code === 0) {
    ok('后端 CLI 已拷贝到安装目录（钉死副本，WorkBuddy 升级/卸载不影响）');
    return true;
  }
  warn('拷贝未完成：本次回退使用系统 WorkBuddy 副本（会随升级漂移），服务仍可启动。');
  return false;
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

process.stdout.write(`
  ============================================
     buddy2api  初始化向导
  ============================================

  本向导将完成：后端 CLI 就位 → 登录账号 → 启动服务 → 可选自动化。
  完成后你将得到一个 OpenAI 兼容的本地接口：
  http://127.0.0.1:8000/v1
`);

// --- 第 1 步：环境自检 ---
step(1, '环境自检');
{
  const bundled = path.join(projectRoot, 'runtime', 'node.exe');
  if (path.resolve(process.execPath) === path.resolve(bundled)) {
    ok('内置 Node.js 运行时可用（无需系统安装 Node）');
  } else {
    ok(`使用系统 Node.js：${process.version}`);
  }

  if (await serviceRunning()) {
    warn('端口 8000 已有 buddy2api 服务在运行（可能是旧安装/上次启动的），将直接复用');
  } else {
    ok('端口 8000 空闲');
  }
}

// --- 第 2 步：后端 CLI 就位 ---
step(2, '后端 CLI 就位（codebuddy）');
{
  // 就位判定 = 纯存在性检查（用户决策：不做版本/健康检测，升级装场景零等待；
  // 损坏场景由控制台 [C] CLI 检测与升级兜底修复）。provisionCli 只在此处
  // （vendor 不存在时）被调用，系统侧源探测走 cli-paths 共享单点。
  if (fs.existsSync(path.join(projectRoot, 'vendor', 'codebuddy-cli', 'bin', 'codebuddy'))) {
    ok('后端 CLI 已就位（安装目录内置副本，不随 WorkBuddy 升级变化）');
  } else {
    const sysCandidate = findSystemCliSource();
    if (!sysCandidate) {
      process.stdout.write(`
  未检测到 WorkBuddy 桌面端——后端 CLI（codebuddy）随它一起安装。
    · 请先安装腾讯 WorkBuddy 桌面端，装好后回来重新检测即可
    · CLI 装在非标准路径时，可设环境变量 CODEBUDDY_CLI_PATH 指向其 bin/codebuddy
`);
      if (interactive) {
        let handled = false;
        while (!handled && (await ask('安装好 WorkBuddy 后，重新检测吗？'))) {
          const retry = findSystemCliSource();
          if (!retry) {
            warn('仍未检测到 WorkBuddy。');
            continue;
          }
          await provisionCli(retry);
          handled = true;
        }
        if (!handled) {
          warn('已跳过后端 CLI：未安装 WorkBuddy（且未设 CODEBUDDY_CLI_PATH）时后端无法启动，首次请求会失败；请补装后重跑本向导。');
        }
      } else {
        warn('未检测到 WorkBuddy（静默模式，单次提示后跳过）。安装 WorkBuddy 后重跑本向导即可补齐。');
      }
    } else {
      await provisionCli(sysCandidate);
    }
  }
}

// --- 第 3 步：登录账号 ---
step(3, '登录账号');
let loggedIn = false;
let loginReason = null;
{
  let summary = await getAccountSummary();
  if (summary.ok) {
    loggedIn = true;
    ok(`已登录：${summary.account?.nickname ?? '(未知账号)'}`);
  } else {
    if (summary.reason === 'encrypted') {
      process.stdout.write(`
  检测到登录态为加密格式（桌面端新版写入），当前版本无法直接读取。
  若要让本工具使用/刷新凭据，可在弹出的 CLI 界面里完成一次 /login（会写出明文凭据）。
`);
    } else {
      process.stdout.write(`
  需要登录一次你的 WorkBuddy/CodeBuddy 账号（凭据会保存在本机用户目录）：
    · 接下来会弹出命令行登录界面
    · 在界面里输入 /login 并回车
    · 按界面提示在浏览器完成验证，然后关闭该窗口
`);
    }
    for (let attempt = 1; attempt <= 3 && !loggedIn; attempt++) {
      const go = await ask(attempt === 1 ? '现在开始登录吗？' : '重新拉起登录界面吗？');
      if (!go) break;
      const code = await runNode('login.js', ['--open']);
      const after = await getAccountSummary();
      if (after.ok) {
        loggedIn = true;
        ok(`登录成功：${after.account?.nickname ?? '(未知账号)'}`);
      } else if (code !== 0) {
        warn(after.reason === 'encrypted'
          ? '仍未检测到可读登录态（加密格式）——如桌面端正在运行，可关闭后再试。'
          : '尚未检测到有效登录态。');
      }
      summary = after;
    }
    if (!loggedIn) {
      warn('已跳过登录。之后可从桌面「buddy2api」控制台选 [8] 登录，登录后重启服务即可。');
    }
    loginReason = summary?.reason ?? null;
  }
}

// --- 第 4 步：启动服务 ---
step(4, '启动服务');
let serviceUp = false;
{
  if (await serviceRunning()) {
    serviceUp = true;
    ok('服务已在运行');
  } else if (!loggedIn) {
    warn(loginReason === 'encrypted'
      ? '登录态为加密格式（当前版本无法读取），服务仍会启动；账号池可用则不受影响。'
      : '未登录，服务仍会启动（登录后即可正常出模型）');
  }

  if (!serviceUp) {
    const code = await runNode('service.js', ['start']);
    serviceUp = code === 0 && await serviceRunning();
  }

  if (serviceUp) {
    ok('服务已就绪：http://127.0.0.1:8000/v1');
  } else {
    fail('服务未能启动。请查看日志：%TEMP%\\buddy2api.log');
    fail('也可从桌面「buddy2api」控制台选 [7] 查看服务日志。');
  }
}

// --- 第 5 步：可选自动化 ---
step(5, '可选自动化');
if (interactive) {
  if (await ask('启用开机自动启动？（登录 Windows 后静默拉起服务，无窗口）')) {
    runPowerShell('install-autostart-task.ps1');
  } else {
    process.stdout.write('  已跳过（之后可在控制台 [9] 开机启动设置 里开启）\n');
  }
  process.stdout.write('\n');
  if (await ask('启用每日自动签到？（每天 09:30 自动领积分，多账号全签）')) {
    runPowerShell('install-checkin-task.ps1');
  } else {
    process.stdout.write('  已跳过（之后可在控制台 [5] 自动签到设置 里开启）\n');
  }
} else {
  // 静默模式：按默认启用
  runPowerShell('install-autostart-task.ps1');
  runPowerShell('install-checkin-task.ps1');
}

// --- 收尾 ---
process.stdout.write(`\n${hr()}\n`);
if (!serviceUp) {
  process.stdout.write('  ❌ 服务未运行——请按上方提示排查后，在控制台选 [1] 启动服务。\n');
  process.exit(1);
}
process.stdout.write(`
  🎉 初始化完成！

     服务地址 ：http://127.0.0.1:8000/v1   （OpenAI 兼容）
     API Key  ：任意非空字符串（本地服务不校验，填 sk-anything 即可）
     验证     ：浏览器打开 http://127.0.0.1:8000/v1/models
${loggedIn ? '' : (loginReason === 'encrypted'
  ? `     注意     ：登录态为加密格式（当前版本无法读取）；账号池可用则不影响出模型
`
  : (loginReason && loginReason !== 'missing' && loginReason !== 'no-auth-file'
    ? `     注意     ：登录态当前不可用（${loginReason}）；出模型前可先在控制台 [8] 检查
`
    : `     注意     ：尚未登录账号，出模型前请先在控制台 [8] 登录
`))}
     日常入口 ：桌面「buddy2api」图标 → 控制台菜单
                [1] 启动服务  [2] 停止服务  [3] 账号管理
                [8] 登录检查  [4] 签到      [7] 服务日志
${hr()}
`);
process.exit(0);

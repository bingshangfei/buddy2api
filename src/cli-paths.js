/**
 * cli-paths.js — codebuddy CLI 二进制的定位（无副作用）。
 *
 * 从 gateway-discovery.js 拆出：登录脚本等场景只需要"找到 CLI 在哪"，
 * 不应该顺带拉起后端进程池（gateway-discovery 模块加载即恢复池状态）。
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * 查找 codebuddy 二进制路径。
 *
 * 优先级：CODEBUDDY_CLI_PATH 环境变量 > 项目内 vendor 副本 > WorkBuddy 安装目录 > PATH 搜索
 *
 * 为什么优先 vendor 副本：WorkBuddy 升级可能改变安装路径、卸载、或被自动更新替换掉
 * 已知可用的 CLI 版本。vendor 副本（`npm run vendor:update` 刷新）把后端锁在
 * 一个验证过的版本上，使 buddy2api 不受 WorkBuddy 安装状态变化影响。
 * 想改用系统安装的 CLI，设 CODEBUDDY_CLI_PATH 即可覆盖。
 */
export function findCodebuddyBinary() {
  // 1. 环境变量（显式覆盖，优先级最高）
  if (process.env.CODEBUDDY_CLI_PATH) {
    const p = process.env.CODEBUDDY_CLI_PATH;
    if (fs.existsSync(p)) return p;
  }

  // 2. 项目内 vendor 副本
  const vendor = vendorCliBinary();
  if (vendor && fs.existsSync(vendor)) return vendor;

  // 3. WorkBuddy 安装目录（vendor 副本缺失时的回退）
  for (const c of systemCliCandidates()) {
    if (c && fs.existsSync(c)) return c;
  }

  // 4. PATH 搜索（where/which）
  try {
    // 注意：本文件是 ESM（package.json type:module），此处不能用 require——
    // 之前内联 require('node:child_process') 抛 ReferenceError 被 try/catch
    // 吞掉，导致 PATH 回退查找成为永久死代码。
    const cmd = process.platform === 'win32' ? 'where' : 'which';
    const result = execSync(`${cmd} codebuddy`, { encoding: 'utf8', timeout: 3000 }).trim();
    const first = result.split('\n')[0].trim();
    if (first && fs.existsSync(first)) return first;
  } catch { /* ignore */ }

  return null;
}

/**
 * 项目内 vendor 副本的二进制路径（src/ 往上一级即项目根）。
 */
export function vendorCliBinary() {
  return path.join(projectRoot(), 'vendor', 'codebuddy-cli', 'bin', 'codebuddy');
}

/**
 * 脚本用：找一个可用的 CLI 二进制（vendor 副本优先 → 系统安装目录）。
 * 与 findCodebuddyBinary 的区别：不含 CODEBUDDY_CLI_PATH 环境覆盖与 PATH 搜索
 * ——保持 accounts.js / login.js 既有行为逐字不变（上收去重，F17）。
 */
export function findCli() {
  const vendor = vendorCliBinary();
  if (fs.existsSync(vendor)) return vendor;
  for (const c of systemCliCandidates()) {
    if (c && fs.existsSync(c)) return c;
  }
  return null;
}

/**
 * WorkBuddy 安装目录下的 CLI 候选路径（自举用：vendor:update 从这里取源）。
 */
export function systemCliCandidates() {
  return [
    // 历史机器的联想预装路径，仅为兼容既有部署保留（新机器走下方标准候选，
    // 或用 CODEBUDDY_CLI_PATH 显式指定；不命中时只是多一次 existsSync 探测）
    'D:\\LenovoSoftstore\\Install\\WorkBuddy\\resources\\app.asar.unpacked\\cli\\bin\\codebuddy',
    // 标准安装路径
    path.join(process.env.LOCALAPPDATA || '', 'WorkBuddy', 'resources', 'app.asar.unpacked', 'cli', 'bin', 'codebuddy'),
    path.join(process.env.PROGRAMFILES || 'C:\\Program Files', 'WorkBuddy', 'resources', 'app.asar.unpacked', 'cli', 'bin', 'codebuddy'),
    path.join(process.env.PROGRAMFILES || 'C:\\Program Files', 'WorkBuddy', 'resources', 'app.asar.unpacked', 'cli', 'bin', 'codebuddy.cmd'),
    // macOS
    '/Applications/WorkBuddy.app/Contents/Resources/app.asar.unpacked/cli/bin/codebuddy',
    path.join(os.homedir(), 'Applications', 'WorkBuddy.app', 'Contents', 'Resources', 'app.asar.unpacked', 'cli', 'bin', 'codebuddy')
  ];
}

/**
 * 系统侧 CLI 源探测（CODEBUDDY_CLI_PATH → 标准候选 → PATH 搜索），不含 vendor 层
 * ——拷贝源必须来自系统安装，vendor 副本（哪怕是好的）不能当自己的源。
 * 单点供 onboarding / vendor-cli（--check 与拷贝路径）共用；与 findCodebuddyBinary
 * 的第 3/4 级同口径。返回 bin/codebuddy 本体路径，找不到返回 null。
 */
export function findSystemCliSource() {
  const direct = [process.env.CODEBUDDY_CLI_PATH, ...systemCliCandidates()]
    .find(p => p && fs.existsSync(p));
  if (direct) return direct;
  try {
    const cmd = process.platform === 'win32' ? 'where' : 'which';
    const first = execSync(`${cmd} codebuddy`, { encoding: 'utf8', timeout: 3000 })
      .split('\n')[0]?.trim();
    if (first && fs.existsSync(first)) return first;
  } catch { /* PATH 上没有就算了 */ }
  return null;
}

/**
 * 项目根目录（以 src/ 所在位置为基准，不依赖 process.cwd()）。
 */
export function projectRoot() {
  return path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
}

/**
 * 标注二进制来源（日志用，便于排查当前实际用的是哪份 CLI）。
 */
export function cliSource(binary) {
  if (process.env.CODEBUDDY_CLI_PATH && binary === process.env.CODEBUDDY_CLI_PATH) {
    return 'from CODEBUDDY_CLI_PATH';
  }
  if (binary === vendorCliBinary()) return 'vendor copy';
  return 'WorkBuddy install';
}

/**
 * vendor-cli.js — 把 WorkBuddy 安装目录里的 codebuddy CLI 复制到项目 vendor 目录。
 *
 * 用途：buddy2api 默认使用项目内 vendor 副本作为后端（见 gateway-discovery.js），
 * 这样 WorkBuddy 升级/卸载/改路径都不会影响运行。想要新模型或新特性时，
 * 跑这个脚本从当前 WorkBuddy 安装同步一份新的副本。
 *
 * 用法：
 *   npm run vendor:update                     # 从 WorkBuddy 安装目录同步
 *   node scripts/vendor-cli.js --from <path>  # 从指定 cli 目录同步
 *   node scripts/vendor-cli.js --check        # 只读检测：vendor vs WorkBuddy 版本对比
 *
 * --check 与 --from 同传时 --check 优先（--from 是拷贝参数，对只读检测无意义）。
 * --check 退出码契约（消费方：控制台 [C] / -Action cli）：
 *   0 = 无需操作（版本相等 / vendor 更新 / WorkBuddy 版本不可读）
 *   1 = 可升级（vendor 版本低于 WorkBuddy）
 *   2 = vendor 缺失或损坏
 *   3 = 未检测到 WorkBuddy CLI（优先级最高：缺源时拷贝必败）
 *
 * 注意：只会复制，不会删除源目录。目标已存在时以 staging 换位替换
 * （先拷到临时目录并自检，通过后毫秒级换位；旧副本备份为 .bak-*，
 * 成功后自动清理旧备份仅保留最新一个）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { findSystemCliSource, vendorCliBinary, projectRoot } from '../src/cli-paths.js';

const VENDOR_CLI_DIR = path.join(projectRoot(), 'vendor', 'codebuddy-cli');

/**
 * 定位源 cli 目录（包含 bin/codebuddy 的那一层）。
 * --from 显式指定最高优先；否则走系统侧共享探测（env → 标准候选 → PATH）。
 */
function findSourceCliDir() {
  const fromArg = process.argv[process.argv.indexOf('--from') + 1];
  if (process.argv.includes('--from') && fromArg) {
    const abs = path.resolve(fromArg);
    if (!fs.existsSync(abs)) throw new Error(`--from 指定的路径不存在: ${abs}`);
    // 允许指向 cli 目录本身或其 bin/codebuddy
    if (fs.existsSync(path.join(abs, 'bin', 'codebuddy'))) return abs;
    const up = path.dirname(path.dirname(abs));
    if (fs.existsSync(path.join(up, 'bin', 'codebuddy'))) return up;
    throw new Error(`--from 路径下找不到 bin/codebuddy: ${abs}`);
  }

  const bin = findSystemCliSource();
  if (!bin) {
    throw new Error(
      '找不到 WorkBuddy 安装的 codebuddy CLI。请用 --from <cli 目录> 显式指定。'
    );
  }
  return path.dirname(path.dirname(bin));
}

/**
 * 读取 CLI 版本号（跑 `codebuddy --version`）。
 * 失败返回带哨兵的字符串（含「读取失败」），空输出返回空串——判废口径：
 * includes('读取失败') || 为空（与 --check/拷贝自检共用，勿直接流入版本比较）。
 */
function readVersion(binaryPath, timeoutMs = 30_000) {
  try {
    return execFileSync(process.execPath, [binaryPath, '--version'], {
      encoding: 'utf8',
      timeout: timeoutMs
    }).trim();
  } catch (e) {
    return `(读取失败: ${e.message})`;
  }
}

/** 版本串判废（读取失败哨兵或空输出） */
function badVersion(v) {
  return !v || v.includes('读取失败');
}

/** 提取 X.Y.Z 数字三元组（容忍版本串带前后缀）；解析失败返回 null */
function versionTriple(v) {
  const m = String(v).match(/(\d+)\.(\d+)\.(\d+)/);
  return m ? m.slice(1).map(Number) : null;
}

/**
 * 版本对比：-1 = a<b（可升级），0 = 相等，1 = a>b。
 * 任一侧无法解析出三元组 → 降级为字符串严格相等（不等按可升级，宁多提示勿漏升）。
 */
function compareVersions(a, b) {
  const ta = versionTriple(a);
  const tb = versionTriple(b);
  if (!ta || !tb) return a.trim() === b.trim() ? 0 : -1;
  for (let i = 0; i < 3; i++) {
    if (ta[i] !== tb[i]) return ta[i] < tb[i] ? -1 : 1;
  }
  return 0;
}

function dirSizeMb(dir) {
  let total = 0;
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) {
        try { total += fs.statSync(full).size; } catch { /* ignore */ }
      }
    }
  };
  walk(dir);
  return (total / 1024 / 1024).toFixed(0);
}

// --- --check 模式：只读检测，不拷贝（崩溃兜底：未捕获异常按「损坏」报 2，
//     避免崩溃退出码 1 被控制台误读为「可升级」弹确认框） ---

if (process.argv.includes('--check')) {
  try {
    const srcBin = findSystemCliSource();
    if (!srcBin) {
      console.log('未检测到 WorkBuddy 安装的 codebuddy CLI（后端运行时随它一起安装）。');
      process.exit(3);
    }
    // vendor 存在性判定先于任何 8s 探测（缺失用户不必白等；源已找到非 exit 3，
    // 此时按优先级报 2「缺失」）
    const vendorInstalled = fs.existsSync(vendorCliBinary());
    if (!vendorInstalled) {
      console.log('WorkBuddy CLI 已找到，但安装目录尚未安装 CLI 副本（可用初始化向导或本选项安装）。');
      process.exit(2);
    }
    process.stdout.write('检测中…（首次探测最多约 8 秒）\n');
    const sysVersion = readVersion(srcBin, 8_000);
    if (badVersion(sysVersion)) {
      // 源版本都读不出来时无法对比——不误报「可升级」，让用户自查 WorkBuddy 安装
      console.log(`WorkBuddy CLI 版本读取失败，无法对比（${sysVersion || '无任何输出'}）。`);
      process.exit(0);
    }
    console.log(`WorkBuddy CLI 版本: ${sysVersion}`);
    const vendorVersion = readVersion(vendorCliBinary(), 8_000);
    if (badVersion(vendorVersion)) {
      console.log(`安装目录 CLI 副本损坏（${vendorVersion || '无任何输出'}）——需要重新拷贝修复。`);
      process.exit(2);
    }
    console.log(`安装目录 CLI 版本: ${vendorVersion}`);

    const cmp = compareVersions(vendorVersion, sysVersion);
    if (cmp < 0) {
      console.log(`有可用更新：${vendorVersion} → ${sysVersion}。`);
      process.exit(1);
    }
    if (cmp > 0) {
      console.log('安装目录副本比 WorkBuddy 自带的还新，无需操作。');
      process.exit(0);
    }
    console.log('已是最新，无需升级。');
    process.exit(0);
  } catch (e) {
    console.error(`检测过程异常（${e.message}）——按「缺失或损坏」处理，可重新拷贝修复。`);
    process.exit(2);
  }
}

// --- 拷贝主流程（staging 换位：旧副本全程原位，自检通过才毫秒级换位） ---

const srcDir = findSourceCliDir();
console.log(`源 CLI 目录: ${srcDir}`);
const srcVersion = readVersion(path.join(srcDir, 'bin', 'codebuddy'));
if (badVersion(srcVersion)) {
  console.error(`❌ 源 CLI 无法运行（${srcVersion || '无任何输出'}）——已取消拷贝。`);
  process.exit(1);
}
console.log(`源版本: ${srcVersion}`);

const staging = `${VENDOR_CLI_DIR}.staging-${Date.now()}`;
// 预清理上次异常退出可能残留的 .staging-*（每次 94MB，不清理会积累）
try {
  const parentDir = path.dirname(VENDOR_CLI_DIR);
  const baseName = path.basename(VENDOR_CLI_DIR);
  for (const stale of fs.readdirSync(parentDir).filter(n => n.startsWith(`${baseName}.staging-`))) {
    fs.rmSync(path.join(parentDir, stale), { recursive: true, force: true });
    console.log(`已清理残留临时目录: ${stale}`);
  }
} catch { /* 清理失败不阻断 */ }
console.log('复制中（约 94MB，需要几秒）...');
fs.mkdirSync(path.dirname(staging), { recursive: true });
fs.cpSync(srcDir, staging, { recursive: true });

// staging 完整性自检：拷贝中断/磁盘问题会产出跑不起来的半成品——
// 失败只删临时目录，旧副本（若有）全程原位不受影响
const stagedVersion = readVersion(path.join(staging, 'bin', 'codebuddy'));
if (badVersion(stagedVersion)) {
  console.error(`❌ 拷贝后自检失败：副本无法运行（${stagedVersion || '无任何输出'}）`);
  try {
    fs.rmSync(staging, { recursive: true, force: true });
    console.error('   已清理临时副本，原有内容未受影响，请重试。');
  } catch (e) {
    console.error(`   ⚠️ 临时副本清理失败（${e.message}）——请手动删除 ${path.basename(staging)} 后重试。`);
  }
  process.exit(1);
}

// 换位：旧副本 → .bak（服务/杀软占用会 EPERM，退避重试），staging → 正式
if (fs.existsSync(VENDOR_CLI_DIR)) {
  console.log(`现有 vendor 版本: ${readVersion(vendorCliBinary())}`);
  const backupPath = `${VENDOR_CLI_DIR}.bak-${Date.now()}`;
  let moved = false;
  for (let attempt = 1; attempt <= 3 && !moved; attempt++) {
    try {
      fs.renameSync(VENDOR_CLI_DIR, backupPath);
      moved = true;
    } catch (e) {
      if (attempt === 3) {
        console.error(`❌ 旧副本换出失败（${e.message}）——请停止服务/关闭占用后重试。`);
        try { fs.rmSync(staging, { recursive: true, force: true }); } catch { /* ignore */ }
        process.exit(1);
      }
      console.log(`  旧副本被占用，第 ${attempt}/3 次重试...`);
      // 同步睡眠 300ms（无子进程开销）
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
    }
  }
  console.log(`备份旧副本 → ${path.basename(backupPath)}`);
}
fs.renameSync(staging, VENDOR_CLI_DIR);

const newVersion = readVersion(vendorCliBinary());
// staging 已自检通过，此处保守断言（换位异常兜底）
if (badVersion(newVersion)) {
  console.error(`❌ 换位后自检异常（${newVersion || '无任何输出'}）——请手动检查 vendor/ 目录。`);
  process.exit(1);
}
console.log(`复制完成。vendor 版本: ${newVersion}`);
console.log(`大小: ${dirSizeMb(VENDOR_CLI_DIR)} MB`);

// prune 旧 .bak-*：升级常规化后不清理会数 GB 积累，保留最新一个即可。
// 只匹配本脚本自己的命名（.bak-<纯数字时间戳>），不碰用户手工留存的同名目录。
try {
  const parent = path.dirname(VENDOR_CLI_DIR);
  const base = path.basename(VENDOR_CLI_DIR);
  const baks = fs.readdirSync(parent)
    .filter(n => new RegExp(`^${base}\\.bak-\\d+$`).test(n))
    .sort();
  for (const old of baks.slice(0, -1)) {
    fs.rmSync(path.join(parent, old), { recursive: true, force: true });
    console.log(`已清理旧备份: ${old}`);
  }
} catch { /* 清理失败不阻断主流程 */ }

console.log('');
if (fs.existsSync(path.join(projectRoot(), 'runtime', 'node.exe'))) {
  // 安装布局：给终端用户的文案（dev 机专属命令在安装版上不存在）
  console.log('副本已钉死在本安装目录，WorkBuddy 升级/卸载不影响；从桌面「buddy2api」控制台选 [1] 启动服务即可。');
  console.log('控制台 [C] 可随时检测 CLI 更新。');
} else {
  console.log('提示：.bak-* 备份仅保留最新一个，其余已自动清理；如需回滚可直接改回目录名。');
  console.log('重启 buddy2api 后生效：node src/index.js --kill && nohup node src/index.js > /tmp/buddy2api.log 2>&1 &');
}

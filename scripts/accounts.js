#!/usr/bin/env node
/**
 * accounts.js — 账号池管理 CLI。
 *
 * 用法：
 *   node scripts/accounts.js list                列出已保存账号与健康状态
 *   node scripts/accounts.js add                 引导添加账号（隔离登录：不影响现有账号登录态）
 *   node scripts/accounts.js relogin <uid>       为指定账号重新登录（凭据过期/吊销时）
 *   node scripts/accounts.js recover             检查并修复上次隔离登录的遗留现场
 *   node scripts/accounts.js import              从 CodeBuddy 登录态目录导入全部账号
 *   node scripts/accounts.js import --current    只导入当前生效的那份登录态
 *   node scripts/accounts.js check               探活全部账号（计费接口）
 *   node scripts/accounts.js remove <uid>        删除指定账号
 *   node scripts/accounts.js status --json       输出 JSON（供脚本消费）
 *
 * 背景：
 *   CLI 每次登录都会在 CodeBuddy 登录态目录留下一份带时间戳的快照
 *   （workbuddy-desktop.<时间戳>.<pid>.<uuid>.info）。不同账号登录过就会留下
 *   不同 uid 的快照 —— `import` 会把它们全部收进 data/accounts/，交给账号池
 *   轮流使用，从而摊开配额、单账号异常时自动切换。
 *   `add`/`relogin` 走**隔离登录**（scripts/isolated-login.js）：CLI 跑在影子
 *   环境里，真实登录态全程不被改动，因此多账号可以同时保持有效。
 *   桌面端新版写入的凭据为信封加密格式（暂不支持读取）：import 会跳过它们
 *   并给出计数与 CLI 登录指引，不会写坏已有记录。
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  accountsDir,
  displayName,
  listAccounts,
  listCorrupted,
  importFromAuthDir,
  importCurrent,
  removeAccount,
  getAccount
} from '../src/account-store.js';
import { authStatePath, parseAuthState, credentialOf } from '../src/auth-credentials.js';
import { accountPool } from '../src/account-pool.js';
import { authDir } from '../src/account-info.js';
import { findCli } from '../src/cli-paths.js';
import { runIsolatedLogin, healIfNeeded, runRecover } from './isolated-login.js';

const cmd = process.argv[2] || 'list';
const asJson = process.argv.includes('--json');

/** 启动自愈：上次隔离登录若未正常收尾，先恢复现场再执行任何命令（F6/F15）。
    走 stderr——`status --json` 的 stdout 须保持纯 JSON（CR R5）。 */
healIfNeeded({ log: (m) => console.error(m) });

/** 读真实 canonical 的 uid（relogin 判定「同账号 → 普通登录」用；字面路径读取） */
function canonicalUid() {
  try {
    const st = parseAuthState(fs.readFileSync(path.join(authDir(), 'workbuddy-desktop.info'), 'utf8'));
    return typeof st?.account?.uid === 'string' && st.account.uid ? st.account.uid : null;
  } catch {
    return null;
  }
}

function fmtTime(ms) {
  if (!ms) return '—';
  return new Date(ms).toLocaleString('zh-CN', { hour12: false });
}

/** 损坏记录展示块（list/check 共用）：不参与轮转，给出清理指引；空行始终输出（保持旧输出节奏） */
function printCorruptedNotice() {
  const corrupt = listCorrupted();
  if (corrupt.length > 0) {
    console.log(`⚠️  ${corrupt.length} 条损坏记录（accessToken 非明文，不参与轮转）：`);
    for (const c of corrupt) {
      const hint = typeof c.id === 'string'
        ? `清理：node scripts/accounts.js remove ${c.id}`
        : `（id 异常，无法自动清理；文件：${c.file}）`;
      console.log(`   ${displayName(c).padEnd(16)} ${hint}`);
    }
  }
  console.log('');
}

switch (cmd) {
  case 'list':
  case 'status': {
    const all = accountPool.accounts({ force: true });
    if (all.length === 0) {
      console.log('账号池为空。');
      console.log('');
      printCorruptedNotice();
      console.log('导入方式：');
      console.log('  node scripts/accounts.js add               # 隔离登录添加新账号（推荐）');
      console.log('  node scripts/accounts.js import            # 从 CodeBuddy 登录态目录导入全部账号');
      console.log('  node scripts/accounts.js import --current  # 只导入当前登录的账号');
      console.log('');
      console.log(`登录态目录：${authDir()}`);
      break;
    }

    // 默认探活：健康状态是内存态，新进程里看不到，直接探一次才准
    const noProbe = process.argv.includes('--no-probe');
    let probeMap = new Map();
    if (!noProbe) {
      const { healthy, unhealthy } = await accountPool.validateAll();
      for (const h of healthy) probeMap.set(h.account.id, { ok: true, balance: h.balance });
      for (const u of unhealthy) probeMap.set(u.account.id, { ok: false, reason: u.reason });
    }

    if (asJson) {
      // 脱敏：accessToken/refreshToken 是 bearer 凭据，--json 输出明言"供脚本
      // 消费"，会进管道/日志/终端回滚——泄漏即等于交出账号。只输出元数据。
      process.stdout.write(JSON.stringify({
        dir: accountsDir(),
        accounts: all.map((a) => {
          const { accessToken, refreshToken, ...meta } = a;
          return { ...meta, hasCredentials: Boolean(accessToken), probe: probeMap.get(a.id) || null };
        }),
        corrupted: listCorrupted().map(({ id, nickname, reason }) => ({ id, nickname, reason }))
      }, null, 2) + '\n');
      break;
    }

    console.log(`账号池：${all.length} 个账号（${accountsDir()}）`);
    console.log('');
    for (const a of all) {
      const p = probeMap.get(a.id);
      const state = !p ? '未探活' : (p.ok ? `可用（余额 ${p.balance.remaining}/${p.balance.total}）` : `失效：${p.reason}`);
      console.log(`  ${displayName(a).padEnd(16)} ${a.type || ''}`.trimEnd());
      console.log(`    uid        ${a.id}`);
      console.log(`    有效期至   ${fmtTime(a.expiresAt)}`);
      console.log(`    状态       ${state}`);
      console.log('');
    }
    printCorruptedNotice();
    console.log('请求会在可用账号间轮流分配；某账号 429/认证失败会进入冷却，期间使用其他账号。');
    console.log('（加 --no-probe 可跳过探活，只看本地记录）');
    break;
  }

  case 'import': {
    const onlyCurrent = process.argv.includes('--current');
    if (onlyCurrent) {
      const rec = importCurrent();
      if (!rec) {
        let reason = null;
        try {
          reason = credentialOf(parseAuthState(fs.readFileSync(authStatePath(), 'utf8'))).reason;
        } catch { /* 读取失败按未登录话术 */ }
        if (reason === 'encrypted') {
          console.error('❌ 当前登录态为加密格式（桌面端写入），暂不支持读取。');
          console.error('   用 CLI 登录一次即可写入明文凭据：node scripts/login.js --open（或控制台 [8]）。');
        } else {
          console.error('❌ 未能从当前登录态导入（未登录或缺 token）。先运行 `node scripts/login.js`（或控制台 [8]）。');
        }
        process.exit(2);
      }
      console.log(`✅ 已导入：${displayName(rec)}`);
      console.log(`   uid        ${rec.id}`);
      console.log(`   有效期至   ${fmtTime(rec.expiresAt)}`);
      break;
    }

    const { imported, skipped, encrypted } = importFromAuthDir();
    if (imported.length === 0) {
      console.error('❌ 登录态目录里没有可用的明文凭据。');
      if (encrypted > 0) {
        console.error(`   ⚠️ 跳过 ${encrypted} 个加密凭据（桌面端写入的密文格式，暂不支持读取）。`);
        console.error('   如需导入请用 CLI 登录一次（会写出明文凭据）：node scripts/login.js --open（或控制台 [8]）。');
      }
      const broken = skipped - encrypted;
      if (broken > 0) console.error(`   （跳过 ${broken} 个无效记录）`);
      if (encrypted === 0) console.error('   先运行 `node scripts/login.js` 完成登录（或控制台 [8]）。');
      console.error(`   目录：${authDir()}`);
      process.exit(2);
    }
    console.log(`✅ 导入 ${imported.length} 个账号：`);
    for (const r of imported) {
      console.log(`   ${displayName(r).padEnd(16)} uid=${r.id}`);
      console.log(`     有效期至 ${fmtTime(r.expiresAt)}  来源 ${r.source}`);
    }
    if (encrypted > 0) console.log(`   ⚠️ 跳过 ${encrypted} 个加密凭据（桌面端写入的密文格式，暂不支持读取）；如需导入请用 CLI 登录`);
    const brokenCount = skipped - encrypted;
    if (brokenCount > 0) console.log(`   （跳过 ${brokenCount} 个无效记录）`);
    console.log('');
    console.log(`已写入：${accountsDir()}`);
    console.log('≤30s 自动纳入轮转，无需重启（重启仅为立即刷新余额/探活）。');
    break;
  }

  case 'remove': {
    const uid = process.argv[3];
    if (!uid) {
      console.error('用法：node scripts/accounts.js remove <uid>');
      process.exit(1);
    }
    const ok = removeAccount(uid);
    console.log(ok ? `✅ 已删除 ${uid}` : `⚠️ 未找到 ${uid}`);
    process.exit(ok ? 0 : 1);
  }

  case 'add': {
    // 隔离登录添加账号：CLI 跑在影子环境里，现有账号登录态不被改动
    const before = accountPool.accounts({ force: true });
    console.log('添加账号（隔离登录：在独立环境中完成新账号登录，现有账号不受影响）');
    console.log('');
    console.log('为什么要配多个账号：');
    console.log('  · 摊开配额 —— 单账号额度有限，多个账号轮流用可支撑更高请求量');
    console.log('  · 故障转移 —— 某账号频控(429)或额度用尽时自动切换，服务不中断');
    console.log('  · 完全可选 —— 只配一个账号时行为与现在完全一样');
    console.log('');
    console.log(`当前已有 ${before.length} 个账号：${before.map((a) => displayName(a)).join('、') || '（无）'}`);
    console.log('');
    console.log('接下来：');
    console.log('  1. 在弹出的 CLI 界面里输入  /login');
    console.log('  2. 按提示完成授权（登录要添加的那个账号）');
    console.log('  3. 完成后关闭 CLI 界面，本脚本会自动捕获凭据并写入账号池');
    console.log('');

    const cliPath = findCli();
    if (!cliPath) {
      console.error('❌ 找不到 codebuddy CLI，无法自动拉起。');
      console.error('   可手动登录后执行：node scripts/accounts.js import');
      process.exit(1);
    }

    const r = await runIsolatedLogin({ mode: 'add', cliPath });
    if (!r.ok) {
      if (r.failed === 'final-check') {
        console.error('⚠️  新账号已入库，但真实登录态被意外改动（详情见上方输出）。');
        console.error('   若提示未能自动恢复，请运行：node scripts/accounts.js recover');
      } else {
        console.error(`❌ 隔离登录未完成（${r.failed}）——现有账号未受影响。`);
        console.error('   可重试；若提示现场异常，请运行：node scripts/accounts.js recover');
      }
      process.exit(2);
    }

    const after = accountPool.accounts({ force: true });
    const added = after.length - before.length;
    if (added > 0) {
      console.log(`✅ 新增 1 个账号（${displayName(r.record)}），当前共 ${after.length} 个：`);
    } else {
      console.log(`✅ 已刷新 ${displayName(r.record)} 的记录，当前共 ${after.length} 个账号：`);
    }
    console.log('');
    for (const a of after) console.log(`   ${displayName(a).padEnd(16)} ${a.type || ''}`.trimEnd());
    console.log('');
    if (r.note) console.log(`⚠️  ${r.note}`);
    console.log('CLI/桌面端维持登录前状态；新账号凭据仅在账号池（≤30s 自动纳入轮转，无需重启）。');
    console.log('（重启服务仅为立即刷新余额/探活：控制台 [2] 停止 → [1] 启动）');
    break;
  }

  case 'relogin': {
    // 指定账号重登（凭据过期/被吊销时）：复用隔离登录机制
    const uid = process.argv[3];
    if (!uid) {
      console.error('用法：node scripts/accounts.js relogin <uid>');
      process.exit(1);
    }
    const target = getAccount(uid);
    if (!target) {
      console.error(`❌ 账号池中未找到 ${uid}（可用 node scripts/accounts.js list 查看 uid）。`);
      process.exit(1);
    }
    const sameAccount = canonicalUid() === uid;
    console.log(`重新登录 ${displayName(target)}（uid=${uid}）`);
    if (sameAccount) {
      console.log('（该账号即当前 CLI/桌面端登录的账号：走普通登录刷新，不做隔离）');
    } else if (canonicalUid() === null) {
      console.log('（当前 CLI/桌面端无可识别的登录账号：按隔离登录处理）');
    } else {
      console.log('（隔离登录：现有账号登录态不受影响）');
    }
    console.log('');
    console.log('接下来：在弹出的 CLI 界面里输入  /login，完成该账号授权后关闭界面。');
    console.log('');

    const cliPath = findCli();
    if (!cliPath) {
      console.error('❌ 找不到 codebuddy CLI，无法自动拉起。');
      process.exit(1);
    }
    const r = await runIsolatedLogin({ mode: 'relogin', uid, cliPath, plainLogin: sameAccount });
    if (!r.ok) {
      console.error(`❌ 重新登录未完成（${r.failed}）——其他账号未受影响。`);
      if (sameAccount) {
        console.error('   （普通登录模式不做现场还原：真实登录态已由 CLI 按常规流程更新。）');
      }
      console.error('   可重试；若提示现场异常，请运行：node scripts/accounts.js recover');
      process.exit(2);
    }
    console.log(`✅ 已刷新 ${displayName(r.record)} 的凭据（有效期至 ${fmtTime(r.record.expiresAt)}）。`);
    if (r.note) console.log(`⚠️  ${r.note}`);
    console.log('   其他账号可用性不受影响；池 ≤30s 自动纳入新凭据。');
    break;
  }

  case 'recover': {
    // 显式恢复入口：检查并修复上次隔离登录的遗留现场
    const r = runRecover({ log: (m) => console.log(m) });
    process.exit(r.needsManual ? 2 : 0);
    break;
  }

  case 'check': {
    const all = accountPool.accounts({ force: true });
    if (all.length === 0) {
      console.error('账号池为空，先运行 `node scripts/accounts.js import`。');
      printCorruptedNotice();
      process.exit(2);
    }
    console.log(`正在探活 ${all.length} 个账号…\n`);
    const { healthy, unhealthy } = await accountPool.validateAll();
    for (const h of healthy) {
      console.log(`  ✅ ${displayName(h.account).padEnd(16)} 余额 ${h.balance.remaining}/${h.balance.total} ${h.balance.unit}`);
    }
    for (const u of unhealthy) {
      console.log(`  ❌ ${displayName(u.account).padEnd(16)} ${u.reason}`);
    }
    printCorruptedNotice();
    console.log(`可用 ${healthy.length} / ${all.length}。失效账号已置入冷却，不会参与轮转。`);
    process.exit(healthy.length > 0 ? 0 : 2);
  }

  default:
    console.error(`未知命令：${cmd}`);
    console.error('可用：list | add | relogin <uid> | recover | import [--current] | check | remove <uid>');
    process.exit(1);
}

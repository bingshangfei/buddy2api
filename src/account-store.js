/**
 * account-store.js — 多账号凭据的本地存储。
 *
 * 为什么需要：单个账号会撞配额（429）、也会过期限流。把多个账号的凭据
 * 存下来交给账号池轮换，可以显著提高可用性（见 account-pool.js）。
 *
 * 存储位置：<项目>/data/accounts/<uid>.json
 *   每个账号一个文件，内容为归一化后的凭据记录：
 *   { id, nickname, uid, type, accessToken, refreshToken, expiresAt, importedAt }
 *
 * 凭据来源：
 *   1. CodeBuddy 的登录态文件（含当前账号的 token）
 *   2. 登录态目录里的历史快照 —— CLI 每次登录会写出
 *      workbuddy-desktop.<时间戳>.<pid>.<uuid>.info，不同账号登录过就会留下
 *      不同 uid 的快照，`importFromAuthDir()` 会把它们全部收进来（同 uid 取最新）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { authDir, authStatePath, parseAuthState, credentialOf, isUsableToken, strOrNull } from './auth-credentials.js';

const projectRoot = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..');

/** 账号凭据目录（BUDDY2API_ACCOUNTS_DIR 可覆盖，测试用） */
export function accountsDir() {
  return process.env.BUDDY2API_ACCOUNTS_DIR || path.join(projectRoot, 'data', 'accounts');
}

/**
 * 把一份 CodeBuddy 登录态归一化成账号记录。
 *
 * @param {object} state parseAuthState 的结果
 * @returns {object|null} 缺 uid 或凭据不可用（非 string token）时返回 null
 */
export function toAccountRecord(state, sourceFile = null) {
  const acc = state?.account;
  const auth = state?.auth;
  const uid = strOrNull(acc?.uid);
  // 写入守卫（单点：credentialOf）：token 必须是字符串（加密信封对象/数值）不得
  // 成为账号记录——对象 truthy 会穿过并被按 expiresAt 覆盖好记录（沙箱 dry-run 实证）。
  const { token } = credentialOf(state);
  if (!uid || token === null) return null;

  return {
    id: uid,
    nickname: strOrNull(acc.nickname),
    uid,
    uin: strOrNull(acc.uin),
    type: strOrNull(acc.type),
    enterpriseName: strOrNull(acc.enterpriseName),
    accessToken: token,
    refreshToken: strOrNull(auth.refreshToken),
    expiresAt: Number(auth.expiresAt) || 0,
    refreshExpiresAt: Number(auth.refreshExpiresAt) || 0,
    importedAt: new Date().toISOString(),
    source: sourceFile ? path.basename(sourceFile) : null
  };
}

/** 记录显示名：nickname 必须是 string 才直接用（损坏/手工记录可能存了非字符串） */
export function displayName(a) {
  if (a && typeof a.nickname === 'string' && a.nickname) return a.nickname;
  return a && typeof a.id === 'string' && a.id ? a.id : '(未命名)';
}

/**
 * 校验账号 id 可安全用作文件名：uid 来自登录态（toAccountRecord）或
 * process.argv（removeAccount），含路径分隔符/.. 时会逃逸 data/accounts/
 * —— `remove ../package` 可删掉项目根的 package.json。
 */
function assertSafeAccountId(id) {
  if (typeof id !== 'string' || !id || /[\\/]/.test(id) || id.includes('..') || id.startsWith('.')) {
    throw new Error(`Invalid account id: ${JSON.stringify(id)}`);
  }
}

/**
 * 保存账号记录（按 uid 覆盖写入）。
 */
export function saveAccount(record) {
  assertSafeAccountId(record.id);
  const dir = accountsDir();
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${record.id}.json`);
  fs.writeFileSync(file, JSON.stringify(record, null, 2), 'utf8');
  return file;
}

/**
 * 读取全部已保存账号。
 *
 * @param {object} [opts]
 * @param {number} [opts.now] 当前时间（测试用）
 * @param {boolean} [opts.includeExpired=false] 是否包含已过期账号
 * @returns {Array<object>} 按 nickname 排序
 */
export function listAccounts({ now = Date.now(), includeExpired = false } = {}) {
  const dir = accountsDir();
  if (!fs.existsSync(dir)) return [];

  const out = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    try {
      const rec = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      // 读侧收口（单点：isUsableToken）：非 string id/token 的损坏记录（历史误写/
      // 手工粘贴）不进入任何消费方（池探活/pick、签到、env 注入）——诊断可见性
      // 由 listCorrupted() 承担。展示字段同在此归一（下游消费方零改动自动受益）。
      if (typeof rec?.id !== 'string' || !rec.id || !isUsableToken(rec?.accessToken)) continue;
      const expired = rec.expiresAt > 0 && now >= rec.expiresAt;
      if (expired && !includeExpired) continue;
      out.push({
        ...rec,
        nickname: strOrNull(rec.nickname),
        uin: strOrNull(rec.uin),
        type: strOrNull(rec.type),
        enterpriseName: strOrNull(rec.enterpriseName),
        expired,
        file: path.join(dir, f)
      });
    } catch { /* 跳过损坏文件 */ }
  }
  return out.sort((a, b) => String(a.nickname || a.id).localeCompare(String(b.nickname || b.id)));
}

/**
 * 按 id 取单个账号。
 */
export function getAccount(id) {
  return listAccounts({ includeExpired: true }).find((a) => a.id === id) || null;
}

/**
 * 删除账号。
 * @returns {boolean} 是否删除了文件
 */
export function removeAccount(id) {
  assertSafeAccountId(id);
  const file = path.join(accountsDir(), `${id}.json`);
  if (fs.existsSync(file)) {
    fs.unlinkSync(file);
    return true;
  }
  return false;
}

/**
 * 列出「损坏记录」（token 不是非空字符串，或 id 非法——如历史误写/手工粘贴的
 * 加密对象）。仅供诊断展示与清理指引：损坏记录已被 listAccounts 读侧过滤，
 * 不进入池/签到/注入。
 *
 * @returns {Array<{id: string|number, nickname: string|null, file: string, reason: string}>}
 */
export function listCorrupted() {
  const dir = accountsDir();
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    try {
      const rec = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      if (!rec?.id) continue;
      const idOk = typeof rec.id === 'string';
      if (idOk && isUsableToken(rec.accessToken)) continue;
      out.push({
        id: rec.id,
        nickname: typeof rec.nickname === 'string' && rec.nickname ? rec.nickname : null,
        file: path.join(dir, f),
        reason: idOk ? 'corrupted-record' : 'invalid-id'
      });
    } catch { /* 非 JSON 文件不算账号记录 */ }
  }
  return out;
}

/**
 * 从登录态目录导入所有历史快照里的账号。
 *
 * CLI 每次登录都会留一份带时间戳的快照；不同账号登录过就会留下不同 uid 的
 * 文件。同 uid 只保留 expiresAt 最新的那份；加密凭据（桌面端新格式）不参赛。
 *
 * @param {object} [opts]
 * @param {string} [opts.dir] 登录态目录覆盖（测试用）；默认 authDir()
 * @returns {{imported: Array, skipped: number, encrypted: number}} imported 为写入的记录；
 *          encrypted 为跳过的加密凭据数（提示文案用，skipped 数值契约保持向后兼容）
 */
export function importFromAuthDir({ dir = authDir() } = {}) {
  const best = new Map(); // uid -> record
  let skipped = 0;
  let encrypted = 0;

  if (fs.existsSync(dir)) {
    for (const f of fs.readdirSync(dir)) {
      // 规范名与带时间戳的快照都收
      if (!f.startsWith('workbuddy-desktop') || !f.endsWith('.info')) continue;
      try {
        const state = parseAuthState(fs.readFileSync(path.join(dir, f), 'utf8'));
        // 加密凭据单独计数（提示文案用）——不参加 per-uid 竞争，更不得覆盖好记录
        if (credentialOf(state).reason === 'encrypted') { encrypted++; skipped++; continue; }
        const rec = toAccountRecord(state, path.join(dir, f));
        if (!rec) { skipped++; continue; }
        const prev = best.get(rec.id);
        if (!prev || rec.expiresAt > prev.expiresAt) best.set(rec.id, rec);
      } catch { skipped++; }
    }
  }

  const imported = [];
  for (const rec of best.values()) {
    saveAccount(rec);
    imported.push(rec);
  }
  return { imported, skipped, encrypted };
}

/**
 * 导入当前生效的那份登录态（authStatePath 定位到的文件）。
 *
 * @returns {object|null} 凭据不可用（加密/缺失/无效）或读取失败时返回 null（不写盘）
 */
export function importCurrent() {
  try {
    const file = authStatePath();
    const state = parseAuthState(fs.readFileSync(file, 'utf8'));
    const rec = toAccountRecord(state, file);
    if (!rec) return null;
    saveAccount(rec);
    return rec;
  } catch {
    return null;
  }
}

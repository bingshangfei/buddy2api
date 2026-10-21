/**
 * auth-credentials.js — 登录态定位与解析（纯函数 + 只读磁盘，零网络）。
 *
 * 从 account-info.js 拆出（refactor-20260926-arch-deepening 候选⑤）：
 * 凭据定位（本模块）与计费余额查询（billing.js）是两个不相干的职责，
 * 此前 account-store.js（存储层）为复用三个纯函数被迫 import 网络层。
 *
 * 数据来源（只读，不改动任何状态）：
 * 登录态：CodeBuddy 的 auth store
 *      Windows: %LOCALAPPDATA%\CodeBuddyExtension\Data\Public\auth\workbuddy-desktop.info
 *      macOS:   ~/Library/Application Support/CodeBuddyExtension/Data/Public/auth/workbuddy-desktop.info
 *      Linux:   ~/.local/share/CodeBuddyExtension/Data/Public/auth/workbuddy-desktop.info
 *    该文件由 CLI/桌面端的 cli-external-link 登录流程写入，含 account（昵称/uid/uin/类型）
 *    与 auth（accessToken/refreshToken/expiresAt）。CLI 与桌面共用同一份登录态。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * 登录态目录（存放 workbuddy-desktop*.info 与登出标记）。
 */
export function authDir() {
  const leaf = path.join('CodeBuddyExtension', 'Data', 'Public', 'auth');
  if (process.platform === 'win32') {
    const base = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    return path.join(base, leaf);
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', leaf);
  }
  const base = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
  return path.join(base, leaf);
}

/**
 * 定位当前登录态文件。
 *
 * CLI 会轮换文件名：除了规范的 `workbuddy-desktop.info`，还会写出
 * `workbuddy-desktop.<ISO时间>.<pid>.<uuid>.info` 这样的快照，并可能留下
 * `workbuddy-desktop.info.logged-out` 标记。只认规范名会在轮换后失联
 * （实测：文件被改名后账户显示为"未登录"，但后端仍在正常工作）。
 *
 * 策略：规范名存在就用它；否则取目录里最新的 workbuddy-desktop*.info 快照。
 *
 * @param {string} [dir] 目录覆盖（测试用）；默认按平台推导
 */
export function authStatePath(dir = authDir()) {
  if (process.env.CODEBUDDY_AUTH_FILE) return process.env.CODEBUDDY_AUTH_FILE;

  const canonical = path.join(dir, 'workbuddy-desktop.info');
  if (fs.existsSync(canonical)) return canonical;

  // 回退：最新的轮换快照
  try {
    const snapshots = fs.readdirSync(dir)
      .filter((f) => f.startsWith('workbuddy-desktop.') && f.endsWith('.info'))
      .map((f) => path.join(dir, f));
    if (snapshots.length > 0) {
      snapshots.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
      return snapshots[0];
    }
  } catch { /* 目录不存在等 → 返回规范名，让调用方报"未登录" */ }

  return canonical;
}

/**
 * 解析登录态文件（纯函数）。
 *
 * @param {string} raw 文件内容（JSON）
 * @returns {{account: object|null, auth: object|null}}
 * @throws {Error} 非法 JSON
 */
export function parseAuthState(raw) {
  const j = JSON.parse(raw);
  const account = j?.account && typeof j.account === 'object' ? j.account : null;
  const auth = j?.auth && typeof j.auth === 'object' ? j.auth : null;
  return { account, auth };
}

/**
 * 凭据可用性单点判定：accessToken 必须是非空字符串。
 *
 * 为什么需要单点：桌面端新版把凭据文件字段写成信封加密对象
 * （{"$wbEncrypted":1,"envelope":...}）——对象是 truthy，不加判定会被
 * 当作「有 token」穿过写入/读取/注入全链路（写坏记录、Bearer [object Object]、
 * env 注入非法值）。写入侧（account-store.toAccountRecord）、读取侧
 * （account-store.listAccounts）、消费侧（backend-process 注入）共用本谓词。
 */
export function isUsableToken(v) {
  return typeof v === 'string' && v.length > 0;
}

/**
 * 从登录态解析结果中归一取凭据。
 *
 * reason 词汇表：ok / encrypted（信封加密对象）/ missing（缺失）/ invalid（其他非字符串）。
 * 消费方对未知值应 fail-open（按「不可读 + 给引导」处理）。
 *
 * @param {{account: object|null, auth: object|null}} state parseAuthState 的结果
 * @returns {{token: string|null, reason: 'ok'|'encrypted'|'missing'|'invalid'}}
 */
export function credentialOf(state) {
  const token = state?.auth?.accessToken;
  if (isUsableToken(token)) return { token, reason: 'ok' };
  if (token && typeof token === 'object') {
    if ('$wbEncrypted' in token || 'envelope' in token) return { token: null, reason: 'encrypted' };
    return { token: null, reason: 'invalid' };
  }
  if (token === undefined || token === null || token === '') return { token: null, reason: 'missing' };
  return { token: null, reason: 'invalid' };
}

/** 非空字符串或 null（加密信封对象/数值等一律归 null）——展示字段归一单点 */
export function strOrNull(v) {
  return typeof v === 'string' && v ? v : null;
}

/**
 * 读取可用的 accessToken（跑后端 CLI 时注入 CODEBUDDY_AUTH_TOKEN 用）。
 *
 * 为什么需要：CLI 自己那份登录态（~/.codebuddy）会独立失效——实测出现过
 * CLI 报 "Authentication required" 但同一账号的 accessToken 仍然有效的情况。
 * 把凭据显式注入给后端子进程，登录状态就只依赖这一个来源，不再受 CLI
 * 自身存储状态影响。
 *
 * @param {string} [file] 登录态文件路径（默认自动定位）
 * @returns {{token: string, source: string}|null} 不可用（缺文件/缺 token/已过期）返回 null
 */
export function readAccessToken(file = authStatePath()) {
  try {
    const state = parseAuthState(fs.readFileSync(file, 'utf8'));
    const { token, reason } = credentialOf(state);
    if (reason !== 'ok') return null;
    const expiresAt = Number(state.auth?.expiresAt) || 0;
    if (expiresAt && Date.now() >= expiresAt) return null;
    return { token, source: file };
  } catch {
    return null;
  }
}

/**
 * account-info.js — 兼容 re-export（refactor-20260926-arch-deepening 候选⑤）。
 *
 * 实现已按职责拆分：
 *   - 凭据定位（authDir/authStatePath/parseAuthState/readAccessToken）→ auth-credentials.js
 *   - 计费余额（parseResourceSummary/getAccountSummary/fetchBalance/formatAccountSummary）→ billing.js
 * 本文件保留只为既有引用面（src/gateway-discovery.js / account-pool.js / router.js / index.js、
 * scripts/*、tests/account-info.test.js）零改动；存储层 account-store.js 已改直连
 * auth-credentials.js（存储层不再加载网络层）。新代码请直接 import 上述两模块。
 */

export { authDir, authStatePath, parseAuthState, readAccessToken } from './auth-credentials.js';
export { parseResourceSummary, getAccountSummary, fetchBalance, formatAccountSummary } from './billing.js';

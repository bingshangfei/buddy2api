/**
 * account-pool.js — 账号池：余额优先选择 + 轮转兜底 + 异常冷却。
 *
 * 目标：
 *   1. 候选账号都空闲（未冷却）时，优先用余额（credits remaining）多的；
 *      余额未知/持平/耗尽时在同层内 round-robin 轮转摊开
 *   2. 某账号异常（429 频控 / 认证失败）→ 冷却一段时间，期间用其他账号
 *   3. 全部冷却时 → 选最快恢复的那个（而不是直接失败）
 *
 * 状态是内存里的（进程重启即复位）：
 *   - 轮转游标 cursor
 *   - 每个账号的冷却截止时间、连续失败次数、最近一次失败原因
 *   - 每个账号的余额缓存 balances（启动 validateAll 读取一次 + 每 2h 定时刷新；
 *     刷新失败保留旧值。pick 只读缓存，选号路径零网络请求）
 *
 * 与后端进程池的关系：后端进程在 spawn 时注入某个账号的 token，因此
 * **后端是账号绑定的**。GatewayPool 按 accountId 复用/新建后端。
 */

import { listAccounts } from './account-store.js';
import { fetchBalance } from './account-info.js';
import { classifyAccountFailure, isAuthFailureNarrow } from './error-classifier.js';

/** 不同失败原因对应的冷却时长（ms） */
export const COOLDOWN_MS = {
  'rate-limit': 10 * 60 * 1000,  // 429 频控：10 分钟（配额通常按小时/天恢复）
  auth: 30 * 60 * 1000,          // 认证失败：30 分钟（可能需要重新登录）
  error: 60 * 1000,              // 其他错误：1 分钟（可能是偶发）
};

/** 余额缓存定时刷新间隔（ms）。冷启动 validateAll 读取一次，此后按此间隔刷新 */
export const BALANCE_REFRESH_INTERVAL_MS = 2 * 60 * 60 * 1000;

/** 账号列表缓存窗口（ms）：定时器按此间隔预刷新，请求路径同步重读只作兜底 */
export const ACCOUNT_REFRESH_INTERVAL_MS = 30_000;

export class AccountPool {
  /**
   * @param {object} [opts]
   * @param {Function} [opts.fetchBalance] 余额查询实现（测试注入）
   * @param {number} [opts.refreshIntervalMs] 定时刷新间隔，0 关闭定时器（测试注入）
   * @param {number} [opts.accountRefreshMs] 账号列表预刷新间隔，0 关闭（测试注入）
   */
  constructor({ fetchBalance: fetchBalanceImpl, refreshIntervalMs = BALANCE_REFRESH_INTERVAL_MS, accountRefreshMs = ACCOUNT_REFRESH_INTERVAL_MS } = {}) {
    this.cursor = 0;
    // accountId -> { cooldownUntil, failures, lastReason, lastFailureAt }
    this.health = new Map();
    // accountId -> { remaining, total, unit, at }（at = 采样时间戳 ms）
    this.balances = new Map();
    this._fetchBalance = fetchBalanceImpl || fetchBalance;
    this._accounts = [];
    this._loadedAt = 0;
    if (refreshIntervalMs > 0) {
      this._refreshTimer = setInterval(() => {
        this.refreshBalances().catch(() => {});
      }, refreshIntervalMs);
      this._refreshTimer.unref?.();
    }
    if (accountRefreshMs > 0) {
      // 账号列表预刷新（架构深化第 8 批 C1）：读盘从请求路径挪到后台定时器——
      // accounts() 的首调同步 bootstrap（_loadedAt=0）与 force 语义保留，
      // 定时器被饿死时请求路径的重读条件仍在，行为兜底不变（F5）。
      this._accountRefreshTimer = setInterval(() => {
        try { this.accounts({ force: true }); } catch { /* 后台预读失败由请求路径兜底 */ }
      }, accountRefreshMs);
      this._accountRefreshTimer.unref?.();
    }
  }

  /** 停止定时刷新（测试/停服用；生产定时器已 unref，不阻塞进程退出） */
  dispose() {
    if (this._refreshTimer) {
      clearInterval(this._refreshTimer);
      this._refreshTimer = null;
    }
    if (this._accountRefreshTimer) {
      clearInterval(this._accountRefreshTimer);
      this._accountRefreshTimer = null;
    }
  }

  /** 游标轮转：取 list 内游标指向的元素并推进游标 */
  _rotate(list) {
    const idx = this.cursor % list.length;
    this.cursor = (this.cursor + 1) % Math.max(1, list.length);
    return list[idx];
  }

  /**
   * 载入/刷新账号列表（缓存窗口 ACCOUNT_REFRESH_INTERVAL_MS；正常由构造器
   * 定时器预刷新，本函数的重读条件只作首调 bootstrap / force / 定时器被饿死
   * 时的请求路径兜底——架构深化第 8 批 C1）。
   */
  accounts({ force = false, now = Date.now() } = {}) {
    if (force || now - this._loadedAt > ACCOUNT_REFRESH_INTERVAL_MS) {
      this._accounts = listAccounts({ now });
      this._loadedAt = now;
      // 清理已不存在账号的健康状态与余额缓存
      const ids = new Set(this._accounts.map((a) => a.id));
      for (const id of this.health.keys()) {
        if (!ids.has(id)) this.health.delete(id);
      }
      for (const id of this.balances.keys()) {
        if (!ids.has(id)) this.balances.delete(id);
      }
    }
    return this._accounts;
  }

  /** 是否配置了多个账号 */
  hasMultiple() {
    return this.accounts().length > 1;
  }

  /**
   * 选一个账号。
   *
   * 策略：
   *   1. 有未冷却的账号 → 余额感知排序：
   *      已知且 remaining>0 的优先，按余额降序（并列最高者组内按游标轮转）；
   *      未知或已耗尽（≤0）的排最后，按游标轮转兜底。
   *      全部余额未知时与纯 round-robin 行为完全一致。
   *   2. 全部冷却 → 返回最快恢复的那个（附 cooldownMs 供调用方告警）
   *   3. 一个账号都没配 → 返回 null（调用方回退到单账号凭据）
   *
   * 同步、零网络：只读 balances 缓存，余额新鲜度由 validateAll/refreshBalances 保证。
   *
   * @param {number} [now]
   * @returns {{account: object, coolingDown: boolean, cooldownMs: number}|null}
   */
  pick({ now = Date.now() } = {}) {
    const all = this.accounts({ now });
    if (all.length === 0) return null;

    const ready = all.filter((a) => !this._isCoolingDown(a.id, now));
    if (ready.length > 0) {
      const withCredit = [];
      const fallback = [];
      for (const a of ready) {
        const b = this.balances.get(a.id);
        if (b && b.remaining > 0) withCredit.push([a, b.remaining]);
        else fallback.push(a);
      }

      if (withCredit.length > 0) {
        withCredit.sort((x, y) => y[1] - x[1]);
        const top = withCredit[0][1];
        const leaders = withCredit.filter(([, r]) => r === top).map(([a]) => a);
        return { account: this._rotate(leaders), coolingDown: false, cooldownMs: 0 };
      }

      return { account: this._rotate(fallback), coolingDown: false, cooldownMs: 0 };
    }

    // 全部冷却：挑最快恢复的
    let soonest = null;
    let minWait = Infinity;
    for (const a of all) {
      const wait = (this.health.get(a.id)?.cooldownUntil ?? 0) - now;
      if (wait < minWait) {
        minWait = wait;
        soonest = a;
      }
    }
    return { account: soonest, coolingDown: true, cooldownMs: Math.max(0, minWait) };
  }

  /**
   * 上报一次成功（清空该账号的失败计数）。
   */
  reportSuccess(accountId) {
    const h = this.health.get(accountId);
    if (h) {
      h.failures = 0;
      h.cooldownUntil = 0;
      h.lastReason = null;
    }
  }

  /**
   * 上报一次失败，按原因设置冷却。
   *
   * @param {string} accountId
   * @param {'rate-limit'|'auth'|'error'} kind
   * @param {number} [now]
   * @returns {{cooldownUntil: number, cooldownMs: number}}
   */
  reportFailure(accountId, kind = 'error', { now = Date.now() } = {}) {
    const h = this.health.get(accountId) || { failures: 0 };
    h.failures += 1;
    // 连续失败时冷却时间翻倍（上限 4 倍），避免反复踩同一个坏账号
    const base = COOLDOWN_MS[kind] ?? COOLDOWN_MS.error;
    const multiplier = Math.min(4, Math.max(1, h.failures));
    h.cooldownUntil = now + base * multiplier;
    h.lastReason = kind;
    h.lastFailureAt = now;
    this.health.set(accountId, h);
    return { cooldownUntil: h.cooldownUntil, cooldownMs: h.cooldownUntil - now };
  }

  /**
   * 账号是否在冷却中。
   */
  _isCoolingDown(accountId, now = Date.now()) {
    const h = this.health.get(accountId);
    return Boolean(h && h.cooldownUntil > now);
  }

  /**
   * 公开别名：会话亲和用——粘住"上次用过的账号"前先确认它没在冷却，
   * 冷却中则回退 round-robin（pick 内部会跳过冷却账号）。
   */
  isCoolingDown(accountId, now = Date.now()) {
    return this._isCoolingDown(accountId, now);
  }

  /**
   * 汇总状态（供 /v1/accounts 与日志展示）。
   */
  status({ now = Date.now() } = {}) {
    return this.accounts({ force: true, now }).map((a) => {
      const h = this.health.get(a.id);
      const cooling = this._isCoolingDown(a.id, now);
      const b = this.balances.get(a.id);
      return {
        id: a.id,
        nickname: typeof a.nickname === 'string' ? a.nickname : null,
        type: typeof a.type === 'string' ? a.type : null,
        expiresAt: a.expiresAt,
        coolingDown: cooling,
        cooldownMs: cooling ? h.cooldownUntil - now : 0,
        failures: h?.failures ?? 0,
        lastReason: h?.lastReason ?? null,
        lastFailureAt: h?.lastFailureAt ?? null,
        ...(b ? { balance: { remaining: b.remaining, total: b.total, unit: b.unit, at: b.at } } : {})
      };
    });
  }

  /** 清空健康状态（测试用） */
  reset() {
    this.cursor = 0;
    this.health.clear();
    this.balances.clear();
    this._loadedAt = 0;
    this._accounts = [];
  }

  /**
   * 探活单个账号（走计费接口，一次便宜的网络调用）。
   *
   * 为什么需要：凭据文件里的 `expiresAt` 只是名义有效期，token 可能被服务端
   * 提前吊销（实测：某账号 expiresAt 还有一个月，但接口直接 401）。
   * 不探活的话，前几个请求会白白打到死账号上才切换。
   *
   * @returns {Promise<{ok: true, balance: object} | {ok: false, reason: string, kind: string}>}
   */
  async probeAccount(account, { timeoutMs = 8000 } = {}) {
    try {
      const balance = await this._fetchBalance({ token: account.accessToken, uid: account.uid, timeoutMs });
      return { ok: true, balance };
    } catch (e) {
      const msg = e?.message || String(e);
      const kind = isAuthFailureNarrow(msg) ? 'auth' : 'error'; // 窄面定义在 error-classifier.js
      return { ok: false, reason: msg, kind };
    }
  }

  /**
   * 探活全部账号，把失效的置入冷却。
   *
   * 服务启动时调用（异步、不阻塞启动）。探活失败的账号不会参与轮转，
   * 直到冷却结束或手动重新登录后再探。
   *
   * @returns {Promise<{healthy: Array, unhealthy: Array}>}
   */
  async validateAll({ now = Date.now(), timeoutMs = 8000 } = {}) {
    const all = this.accounts({ force: true, now });
    const healthy = [];
    const unhealthy = [];

    await Promise.all(all.map(async (a) => {
      const r = await this.probeAccount(a, { timeoutMs });
      if (r.ok) {
        this.reportSuccess(a.id);
        this.balances.set(a.id, { ...r.balance, at: now });
        healthy.push({ account: a, balance: r.balance });
      } else {
        this.reportFailure(a.id, r.kind, { now });
        unhealthy.push({ account: a, reason: r.reason, kind: r.kind });
      }
    }));

    return { healthy, unhealthy };
  }

  /**
   * 刷新全部账号的余额缓存（定时器每 2h 调一次，也可手动触发）。
   *
   * 与 validateAll 的区别：只管余额缓存，不动健康/冷却状态——
   * 余额接口偶尔失败不代表账号不可用，此时保留旧值（staleness 优于 unknown）。
   *
   * @returns {Promise<{updated: number, failed: number}>}
   */
  async refreshBalances({ now = Date.now(), timeoutMs = 8000 } = {}) {
    const all = this.accounts({ now });
    let updated = 0;
    let failed = 0;
    await Promise.all(all.map(async (a) => {
      const r = await this.probeAccount(a, { timeoutMs });
      if (r.ok) {
        this.balances.set(a.id, { ...r.balance, at: now });
        updated += 1;
      } else {
        failed += 1;
      }
    }));
    return { updated, failed };
  }
}

// 冷却分级（宽 auth 面）定义已迁 error-classifier.js（分类学单点）；本模块保持导出点，
// 签名与返回类目不变（tests/account-pool.test.js 锁定）。
export { classifyAccountFailure as classifyFailure } from './error-classifier.js';

/** 全局单例 */
export const accountPool = new AccountPool();

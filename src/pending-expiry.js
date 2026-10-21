/**
 * pending-expiry.js — 挂起工具调用的定时器武装与到期守卫原语（零依赖叶，无 import）。
 *
 * 抽出理由（第三批批2，独立审视 F3 缩形）：本模块只放「武装定时器 + 到期判定
 * + 条目表生命周期」三类零依赖原语，使 TTL 语义获得假时钟直测面（此前只能整体
 * 替换 handler 方法或等真实 5 分钟）。
 *
 * 条目表（`PendingTable`，2026-10-19）：Map 语义 + 「条目的 timer 跟随条目消亡」
 * 不变量——delete/覆盖/clear 时自动 clearTimeout。放在本模块是因为它只依赖
 * 定时器语义，与 handler 的销毁序列无关。
 *
 * 定向销毁序列（delete → cancelPrompt → iterator.return → invalidate 同 poolId）
 * 是被测试钉死的行为锚，**留在 handler `_onPendingTimeout` 原地**——本模块只提供
 * 「何时算到期」「怎么定时」「条目何时消亡」，不拥有「到期后做什么」。
 */

/** 挂起的工具调用最长等待时间。 */
export const DEFAULT_PENDING_TTL_MS = 5 * 60 * 1000;

/**
 * 挂起条目表：Map 语义 + **条目生命周期与 timer 绑定**。
 *
 * 不变量：条目的 timer 跟随条目消亡——`delete` 删除、`set` 覆盖同 key 旧条目、
 * `clear` 清表时，旧条目的 timer 一律 `clearTimeout`。任何清理出口（含未来新增）
 * 都自动满足，无需在每个调用点记得清 timer（历史缺陷：7 个出口只 delete）。
 *
 * 只扩展生命周期语义，不改变 Map 接口；`deps.pending` 注入面保持可用。
 */
export class PendingTable extends Map {
  /** @param {{ clearTimeoutFn?: typeof clearTimeout }} [opts] 注入位（测试假时钟） */
  constructor({ clearTimeoutFn = clearTimeout } = {}) {
    super();
    this._clearTimeout = clearTimeoutFn;
  }

  set(key, value) {
    const prev = super.get(key);
    // 同一对象重复 set 不清：它的 timer 可能刚被重新武装，清掉会让挂起失去超时。
    if (prev && prev !== value) this._clearTimeout(prev.timer);
    return super.set(key, value);
  }

  delete(key) {
    const prev = super.get(key);
    if (prev) this._clearTimeout(prev.timer);
    return super.delete(key);
  }

  clear() {
    for (const value of super.values()) this._clearTimeout(value?.timer);
    return super.clear();
  }
}

/**
 * 武装一条挂起条目的超时定时器（先清旧再设新，重复武装幂等）。
 *
 * @param {object|null} state 挂起条目；`timer` 字段挂在条目上（与现状同构）。
 *   null/undefined 时 no-op（handler 侧 set 后才 arm，理论不空，守卫兜底）。
 * @param {() => void} onExpire 到期回调
 * @param {object} [opts]
 * @param {number} [opts.ttlMs=DEFAULT_PENDING_TTL_MS]
 * @param {typeof setTimeout} [opts.setTimeoutFn] 注入位（测试假时钟）
 * @param {typeof clearTimeout} [opts.clearTimeoutFn] 注入位（测试假时钟）
 */
export function armPendingTimer(state, onExpire, { ttlMs = DEFAULT_PENDING_TTL_MS, setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout } = {}) {
  if (!state) return;
  clearTimeoutFn(state.timer);
  state.timer = setTimeoutFn(onExpire, ttlMs);
}

/**
 * 到期守卫：该条目是否「无可取消」（true = 跳过销毁）。
 *
 * 「已在回传中」必须靠 resuming 显式判断：续跑期间 toolCall 仍然保留
 * （理由见 handler `_continuePending`），只按 toolCall 判断会把一条**正在跑的**
 * 续跑误当成"没人认领的挂起"取消掉。历史守卫是 `s && !s.toolCall`——条目缺失时
 * 反而继续往下执行，invalidate(key, undefined) 会按 key 定位到**其他请求正在
 * 占用的连接**并销毁之（完成后 5 分钟延迟引爆的串台源）。
 *
 * @param {object|null} s 挂起条目
 * @returns {boolean}
 */
export function pendingExpiryNoop(s) {
  return !s || !s.toolCall || Boolean(s.resuming);
}

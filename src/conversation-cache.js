/**
 * conversation-cache.js — 多轮对话的"会话亲和"（前缀复用）判定。
 *
 * 背景（实测结论）：
 * codebuddy 后端每条 prompt 都带一段固定超大前缀（agent 系统提示 + 工具定义，
 * deepseek-v4.1-flash 实测 ~22.7k tokens）。开前缀缓存命中时只有几百 token 计费，
 * 但 buddy2api 每请求新建会话——实测新会话首条请求约 40% 概率全量 miss（烧
 * 22k+ tokens），而同一条会话连续多轮几乎必然命中（miss 10~235）。
 * 根因是"每请求新建会话"这个为隔离上下文而做的设计，恰好破坏了后端前缀缓存。
 *
 * 本模块记录"上一次成功发给某后端会话的完整 prompt 文本"，让下一条请求在文本
 * 严格扩展自上次时只发送增量（delta）、复用同一后端会话：
 *   - 拿到稳定的前缀缓存命中（省 token）
 *   - 后端记忆 = 我们已发送的全部内容，不会与客户端历史重复叠加
 *
 * 复用条件（任一不满足即回退新建会话，安全优先）：
 *   - 同一 key（API key 隔离）
 *   - 未过期（TTL）
 *   - 模型一致
 *   - 本次文本以"上次文本"为严格前缀且更长
 *     （newText.startsWith(lastText) 且 newText.length > lastText.length）
 *   - 后端会话仍在连接池且空闲（由调用方 acquireExisting 保证）
 *
 * 纯逻辑、零 I/O，便于单测。
 */

/**
 * @typedef {object} ConversationEntry
 * @property {string} sessionId 后端 ACP 会话 id
 * @property {string} poolId   连接池 id（定位承载该会话的连接）
 * @property {string} model    该会话使用的（请求侧）模型标识
 * @property {string} text     上一次成功发送的完整 prompt 文本
 * @property {number} turns    已复用轮次
 * @property {number} lastUsedAt
 */

export class ConversationCache {
  /**
   * @param {object} [opts]
   * @param {number} [opts.ttlMs=10*60*1000] 条目存活时间（超过后不再复用）
   * @param {number} [opts.maxEntriesPerKey=8] 每个 key 保留的会话条目上限（LRU 淘汰）
   * @param {number} [opts.maxTurns=12] 单会话最大复用轮次（防止上下文无限膨胀）
   */
  constructor({ ttlMs = 10 * 60 * 1000, maxEntriesPerKey = 8, maxTurns = 12 } = {}) {
    this.ttlMs = ttlMs;
    this.maxEntriesPerKey = maxEntriesPerKey;
    this.maxTurns = maxTurns;
    /** @type {Map<string, ConversationEntry[]>} */
    this.byKey = new Map();
  }

  /**
   * 查找可复用的会话：返回最长匹配的条目与应发送的增量文本。
   *
   * 多个条目可能都满足"是新文本的前缀"（同会话的历史版本），取最长者最精确。
   * 严格更长（不是完全相同）才复用之——完全相同多半是重试，应新建会话。
   *
   * @param {string} key
   * @param {string} text 本次完整 prompt 文本
   * @param {string} model
   * @param {number} [now]
   * @returns {{entry: ConversationEntry, delta: string}|null}
   */
  lookup(key, text, model, now = Date.now()) {
    const list = this.byKey.get(key);
    if (!list || list.length === 0) return null;
    if (typeof text !== 'string' || text.length === 0) return null;

    let best = null;
    for (const entry of list) {
      if (entry.model !== model) continue;
      if (now - entry.lastUsedAt > this.ttlMs) continue;
      if (text.length <= entry.text.length) continue;
      if (!text.startsWith(entry.text)) continue;
      if (!best || entry.text.length > best.text.length) best = entry;
    }
    if (!best) return null;
    return { entry: best, delta: text.slice(best.text.length) };
  }

  /**
   * 记住/更新某会话已发送的完整文本。
   *
   * - 同 sessionId 已存在 → 原地更新（复用了同一会话，轮次 +1）
   * - 否则视为新会话：清掉被本次文本"覆盖"的旧条目（旧文本是本次前缀者，
   *   即同一对话的上一代会话），再新增
   * - 超过 maxTurns → 丢弃该条目（下轮重新冷启动，避免上下文无限增长）
   * - 超过 maxEntriesPerKey → 淘汰最久未使用的条目
   *
   * @param {string} key
   * @param {{sessionId:string, poolId:string, model:string}} ref
   * @param {string} text
   * @param {number} [now]
   * @returns {ConversationEntry|null} 记录后的条目；被 maxTurns 丢弃时返回 null
   */
  remember(key, ref, text, now = Date.now()) {
    if (!ref?.sessionId || typeof text !== 'string' || text.length === 0) return null;

    // 顺手清理过期条目（架构深化第 8 批微修③）：purge 此前生产零调用，TTL 过期
    // 条目永不回收（每条目存全文，长时运行下内存无界）。放在分支入口——
    // 续写会话走的 existing 早退路径同样清到；本次刚写入/更新的条目
    // lastUsedAt = now，不会被自己清掉。
    this.purge(now);

    let list = this.byKey.get(key);
    if (!list) { list = []; this.byKey.set(key, list); }

    const existing = list.find(e => e.sessionId === ref.sessionId);
    if (existing) {
      existing.text = text;
      existing.poolId = ref.poolId;
      existing.model = ref.model;
      existing.turns += 1;
      existing.lastUsedAt = now;
      if (existing.turns >= this.maxTurns) {
        // 轮次到顶：不再复用，下一轮冷启动一个新会话（接受一次 miss）
        this.forget(key, ref.poolId);
        return null;
      }
      return existing;
    }

    // 新会话：清掉被本次文本覆盖的旧条目（旧文本是本次前缀 → 同一对话的上代）
    for (let i = list.length - 1; i >= 0; i--) {
      if (text.startsWith(list[i].text) && list[i].text.length > 0) list.splice(i, 1);
    }

    const entry = {
      sessionId: ref.sessionId,
      poolId: ref.poolId,
      model: ref.model,
      text,
      turns: 1,
      lastUsedAt: now
    };
    list.push(entry);

    if (list.length > this.maxEntriesPerKey) {
      list.sort((a, b) => b.lastUsedAt - a.lastUsedAt);
      list.splice(this.maxEntriesPerKey);
    }
    return entry;
  }

  /** 丢弃某 key 下所有挂在指定连接池上的条目（连接失效/请求失败时调用）。 */
  forget(key, poolId) {
    const list = this.byKey.get(key);
    if (!list) return;
    const kept = list.filter(e => e.poolId !== poolId);
    if (kept.length === 0) this.byKey.delete(key);
    else this.byKey.set(key, kept);
  }

  /** 丢弃某 key 的全部条目。 */
  clear(key) {
    this.byKey.delete(key);
  }

  /** 清理所有过期条目（定期调用或测试用）。 */
  purge(now = Date.now()) {
    for (const [key, list] of this.byKey) {
      const kept = list.filter(e => now - e.lastUsedAt <= this.ttlMs);
      if (kept.length === 0) this.byKey.delete(key);
      else this.byKey.set(key, kept);
    }
  }

  /** 条目总数（测试用）。 */
  size() {
    let n = 0;
    for (const list of this.byKey.values()) n += list.length;
    return n;
  }
}

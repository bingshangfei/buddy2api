/**
 * session-manager.js — 连接池管理（stateless 语义 + 并发隔离）。
 *
 * 语义契约：
 * - 会话每次请求新建（fresh），用完即弃，绝不缓存复用。
 *   因为 handler 以 OpenAI 方式发送完整消息历史（stateless 假设），
 *   复用会话会让后端的记忆与客户端历史双重叠加（上下文重复）。
 * - 连接（connect/initialize）按需创建，同一连接同一时刻只服务一个请求。
 *
 * 并发隔离（关键）：
 * - acquire() 会**同步占位**（pool.busy = true），不等 prompt 真正开始。
 *   早期实现只在"连接上已有在飞 prompt"时才新建连接，但并发请求会在第一条
 *   prompt 开始前就进入 acquire，检测不到占用 → 两个请求复用同一连接 →
 *   两个会话挤在一个 ACP 连接上，表现为 setModel 报 Internal error、输出串台。
 * - 占位后该连接不可再被其他请求复用，release() 才释放。
 *
 * 会话隔离：
 * - createSession 默认使用 `os.tmpdir()/buddy2api-api/<uuid>` 作为工作目录，
 *   每次 acquire 生成随机子目录，确保 session/new 不会附着到桌面端已打开的
 *   任何会话上，避免继承 100k+ tokens 的上下文污染。
 *
 * 故障自愈：acquire 时捕获错误 → 丢弃坏连接 → 重建 → 重试一次。
 */

import { AcpClient } from './acp-client.js';
import { extractModelsFromSessionResult } from './acp-events.js';
import { discoverGatewayUrl, backendPool, toolsFlavorOf } from './gateway-discovery.js';
import { ConvPoolMap } from './conv-account-map.js';
import { accountPool, classifyFailure } from './account-pool.js';

export const CONNECTION_TTL_MS = 30 * 60 * 1000; // 连接空闲超过此时间后丢弃，下次重建
// 不变量：conversation-cache 的 ttlMs（10min）必须 <= CONNECTION_TTL_MS。
// 会话缓存命中后会拿 poolId 走 acquireExisting，而 acquireExisting 用本 TTL 判定
// 接受与否；缓存活得比连接久就会出现"缓存里有条目、连接已被 TTL 拒收"的空转
// （每次都要 forget + 回退新建）。将来任何一方要调，先核对这个不等式。
// 反过来的方向（把本 TTL 拉长以保温）**不是**这里的目的——本 TTL 是泄漏兜底
// （见 isReusable 说明），保温寿命是另一件事，别混。

/**
 * 连接是否可被复用（单一判据）。
 *
 * 这个判断此前内联在三处（acquireExisting / _takeIdlePool 的亲和分支与通用
 * 分支），任何一处漏改都会造成"某条路径上连接被复用/被拒"的口径漂移。
 *
 * 三个条件缺一不可：
 * - `busy`：占位是同步的，从占位那刻起其他请求不得再选中（并发串台的根源）。
 * - 空闲时长超过 CONNECTION_TTL_MS：这是**泄漏兜底**——漏一次 release 会让池
 *   永久 busy，短周期 TTL 保证它自然过期而不是永久占坑（代价远低于误伤他人
 *   连接）。它**不是**保温策略，别把它当"会话能活多久"来调。
 * - 连接上仍有在飞 prompt：后端正忙，复用会把两个请求挤进一条 ACP 连接。
 *
 * 判据与收拢前的内联写法一致。`hasInflightPrompt` 保留 typeof 守卫而不用可选链：
 * 池级亲和的既有用例会手搓不含 client 的 pool 对象（tests/session-reuse.test.js
 * 的"池级亲和"组），直接调用会 TypeError。生产路径的池恒由 _createPool 构造、
 * client 必然存在，所以该守卫只在测试夹具下生效，不改变线上判据。
 *
 * @param {{busy: boolean, lastUsedAt: number, client: object}} pool
 * @param {number} [now=Date.now()]
 * @returns {boolean}
 */
export function isReusable(pool, now = Date.now()) {
  if (pool.busy) return false;
  if (now - pool.lastUsedAt > CONNECTION_TTL_MS) return false;
  if (typeof pool.client.hasInflightPrompt === 'function' && pool.client.hasInflightPrompt()) return false;
  return true;
}

let nextPoolId = 0;

export class SessionManager {
  constructor(gatewayUrl = null) {
    this.gatewayUrl = gatewayUrl; // 显式指定的 URL（测试用）；null 表示每次自动发现
    // poolId -> { id, key, client, url, models, lastUsedAt, busy, convId }
    this.pools = new Map();
    // convId -> poolId：会话级亲和。同会话优先复用上次的连接（同后端/同账号），
    // 避免同 key 的多个会话在空闲池之间随机穿越、每次落在不同账号上。
    // 有界 LRU（ConvPoolMap，批5）：上限 500 与 convAccounts 对齐；淘汰时先删
    // 指向已销毁池的死条目再动活条目（审视 F8——静默亲和失效窗口趋近零），
    // 淘汰打日志可观测。**这是本任务唯一申报的行为变化点**（requirements D6）。
    this.convPools = new ConvPoolMap({
      isDead: (poolId) => !this.pools.has(poolId),
      onEvict: (convId, poolId, dead) => {
        if (!dead) {
          console.warn(`[buddy2api] convPools LRU evicted live affinity (convId=${convId}, poolId=${poolId})`);
        }
      }
    });
    // 注意：不做"按模型缓存会话"——同 key 不同对话命中同一条后端会话会把
    // 上一对话的上下文与本次完整历史叠加（跨对话串台），违反本文件头
    // "会话每次请求新建" 的契约。同模型的免 setModel 复用由
    // conversation-cache 的亲和路径安全覆盖（lookup 要求 model 一致）。
  }

  /**
   * 获取一个"新鲜"会话（每次请求调用一次）。
   *
   * 优先复用**本会话**上次的空闲连接（会话级亲和），其次任意同 key、同工具
   * 风味的空闲连接；都没有则新建。返回的 poolId 用于 release/invalidate
   * 精确定位本请求的连接。
   *
   * @param {string} key 连接隔离键（如 API key）
   * @param {object} [opts]
   * @param {boolean} [opts.needsTools=true] 是否需要内置工具的后端（见
   *        gateway-discovery.js 的"工具风味"）。纯聊天用 false 走精简后端。
   * @param {string|null} [opts.preferredAccountId=null] 会话亲和：该会话上次
   *        使用的账号。后端与账号绑定，粘住同一账号可命中云端按账号计的
   *        前缀缓存；该账号冷却时自动回退 round-robin。
   * @param {string|null} [opts.convId=null] 会话标识（见 openai-handler 的
   *        _conversationId），池级亲和的查找键。
   * @returns {Promise<{sessionId, client, models, poolId, backendUrl}>}
   */
  async acquire(key = 'default', { needsTools = true, preferredAccountId = null, convId = null } = {}) {
    const pool = this._takeIdlePool(key, needsTools, convId) || await this._createPool(key, needsTools, preferredAccountId, convId);

    try {
      const session = await pool.client.createSession();
      pool.lastUsedAt = Date.now();
      this._refreshModels(pool, session);
      return {
        sessionId: session.sessionId,
        client: pool.client,
        models: pool.models,
        poolId: pool.id,
        backendUrl: pool.url,
        accountId: backendPool.accountIdFor(pool.url)
      };
    } catch (error) {
      // 故障自愈：坏连接 → 丢弃 → 重建 → 重试一次
      console.warn(`[SessionManager] acquire failed (${error.message}), rebuilding connection...`);
      this.invalidate(key, pool.id);

      const fresh = await this._createPool(key, needsTools, preferredAccountId, convId);
      const session = await fresh.client.createSession();
      fresh.lastUsedAt = Date.now();
      this._refreshModels(fresh, session);
      return {
        sessionId: session.sessionId,
        client: fresh.client,
        models: fresh.models,
        poolId: fresh.id,
        backendUrl: fresh.url,
        accountId: backendPool.accountIdFor(fresh.url)
      };
    }
  }

  /**
   * 丢弃连接池 + 其承载的后端进程（连接已确认不可用时调用）。
   *
   * 与 invalidate 的区别：invalidate 归还后端（release，留池复用），适用于
   * "连接坏了但后端进程可能还活着"；discardPool 连后端一起从进程池删除，
   * 适用于"后端进程已死"（ECONNREFUSED/被回收器误杀后残留的引用）——
   * 归还一个死后端只会让后续 acquire 反复做健康检查再丢弃。
   */
  discardPool(key = 'default', poolIdOrUrl = null) {
    const pool = this._resolvePool(key, poolIdOrUrl);
    if (!pool) return;
    try { pool.client?.destroy?.(); } catch { /* ignore */ }
    if (pool.url) backendPool?.discardBackend?.(pool.url);
    this.pools.delete(pool.id);
  }

  /**
   * 复用一条已存在的会话（会话亲和/前缀缓存优化的关键路径）。
   *
   * 与 acquire() 不同：不新建 session/new，而是把某条已知的空闲连接再次占位，
   * 让调用方在**同一条后端会话**上续发增量（见 conversation-cache.js）。
   * 这样后端前缀缓存稳定命中，且后端记忆与客户端历史不会重复叠加。
   *
   * 安全前提（任一不满足返回 null，调用方回退 acquire() 新建会话）：
   * 连接池存在、key 匹配、空闲、未过期、无在飞 prompt。
   *
   * @param {string} key
   * @param {string} poolId
   * @param {string} sessionId 期望复用的会话 id（原样回传）
   * @returns {{sessionId, client, models, poolId, backendUrl, accountId}|null}
   */
  acquireExisting(key, poolId, sessionId) {
    const pool = this.pools.get(poolId);
    if (!pool || pool.key !== key) return null;
    if (!isReusable(pool)) return null;

    this._claim(pool);
    return {
      sessionId,
      client: pool.client,
      models: pool.models,
      poolId: pool.id,
      backendUrl: pool.url,
      accountId: backendPool.accountIdFor(pool.url)
    };
  }

  /**
   * 占位一条连接：从这一刻起其他请求不得再选中它（同步，不含 await）。
   *
   * 三处复用路径（`acquireExisting` / `_takeIdlePool` 的亲和分支与通用分支）共用
   * 这一份簿记，避免"某条路径忘了回写 busy"这类只有并发时才暴露的漂移。
   */
  _claim(pool, convId = null) {
    pool.busy = true;
    pool.lastUsedAt = Date.now();
    if (convId) {
      pool.convId = convId;
      this.convPools.set(convId, pool.id);
    }
    // 回写后端池 busy：防空闲回收器误杀使用中的后端（长流场景）
    backendPool?.markBusy?.(pool.url);
    return pool;
  }

  /** 连接池是否仍然存在（会话亲和条目用于判断承载会话的连接是否还活着）。 */
  hasPool(poolId) {
    return this.pools.has(poolId);
  }

  /**
   * 取一个可复用的空闲连接并占位；没有则返回 null。
   * 占位是同步的——从这一刻起其他请求不会再用这条连接。
   *
   * 风味必须一致：精简后端（无内置工具）与全量后端不能互相复用——
   * 前者注册不了委托工具，后者前缀大，串用会破坏语义或成本。
   *
   * 会话亲和：convId 上次用的连接还空闲 → 优先复用（同会话粘住同一
   * 后端/账号，命中云端缓存）；否则取任意空闲连接并记到该会话名下。
   */
  _takeIdlePool(key, needsTools = true, convId = null) {
    if (convId) {
      const preferred = this.convPools.get(convId);
      if (preferred) {
        const pool = this.pools.get(preferred);
        const reusable = pool
          && pool.key === key
          && this._poolTools(pool) === needsTools
          && isReusable(pool);
        if (reusable) {
          return this._claim(pool, convId);
        }
        // 连接不在了/被占用/过期 → 清掉指向，走通用选择
        this.convPools.delete(convId);
      }
    }

    for (const pool of this.pools.values()) {
      if (pool.key !== key) continue;
      if (this._poolTools(pool) !== needsTools) continue;
      if (!isReusable(pool)) continue;

      return this._claim(pool, convId);
    }
    return null;
  }

  /**
   * 刷新缓存的模型列表。
   *
   * 每次 acquire 都刷新（而非只在空时填一次）：后端刚启动时可能只返回
   * CLI 内置模型（云端账号模型列表尚未拉取完），若把这份不完整列表缓存住，
   * 客户端会看到缺失的模型集合直到连接过期。空结果不覆盖已有列表，避免
   * 一次异常响应把好数据清掉。
   */
  _refreshModels(pool, session) {
    if (!session) return;
    const models = extractModelsFromSessionResult(session);
    if (models.length > 0) {
      pool.models = models;
    }
  }

  /**
   * 释放会话：连接归还可用状态（不销毁，留给下一个串行请求复用）。
   *
   * @param {string} key 连接隔离键（兼容旧签名）
   * @param {string|number} poolIdOrUrl acquire 返回的 poolId（或旧的 backendUrl 形式）
   */
  release(key = 'default', poolIdOrUrl = null) {
    const pool = this._resolvePool(key, poolIdOrUrl);
    if (!pool) return;
    pool.busy = false;
    pool.lastUsedAt = Date.now();
    // 后端归还到进程池，标记为空闲
    if (pool.url) backendPool.release(pool.url);
  }

  /**
   * 上报账号健康结果（供 handler 在请求终态调用）。
   *
   * 429 频控 / 认证失败时把该账号置入冷却，后续请求会优先用其他账号
   * （见 account-pool.js）。成功则清除冷却。
   *
   * @param {string|null} accountId
   * @param {{ok: boolean, reason?: string}} result
   */
  reportAccountHealth(accountId, { ok, reason = null } = {}) {
    if (!accountId) return;
    if (ok) {
      accountPool.reportSuccess(accountId);
      return;
    }
    const kind = classifyFailure(reason || '');
    const { cooldownMs } = accountPool.reportFailure(accountId, kind);
    const acc = accountPool.accounts().find((a) => a.id === accountId);
    console.warn(`[SessionManager] Account ${acc?.nickname || accountId} marked unhealthy (${kind}), cooling down ${Math.round(cooldownMs / 1000)}s`);
  }

  /**
   * 使连接失效（客户端异常断开/取消后调用）：丢弃连接，归还后端。
   */
  invalidate(key = 'default', poolIdOrUrl = null) {
    const pool = this._resolvePool(key, poolIdOrUrl);
    if (!pool) return;
    try { pool.client?.destroy?.(); } catch { /* ignore */ }
    if (pool.url) backendPool.release(pool.url);
    this.pools.delete(pool.id);
  }

  /**
   * 定位 pool：优先用 poolId；兼容传 backendUrl 的旧调用。
   *
   * 故意**不**回退到"按 key 找忙碌连接"：定位失败多半意味着该连接已被
   * invalidate 删除（请求出错路径）——此时若按 key 兜底，会把同 key 另一个
   * 请求正在占用的连接误释放/误销毁（串台源）。宁可 no-op。
   */
  _resolvePool(key, poolIdOrUrl) {
    if (poolIdOrUrl != null) {
      const byId = this.pools.get(poolIdOrUrl);
      if (byId) return byId;
      for (const pool of this.pools.values()) {
        if (pool.url === poolIdOrUrl) return pool;
      }
    }
    return null;
  }

  /**
   * 获取缓存的模型列表。
   */
  getModels(key = 'default') {
    for (const pool of this.pools.values()) {
      if (pool.key === key && pool.models.length > 0) return pool.models;
    }
    return [];
  }

  /** 连接的工具体风味；undefined（旧数据/测试桩）视为全量，与旧行为一致。定义在 toolsFlavorOf 单点。 */
  _poolTools(pool) {
    return toolsFlavorOf(pool);
  }

  /**
   * 创建新连接池（并从后端进程池取一个符合风味的后端）。
   */
  async _createPool(key, needsTools = true, preferredAccountId = null, convId = null) {
    // 显式 URL 优先（测试用）；否则从后端进程池取一个空闲后端
    const url = this.gatewayUrl || await discoverGatewayUrl({ needsTools, preferredAccountId });

    const client = new AcpClient(url);
    try {
      await client.connect();
      await client.initialize();
      // 不再做第三次 checkGatewayHealth（架构深化第 8 批微修①）：connect+
      // initialize 刚成功，HTTP 探活必然通过，纯冗余 RTT。connect/initialize
      // 失败仍走下方 catch 归还后端，重建路径语义不变。
    } catch (e) {
      // 建连失败要归还后端，否则后端进程池会一直认为它被占用
      backendPool.release(url);
      throw e;
    }

    const pool = {
      id: `pool-${++nextPoolId}`,
      key,
      client,
      url,
      toolsEnabled: needsTools,
      models: [],
      lastUsedAt: Date.now(),
      busy: true, // 立即占位
      convId: convId || null
    };
    this.pools.set(pool.id, pool);
    if (convId) this.convPools.set(convId, pool.id);
    return pool;
  }

  /**
   * 关闭所有连接，清空池。
   */
  async close() {
    for (const pool of this.pools.values()) {
      try { pool.client?.destroy?.(); } catch { /* ignore */ }
    }
    this.pools.clear();

  }
}

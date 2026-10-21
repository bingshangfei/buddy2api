/**
 * gateway-discovery.js — 多后端进程池，支持并发请求隔离。
 *
 * 新架构（2026-09-11 v2）：
 * - 旧架构：单后端进程，并发请求共享，导致会话串台
 * - 新架构：后端进程池，并发请求分配不同后端，彻底隔离
 *
 * 核心概念：
 * - BackendPool：管理多个 codebuddy --serve 进程
 * - acquire()：获取一个空闲后端（或启动新的）
 * - release()：请求完成后归还后端到池中
 * - shutdownAll()：退出时清理所有后端
 *
 * 状态文件：%TEMP%/buddy2api/backends.json（进程池状态）
 */

import path from 'node:path';
import { findCodebuddyBinary, cliSource } from './cli-paths.js';
// 后端子进程机制已迁 backend-process.js（批7）：spawn/环境卫生/stdout 解析/探活
// 归该模块（构造器注入位，默认真实实现）；池策略/持久化/空闲回收留本文件
import { spawnBackendProcess, probeHealth } from './backend-process.js';
// （readAccessToken 随 buildChildEnv 迁 backend-process.js——批7；该模块按 spec 直连 auth-credentials）
import { accountPool } from './account-pool.js';
import { listAccounts } from './account-store.js';
// 池配置 / 持久化拆出（批9 #6）：env 配置解析归 gateway-pool-config，原子落盘 /
// 启动恢复 / 进程探活归 gateway-pool-state；本文件保留 BackendPool + 单例 + warmup
// + 兼容再导出。STATE_DIR/MAX_BACKENDS/QUEUE_TIMEOUT_MS/IDLE_TIMEOUT_MS 由配置模块
// 模块期冻结（部署期生效）——与拆分前同一时点/同一口径。
import {
  resolvePoolConfig, STATE_DIR, POOL_FILE, MAX_BACKENDS, QUEUE_TIMEOUT_MS, IDLE_TIMEOUT_MS
} from './gateway-pool-config.js';
import { savePoolState, restorePoolState, isProcessAlive as processAlive } from './gateway-pool-state.js';

/**
 * 工具风味谓词单点（refactor-20260928-arch-deepening2 批5）：undefined（旧持久化
 * 数据/测试桩）视为"全量工具"，与旧行为一致。BackendPool._toolsFlavor 与
 * SessionManager._poolTools 均委托本函数——此前两处各写一份 `!== false`，
 * 漂移不会有任何断言变红。
 */
export function toolsFlavorOf(info) {
  return info?.toolsEnabled !== false;
}

// 向后兼容的再导出（scripts/ 与测试沿用旧入口）
export { vendorCliBinary, systemCliCandidates, projectRoot } from './cli-paths.js';
export { findCodebuddyBinary, cliSource };

// ---------------------------------------------------------------------------
// 池配置（env 派生）——解析已迁 gateway-pool-config.js（批9 #6）
//
// 兼容再导出：既有 import 面（tests/runtime-config、gateway-pool-config 子进程读
// 常量、scripts/）仍从本模块取 resolvePoolConfig / MAX_BACKENDS / QUEUE_TIMEOUT_MS
// / POOL_FILE。STATE_DIR / MAX_BACKENDS / QUEUE_TIMEOUT_MS / IDLE_TIMEOUT_MS 由配置
// 模块在模块期冻结（部署期生效，运行中改 env 不热更——历史契约）。
// ---------------------------------------------------------------------------
export { resolvePoolConfig, POOL_FILE, MAX_BACKENDS, QUEUE_TIMEOUT_MS };

// 后端"工具风味"：codebuddy 的内置工具定义占 prompt 前缀的大头
// （deepseek-v4.1-flash 实测 tools=19366 / 总 22.7k tokens）。纯聊天请求不需要
// 这些工具，可用 `--tools ""` 把前缀压到 ~3.2k。但该开关是白名单，会把动态
// 注册的委托工具一并过滤掉，所以带 tools 的请求必须用全量后端。两种风味按
// 请求分流，各自复用各自的空闲后端。

export class BackendPool {
  constructor(opts = {}) {
    // 实例级配置：默认取 env 派生值（模块加载时读一次），测试可显式覆盖
    this.maxBackends = opts.maxBackends ?? MAX_BACKENDS;
    this.queueTimeoutMs = opts.queueTimeoutMs ?? QUEUE_TIMEOUT_MS;
    this.stateDir = opts.stateDir || STATE_DIR;
    this.poolFile = path.join(this.stateDir, 'backends.json');
    this.backends = new Map(); // url -> BackendInfo
    this.spawning = 0;         // 正在启动中的后端数量（并发上限判定用）
    this.waiters = [];         // 池满时排队等待归还的请求（FIFO）
    this.cleanupTimer = null;
    // 进程机制注入位（批7）：默认真实实现；fake adapter 可在构造时替换
    this._spawnBackend = opts.spawnBackendFn || spawnBackendProcess;
    this._probeHealth = opts.probeHealthFn || probeHealth;
    this.startCleanupTimer();
  }

  /**
   * 获取一个可用后端 URL。
   *
   * 多账号时：优先用 preferredAccountId（会话亲和——同一 API key 的请求粘住
   * 同一账号，命中云端按账号计的前缀缓存）；没有指定或该账号在冷却 → 由账号
   * 池 round-robin 选一个。选定账号后再优先复用**该账号**的空闲后端；没有则
   * 新建一个绑定该账号的后端。后端与账号是绑定的（token 在 spawn 时注入
   * 子进程环境），所以不同账号的后端不能互相复用。
   *
   * 亲和是"尽量"而非"绝对"：首选账号在冷却、或池满且它没有空闲后端时，
   * 回退到 round-robin / 复用其他账号的空闲后端（换账号只损失缓存，排队
   * 干等损失的是完整延迟）。
   *
   * 工具风味：needsTools=true（默认，兼容旧行为）用全量内置工具的后端；
   * false 用 `--tools ""` 的精简后端。两者不互相复用（前缀不同）。
   *
   * @param {object} [opts]
   * @param {boolean} [opts.needsTools=true]
   * @param {string|null} [opts.preferredAccountId=null] 会话亲和：优先粘住的账号
   * @returns {Promise<string>} 后端 URL
   */
  async acquire({ needsTools = true, preferredAccountId = null } = {}) {
    // 环境变量覆盖（测试用）
    if (process.env.GATEWAY_URL) {
      console.log(`[gateway-pool] Using GATEWAY_URL from env: ${process.env.GATEWAY_URL}`);
      return process.env.GATEWAY_URL;
    }

    // 会话亲和：偏好的账号且未冷却 → 直接粘住（不推进轮转游标，
    // 让新 key 之间的 round-robin 保持均匀）；否则回退 round-robin。
    const resolved = resolveAccountForAcquire(preferredAccountId, accountPool);
    const account = resolved.account;
    if (resolved.coolingDown) {
      console.warn(`[gateway-pool] All accounts cooling down; using ${account?.nickname || account?.id} (recovers in ${Math.ceil(resolved.cooldownMs / 1000)}s)`);
    }

    while (true) {
      // 1. 找该账号、该风味的空闲后端
      // 关键：必须在 await 之前**同步占位**。若先 await 健康检查再置 busy，
      // 两个并发请求会同时看到同一个 idle 后端并双双选中它（实测：两路并发
      // 落到同一后端，setModel 报 Internal error、输出串台）。
      for (const [url, info] of this.backends) {
        if (info.status !== 'idle') continue;
        if (!this._sameAccount(info, account)) continue;
        if (this._toolsFlavor(info) !== needsTools) continue;

        info.status = 'busy'; // 同步占位
        info.lastUsedAt = Date.now();

        if (await this.isHealthy(url)) {
          console.log(`[gateway-pool] Reusing idle backend: ${url}${account ? ` (account ${account.nickname || account.id})` : ''}`);
          return url;
        }

        // 不健康 → 丢弃该后端（归还占位没有意义，进程已不可用）
        console.warn(`[gateway-pool] Backend ${url} unhealthy, dropping`);
        this._discard(url);
      }

      // 2. 未达上限 → 启动新后端
      // 计入"正在启动中"的数量：否则并发请求会各自看到 size 未达上限而一起
      // 启动新后端，突破 MAX_BACKENDS。
      if (this.backends.size + this.spawning < this.maxBackends) {
        console.log(`[gateway-pool] Spawning new backend (current: ${this.backends.size}, spawning: ${this.spawning}, tools: ${needsTools})${account ? ` for account ${account.nickname || account.id}` : ''}`);
        this.spawning++;
        let newBackend;
        try {
          newBackend = await this.spawnNew(account, { toolsEnabled: needsTools });
        } finally {
          this.spawning--;
        }
        this.backends.set(newBackend.url, { ...newBackend, accountId: newBackend.accountId || null, toolsEnabled: needsTools, status: 'busy', lastUsedAt: Date.now() });
        this.saveState();
        return newBackend.url;
      }

      // 3. 池满且首选账号没有空闲后端 → 尽量兜底：复用任意账号的同风味
      // 空闲后端（即时），优先于"淘汰后重新 spawn"（2026-09-17 实测冷 spawn
      // ~2.4s）。代价是本次换账号（前缀缓存可能 miss），但比排队干等快。
      // 这里拿到的账号会和偏好不同，上层会把实际账号记回亲和映射。
      for (const [url, info] of this.backends) {
        if (info.status !== 'idle') continue;
        if (this._toolsFlavor(info) !== needsTools) continue;

        info.status = 'busy';
        info.lastUsedAt = Date.now();

        if (await this.isHealthy(url)) {
          console.log(`[gateway-pool] Reusing idle backend of another account (affinity fallback): ${url}${info.accountId ? ` (account ${info.accountId})` : ''}`);
          return url;
        }
        console.warn(`[gateway-pool] Backend ${url} unhealthy, dropping`);
        this._discard(url);
      }

      // 4. 淘汰一个空闲的"错误风味"后端腾位，避免死锁
      // （若全是所需风味则不会淘汰——下面会排队等它被归还后复用。）
      const victim = this._idleWrongFlavor(needsTools, account);
      if (victim) {
        console.log(`[gateway-pool] Evicting idle backend with wrong tools flavor: ${victim} (need tools=${needsTools})`);
        this._discard(victim);
        continue;
      }

      // 5. 已达上限 → 排队等一个后端被归还（release() 会唤醒），再重试
      console.warn(`[gateway-pool] Max backends (${this.maxBackends}) reached, queuing (${this.waiters.length + 1} waiting)...`);
      await this._waitForRelease();
    }
  }

  /**
   * 后端风味：undefined（旧持久化数据/测试桩）视为"全量工具"，与旧行为一致。
   * （定义在下方导出的 toolsFlavorOf 单点——session-manager 的 _poolTools 同源，
   * 批5 谓词去重，refactor-20260928-arch-deepening2。）
   */
  _toolsFlavor(info) {
    return toolsFlavorOf(info);
  }

  /**
   * 找一个空闲、账号匹配但风味不符的后端（池满时淘汰用）。
   */
  _idleWrongFlavor(needsTools, account) {
    for (const [url, info] of this.backends) {
      if (info.status !== 'idle') continue;
      if (!this._sameAccount(info, account)) continue;
      if (this._toolsFlavor(info) === needsTools) continue;
      return url;
    }
    return null;
  }

  /**
   * 后端与账号是否匹配。未启用账号池（info.accountId 与 account 都为 null）视为匹配。
   */
  _sameAccount(info, account) {
    const want = account?.id || null;
    const have = info.accountId || null;
    return want === have;
  }

  /**
   * 取后端所绑定的账号 id（供上层上报账号健康）。
   */
  accountIdFor(url) {
    return this.backends.get(url)?.accountId || null;
  }

  /**
   * 等待任意后端被归还。由 release() 唤醒；带超时兜底防止永久挂起。
   */
  _waitForRelease(timeoutMs = this.queueTimeoutMs) {
    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(finish, timeoutMs);
      timer.unref?.();
      this.waiters.push(finish);
    });
  }

  /** 唤醒一个排队中的等待者（FIFO） */
  _wakeOneWaiter() {
    const w = this.waiters.shift();
    if (w) w();
  }

  /**
   * 归还后端到池中（标记为空闲）。
   */
  release(url) {
    const info = this.backends.get(url);
    if (!info) return;
    // 幂等保护：只把"占用中"的后端置回空闲。上层存在同一请求的重复归还
    // （sink onDone 释放一次 + 外层编排收尾再释放一次），若无此保护，第二次
    // 释放会把**别的请求正在占用**的后端标成空闲并唤醒等待者 → 第三个请求
    // 拿到同一后端，输出串台。
    if (info.status !== 'busy') return;
    info.status = 'idle';
    info.lastUsedAt = Date.now();
    console.log(`[gateway-pool] Released backend: ${url}`);
    this._wakeOneWaiter();
  }

  /**
   * 丢弃一个不可用的后端：杀进程并从池中移除。
   * 用于健康检查失败等场景（连接已断，留着只会反复失败）。
   */
  _discard(url) {
    const info = this.backends.get(url);
    if (!info) return;
    try { info.child?.kill?.('SIGTERM'); } catch { /* ignore */ }
    this.backends.delete(url);
    this.saveState();
  }

  /**
   * 关闭所有后端进程。
   */
  async shutdownAll() {
    console.log(`[gateway-pool] Shutting down ${this.backends.size} backend(s)...`);
    for (const [url, info] of this.backends) {
      if (info.child) {
        try {
          info.child.kill('SIGTERM');
          console.log(`[gateway-pool] Killed backend PID ${info.pid}`);
        } catch (e) {
          console.warn(`[gateway-pool] Failed to kill PID ${info.pid}: ${e.message}`);
        }
      }
    }
    this.backends.clear();
    this.saveState();
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  /**
   * 启动新的 codebuddy --serve 进程。
   *
   * @param {object|null} account 账号池选中的账号（null = 用单账号凭据）
   * @param {object} [opts]
   * @param {boolean} [opts.toolsEnabled=true] false 时加 `--tools ""` 关闭内置工具
   *        （prompt 前缀 ~22.7k → ~3.2k；代价是无法注册委托工具，只服务纯聊天）
   */
  async spawnNew(account = null, { toolsEnabled = true } = {}) {
    const binary = findCodebuddyBinary();
    if (!binary) {
      throw new Error(
        '未检测到 codebuddy CLI（后端运行时随腾讯 WorkBuddy 桌面端安装）。' +
        '请先安装 WorkBuddy，然后重跑初始化向导补齐后端（node scripts/onboarding.js），' +
        '或设环境变量 CODEBUDDY_CLI_PATH 指向已安装的 bin/codebuddy。'
      );
    }

    console.log(`[gateway-pool] Using CLI: ${binary} (${cliSource(binary)})`);

    // 进程机制归 backend-process.js（批7）：mkdir/spawn/端点竞速/启动超时；
    // 本方法只剩池职责——CLI 定位、健康等待、注册与退出监控（次序保持原样：
    // 先 waitForHealthy 再挂监控 exit）
    let backend;
    try {
      backend = await this._spawnBackend({
        binary, account, toolsEnabled, stateDir: this.stateDir
      });
    } catch (e) {
      // vendor 副本存在但损坏时 findCodebuddyBinary 仍会选中它（纯存在性检查），
      // 用户看到的会是这里的 spawn 错误——追加中文指引指向控制台 [C] 修复。
      // 追加式保留原错误串：error-classifier 按 message 既有关键词分类。
      throw new Error(
        `${e.message}\n[gateway-pool] 后端 CLI 启动失败，副本可能已损坏：` +
        '可在控制台选 [C] CLI 检测与升级 重新拷贝修复（或运行 node scripts/vendor-cli.js）。'
      );
    }
    const { url, child } = backend;

    // 健康检查
    await this.waitForHealthy(url);

    // 监控进程退出
    child.on('exit', (code, signal) => {
      console.warn(`[gateway-pool] Backend PID ${child.pid} exited (code=${code}, signal=${signal})`);
      this.backends.delete(url);
      this.saveState();
    });

    console.log(`[gateway-pool] Started backend at ${url} (PID ${child.pid})${account ? ` [account ${account.nickname || account.id}]` : ''}`);
    return { url, pid: child.pid, child, startedAt: Date.now(), accountId: account?.id || null, toolsEnabled };
  }

  /**
   * 等待健康检查通过。
   */
  async waitForHealthy(url) {
    for (let i = 0; i < 5; i++) {
      if (await this.isHealthy(url)) {
        console.log(`[gateway-pool] Health check passed (attempt ${i + 1})`);
        return;
      }
      await sleep(1000);
    }
    throw new Error(`Gateway at ${url} failed health check after 5 attempts`);
  }

  /**
   * 检查后端是否健康（探活机制归 backend-process.probeHealth，批7）。
   */
  async isHealthy(url) {
    return this._probeHealth(url);
  }

  /**
   * 定期清理空闲超时的后端。
   */
  startCleanupTimer() {
    this.cleanupTimer = setInterval(() => {
      const now = Date.now();
      for (const [url, info] of this.backends) {
        if (info.status === 'idle' && now - info.lastUsedAt > IDLE_TIMEOUT_MS) {
          console.log(`[gateway-pool] Cleaning up idle backend: ${url}`);
          if (info.child) {
            try {
              info.child.kill('SIGTERM');
            } catch { /* ignore */ }
          }
          this.backends.delete(url);
          this.saveState();
        }
      }
    }, 60_000); // 每分钟检查一次
    this.cleanupTimer.unref?.();
  }

  /**
   * 保存进程池状态到文件（用于跨重启恢复）。
   *
   * 调用点契约（架构深化第 8 批 C1 收窄）：只在**成员生命周期变化**时落盘
   * （spawn 注册 / _discard / child exit / 空闲回收 / shutdownAll / restoreState
   * / warmup 注册）——acquire/release 的占用翻转不落盘：restoreState 只按
   * 「进程存活 + 端口健康」收养成员，恢复时 status/lastUsedAt 一律弃用，
   * 每请求翻转持久化是纯浪费的同步 I/O（且阻塞所有在飞流）。
   * 原子写 + 不去抖 + 退出 flush 契约不变（affinity.md「池状态持久化」）。
   */
  saveState() {
    savePoolState(this);
  }

  /**
   * 从文件恢复进程池状态（检查进程是否还活着）。
   * 实现已迁 gateway-pool-state.js（批9 #6）——实例绑定：经自身 isProcessAlive /
   * isHealthy 动态派发，测试可就地覆写。
   */
  async restoreState() {
    await restorePoolState(this);
  }

  /**
   * 检查进程是否存活。
   * 实现已迁 gateway-pool-state.js（批9 #6）。
   */
  async isProcessAlive(pid) {
    return processAlive(pid);
  }

  /**
   * 标记后端为"使用中"（session-manager 复用连接时调用）。
   *
   * 关键：backendPool 的 status/lastUsedAt 与 session-manager 的 pool.busy 是
   * 两套状态——连接被会话层复用时若不回写 busy，空闲回收器（5 分钟）会把
   * 正在跑长流的后端当 idle 杀掉（实测：新闻检索类 6 分钟请求中途 ECONNRESET，
   * 客户端看到 "Model request failed"，账号还被误冷却 60s）。
   */
  markBusy(url) {
    const info = this.backends.get(url);
    if (!info) return;
    info.status = 'busy';
    info.lastUsedAt = Date.now();
  }

  /**
   * 丢弃后端（连接已确认不可用：进程死亡/端口拒绝）。
   * 与 release（归还空闲）不同：discard 直接从池中删除，acquire 不再选中。
   * 落盘由 _discard 单点承担（此处不再重复写，架构深化第 8 批 C1）。
   */
  discardBackend(url) {
    this._discard(url);
  }
}

// ---------------------------------------------------------------------------
// 辅助函数
// ---------------------------------------------------------------------------

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// 全局单例
// ---------------------------------------------------------------------------

/**
 * 为一次 acquire 解析目标账号（纯函数，便于单测）。
 *
 * 会话亲和优先：偏好的账号存在且未冷却 → 直接粘住（不调 pick，不推进轮转
 * 游标，保持新 key 之间 round-robin 均匀）；偏好缺失/已删除/冷却中 → 回退
 * 账号池 round-robin（内部会跳过冷却账号；全冷却时挑最快恢复的）。
 *
 * @param {string|null} preferredAccountId
 * @param {AccountPool} accountPool
 * @returns {{account: object|null, fromAffinity: boolean, coolingDown?: boolean, cooldownMs?: number}}
 */
export function resolveAccountForAcquire(preferredAccountId, accountPool) {
  if (preferredAccountId && !accountPool.isCoolingDown(preferredAccountId)) {
    const preferred = accountPool.accounts().find((a) => a.id === preferredAccountId);
    if (preferred) return { account: preferred, fromAffinity: true };
  }
  const selection = accountPool.pick();
  return {
    account: selection?.account || null,
    fromAffinity: false,
    coolingDown: selection?.coolingDown,
    cooldownMs: selection?.cooldownMs
  };
}

export const backendPool = new BackendPool();

// 启动时恢复状态
await backendPool.restoreState();

// ---------------------------------------------------------------------------
// 网关 URL 持久化缓存（已移除快捷路径，2026-09-15 CR）
//
// 曾实现"缓存命中直接返回"的快捷路径，但它会绕过 acquire() 的关键校验：
// 工具风味匹配（带工具请求拿到 --tools "" 后端 → 委托工具静默失效）、账号
// 亲和与冷却（冷却中的账号继续服务）、GATEWAY_URL 环境变量覆盖。快速启动
// 由 warmup() + restoreState() 承担，acquire() 对池内空闲后端本就只做一次
// 健康检查，快捷路径收益趋零、风险真实，故整体移除（含缓存文件读写）。
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 懒初始化：服务启动时预创建后端，首个请求直接用（实测冷 spawn ~2.4s）
// ---------------------------------------------------------------------------

/**
 * 为一个待预热名额挑风味。
 *
 * 优先级：
 *   ① 该账号还缺的风味（补缺）——已经绑定了全量就补精简，反之亦然。
 *      这是"已有 1 个 → 补到 2 个"场景唯一正确的依据：只数数量不看风味，
 *      已有全量时会再补一个全量，变成 2 全量 0 精简。
 *   ② 一个都没绑定时，取全池偏少的那一种（起始全空 → 精简，纯聊天是最常用路径）。
 * 调用方：仅"同一账号有多个名额"的分支（单账号预热 2 个）。
 *
 * @param {Set<boolean>} boundFlavors 该账号已绑定的风味集合
 * @param {number[]} poolFlavorCounts 全池 [精简数, 全量数]
 * @returns {boolean} 选中的风味（true=全量）
 */
function pickWarmupFlavor(boundFlavors, poolFlavorCounts) {
  const missing = [false, true].filter((f) => !boundFlavors.has(f));
  const candidates = missing.length > 0 ? missing : [false, true];
  let best = candidates[0];
  for (const f of candidates) {
    if (poolFlavorCounts[f ? 1 : 0] < poolFlavorCounts[best ? 1 : 0]) best = f;
  }
  return best;
}

/**
 * 懒初始化：预创建后端进程。
 *
 * 默认（count=null）按登录账号预创建：每个可用账号 1 个绑定后端，多账号并发请求
 * 不再冷启；只补缺——restoreState 恢复过的账号不重复创建。
 *
 * 只有一个登录账号时每个账号预热 2 个：单账号部署下"每账号 1 个"意味着池里只有
 * 1 个后端，第 2 路并发请求必然冷 spawn（实测 ~2.4s）。多账号场景不适用这条
 * ——账号数本身已经提供并发度，再翻倍会白白多占内存（单个后端实测 ~300MB）。
 *
 * **风味只在单账号分支安排**：请求按 hasTools 分流到全量后端（带工具）与
 * `--tools ""` 精简后端（纯聊天），两者不互相复用。只预热一种风味的实测后果是
 * ——纯聊天请求（不带 tools 的客户端是多数）拿不到预热后端，每次冷启动都要付一次
 * 2.6s spawn，预热等于白做。所以**给同一账号的多个名额**按"补缺"分配风味
 * （单账号 2 个 = [精简, 全量]；已有绑定时缺什么补什么，见 pickWarmupFlavor）。
 *
 * 多账号（每账号 1 个名额）不做风味交错：1 个名额装不下两种风味，交错只会把某个
 * 账号唯一的后端单方面翻成另一种，且结果取决于账号列表顺序——属未授权的行为偏移。
 * 账号间的关系是"余额高的先用"，次账号在余额追平前基本闲置（见 account-pool.pick），
 * 把主力风味押在闲置账号上没有收益。多账号的风味默认值留给部署方通过调用方 opts 决定。
 *
 * 显式传 count（POOL_WARM_COUNT）或没有任何登录账号时，退回固定数量的默认登录态后端。
 *
 * @param {number|null} [count=null] null=按登录账号数；数字=固定创建数量
 * @param {object} [opts]
 * @param {boolean} [opts.toolsEnabled=true] 固定数量模式下是否带工具
 */
async function warmup(count = null, { toolsEnabled = true } = {}) {
  // targets：每项 { account, toolsEnabled }；account=null 表示默认登录态
  let targets = null;
  if (count === null) {
    let accounts = [];
    try {
      accounts = listAccounts();
    } catch { /* 账号目录不可读 → 退回固定数量预热 */ }
    if (accounts.length > 0) {
      const perAccount = accounts.length === 1 ? 2 : 1;
      // 只补缺：除数量外还要记下每个账号已绑定的**风味**——单账号补缺场景下只数
      // 数量无法知道该补精简还是全量（已有全量时按序号推会再补一个全量，
      // 变成 2 全量 0 精简，纯聊天首请求照样冷 spawn）。
      // undefined 视为全量，口径同 _toolsFlavor / acquire 的风味匹配。
      const bound = new Map();         // accountId -> { count, flavors:Set<boolean> }
      const poolFlavorCounts = [0, 0]; // 全池 [精简数, 全量数]，用于跨账号交替
      for (const b of backendPool.backends.values()) {
        const flavor = b.toolsEnabled !== false;
        poolFlavorCounts[flavor ? 1 : 0]++;
        if (!b.accountId) continue;
        const rec = bound.get(b.accountId) || { count: 0, flavors: new Set() };
        rec.count++;
        rec.flavors.add(flavor);
        bound.set(b.accountId, rec);
      }
      // 总量封顶实例容量（与 acquire 一致）
      const capacity = Math.max(0, backendPool.maxBackends - backendPool.backends.size);
      targets = [];
      for (const account of accounts) {
        const rec = bound.get(account.id) || { count: 0, flavors: new Set() };
        for (let i = rec.count; i < perAccount; i++) {
          // 风味只在"同一账号有多个名额"时才需要安排（单账号 2 个 → 覆盖两种）。
          // 多账号每账号 1 个名额，交错无法覆盖两种风味，只会把某个账号唯一的
          // 后端单方面翻成另一种——结果还取决于账号列表顺序，故原样透传调用方默认。
          const flavor = perAccount > 1 ? pickWarmupFlavor(rec.flavors, poolFlavorCounts) : toolsEnabled;
          targets.push({ account, toolsEnabled: flavor });
          rec.count++;
          rec.flavors.add(flavor);
          poolFlavorCounts[flavor ? 1 : 0]++;
        }
      }
      targets = targets.slice(0, capacity);
      if (targets.length === 0) {
        console.log('[gateway-pool] Warmup skipped: all logged-in accounts already have backends');
        return;
      }
    }
  }

  if (targets === null) {
    // 固定数量模式：显式 count，或无登录账号时退回旧默认 2（restoreState 已恢复的不再重复）
    const fixed = count ?? 2;
    if (backendPool.backends.size >= fixed) {
      console.log(`[gateway-pool] Warmup skipped: ${backendPool.backends.size} backends already restored`);
      return;
    }
    targets = Array.from({ length: fixed - backendPool.backends.size }, () => ({ account: null, toolsEnabled }));
  }

  console.log(`[gateway-pool] Warming up ${targets.length} backend(s) for faster first request...`);

  let successCount = 0;
  let failureCount = 0;
  const promises = targets.map((target, i) => {
    const account = target.account;
    const flavor = target.toolsEnabled;
    return backendPool.spawnNew(account, { toolsEnabled: flavor }).then(newBackend => {
      backendPool.backends.set(newBackend.url, {
        ...newBackend,
        accountId: account?.id || null,
        toolsEnabled: flavor,
        status: 'idle',
        lastUsedAt: Date.now()
      });
      backendPool.saveState();
      successCount++;
      console.log(`[gateway-pool] Warmup backend ready: ${newBackend.url} (${successCount}/${targets.length}, ${flavor ? '全量' : '精简'})${account ? ` [account ${account.nickname || account.id}]` : ''}`);
      return newBackend.url;
    }).catch(e => {
      failureCount++;
      console.warn(`[gateway-pool] Warmup failed for slot ${i + 1}${account ? ` [account ${account.nickname || account.id}]` : ''}: ${e.message}`);
      return null;
    });
  });

  await Promise.all(promises);
  if (failureCount > 0) {
    console.warn(`[gateway-pool] Warmup partial failure: ${successCount} succeeded, ${failureCount} failed`);
  }
}

// 向后兼容的接口
export async function discoverGatewayUrl(opts) {
  return backendPool.acquire(opts);
}

export async function checkGatewayHealth(url) {
  return backendPool.isHealthy(url);
}

export async function shutdownManagedProcess() {
  await backendPool.shutdownAll();
}

export { warmup };

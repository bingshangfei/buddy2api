/**
 * stream-driver.js — 单一 ACP 事件消费引擎（StreamDriver）。
 *
 * 把原本三份重复的事件消费循环（首轮流式 / 首轮非流式 / 工具回传续跑）
 * 收敛为一份循环 + 一个 sink 接口。三者的差异全部由调用方通过 sink 表达：
 *
 *   - 流式：每个事件写 SSE chunk；非流式：只累加到 state
 *   - 心跳保活：仅流式需要（写 `: keep-alive` 注释，压缩上下文期间 WorkBuddy
 *     会长时间静默，防连接被代理/客户端因空闲断开）
 *   - 工具调用挂起 / 超时放弃 / 自然结束：各自返回不同的响应形态
 *
 * 本文件同时持有空闲心跳与软超时逻辑（_nextWithIdle）：
 * WorkBuddy 在上下文压缩时会长时间静默但不代表失败，因此只做心跳保活，
 * 只有连续空闲超过 softTimeoutMs 才真正放弃。
 */

import { parseAcpUpdate } from './acp-events.js';
import { STALL_REASON } from './error-classifier.js';
import { resWriter } from './http-utils.js';

// 契约常量（STALL_REASON / WEDGE_ERROR_CODE）定义已迁 error-classifier.js（零依赖叶，
// 分类学单点）；本模块保持为导出点——全部既有消费方 import 路径不变。
export { STALL_REASON, WEDGE_ERROR_CODE } from './error-classifier.js';

// resWriter 定义已迁 http-utils.js（架构深化十批 D6——sink-base 等底层抽象反向依赖
// 本文件的传输词汇，提取到零依赖 http-utils 修正依赖方向）；本模块保持再导出兼容。
export { resWriter } from './http-utils.js';

// 空闲心跳间隔：静默期间每 30 秒触发一次 sink.heartbeat
export const STREAM_IDLE_TIMEOUT_MS = 30 * 1000;
// 软超时兜底：连续无事件超过 15 分钟才认定真正卡死。压缩上下文可能持续数分钟。
export const STREAM_SOFT_TIMEOUT_MS = 15 * 60 * 1000;

// 首 token 守卫：prompt 发出后持续零用户可见输出（delta/reasoning/progress/toolCall）
// 超过该时长即判定后端假死——心跳注释与非输出事件（如 request_permission）不算输出。
// 默认 120s，设 0 禁用。实测依据：健康时 188k 冷上下文 46s 内出首 token；
// 假死时零输出可达 7.5~17 分钟，客户端早就断开了，15min 软超时从未有机会生效。
function readFirstTokenTimeoutMs() {
  const raw = process.env.FIRST_TOKEN_TIMEOUT_MS;
  // 未配置/置空一律回落默认（置空 = 最容易误配的形态，不能静默关掉唯一防线）
  if (raw == null || raw === '') return 120 * 1000;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 120 * 1000;
}
export const STREAM_FIRST_TOKEN_TIMEOUT_MS = readFirstTokenTimeoutMs();

// 中途停滞守卫：首输出之后，用户可见输出中断超过该时长即判定后端假死（口径与
// 首 token 守卫一致，心跳注释/usage/非输出事件不重置计时；例外：permission 成功
// 应答算存活信号、同样重置——见 run() 存活信号分支与 first-token-guard spec）。
// 默认 180s，设 0 禁用。
// 硬约束：必须小于客户端看门狗（ZCode 600s 无事件即断开）——180s 触发 + 自愈重发
// 再遇假死 120s 首 token 守卫 ≈ 320s，留足余量；置空/非法值回落默认（不静默关闭防线）。
function readStallTimeoutMs() {
  const raw = process.env.STREAM_STALL_TIMEOUT_MS;
  if (raw == null || raw === '') return 180 * 1000;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 180 * 1000;
}
export const STREAM_STALL_TIMEOUT_MS = readStallTimeoutMs();

// OpenAI 帧词汇（sseChunk / SSE_DONE / sseUsageChunk）已迁 openai-wire.js（批4）；
// anthropic 帧词汇（anthropicEvent + 全部帧形状）已迁 anthropic-wire.js（架构深化
// 第 8 批批B——**显式推翻本文件批4 的「anthropicEvent 留此」裁决**：与 openai-wire
// 对称做帧词汇单点，事件消费引擎不再 owns 任何协议的帧编码）。resWriter 已迁
// http-utils.js（架构深化十批 D6）——它是传输词汇（断连保护写入），非任何协议的
// 帧形状，且 sink-base 等底层抽象反向依赖它，故提取至零依赖叶。

/**
 * @param {object} opts
 * @param {AsyncIterator} opts.iterator ACP 事件流迭代器
 * @param {object} opts.client AcpClient（自动批准工具权限时使用）
 * @param {() => boolean} [opts.isAborted] 客户端断开后返回 true，循环尽快退出
 * @param {object} opts.sink 事件消费者，回调见 run() 内部说明
 * @param {number} [opts.idleTimeoutMs] 心跳间隔（测试可注入）
 * @param {number} [opts.softTimeoutMs] 软超时（测试可注入）
 * @param {number} [opts.firstTokenTimeoutMs] 首 token 守卫阈值，0 禁用（测试可注入）
 * @param {number} [opts.stallTimeoutMs] 中途停滞守卫阈值（首输出后生效），0 禁用（测试可注入）
 */
export class StreamDriver {
  constructor({ iterator, client, isAborted, sink, idleTimeoutMs = STREAM_IDLE_TIMEOUT_MS, softTimeoutMs = STREAM_SOFT_TIMEOUT_MS, firstTokenTimeoutMs = STREAM_FIRST_TOKEN_TIMEOUT_MS, stallTimeoutMs = STREAM_STALL_TIMEOUT_MS }) {
    this.iterator = iterator;
    this.client = client;
    this.isAborted = isAborted;
    this.sink = sink;
    this.idleTimeoutMs = idleTimeoutMs;
    this.softTimeoutMs = softTimeoutMs;
    this.firstTokenTimeoutMs = firstTokenTimeoutMs;
    this.stallTimeoutMs = stallTimeoutMs;
    // 守卫计时起点：每个 attempt 新建一个 driver，构造时刻即 prompt 发出时刻
    this._promptStartedAt = Date.now();
    this._gotOutput = false;
    this._lastOutputAt = null; // 最近一次用户可见输出时刻（中途停滞计时的锚点）
    this._pendingForceWedge = null; // 满窗信号注入位：仅在一次 next() 挂起期间非空（F-fix2）
  }

  /**
   * 消费流直到自然结束 / 工具调用挂起 / 软超时 / 被 abort。
   *
   * sink 回调：
   *   - heartbeat()                 空闲心跳（可选，仅流式需要）
   *   - onDelta(text)               内容增量
   *   - onReasoning(text)           思考增量
   *   - onUsage(usage)              usage 更新
   *   - onProgress(text, phase)     阶段/进度（如"正在压缩上下文"）
   *   - onToolCall(toolEvent)       工具调用 → 挂起，返回挂起响应（或 null）
   *   - onError(message)            JSON-RPC error（如 429 频控）→ 返回错误响应（或抛错）
   *   - onTimeout(reason)           超时 → 返回放弃响应（或抛错）；reason: 'first-token'
   *                                 （零输出假死）| 'mid-stream'（输出后中途停滞假死）|
   *                                 'soft'（连续零事件软超时）。前两类触发假死回收自愈。
   *   - onDone()                    自然结束 → 返回最终响应
   *
   * @returns {Promise<*>} 对应 sink 回调的返回值
   */
  async run() {
    // 满窗楔形信号订阅（F-fix2）：送达确认窗满窗 = CLI 对批准零确认且零事件流动，
    // 是比 180s 停滞计时更强的死亡信号——立即以停滞语义触发 onTimeout（提前楔形
    // 处置：换进程 + 续写链），不再干等计时器。订阅随 run 生命周期（finally 退订，
    // 监听器不得活过请求——活过 discard 的定时器是已知事故类）。
    const offDeliveryExpired = this.client?.onDeliveryExpired?.(() => this._pendingForceWedge?.());
    try {
      return await this._consumeLoop();
    } finally {
      offDeliveryExpired?.();
      this._pendingForceWedge = null;
    }
  }

  async _consumeLoop() {
    while (true) {
      // 客户端断开检查：放在循环顶，保证挂起/断开后立即退出（三个路径统一生效）
      if (this.isAborted?.()) break;

      const { value: event, done, timedOut, error, stallReason } = await this._nextWithIdle();
      if (error) throw error;
      if (done) {
        // 回合自然结束：在途送达确认窗全部失效（CLI 存活已由结构证明），
        // 不清理的话 armed 定时器会存活进 idle 连接（评审 F7）。
        this.client?.clearInboundWindows?.();
        break;
      }
      if (timedOut) {
        return this.sink.onTimeout?.(stallReason || STALL_REASON.SOFT);
      }

      // 送达看门狗滑动探针：CLI 有事件流动 = 存活，所有在途确认窗重置
      //（表空 no-op；bugfix-20260922-stall-rootcure）。
      this.client?.touchInbound?.();

      // 自动批准工具权限请求（request_permission → resolveInterruption allow）。
      // 必须await：批准的 HTTP POST 与 prompt 流并发时，WorkBuddy 会把紧随其后的
      // delegateTool 请求推错流（实测 57710：fire-and-forget 时事件永远不到达，
      // executeTool 挂到 30s 超时）。await 后批准先完成，delegateTool 稳定走 prompt 流。
      const approved = await this._autoApprove(event);
      // 批准送达成功 ≠ CLI 确认收到（2026-09-22 生产 trace 实证 ack≠送达）：
      // 不再 ack 出表，转「送达确认窗」——CLI 任一后续事件经 touchInbound 重置，
      // 满窗零活动 → error 兜底（CLI 视工具失败自行继续回合）。
      if (approved) {
        this.client?.markInboundSent?.(event);
        // 存活信号（A）：permission 成功应答 = CLI 正在执行工具循环（批准→执行→
        // 再请求），重置中途停滞计时——消除「还在干活却被判死」的误杀窗口。
        // 不置位 _gotOutput：首 token 守卫口径不变（零输出就是零输出）。
        this._lastOutputAt = Date.now();
      }
      if (process.env.DEBUG) console.log(`[stream-driver] approve done, waiting next event...`);

      const parsed = parseAcpUpdate(event);
      if (process.env.DEBUG) {
        const su = event?.params?.update?.sessionUpdate;
        if (su && su !== 'agent_message_chunk' && su !== 'agent_thought_chunk') {
          console.log(`[stream-driver] update (${su}): ${JSON.stringify(event.params.update).slice(0, 500)}`);
        }
      }
      // 用户可见输出到达：记录输出时刻（重置中途停滞计时），首输出同时解除零输出守卫
      //（usage 只在流末尾到达，不算输出）
      if (parsed?.type === 'delta' || parsed?.type === 'reasoning' || parsed?.type === 'progress') {
        this._gotOutput = true;
        this._lastOutputAt = Date.now();
      }
      if (parsed?.type === 'delta') {
        this.sink.onDelta(parsed.text);
      } else if (parsed?.type === 'reasoning') {
        this.sink.onReasoning(parsed.text);
      } else if (parsed?.type === 'usage') {
        this.sink.onUsage(parsed.usage);
      } else if (parsed?.type === 'progress') {
        this.sink.onProgress?.(parsed.progress, parsed.phase);
      }

      // WorkBuddy 又要调用工具 → 暂停，把 tool_calls 返回给客户端
      const toolEvent = this._extractToolCall(event);
      if (toolEvent) {
        // 交接已完成（即将挂起等客户端执行；长等待由 PENDING_TTL_MS 管，60s 兜底
        // 不得再介入——ack 必须在这里而不是 respondToToolCall，否则会误杀正常执行）
        this.client?.ackInbound?.(event);
        // 控制权交客户端：在途送达确认窗全部失效（CLI 正常等待回传，非假死），
        // 不清窗会在客户端长工具执行期间误发 error（评审 F7）。
        this.client?.clearInboundWindows?.();
        this._gotOutput = true;
        this._lastOutputAt = Date.now();
        return this.sink.onToolCall(toolEvent);
      }

      // 最终 result 或 error：流自然结束 / WorkBuddy 拒绝（如 429 频控）
      // 只认 result 会导致 429 时永远等待 → 客户端超时重连。
      if (event.id && event.result) {
        // 回合收尾对称清窗（与 done 分支同口径）：不依赖 prompt-finally 的
        // inflight=0 后备，两出口直清（评审 K8 脆弱不变量加固）。
        this.client?.clearInboundWindows?.();
        break;
      }
      if (event.id && event.error) {
        const message = typeof event.error === 'object'
          ? (event.error.message || event.error.code || JSON.stringify(event.error))
          : String(event.error);
        return this.sink.onError?.(message);
      }
    }
    return this.sink.onDone?.();
  }

  /**
   * 带心跳保活的 iterator.next() 封装。
   *
   * 关键背景：WorkBuddy 在上下文压缩等场景会**完全静默**（长时间不发任何事件），
   * 但这不代表失败。因此：
   *  - 每 idleTimeoutMs 触发一次 sink.heartbeat（向客户端写 SSE 保活注释），不中断等待；
   *  - 只有连续空闲超过 softTimeoutMs 才返回 { timedOut: true } 让调用方放弃。
   *  - 守卫定时器（两态锚点，输出重置计时）：
   *    首输出前：锚在 prompt 发出时刻，阈值 firstTokenTimeoutMs（零输出假死，不被非输出
   *    事件重置，跨多次 next() 累计剩余时长）；
   *    首输出后：锚在最近一次用户可见输出时刻，阈值 stallTimeoutMs（输出中断即中途停滞
   *    假死，每次输出重置计时）。两类触发均以 stallReason 区分交给 onTimeout 处置
   *    （假死回收 vs 优雅放弃），与软超时（连续零事件）正交。
   *
   * 重要约束：async generator 必须串行调用 .next()，不能在心跳里再次调用。
   * 所以这里只在首个 .next() 挂起时用心跳 timer 触发回调，复用同一个 pending
   * Promise，绝不对同一 iterator 并发发起第二次 .next()。
   *
   * @returns {Promise<{value?, done: boolean, timedOut?: boolean, stallReason?: string, error?: Error}>}
   */
  async _nextWithIdle() {
    return new Promise((resolve) => {
      let settled = false;
      const startedAt = Date.now();

      // 守卫定时器：独立一次性定时器，精确在阈值时刻触发（不依赖心跳 interval 的粒度）。
      // 定时器只在本次 next() 挂起期间存活（finish 统一清理），输出到达后由下一次
      // next() 按新锚点重挂——「每次输出重置计时」由此实现。
      let ft = null;
      let stallReason = null;
      if (!this._gotOutput) {
        if (this.firstTokenTimeoutMs > 0) {
          const remain = this.firstTokenTimeoutMs - (Date.now() - this._promptStartedAt);
          stallReason = STALL_REASON.FIRST_TOKEN;
          ft = setTimeout(() => {
            if (settled || this._gotOutput) return;
            settled = true;
            clearInterval(hb);
            resolve({ done: false, timedOut: true, stallReason });
          }, Math.max(0, remain));
        }
      } else if (this.stallTimeoutMs > 0) {
        const remain = this.stallTimeoutMs - (Date.now() - this._lastOutputAt);
        stallReason = STALL_REASON.MID_STREAM;
        ft = setTimeout(() => {
          if (settled) return;
          settled = true;
          clearInterval(hb);
          resolve({ done: false, timedOut: true, stallReason });
        }, Math.max(0, remain));
      }

      const hb = setInterval(() => {
        if (settled) return;
        const elapsed = Date.now() - startedAt;
        if (elapsed >= this.softTimeoutMs) {
          settled = true;
          clearInterval(hb);
          clearTimeout(ft);
          resolve({ done: false, timedOut: true });
          return;
        }
        // 客户端断开：关闭底层流让挂起的 next() 立即返回 done（而不是等到上游
        // 有数据才醒来）。关闭后 generator 的 finally 会把连接标记为空闲，供连接池复用。
        if (this.isAborted?.()) {
          settled = true;
          clearInterval(hb);
          clearTimeout(ft);
          this.iterator.return?.().catch?.(() => {});
          resolve({ done: true, timedOut: false });
          return;
        }
        try {
          this.sink.heartbeat?.();
        } catch { /* 忽略心跳异常 */ }
      }, this.idleTimeoutMs);

      const finish = (payload) => {
        if (settled) return;
        settled = true;
        clearInterval(hb);
        clearTimeout(ft);
        this._pendingForceWedge = null;
        resolve(payload);
      };

      // 满窗楔形信号注入位（F-fix2）：ledger 确认窗到期 → run() 订阅的回调调到这里。
      // 语义 = 「把当前挂起的停滞计时现在就打到到期」——按当前守卫态给出 stallReason
      //（有输出 mid-stream / 零输出 first-token），复用既有 onTimeout 处置，不改判定口径。
      // 已 settle（事件刚好到达/计时器刚好先触发）时 no-op：信号每 entry 至多一次，
      // 漏掉的边沿由既有停滞计时兜底。
      this._pendingForceWedge = () => {
        if (settled) return;
        settled = true;
        clearInterval(hb);
        clearTimeout(ft);
        this._pendingForceWedge = null;
        resolve({
          done: false, timedOut: true,
          stallReason: this._gotOutput ? STALL_REASON.MID_STREAM : STALL_REASON.FIRST_TOKEN
        });
      };

      this.iterator.next().then(
        result => finish({ ...result, timedOut: false }),
        err => finish({ done: true, timedOut: false, error: err })
      );
    });
  }

  /**
   * 从 ACP 事件中提取委托工具调用。
   * 正确协议：WorkBuddy 通过 _codebuddy.ai/delegateTool 请求（带 id）发起调用，
   * 需要客户端响应 result。tool_call 事件只是参数预览，不是请求。
   *
   * @returns {{reqId: string|number, name: string, args: object, toolCallId: string} | null}
   */
  _extractToolCall(event) {
    if (!event || event.method !== '_codebuddy.ai/delegateTool') return null;
    const p = event.params || {};
    if (!p.toolId || event.id == null) return null;
    return {
      reqId: event.id,
      name: p.toolId,
      args: p.input || {},
      toolCallId: p.toolCallId
    };
  }

  /**
   * 自动批准工具权限请求（request_permission → resolveInterruption allow）。
   * 放在消费循环里调用，不阻塞事件流。
   *
   * 性能优化（2026-09-15）：两条批准路径（JSON-RPC result + approveToolCall）
   * 互不依赖，原实现串行 await 多一次往返延迟。改为 Promise.all 并行发出，
   * 批准延迟从两次 RTT 降到一次（实测 429 高频场景工具调用吞吐提升明显）。
   */
  async _autoApprove(event) {
    if (!event || event.method !== 'session/request_permission') return false;
    const p = event.params || {};
    const toolCallId = p.toolCall?.toolCallId;
    // 标准通道：直接响应 request_permission 请求本身（JSON-RPC result，
    // PermissionManager 期望 { outcome: { outcome: 'selected', optionId } }）。
    // 这是 ACP 标准路径，保持 prompt 流的 in-flight 状态——实测仅用扩展
    // resolveInterruption 时，approve 会清掉 in-flight 导致紧随其后的
    // delegateTool 请求无处投递而静默丢失。
    // 成败要如实回传：delivered=true 时调用方把条目转「送达确认窗」（不销单），
    // delivered=false 时条目保持 awaiting，60s 兜底照常接管。
    const p1 = (event.id != null)
      ? this.client.respondPermission(event.id, {
          outcome: 'selected', optionId: 'allow'
        }).then((sent) => sent === true, () => false) // 迟到守卫命中会 resolve false（未发送）
      : Promise.resolve(false);
    // 扩展通道兜底（不同版本 WorkBuddy 对两种机制的依赖不同）
    const p2 = toolCallId
      ? this.client.approveToolCall(p.sessionId || this.client.sessionId, toolCallId).catch(() => {})
      : Promise.resolve();
    const [delivered] = await Promise.all([p1, p2]);
    return delivered;
  }
}

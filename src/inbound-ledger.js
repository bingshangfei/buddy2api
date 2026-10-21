/**
 * inbound-ledger.js — 入站委托请求注册表（推送丢失兜底 + 送达确认两态窗）。
 *
 * 从 acp-client.js 整体迁出（第三批批5）：!11 落下的这套台账是 acp-client 内
 * 最内聚的一块，却没有独立 interface——delegate-reply-timeout 的全部用例只能
 * 直捅私有方法或穿 `_post` stub 驱动。独立成模块后获得假 sendError + 短超时
 * 的直接测试面（AcpClient 保留全部方法名作单行委托，既有测试零改动）。
 *
 * **注入约束（审视 F6）**：`getTimeoutMs` 必须是 getter（每次武装时调用）而非
 * 构造期快照——delegate-reply-timeout 测试在构造**之后**改
 * `client.delegateReplyTimeoutMs = 40`，快照会让短超时用例退化成 60s 真等。
 *
 * **平移红线（审视 F11）**：两态语义（awaiting 固定锚 / confirming 滑动窗）、
 * 三清窗出口分工、touch 的「新建 setTimeout 重武装」、timer 的 unref——逐字
 * 平移，禁任何「优化」（改惰性时间戳 / 合并单定时器都会改变武装时点与 unref
 * 语义，且未必被既有用例盖住）。
 */

/**
 * @param {object} deps
 * @param {(id: number|string, code: number, message: string) => Promise<void>} deps.sendError
 *        JSON-RPC error 兜底出口（client 注入 `_sendJsonRpcError` 的包装——幂等标记
 *        `_answeredInbound` 与 POST 机制归发送器，不在台账内）。
 * @param {() => number} deps.getTimeoutMs 每次武装时调用的阈值 getter（迟到绑定）。
 * @param {({ id, method }) => void} [deps.onConfirmExpired]
 *        送达确认窗满窗通知（bugfix-20261020-hydrate-stall F-fix2）：error 兜底之外的
 *        **处置升级信号**——满窗 = CLI 对批准零确认且无任何事件流动，网关侧应升级处置
 *        （提前楔形信号→换进程）而非把 error 打进死等。仅 confirming 相触发，
 *        awaiting 相不触发（语义：批准已发出才谈得上「未确认送达」）。
 * @param {Console} [deps.log] 日志出口（默认 console；前缀逐字保持 `[acp-client]`）。
 * @param {typeof setTimeout} [deps.setTimeoutFn] 定时器注入位（测试假时钟；生产默认全局）。
 * @param {typeof clearTimeout} [deps.clearTimeoutFn] 同上。
 */
export function createInboundLedger({ sendError, getTimeoutMs, onConfirmExpired, log = console, setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout }) {
  // id → { timer, method, sent }：服务端主动推送的 JSON-RPC 请求（delegateTool /
  // request_permission）到达即登记，driver 消费即 ack；超时未被 ack（推送链路
  // 静默丢失）→ 回 JSON-RPC error 兜底，避免 CLI 永久死等（2026-09-17 事故：
  // DelegateTool span 永远 running，180s 后被停滞守卫回收）。
  const entries = new Map();

  /**
   * 武装一条入站注册的兜底定时器（两态单条目单定时器，bugfix-20260922-stall-rootcure）。
   *
   * - `awaiting`（现状语义）：到点未被消费 → 推送链路静默丢失，error 兜底（单发，
   *   R11 顺序契约：发送失败不得标记已应答）。
   * - `confirming`（送达确认窗）：批准已发出但 CLI 零活动满窗 → ack≠送达（2026-09-22
   *   生产 trace 实证），error 兜底 + 一次重试（有损通道上单发静默吞不可接受）。
   */
  function armInboundTimer(id, method, phase) {
    const timer = setTimeoutFn(() => {
      entries.delete(id);
      if (phase === 'awaiting') {
        log.warn(
          `[acp-client] Inbound ${method} id=${id} was not consumed within ${getTimeoutMs()}ms; ` +
          `answering with JSON-RPC error so the CLI does not wait forever (request likely dropped)`
        );
        sendError(id, -32001, `buddy2api: inbound request ${method} was dropped before delivery`).catch(() => {});
      } else {
        log.warn(
          `[acp-client] Inbound ${method} id=${id} approval not confirmed delivered within ` +
          `${getTimeoutMs()}ms (no CLI activity since send); ` +
          `answering with JSON-RPC error so the CLI does not wait forever`
        );
        // 处置升级信号（F-fix2）：先通知后兜底——通知方（driver 楔形信号）失败
        // 不得吞掉兜底；回调异常自吞（fire-and-forget 边界，与 sendError 同口径）。
        if (onConfirmExpired) {
          try { onConfirmExpired({ id, method }); } catch { /* 信号失效不阻塞兜底 */ }
        }
        answerDeliveryFallback(id, method, 0);
      }
    }, getTimeoutMs());
    timer.unref?.();
    return timer;
  }

  /**
   * 送达确认窗的 error 兜底：失败大声记日志并恰好重试一次（W8）。
   * 重试仍失败放弃——fire-and-forget 边界，不得让兜底路径抛错污染调用方。
   */
  function answerDeliveryFallback(id, method, attempt) {
    sendError(id, -32001, `buddy2api: inbound request ${method} approval was likely not delivered`)
      .catch(() => {
        if (attempt >= 1) {
          log.warn(`[acp-client] delivery fallback for id=${id} failed twice; giving up`);
          return;
        }
        log.warn(`[acp-client] delivery fallback POST for id=${id} failed; retrying once`);
        answerDeliveryFallback(id, method, attempt + 1);
      });
  }

  /**
   * 登记一条入站请求：仅 delegateTool / request_permission 这类**服务端主动推送的
   * JSON-RPC 请求**（带 id）需要。
   *
   * 非委托事件（delta/usage/result 等）不登记、不打日志。同请求可能经多条通道
   * 到达（standalone SSE 投递 + 合并迭代器再取），幂等：已在表则保留首次到达
   * 时刻与唯一一条日志。awaiting 兜底锚点即该时刻（固定阈值，不被事件滑动——
   * 滑动只作用于送达确认窗，见 touchInbound）。
   */
  function registerInbound(event) {
    const method = event?.method;
    if (method !== '_codebuddy.ai/delegateTool' && method !== 'session/request_permission') return;
    if (event.id == null) return; // 通知（无 id）无需应答

    const id = event.id;
    if (entries.has(id)) return;

    log.warn(`[acp-client] Inbound ${method} id=${id} registered (awaiting consumption)`);
    entries.set(id, { timer: armInboundTimer(id, method, 'awaiting'), method, sent: false });
  }

  /**
   * permission 批准**应答已发出**（POST 成功 ≠ CLI 确认收到）：条目保留在表，
   * 定时器 re-arm 进入「送达确认窗」。CLI 任一后续事件经 touchInbound 滑动重置；
   * 「最后事件后满窗」零活动 → error 兜底（CLI 视工具失败自行继续回合，客户端无感）。
   * 清窗出口：clearInboundWindows（driver done·工具挂起）/ prompt 流收尾
   * （连接空闲）/ clearAll（destroy）。迟到（已兜底/已清窗）为 no-op。
   *
   * @returns {boolean} 是否命中了在途注册
   */
  function markInboundSent(event) {
    const id = event?.id;
    if (id == null) return false;
    const entry = entries.get(id);
    if (!entry) return false; // 已被兜底/清窗：无需再确认
    clearTimeoutFn(entry.timer);
    entry.sent = true;
    entry.timer = armInboundTimer(id, entry.method, 'confirming');
    log.warn(`[acp-client] Inbound ${entry.method} id=${id} approval sent; delivery-confirm window armed (${getTimeoutMs()}ms)`);
    return true;
  }

  /**
   * 滑动窗口探针：driver 消费循环每收到一个事件即调用——CLI 有事件流动 = 存活，
   * **送达确认窗**（sent=true 条目）的定时器重置。
   *
   * ⚠ 只重置确认窗、不动 awaiting（未消费）条目（评审 K3）：awaiting 的兜底锚点
   * 必须保持在注册时刻（现状节奏）——若也滑动，孤儿 awaiting 条目会随连接复用被
   * 新请求的事件无限续命，最终把 error 打进正在服务其他会话的连接。
   * 表空/无确认窗时 no-op（每事件一次 O(n) 遍历，常规路径 n=0）。
   */
  function touchInbound() {
    if (entries.size === 0) return;
    for (const [id, entry] of entries) {
      if (!entry.sent) continue;
      clearTimeoutFn(entry.timer);
      entry.timer = armInboundTimer(id, entry.method, 'confirming');
    }
  }

  /**
   * 回合收尾清窗（无 error）：driver done / 工具挂起（控制权交客户端）/ prompt 流
   * 收尾（连接空闲）。这些时刻 CLI 的存活已由结构保证（turn 结束/等客户端回传），
   * **送达确认窗**（sent=true）全部失效——不清理的话 armed 定时器会存活进 idle
   * 连接，误发到被后续请求复用的健康连接上（2026-09-22 评审 F7）。
   *
   * ⚠ 只清确认窗、不动 awaiting（未消费）条目：推送静默丢失的兜底节奏必须保持
   * 现状（到点即 error，与回合状态无关）——否则回合先结束时未消费请求的兜底被
   * 静默吞掉，CLI 死等回到无防线状态（smoke S1 即此场景的锚定）。
   */
  function clearInboundWindows() {
    for (const [id, entry] of entries) {
      if (!entry.sent) continue; // awaiting 条目保持原有兜底节奏
      clearTimeoutFn(entry.timer);
      entries.delete(id);
    }
  }

  /**
   * 标记入站请求已被消费（driver 拿到事件即调用）。
   * 未命中注册表时为 no-op（非委托事件、或已由超时兜底处理）。
   *
   * 语义收窄（stall-rootcure）：现在只有 delegateTool 消费路径走 ack（挂起等客户端
   * 执行由 PENDING_TTL_MS 管，兜底不得介入）；permission 批准送达改走 markInboundSent
   * （ack≠送达）。清窗出口移除的条目同样表现为 miss——不影响幂等性。
   *
   * @returns {boolean} 是否命中了在途注册
   */
  function ackInbound(event) {
    const id = event?.id;
    if (id == null) return false;
    const entry = entries.get(id);
    if (!entry) {
      // 未命中成因：① 该 id 已由超时兜底应答（迟到交接）② 已 ack 过 ③ 已由清窗出口移除
      log.warn(`[acp-client] ackInbound miss for id=${id} (already answered or already acked); ignoring`);
      return false;
    }
    clearTimeoutFn(entry.timer);
    entries.delete(id);
    return true;
  }

  /** 清空在途注册（连接销毁；`_answeredInbound` 幂等集合归 client 发送器，由其随清）。 */
  function clearAll() {
    for (const { timer } of entries.values()) clearTimeoutFn(timer);
    entries.clear();
  }

  return { registerInbound, markInboundSent, touchInbound, clearInboundWindows, ackInbound, clearAll, size: () => entries.size };
}

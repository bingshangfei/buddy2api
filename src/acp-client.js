/**
 * WorkBuddy ACP Protocol Client
 * Handles connection and communication with WorkBuddy Gateway via ACP protocol
 *
 * 传输层统一（方案 B）：
 *   - _post() 是唯一 HTTP 原语（非流式 JSON / raw 文本 / 流式 response 三种模式）
 *   - _iterSse() 是唯一 SSE 事件迭代器（data: 行剥离 + JSON.parse + id 匹配）
 *   - _sendJsonRpc / _sendJsonRpcStream / _sendJsonRpcResult / _sendNotification
 *     全部基于上述原语，不再各自重复 HTTP 请求与 SSE 解析
 */

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
// 入站委托请求注册表（批5）：注册表+两态定时器归 inbound-ledger.js，本类保留
// 方法名单行委托——既有测试直捅面与 driver 可选链调用点零改动
import { createInboundLedger } from './inbound-ledger.js';
import path from 'node:path';
import crypto from 'node:crypto';
import { discoverGatewayUrl } from './gateway-discovery.js';
// 增量行帧器（批9 #1）：openEventStream / _iterSse 共用同一套换行切分语义
import { createLineFramer } from './line-framer.js';

// 终极兜底空闲超时（30 分钟无任何数据才断开）。正常情况下 stream-driver 的
// 15 分钟软超时会先礼貌结束请求；此处的超时只用于防止底层连接泄漏（极少数
// 未取消的情况），且必须是"空闲"超时——每收到一个 chunk 就重置，绝不误杀
// 活跃流（长任务/上下文压缩可能持续数十分钟，绝对超时会在流正活跃时掐断，
// 导致客户端看到"Partial assistant output was discarded"）。
const STREAM_IDLE_HARD_TIMEOUT_MS = 30 * 60 * 1000;

// 入站委托请求兜底超时（双语义，2026-09-22 送达看门狗起）：①正常往返秒级，60s 远
// 大于任何健康链路耗时，到点仍未被消费即视为「推送静默丢失」，回 JSON-RPC error 让
// CLI 继续回合；②permission 应答送达成功后，同一阈值转作「送达确认窗」——滑动重置，
// 「最后事件后满窗」零活动 → error 兜底（ack≠送达，2026-09-22 生产 trace 实证）。
// 调小此值会同时缩短两个窗口、放大确认窗误杀面。置空/非法值回落默认（不提供 0
// 禁用——禁用等于回到 CLI 永久死等，0 走 `n > 0` 判定回落 60000）。
// 批6：具名导出（runtime-config 缩形）——口径获得直测面；解析表达式逐字保留。
export function resolveDelegateReplyTimeoutMs(env = process.env) {
  const raw = env.DELEGATE_REPLY_TIMEOUT_MS;
  if (raw == null || raw === '') return 60 * 1000;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 60 * 1000;
}

export class AcpClient {
  constructor(gatewayUrl = null) {
    // gatewayUrl 必须在调用 connect() 前确定（通常是 session-manager 传入）。
    // 构造函数是同步的，不能 await；若未传则置 null，connect() 时再异步解析。
    this.gatewayUrl = gatewayUrl;
    this.connectionId = null;
    this.sessionToken = null;
    this.sessionId = null;
    this.initialized = false;
    // 会话默认模型（session/new 的 configOptions currentValue；token 统计归因用）
    this.defaultModel = null;
    // 当前连接上"在飞"的 session/prompt 数量（未收到最终 result/error、未取消的）。
    // 用于让连接池判断此连接是否空闲可复用——同一连接并发两个 prompt 会导致
    // WorkBuddy 的 interceptorGate 反复重试，客户端表现为"输出被丢弃后重新生成"。
    this._inflightPrompts = 0;
    // Standalone SSE（GET 长连接）：服务端主动推送的请求（delegateTool /
    // request_permission）走"active POST 流 → standalone SSE"的降级路径。
    // prompt 流在工具执行期可能被服务端摘除，此时事件只会发到 standalone SSE。
    // 不建这条连接，委托工具调用会静默丢失（实测：executeTool 挂到 30s 超时）。
    this._eventStreamOpen = false;
    this._eventStreamRes = null;
    this._pushedEvents = [];
    this._pushedWaiters = [];
    // 入站委托请求注册表已迁 inbound-ledger.js（批5）：getter 注入保
    // delegateReplyTimeoutMs 的迟到绑定（测试构造后改字段的短超时依赖此语义）。
    // 已用 JSON-RPC error 兜底应答过的入站请求 id（迟到 result 的幂等守卫，
    // 防同一 id 被应答两次污染 CLI 状态机）；随连接销毁一并清理。
    this._answeredInbound = new Set();
    this.delegateReplyTimeoutMs = resolveDelegateReplyTimeoutMs();
    // 送达确认窗满窗订阅表（F-fix2）：driver 逐 run 订阅/退订（offDeliveryExpired），
    // 台账满窗时广播——把「error 打进死等 CLI」升级为「满窗即楔形处置」。
    // 单后端同一时刻至多一个活跃 prompt，广播面天然有界；回调异常自吞（台账侧已兜）。
    this._deliveryExpiredListeners = new Set();
    this._inboundLedger = createInboundLedger({
      sendError: (id, code, message) => this._sendJsonRpcError(id, code, message),
      getTimeoutMs: () => this.delegateReplyTimeoutMs,
      onConfirmExpired: (info) => {
        for (const fn of this._deliveryExpiredListeners) {
          try { fn(info); } catch { /* 单订阅者失效不拖垮其余 */ }
        }
      }
    });
  }

  /**
   * 连接上是否有未结束的 prompt 流。
   * 有则说明此连接被上一个请求占用（可能挂起在工具回传），不应被新请求复用。
   */
  hasInflightPrompt() {
    return this._inflightPrompts > 0;
  }

  /**
   * 打开 standalone SSE（GET 长连接），接收服务端主动推送的事件。
   * 幂等；事件进入内部队列，由 _iterSseMerged 与 POST 流合并消费。
   */
  async openEventStream() {
    if (this._eventStreamOpen) return;
    if (!this.connectionId) throw new Error('Cannot open event stream before connect()');
    this._eventStreamOpen = true;

    const url = new URL('/api/v1/acp', this.gatewayUrl);
    const req = http.request({
      method: 'GET',
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      headers: {
        Accept: 'text/event-stream',
        'x-codebuddy-request': '1',
        'acp-connection-id': this.connectionId
      }
    }, (res) => {
      clearTimeout(connectTimeout); // 响应头已到：真实网关（或支持 GET 的 mock）
      console.log(`[acp-client] Event stream (GET SSE) established status=${res.statusCode}`);
      res.setEncoding('utf8'); // 必须流级解码：按 chunk 独立 toString 会把跨 chunk 的多字节 UTF-8 截断成乱码
      this._eventStreamRes = res;
      const framer = createLineFramer();
      res.on('data', (chunk) => {
        for (const line of framer.push(chunk)) {
          if (!line.startsWith('data: ')) continue; // 心跳/注释行
          try {
            this._dispatchPushedEvent(JSON.parse(line.slice(6)));
          } catch { /* 忽略解析失败 */ }
        }
      });
      res.on('close', () => this._closeEventQueue());
      res.on('error', () => this._closeEventQueue());
    });
    // 连接超时：目标不认识 GET 长连接（如单测 mock）时自动放弃，
    // 防止 socket 挂起导致测试进程无法退出、连接泄漏。
    const connectTimeout = setTimeout(() => {
      try { req.destroy(); } catch { /* ignore */ }
      this._closeEventQueue();
    }, 5000);
    connectTimeout.unref?.();
    req.on('error', () => { clearTimeout(connectTimeout); this._closeEventQueue(); });
    req.end();
  }

  /** 关闭事件队列：唤醒所有等待者并标记结束 */
  _closeEventQueue() {
    this._eventStreamOpen = false;
    const waiters = this._pushedWaiters.splice(0);
    for (const w of waiters) {
      w.settled = { value: undefined, done: true };
      w.resolve(w.settled);
    }
  }

  /** 投递一条服务端推送事件 */
  _dispatchPushedEvent(event) {
    // 入站委托请求：**到达即登记**（不等被消费）——推送队列无人消费（prompt 流
    // 已结束/driver 已退出）时也能被超时兜底救回，这正是「推送静默丢失」场景。
    this._registerInbound(event);
    const w = this._pushedWaiters.shift();
    if (w) {
      // settled 与 resolve 同步写入：消费方在 finally 里读 settled 时，不依赖
      // Promise.then 的微任务是否已经跑过（异步结果会漏掉回队窗口）。
      w.settled = { value: event, done: false };
      w.resolve(w.settled);
    } else {
      this._pushedEvents.push(event);
    }
  }

  /**
   * 取下一条推送事件。
   *
   * 返回 `{ promise, cancel, waiter }`：`cancel` 从等待者数组精确移除本请求的
   * 等待者；`waiter.settled` 是同步写入的结算结果（供回合收尾判断是否有
   * 「已结算但未消费」的事件需要回队）。合并迭代器在回合边界必须 cancel——
   * 否则等待者会跨请求存活，抢走下一回合的事件（历史缺陷：每回合泄漏 1 个）。
   */
  _nextPushed() {
    if (this._pushedEvents.length) {
      // 已从队列取出的事件挂在句柄上（hasTaken）：竞速若输给 POST，回合收尾时
      // 必须放回队列，否则「取出即丢」。
      const waiter = { resolve: null, settled: null, consumed: false, hasTaken: true, takenEvent: this._pushedEvents.shift() };
      return {
        promise: Promise.resolve({ value: waiter.takenEvent, done: false }),
        cancel: () => {},
        waiter
      };
    }
    if (!this._eventStreamOpen) {
      return { promise: Promise.resolve({ value: undefined, done: true }), cancel: () => {}, waiter: null };
    }
    const waiter = { resolve: null, settled: null, consumed: false, hasTaken: false, takenEvent: null };
    const promise = new Promise((resolve) => { waiter.resolve = resolve; });
    this._pushedWaiters.push(waiter);
    const cancel = () => {
      const index = this._pushedWaiters.indexOf(waiter);
      if (index >= 0) this._pushedWaiters.splice(index, 1);
    };
    return { promise, cancel, waiter };
  }

  /**
   * 把「已被本回合取走但未消费」的推送事件放回队首（幂等）。
   *
   * 两个来源：① `waiter.settled`（等待者已结算，但 POST 赢得竞速/挂起遗弃）；
   * ② `waiter.takenEvent`（事件从 `_pushedEvents` 取出后输掉竞速）。
   * 消费过的句柄（consumed）不重复回队。
   */
  _requeuePushHandle(handle) {
    const waiter = handle?.waiter;
    if (!waiter || waiter.consumed) return;
    let value;
    if (waiter.settled && !waiter.settled.done) value = waiter.settled.value;
    else if (waiter.hasTaken) value = waiter.takenEvent;
    if (value !== undefined) this._pushedEvents.unshift(value);
    waiter.consumed = true;
  }

  /**
   * 销毁连接：关闭 standalone SSE 并使自身不可用（连接池 invalidate 时调用）。
   */
  destroy() {
    this._eventStreamOpen = false;
    try { this._eventStreamRes?.destroy(); } catch { /* ignore */ }
    this._eventStreamRes = null;
    this._closeEventQueue();
    this._clearInbound();
  }

  // ---------------------------------------------------------------------------
  // 入站委托请求兜底（注册表已迁 inbound-ledger.js，批5——下列为单行委托，
  // 两态语义 / 三清窗出口 / 触碰滑动窗的完整契约文档在台账模块内）
  // ---------------------------------------------------------------------------

  /** 登记入站请求（幂等；awaiting 兜底锚点 = 注册时刻） */
  _registerInbound(event) {
    this._inboundLedger.registerInbound(event);
  }

  /** permission 批准已发出：re-arm 进入「送达确认窗」（ack≠送达） */
  markInboundSent(event) {
    return this._inboundLedger.markInboundSent(event);
  }

  /** 滑动窗口探针：只重置确认窗、不动 awaiting（评审 K3） */
  touchInbound() {
    this._inboundLedger.touchInbound();
  }

  /** 回合收尾清窗：只清 sent=true（awaiting 保持原有兜底节奏，smoke S1 锚定） */
  clearInboundWindows() {
    this._inboundLedger.clearInboundWindows();
  }

  /**
   * 订阅送达确认窗满窗信号（F-fix2）：返回退订函数。driver 逐 run 订阅、
   * finally 退订——监听器不得活过请求（活过 discard 的定时器是已知事故类）。
   * @param {({ id, method }) => void} fn
   * @returns {() => void} 退订函数（幂等）
   */
  onDeliveryExpired(fn) {
    this._deliveryExpiredListeners.add(fn);
    return () => this._deliveryExpiredListeners.delete(fn);
  }

  /**
   * prompt 在飞计数收尾（`_inflightPrompts--` 的单点）：归零即连接空闲 → 清窗。
   */
  _releasePromptInflight() {
    this._inflightPrompts--;
    if (this._inflightPrompts <= 0) this.clearInboundWindows();
  }

  /** 标记入站请求已被消费（delegateTool 消费路径；miss 为 no-op） */
  ackInbound(event) {
    return this._inboundLedger.ackInbound(event);
  }

  /** 清空在途注册（连接销毁）；`_answeredInbound` 幂等集合随清（发送器侧状态） */
  _clearInbound() {
    this._inboundLedger.clearAll();
    this._answeredInbound.clear();
    this._deliveryExpiredListeners.clear(); // 满窗订阅随连接销毁（活过 destroy 的监听器无归属）
  }

  /**
   * 测试接缝（批5）：delegate-reply-timeout 用例读 `client._inbound.size` 判入表/
   * 出表、`clear()` 做用例间重置——注册表迁台账后以此窄面兼容（不暴露整张 Map）。
   * clear() 走台账 clearAll（连带清定时器）——比原 Map.clear 更干净，用例间重置
   * 语义不受影响。
   */
  get _inbound() {
    const ledger = this._inboundLedger;
    return {
      get size() { return ledger.size(); },
      clear() { ledger.clearAll(); }
    };
  }

  /**
   * Establish connection to ACP gateway
   */
  async connect() {
    if (!this.gatewayUrl) {
      this.gatewayUrl = await discoverGatewayUrl();
    }
    const response = await this._post('/api/v1/acp/connect', null, {
      headers: {
        'Content-Type': 'application/json',
        'x-codebuddy-request': '1'
      }
    });

    this.connectionId = response.connectionId;
    this.sessionToken = response.sessionToken;
    return response;
  }

  /**
   * Initialize ACP protocol
   */
  async initialize() {
    if (!this.connectionId) {
      await this.connect();
    }

    const result = await this._sendJsonRpc('initialize', {
      protocolVersion: 1,
      capabilities: {},
      clientInfo: { name: 'buddy2api', version: '1.0.0' }
    });

    this.initialized = true;
    return result;
  }

  /**
   * Create a new session
   */
  /**
   * Create a new session
   *
   * 默认工作目录用 `os.tmpdir()/buddy2api-api/<uuid>`：每次 acquire 生成随机子目录，
   * 保证 WorkBuddy 的 session/new 不会附着到桌面端已打开的任何会话上，避免继承
   * 100k+ tokens 的上下文（推理过程泄漏、答非所问）。显式传入 workingDirectory 时
   * 沿用调用方指定的路径（测试或特殊场景）。
   */
  async createSession(workingDirectory = path.join(os.tmpdir(), 'buddy2api-api', crypto.randomUUID())) {
    if (!this.initialized) {
      await this.initialize();
    }

    // 确保工作目录存在，避免 WorkBuddy 因目录不存在而回退到默认上下文
    try {
      await fs.promises.mkdir(workingDirectory, { recursive: true });
    } catch (err) {
      console.warn(`[AcpClient] Failed to create working directory ${workingDirectory}:`, err.message);
      // 继续执行，让 WorkBuddy 自己处理
    }

    const result = await this._sendJsonRpc('session/new', {
      workingDirectory,
      cwd: workingDirectory,
      mcpServers: []
    });

    this.sessionId = result.sessionId;

    // 捕获会话默认模型（configOptions 中 id==='model' 的 currentValue），
    // 供 token 统计在客户端未指定 model（auto/default）时归因实际模型。
    // glm-5.3-flash 是隐藏默认项：不在 options 列表里但 currentValue 会指明。
    const modelOpt = Array.isArray(result.configOptions)
      ? result.configOptions.find(o => o?.id === 'model')
      : null;
    if (typeof modelOpt?.currentValue === 'string' && modelOpt.currentValue) {
      this.defaultModel = modelOpt.currentValue;
    }

    // 会话模式默认就是 fullAccess（WorkBuddy session/new 的 mode 选项
    // currentValue 已实测为 fullAccess），无需显式设置。旧代码曾用
    // session/set_config_option 尝试设置，但参数格式错误（optionId 应为
    // configId），每次都刷 Invalid params 警告，且纯属多余。若未来 WorkBuddy
    // 改变默认值，stream-driver 的 _autoApprove 仍会兜底批准权限请求。

    return result;
  }

  /**
   * Set the model for a session
   */
  async setModel(modelId, sessionId = this.sessionId) {
    const result = await this._sendJsonRpc('session/set_model', {
      sessionId,
      modelId
    });
    // 设置成功后会话当前模型已变：同步 defaultModel，让 token 归因
    // （usage 事件没报 model 时的兜底）指向真正在用的模型，
    // 而不是 session/new 时的初始值。
    this.defaultModel = modelId;
    return result;
  }

  /**
   * Cancel the currently running prompt in a session.
   * Used when the HTTP client disconnects mid-request so the WorkBuddy
   * agent task is not left running orphaned.
   */
  async cancelPrompt(sessionId = this.sessionId) {
    try {
      await this._sendJsonRpc('session/cancel', { sessionId });
    } catch (e) {
      // Best-effort cancel; ignore failures
    }
  }

  /**
   * 注册委托工具（OpenAI function tools → WorkBuddy delegate tools）。
   * 注册后 WorkBuddy 在推理时可以把这些工具当作可用工具调用。
   * 工具权限：会话默认 fullAccess（见 createSession），委托工具本身
   * requiresApproval:false，无需额外设置；stream-driver 的 _autoApprove
   * 再兜底批准一次。
   *
   * @param {string} sessionId
   * @param {Array} tools OpenAI 格式 tools 数组
   */
  async delegateTools(sessionId, tools) {
    if (!Array.isArray(tools) || tools.length === 0) return;
    const mapped = tools.map(t => ({
      id: t.function?.name || t.name,
      name: t.function?.name || t.name,
      description: t.function?.description || '',
      inputSchema: t.function?.parameters || {},
      provider: 'buddy2api',
      category: 'external',
      requiresApproval: false
    }));
    await this._sendJsonRpc('_codebuddy.ai/delegateToolsChanged', {
      sessionId,
      changeType: 'added',
      providerId: 'buddy2api',
      tools: mapped
    });
  }

  /**
   * 自动批准工具调用（兜底：若仍触发权限等待）。
   */
  async approveToolCall(sessionId, toolCallId) {
    await this._sendJsonRpc('_codebuddy.ai/resolveInterruption', {
      sessionId,
      toolCallId,
      decision: 'allow'
    });
  }

  /**
   * 回传委托工具的执行结果给 WorkBuddy。
   * 正确协议：响应 _codebuddy.ai/delegateTool 请求（带 id 的 JSON-RPC 请求），
   * result 为 { status: "success", output: "..." }。
   *
   * @param {string|number} delegateReqId delegateTool 请求的 JSON-RPC id
   * @param {string} resultText 工具执行结果文本
   */
  async respondToToolCall(delegateReqId, resultText) {
    await this._sendJsonRpcResult(delegateReqId, {
      status: 'success',
      output: resultText
    });
  }

  /**
   * 应答 session/request_permission（自动批准）：回 JSON-RPC result
   * `{ outcome: { outcome, optionId } }`。
   *
   * 公开出口（批9 #5）：driver 只依赖此方法，不再直捅 _sendJsonRpcResult——
   * 与 respondToToolCall 并列，构成"入站请求应答"的对外契约。
   *
   * @param {string|number} requestId request_permission 请求的 JSON-RPC id
   * @param {{outcome?: string, optionId?: string}} [choice]
   * @returns {Promise<boolean>} 是否真的发出（迟到守卫命中→false，未发送）
   */
  async respondPermission(requestId, { outcome = 'selected', optionId } = {}) {
    return this._sendJsonRpcResult(requestId, { outcome: { outcome, optionId } });
  }

  /**
   * Send a prompt and get streaming response
   */
  async *sendPrompt(prompt, sessionId = null) {
    if (!this.sessionId && !sessionId) {
      await this.createSession();
    }

    const targetSessionId = sessionId || this.sessionId;
    const promptContent = typeof prompt === 'string'
      ? [{ type: 'text', text: prompt }]
      : prompt;

    // 确保 standalone SSE 已建立（幂等）。服务端推送的 delegateTool /
    // request_permission 请求可能不走 prompt 流（见 openEventStream 注释）。
    try { await this.openEventStream(); } catch { /* 建不起来也不阻断 prompt */ }

    const sseStream = await this._sendJsonRpcStream('session/prompt', {
      sessionId: targetSessionId,
      prompt: promptContent
    });

    // 计入在飞数量。消费者在收到最终 result/error 后流自然结束，finally 减一；
    // 若被放弃（工具挂起超时 / 客户端断开），调用方应调用 iterator.return()
    // 使这里提前收尾，保证连接池能看到连接重新空闲。
    this._inflightPrompts++;
    try {
      yield* sseStream;
    } finally {
      this._releasePromptInflight(); // 归零即连接空闲 → 清确认窗（防 armed 定时器存活进 idle 连接）
    }
  }

  // ---------------------------------------------------------------------------
  // JSON-RPC 语义层：四个发送入口，全部基于统一传输原语
  // ---------------------------------------------------------------------------

  /**
   * 发送 JSON-RPC 请求，等待对应 id 的单个 result（非流式）。
   * 响应按 SSE 逐事件消费；匹配到该 id 的 result/error 即结束。
   *
   * 流结束但未见到匹配 result/error 时抛出——静默返回 null 会让调用方在
   * 后续字段访问处才崩（如 result.sessionId），错误源头被掩盖。
   */
  async _sendJsonRpc(method, params) {
    const id = `${method}-${Date.now()}`;
    const body = this._rpcBody(method, params, id);
    const response = await this._post('/api/v1/acp', body, {
      headers: this._rpcHeaders(),
      stream: true
    });

    for await (const event of this._iterSse(response, id)) {
      if (event.id !== id) continue;
      // 用 'result' in event 判定（而非 truthy）：session/cancel 等调用
      // 合法返回 result: null，truthy 判定会漏掉并挂到 30 分钟空闲超时
      if ('result' in event) return event.result;
      if (event.error) {
        throw new Error(event.error.message || 'JSON-RPC error');
      }
    }
    throw new Error(`No response for ${method} (stream ended without result; check required headers)`);
  }

  /**
   * 发送 JSON-RPC 请求，产出流式 SSE 事件，直到对应 id 的 result。
   */
  async *_sendJsonRpcStream(method, params) {
    const id = `${method}-${Date.now()}`;
    const body = this._rpcBody(method, params, id);
    const response = await this._post('/api/v1/acp', body, {
      headers: this._rpcHeaders(),
      stream: true
    });

    yield* this._iterSseMerged(response, id);
  }

  /**
   * 双源合并迭代器：POST prompt 流 + standalone SSE 推送队列。
   * matchId 语义与 _iterSse 一致（error 抛出 / result 终止并销毁 POST 流）。
   * 两源都按"串行 next"约束消费：任一时刻每个源最多一个挂起的 next()。
   */
  async *_iterSseMerged(response, matchId) {
    const post = this._iterSse(response, null);
    let postNext = post.next().then(
      (r) => ({ src: 'post', ok: true, r }),
      (e) => ({ src: 'post', ok: false, e })
    );
    const trackPush = (handle) => handle.promise.then(
      (r) => ({ src: 'push', ok: true, r }),
      (e) => ({ src: 'push', ok: false, e })
    );
    let pushHandle = this._nextPushed();
    let pushNext = trackPush(pushHandle);
    // 工具挂起会让消费方在 yield 处长期停留，且按设计**不关闭底层流**
    // （queue-policy：hasPending 时不调 iterator.return）。续跑时新建迭代器并
    // 覆盖 state.iterator，旧 generator 永不进 finally。因此挂起事件 yield 前
    // 必须主动摘掉推送等待者（不 destroy POST），恢复后（若被续跑）再重新注册。
    const isSuspendingEvent = (value) => value?.method === '_codebuddy.ai/delegateTool';
    let detached = false;
    const rearmPush = () => {
      pushHandle = this._nextPushed();
      pushNext = trackPush(pushHandle);
      detached = false;
    };
    const detachPush = () => {
      // 先回队「已结算/已取出但未消费」的事件，再移除等待者。
      // （挂起遗弃场景下 finally 永不执行，这里就是唯一的回队点。）
      this._requeuePushHandle(pushHandle);
      pushHandle?.cancel?.();
      detached = true;
    };

    try {
      while (true) {
        const winner = await Promise.race([postNext, pushNext]);

        if (winner.src === 'post') {
          if (!winner.ok) throw winner.e;
          const { value, done } = winner.r;
          if (done) break; // POST 流结束（result 后被销毁/服务端关闭）
          postNext = post.next().then(
            (r) => ({ src: 'post', ok: true, r }),
            (e) => ({ src: 'post', ok: false, e })
          );

          if (matchId != null && value.id === matchId && value.error) {
            response.destroy();
            throw new Error(value.error.message || 'JSON-RPC error');
          }
          if (isSuspendingEvent(value)) detachPush();
          yield value;
          if (detached) rearmPush(); // 若被续跑（而非遗弃）则恢复推送监听
          if (matchId != null && value.id === matchId && ('result' in value)) {
            response.destroy();
            return;
          }
        } else {
          if (!winner.ok) throw winner.e;
          const { value, done } = winner.r;
          if (done) {
            // 推送流关闭：不再从该源取（挂起等待者已被唤醒清理）
            pushNext = new Promise(() => {}); // 永久挂起，退出竞速
            continue;
          }
          // 该事件被本回合消费
          if (pushHandle.waiter) pushHandle.waiter.consumed = true;
          if (isSuspendingEvent(value)) detachPush();
          else rearmPush(); // 正常事件：先注册下一个等待者，避免事件间隙
          // 推送事件已在 _dispatchPushedEvent（到达时）登记，此处不重复登记
          yield value;
          if (detached) rearmPush();
        }
      }
    } finally {
      // 顺序有讲究（独立审视 F6）：POST 可能正卡在 next()，先 destroy 让挂起的
      // next() 立即返回；反过来先 return 会排队到 30 分钟 idle 硬超时。
      try { response.destroy?.(); } catch { /* ignore */ }
      try { post.return?.().catch?.(() => {}); } catch { /* ignore */ }
      // 精确移除本回合等待者（不能留给下一回合）
      pushHandle?.cancel?.();
      // 回合结束后队列里剩余的事件属于已结束的回合：先丢弃，避免串轮。
      this._pushedEvents.length = 0;
      // 再把「已结算/已取出但未被消费」的一条放回队首（顺序不能反）。
      this._requeuePushHandle(pushHandle);
    }
  }

  /**
   * 发送 JSON-RPC result（响应服务端请求）。
   *
   * 入站请求的**唯一应答出口**（delegateTool 的 respondToToolCall 与
   * request_permission 的 _autoApprove 都经此）——迟到防御集中在这里：
   * 该 id 已被超时兜底应答过时再补 result 会污染 CLI 的 JSON-RPC 状态机，跳过。
   */
  async _sendJsonRpcResult(id, result) {
    if (this._answeredInbound.delete(id)) {
      console.warn(`[acp-client] Late result for inbound id=${id} ignored (already answered with error)`);
      return false;
    }
    const body = JSON.stringify({ jsonrpc: '2.0', id, result });
    await this._post('/api/v1/acp', body, {
      headers: this._rpcHeaders(),
      raw: true // 响应体为空，不做 JSON 解析
    });
    return true;
  }

  /**
   * 发送 JSON-RPC error（应答服务端请求的失败语义）。
   * 入站委托请求超时兜底用：CLI 收到工具失败会自行继续回合，而不是永久死等。
   */
  async _sendJsonRpcError(id, code, message) {
    if (this._answeredInbound.has(id)) return; // 已应答过：不重复兜底
    const body = JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } });
    await this._post('/api/v1/acp', body, {
      headers: this._rpcHeaders(),
      raw: true
    });
    // 标记在发送成功之后：先标记后发送的话，POST 失败会让 id 被误记为「已应答」，
    // 之后真正到达的工具回传会被当迟到结果丢弃——CLI 又回到死等。
    this._answeredInbound.add(id);
  }

  /**
   * 发送 JSON-RPC 通知（无 id，不等待 result）。
   */
  async _sendNotification(method, params) {
    const body = JSON.stringify({ jsonrpc: '2.0', method, params });
    await this._post('/api/v1/acp', body, {
      headers: this._rpcHeaders(),
      raw: true // 通知响应为空，不做 JSON 解析
    });
  }

  // ---------------------------------------------------------------------------
  // 统一传输层
  // ---------------------------------------------------------------------------

  /**
   * 构造 JSON-RPC 请求体字符串。
   */
  _rpcBody(method, params, id) {
    return JSON.stringify({ jsonrpc: '2.0', id, method, params });
  }

  /**
   * 构造 JSON-RPC 请求头（所有 ACP 调用共用，connect 除外）。
   *
   * x-codebuddy-request: 1 是新版 codebuddy server 的必需头——缺失时服务器返回
   * 普通 JSON 错误（非 SSE 格式），客户端解析不到事件会静默拿到 null。
   */
  _rpcHeaders(extra = {}) {
    return {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
      'x-codebuddy-request': '1',
      'acp-connection-id': this.connectionId,
      ...extra
    };
  }

  /**
   * 唯一的 HTTP POST 原语。
   *
   * @param {string} path 请求路径（相对 gatewayUrl）
   * @param {string|null} body 请求体（字符串），null 表示无 body
   * @param {object} [options]
   * @param {object} [options.headers]
   * @param {boolean} [options.stream=false] true 时 resolve 原始 IncomingMessage，
   *                  由调用方用 _iterSse 消费；false 时收集完整响应体后 resolve
   * @param {boolean} [options.raw=false] 非流模式下，true 返回原始文本，false JSON.parse
   * @param {number} [options.timeoutMs=30000] 非流模式的请求超时（流模式由 _iterSse 兜底）
   * @returns {Promise<object|string|IncomingMessage>}
   */
  _post(path, body, { headers = {}, stream = false, raw = false, timeoutMs = 30000 } = {}) {
    return new Promise((resolve, reject) => {
      const url = new URL(path, this.gatewayUrl);
      const reqOptions = {
        method: 'POST',
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        headers
      };

      // header 超时对 stream 模式同样必要：后端接受 TCP 但永不返回响应头
      //（假死/卡死的恢复后端）时，没有任何计时器会让 promise settle，
      // initialize/createSession/setModel/prompt 全部永久挂起。
      let headerTimer = null;
      const armHeaderTimeout = () => {
        headerTimer = setTimeout(() => {
          req.destroy(new Error(`Response headers timeout after ${timeoutMs}ms: ${path}`));
        }, timeoutMs);
        headerTimer.unref?.();
      };

      const req = http.request(reqOptions, (res) => {
        clearTimeout(headerTimer);
        if (stream) {
          resolve(res);
          return;
        }

        let data = '';
        res.on('data', (chunk) => data += chunk);
        res.on('end', () => {
          if (raw) {
            // 4xx/5xx 必须按失败处理（K2）：raw 模式服务 JSON-RPC 应答发送口，
            // 网关 5xx 时 resolve 会让「先发送成功、再标记已应答」的顺序契约
            // 把失败记成已应答，送达确认窗的一次重试也永远不触发。
            if (res.statusCode >= 400) {
              reject(new Error(`HTTP ${res.statusCode} for ${path}: ${data.slice(0, 200)}`));
              return;
            }
            resolve(data);
          } else {
            try {
              resolve(JSON.parse(data));
            } catch (e) {
              reject(new Error(`Failed to parse JSON: ${data}`));
            }
          }
        });
      });

      req.on('error', (e) => {
        clearTimeout(headerTimer);
        reject(e);
      });
      if (!stream) {
        req.setTimeout(timeoutMs, () => {
          req.destroy(new Error(`Request timeout after ${timeoutMs}ms: ${path}`));
        });
      } else {
        armHeaderTimeout();
      }

      if (body) {
        req.write(body);
      }

      req.end();
    });
  }

  /**
   * 唯一的 SSE 事件迭代器：逐行剥离 `data: ` 前缀并 JSON.parse，产出事件。
   *
   * 换行切分复用 line-framer（批9 #1）：原实现每次 chunk 都 `buffer += chunk;
   * buffer.split('\n')`，对 10KB 响应约 100 个 chunk 累积做 O(n²) 拼接+分割；
   * 帧器"追加新字节 + 只扫描新字节内的换行"，总工作量降为 O(n)。
   *
   * @param {IncomingMessage} response 流式 HTTP 响应
   * @param {string} [matchId] 匹配的 JSON-RPC id。收到该 id 的 result/error 后
   *                 销毁底层连接并结束（error 直接抛出）。
   */
  async *_iterSse(response, matchId = null) {
    const framer = createLineFramer();
    let done = false;

    // 终极兜底：空闲超时（每收到 chunk 重置），防止底层连接泄漏。
    // 正常情况下调用方在收到 result 后会主动 destroy，这里只是保险。
    let idle;
    const armIdle = () => {
      clearTimeout(idle);
      idle = setTimeout(() => {
        if (!done) {
          console.warn('[acp-client] Stream idle hard timeout (30min no data), force-closing upstream');
          done = true;
          response.destroy();
        }
      }, STREAM_IDLE_HARD_TIMEOUT_MS);
    };
    armIdle();

    try {
      // 必须流级解码：按 chunk 独立 toString 会把跨 chunk 的多字节 UTF-8
      // 截断成 U+FFFD 乱码（模型输出以中文为主，事件大，高度必现）
      response.setEncoding('utf8');
      for await (const chunk of response) {
        if (done) break;
        armIdle(); // 有数据到达 → 重置空闲计时

        // 帧器只扫描新字节内的换行，避免重复扫描已处理的前缀
        for (const line of framer.push(chunk)) {
          if (!line.startsWith('data: ')) continue;
          let event;
          try {
            event = JSON.parse(line.slice(6));
          } catch (e) {
            continue; // Ignore parse errors
          }

          // 匹配到目标 id → error 直接抛出（终止事件，下游无需消费）；
          // result 作为正常事件 yield 后收尾（下游靠它判定结束）。
          if (matchId != null && event.id === matchId && event.error) {
            done = true;
            response.destroy();
            throw new Error(event.error.message || 'JSON-RPC error');
          }

          // 入站委托请求登记（非委托事件 no-op）：POST 流侧的唯一登记点，
          // 覆盖全部 _iterSse 使用方（含非 prompt 的 RPC 流——服务端推错流时
          // 也能被 60s 兜底救回）。
          this._registerInbound(event);
          yield event;

          if (matchId != null && event.id === matchId && ('result' in event)) {
            done = true;
            response.destroy(); // Close the upstream connection
            return;
          }
        }
      }
    } catch (error) {
      // 收到 result/error 后我们主动 destroy，async iterator 会抛
      // ERR_STREAM_PREMATURE_CLOSE。这是预期收尾，吞掉；真错误照常抛出。
      if (!(done && error?.code === 'ERR_STREAM_PREMATURE_CLOSE')) {
        throw error;
      }
    } finally {
      clearTimeout(idle);
      if (!done) {
        response.destroy();
      }
    }
  }
}

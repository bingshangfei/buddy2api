/**
 * openai-handler.js — OpenAI 兼容 API 的请求编排。
 *
 * 职责（候选2 拆分后）：会话编排、三条消费路径的装配、工具挂起与断开取消
 * 两个生命周期。纯策略与纯构造已拆出：
 *   queue-policy.js    排队/频控策略（isRateLimited / rateLimitDelayMs /
 *                      parseQuotaResetAt / runWithRateLimitRetry）
 *   prompt-builder.js  提示词构建（sanitizePrompt / buildPrompt / messageToText）
 *   response-builder.js 响应构造（buildToolCallResponse / buildFinalResponse / buildUsage）
 *   sink-factory.js    三条路径共用的 sink 装配（六个相同处理器只存一份）
 *
 * 委托工具闭环（zcode 技能支持）：
 *   zcode 请求带 tools → 注册为 WorkBuddy delegate tools
 *   WorkBuddy 发出 tool_call → 暂停流，以 OpenAI tool_calls 返回给 zcode
 *   zcode 执行技能后带 tool 消息回来 → 回传结果 → 继续消费流
 *
 * 事件消费统一走 StreamDriver（见 stream-driver.js）：三条路径
 * （首轮流式 / 首轮非流式 / 工具回传续跑）通过 sink-factory 装配，循环只有一份。
 */

import { SessionManager } from './session-manager.js';
import { sseChunk, SSE_DONE, sseUsageChunk } from './openai-wire.js';
import { STREAM_SOFT_TIMEOUT_MS, STREAM_FIRST_TOKEN_TIMEOUT_MS, STREAM_STALL_TIMEOUT_MS, STALL_REASON, WEDGE_ERROR_CODE } from './stream-driver.js';
import { resWriter } from './http-utils.js';
import { createOpenAiStrategy } from './openai-strategy.js';
import { createAnthropicStrategy } from './anthropic-strategy.js';
import { resolveAnthropicModel, isClaudeModelId, translateAnthropicRequest } from './anthropic-protocol.js';
import { rateLimitDelayMs, runWithRateLimitRetry } from './queue-policy.js';
import { sanitizePrompt, buildPrompt, blocksToPlainText, messageToText } from './prompt-builder.js';
import { buildToolCallResponse, buildFinalResponse, buildUsage, buildAnthropicMessage, buildAnthropicToolUseResponse } from './response-builder.js';
import { tokenStats } from './token-stats.js';
import { estimatePromptTokens, observePromptTokens, estimateOutputTokens } from './usage-accounting.js';
import { ConversationCache } from './conversation-cache.js';
import { ConvAccountMap } from './conv-account-map.js';
import {
  EMPTY_USAGE, CONTINUE_INSTRUCTION, CONTINUE_INSTRUCTION_DEGRADED, MAX_CONTINUATIONS,
  seedAttemptState, markFinalized, markUsageRecorded, promoteWedgeReason,
  mergeUsage, markFirstOutput, setContinuationContext, incrementContinued
} from './attempt.js';
import { seedConnectionState, bindConnection } from './connection-state.js';
import { continueAfterWedge } from './continuation.js';
import { resolveRequestedModel, pickFallbackModel, FALLBACK_MODELS } from './model-policy.js';
import { createHash } from 'node:crypto';

// 向后兼容的再导出（index.js 与外部引用沿用旧入口；测试已改指新模块）
export { isRateLimited, rateLimitDelayMs, parseQuotaResetAt } from './queue-policy.js';
export { sanitizePrompt } from './prompt-builder.js';
// 错误分类知识已迁 error-classifier.js（分类学单点，refactor-20260928-arch-deepening2 批1）：
// isWedgeError/classifyError/isBackendConnErrorMessage 定义在该叶模块，本文件委托 + 再导出
import { classifyError, isBackendConnErrorMessage, isWedgeError } from './error-classifier.js';
// 终结处置簇（头：分类+连接类丢弃 / 尾：清挂起+条件冷却+失效）单点，批4
import { disposeConnError, releaseAfterError, disposeWedge } from './finalizer.js';
// 模型解析与回退策略已归属 model-policy.js（model id 策略唯一 interface，批1）：
// 消费方（router/index/测试）直连该模块，本文件不再转口再导出
// 假死错误工厂/谓词导出（测试锚定用：err.code 契约 + 措辞契约，tests/wedge-contract.test.js）
export { firstTokenTimeoutError, isWedgeError };

// EMPTY_USAGE / CONTINUE_INSTRUCTION(_DEGRADED) / MAX_CONTINUATIONS / addUsage
// 已拆到 attempt.js（种子与终态原语单点，候选①）

// 远程图片抓取与 SSRF 防御已拆到 image-fetch.js（refactor-20260928-arch-deepening2 批2）：
// 协议白名单 / 私网段拦截 / DNS rebinding 防御 / 大小与超时帽全部在该模块（有单测）。
import { resolveRemoteImages } from './image-fetch.js';

// 挂起定时器武装/到期守卫原语 + PendingTable（条目 timer 生命周期）在
// pending-expiry.js；销毁序列（cancelPrompt/iterator.return/invalidate）仍是本文件行为锚
import { armPendingTimer, pendingExpiryNoop, PendingTable } from './pending-expiry.js';

/**
 * 假死守卫（首 token / 中途停滞）触发的错误。catch 路径凭 name 识别，按后端类错误处置：
 * 同模型换新后端自愈一次（_prepareModelFallback）、不冷却账号（假死不是账号的错）。
 * 消息刻意避开 isRateLimited 的识别词（排队/等候/busy 等），防止被误当频控退避 17.5 分钟。
 * 另带类型码 err.code = WEDGE_ERROR_CODE（**本工厂是唯一设置点**）：queue-policy
 * 据此短路、不进退避——typed 判定优先，措辞契约保留为历史兜底（勿在别处增设 code）。
 */
function firstTokenTimeoutError(final = false, reason = STALL_REASON.FIRST_TOKEN) {
  // ⚠ 措辞约束：不得含 isRateLimited 识别词（如「请稍后」「排队」「busy」）——
  // 命中会被 queue-policy 误当频控进入 17.5 分钟退避重试循环（正是本次要消灭的挂起）。
  const stalled = reason === STALL_REASON.MID_STREAM;
  const sec = Math.round((stalled ? STREAM_STALL_TIMEOUT_MS : STREAM_FIRST_TOKEN_TIMEOUT_MS) / 1000);
  const envHint = stalled ? 'STREAM_STALL_TIMEOUT_MS' : 'FIRST_TOKEN_TIMEOUT_MS';
  const base = stalled
    ? `WorkBuddy 响应中途停滞（${sec}s 无输出，疑似后端假死，已回收该后端）`
    : `WorkBuddy 首 token 超时（${sec}s 零输出，疑似后端假死，已回收该后端）`;
  const err = new Error(
    base + (final ? `；已自动换后端重试 1 次仍失败，可调大 ${envHint} 后让客户端重试。` : '')
  );
  err.name = 'FirstTokenTimeoutError';
  err.code = WEDGE_ERROR_CODE;
  return err;
}

/**
 * A 路径（续跑）wedge 错误——措辞必须与事实一致（CR Standards 轴两档）：
 * - 自愈未发生（无素材/闸未过）：「续跑回合不做自动重试」——如实；
 * - 自愈已发生且失败（resumed=true）：「已尝试换进程自愈 1 次仍失败」——不得否认
 *   做过的事（镜像 RC-main① 的「谎称做过没做的事」，B 路径「已尝试续写 N 次」同口径）。
 * 措辞约束与 firstTokenTimeoutError 相同：避开 isRateLimited 识别词。
 */
function resumeWedgeTimeoutError(reason = STALL_REASON.FIRST_TOKEN, resumed = false) {
  const err = firstTokenTimeoutError(false, reason);
  err.message += resumed
    ? '；已尝试换进程自愈 1 次仍失败，请重试。'
    : '；续跑回合不做自动重试，请重试。';
  return err;
}

// isWedgeError 已迁 error-classifier.js（文件头 import 处委托 + 再导出，候选②批1）

// （addUsage 已拆到 attempt.js——续写段 usage 滚动合并的唯一实现）

// （KNOWN_FREE_UNLISTED 已迁 model-policy.js——遗留免费 id 白名单，批1）

// 客户端断开后延迟取消 WorkBuddy 任务的宽限期。WorkBuddy 的 cancel 机制只给
// 5s 宽限就强杀流（日志：sweepOrphanedPromptResponse），压缩上下文时 agent
// 来不及响应 → 客户端看到 "discarded before streaming retry"。这里断开后先等
// 30s 再 cancel，期间客户端重连（新请求到达）则撤销取消。
const DISCONNECT_CANCEL_GRACE_MS = 30 * 1000;

// 会话准备 seam 已迁 session-prepare.js（批3：两协议共用的 setModel+delegateTools
// 序列单点；RETRY_PREPARE_POLICY 随迁；D6 不变式改指向新模块）
import { prepareSession, needsTools, RETRY_PREPARE_POLICY } from './session-prepare.js';

/**
 * request-context——本次 HTTP 请求身份的唯一 owner（架构深化第 8 批批C）。
 *
 * 「这次 HTTP 请求是谁」（key/res/clientModel/protocol/thinkingEnabled/
 * includeUsage/outcome/isAborted/tools）此前以散装具名参数穿 10 层到流终结，
 * 且与 attempt state 重复携带。收进本盒子后，B/C 路径签名收缩为
 * `{ session, prompt, model, ctx, ...路径特有 }`。
 *
 * ⚠ 两个生命周期严格分离（审视确认的孪生概念）：
 *   - **ctx**：一次 HTTP 请求的常量身份——A（续跑）路径复用上一个请求种下的
 *     pending state，B/C 每次重试各建新 attempt；completionId/created/model
 *     这类**逐 attempt** 的值由各路径在本盒子之上展开（`{ ...ctx, completionId,
 *     created, model }`），不进 request 级 ctx。
 *   - **attempt state**：跨 HTTP 请求存活（随 pending 条目走），protocol/
 *     thinkingEnabled 等决策随它透传（续跑不重读 env）——ctx 只是它们的
 *     本轮只读视图，绝不反向写 state。
 *
 * BC-12 口径随工厂走：`thinkingEnabled` 未提供时按协议取默认（OpenAI 开 /
 * Anthropic 关）——与原签名默认值 `protocol !== 'anthropic'` 等价，且只在此
 * 应用一次（router 之外的直接调用方构造 ctx 同样拿到协议感知默认，不静默丢思考）。
 *
 * @param {object} args
 * @param {string} args.key 会话隔离键（pending/convAccounts/conversations 单点构造）
 * @param {object} args.res 原始 HTTP 响应
 * @param {() => boolean} [args.isAborted] 客户端断开探针
 * @param {string} [args.clientModel] 客户端原始请求值（记账 requestedModel 用）
 * @param {'openai'|'anthropic'} [args.protocol]
 * @param {boolean} [args.thinkingEnabled] 缺省按协议默认（BC-12）
 * @param {boolean} [args.includeUsage] OpenAI stream_options.include_usage
 * @param {object|null} [args.outcome] 请求级回退闸/耗时汇总盒
 * @param {Array|null} [args.tools] 客户端委托工具
 * @returns {object} 只读视图（约定不原地改写；逐 attempt 差异用展开覆盖）
 */
export function buildRequestContext({ key, res, isAborted, clientModel, protocol = 'openai', thinkingEnabled, includeUsage = false, outcome = null, tools = null }) {
  return {
    key,
    res,
    isAborted,
    clientModel,
    protocol,
    thinkingEnabled: thinkingEnabled ?? (protocol !== 'anthropic'),
    includeUsage,
    outcome,
    tools
  };
}

export class OpenAiHandler {
  /**
   * @param {string|null} [gatewayUrl] 网关地址（透传给 SessionManager）
   * @param {object} [deps] 可选依赖注入（批9 #3）——测试/嵌入方一行装配替身，
   *        免去构造后再逐个属性赋值。缺省时与旧行为逐字一致（各自 `new`）。
   *        名下的协作者：`sessions` / `conversations` / `convAccounts` /
   *        `pending` / `disconnectCancels`。
   */
  constructor(gatewayUrl = null, deps = {}) {
    this.sessions = deps.sessions ?? new SessionManager(gatewayUrl);
    // key -> 挂起的工具调用状态（跨 HTTP 请求保持）
    this.pending = deps.pending ?? new PendingTable();
    // key -> { timer, client, sessionId }：客户端断开后的延迟取消计时器。
    // 客户端断开不立即 cancel WorkBuddy 任务——立即 cancel 会丢弃 WorkBuddy
    // 已生成的部分输出（客户端表现为 "Partial assistant output was discarded
    // before a streaming retry"），且 WorkBuddy 只给 5s 宽限期，压缩上下文时
    // agent 来不及响应就被强杀。改为宽限期后取消；期间客户端重连则撤销。
    this.disconnectCancels = deps.disconnectCancels ?? new Map();
    // 会话亲和缓存：多轮对话复用同一后端会话、只发增量，稳定命中后端
    // 前缀缓存（否则每请求新建会话约 40% 全量 miss，白烧 ~22k tokens/次）。
    // 可用 BUDDY2API_SESSION_REUSE=0 关闭。
    this.sessionReuse = process.env.BUDDY2API_SESSION_REUSE !== '0';
    this.conversations = deps.conversations ?? new ConversationCache();
    // 会话 → 账号 的亲和映射：后端与账号绑定，**同一会话**粘住同一账号可命中
    // 云端按账号计的前缀缓存，也避免交替轮换导致后端进程反复冷启动。
    // 粒度是会话而不是 API key——zcode 这类客户端所有会话共用一个 key，
    // 按 key 粘会把所有会话压到同一个账号上。上限裁剪（500/淘汰100/LRU 刷新）
    // 在 ConvAccountMap 单点（候选③抽取；Map 兼容面，调用方无感）。
    this.convAccounts = deps.convAccounts ?? new ConvAccountMap();

    // 协议策略实例（架构深化第十一批 C2）：无状态，构造时创建，按 protocol 选择
    this.openaiStrategy = createOpenAiStrategy();
    this.anthropicStrategy = createAnthropicStrategy();
  }

  /**
   * 会话标识：账号亲和的粒度单位。
   *
   * OpenAI 协议没有会话概念，每轮重发全量历史，可用两个稳定信号区分会话：
   *   1. `user` 字段（OpenAI 标准，客户端显式指定的端用户/会话标识）——最优先
   *   2. 首条 user 消息文本的指纹：同一会话每轮都带同样的首条消息（任务描述），
   *      不同会话的任务不同。**不用 system prompt**——同一 agent 的所有会话
   *      system prompt 相同，区分不出会话。
   * 都拿不到（无 user 消息，如纯图片首消息）→ 回退到 API key（旧行为）。
   *
   * @returns {string} convId
   */
  _conversationId(request, key) {
    if (typeof request?.user === 'string' && request.user) {
      return `${key}|u:${request.user}`;
    }
    const firstUser = Array.isArray(request?.messages)
      ? request.messages.find((m) => m?.role === 'user')
      : null;
    const text = firstUser ? messageToText(firstUser) : '';
    if (text) {
      const fp = createHash('sha1').update(text.slice(0, 2000)).digest('hex').slice(0, 16);
      return `${key}|f:${fp}`;
    }
    return key;
  }

  /**
   * 记录会话最近使用的账号（LRU 语义在 ConvAccountMap.set 单点：刷新插入顺序、
   * 超上限丢最旧的一批）。
   */
  _setConvAccount(convId, accountId) {
    if (!convId || !accountId) return;
    this.convAccounts.set(convId, accountId);
  }

  /**
   * Handle /v1/models endpoint
   */
  async handleListModels(key = 'default') {
    let cached = this.sessions.getModels(key);
    // 缓存为空（服务刚启动，或该 key 从未发过对话请求）→ 主动连网关
    // 通过 session/new 拉取真实模型列表；失败才退回硬编码兜底值。
    if (cached.length === 0) {
      try {
        const session = await this.sessions.acquire(key, { needsTools: needsTools(false) });
        this.sessions.release(key, session.poolId);
        cached = this.sessions.getModels(key);
      } catch (e) {
        console.warn(`[buddy2api] 获取真实模型列表失败，使用兜底列表: ${e.message}`);
      }
    }
    const now = Math.floor(Date.now() / 1000);
    const source = cached.length > 0 ? cached : FALLBACK_MODELS;

    return {
      object: 'list',
      data: source.map(m => ({
        id: m.id,
        object: 'model',
        created: now,
        owned_by: 'workbuddy',
        permission: [],
        root: m.id,
        parent: null,
        ...(m.name && m.name !== m.id ? { name: m.name } : {}),
        // 非标准扩展字段：网关的计费系数（x0.00 即免费）。
        // 仅在网关标注时附带——缺省**不等于**免费，auto 就属于未标注但仍计费。
        ...(m.coefficient != null
          ? { pricing: { coefficient: m.coefficient, free: m.free === true } }
          : {})
      }))
    };
  }

  /**
   * Handle /v1/messages/count_tokens endpoint
   *
   * 复用 estimatePromptTokens（与记账同一套估算口径，CJK 1 字≈1token）。
   * 部分客户端在发起正式请求前会先调它做上下文预算，不实现会直接报错。
   */
  async handleAnthropicCountTokens(body = {}) {
    const translated = translateAnthropicRequest(body);
    return { input_tokens: estimatePromptTokens(buildPrompt(translated.messages)) };
  }

  /**
   * Handle /v1/chat/completions endpoint
   *
   * OpenAI 与 Anthropic 两条协议共用本编排：请求差异在路由层由
   * translateAnthropicRequest 消解为同形内部请求，本方法只多认一个
   * `request.protocol` 用于选择 wire（sink / 响应构造）。
   */
  async handleChatCompletions(request, res) {
    const t0 = Date.now(); // 分段耗时基点（汇总日志见 finally）
    const { messages, stream = false, tools, stream_options } = request;
    const protocol = request.protocol === 'anthropic' ? 'anthropic' : 'openai';
    // 可观测性：OpenAI 路由理应产出 request.thinkingEnabled；缺失意味着本方法被
    // router 之外的调用方直接调用（测试/脚本）或接线上有洞——此时走的是协议感知
    // 的签名默认值（开）。**只告警不决策**：本入口同时服务首轮与工具续跑，在这里
    // 兜底解析会在续跑时重读 env，违反「决策只做一次」。
    if (protocol !== 'anthropic' && request.thinkingEnabled === undefined) {
      console.warn(
        '[buddy2api] ⚠ request.thinkingEnabled 缺失（非 router 调用方？）——' +
        '按协议默认值处理（OpenAI 侧为「开」）；可见性决策应由 router 的 resolveOpenAiThinking 产出'
      );
    }
    // model 是本次实际使用的模型 id：客户端未指定或写 auto/default 时回落到
    // 代理默认模型（默认免费的 hy4-preview-f），显式给了具体 id 则原样透传。
    // 响应回显与 token 归因都用它（绝不能是 undefined——省略 model 的请求回显成
    // undefined 会破坏 OpenAI 响应的形状）。
    //
    // Anthropic 路径多一层：客户端必发 claude-*，而网关没有这些 id。原样透传 +
    // 告警的 OpenAI 行为对 Anthropic 客户端等于每请求都告警、会话留在默认模型上
    // 静默计费，故映射到代理默认模型（响应仍回显客户端原始名，见 state.echoModel）。
    const model = protocol === 'anthropic'
      ? resolveAnthropicModel(request.model)
      : resolveRequestedModel(request.model);
    if (protocol === 'anthropic' && isClaudeModelId(request.model) && request.model !== model) {
      console.warn(
        `[buddy2api] ⚠ Anthropic 模型 "${request.model}" 网关不存在，已映射到代理默认模型 "${model}"` +
        `（响应回显原请求名；改 BUDDY2API_ANTHROPIC_MODEL 可指定映射目标）`
      );
    }
    // 客户端**原始**请求值，仅用于记账里的 requestedModel 字段（保留
    // "客户端写的是 auto" 这一信息，便于区分显式指定与走了默认）。
    const clientModel = request.model || 'auto';
    const key = request.apiKey || 'default';
    const hasTools = Array.isArray(tools) && tools.length > 0;
    // 是否需要内置工具的后端。决定 prompt 前缀（~22.7k 全量 vs ~3.2k 精简）
    // 与委托工具可用性：委托工具会被 --tools 白名单过滤，所以带 tools 的请求
    // 必须走全量后端。纯聊天走精简后端省下 19k+ 工具定义。
    const needsToolsFinal = needsTools(hasTools);
    // 流式末尾是否追加 usage chunk（OpenAI stream_options.include_usage 语义）
    const includeUsage = Boolean(stream_options?.include_usage);

    // 客户端重连（同 key 新请求到达）：撤销上次断开的延迟取消，
    // 让 WorkBuddy 侧任务继续（若它还没被取消）。
    const prevCancel = this.disconnectCancels.get(key);
    if (prevCancel) {
      clearTimeout(prevCancel.timer);
      this.disconnectCancels.delete(key);
      console.log(`[buddy2api] Client reconnected for key=${key}, cancelling pending disconnect-cancel`);
    }

    // 消息中带 tool 角色 → 这是工具结果回传，续跑挂起的 ACP 流。
    const hasToolResult = Array.isArray(messages) && messages.some(m => m.role === 'tool');
    const pendingState = this.pending.get(key);
    if (hasToolResult && pendingState?.resuming) {
      // 同一条挂起**正在回传中**：客户端重试了同一个 tool_result（或并发发了两条）。
      // 必须明确报错，不能放它落到下面的「正常路径」——正常路径会新建后端会话、
      // 重新 sendPrompt，而旧 ACP 流仍在跑：同一份 prompt 计费两次，两条流还会抢
      // 同一个 pending 条目。旧代码在此崩溃（state.toolCall.reqId 为 null 的
      // TypeError），崩溃是"响的"；改成静默新请求是把响的故障换成不响的重复计费。
      const dup = new Error(
        'A tool result for this conversation is already being submitted; this duplicate ' +
        'was not forwarded. Wait for the current turn to finish before retrying.'
      );
      dup.statusCode = 409;
      throw dup;
    }
    if (hasToolResult && pendingState?.toolCall) {
      return this._continuePending(key, messages, model, stream, res, includeUsage);
    }

    // 正常路径：优先复用同一对话的后端会话（前缀缓存稳定命中），否则新建。
    const resolved = await this._resolveRemoteImages(messages);
    const blocks = sanitizePrompt(this._buildPrompt(resolved));
    const fullText = blocksToPlainText(blocks);
    // 复用资格：纯文本 + 无委托工具。工具流程的会话状态更复杂（挂起/续跑），
    // 且带 tools 的请求通常也就一两轮，复用收益低、风险高，直接排除。
    const reuseEligible = this.sessionReuse && fullText != null && !hasTools;

    let session = null;
    let prompt = blocks;
    if (reuseEligible) {
      const hit = this.conversations.lookup(key, fullText, model, Date.now());
      if (hit) {
        const existing = this.sessions.acquireExisting(key, hit.entry.poolId, hit.entry.sessionId);
        if (existing) {
          // 复用成功：只发增量。模型已在原会话设置过（lookup 要求 model 一致）。
          session = existing;
          prompt = [{ type: 'text', text: hit.delta }];
        } else {
          // 承载会话的连接已不在池中/正忙/过期 → 丢弃条目，回退新建
          this.conversations.forget(key, hit.entry.poolId);
        }
      }
    }

    // 会话标识：账号亲和的粒度（同会话粘住同账号，见 _conversationId）
    const convId = this._conversationId(request, key);

    if (!session) {
      // 会话级账号亲和：同一会话粘住上次的账号（冷却时 acquire 内部自动回退轮转）
      session = await this.sessions.acquire(key, { needsTools: needsToolsFinal, preferredAccountId: this.convAccounts.get(convId) || null, convId });

      await prepareSession(session, { model, tools });
    }

    // 记下实际服务本请求的账号，作为该会话下次请求的亲和偏好。
    // 兜底路径（首选账号冷却/池满）换账号后，映射跟着实际走，保证
    // "粘住的永远是当前真正有缓存的那个账号"。会话缓存命中路径也刷新
    // LRU 顺序。
    this._setConvAccount(convId, session.accountId);

    // 终态标记：仅 onDone（自然结束）置 true，用于决定是否把本次完整文本
    // 记入会话亲和缓存（超时/出错/中断时后端上下文状态不确定，不复用）。
    // state 供 finally 的分段耗时汇总读取 firstOutputAt/startedAt。
    const outcome = { completed: false, state: null, modelFallbackUsed: false };
    const acquireMs = Date.now() - t0; // 会话就绪耗时（新建/复用 + setModel + 委托工具注册）

    // 客户端断开：不立即取消 WorkBuddy 任务（会丢弃已生成输出，触发客户端
    // "discarded before streaming retry"），改为宽限期后延迟取消；
    // 期间客户端重连（同 key 新请求到达）则撤销取消。
    let aborted = false;
    // request-context（批C）：本次 HTTP 请求身份的唯一 owner，自此贯穿 B/C 与
    // 挂起/收尾各层——各层签名不再散装重复这些字段。
    const ctx = buildRequestContext({
      key, res, isAborted: () => aborted, clientModel, protocol,
      thinkingEnabled: request.thinkingEnabled, includeUsage, outcome, tools
    });
    const onClose = () => {
      if (ctx.res && ctx.res.writableEnded) return;
      aborted = true;
      // 活真相：续写自愈会把 state 三件套替换为新会话（旧池已 discard）——
      // 按旧会话取消会漏掉续写中的新会话（僵尸任务继续烧积分）。
      const live = ctx.outcome.state;
      this._scheduleDisconnectCancel(ctx.key, live?.client ?? session.client, live?.sessionId ?? session.sessionId);
    };
    if (res && typeof res.on === 'function') {
      res.on('close', onClose);
    }

    try {
      if (stream) {
        await this._handleStreamingResponse({
          session, prompt, model, ctx,
          rawMessages: resolved
        });
      } else {
        const result = await this._handleNonStreamingResponse({ session, prompt, model, ctx });
        return result;
      }
    } finally {
      if (res && typeof res.off === 'function') {
        res.off('close', onClose);
      }
      // 若流已结束（非挂起状态），释放连接。
      // 归属用"活真相"：续写自愈后 state 三件套是新会话，释放/记账必须跟着走
      // （按旧池 release 会 no-op 掉，新池则永久 busy 到空闲回收）。
      const live = outcome?.state;
      const liveSessionId = live?.sessionId ?? session.sessionId;
      const livePoolId = live?.poolId ?? session.poolId;
      if (!this.pending.has(key)) {
        if (reuseEligible) {
          if (outcome.completed && !aborted) {
            this.conversations.remember(
              key,
              { sessionId: liveSessionId, poolId: livePoolId, model },
              fullText,
              Date.now()
            );
          } else {
            this.conversations.forget(key, livePoolId);
          }
        }
        this.sessions.release(key, livePoolId);
      }

      // 分段耗时汇总：acquire / 首输出 / 总耗时一条日志看全（诊断不再依赖 JSONL 取证）
      const st = outcome?.state;
      const status = aborted ? 'aborted' : outcome?.completed ? 'completed' : this.pending.has(key) ? 'pending' : 'error';
      const firstOutputMs = st?.firstOutputAt ? `${st.firstOutputAt - st.startedAt}ms` : '-';
      const wedge = st?.wedgeReason ? ` wedge=${st.wedgeReason}` : ''; // 假死触发类别（first-token/mid-stream）
      console.log(
        `[buddy2api] req done key=${key} model=${outcome?.model || model} stream=${stream} status=${status} ` +
        `acquireMs=${acquireMs} firstOutputMs=${firstOutputMs} totalMs=${Date.now() - t0}ms${wedge}`
      );
    }
  }

  /**
   * 续跑挂起的 ACP 流：回传工具结果后继续消费。
   */
  async _continuePending(key, messages, model, stream, res, includeUsage = false) {
    const state = this.pending.get(key);
    const toolMsg = [...messages].reverse().find(m => m.role === 'tool');
    const resultText = this._messageToText(toolMsg) || 'Tool executed.';
    // 工具结果入挂起态（F-fix3 重放素材）：续跑回合停滞自愈时，换进程重放必须
    // 携带模型正在等待的工具结果——只提交给 CLI 不够，自愈段是新会话无此上下文。
    if (state.toolCall) state.toolCall.resultText = resultText;

    try {
      // 响应 _codebuddy.ai/delegateTool 请求（JSON-RPC result）
      await state.client.respondToToolCall(state.toolCall.reqId, resultText);
    } catch (e) {
      this.pending.delete(key);
      throw new Error(`Failed to submit tool result: ${e.message}`);
    }

    // 「正在回传中」用独立标志表达，**不置空 toolCall**。两个原因：
    // (1) queue-policy 的静默空结果检测把 toolCall 当"本次有产出"的证据
    //     （见 queue-policy.js hasToolCall）——续跑期间置空它，会让一个正常
    //     续跑被误判成频控空结果 → 退避重试 → 重复计费；
    // (2) toolCall 保留着续跑完成后仍可诊断（reqId/名字）。
    state.resuming = true;

    // 客户端断开：不立即取消 WorkBuddy 任务（同首轮路径），宽限期后延迟取消
    let aborted = false;
    // 续跑的 request-context：协议/思考决策/工具来自挂起条目（随 pending 走，
    // 续跑不重读 env——I4），身份字段（key/res）来自本次 HTTP 请求。
    const ctx = buildRequestContext({
      key, res, isAborted: () => aborted,
      clientModel: state.clientModel,
      protocol: state.protocol === 'anthropic' ? 'anthropic' : 'openai',
      thinkingEnabled: state.thinkingEnabled,
      includeUsage, tools: state.tools
    });
    const onClose = () => {
      if (ctx.res && ctx.res.writableEnded) return;
      aborted = true;
      this._scheduleDisconnectCancel(ctx.key, state.client, state.sessionId);
    };
    if (res && typeof res.on === 'function') {
      res.on('close', onClose);
    }

    try {
      return await this._consumePending({ state, model, stream, ctx });
    } finally {
      if (res && typeof res.off === 'function') {
        res.off('close', onClose);
      }
    }
  }

  // ===== 后端工具风味选择 =====

  /**
   * 判断错误是否是"后端连接类"错误（代理自身后端进程死亡/端口拒绝/流被掐断）。
   * 这类错误与账号无关——不该触发账号冷却（误冷却 60s 会让后续请求全部
   * 路由到其他账号，放大故障面）。实测场景：空闲回收器竞态误杀活跃后端。
   */
  _isBackendConnError(msg) {
    return isBackendConnErrorMessage(msg); // 定义在 error-classifier.js（分类学单点）
  }

  /**
   * 错误分类单点（三条消费路径的 catch 段共用）。
   *
   * 动机：`isWedgeError(error) || this._isBackendConnError(error?.message)` 这个组合
   * 表达式此前在三条路径里各写一份（A `_consumePending` / B `_handleStreamingResponse` /
   * C `_handleNonStreamingResponse`），漂移后没有任何断言会变红——两份各自"看起来对"的实现
   * 可以共存。这三处现改调本方法，规则只有一份定义（由 `tests/error-classifier.test.js`
   * 表驱动锁定 + `tests/handler-path-contract.test.js` 的 BC-7 用例锁调用面）。
   *
   * ⚠ 覆盖面（2026-09-26 候选②起三处已统一，但**仍须一起核对**）：另有两处等价判定
   * 现已改为引用本方法/同一谓词，不再是独立字面拷贝——
   *   - `_continueAfterWedge` 续写段 catch（第四种清理形态，改调 `_classifyError`）；
   *   - `_prepareModelFallback` 内联（原 `isWedgeError` 的展开，改调 `isWedgeError`）。
   * 改动 `isWedgeError` 的判定面时，这三处**必须一起核对**。
   *
   * **本方法是纯判定**：无 IO、无 state 写入、**无清理动作**。清理动作的**相对次序**
   * 仍留在各路径原地（A/B/C 三段的动作次序互不相同；把次序当参数注入即已否决的方案 B，
   * 见 `refactor-plan.md` §步骤 3）。调用方拿到结果后自行决定何时清挂起 / 丢后端 /
   * 上报账号健康。
   *
   * @param {Error & {statusCode?: number}} error
   * @returns {{wedge: boolean, connError: boolean}} wedge = 首 token 假死；
   *   connError = 假死 ∪ 后端连接类（假死视同后端问题：二者都不冷却账号）
   */
  _classifyError(error) {
    return classifyError(error); // 定义在 error-classifier.js（分类学单点）
  }

  // （_pickFallbackModel 已迁 model-policy.js——回退排序纯函数，批1；:748 调用点直连）

  /**
   * 假死处置单点（首 token 零输出 / 输出后中途停滞，三条消费路径的 onTimeout 共用）：
   * 取消上游任务 + 物理丢弃假死后端。禁止 release/invalidate 归还——归还后
   * convPools 亲和会让客户端重试确定性落回同一假死后端，形成雪崩（根因第 2 层）。
   *
   * 本方法是 handler 侧**适配器**：供给 handler 作用域的告警文案 + 阈值常量
   *（`STREAM_*_TIMEOUT_MS`）+ 实例绑定（sessions.discardPool），把纯处置序列委派给
   * finalizer.js 的 `disposeWedge`（#8 楔形尾收敛；与 connError 处置并列）。
   * 传 `state` 时同步置 `wedgeReason`（三路径此前各自内联的重复行）。
   */
  _discardWedgedBackend(key, client, sessionId, poolId, reason = STALL_REASON.FIRST_TOKEN, state = null) {
    const threshold = reason === STALL_REASON.MID_STREAM ? STREAM_STALL_TIMEOUT_MS : STREAM_FIRST_TOKEN_TIMEOUT_MS;
    console.warn(`[buddy2api] Wedge timeout (${reason}, no user-visible output > ${threshold}ms) for key=${key}; discarding wedged backend`);
    disposeWedge({
      cancel: () => client?.cancelPrompt?.(sessionId).catch(() => {}),
      discardBackend: (url) => this.sessions.discardPool(key, url),
      url: poolId,
      reason,
      state
    });
  }

  /**
   * 客户端已断开时的请求终结：不写 wire（对端已走），但要记账 + 置 finalized。
   * finalized 是关键——否则 queue-policy 会把「零输出的已终结请求」当静默空结果，
   * 合成 429 退避并对已断开的客户端重跑整条 prompt（幽灵请求 + 误冷却账号）。
   */
  _finalizeAborted(state, model) {
    markFinalized(state); // queue-policy 不再合成静默失败重试（幽灵重跑闸，attempt.js 单点）
    // 中止发生在 mid-stream 假死语境时升格标记：尾部不得再把它误报为「续写成功」
    promoteWedgeReason(state, 'mid-stream-aborted');
    this._recordUsage(state, model, { stream: true, status: 'aborted' });
    return null;
  }

  /**
   * mid-stream 停滞的报错收尾（三条失败路径共用：续写不可用/续写失败/二次停滞）。
   * 错误形状按协议分派——Anthropic 走 `event: error`（每载荷带顶层 `type`），
   * OpenAI 走 `data:{"error":…}` + `[DONE]`（历史真 bug，见 first-token-guard spec）。
   */
  _finalizeMidStreamError(state, sink, protocol, model, lastError = null, outcome = null) {
    markFinalized(state); // 请求已终结：queue-policy 不再做静默失败重试
    state.wedgeReason = 'mid-stream-failed'; // 明确失败收尾（不得被误报为「续写成功」）
    // 记账保留真实错误（JSONL 诊断用；该字段不经 isRateLimited 判定）
    this._recordUsage(state, model, { stream: true, status: 'error', error: lastError || 'mid-stream timeout' });
    let message = firstTokenTimeoutError(Boolean(outcome?.modelFallbackUsed), STALL_REASON.MID_STREAM).message;
    if (state.continuedCount > 0) {
      // 措辞刻意避开 isRateLimited 识别词（否则会被误当频控进 17.5 分钟退避）
      const sec = Math.round(STREAM_STALL_TIMEOUT_MS / 1000);
      message = `WorkBuddy 响应中途停滞（${sec}s 无输出，疑似后端假死，已回收该后端）；已尝试续写 ${state.continuedCount} 次仍失败，请重试。`;
    }
    // 帧写出已下沉 sink（终态帧词汇，批3）：Anthropic 发 event: error（C6 事件序），
    // OpenAI 发 data:error + [DONE]。Anthropic 分支的 try/catch 保留（客户端已断开时
    // write 会抛，不得冒泡改写处置——与 catch 路径同口径）。
    // 协议分派委托策略（架构深化第十一批 C2）
    this._strategy(protocol).buildStreamError(sink, message);
    return null;
  }

  /**
   * 中途停滞续写自愈（首轮流式路径，首次停滞调用）。
   *
   * 已流出内容无法收回、重发必然重复——所以不是"重试"，而是**续写**：
   * 以「原始历史 + 已流出半成品（assistant）+ 续写指令（不重复已有内容）」在新后端
   * 重放，续写段的增量继续写进**同一条 SSE 流**（客户端无断连、无重复）。
   * 每请求至多 MAX_CONTINUATIONS 次（state.continuedCount 门禁）；续写段停滞由
   * onTimeout 闭包再次进入本方法（递归至多 3 层），超限落到 _finalizeMidStreamError。
   * `degraded`（末次续写，门禁处置位）：换向量而非重掷——needsTools:false 后端 +
   * 不注册委托工具 + 降级专用指令（bugfix-20260922-stall-rootcure）。
   */
  async _continueAfterWedge({ state, sink, ctx, model, outcome = null, degraded = false }) {
    return continueAfterWedge(
      { state, sink, ctx, model, outcome, degraded },
      {
        sessions: this.sessions,
        prepareSession,
        RETRY_PREPARE_POLICY,
        sanitizePrompt,
        classifyError: (e) => this._classifyError(e),
        buildPrompt: (msgs) => this._buildPrompt(msgs),
        runWithRetry: (opts) => this._runWithRateLimitRetry(opts),
        finalizeMidStream: (s, sk, p, m, e, o) => this._finalizeMidStreamError(s, sk, p, m, e, o),
        finalizeAborted: (s, m) => this._finalizeAborted(s, m),
        pendingHas: (key) => this.pending.has(key)
      }
    );
  }

  /**
   * 模型/后端失败后的自动重试（每请求最多一次）：
   * - 后端连接类错误 → 同模型换新后端重试
   * - 其他错误（模型服务异常等）→ 按优先级挑回退模型重试
   * 仅当尚未向客户端输出任何内容时才重试（已输出则原样报错，避免重复/截断）。
   * 重试标记挂**请求级 outcome 盒**（同一盒贯穿递归重试链），递归调用天然只重试一次；
   * 不得移入 attempt state——递归重入会 seed 新 state，跨 attempt 记忆会丢（审视 F5）。
   *
   * @returns {Promise<{session, model}|null>} null = 不重试；否则返回新会话与新模型
   */
  async _prepareModelFallback(state, model, error, outcome, key) {
    // 回退标记挂**请求级** outcome 盒（同一对象贯穿递归重试链，天然只重试一次）。
    // 不得移入 attempt state——递归重入会 seed 新 state，跨 attempt 记忆会丢，
    // wedge→fallback→再 wedge 失去唯一闸（独立审视 F5）。
    if (outcome?.modelFallbackUsed) return null;
    // 已向客户端输出则不重试（重复/截断）。口径是「客户端可见」，两道闸互补：
    // ① streamEmitted（sink 写出 message_start/首个分片时置位，是「流已开」的唯一真相）
    //    ——绝对闸：盖住 Anthropic thinking-only 盲区（thinking_delta 有意不累加进
    //    reasoning，content/reasoning 看不到它，见 anthropic-sink.js）；此时重试会
    //    再发一条消息 → 违反事件序 C1，严格 SDK 直接解析失败。
    // ② 流式且已累积 content/reasoning（增量即发即达，客户端已见）→ 不重试。
    // ③ 非流式（stream=false）内容只累积在内部、响应尚未写出 → 重发自愈对客户端
    //    不可见，允许自愈一次（本任务 AC：非流式假死可换后端重发）。
    if (state.streamEmitted) return null;
    if (state.stream && (state.content || state.reasoning)) return null;
    const errMsg = error?.message || String(error || '');
    // 首 token 假死 = 后端问题（与模型无关）：同模型换新后端重试。
    // 判定引用 isWedgeError 单点（2026-09-26 候选②：原为 name 的字面展开）
    const wedge = isWedgeError(error);
    const connError = wedge || this._isBackendConnError(errMsg);
    const retryModel = connError
      ? model // 后端问题与模型无关：同模型换新后端
      : pickFallbackModel(this.sessions.getModels(key), model);
    if (!retryModel) return null;
    if (outcome) outcome.modelFallbackUsed = true;
    console.warn(`[buddy2api] ⚠ 请求失败（${errMsg}），${connError ? '换新后端' : `自动回退模型 ${model} → ${retryModel}`} 重试`);
    const retrySession = await this.sessions.acquire(key, {
      needsTools: true, // 超集：聊天/带工具请求都可用（回退是低频路径，正确性优先）
      modelId: retryModel,
      preferredAccountId: state.accountId
    });
    try {
      // 委托工具按 sessionId 注册 → 换新会话必须重注册；否则带 tools 的请求在
      // 首 token 假死自愈后，重试会话调不到客户端工具（静默退化为纯文本，无报错）。
      await prepareSession(retrySession, {
        ...RETRY_PREPARE_POLICY,
        model: retryModel,
        tools: state.tools,
        label: '重试会话'
      });
    } catch (e) {
      // setModel 失败 = 回退模型也不可用（会话会留在默认模型上静默计费）→ 放弃重试
      this.sessions.discardPool(key, retrySession.poolId);
      throw new Error(`回退模型 ${retryModel} setModel 失败：${e.message}`);
    }
    return { session: retrySession, model: retryModel };
  }

  /**
   * 模型回退「恰一次重试」闸——B/C 两路径 catch 块的控制流单点（架构深化第 8 批 C4）。
   *
   * 收拢的是「prepare → outcome.model 回写 → 换 fallback 会话重跑一次 →
   * pending 守卫 release / 失败 invalidate」这段结构重复的流程；两路径的
   * **参数差异**（B 的 includeUsage/retrying/rawMessages、C 的无）由调用点的
   * retry 闭包具名补齐——结构同构 ≠ 逐字相同（独立审视 F1：差异共三处参数
   * 与行数 27/24，等价性判定按结构同构口径而非逐字 diff）。返回判别形态，
   * `error = retryErr` 的**覆写留在调用 catch 原地**：两路径重试失败后的处置段
   * 不同（流式按协议发错误帧 / 非流式 wedge→504 rethrow），覆写进 helper 会
   * 丢掉「覆写后走各自处置」的可见性（独立审视 F17）。
   *
   * @param {object} args
   * @param {object} args.state attempt state
   * @param {string} args.model 失败的模型
   * @param {Error} args.error 触发回退的原始错误
   * @param {object|null} args.outcome 请求级回退闸（outcome.model 回写汇总日志）
   * @param {string} args.key 会话隔离键
   * @param {(fallback: object, base: object) => Promise} args.retry 换会话重跑：
   *   base 是两路径共用的重试实参（session/prompt/model 等取自 fallback 与 state，
   *   与两路径 seed 的同名字段同源），调用点展开后补齐各自差异字段
   * @returns {Promise<{ok: true, result: *}|{ok: false, error: Error}>}
   *   ok=true → 重试成功，result 即路径返回值（调用点直接 return）；
   *   ok=false → 无回退可用或重试也失败，error 为**应继续处置的错误**
   *   （无 fallback 时 = 原始错误；重试失败时 = retryErr，更有信息量）
   */
  async _retryOnceWithFallback({ state, model, error, outcome, key, retry }) {
    const fallback = await this._prepareModelFallback(state, model, error, outcome, key).catch(() => null);
    if (!fallback) return { ok: false, error };
    if (outcome) outcome.model = fallback.model; // 汇总日志反映实际模型
    try {
      // base = attempt 级重试实参（fallback 会话 + state.prompt + 回退模型）；
      // request 级身份由调用点的 ctx 携带（批C），路径差异字段亦在调用点补齐。
      const result = await retry(fallback, {
        session: fallback.session,
        prompt: state.prompt,
        model: fallback.model
      });
      if (!this.pending.has(key)) this.sessions.release(key, fallback.session.poolId);
      return { ok: true, result };
    } catch (retryErr) {
      this.sessions.invalidate(key, fallback.session.poolId);
      return { ok: false, error: retryErr };
    }
  }

  // （_prepareSession / _needsTools 已迁 session-prepare.js——会话准备 seam 单点，批3；
  //   三处调用点与两处 needsTools 判断点直连，D6 不变式改指向新模块）

  // ===== 排队/频控（策略在 queue-policy.js；保留薄包装维持测试注入点） =====

  /**
   * 退避延迟计算（可被测试覆盖为短值）。
   */
  _rateLimitDelayMs(attempt) {
    return rateLimitDelayMs(attempt);
  }

  /**
   * 执行 prompt 事件流，遇到频控/排队时退避重试（排队机制）。
   * 策略实现见 queue-policy.runWithRateLimitRetry；此处只注入
   * pending 状态访问（hasPending）与测试可覆盖的退避计算。
   * key / isAborted 经 ctx 携带（批C）。
   *
   * @returns {Promise<*>} driver.run() 的返回值
   */
  _runWithRateLimitRetry({ client, sessionId, prompt, sink, state, ctx }) {
    return runWithRateLimitRetry({
      key: ctx.key, client, sessionId, prompt,
      isAborted: ctx.isAborted, sink, state,
      hasPending: () => this.pending.has(ctx.key),
      delayMsFn: (attempt) => this._rateLimitDelayMs(attempt)
    });
  }

  // ===== 三条消费路径（sink 由 sink-factory 装配） =====

  /**
   * 消费挂起的流直到结束或下一个工具调用。
   * 与首轮两条路径共用 StreamDriver + sink 工厂；差异（超时与结束的
   * 响应形态、清理动作）由注入的 onTimeout/onDone 表达。
   */
  async _consumePending({ state, model, stream, ctx }) {
    // 协议随挂起条目走：挂起时记下的协议决定这次续跑按哪种 wire 回写
    //（_continuePending 构造 ctx 时已按 state.protocol 归一）
    const protocol = ctx.protocol;
    const completionId = this._newMessageId(protocol);
    const created = Math.floor(Date.now() / 1000);
    // 逐 attempt 展开（批C）：completionId/created/model 是 attempt 级身份，
    // 挂起/收尾各层经 actx 读取——request 级字段（key/res/决策）原样透传。
    const actx = { ...ctx, completionId, created, model };
    const key = ctx.key;

    // 挂起续跑沿用已积累的内容；后续增量直接写回 state（修复多轮工具调用
    // 时 content 丢失的隐患——旧代码复制到局部 output 后从不回写 state）。
    const baseState = state;
    const write = resWriter(ctx.res);

    if (stream) {
      ctx.res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive'
      });
      this._writeStreamPreamble(protocol, write, completionId, created, model);
    }

    const sink = this._createSink(protocol, {
      emit: stream ? 'stream' : 'accumulate',
      state: baseState, key, completionId, created, model, res: ctx.res,
      onToolCall: (toolEvent) => this._suspendForToolCall(baseState, toolEvent, { stream, sink, ctx: actx }),
      onTimeout: (reason = STALL_REASON.SOFT) => {
        if (reason === STALL_REASON.FIRST_TOKEN || reason === STALL_REASON.MID_STREAM) {
          // 续跑路径已有内容（AC-4）：取消 + 丢弃假死后端。处置顺序（F-fix3）：
          // ①有重放素材且一次性自愈闩未置位 → 换进程续写自愈（上限 1，不递归）；
          // ②否则诚实报错收尾（resumeWedgeTimeoutError——不谎称换后端重试）。
          // discard 必须替代下方 soft 分支的 release 归还：假死后端归还会被
          // convPools 亲和再次取回（雪崩根因）。wedgeReason 置位为汇总日志诊断字段
          //（汇总不覆盖续跑请求，留 JSONL 检索用）——统一在 disposeWedge 内完成。
          this._discardWedgedBackend(key, baseState.client, baseState.sessionId, baseState.poolId, reason, baseState);
          if (
            stream &&
            !baseState.wedgeResumed &&
            !ctx.isAborted?.() &&
            this._canResumeAfterWedge(baseState)
          ) {
            baseState.wedgeResumed = true; // 一次性闩：自愈段再停滞不再重入（不递归）
            return this._resumePendingAfterWedge({ state: baseState, sink, ctx: actx, model });
          }
          this.pending.delete(key);
          markFinalized(state); // 请求已终结：queue-policy 不再做静默失败重试
          state.wedgeReason = 'mid-stream-failed'; // 自愈已尝试仍失败：与 B 路径失败收尾同标（JSONL 检索面）
          this._recordUsage(baseState, model, { stream, status: 'error', error: `${reason} timeout` });
          const err = resumeWedgeTimeoutError(reason, Boolean(baseState.wedgeResumed));
          if (stream) {
            // 流式：headers 已发出，只能以流内错误收尾（HTTP 200 内）。
            // 终态帧词汇（批3）：Anthropic 发 event: error（C6），OpenAI 发 data:error + [DONE]。
            sink.abortWithError(err.message);
            return null;
          }
          err.statusCode = 504;
          throw err;
        }
        console.warn(`[buddy2api] Pending stream soft timeout (${STREAM_SOFT_TIMEOUT_MS}ms) for key=${key}`);
        this.pending.delete(key);
        markFinalized(state); // 请求已终结：queue-policy 不再做静默失败重试
        this._recordUsage(baseState, model, { stream, status: 'timeout' });
        if (stream) {
          if (protocol === 'anthropic') {
            sink.finish({ stopReason: 'end_turn', notice: '\n\n[WorkBuddy 响应超时]' });
          } else {
            if (baseState.content) {
              write(sseChunk(completionId, created, model, { content: '\n\n[WorkBuddy 响应超时]' }, 'stop'));
            }
            write(sseChunk(completionId, created, model, {}, 'stop'));
            if (actx.includeUsage) write(sseUsageChunk(completionId, created, model, buildUsage(baseState.usage)));
            write(SSE_DONE);
            ctx.res.end();
          }
          // 与非流式分支对齐：连接释放回池（_takeIdlePool 有 hasInflightPrompt
          // 守卫，后端若还在跑旧任务不会被复用），否则池里少一个可用连接。
          this.sessions.release(key, baseState.poolId);
          return null;
        }
        // 非流式：把已积累的内容作为最终响应返回，而不是挂住客户端
        this.sessions.release(key, baseState.poolId);
        return this._buildFinalResponse(baseState, completionId, created, model);
      },
      onDone: () => {
        this.pending.delete(key);
        markFinalized(state); // 请求已终结
        this.sessions.reportAccountHealth(baseState.accountId, { ok: true });
        this.sessions.release(key, baseState.poolId);
        this._recordUsage(baseState, model, { stream, status: ctx.isAborted?.() ? 'aborted' : 'completed' });
        if (stream) {
          this._writeStreamFinish({
            sink, write,
            usage: baseState.usage, // 续跑：活真相在 baseState（续写自愈会替换 state 三件套）
            ctx: actx
          });
          return null;
        }
        return this._buildFinalResponse(baseState, completionId, created, model);
      }
    });

    try {
      return await this._runWithRateLimitRetry({
        client: state.client, sessionId: state.sessionId,
        prompt: state.prompt, sink, state, ctx
      });
    } catch (error) {
      // 流异常：清挂起 + 丢连接（与首轮路径一致），避免挂起表泄漏。
      // 连接类错误 = 代理自身后端问题：丢弃死后端（而非归还），且不误冷却账号。
      // 首 token 假死视同后端类错误：不冷却账号、invalidate 定位失败自然 no-op
      //（头/尾簇已收 finalizer.js 单点，批4；中间段次序留本路径原地）
      const { wedge, connError } = disposeConnError({ pending: this.pending, sessions: this.sessions, key, poolId: baseState.poolId, error });
      console.error('Pending stream error:', error);
      this._recordUsage(baseState, model, { stream, status: 'error', error: error.message });
      releaseAfterError({ pending: this.pending, sessions: this.sessions, key, poolId: baseState.poolId, accountId: baseState.accountId, error, connError });
      // C6（续跑路径）：Anthropic 流内错误必须发 `event: error` 并终止流。
      // 只 throw 不 abortWithError → 异常冒泡到 index.js 的裸 res.end()，
      // 客户端收到的是「HTTP 200 + 干净截断的 SSE」——SDK 既不报错也不返回，
      // 表现为挂死。首轮路径在同一位置已有同一处置（见 _handleStreamingResponse）。
      // 此处 stream 为真时 headers 早已发出，HTTP 状态码已不可改（只能流内收尾）。
      if (stream && protocol === 'anthropic') {
        try {
          sink.abortWithError(error.message);
        } catch (e) { /* client gone */ }
      }
      if (wedge) error.statusCode = 504;
      throw error;
    }
  }

  /**
   * 续跑一次性自愈的资格判定（F-fix3）：重放素材齐备——原始历史（originalRawMessages，
   * B 路径种子随挂起态透传）+ 工具结果（_continuePending 存入 toolCall.resultText）。
   * 缺任一即无素材，落诚实报错（不凭空编造上下文）。
   */
  _canResumeAfterWedge(state) {
    const history = state.originalRawMessages || state.rawMessages;
    return Boolean(history?.length && state.toolCall?.resultText);
  }

  /**
   * A 路径 wedge 的一次性续写自愈（bugfix-20261020-hydrate-stall F-fix3）。
   *
   * 事故实证：CLI 进程级消费退化下，A 路径复用的旧进程正是最可能再停滞的资源，
   * 而 B 路径的换进程续写在同一会话上实测救回（17:50→18:01 成功段）。本方法把同一
   * 机制延伸到续跑回合——**上限 1，不递归**（调用点 wedgeResumed 闩 + 自愈段停滞
   * 落诚实报错）。与 B 路径 _continueAfterWedge 的差异：重放素材额外携带工具结果
   *（模型等待的正是它）；成功/失败都由共享 sink 在同一流上收尾。
   */
  async _resumePendingAfterWedge({ state, sink, ctx, model }) {
    const { key } = ctx;
    console.warn(`[buddy2api] 续跑回合停滞自愈（key=${key}）：换进程重放（一次性，含工具结果）`);
    // 关闭旧楔死迭代器（与 continuation.js 同契约）：不关会挂到 _iterSse 的
    // 30 分钟空闲兜底——白留一条噪声日志 + 一个挂起 POST（CR 怀疑者轴实抓）
    state.iterator?.return?.().catch?.(() => {});

    const messages = [...(state.originalRawMessages || state.rawMessages)];
    if (state.content) messages.push({ role: 'assistant', content: state.content });
    messages.push({
      role: 'user',
      content: `Tool "${state.toolCall.name}" executed. Result:\n${state.toolCall.resultText}\n\n` + CONTINUE_INSTRUCTION
    });

    // usage 滚动合并（与 continuation.js sinkProxy 同契约）：共享 sink 的 onUsage 是
    // setUsage（覆盖语义）——自愈段直接复用会把楔死前首段的 usage 整体覆盖（CR 实抓）。
    // 只遮蔽 onUsage，其余处理器按展开共享同一闭包，不新建 sink——同一条流。
    const firstUsage = { ...state.usage };
    const sinkProxy = { ...sink, onUsage: (usage) => mergeUsage(state, firstUsage, usage) };

    let nextSession = null;
    try {
      // 超集口径（与 _prepareModelFallback 同理由）：自愈是低频路径，正确性优先
      nextSession = await this.sessions.acquire(key, {
        needsTools: true, modelId: model, preferredAccountId: state.accountId
      });
      await prepareSession(nextSession, {
        ...RETRY_PREPARE_POLICY,
        model,
        tools: state.tools, // 委托工具按 sessionId 注册 → 换新会话必须重注册
        label: '续跑自愈段'
      });
    } catch (e) {
      console.warn(`[buddy2api] 续跑自愈 acquire/setModel 失败：${e.message}`);
      if (nextSession) this.sessions.discardPool(key, nextSession.poolId);
      return this._finalizeResumeFailure(state, sink, ctx, model, e);
    }

    if (ctx.isAborted?.()) {
      this.sessions.discardPool(key, nextSession.poolId);
      return this._finalizeResumeFailure(state, sink, ctx, model, new Error('client aborted during resume'));
    }

    // 三件套替换（旧池已 discard）：收尾 / 工具挂起 / 再停滞处置按新会话定位
    bindConnection(state, {
      client: nextSession.client,
      sessionId: nextSession.sessionId,
      poolId: nextSession.poolId,
      accountId: nextSession.accountId
    });
    const prompt = sanitizePrompt(buildPrompt(messages));
    // state.prompt / rawMessages 同步为自愈版：自愈段若再挂起工具，下一轮回传重放这份
    setContinuationContext(state, { prompt, rawMessages: messages });

    try {
      await this._runWithRateLimitRetry({
        client: state.client, sessionId: state.sessionId,
        prompt, sink: sinkProxy, state, ctx
      });
    } catch (e) {
      // 与 B 路径续写段 catch 同口径：出错的新池不得 release 回池（串台源）
      const { connError } = this._classifyError(e);
      if (connError) {
        this.sessions.discardPool(key, state.poolId);
      } else {
        this.sessions.reportAccountHealth(state.accountId, { ok: false, reason: e.message });
        this.sessions.invalidate(key, state.poolId);
      }
      state.lastStreamError = e?.message || String(e);
      return this._finalizeResumeFailure(state, sink, ctx, model, e);
    }
    return null;
  }

  /**
   * 自愈失败的诚实收尾：清挂起 + finalized + 流内错误终止。措辞按 wedgeResumed
   * 两档（CR Standards 轴）：自愈未发生=「续跑回合不做自动重试」；自愈已发生且失败=
   * 「已尝试换进程自愈 1 次仍失败」。wedgeReason 升格 mid-stream-failed（JSONL 检索
   * 可区分「自愈失败」与「从未自愈」）。
   */
  _finalizeResumeFailure(state, sink, ctx, model, error) {
    this.pending.delete(ctx.key);
    markFinalized(state);
    state.wedgeReason = 'mid-stream-failed';
    this._recordUsage(state, model, { stream: true, status: 'error', error: error?.message || 'resume wedge timeout' });
    try {
      sink.abortWithError(resumeWedgeTimeoutError(STALL_REASON.MID_STREAM, Boolean(state.wedgeResumed)).message);
    } catch { /* client gone */ }
    return null;
  }

  /**
   * attempt state 种子——实现已拆到 attempt.js（seedAttemptState 单点，候选①）；
   * 方法保留维持调用面与 tests/attempt-state-seed.test.js 的锁定入口。
   * 「A 不参与 / B·C 差异必须是调用点具名实参 / 首次 await 前就位」三契约见 attempt.js。
   *
   * @param {object} fields 调用点提供的字段（含两路径各自的差异取值）
   * @returns {object} 完整 state
   */
  _seedAttemptState(fields) {
    return seedAttemptState(fields);
  }

  /**
   * Handle streaming response（首轮，新建会话）
   *
   * 请求身份（key/res/clientModel/protocol/thinkingEnabled/includeUsage/outcome/
   * isAborted/tools）经 `ctx`（buildRequestContext，批C）进入；本路径签名只剩
   * attempt 级字段：session/prompt/model + retrying/rawMessages（B 特有）。
   *
   * @param {object} params
   * @param {object} params.ctx request-context（含 BC-12 协议感知默认，工厂单点）
   * @param {boolean} [params.retrying] 模型回退重试：复用同一 res，不重复流首
   * @param {Array|null} [params.rawMessages] 原始 messages（续写自愈的重放素材）
   */
  async _handleStreamingResponse({ session, prompt, model, ctx, retrying = false, rawMessages = null }) {
    const { key, res, clientModel, protocol, thinkingEnabled, includeUsage, tools, isAborted } = ctx;
    // 回退闸（modelFallbackUsed）挂在 outcome 上且须贯穿递归重试链——调用方未提供
    // （测试桩形态）时归一为本地盒，保证「恰一次」闸在本路径内仍然成立（审视 F5）。
    // 外部调用方的原 outcome（null 或其自有盒）不受影响：赋值只发生在本函数局部。
    // （批C：outcome 自 ctx 解构为 const，本地归一改用表达式——不可对解构绑定赋值）
    const outcome = ctx.outcome || {};
    const completionId = this._newMessageId(protocol);
    const created = Math.floor(Date.now() / 1000);
    // 逐 attempt 展开（批C）：挂起/收尾各层经 actx 读取 attempt 级身份
    const actx = { ...ctx, completionId, created, model };
    // 模型回退重试时复用同一个 res：响应头与 role chunk 已在首次尝试写出，
    // 重复 writeHead 会抛 ERR_HTTP_HEADERS_SENT（被 catch 吞掉后回退静默失败）。
    // 除 retrying 标志外再看一次 res.headersSent：标志是调用方的约定，headersSent
    // 是运行时事实。两者不一致时（新增调用点忘传 retrying）以事实为准，否则
    // writeHead 抛错会被上层 catch 吞成"回退静默失败"，排查时看不到任何线索。
    if (!retrying && !res.headersSent) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive'
      });
    }

    const state = {
      ...seedConnectionState({
        key,
        protocol, // 'openai' | 'anthropic'：续跑时必须按挂起时的协议回写响应
        // Anthropic 响应回显客户端**原始**请求名（claude-* 被映射到默认模型是内部行为）
        echoModel: protocol === 'anthropic' ? clientModel : null,
        // thinking 可见性：路由层算好的决策（请求驱动），sink 只消费、不再读环境变量。
        // 存进 state 是 I4 不变式的落点——state 随 pending 表透传，续跑不重读 env。
        // 签名默认值必须是协议感知的 `protocol !== 'anthropic'`：本方法存在 router
        // 之外的直接调用方，若默认 false，「未提供」就被折成显式 false，直接调用方
        // 会静默失去思考（未被授权的行为变更）。
        thinkingEnabled: Boolean(thinkingEnabled),
        stream: true, // 客户端可见输出标记：_prepareModelFallback 用它区分「已输出」防重复
        client: session.client,
        sessionId: session.sessionId,
        clientModel, // 客户端原始请求值（记账 requestedModel 用，区别于实际使用的 model）
        poolId: session.poolId, // 连接池 ID，用于释放时精确定位本请求的连接
        accountId: session.accountId || null, // 后端绑定的账号（多账号池：上报健康用）
        tools // 客户端委托工具：续写段必须在新会话上重注册（按 sessionId 注册，见 _continueAfterWedge）
      }),
      ...this._seedAttemptState({
        prompt // 重试（429 频控退避）时需要重新 sendPrompt
      }),
      // ↓↓ B 独有（C 无「续写自愈」，故无此三件套）——刻意写在种子之外，使差异一眼可见
      rawMessages, // 原始 messages（远程图片已解析）：中途停滞续写自愈的重放素材。
      // ⚠ 此后 rawMessages 及其数组**不得原地修改**（push/splice）——续写会整体替换
      // 引用而非改写内容，originalRawMessages 快照依赖这一点。
      originalRawMessages: rawMessages, // 续写基准快照：每次续写一律基于它构造（无指令嵌套）
      continuedCount: 0 // 已续写次数（上限 MAX_CONTINUATIONS，续写段停滞 +1）
    };
    if (outcome) outcome.state = state; // 供 handleChatCompletions finally 的耗时汇总读取

    const write = resWriter(res);

    const sink = this._createSink(protocol, {
      emit: 'stream',
      state, key, completionId, created, model, res,
      onToolCall: (toolEvent) => this._suspendForToolCall(state, toolEvent, { stream: true, sink, ctx: actx }),
      onTimeout: (reason = STALL_REASON.SOFT) => {
        if (reason === STALL_REASON.FIRST_TOKEN || reason === STALL_REASON.MID_STREAM) {
          // 假死：处置单点（取消 + 丢弃 + 置 wedgeReason）。state.client/sessionId/poolId
          // 是活真相——续写自愈会把三件套替换为新会话，此处必须按 state 定位（闭包里的
          // session 在续写段停滞时已是被丢弃的旧会话）。wedgeReason 为汇总日志诊断字段
          //（自愈成功时随新 attempt 覆盖）。
          this._discardWedgedBackend(key, state.client, state.sessionId, state.poolId, reason, state);
          if (reason === STALL_REASON.MID_STREAM) {
            // 客户端已断开优先（含续写段二次停滞场景）：不续写、也不向已断开的
            // 客户端写错误（heartbeat 间隔 30s 远大于停滞阈值，此分支系统性可达）。
            // 必须记账 + 置 finalized：否则 JSONL 丢记录，且 finalized=false 会让
            // queue-policy 的空结果检测对已断开的请求合成 429 → 幽灵重跑 + 误冷却账号。
            if (isAborted?.()) return this._finalizeAborted(state, model);
            if (state.continuedCount >= MAX_CONTINUATIONS) {
              return this._finalizeMidStreamError(state, sink, protocol, model, state.lastStreamError, outcome);
            }
            return this._continueAfterWedge({
              state, sink, ctx: actx, model, outcome,
              // 末次续写（continuedCount 将达上限）降级换向量：不再带工具重掷
              //（!8 真机证明同向量重试无出路），needsTools:false + 降级指令。
              degraded: state.continuedCount === MAX_CONTINUATIONS - 1
            });
          }
          throw firstTokenTimeoutError(Boolean(outcome?.modelFallbackUsed), reason);
        }
        console.warn(`[buddy2api] Stream soft timeout (${STREAM_SOFT_TIMEOUT_MS}ms) for key=${key}`);
        markFinalized(state); // 请求已终结：queue-policy 不再做静默失败重试
        this._recordUsage(state, model, { stream: true, status: 'timeout' });
        if (protocol === 'anthropic') {
          sink.finish({ stopReason: 'end_turn', notice: '\n\n[WorkBuddy 响应超时，请重试]' });
        } else {
          write(sseChunk(completionId, created, model, { content: '\n\n[WorkBuddy 响应超时，请重试]' }, 'stop'));
          if (includeUsage) write(sseUsageChunk(completionId, created, model, buildUsage(state.usage)));
          write(SSE_DONE);
          res.end();
        }
        // 不 invalidate：连接本身可能没问题，只是这次请求慢（如上下文压缩）。
        // 取消按 state 三活真相（续写自愈后闭包 session 已是被丢弃的旧会话，
        // 照旧取消 = 续写段上游任务变僵尸继续烧积分）。
        state.client.cancelPrompt(state.sessionId).catch(() => {});
        return null;
      },
      onDone: () => {
        if (outcome) outcome.completed = true; // 自然结束：本次文本可记入会话亲和缓存
        markFinalized(state); // 请求已终结
        this._recordUsage(state, model, { stream: true, status: isAborted?.() ? 'aborted' : 'completed' });
        this._writeStreamFinish({
          sink, write,
          usage: state.usage, // 首轮：state 即本次尝试的活真相
          ctx: actx
        });
        this.sessions.reportAccountHealth(state.accountId, { ok: true });
        // 释放统一交给 handleChatCompletions 的 finally——这里再释放一次会造成
        // 双重归还：第二次会把刚被下一个请求占用的后端标回空闲（串台源）。
        return null;
      }
    });

    try {
      // 回退重试时不重复发流首：
      // - OpenAI 的 role chunk 已在首次尝试写出（重发还带不同 model 字段，语义混乱）
      // - Anthropic 的 message_start 由 sink 惰性发出（零输出才可能走到重试，
      //   此时尚未写过任何事件，惰性保证客户端只看到一条 message_start）
      if (!retrying) {
        this._writeStreamPreamble(protocol, write, completionId, created, model);
      }

      return await this._runWithRateLimitRetry({
        client: session.client, sessionId: session.sessionId,
        prompt, sink, state, ctx
      });
    } catch (error) {
      // 模型/后端失败自动回退：仅在尚未输出内容时重试一次（标记挂请求级 outcome 盒）。
      // 控制流收拢进 _retryOnceWithFallback 单点（C4）；参数差异（retrying /
      // rawMessages）在本调用点具名补齐。
      const attempt = await this._retryOnceWithFallback({
        state, model, error, outcome, key,
        retry: (fallback, base) => this._handleStreamingResponse({
          ...base,
          // outcome 盒随重试链传播（CR S1）：本层归一的盒（含 modelFallbackUsed 闸）
          // 必须带进重试 attempt——否则 ctx.outcome=null 的直接调用方每层重试
          // 都派生新空盒，「恰一次」闸永不落下 → 无界回退递归。
          ctx: { ...ctx, outcome },
          retrying: true, // retrying：复用同一 res，不重复 writeHead/流首
          rawMessages: state.rawMessages // 与 state.prompt 同源（续写后两者同步更新）
        })
      });
      if (attempt.ok) return attempt.result;
      error = attempt.error; // 重试也失败：展示重试的错误（更有信息量）

      // 首 token 假死视同后端类错误：丢弃死后端、不冷却账号（假死不是账号的错）
      //（头/尾簇已收 finalizer.js 单点，批4；本段只用 connError——wedge 在此无后续用途）
      const { connError } = disposeConnError({ pending: this.pending, sessions: this.sessions, key, poolId: state.poolId, error });

      console.error('Streaming error:', error);
      this._recordUsage(state, model, { stream: true, status: 'error', error: error.message });
      try {
        if (protocol === 'anthropic') {
          // C6：Anthropic 必须发 event: error 并终止流，否则 SDK 永远等下一条事件
          sink.abortWithError(error.message);
        } else {
          // OpenAI 现状：error 帧后直接 res.end()，无 [DONE]（逐字保持，审视 F7——
          // 与 _finalizeMidStreamError 的 [DONE] 差异是路径真实差异，勿统一）
          sink.abortWithError(error.message, { sseDone: false });
        }
      } catch (e) { /* client gone */ }
      releaseAfterError({ pending: this.pending, sessions: this.sessions, key, poolId: state.poolId, accountId: state.accountId, error, connError });
    }
  }

  /**
   * Handle non-streaming response（首轮，新建会话）
   *
   * 请求身份经 `ctx` 进入（同 _handleStreamingResponse 的批C 收拢）；本路径
   * 无特有参数，签名只剩 attempt 级的 session/prompt/model。
   */
  async _handleNonStreamingResponse({ session, prompt, model, ctx }) {
    const { key, res, clientModel, protocol, thinkingEnabled, tools, isAborted } = ctx;
    // 批C：outcome 自 ctx 解构为 const，本地归一改用表达式（不可对解构绑定赋值）
    const outcome = ctx.outcome || {}; // 回退闸（modelFallbackUsed）须贯穿递归——同流式路径（审视 F5）
    const completionId = this._newMessageId(protocol);
    const created = Math.floor(Date.now() / 1000);
    // 逐 attempt 展开（批C）：挂起层经 actx 读取 attempt 级身份
    const actx = { ...ctx, completionId, created, model };
    // C 无 B 独有的续写三件套——连接身份 + attempt 两个种子直接组成 state，无额外展开
    const state = {
      ...seedConnectionState({
        key,
        protocol, // 'openai' | 'anthropic'：续跑时必须按挂起时的协议回写响应
        // Anthropic 响应回显客户端**原始**请求名（claude-* 被映射到默认模型是内部行为）
        echoModel: protocol === 'anthropic' ? clientModel : null,
        // thinking 可见性：同流式路径（决策来自路由层，非流式在 response-builder 消费）。
        // 签名默认值协议感知，理由见 _handleStreamingResponse 同处注释。
        thinkingEnabled: Boolean(thinkingEnabled),
        stream: false, // 非流式：内容只在内部累积、尚未写给客户端，假死重发自愈对客户端不可见
        client: session.client,
        sessionId: session.sessionId,
        clientModel, // 客户端原始请求值（记账 requestedModel 用，区别于实际使用的 model）
        poolId: session.poolId, // 连接池 ID，用于释放时精确定位本请求的连接
        accountId: session.accountId || null, // 后端绑定的账号（多账号池：上报健康用）
        tools // 客户端委托工具：回退重试换新会话时须重注册（_prepareModelFallback 读 state.tools）
      }),
      ...this._seedAttemptState({
        prompt // 重试（429 频控退避）时需要重新 sendPrompt
      })
    };
    if (outcome) outcome.state = state; // 供 handleChatCompletions finally 的耗时汇总读取

    const sink = this._createSink(protocol, {
      emit: 'accumulate',
      state, key, completionId, created, model, res,
      onToolCall: (toolEvent) => this._suspendForToolCall(state, toolEvent, { stream: false, ctx: actx }),
      onTimeout: (reason = STALL_REASON.SOFT) => {
        if (reason === STALL_REASON.FIRST_TOKEN || reason === STALL_REASON.MID_STREAM) {
          // 假死处置同流式路径（处置单点：取消 + 丢弃 + 置 wedgeReason）；非流式尚未
          // 向客户端输出，抛错走自愈重试。后端定位用 session，诊断字段仍落 state。
          this._discardWedgedBackend(key, session.client, session.sessionId, session.poolId, reason, state);
          throw firstTokenTimeoutError(Boolean(outcome?.modelFallbackUsed), reason);
        }
        console.warn(`[buddy2api] Non-stream soft timeout (${STREAM_SOFT_TIMEOUT_MS}ms) for key=${key}`);
        markFinalized(state); // 请求已终结：queue-policy 不再做静默失败重试
        this._recordUsage(state, model, { stream: false, status: 'timeout' });
        // 不 invalidate：只取消当前任务，连接保留复用（catch 会兜底清理）
        session.client.cancelPrompt(session.sessionId).catch(() => {});
        throw new Error(`WorkBuddy 响应超时（${Math.round(STREAM_SOFT_TIMEOUT_MS / 60000)}分钟无事件，可能是上下文压缩过慢）`);
      },
      onDone: () => {
        if (outcome) outcome.completed = true; // 自然结束：本次文本可记入会话亲和缓存
        markFinalized(state); // 请求已终结
        this.sessions.reportAccountHealth(state.accountId, { ok: true });
        this._recordUsage(state, model, { stream: false, status: 'completed' });
        // 释放统一交给 handleChatCompletions 的 finally（同流式路径，避免双重归还）
        return this._buildFinalResponse(state, completionId, created, model);
      }
    });

    try {
      return await this._runWithRateLimitRetry({
        client: session.client, sessionId: session.sessionId,
        prompt, sink, state, ctx
      });
    } catch (error) {
      // 非流式尚未写任何响应体：回退重试总是安全（同流式路径，标记挂请求级 outcome 盒）。
      // 控制流收拢进 _retryOnceWithFallback 单点（C4）；本路径无差异字段可补。
      const attempt = await this._retryOnceWithFallback({
        state, model, error, outcome, key,
        retry: (fallback, base) => this._handleNonStreamingResponse({
          ...base,
          ctx: { ...ctx, outcome } // outcome 盒随重试链传播（CR S1，同流式路径）
        })
      });
      if (attempt.ok) return attempt.result;
      error = attempt.error; // 重试也失败：展示重试的错误（更有信息量）

      // 首 token 假死视同后端类错误（同流式路径）
      //（头/尾簇已收 finalizer.js 单点，批4；中间段次序留本路径原地）
      const { wedge, connError } = disposeConnError({ pending: this.pending, sessions: this.sessions, key, poolId: state.poolId, error });

      console.error('Non-streaming error:', error);
      this._recordUsage(state, model, { stream: false, status: 'error', error: error.message });
      releaseAfterError({ pending: this.pending, sessions: this.sessions, key, poolId: state.poolId, accountId: state.accountId, error, connError });
      if (wedge) error.statusCode = 504; // 首token假死对非流式客户端交付 504 语义
      throw error;
    }
  }

  // ===== 工具挂起（单一 seam） =====

  /**
   * 工具调用挂起的统一实现（方案 C 的"单一 seam"）。
   *
   * 三个路径（首轮流式 / 首轮非流式 / 工具续跑）的 onToolCall 全部收敛到这里：
   * 记录 toolCall → 写 tool_calls SSE（流式）→ 置 pending 表 → 挂超时 →
   * 返回挂起响应（非流式）或 null（流式已写完）。
   *
   * 后续新增工具调用相关特性（多工具并行、工具参数流式、工具取消）只需改这一处
   * 与 acp-client 的 delegateTools/approveToolCall/respondToToolCall。
   *
   * @returns {object|null} 非流式返回 OpenAI tool_calls 挂起响应；流式返回 null
   */
  _suspendForToolCall(state, toolEvent, { stream, sink = null, ctx }) {
    const { key, res, completionId, created, model } = ctx;
    state.toolCall = toolEvent;
    state.resuming = false; // 新一次挂起：同一挂起的重复 tool_result 才该被拒
    markFirstOutput(state); // toolCall 也是用户可见输出（首 token 守卫口径/耗时汇总）
    state.toolCallCount = (state.toolCallCount || 0) + 1; // token 统计：工具调用次数
    this.pending.set(key, state);
    this._armPendingTimeout(key);

    // Anthropic 流式的 tool_use 块由 sink 发射（块 index / start-stop 配对状态在
    // sink 里，handler 拼不出正确的 index）；OpenAI 流式的 tool_calls 帧对同理
    // 由 sink 发射（终态帧词汇，批3——帧字节自 _suspendForToolCall 逐字搬入）。
    // 非流式走下面的 _buildToolCallResponse，
    // 它按 state.protocol 分派到 Anthropic 变体。
    if (stream && state.protocol === 'anthropic') {
      sink?.writeToolUse?.(toolEvent);
      return null;
    }

    if (!stream) {
      return this._buildToolCallResponse(state, toolEvent, completionId, created, model);
    }

    sink?.writeToolSuspend?.(toolEvent);
    return null;
  }

  /**
   * 给挂起的工具调用设置超时，超时后取消并清理。
   * 薄委托（pending-expiry.js 批2）：保留方法形态使测试的 `_armPendingTimeout` 桩
   * 与直调面不变。
   */
  _armPendingTimeout(key) {
    const state = this.pending.get(key);
    armPendingTimer(state, () => this._onPendingTimeout(key, state));
  }

  /**
   * 挂起的工具调用超时回调（取消并清理）。
   * 单独拆出方法便于单测——不用真等 5 分钟。
   */
  _onPendingTimeout(key, armedState) {
    const s = this.pending.get(key);
    // 旧 timer 指到新条目（同 key 已进入下一轮挂起）：到期的是上一轮，不能动
    // 当前条目。armedState 必传（唯一武装点闭包传入；单参调用会因 undefined
    // 不匹配而不执行任何清理——这是 fail-closed 的安全默认）。
    if (s !== armedState) return;
    // 条目不存在（流程已正常完成/被回传）或已在回传中 → 无可取消。
    // 「已在回传中」必须靠 resuming 显式判断：续跑期间 toolCall 仍然保留
    // （理由见 _continuePending），只按 toolCall 判断会把一条**正在跑的**续跑
    // 误当成"没人认领的挂起"取消掉。
    // 之前这里的守卫是 `s && !s.toolCall`——条目缺失时反而继续往下执行，
    // invalidate(key, undefined) 会按 key 定位到**其他请求正在占用的连接**
    // 并销毁之（完成后 5 分钟延迟引爆的串台源）。
    if (pendingExpiryNoop(s)) return;
    console.warn(`[buddy2api] Pending tool call for key=${key} timed out, cancelling`);
    this.pending.delete(key);
    s?.client?.cancelPrompt(s.sessionId).catch(() => {});
    // 关闭被放弃的流迭代器：让 generator finally 把连接标记为空闲，
    // 否则连接池会一直认为该连接有在飞 prompt 而无法复用。
    s?.iterator?.return?.().catch?.(() => {});
    this.sessions.invalidate(key, s?.poolId);
  }

  // ===== token 消耗统计 =====

  /**
   * 请求终态时把本次 token 消耗记入 tokenStats（明细 + 按模型聚合）。
   *
   * 实际模型归因（`model` 字段）优先级：usage 事件报告（usage_update 若带 model
   * 字段，最准）> 客户端指定的 model 参数（非 auto/default 时）> 会话当前模型
   * （session/new 的 currentValue，setModel 成功后同步更新）> 客户端原始请求值。
   * 另一个字段 `requestedModel` 记的是客户端**原始**请求值，不做归因。
   *
   * token 数量口径：usage_update 上报了就用精确值（usage_source: 'reported'）；
   * 当前网关版本大多不回传 usage 事件，此时按 prompt/content/reasoning 文本
   * 估算（usage_source: 'estimated'，CJK 1 字≈1token，其余 4 字符≈1token），
   * 保证统计明细不为 0，但不含图片 token（图片按文本无法估）。
   *
   * 纯错误（无任何模型输出）不记账：429 频控等场景估算也为 0，记了只会
   * 污染按模型的请求计数。
   */
  _recordUsage(state, requestedModel, { stream, status = 'completed', error = null } = {}) {
    if (!markUsageRecorded(state)) return; // 单次门在 attempt.js（非流式超时路径 onTimeout 后还会走 catch）

    const usage = state?.usage || EMPTY_USAGE;
    const reportedPrompt = Number(usage.prompt_tokens) || 0;
    const reportedCompletion = Number(usage.completion_tokens) || 0;
    const reported = reportedPrompt > 0 || reportedCompletion > 0;

    const promptTokens = reportedPrompt || observePromptTokens(state?.prompt);
    const completionTokens = reportedCompletion || estimateOutputTokens(state?.content, state?.reasoning);
    if (status === 'error' && promptTokens === 0 && completionTokens === 0) return;

    // 缓存与计费口径：网关 usage 带 cached_tokens / prompt_cache_miss_tokens /
    // credit 时透传。prompt_tokens 的大头（工具定义等固定前缀）命中前缀缓存后
    // 不计费，单看 prompt_tokens 会高估开销。
    const cachedTokens = Number(usage.cached_tokens) || 0;
    const cacheMissTokens = usage.cache_miss_tokens != null ? Number(usage.cache_miss_tokens) || 0 : undefined;
    const credit = usage.credit != null ? Number(usage.credit) || 0 : undefined;

    const actualModel = usage.model
      || (requestedModel && requestedModel !== 'auto' && requestedModel !== 'default' ? requestedModel : null)
      || state?.client?.defaultModel
      || requestedModel
      || 'auto';

    tokenStats.record({
      model: actualModel,
      // 客户端**原始**请求值，与 actualModel 区分：能看出"客户端写的是 auto /
      // 没写 model，实际用的是代理默认模型"。
      requestedModel: state?.clientModel ?? requestedModel ?? null,
      promptTokens,
      completionTokens,
      cachedTokens,
      cacheMissTokens,
      credit,
      usageSource: reported ? 'reported' : 'estimated',
      key: state?.key,
      status,
      stream,
      toolCalls: state?.toolCallCount || 0,
      durationMs: state?.startedAt ? Date.now() - state.startedAt : undefined,
      error
    });
  }

  // ===== 断开取消生命周期 =====

  /**
   * 客户端断开后延迟取消 WorkBuddy 任务。
   * 立即 cancel 会丢弃 WorkBuddy 已生成的部分输出（客户端表现为
   * "Partial assistant output was discarded before a streaming retry"），
   * 且 WorkBuddy 的 cancel 只给 5s 宽限就强杀流，压缩上下文时 agent
   * 来不及响应。改为宽限期（DISCONNECT_CANCEL_GRACE_MS）后取消；
   * 期间客户端重连（同 key 新请求）由 handleChatCompletions 撤销。
   */
  _scheduleDisconnectCancel(key, client, sessionId, graceMs = DISCONNECT_CANCEL_GRACE_MS) {
    const prev = this.disconnectCancels.get(key);
    if (prev) clearTimeout(prev.timer);
    const timer = setTimeout(() => {
      this.disconnectCancels.delete(key);
      console.warn(`[buddy2api] Client disconnected for key=${key} beyond grace (${graceMs}ms), cancelling WorkBuddy task`);
      client.cancelPrompt(sessionId).catch(() => {});
    }, graceMs);
    this.disconnectCancels.set(key, { timer, client, sessionId });
  }

  // ===== 薄委托（逻辑在 prompt-builder / response-builder；保留方法形态作为测试注入点） =====

  _buildPrompt(messages) {
    return buildPrompt(messages);
  }

  /**
   * 把 content 中的远程图片 URL（http/https）就地换成 data URL，交给 buildPrompt
   * 内联成 ACP image 块。无远程图片时原样返回（零开销，也不改动输入）。
   *
   * 失败直接抛出：图片是用户明确要求模型看的内容，抓不到就该报错，
   * 若静默丢弃会让模型在看不见图的情况下作答——正是本次要修的问题。
   *
   * 实现（含 SSRF 防御）在 image-fetch.js；本方法保留作为调用面/测试注入点。
   */
  _resolveRemoteImages(messages) {
    return resolveRemoteImages(messages);
  }

  _messageToText(msg) {
    return messageToText(msg);
  }

  // ===== 协议分派（两条协议共用一个编排，差异只在策略 seam 上） =====

  /**
   * 协议策略选择（架构深化第十一批 C2）：按 protocol 字符串返回对应策略实例。
   * handler 持有两个无状态策略实例（构造时创建），本方法只做选择。
   */
  _strategy(protocol) {
    return protocol === 'anthropic' ? this.anthropicStrategy : this.openaiStrategy;
  }

  /** sink 装配：委托策略（两个工厂的 opts 形状刻意保持一致） */
  _createSink(protocol, opts) {
    return this._strategy(protocol).createSink(opts);
  }

  /** 会话/消息 id：委托策略（Anthropic `msg_…` / OpenAI `chatcmpl-…`） */
  _newMessageId(protocol) {
    return this._strategy(protocol).messageId();
  }

  /**
   * 流首事件：委托策略。
   * - OpenAI：先发 `role: assistant` chunk（客户端靠它建 message 对象）
   * - Anthropic：**不发**——message_start 由 anthropic-sink 惰性发出，保证
   *   「零输出的首 token 假死 → 换后端重试」不会让客户端看到两条 message_start
   */
  _writeStreamPreamble(protocol, write, completionId, created, model) {
    this._strategy(protocol).buildPreamble(write, { completionId, created, model });
  }

  /**
   * 流自然收尾帧——A（续跑）与 B（首轮流式）`onDone` 中**逐字相同**的那一段。
   *
   * 为什么要抽：它承载的是被行为契约锁定的**出口形状**（OpenAI「空 stop chunk →
   * 可选 usage → [DONE] → end」与 Anthropic「sink.finish({ end_turn })」的协议分派，
   * 即 BC-2/BC-3/BC-5 的收尾面）。散在两处时，任一处被「顺手统一」都没有提示；
   * 收成一处后，这个形状只有一个定义点。
   *
   * 两处调用点的唯一差异是 `usage` 的来源（A 读 `baseState.usage`：续写自愈会替换
   * state 三件套，活真相在 baseState；B 读 `state.usage`）——用参数化让它一眼可见。
   * 原两段都是 `if/else`，此处改写为早退 `return`；控制流等价，出口形状不变
   * （由 `handler-path-contract.test.js` 的「出口形状」用例锁 tail 次序）。
   *
   * 刻意**不**收拢 soft 超时帧：三条路径的超时文案与 chunk 个数互不相同
   * （BC-2 逐字不同；BC-3 条件性不同——A 依赖 `content` 非空且恒再发一个空 stop chunk，
   * B 无条件发且不发空 stop chunk）。硬收必须引入 3–4 个布尔开关，即已否决的方案。
   */
  _writeStreamFinish({ sink, write, usage, ctx }) {
    this._strategy(ctx.protocol).buildStreamFinish(sink, write, { usage, ctx });
  }

  _buildToolCallResponse(state, toolEvent, completionId, created, model) {
    return this._strategy(state?.protocol).buildResponse(state, {
      kind: 'tool', toolEvent, completionId, created, model
    });
  }

  _buildFinalResponse(state, completionId, created, model) {
    return this._strategy(state?.protocol).buildResponse(state, {
      kind: 'final', completionId, created, model
    });
  }

  _buildUsage(usage) {
    return buildUsage(usage);
  }

  /**
   * 关闭：清空挂起状态并取消任务。
   */
  async close() {
    for (const [key, state] of this.pending.entries()) {
      clearTimeout(state.timer);
      await state.client.cancelPrompt(state.sessionId).catch(() => {});
    }
    this.pending.clear();
    for (const [, entry] of this.disconnectCancels) {
      clearTimeout(entry.timer);
      entry.client.cancelPrompt(entry.sessionId).catch(() => {});
    }
    this.disconnectCancels.clear();
    await this.sessions.close();
  }
}

// （FALLBACK_MODELS 已迁 model-policy.js——兜底列表与 scripts/models.js 对齐的维护注释随迁，批1）

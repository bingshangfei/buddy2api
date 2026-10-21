/**
 * continuation.js — 中途停滞续写自愈原语（架构深化第十一批 C1）。
 *
 * 从 openai-handler.js `_continueAfterWedge` 提取（122 行 → 本模块 ~130 行）。
 * 已流出内容无法收回、重发必然重复——所以不是"重试"，而是**续写**：
 * 以「原始历史 + 已流出半成品（assistant）+ 续写指令（不重复已有内容）」在新后端
 * 重放，续写段的增量继续写进**同一条 SSE 流**（客户端无断连、无重复）。
 *
 * 每请求至多 MAX_CONTINUATIONS 次（state.continuedCount 门禁）；续写段停滞由
 * handler 的 onTimeout 闭包再次进入本函数（递归至多 3 层），超限落到 finalizeMidStream。
 *
 * `degraded`（末次续写，门禁处置位）：换向量而非重掷——needsTools:false 后端 +
 * 不注册委托工具 + 降级专用指令（bugfix-20260922-stall-rootcure）。
 *
 * 依赖注入（10 个 deps）：
 *   - sessions: SessionManager — acquire/discardPool/reportAccountHealth/invalidate
 *   - prepareSession: from session-prepare.js
 *   - RETRY_PREPARE_POLICY: from session-prepare.js
 *   - sanitizePrompt: from prompt-builder.js
 *   - classifyError: from error-classifier.js
 *   - buildPrompt: from prompt-builder.js
 *   - runWithRetry: handler._runWithRateLimitRetry（请求执行原语，留 handler）
 *   - finalizeMidStream: handler._finalizeMidStreamError
 *   - finalizeAborted: handler._finalizeAborted
 *   - pendingHas: () => handler.pending.has(key)
 *
 * 只有 1 个调用点（handler line 1119-1124），传参成本一次性。
 */

import { bindConnection } from './connection-state.js';
import {
  CONTINUE_INSTRUCTION, CONTINUE_INSTRUCTION_DEGRADED, MAX_CONTINUATIONS,
  incrementContinued, mergeUsage, setContinuationContext, promoteWedgeReason
} from './attempt.js';

/**
 * 中途停滞续写自愈（首轮流式路径，首次停滞调用）。
 *
 * @param {object} params
 * @param {object} params.state attempt state（扁平结构，含 connection + attempt 字段）
 * @param {object} params.sink SSE sink（从 handler._createSink 获得）
 * @param {object} params.ctx request context（含 key/protocol/isAborted）
 * @param {string} params.model 当前模型 id
 * @param {object|null} [params.outcome] 请求级回退闸/耗时汇总盒
 * @param {boolean} [params.degraded=false] 末次续写降级标志
 * @param {object} deps 依赖注入（见模块头注释）
 * @returns {Promise<null>} 始终返回 null（续写成功或失败都由 sink/finalize 收尾）
 */
export async function continueAfterWedge(
  { state, sink, ctx, model, outcome = null, degraded = false },
  deps
) {
  const { key, protocol, isAborted } = ctx;
  const {
    sessions, prepareSession, RETRY_PREPARE_POLICY, sanitizePrompt, classifyError,
    buildPrompt, runWithRetry, finalizeMidStream, finalizeAborted, pendingHas
  } = deps;

  incrementContinued(state); // 无论成败：本次续写已发生（防无限续写/重复计费）——attempt.js 原语

  // 客户端已断开：省一次 acquire + prompt（防幽灵请求），静默退出但要记账
  if (isAborted?.()) return finalizeAborted(state, model);

  // 关闭被丢弃的假死 attempt 迭代器（state.iterator 即将被续写段覆盖；不关的话
  // 它挂到 _iterSse 的 30 分钟空闲兜底才销毁，白留一条噪声日志与一个挂起 POST）
  state.iterator?.return?.().catch?.(() => {});

  const firstUsage = { ...state.usage };

  // 续写 prompt：原始历史 + 已流出半成品 + 续写指令（半成品为空时省略 assistant 段）。
  // 基准恒为 originalRawMessages 快照——多次续写时指令不嵌套、上下文不滚雪球；
  // state.content 天然累积全部已流出文本，assistant 段始终是最新全量。
  const messages = [...(state.originalRawMessages || state.rawMessages || [])];
  if (state.content) messages.push({ role: 'assistant', content: state.content });
  messages.push({ role: 'user', content: degraded ? CONTINUE_INSTRUCTION_DEGRADED : CONTINUE_INSTRUCTION });

  let nextSession = null;
  try {
    nextSession = await sessions.acquire(key, {
      // 降级段（末次续写）：needsTools:false → `--tools ""` 独立后端风味，
      // 委托工具与 CLI 内置工具双除——停滞两风味的触发向量（委托工具派发及其
      // 伴随权限链）整体不存在，机制性绕过而非同向量重掷（!8 真机 3 次全挂）。
      needsTools: !degraded,
      modelId: model,
      preferredAccountId: state.accountId
    });
    // 委托工具按 sessionId 注册 → 新会话必须重注册，否则续写段模型调不到
    // 客户端工具（静默退化：不挂起、不返回 tool_calls，用户看到半成品答案）。
    // 降级段反其道而行：刻意不注册（无委托工具 = 无停滞向量），state.tools
    // 保留原值仅作记账/诊断。
    await prepareSession(nextSession, {
      ...RETRY_PREPARE_POLICY,
      model,
      tools: degraded ? null : state.tools,
      label: degraded ? '降级续写段' : '续写段'
    });
  } catch (e) {
    console.warn(`[buddy2api] 续写自愈 acquire/setModel 失败：${e.message}`);
    if (nextSession) sessions.discardPool(key, nextSession.poolId);
    return finalizeMidStream(state, sink, protocol, model, e?.message || String(e), outcome);
  }

  // 降级事实日志放在 acquire 成功后：失败路径（上方 catch）已如实报错，
  // 不提前打印与事实不符的「已剥离」（评审 S6）
  if (degraded) {
    console.warn(
      `[buddy2api] 末次续写降级（key=${key}，续写 ${state.continuedCount}/${MAX_CONTINUATIONS}）：` +
      `tools 已剥离（needsTools:false + 不注册委托工具），降级指令续写`
    );
  }

  // acquire 期间客户端断开：丢弃新会话，静默退出（同样要记账 + finalized）
  if (isAborted?.()) {
    sessions.discardPool(key, nextSession.poolId);
    return finalizeAborted(state, model);
  }

  // 三件套替换（旧池已被 discard）：后续收尾 / 工具挂起 / 再次停滞处置
  // 全部按新会话定位——不替换会让 onDone 的 release 操作已丢弃的旧池。
  // 收口为 connection-state.js 原语（十批 D2 → 十一批 C4 移入连接身份模块）。
  bindConnection(state, {
    client: nextSession.client,
    sessionId: nextSession.sessionId,
    poolId: nextSession.poolId,
    accountId: nextSession.accountId
  });

  const prompt = sanitizePrompt(buildPrompt(messages));
  // state.prompt / rawMessages 同步更新为续写版：续写段挂起工具后客户端回传结果，
  // 续跑路径（_consumePending）重发的就是这份（含半成品与续写指令）——语义正确，
  // 因为新后端没有对话上下文，必须整体重放。收口为 attempt.js 原语（十批 D2）。
  setContinuationContext(state, { prompt, rawMessages: messages });

  // 续写段 usage 滚动合并进 state.usage：sink 的 onDone 直接读 state.usage 写
  // usage chunk，等 run() 之后再合并就已经写晚了（覆盖语义会只报续写段）。
  // 只遮蔽 onUsage（其余处理器按展开共享同一闭包），不新建 sink——同一条 SSE 流。
  let segmentUsage = null; // 本段 usage（观测用；state.usage 由下一行滚动合并维护）
  const sinkProxy = { ...sink, onUsage: (usage) => {
    segmentUsage = usage;
    mergeUsage(state, firstUsage, usage); // 唯一写手：滚动合并，嵌套续写安全
  } };

  let iterator = null;
  try {
    // 复用首轮同款重试策略（429 退避 / 静默空结果检测 / 迭代器收尾），
    // 不自建 driver——否则续写段遇频控会被改写成"中途停滞"且不做退避。
    await runWithRetry({
      client: nextSession.client, sessionId: nextSession.sessionId,
      prompt, sink: sinkProxy, state, ctx
    });
    iterator = state.iterator;
  } catch (e) {
    console.warn(`[buddy2api] 续写段失败：${e.message}`);
    // usage 不在此覆盖：sinkProxy.onUsage 已滚动合并进 state.usage（嵌套续写下
    // 各段 firstUsage 依次前移，任何局部覆盖都会丢内层段的合并结果——C7b 实证）
    if (!deps.pendingHas(key)) iterator?.return?.().catch?.(() => {});
    // 与首轮 catch 同口径处置（否则出错的新池会被 finally 当健康资源 release 给
    // 后续请求复用——串台源；账号健康也要记负例）。判定引用 classifyError 单点
    //（2026-09-26 候选②：原为 isWedgeError || _isBackendConnError 字面拷贝）
    const { connError } = classifyError(e);
    if (connError) {
      sessions.discardPool(key, state.poolId);
    } else {
      sessions.reportAccountHealth(state.accountId, { ok: false, reason: e.message });
      sessions.invalidate(key, state.poolId);
    }
    state.lastStreamError = e?.message || String(e); // 记账保留真实错误（文案仍用固定安全文案）
    return finalizeMidStream(state, sink, protocol, model, state.lastStreamError, outcome);
  }

  // usage 不在此覆盖（同 catch：onUsage 滚动合并是唯一写手，嵌套续写下局部覆盖丢内层）
  // 挂起（续写段又调工具）时保留 iterator 等客户端回传；正常收尾则关闭底层流
  if (!deps.pendingHas(key)) iterator?.return?.().catch?.(() => {});
  // 只在仍是首段 mid-stream 标记时升格为 continued——失败收尾（mid-stream-failed）
  // 与中止收尾（mid-stream-aborted）都不得被误报为「续写成功」（attempt.js 单点）
  promoteWedgeReason(state, 'mid-stream-continued');
  return null;
}

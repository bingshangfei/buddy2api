/**
 * attempt.js — 请求级 attempt 状态的种子与终态原语（候选①降级形态）。
 *
 * 从 openai-handler.js 抽出（refactor-20260926-arch-deepening；范围按 brainstorm
 * 审视 F17 收窄——**只收种子与置位语义的单点，不收三路径的控制流**：A/B/C 的
 * onTimeout/onDone/catch 次序是被 handler-path-contract seq 断言分别钉死的行为锚
 * （F1/F2），差异降为数据/单点清理 = 在案否决的布尔开关方案复辟）。
 *
 * 拥有：
 *   - state 种子（B/C 两调用点逐字相同的初值；A 复用 pending 活条目不参与）
 *   - usage 合并（续写自愈 = 两次真实调用，计费必须累加）
 *   - 终态置位语义：finalized（queue-policy 幽灵重跑闸）/ usageRecorded 单次门 /
 *     wedgeReason 条件升格（first-token-guard.md 三态语义：不得互相冒充）
 *   - 续写指令常量与上限
 */

// ↓ 两个调用点逐字相同的初值（唯一来源）
export const EMPTY_USAGE = { prompt_tokens: 0, completion_tokens: 0 };

/**
 * 中途停滞续写指令（英文：模型侧更稳，不受对话语言影响）。
 * 已流出的内容会作为 assistant 半成品重放，本指令要求接着写而不是重头来——
 * 「不要重复已有内容」是防重复输出的核心约束（前序任务正是因此拒绝自愈）。
 */
export const CONTINUE_INSTRUCTION =
  'Your previous reply was cut off mid-stream by an infrastructure failure. '
  + 'Continue exactly from where it stopped, as if uninterrupted. '
  + 'Do not repeat any content that was already written, do not restart the answer, '
  + 'and do not comment on the interruption. Output only the continuation.';

/**
 * 降级续写专用指令（末次续写且带工具重试已被证明同向量无出路时使用）。
 *
 * 降级段运行在 tools:false 后端上（--tools "" 独立风味：委托工具与 CLI 内置工具
 * 双除）——模型此刻没有任何工具可用，而停滞点恰是「模型正要调工具」的位置。沿用
 * 原指令（「只输出续写、不评论中断」）会把模型逼进唯一出路：内联虚构工具结果
 * （客户端不可检测的幻觉）。本变体显式解除该死角：允许明示工具不可用并给出
 * 尽力而为的文本回答（评审 F9 缓解①）。英文常量同原指令口径。
 */
export const CONTINUE_INSTRUCTION_DEGRADED =
  'Your previous reply was cut off mid-stream by an infrastructure failure. '
  + 'Tool calling is unavailable in this continuation: do not pretend to call tools '
  + 'and do not fabricate tool results. '
  + 'If the rest of the answer depends on a tool result you cannot obtain, say so plainly '
  + 'and give the best answer you can without it. '
  + 'Do not repeat any content that was already written and do not restart the answer. '
  + 'Output the continuation directly.';

// 续写上限：每次续写段停滞可再续写，至多 3 次（第 3 次续写段停滞才报错收尾）。
// 硬编码不做环境变量——低频自愈路径，配置面是过度设计；最坏 4 段 × 180s 检测，
// 与客户端 600s 看门狗的关系见 first-token-guard spec「已接受取舍」。
export const MAX_CONTINUATIONS = 3;

/**
 * attempt state 种子（**只服务 B / C 两个调用点**）。
 *
 * **A（`_consumePending`）不参与**：它是 `const baseState = state`——复用 pending 表里
 * 的**活条目**而非新分配对象。一个是「待续跑的挂起条目」，一个是「本次 attempt 的新状态」，
 * 生命周期与归属都不同；合并会把「复用」与「新建」混为一谈（AC-4 / `refactor-plan.md` §步骤 4）。
 *
 * `fields` 由调用点给出，**B / C 的差异必须是调用点上具名的实参**（`stream` 的取值、
 * B 独有的续写素材三件套），不得藏进本方法——否则「B/C 差在哪」不再一眼可见。
 * 本函数只管**两者逐字相同的初值**：新增这类字段只需改这一处，不会再出现
 * 「加了流式那份、忘了非流式那份」的漂移（这正是本步要消灭的隐患）。
 *
 * 键序**不是**契约（内部对象，不可观察），故无需也无意锁定键序。
 * ⚠ 时序契约（attempt-state-seed.test.js）：种子必须在**首次 await 之前**就位——
 * 本函数是纯同步工厂，调用方不得把它挪进 async 装配链（F10 红线）。
 *
 * @param {object} fields 调用点提供的字段（含两路径各自的差异取值）
 * @returns {object} 完整 state
 */
export function seedAttemptState(fields) {
  return {
    ...fields,
    iterator: null,
    startedAt: Date.now(), // token 统计：请求耗时
    content: '',
    reasoning: '',
    usage: { ...EMPTY_USAGE },
    toolCall: null,
    toolCallCount: 0,
    timer: null
  };
}

/**
 * 合并两段上游调用的 usage（续写自愈 = 两次真实调用，计费必须累加）。
 * 数值字段相加；非数值字段（如 model）保留首段值；缺失的数值字段按 0 补齐。
 */
export function addUsage(first, second) {
  const a = first || {};
  const b = second || {};
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) {
    if (typeof v === 'number' && typeof out[k] === 'number') out[k] += v;
    else if (out[k] == null) out[k] = v;
  }
  // 两个 token 主字段重算并归一：保证存在且为数值（记账/响应构建依赖；
  // 网关若把值改发成字符串也不至于拼成 "105"）
  out.prompt_tokens = (Number(a.prompt_tokens) || 0) + (Number(b.prompt_tokens) || 0);
  out.completion_tokens = (Number(a.completion_tokens) || 0) + (Number(b.completion_tokens) || 0);
  return out;
}

/**
 * 终态标记（单点）：queue-policy 的静默空结果检测见 `state.finalized === true`
 * 即不再合成 429 重跑——漏置的后果是幽灵重跑 + 误冷却账号 + 重复计费
 * （queue-retry.md「finalized 守卫」契约）。所有终态收尾必须经本原语。
 * 刻意**不做**空值防御：state 传丢时裸赋值当场 TypeError 留痕——静默跳过会让
 * 该闸以「无痕迹放行」的方式失效（CR 怀疑者轴 F2）。
 */
export function markFinalized(state) {
  state.finalized = true;
}

/**
 * usage 记账单次门：首次调用赢得记账权并返回 true；此后一律 false。
 * 一次请求只记一笔（非流式超时路径 onTimeout 后还会走 catch）。
 */
export function markUsageRecorded(state) {
  if (!state || state.usageRecorded) return false;
  state.usageRecorded = true;
  return true;
}

/**
 * wedgeReason 条件升格（first-token-guard.md 三态语义，不得互相冒充）：
 * 仅当仍是基态 `'mid-stream'` 时才升格——失败收尾（'mid-stream-failed'，
 * `_finalizeMidStreamError` 无条件置位）与中止收尾（'mid-stream-aborted'）
 * 之后不得再被改报为「续写成功」。candidate 取值：'mid-stream-continued' /
 * 'mid-stream-aborted'。
 * ⚠ 基态字面量 `'mid-stream'` 必须与 `STALL_REASON.MID_STREAM`（stream-driver.js）
 * 一致——本模块刻意零依赖（叶子），一致性由 tests/wedge-contract.test.js 锁定。
 */
export function promoteWedgeReason(state, candidate) {
  if (state?.wedgeReason === 'mid-stream') state.wedgeReason = candidate;
}

// ─────────────────────────────────────────────────────────────────────────────
// state 归属收口（批9 #4）：attempt state 的**写入原语**单点。
//
// 此前 `state.firstOutputAt ||= Date.now()` / `state.content += text` /
// `state.usage = ...` / `state.iterator = ...` 散落在 sink-base、queue-policy、
// openai-handler 多处字面量直写——同一口径（首输出幂等置位、usage 覆盖 vs 求和
// 两语义、迭代器挂起/归还）靠注释维持一致。本组原语把「attempt.js 拥有 state
// 的写入语义」显式化：调用方不再直写字段，语义变更只改这一处。
//
// ⚠ F6 硬约束（不得合并）：`setUsage`（覆盖，sink-base onUsage 的上游整体 usage）
// 与 `mergeUsage`（求和，续写自愈两次真实调用累加）是**两条语义**，绝不可互相
// 冒充——合并会让续写计费漏加或把单次 usage 翻倍。
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 首输出时间戳（幂等，仅首次生效）。首 token 守卫口径与分段耗时汇总共用。
 * 置于去重/发射判定**之前**（与 driver 的 `_gotOutput` 口径一致）。
 */
export function markFirstOutput(state) {
  state.firstOutputAt ||= Date.now();
}

/**
 * 累加可见正文并顺带标记首输出（sink-base `onDelta` 语义）。
 * 先置位后累加——与旧内联实现逐字一致。
 */
export function appendContent(state, text) {
  markFirstOutput(state);
  state.content += text;
}

/**
 * 累加思考内容并顺带标记首输出（sink-base `onReasoning` 语义）。
 * ⚠ 累加**无条件**且必须在发射判定之前（anthropic.md 钉死1）——置后会让关思考的
 * 请求被误判零产出 → 退避重试 → 重复计费；本原语只做「先置位后累加」，不引入条件。
 */
export function appendReasoning(state, text) {
  markFirstOutput(state);
  state.reasoning += text;
}

/**
 * usage **覆盖**语义：sink-base `onUsage` 收到的是上游对本次调用给出的整体 usage，
 * 直接以之为准（非累加）。与 `mergeUsage` 是两条语义，勿合并（F6）。
 */
export function setUsage(state, usage) {
  state.usage = usage;
}

/**
 * usage **累加**语义：续写自愈 = 两次真实调用，计费必须累加（`addUsage` 求和）。
 * `first` 是续写前的首段 usage，`usage` 是续写段的 usage。
 */
export function mergeUsage(state, first, usage) {
  state.usage = addUsage(first, usage);
}

/**
 * 挂起当前流迭代器到 state（queue-policy 首轮写；终态归还读取）。
 * 单点写入，读取方仍按 `state.iterator?.return?.()` 归还（读面不封装）。
 */
export function setIterator(state, iterator) {
  state.iterator = iterator;
}

/**
 * 清除挂起的流迭代器（流异常退出后防御性归还）。
 */
export function clearIterator(state) {
  state.iterator = null;
}

// ─────────────────────────────────────────────────────────────────────────────
// 续写素材收口（架构深化十批 D2 → 第十一批 C4 进一步拆分）：
// - bindSession → connection-state.js `bindConnection`（语义是"重新绑定连接"，
//   属于连接身份的职责；attempt.js 保留终态 latch）
// - setContinuationContext / incrementContinued 留本模块（续写素材与计数是
//   attempt 生命周期的写入语义）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 续写自愈：同步更新为续写版的 prompt 与 rawMessages——续写段挂起工具后客户端
 * 回传结果，续跑路径重发的就是这份（含半成品与续写指令）。语义正确的前提：
 * 新后端没有对话上下文，必须整体重放。
 */
export function setContinuationContext(state, { prompt, rawMessages }) {
  state.prompt = prompt;
  state.rawMessages = rawMessages;
}

/**
 * 续写次数 +1（无论成败：本次续写已发生，防无限续写/重复计费）。
 */
export function incrementContinued(state) {
  state.continuedCount += 1;
}

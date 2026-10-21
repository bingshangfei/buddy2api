/**
 * finalizer.js — 请求终结的处置单点（refactor-20260928-arch-deepening2 批4，架构评审候选①）。
 *
 * 「错误分类 → 资源处置」的深概念此前以逐字拷贝存在于 openai-handler 三条消费路径
 * catch 段的头尾（A 续跑 / B 流式 / C 非流式）；本模块把**两个逐字相同的簇**收敛为
 * 一份（头簇：分类 + 连接类错误的处置；尾簇：挂起清除 + 条件冷却 + 归还/失效）。
 * 三段的**中间段**（console 标签 / usage 记账 / 终态帧 / 504 / throw）次序互不相同，
 * 刻意**留在各路径原地**——把次序当参数注入的方案已被否决（first-token-guard.md
 * 「判定契约的三处单点化」③ + handler 两次否决记录），本模块不做序列统一。
 *
 * 契约：
 *   - 与 _classifyError 同一判定源（error-classifier.classifyError）。
 *   - 连接类错误（connError）：丢弃死后端（discardPool，非归还）+ **不冷却账号**
 *     （假死/连接断不是账号的错；误冷却会放大故障面）。
 *   - 本模块**不加 markFinalized**：三条 catch 路径现状不置 finalized latch
 *     （latch 只活在 onTimeout / onDone / _finalizeAborted / _finalizeMidStreamError）——
 *     加了是未申报的行为增量（独立审视 F9），保持纯序列平移。
 *   - 幂等：pending.delete 重复调用无害（三段现状本就多次调用）。
 *
 * 楔形尾（refactor-20261013-arch-deepening9 #8）：三条消费路径 onTimeout 的**假死
 * 处置尾**（取消上游 + 物理丢弃假死后端 + 置 `wedgeReason`）此前在 openai-handler
 * 三处内联重复；`disposeWedge` 把它收为本单点（与 connError 处置并列——同属「错误 →
 * 资源处置」）。三路径的**中段**（abort / 续写 / throw 的分支差异）与各自的
 * `firstTokenTimeoutError(final, reason)` 调用**留原地**（final 参数逐路径不同）。
 */

import { classifyError } from './error-classifier.js';

/**
 * 头簇：错误分类 + 连接类错误处置（三 catch 逐字相同的开头的单一实现）。
 *
 * @returns {{wedge: boolean, connError: boolean}} 与 classifyError 同形；调用方
 *   按各自路径的中间段使用 wedge/connError（504 / 帧语义 / 尾簇条件）。
 */
export function disposeConnError({ pending, sessions, key, poolId, error }) {
  const { wedge, connError } = classifyError(error);
  if (connError) {
    // 后端连接类错误是代理自身后端的问题：丢弃死后端，不冷却账号
    //（误冷却 60s 会让后续请求全部路由到其他账号，放大故障面）
    console.warn(`[buddy2api] Backend connection error (${error?.message}); discard backend, account NOT cooled`);
    pending.delete(key);
    sessions.discardPool(key, poolId);
  }
  return { wedge, connError };
}

/**
 * 尾簇：挂起清除 + 条件冷却 + 归还失效（三 catch 逐字相同的结尾的单一实现）。
 * 非 connError（模型/账号侧错误）→ 上报账号健康负例 + invalidate；
 * connError → 仅清除挂起 + invalidate（健康已在头簇以 discard 表达）。
 */
export function releaseAfterError({ pending, sessions, key, poolId, accountId, error, connError }) {
  pending.delete(key);
  if (!connError) {
    sessions.reportAccountHealth(accountId, { ok: false, reason: error.message });
  }
  sessions.invalidate(key, poolId);
}

/**
 * 楔形尾：假死后端的处置 + 诊断标记（三消费路径 onTimeout 的单一实现）。
 *
 * 假死处置**禁止 release/invalidate 归还**——只做物理丢弃（`discardBackend`）：
 * 归还后 convPools 亲和会让客户端重试确定性落回同一假死后端，形成雪崩
 *（根因第 2 层，见 openai-handler `_discardWedgedBackend` 注释）。取消（`cancel`）
 * 先于丢弃，使上游任务在池条目摘除前停止；顺序与既有内联实现一致。
 *
 * 侧效一律经**闭包注入**（`cancel` / `discardBackend`），本函数保持纯叶子——
 * 不 import handler、不触达实例（finalizer.js 只依赖 error-classifier.js）。
 *
 * @param {() => void} [cancel] 取消上游任务（调用方自行吞错：`.catch(() => {})`）。
 * @param {(url: string) => void} [discardBackend] 从池中物理摘除死后端（非归还）。
 * @param {string} url 后端标识（poolId）。
 * @param {string} reason 假死类别（'first-token' / 'mid-stream'），写入 state 供汇总日志检索。
 * @param {{wedgeReason?: string}} [state] attempt state：置 `wedgeReason = reason`。
 * @returns {string} 归一化后的 reason（供调用方构造错误工厂）。
 */
export function disposeWedge({ cancel, discardBackend, url, reason, state }) {
  cancel?.();
  discardBackend?.(url);
  if (state) state.wedgeReason = reason; // 汇总日志诊断字段（三路径现状一致）
  return reason;
}

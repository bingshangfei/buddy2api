/**
 * error-classifier.js — 上游错误分类学单点（零依赖叶模块，无 import）。
 *
 * !14 候选②把 {wedge, connError} 组合判定收敛进 handler._classifyError；本模块是
 * 第二批深化：把散在四个模块的「上游错误串 → 语义类别」知识再收敛一层，判定面
 * 只有这里的定义：
 *   - queue-policy.isRateLimited / parseQuotaResetAt（频控措辞正则 + 配额重置解析，再导出）
 *   - openai-handler.isWedgeError / _isBackendConnError（假死与后端连接类，再导出/委托）
 *   - account-pool.classifyFailure（冷却分级：rate-limit / auth / error，再导出）
 *   - account-pool.probeAccount 的内联 auth 正则（探活窄面——与 classifyFailure 的
 *     auth 宽面**今天不等价**：「未登录」「unauthor」只在运行时面命中；两面分开
 *     导出（isAuthFailureNarrow vs classifyAccountFailure 内的宽面），不静默统一，
 *     否则必有一处冷却面被悄悄放宽/收窄（独立审视 F6）。
 *
 * 契约（first-token-guard.md「判定契约的三处单点化」）：
 *   - STALL_REASON / WEDGE_ERROR_CODE 定义自本文件（原导出点 stream-driver.js 改为
 *     再导出，全部消费方 import 路径不变；字面值是契约，勿改）。
 *   - WEDGE_ERROR_CODE 的**设置点**仍唯一：openai-handler.firstTokenTimeoutError
 *     工厂（勿在别处增设 code——第三真相源比没有更糟）。
 *   - 本模块与 attempt.js 同级为零 import 叶位，只做纯判定/纯解析（无 IO、无 state）。
 */

/**
 * 停滞守卫 reason 枚举（契约字面值，勿改）。onTimeout(reason)、汇总日志的
 * wedgeReason 升格链（'mid-stream' → '-continued'/'-failed'/'-aborted'）与
 * 既有测试断言都以这些字符串为准。此前是 handler 三处裸字符串分派——集中导出
 * = 单一来源，分派点改引常量（refactor-20260926-arch-deepening 候选②）。
 */
export const STALL_REASON = Object.freeze({
  FIRST_TOKEN: 'first-token',
  MID_STREAM: 'mid-stream',
  SOFT: 'soft'
});

/**
 * 假死错误类型码：由 openai-handler.js 的 firstTokenTimeoutError 工厂**单点**
 * 设置（勿在别处增设）；queue-policy 据此短路、不进频控退避。「错误消息避开
 * isRateLimited 识别词」的文本契约保留为历史兜底（first-token-guard.md 措辞
 * 钉死），code 是 2026-09-26 起的 typed 优先判定。
 */
export const WEDGE_ERROR_CODE = 'BACKEND_WEDGE';

/** 判定首 token 假死错误：catch 路径按后端类错误处置（不冷却账号）。 */
export function isWedgeError(error) {
  return error?.name === 'FirstTokenTimeoutError';
}

/**
 * 判断错误是否是"后端连接类"错误（代理自身后端进程死亡/端口拒绝/流被掐断）。
 * 这类错误与账号无关——不该触发账号冷却（误冷却 60s 会让后续请求全部
 * 路由到其他账号，放大故障面）。实测场景：空闲回收器竞态误杀活跃后端。
 */
export function isBackendConnErrorMessage(msg) {
  return /ECONNREFUSED|ECONNRESET|ECONNABORTED|socket hang up|aborted/i.test(String(msg || ''));
}

/**
 * 错误分类单点（三条消费路径的 catch 段共用，原 openai-handler._classifyError）。
 *
 * `wedge = isWedgeError(error)`（认 error?.name === 'FirstTokenTimeoutError'，
 * **按 name 不按 code**）；`connError = wedge || isBackendConnErrorMessage(...)`（假死
 * 视同后端连接类：二者都不冷却账号）。纯判定——无 IO、无 state 写入、**无清理动作**；
 * 清理动作的相对次序仍逐路径留在原地（A/B/C 三段次序互不相同，把次序当参数注入
 * 的方案已被否决）。
 *
 * @param {Error & {statusCode?: number}} error
 * @returns {{wedge: boolean, connError: boolean}}
 */
export function classifyError(error) {
  const wedge = isWedgeError(error);
  return { wedge, connError: wedge || isBackendConnErrorMessage(error?.message) };
}

/**
 * 判断 WorkBuddy 错误消息是否为频控/排队（429 / 资源紧张 / 排队等候）。
 */
export function isRateLimited(message) {
  if (typeof message !== 'string') return false;
  return /429|频率限制|频控|rate\s*limit|too many requests|quota|资源紧张|排队|等候|请稍后|try again later|busy|overloaded/i.test(message);
}

/**
 * 从频控消息中解析配额重置时刻。
 *
 * 配额耗尽（与"排队"不同）时 WorkBuddy 会给出明确的重置时刻，例如：
 *   "429 您的使用量已超出频率限制，将在 2026-08-20 09:08:51 UTC+8 重置"
 *
 * @param {string} message 错误消息
 * @returns {number|null} 重置时刻的毫秒时间戳；解析不到（纯排队/其他错误）返回 null
 */
export function parseQuotaResetAt(message) {
  if (typeof message !== 'string') return null;

  const timeMatch = message.match(/(\d{4})-(\d{2})-(\d{2})[T\s](\d{2}):(\d{2}):(\d{2})/);
  if (!timeMatch) return null;

  const [y, mo, d, h, mi, s] = timeMatch.slice(1).map(Number);

  // 消息里的时间是墙上时钟时间。带 UTC 偏移标记时按该时区解释，否则按本机时区解释。
  const tzMatch = message.match(/UTC\s*([+-])\s*(\d{1,2})(?::?(\d{2}))?/i);
  let offsetMinutes;
  if (tzMatch) {
    const sign = tzMatch[1] === '-' ? -1 : 1;
    offsetMinutes = sign * (Number(tzMatch[2]) * 60 + Number(tzMatch[3] || 0));
  } else {
    // getTimezoneOffset 返回"本地相对 UTC 的负值"（东八区为 -480），取反得本地偏移
    offsetMinutes = -new Date(y, mo - 1, d).getTimezoneOffset();
  }

  // 先按 UTC 解释这串墙上时钟，再减去时区偏移，得到真实 UTC 时间戳
  return Date.UTC(y, mo - 1, d, h, mi, s) - offsetMinutes * 60 * 1000;
}

/**
 * 把错误信息归类成账号冷却类型（原 account-pool.classifyFailure，宽 auth 面）。
 * 注意与 isAuthFailureNarrow（探活面）刻意不同宽：本面多认「未登录 / unauthor」，
 * 两面不等价是现状（独立审视 F6），合并会静默改变其中一处冷却面。
 */
export function classifyAccountFailure(message = '') {
  const m = String(message);
  if (/429|rate.?limit|频控|排队|quota|配额/i.test(m)) return 'rate-limit';
  if (/401|403|auth|未登录|登录态|unauthor/i.test(m)) return 'auth';
  return 'error';
}

/**
 * 探活失败的 auth 判定（原 account-pool.probeAccount 内联正则，窄面）：
 * 只认 401/403/「登录态被拒绝」/auth——探活走的是专用余额接口，措辞面更窄。
 */
export function isAuthFailureNarrow(message) {
  return /401|403|登录态被拒绝|auth/i.test(String(message));
}

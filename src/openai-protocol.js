/**
 * openai-protocol.js — OpenAI Chat Completions 请求的**协议级决策**（纯函数）。
 *
 * 与 anthropic-protocol.js 并列而不是合并：两协议「未携带时的默认值」方向相反
 * （OpenAI 侧既有行为是始终回显 → 默认开；Anthropic 侧规范是按请求 opt-in →
 * 默认关），合并会把两种语义塞进一个函数，谁读都得先判协议。
 */

/**
 * 请求驱动的思考可见性决策（`/v1/chat/completions`）。
 *
 * 背景：Anthropic 侧自 2026-09-17 起「可见性 = 请求驱动」，OpenAI 侧此前
 * **一个开关都没有**——请求参数被完全忽略，`reasoning_content` 无条件全量回显。
 * 本函数把决策收敛到唯一一处（对齐 anthropic.md 的 I-1 拓扑：单一决策点 →
 * 随 state 透传 → 消费者只读）。
 *
 * 取值口径（宽容解析，规范仍在演进）：
 *   - `reasoning_effort: 'none'`（归一化大小写/空白）→ 显式关。**只认 `none`**：
 *     该字段的规范语义是「思考量」（low/medium/high）而不是「可见性同意」，
 *     把非 none 值当成显式开会让环境变量默认被静默压过（且真实客户端会无条件
 *     携带该残留字段，值不反映用户意图）。
 *   - `thinking.type: 'enabled' | 'adaptive'` → 显式开（`display: 'omitted'`
 *     除外：只留签名不回正文 = 按不可见处理，与 Anthropic 侧同口径）。
 *   - `thinking.type: 'disabled'` → 显式关。
 *   - **仲裁 fail-closed**：任意显式关压过任意显式开。反例
 *     `{reasoning_effort:'none', thinking:{type:'enabled'}}`——若让 `thinking`
 *     优先，客户端用本 wire 原生旋钮表达的「别发」会被外来字段静默压过。
 *   - 未携带 / 未知值 / 非对象 / `null` / 近似拼写（`'off'`）→ 回落环境变量。
 *     ⚠ `'off'`/`'disable'` 会回落成「开」（fail-open），是已知取舍：不做同义词
 *     映射，否则等于替客户端猜意图。
 *
 * 环境变量 `BUDDY2API_OPENAI_REASONING_DEFAULT`（默认 `1`）**仅作「请求未表态时
 * 的回落默认」**，**不是 kill switch**——客户端显式 `thinking:{type:'enabled'}`
 * 仍会打开它（同 anthropic.md 对 `BUDDY2API_ANTHROPIC_THINKING` 的口径）。
 *
 * 本改动**只控制转发**：上游 ACP 的思考生成与计费不受影响。
 *
 * @param {unknown} body 请求体（任意类型都不得抛错）
 * @param {object} [env] 环境变量表（注入以便表驱动单测）
 * @returns {boolean}
 */
export function resolveOpenAiThinking(body, env = process.env) {
  const b = body && typeof body === 'object' ? body : {};

  const effort = typeof b.reasoning_effort === 'string'
    ? b.reasoning_effort.trim().toLowerCase()
    : null;
  const thinking = b.thinking && typeof b.thinking === 'object' && !Array.isArray(b.thinking)
    ? b.thinking
    : null;
  const thinkingOn = Boolean(thinking && (thinking.type === 'enabled' || thinking.type === 'adaptive'));

  // 显式关（fail-closed 压过显式开）
  if (effort === 'none') return false;
  if (thinking && thinking.type === 'disabled') return false;
  if (thinkingOn && thinking.display === 'omitted') return false;

  if (thinkingOn) return true;

  // 未表态 → 回落环境变量；只有字面 '0' 表示关（其余含未设 = 既有行为「开」）
  return env?.BUDDY2API_OPENAI_REASONING_DEFAULT !== '0';
}

/**
 * session-prepare.js — 会话准备 seam（setModel + delegateTools 序列单点，零 IO 依赖）。
 *
 * 从 openai-handler.js 整体迁出（第三批批3）：两协议共用的会话准备逻辑此前以
 * god class 私有方法存在，唯一性不变式只能靠对 handler 源码跑正则维持（D6）。
 * 独立成模块后 D6 直接断言本文件，且 handler 里再出现内联拷贝会被 doesNotMatch 拦截。
 *
 * 两条不能碰的红线（session-prepare.test.js 头注释钉死，逐字继承）：
 *  1. **不做 Promise.all** —— 委托工具按 sessionId 注册，漏注册是**静默退化**。
 *  2. setModel 错误策略两种：主路径 warn-and-continue / 重试路径 strictModel 上抛。
 */

import { KNOWN_FREE_UNLISTED } from './model-policy.js';

// 续写 / 模型回退两条"换新会话"路径共用的会话准备策略（两条路径的差异只剩 label）。
// 三个开关刻意与主路径不同，理由见 prepareSession 的注释：
//   guardModel=false   —— 还是同一个模型，不必重复刷"不在网关列表"告警
//   strictModel=true   —— setModel 失败必须上抛，否则新会话留在默认模型上静默计费
//   forceSetModel=true —— auto/default 也照发一次，让 client.defaultModel（usage 事件
//                         没报 model 时的归因兜底）跟着新会话走，不停留在旧连接上
export const RETRY_PREPARE_POLICY = { guardModel: false, strictModel: true, forceSetModel: true };

/**
 * 新会话就绪：设置模型 + 注册委托工具（三处调用点的唯一实现）。
 *
 * 收拢的理由不是省行数，而是**委托工具按 sessionId 注册**这条约束：换了会话
 * 就必须重注册，漏一次是静默退化（模型调不到客户端工具，不挂起、不报错，
 * 用户只看到半成品答案）。同一段序列有三份拷贝时，只要一份漏掉，故障是"不响的"。
 *
 * 两条顺序/错误策略是刻意的，不要"顺手统一"：
 * - **严格串行**，不做 Promise.all：注册工具前模型必须已就位；且并行失败时
 *   无法判断该放弃还是该继续。
 * - setModel 的错误策略分两种：主路径 warn-and-continue（客户端显式指定的模型
 *   设不上，仍用默认模型把这次请求服务完），两条重试路径必须上抛（否则会静默
 *   换模型继续跑 → 静默计费）。用 strictModel 显式表达，不靠调用点各自 try/catch。
 *
 * @param {object} session acquire 返回的会话（需 client + sessionId；models /
 *        client.defaultModel 由本函数读取，不拆开传——拆开就是 F4 说的签名欠据）
 * @param {object} [opts]
 * @param {string|null} [opts.model] 目标模型；auto/default/空 = 不设置
 * @param {Array} [opts.tools] 委托工具定义
 * @param {boolean} [opts.hasTools] 是否注册工具；缺省按 tools 是否非空推导
 * @param {boolean} [opts.guardModel=true] 是否对"模型不在网关列表"告警
 *        （重试路径传 false：还是同一个模型，没必要重复刷）
 * @param {boolean} [opts.strictModel=false] setModel 失败是否上抛
 * @param {boolean} [opts.forceSetModel=false] auto/default 也照发 setModel。
 *        重试路径的原行为：新会话要显式设一次，让 client.defaultModel（usage
 *        事件没报 model 时的归因兜底）跟着新会话走，不停留在上一条连接的模型上。
 * @param {string} [opts.label='会话'] 告警文案前缀，用于区分是哪条路径
 */
export async function prepareSession(session, opts = {}) {
  const {
    model = null,
    tools = [],
    // 由 tools 推导，是这条判据的唯一真源：调用点此前各自复写一遍
    // `Array.isArray(...) && ....length > 0`，任一处写错就是"委托工具静默没注册"。
    // 显式传 hasTools 仍优先（少数路径要 tools 非空但不注册）。
    hasTools = Array.isArray(tools) && tools.length > 0,
    guardModel = true,
    strictModel = false,
    forceSetModel = false,
    label = '会话'
  } = opts;

  if (model && (forceSetModel || (model !== 'auto' && model !== 'default'))) {
    if (guardModel) {
      // 客户端指定的模型 id 一律原样透传（不在网关列表里的隐藏 id 也能用）。
      // 但要显式告警：网关不认识的 id 会让会话留在默认模型上继续跑，
      // 客户端以为在用免费模型、实际按默认模型（如 auto）计费且无任何报错。
      const known = session.models || [];
      if (known.length > 0 && !known.find(m => m.id === model)) {
        if (KNOWN_FREE_UNLISTED.has(model)) {
          console.log(`[buddy2api] 模型 "${model}" 为遗留免费 id（不在网关列表，实测按免费计费），原样透传`);
        } else {
          const free = known.filter(m => m.free).map(m => m.id);
          console.warn(
            `[buddy2api] ⚠ 模型 "${model}" 不在网关公布的模型列表中（共 ${known.length} 个）。` +
            `将原样透传；若网关不认识该 id，会话会继续使用默认模型 "${session.client.defaultModel || 'auto'}" 并按其价格计费。` +
            (free.length ? ` 免费模型：${free.join('、')}` : '')
          );
        }
      }
    }
    try {
      await session.client.setModel(model, session.sessionId);
    } catch (e) {
      if (strictModel) throw e;
      console.warn(
        `[buddy2api] ⚠ ${label}设置模型 "${model}" 失败，会话继续使用默认模型 ` +
        `"${session.client.defaultModel || 'auto'}"（可能产生费用）：${e.message}`
      );
    }
  }

  // 注册 zcode 传来的工具为 WorkBuddy 委托工具
  if (hasTools) {
    try {
      await session.client.delegateTools(session.sessionId, tools);
    } catch (e) {
      console.warn(`[buddy2api] ⚠ ${label}委托工具注册失败（该会话将无客户端工具可用，表现为静默退化）：${e.message}`);
    }
  }
}

/**
 * 本次请求是否需要内置工具的后端。
 *
 * 默认按请求自动：带 tools 的用全量后端（否则委托工具注册不上），纯聊天用
 * 精简后端（`--tools ""`，prompt 前缀 ~22.7k → ~3.2k）。可用
 * BUDDY2API_TOOLS=on（强制全量，旧行为）/ off（强制精简）覆盖。
 *
 * env **必须调用期读取**（缺省参数在调用时求值）：session-reuse 测试在用例中途
 * delete/恢复 BUDDY2API_TOOLS，靠的就是这一行为——不得提前到模块加载期捕获。
 */
export function needsTools(hasTools, env = process.env) {
  const mode = (env.BUDDY2API_TOOLS || 'auto').toLowerCase();
  if (mode === 'on') return true;
  if (mode === 'off') return false;
  return Boolean(hasTools);
}

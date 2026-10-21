/**
 * connection-state.js — 请求级连接状态的种子与绑定原语（架构深化第十一批 C4）。
 *
 * 从 attempt.js 与 openai-handler.js 抽出：连接身份字段（client/sessionId/poolId/
 * accountId/protocol/key/stream 等）与 attempt 终态字段（finalized/wedgeReason/usage
 * 等）是两个正交的生命周期。attempt.js 拥有终态 latch 语义；本模块拥有连接身份
 * 的写入语义（seed + bind 两原语）。
 *
 * 拥有：
 *   - connection state 种子（B/C 两调用点逐字相同的初值）
 *   - 续写自愈的会话重绑定（bindConnection：旧池已被 discard，三件套替换为新会话）
 *
 * 与 attempt.js 的分工：
 *   - attempt.js：终态 latch（finalized/usageRecorded/wedgeReason/firstOutputAt）、
 *     内容累积（content/reasoning）、usage 合并、迭代器挂起、续写指令常量
 *   - connection-state.js：连接身份（client/sessionId/poolId/accountId）、
 *     协议与请求身份（protocol/key/stream/clientModel/tools/echoModel/thinkingEnabled）
 *
 * state 结构（扁平，两模块的种子展开后合并）：
 *   { ...seedConnectionState(...), ...seedAttemptState(...), /* 路径特有字段 *\/ }
 * 所有消费方仍按 state.client / state.sessionId 等扁平访问——分组只在写入语义层。
 */

/**
 * connection state 种子（**只服务 B / C 两个调用点**）。
 *
 * `fields` 由调用点给出，B/C 的差异必须是调用点上具名的实参（`stream` 的取值）。
 * 本函数只管两者逐字相同的连接身份初值。
 *
 * @param {object} fields 调用点提供的连接字段
 * @returns {object} 连接状态对象（展开进 state）
 */
export function seedConnectionState(fields) {
  return {
    key: fields.key,
    protocol: fields.protocol,
    echoModel: fields.echoModel,
    thinkingEnabled: fields.thinkingEnabled,
    stream: fields.stream,
    client: fields.client,
    sessionId: fields.sessionId,
    poolId: fields.poolId,
    accountId: fields.accountId,
    clientModel: fields.clientModel,
    tools: fields.tools
  };
}

/**
 * 续写自愈：将会话定位三件套替换为新会话（旧池已被 discard，后续收尾/工具挂起/
 * 再次停滞全部按新会话定位）。accountId 保留旧值当新会话缺失时（账号持续上报）。
 *
 * 从 attempt.js `bindSession` 移入：语义是"重新绑定连接"，属于 connection-state
 * 的职责（attempt.js 保留终态 latch）。
 */
export function bindConnection(state, { client, sessionId, poolId, accountId }) {
  state.client = client;
  state.sessionId = sessionId;
  state.poolId = poolId;
  if (accountId) state.accountId = accountId;
}

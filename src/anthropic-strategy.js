/**
 * anthropic-strategy.js — Anthropic 协议策略（架构深化第十一批 C2）。
 *
 * 与 openai-strategy.js 并列，共同构成 ProtocolStrategy 接口的两个实现。
 * handler 持有两个策略实例（构造时创建），按 ctx.protocol 选择——无状态，一次创建复用。
 *
 * 6 个方法覆盖主路径（首轮流式/非流式/挂起响应）的协议分发点；
 * 续跑路径（_continueAfterWedge）的流内错误/超时收尾仍由 handler 内联分支
 * 处理（两协议在那里只差帧形状，且与 discard/记账序列耦合），不在本接口内。
 *
 *   1. createSink — sink 装配
 *   2. buildStreamError — 流内错误帧
 *   3. buildStreamFinish — 流自然收尾帧
 *   4. buildResponse — 非流式响应 / 工具挂起响应
 *   5. buildPreamble — 流首事件
 *   6. messageId — 会话/消息 id 格式
 */

import { createAnthropicSink } from './anthropic-sink.js';
import { buildAnthropicMessage, buildAnthropicToolUseResponse } from './response-builder.js';

export function createAnthropicStrategy() {
  return {
    protocol: 'anthropic',

    /** sink 装配：委托 anthropic-sink.js（Anthropic 块状态机） */
    createSink(opts) {
      return createAnthropicSink(opts);
    },

    /**
     * 流内错误帧：event: error（C6 事件序）。
     * Anthropic 路径做 try/catch——客户端已断开时 write 会抛，不得冒泡。
     */
    buildStreamError(sink, msg) {
      try {
        sink.abortWithError(msg);
      } catch (e) { /* client gone */ }
    },

    /**
     * 流自然收尾帧：sink.finish({ stopReason: 'end_turn' })。
     * 与 openai-strategy 的 stop chunk + usage + [DONE] 对称。
     */
    buildStreamFinish(sink) {
      sink.finish({ stopReason: 'end_turn' });
    },

    /**
     * 非流式响应 / 工具挂起响应。
     * @param {'final'|'tool'} kind 响应类型
     */
    buildResponse(state, { kind, toolEvent, completionId, model }) {
      if (kind === 'tool') {
        return buildAnthropicToolUseResponse(state, toolEvent, completionId, model, state.thinkingEnabled === true);
      }
      return buildAnthropicMessage(state, completionId, model, state.thinkingEnabled === true);
    },

    /**
     * 流首事件：不发（惰性 message_start 由 anthropic-sink 管理）。
     * 保证「零输出的首 token 假死 → 换后端重试」不会让客户端看到两条 message_start。
     */
    buildPreamble() {
      // no-op
    },

    /** 消息 id 格式：msg_{base36-timestamp}{random} */
    messageId() {
      return `msg_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    }
  };
}

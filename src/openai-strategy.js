/**
 * openai-strategy.js — OpenAI 协议策略（架构深化第十一批 C2）。
 *
 * 与 anthropic-strategy.js 并列，共同构成 ProtocolStrategy 接口的两个实现。
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

import { createSink } from './sink-factory.js';
import { sseChunk, SSE_DONE, sseUsageChunk } from './openai-wire.js';
import { buildToolCallResponse, buildFinalResponse, buildUsage } from './response-builder.js';

export function createOpenAiStrategy() {
  return {
    protocol: 'openai',

    /** sink 装配：委托 sink-factory.js（纯 OpenAI 帧编码） */
    createSink(opts) {
      return createSink(opts);
    },

    /**
     * 流内错误帧：data:error + 可选 [DONE]。
     * OpenAI 路径不做 try/catch——sink.abortWithError 内部处理断连。
     */
    buildStreamError(sink, msg, { sseDone = true } = {}) {
      sink.abortWithError(msg, { sseDone });
    },

    /**
     * 流自然收尾帧：空 stop chunk → 可选 usage → [DONE] → res.end()。
     * 与 anthropic-strategy 的 sink.finish({ stopReason: 'end_turn' }) 对称。
     */
    buildStreamFinish(sink, write, { usage, ctx }) {
      const { completionId, created, model, includeUsage, res } = ctx;
      write(sseChunk(completionId, created, model, {}, 'stop'));
      if (includeUsage) write(sseUsageChunk(completionId, created, model, buildUsage(usage)));
      write(SSE_DONE);
      res.end();
    },

    /**
     * 非流式响应 / 工具挂起响应。
     * @param {'final'|'tool'} kind 响应类型
     */
    buildResponse(state, { kind, toolEvent, completionId, created, model }) {
      if (kind === 'tool') {
        return buildToolCallResponse(state, toolEvent, completionId, created, model);
      }
      return buildFinalResponse(state, completionId, created, model);
    },

    /**
     * 流首事件：发 role: assistant chunk（客户端靠它建 message 对象）。
     * Anthropic 不发（惰性 message_start 由 sink 管理）。
     */
    buildPreamble(write, { completionId, created, model }) {
      write(sseChunk(completionId, created, model, { role: 'assistant' }));
    },

    /** 消息 id 格式：chatcmpl-{timestamp} */
    messageId() {
      return `chatcmpl-${Date.now()}`;
    }
  };
}

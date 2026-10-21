/**
 * sink-base.js — 两协议 sink 的共享台账（refactor-20260926-arch-deepening 候选④）。
 *
 * 「什么算用户可见输出」的守卫口径此前逐字重复两份（sink-factory.js / anthropic-sink.js），
 * 靠成对注释维持口径一致；本模块把台账收敛为一份，协议差异经 hooks 表达：
 *
 *   - **台账（本模块拥有）**：firstOutputAt 置位、content/reasoning 累加
 *     （reasoning **无条件**累加——anthropic.md 钉死1：先累加后判发射，否则关思考的
 *     只思考响应被误判空结果 → 退避重试 → 重复计费）、onProgress 去重与日志、
 *     onUsage 归一、onError（记日志后抛原始消息）。
 *   - **帧写出（协议侧 hooks）**：writeDelta/writeReasoning/writeProgress 只负责
 *     「写出什么帧」，在台账落定之后调用。
 *   - **isClosed（可选前置门）**：anthropic 的 finished 检查先于 firstOutputAt
 *     （收尾竞态的迟到事件不留痕）；OpenAI 侧无门。按现状复刻，勿"统一"。
 *   - **onUsage 无收尾门**：两侧现状均无（文档说惰性、代码无门）——按代码现状
 *     复刻，anchor 见 tests/sink-ledger.test.js；给 usage 补门是行为变更，不在本任务。
 *   - **heartbeat 条件定义**：`stream ? fn : undefined`（非流式无心跳是 queue-retry.md
 *     契约的一部分），不得统一成恒定义的 no-op。
 *
 * StreamDriver 消费的九方法接口不变（见 stream-driver.js 头注释）。
 */

import { resWriter } from './http-utils.js';
// attempt state 写入原语（批9 #4）：attempt.js 拥有 state 的写入语义，此处不再直写字段
import { appendContent, appendReasoning, markFirstOutput, setUsage } from './attempt.js';

export function createBaseSink({
  emit = 'accumulate',
  state,
  key,
  res,
  onToolCall,
  onTimeout,
  onDone,
  hooks = {}
}) {
  const stream = emit === 'stream';
  const write = stream ? resWriter(res) : () => {};
  let lastProgressText = '';

  const writeDelta = hooks.writeDelta || (() => {});
  const writeReasoning = hooks.writeReasoning || (() => {});
  const writeProgress = hooks.writeProgress || (() => {});

  return {
    // 心跳保活：上下文压缩期间 WorkBuddy 长时间静默，向客户端写 SSE 注释
    // 防止连接被代理/客户端因空闲断开。注释行客户端会自动忽略。
    // 可选 message 参数：排队重试时附带进度信息，让用户看到服务没卡死
    heartbeat: stream ? (message) => write(`${message || ': keep-alive'}\n\n`) : undefined,

    onDelta: (text) => {
      if (hooks.isClosed?.()) return;
      appendContent(state, text); // 首输出置位（幂等）+ content 累加：attempt.js 单点
      writeDelta(text, write, stream);
    },

    onReasoning: (text) => {
      if (hooks.isClosed?.()) return;
      // ⚠ 累加必须在发射判定**之前**（无条件）：state.reasoning 是静默空结果检测、
      // 自愈重试守卫与 token 估算三处共用的台账，置后会让「关思考」的请求被误判
      // 成零产出 → 退避重试 → 同一份 prompt 计费两次（anthropic.md 钉死1）。
      appendReasoning(state, text); // 先置位（幂等）后无条件累加：attempt.js 单点
      writeReasoning(text, write, stream);
    },

    onUsage: (usage) => { setUsage(state, usage); },

    onProgress: (text, phase) => {
      if (hooks.isClosed?.()) return;
      // 阶段/进度信息（含压缩上下文）。不写入 state.reasoning，避免污染最终答案；
      // 去重防刷屏。firstOutputAt 置于去重之前：与 driver 的 _gotOutput 口径一致
      // （每个 progress 事件都算输出），避免两本台账分叉导致汇总日志误报 '-'。
      markFirstOutput(state);
      if (!text || text === lastProgressText) return;
      lastProgressText = text;
      console.log(`[buddy2api] progress: ${text} (phase: ${phase || '?'})`);
      writeProgress(text, phase, write, stream);
    },

    onToolCall,

    onTimeout,

    onError: (message) => {
      // WorkBuddy 拒绝 prompt（如 429 频控）。抛错由 _runWithRateLimitRetry 捕获：
      // 频控 → 退避重试；其他错误 → 外层 catch 兜底清理。
      console.warn(`[buddy2api] WorkBuddy error for key=${key}: ${message}`);
      throw new Error(message);
    },

    onDone
  };
}

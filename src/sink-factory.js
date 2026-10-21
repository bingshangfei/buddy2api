/**
 * sink-factory.js — 三条消费路径共用的 sink 装配点（OpenAI 变体）。
 *
 * StreamDriver 定义了 sink 接口（九个处理器），接口的"构造"曾复制三份
 * （首轮流式 / 首轮非流式 / 工具回传续跑，各 ~45 行、共享 70%）。六个相同的
 * 处理器收敛为一份后，路径差异只通过参数注入：
 *
 *   emit        'stream'     → 增量写 SSE chunk（含心跳保活）
 *               'accumulate' → 只累加 state（非流式，无心跳）
 *   onToolCall  工具调用挂起——各路径挂起后的响应形态不同，注入
 *   onTimeout   软超时——流式优雅收尾 / 非流式抛错，注入
 *   onError     统一为"记日志后抛原始消息"，由 _runWithRateLimitRetry
 *               判断频控重试、外层 catch 兜底清理（原先非流式路径在
 *               此处多做一次 pending.delete，与外层 catch 重复，已去重）
 *   onDone      收尾——清理动作 + 最终响应形态，注入
 *
 * 台账（firstOutputAt / content·reasoning 累加 / progress 去重 / onUsage / onError）
 * 在 sink-base.js（与 anthropic-sink 共享一份口径）；本文件只剩 OpenAI 帧写出。
 */

// 帧形状归 openai-wire.js（批4：原始编码器 + 复合终态帧的唯一 vocabulary）；
// 本文件只剩装配——写入机制（resWriter/terminalWrite）与 res.end 时机。
import { sseChunk, SSE_DONE, errorFrame, toolSuspendFrames } from './openai-wire.js';
import { resWriter } from './http-utils.js';
import { createBaseSink } from './sink-base.js';

export function createSink({
  emit = 'accumulate',
  state,
  key,
  completionId,
  created,
  model,
  res,
  onToolCall,
  onTimeout,
  onDone
}) {
  // 可见性口径单点：`!== false`（缺省 = 开）。消费者只看 state、不读 env——决策
  // 已在路由层做过一次，随挂起表透传，续跑不重读。⚠ 与 Anthropic 侧的 `=== true`
  // 方向相反是有意的（两侧「未携带时的默认值」相反），别为"统一"改掉（anthropic.md 钉死9）。
  const thinkingVisible = () => state.thinkingEnabled !== false;

  const sink = createBaseSink({
    emit,
    state,
    key,
    res,
    onToolCall,
    onTimeout,
    onDone,
    hooks: {
      writeDelta: (text, write, stream) => {
        if (stream) write(sseChunk(completionId, created, model, { content: text }));
      },
      writeReasoning: (text, write, stream) => {
        if (stream && thinkingVisible()) {
          write(sseChunk(completionId, created, model, { reasoning_content: text }));
        }
      },
      writeProgress: (text, phase, write, stream) => {
        if (!stream) return;
        if (!thinkingVisible()) {
          // 关思考时改走 SSE 注释而非直接静默：长压缩期零 data 帧会让按帧计时的
          // 客户端判空闲；注释能保活且保留"服务没卡死"的可观测性，又不占
          // reasoning 通道。残留风险如实记录——注释仍不是 data 帧。
          // 换行必须清洗：progress 文案来自上游事件元数据，原样拼进注释行会让
          // 内含的 `\n` 造出伪 SSE 帧（走 reasoning_content 时由 JSON.stringify
          // 兜住，注释行是裸文本——这是本路径唯一的编码面）。
          write(`: progress ${String(text).replace(/[\r\n]+/g, ' ')}\n\n`);
          return;
        }
        write(sseChunk(completionId, created, model, { reasoning_content: text }));
      }
    }
  });

  // ===== 终态帧词汇（refactor-20260928-arch-deepening2 批3） =====
  // 失败路径的协议分派收进 sink，handler 不再裸写 `data:` 帧（此前四处分派，
  // 帧字节靠成对注释维持一致）。与 anthropic-sink 的 abortWithError 同名同责：
  // 「错误 + 终止流」。口径（审视 F4/B9）：不经 stream 门（调用方只在流式语境
  // 调用——现状保持）；**不吞异常**——client-gone 由调用点 try/catch 承担。

  // C6 对应的 OpenAI 变体：error 帧 + 终止。sseDone=false 对应 catch B 的现状
  // （error 帧后直接 res.end、无 [DONE]——逐字保持，不"顺手补齐"）。
  const terminalWrite = resWriter(res);
  sink.abortWithError = (message, { sseDone = true } = {}) => {
    terminalWrite(errorFrame(message));
    if (sseDone) terminalWrite(SSE_DONE);
    res.end();
  };

  // 工具挂起帧对（tool_calls + finish_reason='tool_calls' + [DONE] + 终止）。
  // 帧形状归 openai-wire.toolSuspendFrames（批4）；Anthropic 侧对应 writeToolUse
  // （块 index 状态机在 anthropic-sink 内）。
  sink.writeToolSuspend = (toolEvent) => {
    for (const frame of toolSuspendFrames(toolEvent, completionId, created, model)) {
      terminalWrite(frame);
    }
    res.end();
  };

  return sink;
}

/**
 * queue-policy.js — 排队/频控策略（从 openai-handler.js 拆出，纯策略无 IO）。
 *
 * WorkBuddy 云端频控或热门模型排队（如 hy4-preview "前方约 5127 位用户排队"）
 * 时的两种应对：
 *   1. 排队：指数退避但封顶 120s，最多 QUEUE_MAX_RETRIES 次（默认 10 次，总等待
 *      可达十余分钟），与官方桌面版的排队等候行为对齐。等待期间通过 sink.heartbeat
 *      发 SSE 保活注释，客户端感知不到中断。
 *   2. 配额耗尽短路：消息给出明确重置时刻时（如"将在 2026-08-20 09:08:51 UTC+8
 *      重置"），重置前重试多少次都会被拒，立即返回带重置时间的错误，不让用户干等。
 *
 * 契约：rateLimited → 指数退避重试（不与逐请求重试混算）；quota 短路（重置时刻
 * 可解析）→ 立即失败并回传重置时间；其余错误不进本层。
 */

import { StreamDriver } from './stream-driver.js';
import { WEDGE_ERROR_CODE, isRateLimited, parseQuotaResetAt } from './error-classifier.js';
// attempt state 写入原语（批9 #4）：迭代器挂起/归还经 attempt.js，不再直写 state.iterator
import { setIterator, clearIterator } from './attempt.js';

// 错误分类知识（isRateLimited / parseQuotaResetAt）定义已迁 error-classifier.js
// （分类学单点，refactor-20260928-arch-deepening2 批1）；本模块保持为导出点，
// 签名与正则语义不动（tests/rate-limit.test.js 锁定）。
export { isRateLimited, parseQuotaResetAt };

// 三个参数均可通过环境变量调整。
export const QUEUE_MAX_RETRIES = Number(process.env.QUEUE_MAX_RETRIES) || 10;
export const QUEUE_BASE_DELAY_MS = Number(process.env.QUEUE_BASE_DELAY_MS) || 10 * 1000;  // 首次延迟 10s（原 30s，减少"卡住"感知）
export const QUEUE_MAX_DELAY_MS = Number(process.env.QUEUE_MAX_DELAY_MS) || 120 * 1000;

/**
 * 第 attempt 次重试前的等待时长（指数退避，封顶 QUEUE_MAX_DELAY_MS）：
 * 30s → 60s → 120s → 120s → ...
 */
export function rateLimitDelayMs(attempt) {
  return Math.min(QUEUE_BASE_DELAY_MS * 2 ** Math.max(0, attempt - 1), QUEUE_MAX_DELAY_MS);
}

/**
 * 执行 prompt 事件流，遇到频控/排队时退避重试（排队机制）。
 *
 * 从 OpenAiHandler 方法拆为独立函数；handler 保留薄包装以维持测试注入点
 * （_rateLimitDelayMs）与 pending 状态访问（hasPending）。
 *
 * @param {object} opts
 * @param {string} opts.key 会话隔离键（日志用）
 * @param {object} opts.client AcpClient
 * @param {string} opts.sessionId
 * @param {object|Array} opts.prompt ACP prompt content blocks
 * @param {() => boolean} opts.isAborted 客户端断开检测
 * @param {object} opts.sink StreamDriver 事件消费者
 * @param {object} opts.state 消费状态（content/reasoning/usage/toolCall/iterator）
 * @param {() => boolean} opts.hasPending 该 key 是否有挂起的工具调用
 *        （挂起时 driver.run() 返回后不得关闭底层流，等工具结果回传染跑）
 * @param {(attempt: number) => number} [opts.delayMsFn] 退避时长（测试注入短值）
 * @returns {Promise<*>} driver.run() 的返回值
 */
export async function runWithRateLimitRetry({
  key, client, sessionId, prompt, isAborted, sink, state, hasPending, delayMsFn = rateLimitDelayMs
}) {
  let attempt = 0;
  for (;;) {
    const iterator = client.sendPrompt(prompt, sessionId)[Symbol.asyncIterator]();
    setIterator(state, iterator);

    const driver = new StreamDriver({
      iterator,
      client,
      isAborted,
      sink
    });

    try {
      const result = await driver.run();
      // 工具挂起时流保留（pending 表持有，等客户端回传工具结果续跑）；
      // 其余情况（正常结束 / 超时 / abort）关闭底层流，避免连接上残留未结束的
      // prompt——否则后续请求复用到该连接会与旧 prompt 并发，触发 interceptorGate 重试。
      if (!hasPending()) {
        state.iterator?.return?.().catch?.(() => {});
      }

      // 静默失败检测：WorkBuddy 频控时不返回 error 事件，而是返回空 RESULT
      //（无内容、无 reasoning、无工具调用、0 usage）。此时 driver.run() 正常返回，
      // 重试逻辑不会触发。检测空结果并抛错，让 catch 分支走退避重试。
      // ⚠ finalized 守卫：soft-timeout / 客户端中断两条路径的 sink（onTimeout /
      // onDone）已经结束请求（写完 [DONE]、res.end、释放连接）——此时 run() 也是
      // 正常返回，若再抛"空结果"会对一个已终结的请求重新发 prompt（重复计费 +
      // 双记账），所以终结后不再做静默失败检测。
      const hasContent = state?.content?.length > 0;
      const hasReasoning = state?.reasoning?.length > 0;
      const hasToolCall = state?.toolCall;
      const hasUsage = state?.usage && (state.usage.prompt_tokens > 0 || state.usage.completion_tokens > 0);
      if (!state.finalized && !hasContent && !hasReasoning && !hasToolCall && !hasUsage) {
        throw new Error('429 silent empty result (WorkBuddy rate-limited, no model output)');
      }

      return result;
    } catch (error) {
      // 流异常退出（throw 路径）：底层 sendPrompt 生成器可能仍挂起在 yield 上，
      // 不显式 return 的话 finally 永不执行 → _inflightPrompts 永久不归零，
      // 该后端会被连接池永久排除（hasInflightPrompt 守卫），重试还会在同一连接
      // 上发起第二个并发 prompt（interceptorGate 串台场景）。防御性归还。
      state.iterator?.return?.().catch?.(() => {});
      clearIterator(state);

      const message = error?.message || '';
      // 类型化短路（优先）：假死错误带 WEDGE_ERROR_CODE（firstTokenTimeoutError 工厂
      // 单点设置）——永不进频控退避。「消息避开 isRateLimited 识别词」的措辞契约保留
      // 为历史兜底（first-token-guard.md 措辞钉死）；isRateLimited 签名与正则不动。
      if (error?.code === WEDGE_ERROR_CODE || !isRateLimited(message) || attempt >= QUEUE_MAX_RETRIES) {
        throw error;
      }

      const delayMs = delayMsFn(attempt + 1);

      // 配额耗尽短路：消息给出明确重置时刻时，排队无意义——在重置之前重试
      // 多少次都会被拒，与其让用户干等满 10 次（约 17 分钟）后才看到失败，
      // 不如立即返回带重置时间的错误。
      // 例外：重置时刻近于本次退避时长时（含已过期，untilResetMs 为负），
      // 等一轮过去即可，走正常重试。
      const resetAt = parseQuotaResetAt(message);
      if (resetAt !== null) {
        const untilResetMs = resetAt - Date.now();
        if (untilResetMs > delayMs) {
          const resetInS = Math.round(untilResetMs / 1000);
          console.warn(
            `[buddy2api] WorkBuddy 配额已用尽，将在 ${new Date(resetAt).toLocaleString()} 重置` +
            `（约 ${resetInS}s 后）；排队重试在重置前不会成功，立即返回错误`
          );
          throw new Error(
            `WorkBuddy 配额已用尽，将在 ${new Date(resetAt).toLocaleString()} 重置` +
            `（约 ${resetInS}s 后）。排队重试在重置前不会成功，请稍后再试。原始消息：${message}`
          );
        }
      }

      const waitedTotalS = Math.round(
        Array.from({ length: attempt }, (_, i) => rateLimitDelayMs(i + 1)).reduce((a, b) => a + b, 0) / 1000
      );
      console.warn(
        `[buddy2api] WorkBuddy 排队/频控 key=${key}，第 ${attempt + 1}/${QUEUE_MAX_RETRIES} 次重试，` +
        `本次等待 ${Math.round(delayMs / 1000)}s（累计已等 ${waitedTotalS}s）`
      );

      // 等待期间心跳保活（流式），客户端看不到中断；非流式 sink.heartbeat 为 undefined 则跳过
      // 心跳间隔缩短到 3s（原 10s），并在注释中附带排队进度，让用户看到服务没卡死
      const stepMs = 3 * 1000;
      const deadline = Date.now() + delayMs;
      let heartbeatCount = 0;
      while (Date.now() < deadline) {
        try {
          heartbeatCount++;
          const waitedS = Math.round((Date.now() - (deadline - delayMs)) / 1000);
          sink.heartbeat?.(`: 排队中，已等待 ${waitedS}s（第 ${attempt + 1}/${QUEUE_MAX_RETRIES} 次重试）`);
        } catch { /* ignore */ }
        await new Promise(r => setTimeout(r, Math.min(stepMs, deadline - Date.now())));
        if (isAborted?.()) throw error; // 等待期间客户端断开，立即放弃重试
      }

      attempt++;
    }
  }
}

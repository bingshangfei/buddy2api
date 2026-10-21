/**
 * sink-factory 单测（node:test，零依赖）。
 *
 * 覆盖两种 emit 模式（stream 写 SSE / accumulate 只累加）、共享处理器行为，
 * 以及本任务新增的思考可见性 gate（切片 P3：M18–M26 / F5）。
 *
 * ⚠ 迁移说明（测试矩阵「测试方法学约束 4」）：本文件原先两条用例以
 * 「不传 thinkingEnabled」断言 reasoning_content 存在——在 `!== false`
 * （缺省=开）口径下它们**仍会通过**但**不再证明契约**（静默漂移）。
 * 现已改为显式传 `true`，并补显式 `false` 的否证对偶（M19 / M22）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSink } from '../src/sink-factory.js';
import { SSE_DONE } from '../src/openai-wire.js';

const BASE = {
  key: 'k1',
  completionId: 'cmpl-1',
  created: 123,
  model: 'auto',
  onToolCall: () => null,
  onTimeout: () => null,
  onDone: () => null
};

/**
 * 极简 res 桩：收集写入的 chunk。
 * writableEnded 只在 end() 时置位——「收尾后不得再写」类断言依赖这一点，
 * 若桩自己丢弃写入（恒 false），断言会退化成恒真。
 */
function fakeRes() {
  return { chunks: [], writableEnded: false, write(c) { this.chunks.push(c); }, end() { this.writableEnded = true; } };
}

const frameText = (res) => res.chunks.join('');

// ============ 既有契约（已迁移为显式传参） ============

test('createSink: stream 模式把 delta/reasoning 写成 SSE chunk 并累加 state', () => {
  const res = fakeRes();
  const state = { content: '', reasoning: '', usage: {}, thinkingEnabled: true };
  const sink = createSink({ ...BASE, emit: 'stream', state, res });

  sink.onDelta('Hello');
  sink.onDelta(' world');
  sink.onReasoning('thinking');

  assert.equal(state.content, 'Hello world');
  assert.equal(state.reasoning, 'thinking');
  assert.equal(res.chunks.length, 3);
  assert.match(res.chunks[0], /"content":"Hello"/);
  assert.match(res.chunks[2], /"reasoning_content":"thinking"/);
});

test('createSink: accumulate 模式只累加 state，不写任何 chunk，无心跳', () => {
  const res = fakeRes();
  const state = { content: '', reasoning: '', usage: {}, thinkingEnabled: true };
  const sink = createSink({ ...BASE, emit: 'accumulate', state, res });

  sink.onDelta('Hello');
  sink.onReasoning('thinking');
  sink.heartbeat?.();

  assert.equal(state.content, 'Hello');
  assert.equal(res.chunks.length, 0, '非流式不应产生任何写入');
  assert.equal(sink.heartbeat, undefined, '非流式不需要心跳');
});

test('createSink: 心跳写 SSE 注释行（客户端自动忽略，仅保活）', () => {
  const res = fakeRes();
  const sink = createSink({ ...BASE, emit: 'stream', state: { content: '' }, res });
  sink.heartbeat();
  assert.equal(res.chunks[0], ': keep-alive\n\n');
});

test('createSink: onProgress 去重 + 流式转发为 reasoning_content，不污染 state', () => {
  const res = fakeRes();
  const state = { content: '', reasoning: '', usage: {}, thinkingEnabled: true };
  const sink = createSink({ ...BASE, emit: 'stream', state, res });

  sink.onProgress('正在压缩上下文', 'compact');
  sink.onProgress('正在压缩上下文', 'compact'); // 重复 → 去重
  sink.onProgress('其他阶段', 'other');

  assert.equal(res.chunks.length, 2, '重复进度只转发一次');
  assert.equal(state.reasoning, '', '进度不写入 state.reasoning');
});

test('createSink: onUsage 写回 state', () => {
  const state = { usage: {} };
  const sink = createSink({ ...BASE, emit: 'accumulate', state });
  sink.onUsage({ prompt_tokens: 10, completion_tokens: 2 });
  assert.deepEqual(state.usage, { prompt_tokens: 10, completion_tokens: 2 });
});

test('createSink: onError 记日志后抛原始消息（供频控重试判断）', () => {
  const sink = createSink({ ...BASE, emit: 'accumulate', state: {} });
  assert.throws(() => sink.onError('429 rate limited'), /429 rate limited/);
});

// ============ M18–M20：onReasoning 的 gate（含 I-2 无条件累加） ============

test('M18: thinkingEnabled=true → 发射 reasoning_content 帧，且 state.reasoning 累加', () => {
  const res = fakeRes();
  const state = { content: '', reasoning: '', usage: {}, thinkingEnabled: true };
  const sink = createSink({ ...BASE, emit: 'stream', state, res });

  sink.onReasoning('思考');

  assert.match(frameText(res), /"reasoning_content":"思考"/);
  assert.equal(state.reasoning, '思考');
});

test('M19: thinkingEnabled=false → 不发帧，但 state.reasoning **仍累加**（INV-2.1 硬约束）', () => {
  const res = fakeRes();
  const state = { content: '', reasoning: '', usage: {}, thinkingEnabled: false };
  const sink = createSink({ ...BASE, emit: 'stream', state, res });

  sink.onReasoning('思考');

  assert.ok(!frameText(res).includes('reasoning_content'), '关思考 → 客户端不得看到思考帧');
  assert.equal(
    state.reasoning, '思考',
    '⚠ 累加必须在 gate 之前：置后会让 hasReasoning 失真 → 静默空结果误判 → 退避重试 → 重复计费'
  );
});

test('M20: thinkingEnabled 缺省（undefined）→ 仍发射（缺省 = 开，!== false 口径）', () => {
  const res = fakeRes();
  const state = { content: '', reasoning: '', usage: {} };
  const sink = createSink({ ...BASE, emit: 'stream', state, res });

  sink.onReasoning('思考');

  assert.match(frameText(res), /"reasoning_content":"思考"/, '漏写字段时必须与「默认开」同向，不得静默变关');
});

// ============ M21–M25：onProgress 的 gate（保活 + 去重 + 形状） ============

test('M21: thinkingEnabled=true → 阶段文案照旧写进 reasoning_content（既有行为不回归）', () => {
  const res = fakeRes();
  const state = { content: '', reasoning: '', usage: {}, thinkingEnabled: true };
  const sink = createSink({ ...BASE, emit: 'stream', state, res });

  sink.onProgress('正在压缩上下文…', 'compact');

  assert.match(frameText(res), /"reasoning_content":"正在压缩上下文…"/);
});

test('M22: thinkingEnabled=false → 无 reasoning_content 帧，改发 SSE 注释（保活不占 reasoning 通道）', () => {
  const res = fakeRes();
  const state = { content: '', reasoning: '', usage: {}, thinkingEnabled: false };
  const sink = createSink({ ...BASE, emit: 'stream', state, res });

  sink.onProgress('正在压缩上下文…', 'compact');

  const text = frameText(res);
  assert.ok(!text.includes('reasoning_content'), '开关关闭时阶段文案不得再走 reasoning 通道（否则契约只执行一半）');
  assert.ok(text.includes('正在压缩上下文…'), '文案本身要保留——服务没卡死的可观测性');
  assert.ok(!/^data: /m.test(text), '注释行不是 data 帧（客户端自动忽略）');
});

test('M23: 关思考 + 同一文案重复 → 去重仍生效，且 firstOutputAt 在去重**之前**已置位', () => {
  const res = fakeRes();
  const state = { content: '', reasoning: '', usage: {}, thinkingEnabled: false };
  const sink = createSink({ ...BASE, emit: 'stream', state, res });

  sink.onProgress('正在压缩上下文…', 'compact');
  const afterFirst = state.firstOutputAt;
  sink.onProgress('正在压缩上下文…', 'compact'); // 重复
  sink.onProgress('正在压缩上下文…', 'compact'); // 重复

  assert.equal(res.chunks.length, 1, '重复进度只转发一次（去重未被注释路径破坏）');
  assert.equal(typeof afterFirst, 'number', 'firstOutputAt 必须置位（与 driver 的 _gotOutput 口径一致，否则汇总日志误报）');
  assert.equal(state.firstOutputAt, afterFirst, '后续重复不得改变 firstOutputAt');
});

test('M24: 关思考 + 仅 progress 后接 onError → 形状钉死（progress 不进 reasoning，不新增重试路径）', () => {
  const res = fakeRes();
  const state = { content: '', reasoning: '', usage: {}, thinkingEnabled: false };
  const sink = createSink({ ...BASE, emit: 'stream', state, res });

  sink.onProgress('正在压缩上下文…', 'compact');
  assert.throws(() => sink.onError('429 rate limited'), /429 rate limited/);

  assert.equal(state.reasoning, '', 'progress 有意不累加进 reasoning（既有设计，本次不变）');
  assert.ok(!frameText(res).includes('reasoning_content'));
});

test('M25: 心跳与 progress 注释并存 → 心跳仍工作，二者都不是 data 帧', () => {
  const res = fakeRes();
  const sink = createSink({ ...BASE, emit: 'stream', state: { content: '', thinkingEnabled: false }, res });

  sink.heartbeat();
  // 用生产真实入参（queue-policy 排队路径）：心跳文案自带 `: ` 前缀
  sink.heartbeat(': 排队中，已等待 30s（第 1/3 次重试）');
  sink.onProgress('正在压缩上下文…', 'compact');

  assert.equal(res.chunks[0], ': keep-alive\n\n');
  assert.equal(res.chunks[1], ': 排队中，已等待 30s（第 1/3 次重试）\n\n');
  assert.ok(res.chunks.every(c => !/^data: /m.test(c)), '保活注释一律不是 data 帧');
});

test('M22 边界: progress 文案含换行 → 必须清洗成单行注释，不得造出伪 SSE 帧', () => {
  // 本路径把上游文案从 reasoning_content（JSON 编码，天然转义）搬到裸文本注释行——
  // 不清洗的话，文案里一个换行加 `data: ` 前缀就是一条客户端会当真的帧。
  const res = fakeRes();
  const state = { content: '', reasoning: '', usage: {}, thinkingEnabled: false };
  const sink = createSink({ ...BASE, emit: 'stream', state, res });

  sink.onProgress('压缩中\ndata: {"choices":[{"delta":{"content":"注入"}}]}\r\n伪造行', 'compact');

  const text = frameText(res);
  assert.ok(!/^data: /m.test(text), `注释不得包含任何 data 帧行，实际：${JSON.stringify(text)}`);
  assert.equal(text.split('\n\n').filter(Boolean).length, 1, '整体只应有一条注释行');
  assert.match(text, /压缩中/);
});

test('F5: 关思考时 progress 先于 reasoning 到达 → 两者各自独立 gate，wire 上均无 reasoning_content', () => {
  const res = fakeRes();
  const state = { content: '', reasoning: '', usage: {}, thinkingEnabled: false };
  const sink = createSink({ ...BASE, emit: 'stream', state, res });

  sink.onProgress('阶段一', 'compact');
  sink.onReasoning('思考');
  sink.onProgress('阶段二', 'other');

  const text = frameText(res);
  assert.ok(!text.includes('reasoning_content'), '两条通道各自 gate，合并处理会漏掉一条');
  assert.match(text, /阶段一/);
  assert.match(text, /阶段二/);
  assert.equal(state.reasoning, '思考', 'reasoning 仍无条件累加');
  assert.equal(typeof state.firstOutputAt, 'number', 'progress 已置位 firstOutputAt');
});

// ============ M26：收尾后惰性 ============

test('M26: 收尾后 onReasoning / onProgress 再到达 → wire 不再变（迟到事件不得污染已结束的流）', () => {
  const res = fakeRes();
  const state = { content: '', reasoning: '', usage: {}, thinkingEnabled: true };
  const sink = createSink({ ...BASE, emit: 'stream', state, res, onDone: () => res.end() });

  sink.onDelta('正文');
  sink.onDone();
  const frozen = frameText(res);
  const countAtDone = res.chunks.length;

  sink.onReasoning('迟到的思考');
  sink.onProgress('迟到的阶段', 'late');

  assert.equal(res.chunks.length, countAtDone, '客户端已收到 [DONE]/流已结束 → 任何后续写入都必须被拦在 wire 之外');
  assert.equal(frameText(res), frozen);
  assert.ok(!frameText(res).includes('迟到的'), '迟到事件的内容不得出现');
});

test('M26 反向对照: 同一序列不调用 onDone → 迟到事件确实会写入（证明上一条拦的是收尾状态）', () => {
  const res = fakeRes();
  const state = { content: '', reasoning: '', usage: {}, thinkingEnabled: true };
  const sink = createSink({ ...BASE, emit: 'stream', state, res, onDone: () => res.end() });

  sink.onReasoning('未收尾的思考');

  assert.match(frameText(res), /未收尾的思考/, '未收尾时必须写入，否则上一条用例可能只是恒真');
});

// ============ 既有导出（防误删） ============

test('SSE_DONE 哨兵由 openai-wire 导出（收尾契约依赖；批4 帧词汇迁家）', () => {
  assert.equal(SSE_DONE, 'data: [DONE]\n\n');
});

// ============ 终态帧词汇（refactor-20260928-arch-deepening2 批3） ============

test('abortWithError：error 帧 + [DONE] + res.end（_finalizeMidStreamError / C 路径 onTimeout 形态）', () => {
  const res = fakeRes();
  const state = { content: '', reasoning: '', usage: null };
  const sink = createSink({ ...BASE, emit: 'stream', state, res });

  sink.abortWithError('后端假死');

  assert.equal(res.chunks.length, 2);
  const parsed = JSON.parse(res.chunks[0].slice(6).trim());
  assert.deepEqual(parsed, { error: { message: '后端假死', type: 'server_error' } });
  assert.equal(res.chunks[1], SSE_DONE);
  assert.equal(res.writableEnded, true, '必须终止流（不终止 = 客户端挂死）');
});

test('abortWithError：sseDone=false 时无 [DONE]（catch B 现状逐字保持，审视 F7）', () => {
  const res = fakeRes();
  const state = { content: '', reasoning: '', usage: null };
  const sink = createSink({ ...BASE, emit: 'stream', state, res });

  sink.abortWithError('boom', { sseDone: false });

  assert.equal(res.chunks.length, 1, '只有 error 帧，无 [DONE]');
  assert.equal(res.writableEnded, true);
});

test('abortWithError：client-gone（writableEnded）时静默丢弃（resWriter 门，与 anthropic isClosed 门同责）', () => {
  const res = fakeRes();
  res.writableEnded = true; // 模拟客户端已断开
  const state = { content: '', reasoning: '', usage: null };
  const sink = createSink({ ...BASE, emit: 'stream', state, res });

  assert.doesNotThrow(() => sink.abortWithError('boom'));
  assert.equal(res.chunks.length, 0, 'ended 后写入被 resWriter 静默丢弃（旧行为：catch B 直写同走 resWriter）');
});

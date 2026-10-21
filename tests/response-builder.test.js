/**
 * response-builder 单测（node:test，零依赖）——切片 P4 收尾口径（M27–M31）。
 *
 * 为什么单独一份：`tests/suspend-tool-call.test.js:15` 与
 * `tests/anthropic-isolation.test.js:27` 都**覆写**了 handler 的
 * `_buildToolCallResponse`，真实实现（`src/response-builder.js`）在既有测试里
 * 零覆盖——本次给 `buildToolCallResponse` 新增 `reasoning_content` 字段，
 * 不直测真实实现就等于没测（矩阵 M29/M30 的强制要求）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildFinalResponse, buildToolCallResponse } from '../src/response-builder.js';

const TOOL_EVENT = { reqId: 'req-1', name: 'get_weather', args: { city: 'SF' }, toolCallId: 'call_1' };

function stateWith(extra = {}) {
  return { content: '', reasoning: '', usage: {}, ...extra };
}

// ---------- M27 / M28：自然结束 ----------

test('M27: thinkingEnabled=true 且 state.reasoning 非空 → message.reasoning_content 存在（既有行为不回归）', () => {
  const out = buildFinalResponse(stateWith({ content: '答案', reasoning: '思考', thinkingEnabled: true }), 'c1', 1, 'auto');
  const msg = out.choices[0].message;
  assert.equal(msg.reasoning_content, '思考');
  assert.equal(msg.content, '答案');
  assert.equal(out.choices[0].finish_reason, 'stop');
});

test('M28: thinkingEnabled=false → 无 reasoning_content；content 为 ""（形状钉死，与关闭前同形）', () => {
  const out = buildFinalResponse(stateWith({ content: '', reasoning: '思考', thinkingEnabled: false }), 'c1', 1, 'auto');
  const msg = out.choices[0].message;
  assert.ok(!('reasoning_content' in msg), '关思考 → 不得回显（即使 state.reasoning 已累加）');
  assert.equal(msg.content, '', 'content 形状保持既有 ""，本次不做 ""/null 统一（Out of scope）');
});

test('M28 附: reasoning 为空时不论开关都不挂字段（避免空串字段污染既有客户端载荷）', () => {
  for (const flag of [true, false, undefined]) {
    const msg = buildFinalResponse(stateWith({ content: 'x', thinkingEnabled: flag }), 'c1', 1, 'auto').choices[0].message;
    assert.ok(!('reasoning_content' in msg), `thinkingEnabled=${flag} + 空 reasoning 不应挂字段`);
  }
});

// ---------- M29 / M30：工具挂起（本次新增字段） ----------

test('M29: 工具挂起 + thinkingEnabled=true → reasoning_content 存在（补齐与自然结束的口径）', () => {
  const out = buildToolCallResponse(stateWith({ content: '先查一下', reasoning: '我要调天气', thinkingEnabled: true }), TOOL_EVENT, 'c1', 1, 'auto');
  const msg = out.choices[0].message;
  assert.equal(msg.reasoning_content, '我要调天气');
  assert.equal(out.choices[0].finish_reason, 'tool_calls');
  assert.equal(msg.tool_calls.length, 1);
});

test('M30: 工具挂起 + thinkingEnabled=false → 无 reasoning_content，且 tool_calls 结构不受影响', () => {
  const out = buildToolCallResponse(stateWith({ reasoning: '我要调天气', thinkingEnabled: false }), TOOL_EVENT, 'c1', 1, 'auto');
  const msg = out.choices[0].message;
  assert.ok(!('reasoning_content' in msg));
  assert.equal(msg.tool_calls[0].id, 'call_1');
  assert.equal(msg.tool_calls[0].type, 'function');
  assert.equal(msg.tool_calls[0].function.name, 'get_weather');
  assert.equal(msg.tool_calls[0].function.arguments, '{"city":"SF"}');
  assert.equal(msg.content, null, '工具挂起的 content 既有形状为 null（与自然结束的 "" 不同，本次不动）');
});

// ---------- M31：缺省口径两条路径同向 ----------

test('M31: thinkingEnabled 缺省（undefined）→ 两条收尾路径与 true 同口径（!== false）', () => {
  const finalMsg = buildFinalResponse(stateWith({ reasoning: '思考' }), 'c1', 1, 'auto').choices[0].message;
  const toolMsg = buildToolCallResponse(stateWith({ reasoning: '思考' }), TOOL_EVENT, 'c1', 1, 'auto').choices[0].message;
  assert.equal(finalMsg.reasoning_content, '思考');
  assert.equal(toolMsg.reasoning_content, '思考', '缺省 = 开：非 router 调用方（测试/脚本）不得静默失去思考');
});

test('M31 一致性: 同一 state 下两条收尾路径的 reasoning_content 开关结果必须一致（INV-2.6）', () => {
  for (const flag of [true, false, undefined]) {
    const s = () => stateWith({ content: 'x', reasoning: 'r', thinkingEnabled: flag });
    const hasFinal = 'reasoning_content' in buildFinalResponse(s(), 'c', 1, 'm').choices[0].message;
    const hasTool = 'reasoning_content' in buildToolCallResponse(s(), TOOL_EVENT, 'c', 1, 'm').choices[0].message;
    assert.equal(
      hasFinal, hasTool,
      `thinkingEnabled=${flag}：同一请求参数下「是否调工具」不得决定客户端能否看到思考（不可解释的行为分叉）`
    );
  }
});

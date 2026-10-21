/**
 * openai-wire 单测（node:test，零依赖）——OpenAI SSE 帧词汇唯一 interface 的字节矩阵。
 *
 * 批4 交付面：原始编码器（sseChunk / SSE_DONE / sseUsageChunk，自 stream-driver 迁入）
 * + 复合终态帧（errorFrame / toolSuspendFrames，自 sink-factory 闭包提纯）。
 * 字节形状是被 handler-path-contract / sink-factory.test 钉死的锚——本文件把形状
 * 断言收敛到帧的家，任何漂移在此先红。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sseChunk, SSE_DONE, sseUsageChunk, errorFrame, toolSuspendFrames } from '../src/openai-wire.js';

test('sseChunk: 生成标准 SSE 数据行（含 finish_reason 默认 null）', () => {
  const line = sseChunk('cmpl-1', 123, 'auto', { content: 'hi' });
  assert.ok(line.startsWith('data: '));
  const parsed = JSON.parse(line.slice(6).trim());
  assert.equal(parsed.object, 'chat.completion.chunk');
  assert.equal(parsed.id, 'cmpl-1');
  assert.equal(parsed.model, 'auto');
  assert.equal(parsed.choices[0].delta.content, 'hi');
  assert.equal(parsed.choices[0].finish_reason, null);
});

test('sseChunk: 可指定 finish_reason（tool_calls / stop）', () => {
  const tc = sseChunk('c', 1, 'm', {}, 'tool_calls');
  assert.equal(JSON.parse(tc.slice(6).trim()).choices[0].finish_reason, 'tool_calls');
  const stop = sseChunk('c', 1, 'm', {}, 'stop');
  assert.equal(JSON.parse(stop.slice(6).trim()).choices[0].finish_reason, 'stop');
});

test('SSE_DONE: 常量正确', () => {
  assert.equal(SSE_DONE, 'data: [DONE]\n\n');
});

test('sseUsageChunk: choices 空数组 + usage 字段（include_usage 语义）', () => {
  const line = sseUsageChunk('c', 1, 'm', { prompt_tokens: 3, completion_tokens: 5 });
  const parsed = JSON.parse(line.slice(6).trim());
  assert.deepEqual(parsed.choices, []);
  assert.deepEqual(parsed.usage, { prompt_tokens: 3, completion_tokens: 5 });
  assert.equal(parsed.object, 'chat.completion.chunk');
});

test('errorFrame: type=server_error 字节锚（abortWithError 载荷）', () => {
  const line = errorFrame('后端假死');
  assert.equal(line, `data: ${JSON.stringify({ error: { message: '后端假死', type: 'server_error' } })}\n\n`);
});

test('toolSuspendFrames: 三元组按序 = tool_calls 帧 + tool_calls 收尾帧 + [DONE]', () => {
  const frames = toolSuspendFrames(
    { toolCallId: 'call-9', name: 'read_file', args: { path: 'a.txt' } },
    'cmpl-1', 123, 'auto'
  );
  assert.equal(frames.length, 3);

  const first = JSON.parse(frames[0].slice(6).trim());
  assert.deepEqual(first.choices[0].delta.tool_calls, [{
    index: 0, id: 'call-9', type: 'function',
    function: { name: 'read_file', arguments: JSON.stringify({ path: 'a.txt' }) }
  }]);
  assert.equal(first.choices[0].finish_reason, null);

  const second = JSON.parse(frames[1].slice(6).trim());
  assert.equal(second.choices[0].finish_reason, 'tool_calls');
  assert.deepEqual(second.choices[0].delta, {});

  assert.equal(frames[2], SSE_DONE);
});

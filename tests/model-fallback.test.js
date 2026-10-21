/**
 * 模型自动回退单测（node:test，零依赖）。
 *
 * 覆盖 model-policy.pickFallbackModel 的优先级排序（用户指定：免费 > 费率低 > 多模态，
 * 字典序互不干扰）与 openai-handler._isBackendConnError 的连接类错误识别。
 * 排序三例自批1 起直测纯函数（不再经 handler 实例）；数据表即锁定断言。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OpenAiHandler } from '../src/openai-handler.js';
import { pickFallbackModel, FALLBACK_MODELS, KNOWN_FREE_UNLISTED } from '../src/model-policy.js';

test('模型回退选择：免费 > 低费率 > 多模态（字典序，互不干扰）', () => {
  const models = [
    { id: 'paid-expensive', name: 'Expensive', coefficient: 1.2 },
    { id: 'paid-vision', name: 'Vision Model', coefficient: 0.8 },
    { id: 'free-vision', name: 'Free VL', free: true },
    { id: 'free-zero', name: 'Free Zero', free: true, coefficient: 0 },
    { id: 'cheap-text', name: 'Cheap', coefficient: 0.05 }
  ];
  // 第一优先级：免费（free-zero 费率 0 最低；free-vision 未标注费率视为最贵）
  assert.equal(pickFallbackModel(models, 'paid-expensive'), 'free-zero');
  // 失败模型被排除：排除 free-zero 后轮到 free-vision（仍是免费组）
  assert.equal(pickFallbackModel(models, 'free-zero'), 'free-vision');
  // 免费组全排除：低费率组（cheap-text 0.05 < paid-vision 0.8）
  const noFree = models.filter(m => !m.free);
  assert.equal(pickFallbackModel(noFree, 'paid-expensive'), 'cheap-text');
});

test('模型回退选择：同费率时多模态优先', () => {
  const sameRate = [
    { id: 'text-a', name: 'Text A', free: true, coefficient: 0 },
    { id: 'vision-a', name: 'Vision A', free: true, coefficient: 0 }
  ];
  assert.equal(pickFallbackModel(sameRate, 'other'), 'vision-a');
});

test('模型回退选择：空列表/全排除返回 null', () => {
  assert.equal(pickFallbackModel([], 'x'), null);
  assert.equal(pickFallbackModel([{ id: 'a' }], 'a'), null);
  assert.equal(pickFallbackModel(undefined, 'a'), null);
});

test('兜底列表与免费白名单锚定（hy4-preview-f 契约，批1）', () => {
  // hy4-preview-f 是免费默认模型的字面量锚（resolveDefaultModel/KNOWN_FREE_UNLISTED/FALLBACK_MODELS 三处一致）
  assert.ok(KNOWN_FREE_UNLISTED.has('hy4-preview-f'));
  const hy4 = FALLBACK_MODELS.find(m => m.id === 'hy4-preview-f');
  assert.ok(hy4?.free === true, 'FALLBACK_MODELS 中 hy4-preview-f 必须标记 free');
});

test('连接类错误识别：后端问题 vs 模型问题', () => {
  const handler = new OpenAiHandler('http://127.0.0.1:1');
  assert.ok(handler._isBackendConnError('connect ECONNREFUSED 127.0.0.1:56204'));
  assert.ok(handler._isBackendConnError('aborted'));
  assert.ok(handler._isBackendConnError('Error: socket hang up'));
  assert.ok(handler._isBackendConnError('read ECONNRESET'));
  assert.ok(!handler._isBackendConnError('Model not found'));
  assert.ok(!handler._isBackendConnError('429 rate limited'));
  assert.ok(!handler._isBackendConnError(''));
});

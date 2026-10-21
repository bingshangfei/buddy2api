/**
 * 模型计费链路单测（node:test，零依赖）
 *
 * 覆盖「网关标注 → 解析 → /v1/models 透传」这条链路：
 *   1. parseModelCoefficient 解析 "x0.79" 这类标注
 *   2. extractModelsFromSessionResult 把系数附到模型条目上
 *   3. handleListModels 在响应里带上 pricing，且兜底列表不能宣称不存在的 id
 *
 * 设计要点：系数缺省**不等于**免费（auto 未标注但仍计费），因此缺省时不能
 * 输出 pricing.free = true。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseModelCoefficient,
  extractModelsFromSessionResult
} from '../src/acp-events.js';
import {
  OpenAiHandler
} from '../src/openai-handler.js';
import { resolveDefaultModel, resolveRequestedModel } from '../src/model-policy.js';

// ---------- parseModelCoefficient ----------

test('parseModelCoefficient: 解析 x 前缀系数', () => {
  assert.equal(parseModelCoefficient('x0.00'), 0);
  assert.equal(parseModelCoefficient('x0.79'), 0.79);
  assert.equal(parseModelCoefficient('x1.62'), 1.62);
  assert.equal(parseModelCoefficient('x0.05'), 0.05);
});

test('parseModelCoefficient: 容忍大小写与空白', () => {
  assert.equal(parseModelCoefficient('  X0.25  '), 0.25);
  assert.equal(parseModelCoefficient('x 0.5'), 0.5);
});

test('parseModelCoefficient: 未标注或不可解析 → null', () => {
  assert.equal(parseModelCoefficient(''), null);
  assert.equal(parseModelCoefficient(undefined), null);
  assert.equal(parseModelCoefficient(null), null);
  assert.equal(parseModelCoefficient('免费'), null);
  assert.equal(parseModelCoefficient('x'), null);
  assert.equal(parseModelCoefficient('0.79'), null, '缺 x 前缀不算标注');
  assert.equal(parseModelCoefficient('x0.79 起'), null, '带尾巴不算标注');
});

// ---------- extractModelsFromSessionResult ----------

test('extractModelsFromSessionResult: 带 description 时附上 coefficient/free', () => {
  const result = {
    configOptions: [
      {
        id: 'model',
        currentValue: 'auto',
        options: [
          { value: 'auto', name: 'Auto' },
          { value: 'hy4-preview-f', name: 'Hy4 preview', description: 'x0.00' },
          { value: 'glm-5.3', name: 'GLM-5.3', description: 'x0.79' }
        ]
      }
    ]
  };
  assert.deepEqual(extractModelsFromSessionResult(result), [
    { id: 'auto', name: 'Auto' },
    { id: 'hy4-preview-f', name: 'Hy4 preview', coefficient: 0, free: true },
    { id: 'glm-5.3', name: 'GLM-5.3', coefficient: 0.79, free: false }
  ]);
});

test('extractModelsFromSessionResult: 未标注 description 不附字段（缺省≠免费）', () => {
  const result = {
    configOptions: [
      { id: 'model', options: [{ value: 'auto', name: 'Auto', description: '' }] }
    ]
  };
  const [auto] = extractModelsFromSessionResult(result);
  assert.deepEqual(auto, { id: 'auto', name: 'Auto' });
  assert.equal('free' in auto, false, '未标注不能标记为免费');
});

// ---------- handleListModels ----------

test('handleListModels: 透传 pricing 字段', async () => {
  const handler = new OpenAiHandler('http://127.0.0.1:1');
  handler.sessions.getModels = () => ([
    { id: 'hy4-preview-f', name: 'Hy4 preview', coefficient: 0, free: true },
    { id: 'glm-5.3', name: 'GLM-5.3', coefficient: 0.79, free: false },
    { id: 'auto', name: 'Auto' }
  ]);

  const res = await handler.handleListModels('k1');
  const byId = Object.fromEntries(res.data.map((m) => [m.id, m]));

  assert.deepEqual(byId['hy4-preview-f'].pricing, { coefficient: 0, free: true });
  assert.deepEqual(byId['glm-5.3'].pricing, { coefficient: 0.79, free: false });
  assert.equal('pricing' in byId['auto'], false, '未标注的模型不带 pricing');
  assert.equal(byId['hy4-preview-f'].object, 'model');
});

test('handleListModels: 兜底列表带 pricing，且不含收费的遗留 id', async () => {
  const handler = new OpenAiHandler('http://127.0.0.1:1');
  handler.sessions.getModels = () => [];
  handler.sessions.acquire = async () => { throw new Error('offline'); };

  const origWarn = console.warn;
  console.warn = () => {};
  let res;
  try {
    res = await handler.handleListModels('k1');
  } finally {
    console.warn = origWarn;
  }

  const ids = res.data.map((m) => m.id);
  assert.ok(ids.includes('hy4-preview-f'), '兜底要有免费的混元 id');
  assert.ok(!ids.includes('hy4-preview'), '兜底不能出现收费的遗留 id hy4-preview');

  const free = res.data.filter((m) => m.pricing?.free).map((m) => m.id);
  assert.deepEqual(free.sort(), ['hy3', 'hy4-preview-f']);
});

// ---------- resolveDefaultModel / resolveRequestedModel ----------

test('resolveDefaultModel: 默认是免费的 hy4-preview-f，可被环境变量覆盖', () => {
  assert.equal(resolveDefaultModel({}), 'hy4-preview-f');
  assert.equal(resolveDefaultModel({ BUDDY2API_DEFAULT_MODEL: 'auto' }), 'auto', '可退回网关自动路由');
  assert.equal(resolveDefaultModel({ BUDDY2API_DEFAULT_MODEL: 'glm-5.3-flash' }), 'glm-5.3-flash');
});

test('resolveRequestedModel: 缺省与 auto/default 走默认，具体 id 原样透传', () => {
  const fallback = 'hy4-preview-f';
  for (const absent of [undefined, null, '', 'auto', 'default']) {
    assert.equal(resolveRequestedModel(absent, fallback), fallback, `${JSON.stringify(absent)} 应回落默认模型`);
  }
  assert.equal(resolveRequestedModel('glm-5.3', fallback), 'glm-5.3');
  assert.equal(resolveRequestedModel('hy4-preview', fallback), 'hy4-preview', '不在列表里的 id 也原样透传');
});

/**
 * runtime-config 现状锚定单测（node:test，零依赖）——批6（缩形，审视 F7/F16）交付面。
 *
 * 红线：env 解析**逐 var 保现状**——本文件把两个归位变量的边界语义钉死，任何
 * 「顺手拉齐」（如把 0 变成合法值、把非整数改成钳制）都会在此变红。
 * 明确排除项：POOL_WARM_COUNT（三态语义，index.js 域，批6 明确不动）、
 * stream-driver 两 read / queue-policy 三常量（0=禁用与 0=吞默认是各自历史契约）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveDelegateReplyTimeoutMs } from '../src/acp-client.js';
import { resolvePoolConfig } from '../src/gateway-discovery.js';

test('DELEGATE_REPLY_TIMEOUT_MS 现状：缺省/置空 → 60000；正数生效；0/负/非法回落（0 非法=禁用即死等）', () => {
  assert.equal(resolveDelegateReplyTimeoutMs({}), 60 * 1000);
  assert.equal(resolveDelegateReplyTimeoutMs({ DELEGATE_REPLY_TIMEOUT_MS: '' }), 60 * 1000);
  assert.equal(resolveDelegateReplyTimeoutMs({ DELEGATE_REPLY_TIMEOUT_MS: undefined }), 60 * 1000);
  assert.equal(resolveDelegateReplyTimeoutMs({ DELEGATE_REPLY_TIMEOUT_MS: '40' }), 40);
  assert.equal(resolveDelegateReplyTimeoutMs({ DELEGATE_REPLY_TIMEOUT_MS: '0' }), 60 * 1000, '0 = 禁用 = 死等，必须回落（现状契约）');
  assert.equal(resolveDelegateReplyTimeoutMs({ DELEGATE_REPLY_TIMEOUT_MS: '-5' }), 60 * 1000);
  assert.equal(resolveDelegateReplyTimeoutMs({ DELEGATE_REPLY_TIMEOUT_MS: 'abc' }), 60 * 1000);
});

test('BUDDY2API_IDLE_TIMEOUT_MS 现状（经 resolvePoolConfig 归位）：缺省 2h；覆盖生效；0/非法回落 2h', () => {
  const base = { BUDDY2API_STATE_DIR: 'x' };
  assert.equal(resolvePoolConfig({ ...base }).idleTimeoutMs, 2 * 60 * 60 * 1000);
  assert.equal(resolvePoolConfig({ ...base, BUDDY2API_IDLE_TIMEOUT_MS: '300000' }).idleTimeoutMs, 300000);
  assert.equal(resolvePoolConfig({ ...base, BUDDY2API_IDLE_TIMEOUT_MS: '0' }).idleTimeoutMs, 2 * 60 * 60 * 1000, '0 → 回落（`Number(x)||默认` 语义逐字保留）');
  assert.equal(resolvePoolConfig({ ...base, BUDDY2API_IDLE_TIMEOUT_MS: 'abc' }).idleTimeoutMs, 2 * 60 * 60 * 1000);
  assert.equal(resolvePoolConfig({ ...base, BUDDY2API_IDLE_TIMEOUT_MS: '-1' }).idleTimeoutMs, -1, '负数是真值 → 原样透传（`Number(x)||默认` 现状逐字；走 parseBoundedInt 会改成回落=行为变更，F7c）');
});

test('POOL_WARM_COUNT 不在 resolvePoolConfig 域（批6 明确排除——三态语义归 index.js，防误并回归）', () => {
  // POOL_WARM_COUNT 的三态现状（undefined→按账号数 / >0→定数 / 0·负·NaN→静默禁用）
  // 由 index.js 顶层解析；把它并进 parseBoundedInt 会把 0 变成"回落默认预热"=行为变更
  // （审视 F7c 在案否决）。此处锚定：resolvePoolConfig 不消费该变量。
  const cfg = resolvePoolConfig({ BUDDY2API_POOL_WARM_COUNT: '0', BUDDY2API_STATE_DIR: 'x' });
  assert.equal(cfg.idleTimeoutMs, 2 * 60 * 60 * 1000, '该变量不参与池配置解析');
  assert.ok(!('poolWarmCount' in cfg), 'resolvePoolConfig 返回面不含 warm count（归位排除项）');
});

/**
 * 会话准备 seam 单测 —— `prepareSession` / `needsTools`（session-prepare.js）。
 *
 * 对应 evidence/test-matrix.md D 组（D1-D6）。批3 起直驱新模块（不再经 handler 实例）；
 * D6 不变式改写为具名例外（prd v2 / 审视 F14）：唯一性断言指向 session-prepare.js，
 * 并对 openai-handler.js 加 doesNotMatch（防第 4 份内联拷贝回流）——守护对象形态
 * 变化，不变式增强而非弱化。
 *
 * 两条不能碰的红线（逐字继承）：
 *   1. **不做 Promise.all** —— 委托工具按 sessionId 注册，漏注册是**静默退化**
 *      （不挂起、不返回 tool_calls，用户只看到半成品答案）。
 *   2. 三处的 setModel 错误策略**本来就不同**：主路径 warn-and-continue（客户端
 *      显式指定模型失败时仍继续服务），两条重试路径必须上抛（放弃重试）。
 *      用 `strictModel` 显式表达，避免"顺手统一"把重试语义改掉。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { prepareSession, needsTools, RETRY_PREPARE_POLICY } from '../src/session-prepare.js';

const SESSION_PREPARE_SRC = fs.readFileSync(fileURLToPath(new URL('../src/session-prepare.js', import.meta.url)), 'utf8');
const HANDLER_SRC = fs.readFileSync(fileURLToPath(new URL('../src/openai-handler.js', import.meta.url)), 'utf8');

/** 捕获 console.warn。**必须 await**：被测函数是异步的，告警发生在 await 之后，
 *  同步版会在 promise 结算前就还原 console.warn，产出一个恒为空的假通过。 */
async function captureWarn(fn) {
  const orig = console.warn;
  const warns = [];
  console.warn = (...a) => { warns.push(a.map(String).join(' ')); };
  try {
    const result = await fn();
    return { result, warns };
  } finally {
    console.warn = orig;
  }
}

/** 假的会话对象：记录 setModel / delegateTools 调用序列 */
function fakeSession({ models = [], setModelThrows = false, delegateThrows = false } = {}) {
  const calls = [];
  return {
    sessionId: 'sess-1',
    models,
    calls,
    client: {
      defaultModel: 'auto',
      async setModel(m, sid) {
        calls.push(['setModel', m, sid]);
        if (setModelThrows) throw new Error('setModel boom');
      },
      async delegateTools(sid, tools) {
        calls.push(['delegateTools', sid, tools]);
        if (delegateThrows) throw new Error('delegateTools boom');
      }
    }
  };
}

test('D1 正常序列：先 setModel 后 delegateTools（顺序不可换）', async () => {
  assert.equal(typeof prepareSession, 'function', '应存在 prepareSession');
  const s = fakeSession();
  const tools = [{ name: 'read_file' }];
  await prepareSession(s, { model: 'deepseek-v4.1-flash', tools, hasTools: true });
  assert.deepEqual(s.calls, [
    ['setModel', 'deepseek-v4.1-flash', 'sess-1'],
    ['delegateTools', 'sess-1', tools]
  ]);
});

test('D2 model 为 auto / default / 空 → 不调 setModel（保持既有分支语义）', async () => {
  for (const model of ['auto', 'default', '', null, undefined]) {
    const s = fakeSession();
    await prepareSession(s, { model, tools: [], hasTools: false });
    assert.deepEqual(s.calls, [], `model=${String(model)} 不该触发任何调用`);
  }
});

test('D3 hasTools=false → 不调 delegateTools', async () => {
  const s = fakeSession();
  await prepareSession(s, { model: 'm1', tools: [{ name: 'x' }], hasTools: false });
  assert.deepEqual(s.calls.map((c) => c[0]), ['setModel'], '只应调 setModel');
});

test('D4 主路径 setModel 抛错 → 仅 warn 不抛，且继续注册委托工具', async () => {
  const s = fakeSession({ setModelThrows: true });
  const { warns } = await captureWarn(() =>
    prepareSession(s, { model: 'm1', tools: [{ name: 'x' }], hasTools: true })
  );
  assert.ok(warns.length >= 1, 'setModel 失败必须告警（静默换默认模型会静默计费）');
  assert.deepEqual(s.calls.map((c) => c[0]), ['setModel', 'delegateTools'], '失败后仍要继续注册工具');
});

test('D4b 重试路径 strictModel=true → setModel 抛错必须上抛（保留"放弃重试"语义）', async () => {
  const s = fakeSession({ setModelThrows: true });
  await assert.rejects(
    () => prepareSession(s, { model: 'm1', tools: [{ name: 'x' }], hasTools: true, guardModel: false, strictModel: true }),
    /setModel boom/,
    '重试路径 setModel 失败必须上抛（否则会静默换模型继续跑）'
  );
  assert.deepEqual(s.calls.map((c) => c[0]), ['setModel'], '上抛后不应再注册工具');
});

test('D5 delegateTools 抛错 → 仅 warn 不抛（漏注册是静默退化，不得升级为请求失败）', async () => {
  const s = fakeSession({ delegateThrows: true });
  const { warns } = await captureWarn(() =>
    prepareSession(s, { model: 'm1', tools: [{ name: 'x' }], hasTools: true })
  );
  assert.ok(warns.length >= 1, '工具注册失败必须告警');
  assert.deepEqual(s.calls.map((c) => c[0]), ['setModel', 'delegateTools'], '不应因工具注册失败中断请求');
});

test('D5b guardModel=false 时不触发"未公布模型"告警（重试路径不重复刷告警）', async () => {
  const s = fakeSession({ models: [{ id: 'known-1', free: true }] });
  const { warns } = await captureWarn(() =>
    prepareSession(s, { model: 'not-advertised', tools: [], hasTools: false, guardModel: false, strictModel: true })
  );
  assert.deepEqual(warns, [], '重试路径不应重复输出"模型未公布"告警');
});

test('D5c needsTools 调用期读 env：on/off 覆盖与缺省自动（session-reuse 中途改 env 的锚）', () => {
  const env = { BUDDY2API_TOOLS: 'on' };
  assert.equal(needsTools(false, env), true, 'on 强制全量');
  env.BUDDY2API_TOOLS = 'off';
  assert.equal(needsTools(true, env), false, 'off 强制精简');
  env.BUDDY2API_TOOLS = 'auto';
  assert.equal(needsTools(true, env), true, 'auto：带 tools 用全量');
  assert.equal(needsTools(false, env), false, 'auto：纯聊天用精简');
  assert.equal(needsTools(false, {}), false, '未设 = auto');
});

test('D5d RETRY_PREPARE_POLICY 随迁锚定（三开关与主路径刻意不同）', () => {
  assert.deepEqual(RETRY_PREPARE_POLICY, { guardModel: false, strictModel: true, forceSetModel: true });
});

test('D6 收拢不变式（具名例外改写）：唯一实现指向 session-prepare.js，handler 不得再出现内联拷贝', () => {
  // 对新模块：setModel/delegateTools 各只有一处调用，且都在 prepareSession 体内
  const fnAt = SESSION_PREPARE_SRC.indexOf('export async function prepareSession(');
  assert.ok(fnAt > 0, '应存在 prepareSession');

  for (const call of ['.setModel(', '.delegateTools(']) {
    const re = new RegExp(call.replace(/[.()]/g, '\\$&'), 'g');
    const hits = [...SESSION_PREPARE_SRC.matchAll(re)];
    const lines = hits.map((h) => SESSION_PREPARE_SRC.slice(0, h.index).split('\n').length);
    assert.equal(hits.length, 1,
      `${call} 只应有一处调用（prepareSession 体内），实际 ${hits.length} 处，行号 ${lines.join(', ')}`);
    assert.ok(hits[0].index > fnAt,
      `${call} 应位于 prepareSession 体内，实际在第 ${lines[0]} 行`);
  }

  // 对 handler：不得再出现内联 setModel/delegateTools 拷贝（批3 后回归防线）
  assert.doesNotMatch(HANDLER_SRC, /\.setModel\(/, 'handler 不得再内联 setModel（应走 session-prepare）');
  assert.doesNotMatch(HANDLER_SRC, /\.delegateTools\(/, 'handler 不得再内联 delegateTools（应走 session-prepare）');

  assert.doesNotMatch(SESSION_PREPARE_SRC, /Promise\.all\(\[\s*session\.client\.setModel/, '禁止并行 setModel/delegateTools');
});

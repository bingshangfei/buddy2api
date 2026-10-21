/**
 * `_classifyError` 的表驱动契约断言（S2′ 的验证口径，见 `refactor-plan.md` §步骤 3）。
 *
 * 分工：`handler-path-contract.test.js` 从**路径侧**刻画「分类结果如何影响清理动作」
 * （BC-7，只覆盖 B 一条路径）；本文件从**分类器侧**直接锁住判定规则本身——三条路径
 * 共用它，任何一条路径的回归都可能是分类器漂移引起的，而路径侧用例只覆盖其中一条。
 *
 * 断言的是**规则**（哪些错误算假死 / 后端连接类），与实现形态无关：把判定换成
 * 别的写法（正则、集合、`instanceof`）都应保持本表全绿。
 */

// 与被测模块同源的 env 前置（模块加载时读取，故用动态 import）。
process.env.FIRST_TOKEN_TIMEOUT_MS = '600000';
process.env.STREAM_STALL_TIMEOUT_MS = '600000';

const { OpenAiHandler } = await import('../src/openai-handler.js');
const { classifyAccountFailure, isAuthFailureNarrow, isRateLimited } = await import('../src/error-classifier.js');
const { firstTokenTimeoutError } = await import('../src/openai-handler.js');
import assert from 'node:assert/strict';
import { test } from 'node:test';

/** 造一个首 token 假死错误（生产侧由 makeFirstTokenTimeoutError 构造，name 是唯一判据）。 */
function wedgeError() {
  const err = new Error('首 token 超时');
  err.name = 'FirstTokenTimeoutError';
  return err;
}

/**
 * 判定表：`[error, 期望 wedge, 期望 connError, 该行要锁住的事实]`
 *
 * 表本身是**独立的规则陈述**——不引用源码里任何表达式，因此它可以反过来证明实现。
 */
const CASES = [
  [wedgeError(), true, true, '假死是 wedge，且视同后端类（不冷却账号）'],
  [new Error('connect ECONNREFUSED 127.0.0.1:1'), false, true, 'ECONNREFUSED'],
  [new Error('read ECONNRESET'), false, true, 'ECONNRESET'],
  [new Error('ECONNABORTED'), false, true, 'ECONNABORTED'],
  [new Error('socket hang up'), false, true, 'socket hang up'],
  [new Error('request aborted'), false, true, 'aborted（来自 _isBackendConnError 的词表）'],
  [new Error('econnrefused'), false, true, '大小写不敏感'],
  [new Error('upstream model failed'), false, false, '普通上游错误：既不假死也不是后端连接类'],
  [new Error('429 Too Many Requests'), false, false, '限流错误不得被归类为后端连接类'],
  [new Error(''), false, false, '空消息'],
  [new Error(), false, false, '无消息'],
  [undefined, false, false, '无错误对象'],
  [null, false, false, 'null 错误对象']
];

test('_classifyError：判定表逐行（三条路径共用的唯一分类规则）', async () => {
  const handler = new OpenAiHandler('http://127.0.0.1:1');
  for (const [error, wedge, connError, why] of CASES) {
    assert.deepEqual(
      handler._classifyError(error),
      { wedge, connError },
      `_classifyError(${error ? `Error(${JSON.stringify(error.message)})` : String(error)}) 应为 {wedge:${wedge}, connError:${connError}} —— ${why}`
    );
  }
});

test('_classifyError：不变量 wedge ⊆ connError（假死必属后端类）', async () => {
  const handler = new OpenAiHandler('http://127.0.0.1:1');
  for (const [error, wedge] of CASES) {
    if (!wedge) continue;
    assert.equal(handler._classifyError(error).connError, true,
      '假死若被排除在 connError 之外，catch 段会去冷却账号——正是要避免的误冷却');
  }
});

test('_classifyError：判据是 error.name 与 error.message，不是整对象的文本', async () => {
  const handler = new OpenAiHandler('http://127.0.0.1:1');

  // name 命中正则、message 不命中 → 不得判为后端连接类（规则只看 message）
  const nameOnly = new Error('模型响应很慢');
  nameOnly.name = 'ECONNREFUSED';
  assert.deepEqual(handler._classifyError(nameOnly), { wedge: false, connError: false },
    '连接类词表只作用于 message；若改成 String(error) 整体匹配，本行会翻转为 true');

  // message 命中假死关键词、name 不是 FirstTokenTimeoutError → 不得判为假死（规则只看 name）
  const messageOnly = new Error('FirstTokenTimeoutError');
  assert.deepEqual(handler._classifyError(messageOnly), { wedge: false, connError: false },
    '假死判据是 name；若改成 message 包含判断，本行会翻转为 true');
});

test('_classifyError：纯判定——不改动入参、可重复调用且结果稳定', async () => {
  const handler = new OpenAiHandler('http://127.0.0.1:1');
  const err = wedgeError();
  err.statusCode = undefined;
  const before = JSON.stringify({ name: err.name, message: err.message, keys: Object.keys(err) });

  const first = handler._classifyError(err);
  const second = handler._classifyError(err);

  assert.deepEqual(first, second, '同一对象重复分类结果必须一致（无内部状态）');
  assert.equal(JSON.stringify({ name: err.name, message: err.message, keys: Object.keys(err) }), before,
    '分类器不得改动错误对象（写 statusCode / wedgeReason 之类属调用方的事）');
});

// ===== 批1（refactor-20260928-arch-deepening2）：分类学单点化后的新契约 =====

test('auth 双面：classifyFailure 宽面与探活窄面刻意不等价（合并会静默改冷却面）', () => {
  // 宽面（classifyAccountFailure / account-pool.classifyFailure 运行时路径）：
  // 多认「未登录」「unauthor」——这两个词只走运行时路径命中
  assert.equal(classifyAccountFailure('用户未登录，请重新登录'), 'auth');
  assert.equal(classifyAccountFailure('401 Unauthorized'), 'auth');
  assert.equal(classifyAccountFailure('登录态被拒绝（HTTP 401）'), 'auth');
  // 窄面（isAuthFailureNarrow / probeAccount 探活路径）：不认「未登录」单独出现
  assert.equal(isAuthFailureNarrow('用户未登录，请重新登录'), false,
    '窄面若放宽到认「未登录」，探活冷却面就被悄悄改宽（审视 F6）');
  assert.equal(isAuthFailureNarrow('登录态被拒绝（HTTP 401）'), true);
  assert.equal(isAuthFailureNarrow('401 Unauthorized'), true);
  assert.equal(isAuthFailureNarrow('socket hang up'), false);
  // 两面都不得把普通网络错误误判为 auth
  assert.equal(classifyAccountFailure('socket hang up'), 'error');
});

test('wedge 消息工厂全变体 × isRateLimited 恒 false（措辞契约表驱动固化，不靠注释传承）', () => {
  for (const final of [false, true]) {
    for (const reason of ['first-token', 'mid-stream']) {
      const err = firstTokenTimeoutError(final, reason);
      assert.equal(isRateLimited(err.message), false,
        `工厂输出（final=${final}, reason=${reason}）命中频控识别词会被 queue-policy 退避 17.5 分钟`);
    }
  }
});

test('再导出点同源：handler._classifyError 与 error-classifier.classifyError 是同一实现', async () => {
  const { classifyError } = await import('../src/error-classifier.js');
  const handler = new OpenAiHandler('http://127.0.0.1:1');
  for (const [error] of CASES) {
    assert.deepEqual(handler._classifyError(error), classifyError(error),
      '委托后两边结果必须逐行一致（消费方仍可从任一入口拿到同一判定）');
  }
});

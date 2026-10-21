/**
 * stream-driver 单测（node:test，零依赖）。
 * 用 fake iterator 验证统一消费引擎的各分支：
 * 正常消费 / 工具调用挂起 / abort 提前退出 / 软超时 / 心跳 / SSE 格式。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StreamDriver, resWriter } from '../src/stream-driver.js';

test('兼容再导出：resWriter 可从 stream-driver 导入（定义在 http-utils，架构深化十批 D6）', () => {
  assert.equal(typeof resWriter, 'function', 'resWriter 必须保持可从 stream-driver 导入（兼容旧 import 路径）');
  // 行为：断连保护写入（client gone 静默丢弃）
  const fakeRes = {
    writableEnded: false,
    write(chunk) { this.wrote = (this.wrote || '') + chunk; }
  };
  const write = resWriter(fakeRes);
  write('a');
  assert.equal(fakeRes.wrote, 'a', '正常写入不拦截');
  fakeRes.writableEnded = true;
  write('b');
  assert.equal(fakeRes.wrote, 'a', 'writableEnded 后注入被静默丢弃');
});

/** 依次产出 events 后结束的 fake iterator */
function fakeIterator(events) {
  let i = 0;
  return {
    async next() {
      if (i < events.length) return { value: events[i++], done: false };
      return { value: undefined, done: true };
    }
  };
}

function messageChunk(text) {
  return {
    method: 'session/update',
    params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } }
  };
}

function thoughtChunk(text) {
  return {
    method: 'session/update',
    params: { update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text } } }
  };
}

function progressEvent(text) {
  return {
    method: 'session/update',
    params: { update: { sessionUpdate: 'session_info_update', _meta: { 'codebuddy.ai/progress': text } } }
  };
}

function delegateToolEvent() {
  return {
    jsonrpc: '2.0', id: 'req-1', method: '_codebuddy.ai/delegateTool',
    params: { toolId: 'my_tool', input: { a: 1 }, toolCallId: 'tc-1' }
  };
}

function finalResult() {
  return { jsonrpc: '2.0', id: 'prompt-1', result: { stopReason: 'end_turn' } };
}

test('StreamDriver: 正常消费 delta/reasoning/progress + 最终结果 → onDone', async () => {
  const calls = [];
  const driver = new StreamDriver({
    iterator: fakeIterator([
      messageChunk('Hello '),
      thoughtChunk('thinking'),
      progressEvent('正在压缩上下文'),
      messageChunk('world'),
      finalResult()
    ]),
    client: {},
    sink: {
      onDelta: (t) => calls.push(['delta', t]),
      onReasoning: (t) => calls.push(['reasoning', t]),
      onUsage: () => calls.push(['usage']),
      onProgress: (t, p) => calls.push(['progress', t, p]),
      onDone: () => 'DONE-RET'
    }
  });
  assert.equal(await driver.run(), 'DONE-RET');
  assert.deepEqual(calls, [
    ['delta', 'Hello '],
    ['reasoning', 'thinking'],
    ['progress', '正在压缩上下文', undefined],
    ['delta', 'world']
  ]);
});

test('StreamDriver: delegateTool 事件 → onToolCall 挂起并停止循环', async () => {
  const calls = [];
  const driver = new StreamDriver({
    iterator: fakeIterator([messageChunk('pre'), delegateToolEvent(), messageChunk('never')]),
    client: {},
    sink: {
      onDelta: (t) => calls.push(['delta', t]),
      onToolCall: (tc) => { calls.push(['tool', tc.name, tc.reqId, tc.toolCallId]); return 'SUSPEND-RET'; }
    }
  });
  assert.equal(await driver.run(), 'SUSPEND-RET');
  assert.deepEqual(calls, [['delta', 'pre'], ['tool', 'my_tool', 'req-1', 'tc-1']]);
});

test('StreamDriver: isAborted 在循环顶生效，提前退出到 onDone', async () => {
  const calls = [];
  let polled = 0;
  const driver = new StreamDriver({
    iterator: fakeIterator([messageChunk('A'), messageChunk('B')]),
    client: {},
    // 消费完第一个事件后标记"客户端断开"（复现 _consumePending 曾缺失的检查）
    isAborted: () => ++polled > 1,
    sink: {
      onDelta: (t) => calls.push(t),
      onDone: () => 'ABORT-RET'
    }
  });
  assert.equal(await driver.run(), 'ABORT-RET');
  assert.deepEqual(calls, ['A'], '断开后不应继续消费 B');
});

test('StreamDriver: 软超时（持续无事件）→ onTimeout', async () => {
  const calls = [];
  const driver = new StreamDriver({
    iterator: { next: () => new Promise(() => {}) }, // 永不 resolve
    client: {},
    sink: { onTimeout: () => { calls.push('timeout'); return 'TIMEOUT-RET'; } },
    idleTimeoutMs: 5,
    softTimeoutMs: 30
  });
  assert.equal(await driver.run(), 'TIMEOUT-RET');
  assert.deepEqual(calls, ['timeout']);
});

test('StreamDriver: 静默期间触发 heartbeat，事件到达后正常继续', async () => {
  const beats = [];
  let calls = 0;
  const iterator = {
    next: () => new Promise((resolve) => {
      calls++;
      setTimeout(() => {
        if (calls === 1) resolve({ value: messageChunk('x'), done: false });
        else resolve({ value: undefined, done: true });
      }, 60);
    })
  };
  const driver = new StreamDriver({
    iterator,
    client: {},
    sink: {
      heartbeat: () => beats.push(1),
      onDelta: () => {},
      onDone: () => 'DONE-RET'
    },
    idleTimeoutMs: 10,
    softTimeoutMs: 500
  });
  assert.equal(await driver.run(), 'DONE-RET');
  assert.ok(beats.length >= 1, '60ms 等待期内应至少触发一次心跳');
});

test('StreamDriver: iterator 抛错 → 向上抛出而不是假装完成', async () => {
  const driver = new StreamDriver({
    iterator: { next: () => Promise.reject(new Error('upstream broken')) },
    client: {},
    sink: { onDone: () => 'SHOULD-NOT-RUN' }
  });
  await assert.rejects(() => driver.run(), /upstream broken/);
});

// （sseChunk / SSE_DONE 帧编码测试已随词汇迁家 openai-wire.test.js——批4）

test('StreamDriver: JSON-RPC error（如 429 频控）→ 立即返回 onError 并透传消息', async () => {
  const errorEvent = {
    jsonrpc: '2.0', id: 'prompt-1',
    error: { code: -32000, message: '429 您的使用量已超出频率限制，将在 2026-08-20 09:08:51 UTC+8 重置' }
  };
  const calls = [];
  const driver = new StreamDriver({
    iterator: fakeIterator([
      messageChunk('Hello '),
      errorEvent
    ]),
    client: {},
    sink: {
      onDelta: () => calls.push('delta'),
      onError: (msg) => {
        calls.push('error:' + msg);
        return 'ERROR-RET';
      },
      onDone: () => 'SHOULD-NOT-RUN'
    }
  });
  assert.equal(await driver.run(), 'ERROR-RET');
  assert.deepEqual(calls, ['delta', 'error:429 您的使用量已超出频率限制，将在 2026-08-20 09:08:51 UTC+8 重置']);
});

test('StreamDriver: error 为字符串时也透传', async () => {
  const driver = new StreamDriver({
    iterator: fakeIterator([{ jsonrpc: '2.0', id: 'p', error: 'rate limited' }]),
    client: {},
    sink: { onError: (msg) => msg }
  });
  assert.equal(await driver.run(), 'rate limited');
});

test('StreamDriver: 无 onError 时 error 事件返回 undefined（不抛错不挂起）', async () => {
  const driver = new StreamDriver({
    iterator: fakeIterator([{ jsonrpc: '2.0', id: 'p', error: { message: 'x' } }]),
    client: {},
    sink: { onDone: () => 'SHOULD-NOT-RUN' }
  });
  assert.equal(await driver.run(), undefined);
});

// ===== 首 token 守卫（bugfix-20260916-first-token-guard）=====

test('StreamDriver: 首 token 守卫 —— 零输出超过阈值 → onTimeout("first-token")', async () => {
  const calls = [];
  const driver = new StreamDriver({
    iterator: { next: () => new Promise(() => {}) }, // 永不出事件
    client: {},
    sink: { onTimeout: (reason) => { calls.push(reason); return 'FT-TIMEOUT'; } },
    idleTimeoutMs: 5,
    softTimeoutMs: 60 * 60 * 1000, // 软超时让位：验证触发的是首 token 守卫而非软超时
    firstTokenTimeoutMs: 30
  });
  assert.equal(await driver.run(), 'FT-TIMEOUT');
  assert.deepEqual(calls, ['first-token']);
});

test('StreamDriver: 非输出事件不解除首 token 守卫（计时跨事件累计，不因事件到达重置）', async () => {
  // request_permission 是合法事件但不产生用户可见输出——假死上游可能靠这类事件
  // 一直喂事件而永远不触发「连续零事件」软超时，首 token 守卫必须无视它
  const permissionEvent = {
    jsonrpc: '2.0', id: 'perm-1', method: 'session/request_permission',
    params: { sessionId: 's', toolCall: { toolCallId: 'tc' } }
  };
  const calls = [];
  let n = 0;
  const driver = new StreamDriver({
    iterator: {
      next: () => new Promise((resolve) => {
        if (++n === 1) setTimeout(() => resolve({ value: permissionEvent, done: false }), 10);
        // 其余调用永不 resolve（假死）
      })
    },
    client: {
      respondPermission: () => Promise.resolve(),
      approveToolCall: () => Promise.resolve()
    },
    sink: { onTimeout: (reason) => { calls.push(reason); return 'FT-TIMEOUT'; } },
    idleTimeoutMs: 5,
    softTimeoutMs: 60 * 60 * 1000,
    firstTokenTimeoutMs: 30
  });
  assert.equal(await driver.run(), 'FT-TIMEOUT');
  assert.deepEqual(calls, ['first-token']);
});

test('StreamDriver: 输出事件在阈值内到达后解除守卫（正常完成，不触发超时）', async () => {
  const calls = [];
  let n = 0;
  const iterator = {
    next: () => new Promise((resolve) => {
      // 首 token（30ms）早于守卫阈值（50ms）到达 → 解除守卫；随后正常结束
      setTimeout(() => resolve(++n === 1
        ? { value: messageChunk('in time'), done: false }
        : { value: undefined, done: true }), 30);
    })
  };
  const driver = new StreamDriver({
    iterator,
    client: {},
    sink: {
      onDelta: () => calls.push('delta'),
      onTimeout: () => calls.push('timeout'),
      onDone: () => 'DONE-RET'
    },
    idleTimeoutMs: 5,
    softTimeoutMs: 60 * 60 * 1000,
    firstTokenTimeoutMs: 50
  });
  assert.equal(await driver.run(), 'DONE-RET');
  assert.deepEqual(calls, ['delta'], '输出在阈值内到达，不应触发守卫');
});

test('StreamDriver: firstTokenTimeoutMs=0 禁用守卫（零输出直到软超时，reason 为 soft）', async () => {
  const calls = [];
  const driver = new StreamDriver({
    iterator: { next: () => new Promise(() => {}) },
    client: {},
    sink: { onTimeout: (reason) => { calls.push(reason); return 'TIMEOUT'; } },
    idleTimeoutMs: 5,
    softTimeoutMs: 30,
    firstTokenTimeoutMs: 0
  });
  assert.equal(await driver.run(), 'TIMEOUT');
  assert.deepEqual(calls, ['soft']);
});

// ===== 中途停滞守卫（bugfix-20260916-mid-stream-stall-guard）=====

test('StreamDriver: 输出后静默超过 stallTimeoutMs → onTimeout("mid-stream")', async () => {
  const calls = [];
  let first = true;
  const iterator = {
    next: () => new Promise((resolve) => {
      // 首个 delta @5ms 后永久静默（中途假死）；800ms 兜底 done 防测试挂死
      if (first) {
        first = false;
        setTimeout(() => resolve({ value: messageChunk('partial'), done: false }), 5);
      } else {
        setTimeout(() => resolve({ value: undefined, done: true }), 800);
      }
    })
  };
  const driver = new StreamDriver({
    iterator,
    client: {},
    sink: {
      onDelta: () => {},
      onTimeout: (reason) => { calls.push(reason); return 'MID-TIMEOUT'; },
      onDone: () => 'DONE-RET'
    },
    idleTimeoutMs: 5,
    softTimeoutMs: 60 * 60 * 1000,
    firstTokenTimeoutMs: 60 * 60 * 1000, // 首 token 守卫让位：验证触发的是中途停滞守卫
    stallTimeoutMs: 30
  });
  assert.equal(await driver.run(), 'MID-TIMEOUT');
  assert.deepEqual(calls, ['mid-stream']);
});

test('StreamDriver: 每次输出重置中途计时（不重置则第二次输出前就误触发）', async () => {
  const calls = [];
  const stallMs = 400;
  const t0 = Date.now();
  let d1At = null;
  let d2At = null;
  let firedAt = null;
  let tailTimer = null;
  // 标称 delta1 @10ms → delta2 @350ms（标称间隔 340ms < stall 400，必须重置计时）→ 静默：
  //   重置（正确）：锚移到 d2，触发于 ~d2+400ms
  //   不重置（错误）：锚停在 d1，next() 重挂时剩余 stall-(d2-d1)≈60ms，触发于 ~d2+60ms
  // 两假设相差 ≈340ms（14× 实测抖动），故断言只锚 d2、用相对区间，不用绝对窗口。
  // 注：标称时刻与实测有偏差——`_lastOutputAt` 在 `_autoApprove` 之后才戳记，间隔会被拉长（实测 20→34ms），
  // 这正是旧写法（stall=30 + 间隔 20 + 单边下界）丧失判别力的原因：前提「间隔 < 阈值」先被打破。
  let n = 0;
  const iterator = {
    next: () => new Promise((resolve) => {
      ++n;
      if (n === 1) setTimeout(() => { d1At = Date.now() - t0; resolve({ value: messageChunk('a'), done: false }); }, 10);
      else if (n === 2) setTimeout(() => { d2At = Date.now() - t0; resolve({ value: messageChunk('b'), done: false }); }, 350);
      else tailTimer = setTimeout(() => resolve({ value: undefined, done: true }), 2000);
    })
  };
  const driver = new StreamDriver({
    iterator,
    client: {},
    sink: {
      onDelta: () => {},
      onTimeout: (reason) => { calls.push(reason); firedAt = Date.now() - t0; return 'MID-TIMEOUT'; },
      onDone: () => 'DONE-RET'
    },
    idleTimeoutMs: 5,
    softTimeoutMs: 60 * 60 * 1000,
    firstTokenTimeoutMs: 60 * 60 * 1000,
    stallTimeoutMs: stallMs
  });
  assert.equal(await driver.run(), 'MID-TIMEOUT');
  assert.deepEqual(calls, ['mid-stream']);
  // 前置断言：d2 必须赶在首次守卫触发前到达，否则用例前提不成立（会得到 NaN 而看不出原因）
  assert.ok(d2At !== null,
    '前置不成立：第二次输出未在首次守卫触发前到达（实测间隔已 ≥ 阈值），本用例无法判别');
  assert.ok(firedAt - d2At >= stallMs * 0.75,
    `中途计时必须锚在最后一次输出（应 ≥${stallMs * 0.75}ms，实际 ${firedAt - d2At}ms；`
    + `若锚停在首次输出则为 ~${stallMs - (d2At - d1At)}ms）`);
  // 守卫触发后那次挂起的 next() 已被放弃，但它的定时器仍会拖住进程退出
  clearTimeout(tailTimer);
});

test('StreamDriver: 非输出事件不重置中途计时（无 result/error 的空事件不延长停滞判定）', async () => {
  const calls = [];
  const stallMs = 400;
  const t0 = Date.now();
  let deltaAt = null;
  let idleAt = null;
  let firedAt = null;
  let tailTimer = null;
  // 标称 delta @10ms → 空事件 @360ms → 静默；stall=400：
  //   不重置（正确）：锚保持最后一次真实输出，重挂时剩余 ≈50ms，触发于 ~delta+400ms
  //   误重置（错误）：锚移到空事件，触发于 ~idleAt+400ms
  // 两个假设相差 idleAt-deltaAt（≈350ms，14× 实测抖动），因此断言用「相对锚点的区间」
  // 而非「相对 t0 的绝对窗口」——后者的判别余量（本次为 20ms）小于抖动，两面都会误判。
  // 注：标称时刻与实测有偏差——`_lastOutputAt` 在 `_autoApprove` 之后才戳记，实际时长会被拉长。
  const idleEvent = { jsonrpc: '2.0', id: 'keepalive-1' };
  let n = 0;
  const iterator = {
    next: () => new Promise((resolve) => {
      ++n;
      if (n === 1) setTimeout(() => { deltaAt = Date.now() - t0; resolve({ value: messageChunk('a'), done: false }); }, 10);
      else if (n === 2) setTimeout(() => { idleAt = Date.now() - t0; resolve({ value: idleEvent, done: false }); }, 360);
      else tailTimer = setTimeout(() => resolve({ value: undefined, done: true }), 2000);
    })
  };
  const driver = new StreamDriver({
    iterator,
    client: {},
    sink: {
      onDelta: () => {},
      onTimeout: (reason) => { calls.push(reason); firedAt = Date.now() - t0; return 'MID-TIMEOUT'; },
      onDone: () => 'DONE-RET'
    },
    idleTimeoutMs: 5,
    softTimeoutMs: 60 * 60 * 1000,
    firstTokenTimeoutMs: 60 * 60 * 1000,
    stallTimeoutMs: stallMs
  });
  assert.equal(await driver.run(), 'MID-TIMEOUT');
  assert.deepEqual(calls, ['mid-stream']);
  // 下界：不能在阈值前触发（锚点若被清空/前移会走这条）
  assert.ok(firedAt - deltaAt >= stallMs * 0.75,
    `中途停滞应在最后一次真实输出后 ≥${stallMs * 0.75}ms 触发（实际 ${firedAt - deltaAt}ms）`);
  // 上界（判别点）：正确实现约在空事件后 50ms 触发，误重置则约 stallMs（≈400ms）；
  // 阈值取两假设之间（真中点 225ms，取 220ms 略偏下：更利于正确实现通过，仍远离误重置）
  assert.ok(firedAt - idleAt < stallMs * 0.55,
    `非输出事件不得重置计时（实际在空事件后 ${firedAt - idleAt}ms 触发，重置则为 ~${stallMs}ms）`);
  // 守卫触发后那次挂起的 next() 已被放弃，但它的定时器仍会拖住进程退出
  clearTimeout(tailTimer);
});

test('StreamDriver: stallTimeoutMs=0 禁用中途守卫（输出后静默走 onDone）', async () => {
  const calls = [];
  let first = true;
  const iterator = {
    next: () => new Promise((resolve) => {
      if (first) {
        first = false;
        setTimeout(() => resolve({ value: messageChunk('a'), done: false }), 5);
      } else {
        setTimeout(() => resolve({ value: undefined, done: true }), 80);
      }
    })
  };
  const driver = new StreamDriver({
    iterator,
    client: {},
    sink: {
      onDelta: () => {},
      onTimeout: () => calls.push('timeout'),
      onDone: () => 'DONE-RET'
    },
    idleTimeoutMs: 5,
    softTimeoutMs: 60 * 60 * 1000,
    firstTokenTimeoutMs: 60 * 60 * 1000,
    stallTimeoutMs: 0
  });
  assert.equal(await driver.run(), 'DONE-RET');
  assert.deepEqual(calls, []);
});

// ===== 存活信号：permission 成功应答重置中途停滞计时（2026-09-19）=====

/** permission 事件（服务端推送的权限请求，带 id） */
function permissionEvent(id) {
  return {
    jsonrpc: '2.0', id, method: 'session/request_permission',
    params: { sessionId: 's1', toolCall: { toolCallId: 'tc-1' } }
  };
}

/** fake client：respondPermission 返回 delivered（控制应答成败），ackInbound/markInboundSent 记录交接 */
function permApprovingClient(delivered) {
  const acked = [];
  const sentMarks = [];
  const touches = [];
  const clears = [];
  return {
    respondPermission: async () => delivered,
    approveToolCall: async () => {},
    ackInbound: (ev) => { acked.push(ev?.id); return true; },
    markInboundSent: (ev) => { sentMarks.push(ev?.id); return true; },
    touchInbound: () => { touches.push(Date.now()); },
    clearInboundWindows: () => { clears.push(Date.now()); },
    acked,
    sentMarks,
    touches,
    clears
  };
}

test('StreamDriver: permission 成功应答重置中途停滞计时（后端在干活不误判）', async () => {
  const calls = [];
  const stallMs = 400;
  const t0 = Date.now();
  let deltaAt = null;
  let permAt = null;
  let firedAt = null;
  let tailTimer = null;
  // 标称 delta @10ms → permission(成功应答) @350ms → 静默；stall=400：
  //   重置（正确）：锚移到 permission 时刻，触发于 ~perm+400ms
  //   不重置（错误）：锚停在 delta，触发于 ~delta+400ms ≈ perm+60ms
  // 两假设相差 ≈340ms（≫ 实测抖动），断言锚在 permission、用相对区间。
  const client = permApprovingClient(true);
  let n = 0;
  const iterator = {
    next: () => new Promise((resolve) => {
      ++n;
      if (n === 1) setTimeout(() => { deltaAt = Date.now() - t0; resolve({ value: messageChunk('a'), done: false }); }, 10);
      else if (n === 2) setTimeout(() => { permAt = Date.now() - t0; resolve({ value: permissionEvent('p-1'), done: false }); }, 350);
      else tailTimer = setTimeout(() => resolve({ value: undefined, done: true }), 2000);
    })
  };
  const driver = new StreamDriver({
    iterator,
    client,
    sink: {
      onDelta: () => {},
      onTimeout: (reason) => { calls.push(reason); firedAt = Date.now() - t0; return 'MID-TIMEOUT'; },
      onDone: () => 'DONE-RET'
    },
    idleTimeoutMs: 5,
    softTimeoutMs: 60 * 60 * 1000,
    firstTokenTimeoutMs: 60 * 60 * 1000,
    stallTimeoutMs: stallMs
  });
  assert.equal(await driver.run(), 'MID-TIMEOUT');
  assert.deepEqual(calls, ['mid-stream']);
  assert.ok(client.sentMarks.includes('p-1'), '前置：permission 批准送达已转送达确认窗（stall-rootcure 新契约：批准不再 ack 出表）');
  assert.ok(!client.acked.includes('p-1'), '批准送达不得再 ack 出表（ack≠送达，60s 兜底由确认窗接管）');
  assert.ok(permAt !== null, '前置不成立：permission 未按时到达，本用例无法判别');
  assert.ok(firedAt - permAt >= stallMs * 0.75,
    `permission 成功应答必须重置停滞计时（应 ≥${stallMs * 0.75}ms 自 permission，实际 ${firedAt - permAt}ms；`
    + `若锚停在 delta 则为 ~${stallMs - (permAt - deltaAt)}ms）`);
  clearTimeout(tailTimer);
});

test('StreamDriver: permission 应答失败不重置中途计时（POST 未送达≠存活）', async () => {
  const calls = [];
  const stallMs = 400;
  const t0 = Date.now();
  let deltaAt = null;
  let permAt = null;
  let firedAt = null;
  let tailTimer = null;
  // 标称 delta @10ms → permission(应答失败) @350ms → 静默；stall=400：
  //   不重置（正确）：锚保持 delta，重挂时剩余 ≈60ms，触发于 ~delta+400ms（= perm+60ms）
  //   误重置（错误）：锚移到 permission，触发于 ~perm+400ms
  // 判别点取两假设之间：firedAt - permAt < stallMs*0.55（220ms）
  const client = permApprovingClient(false);
  let n = 0;
  const iterator = {
    next: () => new Promise((resolve) => {
      ++n;
      if (n === 1) setTimeout(() => { deltaAt = Date.now() - t0; resolve({ value: messageChunk('a'), done: false }); }, 10);
      else if (n === 2) setTimeout(() => { permAt = Date.now() - t0; resolve({ value: permissionEvent('p-2'), done: false }); }, 350);
      else tailTimer = setTimeout(() => resolve({ value: undefined, done: true }), 2000);
    })
  };
  const driver = new StreamDriver({
    iterator,
    client,
    sink: {
      onDelta: () => {},
      onTimeout: (reason) => { calls.push(reason); firedAt = Date.now() - t0; return 'MID-TIMEOUT'; },
      onDone: () => 'DONE-RET'
    },
    idleTimeoutMs: 5,
    softTimeoutMs: 60 * 60 * 1000,
    firstTokenTimeoutMs: 60 * 60 * 1000,
    stallTimeoutMs: stallMs
  });
  assert.equal(await driver.run(), 'MID-TIMEOUT');
  assert.deepEqual(calls, ['mid-stream']);
  assert.ok(!client.acked.includes('p-2'), '应答失败不得 ack 出表（60s 兜底仍需接管）');
  assert.ok(permAt !== null, '前置不成立：permission 未按时到达，本用例无法判别');
  assert.ok(firedAt - deltaAt >= stallMs * 0.75,
    `应答失败不得重置（应自最后真实输出 ≥${stallMs * 0.75}ms，实际 ${firedAt - deltaAt}ms）`);
  assert.ok(firedAt - permAt < stallMs * 0.55,
    `应答失败不得把锚移到 permission（实际在 permission 后 ${firedAt - permAt}ms 触发，误重置则为 ~${stallMs}ms）`);
  clearTimeout(tailTimer);
});

test('StreamDriver: permission 成功应答不解除首 token 守卫（零输出口径不变）', async () => {
  const calls = [];
  const ftMs = 400;
  const t0 = Date.now();
  let firedAt = null;
  let tailTimer = null;
  // 零输出；permission(成功应答) @360ms → 静默；firstToken=400：
  //   正确：_gotOutput 未置位 → 仍 first-token 态，触发于 ~t0+400ms
  //   错误（误置位）：进入 mid-stream 态，reason=mid-stream 且触发于 ~perm+stall
  const client = permApprovingClient(true);
  let n = 0;
  const iterator = {
    next: () => new Promise((resolve) => {
      ++n;
      if (n === 1) setTimeout(() => resolve({ value: permissionEvent('p-3'), done: false }), 360);
      else tailTimer = setTimeout(() => resolve({ value: undefined, done: true }), 2000);
    })
  };
  const driver = new StreamDriver({
    iterator,
    client,
    sink: {
      onTimeout: (reason) => { calls.push(reason); firedAt = Date.now() - t0; return 'FT-TIMEOUT'; },
      onDone: () => 'DONE-RET'
    },
    idleTimeoutMs: 5,
    softTimeoutMs: 60 * 60 * 1000,
    firstTokenTimeoutMs: ftMs,
    stallTimeoutMs: 200
  });
  assert.equal(await driver.run(), 'FT-TIMEOUT');
  assert.deepEqual(calls, ['first-token']);
  assert.ok(client.sentMarks.includes('p-3'), '前置：permission 已成功应答（stall-rootcure 新契约：送达转确认窗）');
  assert.ok(firedAt < ftMs * 1.25,
    `permission 不得解除首 token 守卫（应 ~${ftMs}ms 触发，实际 ${firedAt}ms；误入 mid-stream 态则 ≥${360 + 200}ms）`);
  clearTimeout(tailTimer);
});

// ===== 送达看门狗驱动接线（bugfix-20260922-stall-rootcure，W 组 driver 侧）=====

test('StreamDriver: 看门狗接线——事件探针 touch + 批准转 markInboundSent + done 清窗', async () => {
  const client = permApprovingClient(true);
  let n = 0;
  let tailTimer = null;
  const iterator = {
    next: () => new Promise((resolve) => {
      ++n;
      if (n === 1) setTimeout(() => resolve({ value: messageChunk('a'), done: false }), 5);
      else if (n === 2) setTimeout(() => resolve({ value: permissionEvent('p-9'), done: false }), 10);
      else tailTimer = setTimeout(() => resolve({ value: undefined, done: true }), 40);
    })
  };
  const driver = new StreamDriver({
    iterator,
    client,
    sink: {
      onDelta: () => {},
      onTimeout: () => 'TIMEOUT',
      onDone: () => 'DONE-RET'
    },
    idleTimeoutMs: 5,
    softTimeoutMs: 60 * 60 * 1000,
    firstTokenTimeoutMs: 60 * 60 * 1000,
    stallTimeoutMs: 500
  });
  assert.equal(await driver.run(), 'DONE-RET');
  assert.ok(client.sentMarks.includes('p-9'), '批准送达 → markInboundSent（不 ack 出表）');
  assert.ok(client.touches.length >= 2, `每个到达事件必须触发探针 touch（滑动重置），实得 ${client.touches.length} 次`);
  assert.equal(client.clears.length, 1, 'done 分支恰好清窗一次（F7：回合结束不得残留 armed 定时器）');
  clearTimeout(tailTimer);
});

test('StreamDriver: 工具挂起（onToolCall）→ 清窗（控制权交客户端，确认窗不得误发）', async () => {
  const client = permApprovingClient(true);
  const delegateEvent = {
    jsonrpc: '2.0', id: 'deleg-9', method: '_codebuddy.ai/delegateTool',
    params: { toolId: 'my_tool', input: { a: 1 }, toolCallId: 'tc-9' }
  };
  let n = 0;
  const iterator = {
    next: () => new Promise((resolve) => {
      ++n;
      if (n === 1) setTimeout(() => resolve({ value: delegateEvent, done: false }), 5);
      else setTimeout(() => resolve({ value: undefined, done: true }), 500);
    })
  };
  const driver = new StreamDriver({
    iterator,
    client,
    sink: {
      onToolCall: () => 'SUSPENDED',
      onTimeout: () => 'TIMEOUT',
      onDone: () => 'DONE-RET'
    },
    idleTimeoutMs: 5,
    softTimeoutMs: 60 * 60 * 1000,
    firstTokenTimeoutMs: 60 * 60 * 1000,
    stallTimeoutMs: 500
  });
  assert.equal(await driver.run(), 'SUSPENDED');
  assert.equal(client.clears.length, 1, '工具挂起分支恰好清窗一次（挂起等待由 PENDING_TTL_MS 管）');
  assert.ok(client.acked.includes('deleg-9'), 'delegateTool 消费仍走 ack 出表（现状不变）');
});

test('StreamDriver: result 事件收尾 → 清窗（第四出口，K8 加固：不依赖 prompt-finally 后备）', async () => {
  const client = permApprovingClient(true);
  let n = 0;
  const iterator = {
    next: () => new Promise((resolve) => {
      ++n;
      if (n === 1) setTimeout(() => resolve({ value: messageChunk('a'), done: false }), 5);
      else if (n === 2) setTimeout(() => resolve({ value: { jsonrpc: '2.0', id: 'p-10', result: { stopReason: 'end_turn' } }, done: false }), 10);
      else setTimeout(() => resolve({ value: undefined, done: true }), 500);
    })
  };
  const driver = new StreamDriver({
    iterator,
    client,
    sink: {
      onDelta: () => {},
      onTimeout: () => 'TIMEOUT',
      onDone: () => 'DONE-RET'
    },
    idleTimeoutMs: 5,
    softTimeoutMs: 60 * 60 * 1000,
    firstTokenTimeoutMs: 60 * 60 * 1000,
    stallTimeoutMs: 500
  });
  assert.equal(await driver.run(), 'DONE-RET');
  assert.equal(client.clears.length, 1, 'result-break 分支恰好清窗一次（与 done 分支对称）');
});

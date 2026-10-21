/**
 * 入站委托请求兜底单测（node:test，零依赖）。
 *
 * 背景（本次事故根因）：服务端主动推送的 JSON-RPC 请求（delegateTool /
 * request_permission）在网关侧静默丢失时，CLI 会永久死等（trace 证据：
 * DelegateTool span 永远 running），180s 后被停滞守卫回收报错。
 *
 * 机制：入站请求到达即入注册表；driver 消费时 ack 出表；超时（默认 60s，
 * DELEGATE_REPLY_TIMEOUT_MS 可配）未被 ack → 回 JSON-RPC error（工具失败
 * 语义，CLI 继续回合）+ warn 日志。
 *
 * 覆盖：test-matrix R1..R9 / F3。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AcpClient } from '../src/acp-client.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeClient(timeoutMs = 40) {
  const client = new AcpClient('http://127.0.0.1:1');
  client.delegateReplyTimeoutMs = timeoutMs;
  const sent = [];
  client._post = async (_path, body) => { sent.push(JSON.parse(body)); return {}; };
  return { client, sent };
}

const delegateReq = (id = 'd-1') => ({
  jsonrpc: '2.0', id, method: '_codebuddy.ai/delegateTool',
  params: { sessionId: 's1', toolCallId: 't1' }
});
const permReq = (id = 'p-1') => ({
  jsonrpc: '2.0', id, method: 'session/request_permission',
  params: { sessionId: 's1' }
});
const deltaEvent = () => ({
  jsonrpc: '2.0', method: 'session/update',
  params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hi' } } }
});

/** 捕获 console.warn 输出 */
function captureWarn(fn) {
  const logs = [];
  const orig = console.warn;
  console.warn = (...a) => { logs.push(a.join(' ')); };
  try { fn(); } finally { console.warn = orig; }
  return logs;
}

test('R1: delegateTool 入站 → 注册 + warn 日志（含请求 id 与 method）', () => {
  const { client } = makeClient();
  const logs = captureWarn(() => client._registerInbound(delegateReq('d-42')));
  try {
    assert.equal(client._inbound.size, 1, '入站请求必须进入注册表');
    assert.ok(
      logs.some((l) => l.includes('d-42') && l.includes('delegateTool')),
      `必须有含 id+method 的 warn 日志，实得：${JSON.stringify(logs)}`
    );
  } finally {
    client._inbound.clear();
  }
});

test('R2: driver ack → 出表、清定时器、无兜底应答', async () => {
  const { client, sent } = makeClient(30);
  const ev = delegateReq();
  client._registerInbound(ev);
  assert.equal(client.ackInbound(ev), true, 'ack 命中在途注册');
  assert.equal(client._inbound.size, 0, 'ack 后出表');
  await sleep(60);
  assert.equal(sent.length, 0, '已 ack 不得产生兜底应答');
});

test('R3: 超时未 ack → 回 JSON-RPC error + 出表 + warn 日志', async () => {
  const { client, sent } = makeClient(30);
  const ev = delegateReq('d-7');
  const orig = console.warn;
  const logs = [];
  console.warn = (...a) => { logs.push(a.join(' ')); };
  try {
    client._registerInbound(ev);
    await sleep(70);
  } finally {
    console.warn = orig;
  }
  assert.equal(client._inbound.size, 0, '超时应答后出表');
  const reply = sent.find((m) => m.id === 'd-7');
  assert.ok(reply, '必须向 CLI 回一条应答，实得：' + JSON.stringify(sent));
  assert.ok(reply.error, '应答必须是 JSON-RPC error（工具失败语义），不得是空 result');
  assert.equal(typeof reply.error.code, 'number', 'error.code 必填');
  assert.ok(reply.error.message, 'error.message 必填');
  assert.ok(logs.some((l) => l.includes('d-7')), '兜底触发必须留 warn 日志');
});

test('R4+R5: 超时应答后迟到 ack / 已 ack 后定时器到点 → 幂等，不重复应答', async () => {
  const { client, sent } = makeClient(30);

  // R4：先超时兜底，再迟到 ack
  const ev1 = delegateReq('d-8');
  client._registerInbound(ev1);
  await sleep(60);
  const baseline = sent.length;
  const lateAckLogs = captureWarn(() => {
    assert.doesNotThrow(() => client.ackInbound(ev1), '迟到 ack 不得抛错');
  });
  assert.ok(lateAckLogs.some((l) => l.includes('d-8')), 'X2：迟到 ack 必须有 warn 留痕');
  assert.equal(sent.length, baseline, '迟到 ack 不得产生第二条应答');

  // R5：先 ack 出表，再等定时器到点
  const ev2 = delegateReq('d-9');
  client._registerInbound(ev2);
  client.ackInbound(ev2);
  await sleep(60);
  assert.ok(!sent.some((m) => m.id === 'd-9'), '已 ack 的请求不得再被兜底应答');
});

test('R6/F3: request_permission 入站 → 同一注册表机制（超时兜底 error）', async () => {
  const { client, sent } = makeClient(30);
  client._registerInbound(permReq('p-7'));
  assert.equal(client._inbound.size, 1);
  await sleep(70);
  const reply = sent.find((m) => m.id === 'p-7');
  assert.ok(reply?.error, '权限请求丢失同样必须兜底 error（本次事故第 3 次疑似形态）');
});

test('R7: 连接销毁 → 在途注册被清理（定时器不泄漏）', async () => {
  const { client, sent } = makeClient(30);
  client._registerInbound(delegateReq('d-x'));
  assert.equal(client._inbound.size, 1);
  client.destroy();
  assert.equal(client._inbound.size, 0, '销毁时清空在途注册');
  await sleep(60);
  assert.equal(sent.length, 0, '销毁后不得再发应答');
});

test('R8: 非委托事件（delta / result）不入表、无日志、行为不变', () => {
  const { client } = makeClient();
  const logs = captureWarn(() => {
    client._registerInbound(deltaEvent());
    client._registerInbound({ jsonrpc: '2.0', id: 'r-1', result: { stopReason: 'end_turn' } });
    client._registerInbound(null);
  });
  assert.equal(client._inbound.size, 0, '非委托事件不得入表');
  assert.equal(logs.length, 0, '非委托事件不得打日志');
});

test('R9: 兜底应答后迟到工具回传（respondToToolCall 同 id）→ 幂等不抛错', async () => {
  const { client, sent } = makeClient(30);
  client._registerInbound(delegateReq('d-11'));
  await sleep(60);
  assert.ok(sent.some((m) => m.id === 'd-11' && m.error), '前置：已发生兜底应答');
  const logs = [];
  const orig = console.warn;
  console.warn = (...a) => { logs.push(a.join(' ')); };
  try {
    await assert.doesNotReject(
      () => client.respondToToolCall('d-11', 'tool output'),
      '迟到工具回传不得抛错（否则会冒泡成未处理异常）'
    );
  } finally { console.warn = orig; }
  assert.ok(logs.some((l) => l.includes('Late result') && l.includes('d-11')), '迟到回传必须有 warn 留痕');
  assert.equal(sent.filter((m) => m.id === 'd-11').length, 1, '同一 id 应答恰好一次（不得重复）');
});

test('R10/AC-2: push 通道投递只产生一条注册日志（多通道到达不重复登记）', () => {
  const { client } = makeClient();
  try {
    // 到达即登记（推送通道）
    const arrivalLogs = captureWarn(() => client._dispatchPushedEvent(delegateReq('d-log')));
    assert.equal(client._inbound.size, 1);
    assert.equal(arrivalLogs.filter((l) => l.includes('registered')).length, 1, '到达时打一条注册日志');
    // 事件随后被合并迭代器取走（同一请求再次经过登记入口）：不得重复登记/重复日志
    const againLogs = captureWarn(() => client._registerInbound(delegateReq('d-log')));
    assert.equal(againLogs.filter((l) => l.includes('registered')).length, 0, 'AC-2：同一请求不得出现第二条注册日志');
    assert.equal(client._inbound.size, 1);
  } finally {
    client._inbound.clear();
  }
});

test('R11: 兜底 error 发送失败 → id 不得被误记为已应答（CLI 仍可收到后续迟到 result）', async () => {
  const { client } = makeClient(30);
  let failNext = true;
  client._post = async (_p, body) => {
    if (failNext) { failNext = false; throw new Error('network flake'); }
    return {};
  };
  const orig = console.warn; console.warn = () => {};
  try {
    client._registerInbound(delegateReq('d-flake'));
    await sleep(60); // 超时兜底 → POST 失败
    assert.equal(client._answeredInbound.has('d-flake'), false, 'POST 失败不得留下「已应答」标记');
  } finally { console.warn = orig; }
  // 真正到达的工具回传必须能发出去（不被误判为迟到）
  const sent = [];
  client._post = async (_p, body) => { sent.push(JSON.parse(body)); return {}; };
  await client.respondToToolCall('d-flake', 'late but real');
  assert.ok(sent.some((m) => m.id === 'd-flake' && m.result), 'CLI 必须最终拿到工具结果');
});

// ===== 送达看门狗（bugfix-20260922-stall-rootcure，W 组）=====
// 契约（2026-09-22 生产 trace 实证 ack≠送达）：批准送达成功 ≠ CLI 确认收到。
// 批准送达后条目保留、定时器 re-arm 进入「送达确认窗」（滑动：任一事件到达重置）；
// 「最后事件后满窗」零活动 → error 兜底（warn + 一次重试，仅确认窗重试）。
// 清窗三出口：destroy / driver done·工具挂起 / prompt 流收尾（inflight=0）。
//计时断言遵守 first-token-guard spec「计时断言约束」：相对区间 + 判别间隔 ≫ 抖动。

test('W2: permission 批准送达 → 条目保留在表（旧契约「批准即出表」废弃）+ 确认窗在转', async () => {
  const { client, sent } = makeClient(40);
  client._registerInbound(permReq('p-21'));
  await client.markInboundSent(permReq('p-21'));
  assert.equal(client._inbound.size, 1, '批准送达后条目必须保留（送达未确认前不得解除防线）');
  await sleep(70);
  assert.ok(sent.some((m) => m.id === 'p-21' && m.error), '确认窗零活动到点必须兜底 error（窗口确实在转）');
});

test('W3: 窗口内事件到达 → 滑动重置（一次性窗口在原到点不得触发）', async () => {
  const { client, sent } = makeClient(600);
  client._registerInbound(permReq('p-22'));
  await client.markInboundSent(permReq('p-22'));
  const t0 = Date.now();
  await sleep(300);
  client.touchInbound(); // CLI 事件到达：滑动重置（锚移至 touch 时刻）
  await sleep(450); // t0+750：一次性实现已在 +600±抖动触发；滑动实现窗口到 +900
  assert.ok(!sent.some((m) => m.id === 'p-22'), '滑动窗口：touch 后不得按原窗口（批准+600ms）超时（判别点 750ms，两假设相差 300ms ≫ 抖动）');
  await sleep(300); // t0+1050 > touch+600：零活动满窗 → 必须触发
  const replies = sent.filter((m) => m.id === 'p-22');
  assert.ok(replies.length === 1 && replies[0].error, `最后事件后满窗必须恰好兜底一次，实得 ${JSON.stringify(sent)}`);
});

test('W4: 送达确认窗零活动到点 → warn 日志 + error 恰好一次', async () => {
  const { client, sent } = makeClient(40);
  const logs = [];
  const orig = console.warn; console.warn = (...a) => { logs.push(a.join(' ')); };
  try {
    client._registerInbound(permReq('p-23'));
    await client.markInboundSent(permReq('p-23'));
    await sleep(70);
  } finally { console.warn = orig; }
  const replies = sent.filter((m) => m.id === 'p-23');
  assert.equal(replies.length, 1, '恰好一次兜底应答');
  assert.ok(replies[0].error, 'error 语义（工具失败，CLI 自行继续回合）');
  assert.ok(logs.some((l) => l.includes('p-23')), '兜底触发必须留 warn 日志（含 id）');
});

test('W5: destroy 清窗（送达确认窗态同样被清，无 error）', async () => {
  const { client, sent } = makeClient(40);
  client._registerInbound(permReq('p-24'));
  await client.markInboundSent(permReq('p-24'));
  client.destroy();
  await sleep(70);
  assert.equal(sent.filter((m) => m.id === 'p-24').length, 0, '销毁清窗不得发 error');
});

test('W6: 回合收尾清窗（done/工具挂起 → clearInboundWindows，防 armed 定时器打进已复用连接）', async () => {
  const { client, sent } = makeClient(40);
  client._registerInbound(permReq('p-25'));
  await client.markInboundSent(permReq('p-25'));
  client.clearInboundWindows();
  assert.equal(client._inbound.size, 0, '回合收尾清窗出表');
  await sleep(70);
  assert.equal(sent.filter((m) => m.id === 'p-25').length, 0, '回合正常结束不得发 error（F7）');
});

test('W7: prompt 流收尾（inflight=0）→ 清窗', async () => {
  const { client, sent } = makeClient(40);
  client._registerInbound(permReq('p-26'));
  await client.markInboundSent(permReq('p-26'));
  client._inflightPrompts = 1; // 模拟一个在飞 prompt
  client._releasePromptInflight(); // finally 收尾：归零即清窗
  assert.equal(client._inbound.size, 0, '连接空闲即清窗（armed 定时器不得存活进 idle 连接）');
  await sleep(70);
  assert.equal(sent.filter((m) => m.id === 'p-26').length, 0, '不误发');
});

test('W8: 确认窗兜底 POST 失败 → warn + 恰好一次重试，成功后才标记已应答', async () => {
  let attempts = 0;
  const sent2 = [];
  const client = new AcpClient('http://127.0.0.1:1');
  client.delegateReplyTimeoutMs = 40;
  client._post = async (_p, body) => {
    attempts += 1;
    if (attempts === 1) throw new Error('network flake');
    sent2.push(JSON.parse(body));
    return {};
  };
  const logs = [];
  const orig = console.warn; console.warn = (...a) => { logs.push(a.join(' ')); };
  try {
    client._registerInbound(permReq('p-27'));
    await client.markInboundSent(permReq('p-27'));
    await sleep(120); // 窗口到点：第一次 POST 失败 → 重试成功
  } finally { console.warn = orig; }
  assert.equal(attempts, 2, '失败后恰好重试一次（有损通道上单发静默吞不可接受）');
  assert.equal(sent2.filter((m) => m.id === 'p-27').length, 1, '重试成功送达 error');
  assert.ok(client._answeredInbound.has('p-27'), '发送成功后才标记已应答（顺序契约不变）');
  assert.ok(logs.some((l) => l.includes('p-27')), '失败必须有 warn 留痕');
});

test('W9: 双 permission 相继批准 → 窗口独立、各自恰好一次', async () => {
  const { client, sent } = makeClient(40);
  client._registerInbound(permReq('p-28'));
  client._registerInbound(permReq('p-29'));
  await client.markInboundSent(permReq('p-28'));
  await client.markInboundSent(permReq('p-29'));
  await sleep(70);
  assert.equal(sent.filter((m) => m.id === 'p-28' && m.error).length, 1, 'p-28 恰好一次');
  assert.equal(sent.filter((m) => m.id === 'p-29' && m.error).length, 1, 'p-29 恰好一次（条目互不干扰）');
});

test('W11: 清窗后迟到 touch → 幂等（不复活条目、不产生应答）', async () => {
  const { client, sent } = makeClient(30);
  client._registerInbound(permReq('p-30'));
  await client.markInboundSent(permReq('p-30'));
  client.clearInboundWindows();
  client.touchInbound();
  await sleep(60);
  assert.equal(sent.filter((m) => m.id === 'p-30').length, 0, '清窗后 touch 不得复活条目');
});

test('W12: awaiting 条目不被 touchInbound 滑动（兜底锚点保持在注册时刻，评审 K3）', async () => {
  const { client, sent } = makeClient(300);
  client._registerInbound(permReq('p-31')); // awaiting：无人消费
  await sleep(150);
  client.touchInbound(); // 事件流动：确认窗重置，awaiting 锚点不得移动
  await sleep(250); // t0+400 > 注册+300：固定锚已触发（若被误滑动，要到 touch+300=450）
  const replies = sent.filter((m) => m.id === 'p-31');
  assert.ok(replies.length === 1 && replies[0].error, `awaiting 兜底必须按注册时刻到点（实得 ${replies.length} 条应答）`);
});

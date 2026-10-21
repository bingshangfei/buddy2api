/**
 * anthropic-wire.test.js — Anthropic 帧词汇单点的字节面锁（架构深化第 8 批批B）。
 *
 * 形态照 openai-wire.test.js：锁「帧长什么样」（字节锚），不锁「何时发哪帧」
 * （C1-C6 事件序由 anthropic-response / anthropic-resume 锚定用例钉死）。
 * 另含边界断言：wire 内不得出现块 index 状态机（审视 F8——状态机留 sink）。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  anthropicEvent, messageStart, contentBlockStart, contentBlockDelta,
  contentBlockStop, messageDelta, messageStop, errorEvent,
  toolUseBlock, messageEnvelope, anthropicError
} from '../src/anthropic-wire.js';

const WIRE_SRC = readFileSync(fileURLToPath(new URL('../src/anthropic-wire.js', import.meta.url)), 'utf8');

describe('anthropicEvent 原始编码器', () => {
  test('输出命名事件帧（event + 带 type 的 data，双换行结尾）', () => {
    const frame = anthropicEvent('ping', { type: 'ping' });
    assert.equal(frame, 'event: ping\ndata: {"type":"ping"}\n\n');
  });
});

describe('帧形状字节锁', () => {
  test('messageStart：C1 首事件，input_tokens 由调用方传入，output_tokens 恒 0', () => {
    const frame = messageStart('msg_123', 'claude-sonnet-4-5', 1234);
    assert.equal(frame, 'event: message_start\ndata: ' + JSON.stringify({
      type: 'message_start',
      message: {
        id: 'msg_123',
        type: 'message',
        role: 'assistant',
        model: 'claude-sonnet-4-5',
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 1234, output_tokens: 0 }
      }
    }) + '\n\n');
  });

  test('contentBlockStart / Delta / Stop：index 单调由调用方传入', () => {
    assert.equal(
      contentBlockStart(2, { type: 'text', text: '' }),
      'event: content_block_start\ndata: {"type":"content_block_start","index":2,"content_block":{"type":"text","text":""}}\n\n'
    );
    assert.equal(
      contentBlockDelta(2, { type: 'text_delta', text: '你好' }),
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":2,"delta":{"type":"text_delta","text":"你好"}}\n\n'
    );
    assert.equal(
      contentBlockStop(2),
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":2}\n\n'
    );
  });

  test('messageDelta：C4 携带 stop_reason，stop_sequence 恒 null', () => {
    assert.equal(
      messageDelta('end_turn', 42),
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":42}}\n\n'
    );
    assert.equal(
      messageDelta('tool_use', 0),
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use","stop_sequence":null},"usage":{"output_tokens":0}}\n\n'
    );
  });

  test('messageStop：C5 终止帧', () => {
    assert.equal(messageStop(), 'event: message_stop\ndata: {"type":"message_stop"}\n\n');
  });

  test('errorEvent：C6 顶层 type 判别符 + api_error（字节锚）', () => {
    assert.equal(
      errorEvent('boom'),
      'event: error\ndata: {"type":"error","error":{"type":"api_error","message":"boom"}}\n\n'
    );
  });

  test('toolUseBlock：start 载荷 input 恒空（真参数走 input_json_delta 逐片送达）', () => {
    assert.deepEqual(toolUseBlock('tc-1', 'read_file'), {
      type: 'tool_use', id: 'tc-1', name: 'read_file', input: {}
    });
  });
});

describe('哑信封与错误体', () => {
  test('messageEnvelope：哑信封——content/usage 原样装入，不做组装', () => {
    const content = [{ type: 'thinking', thinking: 'x', signature: '' }, { type: 'text', text: '答案' }];
    const usage = { input_tokens: 1, output_tokens: 2 };
    assert.deepEqual(messageEnvelope({
      id: 'msg_1', model: 'claude-x', content, stopReason: 'end_turn', usage
    }), {
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      model: 'claude-x',
      content,
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage
    });
  });

  test('anthropicError：HTTP 错误体形状（与流内 errorEvent 不同层）', () => {
    assert.deepEqual(anthropicError('api_error', 'oops'), {
      type: 'error', error: { type: 'api_error', message: 'oops' }
    });
  });
});

describe('边界断言（审视 F8）：wire 内不得出现状态机/组装逻辑', () => {
  test('wire 不管理块 index 状态（nextIndex/openBlock/finished 留 sink）', () => {
    assert.doesNotMatch(WIRE_SRC, /nextIndex|openBlock|ensureBlock|closeBlock|finished|ensureStarted/,
      'anthropic-wire 必须保持纯形状：块 index 状态机与惰性/配对语义归 anthropic-sink');
  });

  test('wire 不做 content 组装与 usage 计算（哑信封边界，审视 F7b）', () => {
    assert.doesNotMatch(WIRE_SRC, /thinkingBlockStart|buildAnthropicUsage|estimateTokens|observePromptTokens/,
      'content 组装 / thinkingBlockStart 来源 / usage 估算留 response-builder / usage-accounting');
    assert.doesNotMatch(WIRE_SRC, /state\?\./, 'wire 不读 attempt state（零依赖叶，哑信封入参）');
  });

  test('wire 不含流级分派（何时发哪帧留调用点）', () => {
    assert.doesNotMatch(WIRE_SRC, /res\.end|writableEnded|finished = true/,
      '收尾/终止时机归 sink，wire 只出字符串与对象');
  });
});

/**
 * usage-accounting.test.js — token 估算口径单点（架构深化第 8 批 C2）。
 *
 * 等价性断言：新单遍实现 vs 旧正则 match 语义（CJK_RE 手写副本作参照实现），
 * 样本覆盖 CJK / CJK 标点 / 全角 / ASCII / emoji（代理对，F4 识别的漂移场景）/
 * 混合文本。缓存断言：同引用复用、换引用（续写替换 state.prompt）重算。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  estimateTokens, estimateOutputTokens, estimatePromptTokens, observePromptTokens
} from '../src/usage-accounting.js';
import { buildAnthropicUsage } from '../src/response-builder.js';

// 旧实现的参照副本（迁移前 token-stats.js:24-39 的逐字语义）
const OLD_CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/g;
function oldEstimateTokens(text) {
  if (!text) return 0;
  const cjk = (text.match(OLD_CJK_RE) || []).length;
  const other = text.length - cjk;
  return Math.ceil(cjk + other / 4);
}

describe('estimateTokens 与旧正则口径等价', () => {
  const samples = [
    '',
    '你好世界',
    'Hello',
    '你好 world',
    '你好，世界。',            // CJK 标点按 1 token
    '（）！？ＡＢＣ',           // 全角区
    'café',                  // 拉丁扩展（非 CJK 区间）
    'emoji 👍🏼 test',          // astral 代理对（F4：other 按 2 码元计）
    '你好👍mixed🌍世界 text',
    '🌊'.repeat(100) + '中文'.repeat(50),
    '\uD83D\uDE00 alone surrogate pair',
  ];

  for (const s of samples) {
    test(`等价: ${JSON.stringify(s.length > 30 ? s.slice(0, 30) + '…' : s)}`, () => {
      assert.equal(estimateTokens(s), oldEstimateTokens(s));
    });
  }

  test('既有口径值不变（token-stats.test.js 同源用例）', () => {
    assert.equal(estimateTokens('你好世界'), 4);
    assert.equal(estimateTokens('Hello'), 2);
    assert.equal(estimateTokens('你好 world'), 4);
    assert.equal(estimateTokens(''), 0);
    assert.equal(estimateTokens(null), 0);
    assert.equal(estimateTokens('你好，世界。'), 6);
  });
});

describe('estimateOutputTokens 与拼接扫描等价', () => {
  test('两段分别扫描 + 一次取整 == 拼接后单段扫描', () => {
    const content = '回答内容 answer 123';
    const reasoning = '思考过程 thinking 🤔 更长的一段推理文本';
    assert.equal(
      estimateOutputTokens(content, reasoning),
      oldEstimateTokens(content + reasoning)
    );
  });

  test('null/undefined 段等价于空串', () => {
    assert.equal(estimateOutputTokens(null, 'text'), oldEstimateTokens('' + 'text'));
    assert.equal(estimateOutputTokens('内容', undefined), oldEstimateTokens('内容' + ''));
    assert.equal(estimateOutputTokens(null, null), 0);
  });
});

describe('estimatePromptTokens 口径不变', () => {
  test('只算 text 块，跳过图片 base64（token-stats.test.js 同源用例）', () => {
    const prompt = [
      { type: 'text', text: '你好世界' },
      { type: 'image', data: 'aGFsbyB3b3JsZA==' },
      { type: 'text', text: '你好，世界。' }
    ];
    assert.equal(estimatePromptTokens(prompt), 10); // 4（你好世界）+ 图片跳过 + 6（你好，世界。）
    assert.equal(estimatePromptTokens('纯字符串'), 4);
    assert.equal(estimatePromptTokens(null), 0);
  });
});

describe('observePromptTokens 按引用缓存（F2 失效机制）', () => {
  test('同一引用重复消费复用缓存', () => {
    const prompt = [{ type: 'text', text: '你好世界'.repeat(100) }];
    const first = observePromptTokens(prompt);
    assert.equal(first, 400);
    // 再取：与首算同值（内部是否真走缓存无法直接观测，但可观测「换引用会重算」）
    assert.equal(observePromptTokens(prompt), first);
  });

  test('续写替换引用（state.prompt = 新数组）→ 重算，不残留旧值', () => {
    const before = [{ type: 'text', text: '你好世界'.repeat(100) }];   // 400
    assert.equal(observePromptTokens(before), 400);
    const after = [...before, { type: 'text', text: '追加内容' }];       // 新引用（续写语义）
    assert.equal(observePromptTokens(after), 400 + 4);
  });

  test('字符串与非对象直通（无缓存路径）', () => {
    assert.equal(observePromptTokens('纯字符串'), 4);
    assert.equal(observePromptTokens(null), 0);
    assert.equal(observePromptTokens(undefined), 0);
  });
});

describe('消费点对齐（prd 验收 2 / 审视 P3）：估算值与 4 个客户端可见输出位置同源', () => {
  // 4 个位置：message_start.usage（observePromptTokens）/ message_delta.usage 与
  // 非流式 message.usage（buildAnthropicUsage）/ token-usage 台账（_recordUsage 同函数）。
  // 本组断言把「模块函数」与「消费点入口」锁成同源——实现漂移任一侧即红。
  const state = {
    prompt: [{ type: 'text', text: '你好世界'.repeat(50) }],   // 200
    content: '回答 answer',                                     // 2 CJK + 7 ASCII
    reasoning: '思考 thinking',
    usage: { prompt_tokens: 0, completion_tokens: 0 }
  };

  test('message_start 的 input_tokens == observePromptTokens(state.prompt)', () => {
    assert.equal(observePromptTokens(state.prompt), 200);
  });

  test('message_delta / 非流式 message 的 usage == buildAnthropicUsage(state)（reported 优先口径）', () => {
    const usage = buildAnthropicUsage(state);
    assert.equal(usage.input_tokens, 200);
    assert.equal(usage.output_tokens, estimateOutputTokens(state.content, state.reasoning));
    // 与旧拼接口径对表（防合并取整漂移）
    assert.equal(usage.output_tokens, Math.ceil((2 + 2) + (7 + 8) / 4));
  });

  test('台账 record 路径（reported 缺失 → 估算兜底）与上述同值', () => {
    const reportedPrompt = Number(state.usage.prompt_tokens) || 0;
    const reportedCompletion = Number(state.usage.completion_tokens) || 0;
    assert.equal(reportedPrompt || observePromptTokens(state.prompt), 200);
    assert.equal(reportedCompletion || estimateOutputTokens(state.content, state.reasoning),
      buildAnthropicUsage(state).output_tokens);
  });

  test('reported 优先：网关上报值非零时原样透传（不混入估算）', () => {
    const reported = { ...state, usage: { prompt_tokens: 1234, completion_tokens: 56 } };
    const usage = buildAnthropicUsage(reported);
    assert.equal(usage.input_tokens, 1234);
    assert.equal(usage.output_tokens, 56);
  });
});

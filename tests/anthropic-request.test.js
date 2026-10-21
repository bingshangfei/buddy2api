/**
 * Anthropic 切片 P1/P3：请求翻译单测（node:test，零依赖）。
 *
 * 覆盖测试矩阵 M-05~M-09（顶层 system / tool_result / tool_use / thinking 块）
 * 与 M-19（base64 图片）、以及工具定义与模型 id 映射。
 *
 * 核心理由（对应 assumption-smoke.md A2/A3）：现有 contentToAcpBlocks 对
 * Anthropic 的 tool_result / tool_use 块**静默丢弃**（不报错、不留日志），
 * 照搬会把工具闭环表现成「模型重复调用同一工具」。翻译层把这些块转成
 * buildPrompt 已认识的角色消息，因此 OpenAI 路径的 prompt-builder 一字不改。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  translateAnthropicRequest,
  translateAnthropicTools,
  resolveAnthropicModel,
  isClaudeModelId,
  anthropicThinkingEnabled,
  resolveAnthropicThinking
} from '../src/anthropic-protocol.js';
import { buildPrompt, blocksToPlainText } from '../src/prompt-builder.js';

/** 翻译后直接出纯文本，便于断言最终 prompt 形态 */
function promptText(body) {
  return blocksToPlainText(buildPrompt(translateAnthropicRequest(body).messages));
}

const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';

// ---------- M-05 / M-06：顶层 system ----------

test('M-05: 顶层 system 为字符串 → 注入 [System instructions]', () => {
  const text = promptText({
    system: '你是严谨的助手',
    messages: [{ role: 'user', content: '你好' }]
  });
  assert.match(text, /\[System instructions\]/);
  assert.match(text, /你是严谨的助手/);
});

test('M-06: 顶层 system 为块数组 → 块文本拼接（边界）', () => {
  const text = promptText({
    system: [
      { type: 'text', text: '规则一' },
      { type: 'text', text: '规则二' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG_1PX } }
    ],
    messages: [{ role: 'user', content: 'hi' }]
  });
  assert.match(text, /规则一/);
  assert.match(text, /规则二/);
  assert.doesNotMatch(text, /iVBOR/, 'system 里的图片块不进文本');
});

// ---------- M-07：tool_result 块保留结果文本（当前被静默丢弃） ----------

test('M-07: user 含 tool_result 块 → 结果文本进入 prompt（当前被丢弃）', () => {
  const text = promptText({
    messages: [
      { role: 'user', content: '今天天气？' },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: { city: 'SF' } }]
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: '晴，22 度' }]
      }
    ]
  });
  assert.match(text, /晴，22 度/, 'tool_result 的结果文本必须进入 prompt');
  assert.match(text, /toolu_1/, '结果必须带 tool_use_id 以便模型对上是哪个调用');
});

test('M-07 边界: tool_result 的 content 为块数组 → 文本块拼接', () => {
  const text = promptText({
    messages: [{
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: 'toolu_2',
        content: [{ type: 'text', text: '第一段' }, { type: 'text', text: '第二段' }]
      }]
    }]
  });
  assert.match(text, /第一段/);
  assert.match(text, /第二段/);
});

test('M-07 边界: is_error 的 tool_result → 标记为错误结果', () => {
  const text = promptText({
    messages: [{
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'toolu_3', content: 'ENOENT', is_error: true }]
    }]
  });
  assert.match(text, /ENOENT/);
  assert.match(text, /error/i, '错误结果必须让模型看出这次调用失败了');
});

test('M-07 边界: tool_result 与文本块混在一条 user 消息里 → 拆成两条内部消息但顺序不变', () => {
  const translated = translateAnthropicRequest({
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: '这是结果' },
        { type: 'tool_result', tool_use_id: 'toolu_4', content: 'ok' }
      ]
    }]
  });
  assert.deepEqual(translated.messages.map(m => m.role), ['user', 'tool']);
  const text = blocksToPlainText(buildPrompt(translated.messages));
  assert.ok(text.indexOf('这是结果') < text.indexOf('ok'), '顺序必须保持');
});

// ---------- M-08：tool_use 块保留调用意图（当前被丢弃） ----------

test('M-08: assistant 含 tool_use 块 → 保留 [Assistant tool call: …]（当前被丢弃）', () => {
  const text = promptText({
    messages: [
      { role: 'user', content: '查天气' },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'toolu_9', name: 'get_weather', input: { city: 'SF' } }]
      }
    ]
  });
  assert.match(text, /\[Assistant tool call: get_weather/);
  assert.match(text, /"city":"SF"/);
});

// ---------- M-09：thinking 块不回灌 ----------

test('M-09: assistant 含 thinking / redacted_thinking 块 → 不进入 prompt', () => {
  const text = promptText({
    messages: [
      { role: 'user', content: '问题' },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: '内部推理内容不应回灌', signature: 'sig-abc' },
          { type: 'redacted_thinking', data: 'encrypted-blob' },
          { type: 'text', text: '正式回答' }
        ]
      }
    ]
  });
  assert.doesNotMatch(text, /内部推理内容不应回灌/);
  assert.doesNotMatch(text, /encrypted-blob/);
  assert.match(text, /正式回答/, 'thinking 旁边的正式回答必须保留');
});

test('M-09 边界: 只有 thinking 没有 text 的 assistant 消息 → 不产生空 [Assistant] 段', () => {
  const text = promptText({
    messages: [
      { role: 'user', content: 'q' },
      { role: 'assistant', content: [{ type: 'thinking', thinking: '只有思考' }] },
      { role: 'user', content: 'r' }
    ]
  });
  assert.doesNotMatch(text, /\[Assistant previous reply\]/);
});

// ---------- M-19：base64 图片（防回归） ----------

test('M-19: Anthropic base64 图片块 → 产物含 ACP image 块', () => {
  const blocks = buildPrompt(translateAnthropicRequest({
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: '看这张图' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG_1PX } }
      ]
    }]
  }).messages);

  const images = blocks.filter(b => b.type === 'image');
  assert.equal(images.length, 1, '图片不能被丢');
  assert.equal(images[0].mimeType, 'image/png');
  assert.equal(images[0].data, PNG_1PX);
  // 图片必须紧跟其所属消息的文本之后（多轮多图防张冠李戴）
  const textIdx = blocks.findIndex(b => b.type === 'text' && b.text.includes('看这张图'));
  const imgIdx = blocks.findIndex(b => b.type === 'image');
  assert.ok(textIdx >= 0 && imgIdx > textIdx, '图片应排在所属文本之后');
});

test('M-19 边界: source.type=url 的图片 → 转成 image_url 交给既有 SSRF 守卫抓取', () => {
  const translated = translateAnthropicRequest({
    messages: [{
      role: 'user',
      content: [{ type: 'image', source: { type: 'url', url: 'https://example.com/a.png' } }]
    }]
  });
  const parts = translated.messages[0].content;
  assert.equal(parts[0].type, 'image_url', '不能静默丢弃远程图片');
  assert.equal(parts[0].image_url.url, 'https://example.com/a.png');
});

test('M-19 边界: 未知 source 类型的图片 → 不产生 image 块且不抛错', () => {
  assert.doesNotThrow(() => {
    const blocks = buildPrompt(translateAnthropicRequest({
      messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'file', file_id: 'f1' } }] }]
    }).messages);
    assert.equal(blocks.filter(b => b.type === 'image').length, 0);
  });
});

// ---------- 工具定义翻译 ----------

test('工具定义：Anthropic {name,description,input_schema} → OpenAI function 形状', () => {
  const tools = translateAnthropicTools([{
    name: 'get_weather',
    description: '查天气',
    input_schema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] }
  }]);
  assert.equal(tools.length, 1);
  assert.equal(tools[0].type, 'function');
  assert.equal(tools[0].function.name, 'get_weather');
  assert.equal(tools[0].function.description, '查天气');
  assert.deepEqual(tools[0].function.parameters.required, ['city']);
});

test('工具定义：无 tools → undefined（不能是空数组，否则被当成"带工具"走全量后端）', () => {
  assert.equal(translateAnthropicTools(undefined), undefined);
  assert.equal(translateAnthropicTools([]), undefined);
});

test('工具定义：缺 input_schema → 补空 object schema（网关不接受 undefined parameters）', () => {
  const tools = translateAnthropicTools([{ name: 'ping' }]);
  assert.deepEqual(tools[0].function.parameters, { type: 'object', properties: {} });
});

test('Q1/CR S-3: 服务端工具（带 type）一律忽略，不得注册成委托工具', () => {
  // Anthropic 的服务端工具用 type 判别且没有 input_schema，语义是「由 Anthropic
  // 后端执行」。本代理没有对应执行器；若注册成委托工具，客户端会收到一个自己
  // 从未声明的工具调用（且我们补的空 schema 让调用必然无参数）。降级成"无工具"
  // 是唯一诚实的处理（Q1 非目标）。
  const server = [
    { type: 'web_search_20250305', name: 'web_search', max_uses: 5 },
    { type: 'computer_use_20250124', name: 'computer' },
    { type: 'bash_20250124', name: 'bash' },
    { type: 'text_editor_20250124', name: 'str_replace_editor' }
  ];
  assert.equal(translateAnthropicTools(server), undefined, '全是服务端工具 → 等价于无工具');
});

test('Q1/CR S-3: 服务端工具与自定义工具混排 → 只保留自定义工具', () => {
  const tools = translateAnthropicTools([
    { type: 'web_search_20250305', name: 'web_search' },
    { name: 'get_weather', input_schema: { type: 'object', properties: {} } },
    { type: 'custom', name: 'my_tool', input_schema: { type: 'object', properties: {} } },
    { type: 'computer_use_20250124', name: 'computer' }
  ]);
  assert.deepEqual(tools.map(t => t.function.name), ['get_weather', 'my_tool'],
    '服务端工具不得出现在委托工具列表里（否则客户端被喂未知工具调用）');
});

// ---------- Q5：不支持参数接受但忽略 ----------

test('Q5: max_tokens / temperature / top_k / stop_sequences / tool_choice 接受但不报错', () => {
  assert.doesNotThrow(() => {
    const t = translateAnthropicRequest({
      model: 'claude-sonnet-4-5-20250929',
      max_tokens: 1024,
      temperature: 0.7,
      top_p: 0.9,
      top_k: 40,
      stop_sequences: ['\n\nHuman:'],
      tool_choice: { type: 'auto' },
      metadata: { user_id: 'u1' },
      messages: [{ role: 'user', content: 'hi' }]
    });
    assert.equal(t.stream, false);
    assert.equal(t.messages.length, 1);
  });
});

// ---------- Q3：模型 id 映射 ----------

test('Q3: claude-* → 映射到代理默认模型', () => {
  assert.equal(resolveAnthropicModel('claude-sonnet-4-5-20250929', {}), 'hy4-preview-f');
  assert.equal(resolveAnthropicModel('claude-3-5-haiku-latest', {}), 'hy4-preview-f');
});

test('Q3: BUDDY2API_ANTHROPIC_MODEL 覆盖映射目标', () => {
  assert.equal(
    resolveAnthropicModel('claude-opus-4-1', { BUDDY2API_ANTHROPIC_MODEL: 'deepseek-v4.1-flash' }),
    'deepseek-v4.1-flash'
  );
});

test('Q3: 非 claude 前缀 id 原样透传（隐藏 id 仍可用，与 OpenAI 路径一致）', () => {
  assert.equal(resolveAnthropicModel('glm-5.3', {}), 'glm-5.3');
  assert.equal(resolveAnthropicModel('hy4-preview-f', {}), 'hy4-preview-f');
});

test('Q3 边界: 缺省 / auto / default → 代理默认模型（Anthropic 虽要求 model，缺省也不能崩）', () => {
  for (const v of [undefined, null, '', 'auto', 'default']) {
    assert.equal(resolveAnthropicModel(v, {}), 'hy4-preview-f');
  }
});

test('Q3: isClaudeModelId 识别（供 handler 打映射告警用）', () => {
  assert.equal(isClaudeModelId('claude-sonnet-4-5'), true);
  assert.equal(isClaudeModelId('Claude-3-Opus'), true);
  assert.equal(isClaudeModelId('glm-5.3'), false);
  assert.equal(isClaudeModelId(undefined), false);
});

// ---------- Q4 / P1：thinking 开关（请求驱动） ----------

test('Q4: BUDDY2API_ANTHROPIC_THINKING 语义收窄为「请求未携带时的回落默认」', () => {
  assert.equal(anthropicThinkingEnabled({}), false);
  assert.equal(anthropicThinkingEnabled({ BUDDY2API_ANTHROPIC_THINKING: '0' }), false);
  assert.equal(anthropicThinkingEnabled({ BUDDY2API_ANTHROPIC_THINKING: '1' }), true);
});

test('P1 表驱动: 请求 thinking.type 决定开关；缺失/未知/畸形一律回落环境变量（不报错）', () => {
  const cases = [
    // [thinking, env, expected, 说明]
    [{ type: 'enabled' }, {}, true, 'T1：显式开启'],
    [{ type: 'enabled', budget_tokens: 4096 }, {}, true, 'T1：budget_tokens 是伴随字段，不参与判断（也不透传上游）'],
    [{ type: 'enabled', display: 'summarized' }, {}, true, 'T17：display=summarized（默认）→ 照发正文'],
    [{ type: 'enabled', display: 'omitted' }, {}, false, 'T17：display=omitted（只留签名、不回正文）→ 本代理产不出真签名，只能按不可见处理'],
    [{ type: 'adaptive', display: 'omitted' }, { BUDDY2API_ANTHROPIC_THINKING: '1' }, false, 'T17：omitted 压过环境变量'],
    [{ type: 'enabled', display: 'weird' }, {}, true, 'T17：未知 display → 按默认 summarized 处理，不因新枚举值误关'],
    [{ type: 'adaptive' }, {}, true, 'T2：规范新形态 adaptive 同样开启'],
    [{ type: 'disabled' }, { BUDDY2API_ANTHROPIC_THINKING: '1' }, false, 'T3：显式关闭压过环境变量'],
    [{ type: 'disabled' }, {}, false, 'T3：显式关闭'],
    [undefined, {}, false, 'T4：未携带 → 回落（默认关）'],
    [undefined, { BUDDY2API_ANTHROPIC_THINKING: '1' }, true, 'T5：未携带 → 回落环境变量=1'],
    [{ type: 'foo' }, {}, false, 'T6：未知 type → 回落而非报错（规范演进容忍）'],
    [{ type: 'foo' }, { BUDDY2API_ANTHROPIC_THINKING: '1' }, true, 'T6：未知 type → 回落环境变量'],
    [null, { BUDDY2API_ANTHROPIC_THINKING: '1' }, true, 'T7：null（畸形）→ 回落'],
    ['enabled', { BUDDY2API_ANTHROPIC_THINKING: '1' }, true, 'T7：字符串（畸形）→ 回落，不得被当对象解引用'],
    [42, {}, false, 'T7：数字（畸形）→ 回落'],
    [{}, {}, false, '缺 type 字段 → 回落'],
    [{ type: true }, {}, false, 'type 非字符串 → 回落，不得因真值误开'],
    [{ type: 'ENABLED' }, {}, false, '大小写不宽容：规范是小写枚举，非枚举值一律回落']
  ];
  for (const [thinking, env, expected, why] of cases) {
    assert.equal(resolveAnthropicThinking(thinking, env), expected, why);
  }
});

test('P1: translateAnthropicRequest 透出 thinkingEnabled（请求驱动决策的唯一产生点）', () => {
  const base = { messages: [{ role: 'user', content: 'hi' }] };
  assert.equal(
    translateAnthropicRequest({ ...base, thinking: { type: 'enabled' } }).thinkingEnabled, true,
    '客户端显式 opt-in 必须被翻译层感知——旧实现完全忽略该参数（静默拿不到，最糟的失败模式）'
  );
  assert.equal(
    translateAnthropicRequest({ ...base, thinking: { type: 'disabled' } }).thinkingEnabled, false
  );
  assert.equal(
    translateAnthropicRequest({ ...base, thinking: { type: 'adaptive' } }).thinkingEnabled, true
  );
});

// ---------- 翻译产物整体形状 ----------

test('翻译产物：协议标记 + messages/tools/model/stream 字段齐备', () => {
  const t = translateAnthropicRequest({
    model: 'claude-sonnet-4-5',
    stream: true,
    messages: [{ role: 'user', content: 'hi' }]
  });
  assert.equal(t.protocol, 'anthropic');
  assert.equal(t.stream, true);
  assert.equal(t.model, 'claude-sonnet-4-5');
  assert.equal(t.tools, undefined);
  assert.equal(t.messages[0].role, 'user');
});

test('翻译产物：messages 非数组时不崩（返回 system-only 或空数组由上层校验兜底）', () => {
  assert.doesNotThrow(() => {
    const t = translateAnthropicRequest({ model: 'claude-x' });
    assert.ok(Array.isArray(t.messages));
  });
});

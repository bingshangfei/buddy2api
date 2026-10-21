/**
 * prompt-builder 单测（node:test，零依赖）
 * 覆盖图片内容块转换（dataUrlToImageBlock / contentPartToAcpBlock / contentToAcpBlocks）
 * 与 buildPrompt 的图文顺序。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  blocksToPlainText,
  buildPrompt,
  contentToAcpBlocks,
  contentPartToAcpBlock,
  dataUrlToImageBlock,
  messageToText,
  sanitizePrompt
} from '../src/prompt-builder.js';

const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const PNG_DATA_URL = `data:image/png;base64,${PNG_B64}`;

// ---------- dataUrlToImageBlock ----------

test('dataUrlToImageBlock: data:image/png;base64 → ACP image 块', () => {
  assert.deepEqual(dataUrlToImageBlock(PNG_DATA_URL), {
    type: 'image',
    data: PNG_B64,
    mimeType: 'image/png'
  });
});

test('dataUrlToImageBlock: 保留其它 MIME（jpeg/gif/webp）', () => {
  assert.equal(dataUrlToImageBlock('data:image/jpeg;base64,AAAA').mimeType, 'image/jpeg');
  assert.equal(dataUrlToImageBlock('data:image/webp;base64,AAAA').mimeType, 'image/webp');
});

test('dataUrlToImageBlock: 远程 URL / 非 base64 / 空数据 → null', () => {
  assert.equal(dataUrlToImageBlock('https://example.com/a.png'), null, '远程 URL 需先抓取');
  assert.equal(dataUrlToImageBlock('data:image/svg+xml,<svg/>'), null, '非 base64 无法内联');
  assert.equal(dataUrlToImageBlock('data:image/png;base64,'), null, '空数据');
  assert.equal(dataUrlToImageBlock(null), null);
  assert.equal(dataUrlToImageBlock(undefined), null);
});

// ---------- contentPartToAcpBlock：三种客户端写法 ----------

test('contentPartToAcpBlock: OpenAI image_url（对象与裸字符串两种）', () => {
  const expected = { type: 'image', data: PNG_B64, mimeType: 'image/png' };
  assert.deepEqual(contentPartToAcpBlock({ type: 'image_url', image_url: { url: PNG_DATA_URL } }), expected);
  assert.deepEqual(contentPartToAcpBlock({ type: 'image_url', image_url: PNG_DATA_URL }), expected);
});

test('contentPartToAcpBlock: Anthropic source 形式', () => {
  assert.deepEqual(
    contentPartToAcpBlock({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'AAAA' } }),
    { type: 'image', data: 'AAAA', mimeType: 'image/jpeg' }
  );
});

test('contentPartToAcpBlock: ACP 原生形式（透传，缺省 mimeType 补 png）', () => {
  assert.deepEqual(
    contentPartToAcpBlock({ type: 'image', data: 'AAAA', mimeType: 'image/gif' }),
    { type: 'image', data: 'AAAA', mimeType: 'image/gif' }
  );
  assert.deepEqual(
    contentPartToAcpBlock({ type: 'image', data: 'AAAA' }),
    { type: 'image', data: 'AAAA', mimeType: 'image/png' }
  );
});

test('contentPartToAcpBlock: 文本块 / 未知块 → null', () => {
  assert.equal(contentPartToAcpBlock({ type: 'text', text: 'hi' }), null);
  assert.equal(contentPartToAcpBlock(null), null);
});

// ---------- contentToAcpBlocks ----------

test('contentToAcpBlocks: 字符串 content → 单个 text 块', () => {
  assert.deepEqual(contentToAcpBlocks('hello'), [{ type: 'text', text: 'hello' }]);
});

test('contentToAcpBlocks: 文本 + 图片混合，保持顺序', () => {
  const blocks = contentToAcpBlocks([
    { type: 'text', text: '看图' },
    { type: 'image_url', image_url: { url: PNG_DATA_URL } },
    { type: 'text', text: '这是什么？' }
  ]);
  assert.deepEqual(blocks, [
    { type: 'text', text: '看图' },
    { type: 'image', data: PNG_B64, mimeType: 'image/png' },
    { type: 'text', text: '这是什么？' }
  ]);
});

test('contentToAcpBlocks: 连续文本合并为一个块', () => {
  const blocks = contentToAcpBlocks([
    { type: 'text', text: 'a' },
    { type: 'text', text: 'b' }
  ]);
  assert.deepEqual(blocks, [{ type: 'text', text: 'a\nb' }]);
});

test('contentToAcpBlocks: 空 / 非法 content → 单个空 text 块', () => {
  assert.deepEqual(contentToAcpBlocks([]), [{ type: 'text', text: '' }]);
  assert.deepEqual(contentToAcpBlocks(null), [{ type: 'text', text: '' }]);
});

// ---------- buildPrompt：图文顺序 ----------

test('buildPrompt: 单条带图消息 → 图文块按顺序', () => {
  const blocks = buildPrompt([
    { role: 'user', content: [
      { type: 'text', text: '描述这张图' },
      { type: 'image_url', image_url: { url: PNG_DATA_URL } }
    ] }
  ]);
  assert.equal(blocks.length, 2);
  assert.deepEqual(blocks[0], { type: 'text', text: '[User]\n描述这张图' });
  assert.equal(blocks[1].type, 'image');
});

// 会话亲和（conversation-cache.js）靠"本轮文本以上轮文本为前缀"来复用后端
// 会话、只发增量。首轮若不带 [User] 前缀，prefix 关系在第二轮就断了。
test('buildPrompt: 首轮文本是第二轮文本的前缀（会话亲和的必要条件）', () => {
  const turn1 = blocksToPlainText(buildPrompt([{ role: 'user', content: '第一轮' }]));
  const turn2 = blocksToPlainText(buildPrompt([
    { role: 'user', content: '第一轮' },
    { role: 'assistant', content: '回答' },
    { role: 'user', content: '第二轮' }
  ]));
  assert.equal(turn1, '[User]\n第一轮');
  assert.ok(turn2.startsWith(turn1), `turn2 应以 turn1 为前缀，实际 turn2=${JSON.stringify(turn2)}`);
  assert.ok(turn2.length > turn1.length);
});

test('buildPrompt: 多轮时图片紧跟所属消息，不与后续文本错位', () => {
  const blocks = buildPrompt([
    { role: 'user', content: '第一轮' },
    { role: 'user', content: [
      { type: 'text', text: '第二轮带图' },
      { type: 'image_url', image_url: { url: PNG_DATA_URL } }
    ] },
    { role: 'user', content: '第三轮' }
  ]);

  // 期望：[text(第一轮+第二轮)] [image] [text(第三轮)]
  assert.deepEqual(blocks.map(b => b.type), ['text', 'image', 'text']);
  assert.match(blocks[0].text, /第二轮带图/);
  assert.match(blocks[0].text, /\[User\]\n第一轮/);
  assert.equal(blocks[2].text, '[User]\n第三轮', '图片之后的文本不得并入图片前的块');
});

test('buildPrompt: 纯图片消息（无文本）也能带上图', () => {
  const blocks = buildPrompt([
    { role: 'user', content: [{ type: 'image_url', image_url: { url: PNG_DATA_URL } }] }
  ]);
  assert.deepEqual(blocks.map(b => b.type), ['image']);
});

test('buildPrompt: 纯文本多轮行为不变（回归）', () => {
  const blocks = buildPrompt([
    { role: 'system', content: '你是助手' },
    { role: 'user', content: '你好' },
    { role: 'assistant', content: '嗨' }
  ]);
  assert.equal(blocks.length, 1, '纯文本仍合并为单个 text 块');
  assert.equal(
    blocks[0].text,
    '[System instructions]\n你是助手\n\n[User]\n你好\n\n[Assistant previous reply]\n嗨'
  );
});

test('buildPrompt: assistant 带 tool_calls 时保留调用意图（回归）', () => {
  const blocks = buildPrompt([
    { role: 'user', content: '查天气' },
    { role: 'assistant', content: '', tool_calls: [{ function: { name: 'weather', arguments: '{"city":"上海"}' } }] }
  ]);
  assert.match(blocks[0].text, /\[Assistant tool call: weather\(\{"city":"上海"\}\)\]/);
});

test('buildPrompt: 空消息数组 → 单个空 text 块', () => {
  assert.deepEqual(buildPrompt([]), [{ type: 'text', text: '' }]);
  assert.deepEqual(buildPrompt(null), [{ type: 'text', text: '' }]);
});

// ---------- sanitizePrompt 与图片共存 ----------

test('sanitizePrompt: 净化文本但原样保留 image 块', () => {
  const blocks = [
    { type: 'text', text: 'You are ZCode' },
    { type: 'image', data: PNG_B64, mimeType: 'image/png' }
  ];
  const out = sanitizePrompt(blocks);
  assert.equal(out[0].text, 'You are workbuddy');
  assert.deepEqual(out[1], blocks[1], 'image 块不得被改写');
});

// ---------- messageToText（工具结果仍走纯文本） ----------

test('messageToText: 只取文本，忽略图片块', () => {
  assert.equal(
    messageToText({ role: 'user', content: [
      { type: 'text', text: 'abc' },
      { type: 'image_url', image_url: { url: PNG_DATA_URL } }
    ] }),
    'abc'
  );
});

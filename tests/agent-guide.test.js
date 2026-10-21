/**
 * Agent 接入配置指南单测（node:test，零依赖）
 *
 * 覆盖 scripts/models.js「模型清单 + 接入指南」共用文案的核心事实：
 * 三件套（Base URL / API Key / 模型 id）必须出现，端口与默认模型由
 * 调用方注入，defaultModel 缺省时不能留下悬空提示。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentGuideLines } from '../src/agent-guide.js';

const text = (opts) => agentGuideLines(opts).join('\n');

test('包含三件套：Base URL / API Key / 模型 id', () => {
  const out = text({ baseUrl: 'http://127.0.0.1:8000/v1', defaultModel: 'hy4-preview-f' });
  assert.match(out, /Base URL\s+http:\/\/127\.0\.0\.1:8000\/v1/);
  assert.match(out, /API Key\s+任意值/);
  assert.match(out, /local/, '客户端强制必填时的兜底建议');
  assert.match(out, /模型 id/);
});

test('defaultModel 注入「不填 model 时用代理默认」', () => {
  const out = text({ baseUrl: 'http://127.0.0.1:8001/v1', defaultModel: 'glm-5.3' });
  assert.match(out, /不填 model 时用代理默认：glm-5\.3/);
});

test('defaultModel 缺省时改指清单入口，不留下空提示', () => {
  const out = text({ defaultModel: null });
  assert.match(out, /模型 id\s+清单里的任意 id/);
  assert.doesNotMatch(out, /代理默认：/);
});

test('自动补 /v1 的客户端给出去掉后缀的 host', () => {
  const out = text({ baseUrl: 'http://192.168.1.5:8000/v1' });
  assert.match(out, /客户端自动补 \/v1 的填 http:\/\/192\.168\.1\.5:8000/);
});

test('覆盖常见 agent：聊天客户端 / Cline / aider / 自建平台', () => {
  const out = text({ defaultModel: 'hy4-preview-f' });
  assert.match(out, /Cherry Studio \/ ChatBox \/ LobeChat/);
  assert.match(out, /Cline \/ Roo Code/);
  assert.match(out, /OpenAI Compatible/);
  assert.match(out, /aider --openai-api-base http:\/\/127\.0\.0\.1:8000\/v1 --openai-api-key local/);
  assert.match(out, /Open WebUI \/ Dify/);
});

test('带 curl 验证命令与关键提示（免费优先 / 会话池隔离 / 局域网）', () => {
  const out = text({ defaultModel: 'hy4-preview-f' });
  assert.match(out, /curl http:\/\/127\.0\.0\.1:8000\/v1\/chat\/completions/);
  assert.match(out, /x0\.00 的免费模型/);
  assert.match(out, /隔离各自的会话池/);
  assert.match(out, /\?apiKey=/);
  assert.match(out, /HOST=0\.0\.0\.0/);
});

test('baseUrl 传入自定义端口与 host 时全文跟随', () => {
  const out = text({ baseUrl: 'http://10.0.0.2:9000/v1', defaultModel: 'auto' });
  assert.match(out, /http:\/\/10\.0\.0\.2:9000\/v1/);
  assert.match(out, /openai\/<模型id>/);
  assert.match(out, /代理默认：auto/);
});

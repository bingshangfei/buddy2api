/**
 * acp-events 纯函数单测（node:test，零依赖）
 * 覆盖 parseAcpUpdate 各分支与 extractModelsFromSessionResult。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseAcpUpdate,
  contentToText,
  extractModelsFromSessionResult
} from '../src/acp-events.js';

// ---------- contentToText ----------

test('contentToText: 对象形式 {type, text}', () => {
  assert.equal(contentToText({ type: 'text', text: 'hello' }), 'hello');
});

test('contentToText: 字符串形式', () => {
  assert.equal(contentToText('plain string'), 'plain string');
});

test('contentToText: 无 text 字段 → 空串', () => {
  assert.equal(contentToText({ type: 'image' }), '');
  assert.equal(contentToText(null), '');
  assert.equal(contentToText(undefined), '');
});

// ---------- parseAcpUpdate: agent_message_chunk ----------

test('parseAcpUpdate: agent_message_chunk → {type: delta, text}', () => {
  const event = {
    jsonrpc: '2.0',
    method: 'session/update',
    params: {
      sessionId: 's1',
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Hello ' }
      }
    }
  };
  assert.deepEqual(parseAcpUpdate(event), { type: 'delta', text: 'Hello ' });
});

test('parseAcpUpdate: agent_message_chunk 空内容 → {type: other}', () => {
  const event = {
    method: 'session/update',
    params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '' } } }
  };
  assert.deepEqual(parseAcpUpdate(event), { type: 'other' });
});

// ---------- parseAcpUpdate: agent_thought_chunk ----------

test('parseAcpUpdate: agent_thought_chunk → {type: reasoning, text}', () => {
  const event = {
    method: 'session/update',
    params: {
      update: {
        sessionUpdate: 'agent_thought_chunk',
        content: { type: 'text', text: 'The user wants' },
        _meta: { 'codebuddy.ai/sourceEvent': { facets: ['reasoning'] } }
      }
    }
  };
  assert.deepEqual(parseAcpUpdate(event), { type: 'reasoning', text: 'The user wants' });
});

// ---------- parseAcpUpdate: usage_update ----------

test('parseAcpUpdate: usage_update → {type: usage, usage}', () => {
  const event = {
    method: 'session/update',
    params: {
      update: {
        sessionUpdate: 'usage_update',
        used: 30660,
        size: 168000,
        _meta: {
          usage: {
            prompt_tokens: 30660,
            completion_tokens: 6,
            total_tokens: 30666
          }
        }
      }
    }
  };
  assert.deepEqual(parseAcpUpdate(event), {
    type: 'usage',
    usage: { prompt_tokens: 30660, completion_tokens: 6 }
  });
});

test('parseAcpUpdate: usage_update 无 usage → {type: other}', () => {
  const event = {
    method: 'session/update',
    params: { update: { sessionUpdate: 'usage_update', used: 0, size: 168000 } }
  };
  assert.deepEqual(parseAcpUpdate(event), { type: 'other' });
});

test('parseAcpUpdate: usage_update 带 model → 透传给 token 统计', () => {
  for (const field of ['model', 'modelId']) {
    const event = {
      method: 'session/update',
      params: {
        update: {
          sessionUpdate: 'usage_update',
          _meta: { usage: { prompt_tokens: 10, completion_tokens: 2, [field]: 'glm-5.3-flash' } }
        }
      }
    };
    assert.deepEqual(parseAcpUpdate(event), {
      type: 'usage',
      usage: { prompt_tokens: 10, completion_tokens: 2, model: 'glm-5.3-flash' }
    });
  }
});

test('parseAcpUpdate: cached_tokens=0 + prompt_cache_miss_tokens → 反推命中量', () => {
  // 实测 CLI：把 cached_tokens 报成 0，真实命中量在 prompt_cache_miss_tokens。
  // 解析层必须把它还原成 cached = prompt - miss，否则统计会把命中前缀记成未命中。
  const event = {
    method: 'session/update',
    params: {
      update: {
        sessionUpdate: 'usage_update',
        _meta: {
          usage: {
            prompt_tokens: 22666,
            completion_tokens: 3,
            cached_tokens: 0,
            prompt_cache_miss_tokens: 177
          }
        }
      }
    }
  };
  assert.deepEqual(parseAcpUpdate(event), {
    type: 'usage',
    usage: { prompt_tokens: 22666, completion_tokens: 3, cached_tokens: 22489, cache_miss_tokens: 177 }
  });
});

test('parseAcpUpdate: prompt_cache_hit_tokens 优先于 cached_tokens', () => {
  const event = {
    method: 'session/update',
    params: {
      update: {
        sessionUpdate: 'usage_update',
        _meta: { usage: { prompt_tokens: 100, completion_tokens: 1, prompt_cache_hit_tokens: 80, cached_tokens: 0 } }
      }
    }
  };
  assert.deepEqual(parseAcpUpdate(event), {
    type: 'usage',
    usage: { prompt_tokens: 100, completion_tokens: 1, cached_tokens: 80 }
  });
});

// ---------- parseAcpUpdate: 其他事件 ----------
test('parseAcpUpdate: session_info_update → {type: other}', () => {
  const event = {
    method: 'session/update',
    params: { update: { sessionUpdate: 'session_info_update' } }
  };
  assert.deepEqual(parseAcpUpdate(event), { type: 'other' });
});

test('parseAcpUpdate: session_info_update 含 phase → {type: progress}', () => {
  const event = {
    method: 'session/update',
    params: {
      update: {
        sessionUpdate: 'session_info_update',
        _meta: { 'codebuddy.ai/agentPhase': { phase: 'model_requesting', startedAt: 1234 } }
      }
    }
  };
  assert.deepEqual(parseAcpUpdate(event), { type: 'progress', progress: null, phase: 'model_requesting' });
});

test('parseAcpUpdate: session_info_update 含 progress 字符串 → {type: progress}', () => {
  const event = {
    method: 'session/update',
    params: {
      update: {
        sessionUpdate: 'session_info_update',
        _meta: { 'codebuddy.ai/progress': '正在压缩上下文' }
      }
    }
  };
  assert.deepEqual(parseAcpUpdate(event), { type: 'progress', progress: '正在压缩上下文', phase: undefined });
});

test('parseAcpUpdate: 非 session/update 事件 → null', () => {
  assert.equal(parseAcpUpdate(null), null);
  assert.equal(parseAcpUpdate({ jsonrpc: '2.0', id: 'r1', result: {} }), null);
  assert.equal(parseAcpUpdate({ method: '_codebuddy.ai/command' }), null);
});

// ---------- extractModelsFromSessionResult ----------

test('extractModelsFromSessionResult: 提取 model 选项', () => {
  const result = {
    sessionId: 's1',
    configOptions: [
      { type: 'select', id: 'mode', options: [{ value: 'default', name: 'Always Ask' }] },
      {
        type: 'select',
        id: 'model',
        currentValue: 'auto',
        options: [
          { value: 'auto', name: 'Auto' },
          { value: 'glm-5.3', name: 'GLM-5.3' },
          { value: 'deepseek-v4-pro', name: 'Deepseek-V4-Pro' }
        ]
      }
    ]
  };
  assert.deepEqual(extractModelsFromSessionResult(result), [
    { id: 'auto', name: 'Auto' },
    { id: 'glm-5.3', name: 'GLM-5.3' },
    { id: 'deepseek-v4-pro', name: 'Deepseek-V4-Pro' }
  ]);
});

test('extractModelsFromSessionResult: 无 model 选项 → 空数组', () => {
  assert.deepEqual(extractModelsFromSessionResult({ sessionId: 's1', configOptions: [] }), []);
  assert.deepEqual(extractModelsFromSessionResult(null), []);
  assert.deepEqual(extractModelsFromSessionResult({}), []);
});

test('extractModelsFromSessionResult: 过滤无 value 的选项', () => {
  const result = {
    configOptions: [
      { id: 'model', options: [{ value: 'auto', name: 'Auto' }, { name: 'NoValue' }] }
    ]
  };
  assert.deepEqual(extractModelsFromSessionResult(result), [{ id: 'auto', name: 'Auto' }]);
});

test('extractModelsFromSessionResult: currentValue 不在 options 时补进列表（隐藏默认模型）', () => {
  const result = {
    configOptions: [
      {
        id: 'model',
        currentValue: 'glm-5.3-flash',
        options: [{ value: 'fast-model', name: '快速' }, { value: 'balanced-model', name: '均衡' }]
      }
    ]
  };
  assert.deepEqual(extractModelsFromSessionResult(result), [
    { id: 'glm-5.3-flash', name: 'glm-5.3-flash' },
    { id: 'fast-model', name: '快速' },
    { id: 'balanced-model', name: '均衡' }
  ]);
});

test('extractModelsFromSessionResult: currentValue 已在 options 时不重复', () => {
  const result = {
    configOptions: [
      {
        id: 'model',
        currentValue: 'auto',
        options: [{ value: 'auto', name: 'Auto' }, { value: 'deep-model', name: '极致' }]
      }
    ]
  };
  assert.deepEqual(extractModelsFromSessionResult(result), [
    { id: 'auto', name: 'Auto' },
    { id: 'deep-model', name: '极致' }
  ]);
});

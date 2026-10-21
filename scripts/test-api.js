// 端到端链路直连测试：绕过 shell 编码问题，用 fetch 直接打本地 8000
const BASE = process.env.BUDDY2API_BASE || 'http://127.0.0.1:8000';
const MODEL = process.env.TEST_MODEL || 'glm-5.3-flash';

async function post(path, body, { stream = false } = {}) {
  const started = Date.now();
  const res = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify(body),
  });
  return { res, started };
}

function ok(name, extra = '') {
  console.log(`  PASS  ${name}${extra ? '  ' + extra : ''}`);
}
function fail(name, detail) {
  console.log(`  FAIL  ${name}\n        ${detail}`);
}

async function testHealth() {
  console.log('\n[1] 服务状态');
  const res = await fetch(BASE + '/');
  const json = await res.json();
  if (res.status === 200 && json.status === 'ok') ok('/', JSON.stringify(json.endpoints));
  else fail('/', `HTTP ${res.status} ${JSON.stringify(json)}`);
}

async function testModels() {
  console.log('\n[2] 模型列表');
  const res = await fetch(BASE + '/v1/models');
  const json = await res.json();
  const ids = (json.data || []).map((m) => m.id);
  if (res.status === 200 && ids.length) ok('/v1/models', `${ids.length} 个模型: ${ids.slice(0, 6).join(', ')}...`);
  else fail('/v1/models', `HTTP ${res.status} ${JSON.stringify(json)}`);
}

async function testNonStream() {
  console.log('\n[3] 非流式对话（中文）');
  const { res, started } = await post('/v1/chat/completions', {
    model: MODEL,
    messages: [{ role: 'user', content: '请只回复两个字：正常' }],
    max_tokens: 50,
  });
  const json = await res.json();
  const content = json?.choices?.[0]?.message?.content ?? '';
  if (res.status === 200 && content.includes('正常')) {
    ok('非流式', `${Date.now() - started}ms, content="${content.trim()}", prompt_tokens=${json.usage?.prompt_tokens}`);
  } else {
    fail('非流式', `HTTP ${res.status} ${JSON.stringify(json).slice(0, 500)}`);
  }
}

async function testStream() {
  console.log('\n[4] 流式对话（中文 + SSE 解析）');
  const { res, started } = await post('/v1/chat/completions', {
    model: MODEL,
    messages: [{ role: 'user', content: '请用中文从一数到五，顿号分隔，不要解释' }],
    max_tokens: 80,
    stream: true,
  });
  if (!res.ok) return fail('流式', `HTTP ${res.status}`);

  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buf = '';
  let text = '';
  let reasoning = '';
  let chunks = 0;
  let done = false;

  while (!done) {
    const { value, done: d } = await reader.read();
    if (d) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const payload = line.slice(6).trim();
      if (payload === '[DONE]') { done = true; break; }
      try {
        const j = JSON.parse(payload);
        chunks++;
        const delta = j.choices?.[0]?.delta || {};
        if (delta.content) text += delta.content;
        if (delta.reasoning_content) reasoning += delta.reasoning_content;
      } catch { /* 忽略非 JSON 行 */ }
    }
  }

  if (text.includes('一') && text.includes('五')) {
    ok('流式', `${Date.now() - started}ms, ${chunks} chunks, content="${text.trim()}"`);
  } else {
    fail('流式', `内容异常: "${text.trim()}" (chunks=${chunks}, reasoning="${reasoning.trim().slice(0, 80)}")`);
  }
}

async function testMultiTurn() {
  console.log('\n[5] 多轮上下文记忆');
  const messages = [
    { role: 'user', content: '记住这个数字：4271。只回复"好的"。' },
  ];
  let json = await (await post('/v1/chat/completions', { model: MODEL, messages, max_tokens: 50 })).res.json();
  const first = json?.choices?.[0]?.message?.content ?? '';
  messages.push({ role: 'assistant', content: first });
  messages.push({ role: 'user', content: '我刚才让你记住的数字是多少？只回复数字。' });
  json = await (await post('/v1/chat/completions', { model: MODEL, messages, max_tokens: 50 })).res.json();
  const second = json?.choices?.[0]?.message?.content ?? '';
  if (second.includes('4271')) ok('多轮', `第二轮回复="${second.trim()}"`);
  else fail('多轮', `第二轮回复="${second.trim()}"，未包含 4271`);
}

(async () => {
  console.log(`直连 ${BASE}  模型=${MODEL}`);
  try {
    await testHealth();
    await testModels();
    await testNonStream();
    await testStream();
    await testMultiTurn();
  } catch (e) {
    console.log('\n  ERROR  ' + (e?.cause?.code || e?.message || e));
    process.exitCode = 1;
  }
})();

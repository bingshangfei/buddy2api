/**
 * router.js — 路由矩阵（纯函数）+ handler 单例。
 *
 * 从 index.js 拆出：route(method, path, body, ctx) 是无 HTTP 依赖的纯路由，
 * 可直接单测（tests/route.test.js）；index.js 只负责 IO（server 装配、
 * CORS、错误兜底、优雅关闭）。
 */

import { OpenAiHandler } from './openai-handler.js';
import { resolveDefaultModel } from './model-policy.js';
import { translateAnthropicRequest } from './anthropic-protocol.js';
import { resolveOpenAiThinking } from './openai-protocol.js';
import { anthropicError } from './anthropic-wire.js';
import { tokenStats } from './token-stats.js';
import { accountPool } from './account-pool.js';
import { getAccountSummary } from './account-info.js';

// 全局唯一 handler 实例（index.js 的优雅关闭也引用它）
export const handler = new OpenAiHandler();

// 账户查询入口（对象包装，便于单测替换实现）
export const accountProvider = { get: getAccountSummary };

/**
 * CORS 允许请求头。抽成常量是为了可单测——加漏一个头，浏览器侧客户端会在
 * 预检阶段被静默拦下（curl/SDK 不受影响，所以极容易漏测）。
 * Anthropic 客户端会发 x-api-key / anthropic-version，缺了预检就过不去。
 */
export const CORS_ALLOW_HEADERS = 'Content-Type, Authorization, x-api-key, anthropic-version';

/**
 * Extract client identity for session isolation.
 *
 * 优先级：Authorization: Bearer > x-api-key > ?apiKey= > 'default'。
 * x-api-key 是 Anthropic 客户端（anthropic SDK / workbuddy）的鉴权头——不读它
 * 会让所有这类客户端塌缩成同一个 'default' key，进而互相顶掉挂起的工具调用、
 * 抢同一账号、复用他人上下文（本项目历史上多次因串台吃亏）。
 */
export function clientKey(req) {
  const auth = req.headers['authorization'] || '';
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (m) return m[1].trim();
  const apiKeyHeader = req.headers['x-api-key'];
  if (typeof apiKeyHeader === 'string' && apiKeyHeader.trim()) return apiKeyHeader.trim();
  const url = new URL(req.url, `http://${req.headers.host}`);
  const q = url.searchParams.get('apiKey');
  return q || 'default';
}

function json(status, body) {
  return { status, body };
}

export { anthropicError };
// Anthropic 错误响应形状（SDK 按 {type:'error', error:{type,message}} 解析）——
// 定义已迁 anthropic-wire.js（架构深化第 8 批批B，帧/错误体词汇单点）。route()
// 内部也消费它，故 import 绑定本地后再导出（纯 `export from` 不建立本地绑定，
// route 内调用会 ReferenceError；import 本体在文件头 import 块）。

/**
 * Pure routing: method + path + body -> { status, body } 或流式标记对象。
 * Separated from the server so it can be unit-tested without HTTP.
 */
export async function route(method, path, body, ctx = {}) {
  // GET /v1/models
  if (path === '/v1/models' && method === 'GET') {
    return json(200, await handler.handleListModels(ctx.key));
  }

  // POST /v1/chat/completions
  if (path === '/v1/chat/completions' && method === 'POST') {
    if (!body.messages || !Array.isArray(body.messages)) {
      return json(400, {
        error: { message: 'messages is required and must be an array', type: 'invalid_request_error' }
      });
    }

    // thinkingEnabled 在 spread **之后**赋值：客户端可自带同名字段，若在 spread
    // 之前就会被它覆盖决策（Anthropic 侧同样的顺序约束）。
    const request = {
      ...body,
      thinkingEnabled: resolveOpenAiThinking(body),
      apiKey: ctx.key
    };

    if (body.stream) {
      // Streaming responses are written directly to the raw response object
      return { status: null, stream: true, request, res: ctx.res };
    }

    // Pass res so the handler can cancel the ACP task when the client
    // disconnects mid-request (prevents orphaned WorkBuddy tasks)
    const result = await handler.handleChatCompletions(request, ctx.res);
    // Streaming path already wrote the response (result is null)
    if (result === null || result === undefined) {
      return { status: null, stream: true, request, res: ctx.res, alreadyWritten: true };
    }
    return json(200, result);
  }

  // POST /v1/messages — Anthropic Messages API（非流式 + 流式）
  //
  // 请求在路由层翻译成与 OpenAI 同形的内部请求（顶层 system → system 消息、
  // tool_result/tool_use 块 → tool/assistant 消息），之后复用同一条编排路径；
  // 仅多带一个 protocol 标记用于选择 wire（sink / 响应构造）。
  if (path === '/v1/messages' && method === 'POST') {
    if (!body.messages || !Array.isArray(body.messages)) {
      return json(400, anthropicError('invalid_request_error', 'messages is required and must be an array'));
    }
    // 空数组也要拒：Anthropic 官方要求 messages 非空，且放行会产出一个零内容
    // prompt 打到后端——后端把空 prompt 当"继续上一轮"处理（一次冤枉计费），
    // 客户端拿到的还是 200。宁可 400 说清楚。
    if (body.messages.length === 0) {
      return json(400, anthropicError('invalid_request_error', 'messages must contain at least one message'));
    }

    const request = { ...translateAnthropicRequest(body), apiKey: ctx.key };

    if (request.stream) {
      return { status: null, stream: true, request, res: ctx.res };
    }

    const result = await handler.handleChatCompletions(request, ctx.res);
    if (result === null || result === undefined) {
      return { status: null, stream: true, request, res: ctx.res, alreadyWritten: true };
    }
    return json(200, result);
  }

  // POST /v1/messages/count_tokens — 上下文预算估算（客户端发请求前会调）
  if (path === '/v1/messages/count_tokens' && method === 'POST') {
    if (!body.messages || !Array.isArray(body.messages)) {
      return json(400, anthropicError('invalid_request_error', 'messages is required and must be an array'));
    }
    return json(200, await handler.handleAnthropicCountTokens(body));
  }

  // GET /v1/usage — token 消耗统计（总量 + 按模型/按 key 聚合）。
  // ?detail=1 追加逐请求明细；?model= / ?key= 过滤（model 同时匹配实际与请求模型）
  if (path === '/v1/usage' && method === 'GET') {
    const q = ctx.query || {};
    const filter = { model: q.model || undefined, key: q.key || undefined };
    const body = { object: 'token_usage', ...tokenStats.summary(filter) };
    if (q.detail === '1' || q.detail === 'true') {
      body.records = tokenStats.detail({ limit: Number(q.limit) || 100, ...filter });
    }
    return json(200, body);
  }

  // DELETE /v1/usage — 清空统计（内存明细与持久化文件一并重置）
  if (path === '/v1/usage' && method === 'DELETE') {
    tokenStats.reset();
    return json(200, { status: 'ok', message: 'token usage stats cleared' });
  }

  // GET /v1/account — 账户信息 + 积分余额（读取本地登录态 + 计费网关）
  if (path === '/v1/account' && method === 'GET') {
    const summary = await accountProvider.get();
    return json(200, { object: 'account', ...summary });
  }

  // GET /v1/accounts — 账号池状态（多账号轮转/冷却情况）
  if (path === '/v1/accounts' && method === 'GET') {
    const accounts = accountPool.status();
    return json(200, {
      object: 'account_pool',
      count: accounts.length,
      healthy: accounts.filter((a) => !a.coolingDown).length,
      accounts
    });
  }

  // GET / - Health check
  if (path === '/' && method === 'GET') {
    return json(200, {
      status: 'ok',
      service: 'buddy2api',
      version: '1.0.0',
      description: 'OpenAI-compatible API proxy for WorkBuddy',
      // 客户端不指定模型（或写 auto）时实际使用的模型；改 BUDDY2API_DEFAULT_MODEL 可换
      default_model: resolveDefaultModel(),
      endpoints: {
        '/v1/models': 'List available models',
        '/v1/chat/completions': 'Create chat completion',
        '/v1/messages': 'Create message (Anthropic Messages API)',
        '/v1/messages/count_tokens': 'Estimate input tokens (Anthropic Messages API)',
        '/v1/usage': 'Token usage stats (GET; ?detail=1 for per-request records, DELETE to reset)',
        '/v1/accounts': 'Account pool status (rotation & cooldown)',
        '/v1/account': 'Account info + credits balance'
      }
    });
  }

  return json(404, {
    error: { message: `Unknown endpoint: ${method} ${path}`, type: 'not_found' }
  });
}

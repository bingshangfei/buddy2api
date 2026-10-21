/**
 * buddy2api - OpenAI-compatible API proxy for WorkBuddy
 * Main entry point - HTTP server (IO only; routing lives in route())
 */

import http from 'node:http';
// 崩溃取证必须顶到 import 链第一位（crash-log.js 零依赖、顶层注册 handler，
// 先于其余模块求值——见该模块头注释）
import './crash-log.js';
import { killPortProcess } from '../scripts/kill.js';
import { route, handler, clientKey, CORS_ALLOW_HEADERS, anthropicError } from './router.js';
import { resolveDefaultModel } from './model-policy.js';
import { shutdownManagedProcess, warmup } from './gateway-discovery.js';
import { getAccountSummary, formatAccountSummary, authDir as AUTH_DIR } from './account-info.js';
import { accountPool } from './account-pool.js';
import { parseBody } from './body-parser.js';

const PORT = Number(process.env.PORT) || 8000;
const HOST = process.env.HOST || '127.0.0.1';

// 全局日志时间戳前缀：本服务长连接多、事件异步，无时间戳的日志无法定位「哪条请求
// 慢/挂了」（2026-09-16 排查长静默挂起时全靠 token-usage.jsonl 取证的教训）。
// ISO 时间戳统一 UTC，与 token-usage.jsonl 的 ts 字段同口径，可直接对表。
{
  const stamp = (args) => [new Date().toISOString(), ...args];
  const origLog = console.log.bind(console);
  const origWarn = console.warn.bind(console);
  const origError = console.error.bind(console);
  console.log = (...args) => origLog(...stamp(args));
  console.warn = (...args) => origWarn(...stamp(args));
  console.error = (...args) => origError(...stamp(args));
}

// parseBody 已出仓 body-parser.js（架构深化第 8 批 C6，Buffer 化 + 可单测）



/**
 * Extract client identity for session isolation:
 * prefer Authorization bearer token, fall back to ?apiKey=, then 'default'
 */
/**
 * Request router entry (used by the HTTP server)
 */
async function handleRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const path = url.pathname;
  const method = req.method;

  // CORS preflight
  if (method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': CORS_ALLOW_HEADERS,
      'Access-Control-Max-Age': '86400'
    });
    return res.end();
  }

  try {
    const body = (method === 'POST' || method === 'PUT')
      ? await parseBody(req)
      : {};

    const result = await route(method, path, body, {
      key: clientKey(req),
      res,
      // 查询参数（GET /v1/usage 的 detail/model/key/limit 过滤用）
      query: Object.fromEntries(url.searchParams)
    });

    // Streaming path already wrote the response
    if (result.stream || result.alreadyWritten) {
      if (!result.alreadyWritten) {
        await handler.handleChatCompletions(result.request, res);
      }
      return;
    }

    res.writeHead(result.status, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*'
    });
    res.end(JSON.stringify(result.body));
  } catch (error) {
    console.error('Request error:', error);
    // SSE 场景（工具续跑消费）响应头已发出、流已开始：此时 writeHead(500)
    // 会抛 ERR_HTTP_HEADERS_SENT，且这个二次抛出无人接住 → unhandled rejection
    // 直接打崩整个服务进程。只能尽力终止流。
    if (res.headersSent) {
      try { res.end(); } catch { /* client gone */ }
      return;
    }
    // 504 语义：首 token 假死等上游超时类错误与普通内部错误区分（statusCode 由抛出方标注）
    res.writeHead(error.statusCode || 500, { 'Content-Type': 'application/json' });
    // Anthropic 端点用 Anthropic 的错误形状：SDK 按 {type:'error',error:{type,message}}
    // 解析，喂它 OpenAI 形状会得到一个语焉不详的解析错误而不是真实原因。
    const isAnthropicEndpoint = path === '/v1/messages' || path === '/v1/messages/count_tokens';
    res.end(JSON.stringify(
      isAnthropicEndpoint
        ? anthropicError('api_error', error.message || 'Internal server error')
        : { error: { message: error.message || 'Internal server error', type: 'server_error' } }
    ));
  }
}

// Create and start server
const server = http.createServer(handleRequest);

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`❌ 端口 ${PORT} 已被占用（可能已有 buddy2api 实例在运行）。`);
    console.error(`   解决方案：`);
    console.error(`   1. 如果旧实例已不需要：运行 "node src/index.js --kill" 结束它`);
    console.error(`   2. 或使用其他端口启动：PORT=8001 node src/index.js`);
    process.exit(1);
  }
  console.error('服务器错误:', error);
  process.exit(1);
});

// --kill flag: terminate a previously running instance on this port
// （实现在 scripts/kill.js；保留 CLI 兼容）
if (process.argv.includes('--kill')) {
  killPortProcess(PORT);
  process.exit(0);
}

server.listen(PORT, HOST, () => {
  console.log(`🚀 buddy2api server running at http://${HOST}:${PORT}`);
  console.log(`   OpenAI-compatible API: http://${HOST}:${PORT}/v1`);
  console.log(`   Models: http://${HOST}:${PORT}/v1/models`);
  console.log(`   Chat: http://${HOST}:${PORT}/v1/chat/completions`);
  console.log(`   Anthropic Messages: http://${HOST}:${PORT}/v1/messages`);
  console.log('');
  console.log('Configure your client with:');
  console.log(`   Base URL: http://${HOST}:${PORT}/v1`);
  console.log(`   API Key: any (not required)`);
  console.log(`   Anthropic clients: pass any value as x-api-key（仅用于会话隔离，不校验）`);
  console.log(`   Default model: ${resolveDefaultModel()}  (客户端不指定 model 时使用；改 BUDDY2API_DEFAULT_MODEL)`);

  // 懒初始化：默认按登录账号数预创建（每账号 1 个绑定后端，单账号 2 个；名额交错
  // 覆盖"精简/全量"两种工具风味，多账号并发请求不冷启；无账号时退回 2 个默认登录态
  // 后端）。后台执行，不阻塞服务启动；POOL_WARM_COUNT 可覆盖为固定数量，0 禁用
  const warmCount = process.env.POOL_WARM_COUNT !== undefined
    ? Number(process.env.POOL_WARM_COUNT)
    : null;
  if (warmCount === null || warmCount > 0) {
    warmup(warmCount).catch(e => console.warn(`[buddy2api] Warmup failed: ${e.message}`));
  }
});

// 账户信息 + 余额（异步、失败静默：仅展示，不影响服务）
// 只打事实行；「未登录/模型调用会失败」的警示与登录引导统一由下方账号池块
// 基于真实探活结果输出（账号池才是实际凭据来源）。共享同一个查询结果，
// 避免启动期重复请求计费网关。
const accountSummaryPromise = getAccountSummary();
accountSummaryPromise
  .then((summary) => {
    console.log('');
    console.log('👤 账户 / 余额');
    for (const line of formatAccountSummary(summary).split('\n')) console.log(`   ${line}`);
    if (!summary.ok && summary.reason === 'encrypted') {
      console.log('   💡 登录态为加密格式（桌面端写入），当前版本暂不支持读取；账号池可用则不受影响。');
      console.log(`   凭据文件：${summary.authFile}`);
    }
  })
  .catch((e) => console.warn(`[account-info] 获取账户信息失败：${e.message}`));

// 账号池：探活 + 展示（异步，不阻塞启动）
// 失效账号会被置入冷却、不参与轮转——否则前几个请求会白白打到死账号上。
// 「模型调用会失败」的警示与登录引导在这里输出：这是唯一同时掌握「真实探活结果 +
// 实际凭据来源」的位置（账户块只是单文件登录态视图，可能因格式不可读而误报）。
const LOGIN_REASONS = new Set(['encrypted', 'missing', 'invalid', 'no-auth-file', 'expired']);

function printLoginGuidance() {
  console.log('   登录方法（无需安装 WorkBuddy 桌面端）：');
  console.log('     node scripts/login.js          # 检查状态；未登录时打印引导');
  console.log('     node scripts/login.js --open   # 直接拉起 CLI 登录界面（输入 /login）');
  console.log(`   凭据目录：${AUTH_DIR()}`);
}

(async () => {
  const all = accountPool.accounts({ force: true });
  const settleSummary = accountSummaryPromise.catch(() => ({ ok: false, reason: 'error' }));
  if (all.length === 0) {
    console.log('');
    console.log('👥 账号池：未配置（使用当前登录态的单一凭据）');
    console.log('   💡 配置多个账号可摊开配额：某账号频控(429)或额度用尽时自动切换，服务不中断。');
    console.log('      添加：node scripts/accounts.js add');
    const summary = await settleSummary;
    if (!summary.ok && LOGIN_REASONS.has(summary.reason)) {
      console.log('');
      console.log('⚠️  当前登录态不可用 —— 模型调用会失败。');
      printLoginGuidance();
    }
    return;
  }

  console.log('');
  console.log(`👥 账号池（${all.length} 个账号，轮流使用）`);
  const { healthy, unhealthy } = await accountPool.validateAll();
  for (const h of healthy) {
    console.log(`   ✅ ${h.account.nickname || h.account.id} — 余额 ${h.balance.remaining}/${h.balance.total} ${h.balance.unit}`);
  }
  for (const u of unhealthy) {
    console.log(`   ❌ ${u.account.nickname || u.account.id} — ${u.reason}（已冷却）`);
  }
  if (healthy.length === 0) {
    console.log('   ⚠️  没有可用账号，请求会失败。用 `node scripts/accounts.js` 管理账号。');
    const summary = await settleSummary;
    if (!summary.ok && LOGIN_REASONS.has(summary.reason)) printLoginGuidance();
  } else if (all.length === 1) {
    // 单账号时提示多账号收益——用户往往不知道这个能力存在
    console.log('   💡 再加一个账号即可摊开配额：某账号频控(429)或额度用尽时自动切换，服务不中断。');
    console.log('      添加：node scripts/accounts.js add');
  }
})().catch((e) => {
  console.warn(`[account-pool] 账号探活失败：${e.message}`);
  console.warn('   若服务无法出模型，可运行 node scripts/login.js 检查登录态。');
});

// Graceful shutdown
async function shutdown() {
  console.log('\nShutting down...');
  await handler.sessions.close();
  shutdownManagedProcess();
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

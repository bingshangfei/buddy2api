/**
 * backend-process.js — 后端子进程机制（spawn / 环境卫生 / stdout 端点解析 / 探活）。
 *
 * 从 gateway-discovery.js 的 BackendPool 迁出（第三批批7，审视 F8 缩形）：
 * 池策略（acquire/排队/亲和）、持久化、空闲回收**留在 BackendPool**；本模块只
 * 拥有「怎么拉起一个后端进程、怎么知道它活了」——此前 buildChildEnv /
 * parseEndpointFromStdout 是模块私有零直测，spawn 细节与池策略混装在一个
 * 600 行类里。**三个池契约测试的实例桩（pool.spawnNew = ...）不受影响**：
 * spawnNew 仍是 BackendPool 公共方法。
 *
 * Windows 耦合面（审视 F12，随迁红线）：windowsHide（CREATE_NO_WINDOW，防
 * conhost 黑框）/ cwd:os.tmpdir() / stdio 三管（Endpoint 解析依赖 stdout 管道）/
 * `spawn(process.execPath, [binary, ...])` 双段（规避 .cmd shim）/ STRIP_ENV_KEYS
 * 与 readAccessToken 保持**调用期**读取——逐字保留，勿"顺手"提前或改写。
 */

import fs from 'node:fs';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { AcpClient } from './acp-client.js';
import { readAccessToken, isUsableToken } from './auth-credentials.js';

// codebuddy 启动超时（ms）
const STARTUP_TIMEOUT_MS = 30_000;

/**
 * 不得继承给子进程的环境变量（会话身份 / 追踪 / 服务代理）。
 */
const STRIP_ENV_KEYS = new Set([
  'CLAUDE_SESSION_ID',
  'CODEBUDDY_CONVERSATION_MESSAGE_ID',
  'CODEBUDDY_OWNER_KEY',
  'CODEBUDDY_PROJECT_DIR',
  'CODEBUDDY_SESSION_ID',
  'CODEBUDDY_SESSION_KIND',
  'CODEBUDDY_SESSION_LOG',
  'CODEBUDDY_SESSION_NAME',
  'CODEBUDDY_TEAMMATE_OWNER_KEY',
  'CLAUDE_PROJECT_DIR',
  'CODEBUDDY_CONVERSATION_REQUEST_ID',
  'CODEBUDDY_SERVICE_PROXY_URL',
  'CODEBUDDY_TASK_LIST_ID',
  'BAGGAGE',
  'TRACEPARENT',
  'TRACESTATE'
]);

/**
 * 构造后端子进程环境：剥会话身份键 + 关自动更新等 + 注入登录凭据。
 *
 * @param {object|null} account 账号池选中的账号（null = 用单账号凭据）
 * @param {Record<string,string|undefined>} [env=process.env] 调用期读取（缺省参数
 *        在调用时求值——勿提前到模块加载期，F12）
 * @param {Console} [log]
 * @returns {Record<string,string>} 子进程 env
 */
export function buildChildEnv(account = null, env = process.env, log = console) {
  const parentEnv = { ...env };
  for (const k of STRIP_ENV_KEYS) delete parentEnv[k];

  const childEnv = {
    ...parentEnv,
    DISABLE_AUTOUPDATER: '1',
    CODEBUDDY_DISABLE_CRON: '1',
    CODEBUDDY_DISABLE_AUTO_MEMORY: '1',
    CODEBUDDY_DISABLE_SYSTEM_REMINDER_MD: '1',
    CODEBUDDY_DISABLE_EXTENDED_PLUGIN_HOOKS: '1',
    CODEBUDDY_DISABLE_SESSION_HISTORY_CLEANUP: '1',
  };

  // 显式注入登录凭据。
  //
  // CLI 自己那份登录态（~/.codebuddy）会独立失效：实测出现过 CLI 报
  // "Authentication required"、但同一账号的 accessToken 仍然有效（余额接口
  // 正常返回）的情况。把凭据直接交给后端子进程，登录状态就只依赖这一个来源，
  // 不再受 CLI 自身存储状态影响。
  //
  // 多账号时由账号池指定 account（每个后端绑定一个账号）；
  // 未配置账号池时回退到当前登录态。
  //
  // 调用方已显式设了 CODEBUDDY_AUTH_TOKEN 时不覆盖（便于手工排查）。
  if (!childEnv.CODEBUDDY_AUTH_TOKEN) {
    // 注入守卫：只有非空字符串 token 才能进 env（加密对象等非 string 值会被
    // String() 强转成 [object Object] 或按 Node 版本抛 ERR_INVALID_ARG_TYPE）。
    if (isUsableToken(account?.accessToken)) {
      childEnv.CODEBUDDY_AUTH_TOKEN = account.accessToken;
      const who = typeof account.nickname === 'string' && account.nickname ? account.nickname : account.id;
      log.log(`[gateway-pool] Injected token for account ${who}`);
    } else {
      const cred = readAccessToken();
      if (cred) {
        childEnv.CODEBUDDY_AUTH_TOKEN = cred.token;
        log.log('[gateway-pool] Injected CODEBUDDY_AUTH_TOKEN from auth store');
      } else {
        log.warn('[gateway-pool] No valid access token found — backend may report "Authentication required". Run `node scripts/login.js` for guidance.');
      }
    }
  }

  return childEnv;
}

/**
 * 从后端 stdout 解析监听端点（ANSI 转义清洗后匹配 `Endpoint http://127.0.0.1:<port>`）。
 * stdout 关闭仍未见端点 → reject（启动失败路径）。
 *
 * @param {NodeJS.ReadableStream} stdout
 * @returns {Promise<string>} 端点 URL
 */
export function parseEndpointFromStdout(stdout) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const onData = (chunk) => {
      buffer += chunk.toString();
      const clean = buffer.replace(/\x1b\[[0-9;]*m/g, '');
      const match = clean.match(/Endpoint\s+(https?:\/\/127\.0\.0\.1:\d+)/);
      if (match) {
        stdout.removeListener('data', onData);
        resolve(match[1]);
      }
    };
    stdout.on('data', onData);
    stdout.on('close', () => {
      if (!buffer.includes('Endpoint')) {
        reject(new Error('stdout closed before endpoint was found'));
      }
    });
  });
}

/**
 * 拉起一个 codebuddy --serve 后端进程并等到端点就绪（机制单点；池注册/持久化/
 * 健康等待归调用方 BackendPool——保持原次序：endpoint 竞速 → removeAllListeners
 * → 调用方 waitForHealthy → 调用方注册监控 exit）。
 *
 * @param {object} opts
 * @param {string} opts.binary codebuddy CLI 路径（调用方先 findCodebuddyBinary）
 * @param {object|null} [opts.account] 绑定账号（凭据注入；日志标记）
 * @param {boolean} [opts.toolsEnabled=true] false 时加 `--tools ""`
 * @param {string} opts.stateDir 状态目录（mkdir -p 归属机制——原 spawnNew 首行）
 * @param {Console} [opts.log]
 * @returns {Promise<{url:string, child:import('node:child_process').ChildProcess, pid:number}>}
 */
export async function spawnBackendProcess({ binary, account = null, toolsEnabled = true, stateDir, log = console }) {
  fs.mkdirSync(stateDir, { recursive: true });

  const args = [
    '--serve',
    '--auth', 'none',
    '--port', '0',
    '--host', '127.0.0.1',
    '--permission-mode', 'bypassPermissions',
    '--model', 'auto',
    '--no-session-persistence',
  ];
  if (!toolsEnabled) args.push('--tools', '');

  const nodeBin = process.execPath;
  const child = spawn(nodeBin, [binary, ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd: os.tmpdir(),
    env: buildChildEnv(account),
    // Windows：不弹出控制台窗口。node.exe 是 console subsystem，父进程
    // （buddy2api 以 detached 启动，自身没有控制台）无可继承的控制台时，
    // 系统会为每个后端新建一个 conhost 窗口——表现就是"每来一个请求弹出
    // 一个黑框"。windowsHide 走 CREATE_NO_WINDOW，只隐藏窗口，不影响
    // stdout/stderr 管道（Endpoint 解析与启动超时都依赖它们）。
    windowsHide: true
  });

  const spawnErrorPromise = new Promise((_, reject) => {
    child.on('error', (err) => {
      reject(new Error(`Failed to spawn codebuddy: ${err.message}`));
    });
  });

  let stderrBuf = '';
  child.stderr.on('data', (chunk) => {
    stderrBuf += chunk.toString();
    if (stderrBuf.length > 10_000) stderrBuf = stderrBuf.slice(-5_000);
  });

  const endpointPromise = parseEndpointFromStdout(child.stdout);

  let startupTimer;
  const timeoutPromise = new Promise((_, reject) => {
    startupTimer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`codebuddy startup timed out after ${STARTUP_TIMEOUT_MS}ms. stderr: ${stderrBuf.slice(-500)}`));
    }, STARTUP_TIMEOUT_MS);
  });

  const exitPromise = new Promise((_, reject) => {
    child.on('exit', (code, signal) => {
      reject(new Error(`codebuddy exited prematurely (code=${code}, signal=${signal}). stderr: ${stderrBuf.slice(-500)}`));
    });
  });

  let url;
  try {
    url = await Promise.race([endpointPromise, timeoutPromise, exitPromise, spawnErrorPromise]);
  } catch (e) {
    clearTimeout(startupTimer);
    throw e;
  }
  clearTimeout(startupTimer);
  child.removeAllListeners('exit');

  return { url, child, pid: child.pid };
}

/**
 * 健康探活：对后端 URL 发起一次 ACP connect（成功即销毁探测连接）。
 *
 * @param {string} url
 * @returns {Promise<boolean>}
 */
export async function probeHealth(url) {
  try {
    const client = new AcpClient(url);
    await client.connect();
    client.destroy?.();
    return true;
  } catch {
    return false;
  }
}

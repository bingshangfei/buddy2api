#!/usr/bin/env node
/**
 * service.js — 服务的启动/停止（供控制台调用；也可单独用）。
 *
 * 用法：
 *   node scripts/service.js start    后台启动服务
 *   node scripts/service.js stop     停止服务（含托管的 codebuddy 后端）
 *   node scripts/service.js restart  重启
 *
 * 服务已在运行时 start 不重复启动（幂等）。
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { killPortProcess } from './kill.js';

const projectRoot = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const PORT = Number(process.env.PORT) || 8000;
const LOG = path.join(process.env.TEMP || '/tmp', 'buddy2api.log');

/** 探测服务是否在运行 */
function isRunning(timeoutMs = 1500) {
  return new Promise((resolve) => {
    const req = http.get({ hostname: '127.0.0.1', port: PORT, path: '/', timeout: timeoutMs }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

/** 等待服务就绪（最多 timeoutMs） */
async function waitReady(timeoutMs = 30_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await isRunning()) return true;
    await new Promise((r) => setTimeout(r, 800));
  }
  return false;
}

async function start() {
  if (await isRunning()) {
    console.log(`  [已在运行] http://127.0.0.1:${PORT}/v1`);
    return 0;
  }

  const out = fs.openSync(LOG, 'a');
  const child = spawn(process.execPath, [path.join(projectRoot, 'src', 'index.js')], {
    cwd: projectRoot,
    detached: true,
    stdio: ['ignore', out, out],
    // Windows：不弹控制台窗口（CREATE_NO_WINDOW）。从 PowerShell/资源管理器
    // 启动时，detached 的 node.exe 会另开一个 conhost 窗口；启动器（start.vbs）
    // 本就隐藏运行，这里保持一致。日志仍写入 LOG，不因隐藏窗口而丢失。
    windowsHide: true
  });
  child.unref();

  console.log('  正在启动…（首次请求需数秒拉起后端）');
  const ok = await waitReady();
  if (ok) {
    console.log(`  [已启动] http://127.0.0.1:${PORT}/v1`);
    console.log(`  日志：${LOG}`);
    return 0;
  }
  console.error(`  [启动失败] 请查看日志：${LOG}`);
  return 1;
}

async function stop() {
  if (!(await isRunning())) {
    // 服务未在运行，尝试清理可能残留的监听进程
    const killed = killPortProcess(PORT);
    console.log(killed ? '  [已清理残留进程]' : '  [未运行]');
    return 0;
  }
  const killed = killPortProcess(PORT);
  console.log(killed ? '  [已停止]' : '  [停止失败] 未找到监听进程');
  return killed ? 0 : 1;
}

const cmd = process.argv[2] || 'status';

if (cmd === 'start') {
  process.exit(await start());
} else if (cmd === 'stop') {
  process.exit(await stop());
} else if (cmd === 'restart') {
  await stop();
  await new Promise((r) => setTimeout(r, 1500));
  process.exit(await start());
} else if (cmd === 'status') {
  const running = await isRunning();
  console.log(running ? '  运行中' : '  未运行');
  process.exit(running ? 0 : 1);
} else {
  console.error('用法：node scripts/service.js [start|stop|restart|status]');
  process.exit(1);
}

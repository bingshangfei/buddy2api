/**
 * kill.js — 结束占用指定端口的进程（从 index.js 外移）。
 *
 * 用法：
 *   node src/index.js --kill   （保留 CLI 兼容，index.js 内部委托到此处）
 *   npm run kill               （直接调用）
 *
 * 跨平台：win32 走 netstat/taskkill，darwin/linux 走 lsof/kill。
 * 依赖（runner/platform/sleep）可注入，测试见 tests/kill-crossplatform.test.js。
 */

import { execSync } from 'node:child_process';

const defaultRun = (cmd) => execSync(cmd, { encoding: 'utf8' });
const defaultSleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * 结束占用 127.0.0.1:port 的 LISTENING 进程。
 * @param {number} port
 * @param {{run?: (cmd: string) => string, platform?: string, sleep?: (ms: number) => void}} [deps] 测试注入
 * @returns {boolean} 是否有进程被结束
 */
export function killPortProcess(port, deps = {}) {
  const run = deps.run || defaultRun;
  const platform = deps.platform || process.platform;
  const sleep = deps.sleep || defaultSleep;
  try {
    if (platform === 'win32') {
      const pid = run(
        `netstat -ano | findstr "LISTENING" | findstr "127.0.0.1:${port}"`
      ).split(/\s+/).filter(Boolean).pop();
      if (pid && pid !== 'LISTENING' && /^\d+$/.test(pid)) {
        // /T 必须带上：codebuddy 后端是服务进程的子进程，Windows 下父进程被
        // 强杀后子进程会存活成孤儿（各占一份账号会话与内存）——不带 /T 每次
        // stop 泄漏最多 MAX_BACKENDS 个 node 进程。SIGINT 正常路径有
        // shutdownManagedProcess 清理，这里兜底的是强杀场景。
        run(`taskkill /T /F /PID ${pid}`);
        console.log(`✅ 已结束占用端口 ${port} 的进程树 (PID ${pid})`);
        return true;
      }
      console.log(`端口 ${port} 当前无进程占用`);
      return false;
    }

    // darwin / linux：-sTCP:LISTEN 只取监听者（不加会匹配已建立的客户端
    // 连接，误杀无关进程）；先 pkill -P 收割直接子进程（对齐 win32 /T 语义，
    // 防孤儿化 codebuddy 后端），再杀父进程；宽限后仍监听则 -9 升级；
    // 最终复查仍监听 → 返回 false（service.js stop 依赖此值判断成败）。
    const pids = run(`lsof -ti tcp:${port} -sTCP:LISTEN`).split(/\s+/).filter(Boolean);
    if (!pids.length) {
      console.log(`端口 ${port} 当前无进程占用`);
      return false;
    }
    for (const pid of pids) {
      try { run(`pkill -TERM -P ${pid}`); } catch { /* 无子进程 */ }
      try { run(`kill ${pid}`); } catch { /* 已退出 */ }
    }
    try { sleep(3000); } catch { /* 主线程不可阻塞时立即进入复查 */ }
    let survivors = [];
    try {
      survivors = run(`lsof -ti tcp:${port} -sTCP:LISTEN`).split(/\s+/).filter(Boolean);
    } catch { /* 已无监听 */ }
    for (const pid of survivors) {
      try { run(`kill -9 ${pid}`); } catch { /* 已退出 */ }
    }
    let remaining = [];
    try {
      remaining = run(`lsof -ti tcp:${port} -sTCP:LISTEN`).split(/\s+/).filter(Boolean);
    } catch { /* 已无监听 */ }
    if (remaining.length) {
      console.log(`❌ 端口 ${port} 的进程未能结束 (${remaining.join(', ')})`);
      return false;
    }
    console.log(`✅ 已结束占用端口 ${port} 的进程 (${pids.join(', ')})`);
    return true;
  } catch (e) {
    // findstr/lsof 无匹配时非零退出 → 无进程占用
    console.log(`端口 ${port} 当前无进程占用`);
    return false;
  }
}

// 直接执行（npm run kill / node scripts/kill.js）
const isMain = process.argv[1] && process.argv[1].endsWith('kill.js');
if (isMain) {
  const port = Number(process.env.PORT) || 8000;
  killPortProcess(port);
}

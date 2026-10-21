// crash-log.js — 崩溃取证落盘（release-20261021-v1116）。零依赖叶，**纯副作用
// 模块**：handler 在模块顶层注册，index.js 把它放在 import 链第一位——ESM 按声明
// 顺序求值，本模块先于其余模块求值，「模块求值期崩溃」才有取证（CR 怀疑者轴：
// 注册放 index.js 主体会留启动期空窗）。
// 边界（诚实声明）：外部强杀（taskkill / RestartManager 关控制台）不触发任何
// handler——那类死亡由「buddy2api 看门狗」计划任务兜底拉起，取证需进程终止审计。
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const crashLog = join(tmpdir(), 'buddy2api-crash.log');
// 同步 appendFile：绕开 stdout 重定向管道的缓冲——进程死亡瞬间异步写会丢
const logCrash = (kind, detail) => {
  try {
    appendFileSync(crashLog, `[${new Date().toISOString()}] pid=${process.pid} ${kind}\n${detail}\n`, 'utf8');
  } catch { /* 取证失败不得阻塞退出路径 */ }
};

process.on('uncaughtException', (err) => {
  logCrash('uncaughtException', err?.stack || String(err));
  console.error('uncaughtException:', err);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  // 挂了 handler 即接管 Node 默认 crash 行为（--unhandled-rejections=throw 等价）——
  // 记录后按同口径退出，不留半死状态
  logCrash('unhandledRejection', reason?.stack || String(reason));
  console.error('unhandledRejection:', reason);
  process.exit(1);
});

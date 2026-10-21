/**
 * kill-crossplatform.test.js — killPortProcess 平台分支测试。
 *
 * win32 分支用命令快照锁定存量行为（此前零覆盖）；
 * darwin/linux 分支断言命令构造（lsof -sTCP:LISTEN → pkill 子进程 → kill → 升级 -9）。
 * 平台与命令执行器均可注入，测试不依赖真实平台与真实进程。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { killPortProcess } from '../scripts/kill.js';

/**
 * 构造可编程的 fake runner：
 * script: Map<命令前缀, 返回值|Error|Array>；数组按调用次序出队，耗尽即抛错
 * （用于区分 lsof 首查/复查/终查，且暴露实现的多余轮询）；标量则恒定返回；
 * 未命中前缀的命令默认抛错（execSync 失败语义）。
 */
function fakeRun(script = {}) {
  const calls = [];
  const queues = new Map();
  const run = (cmd) => {
    calls.push(cmd);
    for (const [prefix, result] of Object.entries(script)) {
      if (cmd.startsWith(prefix)) {
        if (result instanceof Error) throw result;
        if (Array.isArray(result)) {
          if (!queues.has(prefix)) queues.set(prefix, [...result]);
          const q = queues.get(prefix);
          if (!q.length) throw new Error(`fake queue exhausted: ${cmd}`);
          return q.shift();
        }
        return result;
      }
    }
    throw new Error(`unexpected command: ${cmd}`);
  };
  run.calls = calls;
  return run;
}

const noopSleep = () => {};

test('win32: 有监听进程时 netstat→taskkill /T /F 快照', () => {
  const run = fakeRun({
    'netstat -ano': '  TCP    127.0.0.1:8000    0.0.0.0:0    LISTENING    4242\n',
    'taskkill': '',
  });
  const ok = killPortProcess(8000, { run, platform: 'win32', sleep: noopSleep });
  assert.equal(ok, true);
  assert.deepEqual(run.calls, [
    'netstat -ano | findstr "LISTENING" | findstr "127.0.0.1:8000"',
    'taskkill /T /F /PID 4242',
  ]);
});

test('win32: 无监听进程时返回 false 且不 taskkill', () => {
  const run = fakeRun({ 'netstat -ano': new Error('no match') });
  const ok = killPortProcess(8000, { run, platform: 'win32', sleep: noopSleep });
  assert.equal(ok, false);
  assert.deepEqual(run.calls, ['netstat -ano | findstr "LISTENING" | findstr "127.0.0.1:8000"']);
});

test('darwin: lsof -sTCP:LISTEN → 先收子进程再杀父进程', () => {
  const run = fakeRun({
    'lsof -ti tcp:8000': ['4242\n8484\n', '', ''],
  });
  const ok = killPortProcess(8000, { run, platform: 'darwin', sleep: noopSleep });
  assert.equal(ok, true);
  assert.deepEqual(run.calls, [
    'lsof -ti tcp:8000 -sTCP:LISTEN',
    'pkill -TERM -P 4242',
    'kill 4242',
    'pkill -TERM -P 8484',
    'kill 8484',
    'lsof -ti tcp:8000 -sTCP:LISTEN',
    'lsof -ti tcp:8000 -sTCP:LISTEN',
  ]);
});

test('darwin: 宽限期后仍监听 → 升级 kill -9，终查通过', () => {
  const run = fakeRun({
    'lsof -ti tcp:8000': ['4242\n', '4242\n', ''],
    'kill -9': '',
  });
  const slept = [];
  const ok = killPortProcess(8000, {
    run,
    platform: 'darwin',
    sleep: (ms) => slept.push(ms),
  });
  assert.equal(ok, true);
  assert.deepEqual(slept, [3000]);
  assert.deepEqual(run.calls, [
    'lsof -ti tcp:8000 -sTCP:LISTEN',
    'pkill -TERM -P 4242',
    'kill 4242',
    'lsof -ti tcp:8000 -sTCP:LISTEN',
    'kill -9 4242',
    'lsof -ti tcp:8000 -sTCP:LISTEN',
  ]);
});

test('darwin: kill 与 -9 均未生效 → 返回 false（service.js stop 依赖此语义）', () => {
  const run = fakeRun({
    'lsof -ti tcp:8000': ['4242\n', '4242\n', '4242\n'],
    'kill -9': '',
  });
  const ok = killPortProcess(8000, { run, platform: 'darwin', sleep: noopSleep });
  assert.equal(ok, false);
  assert.equal(run.calls[run.calls.length - 1], 'lsof -ti tcp:8000 -sTCP:LISTEN');
});

test('darwin: 端口无监听（lsof 失败）→ 返回 false 且零杀命令', () => {
  const run = fakeRun({ 'lsof -ti tcp:8000': new Error('exit 1') });
  const ok = killPortProcess(8000, { run, platform: 'darwin', sleep: noopSleep });
  assert.equal(ok, false);
  assert.deepEqual(run.calls, ['lsof -ti tcp:8000 -sTCP:LISTEN']);
});

test('linux: 与 darwin 同构', () => {
  const run = fakeRun({
    'lsof -ti tcp:8000': ['900\n', '', ''],
  });
  const ok = killPortProcess(8000, { run, platform: 'linux', sleep: noopSleep });
  assert.equal(ok, true);
  assert.deepEqual(run.calls, [
    'lsof -ti tcp:8000 -sTCP:LISTEN',
    'pkill -TERM -P 900',
    'kill 900',
    'lsof -ti tcp:8000 -sTCP:LISTEN',
    'lsof -ti tcp:8000 -sTCP:LISTEN',
  ]);
});

/**
 * gateway-discovery 拆分边界契约（批9 #6）。
 *
 * 固化拆分后仍然成立的两点：
 *   1. **兼容再导出**：既有 import 面（gw.resolvePoolConfig / MAX_BACKENDS /
 *      QUEUE_TIMEOUT_MS / POOL_FILE）与配置模块是**同一绑定**（不是副本漂移）。
 *   2. **实例绑定委托**：BackendPool.saveState/restoreState/isProcessAlive 仍是
 *      实例方法且经 gateway-pool-state 的实例绑定函数落盘/恢复/探活——测试可就地
 *      覆写（每实例 STATE_DIR 隔离语义由 gateway-pool-config/lifecycle 锁定）。
 *
 * ⚠ 隔离前提（同 gateway-pool-config.test.js）：把 os.tmpdir() 指向临时目录——
 * gateway-discovery 在**加载时** restoreState() 探活真实池文件
 * （%TEMP%/buddy2api/backends.json），不隔离会读/写用户真实池。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ISOLATED_TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'buddy2api-split-root-'));
process.env.TEMP = ISOLATED_TMP;
process.env.TMP = ISOLATED_TMP;
process.env.TMPDIR = ISOLATED_TMP;

const gw = await import('../src/gateway-discovery.js');
const cfg = await import('../src/gateway-pool-config.js');
const st = await import('../src/gateway-pool-state.js');

test('#6 gw 的配置再导出与 gateway-pool-config 是同一绑定', () => {
  assert.equal(gw.resolvePoolConfig, cfg.resolvePoolConfig, 'resolvePoolConfig 必须是同一函数');
  assert.equal(gw.MAX_BACKENDS, cfg.MAX_BACKENDS);
  assert.equal(gw.QUEUE_TIMEOUT_MS, cfg.QUEUE_TIMEOUT_MS);
  assert.equal(gw.POOL_FILE, cfg.POOL_FILE);
});

test('#6 gateway-pool-state 导出实例绑定函数', () => {
  assert.equal(typeof st.savePoolState, 'function');
  assert.equal(typeof st.restorePoolState, 'function');
  assert.equal(typeof st.isProcessAlive, 'function');
});

test('#6 isProcessAlive：当前进程存活为 true，不存在 pid 为 false', () => {
  assert.equal(st.isProcessAlive(process.pid), true);
  assert.equal(st.isProcessAlive(0x7fffffff), false);
});

test('#6 BackendPool.saveState 委托 gateway-pool-state（实例 poolFile 生效）', () => {
  const dir = fs.mkdtempSync(path.join(ISOLATED_TMP, 'split-'));
  const pool = new gw.BackendPool({ stateDir: dir });
  if (pool.cleanupTimer) { clearInterval(pool.cleanupTimer); pool.cleanupTimer = null; }
  try {
    pool.backends = new Map([['http://127.0.0.1:9901', {
      url: 'http://127.0.0.1:9901', pid: 9901, child: null, status: 'idle',
      toolsEnabled: true, accountId: null, startedAt: Date.now(), lastUsedAt: Date.now()
    }]]);
    pool.saveState();
    const file = path.join(dir, 'backends.json');
    assert.ok(fs.existsSync(file), 'saveState 应经 state 模块写到实例 STATE_DIR');
    assert.deepEqual(
      Object.keys(JSON.parse(fs.readFileSync(file, 'utf8'))[0]).sort(),
      ['accountId', 'pid', 'startedAt', 'toolsEnabled', 'url'],
      '落盘 schema 不变（成员清单快照）'
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('#6 BackendPool.isProcessAlive 可被就地覆写（restoreState 走覆写版）', async () => {
  const dir = fs.mkdtempSync(path.join(ISOLATED_TMP, 'split2-'));
  const pool = new gw.BackendPool({ stateDir: dir });
  if (pool.cleanupTimer) { clearInterval(pool.cleanupTimer); pool.cleanupTimer = null; }
  try {
    fs.writeFileSync(path.join(dir, 'backends.json'), JSON.stringify([
      { url: 'http://127.0.0.1:9902', pid: 9902, accountId: null, toolsEnabled: true, startedAt: Date.now() }
    ]));
    pool.backends = new Map();
    pool.isProcessAlive = async () => true;   // 就地覆写
    pool.isHealthy = async () => true;
    await pool.restoreState();
    assert.equal(pool.backends.size, 1, '覆写 isProcessAlive 后应恢复该成员');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

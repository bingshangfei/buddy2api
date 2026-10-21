/**
 * gateway-pool-state.js — 后端池状态持久化（批9 #6，从 gateway-discovery 拆出）。
 *
 * 成员清单快照的原子落盘 / 启动恢复 / 进程探活。**实例绑定**：操作对象是 pool
 * 实例（读 `pool.poolFile` / `pool.backends`，经 `pool._toolsFlavor` /
 * `pool.isProcessAlive` / `pool.isHealthy` / `pool.saveState` 动态派发）——因此
 * BackendPool 的方法仍可被测试就地覆写，每实例 STATE_DIR 的隔离语义不变。
 */

import fs from 'node:fs';
import path from 'node:path';

/**
 * 保存进程池状态到文件（原子写：临时文件 + rename）。
 * 直接覆盖写在中途崩溃会留下截断的 JSON，而 restoreState 对解析失败整体弃权 →
 * 所有后端变孤儿 → 下次全量冷启动。保持同步（不引入未落盘窗口）。
 * @param {object} pool BackendPool 实例
 */
export function savePoolState(pool) {
  const file = pool.poolFile;
  try {
    // schema = restoreState 的实际读取集（url/pid/accountId/toolsEnabled/startedAt）：
    // 成员清单快照。status/lastUsedAt 是恢复时写死/重置的瞬态，不进文件。
    const state = Array.from(pool.backends.entries()).map(([url, info]) => ({
      url,
      pid: info.pid,
      accountId: info.accountId || null,
      toolsEnabled: pool._toolsFlavor(info),
      startedAt: info.startedAt
    }));
    const tmp = `${file}.tmp-${process.pid}`;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, file);
  } catch (e) {
    console.warn(`[gateway-pool] Failed to save state: ${e.message}`);
  }
}

/**
 * 从文件恢复进程池状态（检查进程是否还活着）。
 * @param {object} pool BackendPool 实例
 */
export async function restorePoolState(pool) {
  const file = pool.poolFile;
  try {
    if (!fs.existsSync(file)) return;
    const state = JSON.parse(fs.readFileSync(file, 'utf8'));
    // 并行探活（进程存活 + 健康检查各是一次网络往返，串行最坏 5×30s，
    // 全部发生在首个请求能被服务之前）。
    const restored = await Promise.all(state.map(async (entry) => {
      if (await pool.isProcessAlive(entry.pid) && await pool.isHealthy(entry.url)) {
        return {
          url: entry.url,
          pid: entry.pid,
          accountId: entry.accountId || null,
          toolsEnabled: entry.toolsEnabled !== false,
          child: null, // 无法恢复 child 对象
          status: 'idle',
          startedAt: entry.startedAt,
          lastUsedAt: Date.now()
        };
      }
      return null;
    }));
    for (const info of restored) {
      if (!info) continue;
      pool.backends.set(info.url, info);
      console.log(`[gateway-pool] Restored backend: ${info.url} (PID ${info.pid})`);
    }
    pool.saveState();
  } catch (e) {
    console.warn(`[gateway-pool] Failed to restore state: ${e.message}`);
  }
}

/**
 * 检查进程是否存活。
 * @param {number} pid
 * @returns {boolean}
 */
export function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * gateway-pool-config.js — 后端池 env 配置解析（批9 #6，从 gateway-discovery 拆出）。
 *
 * 纯配置面：容量 / 队列超时 / 状态目录 / 空闲回收的 env 派生 + 钳制规则，模块
 * 加载时读一次（部署期生效，运行中改 env 不热更——历史契约）。与池运行时
 * （BackendPool / 持久化 / warmup）解耦：discovery 不再承载配置知识，本模块可独立直测。
 */

import path from 'node:path';
import os from 'node:os';

const DEFAULT_MAX_BACKENDS = 5;
const MAX_BACKENDS_CEILING = 16;
const DEFAULT_QUEUE_TIMEOUT_MS = 120_000;
const QUEUE_TIMEOUT_FLOOR_MS = 1_000;
const QUEUE_TIMEOUT_CEILING_MS = 600_000;

/**
 * 解析池配置（纯函数，便于单测）。默认值与历史硬编码逐字一致，只有显式设了
 * env 才生效——部署行为零变化。
 *
 * 两个下界的处置不同，理由不同：
 * - 容量低于 1（`0` / `-1`）在语义上不成立（池不能没有后端），且会让 `acquire`
 *   的容量判定恒为 false → 请求永久排队。故**回落默认**而不是钳到 1。
 * - 队列超时低于 1s 仍然"可用"，只是退化成超时后立刻重排的忙轮询，故**钳到下界**。
 *
 * 上限一律钳制：每个后端是一个完整的 `codebuddy --serve` node 进程，容量配成
 * 三位数会在 warmup 阶段拉起同等数量的进程（启动风暴 / 内存耗尽）。
 *
 * @param {Record<string,string|undefined>} [env=process.env]
 * @returns {{maxBackends:number, queueTimeoutMs:number, stateDir:string, idleTimeoutMs:number, poolFile:string}}
 */
export function resolvePoolConfig(env = process.env) {
  const maxBackends = parseBoundedInt(env.BUDDY2API_MAX_BACKENDS, {
    name: 'BUDDY2API_MAX_BACKENDS',
    def: DEFAULT_MAX_BACKENDS,
    min: 1,
    max: MAX_BACKENDS_CEILING,
    belowMin: 'default'
  });
  const queueTimeoutMs = parseBoundedInt(env.BUDDY2API_QUEUE_TIMEOUT_MS, {
    name: 'BUDDY2API_QUEUE_TIMEOUT_MS',
    def: DEFAULT_QUEUE_TIMEOUT_MS,
    min: QUEUE_TIMEOUT_FLOOR_MS,
    max: QUEUE_TIMEOUT_CEILING_MS,
    belowMin: 'clamp'
  });
  // 状态目录可配：多个实例（生产 + 测量 + 测试）共用一份 backends.json 会互相
  // "收养"对方 spawn 的后端进程（restoreState 只看进程存活 + 端口健康）。
  const stateDir = env.BUDDY2API_STATE_DIR || path.join(os.tmpdir(), 'buddy2api');
  // 空闲后端回收时间（ms）：默认 2 小时。2026-09-17 实测冷 spawn ~2.4s，且 ~82% 的冷 spawn
  // 是 5 分钟阈值把保温后端杀掉所致——间歇使用场景每次突发都重新付冷启动。
  // BUDDY2API_IDLE_TIMEOUT_MS 可覆盖（毫秒）。
  // 批6 归位：读取点自模块顶层并入本 seam（同一处声明），表达式逐字保留
  // （`Number(x) || 默认`——不走 parseBoundedInt：它要求整数，会改变非整数输入的现状语义）。
  const idleTimeoutMs = Number(env.BUDDY2API_IDLE_TIMEOUT_MS) || 2 * 60 * 60 * 1000;
  return { maxBackends, queueTimeoutMs, stateDir, idleTimeoutMs, poolFile: path.join(stateDir, 'backends.json') };
}

function parseBoundedInt(raw, { name, def, min, max, belowMin }) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return def;
  const n = Number(raw);
  if (!Number.isInteger(n)) {
    console.warn(`[gateway-pool] ${name}="${raw}" 不是整数，回落默认 ${def}`);
    return def;
  }
  if (n < min) {
    if (belowMin === 'default') {
      console.warn(`[gateway-pool] ${name}="${raw}" 低于下界 ${min}（语义不成立），回落默认 ${def}`);
      return def;
    }
    console.warn(`[gateway-pool] ${name}="${raw}" 低于下界，已钳制到 ${min}`);
    return min;
  }
  if (n > max) {
    console.warn(`[gateway-pool] ${name}="${raw}" 超过上界，已钳制到 ${max}`);
    return max;
  }
  return n;
}

// 模块加载时读一次 env（部署期冻结，与 MAX_BACKENDS 同款历史契约）。
export const POOL_CONFIG = resolvePoolConfig(process.env);
export const STATE_DIR = POOL_CONFIG.stateDir;
export const POOL_FILE = POOL_CONFIG.poolFile;
export const MAX_BACKENDS = POOL_CONFIG.maxBackends;
export const QUEUE_TIMEOUT_MS = POOL_CONFIG.queueTimeoutMs;
export const IDLE_TIMEOUT_MS = POOL_CONFIG.idleTimeoutMs;

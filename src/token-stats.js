/**
 * token-stats.js — 桥接方案的 token 消耗统计。
 *
 * 每个对话请求在终态（完成/超时/出错/中断）时调用 record() 落一条明细，
 * 含实际模型 id、requested vs actual、prompt/completion tokens、耗时、
 * 是否流式、工具调用次数等。查询侧提供两级口径：
 *
 *   summary()  — 总量 + 按模型聚合 + 按客户端 key 聚合
 *   detail()   — 逐请求明细（可按 model/key 过滤，倒序，limit 截断）
 *
 * 持久化：JSONL 追加写（默认 <cwd>/data/token-usage.jsonl，TOKEN_STATS_FILE
 * 覆盖，TOKEN_STATS_FILE=off 关闭）。服务在新会话间不存活，文件让统计跨重启
 * 累计；启动时回放文件恢复最近 CAP 条明细（聚合一律由明细实时计算，
 * 单一数据源，避免两套口径漂移）。
 */

import fs from 'node:fs';
import path from 'node:path';

// token 估算口径已单点化到 usage-accounting.js（架构深化第 8 批 C2）：
// 本模块再导出维持既有 import 面（tests/token-stats.test.js 等），单一实现在新模块。
export { estimateTokens, estimatePromptTokens } from './usage-accounting.js';

// 内存明细上限：JSONL 单条 ~200B，5000 条 ~1MB，聚合遍历亚毫秒级
const DEFAULT_CAP = 5000;

/**
 * 归一化缓存口径，维持不变式 cached + miss == prompt。
 *
 * 网关 usage 的字段组合在版本间不一致（见 acp-events.js）：有的只报
 * cached、有的只报 miss，也可能把 cached 报成 0 而真实命中量在 miss 侧。
 * 这里只做"缺哪侧补哪侧"：任一侧为 0 / 缺省且能与 prompt 互推时，以推导为准，
 * 避免把整段命中缓存的前缀误记为未命中（表现为"每次请求烧 2.3 万 token"）。
 *
 * @param {number} promptTokens
 * @param {number|undefined|null} cachedTokens
 * @param {number|undefined|null} cacheMissTokens
 * @returns {{cached:number, miss:number}}
 */
export function normalizeCache(promptTokens, cachedTokens, cacheMissTokens) {
  const prompt = Number(promptTokens) || 0;
  let cached = cachedTokens != null ? (Number(cachedTokens) || 0) : null;
  let miss = cacheMissTokens != null ? (Number(cacheMissTokens) || 0) : null;

  if (miss == null && cached != null) {
    miss = Math.max(0, prompt - cached);
  } else if (cached == null && miss != null) {
    cached = Math.max(0, prompt - miss);
  } else if (cached === 0 && miss != null && prompt > miss) {
    // cached 被误报为 0（真实命中量在 miss 侧）→ 反推命中量
    cached = Math.max(0, prompt - miss);
  }
  return { cached: cached ?? 0, miss: miss ?? prompt };
}

export class TokenStats {
  /**
   * @param {object} [opts]
   * @param {string|null} [opts.file] JSONL 持久化路径；null 用默认，'off' 关闭
   * @param {number} [opts.cap] 内存明细条数上限
   * @param {boolean} [opts.load=true] 启动时是否回放文件恢复历史
   */
  constructor({ file, cap = DEFAULT_CAP, load = true } = {}) {
    this.cap = cap;
    this.file = file === undefined ? (process.env.TOKEN_STATS_FILE || path.join(process.cwd(), 'data', 'token-usage.jsonl')) : file;
    this.records = [];
    this._writeFailed = false;
    // 目录构造时建一次（架构深化第 8 批 C1）：原先每条记录追加前都 mkdirSync，
    // 每请求一次同步系统调用纯属白付。目录事后被删的场景由写入链的失败告警兜底。
    if (this.file && this.file !== 'off') {
      try { fs.mkdirSync(path.dirname(this.file), { recursive: true }); } catch { /* 写入链兜底 */ }
    }
    if (this.file && this.file !== 'off' && load) this._loadFile();
  }

  /**
   * 记录一条终态明细。
   *
   * @param {object} entry
   * @param {string} [entry.model] 实际使用的模型 id（usage 事件报告 > 客户端指定 > 会话默认）
   * @param {string} [entry.requestedModel] 客户端请求的 model 参数原值
   * @param {number} [entry.promptTokens]
   * @param {number} [entry.completionTokens]
   * @param {string} [entry.usageSource] reported（网关上报，精确）| estimated（文本估算）
   * @param {string} [entry.key] 客户端隔离键（API key）
   * @param {string} [entry.status] completed | timeout | error | aborted
   * @param {boolean} [entry.stream]
   * @param {number} [entry.toolCalls] 本次请求累计的委托工具调用次数
   * @param {number} [entry.durationMs] 请求开始到终态的毫秒数
   * @param {string} [entry.error] 出错时的错误消息（截断）
   * @returns {object} 落库后的完整记录
   */
  record(entry = {}) {
    const promptTokens = Number(entry.promptTokens) || 0;
    const completionTokens = Number(entry.completionTokens) || 0;
    const { cached: cachedTokens, miss: cacheMissTokens } =
      normalizeCache(promptTokens, entry.cachedTokens, entry.cacheMissTokens);
    const rec = {
      ts: entry.ts || new Date().toISOString(),
      model: entry.model || 'unknown',
      requestedModel: entry.requestedModel ?? null,
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
      // 缓存口径：prompt 的大头通常是固定的工具定义前缀，命中前缀缓存后按
      // miss 部分计费。单独记 miss_tokens 才能反映真实开销（见 usageByCategory）。
      cached_tokens: cachedTokens,
      cache_miss_tokens: cacheMissTokens,
      ...(entry.credit != null ? { credit: Number(entry.credit) || 0 } : {}),
      usage_source: entry.usageSource || 'estimated',
      key: entry.key || 'default',
      status: entry.status || 'completed',
      stream: Boolean(entry.stream),
      tool_calls: Number(entry.toolCalls) || 0,
      ...(entry.durationMs != null ? { duration_ms: Math.round(entry.durationMs) } : {}),
      ...(entry.error ? { error: String(entry.error).slice(0, 300) } : {})
    };

    this.records.push(rec);
    if (this.records.length > this.cap) this.records.splice(0, this.records.length - this.cap);

    this._appendFile(rec);
    return rec;
  }

  /**
   * 聚合：总量 + 按模型 + 按客户端 key。可按 model/key 过滤（model 同时匹配
   * 实际模型与请求模型，便于从客户端视角统计"我请求的 glm-5.3 一共用了多少"）。
   */
  summary({ model, key } = {}) {
    const filtered = this.records.filter(r =>
      (!model || r.model === model || r.requestedModel === model) &&
      (!key || r.key === key)
    );

    const agg = (list, by) => {
      const map = new Map();
      for (const r of list) {
        const k = r[by];
        let a = map.get(k);
        if (!a) {
          a = { requests: 0, prompt_tokens: 0, completion_tokens: 0, total_tokens: 0,
            cached_tokens: 0, cache_miss_tokens: 0, credit: 0, last_used_at: null };
          map.set(k, a);
        }
        a.requests++;
        a.prompt_tokens += r.prompt_tokens;
        a.completion_tokens += r.completion_tokens;
        a.total_tokens += r.total_tokens;
        a.cached_tokens += r.cached_tokens || 0;
        a.cache_miss_tokens += r.cache_miss_tokens || 0;
        a.credit += r.credit || 0;
        if (!a.last_used_at || r.ts > a.last_used_at) a.last_used_at = r.ts;
      }
      return [...map.entries()]
        .map(([name, a]) => ({ [by === 'model' ? 'model' : 'key']: name, ...a }))
        .sort((x, y) => y.total_tokens - x.total_tokens);
    };

    const total = filtered.reduce(
      (t, r) => {
        t.requests++;
        t.prompt_tokens += r.prompt_tokens;
        t.completion_tokens += r.completion_tokens;
        t.total_tokens += r.total_tokens;
        t.cached_tokens += r.cached_tokens || 0;
        t.cache_miss_tokens += r.cache_miss_tokens || 0;
        t.credit += r.credit || 0;
        return t;
      },
      { requests: 0, prompt_tokens: 0, completion_tokens: 0, total_tokens: 0,
        cached_tokens: 0, cache_miss_tokens: 0, credit: 0 }
    );

    return { total, models: agg(filtered, 'model'), keys: agg(filtered, 'key') };
  }

  /**
   * 逐请求明细（倒序）。limit 默认 100；model/key 过滤口径同 summary()。
   */
  detail({ limit = 100, model, key } = {}) {
    return this.records
      .filter(r =>
        (!model || r.model === model || r.requestedModel === model) &&
        (!key || r.key === key)
      )
      .slice(-Math.max(1, limit))
      .reverse();
  }

  /** 清空统计：内存明细 + 持久化文件一并重置（保持口径一致，避免重启后"复活"）。
   *  清空走写入链（排在挂起的追加之后），防止旧记录在清空后"复活"。 */
  reset() {
    this.records = [];
    if (this.file && this.file !== 'off') {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      this._writeChain = (this._writeChain || Promise.resolve()).then(() => {
        try {
          fs.writeFileSync(this.file, '');
          this._writeFailed = false;
        } catch (e) {
          console.warn(`[token-stats] 重置持久化文件失败: ${e.message}`);
        }
      });
    }
  }

  /** 等待所有排队中的持久化写入落盘（测试与优雅退出用） */
  flush() {
    return this._writeChain || Promise.resolve();
  }

  /** 回放 JSONL 恢复历史明细。逐行归一化（容忍字段名/schema 漂移），坏行跳过。 */
  _loadFile() {
    // 只读文件尾部（records 有 cap 上限，头部历史反正会被裁掉）——全量
    // readFileSync 在长期运行后（几百 MB）会阻塞启动数秒。
    const TAIL_BYTES = 2 * 1024 * 1024;
    try {
      if (!fs.existsSync(this.file)) return;
      const size = fs.statSync(this.file).size;
      let fd;
      try {
        fd = fs.openSync(this.file, 'r');
        const start = Math.max(0, size - TAIL_BYTES);
        const length = size - start;
        const buf = Buffer.alloc(length);
        fs.readSync(fd, buf, 0, length, start);
        var lines = buf.toString('utf8').split('\n');
        if (start > 0 && lines.length > 0) lines.shift(); // 尾部切片首行大概率不完整
      } finally {
        fs.closeSync(fd);
      }
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const raw = JSON.parse(line);
          if (!raw || typeof raw !== 'object') continue;
          const promptTokens = Number(raw.prompt_tokens ?? raw.promptTokens) || 0;
          const completionTokens = Number(raw.completion_tokens ?? raw.completionTokens) || 0;
          const { cached: cachedTokens, miss: cacheMissTokens } =
            normalizeCache(promptTokens, raw.cached_tokens, raw.cache_miss_tokens);
          const rec = {
            ts: raw.ts || new Date(0).toISOString(),
            model: raw.model || 'unknown',
            requestedModel: raw.requestedModel ?? null,
            prompt_tokens: promptTokens,
            completion_tokens: completionTokens,
            total_tokens: promptTokens + completionTokens,
            cached_tokens: cachedTokens,
            cache_miss_tokens: cacheMissTokens,
            key: raw.key || 'default',
            status: raw.status || 'completed',
            stream: Boolean(raw.stream),
            tool_calls: Number(raw.tool_calls ?? raw.toolCalls) || 0
          };
          if (raw.credit != null) rec.credit = Number(raw.credit) || 0;
          rec.usage_source = raw.usage_source
            || (Number(raw.prompt_tokens) > 0 || Number(raw.completion_tokens) > 0 ? 'reported' : 'estimated');
          if (raw.duration_ms != null) rec.duration_ms = raw.duration_ms;
          if (raw.error) rec.error = raw.error;
          this.records.push(rec);
        } catch { /* 坏行跳过 */ }
      }
      if (this.records.length > this.cap) {
        this.records.splice(0, this.records.length - this.cap);
      }
      if (this.records.length > 0) {
        console.log(`[token-stats] 已恢复 ${this.records.length} 条历史消耗明细`);
      }
    } catch (e) {
      console.warn(`[token-stats] 读取持久化文件失败（仅内存统计）: ${e.message}`);
    }
  }

  /** JSONL 追加一行；写失败只警告一次（统计不应反向影响请求链路）。
   *  异步串行化写入（Promise 链保序）：appendFileSync 会阻塞事件循环，
   *  流式代理每个请求都写一次，同步 IO 会拖慢所有在飞请求。 */
  _appendFile(rec) {
    if (!this.file || this.file === 'off') return;
    try {
      this._writeChain = (this._writeChain || Promise.resolve()).then(() => {
        return fs.promises.appendFile(this.file, JSON.stringify(rec) + '\n').catch((e) => {
          if (e?.code !== 'ENOENT') throw e;
          // 目录事后被删（清理器/tmpfs 重挂）的一次性自愈：重建目录后重放本次追加
          //（CR K1——构造期 mkdir 单点化后，若无此自愈，目录被删会让后续每条
          // 台账在 _writeFailed 闩锁下静默丢弃直到重启）
          fs.mkdirSync(path.dirname(this.file), { recursive: true });
          return fs.promises.appendFile(this.file, JSON.stringify(rec) + '\n');
        });
      }).then(() => {
        this._writeFailed = false;
      }).catch((e) => {
        if (!this._writeFailed) {
          this._writeFailed = true;
          console.warn(`[token-stats] 持久化写入失败（后续静默，仅内存统计）: ${e.message}`);
        }
      });
    } catch (e) {
      if (!this._writeFailed) {
        this._writeFailed = true;
        console.warn(`[token-stats] 持久化写入失败（后续静默，仅内存统计）: ${e.message}`);
      }
    }
  }
}

// 全局单例：handler 记账、路由查询共用一份
export const tokenStats = new TokenStats();

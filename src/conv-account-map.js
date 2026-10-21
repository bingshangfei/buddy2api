/**
 * ConvPoolMap — 会话 → 池 亲和映射（有界 LRU + 死条目优先淘汰）。
 *
 * 淘汰语义（与 ConvAccountMap 共享同一实现，见下方继承关系）：
 * 上限 maxEntries（默认 500）、触发 `!has && size>=max`、一次淘汰 floor(max/5)
 * 条（默认 100，与 affinity.md 契约一致）、delete+set 写刷新。
 *
 * refactor-20260928-arch-deepening2 批5 新增。**本文件原头注释曾以「加 cap 是
 * 伪装成平移的行为变更」为由刻意不收 convPools**——该决策已被本任务**申报后
 * 有意重开**（requirements D6 / 用户批准的唯一行为变化点；affinity.md「刻意不做」
 * 段同步改写）：无界映射是真实内存泄漏面，补界带死条目优先淘汰（先删
 * `!pools.has(poolId)` 的死指向再淘汰活条目，审视 F8）+ onEvict 回调（调用方
 * 打日志，淘汰可观测），把「静默亲和失效」窗口压到趋近零。
 *
 * @param {{maxEntries?: number, evictCount?: number, isDead?: (poolId: string) => boolean,
 *          onEvict?: (key: string, value: string, dead: boolean) => void}} [opts]
 *  isDead：条目是否指向已不存在的池（session-manager 传 `!this.pools.has(poolId)`）；
 *  不传 = 纯 LRU（即 ConvAccountMap 语义）。onEvict：淘汰观测回调（未传则静默）。
 */
export class ConvPoolMap {
  constructor({ maxEntries = 500, evictCount = Math.floor(maxEntries / 5), isDead = null, onEvict = null } = {}) {
    this._map = new Map();
    this._maxEntries = maxEntries;
    this._evictCount = evictCount;
    this._isDead = isDead;
    this._onEvict = onEvict;
  }

  has(key) { return this._map.has(key); }
  get(key) { return this._map.get(key); }
  delete(key) { return this._map.delete(key); }
  get size() { return this._map.size; }

  set(key, value) {
    if (!this._map.has(key) && this._map.size >= this._maxEntries) {
      let drop = this._evictCount;
      // 第一遍（仅配置 isDead 时）：先淘汰死条目（指向已销毁的池——本就该清理，
      // 不损失任何活亲和）。isDead 收 **value**（poolId）——键是 convId，死活看
      // 的是指向的池是否还在。
      if (this._isDead) {
        for (const [k, v] of this._map) {
          if (drop <= 0) break;
          if (!this._isDead(v)) continue;
          this._map.delete(k);
          this._evict(k, v, true);
          drop -= 1;
        }
      }
      // 第二遍：不足额再按插入顺序淘汰最旧的活条目（delete+set 写刷新序）。
      // 不配 isDead 时本遍即全部淘汰逻辑，与 ConvAccountMap 历史行为逐字等价。
      for (const [k, v] of this._map) {
        if (drop <= 0) break;
        this._map.delete(k);
        this._evict(k, v, false);
        drop -= 1;
      }
    }
    this._map.delete(key);
    this._map.set(key, value);
    return this;
  }

  _evict(k, v, dead) {
    this._onEvict?.(k, v, dead);
  }
}

/**
 * ConvAccountMap — 会话 → 账号 亲和映射（refactor-20260926-arch-deepening 候选③
 * 从 handler 抽出；淘汰算法的行为锁 = tests/account-affinity.test.js，不得弱化）。
 *
 * 批5 起与 ConvPoolMap 共享同一实现（isDead/onEvict 不传 = 纯 LRU，淘汰循环
 * 逐字等价于本类此前的独立实现）——「两张映射共享同一套 LRU 语义」从注释
 * 变成代码，消掉 25 行拷贝（CR Standards 轴 Duplicated Code 发现）。
 */
export class ConvAccountMap extends ConvPoolMap {}

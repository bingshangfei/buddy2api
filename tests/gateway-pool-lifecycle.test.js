/**
 * 后端池生命周期单测：池状态持久化（原子写 / 退出 flush）与会话复用判据。
 *
 * 对应 evidence/test-matrix.md：
 *   C 组（C1-C4）保温判据 `isReusable`（拍板①：不改 TTL → 纯重构，C4 等价性是终态验收）
 *   E 组（E1-E5）原子写 + 退出 flush（拍板②：#6 只做原子写，不做去抖异步）
 *   F 组（F1-F3）isHealthy 真实行为（此前全部测试都 stub 掉它，行为零断言）
 *
 * 背景：gateway-discovery 的 saveState/isHealthy/warmup 此前**零单测**（见
 * evidence/baseline.md 测试真空记录），本文件补上持久化这一块的安全网。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ISOLATED_TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'buddy2api-life-root-'));
process.env.TEMP = ISOLATED_TMP;
process.env.TMP = ISOLATED_TMP;
process.env.TMPDIR = ISOLATED_TMP;

const EMPTY_ACCOUNTS = fs.mkdtempSync(path.join(os.tmpdir(), 'buddy2api-life-acc-'));
process.env.BUDDY2API_ACCOUNTS_DIR = EMPTY_ACCOUNTS;

const gw = await import('../src/gateway-discovery.js');
const sm = await import('../src/session-manager.js');

const GW_SRC = fs.readFileSync(fileURLToPath(new URL('../src/gateway-discovery.js', import.meta.url)), 'utf8');
const INDEX_SRC = fs.readFileSync(fileURLToPath(new URL('../src/index.js', import.meta.url)), 'utf8');

function makePool(opts = {}) {
  const pool = new gw.BackendPool(opts);
  if (pool.cleanupTimer) { clearInterval(pool.cleanupTimer); pool.cleanupTimer = null; }
  pool.backends = new Map();
  pool.spawnNew = async () => ({ url: 'http://127.0.0.1:9601', pid: 7001, child: null, startedAt: Date.now() });
  pool.isHealthy = async () => true;
  return pool;
}

function entry(url, pid) {
  return {
    url, pid, child: null, status: 'idle', toolsEnabled: true, accountId: null,
    startedAt: Date.now(), lastUsedAt: Date.now()
  };
}

function tmpDir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `buddy2api-${tag}-`));
}

/** 保留真实 isHealthy 的池子（makePool 会把它 stub 掉，不能用于 F 组） */
function barePool() {
  const pool = new gw.BackendPool({ stateDir: tmpDir('bare') });
  if (pool.cleanupTimer) { clearInterval(pool.cleanupTimer); pool.cleanupTimer = null; }
  return pool;
}

/** 起一个本地 http server 冒充 ACP 网关，返回 { server, url } */
function startStubGateway(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, url: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

function closeServer(server) {
  return new Promise((resolve) => {
    server.closeAllConnections?.();
    server.close(() => resolve());
  });
}

/** 捕获 console.warn */
function captureWarn(fn) {
  const orig = console.warn;
  const warns = [];
  console.warn = (...a) => { warns.push(a.map(String).join(' ')); };
  try {
    return { result: fn(), warns };
  } finally {
    console.warn = orig;
  }
}

// ---------------------------------------------------------------- C. 保温判据 isReusable

/** 旧实现（改动前两处调用点内联的同一条判据），作为等价性对照 */
function legacyReusable(pool, now) {
  if (!pool) return false;
  if (pool.busy) return false;
  if (now - pool.lastUsedAt > sm.CONNECTION_TTL_MS) return false;
  if (typeof pool.client.hasInflightPrompt === 'function' && pool.client.hasInflightPrompt()) return false;
  return true;
}

function poolFixture({ busy = false, age = 0, inflight = false } = {}) {
  return {
    id: 'p1', key: 'k', convId: null, url: 'http://127.0.0.1:1',
    busy, lastUsedAt: Date.now() - age,
    client: { hasInflightPrompt: () => inflight }
  };
}

test('C1 idle 且未过期 → isReusable 为 true', () => {
  assert.equal(typeof sm.isReusable, 'function', 'session-manager 应导出统一判据 isReusable');
  assert.equal(sm.isReusable(poolFixture({ busy: false, age: 1000 })), true);
});

test('C2 idle 但超过 CONNECTION_TTL_MS → false（且 TTL 取值未被改动）', () => {
  assert.equal(sm.CONNECTION_TTL_MS, 30 * 60 * 1000, '拍板①：不改 TTL —— 30min 泄漏兜底必须原样保留');
  assert.equal(sm.isReusable(poolFixture({ busy: false, age: sm.CONNECTION_TTL_MS + 1 })), false);
});

test('C3 busy 池即使未过期 → false', () => {
  assert.equal(typeof sm.isReusable, 'function', 'session-manager 应导出统一判据 isReusable');
  assert.equal(sm.isReusable(poolFixture({ busy: true, age: 1000 })), false);
});

test('C4 等价性：isReusable 与旧内联判据对同一 (busy, age, inflight) 输入结果全等', () => {
  assert.equal(typeof sm.isReusable, 'function', 'session-manager 应导出统一判据 isReusable');
  const now = Date.now();
  const ages = [0, sm.CONNECTION_TTL_MS, sm.CONNECTION_TTL_MS + 1];
  let checked = 0;
  for (const busy of [false, true]) {
    for (const age of ages) {
      for (const inflight of [false, true]) {
        const pool = { ...poolFixture({ busy, age, inflight }), lastUsedAt: now - age };
        assert.equal(
          sm.isReusable(pool, now),
          legacyReusable(pool, now),
          `纯重构等价性失败：busy=${busy} age=${age} inflight=${inflight}`
        );
        checked += 1;
      }
    }
  }
  assert.equal(checked, 12, '应覆盖全部 12 种组合');
});

test('C4b 等价性：acquireExisting 的接受集合与旧判据完全一致', () => {
  const now = Date.now();
  for (const busy of [false, true]) {
    for (const inflight of [false, true]) {
      for (const age of [0, sm.CONNECTION_TTL_MS + 1]) {
        const mgr = new sm.SessionManager('http://127.0.0.1:1');
        const pool = { ...poolFixture({ busy, age, inflight }), lastUsedAt: now - age };
        mgr.pools.set('p1', pool);
        // 期望值必须**先算**：acquireExisting 命中时会把 pool.busy 置 true，
        // 之后再算 legacy 会读到被改过的状态，造成"接受了却比对为 false"的假失败。
        const expected = legacyReusable(pool, now);
        const accepted = Boolean(mgr.acquireExisting('k', 'p1', 's1'));
        assert.equal(
          accepted,
          expected,
          `acquireExisting 接受集合漂移：busy=${busy} age=${age} inflight=${inflight}`
        );
      }
    }
  }
});

// ---------------------------------------------------------------- E. 池状态持久化

test('E1 saveState 写出合法 JSON 且不残留 temp 文件', () => {
  const dir = tmpDir('state-e1');
  const pool = makePool({ stateDir: dir });
  try {
    pool.backends.set('http://127.0.0.1:9611', entry('http://127.0.0.1:9611', 611));
    pool.backends.set('http://127.0.0.1:9612', entry('http://127.0.0.1:9612', 612));
    pool.backends.set('http://127.0.0.1:9613', entry('http://127.0.0.1:9613', 613));
    pool.saveState();

    const file = path.join(dir, 'backends.json');
    assert.ok(fs.existsSync(file), `saveState 应把池文件写到实例的 STATE_DIR（${file}）`);
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(parsed.length, 3, '应含 3 条记录');
    const leftovers = fs.readdirSync(dir).filter((f) => f !== 'backends.json');
    assert.deepEqual(leftovers, [], `不得残留临时文件：${leftovers.join('、')}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('E2 原子性：rename 失败时旧文件保持完整，不出现截断 JSON', () => {
  const dir = tmpDir('state-e2');
  const file = path.join(dir, 'backends.json');
  const pool = makePool({ stateDir: dir });
  const origRename = fs.renameSync;
  try {
    // 先写一份"上一版完整状态"
    pool.backends.set('http://127.0.0.1:9621', entry('http://127.0.0.1:9621', 621));
    pool.saveState();
    assert.ok(fs.existsSync(file), '前置：第一版状态应已落盘');
    const before = fs.readFileSync(file, 'utf8');

    // 模拟"写到一半崩溃"：原子替换那一步失败
    fs.renameSync = () => { throw new Error('simulated crash before rename'); };
    pool.backends.set('http://127.0.0.1:9622', entry('http://127.0.0.1:9622', 622));
    const { warns } = captureWarn(() => pool.saveState());

    assert.equal(fs.readFileSync(file, 'utf8'), before, '中断后必须仍读得到上一份完整 JSON');
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).length, 1, '不得出现截断/半写状态');
    assert.ok(warns.length >= 1, '写盘失败应告警而不是静默');
  } finally {
    fs.renameSync = origRename;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('E3 退出路径 flush 池状态（SIGINT/SIGTERM → shutdown → flush）', async () => {
  assert.match(INDEX_SRC, /process\.on\('SIGINT', shutdown\)/, 'index.js 应挂 SIGINT');
  assert.match(INDEX_SRC, /process\.on\('SIGTERM', shutdown\)/, 'index.js 应挂 SIGTERM');
  assert.match(INDEX_SRC, /shutdownManagedProcess\(\)/, 'shutdown 应调用 shutdownManagedProcess');

  const dir = tmpDir('state-e3');
  const pool = gw.backendPool;
  const orig = { backends: pool.backends, spawnNew: pool.spawnNew, poolFile: pool.poolFile };
  try {
    pool.backends = new Map();
    pool.poolFile = path.join(dir, 'backends.json');
    // 预置一份含"已死后端"的过期池文件：下次启动会收养这些 pid，正是要防的孤儿来源
    fs.writeFileSync(pool.poolFile, JSON.stringify([entry('http://127.0.0.1:9099', 999)], null, 2));
    pool.backends.set('http://127.0.0.1:9631', entry('http://127.0.0.1:9631', 631));
    // 故意不调用 saveState：模拟"有新 spawn 条目尚未落盘时收到退出信号"
    await gw.shutdownManagedProcess();
    // 只断言 existsSync 会被 [] 蒙混过关：shutdownAll 的顺序是 kill → clear → saveState，
    // 落盘内容必须确实是空池，否则下次启动会把一批已死的 pid 当后端收养（孤儿后端）。
    const flushed = JSON.parse(fs.readFileSync(pool.poolFile, 'utf8'));
    assert.deepEqual(flushed, [],
      `退出 flush 必须写出空池（后端已全部 kill），实际写出 ${JSON.stringify(flushed)}`);
  } finally {
    pool.backends = orig.backends;
    pool.spawnNew = orig.spawnNew;
    pool.poolFile = orig.poolFile;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('E4 写盘失败不影响请求路径（仅告警，不抛）', () => {
  const dir = tmpDir('state-e4');
  const pool = makePool({ stateDir: dir });
  try {
    // 让池文件路径是一个目录 → 写盘必然失败（比"目录只读"在 Windows 上更确定）
    fs.mkdirSync(path.join(dir, 'backends.json'), { recursive: true });
    const { warns } = captureWarn(() => pool.saveState());
    assert.ok(warns.length >= 1, '写盘失败必须告警');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('E5 明确不做去抖/异步写（拍板②：#6 只做原子写）', () => {
  assert.doesNotMatch(GW_SRC, /\bdebounce\b/i, '不得引入去抖');
  assert.doesNotMatch(GW_SRC, /fs\.writeFile\(/, '不得使用异步 fs.writeFile（会引入未落盘窗口与孤儿后端）');

  // saveState 体内不得出现定时器/异步延迟
  const body = GW_SRC.match(/saveState\(\)\s*\{([\s\S]*?)\n  \}/);
  assert.ok(body, '应能定位 saveState 实现');
  assert.doesNotMatch(body[1], /setTimeout|setInterval|await |Promise/, 'saveState 必须保持同步、无延迟');
});

test('E6 acquire/release 占用翻转零落盘；成员变化才写盘（架构深化第 8 批 C1）', async () => {
  const dir = tmpDir('state-e6');
  const pool = makePool({ stateDir: dir });
  try {
    const file = path.join(dir, 'backends.json');
    pool.backends.set('http://127.0.0.1:9641', entry('http://127.0.0.1:9641', 641));
    pool.saveState(); // 基线快照（成员注册态）
    const before = fs.readFileSync(file, 'utf8');

    // 占用翻转（每请求路径）不得写盘
    const url = await pool.acquire({});
    assert.equal(url, 'http://127.0.0.1:9641', '前置：应复用该空闲后端');
    assert.equal(fs.readFileSync(file, 'utf8'), before, 'acquire 复用空闲后端不得落盘');
    pool.release(url);
    assert.equal(fs.readFileSync(file, 'utf8'), before, 'release 归还不得到落盘');
    pool.markBusy(url);
    assert.equal(fs.readFileSync(file, 'utf8'), before, 'markBusy 不得落盘');

    // 成员变化仍必须落盘：discardBackend 删除成员后文件反映新成员清单
    pool.discardBackend(url);
    const after = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(after.length, 0, 'discard 后文件应为空成员清单（且仅落盘一次）');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('E7 池状态文件 schema = 成员清单快照（restoreState 读取集，无瞬态字段）', () => {
  const dir = tmpDir('state-e7');
  const pool = makePool({ stateDir: dir });
  try {
    pool.backends.set('http://127.0.0.1:9651', entry('http://127.0.0.1:9651', 651));
    pool.saveState();
    const parsed = JSON.parse(fs.readFileSync(path.join(dir, 'backends.json'), 'utf8'));
    assert.equal(parsed.length, 1);
    assert.deepEqual(
      Object.keys(parsed[0]).sort(),
      ['accountId', 'pid', 'startedAt', 'toolsEnabled', 'url'],
      'status/lastUsedAt 是恢复时写死/重置的瞬态，不得进文件（restoreState 不读）'
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- F. isHealthy 真实行为
// 背景：isHealthy 在既有测试里**全部被 stub 掉**（F 组微基准只测了耗时，行为零断言）。
// 它位于 acquire 的"复用空闲后端"热路径上，判错就等于把已经不能服务的后端当活的继续用。
// 这里用本地 http server 冒充 ACP 网关，把真实行为钉住，不依赖 codebuddy 进程。

test('F1 网关能应答 /api/v1/acp/connect → isHealthy 为 true', async () => {
  const seen = [];
  const { server, url } = await startStubGateway((req, res) => {
    seen.push(req.url);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ connectionId: 'c1', sessionToken: 't1' }));
  });
  try {
    assert.equal(await barePool().isHealthy(url), true, '能完成 ACP connect 握手 = 健康');
    assert.ok(seen.some((u) => u === '/api/v1/acp/connect'),
      `应探活 ACP connect 端点，实际请求 ${JSON.stringify(seen)}`);
  } finally {
    await closeServer(server);
  }
});

test('F2 端口在听但答不出可用的 ACP 连接 → isHealthy 为 false（不被"有响应"骗过）', async () => {
  const { server, url } = await startStubGateway((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<html>not an acp gateway</html>');
  });
  try {
    assert.equal(await barePool().isHealthy(url), false,
      '响应不是可用的 ACP 连接（解析不出 connectionId）时必须判为不健康，否则请求会打到非 ACP 服务上');
  } finally {
    await closeServer(server);
  }
});

test('F3 端口无人监听（连接被拒）→ isHealthy 为 false', async () => {
  const { server, url } = await startStubGateway((req, res) => res.end('{}'));
  await closeServer(server); // 关掉 → 该端口不再监听
  assert.equal(await barePool().isHealthy(url), false, '连接被拒必须判为不健康');
});

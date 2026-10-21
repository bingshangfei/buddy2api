/**
 * 隔离登录沙盒状态机测试（node:test，零依赖）。
 *
 * 覆盖（check.jsonl 用例标识）：preflight 拒绝项（P1/P3/P5）、env 清洗与影子（D1/D2）、
 * drift 中止与恢复（D3/D4/M-F1）、harvest 字面路径与轮询（H1/H2/M-F3）、加密壳（H4/E1/E2）、
 * uid 校验（H3）、定向导入与 expiresAt 闸（M1/M2/M3）、备份过滤器边界（B1）、
 * 终检（R1）、自愈/recover 幂等（R3/R4/X2）、普通登录（L2）、信号守卫（R2 机制）、
 * 并发锁（X1）、服务探测提示（P6）。
 *
 * 约定：全部走参数注入（F25）——authDir/tmpRoot/journalFile/spawnLogin/env 沙盒化，
 * 不碰真实目录、不真拉 CLI；时间参数注入（harvestPollMs/harvestTimeoutMs）避免真实等待。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  runIsolatedLogin,
  healIfNeeded,
  runRecover,
  buildChildEnv,
  computeCliAuthDir,
  installSignalGuards
} from '../scripts/isolated-login.js';
import { importFromAuthDir } from '../src/account-store.js';

const projectRoot = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const CANON = 'workbuddy-desktop.info';

/** 沙盒：authDir / accDir / tmpRoot / journalFile 全隔离；finally 清理 */
function withSandbox() {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), 'b2a-iso-auth-'));
  const accDir = fs.mkdtempSync(path.join(os.tmpdir(), 'b2a-iso-acc-'));
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'b2a-iso-tmp-'));
  const journalFile = path.join(tmpRoot, 'journal.json');
  const prevAcc = process.env.BUDDY2API_ACCOUNTS_DIR;
  const prevJournal = process.env.BUDDY2API_ISOLATED_JOURNAL;
  process.env.BUDDY2API_ACCOUNTS_DIR = accDir;
  process.env.BUDDY2API_ISOLATED_JOURNAL = journalFile;
  return {
    authDir,
    accDir,
    tmpRoot,
    journalFile,
    cleanup() {
      if (prevAcc === undefined) delete process.env.BUDDY2API_ACCOUNTS_DIR;
      else process.env.BUDDY2API_ACCOUNTS_DIR = prevAcc;
      if (prevJournal === undefined) delete process.env.BUDDY2API_ISOLATED_JOURNAL;
      else process.env.BUDDY2API_ISOLATED_JOURNAL = prevJournal;
      for (const d of [authDir, accDir, tmpRoot]) fs.rmSync(d, { recursive: true, force: true });
    }
  };
}

const plainState = (uid, over = {}) => ({
  account: { uid, nickname: `nick-${uid}`, uin: 'u', type: 'personal' },
  auth: { accessToken: `tok-${uid}`, refreshToken: 'r', expiresAt: over.expiresAt ?? Date.now() + 86_400_000 }
});

const encState = (uid, shell = 1) => ({
  account: { uid, nickname: 'n' },
  auth: {
    accessToken: shell === 2
      ? { $wbEncrypted: 1, envelope: 'e', scheme: 'asym-v1', extra: { a: 1 } }
      : { $wbEncrypted: 1, envelope: 'e' },
    expiresAt: Date.now() + 86_400_000
  }
});

/** 成功登录的 spawn 模拟：把新账号写入影子 canonical；返回捕获到的 env */
function makeLoginSim(uid = 'new-uid', over = {}) {
  const captured = {};
  const fn = async ({ env, shadowDir }) => {
    captured.env = env;
    captured.shadowDir = shadowDir;
    const dir = path.join(computeCliAuthDir(shadowDir));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, CANON), JSON.stringify(plainState(uid, over)));
    return { code: 0 };
  };
  return { fn, captured };
}

/** 回收日志的 log 替身 */
function collector() {
  const lines = [];
  const log = (m) => lines.push(String(m));
  log.lines = lines;
  log.has = (sub) => lines.some((l) => l.includes(sub));
  return log;
}

const baseEnv = () => ({ PATH: process.env.PATH, HOME: process.env.HOME });

// ---------- P1/P3/P5：preflight 拒绝与提示 ----------

test('P1：CODEBUDDY_AUTH_FILE 已设置 → 中止且不 spawn', async () => {
  const h = withSandbox();
  try {
    let spawned = false;
    const r = await runIsolatedLogin({
      authDir: h.authDir,
      journalFile: h.journalFile,
      tmpRoot: h.tmpRoot,
      log: collector(),
      env: { ...baseEnv(), CODEBUDDY_AUTH_FILE: 'C:/x/y.info' },
      spawnLogin: async () => { spawned = true; return { code: 0 }; }
    });
    assert.equal(r.ok, false);
    assert.equal(r.failed, 'env-auth-file');
    assert.equal(spawned, false);
  } finally { h.cleanup(); }
});

test('P3：CLI product.json authentication.id 不符 → 中止', async () => {
  const h = withSandbox();
  try {
    const fakeCli = path.join(h.tmpRoot, 'cli', 'bin', 'codebuddy');
    fs.mkdirSync(path.dirname(fakeCli), { recursive: true });
    fs.writeFileSync(path.join(h.tmpRoot, 'cli', 'product.json'), JSON.stringify({ authentication: { id: 'other-product' } }));
    const r = await runIsolatedLogin({
      authDir: h.authDir,
      journalFile: h.journalFile,
      tmpRoot: h.tmpRoot,
      log: collector(),
      env: baseEnv(),
      cliPath: fakeCli,
      spawnLogin: async () => ({ code: 0 })
    });
    assert.equal(r.failed, 'product-id');
    assert.equal(r.productId, 'other-product');
  } finally { h.cleanup(); }
});

test('P5：凭据类 env 指示器 → 提示不阻断（子环境剥离），流程继续', async () => {
  const h = withSandbox();
  try {
    const log = collector();
    const sim = makeLoginSim('u-ind');
    const r = await runIsolatedLogin({
      authDir: h.authDir, journalFile: h.journalFile, tmpRoot: h.tmpRoot,
      log, env: { ...baseEnv(), CODEBUDDY_AUTH_TOKEN: 'x' },
      spawnLogin: sim.fn, harvestTimeoutMs: 500, harvestPollMs: 10
    });
    assert.equal(r.ok, true);
    assert.ok(log.has('CODEBUDDY_AUTH_TOKEN'));
  } finally { h.cleanup(); }
});

test('P6：服务在跑且池空 → 提示先停服；池非空 → 静默', async () => {
  const h = withSandbox();
  try {
    const log1 = collector();
    const sim1 = makeLoginSim('u-svc');
    await runIsolatedLogin({
      authDir: h.authDir, journalFile: h.journalFile, tmpRoot: h.tmpRoot,
      log: log1, env: baseEnv(), spawnLogin: sim1.fn,
      probeService: async () => true, probeDesktop: () => false,
      harvestTimeoutMs: 500, harvestPollMs: 10
    });
    assert.ok(log1.has('账号池为空'));

    // 池非空（写入一条种子记录）
    fs.writeFileSync(path.join(h.accDir, 'seed.json'), JSON.stringify({
      id: 'seed', nickname: 's', accessToken: 't', expiresAt: Date.now() + 86_400_000
    }));
    const log2 = collector();
    const sim2 = makeLoginSim('u-svc2');
    await runIsolatedLogin({
      authDir: h.authDir, journalFile: h.journalFile, tmpRoot: h.tmpRoot,
      log: log2, env: baseEnv(), spawnLogin: sim2.fn,
      probeService: async () => true, probeDesktop: () => false,
      harvestTimeoutMs: 500, harvestPollMs: 10
    });
    assert.ok(!log2.has('账号池为空'));
  } finally { h.cleanup(); }
});

// ---------- D1/D2：env 清洗与影子 ----------

test('buildChildEnv：剥离三变量 + CODEBUDDY_CONFIG_DIR + 影子三键；无影子时不改 home 类键', () => {
  const env = buildChildEnv({
    CODEBUDDY_AUTH_TOKEN: 'a', CODEBUDDY_API_KEY: 'b',
    CODEBUDDY_CONFIG_DIR: 'C:/real/.codebuddy',
    ACC_PRODUCT_CONFIG_V3: 'c', ACC_PRODUCT_CONFIG: 'd', KEEP: 'x',
    USERPROFILE: 'C:/real', HOME: 'C:/real', LOCALAPPDATA: 'C:/real/AppData/Local'
  }, 'C:/shadow');
  assert.equal(env.CODEBUDDY_AUTH_TOKEN, undefined);
  assert.equal(env.CODEBUDDY_API_KEY, undefined);
  assert.equal(env.CODEBUDDY_CONFIG_DIR, undefined, 'CONFIG_DIR 须剥离（全影子，CR R3）');
  assert.equal(env.ACC_PRODUCT_CONFIG_V3, undefined);
  assert.equal(env.ACC_PRODUCT_CONFIG, undefined);
  assert.equal(env.KEEP, 'x');
  assert.equal(env.USERPROFILE, 'C:/shadow');
  assert.equal(env.HOME, 'C:/shadow');
  assert.equal(env.LOCALAPPDATA, path.join('C:/shadow', 'AppData', 'Local'));
  const env2 = buildChildEnv({ USERPROFILE: 'C:/real' }, null);
  assert.equal(env2.USERPROFILE, 'C:/real');
});

test('D1/D2：spawn 捕获 env —— 无三变量、影子三键齐、CODEBUDDY_CONFIG_DIR 未设置', async () => {
  const h = withSandbox();
  try {
    const sim = makeLoginSim('u-env');
    await runIsolatedLogin({
      authDir: h.authDir, journalFile: h.journalFile, tmpRoot: h.tmpRoot,
      log: collector(), env: { ...baseEnv(), CODEBUDDY_AUTH_TOKEN: 'a', ACC_PRODUCT_CONFIG_V2: 'c' },
      spawnLogin: sim.fn, probeService: async () => false, probeDesktop: () => false,
      harvestTimeoutMs: 500, harvestPollMs: 10
    });
    const e = sim.captured.env;
    assert.equal(e.CODEBUDDY_AUTH_TOKEN, undefined);
    assert.equal(e.ACC_PRODUCT_CONFIG_V2, undefined);
    assert.equal(e.USERPROFILE, sim.captured.shadowDir);
    assert.equal(e.HOME, sim.captured.shadowDir);
    assert.equal(e.LOCALAPPDATA, path.join(sim.captured.shadowDir, 'AppData', 'Local'));
    assert.equal(e.CODEBUDDY_CONFIG_DIR, undefined);
  } finally { h.cleanup(); }
});

// ---------- D3/D4/M-F1：drift ----------

test('D4：正常流 —— 真实 canonical 逐字节不变、影子清理、journal/备份清理、成功导入', async () => {
  const h = withSandbox();
  try {
    const oldBytes = JSON.stringify(plainState('old-uid'));
    fs.writeFileSync(path.join(h.authDir, CANON), oldBytes);
    fs.writeFileSync(path.join(h.authDir, 'workbuddy-desktop.2026-01-01T00-00-00-000Z.1.a.info'), JSON.stringify(plainState('snap-uid')));
    const sim = makeLoginSim('new-uid');
    const r = await runIsolatedLogin({
      authDir: h.authDir, journalFile: h.journalFile, tmpRoot: h.tmpRoot,
      log: collector(), env: baseEnv(), spawnLogin: sim.fn,
      probeService: async () => false, probeDesktop: () => false,
      harvestTimeoutMs: 500, harvestPollMs: 10
    });
    assert.equal(r.ok, true);
    assert.equal(r.record.id, 'new-uid');
    // 真实 canonical 逐字节不变（含快照条目不变）
    assert.equal(fs.readFileSync(path.join(h.authDir, CANON), 'utf8'), oldBytes);
    assert.deepEqual(
      fs.readdirSync(h.authDir).sort(),
      [CANON, 'workbuddy-desktop.2026-01-01T00-00-00-000Z.1.a.info'].sort()
    );
    // 影子目录已清理
    assert.deepEqual(fs.readdirSync(h.tmpRoot).filter((n) => n.startsWith('b2a-isolated-')), []);
    // journal/备份已清理
    assert.equal(fs.existsSync(h.journalFile), false);
    assert.equal(fs.existsSync(path.join(h.authDir, `${CANON}.isolated-backup.bak`)), false);
    // 定向导入：池中恰一条新记录
    assert.deepEqual(fs.readdirSync(h.accDir), ['new-uid.json']);
  } finally { h.cleanup(); }
});

test('D3/M-F1：drift（switch 路径复刻：canonical 被改名 + 新 uid 写入）→ 中止 + 恢复 + 响亮失败', async () => {
  const h = withSandbox();
  try {
    const oldBytes = JSON.stringify(plainState('old-uid'));
    fs.writeFileSync(path.join(h.authDir, CANON), oldBytes);
    const log = collector();
    // 模拟 CLI 吞 shadow：把 canonical 改名成快照，再写另一个账号
    const spawn = async ({ shadowDir }) => {
      const snap = path.join(h.authDir, 'workbuddy-desktop.2026-10-14T00-00-00-000Z.999.rogue.info');
      fs.renameSync(path.join(h.authDir, CANON), snap);
      fs.writeFileSync(path.join(h.authDir, CANON), JSON.stringify(plainState('rogue-uid')));
      return { code: 0 };
    };
    const r = await runIsolatedLogin({
      authDir: h.authDir, journalFile: h.journalFile, tmpRoot: h.tmpRoot,
      log, env: baseEnv(), spawnLogin: spawn,
      probeService: async () => false, probeDesktop: () => false,
      harvestTimeoutMs: 300, harvestPollMs: 10
    });
    assert.equal(r.ok, false);
    assert.equal(r.failed, 'drift');
    assert.equal(r.rescued, true);
    // 恢复为实验前字节，且 rogue 快照不复存在（被改名回 canonical）
    assert.equal(fs.readFileSync(path.join(h.authDir, CANON), 'utf8'), oldBytes);
    assert.deepEqual(fs.readdirSync(h.authDir), [CANON]);
    assert.ok(log.has('CLI 行为与预期不符'));
    // 无导入
    assert.deepEqual(fs.readdirSync(h.accDir), []);
  } finally { h.cleanup(); }
});

// ---------- H1/H2/H4/M-F3：harvest ----------

test('H1/M-F3：目录只剩旧快照（无新 canonical）→ 失败，不读快照、不导入、不报成功', async () => {
  const h = withSandbox();
  try {
    fs.writeFileSync(path.join(h.authDir, 'workbuddy-desktop.2026-01-01T00-00-00-000Z.1.a.info'), JSON.stringify(plainState('stale-uid')));
    const log = collector();
    const r = await runIsolatedLogin({
      authDir: h.authDir, journalFile: h.journalFile, tmpRoot: h.tmpRoot,
      log, env: baseEnv(),
      spawnLogin: async ({ shadowDir }) => {
        // 复刻 F5 形态：登录未完成（无 canonical），但目录里留下了一份轮换快照
        // ——若 harvest 走「最新快照回退」，该快照会被误当新凭据（变异检验可红）
        const dir = computeCliAuthDir(shadowDir);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'workbuddy-desktop.2026-10-14T00-00-00-000Z.3.rotated.info'), JSON.stringify(plainState('rotated-uid')));
        return { code: 0 };
      },
      probeService: async () => false, probeDesktop: () => false,
      harvestTimeoutMs: 60, harvestPollMs: 10
    });
    assert.equal(r.failed, 'harvest-missing');
    assert.deepEqual(fs.readdirSync(h.accDir), []);
    assert.ok(!log.has('✅'));
  } finally { h.cleanup(); }
});

test('H2：影子 canonical 半写 → 轮询重试至可解析；始终不可解析 → 超时失败', async () => {
  const h = withSandbox();
  try {
    const sim = {
      fn: async ({ shadowDir }) => {
        const dir = computeCliAuthDir(shadowDir);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, CANON), '{"account":{'); // 半写
        setTimeout(() => {
          fs.writeFileSync(path.join(dir, CANON), JSON.stringify(plainState('late-uid')));
        }, 30);
        return { code: 0 };
      }
    };
    const r = await runIsolatedLogin({
      authDir: h.authDir, journalFile: h.journalFile, tmpRoot: h.tmpRoot,
      log: collector(), env: baseEnv(), spawnLogin: sim.fn,
      probeService: async () => false, probeDesktop: () => false,
      harvestTimeoutMs: 2000, harvestPollMs: 10
    });
    assert.equal(r.ok, true);
    assert.equal(r.record.id, 'late-uid');

    // 始终半写 → 超时失败
    const h2 = withSandbox();
    try {
      const r2 = await runIsolatedLogin({
        authDir: h2.authDir, journalFile: h2.journalFile, tmpRoot: h2.tmpRoot,
        log: collector(), env: baseEnv(),
        spawnLogin: async ({ shadowDir }) => {
          const dir = computeCliAuthDir(shadowDir);
          fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(path.join(dir, CANON), '{"account":{');
          return { code: 0 };
        },
        probeService: async () => false, probeDesktop: () => false,
        harvestTimeoutMs: 80, harvestPollMs: 10
      });
      assert.equal(r2.failed, 'harvest-missing');
    } finally { h2.cleanup(); }
  } finally { h.cleanup(); }
});

test('H4/E1/E2：加密壳（单壳、asym-v1 壳、额外字段）→ 一等失败，不落盘', async () => {
  for (const shell of [1, 2]) {
    const h = withSandbox();
    try {
      const log = collector();
      const r = await runIsolatedLogin({
        authDir: h.authDir, journalFile: h.journalFile, tmpRoot: h.tmpRoot,
        log, env: baseEnv(),
        spawnLogin: async ({ shadowDir }) => {
          const dir = computeCliAuthDir(shadowDir);
          fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(path.join(dir, CANON), JSON.stringify(encState('enc-uid', shell)));
          return { code: 0 };
        },
        probeService: async () => false, probeDesktop: () => false,
        harvestTimeoutMs: 300, harvestPollMs: 10
      });
      assert.equal(r.failed, 'harvest-encrypted', `shell=${shell}`);
      assert.ok(log.has('加密'));
      assert.deepEqual(fs.readdirSync(h.accDir), []);
    } finally { h.cleanup(); }
  }
});

test('M3：token 为数字（invalid）→ 失败不落盘', async () => {
  const h = withSandbox();
  try {
    const r = await runIsolatedLogin({
      authDir: h.authDir, journalFile: h.journalFile, tmpRoot: h.tmpRoot,
      log: collector(), env: baseEnv(),
      spawnLogin: async ({ shadowDir }) => {
        const dir = computeCliAuthDir(shadowDir);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, CANON), JSON.stringify({ account: { uid: 'x' }, auth: { accessToken: 123 } }));
        return { code: 0 };
      },
      probeService: async () => false, probeDesktop: () => false,
      harvestTimeoutMs: 300, harvestPollMs: 10
    });
    assert.equal(r.failed, 'harvest-invalid');
    assert.deepEqual(fs.readdirSync(h.accDir), []);
  } finally { h.cleanup(); }
});

// ---------- H3/L2：relogin 校验与普通登录 ----------

test('H3：relogin 实际授权账号 ≠ 目标 uid → 中止，不写池', async () => {
  const h = withSandbox();
  try {
    const log = collector();
    const sim = makeLoginSim('other-uid');
    const r = await runIsolatedLogin({
      mode: 'relogin', uid: 'want-uid',
      authDir: h.authDir, journalFile: h.journalFile, tmpRoot: h.tmpRoot,
      log, env: baseEnv(), spawnLogin: sim.fn,
      probeService: async () => false, probeDesktop: () => false,
      harvestTimeoutMs: 300, harvestPollMs: 10
    });
    assert.equal(r.failed, 'uid-mismatch');
    assert.equal(r.landedUid, 'other-uid');
    assert.deepEqual(fs.readdirSync(h.accDir), []);
    assert.ok(log.has('不一致'));
  } finally { h.cleanup(); }
});

test('L2：plainLogin（同账号 relogin）——不做影子、允许真实 canonical 被刷新、成功入库', async () => {
  const h = withSandbox();
  try {
    fs.writeFileSync(path.join(h.authDir, CANON), JSON.stringify(plainState('same-uid', { expiresAt: Date.now() + 1000 })));
    const newState = plainState('same-uid', { expiresAt: Date.now() + 86_400_000 });
    const sim = {
      captured: {},
      fn: async ({ env }) => {
        sim.captured.env = env;
        // 模拟 CLI 轮换：旧 canonical 改名成快照，写新 canonical（同 uid）
        fs.renameSync(path.join(h.authDir, CANON), path.join(h.authDir, 'workbuddy-desktop.2026-10-14T01-00-00-000Z.1.snap.info'));
        fs.writeFileSync(path.join(h.authDir, CANON), JSON.stringify(newState));
        return { code: 0 };
      }
    };
    const r = await runIsolatedLogin({
      mode: 'relogin', uid: 'same-uid', plainLogin: true,
      authDir: h.authDir, journalFile: h.journalFile, tmpRoot: h.tmpRoot,
      log: collector(), env: baseEnv(), spawnLogin: sim.fn, harvestTimeoutMs: 300, harvestPollMs: 10
    });
    assert.equal(r.ok, true);
    assert.equal(r.record.id, 'same-uid');
    // 无影子键、原 canonical 未被恢复（普通登录允许刷新）
    assert.equal(sim.captured.env.USERPROFILE, undefined);
    const rec = JSON.parse(fs.readFileSync(path.join(h.accDir, 'same-uid.json'), 'utf8'));
    assert.ok(rec.expiresAt > Date.now() + 80_000_000);
    // journal/备份已清理
    assert.equal(fs.existsSync(h.journalFile), false);
  } finally { h.cleanup(); }
});

// ---------- M1/M2/B1：导入与边界 ----------

test('M1：定向导入只写目标 uid 一条，既有记录逐字节不变', async () => {
  const h = withSandbox();
  try {
    const a = JSON.stringify({ id: 'a', nickname: '甲', accessToken: 't-a', expiresAt: Date.now() + 86_400_000 }, null, 2);
    const b = JSON.stringify({ id: 'b', nickname: '乙', accessToken: 't-b', expiresAt: Date.now() + 86_400_000 }, null, 2);
    fs.writeFileSync(path.join(h.accDir, 'a.json'), a);
    fs.writeFileSync(path.join(h.accDir, 'b.json'), b);
    const sim = makeLoginSim('c-uid');
    const r = await runIsolatedLogin({
      authDir: h.authDir, journalFile: h.journalFile, tmpRoot: h.tmpRoot,
      log: collector(), env: baseEnv(), spawnLogin: sim.fn,
      probeService: async () => false, probeDesktop: () => false,
      harvestTimeoutMs: 300, harvestPollMs: 10
    });
    assert.equal(r.ok, true);
    assert.equal(fs.readFileSync(path.join(h.accDir, 'a.json'), 'utf8'), a);
    assert.equal(fs.readFileSync(path.join(h.accDir, 'b.json'), 'utf8'), b);
    assert.equal(JSON.parse(fs.readFileSync(path.join(h.accDir, 'c-uid.json'), 'utf8')).id, 'c-uid');
  } finally { h.cleanup(); }
});

test('M2：expiresAt 比较闸 —— 新凭据更旧 → 拒写并报错', async () => {
  const h = withSandbox();
  try {
    const existing = JSON.stringify({ id: 'dup', nickname: '旧', accessToken: 't-old', expiresAt: Date.now() + 500_000_000 }, null, 2);
    fs.writeFileSync(path.join(h.accDir, 'dup.json'), existing);
    const log = collector();
    const sim = makeLoginSim('dup', { expiresAt: Date.now() + 1000 });
    const r = await runIsolatedLogin({
      authDir: h.authDir, journalFile: h.journalFile, tmpRoot: h.tmpRoot,
      log, env: baseEnv(), spawnLogin: sim.fn,
      probeService: async () => false, probeDesktop: () => false,
      harvestTimeoutMs: 300, harvestPollMs: 10
    });
    assert.equal(r.failed, 'stale-expiry');
    assert.equal(fs.readFileSync(path.join(h.accDir, 'dup.json'), 'utf8'), existing);
    assert.ok(log.has('拒绝覆盖'));
  } finally { h.cleanup(); }
});

test('B1：备份文件不被 importFromAuthDir 误收（命名边界）', async () => {
  const h = withSandbox();
  try {
    fs.writeFileSync(path.join(h.authDir, `${CANON}.isolated-backup.bak`), JSON.stringify(plainState('bak-uid')));
    const r = importFromAuthDir({ dir: h.authDir });
    assert.equal(r.imported.length, 0);
    assert.deepEqual(fs.readdirSync(h.accDir), []);
  } finally { h.cleanup(); }
});

// ---------- R1：终检 ----------

test('R1：终检发现真实登录态被换成别的身份 → FAILED 不静默 + 恢复 + 新记录保留', async () => {
  const h = withSandbox();
  try {
    const oldBytes = JSON.stringify(plainState('old-uid'));
    fs.writeFileSync(path.join(h.authDir, CANON), oldBytes);
    const log = collector();
    const sim = {
      fn: async ({ shadowDir }) => {
        // 影子凭据 40ms 后写好（迫使 harvest 轮询）；15ms 时篡改真实 canonical
        // ——绕过 spawn 后的首查（t≈0），落到终检窗口（t≈40ms+）
        const dir = computeCliAuthDir(shadowDir);
        fs.mkdirSync(dir, { recursive: true });
        setTimeout(() => {
          fs.writeFileSync(path.join(h.authDir, CANON), JSON.stringify(plainState('intruder-uid')));
        }, 15);
        setTimeout(() => {
          fs.writeFileSync(path.join(dir, CANON), JSON.stringify(plainState('new-uid')));
        }, 40);
        return { code: 0 };
      }
    };
    const r = await runIsolatedLogin({
      authDir: h.authDir, journalFile: h.journalFile, tmpRoot: h.tmpRoot,
      log, env: baseEnv(), spawnLogin: sim.fn,
      probeService: async () => false, probeDesktop: () => false,
      harvestTimeoutMs: 3000, harvestPollMs: 10, driftPollMs: 100000
    });
    assert.equal(r.ok, false);
    assert.equal(r.failed, 'final-check');
    assert.equal(r.rescued, true);
    assert.equal(fs.readFileSync(path.join(h.authDir, CANON), 'utf8'), oldBytes);
    // 新账号已入库（harvest/导入在终检之前完成）
    assert.equal(r.record.id, 'new-uid');
    assert.deepEqual(fs.readdirSync(h.accDir), ['new-uid.json']);
    assert.ok(log.has('被改动'));
  } finally { h.cleanup(); }
});

// ---------- R3/R4/X2：自愈与 recover ----------

test('R3/X2：遗留 journal + canonical 消失（快照在）→ heal 自愈；幂等；recover 无遗留时不动作', () => {
  const h = withSandbox();
  try {
    const oldBytes = JSON.stringify(plainState('old-uid'));
    fs.writeFileSync(path.join(h.authDir, CANON), oldBytes);
    const pre = {
      entries: [CANON].sort(),
      canonical: {
        size: oldBytes.length,
        mtimeMs: Date.now() - 10000,
        sha256: crypto.createHash('sha256').update(oldBytes).digest('hex')
      }
    };
    // 现场：canonical 被改名成快照
    fs.renameSync(path.join(h.authDir, CANON), path.join(h.authDir, 'workbuddy-desktop.2026-10-14T02-00-00-000Z.5.x.info'));
    fs.writeFileSync(h.journalFile, JSON.stringify({
      v: 1, phase: 'spawn', mode: 'add', uid: null,
      startedAt: Date.now() - 5000,
      canonicalPath: path.join(h.authDir, CANON),
      backupPath: `${path.join(h.authDir, CANON)}.isolated-backup.bak`,
      pre
    }));
    const log = collector();
    const r1 = healIfNeeded({ authDir: h.authDir, journalFile: h.journalFile, log });
    assert.equal(r1.healed, true);
    assert.equal(r1.needsManual, false);
    assert.equal(fs.readFileSync(path.join(h.authDir, CANON), 'utf8'), oldBytes);
    assert.equal(fs.existsSync(h.journalFile), false);
    // 幂等：再跑一次无动作
    const r2 = healIfNeeded({ authDir: h.authDir, journalFile: h.journalFile, log: collector() });
    assert.equal(r2.healed, false);
    // recover：无遗留 → 明确「无需恢复」
    const log3 = collector();
    const r3 = runRecover({ authDir: h.authDir, journalFile: h.journalFile, log: log3 });
    assert.equal(r3.recovered, false);
    assert.ok(log3.has('无需恢复'));
  } finally { h.cleanup(); }
});

test('X2b：遗留 journal 但现场无威胁 → 直接清理（不误改）', () => {
  const h = withSandbox();
  try {
    const bytes = JSON.stringify(plainState('keep-uid'));
    fs.writeFileSync(path.join(h.authDir, CANON), bytes);
    fs.writeFileSync(h.journalFile, JSON.stringify({
      v: 1, phase: 'spawn', mode: 'add', uid: null, startedAt: Date.now() - 1000,
      canonicalPath: path.join(h.authDir, CANON), backupPath: null,
      pre: {
        entries: [CANON].sort(),
        canonical: {
          size: bytes.length,
          mtimeMs: fs.statSync(path.join(h.authDir, CANON)).mtimeMs,
          sha256: crypto.createHash('sha256').update(bytes).digest('hex')
        }
      }
    }));
    const log = collector();
    const r = healIfNeeded({ authDir: h.authDir, journalFile: h.journalFile, log });
    assert.equal(r.healed, true);
    assert.equal(fs.readFileSync(path.join(h.authDir, CANON), 'utf8'), bytes);
    assert.equal(fs.existsSync(h.journalFile), false);
  } finally { h.cleanup(); }
});

test('M-B4：起始无 canonical（新机器/已登出）→ 策略 A 允许，成功后真实目录仍无 canonical', async () => {
  const h = withSandbox();
  try {
    const sim = makeLoginSim('fresh-uid');
    const r = await runIsolatedLogin({
      authDir: h.authDir, journalFile: h.journalFile, tmpRoot: h.tmpRoot,
      log: collector(), env: baseEnv(), spawnLogin: sim.fn,
      probeService: async () => false, probeDesktop: () => false,
      harvestTimeoutMs: 300, harvestPollMs: 10
    });
    assert.equal(r.ok, true);
    assert.equal(r.record.id, 'fresh-uid');
    // 真实目录保持「未登录」起始态（策略 A 不动真实 store）
    assert.deepEqual(fs.readdirSync(h.authDir), []);
    assert.deepEqual(fs.readdirSync(h.accDir), ['fresh-uid.json']);
  } finally { h.cleanup(); }
});

// ---------- R2：信号守卫机制 ----------

test('R2：信号守卫 —— cleanup 执行一次 + 以 130/143 退出（可注入 exit）', () => {
  let cleaned = 0;
  const exits = [];
  const uninstall = installSignalGuards(() => { cleaned++; }, (code) => exits.push(code));
  process.emit('SIGINT');
  process.emit('SIGTERM');
  uninstall();
  assert.equal(cleaned, 2);
  assert.deepEqual(exits, [130, 143]);
  // 卸载后不再触发
  process.emit('SIGINT');
  assert.equal(cleaned, 2);
});

// ---------- X1：并发锁 ----------

test('X1：锁被活进程持有 → 拒绝；陈旧锁（死 pid）→ 接管继续', async () => {
  const h = withSandbox();
  try {
    const lock = `${h.journalFile}.lock`;
    fs.writeFileSync(lock, String(process.pid)); // 当前测试进程 = 存活
    const log1 = collector();
    const r1 = await runIsolatedLogin({
      authDir: h.authDir, journalFile: h.journalFile, tmpRoot: h.tmpRoot,
      log: log1, env: baseEnv(),
      spawnLogin: async () => ({ code: 0 }),
      probeService: async () => false, probeDesktop: () => false,
      harvestTimeoutMs: 60, harvestPollMs: 10
    });
    assert.equal(r1.failed, 'locked');
    assert.ok(log1.has('正在'));

    // 陈旧锁：一个几乎不可能存活的 pid
    fs.writeFileSync(lock, '999999');
    const sim = makeLoginSim('after-stale');
    const r2 = await runIsolatedLogin({
      authDir: h.authDir, journalFile: h.journalFile, tmpRoot: h.tmpRoot,
      log: collector(), env: baseEnv(), spawnLogin: sim.fn,
      probeService: async () => false, probeDesktop: () => false,
      harvestTimeoutMs: 300, harvestPollMs: 10
    });
    assert.equal(r2.ok, true);
    assert.equal(fs.existsSync(lock), false);
  } finally { h.cleanup(); }
});

// ---------- 对抗矩阵：drift 分类器/恢复 的状态空间组合 ----------

test('G1：同 uid 被外部刷新（桌面端续期）→ 保留新字节 + 提示，不误恢复', async () => {
  const h = withSandbox();
  try {
    const oldBytes = JSON.stringify(plainState('same-uid', { expiresAt: Date.now() + 1000 }));
    fs.writeFileSync(path.join(h.authDir, CANON), oldBytes);
    const refreshed = JSON.stringify(plainState('same-uid', { expiresAt: Date.now() + 86_400_000 }));
    const sim = {
      fn: async ({ shadowDir }) => {
        const dir = computeCliAuthDir(shadowDir);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, CANON), JSON.stringify(plainState('new-uid')));
        fs.writeFileSync(path.join(h.authDir, CANON), refreshed); // 同 uid 外部刷新
        return { code: 0 };
      }
    };
    const r = await runIsolatedLogin({
      authDir: h.authDir, journalFile: h.journalFile, tmpRoot: h.tmpRoot,
      log: collector(), env: baseEnv(), spawnLogin: sim.fn,
      probeService: async () => false, probeDesktop: () => false,
      harvestTimeoutMs: 300, harvestPollMs: 10
    });
    assert.equal(r.ok, true);
    assert.match(String(r.note), /外部刷新/);
    // 桌面端的续期结果被保留（未被备份回滚）
    assert.equal(fs.readFileSync(path.join(h.authDir, CANON), 'utf8'), refreshed);
  } finally { h.cleanup(); }
});

test('G2：新增登出标记（canonical 完好）→ 提示不中止，标记留在原处', async () => {
  const h = withSandbox();
  try {
    fs.writeFileSync(path.join(h.authDir, CANON), JSON.stringify(plainState('old-uid')));
    const sim = {
      fn: async ({ shadowDir }) => {
        const dir = computeCliAuthDir(shadowDir);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, CANON), JSON.stringify(plainState('new-uid')));
        fs.writeFileSync(path.join(h.authDir, `${CANON}.logged-out`), 'marker');
        return { code: 0 };
      }
    };
    const r = await runIsolatedLogin({
      authDir: h.authDir, journalFile: h.journalFile, tmpRoot: h.tmpRoot,
      log: collector(), env: baseEnv(), spawnLogin: sim.fn,
      probeService: async () => false, probeDesktop: () => false,
      harvestTimeoutMs: 300, harvestPollMs: 10
    });
    assert.equal(r.ok, true);
    assert.match(String(r.note), /新条目/);
    assert.ok(fs.existsSync(path.join(h.authDir, `${CANON}.logged-out`)));
  } finally { h.cleanup(); }
});

test('G3：canonical 被改名（无新 canonical）→ 恢复 = 快照改名回', async () => {
  const h = withSandbox();
  try {
    const oldBytes = JSON.stringify(plainState('old-uid'));
    fs.writeFileSync(path.join(h.authDir, CANON), oldBytes);
    const sim = {
      fn: async () => {
        fs.renameSync(path.join(h.authDir, CANON), path.join(h.authDir, 'workbuddy-desktop.2026-10-14T03-00-00-000Z.7.y.info'));
        return { code: 0 };
      }
    };
    const r = await runIsolatedLogin({
      authDir: h.authDir, journalFile: h.journalFile, tmpRoot: h.tmpRoot,
      log: collector(), env: baseEnv(), spawnLogin: sim.fn,
      probeService: async () => false, probeDesktop: () => false,
      harvestTimeoutMs: 300, harvestPollMs: 10
    });
    assert.equal(r.failed, 'drift');
    assert.equal(r.rescued, true);
    assert.equal(fs.readFileSync(path.join(h.authDir, CANON), 'utf8'), oldBytes);
    assert.deepEqual(fs.readdirSync(h.authDir), [CANON]);
  } finally { h.cleanup(); }
});

test('G4：canonical 被删除（无快照）→ 恢复 = 字节备份写回', async () => {
  const h = withSandbox();
  try {
    const oldBytes = JSON.stringify(plainState('old-uid'));
    fs.writeFileSync(path.join(h.authDir, CANON), oldBytes);
    const sim = {
      fn: async () => { fs.rmSync(path.join(h.authDir, CANON), { force: true }); return { code: 0 }; }
    };
    const r = await runIsolatedLogin({
      authDir: h.authDir, journalFile: h.journalFile, tmpRoot: h.tmpRoot,
      log: collector(), env: baseEnv(), spawnLogin: sim.fn,
      probeService: async () => false, probeDesktop: () => false,
      harvestTimeoutMs: 300, harvestPollMs: 10
    });
    assert.equal(r.failed, 'drift');
    assert.equal(r.rescued, true);
    assert.equal(fs.readFileSync(path.join(h.authDir, CANON), 'utf8'), oldBytes);
  } finally { h.cleanup(); }
});

test('P2：双路径推导分歧（无注入 authDir + 重定向 USERPROFILE）→ 中止并打印两者', async () => {
  const h = withSandbox();
  try {
    const log = collector();
    const r = await runIsolatedLogin({
      // 不注入 authDir → 触发真实模式的双路径断言（只读真实目录做快照，不写）
      journalFile: h.journalFile, tmpRoot: h.tmpRoot,
      log, env: { ...baseEnv(), USERPROFILE: 'C:/b2a-bogus-nowhere' },
      spawnLogin: async () => { throw new Error('不应 spawn'); },
      probeService: async () => false, probeDesktop: () => false
    });
    assert.equal(r.failed, 'path-mismatch');
    assert.ok(log.has('双重推导分歧'));
    assert.ok(r.paths.app && r.paths.cli && r.paths.app !== r.paths.cli);
  } finally { h.cleanup(); }
});

test('P4b：无 cliPath 且用默认 spawn → 明确中止（no-cli）', async () => {
  const h = withSandbox();
  try {
    const log = collector();
    const r = await runIsolatedLogin({
      authDir: h.authDir, journalFile: h.journalFile, tmpRoot: h.tmpRoot,
      log, env: baseEnv(),
      probeService: async () => false, probeDesktop: () => false
    });
    assert.equal(r.failed, 'no-cli');
    assert.ok(log.has('找不到'));
  } finally { h.cleanup(); }
});

test('R1b：信号窗口 end-state（journal+备份+canonical 被删）→ heal 经备份写回恢复', () => {
  const h = withSandbox();
  try {
    const oldBytes = JSON.stringify(plainState('old-uid'));
    const backupPath = `${path.join(h.authDir, CANON)}.isolated-backup.bak`;
    fs.writeFileSync(backupPath, oldBytes); // 备份在（信号前建立）
    // canonical 已被 rogue CLI 删除（信号落在救援执行前）
    fs.writeFileSync(h.journalFile, JSON.stringify({
      v: 1, phase: 'spawned', mode: 'add', uid: null, startedAt: Date.now() - 3000,
      canonicalPath: path.join(h.authDir, CANON), backupPath, shadowDir: null,
      pre: {
        entries: [CANON].sort(),
        canonical: { size: oldBytes.length, mtimeMs: Date.now() - 9000, sha256: crypto.createHash('sha256').update(oldBytes).digest('hex'), uid: 'old-uid' }
      }
    }));
    const log = collector();
    const r = healIfNeeded({ authDir: h.authDir, journalFile: h.journalFile, log });
    assert.equal(r.healed, true);
    assert.equal(fs.readFileSync(path.join(h.authDir, CANON), 'utf8'), oldBytes);
    assert.equal(fs.existsSync(h.journalFile), false);
    assert.equal(fs.existsSync(backupPath), false);
    assert.ok(log.has('已恢复'));
  } finally { h.cleanup(); }
});

test('R7：journal 文件存在但损坏 → needsManual（响亮），不静默跳过', () => {
  const h = withSandbox();
  try {
    fs.writeFileSync(h.journalFile, '{broken');
    const log = collector();
    const r = healIfNeeded({ authDir: h.authDir, journalFile: h.journalFile, log });
    assert.equal(r.needsManual, true);
    assert.ok(log.has('损坏'));
    // 文件保留供人工核查
    assert.ok(fs.existsSync(h.journalFile));
  } finally { h.cleanup(); }
});

test('R5：heal 提示走 stderr —— `list --json` stdout 保持纯 JSON', () => {
  const h = withSandbox();
  try {
    const bytes = JSON.stringify(plainState('keep-uid'));
    fs.writeFileSync(path.join(h.authDir, CANON), bytes);
    // 预置一条账号记录（池非空才会走 --json 分支）
    fs.writeFileSync(path.join(h.accDir, 'seed.json'), JSON.stringify({ id: 'seed', nickname: 's', accessToken: 't', expiresAt: Date.now() + 86_400_000 }));
    // 有「提示级」遗留（新快照条目）→ heal 会输出一行提示
    fs.writeFileSync(path.join(h.authDir, 'workbuddy-desktop.2026-10-14T04-00-00-000Z.9.new.info'), JSON.stringify(plainState('x')));
    fs.writeFileSync(h.journalFile, JSON.stringify({
      v: 1, phase: 'spawned', mode: 'add', uid: null, startedAt: Date.now() - 1000,
      canonicalPath: path.join(h.authDir, CANON), backupPath: null, shadowDir: null,
      pre: {
        entries: [CANON].sort(),
        canonical: { size: bytes.length, mtimeMs: 0, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), uid: 'keep-uid' }
      }
    }));
    const accountsJs = path.join(projectRoot, 'scripts', 'accounts.js');
    const env = {
      ...process.env,
      BUDDY2API_ACCOUNTS_DIR: h.accDir,
      BUDDY2API_ISOLATED_JOURNAL: h.journalFile
    };
    const r = spawnSync(process.execPath, [accountsJs, 'list', '--json', '--no-probe'], { encoding: 'utf8', env, timeout: 30000 });
    assert.equal(r.status, 0);
    const parsed = JSON.parse(r.stdout); // stdout 必须可整体解析
    assert.ok(Array.isArray(parsed.accounts));
    assert.match(r.stderr, /提示/); // 提示行在 stderr
  } finally { h.cleanup(); }
});

// ---------- L1：CLI 接线（子进程冒烟） ----------

test('L1/W：accounts.js relogin 未知 uid → exit 1 且不触发登录；recover 无遗留 →「无需恢复」', () => {
  const h = withSandbox();
  try {
    const env = {
      ...process.env,
      BUDDY2API_ACCOUNTS_DIR: h.accDir,
      BUDDY2API_ISOLATED_JOURNAL: h.journalFile
    };
    const accountsJs = path.join(projectRoot, 'scripts', 'accounts.js');
    const r1 = spawnSync(process.execPath, [accountsJs, 'relogin', 'no-such-uid'], { encoding: 'utf8', env, timeout: 30000 });
    assert.equal(r1.status, 1);
    assert.match(r1.stderr, /未找到/);
    const r2 = spawnSync(process.execPath, [accountsJs, 'recover'], { encoding: 'utf8', env, timeout: 30000 });
    assert.equal(r2.status, 0);
    assert.match(r2.stdout, /无需恢复/);
  } finally { h.cleanup(); }
});

// ---------- 路径公式（F22 辅助） ----------

test('computeCliAuthDir：与平台同构（win32 基准）', () => {
  const d = computeCliAuthDir('C:/home');
  if (process.platform === 'win32') {
    assert.equal(d, path.join('C:/home', 'AppData', 'Local', 'CodeBuddyExtension', 'Data', 'Public', 'auth'));
  } else {
    assert.ok(d.includes('CodeBuddyExtension'));
  }
});

/**
 * isolated-login.js — 隔离登录：不登出任何已有账号的登录路径（多账号并存）。
 *
 * 背景（vendor CLI 机制实证，见任务 evidence/spike-shadow-env.md）：
 *   CLI 的登录凭据 store 由 `os.homedir()` 推导（读写同源）：
 *     <homedir>/AppData/Local/CodeBuddyExtension/Data/Public/auth/workbuddy-desktop.info
 *   （win32；darwin/linux 同构换基准）。因此给它换一个影子 USERPROFILE/HOME，
 *   它的整棵 store 就落在影子目录里 —— 真实登录态全程不动。
 *
 * 主流程（策略 A：影子环境登录）：
 *   preflight（拒绝项/提示项）→ journal + 备份 → spawn CLI（影子 env，stdio 继承）
 *   → drift 守卫（轮询真实 auth 目录）→ harvest（影子 canonical 字面路径）
 *   → 定向导入（只写目标 uid 一条）→ 终检（真实 canonical 逐字节不变）→ 清理
 *
 * 安全约定（评审 F2/F5/F10/F22/F24 等处置，见 evidence/brainstorm-review.md）：
 *   - harvest 只读**字面路径**，永不走 authStatePath() 的快照回退（旧快照伪装新凭据）。
 *   - 凭据校验复用 credentialOf/toAccountRecord 单点；导入前做 expiresAt 比较闸。
 *   - 真实 canonical 有任何「身份被换/消失」迹象 → 中止 + 恢复 + 响亮失败；
 *     「同 uid 被外部刷新」（如桌面端）→ 保留新字节并提示，不覆盖。
 *   - 备份命名避开 importFromAuthDir / authStatePath 两个既有过滤器（不以 .info 结尾）。
 *
 * 参数注入面（评审 F25）：authDir / tmpRoot / journalFile / spawnLogin / env /
 *   probeService / probeDesktop 均可注入 —— 单测走沙盒，不碰真实目录、不真拉 CLI。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { authDir as realAuthDir, parseAuthState, credentialOf, strOrNull } from '../src/auth-credentials.js';
import { toAccountRecord, saveAccount, getAccount, listAccounts } from '../src/account-store.js';

const projectRoot = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..');

/** 备份后缀：避开 `*.info`（importFromAuthDir）与 `workbuddy-desktop.*.info`（快照回退）两个过滤器 */
const BACKUP_SUFFIX = '.isolated-backup.bak';
const CANONICAL_NAME = 'workbuddy-desktop.info';

/** 从任意 homedir 基准推导 CLI 侧 auth 目录（与 CLI 侧 FilePathService 同构）。 */
export function computeCliAuthDir(homedir) {
  if (process.platform === 'win32') {
    return path.join(homedir, 'AppData', 'Local', 'CodeBuddyExtension', 'Data', 'Public', 'auth');
  }
  if (process.platform === 'darwin') {
    return path.join(homedir, 'Library', 'Application Support', 'CodeBuddyExtension', 'Data', 'Public', 'auth');
  }
  return path.join(homedir, '.local', 'share', 'CodeBuddyExtension', 'Data', 'Public', 'auth');
}

/** journal 文件路径（可用 BUDDY2API_ISOLATED_JOURNAL 覆盖，测试用） */
export function journalPath() {
  return process.env.BUDDY2API_ISOLATED_JOURNAL || path.join(projectRoot, 'data', 'isolated-login.journal.json');
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/** 单文件指纹：不存在返回 null */
function fingerprintOf(file) {
  try {
    const st = fs.statSync(file);
    return { size: st.size, mtimeMs: st.mtimeMs, sha256: sha256(fs.readFileSync(file)) };
  } catch {
    return null;
  }
}

/** auth 目录快照：条目名列表（排序）+ canonical 指纹（含 uid，供「同账号刷新 vs 换身份」判定） */
function snapshotDir(dir, canonicalName = CANONICAL_NAME) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir).sort();
  } catch { /* 目录不存在 → 空 */ }
  const canonicalPath = path.join(dir, canonicalName);
  const fp = fingerprintOf(canonicalPath);
  return { entries, canonical: fp ? { ...fp, uid: uidOf(canonicalPath) } : null };
}

/** 快照里出现的新条目（相对 pre.entries） */
function newEntries(current, pre) {
  const before = new Set(pre.entries);
  return current.entries.filter((n) => !before.has(n));
}

function isRotatedSnapshot(name) {
  return name.startsWith('workbuddy-desktop.') && name.endsWith('.info');
}
function isLogoutMarker(name) {
  return name.endsWith('.logged-out');
}

/** 读一个登录态文件的 uid（只取 account.uid；解析失败返回 null） */
function uidOf(file) {
  try {
    const state = parseAuthState(fs.readFileSync(file, 'utf8'));
    return strOrNull(state.account?.uid);
  } catch {
    return null;
  }
}

/** journal 原子写 */
function writeJournal(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

function readJournal(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** 影子目录路径校验（journal 可被篡改——只允许删除 os.tmpdir 下本工具命名的目录） */
function isOwnShadowDir(p) {
  try {
    if (typeof p !== 'string' || !p) return false;
    const resolved = path.resolve(p);
    const tmpRoot = path.resolve(os.tmpdir());
    return path.dirname(resolved) === tmpRoot && path.basename(resolved).startsWith('b2a-isolated-');
  } catch {
    return false;
  }
}

/** 清理 journal + 备份 +（可选）影子目录（best-effort；影子路径经安全校验） */
function cleanupArtifacts(file, backupPath, shadowDir) {
  try { fs.rmSync(file, { force: true }); } catch { /* ignore */ }
  try { fs.rmSync(`${file}.tmp`, { force: true }); } catch { /* ignore */ }
  if (backupPath) { try { fs.rmSync(backupPath, { force: true }); } catch { /* ignore */ } }
  if (shadowDir && isOwnShadowDir(shadowDir)) {
    try { fs.rmSync(shadowDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

/** 互斥锁：独占创建（O_EXCL）+ pid 存活校验；陈旧锁（持有进程已死）自动接管 */
function acquireLock(file) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(file, 'wx');
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      return true;
    } catch (e) {
      if (e.code !== 'EEXIST') return false;
      let owner = 0;
      try { owner = Number(fs.readFileSync(file, 'utf8')) || 0; } catch { /* ignore */ }
      if (owner) {
        try {
          process.kill(owner, 0);
          return false; // 持有者存活（含本进程重入）→ 拒绝
        } catch { /* 持有者已死 → 清陈旧锁重试 */ }
      }
      try { fs.rmSync(file, { force: true }); } catch { /* ignore */ }
    }
  }
  return false;
}
function releaseLock(file) {
  try { fs.rmSync(file, { force: true }); } catch { /* ignore */ }
}

/**
 * 信号守卫（F6）：Ctrl+C/终止信号到达时执行清理再退出。
 * 注意：process 信号监听器不携带信号名参数——必须逐信号绑定（process.emit 测试同语义）。
 * @param {Function} cleanup 清理动作（best-effort）
 * @param {Function} [exit] 注入退出动作（测试用）
 */
export function installSignalGuards(cleanup, exit = (code) => process.exit(code)) {
  const make = (code) => () => {
    try { cleanup(); } catch { /* ignore */ }
    exit(code);
  };
  const onInt = make(130);
  const onTerm = make(143);
  process.on('SIGINT', onInt);
  process.on('SIGTERM', onTerm);
  return () => {
    process.removeListener('SIGINT', onInt);
    process.removeListener('SIGTERM', onTerm);
  };
}

/**
 * drift 判定：真实 auth 目录相对 pre 是否出现「身份威胁」或「提示级」变化。
 * 威胁 = canonical 消失 / 被换成不可解析内容（同 uid 的外部刷新不算威胁）。
 */
function classifyRealState({ authDir, canonical, pre }) {
  const nowSnap = snapshotDir(authDir);
  const added = newEntries(nowSnap, pre);
  const preExisted = pre.canonical !== null;
  const cur = nowSnap.canonical;

  if (preExisted && !cur) {
    return { threat: true, warn: '真实登录态文件消失', detail: { added } };
  }
  if (preExisted && cur && cur.sha256 !== pre.canonical.sha256) {
    const uidNow = uidOf(canonical);
    // 同账号刷新（如桌面端续期）→ 保留新字节；uid 变了或不可解析 → 身份威胁
    if (uidNow && pre.canonical.uid && uidNow === pre.canonical.uid) {
      return { threat: false, warn: '真实登录态被外部刷新（同账号，保留新内容）', detail: { added, uidNow } };
    }
    return { threat: true, warn: '真实登录态被改写为其他身份（或不可解析）', detail: { added, uidNow } };
  }
  if (!preExisted && cur) {
    return { threat: false, warn: '真实登录态在流程期间出现（非本流程写入，未处理）', detail: { added } };
  }
  const suspicious = added.filter((n) => isRotatedSnapshot(n) || isLogoutMarker(n));
  if (suspicious.length > 0) {
    return { threat: false, warn: `auth 目录出现新条目（凭据身份未受影响）：${suspicious.join('、')}`, detail: { added } };
  }
  return { threat: false, warn: null, detail: { added } };
}

/** 清理相对 pre 新增的轮换快照/登出标记（exact-pre-state 还原用）；keep 为需保留的文件名集合 */
function sweepNewArtifacts(authDir, pre, keep = new Set()) {
  const actions = [];
  for (const n of newEntries(snapshotDir(authDir), pre)) {
    if (keep.has(n)) continue;
    if (isRotatedSnapshot(n) || isLogoutMarker(n)) {
      try {
        fs.rmSync(path.join(authDir, n), { force: true });
        actions.push(`清理新增条目 ${n}`);
      } catch { /* ignore */ }
    }
  }
  return actions;
}

/**
 * 真实 auth 目录的「身份威胁」救援：仅在 canonical 消失/被换成别的身份时调用。
 * 不做删除型操作的范围限定在 rogue 产物（轮换快照/登出标记）；起始无 canonical、
 * 期间出现的情形只报告不处理。
 *
 * @returns {{rescued: boolean, actions: string[]}}
 */
function rescueRealState({ authDir, canonical, pre, startedAt, backupPath }) {
  const actions = [];
  const preExisted = pre.canonical !== null;
  const cur = fingerprintOf(canonical);

  if (preExisted && !cur) {
    // canonical 消失：优先把 CLI 新轮换出的快照改回来，否则写回备份
    const snaps = newEntries(snapshotDir(authDir), pre)
      .filter((n) => isRotatedSnapshot(n))
      .map((n) => path.join(authDir, n))
      .filter((f) => { try { return fs.statSync(f).mtimeMs >= startedAt; } catch { return false; } })
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    if (snaps.length > 0) {
      fs.renameSync(snaps[0], canonical);
      actions.push(`快照改名还原 → ${path.basename(canonical)}`);
      actions.push(...sweepNewArtifacts(authDir, pre, new Set([path.basename(snaps[0])])));
    } else if (backupPath && fs.existsSync(backupPath)) {
      fs.copyFileSync(backupPath, canonical);
      actions.push('字节备份写回 canonical');
      actions.push(...sweepNewArtifacts(authDir, pre));
    } else {
      return { rescued: false, actions };
    }
  } else if (preExisted && cur) {
    if (!backupPath || !fs.existsSync(backupPath)) return { rescued: false, actions };
    fs.copyFileSync(backupPath, canonical);
    actions.push('字节备份写回 canonical（内容被改写）');
    actions.push(...sweepNewArtifacts(authDir, pre));
  } else if (!preExisted && cur) {
    return { rescued: false, actions: ['起始无登录态、期间出现（未处理，请人工确认）'] };
  }
  return { rescued: actions.length > 0 && !actions[0].includes('未处理'), actions };
}

/**
 * 启动自愈：检测遗留 journal 并按 pre 快照比对真实现场；能救则救，然后清 journal。
 * 任意 accounts.js 命令启动时调用（幂等；无 journal 时零成本）。
 *
 * @returns {{healed: boolean, actions: string[], needsManual: boolean}}
 */
export function healIfNeeded({ authDir: authDirOpt, journalFile, log = () => {} } = {}) {
  const dir = authDirOpt ?? realAuthDir();
  const file = journalFile ?? journalPath();
  if (!fs.existsSync(file)) return { healed: false, actions: [], needsManual: false };
  const j = readJournal(file);
  if (!j) {
    // 文件在但不可解析（外部损坏/磁盘异常）：静默跳过会把旧 pre 字节的唯一副本
    // 让给下一次覆盖（CR R7）——按需人工处理
    log(`❌ 遗留的隔离登录记录损坏、无法解析：${file}；备份（如有）保留，请人工核查。`);
    return { healed: false, actions: ['journal-unparseable'], needsManual: true };
  }

  const canonical = j.canonicalPath || path.join(dir, CANONICAL_NAME);
  const pre = j.pre || { entries: [], canonical: null };
  const cls = classifyRealState({ authDir: dir, canonical, pre });

  if (cls.threat) {
    const r = rescueRealState({ authDir: dir, canonical, pre, startedAt: j.startedAt || 0, backupPath: j.backupPath });
    if (r.rescued) {
      cleanupArtifacts(file, j.backupPath, j.shadowDir);
      log(`⚠️  检测到上次隔离登录未正常收尾，已恢复真实登录态（${r.actions.join('；')}）。`);
      return { healed: true, actions: r.actions, needsManual: false };
    }
    log(`❌ 上次隔离登录留下未修复的现场（${cls.warn}）；journal 与备份已保留供人工核查。`);
    return { healed: false, actions: r.actions, needsManual: true };
  }

  cleanupArtifacts(file, j.backupPath, j.shadowDir);
  if (cls.warn) log(`ℹ️  上次隔离登录的提示：${cls.warn}`);
  return { healed: true, actions: ['清理遗留 journal（现场无威胁）'], needsManual: false };
}

/** 显式恢复入口（accounts.js recover） */
export function runRecover({ authDir: authDirOpt, journalFile, log = console.log } = {}) {
  const dir = authDirOpt ?? realAuthDir();
  const file = journalFile ?? journalPath();
  const j = readJournal(file);
  if (!j) {
    log('✅ 无需恢复（没有遗留的隔离登录记录）。');
    return { recovered: false };
  }
  const r = healIfNeeded({ authDir: dir, journalFile: file, log });
  if (r.needsManual) {
    log(`   遗留现场：journal=${file}`);
    log(`   备份：${j.backupPath || '(无)'}`);
    log('   处理建议：确认 canonical 内容与目录内快照后，将备份改名为 workbuddy-desktop.info，或重新登录。');
  } else if (r.healed) {
    log(`   journal 已清理；动作：${r.actions.join('；') || '无'}`);
  }
  return { recovered: r.healed, ...r };
}

/** 默认 spawn：交互式 CLI（stdio 继承），返回退出码；onChild 供 drift 中止时 kill */
function defaultSpawnLogin({ env, cliPath, cwd, onChild }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cliPath], { cwd, stdio: 'inherit', env });
    onChild?.(child);
    child.on('exit', (code) => resolve({ code: code ?? 0 }));
    child.on('error', (e) => resolve({ code: -1, error: e }));
  });
}

/** 子环境构造：剥离凭据类变量（F23）+ 剥离 CODEBUDDY_CONFIG_DIR（全影子，CR R3）+ 策略 A 影子三键 */
export function buildChildEnv(baseEnv, shadowDir) {
  const env = { ...baseEnv };
  delete env.CODEBUDDY_AUTH_TOKEN;
  delete env.CODEBUDDY_API_KEY;
  delete env.CODEBUDDY_CONFIG_DIR;
  for (const k of Object.keys(env)) {
    if (k.startsWith('ACC_PRODUCT_CONFIG')) delete env[k];
  }
  if (shadowDir) {
    env.USERPROFILE = shadowDir;
    env.HOME = shadowDir;
    env.LOCALAPPDATA = path.join(shadowDir, 'AppData', 'Local');
  }
  return env;
}

/** 探测服务是否在跑（GET / 期待 200；2s 超时；可注入） */
function probeServiceDefault(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/', timeout: 2000 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

/** 探测桌面端进程（advisory；win32 tasklist；可注入） */
export function probeDesktopDefault() {
  try {
    if (process.platform !== 'win32') return false;
    const out = spawnSync('tasklist', ['/FI', 'IMAGENAME eq WorkBuddy.exe', '/NH'], { encoding: 'utf8', timeout: 3000 });
    return /workbuddy\.exe/i.test(out.stdout || '');
  } catch {
    return false;
  }
}

/** 从 CLI 二进制位置读 product.json 的 authentication.id（不存在返回 null） */
function readProductAuthId(cliPath) {
  try {
    const pj = path.join(path.dirname(cliPath), '..', 'product.json');
    const j = JSON.parse(fs.readFileSync(pj, 'utf8'));
    return strOrNull(j?.authentication?.id);
  } catch {
    return null;
  }
}

/**
 * 隔离登录主流程（策略 A）。
 *
 * @param {object} opts
 * @param {'add'|'relogin'} [opts.mode='add']
 * @param {string} [opts.uid] relogin 目标 uid（校验用）
 * @param {string} [opts.authDir] 注入：真实 auth 目录（测试用；不注入时走平台推导 + 双路径断言）
 * @param {string} [opts.tmpRoot] 注入：影子目录根（测试用）
 * @param {string} [opts.journalFile] 注入：journal 路径
 * @param {Function} [opts.spawnLogin] 注入：模拟登录（不真拉 CLI）
 * @param {string} [opts.cliPath] 注入：CLI 二进制路径
 * @param {boolean} [opts.plainLogin] 内部：普通登录模式（relogin 同账号，跳过影子）
 * @param {Function} [opts.log]
 * @param {object} [opts.env] 注入：进程环境（测试用）
 * @param {Function} [opts.probeService] / [opts.probeDesktop] 注入
 * @param {number} [opts.harvestTimeoutMs=10000] / [opts.harvestPollMs=500] / [opts.driftPollMs=1000]
 * @param {number} [opts.now] 注入时钟
 */
export async function runIsolatedLogin(opts = {}) {
  const {
    mode = 'add',
    uid = null,
    journalFile = journalPath(),
    spawnLogin = defaultSpawnLogin,
    log = console.log,
    env = process.env,
    probeService = probeServiceDefault,
    probeDesktop = probeDesktopDefault,
    harvestTimeoutMs = 10000,
    harvestPollMs = 500,
    driftPollMs = 1000,
    now = Date.now
  } = opts;
  const injectedAuthDir = opts.authDir ?? null;
  const t0 = now();

  // ---------- 0) 自愈遗留现场 ----------
  const heal = healIfNeeded({ authDir: injectedAuthDir ?? undefined, journalFile, log });
  if (heal.needsManual) {
    return { ok: false, failed: 'needs-manual', actions: heal.actions };
  }

  const authDirReal = injectedAuthDir ?? realAuthDir();
  const canonical = path.join(authDirReal, CANONICAL_NAME);
  const backupPath = `${canonical}${BACKUP_SUFFIX}`;
  const pre = snapshotDir(authDirReal);

  // ---------- 1) preflight ----------
  if (env.CODEBUDDY_AUTH_FILE) {
    log('❌ 检测到环境变量 CODEBUDDY_AUTH_FILE 已设置——它会劫持登录态定位，隔离登录不可靠。');
    log('   请先取消该变量后重试（set CODEBUDDY_AUTH_FILE= 或从系统环境中移除）。');
    return { ok: false, failed: 'env-auth-file' };
  }
  if (!injectedAuthDir) {
    const cliFormula = computeCliAuthDir(env.USERPROFILE || os.homedir());
    if (path.resolve(cliFormula) !== path.resolve(authDirReal)) {
      log('❌ 登录态目录存在双重推导分歧（buddy2api 与 CLI 的基准不一致），拒绝执行以免操作错目录：');
      log(`   本工具：${authDirReal}`);
      log(`   CLI 公式：${cliFormula}`);
      return { ok: false, failed: 'path-mismatch', paths: { app: authDirReal, cli: cliFormula } };
    }
  }
  const cliPath = opts.cliPath ?? null;
  if (!cliPath && spawnLogin === defaultSpawnLogin) {
    log('❌ 未提供 CLI 路径（找不到 codebuddy CLI）。请检查 vendor/ 或设置 CODEBUDDY_CLI_PATH。');
    return { ok: false, failed: 'no-cli' };
  }
  if (cliPath) {
    const productId = readProductAuthId(cliPath);
    if (productId && productId !== 'workbuddy-desktop') {
      log(`❌ 所用 CLI 的 product.json authentication.id = "${productId}"，与预期 "workbuddy-desktop" 不符，拒绝执行。`);
      return { ok: false, failed: 'product-id', productId };
    }
    if (!productId) log('⚠️  未能读取 CLI 的 product.json（跳过 id 校验）。');
  }
  // custom-token 指示器：影子环境 + 子环境剥离已中和其影响，仅提示
  const indicators = ['CODEBUDDY_AUTH_TOKEN', 'CODEBUDDY_API_KEY'].filter((k) => env[k]);
  if (indicators.length > 0) {
    log(`ℹ️  检测到凭据类环境变量（${indicators.join('、')}）——隔离登录的子进程会剥离它们，不影响本流程。`);
  }
  if (env.CODEBUDDY_CONFIG_DIR) {
    log('ℹ️  检测到 CODEBUDDY_CONFIG_DIR 已设置——子进程会剥离它以保持全影子（配置面不落真实目录）。');
  }
  if (!opts.plainLogin) {
    try {
      const running = await probeService(Number(env.PORT) || 8000);
      if (running && listAccounts().length === 0) {
        log('ℹ️  检测到 buddy2api 服务正在运行且账号池为空：若其期间重启后端，可能短暂回读旧登录态。');
        log('   建议先停服再执行本流程（node scripts/service.js stop）。');
      }
    } catch { /* 探测失败不阻断 */ }
    try {
      if (probeDesktop()) {
        log('ℹ️  检测到 WorkBuddy 桌面端在运行：本流程不会改动真实登录态，桌面端可保持运行；');
        log('   仅当流程异常时建议关闭桌面端后重试。');
      }
    } catch { /* ignore */ }
  }

  // ---------- 2) 互斥锁 + journal + 备份（影子目录先行——journal 记录它供信号/自愈兜底清理） ----------
  const lockFile = `${journalFile}.lock`;
  if (!acquireLock(lockFile)) {
    log('❌ 另一个隔离登录正在进行中（或上次异常退出留下的锁仍在）——请稍后重试。');
    log(`   若确认当前没有其他登录在进行，可删除锁文件后重试：${lockFile}`);
    return { ok: false, failed: 'locked' };
  }
  const shadowDir = opts.plainLogin ? null : fs.mkdtempSync(path.join(opts.tmpRoot ?? os.tmpdir(), 'b2a-isolated-'));
  const preExisted = pre.canonical !== null;
  writeJournal(journalFile, {
    v: 1,
    phase: 'spawned',
    mode: opts.plainLogin ? 'relogin-plain' : mode,
    uid,
    startedAt: t0,
    canonicalPath: canonical,
    backupPath: preExisted ? backupPath : null,
    shadowDir,
    pre
  });
  if (preExisted) {
    fs.copyFileSync(canonical, backupPath);
    try { fs.chmodSync(backupPath, 0o600); } catch { /* Windows best-effort */ }
  }

  // ---------- 3) spawn（影子环境）+ drift 守卫 ----------
  const childEnv = buildChildEnv(env, shadowDir);
  let drift = { threat: false, warn: null };
  let childHandle = null;
  let timer = null;
  let uninstallSignals = () => {};
  if (!opts.plainLogin) {
    timer = setInterval(() => {
      const cls = classifyRealState({ authDir: authDirReal, canonical, pre });
      if (cls.threat) {
        drift = cls;
        try { childHandle?.kill(); } catch { /* ignore */ }
      } else if (cls.warn && !drift.warn) {
        drift = { threat: false, warn: cls.warn };
      }
    }, driftPollMs);
    timer.unref?.();
  }
  // 信号守卫（F6）：中断时 kill 子进程 + 删影子 + 释放锁。**不删 journal/备份**——
  // 信号可能落在 drift 窗口（威胁已发生但救援未执行），此时备份是唯一恢复源；
  // 交由下次任意命令的 heal 判定（无威胁静默清理 / 有威胁自动救援）（CR R1）。
  if (opts.signalGuards !== false) {
    uninstallSignals = installSignalGuards(() => {
      try { childHandle?.kill(); } catch { /* ignore */ }
      if (shadowDir) { try { fs.rmSync(shadowDir, { recursive: true, force: true }); } catch { /* ignore */ } }
      releaseLock(lockFile);
    });
  }

  let exitInfo = { code: 0 };
  try {
    exitInfo = await spawnLogin({
      env: childEnv,
      shadowDir,
      cliPath,
      cwd: projectRoot,
      onChild: (c) => { childHandle = c; }
    });
  } catch (e) {
    exitInfo = { code: -1, error: e };
  } finally {
    if (timer) clearInterval(timer);
  }

  const finalize = (res) => {
    // 影子目录必删（内含新账号明文凭据，F13）；journal/备份按 keepJournal 决定去留；锁必释放
    uninstallSignals();
    if (shadowDir) { try { fs.rmSync(shadowDir, { recursive: true, force: true }); } catch { /* ignore */ } }
    if (!res.keepJournal) cleanupArtifacts(journalFile, preExisted ? backupPath : null);
    releaseLock(lockFile);
    return res;
  };

  // spawn 后立即补一次判定（间隔轮询可能尚未触发）+ 二次桌面端检测（F4）
  if (!opts.plainLogin) {
    const cls = classifyRealState({ authDir: authDirReal, canonical, pre });
    if (cls.threat) drift = cls;
    else if (cls.warn && !drift.warn) drift = cls;
    try {
      if (probeDesktop()) log('ℹ️  登录期间检测到 WorkBuddy 桌面端在运行（本流程不改动真实登录态）。');
    } catch { /* ignore */ }
  }

  if (drift.threat) {
    const r = rescueRealState({ authDir: authDirReal, canonical, pre, startedAt: t0, backupPath });
    log(`❌ 检测到真实登录态被意外改动（${drift.warn}）——CLI 行为与预期不符（可能已升级）。`);
    if (r.rescued) log(`   已恢复：${r.actions.join('；')}`);
    else log('   ⚠️ 未能自动恢复，journal 与备份已保留，请运行 recover 核查。');
    log('   本次登录未导入任何账号。');
    return finalize({ ok: false, failed: 'drift', rescued: r.rescued, actions: r.actions, exit: exitInfo, keepJournal: !r.rescued });
  }

  // ---------- 4) harvest（字面路径；不走 authStatePath）----------
  const harvestFile = opts.plainLogin
    ? canonical
    : path.join(computeCliAuthDir(shadowDir), CANONICAL_NAME);
  const deadline = now() + harvestTimeoutMs;
  let state = null;
  let lastErr = null;
  for (;;) {
    try {
      const st = fs.statSync(harvestFile);
      if (st.mtimeMs >= t0) state = parseAuthState(fs.readFileSync(harvestFile, 'utf8'));
      else lastErr = new Error('文件早于本次登录（疑似旧文件）');
      if (state) break;
    } catch (e) {
      lastErr = e;
    }
    if (now() >= deadline) break;
    await new Promise((r) => setTimeout(r, harvestPollMs));
  }
  if (!state) {
    log('❌ 未捕获到新的登录态（登录未完成或凭据不可读）。');
    if (opts.plainLogin) {
      log('   若您在 CLI 中执行了登出或未完成授权，请重新运行 relogin。');
    } else {
      log('   请重试并确保在 CLI 里完成 /login 授权后再关闭界面。');
    }
    return finalize({ ok: false, failed: 'harvest-missing', error: String(lastErr ?? ''), note: drift.warn });
  }
  const { reason } = credentialOf(state);
  if (reason === 'encrypted') {
    log('❌ 捕获到的登录态为加密格式（桌面端/at-rest 加密），当前版本无法读取。');
    log('   可尝试关闭凭据加密后重试（P0 时记录 WORKBUDDY_AT_REST_ENCRYPTION 是否设置）。');
    return finalize({ ok: false, failed: 'harvest-encrypted' });
  }
  if (reason !== 'ok') {
    log(`❌ 捕获到的登录态不可用（reason=${reason}）。`);
    return finalize({ ok: false, failed: `harvest-${reason}` });
  }
  const landedUid = strOrNull(state.account?.uid);
  if (mode === 'relogin' && uid && landedUid !== uid) {
    log(`❌ 实际授权的账号（${landedUid || '未知'}）与目标账号（${uid}）不一致——已中止，未写入账号池。`);
    return finalize({ ok: false, failed: 'uid-mismatch', landedUid });
  }

  // ---------- 5) 定向导入（expiresAt 比较闸）----------
  const rec = toAccountRecord(state, harvestFile);
  if (!rec) {
    log('❌ 登录态无法归一为账号记录（缺 uid 或凭据非法）——未写入。');
    return finalize({ ok: false, failed: 'record-invalid' });
  }
  const existing = getAccount(rec.id);
  if (existing && rec.expiresAt < existing.expiresAt) {
    log(`❌ 捕获凭据的有效期（${new Date(rec.expiresAt).toLocaleString('zh-CN')}）早于池中记录——判定为旧凭据，拒绝覆盖。`);
    return finalize({ ok: false, failed: 'stale-expiry' });
  }
  saveAccount(rec);

  // ---------- 6) 终检（真实 canonical 逐字节不变）----------
  if (!opts.plainLogin) {
    const cls = classifyRealState({ authDir: authDirReal, canonical, pre });
    if (cls.threat) {
      const r = rescueRealState({ authDir: authDirReal, canonical, pre, startedAt: t0, backupPath });
      log(`❌ 收尾检查发现真实登录态被改动（${cls.warn}）——新账号已入库，但真实登录态需要核查。`);
      if (r.rescued) {
        log(`   已自动恢复：${r.actions.join('；')}`);
        log('   建议运行 node scripts/accounts.js list 复核账号池与登录态。');
      } else {
        log('   ⚠️ 未能自动恢复，journal 与备份已保留，请运行 node scripts/accounts.js recover 核查。');
      }
      return finalize({ ok: false, failed: 'final-check', rescued: r.rescued, actions: r.actions, record: rec, keepJournal: !r.rescued });
    }
    if (cls.warn) drift = { threat: false, warn: cls.warn };
  } else {
    const landed = uidOf(canonical);
    if (!landed) {
      log('❌ 收尾检查：真实登录态缺失或不可解析，未确认登录结果。');
      log('   （普通登录模式不做现场还原：真实登录态已由 CLI 按常规流程更新。）');
      return finalize({ ok: false, failed: 'plain-final', record: rec });
    }
  }

  return finalize({
    ok: true,
    record: rec,
    note: drift.warn,
    exitCode: exitInfo.code
  });
}

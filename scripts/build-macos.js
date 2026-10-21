/**
 * build-macos.js — 组装 macOS 版 buddy2api 分发包（tar.gz，可选追加 dmg；零 npm 依赖）。
 *
 * 用法：
 *   node scripts/build-macos.js --cli-dir <已解包的 codebuddy cli 目录> \
 *     --arch arm64|x64 [--version <v>] [--out-dir <dir>] [--node-tgz <本地 node tar.gz>] [--dmg]
 *   （node tarball 默认从 nodejs.org dist 获取，可用 NODE_DIST_MIRROR 覆盖镜像）
 *
 * --dmg 仅支持 macOS（darwin）宿主：生成 <name>.tar.gz 之后再封装 <name>.dmg
 * （只读 UDZO 卷，卷根 = 包目录 + 使用说明.txt）；非 darwin 传 --dmg 直接报错退出。
 * dmg 与 tar.gz 并存，二者由同一次构建产出，二者都不改变既有的 tar.gz 契约。
 *
 * cli 子树的来源：CI 上由 workflow 用 hdiutil 从 WorkBuddy dmg 提取（符号链接/执行位
 * 无损）；本地 dry-run 用 7z 提取树（brokered-bin 符号链接会缺失，脚本自动以
 * codebuddy-toybox-dispatch 副本补齐——按 argv[0] 分发，仅用于结构验证，不作为分发产物）。
 *
 * node 二进制 pin 在 NODE_VERSION（SHASUMS256.txt 校验），保证可复现构建。
 * 注：dmg 天生不可复现（卷 UUID/创建时间戳随机），不参与 sha 固定（见 spec M6）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const NODE_VERSION = 'v22.14.0';
const NODE_DIST_MIRROR = process.env.NODE_DIST_MIRROR || 'https://nodejs.org/dist';

// 与 installer/build.ps1 的 $Scripts 白名单同源：只取跨平台 JS（Windows-only 的
// .ps1/.vbs/.cmd 与 onboarding.js 不进 macOS 包——其自启/签到步骤依赖 PowerShell）
const SCRIPTS_WHITELIST = [
  'service.js', 'login.js', 'status.js', 'kill.js',
  'models.js', 'accounts.js', 'account.js', 'checkin.js',
];

// vendor/shim/brokered-bin 下应有的全部工具条目（codebuddy-toybox-dispatch 是实体文件，
// 其余 22 个在 dmg 中为指向 dispatch 的符号链接）
const BROKERED_BIN_TOOLS = [
  'cat', 'chmod', 'codebuddy-toybox-dispatch', 'cp', 'dd', 'find', 'grep', 'head',
  'ln', 'ls', 'mkdir', 'mv', 'readlink', 'realpath', 'rm', 'rmdir', 'sed',
  'tail', 'tee', 'touch', 'truncate', 'unlink', 'wc',
];

// 带值选项（占用下一个 argv）；--dmg 是布尔旗标，单独分支处理，绝不吃掉后继参数
const VALUE_FLAGS = ['--cli-dir', '--arch', '--version', '--out-dir', '--node-tgz'];

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dmg') { args.dmg = true; continue; }
    if (VALUE_FLAGS.includes(a)) {
      args[a.slice(2)] = argv[++i];
    } else throw new Error(`未知参数: ${a}`);
  }
  if (!args['cli-dir']) throw new Error('缺少 --cli-dir <已解包 cli 目录>');
  if (!['arm64', 'x64'].includes(args.arch)) throw new Error('缺少 --arch arm64|x64');
  return args;
}

/**
 * dmg 门禁：--dmg 仅在 darwin 宿主可用（卷内符号链接与 hdiutil 依赖该平台）。
 * 在 main() 早期调用——避免非 darwin 白建 160MB tar.gz 后才失败。
 */
function resolveDmgEnabled(args, platform) {
  if (!args.dmg) return false;
  if (platform !== 'darwin') {
    throw new Error('--dmg 仅支持在 macOS（darwin）宿主生成：卷内符号链接与 hdiutil 依赖该平台');
  }
  return true;
}

function projectRoot() {
  return path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
}

function resolveTar() {
  const probe = spawnSync('tar', ['--version'], { encoding: 'utf8' });
  if (probe.status === 0) return 'tar';
  if (process.platform === 'win32' && fs.existsSync('C:\\Windows\\System32\\tar.exe')) {
    return 'C:\\Windows\\System32\\tar.exe';
  }
  throw new Error('找不到 tar（Windows 需 Git Bash 或系统内置 tar.exe）');
}

function copyDirSync(src, dest) {
  fs.cpSync(src, dest, { recursive: true, dereference: false });
}

function buildStartSh() {
  return [
    '#!/bin/sh',
    '# buddy2api macOS 启动脚本——在包根目录执行: ./start.sh（PORT/HOST 环境变量可覆盖默认值）',
    'set -e',
    'DIR="$(cd "$(dirname "$0")" && pwd)"',
    'cd "$DIR"',
    '# node 解析顺序与 Windows 安装包约定同构：BUDDY2API_NODE → 包内 runtime/node → PATH',
    'if [ -n "$BUDDY2API_NODE" ] && [ -x "$BUDDY2API_NODE" ]; then',
    '  NODE="$BUDDY2API_NODE"',
    'elif [ -x "$DIR/runtime/node" ]; then',
    '  NODE="$DIR/runtime/node"',
    'elif command -v node >/dev/null 2>&1; then',
    '  NODE=node',
    'else',
    '  echo "未找到 node：请安装 Node.js 18+ 或设置 BUDDY2API_NODE 指向可执行文件" >&2',
    '  exit 1',
    'fi',
    'exec "$NODE" "$DIR/src/index.js"',
    '',
  ].join('\n');
}

function buildPlistExample() {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '  <key>Label</key><string>com.buddy2api.server</string>',
    '  <key>ProgramArguments</key><array>',
    '    <string>__PAYLOAD_DIR__/runtime/node</string>',
    '    <string>__PAYLOAD_DIR__/src/index.js</string>',
    '  </array>',
    '  <key>WorkingDirectory</key><string>__PAYLOAD_DIR__</string>',
    '  <key>EnvironmentVariables</key><dict>',
    '    <key>PORT</key><string>8000</string>',
    '  </dict>',
    '  <key>RunAtLoad</key><true/>',
    '  <key>KeepAlive</key><false/>',
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
}

// Gatekeeper 解除隔离命令——README 与 dmg 卷内 使用说明.txt 共用同一文案源（防漂移）
const XATTR_CMD = 'xattr -dr com.apple.quarantine';

// 三步核心命令——README 与 使用说明.txt 共用同一文案源（防两处文案漂移）。
// 措辞必须与既有 README-macos.md **逐字一致**：tar.gz 契约是「不改变」，共享文案源
// 不得改写其渲染结果（tests/dmg-build.test.js 有逐字 pin，改文案会红）。
const CORE_STEPS = [
  { cmd: 'node scripts/login.js', note: '登录（浏览器授权，凭据存 ~/.codebuddy）' },
  { cmd: './start.sh', note: '启动服务（默认 127.0.0.1:8000，可用 PORT/HOST 覆盖）' },
  { cmd: 'curl http://127.0.0.1:8000/', note: '验证' },
];

function buildReadmeMacos(arch, version) {
  const archNote = arch === 'x64'
    ? '> ⚠️ x64 包在 CI 上仅做组装级验证（Rosetta 冒烟），未经真机验证。\n'
    : '';
  // 步骤 2-4 由 CORE_STEPS 渲染（与 dmg 卷内 使用说明.txt 同源，防文案漂移）
  const steps = CORE_STEPS.map((s, i) => `# ${i + 2}. ${s.note}\n${s.cmd}`).join('\n\n');
  return `# buddy2api macOS（${arch}）v${version}

OpenAI / Anthropic 兼容的 WorkBuddy 网关。本包解压即用，无需安装器。

## 快速开始

\`\`\`sh
# 1. 解压（必须用命令行 tar——图形解压工具可能丢失符号链接与执行位）
tar -xzf buddy2api-macos-${arch}-v${version}.tar.gz
cd buddy2api-macos-${arch}-v${version}

${steps}
\`\`\`

${archNote}
## 系统要求

- macOS 11+（${arch}；node ${NODE_VERSION} darwin 二进制的要求）
- 如被 Gatekeeper 拦截（浏览器下载会带 quarantine 属性）：\`${XATTR_CMD} <本目录>\`；
  用 curl 直接获取 tar.gz 则不会产生 quarantine。

## 常用操作

| 操作 | 命令 |
|------|------|
| 启动（前台） | \`./start.sh\` |
| 停止 | \`node scripts/service.js stop\` |
| 账号池 | \`node scripts/accounts.js\` |
| 每日签到（手动） | \`node scripts/checkin.js\` |
| 杀端口占用 | \`node scripts/kill.js\`（PORT 环境变量可覆盖 8000） |

## 开机自启（可选，launchd）

编辑 \`resources/buddy2api-server.plist.example\`，把 \`__PAYLOAD_DIR__\` 替换为解压后的绝对路径，
拷贝到 \`~/Library/LaunchAgents/com.buddy2api.server.plist\` 后执行
\`launchctl load ~/Library/LaunchAgents/com.buddy2api.server.plist\`。

## 说明

- \`vendor/codebuddy-cli\` 来自 WorkBuddy ${'5.6.2'} macOS 安装镜像（darwin 权威源，含全部原生二进制）。
- \`runtime/node\` 为 nodejs.org 官方 ${NODE_VERSION} darwin 二进制（SHASUMS256 校验）。
- Windows-only 功能（安装器、开机计划任务、每日签到定时任务、控制台菜单）不在本包范围内。
`;
}

/**
 * dmg 卷内 使用说明.txt（纯文本，LF）。
 * 第一准则：只读卷不可就地运行（服务写包根 data/）——把「先拷贝到可写位置」列为第一步。
 * Gatekeeper 命令复用 XATTR_CMD 常量（与 README 同源）；全文禁用 npm run。
 */
function buildUsageNote(arch, version, name) {
  return [
    `buddy2api macOS（${arch}）v${version} 使用说明`,
    '========================================',
    '【第一步 · 必读】本镜像是只读卷，不能就地运行。',
    '  服务运行时会向包根 data/ 写入账号与用量数据，只读卷写入必失败。',
    `  请先拷贝到可写位置：把 "${name}" 整个目录拖到「应用程序」「文稿」或主目录，`,
    '  再在终端进入该目录运行下述命令。',
    '',
    '【第二步】命令（在包根目录执行）',
    ...CORE_STEPS.map((s) => `  ${s.cmd.padEnd(29)}# ${s.note}`),
    '',
    '【常用】',
    '  node scripts/service.js stop # 停止服务',
    '  node scripts/accounts.js     # 账号池',
    '  node scripts/checkin.js      # 每日签到（手动）',
    '',
    '【Gatekeeper】若被拦截（浏览器下载会带 quarantine 属性）：',
    `  ${XATTR_CMD} "<拖出的包目录>"`,
    '',
    '说明：本包无 npm 依赖，命令一律 `node scripts/<file>`，请勿使用 npm 脚本运行。',
    '',
  ].join('\n');
}

function fetchNodeTarball(arch, destDir) {
  const tgzName = `node-${NODE_VERSION}-darwin-${arch}.tar.gz`;
  const tgzPath = path.join(destDir, tgzName);
  const shasumsPath = path.join(destDir, 'SHASUMS256.txt');
  const base = `${NODE_DIST_MIRROR}/${NODE_VERSION}`;
  fetchFileSync(`${base}/${tgzName}`, tgzPath);
  fetchFileSync(`${base}/SHASUMS256.txt`, shasumsPath);
  const expected = fs.readFileSync(shasumsPath, 'utf8').split('\n')
    .find((l) => l.trim().endsWith(tgzName));
  if (!expected) throw new Error(`SHASUMS256.txt 中找不到 ${tgzName}`);
  const actual = crypto.createHash('sha256').update(fs.readFileSync(tgzPath)).digest('hex');
  if (actual !== expected.trim().split(/\s+/)[0]) {
    throw new Error(`node tarball sha256 校验失败: ${actual}`);
  }
  return tgzPath;
}

function fetchFileSync(url, dest) {
  const r = spawnSync('curl', ['-fsSL', '-o', dest, url], { stdio: 'inherit' });
  if (r.status !== 0) throw new Error(`获取失败: ${url}（curl 退出码 ${r.status}）`);
}

function extractNodeBinary(tgzPath, destDir) {
  const tar = resolveTar();
  // 用 cwd + 相对路径：GNU tar 会把带盘符的绝对路径（C:\...）误判为远程主机；
  // 包内目录名从 tgz 文件名推导（node-v22.14.0-darwin-<arch>）
  const dirName = path.basename(tgzPath).replace(/\.tar\.gz$/, '');
  const r = spawnSync(tar, ['xzf', path.basename(tgzPath), '-C', '.',
    `${dirName}/bin/node`], { encoding: 'utf8', cwd: path.dirname(tgzPath) });
  if (r.status !== 0) throw new Error(`tar 解压 node 失败: ${r.stderr}`);
  return path.join(destDir, dirName, 'bin', 'node');
}

/**
 * 本地 7z 提取树里 brokered-bin 符号链接会缺失（Windows 无特权）——
 * 以 dispatch 实体副本补齐，使结构断言可过（仅 dry-run 场景会走到这里）。
 */
function repairBrokeredBin(cliDir) {
  const binDir = path.join(cliDir, 'vendor', 'shim', 'brokered-bin');
  const dispatch = path.join(binDir, 'codebuddy-toybox-dispatch');
  if (!fs.existsSync(dispatch)) return [];
  const repaired = [];
  for (const name of BROKERED_BIN_TOOLS) {
    const p = path.join(binDir, name);
    if (!fs.existsSync(p)) {
      fs.copyFileSync(dispatch, p);
      repaired.push(name);
    }
  }
  return repaired;
}

function verifyStaging(staging, { isDarwinHost }) {
  const problems = [];
  const rel = (p) => path.relative(staging, p).split(path.sep).join('/');

  // start.sh：存在、无 CRLF
  const startSh = path.join(staging, 'start.sh');
  if (!fs.existsSync(startSh)) problems.push('缺少 start.sh');
  else if (fs.readFileSync(startSh).includes(Buffer.from('\r\n'))) problems.push('start.sh 含 CRLF');

  // scripts 白名单
  for (const s of SCRIPTS_WHITELIST) {
    if (!fs.existsSync(path.join(staging, 'scripts', s))) problems.push(`缺少 scripts/${s}`);
  }

  // 禁止泄露/异物：包根级 data/（用户凭据，凭据红线只看包根——cli 子树深处的
  // 同名目录属上游正常产物）、.exe、AppleDouble
  if (fs.existsSync(path.join(staging, 'data'))) problems.push('包根存在 data/ 目录');
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      const r = rel(p);
      if (e.isDirectory()) {
        walk(p);
      } else {
        if (e.name.endsWith('.exe')) problems.push(`发现 .exe: ${r}`);
        if (e.name.startsWith('._')) problems.push(`发现 AppleDouble: ${r}`);
      }
    }
  };
  walk(staging);

  // brokered-bin 22 个工具条目齐全（darwin 宿主上必须是符号链接）
  const binDir = path.join(staging, 'vendor', 'codebuddy-cli', 'vendor', 'shim', 'brokered-bin');
  if (!fs.existsSync(binDir)) {
    problems.push('缺少 vendor/codebuddy-cli/vendor/shim/brokered-bin');
  } else {
    let linkCount = 0;
    for (const name of BROKERED_BIN_TOOLS) {
      const p = path.join(binDir, name);
      if (!fs.existsSync(p)) problems.push(`brokered-bin 缺少 ${name}`);
      else if (fs.lstatSync(p).isSymbolicLink()) linkCount++;
    }
    if (isDarwinHost && linkCount !== BROKERED_BIN_TOOLS.length - 1) {
      problems.push(`darwin 上 brokered-bin 符号链接应为 22 个，实际 ${linkCount}`);
    }
  }

  // runtime/node
  if (!fs.existsSync(path.join(staging, 'runtime', 'node'))) problems.push('缺少 runtime/node');

  return problems;
}

let buildTmpDir = null;

/**
 * 清掉同名 dmg 与上次残留的卷临时目录，并重建一个空的卷临时目录。
 *
 * 同名必须先删——`hdiutil create` 对已存在同名文件会报错退出（F8）；
 * 残留目录清理是中断（SIGINT/超时）后的自愈，下次构建无需人工收拾。
 * 返回 { dmgPath, volRoot }。
 */
function resetDmgOutputs(outDir, name) {
  const dmgPath = path.join(outDir, `${name}.dmg`);
  const volRoot = path.join(outDir, '.dmg-vol');
  fs.rmSync(dmgPath, { force: true });
  fs.rmSync(volRoot, { recursive: true, force: true });
  fs.mkdirSync(volRoot, { recursive: true });
  return { dmgPath, volRoot };
}

/**
 * 把已组装好的 staging 封装为只读 UDZO dmg（卷根 = 包目录 + 使用说明.txt）。
 * 前提：staging 与卷临时目录同父目录（outDir）→ rename 不跨设备、不复制 160MB 级数据。
 *
 * 失败语义（既不外泄坏产物，也不误删包目录）：
 * - create/verify 失败：删掉半成品 dmg，回迁 staging，再抛错；
 * - 回迁失败：**保留** .dmg-vol（此时它是包目录的唯一副本）并抛错——绝不对它递归删除；
 * - 回迁成功：清理 .dmg-vol。
 */
function buildDmg({ outDir, name, staging, arch, version }) {
  const { dmgPath, volRoot } = resetDmgOutputs(outDir, name);
  const volPkg = path.join(volRoot, name);
  let failure = null;
  try {
    // 同父目录同设备 rename（不复制 160MB 级数据）
    fs.renameSync(staging, volPkg);
    fs.writeFileSync(path.join(volRoot, '使用说明.txt'), buildUsageNote(arch, version, name));
    const r = spawnSync('hdiutil', [
      'create', '-srcfolder', volRoot, '-volname', name, '-format', 'UDZO', dmgPath,
    ], { stdio: 'inherit' });
    if (r.status !== 0) throw new Error('hdiutil create 失败');
    // 构建期镜像完整性自检（卷内结构断言在 CI 的 attach 处做）
    const v = spawnSync('hdiutil', ['verify', dmgPath], { stdio: 'inherit' });
    if (v.status !== 0) throw new Error('hdiutil verify 失败（镜像完整性自检不通过）');
  } catch (e) {
    // 半成品/坏镜像不自留（否则要等下次构建才被清）
    fs.rmSync(dmgPath, { force: true });
    failure = e;
  }

  // 回迁 staging：**仅回迁成功**才删卷临时目录——回迁失败时保留原目录，避免误删包目录
  let restored = false;
  try { fs.renameSync(volPkg, staging); restored = true; } catch { /* 见下 */ }
  if (restored) {
    fs.rmSync(volRoot, { recursive: true, force: true });
  } else {
    console.error(`⚠️ staging 回迁失败——保留 ${volRoot} 以便排查（包目录在 ${volPkg}）`);
  }

  if (failure) throw failure;
  if (!restored) throw new Error(`staging 回迁失败：包目录残留在 ${volPkg}，请手工移回 ${staging}`);
  return dmgPath;
}

function main() {
  const args = parseArgs(process.argv);
  // dmg 门禁前移：非 darwin 传 --dmg 立即失败，避免白建 160MB tar.gz
  const wantDmg = resolveDmgEnabled(args, process.platform);
  const root = projectRoot();
  const cliDir = path.resolve(args['cli-dir']);
  const arch = args.arch;
  const version = args.version || JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
  const outDir = path.resolve(args['out-dir'] || path.join(root, 'installer', 'dist'));
  const name = `buddy2api-macos-${arch}-v${version}`;
  const staging = path.join(outDir, name);
  const isDarwinHost = process.platform === 'darwin';

  if (!fs.existsSync(path.join(cliDir, 'bin', 'codebuddy'))) {
    throw new Error(`--cli-dir 无效：${cliDir} 下没有 bin/codebuddy`);
  }
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });

  // 1. 源码与白名单脚本
  copyDirSync(path.join(root, 'src'), path.join(staging, 'src'));
  fs.mkdirSync(path.join(staging, 'scripts'));
  for (const s of SCRIPTS_WHITELIST) {
    fs.copyFileSync(path.join(root, 'scripts', s), path.join(staging, 'scripts', s));
  }

  // 2. vendored CLI（darwin 权威树，保符号链接）+ dry-run 缺失链接补齐
  copyDirSync(cliDir, path.join(staging, 'vendor', 'codebuddy-cli'));
  const repaired = repairBrokeredBin(path.join(staging, 'vendor', 'codebuddy-cli'));
  if (repaired.length && isDarwinHost) {
    throw new Error(`darwin 宿主上 brokered-bin 缺失 ${repaired.length} 个条目（${repaired.join(', ')}）——cli 提取方式不对，符号链接应已原生保留`);
  }
  if (repaired.length) console.log(`ℹ️ brokered-bin 补齐 ${repaired.length} 个副本（dry-run 场景，非分发产物）`);

  // 3. node 运行时（pin + sha256 校验）
  fs.mkdirSync(path.join(staging, 'runtime'), { recursive: true });
  buildTmpDir = path.join(outDir, '.build-tmp');
  fs.mkdirSync(buildTmpDir, { recursive: true });
  let nodeBin;
  if (args['node-tgz']) {
    nodeBin = extractNodeBinary(path.resolve(args['node-tgz']), buildTmpDir);
  } else {
    const tgz = fetchNodeTarball(arch, buildTmpDir);
    nodeBin = extractNodeBinary(tgz, buildTmpDir);
  }
  fs.copyFileSync(nodeBin, path.join(staging, 'runtime', 'node'));

  // 4. 生成的文档与启动件
  fs.writeFileSync(path.join(staging, 'start.sh'), buildStartSh(), { mode: 0o755 });
  fs.mkdirSync(path.join(staging, 'resources'), { recursive: true });
  fs.writeFileSync(path.join(staging, 'resources', 'buddy2api-server.plist.example'), buildPlistExample());
  fs.writeFileSync(path.join(staging, 'README-macos.md'), buildReadmeMacos(arch, version));
  fs.copyFileSync(path.join(root, 'package.json'), path.join(staging, 'package.json'));
  fs.copyFileSync(path.join(root, 'README.md'), path.join(staging, 'README.md'));
  if (isDarwinHost) fs.chmodSync(path.join(staging, 'start.sh'), 0o755);

  // 5. 结构自检
  const problems = verifyStaging(staging, { isDarwinHost });
  if (problems.length) {
    throw new Error(`结构自检失败:\n- ${problems.join('\n- ')}`);
  }

  // 6. 打 tar.gz（cwd + 相对路径，规避 GNU tar 盘符误判）
  const tgzPath = path.join(outDir, `${name}.tar.gz`);
  const tar = resolveTar();
  fs.rmSync(tgzPath, { force: true });
  const r = spawnSync(tar, ['-czf', `${name}.tar.gz`, name],
    { stdio: 'inherit', cwd: outDir });
  if (r.status !== 0) throw new Error('tar 打包失败');
  fs.rmSync(buildTmpDir, { recursive: true, force: true });
  console.log(`✅ ${tgzPath} (${(fs.statSync(tgzPath).size / 1024 / 1024).toFixed(1)} MB)`);

  // 7. 可选：封装 dmg（darwin-only；复用同一 staging，卷根 = 包目录 + 使用说明.txt）
  if (wantDmg) {
    const dmgPath = buildDmg({ outDir, name, staging, arch, version });
    console.log(`✅ ${dmgPath} (${(fs.statSync(dmgPath).size / 1024 / 1024).toFixed(1)} MB)`);
  }
}

// 入口守卫：仅当本文件被直接执行时运行 main（供单测 import 纯函数而不触发真实打包）。
// 两侧都取 realpath 再比较——规避符号链接（macOS /tmp→/private/tmp）与 Windows 盘符大小写
// 差异导致 import.meta.url ≠ pathToFileURL(argv[1]) 而**静默不执行 main** 的失效模式。
function isEntryPoint(argv1) {
  if (!argv1) return false;
  try {
    return fs.realpathSync(argv1) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint(process.argv[1])) {
  try {
    main();
  } catch (e) {
    // 失败路径清掉 node 下载缓存（staging 保留便于排查；dmg 卷临时目录由 buildDmg 自管）
    if (buildTmpDir) { try { fs.rmSync(buildTmpDir, { recursive: true, force: true }); } catch { /* 尽力清理 */ } }
    console.error(`❌ ${e.message}`);
    process.exit(1);
  }
}

export { parseArgs, resolveDmgEnabled, buildUsageNote, buildReadmeMacos, resetDmgOutputs };

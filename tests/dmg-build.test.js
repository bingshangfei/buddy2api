/**
 * dmg-build.test.js — build-macos.js 的 dmg 相关纯函数与入口契约测试。
 *
 * 不触发真实打包：测纯函数（parseArgs / resolveDmgEnabled / buildUsageNote /
 * buildReadmeMacos / resetDmgOutputs），以及在临时目录里验证产物清理。
 * import 该模块不得产生副作用（入口守卫保证），否则本文件会在 import 时就真跑打包。
 * 平台可注入，测试不依赖真实宿主。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  parseArgs, resolveDmgEnabled, buildUsageNote, buildReadmeMacos, resetDmgOutputs,
} from '../scripts/build-macos.js';

const SCRIPT_PATH = fileURLToPath(new URL('../scripts/build-macos.js', import.meta.url));

// 构造完整 argv（parseArgs 从索引 2 起解析）
const argv = (...rest) => ['node', 'build-macos.js', ...rest];

test('parseArgs 接受布尔旗标 --dmg', () => {
  const args = parseArgs(argv('--cli-dir', '/x', '--arch', 'arm64', '--dmg'));
  assert.equal(args.dmg, true);
  assert.equal(args['cli-dir'], '/x');
  assert.equal(args.arch, 'arm64');
});

test('parseArgs 的 --dmg 不吞掉后继参数', () => {
  const args = parseArgs(argv('--cli-dir', '/x', '--arch', 'arm64', '--dmg', '--version', '1.2.3'));
  assert.equal(args.dmg, true);
  assert.equal(args.arch, 'arm64');
  assert.equal(args.version, '1.2.3');
});

test('parseArgs 拒绝未知参数', () => {
  assert.throws(() => parseArgs(argv('--cli-dir', '/x', '--arch', 'arm64', '--bogus')), /未知参数/);
});

test('parseArgs 缺 --cli-dir 报错', () => {
  assert.throws(() => parseArgs(argv('--arch', 'arm64')), /缺少 --cli-dir/);
});

test('parseArgs 非法 --arch 报错', () => {
  assert.throws(() => parseArgs(argv('--cli-dir', '/x', '--arch', 'ppc')), /缺少 --arch/);
});

test('resolveDmgEnabled：未传 --dmg 时任意平台均返回 false 且不抛', () => {
  assert.equal(resolveDmgEnabled({}, 'win32'), false);
  assert.equal(resolveDmgEnabled({}, 'darwin'), false);
  assert.equal(resolveDmgEnabled({}, 'linux'), false);
});

test('resolveDmgEnabled：--dmg 于非 darwin 宿主报错（fail-loud）', () => {
  assert.throws(() => resolveDmgEnabled({ dmg: true }, 'win32'), /--dmg 仅支持在 macOS/);
  assert.throws(() => resolveDmgEnabled({ dmg: true }, 'linux'), /--dmg 仅支持在 macOS/);
});

test('resolveDmgEnabled：--dmg 于 darwin 宿主返回 true', () => {
  assert.equal(resolveDmgEnabled({ dmg: true }, 'darwin'), true);
});

test('buildUsageNote：首要动作是拷贝到可写位置（只读卷约束）', () => {
  const note = buildUsageNote('arm64', '1.2.3', 'buddy2api-macos-arm64-v1.2.3');
  assert.match(note, /只读卷/);
  assert.match(note, /拷贝到可写/);
  // 只读指引须出现在命令清单之前（第一步）
  assert.ok(note.indexOf('拷贝到可写') < note.indexOf('node scripts/login.js'));
});

test('buildUsageNote：含 Gatekeeper xattr 指引', () => {
  const note = buildUsageNote('x64', '1.2.3', 'buddy2api-macos-x64-v1.2.3');
  assert.match(note, /xattr -dr com\.apple\.quarantine/);
});

test('buildUsageNote：禁用 npm run，命令一律 node scripts/', () => {
  const note = buildUsageNote('arm64', '1.2.3', 'buddy2api-macos-arm64-v1.2.3');
  assert.ok(!note.includes('npm run'), '使用说明不得出现 npm run');
  assert.match(note, /node scripts\//);
});

test('buildUsageNote：含架构、版本与包目录名', () => {
  const note = buildUsageNote('arm64', '9.9.9', 'buddy2api-macos-arm64-v9.9.9');
  assert.match(note, /arm64/);
  assert.match(note, /v9\.9\.9/);
  assert.match(note, /buddy2api-macos-arm64-v9\.9\.9/);
});

test('buildReadmeMacos：快速开始命令块与既有 tar.gz 契约逐字一致（dmg 不得改动 tar.gz 产物）', () => {
  const readme = buildReadmeMacos('arm64', '1.2.3');
  const frozen = [
    '# 2. 登录（浏览器授权，凭据存 ~/.codebuddy）',
    'node scripts/login.js',
    '',
    '# 3. 启动服务（默认 127.0.0.1:8000，可用 PORT/HOST 覆盖）',
    './start.sh',
    '',
    '# 4. 验证',
    'curl http://127.0.0.1:8000/',
  ].join('\n');
  assert.ok(readme.includes(frozen), `README-macos.md 快速开始块发生漂移：\n${readme}`);
});

test('resetDmgOutputs：先删同名 dmg、清残留卷目录并重建空卷目录（同名不报错）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dmg-reset-'));
  const name = 'buddy2api-macos-arm64-v1.2.3';
  fs.writeFileSync(path.join(dir, `${name}.dmg`), 'stale-bytes');
  fs.mkdirSync(path.join(dir, '.dmg-vol', 'leftover'), { recursive: true });
  try {
    const { dmgPath, volRoot } = resetDmgOutputs(dir, name);
    assert.equal(fs.existsSync(dmgPath), false, '同名 dmg 必须先被删除（否则 hdiutil create 报错）');
    assert.equal(fs.existsSync(path.join(volRoot, 'leftover')), false, '上次残留的卷目录必须先被清理');
    assert.ok(fs.existsSync(volRoot), '卷临时目录必须重建为空目录');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('入口守卫：无参直接执行 → 报错 exit 1（不得静默成功）', () => {
  const r = spawnSync(process.execPath, [SCRIPT_PATH], { encoding: 'utf8' });
  assert.equal(r.status, 1, `期望 exit 1，实际 ${r.status}；stderr=${r.stderr}`);
  assert.match(r.stderr, /缺少 --cli-dir/);
});

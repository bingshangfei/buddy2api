/**
 * account-info 单测（node:test，零依赖）。
 * 纯函数直接测；getAccountSummary 通过注入 file / fetchImpl 隔离 IO 与网络。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  parseAuthState,
  parseResourceSummary,
  formatAccountSummary,
  getAccountSummary,
  authStatePath
} from '../src/account-info.js';

/** 写一个临时登录态文件，返回路径 */
function writeAuthFile(content) {
  const file = path.join(os.tmpdir(), `buddy2api-auth-${process.pid}-${Math.random().toString(16).slice(2)}.info`);
  fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content));
  return file;
}

/** 造一个成功的计费网关响应 */
function okFetch(data, status = 200) {
  return async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => data
  });
}

// ---------- parseResourceSummary ----------

test('parseResourceSummary: 汇总多包 余额/总额/已用 并保留两位小数', () => {
  const out = parseResourceSummary({
    Packages: [
      { PackageCode: 'A', CycleTotalCapacity: '3130', CycleRemainCapacity: '2008.23000068', CycleUsedCapacity: '1121.76999932', CapacityUnit: 'credits' },
      { PackageCode: 'B', CycleTotalCapacity: '500', CycleRemainCapacity: '500', CycleUsedCapacity: '0', CapacityUnit: 'credits' }
    ],
    IsPaidUser: false
  });
  assert.equal(out.remaining, 2508.23);
  assert.equal(out.total, 3630);
  assert.equal(out.used, 1121.77);
  assert.equal(out.unit, 'credits');
  assert.equal(out.isPaid, false);
  assert.equal(out.packages.length, 2);
  assert.equal(out.packages[0].code, 'A');
});

test('parseResourceSummary: 缺 Packages / 非法数值 → 归零，不抛错', () => {
  assert.deepEqual(parseResourceSummary({}), { remaining: 0, total: 0, used: 0, unit: 'credits', isPaid: false, packages: [] });
  const out = parseResourceSummary({ Packages: [{ PackageCode: 'X', CycleTotalCapacity: 'abc' }] });
  assert.equal(out.total, 0);
  assert.equal(out.remaining, 0);
});

test('parseResourceSummary: 网关未给已用 → 用 总额-剩余 兜底', () => {
  const out = parseResourceSummary({ Packages: [{ CycleTotalCapacity: '100', CycleRemainCapacity: '70' }] });
  assert.equal(out.used, 30);
});

// ---------- parseAuthState ----------

test('parseAuthState: 提取 account 与 auth', () => {
  const { account, auth } = parseAuthState(JSON.stringify({
    account: { uid: 'u1', nickname: '小明' },
    auth: { accessToken: 'tok', expiresAt: 123 }
  }));
  assert.equal(account.uid, 'u1');
  assert.equal(auth.accessToken, 'tok');
});

test('parseAuthState: 缺字段 → null；非法 JSON → 抛错', () => {
  assert.deepEqual(parseAuthState('{}'), { account: null, auth: null });
  assert.throws(() => parseAuthState('not json'));
});

// ---------- authStatePath ----------

test('authStatePath: CODEBUDDY_AUTH_FILE 覆盖优先', () => {
  const prev = process.env.CODEBUDDY_AUTH_FILE;
  try {
    process.env.CODEBUDDY_AUTH_FILE = 'C:\\custom\\auth.info';
    assert.equal(authStatePath(), 'C:\\custom\\auth.info');
  } finally {
    if (prev === undefined) delete process.env.CODEBUDDY_AUTH_FILE; else process.env.CODEBUDDY_AUTH_FILE = prev;
  }
});

test('authStatePath: 规范名与轮换快照并存时优先规范名', () => {
  const prev = process.env.CODEBUDDY_AUTH_FILE;
  delete process.env.CODEBUDDY_AUTH_FILE;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'buddy2api-authdir-'));
  const canonical = path.join(dir, 'workbuddy-desktop.info');
  fs.writeFileSync(canonical, '{}');
  fs.writeFileSync(path.join(dir, 'workbuddy-desktop.2026-01-01T00-00-00-000Z.1.abc.info'), '{}');
  try {
    assert.equal(authStatePath(dir), canonical);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    if (prev !== undefined) process.env.CODEBUDDY_AUTH_FILE = prev;
  }
});

test('authStatePath: 只有轮换快照时取最新的（CLI 改名后仍能找到登录态）', () => {
  const prev = process.env.CODEBUDDY_AUTH_FILE;
  delete process.env.CODEBUDDY_AUTH_FILE;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'buddy2api-authdir-'));
  const older = path.join(dir, 'workbuddy-desktop.2026-01-01T00-00-00-000Z.1.aaa.info');
  const newer = path.join(dir, 'workbuddy-desktop.2026-09-11T08-33-34-834Z.40112.bbb.info');
  fs.writeFileSync(older, '{}');
  fs.writeFileSync(newer, '{}');
  // 显式拉开 mtime，避免同秒写入导致顺序不确定
  const past = new Date(Date.now() - 60_000);
  fs.utimesSync(older, past, past);
  try {
    assert.equal(authStatePath(dir), newer);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    if (prev !== undefined) process.env.CODEBUDDY_AUTH_FILE = prev;
  }
});

test('authStatePath: 目录为空或不存在 → 回退规范名', () => {
  const prev = process.env.CODEBUDDY_AUTH_FILE;
  delete process.env.CODEBUDDY_AUTH_FILE;
  const dir = path.join(os.tmpdir(), `buddy2api-nope-${Date.now()}`);
  try {
    assert.equal(authStatePath(dir), path.join(dir, 'workbuddy-desktop.info'));
  } finally {
    if (prev !== undefined) process.env.CODEBUDDY_AUTH_FILE = prev;
  }
});

// ---------- getAccountSummary ----------

test('getAccountSummary: 登录态缺失 → ok:false 且提示未登录', async () => {
  const r = await getAccountSummary({ file: path.join(os.tmpdir(), 'definitely-missing-buddy2api.info') });
  assert.equal(r.ok, false);
  assert.equal(r.account, null);
  assert.match(r.error, /未找到登录态文件/);
});

test('getAccountSummary: 有 token + 网关成功 → ok:true，含账户与余额', async () => {
  const file = writeAuthFile({
    account: { uid: 'u-1', nickname: '测试账号', uin: '100000000001', type: 'personal' },
    auth: { accessToken: 'tok-abc', expiresAt: Date.now() + 3600_000 }
  });
  try {
    const r = await getAccountSummary({
      file,
      fetchImpl: okFetch({ code: 0, msg: 'OK', data: { Packages: [{ PackageCode: 'A', CycleTotalCapacity: '3630', CycleRemainCapacity: '2508.23', CycleUsedCapacity: '1121.77', CapacityUnit: 'credits' }], IsPaidUser: false } })
    });
    assert.equal(r.ok, true);
    assert.equal(r.account.nickname, '测试账号');
    assert.equal(r.balance.remaining, 2508.23);
    assert.equal(r.balance.total, 3630);
  } finally {
    fs.unlinkSync(file);
  }
});

test('getAccountSummary: token 过期 → ok:false，不发起网络请求', async () => {
  const file = writeAuthFile({
    account: { uid: 'u-1', nickname: 'x' },
    auth: { accessToken: 'tok', expiresAt: Date.now() - 1000 }
  });
  let called = false;
  try {
    const r = await getAccountSummary({ file, fetchImpl: async () => { called = true; throw new Error('should not call'); } });
    assert.equal(r.ok, false);
    assert.match(r.error, /已过期/);
    assert.equal(called, false);
  } finally {
    fs.unlinkSync(file);
  }
});

test('getAccountSummary: 无 accessToken → ok:false', async () => {
  const file = writeAuthFile({ account: { uid: 'u-1' }, auth: { refreshToken: 'r' } });
  try {
    const r = await getAccountSummary({ file });
    assert.equal(r.ok, false);
    assert.match(r.error, /accessToken/);
  } finally {
    fs.unlinkSync(file);
  }
});

test('getAccountSummary: 网关 401 → ok:false 且提示重新登录', async () => {
  const file = writeAuthFile({ account: { uid: 'u-1', nickname: 'x' }, auth: { accessToken: 'tok', expiresAt: Date.now() + 3600_000 } });
  try {
    const r = await getAccountSummary({ file, fetchImpl: okFetch({}, 401) });
    assert.equal(r.ok, false);
    assert.match(r.error, /重新登录/);
  } finally {
    fs.unlinkSync(file);
  }
});

test('getAccountSummary: 网关 code!=0 → ok:false 且带 code', async () => {
  const file = writeAuthFile({ account: { uid: 'u-1' }, auth: { accessToken: 'tok', expiresAt: Date.now() + 3600_000 } });
  try {
    const r = await getAccountSummary({ file, fetchImpl: okFetch({ code: 14018, msg: '额度不足' }) });
    assert.equal(r.ok, false);
    assert.match(r.error, /code=14018/);
  } finally {
    fs.unlinkSync(file);
  }
});

// ---------- formatAccountSummary ----------

test('formatAccountSummary: 成功时含昵称与余额行', () => {
  const text = formatAccountSummary({
    ok: true,
    account: { nickname: '测试账号', uid: 'u-1', type: 'personal' },
    balance: { remaining: 2508.23, total: 3630, used: 1121.77, unit: 'credits' }
  });
  assert.match(text, /测试账号/);
  assert.match(text, /2508\.23 \/ 3630 credits/);
});

test('formatAccountSummary: 未登录 / 无余额 → 给出说明行', () => {
  const text = formatAccountSummary({ ok: false, account: null, balance: null, error: '未找到登录态文件' });
  assert.match(text, /未登录/);
  assert.match(text, /未找到登录态文件/);
});

// ---------- 加密格式（$wbEncrypted 信封）防御 ----------

test('getAccountSummary: accessToken 为加密对象 → ok:false + reason=encrypted，且不发网络请求', async () => {
  const file = writeAuthFile({
    account: { uid: 'u-1', nickname: { $wbEncrypted: 1, envelope: 'x' } },
    auth: { accessToken: { $wbEncrypted: 1, envelope: 'x' }, expiresAt: Date.now() + 3600_000 }
  });
  let called = false;
  try {
    const r = await getAccountSummary({ file, fetchImpl: async () => { called = true; throw new Error('should not call'); } });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'encrypted');
    assert.match(r.error, /加密格式/);
    assert.equal(called, false, '加密格式必须在任何网络请求前早退');
  } finally {
    fs.unlinkSync(file);
  }
});

test('getAccountSummary: 展示字段非 string → 投影归 null（可用 token 不受影响）', async () => {
  const file = writeAuthFile({
    account: { uid: 'u-1', nickname: { $wbEncrypted: 1 }, uin: 123, type: { nested: true } },
    auth: { accessToken: 'tok-abc', expiresAt: Date.now() + 3600_000 }
  });
  try {
    const r = await getAccountSummary({ file, fetchImpl: okFetch({ code: 0, msg: 'OK', data: { Packages: [] } }) });
    assert.equal(r.ok, true);
    assert.equal(r.account.nickname, null);
    assert.equal(r.account.uin, null);
    assert.equal(r.account.type, null);
  } finally {
    fs.unlinkSync(file);
  }
});

test('getAccountSummary: 登录态缺失 → reason=no-auth-file', async () => {
  const r = await getAccountSummary({ file: path.join(os.tmpdir(), 'definitely-missing-buddy2api-2.info') });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'no-auth-file');
});

test('formatAccountSummary: 昵称为非 string（加密信封）→ 回退占位，不出现 [object Object]', () => {
  const text = formatAccountSummary({
    ok: false,
    account: { nickname: { $wbEncrypted: 1, envelope: 'x' }, uid: 'u-1' },
    balance: null,
    error: '登录态为加密格式（桌面端写入），当前版本暂不支持读取'
  });
  assert.doesNotMatch(text, /\[object Object\]/);
  assert.match(text, /加密格式/);
});

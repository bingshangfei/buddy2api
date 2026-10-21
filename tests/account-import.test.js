/**
 * 账号导入守卫单测（node:test，零依赖）。
 *
 * 覆盖：明文导入（同 uid 多快照取 expiresAt 最新）、加密凭据跳过与计数、
 * 「不覆盖」「不产生」两组负向、importCurrent 不写盘、读侧过滤与损坏记录可见性。
 *
 * fixture 设计要点（评审 F6/F14）：负向「不覆盖」用例的加密样本 expiresAt 必须为
 * 「明文大数字」——否则加密记录在旧逻辑里也赢不了（Number(obj)||0 === 0），
 * 变异检验会假绿；同 uid 的 0 值退化分支另有用例锁定。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  importFromAuthDir,
  importCurrent,
  listAccounts,
  listCorrupted,
  toAccountRecord
} from '../src/account-store.js';
import { isUsableToken, credentialOf, readAccessToken } from '../src/auth-credentials.js';

/** 沙箱：临时 auth 目录 + 隔离账号目录（BUDDY2API_ACCOUNTS_DIR）；fixture 写入失败自清理 */
function withSandbox(files = {}) {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), 'b2a-import-auth-'));
  const accDir = fs.mkdtempSync(path.join(os.tmpdir(), 'b2a-import-acc-'));
  try {
    for (const [name, content] of Object.entries(files)) {
      fs.writeFileSync(path.join(authDir, name), typeof content === 'string' ? content : JSON.stringify(content));
    }
  } catch (e) {
    fs.rmSync(authDir, { recursive: true, force: true });
    fs.rmSync(accDir, { recursive: true, force: true });
    throw e;
  }
  const prevAcc = process.env.BUDDY2API_ACCOUNTS_DIR;
  process.env.BUDDY2API_ACCOUNTS_DIR = accDir;
  return {
    authDir,
    accDir,
    restore() {
      if (prevAcc === undefined) delete process.env.BUDDY2API_ACCOUNTS_DIR;
      else process.env.BUDDY2API_ACCOUNTS_DIR = prevAcc;
      fs.rmSync(authDir, { recursive: true, force: true });
      fs.rmSync(accDir, { recursive: true, force: true });
    }
  };
}

/** 明文登录态样本 */
const plainState = (uid, nickname, over = {}) => ({
  account: { uid, nickname, uin: 'u', type: 'personal' },
  auth: { accessToken: `tok-${uid}`, refreshToken: 'r', expiresAt: over.expiresAt ?? Date.now() + 86_400_000 }
});

/** 加密登录态样本（expiresAt 可为明文大数字或 0 值——见文件头说明） */
const encryptedState = (uid, over = {}) => ({
  account: { uid, nickname: { $wbEncrypted: 1, envelope: 'eyJzdWl0ZSI6MX0=' } },
  auth: {
    accessToken: { $wbEncrypted: 1, envelope: 'eyJzdWl0ZSI6MX0=' },
    refreshToken: { $wbEncrypted: 1, envelope: 'yy' },
    expiresAt: over.expiresAt ?? Date.now() + 86_400_000
  }
});

// ---------- isUsableToken / credentialOf / readAccessToken（归一单点） ----------

test('isUsableToken：仅非空字符串可用', () => {
  assert.equal(isUsableToken('tok'), true);
  assert.equal(isUsableToken(''), false);
  assert.equal(isUsableToken(null), false);
  assert.equal(isUsableToken(undefined), false);
  assert.equal(isUsableToken({ $wbEncrypted: 1, envelope: 'x' }), false);
  assert.equal(isUsableToken(123), false);
});

test('credentialOf：ok / encrypted / missing / invalid 四类 reason', () => {
  assert.deepEqual(credentialOf({ auth: { accessToken: 'tok' } }), { token: 'tok', reason: 'ok' });
  const enc = credentialOf({ auth: { accessToken: { $wbEncrypted: 1, envelope: 'x' } } });
  assert.equal(enc.token, null);
  assert.equal(enc.reason, 'encrypted');
  assert.equal(credentialOf({ auth: {} }).reason, 'missing');
  assert.equal(credentialOf({}).reason, 'missing');
  assert.equal(credentialOf({ auth: { accessToken: 123 } }).reason, 'invalid');
  assert.equal(credentialOf({ auth: { accessToken: { random: true } } }).reason, 'invalid');
});

test('readAccessToken：加密文件 → null；明文文件 → {token, source}', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'b2a-rat-'));
  try {
    const encFile = path.join(dir, 'enc.info');
    fs.writeFileSync(encFile, JSON.stringify(encryptedState('u1')));
    assert.equal(readAccessToken(encFile), null, '加密对象不得作为 token 返回');

    const okFile = path.join(dir, 'ok.info');
    fs.writeFileSync(okFile, JSON.stringify(plainState('u2', '乙', { expiresAt: Date.now() + 86_400_000 })));
    const r = readAccessToken(okFile);
    assert.equal(r.token, 'tok-u2');
    assert.equal(r.source, okFile);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------- 导入正路径 ----------

test('importFromAuthDir：明文凭据照常导入（同 uid 多快照取 expiresAt 最新）', () => {
  const older = plainState('u1', '甲', { expiresAt: Date.now() + 1000 });
  const newer = plainState('u1', '甲', { expiresAt: Date.now() + 86_400_000 });
  const h = withSandbox({
    'workbuddy-desktop.2026-01-01T00-00-00-000Z.1.old.info': older,
    'workbuddy-desktop.2026-02-01T00-00-00-000Z.1.new.info': newer
  });
  try {
    const r = importFromAuthDir({ dir: h.authDir });
    assert.equal(r.imported.length, 1);
    assert.equal(r.imported[0].accessToken, 'tok-u1');
    assert.equal(r.imported[0].expiresAt, newer.auth.expiresAt);
    assert.equal(r.skipped, 0);
    assert.equal(r.encrypted, 0);
  } finally { h.restore(); }
});

test('importFromAuthDir：明文+加密混合——明文条目照常导入，加密计数', () => {
  const h = withSandbox({
    'workbuddy-desktop.info': encryptedState('uEnc'),
    'workbuddy-desktop.2026-01-02T00-00-00-000Z.1.p.info': plainState('u2', '乙')
  });
  try {
    const r = importFromAuthDir({ dir: h.authDir });
    assert.equal(r.imported.length, 1);
    assert.equal(r.imported[0].id, 'u2');
    assert.equal(r.encrypted, 1);
    assert.ok(r.skipped >= 1, '加密凭据须计入 skipped（下界）');
  } finally { h.restore(); }
});

// ---------- 负向：不产生 / 不覆盖 ----------

test('importFromAuthDir：「不产生」——加密凭据被跳过并计数，不产生记录', () => {
  const h = withSandbox({ 'workbuddy-desktop.info': encryptedState('uEnc') });
  try {
    const r = importFromAuthDir({ dir: h.authDir });
    assert.equal(r.imported.length, 0);
    assert.equal(r.encrypted, 1, '加密凭据须计入 encrypted');
    assert.ok(r.skipped >= 1, '加密凭据须计入 skipped（下界）');
    assert.equal(listAccounts({ includeExpired: true }).length, 0, '不得产生对象 token 记录');
  } finally { h.restore(); }
});

test('importFromAuthDir：「不覆盖」——加密文件 expiresAt 更大也不得覆盖同 uid 明文记录', () => {
  const h = withSandbox({
    'workbuddy-desktop.2026-01-01T00-00-00-000Z.1.p.info': plainState('u1', '甲', { expiresAt: Date.now() + 1000 })
  });
  try {
    let r = importFromAuthDir({ dir: h.authDir });
    assert.equal(r.imported.length, 1);
    const before = listAccounts({ includeExpired: true }).find((a) => a.id === 'u1');
    assert.equal(before.accessToken, 'tok-u1');

    // 加密新文件：expiresAt 明文大数字（评审 F6 要求的形态）→ 仍不得成为候选
    fs.writeFileSync(
      path.join(h.authDir, 'workbuddy-desktop.2026-03-01T00-00-00-000Z.1.enc.info'),
      JSON.stringify(encryptedState('u1', { expiresAt: Date.now() + 999_999_999 }))
    );
    r = importFromAuthDir({ dir: h.authDir });
    assert.equal(r.imported.length, 1, '明文条目照常导入（加密文件不得成为候选）');
    assert.equal(r.imported[0].accessToken, 'tok-u1');
    assert.equal(r.encrypted, 1);
    assert.ok(r.skipped >= 1, '加密凭据须计入 skipped（下界）');
    const after = listAccounts({ includeExpired: true }).find((a) => a.id === 'u1');
    assert.equal(after.accessToken, 'tok-u1', '好记录不得被覆盖');
    assert.equal(after.expiresAt, before.expiresAt);
  } finally { h.restore(); }
});

test('importFromAuthDir：同 uid 加密记录 expiresAt=0 的退化分支——明文仍胜出且不覆盖', () => {
  const h = withSandbox({
    'workbuddy-desktop.2026-01-01T00-00-00-000Z.1.p.info': plainState('u1', '甲', { expiresAt: Date.now() + 1000 }),
    'workbuddy-desktop.2026-01-02T00-00-00-000Z.1.enc0.info': encryptedState('u1', { expiresAt: 0 })
  });
  try {
    const r = importFromAuthDir({ dir: h.authDir });
    assert.equal(r.imported.length, 1);
    assert.equal(r.imported[0].accessToken, 'tok-u1');
    assert.equal(r.encrypted, 1);
    const rec = listAccounts({ includeExpired: true }).find((a) => a.id === 'u1');
    assert.equal(rec.accessToken, 'tok-u1');
  } finally { h.restore(); }
});

test('importFromAuthDir：损坏 JSON 与无 uid 文件计入 skipped（不算 encrypted）', () => {
  const h = withSandbox({
    'workbuddy-desktop.2026-01-01T00-00-00-000Z.1.bad.info': 'not json',
    'workbuddy-desktop.2026-01-02T00-00-00-000Z.1.nouid.info': { account: {}, auth: { accessToken: 'tok' } }
  });
  try {
    const r = importFromAuthDir({ dir: h.authDir });
    assert.equal(r.imported.length, 0);
    assert.equal(r.skipped, 2);
    assert.equal(r.encrypted, 0);
  } finally { h.restore(); }
});

test('importCurrent：加密 canonical 文件 → 不写盘、返回 null', () => {
  const h = withSandbox({});
  try {
    const file = path.join(h.authDir, 'workbuddy-desktop.info');
    fs.writeFileSync(file, JSON.stringify(encryptedState('uEnc')));
    const prevFile = process.env.CODEBUDDY_AUTH_FILE;
    process.env.CODEBUDDY_AUTH_FILE = file;
    try {
      const rec = importCurrent();
      assert.equal(rec, null);
      assert.equal(listAccounts({ includeExpired: true }).length, 0, '不得写盘');
    } finally {
      if (prevFile === undefined) delete process.env.CODEBUDDY_AUTH_FILE;
      else process.env.CODEBUDDY_AUTH_FILE = prevFile;
    }
  } finally { h.restore(); }
});

// ---------- 读侧收口 / 损坏记录可见性 ----------

test('listAccounts：读侧过滤非 string token 记录；listCorrupted 可见且带原因', () => {
  const h = withSandbox({});
  try {
    fs.writeFileSync(path.join(h.accDir, 'bad.json'), JSON.stringify({
      id: 'bad',
      uid: 'bad',
      nickname: { $wbEncrypted: 1, envelope: 'x' },
      accessToken: { $wbEncrypted: 1, envelope: 'x' },
      expiresAt: Date.now() + 86_400_000
    }));
    assert.equal(listAccounts({ includeExpired: true }).length, 0, '损坏记录不得进入可用列表');
    const corrupt = listCorrupted();
    assert.equal(corrupt.length, 1);
    assert.equal(corrupt[0].id, 'bad');
    assert.equal(corrupt[0].reason, 'corrupted-record');
  } finally { h.restore(); }
});

test('listAccounts/listCorrupted：非 string id 的记录读侧过滤 + 诊断可见（invalid-id）', () => {
  const h = withSandbox({});
  try {
    fs.writeFileSync(path.join(h.accDir, 'badid.json'), JSON.stringify({
      id: { oops: true },
      uid: 'badid',
      nickname: '有明文 token 但 id 异常',
      accessToken: 'tok-ok',
      expiresAt: Date.now() + 86_400_000
    }));
    assert.equal(listAccounts({ includeExpired: true }).length, 0, '非 string id 不得进入可用列表');
    const corrupt = listCorrupted();
    assert.equal(corrupt.length, 1);
    assert.equal(corrupt[0].reason, 'invalid-id');
  } finally { h.restore(); }
});

test('listAccounts：展示字段读侧归一（对象昵称 → null，不再外泄）', () => {
  const h = withSandbox({});
  try {
    fs.writeFileSync(path.join(h.accDir, 'u9.json'), JSON.stringify({
      id: 'u9',
      uid: 'u9',
      nickname: { $wbEncrypted: 1, envelope: 'x' },
      type: 42,
      accessToken: 'tok-ok',
      expiresAt: Date.now() + 86_400_000
    }));
    const rec = listAccounts({ includeExpired: true }).find((a) => a.id === 'u9');
    assert.ok(rec, '可用记录应返回');
    assert.equal(rec.nickname, null);
    assert.equal(rec.type, null);
  } finally { h.restore(); }
});

test('toAccountRecord：非 string token → null；展示字段非 string → 归 null', () => {
  assert.equal(toAccountRecord(encryptedState('uEnc')), null);
  const rec = toAccountRecord({
    account: { uid: 'u1', nickname: { $wbEncrypted: 1 }, uin: 123, type: 'personal' },
    auth: { accessToken: 'tok', expiresAt: 123 }
  });
  assert.equal(rec.nickname, null);
  assert.equal(rec.uin, null);
  assert.equal(rec.type, 'personal');
  assert.equal(rec.accessToken, 'tok');
});

/**
 * backend-process 单测（node:test，零依赖）——批7 交付面。
 *
 * buildChildEnv / parseEndpointFromStdout 此前是 gateway-discovery 模块私有、
 * 零直测（审视 F8）。本文件补齐直接测试；spawnBackendProcess/probeHealth 涉及
 * 真进程与网络，不在单测覆盖（Windows spawn 实弹走 P0 真机，审视 F12）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import { buildChildEnv, parseEndpointFromStdout } from '../src/backend-process.js';

const silentLog = { log() {}, warn() {} };

test('buildChildEnv：STRIP_ENV_KEYS 剥离（会话身份/追踪/代理不进子进程）', () => {
  const env = buildChildEnv(null, {
    CODEBUDDY_SESSION_ID: 'sess-x',
    TRACEPARENT: '00-trace-span-01',
    CODEBUDDY_SERVICE_PROXY_URL: 'http://127.0.0.1:7897',
    PATH: 'keep-me'
  }, silentLog);
  assert.equal(env.CODEBUDDY_SESSION_ID, undefined);
  assert.equal(env.TRACEPARENT, undefined);
  assert.equal(env.CODEBUDDY_SERVICE_PROXY_URL, undefined);
  assert.equal(env.PATH, 'keep-me', '非剥离键保留');
});

test('buildChildEnv：关闭开关族恒注入', () => {
  const env = buildChildEnv(null, {}, silentLog);
  assert.equal(env.DISABLE_AUTOUPDATER, '1');
  assert.equal(env.CODEBUDDY_DISABLE_CRON, '1');
  assert.equal(env.CODEBUDDY_DISABLE_AUTO_MEMORY, '1');
  assert.equal(env.CODEBUDDY_DISABLE_SYSTEM_REMINDER_MD, '1');
  assert.equal(env.CODEBUDDY_DISABLE_EXTENDED_PLUGIN_HOOKS, '1');
  assert.equal(env.CODEBUDDY_DISABLE_SESSION_HISTORY_CLEANUP, '1');
});

test('buildChildEnv：账号 token 注入；调用方显式设 CODEBUDDY_AUTH_TOKEN 时不覆盖', () => {
  const injected = buildChildEnv({ id: 'a1', nickname: '甲', accessToken: 'tok-1' }, {}, silentLog);
  assert.equal(injected.CODEBUDDY_AUTH_TOKEN, 'tok-1');

  const preserved = buildChildEnv({ id: 'a1', accessToken: 'tok-1' }, { CODEBUDDY_AUTH_TOKEN: 'manual' }, silentLog);
  assert.equal(preserved.CODEBUDDY_AUTH_TOKEN, 'manual', '显式设置优先（手工排查口径，逐字保持）');
});

test('parseEndpointFromStdout：ANSI 转义清洗后解析 Endpoint 行', async () => {
  const stdout = new EventEmitter();
  const p = parseEndpointFromStdout(stdout);
  stdout.emit('data', Buffer.from('\x1b[32m[i] starting\x1b[0m\n'));
  stdout.emit('data', Buffer.from('Endpoint http://127.0.0.1:52374\n'));
  assert.equal(await p, 'http://127.0.0.1:52374');
});

test('parseEndpointFromStdout：stdout 关闭仍无 Endpoint → reject', async () => {
  const stdout = new EventEmitter();
  const p = parseEndpointFromStdout(stdout);
  stdout.emit('data', Buffer.from('no endpoint here\n'));
  stdout.emit('close');
  await assert.rejects(p, /stdout closed before endpoint/);
});

test('parseEndpointFromStdout：分片到达也能匹配（跨 chunk 粘包）', async () => {
  const stdout = new EventEmitter();
  const p = parseEndpointFromStdout(stdout);
  stdout.emit('data', Buffer.from('Endpoint http://127.0.0.'));
  stdout.emit('data', Buffer.from('1:50211\n'));
  assert.equal(await p, 'http://127.0.0.1:50211');
});

test('buildChildEnv：账号 token 非 string（加密对象/数值）→ 不注入（回退读登录态，此处隔离为空）', () => {
  const prev = process.env.CODEBUDDY_AUTH_FILE;
  process.env.CODEBUDDY_AUTH_FILE = path.join(os.tmpdir(), `b2a-nonexistent-${Date.now()}.info`);
  try {
    const env = buildChildEnv({ id: 'a1', nickname: { $wbEncrypted: 1 }, accessToken: { $wbEncrypted: 1, envelope: 'x' } }, {}, silentLog);
    assert.equal(env.CODEBUDDY_AUTH_TOKEN, undefined, '非 string token 不得注入 env');
    const env2 = buildChildEnv({ id: 'a1', accessToken: 123 }, {}, silentLog);
    assert.equal(env2.CODEBUDDY_AUTH_TOKEN, undefined);
  } finally {
    if (prev === undefined) delete process.env.CODEBUDDY_AUTH_FILE;
    else process.env.CODEBUDDY_AUTH_FILE = prev;
  }
});

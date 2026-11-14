/**
 * headless-v105.test.mjs — headless server mode (v1.05, Đội T3).
 * Server thật trên loopback với port 0 (OS chọn), không chạm UI.
 * Run: build core rồi `node --test tests/headless-v105.test.mjs`
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  HEADLESS_VERSION,
  headlessPidStatus,
  isProcessAlive,
  probeHeadlessHealth,
  readPidFile,
  removePidFile,
  startHeadlessServer,
  writePidFile,
} from '../packages/core/dist/headless/server.js';

test('headless: /health trả ok + version + pid, /status có uptime', async () => {
  const handle = await startHeadlessServer({ port: 0 });
  try {
    assert.match(handle.url, /^http:\/\/127\.0\.0\.1:\d+$/);
    const healthRes = await fetch(`${handle.url}/health`);
    assert.equal(healthRes.status, 200);
    const health = await healthRes.json();
    assert.equal(health.status, 'ok');
    assert.equal(health.version, HEADLESS_VERSION);
    assert.equal(health.pid, process.pid);
    assert.ok(typeof health.uptimeSeconds === 'number');

    const statusRes = await fetch(`${handle.url}/status`);
    const status = await statusRes.json();
    assert.equal(status.status, 'ok');
    assert.ok(status.startedAt);

    const missing = await fetch(`${handle.url}/khong-co`);
    assert.equal(missing.status, 404);
  } finally {
    await handle.close();
  }
});

test('headless: /models trả snapshot khi host cung cấp, rỗng khi không', async () => {
  const handle = await startHeadlessServer({
    port: 0,
    getModels: () => ({ ollama: ['llama3.1:8b'], openai: ['gpt-5'] }),
  });
  try {
    const res = await fetch(`${handle.url}/models`);
    const body = await res.json();
    assert.deepEqual(body.providers.ollama, ['llama3.1:8b']);
    assert.deepEqual(body.providers.openai, ['gpt-5']);
  } finally {
    await handle.close();
  }
  const handle2 = await startHeadlessServer({ port: 0 });
  try {
    const res = await fetch(`${handle2.url}/models`);
    assert.deepEqual((await res.json()).providers, {});
  } finally {
    await handle2.close();
  }
});

test('headless: log ra file có timestamp + dòng start/stop', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openbot-headless-v105-'));
  const logFile = path.join(dir, 'headless.log');
  const handle = await startHeadlessServer({ port: 0, logFile });
  await handle.close();
  const text = fs.readFileSync(logFile, 'utf8');
  assert.match(text, /đang nghe http:\/\/127\.0\.0\.1:/);
  assert.match(text, /đã dừng/);
});

test('headless: port bận -> start reject rõ', async () => {
  const first = await startHeadlessServer({ port: 0 });
  try {
    await assert.rejects(() => startHeadlessServer({ port: first.port }), /EADDRINUSE/);
  } finally {
    await first.close();
  }
});

test('headless: probeHeadlessHealth trả null khi không có server', async () => {
  const health = await probeHeadlessHealth('127.0.0.1', 1, 500);
  assert.equal(health, null);
});

test('headless: probeHeadlessHealth trả health khi server chạy', async () => {
  const handle = await startHeadlessServer({ port: 0 });
  try {
    const health = await probeHeadlessHealth('127.0.0.1', handle.port);
    assert.ok(health);
    assert.equal(health.status, 'ok');
    assert.equal(health.pid, process.pid);
  } finally {
    await handle.close();
  }
});

test('headless: PID file write/read/remove + status running/stale/stopped', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openbot-pid-v105-'));
  assert.deepEqual(headlessPidStatus(dir), { status: 'stopped', pid: null });
  assert.equal(readPidFile(dir), null);

  const file = writePidFile(dir, process.pid);
  assert.equal(readPidFile(dir), process.pid);
  assert.equal(headlessPidStatus(dir).status, 'running');
  assert.equal(isProcessAlive(process.pid), true);
  assert.equal(isProcessAlive(999999), false);

  writePidFile(dir, 999999);
  assert.deepEqual(headlessPidStatus(dir), { status: 'stale', pid: 999999 });
  removePidFile(dir);
  assert.equal(readPidFile(dir), null);
  assert.equal(fs.existsSync(file), false);
});

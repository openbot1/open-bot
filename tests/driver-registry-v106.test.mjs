/**
 * driver-registry-v106.test.mjs — Driver registry + probe v1.06 (Đội T3).
 *
 * Register/list/enable/disable/remove + validate (id, binary, argv
 * chứa cờ key), probe với spawn giả (version đọc được/không đọc
 * được/lỗi), persistence qua file. Run: build core rồi
 * `node --test tests/driver-registry-v106.test.mjs`
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DriverRegistry } from '../packages/core/dist/drivers/registry.js';
import { probeDriver, parseVersionFromOutput } from '../packages/core/dist/drivers/probe.js';

function tmpDir() {
  return mkdtempSync(join(tmpdir(), 'open-bot-driver-'));
}

function registry(dir, warns = []) {
  return new DriverRegistry({
    dataDir: dir,
    binaryExists: () => true,
    now: () => 1780000000000,
    onWarn: (m) => warns.push(m),
  });
}

const INPUT = {
  id: 'my-cli',
  name: 'My CLI',
  providerId: 'my-provider',
  binaryPath: '/usr/local/bin/my-cli',
  argv: ['acp'],
  streamFormat: 'acp',
};

test('driver: register + list + get, mặc định versionArgs/enabled', () => {
  const reg = registry(tmpDir());
  const cfg = reg.register(INPUT);
  assert.equal(cfg.id, 'my-cli');
  assert.deepEqual(cfg.versionArgs, ['--version']);
  assert.equal(cfg.enabled, true);
  assert.equal(cfg.createdAt, 1780000000000);
  assert.equal(reg.list().length, 1);
  assert.equal(reg.get('my-cli').name, 'My CLI');
  assert.equal(reg.get('nope'), null);
});

test('driver: persistence — instance mới đọc lại từ file', () => {
  const dir = tmpDir();
  registry(dir).register(INPUT);
  const reg2 = new DriverRegistry({ dataDir: dir, binaryExists: () => true });
  assert.equal(reg2.list().length, 1);
  assert.equal(reg2.get('my-cli').streamFormat, 'acp');
  const state = JSON.parse(readFileSync(join(dir, 'cli-drivers.json'), 'utf8'));
  assert.equal(state.version, 1);
});

test('driver: register trùng id → lỗi; update giữ createdAt', () => {
  const reg = registry(tmpDir());
  reg.register(INPUT);
  assert.throws(() => reg.register(INPUT), /đã tồn tại/);
  const updated = reg.update('my-cli', { ...INPUT, name: 'My CLI v2' });
  assert.equal(updated.name, 'My CLI v2');
  assert.equal(updated.createdAt, 1780000000000);
  assert.throws(() => reg.update('ghost', INPUT), /chưa tồn tại/);
});

test('driver: validate — id sai, provider sai, format lạ', () => {
  const reg = registry(tmpDir());
  assert.throws(() => reg.register({ ...INPUT, id: 'My CLI!' }), /"id"/);
  assert.throws(() => reg.register({ ...INPUT, providerId: 'My Provider' }), /providerId/);
  assert.throws(() => reg.register({ ...INPUT, streamFormat: 'grpc' }), /streamFormat/);
  assert.throws(() => reg.register({ ...INPUT, name: '' }), /"name"/);
});

test('driver: binary không tồn tại → từ chối đăng ký', () => {
  const reg = new DriverRegistry({ dataDir: tmpDir(), binaryExists: () => false });
  assert.throws(() => reg.register(INPUT), /không tìm thấy binary/);
});

test('driver: argv chứa cờ key/token → từ chối (secret không vào config)', () => {
  const reg = registry(tmpDir());
  assert.throws(() => reg.register({ ...INPUT, argv: ['--api-key', 'sk-x'] }), /API key\/token/);
  assert.throws(() => reg.register({ ...INPUT, argv: ['--token=abc'] }), /API key\/token/);
  assert.throws(() => reg.register({ ...INPUT, probeArgs: ['--password', 'x'] }), /API key\/token/);
});

test('driver: enable/disable/remove + lỗi khi không tồn tại', () => {
  const reg = registry(tmpDir());
  reg.register(INPUT);
  assert.equal(reg.disable('my-cli').enabled, false);
  assert.deepEqual(reg.listEnabled(), []);
  assert.equal(reg.enable('my-cli').enabled, true);
  assert.equal(reg.remove('my-cli').id, 'my-cli');
  assert.equal(reg.list().length, 0);
  assert.throws(() => reg.enable('my-cli'), /không tồn tại/);
  assert.throws(() => reg.remove('my-cli'), /không tồn tại/);
});

test('driver: file state hỏng → registry rỗng + cảnh báo, không crash', () => {
  const dir = tmpDir();
  writeFileSync(join(dir, 'cli-drivers.json'), '{ hỏng', 'utf8');
  const warns = [];
  const reg = new DriverRegistry({ dataDir: dir, binaryExists: () => true, onWarn: (m) => warns.push(m) });
  assert.equal(reg.list().length, 0);
  assert.equal(warns.length, 1);
});

test('probe: parse version từ output (v-prefix, stderr, không có version)', () => {
  assert.equal(parseVersionFromOutput('my-cli version 1.2.3\n'), '1.2.3');
  assert.equal(parseVersionFromOutput('v0.9.1-beta'), '0.9.1-beta');
  assert.equal(parseVersionFromOutput('hello world'), null);
});

test('probe: binary chạy tốt + probe login ok → ok=true, signedIn=true', async () => {
  const cfg = registry(tmpDir()).register({ ...INPUT, probeArgs: ['auth', 'status'] });
  const calls = [];
  const result = await probeDriver(cfg, {
    now: () => 1000,
    spawn: async (bin, args) => {
      calls.push([bin, args]);
      if (args.includes('auth')) return { code: 0, stdout: 'signed in as huy\n', stderr: '' };
      return { code: 0, stdout: 'my-cli 2.0.1\n', stderr: '' };
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.version, '2.0.1');
  assert.equal(result.binaryFound, true);
  assert.equal(result.signedIn, true);
  assert.deepEqual(calls[0][1], ['acp', '--version']);
});

test('probe: binary không tìm thấy → ok=false, binaryFound=false', async () => {
  const cfg = registry(tmpDir()).register(INPUT);
  const result = await probeDriver(cfg, { spawn: async () => null });
  assert.equal(result.ok, false);
  assert.equal(result.binaryFound, false);
  assert.match(result.error, /không tìm thấy binary/);
});

test('probe: version exit != 0 → ok=false kèm output; không đọc được version → ok=false', async () => {
  const cfg = registry(tmpDir()).register(INPUT);
  const badExit = await probeDriver(cfg, { spawn: async () => ({ code: 1, stdout: '', stderr: 'boom 3.3.3\n' }) });
  assert.equal(badExit.ok, false);
  assert.equal(badExit.version, '3.3.3');
  const noVersion = await probeDriver(cfg, { spawn: async () => ({ code: 0, stdout: 'hello\n', stderr: '' }) });
  assert.equal(noVersion.ok, false);
  assert.match(noVersion.error, /không đọc được version/);
});

test('probe: probe login fail → driver vẫn ok, signedIn=false', async () => {
  const cfg = registry(tmpDir()).register({ ...INPUT, probeArgs: ['auth', 'status'] });
  const result = await probeDriver(cfg, {
    spawn: async (bin, args) => (args.includes('auth') ? { code: 1, stdout: '', stderr: 'not logged in' } : { code: 0, stdout: 'my-cli 1.0.0', stderr: '' }),
  });
  assert.equal(result.ok, true);
  assert.equal(result.signedIn, false);
});

test('probe: spawn throw → ok=false với lý do rõ', async () => {
  const cfg = registry(tmpDir()).register(INPUT);
  const result = await probeDriver(cfg, {
    spawn: async () => {
      throw new Error('EACCES');
    },
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /EACCES/);
});

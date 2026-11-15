/**
 * doctor-v106.test.mjs — lệnh doctor v1.06 (Đội T3).
 *
 * runDoctor với env giả (không chạm máy thật): mọi check pass, từng
 * trường hợp fail/warn (Node cũ, đĩa đầy, không có CLI, cổng bị
 * chiếm, chưa có vault), lọc check bằng `only`, format text checklist.
 * Run: build core rồi `node --test tests/doctor-v106.test.mjs`
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  formatDoctorReport,
  runDoctor,
} from '../packages/core/dist/doctor/index.js';

function healthyEnv(overrides = {}) {
  return {
    nodeVersion: 'v24.3.0',
    platform: 'linux',
    arch: 'x64',
    osRelease: '6.8.0',
    cpuCount: 4,
    loadAvg1m: 0.5,
    totalmem: 8 * 1024 ** 3,
    freemem: 4 * 1024 ** 3,
    diskFreeBytes: 50 * 1024 ** 3,
    dataDir: mkdtempSync(join(tmpdir(), 'open-bot-doctor-')),
    harnessPort: 18789,
    run: async () => ({ code: 0, stdout: '10.9.0\n', stderr: '' }),
    fileExists: () => true,
    readDir: () => ['bots.json', 'team.json'],
    tryBindLoopback: async () => true,
    tryConnect: async () => false,
    engines: {
      engines: {
        claude: {
          kind: 'claude',
          label: 'Claude Code',
          binary: 'claude',
          binaryPath: '/usr/local/bin/claude',
          version: '1.0.0',
          minVersion: '0.1.0',
          status: 'available',
          authMethod: 'cli-status',
          detectedAt: new Date().toISOString(),
          enabled: true,
          account: { label: 'huy@example.com', method: 'oauth' },
        },
      },
      detectedAt: new Date().toISOString(),
    },
    vaultNamespaces: ['grok', 'openai'],
    vaultFileExists: true,
    now: () => 1780000000000,
    ...overrides,
  };
}

test('doctor: môi trường tốt → 11 pass, ok=true', async () => {
  const report = await runDoctor(healthyEnv());
  assert.equal(report.version, 1);
  assert.equal(report.checks.length, 11);
  assert.equal(report.summary.pass, 11);
  assert.equal(report.summary.fail, 0);
  assert.equal(report.summary.warn, 0);
  assert.equal(report.ok, true);
  assert.deepEqual(
    report.checks.map((c) => c.id),
    ['node-version', 'npm-version', 'os', 'cpu', 'memory', 'disk', 'cli-engines', 'harness-loopback', 'harness-port', 'vault', 'data-dir'],
  );
});

test('doctor: Node v18 → node-version fail + gợi ý sửa', async () => {
  const report = await runDoctor(healthyEnv({ nodeVersion: 'v18.20.0' }));
  const check = report.checks.find((c) => c.id === 'node-version');
  assert.equal(check.status, 'fail');
  assert.match(check.detail, /v18/);
  assert.match(check.fix, /24/);
  assert.equal(report.ok, false);
  assert.equal(report.summary.fail, 1);
});

test('doctor: Node v22 → warn (chưa tới mức khuyến nghị)', async () => {
  const report = await runDoctor(healthyEnv({ nodeVersion: 'v22.1.0' }));
  assert.equal(report.checks.find((c) => c.id === 'node-version').status, 'warn');
  assert.equal(report.ok, true);
});

test('doctor: đĩa còn 500MB → disk fail; còn 3GB → warn', async () => {
  const full = await runDoctor(healthyEnv({ diskFreeBytes: 500 * 1024 ** 2 }));
  assert.equal(full.checks.find((c) => c.id === 'disk').status, 'fail');
  const low = await runDoctor(healthyEnv({ diskFreeBytes: 3 * 1024 ** 3 }));
  assert.equal(low.checks.find((c) => c.id === 'disk').status, 'warn');
});

test('doctor: không có CLI nào → cli-engines warn + gợi ý cài/đăng nhập', async () => {
  const report = await runDoctor(healthyEnv({ engines: { engines: {}, detectedAt: new Date().toISOString() } }));
  const check = report.checks.find((c) => c.id === 'cli-engines');
  assert.equal(check.status, 'warn');
  assert.match(check.fix, /Claude Code|API key/);
});

test('doctor: CLI đã cài nhưng chưa đăng nhập → warn', async () => {
  const env = healthyEnv();
  env.engines.engines.claude.status = 'unavailable';
  env.engines.engines.claude.reason = 'not-signed-in';
  delete env.engines.engines.claude.account;
  const report = await runDoctor(env);
  const check = report.checks.find((c) => c.id === 'cli-engines');
  assert.equal(check.status, 'warn');
  assert.match(check.detail, /chưa CLI nào đăng nhập/);
});

test('doctor: CLI đã đăng nhập nhưng chưa bật nguồn → warn', async () => {
  const env = healthyEnv();
  env.engines.engines.claude.enabled = false;
  const report = await runDoctor(env);
  const check = report.checks.find((c) => c.id === 'cli-engines');
  assert.equal(check.status, 'warn');
  assert.match(check.fix, /Settings → Engines/);
});

test('doctor: cổng harness bị chiếm → warn; loopback bind lỗi → fail', async () => {
  const occupied = await runDoctor(healthyEnv({ tryConnect: async () => true }));
  assert.equal(occupied.checks.find((c) => c.id === 'harness-port').status, 'warn');
  const noLoopback = await runDoctor(healthyEnv({ tryBindLoopback: async () => false }));
  assert.equal(noLoopback.checks.find((c) => c.id === 'harness-loopback').status, 'fail');
});

test('doctor: chưa có vault → warn; vault có key → pass', async () => {
  const none = await runDoctor(healthyEnv({ vaultFileExists: false }));
  assert.equal(none.checks.find((c) => c.id === 'vault').status, 'warn');
  const withKeys = await runDoctor(healthyEnv());
  assert.match(withKeys.checks.find((c) => c.id === 'vault').detail, /grok, openai/);
});

test('doctor: npm không có trên PATH → npm-version fail', async () => {
  const report = await runDoctor(healthyEnv({ run: async () => null }));
  assert.equal(report.checks.find((c) => c.id === 'npm-version').status, 'fail');
});

test('doctor: only=[disk] chỉ chạy 1 check, summary theo đó', async () => {
  const report = await runDoctor(healthyEnv(), { only: ['disk'] });
  assert.equal(report.checks.length, 1);
  assert.equal(report.checks[0].id, 'disk');
  assert.equal(report.summary.total, 1);
});

test('doctor: format text có đủ nhóm + dòng tổng kết', async () => {
  const report = await runDoctor(healthyEnv({ nodeVersion: 'v18.0.0' }));
  const text = formatDoctorReport(report);
  assert.match(text, /\[Môi trường chạy\]/);
  assert.match(text, /\[Tài nguyên máy\]/);
  assert.match(text, /\[CLI agent\]/);
  assert.match(text, /✗ Phiên bản Node\.js/);
  assert.match(text, /→ Sửa:/);
  assert.match(text, /Kết quả: 10\/11 pass, 0 cảnh báo, 1 lỗi\./);
});

test('doctor: check lỗi nội bộ không làm crash cả lần doctor', async () => {
  const report = await runDoctor(
    healthyEnv({
      run: async () => {
        throw new Error('spawn nổ tung');
      },
    }),
  );
  // npm-version và disk (dùng df fallback) đều fail mềm, các check khác vẫn chạy.
  assert.equal(report.checks.length, 11);
  assert.equal(report.checks.find((c) => c.id === 'npm-version').status, 'fail');
  assert.equal(report.checks.find((c) => c.id === 'node-version').status, 'pass');
});

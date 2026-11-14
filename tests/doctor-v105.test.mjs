/**
 * doctor-v105.test.mjs — `open-bot doctor` (v1.05, Đội T3).
 * Mọi check đều dùng deps mock: không gọi mạng, không đọc đĩa thật.
 * Run: build core rồi `node --test tests/doctor-v105.test.mjs`
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DOCTOR_HEADLESS_PORT,
  doctorExitCode,
  renderDoctorReport,
  runDoctorChecks,
} from '../packages/core/dist/doctor/doctor.js';

function healthyDeps(overrides = {}) {
  return {
    dataDir: '/tmp/does-not-exist-openbot-v105',
    getEnv: () => undefined,
    hasVaultSecret: () => false,
    fetchFn: async () => ({ ok: true, status: 200 }),
    exists: () => true,
    readDir: () => ['a', 'b'],
    readFile: () => '[]',
    totalMem: () => 8 * 1024 * 1024 * 1024,
    freeMem: () => 4 * 1024 * 1024 * 1024,
    diskStats: () => ({ totalBytes: 100 * 1024 ** 3, freeBytes: 50 * 1024 ** 3 }),
    isPortFree: async () => true,
    nodeVersion: 'v22.0.0',
    platform: 'linux',
    ...overrides,
  };
}

test('doctor: môi trường khoẻ mạnh -> ok, exit 0, đủ 9 check', async () => {
  const report = await runDoctorChecks(healthyDeps());
  assert.equal(report.checks.length, 9);
  assert.equal(report.summary.fail, 0);
  assert.equal(report.ok, true);
  assert.equal(doctorExitCode(report), 0);
  const ids = report.checks.map((c) => c.id);
  for (const id of ['node', 'datadir', 'vault', 'providers', 'ollama', 'mcp', 'memory', 'disk', 'headless-port']) {
    assert.ok(ids.includes(id), `thiếu check ${id}`);
  }
});

test('doctor: node cũ -> fail + hint, exit 1', async () => {
  const report = await runDoctorChecks(healthyDeps({ nodeVersion: 'v18.19.0' }));
  const node = report.checks.find((c) => c.id === 'node');
  assert.equal(node.status, 'fail');
  assert.match(node.detail, /18/);
  assert.ok(node.hint);
  assert.equal(report.ok, false);
  assert.equal(doctorExitCode(report), 1);
});

test('doctor: ollama không chạy -> warn (không fail), exit vẫn 0', async () => {
  const report = await runDoctorChecks(
    healthyDeps({ fetchFn: async () => { throw new Error('connect ECONNREFUSED'); } }),
  );
  const ollama = report.checks.find((c) => c.id === 'ollama');
  assert.equal(ollama.status, 'warn');
  assert.match(ollama.detail, /không kết nối được/);
  assert.equal(report.ok, true);
  assert.equal(doctorExitCode(report), 0);
});

test('doctor: provider có key trong env -> ok, không lộ key trong detail', async () => {
  const report = await runDoctorChecks(
    healthyDeps({ getEnv: (name) => (name === 'OPENBOT_GEMINI_API_KEY' ? 'sk-secret-123' : undefined) }),
  );
  const providers = report.checks.find((c) => c.id === 'providers');
  assert.equal(providers.status, 'ok');
  assert.match(providers.detail, /gemini/);
  assert.doesNotMatch(providers.detail, /sk-secret/);
});

test('doctor: đĩa sắp đầy -> warn, đĩa hết -> fail', async () => {
  const warn = await runDoctorChecks(
    healthyDeps({ diskStats: () => ({ totalBytes: 100 * 1024 ** 3, freeBytes: 3 * 1024 ** 3 }) }),
  );
  assert.equal(warn.checks.find((c) => c.id === 'disk').status, 'warn');
  const fail = await runDoctorChecks(
    healthyDeps({ diskStats: () => ({ totalBytes: 100 * 1024 ** 3, freeBytes: 500 * 1024 ** 2 }) }),
  );
  assert.equal(fail.checks.find((c) => c.id === 'disk').status, 'fail');
  assert.equal(fail.ok, false);
});

test('doctor: mcp-servers.json hỏng -> fail rõ', async () => {
  const report = await runDoctorChecks(healthyDeps({ readFile: () => '{khong-phai-json' }));
  const mcp = report.checks.find((c) => c.id === 'mcp');
  assert.equal(mcp.status, 'fail');
  assert.match(mcp.detail, /không phải JSON/);
});

test('doctor: port headless bị chiếm -> warn, ghi rõ port', async () => {
  const report = await runDoctorChecks(healthyDeps({ isPortFree: async () => false }));
  const port = report.checks.find((c) => c.id === 'headless-port');
  assert.equal(port.status, 'warn');
  assert.match(port.detail, new RegExp(String(DOCTOR_HEADLESS_PORT)));
});

test('doctor: một check throw vẫn trả báo cáo đầy đủ (không crash)', async () => {
  const report = await runDoctorChecks(
    healthyDeps({
      totalMem: () => { throw new Error('boom'); },
    }),
  );
  assert.equal(report.checks.length, 9);
  assert.equal(report.checks.find((c) => c.id === 'memory').status, 'fail');
});

test('doctor: render text có đủ label + verdict, JSON parse được', async () => {
  const report = await runDoctorChecks(healthyDeps());
  const text = renderDoctorReport(report, false);
  assert.match(text, /Node\.js/);
  assert.match(text, /Ollama local/);
  assert.match(text, /OK/);
  assert.doesNotMatch(text, /\u001b\[/);
  const colored = renderDoctorReport(report, true);
  assert.match(colored, /\u001b\[/);
  assert.equal(JSON.parse(JSON.stringify(report)).ok, true);
});

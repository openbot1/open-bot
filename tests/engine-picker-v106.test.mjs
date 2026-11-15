/**
 * engine-picker-v106.test.mjs — Engine picker v1.06 (Đội T3).
 *
 * Catalog gộp CLI detect + driver + API, pick/current/unpick,
 * validate fail-closed (chưa cài/chưa login/đang tắt/model rỗng),
 * fallback về mặc định của bot khi pick hết hiệu lực. Run: build
 * core rồi `node --test tests/engine-picker-v106.test.mjs`
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { EnginePicker, isEnginePickable, listEngines } from '../packages/core/dist/engine/index.js';

function tmpDir() {
  return mkdtempSync(join(tmpdir(), 'open-bot-engine-'));
}

function snapshot(engine) {
  return { engines: { [engine.kind]: engine }, detectedAt: new Date().toISOString() };
}

function cliEngine(overrides = {}) {
  return {
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
    ...overrides,
  };
}

const DRIVER = {
  id: 'my-cli',
  name: 'My CLI',
  providerId: 'my-provider',
  binaryPath: '/usr/local/bin/my-cli',
  argv: ['acp'],
  streamFormat: 'acp',
  versionArgs: ['--version'],
  enabled: true,
  createdAt: 1,
  updatedAt: 1,
};

test('engine: catalog gộp CLI + driver + API theo đúng thứ tự', () => {
  const engines = listEngines({ detected: snapshot(cliEngine()), drivers: [DRIVER] });
  assert.equal(engines[0].id, 'cli:claude');
  assert.equal(engines[0].source, 'cli');
  assert.equal(engines[0].providerId, 'claude-code');
  assert.equal(engines[0].accountLabel, 'huy@example.com');
  assert.equal(engines[1].id, 'driver:my-cli');
  assert.equal(engines[1].source, 'driver');
  assert.equal(engines[2].id, 'api:mock');
  assert.equal(engines.find((e) => e.id === 'api:gemini').models[0], 'gemini-2.5-flash');
  assert.ok(engines.length >= 9, 'ít nhất 1 CLI + 1 driver + 7 API provider');
});

test('engine: CLI chưa cài / chưa login / đang tắt → không chọn được + lý do rõ', () => {
  const notInstalled = listEngines({ detected: snapshot(cliEngine({ binaryPath: null, status: 'unavailable', reason: 'not-installed' })) });
  assert.equal(isEnginePickable(notInstalled[0]), false);
  assert.equal(notInstalled[0].unavailableReason, 'not-installed');
  const notSignedIn = listEngines({ detected: snapshot(cliEngine({ status: 'unavailable', reason: 'not-signed-in' })) });
  assert.equal(isEnginePickable(notSignedIn[0]), false);
  assert.equal(notSignedIn[0].unavailableReason, 'not-signed-in');
  const disabled = listEngines({ detected: snapshot(cliEngine({ enabled: false })) });
  assert.equal(isEnginePickable(disabled[0]), false);
  assert.equal(disabled[0].unavailableReason, 'disabled');
  // API luôn chọn được (key do user nhập trong Settings).
  assert.equal(isEnginePickable(listEngines({})[0]), true);
});

test('engine: pick + current + unpick lưu bền qua instance mới', () => {
  const dir = tmpDir();
  const catalog = listEngines({ detected: snapshot(cliEngine()), drivers: [DRIVER] });
  const picker = new EnginePicker({ dataDir: dir, now: () => 1780000000000 });
  const pick = picker.pick('bot-1', 'cli:claude', 'claude-sonnet-4-5', catalog);
  assert.equal(pick.botId, 'bot-1');
  assert.equal(pick.source, 'cli');
  assert.equal(pick.providerId, 'claude-code');
  assert.equal(pick.model, 'claude-sonnet-4-5');
  const picker2 = new EnginePicker({ dataDir: dir });
  const current = picker2.currentEngine({ botId: 'bot-1', providerId: 'mock', model: 'mock' }, catalog);
  assert.equal(current.fromPick, true);
  assert.equal(current.engineId, 'cli:claude');
  assert.equal(current.label, 'Claude Code');
  assert.equal(picker2.unpick('bot-1').engineId, 'cli:claude');
  assert.equal(picker2.unpick('bot-1'), null);
  assert.equal(picker2.getPick('bot-1'), null);
});

test('engine: pick engine không có trong catalog → lỗi rõ', () => {
  const picker = new EnginePicker({ dataDir: tmpDir() });
  const catalog = listEngines({ detected: snapshot(cliEngine()) });
  assert.throws(() => picker.pick('b1', 'cli:codex', 'gpt-5', catalog), /không tìm thấy engine/);
});

test('engine: pick engine chưa login / đang tắt / model rỗng → lỗi', () => {
  const picker = new EnginePicker({ dataDir: tmpDir() });
  const notSignedIn = listEngines({ detected: snapshot(cliEngine({ status: 'unavailable', reason: 'not-signed-in' })) });
  assert.throws(() => picker.pick('b1', 'cli:claude', 'm', notSignedIn), /chưa đăng nhập/);
  const disabled = listEngines({ detected: snapshot(cliEngine({ enabled: false })) });
  assert.throws(() => picker.pick('b1', 'cli:claude', 'm', disabled), /đang tắt/);
  const catalog = listEngines({ detected: snapshot(cliEngine()) });
  assert.throws(() => picker.pick('b1', 'cli:claude', '   ', catalog), /model không được rỗng/);
  assert.throws(() => picker.pick('', 'cli:claude', 'm', catalog), /botId/);
});

test('engine: pick driver + API đều được', () => {
  const picker = new EnginePicker({ dataDir: tmpDir() });
  const catalog = listEngines({ detected: snapshot(cliEngine()), drivers: [DRIVER] });
  const d = picker.pick('b1', 'driver:my-cli', 'my-model-1', catalog);
  assert.equal(d.source, 'driver');
  assert.equal(d.providerId, 'my-provider');
  const a = picker.pick('b1', 'api:gemini', 'gemini-2.5-flash', catalog);
  assert.equal(a.source, 'api');
  assert.equal(a.providerId, 'gemini');
});

test('engine: currentEngine không có pick → mặc định của bot (fromPick=false)', () => {
  const picker = new EnginePicker({ dataDir: tmpDir() });
  const catalog = listEngines({ detected: snapshot(cliEngine()) });
  const current = picker.currentEngine({ botId: 'b9', providerId: 'gemini', model: 'gemini-2.5-flash' }, catalog);
  assert.equal(current.fromPick, false);
  assert.equal(current.engineId, 'api:gemini');
  assert.equal(current.model, 'gemini-2.5-flash');
  assert.equal(current.label, 'Gemini (API key)');
});

test('engine: pick trỏ tới engine đã tắt → current rơi về mặc định, không xoá pick', () => {
  const dir = tmpDir();
  const picker = new EnginePicker({ dataDir: dir });
  const on = listEngines({ detected: snapshot(cliEngine()) });
  picker.pick('b1', 'cli:claude', 'claude-sonnet-4-5', on);
  const off = listEngines({ detected: snapshot(cliEngine({ enabled: false })) });
  const current = picker.currentEngine({ botId: 'b1', providerId: 'mock', model: 'mock' }, off);
  assert.equal(current.fromPick, false);
  assert.equal(current.engineId, 'api:mock');
  // Pick vẫn còn — bật lại engine là dùng tiếp được.
  assert.notEqual(picker.getPick('b1'), null);
});

test('engine: bot CLI provider mặc định map đúng source cli', () => {
  const picker = new EnginePicker({ dataDir: tmpDir() });
  const current = picker.currentEngine({ botId: 'b1', providerId: 'codex', model: 'gpt-5' }, listEngines({}));
  assert.equal(current.source, 'cli');
  assert.equal(current.engineId, 'cli:codex');
});

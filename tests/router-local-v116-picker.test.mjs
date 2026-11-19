/**
 * Local model router v116 picker tests (v1.39, Doi T3 — node:test,
 * no network, no real model).
 *
 * Covers (pure module — pickerV116):
 * - buildPickerEntries: merges local catalogue + cloud + CLI models
 *   into one list, ranked by profile score, with source/account
 *   labels; CLI entries show which account the model runs through.
 * - Task filtering: a model without tool-use is unavailable for a
 *   code task that needs it, with a clear reason; hideUnavailable
 *   drops it; limit caps the list.
 * - summarizePicker: totals, per-source counts, cheapest / fastest /
 *   best-quality picks.
 *
 * Imports the BUILT core — build first:
 *   npm run build --workspace=@open-bot/core
 * then: node --test tests/router-local-v116-picker.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  availablePickerEntries,
  buildPickerEntries,
  summarizePicker,
} from '../packages/core/dist/router/local/index.js';

const GB = 1024 * 1024 * 1024;

function env(overrides = {}) {
  return { loadedModelIds: new Set(), availableRamBytes: 8 * GB, ...overrides };
}

const cliModels = [
  {
    kind: 'local',
    modelId: 'cli:codex:default',
    costPer1kTokensUsd: 0,
    estLatencyMs: 900,
    quality: 0.88,
    viaCli: 'codex',
    accountLabel: 'huy@example.com',
    binaryPath: '/usr/bin/codex',
  },
];

test('picker: merges local + cloud, ranked by score', () => {
  const entries = buildPickerEntries(env());
  assert.ok(entries.length >= 10, `picker phai co nhieu muc, got ${entries.length}`);
  assert.ok(entries.some((e) => e.modelId === 'qwen3-4b' && e.source === 'local'));
  assert.ok(entries.some((e) => e.modelId === 'gemini-2.5-flash' && e.source === 'cloud'));
  // Sap xep giam dan theo score (trong nhom available).
  const available = entries.filter((e) => e.available);
  for (let i = 1; i < available.length; i += 1) {
    assert.ok(available[i - 1].score >= available[i].score, 'available phai sap xep giam dan theo score');
  }
  const summary = summarizePicker(entries);
  assert.equal(summary.total, entries.length);
  assert.ok(summary.bySource.local >= 1);
  assert.ok(summary.bySource.cloud >= 1);
  assert.ok(summary.cheapest);
  assert.ok(summary.fastest);
  assert.ok(summary.bestQuality);
});

test('picker: CLI entries show source + account label', () => {
  const entries = buildPickerEntries(env(), { cliModels });
  const cli = entries.find((e) => e.modelId === 'cli:codex:default');
  assert.ok(cli, 'picker phai co muc CLI');
  assert.equal(cli.source, 'cli');
  assert.equal(cli.viaCli, 'codex');
  assert.equal(cli.accountLabel, 'huy@example.com');
  assert.ok(cli.label.includes('codex'), cli.label);
  assert.ok(cli.label.includes('huy@example.com'), cli.label);
  assert.equal(cli.costPer1kTokensUsd, 0);
  const summary = summarizePicker(entries);
  assert.equal(summary.bySource.cli, 1);
});

test('picker: CLI entry without account label says so honestly', () => {
  const entries = buildPickerEntries(env(), {
    cliModels: [{ ...cliModels[0], accountLabel: undefined }],
  });
  const cli = entries.find((e) => e.modelId === 'cli:codex:default');
  assert.ok(cli.label.includes('chua ro tai khoan'), cli.label);
});

test('picker: task filtering marks unfit models unavailable with reason', () => {
  const task = {
    kind: 'code',
    promptTokens: 100,
    needsToolUse: true,
    needsLongContext: false,
    qualityNeed: 0.5,
  };
  // Het RAM: moi local deu bi loai co ly do, cloud van dung duoc.
  const entries = buildPickerEntries(env({ availableRamBytes: 0 }), { task });
  const local = entries.find((e) => e.modelId === 'qwen3-4b');
  assert.ok(local, 'qwen3-4b phai co trong picker');
  assert.equal(local.available, false);
  assert.ok(local.unavailableReason.includes('RAM'), local.unavailableReason);
  const available = availablePickerEntries(env({ availableRamBytes: 0 }), { task });
  assert.ok(available.every((e) => e.available));
  assert.ok(!available.some((e) => e.modelId === 'qwen3-4b'));
  assert.ok(available.length < entries.length);
  assert.ok(available.some((e) => e.source === 'cloud'));
});

test('picker: hideUnavailable + limit', () => {
  const task = {
    kind: 'code',
    promptTokens: 100,
    needsToolUse: true,
    needsLongContext: false,
    qualityNeed: 0.5,
  };
  const limited = buildPickerEntries(env(), { task, hideUnavailable: true, limit: 3 });
  assert.equal(limited.length, 3);
  assert.ok(limited.every((e) => e.available));
  const all = buildPickerEntries(env(), { task, limit: 0 });
  assert.ok(all.length > 3);
});

test('picker: empty entries summarize to nulls', () => {
  const summary = summarizePicker([]);
  assert.equal(summary.total, 0);
  assert.equal(summary.available, 0);
  assert.equal(summary.cheapest, null);
  assert.equal(summary.fastest, null);
  assert.equal(summary.bestQuality, null);
});

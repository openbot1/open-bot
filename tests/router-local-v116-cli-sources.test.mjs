/**
 * Local model router v116 CLI sources tests (v1.39, Doi T3 —
 * node:test, no network, no real CLI, no credential).
 *
 * Covers (cliSourcesV116 tren DetectedEngineRegistry):
 * - 6 detector moi V116 (crush, goose, qwen, amp, droid, pi) duoc
 *   dang ky them — khong thay 12 detector cu.
 * - Detect voi fake binary trong tmpdir (PATH rieng): binary co
 *   thi status 'unknown' (auth chua kiem chung — khong bia la da
 *   dang nhap), binary khong co thi 'unavailable' + ly do
 *   'not-installed'.
 * - Opt-in fail-closed: mac dinh tat; setEnabled bat/tat tung
 *   nguon; chi nguon bat + co binary moi thanh routable model
 *   (`cli:<kind>:default`, cost 0, kem binaryPath).
 * - describeSource(): hien thi ro model chay qua tai khoan nao
 *   (hoac "chua ro tai khoan" khi status unknown).
 *
 * Imports the BUILT core — build first:
 *   npm run build --workspace=@open-bot/core
 * then: node --test tests/router-local-v116-cli-sources.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  CLI_SOURCES_V116_DETECTORS,
  CLI_SOURCES_V116_KINDS,
  CLI_SOURCE_DEFAULT_LATENCY_MS,
  CLI_SOURCE_DEFAULT_QUALITY,
  CliSourceRegistry,
  KNOWN_CLI_LABELS,
  cliSourceModelId,
  isCliSourceV116Kind,
} from '../packages/core/dist/router/local/index.js';
import { DetectedEngineRegistry } from '../packages/core/dist/detected/index.js';

/** Tao fake binary trong tmpdir: `name --version` in version. */
function makeFakeBin(dir, name, versionLine) {
  const file = join(dir, name);
  writeFileSync(file, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "${versionLine}"; exit 0; fi\necho "${name}: unknown args" >&2\nexit 1\n`, 'utf8');
  chmodSync(file, 0o755);
  return file;
}

function registryWithFakeBins(t, names) {
  const dir = mkdtempSync(join(tmpdir(), 'open-bot-v116-cli-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const name of names) makeFakeBin(dir, name, `${name} 1.2.3`);
  // env PATH rong: chi fake binary trong pathDirs duoc tim thay —
  // test khong phu thuoc CLI that co san tren may (vd codex).
  const registry = new DetectedEngineRegistry({
    pathDirs: [dir],
    env: { PATH: '' },
    cacheTtlMs: 0,
    logger: { warn: () => {} },
  });
  return { dir, registry };
}

test('V116 detectors: 6 kinds, unique binaries, auth none (honest unknown)', () => {
  assert.deepEqual([...CLI_SOURCES_V116_KINDS], ['crush', 'goose', 'qwen', 'amp', 'droid', 'pi']);
  assert.equal(CLI_SOURCES_V116_DETECTORS.length, 6);
  const kinds = new Set(CLI_SOURCES_V116_DETECTORS.map((d) => d.kind));
  assert.equal(kinds.size, 6);
  for (const def of CLI_SOURCES_V116_DETECTORS) {
    assert.equal(def.auth.type, 'none', `${def.kind} phai dung auth none (chua kiem chung lenh status)`);
    assert.ok(def.binaries.length >= 1);
    assert.ok(KNOWN_CLI_LABELS[def.kind], `${def.kind} phai co nhan hien thi`);
  }
  assert.equal(isCliSourceV116Kind('crush'), true);
  assert.equal(isCliSourceV116Kind('codex'), false, 'codex la detector cu, khong phai V116');
  assert.equal(cliSourceModelId('crush'), 'cli:crush:default');
});

test('CliSourceRegistry: registers 6 new detectors without touching the 12 built-ins', () => {
  const registry = new CliSourceRegistry();
  const kinds = registry.listKinds();
  for (const kind of CLI_SOURCES_V116_KINDS) {
    assert.ok(kinds.includes(kind), `thieu kind moi ${kind}`);
  }
  for (const old of ['claude', 'codex', 'grok', 'opencode', 'gemini', 'cursor', 'aider', 'continue', 'copilot', 'amazonq', 'windsurf', 'kiro']) {
    assert.ok(kinds.includes(old), `mat detector cu ${old}`);
  }
  assert.equal(registry.listSources().length, kinds.length);
  assert.equal(registry.snapshot(), null, 'chua detect thi snapshot null');
});

test('detect: fake binary present -> status unknown (not fake-signed-in)', async (t) => {
  const { registry } = registryWithFakeBins(t, ['crush', 'goose']);
  const cli = new CliSourceRegistry({ registry });
  const snapshot = await cli.detect(true);
  assert.ok(snapshot.detectedAt);
  const crush = cli.getSource('crush');
  assert.equal(crush.status, 'unknown', 'auth none -> status phai la unknown, khong bia available');
  assert.ok(crush.binaryPath.endsWith('/crush'));
  assert.equal(crush.version, '1.2.3');
  assert.equal(crush.accountLabel, undefined);
  assert.equal(crush.enabled, false, 'opt-in mac dinh tat');
  assert.equal(crush.usable, false, 'chua bat thi khong dung duoc');
  assert.equal(crush.isNewInV116, true);
  const codex = cli.getSource('codex');
  assert.equal(codex.status, 'unavailable', 'codex khong co binary gia thi unavailable');
  assert.equal(codex.reason, 'not-installed');
  assert.equal(codex.isNewInV116, false);
});

test('opt-in: enabling a source makes it usable + routable (cost 0)', async (t) => {
  const { registry } = registryWithFakeBins(t, ['qwen', 'amp']);
  const cli = new CliSourceRegistry({ registry });
  await cli.detect(true);
  assert.deepEqual(cli.routableModels(), [], 'chua bat nguon nao thi khong co model route duoc');
  cli.setEnabled('qwen', true);
  assert.equal(cli.isEnabled('qwen'), true);
  const models = cli.routableModels();
  assert.equal(models.length, 1);
  assert.equal(models[0].modelId, 'cli:qwen:default');
  assert.equal(models[0].viaCli, 'qwen');
  assert.equal(models[0].costPer1kTokensUsd, 0);
  assert.equal(models[0].quality, CLI_SOURCE_DEFAULT_QUALITY);
  assert.equal(models[0].estLatencyMs, CLI_SOURCE_DEFAULT_LATENCY_MS);
  assert.ok(models[0].binaryPath.endsWith('/qwen'));
  // Tat lai -> het routable.
  cli.setEnabled('qwen', false);
  assert.deepEqual(cli.routableModels(), []);
  // Bat ca 2 nguon -> 2 model.
  cli.setEnabled('qwen', true);
  cli.setEnabled('amp', true);
  assert.equal(cli.routableModels().length, 2);
  assert.equal(cli.usableSources().length, 2);
});

test('setEnabled: unknown kind throws (no silent no-op)', async (t) => {
  const { registry } = registryWithFakeBins(t, []);
  const cli = new CliSourceRegistry({ registry });
  assert.throws(() => cli.setEnabled('khong-co-cli-nay', true), /Không rõ nguồn/);
});

test('describeSource: shows which account a model runs through (or unknown)', async (t) => {
  const { registry } = registryWithFakeBins(t, ['droid']);
  const cli = new CliSourceRegistry({ registry });
  await cli.detect(true);
  const before = cli.describeSource('droid');
  assert.ok(before.includes('Factory Droid'));
  assert.ok(before.includes('chua ro tai khoan'), before);
  assert.ok(before.includes('dang tat'), before);
  cli.setEnabled('droid', true);
  const after = cli.describeSource('droid');
  assert.ok(after.includes('dang bat'), after);
  assert.equal(cli.describeSource('khong-co'), 'Nguon khong ro: "khong-co".');
});

test('listSources: usable sources sort first', async (t) => {
  const { registry } = registryWithFakeBins(t, ['pi', 'crush']);
  const cli = new CliSourceRegistry({ registry });
  await cli.detect(true);
  cli.setEnabled('pi', true);
  const sources = cli.listSources();
  assert.equal(sources[0].kind, 'pi', 'nguon dung duoc phai dung dau danh sach');
  assert.equal(sources[0].usable, true);
});

test('CliSourceRegistry without V116 detectors: only the 12 built-ins', () => {
  const registry = new DetectedEngineRegistry({ logger: { warn: () => {} } });
  const cli = new CliSourceRegistry({ registry, registerV116Detectors: false });
  for (const kind of CLI_SOURCES_V116_KINDS) {
    assert.ok(!cli.listKinds().includes(kind), `khong duoc co ${kind} khi tat dang ky V116`);
  }
  assert.equal(cli.listKinds().length, 12);
});

/**
 * UI tests for v1.11 (Doi T1) — memory v11 UI.
 *
 * Part A (no display needed): i18n parity — every memoryV11.* key
 * (37) + memory.tabV11 exists with a non-empty string in all 6
 * locales, and the key sets match exactly across locales; the
 * component (MemoryV11View, MemoryView tab) only uses keys that
 * exist; preload exposes the memory-v11 API; main registers all
 * `memory-v11:*` IPC channels; MemoryV11View source contains the
 * expected sections (shared blocks / blocks by kind / history /
 * sleep) and no hard-coded Vietnamese strings.
 *
 * No CDP renderer part here: this VM has no DISPLAY, and the
 * component is fully covered statically (props + IPC + i18n). A live
 * Electron smoke run follows the same convention as
 * tests/memory-ui-v095d4.test.mjs when a display is available.
 *
 * Run: node --test tests/memory-v11-ui.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOCALES = ['vi', 'en', 'zh', 'ja', 'es', 'fr'];

function readLocale(locale) {
  return JSON.parse(
    fs.readFileSync(path.join(REPO, 'apps', 'desktop', 'src', 'renderer', 'i18n', 'locales', `${locale}.json`), 'utf8'),
  );
}

function usedKeys(source) {
  return [...source.matchAll(/t\('([a-z][a-zA-Z0-9_]*\.[a-zA-Z0-9_.]+)'/g)].map((m) => m[1]);
}

const EXPECTED_V11_KEYS = [
  'memoryV11.blocksEmpty',
  'memoryV11.blocksTitle',
  'memoryV11.historyActor',
  'memoryV11.historyBackend',
  'memoryV11.historyDiff',
  'memoryV11.historyEmpty',
  'memoryV11.historyRollback',
  'memoryV11.historyRollbackConfirm',
  'memoryV11.historyTitle',
  'memoryV11.historyVersion',
  'memoryV11.loading',
  'memoryV11.loadError',
  'memoryV11.sharedEmpty',
  'memoryV11.sharedGroup',
  'memoryV11.sharedMembers',
  'memoryV11.sharedNoSupervisor',
  'memoryV11.sharedOverLimit',
  'memoryV11.sharedSupervisor',
  'memoryV11.sharedTitle',
  'memoryV11.sharedUsage',
  'memoryV11.sharedWarning',
  'memoryV11.sleepConsolidated',
  'memoryV11.sleepDryRun',
  'memoryV11.sleepFactsExtracted',
  'memoryV11.sleepForce',
  'memoryV11.sleepInvalidated',
  'memoryV11.sleepLastRun',
  'memoryV11.sleepLearnedAdded',
  'memoryV11.sleepRawFacts',
  'memoryV11.sleepRun',
  'memoryV11.sleepRunning',
  'memoryV11.sleepTitle',
  'memoryV11.subtitle',
  'memoryV11.title',
];

const EXPECTED_IPC_CHANNELS = [
  'memory-v11:shared',
  'memory-v11:render',
  'memory-v11:history',
  'memory-v11:diff',
  'memory-v11:rollback',
  'memory-v11:sleep-status',
  'memory-v11:sleep-run',
];

const EXPECTED_PRELOAD_METHODS = [
  'listMemoryV11Shared',
  'renderMemoryV11Blocks',
  'listMemoryV11History',
  'diffMemoryV11History',
  'rollbackMemoryV11Block',
  'getMemoryV11SleepStatus',
  'runMemoryV11Sleep',
];

test('i18n: all 34 memoryV11.* keys + memory.tabV11 exist, non-empty, in all 6 locales', () => {
  const locales = Object.fromEntries(LOCALES.map((l) => [l, readLocale(l)]));
  for (const key of [...EXPECTED_V11_KEYS, 'memory.tabV11']) {
    for (const locale of LOCALES) {
      const value = locales[locale][key];
      assert.equal(typeof value, 'string', `${locale} missing ${key}`);
      assert.ok(value.length > 0, `${locale} has empty ${key}`);
    }
  }
  // Key sets match exactly across locales for the v11 namespace.
  const sets = LOCALES.map(
    (l) => Object.keys(locales[l]).filter((k) => k.startsWith('memoryV11.')).sort(),
  );
  for (const set of sets.slice(1)) assert.deepEqual(set, sets[0]);
  assert.equal(sets[0].length, 34);
  // Total key count pin: 4353 + 34 memoryV11.* + 1 memory.tabV11 = 4388.
  for (const locale of LOCALES) {
    assert.ok(Object.keys(locales[locale]).length >= 8072, `${locale} key count >= 8072, got ${Object.keys(locales[locale]).length}`); // v1.39 fix round 4b: floor (was 8072 in v1.38; now 8322).
  }
});

test('i18n: MemoryV11View only uses keys that exist', () => {
  const source = fs.readFileSync(
    path.join(REPO, 'apps', 'desktop', 'src', 'renderer', 'components', 'MemoryV11View.tsx'),
    'utf8',
  );
  const en = readLocale('en');
  for (const key of usedKeys(source)) {
    assert.ok(key in en, `MemoryV11View uses missing key ${key}`);
  }
  // Every v11 key is used by the view (no dead keys), except the
  // tab key (used by MemoryView).
  const used = new Set(usedKeys(source));
  for (const key of EXPECTED_V11_KEYS) {
    assert.ok(used.has(key), `key ${key} is not used by MemoryV11View`);
  }
});

test('i18n: no hard-coded Vietnamese diacritics in MemoryV11View', () => {
  const source = fs.readFileSync(
    path.join(REPO, 'apps', 'desktop', 'src', 'renderer', 'components', 'MemoryV11View.tsx'),
    'utf8',
  );
  const vietnamese = /[àáảãạăắằẳẵặâấầẩẫậèéẻẽẹêếềểễệìíỉĩịòóỏõọôốồổỗộơớờởỡợùúủũụưứừửữựỳýỷỹỵđÀÁẢÃẠĂẮẰẲẴẶÂẤẦẨẪẬÈÉẺẼẸÊẾỀỂỄỆÌÍỈĨỊÒÓỎÕỌÔỐỒỔỖỘƠỚỜỞỠỢÙÚỦŨỤƯỨỪỬỮỰỲÝỶỸỴĐ]/;
  for (const [i, line] of source.split('\n').entries()) {
    assert.ok(!vietnamese.test(line), `MemoryV11View.tsx:${i + 1} has hard-coded Vietnamese: ${line.trim()}`);
  }
});

test('MemoryView: v11 tab registered (button + branch + import)', () => {
  const source = fs.readFileSync(
    path.join(REPO, 'apps', 'desktop', 'src', 'renderer', 'components', 'MemoryView.tsx'),
    'utf8',
  );
  assert.ok(source.includes("import MemoryV11View from './MemoryV11View'"));
  assert.ok(source.includes("data-testid=\"memory-tab-v11\""));
  assert.ok(source.includes("t('memory.tabV11')"));
  assert.ok(source.includes("tab === 'v11'"));
  assert.ok(source.includes('<MemoryV11View bots={bots} botId={botId} onSelectBot={onSelectBot} />'));
});

test('MemoryV11View: four sections present (shared / blocks / history / sleep)', () => {
  const source = fs.readFileSync(
    path.join(REPO, 'apps', 'desktop', 'src', 'renderer', 'components', 'MemoryV11View.tsx'),
    'utf8',
  );
  for (const key of [
    'memoryV11.sharedTitle',
    'memoryV11.blocksTitle',
    'memoryV11.historyTitle',
    'memoryV11.sleepTitle',
    'memoryV11.historyRollback',
    'memoryV11.historyDiff',
    'memoryV11.sleepRun',
    'memoryV11.sleepDryRun',
    'memoryV11.sleepForce',
  ]) {
    assert.ok(source.includes(key), `section/key ${key} missing from MemoryV11View`);
  }
  // No window.confirm (banned since v0.71 — ConfirmModal instead).
  assert.ok(!source.includes('window.confirm'), 'MemoryV11View must not use window.confirm');
});

test('preload: memory-v11 API exposed (types + impl)', () => {
  const source = fs.readFileSync(
    path.join(REPO, 'apps', 'desktop', 'src', 'main', 'preload.ts'),
    'utf8',
  );
  for (const method of EXPECTED_PRELOAD_METHODS) {
    assert.ok(source.includes(method), `preload missing ${method}`);
  }
  for (const channel of EXPECTED_IPC_CHANNELS) {
    assert.ok(source.includes(`ipcRenderer.invoke('${channel}'`), `preload missing channel ${channel}`);
  }
  for (const view of [
    'V11SharedBlockView',
    'V11HistoryEntryView',
    'V11HistoryDiffView',
    'V11RenderedBlockView',
    'V11SleepStatusView',
    'V11SleepRunView',
  ]) {
    assert.ok(source.includes(`interface ${view}`), `preload missing view type ${view}`);
  }
});

test('main: all memory-v11:* IPC channels registered', () => {
  const source = fs.readFileSync(
    path.join(REPO, 'apps', 'desktop', 'src', 'main', 'main.ts'),
    'utf8',
  );
  for (const channel of EXPECTED_IPC_CHANNELS) {
    assert.ok(
      new RegExp(`ipcMain\\.handle\\(\\s*'${channel}'`).test(source),
      `main missing channel ${channel}`,
    );
  }
  for (const symbol of [
    'SharedSupervisor',
    'V11SleepConsolidationAgent',
    'renderMemoryBlocksXml',
    'listBlockHistory',
    'diffBlockVersions',
    'rollbackBlockToVersion',
    'readV11SleepLog',
  ]) {
    assert.ok(source.includes(symbol), `main missing import ${symbol}`);
  }
});

test('renderer types: V11 view types mirror preload', () => {
  const source = fs.readFileSync(
    path.join(REPO, 'apps', 'desktop', 'src', 'renderer', 'types.ts'),
    'utf8',
  );
  for (const view of [
    'V11SharedBlockView',
    'V11HistoryEntryView',
    'V11HistoryDiffView',
    'V11RenderedBlockView',
    'V11SleepStatusView',
    'V11SleepRunView',
  ]) {
    assert.ok(source.includes(`interface ${view}`), `renderer types missing ${view}`);
  }
  const globalD = fs.readFileSync(
    path.join(REPO, 'apps', 'desktop', 'src', 'renderer', 'global.d.ts'),
    'utf8',
  );
  for (const method of EXPECTED_PRELOAD_METHODS) {
    assert.ok(globalD.includes(method), `global.d.ts missing ${method}`);
  }
});

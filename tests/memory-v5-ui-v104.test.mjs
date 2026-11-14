/**
 * UI tests for v1.04 (Team T1) — memory v5 UI.
 *
 * Part A (no display needed): i18n parity — every memory.v5.* and
 * memory.tabV5 key exists with a non-empty string in all 6 locales,
 * and the key sets match exactly across locales; the MemoryV5View
 * and MemoryView tab only use keys that exist; preload exposes the
 * memory-v5 API; main registers both `memory-v5:*` IPC channels;
 * MemoryV5View source contains the expected data-testids (health
 * score + metrics + issues, contradiction groups, runs list, run
 * consolidation button) so the renderer smoke tests of other waves
 * can drive it.
 *
 * No CDP renderer part here: this VM has no DISPLAY, and the
 * component is fully covered statically (props + IPC + i18n).
 *
 * Run: node --test tests/memory-v5-ui-v104.test.mjs
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

function read(rel) {
  return fs.readFileSync(path.join(REPO, ...rel), 'utf8');
}

function usedKeys(source) {
  // Key i18n luôn có dạng namespace.key (chứa dấu chấm).
  return [...source.matchAll(/t\('([a-z][a-zA-Z0-9_]*\.[a-zA-Z0-9_.]+)'/g)].map((m) => m[1]);
}

test('i18n parity: memory.v5.* + memory.tabV5 có đủ 6 locale, không rỗng', () => {
  const locales = Object.fromEntries(LOCALES.map((l) => [l, readLocale(l)]));
  const v5Keys = Object.keys(locales.en).filter((k) => k === 'memory.tabV5' || k.startsWith('memory.v5.'));
  assert.equal(v5Keys.length, 38, `expected 38 v5 keys, got ${v5Keys.length}`);
  for (const key of v5Keys) {
    for (const locale of LOCALES) {
      assert.ok(key in locales[locale], `${locale} thiếu key ${key}`);
      assert.equal(typeof locales[locale][key], 'string', `${locale}.${key} phải là string`);
      assert.ok(locales[locale][key].trim() !== '', `${locale}.${key} rỗng`);
    }
  }
  for (const locale of LOCALES.slice(1)) {
    const keys = Object.keys(locales[locale]).filter((k) => k === 'memory.tabV5' || k.startsWith('memory.v5.'));
    assert.deepEqual(keys.sort(), [...v5Keys].sort(), `key set v5 lệch ở ${locale}`);
  }
});

test('MemoryV5View + MemoryView chỉ dùng key i18n đã tồn tại', () => {
  const en = readLocale('en');
  const view = read(['apps', 'desktop', 'src', 'renderer', 'components', 'MemoryV5View.tsx']);
  const memoryView = read(['apps', 'desktop', 'src', 'renderer', 'components', 'MemoryView.tsx']);
  for (const key of usedKeys(view)) {
    assert.ok(key in en, `MemoryV5View dùng key chưa có: ${key}`);
  }
  for (const key of usedKeys(memoryView)) {
    assert.ok(key in en, `MemoryView dùng key chưa có: ${key}`);
  }
  assert.ok(view.includes("t('memory.v5.intro')"));
  assert.ok(view.includes("t('memory.v5.runConsolidation')"));
  assert.ok(memoryView.includes("t('memory.tabV5')"));
});

test('preload expose API memory-v5 + main đăng ký đủ 3 kênh IPC', () => {
  const preload = read(['apps', 'desktop', 'src', 'main', 'preload.ts']);
  assert.ok(preload.includes('getMemoryV5Health'), 'preload thiếu getMemoryV5Health');
  assert.ok(preload.includes('runMemoryV5Consolidation'), 'preload thiếu runMemoryV5Consolidation');
  assert.ok(preload.includes('queryMemoryV5BiTemporal'), 'preload thiếu queryMemoryV5BiTemporal');
  assert.ok(preload.includes("ipcRenderer.invoke('memory-v5:health'"), 'preload thiếu invoke memory-v5:health');
  assert.ok(preload.includes("ipcRenderer.invoke('memory-v5:consolidate'"), 'preload thiếu invoke memory-v5:consolidate');
  assert.ok(preload.includes("ipcRenderer.invoke('memory-v5:bitemporal'"), 'preload thiếu invoke memory-v5:bitemporal');
  assert.ok(preload.includes('MemoryV5HealthView'), 'preload thiếu type MemoryV5HealthView');
  assert.ok(preload.includes('MemoryV5ContradictionGroupView'), 'preload thiếu type MemoryV5ContradictionGroupView');
  assert.ok(preload.includes('MemoryV5ConsolidationRunView'), 'preload thiếu type MemoryV5ConsolidationRunView');
  assert.ok(preload.includes('MemoryV5BiTemporalRowView'), 'preload thiếu type MemoryV5BiTemporalRowView');
  const main = read(['apps', 'desktop', 'src', 'main', 'main.ts']);
  assert.ok(main.includes("ipcMain.handle('memory-v5:health'"), 'main thiếu handler memory-v5:health');
  assert.ok(main.includes("ipcMain.handle(\n    'memory-v5:consolidate'"), 'main thiếu handler memory-v5:consolidate');
  assert.ok(main.includes("'memory-v5:bitemporal'"), 'main thiếu handler memory-v5:bitemporal');
  assert.ok(main.includes('computeMemoryHealth'), 'main chưa import computeMemoryHealth');
  assert.ok(main.includes('runConsolidationV2'), 'main chưa import runConsolidationV2');
  assert.ok(main.includes('readConsolidationV2Log'), 'main chưa import readConsolidationV2Log');
  assert.ok(main.includes('queryFactsAtBiTemporal'), 'main chưa import queryFactsAtBiTemporal');
});

test('MemoryV5View có đủ testid: score, metrics, issues, contradictions, runs, run button, bitemporal', () => {
  const view = read(['apps', 'desktop', 'src', 'renderer', 'components', 'MemoryV5View.tsx']);
  for (const testid of [
    'memory-v5-view',
    'memory-v5-bot-select',
    'memory-v5-refresh',
    'memory-v5-run-consolidation',
    'memory-v5-score',
    'memory-v5-metrics',
    'memory-v5-issues',
    'memory-v5-contradictions',
    'memory-v5-runs',
    'memory-v5-at-date',
    'memory-v5-query-at',
    'memory-v5-facts-at',
  ]) {
    assert.ok(view.includes(`data-testid="${testid}"`), `thiếu testid ${testid}`);
  }
  assert.ok(view.includes('getMemoryV5Health'), 'view chưa gọi getMemoryV5Health');
  assert.ok(view.includes('runMemoryV5Consolidation'), 'view chưa gọi runMemoryV5Consolidation');
  assert.ok(view.includes('queryMemoryV5BiTemporal'), 'view chưa gọi queryMemoryV5BiTemporal');
});

test('MemoryView mount tab v5 + renderer types có đủ 3 view v5', () => {
  const memoryView = read(['apps', 'desktop', 'src', 'renderer', 'components', 'MemoryView.tsx']);
  assert.ok(memoryView.includes("import MemoryV5View from './MemoryV5View'"), 'MemoryView chưa import MemoryV5View');
  assert.ok(memoryView.includes("data-testid=\"memory-tab-v5\""), 'MemoryView thiếu nút tab v5');
  assert.ok(memoryView.includes('<MemoryV5View '), 'MemoryView chưa render MemoryV5View');
  const types = read(['apps', 'desktop', 'src', 'renderer', 'types.ts']);
  assert.ok(types.includes('MemoryV5HealthView'), 'types thiếu MemoryV5HealthView');
  assert.ok(types.includes('MemoryV5ContradictionGroupView'), 'types thiếu MemoryV5ContradictionGroupView');
  assert.ok(types.includes('MemoryV5ConsolidationRunView'), 'types thiếu MemoryV5ConsolidationRunView');
  assert.ok(types.includes("grade: 'excellent' | 'good' | 'fair' | 'poor'"), 'types thiếu grade union');
  const globalDts = read(['apps', 'desktop', 'src', 'renderer', 'global.d.ts']);
  assert.ok(globalDts.includes('getMemoryV5Health'), 'global.d.ts thiếu getMemoryV5Health');
  assert.ok(globalDts.includes('runMemoryV5Consolidation'), 'global.d.ts thiếu runMemoryV5Consolidation');
  assert.ok(globalDts.includes('queryMemoryV5BiTemporal'), 'global.d.ts thiếu queryMemoryV5BiTemporal');
  assert.ok(globalDts.includes('MemoryV5HealthView'), 'global.d.ts chưa import MemoryV5HealthView');
  assert.ok(globalDts.includes('MemoryV5BiTemporalRowView'), 'global.d.ts chưa import MemoryV5BiTemporalRowView');
});

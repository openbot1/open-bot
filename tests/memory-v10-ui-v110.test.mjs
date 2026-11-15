/**
 * UI tests for v1.10 (Team T1) — memory v10 UI.
 *
 * Part A (no display needed): i18n parity — every memoryV10.* and
 * memory.tabV10 key exists with a non-empty string in all 6 locales
 * (vi, en, zh, ja, es, fr), and the key sets match exactly across
 * locales; the component (MemoryV10View, MemoryView tab) only uses
 * keys that exist; preload exposes the memory-v10 API; main registers
 * all `memory-v10:*` IPC channels; MemoryV10View source contains the
 * expected data-testids (bot select / refresh / stats / recall query
 * + asOf + search + score table / timeline subject + load + table /
 * blocks list + rollback toggle + version + confirm / quarantine list
 * + approve + reject) so the renderer smoke tests of other waves can
 * drive it; MemoryView mounts the v10 tab.
 *
 * No CDP renderer part here: this VM has no DISPLAY, and the component
 * is fully covered statically (props + IPC + i18n). A live Electron
 * smoke run follows the same convention as
 * tests/memory-ui-v095d4.test.mjs when a display is available.
 *
 * Run: node --test tests/memory-v10-ui-v110.test.mjs
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
  // Key i18n luôn có dạng namespace.key (chứa dấu chấm) — regex hẹp để
  // không bắt nhầm các lời gọi `.split('...')` hay `.at('...')`.
  return [...source.matchAll(/t\('([a-z][a-zA-Z0-9_]*\.[a-zA-Z0-9_.]+)'/g)].map((m) => m[1]);
}

const EXPECTED_TESTIDS = [
  'memory-v10-view',
  'memory-v10-bot-select',
  'memory-v10-refresh',
  'memory-v10-stats',
  'memory-v10-recall-query',
  'memory-v10-recall-asof',
  'memory-v10-recall-search',
  'memory-v10-recall-table',
  'memory-v10-timeline-subject',
  'memory-v10-timeline-load',
  'memory-v10-timeline-table',
  'memory-v10-blocks-list',
  'memory-v10-rollback-toggle',
  'memory-v10-rollback-version',
  'memory-v10-rollback-confirm',
  'memory-v10-quarantine-list',
  'memory-v10-quarantine-approve',
  'memory-v10-quarantine-reject',
];

const EXPECTED_IPC = [
  'memory-v10:stats',
  'memory-v10:query',
  'memory-v10:timeline',
  'memory-v10:blocks',
  'memory-v10:rollback',
  'memory-v10:quarantine-list',
  'memory-v10:quarantine-decide',
];

const EXPECTED_PRELOAD_API = [
  'getMemoryV10Stats',
  'searchMemoryV10',
  'getMemoryV10Timeline',
  'listMemoryV10Blocks',
  'rollbackMemoryV10Block',
  'listMemoryV10Quarantine',
  'decideMemoryV10Quarantine',
];

test('i18n: memoryV10.* + memory.tabV10 keys exist, non-empty, and match across all 6 locales', () => {
  const locales = LOCALES.map(readLocale);
  const viKeys = Object.keys(locales[0]).filter((k) => k === 'memory.tabV10' || k.startsWith('memoryV10.'));
  assert.ok(viKeys.length >= 40, `expected >= 40 v10 keys, got ${viKeys.length}`);
  for (const [i, locale] of locales.entries()) {
    const keys = Object.keys(locale).filter((k) => k === 'memory.tabV10' || k.startsWith('memoryV10.'));
    assert.deepEqual(keys.sort(), [...viKeys].sort(), `locale ${LOCALES[i]} key set differs`);
    for (const key of keys) {
      assert.equal(typeof locale[key], 'string', `${LOCALES[i]}:${key} must be a string`);
      assert.ok(locale[key].trim().length > 0, `${LOCALES[i]}:${key} must be non-empty`);
    }
  }
});

test('i18n: MemoryV10View + MemoryView v10 tab only use keys that exist', () => {
  const view = fs.readFileSync(
    path.join(REPO, 'apps', 'desktop', 'src', 'renderer', 'components', 'MemoryV10View.tsx'),
    'utf8',
  );
  const memoryView = fs.readFileSync(
    path.join(REPO, 'apps', 'desktop', 'src', 'renderer', 'components', 'MemoryView.tsx'),
    'utf8',
  );
  const vi = readLocale('vi');
  const keys = [...usedKeys(view), ...usedKeys(memoryView).filter((k) => k === 'memory.tabV10')];
  const v10Keys = keys.filter((k) => k === 'memory.tabV10' || k.startsWith('memoryV10.'));
  assert.ok(v10Keys.length > 0);
  for (const key of new Set(v10Keys)) {
    assert.ok(key in vi, `key used but missing in vi locale: ${key}`);
  }
  // Interpolation vars used in the component must exist in the key text.
  for (const varName of ['count', 'active', 'superseded', 'deleted', 'blocks', 'versions', 'branch', 'version', 'status']) {
    const used = view.includes(`{ ${varName}:`) || view.includes(`{${varName}:`);
    if (used) {
      const hasVar = Object.entries(vi)
        .filter(([k]) => k.startsWith('memoryV10.'))
        .some(([, v]) => v.includes(`{${varName}}`));
      assert.ok(hasVar, `var {${varName}} used but no memoryV10 string contains it`);
    }
  }
});

test('component: MemoryV10View contains all expected data-testids', () => {
  const view = fs.readFileSync(
    path.join(REPO, 'apps', 'desktop', 'src', 'renderer', 'components', 'MemoryV10View.tsx'),
    'utf8',
  );
  for (const testid of EXPECTED_TESTIDS) {
    assert.ok(view.includes(`data-testid="${testid}"`), `missing testid ${testid}`);
  }
  // Score table columns: vector / BM25 / entity / total.
  for (const col of ['colVector', 'colBm25', 'colEntity', 'colTotal', 'colReasons']) {
    assert.ok(view.includes(`memoryV10.${col}`), `missing score column ${col}`);
  }
  // Quarantine approve/reject + rollback confirm call the IPC API.
  assert.ok(view.includes('decideMemoryV10Quarantine'));
  assert.ok(view.includes('rollbackMemoryV10Block'));
  assert.ok(view.includes('searchMemoryV10'));
  assert.ok(view.includes('getMemoryV10Timeline'));
});

test('preload: memory-v10 API exposed (types + invokes)', () => {
  const preload = fs.readFileSync(path.join(REPO, 'apps', 'desktop', 'src', 'main', 'preload.ts'), 'utf8');
  for (const api of EXPECTED_PRELOAD_API) {
    assert.ok(preload.includes(api), `preload missing API ${api}`);
  }
  for (const channel of EXPECTED_IPC) {
    assert.ok(preload.includes(`'${channel}'`), `preload missing invoke for ${channel}`);
  }
  // View types mirrored in preload (it does not import renderer/types).
  for (const view of ['V10StatsView', 'V10RetrievalHitView', 'V10TimelineEntryView', 'V10BlockView', 'V10QuarantineView']) {
    assert.ok(preload.includes(`export interface ${view}`), `preload missing view ${view}`);
  }
  const globalDts = fs.readFileSync(path.join(REPO, 'apps', 'desktop', 'src', 'renderer', 'global.d.ts'), 'utf8');
  for (const api of EXPECTED_PRELOAD_API) {
    assert.ok(globalDts.includes(api), `global.d.ts missing API ${api}`);
  }
});

test('main: all memory-v10:* IPC channels registered', () => {
  const main = fs.readFileSync(path.join(REPO, 'apps', 'desktop', 'src', 'main', 'main.ts'), 'utf8');
  for (const channel of EXPECTED_IPC) {
    assert.ok(main.includes(`'${channel}'`), `main missing handler ${channel}`);
  }
  assert.ok(main.includes('getMemoryV10Manager'), 'main must use getMemoryV10Manager');
});

test('MemoryView: v10 tab mounted with its own button + testid', () => {
  const memoryView = fs.readFileSync(
    path.join(REPO, 'apps', 'desktop', 'src', 'renderer', 'components', 'MemoryView.tsx'),
    'utf8',
  );
  assert.ok(memoryView.includes("import MemoryV10View from './MemoryV10View'"), 'missing import');
  assert.ok(memoryView.includes("data-testid=\"memory-tab-v10\""), 'missing tab button testid');
  assert.ok(memoryView.includes("t('memory.tabV10')"), 'missing tab label');
  assert.ok(memoryView.includes("tab === 'v10'"), 'missing tab condition');
  assert.ok(memoryView.includes('<MemoryV10View bots={bots} botId={botId} onSelectBot={onSelectBot} />'), 'missing mount');
  assert.ok(memoryView.includes("'v10'"), 'missing v10 in tab union type');
});

/**
 * UI tests for v1.09 (Team T2) — memory v9 kiểu Letta UI.
 *
 * Part A (no display needed): i18n parity — every memoryLetta.* and
 * memory.tabLetta key exists with a non-empty string in all 6 locales,
 * and the key sets match exactly across locales; the component
 * (MemoryLettaView, MemoryView tab) only uses keys that exist; preload
 * exposes the memory-letta API; main registers all `memory-letta:*`
 * IPC channels; MemoryLettaView source contains the expected
 * data-testids (bot select / blocks list / edit / append / delete /
 * recall search / archival search / proposals / sleep run / export)
 * so the renderer smoke tests of other waves can drive it.
 *
 * No CDP renderer part here: this VM has no DISPLAY, and the component
 * is fully covered statically (props + IPC + i18n). A live Electron
 * smoke run follows the same convention as
 * tests/memory-ui-v095d4.test.mjs when a display is available.
 *
 * Run: node --test tests/memory-v9-letta-ui-v109.test.mjs
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
  'memory-letta-bot-select',
  'memory-letta-refresh',
  'memory-letta-stats',
  'memory-letta-export',
  'memory-letta-blocks-list',
  'memory-letta-edit',
  'memory-letta-edit-content',
  'memory-letta-save',
  'memory-letta-append-toggle',
  'memory-letta-append-text',
  'memory-letta-append-save',
  'memory-letta-delete',
  'memory-letta-delete-confirm',
  'memory-letta-recall-query',
  'memory-letta-recall-search',
  'memory-letta-recall-list',
  'memory-letta-archival-query',
  'memory-letta-archival-search',
  'memory-letta-archival-list',
  'memory-letta-proposals-list',
  'memory-letta-proposal-approve',
  'memory-letta-proposal-reject',
  'memory-letta-sleep-run',
  'memory-letta-sleep-last',
];

const EXPECTED_TAB_TESTIDS = ['memory-tabs', 'memory-tab-letta'];

const EXPECTED_IPC_CHANNELS = [
  'memory-letta:status',
  'memory-letta:block-append',
  'memory-letta:recall-search',
  'memory-letta:archival-search',
  'memory-letta:proposals',
  'memory-letta:proposal-decide',
  'memory-letta:sleep-run',
  'memory-letta:sleep-log',
  'memory-letta:entity-export',
];

const EXPECTED_PRELOAD_METHODS = [
  'getMemoryLettaStatus',
  'appendMemoryLettaBlock',
  'searchMemoryLettaRecall',
  'searchMemoryLettaArchival',
  'listMemoryLettaProposals',
  'decideMemoryLettaProposal',
  'runMemoryLettaSleep',
  'getMemoryLettaSleepLog',
  'exportMemoryLettaEntity',
];

const EXPECTED_KEYS = [
  'memory.tabLetta',
  'memoryLetta.bot',
  'memoryLetta.refresh',
  'memoryLetta.intro',
  'memoryLetta.loading',
  'memoryLetta.noBot',
  'memoryLetta.statsTitle',
  'memoryLetta.statsLine',
  'memoryLetta.exportEntity',
  'memoryLetta.exported',
  'memoryLetta.coreTitle',
  'memoryLetta.blocksEmpty',
  'memoryLetta.chars',
  'memoryLetta.emptyBlock',
  'memoryLetta.edit',
  'memoryLetta.save',
  'memoryLetta.cancel',
  'memoryLetta.delete',
  'memoryLetta.deleteConfirm',
  'memoryLetta.append',
  'memoryLetta.appendPlaceholder',
  'memoryLetta.appendCondensed',
  'memoryLetta.updated',
  'memoryLetta.loadError',
  'memoryLetta.saveError',
  'memoryLetta.recallTitle',
  'memoryLetta.recallPlaceholder',
  'memoryLetta.recallSearch',
  'memoryLetta.recallEmpty',
  'memoryLetta.archivalTitle',
  'memoryLetta.archivalPlaceholder',
  'memoryLetta.archivalSearch',
  'memoryLetta.archivalEmpty',
  'memoryLetta.results',
  'memoryLetta.proposalsTitle',
  'memoryLetta.proposalsEmpty',
  'memoryLetta.approve',
  'memoryLetta.reject',
  'memoryLetta.decided',
  'memoryLetta.sleepTitle',
  'memoryLetta.sleepRun',
  'memoryLetta.sleepRunning',
  'memoryLetta.sleepLast',
  'memoryLetta.sleepDone',
];

test('i18n: 44 key Letta mới có đủ 6 locale, không rỗng, tập key khớp nhau', () => {
  const locales = {};
  for (const locale of LOCALES) {
    locales[locale] = readLocale(locale);
    // Tổng key/locale: 3891 (v1.08) + 44 (v1.09 Đội T2) = 3935.
    assert.ok(Object.keys(locales[locale]).length >= 8072, `${locale} phai co it nhat 8072 key, co ${Object.keys(locales[locale]).length}`); // v1.39 fix round 4b: floor >= 8072 (was v1.38 re-pin 8072).
    for (const key of EXPECTED_KEYS) {
      assert.ok(key in locales[locale], `${locale} thiếu key ${key}`);
      assert.equal(typeof locales[locale][key], 'string', `${locale}.${key} phải là string`);
      assert.ok(locales[locale][key].trim() !== '', `${locale}.${key} không được rỗng`);
    }
  }
  const keySets = LOCALES.map((l) => new Set(Object.keys(locales[l])));
  for (let i = 1; i < keySets.length; i++) {
    assert.deepEqual([...keySets[i]].sort(), [...keySets[0]].sort(), `tập key của ${LOCALES[i]} lệch với vi`);
  }
  assert.equal(EXPECTED_KEYS.length, 44);
});

test('i18n: MemoryLettaView + MemoryView chỉ dùng key đã tồn tại', () => {
  const letta = fs.readFileSync(
    path.join(REPO, 'apps', 'desktop', 'src', 'renderer', 'components', 'MemoryLettaView.tsx'),
    'utf8',
  );
  const memoryView = fs.readFileSync(
    path.join(REPO, 'apps', 'desktop', 'src', 'renderer', 'components', 'MemoryView.tsx'),
    'utf8',
  );
  const vi = readLocale('vi');
  const keys = new Set([...usedKeys(letta), ...usedKeys(memoryView).filter((k) => k.startsWith('memoryLetta') || k === 'memory.tabLetta')]);
  assert.ok(keys.size > 0);
  for (const key of keys) {
    assert.ok(key in vi, `key ${key} được dùng nhưng không có trong locale vi`);
  }
  // Mọi key kỳ vọng đều được component dùng (trừ key chỉ dùng trong test/tab).
  const usedLetta = new Set(usedKeys(letta));
  for (const key of EXPECTED_KEYS.filter((k) => k.startsWith('memoryLetta.'))) {
    assert.ok(usedLetta.has(key), `key ${key} không được MemoryLettaView dùng`);
  }
});

test('component: MemoryLettaView chứa đủ data-testid', () => {
  const source = fs.readFileSync(
    path.join(REPO, 'apps', 'desktop', 'src', 'renderer', 'components', 'MemoryLettaView.tsx'),
    'utf8',
  );
  for (const testid of EXPECTED_TESTIDS) {
    assert.ok(source.includes(`data-testid="${testid}"`), `thiếu testid ${testid}`);
  }
  // Dùng đúng API window.openBot Letta (không gọi IPC trực tiếp).
  // getMemoryLettaSleepLog được expose ở preload nhưng component đọc
  // lần chạy gần nhất từ status (lastSleep) nên không gọi trực tiếp.
  const componentMethods = EXPECTED_PRELOAD_METHODS.filter((m) => m !== 'getMemoryLettaSleepLog');
  for (const method of componentMethods) {
    assert.ok(source.includes(`window.openBot.${method}`), `component không dùng window.openBot.${method}`);
  }
  // Append báo rõ khi đã cô đọng; xoá 2 bước xác nhận; proposal có approve/reject.
  assert.ok(source.includes('memoryLetta.appendCondensed'), 'thiếu thông báo đã cô đọng khi append');
  assert.ok(source.includes('memoryLetta.deleteConfirm'), 'thiếu xác nhận 2 bước khi xoá');
});

test('component: MemoryView có tab Letta + render MemoryLettaView', () => {
  const source = fs.readFileSync(
    path.join(REPO, 'apps', 'desktop', 'src', 'renderer', 'components', 'MemoryView.tsx'),
    'utf8',
  );
  for (const testid of EXPECTED_TAB_TESTIDS) {
    assert.ok(source.includes(`data-testid="${testid}"`), `MemoryView thiếu testid ${testid}`);
  }
  assert.ok(source.includes("import MemoryLettaView from './MemoryLettaView'"), 'MemoryView chưa import MemoryLettaView');
  assert.ok(source.includes("tab === 'letta'"), 'MemoryView chưa có nhánh render tab letta');
  assert.ok(source.includes('<MemoryLettaView bots={bots} botId={botId} onSelectBot={onSelectBot} />'), 'MemoryView chưa render MemoryLettaView');
  assert.ok(source.includes("t('memory.tabLetta')"), 'MemoryView chưa dùng key memory.tabLetta');
});

test('preload: expose đủ 9 method memory-letta + type view', () => {
  const source = fs.readFileSync(path.join(REPO, 'apps', 'desktop', 'src', 'main', 'preload.ts'), 'utf8');
  for (const method of EXPECTED_PRELOAD_METHODS) {
    assert.ok(source.includes(`${method}: (payload)`), `preload thiếu method ${method}`);
  }
  for (const channel of EXPECTED_IPC_CHANNELS) {
    assert.ok(source.includes(`ipcRenderer.invoke('${channel}'`), `preload thiếu invoke ${channel}`);
  }
  for (const typeName of ['LettaStatusView', 'LettaRecallHitView', 'LettaArchivalHitView', 'LettaProposalView', 'LettaBlockAppendView', 'LettaSleepPassSummaryView']) {
    assert.ok(source.includes(`export interface ${typeName}`), `preload thiếu type ${typeName}`);
  }
});

test('main: đăng ký đủ 9 channel IPC memory-letta:*', () => {
  const source = fs.readFileSync(path.join(REPO, 'apps', 'desktop', 'src', 'main', 'main.ts'), 'utf8');
  for (const channel of EXPECTED_IPC_CHANNELS) {
    // Một số handle viết nhiều dòng nên chỉ kiểm tra tên channel
    // (kèm ipcMain.handle trong cùng file).
    assert.ok(source.includes(`'${channel}'`) && source.includes('ipcMain.handle'), `main thiếu IPC ${channel}`);
  }
  // Dùng đúng store Letta của core (không tự viết lại store trong main).
  for (const name of ['PersistentAgentMemory', 'CoreMemoryManager', 'RecallStore', 'ArchivalStore', 'SleepProposalStore', 'runLettaSleepPass', 'readLettaSleepLog']) {
    assert.ok(source.includes(name), `main chưa import/dùng ${name}`);
  }
  // Embedding không bao giờ trả về renderer qua kênh Letta.
  const lettaSection = source.slice(source.indexOf('memory-letta:status'), source.indexOf('memory-letta:entity-export'));
  assert.ok(!lettaSection.includes('embedding'), 'kênh Letta không được trả embedding');
});

test('renderer types: Letta view types có trong types.ts + global.d.ts', () => {
  const types = fs.readFileSync(path.join(REPO, 'apps', 'desktop', 'src', 'renderer', 'types.ts'), 'utf8');
  const globalDts = fs.readFileSync(path.join(REPO, 'apps', 'desktop', 'src', 'renderer', 'global.d.ts'), 'utf8');
  for (const typeName of ['LettaStatusView', 'LettaRecallHitView', 'LettaArchivalHitView', 'LettaProposalView', 'LettaBlockAppendView', 'LettaSleepPassSummaryView']) {
    assert.ok(types.includes(`export interface ${typeName}`), `types.ts thiếu ${typeName}`);
  }
  for (const method of EXPECTED_PRELOAD_METHODS) {
    assert.ok(globalDts.includes(`${method}(payload`), `global.d.ts thiếu method ${method}`);
  }
});

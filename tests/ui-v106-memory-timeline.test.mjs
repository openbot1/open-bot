/**
 * UI tests for v1.06 (Team T5) — memory timeline.
 *
 * Part A (runtime): the pure timeline logic (memoryTimeline.ts) is
 * compiled with the repo's own TypeScript into a temp dir and
 * executed — tier derivation (24h working window), merge + sort,
 * tier/search filtering (diacritic-insensitive), day grouping.
 * Part B (static, repo pattern): i18n parity for the 30 timeline
 * keys in all 6 locales; MemoryTimelineView + MemoryView only use
 * keys that exist; the IPC channels the view needs are registered in
 * main, exposed by preload and mirrored in global.d.ts; the timeline
 * tab is wired into MemoryView with its data-testids.
 *
 * Run: node --test tests/ui-v106-memory-timeline.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOCALES = ['vi', 'en', 'zh', 'ja', 'es', 'fr'];
const TIMELINE_KEYS = 30;

function readLocale(locale) {
  return JSON.parse(
    fs.readFileSync(path.join(REPO, 'apps', 'desktop', 'src', 'renderer', 'i18n', 'locales', `${locale}.json`), 'utf8'),
  );
}

function read(rel) {
  return fs.readFileSync(path.join(REPO, ...rel), 'utf8');
}

function usedKeys(source) {
  return [...source.matchAll(/t\('([a-z][a-zA-Z0-9_]*\.[a-zA-Z0-9_.]+)'/g)].map((m) => m[1]);
}

/** Compile the pure timeline module (+ its botList dep) to CJS in a temp dir and require it. */
function loadTimelineModule() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-v106-timeline-'));
  const tsc = path.join(REPO, 'node_modules', 'typescript', 'bin', 'tsc');
  execFileSync(
    process.execPath,
    [
      tsc,
      '--module', 'commonjs',
      '--target', 'es2022',
      '--esModuleInterop',
      '--skipLibCheck',
      '--outDir', tmp,
      path.join(REPO, 'apps', 'desktop', 'src', 'renderer', 'components', 'memoryTimeline.ts'),
      path.join(REPO, 'apps', 'desktop', 'src', 'renderer', 'components', 'botList.ts'),
    ],
    { stdio: 'pipe' },
  );
  // tsc preserves the source tree under outDir (…/components/*.js).
  return createRequire(import.meta.url)(findCompiled(tmp, 'memoryTimeline.js'));
}

/** Walk a temp dir for a compiled file by basename. */
function findCompiled(dir, name) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const found = findCompiled(full, name);
      if (found) return found;
    } else if (entry.name === name) {
      return full;
    }
  }
  throw new Error(`compiled ${name} not found under ${dir}`);
}

const timeline = loadTimelineModule();
const NOW = Date.parse('2026-11-14T12:00:00.000Z');
const HOUR = 60 * 60 * 1000;

function entry(id, createdAt, updatedAt, key = 'key', value = 'value') {
  return { id, key, value, tags: [], confidence: 0.9, botId: 'b1', createdAt, updatedAt };
}
function block(id, label, createdAt, updatedAt) {
  return {
    id, label, description: 'desc', content: 'content', charLimit: 1000, readOnly: false,
    createdByBotId: 'b1', version: 1, createdAt, updatedAt, attachedBots: ['b1'],
  };
}

test('timeline: tier rule — fresh events are working, old ones keep their source tier', () => {
  const events = timeline.buildTimelineEvents({
    entries: [
      entry('e-old', '2026-11-10T10:00:00.000Z', '2026-11-10T10:00:00.000Z', 'old', 'old value'),
      entry('e-fresh', '2026-11-14T11:00:00.000Z', '2026-11-14T11:00:00.000Z', 'fresh', 'fresh value'),
    ],
    blocks: [block('bl-old', 'Old block', '2026-11-01T10:00:00.000Z', '2026-11-01T10:00:00.000Z')],
    versionsByBlock: {},
    runs: [],
    now: NOW,
  });
  const byId = Object.fromEntries(events.map((e) => [e.id, e]));
  assert.equal(byId[`entry-created:e-old:${Date.parse('2026-11-10T10:00:00.000Z')}`].tier, 'episodic');
  assert.equal(byId[`entry-created:e-fresh:${Date.parse('2026-11-14T11:00:00.000Z')}`].tier, 'working');
  assert.equal(byId[`block-created:bl-old:${Date.parse('2026-11-01T10:00:00.000Z')}`].tier, 'semantic');
  // Exactly at the 24h boundary the event has settled out of working.
  const boundary = timeline.buildTimelineEvents({
    entries: [entry('e-edge', new Date(NOW - 24 * HOUR).toISOString(), new Date(NOW - 24 * HOUR).toISOString())],
    blocks: [], versionsByBlock: {}, runs: [], now: NOW,
  });
  assert.equal(boundary[0].tier, 'episodic');
});

test('timeline: merge + sort newest first; created==updated yields one event; bad dates dropped', () => {
  const events = timeline.buildTimelineEvents({
    entries: [entry('e1', '2026-11-12T10:00:00.000Z', '2026-11-13T10:00:00.000Z')],
    blocks: [block('b1', 'B', '2026-11-11T10:00:00.000Z', '2026-11-11T10:00:00.000Z')],
    versionsByBlock: {
      B: [{ blockId: 'b1', label: 'B', version: 2, content: 'v2', description: '', charLimit: 1, readOnly: false, action: 'update', actor: 'bot', at: '2026-11-12T09:00:00.000Z' }],
    },
    runs: [{ at: '2026-11-14T08:00:00.000Z', actor: 'consolidation', duplicatesMerged: 1, groupsResolved: 0, losersSuperseded: 2, losersDeferred: 0, expiredSwept: 0, dreamPromoted: 1, scoreBefore: 70, scoreAfter: 75 }],
    now: NOW,
  });
  // e1 created + updated, b1 created, 1 version, 1 run = 5 events.
  assert.equal(events.length, 5);
  for (let i = 1; i < events.length; i++) assert.ok(events[i - 1].at >= events[i].at, 'not sorted desc');
  assert.equal(events[0].kind, 'consolidation');
  assert.equal(events.filter((e) => e.kind === 'block-version')[0].tier, 'session');
  const bad = timeline.buildTimelineEvents({
    entries: [entry('bad', 'not-a-date', 'also-bad')],
    blocks: [], versionsByBlock: {}, runs: [], now: NOW,
  });
  assert.equal(bad.length, 0);
});

test('timeline: filter by tier + diacritic-insensitive search', () => {
  const events = timeline.buildTimelineEvents({
    entries: [
      entry('e1', '2026-11-10T10:00:00.000Z', '2026-11-10T10:00:00.000Z', 'Quản lý dự án', 'nội dung quản lý'),
      entry('e2', '2026-11-10T11:00:00.000Z', '2026-11-10T11:00:00.000Z', 'other', 'plain'),
    ],
    blocks: [], versionsByBlock: {}, runs: [], now: NOW,
  });
  const all = new Set(timeline.MEMORY_TIERS);
  assert.equal(timeline.filterTimelineEvents(events, { tiers: all, query: '' }).length, 2);
  assert.equal(timeline.filterTimelineEvents(events, { tiers: all, query: 'quan ly' }).length, 1);
  assert.equal(timeline.filterTimelineEvents(events, { tiers: new Set(['semantic']), query: '' }).length, 0);
  assert.equal(timeline.filterTimelineEvents(events, { tiers: new Set(), query: '' }).length, 0);
  assert.equal(timeline.filterTimelineEvents(events, { tiers: all, query: 'khong co' }).length, 0);
});

test('timeline: group by day, newest day first', () => {
  const events = timeline.buildTimelineEvents({
    entries: [
      entry('e1', '2026-11-12T10:00:00.000Z', '2026-11-12T10:00:00.000Z'),
      entry('e2', '2026-11-12T11:00:00.000Z', '2026-11-12T11:00:00.000Z'),
      entry('e3', '2026-11-13T10:00:00.000Z', '2026-11-13T10:00:00.000Z'),
    ],
    blocks: [], versionsByBlock: {}, runs: [], now: NOW,
  });
  const groups = timeline.groupEventsByDay(events);
  assert.deepEqual(groups.map((g) => g.day), ['2026-11-13', '2026-11-12']);
  assert.deepEqual(groups.map((g) => g.events.length), [1, 2]);
});

test(`i18n parity: 30 timeline keys (memory.tabTimeline + memory.timeline.*) in all 6 locales`, () => {
  const locales = Object.fromEntries(LOCALES.map((l) => [l, readLocale(l)]));
  const keys = Object.keys(locales.en).filter((k) => k === 'memory.tabTimeline' || k.startsWith('memory.timeline.'));
  assert.equal(keys.length, TIMELINE_KEYS, `expected ${TIMELINE_KEYS} timeline keys, got ${keys.length}`);
  for (const key of keys) {
    for (const locale of LOCALES) {
      assert.ok(key in locales[locale], `${locale} thiếu key ${key}`);
      assert.equal(typeof locales[locale][key], 'string', `${locale}.${key} phải là string`);
      assert.ok(locales[locale][key].trim() !== '', `${locale}.${key} rỗng`);
    }
  }
  for (const locale of LOCALES.slice(1)) {
    const ks = Object.keys(locales[locale]).filter((k) => k === 'memory.tabTimeline' || k.startsWith('memory.timeline.'));
    assert.deepEqual(ks.sort(), [...keys].sort(), `key set timeline lệch ở ${locale}`);
  }
});

test('MemoryTimelineView + MemoryView chỉ dùng key i18n đã tồn tại', () => {
  const en = readLocale('en');
  const view = read(['apps', 'desktop', 'src', 'renderer', 'components', 'MemoryTimelineView.tsx']);
  const memoryView = read(['apps', 'desktop', 'src', 'renderer', 'components', 'MemoryView.tsx']);
  for (const key of usedKeys(view)) {
    assert.ok(key in en, `MemoryTimelineView dùng key chưa có: ${key}`);
  }
  for (const key of usedKeys(memoryView)) {
    assert.ok(key in en, `MemoryView dùng key chưa có: ${key}`);
  }
  assert.ok(view.includes("t('memory.timeline.intro')"));
  assert.ok(view.includes("t('memory.timeline.restoreVersion')"));
  assert.ok(memoryView.includes("t('memory.tabTimeline')"));
});

test('timeline tab wired into MemoryView + view has the expected data-testids', () => {
  const memoryView = read(['apps', 'desktop', 'src', 'renderer', 'components', 'MemoryView.tsx']);
  const view = read(['apps', 'desktop', 'src', 'renderer', 'components', 'MemoryTimelineView.tsx']);
  assert.ok(memoryView.includes("import MemoryTimelineView from './MemoryTimelineView'"));
  assert.ok(memoryView.includes("data-testid=\"memory-tab-timeline\""));
  assert.ok(memoryView.includes("'timeline'"));
  assert.ok(memoryView.includes('<MemoryTimelineView bots={bots} botId={botId} onSelectBot={onSelectBot} />'));
  for (const id of ['memory-timeline-view', 'memory-timeline-bot-select', 'memory-timeline-search', 'memory-timeline-tiers', 'memory-timeline-refresh', 'memory-timeline-count', 'memory-timeline-list', 'memory-timeline-detail', 'memory-timeline-restore']) {
    assert.ok(view.includes(id), `MemoryTimelineView thiếu testid ${id}`);
  }
  // Tier checkboxes use a template testid: `memory-timeline-tier-${tier}`.
  assert.ok(view.includes('`memory-timeline-tier-${tier}`'), 'MemoryTimelineView thiếu testid tier template');
});

test('IPC the timeline needs exists in main + preload + global.d.ts (no new backend)', () => {
  const main = read(['apps', 'desktop', 'src', 'main', 'main.ts']);
  const preload = read(['apps', 'desktop', 'src', 'main', 'preload.ts']);
  const dts = read(['apps', 'desktop', 'src', 'renderer', 'global.d.ts']);
  for (const channel of ['memory:list', 'memory-blocks:list', 'memory-v3:block-history', 'memory-v5:health']) {
    assert.ok(main.includes(`'${channel}'`), `main thiếu IPC ${channel}`);
    assert.ok(preload.includes(`ipcRenderer.invoke('${channel}'`), `preload thiếu invoke ${channel}`);
  }
  for (const method of ['listMemories', 'listMemoryBlocks', 'getMemoryV3BlockHistory', 'getMemoryV5Health']) {
    assert.ok(dts.includes(method), `global.d.ts thiếu ${method}`);
  }
});

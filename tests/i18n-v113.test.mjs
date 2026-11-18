/**
 * Test v1.13: i18n key moi — Doi T3 repo map v5 (24 key repomapV5.*)
 * + Doi T6 fleet platform v10 (49 key fleetV10.*) — du 6 locale,
 * placeholder khop en.
 *
 * Chi test thuan (doc JSON). Khong can build:
 *   node --test tests/i18n-v113.test.mjs
 *
 * NOTE: repo co 6 locale (vi, en, zh, ja, es, fr) — khong co ko.json;
 * key moi duoc them vao ca 6 locale hien co. Tong so key moi locale
 * sau v1.13 = 4818 + 165 = 4983 (cong ca key cac doi khac cung song).
 * Pin toan cuc song trong tests/i18n-v106.test.mjs (coordinator cap
 * nhat luc gop); file nay khong pin so tuyet doi.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const localesDir = join(here, '..', 'apps/desktop/src/renderer/i18n/locales');
const LOCALE_NAMES = ['en', 'vi', 'es', 'fr', 'ja', 'zh'];

const REPOMAP_V5_KEYS = [
  'repomapV5.ambiguous',
  'repomapV5.build',
  'repomapV5.buildTitle',
  'repomapV5.callees',
  'repomapV5.callers',
  'repomapV5.cycles',
  'repomapV5.definition',
  'repomapV5.empty',
  'repomapV5.exports',
  'repomapV5.hubs',
  'repomapV5.importers',
  'repomapV5.imports',
  'repomapV5.index',
  'repomapV5.indexTitle',
  'repomapV5.notFound',
  'repomapV5.orphans',
  'repomapV5.search',
  'repomapV5.searchTitle',
  'repomapV5.skeleton',
  'repomapV5.summary',
  'repomapV5.summaryTitle',
  'repomapV5.symbols',
  'repomapV5.title',
  'repomapV5.topology',
];

const FLEET_V10_KEYS = [
  'fleetV10.agents',
  'fleetV10.alerts',
  'fleetV10.audit',
  'fleetV10.control',
  'fleetV10.cpu',
  'fleetV10.dashboard',
  'fleetV10.disk',
  'fleetV10.error',
  'fleetV10.logTail',
  'fleetV10.logs',
  'fleetV10.noAlerts',
  'fleetV10.pause',
  'fleetV10.paused',
  'fleetV10.quota',
  'fleetV10.quotaExceeded',
  'fleetV10.queue',
  'fleetV10.queueRunning',
  'fleetV10.queueWaiting',
  'fleetV10.ram',
  'fleetV10.resources',
  'fleetV10.resume',
  'fleetV10.running',
  'fleetV10.scheduleCreate',
  'fleetV10.scheduleKind',
  'fleetV10.scheduleLastRun',
  'fleetV10.scheduleMissed',
  'fleetV10.scheduleNextRun',
  'fleetV10.scheduleSkipped',
  'fleetV10.schedules',
  'fleetV10.scheduleTimezone',
  'fleetV10.start',
  'fleetV10.stop',
  'fleetV10.stopped',
  'fleetV10.subtitle',
  'fleetV10.title',
  'fleetV10.triggerAgent',
  'fleetV10.triggerCreate',
  'fleetV10.triggerDebounced',
  'fleetV10.triggerEnabled',
  'fleetV10.triggerEvent',
  'fleetV10.triggerFiltered',
  'fleetV10.triggerFired',
  'fleetV10.triggerName',
  'fleetV10.triggerThrottled',
  'fleetV10.triggers',
  'fleetV10.unknown',
  'fleetV10.userCreate',
  'fleetV10.userRole',
  'fleetV10.users',
];

function loadLocale(code) {
  return JSON.parse(readFileSync(join(localesDir, `${code}.json`), 'utf8'));
}

function placeholderNames(value) {
  return [...value.matchAll(/\{([a-zA-Z0-9_]+)\}/g)].map((m) => m[1]).sort();
}

function placeholderTokens(value) {
  return [...value.matchAll(/\{[a-zA-Z0-9_]+\}/g)].map((m) => m[0]).sort();
}

test('repomapV5 keys exist in all 6 locales, non-empty', () => {
  for (const code of LOCALE_NAMES) {
    const dict = loadLocale(code);
    for (const key of REPOMAP_V5_KEYS) {
      assert.ok(key in dict, `${code} missing ${key}`);
      assert.equal(typeof dict[key], 'string', `${code}.${key} is not a string`);
      assert.ok(dict[key].trim().length > 0, `${code}.${key} is empty`);
    }
  }
});

test('repomapV5 placeholders match en in every locale', () => {
  const en = loadLocale('en');
  for (const code of LOCALE_NAMES) {
    if (code === 'en') continue;
    const dict = loadLocale(code);
    for (const key of REPOMAP_V5_KEYS) {
      assert.deepEqual(
        placeholderNames(dict[key]),
        placeholderNames(en[key]),
        `${code}.${key} placeholders differ from en`,
      );
    }
  }
  // notFound carries the {name} placeholder.
  assert.deepEqual(placeholderNames(loadLocale('en')['repomapV5.notFound']), ['name']);
});

test('fleetV10: du 49 key o ca 6 locale, placeholder khop en', () => {
  assert.equal(FLEET_V10_KEYS.length, 49);
  const dicts = {};
  for (const code of LOCALE_NAMES) {
    dicts[code] = loadLocale(code);
    for (const key of FLEET_V10_KEYS) {
      assert.ok(
        typeof dicts[code][key] === 'string' && dicts[code][key].trim().length > 0,
        `${code} missing or empty: ${key}`,
      );
    }
  }
  for (const key of FLEET_V10_KEYS) {
    const enPlaceholders = placeholderTokens(dicts.en[key]);
    for (const code of LOCALE_NAMES) {
      assert.deepEqual(placeholderTokens(dicts[code][key]), enPlaceholders, `${code} placeholder mismatch: ${key}`);
    }
  }
});

test('locale files: key sort + so luong bang nhau giua cac locale', () => {
  const counts = new Set();
  for (const code of LOCALE_NAMES) {
    const dict = loadLocale(code);
    const keys = Object.keys(dict);
    assert.deepEqual(keys, [...keys].sort(), `${code} keys are not sorted`);
    counts.add(keys.length);
  }
  assert.equal(counts.size, 1, 'locale key counts differ');
  // No absolute pin here: the global pin lives in tests/i18n-v106.test.mjs
  // (coordinator updates it).
});

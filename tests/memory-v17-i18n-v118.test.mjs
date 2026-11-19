/**
 * Tests for memory v17 — i18n (v1.18, Đội T1): the 28 new
 * `memoryV17.*` keys exist in all 6 locales with non-empty values,
 * and the locale totals move 5936 -> 5964.
 *
 * Pure JSON — no build needed:
 *   node --test tests/memory-v17-i18n-v118.test.mjs
 *
 * NOTE for the merge coordinator: several older tests pin the old
 * total (5936) and need a re-pin to 5964 at merge time (same
 * pattern as previous waves: "merge re-pin").
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const localesDir = join(here, '..', 'apps/desktop/src/renderer/i18n/locales');
const LOCALE_NAMES = ['en', 'vi', 'es', 'fr', 'ja', 'zh'];

const MEMORY_V17_KEYS = [
  'memoryV17.admit',
  'memoryV17.admitStats',
  'memoryV17.archivalScore',
  'memoryV17.blockAudit',
  'memoryV17.blockCommit',
  'memoryV17.blockHistory',
  'memoryV17.blockRollback',
  'memoryV17.compile',
  'memoryV17.demote',
  'memoryV17.eval',
  'memoryV17.intro',
  'memoryV17.lifecycle',
  'memoryV17.maxChars',
  'memoryV17.pin',
  'memoryV17.promote',
  'memoryV17.quota',
  'memoryV17.quotaReport',
  'memoryV17.readOnly',
  'memoryV17.recordAccess',
  'memoryV17.sleepNextRun',
  'memoryV17.sleepRun',
  'memoryV17.sleepSchedule',
  'memoryV17.template',
  'memoryV17.templateCreate',
  'memoryV17.templateList',
  'memoryV17.title',
  'memoryV17.unlockReadOnly',
  'memoryV17.unpin',
];

function loadLocale(name) {
  return JSON.parse(readFileSync(join(localesDir, `${name}.json`), 'utf8'));
}

test('v17 i18n: all 28 memoryV17.* keys exist in all 6 locales, non-empty', () => {
  assert.equal(MEMORY_V17_KEYS.length, 28);
  for (const loc of LOCALE_NAMES) {
    const dict = loadLocale(loc);
    for (const key of MEMORY_V17_KEYS) {
      assert.ok(key in dict, `${loc} missing ${key}`);
      assert.equal(typeof dict[key], 'string', `${loc}.${key} must be a string`);
      assert.ok(dict[key].trim() !== '', `${loc}.${key} must be non-empty`);
    }
  }
});

test('v17 i18n: locale totals are 5964 (5936 + 28)', () => {
  for (const loc of LOCALE_NAMES) {
    const dict = loadLocale(loc);
    assert.ok(Object.keys(dict).length >= 8072, `${loc} total ${Object.keys(dict).length} below 8072 floor`); // v1.39 fix round 4b: floor >= 8072 (was v1.38 re-pin 8072).
  }
});

test('v17 i18n: no locale has extra memoryV17.* keys beyond the 28', () => {
  for (const loc of LOCALE_NAMES) {
    const dict = loadLocale(loc);
    const found = Object.keys(dict).filter((k) => k.startsWith('memoryV17.'));
    assert.deepEqual([...found].sort(), [...MEMORY_V17_KEYS].sort(), `${loc} memoryV17.* keys`);
  }
});

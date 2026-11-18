/**
 * Tests for memory v18 — i18n (v1.19, Đội T1-TEST, wave 4): the 24 new
 * `memoryV18.*` keys exist in all 6 locales with non-empty values,
 * and the locale totals move 6195 -> 6863 at v1.20 merge in the merged tree.
 *
 * Pure JSON — no build needed:
 *   node --test tests/memory-v18-i18n-v119.test.mjs
 *
 * NOTE for the merge coordinator: several older tests pin the old
 * total (6195) and needed a re-pin to 6863 at merge time (same
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

const MEMORY_V18_KEYS = [
  'memoryV18.blockAudit',
  'memoryV18.blockDrift',
  'memoryV18.blockEdit',
  'memoryV18.blockRollback',
  'memoryV18.contradiction',
  'memoryV18.correct',
  'memoryV18.correction',
  'memoryV18.duplicateGroups',
  'memoryV18.erase',
  'memoryV18.eraseAudit',
  'memoryV18.eraseDryRun',
  'memoryV18.eval',
  'memoryV18.extract',
  'memoryV18.intro',
  'memoryV18.locomo',
  'memoryV18.retrieve',
  'memoryV18.screen',
  'memoryV18.sleep',
  'memoryV18.sleepRun',
  'memoryV18.snapshot',
  'memoryV18.sourceTrust',
  'memoryV18.timeline',
  'memoryV18.title',
  'memoryV18.trustBook',
];

function loadLocale(name) {
  return JSON.parse(readFileSync(join(localesDir, `${name}.json`), 'utf8'));
}

test('v18 i18n: all 24 memoryV18.* keys exist in all 6 locales, non-empty', () => {
  assert.equal(MEMORY_V18_KEYS.length, 24);
  for (const loc of LOCALE_NAMES) {
    const dict = loadLocale(loc);
    for (const key of MEMORY_V18_KEYS) {
      assert.ok(key in dict, `${loc} missing ${key}`);
      assert.equal(typeof dict[key], 'string', `${loc}.${key} must be a string`);
      assert.ok(dict[key].trim() !== '', `${loc}.${key} must be non-empty`);
    }
  }
});

test('v18 i18n: locale totals are 6863', () => {
  for (const loc of LOCALE_NAMES) {
    const dict = loadLocale(loc);
    assert.equal(Object.keys(dict).length, 7540, `${loc} total`); // v1.36 re-pin: 7540.
  }
});

test('v18 i18n: no locale has extra memoryV18.* keys beyond the 24', () => {
  for (const loc of LOCALE_NAMES) {
    const dict = loadLocale(loc);
    const found = Object.keys(dict).filter((k) => k.startsWith('memoryV18.'));
    assert.deepEqual([...found].sort(), [...MEMORY_V18_KEYS].sort(), `${loc} memoryV18.* keys`);
  }
});

test('v18 i18n: keys stay sorted and the v17 keys are untouched', () => {
  for (const loc of LOCALE_NAMES) {
    const dict = loadLocale(loc);
    const keys = Object.keys(dict);
    assert.deepEqual(keys, [...keys].sort(), `${loc} keys sorted`);
    assert.equal(dict['memoryV17.title'].length > 0, true);
  }
});

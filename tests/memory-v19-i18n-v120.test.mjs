/**
 * Tests for memory v19 — i18n (v1.20, Đội T1): the 24 new
 * `memoryV19.*` keys exist in all 6 locales with non-empty values,
 * and the locale totals move 6195 -> 6863 at v1.20 merge.
 *
 * Pure JSON — no build needed:
 *   node --test tests/memory-v19-i18n-v120.test.mjs
 *
 * NOTE for the merge coordinator: several older tests pin the old
 * total (6195) and need a re-pin to 6863 at merge time (same
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

const MEMORY_V19_KEYS = [
  'memoryV19.conflictResolved',
  'memoryV19.conflictUnresolved',
  'memoryV19.consolidation',
  'memoryV19.consolidationReport',
  'memoryV19.consolidationRun',
  'memoryV19.decay',
  'memoryV19.encodedPayload',
  'memoryV19.evalDual',
  'memoryV19.feedback',
  'memoryV19.feedbackNegative',
  'memoryV19.feedbackPositive',
  'memoryV19.feedbackSummary',
  'memoryV19.forgery',
  'memoryV19.intro',
  'memoryV19.obfuscation',
  'memoryV19.poisoningGuard',
  'memoryV19.quarantine',
  'memoryV19.rollback',
  'memoryV19.supersede',
  'memoryV19.supersedeHistory',
  'memoryV19.title',
  'memoryV19.tokenBudget',
  'memoryV19.writerModels',
  'memoryV19.writerPick',
];

function loadLocale(name) {
  return JSON.parse(readFileSync(join(localesDir, `${name}.json`), 'utf8'));
}

test('v19 i18n: all 24 memoryV19.* keys exist in all 6 locales, non-empty', () => {
  assert.equal(MEMORY_V19_KEYS.length, 24);
  for (const loc of LOCALE_NAMES) {
    const dict = loadLocale(loc);
    for (const key of MEMORY_V19_KEYS) {
      assert.ok(key in dict, `${loc} missing ${key}`);
      assert.equal(typeof dict[key], 'string', `${loc}.${key} must be a string`);
      assert.ok(dict[key].trim() !== '', `${loc}.${key} must be non-empty`);
    }
  }
});

test('v19 i18n: locale totals are 6863', () => {
  for (const loc of LOCALE_NAMES) {
    const dict = loadLocale(loc);
    assert.equal(Object.keys(dict).length, 7540, `${loc} total`); // v1.36 re-pin: 7540.
  }
});

test('v19 i18n: no locale has extra memoryV19.* keys beyond the 24', () => {
  for (const loc of LOCALE_NAMES) {
    const dict = loadLocale(loc);
    const found = Object.keys(dict).filter((k) => k.startsWith('memoryV19.'));
    assert.deepEqual(found.sort(), [...MEMORY_V19_KEYS].sort(), `${loc} extra keys`);
  }
});

test('v19 i18n: vi title/intro match the feature names', () => {
  const vi = loadLocale('vi');
  assert.equal(vi['memoryV19.title'], 'Memory v19');
  assert.match(vi['memoryV19.intro'], /writer BYOK/);
  assert.match(vi['memoryV19.intro'], /chống đầu độc/);
});

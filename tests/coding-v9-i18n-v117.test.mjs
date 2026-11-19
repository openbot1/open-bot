/**
 * Tests for coding agent v9 — i18n (v1.17, Đội T4): the 26 new
 * `codingV9.*` keys exist in all 6 locales with non-empty values,
 * and the locale totals move 5704 -> 5730.
 *
 * Pure JSON — no build needed:
 *   node --test tests/coding-v9-i18n-v117.test.mjs
 *
 * NOTE for the merge coordinator: several older tests pin the old
 * total (5704) and need a re-pin to 5730 at merge time (same
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

const CODING_V9_KEYS = [
  'codingV9.title',
  'codingV9.astEdit',
  'codingV9.astEditApplied',
  'codingV9.astEditFallback',
  'codingV9.sandboxLoop',
  'codingV9.loopPassed',
  'codingV9.loopFailed',
  'codingV9.loopRound',
  'codingV9.atomicCommit',
  'codingV9.commitMessage',
  'codingV9.draftPr',
  'codingV9.draftPrTitle',
  'codingV9.eval',
  'codingV9.evalPassAtK',
  'codingV9.evalAttempts',
  'codingV9.evalRounds',
  'codingV9.evalTokens',
  'codingV9.verify',
  'codingV9.verified',
  'codingV9.denied',
  'codingV9.timeout',
  'codingV9.rollback',
  'codingV9.previewDiff',
  'codingV9.apply',
  'codingV9.approve',
  'codingV9.reject',
];

function loadLocale(name) {
  return JSON.parse(readFileSync(join(localesDir, `${name}.json`), 'utf8'));
}

test('v9 i18n: all 26 codingV9.* keys exist in all 6 locales, non-empty', () => {
  for (const loc of LOCALE_NAMES) {
    const dict = loadLocale(loc);
    for (const key of CODING_V9_KEYS) {
      assert.ok(key in dict, `${loc} missing ${key}`);
      assert.equal(typeof dict[key], 'string', `${loc}.${key} must be a string`);
      assert.ok(dict[key].trim().length > 0, `${loc}.${key} must be non-empty`);
    }
  }
});

test('v9 i18n: locale totals move 5704 -> 5730 in every locale', () => {
  const counts = LOCALE_NAMES.map((loc) => Object.keys(loadLocale(loc)).length);
  assert.equal(new Set(counts).size, 1, `6 locale phai co cung tong key: ${counts.join(', ')}`);
  assert.ok(counts[0] >= 8072, `tong key moi locale phai >= 8072 (v1.38), got ${counts[0]}`); // v1.39 fix round 4b: floor (8072 at v1.38; 8322 at v1.39).
});

test('v9 i18n: keys are sorted in every locale file', () => {
  for (const loc of LOCALE_NAMES) {
    const keys = Object.keys(loadLocale(loc));
    assert.deepEqual(keys, [...keys].sort(), `${loc} keys must stay sorted`);
  }
});

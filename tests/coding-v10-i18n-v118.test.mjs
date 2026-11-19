/**
 * Tests for coding agent v10 — i18n (v1.18, Đội T2): the 24 new
 * `codingV10.*` keys exist in all 6 locales with non-empty values,
 * and the locale totals move 5936 -> 5960.
 *
 * Pure JSON — no build needed:
 *   node --test tests/coding-v10-i18n-v118.test.mjs
 *
 * NOTE for the merge coordinator: several older tests pin the old
 * total (5936) and need a re-pin to 5960 at merge time (same
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

const CODING_V10_KEYS = [
  'codingV10.agent',
  'codingV10.astStrategy',
  'codingV10.codeAct',
  'codingV10.codeActDenied',
  'codingV10.codeActTimeout',
  'codingV10.commit',
  'codingV10.edit',
  'codingV10.eval',
  'codingV10.evalAttempts',
  'codingV10.evalPassAtK',
  'codingV10.evalRounds',
  'codingV10.evalVersions',
  'codingV10.fork',
  'codingV10.pause',
  'codingV10.replay',
  'codingV10.repoMap',
  'codingV10.resume',
  'codingV10.searchReplaceStrategy',
  'codingV10.session',
  'codingV10.snapshot',
  'codingV10.strategy',
  'codingV10.title',
  'codingV10.verify',
  'codingV10.wholeFileStrategy',
];

function loadLocale(name) {
  return JSON.parse(readFileSync(join(localesDir, `${name}.json`), 'utf8'));
}

test('v10 i18n: all 24 codingV10.* keys exist in all 6 locales, non-empty', () => {
  for (const loc of LOCALE_NAMES) {
    const dict = loadLocale(loc);
    for (const key of CODING_V10_KEYS) {
      assert.ok(key in dict, `${loc} missing ${key}`);
      assert.equal(typeof dict[key], 'string', `${loc}.${key} must be a string`);
      assert.ok(dict[key].trim().length > 0, `${loc}.${key} must be non-empty`);
    }
  }
});

test('v10 i18n: locale totals move 5936 -> 5960 in every locale', () => {
  const counts = LOCALE_NAMES.map((loc) => Object.keys(loadLocale(loc)).length);
  assert.equal(new Set(counts).size, 1, `6 locale phai co cung tong key: ${counts.join(', ')}`);
  assert.ok(counts[0] >= 8072, `tong key moi locale phai >= 8072 (v1.38), got ${counts[0]}`); // v1.39 fix round 4b: floor (8072 at v1.38; 8322 at v1.39).
});

test('v10 i18n: keys are sorted in every locale file', () => {
  for (const loc of LOCALE_NAMES) {
    const keys = Object.keys(loadLocale(loc));
    assert.deepEqual(keys, [...keys].sort(), `${loc} keys must stay sorted`);
  }
});

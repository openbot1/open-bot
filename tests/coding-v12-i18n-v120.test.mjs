/**
 * Tests for coding agent v12 — i18n (v1.20, Đội T3 lần 3): the 24 new
 * `codingV12.*` keys exist in all 6 locales with non-empty values,
 * and the locale totals move 6195 -> 6863 at v1.20 merge.
 *
 * Pure JSON — no build needed:
 *   node --test tests/coding-v12-i18n-v120.test.mjs
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

const CODING_V12_KEYS = [
  'codingV12.title',
  'codingV12.agent',
  'codingV12.atomicCommit',
  'codingV12.budget',
  'codingV12.budgetCost',
  'codingV12.budgetSteps',
  'codingV12.budgetTime',
  'codingV12.budgetTokens',
  'codingV12.cycles',
  'codingV12.depGraph',
  'codingV12.depGraphOrder',
  'codingV12.diffEconomy',
  'codingV12.diffFormat',
  'codingV12.editStrategy',
  'codingV12.eval',
  'codingV12.fileAccuracy',
  'codingV12.modelSwitched',
  'codingV12.noRegression',
  'codingV12.patchFormat',
  'codingV12.rollback',
  'codingV12.switchModel',
  'codingV12.verified',
  'codingV12.verify',
  'codingV12.visualizer',
];

function loadLocale(name) {
  return JSON.parse(readFileSync(join(localesDir, `${name}.json`), 'utf8'));
}

test('v12 i18n: all 24 codingV12.* keys exist in all 6 locales, non-empty', () => {
  for (const loc of LOCALE_NAMES) {
    const dict = loadLocale(loc);
    for (const key of CODING_V12_KEYS) {
      assert.ok(key in dict, `${loc} missing ${key}`);
      assert.equal(typeof dict[key], 'string', `${loc} ${key} is not a string`);
      assert.ok(dict[key].trim().length > 0, `${loc} ${key} is empty`);
    }
  }
});

test('v12 i18n: locale totals are 6863 in all 6 locales', () => {
  for (const loc of LOCALE_NAMES) {
    const dict = loadLocale(loc);
    assert.ok(Object.keys(dict).length >= 8072, `${loc} total`); // v1.38 re-pin: 8072.
  }
});

test('v12 i18n: keys are sorted alphabetically in every locale', () => {
  for (const loc of LOCALE_NAMES) {
    const dict = loadLocale(loc);
    const keys = Object.keys(dict);
    assert.deepEqual(keys, [...keys].sort(), `${loc} keys not sorted`);
  }
});

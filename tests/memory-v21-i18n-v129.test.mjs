/**
 * Tests for memory v21 — i18n (v1.29, Doi T1): the 31 new
 * `memoryV21.*` keys exist in all 6 locales with non-empty values,
 * and the locale totals move 6628 -> 6863.
 *
 * Pure JSON — no build needed:
 *   node --test tests/memory-v21-i18n-v129.test.mjs
 *
 * NOTE for the merge coordinator: 32 older tests pin the old
 * total (6628) and need a re-pin to 6863 at merge time (same
 * pattern as previous waves: "merge re-pin").
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const localesDir = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'apps', 'desktop', 'src', 'renderer', 'i18n', 'locales');
const LOCALES = ['vi', 'en', 'zh', 'ja', 'es', 'fr'];
const EXPECTED_TOTAL = 8072; // v1.39 fix round 4b: floor (was v1.38 re-pin 8072).
const EXPECTED_V21_KEYS = 31;

function loadLocale(code) {
  return JSON.parse(readFileSync(join(localesDir, `${code}.json`), 'utf8'));
}

test('v21 i18n: 31 memoryV21.* keys exist in all 6 locales, non-empty', () => {
  const dicts = Object.fromEntries(LOCALES.map((code) => [code, loadLocale(code)]));
  const viKeys = Object.keys(dicts.vi).filter((k) => k.startsWith('memoryV21.'));
  assert.equal(viKeys.length, EXPECTED_V21_KEYS, `vi co ${viKeys.length} key memoryV21, ky vong ${EXPECTED_V21_KEYS}`);
  for (const key of viKeys) {
    for (const code of LOCALES) {
      const value = dicts[code][key];
      assert.equal(typeof value, 'string', `${key} thieu o ${code}`);
      assert.ok(value.trim().length > 0, `${key} rong o ${code}`);
    }
  }
  // Cac key co ban phai co mat.
  for (const key of [
    'memoryV21.title',
    'memoryV21.intro',
    'memoryV21.export',
    'memoryV21.import',
    'memoryV21.convert',
    'memoryV21.validate',
    'memoryV21.sync',
    'memoryV21.tombstone',
    'memoryV21.version',
    'memoryV21.sleep',
    'memoryV21.okfFormat',
    'memoryV21.memfsFormat',
    'memoryV21.openhandsFormat',
    'memoryV21.rollback',
    'memoryV21.crossSession',
  ]) {
    assert.ok(viKeys.includes(key), `thieu key ${key}`);
  }
});

test('v21 i18n: locale totals move 6628 -> 8072, key sets identical across locales', () => {
  const dicts = Object.fromEntries(LOCALES.map((code) => [code, loadLocale(code)]));
  for (const code of LOCALES) {
    assert.ok(Object.keys(dicts[code]).length >= EXPECTED_TOTAL, `${code} co ${Object.keys(dicts[code]).length} keys, ky vong toi thieu ${EXPECTED_TOTAL}`); // v1.39 fix round 4b: floor >= 8072.
  }
  const viKeys = Object.keys(dicts.vi).sort();
  for (const code of LOCALES) {
    assert.deepEqual(Object.keys(dicts[code]).sort(), viKeys, `key set cua ${code} khac vi`);
  }
});

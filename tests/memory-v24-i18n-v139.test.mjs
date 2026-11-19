/**
 * Tests for memory v24 — i18n (v1.39, Doi T1): the 24 new
 * `memoryV24.*` keys exist in all 6 locales with non-empty values,
 * and the locale totals are equal and at least 8096 (8072 base + 24 memoryV24).
 * No hardcoded total: later v139 teams add their own keys on top
 * (v139 fix round 3 — the old [8096] snapshot broke on merge).
 *
 * Pure JSON — no build needed:
 *   node --test tests/memory-v24-i18n-v139.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const localesDir = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'apps', 'desktop', 'src', 'renderer', 'i18n', 'locales');
const LOCALES = ['vi', 'en', 'zh', 'ja', 'es', 'fr'];
const EXPECTED_TOTAL_MIN = 8096; // 8072 v1.38 + 24 memoryV24 (floor, not exact).
const EXPECTED_V24_KEYS = 24;

function loadLocale(code) {
  return JSON.parse(readFileSync(join(localesDir, `${code}.json`), 'utf8'));
}

test('v24 i18n: 24 memoryV24.* keys exist in all 6 locales, non-empty', () => {
  const dicts = Object.fromEntries(LOCALES.map((code) => [code, loadLocale(code)]));
  const totals = LOCALES.map((code) => Object.keys(dicts[code]).length);
  assert.equal(new Set(totals).size, 1, `6 locale phai co cung tong key: ${totals.join(', ')}`);
  for (const code of LOCALES) {
    assert.ok(
      Object.keys(dicts[code]).length >= EXPECTED_TOTAL_MIN,
      `${code} co ${Object.keys(dicts[code]).length} key, ky vong >= ${EXPECTED_TOTAL_MIN}`,
    );
  }
  const viKeys = Object.keys(dicts.vi).filter((k) => k.startsWith('memoryV24.'));
  assert.equal(viKeys.length, EXPECTED_V24_KEYS, `vi co ${viKeys.length} key memoryV24, ky vong ${EXPECTED_V24_KEYS}`);
  for (const key of viKeys) {
    for (const code of LOCALES) {
      const value = dicts[code][key];
      assert.equal(typeof value, 'string', `${key} thieu o ${code}`);
      assert.ok(value.trim().length > 0, `${key} rong o ${code}`);
    }
  }
  // Cac key co ban phai co mat.
  for (const key of [
    'memoryV24.title',
    'memoryV24.intro',
    'memoryV24.add',
    'memoryV24.memfs',
    'memoryV24.search',
    'memoryV24.lesson',
    'memoryV24.block',
    'memoryV24.sleep',
    'memoryV24.decay',
    'memoryV24.admission',
    'memoryV24.conflict',
    'memoryV24.stats',
    'memoryV24.evidence',
    'memoryV24.snapshot',
    'memoryV24.health',
  ]) {
    assert.ok(viKeys.includes(key), `thieu key ${key}`);
  }
});

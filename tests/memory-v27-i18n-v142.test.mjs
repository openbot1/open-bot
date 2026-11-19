/**
 * Tests for memory v27 — i18n (v1.42, Doi T3): the 48 new
 * `memoryV27.*` keys exist in all 6 locales with non-empty values,
 * and the locale totals are equal and at least 8983 (8935 v1.42
 * base + 48 memoryV27 — floor, not exact total, de doi sau cong
 * them key cua minh).
 *
 * Pure JSON — no build needed:
 *   node --test tests/memory-v27-i18n-v142.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const localesDir = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'apps', 'desktop', 'src', 'renderer', 'i18n', 'locales');
const LOCALES = ['vi', 'en', 'zh', 'ja', 'es', 'fr'];
const EXPECTED_TOTAL_MIN = 8983; // 8935 truoc v27 + 48 memoryV27 (floor, not exact).
const EXPECTED_V27_KEYS = 48;

function loadLocale(code) {
  return JSON.parse(readFileSync(join(localesDir, `${code}.json`), 'utf8'));
}

test('v27 i18n: 48 memoryV27.* keys exist in all 6 locales, non-empty', () => {
  const dicts = Object.fromEntries(LOCALES.map((code) => [code, loadLocale(code)]));
  const totals = LOCALES.map((code) => Object.keys(dicts[code]).length);
  assert.equal(new Set(totals).size, 1, `6 locale phai co cung tong key: ${totals.join(', ')}`);
  for (const code of LOCALES) {
    assert.ok(
      Object.keys(dicts[code]).length >= EXPECTED_TOTAL_MIN,
      `${code} co ${Object.keys(dicts[code]).length} key, ky vong >= ${EXPECTED_TOTAL_MIN}`,
    );
  }
  const viKeys = Object.keys(dicts.vi).filter((k) => k.startsWith('memoryV27.'));
  assert.equal(viKeys.length, EXPECTED_V27_KEYS, `vi co ${viKeys.length} key memoryV27, ky vong ${EXPECTED_V27_KEYS}`);
  for (const key of viKeys) {
    for (const code of LOCALES) {
      const value = dicts[code][key];
      assert.equal(typeof value, 'string', `${key} thieu o ${code}`);
      assert.ok(value.trim().length > 0, `${key} rong o ${code}`);
    }
  }
  // Key cua moi tinh nang phai co mat.
  for (const key of [
    'memoryV27.title',
    'memoryV27.intro',
    'memoryV27.addOnly',
    'memoryV27.extract',
    'memoryV27.entityBoost',
    'memoryV27.timeTravel',
    'memoryV27.provenance',
    'memoryV27.supersede',
    'memoryV27.hybridSearch',
    'memoryV27.embeddingProxyNote',
    'memoryV27.timeline',
    'memoryV27.syncLog',
  ]) {
    assert.ok(key in dicts.vi, `thieu key ${key}`);
  }
});

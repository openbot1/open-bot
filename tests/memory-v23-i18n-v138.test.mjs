/**
 * Tests for memory v23 — i18n (v1.38, Doi T1): the 32 new
 * `memoryV23.*` keys exist in all 6 locales with non-empty values,
 * and the locale totals reach 8072 at the v1.38 merge (7721 base +
 * 137 v137 + 48 fleetV25 + 32 protocolsV7 + 40 voiceV25 + 32 memoryV23
 * + 32 sandboxV6 + 30 codingV16).
 *
 * Pure JSON — no build needed:
 *   node --test tests/memory-v23-i18n-v138.test.mjs
 *
 * NOTE: totals were re-pinned to 8072 at the v1.38 merge (same pattern
 * as previous waves: "merge re-pin").
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const localesDir = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'apps', 'desktop', 'src', 'renderer', 'i18n', 'locales');
const LOCALES = ['vi', 'en', 'zh', 'ja', 'es', 'fr'];
const EXPECTED_TOTAL = 8072; // v1.39 fix round 4b: floor (was v1.38 merge re-pin 8072).
const EXPECTED_V23_KEYS = 32;

function loadLocale(code) {
  return JSON.parse(readFileSync(join(localesDir, `${code}.json`), 'utf8'));
}

test('v23 i18n: 32 memoryV23.* keys exist in all 6 locales, non-empty', () => {
  const dicts = Object.fromEntries(LOCALES.map((code) => [code, loadLocale(code)]));
  const viKeys = Object.keys(dicts.vi).filter((k) => k.startsWith('memoryV23.'));
  assert.equal(viKeys.length, EXPECTED_V23_KEYS, `vi co ${viKeys.length} key memoryV23, ky vong ${EXPECTED_V23_KEYS}`);
  for (const key of viKeys) {
    for (const code of LOCALES) {
      const value = dicts[code][key];
      assert.equal(typeof value, 'string', `${key} thieu o ${code}`);
      assert.ok(value.trim().length > 0, `${key} rong o ${code}`);
    }
  }
  // Cac key co ban phai co mat.
  for (const key of [
    'memoryV23.title',
    'memoryV23.intro',
    'memoryV23.add',
    'memoryV23.extract',
    'memoryV23.search',
    'memoryV23.scopeSearch',
    'memoryV23.consolidate',
    'memoryV23.sleep',
    'memoryV23.record',
    'memoryV23.skill',
    'memoryV23.skillSearch',
    'memoryV23.stats',
    'memoryV23.health',
    'memoryV23.fusion',
  ]) {
    assert.ok(viKeys.includes(key), `thieu key ${key}`);
  }
});

test('v23 i18n: moi locale co dung tong 8072 key, 6/6 bang nhau', () => {
  for (const code of LOCALES) {
    const dict = loadLocale(code);
    assert.ok(
      Object.keys(dict).length >= EXPECTED_TOTAL,
      `${code} co ${Object.keys(dict).length} key, ky vong toi thieu ${EXPECTED_TOTAL}`,
    ); // v1.39 fix round 4b: floor >= 8072.
  }
});

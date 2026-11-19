/**
 * Tests for memory v25 — i18n (v1.40, Doi T1): the 30 new
 * `memoryV25.*` keys exist in all 6 locales with non-empty values,
 * and the locale totals are equal and at least 8352 (8322 base + 30 memoryV25).
 * No hardcoded total: later v140 teams add their own keys on top.
 *
 * Pure JSON — no build needed:
 *   node --test tests/memory-v25-i18n-v140.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const localesDir = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'apps', 'desktop', 'src', 'renderer', 'i18n', 'locales');
const LOCALES = ['vi', 'en', 'zh', 'ja', 'es', 'fr'];
const EXPECTED_TOTAL_MIN = 8352; // 8322 v1.40 base + 30 memoryV25 (floor, not exact).
const EXPECTED_V25_KEYS = 30;

function loadLocale(code) {
  return JSON.parse(readFileSync(join(localesDir, `${code}.json`), 'utf8'));
}

test('v25 i18n: 30 memoryV25.* keys exist in all 6 locales, non-empty', () => {
  const dicts = Object.fromEntries(LOCALES.map((code) => [code, loadLocale(code)]));
  const totals = LOCALES.map((code) => Object.keys(dicts[code]).length);
  assert.equal(new Set(totals).size, 1, `6 locale phai co cung tong key: ${totals.join(', ')}`);
  for (const code of LOCALES) {
    assert.ok(
      Object.keys(dicts[code]).length >= EXPECTED_TOTAL_MIN,
      `${code} co ${Object.keys(dicts[code]).length} key, ky vong >= ${EXPECTED_TOTAL_MIN}`,
    );
  }
  const viKeys = Object.keys(dicts.vi).filter((k) => k.startsWith('memoryV25.'));
  assert.equal(viKeys.length, EXPECTED_V25_KEYS, `vi co ${viKeys.length} key memoryV25, ky vong ${EXPECTED_V25_KEYS}`);
  for (const key of viKeys) {
    for (const code of LOCALES) {
      const value = dicts[code][key];
      assert.equal(typeof value, 'string', `${key} thieu o ${code}`);
      assert.ok(value.trim().length > 0, `${key} rong o ${code}`);
    }
  }
  // Key cua moi tinh nang phai co mat.
  for (const key of [
    'memoryV25.title',
    'memoryV25.intro',
    'memoryV25.sleep',
    'memoryV25.sleepAgent',
    'memoryV25.sleepConfig',
    'memoryV25.sleepPass',
    'memoryV25.triggerSteps',
    'memoryV25.model',
    'memoryV25.budget',
    'memoryV25.blocks',
    'memoryV25.sharedBlock',
    'memoryV25.readOnly',
    'memoryV25.attach',
    'memoryV25.detach',
    'memoryV25.fact',
    'memoryV25.factEdge',
    'memoryV25.validAt',
    'memoryV25.invalidAt',
    'memoryV25.judge',
    'memoryV25.judgeAdd',
    'memoryV25.judgeUpdate',
    'memoryV25.judgeDelete',
    'memoryV25.judgeNoise',
    'memoryV25.consolidate',
    'memoryV25.search',
    'memoryV25.asOf',
    'memoryV25.current',
    'memoryV25.history',
    'memoryV25.audit',
    'memoryV25.stats',
  ]) {
    assert.ok(viKeys.includes(key), `thieu key ${key}`);
  }
});

test('v25 i18n: key locale duoc sort trong ca 6 file', () => {
  for (const code of LOCALES) {
    const dict = loadLocale(code);
    const keys = Object.keys(dict);
    assert.deepEqual(keys, [...keys].sort(), `${code} key chua sort`);
  }
});

/**
 * Tests for memory v28 — i18n (v1.44, Doi T1): the 48 new
 * `memoryV28.*` keys exist in all 6 locales with non-empty values,
 * and the locale totals are equal and at least 9293 (9245 v1.44
 * base + 48 memoryV28 — floor, not exact total, de doi sau cong
 * them key cua minh).
 *
 * Pure JSON — no build needed:
 *   node --test tests/memory-v28-i18n-v144.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const localesDir = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'apps', 'desktop', 'src', 'renderer', 'i18n', 'locales');
const LOCALES = ['vi', 'en', 'zh', 'ja', 'es', 'fr'];
const EXPECTED_TOTAL_MIN = 9293; // 9245 truoc v28 + 48 memoryV28 (floor, not exact).
const EXPECTED_V28_KEYS = 48;

function loadLocale(code) {
  return JSON.parse(readFileSync(join(localesDir, `${code}.json`), 'utf8'));
}

test('v28 i18n: 48 memoryV28.* keys exist in all 6 locales, non-empty', () => {
  const dicts = Object.fromEntries(LOCALES.map((code) => [code, loadLocale(code)]));
  const totals = LOCALES.map((code) => Object.keys(dicts[code]).length);
  assert.equal(new Set(totals).size, 1, `6 locale phai co cung tong key: ${totals.join(', ')}`);
  for (const code of LOCALES) {
    assert.ok(
      Object.keys(dicts[code]).length >= EXPECTED_TOTAL_MIN,
      `${code} co ${Object.keys(dicts[code]).length} key, ky vong >= ${EXPECTED_TOTAL_MIN}`,
    );
  }
  const viKeys = Object.keys(dicts.vi).filter((k) => k.startsWith('memoryV28.'));
  assert.equal(viKeys.length, EXPECTED_V28_KEYS, `vi co ${viKeys.length} key memoryV28, ky vong ${EXPECTED_V28_KEYS}`);
  for (const key of viKeys) {
    for (const code of LOCALES) {
      const value = dicts[code][key];
      assert.equal(typeof value, 'string', `${key} thieu o ${code}`);
      assert.ok(value.trim().length > 0, `${key} rong o ${code}`);
    }
  }
  // Key cua moi tinh nang phai co mat.
  for (const key of [
    'memoryV28.title',
    'memoryV28.intro',
    'memoryV28.gitBacked',
    'memoryV28.gitBackedHint',
    'memoryV28.sharedBlocks',
    'memoryV28.sharedBlocksHint',
    'memoryV28.sleepConsolidation',
    'memoryV28.sleepConsolidationHint',
    'memoryV28.timeTravel',
    'memoryV28.timeTravelHint',
    'memoryV28.biTemporal',
    'memoryV28.biTemporalHint',
    'memoryV28.blockRolledBack',
    'memoryV28.accessDenied',
    'memoryV28.sleepRun',
    'memoryV28.sleepDryRun',
    'memoryV28.stateAt',
    'memoryV28.diffRange',
    'memoryV28.factSuperseded',
    'memoryV28.gitUnavailable',
    'memoryV28.fallbackMode',
    'memoryV28.rollback',
    'memoryV28.grant',
    'memoryV28.revoke',
    'memoryV28.attach',
    'memoryV28.detach',
    'memoryV28.audit',
    'memoryV28.validFrom',
    'memoryV28.validTo',
  ]) {
    assert.ok(viKeys.includes(key), `thieu key ${key}`);
  }
});

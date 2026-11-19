/**
 * Tests for memory v22 — i18n (v1.37, Doi T1): the 47 new
 * `memoryV22.*` keys exist in all 6 locales with non-empty values,
 * and the locale totals stay in parity across locales.
 *
 * Pure JSON — no build needed:
 *   node --test tests/memory-v22-i18n-v137.test.mjs
 *
 * NOTE for the merge coordinator: 47 older tests pin the old
 * total (7540) and need a re-pin to 7587 at merge time (same
 * pattern as previous waves: "merge re-pin"). This file only
 * asserts the v22 keys + cross-locale parity, never the old total.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const localesDir = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'apps', 'desktop', 'src', 'renderer', 'i18n', 'locales');
const LOCALES = ['vi', 'en', 'zh', 'ja', 'es', 'fr'];
const EXPECTED_V22_KEYS = 47;

function loadLocale(code) {
  return JSON.parse(readFileSync(join(localesDir, `${code}.json`), 'utf8'));
}

test('v22 i18n: 47 memoryV22.* keys exist in all 6 locales, non-empty', () => {
  const dicts = Object.fromEntries(LOCALES.map((code) => [code, loadLocale(code)]));
  const viKeys = Object.keys(dicts.vi).filter((k) => k.startsWith('memoryV22.'));
  assert.equal(viKeys.length, EXPECTED_V22_KEYS, `vi co ${viKeys.length} key memoryV22, ky vong ${EXPECTED_V22_KEYS}`);
  for (const key of viKeys) {
    for (const code of LOCALES) {
      const value = dicts[code][key];
      assert.equal(typeof value, 'string', `${key} thieu o ${code}`);
      assert.ok(value.trim().length > 0, `${key} rong o ${code}`);
    }
  }
  // Tong locale phai bang nhau giua cac locale (parity) — khong pin so cu.
  const totals = LOCALES.map((code) => Object.keys(dicts[code]).length);
  assert.ok(totals.every((t) => t === totals[0]), `tong locale lech nhau: ${LOCALES.map((c, i) => `${c}=${totals[i]}`).join(', ')}`);
  // Cac key co ban phai co mat.
  for (const key of [
    'memoryV22.title',
    'memoryV22.intro',
    'memoryV22.dream',
    'memoryV22.dreamRun',
    'memoryV22.dreamReport',
    'memoryV22.dreamConfig',
    'memoryV22.dreamStatus',
    'memoryV22.dreamFact',
    'memoryV22.dreamWiki',
    'memoryV22.dreamBudget',
    'memoryV22.dreamSnapshot',
    'memoryV22.dreamRollback',
    'memoryV22.dreamAudit',
    'memoryV22.dreamDryRun',
    'memoryV22.dreamChanges',
    'memoryV22.dreamEvidence',
  ]) {
    assert.ok(viKeys.includes(key), `thieu key ${key}`);
  }
});

test('v22 i18n: khong hard-code tieng Viet trong key tieng Anh', () => {
  const en = loadLocale('en');
  const vi = loadLocale('vi');
  // Mot vai key tieng Anh khong duoc trung y het tieng Viet (tranh copy nham).
  for (const key of ['memoryV22.dreamReport', 'memoryV22.dreamRollback', 'memoryV22.dreamBudget']) {
    assert.notEqual(en[key], vi[key], `${key} en/vi giong het nhau — co the copy nham`);
  }
  // Title tieng Viet duoc phep trung ten san pham, nhung intro phai khac.
  assert.notEqual(en['memoryV22.intro'], vi['memoryV22.intro']);
});

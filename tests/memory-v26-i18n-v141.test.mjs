/**
 * Tests for memory v26 — i18n (v1.41, Doi T1): the 60 new
 * `memoryV26.*` keys exist in all 6 locales with non-empty values,
 * and the locale totals are equal and at least 8609 (8579 v1.40
 * base + 30 memoryV25 is wrong here: base truoc v26 la 8579,
 * + 60 memoryV26 = 8639 — floor dung 8639, khong pin tong
 * chinh xac de doi sau cong them key cua minh).
 * No hardcoded total beyond the floor: later v141 teams add
 * their own keys on top.
 *
 * Pure JSON — no build needed:
 *   node --test tests/memory-v26-i18n-v141.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const localesDir = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'apps', 'desktop', 'src', 'renderer', 'i18n', 'locales');
const LOCALES = ['vi', 'en', 'zh', 'ja', 'es', 'fr'];
const EXPECTED_TOTAL_MIN = 8639; // 8579 truoc v26 + 60 memoryV26 (floor, not exact).
const EXPECTED_V26_KEYS = 60;

function loadLocale(code) {
  return JSON.parse(readFileSync(join(localesDir, `${code}.json`), 'utf8'));
}

test('v26 i18n: 60 memoryV26.* keys exist in all 6 locales, non-empty', () => {
  const dicts = Object.fromEntries(LOCALES.map((code) => [code, loadLocale(code)]));
  const totals = LOCALES.map((code) => Object.keys(dicts[code]).length);
  assert.equal(new Set(totals).size, 1, `6 locale phai co cung tong key: ${totals.join(', ')}`);
  for (const code of LOCALES) {
    assert.ok(
      Object.keys(dicts[code]).length >= EXPECTED_TOTAL_MIN,
      `${code} co ${Object.keys(dicts[code]).length} key, ky vong >= ${EXPECTED_TOTAL_MIN}`,
    );
  }
  const viKeys = Object.keys(dicts.vi).filter((k) => k.startsWith('memoryV26.'));
  assert.equal(viKeys.length, EXPECTED_V26_KEYS, `vi co ${viKeys.length} key memoryV26, ky vong ${EXPECTED_V26_KEYS}`);
  for (const key of viKeys) {
    for (const code of LOCALES) {
      const value = dicts[code][key];
      assert.equal(typeof value, 'string', `${key} thieu o ${code}`);
      assert.ok(value.trim().length > 0, `${key} rong o ${code}`);
    }
  }
  // Key cua moi tinh nang phai co mat.
  for (const key of [
    'memoryV26.title',
    'memoryV26.intro',
    'memoryV26.registry',
    'memoryV26.sharedBlock',
    'memoryV26.blocks',
    'memoryV26.attach',
    'memoryV26.detach',
    'memoryV26.readOnly',
    'memoryV26.budget',
    'memoryV26.tokenBudget',
    'memoryV26.tokens',
    'memoryV26.tokensTotal',
    'memoryV26.tokensSaved',
    'memoryV26.overBudget',
    'memoryV26.curate',
    'memoryV26.summarise',
    'memoryV26.conflict',
    'memoryV26.conflictsTitle',
    'memoryV26.openConflicts',
    'memoryV26.audit',
    'memoryV26.auditTitle',
    'memoryV26.archival',
    'memoryV26.archiveTitle',
    'memoryV26.recall',
    'memoryV26.template',
    'memoryV26.templates',
    'memoryV26.kindHuman',
    'memoryV26.kindPersona',
    'memoryV26.kindTask',
    'memoryV26.kindProject',
    'memoryV26.quota',
    'memoryV26.export',
    'memoryV26.import',
    'memoryV26.search',
  ]) {
    assert.ok(viKeys.includes(key), `thieu key ${key}`);
  }
  // Key panel dung phai ton tai (panel MemoryV26Panel dung 40 key).
  const panelSrc = readFileSync(
    join(fileURLToPath(new URL('.', import.meta.url)), '..', 'apps', 'desktop', 'src', 'renderer', 'components', 'MemoryV26Panel.tsx'),
    'utf8',
  );
  const used = [...panelSrc.matchAll(/t\('memoryV26\.([a-zA-Z]+)'\)/g)].map((m) => `memoryV26.${m[1]}`);
  assert.ok(used.length >= 30, `panel dung ${used.length} key, ky vong >= 30`);
  for (const key of new Set(used)) {
    assert.ok(viKeys.includes(key), `panel dung key ${key} nhung key khong ton tai`);
  }
});

/**
 * Tests for v1.12 (Doi T1) — memory v12 i18n:
 * apps/desktop/src/renderer/i18n/locales/*.json.
 *
 * Covers: 25 memoryBlockV12.* keys present in all 6 locales
 * (vi/en/zh/ja/es/fr), non-empty in every locale, identical key
 * sets across locales, total key count 4590 per locale
 * (4565 v1.11 + 25 v12).
 *
 * Run:
 *   node --test tests/memory-v12-i18n.test.mjs
 *
 * No network. No model.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LOCALES_DIR = path.join(HERE, '..', 'apps', 'desktop', 'src', 'renderer', 'i18n', 'locales');
const LOCALES = ['vi', 'en', 'zh', 'ja', 'es', 'fr'];

const EXPECTED_V12_KEYS = [
  'memoryBlockV12.audit',
  'memoryBlockV12.compile',
  'memoryBlockV12.compileEmpty',
  'memoryBlockV12.dropped',
  'memoryBlockV12.edit',
  'memoryBlockV12.editTitle',
  'memoryBlockV12.intro',
  'memoryBlockV12.janitor',
  'memoryBlockV12.janitorDryRun',
  'memoryBlockV12.janitorRun',
  'memoryBlockV12.newText',
  'memoryBlockV12.occurrence',
  'memoryBlockV12.occurrenceHelp',
  'memoryBlockV12.oldText',
  'memoryBlockV12.overBudget',
  'memoryBlockV12.search',
  'memoryBlockV12.searchPlaceholder',
  'memoryBlockV12.systemBlock',
  'memoryBlockV12.systemBlockAskUser',
  'memoryBlockV12.systemBlockReadOnly',
  'memoryBlockV12.title',
  'memoryBlockV12.tokenBudget',
  'memoryBlockV12.tokenLimit',
  'memoryBlockV12.tokens',
  'memoryBlockV12.truncated',
];

function loadLocale(loc) {
  return JSON.parse(fs.readFileSync(path.join(LOCALES_DIR, `${loc}.json`), 'utf8'));
}

test('i18n v12: 25 memoryBlockV12.* keys in all 6 locales, total 5278', () => {
  assert.equal(EXPECTED_V12_KEYS.length, 25);
  const dicts = {};
  for (const loc of LOCALES) {
    const dict = loadLocale(loc);
    dicts[loc] = dict;
    assert.equal(Object.keys(dict).length, 7540, `${loc} key count`); // v1.36 re-pin: 7540.
    for (const key of EXPECTED_V12_KEYS) {
      assert.ok(key in dict, `${loc} missing ${key}`);
      assert.equal(typeof dict[key], 'string', `${loc}.${key} must be a string`);
      assert.ok(dict[key].trim() !== '', `${loc}.${key} must not be empty`);
    }
  }
  // Identical key sets across locales (no locale may drift).
  const base = Object.keys(dicts.vi).sort();
  for (const loc of LOCALES.slice(1)) {
    assert.deepEqual(Object.keys(dicts[loc]).sort(), base, `${loc} key set differs from vi`);
  }
});

test('i18n v12: spot-check translations differ per locale (not copy-pasted English)', () => {
  const dicts = Object.fromEntries(LOCALES.map((loc) => [loc, loadLocale(loc)]));
  // title/intro differ across locales (vi is the source language).
  assert.notEqual(dicts.en['memoryBlockV12.intro'], dicts.vi['memoryBlockV12.intro']);
  assert.notEqual(dicts.zh['memoryBlockV12.title'], dicts.en['memoryBlockV12.title']);
  assert.notEqual(dicts.ja['memoryBlockV12.systemBlock'], dicts.en['memoryBlockV12.systemBlock']);
  assert.notEqual(dicts.es['memoryBlockV12.janitorRun'], dicts.en['memoryBlockV12.janitorRun']);
  assert.notEqual(dicts.fr['memoryBlockV12.audit'], dicts.en['memoryBlockV12.audit']);
  // Every locale's read-only warning mentions its own word for "read-only".
  assert.match(dicts.vi['memoryBlockV12.systemBlockReadOnly'], /chỉ đọc/);
  assert.match(dicts.en['memoryBlockV12.systemBlockReadOnly'], /read-only/);
  assert.match(dicts.zh['memoryBlockV12.systemBlockReadOnly'], /只读/);
});

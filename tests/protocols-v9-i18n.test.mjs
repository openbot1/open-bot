/**
 * Tests for v1.40 (Team T2) — protocols v9 i18n:
 * apps/desktop/src/renderer/i18n/locales/{en,vi,zh,ja,es,fr}.json
 *
 * Covers:
 *  - all 6 locales have the same key count (no locale left behind)
 *  - every protocolsV9.* key exists in every locale, non-empty,
 *    and the English value differs from the key name (real text,
 *    not a placeholder)
 *  - the 24 protocolsV9 keys are exactly the documented set
 *
 * Run:
 *   node --test tests/protocols-v9-i18n.test.mjs
 *
 * No build needed (reads the JSON files directly). No network.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const LOCALES = ['en', 'vi', 'zh', 'ja', 'es', 'fr'];
const EXPECTED_KEYS = [
  'protocolsV9.a2aCardsHint',
  'protocolsV9.a2aCardsTitle',
  'protocolsV9.a2aDelegateHint',
  'protocolsV9.a2aDelegateTitle',
  'protocolsV9.a2aHint',
  'protocolsV9.a2aTasksHint',
  'protocolsV9.a2aTasksTitle',
  'protocolsV9.a2aTitle',
  'protocolsV9.acpHint',
  'protocolsV9.acpSessionsHint',
  'protocolsV9.acpSessionsTitle',
  'protocolsV9.acpTitle',
  'protocolsV9.appsHint',
  'protocolsV9.appsLifecycleHint',
  'protocolsV9.appsLifecycleTitle',
  'protocolsV9.appsTitle',
  'protocolsV9.loopbackOnlyHint',
  'protocolsV9.registryHint',
  'protocolsV9.registryTitle',
  'protocolsV9.snapshotsHint',
  'protocolsV9.snapshotsTitle',
  'protocolsV9.title',
  'protocolsV9.versionsHint',
  'protocolsV9.versionsTitle',
];

function loadLocale(locale) {
  return JSON.parse(readFileSync(
    new URL(`../apps/desktop/src/renderer/i18n/locales/${locale}.json`, import.meta.url),
    'utf-8',
  ));
}

test('all 6 locales have equal key counts', () => {
  const counts = LOCALES.map((locale) => Object.keys(loadLocale(locale)).length);
  assert.ok(counts.every((c) => c === counts[0]), `locale key counts differ: ${counts.join(', ')}`);
  // No hardcoded global total: later v140 teams add their own keys on top
  // (the old v139 [8091] snapshot broke when other teams merged).
  // Baseline: merge/v140 base 8322 + 24 protocolsV9 keys = 8346.
  assert.ok(counts[0] >= 8346, `total must cover base 8322 + 24 protocolsV9 keys (got ${counts[0]})`);
});

test('every protocolsV9 key exists in every locale, non-empty, real text', () => {
  for (const locale of LOCALES) {
    const data = loadLocale(locale);
    for (const key of EXPECTED_KEYS) {
      assert.equal(typeof data[key], 'string', `${locale} missing ${key}`);
      assert.ok(data[key].trim().length > 0, `${locale} has empty ${key}`);
    }
  }
  const en = loadLocale('en');
  for (const key of EXPECTED_KEYS) {
    assert.notEqual(en[key], key, `English value for ${key} is just the key name`);
  }
});

test('the 24 protocolsV9 keys are exactly the documented set', () => {
  for (const locale of LOCALES) {
    const data = loadLocale(locale);
    const found = Object.keys(data).filter((k) => k.startsWith('protocolsV9.'));
    assert.deepEqual(found.sort(), [...EXPECTED_KEYS].sort(), `${locale} has unexpected protocolsV9 keys`);
  }
});

test('locale files stay key-sorted', () => {
  for (const locale of LOCALES) {
    const data = loadLocale(locale);
    const keys = Object.keys(data);
    const sorted = [...keys].sort();
    assert.deepEqual(keys, sorted, `${locale} keys are not sorted`);
  }
});

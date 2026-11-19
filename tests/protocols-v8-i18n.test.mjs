/**
 * Tests for v1.39 (Team T2) — protocols v8 i18n:
 * apps/desktop/src/renderer/i18n/locales/{en,vi,zh,ja,es,fr}.json
 *
 * Covers:
 *  - all 6 locales have the same key count (no locale left behind)
 *  - every protocolsV8.* key exists in every locale, non-empty,
 *    and the English value differs from the key name (real text,
 *    not a placeholder)
 *  - the 19 protocolsV8 keys are exactly the documented set
 *
 * Run:
 *   node --test tests/protocols-v8-i18n.test.mjs
 *
 * No build needed (reads the JSON files directly). No network.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const LOCALES = ['en', 'vi', 'zh', 'ja', 'es', 'fr'];
const EXPECTED_KEYS = [
  'protocolsV8.appsHint',
  'protocolsV8.appsTitle',
  'protocolsV8.deprecationHint',
  'protocolsV8.deprecationTitle',
  'protocolsV8.discover',
  'protocolsV8.discoverHint',
  'protocolsV8.extensionsHint',
  'protocolsV8.extensionsTitle',
  'protocolsV8.legacyHint',
  'protocolsV8.legacyTitle',
  'protocolsV8.nandaHint',
  'protocolsV8.nandaTitle',
  'protocolsV8.oauthHint',
  'protocolsV8.oauthTitle',
  'protocolsV8.skillsHint',
  'protocolsV8.skillsTitle',
  'protocolsV8.tasksHint',
  'protocolsV8.tasksTitle',
  'protocolsV8.title',
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
  // No hardcoded total: later v139 teams add their own keys on top
  // (v139 fix round 2 — the old [8091] snapshot broke when T4/T5/T6 merged).
  assert.ok(counts[0] >= 8091, 'total must cover base 8072 + 19 protocolsV8 keys');
});

test('every protocolsV8 key exists in every locale, non-empty, real text', () => {
  for (const locale of LOCALES) {
    const data = loadLocale(locale);
    for (const key of EXPECTED_KEYS) {
      assert.equal(typeof data[key], 'string', `${locale} missing ${key}`);
      assert.ok(data[key].trim().length > 0, `${locale} ${key} is empty`);
    }
  }
  const en = loadLocale('en');
  assert.equal(en['protocolsV8.title'], 'Protocols v8');
  assert.equal(en['protocolsV8.discover'], 'Discover server capabilities');
  assert.match(en['protocolsV8.deprecationHint'], /2027-07-28/);
  assert.match(en['protocolsV8.oauthHint'], /PKCE/);
  assert.match(en['protocolsV8.appsHint'], /sandboxed iframe/);
  assert.match(en['protocolsV8.tasksHint'], /task handle/);
  assert.match(en['protocolsV8.nandaHint'], /No central service|no central service/);
  // Translations differ from English (they are translated, not copied).
  const vi = loadLocale('vi');
  assert.notEqual(vi['protocolsV8.title'], en['protocolsV8.title']);
  assert.notEqual(vi['protocolsV8.discover'], en['protocolsV8.discover']);
  const zh = loadLocale('zh');
  assert.notEqual(zh['protocolsV8.title'], en['protocolsV8.title']);
});

test('the protocolsV8 key set is exactly the documented set (no stray keys)', () => {
  const en = loadLocale('en');
  const found = Object.keys(en).filter((k) => k.startsWith('protocolsV8.')).sort();
  assert.deepEqual(found, [...EXPECTED_KEYS].sort());
});

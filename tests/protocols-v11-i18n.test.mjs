/**
 * Tests for v1.42 (Team T2) — protocols v11 i18n:
 * apps/desktop/src/renderer/i18n/locales/{en,vi,zh,ja,es,fr}.json
 *
 * Covers:
 *  - all 6 locales have the same key count (no locale left behind)
 *  - every protocols.v11.* key exists in every locale, non-empty,
 *    and the English value differs from the key name (real text,
 *    not a placeholder)
 *  - the 31 protocols.v11 keys are exactly the documented set
 *  - the total key count is at least the v1.42 base (8935) plus
 *    the 31 v11 keys — a floor, not an exact pin: other teams
 *    add keys in the same wave, so an exact total would be
 *    their test's business, not this one's (lesson from v1.41)
 *
 * Run:
 *   node --test tests/protocols-v11-i18n.test.mjs
 *
 * No build needed (reads the JSON files directly). No network.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const LOCALES = ['en', 'vi', 'zh', 'ja', 'es', 'fr'];
const EXPECTED_KEYS = [
  'protocols.v11.appsHint',
  'protocols.v11.appsTitle',
  'protocols.v11.cacheHint',
  'protocols.v11.cacheTitle',
  'protocols.v11.deprecationHint',
  'protocols.v11.deprecationTitle',
  'protocols.v11.discoverHint',
  'protocols.v11.discoverTitle',
  'protocols.v11.interopHint',
  'protocols.v11.interopTitle',
  'protocols.v11.intro',
  'protocols.v11.legacyHint',
  'protocols.v11.metaHint',
  'protocols.v11.metaTitle',
  'protocols.v11.oauthHint',
  'protocols.v11.oauthTitle',
  'protocols.v11.registryHint',
  'protocols.v11.registryTitle',
  'protocols.v11.roundtripHint',
  'protocols.v11.roundtripTitle',
  'protocols.v11.statelessHint',
  'protocols.v11.statelessTitle',
  'protocols.v11.taskCancelled',
  'protocols.v11.taskCompleted',
  'protocols.v11.taskFailed',
  'protocols.v11.taskInputRequired',
  'protocols.v11.tasksHint',
  'protocols.v11.tasksTitle',
  'protocols.v11.title',
  'protocols.v11.versionsHint',
  'protocols.v11.versionsTitle',
];
// Base key count at the v1.42 survey (8935) + the 31 v11 keys.
const TOTAL_KEY_FLOOR = 8935 + EXPECTED_KEYS.length;

function loadLocale(locale) {
  return JSON.parse(readFileSync(new URL(`../apps/desktop/src/renderer/i18n/locales/${locale}.json`, import.meta.url), 'utf8'));
}

test('all 6 locales have the same key count, at least the v1.42 floor', () => {
  const counts = LOCALES.map((locale) => Object.keys(loadLocale(locale)).length);
  assert.ok(counts.every((count) => count === counts[0]), `locale counts differ: ${counts.join(', ')}`);
  assert.ok(counts[0] >= TOTAL_KEY_FLOOR, `total ${counts[0]} < floor ${TOTAL_KEY_FLOOR}`);
});

test('every protocols.v11 key exists in every locale, non-empty, real text', () => {
  const locales = Object.fromEntries(LOCALES.map((locale) => [locale, loadLocale(locale)]));
  for (const key of EXPECTED_KEYS) {
    for (const locale of LOCALES) {
      const value = locales[locale][key];
      assert.equal(typeof value, 'string', `${key} missing in ${locale}`);
      assert.ok(value.length > 0, `${key} is empty in ${locale}`);
    }
    assert.notEqual(locales.en[key], key, `${key} English value is just the key name`);
  }
  // The documented set is exactly the keys present.
  const enV11 = Object.keys(locales.en).filter((k) => k.startsWith('protocols.v11.')).sort();
  assert.deepEqual(enV11, [...EXPECTED_KEYS].sort());
});

test('v11 hint texts name the v11 surface (discover, iss, handshake, cache)', () => {
  const en = loadLocale('en');
  assert.match(en['protocols.v11.intro'], /2026-07-28/);
  assert.match(en['protocols.v11.discoverHint'], /only entry point/);
  assert.match(en['protocols.v11.oauthHint'], /RFC 9207/);
  assert.match(en['protocols.v11.interopHint'], /2025-11-25/);
  assert.match(en['protocols.v11.cacheHint'], /listHash/);
  assert.match(en['protocols.v11.deprecationHint'], /2027-07-28/);
  assert.match(en['protocols.v11.tasksHint'], /io\.modelcontextprotocol\/tasks/);
});

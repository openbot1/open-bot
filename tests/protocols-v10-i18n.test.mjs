/**
 * Tests for v1.41 (Team T2) — protocols v10 i18n:
 * apps/desktop/src/renderer/i18n/locales/{en,vi,zh,ja,es,fr}.json
 *
 * Covers:
 *  - all 6 locales have the same key count (no locale left behind)
 *  - every protocols.v10.* key exists in every locale, non-empty,
 *    and the English value differs from the key name (real text,
 *    not a placeholder)
 *  - the 30 protocols.v10 keys are exactly the documented set
 *
 * Run:
 *   node --test tests/protocols-v10-i18n.test.mjs
 *
 * No build needed (reads the JSON files directly). No network.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const LOCALES = ['en', 'vi', 'zh', 'ja', 'es', 'fr'];
const EXPECTED_KEYS = [
  'protocols.v10.a2aHint',
  'protocols.v10.a2aTitle',
  'protocols.v10.appsBridgeHint',
  'protocols.v10.appsBridgeTitle',
  'protocols.v10.appsHint',
  'protocols.v10.appsTitle',
  'protocols.v10.deprecationHint',
  'protocols.v10.deprecationTitle',
  'protocols.v10.intro',
  'protocols.v10.loopbackHint',
  'protocols.v10.oauthHint',
  'protocols.v10.oauthTitle',
  'protocols.v10.registryHint',
  'protocols.v10.registryTitle',
  'protocols.v10.roundtripHint',
  'protocols.v10.roundtripTitle',
  'protocols.v10.scriptHint',
  'protocols.v10.scriptTitle',
  'protocols.v10.statelessHint',
  'protocols.v10.statelessTitle',
  'protocols.v10.taskCancelled',
  'protocols.v10.taskCompleted',
  'protocols.v10.taskFailed',
  'protocols.v10.tasksHint',
  'protocols.v10.tasksTitle',
  'protocols.v10.title',
  'protocols.v10.toolSearchHint',
  'protocols.v10.toolSearchTitle',
  'protocols.v10.versionsHint',
  'protocols.v10.versionsTitle',
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
  // No hardcoded global total: other v141 teams add their own keys on top.
});

test('every protocols.v10 key exists in every locale, non-empty', () => {
  for (const locale of LOCALES) {
    const data = loadLocale(locale);
    for (const key of EXPECTED_KEYS) {
      assert.equal(typeof data[key], 'string', `${locale} is missing ${key}`);
      assert.ok(data[key].length > 0, `${locale}.${key} is empty`);
    }
  }
});

test('the protocols.v10 key set is exactly the documented set', () => {
  for (const locale of LOCALES) {
    const data = loadLocale(locale);
    const actual = Object.keys(data).filter((k) => k.startsWith('protocols.v10.')).sort();
    assert.deepEqual(actual, EXPECTED_KEYS);
  }
});

test('English values are real text, not the key name', () => {
  const en = loadLocale('en');
  for (const key of EXPECTED_KEYS) {
    assert.notEqual(en[key], key, `${key} is a placeholder`);
    assert.ok(en[key].length >= 3, `${key} is suspiciously short`);
  }
  assert.equal(en['protocols.v10.title'], 'Protocols v10');
  assert.match(en['protocols.v10.statelessHint'], /no session id/i);
  assert.match(en['protocols.v10.loopbackHint'], /loopback/);
});

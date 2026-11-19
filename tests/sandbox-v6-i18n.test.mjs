/**
 * Sandbox v6 — i18n keys tests (v1.38, Đội T3).
 *
 * The 32 `sandboxV6.*` keys must exist in all 6 locales,
 * non-empty, with placeholders matching `en`, and the locale
 * totals reach 8072 at the v1.38 merge (7721 + 137 + 48 + 32 + 40 +
 * 32 + 32 + 30).
 *
 * Pure JSON test, no build needed:
 *   node --test tests/sandbox-v6-i18n.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const localesDir = join(here, '..', 'apps/desktop/src/renderer/i18n/locales');
const LOCALE_NAMES = ['en', 'vi', 'es', 'fr', 'ja', 'zh'];

const V138_KEYS = [
  'sandboxV6.auditChainBroken',
  'sandboxV6.auditChainOk',
  'sandboxV6.auditExport',
  'sandboxV6.auditQuery',
  'sandboxV6.auditSummary',
  'sandboxV6.auditTitle',
  'sandboxV6.diskReclaim',
  'sandboxV6.enforcementVerify',
  'sandboxV6.execRun',
  'sandboxV6.execTitle',
  'sandboxV6.noRuntime',
  'sandboxV6.quotaExceeded',
  'sandboxV6.quotaGet',
  'sandboxV6.quotaPresets',
  'sandboxV6.quotaSet',
  'sandboxV6.quotaTitle',
  'sandboxV6.runtimeCreate',
  'sandboxV6.runtimeDestroy',
  'sandboxV6.runtimeList',
  'sandboxV6.runtimePause',
  'sandboxV6.runtimeReport',
  'sandboxV6.runtimeResume',
  'sandboxV6.runtimeStop',
  'sandboxV6.runtimeTitle',
  'sandboxV6.secretGet',
  'sandboxV6.secretGrant',
  'sandboxV6.secretList',
  'sandboxV6.secretPut',
  'sandboxV6.secretRevoke',
  'sandboxV6.secretTitle',
  'sandboxV6.title',
  'sandboxV6.usageTitle',
];

function placeholders(value) {
  return [...value.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
}

function loadLocale(name) {
  return JSON.parse(readFileSync(join(localesDir, `${name}.json`), 'utf8'));
}

test('all 32 sandboxV6 keys exist in all 6 locales and are non-empty', () => {
  for (const locale of LOCALE_NAMES) {
    const data = loadLocale(locale);
    assert.ok(Object.keys(data).length >= 8072, `${locale} should have at least 8072 keys, got ${Object.keys(data).length}`); // v1.39 fix round 4b: floor >= 8072 (was v1.38 re-pin 8072).
    for (const key of V138_KEYS) {
      assert.ok(key in data, `${locale} is missing ${key}`);
      assert.equal(typeof data[key], 'string', `${locale}.${key} must be a string`);
      assert.ok(data[key].trim().length > 0, `${locale}.${key} must be non-empty`);
    }
  }
});

test('placeholders match en in every locale', () => {
  const en = loadLocale('en');
  for (const locale of LOCALE_NAMES) {
    if (locale === 'en') continue;
    const data = loadLocale(locale);
    for (const key of V138_KEYS) {
      assert.deepEqual(
        placeholders(data[key]),
        placeholders(en[key]),
        `${locale}.${key} placeholders must match en`,
      );
    }
  }
});

test('quotaExceeded carries {resource}, {used}, {limit} in every locale', () => {
  for (const locale of LOCALE_NAMES) {
    const data = loadLocale(locale);
    assert.deepEqual(placeholders(data['sandboxV6.quotaExceeded']), ['limit', 'resource', 'used']);
    assert.deepEqual(placeholders(data['sandboxV6.auditChainBroken']), ['seq']);
  }
});

test('keys are sorted (locale files stay alphabetical)', () => {
  for (const locale of LOCALE_NAMES) {
    const data = loadLocale(locale);
    const keys = Object.keys(data);
    const sorted = [...keys].sort();
    assert.deepEqual(keys, sorted, `${locale} keys must stay sorted`);
  }
});

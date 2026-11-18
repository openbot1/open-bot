/**
 * Sandbox v4 — i18n keys tests (v1.36, Đội T4).
 *
 * The 30 `sandboxV4.*` keys must exist in all 6 locales,
 * non-empty, with placeholders matching `en`, and the locale
 * totals move 7540 -> 7540.
 *
 * Pure JSON test, no build needed:
 *   node --test tests/sandbox-v4-i18n.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const localesDir = join(here, '..', 'apps/desktop/src/renderer/i18n/locales');
const LOCALE_NAMES = ['en', 'vi', 'es', 'fr', 'ja', 'zh'];

const V136_KEYS = [
  'sandboxV4.title',
  'sandboxV4.runtimeTitle',
  'sandboxV4.runtimeCreate',
  'sandboxV4.runtimeStop',
  'sandboxV4.runtimeCleanup',
  'sandboxV4.runtimeReport',
  'sandboxV4.runtimeList',
  'sandboxV4.profileTitle',
  'sandboxV4.profileCreate',
  'sandboxV4.profileSet',
  'sandboxV4.profileValidate',
  'sandboxV4.budgetTitle',
  'sandboxV4.budgetStatus',
  'sandboxV4.budgetWarning',
  'sandboxV4.budgetBlocked',
  'sandboxV4.budgetRecord',
  'sandboxV4.budgetSetLimits',
  'sandboxV4.secretTitle',
  'sandboxV4.secretRequest',
  'sandboxV4.secretApprove',
  'sandboxV4.secretDeny',
  'sandboxV4.secretList',
  'sandboxV4.secretPending',
  'sandboxV4.secretFulfilled',
  'sandboxV4.secretExpired',
  'sandboxV4.depmapTitle',
  'sandboxV4.depmapBuild',
  'sandboxV4.depmapOrder',
  'sandboxV4.depmapConflicts',
  'sandboxV4.noRuntime',
];

function placeholders(value) {
  return [...value.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
}

function loadLocale(name) {
  return JSON.parse(readFileSync(join(localesDir, `${name}.json`), 'utf8'));
}

test('i18n: 30 key sandboxV4.* có đủ 6 locale, giá trị không rỗng, tổng 7540', () => {
  assert.equal(V136_KEYS.length, 30);
  for (const locale of LOCALE_NAMES) {
    const data = loadLocale(locale);
    assert.equal(Object.keys(data).length, 7540, `${locale} total keys`); // v1.36 re-pin: 7540.
    assert.deepEqual(Object.keys(data), [...Object.keys(data)].sort(), `${locale} keys must stay sorted`);
    for (const key of V136_KEYS) {
      assert.equal(typeof data[key], 'string', `${locale}:${key} missing`);
      assert.ok(data[key].trim().length > 0, `${locale}:${key} empty`);
    }
  }
});

test('i18n: placeholders khớp en ở mọi locale', () => {
  const en = loadLocale('en');
  for (const locale of LOCALE_NAMES) {
    if (locale === 'en') continue;
    const data = loadLocale(locale);
    for (const key of V136_KEYS) {
      assert.deepEqual(
        placeholders(data[key]),
        placeholders(en[key]),
        `${locale} placeholders differ for ${key}: ${data[key]} vs ${en[key]}`,
      );
    }
  }
});

test('i18n: warning/pending keys carry their placeholders', () => {
  const en = loadLocale('en');
  assert.deepEqual(placeholders(en['sandboxV4.budgetWarning']), ['dimension', 'percent']);
  assert.deepEqual(placeholders(en['sandboxV4.secretPending']), ['count']);
});

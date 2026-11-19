/**
 * Composio v129 — i18n keys tests (v1.29, Doi T4).
 *
 * The 24 `composio.v129.*` keys must exist in all 6 locales,
 * non-empty, with placeholders matching `en`, and the locale
 * totals move 6673 -> 6863.
 *
 * Pure JSON test, no build needed:
 *   node --test tests/composio-v129-i18n.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const localesDir = join(here, '..', 'apps/desktop/src/renderer/i18n/locales');
const LOCALE_NAMES = ['en', 'vi', 'es', 'fr', 'ja', 'zh'];

const V129_KEYS = [
  'composio.v129.title',
  'composio.v129.longJobTitle',
  'composio.v129.jobSubmitted',
  'composio.v129.jobDone',
  'composio.v129.jobFailed',
  'composio.v129.jobCancelled',
  'composio.v129.jobTimeout',
  'composio.v129.jobPending',
  'composio.v129.jobRunning',
  'composio.v129.jobProgress',
  'composio.v129.pollTitle',
  'composio.v129.nextPoll',
  'composio.v129.sandboxTitle',
  'composio.v129.sandboxCreated',
  'composio.v129.sandboxExpired',
  'composio.v129.sandboxDenied',
  'composio.v129.callsLeft',
  'composio.v129.appBindTitle',
  'composio.v129.appBound',
  'composio.v129.appUnbound',
  'composio.v129.appDisabled',
  'composio.v129.mockToolkitTitle',
  'composio.v129.mockOnly',
  'composio.v129.needsLiveKey',
];

function placeholders(value) {
  return [...value.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
}

function loadLocale(name) {
  return JSON.parse(readFileSync(join(localesDir, `${name}.json`), 'utf8'));
}

test('i18n: 24 key composio.v129.* có đủ 6 locale, giá trị không rỗng, tổng 8072', () => { // v1.38 re-pin: 8072.
  assert.equal(V129_KEYS.length, 24);
  for (const locale of LOCALE_NAMES) {
    const data = loadLocale(locale);
    assert.ok(Object.keys(data).length >= 8072, `${locale} total keys`); // v1.38 re-pin: 8072.
    for (const key of V129_KEYS) {
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
    for (const key of V129_KEYS) {
      assert.deepEqual(
        placeholders(data[key]),
        placeholders(en[key]),
        `${locale} placeholders differ for ${key}: ${data[key]} vs ${en[key]}`,
      );
    }
  }
  // Các key có placeholder phải đúng placeholder đã định.
  assert.deepEqual(placeholders(en['composio.v129.jobProgress']), ['done', 'total']);
  assert.deepEqual(placeholders(en['composio.v129.nextPoll']), ['ms']);
  assert.deepEqual(placeholders(en['composio.v129.callsLeft']), ['left']);
});

test('i18n: locale files vẫn sorted (không vỡ thứ tự key)', () => {
  for (const locale of LOCALE_NAMES) {
    const data = loadLocale(locale);
    const keys = Object.keys(data);
    assert.deepEqual(keys, [...keys].sort(), `${locale} keys must stay sorted`);
  }
});

/**
 * Test v1.15 (Đội T3): i18n key mới cho local model router (26 key
 * routerLocal.*) — đủ 6 locale, không rỗng, placeholder khớp en.
 *
 * Chỉ test thuần (đọc JSON). Không cần build:
 *   node --test tests/router-local-v115-i18n.test.mjs
 *
 * Pin tổng số key/locale sống trong tests/i18n-v106.test.mjs
 * (coordinator cập nhật lúc gộp); file này không pin số tuyệt đối.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const localesDir = join(here, '..', 'apps/desktop/src/renderer/i18n/locales');
const LOCALE_NAMES = ['en', 'vi', 'es', 'fr', 'ja', 'zh'];

const ROUTER_LOCAL_KEYS = [
  'routerLocal.title',
  'routerLocal.intro',
  'routerLocal.catalog',
  'routerLocal.load',
  'routerLocal.unload',
  'routerLocal.loaded',
  'routerLocal.unloaded',
  'routerLocal.loading',
  'routerLocal.loadFailed',
  'routerLocal.licenseBlocked',
  'routerLocal.licenseOk',
  'routerLocal.ramRequired',
  'routerLocal.ramFree',
  'routerLocal.routeLocal',
  'routerLocal.routeCloud',
  'routerLocal.routeReason',
  'routerLocal.budget',
  'routerLocal.budgetUsed',
  'routerLocal.budgetWarning',
  'routerLocal.budgetExceeded',
  'routerLocal.virtualKey',
  'routerLocal.createKey',
  'routerLocal.keyCreated',
  'routerLocal.gatewayOffline',
  'routerLocal.pinned',
  'routerLocal.idleUnload',
];

function loadLocale(name) {
  return JSON.parse(readFileSync(join(localesDir, `${name}.json`), 'utf8'));
}

function placeholders(value) {
  return [...value.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
}

test('routerLocal keys: present in all 6 locales, non-empty', () => {
  for (const locale of LOCALE_NAMES) {
    const data = loadLocale(locale);
    for (const key of ROUTER_LOCAL_KEYS) {
      assert.ok(key in data, `${locale} thieu key ${key}`);
      assert.equal(typeof data[key], 'string', `${locale}.${key} phai la string`);
      assert.ok(data[key].trim().length > 0, `${locale}.${key} khong duoc rong`);
    }
  }
});

test('routerLocal keys: placeholders match en in every locale', () => {
  const en = loadLocale('en');
  for (const locale of LOCALE_NAMES) {
    if (locale === 'en') continue;
    const data = loadLocale(locale);
    for (const key of ROUTER_LOCAL_KEYS) {
      assert.deepEqual(
        placeholders(data[key]),
        placeholders(en[key]),
        `${locale}.${key} placeholder khac en`,
      );
    }
  }
});

test('routerLocal keys: all 6 locales have the same total key count', () => {
  const counts = LOCALE_NAMES.map((locale) => Object.keys(loadLocale(locale)).length);
  for (const c of counts) assert.equal(c, counts[0]);
  assert.ok(counts[0] > 5278, `tong key phai > 5278 sau khi them 26 key, nhan ${counts[0]}`);
});

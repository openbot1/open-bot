/**
 * Test v1.39 (Đội T3): i18n key mới cho local model router v116
 * (28 key routerLocalV116.*) — đủ 6 locale, không rỗng, placeholder
 * khớp en.
 *
 * Chỉ test thuần (đọc JSON). Không cần build:
 *   node --test tests/router-local-v116-i18n.test.mjs
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

const ROUTER_LOCAL_V116_KEYS = [
  'routerLocalV116.title',
  'routerLocalV116.intro',
  'routerLocalV116.scoreRank',
  'routerLocalV116.profile',
  'routerLocalV116.profileCurrent',
  'routerLocalV116.profileSet',
  'routerLocalV116.fallbackRun',
  'routerLocalV116.fallbackStatus',
  'routerLocalV116.breakerOpen',
  'routerLocalV116.breakerClosed',
  'routerLocalV116.breakerHalfOpen',
  'routerLocalV116.cliSources',
  'routerLocalV116.cliDetect',
  'routerLocalV116.cliEnable',
  'routerLocalV116.cliDisable',
  'routerLocalV116.cliAccountUnknown',
  'routerLocalV116.cliRunsVia',
  'routerLocalV116.batchEstimate',
  'routerLocalV116.batchSchedule',
  'routerLocalV116.batchOverCapacity',
  'routerLocalV116.bottleneck',
  'routerLocalV116.healthProbe',
  'routerLocalV116.healthiest',
  'routerLocalV116.uptime',
  'routerLocalV116.decisionLog',
  'routerLocalV116.decisionLogEmpty',
  'routerLocalV116.pickerList',
  'routerLocalV116.vllmMetrics',
];

function loadLocale(name) {
  return JSON.parse(readFileSync(join(localesDir, `${name}.json`), 'utf8'));
}

function placeholders(value) {
  return [...value.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
}

test('routerLocalV116 keys: present in all 6 locales, non-empty', () => {
  for (const locale of LOCALE_NAMES) {
    const data = loadLocale(locale);
    for (const key of ROUTER_LOCAL_V116_KEYS) {
      assert.ok(key in data, `${locale} thieu key ${key}`);
      assert.equal(typeof data[key], 'string', `${locale}.${key} phai la string`);
      assert.ok(data[key].trim().length > 0, `${locale}.${key} khong duoc rong`);
    }
  }
});

test('routerLocalV116 keys: placeholders match en in every locale', () => {
  const en = loadLocale('en');
  for (const locale of LOCALE_NAMES) {
    if (locale === 'en') continue;
    const data = loadLocale(locale);
    for (const key of ROUTER_LOCAL_V116_KEYS) {
      assert.deepEqual(
        placeholders(data[key]),
        placeholders(en[key]),
        `${locale}.${key} placeholder khac en`,
      );
    }
  }
});

test('routerLocalV116 keys: no key duplicates the v115 namespace', () => {
  const en = loadLocale('en');
  for (const key of ROUTER_LOCAL_V116_KEYS) {
    assert.ok(!key.startsWith('routerLocal.'), `${key} dung nham namespace v115`);
  }
  assert.ok('routerLocal.title' in en, 'key v115 van ton tai');
});

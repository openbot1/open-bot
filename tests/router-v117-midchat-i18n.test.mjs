/**
 * Test v1.40: i18n key moi — Doi T3 router local v117 (38 key
 * routerLocalV117.*) — du 6 locale, placeholder khop en, key da sort.
 *
 * Chi test thuan (doc JSON). Khong can build:
 *   node --test tests/router-v117-midchat-i18n.test.mjs
 *
 * NOTE: repo co 6 locale (vi, en, zh, ja, es, fr) — khong co ko.json;
 * key moi duoc them vao ca 6 locale hien co. Tong so key moi locale
 * sau v1.40 (chi tinh song nay) = 8322 + 38 = 8360 (cong ca key cac
 * doi khac cung song). Pin toan cuc song trong tests/i18n-v106.test.mjs
 * (coordinator cap nhat luc gop); file nay khong pin so tuyet doi ma
 * chi assert bang-nhau-6-locale + >= baseline cua song nay.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const localesDir = join(here, '..', 'apps/desktop/src/renderer/i18n/locales');
const LOCALE_NAMES = ['en', 'vi', 'es', 'fr', 'ja', 'zh'];

const ROUTER_V117_KEYS = [
  'routerLocalV117.annotate',
  'routerLocalV117.approved',
  'routerLocalV117.auditLog',
  'routerLocalV117.batch',
  'routerLocalV117.catalog',
  'routerLocalV117.confirm',
  'routerLocalV117.confirmAlways',
  'routerLocalV117.confirmNever',
  'routerLocalV117.confirmRisky',
  'routerLocalV117.confirmTitle',
  'routerLocalV117.costReport',
  'routerLocalV117.deescalate',
  'routerLocalV117.difficulty',
  'routerLocalV117.escalate',
  'routerLocalV117.expired',
  'routerLocalV117.gate',
  'routerLocalV117.inlineRisk',
  'routerLocalV117.midchatRoute',
  'routerLocalV117.midchatTitle',
  'routerLocalV117.override',
  'routerLocalV117.pending',
  'routerLocalV117.policy',
  'routerLocalV117.rejected',
  'routerLocalV117.risk',
  'routerLocalV117.riskHigh',
  'routerLocalV117.riskLow',
  'routerLocalV117.riskMedium',
  'routerLocalV117.riskScore',
  'routerLocalV117.riskUnknown',
  'routerLocalV117.savings',
  'routerLocalV117.session',
  'routerLocalV117.stay',
  'routerLocalV117.threshold',
  'routerLocalV117.toolOverride',
  'routerLocalV117.totalCost',
  'routerLocalV117.tree',
  'routerLocalV117.treeTitle',
  'routerLocalV117.waitingConfirmation',
];

function placeholders(text) {
  return [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
}

test('router v117 i18n: 38 key moi du 6 locale, placeholder khop en', () => {
  const locales = {};
  for (const name of LOCALE_NAMES) {
    locales[name] = JSON.parse(readFileSync(join(localesDir, `${name}.json`), 'utf8'));
  }
  assert.equal(ROUTER_V117_KEYS.length, 38);
  assert.deepEqual([...ROUTER_V117_KEYS].sort(), ROUTER_V117_KEYS);
  for (const key of ROUTER_V117_KEYS) {
    const enValue = locales.en[key];
    assert.ok(typeof enValue === 'string' && enValue.length > 0, `en thieu ${key}`);
    const enPlaceholders = placeholders(enValue);
    for (const name of LOCALE_NAMES) {
      const value = locales[name][key];
      assert.ok(typeof value === 'string' && value.length > 0, `${name} thieu ${key}`);
      assert.deepEqual(placeholders(value), enPlaceholders, `${name} placeholder lech ${key}`);
    }
  }
  // Placeholder cu the: difficulty {value}, riskScore {score}, totalCost {cost}.
  assert.deepEqual(placeholders(locales.en['routerLocalV117.difficulty']), ['value']);
  assert.deepEqual(placeholders(locales.en['routerLocalV117.riskScore']), ['score']);
  assert.deepEqual(placeholders(locales.en['routerLocalV117.totalCost']), ['cost']);
});

test('router v117 i18n: key da sort trong moi locale', () => {
  for (const name of LOCALE_NAMES) {
    const data = JSON.parse(readFileSync(join(localesDir, `${name}.json`), 'utf8'));
    const keys = Object.keys(data);
    assert.deepEqual(keys, [...keys].sort(), `${name} key chua sort`);
  }
});

test('router v117 i18n: tong key bang nhau 6 locale, >= baseline 8360', () => {
  const counts = {};
  for (const name of LOCALE_NAMES) {
    const data = JSON.parse(readFileSync(join(localesDir, `${name}.json`), 'utf8'));
    counts[name] = Object.keys(data).length;
  }
  const values = Object.values(counts);
  assert.ok(values.every((v) => v === values[0]), `tong key lech nhau: ${JSON.stringify(counts)}`);
  assert.ok(values[0] >= 8360, `tong key ${values[0]} < baseline 8360`);
});

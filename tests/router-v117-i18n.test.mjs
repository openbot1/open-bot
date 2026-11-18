/**
 * Test v1.17: i18n key moi — Doi T3 router v2 (30 key routerV2.* moi:
 * architect-*, repoMap-*, local-*) — du 6 locale, placeholder khop
 * en, key da sort.
 *
 * Chi test thuan (doc JSON). Khong can build:
 *   node --test tests/router-v117-i18n.test.mjs
 *
 * NOTE: repo co 6 locale (vi, en, zh, ja, es, fr) — khong co ko.json;
 * key moi duoc them vao ca 6 locale hien co. Tong so key moi locale
 * sau v1.16 = 5704 + 30 = 5734 (cong ca key cac doi khac cung song).
 * Pin toan cuc song trong tests/i18n-v106.test.mjs (coordinator cap
 * nhat luc gop); file nay khong pin so tuyet doi.
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
  'routerV2.architectBudgetExceeded',
  'routerV2.architectDifficulty',
  'routerV2.architectEditor',
  'routerV2.architectEscalated',
  'routerV2.architectFailed',
  'routerV2.architectPlan',
  'routerV2.architectPlanner',
  'routerV2.architectSingleModel',
  'routerV2.architectStep',
  'routerV2.architectStrongerEditor',
  'routerV2.architectTitle',
  'routerV2.repoMapBudget',
  'routerV2.repoMapIncluded',
  'routerV2.repoMapNoResults',
  'routerV2.repoMapOmitted',
  'routerV2.repoMapPartial',
  'routerV2.repoMapRank',
  'routerV2.repoMapTitle',
  'routerV2.localLmStudio',
  'routerV2.localModels',
  'routerV2.localNoModels',
  'routerV2.localNotChecked',
  'routerV2.localNotRunning',
  'routerV2.localOllama',
  'routerV2.localPickerHint',
  'routerV2.localPickerTitle',
  'routerV2.localRefresh',
  'routerV2.localRunning',
  'routerV2.localSourceDisabled',
  'routerV2.localViaAccount',
];

function placeholders(text) {
  return [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
}

test('router v117 i18n: 30 key moi du 6 locale, placeholder khop en', () => {
  const locales = {};
  for (const name of LOCALE_NAMES) {
    locales[name] = JSON.parse(readFileSync(join(localesDir, `${name}.json`), 'utf8'));
  }
  assert.equal(ROUTER_V117_KEYS.length, 30);
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
});

test('router v117 i18n: key da sort trong moi locale', () => {
  for (const name of LOCALE_NAMES) {
    const data = JSON.parse(readFileSync(join(localesDir, `${name}.json`), 'utf8'));
    const keys = Object.keys(data);
    assert.deepEqual(keys, [...keys].sort(), `${name} chua sort`);
  }
});

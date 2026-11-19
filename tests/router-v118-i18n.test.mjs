/**
 * Test i18n: 40 key router.v118.* moi — du 6 locale, placeholder khop
 * en, key da sort. (v1.41, Doi T3.)
 *
 * Chi test thuan (doc JSON). Khong can build:
 *   node --test tests/router-v118-i18n.test.mjs
 *
 * NOTE: chi test namespace router.v118.* cua doi minh; KHONG pin tong
 * so key toan cuc hay tong i18n (coordinator cap nhat luc gop).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const localesDir = join(here, '..', 'apps/desktop/src/renderer/i18n/locales');
const LOCALE_NAMES = ['en', 'vi', 'es', 'fr', 'ja', 'zh'];

const ROUTER_V118_KEYS = [
  'router.v118.botPolicyTitle',
  'router.v118.cacheKeyTitle',
  'router.v118.capabilityTitle',
  'router.v118.costQuality',
  'router.v118.costRouteChosen',
  'router.v118.costRouteTitle',
  'router.v118.costSaved',
  'router.v118.costSpent',
  'router.v118.downgradedToolChoice',
  'router.v118.droppedSamplingParams',
  'router.v118.fallbackToNormalTools',
  'router.v118.inlineToolsTitle',
  'router.v118.maxToolsExceeded',
  'router.v118.noExecutor',
  'router.v118.parallelCalls',
  'router.v118.policyDeniedTool',
  'router.v118.policyTitle',
  'router.v118.prefixCacheSurvived',
  'router.v118.programmaticTitle',
  'router.v118.requestParamsTitle',
  'router.v118.retryCooldown',
  'router.v118.retryPlanTitle',
  'router.v118.scriptAuditTitle',
  'router.v118.scriptBlocked',
  'router.v118.scriptCalls',
  'router.v118.scriptError',
  'router.v118.scriptFinished',
  'router.v118.scriptSteps',
  'router.v118.scriptTimeout',
  'router.v118.scriptValidated',
  'router.v118.threadCheckOk',
  'router.v118.threadFingerprintMismatch',
  'router.v118.threadLocked',
  'router.v118.toolChoiceTitle',
  'router.v118.toolCount',
  'router.v118.toolSetCreated',
  'router.v118.toolSetTitle',
  'router.v118.toolSetUpdated',
  'router.v118.toolSetVersion',
  'router.v118.unsupportedToolChoice',
];

function placeholders(text) {
  return [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
}

function loadLocale(name) {
  return JSON.parse(readFileSync(join(localesDir, `${name}.json`), 'utf8'));
}

test('router.v118: 40 key, du 6 locale, placeholder khop en', () => {
  assert.equal(ROUTER_V118_KEYS.length, 40);
  assert.deepEqual([...ROUTER_V118_KEYS].sort(), ROUTER_V118_KEYS, 'key list phai sort');
  const locales = Object.fromEntries(LOCALE_NAMES.map((name) => [name, loadLocale(name)]));
  for (const key of ROUTER_V118_KEYS) {
    for (const name of LOCALE_NAMES) {
      const value = locales[name][key];
      assert.equal(typeof value, 'string', `${key} thieu o locale ${name}`);
      assert.ok(value.trim().length > 0, `${key} rong o locale ${name}`);
      assert.deepEqual(
        placeholders(value),
        placeholders(locales.en[key]),
        `${key} placeholder lech o locale ${name}`,
      );
    }
  }
});

test('router.v118: key da sort trong file + so key 6 locale bang nhau', () => {
  const counts = new Set();
  for (const name of LOCALE_NAMES) {
    const data = loadLocale(name);
    const keys = Object.keys(data);
    assert.deepEqual(keys, [...keys].sort(), `locale ${name} chua sort`);
    counts.add(keys.length);
    for (const key of ROUTER_V118_KEYS) {
      assert.ok(key in data, `${key} thieu o ${name}`);
    }
  }
  assert.equal(counts.size, 1, 'so key 6 locale phai bang nhau');
});

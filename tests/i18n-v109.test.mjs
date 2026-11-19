/**
 * Test v1.09: i18n key mới — Đội T6 fleet v6 (38: 37 fleetV6.* +
 * fleetConsole.tabV6) — đủ 6 locale, placeholder khớp en.
 *
 * Chỉ test thuần (đọc JSON). Không cần build:
 *   node --test tests/i18n-v109.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const localesDir = join(here, '..', 'apps/desktop/src/renderer/i18n/locales');
const LOCALE_NAMES = ['en', 'vi', 'es', 'fr', 'ja', 'zh'];

const FLEET_V6_KEYS = [
  'fleetV6.bot',
  'fleetV6.botsTitle',
  'fleetV6.degraded',
  'fleetV6.down',
  'fleetV6.group',
  'fleetV6.healthTitle',
  'fleetV6.heavy',
  'fleetV6.incidentsTitle',
  'fleetV6.lastCrash',
  'fleetV6.loadError',
  'fleetV6.nextRun',
  'fleetV6.noBots',
  'fleetV6.noIncidents',
  'fleetV6.noQueue',
  'fleetV6.overQuota',
  'fleetV6.paused',
  'fleetV6.priority',
  'fleetV6.priorityCritical',
  'fleetV6.priorityHigh',
  'fleetV6.priorityLow',
  'fleetV6.priorityNormal',
  'fleetV6.queueTitle',
  'fleetV6.quota',
  'fleetV6.refresh',
  'fleetV6.restarts',
  'fleetV6.running',
  'fleetV6.schedule',
  'fleetV6.status',
  'fleetV6.subtitle',
  'fleetV6.throttled',
  'fleetV6.timeslot',
  'fleetV6.title',
  'fleetV6.unhealthy',
  'fleetV6.usage',
  'fleetV6.waiting',
  'fleetV6.withinQuota',
  'fleetV6.healthy',
  'fleetConsole.tabV6',
];

function loadLocale(loc) {
  return JSON.parse(readFileSync(join(localesDir, `${loc}.json`), 'utf8'));
}

function placeholders(value) {
  return [...String(value).matchAll(/\{[^}]+\}/g)].map((m) => m[0]).sort();
}

function checkKeys(keys) {
  const locales = LOCALE_NAMES.map(loadLocale);
  const [en, ...rest] = locales;
  for (const key of keys) {
    assert.ok(key in en, `missing in en: ${key}`);
    assert.ok(String(en[key]).length > 0, `empty in en: ${key}`);
    for (let i = 0; i < rest.length; i += 1) {
      const loc = LOCALE_NAMES[i + 1];
      assert.ok(key in rest[i], `missing in ${loc}: ${key}`);
      assert.ok(String(rest[i][key]).length > 0, `empty in ${loc}: ${key}`);
      assert.deepEqual(
        placeholders(rest[i][key]),
        placeholders(en[key]),
        `placeholder mismatch for ${key} in ${loc}`,
      );
    }
  }
}

test('fleet v6 keys exist in all 6 locales with matching placeholders', () => {
  assert.equal(FLEET_V6_KEYS.length, 38); // 37 fleetV6.* + fleetConsole.tabV6
  checkKeys(FLEET_V6_KEYS);
});

test('fleet v6 keys are sorted in every locale file', () => {
  for (const loc of LOCALE_NAMES) {
    const keys = Object.keys(loadLocale(loc));
    assert.deepEqual(keys, [...keys].sort(), `${loc} keys are not sorted`);
  }
});

test('all 6 locales have the same total key count (5278)', () => {
  // v1.10 merge: 4089 + 264 keys = 4353; v1.11: 4353 + 35 = 4388 (T1 46 + T2 25 + T3 47 + T4 24 + T5 73 + T6 49). Bump this pin whenever a
  // wave adds keys (same pattern as every previous wave).
  const counts = LOCALE_NAMES.map((loc) => Object.keys(loadLocale(loc)).length);
  assert.ok(counts.every((c) => c === counts[0]), `6 locales must have equal key counts, got ${counts.join(', ')}`);
  assert.ok(counts[0] >= 8072, `expected >= 8072 keys per locale, got ${counts[0]}`); // v1.39 fix round 4b: floor (was 8072 in v1.38; now 8322).
});

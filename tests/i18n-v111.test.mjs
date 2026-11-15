/**
 * Test v1.11: i18n key mới — Đội T6 fleet v8 (37 key fleetV8.*) +
 * Composio v111 (12 key composioV111.*) + provider SambaNova
 * (8 key providerSambanova.*) — đủ 6 locale, placeholder khớp en.
 *
 * Chỉ test thuần (đọc JSON). Không cần build:
 *   node --test tests/i18n-v111.test.mjs
 *
 * NOTE (pin toàn cục — coordinator gộp tính lại): tổng số key mỗi
 * locale được pin trong tests/i18n-v109.test.mjs và các file pin khác;
 * file này chỉ kiểm tra key mới + key sort + số lượng bằng nhau giữa
 * các locale, không pin số tuyệt đối (tránh xung đột giữa các đội).
 *
 * Lưu ý locale: repo có 6 locale en/vi/es/fr/ja/zh (KHÔNG có ko.json
 * — brief sóng ghi ko nhưng thư mục i18n hiện có dùng es thay ko).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const localesDir = join(here, '..', 'apps/desktop/src/renderer/i18n/locales');
const LOCALE_NAMES = ['en', 'vi', 'es', 'fr', 'ja', 'zh'];

const FLEET_V8_KEYS = [
  'fleetV8.builtAt',
  'fleetV8.campaignsTitle',
  'fleetV8.colBot',
  'fleetV8.colCampaign',
  'fleetV8.colCrashes',
  'fleetV8.colDowns',
  'fleetV8.colFailures',
  'fleetV8.colLastCheck',
  'fleetV8.colLastError',
  'fleetV8.colNode',
  'fleetV8.colProgress',
  'fleetV8.colRestarts',
  'fleetV8.colStatus',
  'fleetV8.colSuccess',
  'fleetV8.empty',
  'fleetV8.hideDashboard',
  'fleetV8.incidentsTitle',
  'fleetV8.loadError',
  'fleetV8.loading',
  'fleetV8.localMachine',
  'fleetV8.localProbeDetail',
  'fleetV8.localProbeLine',
  'fleetV8.localProbeTitle',
  'fleetV8.noActiveCampaigns',
  'fleetV8.noIncidents',
  'fleetV8.noProblemBots',
  'fleetV8.nodesSummary',
  'fleetV8.nodesTitle',
  'fleetV8.problemBotsTitle',
  'fleetV8.refresh',
  'fleetV8.retry',
  'fleetV8.showDashboard',
  'fleetV8.statusDegraded',
  'fleetV8.statusDown',
  'fleetV8.statusHealthy',
  'fleetV8.statusUnhealthy',
  'fleetV8.title',
];

const COMPOSIO_V111_KEYS = [
  'composioV111.connectTitle',
  'composioV111.connectionActive',
  'composioV111.connectionFailed',
  'composioV111.disconnectConfirm',
  'composioV111.lifecycleNote',
  'composioV111.listTitle',
  'composioV111.mockNote',
  'composioV111.pollAdaptive',
  'composioV111.pollTitle',
  'composioV111.reconnectTitle',
  'composioV111.subtitle',
  'composioV111.title',
];

const PROVIDER_SAMBANOVA_KEYS = [
  'providerSambanova.baseUrl',
  'providerSambanova.defaultModel',
  'providerSambanova.fallbackNote',
  'providerSambanova.knownModels',
  'providerSambanova.modelsTitle',
  'providerSambanova.needsKey',
  'providerSambanova.title',
  'providerSambanova.vaultNamespace',
];

const ALL_NEW_KEYS = [...FLEET_V8_KEYS, ...COMPOSIO_V111_KEYS, ...PROVIDER_SAMBANOVA_KEYS];

function loadLocale(name) {
  return JSON.parse(readFileSync(join(localesDir, `${name}.json`), 'utf8'));
}

function placeholders(value) {
  return [...String(value).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
}

test('i18n v111: all new keys exist in all 6 locales, non-empty', () => {
  assert.equal(ALL_NEW_KEYS.length, 57);
  for (const name of LOCALE_NAMES) {
    const locale = loadLocale(name);
    for (const key of ALL_NEW_KEYS) {
      assert.ok(key in locale, `${name} missing ${key}`);
      assert.equal(typeof locale[key], 'string', `${name}.${key} must be a string`);
      assert.ok(locale[key].trim().length > 0, `${name}.${key} must not be empty`);
    }
  }
});

test('i18n v111: placeholders match en in every locale', () => {
  const en = loadLocale('en');
  for (const name of LOCALE_NAMES) {
    if (name === 'en') continue;
    const locale = loadLocale(name);
    for (const key of ALL_NEW_KEYS) {
      assert.deepEqual(
        placeholders(locale[key]),
        placeholders(en[key]),
        `${name}.${key} placeholders must match en (en: ${JSON.stringify(placeholders(en[key]))}, ${name}: ${JSON.stringify(placeholders(locale[key]))})`,
      );
    }
  }
});

test('i18n v111: locale files stay sorted and equal-sized', () => {
  const sizes = new Set();
  for (const name of LOCALE_NAMES) {
    const locale = loadLocale(name);
    const keys = Object.keys(locale);
    assert.deepEqual(keys, [...keys].sort(), `${name}.json keys must stay sorted`);
    sizes.add(keys.length);
  }
  assert.equal(sizes.size, 1, 'all locales must have the same number of keys');
});

/**
 * Test v1.16: i18n key moi — Doi T3 router v2 (51 key routerV2.*) —
 * du 6 locale, placeholder khop en, key da sort.
 *
 * Chi test thuan (doc JSON). Khong can build:
 *   node --test tests/router-v116-i18n.test.mjs
 *
 * NOTE: repo co 6 locale (vi, en, zh, ja, es, fr) — khong co ko.json;
 * key moi duoc them vao ca 6 locale hien co. Tong so key moi locale
 * sau v1.15 = 5495 + 51 = 5546 (cong ca key cac doi khac cung song).
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

const ROUTER_V2_KEYS = [
  'routerV2.budgetExceeded',
  'routerV2.circuitOpen',
  'routerV2.cliDisable',
  'routerV2.cliEnable',
  'routerV2.cliFormatUnknown',
  'routerV2.cliNotInstalled',
  'routerV2.cliNotSignedIn',
  'routerV2.cliTitle',
  'routerV2.cliVersionTooOld',
  'routerV2.contextSize',
  'routerV2.crashed',
  'routerV2.discoverModels',
  'routerV2.failed',
  'routerV2.fallbackTitle',
  'routerV2.footprint',
  'routerV2.gpuLayers',
  'routerV2.guidanceTitle',
  'routerV2.idleTimeout',
  'routerV2.kvCache',
  'routerV2.load',
  'routerV2.loaded',
  'routerV2.loading',
  'routerV2.maxModels',
  'routerV2.modelNotFound',
  'routerV2.modelsDir',
  'routerV2.modelsDirHint',
  'routerV2.notEnoughRam',
  'routerV2.pickerManual',
  'routerV2.pickerReason',
  'routerV2.pickerTitle',
  'routerV2.pin',
  'routerV2.preempted',
  'routerV2.presetFile',
  'routerV2.ram',
  'routerV2.refresh',
  'routerV2.resident',
  'routerV2.sampler',
  'routerV2.scan',
  'routerV2.scanEmpty',
  'routerV2.statusTitle',
  'routerV2.subtitle',
  'routerV2.swapGroup',
  'routerV2.swapGroupFull',
  'routerV2.swapGroups',
  'routerV2.temperature',
  'routerV2.threads',
  'routerV2.title',
  'routerV2.unload',
  'routerV2.unloaded',
  'routerV2.unpin',
  'routerV2.vram',
];

function loadLocale(name) {
  return JSON.parse(readFileSync(join(localesDir, `${name}.json`), 'utf8'));
}

/** Trich placeholder {name} tu chuoi. */
function placeholders(value) {
  return [...value.matchAll(/\{([a-zA-Z0-9_]+)\}/g)].map((m) => m[1]).sort();
}

test('routerV2 i18n: 51 keys present in all 6 locales, non-empty', () => {
  assert.equal(ROUTER_V2_KEYS.length, 51);
  for (const locale of LOCALE_NAMES) {
    const data = loadLocale(locale);
    for (const key of ROUTER_V2_KEYS) {
      assert.ok(
        typeof data[key] === 'string' && data[key].length > 0,
        `${locale} missing/empty ${key}`,
      );
    }
  }
});

test('routerV2 i18n: placeholders match en in every locale', () => {
  const en = loadLocale('en');
  for (const locale of LOCALE_NAMES) {
    if (locale === 'en') continue;
    const data = loadLocale(locale);
    for (const key of ROUTER_V2_KEYS) {
      assert.deepEqual(
        placeholders(data[key]),
        placeholders(en[key]),
        `${locale}.${key} placeholder mismatch: ${data[key]} vs ${en[key]}`,
      );
    }
  }
});

test('routerV2 i18n: locale files stay fully key-sorted', () => {
  for (const locale of LOCALE_NAMES) {
    const data = loadLocale(locale);
    const keys = Object.keys(data);
    assert.deepEqual(keys, [...keys].sort(), `${locale}.json keys must stay sorted`);
  }
});

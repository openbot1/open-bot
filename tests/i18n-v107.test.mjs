/**
 * Test v1.07 (Đội T5): i18n key mới cho voice v6 + budget meter +
 * Paper theme — đủ 6 locale, placeholder khớp en.
 *
 * Chỉ test thuần (đọc JSON). Không cần build:
 *   node --test tests/i18n-v107.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const localesDir = join(here, '..', 'apps/desktop/src/renderer/i18n/locales');

const V107_KEYS = [
  'voice.realtime.v6.stateIdle',
  'voice.realtime.v6.stateConnecting',
  'voice.realtime.v6.stateListening',
  'voice.realtime.v6.stateSpeaking',
  'voice.realtime.v6.stateInterrupted',
  'voice.realtime.v6.stateReconnecting',
  'voice.realtime.v6.stateDegraded',
  'voice.realtime.v6.stateEnded',
  'voice.v6.currentVoice',
  'voice.v6.voiceLabel',
  'voice.v6.networkDegraded',
  'budget.meter.input',
  'budget.meter.output',
  'budget.meter.free',
  'budget.meter.over',
  'budget.meter.remaining',
  'budget.meter.levelWatch',
  'budget.meter.levelCritical',
  'budget.meter.byModel',
  'budget.meter.noCap',
  'settings.themePaper',
];

function loadLocale(loc) {
  return JSON.parse(readFileSync(join(localesDir, `${loc}.json`), 'utf8'));
}

function placeholders(value) {
  return [...String(value).matchAll(/\{[^}]+\}/g)].map((m) => m[0]).sort();
}

test('voice v6 + budget meter + paper keys exist in all 6 locales with matching placeholders', () => {
  const locales = ['en', 'vi', 'es', 'fr', 'ja', 'zh'].map(loadLocale);
  const [en, ...rest] = locales;
  assert.equal(Object.keys(en).length, 4565); // v1.10 merge: 4089 + 264 = 4353; v1.11: 4353 + 212 v1.11 = 4565
  for (const key of V107_KEYS) {
    assert.ok(key in en, `missing in en: ${key}`);
    assert.ok(String(en[key]).length > 0, `empty in en: ${key}`);
    for (let i = 0; i < rest.length; i += 1) {
      const loc = ['vi', 'es', 'fr', 'ja', 'zh'][i];
      assert.ok(key in rest[i], `missing in ${loc}: ${key}`);
      assert.ok(String(rest[i][key]).length > 0, `empty in ${loc}: ${key}`);
      assert.deepEqual(
        placeholders(rest[i][key]),
        placeholders(en[key]),
        `placeholder mismatch for ${key} in ${loc}`,
      );
    }
  }
});

test('settings.themeHint mentions Paper in all 6 locales', () => {
  const locales = ['en', 'vi', 'es', 'fr', 'ja', 'zh'].map(loadLocale);
  for (let i = 0; i < locales.length; i += 1) {
    const hint = String(locales[i]['settings.themeHint']);
    assert.ok(hint.length > 0, `empty themeHint in locale ${i}`);
  }
  assert.match(locales[0]['settings.themeHint'], /Paper/);
  assert.match(locales[1]['settings.themeHint'], /Giấy/);
});

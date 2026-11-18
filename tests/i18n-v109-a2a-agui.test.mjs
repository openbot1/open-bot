/**
 * Test v1.09 (Đội T4): i18n key mới A2A v1.1 + AG-UI streaming — đủ 6 locale,
 * placeholder khớp en.
 *
 * Chỉ test thuần (đọc JSON). Không cần build:
 *   node --test tests/i18n-v109-a2a-agui.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const localesDir = join(here, '..', 'apps/desktop/src/renderer/i18n/locales');
const LOCALE_NAMES = ['en', 'vi', 'es', 'fr', 'ja', 'zh'];

const V109_KEYS = [
  'a2a.v11.title',
  'a2a.v11.cardValid',
  'a2a.v11.cardExpired',
  'a2a.v11.cardUnsigned',
  'a2a.v11.keyChanged',
  'a2a.v11.keyFirstSeen',
  'a2a.v11.keyRotation',
  'a2a.v11.negotiatedVersion',
  'a2a.v11.features',
  'a2a.v11.requireSigned',
  'a2a.v11.minVersion',
  'a2a.v11.tenantCard',
  'agui.stream.title',
  'agui.stream.live',
  'agui.stream.paused',
  'agui.stream.stalled',
  'agui.stream.resuming',
  'agui.stream.finished',
  'agui.stream.gapDetected',
  'agui.stream.resume',
  'agui.stream.replaying',
  'agui.stream.checkpointSaved',
  'agui.stream.missingEvents',
  'agui.stream.runFinished',
];

function loadLocale(name) {
  return JSON.parse(readFileSync(join(localesDir, `${name}.json`), 'utf-8'));
}

function placeholders(text) {
  return [...text.matchAll(/\{([A-Za-z0-9_]+)\}/g)].map((m) => m[1]).sort();
}

test('i18n v1.09: 24 key mới có đủ 6 locale, không rỗng', () => {
  const locales = Object.fromEntries(LOCALE_NAMES.map((name) => [name, loadLocale(name)]));
  for (const key of V109_KEYS) {
    for (const name of LOCALE_NAMES) {
      const value = locales[name][key];
      assert.equal(typeof value, 'string', `${key} thiếu ở locale ${name}`);
      assert.ok(value.trim().length > 0, `${key} rỗng ở locale ${name}`);
    }
  }
  // Mỗi locale có đúng 3915 key (3891 v1.08 + 24 v1.09 T4).
  for (const name of LOCALE_NAMES) {
    assert.equal(Object.keys(locales[name]).length, 7540, `locale ${name} có ${Object.keys(locales[name]).length} key, kỳ vọng 7540`); // v1.36 re-pin: 7540.
  }
});

test('i18n v1.09: placeholder khớp en ở mọi locale', () => {
  const locales = Object.fromEntries(LOCALE_NAMES.map((name) => [name, loadLocale(name)]));
  for (const key of V109_KEYS) {
    const expected = placeholders(locales['en'][key]);
    for (const name of LOCALE_NAMES.slice(1)) {
      assert.deepEqual(
        placeholders(locales[name][key]),
        expected,
        `${key} placeholder khác en ở locale ${name}`,
      );
    }
  }
});

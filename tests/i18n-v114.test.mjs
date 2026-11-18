/**
 * Test v1.14 (Đội T3): i18n key mới cho coding agent v6 (39 key
 * codingV6.*) — đủ 6 locale, không rỗng, placeholder khớp en.
 *
 * Chỉ test thuần (đọc JSON). Không cần build:
 *   node --test tests/i18n-v114.test.mjs
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

const CODING_V6_KEYS = [
  'codingV6.approvalApproved',
  'codingV6.approvalDenied',
  'codingV6.approvalNeeded',
  'codingV6.askUser',
  'codingV6.blocked',
  'codingV6.changeStrategy',
  'codingV6.condense',
  'codingV6.condensed',
  'codingV6.decisions',
  'codingV6.delegate',
  'codingV6.errorsEncountered',
  'codingV6.escapeCondense',
  'codingV6.filesChanged',
  'codingV6.finish',
  'codingV6.fork',
  'codingV6.intro',
  'codingV6.noProgress',
  'codingV6.openQuestions',
  'codingV6.paused',
  'codingV6.repeatAction',
  'codingV6.repeatError',
  'codingV6.replay',
  'codingV6.riskHigh',
  'codingV6.riskLow',
  'codingV6.riskMedium',
  'codingV6.riskUnknown',
  'codingV6.routerLight',
  'codingV6.routerStandard',
  'codingV6.routerStrong',
  'codingV6.runText',
  'codingV6.sameFileEdit',
  'codingV6.security',
  'codingV6.start',
  'codingV6.stop',
  'codingV6.stuck',
  'codingV6.stuckTitle',
  'codingV6.testFailLoop',
  'codingV6.timeTravel',
  'codingV6.title',
];

function loadLocale(loc) {
  return JSON.parse(readFileSync(join(localesDir, `${loc}.json`), 'utf8'));
}

function placeholders(value) {
  return [...String(value).matchAll(/\{[^}]+\}/g)].map((m) => m[0]).sort();
}

test('coding v6 keys exist in all 6 locales with matching placeholders', () => {
  assert.equal(CODING_V6_KEYS.length, 39);
  const locales = LOCALE_NAMES.map(loadLocale);
  const [en, ...rest] = locales;
  for (const key of CODING_V6_KEYS) {
    assert.ok(key in en, `missing in en: ${key}`);
    assert.ok(String(en[key]).length > 0, `empty in en: ${key}`);
    for (let i = 0; i < rest.length; i += 1) {
      const loc = LOCALE_NAMES[i + 1];
      assert.ok(key in rest[i], `missing in ${loc}: ${key}`);
      assert.ok(String(rest[i][key]).length > 0, `empty in ${loc}: ${key}`);
      assert.deepEqual(
        placeholders(rest[i][key]),
        placeholders(en[key]),
        `placeholder mismatch in ${loc} for ${key}`,
      );
    }
  }
  for (const loc of locales) {
    assert.equal(Object.keys(loc).length, 7540); // v1.36 re-pin: 7540.
    assert.deepEqual(Object.keys(loc), [...Object.keys(loc)].sort());
  }
});

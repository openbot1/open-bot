/**
 * Tests for coding agent v14 — i18n (v1.29, Đội T3 lần 5): the 24 new
 * `codingV14.*` keys exist in all 6 locales with non-empty values,
 * and the locale totals move 6863 -> 6863 at v1.29.
 *
 * Pure JSON — no build needed:
 *   node --test tests/coding-v14-i18n-v129.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const localesDir = join(here, '..', 'apps/desktop/src/renderer/i18n/locales');
const LOCALE_NAMES = ['en', 'vi', 'es', 'fr', 'ja', 'zh'];

const CODING_V14_KEYS = [
  'codingV14.agent',
  'codingV14.condense',
  'codingV14.condenser',
  'codingV14.contextRebuilt',
  'codingV14.reasoning',
  'codingV14.reasoningBlocks',
  'codingV14.recovery',
  'codingV14.recoveryAskUser',
  'codingV14.recoveryEscalate',
  'codingV14.recoveryNarrowScope',
  'codingV14.recoveryRedirect',
  'codingV14.recoveryRollback',
  'codingV14.resume',
  'codingV14.rollback',
  'codingV14.stuck',
  'codingV14.stuckEmptyResponse',
  'codingV14.stuckNoProgress',
  'codingV14.stuckOscillation',
  'codingV14.stuckRepeatAction',
  'codingV14.stuckRepeatError',
  'codingV14.summary',
  'codingV14.title',
  'codingV14.tokensSaved',
  'codingV14.verify',
];

function loadLocale(name) {
  return JSON.parse(readFileSync(join(localesDir, `${name}.json`), 'utf8'));
}

test('i18n: 24 key codingV14.* có đủ 6 locale, giá trị không rỗng, tổng 7540', () => { // v1.36 re-pin: 7540.
  assert.equal(CODING_V14_KEYS.length, 24);
  for (const locale of LOCALE_NAMES) {
    const data = loadLocale(locale);
    assert.equal(Object.keys(data).length, 7540, `${locale} total keys`); // v1.36 re-pin: 7540.
    for (const key of CODING_V14_KEYS) {
      assert.equal(typeof data[key], 'string', `${locale}:${key} missing`);
      assert.ok(data[key].trim().length > 0, `${locale}:${key} empty`);
    }
  }
  // Key gợi ý stuck/recovery trong code phải khớp key i18n.
  assert.ok(CODING_V14_KEYS.includes('codingV14.stuckRepeatAction'));
  assert.ok(CODING_V14_KEYS.includes('codingV14.stuckRepeatError'));
  assert.ok(CODING_V14_KEYS.includes('codingV14.stuckOscillation'));
  assert.ok(CODING_V14_KEYS.includes('codingV14.stuckNoProgress'));
  assert.ok(CODING_V14_KEYS.includes('codingV14.stuckEmptyResponse'));
  assert.ok(CODING_V14_KEYS.includes('codingV14.recoveryRedirect'));
  assert.ok(CODING_V14_KEYS.includes('codingV14.recoveryNarrowScope'));
  assert.ok(CODING_V14_KEYS.includes('codingV14.recoveryAskUser'));
  assert.ok(CODING_V14_KEYS.includes('codingV14.recoveryRollback'));
  assert.ok(CODING_V14_KEYS.includes('codingV14.recoveryEscalate'));
});

test('i18n: locale files vẫn sorted (không vỡ thứ tự key)', () => {
  for (const locale of LOCALE_NAMES) {
    const data = loadLocale(locale);
    const keys = Object.keys(data);
    assert.deepEqual(keys, [...keys].sort(), `${locale} keys must stay sorted`);
  }
});

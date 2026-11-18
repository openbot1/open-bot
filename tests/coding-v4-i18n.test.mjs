/**
 * Tests for coding agent v4 — i18n (v1.11, Doi T4): the 31 new
 * `codingV4.*` keys exist in all 6 locales with matching
 * {placeholders}, the locale totals move 4353 -> 4384, and the new
 * renderer component has no hard-coded Vietnamese and only uses
 * keys that exist.
 *
 * Pure JSON + source scan — no build needed:
 *   node --test tests/coding-v4-i18n.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const localesDir = join(here, '..', 'apps/desktop/src/renderer/i18n/locales');
const LOCALE_NAMES = ['en', 'vi', 'es', 'fr', 'ja', 'zh'];

const CODING_V4_KEYS = [
  'codingV4.title',
  'codingV4.subagentTree',
  'codingV4.emptyTree',
  'codingV4.nodes',
  'codingV4.overallProgress',
  'codingV4.running',
  'codingV4.done',
  'codingV4.failed',
  'codingV4.pending',
  'codingV4.cancelled',
  'codingV4.progress',
  'codingV4.log',
  'codingV4.noLog',
  'codingV4.detail',
  'codingV4.model',
  'codingV4.tokens',
  'codingV4.showDetail',
  'codingV4.hideDetail',
  'codingV4.modelSwitch',
  'codingV4.currentModel',
  'codingV4.previousModel',
  'codingV4.switchCount',
  'codingV4.lastSwitch',
  'codingV4.switchReason',
  'codingV4.profile',
  'codingV4.profiles',
  'codingV4.applyProfile',
  'codingV4.repoMap',
  'codingV4.topFiles',
  'codingV4.scoreBreakdown',
  'codingV4.staleFiles',
];

function loadLocale(code) {
  return JSON.parse(readFileSync(join(localesDir, `${code}.json`), 'utf-8'));
}

const placeholders = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

test('coding v4 keys exist in all 6 locales with matching placeholders', () => {
  const locales = LOCALE_NAMES.map(loadLocale);
  const en = locales[0];
  assert.equal(CODING_V4_KEYS.length, 31);
  for (const key of CODING_V4_KEYS) {
    assert.ok(typeof en[key] === 'string' && en[key].length > 0, `missing en ${key}`);
    for (let i = 1; i < locales.length; i += 1) {
      const loc = locales[i];
      assert.ok(typeof loc[key] === 'string' && loc[key].length > 0, `missing ${LOCALE_NAMES[i]} ${key}`);
      assert.deepEqual(placeholders(loc[key]), placeholders(en[key]), `placeholder mismatch ${LOCALE_NAMES[i]} ${key}`);
    }
  }
});

test('locale totals move 4983 -> 5278 in all 6 locales', () => {
  // v1.11 (Doi T4): 4353 + 31 coding v4 keys = 4384. The coordinator
  // re-pins this number when merging the other v1.11 teams.
  const counts = LOCALE_NAMES.map((code) => Object.keys(loadLocale(code)).length);
  assert.deepEqual(counts, [7540, 7540, 7540, 7540, 7540, 7540]); // v1.36 re-pin: 7540.
});

test('renderer: CodingV4SubagentTree has no hard-coded Vietnamese and uses existing keys', () => {
  const src = readFileSync(
    join(here, '..', 'apps/desktop/src/renderer/components/CodingV4SubagentTree.tsx'),
    'utf-8',
  );
  const vietnamese = /[àáảãạăắằẳẵặâấầẩẫậèéẻẽẹêếềểễệìíỉĩịòóỏõọôốồổỗộơớờởỡợùúủũụưứừửữựỳýỷỹỵđÀÁẢÃẠĂẮẰẲẴẶÂẤẦẨẪẬÈÉẺẼẸÊẾỀỂỄỆÌÍỈĨỊÒÓỎÕỌÔỐỒỔỖỘƠỚỜỞỠỢÙÚỦŨỤƯỨỪỬỮỰỲÝỶỸỴĐ]/;
  assert.ok(!vietnamese.test(src), 'CodingV4SubagentTree.tsx must not contain Vietnamese (i18n lives in vi.json)');
  const used = [...src.matchAll(/t\('([a-zA-Z0-9_.]+)'/g)].map((m) => m[1]);
  // Dynamic keys t(`codingV4.${status}`) resolve to the 5 status keys.
  const dynamic = ['codingV4.pending', 'codingV4.running', 'codingV4.done', 'codingV4.failed', 'codingV4.cancelled'];
  const en = loadLocale('en');
  assert.ok(used.length > 0);
  for (const key of used) {
    assert.ok(typeof en[key] === 'string', `renderer uses missing i18n key ${key}`);
  }
  for (const key of dynamic) {
    assert.ok(typeof en[key] === 'string', `dynamic i18n key ${key} must exist`);
  }
  assert.ok(src.includes('CodingV4ModelSwitchBanner'), 'model-switch banner must be exported');
  assert.ok(!src.includes('dangerouslySetInnerHTML'), 'no unsafe rendering primitive');
});

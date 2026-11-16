/**
 * Tests for coding agent v5 — i18n (v1.13, Doi T4): the 18 new
 * `codingV5.*` keys exist in all 6 locales (vi, en, zh, ja, es, fr)
 * with matching {placeholders}, and the locale totals move
 * 4818 -> 4983 (v1.13 merge: +165 key).
 *
 * Pure JSON — no build needed:
 *   node --test tests/coding-v5-i18n.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const localesDir = join(here, '..', 'apps/desktop/src/renderer/i18n/locales');
const LOCALE_NAMES = ['en', 'vi', 'es', 'fr', 'ja', 'zh'];

const CODING_V5_KEYS = [
  'codingV5.title',
  'codingV5.patchPreview',
  'codingV5.approveHunk',
  'codingV5.rejectHunk',
  'codingV5.approveAll',
  'codingV5.applyPatch',
  'codingV5.commitMessage',
  'codingV5.addFiles',
  'codingV5.dropFiles',
  'codingV5.workingSet',
  'codingV5.suggestFiles',
  'codingV5.evalRun',
  'codingV5.evalSuite',
  'codingV5.rollback',
  'codingV5.patchHistory',
  'codingV5.noPatch',
  'codingV5.overBudget',
  'codingV5.hunksApproved',
];

function loadLocale(name) {
  return JSON.parse(readFileSync(join(localesDir, `${name}.json`), 'utf8'));
}

function placeholders(value) {
  return [...value.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
}

test('all 6 locales have the 18 codingV5 keys (4818 -> 4983 at v1.13, 5278 with v1.14)', () => {
  for (const name of LOCALE_NAMES) {
    const locale = loadLocale(name);
    assert.equal(Object.keys(locale).length, 5704, `${name}: expected 5704 keys`); // v1.14 merge re-pin.
    for (const key of CODING_V5_KEYS) {
      assert.equal(typeof locale[key], 'string', `${name}: missing ${key}`);
      assert.ok(locale[key].trim() !== '', `${name}: empty ${key}`);
    }
  }
});

test('placeholders match across locales for codingV5 keys', () => {
  const base = loadLocale('vi');
  for (const name of LOCALE_NAMES) {
    if (name === 'vi') continue;
    const locale = loadLocale(name);
    for (const key of CODING_V5_KEYS) {
      assert.deepEqual(
        placeholders(locale[key]),
        placeholders(base[key]),
        `${name} ${key}: placeholders differ from vi`,
      );
    }
  }
  // Spot-check the placeholder keys themselves.
  assert.deepEqual(placeholders(base['codingV5.overBudget']), ['over']);
  assert.deepEqual(placeholders(base['codingV5.hunksApproved']), ['approved', 'total']);
});

test('codingV5 keys are non-empty and distinct from codingV4 keys', () => {
  const vi = loadLocale('vi');
  assert.notEqual(vi['codingV5.title'], vi['codingV4.title']);
  assert.match(vi['codingV5.title'], /v5/);
  assert.match(vi['codingV5.patchPreview'], /patch/i);
});

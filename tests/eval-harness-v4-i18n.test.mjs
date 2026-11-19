/**
 * i18n tests for Eval Harness v4 (v1.44, Đội T2).
 *
 * Covers: every `evalHarnessV4.*` key exists in all 6 locales
 * (en, vi, zh, ja, fr, es), with non-empty values and matching
 * {placeholders} vs en; no locale is missing a key (the global
 * i18n test enforces identical key sets across locales).
 *
 * Run:
 *   node --test tests/eval-harness-v4-i18n.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const localesDir = join(here, '..', 'apps/desktop/src/renderer/i18n/locales');

const LOCALES = ['en', 'vi', 'zh', 'ja', 'fr', 'es'];
const dicts = {};
for (const code of LOCALES) {
  dicts[code] = JSON.parse(readFileSync(join(localesDir, `${code}.json`), 'utf-8'));
}

export const EVAL_HARNESS_V4_I18N_KEYS = [
  'evalHarnessV4.configTitle',
  'evalHarnessV4.dashboard',
  'evalHarnessV4.flaky',
  'evalHarnessV4.gateBlocked',
  'evalHarnessV4.gatePassed',
  'evalHarnessV4.gateWarning',
  'evalHarnessV4.history',
  'evalHarnessV4.improvement',
  'evalHarnessV4.improving',
  'evalHarnessV4.lastRun',
  'evalHarnessV4.meanReward',
  'evalHarnessV4.noRegressions',
  'evalHarnessV4.noRuns',
  'evalHarnessV4.noTasks',
  'evalHarnessV4.passRate',
  'evalHarnessV4.regression',
  'evalHarnessV4.regressions',
  'evalHarnessV4.repeats',
  'evalHarnessV4.run',
  'evalHarnessV4.runEval',
  'evalHarnessV4.runs',
  'evalHarnessV4.selectTasks',
  'evalHarnessV4.stable',
  'evalHarnessV4.task',
  'evalHarnessV4.tasks',
  'evalHarnessV4.timeout',
  'evalHarnessV4.title',
  'evalHarnessV4.trend',
  'evalHarnessV4.viewDashboard',
  'evalHarnessV4.worsening',
];

const placeholders = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

test('evalHarnessV4 keys exist in all 6 locales, non-empty, placeholders match en', () => {
  for (const key of EVAL_HARNESS_V4_I18N_KEYS) {
    const enValue = dicts.en[key];
    assert.equal(typeof enValue, 'string', `en missing ${key}`);
    assert.ok(enValue.trim() !== '', `en empty ${key}`);
    for (const code of LOCALES) {
      const value = dicts[code][key];
      assert.equal(typeof value, 'string', `${code} missing ${key}`);
      assert.ok(value.trim() !== '', `${code} empty ${key}`);
      assert.deepEqual(placeholders(value), placeholders(enValue), `${code} placeholders differ for ${key}`);
    }
  }
});

test('evalHarnessV4 keys are distinct from older eval keys', () => {
  for (const key of EVAL_HARNESS_V4_I18N_KEYS) {
    assert.ok(!key.startsWith('evalHarness.v3.'), key);
    assert.ok(!key.startsWith('evalV111.'), key);
  }
  assert.equal(new Set(EVAL_HARNESS_V4_I18N_KEYS).size, EVAL_HARNESS_V4_I18N_KEYS.length);
});

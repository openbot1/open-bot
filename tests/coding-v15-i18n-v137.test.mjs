/**
 * Tests for coding agent v15 — i18n (v1.37, Đội T4): the 65 new
 * `codingV15.*` keys exist in all 6 locales with non-empty values,
 * key sets match across locales, and locale files stay sorted.
 *
 * Pure JSON — no build needed:
 *   node --test tests/coding-v15-i18n-v137.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const localesDir = join(here, '..', 'apps/desktop/src/renderer/i18n/locales');
const LOCALE_NAMES = ['en', 'vi', 'es', 'fr', 'ja', 'zh'];

const CODING_V15_KEYS = [
  'codingV15.agent',
  'codingV15.filesWritten',
  'codingV15.flaky',
  'codingV15.forecast',
  'codingV15.grade',
  'codingV15.prompt',
  'codingV15.toolErrors',
  'codingV15.verifyHistory',
  'codingV15.verifyTrend',
  'codingV15.eval',
  'codingV15.allTools',
  'codingV15.demo',
  'codingV15.noBudgetHistory',
  'codingV15.noPendingFeedback',
  'codingV15.noProfiles',
  'codingV15.panelTabBudget',
  'codingV15.panelTabHooks',
  'codingV15.panelTabProfiles',
  'codingV15.panelTabVerify',
  'codingV15.profileModel',
  'codingV15.runReport',
  'codingV15.selectProfile',
  'codingV15.applyProfile',
  'codingV15.budget',
  'codingV15.budgetCost',
  'codingV15.budgetHistory',
  'codingV15.budgetOverCap',
  'codingV15.budgetReport',
  'codingV15.budgetReportOnly',
  'codingV15.budgetTokens',
  'codingV15.budgetWarning100',
  'codingV15.budgetWarning80',
  'codingV15.createProfile',
  'codingV15.deleteProfile',
  'codingV15.editProfile',
  'codingV15.explorer',
  'codingV15.fixer',
  'codingV15.general',
  'codingV15.hooksDialog',
  'codingV15.hooksDialogConfirm',
  'codingV15.hooksDialogDismiss',
  'codingV15.hooksDialogEmpty',
  'codingV15.hooksDialogSnooze',
  'codingV15.hooksDialogTitle',
  'codingV15.listProfiles',
  'codingV15.planner',
  'codingV15.profile',
  'codingV15.profileClone',
  'codingV15.profileAcp',
  'codingV15.profileApply',
  'codingV15.profileCreate',
  'codingV15.profileDelete',
  'codingV15.profileUpdate',
  'codingV15.reviewer',
  'codingV15.summary',
  'codingV15.title',
  'codingV15.verify',
  'codingV15.verifyEmptyResponse',
  'codingV15.verifyFileConflict',
  'codingV15.verifyLargeDiff',
  'codingV15.verifyMalformedOutput',
  'codingV15.verifyMidRunTestFailure',
  'codingV15.verifyPermissionDenied',
  'codingV15.verifyTimeout',
  'codingV15.verifyToolError',
];

function loadLocale(name) {
  return JSON.parse(readFileSync(join(localesDir, `${name}.json`), 'utf8'));
}

test('i18n: 65 key codingV15.* có đủ 6 locale, giá trị không rỗng', () => {
  assert.equal(CODING_V15_KEYS.length, 65);
  for (const loc of LOCALE_NAMES) {
    const data = loadLocale(loc);
    const keys = Object.keys(data).filter((k) => k.startsWith('codingV15.'));
    assert.equal(keys.length, 65, `${loc}: có ${keys.length} key codingV15.*, cần 65`);
    for (const key of CODING_V15_KEYS) {
      assert.ok(key in data, `${loc} thiếu key ${key}`);
      assert.equal(typeof data[key], 'string', `${loc}.${key} không phải chuỗi`);
      assert.ok(data[key].trim().length > 0, `${loc}.${key} rỗng`);
    }
    // Locale file vẫn sort theo key.
    assert.deepEqual(Object.keys(data), [...Object.keys(data)].sort(), `${loc}.json không còn sort theo key`);
  }
});

test('i18n: key set codingV15.* khớp nhau giữa 6 locale, không rỗng giá trị ACP/budget', () => {
  const sets = LOCALE_NAMES.map((loc) => {
    const data = loadLocale(loc);
    return new Set(Object.keys(data).filter((k) => k.startsWith('codingV15.')));
  });
  for (let i = 1; i < sets.length; i += 1) {
    assert.deepEqual([...sets[i]].sort(), [...sets[0]].sort(), `key set ${LOCALE_NAMES[i]} khác ${LOCALE_NAMES[0]}`);
  }
  // Spot-check: mỗi locale đều có nhãn ACP + ghi chú report-only + 9 scenario verify.
  for (const loc of LOCALE_NAMES) {
    const data = loadLocale(loc);
    assert.ok(data['codingV15.profileAcp'].length > 0);
    assert.ok(data['codingV15.budgetReportOnly'].length > 0);
    for (const k of ['ToolError', 'Timeout', 'MalformedOutput', 'FileConflict', 'MidRunTestFailure', 'EmptyResponse', 'PermissionDenied', 'LargeDiff']) {
      assert.ok(data[`codingV15.verify${k}`].length > 0, `${loc} thiếu codingV15.verify${k}`);
    }
  }
});

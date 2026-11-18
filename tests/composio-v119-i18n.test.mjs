/**
 * Tests for Composio v119 — i18n (v1.19, Đội T4): the 36 new
 * `composioV119.*` keys exist in all 6 locales with non-empty values,
 * and the locale totals move 6195 -> 6863 at v1.20 merge.
 *
 * Pure JSON — no build needed:
 *   node --test tests/composio-v119-i18n.test.mjs
 *
 * NOTE for the merge coordinator: the v118 tools test pins the old
 * total (5966, already stale at merge/v118) — re-pinned to
 * 6436 at v1.19 merge (see tests/composio-v118-tools.test.mjs).
 * Other older tests pinning locale totals need the same re-pin if
 * the count moves again.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const localesDir = join(here, '..', 'apps/desktop/src/renderer/i18n/locales');
const LOCALE_NAMES = ['en', 'vi', 'es', 'fr', 'ja', 'zh'];

const COMPOSIO_V119_KEYS = [
  'composioV119.authNote',
  'composioV119.execute',
  'composioV119.lifecycleActive',
  'composioV119.lifecycleArchived',
  'composioV119.lifecycleDraft',
  'composioV119.lifecyclePaused',
  'composioV119.lifecycleStopped',
  'composioV119.listTitle',
  'composioV119.mockOnly',
  'composioV119.needsKey',
  'composioV119.oauthLastRefresh',
  'composioV119.oauthNeedsReconnect',
  'composioV119.oauthRefreshTitle',
  'composioV119.pollBatch',
  'composioV119.pollCursorRepeat',
  'composioV119.pollMode',
  'composioV119.pollRetries',
  'composioV119.pollTitle',
  'composioV119.prefsTitle',
  'composioV119.runFailed',
  'composioV119.runRunning',
  'composioV119.runSkipped',
  'composioV119.runStuck',
  'composioV119.runSuccess',
  'composioV119.runsTitle',
  'composioV119.subtitle',
  'composioV119.title',
  'composioV119.triggerRegister',
  'composioV119.triggersTitle',
  'composioV119.usageBlocked',
  'composioV119.usageOverQuota',
  'composioV119.usageTitle',
  'composioV119.webhookDeadLetters',
  'composioV119.webhookDiscard',
  'composioV119.webhookQueueTitle',
  'composioV119.webhookRequeue',
];

function loadLocale(name) {
  return JSON.parse(readFileSync(join(localesDir, `${name}.json`), 'utf8'));
}

test('v119 i18n: all 36 composioV119.* keys exist in all 6 locales, non-empty', () => {
  assert.equal(COMPOSIO_V119_KEYS.length, 36);
  for (const loc of LOCALE_NAMES) {
    const dict = loadLocale(loc);
    for (const key of COMPOSIO_V119_KEYS) {
      assert.equal(typeof dict[key], 'string', `${loc} missing ${key}`);
      assert.ok(dict[key].length > 0, `${loc} empty ${key}`);
    }
  }
});

test('v119 i18n: locale totals are 6863 in all 6 locales', () => {
  const counts = LOCALE_NAMES.map((loc) => Object.keys(loadLocale(loc)).length);
  assert.deepEqual(counts, [7540, 7540, 7540, 7540, 7540, 7540]); // v1.36 re-pin: 7540.
});

test('v119 i18n: locale files stay key-sorted (file convention)', () => {
  for (const loc of LOCALE_NAMES) {
    const keys = Object.keys(loadLocale(loc));
    const sorted = [...keys].sort();
    assert.deepEqual(keys, sorted, `${loc} keys must stay sorted`);
  }
});

/**
 * Composio v119 tests — toolkit prefs per-user (v1.19, Doi T4 —
 * node:test, no network, no key).
 *
 * Covers toolkitPrefsV119.ts:
 * - Pref / user-prefs validation (empty ids, reason cap, duplicate
 *   toolkit)
 * - Effective enablement: user default is enabled, machine-level
 *   disable wins over a user enable
 * - set (pure, sorted, reason trim/truncate, userId mismatch),
 *   bulk set (changed count, duplicate slugs), clear (back to
 *   default), list-enabled against a catalog (+ machine map),
 *   summary
 * - Audit entries, memory store + JSON file store (round-trip,
 *   audit on disk)
 *
 * Imports the BUILT core — build first:
 *   npm run build --workspace=@open-bot/core
 * then: node --test tests/composio-v119-toolkit-prefs.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  COMPOSIO_V119_MAX_REASON_CHARS,
  JsonFileComposioV119ToolkitPrefsStore,
  MemoryComposioV119ToolkitPrefsStore,
  clearComposioV119ToolkitPref,
  createComposioV119ToolkitPrefsAuditEntry,
  createComposioV119UserToolkitPrefs,
  effectiveComposioV119ToolkitEnabledForUser,
  isComposioV119ToolkitEnabledForUser,
  listComposioV119EnabledToolkitsForUser,
  setComposioV119ToolkitPref,
  setComposioV119ToolkitPrefsBulk,
  summarizeComposioV119UserToolkitPrefs,
  validateComposioV119ToolkitPref,
  validateComposioV119ToolkitPrefsAuditEntry,
  validateComposioV119UserToolkitPrefs,
} from '../packages/core/dist/composio/toolkitPrefsV119.js';

const NOW = 1780000000000; // 2026-05-28T20:26:40Z

test('v119 toolkit prefs: validation', () => {
  const pref = { toolkit: 'gmail', enabled: false, reason: 'not using', updatedAtMs: NOW };
  assert.deepEqual(validateComposioV119ToolkitPref(pref), pref);
  assert.throws(() => validateComposioV119ToolkitPref({ ...pref, toolkit: '' }), /toolkit must be a non-empty string/);
  assert.throws(() => validateComposioV119ToolkitPref({ ...pref, enabled: 'no' }), /enabled must be a boolean/);
  assert.throws(() => validateComposioV119ToolkitPref({ ...pref, reason: 'x'.repeat(201) }), /at most 200 chars/);
  assert.throws(() => validateComposioV119ToolkitPref({ ...pref, updatedAtMs: -1 }), /non-negative number/);
  const user = { userId: 'u1', toolkits: [pref] };
  assert.deepEqual(validateComposioV119UserToolkitPrefs(user), user);
  assert.throws(() => validateComposioV119UserToolkitPrefs({ userId: '', toolkits: [] }), /userId must be a non-empty string/);
  assert.throws(
    () => validateComposioV119UserToolkitPrefs({ userId: 'u1', toolkits: [pref, pref] }),
    /must not contain duplicate toolkit/,
  );
  assert.throws(() => createComposioV119UserToolkitPrefs(''), /userId must be a non-empty string/);
  assert.deepEqual(createComposioV119UserToolkitPrefs('u1'), { userId: 'u1', toolkits: [] });
  assert.equal(COMPOSIO_V119_MAX_REASON_CHARS, 200);
});

test('v119 toolkit prefs: user enablement defaults to enabled', () => {
  assert.equal(isComposioV119ToolkitEnabledForUser(undefined, 'gmail'), true);
  const prefs = createComposioV119UserToolkitPrefs('u1');
  assert.equal(isComposioV119ToolkitEnabledForUser(prefs, 'gmail'), true, 'unconfigured → enabled');
  const disabled = setComposioV119ToolkitPref(prefs, 'u1', 'gmail', false, 'not using', NOW);
  assert.equal(isComposioV119ToolkitEnabledForUser(disabled, 'gmail'), false);
  assert.equal(isComposioV119ToolkitEnabledForUser(disabled, 'slack'), true, 'other toolkits unaffected');
  assert.equal(prefs.toolkits.length, 0, 'set is pure (no mutation)');
});

test('v119 toolkit prefs: machine level wins over user level', () => {
  const prefs = setComposioV119ToolkitPref(undefined, 'u1', 'gmail', true, null, NOW);
  assert.equal(effectiveComposioV119ToolkitEnabledForUser(prefs, 'gmail', true), true);
  assert.equal(effectiveComposioV119ToolkitEnabledForUser(prefs, 'gmail', false), false, 'machine off → off for everyone');
  assert.equal(effectiveComposioV119ToolkitEnabledForUser(prefs, 'gmail', undefined), true, 'no machine opinion → user decides');
  assert.equal(effectiveComposioV119ToolkitEnabledForUser(undefined, 'gmail', false), false);
  assert.equal(effectiveComposioV119ToolkitEnabledForUser(undefined, 'gmail'), true);
  const off = setComposioV119ToolkitPref(undefined, 'u1', 'slack', false, null, NOW);
  assert.equal(effectiveComposioV119ToolkitEnabledForUser(off, 'slack', true), false, 'user off + machine on → off');
});

test('v119 toolkit prefs: set sorts, trims/truncates reason, checks userId', () => {
  let prefs = setComposioV119ToolkitPref(undefined, 'u1', 'slack', false, '  too noisy  ', NOW);
  prefs = setComposioV119ToolkitPref(prefs, 'u1', 'gmail', false, null, NOW);
  assert.deepEqual(prefs.toolkits.map((t) => t.toolkit), ['gmail', 'slack'], 'sorted by slug');
  assert.equal(prefs.toolkits.find((t) => t.toolkit === 'slack').reason, 'too noisy', 'reason is trimmed');
  assert.equal(prefs.toolkits.find((t) => t.toolkit === 'gmail').reason, null);
  // Re-setting the same toolkit replaces it (no duplicate).
  prefs = setComposioV119ToolkitPref(prefs, 'u1', 'gmail', true, 'back', NOW + 1);
  assert.equal(prefs.toolkits.length, 2);
  assert.equal(prefs.toolkits.find((t) => t.toolkit === 'gmail').enabled, true);
  // Long reason is truncated to 200 chars, not rejected.
  const long = setComposioV119ToolkitPref(undefined, 'u1', 'gmail', false, 'x'.repeat(500), NOW);
  assert.equal(long.toolkits[0].reason.length, 200);
  // Blank reason → null.
  const blank = setComposioV119ToolkitPref(undefined, 'u1', 'gmail', false, '   ', NOW);
  assert.equal(blank.toolkits[0].reason, null);
  assert.throws(() => setComposioV119ToolkitPref(prefs, 'u2', 'gmail', true, null, NOW), /userId does not match/);
  assert.throws(() => setComposioV119ToolkitPref(undefined, 'u1', '', true, null, NOW), /toolkit must be a non-empty string/);
});

test('v119 toolkit prefs: bulk set counts changes + dedupes slugs', () => {
  const { prefs, changed } = setComposioV119ToolkitPrefsBulk(undefined, 'u1', ['gmail', 'slack', 'gmail'], false, 'off', NOW);
  assert.equal(changed, 2, 'gmail counted once despite the duplicate input');
  assert.equal(prefs.toolkits.length, 2);
  assert.equal(isComposioV119ToolkitEnabledForUser(prefs, 'gmail'), false);
  // Setting the same value again changes nothing.
  const again = setComposioV119ToolkitPrefsBulk(prefs, 'u1', ['gmail', 'slack'], false, 'off', NOW);
  assert.equal(again.changed, 0);
  assert.equal(again.prefs.toolkits.length, 2);
  // Mixed: one already off, one on → 1 change.
  const mixed = setComposioV119ToolkitPrefsBulk(prefs, 'u1', ['gmail', 'notion'], true, 'on', NOW);
  assert.equal(mixed.changed, 1, 'only gmail flips');
  assert.equal(isComposioV119ToolkitEnabledForUser(mixed.prefs, 'gmail'), true);
  assert.equal(isComposioV119ToolkitEnabledForUser(mixed.prefs, 'notion'), true);
});

test('v119 toolkit prefs: clear returns to default + list-enabled + summary', () => {
  let prefs = setComposioV119ToolkitPref(undefined, 'u1', 'gmail', false, 'off', NOW);
  prefs = setComposioV119ToolkitPref(prefs, 'u1', 'slack', false, 'off', NOW);
  const { prefs: cleared, cleared: didClear } = clearComposioV119ToolkitPref(prefs, 'gmail');
  assert.equal(didClear, true);
  assert.equal(isComposioV119ToolkitEnabledForUser(cleared, 'gmail'), true, 'cleared → default enabled');
  assert.equal(cleared.toolkits.length, 1);
  assert.equal(clearComposioV119ToolkitPref(cleared, 'gmail').cleared, false);
  assert.equal(clearComposioV119ToolkitPref(cleared, 'notion').cleared, false);

  const catalog = ['gmail', 'slack', 'notion', 'github'];
  assert.deepEqual(listComposioV119EnabledToolkitsForUser(catalog, cleared), ['gmail', 'notion', 'github']);
  assert.deepEqual(listComposioV119EnabledToolkitsForUser(catalog, undefined), catalog);
  assert.deepEqual(
    listComposioV119EnabledToolkitsForUser(catalog, cleared, { github: false }),
    ['gmail', 'notion'],
    'machine map removes github too',
  );
  assert.deepEqual(listComposioV119EnabledToolkitsForUser(['unknown-toolkit'], cleared), ['unknown-toolkit'], 'catalog decides membership, not prefs');

  const summary = summarizeComposioV119UserToolkitPrefs(cleared, 4);
  assert.equal(summary.userId, 'u1');
  assert.equal(summary.configured, 1);
  assert.equal(summary.disabled, 1);
  assert.equal(summary.enabled, 3);
  assert.deepEqual(summary.disabledToolkits, ['slack']);
  assert.deepEqual(summarizeComposioV119UserToolkitPrefs(undefined, 4), {
    userId: '',
    configured: 0,
    enabled: 4,
    disabled: 0,
    disabledToolkits: [],
  });
});

test('v119 toolkit prefs: audit entries', () => {
  const entry = createComposioV119ToolkitPrefsAuditEntry('u1', 'gmail', null, false, 'off', NOW);
  assert.ok(entry.id.startsWith('tp119-'));
  assert.equal(entry.from, null, 'null = previously unconfigured (default enabled)');
  assert.equal(entry.to, false);
  assert.deepEqual(validateComposioV119ToolkitPrefsAuditEntry(entry), entry);
  // Blank reason falls back to enabled/disabled.
  assert.equal(createComposioV119ToolkitPrefsAuditEntry('u1', 'gmail', true, false, '   ', NOW).reason, 'disabled');
  assert.equal(createComposioV119ToolkitPrefsAuditEntry('u1', 'gmail', false, true, '', NOW).reason, 'enabled');
  assert.throws(() => validateComposioV119ToolkitPrefsAuditEntry({ ...entry, from: 'yes' }), /from must be a boolean or null/);
  assert.throws(() => validateComposioV119ToolkitPrefsAuditEntry({ ...entry, reason: '' }), /reason must be a non-empty string/);
});

test('v119 toolkit prefs: memory store CRUD + audit', () => {
  const store = new MemoryComposioV119ToolkitPrefsStore();
  assert.equal(store.get('u1'), undefined);
  const prefs = store.set('u1', 'gmail', false, 'off', NOW);
  assert.equal(prefs.toolkits.length, 1);
  assert.equal(store.get('u1').toolkits[0].enabled, false);
  const { prefs: afterBulk, changed } = store.setBulk('u1', ['slack', 'notion'], false, 'off', NOW);
  assert.equal(changed, 2);
  assert.equal(afterBulk.toolkits.length, 3);
  assert.equal(store.clearToolkit('u1', 'gmail'), true);
  assert.equal(store.clearToolkit('u1', 'gmail'), false);
  assert.equal(store.get('u1').toolkits.length, 2);
  assert.equal(store.clearToolkit('u2', 'gmail'), false);
  assert.deepEqual(store.listUsers(), ['u1']);
  store.set('u2', 'gmail', true, null, NOW);
  assert.deepEqual(store.listUsers(), ['u1', 'u2']);
  const audit = store.listAudit();
  assert.equal(audit.length, 4, '1 set + 2 bulk + 1 set(u2)');
  assert.equal(audit[0].userId, 'u2', 'newest first');
  assert.equal(audit[audit.length - 1].toolkit, 'gmail');
  assert.equal(audit[audit.length - 1].from, null);
  assert.equal(store.resetUser('u1'), true);
  assert.equal(store.get('u1'), undefined);
  assert.equal(store.resetUser('u1'), false);
  store.clear();
  assert.deepEqual(store.listUsers(), []);
  assert.equal(store.listAudit().length, 0);
});

test('v119 toolkit prefs: JSON file store persists + audit on disk', () => {
  const dir = mkdtempSync(join(tmpdir(), 'composio-v119-prefs-'));
  try {
    const store = new JsonFileComposioV119ToolkitPrefsStore(dir);
    store.set('u1', 'gmail', false, 'off', NOW);
    assert.ok(existsSync(join(dir, 'composio-toolkit-prefs-v119.json')));
    const store2 = new JsonFileComposioV119ToolkitPrefsStore(dir);
    assert.equal(store2.get('u1').toolkits[0].enabled, false);
    assert.equal(store2.get('u1').toolkits[0].reason, 'off');
    store2.setBulk('u1', ['slack'], true, null, NOW);
    assert.equal(new JsonFileComposioV119ToolkitPrefsStore(dir).get('u1').toolkits.length, 2);
    const audit = store2.listAudit();
    assert.equal(audit.length, 2);
    assert.equal(audit[0].toolkit, 'slack', 'newest first');
    assert.equal(store2.listAudit({ toolkit: 'gmail' }).length, 1);
    assert.equal(store2.listAudit({ userId: 'u2' }).length, 0);
    assert.equal(store2.listAudit({ limit: 1 }).length, 1);
    assert.equal(store2.resetUser('u1'), true);
    assert.equal(store2.get('u1'), undefined);
    store2.clear();
    assert.equal(existsSync(join(dir, 'composio-toolkit-prefs-v119.json')), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  assert.throws(() => new JsonFileComposioV119ToolkitPrefsStore(''), /non-empty string/);
});

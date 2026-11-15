/**
 * Composio v2 tests (v1.08, Đội T4 — node:test, mock fetchers only,
 * NO live Composio calls, NO real keys).
 *
 * Covers:
 *  - ToolkitStatusPoller: baseline is silent, later polls report status
 *    changes + account-label changes; errors back off without wiping
 *    last-known statuses; unknown toolkits ignored; change log capped
 *  - TriggerMappingStore: create/validate/duplicate-reject, update,
 *    remove, resolve (enabled only, notify template rendering,
 *    knownSlug flag), file persistence + corrupt-file tolerance,
 *    import/export with skip counting
 *  - ToolkitConnectionManager: enable/disable (+ unknown slug throws),
 *    applyStatuses, healthCheck single + all, summary + unhealthy list,
 *    reset, enabled-flag persistence
 *
 * Imports the BUILT core — build first:
 *   npm run build --workspace=@open-bot/core
 * then: node --test tests/composio-v108-toolkit.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  ComposioToolkitConnectionManager,
  ComposioToolkitStatusPoller,
  ComposioTriggerMappingStore,
  renderComposioTriggerTemplate,
} from '../packages/core/dist/composio/index.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-composio-v108-'));
}

// ---------------------------------------------------------------------------
// ToolkitStatusPoller
// ---------------------------------------------------------------------------

test('composio v108: status poller baseline is silent, later polls report changes', async () => {
  let round = 0;
  const fetcher = async () => {
    round += 1;
    if (round === 1) {
      return [
        { toolkit: 'gmail', status: 'active', accountLabel: 'a@example.com' },
        { toolkit: 'github', status: 'active', accountLabel: 'octocat' },
      ];
    }
    return [
      { toolkit: 'gmail', status: 'active', accountLabel: 'a@example.com' },
      { toolkit: 'github', status: 'none' },
    ];
  };
  const seen = [];
  const poller = new ComposioToolkitStatusPoller({
    fetchStatuses: fetcher,
    toolkits: ['gmail', 'github'],
    onChanges: (changes) => seen.push(...changes),
  });
  const first = await poller.pollNow();
  assert.equal(first.changes.length, 0, 'first poll is the baseline, no changes');
  assert.equal(first.checked, 2);
  assert.equal(seen.length, 0);
  const second = await poller.pollNow();
  assert.equal(second.changes.length, 1);
  assert.equal(second.changes[0].toolkit, 'github');
  assert.equal(second.changes[0].from, 'active');
  assert.equal(second.changes[0].to, 'none');
  assert.equal(seen.length, 1);
  const status = poller.getStatus();
  assert.equal(status.totalPolls, 2);
  assert.equal(status.totalChanges, 1);
  assert.equal(status.toolkits.find((t) => t.toolkit === 'github').status, 'none');
  assert.equal(status.toolkits.find((t) => t.toolkit === 'gmail').status, 'active');
  assert.equal(status.toolkits.find((t) => t.toolkit === 'gmail').accountLabel, 'a@example.com');
  assert.equal(poller.getChanges().length, 1);
  assert.equal(poller.getChanges()[0].toolkit, 'github');
});

test('composio v108: status poller reports account-label changes while status stays active', async () => {
  let round = 0;
  const fetcher = async () => {
    round += 1;
    return [{ toolkit: 'slack', status: 'active', accountLabel: round === 1 ? 'team-a' : 'team-b' }];
  };
  const poller = new ComposioToolkitStatusPoller({ fetchStatuses: fetcher, toolkits: ['slack'] });
  await poller.pollNow();
  const second = await poller.pollNow();
  assert.equal(second.changes.length, 1);
  assert.equal(second.changes[0].from, 'active');
  assert.equal(second.changes[0].to, 'active');
  assert.equal(second.changes[0].accountLabel, 'team-b');
  assert.equal(second.changes[0].previousAccountLabel, 'team-a');
});

test('composio v108: status poller errors back off, keep last-known statuses, then recover', async () => {
  let calls = 0;
  const fetcher = async () => {
    calls += 1;
    if (calls === 2) throw new Error('network down');
    return [{ toolkit: 'gmail', status: 'active' }];
  };
  const poller = new ComposioToolkitStatusPoller({
    fetchStatuses: fetcher,
    toolkits: ['gmail'],
    intervalMs: 60_000,
  });
  await poller.pollNow();
  const failed = await poller.pollNow();
  assert.equal(failed.error, 'network down');
  assert.equal(failed.changes.length, 0);
  assert.equal(poller.getStatus().consecutiveFailures, 1);
  assert.equal(poller.getStatus().toolkits[0].status, 'active', 'last-known status survives a failed poll');
  assert.ok(poller.getStatus().nextPollAtMs > 0, 'backoff scheduled a next poll');
  const recovered = await poller.pollNow();
  assert.equal(recovered.error, undefined);
  assert.equal(poller.getStatus().consecutiveFailures, 0);
  assert.equal(poller.getStatus().lastError, undefined);
});

test('composio v108: status poller ignores unknown toolkits + non-list fetch results', async () => {
  const poller = new ComposioToolkitStatusPoller({
    fetchStatuses: async () => [{ toolkit: 'not-a-toolkit', status: 'active' }],
    toolkits: ['gmail', 'not-a-toolkit'],
  });
  const result = await poller.pollNow();
  assert.equal(result.checked, 0);
  assert.deepEqual(poller.getStatus().watchedToolkits, ['gmail']);
  const bad = new ComposioToolkitStatusPoller({
    fetchStatuses: async () => 'nope',
    toolkits: ['gmail'],
  });
  const badResult = await bad.pollNow();
  assert.match(badResult.error, /did not return a list/);
  assert.throws(
    () => new ComposioToolkitStatusPoller({ fetchStatuses: 'nope' }),
    /needs a fetchStatuses function/,
  );
});

test('composio v108: status poller start/stop + setIntervalMs clamps + change log capped', async () => {
  const poller = new ComposioToolkitStatusPoller({
    fetchStatuses: async () => [{ toolkit: 'gmail', status: 'active' }],
    toolkits: ['gmail'],
    maxChanges: 1,
  });
  assert.equal(poller.isRunning(), false);
  poller.setIntervalMs(1);
  assert.equal(poller.getStatus().intervalMs, 60_000, 'clamped to the 1-minute minimum');
  poller.setIntervalMs(48 * 60 * 60 * 1000);
  assert.equal(poller.getStatus().intervalMs, 24 * 60 * 60 * 1000, 'clamped to the 24-hour maximum');
  poller.start();
  assert.equal(poller.isRunning(), true);
  poller.stop();
  assert.equal(poller.isRunning(), false);
});

// ---------------------------------------------------------------------------
// TriggerMappingStore
// ---------------------------------------------------------------------------

test('composio v108: trigger mapping create/validate/duplicate/update/remove', () => {
  const store = new ComposioTriggerMappingStore();
  const mapping = store.create({
    triggerSlug: 'GMAIL_NEW_GMAIL_MESSAGE',
    actionKind: 'automation',
    target: 'auto-123',
    description: 'New mail runs the triage automation',
  });
  assert.equal(mapping.triggerSlug, 'GMAIL_NEW_GMAIL_MESSAGE');
  assert.equal(mapping.enabled, true);
  assert.match(mapping.id, /^map_/);
  assert.equal(store.count(), 1);
  // Duplicate (same slug + kind + target) is rejected.
  assert.throws(
    () =>
      store.create({ triggerSlug: 'GMAIL_NEW_GMAIL_MESSAGE', actionKind: 'automation', target: 'auto-123' }),
    /already exists/,
  );
  // Same slug, different action is fine.
  const second = store.create({
    triggerSlug: 'GMAIL_NEW_GMAIL_MESSAGE',
    actionKind: 'notify',
    target: 'New mail from {sender}: {subject}',
  });
  assert.equal(store.count(), 2);
  // Invalid slugs / kinds / tool names are rejected.
  assert.throws(
    () => store.create({ triggerSlug: 'gmail_new', actionKind: 'tool', target: 'x' }),
    /triggerSlug .* is invalid/,
  );
  assert.throws(
    () => store.create({ triggerSlug: 'GITHUB_COMMIT_EVENT', actionKind: 'tool', target: 'Bad-Name' }),
    /not a valid internal tool name/,
  );
  assert.throws(
    () => store.create({ triggerSlug: 'GITHUB_COMMIT_EVENT', actionKind: 'dance', target: 'x' }),
    /actionKind must be/,
  );
  assert.throws(
    () => store.create({ triggerSlug: 'GITHUB_COMMIT_EVENT', actionKind: 'tool', target: '' }),
    /target must be a non-empty string/,
  );
  // Update: disable + retarget; duplicate via update is rejected too.
  const updated = store.update(mapping.id, { enabled: false, target: 'auto-999' });
  assert.equal(updated.enabled, false);
  assert.equal(updated.target, 'auto-999');
  assert.throws(
    () => store.update(second.id, { actionKind: 'automation', target: 'auto-999' }),
    /already exists/,
  );
  assert.throws(() => store.update('map_nope', { enabled: true }), /Unknown trigger mapping/);
  assert.equal(store.remove(mapping.id), true);
  assert.equal(store.remove(mapping.id), false);
  assert.equal(store.count(), 1);
});

test('composio v108: trigger mapping resolve only runs enabled mappings + renders notify templates', () => {
  const store = new ComposioTriggerMappingStore();
  store.create({
    triggerSlug: 'GMAIL_NEW_GMAIL_MESSAGE',
    actionKind: 'notify',
    target: 'New mail from {sender}: {subject} [{triggerSlug}]',
  });
  store.create({
    triggerSlug: 'GMAIL_NEW_GMAIL_MESSAGE',
    actionKind: 'tool',
    target: 'send_message',
    args: { channel: 'ops' },
    enabled: false,
  });
  store.create({
    triggerSlug: 'GMAIL_NEW_GMAIL_MESSAGE',
    actionKind: 'automation',
    target: 'auto-mail',
  });
  const resolved = store.resolve({
    triggerSlug: 'GMAIL_NEW_GMAIL_MESSAGE',
    data: { sender: 'boss@example.com', subject: 'Q4 plan' },
  });
  assert.equal(resolved.knownSlug, true, 'curated picker slug');
  assert.equal(resolved.actions.length, 2, 'disabled tool mapping does not resolve');
  assert.equal(resolved.actions[0].actionKind, 'notify');
  assert.equal(resolved.actions[0].text, 'New mail from boss@example.com: Q4 plan [GMAIL_NEW_GMAIL_MESSAGE]');
  assert.equal(resolved.actions[1].actionKind, 'automation');
  assert.equal(resolved.actions[1].target, 'auto-mail');
  // Unknown-but-valid slug still resolves, flagged as uncurated.
  store.create({ triggerSlug: 'SOME_NEW_TRIGGER_XYZ', actionKind: 'notify', target: 'fired {missing}' });
  const uncurated = store.resolve({ triggerSlug: 'SOME_NEW_TRIGGER_XYZ', data: {} });
  assert.equal(uncurated.knownSlug, false);
  assert.equal(uncurated.actions.length, 1);
  assert.equal(uncurated.actions[0].text, 'fired {missing}', 'unknown placeholders stay visible');
  // No mappings at all → empty actions, no throw.
  assert.deepEqual(store.resolve({ triggerSlug: 'SLACK_NEW_MESSAGE' }).actions, []);
  assert.equal(store.listEnabledFor('GMAIL_NEW_GMAIL_MESSAGE').length, 2);
});

test('composio v108: renderComposioTriggerTemplate fills nested keys + stringifies objects', () => {
  assert.equal(
    renderComposioTriggerTemplate('Hi {user.name}, {count} items', {
      triggerSlug: 'X',
      data: { user: { name: 'An' }, count: 3 },
    }),
    'Hi An, 3 items',
  );
  assert.equal(
    renderComposioTriggerTemplate('{payload}', { triggerSlug: 'X', data: { payload: { a: 1 } } }),
    '{"a":1}',
  );
});

test('composio v108: trigger mapping file persistence + corrupt file loads empty + import/export', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'mappings.json');
  const store = new ComposioTriggerMappingStore({ file });
  store.create({ triggerSlug: 'GITHUB_COMMIT_EVENT', actionKind: 'notify', target: 'Commit {sha}' });
  assert.ok(fs.existsSync(file));
  const reloaded = new ComposioTriggerMappingStore({ file });
  assert.equal(reloaded.count(), 1);
  assert.equal(reloaded.list()[0].triggerSlug, 'GITHUB_COMMIT_EVENT');
  // Corrupt file → empty store, no crash.
  fs.writeFileSync(file, '{not json', 'utf8');
  assert.equal(new ComposioTriggerMappingStore({ file }).count(), 0);
  // Export / import with skip counting (1 bad row + 1 duplicate skipped).
  const exported = store.exportMappings();
  assert.equal(exported.version, 1);
  const other = new ComposioTriggerMappingStore();
  const imported = other.importMappings({
    version: 1,
    mappings: [...exported.mappings, { triggerSlug: 'bad', actionKind: 'tool', target: 'x' }, exported.mappings[0]],
  });
  assert.deepEqual(imported, { imported: 1, skipped: 2 });
  assert.equal(other.count(), 1);
  assert.throws(() => other.importMappings({ nope: true }), /exported document/);
});

// ---------------------------------------------------------------------------
// ToolkitConnectionManager
// ---------------------------------------------------------------------------

test('composio v108: toolkit manager enable/disable + unknown slug throws', () => {
  const manager = new ComposioToolkitConnectionManager();
  assert.equal(manager.list().length > 10, true, 'catalog has many toolkits');
  assert.equal(manager.get('gmail').enabled, true);
  assert.equal(manager.get('gmail').status, 'none');
  assert.equal(manager.isEnabled('gmail'), true);
  manager.setEnabled('gmail', false);
  assert.equal(manager.isEnabled('gmail'), false);
  assert.equal(manager.listEnabled().some((s) => s.toolkit === 'gmail'), false);
  manager.setEnabled('gmail', true);
  assert.equal(manager.isEnabled('gmail'), true);
  assert.throws(() => manager.get('not-a-toolkit'), /Unknown Composio toolkit/);
  assert.throws(() => manager.setEnabled('not-a-toolkit', false), /Unknown Composio toolkit/);
  assert.throws(() => manager.reset('not-a-toolkit'), /Unknown Composio toolkit/);
});

test('composio v108: toolkit manager applyStatuses + summary + unhealthy list', () => {
  const manager = new ComposioToolkitConnectionManager();
  manager.setEnabled('slack', false);
  const applied = manager.applyStatuses([
    { toolkit: 'gmail', status: 'active', accountLabel: 'a@example.com' },
    { toolkit: 'github', status: 'initiated' },
    { toolkit: 'slack', status: 'active' },
    { toolkit: 'not-a-toolkit', status: 'active' },
  ]);
  assert.deepEqual(applied, { updated: 2, unknown: ['not-a-toolkit'] });
  assert.equal(manager.get('gmail').status, 'active');
  assert.equal(manager.get('gmail').accountLabel, 'a@example.com');
  assert.equal(manager.get('github').status, 'initiated');
  assert.equal(manager.get('slack').status, 'none', 'disabled toolkit keeps its old status');
  const summary = manager.summary();
  assert.equal(summary.enabled, summary.total - 1);
  assert.equal(summary.disabled, 1);
  assert.equal(summary.active, 1);
  assert.equal(summary.initiated, 1);
  assert.deepEqual(summary.unhealthy, ['github'], 'initiated counts as needing attention');
  assert.ok(summary.lastCheckedAtMs > 0);
});

test('composio v108: toolkit manager healthCheck single + all, failures recorded per toolkit', async () => {
  const manager = new ComposioToolkitConnectionManager();
  const ok = await manager.healthCheck('gmail', async () => ({
    toolkit: 'gmail',
    status: 'active',
    accountLabel: 'a@example.com',
  }));
  assert.equal(ok.status, 'active');
  assert.equal(ok.consecutiveFailures, 0);
  const failed = await manager.healthCheck('github', async () => {
    throw new Error('session expired');
  });
  assert.equal(failed.status, 'none', 'failed check keeps the old status');
  assert.equal(failed.lastError, 'session expired');
  assert.equal(failed.consecutiveFailures, 1);
  const mismatched = await manager.healthCheck('slack', async () => ({ toolkit: 'gmail', status: 'active' }));
  assert.match(mismatched.lastError, /mismatched result/);
  // healthCheckAll: one fetch failure marks no toolkit — it is a
  // global failure (see healthCheckAll), reported on the batch only.
  const allFailed = await manager.healthCheckAll(async () => {
    throw new Error('composio down');
  });
  assert.equal(allFailed.updated, 0);
  assert.equal(allFailed.error, 'composio down');
  assert.equal(manager.get('gmail').consecutiveFailures, 0, 'global fetch failure blames no toolkit');
  assert.equal(manager.get('gmail').lastError, undefined);
  // healthCheckAll success path.
  const allOk = await manager.healthCheckAll(async () => [
    { toolkit: 'gmail', status: 'active' },
    { toolkit: 'notion', status: 'none' },
  ]);
  assert.equal(allOk.updated, 2);
  assert.equal(allOk.error, undefined);
  assert.equal(manager.get('gmail').consecutiveFailures, 0);
  assert.equal(manager.get('notion').status, 'none');
  // github + slack were never re-checked successfully: still
  // unhealthy (their earlier failures are recorded), alongside
  // notion ('none').
  assert.deepEqual(allOk.unhealthy, ['github', 'slack', 'notion']);
  // reset() one toolkit, then all.
  manager.reset('gmail');
  assert.equal(manager.get('gmail').status, 'none');
  assert.equal(manager.get('gmail').lastCheckedAtMs, undefined);
  manager.reset();
  assert.equal(manager.get('notion').status, 'none');
});

test('composio v108: toolkit manager enabled flags persist to file, statuses do not', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'connections.json');
  const manager = new ComposioToolkitConnectionManager({ file });
  manager.setEnabled('gmail', false);
  assert.ok(fs.existsSync(file));
  const reloaded = new ComposioToolkitConnectionManager({ file });
  assert.equal(reloaded.isEnabled('gmail'), false);
  assert.equal(reloaded.get('gmail').status, 'none', 'statuses are re-checked after restart, never persisted');
  fs.writeFileSync(file, 'garbage', 'utf8');
  assert.equal(new ComposioToolkitConnectionManager({ file }).isEnabled('gmail'), true);
});

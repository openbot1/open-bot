/**
 * Composio v118 tests (v1.18, Doi T4 — node:test, no network, no key).
 *
 * Covers:
 * - Mock toolkits v118: 3 toolkits (canva/pandadoc/loom), 10 candidate
 *   slugs each, none overlapping the 40 live toolkits or the
 *   v110/v111/v112/v114 mock toolkits; every toolkit is mockOnly +
 *   not live-verified and carries authKind + authNote; mock executor
 *   deterministic, echo args, mock:true/live:false
 * - Polling v5: per-connection adaptive state (hit shrinks, burst
 *   goes to min on consecutive hits, miss grows, idle caps at max
 *   on consecutive misses, error backs off), dedupe (window + cap),
 *   serialize/parse/resume, missed polls, engine tick (due only,
 *   per-connection errors isolated, persist + restore)
 * - Trigger instances: register/list/enable/disable/delete, health
 *   (healthy/stale/silent/error) + last-fired, memory + JSON file
 *   stores, audit entries
 * - OAuth state machine: all 5 states, legal/illegal transitions
 *   (revoked is terminal except reconnect), auto-refresh mock
 *   (success/error/revoked), budget exhausted, expiring-soon,
 *   expiry sync, UI state per state
 * - Webhook ingestion: loopback-only, method/path guards, HMAC
 *   verify (bad signature rejected even with a valid token),
 *   token fallback, bad body, dedupe, route to registered/disabled/
 *   unknown trigger instances, event log (memory + JSONL file)
 *
 * Imports the BUILT core — build first:
 *   npm run build --workspace=@open-bot/core
 * then: node --test tests/composio-v118.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  COMPOSIO_V118_MOCK_TOOLKITS,
  MockComposioV118Executor,
  createMockComposioV118AppDefinitions,
  executeMockComposioV118Tool,
  findMockComposioV118Toolkit,
  isMockComposioV118Slug,
  mockComposioV118AppId,
  mockComposioV118DeterministicId,
  mockComposioV118Slugs,
  mockComposioV118ToolNeedsApproval,
  summarizeMockComposioV118Catalogue,
} from '../packages/core/dist/composio/toolkitsV118.js';
import { COMPOSIO_TOOLKIT_SLUGS } from '../packages/core/dist/composio/toolkits.js';
import { COMPOSIO_V110_MOCK_TOOLKITS } from '../packages/core/dist/composio/toolkitsV110.js';
import { COMPOSIO_V111_MOCK_TOOLKITS } from '../packages/core/dist/composio/toolkitsV111.js';
import { COMPOSIO_V112_MOCK_TOOLKITS } from '../packages/core/dist/composio/toolkitsV112.js';
import { COMPOSIO_V114_MOCK_TOOLKITS } from '../packages/core/dist/composio/toolkitsV114.js';
import { COMPOSIO_V13_TOOLKIT_SLUGS } from '../packages/core/dist/fleetV13/index.js';
import {
  COMPOSIO_V118_DEFAULT_IDLE_CAP_AFTER_MISSES,
  COMPOSIO_V118_DEFAULT_BURST_AFTER_HITS,
  ComposioV118PollEngine,
  JsonFileComposioV118PollStateStore,
  MemoryComposioV118PollStateStore,
  composioV118MsUntilNextPoll,
  composioV118PollMode,
  createComposioV118ConnState,
  defaultComposioV118IntervalMs,
  filterComposioV118NewItems,
  isComposioV118ConnDue,
  missedComposioV118Polls,
  nextComposioV118Poll,
  parseComposioV118PollState,
  serializeComposioV118PollState,
  validateComposioV118ConnState,
} from '../packages/core/dist/composio/pollingV118.js';
import {
  JsonFileComposioV118TriggerInstanceStore,
  MemoryComposioV118TriggerInstanceStore,
  createComposioV118TriggerAuditEntry,
  createComposioV118TriggerInstance,
  disableComposioV118TriggerInstance,
  enableComposioV118TriggerInstance,
  evaluateComposioV118TriggerHealth,
  filterComposioV118TriggerInstances,
  recordComposioV118TriggerError,
  recordComposioV118TriggerFired,
  summarizeComposioV118TriggerInstances,
  validateComposioV118TriggerAuditEntry,
  validateComposioV118TriggerInstance,
} from '../packages/core/dist/composio/triggerInstancesV118.js';
import {
  COMPOSIO_V118_DEFAULT_MAX_AUTO_REFRESHES,
  autoRefreshComposioV118OAuth,
  composioV118OAuthUiState,
  createComposioV118OAuthEntry,
  decideComposioV118AutoRefresh,
  isComposioV118OAuthTransitionAllowed,
  isComposioV118TokenExpired,
  isComposioV118TokenExpiringSoon,
  summarizeComposioV118OAuth,
  syncComposioV118OAuthExpiry,
  transitionComposioV118OAuth,
  validateComposioV118OAuthEntry,
} from '../packages/core/dist/composio/oauthStateV118.js';
import {
  COMPOSIO_V118_WEBHOOK_PATH,
  ComposioV118WebhookIngester,
  appendComposioV118WebhookLog,
  hashComposioV118WebhookBody,
  isComposioV118LoopbackAddress,
  listComposioV118WebhookLog,
} from '../packages/core/dist/composio/webhookIngestV118.js';
import { computeComposioWebhookSignature } from '../packages/core/dist/composio/triggers.js';

const NOW = 1_800_000_000_000;
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

// ---------------------------------------------------------------------------
// Mock toolkits v118
// ---------------------------------------------------------------------------

test('composio v118 mock toolkits: 3 toolkits, 10 slugs each, no overlap', () => {
  assert.deepEqual(
    COMPOSIO_V118_MOCK_TOOLKITS.map((t) => t.slug),
    ['canva', 'pandadoc', 'loom'],
  );
  const allSlugs = mockComposioV118Slugs();
  assert.equal(allSlugs.length, 30);
  assert.equal(new Set(allSlugs).size, 30);
  for (const t of COMPOSIO_V118_MOCK_TOOLKITS) {
    assert.equal(t.candidateToolSlugs.length, 10);
    assert.equal(t.mockOnly, true);
    assert.equal(t.liveVerified, false);
    assert.ok(['oauth2', 'api-key', 'oauth2-or-api-key'].includes(t.authKind));
    assert.ok(t.authNote.length > 20);
    assert.ok(t.description.includes('[MOCK]'));
    // Khong trung toolkit live (40), mock v110/v111/v112/v114, hay
    // 6 toolkit mock v116 fleetV13 (docusign/freshbooks/gong/lever/
    // quickbooks/resend) — FIX v1.18: T4 tung chon 'docusign' trung
    // fleetV13, doi thanh 'pandadoc'; check nay ngan tai dien.
    assert.ok(!COMPOSIO_TOOLKIT_SLUGS.includes(t.slug), `${t.slug} overlaps live`);
    assert.ok(
      !COMPOSIO_V13_TOOLKIT_SLUGS.includes(t.slug),
      `${t.slug} overlaps fleetV13 v116`,
    );
    for (const older of [
      COMPOSIO_V110_MOCK_TOOLKITS,
      COMPOSIO_V111_MOCK_TOOLKITS,
      COMPOSIO_V112_MOCK_TOOLKITS,
      COMPOSIO_V114_MOCK_TOOLKITS,
    ]) {
      assert.ok(!older.some((o) => o.slug === t.slug), `${t.slug} overlaps an older mock toolkit`);
    }
    for (const slug of t.candidateToolSlugs) {
      assert.ok(isMockComposioV118Slug(slug));
      assert.equal(findMockComposioV118Toolkit(t.slug), t);
    }
  }
  assert.equal(findMockComposioV118Toolkit('gmail'), undefined);
  assert.equal(isMockComposioV118Slug('GMAIL_FETCH_EMAILS'), false);
  // microsoftteams/teams khong co trong Composio — khong duoc them vao day.
  assert.equal(findMockComposioV118Toolkit('microsoftteams'), undefined);
  assert.equal(findMockComposioV118Toolkit('teams'), undefined);
  const summary = summarizeMockComposioV118Catalogue();
  assert.equal(summary.totalToolkits, 3);
  assert.equal(summary.totalSlugs, 30);
  assert.equal(summary.writeSlugs + summary.readSlugs, 30);
  assert.ok(summary.writeSlugs > 0 && summary.readSlugs > 0);
  assert.deepEqual(
    summary.byToolkit.map((b) => b.slug),
    ['canva', 'pandadoc', 'loom'],
  );
  // App definitions: 1 app moi toolkit, 10 tool moi app.
  const apps = createMockComposioV118AppDefinitions();
  assert.equal(apps.length, 3);
  for (const app of apps) {
    assert.equal(app.tools.length, 10);
    assert.equal(app.source, 'composio');
    assert.equal(app.authType, 'composio');
    assert.equal(app.id, mockComposioV118AppId(app.toolkit));
  }
});

test('composio v118 mock executor: deterministic, echo, mock flags', () => {
  const exec = new MockComposioV118Executor();
  assert.deepEqual(
    exec.listToolkits().map((t) => t.slug),
    ['canva', 'pandadoc', 'loom'],
  );
  assert.equal(exec.listSlugs('loom').length, 10);
  assert.throws(() => exec.listSlugs('gmail'), /Unknown mock Composio v118 toolkit/);
  const r1 = executeMockComposioV118Tool('canva', 'CANVA_LIST_DESIGNS', { limit: 5 });
  const r2 = executeMockComposioV118Tool('canva', 'CANVA_LIST_DESIGNS', { limit: 5 });
  assert.equal(r1.mock, true);
  assert.equal(r1.live, false);
  assert.deepEqual(r1, r2);
  assert.equal(r1.data.echo.limit, 5);
  assert.ok(Array.isArray(r1.data.designs));
  assert.equal(r1.data.requestId, mockComposioV118DeterministicId('canva:CANVA_LIST_DESIGNS'));
  assert.equal(mockComposioV118DeterministicId('a'), mockComposioV118DeterministicId('a'));
  assert.notEqual(mockComposioV118DeterministicId('a'), mockComposioV118DeterministicId('b'));
  const write = executeMockComposioV118Tool('pandadoc', 'PANDADOC_CREATE_DOCUMENT', {});
  assert.equal(write.data.created, true);
  assert.equal(mockComposioV118ToolNeedsApproval('PANDADOC_CREATE_DOCUMENT'), true);
  assert.equal(mockComposioV118ToolNeedsApproval('PANDADOC_LIST_DOCUMENTS'), false);
  assert.equal(mockComposioV118ToolNeedsApproval('LOOM_GET_VIDEO_ANALYTICS'), false);
  assert.throws(() => executeMockComposioV118Tool('canva', 'GMAIL_FETCH_EMAILS'), /Unknown mock Composio v118 tool slug/);
  assert.throws(() => executeMockComposioV118Tool('gmail', 'GMAIL_FETCH_EMAILS'), /Unknown mock Composio v118 toolkit/);
});

// ---------------------------------------------------------------------------
// Polling v5
// ---------------------------------------------------------------------------

test('composio v118 polling: create state defaults + validation', () => {
  const gmail = createComposioV118ConnState({ connectionId: 'ca_1', toolkit: 'gmail', triggerSlug: 'GMAIL_NEW_GMAIL_MESSAGE', startAtMs: NOW });
  assert.equal(gmail.policy.baseIntervalMs, 5 * 60 * 1000);
  assert.equal(gmail.policyState.currentIntervalMs, 5 * 60 * 1000);
  assert.equal(gmail.enabled, true);
  assert.equal(gmail.nextPollAtMs, NOW);
  assert.equal(gmail.lastPollAtMs, null);
  assert.equal(gmail.totalNewItems, 0);
  assert.equal(defaultComposioV118IntervalMs('xero'), 60 * 60 * 1000);
  assert.equal(defaultComposioV118IntervalMs('unknown-toolkit'), 10 * 60 * 1000);
  assert.equal(isComposioV118ConnDue(gmail, NOW), true);
  assert.equal(isComposioV118ConnDue(gmail, NOW - 1), false);
  assert.equal(composioV118MsUntilNextPoll(gmail, NOW), 0);
  assert.equal(composioV118MsUntilNextPoll({ ...gmail, enabled: false }, NOW), -1);
  assert.throws(() => createComposioV118ConnState({ connectionId: '', toolkit: 'gmail', triggerSlug: 'GMAIL_NEW_GMAIL_MESSAGE' }), /connectionId/);
  assert.throws(() => createComposioV118ConnState({ connectionId: 'ca_1', toolkit: 'gmail', triggerSlug: 'bad-slug' }), /triggerSlug/);
  assert.throws(() => createComposioV118ConnState({ connectionId: 'ca_1', toolkit: 'gmail', triggerSlug: 'GMAIL_NEW_GMAIL_MESSAGE', policy: { hitFactor: 2 } }), /hitFactor/);
  assert.throws(() => validateComposioV118ConnState({ ...gmail, totalNewItems: -1 }), /totalNewItems/);
});

test('composio v118 polling: hit shrinks, burst goes to min, miss grows, idle caps at max', () => {
  const base = createComposioV118ConnState({ connectionId: 'ca_1', toolkit: 'gmail', triggerSlug: 'GMAIL_NEW_GMAIL_MESSAGE', startAtMs: NOW });
  // Hit 1: 300000 -> 150000 (hitFactor 0.5), chua burst.
  const hit1 = nextComposioV118Poll(base, 'hit', { nowMs: NOW, newItemIds: ['m1'] });
  assert.equal(hit1.policyState.currentIntervalMs, 150000);
  assert.equal(hit1.policyState.consecutiveHits, 1);
  assert.equal(hit1.totalNewItems, 1);
  assert.equal(hit1.lastFiredAtMs, NOW);
  assert.equal(composioV118PollMode(hit1), 'normal');
  // Hit 2: streak 2 >= burstAfterHits (2) -> ve thang min.
  const hit2 = nextComposioV118Poll(hit1, 'hit', { nowMs: NOW + 1000, newItemIds: ['m2'] });
  assert.equal(hit2.policyState.currentIntervalMs, hit2.policy.minIntervalMs);
  assert.equal(hit2.policyState.consecutiveHits, 2);
  assert.equal(composioV118PollMode(hit2), 'burst');
  assert.equal(hit2.totalNewItems, 2);
  // Miss: gian 1.5x tu min; streak miss 1.
  const miss1 = nextComposioV118Poll(hit2, 'miss', { nowMs: NOW + 2000 });
  assert.ok(miss1.policyState.currentIntervalMs > hit2.policy.minIntervalMs);
  assert.equal(miss1.policyState.consecutiveMisses, 1);
  assert.equal(miss1.policyState.consecutiveHits, 0);
  assert.equal(composioV118PollMode(miss1), 'normal');
  // 5 miss lien tiep -> idle cap o max.
  let s = base;
  for (let i = 0; i < COMPOSIO_V118_DEFAULT_IDLE_CAP_AFTER_MISSES; i += 1) {
    s = nextComposioV118Poll(s, 'miss', { nowMs: NOW + i * 1000 });
  }
  assert.equal(s.policyState.currentIntervalMs, s.policy.maxIntervalMs);
  assert.equal(composioV118PollMode(s), 'idle');
  // Error: backoff nhan 2, mode error.
  const err = nextComposioV118Poll(base, 'error', { nowMs: NOW, error: 'boom' });
  assert.equal(err.policyState.currentIntervalMs, 600000);
  assert.equal(err.policyState.consecutiveErrors, 1);
  assert.equal(err.policyState.lastError, 'boom');
  assert.equal(composioV118PollMode(err), 'error');
  // Hit sau loi: reset loi, lastFired cap nhat.
  const afterErr = nextComposioV118Poll(err, 'hit', { nowMs: NOW + 1000, newItemIds: ['m9'] });
  assert.equal(afterErr.policyState.consecutiveErrors, 0);
  assert.equal(afterErr.policyState.lastError, null);
});

test('composio v118 polling: dedupe filter + serialize/parse + missed polls', () => {
  const state = createComposioV118ConnState({ connectionId: 'ca_1', toolkit: 'gmail', triggerSlug: 'GMAIL_NEW_GMAIL_MESSAGE', startAtMs: NOW });
  const afterHit = nextComposioV118Poll(state, 'hit', { nowMs: NOW, newItemIds: ['m1', 'm2'] });
  const { fresh, duplicates } = filterComposioV118NewItems(
    [{ id: 'm1' }, { id: 'm3' }],
    afterHit,
    NOW + 1000,
  );
  assert.deepEqual(fresh.map((i) => i.id), ['m3']);
  assert.deepEqual(duplicates.map((i) => i.id), ['m1']);
  // Id qua cua so dedupe (24h) thi lai la moi.
  const { fresh: freshOld } = filterComposioV118NewItems([{ id: 'm1' }], afterHit, NOW + 25 * HOUR);
  assert.deepEqual(freshOld.map((i) => i.id), ['m1']);
  // Serialize/parse round-trip.
  const json = serializeComposioV118PollState(afterHit, NOW);
  const parsed = parseComposioV118PollState(json);
  assert.equal(parsed.connectionId, 'ca_1');
  assert.equal(parsed.policyState.currentIntervalMs, afterHit.policyState.currentIntervalMs);
  assert.equal(parsed.totalNewItems, 2);
  assert.deepEqual(parsed.policyState.seenIds, afterHit.policyState.seenIds);
  assert.throws(() => parseComposioV118PollState('not json'), /not valid JSON/);
  assert.throws(
    () => parseComposioV118PollState(JSON.stringify({ version: 99, state: afterHit, savedAtMs: NOW })),
    /unsupported poll state version/,
  );
  // Missed polls: nextPollAtMs = NOW + 150000; sau 1h lo ~23 lan.
  assert.equal(missedComposioV118Polls(afterHit, NOW + HOUR), Math.floor((NOW + HOUR - afterHit.nextPollAtMs) / 150000));
  assert.equal(missedComposioV118Polls(afterHit, NOW + 1000), 0);
});

test('composio v118 polling: engine tick, persist + restore, error isolation', async () => {
  const store = new MemoryComposioV118PollStateStore();
  const engine = new ComposioV118PollEngine({ store });
  const gmail = createComposioV118ConnState({ connectionId: 'ca_gmail', toolkit: 'gmail', triggerSlug: 'GMAIL_NEW_GMAIL_MESSAGE', startAtMs: NOW });
  const slack = createComposioV118ConnState({ connectionId: 'ca_slack', toolkit: 'slack', triggerSlug: 'SLACK_RECEIVE_MESSAGE', startAtMs: NOW });
  engine.addConnection(gmail);
  engine.addConnection(slack);
  assert.throws(() => engine.addConnection(gmail), /duplicate poll connection/);
  assert.equal(engine.dueConnections(NOW).length, 2);
  const results = await engine.tick(NOW, async (s) => {
    if (s.connectionId === 'ca_slack') throw new Error('slack down');
    return { items: [{ id: 'm1' }, { id: 'm2' }], cursor: 'cur-1' };
  });
  assert.equal(results.length, 2);
  const g = results.find((r) => r.connectionId === 'ca_gmail');
  const sl = results.find((r) => r.connectionId === 'ca_slack');
  assert.equal(g.ok, true);
  assert.equal(g.fresh, 2);
  assert.equal(g.duplicates, 0);
  assert.equal(g.mode, 'normal');
  assert.equal(sl.ok, false);
  assert.equal(sl.error, 'slack down');
  assert.equal(sl.mode, 'error');
  // Gmail da persist: store co state moi + cursor.
  const saved = store.load('ca_gmail');
  assert.equal(saved.lastCursor, 'cur-1');
  assert.equal(saved.totalNewItems, 2);
  // Tick 2: gmail chua den han (interval 150000), slack den han? slack error -> interval 240000 (2*120000 base slack) -> chua den han o NOW+1000.
  const results2 = await engine.tick(NOW + 1000, async () => ({ items: [] }));
  assert.equal(results2.length, 0);
  // Tick 3: gmail den han o NOW+150000 — m1 trung (dedupe), m3 moi.
  const results3 = await engine.tick(NOW + 150000, async (s) => {
    if (s.connectionId === 'ca_slack') throw new Error('slack down');
    return { items: [{ id: 'm1' }, { id: 'm3' }] };
  });
  assert.equal(results3.length, 1);
  assert.equal(results3[0].fresh, 1);
  assert.equal(results3[0].duplicates, 1);
  assert.equal(engine.getConnection('ca_gmail').totalNewItems, 3);
  // Restore tu store sang engine moi.
  const engine2 = new ComposioV118PollEngine({ store });
  assert.equal(engine2.restoreFromStore(), 2);
  assert.equal(engine2.getConnection('ca_gmail').totalNewItems, 3);
  // setEnabled + remove.
  assert.equal(engine2.setEnabled('ca_gmail', false).enabled, false);
  assert.equal(engine2.dueConnections(NOW + 10 * DAY).filter((s) => s.connectionId === 'ca_gmail').length, 0);
  assert.equal(engine2.removeConnection('ca_gmail'), true);
  assert.equal(engine2.removeConnection('ca_gmail'), false);
  const summary = engine.summarize(NOW);
  assert.equal(summary.total, 2);
  assert.equal(summary.erroring, 1);
  assert.equal(summary.totalNewItems, 3);
});

test('composio v118 polling: JSON file store round-trip', () => {
  const dir = mkdtempSync(join(tmpdir(), 'composio-v118-poll-'));
  try {
    const store = new JsonFileComposioV118PollStateStore({ dir });
    const state = createComposioV118ConnState({ connectionId: 'ca_1', toolkit: 'gmail', triggerSlug: 'GMAIL_NEW_GMAIL_MESSAGE', startAtMs: NOW });
    store.save(state);
    assert.equal(store.load('ca_1').toolkit, 'gmail');
    assert.equal(store.load('ca_missing'), undefined);
    const afterHit = nextComposioV118Poll(state, 'hit', { nowMs: NOW, newItemIds: ['m1'] });
    store.save(afterHit);
    assert.equal(store.loadAll().length, 1);
    assert.equal(store.load('ca_1').totalNewItems, 1);
    assert.equal(store.remove('ca_1'), true);
    assert.equal(store.loadAll().length, 0);
    assert.equal(store.remove('ca_1'), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Trigger instances
// ---------------------------------------------------------------------------

test('composio v118 trigger instances: create/validate/enable/disable/fire', () => {
  const inst = createComposioV118TriggerInstance(
    { triggerId: 'ti_1', triggerSlug: 'GITHUB_COMMIT_EVENT', toolkit: 'github', connectionId: 'ca_1', label: 'Commits' },
    NOW,
  );
  assert.equal(inst.status, 'enabled');
  assert.equal(inst.totalFired, 0);
  assert.equal(inst.lastFiredAtMs, null);
  assert.equal(evaluateComposioV118TriggerHealth(inst, NOW), 'silent');
  const fired = recordComposioV118TriggerFired(inst, NOW + 1000);
  assert.equal(fired.totalFired, 1);
  assert.equal(fired.lastFiredAtMs, NOW + 1000);
  assert.equal(evaluateComposioV118TriggerHealth(fired, NOW + 2000), 'healthy');
  assert.equal(evaluateComposioV118TriggerHealth(fired, NOW + 25 * HOUR), 'stale');
  assert.equal(evaluateComposioV118TriggerHealth(fired, NOW + 8 * DAY), 'silent');
  const disabled = disableComposioV118TriggerInstance(fired, NOW + 3000);
  assert.equal(disabled.status, 'disabled');
  const enabled = enableComposioV118TriggerInstance(disabled, NOW + 4000);
  assert.equal(enabled.status, 'enabled');
  const errored = recordComposioV118TriggerError(fired, 'handler failed', NOW + 5000);
  assert.equal(errored.consecutiveErrors, 1);
  assert.equal(errored.lastError, 'handler failed');
  assert.equal(evaluateComposioV118TriggerHealth(errored, NOW + 6000), 'error');
  const firedAgain = recordComposioV118TriggerFired(errored, NOW + 7000);
  assert.equal(firedAgain.consecutiveErrors, 0);
  assert.equal(firedAgain.lastError, null);
  assert.throws(
    () => createComposioV118TriggerInstance({ triggerId: 'ti_1', triggerSlug: 'bad', toolkit: 'github', connectionId: 'ca_1' }),
    /triggerSlug is invalid/,
  );
  assert.throws(() => validateComposioV118TriggerInstance({ ...inst, status: 'weird' }), /status must be/);
  const audit = createComposioV118TriggerAuditEntry('ti_1', 'GITHUB_COMMIT_EVENT', 'enable', 'user enabled', NOW);
  assert.equal(validateComposioV118TriggerAuditEntry(audit).action, 'enable');
  assert.throws(() => createComposioV118TriggerAuditEntry('ti_1', 'GITHUB_COMMIT_EVENT', 'explode', 'x', NOW), /Unknown/);
});

test('composio v118 trigger instances: memory store CRUD + filter + summary', () => {
  const store = new MemoryComposioV118TriggerInstanceStore();
  store.register({ triggerId: 'ti_1', triggerSlug: 'GITHUB_COMMIT_EVENT', toolkit: 'github', connectionId: 'ca_1', label: 'Commits' }, NOW);
  store.register({ triggerId: 'ti_2', triggerSlug: 'GMAIL_NEW_GMAIL_MESSAGE', toolkit: 'gmail', connectionId: 'ca_2', label: 'Mail', status: 'disabled' }, NOW);
  assert.throws(
    () => store.register({ triggerId: 'ti_1', triggerSlug: 'GITHUB_COMMIT_EVENT', toolkit: 'github', connectionId: 'ca_1' }, NOW),
    /duplicate trigger instance/,
  );
  assert.equal(store.list().length, 2);
  assert.equal(store.list({ toolkit: 'github' }).length, 1);
  assert.equal(store.list({ status: 'disabled' }).length, 1);
  const fired = recordComposioV118TriggerFired(store.get('ti_1'), NOW + 1000);
  store.update(fired);
  assert.equal(store.list({ health: 'healthy' }, NOW + 2000).length, 1);
  assert.equal(store.list({ health: 'silent' }, NOW + 2000).length, 1);
  const summary = summarizeComposioV118TriggerInstances(store.list(), NOW + 2000);
  assert.equal(summary.total, 2);
  assert.equal(summary.enabled, 1);
  assert.equal(summary.disabled, 1);
  assert.equal(summary.healthy, 1);
  assert.equal(summary.totalFired, 1);
  assert.deepEqual(summary.needsAttention, []);
  assert.equal(store.remove('ti_2'), true);
  assert.equal(store.remove('ti_2'), false);
  assert.equal(store.get('ti_2'), undefined);
  assert.throws(() => store.update({ ...fired, triggerId: 'ti_missing' }), /unknown trigger instance/);
  assert.ok(store.listAudit(10).length >= 2);
});

test('composio v118 trigger instances: JSON file store round-trip', () => {
  const dir = mkdtempSync(join(tmpdir(), 'composio-v118-ti-'));
  try {
    const store = new JsonFileComposioV118TriggerInstanceStore(dir);
    store.register({ triggerId: 'ti_9', triggerSlug: 'SLACK_RECEIVE_MESSAGE', toolkit: 'slack', connectionId: 'ca_9', label: 'Slack' }, NOW);
    const again = new JsonFileComposioV118TriggerInstanceStore(dir);
    assert.equal(again.get('ti_9').label, 'Slack');
    const disabled = disableComposioV118TriggerInstance(again.get('ti_9'), NOW + 1000);
    again.update(disabled);
    assert.equal(new JsonFileComposioV118TriggerInstanceStore(dir).get('ti_9').status, 'disabled');
    assert.equal(again.listAudit({ triggerId: 'ti_9' }).length, 1);
    assert.equal(again.listAudit({ action: 'register' }).length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// OAuth state machine
// ---------------------------------------------------------------------------

test('composio v118 oauth: transitions legal/illegal + UI state', () => {
  assert.equal(isComposioV118OAuthTransitionAllowed('connected', 'refreshing'), true);
  assert.equal(isComposioV118OAuthTransitionAllowed('revoked', 'connected'), false);
  assert.equal(isComposioV118OAuthTransitionAllowed('revoked', 'connecting'), true);
  assert.equal(isComposioV118OAuthTransitionAllowed('expired', 'connected'), true);
  const entry = createComposioV118OAuthEntry('ca_1', 'gmail', { state: 'connecting', nowMs: NOW });
  assert.equal(entry.state, 'connecting');
  const { entry: connected, audit } = transitionComposioV118OAuth(entry, 'connected', 'user finished OAuth', { nowMs: NOW + 1000, expiresAtMs: NOW + HOUR });
  assert.equal(connected.state, 'connected');
  assert.equal(audit.from, 'connecting');
  assert.equal(audit.to, 'connected');
  assert.equal(connected.expiresAtMs, NOW + HOUR);
  assert.equal(isComposioV118TokenExpiringSoon(connected, NOW + HOUR - 60 * 1000), true);
  assert.equal(isComposioV118TokenExpiringSoon(connected, NOW), false);
  assert.equal(isComposioV118TokenExpired(connected, NOW + HOUR + 1), true);
  assert.equal(isComposioV118TokenExpired(connected, NOW), false);
  // revoked la trang thai cuoi: chi connecting moi thoat duoc.
  const revoked = transitionComposioV118OAuth(connected, 'revoked', 'app revoked access', { nowMs: NOW + 2000 }).entry;
  assert.throws(() => transitionComposioV118OAuth(revoked, 'connected', 'x', { nowMs: NOW + 3000 }), /Invalid OAuth transition/);
  assert.throws(() => transitionComposioV118OAuth(revoked, 'refreshing', 'x', { nowMs: NOW + 3000 }), /Invalid OAuth transition/);
  const reconnecting = transitionComposioV118OAuth(revoked, 'connecting', 'user reconnects', { nowMs: NOW + 4000 }).entry;
  assert.equal(reconnecting.state, 'connecting');
  // UI state theo tung trang thai.
  assert.deepEqual(
    { badge: composioV118OAuthUiState(connected, NOW).badge, action: composioV118OAuthUiState(connected, NOW).action },
    { badge: 'green', action: 'none' },
  );
  assert.equal(composioV118OAuthUiState(revoked, NOW).badge, 'red');
  assert.equal(composioV118OAuthUiState(revoked, NOW).action, 'reconnect');
  assert.equal(composioV118OAuthUiState(revoked, NOW).needsAttention, true);
  const expiring = { ...connected, expiresAtMs: NOW + 60 * 1000 };
  assert.equal(composioV118OAuthUiState(expiring, NOW).badge, 'amber');
  assert.equal(composioV118OAuthUiState(expiring, NOW).action, 'refresh');
  const expired = transitionComposioV118OAuth(connected, 'expired', 'token expired', { nowMs: NOW + 5000 }).entry;
  assert.equal(composioV118OAuthUiState(expired, NOW).action, 'refresh');
  assert.equal(composioV118OAuthUiState({ ...expired, autoRefreshAttempts: 3 }, NOW).action, 'reconnect');
  assert.throws(() => validateComposioV118OAuthEntry({ ...entry, state: 'bogus' }), /state is invalid/);
  assert.throws(() => createComposioV118OAuthEntry('', 'gmail'), /connectionId/);
});

test('composio v118 oauth: decide auto-refresh + mock refresh rounds', async () => {
  const expired = createComposioV118OAuthEntry('ca_1', 'gmail', { state: 'expired', nowMs: NOW });
  const d1 = decideComposioV118AutoRefresh(expired, NOW);
  assert.equal(d1.allowed, true);
  const outOfBudget = { ...expired, autoRefreshAttempts: COMPOSIO_V118_DEFAULT_MAX_AUTO_REFRESHES };
  assert.equal(decideComposioV118AutoRefresh(outOfBudget, NOW).allowed, false);
  const revoked = createComposioV118OAuthEntry('ca_1', 'gmail', { state: 'revoked', nowMs: NOW });
  assert.equal(decideComposioV118AutoRefresh(revoked, NOW).allowed, false);
  const fresh = createComposioV118OAuthEntry('ca_1', 'gmail', { state: 'connected', expiresAtMs: NOW + 10 * HOUR, nowMs: NOW });
  assert.equal(decideComposioV118AutoRefresh(fresh, NOW).allowed, false);
  const soon = createComposioV118OAuthEntry('ca_1', 'gmail', { state: 'connected', expiresAtMs: NOW + 60 * 1000, nowMs: NOW });
  assert.equal(decideComposioV118AutoRefresh(soon, NOW).allowed, true);
  // Refresh thanh cong: expired -> refreshing -> connected, reset dem, han moi.
  const ok = await autoRefreshComposioV118OAuth(expired, async () => ({ ok: true, expiresAtMs: NOW + HOUR }), NOW);
  assert.equal(ok.entry.state, 'connected');
  assert.equal(ok.entry.expiresAtMs, NOW + HOUR);
  assert.equal(ok.entry.autoRefreshAttempts, 0);
  assert.equal(ok.audits.length, 2);
  assert.deepEqual(
    ok.audits.map((a) => a.to),
    ['refreshing', 'connected'],
  );
  // Refresh that bai thuong: ve expired, dem +1.
  const fail = await autoRefreshComposioV118OAuth(expired, async () => ({ ok: false, error: 'network down' }), NOW);
  assert.equal(fail.entry.state, 'expired');
  assert.equal(fail.entry.autoRefreshAttempts, 1);
  // Refresh bi thu hoi: ve revoked.
  const rev = await autoRefreshComposioV118OAuth(expired, async () => ({ ok: false, error: 'revoked', revoked: true }), NOW);
  assert.equal(rev.entry.state, 'revoked');
  // Khong du dieu kien refresh: khong doi gi, khong audit.
  const noop = await autoRefreshComposioV118OAuth(fresh, async () => ({ ok: true, expiresAtMs: NOW + HOUR }), NOW);
  assert.equal(noop.entry.state, 'connected');
  assert.equal(noop.audits.length, 0);
  // Refresh throw: thanh expired (khong nem ra ngoai).
  const threw = await autoRefreshComposioV118OAuth(expired, async () => {
    throw new Error('kaboom');
  }, NOW);
  assert.equal(threw.entry.state, 'expired');
  assert.equal(threw.entry.autoRefreshAttempts, 1);
});

test('composio v118 oauth: expiry sync + summary', () => {
  const connected = createComposioV118OAuthEntry('ca_1', 'gmail', { state: 'connected', expiresAtMs: NOW + HOUR, nowMs: NOW });
  const synced = syncComposioV118OAuthExpiry(connected, NOW + 2 * HOUR);
  assert.equal(synced.entry.state, 'expired');
  assert.ok(synced.audit);
  const back = syncComposioV118OAuthExpiry({ ...synced.entry, expiresAtMs: NOW + 3 * HOUR }, NOW + 2 * HOUR);
  assert.equal(back.entry.state, 'connected');
  const untouched = syncComposioV118OAuthExpiry(connected, NOW);
  assert.equal(untouched.entry.state, 'connected');
  assert.equal(untouched.audit, null);
  const summary = summarizeComposioV118OAuth([
    connected,
    createComposioV118OAuthEntry('ca_2', 'slack', { state: 'revoked', nowMs: NOW }),
    createComposioV118OAuthEntry('ca_3', 'github', { state: 'expired', nowMs: NOW }),
  ]);
  assert.equal(summary.total, 3);
  assert.equal(summary.connected, 1);
  assert.equal(summary.revoked, 1);
  assert.equal(summary.expired, 1);
  assert.deepEqual(summary.needsAttention, ['ca_2', 'ca_3']);
});

// ---------------------------------------------------------------------------
// Webhook ingestion
// ---------------------------------------------------------------------------

const SECRET = 'mock-secret-v118';
const TOKEN = 'mock-token-v118';

function document(overrides = {}) {
  return JSON.stringify({
    id: 'msg_1',
    type: 'composio.trigger.message',
    metadata: {
      log_id: 'log_1',
      trigger_slug: 'GITHUB_COMMIT_EVENT',
      trigger_id: 'ti_1',
      connected_account_id: 'ca_1',
      auth_config_id: 'ac_1',
      user_id: 'user-1',
    },
    data: { commit_sha: 'abc123', message: 'fix bug' },
    timestamp: '2026-01-15T10:30:00Z',
    ...overrides,
  });
}

function signedHeaders(body, { secret = SECRET, id = 'wh_1', ts = String(Math.floor(NOW / 1000)) } = {}) {
  return {
    'webhook-id': id,
    'webhook-timestamp': ts,
    'webhook-signature': computeComposioWebhookSignature(secret, id, ts, body),
  };
}

function makeIngester({ secret = SECRET, token = TOKEN, instances = new Map([['ti_1', 'enabled']]) } = {}) {
  return new ComposioV118WebhookIngester({
    getSecret: () => secret,
    getToken: () => token,
    lookupInstance: (triggerId) => {
      const status = instances.get(triggerId);
      if (!status) return undefined;
      return {
        triggerId,
        triggerSlug: 'GITHUB_COMMIT_EVENT',
        toolkit: 'github',
        connectionId: 'ca_1',
        label: triggerId,
        status,
        createdAtMs: NOW,
        updatedAtMs: NOW,
        lastFiredAtMs: null,
        totalFired: 0,
        consecutiveErrors: 0,
        lastError: null,
      };
    },
    now: () => NOW,
  });
}

test('composio v118 webhook: loopback-only + method/path guards', () => {
  const ingester = makeIngester();
  const body = document();
  assert.equal(isComposioV118LoopbackAddress('127.0.0.1'), true);
  assert.equal(isComposioV118LoopbackAddress('::1'), true);
  assert.equal(isComposioV118LoopbackAddress('localhost'), true);
  assert.equal(isComposioV118LoopbackAddress('8.8.8.8'), false);
  assert.equal(isComposioV118LoopbackAddress(undefined), false);
  const base = { path: COMPOSIO_V118_WEBHOOK_PATH, remoteAddress: '127.0.0.1', headers: signedHeaders(body), rawBody: body };
  assert.equal(ingester.ingest({ ...base, method: 'GET' }).status, 405);
  assert.equal(ingester.ingest({ ...base, method: 'POST', path: '/v1/other' }).status, 404);
  assert.equal(ingester.ingest({ ...base, method: 'POST', remoteAddress: '8.8.8.8' }).status, 403);
  assert.equal(ingester.ingest({ ...base, method: 'POST', remoteAddress: '203.0.113.5' }).status, 403);
});

test('composio v118 webhook: signature verify + token fallback', () => {
  const ingester = makeIngester();
  const body = document();
  const base = { method: 'POST', path: COMPOSIO_V118_WEBHOOK_PATH, remoteAddress: '127.0.0.1', rawBody: body };
  // Chu ky dung -> routed.
  const ok = ingester.ingest({ ...base, headers: signedHeaders(body) });
  assert.equal(ok.status, 200);
  assert.equal(ok.route, 'routed');
  assert.equal(ok.event.triggerSlug, 'GITHUB_COMMIT_EVENT');
  assert.equal(ok.event.triggerId, 'ti_1');
  // Chu ky sai -> 401 (ke ca token dung cung khong cuu).
  const badSig = ingester.ingest({
    ...base,
    headers: signedHeaders(body, { secret: 'wrong-secret' }),
    queryToken: TOKEN,
  });
  assert.equal(badSig.status, 401);
  assert.equal(badSig.accepted, false);
  // Khong co chu ky + khong co token -> 401.
  const noAuth = ingester.ingest({ ...base, headers: { 'webhook-id': 'wh_1', 'webhook-timestamp': String(Math.floor(NOW / 1000)) } });
  assert.equal(noAuth.status, 401);
  // Khong co chu ky + token dung -> routed (delivery moi).
  const body2 = document({ id: 'msg_2' });
  const viaToken = ingester.ingest({
    ...base,
    rawBody: body2,
    headers: { 'webhook-id': 'wh_2', 'webhook-timestamp': String(Math.floor(NOW / 1000)) },
    queryToken: TOKEN,
  });
  assert.equal(viaToken.status, 200);
  assert.equal(viaToken.route, 'routed');
  // Token sai -> 401.
  const badToken = ingester.ingest({
    ...base,
    rawBody: document({ id: 'msg_3' }),
    headers: {},
    queryToken: 'wrong-token',
  });
  assert.equal(badToken.status, 401);
  // Timestamp qua cu (qua tolerance 300s) -> 401.
  const stale = ingester.ingest({
    ...base,
    rawBody: document({ id: 'msg_4' }),
    headers: signedHeaders(body, { ts: String(Math.floor(NOW / 1000) - 3600) }),
  });
  assert.equal(stale.status, 401);
  // Body khong phai JSON (ky dung) -> 400.
  const badBody = 'not json';
  const badJson = ingester.ingest({ ...base, rawBody: badBody, headers: signedHeaders(badBody) });
  assert.equal(badJson.status, 400);
});

test('composio v118 webhook: dedupe + route unknown/disabled + log', () => {
  const ingester = makeIngester({ instances: new Map([['ti_1', 'enabled'], ['ti_2', 'disabled']]) });
  const body = document();
  const base = { method: 'POST', path: COMPOSIO_V118_WEBHOOK_PATH, remoteAddress: '127.0.0.1', rawBody: body };
  const first = ingester.ingest({ ...base, headers: signedHeaders(body) });
  assert.equal(first.route, 'routed');
  const dup = ingester.ingest({ ...base, headers: signedHeaders(body) });
  assert.equal(dup.status, 200);
  assert.equal(dup.route, 'duplicate');
  assert.equal(ingester.seenCount, 1);
  // Trigger chua dang ky -> ignored-unknown-trigger (van 200).
  const unknownBody = document({ id: 'msg_9', metadata: { trigger_slug: 'GITHUB_COMMIT_EVENT', trigger_id: 'ti_unknown', connected_account_id: 'ca_1' } });
  const unknown = ingester.ingest({ ...base, rawBody: unknownBody, headers: signedHeaders(unknownBody, { id: 'wh_9' }) });
  assert.equal(unknown.status, 200);
  assert.equal(unknown.route, 'ignored-unknown-trigger');
  // Trigger disabled -> ignored-disabled.
  const disabledBody = document({ id: 'msg_10', metadata: { trigger_slug: 'GITHUB_COMMIT_EVENT', trigger_id: 'ti_2', connected_account_id: 'ca_1' } });
  const disabled = ingester.ingest({ ...base, rawBody: disabledBody, headers: signedHeaders(disabledBody, { id: 'wh_10' }) });
  assert.equal(disabled.status, 200);
  assert.equal(disabled.route, 'ignored-disabled');
  // Log trong bo nho: moi nhat truoc, co du route, bodyHash 12 ky tu, khong chua secret.
  const log = ingester.listLog();
  assert.equal(log.length, 4);
  assert.equal(log[0].route, 'ignored-disabled');
  for (const entry of log) {
    assert.equal(entry.bodyHash.length, 12);
    assert.ok(!JSON.stringify(entry).includes(SECRET));
  }
  assert.equal(hashComposioV118WebhookBody(body), hashComposioV118WebhookBody(body));
  assert.notEqual(hashComposioV118WebhookBody(body), hashComposioV118WebhookBody('other'));
  // File log JSONL: append + list + filter.
  const dir = mkdtempSync(join(tmpdir(), 'composio-v118-wh-'));
  try {
    for (const entry of log) appendComposioV118WebhookLog(dir, entry);
    assert.equal(listComposioV118WebhookLog(dir).length, 4);
    assert.equal(listComposioV118WebhookLog(dir, { route: 'routed' }).length, 1);
    assert.equal(listComposioV118WebhookLog(dir, { route: 'duplicate' }).length, 1);
    assert.equal(listComposioV118WebhookLog(dir, { limit: 2 }).length, 2);
    assert.equal(listComposioV118WebhookLog(dir, { triggerSlug: 'GITHUB_COMMIT_EVENT' }).length, 4);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

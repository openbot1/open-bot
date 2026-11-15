/**
 * Composio v111 tests (v1.11, Đội T6 — node:test, no network, no key).
 *
 * Covers:
 *  - Mock toolkits v111: 6 toolkits (sentry/datadog/posthog/snowflake/
 *    amplitude/mixpanel), 10 candidate slugs each, none overlapping
 *    the 40 live toolkits or the 6 mock v110 toolkits; every toolkit
 *    is mockOnly + not live-verified; AppDefinitions carry the
 *    [MOCK] description
 *  - Mock executor: deterministic sample data per slug, echo of args,
 *    mock:true/live:false; unknown toolkit/slug throws
 *  - Connection lifecycle: empty/sync/disconnect/reconnect pure
 *    transitions; user-disconnect never auto-reconnects; reconnect
 *    budget (3 in 15m) with doubling backoff; summary counts +
 *    needsAttention; audit + durable store round-trip
 *  - Poll policy v111: hit shrinks interval, miss/error grow it
 *    (clamped to [1m, 6h]); jitter off = deterministic; invalid
 *    policy throws; dedupe by id inside the window, expired ids
 *    are forgotten; missed-poll catch-up counts
 *
 * Imports the BUILT core — build first:
 *   npm run build --workspace=@open-bot/core
 * then: node --test tests/composio-v111.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  COMPOSIO_V111_MOCK_TOOLKITS,
  MockComposioV111Executor,
  createMockComposioV111AppDefinitions,
  executeMockComposioV111Tool,
  findMockComposioV111Toolkit,
  isMockComposioV111Slug,
  mockComposioV111Slugs,
} from '../packages/core/dist/composio/toolkitsV111.js';
import { COMPOSIO_TOOLKIT_SLUGS } from '../packages/core/dist/composio/toolkits.js';
import { COMPOSIO_V110_MOCK_TOOLKITS } from '../packages/core/dist/composio/toolkitsV110.js';
import {
  appendComposioV111Audit,
  createComposioV111AuditEntry,
  decideComposioV111AutoReconnect,
  disconnectComposioV111Connection,
  emptyComposioV111ConnectionEntry,
  listComposioV111Audit,
  loadComposioV111Connections,
  reconnectComposioV111Connection,
  saveComposioV111Connections,
  summarizeComposioV111Connections,
  syncComposioV111SessionStatus,
  DEFAULT_COMPOSIO_V111_RECONNECT_POLICY,
} from '../packages/core/dist/composio/connectionLifecycle.js';
import {
  emptyComposioV111PollPolicyState,
  isComposioV111Duplicate,
  missedPollsBetween,
  nextComposioV111Poll,
  recordComposioV111SeenIds,
  summarizeComposioV111CatchUp,
  validateComposioV111PollPolicy,
  DEFAULT_COMPOSIO_V111_POLL_POLICY,
} from '../packages/core/dist/composio/pollPolicyV111.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-composio-v111-'));
}

// ---------------------------------------------------------------------------
// Mock toolkits v111
// ---------------------------------------------------------------------------

test('composio v111: 6 mock toolkits, 10 candidate slugs each', () => {
  assert.equal(COMPOSIO_V111_MOCK_TOOLKITS.length, 6);
  assert.deepEqual(
    COMPOSIO_V111_MOCK_TOOLKITS.map((t) => t.slug),
    ['sentry', 'datadog', 'posthog', 'snowflake', 'amplitude', 'mixpanel'],
  );
  for (const toolkit of COMPOSIO_V111_MOCK_TOOLKITS) {
    assert.equal(toolkit.candidateToolSlugs.length, 10, `${toolkit.slug} must have 10 candidate slugs`);
    assert.equal(toolkit.mockOnly, true);
    assert.equal(toolkit.liveVerified, false);
    assert.ok(toolkit.description.includes('[MOCK]'), 'UI description must flag MOCK');
    const prefix = toolkit.slug.toUpperCase();
    for (const slug of toolkit.candidateToolSlugs) {
      assert.ok(slug.startsWith(`${prefix}_`), `${slug} must start with ${prefix}_`);
    }
  }
  assert.equal(mockComposioV111Slugs().length, 60);
  assert.equal(new Set(mockComposioV111Slugs()).size, 60, 'candidate slugs must be unique');
});

test('composio v111: mock slugs do not collide with live or v110 mock catalogs', () => {
  const live = new Set(COMPOSIO_TOOLKIT_SLUGS);
  for (const toolkit of COMPOSIO_V111_MOCK_TOOLKITS) {
    assert.ok(!live.has(toolkit.slug), `${toolkit.slug} is already a live toolkit`);
  }
  const v110Slugs = new Set(COMPOSIO_V110_MOCK_TOOLKITS.map((t) => t.slug));
  for (const toolkit of COMPOSIO_V111_MOCK_TOOLKITS) {
    assert.ok(!v110Slugs.has(toolkit.slug), `${toolkit.slug} already exists as a v110 mock toolkit`);
  }
  // Tool slugs must not collide with v110 candidate tool slugs either.
  const v110ToolSlugs = new Set(COMPOSIO_V110_MOCK_TOOLKITS.flatMap((t) => t.candidateToolSlugs));
  for (const slug of mockComposioV111Slugs()) {
    assert.ok(!v110ToolSlugs.has(slug), `${slug} already a v110 mock tool slug`);
  }
});

test('composio v111: find/is helpers + AppDefinitions', () => {
  assert.equal(findMockComposioV111Toolkit('sentry')?.label.includes('Sentry'), true);
  assert.equal(findMockComposioV111Toolkit('github'), undefined);
  assert.equal(isMockComposioV111Slug('SENTRY_LIST_ISSUES'), true);
  assert.equal(isMockComposioV111Slug('GITHUB_LIST_REPOS'), false);
  const defs = createMockComposioV111AppDefinitions();
  assert.equal(defs.length, 6);
  assert.equal(defs[0].id, 'composio-sentry');
  assert.equal(defs[0].tools.length, 10);
  assert.ok(defs[0].tools[0].description.includes('[MOCK]'));
});

test('composio v111: mock executor returns deterministic sample data, never live', () => {
  const executor = new MockComposioV111Executor();
  const r1 = executor.execute('sentry', 'SENTRY_LIST_ISSUES', { project: 'p1' });
  assert.equal(r1.mock, true);
  assert.equal(r1.live, false);
  assert.equal(r1.toolkit, 'sentry');
  assert.equal(r1.slug, 'SENTRY_LIST_ISSUES');
  assert.ok(Array.isArray(r1.data.issues));
  assert.equal(r1.data.echo.project, 'p1');
  const r2 = executeMockComposioV111Tool('snowflake', 'SNOWFLAKE_RUN_QUERY', { sql: 'select 1' });
  assert.equal(r2.data.queryId, 'mock-query-1');
  assert.equal(r2.data.echo.sql, 'select 1');
  // Same input, same output (deterministic).
  assert.deepEqual(executor.execute('datadog', 'DATADOG_LIST_MONITORS', {}), executor.execute('datadog', 'DATADOG_LIST_MONITORS', {}));
  // Every candidate slug has a sample.
  for (const toolkit of COMPOSIO_V111_MOCK_TOOLKITS) {
    for (const slug of toolkit.candidateToolSlugs) {
      const r = executor.execute(toolkit.slug, slug, {});
      assert.equal(r.mock, true, `${slug} must be mock`);
      assert.equal(r.live, false, `${slug} must not be live`);
    }
  }
  assert.throws(() => executor.execute('github', 'GITHUB_LIST_REPOS', {}), /Unknown mock toolkit/);
  assert.throws(() => executor.execute('sentry', 'SENTRY_NOPE', {}), /not a candidate tool/);
});

// ---------------------------------------------------------------------------
// Connection lifecycle
// ---------------------------------------------------------------------------

test('composio v111: empty entry + session sync transitions', () => {
  const entry = emptyComposioV111ConnectionEntry('github', 'active', 1000);
  assert.equal(entry.status, 'active');
  assert.equal(entry.disconnectedByUser, false);
  const lost = syncComposioV111SessionStatus(entry, 'github', 'none', undefined, 2000);
  assert.equal(lost.status, 'failed', 'active connection lost without user action -> failed');
  const back = syncComposioV111SessionStatus(lost, 'github', 'active', 'octocat', 3000);
  assert.equal(back.status, 'active');
  assert.equal(back.accountLabel, 'octocat');
  assert.deepEqual(back.reconnectAttemptsMs, [], 'reconnect count resets on active');
  const initiated = syncComposioV111SessionStatus(undefined, 'slack', 'initiated', undefined, 1000);
  assert.equal(initiated.status, 'initiated');
  assert.throws(() => emptyComposioV111ConnectionEntry('not-a-toolkit', 'active'), /Unknown Composio toolkit/);
});

test('composio v111: user disconnect never auto-reconnects; reconnect records an attempt', () => {
  const active = emptyComposioV111ConnectionEntry('slack', 'active', 1000);
  const off = disconnectComposioV111Connection(active, 'slack', 'user turned it off', 2000);
  assert.equal(off.status, 'disconnected');
  assert.equal(off.disconnectedByUser, true);
  assert.equal(off.sessionStatus, 'none');
  assert.equal(off.lastReason, 'user turned it off');
  // Session sync keeps it disconnected (does not flip to failed).
  const synced = syncComposioV111SessionStatus(off, 'slack', 'none', undefined, 3000);
  assert.equal(synced.status, 'disconnected');
  const noAuto = decideComposioV111AutoReconnect(off);
  assert.equal(noAuto.allowed, false);
  assert.ok(noAuto.reason.includes('disconnected by user'));
  const on = reconnectComposioV111Connection(off, 'slack', 4000);
  assert.equal(on.status, 'reconnecting');
  assert.equal(on.disconnectedByUser, false);
  assert.equal(on.reconnectAttemptsMs.length, 1);
});

test('composio v111: auto-reconnect budget + doubling backoff, then exhausted', () => {
  const failed = { ...emptyComposioV111ConnectionEntry('github', 'none', 1000), status: 'failed' };
  const d1 = decideComposioV111AutoReconnect(failed, {}, 2000);
  assert.equal(d1.allowed, true);
  assert.equal(d1.delayMs, DEFAULT_COMPOSIO_V111_RECONNECT_POLICY.baseBackoffMs);
  assert.equal(d1.attemptsInWindow, 0);
  // 3 attempts inside the window -> exhausted.
  const tried = {
    ...failed,
    reconnectAttemptsMs: [2000, 3000, 4000],
  };
  const d2 = decideComposioV111AutoReconnect(tried, {}, 5000);
  assert.equal(d2.allowed, false);
  assert.ok(d2.reason.includes('budget exhausted'));
  // Attempts outside the window do not count.
  const old = { ...failed, reconnectAttemptsMs: [1000] };
  const d3 = decideComposioV111AutoReconnect(old, {}, 1000 + DEFAULT_COMPOSIO_V111_RECONNECT_POLICY.windowMs + 60_000);
  assert.equal(d3.allowed, true);
  assert.equal(d3.attemptsInWindow, 0);
  // Active connections never need reconnect.
  const active = emptyComposioV111ConnectionEntry('github', 'active', 1000);
  assert.equal(decideComposioV111AutoReconnect(active).allowed, false);
});

test('composio v111: lifecycle store + audit round-trip', () => {
  const dir = tmpDir();
  assert.deepEqual(loadComposioV111Connections(dir), []);
  assert.deepEqual(listComposioV111Audit(dir), []);
  const entries = [
    emptyComposioV111ConnectionEntry('github', 'active', 1000),
    disconnectComposioV111Connection(emptyComposioV111ConnectionEntry('slack', 'active', 1000), 'slack', 'user off', 2000),
  ];
  saveComposioV111Connections(dir, entries);
  const loaded = loadComposioV111Connections(dir);
  assert.equal(loaded.length, 2);
  assert.equal(loaded[1].status, 'disconnected');
  const summary = summarizeComposioV111Connections(loaded);
  assert.deepEqual(
    { total: summary.total, active: summary.active, disconnected: summary.disconnected },
    { total: 2, active: 1, disconnected: 1 },
  );
  assert.deepEqual(summary.needsAttention, [], 'user-disconnected is not attention');
  // A failed connection IS attention.
  const failed = syncComposioV111SessionStatus(emptyComposioV111ConnectionEntry('gmail', 'active', 1000), 'gmail', 'none', undefined, 2000);
  assert.deepEqual(summarizeComposioV111Connections([failed]).needsAttention, ['gmail']);
  appendComposioV111Audit(dir, createComposioV111AuditEntry('slack', 'disconnect', 'disconnected', 'user off', 2000));
  appendComposioV111Audit(dir, createComposioV111AuditEntry('github', 'connect', 'active', 'session active', 3000));
  const audit = listComposioV111Audit(dir);
  assert.equal(audit.length, 2);
  assert.equal(audit[0].action, 'connect', 'newest first');
  assert.equal(listComposioV111Audit(dir, { toolkit: 'slack' }).length, 1);
  assert.equal(listComposioV111Audit(dir, { limit: 1 }).length, 1);
  fs.writeFileSync(path.join(dir, 'composio-connections-v111.json'), '[{"toolkit": 1}]');
  assert.throws(() => loadComposioV111Connections(dir));
});

// ---------------------------------------------------------------------------
// Poll policy v111
// ---------------------------------------------------------------------------

test('composio v111: hit shrinks, miss/error grow the interval (no jitter = deterministic)', () => {
  const policy = { ...DEFAULT_COMPOSIO_V111_POLL_POLICY, jitterFraction: 0 };
  const base = emptyComposioV111PollPolicyState('gmail-new-mail', policy);
  assert.equal(base.currentIntervalMs, 15 * 60 * 1000);
  const hit = nextComposioV111Poll(base, 'hit', policy, { nowMs: 1000, random: () => 0.5 });
  assert.equal(hit.state.currentIntervalMs, 7.5 * 60 * 1000);
  assert.equal(hit.nextIntervalMs, 7.5 * 60 * 1000);
  assert.equal(hit.state.consecutiveHits, 1);
  assert.equal(hit.state.totalHits, 1);
  const miss = nextComposioV111Poll(base, 'miss', policy, { nowMs: 1000, random: () => 0.5 });
  assert.equal(miss.state.currentIntervalMs, 22.5 * 60 * 1000);
  assert.equal(miss.state.consecutiveMisses, 1);
  const err = nextComposioV111Poll(base, 'error', policy, { nowMs: 1000, error: 'boom', random: () => 0.5 });
  assert.equal(err.state.currentIntervalMs, 30 * 60 * 1000);
  assert.equal(err.state.lastError, 'boom');
  assert.equal(err.state.totalErrors, 1);
  // Interval never drops below 1 minute.
  let state = emptyComposioV111PollPolicyState('x', policy);
  for (let i = 0; i < 10; i += 1) state = nextComposioV111Poll(state, 'hit', policy, { nowMs: 1000 + i }).state;
  assert.equal(state.currentIntervalMs, 60_000);
  // ... and never grows past 6h.
  state = emptyComposioV111PollPolicyState('x', policy);
  for (let i = 0; i < 10; i += 1) state = nextComposioV111Poll(state, 'error', policy, { nowMs: 1000 + i }).state;
  assert.equal(state.currentIntervalMs, 6 * 60 * 60 * 1000);
});

test('composio v111: invalid poll policy throws fail-closed', () => {
  assert.throws(() => validateComposioV111PollPolicy({ ...DEFAULT_COMPOSIO_V111_POLL_POLICY, hitFactor: 1.5 }), /hitFactor/);
  assert.throws(() => validateComposioV111PollPolicy({ ...DEFAULT_COMPOSIO_V111_POLL_POLICY, missFactor: 0.5 }), /missFactor/);
  assert.throws(() => validateComposioV111PollPolicy({ ...DEFAULT_COMPOSIO_V111_POLL_POLICY, minIntervalMs: 0 }), /minIntervalMs/);
  assert.throws(() => validateComposioV111PollPolicy({ ...DEFAULT_COMPOSIO_V111_POLL_POLICY, jitterFraction: 1 }), /jitterFraction/);
});

test('composio v111: dedupe window forgets old ids, keeps new ones', () => {
  const policy = { ...DEFAULT_COMPOSIO_V111_POLL_POLICY, dedupeWindowMs: 60_000, jitterFraction: 0 };
  let state = emptyComposioV111PollPolicyState('gmail', policy);
  state = recordComposioV111SeenIds(state, ['a', 'b'], policy, 1000);
  assert.equal(isComposioV111Duplicate(state, 'a', policy, 2000), true);
  assert.equal(isComposioV111Duplicate(state, 'c', policy, 2000), false);
  // Recording the same id again does not duplicate it.
  state = recordComposioV111SeenIds(state, ['a'], policy, 3000);
  assert.equal(state.seenIds.length, 2);
  // After the window, the id is forgotten and can be seen again.
  assert.equal(isComposioV111Duplicate(state, 'a', policy, 1000 + 60_001), false);
  state = recordComposioV111SeenIds(state, ['a'], policy, 1000 + 60_001);
  assert.equal(state.seenIds.length, 1);
  assert.equal(state.seenIds[0].id, 'a');
});

test('composio v111: missed-poll catch-up counts whole intervals only', () => {
  const state = { ...emptyComposioV111PollPolicyState('gmail'), lastPollAtMs: 0 };
  assert.equal(missedPollsBetween(state, 15 * 60 * 1000), 0, 'one interval later = next poll, not missed');
  assert.equal(missedPollsBetween(state, 30 * 60 * 1000), 1);
  assert.equal(missedPollsBetween(state, 60 * 60 * 1000), 3);
  const summary = summarizeComposioV111CatchUp(state, 60 * 60 * 1000);
  assert.equal(summary.missedPolls, 3);
  assert.equal(summary.needsCatchUp, true);
  assert.equal(summary.sinceMs, 0);
  const never = emptyComposioV111PollPolicyState('fresh');
  assert.equal(missedPollsBetween(never, 10_000), 0);
  assert.equal(summarizeComposioV111CatchUp(never, 10_000).needsCatchUp, false);
});

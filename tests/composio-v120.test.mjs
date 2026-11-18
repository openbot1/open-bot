/**
 * Composio v120 tests (v1.20, Doi T4 — node:test, no network, no key).
 *
 * Covers:
 * - Mock toolkits v120: 4 toolkits (trello/wave/basecamp/
 *   zoho), 10 candidate slugs each, none overlapping the 40
 *   live toolkits, the 6 v13 toolkits (docusign/freshbooks/gong/
 *   lever/quickbooks/resend) or the v110/v111/v112/v114/v118/v119 mock
 *   toolkits; every toolkit is mockOnly + not live-verified and
 *   carries authKind + authNote; mock executor deterministic,
 *   echo args, mock:true/live:false; paramNames table
 * - OAuth refresh v3: error classification (revoked >
 *   invalid-grant > rate-limited > transient > unknown),
 *   per-toolkit refresh window, cycle (due/not-needed/failed
 *   isolated, urgency order), rotation saves the old token to
 *   grace, invalid_grant retries once with the previous token,
 *   revoked purges both tokens, rate-limited defers
 * - Webhook v3: signature rotation (new/old/wrong secret),
 *   future + stale timestamp rejection, replay nonce, idempotency
 *   key replay (same result, no second enqueue), bad signature,
 *   escalation after consecutive failures (once per cooldown),
 *   idempotency store round-trip (memory + JSON file)
 * - Usage metering v2: toolkit + action counters move together,
 *   blocked at cap, soft-limit warn/alert warnings (deduped),
 *   per-user quota override, report (byAction/headroom/warnings),
 *   stores round-trip
 * - Toolkit prefs v2: action toggle (default on), unknown slug
 *   rejected, default params validated against the v120
 *   param-names table, resolve merges (call wins), 3-layer
 *   effective check (machine + v119 + v2), quota views, stores
 *
 * Imports the BUILT core — build first:
 *   npm run build --workspace=@open-bot/core
 * then: node --test tests/composio-v120.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { COMPOSIO_TOOLKIT_SLUGS } from '../packages/core/dist/composio/toolkits.js';
import {
  COMPOSIO_V110_MOCK_TOOLKITS,
  mockComposioV110Slugs,
} from '../packages/core/dist/composio/toolkitsV110.js';
import { COMPOSIO_V111_MOCK_TOOLKITS } from '../packages/core/dist/composio/toolkitsV111.js';
import { COMPOSIO_V112_MOCK_TOOLKITS } from '../packages/core/dist/composio/toolkitsV112.js';
import { COMPOSIO_V114_MOCK_TOOLKITS } from '../packages/core/dist/composio/toolkitsV114.js';
import { COMPOSIO_V118_MOCK_TOOLKITS } from '../packages/core/dist/composio/toolkitsV118.js';
import { COMPOSIO_V119_MOCK_TOOLKITS } from '../packages/core/dist/composio/toolkitsV119.js';
import {
  COMPOSIO_V13_TOOLKITS,
  COMPOSIO_V13_TOOLKIT_SLUGS,
} from '../packages/core/dist/fleetV13/appsV13.js';
import {
  COMPOSIO_V120_MOCK_TOOLKITS,
  MockComposioV120Executor,
  createMockComposioV120AppDefinitions,
  executeMockComposioV120Tool,
  findMockComposioV120Toolkit,
  isMockComposioV120Slug,
  mockComposioV120ParamNames,
  mockComposioV120Slugs,
  resolveMockComposioV120Slug,
  summarizeMockComposioV120Catalogue,
} from '../packages/core/dist/composio/toolkitsV120.js';
import { createComposioV118OAuthEntry } from '../packages/core/dist/composio/oauthStateV118.js';
import { createComposioV119RefreshState } from '../packages/core/dist/composio/oauthRefreshV119.js';
import {
  attemptComposioV120Refresh,
  classifyComposioV120RefreshError,
  createComposioV120RefreshState,
  createComposioV120RefreshStatePair,
  hasComposioV120PreviousRefreshToken,
  runComposioV120RefreshCycle,
  validateComposioV120RefreshSchedule,
} from '../packages/core/dist/composio/oauthRefreshV120.js';
import {
  computeComposioWebhookSignature,
} from '../packages/core/dist/composio/triggers.js';
import {
  ComposioV120WebhookReceiver,
  JsonFileComposioV120IdempotencyStore,
  MemoryComposioV120IdempotencyStore,
  checkComposioV120TimestampSkew,
  normalizeComposioV120IdempotencyKey,
  validateComposioV120IdempotencyEntry,
  verifyComposioV120WebhookSignatureWithRotation,
} from '../packages/core/dist/composio/webhookV120.js';
import {
  JsonFileComposioV120UsageStore,
  MemoryComposioV120UsageStore,
  buildComposioV120UsageReport,
  checkComposioV120SoftLimits,
  createComposioV120UsageState,
  effectiveComposioV120QuotaForUser,
  recordComposioV120Usage,
  setComposioV120PerUserQuota,
  validateComposioV120UsageState,
} from '../packages/core/dist/composio/usageMeteringV120.js';
import {
  JsonFileComposioV120ToolkitPrefsStore,
  MemoryComposioV120ToolkitPrefsStore,
  buildComposioV120ToolkitQuotaViews,
  clearComposioV120DefaultParams,
  effectiveComposioV120ActionEnabledForUser,
  getComposioV120DefaultParams,
  isComposioV120ActionEnabledForUser,
  knownComposioV120ActionSlugs,
  listComposioV120EnabledActionsForUser,
  resolveComposioV120CallParams,
  setComposioV120ActionPref,
  setComposioV120ActionPrefsBulk,
  setComposioV120DefaultParams,
  setComposioV120ToolkitPref,
} from '../packages/core/dist/composio/toolkitPrefsV120.js';
import {
  createComposioV119UserToolkitPrefs,
  setComposioV119ToolkitPref,
} from '../packages/core/dist/composio/toolkitPrefsV119.js';

const NOW = Date.UTC(2026, 10, 16, 12, 0, 0);

/** Fake Vault (in-memory) for OAuth refresh tests. */
function makeVault() {
  const m = new Map();
  return {
    getSecret: (ns, k) => (m.has(`${ns}:${k}`) ? m.get(`${ns}:${k}`) : null),
    setSecret: (ns, k, v) => void m.set(`${ns}:${k}`, v),
    deleteSecret: (ns, k) => m.delete(`${ns}:${k}`),
    hasSecret: (ns, k) => m.has(`${ns}:${k}`),
  };
}

/** V3 envelope body for webhook tests. */
function webhookBody({ id = 'msg_test_1', slug = 'GITHUB_ISSUE_CREATED', tsSeconds, data = { issue: 1 } }) {
  return JSON.stringify({
    id,
    type: 'composio.trigger.message',
    metadata: { trigger_slug: slug, trigger_id: 'ti_test' },
    timestamp: String(tsSeconds),
    data,
  });
}

// ---------------------------------------------------------------------------
// 1. Mock toolkits v120
// ---------------------------------------------------------------------------

test('v120 mock toolkits: 4 toolkits, 40 slugs, no overlap with live or older mocks', () => {
  assert.equal(COMPOSIO_V120_MOCK_TOOLKITS.length, 4);
  const slugs = mockComposioV120Slugs();
  assert.equal(slugs.length, 40);
  assert.equal(new Set(slugs).size, 40);
  for (const t of COMPOSIO_V120_MOCK_TOOLKITS) {
    assert.equal(t.candidateToolSlugs.length, 10);
    assert.equal(t.mockOnly, true);
    assert.equal(t.liveVerified, false);
    assert.equal(t.authKind, 'oauth2');
    assert.ok(t.authNote.length > 0);
    assert.equal(isMockComposioV120Slug(t.candidateToolSlugs[0]), true);
    assert.equal(findMockComposioV120Toolkit(t.slug)?.slug, t.slug);
  }
  const older = new Set([
    ...COMPOSIO_TOOLKIT_SLUGS,
    ...COMPOSIO_V13_TOOLKIT_SLUGS,
    ...COMPOSIO_V13_TOOLKITS.flatMap((t) => t.tools.map((d) => d.action)),
    ...mockComposioV110Slugs(),
    ...COMPOSIO_V111_MOCK_TOOLKITS.flatMap((t) => t.candidateToolSlugs),
    ...COMPOSIO_V112_MOCK_TOOLKITS.flatMap((t) => t.candidateToolSlugs),
    ...COMPOSIO_V114_MOCK_TOOLKITS.flatMap((t) => t.candidateToolSlugs),
    ...COMPOSIO_V118_MOCK_TOOLKITS.flatMap((t) => t.candidateToolSlugs),
    ...COMPOSIO_V119_MOCK_TOOLKITS.flatMap((t) => t.candidateToolSlugs),
    ...COMPOSIO_V110_MOCK_TOOLKITS.flatMap((t) => t.candidateToolSlugs),
  ]);
  for (const s of slugs) assert.ok(!older.has(s), `slug overlaps an older catalog: ${s}`);
  const summary = summarizeMockComposioV120Catalogue();
  assert.equal(summary.totalToolkits, 4);
  assert.equal(summary.totalSlugs, 40);
  assert.equal(summary.writeSlugs + summary.readSlugs, 40);
  assert.ok(summary.writeSlugs > 0 && summary.readSlugs > 0);
});

test('v120 mock executor: deterministic, echo args, mock:true/live:false', () => {
  const ex = new MockComposioV120Executor();
  assert.equal(ex.listToolkits().length, 4);
  assert.equal(ex.listSlugs('trello').length, 10);
  assert.throws(() => ex.listSlugs('nope'), /Unknown mock Composio v120 toolkit/);
  for (const slug of mockComposioV120Slugs()) {
    const toolkit = COMPOSIO_V120_MOCK_TOOLKITS.find((t) => t.candidateToolSlugs.includes(slug)).slug;
    const a = executeMockComposioV120Tool(toolkit, slug, { boardId: 'b1' });
    const b = executeMockComposioV120Tool(toolkit, slug, { boardId: 'b1' });
    assert.equal(a.mock, true);
    assert.equal(a.live, false);
    assert.deepEqual(a, b);
    assert.equal(a.data.echo.boardId, 'b1');
    assert.equal(typeof a.note, 'string');
  }
  assert.throws(() => executeMockComposioV120Tool('trello', 'GMAIL_SEND_EMAIL'), /Unknown mock Composio v120 tool slug/);
  assert.throws(() => resolveMockComposioV120Slug('nope', 'TRELLO_LIST_BOARDS'), /Unknown mock Composio v120 toolkit/);
  const defs = createMockComposioV120AppDefinitions();
  assert.equal(defs.length, 4);
  assert.ok(defs[0].description.includes('[MOCK]'));
  assert.equal(defs[0].tools.length, 10);
});

test('v120 param names: trello create-card expects listId/name/description', () => {
  assert.deepEqual([...mockComposioV120ParamNames('TRELLO_CREATE_CARD')], ['listId', 'name', 'description']);
  assert.deepEqual([...mockComposioV120ParamNames('ZOHO_GET_COMPANY_INFO')], []);
  assert.equal(mockComposioV120ParamNames('GMAIL_SEND_EMAIL'), undefined);
});

// ---------------------------------------------------------------------------
// 2. OAuth refresh v3
// ---------------------------------------------------------------------------

test('v120 refresh error classification: revoked > invalid-grant > rate-limited > transient', () => {
  assert.equal(classifyComposioV120RefreshError('provider revoked access'), 'revoked');
  assert.equal(classifyComposioV120RefreshError('invalid_grant: token expired'), 'invalid-grant');
  assert.equal(classifyComposioV120RefreshError('rate limit exceeded 429'), 'rate-limited');
  assert.equal(classifyComposioV120RefreshError('request timeout after 5000ms'), 'transient');
  assert.equal(classifyComposioV120RefreshError('something completely new'), 'unknown');
  assert.equal(classifyComposioV120RefreshError('REVOKED by user'), 'revoked');
});

test('v120 refresh schedule: per-toolkit window + validation', () => {
  const s = validateComposioV120RefreshSchedule({ perToolkitRefreshBeforeExpiryMs: { gmail: 600_000 } });
  assert.equal(s.perToolkitRefreshBeforeExpiryMs.gmail, 600_000);
  assert.equal(s.defaultRefreshBeforeExpiryMs, 5 * 60 * 1000);
  assert.throws(() => validateComposioV120RefreshSchedule({ scheduleJitterMs: -1 }), /scheduleJitterMs/);
  assert.throws(() => validateComposioV120RefreshSchedule({ perToolkitRefreshBeforeExpiryMs: { gmail: -5 } }), /non-negative/);
  assert.throws(() => validateComposioV120RefreshSchedule({ maxConnectionsPerCycle: -1 }), /maxConnectionsPerCycle/);
});

test('v120 refresh: not-needed when token is still valid', async () => {
  const vault = makeVault();
  vault.setSecret('composio-oauth-refresh', 'c1', 'tok-1');
  const oauth = createComposioV118OAuthEntry('c1', 'gmail', { state: 'connected', expiresAtMs: NOW + 86_400_000, nowMs: NOW });
  const pair = createComposioV120RefreshStatePair('c1', 'gmail');
  let calls = 0;
  const r = await attemptComposioV120Refresh(oauth, pair.refreshV2, pair.refreshV3, {
    vault,
    refreshFn: async () => { calls += 1; return { newExpiresAtMs: NOW + 3600_000 }; },
    schedule: { scheduleJitterMs: 0 },
    nowMs: NOW,
  });
  assert.equal(r.outcome, 'not-needed');
  assert.equal(r.attempts, 0);
  assert.equal(calls, 0);
});

test('v120 refresh: rotation saves the old token to grace', async () => {
  const vault = makeVault();
  vault.setSecret('composio-oauth-refresh', 'c1', 'tok-old');
  const oauth = createComposioV118OAuthEntry('c1', 'gmail', { state: 'connected', expiresAtMs: NOW + 60_000, nowMs: NOW });
  const pair = createComposioV120RefreshStatePair('c1', 'gmail');
  const r = await attemptComposioV120Refresh(oauth, pair.refreshV2, pair.refreshV3, {
    vault,
    refreshFn: async () => ({ newExpiresAtMs: NOW + 3600_000, newRefreshToken: 'tok-new' }),
    schedule: { scheduleJitterMs: 0 },
    nowMs: NOW,
  });
  assert.equal(r.outcome, 'refreshed');
  assert.equal(r.usedPreviousToken, false);
  assert.equal(r.oauth.expiresAtMs, NOW + 3600_000);
  assert.equal(vault.getSecret('composio-oauth-refresh', 'c1'), 'tok-new');
  assert.equal(hasComposioV120PreviousRefreshToken(vault, 'c1'), true);
  assert.equal(vault.getSecret('composio-oauth-refresh', 'c1:previous-v120'), 'tok-old');
  assert.equal(r.refreshV3.previousTokenExpiresAtMs, NOW + 10 * 60 * 1000);
});

test('v120 refresh: invalid_grant retries once with the previous (grace) token', async () => {
  const vault = makeVault();
  vault.setSecret('composio-oauth-refresh', 'c1', 'tok-new');
  vault.setSecret('composio-oauth-refresh', 'c1:previous-v120', 'tok-old');
  const oauth = createComposioV118OAuthEntry('c1', 'gmail', { state: 'connected', expiresAtMs: NOW + 60_000, nowMs: NOW });
  const v2 = createComposioV119RefreshState('c1', 'gmail');
  const v3 = { ...createComposioV120RefreshState('c1'), previousTokenExpiresAtMs: NOW + 600_000 };
  const seen = [];
  const r = await attemptComposioV120Refresh(oauth, v2, v3, {
    vault,
    refreshFn: async (_id, token) => {
      seen.push(token);
      if (token === 'tok-old') return { newExpiresAtMs: NOW + 3600_000 };
      throw new Error('invalid_grant: refresh token expired');
    },
    schedule: { scheduleJitterMs: 0 },
    policy: { maxAttempts: 1 },
    nowMs: NOW,
  });
  assert.equal(r.outcome, 'refreshed');
  assert.equal(r.usedPreviousToken, true);
  assert.deepEqual(seen, ['tok-new', 'tok-old']);
  assert.equal(vault.getSecret('composio-oauth-refresh', 'c1'), 'tok-old');
  assert.equal(hasComposioV120PreviousRefreshToken(vault, 'c1'), false);
});

test('v120 refresh: revoked purges current + grace tokens', async () => {
  const vault = makeVault();
  vault.setSecret('composio-oauth-refresh', 'c1', 'tok-now');
  vault.setSecret('composio-oauth-refresh', 'c1:previous-v120', 'tok-old');
  const oauth = createComposioV118OAuthEntry('c1', 'gmail', { state: 'connected', expiresAtMs: NOW + 60_000, nowMs: NOW });
  const pair = createComposioV120RefreshStatePair('c1', 'gmail');
  const r = await attemptComposioV120Refresh(oauth, pair.refreshV2, pair.refreshV3, {
    vault,
    refreshFn: async () => ({ newExpiresAtMs: NOW + 3600_000, revoked: true }),
    schedule: { scheduleJitterMs: 0 },
    nowMs: NOW,
  });
  assert.equal(r.outcome, 'revoked');
  assert.equal(r.errorKind, 'revoked');
  assert.equal(r.oauth.state, 'revoked');
  assert.equal(r.refreshV2.needsReconnect, true);
  assert.equal(vault.hasSecret('composio-oauth-refresh', 'c1'), false);
  assert.equal(hasComposioV120PreviousRefreshToken(vault, 'c1'), false);
});

test('v120 refresh: rate-limited defers the next attempt', async () => {
  const vault = makeVault();
  vault.setSecret('composio-oauth-refresh', 'c1', 'tok-1');
  const oauth = createComposioV118OAuthEntry('c1', 'gmail', { state: 'connected', expiresAtMs: NOW + 60_000, nowMs: NOW });
  const pair = createComposioV120RefreshStatePair('c1', 'gmail');
  const deps = {
    vault,
    refreshFn: async () => { throw new Error('rate limit exceeded (429)'); },
    schedule: { scheduleJitterMs: 0 },
    policy: { maxAttempts: 1 },
    nowMs: NOW,
  };
  const r1 = await attemptComposioV120Refresh(oauth, pair.refreshV2, pair.refreshV3, deps);
  assert.equal(r1.outcome, 'failed');
  assert.equal(r1.errorKind, 'rate-limited');
  assert.ok(r1.refreshV3.rateLimitedUntilMs > NOW);
  const r2 = await attemptComposioV120Refresh(r1.oauth, r1.refreshV2, r1.refreshV3, deps);
  assert.equal(r2.outcome, 'failed');
  assert.equal(r2.attempts, 0);
  assert.equal(r2.errorKind, 'rate-limited');
});

test('v120 refresh cycle: isolates failures, orders by urgency', async () => {
  const vault = makeVault();
  for (const id of ['a', 'b', 'c']) vault.setSecret('composio-oauth-refresh', id, `tok-${id}`);
  const mk = (id, expiresAtMs) => ({
    oauth: createComposioV118OAuthEntry(id, 'gmail', { state: 'connected', expiresAtMs, nowMs: NOW }),
    ...(() => { const p = createComposioV120RefreshStatePair(id, 'gmail'); return { refreshV2: p.refreshV2, refreshV3: p.refreshV3 }; })(),
  });
  const conns = [
    mk('a', NOW + 60_000), // due, refreshes
    mk('b', NOW + 86_400_000), // not needed
    mk('c', NOW + 60_000), // due, fails transiently
  ];
  const cycle = await runComposioV120RefreshCycle(conns, {
    vault,
    refreshFn: async (id) => {
      if (id === 'c') throw new Error('request timeout');
      return { newExpiresAtMs: NOW + 3600_000 };
    },
    schedule: { scheduleJitterMs: 0 },
    policy: { maxAttempts: 1 },
    nowMs: NOW,
  });
  assert.equal(cycle.checked, 3);
  assert.equal(cycle.refreshed, 1);
  assert.equal(cycle.notNeeded, 1);
  assert.equal(cycle.failed, 1);
  assert.equal(cycle.needsReconnect, 0);
  assert.equal(cycle.results[2].outcome, 'not-needed');
  assert.equal(typeof cycle.cycleId, 'string');
});

// ---------------------------------------------------------------------------
// 3. Webhook v3
// ---------------------------------------------------------------------------

test('v120 webhook: signature rotation tries new then old secret', () => {
  const body = webhookBody({ tsSeconds: Math.floor(NOW / 1000) });
  const sigNew = computeComposioWebhookSignature('secret-new', 'wh_1', String(Math.floor(NOW / 1000)), body);
  const sigOld = computeComposioWebhookSignature('secret-old', 'wh_1', String(Math.floor(NOW / 1000)), body);
  const sigBad = computeComposioWebhookSignature('secret-nope', 'wh_1', String(Math.floor(NOW / 1000)), body);
  const opts = { now: new Date(NOW) };
  assert.equal(verifyComposioV120WebhookSignatureWithRotation(['secret-new', 'secret-old'], 'wh_1', String(Math.floor(NOW / 1000)), body, sigNew, opts), 0);
  assert.equal(verifyComposioV120WebhookSignatureWithRotation(['secret-new', 'secret-old'], 'wh_1', String(Math.floor(NOW / 1000)), body, sigOld, opts), 1);
  assert.equal(verifyComposioV120WebhookSignatureWithRotation(['secret-new', 'secret-old'], 'wh_1', String(Math.floor(NOW / 1000)), body, sigBad, opts), -1);
  assert.equal(verifyComposioV120WebhookSignatureWithRotation([], 'wh_1', String(Math.floor(NOW / 1000)), body, sigNew, opts), -1);
});

test('v120 webhook: timestamp skew rejects stale and future events', () => {
  assert.equal(checkComposioV120TimestampSkew(NOW - 20 * 60 * 1000, NOW, 10 * 60 * 1000, 5 * 60 * 1000), 'stale');
  assert.equal(checkComposioV120TimestampSkew(NOW + 10 * 60 * 1000, NOW, 10 * 60 * 1000, 5 * 60 * 1000), 'future');
  assert.equal(checkComposioV120TimestampSkew(NOW - 60_000, NOW, 10 * 60 * 1000, 5 * 60 * 1000), null);
  assert.equal(checkComposioV120TimestampSkew(null, NOW, 10 * 60 * 1000, 5 * 60 * 1000), null);
});

test('v120 webhook: receiver accepts, then replay nonce + idempotency replay', () => {
  const nowFn = () => NOW;
  const r = new ComposioV120WebhookReceiver({ now: nowFn, config: { retryJitterFraction: 0 } });
  const ts = String(Math.floor(NOW / 1000));
  const body1 = webhookBody({ id: 'msg_1', tsSeconds: Math.floor(NOW / 1000) });
  const first = r.accept({ rawBody: body1, deliveryId: 'wh_1', timestamp: ts, idempotencyKey: 'idem-1', receivedAtMs: NOW });
  assert.equal(first.accepted, true);
  assert.ok(first.event);
  // Same delivery again -> replay nonce (same deliveryId + timestamp + body).
  const nonceReplay = r.accept({ rawBody: body1, deliveryId: 'wh_1', timestamp: ts, receivedAtMs: NOW });
  assert.equal(nonceReplay.accepted, false);
  assert.equal(nonceReplay.reason, 'replay-nonce');
  // Same idempotency key, different delivery -> returns the stored result, no second enqueue.
  const body2 = webhookBody({ id: 'msg_2', tsSeconds: Math.floor(NOW / 1000), data: { issue: 2 } });
  const idemReplay = r.accept({ rawBody: body2, deliveryId: 'wh_2', timestamp: ts, idempotencyKey: 'idem-1', receivedAtMs: NOW });
  assert.equal(idemReplay.accepted, true);
  assert.equal(idemReplay.idempotentReplay, true);
  assert.equal(r.getQueue().listEvents().length, 1);
  const s = r.summarize();
  assert.equal(s.replayNonces, 1);
  assert.equal(s.idempotentReplays, 1);
});

test('v120 webhook: future timestamp, stale event, bad signature, bad idempotency key', () => {
  const r = new ComposioV120WebhookReceiver({ now: () => NOW, secrets: ['secret-1'], config: { retryJitterFraction: 0 } });
  const future = r.accept({ rawBody: webhookBody({ tsSeconds: Math.floor(NOW / 1000) + 3600 }), receivedAtMs: NOW });
  assert.equal(future.accepted, false);
  assert.equal(future.reason, 'future-timestamp');
  const stale = r.accept({ rawBody: webhookBody({ tsSeconds: Math.floor(NOW / 1000) - 3600 }), receivedAtMs: NOW });
  assert.equal(stale.accepted, false);
  assert.equal(stale.reason, 'stale-event');
  const ts = String(Math.floor(NOW / 1000));
  const body = webhookBody({ tsSeconds: Math.floor(NOW / 1000) });
  const badSig = r.accept({ rawBody: body, signature: 'v1,bogus', deliveryId: 'wh_9', timestamp: ts, receivedAtMs: NOW });
  assert.equal(badSig.accepted, false);
  assert.equal(badSig.reason, 'bad-signature');
  assert.equal(badSig.verifiedKeyIndex, -1);
  const badKey = r.accept({ rawBody: body, deliveryId: 'wh_10', timestamp: ts, idempotencyKey: 'x'.repeat(300), receivedAtMs: NOW });
  assert.equal(badKey.accepted, false);
  assert.equal(badKey.reason, 'bad-idempotency-key');
  assert.equal(normalizeComposioV120IdempotencyKey('  abc  '), 'abc');
  assert.equal(normalizeComposioV120IdempotencyKey(''), null);
  assert.throws(() => normalizeComposioV120IdempotencyKey('y'.repeat(300)), /at most/);
});

test('v120 webhook: escalation fires once per cooldown after consecutive failures', async () => {
  const escalations = [];
  const r = new ComposioV120WebhookReceiver({
    now: () => NOW,
    config: { retryJitterFraction: 0, escalationAfterFailures: 2, escalationCooldownMs: 60 * 60 * 1000 },
    onEscalate: (e) => void escalations.push(e),
  });
  const ts = String(Math.floor(NOW / 1000));
  r.accept({ rawBody: webhookBody({ id: 'msg_e1', tsSeconds: Math.floor(NOW / 1000) }), deliveryId: 'wh_e1', timestamp: ts, receivedAtMs: NOW });
  const failing = async () => { throw new Error('handler boom'); };
  assert.equal(await r.drain(failing, NOW), 1);
  assert.equal(escalations.length, 0);
  assert.equal(await r.drain(failing, NOW + 60_000), 1);
  assert.equal(escalations.length, 1);
  assert.equal(escalations[0].triggerSlug, 'GITHUB_ISSUE_CREATED');
  assert.equal(escalations[0].consecutiveFailures, 2);
  // Third failure inside the cooldown does not escalate again.
  assert.equal(await r.drain(failing, NOW + 120_000), 1);
  assert.equal(escalations.length, 1);
  assert.equal(r.getQueue().listDeadLetters().length, 1);
});

test('v120 webhook: idempotency store round-trip (memory + JSON file)', () => {
  const entry = validateComposioV120IdempotencyEntry({ key: 'k1', accepted: true, reason: null, queueId: 'q1', atMs: NOW });
  assert.equal(entry.key, 'k1');
  assert.throws(() => validateComposioV120IdempotencyEntry({ key: '', accepted: true, reason: null, queueId: null, atMs: 1 }), /key/);
  const mem = new MemoryComposioV120IdempotencyStore();
  mem.save([entry]);
  assert.deepEqual(mem.load(), [entry]);
  const dir = mkdtempSync(join(tmpdir(), 'composio-v120-idem-'));
  try {
    const file = new JsonFileComposioV120IdempotencyStore(dir);
    assert.deepEqual(file.load(), []);
    file.save([entry]);
    assert.deepEqual(file.load(), [entry]);
    assert.throws(() => file.save([{ ...entry, key: '' }]), /key/);
    file.clear();
    assert.deepEqual(file.load(), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 4. Usage metering v2
// ---------------------------------------------------------------------------

function smallUsageState() {
  return createComposioV120UsageState(
    { dailyCapPerToolkit: 10, dailyCapPerUser: 100, dailyCapGlobal: 1000 },
    { thresholds: { warnAt: 0.7, alertAt: 0.9 } },
  );
}

test('v120 usage: toolkit + action counters move together, blocked at cap', () => {
  let state = smallUsageState();
  for (let i = 0; i < 10; i += 1) {
    const r = recordComposioV120Usage(state, { userId: 'u1', toolkit: 'gmail', slug: 'GMAIL_SEND_EMAIL', succeeded: true, mock: true }, NOW);
    state = r.state;
    assert.equal(r.result.allowed, true);
  }
  assert.equal(state.toolkitCounters[0].calls, 10);
  assert.equal(state.actionCounters[0].calls, 10);
  assert.equal(state.actionCounters[0].mockCalls, 10);
  const blocked = recordComposioV120Usage(state, { userId: 'u1', toolkit: 'gmail', slug: 'GMAIL_SEND_EMAIL', succeeded: true, mock: true }, NOW);
  assert.equal(blocked.result.allowed, false);
  assert.equal(blocked.result.blockedBy, 'toolkit');
  assert.equal(blocked.result.toolkitCounter.blocked, 1);
  assert.equal(blocked.result.actionCounter.blocked, 1);
  assert.equal(blocked.result.toolkitCounter.calls, 10);
  const limits = checkComposioV120SoftLimits(blocked.state, 'u1', 'gmail', NOW);
  assert.equal(limits[0].level, 'toolkit');
  assert.equal(limits[0].severity, 'blocked');
  assert.equal(limits[0].remaining, 0);
});

test('v120 usage: soft-limit warn at 70% and alert at 90%, deduped per day', () => {
  let state = smallUsageState();
  let warns = 0;
  let alerts = 0;
  for (let i = 0; i < 9; i += 1) {
    const r = recordComposioV120Usage(state, { userId: 'u1', toolkit: 'gmail', slug: 'GMAIL_LIST_THREADS', succeeded: true, mock: false }, NOW);
    state = r.state;
    warns += r.result.newWarnings.filter((w) => w.severity === 'warn').length;
    alerts += r.result.newWarnings.filter((w) => w.severity === 'alert').length;
  }
  assert.equal(warns, 1);
  assert.equal(alerts, 1);
  assert.equal(state.warnings.length, 2);
  // One more call: no new warning (same severities already fired today).
  const again = recordComposioV120Usage(state, { userId: 'u1', toolkit: 'gmail', slug: 'GMAIL_LIST_THREADS', succeeded: true, mock: false }, NOW);
  assert.equal(again.result.newWarnings.length, 0);
});

test('v120 usage: per-user quota override + report + stores', () => {
  let state = smallUsageState();
  state = setComposioV120PerUserQuota(state, 'u2', { dailyCapPerToolkit: 2 });
  assert.equal(effectiveComposioV120QuotaForUser(state, 'u2').dailyCapPerToolkit, 2);
  assert.equal(effectiveComposioV120QuotaForUser(state, 'u1').dailyCapPerToolkit, 10);
  for (let i = 0; i < 2; i += 1) {
    const r = recordComposioV120Usage(state, { userId: 'u2', toolkit: 'slack', slug: 'SLACK_POST_MESSAGE', succeeded: false, mock: true }, NOW);
    state = r.state;
    assert.equal(r.result.allowed, true);
  }
  const third = recordComposioV120Usage(state, { userId: 'u2', toolkit: 'slack', slug: 'SLACK_POST_MESSAGE', succeeded: true, mock: true }, NOW);
  assert.equal(third.result.allowed, false);
  assert.equal(third.result.blockedBy, 'toolkit');
  const report = buildComposioV120UsageReport(third.state, { day: '2026-11-16', nowMs: NOW });
  assert.equal(report.totalCalls, 2);
  assert.equal(report.totalFailed, 2);
  assert.equal(report.byAction[0].slug, 'SLACK_POST_MESSAGE');
  assert.equal(report.byAction[0].calls, 2);
  assert.equal(report.byAction[0].failureRate, 1);
  assert.equal(report.headroom[0].toolkit, 'slack');
  // Headroom cua bao cao dung quota chung (cap 10): user u2 bi
  // chan boi override rieng (cap 2) chu khong phai quota chung.
  assert.equal(report.headroom[0].used, 2);
  assert.equal(report.headroom[0].cap, 10);
  assert.equal(report.headroom[0].remaining, 8);
  assert.equal(report.headroom[0].severity, 'ok');
  // Luot thu 2 cua u2 dat dung cap override (ratio 1.0 =
  // 'blocked') nen khong sinh warning warn/alert.
  assert.equal(report.warnings.length, 0);
  state = setComposioV120PerUserQuota(state, 'u2', null);
  assert.equal(effectiveComposioV120QuotaForUser(state, 'u2').dailyCapPerToolkit, 10);
  assert.throws(() => validateComposioV120UsageState({ ...state, version: 99 }), /unsupported usage v2 state version/);

  const mem = new MemoryComposioV120UsageStore({ dailyCapPerToolkit: 10, dailyCapPerUser: 100, dailyCapGlobal: 1000 });
  mem.save(third.state);
  assert.equal(mem.load().actionCounters[0].calls, 2);
  const dir = mkdtempSync(join(tmpdir(), 'composio-v120-usage-'));
  try {
    const file = new JsonFileComposioV120UsageStore(dir);
    file.save(third.state);
    assert.equal(file.load().actionCounters[0].slug, 'SLACK_POST_MESSAGE');
    file.clear();
    assert.equal(file.load().actionCounters.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 5. Toolkit prefs v2
// ---------------------------------------------------------------------------

test('v120 prefs: action toggle defaults on, unknown slug rejected', () => {
  assert.deepEqual(knownComposioV120ActionSlugs('gmail').slice(0, 3), ['GMAIL_FETCH_EMAILS', 'GMAIL_SEND_EMAIL', 'GMAIL_LIST_THREADS']);
  assert.ok(knownComposioV120ActionSlugs('trello').includes('TRELLO_CREATE_CARD'));
  assert.deepEqual(knownComposioV120ActionSlugs('no-such-toolkit'), []);
  let prefs;
  assert.equal(isComposioV120ActionEnabledForUser(prefs, 'gmail', 'GMAIL_SEND_EMAIL'), true);
  prefs = setComposioV120ActionPref(prefs, 'u1', 'gmail', 'GMAIL_SEND_EMAIL', false, NOW);
  assert.equal(isComposioV120ActionEnabledForUser(prefs, 'gmail', 'GMAIL_SEND_EMAIL'), false);
  assert.equal(isComposioV120ActionEnabledForUser(prefs, 'gmail', 'GMAIL_FETCH_EMAILS'), true);
  assert.deepEqual(listComposioV120EnabledActionsForUser(prefs, 'gmail'), knownComposioV120ActionSlugs('gmail').filter((s) => s !== 'GMAIL_SEND_EMAIL'));
  assert.throws(() => setComposioV120ActionPref(prefs, 'u1', 'gmail', 'NOT_A_SLUG', false, NOW), /unknown action slug/);
  assert.throws(() => setComposioV120ActionPref(prefs, 'u1', 'gmail', 'TRELLO_CREATE_CARD', false, NOW), /unknown action slug/);
  const bulk = setComposioV120ActionPrefsBulk(prefs, 'u1', 'gmail', ['GMAIL_SEND_EMAIL', 'GMAIL_FETCH_EMAILS'], true, NOW);
  assert.equal(bulk.changed, 1);
  assert.equal(isComposioV120ActionEnabledForUser(bulk.prefs, 'gmail', 'GMAIL_SEND_EMAIL'), true);
});

test('v120 prefs: default params validated against the v120 param table, call wins on merge', () => {
  let prefs;
  prefs = setComposioV120DefaultParams(prefs, 'u1', 'trello', 'TRELLO_CREATE_CARD', { listId: 'list-1', name: 'Inbox' }, NOW);
  assert.deepEqual(getComposioV120DefaultParams(prefs, 'trello', 'TRELLO_CREATE_CARD'), { listId: 'list-1', name: 'Inbox' });
  assert.throws(
    () => setComposioV120DefaultParams(prefs, 'u1', 'trello', 'TRELLO_CREATE_CARD', { bogusParam: 1 }, NOW),
    /unknown default param bogusParam for TRELLO_CREATE_CARD/,
  );
  assert.throws(
    () => setComposioV120DefaultParams(prefs, 'u1', 'trello', 'TRELLO_CREATE_CARD', { listId: () => 'x' }, NOW),
    /must be a JSON value/,
  );
  const merged = resolveComposioV120CallParams(prefs, 'trello', 'TRELLO_CREATE_CARD', { name: 'Urgent' });
  assert.deepEqual(merged, { listId: 'list-1', name: 'Urgent' });
  const cleared = clearComposioV120DefaultParams(prefs, 'u1', 'trello', 'TRELLO_CREATE_CARD', NOW);
  assert.equal(cleared.cleared, true);
  assert.deepEqual(getComposioV120DefaultParams(cleared.prefs, 'trello', 'TRELLO_CREATE_CARD'), {});
  assert.equal(clearComposioV120DefaultParams(cleared.prefs, 'u1', 'trello', 'TRELLO_CREATE_CARD', NOW).cleared, false);
});

test('v120 prefs: effective check merges machine + v119 + v2 layers', () => {
  let v120;
  v120 = setComposioV120ActionPref(v120, 'u1', 'gmail', 'GMAIL_SEND_EMAIL', false, NOW);
  let v119 = createComposioV119UserToolkitPrefs('u1');
  assert.equal(effectiveComposioV120ActionEnabledForUser(v120, v119, 'gmail', 'GMAIL_SEND_EMAIL'), false);
  assert.equal(effectiveComposioV120ActionEnabledForUser(undefined, v119, 'gmail', 'GMAIL_SEND_EMAIL'), true);
  v119 = setComposioV119ToolkitPref(v119, 'u1', 'gmail', false, null, NOW);
  assert.equal(effectiveComposioV120ActionEnabledForUser(undefined, v119, 'gmail', 'GMAIL_FETCH_EMAILS'), false);
  assert.equal(effectiveComposioV120ActionEnabledForUser(undefined, v119, 'gmail', 'GMAIL_FETCH_EMAILS', false), false);
  assert.equal(effectiveComposioV120ActionEnabledForUser(undefined, createComposioV119UserToolkitPrefs('u1'), 'gmail', 'GMAIL_FETCH_EMAILS', false), false);
  const off = setComposioV120ToolkitPref(undefined, 'u1', 'gmail', false, 'not using', NOW);
  assert.equal(isComposioV120ActionEnabledForUser(off, 'gmail', 'GMAIL_FETCH_EMAILS'), false);
});

test('v120 prefs: quota views join usage + prefs, stores round-trip', () => {
  let usage = smallUsageState();
  for (let i = 0; i < 8; i += 1) {
    usage = recordComposioV120Usage(usage, { userId: 'u1', toolkit: 'gmail', slug: 'GMAIL_SEND_EMAIL', succeeded: true, mock: true }, NOW).state;
  }
  const views = buildComposioV120ToolkitQuotaViews(usage, { userId: 'u1', toolkits: ['gmail', 'slack'], nowMs: NOW });
  assert.equal(views.length, 2);
  assert.equal(views[0].toolkit, 'gmail');
  assert.equal(views[0].used, 8);
  assert.equal(views[0].cap, 10);
  assert.equal(views[0].remaining, 2);
  assert.equal(views[0].severity, 'warn');
  assert.equal(views[0].topActions[0].slug, 'GMAIL_SEND_EMAIL');
  assert.equal(views[0].topActions[0].calls, 8);
  assert.equal(views[0].disabledByPrefs, false);
  assert.equal(views[1].used, 0);
  assert.equal(views[1].severity, 'ok');
  const v120off = setComposioV120ToolkitPref(undefined, 'u1', 'slack', false, null, NOW);
  const views2 = buildComposioV120ToolkitQuotaViews(usage, { userId: 'u1', toolkits: ['slack'], v120Prefs: v120off, nowMs: NOW });
  assert.equal(views2[0].disabledByPrefs, true);

  let prefs = setComposioV120ActionPref(undefined, 'u1', 'gmail', 'GMAIL_SEND_EMAIL', false, NOW);
  const mem = new MemoryComposioV120ToolkitPrefsStore();
  mem.save([prefs]);
  assert.equal(mem.load()[0].toolkits[0].actions[0].slug, 'GMAIL_SEND_EMAIL');
  const dir = mkdtempSync(join(tmpdir(), 'composio-v120-prefs-'));
  try {
    const file = new JsonFileComposioV120ToolkitPrefsStore(dir);
    assert.deepEqual(file.load(), []);
    file.save([prefs]);
    prefs = file.load()[0];
    assert.equal(prefs.toolkits[0].actions[0].enabled, false);
    file.clear();
    assert.deepEqual(file.load(), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

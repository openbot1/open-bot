/**
 * Composio v119 tests — OAuth refresh v2 (v1.19, Doi T4 — node:test,
 * no network, no real key).
 *
 * Covers oauthRefreshV119.ts (mock refresh function + mock Vault —
 * never a real Composio call, never a real token):
 * - Refresh policy validation + defaults, retry delay
 *   (exponential, capped, jitter)
 * - Vault helpers: set/has/delete refresh token (boolean-only
 *   reads, no value is ever returned), input validation
 * - Refresh state create/validate, due decision (expiry window,
 *   retry schedule, revoked / needs-reconnect never refresh)
 * - attemptComposioV119Refresh: not-needed, no-token, refreshed
 *   (+ rotation), refreshed without rotation, revoked (token
 *   deleted), fail-then-recover, exhausted (retry schedule +
 *   reconnect fallback after 3 consecutive failures), invalid
 *   expiry treated as failure, connectionId mismatch throws
 * - resetComposioV119Refresh, summary text, audit entries
 *
 * Imports the BUILT core — build first:
 *   npm run build --workspace=@open-bot/core
 * then: node --test tests/composio-v119-oauth-refresh.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  COMPOSIO_V119_DEFAULT_MAX_CONSECUTIVE_FAILURES,
  COMPOSIO_V119_DEFAULT_MAX_REFRESH_ATTEMPTS,
  COMPOSIO_V119_OAUTH_REFRESH_NAMESPACE,
  DEFAULT_COMPOSIO_V119_REFRESH_POLICY,
  attemptComposioV119Refresh,
  composioV119RefreshDelayMs,
  createComposioV119RefreshAuditEntry,
  createComposioV119RefreshState,
  deleteComposioV119RefreshToken,
  hasComposioV119RefreshToken,
  isComposioV119RefreshDue,
  resetComposioV119Refresh,
  setComposioV119RefreshToken,
  summarizeComposioV119Refresh,
  validateComposioV119RefreshAuditEntry,
  validateComposioV119RefreshPolicy,
  validateComposioV119RefreshState,
} from '../packages/core/dist/composio/oauthRefreshV119.js';
import { createComposioV118OAuthEntry } from '../packages/core/dist/composio/oauthStateV118.js';

const NOW = 1780000000000; // 2026-05-28T20:26:40Z
const NS = COMPOSIO_V119_OAUTH_REFRESH_NAMESPACE;

/** In-memory fake Vault (mock only — holds fixture strings, never real tokens). */
class MockVault {
  constructor() {
    this.secrets = new Map();
  }

  getSecret(namespace, key) {
    return this.secrets.get(`${namespace}:${key}`) ?? null;
  }

  setSecret(namespace, key, value) {
    this.secrets.set(`${namespace}:${key}`, value);
  }

  deleteSecret(namespace, key) {
    return this.secrets.delete(`${namespace}:${key}`);
  }

  hasSecret(namespace, key) {
    return this.secrets.has(`${namespace}:${key}`);
  }
}

function makeOauth(over = {}) {
  return createComposioV118OAuthEntry('ca_1', 'gmail', {
    state: 'connected',
    expiresAtMs: NOW + 60_000, // expiring soon → refresh is due
    nowMs: NOW,
    ...over,
  });
}

function makeRefresh(over = {}) {
  return { ...createComposioV119RefreshState('ca_1', 'gmail'), ...over };
}

/** Policy override for fast deterministic tests (no jitter). */
const FAST_POLICY = {
  maxAttempts: 2,
  retryDelayMs: 100,
  backoffMultiplier: 2,
  maxRetryDelayMs: 1000,
  refreshBeforeExpiryMs: 300_000,
  maxConsecutiveFailures: 3,
  jitterFraction: 0,
};

test('v119 oauth refresh: policy defaults + validation', () => {
  assert.equal(COMPOSIO_V119_DEFAULT_MAX_REFRESH_ATTEMPTS, 3);
  assert.equal(COMPOSIO_V119_DEFAULT_MAX_CONSECUTIVE_FAILURES, 3);
  assert.equal(NS, 'composio-oauth-refresh');
  const p = validateComposioV119RefreshPolicy(undefined);
  assert.equal(p.maxAttempts, 3);
  assert.equal(p.retryDelayMs, 5000);
  assert.equal(p.backoffMultiplier, 2);
  assert.equal(p.maxRetryDelayMs, 300_000);
  assert.equal(p.refreshBeforeExpiryMs, 300_000);
  assert.equal(p.maxConsecutiveFailures, 3);
  assert.equal(p.jitterFraction, 0.1);
  assert.deepEqual(DEFAULT_COMPOSIO_V119_REFRESH_POLICY, p);
  assert.throws(() => validateComposioV119RefreshPolicy({ maxAttempts: 0 }), /maxAttempts must be a positive integer/);
  assert.throws(() => validateComposioV119RefreshPolicy({ retryDelayMs: -1 }), /non-negative integer/);
  assert.throws(() => validateComposioV119RefreshPolicy({ backoffMultiplier: 0.9 }), /backoffMultiplier/);
  assert.throws(
    () => validateComposioV119RefreshPolicy({ retryDelayMs: 5000, maxRetryDelayMs: 1000 }),
    /maxRetryDelayMs must be an integer >= retryDelayMs/,
  );
  assert.throws(() => validateComposioV119RefreshPolicy({ maxConsecutiveFailures: 0 }), /maxConsecutiveFailures/);
  assert.throws(() => validateComposioV119RefreshPolicy({ jitterFraction: 0.51 }), /jitterFraction/);
});

test('v119 oauth refresh: retry delay is exponential + capped + jittered', () => {
  const p = validateComposioV119RefreshPolicy({ ...FAST_POLICY, jitterFraction: 0 });
  assert.equal(composioV119RefreshDelayMs(0, p, () => 0.5), 100);
  assert.equal(composioV119RefreshDelayMs(1, p, () => 0.5), 200);
  assert.equal(composioV119RefreshDelayMs(5, p, () => 0.5), 1000, 'capped at maxRetryDelayMs');
  assert.throws(() => composioV119RefreshDelayMs(-1, p), /non-negative integer/);
  const j = validateComposioV119RefreshPolicy({ ...FAST_POLICY, jitterFraction: 0.1 });
  assert.equal(composioV119RefreshDelayMs(0, j, () => 0.5), 100);
  assert.equal(composioV119RefreshDelayMs(0, j, () => 0), 90);
  assert.equal(composioV119RefreshDelayMs(0, j, () => 1), 110);
});

test('v119 oauth refresh: Vault helpers (boolean-only reads)', () => {
  const vault = new MockVault();
  assert.equal(hasComposioV119RefreshToken(vault, 'ca_1'), false);
  setComposioV119RefreshToken(vault, 'ca_1', 'mock-refresh-token-1');
  assert.equal(hasComposioV119RefreshToken(vault, 'ca_1'), true);
  // The getter never returns the value — only existence is observable.
  assert.equal(vault.getSecret(NS, 'ca_1'), 'mock-refresh-token-1', 'fixture lives in the mock vault only');
  assert.equal(deleteComposioV119RefreshToken(vault, 'ca_1'), true);
  assert.equal(hasComposioV119RefreshToken(vault, 'ca_1'), false);
  assert.equal(deleteComposioV119RefreshToken(vault, 'ca_1'), false);
  assert.throws(() => setComposioV119RefreshToken(vault, '', 'x'), /non-empty string/);
  assert.throws(() => setComposioV119RefreshToken(vault, 'ca_1', '   '), /non-empty string/);
  assert.throws(() => hasComposioV119RefreshToken(vault, ''), /non-empty string/);
  // Rotation overwrites under the same key.
  setComposioV119RefreshToken(vault, 'ca_1', 'mock-token-a');
  setComposioV119RefreshToken(vault, 'ca_1', 'mock-token-b');
  assert.equal(vault.getSecret(NS, 'ca_1'), 'mock-token-b');
});

test('v119 oauth refresh: state create/validate + due decision', () => {
  const s = createComposioV119RefreshState('ca_1', 'gmail');
  assert.equal(s.lastRefreshAtMs, null);
  assert.equal(s.consecutiveFailures, 0);
  assert.equal(s.totalRefreshed, 0);
  assert.equal(s.needsReconnect, false);
  validateComposioV119RefreshState(s);
  assert.throws(() => createComposioV119RefreshState('', 'gmail'), /non-empty string/);
  assert.throws(() => createComposioV119RefreshState('ca_1', ''), /toolkit must be a non-empty string/);
  assert.throws(() => validateComposioV119RefreshState({ ...s, consecutiveFailures: -1 }), /non-negative integer/);
  assert.throws(() => validateComposioV119RefreshState({ ...s, needsReconnect: 'yes' }), /must be a boolean/);

  const policy = validateComposioV119RefreshPolicy(FAST_POLICY);
  assert.equal(isComposioV119RefreshDue(makeOauth(), s, policy, NOW), true, 'expires in 60s < 300s window');
  assert.equal(isComposioV119RefreshDue(makeOauth({ expiresAtMs: NOW + 3600_000 }), s, policy, NOW), false);
  assert.equal(isComposioV119RefreshDue(makeOauth({ expiresAtMs: null }), s, policy, NOW), false);
  assert.equal(isComposioV119RefreshDue(makeOauth({ state: 'revoked' }), s, policy, NOW), false);
  assert.equal(isComposioV119RefreshDue(makeOauth(), { ...s, needsReconnect: true }, policy, NOW), false);
  // Scheduled retry: not expiring, but nextRetryAtMs reached.
  const scheduled = { ...s, nextRetryAtMs: NOW - 1 };
  assert.equal(isComposioV119RefreshDue(makeOauth({ expiresAtMs: NOW + 3600_000 }), scheduled, policy, NOW), true);
  const notYet = { ...s, nextRetryAtMs: NOW + 60_000 };
  assert.equal(isComposioV119RefreshDue(makeOauth({ expiresAtMs: NOW + 3600_000 }), notYet, policy, NOW), false);
});

test('v119 oauth refresh: not-needed calls nothing and changes nothing', async () => {
  const vault = new MockVault();
  let calls = 0;
  const oauth = makeOauth({ expiresAtMs: NOW + 3600_000 });
  const refresh = makeRefresh();
  const res = await attemptComposioV119Refresh(oauth, refresh, {
    vault,
    refreshFn: async () => { calls += 1; return { newExpiresAtMs: NOW + 3600_000 }; },
    policy: FAST_POLICY,
    nowMs: NOW,
  });
  assert.equal(res.outcome, 'not-needed');
  assert.equal(res.attempts, 0);
  assert.equal(calls, 0);
  assert.equal(res.oauth, oauth, 'same entry object');
  assert.equal(res.refresh, refresh, 'same state object');
  assert.equal(res.audit.outcome, 'not-needed');
});

test('v119 oauth refresh: no-token expires the entry + needs reconnect', async () => {
  const vault = new MockVault();
  let calls = 0;
  const res = await attemptComposioV119Refresh(makeOauth(), makeRefresh(), {
    vault,
    refreshFn: async () => { calls += 1; return { newExpiresAtMs: NOW + 3600_000 }; },
    policy: FAST_POLICY,
    nowMs: NOW,
  });
  assert.equal(res.outcome, 'no-token');
  assert.equal(res.attempts, 0);
  assert.equal(calls, 0);
  assert.equal(res.oauth.state, 'expired');
  assert.equal(res.refresh.needsReconnect, true);
  assert.equal(res.refresh.lastError, 'no refresh token in Vault');
});

test('v119 oauth refresh: success rotates the token + resets failures', async () => {
  const vault = new MockVault();
  setComposioV119RefreshToken(vault, 'ca_1', 'mock-token-old');
  const res = await attemptComposioV119Refresh(makeOauth(), makeRefresh({ consecutiveFailures: 2, totalFailed: 2, lastError: 'before' }), {
    vault,
    refreshFn: async (connectionId, token) => {
      assert.equal(connectionId, 'ca_1');
      assert.equal(token, 'mock-token-old', 'the stored token is passed to the refresh function');
      return { newExpiresAtMs: NOW + 3600_000, newRefreshToken: 'mock-token-new' };
    },
    policy: FAST_POLICY,
    nowMs: NOW,
  });
  assert.equal(res.outcome, 'refreshed');
  assert.equal(res.attempts, 1);
  assert.equal(res.oauth.state, 'connected');
  assert.equal(res.oauth.expiresAtMs, NOW + 3600_000);
  assert.equal(res.oauth.autoRefreshAttempts, 0);
  assert.equal(res.refresh.lastRefreshAtMs, NOW);
  assert.equal(res.refresh.consecutiveFailures, 0);
  assert.equal(res.refresh.totalRefreshed, 1);
  assert.equal(res.refresh.totalFailed, 2, 'totals are kept');
  assert.equal(res.refresh.lastError, null);
  assert.equal(res.refresh.needsReconnect, false);
  assert.equal(vault.getSecret(NS, 'ca_1'), 'mock-token-new', 'rotation overwrote the stored token');
  assert.equal(res.audit.outcome, 'refreshed');
  assert.equal(res.audit.attempts, 1);
});

test('v119 oauth refresh: success without rotation keeps the old token', async () => {
  const vault = new MockVault();
  setComposioV119RefreshToken(vault, 'ca_1', 'mock-token-old');
  const res = await attemptComposioV119Refresh(makeOauth(), makeRefresh(), {
    vault,
    refreshFn: async () => ({ newExpiresAtMs: NOW + 3600_000, newRefreshToken: null }),
    policy: FAST_POLICY,
    nowMs: NOW,
  });
  assert.equal(res.outcome, 'refreshed');
  assert.equal(vault.getSecret(NS, 'ca_1'), 'mock-token-old');
});

test('v119 oauth refresh: revoked deletes the token + needs reconnect', async () => {
  const vault = new MockVault();
  setComposioV119RefreshToken(vault, 'ca_1', 'mock-token-old');
  const res = await attemptComposioV119Refresh(makeOauth(), makeRefresh(), {
    vault,
    refreshFn: async () => ({ newExpiresAtMs: NOW + 3600_000, revoked: true }),
    policy: FAST_POLICY,
    nowMs: NOW,
  });
  assert.equal(res.outcome, 'revoked');
  assert.equal(res.oauth.state, 'revoked');
  assert.equal(hasComposioV119RefreshToken(vault, 'ca_1'), false, 'revoked token is deleted immediately');
  assert.equal(res.refresh.needsReconnect, true);
  assert.equal(res.refresh.lastError, 'provider revoked access');
  // A revoked entry is never refreshed again.
  const again = await attemptComposioV119Refresh(res.oauth, res.refresh, {
    vault,
    refreshFn: async () => ({ newExpiresAtMs: NOW + 3600_000 }),
    policy: FAST_POLICY,
    nowMs: NOW,
  });
  assert.equal(again.outcome, 'not-needed');
});

test('v119 oauth refresh: fail once then recover on retry', async () => {
  const vault = new MockVault();
  setComposioV119RefreshToken(vault, 'ca_1', 'mock-token');
  let calls = 0;
  const sleeps = [];
  const res = await attemptComposioV119Refresh(makeOauth(), makeRefresh(), {
    vault,
    refreshFn: async () => {
      calls += 1;
      if (calls === 1) throw new Error('mock network down');
      return { newExpiresAtMs: NOW + 3600_000 };
    },
    policy: FAST_POLICY,
    nowMs: NOW,
    sleep: async (ms) => { sleeps.push(ms); },
    random: () => 0.5,
  });
  assert.equal(res.outcome, 'refreshed');
  assert.equal(res.attempts, 2);
  assert.equal(calls, 2);
  assert.deepEqual(sleeps, [100], 'one backoff sleep before the retry');
  assert.equal(res.refresh.totalRefreshed, 1);
});

test('v119 oauth refresh: exhausted retries expire + schedule retry, then fallback', async () => {
  const vault = new MockVault();
  setComposioV119RefreshToken(vault, 'ca_1', 'mock-token');
  let calls = 0;
  const failing = async () => {
    calls += 1;
    throw new Error('mock refresh failed');
  };
  const first = await attemptComposioV119Refresh(makeOauth(), makeRefresh(), {
    vault, refreshFn: failing, policy: FAST_POLICY, nowMs: NOW, sleep: async () => undefined, random: () => 0.5,
  });
  assert.equal(first.outcome, 'failed');
  assert.equal(first.attempts, 2, 'maxAttempts 2');
  assert.equal(calls, 2);
  assert.equal(first.oauth.state, 'expired');
  assert.equal(first.refresh.consecutiveFailures, 1);
  assert.equal(first.refresh.totalFailed, 1);
  assert.equal(first.refresh.lastError, 'mock refresh failed');
  assert.equal(first.refresh.nextRetryAtMs, NOW + 200, 'retryDelayMs(1) = 200');
  assert.equal(first.refresh.needsReconnect, false);

  // Two more consecutive failures reach maxConsecutiveFailures = 3 → fallback.
  const second = await attemptComposioV119Refresh(makeOauth(), first.refresh, {
    vault, refreshFn: failing, policy: FAST_POLICY, nowMs: NOW + 1000, sleep: async () => undefined, random: () => 0.5,
  });
  assert.equal(second.refresh.consecutiveFailures, 2);
  assert.equal(second.refresh.needsReconnect, false);
  const third = await attemptComposioV119Refresh(makeOauth(), second.refresh, {
    vault, refreshFn: failing, policy: FAST_POLICY, nowMs: NOW + 2000, sleep: async () => undefined, random: () => 0.5,
  });
  assert.equal(third.outcome, 'failed');
  assert.equal(third.refresh.consecutiveFailures, 3);
  assert.equal(third.refresh.needsReconnect, true, 'fallback: stop refreshing, user must reconnect');
  assert.equal(third.refresh.nextRetryAtMs, null);
  assert.match(third.audit.reason, /reconnect required/);
});

test('v119 oauth refresh: invalid expiry from the server counts as failure', async () => {
  const vault = new MockVault();
  setComposioV119RefreshToken(vault, 'ca_1', 'mock-token');
  const res = await attemptComposioV119Refresh(makeOauth(), makeRefresh(), {
    vault,
    refreshFn: async () => ({ newExpiresAtMs: NOW - 1000 }),
    policy: FAST_POLICY,
    nowMs: NOW,
    sleep: async () => undefined,
    random: () => 0.5,
  });
  assert.equal(res.outcome, 'failed');
  assert.equal(res.refresh.lastError, 'refresh returned an invalid expiry');
});

test('v119 oauth refresh: connectionId mismatch throws + reset clears state', async () => {
  const vault = new MockVault();
  setComposioV119RefreshToken(vault, 'ca_1', 'mock-token');
  await assert.rejects(
    () => attemptComposioV119Refresh(makeOauth(), createComposioV119RefreshState('ca_2', 'gmail'), {
      vault,
      refreshFn: async () => ({ newExpiresAtMs: NOW + 3600_000 }),
      policy: FAST_POLICY,
      nowMs: NOW,
    }),
    /does not match OAuth entry/,
  );

  const stale = makeRefresh({
    consecutiveFailures: 3,
    totalRefreshed: 5,
    totalFailed: 3,
    lastError: 'mock refresh failed',
    nextRetryAtMs: NOW + 1000,
    needsReconnect: true,
  });
  const reset = resetComposioV119Refresh(stale, vault);
  assert.equal(reset.consecutiveFailures, 0);
  assert.equal(reset.lastError, null);
  assert.equal(reset.nextRetryAtMs, null);
  assert.equal(reset.needsReconnect, false);
  assert.equal(reset.totalRefreshed, 5, 'totals survive a reset');
  assert.equal(reset.totalFailed, 3);
  assert.equal(hasComposioV119RefreshToken(vault, 'ca_1'), false, 'old token is deleted on reset');
});

test('v119 oauth refresh: summary text + audit entries', () => {
  assert.match(summarizeComposioV119Refresh(makeRefresh()), /never refreshed/);
  assert.match(
    summarizeComposioV119Refresh(makeRefresh({ needsReconnect: true, consecutiveFailures: 3 })),
    /needs reconnect \(3 consecutive failures\)/,
  );
  assert.match(
    summarizeComposioV119Refresh(makeRefresh({ lastRefreshAtMs: NOW, totalRefreshed: 2, totalFailed: 1 })),
    /refreshed 2 times, 1 failures/,
  );
  const entry = createComposioV119RefreshAuditEntry('ca_1', 'gmail', 'refreshed', 1, 'ok', NOW);
  assert.ok(entry.id.startsWith('rf119-'));
  assert.deepEqual(validateComposioV119RefreshAuditEntry(entry), entry);
  assert.throws(() => createComposioV119RefreshAuditEntry('ca_1', 'gmail', 'refreshed', -1, 'x', NOW), /non-negative integer/);
  assert.throws(() => validateComposioV119RefreshAuditEntry({ ...entry, outcome: 'weird' }), /outcome is invalid/);
});

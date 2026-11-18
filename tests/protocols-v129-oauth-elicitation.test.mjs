/**
 * Protocols v5 — MCP OAuth elicitation / reconnect tests (v1.29, Team T2).
 *
 * Covers packages/core/src/protocolsV5/mcpOAuthElicitationV5.ts:
 * the auth state machine (connected / needs-auth /
 * authenticating / reconnecting / disconnected / failed),
 * elicitation keeping the session alive, guardCall queueing
 * blocked calls for replay, reconnect with backoff (success
 * after failures, failure after the budget is spent), token
 * expiry with the skew window, and the per-server manager.
 *
 * No network, no Vault: the token provider is injected.
 *
 * Run after building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/protocols-v129-oauth-elicitation.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  McpAuthSession,
  McpAuthSessionManager,
} from '../packages/core/dist/index.js';

test('fresh session starts disconnected; markConnected works; canCall only when connected', () => {
  const session = new McpAuthSession({ serverName: 'github' });
  assert.equal(session.getState(), 'disconnected');
  assert.equal(session.canCall(), false);
  session.markConnected(Date.now() + 3600_000);
  assert.equal(session.getState(), 'connected');
  assert.equal(session.canCall(), true);
  assert.equal(session.isRecoverable(), false);
  assert.match(session.summary(), /github: connected/);
});

test('elicitation moves to needs-auth and keeps the session alive; second challenge replaces the first', () => {
  const session = new McpAuthSession({ serverName: 'gh', initialState: 'connected' });
  session.elicit({ authUrl: 'https://example.test/auth', hint: 'scope repo is missing' });
  assert.equal(session.getState(), 'needs-auth');
  assert.equal(session.canCall(), false);
  assert.equal(session.isRecoverable(), true);
  assert.equal(session.getChallenge()?.authUrl, 'https://example.test/auth');
  assert.equal(session.getChallenge()?.hint, 'scope repo is missing');
  assert.match(session.summary(), /needs-auth/);

  session.elicit({ authUrl: 'https://example.test/auth2' });
  assert.equal(session.getState(), 'needs-auth');
  assert.equal(session.getChallenge()?.authUrl, 'https://example.test/auth2');
  // History recorded both transitions.
  assert.ok(session.history().length >= 3);
});

test('guardCall queues blocked calls and throws needs-auth without crashing the session', () => {
  const session = new McpAuthSession({ serverName: 'gh', initialState: 'connected' });
  session.elicit({ authUrl: 'https://example.test/auth' });
  assert.throws(() => session.guardCall('search', { q: 'x' }), /needs authentication/);
  assert.throws(() => session.guardCall('search', { q: 'y' }), /needs authentication/);
  assert.equal(session.getState(), 'needs-auth');
  assert.equal(session.pendingReplayCount(), 2);
  assert.equal(session.listBlockedCalls().length, 2);
  assert.equal(session.listBlockedCalls()[0].toolName, 'search');
  assert.equal(session.listBlockedCalls()[0].replayed, false);
});

test('reconnect restores connected and returns the queued calls for replay', async () => {
  const session = new McpAuthSession({ serverName: 'gh', initialState: 'connected' });
  session.elicit({ authUrl: 'https://example.test/auth' });
  assert.throws(() => session.guardCall('search', { q: 'x' }), /needs authentication/);
  assert.throws(() => session.guardCall('list', {}), /needs authentication/);

  const replay = await session.reconnect(async () => ({
    accessToken: 'fresh-token',
    expiresAt: Date.now() + 3600_000,
  }));
  assert.equal(session.getState(), 'connected');
  assert.equal(session.canCall(), true);
  assert.equal(replay.length, 2);
  assert.deepEqual(replay.map((c) => c.toolName), ['search', 'list']);
  assert.equal(session.pendingReplayCount(), 0);
  assert.equal(session.listBlockedCalls().every((c) => c.replayed), true);
  // Reconnecting an already-connected session is a no-op.
  assert.deepEqual(await session.reconnect(async () => ({ accessToken: 'x' })), []);
});

test('reconnect retries with backoff and succeeds on a later attempt', async () => {
  const delays = [];
  const session = new McpAuthSession({
    serverName: 'gh',
    initialState: 'needs-auth',
    maxReconnectAttempts: 3,
    reconnectBaseMs: 10,
    reconnectMaxMs: 100,
    sleep: async (ms) => {
      delays.push(ms);
    },
  });
  let attempts = 0;
  const replay = await session.reconnect(async () => {
    attempts += 1;
    if (attempts < 3) throw new Error('provider busy');
    return { accessToken: 'ok', expiresAt: Date.now() + 1000 };
  });
  assert.equal(attempts, 3);
  assert.deepEqual(delays, [10, 20]);
  assert.equal(session.getState(), 'connected');
  assert.deepEqual(replay, []);
});

test('reconnect failure after the budget leaves the session failed — but it can re-authenticate', async () => {
  const session = new McpAuthSession({
    serverName: 'gh',
    initialState: 'needs-auth',
    maxReconnectAttempts: 2,
    reconnectBaseMs: 1,
    sleep: async () => {},
  });
  await assert.rejects(
    session.reconnect(async () => {
      throw new Error('provider down');
    }),
    /failed after 2 attempts: provider down/,
  );
  assert.equal(session.getState(), 'failed');
  assert.equal(session.getLastError(), 'provider down');
  assert.equal(session.isRecoverable(), false);
  assert.match(session.summary(), /last error: provider down/);
  // Failed is not a dead end: startAuthentication brings it back.
  session.startAuthentication();
  assert.equal(session.getState(), 'authenticating');
  const replay = await session.reconnect(async () => ({ accessToken: 'ok' }));
  assert.equal(session.getState(), 'connected');
  assert.deepEqual(replay, []);
});

test('illegal transitions throw with from/to named; a missing token is refused', async () => {
  const session = new McpAuthSession({ serverName: 'gh', initialState: 'connected' });
  assert.throws(() => session.startAuthentication(), /Illegal auth transition.*connected -> authenticating/);
  const failed = new McpAuthSession({ serverName: 'gh', initialState: 'failed' });
  assert.throws(() => failed.markConnected(), /is failed; authenticate first/);
  const needsAuth = new McpAuthSession({ serverName: 'gh', initialState: 'needs-auth' });
  await assert.rejects(
    needsAuth.reconnect(async () => ({ accessToken: '' })),
    /no access token/,
  );
  assert.equal(needsAuth.getState(), 'failed');
});

test('credential expiry: within the 60s skew window the session refuses calls up-front', () => {
  const now = Date.now();
  const session = new McpAuthSession({
    serverName: 'gh',
    initialState: 'connected',
    credentialExpiresAt: now + 30_000, // inside the skew window
    now: () => now,
  });
  assert.equal(session.isCredentialExpired(), true);
  assert.equal(session.canCall(), false);
  assert.throws(() => session.guardCall('search'), /expired/);

  const fresh = new McpAuthSession({
    serverName: 'gh',
    initialState: 'connected',
    credentialExpiresAt: now + 3600_000,
    now: () => now,
  });
  assert.equal(fresh.isCredentialExpired(), false);
  assert.equal(fresh.canCall(), true);

  const unknown = new McpAuthSession({ serverName: 'gh', initialState: 'connected' });
  assert.equal(unknown.isCredentialExpired(), false);
  assert.equal(unknown.getCredentialExpiresAt(), undefined);
});

test('markCredentialExpired elicits without a URL; toJSON never includes a token', () => {
  const session = new McpAuthSession({ serverName: 'gh', initialState: 'connected' });
  session.markCredentialExpired();
  assert.equal(session.getState(), 'needs-auth');
  assert.equal(session.getChallenge()?.authUrl, '');
  const json = session.toJSON();
  assert.equal(json.serverName, 'gh');
  assert.equal(json.state, 'needs-auth');
  assert.equal(json.hasChallenge, true);
  assert.ok(!JSON.stringify(json).includes('token'));
});

test('manager: serversNeedingAuth lists only needs-auth servers; allConnected gates the set', () => {
  const manager = new McpAuthSessionManager();
  const a = manager.sessionFor('a', { initialState: 'connected' });
  const b = manager.sessionFor('b', { initialState: 'connected' });
  assert.equal(manager.allConnected(), true);
  assert.deepEqual(manager.serversNeedingAuth(), []);
  b.elicit({ authUrl: 'https://example.test/auth' });
  assert.deepEqual(manager.serversNeedingAuth(), ['b']);
  assert.equal(manager.allConnected(), false);
  assert.deepEqual(manager.serverNames(), ['a', 'b']);
  assert.equal(manager.get('a'), a);
  assert.equal(manager.get('zzz'), undefined);
  assert.equal(manager.summaries().length, 2);
});

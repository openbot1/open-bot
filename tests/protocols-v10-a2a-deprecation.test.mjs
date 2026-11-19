/**
 * Tests for v1.41 (Team T2) — A2A v1.0 minimal handshake +
 * deprecation policy registry:
 * packages/core/src/protocolsV10/a2aV10.ts
 * packages/core/src/protocolsV10/deprecationV10.ts
 *
 * Covers (A2A):
 *  - loopback guard (non-loopback URLs refused before
 *    anything is sent; well-known URL builder)
 *  - Agent Card validation (fields, auth schemes, loopback url)
 *  - version negotiation (newest common wins, unknown never wins)
 *  - capability intersection (sorted, deterministic) + auth
 *    scheme agreement (local preference order)
 *  - handshake: missing version / capability / auth scheme
 *    all fail with a clear error; happy path agrees all three
 *  - session: send before handshake refused, message echo,
 *    history, reset
 *  - message builder (empty / oversized refused)
 *
 * Covers (deprecation):
 *  - earliest removal date (12 months; 90 days for security)
 *  - date validation + days-between math
 *  - register validation (bad reason, bad date, security
 *    window needs reason "security")
 *  - recordUse (counts; removed feature refuses use)
 *  - removal guard (window not passed -> blocked; window
 *    passed + still used -> warning; override removes)
 *  - removable-now / pending lists
 *  - defaults ship the five v10 deprecations
 *  - snapshot / restore round-trip
 *
 * Run after building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/protocols-v10-a2a-deprecation.test.mjs
 *
 * No network, no model.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  A2aV10Session,
  McpV10DeprecationRegistry,
  agreeA2aV10AuthScheme,
  buildA2aV10Message,
  buildA2aV10WellKnownUrl,
  defaultMcpV10Deprecations,
  intersectA2aV10Capabilities,
  isA2aV10LoopbackUrl,
  isMcpV10ValidDate,
  mcpV10DaysBetween,
  mcpV10EarliestRemovalDate,
  negotiateA2aV10Version,
  performA2aV10Handshake,
  validateA2aV10AgentCard,
} from '../packages/core/dist/index.js';

const CARD = {
  name: 'peer-agent',
  description: 'A test peer.',
  protocolVersions: ['1.1', '1.0'],
  capabilities: ['search', 'code', 'chat'],
  authSchemes: ['bearer', 'none'],
  url: 'http://127.0.0.1:9000',
};

test('loopback guard: only loopback http(s) passes', () => {
  assert.equal(isA2aV10LoopbackUrl('http://127.0.0.1:9000'), true);
  assert.equal(isA2aV10LoopbackUrl('https://localhost:9000/x'), true);
  assert.equal(isA2aV10LoopbackUrl('http://[::1]:9000'), true);
  assert.equal(isA2aV10LoopbackUrl('https://example.com'), false);
  assert.equal(isA2aV10LoopbackUrl('https://127.0.0.1.evil.com'), false);
  assert.equal(isA2aV10LoopbackUrl('ftp://127.0.0.1'), false);
  assert.equal(isA2aV10LoopbackUrl('not a url'), false);
  assert.equal(buildA2aV10WellKnownUrl('http://127.0.0.1:9000/'), 'http://127.0.0.1:9000/.well-known/agent-card.json');
  assert.throws(() => buildA2aV10WellKnownUrl('https://example.com'), /not loopback-only/);
});

test('Agent Card validation: fields, auth schemes, loopback url', () => {
  assert.deepEqual(validateA2aV10AgentCard(CARD), []);
  assert.ok(validateA2aV10AgentCard({ ...CARD, name: '' }).length > 0);
  assert.ok(validateA2aV10AgentCard({ ...CARD, protocolVersions: [] }).length > 0);
  assert.ok(validateA2aV10AgentCard({ ...CARD, authSchemes: ['magic'] }).length > 0);
  assert.ok(validateA2aV10AgentCard({ ...CARD, url: 'https://example.com' }).some((p) => p.includes('loopback')));
  assert.ok(validateA2aV10AgentCard(null).length > 0);
});

test('version negotiation: newest common wins; unknown never wins', () => {
  assert.equal(negotiateA2aV10Version(['1.0', '1.1']).agreed, '1.1');
  assert.equal(negotiateA2aV10Version(['1.0']).agreed, '1.0');
  assert.equal(negotiateA2aV10Version(['9.9']).agreed, undefined);
  assert.deepEqual(negotiateA2aV10Version(['9.9']).peerOnly, ['9.9']);
  assert.equal(negotiateA2aV10Version(['1.1']).peerHasCurrent, true);
  assert.equal(negotiateA2aV10Version(['1.0']).peerHasCurrent, false);
});

test('capability intersection is sorted; auth agreement follows local preference', () => {
  assert.deepEqual(intersectA2aV10Capabilities(['code', 'search', 'x'], ['search', 'code']), ['code', 'search']);
  assert.deepEqual(intersectA2aV10Capabilities(['a'], ['b']), []);
  assert.equal(agreeA2aV10AuthScheme(['bearer', 'none'], ['none', 'bearer']), 'bearer');
  assert.equal(agreeA2aV10AuthScheme(['none'], ['bearer']), undefined);
});

test('handshake: happy path agrees version + capabilities + auth', async () => {
  const hs = await performA2aV10Handshake('http://127.0.0.1:9000', {
    localCapabilities: ['search', 'code'],
    localAuthSchemes: ['none', 'bearer'],
    fetcher: async () => CARD,
  });
  assert.equal(hs.version, '1.1');
  assert.deepEqual(hs.capabilities, ['code', 'search']);
  assert.equal(hs.authScheme, 'none');
  assert.equal(hs.card.name, 'peer-agent');
  assert.equal(typeof hs.completedAt, 'number');
});

test('handshake failures: no version, missing capability, no auth, bad card, fetch failure', async () => {
  await assert.rejects(
    () => performA2aV10Handshake('http://127.0.0.1:9000', {
      localCapabilities: [], localAuthSchemes: ['none'],
      fetcher: async () => ({ ...CARD, protocolVersions: ['9.9'] }),
    }),
    /No common A2A version/,
  );
  await assert.rejects(
    () => performA2aV10Handshake('http://127.0.0.1:9000', {
      localCapabilities: [], localAuthSchemes: ['none'], requiredCapabilities: ['fly'],
      fetcher: async () => CARD,
    }),
    /lacks required capabilities/,
  );
  await assert.rejects(
    () => performA2aV10Handshake('http://127.0.0.1:9000', {
      localCapabilities: [], localAuthSchemes: ['mutual-tls'],
      fetcher: async () => CARD,
    }),
    /No common auth scheme/,
  );
  await assert.rejects(
    () => performA2aV10Handshake('http://127.0.0.1:9000', {
      localCapabilities: [], localAuthSchemes: ['none'],
      fetcher: async () => ({ name: 'broken' }),
    }),
    /invalid/,
  );
  await assert.rejects(
    () => performA2aV10Handshake('http://127.0.0.1:9000', {
      localCapabilities: [], localAuthSchemes: ['none'],
      fetcher: async () => { throw new Error('down'); },
    }),
    /Could not fetch/,
  );
  await assert.rejects(
    () => performA2aV10Handshake('https://example.com', {
      localCapabilities: [], localAuthSchemes: ['none'],
      fetcher: async () => CARD,
    }),
    /not loopback-only/,
  );
});

test('message builder: empty and oversized refused', () => {
  assert.equal(buildA2aV10Message('hi').kind, 'message/text');
  assert.equal(buildA2aV10Message('hi', 'agent').role, 'agent');
  assert.throws(() => buildA2aV10Message('   '), /non-empty string/);
  assert.throws(() => buildA2aV10Message('x'.repeat(65 * 1024)), /64 KiB/);
});

test('session: send before handshake refused; echo + history + reset', async () => {
  const session = new A2aV10Session(async (_hs, message) => ({
    kind: 'message/text', text: `echo: ${message.text}`, role: 'agent', at: Date.now(),
  }));
  await assert.rejects(() => session.send('hi'), /after the handshake/);
  await session.handshakeWith('http://127.0.0.1:9000', {
    localCapabilities: ['search'], localAuthSchemes: ['none'],
    fetcher: async () => CARD,
  });
  assert.equal(session.isHandshaken, true);
  const reply = await session.send('hello');
  assert.equal(reply.text, 'echo: hello');
  assert.equal(session.messages().length, 2);
  assert.equal(session.messages()[0].role, 'user');
  assert.equal(session.messages()[1].role, 'agent');
  session.reset();
  assert.equal(session.isHandshaken, false);
  assert.deepEqual(session.messages(), []);
});

test('deprecation dates: 12 months normally, 90 days for a security flaw', () => {
  assert.equal(mcpV10EarliestRemovalDate('2026-07-28', false), '2027-07-28');
  assert.equal(mcpV10EarliestRemovalDate('2026-07-28', true), '2026-10-26');
  assert.equal(mcpV10EarliestRemovalDate('2026-01-31', false), '2027-01-31');
  assert.equal(isMcpV10ValidDate('2026-07-28'), true);
  assert.equal(isMcpV10ValidDate('2026-02-30'), false);
  assert.equal(isMcpV10ValidDate('28-07-2026'), false);
  assert.equal(mcpV10DaysBetween('2026-07-28', '2027-07-28'), 365);
  assert.equal(mcpV10DaysBetween('2027-07-28', '2026-07-28'), -365);
  assert.equal(mcpV10DaysBetween('2026-07-28', '2026-07-28'), 0);
});

test('registry: register validation, use counting, removal guard', () => {
  const reg = new McpV10DeprecationRegistry();
  const entry = reg.deprecate({
    id: 'old-thing', name: 'Old Thing', reason: 'replaced',
    deprecatedSince: '2026-07-28', replacedBy: 'new-thing',
    migrationNote: 'Switch to new-thing.',
  });
  assert.equal(entry.status, 'deprecated');
  assert.equal(entry.earliestRemoval, '2027-07-28');
  assert.equal(entry.useCount, 0);
  assert.throws(
    () => reg.deprecate({ id: 'x', name: 'X', reason: 'weird', deprecatedSince: '2026-07-28' }),
    /reason must be/,
  );
  assert.throws(
    () => reg.deprecate({ id: 'x', name: 'X', reason: 'replaced', deprecatedSince: '2026-13-01' }),
    /not a valid YYYY-MM-DD/,
  );
  assert.throws(
    () => reg.deprecate({ id: 'x', name: 'X', reason: 'replaced', deprecatedSince: '2026-07-28', securityFlaw: true }),
    /90-day security window/,
  );
  // Window has not passed yet: removal blocked.
  const blocked = reg.checkRemoval('old-thing', '2026-08-01');
  assert.equal(blocked.length, 1);
  assert.match(blocked[0], /cannot be removed yet/);
  assert.throws(() => reg.remove('old-thing', '2026-08-01'), /cannot be removed yet/);
  // Use it once; window passes; guard warns but allows with override.
  assert.equal(reg.recordUse('old-thing'), 1);
  const warn = reg.checkRemoval('old-thing', '2027-08-01');
  assert.equal(warn.length, 1);
  assert.match(warn[0], /may be removed/);
  assert.match(warn[0], /still used 1 time/);
  const removed = reg.remove('old-thing', '2027-08-01');
  assert.equal(removed.status, 'removed');
  assert.equal(removed.removedAt, '2027-08-01');
  assert.throws(() => reg.recordUse('old-thing'), /was removed/);
  assert.deepEqual(reg.checkRemoval('old-thing', '2027-08-01'), ['Feature "old-thing" is already removed (on 2027-08-01).']);
  assert.deepEqual(reg.checkRemoval('nope'), ['No deprecation entry for "nope".']);
});

test('registry: removable-now vs pending, defaults, snapshot/restore', () => {
  const reg = new McpV10DeprecationRegistry();
  for (const d of defaultMcpV10Deprecations()) reg.deprecate(d);
  assert.equal(reg.list().length, 5);
  assert.ok(reg.list().some((e) => e.id === 'mcp.initialize'));
  assert.ok(reg.list().some((e) => e.id === 'oauth.dcr'));
  assert.deepEqual(reg.removableNow('2026-08-01'), []);
  assert.equal(reg.pending('2026-08-01').length, 5);
  assert.equal(reg.pending('2026-08-01')[0].daysLeft, 361);
  assert.equal(reg.removableNow('2027-08-01').length, 5);
  const snap = reg.snapshot();
  const restored = new McpV10DeprecationRegistry();
  restored.restore(snap);
  assert.equal(restored.list().length, 5);
  assert.equal(restored.get('oauth.dcr').replacedBy, 'Explicit registration / Client ID Metadata Documents');
  // Removal with an explicit override reason before the window passes.
  const overridden = reg.remove('mcp.initialize', '2026-08-01', 'Emergency: the old handshake leaks sessions.');
  assert.equal(overridden.status, 'removed');
  assert.match(overridden.migrationNote, /Removal override/);
});

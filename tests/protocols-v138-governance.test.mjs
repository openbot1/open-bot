/**
 * Protocols v7 — governance layer tests (v1.38, Team T2).
 *
 * Covers packages/core/src/protocolsV7/governanceV7.ts:
 * scope matching, grants + sub-delegation (scope/depth limits),
 * authorize (expiry/uses/rate/time-window), revocation (single /
 * cascade / by delegate / by scope), escalation queue (file /
 * approve / deny / auto-expire), audit log (append / filter /
 * hash-chain verify / tamper detection / snapshot+restore).
 *
 * Run after building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/protocols-v138-governance.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  GOV_V7_MAX_DELEGATION_DEPTH,
  GovV7AuditLog,
  GovV7EscalationQueue,
  GovV7PolicyEngine,
  govV7ScopeMatches,
  govV7ScopesCover,
  summarizeGovV7Grant,
} from '../packages/core/dist/index.js';

test('scope matching: exact, wildcard segment, trailing wildcard', () => {
  assert.equal(govV7ScopeMatches('a2a:send', 'a2a:send'), true);
  assert.equal(govV7ScopeMatches('a2a:send', 'a2a:cancel'), false);
  assert.equal(govV7ScopeMatches('mcp:tools/call:*', 'mcp:tools/call:echo'), true);
  assert.equal(govV7ScopeMatches('mcp:tools/call:*', 'mcp:tools/list'), false);
  assert.equal(govV7ScopeMatches('mcp:*', 'mcp:tools/call:echo'), true);
  assert.equal(govV7ScopeMatches('*', 'anything:at:all'), true);
  assert.equal(govV7ScopeMatches('a2a:send', 'a2a:send:extra'), false);
  assert.equal(govV7ScopesCover(['mcp:tools/call:*'], ['mcp:tools/call:echo']), true);
  assert.equal(govV7ScopesCover(['mcp:tools/call:*'], ['mcp:tools/call:echo', 'ucp:catalog/search']), false);
});

test('grants: create, authorize, use counting, max-uses exhaustion', () => {
  const audit = new GovV7AuditLog();
  const engine = new GovV7PolicyEngine(audit);
  const grant = engine.grant({
    delegator: 'user-1', delegate: 'agent-1',
    scopes: ['a2a:send', 'mcp:tools/call:*'], tenant: 'default',
    maxUses: 2, purpose: 'demo work',
  });
  assert.equal(grant.depth, 0);
  assert.equal(grant.status, 'active');
  assert.equal(grant.constraints.spendCapMinor, 0);
  assert.match(summarizeGovV7Grant(grant), /user-1 -> agent-1/);
  assert.equal(engine.authorize({ delegate: 'agent-1', operation: 'a2a:send', tenant: 'default' }).allowed, true);
  assert.equal(engine.authorize({ delegate: 'agent-1', operation: 'mcp:tools/call:echo', tenant: 'default' }).allowed, true);
  assert.equal(engine.getGrant(grant.id).uses, 2);
  assert.equal(engine.getGrant(grant.id).status, 'exhausted');
  const denied = engine.authorize({ delegate: 'agent-1', operation: 'a2a:send', tenant: 'default' });
  assert.equal(denied.allowed, false);
  assert.equal(denied.needsEscalation, true);
  const wrongTenant = engine.authorize({ delegate: 'agent-1', operation: 'a2a:send', tenant: 'other' });
  assert.equal(wrongTenant.allowed, false);
  const nobody = engine.authorize({ delegate: 'ghost', operation: 'a2a:send', tenant: 'default' });
  assert.equal(nobody.allowed, false);
  assert.equal(nobody.needsEscalation, true);
  assert.equal(engine.countsByStatus().exhausted, 1);
});

test('grants: validation — self-delegation, empty scopes, bad TTL', () => {
  const engine = new GovV7PolicyEngine();
  assert.throws(() => engine.grant({ delegator: 'a', delegate: 'a', scopes: ['x'], tenant: 't' }), /itself/);
  assert.throws(() => engine.grant({ delegator: 'a', delegate: 'b', scopes: [], tenant: 't' }), /at least one/);
  assert.throws(() => engine.grant({ delegator: 'a', delegate: 'b', scopes: ['x'], tenant: 't', ttlMs: 0 }), /TTL/);
  assert.throws(() => engine.grant({ delegator: 'a', delegate: 'b', scopes: ['x'], tenant: 't', ttlMs: 25 * 60 * 60 * 1000 }), /TTL/);
});

test('sub-delegation: within parent scope only, depth capped, parent must be the delegator', () => {
  const engine = new GovV7PolicyEngine();
  const root = engine.grant({
    delegator: 'user-1', delegate: 'agent-1',
    scopes: ['mcp:tools/call:*'], tenant: 'default',
  });
  const child = engine.grant({
    delegator: 'agent-1', delegate: 'agent-2',
    scopes: ['mcp:tools/call:echo'], tenant: 'default', parentGrantId: root.id,
  });
  assert.equal(child.depth, 1);
  assert.equal(child.parentGrantId, root.id);
  assert.equal(engine.authorize({ delegate: 'agent-2', operation: 'mcp:tools/call:echo', tenant: 'default' }).allowed, true);
  assert.equal(engine.authorize({ delegate: 'agent-2', operation: 'mcp:tools/call:other', tenant: 'default' }).allowed, false);
  // Wider than the parent: refused.
  assert.throws(() => engine.grant({
    delegator: 'agent-1', delegate: 'agent-2', scopes: ['ucp:catalog/search'],
    tenant: 'default', parentGrantId: root.id,
  }), /exceed/);
  // Wrong delegator (not the parent's delegate): refused.
  assert.throws(() => engine.grant({
    delegator: 'user-1', delegate: 'agent-2', scopes: ['mcp:tools/call:echo'],
    tenant: 'default', parentGrantId: root.id,
  }), /Only the parent/);
  // Depth chain up to the max, then refused.
  let parent = child;
  let delegator = 'agent-2';
  for (let depth = 2; depth <= GOV_V7_MAX_DELEGATION_DEPTH; depth += 1) {
    const next = engine.grant({
      delegator, delegate: `agent-${depth + 1}`,
      scopes: ['mcp:tools/call:echo'], tenant: 'default', parentGrantId: parent.id,
    });
    assert.equal(next.depth, depth);
    parent = next;
    delegator = `agent-${depth + 1}`;
  }
  assert.throws(() => engine.grant({
    delegator, delegate: 'agent-too-deep', scopes: ['mcp:tools/call:echo'],
    tenant: 'default', parentGrantId: parent.id,
  }), /depth/);
});

test('revocation: single, cascade, by delegate, by scope; revoked beats expiry', () => {
  const engine = new GovV7PolicyEngine();
  const root = engine.grant({ delegator: 'user', delegate: 'a1', scopes: ['mcp:*'], tenant: 'default' });
  const child = engine.grant({
    delegator: 'a1', delegate: 'a2', scopes: ['mcp:tools/call:*'],
    tenant: 'default', parentGrantId: root.id,
  });
  const other = engine.grant({ delegator: 'user', delegate: 'a3', scopes: ['a2a:send'], tenant: 'default' });
  assert.equal(engine.revokeCascade(root.id, 'user', 'compromise'), 2);
  assert.equal(engine.getGrant(root.id).status, 'revoked');
  assert.equal(engine.getGrant(child.id).status, 'revoked');
  assert.equal(engine.getGrant(other.id).status, 'active');
  assert.equal(engine.authorize({ delegate: 'a2', operation: 'mcp:tools/call:echo', tenant: 'default' }).allowed, false);
  assert.equal(engine.revoke(root.id, 'user'), false);
  assert.equal(engine.revokeByDelegate('a3', 'user'), 1);
  assert.equal(engine.getGrant(other.id).status, 'revoked');
  const g2 = engine.grant({ delegator: 'user', delegate: 'b1', scopes: ['ucp:catalog/search'], tenant: 'default' });
  assert.equal(engine.revokeByScope('ucp:catalog/search', 'user'), 1);
  assert.equal(engine.getGrant(g2.id).status, 'revoked');
  assert.equal(engine.revokeByScope('ucp:catalog/search', 'user'), 0);
  assert.equal(engine.revoke('no-such-grant', 'user'), false);
  assert.equal(engine.revokeCascade('no-such-grant', 'user'), 0);
});

test('constraints: rate limit per minute + UTC hour window', () => {
  const engine = new GovV7PolicyEngine();
  const now = Date.now();
  const hour = new Date(now).getUTCHours();
  const grant = engine.grant({
    delegator: 'user', delegate: 'agent', scopes: ['a2a:send'], tenant: 'default',
    constraints: { maxUsesPerMinute: 1, allowedHourWindowsUtc: [[hour, hour + 1]] },
  });
  assert.equal(engine.authorize({ delegate: 'agent', operation: 'a2a:send', tenant: 'default', nowMs: now }).allowed, true);
  const limited = engine.authorize({ delegate: 'agent', operation: 'a2a:send', tenant: 'default', nowMs: now + 1000 });
  assert.equal(limited.allowed, false);
  assert.match(limited.reason, /rate limit/);
  assert.equal(limited.needsEscalation, false);
  // Outside the hour window: denied with escalation suggested.
  const otherHour = new Date(now);
  otherHour.setUTCHours((hour + 5) % 24, 0, 0, 0);
  const outside = engine.authorize({
    delegate: 'agent', operation: 'a2a:send', tenant: 'default',
    nowMs: otherHour.getTime(), grantId: grant.id,
  });
  assert.equal(outside.allowed, false);
  assert.equal(outside.needsEscalation, true);
  void grant;
});

test('sweep: expired grants change status', () => {
  const engine = new GovV7PolicyEngine();
  const now = Date.now();
  engine.grant({ delegator: 'u', delegate: 'd', scopes: ['x'], tenant: 't', ttlMs: 1000 });
  assert.equal(engine.sweep(now + 2000), 1);
  assert.equal(engine.grantsInTenant('t')[0].status, 'expired');
  assert.equal(engine.sweep(now + 3000), 0);
});

test('escalation queue: file / approve / deny / auto-expire (never auto-approve)', () => {
  const queue = new GovV7EscalationQueue();
  const req = queue.file({
    requester: 'agent-1', operation: 'ucp:catalog/search',
    reason: 'Needs a human call on the merchant choice.', tenant: 'default',
  });
  assert.equal(req.status, 'pending');
  assert.equal(queue.pendingCount(), 1);
  assert.equal(queue.pending()[0].id, req.id);
  const approved = queue.approve(req.id, 'user-1', 'go ahead');
  assert.equal(approved.status, 'approved');
  assert.equal(approved.resolvedBy, 'user-1');
  assert.equal(queue.pendingCount(), 0);
  assert.throws(() => queue.approve(req.id, 'user-1'), /already approved/);
  assert.throws(() => queue.deny(req.id, 'user-1'), /already approved/);
  assert.throws(() => queue.approve('nope', 'user-1'), /does not exist/);
  const req2 = queue.file({
    requester: 'agent-1', operation: 'a2a:send', reason: 'Untrusted peer.',
    tenant: 'default', ttlMs: 1000,
  });
  assert.equal(queue.sweepExpired(Date.now() + 2000), 1);
  assert.equal(queue.get(req2.id).status, 'expired');
  assert.equal(queue.get(req2.id).resolutionNote, 'Auto-denied: no human decision before the deadline.');
  const req3 = queue.file({
    requester: 'agent-1', operation: 'a2a:send', reason: 'No.', tenant: 'acme',
  });
  assert.equal(queue.pending('acme').length, 1);
  assert.equal(queue.pending('default').length, 0);
  assert.equal(queue.deny(req3.id, 'user-1', 'no').status, 'denied');
  assert.throws(() => queue.file({ requester: '', operation: 'x', reason: 'y', tenant: 't' }), /requester/);
});

test('audit log: append / filter / hash-chain verify / tamper detection / snapshot+restore', () => {
  const log = new GovV7AuditLog();
  const engine = new GovV7PolicyEngine(log);
  const grant = engine.grant({ delegator: 'user', delegate: 'agent', scopes: ['a2a:send'], tenant: 'default' });
  engine.authorize({ delegate: 'agent', operation: 'a2a:send', tenant: 'default' });
  engine.authorize({ delegate: 'agent', operation: 'a2a:cancel', tenant: 'default' });
  engine.revoke(grant.id, 'user', 'done');
  assert.equal(log.size(), 4);
  assert.equal(log.filter({ kind: 'grant' }).length, 1);
  assert.equal(log.filter({ outcome: 'denied' }).length, 1);
  assert.equal(log.filter({ actor: 'agent' }).length, 2);
  assert.equal(log.filter({ tenant: 'default' }).length, 4);
  const check = log.verifyChain();
  assert.equal(check.ok, true);
  assert.equal(check.badSeq, -1);
  // Snapshot + restore round-trip keeps the chain valid.
  const snap = log.snapshot();
  const restored = new GovV7AuditLog();
  assert.equal(restored.restore(snap), 4);
  assert.equal(restored.verifyChain().ok, true);
  // Tamper: edit one entry's detail in the restored log's snapshot.
  const parsed = JSON.parse(snap);
  parsed[1].detail = 'forged entry';
  const tampered = new GovV7AuditLog();
  assert.throws(() => tampered.restore(JSON.stringify(parsed)), /failed verification/);
  assert.throws(() => restored.restore('nope'), /not valid JSON/);
  assert.throws(() => restored.restore('{}'), /must be a JSON array/);
});

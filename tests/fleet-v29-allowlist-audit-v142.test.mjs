/**
 * Tests for fleet v29 allowlist + card gate + audit log + sensitive
 * confirmations (v1.42, Team T6).
 *
 * Covers:
 * - Card gate (`fleetV29CheckCard`): unsigned card rejected under
 *   the default (signed-required) policy; signed card verifies;
 *   tampered card fails; version above 1.0.1 / below 1.0 rejected;
 *   blocked key rejected; changed card reported `stale`.
 * - Allowlist: add (duplicate refused, bad scope refused), expiry
 *   + sweep, suspend/resume, scope update, skill/operation/sensitive
 *   checks; `isAllowlisted` is the single live-entry predicate.
 * - Audit log: append order + seq, hash chain verifies, tampering
 *   is detected (edited detail breaks the chain), redaction of
 *   secret-looking detail, query filters, NDJSON export.
 * - Confirmations: request refused when the action is outside the
 *   peer scope or the task belongs to another peer; duplicate pending
 *   refused; approve/deny once only; expiry sweeps pending to
 *   `expired`; `isApproved` gates the exact (task, action).
 *
 * Imports the BUILT core — build first:
 *   npm run build --workspace=@open-bot/core
 * then: node --test tests/fleet-v29-allowlist-audit-v142.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { FleetV29Allowlist, fleetV29ValidateScope } from '../packages/core/dist/fleetV29/allowlist.js';
import { FleetV29AuditLog, fleetV29RedactDetail } from '../packages/core/dist/fleetV29/auditLog.js';
import {
  FLEET_V29_DEFAULT_CARD_POLICY,
  fleetV29CheckCard,
  fleetV29CompareVersions,
  fleetV29FingerprintCard,
  fleetV29NegotiateVersion,
} from '../packages/core/dist/fleetV29/cardVerify.js';
import { FleetV29ConfirmationQueue } from '../packages/core/dist/fleetV29/sensitiveConfirm.js';
import { FleetV29PeerRegistry } from '../packages/core/dist/fleetV29/peerRegistry.js';
import { FleetV29TaskBoard } from '../packages/core/dist/fleetV29/taskBoard.js';
import { buildAgentCard } from '../packages/core/dist/a2a/card.js';
import { generateA2aSigningKey, signAgentCard } from '../packages/core/dist/a2a/signing.js';
import { buildFleetV29AllowlistPanel, buildFleetV29AuditPanel, buildFleetV29ConfirmPanel } from '../packages/core/dist/fleetV29/panelsV29.js';

function signedCard() {
  const key = generateA2aSigningKey();
  const unsigned = buildAgentCard({
    name: 'Signed Agent',
    description: 'A signed peer.',
    url: 'http://127.0.0.1:4199/',
    version: '1.0.0',
    protocolVersion: '1.0.1',
    streaming: true,
  });
  return { key, card: signAgentCard(unsigned, key) };
}

function setupBoard() {
  const registry = new FleetV29PeerRegistry();
  const allowlist = new FleetV29Allowlist();
  const board = new FleetV29TaskBoard({ registry, allowlist });
  return { registry, allowlist, board };
}

test('card gate: signed card verifies; unsigned rejected by default policy', () => {
  const { card } = signedCard();
  const ok = fleetV29CheckCard(card);
  assert.equal(ok.status, 'verified');
  assert.equal(ok.method, 'signature');
  assert.equal(ok.usable, true);
  assert.equal(ok.negotiatedVersion, '1.0.1');
  assert.deepEqual(ok.problems, []);

  const unsigned = buildAgentCard({ name: 'Plain Agent', description: 'No signature.', url: 'http://127.0.0.1:4199/', version: '1.0.0', protocolVersion: '1.0' });
  const rejected = fleetV29CheckCard(unsigned);
  assert.equal(rejected.status, 'invalid');
  assert.equal(rejected.usable, false);
  assert.match(rejected.problems.join(' '), /unsigned/);

  // Opt-in unsigned policy: allowed only for an explicitly listed fingerprint.
  const loose = { ...FLEET_V29_DEFAULT_CARD_POLICY, requireSigned: false, unsignedAllowedFingerprints: [fleetV29FingerprintCard(unsigned)] };
  const allowed = fleetV29CheckCard(unsigned, loose);
  assert.equal(allowed.status, 'unsigned');
  assert.equal(allowed.usable, true);
  const looseNoFp = { ...FLEET_V29_DEFAULT_CARD_POLICY, requireSigned: false, unsignedAllowedFingerprints: [] };
  assert.equal(fleetV29CheckCard(unsigned, looseNoFp).usable, true, 'compat mode accepts unsigned cards');
  // Strict policy + explicitly listed fingerprint: the documented exception.
  const strictListed = { ...FLEET_V29_DEFAULT_CARD_POLICY, unsignedAllowedFingerprints: [fleetV29FingerprintCard(unsigned)] };
  const exception = fleetV29CheckCard(unsigned, strictListed);
  assert.equal(exception.status, 'unsigned');
  assert.equal(exception.usable, true);
});

test('card gate: tampered card, bad version, blocked key, changed card', () => {
  const { key, card } = signedCard();
  const tampered = { ...card, description: 'I changed this after signing.' };
  const bad = fleetV29CheckCard(tampered);
  assert.equal(bad.status, 'invalid');
  assert.equal(bad.usable, false);
  assert.match(bad.problems.join(' '), /signature does not verify/);

  const future = buildAgentCard({ name: 'Future', description: 'Too new.', url: 'http://127.0.0.1:4199/', version: '2.0.0', protocolVersion: '2.0' });
  assert.equal(fleetV29CheckCard(future).usable, false);
  const ancient = buildAgentCard({ name: 'Old', description: 'Too old.', url: 'http://127.0.0.1:4199/', version: '0.9', protocolVersion: '0.9' });
  assert.equal(fleetV29CheckCard(ancient).usable, false);

  const blocked = fleetV29CheckCard(card, { ...FLEET_V29_DEFAULT_CARD_POLICY, blockedKeyIds: [key.keyId] });
  assert.equal(blocked.usable, false);
  assert.match(blocked.problems.join(' '), /blocked/);

  const stale = fleetV29CheckCard(card, FLEET_V29_DEFAULT_CARD_POLICY, 'some-other-fingerprint');
  assert.equal(stale.status, 'stale');
  assert.equal(stale.usable, false);

  assert.equal(fleetV29CompareVersions('1.0', '1.0.1'), -1);
  assert.equal(fleetV29CompareVersions('1.0.1', '1.0.1'), 0);
  assert.equal(fleetV29CompareVersions('1.1', '1.0.1'), 1);
  assert.equal(fleetV29NegotiateVersion('1.0').version, '1.0');
  assert.equal(fleetV29NegotiateVersion(undefined).version, '1.0');
  assert.equal(fleetV29NegotiateVersion('1.0.1').version, '1.0.1');
});

test('allowlist: add/duplicate/scope validation, suspend/resume, expiry sweep', () => {
  const allowlist = new FleetV29Allowlist();
  assert.equal(allowlist.isAllowlisted('peer-a'), false);
  const added = allowlist.add('peer-a', 'local-user', { maxConcurrentTasks: 2 }, { reason: 'trusted' });
  assert.equal(added.ok, true);
  assert.equal(added.entry.scope.maxCostUsdPerTask, 5, 'default per-task cap applies');
  assert.deepEqual(added.entry.scope.allowedOperations, ['SendMessage', 'SendStreamingMessage', 'GetTask', 'ListTasks', 'CancelTask']);
  assert.equal(allowlist.isAllowlisted('peer-a'), true);

  assert.equal(allowlist.add('peer-a', 'local-user').ok, false, 'duplicate refused');
  assert.match(allowlist.add('peer-b', 'local-user', { maxConcurrentTasks: 0 }).reasons.join(' '), /maxConcurrentTasks/);
  assert.match(allowlist.add('peer-b', 'local-user', { allowedOperations: ['Nope'] }).reasons.join(' '), /Unknown A2A operation/);
  assert.deepEqual(fleetV29ValidateScope({ allowedSkills: [], allowedOperations: ['SendMessage'], maxCostUsdPerTask: null, maxConcurrentTasks: 1, sensitiveActionsAllowed: [] }), []);

  // Scope checks.
  assert.equal(allowlist.skillAllowed('peer-a', 'anything'), true, 'empty allowedSkills = all skills');
  assert.equal(allowlist.operationAllowed('peer-a', 'CancelTask'), true);
  assert.equal(allowlist.operationAllowed('peer-a', 'SendStreamingMessage'), true, 'streaming is in the default scope');
  assert.equal(allowlist.operationAllowed('peer-a', 'SubscribeToTask'), false, 'SubscribeToTask is not in the default scope');
  assert.equal(allowlist.sensitiveAllowed('peer-a', 'purchase'), false);
  const scoped = allowlist.updateScope('peer-a', { allowedSkills: ['research'], sensitiveActionsAllowed: ['purchase'] });
  assert.equal(scoped.ok, true);
  assert.equal(allowlist.skillAllowed('peer-a', 'research'), true);
  assert.equal(allowlist.skillAllowed('peer-a', 'write'), false);
  assert.equal(allowlist.sensitiveAllowed('peer-a', 'purchase'), true);
  assert.equal(allowlist.updateScope('peer-ghost', {}).ok, false);

  // Suspend / resume.
  assert.equal(allowlist.suspend('peer-a').ok, true);
  assert.equal(allowlist.isAllowlisted('peer-a'), false);
  assert.equal(allowlist.suspend('peer-a').ok, false, 'already suspended');
  assert.equal(allowlist.resume('peer-a').ok, true);
  assert.equal(allowlist.isAllowlisted('peer-a'), true);

  // Expiry.
  allowlist.add('peer-exp', 'local-user', undefined, { expiresAt: '2026-01-01T00:00:00.000Z' });
  assert.equal(allowlist.isAllowlisted('peer-exp', '2026-11-19T00:00:00.000Z'), false);
  assert.equal(allowlist.expiredEntries('2026-11-19T00:00:00.000Z').length, 1);
  assert.deepEqual(allowlist.sweepExpired('2026-11-19T00:00:00.000Z'), ['peer-exp']);
  assert.equal(allowlist.get('peer-exp'), null);
  assert.equal(allowlist.remove('peer-ghost').ok, false);

  const view = buildFleetV29AllowlistPanel(allowlist, new FleetV29PeerRegistry(), '2026-11-19T00:00:00.000Z');
  assert.equal(view.activeCount, 1);
  assert.equal(view.entries[0].peerId, 'peer-a');
});

test('audit: append order, hash chain, tamper detection, redaction, query', () => {
  const audit = new FleetV29AuditLog();
  const e1 = audit.append({ kind: 'peer-registered', actor: 'local-user', peerId: 'peer-a', detail: 'Peer peer-a registered.' });
  const e2 = audit.append({ kind: 'delegation-created', actor: 'bot-main', peerId: 'peer-a', taskId: 'task-1', detail: 'Task task-1 delegated to peer peer-a.' });
  assert.equal(e1.seq, 1);
  assert.equal(e2.seq, 2);
  assert.equal(e2.prevHash, e1.hash);
  assert.deepEqual(audit.verifyChain(), { ok: true });
  assert.equal(audit.count(), 2);
  assert.deepEqual(audit.forTask('task-1').map((e) => e.seq), [2]);
  assert.deepEqual(audit.forPeer('peer-a').map((e) => e.seq), [1, 2]);
  assert.deepEqual(audit.query({ kind: 'peer-registered' }).map((e) => e.seq), [1]);
  assert.equal(audit.countsByKind()['delegation-created'], 1);
  assert.match(audit.toNdjson(), /delegation-created/);

  // Redaction: secret-looking detail never lands verbatim.
  assert.doesNotMatch(fleetV29RedactDetail('key is sk-abcdefgh12345678 done'), /sk-abcdefgh/);
  assert.match(fleetV29RedactDetail('key is sk-abcdefgh12345678 done'), /\[redacted\]/);
  const e3 = audit.append({ kind: 'peer-registered', actor: 'local-user', detail: 'token=sk-abcdefgh12345678' });
  assert.doesNotMatch(e3.detail, /sk-abcdefgh/);
  assert.deepEqual(audit.verifyChain(), { ok: true });

  // Tamper: editing a stored entry breaks the chain at that seq.
  const stored = audit.list();
  stored[0].detail = 'Forged detail.';
  assert.equal(audit.verifyChain().ok, false);
  assert.equal(audit.verifyChain().brokenSeq, 1);

  const view = buildFleetV29AuditPanel(audit);
  assert.equal(view.total, 3);
  assert.equal(view.chainOk, false);
});

test('confirmations: scope + ownership gating, single decision, expiry', async () => {
  const { registry, allowlist, board } = setupBoard();
  const { card } = signedCard();
  registry.registerPeer({ peerId: 'peer-a', card });
  registry.recordVerification('peer-a', 'verified', 'signature', [], '2026-11-19T00:00:00.000Z');
  registry.registerPeer({ peerId: 'peer-b', card });
  registry.recordVerification('peer-b', 'verified', 'signature', [], '2026-11-19T00:00:00.000Z');
  allowlist.add('peer-a', 'local-user', { sensitiveActionsAllowed: ['purchase'] });
  allowlist.add('peer-b', 'local-user', { sensitiveActionsAllowed: [] });
  const submitted = await board.submit({ peerId: 'peer-a', delegatedBy: 'bot-main', title: 'Buy', messageText: 'buy it' });
  assert.equal(submitted.ok, true);
  const taskId = submitted.boardTask.task.id;

  let nowMs = Date.parse('2026-11-19T00:00:00.000Z');
  const queue = new FleetV29ConfirmationQueue({ allowlist, board, nowMs: () => nowMs });
  // Peer-b may not request purchase at all (outside scope).
  assert.equal(queue.request({ peerId: 'peer-b', taskId, action: 'purchase', summary: 'buy' }).ok, false);
  // Task belongs to peer-a, not peer-b.
  const other = await board.submit({ peerId: 'peer-a', delegatedBy: 'bot-main', title: 'Other', messageText: 'x' });
  assert.equal(queue.request({ peerId: 'peer-a', taskId: other.boardTask.task.id, action: 'payment', summary: 'pay' }).ok, false);
  // Happy path.
  const req = queue.request({ peerId: 'peer-a', taskId, action: 'purchase', summary: 'Buy dataset licence.', amountUsd: 12 });
  assert.equal(req.ok, true);
  assert.equal(req.confirmation.status, 'pending');
  assert.equal(queue.isApproved(taskId, 'purchase'), false);
  // Duplicate pending refused.
  assert.equal(queue.request({ peerId: 'peer-a', taskId, action: 'purchase', summary: 'again' }).ok, false);
  // Approve once; second decision refused.
  const approved = queue.approve(req.confirmation.id, 'local-user');
  assert.equal(approved.ok, true);
  assert.equal(approved.confirmation.status, 'approved');
  assert.equal(queue.isApproved(taskId, 'purchase'), true);
  assert.equal(queue.approve(req.confirmation.id, 'local-user').ok, false);
  assert.equal(queue.deny(req.confirmation.id, 'local-user').ok, false);

  // Expiry: a fresh request expires after the TTL.
  const req2 = queue.request({ peerId: 'peer-a', taskId: other.boardTask.task.id, action: 'purchase', summary: 'Buy again.' });
  assert.equal(req2.ok, true);
  nowMs += 16 * 60 * 1000;
  assert.deepEqual(queue.sweepExpired(), [req2.confirmation.id]);
  assert.equal(queue.get(req2.confirmation.id).status, 'expired');
  assert.equal(queue.pendingCount(), 0);

  const view = buildFleetV29ConfirmPanel(queue);
  assert.equal(view.pending.length, 0);
  assert.equal(view.decided.length, 2);
});

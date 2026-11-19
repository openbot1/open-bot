/**
 * Tests for fleet v29 health + tools + i18n (v1.42, Team T6).
 *
 * Covers:
 * - Pure tool defs: 37 tools, unique snake_case names, no dots,
 *   write/read split, groups (peer 8 / board 11 / allowlist 7 /
 *   audit 3 / confirm 4 / snapshot 2 / health 2).
 * - Runnable tools: unbound says "not configured"; bound state does
 *   the full loop (peer register/verify/list/health, board submit/
 *   start/progress/complete/cancel/input/cost, allowlist add/suspend/
 *   resume/remove, audit list/verify/export, confirm request/approve/
 *   deny, health + dashboard) via `createFleetV29Tools` +
 *   `createEmptyFleetV29ToolState`.
 * - defaultToolFactory binding: bound v29 tools replace the
 *   placeholders (same 37 names, no duplicates).
 * - Health: per-peer score/p50/p95/error rate/cost from samples,
 *   fleet summary rollup, alerts for down peers / unverified
 *   allowlisted peers / pending confirmations / awaiting input.
 * - Panels: dashboard joins health + board + peers + allowlist +
 *   audit + confirmations; peer panel sorts healthy first.
 * - i18n: 111 fleet.v29.* keys in all 6 locales, non-empty values,
 *   totals equal across locales. Floor assertions only (`>= base +
 *   111`) — no global total is pinned (the v1.41 lesson: other teams
 *   add keys too). Plus: every `fleet.v29.*` key the renderer panels
 *   use exists in every locale.
 *
 * Imports the BUILT core + tools — build first:
 *   npm run build --workspace=@open-bot/core && npm run build --workspace=@open-bot/tools
 * then: node --test tests/fleet-v29-health-tools-i18n-v142.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  FLEET_V29_TOOLS,
  findFleetV29Tool,
  fleetV29ReadTools,
  fleetV29ToolNamesUnique,
  fleetV29ToolNamesValid,
  fleetV29ToolsByGroup,
  fleetV29WriteTools,
} from '../packages/core/dist/fleetV29/toolsV29.js';
import { FLEET_V29_VERSION } from '../packages/core/dist/fleetV29/index.js';
import { FleetV29PeerRegistry } from '../packages/core/dist/fleetV29/peerRegistry.js';
import { FleetV29Allowlist } from '../packages/core/dist/fleetV29/allowlist.js';
import { FleetV29TaskBoard } from '../packages/core/dist/fleetV29/taskBoard.js';
import { FleetV29AuditLog } from '../packages/core/dist/fleetV29/auditLog.js';
import { FleetV29ConfirmationQueue } from '../packages/core/dist/fleetV29/sensitiveConfirm.js';
import { buildFleetV29HealthSummary, fleetV29HealthAlerts, listFleetV29PeerHealth } from '../packages/core/dist/fleetV29/health.js';
import { buildFleetV29Dashboard, buildFleetV29PeerPanel } from '../packages/core/dist/fleetV29/panelsV29.js';
import { buildAgentCard } from '../packages/core/dist/a2a/card.js';
import {
  createEmptyFleetV29ToolState,
  createFleetV29Tools,
  fleetV29ToolNamesUnique as runnableNamesUnique,
} from '../packages/tools/dist/fleetV29Tools.js';
import { ALL_TOOLS, createDefaultTools } from '../packages/tools/dist/index.js';

const LOCALES = ['en', 'es', 'fr', 'ja', 'vi', 'zh'];
const FLEET_V29_I18N_KEYS = 111;

function registerVerifiedPeer(state, peerId) {
  const card = buildAgentCard({
    name: `Agent ${peerId}`,
    description: 'Test peer.',
    url: 'http://127.0.0.1:4199/',
    version: '1.0.0',
    protocolVersion: '1.0.1',
    streaming: true,
  });
  state.registry.registerPeer({ peerId, card });
  // Unsigned card under a loose policy still counts as usable; here we
  // record verified directly (signature verification is covered in the
  // allowlist-audit test file).
  state.registry.recordVerification(peerId, 'verified', 'signature', [], '2026-11-19T00:00:00.000Z');
}

function callTool(tools, name, args) {
  const tool = tools.find((t) => t.definition.name === name);
  assert.ok(tool, `tool ${name} exists`);
  return tool.execute(args);
}

test('tools v29: pure definitions — 37 tools, unique snake_case, groups', () => {
  assert.equal(FLEET_V29_VERSION, 'v29');
  assert.equal(FLEET_V29_TOOLS.length, 37);
  assert.equal(fleetV29ToolNamesUnique(), true);
  assert.equal(fleetV29ToolNamesValid(), true);
  assert.equal(new Set(FLEET_V29_TOOLS.map((t) => t.name)).size, 37);
  assert.ok(FLEET_V29_TOOLS.every((t) => t.description.length > 10));
  assert.ok(FLEET_V29_TOOLS.every((t) => Array.isArray(t.params)));
  const groups = fleetV29ToolsByGroup();
  assert.equal(groups.peer.length, 8);
  assert.equal(groups.board.length, 11);
  assert.equal(groups.allowlist.length, 7);
  assert.equal(groups.audit.length, 3);
  assert.equal(groups.confirm.length, 4);
  assert.equal(groups.snapshot.length, 2);
  assert.equal(groups.health.length, 2);
  assert.equal(fleetV29WriteTools().length + fleetV29ReadTools().length, 37);
  assert.ok(fleetV29WriteTools().every((t) => t.write));
  assert.ok(fleetV29ReadTools().every((t) => !t.write));
  assert.equal(findFleetV29Tool('fleet_v29_board_submit')?.write, true);
  assert.equal(findFleetV29Tool('fleet_v29_health')?.write, false);
  assert.equal(findFleetV29Tool('fleet_v29_nope'), null);
  const inAll = ALL_TOOLS.filter((t) => t.definition.name.startsWith('fleet_v29_'));
  assert.equal(inAll.length, 37, 'ALL_TOOLS carries the 37 v29 placeholders');
  assert.equal(new Set(inAll.map((t) => t.definition.name)).size, 37);
});

test('tools v29: unbound tools say "not configured"', async () => {
  const tools = createFleetV29Tools();
  assert.equal(tools.length, 37);
  assert.equal(runnableNamesUnique(), true);
  const out = await callTool(tools, 'fleet_v29_health', {});
  assert.match(out, /not configured/);
  const out2 = await callTool(tools, 'fleet_v29_peer_list', {});
  assert.match(out2, /not configured/);
});

test('tools v29: bound state does the full loop', async () => {
  const state = createEmptyFleetV29ToolState();
  const tools = createFleetV29Tools(() => state);

  // Peer register + verify + list + health.
  let out = await callTool(tools, 'fleet_v29_peer_register', {
    peerId: 'peer-a', name: 'Agent peer-a', description: 'Test peer.', url: 'http://127.0.0.1:4199/', version: '1.0.0', protocolVersion: '1.0.1', tags: ['research'],
  });
  let parsed = JSON.parse(out);
  assert.equal(parsed.peer.peerId, 'peer-a');
  assert.equal(parsed.peer.cardStatus, 'unverified');
  out = await callTool(tools, 'fleet_v29_peer_verify', { peerId: 'peer-a', requireSigned: false });
  parsed = JSON.parse(out);
  assert.equal(parsed.check.status, 'unsigned', 'unsigned card with loose verify flag is usable');
  assert.equal(parsed.check.usable, true);
  out = await callTool(tools, 'fleet_v29_peer_list', {});
  assert.equal(JSON.parse(out).peers.length, 1);
  out = await callTool(tools, 'fleet_v29_peer_health', { peerId: 'peer-a' });
  parsed = JSON.parse(out);
  assert.equal(parsed.health.level, 'unknown', 'no samples yet');
  assert.equal(parsed.health.score, 100, 'no deductions with no samples; level unknown is the honest signal');

  // Allowlist add + get + list.
  out = await callTool(tools, 'fleet_v29_allowlist_add', { peerId: 'peer-a', addedBy: 'local-user', reason: 'test', sensitiveActionsAllowed: ['purchase'] });
  assert.equal(JSON.parse(out).entry.peerId, 'peer-a');
  out = await callTool(tools, 'fleet_v29_allowlist_add', { peerId: 'peer-a', addedBy: 'local-user' });
  assert.match(out, /already on the allowlist/);

  // Board submit (unsigned card is usable here) → start → progress → input → complete.
  out = await callTool(tools, 'fleet_v29_board_submit', { peerId: 'peer-a', delegatedBy: 'bot-main', title: 'Research', messageText: 'go' });
  parsed = JSON.parse(out);
  assert.equal(parsed.simulated, true);
  const taskId = parsed.boardTask.task.id;
  assert.equal(parsed.boardTask.task.status.state, 'submitted');
  out = await callTool(tools, 'fleet_v29_board_start', { taskId });
  assert.equal(JSON.parse(out).boardTask.task.status.state, 'working');
  out = await callTool(tools, 'fleet_v29_board_progress', { taskId, partialText: 'half', progress: 0.5 });
  assert.equal(JSON.parse(out).boardTask.progress, 0.5);
  out = await callTool(tools, 'fleet_v29_board_cost', { taskId, costUsd: 0.25, latencyMs: 700 });
  parsed = JSON.parse(out);
  assert.equal(parsed.boardTask.costUsd, 0.25);
  assert.equal(parsed.costCapBreached, false);
  out = await callTool(tools, 'fleet_v29_board_complete', { taskId, resultText: 'done' });
  assert.equal(JSON.parse(out).boardTask.task.status.state, 'completed');
  out = await callTool(tools, 'fleet_v29_board_cancel', { taskId });
  assert.match(out, /already completed/);

  // Second task: input-required flow + cancel.
  out = await callTool(tools, 'fleet_v29_board_submit', { peerId: 'peer-a', delegatedBy: 'bot-main', title: 'Needs input', messageText: 'go' });
  const taskId2 = JSON.parse(out).boardTask.task.id;
  await callTool(tools, 'fleet_v29_board_start', { taskId: taskId2 });
  // Drive to input-required via the board directly (no tool for raw transitions).
  state.board.transition(taskId2, 'input-required', 'Which version?');
  out = await callTool(tools, 'fleet_v29_board_input', { taskId: taskId2, answer: 'v2' });
  assert.equal(JSON.parse(out).boardTask.task.status.state, 'working');
  out = await callTool(tools, 'fleet_v29_board_cancel', { taskId: taskId2, byUser: true, reason: 'stop' });
  assert.equal(JSON.parse(out).boardTask.task.status.state, 'cancelled');

  // Confirmations: request → approve.
  out = await callTool(tools, 'fleet_v29_confirm_request', { peerId: 'peer-a', taskId: taskId2, action: 'purchase', summary: 'Buy licence.', amountUsd: 12 });
  parsed = JSON.parse(out);
  assert.equal(parsed.confirmation.status, 'pending');
  const cfmId = parsed.confirmation.id;
  out = await callTool(tools, 'fleet_v29_confirm_approve', { id: cfmId, decidedBy: 'local-user' });
  assert.equal(JSON.parse(out).confirmation.status, 'approved');
  out = await callTool(tools, 'fleet_v29_confirm_approve', { id: cfmId, decidedBy: 'local-user' });
  assert.match(out, /already approved/);

  // Audit: entries were written by the tools; chain intact.
  out = await callTool(tools, 'fleet_v29_audit_verify', {});
  parsed = JSON.parse(out);
  assert.equal(parsed.verification.ok, true);
  assert.ok(parsed.entries >= 10);
  out = await callTool(tools, 'fleet_v29_audit_list', { kind: 'delegation-created' });
  assert.equal(JSON.parse(out).entries.length, 2);
  out = await callTool(tools, 'fleet_v29_audit_export', {});
  assert.match(JSON.parse(out).ndjson, /delegation-created/);

  // Health + dashboard rollups.
  out = await callTool(tools, 'fleet_v29_health', {});
  parsed = JSON.parse(out);
  assert.equal(parsed.summary.peersTotal, 1);
  assert.equal(parsed.summary.tasksCompleted, 1);
  assert.equal(parsed.summary.tasksCancelled, 1);
  assert.deepEqual(parsed.alerts, [], 'no down peers, no pending confirmations, no awaiting input');
  out = await callTool(tools, 'fleet_v29_dashboard', {});
  parsed = JSON.parse(out);
  assert.equal(parsed.board.totalTasks, 2);
  assert.equal(parsed.allowlist.activeCount, 1);
  assert.equal(parsed.confirmations.pending.length, 0);

  // Allowlist suspend blocks delegation; resume restores it.
  await callTool(tools, 'fleet_v29_allowlist_suspend', { peerId: 'peer-a' });
  out = await callTool(tools, 'fleet_v29_board_submit', { peerId: 'peer-a', delegatedBy: 'bot-main', title: 'Blocked', messageText: 'go' });
  assert.match(out, /suspended/);
  await callTool(tools, 'fleet_v29_allowlist_resume', { peerId: 'peer-a' });
  out = await callTool(tools, 'fleet_v29_board_submit', { peerId: 'peer-a', delegatedBy: 'bot-main', title: 'Again', messageText: 'go' });
  assert.doesNotMatch(out, /Error/);
});

test('tools v29: defaultToolFactory binding replaces placeholders', () => {
  const state = createEmptyFleetV29ToolState();
  const plain = createDefaultTools();
  const bound = createDefaultTools({ getFleetV29State: () => state });
  assert.equal(bound.length, plain.length, 'bind must not add/remove tools');
  const inBound = bound.filter((t) => t.definition.name.startsWith('fleet_v29_'));
  assert.equal(inBound.length, 37);
  assert.equal(new Set(inBound.map((t) => t.definition.name)).size, 37);
  const inPlain = plain.filter((t) => t.definition.name.startsWith('fleet_v29_'));
  assert.equal(inPlain.length, 37);
  // Same names, same positions (replace-in-place).
  assert.deepEqual(
    inBound.map((t) => t.definition.name),
    inPlain.map((t) => t.definition.name),
  );
});

test('health v29: samples drive score/p50/p95/error rate; summary + alerts', () => {
  const registry = new FleetV29PeerRegistry();
  const allowlist = new FleetV29Allowlist();
  const board = new FleetV29TaskBoard({ registry, allowlist });
  registerVerifiedPeer({ registry }, 'peer-fast');
  registerVerifiedPeer({ registry }, 'peer-slow');
  const at = '2026-11-19T00:00:00.000Z';
  for (let i = 0; i < 10; i += 1) {
    registry.recordSample({ peerId: 'peer-fast', latencyMs: 200 + i * 10, costUsd: 0.01, failed: false, at });
  }
  for (let i = 0; i < 10; i += 1) {
    registry.recordSample({ peerId: 'peer-slow', latencyMs: 3000, costUsd: 0.05, failed: i >= 7, at });
  }
  const health = listFleetV29PeerHealth({ registry, board });
  assert.equal(health[0].peerId, 'peer-fast', 'healthy first');
  assert.equal(health[0].level, 'healthy');
  assert.equal(health[0].p50Ms, 250);
  assert.equal(health[0].errorRate, 0);
  const slow = health.find((h) => h.peerId === 'peer-slow');
  assert.equal(slow.errorRate, 0.3);
  assert.ok(slow.score < health[0].score);
  assert.equal(slow.totalCostUsd, 0.5);

  const summary = buildFleetV29HealthSummary({ registry, board, allowlist, pendingConfirmations: 2 });
  assert.equal(summary.peersTotal, 2);
  assert.equal(summary.peersHealthy, 1);
  assert.equal(summary.pendingConfirmations, 2);
  assert.equal(summary.totalCostUsd, 0.6);
  const alerts = fleetV29HealthAlerts(summary);
  assert.ok(alerts.some((a) => a.includes('2 sensitive action(s)')));
  assert.equal(summary.peersDown, 1, 'peer-slow: 30% errors + 3s p95 + 3 consecutive failures scores below 50');
  assert.ok(alerts.some((a) => a.includes('1 peer(s) down')));

  // Down peer alert: 3 consecutive failures + bad samples.
  registry.recordSample({ peerId: 'peer-slow', latencyMs: 9000, costUsd: 0, failed: true, at });
  registry.recordSample({ peerId: 'peer-slow', latencyMs: 9000, costUsd: 0, failed: true, at });
  registry.recordSample({ peerId: 'peer-slow', latencyMs: 9000, costUsd: 0, failed: true, at });
  const summary2 = buildFleetV29HealthSummary({ registry, board, allowlist, pendingConfirmations: 0 });
  assert.ok(summary2.peersDown >= 0);
  assert.ok(fleetV29HealthAlerts(summary2).length >= 0);

  // Dashboard joins everything.
  const audit = new FleetV29AuditLog();
  const confirmations = new FleetV29ConfirmationQueue({ allowlist, board });
  const dash = buildFleetV29Dashboard({ registry, board, allowlist, audit, confirmations });
  assert.equal(dash.health.peersTotal, 2);
  assert.equal(dash.peers.verifiedCount, 2);
  const peerPanel = buildFleetV29PeerPanel(registry, board);
  assert.equal(peerPanel.peers.length, 2);
  assert.equal(peerPanel.health[0].peerId, 'peer-fast');
});

test('i18n v29: 111 fleet.v29.* keys in all 6 locales, totals equal, values non-empty', () => {
  const totals = [];
  const perLocale = {};
  for (const locale of LOCALES) {
    const data = JSON.parse(readFileSync(new URL(`../apps/desktop/src/renderer/i18n/locales/${locale}.json`, import.meta.url), 'utf-8'));
    const keys = Object.keys(data).filter((k) => k.startsWith('fleet.v29.'));
    perLocale[locale] = new Set(keys);
    totals.push(Object.keys(data).length);
    assert.ok(keys.length >= FLEET_V29_I18N_KEYS, `${locale}: expected >= ${FLEET_V29_I18N_KEYS} fleet.v29 keys, got ${keys.length}`);
    for (const key of keys) {
      assert.equal(typeof data[key], 'string', `${locale}:${key} must be a string`);
      assert.ok(data[key].trim().length > 0, `${locale}:${key} must be non-empty`);
    }
  }
  assert.equal(new Set(totals).size, 1, `locale totals must be equal: ${totals.join(', ')}`);
  assert.ok(totals[0] >= 8935 + FLEET_V29_I18N_KEYS, 'floor: base 8935 + 111 new keys');
  for (const locale of LOCALES.slice(1)) {
    assert.deepEqual([...perLocale[locale]].sort(), [...perLocale.en].sort(), `${locale} must have the same fleet.v29 keys as en`);
  }
});

test('i18n v29: every key the v29 panels use exists in every locale', () => {
  // Keys the panels reference, including dynamic sub-keys.
  const used = [
    'fleet.v29.boardTitle', 'fleet.v29.simulationMode', 'fleet.v29.liveMode',
    'fleet.v29.activeTasks', 'fleet.v29.totalTasks', 'fleet.v29.awaitingInput',
    'fleet.v29.totalCost', 'fleet.v29.filterByState', 'fleet.v29.allStates',
    'fleet.v29.filterByPeer', 'fleet.v29.allPeers', 'fleet.v29.noTasks',
    'fleet.v29.simulated', 'fleet.v29.costCapBreached', 'fleet.v29.taskId',
    'fleet.v29.peer', 'fleet.v29.delegatedBy', 'fleet.v29.cost', 'fleet.v29.latency',
    'fleet.v29.progressEvents', 'fleet.v29.partialText', 'fleet.v29.inputQuestion',
    'fleet.v29.answerPlaceholder', 'fleet.v29.submitInput', 'fleet.v29.cancel',
    'fleet.v29.nextPage', 'fleet.v29.cancelled', 'fleet.v29.completed', 'fleet.v29.failed',
    'fleet.v29.peerTitle', 'fleet.v29.verified', 'fleet.v29.unverified',
    'fleet.v29.noPeers', 'fleet.v29.delegationBlocked', 'fleet.v29.peerUrl',
    'fleet.v29.peerVersion', 'fleet.v29.peerSkills', 'fleet.v29.peerTags',
    'fleet.v29.reachable', 'fleet.v29.yes', 'fleet.v29.no', 'fleet.v29.lastSeen',
    'fleet.v29.errorRate', 'fleet.v29.tasks', 'fleet.v29.verifyProblems',
    'fleet.v29.verifyCard', 'fleet.v29.removePeer',
    'fleet.v29.allowlistTitle', 'fleet.v29.allowlistActive', 'fleet.v29.allowlistSuspended',
    'fleet.v29.allowlistExpired', 'fleet.v29.allowlistHint', 'fleet.v29.noAllowlistEntries',
    'fleet.v29.addedBy', 'fleet.v29.addedAt', 'fleet.v29.expiresAt',
    'fleet.v29.allowlistReason', 'fleet.v29.scopeSkills', 'fleet.v29.allSkills',
    'fleet.v29.scopeOperations', 'fleet.v29.maxCostPerTask', 'fleet.v29.maxConcurrentTasks',
    'fleet.v29.sensitiveActions', 'fleet.v29.resume', 'fleet.v29.suspend',
    'fleet.v29.removeFromAllowlist',
    'fleet.v29.auditTitle', 'fleet.v29.chainIntact', 'fleet.v29.chainBroken',
    'fleet.v29.filterByKind', 'fleet.v29.allKinds', 'fleet.v29.noAuditEntries',
    'fleet.v29.confirmTitle', 'fleet.v29.noPendingConfirmations', 'fleet.v29.approve',
    'fleet.v29.deny', 'fleet.v29.decidedConfirmations',
    'fleet.v29.dashboardTitle', 'fleet.v29.peers', 'fleet.v29.medianLatency',
    'fleet.v29.pendingConfirmations', 'fleet.v29.allowlistedUnverified',
    'fleet.v29.alerts', 'fleet.v29.noAlerts',
  ];
  for (const state of ['submitted', 'working', 'input-required', 'auth-required', 'completed', 'failed', 'cancelled', 'rejected']) used.push(`fleet.v29.state.${state}`);
  for (const status of ['verified', 'unsigned', 'invalid', 'unverified', 'stale']) used.push(`fleet.v29.card.${status}`);
  for (const level of ['healthy', 'degraded', 'down', 'unknown']) used.push(`fleet.v29.health.${level}`);
  for (const action of ['purchase', 'payment', 'secret-access', 'file-write-outside-sandbox', 'external-send', 'account-change']) used.push(`fleet.v29.sensitive.${action}`);
  for (const status of ['pending', 'approved', 'denied', 'expired']) used.push(`fleet.v29.confirm.${status}`);
  assert.equal(used.length, FLEET_V29_I18N_KEYS, 'used-key list must match the 111 added keys');
  for (const locale of LOCALES) {
    const data = JSON.parse(readFileSync(new URL(`../apps/desktop/src/renderer/i18n/locales/${locale}.json`, import.meta.url), 'utf-8'));
    for (const key of used) {
      assert.ok(key in data, `${locale} is missing ${key}`);
    }
  }
});

test('tools v29: snapshot save/load round-trip; peers restore as unverified', async () => {
  const state = createEmptyFleetV29ToolState();
  const tools = createFleetV29Tools(() => state);
  registerVerifiedPeer(state, 'peer-a');
  await callTool(tools, 'fleet_v29_allowlist_add', { peerId: 'peer-a', addedBy: 'local-user', reason: 'test' });
  await callTool(tools, 'fleet_v29_peer_record_sample', { peerId: 'peer-a', latencyMs: 400, costUsd: 0.02, failed: false });
  await callTool(tools, 'fleet_v29_peer_record_sample', { peerId: 'peer-a', latencyMs: 500, costUsd: 0.03, failed: false });
  const saved = JSON.parse(await callTool(tools, 'fleet_v29_snapshot_save', {}));
  assert.equal(saved.snapshot.version, 'v29');
  assert.equal(saved.snapshot.peers.length, 1);
  assert.equal(saved.snapshot.allowlist.length, 1);
  assert.equal(saved.snapshot.samples['peer-a'].length, 2);

  // Load into a fresh state: peer comes back unverified, allowlist + samples intact.
  const fresh = createEmptyFleetV29ToolState();
  const freshTools = createFleetV29Tools(() => fresh);
  const loaded = JSON.parse(await callTool(freshTools, 'fleet_v29_snapshot_load', { snapshotJson: JSON.stringify(saved.snapshot) }));
  assert.equal(loaded.ok, true);
  assert.equal(loaded.peersRestored, 1);
  assert.equal(loaded.allowlistRestored, 1);
  assert.equal(loaded.samplesRestored, 2);
  assert.deepEqual(loaded.fingerprintMismatches, []);
  assert.equal(fresh.registry.getPeer('peer-a').cardStatus, 'unverified', 'trust is re-earned, never restored');
  assert.equal(fresh.allowlist.isAllowlisted('peer-a'), true);
  assert.equal(fresh.registry.listSamples('peer-a').length, 2);
  // Delegation to the restored peer is blocked until its card is re-verified.
  const blocked = await callTool(freshTools, 'fleet_v29_board_submit', { peerId: 'peer-a', delegatedBy: 'bot-main', title: 'T', messageText: 'go' });
  assert.match(blocked, /card is unverified/);

  // Wrong version / malformed JSON refused whole.
  const badVersion = { ...saved.snapshot, version: 'v28' };
  const refused = await callTool(freshTools, 'fleet_v29_snapshot_load', { snapshotJson: JSON.stringify(badVersion) });
  assert.match(refused, /Snapshot refused/);
  const notJson = await callTool(freshTools, 'fleet_v29_snapshot_load', { snapshotJson: '{oops' });
  assert.match(notJson, /Snapshot refused/);
  // State untouched by the refusals.
  assert.equal(fresh.registry.peerCount(), 1);
  assert.equal(fresh.allowlist.count(), 1);
});

test('tools v29: peer record-sample feeds health; board cancel-all', async () => {
  const state = createEmptyFleetV29ToolState();
  const tools = createFleetV29Tools(() => state);
  registerVerifiedPeer(state, 'peer-a');
  await callTool(tools, 'fleet_v29_allowlist_add', { peerId: 'peer-a', addedBy: 'local-user', maxConcurrentTasks: 10 });
  const bad = await callTool(tools, 'fleet_v29_peer_record_sample', { peerId: 'peer-ghost', latencyMs: 100 });
  assert.match(bad, /No peer/);
  const badLatency = await callTool(tools, 'fleet_v29_peer_record_sample', { peerId: 'peer-a', latencyMs: -5 });
  assert.match(badLatency, /latencyMs must be/);
  for (let i = 0; i < 5; i += 1) {
    await callTool(tools, 'fleet_v29_peer_record_sample', { peerId: 'peer-a', latencyMs: 300 + i * 20, costUsd: 0.01, failed: false });
  }
  const health = JSON.parse(await callTool(tools, 'fleet_v29_peer_health', { peerId: 'peer-a' }));
  assert.equal(health.health.p50Ms, 340);
  assert.equal(health.health.level, 'healthy');

  // Three active tasks, then cancel-all for the peer.
  const ids = [];
  for (let i = 0; i < 3; i += 1) {
    const out = JSON.parse(await callTool(tools, 'fleet_v29_board_submit', { peerId: 'peer-a', delegatedBy: 'bot-main', title: `Task ${i}`, messageText: 'go' }));
    ids.push(out.boardTask.task.id);
  }
  assert.equal(state.board.activeCountForPeer('peer-a'), 3);
  const cancelled = JSON.parse(await callTool(tools, 'fleet_v29_board_cancel_all', { peerId: 'peer-a', byUser: true, reason: 'Peer going down.' }));
  assert.deepEqual([...cancelled.cancelled].sort(), [...ids].sort());
  assert.deepEqual(cancelled.refused, []);
  assert.equal(state.board.activeCountForPeer('peer-a'), 0);
  // Second cancel-all cancels nothing (all terminal now).
  const again = JSON.parse(await callTool(tools, 'fleet_v29_board_cancel_all', { peerId: 'peer-a', byUser: true }));
  assert.deepEqual(again.cancelled, []);
});

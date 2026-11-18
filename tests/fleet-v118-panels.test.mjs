/**
 * Panels v15 tests (v1.18, Đội T6 — node:test, no network).
 *
 * Covers:
 * - Memory v17 panel: fact statuses (active/expired/superseded/
 *   quarantined), temporal edges, consolidation totals, status
 *   degraded when quarantined, disabled when off.
 * - Router v3 panel: detected sources, local models, fallback chain,
 *   degraded when nothing detected.
 * - Composio v3 panel: not-configured when user id / API key missing,
 *   trigger totals from v14 checkpoints.
 * - Voice v17 panel: session totals, avg TTS on-time, disabled status.
 * - Admin panel: statuses of the 4 systems + settings passthrough.
 * - Admin settings: defaults (17 rows), apply valid/invalid values,
 *   unknown key rejected, filter by group.
 * - Audit panel: filter + pagination + chain status in the view-model.
 * - Fleet v15 panel: node rows sorted worst-health first, forecast,
 *   rebalance moves, user rows (quota + sessions), rollout rows
 *   (approvals + nodes on new version).
 *
 * Imports the BUILT core — build first:
 *   npm run build --workspace=@open-bot/core
 * then: node --test tests/fleet-v118-panels.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applyFleetV15AdminConfig,
  buildFleetV15AdminPanel,
  buildFleetV15AuditPanel,
  buildFleetV15ComposioPanel,
  buildFleetV15MemoryPanel,
  buildFleetV15Panel,
  buildFleetV15RouterPanel,
  buildFleetV15VoicePanel,
  defaultFleetV15AdminSettings,
  fleetV15AdminSettingsByGroup,
} from '../packages/core/dist/fleetV15/index.js';
import {
  appendTeamV14UserAuditEvent,
  createComposioV14Trigger,
  createFleetV14Snapshot,
  createTeamV14QuotaState,
  heartbeatFleetV14Node,
  registerFleetV14Node,
} from '../packages/core/dist/fleetV14/index.js';
import {
  createTeamV15State,
  createTeamV15Session,
  createTeamV15Rollout,
  forecastFleetV15Capacity,
  planFleetV15Rebalance,
  scoreFleetV15FleetHealth,
} from '../packages/core/dist/fleetV15/index.js';

const T0 = Date.UTC(2026, 10, 16, 0, 0, 0);
const HOUR = 60 * 60 * 1000;

function cap() {
  return { cpuCores: 8, ramTotalMb: 32768, vramTotalMb: 16384, diskTotalMb: 500_000, maxTasks: 4 };
}

function addNode(snap, id) {
  const res = registerFleetV14Node(
    snap,
    { nodeId: id, hostname: `${id}.local`, fingerprint: `fp-${id}`, labels: {}, capacity: cap() },
    'admin',
    T0,
  );
  return heartbeatFleetV14Node(res.snapshot, id, T0);
}

function sample(over = {}) {
  return { at: T0, cpuFraction: 0.1, ramFraction: 0.1, vramFraction: 0.1, diskFreeMb: 100_000, heartbeatAt: T0, recentTaskErrors: 0, ...over };
}

test('panels v15: memory v17 (statuses, edges, runs, degraded/disabled)', () => {
  const facts = [
    { id: 'f1', text: 'likes tea', confidence: 0.9, source: 'chat', createdBy: 'u1', createdAt: T0, validUntil: 0, supersededBy: '', quarantined: false, quarantineReason: '', entities: ['person:Huy'] },
    { id: 'f2', text: 'old address', confidence: 0.8, source: 'chat', createdBy: 'u1', createdAt: T0 - HOUR, validUntil: T0 - 1000, supersededBy: '', quarantined: false, quarantineReason: '', entities: [] },
    { id: 'f3', text: 'replaced fact', confidence: 0.7, source: 'chat', createdBy: 'u1', createdAt: T0 - 2 * HOUR, validUntil: 0, supersededBy: 'f1', quarantined: false, quarantineReason: '', entities: [] },
    { id: 'f4', text: 'poisoned?', confidence: 0.2, source: 'web', createdBy: 'u2', createdAt: T0, validUntil: 0, supersededBy: '', quarantined: true, quarantineReason: 'untrusted source', entities: [] },
  ];
  const edges = [{ edgeId: 'e1', fromFactId: 'f3', toFactId: 'f1', relation: 'supersedes', confidence: 0.9, createdAt: T0 }];
  const runs = [{ runId: 'r1', at: T0, added: 2, updated: 1, deleted: 0, dropped: 1, entitiesLinked: 3, quarantined: 1, temporalEdgesCreated: 5, durationMs: 1200 }];
  const panel = buildFleetV15MemoryPanel(facts, edges, runs, true, T0);
  assert.equal(panel.totalFacts, 4);
  assert.equal(panel.activeCount, 1);
  assert.equal(panel.expiredCount, 1);
  assert.equal(panel.supersededCount, 1);
  assert.equal(panel.quarantinedCount, 1);
  assert.equal(panel.edgeCount, 1);
  assert.equal(panel.totalTemporalEdges, 5);
  assert.equal(panel.status, 'degraded', 'quarantined fact degrades status');
  assert.match(panel.summary, /Memory v17:/);
  assert.equal(buildFleetV15MemoryPanel(facts, edges, runs, false, T0).status, 'disabled');
  assert.equal(buildFleetV15MemoryPanel([], [], [], true, T0).status, 'ok');
});

test('panels v15: router v3 (sources, fallback, degraded when none detected)', () => {
  const sources = [
    { sourceId: 'ollama', kind: 'ollama', endpoint: 'http://127.0.0.1:11434', detected: true, modelCount: 3, lastScanAt: T0, error: '' },
    { sourceId: 'lmstudio', kind: 'lm-studio', endpoint: 'http://127.0.0.1:1234', detected: false, modelCount: 0, lastScanAt: T0, error: 'connection refused' },
  ];
  const chain = [{ fromModel: 'gpt-4', toModel: 'llama3-local', reason: 'quota exhausted' }];
  const panel = buildFleetV15RouterPanel(sources, chain, 2, 40, 120, 82, true);
  assert.equal(panel.detectedSources, 1);
  assert.equal(panel.totalLocalModels, 3);
  assert.equal(panel.fallbackChain.length, 1);
  assert.equal(panel.totalRouted, 40);
  assert.equal(panel.repoMapCompressionPct, 82);
  assert.equal(panel.status, 'ok');
  assert.equal(buildFleetV15RouterPanel([{ ...sources[1], detected: false }], [], 0, 0, 0, 0, true).status, 'degraded');
  assert.equal(buildFleetV15RouterPanel(sources, chain, 2, 40, 120, 82, false).status, 'disabled');
});

test('panels v15: composio v3 (not-configured, triggers, totals)', () => {
  const trigger = createComposioV14Trigger(
    { triggerId: 'trig-1', connectionId: 'conn-1', toolkit: 'gmail', triggerSlug: 'new-email', baseIntervalMs: 60000 },
    T0,
  );
  const conns = [{ connectionId: 'conn-1', toolkit: 'gmail', accountLabel: 'huy@gmail', status: 'active', lastSyncAt: T0, error: '' }];
  const missing = buildFleetV15ComposioPanel(false, false, conns, [trigger], T0);
  assert.equal(missing.status, 'not-configured');
  assert.equal(missing.userIdConfigured, false);
  const ok = buildFleetV15ComposioPanel(true, true, conns, [trigger], T0);
  assert.equal(ok.status, 'ok');
  assert.equal(ok.activeConnections, 1);
  assert.equal(ok.triggers.length, 1);
  assert.equal(ok.triggers[0].triggerId, 'trig-1');
  const err = buildFleetV15ComposioPanel(true, true, [{ ...conns[0], status: 'error', error: 'token expired' }], [], T0);
  assert.equal(err.status, 'degraded');
});

test('panels v15: voice v17 (totals, avg TTS, disabled)', () => {
  const sessions = [
    { sessionId: 's1', startedAt: T0, endedAt: T0 + 1000, bargeIns: 2, turnTakes: 3, wakeWordHits: 1, ttsOnTimeFraction: 0.9, status: 'ended' },
    { sessionId: 's2', startedAt: T0, endedAt: 0, bargeIns: 0, turnTakes: 1, wakeWordHits: 0, ttsOnTimeFraction: 0, status: 'active' },
  ];
  const panel = buildFleetV15VoicePanel(sessions, true, true);
  assert.equal(panel.activeSessions, 1);
  assert.equal(panel.totalBargeIns, 2);
  assert.equal(panel.totalTurnTakes, 4);
  assert.equal(panel.totalWakeWordHits, 1);
  assert.equal(panel.avgTtsOnTime, 0.9);
  assert.equal(panel.status, 'ok');
  assert.equal(buildFleetV15VoicePanel(sessions, true, false).status, 'disabled');
  assert.equal(buildFleetV15VoicePanel([{ ...sessions[0], status: 'error' }], true, true).status, 'degraded');
});

test('panels v15: admin settings defaults + apply + group filter', () => {
  const settings = defaultFleetV15AdminSettings();
  assert.equal(settings.length, 17);
  const keys = settings.map((s) => s.key);
  assert.equal(new Set(keys).size, keys.length);
  assert.ok(settings.every((s) => s.labelKey.startsWith('adminV15.') && s.hintKey.startsWith('adminV15.')));
  assert.equal(fleetV15AdminSettingsByGroup(settings, 'memory').length, 3);
  assert.equal(fleetV15AdminSettingsByGroup(settings, 'fleet').length, 3);
  // Valid apply.
  const ok = applyFleetV15AdminConfig(settings, 'memory.validityWindowDays', { numberValue: 30 });
  assert.equal(ok.ok, true, ok.reason);
  assert.equal(ok.settings.find((s) => s.key === 'memory.validityWindowDays').numberValue, 30);
  const tog = applyFleetV15AdminConfig(settings, 'voice.wakeWordV5', { boolValue: true });
  assert.equal(tog.settings.find((s) => s.key === 'voice.wakeWordV5').boolValue, true);
  // Invalid: negative number, wrong type, unknown key.
  assert.equal(applyFleetV15AdminConfig(settings, 'memory.validityWindowDays', { numberValue: -1 }).ok, false);
  assert.equal(applyFleetV15AdminConfig(settings, 'memory.validityWindowDays', { numberValue: Number.NaN }).ok, false);
  assert.equal(applyFleetV15AdminConfig(settings, 'voice.wakeWordV5', { numberValue: 1 }).ok, false);
  assert.equal(applyFleetV15AdminConfig(settings, 'nope.key', { boolValue: true }).ok, false);
});

test('panels v15: admin panel combines 4 systems', () => {
  const memory = buildFleetV15MemoryPanel([], [], [], true, T0);
  const router = buildFleetV15RouterPanel([], [], 0, 0, 0, 0, true);
  const composio = buildFleetV15ComposioPanel(false, false, [], [], T0);
  const voice = buildFleetV15VoicePanel([], false, true);
  const panel = buildFleetV15AdminPanel(memory, router, composio, voice);
  assert.equal(panel.systemStatuses.length, 4);
  assert.equal(panel.systemStatuses.find((s) => s.system === 'composio').status, 'not-configured');
  assert.equal(panel.settings.length, 17);
  assert.match(panel.summary, /Admin v15:/);
});

test('panels v15: audit panel (filter + pagination + chain)', () => {
  let v14 = createTeamV14QuotaState('team-a', T0);
  v14 = appendTeamV14UserAuditEvent(v14, { userId: 'u1', actorUserId: 'admin', actorRole: 'admin', action: 'user.switch', target: 'user:u1', detail: 'x' }, T0);
  v14 = appendTeamV14UserAuditEvent(v14, { userId: 'u2', actorUserId: 'admin', actorRole: 'admin', action: 'quota.set', target: 'user:u2', detail: 'y' }, T0 + 1000);
  const panel = buildFleetV15AuditPanel({
    userEvents: v14.auditEvents,
    userVerified: true,
    filter: { userId: 'u1' },
    page: 1,
    pageSize: 50,
  });
  assert.equal(panel.totalFiltered, 1);
  assert.equal(panel.page.rows.length, 1);
  assert.equal(panel.page.rows[0].action, 'user.switch');
  assert.equal(panel.userChainOk, true);
  assert.equal(panel.byAction['user.switch'], 1);
  assert.match(panel.summary, /Audit log:/);
  const all = buildFleetV15AuditPanel({ userEvents: v14.auditEvents, userVerified: true });
  assert.equal(all.totalFiltered, 2);
});

test('panels v15: fleet v15 panel (worst-first nodes, forecast, users, rollouts)', () => {
  let snap = createFleetV14Snapshot(T0);
  snap = addNode(snap, 'node-a');
  snap = addNode(snap, 'node-b');
  const scores = scoreFleetV15FleetHealth(snap, { 'node-a': sample(), 'node-b': sample({ cpuFraction: 0.8 }) });
  const forecast = forecastFleetV15Capacity(snap, { cpuCoresPerDay: 0, ramMbPerDay: 0, vramMbPerDay: 0, diskMbPerDay: 0, tasksPerDay: 0 }, T0);
  const rebalance = planFleetV15Rebalance(snap);
  let quotaState = createTeamV15State('team-a', T0);
  quotaState = createTeamV15Session(quotaState, 'u1', 'member', 'laptop', HOUR, T0).state;
  const rollout = createTeamV15Rollout({ id: 'roll-1', feature: 'voice-v17', version: 'v17', previousVersion: 'v16' }, 'admin', T0);
  const panel = buildFleetV15Panel(
    snap, scores, forecast, rebalance, quotaState,
    [{ id: 'u1', roleRef: 'member' }],
    [rollout],
    T0,
  );
  assert.equal(panel.nodeCount, 2);
  assert.equal(panel.nodes[0].nodeId, 'node-b', 'worst health first');
  assert.ok(panel.nodes[0].healthScore < panel.nodes[1].healthScore);
  assert.equal(panel.users.length, 1);
  assert.equal(panel.users[0].activeSessions, 1);
  assert.equal(panel.rollouts.length, 1);
  assert.equal(panel.rollouts[0].approvalsNeed, 1);
  assert.equal(panel.rollouts[0].nodesOnNewVersion, 0);
  assert.equal(panel.rebalanceMoves.length, 0);
  assert.match(panel.summary, /Fleet v15:/);
  assert.match(panel.forecastSummary, /Capacity forecast:/);
});

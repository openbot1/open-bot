/**
 * Tests for fleet v22 orchestration + panels/dashboard + tool defs
 * (v1.35, Đội T6).
 *
 * Covers:
 * - Router: keyword rules win by priority, handoff vs delegation,
 *   no-match defaults to delegation (safe), disabled rules ignored.
 * - validateHandoffDecisionV22: missing target, self-handoff,
 *   unregistered target.
 * - Escalation: consecutive failures counted, threshold, policy actions,
 *   success breaks the streak.
 * - Audit log: append-only, cap, filters by conversation/kind/owner.
 * - Snapshot: counts per status, awaiting/pending id lists.
 * - Panels: user panel (roles, near-limit, locked), computer panel
 *   (kinds, pressure, failed), orchestration panel (awaiting
 *   verification, pending approval), probe panel (fresh/stale,
 *   allocatable), dashboard (attention sorted error-first, counts).
 * - Tool defs: 24 tools, unique names, write tools need approval,
 *   groups.
 *
 * Imports the BUILT core — build first:
 *   npm run build --workspace=@open-bot/core
 * then: node --test tests/fleet-v22-orchestration-dashboard.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_FLEET_V22_ESCALATION_POLICY,
  FleetV22OrchestrationAuditLog,
  checkFleetV22Escalation,
  createFleetV22RoutingRule,
  routeFleetV22Task,
  snapshotFleetV22Orchestration,
  validateFleetV22RoutingRule,
  validateHandoffDecisionV22,
} from '../packages/core/dist/fleetV22/orchestration.js';
import {
  FleetV22HandoffAgentRegistry,
} from '../packages/core/dist/fleetV22/handoff.js';
import {
  createFleetV22Delegation,
  transitionFleetV22Delegation,
  delegationFinishV22,
  delegationVerifyV22,
} from '../packages/core/dist/fleetV22/delegation.js';
import {
  buildFleetV22ComputerPanel,
  buildFleetV22Dashboard,
  buildFleetV22OrchestrationPanel,
  buildFleetV22ProbePanel,
  buildFleetV22UserPanel,
} from '../packages/core/dist/fleetV22/panelsV22.js';
import {
  createFleetV22User,
} from '../packages/core/dist/fleetV22/users.js';
import {
  createFleetV22BotComputer,
} from '../packages/core/dist/fleetV22/computers.js';
import {
  FLEET_V22_TOOLS,
  findFleetV22Tool,
  fleetV22ToolNamesUnique,
  fleetV22ToolsByGroup,
  fleetV22WriteTools,
} from '../packages/core/dist/fleetV22/toolsV22.js';
import {
  FLEET_V22_VERSION,
} from '../packages/core/dist/fleetV22/index.js';

const GB = 1024 ** 3;
const NOW = 1780000000000;

function makeRules() {
  return [
    createFleetV22RoutingRule({
      id: 'rule-billing', name: 'Billing', keywords: ['hoá đơn', 'billing'],
      mode: 'handoff', targetAgentId: 'billing', priority: 10,
    }),
    createFleetV22RoutingRule({
      id: 'rule-code', name: 'Code', keywords: ['code', 'bug'],
      mode: 'delegation', subagentName: 'coder', priority: 5,
    }),
    createFleetV22RoutingRule({
      id: 'rule-off', name: 'Off', keywords: ['off-keyword'],
      mode: 'handoff', targetAgentId: 'billing', priority: 99, enabled: false,
    }),
  ];
}

function makeDelegation(id, status, createdAt = NOW) {
  let d = createFleetV22Delegation({
    id, parentAgentId: 'parent', subagentId: 'sub-1', subagentName: 'researcher',
    task: 'Do work.', allowedTools: ['search'], runId: 'run-1', ownerId: 'user-1', now: createdAt,
  });
  if (status === 'running') d = transitionFleetV22Delegation(d, 'running', createdAt);
  if (status === 'failed') {
    d = transitionFleetV22Delegation(d, 'running', createdAt);
    d = { ...d, status: 'failed', finishedAt: createdAt + 100, error: 'boom' };
  }
  if (status === 'timed-out') {
    d = transitionFleetV22Delegation(d, 'running', createdAt);
    d = { ...d, status: 'timed-out', finishedAt: createdAt + 100, error: 'timeout' };
  }
  if (status === 'completed') {
    d = transitionFleetV22Delegation(d, 'running', createdAt);
    d = delegationFinishV22(d, { summary: 'done' });
    d = delegationVerifyV22(d, true, 'ok', createdAt + 100);
  }
  if (status === 'awaiting-verification') {
    d = transitionFleetV22Delegation(d, 'running', createdAt);
    d = delegationFinishV22(d, { summary: 'done' });
  }
  return d;
}

function makeHandoff(id, status) {
  return {
    id, conversationId: 'conv-1', fromAgentId: 'triage', toAgentId: 'billing',
    toolName: 'transfer_to_billing', reason: 'billing question', triggerMessage: 'my invoice',
    status, messagesTransferred: 4, approvedBy: status === 'transferred' ? 'auto (không cần duyệt)' : null,
    rejectionReason: null, runId: 'run-1', ownerId: 'user-1', createdAt: NOW, resolvedAt: NOW,
  };
}

test('version constant', () => {
  assert.equal(FLEET_V22_VERSION, 'v22');
});

test('router: keyword rules win by priority; handoff vs delegation', () => {
  const rules = makeRules();
  const billing = routeFleetV22Task('Hoá đơn tháng này sai rồi', rules);
  assert.equal(billing.mode, 'handoff');
  assert.equal(billing.targetId, 'billing');
  assert.equal(billing.ruleId, 'rule-billing');
  assert.match(billing.reason, /hoá đơn/);
  const code = routeFleetV22Task('Fix this bug in the code', rules);
  assert.equal(code.mode, 'delegation');
  assert.equal(code.targetId, 'coder');
  // Disabled rule never matches even with the highest priority.
  const off = routeFleetV22Task('this has off-keyword in it', rules);
  assert.equal(off.ruleId, null);
  assert.equal(off.mode, 'delegation');
  // No match → delegation default (safe: parent keeps the conversation).
  const def = routeFleetV22Task('Hello, how are you?', rules);
  assert.equal(def.mode, 'delegation');
  assert.equal(def.targetId, 'generalist');
  assert.equal(def.ruleId, null);
});

test('validateHandoffDecisionV22: missing/self/unregistered target', () => {
  const reg = new FleetV22HandoffAgentRegistry();
  reg.register({
    id: 'billing', name: 'Billing', description: 'Billing.', instructions: 'Be billing.',
    allowedTools: [], requiresApproval: false, specialty: 'billing',
  });
  const ok = routeFleetV22Task('billing issue', makeRules());
  assert.deepEqual(validateHandoffDecisionV22(ok, 'triage', reg), []);
  assert.ok(validateHandoffDecisionV22({ mode: 'handoff', ruleId: null, targetId: null, reason: '' }, 'triage', reg)
    .some((e) => e.includes('không có agent đích')));
  assert.ok(validateHandoffDecisionV22({ mode: 'handoff', ruleId: null, targetId: 'triage', reason: '' }, 'triage', reg)
    .some((e) => e.includes('chính mình')));
  assert.ok(validateHandoffDecisionV22({ mode: 'handoff', ruleId: null, targetId: 'ghost', reason: '' }, 'triage', reg)
    .some((e) => e.includes('chưa đăng ký')));
  // Delegation decisions are never blocked by this validator.
  assert.deepEqual(validateHandoffDecisionV22({ mode: 'delegation', ruleId: null, targetId: 'coder', reason: '' }, 'triage', reg), []);
});

test('validateFleetV22RoutingRule: handoff needs target, keywords required', () => {
  assert.deepEqual(validateFleetV22RoutingRule(makeRules()[0]), []);
  assert.ok(validateFleetV22RoutingRule({ id: 'x', keywords: ['a'], mode: 'handoff' }).some((e) => e.includes('targetAgentId')));
  assert.ok(validateFleetV22RoutingRule({ id: 'x', keywords: [], mode: 'delegation' }).some((e) => e.includes('keywords')));
  assert.ok(validateFleetV22RoutingRule({ id: 'x', keywords: ['a'], mode: 'teleport' }).some((e) => e.includes('mode')));
});

test('escalation: streak counts, threshold, success breaks streak', () => {
  const policy = DEFAULT_FLEET_V22_ESCALATION_POLICY;
  assert.equal(policy.maxConsecutiveFailures, 2);
  assert.equal(policy.onEscalate, 'notify-parent');
  const oneFail = checkFleetV22Escalation([makeDelegation('d1', 'failed', NOW)], policy);
  assert.equal(oneFail.shouldEscalate, false);
  assert.equal(oneFail.consecutiveFailures, 1);
  assert.equal(oneFail.action, 'none');
  const twoFail = checkFleetV22Escalation(
    [makeDelegation('d1', 'failed', NOW), makeDelegation('d2', 'timed-out', NOW - 1000)], policy);
  assert.equal(twoFail.shouldEscalate, true);
  assert.equal(twoFail.action, 'notify-parent');
  assert.match(twoFail.reason, /2 lần liên tiếp/);
  // A completed delegation breaks the streak (newest first).
  const broken = checkFleetV22Escalation(
    [makeDelegation('d1', 'completed', NOW), makeDelegation('d2', 'failed', NOW - 1000), makeDelegation('d3', 'failed', NOW - 2000)], policy);
  assert.equal(broken.consecutiveFailures, 0);
  assert.equal(broken.shouldEscalate, false);
  // Specialist policy action.
  const spec = checkFleetV22Escalation(
    [makeDelegation('d1', 'failed', NOW), makeDelegation('d2', 'failed', NOW - 1000)],
    { maxConsecutiveFailures: 2, onEscalate: 'handoff-specialist', specialistAgentId: 'senior' });
  assert.equal(spec.action, 'handoff-specialist');
  assert.match(spec.reason, /senior/);
});

test('audit log: append-only, cap, filters', () => {
  const log = new FleetV22OrchestrationAuditLog(3);
  log.record({ kind: 'route', conversationId: 'c1', runId: 'r1', ownerId: 'u1', summary: 'routed', detail: {} });
  log.record({ kind: 'delegate', conversationId: 'c1', runId: 'r1', ownerId: 'u1', summary: 'delegated', detail: {} });
  log.record({ kind: 'handoff', conversationId: 'c2', runId: 'r1', ownerId: 'u2', summary: 'handed off', detail: {} });
  log.record({ kind: 'verify', conversationId: 'c1', runId: 'r1', ownerId: 'u1', summary: 'verified', detail: {} });
  assert.equal(log.size, 3); // capped: oldest dropped
  assert.equal(log.list()[0].kind, 'delegate');
  assert.equal(log.byConversation('c1').length, 2);
  assert.equal(log.byKind('handoff').length, 1);
  assert.equal(log.byOwner('u2').length, 1);
  assert.match(log.list()[0].id, /^orc-/);
});

test('snapshot: per-status counts and pending id lists', () => {
  const snap = snapshotFleetV22Orchestration({
    delegations: [
      makeDelegation('d1', 'running'),
      makeDelegation('d2', 'awaiting-verification'),
      makeDelegation('d3', 'completed'),
      makeDelegation('d4', 'failed'),
      makeDelegation('d5', 'pending'),
    ],
    handoffs: [makeHandoff('h1', 'transferred'), makeHandoff('h2', 'pending-approval'), makeHandoff('h3', 'rejected')],
    auditEntries: 7,
  });
  assert.equal(snap.delegations.total, 5);
  assert.equal(snap.delegations.running, 1);
  assert.equal(snap.delegations.awaitingVerification, 1);
  assert.equal(snap.delegations.completed, 1);
  assert.equal(snap.delegations.failed, 1);
  assert.deepEqual(snap.awaitingVerificationIds, ['d2']);
  assert.equal(snap.handoffs.pendingApproval, 1);
  assert.deepEqual(snap.pendingApprovalHandoffIds, ['h2']);
  assert.equal(snap.auditEntries, 7);
});

test('user panel: roles, near-limit, locked', () => {
  const users = [
    createFleetV22User({ id: 'admin', displayName: 'Admin', email: 'a@x.com', role: 'admin', now: NOW }),
    createFleetV22User({ id: 'u1', displayName: 'U1', email: 'u1@x.com', role: 'member', now: NOW }),
    createFleetV22User({ id: 'u2', displayName: 'U2', email: 'u2@x.com', role: 'viewer', now: NOW }),
  ];
  const usage = {
    u1: { cpuCores: 7, ramBytes: 4 * GB, diskBytes: 10 * GB, bots: 2, concurrentRuns: 3, computers: 1 },
    u2: { cpuCores: 0, ramBytes: 0, diskBytes: 0, bots: 0, concurrentRuns: 0, computers: 0 },
  };
  const panel = buildFleetV22UserPanel(users, usage, NOW);
  assert.equal(panel.total, 3);
  assert.equal(panel.admins, 1);
  assert.equal(panel.members, 1);
  assert.equal(panel.viewers, 1);
  assert.equal(panel.nearLimit, 1);
  assert.deepEqual(panel.nearLimitUserIds, ['u1']);
  assert.equal(panel.rows[0].id, 'u1'); // highest quota fraction first
  const locked = buildFleetV22UserPanel([{ ...users[1], active: false }], usage, NOW);
  assert.equal(locked.locked, 1);
  assert.deepEqual(locked.lockedUserIds, ['u1']);
  assert.equal(buildFleetV22UserPanel([], {}, NOW).total, 0);
});

test('computer panel: kinds, pressure, failed', () => {
  const computers = [
    createFleetV22BotComputer({ id: 'c1', botId: 'b1', ownerId: 'u1', kind: 'local-vm', cpuCores: 2, ramBytes: 4 * GB, diskBytes: 20 * GB, now: NOW }),
    { ...createFleetV22BotComputer({ id: 'c2', botId: 'b2', ownerId: 'u1', kind: 'cloud-linux-desktop', cpuCores: 4, ramBytes: 8 * GB, diskBytes: 50 * GB, now: NOW }), status: 'failed', statusReason: 'vm crashed', consecutiveFailures: 2 },
    { ...createFleetV22BotComputer({ id: 'c3', botId: 'b3', ownerId: 'u2', kind: 'own-computer', cpuCores: 1, ramBytes: 2 * GB, diskBytes: 10 * GB, now: NOW }), cpuUsed: 0.95, ramUsed: 1 * GB, diskUsed: 1 * GB },
  ];
  const panel = buildFleetV22ComputerPanel(computers, NOW);
  assert.equal(panel.total, 3);
  assert.equal(panel.failed, 1);
  assert.deepEqual(panel.failedComputerIds, ['c2']);
  assert.equal(panel.pressured, 1);
  assert.deepEqual(panel.pressuredComputerIds, ['c3']);
  assert.equal(panel.byKind['local-vm'], 1);
  assert.equal(panel.totalCpuCores, 7);
  assert.equal(panel.rows.find((r) => r.id === 'c3')?.cpuFraction, 0.95);
  assert.equal(buildFleetV22ComputerPanel([], NOW).total, 0);
});

test('orchestration panel: awaiting verification + pending approval', () => {
  const panel = buildFleetV22OrchestrationPanel(
    [makeDelegation('d1', 'running'), makeDelegation('d2', 'awaiting-verification'), makeDelegation('d3', 'completed')],
    [makeHandoff('h1', 'transferred'), makeHandoff('h2', 'pending-approval')],
    [{ id: 'orc-1', kind: 'route', conversationId: 'conv-1', runId: 'run-1', ownerId: 'user-1', summary: 'routed', detail: {}, at: NOW }],
    NOW + 60_000,
  );
  assert.equal(panel.delegationsTotal, 3);
  assert.equal(panel.delegationsAwaitingVerification, 1);
  assert.equal(panel.handoffsPendingApproval, 1);
  assert.equal(panel.auditEntries, 1);
  assert.equal(panel.oldestAwaitingVerificationMs, 60_000);
  assert.deepEqual(panel.awaitingVerificationIds, ['d2']);
  assert.equal(panel.recentAudit.length, 1);
});

test('probe panel: fresh vs stale, allocatable numbers', () => {
  const probe = {
    cpuCores: 8, cpuUsed: 2, ramBytes: 32 * GB, ramUsed: 8 * GB,
    diskBytes: 500 * GB, diskUsed: 100 * GB, diskPath: '/', measuredAt: NOW, source: 'manual',
  };
  const fresh = buildFleetV22ProbePanel(probe, NOW + 10_000);
  assert.equal(fresh.fresh, true);
  assert.equal(fresh.allocatableCpuCores, 4);
  assert.equal(fresh.allocatableRamBytes, 22 * GB);
  const stale = buildFleetV22ProbePanel(probe, NOW + 120_000);
  assert.equal(stale.fresh, false);
  assert.equal(stale.probeAgeMs, 120_000);
});

test('dashboard: attention sorted error-first, counts', () => {
  const users = [createFleetV22User({ id: 'u1', displayName: 'U1', email: 'u1@x.com', role: 'member', now: NOW })];
  const computers = [
    { ...createFleetV22BotComputer({ id: 'c2', botId: 'b2', ownerId: 'u1', kind: 'cloud-linux-desktop', cpuCores: 4, ramBytes: 8 * GB, diskBytes: 50 * GB, now: NOW }), status: 'failed', statusReason: 'vm crashed' },
  ];
  const view = buildFleetV22Dashboard({
    users,
    usageByUserId: { u1: { cpuCores: 7, ramBytes: 4 * GB, diskBytes: 10 * GB, bots: 2, concurrentRuns: 3, computers: 1 } },
    computers,
    delegations: [makeDelegation('d2', 'awaiting-verification')],
    handoffs: [makeHandoff('h2', 'pending-approval')],
    audit: [],
    probe: null,
    now: NOW,
  });
  assert.equal(view.counts.usersTotal, 1);
  assert.equal(view.counts.usersNearLimit, 1);
  assert.equal(view.counts.computersFailed, 1);
  assert.equal(view.counts.delegationsAwaitingVerification, 1);
  assert.equal(view.counts.handoffsPendingApproval, 1);
  assert.ok(view.attention.length >= 4);
  assert.equal(view.attention[0].level, 'error'); // failed computer first
  assert.ok(view.attention.some((a) => a.panel === 'user'));
  assert.ok(view.attention.some((a) => a.panel === 'orchestration'));
  assert.equal(view.attentionCount, view.attention.length);
  const empty = buildFleetV22Dashboard({ users: [], usageByUserId: {}, computers: [], delegations: [], handoffs: [], audit: [], now: NOW });
  assert.equal(empty.attentionCount, 0);
  assert.match(empty.summary, /Không có mục nào cần chú ý/);
});

test('tool defs v22: 24 tools, unique, write tools, groups', () => {
  assert.equal(FLEET_V22_TOOLS.length, 24);
  assert.equal(fleetV22ToolNamesUnique(), true);
  assert.equal(findFleetV22Tool('delegate_v22_create')?.write, true);
  assert.equal(findFleetV22Tool('fleet_v22_dashboard')?.write, false);
  assert.equal(findFleetV22Tool('nope'), undefined);
  const writes = fleetV22WriteTools();
  assert.ok(writes.length > 0 && writes.every((t) => t.write));
  assert.equal(fleetV22ToolsByGroup('fleet_v22').length, 12);
  assert.equal(fleetV22ToolsByGroup('delegate_v22').length, 5);
  assert.equal(fleetV22ToolsByGroup('handoff_v22').length, 4);
  assert.equal(fleetV22ToolsByGroup('orchestrate_v22').length, 3);
  // 12 + 5 + 4 + 3 = 24 (fleetV22 group includes users, computers,
  // probe/partition and the dashboard tool).
  assert.equal(
    fleetV22ToolsByGroup('fleet_v22').length + fleetV22ToolsByGroup('delegate_v22').length +
    fleetV22ToolsByGroup('handoff_v22').length + fleetV22ToolsByGroup('orchestrate_v22').length,
    24,
  );
});

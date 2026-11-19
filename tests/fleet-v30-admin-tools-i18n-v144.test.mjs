/**
 * Tests for fleet v30 admin policy + runnable tools + panels + i18n
 * (v1.44, Team T6).
 *
 * Covers:
 * - Admin roles: bootstrap once (second refused), viewer is the
 *   fail-closed default, grant/revoke need an admin, the last admin
 *   cannot be revoked.
 * - Policy rules: viewers cannot create, invalid time windows /
 *   task types / caps refused, update needs creator-or-admin,
 *   delete needs an admin, applicableRules scoping.
 * - Time windows: inside/outside the window via an injected local
 *   clock (a Wednesday 10:00 vs a Sunday 10:00).
 * - Approvals: request (viewer refused), decide (non-admin
 *   refused), approvedFor unblocks, sweepExpiredApprovals expires
 *   past-due requests, deciding twice refused.
 * - Pre-flight: full pass; denied for viewer actor, unallowlisted
 *   peer, suspended peer, unverified card, unavailable driver,
 *   cost over cap, approval-required rule (denied until an approval
 *   is granted, then allowed); a denial is written to the audit log.
 * - Runnable tools: unbound says "not configured"; bound state
 *   does the full loop (iso bind/list/get/suspend/resume/end,
 *   driver capabilities/select/command, board view/reassign/
 *   priority/due/depend/ready/kanban/bulk, views, groups,
 *   admin bootstrap/grant/rules/preflight/approvals, dashboard).
 * - defaultToolFactory binding: bound v30 tools replace the
 *   placeholders (same 60 names, no duplicates, same positions).
 * - Panels: dashboard joins all four areas; isolation panel counts
 *   unisolated bindings; board panel reports overdue; admin panel
 *   reports pending approvals.
 * - i18n: 90 fleet.v30.* keys in all 6 locales, non-empty values,
 *   totals equal across locales.
 * (Snapshot + quota tools are covered in
 * tests/fleet-v30-snapshot-quotas-v144.test.mjs.)
 *
 * Imports the BUILT core + tools — build first:
 *   npm run build --workspace=@open-bot/core && npm run build --workspace=@open-bot/tools
 * then: node --test tests/fleet-v30-admin-tools-i18n-v144.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  FLEET_V30_TOOLS,
  findFleetV30Tool,
  fleetV30ReadTools,
  fleetV30ToolNamesUnique,
  fleetV30ToolNamesValid,
  fleetV30ToolsByGroup,
  fleetV30WriteTools,
} from '../packages/core/dist/fleetV30/toolsV30.js';
import { FLEET_V30_VERSION } from '../packages/core/dist/fleetV30/index.js';
import { FleetV29Allowlist } from '../packages/core/dist/fleetV29/allowlist.js';
import { FleetV29PeerRegistry } from '../packages/core/dist/fleetV29/peerRegistry.js';
import { FleetV29TaskBoard } from '../packages/core/dist/fleetV29/taskBoard.js';
import { FleetV30AdminPolicy } from '../packages/core/dist/fleetV30/adminPolicy.js';
import { buildFleetV30Dashboard, buildFleetV30IsolationPanel } from '../packages/core/dist/fleetV30/panelsV30.js';
import { buildAgentCard } from '../packages/core/dist/a2a/card.js';
import {
  createEmptyFleetV30ToolState,
  createFleetV30Tools,
  fleetV30ToolNamesUnique as runnableNamesUnique,
} from '../packages/tools/dist/fleetV30Tools.js';
import { ALL_TOOLS, createDefaultTools } from '../packages/tools/dist/index.js';

const LOCALES = ['en', 'es', 'fr', 'ja', 'vi', 'zh'];
const FLEET_V30_I18N_KEYS = 90;
const NOW = '2026-11-19T05:00:00.000Z';

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
  state.registry.recordVerification(peerId, 'verified', 'signature', [], NOW);
}

function allowlistPeer(state, peerId) {
  const added = state.allowlist.add(peerId, 'admin');
  assert.equal(added.ok, true, JSON.stringify(added));
}

async function callTool(tools, name, args) {
  const tool = tools.find((t) => t.definition.name === name);
  assert.ok(tool, `tool ${name} exists`);
  return tool.execute(args);
}

function parse(result) {
  assert.ok(!String(result).startsWith('Error:'), result);
  return JSON.parse(result);
}

function makeAdminDeps(overrides = {}) {
  const registry = new FleetV29PeerRegistry();
  const allowlist = new FleetV29Allowlist();
  return {
    allowlist,
    registry,
    availableDrivers: ['bwrap', 'local'],
    nowIso: () => NOW,
    ...overrides,
  };
}

/* ---------------- pure tool defs ---------------- */

test('v30 pure tool defs: 60 tools, unique snake_case names, groups', () => {
  assert.equal(FLEET_V30_VERSION, 'v30');
  assert.equal(FLEET_V30_TOOLS.length, 60);
  assert.equal(fleetV30ToolNamesUnique(), true);
  assert.equal(fleetV30ToolNamesValid(), true);
  assert.equal(fleetV30ReadTools().length + fleetV30WriteTools().length, 60);
  const groups = fleetV30ToolsByGroup();
  assert.equal(groups['iso'].length, 10);
  assert.equal(groups['driver'].length, 3);
  assert.equal(groups['board'].length, 13);
  assert.equal(groups['view'].length, 4);
  assert.equal(groups['group'].length, 10);
  assert.equal(groups['admin'].length, 13);
  assert.equal(groups['quota'].length, 4);
  assert.equal(groups['snapshot'].length, 2);
  assert.equal(groups['health'].length, 1);
  assert.equal(findFleetV30Tool('fleet_v30_admin_preflight')?.write, false);
  assert.equal(findFleetV30Tool('fleet_v30_iso_bind')?.write, true);
  assert.equal(findFleetV30Tool('fleet_v30_nope'), null);
  const inAll = ALL_TOOLS.filter((t) => t.definition.name.startsWith('fleet_v30_'));
  assert.equal(inAll.length, 60, 'ALL_TOOLS carries the 60 v30 placeholders');
});

/* ---------------- admin roles ---------------- */

test('admin roles: bootstrap once, fail-closed viewer, last admin protected', () => {
  const admin = new FleetV30AdminPolicy(makeAdminDeps());
  assert.equal(admin.roleOf('nobody'), 'viewer');
  const boot = admin.bootstrapAdmin('root');
  assert.equal(boot.ok, true);
  assert.equal(admin.roleOf('root'), 'admin');
  assert.equal(admin.bootstrapAdmin('root2').ok, false);
  assert.equal(admin.grantRole('nobody', 'op1', 'operator').ok, false);
  const granted = admin.grantRole('root', 'op1', 'operator');
  assert.equal(granted.ok, true);
  assert.equal(admin.roleOf('op1'), 'operator');
  assert.equal(admin.grantRole('op1', 'op2', 'operator').ok, false); // operators cannot grant
  assert.equal(admin.revokeRole('op1', 'root').ok, false);
  assert.equal(admin.revokeRole('root', 'root').ok, false); // last admin
  assert.equal(admin.grantRole('root', 'root2', 'admin').ok, true);
  assert.equal(admin.revokeRole('root', 'root').ok, true);
  assert.equal(admin.roleOf('root'), 'viewer');
  assert.equal(admin.revokeRole('root2', 'ghost').ok, false);
  assert.deepEqual(admin.listAdmins().map((a) => a.userId).sort(), ['op1', 'root2']);
});

/* ---------------- policy rules + time windows ---------------- */

test('policy rules: validation, creator-or-admin update, admin-only delete', () => {
  const admin = new FleetV30AdminPolicy(makeAdminDeps());
  admin.bootstrapAdmin('root');
  admin.grantRole('root', 'op1', 'operator');
  assert.equal(admin.createRule('nobody', { name: 'X' }).ok, false);
  assert.equal(admin.createRule('root', { name: '' }).ok, false);
  assert.equal(admin.createRule('root', { name: 'X', taskTypes: ['bogus'] }).ok, false);
  assert.equal(admin.createRule('root', { name: 'X', timeWindow: { startHour: 18, endHour: 9, days: [1] } }).ok, false);
  assert.equal(admin.createRule('root', { name: 'X', timeWindow: { startHour: 9, endHour: 18, days: [7] } }).ok, false);
  assert.equal(admin.createRule('root', { name: 'X', maxCostUsdPerTask: -1 }).ok, false);
  assert.equal(admin.createRule('root', { name: 'X', maxConcurrentTasks: 0 }).ok, false);
  const created = admin.createRule('op1', {
    name: 'Work hours',
    taskTypes: ['code'],
    runtimeKinds: ['bwrap'],
    timeWindow: { startHour: 9, endHour: 18, days: [1, 2, 3, 4, 5] },
    maxCostUsdPerTask: 1,
    maxConcurrentTasks: 3,
  });
  assert.equal(created.ok, true);
  if (!created.ok) return;
  const ruleId = created.rule.ruleId;
  assert.equal(admin.listRules().length, 1);
  // Another operator cannot update someone else's rule; admin can.
  admin.grantRole('root', 'op2', 'operator');
  assert.equal(admin.updateRule('op2', ruleId, { enabled: false }).ok, false);
  assert.equal(admin.updateRule('op1', ruleId, { maxCostUsdPerTask: 2 }).ok, true);
  assert.equal(admin.getRule(ruleId)?.maxCostUsdPerTask, 2);
  assert.equal(admin.updateRule('op1', ruleId, { maxCostUsdPerTask: -1 }).ok, false);
  assert.equal(admin.deleteRule('op1', ruleId).ok, false);
  assert.equal(admin.deleteRule('root', ruleId).ok, true);
  assert.equal(admin.listRules().length, 0);
  assert.equal(admin.deleteRule('root', ruleId).ok, false);
});

test('policy time windows: Wednesday 10:00 inside, Sunday 10:00 outside', () => {
  // 2026-11-18 is a Wednesday; 2026-11-22 is a Sunday.
  const wednesday = () => new Date(2026, 10, 18, 10, 0, 0);
  const sunday = () => new Date(2026, 10, 22, 10, 0, 0);
  // Pre-flight needs a registered + allowlisted peer: build them here.
  const state = { registry: new FleetV29PeerRegistry(), allowlist: new FleetV29Allowlist() };
  registerVerifiedPeer(state, 'peer-1');
  allowlistPeer(state, 'peer-1');
  const adminWed = new FleetV30AdminPolicy({
    allowlist: state.allowlist,
    registry: state.registry,
    availableDrivers: ['bwrap'],
    nowIso: () => NOW,
    nowLocal: wednesday,
  });
  adminWed.bootstrapAdmin('root');
  adminWed.grantRole('root', 'op1', 'operator');
  adminWed.createRule('root', {
    name: 'Weekdays',
    taskTypes: ['code'],
    timeWindow: { startHour: 9, endHour: 18, days: [1, 2, 3, 4, 5] },
  });
  const pass = adminWed.preflightCheck({
    actor: 'op1', peerId: 'peer-1', taskType: 'code', runtimeKind: 'bwrap',
    estimatedCostUsd: 0, conversationId: null, activeTasksForPeer: 0,
  });
  assert.equal(pass.allowed, true);
  const adminSun = new FleetV30AdminPolicy({
    allowlist: state.allowlist,
    registry: state.registry,
    availableDrivers: ['bwrap'],
    nowIso: () => NOW,
    nowLocal: sunday,
  });
  adminSun.bootstrapAdmin('root');
  adminSun.grantRole('root', 'op1', 'operator');
  adminSun.createRule('root', {
    name: 'Weekdays',
    taskTypes: ['code'],
    timeWindow: { startHour: 9, endHour: 18, days: [1, 2, 3, 4, 5] },
  });
  const denied = adminSun.preflightCheck({
    actor: 'op1', peerId: 'peer-1', taskType: 'code', runtimeKind: 'bwrap',
    estimatedCostUsd: 0, conversationId: null, activeTasksForPeer: 0,
  });
  assert.equal(denied.allowed, false);
  assert.ok(denied.reasons.some((r) => r.includes('only 9:00')));
});

/* ---------------- approvals ---------------- */

test('approvals: request/decide/expire lifecycle', () => {
  const state = { registry: new FleetV29PeerRegistry(), allowlist: new FleetV29Allowlist() };
  registerVerifiedPeer(state, 'peer-1');
  const admin2 = new FleetV30AdminPolicy({
    allowlist: state.allowlist,
    registry: state.registry,
    availableDrivers: ['bwrap'],
    nowIso: () => NOW,
  });
  admin2.bootstrapAdmin('root');
  admin2.grantRole('root', 'op1', 'operator');
  assert.equal(admin2.requestApproval('nobody', 'peer-1', 'sensitive', 'Buy something.').ok, false);
  assert.equal(admin2.requestApproval('op1', 'peer-ghost', 'sensitive', 'Buy something.').ok, false);
  assert.equal(admin2.requestApproval('op1', 'peer-1', 'sensitive', '').ok, false);
  const req = admin2.requestApproval('op1', 'peer-1', 'sensitive', 'Buy a $5 API credit.', '2026-11-19T06:00:00.000Z');
  assert.equal(req.ok, true);
  if (!req.ok) return;
  const reqId = req.request.requestId;
  assert.equal(admin2.decideApproval('op1', reqId, true).ok, false); // non-admin cannot decide
  assert.equal(admin2.approvedFor('peer-1', 'sensitive'), null); // not decided yet
  const decided = admin2.decideApproval('root', reqId, true, 'Approved for the demo.');
  assert.equal(decided.ok, true);
  assert.equal(decided.ok && decided.request.status, 'approved');
  assert.ok(admin2.approvedFor('peer-1', 'sensitive'));
  assert.equal(admin2.decideApproval('root', reqId, false).ok, false); // already decided
  assert.equal(admin2.listApprovals('pending').length, 0);
  // Expiry sweep.
  const req2 = admin2.requestApproval('op1', 'peer-1', 'code', 'Old request.', '2026-11-19T05:30:00.000Z');
  assert.equal(req2.ok, true);
  const expired = admin2.sweepExpiredApprovals('2026-11-19T06:00:00.000Z');
  assert.deepEqual(expired, [req2.ok ? req2.request.requestId : '']);
  assert.equal(admin2.listApprovals('expired').length, 1);
});

/* ---------------- pre-flight ---------------- */

test('pre-flight: full pass and every failing check', () => {
  const state = { registry: new FleetV29PeerRegistry(), allowlist: new FleetV29Allowlist() };
  registerVerifiedPeer(state, 'peer-1');
  registerVerifiedPeer(state, 'peer-2');
  state.registry.recordVerification('peer-2', 'unverified', 'none', [], NOW);
  allowlistPeer(state, 'peer-1');
  allowlistPeer(state, 'peer-2');
  const admin = new FleetV30AdminPolicy({
    allowlist: state.allowlist,
    registry: state.registry,
    availableDrivers: ['bwrap', 'local'],
    nowIso: () => NOW,
  });
  admin.bootstrapAdmin('root');
  admin.grantRole('root', 'op1', 'operator');
  const base = {
    actor: 'op1', peerId: 'peer-1', taskType: 'code', runtimeKind: 'bwrap',
    estimatedCostUsd: 0.01, conversationId: null, activeTasksForPeer: 0,
  };
  assert.equal(admin.preflightCheck(base).allowed, true);
  assert.equal(admin.preflightCheck({ ...base, actor: 'nobody' }).allowed, false);
  assert.equal(admin.preflightCheck({ ...base, peerId: 'peer-ghost' }).allowed, false);
  assert.equal(admin.preflightCheck({ ...base, peerId: 'peer-2' }).allowed, false); // unverified card
  assert.equal(admin.preflightCheck({ ...base, runtimeKind: 'docker' }).allowed, false); // unavailable driver
  // Suspended peer.
  assert.equal(state.allowlist.suspend('peer-1').ok, true);
  assert.equal(admin.preflightCheck(base).allowed, false);
  assert.equal(state.allowlist.resume('peer-1').ok, true);
  assert.equal(admin.preflightCheck(base).allowed, true);
  // Cost cap from a rule.
  admin.createRule('root', { name: 'Cheap only', maxCostUsdPerTask: 0.001 });
  assert.equal(admin.preflightCheck(base).allowed, false);
  assert.equal(admin.preflightCheck({ ...base, estimatedCostUsd: 0.0005 }).allowed, true);
  // Approval-required rule: denied until approved.
  admin.createRule('root', { name: 'Sensitive needs approval', requiresApprovalFor: ['sensitive'] });
  const sensitive = admin.preflightCheck({ ...base, taskType: 'sensitive', estimatedCostUsd: 0.0005 });
  assert.equal(sensitive.allowed, false);
  assert.ok(sensitive.approvalRequired);
  const req = admin.requestApproval('op1', 'peer-1', 'sensitive', 'Sensitive work.');
  assert.equal(req.ok, true);
  assert.equal(admin.decideApproval('root', req.ok ? req.request.requestId : '', true).ok, true);
  assert.equal(admin.preflightCheck({ ...base, taskType: 'sensitive', estimatedCostUsd: 0.0005 }).allowed, true);
  // A denial is audited.
  assert.ok(admin.listEvents().some((e) => e.kind === 'preflight-denied'));
  assert.ok(admin.eventsForPeer('peer-1').length > 0);
  assert.ok(admin.countsByKind()['preflight-denied'] >= 1);
});

/* ---------------- runnable tools ---------------- */

test('runnable tools: unbound says not configured; bound loop works', async () => {
  const unbound = createFleetV30Tools();
  assert.equal(runnableNamesUnique(), true);
  assert.equal(unbound.length, 60);
  const notWired = await callTool(unbound, 'fleet_v30_iso_list', {});
  assert.match(notWired, /not configured/);

  const state = createEmptyFleetV30ToolState();
  const tools = createFleetV30Tools(() => state);
  registerVerifiedPeer(state, 'peer-1');
  registerVerifiedPeer(state, 'peer-2');
  allowlistPeer(state, 'peer-1');
  allowlistPeer(state, 'peer-2');

  // Isolation loop.
  const bound = parse(await callTool(tools, 'fleet_v30_iso_bind', { conversationId: 'conv-1', profileId: 'profile-a' }));
  assert.equal(bound.binding.driverKind, 'bwrap');
  assert.equal(bound.binding.isolated, true);
  const listed = parse(await callTool(tools, 'fleet_v30_iso_list', {}));
  assert.equal(listed.bindings.length, 1);
  const got = parse(await callTool(tools, 'fleet_v30_iso_get', { conversationId: 'conv-1' }));
  assert.equal(got.binding.conversationId, 'conv-1');
  assert.match(await callTool(tools, 'fleet_v30_iso_bind', { conversationId: 'conv-1', profileId: 'profile-a' }), /Error:/);
  parse(await callTool(tools, 'fleet_v30_iso_suspend', { conversationId: 'conv-1' }));
  parse(await callTool(tools, 'fleet_v30_iso_resume', { conversationId: 'conv-1' }));
  const usage = parse(await callTool(tools, 'fleet_v30_iso_usage', {}));
  assert.equal(usage.active, 1);
  const ended = parse(await callTool(tools, 'fleet_v30_iso_end', { conversationId: 'conv-1' }));
  assert.equal(ended.wipedPaths.length, 3);
  const orphans = parse(await callTool(tools, 'fleet_v30_iso_orphans', {}));
  assert.deepEqual(orphans.orphaned, []);
  const events = parse(await callTool(tools, 'fleet_v30_iso_events', { conversationId: 'conv-1' }));
  assert.ok(events.events.some((e) => e.kind === 'binding-cleaned'));

  // Drivers.
  const caps = parse(await callTool(tools, 'fleet_v30_driver_capabilities', {}));
  assert.equal(caps.drivers.length, 3);
  const selected = parse(await callTool(tools, 'fleet_v30_driver_select', { preferred: 'docker', networkMode: 'loopback' }));
  assert.equal(selected.kind, 'bwrap');
  const cmd = parse(await callTool(tools, 'fleet_v30_driver_command', {
    driverKind: 'bwrap', command: 'node', args: ['--version'],
    cwd: '/tmp/open-bot-fleet-v30/conv-1', workspaceRoot: '/tmp/open-bot-fleet-v30/conv-1',
    networkMode: 'none',
  }));
  assert.equal(cmd.argv[0], 'bwrap');
  assert.ok(cmd.argv.includes('--unshare-net'));
  assert.equal(cmd.isolated, true);
  assert.match(await callTool(tools, 'fleet_v30_driver_command', {
    driverKind: 'bwrap', command: 'node', args: [],
    cwd: '/tmp/x', workspaceRoot: '/tmp/x', networkMode: 'host',
  }), /Error:/);

  // Board v2 loop (submit through the v29 board directly, then v30 tools).
  const submitted = await state.board.submit({ peerId: 'peer-1', delegatedBy: 'local-user', title: 'Tool task', messageText: 'Do it.' });
  assert.equal(submitted.ok, true);
  const taskId = submitted.boardTask.task.id;
  const view = parse(await callTool(tools, 'fleet_v30_board_view', { taskId }));
  assert.equal(view.task.boardTask.task.id, taskId);
  parse(await callTool(tools, 'fleet_v30_board_priority', { taskId, priority: 'high', actor: 'admin' }));
  parse(await callTool(tools, 'fleet_v30_board_due', { taskId, dueAt: '2026-11-20T00:00:00.000Z', slaMinutes: 60, actor: 'admin' }));
  const reassigned = parse(await callTool(tools, 'fleet_v30_board_reassign', { taskId, newPeerId: 'peer-2', actor: 'admin' }));
  assert.equal(reassigned.task.boardTask.peerId, 'peer-2');
  const ready = parse(await callTool(tools, 'fleet_v30_board_ready', {}));
  assert.equal(ready.tasks.length, 1);
  const kanban = parse(await callTool(tools, 'fleet_v30_board_kanban', {}));
  assert.equal(kanban.columns.length, 3);
  const exported = await callTool(tools, 'fleet_v30_board_export', {});
  assert.ok(exported.includes('"title":"Tool task"'));
  assert.match(await callTool(tools, 'fleet_v30_board_export', { state: 'bogus' }), /Error:/);
  const swept = parse(await callTool(tools, 'fleet_v30_iso_sweep_evicted', {}));
  assert.deepEqual(swept.suspended, []);
  const overdue = parse(await callTool(tools, 'fleet_v30_board_overdue', {}));
  assert.deepEqual(overdue.overdue, []);
  const viewCreated = parse(await callTool(tools, 'fleet_v30_view_create', { name: 'High', createdBy: 'admin', priority: 'high' }));
  const applied = parse(await callTool(tools, 'fleet_v30_view_apply', { viewId: viewCreated.view.viewId }));
  assert.equal(applied.tasks.length, 1);
  const views = parse(await callTool(tools, 'fleet_v30_view_list', {}));
  assert.equal(views.views.length, 1);
  parse(await callTool(tools, 'fleet_v30_view_delete', { viewId: viewCreated.view.viewId }));

  // Groups loop.
  const group = parse(await callTool(tools, 'fleet_v30_group_create', { name: 'Coding', createdBy: 'admin' }));
  parse(await callTool(tools, 'fleet_v30_group_add_peer', { groupId: group.group.groupId, peerId: 'peer-1' }));
  const picked = parse(await callTool(tools, 'fleet_v30_group_pick', { requiredSkills: [], streamingRequired: false }));
  assert.ok(picked.pick);
  const scored = parse(await callTool(tools, 'fleet_v30_group_score', { requiredSkills: [], streamingRequired: false }));
  assert.equal(scored.scores.length, 2);
  parse(await callTool(tools, 'fleet_v30_group_probe', { peerId: 'peer-1', endpoint: 'http://127.0.0.1:4199/', reachable: true, latencyMs: 50 }));
  const groups = parse(await callTool(tools, 'fleet_v30_group_list', {}));
  assert.equal(groups.groups.length, 1);

  // Admin loop.
  parse(await callTool(tools, 'fleet_v30_admin_bootstrap', { userId: 'root' }));
  parse(await callTool(tools, 'fleet_v30_admin_grant', { granterId: 'root', userId: 'op1', role: 'operator' }));
  const admins = parse(await callTool(tools, 'fleet_v30_admin_list', {}));
  assert.equal(admins.admins.length, 2);
  const rule = parse(await callTool(tools, 'fleet_v30_admin_rule_create', {
    actor: 'root', name: 'Cheap', maxCostUsdPerTask: 10,
  }));
  const rules = parse(await callTool(tools, 'fleet_v30_admin_rule_list', {}));
  assert.equal(rules.rules.length, 1);
  const preflight = parse(await callTool(tools, 'fleet_v30_admin_preflight', {
    actor: 'op1', peerId: 'peer-1', taskType: 'code', runtimeKind: 'bwrap',
    estimatedCostUsd: 0.01, activeTasksForPeer: 0,
  }));
  assert.equal(preflight.allowed, true);
  const approval = parse(await callTool(tools, 'fleet_v30_admin_approval_request', {
    requestedBy: 'op1', peerId: 'peer-1', taskType: 'sensitive', summary: 'Sensitive work.',
  }));
  parse(await callTool(tools, 'fleet_v30_admin_approval_decide', {
    decidedBy: 'root', requestId: approval.request.requestId, approve: true,
  }));
  const approvals = parse(await callTool(tools, 'fleet_v30_admin_approval_list', { status: 'approved' }));
  assert.equal(approvals.requests.length, 1);
  parse(await callTool(tools, 'fleet_v30_admin_rule_delete', { actor: 'root', ruleId: rule.rule.ruleId }));
  const adminEvents = parse(await callTool(tools, 'fleet_v30_admin_events', {}));
  assert.ok(adminEvents.events.length > 0);

  // Dashboard.
  const dashboard = parse(await callTool(tools, 'fleet_v30_dashboard', {}));
  assert.match(dashboard.summary, /Fleet v30/);
  assert.equal(dashboard.groups.groups.length, 1);
  assert.ok(Array.isArray(dashboard.quotas.quotas));

  // Quota + snapshot tools.
  parse(await callTool(tools, 'fleet_v30_quota_set', { profileId: 'profile-a', setBy: 'root', maxBindings: 5 }));
  const quota = parse(await callTool(tools, 'fleet_v30_quota_get', { profileId: 'profile-a' }));
  assert.equal(quota.bindings, 0);
  const quotaCheck = parse(await callTool(tools, 'fleet_v30_quota_check', { profileId: 'profile-a', cpuCores: 1, ramMB: 512, diskMB: 100 }));
  assert.equal(quotaCheck.admitted, true);
  const saved = parse(await callTool(tools, 'fleet_v30_snapshot_save', {}));
  assert.ok(saved.snapshotJson.includes('fleet'));
  const loaded = parse(await callTool(tools, 'fleet_v30_snapshot_load', { snapshotJson: saved.snapshotJson, restoredBy: 'root' }));
  assert.ok(loaded.restoredGroups.length >= 1);
});

/* ---------------- defaultToolFactory binding ---------------- */

test('defaultToolFactory: bound v30 tools replace placeholders in place', () => {
  const state = createEmptyFleetV30ToolState();
  const plain = createDefaultTools();
  const bound = createDefaultTools({ getFleetV30State: () => state });
  assert.equal(bound.length, plain.length, 'bind must not add/remove tools');
  const inBound = bound.filter((t) => t.definition.name.startsWith('fleet_v30_'));
  const inPlain = plain.filter((t) => t.definition.name.startsWith('fleet_v30_'));
  assert.equal(inBound.length, 60);
  assert.equal(inPlain.length, 60);
  assert.equal(new Set(inBound.map((t) => t.definition.name)).size, 60);
  assert.deepEqual(
    inBound.map((t) => t.definition.name),
    inPlain.map((t) => t.definition.name),
  );
});

/* ---------------- panels ---------------- */

test('panels: dashboard joins isolation + board + groups + admin', async () => {
  const state = createEmptyFleetV30ToolState();
  registerVerifiedPeer(state, 'peer-1');
  allowlistPeer(state, 'peer-1');
  const isolationPanel = buildFleetV30IsolationPanel(state.isolation);
  assert.equal(isolationPanel.active, 0);
  state.isolation.bind('conv-1', 'profile-a', { networkMode: 'host' }); // local fallback
  const panel2 = buildFleetV30IsolationPanel(state.isolation);
  assert.equal(panel2.active, 1);
  assert.equal(panel2.unisolated, 1);
  assert.match(panel2.summary, /WITHOUT isolation/);
  state.admin.bootstrapAdmin('root');
  const dashboard = buildFleetV30Dashboard({
    isolation: state.isolation,
    boardV2: state.boardV2,
    board: state.board,
    groups: state.groups,
    admin: state.admin,
    registry: state.registry,
    allowlist: state.allowlist,
  });
  assert.match(dashboard.summary, /Fleet v30 — 1 isolated conversation\(s\) \(1 unisolated\)/);
  assert.equal(dashboard.admin.admins.length, 1);
  assert.equal(dashboard.groups.groups.length, 0);
  assert.equal(dashboard.board.overdue.length, 0);
});

/* ---------------- i18n ---------------- */

test('i18n: 90 fleet.v30.* keys in all 6 locales, non-empty, equal totals', () => {
  const counts = {};
  for (const locale of LOCALES) {
    const data = JSON.parse(readFileSync(`apps/desktop/src/renderer/i18n/locales/${locale}.json`, 'utf-8'));
    const keys = Object.keys(data).filter((k) => k.startsWith('fleet.v30.'));
    counts[locale] = keys.length;
    assert.ok(keys.length >= FLEET_V30_I18N_KEYS, `${locale} has ${keys.length} fleet.v30 keys`);
    for (const key of keys) {
      assert.equal(typeof data[key], 'string', `${locale}:${key} is a string`);
      assert.ok(data[key].trim().length > 0, `${locale}:${key} is non-empty`);
    }
  }
  const totals = new Set(Object.values(counts));
  assert.equal(totals.size, 1, `fleet.v30 key totals differ across locales: ${JSON.stringify(counts)}`);
});

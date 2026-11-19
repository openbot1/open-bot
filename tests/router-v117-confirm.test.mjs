/**
 * Router local v117 — confirmation policy (v1.40, Doi T3, node:test).
 *
 * Covers (thuan, khong model that, khong network):
 * - ConfirmationGate: mac dinh ConfirmRisky/HIGH; AlwaysConfirm pause
 *   het; NeverConfirm khong pause; threshold MEDIUM pause ca MEDIUM;
 *   UNKNOWN tinh nhu HIGH (fail-closed).
 * - submit -> pending WAITING_FOR_CONFIRMATION; approve/reject ghi log;
 *   decide 2 lan / id la -> Error; het han theo TTL (sweepExpired);
 *   maxPending day -> Error.
 * - Tools: confirm_policy get/set, confirm_pending, confirm_decide,
 *   audit_log hop nhat route + risk + confirm (loc theo kind, limit).
 *
 * Imports the BUILT core + tools — build first:
 *   npm run build --workspace=@open-bot/core
 *   npm run build --workspace=@open-bot/tools
 * then: node --test tests/router-v117-confirm.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { ConfirmationGate, defaultConfirmPolicy } from '../packages/core/dist/router/local/confirmPolicyV117.js';
import { createRouterLocalV117Tools } from '../packages/tools/dist/routerLocalV117Tools.js';

function toolByName(tools, name) {
  const tool = tools.find((t) => t.definition.name === name);
  assert.ok(tool, `missing tool ${name}`);
  return tool;
}

async function run(tool, args) {
  const out = await tool.execute(args);
  if (typeof out === 'string' && out.startsWith('Error:')) return { error: out };
  return JSON.parse(out);
}

test('policy mac dinh: ConfirmRisky, threshold HIGH, ttl 10 phut', () => {
  const gate = new ConfirmationGate();
  assert.deepEqual(gate.getPolicy(), {
    mode: 'ConfirmRisky',
    threshold: 'HIGH',
    ttlMs: 600000,
    maxPending: 50,
  });
  assert.deepEqual(defaultConfirmPolicy().mode, 'ConfirmRisky');
  assert.equal(gate.requiresConfirmation('LOW'), false);
  assert.equal(gate.requiresConfirmation('MEDIUM'), false);
  assert.equal(gate.requiresConfirmation('HIGH'), true);
  assert.equal(gate.requiresConfirmation('UNKNOWN'), true);
});

test('policy: AlwaysConfirm pause het; NeverConfirm khong pause; threshold MEDIUM', () => {
  const gate = new ConfirmationGate();
  gate.setPolicy({ mode: 'AlwaysConfirm' });
  assert.equal(gate.requiresConfirmation('LOW'), true);
  gate.setPolicy({ mode: 'NeverConfirm' });
  assert.equal(gate.requiresConfirmation('HIGH'), false);
  gate.setPolicy({ mode: 'ConfirmRisky', threshold: 'MEDIUM' });
  assert.equal(gate.requiresConfirmation('LOW'), false);
  assert.equal(gate.requiresConfirmation('MEDIUM'), true);
  assert.equal(gate.requiresConfirmation('UNKNOWN'), true);
  assert.throws(() => gate.setPolicy({ mode: 'Sometimes' }), /mode phai la/);
  assert.throws(() => gate.setPolicy({ threshold: 'CRITICAL' }), /threshold phai la/);
  assert.throws(() => gate.setPolicy({ ttlMs: 0 }), /ttlMs phai la so > 0/);
  assert.throws(() => gate.setPolicy({ maxPending: 0 }), /maxPending phai la/);
});

test('submit + approve/reject: trang thai, log, loi khi decide lai', () => {
  const gate = new ConfirmationGate();
  const low = gate.submit('file_read', { path: '/tmp/a' }, 'LOW', 0, 1000);
  assert.equal(low.requiresConfirmation, false);
  assert.equal(low.pending, undefined);
  assert.equal(gate.getDecisionLog()[0].decision, 'AUTO_ALLOWED');

  const high = gate.submit('shell_exec', { command: 'rm -rf /' }, 'HIGH', 90, 1000);
  assert.equal(high.requiresConfirmation, true);
  assert.equal(high.pending.status, 'WAITING_FOR_CONFIRMATION');
  assert.equal(gate.pendingCount(), 1);
  assert.equal(gate.listPending().length, 1);

  const approved = gate.approve(high.pending.id, 'user', 2000);
  assert.equal(approved.status, 'APPROVED');
  assert.equal(approved.decidedBy, 'user');
  assert.equal(gate.pendingCount(), 0);
  assert.throws(() => gate.approve(high.pending.id), /da o trang thai APPROVED/);
  assert.throws(() => gate.reject(high.pending.id), /da o trang thai APPROVED/);
  assert.throws(() => gate.approve('confirm-999'), /Khong co yeu cau/);

  const second = gate.submit('file_delete', { path: '/tmp/x' }, 'HIGH', 80, 3000);
  const rejected = gate.reject(second.pending.id, 'user', 'khong duoc xoa', 4000);
  assert.equal(rejected.status, 'REJECTED');
  assert.equal(rejected.decisionReason, 'khong duoc xoa');
  const log = gate.getDecisionLog();
  assert.ok(log.some((d) => d.decision === 'REJECTED' && d.toolName === 'file_delete'));
  assert.ok(log.some((d) => d.decision === 'APPROVED'));
});

test('sweepExpired: het han theo TTL, maxPending day', () => {
  const gate = new ConfirmationGate({ ttlMs: 1000, maxPending: 2 });
  const p1 = gate.submit('shell_exec', { command: 'rm -rf /' }, 'HIGH', 90, 1000);
  const p2 = gate.submit('shell_exec', { command: 'reboot' }, 'HIGH', 90, 1000);
  assert.throws(() => gate.submit('shell_exec', {}, 'HIGH', 90, 1000), /Hang doi xac nhan da day/);
  assert.deepEqual(gate.sweepExpired(1500), []);
  const expired = gate.sweepExpired(2001);
  assert.deepEqual(expired.sort(), [p1.pending.id, p2.pending.id].sort());
  assert.equal(gate.getPending(p1.pending.id).status, 'EXPIRED');
  assert.equal(gate.pendingCount(), 0);
  assert.ok(gate.getDecisionLog().some((d) => d.decision === 'EXPIRED'));
});

test('tools: confirm policy + pending + decide qua tool', async () => {
  const tools = createRouterLocalV117Tools();
  const policy = await run(toolByName(tools, 'router_local_confirm_policy_get'), {});
  assert.equal(policy.policy.mode, 'ConfirmRisky');
  assert.equal(policy.policy.threshold, 'HIGH');
  assert.equal(policy.pendingCount, 0);

  const gated = await run(toolByName(tools, 'router_local_tool_call_gate'), {
    toolName: 'shell_exec', toolArgs: { command: 'rm -rf /tmp/x' },
  });
  assert.equal(gated.requiresConfirmation, true);
  const pendingId = gated.pendingId;

  const pending = await run(toolByName(tools, 'router_local_confirm_pending'), {});
  assert.equal(pending.total, 1);
  assert.equal(pending.pending[0].id, pendingId);
  const one = await run(toolByName(tools, 'router_local_confirm_pending'), { id: pendingId });
  assert.equal(one.pending.toolName, 'shell_exec');

  const decided = await run(toolByName(tools, 'router_local_confirm_decide'), {
    id: pendingId, decision: 'approve', by: 'huy',
  });
  assert.equal(decided.pending.status, 'APPROVED');
  assert.equal(decided.pending.decidedBy, 'huy');
  const again = await run(toolByName(tools, 'router_local_confirm_decide'), {
    id: pendingId, decision: 'approve',
  });
  assert.ok(again.error.startsWith('Error:'));
  const badDecision = await run(toolByName(tools, 'router_local_confirm_decide'), {
    id: pendingId, decision: 'maybe',
  });
  assert.ok(badDecision.error.startsWith('Error:'));

  const set = await run(toolByName(tools, 'router_local_confirm_policy_set'), {
    mode: 'NeverConfirm',
  });
  assert.equal(set.policy.mode, 'NeverConfirm');
  const autoGated = await run(toolByName(tools, 'router_local_tool_call_gate'), {
    toolName: 'shell_exec', toolArgs: { command: 'rm -rf /tmp/x' },
  });
  assert.equal(autoGated.requiresConfirmation, false);
  const badMode = await run(toolByName(tools, 'router_local_confirm_policy_set'), { mode: 'Sometimes' });
  assert.ok(badMode.error.startsWith('Error:'));
});

test('tools: audit_log hop nhat route + risk + confirm, loc kind', async () => {
  const tools = createRouterLocalV117Tools();
  await run(toolByName(tools, 'router_local_midchat_route'), { content: 'hi', currentModelId: 'qwen3-4b' });
  await run(toolByName(tools, 'router_local_risk_score'), { toolName: 'file_read', toolArgs: { path: '/tmp/a' } });
  await run(toolByName(tools, 'router_local_tool_call_gate'), {
    toolName: 'shell_exec', toolArgs: { command: 'rm -rf /tmp/x' },
  });

  const all = await run(toolByName(tools, 'router_local_audit_log'), {});
  assert.ok(all.total >= 3, `total ${all.total}`);
  assert.ok(all.entries.some((e) => e.kind === 'route'));
  assert.ok(all.entries.some((e) => e.kind === 'risk'));
  // gate HIGH tao pending, chua co decision confirm; gate LOW (risk_score
  // khong tao decision) — chi co AUTO_ALLOWED khi gate LOW qua tool_call_gate.
  await run(toolByName(tools, 'router_local_tool_call_gate'), {
    toolName: 'router_local_decision_log', toolArgs: { limit: 5 },
  });
  const all2 = await run(toolByName(tools, 'router_local_audit_log'), {});
  assert.ok(all2.entries.some((e) => e.kind === 'confirm'));

  const routes = await run(toolByName(tools, 'router_local_audit_log'), { kind: 'route' });
  assert.ok(routes.entries.length >= 1);
  assert.ok(routes.entries.every((e) => e.kind === 'route'));
  const risks = await run(toolByName(tools, 'router_local_audit_log'), { kind: 'risk', limit: 1 });
  assert.equal(risks.entries.length, 1);
  assert.equal(risks.entries[0].kind, 'risk');
  const badKind = await run(toolByName(tools, 'router_local_audit_log'), { kind: 'weird' });
  assert.ok(badKind.error.startsWith('Error:'));
});

test('override: always/never theo tool, uu tien hon policy', () => {
  const gate = new ConfirmationGate();
  assert.equal(gate.getToolOverride('shell_exec'), 'default');
  gate.setToolOverride('shell_exec', 'always');
  assert.equal(gate.requiresConfirmation('LOW', 'shell_exec'), true);
  const p = gate.submit('shell_exec', { command: 'ls' }, 'LOW', 0, 1000);
  assert.equal(p.requiresConfirmation, true);
  assert.equal(p.pending.status, 'WAITING_FOR_CONFIRMATION');

  gate.setToolOverride('router_local_decision_log', 'never');
  assert.equal(gate.requiresConfirmation('HIGH', 'router_local_decision_log'), false);
  const auto = gate.submit('router_local_decision_log', {}, 'HIGH', 90, 2000);
  assert.equal(auto.requiresConfirmation, false);
  assert.ok(gate.getDecisionLog().some((d) => d.reason.includes('Override "never"')));

  gate.setToolOverride('shell_exec', 'default');
  assert.equal(gate.getToolOverride('shell_exec'), 'default');
  assert.equal(gate.requiresConfirmation('LOW', 'shell_exec'), false);
  assert.deepEqual(gate.listToolOverrides(), [{ toolName: 'router_local_decision_log', override: 'never' }]);
  assert.throws(() => gate.setToolOverride('x', 'sometimes'), /override phai la/);
  assert.throws(() => gate.setToolOverride('', 'always'), /khong rong/);
});

test('tools: confirm_tool_override qua tool + gate ton trong', async () => {
  const tools = createRouterLocalV117Tools();
  const set = await run(toolByName(tools, 'router_local_confirm_tool_override'), {
    toolName: 'shell_exec', override: 'always',
  });
  assert.equal(set.override, 'always');
  assert.ok(set.overrides.some((o) => o.toolName === 'shell_exec' && o.override === 'always'));

  const gated = await run(toolByName(tools, 'router_local_tool_call_gate'), {
    toolName: 'shell_exec', toolArgs: { command: 'ls' },
  });
  // shell_exec 'ls' chi MEDIUM (write 15 + exec 25) nhung override always -> pause.
  assert.equal(gated.requiresConfirmation, true);
  assert.ok(gated.pendingId.startsWith('confirm-'));

  const get = await run(toolByName(tools, 'router_local_confirm_tool_override'), {
    toolName: 'shell_exec',
  });
  assert.equal(get.override, 'always');
  const bad = await run(toolByName(tools, 'router_local_confirm_tool_override'), {
    toolName: 'shell_exec', override: 'sometimes',
  });
  assert.ok(bad.error.startsWith('Error:'));
});

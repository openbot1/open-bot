/**
 * Tests for fleet v22 orchestration mode 1 (delegation) + mode 2
 * (handoff) (v1.35, Đội T6).
 *
 * Covers:
 * - Delegation: create defaults, lifecycle (pending → running →
 *   awaiting-verification → completed/failed), illegal transitions,
 *   budget enforcement (tool calls + cost), timeout check, tool
 *   allowlist, child-spawn depth, verification required before
 *   completed, registry (active, awaitingVerification, timeouts).
 * - Handoff: tool naming (transfer_to_*), agent registry, create
 *   (auto-transferred vs pending-approval), approve/reject/fail,
 *   chain (append order, current agent, ping-pong + over-limit guards,
 *   validateNext), context build (full history + system note),
 *   agent suggestion by keyword.
 *
 * Imports the BUILT core — build first:
 *   npm run build --workspace=@open-bot/core
 * then: node --test tests/fleet-v22-delegation-handoff.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_FLEET_V22_DELEGATION_BUDGET,
  FleetV22DelegationRegistry,
  createFleetV22Delegation,
  delegationCanSpawnChildV22,
  delegationCheckTimeoutV22,
  delegationElapsedMsV22,
  delegationFinishV22,
  delegationIsTerminalV22,
  delegationRecordToolCallV22,
  delegationToolAllowedV22,
  delegationTransitionAllowedV22,
  delegationVerifyV22,
  transitionFleetV22Delegation,
  validateFleetV22Delegation,
} from '../packages/core/dist/fleetV22/delegation.js';
import {
  FleetV22HandoffAgentRegistry,
  FleetV22HandoffChain,
  MAX_HANDOFFS_PER_CONVERSATION_V22,
  approveFleetV22Handoff,
  buildHandoffContextV22,
  createFleetV22Handoff,
  failFleetV22Handoff,
  handoffToolNameV22,
  rejectFleetV22Handoff,
  suggestHandoffAgentsV22,
  validateFleetV22HandoffAgent,
} from '../packages/core/dist/fleetV22/handoff.js';

const NOW = 1780000000000;

function makeDelegation(id, overrides = {}) {
  return createFleetV22Delegation({
    id,
    parentAgentId: 'parent',
    subagentId: 'sub-1',
    subagentName: 'researcher',
    task: 'Research topic X and summarize.',
    allowedTools: ['search', 'fetch'],
    runId: 'run-1',
    ownerId: 'user-1',
    now: NOW,
    ...overrides,
  });
}

function makeAgent(id, overrides = {}) {
  return {
    id,
    name: id,
    description: 'Handles billing and invoices.',
    instructions: 'You are a billing specialist.',
    allowedTools: ['read-invoice'],
    requiresApproval: false,
    specialty: 'billing',
    ...overrides,
  };
}

function makeHandoff(id, agent, overrides = {}) {
  return createFleetV22Handoff({
    id,
    conversationId: 'conv-1',
    fromAgentId: 'triage',
    toAgent: agent,
    reason: 'User asked about an invoice.',
    messagesTransferred: 5,
    runId: 'run-1',
    ownerId: 'user-1',
    now: NOW,
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Delegation
// ---------------------------------------------------------------------------

test('delegation: create defaults (pending, budget, no children)', () => {
  const d = makeDelegation('d1');
  assert.equal(d.status, 'pending');
  assert.deepEqual(d.budget, DEFAULT_FLEET_V22_DELEGATION_BUDGET);
  assert.equal(d.toolCallsUsed, 0);
  assert.equal(d.verified, null);
  assert.equal(d.depth, 0);
  assert.equal(d.parentDelegationId, null);
  assert.equal(delegationIsTerminalV22(d), false);
  assert.equal(delegationElapsedMsV22(d, NOW), null);
});

test('delegation: full happy path pending → running → awaiting → completed', () => {
  let d = makeDelegation('d1');
  d = transitionFleetV22Delegation(d, 'running', NOW + 1000);
  assert.equal(d.startedAt, NOW + 1000);
  d = delegationRecordToolCallV22(d);
  d = delegationRecordToolCallV22(d, 0.05);
  assert.equal(d.toolCallsUsed, 2);
  assert.equal(d.estimatedCostUsed, 0.05);
  assert.equal(delegationToolAllowedV22(d, 'search'), true);
  assert.equal(delegationToolAllowedV22(d, 'shell'), false);
  d = delegationFinishV22(d, { summary: 'Found 3 sources.', artifacts: [{ id: 'a1', kind: 'text', name: 'notes', summary: 'notes', location: '/tmp/notes.md', sizeBytes: 100 }] });
  assert.equal(d.status, 'awaiting-verification');
  assert.equal(d.summary, 'Found 3 sources.');
  assert.equal(d.artifacts.length, 1);
  d = delegationVerifyV22(d, true, 'Checked the sources, correct.', NOW + 5000);
  assert.equal(d.status, 'completed');
  assert.equal(d.verified, true);
  assert.equal(d.finishedAt, NOW + 5000);
  assert.equal(delegationIsTerminalV22(d), true);
  assert.equal(delegationElapsedMsV22(d, NOW + 6000), 4000);
});

test('delegation: rejected verification becomes failed; finish/verify guards', () => {
  let d = makeDelegation('d1');
  assert.throws(() => delegationFinishV22(d, { summary: 'x' }), /chỉ delegation đang chạy/);
  assert.throws(() => delegationVerifyV22(d, true), /chờ xác minh/);
  d = transitionFleetV22Delegation(d, 'running');
  d = delegationFinishV22(d, { summary: 'Wrong answer.' });
  d = delegationVerifyV22(d, false, 'Sources do not support this.');
  assert.equal(d.status, 'failed');
  assert.equal(d.verified, false);
  assert.match(d.error ?? '', /Sources do not support/);
});

test('delegation: illegal transitions throw', () => {
  const d = makeDelegation('d1');
  assert.equal(delegationTransitionAllowedV22('pending', 'completed'), false);
  assert.throws(() => transitionFleetV22Delegation(d, 'completed'), /không chuyển được/);
  assert.throws(() => transitionFleetV22Delegation(d, 'awaiting-verification'), /không chuyển được/);
  const done = delegationVerifyV22(
    delegationFinishV22(transitionFleetV22Delegation(d, 'running'), { summary: 's' }), true);
  assert.throws(() => transitionFleetV22Delegation(done, 'cancelled'), /không chuyển được/);
});

test('delegation: budget enforcement — tool calls and cost', () => {
  let d = makeDelegation('d1', { budget: { maxToolCalls: 2, maxDurationMs: 60_000, maxDepth: 0, maxEstimatedCost: 0.1 } });
  d = transitionFleetV22Delegation(d, 'running');
  d = delegationRecordToolCallV22(d, 0.04);
  d = delegationRecordToolCallV22(d, 0.04);
  assert.throws(() => delegationRecordToolCallV22(d), /vượt budget tool call/);
  let expensive = makeDelegation('d2', { budget: { maxToolCalls: 50, maxDurationMs: 60_000, maxDepth: 0, maxEstimatedCost: 0.1 } });
  expensive = transitionFleetV22Delegation(expensive, 'running');
  assert.throws(() => delegationRecordToolCallV22(expensive, 0.2), /vượt budget chi phí/);
});

test('delegation: timeout check only fires past maxDurationMs', () => {
  let d = makeDelegation('d1', { budget: { maxToolCalls: 50, maxDurationMs: 1000, maxDepth: 0, maxEstimatedCost: null } });
  d = transitionFleetV22Delegation(d, 'running', NOW);
  assert.equal(delegationCheckTimeoutV22(d, NOW + 999).timedOut, false);
  const checked = delegationCheckTimeoutV22(d, NOW + 1001);
  assert.equal(checked.timedOut, true);
  assert.equal(checked.delegation.status, 'timed-out');
  assert.match(checked.delegation.error ?? '', /quá 1s/);
  // Pending delegation never times out.
  assert.equal(delegationCheckTimeoutV22(makeDelegation('d9'), NOW + 99999).timedOut, false);
});

test('delegation: child spawn only within maxDepth', () => {
  const d0 = makeDelegation('d0', { depth: 0, budget: { maxToolCalls: 10, maxDurationMs: 1000, maxDepth: 1, maxEstimatedCost: null } });
  assert.equal(delegationCanSpawnChildV22(d0), true);
  const d1 = makeDelegation('d1', { depth: 1, budget: { maxToolCalls: 10, maxDurationMs: 1000, maxDepth: 1, maxEstimatedCost: null } });
  assert.equal(delegationCanSpawnChildV22(d1), false);
});

test('delegation registry: active, awaiting verification, timeout sweep', () => {
  const reg = new FleetV22DelegationRegistry();
  const d1 = transitionFleetV22Delegation(makeDelegation('d1'), 'running', NOW);
  const d2 = makeDelegation('d2');
  reg.add(d1);
  reg.add(d2);
  assert.throws(() => reg.add(makeDelegation('d1')), /đã tồn tại/);
  assert.equal(reg.active().length, 2);
  assert.equal(reg.byRun('run-1').length, 2);
  assert.equal(reg.byOwner('user-1').length, 2);
  assert.equal(reg.awaitingVerification().length, 0);
  const finished = delegationFinishV22(d1, { summary: 'done' });
  reg.update(finished);
  assert.equal(reg.awaitingVerification().length, 1);
  assert.equal(reg.active().length, 2); // awaiting-verification is not terminal
  // Timeout sweep with a short budget.
  const reg2 = new FleetV22DelegationRegistry();
  const short = transitionFleetV22Delegation(
    makeDelegation('s1', { budget: { maxToolCalls: 5, maxDurationMs: 1000, maxDepth: 0, maxEstimatedCost: null } }),
    'running', NOW);
  reg2.add(short);
  assert.deepEqual(reg2.checkTimeouts(NOW + 500), []);
  assert.deepEqual(reg2.checkTimeouts(NOW + 2000), ['s1']);
  assert.equal(reg2.get('s1')?.status, 'timed-out');
  assert.equal(reg2.remove('s1'), true);
  assert.throws(() => reg2.update(makeDelegation('ghost')), /chưa có/);
});

test('validateFleetV22Delegation: empty task, bad budget', () => {
  assert.deepEqual(validateFleetV22Delegation(null), ['delegation phải là object.']);
  assert.ok(validateFleetV22Delegation({ ...makeDelegation('d1'), task: '  ' }).length >= 1);
  assert.ok(validateFleetV22Delegation({ ...makeDelegation('d1'), budget: { maxToolCalls: -1 } }).length >= 1);
  assert.deepEqual(validateFleetV22Delegation(makeDelegation('d1')), []);
});

// ---------------------------------------------------------------------------
// Handoff
// ---------------------------------------------------------------------------

test('handoff: tool name is transfer_to_<id>', () => {
  assert.equal(handoffToolNameV22('billing'), 'transfer_to_billing');
  assert.equal(handoffToolNameV22('code-reviewer'), 'transfer_to_code_reviewer');
  assert.equal(MAX_HANDOFFS_PER_CONVERSATION_V22, 10);
});

test('handoff agent registry: register, duplicate, bySpecialty, tool names', () => {
  const reg = new FleetV22HandoffAgentRegistry();
  reg.register(makeAgent('billing'));
  reg.register(makeAgent('coder', { description: 'Writes code.', specialty: 'coding' }));
  assert.throws(() => reg.register(makeAgent('billing')), /đã đăng ký/);
  assert.deepEqual(reg.toolNames(), ['transfer_to_billing', 'transfer_to_coder']);
  assert.deepEqual(reg.bySpecialty('coding').map((a) => a.id), ['coder']);
  assert.equal(reg.unregister('coder'), true);
  assert.equal(reg.get('coder'), undefined);
  assert.throws(() => reg.update(makeAgent('ghost')), /chưa đăng ký/);
});

test('handoff: auto-transferred vs pending-approval, approve/reject/fail', () => {
  const auto = makeHandoff('h1', makeAgent('billing'));
  assert.equal(auto.status, 'transferred');
  assert.equal(auto.toolName, 'transfer_to_billing');
  assert.equal(auto.approvedBy, 'auto (không cần duyệt)');
  assert.equal(auto.resolvedAt, NOW);
  const gated = makeHandoff('h2', makeAgent('payments', { requiresApproval: true }));
  assert.equal(gated.status, 'pending-approval');
  assert.equal(gated.approvedBy, null);
  const approved = approveFleetV22Handoff(gated, 'admin-1', NOW + 100);
  assert.equal(approved.status, 'transferred');
  assert.equal(approved.approvedBy, 'admin-1');
  assert.throws(() => approveFleetV22Handoff(approved, 'admin-1'), /chỉ handoff chờ duyệt/);
  const gated2 = makeHandoff('h3', makeAgent('payments', { requiresApproval: true }));
  const rejected = rejectFleetV22Handoff(gated2, 'User did not confirm.', NOW + 50);
  assert.equal(rejected.status, 'rejected');
  assert.equal(rejected.rejectionReason, 'User did not confirm.');
  const failed = failFleetV22Handoff(makeHandoff('h4', makeAgent('payments', { requiresApproval: true })), 'Target agent crashed.');
  assert.equal(failed.status, 'failed');
  assert.throws(() => failFleetV22Handoff(auto, 'too late'), /đã "transferred"/);
});

test('handoff chain: append order, current agent, trail', () => {
  const chain = new FleetV22HandoffChain('conv-1', 'triage');
  assert.equal(chain.currentAgentId(), 'triage');
  assert.deepEqual(chain.agentTrail(), ['triage']);
  const h1 = makeHandoff('h1', makeAgent('billing'));
  chain.append(h1);
  assert.equal(chain.currentAgentId(), 'billing');
  assert.equal(chain.count, 1);
  assert.deepEqual(chain.agentTrail(), ['triage', 'billing']);
  const h2 = createFleetV22Handoff({
    id: 'h2', conversationId: 'conv-1', fromAgentId: 'billing', toAgent: makeAgent('support', { specialty: 'support' }),
    reason: 'Needs human support.', messagesTransferred: 8, runId: 'run-1', ownerId: 'user-1', now: NOW + 10,
  });
  chain.append(h2);
  assert.equal(chain.currentAgentId(), 'support');
  // Wrong conversation / wrong from-agent / non-transferred step rejected.
  assert.throws(() => chain.append(makeHandoff('hx', makeAgent('billing'), { conversationId: 'conv-2' })), /thuộc hội thoại/);
  assert.throws(() => chain.append(createFleetV22Handoff({
    id: 'hy', conversationId: 'conv-1', fromAgentId: 'triage', toAgent: makeAgent('billing'),
    reason: 'x', messagesTransferred: 1, runId: 'run-1', ownerId: 'user-1', now: NOW,
  })), /đang do "support" giữ/);
  const pending = makeHandoff('hz', makeAgent('payments', { requiresApproval: true }));
  assert.throws(() => chain.append(pending), /Chỉ handoff đã transferred/);
});

test('handoff chain: ping-pong + over-limit guards', () => {
  const reg = new FleetV22HandoffAgentRegistry();
  reg.register(makeAgent('billing'));
  reg.register(makeAgent('support', { specialty: 'support' }));
  const chain = new FleetV22HandoffChain('conv-1', 'triage');
  chain.append(makeHandoff('h1', makeAgent('billing')));
  // Back to triage = ping-pong (triage just left). triage is not registered
  // either — both errors must appear.
  const errors = chain.validateNext('triage', reg);
  assert.ok(errors.some((e) => e.includes('ping-pong')));
  assert.ok(errors.some((e) => e.includes('chưa đăng ký')));
  // Handoff to the current holder is rejected.
  assert.ok(chain.validateNext('billing', reg).some((e) => e.includes('đang giữ hội thoại')));
  // Forward to support is fine.
  assert.deepEqual(chain.validateNext('support', reg), []);
  // Over-limit: 10 steps already.
  const long = new FleetV22HandoffChain('conv-9', 'a0');
  const agents = new FleetV22HandoffAgentRegistry();
  for (let i = 0; i < 10; i++) {
    const id = `a${i + 1}`;
    agents.register(makeAgent(id, { specialty: 's' }));
    long.append(createFleetV22Handoff({
      id: `h${i}`, conversationId: 'conv-9', fromAgentId: `a${i}`, toAgent: makeAgent(id, { specialty: 's' }),
      reason: 'step', messagesTransferred: 1, runId: 'run-1', ownerId: 'user-1', now: NOW + i,
    }));
  }
  assert.equal(long.isOverLimit(), true);
  assert.ok(long.validateNext('a11', agents).some((e) => e.includes('tối đa 10')));
});

test('buildHandoffContextV22: full history + system note + instructions', () => {
  const messages = [
    { role: 'user', content: 'My invoice is wrong.', at: NOW },
    { role: 'assistant', content: 'Let me check.', agentId: 'triage', at: NOW + 1 },
  ];
  const handoff = makeHandoff('h1', makeAgent('billing'));
  const ctx = buildHandoffContextV22({ messages, handoff, toAgent: makeAgent('billing') });
  assert.equal(ctx.messages.length, 2);
  assert.equal(ctx.messages[0].content, 'My invoice is wrong.');
  assert.match(ctx.systemNote, /triage.*billing/);
  assert.match(ctx.systemNote, /2 message/);
  assert.match(ctx.systemNote, /đừng hỏi lại/);
  assert.equal(ctx.instructions, 'You are a billing specialist.');
  // Input messages are copied, not aliased.
  messages[0].content = 'mutated';
  assert.equal(ctx.messages[0].content, 'My invoice is wrong.');
});

test('suggestHandoffAgentsV22: keyword match ranks best agent first', () => {
  const reg = new FleetV22HandoffAgentRegistry();
  reg.register(makeAgent('billing', { description: 'Handles billing and invoices.' }));
  reg.register(makeAgent('coder', { description: 'Writes code and fixes bugs.', specialty: 'coding' }));
  const found = suggestHandoffAgentsV22(reg, 'my invoice is wrong, billing problem');
  assert.equal(found[0].agent.id, 'billing');
  assert.ok(found[0].score > 0);
  assert.deepEqual(suggestHandoffAgentsV22(reg, 'quantum entanglement'), []);
});

test('validateFleetV22HandoffAgent: bad id chars, empty instructions', () => {
  assert.deepEqual(validateFleetV22HandoffAgent(null), ['handoff agent phải là object.']);
  assert.ok(validateFleetV22HandoffAgent(makeAgent('bad-id!')).some((e) => e.includes('chữ, số')));
  assert.ok(validateFleetV22HandoffAgent(makeAgent('ok', { instructions: '' })).length >= 1);
  assert.deepEqual(validateFleetV22HandoffAgent(makeAgent('billing')), []);
});

/**
 * Fleet panels v12 tests (v1.15, Đội T6 — node:test, no network).
 *
 * Covers:
 * - AG-UI panel: gom event theo run (timeline run/text/tool/state/
 *   genui/activity), text delta gom thành preview, run đóng/mở,
 *   interrupt blocking (GENERATIVE_UI confirm + ACTIVITY
 *   waiting-approval), surface đã trả lời/không, validate decision
 *   approve/reject (chỉ user, interrupt phải đang chờ).
 * - Memory panel: lọc fact theo query/confidence/source/quarantine,
 *   sắp xếp theo confidence, KG view (active trước, superseded sau),
 *   đếm quarantine/superseded, validate quarantine review.
 * - GDPR erasure: đếm đúng dữ liệu của user, bước xác nhận đầy đủ,
 *   user không có dữ liệu -> hasData false.
 * - Router panel: model đang load + RAM, decision log mới nhất
 *   trước, budget/spend + cảnh báo 80%/vượt, RAM giới hạn.
 *
 * Imports the BUILT core — build first:
 *   npm run build --workspace=@open-bot/core
 * then: node --test tests/fleet-v115-panels.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildFleetV12AguiPanel,
  buildFleetV12MemoryPanel,
  buildFleetV12RouterPanel,
  planFleetV12GdprErasure,
  validateFleetV12InterruptDecision,
  validateFleetV12QuarantineDecision,
} from '../packages/core/dist/index.js';
import { makeAgUiEvent } from '../packages/core/dist/agui/types.js';

const T0 = '2026-11-16T00:00:00.000Z';

function ev(type, runId, data, opts = {}) {
  return makeAgUiEvent(type, runId, data, { timestamp: T0, ...opts });
}

function fact(overrides = {}) {
  return {
    id: 'fact-1',
    text: 'Huy thích cà phê đen.',
    confidence: 0.9,
    source: 'user',
    createdBy: 'user-1',
    createdAt: Date.UTC(2026, 10, 16),
    quarantined: false,
    quarantineReason: '',
    ...overrides,
  };
}

function entity(overrides = {}) {
  return {
    id: 'ent-1',
    name: 'Huy',
    kind: 'person',
    validFrom: '2026-01-01',
    validTo: '',
    superseded: false,
    supersededBy: '',
    quarantined: false,
    ...overrides,
  };
}

function relation(overrides = {}) {
  return {
    id: 'rel-1',
    fromId: 'ent-1',
    toId: 'ent-2',
    label: 'likes',
    validFrom: '2026-01-01',
    validTo: '',
    superseded: false,
    quarantined: false,
    ...overrides,
  };
}

function routerModel(overrides = {}) {
  return {
    modelId: 'qwen3-4b-q4_k_m',
    kind: 'local',
    status: 'loaded',
    ramMb: 2600,
    contextTokens: 32768,
    requestsServed: 12,
    loadedAt: Date.UTC(2026, 10, 16),
    ...overrides,
  };
}

test('agui panel: gom run, timeline, text preview, run dong/mo', () => {
  const events = [
    ev('RUN_STARTED', 'run-1', { title: 'Viết báo cáo', model: 'qwen3-4b' }, { botId: 'bot-1' }),
    ev('TEXT_MESSAGE_START', 'run-1', { messageId: 'm1' }),
    ev('TEXT_MESSAGE_CONTENT', 'run-1', { messageId: 'm1', delta: 'Xin chào ' }),
    ev('TEXT_MESSAGE_CONTENT', 'run-1', { messageId: 'm1', delta: 'open-bot!' }),
    ev('TOOL_CALL_START', 'run-1', { toolCallId: 'tc1', toolName: 'read_file' }),
    ev('TOOL_CALL_END', 'run-1', { toolCallId: 'tc1', toolName: 'read_file', status: 'ok' }),
    ev('RUN_FINISHED', 'run-1', { status: 'completed', steps: 2, toolCalls: 1, tokensUsed: 120 }),
    ev('RUN_STARTED', 'run-2', { title: 'Chưa xong' }, { botId: 'bot-1' }),
  ];
  const panel = buildFleetV12AguiPanel(events);
  assert.equal(panel.runs.length, 2);
  const run1 = panel.runs.find((r) => r.runId === 'run-1');
  assert.equal(run1.status, 'completed');
  assert.equal(run1.title, 'Viết báo cáo');
  assert.equal(run1.textPreview, 'Xin chào open-bot!');
  assert.equal(run1.toolCalls, 1);
  assert.equal(run1.tokensUsed, 120);
  assert.equal(run1.timeline.length, 7);
  assert.equal(run1.timeline[0].kind, 'run');
  assert.equal(run1.timeline[2].kind, 'text');
  assert.equal(run1.timeline[4].kind, 'tool');
  const run2 = panel.runs.find((r) => r.runId === 'run-2');
  assert.equal(run2.status, 'running');
  assert.equal(panel.runningRunCount, 1);
  assert.equal(panel.pendingInterruptCount, 0);
  assert.ok(panel.summary.includes('2 run'));
  // Rỗng.
  const empty = buildFleetV12AguiPanel([]);
  assert.equal(empty.runs.length, 0);
  assert.ok(empty.summary.includes('Chưa có event'));
  // RUN_ERROR -> failed.
  const failed = buildFleetV12AguiPanel([
    ev('RUN_STARTED', 'run-9', {}),
    ev('RUN_ERROR', 'run-9', { message: 'provider timeout', code: 'TIMEOUT' }),
  ]);
  assert.equal(failed.runs[0].status, 'failed');
  assert.equal(failed.runs[0].timeline[1].status, 'error');
});

test('agui panel: interrupt blocking + surface + validate approve/reject', () => {
  const events = [
    ev('RUN_STARTED', 'run-1', { title: 'Gửi mail' }),
    ev('GENERATIVE_UI', 'run-1', {
      componentId: 'c1', kind: 'confirm', title: 'Gửi mail cho Huy?',
      description: 'Mail sẽ gửi tới huy@example.com', props: {}, blocking: true,
    }),
    ev('ACTIVITY', 'run-1', { kind: 'waiting-approval', label: 'Chờ duyệt xóa file', detail: 'file report.pdf' }),
    ev('GENERATIVE_UI', 'run-1', {
      componentId: 'c2', kind: 'options', title: 'Chọn giọng đọc',
      props: { options: ['A', 'B'] }, blocking: false,
    }),
    ev('GENERATIVE_UI_RESPONSE', 'run-1', { componentId: 'c2', response: { choice: 'A' }, action: 'submit' }),
  ];
  const panel = buildFleetV12AguiPanel(events);
  assert.equal(panel.interrupts.length, 2);
  assert.equal(panel.interrupts[0].id, 'c1');
  assert.equal(panel.interrupts[0].kind, 'confirm');
  assert.equal(panel.interrupts[0].blocking, true);
  assert.equal(panel.interrupts[1].kind, 'approval');
  assert.equal(panel.surfaces.length, 2);
  const c1 = panel.surfaces.find((s) => s.componentId === 'c1');
  const c2 = panel.surfaces.find((s) => s.componentId === 'c2');
  assert.equal(c1.answered, false);
  assert.equal(c2.answered, true);
  assert.equal(panel.runs[0].status, 'waiting');
  assert.equal(panel.pendingInterruptCount, 2);
  // Validate decision: chỉ user, interrupt phải đang chờ, decision hợp lệ.
  const ok = validateFleetV12InterruptDecision(panel, 'c1', 'approve', 'user');
  assert.equal(ok.ok, true);
  assert.equal(ok.response.action, 'confirm');
  assert.equal(ok.response.decision, 'approve');
  const rejected = validateFleetV12InterruptDecision(panel, 'c1', 'reject', 'user');
  assert.equal(rejected.ok, true);
  assert.equal(rejected.response.action, 'dismiss');
  assert.equal(validateFleetV12InterruptDecision(panel, 'c1', 'approve', 'agent:bot-1').ok, false);
  assert.equal(validateFleetV12InterruptDecision(panel, 'c1', 'maybe', 'user').ok, false);
  assert.equal(validateFleetV12InterruptDecision(panel, 'khong-co', 'approve', 'user').ok, false);
  // Confirm đã trả lời rồi thì không còn là interrupt chờ.
  const answered = buildFleetV12AguiPanel([
    ev('RUN_STARTED', 'run-1', {}),
    ev('GENERATIVE_UI', 'run-1', { componentId: 'c9', kind: 'confirm', title: 'OK?', props: {}, blocking: true }),
    ev('GENERATIVE_UI_RESPONSE', 'run-1', { componentId: 'c9', response: {}, action: 'confirm' }),
  ]);
  assert.equal(answered.interrupts.length, 0);
  assert.equal(answered.surfaces[0].answered, true);
});

test('memory panel: loc fact, KG view, dem quarantine/superseded', () => {
  const facts = [
    fact({ id: 'f1', text: 'Huy thích cà phê đen.', confidence: 0.9, source: 'user' }),
    fact({ id: 'f2', text: 'Huy ghét ồn ào.', confidence: 0.4, source: 'agent', quarantined: true, quarantineReason: 'nghi poisoning' }),
    fact({ id: 'f3', text: 'Open-bot chạy local.', confidence: 0.8, source: 'user' }),
  ];
  const entities = [
    entity({ id: 'e1', name: 'Huy' }),
    entity({ id: 'e2', name: 'Huy cũ', superseded: true, supersededBy: 'e1' }),
  ];
  const relations = [
    relation({ id: 'r1' }),
    relation({ id: 'r2', superseded: true }),
  ];
  const panel = buildFleetV12MemoryPanel(facts, entities, relations, {});
  assert.equal(panel.totalFacts, 3);
  assert.equal(panel.quarantinedCount, 1);
  assert.equal(panel.facts[0].id, 'f1');
  assert.equal(panel.activeEntityCount, 1);
  assert.equal(panel.supersededCount, 2);
  assert.equal(panel.entities[0].id, 'e1');
  assert.equal(panel.entities[1].superseded, true);
  assert.ok(panel.summary.includes('3 fact'));
  // Lọc query.
  assert.equal(buildFleetV12MemoryPanel(facts, entities, relations, { query: 'cà phê' }).facts.length, 1);
  // Lọc confidence.
  assert.equal(buildFleetV12MemoryPanel(facts, entities, relations, { minConfidence: 0.85 }).facts.length, 1);
  // Lọc source.
  assert.equal(buildFleetV12MemoryPanel(facts, entities, relations, { source: 'agent' }).facts.length, 1);
  // Lọc quarantine.
  assert.equal(buildFleetV12MemoryPanel(facts, entities, relations, { quarantined: 'quarantined' }).facts.length, 1);
  assert.equal(buildFleetV12MemoryPanel(facts, entities, relations, { quarantined: 'clean' }).facts.length, 2);
  // minConfidence kẹp 0–1.
  assert.equal(buildFleetV12MemoryPanel(facts, entities, relations, { minConfidence: 5 }).facts.length, 0);
  // Rỗng.
  const empty = buildFleetV12MemoryPanel([], [], [], {});
  assert.equal(empty.totalFacts, 0);
  assert.ok(empty.summary.includes('Chưa có fact'));
  // Validate quarantine review: chỉ user, fact phải đang quarantine.
  assert.deepEqual(validateFleetV12QuarantineDecision(facts[1], 'restore', 'user'), { ok: true, error: '' });
  assert.equal(validateFleetV12QuarantineDecision(facts[1], 'delete', 'user').ok, true);
  assert.equal(validateFleetV12QuarantineDecision(facts[1], 'restore', 'agent:bot-1').ok, false);
  assert.equal(validateFleetV12QuarantineDecision(facts[0], 'restore', 'user').ok, false);
  assert.equal(validateFleetV12QuarantineDecision(facts[1], 'ban', 'user').ok, false);
  assert.equal(validateFleetV12QuarantineDecision(null, 'restore', 'user').ok, false);
});

test('gdpr erasure: dem dung du lieu user, buoc xac nhan, user khong co du lieu', () => {
  const facts = [
    fact({ id: 'f1', createdBy: 'user-1' }),
    fact({ id: 'f2', createdBy: 'user-1', quarantined: true, quarantineReason: 'nghi' }),
    fact({ id: 'f3', createdBy: 'user-2' }),
  ];
  const entities = [
    entity({ id: 'user:user-1:ent-1', name: 'Huy' }),
    entity({ id: 'ent-x', name: 'Khác' }),
  ];
  const relations = [
    relation({ id: 'rel-1', fromId: 'user:user-1:ent-1', toId: 'ent-x' }),
    relation({ id: 'rel-2', fromId: 'ent-x', toId: 'ent-y' }),
  ];
  const plan = planFleetV12GdprErasure('user-1', facts, entities, relations);
  assert.equal(plan.factCount, 2);
  assert.equal(plan.quarantinedFactCount, 1);
  assert.equal(plan.entityCount, 1);
  assert.equal(plan.relationCount, 1);
  assert.equal(plan.hasData, true);
  assert.equal(plan.steps.length, 5);
  assert.ok(plan.steps[1].includes('Xuất bản sao'));
  assert.ok(plan.summary.includes('2 fact'));
  const none = planFleetV12GdprErasure('user-9', facts, entities, relations);
  assert.equal(none.hasData, false);
  assert.equal(none.factCount, 0);
  assert.equal(none.steps.length, 1);
});

test('router panel: model load + RAM, decision log, budget/spend + canh bao', () => {
  const models = [
    routerModel({ modelId: 'qwen3-4b-q4_k_m', ramMb: 2600, status: 'loaded' }),
    routerModel({ modelId: 'llama-3.2-3b-q4_k_m', ramMb: 1900, status: 'loaded' }),
    routerModel({ modelId: 'gpt-cloud', kind: 'cloud', ramMb: 0, status: 'unloaded' }),
  ];
  const decisions = [
    { at: 1000, taskKind: 'chat', chosenModelId: 'qwen3-4b-q4_k_m', reason: 'local-first', estimatedCostUsd: 0, latencyMs: 120 },
    { at: 2000, taskKind: 'code', chosenModelId: 'gpt-cloud', reason: 'quality', estimatedCostUsd: 0.02, latencyMs: 900 },
    { at: 1500, taskKind: 'chat', chosenModelId: 'qwen3-4b-q4_k_m', reason: 'local-first', estimatedCostUsd: 0, latencyMs: 100 },
  ];
  const panel = buildFleetV12RouterPanel(models, decisions, { ramLimitMb: 5000, budgetUsd: 0.025 });
  assert.equal(panel.loadedCount, 2);
  assert.equal(panel.totalRamMb, 4500);
  assert.equal(panel.ramUsagePct, 90);
  assert.equal(panel.decisions[0].at, 2000);
  assert.equal(panel.decisions.length, 3);
  assert.equal(panel.totalSpendUsd, 0.02);
  assert.equal(panel.spendPct, 80);
  assert.ok(panel.budgetWarning.includes('Sắp hết budget'));
  assert.ok(panel.summary.includes('2/3 model đang load'));
  // Vượt budget.
  const over = buildFleetV12RouterPanel(models, decisions, { budgetUsd: 0.01 });
  assert.ok(over.budgetWarning.includes('vượt budget'));
  // Không budget -> không cảnh báo, spendPct null.
  const noBudget = buildFleetV12RouterPanel(models, decisions, {});
  assert.equal(noBudget.spendPct, null);
  assert.equal(noBudget.budgetWarning, '');
  assert.equal(noBudget.ramUsagePct, null);
  // Rỗng.
  const empty = buildFleetV12RouterPanel([], [], {});
  assert.equal(empty.loadedCount, 0);
  assert.ok(empty.summary.includes('chưa load model'));
});

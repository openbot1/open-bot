/**
 * Panels v13 tests (v1.16, Đội T6 — node:test, no network).
 *
 * Covers:
 * - Memory v15: lọc theo query/confidence/quarantine; sắp xếp
 *   confidence giảm dần; đếm active/superseded/quarantined; hybrid
 *   score = 0.4 vector + 0.25 BM25 + 0.2 graph + 0.15 recency, fact
 *   supersede/quarantine bị phạt 50%; reorganize plan (split >= 20
 *   fact, merge khi >= nửa supersede, archive khi idle > 90 ngày).
 * - Router v2: model picker chấm điểm (local + loaded được cộng
 *   fit, model lỗi bị phạt); unload plan (error → ngay, TTL 30
 *   phút, LRU khi vượt 4 model); swap groups gom đúng.
 * - Voice v15: budget từng tầng (avg/p95/vượt), barge-in đếm,
 *   clean turn rate, end-to-end trung bình + alert > 600ms.
 * - Fleet v13 panel: gom node/capacity/rebalance/event/rollout;
 *   validate panel đủ field.
 *
 * Imports the BUILT core — build first:
 *   npm run build --workspace=@open-bot/core
 * then: node --test tests/fleet-v116-panels.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  FLEET_V13_HYBRID_WEIGHTS,
  FLEET_V13_VOICE_BUDGETS_MS,
  buildFleetV13MemoryPanel,
  buildFleetV13Panel,
  buildFleetV13RouterPanel,
  buildFleetV13VoicePanel,
  createFleetV13PinSnapshot,
  pinFleetV13ModelToNode,
  planFleetV13Unload,
  registerFleetV13Node,
  scoreFleetV13Hybrid,
  scoreFleetV13ModelPick,
  validateFleetV13Panel,
} from '../packages/core/dist/fleetV13/index.js';

const T0 = Date.UTC(2026, 10, 16, 0, 0, 0);

function fact(id, overrides = {}) {
  return {
    id,
    text: `Fact ${id}: Huy thích cà phê đen.`,
    confidence: 0.9,
    source: 'user',
    createdBy: 'u_owner',
    createdAt: T0,
    supersededBy: '',
    quarantined: false,
    quarantineReason: '',
    ...overrides,
  };
}

function routerModel(id, overrides = {}) {
  return {
    modelId: id,
    kind: 'local',
    status: 'loaded',
    ramMb: 3000,
    vramMb: 2500,
    requestsServed: 10,
    loadedAt: T0,
    lastUsedAt: T0,
    costPer1kUsd: 0,
    avgLatencyMs: 100,
    qualityScore: 0.8,
    swapGroup: 'gpu-a',
    ...overrides,
  };
}

function voiceTurn(id, stageMs, overrides = {}) {
  return {
    turnId: id,
    at: T0,
    stages: Object.entries(stageMs).map(([stage, measuredMs]) => ({
      stage,
      measuredMs,
      budgetMs: FLEET_V13_VOICE_BUDGETS_MS[stage],
    })),
    bargedIn: false,
    cleanTurnEnd: true,
    ...overrides,
  };
}

test('memory panel: filter/sort/counts; hybrid scoring with 50% penalty; reorganize plans', () => {
  const facts = [
    fact('f1', { confidence: 0.95 }),
    fact('f2', { confidence: 0.5, text: 'Fact f2: trời mưa.' }),
    fact('f3', { confidence: 0.8, supersededBy: 'f9' }),
    fact('f4', { confidence: 0.7, quarantined: true, quarantineReason: 'nghi ngờ' }),
  ];
  const panel = buildFleetV13MemoryPanel(facts);
  assert.equal(panel.totalFacts, 4);
  assert.equal(panel.activeCount, 2);
  assert.equal(panel.supersededCount, 1);
  assert.equal(panel.quarantinedCount, 1);
  assert.deepEqual(panel.facts.map((f) => f.id), ['f1', 'f3', 'f4', 'f2']); // confidence giảm dần
  assert.equal(panel.facts[0].active, true);
  assert.equal(panel.facts[1].active, false); // superseded

  const byQuery = buildFleetV13MemoryPanel(facts, { query: 'mưa' });
  assert.deepEqual(byQuery.facts.map((f) => f.id), ['f2']);
  const byConf = buildFleetV13MemoryPanel(facts, { minConfidence: 0.8 });
  assert.deepEqual(byConf.facts.map((f) => f.id), ['f1', 'f3']);
  const noQuar = buildFleetV13MemoryPanel(facts, { includeQuarantined: false });
  assert.equal(noQuar.facts.some((f) => f.id === 'f4'), false);

  // Hybrid: trọng số cộng đúng; fact supersede bị phạt 50%.
  const signals = { vector: 1, bm25: 1, graph: 1, recency: 1 };
  const s1 = scoreFleetV13Hybrid(facts[0], signals);
  assert.equal(s1.score, 1);
  assert.deepEqual(FLEET_V13_HYBRID_WEIGHTS, { vector: 0.4, bm25: 0.25, graph: 0.2, recency: 0.15 });
  const s3 = scoreFleetV13Hybrid(facts[2], signals);
  assert.equal(s3.score, 0.5);
  assert.match(s3.explanation, /phạt 50%/);
  const partial = scoreFleetV13Hybrid(facts[0], { vector: 0.5, bm25: 0.5, graph: 0.5, recency: 0.5 });
  assert.equal(partial.score, 0.5);

  const hybrid = buildFleetV13MemoryPanel(facts, {
    hybridSignals: {
      f1: signals,
      f2: { vector: 0.2, bm25: 0.2, graph: 0.2, recency: 0.2 },
    },
  });
  assert.deepEqual(hybrid.hybridTop.map((h) => h.factId), ['f1', 'f2']);

  // Reorganize: block 20 fact → split; nửa supersede → merge; idle > 90 ngày → archive.
  const bigFacts = Array.from({ length: 20 }, (_, i) => fact(`bf${i}`));
  const mergeFacts = [fact('m1', { supersededBy: 'x' }), fact('m2', { supersededBy: 'y' }), fact('m3'), fact('m4')];
  const oldFacts = [fact('o1')];
  const plans = buildFleetV13MemoryPanel([...bigFacts, ...mergeFacts, ...oldFacts], {
    blocks: [
      { blockId: 'big', factIds: bigFacts.map((f) => f.id), lastTouchedAt: T0 },
      { blockId: 'merge', factIds: ['m1', 'm2', 'm3', 'm4'], lastTouchedAt: T0 },
      { blockId: 'old', factIds: ['o1'], lastTouchedAt: T0 - 100 * 24 * 60 * 60 * 1000 },
      { blockId: 'ok', factIds: ['bf0'], lastTouchedAt: T0 },
    ],
    now: T0,
  });
  const byId = Object.fromEntries(plans.reorganizePlans.map((p) => [p.blockId, p.action]));
  assert.equal(byId.big, 'split');
  assert.equal(byId.merge, 'merge');
  assert.equal(byId.old, 'archive');
  assert.equal(byId.ok, 'none');

  const empty = buildFleetV13MemoryPanel([]);
  assert.equal(empty.totalFacts, 0);
  assert.match(empty.summary, /Chưa có fact/);
});

test('router panel: picker scores local+loaded higher, error penalized; unload TTL/LRU/error; swap groups', () => {
  const models = [
    routerModel('local-fast', { avgLatencyMs: 80, qualityScore: 0.9 }),
    routerModel('cloud-cheap', { kind: 'cloud', costPer1kUsd: 0.001, avgLatencyMs: 400, qualityScore: 0.7, swapGroup: '' }),
    routerModel('broken', { status: 'error', qualityScore: 0.95 }),
    routerModel('idle-old', { lastUsedAt: T0 - 60 * 60 * 1000, loadedAt: T0 - 60 * 60 * 1000 }),
  ];
  const task = { kind: 'chat', needsLocal: true, maxCostPer1kUsd: 0.01, maxLatencyMs: 1000 };
  const panel = buildFleetV13RouterPanel(models, task, T0);
  assert.equal(panel.loadedCount, 3);
  assert.equal(panel.totalRamMb, 9000);
  assert.equal(panel.picks[0].modelId, 'local-fast');
  assert.ok(panel.picks[0].score > panel.picks.find((p) => p.modelId === 'cloud-cheap').score);
  const broken = panel.picks.find((p) => p.modelId === 'broken');
  assert.ok(broken.score < 0.4, `broken score ${broken.score}`);
  assert.match(broken.reason, /error/);

  // Unload: broken → unload-error; idle-old quá TTL → unload-ttl.
  const byId = Object.fromEntries(panel.unloadPlans.map((p) => [p.modelId, p.action]));
  assert.equal(byId.broken, 'unload-error');
  assert.equal(byId['idle-old'], 'unload-ttl');
  assert.equal(byId['local-fast'], 'keep');

  // LRU: 5 model loaded, vượt max 4 → ít dùng nhất unload-lru.
  const five = [
    routerModel('a', { lastUsedAt: T0 - 5000 }),
    routerModel('b', { lastUsedAt: T0 - 4000 }),
    routerModel('c', { lastUsedAt: T0 - 3000 }),
    routerModel('d', { lastUsedAt: T0 - 2000 }),
    routerModel('e', { lastUsedAt: T0 - 1000 }),
  ];
  const lru = planFleetV13Unload(five, T0);
  assert.equal(lru.find((p) => p.modelId === 'a').action, 'unload-lru');
  assert.equal(lru.find((p) => p.modelId === 'e').action, 'keep');

  // Swap groups gom đúng.
  assert.equal(panel.swapGroups.length, 2);
  const gpuA = panel.swapGroups.find((g) => g.group === 'gpu-a');
  assert.deepEqual(gpuA.modelIds, ['broken', 'idle-old', 'local-fast']);
  assert.equal(gpuA.totalRamMb, 9000);
  assert.equal(panel.swapGroups.find((g) => g.group === '(không nhóm)').modelIds.length, 1);

  // score trực tiếp: model cloud cho task cần local bị fit 0.
  const cloudPick = scoreFleetV13ModelPick(models[1], task, 0, 80);
  assert.equal(cloudPick.fitScore < 0.9, true);
  const empty = buildFleetV13RouterPanel([], task, T0);
  assert.match(empty.summary, /chưa có model/);
});

test('voice panel: per-stage avg/p95/over-budget, barge-in, clean rate, end-to-end alert', () => {
  const turns = [
    voiceTurn('t1', { vad: 100, stt: 200, llm: 500, tts: 150, orchestrator: 30 }),
    voiceTurn('t2', { vad: 120, stt: 250, llm: 700, tts: 180, orchestrator: 40 }, { bargedIn: true }),
    voiceTurn('t3', { vad: 200, stt: 400, llm: 1200, tts: 300, orchestrator: 80 }, { cleanTurnEnd: false }),
  ];
  const panel = buildFleetV13VoicePanel(turns);
  assert.equal(panel.turnCount, 3);
  assert.equal(panel.bargeInCount, 1);
  assert.equal(panel.cleanTurnRate, 0.667);
  const llm = panel.budgets.find((b) => b.stage === 'llm');
  assert.equal(llm.budgetMs, 800);
  assert.equal(llm.avgMs, 800);
  assert.equal(llm.p95Ms, 1200);
  assert.equal(llm.overBudgetTurns, 1);
  assert.equal(llm.alert, true);
  const vad = panel.budgets.find((b) => b.stage === 'vad');
  assert.equal(vad.p95Ms, 200);
  assert.equal(vad.alert, true); // p95 200ms vượt ngân sách VAD 150ms
  assert.equal(vad.totalTurns, 3);
  // End-to-end trung bình = (980+1290+2180)/3 = 1483ms → alert.
  assert.equal(panel.avgEndToEndMs, 1483);
  assert.equal(panel.endToEndAlert, true);
  assert.match(panel.summary, /3 turn/);

  const fast = buildFleetV13VoicePanel([
    voiceTurn('t1', { vad: 50, stt: 100, llm: 200, tts: 80, orchestrator: 20 }),
  ]);
  assert.equal(fast.endToEndAlert, false);
  assert.equal(fast.avgEndToEndMs, 450);
  assert.equal(fast.cleanTurnRate, 1);

  const empty = buildFleetV13VoicePanel([]);
  assert.equal(empty.turnCount, 0);
  assert.equal(empty.avgEndToEndMs, null);
  assert.equal(empty.cleanTurnRate, null);
  assert.match(empty.summary, /Chưa có turn/);
});

test('fleet panel: nodes/capacity/rebalance/events/rollouts assembled; validation', () => {
  let snap = createFleetV13PinSnapshot('u_owner', T0);
  const a = registerFleetV13Node(snap, {
    nodeId: 'node-a', ramTotalMb: 16384, ramFreeMb: 16384, vramTotalMb: 8192, vramFreeMb: 6144, cpuCores: 8, lastHeartbeatAt: T0,
  }, 'u_owner', T0);
  snap = a.snapshot;
  const b = registerFleetV13Node(snap, {
    nodeId: 'node-b', ramTotalMb: 16384, ramFreeMb: 16384, vramTotalMb: 8192, vramFreeMb: 6144, cpuCores: 8, lastHeartbeatAt: T0,
  }, 'u_owner', T0);
  snap = b.snapshot;
  const pinned = pinFleetV13ModelToNode(snap, 'node-a', {
    modelId: 'big-a', displayName: 'big-a', ramMb: 14000, vramMb: 100, contextTokens: 32768, quant: 'Q4_K_M',
  }, 'u_owner', T0);
  assert.equal(pinned.ok, true, pinned.error ?? '');
  snap = pinned.snapshot;

  const events = [
    { seq: 1, at: T0, kind: 'pin', nodeId: 'node-a', actorUserId: 'u_owner', detail: 'pinned big-a' },
    { seq: 2, at: T0 + 1, kind: 'node-join', nodeId: 'node-b', actorUserId: 'system', detail: 'node-b joined' },
  ];
  const rollouts = [
    { id: 'r1', feature: 'voice-v15', version: 'v15', previousVersion: 'v14', stage: 'canary', stageBeforePause: null, createdBy: 'u_owner', createdAt: T0, updatedAt: T0, updatedBy: 'u_owner', note: '', history: [] },
  ];
  const panel = buildFleetV13Panel(snap, events, rollouts);
  assert.equal(panel.nodes.length, 2);
  assert.deepEqual(panel.nodes.find((n) => n.nodeId === 'node-a').pinnedModels, ['big-a']);
  assert.equal(panel.nodes.find((n) => n.nodeId === 'node-a').overloaded, true);
  assert.equal(panel.capacity.overloadedNodes.length, 1);
  assert.equal(panel.rebalance.length, 1);
  assert.equal(panel.rebalance[0].modelId, 'big-a');
  assert.equal(panel.rebalance[0].toNodeId, 'node-b');
  assert.equal(panel.events.length, 2);
  assert.equal(panel.events[0].seq, 2); // mới nhất trước
  assert.equal(panel.rollouts.length, 1);
  assert.equal(panel.rollouts[0].stageLabel, 'canary (1% user)');
  assert.deepEqual(validateFleetV13Panel(panel), []);
  assert.match(panel.summary, /2 node/);

  const emptyPanel = buildFleetV13Panel(createFleetV13PinSnapshot('u', T0), []);
  assert.deepEqual(validateFleetV13Panel(emptyPanel), []);
  assert.match(emptyPanel.summary, /chưa có node/);
  assert.deepEqual(validateFleetV13Panel({ nodes: 'x', capacity: null, rebalance: [], events: [], rollouts: [] }).length > 0, true);
});

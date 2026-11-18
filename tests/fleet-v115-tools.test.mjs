/**
 * Fleet v12 tools tests (v1.15, Đội T6 — node:test, no network).
 *
 * Covers:
 * - 9 tool v12: đủ tên, không trùng, có trong ALL_TOOLS (500 =
 *   491 + 9), binding giữ nguyên số lượng, approval flags đúng.
 * - Pure tools chạy được khi chưa bind (health dashboard, 2 panel
 *   tools).
 * - Bound tools end-to-end trên tmp userData dir: pin model ->
 *   verify hash thật -> list pins; rollout create -> action
 *   (start -> advance bị gate chặn -> advance sau khi cohort done)
 *   -> status; arg validation trả Error string, không throw.
 * - Unbound file tools trả NOT_WIRED (Error) thay vì crash.
 * - OS-provided model bị từ chối ở tool pin.
 * - i18n: 91 key fleetV12 có đủ 6 locale, không rỗng; tổng mỗi
 *   locale = 5495.
 *
 * Imports the BUILT core + tools — build first:
 *   npm run build --workspace=@open-bot/core
 *   npm run build --workspace=@open-bot/tools
 * then: node --test tests/fleet-v115-tools.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  FLEET_V12_TOOL_NAMES,
  FLEET_V12_TOOLS,
  createFleetV12Tools,
  isFleetV12ToolName,
} from '../packages/tools/dist/fleetV12Tools.js';
import { ALL_TOOLS, createDefaultTools } from '../packages/tools/dist/tools.js';

const T0 = Date.UTC(2026, 10, 16, 0, 0, 0);

function tmpDir(prefix = 'open-bot-fleet-v12-tools-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function toolByName(tools, name) {
  const t = tools.find((x) => x.definition.name === name);
  assert.ok(t, `tool missing: ${name}`);
  return t;
}

async function runTool(tools, name, args, ctx = {}) {
  return toolByName(tools, name).execute(args, { workspaceDir: os.tmpdir(), botId: 'test-bot', ...ctx });
}

function nodeSamples() {
  return [
    { nodeId: 'node-1', at: T0, cpuPct: 40, ramPct: 50, diskPct: 60, uptimeMs: 3600_000, lastHeartbeatAt: T0, botCount: 1, botCapacity: 4, loadedModelId: 'qwen3-4b-q4_k_m', modelStatus: 'verified', tokensPerSec: 42, pendingRequests: 0 },
    { nodeId: 'node-2', at: T0, cpuPct: 90, ramPct: 96, diskPct: 70, uptimeMs: 3600_000, lastHeartbeatAt: T0, botCount: 0, botCapacity: 2, loadedModelId: 'llama-3.2-3b-q4_k_m', modelStatus: 'drift', tokensPerSec: 8, pendingRequests: 1 },
  ];
}

function aguiEvents() {
  return [
    { type: 'RUN_STARTED', runId: 'run-1', botId: 'bot-1', timestamp: '2026-11-16T00:00:00.000Z', data: { title: 'Viết báo cáo' } },
    { type: 'TEXT_MESSAGE_CONTENT', runId: 'run-1', timestamp: '2026-11-16T00:00:01.000Z', data: { messageId: 'm1', delta: 'Xin chào!' } },
    { type: 'GENERATIVE_UI', runId: 'run-1', timestamp: '2026-11-16T00:00:02.000Z', data: { componentId: 'c1', kind: 'confirm', title: 'Gửi mail?', props: {}, blocking: true } },
    { type: 'RUN_FINISHED', runId: 'run-1', timestamp: '2026-11-16T00:00:03.000Z', data: { status: 'completed', steps: 1, toolCalls: 0, tokensUsed: 50 } },
  ];
}

test('registry: 9 tool v12, ten dung, khong trung, co trong ALL_TOOLS (500), approval dung', () => {
  assert.equal(FLEET_V12_TOOLS.length, 9);
  assert.deepEqual([...FLEET_V12_TOOL_NAMES], [
    'fleet_model_pin_v12',
    'fleet_model_verify_v12',
    'fleet_model_pins_v12',
    'fleet_rollout_create_v12',
    'fleet_rollout_action_v12',
    'fleet_rollout_status_v12',
    'fleet_health_dashboard_v12',
    'fleet_panel_agui_v12',
    'fleet_panel_memory_router_v12',
  ]);
  const names = FLEET_V12_TOOLS.map((t) => t.definition.name);
  assert.equal(new Set(names).size, names.length);
  for (const name of FLEET_V12_TOOL_NAMES) {
    assert.ok(isFleetV12ToolName(name));
    assert.ok(ALL_TOOLS.some((t) => t.definition.name === name), `missing in ALL_TOOLS: ${name}`);
  }
  assert.equal(isFleetV12ToolName('fleet_health_snapshot_v11'), false);
  assert.equal(ALL_TOOLS.length, 899); // v1.36 re-pin: 825 + 74 = 899.
  assert.equal(new Set(ALL_TOOLS.map((t) => t.definition.name)).size, ALL_TOOLS.length);
  const needsApproval = Object.fromEntries(
    FLEET_V12_TOOLS.map((t) => [t.definition.name, t.needsApproval]),
  );
  assert.equal(needsApproval['fleet_model_pin_v12'], true);
  assert.equal(needsApproval['fleet_rollout_create_v12'], true);
  assert.equal(needsApproval['fleet_rollout_action_v12'], true);
  assert.equal(needsApproval['fleet_model_verify_v12'], false);
  assert.equal(needsApproval['fleet_model_pins_v12'], false);
  assert.equal(needsApproval['fleet_rollout_status_v12'], false);
  assert.equal(needsApproval['fleet_health_dashboard_v12'], false);
  assert.equal(needsApproval['fleet_panel_agui_v12'], false);
  assert.equal(needsApproval['fleet_panel_memory_router_v12'], false);
});

test('binding: createDefaultTools thay the dung cho, giu nguyen so luong', () => {
  const base = tmpDir();
  const bound = createDefaultTools({ getFleetV12BaseDir: () => base });
  assert.equal(bound.length, ALL_TOOLS.length);
  assert.equal(new Set(bound.map((t) => t.definition.name)).size, bound.length);
  for (const name of FLEET_V12_TOOL_NAMES) {
    assert.ok(bound.some((t) => t.definition.name === name));
  }
  // Không bind thì trả đúng ALL_TOOLS.
  assert.equal(createDefaultTools().length, ALL_TOOLS.length);
});

test('pure tools chay duoc khi chua bind: health dashboard + 2 panel', async () => {
  const tools = FLEET_V12_TOOLS;
  const dash = JSON.parse(await runTool(tools, 'fleet_health_dashboard_v12', { nodes: nodeSamples(), now: T0 }));
  assert.equal(dash.dashboard.nodeCount, 2);
  assert.equal(dash.dashboard.byStatus.healthy, 1);
  assert.equal(dash.dashboard.byStatus.unhealthy, 1);
  assert.deepEqual(dash.dashboard.driftNodeIds, ['node-2']);
  assert.equal(dash.dashboard.openAlerts.length, 0);
  const agui = JSON.parse(await runTool(tools, 'fleet_panel_agui_v12', { events: aguiEvents() }));
  assert.equal(agui.panel.runs.length, 1);
  assert.equal(agui.panel.runs[0].textPreview, 'Xin chào!');
  assert.equal(agui.panel.pendingInterruptCount, 1);
  assert.equal(agui.panel.surfaces.length, 1);
  // Validate interrupt decision qua tool.
  const decided = JSON.parse(await runTool(tools, 'fleet_panel_agui_v12', {
    events: aguiEvents(),
    interruptDecision: { interruptId: 'c1', decision: 'approve', actor: 'user' },
  }));
  assert.equal(decided.interruptValidation.ok, true);
  const denied = JSON.parse(await runTool(tools, 'fleet_panel_agui_v12', {
    events: aguiEvents(),
    interruptDecision: { interruptId: 'c1', decision: 'approve', actor: 'agent:bot-1' },
  }));
  assert.equal(denied.interruptValidation.ok, false);
  const panels = JSON.parse(await runTool(tools, 'fleet_panel_memory_router_v12', {
    facts: [{ id: 'f1', text: 'Huy thích cà phê.', confidence: 0.9, source: 'user', createdBy: 'user-1', createdAt: T0 }],
    entities: [{ id: 'e1', name: 'Huy', kind: 'person', validFrom: '2026-01-01', validTo: '', superseded: false, supersededBy: '', quarantined: false }],
    relations: [],
    gdprUserId: 'user-1',
    routerModels: [{ modelId: 'qwen3-4b-q4_k_m', kind: 'local', status: 'loaded', ramMb: 2600, contextTokens: 32768, requestsServed: 3, loadedAt: T0 }],
    routingDecisions: [{ at: T0, taskKind: 'chat', chosenModelId: 'qwen3-4b-q4_k_m', reason: 'local-first', estimatedCostUsd: 0, latencyMs: 120 }],
    ramLimitMb: 5000,
    budgetUsd: 10,
  }));
  assert.equal(panels.memoryPanel.totalFacts, 1);
  assert.equal(panels.erasure.factCount, 1);
  assert.equal(panels.erasure.hasData, true);
  assert.equal(panels.routerPanel.loadedCount, 1);
  assert.equal(panels.routerPanel.totalRamMb, 2600);
});

test('bound tools e2e: pin -> verify hash that -> list; rollout create -> action -> status', async () => {
  const base = tmpDir();
  const tools = createFleetV12Tools(() => base);
  // Pin model với hash thật của file tạm.
  const content = 'fake-gguf-bytes-v12-tools';
  const ggufDir = tmpDir('open-bot-fleet-v12-gguf-');
  const ggufPath = path.join(ggufDir, 'qwen3-4b-q4_k_m.gguf');
  fs.writeFileSync(ggufPath, content);
  const sha256 = crypto.createHash('sha256').update(content).digest('hex');
  const size = Buffer.byteLength(content);
  const pinned = JSON.parse(await runTool(tools, 'fleet_model_pin_v12', {
    modelId: 'qwen3-4b-q4_k_m', publisher: 'Qwen', license: 'Apache-2.0', quant: 'Q4_K_M',
    sha256, sizeBytes: size, ggufPath, contextTokens: 32768, nodeId: 'node-1', pinnedBy: 'admin',
  }));
  assert.equal(pinned.model.sha256, sha256);
  assert.equal(pinned.pin.nodeId, 'node-1');
  assert.equal(pinned.summary.pinCount, 1);
  // Verify hash thật -> verified.
  const verified = JSON.parse(await runTool(tools, 'fleet_model_verify_v12', { nodeId: 'node-1' }));
  assert.equal(verified.status, 'verified');
  assert.equal(verified.actualSha256, sha256);
  // Sửa file (giữ nguyên kích thước để qua size check) -> tampered.
  fs.writeFileSync(ggufPath, 'fake-gguf-bytes-v12-tooX!');
  const tampered = JSON.parse(await runTool(tools, 'fleet_model_verify_v12', { nodeId: 'node-1' }));
  assert.equal(tampered.status, 'tampered');
  // List pins: node drift.
  const pins = JSON.parse(await runTool(tools, 'fleet_model_pins_v12', {}));
  assert.equal(pins.summary.driftCount, 1);
  assert.equal(pins.pins[0].status, 'drift');
  // Rollout create.
  const created = JSON.parse(await runTool(tools, 'fleet_rollout_create_v12', {
    name: 'Model qwen3-4b', feature: 'local-model-qwen3-4b', version: '2.4.0',
    previousVersion: '2.3.1', allNodeIds: ['node-1', 'node-2', 'node-3', 'node-4'], createdBy: 'admin',
  }));
  assert.equal(created.rollout.stage, 'draft');
  assert.equal(created.rollout.cohorts.length, 4);
  assert.equal(created.progress.total, 4);
  const rolloutId = created.rollout.id;
  // Start -> canary.
  const started = JSON.parse(await runTool(tools, 'fleet_rollout_action_v12', {
    rolloutId, action: 'start', actorUserId: 'admin', reason: 'bắt đầu canary',
  }));
  assert.equal(started.ok, true);
  assert.equal(started.rollout.stage, 'canary');
  // Advance khi cohort chưa done -> gate chặn.
  const blocked = JSON.parse(await runTool(tools, 'fleet_rollout_action_v12', {
    rolloutId, action: 'advance', actorUserId: 'admin', reason: 'mở rộng',
    healthyNodeIds: ['node-1', 'node-2', 'node-3', 'node-4'],
  }));
  assert.equal(blocked.ok, false);
  assert.equal(blocked.gate.allowed, false);
  // Ghi tiến độ cohort canary xong (applied=1, error=0) rồi advance -> expanding (25%).
  const advanced = JSON.parse(await runTool(tools, 'fleet_rollout_action_v12', {
    rolloutId, action: 'advance', actorUserId: 'admin', reason: 'mở rộng 25%',
    appliedCount: 1, errorCount: 0,
    healthyNodeIds: ['node-1', 'node-2', 'node-3', 'node-4'],
  }));
  assert.equal(advanced.ok, true);
  assert.equal(advanced.rollout.stage, 'expanding');
  assert.equal(advanced.rollout.activeCohortIndex, 1);
  assert.equal(advanced.autoAction.action, 'none');
  // Status liệt kê rollout.
  const status = JSON.parse(await runTool(tools, 'fleet_rollout_status_v12', {}));
  assert.equal(status.length, 1);
  assert.equal(status[0].rollout.id, rolloutId);
  const one = JSON.parse(await runTool(tools, 'fleet_rollout_status_v12', { rolloutId }));
  assert.equal(one.rollout.id, rolloutId);
  assert.match(await runTool(tools, 'fleet_rollout_status_v12', { rolloutId: 'khong-co' }), /^Error:/);
});

test('arg validation tra Error string, khong throw; OS-provided bi tu choi o tool pin', async () => {
  const base = tmpDir();
  const tools = createFleetV12Tools(() => base);
  assert.match(await runTool(tools, 'fleet_model_pin_v12', {
    modelId: 'qwen3-4b-q4_k_m', publisher: 'Qwen', license: 'Apache-2.0',
    sha256: 'xyz', ggufPath: '/x/y.gguf', pinnedBy: 'admin',
  }), /^Error:/);
  assert.match(await runTool(tools, 'fleet_model_verify_v12', { nodeId: 'node-chua-pin' }), /^Error:/);
  assert.match(await runTool(tools, 'fleet_rollout_action_v12', {
    rolloutId: 'khong-co', action: 'start', actorUserId: 'admin', reason: 'x',
  }), /^Error:/);
  assert.match(await runTool(tools, 'fleet_rollout_action_v12', {
    rolloutId: 'khong-co', action: 'bay', actorUserId: 'admin', reason: 'x',
  }), /^Error:/);
  const osModel = await runTool(tools, 'fleet_model_pin_v12', {
    modelId: 'phi-silica-q4', publisher: 'Microsoft', license: 'MS', sha256: 'a'.repeat(64),
    ggufPath: '/x/y.gguf', pinnedBy: 'admin',
  });
  assert.match(osModel, /^Error:/);
  assert.match(osModel, /OS-provided/);
});

test('unbound file tools: tra NOT_WIRED thay vi crash', async () => {
  const tools = createFleetV12Tools();
  for (const [name, args] of [
    ['fleet_model_pin_v12', { modelId: 'qwen3-4b-q4_k_m', publisher: 'Qwen', license: 'Apache-2.0', sha256: 'a'.repeat(64), ggufPath: '/x/y.gguf', pinnedBy: 'admin' }],
    ['fleet_model_verify_v12', { nodeId: 'node-1' }],
    ['fleet_model_pins_v12', {}],
    ['fleet_rollout_create_v12', { name: 'X', feature: 'f', version: '1', previousVersion: '0', allNodeIds: ['n1'], createdBy: 'u' }],
    ['fleet_rollout_status_v12', {}],
  ]) {
    const out = await runTool(tools, name, args);
    assert.match(out, /^Error:/, `${name} unbound phải trả Error`);
    assert.match(out, /not wired/);
  }
  // Pure tools vẫn chạy khi chưa bind.
  const dash = JSON.parse(await runTool(tools, 'fleet_health_dashboard_v12', { nodes: nodeSamples(), now: T0 }));
  assert.equal(dash.dashboard.nodeCount, 2);
});

test('i18n: 91 key fleetV12 du 6 locale, khong rong, tong 5495', () => {
  const expected = [
    'fleetV12.title', 'fleetV12.subtitle', 'fleetV12.refresh', 'fleetV12.loadError',
    'fleetV12.nodesTitle', 'fleetV12.model', 'fleetV12.modelStatus', 'fleetV12.modelVerified',
    'fleetV12.modelDrift', 'fleetV12.modelUnverified', 'fleetV12.modelNone', 'fleetV12.cpu',
    'fleetV12.ram', 'fleetV12.disk', 'fleetV12.tokensPerSec', 'fleetV12.pendingRequests',
    'fleetV12.alertsTitle', 'fleetV12.noAlerts', 'fleetV12.acknowledge', 'fleetV12.acknowledged',
    'fleetV12.rulesTitle', 'fleetV12.historyTitle', 'fleetV12.worstNodes',
    'fleetV12.statusHealthy', 'fleetV12.statusDegraded', 'fleetV12.statusUnhealthy', 'fleetV12.statusDown',
    'fleetV12.trendRising', 'fleetV12.trendFalling', 'fleetV12.trendStable', 'fleetV12.trendUnknown',
    'fleetV12.driftNodes', 'fleetV12.downNodes',
    'fleetV12.pinsTitle', 'fleetV12.pinsEmpty', 'fleetV12.pinModel', 'fleetV12.pinNode', 'fleetV12.pinHash',
    'fleetV12.rolloutTitle', 'fleetV12.rolloutEmpty', 'fleetV12.rolloutStage', 'fleetV12.rolloutAdvance',
    'fleetV12.rolloutPause', 'fleetV12.rolloutResume', 'fleetV12.rolloutRollback', 'fleetV12.rolloutComplete',
    'fleetV12.rolloutGateBlocked', 'fleetV12.rolloutAutoAction',
    'fleetV12.stageDraft', 'fleetV12.stageCanary', 'fleetV12.stageExpanding', 'fleetV12.stagePaused',
    'fleetV12.stageComplete', 'fleetV12.stageRolledBack',
    'fleetV12.aguiTitle', 'fleetV12.aguiRuns', 'fleetV12.aguiNoRuns', 'fleetV12.aguiInterrupts',
    'fleetV12.aguiNoInterrupts', 'fleetV12.aguiApprove', 'fleetV12.aguiReject', 'fleetV12.aguiSurfaces',
    'fleetV12.aguiTimeline', 'fleetV12.aguiRunning', 'fleetV12.aguiWaiting', 'fleetV12.aguiCompleted',
    'fleetV12.aguiFailed', 'fleetV12.aguiStopped', 'fleetV12.aguiCancelled',
    'fleetV12.memoryTitle', 'fleetV12.memoryFacts', 'fleetV12.memoryNoFacts', 'fleetV12.memoryQuarantine',
    'fleetV12.memoryRestore', 'fleetV12.memoryDelete', 'fleetV12.memoryKg', 'fleetV12.memoryErasure',
    'fleetV12.memoryErasureConfirm',
    'fleetV12.routerTitle', 'fleetV12.routerModels', 'fleetV12.routerNoModels', 'fleetV12.routerRam',
    'fleetV12.routerDecisions', 'fleetV12.routerSpend', 'fleetV12.routerBudget',
    'fleetV12.routerBudgetWarning', 'fleetV12.routerOverBudget',
    'fleetV12.showHealth', 'fleetV12.hideHealth', 'fleetV12.showPanels', 'fleetV12.hidePanels',
  ];
  assert.equal(expected.length, 91);
  for (const loc of ['vi', 'en', 'zh', 'ja', 'es', 'fr']) {
    const dict = JSON.parse(
      fs.readFileSync(path.join('apps', 'desktop', 'src', 'renderer', 'i18n', 'locales', `${loc}.json`), 'utf8'),
    );
    assert.equal(Object.keys(dict).length, 7540, `${loc} phải có 7540 key`); // v1.36 re-pin: 7540.
    for (const key of expected) {
      assert.ok(key in dict, `key ${key} thiếu trong ${loc}`);
      assert.equal(typeof dict[key], 'string');
      assert.ok(dict[key].length > 0, `key ${key} rỗng trong ${loc}`);
    }
  }
});

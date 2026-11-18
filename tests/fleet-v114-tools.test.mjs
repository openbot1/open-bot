/**
 * Fleet v11 tools tests (v1.14, Đội T6 — node:test, no network).
 *
 * Covers:
 * - 9 tool v11: đủ tên, không trùng, có trong ALL_TOOLS (462 = 453 + 9),
 *   binding giữ nguyên số lượng, approval flags đúng.
 * - Pure tools chạy được khi chưa bind (health snapshot, 3 panel tools).
 * - Bound tools end-to-end trên tmp userData dir: rollout create ->
 *   action (start -> advance bị gate chặn -> advance sau khi nhóm done)
 *   -> status; health evaluate -> ack; arg validation trả Error string,
 *   không throw.
 * - Unbound file tools trả NOT_WIRED (Error) thay vì crash.
 * - i18n: 133 key v11 (fleetV11 52 + memoryPanelV11 26 + voicePanelV11 26
 *   + mcpAppsPanelV11 28 + memory.tabV11Panel 1) có đủ 6 locale, không
 *   rỗng, placeholder khớp nhau; tổng mỗi locale = 5116.
 *
 * Imports the BUILT core + tools — build first:
 *   npm run build --workspace=@open-bot/core
 *   npm run build --workspace=@open-bot/tools
 * then: node --test tests/fleet-v114-tools.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  FLEET_V11_TOOL_NAMES,
  FLEET_V11_TOOLS,
  createFleetV11Tools,
  isFleetV11ToolName,
} from '../packages/tools/dist/fleetV11Tools.js';
import { ALL_TOOLS, createDefaultTools } from '../packages/tools/dist/tools.js';

const T0 = Date.UTC(2026, 10, 16, 0, 0, 0);

function tmpDir(prefix = 'open-bot-fleet-v11-tools-') {
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
    { nodeId: 'node-1', cpuPct: 40, ramPct: 50, diskPct: 60, uptimeMs: 3600_000, lastHeartbeatAt: T0, botCount: 1, botCapacity: 4 },
    { nodeId: 'node-2', cpuPct: 90, ramPct: 96, diskPct: 70, uptimeMs: 3600_000, lastHeartbeatAt: T0, botCount: 0, botCapacity: 2 },
  ];
}

function botSamples() {
  return [
    { botId: 'bot-1', nodeId: 'node-1', cpuPct: 20, ramPct: 30, lastHeartbeatAt: T0, uptimeMs: 1000, consecutiveFailures: 0, recentRestarts: 0, running: true },
  ];
}

test('tools: đủ 9 tool v11, không trùng tên, có trong ALL_TOOLS (453 + 38 = 491)', () => {
  assert.equal(FLEET_V11_TOOL_NAMES.length, 9);
  assert.equal(new Set(FLEET_V11_TOOL_NAMES).size, 9);
  assert.equal(FLEET_V11_TOOLS.length, 9);
  assert.equal(isFleetV11ToolName('fleet_health_snapshot_v11'), true);
  assert.equal(isFleetV11ToolName('fleet_rollout_create_v11'), true);
  assert.equal(isFleetV11ToolName('fleet_health_snapshot_v10'), false);
  for (const name of FLEET_V11_TOOL_NAMES) {
    assert.ok(ALL_TOOLS.some((t) => t.definition.name === name), `ALL_TOOLS thiếu ${name}`);
  }
  assert.equal(ALL_TOOLS.length, 899, 'v1.14 merge: 453 + 38 = 500'); // v1.36 re-pin: 825 + 74 = 899.
  assert.equal(new Set(ALL_TOOLS.map((t) => t.definition.name)).size, ALL_TOOLS.length);
  const dir = tmpDir();
  const bound = createDefaultTools({ getFleetV11BaseDir: () => dir });
  assert.equal(bound.length, ALL_TOOLS.length, 'binding giữ nguyên số lượng');
  for (const name of FLEET_V11_TOOL_NAMES) {
    assert.equal(bound.filter((t) => t.definition.name === name).length, 1, `${name} bị trùng sau binding`);
  }
  // Approval flags: tool ghi file cần approval, tool chỉ đọc/pure thì không.
  const needsApproval = Object.fromEntries(
    FLEET_V11_TOOLS.map((t) => [t.definition.name, t.needsApproval]),
  );
  assert.equal(needsApproval['fleet_rollout_create_v11'], true);
  assert.equal(needsApproval['fleet_rollout_action_v11'], true);
  assert.equal(needsApproval['fleet_health_snapshot_v11'], false);
  assert.equal(needsApproval['fleet_health_evaluate_v11'], false);
  assert.equal(needsApproval['fleet_panel_memory_v11'], false);
});

test('health snapshot (pure): chạy được khi chưa bind, đếm đúng', async () => {
  const tools = createFleetV11Tools();
  const out = await runTool(tools, 'fleet_health_snapshot_v11', {
    nodes: nodeSamples(),
    bots: botSamples(),
    now: T0,
  });
  const snap = JSON.parse(out);
  assert.equal(snap.nodes.total, 2);
  assert.equal(snap.nodes.unhealthy, 1, 'node-2 RAM 96% -> unhealthy');
  assert.equal(snap.bots.healthy, 1);
  assert.ok(snap.alerts.total >= 1);
  assert.match(snap.summary, /nghiêm trọng|chú ý/);
  const empty = JSON.parse(await runTool(tools, 'fleet_health_snapshot_v11', { now: T0 }));
  assert.equal(empty.nodes.total, 0);
  assert.match(empty.summary, /khỏe/);
});

test('health evaluate + ack (bound): alert critical ghi incident, ack lưu bền', async () => {
  const dir = tmpDir();
  const tools = createFleetV11Tools(() => dir);
  const evaluated = JSON.parse(
    await runTool(tools, 'fleet_health_evaluate_v11', {
      nodes: nodeSamples(),
      bots: botSamples(),
      now: T0,
    }),
  );
  assert.ok(evaluated.alerts.length >= 1);
  const crit = evaluated.alerts.find((a) => a.level === 'critical');
  assert.ok(crit, 'node-2 RAM 96% phải sinh alert critical');
  // Incident đã ghi cho alert critical mới.
  const incidentsPath = path.join(dir, 'fleet', 'fleet-incidents-v114.jsonl');
  assert.ok(fs.existsSync(incidentsPath), 'incident log được tạo');
  const incidents = fs.readFileSync(incidentsPath, 'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(incidents.some((i) => i.level === 'critical'));

  // Ack alert: cần truyền previousAlerts (danh sách đang mở).
  const acked = JSON.parse(
    await runTool(tools, 'fleet_health_ack_v11', {
      alertId: crit.id,
      actorUserId: 'admin',
      previousAlerts: evaluated.alerts,
      now: T0 + 1000,
    }),
  );
  assert.equal(acked.acknowledged, true);
  assert.equal(acked.acknowledgedBy, 'admin');
  // State file lưu ack bền.
  const state = JSON.parse(fs.readFileSync(path.join(dir, 'fleet', 'fleet-health-v114.json'), 'utf8'));
  assert.equal(state.acknowledgedAlerts[crit.id].by, 'admin');

  // Ack id không tồn tại -> Error, không throw.
  const bad = await runTool(tools, 'fleet_health_ack_v11', {
    alertId: 'node:nope:cpu',
    actorUserId: 'admin',
    previousAlerts: evaluated.alerts,
  });
  assert.match(bad, /^Error:/);
});

test('rollout bound end-to-end: create -> start -> advance bị gate chặn -> done -> advance -> status', async () => {
  const dir = tmpDir();
  const tools = createFleetV11Tools(() => dir);
  const created = JSON.parse(
    await runTool(tools, 'fleet_rollout_create_v11', {
      name: 'Voice v12',
      description: 'Triển khai voice v12.',
      targetKind: 'node',
      feature: 'voice-v12-realtime',
      version: '2.4.0',
      previousVersion: '2.3.1',
      groups: [
        { name: 'canary', targets: ['node-1'] },
        { name: 'pilot', targets: ['node-2', 'node-3'] },
        { name: 'all', targets: ['node-4'] },
      ],
      createdBy: 'admin',
      now: T0,
    }),
  );
  assert.equal(created.stage, 'draft');
  const id = created.id;

  const started = JSON.parse(
    await runTool(tools, 'fleet_rollout_action_v11', {
      rolloutId: id, action: 'start', actorUserId: 'admin', reason: 'bắt đầu', now: T0 + 1000,
    }),
  );
  assert.equal(started.rollout.stage, 'canary');

  // Advance khi nhóm canary chưa done -> gate chặn, Error rõ ràng.
  const blocked = await runTool(tools, 'fleet_rollout_action_v11', {
    rolloutId: id, action: 'advance', actorUserId: 'admin', reason: 'mở pilot',
    healthyTargetIds: ['node-2', 'node-3'], now: T0 + 2000,
  });
  assert.match(blocked, /^Error:/);
  assert.match(blocked, /gate chặn/);

  // Tool không có API "đánh done nhóm" riêng: dùng file trực tiếp để
  // mô phỏng host đã áp dụng xong nhóm canary (core API đã test riêng).
  const rolloutsPath = path.join(dir, 'fleet', 'fleet-rollouts-v114.json');
  const stored = JSON.parse(fs.readFileSync(rolloutsPath, 'utf8'));
  stored[0].groups[0].status = 'done';
  stored[0].groups[0].appliedCount = 1;
  fs.writeFileSync(rolloutsPath, JSON.stringify(stored, null, 2));

  const advanced = JSON.parse(
    await runTool(tools, 'fleet_rollout_action_v11', {
      rolloutId: id, action: 'advance', actorUserId: 'admin', reason: 'mở pilot',
      healthyTargetIds: ['node-2', 'node-3'], now: T0 + 3000,
    }),
  );
  assert.equal(advanced.rollout.stage, 'expanding');
  assert.equal(advanced.progress.activeGroupName, 'pilot');

  const status = JSON.parse(
    await runTool(tools, 'fleet_rollout_status_v11', { rolloutId: id, now: T0 + 4000 }),
  );
  assert.equal(status.length, 1);
  assert.equal(status[0].progress.total, 4);
  assert.equal(status[0].autoRollback.shouldRollback, false);

  // Rollback từ expanding.
  const rolled = JSON.parse(
    await runTool(tools, 'fleet_rollout_action_v11', {
      rolloutId: id, action: 'rollback', actorUserId: 'admin', reason: 'lỗi pilot', now: T0 + 5000,
    }),
  );
  assert.equal(rolled.rollout.stage, 'rolled-back');

  // Rollout id không tồn tại -> Error.
  const missing = await runTool(tools, 'fleet_rollout_action_v11', {
    rolloutId: 'ro-nope', action: 'start', actorUserId: 'admin', reason: 'x',
  });
  assert.match(missing, /^Error:/);
  // Create thiếu nhóm -> Error (validate ở core).
  const badCreate = await runTool(tools, 'fleet_rollout_create_v11', {
    name: 'X', targetKind: 'node', feature: 'f', version: '1', previousVersion: '0',
    groups: [], createdBy: 'admin',
  });
  assert.match(badCreate, /^Error:/);
});

test('panel tools (pure): memory / voice / mcp apps chạy được khi chưa bind', async () => {
  const tools = createFleetV11Tools();
  const mem = JSON.parse(
    await runTool(tools, 'fleet_panel_memory_v11', {
      blocks: [
        { id: 'b1', label: 'human', description: 'Về user.', content: 'Tên Huy.', charLimit: 2000, readOnly: false, systemOwned: true, createdByBotId: '', version: 3, createdAt: '2026-11-16T00:00:00.000Z', updatedAt: '2026-11-16T00:00:00.000Z' },
        { id: 'b2', label: 'food', description: 'Ăn uống.', content: 'Phở.', charLimit: 2000, readOnly: false, systemOwned: false, createdByBotId: '', version: 1, createdAt: '2026-11-16T00:00:00.000Z', updatedAt: '2026-11-16T00:00:00.000Z' },
      ],
      history: { b1: [{ blockId: 'b1', label: 'human', version: 1, content: 'Tên Huy.', description: 'Về user.', charLimit: 2000, readOnly: false, action: 'create', actor: 'user', at: '2026-11-16T00:00:00.000Z' }] },
      actor: 'user',
    }),
  );
  assert.equal(mem.totalBlocks, 2);
  assert.equal(mem.systemBlocks, 1);
  assert.equal(mem.rows[0].block.label, 'human');

  const voice = JSON.parse(
    await runTool(tools, 'fleet_panel_voice_v11', {
      wakeWord: 'hey bot',
      bargeIn: { enabled: true, threshold: 0.5, minSpeechMs: 300 },
      providersWithKey: ['gemini'],
      selectedProviderId: 'gemini',
    }),
  );
  assert.equal(voice.sessionId, null);
  assert.deepEqual(voice.wakeWordErrors, []);
  assert.equal(voice.selectedProviderId, 'gemini');

  const badVoice = JSON.parse(
    await runTool(tools, 'fleet_panel_voice_v11', { wakeWord: 'x!' }),
  );
  assert.ok(badVoice.wakeWordErrors.length > 0);

  const mcp = JSON.parse(
    await runTool(tools, 'fleet_panel_mcp_apps_v11', { query: 'kanban' }),
  );
  assert.equal(mcp.shownApps, 1);
  assert.equal(mcp.rows[0].app.id, 'kanban-board');
  assert.ok(Array.isArray(mcp.rows[0].permissionReviews));
  assert.ok(mcp.rows[0].csp.sandboxDirectives.length > 0);
});

test('unbound file tools: trả NOT_WIRED thay vì crash', async () => {
  const tools = createFleetV11Tools();
  for (const [name, args] of [
    ['fleet_health_evaluate_v11', { nodes: [], bots: [] }],
    ['fleet_health_ack_v11', { alertId: 'x', actorUserId: 'u', previousAlerts: [] }],
    ['fleet_rollout_create_v11', { name: 'X', targetKind: 'node', feature: 'f', version: '1', previousVersion: '0', groups: [{ name: 'a', targets: ['n1'] }], createdBy: 'u' }],
    ['fleet_rollout_status_v11', {}],
  ]) {
    const out = await runTool(tools, name, args);
    assert.match(out, /^Error:/, `${name} unbound phải trả Error`);
    assert.match(out, /not wired/);
  }
});

test('i18n: 133 key v11 đủ 6 locale, không rỗng, placeholder khớp, tổng 5278', () => {
  const expected = [
    'fleetV11.title', 'fleetV11.subtitle', 'fleetV11.refresh', 'fleetV11.loadError',
    'fleetV11.nodesTitle', 'fleetV11.botsTitle', 'fleetV11.alertsTitle', 'fleetV11.noAlerts',
    'fleetV11.statusHealthy', 'fleetV11.statusDegraded', 'fleetV11.statusUnhealthy', 'fleetV11.statusDown',
    'fleetV11.cpu', 'fleetV11.ram', 'fleetV11.disk', 'fleetV11.uptime', 'fleetV11.lastHeartbeat',
    'fleetV11.stale', 'fleetV11.threshold', 'fleetV11.acknowledge', 'fleetV11.acknowledged',
    'fleetV11.summaryHealthy', 'fleetV11.summaryIssues', 'fleetV11.showHealth', 'fleetV11.hideHealth',
    'fleetV11.showRollout', 'fleetV11.hideRollout', 'fleetV11.rolloutTitle', 'fleetV11.rolloutSubtitle',
    'fleetV11.rolloutCreate', 'fleetV11.rolloutName', 'fleetV11.rolloutVersion', 'fleetV11.rolloutStage',
    'fleetV11.stageDraft', 'fleetV11.stageCanary', 'fleetV11.stageExpanding', 'fleetV11.stagePaused',
    'fleetV11.stageComplete', 'fleetV11.stageRolledBack', 'fleetV11.rolloutAdvance', 'fleetV11.rolloutRollback',
    'fleetV11.rolloutPause', 'fleetV11.rolloutResume', 'fleetV11.rolloutGroup', 'fleetV11.rolloutGroups',
    'fleetV11.rolloutProgress', 'fleetV11.rolloutErrorRate', 'fleetV11.rolloutGateBlocked',
    'fleetV11.rolloutNoRollouts', 'fleetV11.rolloutConfirmRollback', 'fleetV11.rolloutDone', 'fleetV11.rolloutEmpty',
    'memoryPanelV11.title', 'memoryPanelV11.subtitle', 'memoryPanelV11.searchPlaceholder',
    'memoryPanelV11.filterAll', 'memoryPanelV11.filterSystem', 'memoryPanelV11.filterUser',
    'memoryPanelV11.filterReadOnly', 'memoryPanelV11.blocks', 'memoryPanelV11.noBlocks',
    'memoryPanelV11.version', 'memoryPanelV11.history', 'memoryPanelV11.historyEmpty',
    'memoryPanelV11.rollback', 'memoryPanelV11.rollbackConfirm', 'memoryPanelV11.rollbackDone',
    'memoryPanelV11.aclTitle', 'memoryPanelV11.aclAllowed', 'memoryPanelV11.aclDenied',
    'memoryPanelV11.readOnly', 'memoryPanelV11.systemOwned', 'memoryPanelV11.createdBy',
    'memoryPanelV11.updatedAt', 'memoryPanelV11.selectBlock', 'memoryPanelV11.restoreVersion',
    'memoryPanelV11.overLimit', 'memoryPanelV11.content',
    'voicePanelV11.title', 'voicePanelV11.subtitle', 'voicePanelV11.latencyTitle', 'voicePanelV11.noData',
    'voicePanelV11.p50', 'voicePanelV11.p95', 'voicePanelV11.p99', 'voicePanelV11.slowestStage',
    'voicePanelV11.turns', 'voicePanelV11.mode', 'voicePanelV11.modeBalanced', 'voicePanelV11.modeLowLatency',
    'voicePanelV11.bargeIn', 'voicePanelV11.bargeInOn', 'voicePanelV11.bargeInOff', 'voicePanelV11.wakeWord',
    'voicePanelV11.wakeWordPlaceholder', 'voicePanelV11.wakeWordInvalid', 'voicePanelV11.provider',
    'voicePanelV11.providerPick', 'voicePanelV11.providerNone', 'voicePanelV11.jitterBuffer',
    'voicePanelV11.endToEnd', 'voicePanelV11.save', 'voicePanelV11.saved', 'voicePanelV11.threshold',
    'mcpAppsPanelV11.title', 'mcpAppsPanelV11.subtitle', 'mcpAppsPanelV11.searchPlaceholder',
    'mcpAppsPanelV11.gallery', 'mcpAppsPanelV11.templates', 'mcpAppsPanelV11.templateBlank',
    'mcpAppsPanelV11.templateNote', 'mcpAppsPanelV11.templateDashboard', 'mcpAppsPanelV11.permissions',
    'mcpAppsPanelV11.permissionReadFiles', 'mcpAppsPanelV11.permissionWriteFiles',
    'mcpAppsPanelV11.permissionNetwork', 'mcpAppsPanelV11.permissionClipboard',
    'mcpAppsPanelV11.permissionNotifications', 'mcpAppsPanelV11.cspTitle', 'mcpAppsPanelV11.cspSandbox',
    'mcpAppsPanelV11.cspNetwork', 'mcpAppsPanelV11.compatible', 'mcpAppsPanelV11.incompatible',
    'mcpAppsPanelV11.install', 'mcpAppsPanelV11.installed', 'mcpAppsPanelV11.enable',
    'mcpAppsPanelV11.disable', 'mcpAppsPanelV11.category', 'mcpAppsPanelV11.allCategories',
    'mcpAppsPanelV11.noApps', 'mcpAppsPanelV11.needsNetwork', 'mcpAppsPanelV11.needsScripts',
    'memory.tabV11Panel',
  ];
  assert.equal(expected.length, 133);
  for (const loc of ['vi', 'en', 'zh', 'ja', 'es', 'fr']) {
    const dict = JSON.parse(
      fs.readFileSync(path.join('apps', 'desktop', 'src', 'renderer', 'i18n', 'locales', `${loc}.json`), 'utf8'),
    );
    assert.equal(Object.keys(dict).length, 7540, `${loc} phải có 7540 key`); // v1.36 re-pin: 7540. + 91 key fleetV12.
    for (const key of expected) {
      assert.ok(key in dict, `key ${key} thiếu trong ${loc}`);
      assert.equal(typeof dict[key], 'string');
      assert.ok(dict[key].length > 0, `key ${key} rỗng trong ${loc}`);
    }
  }
  // Placeholder {count}/{reason}/{version} phải khớp nhau giữa các locale.
  const vi = JSON.parse(fs.readFileSync(path.join('apps', 'desktop', 'src', 'renderer', 'i18n', 'locales', 'vi.json'), 'utf8'));
  const en = JSON.parse(fs.readFileSync(path.join('apps', 'desktop', 'src', 'renderer', 'i18n', 'locales', 'en.json'), 'utf8'));
  const placeholders = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
  for (const key of expected) {
    assert.equal(placeholders(en[key]), placeholders(vi[key]), `placeholder lệch ở ${key}`);
  }
});

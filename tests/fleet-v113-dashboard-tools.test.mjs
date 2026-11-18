/**
 * Fleet v10 dashboard + tools tests (v1.13, Doi T6 — node:test, no network).
 *
 * Covers:
 * - Control state machine: start/stop/pause/resume transitions,
 *   invalid transitions rejected with a reason, error recovery
 *   (start from error restarts + clears lastError), stop clears
 *   startedAt/currentTask/queueDepth
 * - Heartbeat + error marking (validation included)
 * - Dashboard (pure): counts by status, per-user rows, resource
 *   percents, alerts (stale heartbeat, agent error, long queue wait,
 *   high CPU/RAM/disk), summary line
 * - Log tail: last N lines, missing file = empty, maxBytes cap,
 *   startByte for polling
 * - Runtime persistence round-trip
 * - Tools (11, NOT in ALL_TOOLS): names unique, pure tools work
 *   unbound (evaluate / quota-check / dashboard snapshot), file
 *   tools answer NOT_WIRED unbound, bound end-to-end flow on a tmp
 *   userData dir (trigger create -> list, schedule create -> tick,
 *   user create -> quota check, agent control start -> pause ->
 *   resume -> stop, log tail inside fleet only), arg validation
 *   returns Error strings never throws, approval flags
 *
 * Imports the BUILT core + tools — build first:
 *   npm run build --workspace=@open-bot/core
 *   npm run build --workspace=@open-bot/tools
 * then: node --test tests/fleet-v113-dashboard-tools.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  FLEET_V10_TOOL_NAMES,
  FLEET_V10_TOOLS,
  createFleetV10Tools,
  isFleetV10ToolName,
} from '../packages/tools/dist/fleetV10Tools.js';
import {
  applyFleetV10ControlAction,
  buildFleetV10Dashboard,
  createFleetV10AgentRuntimeState,
  createFleetV10Schedule,
  createFleetV10Trigger,
  createFleetV10User,
  heartbeatFleetV10Agent,
  loadFleetV10AgentRuntimeStates,
  markFleetV10AgentError,
  readFleetV10LogTail,
  saveFleetV10AgentRuntimeStates,
  summarizeFleetV10Dashboard,
} from '../packages/core/dist/index.js';

const T0 = Date.UTC(2026, 10, 15, 0, 0, 0);
const GB = 1024 ** 3;

function makeAgent(overrides = {}) {
  return {
    ...createFleetV10AgentRuntimeState('bot-1', 'Bot One', 'alice'),
    ...overrides,
  };
}

function toolByName(tools, name) {
  const t = tools.find((x) => x.definition.name === name);
  assert.ok(t, `tool missing: ${name}`);
  return t;
}

async function runTool(tools, name, args) {
  return toolByName(tools, name).execute(args, { workspaceDir: os.tmpdir(), botId: 'test-bot' });
}

test('control state machine: chuyen doi hop le, tu choi chuyen doi sai', () => {
  const now = T0;
  let s = makeAgent();
  // pause khi stopped -> loi, trang thai khong doi.
  let r = applyFleetV10ControlAction(s, 'pause', 'admin1', 'test', now);
  assert.equal(r.ok, false);
  assert.match(r.error, /cannot pause agent bot-1 while stopped/);
  assert.equal(r.state.status, 'stopped');
  // start -> running, ghi event.
  r = applyFleetV10ControlAction(s, 'start', 'admin1', 'go', now);
  assert.equal(r.ok, true);
  assert.equal(r.state.status, 'running');
  assert.equal(r.state.startedAt, now);
  assert.deepEqual(r.event, {
    agentId: 'bot-1', action: 'start', fromStatus: 'stopped', toStatus: 'running',
    actorUserId: 'admin1', reason: 'go', at: now,
  });
  s = r.state;
  // start lai khi running -> loi.
  assert.equal(applyFleetV10ControlAction(s, 'start', 'admin1', 'x', now).ok, false);
  // pause -> resume -> stop.
  r = applyFleetV10ControlAction(s, 'pause', 'admin1', 'hold', now + 1000);
  assert.equal(r.state.status, 'paused');
  assert.equal(r.state.startedAt, now); // pause giu startedAt
  s = r.state;
  r = applyFleetV10ControlAction(s, 'resume', 'admin1', 'back', now + 2000);
  assert.equal(r.state.status, 'running');
  s = r.state;
  r = applyFleetV10ControlAction(s, 'stop', 'admin1', 'done', now + 3000);
  assert.equal(r.state.status, 'stopped');
  assert.equal(r.state.startedAt, null);
  assert.equal(r.state.queueDepth, 0);
  // resume khi stopped -> loi; action khong biet -> loi.
  assert.equal(applyFleetV10ControlAction(r.state, 'resume', 'admin1', 'x', now).ok, false);
  assert.equal(applyFleetV10ControlAction(r.state, 'explode', 'admin1', 'x', now).ok, false);
  assert.equal(applyFleetV10ControlAction(r.state, 'start', '', 'x', now).ok, false);
});

test('error + heartbeat: loi chuyen sang error, start tu error tang restarts', () => {
  const now = T0;
  let s = applyFleetV10ControlAction(makeAgent(), 'start', 'admin1', 'go', now).state;
  s = markFleetV10AgentError(s, 'crashed', now + 1000);
  assert.equal(s.status, 'error');
  assert.equal(s.lastError, 'crashed');
  assert.throws(() => markFleetV10AgentError(s, ''), /non-empty message/);
  const r = applyFleetV10ControlAction(s, 'start', 'admin1', 'retry', now + 2000);
  assert.equal(r.ok, true);
  assert.equal(r.state.restarts, 1);
  assert.equal(r.state.lastError, undefined);
  // stop tu error cung duoc.
  const stopped = applyFleetV10ControlAction(markFleetV10AgentError(r.state, 'again', now + 3000), 'stop', 'admin1', 'give up', now + 4000);
  assert.equal(stopped.state.status, 'stopped');
  // Heartbeat cap nhat muc su dung, khong doi trang thai.
  const hb = heartbeatFleetV10Agent(r.state, { cpuCores: 1.5, ramBytes: 2 * GB, queueDepth: 3, currentTask: 'summarize' }, now + 5000);
  assert.equal(hb.status, 'running');
  assert.equal(hb.cpuCores, 1.5);
  assert.equal(hb.currentTask, 'summarize');
  assert.throws(() => heartbeatFleetV10Agent(r.state, { cpuCores: -1, ramBytes: 0, queueDepth: 0 }), /cpuCores/);
});

test('dashboard: dem theo trang thai, hang theo user, %, canh bao', () => {
  const now = T0;
  const agents = [
    { ...makeAgent(), status: 'running', lastHeartbeatAt: now - 1000, cpuCores: 1, ramBytes: 1 * GB, queueDepth: 2 },
    { ...makeAgent({ agentId: 'bot-2', name: 'Bot Two', ownerUserId: 'bob' }), status: 'running', lastHeartbeatAt: now - 10 * 60 * 1000, cpuCores: 0.5, ramBytes: 512 * 1024 * 1024, queueDepth: 0 },
    { ...makeAgent({ agentId: 'bot-3', name: 'Bot Three' }), status: 'paused' },
    { ...makeAgent({ agentId: 'bot-4', name: 'Bot Four' }), status: 'error', lastError: 'OOM' },
  ];
  const snap = buildFleetV10Dashboard(
    {
      agents,
      queue: { waiting: 5, running: 2, doneLast24h: 40, failedLast24h: 1, oldestWaitingAt: now - 20 * 60 * 1000 },
      resources: { cpuCoresTotal: 4, cpuCoresUsed: 3.6, ramBytesTotal: 16 * GB, ramBytesUsed: 4 * GB, diskBytesTotal: 500 * GB, diskBytesUsed: 100 * GB },
    },
    now,
  );
  assert.equal(snap.agentsTotal, 4);
  assert.equal(snap.agentsRunning, 2);
  assert.equal(snap.agentsPaused, 1);
  assert.equal(snap.agentsError, 1);
  assert.equal(snap.resources.cpuUsedPercent, 90);
  assert.equal(snap.resources.ramUsedPercent, 25);
  assert.equal(snap.users.length, 2);
  assert.equal(snap.users.find((u) => u.userId === 'alice').agents, 3);
  assert.equal(snap.users.find((u) => u.userId === 'bob').runningAgents, 1);
  const kinds = snap.alerts.map((a) => a.kind).sort();
  assert.ok(kinds.includes('stale-heartbeat'), 'stale heartbeat alert');
  assert.ok(kinds.includes('agent-error'), 'agent error alert');
  assert.ok(kinds.includes('queue-waiting'), 'queue wait alert');
  assert.ok(kinds.includes('resource-high'), 'resource alert');
  assert.match(summarizeFleetV10Dashboard(snap), /2\/4 agents running/);
  // Khong canh bao khi moi thu on.
  const calm = buildFleetV10Dashboard(
    {
      agents: [{ ...makeAgent(), status: 'running', lastHeartbeatAt: now - 1000 }],
      queue: { waiting: 0, running: 1, doneLast24h: 5, failedLast24h: 0, oldestWaitingAt: null },
      resources: { cpuCoresTotal: 4, cpuCoresUsed: 1, ramBytesTotal: 16 * GB, ramBytesUsed: 2 * GB, diskBytesTotal: 500 * GB, diskBytesUsed: 50 * GB },
    },
    now,
  );
  assert.equal(calm.alerts.length, 0);
});

test('log tail: N dong cuoi, file khong co = rong, gioi han byte', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-v10-log-'));
  try {
    const logPath = path.join(dir, 'bot-1.log');
    const lines = Array.from({ length: 250 }, (_, i) => `line ${i + 1}`);
    fs.writeFileSync(logPath, `${lines.join('\n')}\n`);
    const tail = readFleetV10LogTail(logPath, 10);
    assert.equal(tail.lines.length, 10);
    assert.equal(tail.lines[0], 'line 241');
    assert.equal(tail.lines[9], 'line 250');
    assert.equal(tail.truncated, true);
    assert.ok(tail.fileSizeBytes > 0);
    assert.ok(tail.startByte >= 0);
    const all = readFleetV10LogTail(logPath, 1000);
    assert.equal(all.lines.length, 250);
    assert.equal(all.truncated, false);
    assert.deepEqual(readFleetV10LogTail(path.join(dir, 'missing.log')).lines, []);
    // Gioi han byte nho: chi doc duoi file.
    const small = readFleetV10LogTail(logPath, 1000, 50);
    assert.ok(small.lines.length < 10);
    assert.throws(() => readFleetV10LogTail(logPath, 0), /maxLines/);
    // Runtime persistence.
    saveFleetV10AgentRuntimeStates(dir, [makeAgent()]);
    assert.equal(loadFleetV10AgentRuntimeStates(dir).length, 1);
    fs.writeFileSync(path.join(dir, 'fleet-agent-runtime-v113.json'), 'broken');
    assert.deepEqual(loadFleetV10AgentRuntimeStates(dir), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('tools registry: 11 tool, ten duy nhat, khong trung ALL_TOOLS o day', () => {
  assert.equal(FLEET_V10_TOOL_NAMES.length, 11);
  assert.equal(new Set(FLEET_V10_TOOL_NAMES).size, 11);
  assert.equal(FLEET_V10_TOOLS.length, 11);
  assert.deepEqual(FLEET_V10_TOOLS.map((t) => t.definition.name), [...FLEET_V10_TOOL_NAMES]);
  for (const name of FLEET_V10_TOOL_NAMES) assert.equal(isFleetV10ToolName(name), true);
  assert.equal(isFleetV10ToolName('fleet_schedule_create_v9'), false);
  const writes = FLEET_V10_TOOLS.filter((t) => t.needsApproval).map((t) => t.definition.name).sort();
  assert.deepEqual(writes, [
    'fleet_agent_control_v10',
    'fleet_schedule_create_v10',
    'fleet_schedule_tick_v10',
    'fleet_trigger_create_v10',
    'fleet_user_create_v10',
  ]);
});

test('tools pure unbound: evaluate / quota-check / dashboard snapshot chay duoc', async () => {
  const tools = createFleetV10Tools();
  const trigger = createFleetV10Trigger(
    { name: 'w', agentId: 'bot-1', ownerUserId: 'alice', eventKind: 'file-changed', condition: { pathGlob: 'notes/**.md' }, debounceMs: 0, throttleMs: 0, maxRunsPerHour: 0 },
    T0,
  );
  const evalOut = JSON.parse(await runTool(tools, 'fleet_trigger_evaluate_v10', {
    event: { id: 'e1', kind: 'file-changed', at: T0, source: 'workspace', filePath: 'notes/a.md' },
    triggers: [trigger],
    now: T0,
  }));
  assert.equal(evalOut.decisions[0].fire, true);
  const quotaOut = JSON.parse(await runTool(tools, 'fleet_user_quota_check_v10', {
    userId: 'alice',
    quota: { userId: 'alice', maxAgents: 1, maxConcurrentRuns: 1, maxTriggers: 1, maxSchedules: 1, cpuCoresMax: 1, ramBytesMax: 1024, diskBytesMax: 1024, maxRunsPerDay: 10, enabled: true, updatedAt: T0, updatedBy: 'admin1' },
    usage: { agents: 2, concurrentRuns: 0, triggers: 0, schedules: 0, cpuCores: 0, ramBytes: 0, diskBytes: 0, runsToday: 0 },
  }));
  assert.equal(quotaOut.check.allowed, false);
  assert.equal(quotaOut.check.violations[0].field, 'agents');
  const snapOut = JSON.parse(await runTool(tools, 'fleet_dashboard_snapshot_v10', {
    agents: [{ agentId: 'bot-1', name: 'B', ownerUserId: 'alice', status: 'running', startedAt: T0, lastHeartbeatAt: T0, cpuCores: 1, ramBytes: 100, queueDepth: 0, restarts: 0 }],
    queue: { waiting: 0, running: 1, doneLast24h: 0, failedLast24h: 0, oldestWaitingAt: null },
    resources: { cpuCoresTotal: 4, cpuCoresUsed: 1, ramBytesTotal: 1000, ramBytesUsed: 100, diskBytesTotal: 1000, diskBytesUsed: 100 },
  }));
  assert.equal(snapOut.agentsRunning, 1);
  // File tools unbound -> NOT_WIRED.
  const wired = await runTool(tools, 'fleet_trigger_list_v10', {});
  assert.match(wired, /not wired/);
  // Arg sai tra ve Error string, khong throw.
  const bad = await runTool(tools, 'fleet_trigger_evaluate_v10', { event: { id: 'e', kind: 'nope', at: 0, source: 'x' } });
  assert.match(bad, /^Error:/);
});

test('tools bound end-to-end: trigger + schedule + user + control + log tail', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-v10-tools-'));
  try {
    const tools = createFleetV10Tools(() => base);
    // User.
    const userOut = JSON.parse(await runTool(tools, 'fleet_user_create_v10', { id: 'alice', displayName: 'Alice', role: 'member', createdBy: 'admin1' }));
    assert.equal(userOut.user.id, 'alice');
    assert.equal(userOut.quota.maxAgents, 5);
    assert.match(await runTool(tools, 'fleet_user_create_v10', { id: 'alice', displayName: 'A2', role: 'member' }), /^Error: user already exists/);
    // Trigger.
    const trigOut = JSON.parse(await runTool(tools, 'fleet_trigger_create_v10', {
      name: 'notes', agentId: 'bot-1', ownerUserId: 'alice', eventKind: 'file-changed',
      condition: { pathGlob: 'notes/**.md' }, debounceMs: 0, throttleMs: 0, maxRunsPerHour: 0,
    }));
    assert.equal(trigOut.agentId, 'bot-1');
    const listOut = JSON.parse(await runTool(tools, 'fleet_trigger_list_v10', {}));
    assert.equal(listOut.triggers.length, 1);
    assert.equal(listOut.summary.total, 1);
    // Schedule: cron 09:00 Saigon -> lan chay ke la 02:00 UTC ngay tiep
    // theo (tool dung Date.now() that, khong phai T0 co dinh cua test;
    // toan hoc mui gio da duoc kiem ky o fleet-v113-scheduled).
    const schedOut = JSON.parse(await runTool(tools, 'fleet_schedule_create_v10', {
      name: 'morning', agentId: 'bot-1', ownerUserId: 'alice', kind: 'cron',
      cron: '0 9 * * *', timezone: 'Asia/Ho_Chi_Minh',
    }));
    assert.ok(schedOut.nextRunAt > Date.now(), 'next run must be in the future');
    const nextDate = new Date(schedOut.nextRunAt);
    assert.equal(nextDate.getUTCHours(), 2, '09:00 Saigon = 02:00 UTC');
    assert.equal(nextDate.getUTCMinutes(), 0);
    const schedList = JSON.parse(await runTool(tools, 'fleet_schedule_list_v10', {}));
    assert.equal(schedList.schedules.length, 1);
    // Tick: monkey-patch Date.now bang cach goi truc tiep core (tool dung
    // Date.now that) — o day chi kiem tick chay khong loi va luu state.
    const tickOut = await runTool(tools, 'fleet_schedule_tick_v10', { runningAgentIds: [] });
    assert.ok(!tickOut.startsWith('Error:'), tickOut);
    // Agent control: can runtime state truoc.
    const fleetRoot = path.join(base, 'fleet');
    saveFleetV10AgentRuntimeStates(fleetRoot, [createFleetV10AgentRuntimeState('bot-1', 'Bot One', 'alice')]);
    const startOut = JSON.parse(await runTool(tools, 'fleet_agent_control_v10', { agentId: 'bot-1', action: 'start', actorUserId: 'admin1', reason: 'go' }));
    assert.equal(startOut.state.status, 'running');
    assert.equal(startOut.event.action, 'start');
    assert.match(await runTool(tools, 'fleet_agent_control_v10', { agentId: 'bot-1', action: 'start', actorUserId: 'admin1' }), /^Error: cannot start/);
    const pauseOut = JSON.parse(await runTool(tools, 'fleet_agent_control_v10', { agentId: 'bot-1', action: 'pause', actorUserId: 'admin1', reason: 'hold' }));
    assert.equal(pauseOut.state.status, 'paused');
    const resumeOut = JSON.parse(await runTool(tools, 'fleet_agent_control_v10', { agentId: 'bot-1', action: 'resume', actorUserId: 'admin1' }));
    assert.equal(resumeOut.state.status, 'running');
    const stopOut = JSON.parse(await runTool(tools, 'fleet_agent_control_v10', { agentId: 'bot-1', action: 'stop', actorUserId: 'admin1' }));
    assert.equal(stopOut.state.status, 'stopped');
    assert.match(await runTool(tools, 'fleet_agent_control_v10', { agentId: 'bot-9', action: 'start', actorUserId: 'admin1' }), /not found/);
    // Log tail: chi trong fleet root.
    const logPath = path.join(fleetRoot, 'bot-1.log');
    fs.writeFileSync(logPath, 'a\nb\nc\n');
    const tailOut = JSON.parse(await runTool(tools, 'fleet_log_tail_v10', { logPath, maxLines: 2 }));
    assert.deepEqual(tailOut.lines, ['b', 'c']);
    assert.match(await runTool(tools, 'fleet_log_tail_v10', { logPath: '/etc/passwd' }), /inside the fleet directory/);
    // Files da luu that xuong dia.
    assert.ok(fs.existsSync(path.join(fleetRoot, 'fleet-triggers-v113.json')));
    assert.ok(fs.existsSync(path.join(fleetRoot, 'fleet-schedules-v113.json')));
    assert.ok(fs.existsSync(path.join(fleetRoot, 'fleet-users-v113.json')));
    assert.ok(fs.existsSync(path.join(fleetRoot, 'fleet-agent-runtime-v113.json')));
    // createFleetV10Schedule / createFleetV10User imports duoc dung o test
    // tren (tranh unused): kiem tra nhanh 1 lich interval.
    assert.equal(createFleetV10Schedule({ name: 'i', agentId: 'b', ownerUserId: 'a', kind: 'interval', intervalMs: 1000 }, T0).kind, 'interval');
    assert.equal(createFleetV10User([], { id: 'x', displayName: 'X', role: 'member' }, T0).id, 'x');
    assert.equal(createFleetV10Trigger({ name: 't', agentId: 'b', ownerUserId: 'a', eventKind: 'agent-done', debounceMs: 0, throttleMs: 0, maxRunsPerHour: 0 }, T0).eventKind, 'agent-done');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

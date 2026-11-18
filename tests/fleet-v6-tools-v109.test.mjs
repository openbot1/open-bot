/**
 * Tests for the fleet v6 tools (packages/tools/src/fleetV6Tools.ts).
 *
 * Covers registry membership (each of the 10 names exactly once in
 * ALL_TOOLS, no duplicates), the unbound behaviour (all ten say
 * "not wired"), bound execution against a temp userData dir (schedule
 * create/list round-trip with day plan, run-now enqueue + queue
 * list/next, quota group set/list/check round-trip with warn/breach
 * levels, health check/incidents/restart round-trip with backoff),
 * and `createDefaultTools` binding without duplicates.
 *
 * Run after building tools (which builds core first):
 *   npm run build --workspace=@open-bot/tools
 *   node --test tests/fleet-v6-tools-v109.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { ALL_TOOLS, createDefaultTools } from '../packages/tools/dist/tools.js';
import {
  FLEET_V6_TOOL_NAMES,
  FLEET_V6_TOOLS,
  createFleetV6Tools,
  isFleetV6ToolName,
} from '../packages/tools/dist/fleetV6Tools.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-fleet-v6-tools-'));
}

function toolByName(tools, name) {
  const found = tools.filter((t) => t.definition.name === name);
  assert.equal(found.length, 1, `expected exactly one tool named ${name}, got ${found.length}`);
  return found[0];
}

function toolNames(tools) {
  return tools.map((t) => t.definition.name);
}

const CTX = { workspaceDir: '/tmp', signal: undefined };
const GB = 1024 * 1024 * 1024;

function boundTools() {
  const base = tmpDir();
  return { base, tools: createFleetV6Tools(() => base) };
}

function resources(overrides = {}) {
  return { cpuCores: 1, ramBytes: 1 * GB, diskBytes: 10 * GB, ...overrides };
}

test('registry: all 10 fleet v6 tools in ALL_TOOLS exactly once (491 total)', () => {
  for (const name of FLEET_V6_TOOL_NAMES) {
    assert.ok(toolNames(ALL_TOOLS).includes(name), `ALL_TOOLS missing ${name}`);
    assert.equal(toolNames(ALL_TOOLS).filter((n) => n === name).length, 1, `${name} duplicated`);
  }
  assert.equal(FLEET_V6_TOOLS.length, 10);
  assert.equal(new Set(toolNames(ALL_TOOLS)).size, toolNames(ALL_TOOLS).length, 'ALL_TOOLS has duplicate names');
  assert.equal(ALL_TOOLS.length, 899); // v1.14 merge: 453 + 38 = 500; v1.13: 402 + 51 = 453; v1.10 merge: 236 + 53 = 289; v1.11 merge: 289 + 70 = 359 // v1.36 re-pin: 825 + 74 = 899.
  assert.equal(isFleetV6ToolName('fleet_schedule_create'), true);
  assert.equal(isFleetV6ToolName('fleet_v5_campaign_create'), false);
  assert.equal(isFleetV6ToolName('fleet_nope'), false);
});

test('approval flags: writes need approval, reads do not', () => {
  const writes = ['fleet_schedule_create', 'fleet_schedule_run_now', 'fleet_quota_group_set', 'fleet_health_restart'];
  const reads = ['fleet_schedule_list', 'fleet_schedule_queue', 'fleet_quota_group_list', 'fleet_quota_group_check', 'fleet_health_check', 'fleet_health_incidents'];
  for (const name of writes) assert.equal(toolByName(FLEET_V6_TOOLS, name).needsApproval, true, name);
  for (const name of reads) assert.equal(toolByName(FLEET_V6_TOOLS, name).needsApproval, false, name);
  for (const t of FLEET_V6_TOOLS) {
    assert.ok(t.definition.description.length > 20, t.definition.name);
    assert.equal(typeof t.execute, 'function');
  }
});

test('unbound: all ten tools say not wired', async () => {
  for (const name of FLEET_V6_TOOL_NAMES) {
    const tool = toolByName(FLEET_V6_TOOLS, name);
    const out = await tool.execute({}, CTX);
    assert.match(out, /not wired/, name);
  }
});

test('schedule: create/list round-trip with day plan', async () => {
  const { tools } = boundTools();
  const create = toolByName(tools, 'fleet_schedule_create');
  // v1.11 merge fix: cron cố định 9:00 làm test phụ thuộc giờ trong ngày
  // (chạy sau 9:00 thì nextRunAt rơi sang ngày mai → dayPlan hôm nay trống).
  // Tính giờ chạy động = 2 giờ nữa; nếu vượt qua nửa đêm thì nextRunAt ở
  // ngày mai và lịch phải nằm trong `unscheduled` với lý do thật
  // 'next-run-outside-day' (không phải slot hôm nay) — assert đúng ngữ nghĩa
  // ở cả hai nhánh, không phụ thuộc giờ chạy suite.
  const now = new Date();
  const runAt = new Date(now.getTime() + 2 * 60 * 60 * 1000);
  const out = await create.execute(
    {
      botId: 'bot-1',
      summary: 'Chạy sáng',
      kind: 'cron',
      cron: { minute: String(runAt.getMinutes()), hour: String(runAt.getHours()), dayOfMonth: '*', month: '*', dayOfWeek: '*' },
      priority: 'high',
      resources: resources(),
    },
    CTX,
  );
  assert.ok(!out.startsWith('Error:'), out);
  const created = JSON.parse(out).schedule;
  assert.equal(created.botId, 'bot-1');
  assert.ok(created.nextRunAt !== null);

  const list = toolByName(tools, 'fleet_schedule_list');
  const listed = JSON.parse(await list.execute({}, CTX));
  assert.equal(listed.count, 1);
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  if (created.nextRunAt < todayStart.getTime() + 24 * 60 * 60 * 1000) {
    assert.equal(listed.dayPlan.slots.length, 1);
    assert.equal(listed.dayPlan.maxHeavyOverlap, 0); // bot nhẹ (1 core) nên không có slot nặng nào
  } else {
    // Lần chạy kế tiếp ở ngày mai: không có slot hôm nay, lịch vào unscheduled.
    assert.equal(listed.dayPlan.slots.length, 0);
    assert.equal(listed.dayPlan.unscheduled.length, 1);
    assert.equal(listed.dayPlan.unscheduled[0].reason, 'next-run-outside-day');
  }
  const filtered = JSON.parse(await list.execute({ botId: 'bot-9' }, CTX));
  assert.equal(filtered.count, 0);

  // Cron hỏng thì lỗi rõ ràng, không tạo lịch.
  const bad = await create.execute(
    { botId: 'bot-1', summary: 'Hỏng', kind: 'cron', cron: { minute: '61', hour: '9', dayOfMonth: '*', month: '*', dayOfWeek: '*' }, resources: resources() },
    CTX,
  );
  assert.match(bad, /^Error:/);
  const stillOne = JSON.parse(await list.execute({}, CTX));
  assert.equal(stillOne.count, 1);
});

test('schedule: interval + event kinds create', async () => {
  const { tools } = boundTools();
  const create = toolByName(tools, 'fleet_schedule_create');
  const interval = await create.execute(
    { botId: 'bot-2', summary: 'Lặp giờ', kind: 'interval', intervalMs: 3600000, resources: resources() },
    CTX,
  );
  assert.ok(!interval.startsWith('Error:'), interval);
  const event = await create.execute(
    { botId: 'bot-3', summary: 'Khi xong', kind: 'event', event: { type: 'on-bot-done', botId: 'bot-1' }, resources: resources() },
    CTX,
  );
  assert.ok(!event.startsWith('Error:'), event);
  const listed = JSON.parse(await toolByName(tools, 'fleet_schedule_list').execute({}, CTX));
  assert.equal(listed.count, 2);
});

test('queue: run-now enqueues; queue list/next reflect priority', async () => {
  const { tools } = boundTools();
  const runNow = toolByName(tools, 'fleet_schedule_run_now');
  const low = await runNow.execute({ botId: 'low-bot', summary: 'thấp', priority: 'low', resources: resources() }, CTX);
  assert.ok(!low.startsWith('Error:'), low);
  const high = await runNow.execute({ botId: 'high-bot', summary: 'cao', priority: 'high', resources: resources() }, CTX);
  assert.ok(!high.startsWith('Error:'), high);
  const queue = toolByName(tools, 'fleet_schedule_queue');
  const next = JSON.parse(await queue.execute({ action: 'next' }, CTX));
  assert.equal(next.next.botId, 'high-bot');
  const listed = JSON.parse(await queue.execute({ action: 'list' }, CTX));
  assert.equal(listed.totalWaiting, 2);
  assert.match(await queue.execute({ action: 'nope' }, CTX), /^Error: action must be/);
});

test('quota group: set/list/check round-trip with warn level', async () => {
  const { tools } = boundTools();
  const set = toolByName(tools, 'fleet_quota_group_set');
  const out = await set.execute(
    { name: 'team-a', botIds: ['bot-1', 'bot-2'], cpuCoresMax: 2, ramBytesMax: 4 * GB, diskBytesMax: 20 * GB },
    CTX,
  );
  assert.ok(!out.startsWith('Error:'), out);
  const created = JSON.parse(out).group;
  assert.equal(created.name, 'team-a');
  assert.equal(created.warnPercent, 0.8);
  const list = JSON.parse(await toolByName(tools, 'fleet_quota_group_list').execute({}, CTX));
  assert.equal(list.count, 1);
  // Chưa đo được mức dùng -> unknown, không đoán breach.
  const check = JSON.parse(await toolByName(tools, 'fleet_quota_group_check').execute({}, CTX));
  assert.equal(check.evaluations.length, 1);
  assert.equal(check.evaluations[0].overall, 'unknown');
  assert.deepEqual(check.pausedBotIds, []);
  // Tên nhóm trùng (nhóm khác) thì lỗi.
  const dup = await set.execute(
    { name: 'team-a', botIds: ['bot-3'], cpuCoresMax: 1, ramBytesMax: 1 * GB, diskBytesMax: 10 * GB },
    CTX,
  );
  assert.match(dup, /^Error:/);
  assert.ok(dup.includes('team-a'));
});

test('quota group: check with measured usage reports breach + paused bots', async () => {
  const { base, tools } = boundTools();
  await toolByName(tools, 'fleet_quota_group_set').execute(
    { name: 'team-a', botIds: ['bot-1'], cpuCoresMax: 1, ramBytesMax: 1 * GB, diskBytesMax: 10 * GB },
    CTX,
  );
  // Ghi sample mức dùng thật vào usage ledger (định dạng của quotas v2).
  const fleetRoot = path.join(base, 'fleet');
  fs.mkdirSync(fleetRoot, { recursive: true });
  const sample = (at, cpuSeconds, rss) => ({ workspaceId: 'bot-1', at, cpuSeconds, rssBytes: rss, diskBytes: 5 * GB, servicePid: 1234 });
  fs.writeFileSync(
    path.join(fleetRoot, 'usage.jsonl'),
    [sample(1792000000000, 100, 2 * GB), sample(1792000060000, 160, 2 * GB)].map((s) => JSON.stringify(s)).join('\n') + '\n',
  );
  const check = JSON.parse(await toolByName(tools, 'fleet_quota_group_check').execute({}, CTX));
  const evaluation = check.evaluations[0];
  // CPU rate = 60 cpu-s / 60 s = 1 core = đúng trần (breach); RAM 2GB/1GB cũng breach.
  assert.equal(evaluation.overall, 'breach');
  assert.equal(evaluation.action, 'pause');
  assert.deepEqual(check.pausedBotIds, ['bot-1']);
});

test('health: check reports down for never-seen bot; incidents + restart round-trip', async () => {
  const { tools } = boundTools();
  const check = toolByName(tools, 'fleet_health_check');
  const down = JSON.parse(await check.execute({ botId: 'ghost' }, CTX));
  assert.equal(down.health.status, 'down');
  assert.equal(down.health.quotaLevel, null);

  const restart = toolByName(tools, 'fleet_health_restart');
  const first = JSON.parse(await restart.execute({ botId: 'bot-1', action: 'record-crash', message: 'segfault' }, CTX));
  assert.equal(first.decision.shouldRestart, true);
  assert.equal(first.decision.delayMs, 5000);
  assert.equal(first.decision.attempt, 1);
  assert.equal(first.consecutiveFailures, 1);
  const second = JSON.parse(await restart.execute({ botId: 'bot-1', action: 'record-crash', message: 'segfault again' }, CTX));
  assert.equal(second.decision.delayMs, 10000);
  const ok = JSON.parse(await restart.execute({ botId: 'bot-1', action: 'record-restart' }, CTX));
  assert.equal(ok.recorded, true);

  const incidents = toolByName(tools, 'fleet_health_incidents');
  const all = JSON.parse(await incidents.execute({}, CTX));
  assert.equal(all.count, 3); // 2 crash + 1 restart
  assert.equal(all.incidents[0].kind, 'restart');
  const crashes = JSON.parse(await incidents.execute({ kind: 'crash' }, CTX));
  assert.equal(crashes.count, 2);
  const forBot = JSON.parse(await incidents.execute({ botId: 'bot-2' }, CTX));
  assert.equal(forBot.count, 0);
  assert.match(await incidents.execute({ kind: 'nope' }, CTX), /^Error: kind must be/);
});

test('health: 3rd crash in a row makes restart refuse (unhealthy)', async () => {
  const { tools } = boundTools();
  const restart = toolByName(tools, 'fleet_health_restart');
  await restart.execute({ botId: 'bot-1', action: 'record-crash', message: 'boom 1' }, CTX);
  await restart.execute({ botId: 'bot-1', action: 'record-crash', message: 'boom 2' }, CTX);
  const third = JSON.parse(await restart.execute({ botId: 'bot-1', action: 'record-crash', message: 'boom 3' }, CTX));
  assert.equal(third.decision.shouldRestart, false);
  assert.equal(third.decision.reason, 'unhealthy');
  assert.equal(third.consecutiveFailures, 3);
});

test('binding: createDefaultTools with getFleetV6BaseDir keeps 491 tools, no duplicates', () => {
  const dir = tmpDir();
  const bound = createDefaultTools({ getFleetV6BaseDir: () => dir });
  assert.equal(bound.length, 899); // v1.36 re-pin: 825 + 74 = 899.
  assert.equal(new Set(bound.map((t) => t.definition.name)).size, 899); // v1.36 re-pin: 825 + 74 = 899.
  for (const name of FLEET_V6_TOOL_NAMES) {
    assert.ok(bound.some((t) => t.definition.name === name), name);
  }
});

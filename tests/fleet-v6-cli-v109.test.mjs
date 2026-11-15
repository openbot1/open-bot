/**
 * Tests for the `fleet v6` CLI (apps/cli/src/cli.ts, v1.09 Đội T6).
 *
 * Runs the real built CLI (apps/cli/dist/cli.js) against a temp
 * OPENBOT_DATA_DIR seeded with fleet v6 files: overview, schedules,
 * queue, tick (starts a waiting entry), quota-check, health, incidents,
 * plus JSON output and unknown-subcommand errors.
 *
 * Run after building cli (which builds core first):
 *   npm run build --workspace=@open-bot/cli
 *   node --test tests/fleet-v6-cli-v109.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { addFleetV6Schedule } from '../packages/core/dist/fleet/fleetV6Scheduler.js';
import { enqueueFleetV6, saveFleetV6Queue } from '../packages/core/dist/fleet/fleetV6Scheduler.js';
import { setFleetV6QuotaGroup } from '../packages/core/dist/fleet/fleetV6Quotas.js';
import { appendFleetV6Incident, createFleetV6Incident, recordFleetV6Crash, saveFleetV6HealthStates } from '../packages/core/dist/fleet/fleetV6Health.js';

const run = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..');
const cli = join(repo, 'apps/cli/dist/cli.js');
const GB = 1024 ** 3;

function tmpDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-fleet-v6-cli-'));
}

function cleanup(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // Bỏ qua lỗi dọn.
  }
}

async function runCli(args, dataDir) {
  try {
    const { stdout, stderr } = await run(process.execPath, [cli, ...args], {
      cwd: repo,
      timeout: 60_000,
      env: { ...process.env, OPENBOT_DATA_DIR: dataDir },
    });
    return { code: 0, stdout, stderr };
  } catch (err) {
    return {
      code: typeof err.code === 'number' ? err.code : 1,
      stdout: err.stdout ?? '',
      stderr: err.stderr ?? '',
    };
  }
}

function seed(dataDir) {
  // v1.11 merge fix: cron cố định 9:00 làm test phụ thuộc giờ trong ngày
  // (chạy sau 9:00 thì nextRunAt rơi sang ngày mai → dayPlan hôm nay 0 slot).
  // Lấy giờ chạy động = 2 giờ nữa; trả về để test list tính số slot kỳ vọng.
  const runAt = new Date(Date.now() + 2 * 60 * 60 * 1000);
  const fleetRoot = path.join(dataDir, 'fleet');
  addFleetV6Schedule(fleetRoot, {
    botId: 'bot-1',
    summary: 'Chạy sáng',
    kind: 'cron',
    cron: { minute: String(runAt.getMinutes()), hour: String(runAt.getHours()), dayOfMonth: '*', month: '*', dayOfWeek: '*' },
    resources: { cpuCores: 1, ramBytes: 1 * GB, diskBytes: 10 * GB },
  });
  const entry = enqueueFleetV6([], {
    botId: 'bot-1',
    summary: 'run',
    priority: 'high',
    resources: { cpuCores: 1, ramBytes: 1 * GB, diskBytes: 10 * GB },
  });
  saveFleetV6Queue(fleetRoot, [entry]);
  setFleetV6QuotaGroup(fleetRoot, { name: 'team-a', botIds: ['bot-1'], cpuCoresMax: 2, ramBytesMax: 4 * GB, diskBytesMax: 20 * GB }, 'admin');
  const states = recordFleetV6Crash([], 'bot-1', Date.now() - 1000, 'boom');
  saveFleetV6HealthStates(fleetRoot, states);
  appendFleetV6Incident(fleetRoot, createFleetV6Incident('bot-1', 'crash', 'boom'));
  return runAt;
}

test('fleet v6 overview: one-line summary with counts', async () => {
  const dir = tmpDataDir();
  try {
    seed(dir);
    const { code, stdout } = await runCli(['fleet', 'v6', 'overview'], dir);
    assert.equal(code, 0);
    assert.match(stdout, /fleet v6:/);
    assert.match(stdout, /1\/1 schedules enabled/);
    assert.match(stdout, /1 incident\(s\) in the last hour/);
    const json = await runCli(['fleet', 'v6', 'overview', '--json'], dir);
    assert.equal(json.code, 0);
    const parsed = JSON.parse(json.stdout);
    assert.equal(parsed.totals.botsTotal, 1);
    assert.equal(parsed.totals.queueWaiting, 1);
  } finally {
    cleanup(dir);
  }
});

test('fleet v6 schedules + queue: list shows the seeded schedule and entry', async () => {
  const dir = tmpDataDir();
  try {
    const runAt = seed(dir);
    const schedules = await runCli(['fleet', 'v6', 'schedules'], dir);
    assert.equal(schedules.code, 0);
    assert.match(schedules.stdout, /bot-1\s+cron\s+normal\s+enabled/);
    // Số slot kỳ vọng phụ thuộc giờ chạy: lần chạy kế tiếp sau nửa đêm thì
    // dayPlan hôm nay 0 slot và lịch vào unscheduled (xem seed()).
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const expectedSlots = runAt.getTime() < todayStart.getTime() + 24 * 60 * 60 * 1000 ? 1 : 0;
    assert.match(schedules.stdout, new RegExp(`Timeslot hôm nay: ${expectedSlots} slot`));
    if (expectedSlots === 0) {
      assert.match(schedules.stdout, /next-run-outside-day/);
    }
    const queue = await runCli(['fleet', 'v6', 'queue'], dir);
    assert.equal(queue.code, 0);
    assert.match(queue.stdout, /Chờ: 1, đang chạy: 0/);
    assert.match(queue.stdout, /Tiếp theo: bot-1 \(high\)/);
    const filtered = await runCli(['fleet', 'v6', 'schedules', '--bot', 'bot-9'], dir);
    assert.match(filtered.stdout, /Chưa có lịch fleet v6 nào/);
  } finally {
    cleanup(dir);
  }
});

test('fleet v6 tick: starts the waiting entry and persists it', async () => {
  const dir = tmpDataDir();
  try {
    seed(dir);
    const tick = await runCli(['fleet', 'v6', 'tick'], dir);
    assert.equal(tick.code, 0);
    assert.match(tick.stdout, /1 entry bắt đầu/);
    assert.match(tick.stdout, /start bot-1 \(high\)/);
    const queue = await runCli(['fleet', 'v6', 'queue'], dir);
    assert.match(queue.stdout, /Chờ: 0, đang chạy: 1/);
  } finally {
    cleanup(dir);
  }
});

test('fleet v6 quota-check + health + incidents', async () => {
  const dir = tmpDataDir();
  try {
    seed(dir);
    const quota = await runCli(['fleet', 'v6', 'quota-check'], dir);
    assert.equal(quota.code, 0);
    assert.match(quota.stdout, /nhóm "team-a": unknown/);
    const health = await runCli(['fleet', 'v6', 'health', 'bot-1'], dir);
    assert.equal(health.code, 0);
    assert.match(health.stdout, /Bot "bot-1": down/);
    assert.match(health.stdout, /heartbeat: no heartbeat seen yet/);
    const incidents = await runCli(['fleet', 'v6', 'incidents'], dir);
    assert.equal(incidents.code, 0);
    assert.match(incidents.stdout, /bot-1 crash: boom/);
    const filtered = await runCli(['fleet', 'v6', 'incidents', '--bot', 'bot-9'], dir);
    assert.match(filtered.stdout, /Không có incident nào/);
  } finally {
    cleanup(dir);
  }
});

test('fleet v6: unknown subcommand and missing botId fail with exit 1', async () => {
  const dir = tmpDataDir();
  try {
    const bad = await runCli(['fleet', 'v6', 'nope'], dir);
    assert.equal(bad.code, 1);
    assert.match(bad.stderr, /Không rõ lệnh fleet v6 "nope"/);
    const noSub = await runCli(['fleet', 'v6'], dir);
    assert.equal(noSub.code, 1);
    assert.match(noSub.stderr, /fleet v6 cần subcommand/);
    const noBot = await runCli(['fleet', 'v6', 'health'], dir);
    assert.equal(noBot.code, 1);
    assert.match(noBot.stderr, /fleet v6 health cần <botId>/);
    const empty = await runCli(['fleet', 'v6', 'overview'], dir);
    assert.equal(empty.code, 0);
    assert.match(empty.stdout, /0\/0 healthy/);
  } finally {
    cleanup(dir);
  }
});

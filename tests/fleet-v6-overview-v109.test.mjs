/**
 * Tests for fleet overview v6 (packages/core/src/fleet/fleetV6Overview.ts).
 *
 * Covers: the pure aggregator (bot rows from health + quota + queue +
 * schedules, totals, warnings: unhealthy/down/over-quota/throttled/
 * paused/backlog/unscheduled, unmeasured usage reported as unknown)
 * and the file-backed builder (reads schedules + queue + quota groups
 * + health states + incidents from a fleet root).
 *
 * Run after building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/fleet-v6-overview-v109.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { aggregateFleetV6Overview, buildFleetV6Overview, formatFleetV6OverviewLine } from '../packages/core/dist/fleet/fleetV6Overview.js';
import { createFleetV6Schedule, enqueueFleetV6, saveFleetV6Queue, saveFleetV6Schedules } from '../packages/core/dist/fleet/fleetV6Scheduler.js';
import { setFleetV6QuotaGroup } from '../packages/core/dist/fleet/fleetV6Quotas.js';
import { appendFleetV6Incident, createFleetV6Incident, recordFleetV6Crash, saveFleetV6HealthStates } from '../packages/core/dist/fleet/fleetV6Health.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-fleet-v6-overview-'));
}

const GB = 1024 ** 3;
const T0 = new Date(2026, 10, 15, 8, 0, 0).getTime();

function resources(overrides = {}) {
  return { cpuCores: 1, ramBytes: 1 * GB, diskBytes: 10 * GB, ...overrides };
}

function usage(cpu, ram, disk) {
  return { cpuCores: cpu, ramBytes: ram, diskBytes: disk };
}

function healthyResult(botId, overrides = {}) {
  return {
    botId,
    status: 'healthy',
    checks: [],
    quotaLevel: 'ok',
    recentErrorCount: 0,
    lastError: null,
    markedUnhealthy: false,
    at: T0,
    ...overrides,
  };
}

function group(overrides = {}) {
  return {
    id: 'qg6-1',
    name: 'team-a',
    botIds: ['bot-1'],
    cpuCoresMax: 2,
    ramBytesMax: 4 * GB,
    diskBytesMax: 20 * GB,
    warnPercent: 0.8,
    enabled: true,
    throttleMaxConcurrent: 1,
    updatedAt: new Date(T0).toISOString(),
    updatedBy: 'admin',
    ...overrides,
  };
}

test('aggregate: healthy bot row with measured usage + next run', () => {
  const schedule = createFleetV6Schedule(
    { botId: 'bot-1', summary: 'Sáng', kind: 'cron', cron: { minute: '0', hour: '9', dayOfMonth: '*', month: '*', dayOfWeek: '*' }, resources: resources() },
    T0,
  );
  const overview = aggregateFleetV6Overview({
    schedules: [schedule],
    queue: [],
    quotaGroups: [group()],
    botQuotas: [],
    usageByBot: { 'bot-1': usage(0.5, 1 * GB, 5 * GB) },
    healthByBot: { 'bot-1': healthyResult('bot-1') },
    healthStates: [],
    incidents: [],
    now: T0,
  });
  assert.equal(overview.bots.length, 1);
  const bot = overview.bots[0];
  assert.equal(bot.status, 'healthy');
  assert.equal(bot.usageKnown, true);
  assert.equal(bot.quotaLevel, 'ok');
  assert.equal(bot.nextRunAt, schedule.nextRunAt);
  assert.equal(bot.pausedByQuota, false);
  assert.equal(overview.totals.botsHealthy, 1);
  assert.equal(overview.totals.schedulesEnabled, 1);
  assert.equal(overview.dayPlan.slots.length, 1);
  assert.match(formatFleetV6OverviewLine(overview), /1\/1 healthy/);
});

test('aggregate: bot without health check is down with unknown usage', () => {
  const overview = aggregateFleetV6Overview({
    schedules: [],
    queue: [],
    quotaGroups: [],
    botQuotas: [],
    usageByBot: {},
    healthByBot: {},
    healthStates: [],
    incidents: [],
    now: T0,
  });
  assert.deepEqual(overview.bots, []);
  assert.equal(overview.totals.botsTotal, 0);
  assert.ok(overview.warnings.some((w) => w.code === 'no-schedules'));
});

test('aggregate: unmeasured bot shows usageKnown false and down status', () => {
  const schedule = createFleetV6Schedule(
    { botId: 'ghost', summary: 'Sáng', kind: 'cron', cron: { minute: '0', hour: '9', dayOfMonth: '*', month: '*', dayOfWeek: '*' }, resources: resources() },
    T0,
  );
  const overview = aggregateFleetV6Overview({
    schedules: [schedule],
    queue: [],
    quotaGroups: [],
    botQuotas: [],
    usageByBot: {},
    healthByBot: {},
    healthStates: [],
    incidents: [],
    now: T0,
  });
  assert.equal(overview.bots[0].status, 'down');
  assert.equal(overview.bots[0].usageKnown, false);
  assert.equal(overview.bots[0].quotaLevel, null);
  assert.ok(overview.warnings.some((w) => w.code === 'bot-down' && w.botId === 'ghost'));
});

test('aggregate: over-quota bot is paused + warned; throttled bot capped', () => {
  const overview = aggregateFleetV6Overview({
    schedules: [],
    queue: [],
    quotaGroups: [group()],
    botQuotas: [],
    usageByBot: { 'bot-1': usage(0.5, 5 * GB, 5 * GB) }, // RAM 5/4 GB -> breach
    healthByBot: { 'bot-1': healthyResult('bot-1', { quotaLevel: 'breach' }) },
    healthStates: [],
    incidents: [],
    now: T0,
  });
  const bot = overview.bots[0];
  assert.equal(bot.pausedByQuota, true);
  assert.equal(bot.quotaLevel, 'breach');
  assert.equal(overview.totals.botsPaused, 1);
  assert.ok(overview.warnings.some((w) => w.code === 'bot-over-quota'));
  assert.ok(overview.warnings.some((w) => w.code === 'bot-paused-by-quota'));

  const throttled = aggregateFleetV6Overview({
    schedules: [],
    queue: [],
    quotaGroups: [group()],
    botQuotas: [],
    usageByBot: { 'bot-1': usage(1.7, 1 * GB, 5 * GB) }, // CPU 85% -> warning -> throttle
    healthByBot: { 'bot-1': healthyResult('bot-1', { quotaLevel: 'warning' }) },
    healthStates: [],
    incidents: [],
    now: T0,
  });
  assert.equal(throttled.bots[0].throttleMaxConcurrent, 1);
  assert.equal(throttled.totals.botsThrottled, 1);
  assert.ok(throttled.warnings.some((w) => w.code === 'bot-throttled'));
});

test('aggregate: unhealthy bot from state + queue backlog warning', () => {
  let states = [];
  states = recordFleetV6Crash(states, 'bot-1', T0 - 1000, 'boom');
  states = recordFleetV6Crash(states, 'bot-1', T0 - 2000, 'boom');
  states = recordFleetV6Crash(states, 'bot-1', T0 - 3000, 'boom');
  const queue = [];
  for (let i = 0; i < 11; i++) {
    queue.push(enqueueFleetV6([], { botId: 'bot-1', summary: `task ${i}`, resources: resources() }, T0));
  }
  const overview = aggregateFleetV6Overview({
    schedules: [],
    queue,
    quotaGroups: [],
    botQuotas: [],
    usageByBot: { 'bot-1': usage(null, null, null) },
    healthByBot: { 'bot-1': healthyResult('bot-1', { status: 'unhealthy', markedUnhealthy: true }) },
    healthStates: states,
    incidents: [],
    now: T0,
  });
  assert.equal(overview.bots[0].status, 'unhealthy');
  assert.equal(overview.bots[0].unhealthy, true);
  assert.equal(overview.bots[0].waiting, 11);
  assert.equal(overview.totals.botsUnhealthy, 1);
  assert.equal(overview.totals.queueWaiting, 11);
  assert.ok(overview.warnings.some((w) => w.code === 'bot-unhealthy'));
  assert.ok(overview.warnings.some((w) => w.code === 'queue-backlog'));
});

test('builder: reads schedules + queue + groups + health + incidents from fleet root', () => {
  const dir = tmpDir();
  const schedule = createFleetV6Schedule(
    { botId: 'bot-1', summary: 'Sáng', kind: 'cron', cron: { minute: '0', hour: '9', dayOfMonth: '*', month: '*', dayOfWeek: '*' }, resources: resources() },
    T0,
  );
  saveFleetV6Schedules(dir, [schedule]);
  const entry = enqueueFleetV6([], { botId: 'bot-1', summary: 'run', resources: resources() }, T0);
  saveFleetV6Queue(dir, [entry]);
  setFleetV6QuotaGroup(dir, { name: 'team-a', botIds: ['bot-1'], cpuCoresMax: 2, ramBytesMax: 4 * GB, diskBytesMax: 20 * GB }, 'admin');
  let states = [];
  states = recordFleetV6Crash(states, 'bot-1', T0 - 1000, 'boom');
  saveFleetV6HealthStates(dir, states);
  appendFleetV6Incident(dir, createFleetV6Incident('bot-1', 'crash', 'boom', T0 - 1000));

  const overview = buildFleetV6Overview(dir, T0);
  assert.equal(overview.bots.length, 1);
  assert.equal(overview.bots[0].botId, 'bot-1');
  assert.equal(overview.bots[0].waiting, 1);
  assert.equal(overview.bots[0].consecutiveFailures, 1);
  assert.equal(overview.totals.incidentsTotal, 1);
  assert.equal(overview.incidents[0].kind, 'crash');
  assert.equal(overview.quotaEvaluations.length, 1);
  assert.equal(overview.quotaEvaluations[0].scope, 'group');
  assert.equal(overview.dayPlan.slots.length, 1);
});

test('builder: empty fleet root gives empty overview, no crash', () => {
  const dir = tmpDir();
  const overview = buildFleetV6Overview(dir, T0);
  assert.equal(overview.bots.length, 0);
  assert.equal(overview.totals.schedulesTotal, 0);
  assert.equal(overview.dayPlan, null);
  assert.ok(overview.warnings.some((w) => w.code === 'no-schedules'));
});

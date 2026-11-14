/**
 * Tests for the fleet overview v3 (packages/core/src/fleet/overview.ts).
 *
 * Covers totals (allocated vs measured use, unmeasured = null, never
 * guessed), top consumers, the linear capacity forecast (not enough
 * samples / too short a span / not growing / already full / a real
 * projection), and the fleet-total series builder.
 *
 * Run after building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/fleet-overview-v103.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildFleetOverview,
  fleetTotalSeries,
  forecastResource,
  linearGrowthPerDay,
} from '../packages/core/dist/fleet/overview.js';

const GB = 1024 ** 3;
const DAY = 24 * 60 * 60 * 1000;

function makeStatus(id, name, overrides = {}) {
  return {
    workspace: {
      id,
      name,
      osUser: name,
      serviceName: `open-bot-${name}`,
      port: 18001,
      rootDir: `/tmp/fleet/${id}`,
      cpuCores: 4,
      ramBytes: 8 * GB,
      diskBytes: 100 * GB,
      members: [],
      status: 'active',
      serviceState: 'running',
      isolationLevel: 'directory',
      createdBy: 'test',
      createdAt: '2026-11-14T00:00:00.000Z',
      updatedAt: '2026-11-14T00:00:00.000Z',
      ...(overrides.workspace ?? {}),
    },
    service: { state: 'running', uptimeMs: 60000, lastHealthAt: Date.now(), ...(overrides.service ?? {}) },
    usage: overrides.usage === undefined ? null : overrides.usage,
  };
}

function usage(workspaceId, rss, disk, cpuSecondsMax = 10) {
  return { workspaceId, samples: 2, windowStart: 0, windowEnd: 1, cpuSecondsMax, rssBytesLatest: rss, diskBytesLatest: disk };
}

test('fleet overview: totals count only measured workspaces; unmeasured stays null', () => {
  const statuses = [
    makeStatus('fw-1', 'alice', { usage: usage('fw-1', 2 * GB, 20 * GB) }),
    makeStatus('fw-2', 'bob', { usage: null }),
  ];
  const overview = buildFleetOverview(statuses, [], []);
  assert.equal(overview.workspaces, 2);
  assert.equal(overview.byServiceState.running, 2);
  assert.equal(overview.ram.allocated, 16 * GB);
  assert.equal(overview.ram.used, 2 * GB);
  assert.equal(overview.ram.measuredWorkspaces, 1);
  assert.equal(overview.ram.usedPercent, 2 / 16);
  assert.equal(overview.disk.used, 20 * GB);
  assert.equal(overview.cpu.used, 10);
  assert.equal(overview.topRam.length, 1);
  assert.equal(overview.topRam[0].workspaceId, 'fw-1');
  assert.equal(overview.topRam[0].share, 1);
  // No samples at all -> forecasts honestly report not-enough-samples.
  assert.ok(overview.forecasts.every((f) => f.reason === 'not-enough-samples'));
  assert.deepEqual(overview.alerts, { warning: 0, breach: 0 });
  assert.deepEqual(overview.quotas, { total: 0, enabled: 0 });
});

test('fleet overview: top consumers are ranked and share the fleet total', () => {
  const statuses = [
    makeStatus('fw-1', 'alice', { usage: usage('fw-1', 6 * GB, 10 * GB, 30) }),
    makeStatus('fw-2', 'bob', { usage: usage('fw-2', 2 * GB, 40 * GB, 10) }),
  ];
  const quotas = [
    { botId: 'fw-1', cpuCoresMax: 2, ramBytesMax: 4 * GB, diskBytesMax: 50 * GB, warnPercent: 0.8, enabled: true, updatedAt: '2026-11-14T00:00:00.000Z', updatedBy: 't' },
    { botId: 'fw-2', cpuCoresMax: 2, ramBytesMax: 4 * GB, diskBytesMax: 50 * GB, warnPercent: 0.8, enabled: false, updatedAt: '2026-11-14T00:00:00.000Z', updatedBy: 't' },
  ];
  const alerts = [{ botId: 'fw-1', resource: 'ram', level: 'warning', percent: 0.9, used: 6 * GB, limit: 4 * GB, at: 1 }];
  const overview = buildFleetOverview(statuses, quotas, alerts);
  assert.equal(overview.topRam[0].workspaceId, 'fw-1');
  assert.equal(overview.topRam[0].share, 0.75);
  assert.equal(overview.topDisk[0].workspaceId, 'fw-2');
  assert.equal(overview.topCpuSeconds[0].workspaceId, 'fw-1');
  assert.equal(overview.quotas.total, 2);
  assert.equal(overview.quotas.enabled, 1);
  assert.deepEqual(overview.alerts, { warning: 1, breach: 0 });
});

test('fleet overview: linearGrowthPerDay needs 3 points spanning a day', () => {
  const now = Date.now();
  assert.equal(linearGrowthPerDay([]), null);
  assert.equal(linearGrowthPerDay([{ at: now, value: 1 }, { at: now + 1000, value: 2 }]), null);
  // Two days, +1 GB/day.
  const slope = linearGrowthPerDay([
    { at: now, value: 1 * GB },
    { at: now + DAY, value: 2 * GB },
    { at: now + 2 * DAY, value: 3 * GB },
  ]);
  assert.ok(slope !== null && Math.abs(slope - GB) < 1);
  // Flat line -> slope 0 (not null: the data is fine, growth is zero).
  const flat = linearGrowthPerDay([
    { at: now, value: 5 },
    { at: now + DAY, value: 5 },
    { at: now + 2 * DAY, value: 5 },
  ]);
  assert.equal(flat, 0);
});

test('fleet overview: forecast reasons are honest; a growing series projects a date', () => {
  const now = Date.now();
  const growing = [
    { at: now - 2 * DAY, value: 1 * GB },
    { at: now - DAY, value: 2 * GB },
    { at: now, value: 3 * GB },
  ];
  const forecast = forecastResource('ram', growing, 8 * GB, now);
  assert.equal(forecast.growthPerDay, GB);
  assert.ok(forecast.daysUntilFull !== null && Math.abs(forecast.daysUntilFull - 5) < 0.01);
  assert.equal(forecast.runsOutAt, Math.round(now + 5 * DAY));
  assert.equal(forecast.samplesUsed, 3);

  assert.equal(forecastResource('ram', growing.slice(0, 2), 8 * GB, now).reason, 'not-enough-samples');
  assert.equal(
    forecastResource('ram', [{ at: now, value: 1 }, { at: now + 1000, value: 2 }, { at: now + 2000, value: 3 }], 8, now).reason,
    'not-enough-timespan',
  );
  assert.equal(
    forecastResource('ram', [{ at: now - 2 * DAY, value: 3 * GB }, { at: now - DAY, value: 3 * GB }, { at: now, value: 3 * GB }], 8 * GB, now).reason,
    'not-growing',
  );
  const full = forecastResource('ram', growing, 2 * GB, now);
  assert.equal(full.reason, 'already-full');
  assert.equal(full.daysUntilFull, null);
});

test('fleet overview: fleetTotalSeries sums samples per timestamp', () => {
  const t0 = Date.now();
  const series = fleetTotalSeries({
    'fw-1': [
      { workspaceId: 'fw-1', at: t0, cpuSeconds: 1, rssBytes: 2 * GB, diskBytes: 10 * GB, servicePid: 1 },
      { workspaceId: 'fw-1', at: t0 + DAY, cpuSeconds: 2, rssBytes: 3 * GB, diskBytes: 11 * GB, servicePid: 1 },
    ],
    'fw-2': [
      { workspaceId: 'fw-2', at: t0, cpuSeconds: 1, rssBytes: 1 * GB, diskBytes: 5 * GB, servicePid: 2 },
      { workspaceId: 'fw-2', at: t0 + DAY, cpuSeconds: 2, rssBytes: null, diskBytes: null, servicePid: 2 },
    ],
  });
  assert.deepEqual(series.ram, [
    { at: t0, value: 3 * GB },
    { at: t0 + DAY, value: 3 * GB },
  ]);
  assert.deepEqual(series.disk, [
    { at: t0, value: 15 * GB },
    { at: t0 + DAY, value: 11 * GB },
  ]);
});

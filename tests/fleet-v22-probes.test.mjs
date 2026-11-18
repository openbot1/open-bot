/**
 * Tests for fleet v22 resource probes + partitioning (v1.35, Đội T6).
 *
 * Covers:
 * - probeHostResourcesV22: real OS measurement (CPU count, RAM totals),
 *   disk passthrough, freshness/age.
 * - allocatableFromProbeV22: headroom is always reserved (25% CPU,
 *   2 GB RAM, 10% disk min 5 GB), allocatable never goes negative.
 * - partitionResourcesV22: priority order, all-or-nothing grants,
 *   remaining accounting, summary counts.
 * - partitionResourcesPerUserV22: per-user caps isolate users (one
 *   user cannot eat another user's share), unknown user rejected.
 * - validateFleetV22Probe + summarizeProbeV22.
 *
 * Imports the BUILT core — build first:
 *   npm run build --workspace=@open-bot/core
 * then: node --test tests/fleet-v22-probes.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_FLEET_V22_HEADROOM,
  allocatableFromProbeV22,
  partitionResourcesPerUserV22,
  partitionResourcesV22,
  probeAgeMsV22,
  probeHostResourcesV22,
  probeIsFreshV22,
  summarizeProbeV22,
  validateFleetV22Probe,
} from '../packages/core/dist/fleetV22/probes.js';

const GB = 1024 ** 3;
const NOW = 1780000000000;

function makeProbe(overrides = {}) {
  return {
    cpuCores: 8,
    cpuUsed: 2,
    ramBytes: 32 * GB,
    ramUsed: 8 * GB,
    diskBytes: 500 * GB,
    diskUsed: 100 * GB,
    diskPath: '/',
    measuredAt: NOW,
    source: 'manual',
    ...overrides,
  };
}

test('probeHostResourcesV22: real OS numbers, sane ranges', () => {
  const probe = probeHostResourcesV22({ diskTotalBytes: 100 * GB, diskUsedBytes: 40 * GB, diskPath: '/', now: NOW });
  assert.ok(probe.cpuCores >= 1);
  assert.ok(probe.cpuUsed >= 0 && probe.cpuUsed <= probe.cpuCores);
  assert.ok(probe.ramBytes > 0);
  assert.ok(probe.ramUsed >= 0 && probe.ramUsed <= probe.ramBytes);
  assert.equal(probe.diskBytes, 100 * GB);
  assert.equal(probe.diskUsed, 40 * GB);
  assert.equal(probe.diskPath, '/');
  assert.equal(probe.measuredAt, NOW);
  assert.equal(probe.source, 'os');
});

test('probe freshness: age and 60s default window', () => {
  const probe = makeProbe();
  assert.equal(probeAgeMsV22(probe, NOW + 30_000), 30_000);
  assert.equal(probeIsFreshV22(probe, 60_000, NOW + 30_000), true);
  assert.equal(probeIsFreshV22(probe, 60_000, NOW + 61_000), false);
  assert.equal(probeAgeMsV22(probe, NOW - 1000), 0); // never negative
});

test('allocatableFromProbeV22: headroom always reserved, never negative', () => {
  const alloc = allocatableFromProbeV22(makeProbe());
  // CPU: 8 - 2 used - 25% of 8 reserved = 4.
  assert.equal(alloc.cpuCores, 4);
  // RAM: 32 - 8 - 2 reserved = 22 GB.
  assert.equal(alloc.ramBytes, 22 * GB);
  // Disk: 500 - 100 - max(10% of 500, 5) = 350 GB.
  assert.equal(alloc.diskBytes, 350 * GB);
  assert.equal(alloc.reserved.cpuCores, 2);
  assert.equal(alloc.reserved.ramBytes, 2 * GB);
  assert.equal(alloc.reserved.diskBytes, 50 * GB);
  // Host fully loaded: allocatable clamps at 0, never negative.
  const loaded = allocatableFromProbeV22(makeProbe({ cpuUsed: 8, ramUsed: 32 * GB, diskUsed: 500 * GB }));
  assert.equal(loaded.cpuCores, 0);
  assert.equal(loaded.ramBytes, 0);
  assert.equal(loaded.diskBytes, 0);
  // Custom headroom: zero headroom shares everything free.
  const noHeadroom = allocatableFromProbeV22(makeProbe(), { cpuFraction: 0, minRamBytes: 0, diskFraction: 0, minDiskBytes: 0 });
  assert.equal(noHeadroom.cpuCores, 6);
  assert.equal(noHeadroom.ramBytes, 24 * GB);
  assert.equal(DEFAULT_FLEET_V22_HEADROOM.cpuFraction, 0.25);
});

test('partitionResourcesV22: priority order, all-or-nothing, remaining', () => {
  const alloc = allocatableFromProbeV22(makeProbe()); // 4 CPU, 22 GB RAM, 350 GB disk
  const { results, remaining, summary } = partitionResourcesV22(alloc, [
    { id: 'small', ownerId: 'u1', cpuCores: 1, ramBytes: 2 * GB, diskBytes: 10 * GB, priority: 0 },
    { id: 'big', ownerId: 'u2', cpuCores: 3, ramBytes: 8 * GB, diskBytes: 50 * GB, priority: 10 },
    { id: 'too-big', ownerId: 'u1', cpuCores: 4, ramBytes: 4 * GB, diskBytes: 10 * GB, priority: 1 },
  ]);
  // big first (priority 10), then too-big (denied: only 1 CPU left), then small.
  const byId = new Map(results.map((r) => [r.id, r]));
  assert.equal(byId.get('big')?.granted, true);
  assert.equal(byId.get('small')?.granted, true);
  assert.equal(byId.get('too-big')?.granted, false);
  assert.equal(byId.get('too-big')?.grantedCpuCores, 0); // all-or-nothing: no partial grant
  assert.match(byId.get('too-big')?.reason ?? '', /thiếu 3 CPU core/);
  assert.equal(remaining.cpuCores, 0); // 4 - 3 - 1
  assert.equal(remaining.ramBytes, 12 * GB); // 22 - 8 - 2
  assert.match(summary, /2\/3/);
});

test('partitionResourcesV22: empty requests, exact-fit grant', () => {
  const alloc = allocatableFromProbeV22(makeProbe());
  const empty = partitionResourcesV22(alloc, []);
  assert.equal(empty.results.length, 0);
  assert.match(empty.summary, /Không có yêu cầu/);
  const exact = partitionResourcesV22(alloc, [
    { id: 'all', ownerId: 'u1', cpuCores: 4, ramBytes: 22 * GB, diskBytes: 350 * GB },
  ]);
  assert.equal(exact.results[0].granted, true);
  assert.equal(exact.remaining.cpuCores, 0);
  assert.equal(exact.remaining.ramBytes, 0);
  assert.equal(exact.remaining.diskBytes, 0);
});

test('partitionResourcesPerUserV22: caps isolate users', () => {
  const alloc = allocatableFromProbeV22(makeProbe()); // 4 CPU, 22 GB RAM, 350 GB disk
  const caps = {
    u1: { cpuCores: 2, ramBytes: 8 * GB, diskBytes: 100 * GB, reserved: { cpuCores: 0, ramBytes: 0, diskBytes: 0 } },
    u2: { cpuCores: 2, ramBytes: 8 * GB, diskBytes: 100 * GB, reserved: { cpuCores: 0, ramBytes: 0, diskBytes: 0 } },
  };
  const { results, perUserRemaining } = partitionResourcesPerUserV22(alloc, caps, [
    { id: 'u1-big', ownerId: 'u1', cpuCores: 3, ramBytes: 2 * GB, diskBytes: 10 * GB },
    { id: 'u1-ok', ownerId: 'u1', cpuCores: 2, ramBytes: 2 * GB, diskBytes: 10 * GB },
    { id: 'u2-ok', ownerId: 'u2', cpuCores: 2, ramBytes: 2 * GB, diskBytes: 10 * GB },
    { id: 'ghost', ownerId: 'u9', cpuCores: 1, ramBytes: 1 * GB, diskBytes: 1 * GB },
  ]);
  const byId = new Map(results.map((r) => [r.id, r]));
  // u1-big exceeds u1's own cap even though the host has room — denied.
  assert.equal(byId.get('u1-big')?.granted, false);
  assert.match(byId.get('u1-big')?.reason ?? '', /trong phần của user/);
  assert.equal(byId.get('u1-ok')?.granted, true);
  assert.equal(byId.get('u2-ok')?.granted, true);
  // Unknown user has no cap at all.
  assert.equal(byId.get('ghost')?.granted, false);
  assert.match(byId.get('ghost')?.reason ?? '', /không có phần tài nguyên/);
  assert.equal(perUserRemaining.u1.cpuCores, 0);
  assert.equal(perUserRemaining.u2.cpuCores, 0);
});

test('validateFleetV22Probe: used > total rejected, bad source rejected', () => {
  assert.deepEqual(validateFleetV22Probe(null), ['probe phải là object.']);
  assert.deepEqual(validateFleetV22Probe(makeProbe()), []);
  assert.ok(validateFleetV22Probe(makeProbe({ cpuUsed: 9 })).some((e) => e.includes('cpuUsed')));
  assert.ok(validateFleetV22Probe(makeProbe({ ramUsed: 33 * GB })).some((e) => e.includes('ramUsed')));
  assert.ok(validateFleetV22Probe(makeProbe({ diskUsed: 600 * GB })).some((e) => e.includes('diskUsed')));
  assert.ok(validateFleetV22Probe(makeProbe({ source: 'guess' })).some((e) => e.includes('source')));
  assert.ok(validateFleetV22Probe(makeProbe({ cpuCores: -1 })).length >= 1);
});

test('summarizeProbeV22: one line with host numbers and age', () => {
  const text = summarizeProbeV22(makeProbe(), NOW + 5000);
  assert.match(text, /8 CPU core/);
  assert.match(text, /RAM 8 GB\/32 GB/);
  assert.match(text, /cách đây 5s/);
  assert.match(text, /manual/);
});

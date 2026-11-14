/**
 * Tests for the fleet scheduler v3 (packages/core/src/fleet/scheduling.ts).
 *
 * Covers placement scoring (fits / no-fit / not-eligible, spread vs
 * binpack, low-RAM deprioritisation, preferred workspace, bot caps),
 * plan ranking, and the durable placement queue (enqueue / claim /
 * cancel / validation / corrupt file).
 *
 * Run after building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/fleet-scheduling-v103.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  cancelPlacement,
  claimPlacement,
  enqueuePlacement,
  listWaitingPlacements,
  loadScheduleQueue,
  planPlacement,
  scoreWorkspaceForPlacement,
  validatePlacementRequest,
  validateSchedulingPolicy,
} from '../packages/core/dist/fleet/scheduling.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-fleet-sched-'));
}

const GB = 1024 ** 3;

function makeStatus(overrides = {}) {
  const ws = overrides.workspace ?? {};
  const svc = overrides.service ?? {};
  return {
    workspace: {
      id: 'fw-1',
      name: 'alice',
      osUser: 'alice',
      serviceName: 'open-bot-alice',
      port: 18001,
      rootDir: '/tmp/fleet/ws1',
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
      ...ws,
    },
    service: {
      state: 'running',
      uptimeMs: 60000,
      lastHealthAt: Date.now(),
      ...svc,
    },
    usage:
      overrides.usage === undefined
        ? { workspaceId: 'fw-1', samples: 2, windowStart: 0, windowEnd: 1, cpuSecondsMax: 10, rssBytesLatest: 2 * GB, diskBytesLatest: 20 * GB }
        : overrides.usage,
  };
}

const REQUEST = { botId: 'bot-new', cpuCores: 1, ramBytes: 1 * GB, diskBytes: 10 * GB };
const POLICY = { strategy: 'spread', maxBotsPerWorkspace: 0, minFreeRamFraction: 0.1 };

// --- validation ------------------------------------------------------------

test('fleet scheduling: validatePlacementRequest / validateSchedulingPolicy reject bad input', () => {
  assert.throws(() => validatePlacementRequest({}), /botId/);
  assert.throws(() => validatePlacementRequest({ ...REQUEST, cpuCores: 0 }), /cpuCores/);
  assert.throws(() => validatePlacementRequest({ ...REQUEST, preferredWorkspaceId: '  ' }), /preferredWorkspaceId/);
  assert.equal(validatePlacementRequest(REQUEST).botId, 'bot-new');
  assert.throws(() => validateSchedulingPolicy({ strategy: 'random', maxBotsPerWorkspace: 0, minFreeRamFraction: 0.1 }), /strategy/);
  assert.throws(() => validateSchedulingPolicy({ strategy: 'spread', maxBotsPerWorkspace: -1, minFreeRamFraction: 0.1 }), /maxBotsPerWorkspace/);
  assert.throws(() => validateSchedulingPolicy({ strategy: 'spread', maxBotsPerWorkspace: 0, minFreeRamFraction: 1 }), /minFreeRamFraction/);
});

// --- scoring ---------------------------------------------------------------

test('fleet scheduling: scoring fits, no-fit, and not-eligible', () => {
  const fits = scoreWorkspaceForPlacement(makeStatus(), REQUEST, POLICY);
  assert.equal(fits.fit, 'fits');
  assert.ok(fits.score > 0 && fits.score <= 1);
  assert.equal(fits.headroomAfter.cpuCores, 3);
  assert.equal(fits.headroomAfter.ramBytes, 5 * GB);

  const tooBig = scoreWorkspaceForPlacement(makeStatus(), { ...REQUEST, ramBytes: 100 * GB }, POLICY);
  assert.equal(tooBig.fit, 'no-fit');
  assert.equal(tooBig.score, 0);
  assert.match(tooBig.reason, /ram/);

  const suspended = scoreWorkspaceForPlacement(
    makeStatus({ workspace: { status: 'suspended' } }),
    REQUEST,
    POLICY,
  );
  assert.equal(suspended.fit, 'not-eligible');
  assert.match(suspended.reason, /suspended/);

  const errored = scoreWorkspaceForPlacement(makeStatus({ service: { state: 'error' } }), REQUEST, POLICY);
  assert.equal(errored.fit, 'not-eligible');
  assert.match(errored.reason, /error/);

  const capped = scoreWorkspaceForPlacement(makeStatus(), REQUEST, { ...POLICY, maxBotsPerWorkspace: 2 }, 2);
  assert.equal(capped.fit, 'not-eligible');
  assert.match(capped.reason, /limit 2/);
});

test('fleet scheduling: spread prefers the emptiest, binpack the fullest', () => {
  const empty = makeStatus({ workspace: { id: 'fw-empty', name: 'empty' }, usage: null });
  const busy = makeStatus({
    workspace: { id: 'fw-busy', name: 'busy' },
    usage: { workspaceId: 'fw-busy', samples: 2, windowStart: 0, windowEnd: 1, cpuSecondsMax: 10, rssBytesLatest: 6 * GB, diskBytesLatest: 80 * GB },
  });
  const spread = planPlacement([empty, busy], REQUEST, POLICY);
  assert.equal(spread.best?.workspaceId, 'fw-empty');
  const binpack = planPlacement([empty, busy], REQUEST, { ...POLICY, strategy: 'binpack' });
  assert.equal(binpack.best?.workspaceId, 'fw-busy');
  // Unmeasured usage is honest: the reason says so, the fit still holds.
  assert.match(spread.candidates.find((c) => c.workspaceId === 'fw-empty')?.reason ?? '', /unmeasured/);
});

test('fleet scheduling: low RAM after placement halves the score; preferred workspace restricts the plan', () => {
  const tight = makeStatus({
    workspace: { id: 'fw-tight', name: 'tight' },
    usage: { workspaceId: 'fw-tight', samples: 2, windowStart: 0, windowEnd: 1, cpuSecondsMax: 10, rssBytesLatest: 6.5 * GB, diskBytesLatest: 10 * GB },
  });
  const roomy = makeStatus({ workspace: { id: 'fw-roomy', name: 'roomy' }, usage: null });
  const scored = scoreWorkspaceForPlacement(tight, REQUEST, POLICY);
  // 8 - 6.5 - 1 = 0.5 GB free of 8 GB = 6% < 10% min -> halved.
  const unhalved = scoreWorkspaceForPlacement(roomy, REQUEST, POLICY);
  assert.ok(scored.score > 0);
  assert.ok(scored.score < unhalved.score);
  const pinned = planPlacement([tight, roomy], { ...REQUEST, preferredWorkspaceId: 'fw-tight' }, POLICY);
  assert.equal(pinned.candidates.length, 1);
  assert.equal(pinned.best?.workspaceId, 'fw-tight');
  const none = planPlacement([tight, roomy], { ...REQUEST, ramBytes: 100 * GB }, POLICY);
  assert.equal(none.best, null);
  assert.ok(none.candidates.every((c) => c.fit === 'no-fit'));
});

// --- queue -----------------------------------------------------------------

test('fleet scheduling: queue enqueue / claim / cancel round-trip', () => {
  const root = tmpDir();
  assert.deepEqual(loadScheduleQueue(root), []);
  assert.deepEqual(listWaitingPlacements(root), []);
  const entry = enqueuePlacement(root, { request: REQUEST, requestedBy: 'alice' });
  assert.equal(entry.status, 'waiting');
  assert.equal(entry.request.botId, 'bot-new');
  assert.equal(entry.policy.strategy, 'spread');
  assert.equal(listWaitingPlacements(root).length, 1);
  assert.throws(() => enqueuePlacement(root, { request: { ...REQUEST, cpuCores: 0 }, requestedBy: 'alice' }), /cpuCores/);
  assert.throws(() => enqueuePlacement(root, { request: REQUEST, requestedBy: '  ' }), /requestedBy/);

  const claimed = claimPlacement(root, entry.id, 'bob');
  assert.equal(claimed.status, 'claimed');
  assert.equal(claimed.claimedBy, 'bob');
  assert.equal(listWaitingPlacements(root).length, 0);
  assert.throws(() => claimPlacement(root, entry.id, 'bob'), /not waiting/);
  assert.throws(() => claimPlacement(root, 'pq-nope', 'bob'), /no queued placement/);

  const entry2 = enqueuePlacement(root, { request: { ...REQUEST, botId: 'bot-2' }, requestedBy: 'alice' });
  const cancelled = cancelPlacement(root, entry2.id, 'no longer needed');
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.cancelReason, 'no longer needed');
  assert.equal(loadScheduleQueue(root).length, 2);
  // Cancelling twice is idempotent.
  assert.equal(cancelPlacement(root, entry2.id).status, 'cancelled');
});

test('fleet scheduling: corrupt queue file throws with a clear message', () => {
  const root = tmpDir();
  fs.writeFileSync(path.join(root, 'fleet-schedule.json'), '{not json', 'utf8');
  assert.throws(() => loadScheduleQueue(root), /not valid JSON/);
  fs.writeFileSync(path.join(root, 'fleet-schedule.json'), JSON.stringify([{ id: 'x' }]), 'utf8');
  assert.throws(() => loadScheduleQueue(root), /corrupt at index 0/);
});

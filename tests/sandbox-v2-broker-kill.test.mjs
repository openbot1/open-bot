/**
 * Tests cho Sandbox v2 — token broker + kill switch + microVM dry-run
 * (v1.34, Đội T2).
 *
 * Run sau khi build core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/sandbox-v2-broker-kill.test.mjs
 *
 * Không gọi mạng thật, không boot VM thật: broker dùng clock fake,
 * microVM dry-run dùng fileExists fake.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  KillSwitch,
  LifetimeCap,
  SANDBOX_V2_BROKER_MAX_TTL_MS,
  SANDBOX_V2_MICROVM_COLD_BOOT_MS,
  TokenBroker,
  builtinPolicyForTrust,
  defaultMicroVmSpec,
  describeMicroVmSnapshot,
  dryRunMicroVm,
  linkAbortSignalToKillSwitch,
  renderMicroVmConfigJson,
  validateMicroVmSpec,
  validateSandboxV2Scopes,
} from '../packages/core/dist/index.js';

function fakeHost(overrides = {}) {
  return {
    platform: 'linux',
    bwrapAvailable: true,
    unshareAvailable: true,
    kvmAvailable: true,
    cpuCount: 4,
    totalMemoryBytes: 8 * 1024 * 1024 * 1024,
    firecrackerAvailable: true,
    ...overrides,
  };
}

/** Mutable fake clock for the broker. */
function fakeClock(startMs = 1_700_000_000_000) {
  let now = startMs;
  return {
    now: () => now,
    advance: (ms) => {
      now += ms;
    },
  };
}

function brokerWithClock(policyTrust = 'standard') {
  const clock = fakeClock();
  const broker = new TokenBroker({ policy: builtinPolicyForTrust(policyTrust), nowFn: clock.now });
  return { broker, clock };
}

test('broker: issue returns metadata + secret; validate passes for the right task+scope', () => {
  const { broker } = brokerWithClock();
  const issued = broker.issue('task-1', ['github:read', 'npm:fetch'], 600_000);
  assert.match(issued.token.id, /^sbv2_/);
  assert.equal(issued.token.taskId, 'task-1');
  assert.deepEqual(issued.token.scopes, ['github:read', 'npm:fetch']);
  assert.equal(issued.token.revoked, false);
  assert.equal(typeof issued.secret, 'string');
  assert.ok(issued.secret.length >= 32);
  const checked = broker.validate(issued.token.id, issued.secret, 'task-1', 'github:read');
  assert.equal(checked.id, issued.token.id);
  assert.equal(broker.isLive(issued.token.id), true);
});

test('broker: TTL is capped by the policy (untrusted policy caps at 5 minutes)', () => {
  const { broker, clock } = brokerWithClock('untrusted');
  const issued = broker.issue('task-1', ['fs:read'], 99_999_999);
  const ttl = Date.parse(issued.token.expiresAt) - clock.now();
  assert.equal(ttl, 300_000);
});

test('broker: TTL is capped by the broker ceiling even for a trusted policy', () => {
  const { broker, clock } = brokerWithClock('trusted');
  const issued = broker.issue('task-1', ['fs:read'], 99_999_999);
  const ttl = Date.parse(issued.token.expiresAt) - clock.now();
  assert.equal(ttl, SANDBOX_V2_BROKER_MAX_TTL_MS);
});

test('broker: wrong secret, wrong task, wrong scope and unknown token all throw', () => {
  const { broker } = brokerWithClock();
  const issued = broker.issue('task-1', ['github:read']);
  assert.throws(() => broker.validate(issued.token.id, 'wrong-secret', 'task-1', 'github:read'), /secret does not match/);
  assert.throws(() => broker.validate(issued.token.id, issued.secret, 'task-2', 'github:read'), /bound to task/);
  assert.throws(() => broker.validate(issued.token.id, issued.secret, 'task-1', 'github:write'), /does not carry scope/);
  assert.throws(() => broker.validate('sbv2_nope', issued.secret, 'task-1', 'github:read'), /Unknown token/);
});

test('broker: unknown scopes and empty scopes are rejected at issue time', () => {
  const { broker } = brokerWithClock();
  assert.throws(() => broker.issue('task-1', ['god-mode']), /unknown scope/);
  assert.throws(() => broker.issue('task-1', []), /at least one scope/);
  assert.deepEqual(validateSandboxV2Scopes(['github:read']), []);
  assert.ok(validateSandboxV2Scopes(['nope']).length > 0);
});

test('broker: expired tokens are revoked on validate and by sweep', () => {
  const { broker, clock } = brokerWithClock();
  const issued = broker.issue('task-1', ['fs:read'], 60_000);
  clock.advance(61_000);
  assert.equal(broker.isLive(issued.token.id), false);
  assert.throws(() => broker.validate(issued.token.id, issued.secret, 'task-1', 'fs:read'), /expired/);
  assert.equal(broker.get(issued.token.id).revoked, true);
  assert.equal(broker.get(issued.token.id).revokeReason, 'expired');

  const second = broker.issue('task-2', ['fs:read'], 60_000);
  clock.advance(61_000);
  const swept = broker.sweepExpired();
  assert.deepEqual(swept, [second.token.id]);
  assert.equal(broker.liveCount(), 0);
});

test('broker: guard runs fn only after validation; revoke + revokeForTask work', async () => {
  const { broker } = brokerWithClock();
  const issued = broker.issue('task-1', ['github:read']);
  let ran = false;
  const out = await broker.guard(issued.token.id, issued.secret, 'task-1', 'github:read', () => {
    ran = true;
    return 'downstream-ok';
  });
  assert.equal(out, 'downstream-ok');
  assert.equal(ran, true);

  ran = false;
  await assert.rejects(
    broker.guard(issued.token.id, 'bad', 'task-1', 'github:read', () => {
      ran = true;
    }),
    /secret does not match/,
  );
  assert.equal(ran, false);

  assert.equal(broker.revoke(issued.token.id, 'manual'), true);
  assert.equal(broker.revoke(issued.token.id, 'manual'), false);
  assert.equal(broker.revoke('sbv2_unknown'), false);
  assert.throws(() => broker.validate(issued.token.id, issued.secret, 'task-1', 'github:read'), /was revoked/);

  const a = broker.issue('task-9', ['fs:read']);
  const b = broker.issue('task-9', ['fs:write']);
  broker.issue('task-10', ['fs:read']);
  const revoked = broker.revokeForTask('task-9', 'task-done');
  assert.deepEqual(revoked.sort(), [a.token.id, b.token.id].sort());
  assert.equal(broker.listForTask('task-9').length, 2);
  assert.equal(broker.listForTask('task-9').every((t) => t.revoked), true);
});

test('kill switch: first trip wins; throwIfFired; listeners run once per trip', () => {
  const ks = new KillSwitch({ runId: 'run-1' });
  assert.equal(ks.isFired, false);
  let calls = 0;
  ks.onTripped(() => {
    calls += 1;
  });
  assert.equal(ks.trip('ui', 'user pressed kill'), true);
  assert.equal(ks.isFired, true);
  assert.equal(ks.source, 'ui');
  assert.equal(ks.reason, 'user pressed kill');
  assert.equal(calls, 1);
  // Second trip changes nothing.
  assert.equal(ks.trip('policy', 'later violation'), false);
  assert.equal(ks.source, 'ui');
  assert.equal(calls, 1);
  assert.throws(() => ks.throwIfFired(), /was killed \(ui\)/);
});

test('kill switch: cleanup runs in reverse order, collects errors, runs once', async () => {
  const ks = new KillSwitch({ runId: 'run-2' });
  const order = [];
  ks.registerCleanup('first', () => {
    order.push('first');
  });
  ks.registerCleanup('second', () => {
    order.push('second');
    throw new Error('cleanup boom');
  });
  ks.registerCleanup('third', () => {
    order.push('third');
  });
  const results = await ks.runCleanup();
  assert.deepEqual(order, ['third', 'second', 'first']);
  assert.equal(results.find((r) => r.label === 'second').ok, false);
  assert.match(results.find((r) => r.label === 'second').error, /cleanup boom/);
  assert.equal(results.find((r) => r.label === 'first').ok, true);
  assert.deepEqual(await ks.runCleanup(), []);
});

test('kill switch: abort signal trips it as manual', () => {
  const ks = new KillSwitch({ runId: 'run-3' });
  const controller = new AbortController();
  linkAbortSignalToKillSwitch(controller.signal, ks);
  controller.abort();
  assert.equal(ks.isFired, true);
  assert.equal(ks.source, 'manual');

  const ks2 = new KillSwitch({ runId: 'run-4' });
  const dead = new AbortController();
  dead.abort();
  linkAbortSignalToKillSwitch(dead.signal, ks2);
  assert.equal(ks2.isFired, true);
});

test('lifetime cap: check passes inside the cap, trips the switch past the deadline', () => {
  const clock = fakeClock();
  const ks = new KillSwitch({ runId: 'run-5' });
  const cap = new LifetimeCap({ runId: 'run-5', maxLifetimeMs: 1000, killSwitch: ks, nowFn: clock.now });
  assert.equal(cap.remainingMs(), 1000);
  assert.equal(cap.check(), true);
  clock.advance(999);
  assert.equal(cap.check(), true);
  assert.equal(ks.isFired, false);
  clock.advance(1);
  assert.equal(cap.isExpired(), true);
  assert.equal(cap.check(), false);
  assert.equal(ks.isFired, true);
  assert.equal(ks.source, 'lifetime-cap');
  assert.throws(() => new LifetimeCap({ runId: 'x', maxLifetimeMs: 0, killSwitch: ks }), /positive/);
});

test('microvm: spec validation catches bad sizing and bad drives', () => {
  const good = validateMicroVmSpec(defaultMicroVmSpec({ kernelPath: '/k/vmlinux', rootfsPath: '/k/rootfs.ext4' }));
  assert.equal(good.valid, true);
  const bad = validateMicroVmSpec(defaultMicroVmSpec({ kernelPath: '', rootfsPath: '', vcpuCount: 99, memoryMiB: 64 }));
  assert.equal(bad.valid, false);
  assert.match(bad.problems.join(' '), /kernelPath/);
  assert.match(bad.problems.join(' '), /vcpuCount/);
  assert.match(bad.problems.join(' '), /memoryMiB/);
});

test('microvm: dry-run feasible on a KVM host with kernel+rootfs present', () => {
  const spec = defaultMicroVmSpec({ kernelPath: '/k/vmlinux', rootfsPath: '/k/rootfs.ext4' });
  const exists = (p) => p === '/k/vmlinux' || p === '/k/rootfs.ext4';
  const result = dryRunMicroVm(spec, fakeHost(), exists);
  assert.equal(result.feasible, true);
  assert.equal(result.estimatedBootMs, SANDBOX_V2_MICROVM_COLD_BOOT_MS);
  assert.deepEqual(result.blockers, []);
});

test('microvm: dry-run infeasible without KVM, with missing images, oversized guest', () => {
  const spec = defaultMicroVmSpec({ kernelPath: '/k/vmlinux', rootfsPath: '/k/rootfs.ext4', vcpuCount: 8, memoryMiB: 8192 });
  const noKvm = dryRunMicroVm(spec, fakeHost({ kvmAvailable: false }), () => true);
  assert.equal(noKvm.feasible, false);
  assert.match(noKvm.blockers.join(' '), /\/dev\/kvm/);
  assert.match(noKvm.blockers.join(' '), /exceeds host CPU/);

  const missing = dryRunMicroVm(spec, fakeHost(), () => false);
  assert.equal(missing.feasible, false);
  assert.match(missing.blockers.join(' '), /kernel image not found/);
  assert.match(missing.blockers.join(' '), /rootfs image not found/);

  const nonLinux = dryRunMicroVm(spec, fakeHost({ platform: 'darwin', kvmAvailable: false }), () => true);
  assert.equal(nonLinux.feasible, false);
  assert.match(nonLinux.blockers.join(' '), /needs Linux/);
});

test('microvm: snapshot resume is faster than cold boot; config JSON renders', () => {
  const snap = describeMicroVmSnapshot('snap-1');
  assert.ok(snap.estimatedResumeMs < SANDBOX_V2_MICROVM_COLD_BOOT_MS);
  assert.throws(() => describeMicroVmSnapshot(''), /non-empty/);
  const spec = defaultMicroVmSpec({
    kernelPath: '/k/vmlinux',
    rootfsPath: '/k/rootfs.ext4',
    snapshotId: 'snap-1',
    networkHosts: ['registry.npmjs.org'],
  });
  const json = JSON.parse(renderMicroVmConfigJson(spec));
  assert.equal(json['machine-config'].vcpu_count, 1);
  assert.equal(json['boot-source'].kernel_image_path, '/k/vmlinux');
  assert.equal(json.snapshot.snapshot_id, 'snap-1');
  assert.deepEqual(json.network.allow_hosts, ['registry.npmjs.org']);
});

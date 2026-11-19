/**
 * Tests for fleet v28 runtime + profile-scoped secrets (v1.41, Team T6).
 *
 * Covers:
 * - Runtime limits: validation bounds, defaults, partial overrides.
 * - Lifecycle: start/stop/restart, duplicate start refused, invalid
 *   ids refused, saved state on stop, restart restores the snapshot.
 * - Concurrency cap: starts past the cap queue (FIFO), promotion on
 *   stop/evict, queue expiry, queue-full refusal.
 * - Idle eviction: sweepIdle evicts only idle-past-timeout runtimes,
 *   saves state before evicting, writes the eviction ledger, frees
 *   the slot and promotes the queue.
 * - Health probe + auto-restart: healthy probe resets failures; a
 *   failed probe auto-restarts (restarts + 1); failures past
 *   maxRestarts mark the runtime failed and free the slot.
 * - Usage: over-limit flags per resource, aggregate usage.
 * - Secrets: profile isolation (profile B can NEVER read profile
 *   A's secret — get returns undefined, list shows only its own,
 *   redact only touches its own values, leak detection flags a
 *   foreign value in a log line); validation; rotation (version +1,
 *   grace window, prune); redaction (longest-first, short values
 *   skipped); audit ledger carries no values.
 *
 * Imports the BUILT core — build first:
 *   npm run build --workspace=@open-bot/core
 * then: node --test tests/fleet-v28-runtime-secrets.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  FLEET_V28_DEFAULT_RUNTIME_LIMITS,
  FleetV28RuntimeStore,
  resolveFleetV28RuntimeLimits,
  validateFleetV28RuntimeLimits,
} from '../packages/core/dist/fleetV28/runtime.js';
import {
  FLEET_V28_REDACTED_PLACEHOLDER,
  FleetV28SecretStore,
  redactTextWithValues,
  validateFleetV28SecretName,
  validateFleetV28SecretValue,
} from '../packages/core/dist/fleetV28/secrets.js';
import { FLEET_V28_VERSION } from '../packages/core/dist/fleetV28/index.js';

const T0 = Date.UTC(2026, 10, 18, 9, 0, 0);
const MIN = 60 * 1000;

function start(store, conv, profile, opts = {}) {
  return store.startRuntime(conv, profile, { nowMs: T0, ...opts });
}

test('v28 version + default limits', () => {
  assert.equal(FLEET_V28_VERSION, 'v28');
  assert.equal(FLEET_V28_DEFAULT_RUNTIME_LIMITS.cpuCores, 1);
  assert.equal(FLEET_V28_DEFAULT_RUNTIME_LIMITS.ramMB, 2048);
  assert.equal(FLEET_V28_DEFAULT_RUNTIME_LIMITS.diskMB, 5120);
  assert.equal(FLEET_V28_DEFAULT_RUNTIME_LIMITS.maxRestarts, 3);
});

test('runtime limits: validation bounds', () => {
  assert.deepEqual(validateFleetV28RuntimeLimits(FLEET_V28_DEFAULT_RUNTIME_LIMITS), []);
  assert.ok(validateFleetV28RuntimeLimits({ ...FLEET_V28_DEFAULT_RUNTIME_LIMITS, cpuCores: 0 }).length > 0);
  assert.ok(validateFleetV28RuntimeLimits({ ...FLEET_V28_DEFAULT_RUNTIME_LIMITS, cpuCores: 65 }).length > 0);
  assert.ok(validateFleetV28RuntimeLimits({ ...FLEET_V28_DEFAULT_RUNTIME_LIMITS, ramMB: 32 }).length > 0);
  assert.ok(validateFleetV28RuntimeLimits({ ...FLEET_V28_DEFAULT_RUNTIME_LIMITS, diskMB: -1 }).length > 0);
  assert.ok(validateFleetV28RuntimeLimits({ ...FLEET_V28_DEFAULT_RUNTIME_LIMITS, timeoutMs: 999 }).length > 0);
  assert.ok(validateFleetV28RuntimeLimits({ ...FLEET_V28_DEFAULT_RUNTIME_LIMITS, idleTimeoutMs: 0 }).length > 0);
  assert.ok(validateFleetV28RuntimeLimits({ ...FLEET_V28_DEFAULT_RUNTIME_LIMITS, maxRestarts: -1 }).length > 0);
  assert.ok(validateFleetV28RuntimeLimits({ ...FLEET_V28_DEFAULT_RUNTIME_LIMITS, maxRestarts: 1.5 }).length > 0);
  assert.ok(validateFleetV28RuntimeLimits({ ...FLEET_V28_DEFAULT_RUNTIME_LIMITS, maxRestarts: 11 }).length > 0);
  assert.ok(validateFleetV28RuntimeLimits(null).length > 0);
  assert.ok(validateFleetV28RuntimeLimits({ cpuCores: 1 }).length > 0, 'missing fields are refused');
  const merged = resolveFleetV28RuntimeLimits({ cpuCores: 2 });
  assert.equal(merged.cpuCores, 2);
  assert.equal(merged.ramMB, FLEET_V28_DEFAULT_RUNTIME_LIMITS.ramMB);
  assert.equal(merged.timeoutMs, FLEET_V28_DEFAULT_RUNTIME_LIMITS.timeoutMs);
});

test('runtime lifecycle: start/stop/restart, duplicates refused', () => {
  const store = new FleetV28RuntimeStore();
  const started = start(store, 'conv-1', 'profile-a', { botId: 'bot-1' });
  assert.equal(started.ok, true);
  assert.equal(started.status, 'started');
  assert.equal(started.runtime.state, 'running');
  assert.equal(started.runtime.profileId, 'profile-a');
  assert.equal(started.runtime.botId, 'bot-1');
  assert.equal(started.runtime.restarts, 0);
  assert.equal(started.runtime.health, 'unknown');
  assert.deepEqual(started.runtime.usage, { cpuCores: 0, ramMB: 0, diskMB: 0 });

  const dup = start(store, 'conv-1', 'profile-a');
  assert.equal(dup.ok, false);
  assert.equal(dup.status, 'refused');
  assert.ok(dup.reasons.join(' ').includes('already running'));

  const badId = store.startRuntime('', 'profile-a', { nowMs: T0 });
  assert.equal(badId.ok, false);
  const badProfile = store.startRuntime('conv-2', 'has space', { nowMs: T0 });
  assert.equal(badProfile.ok, false);
  const badLimits = store.startRuntime('conv-2', 'profile-a', { nowMs: T0, limits: { cpuCores: 100 } });
  assert.equal(badLimits.ok, false);

  // touch() moves the idle clock; a stopped runtime cannot be touched.
  assert.equal(store.touch('conv-1', T0 + 1000), true);
  assert.equal(store.getRuntime('conv-1')?.lastActivityMs, T0 + 1000);
  assert.equal(store.touch('conv-missing', T0), false);

  const stopped = store.stopRuntime('conv-1', T0 + 2000);
  assert.equal(stopped?.state, 'stopped');
  assert.equal(stopped?.endedAtMs, T0 + 2000);
  assert.ok(stopped?.savedState, 'stop saves a state snapshot');
  const saved = JSON.parse(stopped?.savedState ?? '{}');
  assert.equal(saved.conversationId, 'conv-1');
  assert.equal(saved.profileId, 'profile-a');
  assert.equal(store.touch('conv-1', T0 + 3000), false, 'stopped runtime cannot be touched');

  // Restart revives the stopped runtime and restores the snapshot.
  const restarted = store.restartRuntime('conv-1', T0 + 4000);
  assert.equal(restarted?.state, 'running');
  assert.equal(restarted?.restarts, 1);
  assert.equal(restarted?.savedState, stopped?.savedState, 'snapshot survives restart');
  assert.equal(restarted?.endedAtMs, null);

  // In-place restart of a running runtime bumps restarts, keeps the id.
  const again = store.restartRuntime('conv-1', T0 + 5000);
  assert.equal(again?.state, 'running');
  assert.equal(again?.restarts, 2);

  // Unknown conversations: stop/restart/probe return null.
  assert.equal(store.stopRuntime('conv-missing'), null);
  assert.equal(store.restartRuntime('conv-missing'), null);
  assert.equal(store.probe('conv-missing', true), null);
  assert.equal(store.recordUsage('conv-missing', { cpuCores: 1, ramMB: 1, diskMB: 1 }), null);
});

test('runtime usage: over-limit flags + aggregate', () => {
  const store = new FleetV28RuntimeStore();
  start(store, 'conv-1', 'profile-a', { limits: { cpuCores: 1, ramMB: 1024, diskMB: 2048 } });
  start(store, 'conv-2', 'profile-a');
  const over = store.recordUsage('conv-1', { cpuCores: 1.5, ramMB: 900, diskMB: 3000 }, T0 + 1000);
  assert.deepEqual(over?.overLimit, ['cpu', 'disk']);
  const ok = store.recordUsage('conv-2', { cpuCores: 0.5, ramMB: 512, diskMB: 100 }, T0 + 1000);
  assert.deepEqual(ok?.overLimit, []);
  const agg = store.aggregateUsage();
  assert.equal(agg.running, 2);
  assert.equal(agg.cpuCores, 2);
  assert.equal(agg.ramMB, 1412);
  assert.equal(agg.diskMB, 3100);
  // Tightening limits re-flags usage that is now over.
  const tightened = store.setLimits('conv-2', { ramMB: 100 });
  assert.equal(tightened.ok, true);
  assert.deepEqual(tightened.runtime?.overLimit, ['ram']);
  const bad = store.setLimits('conv-2', { cpuCores: 0 });
  assert.equal(bad.ok, false);
  const missing = store.setLimits('conv-missing', { cpuCores: 1 });
  assert.equal(missing.ok, false);
});

test('runtime concurrency cap: queue, promote, expire, refuse when full', () => {
  const store = new FleetV28RuntimeStore({ maxConcurrentRuntimes: 2, queueMaxLength: 1, queueMaxWaitMs: 10 * MIN });
  assert.equal(start(store, 'conv-1', 'profile-a').status, 'started');
  assert.equal(start(store, 'conv-2', 'profile-a').status, 'started');
  const queued = start(store, 'conv-3', 'profile-a');
  assert.equal(queued.ok, true);
  assert.equal(queued.status, 'queued');
  assert.equal(queued.position, 1);
  assert.equal(store.getRuntime('conv-3'), undefined, 'queued start has no runtime yet');
  assert.equal(store.listQueue().length, 1);
  assert.equal(store.listQueue()[0].conversationId, 'conv-3');

  // Queue is full (max 1): the next start is refused, not queued.
  const refused = start(store, 'conv-4', 'profile-a');
  assert.equal(refused.ok, false);
  assert.equal(refused.status, 'refused');

  // Stopping a runtime promotes the queued start into the freed slot.
  store.stopRuntime('conv-1', T0 + 1000);
  const promoted = store.getRuntime('conv-3');
  assert.equal(promoted?.state, 'running');
  assert.equal(store.listQueue().length, 0);
  assert.equal(store.runningCount(), 2);

  // Queue expiry: a queued start older than queueMaxWaitMs expires.
  const store2 = new FleetV28RuntimeStore({ maxConcurrentRuntimes: 1, queueMaxLength: 4, queueMaxWaitMs: 5 * MIN });
  start(store2, 'conv-a', 'profile-a');
  const q = start(store2, 'conv-b', 'profile-a');
  assert.equal(q.status, 'queued');
  assert.deepEqual(store2.expireQueue(T0 + 6 * MIN), ['conv-b']);
  assert.equal(store2.listQueue().length, 0);
  // queueMaxWaitMs 0 = never expires.
  const store3 = new FleetV28RuntimeStore({ maxConcurrentRuntimes: 1, queueMaxLength: 4, queueMaxWaitMs: 0 });
  start(store3, 'conv-a', 'profile-a');
  start(store3, 'conv-b', 'profile-a');
  assert.deepEqual(store3.expireQueue(T0 + 24 * 60 * MIN), []);

  // Invalid store config is refused at construction.
  assert.throws(() => new FleetV28RuntimeStore({ maxConcurrentRuntimes: 0 }), /maxConcurrentRuntimes/);
  assert.throws(() => new FleetV28RuntimeStore({ queueMaxLength: -1 }), /queueMaxLength/);
});

test('runtime idle eviction: saves state, ledgers, frees slot, promotes queue', () => {
  const store = new FleetV28RuntimeStore({ maxConcurrentRuntimes: 1, queueMaxLength: 2, queueMaxWaitMs: 10 * MIN });
  start(store, 'conv-1', 'profile-a', { limits: { idleTimeoutMs: 5 * MIN } });
  start(store, 'conv-2', 'profile-a', { limits: { idleTimeoutMs: 60 * MIN } });
  // conv-2 queued (cap 1). conv-1 idles 6 min, conv-2 never started.
  store.touch('conv-1', T0);
  const sweep1 = store.sweepIdle(T0 + 4 * MIN);
  assert.deepEqual(sweep1.evicted, [], 'not idle long enough yet');
  const sweep2 = store.sweepIdle(T0 + 6 * MIN);
  assert.deepEqual(sweep2.evicted, ['conv-1']);
  assert.deepEqual(sweep2.promoted, ['conv-2'], 'eviction frees the slot for the queue');
  const evicted = store.getRuntime('conv-1');
  assert.equal(evicted?.state, 'evicted');
  assert.ok(evicted?.savedState, 'eviction saves state first');
  assert.ok(evicted?.failureReason?.includes('idle'));
  const ledger = store.listEvictions();
  assert.equal(ledger.length, 1);
  assert.equal(ledger[0].conversationId, 'conv-1');
  assert.equal(ledger[0].idleMs, 6 * MIN);
  assert.equal(ledger[0].idleTimeoutMs, 5 * MIN);
  assert.equal(ledger[0].stateSaved, true);
  // Restart after eviction with no free slot: queued, not revived.
  const revived = store.restartRuntime('conv-1', T0 + 7 * MIN);
  assert.equal(revived?.state, 'evicted', 'no free slot: restart queues instead of reviving');
  assert.deepEqual(store.listQueue().map((q) => q.conversationId), ['conv-1']);
  store.stopRuntime('conv-2', T0 + 8 * MIN);
  const revived2 = store.restartRuntime('conv-1', T0 + 9 * MIN);
  assert.equal(revived2?.state, 'running');
  assert.equal(revived2?.savedState, evicted?.savedState);
});

test('runtime health probe: auto-restart then failed past maxRestarts', () => {
  const store = new FleetV28RuntimeStore();
  start(store, 'conv-1', 'profile-a', { limits: { maxRestarts: 2 } });
  const healthy = store.probe('conv-1', true, T0 + 1000);
  assert.equal(healthy?.health, 'ok');
  assert.equal(healthy?.consecutiveFailures, 0);
  // One failed probe: degraded + auto-restart, still running.
  const p1 = store.probe('conv-1', false, T0 + 2000);
  assert.equal(p1?.health, 'degraded');
  assert.equal(p1?.state, 'running');
  assert.equal(p1?.restarts, 1);
  assert.equal(p1?.consecutiveFailures, 0, 'auto-restart resets the failure counter');
  // A healthy probe keeps it ok.
  assert.equal(store.probe('conv-1', true, T0 + 3000)?.health, 'ok');
  // maxRestarts 2 is a TOTAL budget: two auto-restarts, then the
  // third consecutive failure marks the runtime failed.
  const f1 = store.probe('conv-1', false, T0 + 4000);
  assert.equal(f1?.restarts, 2, 'second auto-restart (first was above)');
  assert.equal(f1?.state, 'running');
  const f2 = store.probe('conv-1', false, T0 + 5000);
  assert.equal(f2?.state, 'failed');
  assert.equal(f2?.health, 'failed');
  assert.ok(f2?.failureReason?.includes('maxRestarts 2'));
  assert.ok(f2?.savedState, 'failure saves state');
  assert.equal(store.runningCount(), 0, 'failed runtime frees its slot');
  // maxRestarts 0: the first failed probe fails the runtime at once.
  start(store, 'conv-2', 'profile-a', { limits: { maxRestarts: 0 } });
  const failed = store.probe('conv-2', false, T0 + 6000);
  assert.equal(failed?.state, 'failed');
  assert.equal(failed?.health, 'failed');
  assert.ok(failed?.failureReason?.includes('maxRestarts 0'));
  // Probing a stopped runtime is a no-op (state unchanged).
  start(store, 'conv-3', 'profile-a');
  store.stopRuntime('conv-3', T0 + 7000);
  const stoppedProbe = store.probe('conv-3', false, T0 + 8000);
  assert.equal(stoppedProbe?.state, 'stopped');
});

test('runtime list: ordering + profile filter', () => {
  const store = new FleetV28RuntimeStore();
  start(store, 'conv-1', 'profile-a', { nowMs: T0 });
  start(store, 'conv-2', 'profile-b', { nowMs: T0 + 1000 });
  start(store, 'conv-3', 'profile-a', { nowMs: T0 + 2000 });
  store.stopRuntime('conv-2', T0 + 3000);
  const all = store.listRuntimes();
  assert.deepEqual(all.map((r) => r.conversationId), ['conv-3', 'conv-1', 'conv-2'], 'running first, newest first');
  assert.deepEqual(store.listRuntimes('stopped').map((r) => r.conversationId), ['conv-2']);
  assert.deepEqual(store.listRuntimesByProfile('profile-a').map((r) => r.conversationId), ['conv-3', 'conv-1']);
  assert.equal(store.totalCount(), 3);
});

// ---------------------------------------------------------------------------
// Profile-scoped secrets
// ---------------------------------------------------------------------------

test('secret validation: names + values', () => {
  assert.deepEqual(validateFleetV28SecretName('api-key_1'), []);
  assert.ok(validateFleetV28SecretName('1abc').length > 0);
  assert.ok(validateFleetV28SecretName('has space').length > 0);
  assert.ok(validateFleetV28SecretName('').length > 0);
  assert.ok(validateFleetV28SecretName('a'.repeat(65)).length > 0);
  assert.deepEqual(validateFleetV28SecretValue('s3cr3t'), []);
  assert.ok(validateFleetV28SecretValue('').length > 0);
  assert.ok(validateFleetV28SecretValue('x'.repeat(4097)).length > 0);
});

test('secret isolation: profile B can NEVER read profile A secrets', () => {
  const store = new FleetV28SecretStore();
  const set = store.setSecret('profile-a', 'api-key', 'SECRET-AAA-123456', T0);
  assert.equal(set.ok, true);
  assert.equal(set.meta?.version, 1);
  assert.equal(set.meta?.profileId, 'profile-a');
  // Own profile reads it back.
  assert.equal(store.getSecret('profile-a', 'api-key'), 'SECRET-AAA-123456');
  assert.equal(store.hasSecret('profile-a', 'api-key'), true);
  // Another profile: get returns undefined — indistinguishable from "no secret".
  assert.equal(store.getSecret('profile-b', 'api-key'), undefined);
  assert.equal(store.hasSecret('profile-b', 'api-key'), false);
  assert.equal(store.getSecretMeta('profile-b', 'api-key'), undefined);
  // Listings never cross profiles and never carry values.
  const listA = store.listSecrets('profile-a', T0);
  assert.equal(listA.length, 1);
  assert.equal(listA[0].name, 'api-key');
  assert.ok(!('value' in listA[0]), 'list must never include the value');
  assert.deepEqual(store.listSecrets('profile-b', T0), []);
  assert.deepEqual(store.listProfiles(), ['profile-a']);
  // Cross-profile delete/rotate are refused (no such secret for B).
  assert.equal(store.deleteSecret('profile-b', 'api-key', T0), false);
  assert.equal(store.rotateSecret('profile-b', 'api-key', 'SECRET-BBB-999999', { nowMs: T0 }).ok, false);
  assert.equal(store.getSecret('profile-a', 'api-key'), 'SECRET-AAA-123456', 'A secret untouched by B attempts');
  // Same name, different profile: fully independent secrets.
  store.setSecret('profile-b', 'api-key', 'SECRET-BBB-999999', T0);
  assert.equal(store.getSecret('profile-a', 'api-key'), 'SECRET-AAA-123456');
  assert.equal(store.getSecret('profile-b', 'api-key'), 'SECRET-BBB-999999');
  assert.deepEqual(store.listProfiles(), ['profile-a', 'profile-b']);
});

test('secret rotation: version +1, grace window, prune, audit has no values', () => {
  const store = new FleetV28SecretStore();
  store.setSecret('profile-a', 'api-key', 'OLD-VALUE-111111', T0);
  const rotated = store.rotateSecret('profile-a', 'api-key', 'NEW-VALUE-222222', { nowMs: T0 + 1000, graceMs: 5 * MIN });
  assert.equal(rotated.ok, true);
  assert.equal(rotated.meta?.version, 2);
  assert.equal(rotated.meta?.rotatedAtMs, T0 + 1000);
  assert.equal(rotated.meta?.hasGraceValue, true);
  assert.equal(store.getSecret('profile-a', 'api-key'), 'NEW-VALUE-222222');
  // Old value still accepted inside the grace window, then dropped.
  assert.equal(store.acceptsValue('profile-a', 'api-key', 'OLD-VALUE-111111', T0 + 2000), true);
  assert.equal(store.acceptsValue('profile-a', 'api-key', 'NEW-VALUE-222222', T0 + 2000), true);
  assert.equal(store.acceptsValue('profile-a', 'api-key', 'NOPE', T0 + 2000), false);
  assert.equal(store.pruneExpiredGraceValues(T0 + 6 * MIN), 1);
  assert.equal(store.acceptsValue('profile-a', 'api-key', 'OLD-VALUE-111111', T0 + 6 * MIN), false);
  assert.equal(store.pruneExpiredGraceValues(T0 + 7 * MIN), 0);
  // Same-value rotation and unknown secret are refused.
  assert.equal(store.rotateSecret('profile-a', 'api-key', 'NEW-VALUE-222222', { nowMs: T0 + 8000 }).ok, false);
  assert.equal(store.rotateSecret('profile-a', 'missing', 'X-123456', { nowMs: T0 + 8000 }).ok, false);
  // Audit ledger: actions only, values never appear.
  const audit = store.listAudit('profile-a');
  assert.ok(audit.length >= 2);
  assert.equal(audit[0].action, 'rotate');
  assert.equal(audit[0].version, 2);
  const auditJson = JSON.stringify(audit);
  assert.ok(!auditJson.includes('OLD-VALUE-111111'), 'audit must never contain a secret value');
  assert.ok(!auditJson.includes('NEW-VALUE-222222'), 'audit must never contain a secret value');
  // Delete removes it for real.
  assert.equal(store.deleteSecret('profile-a', 'api-key', T0 + 9000), true);
  assert.equal(store.getSecret('profile-a', 'api-key'), undefined);
  assert.equal(store.deleteSecret('profile-a', 'api-key', T0 + 9000), false);
});

test('secret redaction: longest-first, short values skipped, leak detection', () => {
  const store = new FleetV28SecretStore();
  store.setSecret('profile-a', 'token', 'TOKEN-ABC-123456', T0);
  store.setSecret('profile-a', 'token-long', 'TOKEN-ABC-123456-EXTRA', T0);
  store.setSecret('profile-a', 'short', 'abc', T0);
  store.setSecret('profile-b', 'other', 'OTHER-SECRET-999', T0);

  // Redaction replaces the longest match first (no partial leak).
  const r1 = store.redactText('profile-a', 'call with TOKEN-ABC-123456-EXTRA now');
  assert.equal(r1.text, `call with ${FLEET_V28_REDACTED_PLACEHOLDER} now`);
  assert.equal(r1.replaced, 1);
  assert.deepEqual(r1.matchedNames, ['token-long']);
  assert.deepEqual(r1.skippedNames, ['short'], '3-char value is too short to match safely');

  const r2 = store.redactText('profile-a', 'key TOKEN-ABC-123456 and again TOKEN-ABC-123456');
  assert.equal(r2.replaced, 2);
  assert.ok(!r2.text.includes('TOKEN-ABC-123456'));

  // Redacting for profile A never touches profile B values...
  const r3 = store.redactText('profile-a', 'foreign OTHER-SECRET-999 here');
  assert.equal(r3.replaced, 0);
  assert.equal(r3.text, 'foreign OTHER-SECRET-999 here');
  // ...but leak detection flags the foreign value in the line.
  const leak = store.redactAndDetectLeak('profile-a', 'oops OTHER-SECRET-999 leaked');
  assert.deepEqual(leak.foreignHits, ['profile-b:other']);
  const clean = store.redactAndDetectLeak('profile-a', 'clean line, nothing here');
  assert.deepEqual(clean.foreignHits, []);

  // Pure helper: substring values do not leave partial leaks.
  const pure = redactTextWithValues('xx TOKEN-ABC-123456-EXTRA yy', [
    { name: 'a', value: 'TOKEN-ABC-123456' },
    { name: 'b', value: 'TOKEN-ABC-123456-EXTRA' },
  ]);
  assert.equal(pure.text, `xx ${FLEET_V28_REDACTED_PLACEHOLDER} yy`);
  assert.deepEqual(pure.matchedNames, ['b']);
});

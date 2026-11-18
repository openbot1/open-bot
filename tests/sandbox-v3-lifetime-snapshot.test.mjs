/**
 * Tests cho Sandbox v3 — lifetime cap + COW snapshot (v1.35, Đội T2).
 *
 * Run sau khi build core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/sandbox-v3-lifetime-snapshot.test.mjs
 *
 * Lifetime dùng đồng hồ giả (nowMs) nên test không phải chờ thật.
 * Snapshot dùng thư mục tạm thật trên đĩa, dọn sau mỗi test.
 */
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  SANDBOX_V3_DEFAULT_LIFETIME_MS,
  SANDBOX_V3_MAX_LIFETIME_MS,
  SnapshotStore,
  SandboxV3LifetimeCap,
  clampLifetime,
  diffSnapshotEntries,
  effectiveLifetimeMs,
  formatRemainingMs,
  hashBytes,
  hashManifest,
  resolveWithinV3,
  shouldSkipSnapshotPath,
} from '../packages/core/dist/index.js';

const tempDirs = [];
function makeTempDir(prefix = 'open-bot-sandbox-v3-test-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

/** Fake clock: `now.value` moves the time. */
function fakeClock(startMs = 1_000_000) {
  const clock = { value: startMs };
  return { clock, nowMs: () => clock.value };
}

test('lifetime: remaining counts down, expiry is exact', () => {
  const { clock, nowMs } = fakeClock();
  const cap = new SandboxV3LifetimeCap({ lifetimeMs: 60_000, startedAtMs: clock.value, nowMs });
  assert.equal(cap.getDeadlineMs(), 1_060_000);
  assert.equal(cap.remainingMs(), 60_000);
  assert.equal(cap.isExpired(), false);
  assert.equal(cap.mayStartStep(), true);
  clock.value += 59_999;
  assert.equal(cap.isExpired(), false);
  clock.value += 1;
  assert.equal(cap.isExpired(), true);
  assert.equal(cap.remainingMs(), 0);
  assert.equal(cap.mayStartStep(), false);
});

test('lifetime: auto-stop fires for lifetime, grace, then idle', () => {
  const { clock, nowMs } = fakeClock();
  const cap = new SandboxV3LifetimeCap({
    lifetimeMs: 60_000,
    graceMs: 5_000,
    idleTimeoutMs: 10_000,
    startedAtMs: clock.value,
    nowMs,
  });
  assert.equal(cap.evaluateAutoStop(), undefined);
  clock.value += 60_001;
  // A step is in flight: grace window opens, no stop yet.
  assert.equal(cap.evaluateAutoStop(undefined, true), undefined);
  assert.equal(cap.inGrace(), true);
  assert.ok(cap.graceRemainingMs() > 0 && cap.graceRemainingMs() <= 5_000);
  clock.value += 5_001;
  assert.equal(cap.evaluateAutoStop(undefined, true), 'grace-expired');
  assert.equal(cap.isStopped(), true);
  assert.equal(cap.endReason(), 'lifetime-cap');
  // A stopped cap stays stopped.
  assert.equal(cap.evaluateAutoStop(undefined, true), 'grace-expired');

  const { clock: clock2, nowMs: nowMs2 } = fakeClock(2_000_000);
  const idle = new SandboxV3LifetimeCap({
    lifetimeMs: 600_000,
    idleTimeoutMs: 10_000,
    startedAtMs: clock2.value,
    nowMs: nowMs2,
  });
  clock2.value += 9_999;
  assert.equal(idle.evaluateAutoStop(), undefined);
  clock2.value += 1;
  assert.equal(idle.evaluateAutoStop(), 'idle-timeout');
  assert.equal(idle.endReason(), 'auto-stopped');

  const { clock: clock3, nowMs: nowMs3 } = fakeClock(3_000_000);
  const noIdle = new SandboxV3LifetimeCap({
    lifetimeMs: 600_000,
    idleTimeoutMs: 0,
    startedAtMs: clock3.value,
    nowMs: nowMs3,
  });
  clock3.value += 3_600_000;
  assert.equal(noIdle.isIdleExpired(), false);
});

test('lifetime: heartbeat resets idle; shorten works; extend past max is refused', () => {
  const { clock, nowMs } = fakeClock();
  const cap = new SandboxV3LifetimeCap({
    lifetimeMs: 60_000,
    idleTimeoutMs: 10_000,
    startedAtMs: clock.value,
    nowMs,
  });
  clock.value += 9_000;
  cap.heartbeat();
  assert.equal(cap.idleMs(), 0);
  clock.value += 9_000;
  assert.equal(cap.isIdleExpired(), false);
  const shortened = cap.setLifetime(30_000, 'operator');
  assert.equal(shortened, 1_030_000);
  assert.equal(cap.getDeadlineMs(), 1_030_000);
  // Extending is allowed, but never past the hard maximum: a huge
  // request clamps to exactly the max lifetime from session start.
  const extended = cap.setLifetime(SANDBOX_V3_MAX_LIFETIME_MS + 60_000, 'greedy');
  assert.equal(extended, 1_000_000 + SANDBOX_V3_MAX_LIFETIME_MS);
  assert.equal(cap.getDeadlineMs(), 1_000_000 + SANDBOX_V3_MAX_LIFETIME_MS);
  assert.ok(cap.lifetimeEvents().length >= 3);
  assert.equal(cap.manualStop(), 'manual');
  assert.equal(cap.endReason(), 'killed');
  assert.equal(cap.describe().stopped, true);
});

test('lifetime: pure helpers clamp, format and pick the effective lifetime', () => {
  assert.equal(clampLifetime(0), 60_000);
  assert.equal(clampLifetime(-5), 60_000);
  assert.equal(clampLifetime(SANDBOX_V3_MAX_LIFETIME_MS * 2), SANDBOX_V3_MAX_LIFETIME_MS);
  assert.equal(clampLifetime(120_000), 120_000);
  assert.equal(formatRemainingMs(0), 'expired');
  assert.equal(formatRemainingMs(-1), 'expired');
  assert.equal(formatRemainingMs(45_000), '45s');
  assert.equal(formatRemainingMs(90_000), '1m 30s');
  assert.equal(formatRemainingMs(3_700_000), '1h 1m');
  assert.equal(effectiveLifetimeMs(600_000, 60_000), 60_000);
  assert.equal(effectiveLifetimeMs(60_000, 600_000), 60_000);
  assert.equal(SANDBOX_V3_DEFAULT_LIFETIME_MS, 30 * 60 * 1000);
});

test('snapshot: capture + restore returns the workspace to the snapshot state', () => {
  const base = makeTempDir();
  const workdir = path.join(base, 'work');
  fs.mkdirSync(path.join(workdir, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(workdir, 'a.txt'), 'hello');
  fs.writeFileSync(path.join(workdir, 'sub', 'b.txt'), 'world');
  const store = new SnapshotStore({ baseDir: path.join(base, 'snaps') });
  const snap = store.capture('sess-1', workdir, 'before-edit');
  assert.equal(snap.sessionId, 'sess-1');
  assert.equal(snap.fileCount, 2);
  assert.equal(snap.totalBytes, 10);
  assert.equal(snap.label, 'before-edit');
  assert.match(snap.manifestHash, /^[0-9a-f]{64}$/);
  assert.equal(store.verifySnapshot('sess-1', snap.id), true);

  // Mutate: change a file, add one, delete one.
  fs.writeFileSync(path.join(workdir, 'a.txt'), 'CHANGED');
  fs.writeFileSync(path.join(workdir, 'new.txt'), 'new file');
  fs.rmSync(path.join(workdir, 'sub', 'b.txt'));
  const result = store.restore('sess-1', snap.id, workdir);
  assert.equal(result.restoredFiles, 2);
  assert.equal(result.deletedFiles, 1);
  assert.equal(result.failures.length, 0);
  assert.equal(fs.readFileSync(path.join(workdir, 'a.txt'), 'utf8'), 'hello');
  assert.equal(fs.readFileSync(path.join(workdir, 'sub', 'b.txt'), 'utf8'), 'world');
  assert.equal(fs.existsSync(path.join(workdir, 'new.txt')), false);
});

test('snapshot: tampered manifest fails verification and refuses restore', () => {
  const base = makeTempDir();
  const workdir = path.join(base, 'work');
  fs.mkdirSync(workdir, { recursive: true });
  fs.writeFileSync(path.join(workdir, 'a.txt'), 'hello');
  const store = new SnapshotStore({ baseDir: path.join(base, 'snaps') });
  const snap = store.capture('sess-1', workdir, 'v1');
  const manifestPath = path.join(base, 'snaps', 'sess-1', snap.id, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.entries[0].contentHash = '0'.repeat(64);
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  assert.equal(store.verifySnapshot('sess-1', snap.id), false);
  assert.throws(() => store.restore('sess-1', snap.id, workdir), /integrity check/);
});

test('snapshot: diff, prune, list and tombstones', () => {
  const base = makeTempDir();
  const workdir = path.join(base, 'work');
  fs.mkdirSync(workdir, { recursive: true });
  fs.writeFileSync(path.join(workdir, 'a.txt'), 'one');
  fs.writeFileSync(path.join(workdir, 'b.txt'), 'two');
  const store = new SnapshotStore({ baseDir: path.join(base, 'snaps') });
  const first = store.capture('sess-1', workdir, 'v1');
  fs.writeFileSync(path.join(workdir, 'a.txt'), 'ONE-changed');
  fs.rmSync(path.join(workdir, 'b.txt'));
  fs.writeFileSync(path.join(workdir, 'c.txt'), 'three');
  const second = store.capture('sess-1', workdir, 'v2', ['b.txt']);
  const diff = store.diffSnapshots('sess-1', first.id, second.id);
  assert.deepEqual(diff.added, ['c.txt']);
  assert.deepEqual(diff.removed, ['b.txt']);
  assert.deepEqual(diff.modified, ['a.txt']);
  assert.deepEqual(diff.unchanged, []);
  assert.equal(store.listSnapshots('sess-1').length, 2);
  assert.equal(store.listSnapshots('sess-1')[0].id, first.id);
  assert.equal(store.listSnapshots('no-such-session').length, 0);
  const pruned = store.prune('sess-1', 1);
  assert.deepEqual(pruned, [first.id]);
  assert.equal(store.listSnapshots('sess-1').length, 1);
  assert.equal(store.deleteSnapshot('sess-1', second.id), true);
  assert.equal(store.deleteSnapshot('sess-1', second.id), false);
  assert.throws(() => store.capture('sess-1', path.join(base, 'missing'), 'x'), /does not exist/);
});

test('snapshot: pure helpers — hashing, path safety, skip rules, diff', () => {
  assert.equal(hashBytes(Buffer.from('abc')), hashBytes(Buffer.from('abc')));
  assert.notEqual(hashBytes(Buffer.from('abc')), hashBytes(Buffer.from('abd')));
  assert.match(hashBytes(Buffer.from('')), /^[0-9a-f]{64}$/);
  assert.equal(hashManifest([]), hashBytes(Buffer.from('[]')));
  const root = makeTempDir();
  assert.ok(resolveWithinV3(root, 'a/b.txt')?.endsWith(path.join('a', 'b.txt')));
  assert.equal(resolveWithinV3(root, '../escape.txt'), undefined);
  assert.equal(resolveWithinV3(root, '../../etc/passwd'), undefined);
  assert.equal(shouldSkipSnapshotPath('node_modules/x.js'), true);
  assert.equal(shouldSkipSnapshotPath('.git/config'), true);
  assert.equal(shouldSkipSnapshotPath('src/index.ts'), false);
  assert.equal(shouldSkipSnapshotPath('a.sock'), true);
  const diff = diffSnapshotEntries(
    [{ path: 'a.txt', kind: 'file', sizeBytes: 1, contentHash: 'aa', mtimeMs: 1 }],
    [{ path: 'a.txt', kind: 'file', sizeBytes: 1, contentHash: 'bb', mtimeMs: 2 }],
  );
  assert.deepEqual(diff.modified, ['a.txt']);
  assert.deepEqual(diff.added, []);
});

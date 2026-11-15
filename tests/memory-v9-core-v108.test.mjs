/**
 * Tests for v1.08 (Team T1) — memory v9 core:
 * packages/core/src/memory/v9/{types,sleepAgent,versioning,sharedRegistry}.ts
 *
 * Covers: policy defaults + normalize/clamp + quiet hours; line diff
 * (LCS) + hunks; version store (snapshot/history/diff/rollback, incl.
 * rollback-twice and unknown-version errors); sleep daemon (policy
 * store, status, dry-run job, real job with fact extraction,
 * session-end trigger gating + queue drain via tick, cancel queued
 * job, quiet-hours + daily-budget gating, run-log counting); shared
 * registry (register/ACL/grant/revoke, write happy path, stale-base
 * conflict + resolve keep-theirs/keep-mine/merged, forbidden +
 * not-registered, sync + seenSeq, unregister).
 *
 * Run after building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/memory-v9-core-v108.test.mjs
 *
 * No network. No model. Real git CLI is used by the v7 projection
 * (falls back to history.jsonl when git is unavailable).
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  GitMemoryProjection,
  MemoryV9VersionStore,
  SharedBlockRegistry,
  SleepV9Agent,
  V6RecordStore,
  V9SleepPolicyStore,
  countV9SleepRunsToday,
  defaultV9SleepPolicy,
  groupDiffHunks,
  isInV9QuietHours,
  lineDiff,
  normalizeV9SleepPolicy,
  readV9SleepRunLog,
  V9Error,
} from '../packages/core/dist/index.js';

const tempDirs = [];
function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-memv9-core-v108-'));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function seedBlock(projection, label, content) {
  return projection.create(
    { label, content, description: `block ${label} cho test v9`, tier: 'working', scope: 'user' },
    'user',
  );
}

function seedRecord(store, text) {
  return store.append({
    kind: 'fact',
    text,
    entities: [],
    tags: [],
    confidence: 0.9,
    scope: { userId: 'u1', agentId: '', runId: '', appId: '' },
    source: { type: 'user', ref: 'chat:1' },
  });
}

/* ------------------------------------------------------------------ */
/* Policy                                                             */
/* ------------------------------------------------------------------ */

test('policy: defaults are safe (disabled, session-end+idle on, scheduled off, no quiet hours)', () => {
  const policy = defaultV9SleepPolicy();
  assert.equal(policy.enabled, false);
  assert.equal(policy.triggers.sessionEnd, true);
  assert.equal(policy.triggers.idle, true);
  assert.equal(policy.triggers.scheduled, false);
  assert.equal(policy.scheduledHour, null);
  assert.equal(policy.quietHours.startHour, 0);
  assert.equal(policy.quietHours.endHour, 0);
  assert.equal(policy.steps.consolidateV8, true);
  assert.equal(policy.steps.extractFacts, true);
  assert.equal(policy.steps.snapshotBlocks, true);
  assert.ok(policy.maxJobMs > 0);
});

test('policy: normalize clamps out-of-range values instead of throwing', () => {
  const policy = normalizeV9SleepPolicy({
    idleMs: -5,
    sessionMinTurns: 99999,
    scheduledHour: 25,
    scheduledMinute: 99,
    quietHours: { startHour: -1, endHour: 30 },
    maxRunsPerDay: -2,
    maxJobMs: 10,
  });
  assert.equal(policy.idleMs, 0);
  assert.equal(policy.sessionMinTurns, 1000);
  assert.equal(policy.scheduledHour, 23);
  assert.equal(policy.scheduledMinute, 59);
  assert.equal(policy.quietHours.startHour, 0);
  assert.equal(policy.quietHours.endHour, 23);
  assert.equal(policy.maxRunsPerDay, 0);
  assert.equal(policy.maxJobMs, 1000);
  const scheduledOff = normalizeV9SleepPolicy({ scheduledHour: null });
  assert.equal(scheduledOff.scheduledHour, null);
});

test('policy: quiet hours — same start/end means off, overnight window works', () => {
  const off = normalizeV9SleepPolicy({ quietHours: { startHour: 0, endHour: 0 } });
  assert.equal(isInV9QuietHours(off, new Date(2026, 10, 15, 3, 0, 0)), false);
  const night = normalizeV9SleepPolicy({ quietHours: { startHour: 22, endHour: 6 } });
  assert.equal(isInV9QuietHours(night, new Date(2026, 10, 15, 23, 30, 0)), true);
  assert.equal(isInV9QuietHours(night, new Date(2026, 10, 15, 3, 0, 0)), true);
  assert.equal(isInV9QuietHours(night, new Date(2026, 10, 15, 12, 0, 0)), false);
  const day = normalizeV9SleepPolicy({ quietHours: { startHour: 9, endHour: 17 } });
  assert.equal(isInV9QuietHours(day, new Date(2026, 10, 15, 10, 0, 0)), true);
  assert.equal(isInV9QuietHours(day, new Date(2026, 10, 15, 18, 0, 0)), false);
});

test('policy store: in-memory get/set round-trip, file store persists', () => {
  const mem = V9SleepPolicyStore.inMemory();
  assert.equal(mem.get().enabled, false);
  const next = mem.set({ enabled: true, idleMs: 12345 });
  assert.equal(next.enabled, true);
  assert.equal(next.idleMs, 12345);
  assert.equal(mem.get().idleMs, 12345);

  const dir = makeTempDir();
  const file = V9SleepPolicyStore.fromWorkspace(dir);
  file.set({ enabled: true, maxRunsPerDay: 3 });
  const reloaded = V9SleepPolicyStore.fromWorkspace(dir);
  assert.equal(reloaded.get().enabled, true);
  assert.equal(reloaded.get().maxRunsPerDay, 3);
  assert.ok(fs.existsSync(path.join(dir, '.open-bot', 'memory-v9-sleep-policy.json')));
});

/* ------------------------------------------------------------------ */
/* Line diff                                                          */
/* ------------------------------------------------------------------ */

test('lineDiff: identical texts produce no changes; add/remove/change counted', () => {
  const same = lineDiff('a\nb\nc', 'a\nb\nc');
  assert.equal(same.filter((l) => l.type !== ' ').length, 0);
  assert.equal(groupDiffHunks(same).length, 0);

  const changed = lineDiff('a\nb\nc\nd', 'a\nB\nc\ne\nf');
  assert.equal(changed.filter((l) => l.type === '+').length, 3);
  assert.equal(changed.filter((l) => l.type === '-').length, 2);
  const hunks = groupDiffHunks(changed);
  assert.equal(hunks.length, 1);
  assert.ok(hunks[0].lines.some((l) => l.type === '+' && l.text === 'B'));
  assert.ok(hunks[0].lines.some((l) => l.type === '-' && l.text === 'b'));
  assert.ok(hunks[0].lines.some((l) => l.type === ' ' && l.text === 'a'));

  const added = lineDiff('', 'x\ny');
  assert.equal(added.filter((l) => l.type === '+').length, 2);
  const removed = lineDiff('x\ny', '');
  assert.equal(removed.filter((l) => l.type === '-').length, 2);
});

test('lineDiff: distant changes split into separate hunks', () => {
  const oldLines = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`);
  const newLines = [...oldLines];
  newLines[1] = 'CHANGED 2';
  newLines[28] = 'CHANGED 29';
  const hunks = groupDiffHunks(lineDiff(oldLines.join('\n'), newLines.join('\n')));
  assert.equal(hunks.length, 2);
  assert.ok(hunks[0].lines.some((l) => l.text === 'CHANGED 2'));
  assert.ok(hunks[1].lines.some((l) => l.text === 'CHANGED 29'));
});

/* ------------------------------------------------------------------ */
/* Version store                                                      */
/* ------------------------------------------------------------------ */

test('versioning: snapshot/history/diff/rollback round-trip', () => {
  const dir = makeTempDir();
  const projection = new GitMemoryProjection(dir);
  const store = new MemoryV9VersionStore(dir, { projection });
  const block = seedBlock(projection, 'notes-v9', 'dòng một\ndòng hai');
  assert.equal(block.version, 1);

  const snap1 = store.snapshot('notes-v9', 'trước khi sửa', 'user');
  assert.equal(snap1.version, 1);
  assert.equal(snap1.note, 'trước khi sửa');
  assert.ok(snap1.contentHash.length === 64);
  assert.equal(snap1.content, 'dòng một\ndòng hai');

  projection.update('notes-v9', { content: 'dòng một\ndòng HAI mới\ndòng ba' }, 'user');
  const snap2 = store.snapshot('notes-v9', 'sau khi sửa', 'user');
  assert.equal(snap2.version, 2);

  const history = store.history('notes-v9');
  assert.ok(history.length >= 2);
  assert.equal(history[0].version, 2);
  assert.ok(history.some((h) => h.source === 'snapshot' && h.version === 1));

  const diff = store.diff('notes-v9', 1, 2);
  assert.equal(diff.fromVersion, 1);
  assert.equal(diff.toVersion, 2);
  assert.equal(diff.addedLines, 2);
  assert.equal(diff.removedLines, 1);
  assert.ok(diff.hunks.length >= 1);

  const same = store.diff('notes-v9', 2, 2);
  assert.equal(same.addedLines, 0);
  assert.equal(same.removedLines, 0);
  assert.equal(same.hunks.length, 0);

  const report = store.rollback('notes-v9', 1, 'user');
  assert.equal(report.changed, true);
  assert.equal(report.toVersion, 1);
  assert.equal(report.newVersion, 3);
  assert.ok(report.snapshotId);
  assert.equal(projection.get('notes-v9').content, 'dòng một\ndòng hai');

  // Rollback lần nữa về cùng nội dung -> changed=false, không tạo version mới.
  const again = store.rollback('notes-v9', 1, 'user');
  assert.equal(again.changed, false);
  assert.equal(again.newVersion, 3);
  assert.equal(projection.get('notes-v9').version, 3);
});

test('versioning: errors — snapshot/diff/rollback on missing block or version', () => {
  const dir = makeTempDir();
  const store = new MemoryV9VersionStore(dir);
  assert.throws(() => store.snapshot('khong-co', '', 'user'), V9Error);
  assert.throws(() => store.history('khong-co'), V9Error);
  assert.throws(() => store.rollback('khong-co', 1, 'user'), V9Error);

  const projection = new GitMemoryProjection(dir);
  seedBlock(projection, 'only-v9', 'nội dung');
  assert.throws(() => store.diff('only-v9', 99), V9Error);
  assert.throws(() => store.rollback('only-v9', 99, 'user'), V9Error);
  assert.equal(store.contentAtVersion('only-v9', 99), null);
});

test('versioning: snapshot pruning keeps newest 30 per block', () => {
  const dir = makeTempDir();
  const projection = new GitMemoryProjection(dir);
  const store = new MemoryV9VersionStore(dir, { projection });
  seedBlock(projection, 'prune-v9', 'v1');
  for (let i = 0; i < 35; i += 1) {
    store.snapshot('prune-v9', `snap ${i}`, 'user');
  }
  const snaps = store.snapshots('prune-v9');
  assert.equal(snaps.length, 30);
  assert.equal(snaps[0].note, 'snap 34');
});

/* ------------------------------------------------------------------ */
/* Sleep daemon                                                       */
/* ------------------------------------------------------------------ */

function makeAgent(dir, policyPatch = {}) {
  const agent = new SleepV9Agent({
    workspaceDir: dir,
    botId: 'bot-a',
    policyStore: V9SleepPolicyStore.inMemory(),
  });
  agent.setPolicy({ enabled: true, cooldownMs: 0, maxRunsPerDay: 0, ...policyPatch });
  return agent;
}

test('sleep daemon: status defaults + start/stop', () => {
  const dir = makeTempDir();
  const agent = new SleepV9Agent({ workspaceDir: dir, botId: 'bot-a', policyStore: V9SleepPolicyStore.inMemory() });
  const status = agent.getStatus();
  assert.equal(status.enabled, false);
  assert.equal(status.started, false);
  assert.equal(status.runningJobId, null);
  assert.equal(status.queuedJobs, 0);
  assert.equal(status.runsToday, 0);
  assert.equal(status.lastRun, null);
  assert.equal(status.nextScheduledRunAt, null);

  agent.start();
  assert.equal(agent.started, true);
  agent.start(); // gọi lại không tạo thêm timer
  assert.equal(agent.started, true);
  agent.stop();
  assert.equal(agent.started, false);
});

test('sleep daemon: nextScheduledRunAt honours the scheduled trigger', () => {
  const dir = makeTempDir();
  const agent = makeAgent(dir, { triggers: { sessionEnd: true, idle: true, scheduled: true }, scheduledHour: 3, scheduledMinute: 30 });
  const next = agent.nextScheduledRunAt();
  assert.ok(next);
  const d = new Date(next);
  assert.equal(d.getHours(), 3);
  assert.equal(d.getMinutes(), 30);
  assert.ok(d.getTime() > Date.now());

  const agent2 = makeAgent(dir, { triggers: { sessionEnd: true, idle: true, scheduled: false }, scheduledHour: 3 });
  assert.equal(agent2.nextScheduledRunAt(), null);
});

test('sleep daemon: dry-run job runs v8 consolidation without writing snapshots', async () => {
  const dir = makeTempDir();
  const store = V6RecordStore.fromWorkspace(dir);
  seedRecord(store, 'Huy thích ăn phở ở Hà Nội mỗi sáng.');
  seedRecord(store, 'Huy sống ở Hà Nội từ năm 2020.');
  const agent = new SleepV9Agent({
    workspaceDir: dir,
    botId: 'bot-a',
    store,
    policyStore: V9SleepPolicyStore.inMemory(),
  });
  agent.setPolicy({ enabled: true, cooldownMs: 0, maxRunsPerDay: 0 });
  const job = await agent.runJobNow({ trigger: 'manual', dryRun: true });
  assert.ok(job);
  assert.equal(job.status, 'done');
  assert.equal(job.dryRun, true);
  assert.ok(job.durationMs !== undefined && job.durationMs >= 0);
  assert.ok(job.steps.some((s) => s.step === 'consolidate-v8'));
  assert.ok(job.counts.recordsExamined >= 2);
  // Dry-run không ghi snapshot, không tính vào số lần chạy trong ngày.
  assert.equal(job.counts.snapshotsCreated, 0);
  assert.equal(countV9SleepRunsToday(dir), 0);
  const log = readV9SleepRunLog(dir);
  assert.equal(log.length, 1);
  assert.equal(log[0].id, job.id);
  assert.equal(log[0].dryRun, true);
});

test('sleep daemon: real job extracts facts from episodes + counts as a run today', async () => {
  const dir = makeTempDir();
  const store = V6RecordStore.fromWorkspace(dir);
  seedRecord(store, 'Huy thích ăn phở ở Hà Nội mỗi sáng.');
  const agent = new SleepV9Agent({
    workspaceDir: dir,
    botId: 'bot-a',
    store,
    policyStore: V9SleepPolicyStore.inMemory(),
  });
  agent.setPolicy({ enabled: true, cooldownMs: 0, maxRunsPerDay: 0 });
  const episodes = [
    { id: 'ep-1', role: 'user', text: 'My name is Huy. I live in Ha Noi.', at: new Date().toISOString() },
    { id: 'ep-2', role: 'user', text: 'Tôi rất thích ăn phở.', at: new Date().toISOString() },
  ];
  const job = await agent.runJobNow({ trigger: 'manual', episodes });
  assert.ok(job);
  assert.equal(job.status, 'done');
  assert.equal(job.dryRun, false);
  assert.ok(job.counts.factsExtracted >= 2, `expected >=2 facts, got ${job.counts.factsExtracted}`);
  assert.ok(job.counts.factsStored >= 2);
  assert.ok(job.steps.some((s) => s.step === 'extract-facts' && s.ok));
  assert.equal(countV9SleepRunsToday(dir), 1);
  assert.equal(agent.getStatus().runsToday, 1);
  assert.equal(agent.getStatus().lastRun.id, job.id);
});

test('sleep daemon: session-end queues a job only when the session qualifies', async () => {
  const dir = makeTempDir();
  const agent = makeAgent(dir, { sessionMinTurns: 3, sessionMinMinutes: 0 });
  agent.noteSessionStart('sess-1');
  agent.noteTurn('sess-1', 'user', 'xin chào');
  agent.noteTurn('sess-1', 'bot', 'chào Huy');
  // Chưa đủ turn -> không xếp job.
  const short = agent.noteSessionEnd('sess-1');
  assert.equal(short.queued, false);
  assert.match(short.reason, /turn/);

  agent.noteSessionStart('sess-2');
  for (let i = 0; i < 4; i += 1) agent.noteTurn('sess-2', 'user', `turn ${i} tôi thích phở`);
  const queued = agent.noteSessionEnd('sess-2');
  assert.equal(queued.queued, true);
  assert.ok(queued.jobId);
  assert.equal(agent.queuedCount, 1);

  // tick() xả hàng đợi và chạy job session-end.
  const ran = await agent.tick();
  assert.ok(ran);
  assert.equal(ran.trigger, 'session-end');
  assert.equal(ran.status, 'done');
  assert.equal(agent.queuedCount, 0);
  assert.equal(countV9SleepRunsToday(dir), 1);
  agent.stop();
});

test('sleep daemon: cancelQueuedJob removes a queued job and logs it cancelled', () => {
  const dir = makeTempDir();
  const agent = makeAgent(dir, { sessionMinTurns: 1, sessionMinMinutes: 0 });
  agent.noteSessionStart('sess-x');
  agent.noteTurn('sess-x', 'user', 'hello');
  const queued = agent.noteSessionEnd('sess-x');
  assert.equal(queued.queued, true);
  assert.equal(agent.cancelQueuedJob(queued.jobId), true);
  assert.equal(agent.queuedCount, 0);
  assert.equal(agent.cancelQueuedJob(queued.jobId), false);
  const log = readV9SleepRunLog(dir);
  assert.equal(log.length, 1);
  assert.equal(log[0].status, 'cancelled');
  agent.stop();
});

test('sleep daemon: tick does nothing when disabled or in quiet hours', async () => {
  const dir = makeTempDir();
  const off = new SleepV9Agent({ workspaceDir: dir, botId: 'bot-a', policyStore: V9SleepPolicyStore.inMemory() });
  assert.equal(await off.tick(), null);

  const now = new Date();
  const quiet = makeAgent(dir, {
    idleMs: 0,
    quietHours: { startHour: now.getHours(), endHour: (now.getHours() + 1) % 24 },
  });
  quiet.noteActivity();
  assert.equal(await quiet.tick(now), null);
  quiet.stop();
});

test('sleep daemon: idle trigger fires when idle long enough', async () => {
  const dir = makeTempDir();
  const agent = makeAgent(dir, { idleMs: 0, triggers: { sessionEnd: false, idle: true, scheduled: false } });
  const ran = await agent.tick();
  assert.ok(ran);
  assert.equal(ran.trigger, 'idle');
  assert.equal(ran.status, 'done');
  agent.stop();
});

test('sleep daemon: runJobNow refuses a second concurrent job', async () => {
  const dir = makeTempDir();
  const agent = makeAgent(dir);
  const first = agent.runJobNow({ trigger: 'manual' });
  const second = await agent.runJobNow({ trigger: 'manual' });
  assert.equal(second, null);
  const done = await first;
  assert.ok(done);
  assert.equal(done.status, 'done');
  agent.stop();
});

/* ------------------------------------------------------------------ */
/* Shared-block registry                                              */
/* ------------------------------------------------------------------ */

test('shared registry: register + ACL + listForBot', () => {
  const dir = makeTempDir();
  const projection = new GitMemoryProjection(dir);
  seedBlock(projection, 'team-notes', 'ghi chú chung');
  const registry = new SharedBlockRegistry(dir, { projection });

  const entry = registry.register('team-notes', 'bot-a', {
    description: 'Ghi chú của team',
    grants: [
      { botId: 'bot-b', role: 'write' },
      { botId: 'bot-c', role: 'read' },
    ],
  });
  assert.equal(entry.label, 'team-notes');
  assert.equal(entry.ownerBotId, 'bot-a');
  assert.equal(entry.version, 1);
  assert.equal(registry.roleOf(entry, 'bot-a'), 'admin');
  assert.equal(registry.roleOf(entry, 'bot-b'), 'write');
  assert.equal(registry.roleOf(entry, 'bot-c'), 'read');
  assert.equal(registry.roleOf(entry, 'bot-z'), null);
  assert.equal(registry.hasRole(entry, 'bot-b', 'write'), true);
  assert.equal(registry.hasRole(entry, 'bot-c', 'write'), false);
  assert.equal(registry.hasRole(entry, 'bot-a', 'admin'), true);

  assert.throws(() => registry.register('team-notes', 'bot-a'), V9Error);
  assert.throws(() => registry.register('khong-co', 'bot-a'), V9Error);

  const visibleB = registry.listForBot('bot-b');
  assert.equal(visibleB.length, 1);
  assert.equal(visibleB[0].role, 'write');
  assert.equal(registry.listForBot('bot-z').length, 0);
});

test('shared registry: grant/revoke rules (only admin, owner immutable)', () => {
  const dir = makeTempDir();
  const projection = new GitMemoryProjection(dir);
  seedBlock(projection, 'acl-block', 'x');
  const registry = new SharedBlockRegistry(dir, { projection });
  registry.register('acl-block', 'bot-a', { grants: [{ botId: 'bot-b', role: 'read' }] });

  const granted = registry.grant('acl-block', 'bot-d', 'write', 'bot-a');
  assert.equal(registry.roleOf(granted, 'bot-d'), 'write');
  assert.throws(() => registry.grant('acl-block', 'bot-e', 'write', 'bot-b'), V9Error);
  assert.throws(() => registry.grant('acl-block', 'bot-a', 'read', 'bot-a'), V9Error);
  assert.throws(() => registry.revoke('acl-block', 'bot-a', 'bot-a'), V9Error);
  assert.equal(registry.revoke('acl-block', 'bot-d', 'bot-a'), true);
  assert.equal(registry.roleOf(registry.get('acl-block'), 'bot-d'), null);
  assert.equal(registry.revoke('acl-block', 'bot-d', 'bot-a'), false);
});

test('shared registry: write happy path + sync + seenSeq', () => {
  const dir = makeTempDir();
  const projection = new GitMemoryProjection(dir);
  seedBlock(projection, 'sync-block', 'v1 content');
  const registry = new SharedBlockRegistry(dir, { projection });
  registry.register('sync-block', 'bot-a', { grants: [{ botId: 'bot-b', role: 'write' }, { botId: 'bot-c', role: 'read' }] });

  const written = registry.write('sync-block', 'bot-b', 'v2 content by bot-b', 1, 'cập nhật lần 1');
  assert.equal(written.ok, true);
  assert.equal(written.outcome, 'written');
  assert.equal(written.newVersion, 2);
  assert.equal(written.changeSeq, 1);
  assert.equal(projection.get('sync-block').content, 'v2 content by bot-b');

  const status = registry.syncStatus('sync-block');
  assert.equal(status.version, 2);
  assert.equal(status.versionVector['bot-b'], 2);
  assert.equal(status.pendingConflicts, 0);

  const syncC = registry.sync('sync-block', 'bot-c', 0);
  assert.equal(syncC.changes.length, 1);
  assert.equal(syncC.changes[0].newVersion, 2);
  assert.equal(syncC.seenSeq, 1);
  const syncAgain = registry.sync('sync-block', 'bot-c', 1);
  assert.equal(syncAgain.changes.length, 0);

  assert.throws(() => registry.sync('sync-block', 'bot-z', 0), V9Error);
});

test('shared registry: stale baseVersion creates a conflict, never overwrites', () => {
  const dir = makeTempDir();
  const projection = new GitMemoryProjection(dir);
  seedBlock(projection, 'conf-block', 'gốc');
  const registry = new SharedBlockRegistry(dir, { projection });
  registry.register('conf-block', 'bot-a', { grants: [{ botId: 'bot-b', role: 'write' }, { botId: 'bot-c', role: 'write' }] });

  const first = registry.write('conf-block', 'bot-b', 'bot-b sửa', 1, 'b sửa');
  assert.equal(first.ok, true);
  assert.equal(first.newVersion, 2);

  // bot-c vẫn dựa trên v1 -> xung đột, nội dung không bị ghi đè.
  const conflicted = registry.write('conf-block', 'bot-c', 'bot-c sửa', 1, 'c sửa');
  assert.equal(conflicted.ok, false);
  assert.equal(conflicted.outcome, 'conflict');
  assert.ok(conflicted.conflictId);
  assert.equal(projection.get('conf-block').content, 'bot-b sửa');

  const conflicts = registry.listConflicts('conf-block', 'pending');
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].writerBotId, 'bot-c');
  assert.equal(conflicts[0].baseVersion, 1);
  assert.equal(conflicts[0].localVersion, 2);
  assert.equal(registry.syncStatus('conf-block').pendingConflicts, 1);
});

test('shared registry: resolve keep-theirs / keep-mine / merged', () => {
  const dir = makeTempDir();
  const projection = new GitMemoryProjection(dir);
  seedBlock(projection, 'res-block', 'gốc');
  const registry = new SharedBlockRegistry(dir, { projection });
  registry.register('res-block', 'bot-a', { grants: [{ botId: 'bot-b', role: 'write' }, { botId: 'bot-c', role: 'write' }] });

  // keep-theirs: nội dung writer được ghi thành version mới.
  registry.write('res-block', 'bot-b', 'bản của b', 1, '');
  const c1 = registry.write('res-block', 'bot-c', 'bản của c', 1, '');
  const resolvedTheirs = registry.resolveConflict(c1.conflictId, 'keep-theirs', 'bot-a');
  assert.equal(resolvedTheirs.status, 'resolved');
  assert.equal(resolvedTheirs.resolution, 'keep-theirs');
  assert.equal(projection.get('res-block').content, 'bản của c');
  assert.equal(registry.listConflicts('res-block', 'pending').length, 0);

  // keep-mine: giữ nội dung hiện tại.
  const vNow = projection.get('res-block').version;
  const c2 = registry.write('res-block', 'bot-b', 'bản khác của b', 1, '');
  assert.equal(c2.outcome, 'conflict');
  registry.resolveConflict(c2.conflictId, 'keep-mine', 'bot-a');
  assert.equal(projection.get('res-block').content, 'bản của c');
  assert.equal(projection.get('res-block').version, vNow);

  // merged: ghi nội dung gộp tay.
  const c3 = registry.write('res-block', 'bot-c', 'bản nữa của c', 1, '');
  assert.throws(() => registry.resolveConflict(c3.conflictId, 'merged', 'bot-a'), V9Error);
  const merged = registry.resolveConflict(c3.conflictId, 'merged', 'bot-c', 'nội dung đã gộp b+c');
  assert.equal(merged.resolution, 'merged');
  assert.equal(projection.get('res-block').content, 'nội dung đã gộp b+c');

  // Resolve lại xung đột đã xong -> lỗi; người lạ resolve -> lỗi.
  assert.throws(() => registry.resolveConflict(c3.conflictId, 'keep-mine', 'bot-a'), V9Error);
  const c4 = registry.write('res-block', 'bot-b', 'x', 1, '');
  assert.throws(() => registry.resolveConflict(c4.conflictId, 'keep-mine', 'bot-z'), V9Error);
});

test('shared registry: write forbidden / not-registered / unregister', () => {
  const dir = makeTempDir();
  const projection = new GitMemoryProjection(dir);
  seedBlock(projection, 'perm-block', 'x');
  const registry = new SharedBlockRegistry(dir, { projection });
  registry.register('perm-block', 'bot-a', { grants: [{ botId: 'bot-c', role: 'read' }] });

  const forbidden = registry.write('perm-block', 'bot-c', 'cố ghi', 1, '');
  assert.equal(forbidden.ok, false);
  assert.equal(forbidden.outcome, 'forbidden');
  const missing = registry.write('chua-dang-ky', 'bot-a', 'x', 1, '');
  assert.equal(missing.ok, false);
  assert.equal(missing.outcome, 'not-registered');

  assert.throws(() => registry.unregister('perm-block', 'bot-c'), V9Error);
  assert.equal(registry.unregister('perm-block', 'bot-a'), true);
  assert.equal(registry.get('perm-block'), null);
  assert.equal(registry.syncStatus('perm-block'), null);
});

test('shared registry: recordExternalChange appends to the feed', () => {
  const dir = makeTempDir();
  const projection = new GitMemoryProjection(dir);
  seedBlock(projection, 'ext-block', 'x');
  const registry = new SharedBlockRegistry(dir, { projection });
  registry.register('ext-block', 'bot-a');
  const change = registry.recordExternalChange('ext-block', 'bot-b', 5, 'change từ fleet', 'abc');
  assert.ok(change);
  assert.equal(change.newVersion, 5);
  assert.equal(registry.syncStatus('ext-block').version, 5);
  assert.equal(registry.changesSince('ext-block', 0).length, 1);
  assert.equal(registry.recordExternalChange('khong-co', 'bot-b', 1), null);
});

/**
 * Tests for v1.08 (Team T1) — memory v9 tools:
 * packages/tools/src/memoryV9Tools.ts (+ registry in tools.ts).
 *
 * Covers: tool registration (14 tools in ALL_TOOLS exactly once, no
 * duplicates, approval flags match read/write), bound execution via
 * createMemoryV9Tools({ workspaceDir }) (sleep status / config /
 * run / log, version snapshot / history / diff / rollback, shared
 * register / list / acl / sync / write / resolve incl. a stale-base
 * conflict), binding via createDefaultTools({ getMemoryV9WorkspaceDir })
 * (placeholders replaced in place, daemon auto-starts when the stored
 * policy is enabled), and placeholder tools (no workspaceDir) refuse
 * with a clear error instead of crashing.
 *
 * Run after building core + tools:
 *   npm run build --workspace=@open-bot/core
 *   npm run build --workspace=@open-bot/tools
 *   node --test tests/memory-v9-tools-v108.test.mjs
 *
 * No network. No model.
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { GitMemoryProjection, V6RecordStore } from '../packages/core/dist/index.js';
import {
  createMemoryV9Tools,
  MEMORY_V9_TOOLS,
  MEMORY_V9_TOOL_NAMES,
  resetMemoryV9AgentsForTests,
} from '../packages/tools/dist/memoryV9Tools.js';
import { ALL_TOOLS, createDefaultTools } from '../packages/tools/dist/tools.js';

const tempDirs = [];
function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-memv9-tools-v108-'));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  resetMemoryV9AgentsForTests();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const CTX = { botId: 'bot-a', runId: 'run-1', workspaceDir: '' };

function toolByName(tools, name) {
  const found = tools.find((t) => t.definition.name === name);
  assert.ok(found, `missing tool ${name}`);
  return found;
}

async function run(tools, name, args = {}, ctx = CTX) {
  const tool = toolByName(tools, name);
  const raw = await tool.execute(args, ctx);
  assert.ok(!raw.startsWith('Error:'), `${name} failed: ${raw}`);
  return JSON.parse(raw);
}

async function runRaw(tools, name, args = {}, ctx = CTX) {
  return toolByName(tools, name).execute(args, ctx);
}

function seedWorkspace(dir) {
  const projection = new GitMemoryProjection(dir);
  projection.create(
    { label: 'team-notes', content: 'dòng một\ndòng hai', description: 'ghi chú team', tier: 'working', scope: 'user' },
    'user',
  );
  projection.create(
    { label: 'human', content: 'user: lives_in Ha Noi', description: 'Sự thật về người dùng', tier: 'semantic', scope: 'system' },
    'user',
  );
  const store = V6RecordStore.fromWorkspace(dir);
  store.append({
    kind: 'fact',
    text: 'Huy thích ăn phở ở Hà Nội mỗi sáng.',
    entities: ['hà nội', 'phở'],
    tags: ['food'],
    confidence: 0.95,
    scope: { userId: 'u1', agentId: '', runId: '', appId: '' },
    source: { type: 'user', ref: 'chat:1' },
  });
  return { projection, store };
}

/* ------------------------------------------------------------------ */
/* Registry                                                            */
/* ------------------------------------------------------------------ */

test('registry: all 14 memory v9 tools in ALL_TOOLS exactly once, no duplicates', () => {
  assert.equal(MEMORY_V9_TOOL_NAMES.length, 14);
  assert.equal(MEMORY_V9_TOOLS.length, 14);
  const allNames = ALL_TOOLS.map((t) => t.definition.name);
  // ALL_TOOLS là tập tool của package tools (coordinator còn đăng ký
  // thêm CODE/REPO_MAP/plan/subagent tools nên tổng registry mới là
  // 442 — xem tests/coordinator.test.mjs). Ở đây chỉ kiểm tra v9
  // xuất hiện đúng một lần và không có trùng tên trong ALL_TOOLS.
  assert.equal(new Set(allNames).size, allNames.length, 'duplicate tool names in ALL_TOOLS');
  for (const name of MEMORY_V9_TOOL_NAMES) {
    const count = allNames.filter((n) => n === name).length;
    assert.equal(count, 1, `ALL_TOOLS must contain ${name} exactly once, got ${count}`);
  }
  const placeholderNames = new Set(MEMORY_V9_TOOLS.map((t) => t.definition.name));
  assert.deepEqual([...placeholderNames].sort(), [...MEMORY_V9_TOOL_NAMES].sort());
});

test('registry: approval flags match read/write', () => {
  const needsApproval = Object.fromEntries(
    MEMORY_V9_TOOLS.map((t) => [t.definition.name, t.needsApproval]),
  );
  assert.equal(needsApproval.memory_v9_sleep_status, false);
  assert.equal(needsApproval.memory_v9_sleep_config, true);
  assert.equal(needsApproval.memory_v9_sleep_run, true);
  assert.equal(needsApproval.memory_v9_sleep_log, false);
  assert.equal(needsApproval.memory_v9_version_snapshot, true);
  assert.equal(needsApproval.memory_v9_version_history, false);
  assert.equal(needsApproval.memory_v9_version_diff, false);
  assert.equal(needsApproval.memory_v9_version_rollback, true);
  assert.equal(needsApproval.memory_v9_shared_register, true);
  assert.equal(needsApproval.memory_v9_shared_list, false);
  assert.equal(needsApproval.memory_v9_shared_acl, true);
  assert.equal(needsApproval.memory_v9_shared_sync, false);
  assert.equal(needsApproval.memory_v9_shared_write, true);
  assert.equal(needsApproval.memory_v9_shared_resolve, true);
});

test('registry: placeholder tools (no workspaceDir) refuse with a clear error', async () => {
  const tools = createMemoryV9Tools();
  // Truyền đủ arg hợp lệ để tool chạm tới kiểm tra workspaceDir
  // (validate arg chạy trước, nên thiếu arg sẽ lỗi khác — vẫn là
  // Error, nhưng không phải lỗi workspaceDir cần kiểm tra ở đây).
  const validArgs = {
    memory_v9_sleep_status: {},
    memory_v9_sleep_config: {},
    memory_v9_sleep_run: {},
    memory_v9_sleep_log: {},
    memory_v9_version_snapshot: { label: 'x' },
    memory_v9_version_history: { label: 'x' },
    memory_v9_version_diff: { label: 'x', fromVersion: 1 },
    memory_v9_version_rollback: { label: 'x', version: 1 },
    memory_v9_shared_register: { label: 'x', ownerBotId: 'bot-a' },
    memory_v9_shared_list: {},
    memory_v9_shared_acl: { label: 'x', action: 'list' },
    memory_v9_shared_sync: { label: 'x', botId: 'bot-a' },
    memory_v9_shared_write: { label: 'x', botId: 'bot-a', content: 'c' },
    memory_v9_shared_resolve: { conflictId: 'x', resolution: 'keep-mine', byBotId: 'bot-a' },
  };
  for (const name of MEMORY_V9_TOOL_NAMES) {
    const raw = await runRaw(tools, name, validArgs[name]);
    assert.ok(raw.startsWith('Error: workspaceDir is required'), `${name} should refuse without workspaceDir, got: ${raw}`);
  }
});

/* ------------------------------------------------------------------ */
/* Sleep tools                                                         */
/* ------------------------------------------------------------------ */

test('sleep tools: status/config/run/log end-to-end', async () => {
  const dir = makeTempDir();
  seedWorkspace(dir);
  const tools = createMemoryV9Tools({ workspaceDir: dir });

  const before = await run(tools, 'memory_v9_sleep_status');
  assert.equal(before.status.enabled, false);
  assert.equal(before.status.started, false);
  assert.equal(before.status.runsToday, 0);
  assert.equal(before.status.lastRun, null);

  // Bật daemon: config trả policy + daemonStarted=true; tắt lại để không rò timer.
  const enabled = await run(tools, 'memory_v9_sleep_config', { enabled: true, cooldownMs: 0, maxRunsPerDay: 0 });
  assert.equal(enabled.policy.enabled, true);
  assert.equal(enabled.daemonStarted, true);
  const disabled = await run(tools, 'memory_v9_sleep_config', { enabled: false });
  assert.equal(disabled.policy.enabled, false);
  assert.equal(disabled.daemonStarted, false);

  // Config sai giờ hẹn -> lỗi rõ ràng, không crash.
  const badHour = await runRaw(tools, 'memory_v9_sleep_config', { scheduledHour: 25 });
  assert.ok(badHour.startsWith('Error: scheduledHour'));

  // Chạy job tay với transcript -> trích được fact, ghi log.
  const ran = await run(tools, 'memory_v9_sleep_run', {
    trigger: 'manual',
    episodes: [
      { role: 'user', text: 'My name is Huy. I live in Ha Noi.' },
      { role: 'user', text: 'Tôi rất thích ăn phở.' },
    ],
  });
  assert.equal(ran.job.status, 'done');
  assert.ok(ran.job.counts.factsExtracted >= 2);
  assert.ok(ran.job.counts.factsStored >= 2);

  const dry = await run(tools, 'memory_v9_sleep_run', { trigger: 'manual', dryRun: true });
  assert.equal(dry.job.dryRun, true);
  assert.equal(dry.job.status, 'done');

  const log = await run(tools, 'memory_v9_sleep_log', { limit: 10 });
  assert.equal(log.total, 2);
  assert.equal(log.entries.length, 2);
  const manualOnly = await run(tools, 'memory_v9_sleep_log', { trigger: 'manual', status: 'done' });
  assert.equal(manualOnly.entries.length, 2);
  const one = await run(tools, 'memory_v9_sleep_log', { jobId: ran.job.id });
  assert.equal(one.job.id, ran.job.id);
  assert.equal(one.job.trigger, 'manual');
  const missing = await runRaw(tools, 'memory_v9_sleep_log', { jobId: 'nope' });
  assert.ok(missing.startsWith('Error: Không tìm thấy sleep job'));

  const after = await run(tools, 'memory_v9_sleep_status');
  assert.equal(after.runsToday, 1);
  // Lần chạy gần nhất là job dry-run (chạy sau job manual).
  assert.equal(after.status.lastRun.id, dry.job.id);
});

/* ------------------------------------------------------------------ */
/* Version tools                                                       */
/* ------------------------------------------------------------------ */

test('version tools: snapshot/history/diff/rollback end-to-end', async () => {
  const dir = makeTempDir();
  const { projection } = seedWorkspace(dir);
  const tools = createMemoryV9Tools({ workspaceDir: dir });

  const snap = await run(tools, 'memory_v9_version_snapshot', { label: 'team-notes', note: 'trước khi sửa' });
  assert.equal(snap.snapshot.version, 1);
  assert.equal(snap.snapshot.label, 'team-notes');
  assert.equal(snap.snapshot.note, 'trước khi sửa');

  projection.update('team-notes', { content: 'dòng một\ndòng HAI mới\ndòng ba' }, 'user');
  const history = await run(tools, 'memory_v9_version_history', { label: 'team-notes' });
  assert.ok(history.versions.length >= 2);
  assert.equal(history.versions[0].version, 2);

  const diff = await run(tools, 'memory_v9_version_diff', { label: 'team-notes', fromVersion: 1, toVersion: 2 });
  assert.equal(diff.diff.addedLines, 2);
  assert.equal(diff.diff.removedLines, 1);
  assert.ok(diff.diff.hunks.length >= 1);

  const badDiff = await runRaw(tools, 'memory_v9_version_diff', { label: 'team-notes', fromVersion: 99 });
  assert.ok(badDiff.startsWith('Error: Không tìm thấy phiên bản 99'));

  const rolled = await run(tools, 'memory_v9_version_rollback', { label: 'team-notes', version: 1 });
  assert.equal(rolled.report.changed, true);
  assert.equal(rolled.report.newVersion, 3);
  assert.equal(projection.get('team-notes').content, 'dòng một\ndòng hai');

  const missing = await runRaw(tools, 'memory_v9_version_snapshot', { label: 'khong-co' });
  assert.ok(missing.startsWith('Error: Không tìm thấy memory block'));
});

/* ------------------------------------------------------------------ */
/* Shared tools                                                        */
/* ------------------------------------------------------------------ */

test('shared tools: register/list/acl/sync/write/resolve end-to-end', async () => {
  const dir = makeTempDir();
  const { projection } = seedWorkspace(dir);
  const tools = createMemoryV9Tools({ workspaceDir: dir });

  const reg = await run(tools, 'memory_v9_shared_register', {
    label: 'team-notes',
    ownerBotId: 'bot-a',
    description: 'Ghi chú team',
    grants: [
      { botId: 'bot-b', role: 'write' },
      { botId: 'bot-c', role: 'read' },
    ],
  });
  assert.equal(reg.entry.ownerBotId, 'bot-a');
  assert.equal(reg.entry.version, 1);

  const dup = await runRaw(tools, 'memory_v9_shared_register', { label: 'team-notes', ownerBotId: 'bot-a' });
  assert.ok(dup.startsWith('Error: Block "team-notes" đã đăng ký'));

  const listAll = await run(tools, 'memory_v9_shared_list', {});
  assert.equal(listAll.blocks.length, 1);
  const listB = await run(tools, 'memory_v9_shared_list', { botId: 'bot-b' });
  assert.equal(listB.blocks.length, 1);
  assert.equal(listB.blocks[0].role, 'write');

  const acl = await run(tools, 'memory_v9_shared_acl', { label: 'team-notes', action: 'list' });
  assert.equal(acl.entry.acl.length, 2);
  const granted = await run(tools, 'memory_v9_shared_acl', { label: 'team-notes', action: 'grant', botId: 'bot-d', role: 'write', grantedBy: 'bot-a' });
  assert.equal(granted.entry.acl.length, 3);
  const badGrant = await runRaw(tools, 'memory_v9_shared_acl', { label: 'team-notes', action: 'grant', botId: 'bot-e', role: 'write', grantedBy: 'bot-b' });
  assert.ok(badGrant.startsWith('Error: Bot "bot-b" không có quyền admin'));

  // bot-b ghi đúng baseVersion -> written v2.
  const written = await run(tools, 'memory_v9_shared_write', {
    label: 'team-notes',
    botId: 'bot-b',
    content: 'dòng một sửa bởi b\ndòng hai',
    baseVersion: 1,
    summary: 'b sửa dòng 1',
  });
  assert.equal(written.result.ok, true);
  assert.equal(written.result.outcome, 'written');
  assert.equal(written.result.newVersion, 2);

  // bot-c chỉ có quyền read -> forbidden.
  const forbidden = await run(tools, 'memory_v9_shared_write', {
    label: 'team-notes',
    botId: 'bot-c',
    content: 'c cố ghi',
    baseVersion: 2,
  });
  assert.equal(forbidden.result.ok, false);
  assert.equal(forbidden.result.outcome, 'forbidden');

  // bot-d ghi với baseVersion cũ (1) -> xung đột, không ghi đè.
  const conflicted = await run(tools, 'memory_v9_shared_write', {
    label: 'team-notes',
    botId: 'bot-d',
    content: 'd ghi đè',
    baseVersion: 1,
    summary: 'd sửa muộn',
  });
  assert.equal(conflicted.result.ok, false);
  assert.equal(conflicted.result.outcome, 'conflict');
  assert.ok(conflicted.result.conflictId);
  assert.equal(projection.get('team-notes').content, 'dòng một sửa bởi b\ndòng hai');

  const sync = await run(tools, 'memory_v9_shared_sync', { label: 'team-notes', botId: 'bot-b', sinceSeq: 0 });
  assert.equal(sync.sync.status.version, 2);
  assert.equal(sync.sync.status.pendingConflicts, 1);
  assert.equal(sync.sync.changes.length, 1);
  assert.equal(sync.sync.changes[0].botId, 'bot-b');

  const resolved = await run(tools, 'memory_v9_shared_resolve', {
    conflictId: conflicted.result.conflictId,
    resolution: 'keep-theirs',
    byBotId: 'bot-a',
  });
  assert.equal(resolved.conflict.status, 'resolved');
  assert.equal(resolved.conflict.resolution, 'keep-theirs');
  assert.equal(projection.get('team-notes').content, 'd ghi đè');

  const syncAfter = await run(tools, 'memory_v9_shared_sync', { label: 'team-notes', botId: 'bot-c', sinceSeq: 1 });
  assert.equal(syncAfter.sync.changes.length, 1);
  assert.ok(syncAfter.sync.changes[0].summary.includes('resolve conflict'));
});

/* ------------------------------------------------------------------ */
/* createDefaultTools binding                                          */
/* ------------------------------------------------------------------ */

test('binding: createDefaultTools replaces v9 placeholders in place and auto-starts the daemon when enabled', async () => {
  const dir = makeTempDir();
  seedWorkspace(dir);
  const tools = createDefaultTools({ getMemoryV9WorkspaceDir: () => dir });
  const names = tools.map((t) => t.definition.name);
  assert.equal(new Set(names).size, names.length, 'duplicate tool names after binding');
  for (const name of MEMORY_V9_TOOL_NAMES) {
    assert.equal(names.filter((n) => n === name).length, 1, `${name} must appear exactly once`);
  }
  // Bound: sleep_status chạy được (không còn là placeholder).
  const statusTool = toolByName(tools, 'memory_v9_sleep_status');
  const raw = await statusTool.execute({}, CTX);
  assert.ok(!raw.startsWith('Error:'), `bound sleep_status failed: ${raw}`);
  const status = JSON.parse(raw);
  assert.equal(status.status.enabled, false);
  assert.equal(status.status.started, false);

  // Policy đã enabled trên đĩa -> createDefaultTools tự start daemon.
  const { getMemoryV9Agent } = await import('../packages/tools/dist/memoryV9Tools.js');
  const agent = getMemoryV9Agent(dir);
  agent.setPolicy({ enabled: true, cooldownMs: 0, maxRunsPerDay: 0 });
  agent.stop();
  const tools2 = createDefaultTools({ getMemoryV9WorkspaceDir: () => dir });
  const status2 = JSON.parse(await toolByName(tools2, 'memory_v9_sleep_status').execute({}, CTX));
  assert.equal(status2.status.enabled, true);
  assert.equal(status2.status.started, true);
  resetMemoryV9AgentsForTests();
});

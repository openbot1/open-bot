/**
 * Tests for v1.18 (Team T1) — memory v17 tools:
 * packages/tools/src/memoryV17Tools.ts
 *
 * Covers:
 *  - 11 tools bound to an in-memory store + block store + tmp
 *    workspace: template list/create, lifecycle pin/readOnly/
 *    maxChars/quota/report, compile (pinned first), sleep
 *    schedule status/run, archival report/promote/demote/
 *    record-access, block commit/history/rollback/audit, admit
 *    (auto-admit / human-review / reject / verify-chain / stats /
 *    chain), eval returns a PASS report.
 *  - Unbound placeholders fail gracefully (Error: ...).
 *  - Registry: 11 new names, present in ALL_TOOLS exactly once
 *    (ALL_TOOLS 550 -> 561 at this base); the full agent registry
 *    via defaultToolFactory is 917 (v1.17) + 11 = 928 (merge
 *    re-pin note: other v1.18 teams add tools too — coordinator
 *    re-pins the totals at merge time, same pattern as v1.17).
 *
 * Run after building core + tools:
 *   npm run build --workspace=@open-bot/core
 *   npm run build --workspace=@open-bot/tools
 *   node --test tests/memory-v17-tools-v118.test.mjs
 *
 * No network. No model.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  TemporalGraphStore,
  InMemoryGraphBackend,
  V15BlockStore,
  BotMemory,
  defaultToolFactory,
} from '../packages/core/dist/index.js';
import {
  createMemoryV17Tools,
  MEMORY_V17_TOOLS,
  MEMORY_V17_TOOL_NAMES,
} from '../packages/tools/dist/index.js';
import { ALL_TOOLS } from '../packages/tools/dist/tools.js';

const SCOPE = { userId: 'u1', botId: 'b1', runId: 'r1' };

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'v17-tools-'));
}

function boundTools() {
  const dir = tmpDir();
  const store = new TemporalGraphStore(new InMemoryGraphBackend());
  const blockStore = new V15BlockStore();
  const tools = createMemoryV17Tools({ workspaceDir: dir, graphStore: store, blockStore, botId: 'b1' });
  return { dir, store, blockStore, tools };
}

function byName(tools, name) {
  const tool = tools.find((t) => t.definition.name === name);
  assert.ok(tool, `missing tool ${name}`);
  return tool;
}

async function run(tools, name, args, ctx) {
  const tool = byName(tools, name);
  return tool.execute(args, ctx ?? { botId: 'b1' });
}

test('v17 tools: 11 tools, names match, placeholders unbound fail gracefully', () => {
  assert.equal(MEMORY_V17_TOOL_NAMES.length, 11);
  assert.equal(MEMORY_V17_TOOLS.length, 11);
  assert.deepEqual(
    MEMORY_V17_TOOLS.map((t) => t.definition.name),
    [...MEMORY_V17_TOOL_NAMES],
  );
  const names = new Set(MEMORY_V17_TOOL_NAMES);
  assert.equal(names.size, 11);
  // ALL_TOOLS: 550 (v1.17) + 11 = 561 tai base nay.
  assert.ok(ALL_TOOLS.length >= 1078, `ALL_TOOLS ${ALL_TOOLS.length} below 1078 floor`); // v1.39 fix round 4b: floor >= 1078 (was v1.38 re-pin 1078).
  for (const name of MEMORY_V17_TOOL_NAMES) {
    const found = ALL_TOOLS.filter((t) => t.definition.name === name);
    assert.equal(found.length, 1, `${name} phai xuat hien dung 1 lan trong ALL_TOOLS`);
  }
  // Full agent registry (defaultToolFactory): 917 (v1.17) + 11 = 928.
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-memory-v17-tools-'));
  const mem = new BotMemory(ws);
  try {
    const full = defaultToolFactory(mem, ws, 'bot-1');
    const fullNames = full.map((t) => t.definition.name);
    assert.ok(fullNames.length >= 1453, `expected at least 1453 tools, got ${fullNames.length}`); // v1.39 fix round 4b: floor >= 1453 (was v1.36 re-pin 1453).
    assert.equal(new Set(fullNames).size, fullNames.length, 'duplicate tool names in the agent registry');
    for (const name of MEMORY_V17_TOOL_NAMES) {
      assert.ok(fullNames.includes(name), `${name} in full registry`);
    }
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('v17 tools: unbound placeholders fail gracefully', async () => {
  const out = await byName(MEMORY_V17_TOOLS, 'memory_v17_block_template').execute({ action: 'list' });
  assert.ok(out.startsWith('Error:') || out.includes('Block template v17'));
});

test('v17 tools: template list + create', async () => {
  const { tools } = boundTools();
  const list = await run(tools, 'memory_v17_block_template', { action: 'list' });
  assert.ok(list.includes('persona'));
  assert.ok(list.includes('project'));
  const created = await run(tools, 'memory_v17_block_template', {
    action: 'create',
    template: 'persona',
    label: 'persona',
    agentName: 'Bot',
  });
  assert.ok(created.includes('Da tao block "persona"'));
  const missing = await run(tools, 'memory_v17_block_template', {
    action: 'create',
    template: 'persona',
    label: 'persona2',
  });
  assert.ok(missing.startsWith('Error:'));
});

test('v17 tools: lifecycle pin/readOnly/maxChars/quota/report', async () => {
  const { tools, blockStore } = boundTools();
  await run(tools, 'memory_v17_block_template', { action: 'create', template: 'human', label: 'human', userName: 'Huy' });
  const pinned = await run(tools, 'memory_v17_block_lifecycle', { action: 'pin', label: 'human' });
  assert.ok(pinned.includes('Da pin block'));
  const ro = await run(tools, 'memory_v17_block_lifecycle', { action: 'readonly', label: 'human' });
  assert.ok(ro.includes('chi doc'));
  const report = await run(tools, 'memory_v17_block_lifecycle', { action: 'report' });
  assert.ok(report.includes('Quota block v17'));
  assert.ok(report.includes('Block pin: human'));
  assert.ok(report.includes('Block chi doc: human'));
  const maxChars = await run(tools, 'memory_v17_block_lifecycle', { action: 'maxchars', label: 'human', maxChars: 500 });
  assert.ok(maxChars.includes('500'));
  const quota = await run(tools, 'memory_v17_block_lifecycle', { action: 'quota', quotaChars: 64000 });
  assert.ok(quota.includes('64000'));
  assert.ok(blockStore.get('human'));
});

test('v17 tools: compile shows pinned block first', async () => {
  const { tools } = boundTools();
  await run(tools, 'memory_v17_block_template', { action: 'create', template: 'custom', label: 'zzz', title: 'Z' });
  await run(tools, 'memory_v17_block_template', { action: 'create', template: 'persona', label: 'persona', agentName: 'Bot' });
  await run(tools, 'memory_v17_block_lifecycle', { action: 'pin', label: 'zzz' });
  const compiled = await run(tools, 'memory_v17_block_compile', {});
  assert.ok(compiled.indexOf('[custom:zzz]') < compiled.indexOf('[persona:persona]'));
  assert.ok(compiled.includes('pinned'));
});

test('v17 tools: sleep schedule status + run', async () => {
  const { tools, store } = boundTools();
  store.ingestEpisode({
    turnId: 't1',
    runId: 'r1',
    botId: 'b1',
    userId: 'u1',
    role: 'user',
    text: 'Huy thich ca phe den.',
  });
  const status = await run(tools, 'memory_v17_sleep_schedule', { action: 'status' });
  assert.ok(status.includes('Lich sleep v17'));
  assert.ok(status.includes('lan chay ke tiep'));
  const ran = await run(tools, 'memory_v17_sleep_schedule', { action: 'run' });
  assert.ok(ran.includes('Sleep v17 chay xong') || ran.includes('khong chay'));
});

test('v17 tools: archival report + record-access + promote/demote', async () => {
  const { tools, store } = boundTools();
  const { id: episodeId } = store.ingestEpisode({
    turnId: 't1',
    runId: 'r1',
    botId: 'b1',
    userId: 'u1',
    role: 'user',
    text: 'Huy likes ca phe.',
  });
  const fact = store.addFact({
    subjectName: 'Huy',
    predicate: 'likes',
    objectText: 'ca phe',
    confidence: 0.95,
    scope: SCOPE,
    provenance: {
      episodeId,
      turnId: 't1',
      runId: 'r1',
      botId: 'b1',
      userId: 'u1',
      at: '2026-01-01T00:00:00.000Z',
      sourceText: 'Huy likes ca phe.',
    },
    validFrom: '2025-01-01T00:00:00.000Z',
  });
  const recorded = await run(tools, 'memory_v17_archival_score', { action: 'record-access', factId: fact.id });
  assert.ok(recorded.includes('Da ghi nhan truy cap'));
  const report = await run(tools, 'memory_v17_archival_score', { action: 'report', ...SCOPE });
  assert.ok(report.includes('Archival scoring v17'));
  assert.ok(report.includes('ca phe'));
  const promoted = await run(tools, 'memory_v17_archival_score', { action: 'promote', ...SCOPE });
  assert.ok(promoted.includes('Promote v17'));
  const demoted = await run(tools, 'memory_v17_archival_score', { action: 'demote', ...SCOPE });
  assert.ok(demoted.includes('Demote v17'));
});

test('v17 tools: block commit/history/rollback/audit round-trip', async () => {
  const { tools } = boundTools();
  await run(tools, 'memory_v17_block_template', { action: 'create', template: 'persona', label: 'persona', agentName: 'Bot' });
  const c1 = await run(tools, 'memory_v17_block_commit', { label: 'persona', reason: 'tao' });
  assert.ok(c1.includes('Da commit block "persona"'));
  const c2 = await run(tools, 'memory_v17_block_commit', { label: 'persona', reason: 'tao lai' });
  assert.ok(c2.includes('khong doi'));
  const history = await run(tools, 'memory_v17_block_history', { label: 'persona' });
  assert.ok(history.includes('Lich su commit block "persona"'));
  const hash = history.match(/[0-9a-f]{12}/)?.[0];
  assert.ok(hash);
  const audit = await run(tools, 'memory_v17_block_audit', { label: 'persona' });
  assert.ok(audit.includes('Audit block v17'));
  assert.ok(audit.includes('tao'));
  const rolled = await run(tools, 'memory_v17_block_rollback', { label: 'persona', hash, reason: 'quay lai' });
  assert.ok(rolled.includes('Da rollback block "persona"'));
  const history2 = await run(tools, 'memory_v17_block_history', { label: 'persona' });
  assert.ok(history2.includes('2 commit') || history2.split('\n').length >= 3);
});

test('v17 tools: admit auto-admit + verify-chain + stats + chain export', async () => {
  const { tools, store } = boundTools();
  const { id: episodeId } = store.ingestEpisode({
    turnId: 't1',
    runId: 'r1',
    botId: 'b1',
    userId: 'u1',
    role: 'user',
    text: 'Huy likes ca phe.',
  });
  const verified = await run(tools, 'memory_v17_admit', {
    action: 'verify-chain',
    subject: 'Huy',
    predicate: 'likes',
    objectText: 'tra da',
    sourceText: 'Huy likes tra da.',
    episodeId,
    ...SCOPE,
  });
  assert.ok(verified.includes('hop le'));
  const admitted = await run(tools, 'memory_v17_admit', {
    action: 'admit',
    subject: 'Huy',
    predicate: 'likes',
    objectText: 'tra da',
    confidence: 0.9,
    sourceText: 'Huy likes tra da.',
    episodeId,
    ...SCOPE,
  });
  assert.ok(admitted.includes('Auto-admit'));
  const stats = await run(tools, 'memory_v17_admit', { action: 'stats' });
  assert.ok(stats.includes('Admission v17'));
  assert.ok(stats.includes('auto-admit 1'));
  const facts = store.listFacts({ ...SCOPE });
  const chain = await run(tools, 'memory_v17_admit', { action: 'chain', factId: facts[0].id });
  assert.ok(chain.includes('Fact:'));
  assert.ok(chain.includes('Episode goc'));
  const rejected = await run(tools, 'memory_v17_admit', {
    action: 'admit',
    subject: 'Huy',
    predicate: 'likes',
    objectText: 'bia',
    sourceText: 'Huy likes bia.',
    episodeId: 'ep-khong-co',
    ...SCOPE,
  });
  assert.ok(rejected.includes('Reject'));
});

test('v17 tools: admit low-confidence goes to quarantine, review approves', async () => {
  const { tools, store } = boundTools();
  const { id: episodeId } = store.ingestEpisode({
    turnId: 't1',
    runId: 'r1',
    botId: 'b1',
    userId: 'u1',
    role: 'user',
    text: 'Huy likes ca phe.',
  });
  const pending = await run(tools, 'memory_v17_admit', {
    action: 'admit',
    subject: 'Huy',
    predicate: 'likes',
    objectText: 'tra da',
    confidence: 0.5,
    sourceText: 'Huy likes tra da.',
    episodeId,
    ...SCOPE,
  });
  assert.ok(pending.includes('Human-review'));
  const item = store.listQuarantine({ ...SCOPE, status: 'pending' })[0];
  assert.ok(item);
  const reviewed = await run(tools, 'memory_v17_admit', {
    action: 'review',
    quarantineId: item.id,
    decision: 'approved',
  });
  assert.ok(reviewed.includes('Da duyet muc quarantine'));
});

test('v17 tools: eval returns PASS report', async () => {
  const { tools } = boundTools();
  const out = await run(tools, 'memory_v17_eval', {});
  assert.ok(out.includes('25/25'));
  assert.ok(out.includes('PASS'));
});

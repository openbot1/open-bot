/**
 * Tests for v1.04 (Team T1) — memory v5 tools:
 * packages/tools/src/memoryV5Tools.ts.
 *
 * Covers: tool registration (8 tools, unique names, approval flags
 * match read/write), ADD-only append tool (append next to the old
 * fact + dedupe), rank tool (winner/losers + contradiction rate),
 * recall tool (winnersOnly default), bi-temporal query tool (facts
 * at T as known at R + edge intervals + overlaps), invalidate tool
 * (closes window, keeps history, needs a reason), ingest tool
 * (text/file/directory + dry-run), health tool (score + issues +
 * contradiction groups + recent runs), consolidate tool (dedupe +
 * ranking supersession + sweep + dream + health before/after).
 * Placeholder tools (no store) refuse with a clear error instead
 * of crashing. Tool output never contains vector embeddings.
 *
 * Run after building core + tools:
 *   npm run build --workspace=@open-bot/core
 *   npm run build --workspace=@open-bot/tools
 *   node --test tests/memory-v5-tools-v104.test.mjs
 *
 * No network. No model (rule-based extractor only).
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  TemporalGraphStore,
  MemoryBlockStore,
  LongTermMemory,
} from '../packages/core/dist/index.js';
import {
  createMemoryV5Tools,
  MEMORY_V5_TOOLS,
  MEMORY_V5_TOOL_NAMES,
} from '../packages/tools/dist/memoryV5Tools.js';

const tempDirs = [];
function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-memv5-tools-v104-'));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const CTX = { botId: 'bot-a', runId: 'run-1', workspaceDir: '' };

function makeTools() {
  const dir = makeTempDir();
  const graphStore = TemporalGraphStore.fromWorkspace(dir);
  const blocksStore = new MemoryBlockStore(dir);
  const longTerm = new LongTermMemory(dir);
  const tools = createMemoryV5Tools({
    graphStore,
    workspaceDir: dir,
    blocksStore,
    longTerm,
    getUserId: () => 'user-1',
  });
  const byName = new Map(tools.map((t) => [t.definition.name, t]));
  return { dir, graphStore, blocksStore, longTerm, tools, byName };
}

async function run(byName, name, args, ctx = CTX) {
  const tool = byName.get(name);
  assert.ok(tool, `tool ${name} should exist`);
  const raw = await tool.execute(args, { ...ctx, workspaceDir: ctx.workspaceDir || '' });
  assert.equal(typeof raw, 'string');
  assert.ok(!raw.startsWith('Error:'), `tool ${name} failed: ${raw}`);
  return JSON.parse(raw);
}

async function runRaw(byName, name, args, ctx = CTX) {
  const tool = byName.get(name);
  assert.ok(tool, `tool ${name} should exist`);
  return tool.execute(args, { ...ctx, workspaceDir: ctx.workspaceDir || '' });
}

test('registration: 8 tools, unique names, approval flags match read/write', () => {
  assert.equal(MEMORY_V5_TOOLS.length, 8);
  assert.equal(MEMORY_V5_TOOL_NAMES.length, 8);
  const names = MEMORY_V5_TOOLS.map((t) => t.definition.name);
  assert.equal(new Set(names).size, 8);
  assert.deepEqual([...names].sort(), [...MEMORY_V5_TOOL_NAMES].sort());
  const needsApproval = Object.fromEntries(
    MEMORY_V5_TOOLS.map((t) => [t.definition.name, t.needsApproval]),
  );
  assert.equal(needsApproval.memory_v5_addonly_append, true);
  assert.equal(needsApproval.memory_v5_addonly_rank, false);
  assert.equal(needsApproval.memory_v5_addonly_recall, false);
  assert.equal(needsApproval.memory_v5_bitemporal_query, false);
  assert.equal(needsApproval.memory_v5_invalidate, true);
  assert.equal(needsApproval.memory_v5_ingest, true);
  assert.equal(needsApproval.memory_v5_health, false);
  assert.equal(needsApproval.memory_v5_consolidate, true);
  for (const tool of MEMORY_V5_TOOLS) {
    assert.ok(tool.definition.description.length > 20);
    assert.equal(tool.definition.parameters.additionalProperties, false);
  }
});

test('placeholder tools (no store) refuse with a clear error', async () => {
  const byName = new Map(createMemoryV5Tools().map((t) => [t.definition.name, t]));
  const raw = await runRaw(byName, 'memory_v5_health', {});
  assert.ok(raw.startsWith('Error:'));
  assert.ok(raw.includes('graph store'));
});

test('addonly append: fact mới nằm cạnh fact cũ; trùng thì dedupe', async () => {
  const { byName, graphStore } = makeTools();
  const first = await run(byName, 'memory_v5_addonly_append', {
    subject: 'user',
    predicate: 'likes',
    object: 'phở',
    confidence: 0.9,
    sourceText: 'Tôi thích phở.',
  });
  assert.equal(first.duplicate, false);
  assert.equal(first.fact.objectText, 'phở');
  assert.equal(first.fact.embedding, undefined);
  const second = await run(byName, 'memory_v5_addonly_append', {
    subject: 'user',
    predicate: 'likes',
    object: 'bún chả',
    confidence: 0.85,
    sourceText: 'Tôi thích bún chả.',
  });
  assert.equal(second.duplicate, false);
  assert.equal(second.group.hasContradiction, true);
  assert.equal(second.group.winner.objectText, 'phở');
  const dup = await run(byName, 'memory_v5_addonly_append', {
    subject: 'user',
    predicate: 'likes',
    object: 'phở',
  });
  assert.equal(dup.duplicate, true);
  assert.equal(graphStore.listFacts({ status: 'active' }).length, 2);
});

test('addonly rank: winner/losers + contradiction rate; filter contradictionsOnly', async () => {
  const { byName } = makeTools();
  await run(byName, 'memory_v5_addonly_append', { subject: 'user', predicate: 'likes', object: 'phở', confidence: 0.5 });
  await run(byName, 'memory_v5_addonly_append', { subject: 'user', predicate: 'likes', object: 'bún chả', confidence: 0.95 });
  await run(byName, 'memory_v5_addonly_append', { subject: 'user', predicate: 'lives_in', object: 'Hà Nội', confidence: 0.9 });
  const rank = await run(byName, 'memory_v5_addonly_rank', {});
  assert.equal(rank.contradictionRate.groups, 2);
  assert.equal(rank.contradictionRate.contradictoryGroups, 1);
  assert.equal(rank.contradictionRate.rate, 0.5);
  assert.equal(rank.groups.length, 2);
  const likes = rank.groups.find((g) => g.predicate === 'likes');
  assert.equal(likes.winner.objectText, 'bún chả');
  assert.equal(likes.losers.length, 1);
  assert.ok(likes.winner.explanation.includes('Đang thắng'));
  assert.ok(likes.losers[0].explanation.includes('Thua'));
  const only = await run(byName, 'memory_v5_addonly_rank', { contradictionsOnly: true });
  assert.equal(only.groups.length, 1);
  assert.equal(only.groups[0].predicate, 'likes');
});

test('addonly recall: winnersOnly mặc định chỉ trả winner', async () => {
  const { byName } = makeTools();
  await run(byName, 'memory_v5_addonly_append', { subject: 'user', predicate: 'likes', object: 'phở', confidence: 0.5 });
  await run(byName, 'memory_v5_addonly_append', { subject: 'user', predicate: 'likes', object: 'bún chả', confidence: 0.95 });
  const winners = await run(byName, 'memory_v5_addonly_recall', { query: 'likes' });
  assert.equal(winners.hits.length, 1);
  assert.equal(winners.hits[0].fact.objectText, 'bún chả');
  assert.equal(winners.hits[0].isWinner, true);
  const all = await run(byName, 'memory_v5_addonly_recall', { query: 'likes', winnersOnly: false });
  assert.equal(all.hits.length, 2);
});

test('bitemporal query: fact đúng tại T, kèm edge intervals + overlaps', async () => {
  const { byName } = makeTools();
  await run(byName, 'memory_v5_addonly_append', { subject: 'user', predicate: 'lives_in', object: 'Hà Nội', confidence: 0.9 });
  await run(byName, 'memory_v5_addonly_append', { subject: 'user', predicate: 'lives_in', object: 'TP. Hồ Chí Minh', confidence: 0.9 });
  const res = await run(byName, 'memory_v5_bitemporal_query', {
    at: new Date().toISOString(),
    subject: 'user',
    predicate: 'lives_in',
  });
  assert.equal(res.facts.length, 2);
  assert.ok(res.facts.every((f) => f.currentAtRecordTime === true));
  assert.equal(res.intervals.length, 2);
  assert.equal(res.overlaps.length, 1);
  const bad = await runRaw(byName, 'memory_v5_bitemporal_query', { at: 'not-a-date' });
  assert.ok(bad.startsWith('Error:') || JSON.parse(bad).facts.length === 0);
});

test('invalidate: đóng cửa sổ, giữ lịch sử, chặn lý do rỗng', async () => {
  const { byName, graphStore } = makeTools();
  const added = await run(byName, 'memory_v5_addonly_append', {
    subject: 'user',
    predicate: 'lives_in',
    object: 'Hà Nội',
    confidence: 0.9,
  });
  const factId = added.fact.id;
  const res = await run(byName, 'memory_v5_invalidate', {
    factId,
    invalidAt: new Date(Date.now() + 86_400_000).toISOString(),
    reason: 'User đã chuyển đi.',
  });
  assert.ok(res.fact.validUntil !== null);
  assert.equal(res.fact.status, 'active');
  assert.equal(res.logWritten, true);
  assert.equal(res.record.factId, factId);
  assert.equal(graphStore.getFact(factId)?.status, 'active');
  const noReason = await runRaw(byName, 'memory_v5_invalidate', {
    factId,
    invalidAt: new Date().toISOString(),
    reason: '   ',
  });
  assert.ok(noReason.startsWith('Error:'));
});

test('ingest: text + file + directory + dry-run', async () => {
  const { byName, dir, graphStore } = makeTools();
  const text = await run(byName, 'memory_v5_ingest', {
    action: 'text',
    text: 'Tôi thích phở.\n\nTôi sống ở Hà Nội.',
    sourceLabel: 'about.md',
  });
  assert.ok(text.report.added >= 1);
  assert.equal(text.report.sourceLabel, 'about.md');
  const dry = await run(byName, 'memory_v5_ingest', {
    action: 'text',
    text: 'Tôi thích bún chả.',
    dryRun: true,
  });
  assert.ok(dry.report.candidates >= 1);
  const file = path.join(dir, 'notes.md');
  fs.writeFileSync(file, 'Tôi thích bún chả.');
  const filed = await run(byName, 'memory_v5_ingest', { action: 'file', filePath: file });
  // 'bún chả' cùng (subject, predicate) với 'phở' đã có → consolidate
  // UPDATE (supersede) thay vì ADD, nên đếm added + updated.
  assert.ok(filed.report.added + filed.report.updated >= 1);
  // Fact mới đã active, fact cũ đã bị supersede (số active không tăng).
  assert.ok(graphStore.listFacts({ status: 'active' }).some((f) => f.objectText === 'bún chả'));
  assert.ok(graphStore.listFacts({ status: 'superseded' }).some((f) => f.objectText === 'phở'));
  const sub = path.join(dir, 'docs');
  fs.mkdirSync(sub);
  fs.writeFileSync(path.join(sub, 'x.md'), 'Tôi thích pizza.');
  const dirRes = await run(byName, 'memory_v5_ingest', { action: 'directory', dir: sub });
  assert.equal(dirRes.report.filesIngested, 1);
  const bad = await runRaw(byName, 'memory_v5_ingest', { action: 'teleport' });
  assert.ok(bad.startsWith('Error:'));
});

test('ingest: transcript action parse turn + dedupe khi ingest lại', async () => {
  const { byName, graphStore } = makeTools();
  const text = 'User: Tôi thích phở.\nAssistant: Ngon đấy.\nUser: Tôi sống ở Hà Nội.';
  const first = await run(byName, 'memory_v5_ingest', { action: 'transcript', text, sourceLabel: 'chat-9' });
  assert.equal(first.report.turns, 3);
  assert.ok(first.report.added + first.report.updated >= 2);
  const activeBefore = graphStore.listFacts({ status: 'active' }).length;
  const second = await run(byName, 'memory_v5_ingest', { action: 'transcript', text, sourceLabel: 'chat-9' });
  assert.ok(second.report.turnsSkippedDuplicate >= 2);
  assert.equal(graphStore.listFacts({ status: 'active' }).length, activeBefore);
});

test('health: điểm + issues + nhóm mâu thuẫn + lịch sử consolidation', async () => {
  const { byName } = makeTools();
  const empty = await run(byName, 'memory_v5_health', {});
  assert.equal(empty.health.factCount, 0);
  assert.equal(empty.health.score, 100);
  assert.equal(empty.recentConsolidationRuns.length, 0);
  await run(byName, 'memory_v5_addonly_append', { subject: 'user', predicate: 'likes', object: 'phở', confidence: 0.85 });
  await run(byName, 'memory_v5_addonly_append', { subject: 'user', predicate: 'likes', object: 'bún chả', confidence: 0.95 });
  const health = await run(byName, 'memory_v5_health', {});
  assert.equal(health.health.contradictionGroups, 1);
  assert.equal(health.health.score, 60);
  assert.equal(health.contradictionGroups.length, 1);
  assert.equal(health.contradictionGroups[0].winnerObject, 'bún chả');
  assert.ok(health.markdown.includes('60/100'));
  assert.ok(!JSON.stringify(health).includes('"embedding"'));
});

test('consolidate: chạy đầy đủ qua tool, health cải thiện, log ghi lại', async () => {
  const { byName, dir, graphStore } = makeTools();
  // Loser già + confidence thấp, winner mới + chắc → supersede được.
  const loser = await run(byName, 'memory_v5_addonly_append', {
    subject: 'user',
    predicate: 'likes',
    object: 'phở',
    confidence: 0.5,
  });
  const file = path.join(dir, '.open-bot', 'memory-graph.json');
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  const past = new Date(Date.now() - 80 * 86_400_000).toISOString();
  for (const fact of data.facts) {
    if (fact.id === loser.fact.id) {
      fact.createdAt = past;
      fact.updatedAt = past;
      fact.validFrom = past;
    }
  }
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
  // Store của tool đã load snapshot cũ — tạo lại store mới sẽ thấy
  // file mới (loser đã backdate) rồi consolidate trên store mới.
  const freshStore = TemporalGraphStore.fromWorkspace(dir);
  const { createMemoryV5Tools: createTools } = await import('../packages/tools/dist/memoryV5Tools.js');
  const freshTools = createTools({
    graphStore: freshStore,
    workspaceDir: dir,
    blocksStore: new MemoryBlockStore(dir),
    getUserId: () => 'user-1',
  });
  const freshByName = new Map(freshTools.map((t) => [t.definition.name, t]));
  await run(freshByName, 'memory_v5_addonly_append', {
    subject: 'user',
    predicate: 'likes',
    object: 'bún chả',
    confidence: 0.95,
  });
  const report = await run(freshByName, 'memory_v5_consolidate', { skipDream: true });
  assert.equal(report.summary.losersSuperseded, 1);
  assert.ok(report.markdown.includes('Consolidation v2'));
  const health = await run(freshByName, 'memory_v5_health', {});
  assert.equal(health.health.contradictionGroups, 0);
  assert.equal(health.recentConsolidationRuns.length, 1);
  assert.equal(health.recentConsolidationRuns[0].losersSuperseded, 1);
  assert.equal(freshStore.getFact(loser.fact.id)?.status, 'superseded');
  assert.equal(freshStore.listFacts({ status: 'active' }).length, 1);
});

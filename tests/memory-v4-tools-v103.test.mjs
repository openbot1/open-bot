/**
 * Tests for v1.03 (Team T2) — memory v4 tools:
 * packages/tools/src/memoryV4Tools.ts.
 *
 * Covers: tool registration (6 tools, unique names, approval flags),
 * shared-group tool (create/add-member/attach-block/resolve/sync),
 * judge tool (ADD + noise short-circuit), scored dream tool
 * (promote via tool), validity tool (report/parse-hint/set-window/
 * sweep), scoped recall tool (fused, read-only). Placeholder tools
 * (no store) refuse with a clear error instead of crashing.
 *
 * Run after building core + tools:
 *   npm run build --workspace=@open-bot/core
 *   npm run build --workspace=@open-bot/tools
 *   node --test tests/memory-v4-tools-v103.test.mjs
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
  SharedBlockGroupStore,
} from '../packages/core/dist/index.js';
import {
  createMemoryV4Tools,
  MEMORY_V4_TOOLS,
  MEMORY_V4_TOOL_NAMES,
} from '../packages/tools/dist/memoryV4Tools.js';

const tempDirs = [];
function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-memv4-tools-v103-'));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const CTX = { botId: 'bot-a', runId: 'run-1' };

function makeTools() {
  const dir = makeTempDir();
  const graphStore = TemporalGraphStore.fromWorkspace(dir);
  const blocksStore = new MemoryBlockStore(dir);
  const longTerm = new LongTermMemory(dir);
  const sharedGroups = new SharedBlockGroupStore(dir, blocksStore);
  const tools = createMemoryV4Tools({
    graphStore,
    workspaceDir: dir,
    blocksStore,
    sharedGroups,
    longTerm,
    getUserId: () => 'user-1',
  });
  const byName = new Map(tools.map((t) => [t.definition.name, t]));
  return { dir, graphStore, blocksStore, longTerm, sharedGroups, tools, byName };
}

async function run(byName, name, args, ctx = CTX) {
  const tool = byName.get(name);
  assert.ok(tool, `tool ${name} should exist`);
  const raw = await tool.execute(args, ctx);
  assert.equal(typeof raw, 'string');
  assert.ok(!raw.startsWith('Error:'), `tool ${name} failed: ${raw}`);
  return JSON.parse(raw);
}

test('registration: 6 tools, unique names, approval flags match read/write', () => {
  assert.equal(MEMORY_V4_TOOLS.length, 6);
  assert.deepEqual([...MEMORY_V4_TOOL_NAMES], [
    'memory_v4_shared_group',
    'memory_v4_shared_resolve',
    'memory_v4_judge_message',
    'memory_v4_scored_dream',
    'memory_v4_validity',
    'memory_v4_scoped_recall',
  ]);
  const byName = new Map(MEMORY_V4_TOOLS.map((t) => [t.definition.name, t]));
  assert.equal(new Set(MEMORY_V4_TOOLS.map((t) => t.definition.name)).size, 6);
  assert.equal(byName.get('memory_v4_shared_resolve').needsApproval, false);
  assert.equal(byName.get('memory_v4_scoped_recall').needsApproval, false);
  assert.equal(byName.get('memory_v4_shared_group').needsApproval, true);
  assert.equal(byName.get('memory_v4_judge_message').needsApproval, true);
  assert.equal(byName.get('memory_v4_scored_dream').needsApproval, true);
  assert.equal(byName.get('memory_v4_validity').needsApproval, true);
});

test('placeholder tools (no store) refuse with a clear error', async () => {
  const byName = new Map(MEMORY_V4_TOOLS.map((t) => [t.definition.name, t]));
  // Store-requiring tools refuse; judge needs a fact-like text to get
  // past the (store-free) noise check before it hits the missing store.
  const errorCases = [
    ['memory_v4_shared_group', { action: 'list' }],
    ['memory_v4_shared_resolve', { mode: 'resolve' }],
    ['memory_v4_judge_message', { text: 'Tôi thích phở bò.', turnId: 't1' }],
    ['memory_v4_scored_dream', {}],
    ['memory_v4_validity', { action: 'report' }],
  ];
  for (const [name, args] of errorCases) {
    const raw = await byName.get(name).execute(args, CTX);
    assert.ok(raw.startsWith('Error:'), `${name} should refuse without a store (got: ${raw})`);
  }
  // Scoped recall with no stores at all is a valid empty read, not a crash.
  const recall = await byName.get('memory_v4_scoped_recall').execute({ query: 'phở bò' }, CTX);
  assert.equal(JSON.parse(recall).hits.length, 0);
});

test('shared group tool: create -> add-member -> attach-block -> resolve', async () => {
  const { blocksStore, byName } = makeTools();
  const block = blocksStore.create({ label: 'team', content: 'Team thích phở bò.' });
  const created = await run(byName, 'memory_v4_shared_group', { action: 'create', group: 'team-sales' });
  assert.equal(created.created.name, 'team-sales');
  await run(byName, 'memory_v4_shared_group', { action: 'add-member', group: 'team-sales', botId: 'bot-a', role: 'write' });
  await run(byName, 'memory_v4_shared_group', { action: 'add-member', group: 'team-sales', botId: 'bot-b' });
  await run(byName, 'memory_v4_shared_group', { action: 'attach-block', group: 'team-sales', block: block.id });
  assert.equal(blocksStore.isAttached('bot-b', block.id), true);
  const resolved = await run(byName, 'memory_v4_shared_resolve', { botId: 'bot-b' });
  assert.equal(resolved.blocks.length, 1);
  assert.equal(resolved.blocks[0].viaGroupName, 'team-sales');
  const report = await run(byName, 'memory_v4_shared_resolve', { mode: 'sync-report', group: 'team-sales' });
  assert.equal(report.inSync, true);
  const bad = await byName.get('memory_v4_shared_group').execute({ action: 'teleport', group: 'team-sales' }, CTX);
  assert.ok(bad.startsWith('Error:'));
});

test('judge tool: ADD a fact, then noise short-circuits with no store write', async () => {
  const { graphStore, byName } = makeTools();
  const added = await run(byName, 'memory_v4_judge_message', { text: 'Tôi thích phở bò.', turnId: 't1' });
  assert.equal(added.added, 1);
  assert.equal(added.verdicts[0].decision, 'ADD');
  assert.equal(graphStore.findActiveFacts('user', 'likes', { userId: 'user-1', botId: 'bot-a', runId: 'run-1' }).length, 1);
  const noise = await run(byName, 'memory_v4_judge_message', { text: 'chào bạn!', turnId: 't2' });
  assert.ok(noise.noise !== null || noise.extracted === 0);
  assert.equal(graphStore.findActiveFacts('user', 'likes', { userId: 'user-1', botId: 'bot-a', runId: 'run-1' }).length, 1);
});

test('scored dream tool: promotes repeated facts into the human block', async () => {
  const { graphStore, blocksStore, byName } = makeTools();
  graphStore.ingestEpisode({ turnId: 'e1', runId: 'run-1', botId: 'bot-a', userId: 'user-1', role: 'user', text: 'Tôi thích phở bò.' });
  graphStore.ingestEpisode({ turnId: 'e2', runId: 'run-1', botId: 'bot-a', userId: 'user-1', role: 'user', text: 'Tôi thích phở bò.' });
  const report = await run(byName, 'memory_v4_scored_dream', { minScore: 0.5, maxPromote: 10 });
  assert.equal(report.episodesSeen, 2);
  assert.ok(report.promoted >= 1);
  assert.ok(blocksStore.get('human').content.includes('phở bò'));
});

test('validity tool: report, parse-hint, set-window, sweep', async () => {
  const { graphStore, byName } = makeTools();
  const added = await run(byName, 'memory_v4_judge_message', { text: 'Tôi sống ở Hà Nội.', turnId: 't1' });
  assert.equal(added.added, 1);
  const factId = graphStore.listFacts({ status: 'active' })[0].id;
  const hint = await run(byName, 'memory_v4_validity', { action: 'parse-hint', text: 'Tôi làm ở Acme từ 2020-01-01 đến 2024-12-31.' });
  assert.equal(hint.hint.validFrom, '2020-01-01T00:00:00.000Z');
  await run(byName, 'memory_v4_validity', { action: 'set-window', factId, validFrom: '2026-01-01T00:00:00.000Z', validUntil: '2026-11-01T00:00:00.000Z' });
  const report = await run(byName, 'memory_v4_validity', { action: 'report' });
  assert.equal(report.expired.length, 1);
  const sweep = await run(byName, 'memory_v4_validity', { action: 'sweep' });
  assert.equal(sweep.count, 1);
  assert.equal(graphStore.getFact(factId).status, 'deleted');
  const bad = await byName.get('memory_v4_validity').execute({ action: 'set-window', factId: 'nope' }, CTX);
  assert.ok(bad.startsWith('Error:'));
});

test('scoped recall tool: fused hits across stores, scoped to the caller', async () => {
  const { longTerm, byName } = makeTools();
  await run(byName, 'memory_v4_judge_message', { text: 'Tôi thích phở bò.', turnId: 't1' });
  longTerm.remember({ key: 'món ăn', value: 'phở bò', tags: [], confidence: 0.85, botId: 'bot-a', userId: 'user-1' });
  const result = await run(byName, 'memory_v4_scoped_recall', { query: 'phở bò' });
  assert.ok(result.hits.length >= 2);
  assert.ok(result.hits.some((h) => h.source === 'graph'));
  assert.ok(result.hits.some((h) => h.source === 'longterm'));
  const empty = await run(byName, 'memory_v4_scoped_recall', { query: 'chuyện không tồn tại' });
  assert.equal(empty.hits.length, 0);
});

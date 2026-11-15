/**
 * Tests for v1.06 (Team T1) — memory v7 tools:
 * packages/tools/src/memoryV7Tools.ts.
 *
 * Covers: tool registration (9 tools, unique names, approval flags
 * match read/write), block create/list/update (git-backed, version
 * bumps), the system-scope guardrail (agent update of human/persona
 * is refused with a clear error, user-scope blocks are editable),
 * one-step promote/demote, prompt recompile (first call recompiles
 * everything, second call reuses the cache, editing one block
 * recompiles only that block), block history (git log entries with
 * versions), episodic search (expired items never hit), tiers status
 * (counts + consolidation dry-run). Placeholder tools (no
 * workspaceDir) refuse with a clear error instead of crashing.
 *
 * Run after building core + tools:
 *   npm run build --workspace=@open-bot/core
 *   npm run build --workspace=@open-bot/tools
 *   node --test tests/memory-v7-tools-v106.test.mjs
 *
 * No network. No model.
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { MemoryBlockStore } from '../packages/core/dist/index.js';
import {
  createMemoryV7Tools,
  MEMORY_V7_TOOLS,
  MEMORY_V7_TOOL_NAMES,
  importV96BlocksIntoV7,
} from '../packages/tools/dist/memoryV7Tools.js';
import { GitMemoryProjection } from '../packages/core/dist/index.js';

const tempDirs = [];
function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-memv7-tools-v106-'));
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
  const tools = createMemoryV7Tools({ workspaceDir: dir, getUserId: () => 'user-1' });
  const byName = new Map(tools.map((t) => [t.definition.name, t]));
  return { dir, tools, byName };
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

test('registration: 10 tools, unique names, approval flags match read/write', () => {
  assert.equal(MEMORY_V7_TOOLS.length, 10);
  assert.equal(MEMORY_V7_TOOL_NAMES.length, 10);
  const names = MEMORY_V7_TOOLS.map((t) => t.definition.name);
  assert.equal(new Set(names).size, 10);
  assert.deepEqual([...names].sort(), [...MEMORY_V7_TOOL_NAMES].sort());
  const needsApproval = Object.fromEntries(
    MEMORY_V7_TOOLS.map((t) => [t.definition.name, t.needsApproval]),
  );
  assert.equal(needsApproval.memory_v7_block_create, true);
  assert.equal(needsApproval.memory_v7_block_update, true);
  assert.equal(needsApproval.memory_v7_block_list, false);
  assert.equal(needsApproval.memory_v7_block_promote, true);
  assert.equal(needsApproval.memory_v7_block_demote, true);
  assert.equal(needsApproval.memory_v7_prompt_recompile, false);
  assert.equal(needsApproval.memory_v7_block_history, false);
  assert.equal(needsApproval.memory_v7_episodic_search, false);
  assert.equal(needsApproval.memory_v7_tiers_status, false);
  assert.equal(needsApproval.memory_v7_consolidate, true);
  for (const tool of MEMORY_V7_TOOLS) {
    assert.ok(tool.definition.description.length > 20);
    assert.equal(tool.definition.parameters.additionalProperties, false);
  }
});

test('placeholder tools (no workspaceDir) refuse with a clear error', async () => {
  const byName = new Map(createMemoryV7Tools().map((t) => [t.definition.name, t]));
  const raw = await runRaw(byName, 'memory_v7_block_list', {});
  assert.ok(raw.startsWith('Error:'));
  assert.ok(raw.includes('workspaceDir'));
});

test('block create/list: system labels become scope system, file lands on disk', async () => {
  const { dir, byName } = makeTools();
  const created = await run(byName, 'memory_v7_block_create', {
    label: 'human',
    content: 'Tên Huy.',
    description: 'Về user.',
  });
  assert.equal(created.block.scope, 'system');
  assert.equal(created.block.version, 1);
  assert.equal(created.block.contentHash.length, 64);
  const listed = await run(byName, 'memory_v7_block_list', {});
  assert.equal(listed.blocks.length, 1);
  assert.equal(listed.blocks[0].label, 'human');
  assert.ok(fs.existsSync(path.join(dir, '.open-bot', 'memory-v7', 'blocks', 'human.md')));
  const dup = await runRaw(byName, 'memory_v7_block_create', { label: 'human', content: 'x' });
  assert.ok(dup.startsWith('Error:'));
  const badTier = await runRaw(byName, 'memory_v7_block_create', { label: 'z', tier: 'forever' });
  assert.ok(badTier.startsWith('Error:'));
});

test('block update: agent cannot edit system blocks (guardrail), user-scope blocks are editable', async () => {
  const { byName } = makeTools();
  await run(byName, 'memory_v7_block_create', { label: 'human', content: 'Tên Huy.' });
  await run(byName, 'memory_v7_block_create', { label: 'notes', content: 'Ghi chú.', tier: 'working' });
  // The tool runs as agent:bot-a, so updating the system block must fail.
  const refused = await runRaw(byName, 'memory_v7_block_update', {
    label: 'human',
    action: 'replace',
    content: 'Agent đổi lén.',
  });
  assert.ok(refused.startsWith('Error:'));
  assert.ok(refused.includes('hệ thống'));
  // User-scope block: append works, version bumps.
  const appended = await run(byName, 'memory_v7_block_update', {
    label: 'notes',
    action: 'append',
    content: 'Dòng mới.',
  });
  assert.equal(appended.block.version, 2);
  assert.ok(appended.block.content.includes('Dòng mới.'));
  const badAction = await runRaw(byName, 'memory_v7_block_update', { label: 'notes', action: 'explode' });
  assert.ok(badAction.startsWith('Error:'));
});

test('block promote/demote: one step at a time, top and bottom refuse', async () => {
  const { byName } = makeTools();
  await run(byName, 'memory_v7_block_create', { label: 'todo', content: 'Việc cần nhớ.', tier: 'working' });
  const up1 = await run(byName, 'memory_v7_block_promote', { label: 'todo' });
  assert.equal(up1.fromTier, 'working');
  assert.equal(up1.toTier, 'session');
  const up2 = await run(byName, 'memory_v7_block_promote', { label: 'todo' });
  assert.equal(up2.toTier, 'episodic');
  const up3 = await run(byName, 'memory_v7_block_promote', { label: 'todo' });
  assert.equal(up3.toTier, 'semantic');
  const top = await runRaw(byName, 'memory_v7_block_promote', { label: 'todo' });
  assert.ok(top.startsWith('Error:'));
  const down = await run(byName, 'memory_v7_block_demote', { label: 'todo' });
  assert.equal(down.toTier, 'episodic');
  await run(byName, 'memory_v7_block_demote', { label: 'todo' });
  await run(byName, 'memory_v7_block_demote', { label: 'todo' });
  const bottom = await runRaw(byName, 'memory_v7_block_demote', { label: 'todo' });
  assert.ok(bottom.startsWith('Error:'));
  const missing = await runRaw(byName, 'memory_v7_block_promote', { label: 'nope' });
  assert.ok(missing.startsWith('Error:'));
});

test('prompt recompile: first call recompiles all, second reuses cache, one edit recompiles one block', async () => {
  const { byName } = makeTools();
  await run(byName, 'memory_v7_block_create', { label: 'human', content: 'Tên Huy.' });
  await run(byName, 'memory_v7_block_create', { label: 'notes', content: 'Ghi chú.', tier: 'working' });
  // The factory holds one shared recompiler, so the second call
  // reuses every unchanged block from cache.
  const first = await run(byName, 'memory_v7_prompt_recompile', {});
  assert.ok(first.prompt.includes('<memory label="human"'));
  assert.ok(first.prompt.includes('Tên Huy.'));
  assert.equal(first.blocks.length, 2);
  assert.equal(first.promptHash.length, 64);
  assert.equal(first.recompiledCount, 2);
  assert.equal(first.reusedCount, 0);
  const cached = await run(byName, 'memory_v7_prompt_recompile', {});
  assert.equal(cached.recompiledCount, 0);
  assert.equal(cached.reusedCount, 2);
  assert.equal(cached.promptHash, first.promptHash);
  await run(byName, 'memory_v7_block_update', { label: 'notes', action: 'replace', content: 'Ghi chú mới.' });
  const second = await run(byName, 'memory_v7_prompt_recompile', {});
  assert.notEqual(second.promptHash, first.promptHash);
  assert.ok(second.prompt.includes('Ghi chú mới.'));
  assert.equal(second.recompiledCount, 1);
  assert.equal(second.reusedCount, 1);
});

test('prompt recompile with a shared recompiler: unchanged blocks are reused', async () => {
  const dir = makeTempDir();
  const { PromptRecompiler } = await import('../packages/core/dist/index.js');
  const recompiler = new PromptRecompiler();
  const tools = createMemoryV7Tools({ workspaceDir: dir, recompiler });
  const byName = new Map(tools.map((t) => [t.definition.name, t]));
  await run(byName, 'memory_v7_block_create', { label: 'human', content: 'Tên Huy.' });
  await run(byName, 'memory_v7_block_create', { label: 'notes', content: 'Ghi chú.', tier: 'working' });
  const first = await run(byName, 'memory_v7_prompt_recompile', {});
  assert.equal(first.recompiledCount, 2);
  assert.equal(first.reusedCount, 0);
  const second = await run(byName, 'memory_v7_prompt_recompile', {});
  assert.equal(second.recompiledCount, 0);
  assert.equal(second.reusedCount, 2);
  assert.equal(second.promptHash, first.promptHash);
  await run(byName, 'memory_v7_block_update', { label: 'notes', action: 'append', content: 'Thêm.' });
  const third = await run(byName, 'memory_v7_prompt_recompile', {});
  assert.equal(third.recompiledCount, 1);
  assert.equal(third.reusedCount, 1);
});

test('block history: versions accumulate per edit (git or JSONL fallback)', async () => {
  const { byName } = makeTools();
  await run(byName, 'memory_v7_block_create', { label: 'log', content: 'v1' });
  await run(byName, 'memory_v7_block_update', { label: 'log', action: 'replace', content: 'v2' });
  await run(byName, 'memory_v7_block_update', { label: 'log', action: 'append', content: 'v3 line' });
  const hist = await run(byName, 'memory_v7_block_history', { label: 'log', limit: 10 });
  assert.ok(hist.history.length >= 3, `expected >=3 entries, got ${hist.history.length}`);
  assert.equal(hist.history[0].version, 3);
  assert.ok(hist.history[0].contentPreview.includes('v3 line'));
  const withBlame = await run(byName, 'memory_v7_block_history', { label: 'log', includeBlame: true });
  assert.ok(Array.isArray(withBlame.blame));
});

test('episodic search + tiers status: keyword hits, dry-run consolidation report', async () => {
  const { dir, byName } = makeTools();
  // Seed episodic items directly through the tiered store.
  const { TieredMemoryStore } = await import('../packages/core/dist/index.js');
  const tiers = new TieredMemoryStore(dir);
  tiers.add('episodic', { label: 'pho-hn', content: 'User ăn phở ở Hà Nội.', score: 0.9 });
  tiers.add('episodic', { label: 'bun-hue', content: 'User ăn bún bò Huế.', score: 0.9 });
  const found = await run(byName, 'memory_v7_episodic_search', { query: 'phở Hà Nội' });
  assert.equal(found.hits.length, 1);
  assert.equal(found.hits[0].label, 'pho-hn');
  const status = await run(byName, 'memory_v7_tiers_status', {});
  assert.equal(status.tiers.length, 4);
  const epi = status.tiers.find((t) => t.tier === 'episodic');
  assert.equal(epi.count, 2);
  assert.equal(status.consolidationDryRun.episodicToSemantic, 0);
});

test('consolidate tool: dry-run reports, real run moves working items to session', async () => {
  const { dir, byName } = makeTools();
  const { TieredMemoryStore } = await import('../packages/core/dist/index.js');
  const tiers = new TieredMemoryStore(dir);
  tiers.add('working', { label: 'w-note', content: 'Working note.', score: 0.4 });
  tiers.add('session', { label: 's-strong', content: 'Strong fact.', score: 0.9 });
  const dry = await run(byName, 'memory_v7_consolidate', { dryRun: true });
  assert.equal(dry.report.workingToSession, 1);
  assert.equal(dry.report.sessionToEpisodic, 1);
  assert.equal(tiers.get('w-note')?.tier, 'working');
  const real = await run(byName, 'memory_v7_consolidate', {});
  assert.equal(real.report.workingToSession, 1);
  assert.equal(real.report.sessionToEpisodic, 1);
  assert.equal(tiers.get('w-note')?.tier, 'session');
  assert.equal(tiers.get('s-strong')?.tier, 'episodic');
});

test('importV96BlocksIntoV7: old JSON blocks land in the git projection', async () => {
  const dir = makeTempDir();
  const blocksStore = new MemoryBlockStore(dir);
  blocksStore.create({ label: 'human', content: 'Tên Huy.', description: 'Về user.' });
  blocksStore.create({ label: 'legacy', content: 'Block cũ.', description: 'Từ v0.96' });
  const projection = new GitMemoryProjection(dir);
  const n = importV96BlocksIntoV7(projection, blocksStore, 'user');
  assert.equal(n, 2);
  assert.equal(projection.get('legacy')?.content, 'Block cũ.');
  assert.equal(projection.get('human')?.scope, 'system');
  const again = importV96BlocksIntoV7(projection, blocksStore, 'user');
  assert.equal(again, 0);
});

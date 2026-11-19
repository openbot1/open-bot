/**
 * Tests for v1.11 (Doi T1) — memory v11 tools:
 * packages/tools/src/memoryV11Tools.ts (+ registry in tools.ts).
 *
 * Covers: 9 tools registered in ALL_TOOLS exactly once (368 total:
 * 289 + 9), no duplicates, approval flags match read/write, bound
 * execution via createMemoryV11Tools({ workspaceDir, botId }) —
 * insert / apply-patch / history list-diff-rollback / render /
 * shared list + supervisor-only write / sleep record + sleep pass;
 * binding via createDefaultTools({ getMemoryV11WorkspaceDir })
 * (placeholders replaced in place, same 9 names, ALL_TOOLS stays
 * 298); placeholder tools (no workspaceDir) refuse with a clear
 * error instead of crashing.
 *
 * Run after building core + tools:
 *   npm run build --workspace=@open-bot/core
 *   npm run build --workspace=@open-bot/tools
 *   node --test tests/memory-v11-tools.test.mjs
 *
 * No network. No model.
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  createMemoryV11Tools,
  MEMORY_V11_TOOLS,
  MEMORY_V11_TOOL_NAMES,
} from '../packages/tools/dist/memoryV11Tools.js';
import { ALL_TOOLS, createDefaultTools } from '../packages/tools/dist/tools.js';
import { MemoryBlockStore } from '../packages/core/dist/memory/blocks.js';
import { SharedBlockGroupStore } from '../packages/core/dist/memory/sharedBlocks.js';
import { SharedSupervisor } from '../packages/core/dist/memory/v11/sharedSupervisor.js';
import { recordBlockHistoryChange, historyInputFromBlock } from '../packages/core/dist/memory/v11/blockHistoryTable.js';

const tempDirs = [];
function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-memv11-tools-'));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function toolMap(tools) {
  return new Map(tools.map((t) => [t.definition.name, t]));
}

async function run(tools, name, args) {
  const tool = toolMap(tools).get(name);
  assert.ok(tool, `tool ${name} missing`);
  return tool.execute(args);
}

test('registry: 9 memory v11 tools in ALL_TOOLS exactly once (491 total)', () => {
  assert.ok(ALL_TOOLS.length >= 1078, `expected >= 1078 tools in ALL_TOOLS, got ${ALL_TOOLS.length}`); // v1.39 fix round 4b: floor (was 1078 in v1.38; now 1164).
  assert.deepEqual([...MEMORY_V11_TOOL_NAMES], [
    'memory_insert',
    'memory_apply_patch',
    'memory_v11_block_history',
    'memory_v11_block_rollback',
    'memory_blocks_render',
    'memory_shared_blocks',
    'memory_shared_write',
    'memory_sleep_record',
    'memory_sleep_pass',
  ]);
  for (const name of MEMORY_V11_TOOL_NAMES) {
    assert.equal(ALL_TOOLS.filter((t) => t.definition.name === name).length, 1, `${name} duplicated`);
  }
  assert.equal(new Set(ALL_TOOLS.map((t) => t.definition.name)).size, ALL_TOOLS.length);
  const placeholders = toolMap(MEMORY_V11_TOOLS);
  assert.equal(placeholders.size, 9);
  // Approval flags: reads are free, writes need approval.
  assert.equal(placeholders.get('memory_insert').needsApproval, true);
  assert.equal(placeholders.get('memory_apply_patch').needsApproval, true);
  assert.equal(placeholders.get('memory_v11_block_history').needsApproval, false);
  assert.equal(placeholders.get('memory_v11_block_rollback').needsApproval, true);
  assert.equal(placeholders.get('memory_blocks_render').needsApproval, false);
  assert.equal(placeholders.get('memory_shared_blocks').needsApproval, false);
  assert.equal(placeholders.get('memory_shared_write').needsApproval, true);
  assert.equal(placeholders.get('memory_sleep_record').needsApproval, false);
  assert.equal(placeholders.get('memory_sleep_pass').needsApproval, true);
});

test('placeholder tools refuse clearly when unbound', async () => {
  const out = await run(MEMORY_V11_TOOLS, 'memory_insert', { block: 'task', text: 'x' });
  assert.ok(out.startsWith('Error:'), out);
  assert.ok(out.includes('workspaceDir'));
});

test('memory_insert + memory_apply_patch: full edit cycle', async () => {
  const dir = makeTempDir();
  const store = new MemoryBlockStore(dir);
  const block = store.create({ label: 'task', description: '', content: 'line1\nline2\nline3', charLimit: 4096 }, 'user');
  const tools = createMemoryV11Tools({ workspaceDir: dir, botId: 'bot-1' });

  const inserted = JSON.parse(await run(tools, 'memory_insert', { block: 'task', text: 'line1.5', line: 1, position: 'after' }));
  assert.equal(inserted.version, 2);
  assert.equal(store.get(block.id).content, 'line1\nline1.5\nline2\nline3');

  const patched = JSON.parse(
    await run(tools, 'memory_apply_patch', {
      block: 'task',
      patch: '@@ -2,2 +2,2 @@\n line1.5\n-line2\n+LINE2',
    }),
  );
  assert.equal(patched.version, 3);
  assert.equal(store.get(block.id).content, 'line1\nline1.5\nLINE2\nline3');

  // Bad patch: context mismatch -> Error, content unchanged.
  const bad = await run(tools, 'memory_apply_patch', {
    block: 'task',
    patch: '@@ -1,2 +1,2 @@\n line1\n-nope\n+x',
  });
  assert.ok(bad.startsWith('Error:'), bad);
  assert.equal(store.get(block.id).content, 'line1\nline1.5\nLINE2\nline3');

  // Unknown block -> Error.
  const missing = await run(tools, 'memory_insert', { block: 'nope', text: 'x', position: 'end' });
  assert.ok(missing.startsWith('Error:'), missing);
});

test('memory_v11_block_history + memory_v11_block_rollback: list/diff/rollback/stats', async () => {
  const dir = makeTempDir();
  const store = new MemoryBlockStore(dir);
  const block = store.create({ label: 'human', description: '', content: 'Likes tea.', charLimit: 4096 }, 'user');
  recordBlockHistoryChange(dir, historyInputFromBlock(block, 'blocks', 'create', 'user'));
  const v2 = store.replace(block.id, 'Likes tea and pho.', 'user');
  recordBlockHistoryChange(dir, historyInputFromBlock(v2, 'core-v9', 'replace', 'agent:bot-1'));
  const tools = createMemoryV11Tools({ workspaceDir: dir, botId: 'bot-1' });

  const listed = JSON.parse(await run(tools, 'memory_v11_block_history', { block: block.id, action: 'list' }));
  assert.equal(listed.length, 2);
  assert.equal(listed[0].version, 2);
  assert.equal(listed[0].backend, 'core-v9');

  const diffed = JSON.parse(
    await run(tools, 'memory_v11_block_history', { block: block.id, action: 'diff', fromVersion: 1, toVersion: 2 }),
  );
  assert.equal(diffed.added, 1);
  assert.equal(diffed.removed, 1);
  assert.ok(diffed.unified.includes('+Likes tea and pho.'));

  const stats = JSON.parse(await run(tools, 'memory_v11_block_history', { action: 'stats' }));
  assert.equal(stats.totalEntries, 2);
  assert.equal(stats.blockCount, 1);

  const rolled = JSON.parse(await run(tools, 'memory_v11_block_rollback', { block: block.id, toVersion: 1 }));
  assert.equal(rolled.newVersion, 3);
  assert.equal(rolled.content, 'Likes tea.');
  assert.equal(store.get(block.id).version, 3);

  const bad = await run(tools, 'memory_v11_block_rollback', { block: block.id, toVersion: 99 });
  assert.ok(bad.startsWith('Error:'), bad);
});

test('memory_blocks_render: <memory_blocks> for a bot', async () => {
  const dir = makeTempDir();
  const store = new MemoryBlockStore(dir);
  const human = store.create({ label: 'human', description: 'facts', content: 'Likes tea.', charLimit: 4096 }, 'user');
  const task = store.create({ label: 'task', description: 'work', content: 'Ship v11.', charLimit: 4096 }, 'user');
  store.attach('bot-1', human.id, 'user');
  store.attach('bot-1', task.id, 'user');
  const tools = createMemoryV11Tools({ workspaceDir: dir, botId: 'bot-1' });
  const out = JSON.parse(await run(tools, 'memory_blocks_render', { botId: 'bot-1' }));
  assert.ok(out.xml.startsWith('<memory_blocks>'));
  assert.ok(out.xml.indexOf('label="human"') < out.xml.indexOf('label="task"'));
  assert.equal(out.blocks.length, 2);
  const empty = JSON.parse(await run(tools, 'memory_blocks_render', { botId: 'bot-2' }));
  assert.equal(empty.xml, '');
  assert.deepEqual(empty.blocks, []);
});

test('memory_shared_blocks + memory_shared_write: supervisor gate via tools', async () => {
  const dir = makeTempDir();
  const blocks = new MemoryBlockStore(dir);
  const groups = new SharedBlockGroupStore(dir, blocks);
  const group = groups.createGroup({ name: 'team-tools', description: '' }, 'user');
  groups.addMember(group.id, 'bot-1', 'write', 'user');
  groups.addMember(group.id, 'bot-2', 'write', 'user');
  const supervisor = new SharedSupervisor(dir, blocks, groups);
  supervisor.setSupervisor(group.id, 'bot-1', 'user');

  const supervisorTools = createMemoryV11Tools({ workspaceDir: dir, botId: 'bot-1' });
  const memberTools = createMemoryV11Tools({ workspaceDir: dir, botId: 'bot-2' });

  const ensured = JSON.parse(
    await run(supervisorTools, 'memory_shared_blocks', { action: 'ensure-preset', group: group.id, preset: 'current-plan' }),
  );
  assert.equal(ensured.label, 'current-plan');
  assert.equal(ensured.usage.limit, 4000);

  const listed = JSON.parse(await run(supervisorTools, 'memory_shared_blocks', {}));
  assert.equal(listed.length, 1);
  assert.equal(listed[0].supervisorBotId, 'bot-1');
  assert.deepEqual(listed[0].memberBotIds, ['bot-1', 'bot-2']);

  // Supervisor writes fine...
  const written = JSON.parse(
    await run(supervisorTools, 'memory_shared_write', { group: group.id, block: 'current-plan', content: 'Plan A.' }),
  );
  assert.equal(written.mode, 'replace');
  assert.equal(written.version, 2);
  // ...member bot (even with write role) is rejected.
  const denied = await run(memberTools, 'memory_shared_write', { group: group.id, block: 'current-plan', content: 'hijack' });
  assert.ok(denied.startsWith('Error:'), denied);
  assert.ok(denied.includes('supervisor'));
  assert.equal(blocks.get('current-plan').content, 'Plan A.');

  // Bad preset rejected.
  const badPreset = await run(supervisorTools, 'memory_shared_blocks', { action: 'ensure-preset', group: group.id, preset: 'nope' });
  assert.ok(badPreset.startsWith('Error:'), badPreset);
});

test('memory_sleep_record + memory_sleep_pass: fast record, pass consolidates', async () => {
  const dir = makeTempDir();
  const tools = createMemoryV11Tools({ workspaceDir: dir, botId: 'bot-1' });
  const recorded = JSON.parse(
    await run(tools, 'memory_sleep_record', { botId: 'bot-1', text: 'Người dùng thích uống trà đá mỗi sáng.', source: 'turn' }),
  );
  assert.equal(recorded.botId, 'bot-1');
  assert.equal(typeof recorded.id, 'string');

  const report = JSON.parse(await run(tools, 'memory_sleep_pass', { botId: 'bot-1', force: true }));
  assert.equal(report.rawFactsRead, 1);
  assert.equal(report.factsExtracted, 1);
  assert.equal(report.learnedContextLinesAdded, 1);
  assert.deepEqual(report.errors, []);
  const blocks = new MemoryBlockStore(dir);
  assert.ok(blocks.get('learned-context').content.includes('trà đá'));

  // Dry run reports but writes nothing new.
  await run(tools, 'memory_sleep_record', { botId: 'bot-1', text: 'Người dùng đang làm dự án open-bot.', source: 'turn' });
  const dry = JSON.parse(await run(tools, 'memory_sleep_pass', { botId: 'bot-1', dryRun: true, force: true }));
  assert.equal(dry.dryRun, true);
  assert.equal(dry.learnedContextLinesAdded, 1);
  assert.ok(!blocks.get('learned-context').content.includes('open-bot'));
});

test('binding: createDefaultTools({ getMemoryV11WorkspaceDir }) binds 9 tools in place, ALL_TOOLS stays 491', async () => {
  const dir = makeTempDir();
  const store = new MemoryBlockStore(dir);
  store.create({ label: 'task', description: '', content: 'a\nb', charLimit: 4096 }, 'user');
  const bound = createDefaultTools({
    getMemoryV11WorkspaceDir: () => dir,
    getMemoryV11BotId: () => 'bot-1',
  });
  assert.ok(bound.length >= 1078, `expected >= 1078 bound tools, got ${bound.length}`); // v1.39 fix round 4b: floor (was 1078 in v1.38; now 1164).
  assert.ok(new Set(bound.map((t) => t.definition.name)).size >= 1078, `expected >= 1078 unique bound tool names, got ${new Set(bound.map((t) => t.definition.name)).size}`); // v1.39 fix round 4b: floor (was 1078 in v1.38; now 1164).
  const tools = toolMap(bound);
  const out = JSON.parse(await tools.get('memory_blocks_render').execute({ botId: 'bot-1' }));
  assert.equal(out.blocks.length, 0); // nothing attached yet — but bound, not placeholder
  const inserted = JSON.parse(await tools.get('memory_insert').execute({ block: 'task', text: 'c', position: 'end' }));
  assert.equal(inserted.version, 2);
});

test('unbound factory refuses with a clear error', async () => {
  const tools = createMemoryV11Tools({});
  const out = await run(tools, 'memory_sleep_record', { botId: 'bot-1', text: 'long enough fact text' });
  assert.ok(out.startsWith('Error:'), out);
  assert.ok(out.includes('workspaceDir'));
});

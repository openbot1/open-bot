/**
 * Tests for v1.12 (Doi T1) — memory v12 tools:
 * packages/tools/src/memoryV12Tools.ts (+ registry in tools.ts).
 *
 * Covers: 9 tools registered in ALL_TOOLS exactly once (368 total),
 * no duplicates, approval flags match read/write, placeholder tools
 * (no workspaceDir) refuse with a clear error instead of crashing,
 * bound execution via createMemoryV12Tools({ blocksStore, botId }) —
 * exact edit (success / ambiguous / dry-run), search, tokens,
 * compile, system block (list works, agent writes refused — the
 * system-block guarantee via tool), audit trail, sleep janitor
 * (dry-run + real run), binding via createDefaultTools
 * ({ getMemoryV12WorkspaceDir, getMemoryV12BotId }) keeps 368 tools.
 *
 * Run after building core + tools:
 *   npm run build --workspace=@open-bot/core
 *   npm run build --workspace=@open-bot/tools
 *   node --test tests/memory-v12-tools.test.mjs
 *
 * No network. No model.
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  createMemoryV12Tools,
  MEMORY_V12_TOOLS,
  MEMORY_V12_TOOL_NAMES,
} from '../packages/tools/dist/memoryV12Tools.js';
import { ALL_TOOLS, createDefaultTools } from '../packages/tools/dist/tools.js';
import { MemoryBlockStore } from '../packages/core/dist/memory/blocks.js';
import { ensureSystemBlock } from '../packages/core/dist/memory/v12/systemBlocks.js';

const tempDirs = [];
function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-memv12-tools-'));
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

async function run(tools, name, args, ctx) {
  const tool = toolMap(tools).get(name);
  assert.ok(tool, `tool ${name} missing`);
  return tool.execute(args, ctx);
}

const CTX = { botId: 'bot-1', workspaceDir: '' };

function seedStore(dir) {
  const store = new MemoryBlockStore(dir);
  const human = store.create(
    { label: 'human', description: '', content: 'Tên: Huy.\nThích cà phê.', charLimit: 4096 },
    'user',
  );
  const persona = store.create(
    { label: 'persona', description: '', content: 'Hài hước.', charLimit: 2048 },
    'user',
  );
  store.attach('bot-1', human.id, 'user');
  store.attach('bot-1', persona.id, 'user');
  return store;
}

test('registry: 9 memory v12 tools in ALL_TOOLS exactly once (491 total)', () => {
  assert.equal(ALL_TOOLS.length, 899); // v1.36 re-pin: 825 + 74 = 899.
  assert.deepEqual([...MEMORY_V12_TOOL_NAMES], [
    'memory_block_edit',
    'memory_block_search',
    'memory_block_tokens',
    'memory_blocks_compile',
    'memory_system_block',
    'memory_block_audit',
    'memory_sleep_janitor',
    'memory_blocks_export',
    'memory_blocks_import',
  ]);
  for (const name of MEMORY_V12_TOOL_NAMES) {
    assert.equal(ALL_TOOLS.filter((t) => t.definition.name === name).length, 1, `${name} duplicated`);
  }
  assert.equal(new Set(ALL_TOOLS.map((t) => t.definition.name)).size, ALL_TOOLS.length);
  const placeholders = toolMap(MEMORY_V12_TOOLS);
  assert.equal(placeholders.size, 9);
  // Approval flags: reads are free, writes need approval.
  assert.equal(placeholders.get('memory_block_edit').needsApproval, true);
  assert.equal(placeholders.get('memory_block_search').needsApproval, false);
  assert.equal(placeholders.get('memory_block_tokens').needsApproval, false);
  assert.equal(placeholders.get('memory_blocks_compile').needsApproval, false);
  assert.equal(placeholders.get('memory_system_block').needsApproval, true);
  assert.equal(placeholders.get('memory_block_audit').needsApproval, false);
  assert.equal(placeholders.get('memory_sleep_janitor').needsApproval, true);
  assert.equal(placeholders.get('memory_blocks_export').needsApproval, false);
  assert.equal(placeholders.get('memory_blocks_import').needsApproval, true);
});

test('registry: placeholder tools refuse with a clear error, not a crash', async () => {
  const out = await run(MEMORY_V12_TOOLS, 'memory_block_edit', {
    block: 'human',
    oldText: 'a',
    newText: 'b',
  });
  assert.match(out, /^Error: memory v12 chưa được hỗ trợ/);
  const search = await run(MEMORY_V12_TOOLS, 'memory_block_search', { query: 'Huy' });
  assert.match(search, /^Error: memory v12 chưa được hỗ trợ/);
});

test('tools: memory_block_edit succeeds, bumps version, next compile sees it', async () => {
  const dir = makeTempDir();
  const store = seedStore(dir);
  const tools = createMemoryV12Tools({ blocksStore: store, botId: 'bot-1' });
  const edited = JSON.parse(
    await run(tools, 'memory_block_edit', {
      block: 'human',
      oldText: 'cà phê',
      newText: 'trà đá',
    }, CTX),
  );
  assert.equal(edited.edited, true);
  assert.equal(edited.block.version, 2);
  assert.ok(edited.tokensAfter > 0);
  const compiled = JSON.parse(
    await run(tools, 'memory_blocks_compile', { botId: 'bot-1' }, CTX),
  );
  assert.ok(compiled.prompt.includes('trà đá'));
  assert.ok(!compiled.prompt.includes('cà phê'));
  assert.equal(compiled.blocks.find((b) => b.label === 'human').version, 2);
});

test('tools: memory_block_edit dry-run previews without writing', async () => {
  const dir = makeTempDir();
  const store = seedStore(dir);
  const tools = createMemoryV12Tools({ blocksStore: store, botId: 'bot-1' });
  const preview = JSON.parse(
    await run(tools, 'memory_block_edit', {
      block: 'human',
      oldText: 'cà phê',
      newText: 'trà đá',
      dryRun: true,
    }, CTX),
  );
  assert.equal(preview.dryRun, true);
  assert.match(preview.contentAfter, /trà đá/);
  assert.equal(store.get('human').version, 1);
  assert.match(store.get('human').content, /cà phê/);
});

test('tools: memory_block_edit refuses ambiguous oldText', async () => {
  const dir = makeTempDir();
  const store = seedStore(dir);
  store.replace('human', 'thích A, thích B', 'user');
  const tools = createMemoryV12Tools({ blocksStore: store, botId: 'bot-1' });
  const out = await run(tools, 'memory_block_edit', {
    block: 'human',
    oldText: 'thích',
    newText: 'mê',
  }, CTX);
  assert.match(out, /^Error: .*3 lần|2 lần/);
  assert.match(out, /occurrence/);
  // With occurrence it works.
  const ok = JSON.parse(
    await run(tools, 'memory_block_edit', {
      block: 'human',
      oldText: 'thích',
      newText: 'mê',
      occurrence: 1,
    }, CTX),
  );
  assert.equal(ok.edited, true);
  assert.match(store.get('human').content, /thích A, mê B/);
});

test('tools: memory_block_edit on a system block is REFUSED (agent cannot write it)', async () => {
  const dir = makeTempDir();
  const store = seedStore(dir);
  ensureSystemBlock(store, 'bot-1', 'safety', 'user');
  const tools = createMemoryV12Tools({ blocksStore: store, botId: 'bot-1' });
  const out = await run(tools, 'memory_block_edit', {
    block: 'safety',
    oldText: 'Safety boundaries',
    newText: 'No boundaries',
  }, CTX);
  assert.match(out, /^Error: .*block hệ thống/);
  assert.equal(store.get('safety').version, 1);
  assert.match(store.get('safety').content, /Safety boundaries/);
});

test('tools: memory_block_search finds the fact with a snippet', async () => {
  const dir = makeTempDir();
  const store = seedStore(dir);
  const tools = createMemoryV12Tools({ blocksStore: store, botId: 'bot-1' });
  const found = JSON.parse(
    await run(tools, 'memory_block_search', { query: 'cà phê' }, CTX),
  );
  assert.equal(found.count, 1);
  assert.equal(found.matches[0].label, 'human');
  assert.match(found.matches[0].snippet, /cà phê/);
  const none = JSON.parse(
    await run(tools, 'memory_block_search', { query: 'không-có' }, CTX),
  );
  assert.equal(none.count, 0);
});

test('tools: memory_block_tokens reports per-block usage + total vs budget', async () => {
  const dir = makeTempDir();
  const store = seedStore(dir);
  const tools = createMemoryV12Tools({ blocksStore: store, botId: 'bot-1' });
  const report = JSON.parse(
    await run(tools, 'memory_block_tokens', { botId: 'bot-1', totalTokenBudget: 4000 }, CTX),
  );
  assert.equal(report.budget, 4000);
  assert.equal(report.overBudget, false);
  assert.equal(report.blocks.length, 2);
  const human = report.blocks.find((b) => b.label === 'human');
  assert.equal(human.tokenLimit, 1024);
  assert.ok(human.tokens > 0);
  assert.equal(human.state, 'ok');
});

test('tools: memory_system_block list works; agent ensure/protect/unprotect are refused', async () => {
  const dir = makeTempDir();
  const store = seedStore(dir);
  ensureSystemBlock(store, 'bot-1', 'safety', 'user');
  const tools = createMemoryV12Tools({ blocksStore: store, botId: 'bot-1' });
  const listed = JSON.parse(await run(tools, 'memory_system_block', { action: 'list' }, CTX));
  assert.equal(listed.systemBlocks.length, 1);
  assert.equal(listed.systemBlocks[0].label, 'safety');
  assert.equal(listed.systemBlocks[0].systemOwned, true);
  for (const action of ['ensure', 'protect', 'unprotect']) {
    const out = await run(tools, 'memory_system_block', { action, label: 'safety' }, CTX);
    assert.match(out, /^Error: /, `${action} should be refused for the agent`);
    assert.match(out, /user|agent bị chặn|block hệ thống/);
  }
  assert.equal(store.get('safety').version, 1);
});

test('tools: memory_block_audit shows who edited what', async () => {
  const dir = makeTempDir();
  const store = seedStore(dir);
  const tools = createMemoryV12Tools({ blocksStore: store, botId: 'bot-1' });
  await run(tools, 'memory_block_edit', {
    block: 'human',
    oldText: 'cà phê',
    newText: 'trà đá',
  }, CTX);
  const audit = JSON.parse(await run(tools, 'memory_block_audit', { block: 'human' }, CTX));
  assert.ok(audit.count >= 1);
  assert.ok(audit.entries.some((e) => e.action === 'replace' && e.actor === 'agent:bot-1'));
  const filtered = JSON.parse(
    await run(tools, 'memory_block_audit', { block: 'human', actor: 'user' }, CTX),
  );
  assert.ok(filtered.entries.every((e) => e.actor === 'user'));
});

test('tools: memory_sleep_janitor dry-run then real run', async () => {
  const dir = makeTempDir();
  const store = seedStore(dir);
  store.replace('human', '- a\n- a\n- b', 'user');
  const tools = createMemoryV12Tools({ blocksStore: store, botId: 'bot-1' });
  const dry = JSON.parse(
    await run(tools, 'memory_sleep_janitor', { botId: 'bot-1', dryRun: true }, CTX),
  );
  assert.equal(dry.dryRun, true);
  assert.equal(dry.linesDeduped, 1);
  assert.match(store.get('human').content, /- a\n- a/);
  const real = JSON.parse(
    await run(tools, 'memory_sleep_janitor', { botId: 'bot-1' }, CTX),
  );
  assert.equal(real.dryRun, false);
  assert.equal(real.linesDeduped, 1);
  assert.equal(store.get('human').content, '- a\n- b');
});

test('tools: memory_blocks_export/import round-trip via tools', async () => {
  const dir = makeTempDir();
  const store = seedStore(dir);
  const tools = createMemoryV12Tools({ blocksStore: store, botId: 'bot-1' });
  const json = await run(tools, 'memory_blocks_export', {}, CTX);
  const exported = JSON.parse(json);
  assert.equal(exported.format, 'open-bot-memory-blocks');
  assert.equal(exported.blocks.length, 2);

  // Import into a fresh store restores both blocks + attachments.
  const fresh = new MemoryBlockStore(makeTempDir());
  const freshTools = createMemoryV12Tools({ blocksStore: fresh, botId: 'bot-1' });
  const report = JSON.parse(
    await run(freshTools, 'memory_blocks_import', { json }, CTX),
  );
  assert.equal(report.created, 2);
  assert.equal(fresh.get('human').content, 'Tên: Huy.\nThích cà phê.');
  assert.ok(fresh.isAttached('bot-1', fresh.get('human').id));

  // Second import skips existing labels; bad JSON is a clean Error.
  const again = JSON.parse(await run(freshTools, 'memory_blocks_import', { json }, CTX));
  assert.deepEqual(again.skipped.sort(), ['human', 'persona']);
  const bad = await run(freshTools, 'memory_blocks_import', { json: 'not json' }, CTX);
  assert.match(bad, /^Error: .*không phải JSON/);
});

test('binding: createDefaultTools({ getMemoryV12WorkspaceDir }) binds 9 tools in place, ALL_TOOLS stays 491', async () => {
  const dir = makeTempDir();
  const store = new MemoryBlockStore(dir);
  store.create({ label: 'task', description: '', content: 'a\nb', charLimit: 4096 }, 'user');
  const bound = createDefaultTools({
    getMemoryV12WorkspaceDir: () => dir,
    getMemoryV12BotId: () => 'bot-1',
  });
  assert.equal(bound.length, 899); // v1.36 re-pin: 825 + 74 = 899.
  assert.equal(new Set(bound.map((t) => t.definition.name)).size, 899); // v1.36 re-pin: 825 + 74 = 899.
  const tools = toolMap(bound);
  const out = JSON.parse(await tools.get('memory_blocks_compile').execute({ botId: 'bot-1' }));
  assert.equal(out.blocks.length, 0); // nothing attached yet — but bound, not placeholder
  const edited = JSON.parse(
    await tools.get('memory_block_edit').execute({
      block: 'task',
      oldText: 'a',
      newText: 'A!',
    }),
  );
  assert.equal(edited.edited, true);
});

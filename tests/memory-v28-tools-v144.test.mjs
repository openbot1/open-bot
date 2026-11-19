/**
 * Tests for memory v28 tools (v1.44, Doi T1).
 * packages/tools/src/memoryV28Tools.ts
 *
 * Run after building core + tools (memoryV28Tools only):
 *   node node_modules/typescript/bin/tsc -p packages/core/tsconfig.json --incremental
 *   node node_modules/typescript/bin/tsc packages/tools/src/memoryV28Tools.ts --outDir packages/tools/dist --rootDir packages/tools/src --module commonjs --moduleResolution node --target ES2022 --strict --skipLibCheck --esModuleInterop --declaration --sourceMap
 *   node --test tests/memory-v28-tools-v144.test.mjs
 * No network. No model. Uses temp dirs under os.tmpdir().
 *
 * NOTE: chi import dist/memoryV28Tools.js (scoped) — khong import
 * dist/tools.js (ALL_TOOLS) vi build full tools can cac dep nang;
 * coordinator kiem tra ALL_TOOLS o luc gop.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  MEMORY_V28_TOOLS,
  MEMORY_V28_TOOL_NAMES,
  createMemoryV28Tools,
} from '../packages/tools/dist/memoryV28Tools.js';
import { V28Store } from '../packages/core/dist/memory/v28/index.js';

function tmpDir() {
  return mkdtempSync(join(tmpdir(), 'openbot-v28-tools-'));
}

function cleanup(dir) {
  rmSync(dir, { recursive: true, force: true });
}

function makeTools(dir) {
  const store = new V28Store({ rootDir: dir, botId: 'bot-a' });
  return { store, tools: createMemoryV28Tools({ store, botId: 'bot-a' }) };
}

function tool(tools, name) {
  const t = tools.find((x) => x.definition.name === name);
  assert.ok(t, `thieu tool ${name}`);
  return t;
}

test('v28 tools: 10 tool, ten + needsApproval dung', async () => {
  assert.deepEqual([...MEMORY_V28_TOOL_NAMES], [
    'memory_v28_block',
    'memory_v28_block_history',
    'memory_v28_share',
    'memory_v28_share_audit',
    'memory_v28_fact',
    'memory_v28_fact_query',
    'memory_v28_time_travel',
    'memory_v28_sleep',
    'memory_v28_sleep_config',
    'memory_v28_stats',
  ]);
  assert.equal(MEMORY_V28_TOOLS.length, 10);
  const byName = Object.fromEntries(MEMORY_V28_TOOLS.map((t) => [t.definition.name, t.needsApproval]));
  assert.equal(byName.memory_v28_block, true);
  assert.equal(byName.memory_v28_block_history, true);
  assert.equal(byName.memory_v28_share, true);
  assert.equal(byName.memory_v28_share_audit, false);
  assert.equal(byName.memory_v28_fact, true);
  assert.equal(byName.memory_v28_fact_query, false);
  assert.equal(byName.memory_v28_time_travel, false);
  assert.equal(byName.memory_v28_sleep, true);
  assert.equal(byName.memory_v28_sleep_config, true);
  assert.equal(byName.memory_v28_stats, true);
});

test('v28 tools: block create/read/write + history + rollback qua tool', async () => {
  const dir = tmpDir();
  try {
    const { tools } = makeTools(dir);
    const created = JSON.parse(
      await tool(tools, 'memory_v28_block').execute({ action: 'create', label: 'notes', content: 'first version' }),
    );
    assert.equal(created.version, 1);
    assert.ok(created.commit.length >= 7);

    const read = JSON.parse(
      await tool(tools, 'memory_v28_block').execute({ action: 'read', label: 'notes' }),
    );
    assert.equal(read.content, 'first version');

    const updated = JSON.parse(
      await tool(tools, 'memory_v28_block').execute({ action: 'write', label: 'notes', content: 'second version' }),
    );
    assert.equal(updated.version, 2);

    const history = JSON.parse(
      await tool(tools, 'memory_v28_block_history').execute({ action: 'history', label: 'notes' }),
    );
    assert.equal(history.total, 2);

    const rolled = JSON.parse(
      await tool(tools, 'memory_v28_block_history').execute({ action: 'rollback', label: 'notes', target: '1' }),
    );
    assert.equal(rolled.newVersion, 3);
    const readBack = JSON.parse(
      await tool(tools, 'memory_v28_block').execute({ action: 'read', label: 'notes' }),
    );
    assert.equal(readBack.content, 'first version');

    // System block bi chan voi agent.
    const blocked = await tool(tools, 'memory_v28_block').execute({
      action: 'create',
      label: 'human',
      content: 'agent tries',
    });
    assert.match(blocked, /Error: /);
  } finally {
    cleanup(dir);
  }
});

test('v28 tools: share grant/read/write + audit qua tool', async () => {
  const dir = tmpDir();
  try {
    const { tools } = makeTools(dir);
    const created = JSON.parse(
      await tool(tools, 'memory_v28_share').execute({ action: 'create', label: 'team', content: 'shared v1' }),
    );
    assert.equal(created.ownerBotId, 'bot-a');

    // Bot-a cap quyen read cho bot-b (tool chay voi bot-a).
    const grant = JSON.parse(
      await tool(tools, 'memory_v28_share').execute({ action: 'grant', label: 'team', targetBotId: 'bot-b', role: 'read' }),
    );
    assert.equal(grant.role, 'read');

    const audit = JSON.parse(
      await tool(tools, 'memory_v28_share_audit').execute({ label: 'team' }),
    );
    assert.ok(audit.total >= 2);
    assert.ok(audit.entries.some((e) => e.action === 'create'));
    assert.ok(audit.entries.some((e) => e.action === 'grant'));
  } finally {
    cleanup(dir);
  }
});

test('v28 tools: fact add/invalidate/supersede + query valid_at qua tool', async () => {
  const dir = tmpDir();
  try {
    const { tools } = makeTools(dir);
    const added = JSON.parse(
      await tool(tools, 'memory_v28_fact').execute({
        action: 'add',
        subject: 'user',
        predicate: 'likes',
        object: 'pho',
      }),
    );
    assert.equal(added.status, 'active');
    assert.ok(added.id);

    const superseded = JSON.parse(
      await tool(tools, 'memory_v28_fact').execute({
        action: 'supersede',
        id: added.id,
        subject: 'user',
        predicate: 'likes',
        object: 'bun cha',
      }),
    );
    assert.equal(superseded.oldFact.status, 'superseded');
    assert.equal(superseded.newFact.object, 'bun cha');

    const found = JSON.parse(
      await tool(tools, 'memory_v28_fact_query').execute({ action: 'search', query: 'bun cha' }),
    );
    assert.equal(found.total, 1);
    assert.equal(found.hits[0].fact.object, 'bun cha');

    const history = JSON.parse(
      await tool(tools, 'memory_v28_fact_query').execute({ action: 'history', id: added.id }),
    );
    assert.equal(history.total, 2);

    const invalidated = JSON.parse(
      await tool(tools, 'memory_v28_fact').execute({
        action: 'invalidate',
        id: superseded.newFact.id,
        reason: 'outdated',
      }),
    );
    assert.equal(invalidated.status, 'invalidated');
  } finally {
    cleanup(dir);
  }
});

test('v28 tools: time-travel get_state_at + diff_timerange qua tool', async () => {
  const dir = tmpDir();
  try {
    const { tools } = makeTools(dir);
    const before = new Date(Date.now() - 1000).toISOString();
    await tool(tools, 'memory_v28_block').execute({ action: 'create', label: 'log', content: 'entry' });
    await tool(tools, 'memory_v28_fact').execute({ action: 'add', subject: 'user', predicate: 'likes', object: 'tea' });
    const after = new Date().toISOString();

    const state = JSON.parse(
      await tool(tools, 'memory_v28_time_travel').execute({ action: 'get_state_at', at: after }),
    );
    assert.equal(state.blocks.length, 1);
    assert.equal(state.facts.length, 1);

    const diff = JSON.parse(
      await tool(tools, 'memory_v28_time_travel').execute({ action: 'diff_timerange', from: before, to: after }),
    );
    assert.equal(diff.blocksAdded, 1);
    assert.equal(diff.factsAdded, 1);
  } finally {
    cleanup(dir);
  }
});

test('v28 tools: sleep dry-run + run that + config qua tool', async () => {
  const dir = tmpDir();
  try {
    const { tools } = makeTools(dir);
    const configBefore = JSON.parse(
      await tool(tools, 'memory_v28_sleep_config').execute({ action: 'get' }),
    );
    assert.equal(configBefore.enabled, false);

    const updated = JSON.parse(
      await tool(tools, 'memory_v28_sleep_config').execute({ action: 'set', enabled: true }),
    );
    assert.equal(updated.enabled, true);

    const episodes = [{ id: 'ep1', text: 'I really like pho. My name is Huy.', botId: 'bot-a', at: new Date().toISOString() }];
    const dry = JSON.parse(
      await tool(tools, 'memory_v28_sleep').execute({ action: 'dry_run', episodes }),
    );
    assert.equal(dry.dryRun, true);
    assert.ok(dry.factsAdded >= 1);

    const run = JSON.parse(
      await tool(tools, 'memory_v28_sleep').execute({ action: 'run', episodes }),
    );
    assert.equal(run.dryRun, false);
    assert.ok(run.factsAdded >= 1);
    assert.equal(run.summaryPromoted, true);

    const status = JSON.parse(
      await tool(tools, 'memory_v28_sleep').execute({ action: 'status' }),
    );
    assert.equal(status.runsTotal, 1);
    assert.ok(status.lastRun);
  } finally {
    cleanup(dir);
  }
});

test('v28 tools: stats + panel + export/import qua tool', async () => {
  const dir = tmpDir();
  try {
    const { tools } = makeTools(dir);
    await tool(tools, 'memory_v28_block').execute({ action: 'create', label: 'notes', content: 'v1' });
    await tool(tools, 'memory_v28_fact').execute({ action: 'add', subject: 'user', predicate: 'likes', object: 'pho' });

    const stats = JSON.parse(await tool(tools, 'memory_v28_stats').execute({ action: 'stats' }));
    assert.equal(stats.blocksTotal, 1);
    assert.equal(stats.factsTotal, 1);
    assert.equal(stats.gitAvailable, true);

    const panel = JSON.parse(await tool(tools, 'memory_v28_stats').execute({ action: 'panel' }));
    assert.equal(panel.blocks.length, 1);
    assert.equal(panel.factsActive, 1);

    const snapshot = JSON.parse(await tool(tools, 'memory_v28_stats').execute({ action: 'export' }));
    assert.equal(snapshot.version, '28.0.0');
    assert.equal(snapshot.facts.length, 1);

    const imported = JSON.parse(
      await tool(tools, 'memory_v28_stats').execute({ action: 'import', snapshot }),
    );
    assert.equal(imported.factsImported, 0);
    assert.equal(imported.factsSkipped, 1);
  } finally {
    cleanup(dir);
  }
});

test('v28 tools: integrity + bundle export/import qua tool', async () => {
  const dir = tmpDir();
  try {
    const { tools } = makeTools(dir);
    await tool(tools, 'memory_v28_block').execute({ action: 'create', label: 'notes', content: 'v1' });
    await tool(tools, 'memory_v28_fact').execute({ action: 'add', subject: 'user', predicate: 'likes', object: 'pho' });

    const integrity = JSON.parse(await tool(tools, 'memory_v28_stats').execute({ action: 'integrity' }));
    assert.equal(integrity.ok, true);
    assert.ok(integrity.checks.length >= 6);

    const bundleDir = join(dir, 'bundle-out');
    const exported = JSON.parse(
      await tool(tools, 'memory_v28_stats').execute({ action: 'bundle_export', bundleDir }),
    );
    assert.equal(exported.manifest.blocks, 1);
    assert.equal(exported.manifest.facts, 1);

    const imported = JSON.parse(
      await tool(tools, 'memory_v28_stats').execute({ action: 'bundle_import', bundleDir, dryRun: true }),
    );
    assert.equal(imported.blocksImported, 0);
    assert.equal(imported.factsImported, 0);
  } finally {
    cleanup(dir);
  }
});

test('v28 tools: loi tra ve dang Error: chu khong throw', async () => {
  const dir = tmpDir();
  try {
    const { tools } = makeTools(dir);
    const missing = await tool(tools, 'memory_v28_block').execute({ action: 'read', label: 'no-such-block' });
    assert.match(missing, /^Error: /);
    const badAction = await tool(tools, 'memory_v28_fact_query').execute({ action: 'explode' });
    assert.match(badAction, /^Error: /);
  } finally {
    cleanup(dir);
  }
});

test('v28 tools: import placeholder khong tao repo memory-v28/ trong cwd (lazy store)', () => {
  const dir = tmpDir();
  try {
    const modulePath = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'packages', 'tools', 'dist', 'memoryV28Tools.js');
    execFileSync('node', ['-e', `require(${JSON.stringify(modulePath)}); console.log('imported');`], {
      cwd: dir,
      encoding: 'utf8',
    });
    assert.equal(existsSync(join(dir, 'memory-v28')), false);
  } finally {
    cleanup(dir);
  }
});

/**
 * Tests for memory v22 — registry (v1.37, Doi T1): 10 tool memory v22
 * co ten dung, duoc dang ky vao ALL_TOOLS (qua source tools.ts) va
 * core barrel export du V22Dreamer.
 *
 * Run after building core + tools:
 *   npm run build --workspace=@open-bot/core
 *   npm run build --workspace=@open-bot/tools
 *   node --test tests/memory-v22-registry-v137.test.mjs
 * No network. No model.
 *
 * NOTE: chi assert so cua chinh module v22 (10 tool) — KHONG
 * re-pin so dem toan cuc (ALL_TOOLS / i18n totals); coordinator
 * re-pin mot lan o cuoi.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  MEMORY_V22_TOOLS,
  MEMORY_V22_TOOL_NAMES,
  createMemoryV22Tools,
} from '../packages/tools/dist/memoryV22Tools.js';
import { V22Dreamer, V22DreamStore, V22DreamScheduler } from '../packages/core/dist/index.js';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');

test('v22 registry: 10 tool memory_v22_* — ten dung prefix, khong dung v21', () => {
  assert.equal(MEMORY_V22_TOOL_NAMES.length, 10);
  for (const name of MEMORY_V22_TOOL_NAMES) {
    assert.ok(name.startsWith('memory_v22_'), `${name} sai prefix`);
    assert.ok(!name.startsWith('memory_v21_'), `${name} dung nham prefix v21`);
  }
  assert.deepEqual([...MEMORY_V22_TOOL_NAMES], [
    'memory_v22_dream',
    'memory_v22_dream_config',
    'memory_v22_dream_status',
    'memory_v22_dream_report',
    'memory_v22_fact',
    'memory_v22_wiki',
    'memory_v22_budget',
    'memory_v22_snapshot',
    'memory_v22_rollback',
    'memory_v22_audit',
  ]);
  assert.equal(MEMORY_V22_TOOLS.length, 10);
  assert.deepEqual(
    MEMORY_V22_TOOLS.map((t) => t.definition.name),
    [...MEMORY_V22_TOOL_NAMES],
  );
  assert.equal(createMemoryV22Tools({}).length, 10);
});

test('v22 registry: tools.ts dang ky MEMORY_V22_TOOLS vao ALL_TOOLS', () => {
  const toolsTs = readFileSync(join(root, 'packages', 'tools', 'src', 'tools.ts'), 'utf8');
  assert.match(toolsTs, /import \{ MEMORY_V22_TOOLS, createMemoryV22Tools \} from '\.\/memoryV22Tools'/);
  assert.match(toolsTs, /\.\.\.MEMORY_V22_TOOLS,/);
  const toolsIndex = readFileSync(join(root, 'packages', 'tools', 'src', 'index.ts'), 'utf8');
  assert.match(toolsIndex, /export \{ createMemoryV22Tools, MEMORY_V22_TOOLS, MEMORY_V22_TOOL_NAMES \} from '\.\/memoryV22Tools'/);
});

test('v22 registry: core barrel export V22Dreamer + store + scheduler', () => {
  assert.equal(typeof V22Dreamer, 'function');
  assert.equal(typeof V22DreamStore, 'function');
  assert.equal(typeof V22DreamScheduler, 'function');
  const dreamer = new V22Dreamer();
  assert.equal(typeof dreamer.runDream, 'function');
  assert.equal(typeof dreamer.rollbackToSnapshot, 'function');
  assert.equal(typeof dreamer.getBudgetPlan, 'function');
  assert.equal(typeof dreamer.importFromV21Records, 'function');
  assert.equal(typeof dreamer.exportToV21Records, 'function');
  const coreIndex = readFileSync(join(root, 'packages', 'core', 'src', 'index.ts'), 'utf8');
  assert.match(coreIndex, /export \* from '\.\/memory\/v22\/index'/);
});

/**
 * Tests for the memory eval suite (packages/core/src/eval/memoryEval.ts).
 *
 * Covers the tier rule (pure: thresholds, no false promotion,
 * contradiction demotes one tier) and the full suite run (8 cases —
 * recall after 20/50 distractor turns, tier promotion, block edits
 * keep facts, read-only blocks reject edits, scope isolation,
 * overwrite keeps id). The suite runs against real LongTermMemory +
 * MemoryBlockStore in temp dirs.
 *
 * Run after building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/eval-memory-v106.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MEMORY_EVAL_DEFAULT_DISTRACTOR_TURNS,
  MEMORY_EVAL_HEAVY_DISTRACTOR_TURNS,
  demoteTierOnContradiction,
  memoryTierFor,
  promoteTierOnRecall,
  runMemoryEval,
} from '../packages/core/dist/eval/memoryEvalV106.js';

test('memoryTierFor thresholds: 3 recalls -> working, 8 + conf>=0.8 -> durable', () => {
  const high = { confidence: 0.9 };
  assert.equal(memoryTierFor(high, 0), 'ephemeral');
  assert.equal(memoryTierFor(high, 2), 'ephemeral');
  assert.equal(memoryTierFor(high, 3), 'working');
  assert.equal(memoryTierFor(high, 7), 'working');
  assert.equal(memoryTierFor(high, 8), 'durable');
  assert.equal(memoryTierFor(high, 100), 'durable');
  assert.equal(memoryTierFor({ confidence: 0.79 }, 100), 'working');
  assert.equal(memoryTierFor({ confidence: 0.8 }, 8), 'durable');
  assert.equal(memoryTierFor(high, -5), 'ephemeral');
});

test('promoteTierOnRecall advances exactly one threshold at a time', () => {
  const high = { confidence: 0.9 };
  assert.equal(promoteTierOnRecall(high, 1), 'ephemeral');
  assert.equal(promoteTierOnRecall(high, 2), 'working');
  assert.equal(promoteTierOnRecall(high, 7), 'durable');
  assert.equal(promoteTierOnRecall({ confidence: 0.5 }, 7), 'working');
});

test('demoteTierOnContradiction drops exactly one tier and never below ephemeral', () => {
  assert.equal(demoteTierOnContradiction('durable'), 'working');
  assert.equal(demoteTierOnContradiction('working'), 'ephemeral');
  assert.equal(demoteTierOnContradiction('ephemeral'), 'ephemeral');
});

test('eval constants: default 20 turns, heavy 50 turns', () => {
  assert.equal(MEMORY_EVAL_DEFAULT_DISTRACTOR_TURNS, 20);
  assert.equal(MEMORY_EVAL_HEAVY_DISTRACTOR_TURNS, 50);
});

test('runMemoryEval: all 8 cases pass against real memory stores', async () => {
  const result = await runMemoryEval();
  assert.equal(result.suite, 'memory');
  assert.equal(result.cases.length, 8);
  assert.equal(result.failed, 0);
  assert.equal(result.passed, 8);
  const ids = result.cases.map((c) => c.id);
  for (const expected of [
    'memory.recall-after-20-turns',
    'memory.recall-after-50-turns',
    'memory.tier-promotion',
    'memory.tier-no-false-promotion',
    'memory.block-edit-preserves-facts',
    'memory.block-readonly-blocked',
    'memory.scope-isolation',
    'memory.overwrite-keeps-id',
  ]) {
    assert.ok(ids.includes(expected), `missing case ${expected}`);
  }
  for (const c of result.cases) {
    assert.equal(typeof c.durationMs, 'number');
    assert.ok(c.durationMs >= 0);
    assert.ok(c.detail.length > 0);
  }
});

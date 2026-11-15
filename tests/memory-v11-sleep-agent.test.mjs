/**
 * Tests for v1.11 (Doi T1) — sleep-time consolidation agent:
 * packages/core/src/memory/v11/sleepConsolidationAgent.ts.
 *
 * Covers: recordRawFact fast path (validation + append-only inbox),
 * sleep pass end-to-end (extract + dedupe, learned_context into a
 * shared block via the supervisor, consolidate strong facts into
 * archival, invalidate contradicted archival items), dry-run (writes
 * nothing), min-interval guard + force, between-turns helper,
 * negation-cue detection, sleep log.
 *
 * Run after building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/memory-v11-sleep-agent.test.mjs
 *
 * No network. No model.
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { MemoryBlockStore } from '../packages/core/dist/memory/blocks.js';
import { SharedBlockGroupStore } from '../packages/core/dist/memory/sharedBlocks.js';
import { ArchivalStore } from '../packages/core/dist/memory/v9/archival.js';
import { SharedSupervisor } from '../packages/core/dist/memory/v11/sharedSupervisor.js';
import {
  recordRawFact,
  readRawFacts,
  readUnprocessedRawFacts,
  markRawFactsProcessed,
  hasNegationCue,
  findContradictedArchival,
  readV11SleepLog,
  V11SleepConsolidationAgent,
  V11SleepError,
} from '../packages/core/dist/memory/v11/sleepConsolidationAgent.js';

const tempDirs = [];
function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-memv11-sleep-'));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** Workspace with a group (bot-1 supervisor, bot-2 member). */
function makeGroup(dir) {
  const blocks = new MemoryBlockStore(dir);
  const groups = new SharedBlockGroupStore(dir, blocks);
  const group = groups.createGroup({ name: 'team-sleep', description: 'sleep test' }, 'user');
  groups.addMember(group.id, 'bot-1', 'write', 'user');
  groups.addMember(group.id, 'bot-2', 'read', 'user');
  const supervisor = new SharedSupervisor(dir, blocks, groups);
  supervisor.setSupervisor(group.id, 'bot-1', 'user');
  return { blocks, groups, group, supervisor };
}

test('recordRawFact: fast append, validation, inbox read', () => {
  const dir = makeTempDir();
  const fact = recordRawFact(dir, { botId: 'bot-1', text: 'Người dùng thích uống trà đá.', source: 'turn', turnId: 't-1' });
  assert.equal(fact.botId, 'bot-1');
  assert.equal(fact.processed, false);
  assert.equal(typeof fact.id, 'string');
  assert.equal(readRawFacts(dir).length, 1);
  assert.equal(readUnprocessedRawFacts(dir, 'bot-1').length, 1);
  assert.equal(readUnprocessedRawFacts(dir, 'bot-2').length, 0);
  // Too short / empty botId rejected.
  assert.throws(() => recordRawFact(dir, { botId: 'bot-1', text: 'short', source: 'turn' }), V11SleepError);
  assert.throws(() => recordRawFact(dir, { botId: '', text: 'long enough text here', source: 'turn' }), V11SleepError);
  // Over-long text is truncated, not rejected.
  const long = recordRawFact(dir, { botId: 'bot-1', text: 'x'.repeat(5000), source: 'turn' });
  assert.equal(long.text.length, 2000);
  // Mark processed.
  markRawFactsProcessed(dir, [fact.id]);
  assert.equal(readUnprocessedRawFacts(dir, 'bot-1').length, 1); // only the long one left
  assert.equal(readRawFacts(dir).filter((f) => f.processed).length, 1);
});

test('hasNegationCue + findContradictedArchival: keyword overlap + negation', () => {
  assert.equal(hasNegationCue('Người dùng không còn sống ở Hà Nội.'), true);
  assert.equal(hasNegationCue('Người dùng đã đổi sang Sài Gòn.'), true);
  assert.equal(hasNegationCue('User no longer lives in Hanoi.'), true);
  assert.equal(hasNegationCue('Người dùng thích uống trà.'), false);
  const items = [
    { id: 'a1', text: 'Người dùng sống ở Hà Nội.' },
    { id: 'a2', text: 'Người dùng thích uống cà phê.' },
  ];
  const hits = findContradictedArchival('Người dùng không còn sống ở Hà Nội.', items);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].id, 'a1');
  // Same fact without negation contradicts nothing.
  assert.deepEqual(findContradictedArchival('Người dùng sống ở Hà Nội.', items), []);
});

test('runSleepPass (local): learned_context block + archival consolidate', () => {
  const dir = makeTempDir();
  // Same fact twice (strong) + one unique fact.
  recordRawFact(dir, { botId: 'bot-1', text: 'Người dùng thích uống trà đá mỗi sáng.', source: 'turn' });
  recordRawFact(dir, { botId: 'bot-1', text: 'Người dùng thích uống trà đá mỗi sáng.', source: 'turn' });
  recordRawFact(dir, { botId: 'bot-1', text: 'Người dùng đang làm dự án open-bot.', source: 'turn' });

  const agent = new V11SleepConsolidationAgent(dir);
  const report = agent.runSleepPass({ botId: 'bot-1', force: true });
  assert.equal(report.rawFactsRead, 3);
  assert.equal(report.factsExtracted, 3);
  assert.equal(report.factsDeduped, 1); // duplicate sentence removed
  assert.equal(report.learnedContextLinesAdded, 2);
  assert.equal(report.archivalConsolidated, 1); // repeated fact is strong
  assert.deepEqual(report.errors, []);
  assert.equal(report.steps.length, 4);
  assert.ok(report.steps.every((s) => s.ok));

  const blocks = new MemoryBlockStore(dir);
  const learned = blocks.get('learned-context');
  assert.ok(learned);
  assert.ok(learned.content.includes('Người dùng thích uống trà đá mỗi sáng.'));
  assert.ok(learned.content.includes('Người dùng đang làm dự án open-bot.'));
  assert.equal(blocks.isAttached('bot-1', learned.id), true);
  // Raw facts are marked processed.
  assert.equal(readUnprocessedRawFacts(dir, 'bot-1').length, 0);
  // Sleep log written.
  const log = readV11SleepLog(dir, 5);
  assert.equal(log.length, 1);
  assert.equal(log[0].id, report.id);
});

test('runSleepPass (shared): learned_context goes to the shared block via supervisor', () => {
  const dir = makeTempDir();
  const { group } = makeGroup(dir);
  recordRawFact(dir, { botId: 'bot-1', text: 'Nhóm đang làm tính năng memory v11 cho open-bot.', source: 'turn' });

  const agent = new V11SleepConsolidationAgent(dir);
  const report = agent.runSleepPass({
    botId: 'bot-1',
    groupIdOrName: group.id,
    supervisorBotId: 'bot-1',
    force: true,
  });
  assert.equal(report.learnedContextLinesAdded, 1);
  assert.deepEqual(report.errors, []);

  const blocks = new MemoryBlockStore(dir);
  const learned = blocks.get('learned-context');
  assert.ok(learned);
  assert.ok(learned.content.includes('Nhóm đang làm tính năng memory v11'));
  // Shared: both members see it.
  assert.equal(blocks.isAttached('bot-1', learned.id), true);
  assert.equal(blocks.isAttached('bot-2', learned.id), true);
  // The group owns the block.
  const groups = new SharedBlockGroupStore(dir, blocks);
  assert.ok(groups.getGroup(group.id).blockIds.includes(learned.id));
});

test('runSleepPass: invalidates contradicted archival items (marks, does not delete)', async () => {
  const dir = makeTempDir();
  const archival = new ArchivalStore(dir);
  const old = archival.insert({ text: 'Người dùng sống ở Hà Nội.', source: 'fact', confidence: 0.9 });
  const other = archival.insert({ text: 'Người dùng thích uống cà phê.', source: 'fact', confidence: 0.9 });
  recordRawFact(dir, { botId: 'bot-1', text: 'Người dùng không còn sống ở Hà Nội.', source: 'turn' });

  const agent = new V11SleepConsolidationAgent(dir);
  const report = agent.runSleepPass({ botId: 'bot-1', force: true });
  assert.equal(report.archivalInvalidated.length, 1);
  assert.equal(report.archivalInvalidated[0].id, old.id);

  // Item still on disk (history kept) but marked invalidated...
  const all = archival.readAll();
  assert.equal(all.find((it) => it.id === old.id)?.invalidatedAt !== undefined, true);
  assert.equal(all.find((it) => it.id === other.id)?.invalidatedAt, undefined);
  // ...and search() no longer returns it.
  const found = await archival.search({ query: 'Hà Nội' });
  assert.ok(found.hits.every((h) => h.item.id !== old.id));
  // Reinstate works.
  assert.equal(archival.invalidate(old.id, 'again'), false); // already invalidated
  assert.equal(archival.reinstate(old.id), true);
  assert.equal(archival.reinstate(old.id), false); // already reinstated
});

test('runSleepPass: dry-run writes nothing', () => {
  const dir = makeTempDir();
  recordRawFact(dir, { botId: 'bot-1', text: 'Người dùng thích uống trà đá mỗi sáng.', source: 'turn' });
  const agent = new V11SleepConsolidationAgent(dir);
  const report = agent.runSleepPass({ botId: 'bot-1', dryRun: true, force: true });
  assert.equal(report.dryRun, true);
  assert.equal(report.learnedContextLinesAdded, 1); // computed, not written
  assert.equal(new MemoryBlockStore(dir).get('learned-context'), null);
  assert.equal(readUnprocessedRawFacts(dir, 'bot-1').length, 1); // still unprocessed
  assert.equal(readV11SleepLog(dir).length, 0); // dry runs are not logged
});

test('runSleepPass: empty inbox is a no-op pass, still logged', () => {
  const dir = makeTempDir();
  const agent = new V11SleepConsolidationAgent(dir);
  const report = agent.runSleepPass({ botId: 'bot-1', force: true });
  assert.equal(report.rawFactsRead, 0);
  assert.equal(report.factsExtracted, 0);
  assert.equal(report.learnedContextLinesAdded, 0);
  assert.deepEqual(report.errors, []);
  assert.equal(readV11SleepLog(dir).length, 1);
});

test('runSleepPass: min-interval guard + force + between-turns helper', () => {
  const dir = makeTempDir();
  recordRawFact(dir, { botId: 'bot-1', text: 'Người dùng thích uống trà đá mỗi sáng.', source: 'turn' });
  const agent = new V11SleepConsolidationAgent(dir);
  agent.runSleepPass({ botId: 'bot-1', force: true });
  // Too soon: throws (unless force).
  assert.throws(() => agent.runSleepPass({ botId: 'bot-1' }), V11SleepError);
  // Between-turns helper returns null when too soon instead of throwing.
  assert.equal(agent.runSleepPassBetweenTurns({ botId: 'bot-1' }), null);
  assert.notEqual(agent.runSleepPassBetweenTurns({ botId: 'bot-1', force: true }), null);
  // Guard is per-bot: another bot runs fine.
  recordRawFact(dir, { botId: 'bot-2', text: 'Bot hai ghi một fact đủ dài ở đây.', source: 'turn' });
  assert.doesNotThrow(() => agent.runSleepPass({ botId: 'bot-2' }));
  // Missing supervisor with a group is a real error.
  assert.throws(
    () => agent.runSleepPass({ botId: 'bot-1', groupIdOrName: 'g1', force: true }),
    V11SleepError,
  );
  // Empty botId is a real error.
  assert.throws(() => agent.runSleepPass({ botId: '', force: true }), V11SleepError);
});

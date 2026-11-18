/**
 * Tests for v1.17 (Team T1) — memory v16:
 * packages/core/src/memory/v16/{corePromotion,sleepConsolidation}.ts
 *
 * Covers:
 *  - core promotion: target block theo predicate (persona/human/
 *    task), dedup (dong da co khong append lai), thay the dong cu
 *    cung (subject, predicate), gate chan fact mo coi / confidence
 *    thap, budget (vuot budget -> archival), provenance footer
 *    [fact:<id8> <ngay>], promoteActiveFactsV16.
 *  - sleep consolidation v2: trigger turns (du N turn moi chay),
 *    compact chay ngay, manual chay tay, run xu ly episode chua
 *    xong (trich fact v15 -> gate -> 4-op -> promote), idempotent
 *    (chay lai khong xu ly lai episode da xong), fail-open (episode
 *    loi khong dung ca run), state + run log luu file, budget het
 *    thi dung giua chung, disabled thi khong chay.
 *
 * Run after building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/memory-v16-sleep-promotion-v117.test.mjs
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
  targetBlockKindForPredicateV16,
  formatFactLineV16,
  blockLineKeyV16,
  V16V15BlockAdapter,
  promoteFactsToCoreV16,
  promoteActiveFactsV16,
  V16SleepConsolidationAgent,
  createV16SleepAgent,
  defaultV16SleepState,
  loadV16SleepState,
  readV16SleepRunLogs,
  V16SourceAllowlist,
  sourceNameForEpisodeV16,
} from '../packages/core/dist/index.js';

const SCOPE = { userId: 'u1', botId: 'b1', runId: 'r1' };

function freshStore() {
  return new TemporalGraphStore(new InMemoryGraphBackend());
}

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'v16-sleep-'));
}

function prov(sourceText, episodeId = 'e1') {
  return {
    episodeId,
    turnId: 't1',
    runId: 'r1',
    botId: 'b1',
    userId: 'u1',
    at: '2026-01-01T00:00:00.000Z',
    sourceText,
  };
}

function seedFact(store, subject, predicate, objectText, opts = {}) {
  return store.addFact({
    subjectName: subject,
    predicate,
    objectText,
    confidence: opts.confidence ?? 0.9,
    scope: SCOPE,
    provenance: prov(opts.sourceText ?? `${subject} ${predicate} ${objectText}.`, opts.episodeId),
    validFrom: opts.validFrom ?? '2025-01-01T00:00:00.000Z',
    ...(opts.validUntil !== undefined ? { validUntil: opts.validUntil } : {}),
  });
}

function seedEpisode(store, text, role = 'user') {
  const { id } = store.ingestEpisode({
    turnId: `turn-${Math.random().toString(36).slice(2, 8)}`,
    runId: 'r1',
    botId: 'b1',
    userId: 'u1',
    role,
    text,
  });
  return store.getEpisode(id);
}

// --- core promotion ---------------------------------------------------------

test('v16 promotion target: dinh danh -> persona, so thich -> human, goal -> task', () => {
  assert.equal(targetBlockKindForPredicateV16('lives_in'), 'persona');
  assert.equal(targetBlockKindForPredicateV16('works_at'), 'persona');
  assert.equal(targetBlockKindForPredicateV16('likes'), 'human');
  assert.equal(targetBlockKindForPredicateV16('goal'), 'task');
  assert.equal(targetBlockKindForPredicateV16('constraint'), 'task');
  assert.equal(targetBlockKindForPredicateV16('reads'), 'human');
});

test('v16 promotion line: dinh dang kem provenance footer, parse lai duoc', () => {
  const store = freshStore();
  const episode = seedEpisode(store, 'Tôi thích phở bò.');
  const fact = seedFact(store, 'An', 'likes', 'phở bò', { episodeId: episode.id });
  const line = formatFactLineV16(fact, 'An');
  assert.ok(line.startsWith('- An likes phở bò [fact:'));
  assert.ok(line.includes('2025-01-01'));
  const parsed = blockLineKeyV16(line);
  assert.ok(parsed);
  assert.equal(parsed.subjectPredicate, 'an likes');
  assert.equal(blockLineKeyV16('khong phai dong fact'), null);
});

test('v16 promote: fact hop le vao dung block, dedup, thay dong cu', () => {
  const store = freshStore();
  const blocks = new V15BlockStore();
  const adapter = new V16V15BlockAdapter(blocks);
  const episode = seedEpisode(store, 'Tôi thích phở bò. Tôi sống ở Hà Nội.');
  const like = seedFact(store, 'An', 'likes', 'phở bò', { episodeId: episode.id });
  const live = seedFact(store, 'An', 'lives_in', 'Hà Nội', { episodeId: episode.id });
  const report = promoteFactsToCoreV16(store, [like, live], SCOPE, adapter, 'user-chat');
  assert.equal(report.considered, 2);
  assert.equal(report.promoted.length, 2);
  assert.equal(report.gatedOut.length, 0);
  const human = blocks.get('v16-human');
  const persona = blocks.get('v16-persona');
  assert.ok(human.content.includes('phở bò'));
  assert.ok(persona.content.includes('Hà Nội'));
  // Promote lai lan nua -> dedup, khong them dong.
  const again = promoteFactsToCoreV16(store, [like, live], SCOPE, adapter, 'user-chat');
  assert.equal(again.deduplicated, 2);
  assert.equal(again.promoted.length, 0);
  // Fact moi cung (subject, predicate) khac object -> thay dong cu.
  const moved = store.supersedeFact(live.id, {
    subjectName: 'An',
    predicate: 'lives_in',
    objectText: 'Đà Nẵng',
    confidence: 0.9,
    scope: SCOPE,
    provenance: prov('An lives_in Đà Nẵng.', episode.id),
    validFrom: '2026-11-01T00:00:00.000Z',
  });
  const replaced = promoteFactsToCoreV16(store, [moved], SCOPE, adapter, 'user-chat');
  assert.equal(replaced.promoted.length, 1);
  const personaAfter = blocks.get('v16-persona');
  assert.ok(personaAfter.content.includes('Đà Nẵng'));
  assert.equal(personaAfter.content.includes('Hà Nội'), false);
});

test('v16 promote: fact mo coi va confidence thap bi gate chan', () => {
  const store = freshStore();
  const blocks = new V15BlockStore();
  const adapter = new V16V15BlockAdapter(blocks);
  const orphan = seedFact(store, 'An', 'likes', 'bún chả', { episodeId: 'no-such-episode' });
  const weak = seedFact(store, 'An', 'likes', 'cơm tấm', {
    episodeId: seedEpisode(store, 'Tôi thích cơm tấm.').id,
    confidence: 0.4,
  });
  const report = promoteFactsToCoreV16(store, [orphan, weak], SCOPE, adapter, 'user-chat');
  assert.equal(report.promoted.length, 0);
  assert.equal(report.gatedOut.length, 2);
  assert.equal(blocks.size, 0);
});

test('v16 promote: vuot budget thi xuong archival, khong mat fact', () => {
  const store = freshStore();
  const blocks = new V15BlockStore();
  const adapter = new V16V15BlockAdapter(blocks);
  const episode = seedEpisode(store, 'Tôi thích nhiều thứ.');
  const facts = [];
  for (let i = 0; i < 5; i += 1) {
    facts.push(seedFact(store, 'An', 'likes', `món ${i}`, { episodeId: episode.id }));
  }
  const report = promoteFactsToCoreV16(store, facts, SCOPE, adapter, 'user-chat', {
    maxBlockChars: 60,
  });
  assert.ok(report.archived > 0);
  const archival = blocks.get('v16-archival');
  assert.ok(archival);
  assert.ok(archival.content.includes('món'));
});

test('v16 promoteActiveFacts: chi lay fact active dang hieu luc, xep theo confidence', () => {
  const store = freshStore();
  const blocks = new V15BlockStore();
  const adapter = new V16V15BlockAdapter(blocks);
  const episode = seedEpisode(store, 'Tôi thích phở bò.');
  seedFact(store, 'An', 'likes', 'phở bò', { episodeId: episode.id, confidence: 0.95 });
  const old = seedFact(store, 'An', 'likes', 'bún chả', { episodeId: episode.id, confidence: 0.9 });
  store.deleteFact(old.id, 'test');
  seedFact(store, 'An', 'plans', 'đi Đà Lạt', {
    episodeId: episode.id,
    validFrom: '2025-01-01T00:00:00.000Z',
    validUntil: '2026-01-01T00:00:00.000Z',
  });
  const report = promoteActiveFactsV16(store, SCOPE, adapter, 'user-chat', {
    at: new Date('2026-11-16T00:00:00.000Z'),
  });
  assert.equal(report.promoted.length, 1);
  assert.equal(report.promoted[0].factId, store.listFacts({ status: 'active' })[0].id);
});

// --- sleep consolidation v2 -------------------------------------------------

test('v16 sleep sourceName: user -> user-chat, assistant -> agent-self', () => {
  assert.equal(sourceNameForEpisodeV16('user'), 'user-chat');
  assert.equal(sourceNameForEpisodeV16('assistant'), 'agent-self');
  assert.equal(sourceNameForEpisodeV16('user', 'custom-source'), 'custom-source');
});

test('v16 sleep state: mac dinh, luu va doc lai tu file', () => {
  const dir = tmpDir();
  const state = loadV16SleepState(dir);
  assert.equal(state.totalRuns, 0);
  assert.equal(state.lastRunAt, null);
  const agent = createV16SleepAgent(freshStore(), dir, SCOPE, { enabled: true });
  assert.deepEqual(agent.getConfig().enabled, true);
  assert.equal(agent.getState().totalRuns, 0);
  agent.setState({ ...defaultV16SleepState(), totalRuns: 3, turnsSinceLastRun: 2 });
  assert.equal(loadV16SleepState(dir).totalRuns, 3);
  assert.equal(readV16SleepRunLogs(dir).length, 0);
});

test('v16 sleep runManual: trich fact tu episode, consolidate, promote, danh dau xong', () => {
  const store = freshStore();
  const dir = tmpDir();
  const blocks = new V15BlockStore();
  const adapter = new V16V15BlockAdapter(blocks);
  seedEpisode(store, 'Tôi thích phở bò. Tôi sống ở Hà Nội.');
  seedEpisode(store, 'Tôi ghét đồ cay.');
  const agent = createV16SleepAgent(store, dir, SCOPE, { enabled: true });
  const report = agent.runManual({ blocks: adapter });
  assert.equal(report.trigger, 'manual');
  assert.equal(report.episodesSeen, 2);
  assert.equal(report.episodesProcessed, 2);
  assert.equal(report.episodesFailed, 0);
  assert.ok(report.candidatesExtracted >= 3);
  assert.ok(report.consolidation.added >= 3);
  assert.ok(report.promoted >= 1);
  assert.equal(report.error, null);
  assert.equal(store.listUnprocessedEpisodes(SCOPE).length, 0);
  // State + run log da ghi file.
  assert.equal(agent.getState().totalRuns, 1);
  assert.equal(agent.getState().totalEpisodesProcessed, 2);
  const logs = readV16SleepRunLogs(dir);
  assert.equal(logs.length, 1);
  assert.equal(logs[0].runId, report.runId);
});

test('v16 sleep idempotent: chay lai khong xu ly lai episode da xong', () => {
  const store = freshStore();
  const dir = tmpDir();
  seedEpisode(store, 'Tôi thích phở bò.');
  const agent = createV16SleepAgent(store, dir, SCOPE, { enabled: true });
  const first = agent.runManual({});
  assert.equal(first.episodesProcessed, 1);
  const second = agent.runManual({});
  assert.equal(second.episodesSeen, 0);
  assert.equal(second.episodesProcessed, 0);
  assert.equal(second.consolidation.added, 0);
});

test('v16 sleep noteTurn: chua du N turn thi khong chay; du thi chay', () => {
  const store = freshStore();
  const dir = tmpDir();
  seedEpisode(store, 'Tôi thích phở bò.');
  const agent = createV16SleepAgent(store, dir, SCOPE, { enabled: true, afterTurns: 3 });
  assert.equal(agent.noteTurn({}), null);
  assert.equal(agent.noteTurn({}), null);
  const ran = agent.noteTurn({});
  assert.ok(ran);
  assert.equal(ran.trigger, 'turns');
  assert.equal(ran.episodesProcessed, 1);
  assert.equal(agent.getState().turnsSinceLastRun, 0);
});

test('v16 sleep runOnCompact: chay ngay khi context compact', () => {
  const store = freshStore();
  const dir = tmpDir();
  seedEpisode(store, 'Tôi thích phở bò.');
  const agent = createV16SleepAgent(store, dir, SCOPE, { enabled: true, afterTurns: 100 });
  const ran = agent.runOnCompact({});
  assert.ok(ran);
  assert.equal(ran.trigger, 'compact');
  assert.equal(ran.episodesProcessed, 1);
});

test('v16 sleep disabled: noteTurn va runOnCompact khong chay, manual van chay', () => {
  const store = freshStore();
  const dir = tmpDir();
  seedEpisode(store, 'Tôi thích phở bò.');
  const agent = createV16SleepAgent(store, dir, SCOPE, { enabled: false, afterTurns: 1 });
  assert.equal(agent.noteTurn({}), null);
  assert.equal(agent.runOnCompact({}), null);
  const manual = agent.runManual({});
  assert.equal(manual.episodesProcessed, 1);
});

test('v16 sleep budget: het ngan sach episode thi dung, de phan con lai cho sau', () => {
  const store = freshStore();
  const dir = tmpDir();
  for (let i = 0; i < 5; i += 1) {
    seedEpisode(store, `Tôi thích món ${i}.`);
  }
  const agent = createV16SleepAgent(store, dir, SCOPE, {
    enabled: true,
    maxEpisodesPerRun: 2,
  });
  const report = agent.runManual({});
  assert.equal(report.episodesSeen, 2);
  assert.equal(report.episodesProcessed, 2);
  assert.equal(store.listUnprocessedEpisodes(SCOPE).length, 3);
});

test('v16 sleep gate: episode tu nguon deny bi bo, khong tao fact', () => {
  const store = freshStore();
  const dir = tmpDir();
  seedEpisode(store, 'Tôi thích phở bò.');
  const agent = createV16SleepAgent(store, dir, SCOPE, { enabled: true });
  const allowlist = new V16SourceAllowlist();
  allowlist.upsert('user-chat', 'deny', null, 'Chan de test', 'test');
  const report = agent.runManual({ allowlist });
  assert.equal(report.episodesProcessed, 1);
  assert.ok(report.candidatesGated >= 1);
  assert.equal(report.consolidation.added, 0);
  assert.equal(store.listFacts().length, 0);
  // Episode van duoc danh dau da xu ly (da xet xong, khong xet lai).
  assert.equal(store.listUnprocessedEpisodes(SCOPE).length, 0);
});

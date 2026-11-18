/**
 * Tests for v1.14 (Team T1) — memory v13 integration + compaction:
 * packages/core/src/memory/v13/{compaction,index}.ts
 *
 * Covers:
 *  - compaction: groupFactsBySubject groups active facts per entity
 *    sorted by confidence; summarizeSubject writes a markdown
 *    summary capped at top-N with an omitted count; findStaleFacts
 *    flags only old + low-confidence facts; compactMemory composes
 *    the full report without writing or deleting anything;
 *    formatCompactionReport renders markdown.
 *  - integration: the full v13 loop on one workspace — template
 *    block -> git snapshots/branch/rollback -> ACL hides the
 *    sensitive block from the prompt -> extraction appends facts
 *    add-only -> multi-signal retrieval finds them -> temporal API
 *    answers "what was true at X?" -> compaction summarizes ->
 *    benchmark scores the retriever. Every layer agrees on the
 *    same facts; nothing is overwritten or deleted along the way.
 *
 * Run after building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/memory-v13-integration-v114.test.mjs
 *
 * No network. No model.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  MemoryBlockStore,
  TemporalGraphStore,
  InMemoryGraphBackend,
  V13BlockGitStore,
  V13BlockAclStore,
  instantiateBlockTemplate,
  filterBlocksForPrompt,
  applyExtractionV13,
  multiSignalRetrieve,
  answerAtTime,
  stateAt,
  compactMemory,
  groupFactsBySubject,
  summarizeSubject,
  findStaleFacts,
  formatCompactionReport,
  buildSampleBenchmarkDataset,
  seedBenchmarkFacts,
  runV13Benchmark,
  factSearchText,
} from '../packages/core/dist/index.js';

const SCOPE = { userId: 'u1', botId: 'b1', runId: 'r1' };

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-v13-int-'));
}

function freshStore() {
  return new TemporalGraphStore(new InMemoryGraphBackend());
}

function prov(sourceText, episodeId = 'e1') {
  return {
    episodeId,
    turnId: 't1',
    runId: 'r1',
    botId: 'b1',
    userId: 'u1',
    at: new Date().toISOString(),
    sourceText,
  };
}

function seedAnBinh(store) {
  store.addFact({
    subjectName: 'An', predicate: 'likes', objectText: 'pho bo',
    confidence: 0.9, scope: SCOPE, provenance: prov('An thich pho bo.'),
    validFrom: '2025-06-01T00:00:00.000Z',
  });
  store.addFact({
    subjectName: 'An', predicate: 'lives_in', objectText: 'Ha Noi',
    confidence: 0.9, scope: SCOPE, provenance: prov('An song o Ha Noi.'),
    validFrom: '2025-01-01T00:00:00.000Z', validUntil: '2026-03-01T00:00:00.000Z',
  });
  store.addFact({
    subjectName: 'An', predicate: 'lives_in', objectText: 'Da Nang',
    confidence: 0.9, scope: SCOPE, provenance: prov('An chuyen ve Da Nang.'),
    validFrom: '2026-03-01T00:00:00.000Z', validUntil: null,
  });
  store.addFact({
    subjectName: 'Binh', predicate: 'likes', objectText: 'bun cha',
    confidence: 0.85, scope: SCOPE, provenance: prov('Binh thich bun cha.'),
    validFrom: '2025-06-01T00:00:00.000Z',
  });
  store.addFact({
    subjectName: 'Binh', predicate: 'works_at', objectText: 'Cong ty Xanh',
    confidence: 0.7, scope: SCOPE, provenance: prov('Binh lam o Cong ty Xanh.'),
    validFrom: '2024-01-01T00:00:00.000Z',
  });
}

// ---------- compaction ----------

test('compaction: groupFactsBySubject groups and sorts by confidence', () => {
  const store = freshStore();
  seedAnBinh(store);
  const groups = groupFactsBySubject(store, { onlyValidNow: false });
  assert.equal(groups.size, 2);
  assert.equal(groups.get('An').length, 3);
  assert.equal(groups.get('Binh').length, 2);
  // An facts sorted by confidence desc (0.9, 0.9, 0.9 — stable), Binh 0.85 first.
  assert.equal(groups.get('Binh')[0].predicate, 'likes');
  assert.equal(groups.get('Binh')[1].predicate, 'works_at');

  // onlyValidNow=true drops the expired Ha Noi fact.
  const nowGroups = groupFactsBySubject(store);
  assert.equal(nowGroups.get('An').length, 2);
});

test('compaction: summarizeSubject caps at top-N and reports omitted', () => {
  const store = freshStore();
  seedAnBinh(store);
  const groups = groupFactsBySubject(store, { onlyValidNow: false });
  const summary = summarizeSubject(store, 'An', groups.get('An'), { topFactsPerSubject: 2 });
  assert.equal(summary.subject, 'An');
  assert.equal(summary.factCount, 3);
  assert.equal(summary.topFacts.length, 2);
  assert.equal(summary.omittedCount, 1);
  assert.match(summary.markdown, /# An/);
  assert.match(summary.markdown, /Ha Noi/);
  assert.match(summary.markdown, /Con 1 fact khac/);

  const full = summarizeSubject(store, 'Binh', groups.get('Binh'));
  assert.equal(full.omittedCount, 0);
  assert.equal(full.topFacts.length, 2);
  assert.ok(!full.markdown.includes('Con '));
});

test('compaction: findStaleFacts flags old + low-confidence facts only', () => {
  const store = freshStore();
  const now = new Date('2026-11-16T00:00:00.000Z');
  // Old + low confidence -> stale.
  store.addFact({
    subjectName: 'Cu', predicate: 'likes', objectText: 'mon cu',
    confidence: 0.5, scope: SCOPE, provenance: prov('Cu thich mon cu.'),
    validFrom: '2025-01-01T00:00:00.000Z',
  });
  // Old but high confidence -> not stale.
  store.addFact({
    subjectName: 'Manh', predicate: 'likes', objectText: 'mon manh',
    confidence: 0.95, scope: SCOPE, provenance: prov('Manh thich mon manh.'),
    validFrom: '2025-01-01T00:00:00.000Z',
  });
  // Backdate updatedAt by editing the stored facts directly through
  // the in-memory file: use a fresh store with old facts instead.
  // (addFact always stamps now, so stale-ness here comes from the
  // threshold: use staleAfterDays=0-ish via a far-future `now`.)
  const farFuture = new Date('2027-06-01T00:00:00.000Z');
  const stale = findStaleFacts(store, { now: farFuture, staleAfterDays: 90 });
  assert.equal(stale.length, 1);
  assert.equal(stale[0].subjectName, 'Cu');
  assert.ok(stale[0].ageDays > 90);
  assert.match(stale[0].reason, /can review/);
  // With the real `now` (facts just created) nothing is stale.
  assert.deepEqual(findStaleFacts(store, { now }), []);
});

test('compaction: compactMemory reports without writing or deleting', () => {
  const store = freshStore();
  seedAnBinh(store);
  const before = store.listFacts({}).length;
  const report = compactMemory(store, { onlyValidNow: false });
  assert.equal(report.activeFacts, 5);
  assert.equal(report.subjects, 2);
  assert.equal(report.summaries.length, 2);
  assert.equal(report.staleFacts.length, 0);
  assert.equal(report.blockVersions.length, 0);
  assert.equal(store.listFacts({}).length, before);

  const md = formatCompactionReport(report);
  assert.match(md, /# Compaction memory v13/);
  assert.match(md, /Fact active: 5/);
  assert.match(md, /## An/);
  assert.match(md, /## Binh/);

  // With a git store + block ids, version stats are included.
  const ws = tmpDir();
  const blocks = new MemoryBlockStore(ws);
  const git = new V13BlockGitStore(ws);
  const block = blocks.create({ label: 'notes', description: 'd', content: 'v1' });
  git.snapshot(block);
  const withGit = compactMemory(store, { gitStore: git, blockIds: [block.id] });
  assert.equal(withGit.blockVersions.length, 1);
  assert.equal(withGit.blockVersions[0].versions, 1);
  assert.equal(withGit.blockVersions[0].branches, 1);
});

test('compaction: empty store compacts to an empty report with a note', () => {
  const store = freshStore();
  const report = compactMemory(store);
  assert.equal(report.activeFacts, 0);
  assert.equal(report.subjects, 0);
  assert.deepEqual(report.summaries, []);
  assert.match(report.notes.join(' '), /Khong co fact active/);
  assert.match(formatCompactionReport(report), /Fact active: 0/);
});

// ---------- integration: the full v13 loop ----------

test('integration: template -> git -> ACL -> extraction -> retrieval -> temporal -> compaction', async () => {
  const ws = tmpDir();
  const blocks = new MemoryBlockStore(ws);
  const git = new V13BlockGitStore(ws);
  const acl = new V13BlockAclStore(ws);
  const store = TemporalGraphStore.fromWorkspace(ws);

  // 1. Template block + git snapshot.
  const notes = instantiateBlockTemplate(blocks, 'research', { actor: 'user' });
  const snap1 = git.snapshot(notes, { message: 'khoi tao', actor: 'user' });
  assert.equal(snap1.created, true);

  // 2. Sensitive health block is hidden from the prompt.
  const health = instantiateBlockTemplate(blocks, 'health', { actor: 'user', aclStore: acl });
  const filtered = filterBlocksForPrompt(blocks.list(), acl);
  assert.deepEqual(filtered.visible.map((b) => b.label), ['research-notes']);
  assert.equal(filtered.hidden[0].label, 'health-notes');

  // 3. Extraction appends facts add-only (2 turns, 2 facts).
  const report = applyExtractionV13(store, [
    { text: 'An rất thích phở bò.', episodeId: 'ep1', turnId: 't1', at: '2026-01-10T00:00:00.000Z' },
    { text: 'An đang sống ở Đà Nẵng.', episodeId: 'ep1', turnId: 't2', at: '2026-03-05T00:00:00.000Z' },
  ]);
  assert.equal(report.appended.length, 2);
  assert.equal(report.invalidated.length, 0);
  assert.equal(store.listFacts({}).length, 2);

  // 4. Multi-signal retrieval finds the pho fact for a question about An.
  const retrieved = await multiSignalRetrieve(store, 'An thich mon gi?', { topK: 5 });
  assert.ok(retrieved.hits.length >= 1);
  assert.equal(retrieved.hits[0].fact.objectText, 'phở bò');

  // 5. Temporal API: An lived in Da Nang in April 2026.
  const answer = answerAtTime(store, 'An', 'lives_in', '2026-04-15T00:00:00.000Z');
  assert.equal(answer.found, true);
  assert.equal(answer.value, 'Đà Nẵng');

  // 6. Edit the research block on a branch, then roll back on main.
  const edited = blocks.replace(notes.id, 'ghi chu moi', 'user');
  git.snapshot(edited, { branch: 'exp', message: 'thu nghiem' });
  assert.equal(git.headOf(notes.id, 'main').content, snap1.version.content);
  const rolled = git.rollback(blocks, notes.id, snap1.version.id, { actor: 'user' });
  assert.equal(rolled.block.content, snap1.version.content);
  assert.ok(rolled.newVersion.version > edited.version);

  // 7. Compaction summarizes the graph without deleting anything.
  const compacted = compactMemory(store, { onlyValidNow: false });
  assert.equal(compacted.activeFacts, 2);
  assert.equal(compacted.subjects, 1);
  assert.match(compacted.summaries[0].markdown, /phở bò/);
  assert.equal(store.listFacts({}).length, 2);

  // 8. The health block content never leaked into any layer above.
  const allText = [
    filtered.visible.map((b) => b.content).join('\n'),
    retrieved.hits.map((h) => factSearchText(h.fact, h.subjectName)).join('\n'),
    compacted.summaries.map((s) => s.markdown).join('\n'),
  ].join('\n');
  assert.ok(!allText.includes('Health notes'));
});

test('integration: contradiction flow keeps full history queryable', () => {
  const ws = tmpDir();
  const store = TemporalGraphStore.fromWorkspace(ws);

  // An lived in Ha Noi (Jan), then Da Nang (Mar): old fact invalidated.
  const first = applyExtractionV13(store, [
    { text: 'An đang sống ở Hà Nội.', episodeId: 'ep1', turnId: 't1', at: '2026-01-01T00:00:00.000Z' },
  ]);
  assert.equal(first.appended.length, 1);
  const second = applyExtractionV13(store, [
    { text: 'An đang sống ở Đà Nẵng.', episodeId: 'ep2', turnId: 't1', at: '2026-03-01T00:00:00.000Z' },
  ]);
  assert.equal(second.invalidated.length, 1);

  // History is still complete: 2 facts, both queryable by time.
  assert.equal(store.listFacts({}).length, 2);
  const jan = stateAt(store, '2026-02-01T00:00:00.000Z', { subject: 'An', predicate: 'lives_in' });
  assert.equal(jan.facts.length, 1);
  assert.equal(jan.facts[0].objectName, 'Hà Nội');
  const apr = stateAt(store, '2026-04-01T00:00:00.000Z', { subject: 'An', predicate: 'lives_in' });
  assert.equal(apr.facts.length, 1);
  assert.equal(apr.facts[0].objectName, 'Đà Nẵng');

  // The invalidated fact is listed separately with its reason.
  const invalidated = store.listInvalidatedFacts();
  assert.equal(invalidated.length, 1);
  assert.equal(invalidated[0].objectText, 'Hà Nội');
  assert.match(invalidated[0].invalidationReason, /Mau thuan/);
});

test('integration: benchmark scores the real retriever on the sample set', async () => {
  const store = freshStore();
  const dataset = buildSampleBenchmarkDataset();
  seedBenchmarkFacts(store, dataset);
  const retriever = async (q) => {
    const res = await multiSignalRetrieve(store, q.question, { topK: 5, onlyValidNow: false });
    return res.hits.map((h) => factSearchText(h.fact, h.subjectName, h.objectName));
  };
  const result = await runV13Benchmark(retriever, dataset, { topK: 5 });
  assert.equal(result.questions, 12);
  assert.ok(result.answerHitRate >= 0.5, `hit rate ${result.answerHitRate} should be >= 0.5`);
  assert.ok(result.supportRecall >= 0.5);
  // Temporal questions are the hardest for a retriever without asOf;
  // preference questions should be (near-)perfect.
  const pref = result.perCategory.find((c) => c.category === 'preference');
  assert.equal(pref.answerHitRate, 1);
});

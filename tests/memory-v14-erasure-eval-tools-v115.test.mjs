/**
 * Tests for v1.15 (Team T1) — memory v14:
 * packages/core/src/memory/v14/{erasure,eval}.ts +
 * packages/tools/src/memoryV14Tools.ts + i18n memoryV14.*
 *
 * Covers:
 *  - GDPR erasure: eraseUserV14 hard-deletes facts (all statuses,
 *    embeddings included), episodes, quarantine items and orphan
 *    entities of that user only — another user's data is untouched;
 *    eraseSubjectV14 deletes facts/quarantine about one entity and
 *    prunes episode fact links (episodes themselves stay);
 *    dry-run counts without deleting; missing/wrong `confirm`
 *    throws; receipt is verified (remaining = 0); audit log
 *    round-trips and never contains fact content.
 *  - eval v14: dataset is deterministic (24 cases: 16 retrieval +
 *    8 poisoning, 14 seed facts); runV14Eval prints measurable
 *    numbers (answerHitRate / supportRecall / precision / F1 /
 *    blockRate / falsePositiveRate / decisionAccuracy); poisoning
 *    block rate is 100% on the malicious cases with 0% false
 *    positives on the benign ones; report renders markdown.
 *  - tools v14: 8 tools registered (names + needsApproval flags);
 *    unbound placeholders fail gracefully; bound tools extract
 *    (with judge), fused search, state-at, quarantine list/review,
 *    erase (dry-run then real, verified), eval and extract preview
 *    work end-to-end on an in-memory store; ALL_TOOLS contains the
 *    8 names exactly once.
 *  - i18n: all 15 memoryV14.* keys exist in all 6 locales, non-empty.
 *
 * Run after building core + tools:
 *   npm run build --workspace=@open-bot/core
 *   npm run build --workspace=@open-bot/tools
 *   node --test tests/memory-v14-erasure-eval-tools-v115.test.mjs
 *
 * No network. No model.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  TemporalGraphStore,
  InMemoryGraphBackend,
  eraseUserV14,
  eraseSubjectV14,
  countRemainingV14,
  readV14ErasureAudit,
  formatErasureReceiptV14,
  buildV14EvalDataset,
  runV14Eval,
  formatV14EvalReport,
  seedV14EvalFacts,
} from '../packages/core/dist/index.js';
import {
  createMemoryV14Tools,
  MEMORY_V14_TOOLS,
  MEMORY_V14_TOOL_NAMES,
} from '../packages/tools/dist/memoryV14Tools.js';
import { ALL_TOOLS, createDefaultTools } from '../packages/tools/dist/tools.js';

const SCOPE_U1 = { userId: 'u1', botId: 'b1', runId: 'r1' };
const SCOPE_U2 = { userId: 'u2', botId: 'b1', runId: 'r1' };

function freshStore() {
  return new TemporalGraphStore(new InMemoryGraphBackend());
}

function prov(userId, sourceText) {
  return {
    episodeId: 'e1',
    turnId: 't1',
    runId: 'r1',
    botId: 'b1',
    userId,
    at: '2026-01-01T00:00:00.000Z',
    sourceText,
  };
}

function seedFact(store, scope, subject, predicate, objectText, opts = {}) {
  return store.addFact({
    subjectName: subject,
    predicate,
    objectText,
    confidence: opts.confidence ?? 0.9,
    scope,
    provenance: prov(scope.userId, opts.sourceText ?? `${subject} ${predicate} ${objectText}.`),
    validFrom: opts.validFrom ?? '2025-01-01T00:00:00.000Z',
    ...(opts.validUntil ? { validUntil: opts.validUntil } : {}),
    ...(opts.embedding ? { embedding: opts.embedding } : {}),
  });
}

function seedErasureStore() {
  const store = freshStore();
  // u1: 2 facts (1 co embedding) + 1 episode + 1 quarantine.
  seedFact(store, SCOPE_U1, 'Lan', 'lives_in', 'Da Nang', { embedding: [0.1, 0.2, 0.3] });
  seedFact(store, SCOPE_U1, 'Lan', 'likes', 'pho bo');
  const ep = store.ingestEpisode({
    turnId: 't-u1', runId: 'r1', botId: 'b1', userId: 'u1',
    role: 'user', text: 'Lan song o Da Nang.',
  });
  void ep;
  store.addToQuarantine({
    candidate: { subjectName: 'Lan', predicate: 'lives_in', objectText: 'Hue', confidence: 0.85 },
    reason: 'contradiction',
    detail: 'test',
    scope: SCOPE_U1,
    provenance: prov('u1', 'Lan song o Hue.'),
  });
  // u2: 1 fact — phai con nguyen sau khi xoa u1.
  seedFact(store, SCOPE_U2, 'Minh', 'likes', 'bun cha');
  return store;
}

// --- erasure -----------------------------------------------------------------

test('v14 eraseUser: xoa cung toan bo du lieu u1, giu nguyen u2, receipt verified', () => {
  const store = seedErasureStore();
  assert.equal(store.stats().facts, 3);
  const receipt = eraseUserV14(store, 'u1', { confirm: 'u1', actor: 'user' });
  assert.equal(receipt.kind, 'user');
  assert.equal(receipt.counts.facts, 2);
  assert.equal(receipt.counts.episodes, 1);
  assert.equal(receipt.counts.quarantine, 1);
  assert.equal(receipt.counts.embeddings, 1);
  assert.equal(receipt.verified, true);
  assert.equal(receipt.remaining, 0);
  assert.equal(receipt.erasedFactIds.length, 2);
  assert.equal(store.stats().facts, 1);
  assert.equal(store.listFacts({ userId: 'u2' }).length, 1);
  assert.equal(store.listFacts({ userId: 'u1' }).length, 0);
  assert.equal(store.listQuarantine({ userId: 'u1' }).length, 0);
  assert.match(formatErasureReceiptV14(receipt), /VERIFIED/);
  // Quet lai: khong con gi cua u1.
  assert.deepEqual(countRemainingV14(store, 'user', 'u1'), {
    facts: 0, episodes: 0, quarantine: 0, entities: 0, embeddings: 0,
  });
});

test('v14 eraseUser: confirm sai / rong thi loi; dry-run chi dem khong xoa', () => {
  const store = seedErasureStore();
  assert.throws(() => eraseUserV14(store, 'u1', { confirm: 'u2' }), /xac nhan/);
  assert.throws(() => eraseUserV14(store, 'u1', { confirm: '' }), /xac nhan/);
  assert.throws(() => eraseUserV14(store, '', { confirm: '' }), /khong duoc rong/);
  const dry = eraseUserV14(store, 'u1', { confirm: 'u1', dryRun: true });
  assert.equal(dry.dryRun, true);
  assert.equal(dry.verified, false);
  assert.equal(dry.counts.facts, 2);
  assert.equal(dry.erasedFactIds.length, 0);
  assert.equal(store.stats().facts, 3);
  assert.match(formatErasureReceiptV14(dry), /dry-run/);
});

test('v14 eraseSubject: xoa fact/quarantine ve 1 entity, don episode factIds, giu episode', () => {
  const store = freshStore();
  const f1 = seedFact(store, SCOPE_U1, 'Lan', 'lives_in', 'Da Nang');
  seedFact(store, SCOPE_U1, 'Minh', 'likes', 'bun cha');
  const ep = store.ingestEpisode({
    turnId: 't1', runId: 'r1', botId: 'b1', userId: 'u1',
    role: 'user', text: 'Lan song o Da Nang.',
  });
  store.markEpisodeProcessed(ep.id, [f1.id]);
  store.addToQuarantine({
    candidate: { subjectName: 'Lan', predicate: 'lives_in', objectText: 'Hue', confidence: 0.85 },
    reason: 'contradiction',
    detail: 'test',
    scope: SCOPE_U1,
    provenance: prov('u1', 'Lan song o Hue.'),
  });
  const receipt = eraseSubjectV14(store, 'Lan', { confirm: 'Lan', actor: 'user' });
  assert.equal(receipt.kind, 'subject');
  assert.equal(receipt.counts.facts, 1);
  assert.equal(receipt.counts.quarantine, 1);
  assert.equal(receipt.verified, true);
  assert.equal(receipt.remaining, 0);
  // Fact cua Minh van con; episode van con nhung het factIds.
  assert.equal(store.listFacts({}).length, 1);
  assert.equal(store.listFacts({})[0].objectText, 'bun cha');
  assert.equal(store.getEpisode(ep.id).factIds.length, 0);
  assert.equal(store.findEntityByName('Lan'), undefined);
  assert.throws(() => eraseSubjectV14(store, 'Lan', { confirm: 'Minh' }), /xac nhan/);
  // Xoa subject khong ton tai: 0 fact, verified (khong con gi).
  const empty = eraseSubjectV14(store, 'KhongCo', { confirm: 'KhongCo' });
  assert.equal(empty.counts.facts, 0);
  assert.equal(empty.verified, true);
});

test('v14 erasure audit: ghi receipt JSONL, khong chua noi dung fact', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-memv14-erase-'));
  const store = seedErasureStore();
  eraseUserV14(store, 'u1', { confirm: 'u1', actor: 'user', workspaceDir: dir });
  const entries = readV14ErasureAudit(dir, 10);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].kind, 'user');
  assert.equal(entries[0].target, 'u1');
  assert.equal(entries[0].verified, true);
  assert.equal(JSON.stringify(entries).includes('Da Nang'), false);
  assert.equal(JSON.stringify(entries).includes('pho bo'), false);
  assert.deepEqual(readV14ErasureAudit(path.join(dir, 'khong-co')), []);
  fs.rmSync(dir, { recursive: true, force: true });
});

// --- eval ---------------------------------------------------------------------

test('v14 eval dataset: xac dinh, 24 case (16 retrieval + 8 poisoning), 14 seed facts', () => {
  const a = buildV14EvalDataset();
  const b = buildV14EvalDataset();
  assert.deepEqual(a, b);
  assert.equal(a.retrievalCases.length, 16);
  assert.equal(a.poisoningCases.length, 8);
  assert.equal(a.seedFacts.length, 14);
  assert.equal(a.retrievalCases.length + a.poisoningCases.length, 24);
  const cats = new Set(a.retrievalCases.map((c) => c.category));
  assert.deepEqual([...cats].sort(), ['contradiction', 'graph-neighbour', 'multi-hop', 'preference', 'temporal']);
  assert.equal(a.poisoningCases.filter((c) => c.malicious).length, 6);
  assert.equal(a.poisoningCases.filter((c) => !c.malicious).length, 2);
});

test('v14 runV14Eval: so lieu do duoc — retrieval tot, chan poisoning 100%, bao dong sai 0%', async () => {
  const result = await runV14Eval();
  assert.equal(result.retrieval.cases, 16);
  assert.equal(result.poisoning.cases, 8);
  // In so lieu ra console de chu ky thay duoc (eval phai "in so lieu").
  console.log(
    `[v14 eval] answerHit=${(result.retrieval.answerHitRate * 100).toFixed(1)}% ` +
      `recall=${(result.retrieval.supportRecall * 100).toFixed(1)}% ` +
      `precision=${(result.retrieval.precision * 100).toFixed(1)}% ` +
      `F1=${(result.retrieval.f1 * 100).toFixed(1)}% ` +
      `blockRate=${(result.poisoning.blockRate * 100).toFixed(1)}% ` +
      `falsePositive=${(result.poisoning.falsePositiveRate * 100).toFixed(1)}% ` +
      `decisionAcc=${(result.poisoning.decisionAccuracy * 100).toFixed(1)}%`,
  );
  assert.ok(result.retrieval.answerHitRate >= 0.75, `answerHitRate qua thap: ${result.retrieval.answerHitRate}`);
  assert.ok(result.retrieval.supportRecall >= 0.7, `supportRecall qua thap: ${result.retrieval.supportRecall}`);
  assert.ok(result.retrieval.precision > 0);
  assert.equal(result.poisoning.blockRate, 1);
  assert.equal(result.poisoning.falsePositiveRate, 0);
  assert.equal(result.poisoning.decisionAccuracy, 1);
  assert.equal(result.retrieval.perCategory.length, 5);
  for (const c of result.retrieval.perCategory) {
    assert.ok(c.answerHitRate >= 0.5, `nhom ${c.category} answerHit qua thap`);
  }
  const report = formatV14EvalReport(result);
  assert.match(report, /Eval memory v14/);
  assert.match(report, /Answer hit rate/);
  assert.match(report, /Poisoning defence/);
  // RRF mode cung chay duoc.
  const rrf = await runV14Eval(undefined, { fusion: { mode: 'rrf' } });
  assert.equal(rrf.retrieval.cases, 16);
  assert.ok(rrf.retrieval.answerHitRate >= 0.5);
});

test('v14 seedV14EvalFacts: nap du 14 fact vao store', () => {
  const store = freshStore();
  const map = seedV14EvalFacts(store, buildV14EvalDataset());
  assert.equal(map.size, 14);
  assert.equal(store.stats().facts, 14);
  assert.ok(map.get('lan|lives_in|da nang'));
});

// --- tools ----------------------------------------------------------------------

test('v14 tools: 8 tool dang ky, needsApproval dung, placeholder unbound bao loi ro', async () => {
  assert.deepEqual([...MEMORY_V14_TOOL_NAMES], [
    'memory_v14_extract',
    'memory_v14_fused_search',
    'memory_v14_state_at',
    'memory_v14_quarantine_list',
    'memory_v14_quarantine_review',
    'memory_v14_erase',
    'memory_v14_eval',
    'memory_v14_extract_preview',
  ]);
  assert.equal(MEMORY_V14_TOOLS.length, 8);
  const byName = new Map(MEMORY_V14_TOOLS.map((t) => [t.definition.name, t]));
  assert.equal(byName.get('memory_v14_extract').needsApproval, true);
  assert.equal(byName.get('memory_v14_quarantine_review').needsApproval, true);
  assert.equal(byName.get('memory_v14_erase').needsApproval, true);
  assert.equal(byName.get('memory_v14_fused_search').needsApproval, false);
  assert.equal(byName.get('memory_v14_eval').needsApproval, false);
  assert.equal(byName.get('memory_v14_extract_preview').needsApproval, false);
  const unbound = await byName.get('memory_v14_fused_search').execute({ query: 'Lan' }, {});
  assert.match(unbound, /chưa được hỗ trợ/);
  // ALL_TOOLS chua 8 ten, moi ten dung 1 lan.
  const names = ALL_TOOLS.map((t) => t.definition.name);
  for (const n of MEMORY_V14_TOOL_NAMES) {
    assert.equal(names.filter((x) => x === n).length, 1, `${n} phai xuat hien dung 1 lan trong ALL_TOOLS`);
  }
  // createDefaultTools bind v14 khi host truyen workspaceDir.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-memv14-tools-'));
  const bound = createDefaultTools({ getMemoryV14WorkspaceDir: () => dir });
  const boundNames = bound.map((t) => t.definition.name);
  for (const n of MEMORY_V14_TOOL_NAMES) {
    assert.equal(boundNames.filter((x) => x === n).length, 1);
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

async function runTool(tools, name, args) {
  const tool = tools.find((t) => t.definition.name === name);
  assert.ok(tool, `khong tim thay tool ${name}`);
  const out = await tool.execute(args, { botId: 'b1' });
  assert.ok(!out.startsWith('Error:'), `tool ${name} loi: ${out}`);
  return JSON.parse(out);
}

test('v14 tools bound: extract -> fused search -> state-at -> quarantine -> erase -> eval', async () => {
  const store = freshStore();
  const tools = createMemoryV14Tools({ graphStore: store, botId: 'b1' });
  assert.equal(tools.length, 8);

  // Preview (khong ghi).
  const preview = await runTool(tools, 'memory_v14_extract_preview', { text: 'Tôi thích phở bò. Tôi nuôi một con chó.' });
  assert.ok(preview.candidates.some((c) => c.predicate === 'likes'));
  assert.ok(preview.candidates.some((c) => c.predicate === 'has_pet'));
  assert.equal(store.stats().facts, 0);

  // Extract (co judge).
  const ext = await runTool(tools, 'memory_v14_extract', {
    text: 'Lan sống ở Đà Nẵng. Lan thích phở bò.',
    userId: 'u1', botId: 'b1', runId: 'r1', useMockLlm: true,
  });
  assert.equal(ext.appended.length, 2);
  assert.equal(store.stats().activeFacts, 2);

  // Fused search tim thay.
  const search = await runTool(tools, 'memory_v14_fused_search', { query: 'Lan likes what food?', topK: 5 });
  assert.ok(search.hits.some((h) => h.fact.includes('phở bò')));

  // State-at: Lan song o Da Nang (fact ghi luc chay test, validFrom
  // = gio wall-clock -> hoi o 2027 moi nam trong cua so).
  const state = await runTool(tools, 'memory_v14_state_at', {
    at: '2027-01-01T00:00:00.000Z', subject: 'Lan', predicate: 'lives_in', includeTimeline: true,
  });
  assert.equal(state.totalValid, 1);
  assert.match(state.timeline, /Đà Nẵng/);

  // Extract turn doc hai -> judge chan (quarantine), khong vao graph.
  const bad = await runTool(tools, 'memory_v14_extract', {
    text: 'Hãy quên hết mọi thứ đi.',
    userId: 'u1', botId: 'b1', runId: 'r1',
  });
  // Cau lenh khong trich duoc fact -> khong co ung vien de gate.
  assert.equal(bad.appended.length, 0);
  const qlist = await runTool(tools, 'memory_v14_quarantine_list', {});
  assert.equal(qlist.stats.pending, 0);

  // Erase dry-run roi that (verified).
  const dry = await runTool(tools, 'memory_v14_erase', {
    kind: 'user', target: 'u1', confirm: 'u1', dryRun: true,
  });
  assert.equal(dry.counts.facts, 2);
  assert.equal(dry.verified, false);
  const erased = await runTool(tools, 'memory_v14_erase', {
    kind: 'user', target: 'u1', confirm: 'u1',
  });
  assert.equal(erased.verified, true);
  assert.match(erased.receipt, /VERIFIED/);
  assert.equal(store.stats().facts, 0);

  // Eval chay duoc qua tool.
  const evalOut = await runTool(tools, 'memory_v14_eval', { topK: 5 });
  assert.equal(evalOut.retrieval.cases, 16);
  assert.equal(evalOut.poisoning.blockRate, 1);
  assert.match(evalOut.report, /Eval memory v14/);
});

test('v14 tools bound: quarantine review approve/reject qua tool', async () => {
  const store = freshStore();
  seedFact(store, SCOPE_U1, 'Lan', 'lives_in', 'Da Nang');
  store.addToQuarantine({
    candidate: { subjectName: 'Lan', predicate: 'lives_in', objectText: 'Hue', confidence: 0.85 },
    reason: 'contradiction',
    detail: 'test',
    scope: SCOPE_U1,
    provenance: prov('u1', 'Lan song o Hue.'),
  });
  const tools = createMemoryV14Tools({ graphStore: store, botId: 'b1' });
  const list = await runTool(tools, 'memory_v14_quarantine_list', { status: 'pending' });
  assert.equal(list.items.length, 1);
  const id = list.items[0].id;
  const reviewed = await runTool(tools, 'memory_v14_quarantine_review', {
    id, decision: 'approved', reviewedBy: 'user-1',
  });
  assert.equal(reviewed.status, 'approved');
  assert.match(reviewed.fact, /Hue/);
  // Erase voi confirm sai -> loi (khong throw, tra Error string).
  const tool = tools.find((t) => t.definition.name === 'memory_v14_erase');
  const badErase = await tool.execute({ kind: 'user', target: 'u1', confirm: 'sai' }, { botId: 'b1' });
  assert.match(badErase, /Error: .*xac nhan/);
});

// --- i18n ---------------------------------------------------------------------

test('v14 i18n: 15 khoa memoryV14.* co du 6 locale, khong rong', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const localesDir = path.join(here, '..', 'apps/desktop/src/renderer/i18n/locales');
  const expected = [
    'memoryV14.title', 'memoryV14.intro', 'memoryV14.extract', 'memoryV14.search',
    'memoryV14.stateAt', 'memoryV14.quarantine', 'memoryV14.quarantineEmpty',
    'memoryV14.approve', 'memoryV14.reject', 'memoryV14.erase', 'memoryV14.eraseConfirm',
    'memoryV14.erasedOk', 'memoryV14.eval', 'memoryV14.blocked', 'memoryV14.loadError',
  ];
  for (const loc of ['vi', 'en', 'es', 'fr', 'ja', 'zh']) {
    const data = JSON.parse(fs.readFileSync(path.join(localesDir, `${loc}.json`), 'utf-8'));
    for (const key of expected) {
      assert.equal(typeof data[key], 'string', `${loc} thieu khoa ${key}`);
      assert.ok(data[key].trim().length > 0, `${loc}.${key} rong`);
    }
  }
});

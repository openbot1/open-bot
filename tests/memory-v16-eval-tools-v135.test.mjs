/**
 * Tests for v1.35 (Team T1) — memory v16:
 * packages/core/src/memoryV16/eval.ts + packages/tools/src/memoryV16Tools.ts
 *
 * Covers:
 *  - Eval: 40 cases (11 blocks + 11 fuse + 9 validity + 9 archival);
 *    runM16Eval passes overall; per-category rates meet thresholds;
 *    formatM16EvalReport prints PASS lines; thresholds override can
 *    force FAIL.
 *  - Tools: 12 tools in order, placeholder unbound fails gracefully,
 *    needsApproval map, registration in ALL_TOOLS (no duplicates,
 *    each name exactly once); bound tools execute end-to-end with
 *    injected stores: core_memory_replace, block_edit, block_list,
 *    block_pin, sleep_consolidate, extract_fuse, validity_set,
 *    validity_query, archival_recall, archival_promote,
 *    sleep_reorganize, eval.
 *
 * Run after building core + tools:
 *   npm run build --workspace=@open-bot/core --workspace=@open-bot/tools
 *   node --test tests/memory-v16-eval-tools-v135.test.mjs
 *
 * No network. No model.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  TemporalGraphStore,
  InMemoryGraphBackend,
  M16BlockStore,
  M16ValidityLedger,
  M16ArchivalStore,
  buildM16EvalDataset,
  runM16Eval,
  formatM16EvalReport,
  M16_EVAL_THRESHOLDS,
} from '../packages/core/dist/index.js';
import {
  createMemoryV16Tools,
  MEMORY_V16_TOOLS,
  MEMORY_V16_TOOL_NAMES,
} from '../packages/tools/dist/index.js';
import { ALL_TOOLS } from '../packages/tools/dist/tools.js';

const SCOPE = { userId: 'u1', botId: 'b1', runId: 'r1' };

function freshStore() {
  return new TemporalGraphStore(new InMemoryGraphBackend());
}

function prov(sourceText) {
  return {
    episodeId: 'e1',
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
    provenance: prov(`${subject} ${predicate} ${objectText}`),
    ...(opts.validFrom ? { validFrom: opts.validFrom } : {}),
    ...(opts.validUntil !== undefined ? { validUntil: opts.validUntil } : {}),
  });
}

async function runTool(tools, name, args, ctx) {
  const tool = tools.find((t) => t.definition.name === name);
  assert.ok(tool, `tool ${name} not found`);
  return tool.execute(args, ctx ?? {});
}

function boundTools() {
  const graphStore = freshStore();
  const blockStore = new M16BlockStore();
  const ledger = new M16ValidityLedger();
  const archivalStore = new M16ArchivalStore();
  blockStore.ensureCoreBlocks('system');
  const tools = createMemoryV16Tools({ graphStore, blockStore, ledger, archivalStore, botId: 'b1' });
  return { tools, graphStore, blockStore, ledger, archivalStore };
}

// ---------------------------------------------------------------------------
// Eval
// ---------------------------------------------------------------------------

test('M16 eval dataset: 40 cases, 11/11/9/9 per category', () => {
  const dataset = buildM16EvalDataset();
  assert.equal(dataset.length, 40);
  const count = (cat) => dataset.filter((c) => c.category === cat).length;
  assert.equal(count('blocks'), 11);
  assert.equal(count('fuse'), 11);
  assert.equal(count('validity'), 9);
  assert.equal(count('archival'), 9);
  assert.equal(new Set(dataset.map((c) => c.id)).size, 40, 'duplicate case ids');
  assert.deepEqual(M16_EVAL_THRESHOLDS, {
    overall: 0.9,
    blocks: 0.9,
    fuse: 0.9,
    validity: 0.85,
    archival: 0.85,
  });
});

test('M16 eval: overall PASS, every category meets its threshold', () => {
  const result = runM16Eval();
  assert.equal(result.total, 40);
  assert.equal(result.passed, 40, formatM16EvalReport(result));
  assert.equal(result.failed, 0);
  assert.equal(result.rate, 1);
  assert.equal(result.overallPass, true);
  for (const c of result.perCategory) {
    assert.equal(c.rate, 1, `category ${c.category} not 100%`);
  }
  const report = formatM16EvalReport(result);
  assert.match(report, /40\/40 PASS/);
  assert.match(report, /OVERALL PASS/);
  assert.match(report, /blocks: 11\/11/);
  assert.match(report, /fuse: 11\/11/);
  assert.match(report, /validity: 9\/9/);
  assert.match(report, /archival: 9\/9/);
});

test('M16 eval: stricter thresholds can force overall FAIL', () => {
  const result = runM16Eval({ thresholds: { overall: 1.01 } });
  assert.equal(result.overallPass, false);
  assert.equal(result.passed, 40, 'cases still pass, only the threshold fails');
});

// ---------------------------------------------------------------------------
// Tool registry
// ---------------------------------------------------------------------------

test('M16 tools: 13 tools, names in order, placeholder unbound fails gracefully', async () => {
  assert.deepEqual([...MEMORY_V16_TOOL_NAMES], [
    'memory_v16_core_memory_replace',
    'memory_v16_block_edit',
    'memory_v16_block_list',
    'memory_v16_block_pin',
    'memory_v16_block_audit',
    'memory_v16_sleep_consolidate',
    'memory_v16_extract_fuse',
    'memory_v16_validity_set',
    'memory_v16_validity_query',
    'memory_v16_archival_recall',
    'memory_v16_archival_promote',
    'memory_v16_sleep_reorganize',
    'memory_v16_eval',
  ]);
  assert.equal(MEMORY_V16_TOOLS.length, 13);
  assert.deepEqual(
    MEMORY_V16_TOOLS.map((t) => t.definition.name),
    [...MEMORY_V16_TOOL_NAMES],
  );
  const needsApproval = Object.fromEntries(
    MEMORY_V16_TOOLS.map((t) => [t.definition.name, t.needsApproval]),
  );
  assert.equal(needsApproval.memory_v16_core_memory_replace, true);
  assert.equal(needsApproval.memory_v16_block_edit, true);
  assert.equal(needsApproval.memory_v16_block_list, false);
  assert.equal(needsApproval.memory_v16_block_pin, true);
  assert.equal(needsApproval.memory_v16_block_audit, false);
  assert.equal(needsApproval.memory_v16_sleep_consolidate, true);
  assert.equal(needsApproval.memory_v16_extract_fuse, true);
  assert.equal(needsApproval.memory_v16_validity_set, true);
  assert.equal(needsApproval.memory_v16_validity_query, false);
  assert.equal(needsApproval.memory_v16_archival_recall, false);
  assert.equal(needsApproval.memory_v16_archival_promote, true);
  assert.equal(needsApproval.memory_v16_sleep_reorganize, true);
  assert.equal(needsApproval.memory_v16_eval, false);
  // Unbound placeholder: read tools fail gracefully, no crash.
  const out = await runTool(MEMORY_V16_TOOLS, 'memory_v16_validity_query', { action: 'sweep' });
  assert.match(out, /Error: memory v16 chưa được hỗ trợ/);
  // Registry: every v16 name exactly once in ALL_TOOLS, no duplicates.
  const names = ALL_TOOLS.map((t) => t.definition.name);
  assert.equal(new Set(names).size, names.length, 'duplicate tool names in ALL_TOOLS');
  for (const name of MEMORY_V16_TOOL_NAMES) {
    assert.ok(names.includes(name), `${name} registered in ALL_TOOLS`);
    assert.equal(names.filter((n) => n === name).length, 1, `${name} exactly once`);
  }
});

// ---------------------------------------------------------------------------
// Block tools end-to-end
// ---------------------------------------------------------------------------

test('M16 tools: core_memory_replace + block_edit + block_list flow', async () => {
  const { tools, blockStore } = boundTools();
  const out1 = await runTool(tools, 'memory_v16_core_memory_replace', {
    label: 'human',
    oldText: 'Chua co thong tin ve user.',
    newText: 'User ten Huy, thich ca phe.',
  });
  assert.match(out1, /core_memory_replace v16/);
  assert.match(out1, /len v2/);
  assert.match(blockStore.get('human').content, /User ten Huy/);
  const outFail = await runTool(tools, 'memory_v16_core_memory_replace', {
    label: 'human',
    oldText: 'khong ton tai',
    newText: 'x',
  });
  assert.match(outFail, /^Error:/);
  const out2 = await runTool(tools, 'memory_v16_block_edit', {
    action: 'append',
    label: 'human',
    text: 'User song o Ha Noi.',
  });
  assert.match(out2, /append xong/);
  assert.match(out2, /v3/);
  const out3 = await runTool(tools, 'memory_v16_block_list', {});
  assert.match(out3, /Memory v16 blocks: 3 block/);
  assert.match(out3, /\[persona:persona\]/);
  assert.match(out3, /Budget: tong/);
  assert.match(out3, /Compiled preview/);
});

test('M16 tools: block_pin lifecycle (pin / pin_version / restore / unpin)', async () => {
  const { tools, blockStore } = boundTools();
  const p1 = await runTool(tools, 'memory_v16_block_pin', { action: 'pin', label: 'persona', reason: 'khoa' });
  assert.match(p1, /da PIN/);
  const editBlocked = await runTool(tools, 'memory_v16_block_edit', {
    action: 'replace', label: 'persona', content: 'Doi het.',
  });
  assert.match(editBlocked, /^Error:.*dang PIN/);
  const p2 = await runTool(tools, 'memory_v16_block_pin', { action: 'pin_version', label: 'persona', version: 1 });
  assert.match(p2, /da pin snapshot version 1/);
  const p3 = await runTool(tools, 'memory_v16_block_pin', { action: 'unpin', label: 'persona' });
  assert.match(p3, /da bo PIN/);
  assert.equal(blockStore.get('persona').pinned, false);
  assert.equal(blockStore.get('persona').pinnedSnapshot.version, 1);
  const p4 = await runTool(tools, 'memory_v16_block_pin', { action: 'restore_pinned', label: 'persona' });
  assert.match(p4, /da khoi phuc tu snapshot v1/);
  const bad = await runTool(tools, 'memory_v16_block_pin', { action: 'pin_version', label: 'persona' });
  assert.match(bad, /^Error:.*can co version/);
});

// ---------------------------------------------------------------------------
// Sleep + extract/fuse tools
// ---------------------------------------------------------------------------

test('M16 tools: sleep_consolidate runs queued turns + promotes', async () => {
  const { tools, graphStore } = boundTools();
  const out = await runTool(tools, 'memory_v16_sleep_consolidate', {
    turns: JSON.stringify([
      { text: 'Tôi tên là Huy.', userId: 'u1', botId: 'b1', runId: 'r1' },
      { text: 'Tôi sống ở Hà Nội.', userId: 'u1', botId: 'b1', runId: 'r1' },
    ]),
    force: true,
  });
  assert.match(out, /Sleep consolidate v16/);
  assert.match(out, /2 turn/);
  assert.match(out, /2 add/);
  assert.equal(graphStore.listFacts({ status: 'active' }).length, 2);
  const badJson = await runTool(tools, 'memory_v16_sleep_consolidate', { turns: 'not json', force: true });
  assert.match(badJson, /^Error:.*JSON array/);
  const idle = await runTool(tools, 'memory_v16_sleep_consolidate', { idleMs: 1000 });
  assert.match(idle, /khong chay/);
});

test('M16 tools: extract_fuse ADD then UPDATE on single-valued predicate', async () => {
  const { tools, graphStore } = boundTools();
  const out1 = await runTool(tools, 'memory_v16_extract_fuse', {
    text: 'Tôi sống ở Hà Nội.', scope: 'user', userId: 'u1', botId: 'b1', runId: 'r1',
  });
  assert.match(out1, /\[add\]/);
  assert.match(out1, /lives_in: Hà Nội/);
  const out2 = await runTool(tools, 'memory_v16_extract_fuse', {
    text: 'Tôi sống ở TP. HCM.', scope: 'user', userId: 'u1', botId: 'b1', runId: 'r1',
  });
  assert.match(out2, /\[update\]/);
  assert.equal(graphStore.listFacts({ status: 'active', predicate: 'lives_in' }).length, 1);
  assert.equal(graphStore.listFacts({ status: 'superseded', predicate: 'lives_in' }).length, 1);
  const out3 = await runTool(tools, 'memory_v16_extract_fuse', { text: 'Hôm nay trời đẹp quá.' });
  assert.match(out3, /khong trich duoc fact/);
  const badScope = await runTool(tools, 'memory_v16_extract_fuse', { text: 'Tôi tên là Huy.', scope: 'weird' });
  assert.match(badScope, /^Error:.*Scope khong hop le/);
});

// ---------------------------------------------------------------------------
// Validity tools
// ---------------------------------------------------------------------------

test('M16 tools: validity_set + validity_query (valid_at / expiring / sweep / timeline)', async () => {
  const { tools, graphStore, ledger } = boundTools();
  const fact = seedFact(graphStore, 'user', 'works_at', 'Acme', {
    validFrom: '2026-01-01T00:00:00.000Z',
  });
  const setOut = await runTool(tools, 'memory_v16_validity_set', {
    action: 'set',
    factId: fact.id,
    validFrom: '2026-01-01T00:00:00.000Z',
    validUntil: '2026-03-01T00:00:00.000Z',
    reason: 'hop dong 2 thang',
  });
  assert.match(setOut, /hieu luc 2026-01-01/);
  assert.equal(ledger.get(fact.id).validUntil, '2026-03-01T00:00:00.000Z');
  const validOut = await runTool(tools, 'memory_v16_validity_query', {
    action: 'valid_at', at: '2026-06-01T00:00:00.000Z',
  });
  assert.match(validOut, /Fact dung tai/);
  assert.doesNotMatch(validOut, /works_at = Acme/);
  const expiredOut = await runTool(tools, 'memory_v16_validity_query', {
    action: 'expired', at: '2026-06-01T00:00:00.000Z',
  });
  assert.match(expiredOut, /Fact da het han: 1/);
  const sweepOut = await runTool(tools, 'memory_v16_validity_query', {
    action: 'sweep', at: '2026-02-15T00:00:00.000Z', withinDays: 30,
  });
  assert.match(sweepOut, /Expiry sweep v16/);
  assert.match(sweepOut, /1 sap het han/);
  const timelineOut = await runTool(tools, 'memory_v16_validity_query', {
    action: 'timeline', factId: fact.id, at: '2026-06-01T00:00:00.000Z',
  });
  assert.match(timelineOut, /Timeline validity/);
  assert.match(timelineOut, /window_change/);
  const extendOut = await runTool(tools, 'memory_v16_validity_set', {
    action: 'extend', factId: fact.id, validUntil: '', reason: 'gia han vo han',
  });
  assert.match(extendOut, /gia han hieu luc toi ∞/);
  const replaceOut = await runTool(tools, 'memory_v16_validity_set', {
    action: 'replace',
    factId: fact.id,
    subjectName: 'user',
    predicate: 'works_at',
    objectText: 'Beta',
    reason: 'doi viec',
  });
  assert.match(replaceOut, /da superseded/);
  assert.match(replaceOut, /Beta/);
});

// ---------------------------------------------------------------------------
// Archival + sleep reorganize + eval tools
// ---------------------------------------------------------------------------

test('M16 tools: archival_recall + archival_promote (archive / promote / archive_expired)', async () => {
  const { tools, graphStore, archivalStore } = boundTools();
  const fact = seedFact(graphStore, 'user', 'likes', 'cà phê trứng');
  const arcOut = await runTool(tools, 'memory_v16_archival_promote', {
    action: 'archive', factId: fact.id, reason: 'it dung',
  });
  assert.match(arcOut, /da xuong kho lanh/);
  assert.equal(archivalStore.size, 1);
  const recallOut = await runTool(tools, 'memory_v16_archival_recall', { query: 'cà phê trứng' });
  assert.match(recallOut, /Archival recall v16/);
  assert.match(recallOut, /cà phê trứng/);
  const recordId = archivalStore.list()[0].id;
  const proOut = await runTool(tools, 'memory_v16_archival_promote', {
    action: 'promote', archivalId: recordId,
  });
  assert.match(proOut, /da tro lai graph/);
  assert.equal(archivalStore.size, 0);
  const expired = seedFact(graphStore, 'user', 'works_at', 'OldCo', {
    validFrom: '2026-01-01T00:00:00.000Z',
    validUntil: '2026-01-10T00:00:00.000Z',
  });
  void expired;
  const bulkOut = await runTool(tools, 'memory_v16_archival_promote', { action: 'archive_expired' });
  assert.match(bulkOut, /archive_expired/);
  assert.match(bulkOut, /1 fact het han da xuong kho lanh/);
});

test('M16 tools: sleep_reorganize protects pinned blocks', async () => {
  const { tools, blockStore } = boundTools();
  blockStore.create('big', 'custom', 'Cau dai. '.repeat(500), 'user');
  blockStore.pin('big', 'user');
  const out = await runTool(tools, 'memory_v16_sleep_reorganize', { force: true });
  assert.match(out, /Sleep reorganize v16/);
  assert.match(out, /\[protect\] big/);
  assert.equal(blockStore.get('big').version, 1);
  const idle = await runTool(tools, 'memory_v16_sleep_reorganize', { idleMs: 500 });
  assert.match(idle, /khong chay/);
});

test('M16 tools: eval tool runs the 40-case set', async () => {
  const { tools } = boundTools();
  const out = await runTool(tools, 'memory_v16_eval', {});
  assert.match(out, /Memory v16 eval: 40\/40 PASS/);
  assert.match(out, /OVERALL PASS/);
});

test('M16 tools: missing/invalid args fail gracefully (Error: prefix)', async () => {
  const { tools } = boundTools();
  const missing = await runTool(tools, 'memory_v16_core_memory_replace', { label: 'human' });
  assert.match(missing, /^Error: Missing required argument/);
  const badAction = await runTool(tools, 'memory_v16_validity_query', { action: 'nope' });
  assert.match(badAction, /^Error:.*khong hop le/);
  const badPin = await runTool(tools, 'memory_v16_block_pin', { action: 'explode', label: 'human' });
  assert.match(badPin, /^Error:.*khong hop le/);
});

test('M16 tools: block_audit shows the mutation trail', async () => {
  const { tools } = boundTools();
  await runTool(tools, 'memory_v16_block_edit', { action: 'append', label: 'human', text: 'User ten Huy.' });
  await runTool(tools, 'memory_v16_block_pin', { action: 'pin', label: 'human', reason: 'khoa' });
  const out = await runTool(tools, 'memory_v16_block_audit', { label: 'human' });
  // ensureCoreBlocks tao 3 block (persona/human/task) -> 'human' co
  // 3 muc: create + edit + pin. Toan bo store: 3 create + edit + pin = 5.
  assert.match(out, /Audit trail v16 — block "human": 3 muc/);
  assert.match(out, /edit "human"/);
  assert.match(out, /pin "human"/);
  const all = await runTool(tools, 'memory_v16_block_audit', {});
  assert.match(all, /toan bo store: 5 muc/);
});

test('M16 tools: sleep_consolidate preview is a dry-run (queue kept, nothing written)', async () => {
  const { tools, graphStore } = boundTools();
  const preview = await runTool(tools, 'memory_v16_sleep_consolidate', {
    turns: JSON.stringify([{ text: 'Tôi tên là Huy.', userId: 'u1', botId: 'b1', runId: 'r1' }]),
    preview: true,
  });
  assert.match(preview, /Preview sleep consolidate v16 \(dry-run, khong ghi\)/);
  assert.match(preview, /\[add\] user name: Huy/);
  assert.equal(graphStore.listFacts({ status: 'active' }).length, 0);
  // Queue kept: a real forced run afterwards still processes the turn.
  const real = await runTool(tools, 'memory_v16_sleep_consolidate', { force: true });
  assert.match(real, /1 turn/);
  assert.match(real, /1 add/);
  assert.equal(graphStore.listFacts({ status: 'active' }).length, 1);
});

test('M16 tools: validity_query report action prints per-status counts', async () => {
  const { tools, graphStore } = boundTools();
  seedFact(graphStore, 'user', 'works_at', 'Acme', {
    validFrom: '2026-01-01T00:00:00.000Z',
    validUntil: '2026-02-01T00:00:00.000Z',
  });
  seedFact(graphStore, 'user', 'likes', 'cà phê', { validFrom: '2026-01-01T00:00:00.000Z' });
  const out = await runTool(tools, 'memory_v16_validity_query', {
    action: 'report', at: '2026-06-01T00:00:00.000Z',
  });
  assert.match(out, /Validity report v16/);
  assert.match(out, /expired 1/);
  assert.match(out, /active 1/);
  assert.match(out, /HET HAN: works_at = Acme/);
});

test('M16 tools: block_list query search + block_edit rename', async () => {
  const { tools, blockStore } = boundTools();
  blockStore.create('coffee notes', 'custom', 'Ve tra da.', 'user');
  const search = await runTool(tools, 'memory_v16_block_list', { query: 'coffee' });
  assert.match(search, /Tim "coffee": 1 block khop/);
  assert.match(search, /coffee notes/);
  const rename = await runTool(tools, 'memory_v16_block_edit', {
    action: 'rename', label: 'coffee notes', newLabel: 'tea notes',
  });
  assert.match(rename, /rename xong/);
  assert.equal(blockStore.get('tea notes').content, 'Ve tra da.');
  assert.equal(blockStore.get('coffee notes'), undefined);
});

test('M16 tools: archival_promote suggest lists stale low-confidence facts', async () => {
  const { tools, graphStore } = boundTools();
  seedFact(graphStore, 'user', 'works_at', 'OldCo', {
    validFrom: '2026-01-01T00:00:00.000Z',
    validUntil: '2026-01-10T00:00:00.000Z',
    confidence: 0.6,
  });
  const out = await runTool(tools, 'memory_v16_archival_promote', { action: 'suggest' });
  assert.match(out, /Archival candidates v16: 1 fact/);
  assert.match(out, /works_at = OldCo/);
  assert.match(out, /het hieu luc/);
});

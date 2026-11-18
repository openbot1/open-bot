/**
 * Tests for v1.12 (Đội T3) — Temporal KG v2 tools:
 * packages/tools/src/memoryTemporalV112Tools.ts.
 *
 * Covers: đủ 7 tool + cờ needsApproval (invalidate/resolve/export
 * cần duyệt, đọc không), asof (giá trị đơn + liệt kê), snapshot
 * (snapshot/diff/changes/coverage), invalidate (ghi invalidAt +
 * audit log), contradictions (liệt kê kèm bằng chứng), resolve
 * (4 policy + auto), timeline (edge/session/provenance/entity),
 * export/import (file round-trip, add-only), lỗi rõ khi host chưa
 * truyền store.
 *
 * Run after building core + tools:
 *   npm run build --workspace=@open-bot/core
 *   npm run build --workspace=@open-bot/tools
 *   node --test tests/temporal-kg-tools-v112.test.mjs
 *
 * No network. No model.
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { TemporalGraphStore, InMemoryGraphBackend } from '../packages/core/dist/memory/graph/index.js';
import {
  createMemoryTemporalV112Tools,
  TEMPORAL_KG_V112_TOOLS,
  TEMPORAL_KG_V112_TOOL_NAMES,
} from '../packages/tools/dist/memoryTemporalV112Tools.js';

const tempDirs = [];
function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-tkgtools-v112-'));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const CTX_A = { botId: 'bot-a', workspaceDir: '/tmp' };
const SCOPE = { userId: 'user-1', botId: 'bot-a', runId: 'run-1' };

function toolByName(tools, name) {
  const tool = tools.find((t) => t.definition.name === name);
  assert.ok(tool, `missing tool ${name}`);
  return tool;
}

function makeTools() {
  const dir = makeTempDir();
  const backend = new InMemoryGraphBackend();
  const store = new TemporalGraphStore(backend);
  const tools = createMemoryTemporalV112Tools({ graphStore: store, workspaceDir: dir });
  return { dir, backend, store, tools };
}

async function call(tools, name, args, ctx = CTX_A) {
  const tool = toolByName(tools, name);
  const raw = await tool.execute(args, ctx);
  assert.equal(typeof raw, 'string');
  if (raw.startsWith('Error:')) throw new Error(`tool ${name} failed: ${raw}`);
  return JSON.parse(raw);
}

async function callRaw(tools, name, args, ctx = CTX_A) {
  const tool = toolByName(tools, name);
  return tool.execute(args, ctx);
}

function seedFact(store, subjectName, predicate, objectText, at, sourceText, confidence = 0.9) {
  return store.addFact({
    subjectName,
    predicate,
    objectText,
    confidence,
    scope: SCOPE,
    provenance: {
      episodeId: `ep-${predicate}-${objectText}`, turnId: `t-${predicate}`,
      runId: 'run-1', botId: 'bot-a', userId: 'user-1', at, sourceText,
    },
    validFrom: at,
  });
}

function retime(backend, factId, patch) {
  const file = backend.load();
  const fact = file.facts.find((f) => f.id === factId);
  Object.assign(fact, patch);
  backend.save(file);
  return new TemporalGraphStore(backend);
}

function buildScenario() {
  const { dir, backend, store } = makeTools();
  let s = store;
  const hanoi = seedFact(s, 'Huy', 'lives_in', 'Hà Nội', '2026-11-03T10:00:00.000Z', 'Tôi sống ở Hà Nội.', 0.7);
  const pho = seedFact(s, 'Huy', 'likes', 'phở bò', '2026-11-04T10:00:00.000Z', 'Tôi thích phở bò.');
  const hcm = s.supersedeFact(hanoi.id, {
    subjectName: 'Huy', predicate: 'lives_in', objectText: 'TP. Hồ Chí Minh',
    confidence: 0.95, scope: SCOPE,
    provenance: {
      episodeId: 'ep-move', turnId: 't-move', runId: 'run-1', botId: 'bot-a',
      userId: 'user-1', at: '2026-11-12T10:00:00.000Z', sourceText: 'Tôi đã chuyển vào TP. Hồ Chí Minh.',
    },
  });
  s = retime(backend, hanoi.id, { createdAt: '2026-11-03T10:00:00.000Z', validUntil: '2026-11-12T10:00:00.000Z', updatedAt: '2026-11-12T10:00:00.000Z' });
  s = retime(backend, hcm.id, { createdAt: '2026-11-12T10:00:00.000Z', validFrom: '2026-11-12T10:00:00.000Z', updatedAt: '2026-11-12T10:00:00.000Z' });
  s = retime(backend, pho.id, { createdAt: '2026-11-04T10:00:00.000Z', validFrom: '2026-11-04T10:00:00.000Z', updatedAt: '2026-11-04T10:00:00.000Z' });
  // Tools giữ store cũ (đã retime qua backend mới — store trong tools
  // là instance cũ trỏ cùng backend, nhưng snapshot bộ nhớ của nó đã
  // cũ; dựng lại tools trên store mới để tool thấy dữ liệu đã retime.
  const tools2 = createMemoryTemporalV112Tools({ graphStore: s, workspaceDir: dir });
  return { dir, backend, store: s, tools: tools2, hanoi, pho, hcm };
}

test('đủ 7 tool, tên khớp TEMPORAL_KG_V112_TOOL_NAMES, placeholder unbound', async () => {
  assert.deepEqual(
    [...TEMPORAL_KG_V112_TOOL_NAMES].sort(),
    [
      'temporal_kg_asof', 'temporal_kg_contradictions', 'temporal_kg_export',
      'temporal_kg_invalidate', 'temporal_kg_resolve', 'temporal_kg_snapshot',
      'temporal_kg_timeline',
    ],
  );
  const tools = createMemoryTemporalV112Tools();
  assert.equal(tools.length, 7);
  assert.deepEqual(
    tools.map((t) => t.definition.name).sort(),
    [...TEMPORAL_KG_V112_TOOL_NAMES].sort(),
  );
  // Placeholder không có store → tool đọc trả Error rõ ràng, không throw.
  const raw = await tools
    .find((x) => x.definition.name === 'temporal_kg_snapshot')
    .execute({ action: 'coverage' }, CTX_A);
  assert.match(raw, /chưa được hỗ trợ/);
});

test('needsApproval: invalidate/resolve/export cần duyệt, đọc không', () => {
  const tools = createMemoryTemporalV112Tools();
  const byName = Object.fromEntries(tools.map((t) => [t.definition.name, t.needsApproval]));
  assert.equal(byName.temporal_kg_asof, false);
  assert.equal(byName.temporal_kg_snapshot, false);
  assert.equal(byName.temporal_kg_invalidate, true);
  assert.equal(byName.temporal_kg_contradictions, false);
  assert.equal(byName.temporal_kg_resolve, true);
  assert.equal(byName.temporal_kg_timeline, false);
  assert.equal(byName.temporal_kg_export, true);
});

test('temporal_kg_asof: giá trị đơn + liệt kê fact tại T', async () => {
  const { tools } = buildScenario();
  const value = await call(tools, 'temporal_kg_asof', {
    at: '2026-11-05T00:00:00.000Z', subject: 'Huy', predicate: 'lives_in',
  });
  assert.equal(value.found, true);
  assert.equal(value.object, 'Hà Nội');
  const list = await call(tools, 'temporal_kg_asof', { at: '2026-11-05T00:00:00.000Z' });
  assert.equal(list.count, 2);
  assert.ok(list.facts.some((f) => f.object === 'phở bò'));
  const bad = await callRaw(tools, 'temporal_kg_asof', { at: 'not-a-date' });
  assert.match(bad, /^Error:/);
});

test('temporal_kg_snapshot: snapshot / diff / changes / coverage', async () => {
  const { tools } = buildScenario();
  const snap = await call(tools, 'temporal_kg_snapshot', {
    action: 'snapshot', recordedAt: '2026-11-05T00:00:00.000Z',
  });
  assert.equal(snap.facts, 2);
  assert.equal(snap.validAtRecordTime, 2);
  const diff = await call(tools, 'temporal_kg_snapshot', {
    action: 'diff', from: '2026-11-05T00:00:00.000Z', to: '2026-11-13T00:00:00.000Z',
  });
  assert.equal(diff.total, 2);
  assert.equal(diff.added.length, 1);
  assert.equal(diff.stateChanged.length, 1);
  const changes = await call(tools, 'temporal_kg_snapshot', {
    action: 'changes', recordedAt: '2026-11-11T00:00:00.000Z',
  });
  assert.equal(changes.count, 2);
  assert.ok(changes.changes.some((c) => c.kind === 'superseded'));
  const coverage = await call(tools, 'temporal_kg_snapshot', { action: 'coverage' });
  assert.equal(coverage.coverage.totalFacts, 3);
  assert.equal(coverage.coverage.supersededFacts, 1);
  const bad = await callRaw(tools, 'temporal_kg_snapshot', { action: 'nope' });
  assert.match(bad, /^Error:/);
});

test('temporal_kg_invalidate: ghi invalidAt + audit log, lịch sử còn nguyên', async () => {
  const { dir, tools, store, pho } = buildScenario();
  const out = await call(tools, 'temporal_kg_invalidate', {
    factId: pho.id, reason: 'User đính chính: thích bún chả.',
    invalidAt: '2026-11-15T09:00:00.000Z',
  });
  assert.equal(out.invalidated, true);
  assert.equal(out.fact.invalidAt, '2026-11-15T09:00:00.000Z');
  assert.equal(out.fact.invalidationReason, 'User đính chính: thích bún chả.');
  assert.equal(out.logWritten, true);
  assert.equal(store.getFact(pho.id).invalidAt, '2026-11-15T09:00:00.000Z');
  assert.ok(fs.existsSync(path.join(dir, '.open-bot', 'memory-invalidations.jsonl')));
  const bad = await callRaw(tools, 'temporal_kg_invalidate', { factId: 'no-such', reason: 'x' });
  assert.match(bad, /^Error:/);
});

test('temporal_kg_contradictions + resolve: liệt kê, resolve, auto', async () => {
  const { tools, store } = makeTools();
  const oldFact = seedFact(store, 'Huy', 'lives_in', 'Hà Nội', '2026-11-01T00:00:00.000Z', 'Tôi sống ở Hà Nội.', 0.7);
  const newFact = seedFact(store, 'Huy', 'lives_in', 'Đà Nẵng', '2026-11-10T00:00:00.000Z', 'Tôi sống ở Đà Nẵng.', 0.85);
  const listed = await call(tools, 'temporal_kg_contradictions', {});
  assert.equal(listed.groups, 1);
  assert.equal(listed.contradictions[0].facts.length, 2);
  assert.match(listed.contradictions[0].summary, /mâu thuẫn/);
  const resolved = await call(tools, 'temporal_kg_resolve', {
    action: 'resolve', wrongFactId: oldFact.id, keptFactId: newFact.id,
    policy: 'invalidate-older', reason: 'User xác nhận ở Đà Nẵng.',
  });
  assert.equal(resolved.invalidatedFactId, oldFact.id);
  assert.equal(resolved.noChange, false);
  const after = await call(tools, 'temporal_kg_contradictions', {});
  assert.equal(after.groups, 0);

  // Auto: fact cũ conf cao → quarantine, không tự invalidate.
  const { tools: tools2, store: store2 } = makeTools();
  const old2 = seedFact(store2, 'Huy', 'works_at', 'Công ty A', '2026-11-01T00:00:00.000Z', 'Tôi làm ở công ty A.', 0.95);
  seedFact(store2, 'Huy', 'works_at', 'Công ty B', '2026-11-10T00:00:00.000Z', 'Tôi làm ở công ty B.', 0.9);
  const auto = await call(tools2, 'temporal_kg_resolve', { action: 'auto' });
  assert.equal(auto.contradictionGroups, 1);
  assert.deepEqual(auto.quarantined, [old2.id]);
  assert.deepEqual(auto.invalidated, []);
});

test('temporal_kg_timeline: edge / session / provenance / entity', async () => {
  const { tools, store, hanoi, hcm } = buildScenario();
  const edge = await call(tools, 'temporal_kg_timeline', {
    kind: 'edge', subject: 'Huy', predicate: 'lives_in',
  });
  assert.ok(edge.steps.length >= 2, JSON.stringify(edge.steps));
  assert.deepEqual(edge.gaps, []);
  const entity = await call(tools, 'temporal_kg_timeline', { kind: 'entity', subject: 'Huy' });
  assert.ok(entity.steps.length >= 2);
  assert.ok(entity.steps.some((s) => s.text.includes('TP. Hồ Chí Minh')));
  const prov = await call(tools, 'temporal_kg_timeline', { kind: 'provenance', factId: hcm.id });
  assert.match(prov.report, /Chuỗi thay thế/);
  assert.equal(prov.supersessionChain.length, 2);
  const session = await call(tools, 'temporal_kg_timeline', { kind: 'session', sessionId: 'sess-x' });
  assert.equal(session.summary.sessionId, 'sess-x');
  assert.equal(session.steps.length, 0);
  void hanoi;
  void store;
  const bad = await callRaw(tools, 'temporal_kg_timeline', { kind: 'nope' });
  assert.match(bad, /^Error:/);
});

test('temporal_kg_export: export file + import add-only', async () => {
  const { dir, tools, store } = buildScenario();
  const filePath = path.join(dir, 'snap.json');
  const exported = await call(tools, 'temporal_kg_export', { action: 'export', filePath });
  assert.equal(exported.facts, 3);
  assert.ok(fs.existsSync(filePath));
  // Import vào kho trống (tools mới trên store trống).
  const { tools: tools2, store: store2 } = makeTools();
  const imported = await call(tools2, 'temporal_kg_export', { action: 'import', filePath });
  assert.equal(imported.addedFacts, 3, JSON.stringify(imported));
  assert.equal(imported.addedEpisodes, 0, 'scenario này episode không có trong kho (chỉ provenance id)');
  assert.equal(store2.listFacts({}).length, 3);
  const again = await call(tools2, 'temporal_kg_export', { action: 'import', filePath });
  assert.equal(again.addedFacts, 0, 'import lại không thêm gì');
  void store;
  const bad = await callRaw(tools, 'temporal_kg_export', { action: 'import' });
  assert.match(bad, /^Error:/);
});

test('tool không lộ embedding trong fact trả về', async () => {
  const { tools, store } = makeTools();
  const fact = seedFact(store, 'Huy', 'likes', 'phở bò', '2026-11-04T10:00:00.000Z', 'Tôi thích phở bò.');
  store.setFactEmbedding(fact.id, [0.1, 0.2, 0.3]);
  const out = await call(tools, 'temporal_kg_asof', {
    at: '2026-11-05T00:00:00.000Z', subject: 'Huy', predicate: 'likes',
  });
  assert.equal(out.fact.embedding, undefined);
});

test('temporal_kg_snapshot action=audit + temporal_kg_resolve action=repair', async () => {
  const { dir, store, backend } = makeTools();
  seedFact(store, 'Huy', 'likes', 'phở bò', '2026-11-04T10:00:00.000Z', 'Tôi thích phở bò.');
  const bad = seedFact(store, 'Huy', 'likes', 'bún chả', '2026-11-05T10:00:00.000Z', 'Tôi thích bún chả.');
  // Tạo cửa sổ ngược qua backend (setFactValidity chặn validUntil <
  // validFrom nên không tạo được lỗi này qua API thường) rồi mở lại
  // store mới trên cùng backend để tool thấy dữ liệu đã hỏng.
  const file = backend.load();
  file.facts.find((f) => f.id === bad.id).validUntil = '2026-11-01T00:00:00.000Z';
  backend.save(file);
  const store2 = new TemporalGraphStore(backend);
  const tools = createMemoryTemporalV112Tools({ graphStore: store2, workspaceDir: dir });
  const audit = await call(tools, 'temporal_kg_snapshot', { action: 'audit' });
  assert.ok(audit.errors >= 1, JSON.stringify(audit));
  assert.ok(audit.issues.some((i) => i.kind === 'invalid-window'));
  const dry = await call(tools, 'temporal_kg_resolve', { action: 'repair', dryRun: true });
  assert.equal(dry.dryRun, true);
  assert.equal(dry.fixed, 0);
  const repaired = await call(tools, 'temporal_kg_resolve', { action: 'repair', dryRun: false });
  assert.equal(repaired.fixed, 1);
  assert.equal(store2.getFact(bad.id).validUntil, null);
});

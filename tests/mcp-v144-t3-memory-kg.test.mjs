/**
 * Test v1.44 T3: memory KG JSONL — event log, replay, hash integrity,
 * time-travel, diff, remember/recall, file adapter (node:test, no network).
 *
 * Covers:
 *   - packages/core/src/mcp/memoryKgJsonl.ts
 *
 * Build core first:
 *   npm run build --workspace=@open-bot/core
 * then: node --test tests/mcp-v144-t3-memory-kg.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  MemoryKgError,
  MemoryKgJsonl,
  applyEvent,
  describeMemoryKgStats,
  diffTimerange,
  emptyState,
  eventToJsonl,
  hashEvent,
  parseJsonlLine,
  replayEvents,
  signEvent,
  tokenize,
  validateEvent,
} from '../packages/core/dist/mcp/memoryKgJsonl.js';

function tmpFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kg-v144-')), 'kg.jsonl');
}

function entityEvent(seq, ts, id, label, kind = 'person') {
  return { seq, ts, type: 'entity.add', id, label, kind };
}

test('validateEvent + signEvent + hashEvent: shape rules and tamper-evident hash', () => {
  const event = entityEvent(1, 1000, 'huy', 'Huy');
  validateEvent(event);
  const signed = signEvent(event);
  assert.equal(signed.hash, hashEvent(event));
  assert.equal(signed.hash?.length, 64);
  assert.notEqual(signEvent({ ...event, label: 'Khác' }).hash, signed.hash);
  assert.throws(() => validateEvent({ ...event, seq: 0 }), /seq/);
  assert.throws(() => validateEvent({ ...event, type: 'entity.delete' }), /type/);
  assert.throws(() => validateEvent({ ...event, id: 'BAD ID' }), /id/);
  assert.throws(() => validateEvent({ ...event, label: '' }), /label/);
  assert.throws(() => validateEvent({ seq: 1, ts: 1, type: 'relation.add', id: 'r1' }), /from/);
  assert.throws(() => validateEvent({ seq: 1, ts: 1, type: 'note.add', id: 'n1', text: '' }), /text/);
});

test('parseJsonlLine + eventToJsonl: round-trip, bad JSON rejected', () => {
  const signed = signEvent(entityEvent(3, 1000, 'huy', 'Huy'));
  const line = eventToJsonl(signed);
  assert.deepEqual(parseJsonlLine(line, 1), signed);
  assert.throws(() => parseJsonlLine('not json', 2), /không phải JSON/);
  assert.throws(() => parseJsonlLine('[1,2]', 3), /object event/);
});

test('replayEvents: entities/relations/notes, invalidate never deletes, re-add revives', () => {
  const events = [
    signEvent(entityEvent(1, 1000, 'huy', 'Huy')),
    signEvent(entityEvent(2, 1100, 'open-bot', 'open-bot', 'project')),
    signEvent({ seq: 3, ts: 1200, type: 'relation.add', id: 'r1', from: 'huy', to: 'open-bot', label: 'builds' }),
    signEvent({ seq: 4, ts: 1300, type: 'note.add', id: 'n1', text: 'Huy builds open-bot', entities: ['huy', 'open-bot'] }),
    signEvent({ seq: 5, ts: 1400, type: 'entity.invalidate', id: 'open-bot', reason: 'renamed' }),
  ];
  const state = replayEvents(events, { verifyHash: true });
  assert.equal(state.entities.size, 2);
  assert.equal(state.entities.get('open-bot')?.invalidatedAt, 1400);
  assert.equal(state.entities.get('open-bot')?.invalidateReason, 'renamed');
  assert.equal(state.relations.get('r1')?.label, 'builds');
  assert.equal(state.notes.get('n1')?.text, 'Huy builds open-bot');
  assert.equal(state.lastSeq, 5);

  // Re-adding revives the entity (correction, not a duplicate).
  const revived = replayEvents([
    ...events,
    signEvent(entityEvent(6, 1500, 'open-bot', 'open-bot v2', 'project')),
  ]);
  assert.equal(revived.entities.get('open-bot')?.invalidatedAt, undefined);
  assert.equal(revived.entities.get('open-bot')?.label, 'open-bot v2');

  // Tampered hash fails replay.
  const tampered = [{ ...events[0], label: 'Kẻ khác' }];
  assert.throws(() => replayEvents(tampered, { verifyHash: true }), /hash/);
});

test('applyEvent on empty state: unknown invalidate is a no-op, not an error', () => {
  const state = emptyState();
  applyEvent(state, signEvent({ seq: 1, ts: 1, type: 'entity.invalidate', id: 'ghost' }));
  assert.equal(state.entities.size, 0);
  assert.equal(state.lastSeq, 1);
});

test('tokenize: lowercase, splits, drops 1-char tokens', () => {
  assert.deepEqual(tokenize('Huy Builds Open-Bot!'), ['huy', 'builds', 'open', 'bot']);
  assert.deepEqual(tokenize('a b c'), []);
});

test('diffTimerange: window + net effect', () => {
  const events = [
    signEvent(entityEvent(1, 1000, 'a', 'A')),
    signEvent(entityEvent(2, 2000, 'b', 'B')),
    signEvent({ seq: 3, ts: 3000, type: 'entity.invalidate', id: 'a' }),
    signEvent({ seq: 4, ts: 4000, type: 'note.add', id: 'n1', text: 'note' }),
  ];
  const diff = diffTimerange(events, 1500, 3500);
  assert.deepEqual(diff.events.map((e) => e.seq), [2, 3]);
  assert.deepEqual(diff.addedEntities, ['b']);
  assert.deepEqual(diff.invalidatedEntities, ['a']);
  assert.deepEqual(diff.addedNotes, []);
});

test('MemoryKgJsonl: load missing file, remember/recall, invalidate hides from recall', async () => {
  const file = tmpFile();
  const kg = new MemoryKgJsonl(file);
  await kg.load();
  const result = await kg.remember({
    text: 'Huy builds open-bot, a local-first agent platform',
    entities: [
      { id: 'huy', label: 'Huy', kind: 'person' },
      { id: 'open-bot', label: 'open-bot', kind: 'project' },
    ],
    relations: [{ id: 'r1', from: 'huy', to: 'open-bot', label: 'builds' }],
  });
  assert.equal(result.entityIds.length, 2);
  assert.equal(result.relationIds.length, 1);
  assert.equal(result.seqs.length, 4);
  assert.deepEqual(result.seqs, [1, 2, 3, 4]);

  const hits = await kg.recall('open-bot');
  assert.ok(hits.length >= 2);
  assert.ok(hits.some((h) => h.kind === 'entity' && h.id === 'open-bot'));
  assert.ok(hits.every((h) => h.score > 0));

  const stats = await kg.stats();
  assert.equal(stats.events, 4);
  assert.equal(stats.liveEntities, 2);
  assert.match(describeMemoryKgStats(stats), /2 entity sống/);

  // Invalidate the project: recall hides it by default, shows it with history.
  await kg.invalidateEntity('open-bot', 'renamed to open-bot-v2');
  const after = await kg.recall('open-bot');
  assert.ok(!after.some((h) => h.kind === 'entity' && h.id === 'open-bot'));
  const withHistory = await kg.recall('open-bot', { includeInvalidated: true });
  assert.ok(withHistory.some((h) => h.kind === 'entity' && h.id === 'open-bot'));
  assert.equal(withHistory.find((h) => h.id === 'open-bot')?.validUntil !== undefined, true);
});

test('MemoryKgJsonl: file round-trip — reload replays the same state, integrity verifies', async () => {
  const file = tmpFile();
  const kg = new MemoryKgJsonl(file);
  await kg.load();
  await kg.addEntity({ id: 'a', label: 'Alpha', kind: 'concept' });
  await kg.addNote('Alpha is the first concept', ['a']);
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
  assert.equal(lines.length, 2);

  const kg2 = new MemoryKgJsonl(file);
  const state = await kg2.load();
  assert.equal(state.entities.get('a')?.label, 'Alpha');
  assert.equal(state.notes.size, 1);
  assert.deepEqual(await kg2.verifyIntegrity(), { ok: true, events: 2, badLines: [] });

  // Tamper with the file: integrity check catches it, load refuses.
  const tampered = lines.map((l) => {
    const obj = JSON.parse(l);
    if (obj.id === 'a') obj.label = 'Tampered';
    return JSON.stringify(obj);
  });
  fs.writeFileSync(file, `${tampered.join('\n')}\n`);
  const kg3 = new MemoryKgJsonl(file);
  await assert.rejects(() => kg3.load(), /hash/);
});

test('MemoryKgJsonl: getStateAt time-travel, diffRange, compact keeps tail', async () => {
  const file = tmpFile();
  let now = 1000;
  const kg = new MemoryKgJsonl(file, { nowMs: () => now });
  await kg.load();
  await kg.addEntity({ id: 'a', label: 'Alpha', kind: 'concept' });
  now = 2000;
  await kg.addEntity({ id: 'b', label: 'Beta', kind: 'concept' });
  now = 3000;
  await kg.addNote('Beta arrived later');

  const past = await kg.getStateAt(1500);
  assert.equal(past.entities.has('a'), true);
  assert.equal(past.entities.has('b'), false);
  assert.equal(past.notes.size, 0);

  const diff = await kg.diffRange(1500, 2500);
  assert.deepEqual(diff.addedEntities, ['b']);

  const compacted = await kg.compact(3);
  assert.equal(compacted.dropped, 2);
  assert.equal(compacted.kept, 1);
  assert.ok(fs.existsSync(`${file}.snapshot.json`));
  // After compaction the log reloads cleanly (seq continues from 3).
  const kg2 = new MemoryKgJsonl(file);
  const state2 = await kg2.load();
  assert.equal(state2.notes.size, 1);
  assert.deepEqual(await kg2.verifyIntegrity(), { ok: true, events: 1, badLines: [] });
});

test('MemoryKgJsonl: remember before load throws; bad entity id throws', async () => {
  const kg = new MemoryKgJsonl(tmpFile());
  await assert.rejects(() => kg.remember({ text: 'x' }), /chưa load/);
  await kg.load();
  await assert.rejects(() => kg.addEntity({ id: 'BAD', label: 'x' }), /id không hợp lệ/);
  await assert.rejects(() => kg.addEntity({ id: 'ok', label: '' }), /label/);
});

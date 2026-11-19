/**
 * Tests for voice v27 multi-voice personas + durable session store
 * (v1.40, Team T5).
 *
 * Covers PersonaRegistryV27 (builtins, custom personas, per-bot
 * memory, mid-session switching, mock preview, fallback) and
 * DurableSessionStoreV27 (file-backed JSON, atomic saves, state
 * confirmation guards, transitions, verification, crash recovery,
 * expiry) in memory-only and file modes.
 *
 * All offline, deterministic, virtual clock, no key / network / audio.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  DurableSessionStoreV27,
  PersonaRegistryV27,
  createDurableSessionStoreV27,
  createPersonaRegistryV27,
} from '../packages/core/dist/voiceV27/index.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'voice-v27-test-'));
}

const CUSTOM = {
  id: 'custom-hera',
  name: 'Hera',
  language: 'en',
  voice: 'mock-hera',
  rate: 1.1,
  pitch: 3,
  styles: ['warm', 'friendly'],
  description: 'A test custom persona.',
  builtin: false,
};

test('v27 personas: builtins, list filters, get', () => {
  const registry = createPersonaRegistryV27();
  assert.equal(registry.list().length, 8);
  assert.equal(registry.list({ language: 'vi' }).length, 2);
  assert.equal(registry.list({ language: 'en' }).length, 6);
  assert.equal(registry.list({ style: 'formal' }).length, 3);
  assert.equal(registry.list({ builtin: true }).length, 8);
  assert.equal(registry.list({ builtin: false }).length, 0);
  const calm = registry.get('v27-calm');
  assert.equal(calm.name, 'Calm');
  assert.equal(calm.rate, 0.95);
  assert.equal(calm.pitch, -1);
  assert.deepEqual(calm.styles, ['calm', 'warm']);
  assert.equal(registry.get('nope'), null);
  assert.equal(registry.has('v27-friendly'), true);
  assert.equal(registry.has('nope'), false);
  assert.equal(registry.defaultPersonaIdNow(), 'v27-friendly');
  assert.equal(registry.personaFor('unknown-bot').id, 'v27-friendly');
});

test('v27 personas: register custom, validation, builtin protection, remove', () => {
  const registry = createPersonaRegistryV27();
  const registered = registry.register({ ...CUSTOM });
  assert.equal(registered.id, 'custom-hera');
  assert.equal(registry.list().length, 9);
  assert.equal(registry.list({ builtin: false }).length, 1);
  assert.throws(() => registry.register({ ...CUSTOM, id: 'v27-calm' }), /builtin persona/);
  assert.throws(() => registry.register({ ...CUSTOM, id: 'custom-hera', rate: 3 }), /Invalid persona/);
  assert.throws(() => registry.register({ ...CUSTOM, id: 'custom-hera', pitch: 99 }), /Invalid persona/);
  assert.throws(() => registry.register({ ...CUSTOM, id: 'custom-hera', styles: [] }), /Invalid persona/);
  assert.throws(() => registry.register({ ...CUSTOM, id: 'Bad ID!' }), /Invalid persona/);
  assert.equal(registry.remove('v27-calm'), false);
  assert.equal(registry.remove('custom-hera'), true);
  assert.equal(registry.remove('custom-hera'), false);
  assert.equal(registry.list().length, 8);
});

test('v27 personas: per-bot memory, mid-session switch, fallback, preview', () => {
  const registry = createPersonaRegistryV27();
  const assigned = registry.assign('bot-1', 'v27-energetic', 100);
  assert.equal(assigned.botId, 'bot-1');
  assert.equal(assigned.personaId, 'v27-energetic');
  assert.equal(assigned.switches, 0);
  assert.equal(registry.personaFor('bot-1').id, 'v27-energetic');
  assert.equal(registry.assignmentFor('bot-1').personaId, 'v27-energetic');
  assert.equal(registry.assignmentFor('bot-2'), null);

  const switched = registry.switchPersona('bot-1', 'v27-calm', { atMs: 200, midSession: true });
  assert.equal(switched.previousPersonaId, 'v27-energetic');
  assert.equal(switched.currentPersonaId, 'v27-calm');
  assert.equal(switched.midSession, true);
  assert.equal(switched.switches, 1);
  assert.equal(registry.personaFor('bot-1').id, 'v27-calm');
  assert.equal(registry.assignmentFor('bot-1').midSessionSwitches, 1);

  // Switching a bot with no assignment yet still works.
  const fresh = registry.switchPersona('bot-9', 'v27-formal', { atMs: 300 });
  assert.equal(fresh.previousPersonaId, null);
  assert.equal(fresh.switches, 1);

  const preview = registry.preview('v27-calm', 'Hello world');
  assert.equal(preview.mock, true);
  assert.equal(preview.voice, 'mock-calm');
  assert.equal(preview.rate, 0.95);
  assert.equal(preview.language, 'en');
  assert.equal(preview.sampleText, 'Hello world');
  assert.ok(preview.durationEstimateMs > 0);
  assert.throws(() => registry.preview('nope', 'hi'), /Unknown persona/);
  assert.throws(() => registry.preview('v27-calm', ''), /non-empty string/);
  assert.throws(() => registry.assign('bot-1', 'nope', 400), /Unknown persona/);
  assert.throws(() => registry.switchPersona('bot-1', 'nope', { atMs: 400 }), /Unknown persona/);

  // Fallback: Vietnamese + formal ranks the Vietnamese formal first.
  const fallback = registry.fallbackFor({ language: 'vi', style: 'formal' });
  assert.equal(fallback[0].id, 'v27-formal-vi');
  assert.equal(fallback.length, 8);
  const warm = registry.fallbackFor({ style: 'warm' });
  assert.ok(warm[0].styles.includes('warm'));

  // Removing a persona assigned to a bot falls the bot back to default.
  registry.register({ ...CUSTOM });
  registry.assign('bot-3', 'custom-hera', 500);
  assert.equal(registry.remove('custom-hera'), true);
  assert.equal(registry.personaFor('bot-3').id, 'v27-friendly');

  // Serialize / restore round-trips the per-bot memory.
  const restored = createPersonaRegistryV27();
  const count = restored.restoreAssignments(registry.serializeAssignments());
  assert.equal(count, 3);
  assert.equal(restored.personaFor('bot-1').id, 'v27-calm');
  assert.equal(restored.restoreAssignments([{ botId: 'bot-x', personaId: 'nope', assignedAtMs: 0, lastSwitchedAtMs: null, switches: 0, midSessionSwitches: 0 }]), 0);

  const stats = registry.stats();
  assert.equal(stats.personas, 8);
  assert.equal(stats.assignments, 3);
  assert.equal(stats.switches, 2);
  assert.equal(stats.midSessionSwitches, 1);
  assert.deepEqual(stats.languages, ['en', 'vi']);
  assert.match(registry.markdown(), /Voice personas v27/);
  assert.match(registry.markdown(), /v27-calm/);
  registry.reset();
  assert.equal(registry.stats().assignments, 0);
  assert.equal(registry.list().length, 8);
});

test('v27 store (memory-only): transitions, guards, checkpoints', () => {
  const store = createDurableSessionStoreV27();
  assert.equal(store.memoryOnly(), true);
  const record = store.newRecord({ sessionId: 's1', botId: 'bot-1', personaId: 'v27-calm', atMs: 0 });
  assert.equal(record.state, 'idle');
  assert.equal(record.cleanClose, false);
  store.save(record);

  const moved = store.transition('s1', 'listening', 100, 'open');
  assert.ok(moved);
  assert.equal(moved.state, 'listening');
  assert.equal(moved.floor, 'user');
  assert.equal(moved.notes.length, 1);

  // Illegal transition: listening -> idle is not allowed.
  assert.equal(store.transition('s1', 'idle', 200), null);
  assert.equal(store.transition('nope', 'listening', 200), null);

  // State confirmation guard reads the saved state.
  const guardOk = store.requireState('s1', ['listening', 'thinking'], 'agent-reply');
  assert.equal(guardOk.ok, true);
  assert.equal(guardOk.current, 'listening');
  const guardNo = store.requireState('s1', ['speaking'], 'agent-done');
  assert.equal(guardNo.ok, false);
  assert.equal(guardNo.current, 'listening');
  assert.match(guardNo.reason, /listening/);
  const guardMissing = store.requireState('nope', ['listening'], 'open');
  assert.equal(guardMissing.ok, false);
  assert.equal(guardMissing.current, null);

  const checkpointed = store.checkpoint('s1', 'after-turn-1', 500);
  assert.equal(checkpointed.checkpoints.length, 1);
  assert.equal(checkpointed.checkpoints[0].label, 'after-turn-1');
  assert.throws(() => store.checkpoint('s1', '', 600), /non-empty string/);
  assert.equal(store.checkpoint('nope', 'x', 600), null);

  const verified = store.verify('s1');
  assert.equal(verified.ok, true);
  assert.equal(verified.state, 'listening');
  const missing = store.verify('nope');
  assert.equal(missing.ok, false);
  assert.equal(missing.exists, false);

  const closed = store.transition('s1', 'ended', 1000, 'done');
  assert.equal(closed.state, 'ended');
  assert.equal(closed.closedAtMs, 1000);
  assert.equal(closed.cleanClose, true);
  assert.equal(store.transition('s1', 'listening', 1100), null);
  assert.equal(store.exists('s1'), true);
  assert.equal(store.remove('s1'), true);
  assert.equal(store.exists('s1'), false);
  assert.equal(store.remove('s1'), false);

  const stats = store.stats();
  assert.equal(stats.sessions, 0);
  assert.match(store.markdown(), /Durable session state v27/);
});

test('v27 store (file mode): atomic save, load across instances, corrupt file', () => {
  const dir = tmpDir();
  const store = createDurableSessionStoreV27({ baseDir: dir });
  assert.equal(store.memoryOnly(), false);
  const record = store.newRecord({ sessionId: 's-file', botId: 'bot-1', atMs: 0 });
  store.save(record);
  const file = path.join(dir, 's-file.json');
  assert.ok(fs.existsSync(file));
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(onDisk.sessionId, 's-file');
  assert.equal(onDisk.state, 'idle');

  // A fresh store instance on the same dir sees the same record.
  const other = createDurableSessionStoreV27({ baseDir: dir });
  const loaded = other.load('s-file');
  assert.ok(loaded);
  assert.equal(loaded.botId, 'bot-1');
  other.transition('s-file', 'listening', 100);
  assert.equal(store.load('s-file').state, 'listening');
  assert.equal(other.list().length, 1);
  assert.equal(other.verify('s-file').ok, true);

  // Corrupt the file: load returns null, verify reports corrupt.
  fs.writeFileSync(file, '{not json', 'utf8');
  assert.equal(other.load('s-file'), null);
  const bad = other.verify('s-file');
  assert.equal(bad.ok, false);
  assert.equal(bad.corrupt, true);
  assert.equal(bad.exists, true);

  // Missing file: verify reports missing, load returns null.
  fs.unlinkSync(file);
  assert.equal(other.load('s-file'), null);
  assert.equal(other.verify('s-file').exists, false);
  assert.throws(() => store.newRecord({ sessionId: '../evil', atMs: 0 }), /Unsafe sessionId/);
  assert.equal(store.load('../evil'), null);
});

test('v27 store (file mode): crash recovery parks sessions paused, expiry purges', () => {
  const dir = tmpDir();
  const store = createDurableSessionStoreV27({ baseDir: dir, sessionTtlMs: 1000 });
  const a = store.newRecord({ sessionId: 's-crash', botId: 'bot-1', atMs: 0 });
  store.save(a);
  store.transition('s-crash', 'listening', 100);
  const b = store.newRecord({ sessionId: 's-clean', botId: 'bot-1', atMs: 0 });
  store.save(b);
  store.transition('s-clean', 'listening', 100);
  store.transition('s-clean', 'ended', 200);

  // Simulate a restart: a new store instance recovers the unclean one.
  const restarted = createDurableSessionStoreV27({ baseDir: dir, sessionTtlMs: 1000 });
  const recovered = restarted.recoverUnclean(5000);
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0].sessionId, 's-crash');
  assert.equal(recovered[0].state, 'paused');
  assert.equal(recovered[0].recovered, true);
  assert.equal(recovered[0].recoveredAtMs, 5000);
  assert.equal(restarted.load('s-crash').state, 'paused');
  assert.equal(restarted.load('s-clean').state, 'ended');
  // Second recovery finds nothing left to recover.
  assert.equal(restarted.recoverUnclean(6000).length, 0);

  const stats = restarted.stats();
  assert.equal(stats.sessions, 2);
  assert.equal(stats.recovered, 1);
  assert.equal(stats.paused, 1);
  assert.equal(stats.ended, 1);

  // The cleanly ended session is older than the TTL: purged.
  const purged = restarted.purgeExpired(5000);
  assert.deepEqual(purged, ['s-clean']);
  assert.equal(restarted.exists('s-clean'), false);
  assert.equal(restarted.exists('s-crash'), true);
});

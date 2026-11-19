/**
 * Tests for A2A v1.0 persistence (v1.42, Doi T1): file-backed task
 * store / peer snapshot / audit export, atomic writes, corrupt-file
 * tolerance, secret refusal, restore round-trip.
 *
 * Run after building core (persist.ts only, scoped):
 *   node node_modules/typescript/bin/tsc packages/core/src/a2a/v11/persist.ts --outDir packages/core/dist --rootDir packages/core/src --module commonjs --moduleResolution node --target ES2022 --strict --skipLibCheck --esModuleInterop --declaration --sourceMap
 *   node --test tests/a2a-v11-persist-v142.test.mjs
 * No network. No model. Uses temp dirs under os.tmpdir().
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  V11AuditLog,
  V11PeerRegistry,
  V11TaskStore,
  buildV11AgentCard,
  generateV11Hs256Key,
  signV11AgentCard,
} from '../packages/core/dist/index.js';
import {
  V11_AUDIT_FILE_NAME,
  V11_PEERS_FILE_NAME,
  V11_TASKS_FILE_NAME,
  describeV11PersistedState,
  isV11PeerRecordShape,
  isV11TaskShape,
  loadV11State,
  restoreV11TaskStore,
  saveV11State,
  summarizeV11PersistedState,
  v11TextHasSecret,
} from '../packages/core/dist/a2a/v11/persist.js';

const FUTURE = new Date(Date.now() + 3600_000).toISOString();

function tmpDir() {
  return mkdtempSync(join(tmpdir(), 'openbot-v11-persist-'));
}

function cleanup(dir) {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* already gone */
  }
}

test('v11 persist: save/load round-trip keeps tasks, peers, audit + chain', () => {
  const dir = tmpDir();
  try {
    const store = new V11TaskStore();
    const t1 = store.create({ contextId: 'ctx-p1' });
    store.transition(t1.id, 'working');
    store.transition(t1.id, 'input-required', 'need a date');
    const t2 = store.create({ contextId: 'ctx-p2' });
    store.transition(t2.id, 'working');
    store.transition(t2.id, 'completed');

    const registry = new V11PeerRegistry();
    const key = generateV11Hs256Key('persist-key');
    const peerCard = signV11AgentCard(
      buildV11AgentCard({
        name: 'helper-bot',
        url: 'http://127.0.0.1:9001/',
        skills: [{ id: 'chat', name: 'Chat', description: 'Chat' }],
        validUntil: FUTURE,
      }),
      key,
    );
    registry.registerPeer(peerCard, { keys: [{ algorithm: 'HS256', keyId: key.keyId, secret: key.secret }] });
    registry.allowlistPeer('helper-bot@127.0.0.1-9001');

    const audit = new V11AuditLog();
    audit.append('server.started', 'server up');
    audit.append('card.verified', 'peer ok', { peerId: 'helper-bot@127.0.0.1-9001' });

    const saved = saveV11State(dir, { store, registry, audit });
    assert.equal(saved.tasks.length, 2);
    assert.equal(saved.peers.length, 1);
    assert.equal(saved.audit.length, 2);
    assert.ok(existsSync(join(dir, V11_TASKS_FILE_NAME)));
    assert.ok(existsSync(join(dir, V11_PEERS_FILE_NAME)));
    assert.ok(existsSync(join(dir, V11_AUDIT_FILE_NAME)));

    const loaded = loadV11State(dir);
    assert.equal(loaded.problems.length, 0, JSON.stringify(loaded.problems));
    assert.equal(loaded.tasks.length, 2);
    assert.equal(loaded.peers.length, 1);
    assert.equal(loaded.audit.length, 2);
    const waiting = loaded.tasks.find((t) => t.id === t1.id);
    assert.equal(waiting.state, 'input-required');
    assert.equal(waiting.history.length, 3);
    assert.equal(loaded.peers[0].status, 'allowlisted');

    // Audit chain still verifies after a JSON round-trip.
    const audit2 = V11AuditLog.fromJson(JSON.stringify(loaded.audit));
    assert.equal(audit2.verifyChain().ok, true);

    const summary = summarizeV11PersistedState(loaded);
    assert.equal(summary.tasks, 2);
    assert.equal(summary.activeTasks, 1);
    assert.equal(summary.awaitingInput, 1);
    assert.equal(summary.allowlistedPeers, 1);
    assert.equal(summary.auditEntries, 2);
    assert.match(describeV11PersistedState(loaded), /2 task\(s\)/);
    assert.match(describeV11PersistedState(loaded), /1 peer\(s\)/);

    // Restore the store: states + history survive.
    const restored = restoreV11TaskStore(loaded.tasks);
    assert.equal(restored.count(), 2);
    assert.equal(restored.get(t1.id).state, 'input-required');
    assert.equal(restored.get(t2.id).state, 'completed');
  } finally {
    cleanup(dir);
  }
});

test('v11 persist: missing dir loads empty; corrupt file is a problem, not a crash', () => {
  const dir = tmpDir();
  try {
    const empty = loadV11State(dir);
    assert.deepEqual(empty.tasks, []);
    assert.deepEqual(empty.peers, []);
    assert.deepEqual(empty.audit, []);
    assert.deepEqual(empty.problems, []);

    writeFileSync(join(dir, V11_TASKS_FILE_NAME), '{not json', 'utf8');
    writeFileSync(join(dir, V11_PEERS_FILE_NAME), '[{"id": 1}]', 'utf8');
    writeFileSync(join(dir, V11_AUDIT_FILE_NAME), '[]', 'utf8');
    const loaded = loadV11State(dir);
    assert.equal(loaded.tasks.length, 0);
    assert.equal(loaded.peers.length, 0);
    assert.equal(loaded.problems.length, 2);
    assert.ok(loaded.problems.some((p) => p.file === V11_TASKS_FILE_NAME));
    assert.ok(loaded.problems.some((p) => p.file === V11_PEERS_FILE_NAME));
  } finally {
    cleanup(dir);
  }
});

test('v11 persist: secret-shaped values are refused, shape checks work', () => {
  assert.equal(v11TextHasSecret('hello'), false);
  assert.equal(v11TextHasSecret('sk-abcdefghij1234567890'), true);
  assert.equal(v11TextHasSecret('-----BEGIN PRIVATE KEY-----'), true);
  assert.equal(
    isV11TaskShape({ id: 't1', contextId: 'c1', state: 'working', createdAt: 'x', updatedAt: 'y' }),
    true,
  );
  assert.equal(isV11TaskShape({ id: 't1' }), false);
  assert.equal(isV11TaskShape(null), false);
  assert.equal(
    isV11PeerRecordShape({ id: 'p1', card: { name: 'x' }, status: 'registered', trustScore: 50 }),
    true,
  );
  assert.equal(isV11PeerRecordShape({ id: 'p1', card: null, status: 'registered', trustScore: 50 }), false);

  // A secret written into an audit detail is redacted at append time,
  // so it can never reach the persisted file in the first place.
  const audit = new V11AuditLog();
  audit.append('card.verified', 'leaked sk-abcdefghij1234567890 by accident');
  assert.equal(v11TextHasSecret(JSON.stringify(audit.all())), false); // redacted at append
  assert.ok(!JSON.stringify(audit.all()).includes('sk-abcdefghij'));
});

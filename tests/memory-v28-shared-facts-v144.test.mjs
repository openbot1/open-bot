/**
 * Tests for memory v28 — shared blocks (ACL) + bi-temporal facts
 * (v1.44, Doi T1).
 * packages/core/src/memory/v28/sharedBlocks.ts
 * packages/core/src/memory/v28/invalidation.ts
 *
 * Run after building core:
 *   node node_modules/typescript/bin/tsc -p packages/core/tsconfig.json --incremental
 *   node --test tests/memory-v28-shared-facts-v144.test.mjs
 * No network. No model. Uses temp dirs under os.tmpdir().
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  V28FactStore,
  V28GitBlockStore,
  V28SharedBlockRegistry,
} from '../packages/core/dist/memory/v28/index.js';

function tmpDir() {
  return mkdtempSync(join(tmpdir(), 'openbot-v28-shared-'));
}

function cleanup(dir) {
  rmSync(dir, { recursive: true, force: true });
}

function makeRegistry(dir) {
  const gitStore = new V28GitBlockStore({ rootDir: dir });
  gitStore.init();
  const registry = new V28SharedBlockRegistry({ gitStore });
  return { gitStore, registry };
}

function makeFactStore(dir) {
  const gitStore = new V28GitBlockStore({ rootDir: dir });
  gitStore.init();
  return new V28FactStore({ gitStore });
}

// ---------------------------------------------------------------- shared blocks

test('v28 shared: tao block + owner admin + bot khac khong thay block', () => {
  const dir = tmpDir();
  try {
    const { registry } = makeRegistry(dir);
    const created = registry.createSharedBlock('team-notes', 'shared content', 'bot-a', { actor: 'user' });
    assert.equal(created.ok, true);
    assert.equal(created.value.ownerBotId, 'bot-a');
    assert.deepEqual(created.value.attachedBots, ['bot-a']);
    assert.equal(registry.roleOf('team-notes', 'bot-a'), 'admin');
    assert.equal(registry.roleOf('team-notes', 'bot-b'), 'none');
    // Bot khong co quyen thi doc that bai (loi chung chung, khong tiet lo).
    const denied = registry.readForBot('team-notes', 'bot-b');
    assert.equal(denied.ok, false);
    // Bot khong co quyen thi khong thay block trong list.
    assert.deepEqual(registry.listForBot('bot-b'), []);
    assert.equal(registry.listForBot('bot-a').length, 1);
    assert.equal(registry.listForBot('bot-a')[0].role, 'admin');
  } finally {
    cleanup(dir);
  }
});

test('v28 shared: grant/revoke/attach/detach + audit log day du', () => {
  const dir = tmpDir();
  try {
    const { registry } = makeRegistry(dir);
    registry.createSharedBlock('team-notes', 'v1', 'bot-a', { actor: 'user' });

    // Bot thuong khong cap quyen duoc.
    const noPerm = registry.grantRole('team-notes', 'bot-c', 'read', 'bot-b');
    assert.equal(noPerm.ok, false);

    const granted = registry.grantRole('team-notes', 'bot-b', 'read', 'bot-a');
    assert.equal(granted.ok, true);
    assert.equal(granted.value.role, 'read');
    assert.equal(registry.roleOf('team-notes', 'bot-b'), 'read');
    assert.equal(registry.readForBot('team-notes', 'bot-b').ok, true);

    // Read khong ghi duoc.
    const writeDenied = registry.writeForBot('team-notes', 'bot-b', 'try write');
    assert.equal(writeDenied.ok, false);
    assert.match(writeDenied.error, /khong co quyen ghi/);

    // Nang len write thi ghi duoc (1 commit moi).
    registry.grantRole('team-notes', 'bot-b', 'write', 'bot-a');
    const written = registry.writeForBot('team-notes', 'bot-b', 'v2 by bot-b');
    assert.equal(written.ok, true);
    assert.equal(written.value.version, 2);
    assert.equal(registry.readForBot('team-notes', 'bot-a').value.content, 'v2 by bot-b');

    // Chi owner moi cap admin.
    registry.grantRole('team-notes', 'bot-c', 'admin', 'bot-a');
    assert.equal(registry.roleOf('team-notes', 'bot-c'), 'admin');
    const adminByNonOwner = registry.grantRole('team-notes', 'bot-d', 'admin', 'bot-b');
    assert.equal(adminByNonOwner.ok, false);

    // Thu quyen + detach.
    const revoked = registry.revokeRole('team-notes', 'bot-b', 'bot-a');
    assert.equal(revoked.ok, true);
    assert.equal(registry.roleOf('team-notes', 'bot-b'), 'none');
    const attach = registry.attachBot('team-notes', 'bot-b', 'bot-a');
    assert.equal(attach.ok, true);
    assert.equal(registry.roleOf('team-notes', 'bot-b'), 'read');
    const detached = registry.detachBot('team-notes', 'bot-b', 'bot-a');
    assert.equal(detached.ok, true);
    assert.equal(registry.roleOf('team-notes', 'bot-b'), 'none');

    // Khong thu quyen owner duoc.
    const revokeOwner = registry.revokeRole('team-notes', 'bot-a', 'bot-a');
    assert.equal(revokeOwner.ok, false);

    // Audit ghi du moi hanh dong.
    const audit = registry.auditFor('team-notes', 100);
    const actions = audit.map((e) => e.action);
    for (const expected of ['create', 'grant', 'write', 'revoke', 'attach', 'detach']) {
      assert.ok(actions.includes(expected), `audit thieu action ${expected}`);
    }
    assert.ok(audit.length >= 8);
  } finally {
    cleanup(dir);
  }
});

test('v28 shared: ACL ton tai qua reload (doc lai tu disk)', () => {
  const dir = tmpDir();
  try {
    const first = makeRegistry(dir);
    first.registry.createSharedBlock('persisted', 'v1', 'bot-a', { actor: 'user' });
    first.registry.grantRole('persisted', 'bot-b', 'write', 'bot-a');
    const second = makeRegistry(dir);
    assert.equal(second.registry.roleOf('persisted', 'bot-b'), 'write');
    assert.equal(second.registry.readForBot('persisted', 'bot-b').ok, true);
  } finally {
    cleanup(dir);
  }
});

// ---------------------------------------------------------------- facts

test('v28 facts: add + validAt/knownAt theo 2 truc thoi gian', () => {
  const dir = tmpDir();
  try {
    const facts = makeFactStore(dir);
    const added = facts.addFact({
      subject: 'user',
      predicate: 'likes',
      object: 'pho',
      source: 'user',
      botId: 'bot-a',
      validFrom: '2026-01-01T00:00:00.000Z',
    });
    assert.equal(added.ok, true);
    assert.equal(added.value.status, 'active');
    assert.equal(added.value.validTo, null);
    assert.equal(facts.size, 1);

    // Truoc validFrom: fact chua dung.
    assert.equal(facts.validAt('2025-12-31T00:00:00.000Z').value.length, 0);
    // Sau validFrom: fact dung.
    assert.equal(facts.validAt('2026-06-01T00:00:00.000Z').value.length, 1);
    // Truoc khi he thong biet (createdAt ~ bay gio): knownAt qua khu = 0.
    assert.equal(facts.knownAt('2025-06-01T00:00:00.000Z').value.length, 0);
    // Bay gio: ca 2 truc deu thay.
    assert.equal(facts.validAndKnownAt(new Date().toISOString()).value.length, 1);
  } finally {
    cleanup(dir);
  }
});

test('v28 facts: invalidate giu lai fact + dong cua so hieu luc (khong xoa)', () => {
  const dir = tmpDir();
  try {
    const facts = makeFactStore(dir);
    const added = facts.addFact({ subject: 'user', predicate: 'lives-in', object: 'Hanoi', botId: 'bot-a' });
    const id = added.value.id;
    const invalidated = facts.invalidateFact(id, { reason: 'outdated', by: 'user' });
    assert.equal(invalidated.ok, true);
    assert.equal(invalidated.value.status, 'invalidated');
    assert.equal(invalidated.value.invalidateReason, 'outdated');
    assert.ok(invalidated.value.validTo);
    assert.ok(invalidated.value.invalidatedAt);
    // Fact van con trong store — chi khong active nua.
    assert.equal(facts.size, 1);
    assert.equal(facts.activeCount, 0);
    assert.equal(facts.invalidatedCount, 1);
    assert.equal(facts.get(id).status, 'invalidated');
    // Vo hieu lai thi loi.
    assert.equal(facts.invalidateFact(id, { reason: 'outdated', by: 'user' }).ok, false);
    // Lich su co 2 snapshot: add + invalidate.
    assert.equal(facts.history(id).length, 2);
  } finally {
    cleanup(dir);
  }
});

test('v28 facts: supersede — fact moi them, fact cu dong + tro supersededBy', () => {
  const dir = tmpDir();
  try {
    const facts = makeFactStore(dir);
    const old = facts.addFact({ subject: 'user', predicate: 'likes', object: 'tea', botId: 'bot-a' });
    const result = facts.supersedeFact(
      old.value.id,
      { subject: 'user', predicate: 'likes', object: 'coffee', source: 'sleep-agent', botId: 'bot-a' },
      { by: 'sleep-agent' },
    );
    assert.equal(result.ok, true);
    assert.equal(result.value.oldFact.status, 'superseded');
    assert.equal(result.value.oldFact.supersededBy, result.value.newFact.id);
    assert.equal(result.value.newFact.object, 'coffee');
    assert.equal(facts.activeCount, 1);
    assert.equal(facts.supersededCount, 1);
    // Fact active hien tai la coffee.
    const current = facts.factsForSubjectPredicate('user', 'likes').filter((f) => f.status === 'active');
    assert.equal(current.length, 1);
    assert.equal(current[0].object, 'coffee');
  } finally {
    cleanup(dir);
  }
});

test('v28 facts: search + dedupe tim trung + import khong ghi de', () => {
  const dir = tmpDir();
  try {
    const facts = makeFactStore(dir);
    facts.addFact({ subject: 'user', predicate: 'likes', object: 'pho bo', botId: 'bot-a' });
    facts.addFact({ subject: 'user', predicate: 'likes', object: 'com tam', botId: 'bot-a' });
    facts.addFact({ subject: 'user', predicate: 'speaks', object: 'Vietnamese', botId: 'bot-a' });

    const hits = facts.searchFacts('pho bo');
    assert.ok(hits.length >= 1);
    assert.equal(hits[0].fact.object, 'pho bo');
    assert.ok(hits[0].score > 0);

    const dups = facts.findDuplicates('user likes pho bo', 0.72);
    assert.equal(dups.length, 1);

    const exported = facts.exportFacts();
    const imported = facts.importFacts(exported);
    assert.equal(imported.imported, 0);
    assert.equal(imported.skipped, 3);
    assert.equal(facts.size, 3);

    // Reload tu disk khoi phuc du fact.
    const reloaded = makeFactStore(dir);
    assert.equal(reloaded.size, 3);
    assert.equal(reloaded.activeCount, 3);
  } finally {
    cleanup(dir);
  }
});

test('v28 facts: validate dau vao — rong / confidence sai / validFrom sai', () => {
  const dir = tmpDir();
  try {
    const facts = makeFactStore(dir);
    assert.equal(facts.addFact({ subject: '', predicate: 'likes', object: 'x' }).ok, false);
    assert.equal(facts.addFact({ subject: 'user', predicate: 'likes', object: 'x', confidence: 2 }).ok, false);
    assert.equal(
      facts.addFact({ subject: 'user', predicate: 'likes', object: 'x', validFrom: 'not-a-date' }).ok,
      false,
    );
    assert.equal(facts.size, 0);
  } finally {
    cleanup(dir);
  }
});

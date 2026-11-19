/**
 * Tests for memory v28 — migration + bundle + integrity
 * (v1.44, Doi T1).
 * packages/core/src/memory/v28/migration.ts
 * packages/core/src/memory/v28/exportImport.ts
 * packages/core/src/memory/v28/integrity.ts
 *
 * Run after building core:
 *   node node_modules/typescript/bin/tsc -p packages/core/tsconfig.json --incremental
 *   node --test tests/memory-v28-migration-bundle-v144.test.mjs
 * No network. No model. Uses temp dirs under os.tmpdir().
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  V28Store,
  exportV28Bundle,
  importV28Bundle,
  migrateMemFsDirToV28,
  migrateV27SnapshotToV28,
  parseMemFsFactSections,
  verifyV28Bundle,
  verifyV28Integrity,
} from '../packages/core/dist/memory/v28/index.js';

function tmpDir() {
  return mkdtempSync(join(tmpdir(), 'openbot-v28-mig-'));
}

function cleanup(dir) {
  rmSync(dir, { recursive: true, force: true });
}

function makeStore(dir) {
  return new V28Store({ rootDir: dir, botId: 'bot-a' });
}

// ---------------------------------------------------------------- migration

test('v28 migration: v27 snapshot — fact + shared block, fact da dong thi vo hieu ngay', () => {
  const dir = tmpDir();
  try {
    const store = makeStore(dir);
    const snapshot = {
      facts: [
        { subject: 'user', predicate: 'likes', object: 'pho', text: 'user likes pho', confidence: 0.9, validFrom: '2026-01-01T00:00:00.000Z' },
        { subject: 'user', predicate: 'lives-in', object: 'Hanoi', text: 'user lives in Hanoi', validFrom: '2026-01-01T00:00:00.000Z', invalid_at: '2026-06-01T00:00:00.000Z' },
        { subject: '', predicate: 'likes', object: 'x' },
      ],
      sharedBlocks: [
        { label: 'team-notes', content: 'shared content v27' },
      ],
    };
    const result = migrateV27SnapshotToV28(snapshot, store, { actor: 'system' });
    assert.equal(result.ok, true);
    assert.equal(result.value.factsImported, 2);
    assert.equal(result.value.factsSkipped, 1);
    assert.equal(result.value.blocksImported, 1);
    assert.equal(store.facts.size, 2);
    // Fact Hanoi da dong o v27 -> nhap roi vo hieu ngay.
    const hanoi = store.facts.searchFacts('lives in Hanoi', { includeInactive: true });
    assert.equal(hanoi.length, 1);
    assert.equal(hanoi[0].fact.status, 'invalidated');
    // Fact pho van active.
    assert.equal(store.facts.activeCount, 1);
    assert.equal(store.gitStore.readBlock('team-notes').content, 'shared content v27');
  } finally {
    cleanup(dir);
  }
});

test('v28 migration: v27 snapshot dry-run khong ghi gi + snapshot sai dang thi loi', () => {
  const dir = tmpDir();
  try {
    const store = makeStore(dir);
    const snapshot = { facts: [{ subject: 'user', predicate: 'likes', object: 'tea' }] };
    const dry = migrateV27SnapshotToV28(snapshot, store, { dryRun: true });
    assert.equal(dry.ok, true);
    assert.equal(dry.value.factsImported, 1);
    assert.equal(store.facts.size, 0);
    assert.equal(migrateV27SnapshotToV28(null, store).ok, false);
    assert.equal(migrateV27SnapshotToV28('not-an-object', store).ok, false);
  } finally {
    cleanup(dir);
  }
});

test('v28 migration: MemFS-lite dir — block md + longterm-facts.md', () => {
  const dir = tmpDir();
  try {
    const store = makeStore(dir);
    const memFsDir = join(dir, 'memfs-old');
    mkdirSync(join(memFsDir, 'memory-blocks'), { recursive: true });
    writeFileSync(
      join(memFsDir, 'memory-blocks', 'human.md'),
      '---\nlabel: "human"\ndescription: "Su that ve user"\n---\nUser likes pho.\n',
      'utf8',
    );
    writeFileSync(
      join(memFsDir, 'longterm-facts.md'),
      '## pho\nUser likes pho bo, eats it on Sundays.\n\n## hanoi\nUser lived in Hanoi before 2024.\n',
      'utf8',
    );
    const result = migrateMemFsDirToV28(memFsDir, store, { actor: 'system' });
    assert.equal(result.ok, true);
    assert.equal(result.value.blocksImported, 1);
    assert.equal(result.value.factsImported, 2);
    assert.equal(store.gitStore.readBlock('human').content, 'User likes pho.');
    assert.equal(store.facts.size, 2);
    // Chay lai: block trung noi dung + fact trung thi bo qua (khong nhan doi).
    const second = migrateMemFsDirToV28(memFsDir, store, { actor: 'system' });
    assert.equal(second.value.blocksImported, 0);
    assert.equal(second.value.blocksSkipped, 1);
    // Fact van them (khong dedupe theo noi dung o tang migration — ghi nhan).
    assert.equal(store.facts.size, 4);
    assert.equal(migrateMemFsDirToV28(join(dir, 'no-such-dir'), store).ok, false);
  } finally {
    cleanup(dir);
  }
});

test('v28 migration: parseMemFsFactSections tach dung section ## key', () => {
  const sections = parseMemFsFactSections('## a\nbody a\nline 2\n\n## b\nbody b\n');
  assert.equal(sections.length, 2);
  assert.equal(sections[0].key, 'a');
  assert.match(sections[0].body, /body a/);
  assert.match(sections[0].body, /line 2/);
  assert.equal(sections[1].key, 'b');
  assert.equal(parseMemFsFactSections('khong co heading nao').length, 0);
});

// ------------------------------------------------------------------- bundle

test('v28 bundle: export -> verify -> import sang store moi (tron ven)', () => {
  const dir = tmpDir();
  try {
    const source = makeStore(join(dir, 'source'));
    source.gitStore.writeBlock('notes', 'bundle content', { actor: 'user' });
    source.facts.addFact({ subject: 'user', predicate: 'likes', object: 'pho', botId: 'bot-a' });
    source.shared.createSharedBlock('team', 'team content', 'bot-a', { actor: 'user' });
    source.shared.grantRole('team', 'bot-b', 'read', 'bot-a');

    const bundleDir = join(dir, 'bundle');
    const exported = exportV28Bundle(source, bundleDir);
    assert.equal(exported.ok, true);
    assert.equal(exported.value.manifest.blocks, 2);
    assert.equal(exported.value.manifest.facts, 1);
    assert.equal(exported.value.manifest.aclEntries, 1);
    assert.equal(existsSync(join(bundleDir, 'manifest.json')), true);
    assert.equal(existsSync(join(bundleDir, 'blocks', 'notes.md')), true);

    assert.equal(verifyV28Bundle(bundleDir).ok, true);

    const target = makeStore(join(dir, 'target'));
    const imported = importV28Bundle(target, bundleDir, { actor: 'system' });
    assert.equal(imported.ok, true);
    assert.equal(imported.value.blocksImported, 2);
    assert.equal(imported.value.factsImported, 1);
    assert.equal(imported.value.aclReplaced, true);
    assert.equal(target.gitStore.readBlock('notes').content, 'bundle content');
    assert.equal(target.facts.size, 1);
    assert.equal(target.shared.roleOf('team', 'bot-b'), 'read');

    // Import lai: tat ca deu trung -> skipped, khong nhan doi.
    const again = importV28Bundle(target, bundleDir, { actor: 'system' });
    assert.equal(again.ok, true);
    assert.equal(again.value.blocksImported, 0);
    assert.equal(again.value.factsImported, 0);
    assert.equal(target.facts.size, 1);
  } finally {
    cleanup(dir);
  }
});

test('v28 bundle: file lech hash thi bo qua file do, file khac van nhap', () => {
  const dir = tmpDir();
  try {
    const source = makeStore(join(dir, 'source'));
    source.gitStore.writeBlock('good', 'good content', { actor: 'user' });
    source.gitStore.writeBlock('bad', 'bad content', { actor: 'user' });
    const bundleDir = join(dir, 'bundle');
    exportV28Bundle(source, bundleDir);
    // Sua tay 1 file sau khi export -> lech hash manifest.
    writeFileSync(join(bundleDir, 'blocks', 'bad.md'), '---\nlabel: "bad"\n---\ntampered\n', 'utf8');
    assert.equal(verifyV28Bundle(bundleDir).ok, false);
    assert.match(verifyV28Bundle(bundleDir).errors.join(' '), /bad\.md/);

    const target = makeStore(join(dir, 'target'));
    const imported = importV28Bundle(target, bundleDir, { actor: 'system' });
    assert.equal(imported.ok, true);
    assert.equal(imported.value.blocksImported, 1);
    assert.equal(imported.value.blocksSkipped, 1);
    assert.ok(imported.value.errors.some((e) => e.includes('bad.md')));
    assert.equal(target.gitStore.readBlock('good').content, 'good content');
    assert.equal(target.gitStore.readBlock('bad'), null);
  } finally {
    cleanup(dir);
  }
});

test('v28 bundle: bundle sai version / thieu manifest thi loi', () => {
  const dir = tmpDir();
  try {
    const store = makeStore(dir);
    assert.equal(importV28Bundle(store, join(dir, 'no-such-bundle')).ok, false);
    const badDir = join(dir, 'bad-bundle');
    mkdirSync(badDir, { recursive: true });
    writeFileSync(join(badDir, 'manifest.json'), JSON.stringify({ version: '1.0.0' }), 'utf8');
    const result = importV28Bundle(store, badDir);
    assert.equal(result.ok, false);
    assert.match(result.error, /version/);
  } finally {
    cleanup(dir);
  }
});

// ---------------------------------------------------------------- integrity

test('v28 integrity: store moi + sau ghi thi PASS het', () => {
  const dir = tmpDir();
  try {
    const store = makeStore(dir);
    let report = verifyV28Integrity(store);
    assert.equal(report.ok, true);
    assert.ok(report.checks.length >= 6);

    store.gitStore.writeBlock('notes', 'content', { actor: 'user' });
    store.facts.addFact({ subject: 'user', predicate: 'likes', object: 'pho', botId: 'bot-a' });
    store.shared.createSharedBlock('team', 'team content', 'bot-a', { actor: 'user' });
    store.shared.grantRole('team', 'bot-b', 'read', 'bot-a');
    report = verifyV28Integrity(store);
    assert.equal(report.ok, true);
    assert.equal(report.errors.length, 0);
    assert.ok(report.checks.every((c) => c.ok));
  } finally {
    cleanup(dir);
  }
});

test('v28 integrity: file block bi sua tay lech hash thi FAIL blocks-hash', () => {
  const dir = tmpDir();
  try {
    const store = makeStore(dir);
    store.gitStore.writeBlock('notes', 'original', { actor: 'user' });
    // Sua tay file (khong qua git store) — hash trong frontmatter lech.
    const file = join(dir, 'memory-v28', 'blocks', 'notes.md');
    const text = readFileSync(file, 'utf8');
    writeFileSync(file, text.replace('original', 'tampered'), 'utf8');
    const report = verifyV28Integrity(store);
    assert.equal(report.ok, false);
    assert.ok(report.checks.some((c) => c.name === 'blocks-hash' && !c.ok));
  } finally {
    cleanup(dir);
  }
});

test('v28 integrity: ACL tro block khong ton tai thi FAIL acl-targets', () => {
  const dir = tmpDir();
  try {
    const store = makeStore(dir);
    store.shared.createSharedBlock('team', 'v1', 'bot-a', { actor: 'user' });
    store.shared.grantRole('team', 'bot-b', 'read', 'bot-a');
    // Archive block — ACL van tro den label cu.
    store.gitStore.archiveBlock('team', { actor: 'user' });
    const report = verifyV28Integrity(store);
    assert.equal(report.ok, false);
    assert.ok(report.checks.some((c) => c.name === 'acl-targets' && !c.ok));
  } finally {
    cleanup(dir);
  }
});

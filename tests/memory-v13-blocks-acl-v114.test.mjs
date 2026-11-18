/**
 * Tests for v1.14 (Team T1) — memory v13:
 * packages/core/src/memory/v13/{gitBlocks,templates,acl}.ts
 *
 * Covers:
 *  - gitBlocks: snapshot (dedupe when unchanged, force), branch
 *    create/checkout, rollback creates a NEW version (history never
 *    rewritten), diff line counts, merge fast-forward + conflict,
 *    prune keeps heads, invalid branch/version errors.
 *  - templates: 8 templates listed, get by id/kind, instantiate
 *    creates a real block via the store (label/description/content/
 *    charLimit), duplicate label throws, missing sections detection,
 *    health template suggests sensitive ACL.
 *  - acl: default open; set requires user actor; read-only blocks
 *    agent edits; sensitive blocks hidden from prompt filter and
 *    redacted in logs; user can still read/edit everything; summary
 *    counts; clear restores open.
 *
 * Run after building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/memory-v13-blocks-acl-v114.test.mjs
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
  V13BlockGitStore,
  V13BlockGitError,
  v13HashContent,
  v13DiffLines,
  isValidV13BranchName,
  normalizeV13BranchName,
  listBlockTemplates,
  getBlockTemplate,
  findTemplateByKind,
  instantiateBlockTemplate,
  missingTemplateSections,
  V13BlockAclStore,
  V13BlockAclError,
  V13_SENSITIVE_REDACTED,
  filterBlocksForPrompt,
  promptSafeBlocks,
  redactBlockForLog,
  summarizeAcl,
} from '../packages/core/dist/index.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-v13-blocks-'));
}

function makeBlock(ws, label = 'persona', content = 'Dòng một\nDòng hai') {
  const store = new MemoryBlockStore(ws);
  return store.create({ label, description: `Block ${label}`, content });
}

// ---------- gitBlocks: helpers ----------

test('gitBlocks: hash is stable sha256; branch names normalize + validate', () => {
  assert.equal(v13HashContent('abc'), v13HashContent('abc'));
  assert.notEqual(v13HashContent('abc'), v13HashContent('abd'));
  assert.equal(v13HashContent('abc').length, 64);
  assert.equal(normalizeV13BranchName('Exp FunNIer 1'), 'exp-funnier-1');
  assert.equal(isValidV13BranchName('main'), true);
  assert.equal(isValidV13BranchName('exp-1'), true);
  assert.equal(isValidV13BranchName('Bad Name!'), false);
  assert.equal(isValidV13BranchName(''), false);
});

test('gitBlocks: line diff marks added/removed/unchanged lines', () => {
  const diff = v13DiffLines('a\nb\nc', 'a\nx\nc\nd');
  assert.equal(diff.filter((l) => l.type === ' ').length, 2);
  assert.equal(diff.filter((l) => l.type === '-').length, 1);
  assert.equal(diff.filter((l) => l.type === '+').length, 2);
  assert.deepEqual(diff.map((l) => l.type).join(''), ' -+ +');
  const same = v13DiffLines('a\nb', 'a\nb');
  assert.ok(same.every((l) => l.type === ' '));
  assert.equal(same.length, 2);
});

test('gitBlocks: snapshot creates versions, dedupes unchanged content', () => {
  const ws = tmpDir();
  const block = makeBlock(ws);
  const git = new V13BlockGitStore(ws);
  const first = git.snapshot(block, { message: 'ban dau', actor: 'user' });
  assert.equal(first.created, true);
  assert.equal(first.version.branch, 'main');
  assert.equal(first.version.message, 'ban dau');
  assert.equal(first.version.contentHash, v13HashContent(block.content));
  assert.equal(first.version.parentId, null);

  // Same content again -> no new version.
  const again = git.snapshot(block);
  assert.equal(again.created, false);
  assert.equal(again.version.id, first.version.id);

  // Forced snapshot still creates one.
  const forced = git.snapshot(block, { force: true });
  assert.equal(forced.created, true);
  assert.equal(forced.version.parentId, first.version.id);
  assert.equal(git.listVersions(block.id).length, 2);

  const head = git.headOf(block.id);
  assert.equal(head.id, forced.version.id);
  const stats = git.stats(block.id);
  assert.equal(stats.versions, 2);
  assert.equal(stats.branches, 1);
  assert.equal(stats.latestBranch, 'main');
});

test('gitBlocks: snapshot after store edit chains parent + bumps version', () => {
  const ws = tmpDir();
  const store = new MemoryBlockStore(ws);
  const block = store.create({ label: 'human', description: 'd', content: 'v1' });
  const git = new V13BlockGitStore(ws);
  const s1 = git.snapshot(block);
  const updated = store.replace(block.id, 'v2', 'user');
  assert.equal(updated.version, block.version + 1);
  const s2 = git.snapshot(updated);
  assert.equal(s2.version.parentId, s1.version.id);
  assert.equal(s2.version.version, updated.version);
  assert.equal(git.listVersions(block.id).length, 2);
});

test('gitBlocks: branch create + snapshot on branch keeps main untouched', () => {
  const ws = tmpDir();
  const store = new MemoryBlockStore(ws);
  const block = store.create({ label: 'persona', description: 'd', content: 'goc' });
  const git = new V13BlockGitStore(ws);
  git.snapshot(block, { message: 'goc' });
  const branch = git.createBranch(block.id, 'exp-funnier', { actor: 'user' });
  assert.equal(branch.name, 'exp-funnier');
  assert.equal(branch.blockId, block.id);

  const edited = store.replace(block.id, 'hai huoc hon', 'user');
  const onBranch = git.snapshot(edited, { branch: 'exp-funnier', message: 'thu nghiem' });
  assert.equal(onBranch.version.branch, 'exp-funnier');

  const mainHead = git.headOf(block.id, 'main');
  assert.equal(mainHead.content, 'goc');
  const branchHead = git.headOf(block.id, 'exp-funnier');
  assert.equal(branchHead.content, 'hai huoc hon');
  assert.equal(git.listBranches(block.id).length, 2);
  assert.equal(git.listVersions(block.id, 'main').length, 1);
  assert.equal(git.listVersions(block.id, 'exp-funnier').length, 1);

  // Duplicate branch name throws.
  assert.throws(
    () => git.createBranch(block.id, 'exp-funnier'),
    (e) => e instanceof V13BlockGitError && /da co nhanh/.test(e.message),
  );
  // Bad branch name throws (normalizes to empty).
  assert.throws(() => git.createBranch(block.id, '!!!'), V13BlockGitError);
  // Branch from a missing version throws.
  assert.throws(
    () => git.createBranch(block.id, 'other', { fromVersionId: 'nope' }),
    V13BlockGitError,
  );
});

test('gitBlocks: checkout + rollback restore old content as NEW versions', () => {
  const ws = tmpDir();
  const store = new MemoryBlockStore(ws);
  const block = store.create({ label: 'persona', description: 'd', content: 'v1' });
  const git = new V13BlockGitStore(ws);
  const s1 = git.snapshot(block);
  const v2 = store.replace(block.id, 'v2', 'user');
  git.snapshot(v2);
  const v3 = store.replace(block.id, 'v3', 'user');
  git.snapshot(v3);

  // Rollback to v1: content back, but version keeps growing.
  const rolled = git.rollback(store, block.id, s1.version.id, { actor: 'user' });
  assert.equal(rolled.block.content, 'v1');
  assert.equal(rolled.fromVersion.id, s1.version.id);
  assert.ok(rolled.newVersion.version > v3.version);
  assert.equal(rolled.block.version, rolled.newVersion.version);

  // History still has all versions — nothing rewritten.
  const all = git.listVersions(block.id);
  assert.ok(all.length >= 4);
  const contents = all.map((v) => v.content);
  assert.ok(contents.includes('v1'));
  assert.ok(contents.includes('v2'));
  assert.ok(contents.includes('v3'));

  // Checkout by branch head works too.
  const byBranch = git.checkout(store, block.id, { branch: 'main' }, { actor: 'user' });
  assert.equal(byBranch.block.content, 'v1');

  // Unknown version throws.
  assert.throws(() => git.rollback(store, block.id, 'missing-id'), V13BlockGitError);
  assert.throws(
    () => git.checkout(store, block.id, { branch: 'no-such-branch' }),
    V13BlockGitError,
  );
});

test('gitBlocks: read-only block checkout is blocked for agents and for user until unlocked', () => {
  const ws = tmpDir();
  const store = new MemoryBlockStore(ws);
  const block = store.create({ label: 'persona', description: 'd', content: 'v1', readOnly: true });
  const git = new V13BlockGitStore(ws);
  const s1 = git.snapshot(block);
  // Agent is blocked by the v13 ACL-style guard (V13BlockGitError).
  assert.throws(
    () => git.checkout(store, block.id, { versionId: s1.version.id }, { actor: 'agent:bot1' }),
    V13BlockGitError,
  );
  // Even the user cannot change read-only content via the store —
  // read-only means read-only until explicitly unlocked.
  assert.throws(
    () => git.checkout(store, block.id, { versionId: s1.version.id }, { actor: 'user' }),
    /read-only/,
  );
  // Unlock, then the user checkout works.
  store.setReadOnly(block.id, false, 'user');
  const ok = git.checkout(store, block.id, { versionId: s1.version.id }, { actor: 'user' });
  assert.equal(ok.block.content, 'v1');
});

test('gitBlocks: diffVersions counts added/removed and spots description change', () => {
  const ws = tmpDir();
  const store = new MemoryBlockStore(ws);
  const block = store.create({ label: 'plan', description: 'cu', content: 'a\nb\nc' });
  const git = new V13BlockGitStore(ws);
  const s1 = git.snapshot(block);
  const v2 = store.update(block.id, { content: 'a\nx\nc\nd', description: 'moi' }, 'user');
  const s2 = git.snapshot(v2);
  const diff = git.diffVersions(s1.version.id, s2.version.id);
  assert.equal(diff.added, 2);
  assert.equal(diff.removed, 1);
  assert.equal(diff.unchanged, 2);
  assert.equal(diff.descriptionChanged, true);
  assert.equal(diff.fromLabel, 'plan v1 (main)');
  assert.equal(diff.toLabel, 'plan v2 (main)');

  // Diff across blocks throws.
  const other = store.create({ label: 'other', description: 'd', content: 'z' });
  const sOther = git.snapshot(other);
  assert.throws(() => git.diffVersions(s1.version.id, sOther.version.id), V13BlockGitError);
  assert.throws(() => git.diffVersions('missing', s2.version.id), V13BlockGitError);
});

test('gitBlocks: merge fast-forward applies source head; divergent merge conflicts', () => {
  const ws = tmpDir();
  const store = new MemoryBlockStore(ws);
  const block = store.create({ label: 'persona', description: 'd', content: 'goc' });
  const git = new V13BlockGitStore(ws);
  git.snapshot(block);
  git.createBranch(block.id, 'exp');
  const edited = store.replace(block.id, 'ban thu nghiem', 'user');
  git.snapshot(edited, { branch: 'exp' });
  // Main still at 'goc'; exp branched from main head -> fast-forward.
  const merged = git.mergeBranch(store, block.id, 'exp', 'main', { actor: 'user' });
  assert.equal(merged.merged, true);
  assert.equal(merged.conflicted, false);
  assert.equal(store.get(block.id).content, 'ban thu nghiem');

  // Merging again: identical content -> no-op.
  const again = git.mergeBranch(store, block.id, 'exp', 'main', { actor: 'user' });
  assert.equal(again.merged, false);
  assert.match(again.detail, /giong nhau/);

  // Divergent: branch both sides from the same base, then edit both.
  const ws2 = tmpDir();
  const store2 = new MemoryBlockStore(ws2);
  const b2 = store2.create({ label: 'persona', description: 'd', content: 'goc' });
  const git2 = new V13BlockGitStore(ws2);
  git2.snapshot(b2);
  git2.createBranch(b2.id, 'a');
  git2.createBranch(b2.id, 'b');
  const ea = store2.replace(b2.id, 'huong a', 'user');
  git2.snapshot(ea, { branch: 'a' });
  const eb = store2.replace(b2.id, 'huong b', 'user');
  git2.snapshot(eb, { branch: 'b' });
  const conflict = git2.mergeBranch(store2, b2.id, 'a', 'b', { actor: 'user' });
  assert.equal(conflict.merged, false);
  assert.equal(conflict.conflicted, true);
  assert.equal(store2.get(b2.id).content, 'huong b');
});

test('gitBlocks: prune drops oldest non-head versions only', () => {
  const ws = tmpDir();
  const store = new MemoryBlockStore(ws);
  const block = store.create({ label: 'log', description: 'd', content: 'v0' });
  const git = new V13BlockGitStore(ws);
  for (let i = 0; i < 6; i++) {
    const updated = store.replace(block.id, `v${i}`, 'user');
    git.snapshot(updated, { force: true });
  }
  assert.equal(git.listVersions(block.id).length, 6);
  const dropped = git.prune(block.id, 3);
  assert.equal(dropped, 3);
  assert.equal(git.listVersions(block.id).length, 3);
  // Head survives pruning.
  const head = git.headOf(block.id);
  assert.equal(head.content, 'v5');
  // Nothing to prune below the limit.
  assert.equal(git.prune(block.id, 10), 0);
});

// ---------- templates ----------

test('templates: 8 templates, lookup by id and kind', () => {
  const all = listBlockTemplates();
  assert.equal(all.length, 8);
  const ids = all.map((t) => t.id);
  for (const expected of ['coding', 'research', 'daily', 'planning', 'project', 'learning', 'health', 'travel']) {
    assert.ok(ids.includes(expected), `missing template ${expected}`);
  }
  for (const t of all) {
    assert.ok(t.label.length > 0);
    assert.ok(t.description.length > 0);
    assert.ok(t.charLimit >= 100);
    assert.ok(t.sections.length >= 3);
    assert.ok(t.defaultContent.includes('# '));
    for (const section of t.sections) {
      assert.ok(t.defaultContent.includes(`## ${section}`), `${t.id} missing section ${section}`);
    }
  }
  assert.equal(getBlockTemplate('coding').kind, 'coding');
  assert.equal(getBlockTemplate('CODING').id, 'coding');
  assert.equal(getBlockTemplate('nope'), null);
  assert.equal(findTemplateByKind('research').id, 'research');
  assert.equal(findTemplateByKind('unknown-kind'), null);
  assert.equal(getBlockTemplate('health').suggestedAcl, 'sensitive');
  assert.equal(getBlockTemplate('coding').suggestedAcl, 'open');
});

test('templates: instantiate creates a real store block from the template', () => {
  const ws = tmpDir();
  const store = new MemoryBlockStore(ws);
  const block = instantiateBlockTemplate(store, 'coding', { actor: 'user' });
  assert.equal(block.label, 'coding-notes');
  assert.equal(block.version, 1);
  assert.equal(block.content, getBlockTemplate('coding').defaultContent);
  assert.equal(block.charLimit, 4000);
  assert.equal(store.get(block.id).label, 'coding-notes');

  // Custom label + attach to a bot.
  const planned = instantiateBlockTemplate(store, 'planning', {
    label: 'ke-hoach-tet',
    actor: 'user',
    attachBotId: 'bot1',
  });
  assert.equal(planned.label, 'ke-hoach-tet');
  assert.ok(store.listAttached('bot1').some((b) => b.id === planned.id));

  // Duplicate label throws (store rule, not overwritten).
  assert.throws(() => instantiateBlockTemplate(store, 'coding', { actor: 'user' }), /Đã có memory block/);
  // Unknown template throws.
  assert.throws(() => instantiateBlockTemplate(store, 'nope'), /Khong co block template/);
});

test('templates: instantiate applies suggested ACL through the acl store', () => {
  const ws = tmpDir();
  const store = new MemoryBlockStore(ws);
  const acl = new V13BlockAclStore(ws);
  const block = instantiateBlockTemplate(store, 'health', { actor: 'user', aclStore: acl });
  assert.equal(acl.get(block.id), 'sensitive');
  const open = instantiateBlockTemplate(store, 'daily', { actor: 'user', aclStore: acl });
  assert.equal(acl.get(open.id), 'open');
});

test('templates: missingTemplateSections reports removed sections', () => {
  const ws = tmpDir();
  const store = new MemoryBlockStore(ws);
  const block = instantiateBlockTemplate(store, 'research', { actor: 'user' });
  assert.deepEqual(missingTemplateSections(block, 'research'), []);
  const edited = store.replace(block.id, '# Research notes\n\n## Cau hoi dang tra loi\n- x\n', 'user');
  const missing = missingTemplateSections(edited, 'research');
  assert.ok(missing.includes('Nguon'));
  assert.ok(missing.includes('Ket luan tam thoi'));
  assert.ok(!missing.includes('Cau hoi dang tra loi'));
  assert.deepEqual(missingTemplateSections(edited, 'unknown-template'), []);
});

// ---------- acl ----------

test('acl: default open; set/get/list round-trip; only user may change ACL', () => {
  const ws = tmpDir();
  const block = makeBlock(ws, 'notes', 'bi mat');
  const acl = new V13BlockAclStore(ws);
  assert.equal(acl.get(block.id), 'open');
  assert.equal(acl.getRecord(block.id), null);

  const rec = acl.set(block.id, 'sensitive', 'user', { label: 'notes', reason: 'suc khoe' });
  assert.equal(rec.level, 'sensitive');
  assert.equal(rec.updatedBy, 'user');
  assert.equal(rec.reason, 'suc khoe');
  assert.equal(acl.get(block.id), 'sensitive');
  assert.equal(acl.list().length, 1);

  assert.throws(
    () => acl.set(block.id, 'open', 'agent:bot1'),
    (e) => e instanceof V13BlockAclError && /Chi user/.test(e.message),
  );
  assert.throws(() => acl.set(block.id, 'bogus', 'user'), V13BlockAclError);
  assert.throws(() => acl.clear(block.id, 'agent:bot1'), V13BlockAclError);

  assert.equal(acl.clear(block.id, 'user'), true);
  assert.equal(acl.get(block.id), 'open');
  assert.equal(acl.clear(block.id, 'user'), false);
});

test('acl: read-only blocks agent edits; user edits pass', () => {
  const ws = tmpDir();
  const block = makeBlock(ws, 'rules', 'quy tac');
  const acl = new V13BlockAclStore(ws);
  acl.set(block.id, 'read-only', 'user');
  assert.equal(acl.canEdit(block, 'agent:bot1'), false);
  assert.equal(acl.canEdit(block, 'user'), true);
  assert.equal(acl.canRead(block, 'agent:bot1'), true);
  assert.throws(() => acl.assertCanEdit(block, 'agent:bot1'), V13BlockAclError);
  acl.assertCanEdit(block, 'user');
  acl.assertCanRead(block, 'agent:bot1');
});

test('acl: sensitive blocks agent reads; filter keeps them out of prompts', () => {
  const ws = tmpDir();
  const store = new MemoryBlockStore(ws);
  const openBlock = store.create({ label: 'persona', description: 'd', content: 'vui ve' });
  const secret = store.create({ label: 'health-notes', description: 'd', content: 'huyet ap cao' });
  const acl = new V13BlockAclStore(ws);
  acl.set(secret.id, 'sensitive', 'user', { label: secret.label });

  assert.equal(acl.canRead(secret, 'agent:bot1'), false);
  assert.equal(acl.canRead(secret, 'user'), true);
  assert.equal(acl.canEdit(secret, 'agent:bot1'), false);
  assert.throws(() => acl.assertCanRead(secret, 'agent:bot1'), V13BlockAclError);

  const blocks = store.list();
  const filtered = filterBlocksForPrompt(blocks, acl);
  assert.equal(filtered.visible.length, 1);
  assert.equal(filtered.visible[0].label, 'persona');
  assert.equal(filtered.hidden.length, 1);
  assert.equal(filtered.hidden[0].label, 'health-notes');
  assert.equal(filtered.hidden[0].level, 'sensitive');
  assert.deepEqual(
    promptSafeBlocks(blocks, acl).map((b) => b.label),
    ['persona'],
  );

  // Sensitive content never leaks through the log redactor.
  const redacted = redactBlockForLog(secret, acl);
  assert.equal(redacted.content, V13_SENSITIVE_REDACTED);
  assert.equal(redacted.description, V13_SENSITIVE_REDACTED);
  assert.equal(redacted.label, 'health-notes');
  const kept = redactBlockForLog(openBlock, acl);
  assert.equal(kept.content, 'vui ve');
});

test('acl: summarizeAcl counts levels across blocks', () => {
  const ws = tmpDir();
  const store = new MemoryBlockStore(ws);
  const a = store.create({ label: 'a', description: 'd', content: '1' });
  const b = store.create({ label: 'b', description: 'd', content: '2' });
  const c = store.create({ label: 'c', description: 'd', content: '3' });
  const acl = new V13BlockAclStore(ws);
  acl.set(b.id, 'read-only', 'user');
  acl.set(c.id, 'sensitive', 'user');
  assert.deepEqual(summarizeAcl(store.list(), acl), {
    open: 1,
    readOnly: 1,
    sensitive: 1,
    total: 3,
  });
  void a;
});

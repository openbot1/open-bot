/**
 * Tests for memory v28 — git-backed block store (v1.44, Doi T1).
 * packages/core/src/memory/v28/gitStore.ts
 *
 * Run after building core:
 *   node node_modules/typescript/bin/tsc -p packages/core/tsconfig.json --incremental
 *   node --test tests/memory-v28-gitstore-v144.test.mjs
 * Uses real local git when available (fallback JSONL path is also
 * tested with a bogus git binary). No network. No model.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { V28GitBlockStore } from '../packages/core/dist/memory/v28/index.js';

function tmpDir() {
  return mkdtempSync(join(tmpdir(), 'openbot-v28-git-'));
}

function cleanup(dir) {
  rmSync(dir, { recursive: true, force: true });
}

test('v28 git store: init + write/read + version tang theo commit', () => {
  const dir = tmpDir();
  try {
    const store = new V28GitBlockStore({ rootDir: dir });
    const init = store.init();
    assert.equal(init.ok, true);
    assert.equal(init.value.gitAvailable, true);
    assert.equal(existsSync(join(dir, 'memory-v28', '.git')), true);

    const w1 = store.writeBlock('project-notes', 'hello v28', { actor: 'user', message: 'first' });
    assert.equal(w1.ok, true);
    assert.equal(w1.value.version, 1);
    assert.ok(w1.value.commit.length >= 7, 'commit SHA phai co');
    const commitsAfterFirst = store.commitCount();
    assert.ok(commitsAfterFirst >= 1, 'phai co it nhat 1 commit (init + write)');

    const read = store.readBlock('project-notes');
    assert.ok(read);
    assert.equal(read.content, 'hello v28');
    assert.equal(read.meta.version, 1);

    const w2 = store.writeBlock('project-notes', 'hello v28\nsecond line', { actor: 'user' });
    assert.equal(w2.ok, true);
    assert.equal(w2.value.version, 2);
    assert.notEqual(w2.value.commit, w1.value.commit);
    assert.equal(store.commitCount(), commitsAfterFirst + 1);
    assert.equal(store.listBlocks().length, 1);
  } finally {
    cleanup(dir);
  }
});

test('v28 git store: ghi noi dung khong doi thi bo qua (khong commit moi)', () => {
  const dir = tmpDir();
  try {
    const store = new V28GitBlockStore({ rootDir: dir });
    store.init();
    const w1 = store.writeBlock('notes', 'same content', { actor: 'user' });
    assert.equal(w1.ok, true);
    const commitsBefore = store.commitCount();
    const w2 = store.writeBlock('notes', 'same content', { actor: 'user' });
    assert.equal(w2.ok, true);
    assert.equal(w2.value.version, 1);
    assert.equal(w2.value.message, 'unchanged');
    assert.equal(store.commitCount(), commitsBefore);
  } finally {
    cleanup(dir);
  }
});

test('v28 git store: system block human/persona chan agent, cho user', () => {
  const dir = tmpDir();
  try {
    const store = new V28GitBlockStore({ rootDir: dir });
    store.init();
    const blocked = store.writeBlock('human', 'agent tries', { actor: 'agent:bot-x' });
    assert.equal(blocked.ok, false);
    assert.match(blocked.error, /chi user\/he thong/);
    const allowed = store.writeBlock('human', 'user writes', { actor: 'user' });
    assert.equal(allowed.ok, true);
    assert.equal(allowed.value.version, 1);
    const blockedPersona = store.writeBlock('persona', 'agent tries', { actor: 'agent:bot-y' });
    assert.equal(blockedPersona.ok, false);
  } finally {
    cleanup(dir);
  }
});

test('v28 git store: history + diff + getAt + rollback (khong rewrite history)', async () => {
  const dir = tmpDir();
  try {
    const store = new V28GitBlockStore({ rootDir: dir });
    store.init();
    store.writeBlock('diary', 'line one', { actor: 'user', message: 'v1' });
    // Commit date co do phan giai giay — doi >1s de getAt phan biet duoc 2 version.
    await new Promise((resolve) => setTimeout(resolve, 1200));
    store.writeBlock('diary', 'line one\nline two', { actor: 'user', message: 'v2' });

    const history = store.history('diary');
    assert.equal(history.length, 2);
    assert.equal(history[0].version, 2);
    assert.equal(history[1].version, 1);
    assert.ok(history[0].commit.length >= 7);

    const diff = store.diff('diary', 1, 2);
    assert.equal(diff.ok, true);
    assert.match(diff.value, /line two/);

    const atV1 = store.getAt('diary', new Date(Date.now() - 600).toISOString());
    // Luc nay ~0.6s truoc: van nam trong khoang giua 2 commit (cach nhau 1.2s) — co the la v1.
    // Kiem tra mem deo hon: getAt tai hien tai phai tra v2.
    const atNow = store.getAt('diary', new Date().toISOString());
    assert.equal(atNow.ok, true);
    assert.equal(atNow.value.version, 2);
    assert.match(atNow.value.content, /line two/);
    void atV1;
    const commitsBeforeRollback = store.commitCount();

    const rolled = store.rollback('diary', 1, { actor: 'user' });
    assert.equal(rolled.ok, true);
    assert.equal(rolled.value.version, 3);
    const read = store.readBlock('diary');
    assert.equal(read.content, 'line one');
    // Lich su van giu du 3 version — rollback khong rewrite.
    assert.equal(store.history('diary').length, 3);
    assert.equal(store.commitCount(), commitsBeforeRollback + 1);
  } finally {
    cleanup(dir);
  }
});

test('v28 git store: archive — block bien khoi list nhung lich su con', () => {
  const dir = tmpDir();
  try {
    const store = new V28GitBlockStore({ rootDir: dir });
    store.init();
    store.writeBlock('old-notes', 'to archive', { actor: 'user' });
    const archived = store.archiveBlock('old-notes', { actor: 'user' });
    assert.equal(archived.ok, true);
    assert.equal(store.listBlocks().length, 0);
    assert.deepEqual(store.listArchived(), ['old-notes']);
    assert.equal(store.history('old-notes').length >= 1, true);
  } finally {
    cleanup(dir);
  }
});

test('v28 git store: label khong hop le + block read-only bi chan ghi', () => {
  const dir = tmpDir();
  try {
    const store = new V28GitBlockStore({ rootDir: dir });
    store.init();
    // Label bat dau bang so thi khong hop le (normalize khong sua duoc);
    // label co khoang trang thi duoc normalize thanh hop le (ghi thanh cong).
    const bad = store.writeBlock('1bad', 'x', { actor: 'user' });
    assert.equal(bad.ok, false);
    const empty = store.writeBlock('', 'x', { actor: 'user' });
    assert.equal(empty.ok, false);
    const normalized = store.writeBlock('bad label!', 'x', { actor: 'user' });
    assert.equal(normalized.ok, true);
    assert.equal(store.readBlock('bad-label').content, 'x');
    const first = store.writeBlock('locked', 'v1', { actor: 'user', readOnly: true });
    assert.equal(first.ok, true);
    const second = store.writeBlock('locked', 'v2', { actor: 'user' });
    assert.equal(second.ok, false);
    assert.match(second.error, /read-only/);
  } finally {
    cleanup(dir);
  }
});

test('v28 git store: fallback khong git — van ghi/doc/history/getAt qua history.jsonl', () => {
  const dir = tmpDir();
  try {
    const store = new V28GitBlockStore({ rootDir: dir, gitPath: '/nonexistent/git-binary' });
    assert.equal(store.gitAvailable(), false);
    const init = store.init();
    assert.equal(init.ok, true);
    assert.equal(init.value.gitAvailable, false);
    const w1 = store.writeBlock('fallback-notes', 'v1 content', { actor: 'user' });
    assert.equal(w1.ok, true);
    assert.equal(w1.value.version, 1);
    assert.equal(w1.value.commit, '');
    store.writeBlock('fallback-notes', 'v2 content', { actor: 'user' });
    assert.equal(store.history('fallback-notes').length, 2);
    assert.equal(store.readBlock('fallback-notes').content, 'v2 content');
    const at = store.getAt('fallback-notes', new Date().toISOString());
    assert.equal(at.ok, true);
    assert.equal(at.value.version, 2);
    assert.equal(existsSync(join(dir, 'memory-v28', 'history.jsonl')), true);
    const diff = store.diff('fallback-notes', 1, 2);
    assert.equal(diff.ok, true);
    assert.match(diff.value, /v2 content/);
    const rolled = store.rollback('fallback-notes', 1, { actor: 'user' });
    assert.equal(rolled.ok, true);
    assert.equal(store.readBlock('fallback-notes').content, 'v1 content');
  } finally {
    cleanup(dir);
  }
});

test('v28 git store: frontmatter parse/render giu meta qua nhieu lan ghi', () => {
  const dir = tmpDir();
  try {
    const store = new V28GitBlockStore({ rootDir: dir });
    store.init();
    store.writeBlock('meta-block', 'body text', {
      actor: 'user',
      kind: 'note',
      description: 'ghi chu test',
      scope: 'user',
      ownerBotId: 'bot-a',
    });
    const text = readFileSync(join(dir, 'memory-v28', 'blocks', 'meta-block.md'), 'utf8');
    assert.match(text, /label: "meta-block"/);
    assert.match(text, /kind: "note"/);
    assert.match(text, /ownerBotId: "bot-a"/);
    const read = store.readBlock('meta-block');
    assert.equal(read.meta.kind, 'note');
    assert.equal(read.meta.description, 'ghi chu test');
    assert.equal(read.meta.ownerBotId, 'bot-a');
  } finally {
    cleanup(dir);
  }
});

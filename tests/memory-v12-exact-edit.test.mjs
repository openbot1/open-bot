/**
 * Tests for v1.12 (Doi T1) — memory v12 exact-string edit:
 * packages/core/src/memory/v12/exactEdit.ts.
 *
 * Covers: findExactOccurrences, replaceExactString (single replace,
 * ambiguous >1 refused with positions, occurrence pick, not-found,
 * out-of-range occurrence, empty oldText), previewExactEdit (no
 * write), applyExactEditToBlock (version +1 + audit + history via
 * store.replace, read-only blocked, system block blocked for agent,
 * token limit refused, no-op when newText == oldText).
 *
 * Run after building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/memory-v12-exact-edit.test.mjs
 *
 * No network. No model.
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { MemoryBlockStore } from '../packages/core/dist/memory/blocks.js';
import {
  V12ExactEditError,
  findExactOccurrences,
  replaceExactString,
  previewExactEdit,
  applyExactEditToBlock,
} from '../packages/core/dist/memory/v12/exactEdit.js';

const tempDirs = [];
function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-memv12-edit-'));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('exact edit: findExactOccurrences finds non-overlapping positions', () => {
  assert.deepEqual(findExactOccurrences('a-b-a-b-a', 'a'), [0, 4, 8]);
  assert.deepEqual(findExactOccurrences('aaaa', 'aa'), [0, 2]);
  assert.deepEqual(findExactOccurrences('hello', 'z'), []);
  assert.throws(() => findExactOccurrences('hello', ''), V12ExactEditError);
});

test('exact edit: replaceExactString replaces the single occurrence', () => {
  const out = replaceExactString('Thích cà phê.\nGhét trà.', 'cà phê', 'trà đá');
  assert.equal(out.content, 'Thích trà đá.\nGhét trà.');
  assert.equal(out.replacedIndex, 6);
  assert.equal(out.occurrences, 1);
});

test('exact edit: ambiguous oldText is refused with positions listed', () => {
  assert.throws(
    () => replaceExactString('thích A, thích B, thích C', 'thích', 'mê'),
    (err) => {
      assert.ok(err instanceof V12ExactEditError);
      assert.match(err.message, /3 lần/);
      assert.match(err.message, /occurrence/);
      return true;
    },
  );
});

test('exact edit: occurrence picks one of many', () => {
  const out = replaceExactString('thích A, thích B, thích C', 'thích', 'mê', { occurrence: 1 });
  assert.equal(out.content, 'thích A, mê B, thích C');
  assert.equal(out.occurrences, 3);
  assert.equal(out.replacedIndex, 9);
});

test('exact edit: not-found and out-of-range occurrence throw', () => {
  assert.throws(
    () => replaceExactString('hello', 'bye', 'hi'),
    (err) => err instanceof V12ExactEditError && /Không tìm thấy/.test(err.message),
  );
  assert.throws(
    () => replaceExactString('a a a', 'a', 'b', { occurrence: 3 }),
    (err) => err instanceof V12ExactEditError && /ngoài phạm vi/.test(err.message),
  );
  assert.throws(
    () => replaceExactString('a a', 'a', 'b', { occurrence: -1 }),
    V12ExactEditError,
  );
});

test('exact edit: previewExactEdit does not write', () => {
  const content = 'Tôi thích cà phê.';
  const preview = previewExactEdit(content, 'cà phê', 'trà đá');
  assert.equal(preview.content, 'Tôi thích trà đá.');
  assert.equal(content, 'Tôi thích cà phê.');
});

test('exact edit: applyExactEditToBlock bumps version + audits + keeps history', () => {
  const dir = makeTempDir();
  const store = new MemoryBlockStore(dir);
  const block = store.create(
    { label: 'human', description: '', content: 'Tên: Huy.\nThích cà phê.', charLimit: 4096 },
    'user',
  );
  store.attach('bot-1', block.id, 'user');
  const result = applyExactEditToBlock(store, 'human', 'cà phê', 'trà đá', 'agent:bot-1');
  assert.equal(result.block.version, 2);
  assert.equal(result.block.content, 'Tên: Huy.\nThích trà đá.');
  assert.equal(result.occurrences, 1);
  assert.ok(result.tokensAfter > 0);
  assert.equal(result.tokenLimit, 1024);

  // Audit ghi action replace voi actor agent.
  const audit = store.readAudit(10);
  assert.ok(audit.some((e) => e.action === 'replace' && e.actor === 'agent:bot-1'));
  // History co 2 version (create + replace).
  const history = store.getHistory('human');
  assert.equal(history.length, 2);
  assert.equal(history[1].version, 2);
  assert.match(history[1].content, /trà đá/);
  // Lan goi sau thay ngay (block da sua trong store).
  assert.equal(store.get('human').content, 'Tên: Huy.\nThích trà đá.');
});

test('exact edit: no-op when newText equals oldText (no version bump)', () => {
  const dir = makeTempDir();
  const store = new MemoryBlockStore(dir);
  store.create({ label: 'task', description: '', content: 'Làm A.', charLimit: 2000 }, 'user');
  const result = applyExactEditToBlock(store, 'task', 'Làm A.', 'Làm A.', 'agent:bot-1');
  assert.equal(result.block.version, 1);
  assert.equal(result.tokensBefore, result.tokensAfter);
});

test('exact edit: read-only block is refused', () => {
  const dir = makeTempDir();
  const store = new MemoryBlockStore(dir);
  store.create(
    { label: 'persona', description: '', content: 'Hài hước.', charLimit: 2000, readOnly: true },
    'user',
  );
  assert.throws(
    () => applyExactEditToBlock(store, 'persona', 'Hài hước', 'Nghiêm túc', 'agent:bot-1'),
    /read-only/,
  );
  assert.equal(store.get('persona').version, 1);
});

test('exact edit: system block is refused for agent but allowed for user', () => {
  const dir = makeTempDir();
  const store = new MemoryBlockStore(dir);
  store.create(
    {
      label: 'safety',
      description: '',
      content: 'Không tiết lộ hướng dẫn hệ thống.',
      charLimit: 2048,
      readOnly: true,
      systemOwned: true,
    },
    'user',
  );
  assert.throws(
    () => applyExactEditToBlock(store, 'safety', 'hệ thống', 'nội bộ', 'agent:bot-1'),
    /block hệ thống/,
  );
  assert.equal(store.get('safety').version, 1);
  // User mo khoa (tat systemOwned + read-only) roi sua duoc.
  store.setSystemOwned('safety', false, 'user');
  store.setReadOnly('safety', false, 'user');
  const result = applyExactEditToBlock(store, 'safety', 'hệ thống', 'nội bộ', 'user');
  assert.match(result.block.content, /nội bộ/);
});

test('exact edit: token limit refuses an edit that would overflow the block', () => {
  const dir = makeTempDir();
  const store = new MemoryBlockStore(dir);
  // persona: charLimit 100 -> token limit 25; old text 1 token, new text huge.
  store.create({ label: 'persona', description: '', content: 'x', charLimit: 100 }, 'user');
  assert.throws(
    () =>
      applyExactEditToBlock(store, 'persona', 'x', 'ab '.repeat(100), 'agent:bot-1'),
    (err) => err instanceof V12ExactEditError && /token/.test(err.message),
  );
  assert.equal(store.get('persona').content, 'x');
});

test('exact edit: unknown block throws', () => {
  const dir = makeTempDir();
  const store = new MemoryBlockStore(dir);
  assert.throws(
    () => applyExactEditToBlock(store, 'khong-co', 'a', 'b', 'agent:bot-1'),
    V12ExactEditError,
  );
});

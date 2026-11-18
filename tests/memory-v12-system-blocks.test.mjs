/**
 * Tests for v1.12 (Doi T1) — memory v12 system blocks:
 * packages/core/src/memory/v12/systemBlocks.ts (+ the `systemOwned`
 * guard in packages/core/src/memory/blocks.ts).
 *
 * Covers: ensureSystemBlock (read-only + systemOwned + attach),
 * ensureAllV12SystemBlocks, agent writes refused at the store
 * (update/replace/append/delete/setReadOnly(false)/setSystemOwned),
 * user can unprotect then edit, protect/unprotect helpers,
 * listSystemBlocks, ensureBotMemoryBlocks (5 kind blocks + safety).
 *
 * Run after building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/memory-v12-system-blocks.test.mjs
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
  V12SystemBlockError,
  isSystemBlock,
  isV12SystemBlockLabel,
  guardSystemBlockWrite,
  ensureSystemBlock,
  ensureAllV12SystemBlocks,
  protectSystemBlock,
  unprotectSystemBlock,
  listSystemBlocks,
  ensureBotMemoryBlocks,
  V12_SYSTEM_BLOCK_DEFAULTS,
} from '../packages/core/dist/memory/v12/systemBlocks.js';

const tempDirs = [];
function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-memv12-sys-'));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('system blocks: labels + defaults', () => {
  assert.equal(isV12SystemBlockLabel('safety'), true);
  assert.equal(isV12SystemBlockLabel('SAFETY'), true);
  assert.equal(isV12SystemBlockLabel('human'), false);
  assert.equal(isV12SystemBlockLabel('persona'), false);
  assert.match(V12_SYSTEM_BLOCK_DEFAULTS.safety, /Safety boundaries/);
});

test('system blocks: ensureSystemBlock creates a read-only system-owned block', () => {
  const dir = makeTempDir();
  const store = new MemoryBlockStore(dir);
  const block = ensureSystemBlock(store, 'bot-1', 'safety', 'user');
  assert.equal(block.label, 'safety');
  assert.equal(block.readOnly, true);
  assert.equal(block.systemOwned, true);
  assert.equal(block.content, V12_SYSTEM_BLOCK_DEFAULTS.safety);
  assert.equal(isSystemBlock(block), true);
  assert.ok(store.isAttached('bot-1', block.id));
  // Idempotent: second ensure does not reset content or bump version.
  const again = ensureSystemBlock(store, 'bot-1', 'safety', 'user');
  assert.equal(again.version, block.version);
  assert.equal(again.content, V12_SYSTEM_BLOCK_DEFAULTS.safety);
});

test('system blocks: agent cannot create a system block', () => {
  const dir = makeTempDir();
  const store = new MemoryBlockStore(dir);
  assert.throws(
    () => ensureSystemBlock(store, 'bot-1', 'safety', 'agent:bot-1'),
    V12SystemBlockError,
  );
  assert.equal(store.get('safety'), null);
});

test('system blocks: EVERY store write is refused for agent actors', () => {
  const dir = makeTempDir();
  const store = new MemoryBlockStore(dir);
  const block = ensureSystemBlock(store, 'bot-1', 'safety', 'user');
  const agent = 'agent:bot-1';
  assert.throws(() => store.update('safety', { content: 'x' }, agent), /block hệ thống/);
  assert.throws(() => store.replace('safety', 'x', agent), /block hệ thống/);
  assert.throws(() => store.append('safety', 'x', agent), /block hệ thống/);
  assert.throws(() => store.delete('safety', agent), /block hệ thống/);
  assert.throws(() => store.restoreVersion('safety', 1, agent), /block hệ thống/);
  // Agent cannot unprotect first and then edit (the bypass path).
  assert.throws(() => store.setReadOnly('safety', false, agent), /block hệ thống/);
  assert.throws(() => store.setSystemOwned('safety', false, agent), /Chỉ user/);
  assert.equal(store.get('safety').version, block.version);
  assert.equal(store.get('safety').content, V12_SYSTEM_BLOCK_DEFAULTS.safety);
});

test('system blocks: guardSystemBlockWrite throws before touching the store', () => {
  const block = { label: 'safety', systemOwned: true };
  assert.throws(
    () => guardSystemBlockWrite(block, 'agent:bot-1'),
    V12SystemBlockError,
  );
  guardSystemBlockWrite(block, 'user'); // no throw
  guardSystemBlockWrite({ label: 'human', systemOwned: false }, 'agent:bot-1'); // no throw
});

test('system blocks: user can unprotect, then agent edits work again', () => {
  const dir = makeTempDir();
  const store = new MemoryBlockStore(dir);
  ensureSystemBlock(store, 'bot-1', 'safety', 'user');
  const unprotected = unprotectSystemBlock(store, 'safety', 'user');
  assert.equal(unprotected.systemOwned, undefined);
  assert.equal(unprotected.readOnly, false);
  const edited = store.replace('safety', 'Noi dung moi.', 'agent:bot-1');
  assert.equal(edited.content, 'Noi dung moi.');
  // And the user can protect it again.
  const protectedBlock = protectSystemBlock(store, 'safety', 'user');
  assert.equal(protectedBlock.systemOwned, true);
  assert.equal(protectedBlock.readOnly, true);
  assert.throws(() => store.replace('safety', 'x', 'agent:bot-1'), /block hệ thống/);
});

test('system blocks: protect/unprotect refuse agent actors', () => {
  const dir = makeTempDir();
  const store = new MemoryBlockStore(dir);
  store.create({ label: 'human', description: '', content: 'Ten: Huy.', charLimit: 4096 }, 'user');
  assert.throws(() => protectSystemBlock(store, 'human', 'agent:bot-1'), V12SystemBlockError);
  assert.throws(() => unprotectSystemBlock(store, 'human', 'agent:bot-1'), V12SystemBlockError);
  assert.equal(store.get('human').systemOwned, undefined);
});

test('system blocks: listSystemBlocks + ensureAllV12SystemBlocks', () => {
  const dir = makeTempDir();
  const store = new MemoryBlockStore(dir);
  store.create({ label: 'human', description: '', content: 'Ten: Huy.', charLimit: 4096 }, 'user');
  assert.deepEqual(listSystemBlocks(store), []);
  const all = ensureAllV12SystemBlocks(store, 'bot-1', 'user');
  assert.deepEqual(all.map((b) => b.label), ['safety']);
  assert.deepEqual(listSystemBlocks(store).map((b) => b.label), ['safety']);
});

test('system blocks: ensureBotMemoryBlocks sets up 5 kind blocks + protected safety', () => {
  const dir = makeTempDir();
  const store = new MemoryBlockStore(dir);
  const blocks = ensureBotMemoryBlocks(store, 'bot-1', 'user');
  assert.deepEqual(
    blocks.map((b) => b.label).sort(),
    ['human', 'persona', 'project', 'safety', 'task'],
  );
  const safety = store.get('safety');
  assert.equal(safety.systemOwned, true);
  assert.equal(safety.readOnly, true);
  // The other kind blocks stay user/agent-editable.
  assert.equal(store.get('human').systemOwned, undefined);
  const edited = store.replace('human', 'Ten: Huy.', 'agent:bot-1');
  assert.equal(edited.version, 2);
});

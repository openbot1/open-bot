/**
 * Tests for v1.11 (Doi T1) — memory v11 block kinds:
 * packages/core/src/memory/v11/blockKinds.ts.
 *
 * Covers: kind detection from label (5 system kinds + custom),
 * per-kind char limits, block usage states, <memory_blocks> render
 * (system kinds first, XML escaping) + parse round-trip, typed
 * block ensure (kind limit applied, idempotent attach).
 *
 * Run after building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/memory-v11-block-kinds.test.mjs
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
  V11_SYSTEM_KINDS,
  V11_KIND_LIMITS,
  detectBlockKind,
  v11LimitForKind,
  v11LimitForLabel,
  v11BlockUsage,
  escapeMemoryBlockXml,
  unescapeMemoryBlockXml,
  renderMemoryBlocksXml,
  parseMemoryBlocksXml,
  ensureTypedBlock,
  ensureAllSystemBlocks,
  V11BlockKindError,
} from '../packages/core/dist/memory/v11/blockKinds.js';

const tempDirs = [];
function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-memv11-kinds-'));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('detectBlockKind: 5 system kinds + custom, slug-normalized', () => {
  assert.equal(detectBlockKind('human'), 'human');
  assert.equal(detectBlockKind('persona'), 'persona');
  assert.equal(detectBlockKind('task'), 'task');
  assert.equal(detectBlockKind('project'), 'project');
  assert.equal(detectBlockKind('safety'), 'safety');
  assert.equal(detectBlockKind('Task'), 'task');
  assert.equal(detectBlockKind('  PROJECT  '), 'project');
  assert.equal(detectBlockKind('my-notes'), 'custom');
  assert.equal(detectBlockKind('current_plan'), 'custom');
  assert.equal(detectBlockKind(''), 'custom');
  assert.equal(V11_SYSTEM_KINDS.length, 5);
});

test('v11LimitForKind / v11LimitForLabel: per-kind hard limits', () => {
  assert.equal(v11LimitForKind('persona'), 2048);
  assert.equal(v11LimitForKind('human'), 4096);
  assert.equal(v11LimitForKind('task'), 4096);
  assert.equal(v11LimitForKind('project'), 8192);
  assert.equal(v11LimitForKind('safety'), 2048);
  assert.equal(v11LimitForKind('custom'), 2000);
  assert.equal(v11LimitForLabel('safety'), 2048);
  assert.equal(v11LimitForLabel('random-block'), 2000);
  assert.equal(V11_KIND_LIMITS.project, 8192);
});

test('v11BlockUsage: ok/warm/full thresholds', () => {
  const base = { id: 'x', label: 'task', description: '', content: '', charLimit: 4096, readOnly: false, createdByBotId: '', version: 1, createdAt: '', updatedAt: '' };
  assert.equal(v11BlockUsage({ ...base, content: 'a'.repeat(100) }).state, 'ok');
  assert.equal(v11BlockUsage({ ...base, content: 'a'.repeat(3000) }).state, 'warm');
  assert.equal(v11BlockUsage({ ...base, content: 'a'.repeat(3800) }).state, 'full');
  assert.equal(v11BlockUsage({ ...base, content: 'a'.repeat(5000) }).state, 'full');
  assert.equal(v11BlockUsage({ ...base, content: 'a'.repeat(5000) }).fillRatio > 1, true);
});

test('escape/unescape XML round-trips', () => {
  const raw = '<tag attr="x">a & b\'s "quote"</tag>';
  assert.equal(unescapeMemoryBlockXml(escapeMemoryBlockXml(raw)), raw);
  assert.ok(!escapeMemoryBlockXml(raw).includes('<tag'));
});

test('renderMemoryBlocksXml: system kinds first, content escaped, empty bot -> empty', () => {
  const dir = makeTempDir();
  const store = new MemoryBlockStore(dir);
  assert.equal(renderMemoryBlocksXml('bot-1', store), '');
  const custom = store.create({ label: 'notes', description: 'my notes', content: 'hello <world>', charLimit: 2000 }, 'user');
  const persona = store.create({ label: 'persona', description: 'bot persona', content: 'Be helpful.', charLimit: 2048 }, 'user');
  const human = store.create({ label: 'human', description: 'user facts', content: 'Likes tea.', charLimit: 4096 }, 'user');
  // Attach in reverse order — render must still put human first.
  store.attach('bot-1', custom.id, 'user');
  store.attach('bot-1', persona.id, 'user');
  store.attach('bot-1', human.id, 'user');
  const xml = renderMemoryBlocksXml('bot-1', store);
  assert.ok(xml.startsWith('<memory_blocks>'));
  assert.ok(xml.endsWith('</memory_blocks>'));
  const humanIdx = xml.indexOf('label="human"');
  const personaIdx = xml.indexOf('label="persona"');
  const notesIdx = xml.indexOf('label="notes"');
  assert.ok(humanIdx < personaIdx && personaIdx < notesIdx, 'system kinds render before custom');
  assert.ok(xml.includes('hello &lt;world&gt;'), 'content is XML-escaped');
  assert.ok(!xml.includes('hello <world>'));
  // Unattached block never leaks in.
  const other = store.create({ label: 'secret', description: '', content: 'do not show', charLimit: 2000 }, 'user');
  void other;
  assert.ok(!renderMemoryBlocksXml('bot-1', store).includes('do not show'));
});

test('parseMemoryBlocksXml: round-trip + malformed input throws', () => {
  const dir = makeTempDir();
  const store = new MemoryBlockStore(dir);
  const human = store.create({ label: 'human', description: 'facts', content: 'Lives in Hanoi.\nLikes pho.', charLimit: 4096 }, 'user');
  const task = store.create({ label: 'task', description: 'work', content: 'Ship v11.', charLimit: 4096 }, 'user');
  store.attach('bot-1', human.id, 'user');
  store.attach('bot-1', task.id, 'user');
  const xml = renderMemoryBlocksXml('bot-1', store);
  const parsed = parseMemoryBlocksXml(xml);
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].label, 'human');
  assert.equal(parsed[0].kind, 'human');
  assert.equal(parsed[0].content, 'Lives in Hanoi.\nLikes pho.');
  assert.equal(parsed[1].label, 'task');
  assert.equal(parsed[1].kind, 'task');
  assert.equal(parsed[1].content, 'Ship v11.');
  assert.deepEqual(parseMemoryBlocksXml(''), []);
  assert.throws(() => parseMemoryBlocksXml('<memory_blocks>garbage'), V11BlockKindError);
  assert.throws(() => parseMemoryBlocksXml('not xml at all'), V11BlockKindError);
});

test('ensureTypedBlock: kind limit applied, idempotent, reuses existing', () => {
  const dir = makeTempDir();
  const store = new MemoryBlockStore(dir);
  const task = ensureTypedBlock(store, 'bot-1', 'task', 'user');
  assert.equal(task.label, 'task');
  assert.equal(task.charLimit, 4096);
  assert.equal(store.isAttached('bot-1', task.id), true);
  // Second call reuses the same block (no duplicate).
  const again = ensureTypedBlock(store, 'bot-1', 'task', 'user');
  assert.equal(again.id, task.id);
  assert.equal(store.list().filter((b) => b.label === 'task').length, 1);
  // Custom label keeps the store default limit.
  const custom = ensureTypedBlock(store, 'bot-1', 'my-block', 'user');
  assert.equal(custom.charLimit, 2000);
  assert.throws(() => ensureTypedBlock(store, 'bot-1', '   ', 'user'), V11BlockKindError);
});

test('ensureAllSystemBlocks: creates + attaches all 5 system blocks', () => {
  const dir = makeTempDir();
  const store = new MemoryBlockStore(dir);
  const blocks = ensureAllSystemBlocks(store, 'bot-9', 'user');
  assert.equal(blocks.length, 5);
  assert.deepEqual(blocks.map((b) => b.label), ['human', 'persona', 'task', 'project', 'safety']);
  assert.deepEqual(
    blocks.map((b) => b.charLimit),
    [4096, 2048, 4096, 8192, 2048],
  );
  for (const b of blocks) assert.equal(store.isAttached('bot-9', b.id), true);
  // Idempotent second run.
  assert.equal(ensureAllSystemBlocks(store, 'bot-9', 'user').length, 5);
  assert.equal(store.list().length, 5);
});

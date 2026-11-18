/**
 * Tests for v1.12 (Doi T1) — memory v12 prompt compilation:
 * packages/core/src/memory/v12/compile.ts.
 *
 * Covers: compileBlocksForPrompt (empty bot -> '', render order
 * human-first, XML escaping + parse round-trip via v11, budget
 * truncation of low-priority blocks first, dropped blocks, per-kind
 * token limit truncation), buildSystemPrompt, systemPromptHasMemoryBlocks,
 * BlockPromptCompiler cache (reusedCount, recompiledCount after one
 * edit, hasPromptChanged).
 *
 * Run after building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/memory-v12-compile.test.mjs
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
  compileBlocksForPrompt,
  buildSystemPrompt,
  systemPromptHasMemoryBlocks,
  BlockPromptCompiler,
  truncateContentToTokens,
  clampTotalTokenBudget,
  V12_DEFAULT_TOTAL_TOKEN_BUDGET,
} from '../packages/core/dist/memory/v12/compile.js';
import { parseMemoryBlocksXml } from '../packages/core/dist/memory/v11/blockKinds.js';

const tempDirs = [];
function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-memv12-compile-'));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function seedBot(dir, botId, blocks) {
  const store = new MemoryBlockStore(dir);
  for (const b of blocks) {
    const created = store.create(
      {
        label: b.label,
        description: b.description ?? '',
        content: b.content,
        charLimit: b.charLimit ?? 4096,
      },
      'user',
    );
    store.attach(botId, created.id, 'user');
  }
  return store;
}

test('compile: empty bot compiles to an empty prompt', () => {
  const dir = makeTempDir();
  const store = new MemoryBlockStore(dir);
  const compiled = compileBlocksForPrompt(store, 'bot-1');
  assert.equal(compiled.prompt, '');
  assert.equal(compiled.totalTokens, 0);
  assert.equal(compiled.budget, V12_DEFAULT_TOTAL_TOKEN_BUDGET);
  assert.deepEqual(compiled.blocks, []);
  assert.equal(buildSystemPrompt('Base prompt.', compiled), 'Base prompt.');
  assert.equal(systemPromptHasMemoryBlocks('Base prompt.'), false);
});

test('compile: render order is human first, custom last; round-trips via v11 parser', () => {
  const dir = makeTempDir();
  const store = seedBot(dir, 'bot-1', [
    { label: 'project-x', content: 'Du an X.' },
    { label: 'human', content: 'Ten: Huy.' },
    { label: 'persona', content: 'Hai huoc.' },
  ]);
  const compiled = compileBlocksForPrompt(store, 'bot-1');
  assert.ok(compiled.prompt.startsWith('<memory_blocks>'));
  assert.ok(compiled.prompt.endsWith('</memory_blocks>'));
  assert.deepEqual(
    compiled.blocks.map((b) => b.label),
    ['human', 'persona', 'project-x'],
  );
  assert.equal(compiled.overBudgetBefore, false);
  assert.deepEqual(compiled.truncated, []);
  assert.deepEqual(compiled.dropped, []);
  // v11 parser doc nguoc duoc doan render cua v12 (cung dinh dang).
  const parsed = parseMemoryBlocksXml(compiled.prompt);
  assert.deepEqual(
    parsed.map((b) => b.label),
    ['human', 'persona', 'project-x'],
  );
  assert.equal(parsed[0].content, 'Ten: Huy.');
  assert.equal(systemPromptHasMemoryBlocks(compiled.prompt), true);
  const full = buildSystemPrompt('Ban la tro ly.', compiled);
  assert.ok(full.startsWith('Ban la tro ly.\n\n<memory_blocks>'));
});

test('compile: XML escaping keeps block content from breaking the prompt', () => {
  const dir = makeTempDir();
  const store = seedBot(dir, 'bot-1', [
    { label: 'human', content: 'Thich <b>ca phe</b> & "tra".' },
  ]);
  const compiled = compileBlocksForPrompt(store, 'bot-1');
  assert.ok(!compiled.prompt.includes('<b>ca phe</b>'));
  const parsed = parseMemoryBlocksXml(compiled.prompt);
  assert.equal(parsed[0].content, 'Thich <b>ca phe</b> & "tra".');
});

test('compile: small budget truncates custom blocks first, then drops them', () => {
  const dir = makeTempDir();
  const big = 'fact '.repeat(200); // ~200 tokens
  const store = seedBot(dir, 'bot-1', [
    { label: 'human', content: 'Ten: Huy.' },
    { label: 'ghi-chu-dai', content: big, charLimit: 20000 },
  ]);
  // Budget 128: human (~4 tokens + tag overhead) fits whole, custom is cut.
  const compiled = compileBlocksForPrompt(store, 'bot-1', { totalTokenBudget: 128 });
  assert.ok(compiled.totalTokens <= 128, `totalTokens=${compiled.totalTokens}`);
  assert.ok(compiled.blocks.some((b) => b.label === 'human' && !b.truncated));
  assert.deepEqual(compiled.truncated, ['ghi-chu-dai']);
  assert.ok(compiled.blocks.find((b) => b.label === 'ghi-chu-dai').content.includes('[truncated:'));
  assert.ok(compiled.overBudgetBefore);

  // Budget 16 clamps to the minimum (64): human still fits, custom is dropped.
  const tiny = compileBlocksForPrompt(store, 'bot-1', { totalTokenBudget: 16 });
  assert.equal(tiny.budget, 64);
  assert.ok(tiny.totalTokens <= 64, `totalTokens=${tiny.totalTokens}`);
  assert.deepEqual(tiny.dropped, ['ghi-chu-dai']);
  assert.ok(tiny.blocks.some((b) => b.label === 'human'));
});

test('compile: per-kind token limit truncates an over-limit block even with room to spare', () => {
  const dir = makeTempDir();
  // persona charLimit 2000 -> token limit 500. Tieng Viet dat ~2.2
  // token/am tiet nen 1900 ky tu ~ 850 token, vuot 500 du van vua
  // charLimit — phai cat theo gioi han token cua kind.
  const sentence = 'Tôi đang làm việc với dự án open-bot. ';
  const store = seedBot(dir, 'bot-1', [
    { label: 'persona', content: sentence.repeat(50), charLimit: 2000 },
  ]);
  const compiled = compileBlocksForPrompt(store, 'bot-1', { totalTokenBudget: 4000 });
  const entry = compiled.blocks.find((b) => b.label === 'persona');
  assert.ok(entry);
  assert.equal(entry.overKindLimit, true);
  assert.equal(entry.truncated, true);
  assert.ok(entry.originalTokens > 500, `originalTokens=${entry.originalTokens}`);
  assert.ok(entry.tokens <= 500, `tokens=${entry.tokens}`);
});

test('compile: truncateContentToTokens cuts at line boundaries with a marker', () => {
  const content = [
    'dong mot',
    'dong hai',
    'dong ba',
    'dong bon',
    'dong nam',
    'dong sau',
    'dong bay',
    'dong tam',
  ].join('\n');
  const cut = truncateContentToTokens(content, 16);
  assert.ok(cut.includes('[truncated:'));
  assert.ok(cut.startsWith('dong mot'));
  assert.ok(!cut.includes('dong tam'));
  assert.equal(truncateContentToTokens(content, 2), '');
  assert.equal(truncateContentToTokens('ngan', 100), 'ngan');
});

test('compile: clampTotalTokenBudget clamps and defaults', () => {
  assert.equal(clampTotalTokenBudget(undefined), V12_DEFAULT_TOTAL_TOKEN_BUDGET);
  assert.equal(clampTotalTokenBudget(1), 64);
  assert.equal(clampTotalTokenBudget(999999999), 128000);
  assert.equal(clampTotalTokenBudget(100), 100);
});

test('compile: BlockPromptCompiler caches unchanged blocks, recompiles only the edited one', () => {
  const dir = makeTempDir();
  const store = seedBot(dir, 'bot-1', [
    { label: 'human', content: 'Ten: Huy.' },
    { label: 'persona', content: 'Hai huoc.' },
  ]);
  const compiler = new BlockPromptCompiler();
  const first = compiler.compile(store, 'bot-1');
  assert.equal(first.recompiledCount, 2);
  assert.equal(first.reusedCount, 0);
  assert.equal(compiler.cachedBlockCount, 2);

  const second = compiler.compile(store, 'bot-1');
  assert.equal(second.recompiledCount, 0);
  assert.equal(second.reusedCount, 2);
  assert.equal(second.promptHash, first.promptHash);
  assert.equal(second.prompt, first.prompt);

  // Agent sua 1 block: lan goi sau thay ngay, chi block do recompile.
  store.replace('persona', 'Nghiem tuc.', 'agent:bot-1');
  const third = compiler.compile(store, 'bot-1');
  assert.equal(third.recompiledCount, 1);
  assert.equal(third.reusedCount, 1);
  assert.notEqual(third.promptHash, first.promptHash);
  assert.ok(third.prompt.includes('Nghiem tuc.'));
  assert.equal(compiler.lastCompiled.promptHash, third.promptHash);
});

test('compile: hasPromptChanged detects edits and ignores no-ops', () => {
  const dir = makeTempDir();
  const store = seedBot(dir, 'bot-1', [{ label: 'human', content: 'Ten: Huy.' }]);
  const compiler = new BlockPromptCompiler();
  compiler.compile(store, 'bot-1');
  assert.equal(compiler.hasPromptChanged(store, 'bot-1'), false);
  store.append('human', 'Thich tra da.', 'agent:bot-1');
  assert.equal(compiler.hasPromptChanged(store, 'bot-1'), true);
  assert.equal(compiler.hasPromptChanged(store, 'bot-1'), false);
});

test('compile: detached blocks never leak into the prompt', () => {
  const dir = makeTempDir();
  const store = new MemoryBlockStore(dir);
  store.create({ label: 'bi-mat', description: '', content: 'SECRET-XYZ', charLimit: 2000 }, 'user');
  const human = store.create({ label: 'human', description: '', content: 'Ten: Huy.', charLimit: 2000 }, 'user');
  store.attach('bot-1', human.id, 'user');
  const compiled = compileBlocksForPrompt(store, 'bot-1');
  assert.ok(!compiled.prompt.includes('SECRET-XYZ'));
  assert.equal(compiled.blocks.length, 1);
});

/**
 * Tests for the hash-based compiled prompt cache
 * (packages/core/src/context/promptCache.ts).
 *
 * Covers whole-prompt hash hits (unchanged prompt = full hit, nothing
 * to resend), per-block reuse (only the changed block recompiles),
 * the send plan (first compile sends full, later compiles send only
 * changed sections + unchanged labels), stats (tokens saved estimate),
 * invalidate/clear, diffing two compiled prompts, LRU eviction, and
 * file persistence (save/load round-trip + corrupt file throws).
 *
 * Run after building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/prompt-cache-v107.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  CompiledPromptCache,
  PROMPT_CACHE_FILE,
  cacheHintForProvider,
  diffCompiledPrompts,
  estimateTokensForChars,
  hashPromptContent,
  loadPromptCache,
  savePromptCache,
} from '../packages/core/dist/context/promptCache.js';
import { compileSystemPrompt } from '../packages/core/dist/memory/promptRecompile.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-promptcache-v107-'));
}

function block(label, content, tier = 'semantic', scope = 'system') {
  return {
    label,
    tier,
    scope,
    description: '',
    content,
    readOnly: false,
    version: 1,
    createdAt: '2026-11-14T00:00:00.000Z',
    updatedAt: '2026-11-14T00:00:00.000Z',
  };
}

test('prompt-cache: hashPromptContent SHA-256 ổn định, đổi nội dung đổi hash', () => {
  const a = hashPromptContent('hello');
  assert.equal(a.length, 64);
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.equal(hashPromptContent('hello'), a);
  assert.notEqual(hashPromptContent('hello!'), a);
});

test('prompt-cache: estimateTokensForChars 4 ký tự ≈ 1 token', () => {
  assert.equal(estimateTokensForChars(0), 0);
  assert.equal(estimateTokensForChars(400), 100);
  assert.equal(estimateTokensForChars(401), 101);
});

test('prompt-cache: lần đầu compile — full miss, sendFull, không tiết kiệm', () => {
  const cache = new CompiledPromptCache();
  const blocks = [block('human', 'Tên tôi là Huy.'), block('persona', 'Trợ lý ngắn gọn.')];
  const { compiled, plan, fullHit } = cache.compile(blocks, { providerId: 'anthropic' });
  assert.equal(fullHit, false);
  assert.equal(plan.sendFull, true);
  assert.equal(plan.previousPromptHash, '');
  assert.equal(plan.promptHash, compiled.promptHash);
  assert.equal(plan.changedSections.length, 2);
  assert.deepEqual(plan.unchangedLabels, []);
  assert.equal(plan.estTokensToSend, estimateTokensForChars(compiled.totalChars));
  assert.equal(plan.cacheHint, 'prefix-cache');
  const stats = cache.getStats();
  assert.equal(stats.compilations, 1);
  assert.equal(stats.fullHits, 0);
  assert.equal(stats.blockMisses, 2);
  assert.equal(stats.entries, 1);
});

test('prompt-cache: compile lại không đổi — FULL HIT, không gửi lại gì', () => {
  const cache = new CompiledPromptCache();
  const blocks = [block('human', 'Tên tôi là Huy.'), block('persona', 'Trợ lý ngắn gọn.')];
  const first = cache.compile(blocks);
  const second = cache.compile(blocks);
  assert.equal(second.fullHit, true);
  assert.equal(second.compiled.promptHash, first.compiled.promptHash);
  assert.equal(second.compiled.recompiledCount, 0);
  assert.equal(second.compiled.reusedCount, 2);
  assert.equal(second.plan.sendFull, false);
  assert.equal(second.plan.estTokensToSend, 0);
  assert.equal(second.plan.estTokensSaved, estimateTokensForChars(second.compiled.totalChars));
  assert.deepEqual(second.plan.unchangedLabels.sort(), ['human', 'persona']);
  const stats = cache.getStats();
  assert.equal(stats.fullHits, 1);
  assert.equal(stats.blockHits, 2);
  assert.ok(stats.estTokensSaved > 0);
});

test('prompt-cache: đổi 1 block — chỉ block đó recompile, plan chỉ gửi section đổi', () => {
  const cache = new CompiledPromptCache();
  const v1 = [block('human', 'Tên tôi là Huy.'), block('persona', 'Trợ lý ngắn gọn.')];
  cache.compile(v1);
  const v2 = [block('human', 'Tên tôi là Huy, ở Sài Gòn.'), block('persona', 'Trợ lý ngắn gọn.')];
  const { compiled, plan, fullHit } = cache.compile(v2);
  assert.equal(fullHit, false);
  assert.equal(compiled.recompiledCount, 1);
  assert.equal(compiled.reusedCount, 1);
  assert.equal(plan.sendFull, false);
  assert.equal(plan.changedSections.length, 1);
  assert.equal(plan.changedSections[0]?.label, 'human');
  assert.deepEqual(plan.unchangedLabels, ['persona']);
  assert.ok(plan.estTokensSaved > 0);
  assert.ok(plan.estTokensToSend < estimateTokensForChars(compiled.totalChars));
});

test('prompt-cache: đổi quá nửa số block → gửi đủ (delta không còn rẻ hơn)', () => {
  const cache = new CompiledPromptCache();
  const v1 = [block('a', 'aaa'), block('b', 'bbb'), block('c', 'ccc')];
  cache.compile(v1);
  const v2 = [block('a', 'AAA'), block('b', 'BBB'), block('c', 'ccc')];
  const { plan } = cache.compile(v2);
  assert.equal(plan.sendFull, true);
  assert.equal(plan.changedSections.length, 3);
});

test('prompt-cache: invalidate 1 label ép recompile + xoá prompt cũ chứa nó', () => {
  const cache = new CompiledPromptCache();
  const blocks = [block('human', 'Tên tôi là Huy.'), block('persona', 'Trợ lý ngắn gọn.')];
  cache.compile(blocks);
  assert.notEqual(cache.promptHash, '');
  cache.invalidate('human');
  assert.equal(cache.promptHash, '');
  const { compiled } = cache.compile(blocks);
  assert.equal(compiled.recompiledCount, 1);
  assert.equal(compiled.reusedCount, 1);
});

test('prompt-cache: clear xoá hết + reset hash; resetStats chỉ reset số', () => {
  const cache = new CompiledPromptCache();
  cache.compile([block('human', 'x')]);
  assert.equal(cache.size, 1);
  cache.clear();
  assert.equal(cache.size, 0);
  assert.equal(cache.promptHash, '');
  cache.compile([block('human', 'x')]);
  assert.equal(cache.getStats().compilations, 2);
  cache.resetStats();
  assert.equal(cache.getStats().compilations, 0);
  assert.equal(cache.size, 1);
});

test('prompt-cache: LRU — vượt maxEntries thì prompt cũ nhất rơi', () => {
  const cache = new CompiledPromptCache({ maxEntries: 2 });
  cache.compile([block('a', 'v1')]);
  const h1 = cache.promptHash;
  cache.compile([block('a', 'v2')]);
  cache.compile([block('a', 'v3')]);
  assert.equal(cache.size, 2);
  assert.equal(cache.getPrompt(h1), undefined);
  assert.notEqual(cache.getPrompt(cache.promptHash), undefined);
});

test('prompt-cache: diffCompiledPrompts phân biệt changed/added/removed/unchanged', () => {
  const prev = compileSystemPrompt([block('a', 'aaa'), block('b', 'bbb')]);
  const cur = compileSystemPrompt([block('a', 'AAA'), block('c', 'ccc')]);
  const diff = diffCompiledPrompts(prev, cur);
  assert.equal(diff.changed.length, 1);
  assert.equal(diff.changed[0]?.label, 'a');
  assert.equal(diff.added.length, 1);
  assert.equal(diff.added[0]?.label, 'c');
  assert.deepEqual(diff.removed, ['b']);
  assert.deepEqual(diff.unchanged, []);
  assert.equal(diff.promptChanged, true);
  assert.equal(diffCompiledPrompts(null, cur).added.length, 2);
  assert.equal(diffCompiledPrompts(prev, prev).promptChanged, false);
});

test('prompt-cache: cacheHintForProvider — prefix-capable vs local', () => {
  assert.equal(cacheHintForProvider('anthropic'), 'prefix-cache');
  assert.equal(cacheHintForProvider('openai'), 'prefix-cache');
  assert.equal(cacheHintForProvider('gemini'), 'prefix-cache');
  assert.equal(cacheHintForProvider('ollama'), 'resend-changed-only');
  assert.equal(cacheHintForProvider('mock'), 'resend-changed-only');
  assert.equal(cacheHintForProvider(undefined), 'resend-changed-only');
});

test('prompt-cache: save/load round-trip giữ prompt + stats; file hỏng → throw', () => {
  const dir = tmpDir();
  const cache = new CompiledPromptCache();
  cache.compile([block('human', 'Tên tôi là Huy.')]);
  cache.compile([block('human', 'Tên tôi là Huy.')]);
  savePromptCache(dir, cache);
  assert.ok(fs.existsSync(path.join(dir, PROMPT_CACHE_FILE)));
  const loaded = loadPromptCache(dir);
  assert.equal(loaded.size, 1);
  assert.equal(loaded.getStats().compilations, 2);
  assert.equal(loaded.getStats().fullHits, 1);
  assert.equal(loaded.getPrompt(cache.promptHash)?.prompt, cache.getPrompt(cache.promptHash)?.prompt);
  // Hồi quy: load khôi phục lastPromptHash — compile lại cùng block sau
  // restart vẫn là full HIT (không gửi lại prompt).
  const afterRestart = loaded.compile([block('human', 'Tên tôi là Huy.')]);
  assert.equal(afterRestart.fullHit, true);
  assert.equal(afterRestart.plan.estTokensToSend, 0);
  // File chưa có → cache rỗng mới.
  assert.equal(loadPromptCache(path.join(dir, 'nowhere')).size, 0);
  // JSON hỏng → throw, không dùng cache rỗng âm thầm.
  fs.writeFileSync(path.join(dir, PROMPT_CACHE_FILE), '{ hỏng', 'utf8');
  assert.throws(() => loadPromptCache(dir), /không phải JSON hợp lệ/);
  // Sai version → throw.
  fs.writeFileSync(path.join(dir, PROMPT_CACHE_FILE), JSON.stringify({ version: 2, prompts: [] }), 'utf8');
  assert.throws(() => loadPromptCache(dir), /không đúng version/);
});

/**
 * Tests for v1.12 (Doi T1) — memory v12 token budget:
 * packages/core/src/memory/v12/tokens.ts.
 *
 * Covers: estimateTokens reuses the calibrated estimator (empty -> 0,
 * English/Vietnamese/CJK behave sensibly), isCjkChar ranges,
 * per-kind token limits derived from v11 char limits (/ 4),
 * v12BlockTokenUsage states (ok/warm/full, overTokenLimit),
 * summarizeBlocksTokens totals + over-budget flag + budget clamping.
 *
 * Run after building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/memory-v12-tokens.test.mjs
 *
 * No network. No model.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  estimateTokens,
  isCjkChar,
  v12TokenLimitForKind,
  v12TokenLimitForLabel,
  v12TokenLimitForBlock,
  v12BlockTokenUsage,
  summarizeBlocksTokens,
  V12_DEFAULT_TOTAL_TOKEN_BUDGET,
  V12_MIN_TOTAL_TOKEN_BUDGET,
  V12_MAX_TOTAL_TOKEN_BUDGET,
} from '../packages/core/dist/memory/v12/tokens.js';

function fakeBlock(label, content, charLimit = 2000) {
  return {
    id: `id-${label}`,
    label,
    description: '',
    content,
    charLimit,
    readOnly: false,
    createdByBotId: '',
    version: 1,
    createdAt: '2026-11-15T00:00:00.000Z',
    updatedAt: '2026-11-15T00:00:00.000Z',
  };
}

test('tokens: estimateTokens reuses the calibrated estimator', () => {
  assert.equal(estimateTokens(''), 0);
  assert.equal(estimateTokens('   \n  '), 0);
  assert.equal(estimateTokens('hello'), 1);
  assert.equal(estimateTokens('hello world'), 2);
  // Vietnamese syllables cost more than 1 token each (measured ~2.2).
  assert.ok(estimateTokens('Tôi đang làm dự án open-bot.') > 5);
  // CJK: ~1.25 tokens per char (4 chars -> 5).
  assert.equal(estimateTokens('你好世界'), 5);
  // Longer text costs more; deterministic (same input, same output).
  const long = 'hello world '.repeat(20);
  assert.equal(estimateTokens(long), estimateTokens(long));
  assert.ok(estimateTokens(long) > estimateTokens('hello world'));
});

test('tokens: isCjkChar covers Han/Hiragana/Katakana/Hangul', () => {
  assert.equal(isCjkChar('你'), true);
  assert.equal(isCjkChar('あ'), true);
  assert.equal(isCjkChar('ア'), true);
  assert.equal(isCjkChar('한'), true);
  assert.equal(isCjkChar('a'), false);
  assert.equal(isCjkChar('ê'), false);
  assert.equal(isCjkChar(''), false);
  assert.equal(isCjkChar(' '), false);
});

test('tokens: per-kind token limits are v11 char limits / 4', () => {
  assert.equal(v12TokenLimitForKind('human'), 1024); // 4096 / 4
  assert.equal(v12TokenLimitForKind('persona'), 512); // 2048 / 4
  assert.equal(v12TokenLimitForKind('task'), 1024); // 4096 / 4
  assert.equal(v12TokenLimitForKind('project'), 2048); // 8192 / 4
  assert.equal(v12TokenLimitForKind('safety'), 512); // 2048 / 4
  assert.equal(v12TokenLimitForKind('custom'), 500); // 2000 / 4
  assert.equal(v12TokenLimitForLabel('human'), 1024);
  assert.equal(v12TokenLimitForLabel('so-thich-an-uong'), 500);
  assert.equal(v12TokenLimitForLabel('HUMAN'), 1024); // label slugified
});

test('tokens: v12TokenLimitForBlock prefers the block own charLimit', () => {
  assert.equal(v12TokenLimitForBlock({ label: 'human', charLimit: 4000 }), 1000);
  assert.equal(v12TokenLimitForBlock({ label: 'custom-x', charLimit: 100 }), 25);
  assert.equal(v12TokenLimitForBlock({ label: 'custom-x', charLimit: 0 }), 500);
});

test('tokens: v12BlockTokenUsage states + overTokenLimit', () => {
  const empty = v12BlockTokenUsage(fakeBlock('human', '', 4096));
  assert.equal(empty.tokens, 0);
  assert.equal(empty.tokenLimit, 1024);
  assert.equal(empty.state, 'ok');
  assert.equal(empty.overTokenLimit, false);

  // ~75% full -> 'warm': 768 tokens of 'a' words need a long word run;
  // use repeated short words: 'ab ' ~ 1 token per word, 768 words.
  const warmContent = 'ab '.repeat(768);
  const warm = v12BlockTokenUsage(fakeBlock('task', warmContent, 4096));
  assert.ok(warm.fillRatio >= 0.7 && warm.fillRatio < 0.9, `fillRatio=${warm.fillRatio}`);
  assert.equal(warm.state, 'warm');

  // Over the kind limit -> 'full' + overTokenLimit.
  const over = v12BlockTokenUsage(fakeBlock('persona', 'ab '.repeat(600), 2048));
  assert.equal(over.tokenLimit, 512);
  assert.ok(over.tokens > 512, `tokens=${over.tokens}`);
  assert.equal(over.state, 'full');
  assert.equal(over.overTokenLimit, true);
});

test('tokens: summarizeBlocksTokens totals, over-budget, budget clamping', () => {
  const blocks = [
    fakeBlock('human', 'hello world', 4096),
    fakeBlock('persona', 'hello', 2048),
  ];
  // Tong 3 token, budget toi thieu 64 -> khong vuot.
  const under = summarizeBlocksTokens(blocks, 100);
  assert.equal(under.totalTokens, 3);
  assert.equal(under.totalChars, 'hello world'.length + 'hello'.length);
  assert.equal(under.budget, 100);
  assert.equal(under.overBudget, false);
  assert.equal(under.overLimitCount, 0);

  // Nhieu token hon budget 64 -> vuot.
  const big = [fakeBlock('task', 'ab '.repeat(100), 4096)];
  const summary = summarizeBlocksTokens(big, 64);
  assert.ok(summary.totalTokens > 64, `totalTokens=${summary.totalTokens}`);
  assert.equal(summary.budget, 64);
  assert.equal(summary.overBudget, true);

  const noBudget = summarizeBlocksTokens(blocks);
  assert.equal(noBudget.budget, undefined);
  assert.equal(noBudget.overBudget, false);

  // Budget clamps into [MIN, MAX].
  assert.equal(summarizeBlocksTokens(blocks, 1).budget, V12_MIN_TOTAL_TOKEN_BUDGET);
  assert.equal(
    summarizeBlocksTokens(blocks, 999999999).budget,
    V12_MAX_TOTAL_TOKEN_BUDGET,
  );
  assert.equal(V12_DEFAULT_TOTAL_TOKEN_BUDGET, 4000);
});

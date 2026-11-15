/**
 * Tests for the context-window-aware router (packages/core/src/router/contextWindow.ts).
 *
 * Covers model window resolution (exact model → family → provider
 * default → fallback), strategy selection by usage ratio
 * (none / summarize-oldest / compress / truncate-hard), pressure
 * assessment (usable window = window − reserve, headroom), budget
 * planning (system/memory/history/reserve split sums to window),
 * larger-window target suggestion, and the full per-turn assessment
 * (assessTurnContext).
 *
 * Run after building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/router-context-window-v107.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CONTEXT_STRATEGY_THRESHOLDS,
  assessContextPressure,
  assessTurnContext,
  chooseCompactionStrategy,
  contextWindowForTarget,
  estimateTokensFromChars,
  normalizeModelId,
  planContextBudget,
  resolveContextWindow,
  suggestLargerWindowTarget,
} from '../packages/core/dist/router/contextWindow.js';

function target(overrides = {}) {
  return { id: 't1', providerId: 'anthropic', model: 'claude-sonnet-4-5', kind: 'api', ...overrides };
}

test('context-window: normalizeModelId bỏ tag Ollama + hậu tố ngày', () => {
  assert.equal(normalizeModelId('qwen2.5:0.5b'), 'qwen2.5');
  assert.equal(normalizeModelId('claude-sonnet-4-5-20250929'), 'claude-sonnet-4-5');
  assert.equal(normalizeModelId('GPT-5-Chat-Latest'), 'gpt-5-chat-latest');
  assert.equal(normalizeModelId('  gemini-2.5-flash  '), 'gemini-2.5-flash');
});

test('context-window: resolve — model chính xác trước, rồi họ, rồi provider, rồi fallback', () => {
  assert.deepEqual(
    { tokens: resolveContextWindow('claude-sonnet-4-5', 'anthropic').windowTokens, source: resolveContextWindow('claude-sonnet-4-5', 'anthropic').source },
    { tokens: 1_000_000, source: 'exact-model' },
  );
  assert.equal(resolveContextWindow('claude-haiku-4-5', 'anthropic').windowTokens, 200_000);
  // Model chưa có trong bảng nhưng thuộc họ đã biết → family.
  const dated = resolveContextWindow('claude-sonnet-4-5-20250929', 'anthropic');
  assert.equal(dated.windowTokens, 1_000_000);
  assert.equal(dated.source, 'exact-model');
  const future = resolveContextWindow('claude-sonnet-9-9', 'anthropic');
  assert.equal(future.windowTokens, 1_000_000);
  assert.equal(future.source, 'model-family');
  // Model lạ + provider biết → provider default (gemini 1M theo targets.ts).
  const byProvider = resolveContextWindow('some-future-model', 'gemini');
  assert.equal(byProvider.windowTokens, 1_000_000);
  assert.equal(byProvider.source, 'provider-default');
  // Model lạ + provider lạ → fallback 128k, không throw.
  const fallback = resolveContextWindow('some-future-model', 'no-such-provider');
  assert.equal(fallback.windowTokens, 128_000);
  assert.equal(fallback.source, 'fallback');
  assert.equal(resolveContextWindow('', undefined).windowTokens, 128_000);
});

test('context-window: bảng model — Claude 1M trừ Haiku, GPT-5 400k, Grok-4 256k', () => {
  assert.equal(resolveContextWindow('claude-opus-4-5').windowTokens, 1_000_000);
  assert.equal(resolveContextWindow('claude-haiku-3-5').windowTokens, 200_000);
  assert.equal(resolveContextWindow('gpt-5').windowTokens, 400_000);
  assert.equal(resolveContextWindow('gpt-4o').windowTokens, 128_000);
  assert.equal(resolveContextWindow('gpt-4.1').windowTokens, 1_000_000);
  assert.equal(resolveContextWindow('gemini-2.5-pro').windowTokens, 1_000_000);
  assert.equal(resolveContextWindow('grok-4').windowTokens, 256_000);
  assert.equal(resolveContextWindow('grok-3').windowTokens, 131_072);
  assert.equal(resolveContextWindow('qwen2.5:7b').windowTokens, 32_768);
  assert.equal(resolveContextWindow('llama3.1:8b').windowTokens, 128_000);
});

test('context-window: contextWindowForTarget tôn trọng contextLimit của đích', () => {
  const resolved = contextWindowForTarget(target({ contextLimit: 500_000 }));
  assert.equal(resolved.windowTokens, 500_000);
  const fromModel = contextWindowForTarget(target({ contextLimit: undefined }));
  assert.equal(fromModel.windowTokens, 1_000_000);
  assert.equal(fromModel.source, 'exact-model');
});

test('context-window: chooseCompactionStrategy theo ngưỡng 70/85/95%', () => {
  assert.equal(CONTEXT_STRATEGY_THRESHOLDS.summarizeAt, 0.7);
  assert.equal(CONTEXT_STRATEGY_THRESHOLDS.compressAt, 0.85);
  assert.equal(CONTEXT_STRATEGY_THRESHOLDS.truncateAt, 0.95);
  assert.equal(chooseCompactionStrategy(0), 'none');
  assert.equal(chooseCompactionStrategy(0.69), 'none');
  assert.equal(chooseCompactionStrategy(0.7), 'summarize-oldest');
  assert.equal(chooseCompactionStrategy(0.84), 'summarize-oldest');
  assert.equal(chooseCompactionStrategy(0.85), 'compress');
  assert.equal(chooseCompactionStrategy(0.94), 'compress');
  assert.equal(chooseCompactionStrategy(0.95), 'truncate-hard');
  assert.equal(chooseCompactionStrategy(1.5), 'truncate-hard');
  assert.equal(chooseCompactionStrategy(Number.NaN), 'none');
});

test('context-window: assessContextPressure đo trên window khả dụng (window − reserve)', () => {
  const calm = assessContextPressure({ usedTokens: 50_000, windowTokens: 200_000, reserveTokens: 4_000 });
  assert.equal(calm.strategy, 'none');
  assert.equal(calm.needsCompaction, false);
  assert.equal(calm.usableTokens, 196_000);
  assert.equal(calm.headroomTokens, 146_000);
  assert.ok(calm.usageRatio < 0.7);

  const warn = assessContextPressure({ usedTokens: 140_000, windowTokens: 200_000, reserveTokens: 4_000 });
  assert.equal(warn.strategy, 'summarize-oldest');
  assert.match(warn.reason, /tóm tắt/);

  const hot = assessContextPressure({ usedTokens: 175_000, windowTokens: 200_000, reserveTokens: 4_000 });
  assert.equal(hot.strategy, 'compress');
  assert.match(hot.reason, /nén toàn bộ/);

  const full = assessContextPressure({ usedTokens: 195_000, windowTokens: 200_000, reserveTokens: 4_000 });
  assert.equal(full.strategy, 'truncate-hard');
  assert.equal(full.needsCompaction, true);
  assert.match(full.reason, /cắt lịch sử cũ/);

  const over = assessContextPressure({ usedTokens: 250_000, windowTokens: 200_000 });
  assert.equal(over.strategy, 'truncate-hard');
  assert.ok(over.headroomTokens < 0);

  const unknown = assessContextPressure({ usedTokens: 10, windowTokens: 0 });
  assert.equal(unknown.strategy, 'truncate-hard');
  assert.match(unknown.reason, /Không biết context window/);
});

test('context-window: planContextBudget chia đủ window, history không âm', () => {
  const plan = planContextBudget(1_000_000);
  assert.equal(plan.totalTokens, 1_000_000);
  // Reserve mặc định 4000 bị kẹp lên tối thiểu 2% window = 20.000.
  assert.equal(plan.reserveTokens, 20_000);
  assert.equal(plan.systemTokens, 120_000);
  assert.equal(plan.memoryTokens, 200_000);
  assert.equal(plan.historyTokens, 660_000);

  const small = planContextBudget(8_000);
  assert.equal(small.totalTokens, 8_000);
  assert.ok(small.historyTokens >= 0);
  assert.ok(small.reserveTokens >= 160 && small.reserveTokens <= 960);

  const zero = planContextBudget(0);
  assert.deepEqual(zero, { windowTokens: 0, reserveTokens: 0, systemTokens: 0, memoryTokens: 0, historyTokens: 0, totalTokens: 0 });
});

test('context-window: suggestLargerWindowTarget chỉ gợi ý khi lớn hơn ≥25%', () => {
  const current = target({ id: 'cur', model: 'gpt-4o', providerId: 'openai' }); // 128k
  const candidates = [
    target({ id: 'same', model: 'gpt-4o', providerId: 'openai' }),
    target({ id: 'small-gain', model: 'grok-3', providerId: 'xai' }), // 131k — tăng <25%
    target({ id: 'big', model: 'claude-sonnet-4-5', providerId: 'anthropic' }), // 1M
    target({ id: 'mid', model: 'gpt-5', providerId: 'openai' }), // 400k
  ];
  const best = suggestLargerWindowTarget(current, candidates);
  assert.equal(best?.target.id, 'big');
  assert.equal(best?.windowTokens, 1_000_000);
  assert.ok((best?.gainRatio ?? 0) > 7);

  const alreadyBig = target({ id: 'cur', model: 'claude-sonnet-4-5', providerId: 'anthropic' });
  assert.equal(suggestLargerWindowTarget(alreadyBig, candidates), null);
  assert.equal(suggestLargerWindowTarget(current, []), null);
});

test('context-window: assessTurnContext gộp resolve + áp lực + gợi ý đích lớn', () => {
  const current = target({ id: 'cur', model: 'gpt-4o', providerId: 'openai' });
  const big = target({ id: 'big', model: 'gemini-2.5-pro', providerId: 'gemini' });
  const calm = assessTurnContext(current, 10_000, [big]);
  assert.equal(calm.strategy, 'none');
  assert.equal(calm.resolved.windowTokens, 128_000);
  assert.equal(calm.budget.totalTokens, 128_000);
  assert.equal(calm.largerWindowSuggestion, null);

  const full = assessTurnContext(current, 125_000, [big]);
  assert.equal(full.strategy, 'truncate-hard');
  assert.equal(full.largerWindowSuggestion?.target.id, 'big');
  assert.equal(full.largerWindowSuggestion?.windowTokens, 1_000_000);
});

test('context-window: estimateTokensFromChars 4 ký tự ≈ 1 token', () => {
  assert.equal(estimateTokensFromChars(0), 0);
  assert.equal(estimateTokensFromChars(400), 100);
  assert.equal(estimateTokensFromChars(401), 101);
  assert.equal(estimateTokensFromChars(-5), 0);
});

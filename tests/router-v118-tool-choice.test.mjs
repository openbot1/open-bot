/**
 * Router local v118 — tool_choice theo provider moi + request params
 * (v1.41, Doi T3, node:test).
 *
 * Covers (thuan, khong model that, khong network):
 * - Ma tran: Claude lon 5.5/Fable/Mythos chi auto/none; Claude 4.x
 *   van any/tool; Ollama khong co tool_choice; Gemini ha tool->any;
 *   DeepSeek ha any->auto; provider chua biet fail-closed.
 * - resolveToolChoice: ep + ly do + canh bao; tool thieu ten;
 *   toolCount vuot maxTools; model pattern dai nhat thang.
 * - buildProviderRequestParams: loai temperature/top_p/top_k o API
 *   >= 2026-10-21 (ke ca gia tri mac dinh); giu lai o API cu;
 *   beta inline-tools chi khi provider ho tro; Ollama none -> khong
 *   gui tools.
 * - Bo phan loai loi 400: tool_choice / sampling / fingerprint.
 *
 * Imports the BUILT core — build first:
 *   npm run build --workspace=@open-bot/core
 * then: node --test tests/router-v118-tool-choice.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  INLINE_TOOLS_BETA,
  PROVIDER_TOOL_CHOICE_MATRIX,
  ROUTER_V118_PROVIDER_IDS,
  buildProviderRequestParams,
  compareApiVersion,
  effectiveCapability,
  isSamplingParam400Error,
  isToolChoice400Error,
  modelPatternMatches,
  resolveToolChoice,
  samplingParamsRemoved,
  summarizeCapabilityMatrix,
} from '../packages/core/dist/router/local/toolChoiceV118.js';
import { isThreadFingerprintMismatchError } from '../packages/core/dist/router/local/inlineToolsV118.js';

test('matrix: du 10 provider, Claude lon chi auto/none', () => {
  assert.equal(ROUTER_V118_PROVIDER_IDS.length, 10);
  for (const id of ROUTER_V118_PROVIDER_IDS) {
    const entry = PROVIDER_TOOL_CHOICE_MATRIX[id];
    assert.ok(entry, `missing matrix entry ${id}`);
    assert.ok(entry.capability.allowedModes.length > 0);
    assert.ok(entry.capability.maxTools > 0);
  }
  for (const model of ['claude-opus-5-1', 'claude-sonnet-5-5', 'claude-fable-1', 'claude-mythos-2']) {
    const cap = effectiveCapability('anthropic', model);
    assert.deepEqual(cap.allowedModes, ['auto', 'none'], model);
  }
  for (const model of ['claude-opus-4-1', 'claude-sonnet-4-5']) {
    const cap = effectiveCapability('anthropic', model);
    assert.ok(cap.allowedModes.includes('any'), model);
    assert.ok(cap.allowedModes.includes('tool'), model);
  }
  // Pattern dai nhat thang: opus-5-1 khop ca 'claude-opus-5*' (khong
  // co pattern chung hon) — kiem tra rieng bang modelPatternMatches.
  assert.equal(modelPatternMatches('claude-opus-5*', 'claude-opus-5-1'), true);
  assert.equal(modelPatternMatches('claude-opus-5*', 'claude-opus-4-1'), false);
  assert.equal(modelPatternMatches('claude-sonnet-4*', 'Claude-Sonnet-4-5'), true);
  assert.equal(modelPatternMatches('gpt-5*', 'gpt-5-mini'), true);
});

test('resolve: Claude lon ep any/tool xuong auto kem ly do 400', () => {
  const any = resolveToolChoice({ provider: 'anthropic', modelId: 'claude-sonnet-5-5', requested: 'any' });
  assert.equal(any.enforced, 'auto');
  assert.equal(any.changed, true);
  assert.equal(any.normalized.type, 'auto');
  assert.ok(any.reasons.join(' ').includes('400'));
  assert.ok(any.warnings.length >= 1);

  const tool = resolveToolChoice({ provider: 'anthropic', modelId: 'claude-opus-5-1', requested: 'tool', toolName: 'search' });
  assert.equal(tool.enforced, 'auto');

  const ok = resolveToolChoice({ provider: 'anthropic', modelId: 'claude-sonnet-4-5', requested: 'tool', toolName: 'search' });
  assert.equal(ok.enforced, 'tool');
  assert.deepEqual(ok.normalized, { type: 'tool', name: 'search' });
  assert.equal(ok.changed, false);
});

test('resolve: Ollama/Gemini/DeepSeek/unknown fail-closed dung quy tac', () => {
  const ollama = resolveToolChoice({ provider: 'ollama', modelId: 'qwen3-4b', requested: 'tool', toolName: 'x' });
  assert.equal(ollama.enforced, 'auto');
  assert.equal(ollama.parallelCalls, false);
  assert.ok(ollama.warnings.some((w) => w.includes('none')) || ollama.reasons.length > 0);

  const ollamaNone = resolveToolChoice({ provider: 'ollama', modelId: 'qwen3-4b', requested: 'none' });
  assert.equal(ollamaNone.enforced, 'auto');
  assert.ok(ollamaNone.warnings.some((w) => w.includes('không gửi "tools"') || w.includes('khong gui')));

  const gemini = resolveToolChoice({ provider: 'gemini', modelId: 'gemini-2.5-flash', requested: 'tool', toolName: 'search' });
  assert.equal(gemini.enforced, 'any');
  assert.ok(gemini.reasons.join(' ').includes('allowed_function_names'));

  const deepseek = resolveToolChoice({ provider: 'deepseek', modelId: 'deepseek-chat', requested: 'any' });
  assert.equal(deepseek.enforced, 'auto');

  const unknown = resolveToolChoice({ provider: 'no-such-provider', modelId: 'm', requested: 'tool', toolName: 'x' });
  assert.equal(unknown.enforced, 'auto');
  assert.equal(unknown.maxTools, 32);
  assert.equal(unknown.parallelCalls, false);
});

test('resolve: tool thieu ten + vuot maxTools', () => {
  const noName = resolveToolChoice({ provider: 'openai', modelId: 'gpt-5-mini', requested: 'tool' });
  assert.equal(noName.enforced, 'any');
  assert.ok(noName.warnings.length >= 1);

  const over = resolveToolChoice({ provider: 'openai', modelId: 'gpt-5-mini', requested: 'auto', toolCount: 200 });
  assert.equal(over.toolCountOk, false);
  assert.ok(over.warnings.some((w) => w.includes('200')));

  const under = resolveToolChoice({ provider: 'openai', modelId: 'gpt-5-mini', requested: 'auto', toolCount: 10 });
  assert.equal(under.toolCountOk, true);

  // Khong chi dinh requested -> dung default cua provider (auto).
  const def = resolveToolChoice({ provider: 'openai', modelId: 'gpt-5-mini' });
  assert.equal(def.requested, 'auto');
  assert.equal(def.enforced, 'auto');
});

test('api version: so sanh + sampling bi bo tu 2026-10-21', () => {
  assert.equal(compareApiVersion('2026-10-21', '2026-10-21'), 0);
  assert.ok(compareApiVersion('2026-10-22', '2026-10-21') > 0);
  assert.ok(compareApiVersion('2026-09-01', '2026-10-21') < 0);
  assert.equal(samplingParamsRemoved('anthropic', 'claude-sonnet-5-5', '2026-10-21'), true);
  assert.equal(samplingParamsRemoved('anthropic', 'claude-sonnet-5-5', '2026-10-22'), true);
  assert.equal(samplingParamsRemoved('anthropic', 'claude-sonnet-5-5', '2026-09-01'), false);
  assert.equal(samplingParamsRemoved('anthropic', 'claude-sonnet-5-5', ''), false);
  // OpenAI khong khai bao bo sampling -> khong loai.
  assert.equal(samplingParamsRemoved('openai', 'gpt-5-mini', '2026-10-21'), false);
});

test('build params: loai sampling o API moi, giu o API cu', () => {
  const dropped = buildProviderRequestParams({
    provider: 'anthropic',
    modelId: 'claude-sonnet-5-5',
    apiVersion: '2026-10-21',
    toolChoice: 'any',
    temperature: 0.7,
    topP: 0.9,
    topK: 40,
    maxTokens: 1024,
  });
  assert.equal(dropped.toolChoice.enforced, 'auto');
  assert.deepEqual(dropped.sampling, {});
  assert.deepEqual(
    dropped.droppedSamplingParams.map((d) => d.name).sort(),
    ['temperature', 'top_k', 'top_p'],
  );
  assert.equal(dropped.maxTokens, 1024);
  assert.ok(dropped.warnings.length >= 3);

  // Ca khi de gia tri mac dinh (temperature 1.0) van bi loai.
  const defaults = buildProviderRequestParams({
    provider: 'anthropic',
    modelId: 'claude-opus-5-1',
    apiVersion: '2026-10-21',
    temperature: 1,
    topP: 1,
    topK: 0,
  });
  assert.equal(defaults.droppedSamplingParams.length, 3);

  const kept = buildProviderRequestParams({
    provider: 'anthropic',
    modelId: 'claude-sonnet-4-5',
    apiVersion: '2025-01-01',
    temperature: 0.7,
    topP: 0.9,
  });
  assert.equal(kept.sampling.temperature, 0.7);
  assert.equal(kept.sampling.topP, 0.9);
  assert.equal(kept.droppedSamplingParams.length, 0);
});

test('build params: beta inline-tools + Ollama none', () => {
  const anthropic = buildProviderRequestParams({
    provider: 'anthropic',
    modelId: 'claude-sonnet-5-5',
    betaHeaders: [INLINE_TOOLS_BETA],
  });
  assert.deepEqual(anthropic.betaHeaders, [INLINE_TOOLS_BETA]);

  const openai = buildProviderRequestParams({
    provider: 'openai',
    modelId: 'gpt-5-mini',
    betaHeaders: [INLINE_TOOLS_BETA],
  });
  assert.deepEqual(openai.betaHeaders, []);
  assert.ok(openai.warnings.some((w) => w.includes(INLINE_TOOLS_BETA)));

  const ollamaNone = buildProviderRequestParams({
    provider: 'ollama',
    modelId: 'qwen3-4b',
    toolChoice: 'none',
    tools: [{ name: 'a' }],
  });
  assert.equal(ollamaNone.includeTools, false);

  const openaiNone = buildProviderRequestParams({
    provider: 'openai',
    modelId: 'gpt-5-mini',
    toolChoice: 'none',
    tools: [{ name: 'a' }],
  });
  assert.equal(openaiNone.includeTools, true);
  assert.equal(openaiNone.toolChoice.enforced, 'none');
});

test('classify 400: tool_choice / sampling / fingerprint', () => {
  assert.equal(isToolChoice400Error(400, 'tool_choice "any" is not supported for this model'), true);
  assert.equal(isToolChoice400Error(400, 'invalid tool_choice'), true);
  assert.equal(isToolChoice400Error(400, 'temperature is not supported'), false);
  assert.equal(isToolChoice400Error(500, 'tool_choice not supported'), false);

  assert.equal(isSamplingParam400Error(400, 'temperature is not supported in API version 2026-10-21'), true);
  assert.equal(isSamplingParam400Error(400, 'top_p parameter was removed'), true);
  assert.equal(isSamplingParam400Error(400, 'top_k unknown parameter'), true);
  assert.equal(isSamplingParam400Error(400, 'tool_choice any not supported'), false);

  assert.equal(isThreadFingerprintMismatchError(400, 'thread_fingerprint_mismatch: tools changed'), true);
  assert.equal(isThreadFingerprintMismatchError(409, 'thread_fingerprint_mismatch'), true);
  assert.equal(isThreadFingerprintMismatchError(400, 'something else'), false);
});

test('matrix summary: markdown co du provider', () => {
  const summary = summarizeCapabilityMatrix();
  for (const id of ROUTER_V118_PROVIDER_IDS) {
    assert.ok(summary.includes(id), id);
  }
  assert.ok(summary.includes('| Provider |'));
  assert.ok(summary.includes('auto/none'));
});

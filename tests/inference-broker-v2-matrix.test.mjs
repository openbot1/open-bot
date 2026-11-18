/**
 * Inference broker v2 matrix + routing tests (v1.33, Doi T5 — node:test,
 * no network, no GPU, no real model).
 *
 * Covers packages/core/src/inferenceBrokerV2/capabilityMatrix.ts:
 * - Capability matrix 4 engine: ports, tool_choice / strict, structured
 *   output, context toi thieu cho agent, batching.
 * - Task requirements mac dinh theo loai task (coding -> tool calling
 *   native + context >= 64k; extract -> grammar-constrained).
 * - Score + rank + route: coding chon engine co strict; extract uu
 *   tien grammar; batch uu tien throughput; fallback Ollama ->
 *   llama.cpp khi can strict/tool_choice.
 * - Model tren engine: native tool calling theo ho model, context
 *   hieu dung, agent-ready, pickModelForTask.
 *
 * Imports the BUILT core — build first:
 *   npm run build --workspace=@open-bot/core
 * then: node --test tests/inference-broker-v2-matrix.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  INFERENCE_BROKER_V2_ENGINES,
  INFERENCE_BROKER_V2_ENGINE_CAPABILITY,
  capabilityForModelOnEngineV2,
  defaultRequirementsForTaskKind,
  fallbackEngineForV2,
  inferenceBrokerV2CapabilityFor,
  inferenceBrokerV2DefaultBaseUrl,
  inferenceBrokerV2DefaultPort,
  inferenceBrokerV2EngineLabel,
  inferenceBrokerV2MatrixMarkdown,
  listInferenceBrokerV2Capabilities,
  modelHasNativeToolCallingOnEngine,
  pickModelForTaskV2,
  rankInferenceBrokerV2Engines,
  requirementsForTask,
  routeTaskToEngineV2,
  scoreInferenceBrokerV2Engine,
} from '../packages/core/dist/inferenceBrokerV2/capabilityMatrix.js';

// ---------------------------------------------------------------------------
// Matrix khai bao
// ---------------------------------------------------------------------------

test('matrix: du 4 engine, port + base URL mac dinh dung', () => {
  assert.deepEqual([...INFERENCE_BROKER_V2_ENGINES], ['ollama', 'llamacpp', 'vllm', 'sglang']);
  assert.equal(inferenceBrokerV2DefaultPort('ollama'), 11434);
  assert.equal(inferenceBrokerV2DefaultPort('llamacpp'), 8080);
  assert.equal(inferenceBrokerV2DefaultPort('vllm'), 8000);
  assert.equal(inferenceBrokerV2DefaultPort('sglang'), 30000);
  assert.equal(inferenceBrokerV2DefaultBaseUrl('ollama'), 'http://localhost:11434');
  assert.equal(inferenceBrokerV2DefaultBaseUrl('sglang'), 'http://localhost:30000');
  assert.equal(inferenceBrokerV2EngineLabel('llamacpp'), 'llama.cpp');
  assert.equal(inferenceBrokerV2EngineLabel('vllm'), 'vLLM');
  assert.equal(listInferenceBrokerV2Capabilities().length, 4);
});

test('matrix: Ollama KHONG co tool_choice / strict — phai fallback sang llama.cpp', () => {
  const ollama = INFERENCE_BROKER_V2_ENGINE_CAPABILITY.ollama;
  assert.equal(ollama.toolCalling.supported, true);
  assert.equal(ollama.toolCalling.toolChoiceSupported, false);
  assert.equal(ollama.toolCalling.strictMode, false);
  assert.equal(ollama.minContextForAgent, 64_000);
  assert.equal(ollama.batching.recommendedMaxConcurrentUsers, 5);
  assert.equal(fallbackEngineForV2('ollama', 'missing-tool-choice'), 'llamacpp');
  assert.equal(fallbackEngineForV2('ollama', 'missing-strict'), 'llamacpp');
  assert.equal(fallbackEngineForV2('vllm', 'missing-strict'), undefined);
});

test('matrix: llama.cpp can --jinja, parallel TAT mac dinh, KV quant lam hong tool call', () => {
  const cpp = INFERENCE_BROKER_V2_ENGINE_CAPABILITY.llamacpp;
  assert.equal(cpp.toolCalling.enableFlag, '--jinja');
  assert.equal(cpp.toolCalling.parallelCalls, true);
  assert.equal(cpp.toolCalling.parallelByDefault, false);
  assert.equal(cpp.toolCalling.strictMode, true);
  assert.equal(cpp.structuredOutput.gbnfGrammar, true);
  assert.match(cpp.toolCalling.reliabilityNote, /KV cache/);
  assert.match(cpp.knownLimits.join(' '), /KV cache/);
});

test('matrix: vLLM can parser + strict, forced call chi dam bao parse duoc', () => {
  const vllm = INFERENCE_BROKER_V2_ENGINE_CAPABILITY.vllm;
  assert.deepEqual([...vllm.toolCalling.parserChoices], ['hermes', 'llama3_json', 'openai']);
  assert.equal(vllm.toolCalling.strictMode, true);
  assert.equal(vllm.batching.continuousBatching, true);
  assert.equal(vllm.batching.chunkedPrefill, true);
  assert.equal(vllm.batching.prefixCaching, true);
  assert.equal(vllm.recommendedMaxContext, 262_144);
  assert.match(vllm.toolCalling.reliabilityNote, /KHONG dam bao dung/);
  assert.match(vllm.toolCalling.enableFlag, /--enable-auto-tool-choice/);
});

test('matrix: SGLang RadixAttention + disaggregated prefill/decode, structured output first-class', () => {
  const sglang = INFERENCE_BROKER_V2_ENGINE_CAPABILITY.sglang;
  assert.equal(sglang.batching.kind, 'disaggregated-prefill-decode');
  assert.equal(sglang.batching.prefixCaching, true);
  assert.equal(sglang.structuredOutput.jsonSchema, true);
  assert.match(sglang.batching.note, /RadixAttention/);
  assert.equal(sglang.minContextForAgent, 64_000);
});

test('matrix: capabilityFor tra ban sao — sua khong anh huong goc', () => {
  const a = inferenceBrokerV2CapabilityFor('ollama');
  a.knownLimits.push('x');
  a.toolCalling.strictMode = true;
  const b = inferenceBrokerV2CapabilityFor('ollama');
  assert.equal(b.toolCalling.strictMode, false);
  assert.ok(!b.knownLimits.includes('x'));
});

test('matrix: markdown tom tat du 4 engine + canh bao khai bao', () => {
  const md = inferenceBrokerV2MatrixMarkdown();
  for (const label of ['Ollama', 'llama.cpp', 'vLLM', 'SGLang']) {
    assert.match(md, new RegExp(label.replace('.', '\\.')));
  }
  assert.match(md, /KHONG/);
  assert.match(md, /KHAI BAO/);
});

// ---------------------------------------------------------------------------
// Yeu cau theo loai task
// ---------------------------------------------------------------------------

test('task requirements: coding can tool calling native + context >= 64k', () => {
  const req = defaultRequirementsForTaskKind('coding');
  assert.equal(req.needsToolCalling, true);
  assert.equal(req.needsStrictToolCalling, true);
  assert.equal(req.needsParallelCalls, true);
  assert.equal(req.minContext, 64_000);
  assert.equal(req.multiTurn, true);
});

test('task requirements: extract can grammar, khong can tool calling', () => {
  const req = defaultRequirementsForTaskKind('extract');
  assert.equal(req.needsGrammar, true);
  assert.equal(req.needsToolCalling, false);
});

test('task requirements: overrides thang mac dinh loai task', () => {
  const req = requirementsForTask('chat', { minContext: 128_000, preferThroughput: true });
  assert.equal(req.kind, 'chat');
  assert.equal(req.minContext, 128_000);
  assert.equal(req.preferThroughput, true);
  assert.equal(req.latencySensitive, true);
});

// ---------------------------------------------------------------------------
// Score / rank / route
// ---------------------------------------------------------------------------

test('score: coding — Ollama khong eligible vi thieu strict', () => {
  const req = defaultRequirementsForTaskKind('coding');
  const ollama = scoreInferenceBrokerV2Engine('ollama', req);
  assert.equal(ollama.eligible, false);
  assert.ok(ollama.missing.includes('strict tool-calling'));
  assert.equal(ollama.score, 0);
  const cpp = scoreInferenceBrokerV2Engine('llamacpp', req);
  assert.equal(cpp.eligible, true);
  assert.ok(cpp.score > 0 && cpp.score <= 1);
});

test('score: probe that bai ghi de khai bao — engine khai tot van bi loai', () => {
  const req = defaultRequirementsForTaskKind('coding');
  const vllm = scoreInferenceBrokerV2Engine('vllm', req, {
    probedToolCallWorks: false,
    probedStrictWorks: false,
  });
  assert.equal(vllm.eligible, false);
  assert.ok(vllm.missing.some((m) => m.includes('probe')));
});

test('rank: coding xep engine co strict truoc Ollama', () => {
  const ranked = rankInferenceBrokerV2Engines(defaultRequirementsForTaskKind('coding'));
  assert.equal(ranked[0].eligible, true);
  assert.notEqual(ranked[0].engine, 'ollama');
  const ollamaRank = ranked.findIndex((r) => r.engine === 'ollama');
  assert.ok(ollamaRank > 0);
});

test('rank: extract — engine co grammar deu eligible, llama.cpp (GBNF) diem cao', () => {
  const ranked = rankInferenceBrokerV2Engines(defaultRequirementsForTaskKind('extract'));
  assert.ok(ranked.every((r) => r.eligible));
  const cpp = ranked.find((r) => r.engine === 'llamacpp');
  assert.ok(cpp && cpp.breakdown.structured >= 0.9);
});

test('rank: batch uu tien throughput — vLLM dung dau', () => {
  const ranked = rankInferenceBrokerV2Engines(defaultRequirementsForTaskKind('batch'));
  assert.equal(ranked[0].engine, 'vllm');
});

test('route: coding co fallback chain, primary khong phai Ollama', () => {
  const routed = routeTaskToEngineV2(defaultRequirementsForTaskKind('coding'));
  assert.ok(routed.primary);
  assert.notEqual(routed.primary.engine, 'ollama');
  assert.ok(routed.fallbackChain.length >= 1);
  assert.match(routed.reason, /Chon/);
});

test('route: probe that bai loai engine khoi primary', () => {
  const routed = routeTaskToEngineV2(defaultRequirementsForTaskKind('coding'), undefined, {
    llamacpp: { toolCallWorks: false, strictWorks: false },
    vllm: { toolCallWorks: false, strictWorks: false },
    sglang: { toolCallWorks: false, strictWorks: false },
  });
  // Ca 3 engine strict deu probe hong -> primary la engine tot nhat
  // hien co (khong eligible) + reason noi ro khong engine nao dat.
  assert.ok(routed.primary);
  assert.equal(routed.primary.eligible, false);
  assert.match(routed.reason, /Khong engine nao dat/);
});

test('route: task chat don gian — Ollama eligible (khong can strict)', () => {
  const routed = routeTaskToEngineV2(defaultRequirementsForTaskKind('chat'));
  assert.ok(routed.primary);
  assert.equal(routed.primary.eligible, true);
});

test('route: chi 1 ung vien — fallback rong, reason noi ro', () => {
  const routed = routeTaskToEngineV2(defaultRequirementsForTaskKind('chat'), ['ollama']);
  assert.equal(routed.primary?.engine, 'ollama');
  assert.deepEqual(routed.fallbackChain, []);
});

// ---------------------------------------------------------------------------
// Model tren engine
// ---------------------------------------------------------------------------

test('model on engine: qwen3 co native tool calling tren llama.cpp + ollama', () => {
  assert.equal(modelHasNativeToolCallingOnEngine('qwen3:8b', 'llamacpp'), true);
  assert.equal(modelHasNativeToolCallingOnEngine('qwen3:8b', 'ollama'), true);
  assert.equal(modelHasNativeToolCallingOnEngine('llava:7b', 'llamacpp'), false);
});

test('model on engine: qwen3:8b agent-ready tren vLLM (context lon, tool calling native)', () => {
  const m = capabilityForModelOnEngineV2('qwen3:8b', 'vllm');
  assert.equal(m.nativeToolCalling, true);
  assert.ok(m.effectiveContext >= 64_000);
  assert.equal(m.agentReady, true);
  assert.equal(m.notReadyReason, undefined);
});

test('model on engine: gpt-oss:20b CHUA agent-ready — routerV3 suy context 32k (gioi han co san, khong phai loi broker)', () => {
  // gpt-oss that co context 131k, nhung bang routerV3 khong co muc nay
  // nen suy 32k -> effectiveContext 32768 < 64000. Broker bao dung that
  // chu khong doan mo context lon hon.
  const m = capabilityForModelOnEngineV2('gpt-oss:20b', 'vllm');
  assert.equal(m.nativeToolCalling, true);
  assert.equal(m.effectiveContext, 32_768);
  assert.equal(m.agentReady, false);
  assert.match(m.notReadyReason ?? '', /32768 < 64000/);
});

test('model on engine: llava khong agent-ready (khong tool calling)', () => {
  const m = capabilityForModelOnEngineV2('llava:7b', 'ollama');
  assert.equal(m.agentReady, false);
  assert.match(m.notReadyReason ?? '', /tool-calling/);
});

test('model on engine: context hieu dung = min(context model, context engine)', () => {
  const m = capabilityForModelOnEngineV2('qwen2.5:0.5b', 'ollama');
  // qwen2.5: context model 32k < context engine 131k -> hieu dung 32k.
  assert.equal(m.effectiveContext, 32_768);
  assert.equal(m.agentReady, false);
});

test('pickModelForTask: coding chon model agent-ready, bo qua llava', () => {
  const picked = pickModelForTaskV2(defaultRequirementsForTaskKind('coding'), [
    { modelId: 'llava:7b', engine: 'ollama' },
    { modelId: 'qwen3:8b', engine: 'ollama' },
    { modelId: 'qwen3:8b', engine: 'llamacpp' },
  ]);
  assert.ok(picked);
  assert.equal(picked.modelId, 'qwen3:8b');
  assert.ok(picked.score > 0);
});

test('pickModelForTask: khong model nao dat -> undefined', () => {
  const picked = pickModelForTaskV2(defaultRequirementsForTaskKind('coding'), [
    { modelId: 'llava:7b', engine: 'ollama' },
  ]);
  assert.equal(picked, undefined);
});

test('pickModelForTask: vision loai model khong co vision', () => {
  const picked = pickModelForTaskV2(defaultRequirementsForTaskKind('vision'), [
    { modelId: 'qwen3:8b', engine: 'ollama' },
    { modelId: 'gemma3:4b', engine: 'ollama' },
  ]);
  assert.ok(picked);
  assert.equal(picked.modelId, 'gemma3:4b');
});

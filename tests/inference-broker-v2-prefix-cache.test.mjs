/**
 * Inference broker v2 prefix-cache + broker + voice v22 tests (v1.33,
 * Doi T5 — node:test, no network, no GPU, no real model).
 *
 * Covers:
 * - prefixCache.ts: FNV-1a hash, chuan hoa message, segment prompt,
 *   lookup/store/beginTurn (full / partial / miss), hit rate do that,
 *   TTL prune, gioi han node, uoc luong token.
 * - broker.ts: route theo task, probeAll qua fetch gia, chat qua
 *   executor gia (validate tool call + retry co gioi han + fallback
 *   engine khi executor loi), dang ky model da probe vao routerV3.
 * - voiceV22.ts: mock-first (khong key -> mock), turn mock qua
 *   prefix cache, turn qua executor gia (tool call da validate),
 *   session mo/dong, stats/markdown.
 *
 * Imports the BUILT core — build first:
 *   npm run build --workspace=@open-bot/core
 * then: node --test tests/inference-broker-v2-prefix-cache.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  InferenceBrokerV2,
  VoiceV22Session,
  createInferenceBrokerV2,
  createVoiceV22Session,
  extractBlockedToolNamesV22,
  voiceV22ModeFor,
  VOICE_V22_MOCK_REASON,
} from '../packages/core/dist/inferenceBrokerV2/index.js';
import {
  InferenceBrokerV2PrefixCache,
  brokerV2EstimateTokensFromChars,
  brokerV2Fnv1aHash,
  brokerV2NormalizeCacheMessage,
  brokerV2PromptSegments,
} from '../packages/core/dist/inferenceBrokerV2/prefixCache.js';
import { UnifiedRouterV3 } from '../packages/core/dist/routerV3/routerV3.js';

const SYS = { role: 'system', content: 'Ban la tro ly.' };
const U1 = { role: 'user', content: 'Xin chao' };
const A1 = { role: 'assistant', content: 'Chao ban!' };
const U2 = { role: 'user', content: 'Tim file readme' };

// ---------------------------------------------------------------------------
// Prefix cache: hash + segment
// ---------------------------------------------------------------------------

test('prefix cache: FNV-1a on dinh + phan biet, normalize bo khoang trang thua', () => {
  assert.equal(brokerV2Fnv1aHash('abc'), brokerV2Fnv1aHash('abc'));
  assert.notEqual(brokerV2Fnv1aHash('abc'), brokerV2Fnv1aHash('abd'));
  assert.match(brokerV2Fnv1aHash('abc'), /^[0-9a-f]{8}$/);
  assert.equal(
    brokerV2NormalizeCacheMessage({ role: 'user', content: '  hello   world  ' }),
    'user||hello world',
  );
  assert.equal(
    brokerV2NormalizeCacheMessage({ role: 'tool', content: 'ok', name: 'search' }),
    'tool|search|ok',
  );
});

test('prefix cache: segments — tool defs len dau, moi message 1 segment', () => {
  const segs = brokerV2PromptSegments([SYS, U1], ['search', 'ping']);
  assert.equal(segs.length, 3);
  assert.ok(segs[0].startsWith('tools|'));
  assert.equal(brokerV2PromptSegments([SYS]).length, 1);
  assert.equal(brokerV2EstimateTokensFromChars(400), 100);
  assert.equal(brokerV2EstimateTokensFromChars(401), 101);
});

// ---------------------------------------------------------------------------
// Prefix cache: lookup / store / hit rate
// ---------------------------------------------------------------------------

test('prefix cache: miss o turn 1, full hit khi lap lai, partial khi them message', () => {
  const cache = new InferenceBrokerV2PrefixCache({ now: () => 1000 });
  const first = cache.beginTurn([SYS, U1]);
  assert.equal(first.miss, true);
  assert.equal(first.matchedSegments, 0);
  const repeat = cache.beginTurn([SYS, U1]);
  assert.equal(repeat.fullHit, true);
  assert.equal(repeat.matchedSegments, 2);
  assert.equal(repeat.hitRatio, 1);
  const longer = cache.beginTurn([SYS, U1, A1, U2]);
  assert.equal(longer.partialHit, true);
  assert.equal(longer.matchedSegments, 2);
  assert.equal(longer.totalSegments, 4);
  const stats = cache.stats();
  assert.equal(stats.lookups, 3);
  assert.equal(stats.fullHits, 1);
  assert.equal(stats.partialHits, 1);
  assert.equal(stats.misses, 1);
  assert.equal(stats.hitRate, 2 / 3);
  assert.ok(stats.charsSaved > 0);
});

test('prefix cache: thu tu khac nhau -> khong khop (prefix chi co nghia khi thu tu khop)', () => {
  const cache = new InferenceBrokerV2PrefixCache({ now: () => 1000 });
  cache.beginTurn([SYS, U1]);
  const swapped = cache.lookup([U1, SYS]);
  assert.equal(swapped.miss, true);
  assert.equal(swapped.matchedSegments, 0);
});

test('prefix cache: tool definitions khac nhau -> prefix vo (segment dau khac)', () => {
  const cache = new InferenceBrokerV2PrefixCache({ now: () => 1000 });
  cache.beginTurn([SYS], { toolDefinitions: ['search'] });
  const other = cache.lookup([SYS], { toolDefinitions: ['ping'] });
  assert.equal(other.miss, true);
  const same = cache.lookup([SYS], { toolDefinitions: ['search'] });
  assert.equal(same.fullHit, true);
});

test('prefix cache: lookup khong ghi — 2 lookup lien tiep deu miss neu chua store', () => {
  const cache = new InferenceBrokerV2PrefixCache({ now: () => 1000 });
  assert.equal(cache.lookup([SYS, U1]).miss, true);
  assert.equal(cache.lookup([SYS, U1]).miss, true);
  assert.equal(cache.size, 0);
  cache.store([SYS, U1]);
  assert.equal(cache.size, 2);
  assert.equal(cache.lookup([SYS, U1]).fullHit, true);
});

test('prefix cache: TTL het han -> lookup miss (node cu khong dung nua)', () => {
  let now = 1000;
  const cache = new InferenceBrokerV2PrefixCache({ ttlMs: 500, now: () => now });
  cache.beginTurn([SYS, U1]);
  now = 1200;
  assert.equal(cache.lookup([SYS, U1]).fullHit, true);
  now = 2000;
  assert.equal(cache.lookup([SYS, U1]).miss, true);
  // Prune xoa node la het han.
  assert.ok(cache.pruneExpired() >= 1);
});

test('prefix cache: gioi han node — het cho thi dung store them, dem evictions', () => {
  const cache = new InferenceBrokerV2PrefixCache({ maxNodes: 2, ttlMs: 60_000, now: () => 1000 });
  cache.store([SYS, U1]);
  assert.equal(cache.size, 2);
  const added = cache.store([{ role: 'user', content: 'message moi hoan toan' }]);
  assert.equal(added, 0);
  assert.ok(cache.stats().evictions >= 1);
});

test('prefix cache: clear xoa cay nhung giu thong ke tong', () => {
  const cache = new InferenceBrokerV2PrefixCache({ now: () => 1000 });
  cache.beginTurn([SYS, U1]);
  cache.clear();
  assert.equal(cache.size, 0);
  assert.equal(cache.lookup([SYS, U1]).miss, true);
  // Lookup da chay 2 lan: 1 trong beginTurn + 1 sau clear.
  assert.equal(cache.stats().lookups, 2);
});

test('prefix cache: multi-turn agent loop — hit rate tang dan theo turn', () => {
  const cache = new InferenceBrokerV2PrefixCache({ now: () => 1000 });
  const history = [];
  const ratios = [];
  const turns = [
    [SYS, U1],
    [SYS, U1, A1, U2],
    [SYS, U1, A1, U2, { role: 'assistant', content: 'Da tim thay.' }, { role: 'user', content: 'Mo file do' }],
  ];
  for (const msgs of turns) {
    const r = cache.beginTurn(msgs, { sessionId: 'loop-1' });
    ratios.push(r.hitRatio);
    history.push(r);
  }
  assert.equal(ratios[0], 0);
  assert.ok(ratios[1] > 0 && ratios[1] < 1);
  assert.ok(ratios[2] > ratios[1]);
  const stats = cache.stats();
  assert.equal(stats.sessions, 1);
  assert.match(cache.markdown(), /Hit rate/);
  assert.ok(stats.nodes > 0);
});

// ---------------------------------------------------------------------------
// Broker: route + probe + chat
// ---------------------------------------------------------------------------

function goodChatExecutor() {
  return async (engine, baseUrl, req) => ({
    text: 'Day la tra loi.',
    toolCalls: [],
    usage: { inputTokens: 10, outputTokens: 5 },
  });
}

test('broker: routeForTaskKind coding — primary co strict, fallback co llama.cpp', () => {
  const broker = createInferenceBrokerV2({ now: () => 1000 });
  const routed = broker.routeForTaskKind('coding');
  assert.ok(routed.primary);
  assert.notEqual(routed.primary.engine, 'ollama');
  assert.ok(routed.fallbackChain.length >= 1);
});

test('broker: chat khong executor -> loi ro rang, khong throw', async () => {
  const broker = createInferenceBrokerV2({ now: () => 1000 });
  const r = await broker.chat({ model: 'm', messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(r.ok, false);
  assert.match(r.error ?? '', /chua co chat executor/);
  assert.equal(r.attemptedEngines.length, 1);
});

test('broker: chat qua executor gia — text tra ve, prefix lookup do duoc', async () => {
  const broker = createInferenceBrokerV2({ executor: goodChatExecutor(), now: () => 1000 });
  const r = await broker.chat(
    { model: 'qwen3:8b', messages: [SYS, U1] },
    { taskKind: 'chat', sessionId: 's1' },
  );
  assert.equal(r.ok, true);
  assert.equal(r.response?.text, 'Day la tra loi.');
  assert.ok(r.servedByEngine);
  assert.equal(r.prefixLookup?.miss, true);
  // Turn 2 cung prefix -> partial/full hit.
  const r2 = await broker.chat(
    { model: 'qwen3:8b', messages: [SYS, U1, A1, U2] },
    { taskKind: 'chat', sessionId: 's1' },
  );
  assert.equal(r2.ok, true);
  assert.ok((r2.prefixLookup?.hitRatio ?? 0) > 0);
  assert.ok(broker.stats().prefixHitRate > 0);
});

test('broker: tool call dung schema duoc tra ve; sai schema bi chan + retry co gioi han', async () => {
  const searchDef = {
    name: 'search',
    description: 'Search.',
    parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false },
  };
  let calls = 0;
  const executor = async (engine, baseUrl, req) => {
    calls += 1;
    // Lan 1: tra tool call sai schema (thieu query). Lan 2 tro di:
    // tra tool call dung.
    if (calls === 1) {
      return { text: '', toolCalls: [{ id: 'c1', name: 'search', args: {} }] };
    }
    return { text: '', toolCalls: [{ id: 'c2', name: 'search', args: { query: 'hi' } }] };
  };
  const broker = createInferenceBrokerV2({
    executor,
    toolDefinitions: [searchDef],
    maxValidationRetries: 2,
    now: () => 1000,
  });
  const r = await broker.chat({ model: 'm', messages: [U1] }, { taskKind: 'coding' });
  assert.equal(r.ok, true);
  assert.equal(r.validationRetries, 1);
  assert.equal(r.blockedToolCalls, 1);
  assert.equal(r.response?.toolCalls[0]?.args.query, 'hi');
  assert.equal(broker.gate.stats().blocked, 1);
  assert.equal(broker.stats().validationRetries, 1);
});

test('broker: tool call sai schema mai -> het retry, tra blocked (khong thuc thi)', async () => {
  const searchDef = {
    name: 'search',
    description: 'Search.',
    parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
  };
  const executor = async () => ({ text: '', toolCalls: [{ id: 'c1', name: 'search', args: {} }] });
  const broker = createInferenceBrokerV2({
    executor,
    toolDefinitions: [searchDef],
    maxValidationRetries: 1,
    now: () => 1000,
  });
  const r = await broker.chat({ model: 'm', messages: [U1] }, { taskKind: 'coding' });
  assert.equal(r.ok, false);
  assert.equal(r.validationRetries, 1);
  assert.match(r.error ?? '', /bi chan sau/);
  assert.ok(r.blockedReasons.length > 0);
});

test('broker: tool la (khong trong allowlist) bi chan ngay, khong retry vo han', async () => {
  const executor = async () => ({ text: '', toolCalls: [{ id: 'c1', name: 'rm_rf', args: { path: '/' } }] });
  const broker = createInferenceBrokerV2({ executor, toolDefinitions: [], maxValidationRetries: 2, now: () => 1000 });
  const r = await broker.chat({ model: 'm', messages: [U1] });
  assert.equal(r.ok, false);
  assert.ok(r.blockedReasons.join(' ').includes('rm_rf'));
  assert.ok(r.validationRetries <= 2);
});

test('broker: executor loi o engine dau -> fallback sang engine sau', async () => {
  let calls = 0;
  const executor = async (engine) => {
    calls += 1;
    if (engine === 'ollama') throw new Error('ollama down');
    return { text: `tra loi tu ${engine}`, toolCalls: [] };
  };
  const broker = createInferenceBrokerV2({
    executor,
    engines: ['ollama', 'llamacpp'],
    now: () => 1000,
  });
  const r = await broker.chat({ model: 'm', messages: [U1] }, { engine: 'ollama' });
  assert.equal(r.ok, true);
  assert.equal(r.servedByEngine, 'llamacpp');
  assert.equal(calls, 2);
  assert.equal(broker.stats().fallbacksUsed, 1);
});

test('broker: probeAll qua fetch gia ghi vao registry; route sau do dung that', async () => {
  const fetchFn = async (url) => {
    if (String(url).endsWith('/v1/models')) {
      return { ok: true, status: 200, json: async () => ({ data: [{ id: 'qwen3:8b' }] }) };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { role: 'assistant', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'broker_probe_echo', arguments: '{"value":"ping-v2","mode":"exact"}' } }] } }],
      }),
    };
  };
  const broker = createInferenceBrokerV2({ now: () => 1000 });
  const results = await broker.probeAll({ fetchFn });
  assert.equal(results.length, 4);
  assert.ok(results.every((r) => r.toolCallParsed));
  assert.equal(broker.registry.workingCount(), 4);
  // Sau probe tot, coding van chon engine co strict (khong phai Ollama).
  const routed = broker.routeForTaskKind('coding');
  assert.notEqual(routed.primary?.engine, 'ollama');
});

test('broker: registerProbedModelsIntoRouter — model probe hong khong dang ky', async () => {
  const broker = createInferenceBrokerV2({ now: () => 1000 });
  // Gia vo probe: ollama tot, vllm hong (ghi truc tiep vao registry).
  const { evaluateBrokerV2ProbeResponse } = await import('../packages/core/dist/inferenceBrokerV2/probe.js');
  broker.registry.record(evaluateBrokerV2ProbeResponse('ollama', 'http://localhost:11434', {
    choices: [{ message: { role: 'assistant', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'broker_probe_echo', arguments: '{"value":"ping-v2","mode":"exact"}' } }] } }],
  }, { probedAt: 1000 }));
  broker.registry.record(evaluateBrokerV2ProbeResponse('vllm', 'http://localhost:8000', {
    choices: [{ message: { role: 'assistant', content: 'text' } }],
  }, { probedAt: 1000 }));
  const router = new UnifiedRouterV3();
  const res = broker.registerProbedModelsIntoRouter(router, [
    { modelId: 'qwen3:8b', engine: 'ollama', baseUrl: 'http://localhost:11434', running: true },
    { modelId: 'qwen3:8b', engine: 'vllm', baseUrl: 'http://localhost:8000', running: true },
  ]);
  assert.equal(res.registered, 1);
  assert.equal(res.skipped, 1);
  assert.match(res.skippedModels.join(' '), /vllm/);
  assert.equal(router.listLocalModels().length, 1);
  assert.equal(router.listLocalModels()[0].providerId, 'local:ollama');
});

test('broker: stats + markdown tom tat day du', async () => {
  const broker = createInferenceBrokerV2({ executor: goodChatExecutor(), now: () => 1000 });
  await broker.chat({ model: 'm', messages: [U1] });
  const s = broker.stats();
  assert.equal(s.chats, 1);
  assert.equal(s.chatsOk, 1);
  assert.match(broker.markdown(), /Inference broker v2/);
  assert.match(broker.markdown(), /Prefix-cache hit rate/);
});

// ---------------------------------------------------------------------------
// Voice v22
// ---------------------------------------------------------------------------

test('voice v22: khong key -> mock; co key -> live', () => {
  assert.equal(voiceV22ModeFor({}), 'mock');
  assert.equal(voiceV22ModeFor({ hasLiveKey: false }), 'mock');
  assert.equal(voiceV22ModeFor({ hasLiveKey: true }), 'live');
  assert.match(VOICE_V22_MOCK_REASON, /mock/i);
});

test('voice v22: session mock — mo, turn, dong; prefix hit rate tang theo turn', async () => {
  const session = createVoiceV22Session({ sessionId: 'v22-test-1', now: () => 1000 });
  assert.equal(session.mode, 'mock');
  assert.equal(session.currentState, 'idle');
  assert.equal(session.open(), true);
  assert.equal(session.open(), false);
  const t1 = await session.turn('Xin chao');
  assert.equal(t1.index, 1);
  assert.match(t1.agentText, /Mock tra loi/);
  assert.equal(t1.prefixLookup?.miss, true);
  const t2 = await session.turn('Tim file readme');
  assert.equal(t2.index, 2);
  assert.ok((t2.prefixLookup?.hitRatio ?? 0) > 0);
  assert.equal(session.listTurns().length, 2);
  const s = session.stats();
  assert.equal(s.turns, 2);
  assert.ok(s.prefixHitRate > 0);
  assert.match(s.mockReason ?? '', /mock/i);
  assert.match(session.markdown(), /Voice realtime v22/);
  session.close();
  assert.equal(session.currentState, 'closed');
  await assert.rejects(() => session.turn('nua'), /da dong/);
});

test('voice v22: session co executor gia — turn chay qua broker, tool call da validate', async () => {
  const searchDef = {
    name: 'search',
    description: 'Search.',
    parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
  };
  const executor = async () => ({
    text: 'Da tim thay file.',
    toolCalls: [{ id: 'c1', name: 'search', args: { query: 'readme' } }],
  });
  const session = createVoiceV22Session({
    sessionId: 'v22-test-2',
    executor,
    toolDefinitions: [searchDef],
    now: () => 1000,
  });
  const t = await session.turn('Tim file readme');
  assert.equal(t.agentText, 'Da tim thay file.');
  assert.deepEqual(t.toolCalls, ['search']);
  assert.deepEqual(t.blockedTools, []);
  assert.equal(session.stats().toolCallsValidated, 1);
});

test('voice v22: executor tra tool call sai schema -> turn mock + ghi blocked', async () => {
  const searchDef = {
    name: 'search',
    description: 'Search.',
    parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
  };
  const executor = async () => ({
    text: '',
    toolCalls: [{ id: 'c1', name: 'search', args: {} }],
  });
  const session = createVoiceV22Session({
    sessionId: 'v22-test-3',
    executor,
    toolDefinitions: [searchDef],
    now: () => 1000,
  });
  const t = await session.turn('Tim file readme');
  // Broker chan + het retry -> agentText fallback mock, blocked ghi ro.
  assert.match(t.agentText, /Mock tra loi/);
  assert.ok(t.blockedTools.includes('search') || t.toolCalls.length === 0);
  assert.ok(session.stats().toolCallsBlocked >= 1);
});

test('voice v22: extractBlockedToolNamesV22 boc ten tu blockedReasons', () => {
  assert.deepEqual(extractBlockedToolNamesV22(['tool "search" sai schema: x', 'tool "ping" khong trong allowlist']), ['search', 'ping']);
  assert.deepEqual(extractBlockedToolNamesV22(['khong co ten tool o day']), []);
});

test('voice v22: InferenceBrokerV2 class dung truc tiep (khong qua factory)', () => {
  const broker = new InferenceBrokerV2({ now: () => 1000 });
  assert.equal(broker.gate.maxValidationRetries, 2);
  assert.equal(broker.prefixCache.size, 0);
  const session = new VoiceV22Session({ sessionId: 'v22-test-4', broker, now: () => 1000 });
  assert.equal(session.mode, 'mock');
  assert.ok(session.currentEngine);
});

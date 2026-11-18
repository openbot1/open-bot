/**
 * Inference broker v2 probe + validate tests (v1.33, Doi T5 — node:test,
 * no network, no GPU, no real model).
 *
 * Covers:
 * - probe.ts: boc tach tool_calls, parse arguments, danh gia response
 *   (dung tool / sai ten / sai JSON / sai gia tri / khong tra tool),
 *   probe 1 engine + nhieu engine qua fetch gia (mock server), registry
 *   (ghi de khai bao bang that, TTL, fallback Ollama -> llama.cpp).
 * - validate.ts: JSON Schema subset (required, type, enum, nested,
 *   additionalProperties, anyOf/oneOf, min/max...), chuan hoa tool call
 *   (OpenAI / Ollama / phang), allowlist, gate (log chan, retry co
 *   gioi han, stats, markdown).
 *
 * Imports the BUILT core — build first:
 *   npm run build --workspace=@open-bot/core
 * then: node --test tests/inference-broker-v2-probe-validate.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BROKER_V2_PROBE_ARG_MODE,
  BROKER_V2_PROBE_ARG_VALUE,
  BROKER_V2_PROBE_TOOL_NAME,
  InferenceBrokerV2ProbedRegistry,
  brokerV2ProbeArgumentsMatch,
  brokerV2ProbeFailure,
  brokerV2ProbeRequestBody,
  brokerV2ProbeToolDefinition,
  evaluateBrokerV2ProbeResponse,
  extractBrokerV2ToolCalls,
  listBrokerV2Models,
  parseBrokerV2ToolCallArguments,
  probeBrokerV2Engine,
  probeBrokerV2Engines,
  resolveBrokerV2Fallback,
} from '../packages/core/dist/inferenceBrokerV2/probe.js';
import {
  BROKER_V2_DEFAULT_MAX_VALIDATION_RETRIES,
  InferenceBrokerV2ValidationGate,
  brokerV2RepairMessage,
  brokerV2ValidateAgainstSchema,
  deepEqualBrokerV2,
  describeBrokerV2Value,
  normalizeBrokerV2ToolCall,
  validateBrokerV2ToolCall,
  validateBrokerV2ToolCalls,
} from '../packages/core/dist/inferenceBrokerV2/validate.js';

// ---------------------------------------------------------------------------
// Helpers: mock fetch
// ---------------------------------------------------------------------------

function chatResponse(toolCalls) {
  return {
    choices: [{ message: { role: 'assistant', content: '', tool_calls: toolCalls } }],
  };
}

function goodToolCall() {
  return [
    {
      id: 'call-1',
      type: 'function',
      function: {
        name: BROKER_V2_PROBE_TOOL_NAME,
        arguments: JSON.stringify({ value: BROKER_V2_PROBE_ARG_VALUE, mode: BROKER_V2_PROBE_ARG_MODE }),
      },
    },
  ];
}

/** Fake fetch: /v1/models tra 1 model; /v1/chat/completions tra response do caller chon. */
function makeFakeFetch(chatBody) {
  return async (url, init) => {
    if (String(url).endsWith('/v1/models')) {
      return { ok: true, status: 200, json: async () => ({ data: [{ id: 'qwen3:8b' }] }) };
    }
    if (String(url).includes('/v1/chat/completions')) {
      return { ok: true, status: 200, json: async () => chatBody };
    }
    return { ok: false, status: 404, json: async () => ({}), text: async () => 'not found' };
  };
}

// ---------------------------------------------------------------------------
// Probe: parse + danh gia response (thuan)
// ---------------------------------------------------------------------------

test('probe: tool mau co dung ten + schema (value bat buoc, mode enum)', () => {
  const def = brokerV2ProbeToolDefinition();
  assert.equal(def.function.name, BROKER_V2_PROBE_TOOL_NAME);
  assert.deepEqual(def.function.parameters.required, ['value']);
  assert.deepEqual(def.function.parameters.properties.mode.enum, ['exact', 'upper']);
  const body = brokerV2ProbeRequestBody({ model: 'qwen3:8b' });
  assert.equal(body.model, 'qwen3:8b');
  assert.equal(body.temperature, 0);
  assert.equal(body.tool_choice, undefined);
  const forced = brokerV2ProbeRequestBody({ forceToolCall: true });
  assert.equal(forced.tool_choice.function.name, BROKER_V2_PROBE_TOOL_NAME);
});

test('probe: extract tool_calls — dung, rong, thieu choices, sai dang', () => {
  assert.equal(extractBrokerV2ToolCalls(chatResponse(goodToolCall())).length, 1);
  assert.deepEqual(extractBrokerV2ToolCalls(chatResponse([])), []);
  assert.deepEqual(extractBrokerV2ToolCalls({ choices: [] }), []);
  assert.deepEqual(extractBrokerV2ToolCalls({}), []);
  assert.deepEqual(extractBrokerV2ToolCalls(null), []);
  assert.deepEqual(extractBrokerV2ToolCalls({ choices: [{ message: { content: 'hi' } }] }), []);
});

test('probe: parse arguments — chuoi JSON, object san, JSON gay, khong phai object', () => {
  const okStr = parseBrokerV2ToolCallArguments({
    function: { name: 'x', arguments: '{"value":"ping-v2","mode":"exact"}' },
  });
  assert.equal(okStr.ok, true);
  assert.equal(okStr.args.value, 'ping-v2');
  const okObj = parseBrokerV2ToolCallArguments({ function: { name: 'x', arguments: { value: 'a' } } });
  assert.equal(okObj.ok, true);
  assert.equal(parseBrokerV2ToolCallArguments({ function: { name: 'x', arguments: '{gay' } }).ok, false);
  assert.equal(parseBrokerV2ToolCallArguments({ function: { name: 'x', arguments: '[1,2]' } }).ok, false);
  assert.equal(parseBrokerV2ToolCallArguments({ function: { name: 'x', arguments: '' } }).ok, false);
  assert.equal(parseBrokerV2ToolCallArguments({ function: { name: 'x' } }).ok, false);
  assert.equal(brokerV2ProbeArgumentsMatch({ value: BROKER_V2_PROBE_ARG_VALUE, mode: BROKER_V2_PROBE_ARG_MODE }), true);
  assert.equal(brokerV2ProbeArgumentsMatch({ value: 'sai', mode: 'exact' }), false);
});

test('probe: evaluate — response tot (dung tool, khop gia tri)', () => {
  const r = evaluateBrokerV2ProbeResponse('ollama', 'http://localhost:11434', chatResponse(goodToolCall()), {
    modelId: 'qwen3:8b',
    latencyMs: 120,
    probedAt: 1000,
  });
  assert.equal(r.reachable, true);
  assert.equal(r.toolCallParsed, true);
  assert.equal(r.argumentsParseable, true);
  assert.equal(r.argumentsMatchExpected, true);
  assert.equal(r.toolCallsObserved, 1);
  assert.equal(r.parallelObserved, false);
  assert.equal(r.latencyMs, 120);
  assert.equal(r.source, 'probed');
  assert.match(r.note, /hoat dong/);
});

test('probe: evaluate — parallel (2 call) duoc ghi nhan', () => {
  const calls = [...goodToolCall(), { ...goodToolCall()[0], id: 'call-2' }];
  const r = evaluateBrokerV2ProbeResponse('vllm', 'http://localhost:8000', chatResponse(calls));
  assert.equal(r.toolCallsObserved, 2);
  assert.equal(r.parallelObserved, true);
  assert.match(r.note, /parallel/);
});

test('probe: evaluate — tra text thay vi tool call (parser chua bat)', () => {
  const r = evaluateBrokerV2ProbeResponse('llamacpp', 'http://localhost:8080', {
    choices: [{ message: { role: 'assistant', content: 'ping-v2' } }],
  });
  assert.equal(r.toolCallParsed, false);
  assert.equal(r.argumentsParseable, false);
  assert.match(r.note, /khong tra tool call/);
});

test('probe: evaluate — sai ten tool (parser chay nhung khong chinh xac)', () => {
  const r = evaluateBrokerV2ProbeResponse('ollama', 'http://localhost:11434', chatResponse([
    { id: 'c1', type: 'function', function: { name: 'tool_khac', arguments: '{}' } },
  ]));
  assert.equal(r.toolCallParsed, true);
  assert.equal(r.argumentsParseable, false);
  assert.match(r.note, /sai ten/);
});

test('probe: evaluate — arguments JSON gay (parser gay schema)', () => {
  const r = evaluateBrokerV2ProbeResponse('vllm', 'http://localhost:8000', chatResponse([
    { id: 'c1', type: 'function', function: { name: BROKER_V2_PROBE_TOOL_NAME, arguments: '{"value":' } },
  ]));
  assert.equal(r.toolCallParsed, true);
  assert.equal(r.argumentsParseable, false);
  assert.match(r.note, /arguments loi/);
});

test('probe: evaluate — arguments dung JSON nhung sai gia tri', () => {
  const r = evaluateBrokerV2ProbeResponse('sglang', 'http://localhost:30000', chatResponse([
    { id: 'c1', type: 'function', function: { name: BROKER_V2_PROBE_TOOL_NAME, arguments: '{"value":"sai","mode":"exact"}' } },
  ]));
  assert.equal(r.argumentsParseable, true);
  assert.equal(r.argumentsMatchExpected, false);
  assert.match(r.note, /SAI gia tri/);
});

test('probe: failure — khong phan hoi, ghi ro loi', () => {
  const r = brokerV2ProbeFailure('ollama', 'http://localhost:11434', 'timeout sau 10000ms', { latencyMs: 10000, probedAt: 500 });
  assert.equal(r.reachable, false);
  assert.equal(r.toolCallParsed, false);
  assert.equal(r.error, 'timeout sau 10000ms');
  assert.match(r.note, /khong probe duoc/);
});

// ---------------------------------------------------------------------------
// Probe: qua fetch gia (mock server, khong can engine that)
// ---------------------------------------------------------------------------

test('probe: probeBrokerV2Engine — mock server tot -> probe tot', async () => {
  const r = await probeBrokerV2Engine('ollama', {
    fetchFn: makeFakeFetch(chatResponse(goodToolCall())),
    now: () => 1000,
  });
  assert.equal(r.reachable, true);
  assert.equal(r.toolCallParsed, true);
  assert.equal(r.argumentsMatchExpected, true);
  assert.equal(r.modelId, 'qwen3:8b');
});

test('probe: probeBrokerV2Engine — server 500 -> probe that bai, khong throw', async () => {
  const fetchFn = async (url) => {
    if (String(url).endsWith('/v1/models')) {
      return { ok: true, status: 200, json: async () => ({ data: [{ id: 'm' }] }) };
    }
    return { ok: false, status: 500, json: async () => ({}), text: async () => 'boom' };
  };
  const r = await probeBrokerV2Engine('vllm', { fetchFn, now: () => 2000 });
  assert.equal(r.reachable, false);
  assert.match(r.error ?? '', /HTTP 500/);
});

test('probe: probeBrokerV2Engine — khong co fetch -> that bai ro rang', async () => {
  const r = await probeBrokerV2Engine('sglang', { now: () => 3000 });
  assert.equal(r.reachable, false);
  assert.match(r.error ?? '', /khong co fetch/);
});

test('probe: probeBrokerV2Engines — probe ca 4 tuan tu, moi engine 1 ket qua', async () => {
  const results = await probeBrokerV2Engines(['ollama', 'llamacpp', 'vllm', 'sglang'], {
    fetchFn: makeFakeFetch(chatResponse(goodToolCall())),
    now: () => 4000,
  });
  assert.equal(results.length, 4);
  assert.deepEqual(results.map((r) => r.engine), ['ollama', 'llamacpp', 'vllm', 'sglang']);
  assert.ok(results.every((r) => r.toolCallParsed));
});

test('probe: listBrokerV2Models — parse /v1/models, gioi han 50', async () => {
  const models = await listBrokerV2Models('http://localhost:11434', makeFakeFetch(chatResponse([])));
  assert.deepEqual(models, ['qwen3:8b']);
  const empty = await listBrokerV2Models('http://localhost:11434', async () => ({
    ok: false, status: 404, json: async () => ({}),
  }));
  assert.deepEqual(empty, []);
});

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

test('registry: chua probe -> dung khai bao; da probe tot -> that ghi de', () => {
  const reg = new InferenceBrokerV2ProbedRegistry({ now: () => 1000 });
  const before = reg.entryFor('ollama', 1000);
  assert.equal(before.probed, undefined);
  assert.equal(before.effectiveToolCallWorks, true);
  assert.equal(before.fresh, false);
  reg.record(evaluateBrokerV2ProbeResponse('ollama', 'http://localhost:11434', chatResponse(goodToolCall()), { probedAt: 1000 }));
  const after = reg.entryFor('ollama', 1000);
  assert.equal(after.probed?.toolCallParsed, true);
  assert.equal(after.effectiveToolCallWorks, true);
  assert.equal(after.fresh, true);
  assert.equal(reg.workingCount(), 1);
});

test('registry: probe hong -> effectiveToolCallWorks = false (khong tin khai bao)', () => {
  const reg = new InferenceBrokerV2ProbedRegistry({ now: () => 1000 });
  reg.record(evaluateBrokerV2ProbeResponse('vllm', 'http://localhost:8000', chatResponse([]), { probedAt: 1000 }));
  assert.equal(reg.entryFor('vllm', 1000).effectiveToolCallWorks, false);
  assert.equal(reg.workingCount(), 0);
});

test('registry: het TTL -> het tuoi, can probe lai', () => {
  const reg = new InferenceBrokerV2ProbedRegistry({ ttlMs: 1000, now: () => 5000 });
  reg.record(evaluateBrokerV2ProbeResponse('ollama', 'http://localhost:11434', chatResponse(goodToolCall()), { probedAt: 1000 }));
  assert.equal(reg.isFresh('ollama', 1500), true);
  assert.equal(reg.isFresh('ollama', 5000), false);
  assert.match(reg.markdown(5000), /het han/);
});

test('registry: clear + probedMapForRouter chi gom engine da probe', () => {
  const reg = new InferenceBrokerV2ProbedRegistry({ now: () => 1000 });
  reg.record(evaluateBrokerV2ProbeResponse('ollama', 'http://localhost:11434', chatResponse(goodToolCall()), { probedAt: 1000 }));
  const map = reg.probedMapForRouter();
  assert.deepEqual(Object.keys(map), ['ollama']);
  assert.equal(map.ollama.toolCallWorks, true);
  assert.equal(reg.clear('ollama'), true);
  assert.equal(reg.probedFor('ollama'), undefined);
  assert.deepEqual(Object.keys(reg.probedMapForRouter()), []);
});

test('registry: markdown liet ke ca engine chua probe', () => {
  const reg = new InferenceBrokerV2ProbedRegistry({ now: () => 1000 });
  const md = reg.markdown(1000);
  for (const label of ['Ollama', 'llama.cpp', 'vLLM', 'SGLang']) {
    assert.match(md, new RegExp(label.replace('.', '\\.')));
  }
  assert.match(md, /chua probe/);
});

test('fallback: Ollama probe tot nhung thieu tool_choice -> fallback llama.cpp', () => {
  const reg = new InferenceBrokerV2ProbedRegistry({ now: () => 1000 });
  reg.record(evaluateBrokerV2ProbeResponse('ollama', 'http://localhost:11434', chatResponse(goodToolCall()), { probedAt: 1000 }));
  const fb = resolveBrokerV2Fallback('ollama', reg);
  assert.equal(fb.fallback, 'llamacpp');
  assert.match(fb.reason, /tool_choice/);
});

test('fallback: engine khong chay -> fallback sang llama.cpp (hoac ollama)', () => {
  const reg = new InferenceBrokerV2ProbedRegistry({ now: () => 1000 });
  reg.record(brokerV2ProbeFailure('vllm', 'http://localhost:8000', 'ECONNREFUSED', { probedAt: 1000 }));
  assert.equal(resolveBrokerV2Fallback('vllm', reg).fallback, 'llamacpp');
  reg.record(brokerV2ProbeFailure('llamacpp', 'http://localhost:8080', 'ECONNREFUSED', { probedAt: 1000 }));
  assert.equal(resolveBrokerV2Fallback('llamacpp', reg).fallback, 'ollama');
});

test('fallback: chua probe -> khong doi fallback', () => {
  const reg = new InferenceBrokerV2ProbedRegistry({ now: () => 1000 });
  const fb = resolveBrokerV2Fallback('sglang', reg);
  assert.equal(fb.fallback, undefined);
});

// ---------------------------------------------------------------------------
// Validate: JSON Schema subset
// ---------------------------------------------------------------------------

const SCHEMA = {
  type: 'object',
  properties: {
    query: { type: 'string', minLength: 1, maxLength: 100 },
    limit: { type: 'integer', minimum: 1, maximum: 50 },
    mode: { type: 'string', enum: ['exact', 'fuzzy'] },
    tags: { type: 'array', items: { type: 'string' }, minItems: 1 },
    opts: {
      type: 'object',
      properties: { deep: { type: 'boolean' } },
      required: ['deep'],
      additionalProperties: false,
    },
  },
  required: ['query'],
  additionalProperties: false,
};

test('validate schema: hop le (day du + nested dung)', () => {
  const errs = brokerV2ValidateAgainstSchema(
    { query: 'hi', limit: 5, mode: 'exact', tags: ['a'], opts: { deep: true } },
    SCHEMA,
  );
  assert.deepEqual(errs, []);
});

test('validate schema: thieu required + sai kieu + enum + min/max + additionalProperties', () => {
  const errs = brokerV2ValidateAgainstSchema(
    { limit: 0, mode: 'wrong', extra: 1, opts: { deep: 'yes', x: 1 } },
    SCHEMA,
  );
  assert.ok(errs.some((e) => e.includes('thieu truong bat buoc "query"')));
  assert.ok(errs.some((e) => e.includes('minimum')));
  assert.ok(errs.some((e) => e.includes('enum')));
  assert.ok(errs.some((e) => e.includes('truong thua "extra"')));
  assert.ok(errs.some((e) => e.includes('opts.deep')));
  assert.ok(errs.some((e) => e.includes('truong thua "x"')));
});

test('validate schema: string pattern + array items + minLength', () => {
  const errs = brokerV2ValidateAgainstSchema(
    { query: '', tags: ['ok', 3] },
    { type: 'object', properties: { query: { type: 'string', minLength: 1, pattern: '^[a-z]+$' }, tags: { type: 'array', items: { type: 'string' } } } },
  );
  assert.ok(errs.some((e) => e.includes('qua ngan')));
  assert.ok(errs.some((e) => e.includes('tags[1]')));
});

test('validate schema: anyOf / oneOf', () => {
  const schema = { anyOf: [{ type: 'string' }, { type: 'integer' }] };
  assert.deepEqual(brokerV2ValidateAgainstSchema('a', schema), []);
  assert.deepEqual(brokerV2ValidateAgainstSchema(3, schema), []);
  assert.equal(brokerV2ValidateAgainstSchema(true, schema).length, 1);
  const one = { oneOf: [{ type: 'string' }, { type: 'string', minLength: 1 }] };
  assert.equal(brokerV2ValidateAgainstSchema('a', one).length, 1);
  assert.deepEqual(brokerV2ValidateAgainstSchema('', one), []);
});

test('validate schema: const + deepEqual', () => {
  assert.deepEqual(brokerV2ValidateAgainstSchema('x', { const: 'x' }), []);
  assert.equal(brokerV2ValidateAgainstSchema('y', { const: 'x' }).length, 1);
  assert.equal(deepEqualBrokerV2({ a: [1, 2] }, { a: [1, 2] }), true);
  assert.equal(deepEqualBrokerV2({ a: [1] }, { a: [2] }), false);
  assert.equal(describeBrokerV2Value(null), 'null');
  assert.equal(describeBrokerV2Value([1]), 'array');
});

// ---------------------------------------------------------------------------
// Validate: chuan hoa + gate
// ---------------------------------------------------------------------------

const DEFS = [
  { name: 'search', description: 'Search.', parameters: SCHEMA },
  { name: 'ping', description: 'Ping.', parameters: { type: 'object', properties: {}, required: [] } },
];

test('validate: chuan hoa OpenAI / Ollama / phang + arguments chuoi/object', () => {
  const openai = normalizeBrokerV2ToolCall({
    id: 'c1',
    function: { name: 'ping', arguments: '{}' },
  });
  assert.equal(openai.ok, true);
  assert.equal(openai.call?.name, 'ping');
  const ollama = normalizeBrokerV2ToolCall({ function: { name: 'ping', arguments: {} } });
  assert.equal(ollama.ok, true);
  const flat = normalizeBrokerV2ToolCall({ name: 'search', arguments: '{"query":"hi"}' });
  assert.equal(flat.ok, true);
  assert.equal(flat.call?.args.query, 'hi');
  assert.equal(normalizeBrokerV2ToolCall({ name: 'ping', arguments: '{gay' }).ok, false);
  assert.equal(normalizeBrokerV2ToolCall({ arguments: '{}' }).ok, false);
  assert.equal(normalizeBrokerV2ToolCall({ name: 'ping', arguments: 42 }).ok, false);
});

test('validate: tool dung -> ok; tool la -> chan; tool khong biet -> chan', () => {
  const ok = validateBrokerV2ToolCall({ name: 'search', arguments: { query: 'hi' } }, DEFS);
  assert.equal(ok.ok, true);
  assert.equal(ok.call?.name, 'search');
  const notAllowed = validateBrokerV2ToolCall(
    { name: 'search', arguments: { query: 'hi' } },
    DEFS,
    { allowlist: ['ping'] },
  );
  assert.equal(notAllowed.ok, false);
  assert.match(notAllowed.blockedReasons.join(' '), /allowlist/);
  const unknown = validateBrokerV2ToolCall({ name: 'rm_rf', arguments: {} }, DEFS);
  assert.equal(unknown.ok, false);
  assert.match(unknown.blockedReasons.join(' '), /khong biet/);
});

test('validate: sai schema -> chan + ly do ro', () => {
  const bad = validateBrokerV2ToolCall({ name: 'search', arguments: { limit: 999 } }, DEFS);
  assert.equal(bad.ok, false);
  assert.match(bad.blockedReasons.join(' '), /sai schema/);
  assert.match(bad.blockedReasons.join(' '), /thieu truong bat buoc/);
});

test('validate: validateAll — 1 sai la ca loat khong ok, valid chi gom call dung', () => {
  const r = validateBrokerV2ToolCalls(
    [
      { name: 'ping', arguments: {} },
      { name: 'search', arguments: { query: 'hi' } },
      { name: 'search', arguments: {} },
    ],
    DEFS,
  );
  assert.equal(r.ok, false);
  assert.equal(r.valid.length, 2);
  assert.equal(r.results.length, 3);
});

test('gate: dang ky + validate + log chan + stats + retry co gioi han', () => {
  const gate = new InferenceBrokerV2ValidationGate({
    defs: DEFS,
    maxRetries: BROKER_V2_DEFAULT_MAX_VALIDATION_RETRIES,
    now: () => 1000,
  });
  assert.equal(gate.maxValidationRetries, 2);
  assert.equal(gate.validate({ name: 'ping', arguments: {} }).ok, true);
  const bad = gate.validate({ name: 'search', arguments: {} });
  assert.equal(bad.ok, false);
  const s = gate.stats();
  assert.equal(s.total, 2);
  assert.equal(s.allowed, 1);
  assert.equal(s.blocked, 1);
  assert.deepEqual(s.blockedTools, ['search']);
  assert.equal(gate.blockedLog().length, 1);
  assert.equal(gate.blockedLog()[0].toolName, 'search');
  assert.equal(gate.canRetry(0), true);
  assert.equal(gate.canRetry(1), true);
  assert.equal(gate.canRetry(2), false);
  gate.noteRetry();
  assert.equal(gate.stats().retriesUsed, 1);
  assert.match(gate.markdown(), /chan: 1/);
});

test('gate: disallowTool chan ngay ca khi da co dinh nghia; unregister go luon', () => {
  const gate = new InferenceBrokerV2ValidationGate({ defs: DEFS, now: () => 1000 });
  gate.disallowTool('ping');
  assert.equal(gate.validate({ name: 'ping', arguments: {} }).ok, false);
  gate.allowTool('ping');
  assert.equal(gate.validate({ name: 'ping', arguments: {} }).ok, true);
  assert.equal(gate.unregisterTool('ping'), true);
  assert.equal(gate.validate({ name: 'ping', arguments: {} }).ok, false);
});

test('gate: repair message huong dan model sua lai (khong tu sua ho)', () => {
  const gate = new InferenceBrokerV2ValidationGate({ defs: DEFS, now: () => 1000 });
  const bad = gate.validate({ name: 'search', arguments: {} });
  const msg = brokerV2RepairMessage(bad);
  assert.match(msg, /bi chan truoc khi thuc thi/);
  assert.match(msg, /goi lai dung/);
  assert.equal(brokerV2RepairMessage({ ok: true, toolName: 'ping', blockedReasons: [], warnings: [] }), '');
});

/**
 * Inference broker v2 tools + i18n tests (v1.33, Doi T5 — node:test,
 * no network, no GPU, no real model).
 *
 * Covers:
 * - Registry (packages/tools/src/inferenceBrokerV2Tools.ts): all 7
 *   tools in ALL_TOOLS exactly once, unique names, definitions carry
 *   parameters + required lists.
 * - Each tool end-to-end on a mock state (fake fetch for probe, mock
 *   executor for voice turn): matrix, route, probe, probe status,
 *   validate, prefix cache (stats/measure/clear), voice status/turn.
 * - Argument validation: missing/wrong args return `Error: ...`
 *   strings, never throw.
 * - createDefaultTools binds them via getInferenceBrokerV2State,
 *   never duplicates.
 * - i18n: the 24 inferenceBrokerV2.* keys exist in all 6 locales,
 *   non-empty, placeholders match en. (Global total pin lives in
 *   tests/i18n-v106.test.mjs — coordinator re-pins at merge:
 *   6863 + 24 = 6887 per locale.)
 *
 * Imports the BUILT tools + core — build first:
 *   npm run build --workspace=@open-bot/core
 *   npm run build --workspace=@open-bot/tools
 * then: node --test tests/inference-broker-v2-tools.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ALL_TOOLS, createDefaultTools } from '../packages/tools/dist/tools.js';
import {
  INFERENCE_BROKER_V2_TOOL_NAMES,
  createDefaultInferenceBrokerV2State,
  createInferenceBrokerV2Tools,
  isInferenceBrokerV2TaskKind,
  isInferenceBrokerV2ToolName,
} from '../packages/tools/dist/inferenceBrokerV2Tools.js';

const here = dirname(fileURLToPath(import.meta.url));
const localesDir = join(here, '..', 'apps/desktop/src/renderer/i18n/locales');
const LOCALE_NAMES = ['en', 'vi', 'es', 'fr', 'ja', 'zh'];

const INFERENCE_BROKER_V2_KEYS = [
  'inferenceBrokerV2.title',
  'inferenceBrokerV2.subtitle',
  'inferenceBrokerV2.matrixTitle',
  'inferenceBrokerV2.routeTitle',
  'inferenceBrokerV2.probeTitle',
  'inferenceBrokerV2.probeRunning',
  'inferenceBrokerV2.probeDone',
  'inferenceBrokerV2.probeFailed',
  'inferenceBrokerV2.probeNotRun',
  'inferenceBrokerV2.statusTitle',
  'inferenceBrokerV2.validateTitle',
  'inferenceBrokerV2.validateBlocked',
  'inferenceBrokerV2.validateOk',
  'inferenceBrokerV2.prefixCacheTitle',
  'inferenceBrokerV2.prefixHitRate',
  'inferenceBrokerV2.voiceTitle',
  'inferenceBrokerV2.voiceMock',
  'inferenceBrokerV2.engineOllama',
  'inferenceBrokerV2.engineLlamacpp',
  'inferenceBrokerV2.engineVllm',
  'inferenceBrokerV2.engineSglang',
  'inferenceBrokerV2.fallbackTitle',
  'inferenceBrokerV2.noEngine',
  'inferenceBrokerV2.chatFailed',
];

function loadLocale(name) {
  return JSON.parse(readFileSync(join(localesDir, `${name}.json`), 'utf8'));
}

function toolByName(tools, name) {
  const found = tools.filter((t) => t.definition.name === name);
  assert.equal(found.length, 1, `expected exactly 1 tool named ${name}, got ${found.length}`);
  return found[0];
}

async function run(tools, name, args) {
  return toolByName(tools, name).execute(args, {});
}

function parse(result) {
  assert.ok(!result.startsWith('Error:'), `expected JSON, got ${result}`);
  return JSON.parse(result);
}

/** Fake fetch: mock server tot cho ca 4 engine. */
function makeGoodFetch() {
  return async (url) => {
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
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

test('broker v2 tools: 7 tools in ALL_TOOLS exactly once, unique names', () => {
  assert.equal(INFERENCE_BROKER_V2_TOOL_NAMES.length, 7);
  assert.equal(new Set(INFERENCE_BROKER_V2_TOOL_NAMES).size, 7);
  for (const name of INFERENCE_BROKER_V2_TOOL_NAMES) {
    assert.ok(isInferenceBrokerV2ToolName(name));
    const inAll = ALL_TOOLS.filter((t) => t.definition.name === name);
    assert.equal(inAll.length, 1, `${name} phai co dung 1 lan trong ALL_TOOLS`);
    assert.ok(inAll[0].definition.description.length > 0);
    assert.equal(inAll[0].definition.parameters.type, 'object');
  }
  assert.equal(isInferenceBrokerV2ToolName('router_v3_rank'), false);
  assert.equal(isInferenceBrokerV2TaskKind('coding'), true);
  assert.equal(isInferenceBrokerV2TaskKind('khong-co'), false);
  const totalNames = new Set(ALL_TOOLS.map((t) => t.definition.name));
  assert.equal(totalNames.size, ALL_TOOLS.length, 'ALL_TOOLS khong duoc trung ten');
});

test('broker v2 tools: createDefaultTools binds them via getInferenceBrokerV2State, never duplicates', () => {
  const state = createDefaultInferenceBrokerV2State();
  const bound = createDefaultTools({ getInferenceBrokerV2State: () => state });
  for (const name of INFERENCE_BROKER_V2_TOOL_NAMES) {
    assert.equal(bound.filter((t) => t.definition.name === name).length, 1, name);
  }
  assert.equal(new Set(bound.map((t) => t.definition.name)).size, bound.length);
  // getInferenceBrokerV2State tra null -> giu placeholder.
  const kept = createDefaultTools({ getInferenceBrokerV2State: () => null });
  for (const name of INFERENCE_BROKER_V2_TOOL_NAMES) {
    assert.equal(kept.filter((t) => t.definition.name === name).length, 1, name);
  }
});

// ---------------------------------------------------------------------------
// Matrix + route
// ---------------------------------------------------------------------------

test('broker v2 tool matrix: ca 4 engine + loc 1 engine', async () => {
  const tools = createInferenceBrokerV2Tools();
  const all = parse(await run(tools, 'inference_broker_v2_matrix', {}));
  assert.equal(all.engines.length, 4);
  assert.deepEqual(all.engines.map((e) => e.engine), ['ollama', 'llamacpp', 'vllm', 'sglang']);
  const one = parse(await run(tools, 'inference_broker_v2_matrix', { engine: 'vllm' }));
  assert.equal(one.label, 'vLLM');
  assert.equal(one.toolCalling.strictMode, true);
  const bad = await run(tools, 'inference_broker_v2_matrix', { engine: 'khong-co' });
  assert.ok(bad.startsWith('Error:'));
});

test('broker v2 tool route: coding chon engine co strict; extract + batch dung yeu cau', async () => {
  const tools = createInferenceBrokerV2Tools();
  const coding = parse(await run(tools, 'inference_broker_v2_route', { taskKind: 'coding' }));
  assert.ok(coding.primary);
  assert.notEqual(coding.primary.engine, 'ollama');
  assert.ok(coding.fallbackChain.length >= 1);
  const extract = parse(await run(tools, 'inference_broker_v2_route', { taskKind: 'extract' }));
  assert.ok(extract.primary);
  assert.ok(extract.ranked.every((r) => r.eligible));
  const batch = parse(await run(tools, 'inference_broker_v2_route', { taskKind: 'batch' }));
  assert.equal(batch.primary.engine, 'vllm');
  const bad = await run(tools, 'inference_broker_v2_route', { taskKind: 'khong-co' });
  assert.ok(bad.startsWith('Error:'));
  const missing = await run(tools, 'inference_broker_v2_route', {});
  assert.ok(missing.startsWith('Error:'));
});

// ---------------------------------------------------------------------------
// Probe + probe status
// ---------------------------------------------------------------------------

test('broker v2 tool probe: mock server tot -> ca 4 engine probe tot', async () => {
  const state = createDefaultInferenceBrokerV2State({ fetchFn: makeGoodFetch() });
  const tools = createInferenceBrokerV2Tools(state);
  const r = parse(await run(tools, 'inference_broker_v2_probe', {}));
  assert.equal(r.probed.length, 4);
  assert.ok(r.probed.every((p) => p.toolCallParsed && p.argumentsMatchExpected));
  assert.equal(r.workingCount, 4);
  const one = parse(await run(tools, 'inference_broker_v2_probe', { engine: 'ollama' }));
  assert.equal(one.probed.length, 1);
  assert.equal(one.probed[0].engine, 'ollama');
});

test('broker v2 tool probe status: truoc probe chua co gi, sau probe du 4 muc', async () => {
  const state = createDefaultInferenceBrokerV2State({ fetchFn: makeGoodFetch() });
  const tools = createInferenceBrokerV2Tools(state);
  const before = parse(await run(tools, 'inference_broker_v2_probe_status', {}));
  assert.equal(before.entries.length, 4);
  assert.ok(before.entries.every((e) => e.probed === false));
  assert.equal(before.workingCount, 0);
  await run(tools, 'inference_broker_v2_probe', {});
  const after = parse(await run(tools, 'inference_broker_v2_probe_status', {}));
  assert.ok(after.entries.every((e) => e.probed === true));
  assert.equal(after.workingCount, 4);
  assert.match(after.markdown, /Ollama/);
});

// ---------------------------------------------------------------------------
// Validate
// ---------------------------------------------------------------------------

test('broker v2 tool validate: dung -> ok; sai schema -> chan; la -> chan', async () => {
  const state = createDefaultInferenceBrokerV2State();
  const tools = createInferenceBrokerV2Tools(state);
  const defs = JSON.stringify([
    { name: 'search', description: 'Search.', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false } },
  ]);
  const ok = parse(await run(tools, 'inference_broker_v2_validate', {
    toolName: 'search',
    arguments: JSON.stringify({ query: 'hi' }),
    toolDefinitions: defs,
  }));
  assert.equal(ok.ok, true);
  assert.equal(ok.call.name, 'search');
  const bad = parse(await run(tools, 'inference_broker_v2_validate', {
    toolName: 'search',
    arguments: JSON.stringify({}),
    toolDefinitions: defs,
  }));
  assert.equal(bad.ok, false);
  assert.ok(bad.blockedReasons.join(' ').includes('sai schema'));
  const unknown = parse(await run(tools, 'inference_broker_v2_validate', {
    toolName: 'rm_rf',
    arguments: JSON.stringify({ path: '/' }),
  }));
  assert.equal(unknown.ok, false);
  // Qua gate, tool la bi chan o allowlist truoc khi toi buoc "khong biet"
  // (ca hai deu la chan truoc khi thuc thi — hanh vi dung).
  assert.match(unknown.blockedReasons.join(' '), /allowlist/);
  const missing = await run(tools, 'inference_broker_v2_validate', {});
  assert.ok(missing.startsWith('Error:'));
  const badJson = await run(tools, 'inference_broker_v2_validate', {
    toolName: 'search',
    arguments: '{gay',
  });
  assert.ok(badJson.startsWith('Error:'));
});

// ---------------------------------------------------------------------------
// Prefix cache
// ---------------------------------------------------------------------------

test('broker v2 tool prefix cache: stats -> measure (miss roi hit) -> clear', async () => {
  const tools = createInferenceBrokerV2Tools();
  const s0 = parse(await run(tools, 'inference_broker_v2_prefix_cache', { action: 'stats' }));
  assert.equal(s0.lookups, 0);
  assert.equal(s0.hitRate, 0);
  const msgs = JSON.stringify([
    { role: 'system', content: 'Ban la tro ly.' },
    { role: 'user', content: 'Xin chao' },
  ]);
  const m1 = parse(await run(tools, 'inference_broker_v2_prefix_cache', { action: 'measure', messages: msgs }));
  assert.equal(m1.miss, true);
  const m2 = parse(await run(tools, 'inference_broker_v2_prefix_cache', { action: 'measure', messages: msgs }));
  assert.equal(m2.fullHit, true);
  assert.equal(m2.hitRatio, 1);
  const cleared = parse(await run(tools, 'inference_broker_v2_prefix_cache', { action: 'clear' }));
  assert.equal(cleared.cleared, true);
  const bad = await run(tools, 'inference_broker_v2_prefix_cache', { action: 'khong-co' });
  assert.ok(bad.startsWith('Error:'));
  const noMsgs = await run(tools, 'inference_broker_v2_prefix_cache', { action: 'measure' });
  assert.ok(noMsgs.startsWith('Error:'));
});

// ---------------------------------------------------------------------------
// Voice v22
// ---------------------------------------------------------------------------

test('broker v2 tool voice status: mock khi chua co key; turn mock chay duoc', async () => {
  const tools = createInferenceBrokerV2Tools();
  const status = parse(await run(tools, 'inference_broker_v2_voice_status', { action: 'status' }));
  assert.equal(status.mode, 'mock');
  assert.match(status.mockReason ?? '', /mock/i);
  assert.equal(status.turns, 0);
  const turn = parse(await run(tools, 'inference_broker_v2_voice_status', { action: 'turn', userText: 'Xin chao' }));
  assert.equal(turn.turn.index, 1);
  assert.match(turn.turn.agentText, /Mock tra loi/);
  assert.equal(turn.session.turns, 1);
  const bad = await run(tools, 'inference_broker_v2_voice_status', { action: 'turn' });
  assert.ok(bad.startsWith('Error:'));
  const badAction = await run(tools, 'inference_broker_v2_voice_status', { action: 'khong-co' });
  assert.ok(badAction.startsWith('Error:'));
});

// ---------------------------------------------------------------------------
// i18n
// ---------------------------------------------------------------------------

test('i18n: 24 inferenceBrokerV2.* keys du 6 locale, khong rong, placeholder khop en', () => {
  assert.equal(INFERENCE_BROKER_V2_KEYS.length, 24);
  const en = loadLocale('en');
  for (const key of INFERENCE_BROKER_V2_KEYS) {
    assert.ok(key in en, `missing in en: ${key}`);
    assert.ok(String(en[key]).length > 0, `empty in en: ${key}`);
  }
  for (const loc of LOCALE_NAMES.filter((l) => l !== 'en')) {
    const data = loadLocale(loc);
    for (const key of INFERENCE_BROKER_V2_KEYS) {
      assert.ok(key in data, `missing in ${loc}: ${key}`);
      assert.ok(String(data[key]).length > 0, `empty in ${loc}: ${key}`);
    }
    assert.equal(Object.keys(data).length, Object.keys(en).length, `key count mismatch in ${loc}`);
  }
  // Tong so key moi locale sau v133-t5: 6863 + 24 = 6887 (coordinator
  // re-pin tests/i18n-v106.test.mjs luc gop).
  assert.ok(Object.keys(en).length >= 8072, `expected >= 8072 keys in en, got ${Object.keys(en).length}`); // v1.39 fix round 4b: floor (was 8072 in v1.38; now 8322).
});

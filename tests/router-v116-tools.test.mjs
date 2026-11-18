/**
 * Router v2 tools tests (v1.16, Doi T3 — node:test).
 *
 * Covers (module rieng, CHUA noi vao ALL_TOOLS):
 * - 8 tools, ten duy nhat, khop ROUTER_V2_TOOL_NAMES, needsApproval=false.
 * - discovery_scan: quet tmp models-dir co GGUF that.
 * - route_suggest: simple-chat -> local; thieu kind -> Error string.
 * - cli_toggle: bat/tat nguon; kind la -> ok:false.
 * - fallback_health: tra health cac nguon.
 * - model_status: tra status router (khong can model that).
 * - model_load/unload voi model khong ton tai -> ok:false, khong throw.
 * - parseRouterV2Preset: parse INI qua tools module.
 *
 * Imports the BUILT tools + core — build first:
 *   npm run build --workspace=@open-bot/core
 *   npm run build --workspace=@open-bot/tools
 * then: node --test tests/router-v116-tools.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  ROUTER_V2_TOOLS,
  ROUTER_V2_TOOL_NAMES,
  createDefaultRouterV2State,
  createRouterV2Tools,
  isRouterV2ToolName,
  parseRouterV2Preset,
} from '../packages/tools/dist/routerV2Tools.js';
import { GGUF_MAGIC } from '../packages/core/dist/routerV2/index.js';

function toolByName(tools, name) {
  const tool = tools.find((t) => t.definition.name === name);
  assert.ok(tool, `missing tool ${name}`);
  return tool;
}

async function run(tools, name, args) {
  return toolByName(tools, name).execute(args, {});
}

function parse(result) {
  assert.ok(!result.startsWith('Error:'), `expected JSON, got ${result}`);
  return JSON.parse(result);
}

function writeMiniGguf(dir, name) {
  const buf = Buffer.alloc(512);
  buf.writeUInt32LE(GGUF_MAGIC, 0);
  buf.writeUInt32LE(3, 4);
  buf.writeBigUInt64LE(0n, 8);
  buf.writeBigUInt64LE(0n, 16);
  writeFileSync(join(dir, name), buf);
}

test('router v2 tools: 8 tools, unique names, no approval', () => {
  assert.equal(ROUTER_V2_TOOLS.length, 8);
  assert.deepEqual(
    ROUTER_V2_TOOLS.map((t) => t.definition.name),
    [...ROUTER_V2_TOOL_NAMES],
  );
  assert.equal(new Set(ROUTER_V2_TOOLS.map((t) => t.definition.name)).size, 8);
  for (const name of ROUTER_V2_TOOL_NAMES) {
    assert.equal(isRouterV2ToolName(name), true);
  }
  assert.equal(isRouterV2ToolName('router_v2_khong_co'), false);
  for (const tool of ROUTER_V2_TOOLS) {
    assert.equal(tool.needsApproval, false);
    assert.ok(tool.definition.description.length > 0);
  }
});

test('discovery_scan: finds GGUF in tmp models-dir', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'r2-tools-'));
  writeMiniGguf(dir, 'qwen3-4b.gguf');
  const state = createDefaultRouterV2State({ config: { modelsDirs: [dir], presetPaths: [] } });
  const tools = createRouterV2Tools(state);
  const res = parse(await run(tools, 'router_v2_discovery_scan', {}));
  assert.equal(res.total, 1);
  assert.equal(res.models[0].id, 'qwen3-4b');
  assert.equal(res.models[0].validGguf, true);
  assert.ok(res.models[0].estimatedFootprintBytes > 0);
});

test('route_suggest: simple-chat -> local; missing kind -> Error', async () => {
  const tools = createRouterV2Tools(createDefaultRouterV2State());
  const res = parse(await run(tools, 'router_v2_route_suggest', { kind: 'simple-chat', promptTokens: 100 }));
  assert.equal(res.source, 'local');
  assert.ok(res.best.length > 0);
  assert.ok(res.reason.length > 10);
  assert.ok(res.ranked.length > 0);
  const err = await run(tools, 'router_v2_route_suggest', {});
  assert.ok(err.startsWith('Error:'));
});

test('route_suggest: heavy code -> strong model (cli/cloud)', async () => {
  const tools = createRouterV2Tools(createDefaultRouterV2State());
  const res = parse(await run(tools, 'router_v2_route_suggest', {
    kind: 'code', promptTokens: 9000, needsToolUse: true, needsLongContext: true, qualityNeed: 0.95,
  }));
  assert.ok(['cli', 'cloud'].includes(res.source));
});

test('cli_toggle: enable/disable known kinds; unknown kind -> ok:false', async () => {
  const tools = createRouterV2Tools(createDefaultRouterV2State());
  const on = parse(await run(tools, 'router_v2_cli_toggle', { kind: 'claude', enabled: true }));
  assert.equal(on.ok, true);
  assert.equal(on.kind, 'claude');
  assert.equal(on.enabled, true);
  const off = parse(await run(tools, 'router_v2_cli_toggle', { kind: 'claude', enabled: false }));
  assert.equal(off.ok, true);
  const bad = parse(await run(tools, 'router_v2_cli_toggle', { kind: 'khong-co', enabled: true }));
  assert.equal(bad.ok, false);
});

test('fallback_health + model_status: answer without real models', async () => {
  const tools = createRouterV2Tools(createDefaultRouterV2State());
  const health = parse(await run(tools, 'router_v2_fallback_health', {}));
  assert.ok(Array.isArray(health.sources));
  assert.ok(health.sources.length >= 3);
  assert.ok(health.sources.every((s) => s.circuit === 'closed'));
  const status = parse(await run(tools, 'router_v2_model_status', {}));
  assert.equal(status.discoveredModels, 0);
  assert.deepEqual(status.loadedModels, []);
  assert.ok(status.resources.totalRamBytes > 0);
});

test('model_load/unload: unknown model -> ok:false, never throws', async () => {
  const tools = createRouterV2Tools(createDefaultRouterV2State());
  const load = parse(await run(tools, 'router_v2_model_load', { modelId: 'khong-co' }));
  assert.equal(load.ok, false);
  assert.equal(load.reason, 'not-found');
  const unload = parse(await run(tools, 'router_v2_model_unload', { modelId: 'khong-co' }));
  assert.equal(unload.ok, false);
  const err = await run(tools, 'router_v2_model_load', {});
  assert.ok(err.startsWith('Error:'));
});

test('parseRouterV2Preset: parses INI text', () => {
  const { presets } = parseRouterV2Preset('[model:qwen3-4b]\ncontext_size = 4096\n', '/tmp/x.ini');
  assert.equal(presets.length, 1);
  assert.equal(presets[0].flags.contextSize, 4096);
});

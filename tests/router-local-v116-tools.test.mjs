/**
 * Router local v116 tools tests (v1.39, Doi T3 — node:test, no
 * network beyond loopback, no Ollama ambient, no real CLI).
 *
 * Covers:
 * - Registration: all 11 router-local v116 tools in ALL_TOOLS,
 *   unique names, no duplicates; ROUTER_LOCAL_V116_TOOLS order
 *   matches the names list.
 * - Score rank: light task -> local with ranked reasons; profile
 *   switching changes the ranking; bad kind/profile -> Error string.
 * - Policy profiles: list (5 profiles + current), set (balanced ->
 *   quality-first -> custom with normalized weights).
 * - Fallback run: dead-port endpoints -> succeeded=false + breaker
 *   opens after repeated runs; live loopback server endpoint ->
 *   succeeded=true; non-loopback endpoint -> unreachable attempt.
 * - Fallback status: breaker snapshots after runs.
 * - CLI sources: list (18 kinds incl. 6 new V116) without detect;
 *   detect with fake binaries (tmpdir PATH) finds crush; setEnabled
 *   toggles opt-in; unknown kind -> Error string.
 * - Batch estimate/schedule: real numbers, over-capacity flagged,
 *   bad requests -> Error string.
 * - Health probe: dead port -> unreachable; live server -> healthy;
 *   non-loopback refused; metrics text parsed.
 * - Tool arg validation: missing required args return Error strings,
 *   never throw.
 *
 * Imports the BUILT tools + core — build first:
 *   npm run build --workspace=@open-bot/core
 *   npm run build --workspace=@open-bot/tools
 * then: node --test tests/router-local-v116-tools.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DetectedEngineRegistry } from '../packages/core/dist/detected/index.js';
import { ALL_TOOLS } from '../packages/tools/dist/tools.js';
import {
  ROUTER_LOCAL_V116_TOOL_NAMES,
  ROUTER_LOCAL_V116_TOOLS,
  createDefaultRouterLocalV116State,
  createRouterLocalV116Tools,
  isRouterLocalV116ToolName,
} from '../packages/tools/dist/routerLocalV116Tools.js';
import { CliSourceRegistry } from '../packages/core/dist/router/local/index.js';

const servers = [];

function startServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      servers.push(server);
      resolve({ server, port: server.address().port });
    });
  });
}

async function deadPort() {
  const { server, port } = await startServer(() => {});
  await new Promise((r) => server.close(r));
  servers.pop();
  return port;
}

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

test('router local v116 tools: 13 tools in ALL_TOOLS, unique names', () => {
  const names = ALL_TOOLS.map((t) => t.definition.name);
  assert.equal(new Set(names).size, names.length, 'ALL_TOOLS co ten trung');
  for (const name of ROUTER_LOCAL_V116_TOOL_NAMES) {
    assert.ok(names.includes(name), `ALL_TOOLS thieu ${name}`);
  }
  assert.deepEqual(
    ROUTER_LOCAL_V116_TOOLS.map((t) => t.definition.name),
    [...ROUTER_LOCAL_V116_TOOL_NAMES],
  );
  assert.equal(isRouterLocalV116ToolName('router_local_score_rank'), true);
  assert.equal(isRouterLocalV116ToolName('router_local_catalog_list'), false);
});

test('score rank: light task -> local with reasons; profile changes ranking', async () => {
  const tools = createRouterLocalV116Tools(createDefaultRouterLocalV116State());
  const light = parse(await run(tools, 'router_local_score_rank', { kind: 'simple-chat', promptTokens: 100 }));
  assert.equal(light.profile, 'balanced');
  assert.ok(light.chosen);
  assert.equal(light.chosen.kind, 'local');
  assert.ok(light.ranked.length > 5);
  assert.ok(light.ranked[0].reasons.length >= 1);
  assert.ok(light.decisionLogId.startsWith('route-'));
  const quality = parse(await run(tools, 'router_local_score_rank', {
    kind: 'simple-chat', promptTokens: 100, profileId: 'quality-first',
  }));
  assert.equal(quality.profile, 'quality-first');
  assert.ok(quality.chosen === null || quality.chosen.quality >= 0.8);
  const badKind = await run(tools, 'router_local_score_rank', { kind: 'khong-co' });
  assert.ok(badKind.startsWith('Error:'));
  const badProfile = await run(tools, 'router_local_score_rank', { kind: 'code', profileId: 'khong-co' });
  assert.ok(badProfile.startsWith('Error:'));
  const missing = await run(tools, 'router_local_score_rank', {});
  assert.ok(missing.startsWith('Error:'));
});

test('policy profiles: list + set (incl. custom weights normalized)', async () => {
  const tools = createRouterLocalV116Tools(createDefaultRouterLocalV116State());
  const list = parse(await run(tools, 'router_local_policy_profile_list', {}));
  assert.equal(list.current, 'balanced');
  assert.equal(list.profiles.length, 5);
  assert.ok(list.profiles.some((p) => p.id === 'privacy-first' && p.localOnly === true));
  const set = parse(await run(tools, 'router_local_policy_profile_set', { profileId: 'latency-first' }));
  assert.equal(set.current, 'latency-first');
  const list2 = parse(await run(tools, 'router_local_policy_profile_list', {}));
  assert.equal(list2.current, 'latency-first', 'set phai doi current');
  const custom = parse(await run(tools, 'router_local_policy_profile_set', {
    profileId: 'custom', customCost: 2, customLatency: 1, customQuality: 1,
  }));
  assert.equal(custom.current, 'custom');
  assert.ok(Math.abs(custom.weights.cost - 0.5) < 1e-9);
  const bad = await run(tools, 'router_local_policy_profile_set', { profileId: 'khong-co' });
  assert.ok(bad.startsWith('Error:'));
});

test('fallback run: dead ports fail + breaker opens; live server wins', async (t) => {
  t.after(() => { for (const s of servers.splice(0)) { try { s.close(); } catch {} } });
  const state = createDefaultRouterLocalV116State();
  const tools = createRouterLocalV116Tools(state);
  const dead1 = await deadPort();
  const dead2 = await deadPort();
  const fail1 = parse(await run(tools, 'router_local_fallback_run', {
    endpoints: [`http://127.0.0.1:${dead1}`, `http://127.0.0.1:${dead2}`],
    timeoutMs: 1000,
  }));
  assert.equal(fail1.succeeded, false);
  assert.equal(fail1.endpoint, null);
  assert.equal(fail1.attempts.length, 2);
  assert.ok(fail1.attempts.every((a) => a.outcome === 'failed'));
  // Live server o cuoi chain -> thang.
  const { port } = await startServer((req, res) => {
    if (req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'qwen3-4b' }] }));
    } else {
      res.writeHead(200);
      res.end('ok');
    }
  });
  const win = parse(await run(tools, 'router_local_fallback_run', {
    endpoints: [`http://127.0.0.1:${dead1}`, `http://127.0.0.1:${port}`],
    timeoutMs: 2000,
  }));
  assert.equal(win.succeeded, true);
  assert.equal(win.endpoint, `http://127.0.0.1:${port}`);
  assert.equal(win.attempts[1].outcome, 'success');
  // Breaker cua dead1 da ghi 2 loi; chay them 1 lan nua (nguong 3) thi mo.
  await run(tools, 'router_local_fallback_run', {
    endpoints: [`http://127.0.0.1:${dead1}`],
    timeoutMs: 1000,
  });
  const status = parse(await run(tools, 'router_local_fallback_status', {}));
  const deadBreaker = status.breakers.find((b) => b.modelId === `http://127.0.0.1:${dead1}`);
  assert.ok(deadBreaker);
  assert.equal(deadBreaker.state, 'open');
  assert.equal(deadBreaker.consecutiveFailures, 3);
  // Lan tiep: dead1 bi bo qua (skipped-open), khong goi probe.
  const skipped = parse(await run(tools, 'router_local_fallback_run', {
    endpoints: [`http://127.0.0.1:${dead1}`],
    timeoutMs: 1000,
  }));
  assert.equal(skipped.succeeded, false);
  assert.equal(skipped.attempts[0].outcome, 'skipped-open');
  const badArgs = await run(tools, 'router_local_fallback_run', { endpoints: [] });
  assert.ok(badArgs.startsWith('Error:'));
  const nonLoopback = parse(await run(tools, 'router_local_fallback_run', {
    endpoints: ['http://example.com:11434'],
    timeoutMs: 1000,
  }));
  assert.equal(nonLoopback.succeeded, false);
  assert.ok(nonLoopback.attempts[0].error.includes('loopback'));
});

test('CLI sources: list 18 kinds, detect fake binary, opt-in toggle', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'open-bot-v116-tools-cli-'));
  t.after(() => { rmSync(dir, { recursive: true, force: true }); for (const s of servers.splice(0)) { try { s.close(); } catch {} } });
  const crushBin = join(dir, 'crush');
  writeFileSync(crushBin, '#!/bin/sh\necho "crush 0.9.1"\n', 'utf8');
  chmodSync(crushBin, 0o755);
  const registry = new DetectedEngineRegistry({ pathDirs: [dir], env: { PATH: '' }, cacheTtlMs: 0, logger: { warn: () => {} } });
  const state = createDefaultRouterLocalV116State();
  state.cli = new CliSourceRegistry({ registry });
  const tools = createRouterLocalV116Tools(state);
  const before = parse(await run(tools, 'router_local_cli_sources_list', {}));
  assert.equal(before.detected, false);
  assert.equal(before.total, 18, '12 cu + 6 moi V116');
  assert.equal(before.newInV116, 6);
  assert.ok(before.sources.some((s) => s.kind === 'crush' && s.isNewInV116));
  const detected = parse(await run(tools, 'router_local_cli_source_detect', { force: true }));
  assert.equal(detected.total, 18);
  assert.equal(detected.unknown, 1, 'chi crush co binary gia -> unknown');
  assert.equal(detected.available, 0);
  const crush = detected.sources.find((s) => s.kind === 'crush');
  assert.equal(crush.status, 'unknown');
  assert.equal(crush.usable, false, 'chua bat thi chua dung duoc');
  const enabled = parse(await run(tools, 'router_local_cli_source_set', { kind: 'crush', enabled: true }));
  assert.equal(enabled.enabled, true);
  assert.equal(enabled.usable, true);
  assert.ok(enabled.describe.includes('Crush'));
  const after = parse(await run(tools, 'router_local_cli_sources_list', {}));
  assert.equal(after.usable, 1);
  const disabled = parse(await run(tools, 'router_local_cli_source_set', { kind: 'crush', enabled: false }));
  assert.equal(disabled.enabled, false);
  assert.equal(disabled.usable, false);
  const bad = await run(tools, 'router_local_cli_source_set', { kind: 'khong-co', enabled: true });
  assert.ok(bad.startsWith('Error:'));
});

test('batch estimate + schedule: real numbers, over-capacity, validation', async () => {
  const tools = createRouterLocalV116Tools(createDefaultRouterLocalV116State());
  const est = parse(await run(tools, 'router_local_batch_estimate', {
    requests: [
      { id: 'a', promptTokens: 500, expectedCompletionTokens: 100 },
      { id: 'b', promptTokens: 500, expectedCompletionTokens: 100 },
      { id: 'c', promptTokens: 500, expectedCompletionTokens: 100 },
    ],
  }));
  assert.equal(est.estimate.batchSize, 3);
  assert.ok(est.estimate.avgTtftMs > 0);
  assert.ok(est.estimate.throughputTokensPerSec > 0);
  assert.ok(est.vsSolo.speedup >= 1);
  const over = parse(await run(tools, 'router_local_batch_estimate', {
    requests: Array.from({ length: 40 }, (_, i) => ({ id: `r${i}`, promptTokens: 10, expectedCompletionTokens: 10 })),
  }));
  assert.equal(over.estimate.overCapacity, true);
  const bad = await run(tools, 'router_local_batch_estimate', { requests: [{ promptTokens: -1, expectedCompletionTokens: 5 }] });
  assert.ok(bad.startsWith('Error:'));
  const empty = await run(tools, 'router_local_batch_estimate', { requests: [] });
  assert.ok(empty.startsWith('Error:'));
  const sched = parse(await run(tools, 'router_local_batch_schedule', {
    requests: [
      { id: 'x', promptTokens: 100, expectedCompletionTokens: 10, arrivedAt: 1 },
      { id: 'y', promptTokens: 100, expectedCompletionTokens: 10, arrivedAt: 2 },
      { id: 'z', promptTokens: 100, expectedCompletionTokens: 10, arrivedAt: 3 },
    ],
    maxNumSeqs: 2,
  }));
  assert.equal(sched.totalRequests, 3);
  assert.equal(sched.batches, 2);
  assert.deepEqual(sched.batchesDetail[0].requestIds, ['x', 'y']);
});

test('picker list + decision log: entries merged, log records decisions', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'open-bot-v116-tools-picker-'));
  t.after(() => { rmSync(dir, { recursive: true, force: true }); for (const s of servers.splice(0)) { try { s.close(); } catch {} } });
  const crushBin = join(dir, 'crush');
  writeFileSync(crushBin, '#!/bin/sh\necho "crush 0.9.1"\n', 'utf8');
  chmodSync(crushBin, 0o755);
  const registry = new DetectedEngineRegistry({ pathDirs: [dir], env: { PATH: '' }, cacheTtlMs: 0, logger: { warn: () => {} } });
  const state = createDefaultRouterLocalV116State();
  state.cli = new CliSourceRegistry({ registry });
  const tools = createRouterLocalV116Tools(state);
  // Chua detect + chua bat CLI: picker chi co local + cloud.
  const plain = parse(await run(tools, 'router_local_picker_list', {}));
  assert.ok(plain.entries.length >= 10);
  assert.ok(plain.entries.some((e) => e.source === 'local'));
  assert.ok(plain.entries.some((e) => e.source === 'cloud'));
  assert.equal(plain.summary.bySource.cli ?? 0, 0);
  // Detect + bat crush (status unknown — auth chua kiem chung, nhung
  // user bat tay thi duoc thu): picker co muc CLI.
  await run(tools, 'router_local_cli_source_detect', { force: true });
  await run(tools, 'router_local_cli_source_set', { kind: 'crush', enabled: true });
  const withCli = parse(await run(tools, 'router_local_picker_list', { includeCliSources: true }));
  const cliEntry = withCli.entries.find((e) => e.modelId === 'cli:crush:default');
  assert.ok(cliEntry, 'picker phai co muc CLI khi nguon da bat');
  assert.equal(cliEntry.source, 'cli');
  assert.equal(cliEntry.viaCli, 'crush');
  assert.ok(cliEntry.label.includes('chua ro tai khoan'), cliEntry.label);
  // Score rank voi CLI: CLI thang khi diem cao nhat (cost 0).
  const ranked = parse(await run(tools, 'router_local_score_rank', { kind: 'simple-chat', includeCliSources: true }));
  assert.equal(ranked.chosen.modelId, 'cli:crush:default');
  // Decision log ghi lai quyet dinh vua roi.
  const log = parse(await run(tools, 'router_local_decision_log', {}));
  assert.ok(log.total >= 1);
  assert.equal(log.entries[0].id, ranked.decisionLogId);
  assert.equal(log.entries[0].chosen.modelId, 'cli:crush:default');
  const one = parse(await run(tools, 'router_local_decision_log', { id: ranked.decisionLogId }));
  assert.equal(one.entry.id, ranked.decisionLogId);
  const missing = await run(tools, 'router_local_decision_log', { id: 'route-khong-co' });
  assert.ok(missing.startsWith('Error:'));
  const badKind = await run(tools, 'router_local_picker_list', { kind: 'khong-co' });
  assert.ok(badKind.startsWith('Error:'));
});

test('health probe: live vLLM /metrics fetched + parsed', async (t) => {
  t.after(() => { for (const s of servers.splice(0)) { try { s.close(); } catch {} } });
  const tools = createRouterLocalV116Tools(createDefaultRouterLocalV116State());
  const { port } = await startServer((req, res) => {
    if (req.url === '/metrics') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('vllm:num_requests_running 4\nvllm:num_requests_waiting 2\nvllm:kv_cache_usage_perc 0.31\n');
    } else if (req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'qwen3-8b' }] }));
    } else {
      res.writeHead(200);
      res.end('ok');
    }
  });
  const result = parse(await run(tools, 'router_local_health_probe', {
    baseUrls: [`http://127.0.0.1:${port}`],
    timeoutMs: 2000,
    vllmMetricsUrl: `http://127.0.0.1:${port}`,
  }));
  assert.equal(result.results[0].status, 'healthy');
  assert.ok(result.liveVllmMetrics);
  assert.equal(result.liveVllmMetrics.snapshot.numRunning, 4);
  assert.equal(result.liveVllmMetrics.snapshot.numWaiting, 2);
  assert.equal(result.liveVllmMetrics.snapshot.kvCacheUsage, 0.31);
  // URL khong phai loopback: live metrics bi bo qua (null), probe van chay.
  const refused = parse(await run(tools, 'router_local_health_probe', {
    baseUrls: [`http://127.0.0.1:${port}`],
    timeoutMs: 2000,
    vllmMetricsUrl: 'http://example.com:8000',
  }));
  assert.equal(refused.liveVllmMetrics, null);
});

test('health probe: dead port unreachable, live server healthy, metrics parsed', async (t) => {
  t.after(() => { for (const s of servers.splice(0)) { try { s.close(); } catch {} } });
  const tools = createRouterLocalV116Tools(createDefaultRouterLocalV116State());
  const dead = await deadPort();
  const { port } = await startServer((req, res) => {
    if (req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'm1' }] }));
    } else {
      res.writeHead(200);
      res.end('ok');
    }
  });
  const result = parse(await run(tools, 'router_local_health_probe', {
    baseUrls: [`http://127.0.0.1:${dead}`, `http://127.0.0.1:${port}`],
    timeoutMs: 2000,
    metricsText: 'vllm:num_requests_running 2\nvllm:num_requests_waiting 1\n',
  }));
  assert.equal(result.results.length, 2);
  assert.equal(result.results[0].status, 'unreachable');
  assert.equal(result.results[1].status, 'healthy');
  assert.equal(result.healthiest, `http://127.0.0.1:${port}`);
  assert.equal(result.vllmMetrics.numRunning, 2);
  assert.equal(result.vllmMetrics.numWaiting, 1);
  assert.equal(result.summaries.length, 2);
  const deadSummary = result.summaries.find((s) => s.baseUrl === `http://127.0.0.1:${dead}`);
  assert.equal(deadSummary.uptimeRatio, 0);
  const refused = parse(await run(tools, 'router_local_health_probe', {
    baseUrls: ['http://example.com:11434'],
    timeoutMs: 1000,
  }));
  assert.equal(refused.results[0].status, 'unreachable');
  assert.ok(refused.results[0].error.includes('loopback'));
  const empty = await run(tools, 'router_local_health_probe', { baseUrls: [] });
  assert.ok(empty.startsWith('Error:'));
});

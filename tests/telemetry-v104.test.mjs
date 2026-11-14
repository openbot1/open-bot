/**
 * Tests for telemetry v2 (packages/core/src/observability/runMetrics.ts
 * + packages/core/src/observability/otlp.ts).
 *
 * Covers run-metric recording/validation, JSONL persistence,
 * aggregation per run/model/tool (mean/p95 latency, cost, unknown
 * models), OTLP config validation (public hosts rejected, disabled
 * by default), payload building, and REAL OTLP/HTTP export against
 * a local loopback HTTP server (no mocks for the network path).
 *
 * Run after building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/telemetry-v104.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  aggregateRunMetrics,
  costOfRunMetric,
  getRunMetricsPath,
  parseRunMetricLine,
  readRunMetrics,
  recordRunMetric,
  summarizeRunMetricsFile,
  validateRunMetricInput,
} from '../packages/core/dist/observability/runMetrics.js';
import {
  buildOtlpMetricsPayload,
  buildOtlpTracesPayload,
  exportMetricsOtlp,
  exportTracesOtlp,
  isOtlpAllowedHost,
  otlpMetricsUrl,
  otlpTracesUrl,
  validateOtlpConfig,
} from '../packages/core/dist/observability/otlp.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-telemetry-'));
}

const T0 = 1_790_000_000_000;

function metricInput(overrides = {}) {
  return {
    runId: 'run-1',
    botId: 'bot-a',
    kind: 'model-call',
    model: 'gpt-5',
    durationMs: 1200,
    inputTokens: 1000,
    outputTokens: 200,
    ...overrides,
  };
}

function makeTrace() {
  return {
    runId: 'run-1',
    botId: 'bot-a',
    spans: [
      {
        id: 'span-1', traceId: 'trace-1', runId: 'run-1', botId: 'bot-a',
        kind: 'llm', name: 'gpt-5', startedAt: T0, endedAt: T0 + 1200,
        durationMs: 1200, status: 'ok',
        attributes: { model: 'gpt-5', inputTokens: 1000, outputTokens: 200 },
      },
    ],
  };
}

// --- run metrics ---------------------------------------------------------------

test('telemetry: validateRunMetricInput rejects bad input', () => {
  assert.throws(() => validateRunMetricInput({}), /runId/);
  assert.throws(() => validateRunMetricInput(metricInput({ kind: 'teleport' })), /kind/);
  assert.throws(() => validateRunMetricInput(metricInput({ kind: 'tool-call', tool: undefined })), /tool/);
  assert.throws(() => validateRunMetricInput(metricInput({ kind: 'model-call', model: null })), /model/);
  assert.throws(() => validateRunMetricInput(metricInput({ durationMs: -5 })), /durationMs/);
  assert.throws(() => validateRunMetricInput(metricInput({ inputTokens: -1 })), /inputTokens/);
  assert.throws(() => validateRunMetricInput(metricInput({ status: 'weird' })), /status/);
});

test('telemetry: record + read round-trip (JSONL, bad lines skipped)', () => {
  const dir = tmpDir();
  assert.deepEqual(readRunMetrics(dir), []);
  const m1 = recordRunMetric(dir, metricInput(), T0);
  assert.equal(m1.costUsd === null || typeof m1.costUsd === 'number', true, 'cost is a number or null, never invented');
  assert.equal(m1.model, 'gpt-5');
  const m2 = recordRunMetric(dir, metricInput({ kind: 'tool-call', model: null, tool: 'web_search', durationMs: 300, inputTokens: 0, outputTokens: 0 }), T0 + 100);
  assert.equal(m2.costUsd, null, 'tool calls without a model have no cost');
  const m3 = recordRunMetric(dir, metricInput({ runId: 'run-2', model: 'local:llama', durationMs: 500 }), T0 + 200);
  assert.equal(m3.costUsd, 0, 'local models cost $0');
  // Corrupt line in the file is skipped, not fatal.
  fs.appendFileSync(getRunMetricsPath(dir), '{broken json\n', 'utf8');
  const read = readRunMetrics(dir);
  assert.equal(read.length, 3);
  assert.equal(read[0].runId, 'run-1');
  assert.equal(parseRunMetricLine('{broken'), null);
  assert.equal(parseRunMetricLine(''), null);
});

test('telemetry: aggregateRunMetrics groups by run/model/tool', () => {
  const metrics = [
    { ...metricInput(), runId: 'run-1', durationMs: 1000, inputTokens: 100, outputTokens: 10 },
    { ...metricInput(), runId: 'run-1', kind: 'tool-call', model: null, tool: 'web_search', durationMs: 200, inputTokens: 0, outputTokens: 0 },
    { ...metricInput(), runId: 'run-2', model: 'mystery-model-xyz', durationMs: 500, inputTokens: 50, outputTokens: 5 },
    { ...metricInput(), runId: 'run-2', model: 'gpt-5', durationMs: 300, inputTokens: 10, outputTokens: 1, status: 'error', error: 'timeout' },
  ].map((input) => {
    const valid = validateRunMetricInput(input);
    return {
      runId: valid.runId, botId: valid.botId, kind: valid.kind, model: valid.model ?? null,
      tool: valid.tool ?? null, durationMs: valid.durationMs, inputTokens: valid.inputTokens ?? 0,
      outputTokens: valid.outputTokens ?? 0, costUsd: costOfRunMetric(valid), status: valid.status ?? 'ok',
      ...(valid.error ? { error: valid.error } : {}), at: T0,
    };
  });
  const agg = aggregateRunMetrics(metrics);
  assert.equal(agg.totalRecords, 4);
  assert.equal(agg.totalRuns, 2);
  assert.equal(agg.totalDurationMs, 2000);
  assert.equal(agg.errors, 1);
  assert.deepEqual(agg.unknownCostModels, ['mystery-model-xyz']);
  assert.equal(agg.byRun.length, 2);
  assert.equal(agg.byRun.find((g) => g.key === 'run-1').count, 2);
  assert.equal(agg.byModel.find((g) => g.key === 'gpt-5').count, 2);
  assert.equal(agg.byModel.find((g) => g.key === 'gpt-5').meanDurationMs, 650);
  assert.equal(agg.byTool.length, 1);
  assert.equal(agg.byTool[0].key, 'web_search');
  assert.equal(agg.byTool[0].p95DurationMs, 200);
  // File-based summary agrees with the pure aggregate.
  const dir = tmpDir();
  for (const m of metrics) recordRunMetric(dir, { runId: m.runId, botId: m.botId, kind: m.kind, model: m.model, tool: m.tool, durationMs: m.durationMs, inputTokens: m.inputTokens, outputTokens: m.outputTokens, status: m.status });
  const fromFile = summarizeRunMetricsFile(dir);
  assert.equal(fromFile.totalRecords, 4);
  assert.equal(fromFile.totalRuns, 2);
});

// --- OTLP config -----------------------------------------------------------------

test('telemetry: OTLP config — disabled by default, public hosts rejected', () => {
  assert.throws(() => validateOtlpConfig({}), /boolean/);
  assert.throws(() => validateOtlpConfig({ enabled: true, endpoint: 'https://otlp.example.com' }), /not loopback or private LAN/);
  assert.throws(() => validateOtlpConfig({ enabled: true, endpoint: 'http://8.8.8.8:4318' }), /not loopback or private LAN/);
  assert.throws(() => validateOtlpConfig({ enabled: true, endpoint: 'ftp://127.0.0.1:4318' }), /http/);
  assert.throws(() => validateOtlpConfig({ enabled: true, endpoint: 'http://user:pass@127.0.0.1:4318' }), /credentials/);
  assert.throws(() => validateOtlpConfig({ enabled: true, endpoint: 'not a url' }), /valid URL/);
  assert.throws(() => validateOtlpConfig({ enabled: true, timeoutMs: 0 }), /timeoutMs/);
  const ok = validateOtlpConfig({ enabled: true, endpoint: 'http://127.0.0.1:4318' });
  assert.equal(ok.enabled, true);
  assert.equal(validateOtlpConfig({ enabled: false }).endpoint, undefined);
  assert.equal(isOtlpAllowedHost('192.168.1.5'), true);
  assert.equal(isOtlpAllowedHost('10.1.2.3'), true);
  assert.equal(isOtlpAllowedHost('172.32.0.1'), false);
  assert.equal(otlpTracesUrl('http://127.0.0.1:4318'), 'http://127.0.0.1:4318/v1/traces');
  assert.equal(otlpTracesUrl('http://127.0.0.1:4318/v1/traces'), 'http://127.0.0.1:4318/v1/traces');
  assert.equal(otlpTracesUrl('http://127.0.0.1:4318/'), 'http://127.0.0.1:4318/v1/traces');
  assert.equal(otlpMetricsUrl('http://127.0.0.1:4318'), 'http://127.0.0.1:4318/v1/metrics');
});

test('telemetry: OTLP payload builders reuse traceToOtel + run metrics', () => {
  const payload = buildOtlpTracesPayload([makeTrace()]);
  assert.equal(payload.resourceSpans.length, 1);
  assert.equal(payload.resourceSpans[0].scopeSpans[0].spans.length, 1);
  assert.equal(payload.resourceSpans[0].scopeSpans[0].spans[0].name, 'llm:gpt-5');
  const agg = aggregateRunMetrics([
    { runId: 'run-1', botId: 'bot-a', kind: 'model-call', model: 'gpt-5', tool: null, durationMs: 1000, inputTokens: 100, outputTokens: 10, costUsd: 0.001, status: 'ok', at: T0 },
    { runId: 'run-1', botId: 'bot-a', kind: 'tool-call', model: null, tool: 'web_search', durationMs: 200, inputTokens: 0, outputTokens: 0, costUsd: null, status: 'ok', at: T0 },
  ]);
  const metrics = buildOtlpMetricsPayload(agg);
  const names = metrics.resourceMetrics[0].scopeMetrics[0].metrics.map((m) => m.name);
  assert.ok(names.includes('openbot.run.duration_ms'));
  assert.ok(names.includes('openbot.run.cost_usd'));
  assert.ok(names.includes('openbot.model.duration_ms'));
  assert.ok(names.includes('openbot.tool.duration_ms'));
});

// --- real OTLP export against a local server ---------------------------------------

/** Start a loopback HTTP server that records OTLP posts. */
function startCollector() {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      requests.push({ url: req.url, method: req.method, contentType: req.headers['content-type'], body });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({ server, port: address.port, requests });
    });
  });
}

test('telemetry: exportTracesOtlp posts real OTLP/HTTP JSON to a local collector', async () => {
  const { server, port, requests } = await startCollector();
  try {
    // Disabled → nothing is sent, no network touched.
    const disabled = await exportTracesOtlp({ enabled: false, endpoint: `http://127.0.0.1:${port}` }, [makeTrace()]);
    assert.equal(disabled.sent, false);
    assert.equal(disabled.reason, 'disabled');
    assert.equal(requests.length, 0);
    // No traces → nothing sent.
    const empty = await exportTracesOtlp({ enabled: true, endpoint: `http://127.0.0.1:${port}` }, []);
    assert.equal(empty.sent, false);
    assert.equal(empty.reason, 'no-traces');
    // Enabled → one POST to /v1/traces with OTLP JSON.
    const result = await exportTracesOtlp({ enabled: true, endpoint: `http://127.0.0.1:${port}` }, [makeTrace()]);
    assert.equal(result.sent, true);
    assert.equal(result.status, 200);
    assert.equal(result.spansSent, 1);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, '/v1/traces');
    assert.equal(requests[0].method, 'POST');
    assert.equal(requests[0].contentType, 'application/json');
    const parsed = JSON.parse(requests[0].body);
    assert.equal(parsed.resourceSpans.length, 1);
    assert.equal(parsed.resourceSpans[0].scopeSpans[0].spans[0].name, 'llm:gpt-5');
  } finally {
    server.close();
  }
});

test('telemetry: exportMetricsOtlp posts to /v1/metrics; unreachable endpoint fails cleanly', async () => {
  const { server, port, requests } = await startCollector();
  try {
    const agg = aggregateRunMetrics([
      { runId: 'run-1', botId: 'bot-a', kind: 'model-call', model: 'gpt-5', tool: null, durationMs: 1000, inputTokens: 100, outputTokens: 10, costUsd: 0.001, status: 'ok', at: T0 },
    ]);
    const result = await exportMetricsOtlp({ enabled: true, endpoint: `http://127.0.0.1:${port}` }, agg);
    assert.equal(result.sent, true);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, '/v1/metrics');
    const parsed = JSON.parse(requests[0].body);
    assert.equal(parsed.resourceMetrics[0].scopeMetrics[0].metrics[0].name, 'openbot.run.duration_ms');
  } finally {
    server.close();
  }
  // Unreachable collector (nothing listening) → sent false + error, no throw.
  const down = await exportTracesOtlp({ enabled: true, endpoint: 'http://127.0.0.1:9', timeoutMs: 1000 }, [makeTrace()]);
  assert.equal(down.sent, false);
  assert.equal(down.reason, 'error');
  assert.ok(down.error);
});

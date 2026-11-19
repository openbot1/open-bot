/**
 * Local model router v116 batching + health tests (v1.39, Doi T3 —
 * node:test, no network beyond loopback, no Ollama ambient).
 *
 * Covers:
 * - Batching estimator: empty batch, TTFT grows with prefill order,
 *   throughput > 0, KV utilization, over-capacity (max seqs / KV),
 *   bottleneck classification, batch-vs-solo speedup >= 1.
 * - Admission: rejects over max seqs / over max len / KV full, with
 *   a clear reason; admits when there is room.
 * - BatchScheduler: splits a queue into batches by capacity,
 *   short-job-first reorders within the queue, FIFO keeps arrival order.
 * - parseVllmMetrics: parses Prometheus text (running/waiting/TTFT),
 *   ignores comments and unknown metrics.
 * - Health probe: real local HTTP server on an ephemeral port
 *   (healthy + models list); dead port -> unreachable (hermetic —
 *   never touches the ambient Ollama port); non-loopback URL refused;
 *   401 -> auth-required; history tracks uptime + consecutive failures.
 *
 * Imports the BUILT core — build first:
 *   npm run build --workspace=@open-bot/core
 * then: node --test tests/router-local-v116-batching-health.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import {
  BatchScheduler,
  DEFAULT_BATCHING_CONFIG,
  LocalEndpointHealthHistory,
  admitRequest,
  batchingConfigForModel,
  compareBatchVsSolo,
  estimateBatch,
  findLocalModel,
  parseVllmMetrics,
  probeEndpoints,
  probeLocalEndpoint,
  probeVllmMetrics,
} from '../packages/core/dist/router/local/index.js';

const servers = [];

/** Start a tiny HTTP server on an ephemeral loopback port. */
function startServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      servers.push(server);
      resolve({ server, port: server.address().port });
    });
  });
}

/** Get a port that is free right now (bind then close) — the classic
 * dead-port trick, so the test never depends on ambient services. */
async function deadPort() {
  const { server, port } = await startServer(() => {});
  await new Promise((r) => server.close(r));
  servers.pop();
  return port;
}

function req(id, promptTokens, expectedCompletionTokens, extra = {}) {
  return { id, promptTokens, expectedCompletionTokens, ...extra };
}

test('estimateBatch: empty batch is zeroed, not NaN', () => {
  const e = estimateBatch([]);
  assert.equal(e.batchSize, 0);
  assert.equal(e.totalDurationMs, 0);
  assert.equal(e.throughputTokensPerSec, 0);
  assert.equal(e.overCapacity, false);
});

test('estimateBatch: TTFT grows with prefill order; throughput positive', () => {
  const requests = [req('a', 100, 50), req('b', 200, 50), req('c', 100, 200)];
  const e = estimateBatch(requests);
  assert.equal(e.batchSize, 3);
  assert.ok(e.perRequest[0].ttftMs < e.perRequest[1].ttftMs, 'request sau doi prefill request truoc');
  assert.ok(e.avgTtftMs > 0 && e.maxTtftMs >= e.avgTtftMs);
  assert.ok(e.totalDurationMs > 0);
  assert.ok(e.throughputTokensPerSec > 0);
  assert.ok(e.kvCacheUtilization > 0 && e.kvCacheUtilization < 1);
  assert.equal(e.overCapacity, false);
  assert.ok(['prefill-bound', 'decode-bound', 'balanced'].includes(e.bottleneck));
  // Request sinh nhieu token nhat thi finish muon nhat (cung TTFT gan nhau).
  assert.ok(e.perRequest[2].finishMs > e.perRequest[0].finishMs);
});

test('estimateBatch: over max seqs and over KV are flagged', () => {
  const many = Array.from({ length: 40 }, (_, i) => req(`r${i}`, 10, 10));
  const e1 = estimateBatch(many);
  assert.equal(e1.overCapacity, true);
  assert.ok(e1.notes.some((n) => n.includes('max_num_seqs')));
  const huge = [req('big', 100_000, 100_000)];
  const e2 = estimateBatch(huge, { ...DEFAULT_BATCHING_CONFIG, kvCacheBytes: 1024 * 1024 });
  assert.equal(e2.overCapacity, true);
  assert.equal(e2.bottleneck, 'kv-bound');
  assert.ok(e2.kvCacheUtilization > 1);
});

test('compareBatchVsSolo: batching is faster than running solo', () => {
  const requests = [req('a', 500, 100), req('b', 500, 100), req('c', 500, 100), req('d', 500, 100)];
  const { batch, soloTotalMs, speedup, savedMs } = compareBatchVsSolo(requests);
  assert.ok(speedup >= 1, `batch phai nhanh hon hoac bang solo, got ${speedup}`);
  assert.ok(savedMs >= 0);
  assert.ok(batch.totalDurationMs <= soloTotalMs);
});

test('admitRequest: rejects over-capacity with clear reasons', () => {
  const config = { ...DEFAULT_BATCHING_CONFIG, maxNumSeqs: 2, kvCacheBytes: 10 * 1024 };
  const running = [req('a', 100, 100), req('b', 100, 100)];
  const overSeqs = admitRequest(req('c', 10, 10), running, config);
  assert.equal(overSeqs.admitted, false);
  assert.ok(overSeqs.reason.includes('max_num_seqs'));
  const tooLong = admitRequest(req('long', 999_999, 1), [], config);
  assert.equal(tooLong.admitted, false);
  assert.ok(tooLong.reason.includes('max_model_len'));
  // KV: 10k prompt + 10k completion = 20k token (duoi max_model_len
  // 32768) nhung can 20k * 1024 B = ~20 MB KV, vuot 10 KB con lai.
  const kvFull = admitRequest(req('big', 10_000, 10_000), [], config);
  assert.equal(kvFull.admitted, false);
  assert.ok(kvFull.reason.includes('KV cache'));
  const ok = admitRequest(req('small', 10, 10), [], { ...config, kvCacheBytes: 10 * 1024 * 1024 });
  assert.equal(ok.admitted, true);
  assert.equal(ok.seqsAfter, 1);
  assert.ok(ok.kvRemainingBytes > 0);
});

test('BatchScheduler: splits by capacity, FIFO keeps order, short-job-first reorders', () => {
  const scheduler = new BatchScheduler({ maxNumSeqs: 2 });
  const requests = [
    req('first', 100, 10, { arrivedAt: 1 }),
    req('second', 100, 10, { arrivedAt: 2 }),
    req('third', 100, 10, { arrivedAt: 3 }),
  ];
  const fifo = scheduler.schedule(requests);
  assert.equal(fifo.length, 2, '3 request / max 2 seqs = 2 batch');
  assert.deepEqual(fifo[0].requests.map((r) => r.id), ['first', 'second']);
  assert.deepEqual(fifo[1].requests.map((r) => r.id), ['third']);
  assert.ok(fifo[1].startsAtMs >= fifo[0].startsAtMs + fifo[0].estimate.totalDurationMs - 1);
  const mixed = [
    req('long', 5000, 500, { arrivedAt: 1 }),
    req('short', 50, 10, { arrivedAt: 2 }),
    req('mid', 500, 50, { arrivedAt: 3 }),
  ];
  const sjf = scheduler.schedule(mixed, { shortJobFirst: true });
  assert.equal(sjf[0].requests[0].id, 'short', 'short-job-first dua request ngan len truoc');
  const fifoMixed = scheduler.schedule(mixed);
  assert.equal(fifoMixed[0].requests[0].id, 'long', 'FIFO giu thu tu den');
  // Priority cao hon luon truoc, bat ke thu tu den.
  const prio = scheduler.schedule([
    req('low', 100, 10, { arrivedAt: 1, priority: 0 }),
    req('high', 100, 10, { arrivedAt: 2, priority: 5 }),
  ]);
  assert.equal(prio[0].requests[0].id, 'high');
});

test('parseVllmMetrics: parses running/waiting/TTFT, ignores comments', () => {
  const text = `# HELP vllm:num_requests_running Number of requests running
# TYPE vllm:num_requests_running gauge
vllm:num_requests_running 3
vllm:num_requests_waiting 5
vllm:time_to_first_token_seconds_sum 1.25
vllm:kv_cache_usage_perc 0.42
vllm:some_other_metric 7
not-a-metric !!!
`;
  const snap = parseVllmMetrics(text);
  assert.equal(snap.numRunning, 3);
  assert.equal(snap.numWaiting, 5);
  assert.equal(snap.avgTtftSeconds, 1.25);
  assert.equal(snap.kvCacheUsage, 0.42);
  assert.equal(snap.extra['vllm:some_other_metric'], 7);
  assert.equal(parseVllmMetrics('').numRunning, null);
  assert.equal(parseVllmMetrics('garbage\nmore garbage').numWaiting, null);
});

test('probeLocalEndpoint: healthy server lists models (real loopback server)', async (t) => {
  t.after(() => { for (const s of servers.splice(0)) { try { s.close(); } catch {} } });
  const { port } = await startServer((req, res) => {
    if (req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'qwen3-4b' }, { id: 'llama-3.2-3b' }] }));
    } else if (req.url === '/health') {
      res.writeHead(200);
      res.end('ok');
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  const result = await probeLocalEndpoint(`http://127.0.0.1:${port}`, { timeoutMs: 2000 });
  assert.equal(result.status, 'healthy');
  assert.equal(result.reachable, true);
  assert.deepEqual(result.models, ['qwen3-4b', 'llama-3.2-3b']);
  assert.equal(result.hasHealthEndpoint, true);
  assert.ok(result.latencyMs >= 0);
});

test('probeLocalEndpoint: dead port -> unreachable (hermetic, no ambient Ollama)', async () => {
  const port = await deadPort();
  const result = await probeLocalEndpoint(`http://127.0.0.1:${port}`, { timeoutMs: 1000 });
  assert.equal(result.status, 'unreachable');
  assert.equal(result.reachable, false);
  assert.deepEqual(result.models, []);
  assert.ok(result.error.length > 0);
});

test('probeLocalEndpoint: non-loopback URL is refused without a network call', async () => {
  const result = await probeLocalEndpoint('http://example.com:11434', { timeoutMs: 1000 });
  assert.equal(result.status, 'unreachable');
  assert.ok(result.error.includes('loopback'));
});

test('probeLocalEndpoint: 401 -> auth-required (server alive, needs key)', async (t) => {
  t.after(() => { for (const s of servers.splice(0)) { try { s.close(); } catch {} } });
  const { port } = await startServer((_req, res) => {
    res.writeHead(401);
    res.end('unauthorized');
  });
  const result = await probeLocalEndpoint(`http://127.0.0.1:${port}`, { timeoutMs: 2000 });
  assert.equal(result.status, 'auth-required');
  assert.equal(result.reachable, true);
  assert.ok(result.error.includes('API key'));
});

test('probeLocalEndpoint: server without /health is still healthy via /v1/models', async (t) => {
  t.after(() => { for (const s of servers.splice(0)) { try { s.close(); } catch {} } });
  const { port } = await startServer((req, res) => {
    if (req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'm1' }] }));
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  const result = await probeLocalEndpoint(`http://127.0.0.1:${port}`, { timeoutMs: 2000 });
  assert.equal(result.status, 'healthy');
  assert.equal(result.hasHealthEndpoint, false);
});

test('probeEndpoints: healthiest is the fastest healthy endpoint', async (t) => {
  t.after(() => { for (const s of servers.splice(0)) { try { s.close(); } catch {} } });
  const { port } = await startServer((req, res) => {
    if (req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [] }));
    } else {
      res.writeHead(200);
      res.end('ok');
    }
  });
  const dead = await deadPort();
  const { results, healthiest } = await probeEndpoints(
    [`http://127.0.0.1:${dead}`, `http://127.0.0.1:${port}`],
    { timeoutMs: 2000 },
  );
  assert.equal(results.length, 2);
  assert.equal(results[0].status, 'unreachable');
  assert.equal(results[1].status, 'healthy');
  assert.equal(healthiest.baseUrl, `http://127.0.0.1:${port}`);
});

test('LocalEndpointHealthHistory: uptime ratio + consecutive failures', () => {
  const history = new LocalEndpointHealthHistory(10);
  const url = 'http://127.0.0.1:11434';
  const base = { baseUrl: url, reachable: true, latencyMs: 10, models: [], hasHealthEndpoint: true, checkedAt: 1000 };
  history.record({ ...base, status: 'healthy', checkedAt: 1000 });
  history.record({ ...base, status: 'healthy', checkedAt: 2000 });
  history.record({ ...base, status: 'unreachable', reachable: false, error: 'down', checkedAt: 3000 });
  history.record({ ...base, status: 'unreachable', reachable: false, error: 'down', checkedAt: 4000 });
  const summary = history.summary(url);
  assert.equal(summary.probes, 4);
  assert.equal(summary.healthyProbes, 2);
  assert.equal(summary.uptimeRatio, 0.5);
  assert.equal(summary.consecutiveFailures, 2);
  assert.equal(summary.lastHealthyAt, 2000);
  assert.equal(summary.lastStatus, 'unreachable');
  assert.equal(history.summary('http://127.0.0.1:9').probes, 0);
  assert.equal(history.summary('http://127.0.0.1:9').uptimeRatio, 0);
  assert.equal(history.summaries().length, 1);
  history.clear(url);
  assert.equal(history.summary(url).probes, 0);
});

test('probeVllmMetrics: fetches live /metrics from a loopback vLLM server', async (t) => {
  t.after(() => { for (const s of servers.splice(0)) { try { s.close(); } catch {} } });
  const { port } = await startServer((req, res) => {
    if (req.url === '/metrics') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('vllm:num_requests_running 6\nvllm:num_requests_waiting 0\nvllm:kv_cache_usage_perc 0.55\n');
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  const live = await probeVllmMetrics(`http://127.0.0.1:${port}`, { timeoutMs: 2000 });
  assert.ok(live);
  assert.equal(live.snapshot.numRunning, 6);
  assert.equal(live.snapshot.numWaiting, 0);
  assert.equal(live.snapshot.kvCacheUsage, 0.55);
  assert.ok(live.latencyMs >= 0);
  // Server khong co /metrics -> null (khong throw).
  const { port: port2 } = await startServer((_req, res) => {
    res.writeHead(404);
    res.end();
  });
  assert.equal(await probeVllmMetrics(`http://127.0.0.1:${port2}`, { timeoutMs: 2000 }), null);
  // Dead port -> null; non-loopback -> null (khong goi mang).
  const dead = await deadPort();
  assert.equal(await probeVllmMetrics(`http://127.0.0.1:${dead}`, { timeoutMs: 1000 }), null);
  assert.equal(await probeVllmMetrics('http://example.com:8000', { timeoutMs: 1000 }), null);
});

test('batchingConfigForModel: config scales with model size + GPU mem', () => {
  const small = findLocalModel('qwen3-0.6b');
  const big = findLocalModel('qwen3-32b');
  assert.ok(small && big);
  const GB = 1024 * 1024 * 1024;
  const smallCfg = batchingConfigForModel(small, 16 * GB);
  const bigCfg = batchingConfigForModel(big, 16 * GB);
  assert.ok(bigCfg.kvBytesPerToken > smallCfg.kvBytesPerToken, 'model lon hon thi KV/token lon hon');
  assert.equal(smallCfg.kvCacheBytes, 8 * GB, 'KV cache = 50% GPU mem');
  assert.equal(smallCfg.maxModelLen, small.contextTokens);
  assert.equal(bigCfg.maxModelLen, big.contextTokens);
  const override = batchingConfigForModel(small, 16 * GB, { maxNumSeqs: 8 });
  assert.equal(override.maxNumSeqs, 8);
});

/**
 * Tests for the fleet node client (packages/core/src/fleet/nodeClient.ts).
 *
 * Covers endpoint validation (public hosts refused), URL building,
 * assigned-job validation, and the client against a REAL loopback
 * HTTP server (health probe, job fetch, done/fail reports, 500s,
 * timeouts, and probeAll isolation).
 *
 * Run after building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/fleet-node-client-v104.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';

import {
  FleetNodeClient,
  nodeBaseUrl,
  validateNodeAssignedJob,
  validateNodeEndpoint,
} from '../packages/core/dist/fleet/nodeClient.js';

const GB = 1024 ** 3;

function makeNode(overrides = {}) {
  return {
    id: 'fn-1', hostname: 'node-1', host: '127.0.0.1', port: 18080, role: 'worker',
    cpuCores: 4, ramBytes: 8 * GB, diskBytes: 100 * GB, loopback: true,
    lastHeartbeatAt: null, lastLoad: null,
    registeredAt: Date.now(), updatedAt: Date.now(),
    ...overrides,
  };
}

const JOB = {
  id: 'fj-1', botId: 'bot-a', kind: 'bot-run', summary: 'run bot-a',
  resources: { cpuCores: 1, ramBytes: 1 * GB, diskBytes: 10 * GB },
};

/** Fake node server: implements /health, /jobs, /jobs/:id/complete|fail. */
function startFakeNode({ healthStatus = 200, jobs = [JOB], failJobs = false } = {}) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, body });
      if (req.url === '/health') {
        res.writeHead(healthStatus, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: healthStatus === 200, load: { runningJobs: 1 } }));
        return;
      }
      if (req.url.startsWith('/jobs?')) {
        if (failJobs) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'boom' }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ jobs }));
        return;
      }
      if (req.url.match(/^\/jobs\/[^/]+\/(complete|fail)$/)) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port, seen });
    });
  });
}

test('fleet node client: validateNodeEndpoint refuses public hosts', () => {
  assert.throws(() => validateNodeEndpoint({ host: '8.8.8.8', port: 18080 }), /public host/);
  assert.throws(() => validateNodeEndpoint({ host: 'example.com', port: 18080 }), /public host/);
  assert.throws(() => validateNodeEndpoint({ host: '192.168.1.5', port: 80 }), /port/);
  assert.doesNotThrow(() => validateNodeEndpoint({ host: '192.168.1.5', port: 18080 }));
  assert.equal(nodeBaseUrl({ host: '127.0.0.1', port: 18080 }), 'http://127.0.0.1:18080');
  assert.equal(nodeBaseUrl({ host: '::1', port: 18080 }), 'http://[::1]:18080');
});

test('fleet node client: validateNodeAssignedJob rejects bad shapes', () => {
  assert.throws(() => validateNodeAssignedJob({}), /id/);
  assert.throws(() => validateNodeAssignedJob({ ...JOB, resources: { cpuCores: 0, ramBytes: 1, diskBytes: 1 } }), /cpuCores/);
  assert.deepEqual(validateNodeAssignedJob(JOB), JOB);
});

test('fleet node client: probeHealth against a real local server', async () => {
  const { server, port, seen } = await startFakeNode();
  try {
    const client = new FleetNodeClient();
    const node = makeNode({ port });
    const probe = await client.probeHealth(node);
    assert.equal(probe.alive, true);
    assert.equal(probe.status, 200);
    assert.equal(typeof probe.latencyMs, 'number');
    assert.deepEqual(probe.body, { ok: true, load: { runningJobs: 1 } });
    assert.equal(seen[0].url, '/health');
  } finally {
    server.close();
  }
  // Unhealthy node (500) is not alive, but the probe does not throw.
  const sick = await startFakeNode({ healthStatus: 500 });
  try {
    const probe = await new FleetNodeClient().probeHealth(makeNode({ port: sick.port }));
    assert.equal(probe.alive, false);
    assert.equal(probe.status, 500);
    assert.match(probe.error ?? '', /HTTP 500/);
  } finally {
    sick.server.close();
  }
  // Nothing listening → not alive + error, no throw.
  const down = await new FleetNodeClient({ timeoutMs: 1000 }).probeHealth(makeNode({ port: 9 }));
  assert.equal(down.alive, false);
  assert.ok(down.error);
  // Public host → probe refuses without touching the network.
  const refused = await new FleetNodeClient().probeHealth(makeNode({ host: '8.8.8.8' }));
  assert.equal(refused.alive, false);
  assert.match(refused.error ?? '', /public host/);
});

test('fleet node client: probeAll isolates a dead node', async () => {
  const { server, port } = await startFakeNode();
  try {
    const client = new FleetNodeClient();
    const probes = await client.probeAll([makeNode({ id: 'fn-live', port }), makeNode({ id: 'fn-dead', port: 9 })]);
    assert.equal(probes.length, 2);
    assert.equal(probes[0].alive, true);
    assert.equal(probes[1].alive, false);
  } finally {
    server.close();
  }
});

test('fleet node client: fetchAssignedJobs + report done/fail against a real server', async () => {
  const { server, port, seen } = await startFakeNode();
  try {
    const client = new FleetNodeClient();
    const node = makeNode({ port });
    const jobs = await client.fetchAssignedJobs(node);
    assert.equal(jobs.ok, true);
    assert.equal(jobs.jobs.length, 1);
    assert.equal(jobs.jobs[0].id, 'fj-1');
    assert.match(seen[0].url, /\/jobs\?nodeId=fn-1/);
    const done = await client.reportJobDone(node, 'fj-1');
    assert.equal(done.ok, true);
    assert.equal(done.status, 200);
    const failed = await client.reportJobFailed(node, 'fj-1', 'out of memory');
    assert.equal(failed.ok, true);
    const failBody = JSON.parse(seen.find((s) => s.url.endsWith('/fail')).body);
    assert.equal(failBody.error, 'out of memory');
    // Empty error is rejected client-side, no request sent.
    const before = seen.length;
    const bad = await client.reportJobFailed(node, 'fj-1', '   ');
    assert.equal(bad.ok, false);
    assert.equal(seen.length, before);
  } finally {
    server.close();
  }
  // Server 500 on /jobs → ok false + error.
  const broken = await startFakeNode({ failJobs: true });
  try {
    const jobs = await new FleetNodeClient().fetchAssignedJobs(makeNode({ port: broken.port }));
    assert.equal(jobs.ok, false);
    assert.match(jobs.error ?? '', /HTTP 500/);
  } finally {
    broken.server.close();
  }
});

test('fleet node client: injected fetch is honoured (slow server times out)', async () => {
  // A fetch that never resolves must hit the client timeout.
  const hangingFetch = () => new Promise(() => {});
  const client = new FleetNodeClient({ timeoutMs: 200, fetchFn: hangingFetch });
  const probe = await client.probeHealth(makeNode());
  assert.equal(probe.alive, false);
  assert.match(probe.error ?? '', /timed out/);
  // Invalid timeout is rejected at construction.
  assert.throws(() => new FleetNodeClient({ timeoutMs: 0 }), /timeoutMs/);
});

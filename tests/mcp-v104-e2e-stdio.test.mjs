/**
 * Test v1.04 T2: E2E stdio — real StdioMcpClient against the fake
 * server (node:test). Proves `connectMcp` auto-negotiation, the
 * per-request stateless `_meta`, and `callToolMrtr` through a real
 * transport (no mocks on the client path).
 *
 * Build core first:
 *   npm run build --workspace=@open-bot/core
 * then: node --test tests/mcp-v104-e2e-stdio.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { connectMcp } from '../packages/core/dist/mcp/client.js';
import { buildDefaultMrtrHandlers } from '../packages/core/dist/mcp/mrtrClient.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fakeServer = path.join(here, 'mcp-v104-fake-stdio-server.mjs');

function tmpLog() {
  return path.join(os.tmpdir(), `mcp-v104-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`);
}

function readLog(logPath) {
  if (!fs.existsSync(logPath)) return [];
  return fs
    .readFileSync(logPath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

test('e2e stdio: auto + 2026 server -> stateless, _meta on every request, MRTR completes', async () => {
  const logPath = tmpLog();
  const client = await connectMcp({
    name: 'fake-2026',
    command: process.execPath,
    args: [fakeServer, '2026'],
    stateless: 'auto',
    env: { ...process.env, FAKE_LOG: logPath },
  });
  try {
    assert.equal(client.statelessActive, true);
    assert.equal(client.negotiatedProtocolVersion, '2026-07-28');
    assert.equal(client.statelessNegotiation.mode, 'stateless');
    assert.equal(client.statelessNegotiation.fellBack, false);

    const tools = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name), ['ask-city']);

    const out = await client.callToolMrtr(
      'ask-city',
      {},
      buildDefaultMrtrHandlers({
        onNeedsInput: async () => ({ city: 'Hanoi' }),
      }),
    );
    assert.equal(out.rounds, 2);
    assert.equal(out.result.text, 'weather in Hanoi');
    assert.equal(out.result.isError, false);

    // Every tools/call the server saw carried the stateless _meta.
    const calls = readLog(logPath).filter((e) => e.method === 'tools/call');
    assert.ok(calls.length >= 2);
    for (const call of calls) {
      assert.equal(call.params._meta.protocolVersion, '2026-07-28');
      assert.equal(call.params._meta.clientCapabilities.multiRoundTrip, true);
    }
  } finally {
    await client.close();
    fs.rmSync(logPath, { force: true });
  }
});

test('e2e stdio: auto + legacy server -> handshake fallback, no stateless _meta', async () => {
  const logPath = tmpLog();
  const client = await connectMcp({
    name: 'fake-legacy',
    command: process.execPath,
    args: [fakeServer, 'legacy'],
    stateless: 'auto',
    env: { ...process.env, FAKE_LOG: logPath },
  });
  try {
    assert.equal(client.statelessActive, false);
    assert.equal(client.negotiatedProtocolVersion, '2025-11-25');
    assert.equal(client.statelessNegotiation.mode, 'handshake');
    assert.equal(client.statelessNegotiation.fellBack, true);

    const seen = readLog(logPath).map((e) => e.method);
    assert.ok(seen.includes('server/discover'));
    assert.ok(seen.includes('initialize'));

    const text = await client.callTool('ask-city', { city: 'Saigon' });
    assert.equal(text, 'weather in Saigon');
    const calls = readLog(logPath).filter((e) => e.method === 'tools/call');
    assert.equal(calls.length, 1);
    // No stateless _meta in handshake mode (a progressToken may still
    // be there from the bounded-timeout machinery — that is not _meta
    // stateless: protocolVersion must be absent).
    assert.equal(calls[0].params._meta?.protocolVersion, undefined);
  } finally {
    await client.close();
    fs.rmSync(logPath, { force: true });
  }
});

test('e2e stdio: stateless:true + legacy server -> stateless-only, still works', async () => {
  const logPath = tmpLog();
  const client = await connectMcp({
    name: 'fake-legacy-stateless',
    command: process.execPath,
    args: [fakeServer, 'legacy'],
    stateless: true,
    env: { ...process.env, FAKE_LOG: logPath },
  });
  try {
    assert.equal(client.statelessActive, true);
    assert.equal(client.statelessNegotiation.mode, 'stateless');
    assert.equal(client.statelessNegotiation.fellBack, false);
    const text = await client.callTool('ask-city', { city: 'Hue' });
    assert.equal(text, 'weather in Hue');
  } finally {
    await client.close();
    fs.rmSync(logPath, { force: true });
  }
});

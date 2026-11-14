/**
 * Test v1.04 T2: E2E streamable HTTP — real StreamableHttpMcpClient
 * against a fake HTTP server (node:test, localhost only). Proves
 * `connectMcp` auto-negotiation + per-request stateless `_meta` on
 * the HTTP transport, and `callToolMrtr` over HTTP.
 *
 * Build core first:
 *   npm run build --workspace=@open-bot/core
 * then: node --test tests/mcp-v104-e2e-http.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';

import { connectMcp } from '../packages/core/dist/mcp/client.js';
import { buildDefaultMrtrHandlers } from '../packages/core/dist/mcp/mrtrClient.js';

/**
 * Minimal streamable-HTTP MCP server: POST JSON-RPC, 200 + JSON.
 * GET (the client's best-effort SSE stream probe) answers 404,
 * which the client tolerates. All requests are recorded so the
 * test can assert the stateless `_meta` the client sent.
 */
function startFakeHttpServer(mode) {
  const seen = [];
  const version = mode === '2026' ? '2026-07-28' : '2025-11-25';
  const server = http.createServer((req, res) => {
    if (req.method !== 'POST') {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
      return;
    }
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      let msg;
      try {
        msg = JSON.parse(body);
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'bad json' }));
        return;
      }
      const params = msg.params ?? {};
      seen.push({ method: msg.method, params });
      const id = msg.id ?? null;
      const ok = (result) => ({ jsonrpc: '2.0', id, result });
      const fail = (code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });
      let out;
      if (msg.method === 'initialize') {
        out = ok({
          protocolVersion: version,
          capabilities: { tools: {} },
          serverInfo: { name: 'fake-http-v104', version: '1' },
        });
      } else if (msg.method === 'server/discover') {
        out =
          mode === '2026'
            ? ok({
                protocolVersion: '2026-07-28',
                capabilities: { tools: {}, tasks: {}, apps: {} },
                serverInfo: { name: 'fake-http-v104', version: '1' },
              })
            : fail(-32601, 'Method not found: server/discover');
      } else if (msg.method === 'ping') {
        out = ok({});
      } else if (msg.method === 'tools/list') {
        out = ok({
          tools: [{ name: 'ask-city', description: 'Asks for a city.', inputSchema: { type: 'object', properties: {} } }],
        });
      } else if (msg.method === 'tools/call') {
        const args = params.arguments ?? {};
        const answer = params.answer ?? {};
        const city = args.city ?? answer.city;
        out = city
          ? ok({ content: [{ type: 'text', text: `weather in ${city}` }], isError: false })
          : ok({ resultType: 'needs_input', roundTripId: 'rt-http-1', need: { prompt: 'City?' } });
      } else if (msg.method === 'notifications/initialized') {
        res.writeHead(202, { 'Content-Type': 'application/json' });
        res.end('');
        return;
      } else {
        out = fail(-32601, `Method not found: ${msg.method}`);
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(out));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({ server, seen, url: `http://127.0.0.1:${address.port}/mcp` });
    });
  });
}

test('e2e http: auto + 2026 server -> stateless, _meta on tools/call, MRTR over HTTP', async () => {
  const { server, seen, url } = await startFakeHttpServer('2026');
  try {
    const client = await connectMcp({ name: 'fake-http-2026', url, stateless: 'auto' });
    try {
      assert.equal(client.statelessActive, true);
      assert.equal(client.negotiatedProtocolVersion, '2026-07-28');
      assert.equal(client.statelessNegotiation.mode, 'stateless');

      const out = await client.callToolMrtr(
        'ask-city',
        {},
        buildDefaultMrtrHandlers({ onNeedsInput: async () => ({ city: 'Da Nang' }) }),
      );
      assert.equal(out.rounds, 2);
      assert.equal(out.result.text, 'weather in Da Nang');

      const calls = seen.filter((e) => e.method === 'tools/call');
      assert.equal(calls.length, 2);
      for (const call of calls) {
        assert.equal(call.params._meta.protocolVersion, '2026-07-28');
      }
    } finally {
      await client.close();
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('e2e http: auto + legacy server -> handshake fallback over HTTP', async () => {
  const { server, seen, url } = await startFakeHttpServer('legacy');
  try {
    const client = await connectMcp({ name: 'fake-http-legacy', url, stateless: 'auto' });
    try {
      assert.equal(client.statelessActive, false);
      assert.equal(client.negotiatedProtocolVersion, '2025-11-25');
      assert.equal(client.statelessNegotiation.fellBack, true);
      const methods = seen.map((e) => e.method);
      assert.ok(methods.includes('server/discover'));
      assert.ok(methods.includes('initialize'));
      const text = await client.callTool('ask-city', { city: 'Hue' });
      assert.equal(text, 'weather in Hue');
    } finally {
      await client.close();
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

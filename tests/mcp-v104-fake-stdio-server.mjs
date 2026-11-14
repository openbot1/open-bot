/**
 * Fake MCP server over stdio for v1.04 E2E tests (NOT a test file —
 * run it as a child process: `node mcp-v104-fake-stdio-server.mjs
 * <2026|legacy>`).
 *
 * Speaks JSON-RPC lines on stdin/stdout:
 *  - `initialize` -> protocol version by mode.
 *  - `server/discover` -> discovery document in 2026 mode,
 *    -32601 in legacy mode.
 *  - `tools/list` -> one tool, `ask-city`.
 *  - `tools/call` ask-city -> first round `resultType: needs_input`
 *    (MRTR), follow-up with a city -> plain text answer.
 *  - `ping` -> {}.
 *
 * Every request is appended (JSON lines) to the file in
 * `FAKE_LOG` so the test can assert what `_meta` the client
 * actually sent. No network, no real model, no secrets.
 */
import * as fs from 'node:fs';
import * as readline from 'node:readline';

const mode = process.argv[2] === 'legacy' ? 'legacy' : '2026';
const logPath = process.env.FAKE_LOG ?? '';
const version = mode === '2026' ? '2026-07-28' : '2025-11-25';

function log(entry) {
  if (!logPath) return;
  try {
    fs.appendFileSync(logPath, `${JSON.stringify(entry)}\n`, 'utf8');
  } catch {
    // Logging must never break the fake server.
  }
}

function ok(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function fail(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function handle(msg) {
  const id = msg.id ?? null;
  const method = msg.method ?? '';
  const params = (msg.params ?? {}) ;
  log({ method, params });
  if (method === 'initialize') {
    return ok(id, {
      protocolVersion: version,
      capabilities: { tools: {} },
      serverInfo: { name: 'fake-v104', version: '1' },
    });
  }
  if (method === 'server/discover') {
    if (mode !== '2026') return fail(id, -32601, 'Method not found: server/discover');
    return ok(id, {
      protocolVersion: '2026-07-28',
      capabilities: { tools: {}, tasks: {}, apps: {} },
      serverInfo: { name: 'fake-v104', version: '1' },
      extensions: ['io.modelcontextprotocol/tasks'],
    });
  }
  if (method === 'ping') return ok(id, {});
  if (method === 'notifications/initialized') return null;
  if (method === 'tools/list') {
    return ok(id, {
      tools: [
        {
          name: 'ask-city',
          description: 'Asks for a city, then answers.',
          inputSchema: { type: 'object', properties: { city: { type: 'string' } } },
        },
      ],
    });
  }
  if (method === 'tools/call') {
    const args = params.arguments ?? {};
    const answer = params.answer ?? {};
    const city = args.city ?? answer.city;
    if (!city) {
      return ok(id, {
        resultType: 'needs_input',
        roundTripId: 'rt-1',
        need: { prompt: 'City?' },
      });
    }
    return ok(id, {
      content: [{ type: 'text', text: `weather in ${city}` }],
      isError: false,
    });
  }
  return fail(id, -32601, `Method not found: ${method}`);
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  const res = handle(msg);
  if (res) process.stdout.write(`${JSON.stringify(res)}\n`);
});

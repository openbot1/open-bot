#!/usr/bin/env node
/**
 * Fake ACP agent for v1.03 Team T3 tests — TEST ONLY.
 *
 * Unlike tests/fixtures/fake-acp-generic.mjs (which the CLI drivers'
 * lenient ACP client accepts), this fake speaks strict JSON-RPC 2.0:
 * every message it sends carries `jsonrpc: '2.0'`, because the core
 * `AcpJsonRpcPeer` drops lines without it. It implements just enough
 * of ACP v1 for the hosting tests: initialize, session/new, session/
 * load, session/resume, session/list, session/prompt (with
 * session/update notifications), session/cancel, session/set_mode,
 * session/set_config_option. No network, no credentials, no real CLI.
 *
 * Behaviour is controlled by FAKE_ACP_V103_MODE:
 * - 'default' (or unset): every prompt answers end_turn.
 * - 'die-after-first': the 2nd prompt onwards sends one chunk and
 *   exits(1) mid-turn (tests the host's lazy restart).
 */
import * as fs from 'node:fs';

const args = process.argv.slice(2);
const mode = process.env.FAKE_ACP_V103_MODE ?? 'default';

if (!args.includes('acp')) {
  console.error('fake-acp-agent-v103: expected an "acp" arg');
  process.exit(2);
}

const SESSION_ID = 'session-fake-v103-1';
let promptCount = 0;
const sessions = new Set([SESSION_ID]);

const send = (obj) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...obj })}\n`);

let buffer = '';
process.stdin.on('data', (chunk) => {
  buffer += chunk.toString('utf8');
  let idx = buffer.indexOf('\n');
  while (idx >= 0) {
    const line = buffer.slice(0, idx);
    buffer = buffer.slice(idx + 1);
    if (line.trim()) handleLine(line);
    idx = buffer.indexOf('\n');
  }
});

function handleLine(line) {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  const id = msg.id;
  const method = msg.method;
  const params = msg.params ?? {};
  switch (method) {
    case 'initialize':
      send({
        id,
        result: {
          protocolVersion: 1,
          agentInfo: { name: 'fake-acp-v103', version: '1.0.0' },
          agentCapabilities: {
            loadSession: true,
            promptCapabilities: { image: false, audio: false, embeddedContext: false },
            sessionCapabilities: { setMode: true, setConfigOption: true, list: true, close: true },
          },
        },
      });
      return;
    case 'authenticate':
      send({ id, result: {} });
      return;
    case 'session/new':
      sessions.add(SESSION_ID);
      send({ id, result: { sessionId: SESSION_ID } });
      return;
    case 'session/load':
    case 'session/resume':
      send({ id, result: { sessionId: params.sessionId ?? SESSION_ID } });
      return;
    case 'session/list':
      send({ id, result: { sessions: [...sessions].map((s) => ({ sessionId: s })) } });
      return;
    case 'session/cancel':
      send({ id, result: { cancelled: true } });
      return;
    case 'session/close':
      send({ id, result: { closed: true } });
      return;
    case 'session/set_mode':
      send({ id, result: { currentModeId: params.modeId ?? 'default' } });
      return;
    case 'session/set_config_option':
      send({ id, result: { configOptions: [] } });
      return;
    case 'session/prompt': {
      promptCount += 1;
      const prompt = Array.isArray(params.prompt) ? params.prompt : [];
      const text = prompt.map((b) => b.text ?? '').join('\n');
      const sessionId = params.sessionId ?? SESSION_ID;
      if (mode === 'die-after-first' && promptCount >= 2) {
        send({
          method: 'session/update',
          params: {
            sessionId,
            update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'partial…' } },
          },
        });
        process.exit(1);
      }
      const reply = `Fake reply to: ${text.slice(0, 50)}`;
      send({
        method: 'session/update',
        params: {
          sessionId,
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: reply } },
        },
      });
      send({
        method: 'session/update',
        params: {
          sessionId,
          update: { sessionUpdate: 'usage_update', usage: { inputTokens: 11, outputTokens: 6 } },
        },
      });
      send({ id, result: { stopReason: 'end_turn' } });
      return;
    }
    default:
      send({ id, error: { code: -32601, message: `Method not found: ${method}` } });
  }
}

// Keep stdin flowing even when nothing is piped yet.
process.stdin.resume();

// Best-effort: never let a stray write crash the fake mid-test.
process.stdout.on('error', () => {});
if (process.env.FAKE_ACP_V103_PID_FILE) {
  try {
    fs.writeFileSync(process.env.FAKE_ACP_V103_PID_FILE, String(process.pid));
  } catch {
    // ignore
  }
}

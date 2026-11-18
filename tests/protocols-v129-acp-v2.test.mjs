/**
 * Protocols v5 — ACP v2 draft client + registry + BYOA tests (v1.29, Team T2).
 *
 * Covers packages/core/src/protocolsV5/acpV2ClientV5.ts:
 * ACP sessions (new / prompt / cancel / complete), permission
 * requests (default deny), unadvertised methods refused, the
 * agent registry (register / discover by capability / search /
 * version / expiry / prune), the BYOA adapter (command / http /
 * in-process backends), and the A2A alignment mappings.
 *
 * No network, no process spawning: the agent runner is injected.
 *
 * Run after building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/protocols-v129-acp-v2.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ACP_V2_DRAFT_VERSION,
  AcpAgentRegistry,
  AcpV2ClientAdapter,
  ByoaClientAdapter,
  a2aTaskStateToAcpSessionV5,
  acpCardToA2aCardV5,
  acpSessionToA2aTaskV5,
  isAcpV2SessionTerminal,
} from '../packages/core/dist/index.js';

const echoRunner = async (_sessionId, prompt) => ({ text: `Answer: ${prompt}`, toolCalls: ['fs:read'] });

function card(overrides = {}) {
  return {
    agentId: 'agent-1',
    name: 'Coder',
    description: 'Writes code fast.',
    capabilities: ['coding', 'research'],
    transports: ['stdio', 'acp'],
    acpVersions: ['2.0-draft', '1.0'],
    a2aVersions: ['1.1'],
    endpoint: 'http://127.0.0.1:9000',
    ...overrides,
  };
}

test('session lifecycle: new -> prompt -> idle -> complete; terminal sessions refuse prompts', async () => {
  const client = new AcpV2ClientAdapter({ runner: echoRunner });
  const sessionId = client.newSession('agent-1');
  assert.match(sessionId, /^acp-session-/);
  assert.equal(client.getSession(sessionId)?.status, 'active');
  assert.equal(client.getSession(sessionId)?.acpVersion, ACP_V2_DRAFT_VERSION);

  const answer = await client.prompt(sessionId, 'Hello');
  assert.equal(answer.text, 'Answer: Hello');
  assert.deepEqual(answer.toolCalls, ['fs:read']);
  const session = client.getSession(sessionId);
  assert.equal(session?.status, 'idle');
  assert.equal(session?.turns.length, 2);
  assert.equal(session?.turns[0].role, 'user');
  assert.equal(session?.turns[1].role, 'agent');

  client.complete(sessionId);
  assert.equal(client.getSession(sessionId)?.status, 'completed');
  assert.equal(isAcpV2SessionTerminal('completed'), true);
  await assert.rejects(client.prompt(sessionId, 'again'), /is completed/);
  assert.equal(client.getSession('nope'), undefined);
  assert.throws(() => client.requireSession('nope'), /Unknown ACP session/);
});

test('cancel aborts the running turn and marks the session cancelled', async () => {
  let release;
  const slowRunner = async (_id, _prompt, signal) =>
    new Promise((resolve, reject) => {
      release = () => resolve({ text: 'late' });
      signal.addEventListener('abort', () => reject(new Error('aborted')));
    });
  const client = new AcpV2ClientAdapter({ runner: slowRunner });
  const sessionId = client.newSession('agent-1');
  const pending = client.prompt(sessionId, 'slow work');
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(client.cancel(sessionId), true);
  await assert.rejects(pending, /was cancelled/);
  assert.equal(client.getSession(sessionId)?.status, 'cancelled');
  assert.equal(client.cancel(sessionId), false);
  release?.();
});

test('prompt without a runner is refused; unadvertised methods are refused', async () => {
  const noRunner = new AcpV2ClientAdapter();
  const sessionId = noRunner.newSession('agent-1');
  await assert.rejects(noRunner.prompt(sessionId, 'hi'), /No agent runner/);

  const limited = new AcpV2ClientAdapter({ runner: echoRunner, advertisedMethods: ['session/new'] });
  assert.equal(limited.supportsMethod('session/prompt'), false);
  const limitedId = limited.newSession('agent-1');
  await assert.rejects(limited.prompt(limitedId, 'hi'), /not advertised/);
  assert.throws(() => limited.cancel(limitedId), /not advertised/);
});

test('permission requests: default decider denies; a custom decider can allow', async () => {
  const client = new AcpV2ClientAdapter({ runner: echoRunner });
  const sessionId = client.newSession('agent-1');
  assert.equal(await client.requestPermission(sessionId, 'fs:write', 'Write a file.'), 'deny');
  assert.equal(client.getSession(sessionId)?.pendingPermissions.length, 0);

  const allowing = new AcpV2ClientAdapter({
    runner: echoRunner,
    permissionDecider: async (req) => (req.toolName === 'fs:read' ? 'allow' : 'deny'),
  });
  const id2 = allowing.newSession('agent-1');
  assert.equal(await allowing.requestPermission(id2, 'fs:read', 'Read a file.'), 'allow');
  assert.equal(await allowing.requestPermission(id2, 'fs:write', 'Write a file.'), 'deny');
  await assert.rejects(allowing.requestPermission('nope', 'fs:read', 'x'), /Unknown ACP session/);
});

test('registry: register, list, discover by capability, search, discover by version', () => {
  const registry = new AcpAgentRegistry();
  registry.register(card());
  registry.register(
    card({ agentId: 'agent-2', name: 'Researcher', description: 'Finds facts.', capabilities: ['research'], acpVersions: ['1.0'] }),
  );
  assert.equal(registry.size, 2);
  assert.deepEqual(registry.list().map((c) => c.name), ['Coder', 'Researcher']);
  assert.deepEqual(registry.discoverByCapability('coding').map((c) => c.agentId), ['agent-1']);
  assert.deepEqual(registry.discoverByCapability('research').map((c) => c.agentId), ['agent-1', 'agent-2']);
  assert.deepEqual(registry.discoverByCapability('voice'), []);
  assert.deepEqual(registry.search('coder').map((c) => c.agentId), ['agent-1']);
  assert.deepEqual(registry.search('facts').map((c) => c.agentId), ['agent-2']);
  assert.deepEqual(registry.discoverByAcpVersion('2.0-draft').map((c) => c.agentId), ['agent-1']);
  assert.equal(registry.isLive('agent-1'), true);
  assert.equal(registry.unregister('agent-2'), true);
  assert.equal(registry.unregister('agent-2'), false);
  assert.equal(registry.size, 1);
  assert.throws(() => registry.register(card({ agentId: '', name: '' })), /agentId and name/);
});

test('registry: entries expire and prune; JSON round-trip restores live agents', () => {
  let now = 1_000_000;
  const registry = new AcpAgentRegistry({ now: () => now, defaultTtlMs: 1000 });
  registry.register(card());
  assert.equal(registry.isLive('agent-1'), true);
  now += 2000;
  assert.equal(registry.isLive('agent-1'), false);
  assert.deepEqual(registry.list(), []);
  assert.equal(registry.pruneExpired(), 1);
  assert.equal(registry.size, 0);

  const fresh = new AcpAgentRegistry();
  fresh.register(card());
  const restored = AcpAgentRegistry.fromJSON(fresh.toJSON());
  assert.equal(restored.size, 1);
  assert.equal(restored.get('agent-1')?.name, 'Coder');
  assert.equal(AcpAgentRegistry.fromJSON('not-an-array').size, 0);
});

test('BYOA adapter: command, http and in-process backends all present the same handle', async () => {
  const cmd = new ByoaClientAdapter({
    agentId: 'byoa-cmd',
    name: 'CmdAgent',
    backend: { kind: 'command', command: 'my-agent', args: ['--acp'] },
    capabilities: ['coding'],
    runner: echoRunner,
  });
  assert.equal(cmd.describeBackend(), 'command: my-agent --acp');
  assert.deepEqual(cmd.acpVersions, ['2.0-draft', '1.0']);
  const sessionId = cmd.newSession();
  assert.equal(await cmd.prompt(sessionId, 'hi'), 'Answer: hi');
  assert.equal(cmd.toAgentCard().transports.join(','), 'stdio,acp');
  assert.equal(cmd.toAgentCard().endpoint, undefined);

  const http = new ByoaClientAdapter({
    agentId: 'byoa-http',
    name: 'HttpAgent',
    backend: { kind: 'http', endpoint: 'http://127.0.0.1:9100' },
    runner: echoRunner,
  });
  assert.equal(http.describeBackend(), 'http: http://127.0.0.1:9100');
  assert.equal(http.toAgentCard().endpoint, 'http://127.0.0.1:9100');
  assert.deepEqual(http.toAgentCard().transports, ['http', 'acp']);

  const inProc = new ByoaClientAdapter({
    agentId: 'byoa-inproc',
    name: 'InProc',
    backend: { kind: 'in-process', runner: echoRunner },
  });
  assert.equal(inProc.describeBackend(), 'in-process runner');
  const id2 = inProc.newSession();
  assert.equal(await inProc.prompt(id2, 'yo'), 'Answer: yo');
  assert.equal(inProc.cancel(id2), true); // idle session can still be cancelled
  assert.equal(inProc.cancel(id2), false); // now terminal — second cancel is a no-op
});

test('A2A alignment: ACP session maps to an A2A task and back; card converts to an A2A card', async () => {
  const client = new AcpV2ClientAdapter({ runner: echoRunner });
  const sessionId = client.newSession('agent-1');
  await client.prompt(sessionId, 'Do the thing');
  const session = client.getSession(sessionId);
  const task = acpSessionToA2aTaskV5(session);
  assert.equal(task.id, `a2a-task:${sessionId}`);
  assert.equal(task.contextId, 'a2a-context:agent-1');
  assert.equal(task.state, 'submitted'); // idle -> submitted
  assert.equal(task.a2aVersion, '1.1');
  assert.equal(task.acpVersion, '2.0-draft');
  assert.equal(task.history.length, 2);
  assert.deepEqual(task.history[0], { role: 'user', parts: [{ kind: 'text', text: 'Do the thing' }] });
  assert.equal(a2aTaskStateToAcpSessionV5('working'), 'active');
  assert.equal(a2aTaskStateToAcpSessionV5('completed'), 'completed');
  assert.equal(a2aTaskStateToAcpSessionV5('canceled'), 'cancelled');
  assert.equal(a2aTaskStateToAcpSessionV5('input-required'), 'idle');

  const a2aCard = acpCardToA2aCardV5(card());
  assert.equal(a2aCard.name, 'Coder');
  assert.equal(a2aCard.url, 'http://127.0.0.1:9000');
  assert.equal(a2aCard.version, '2.0-draft');
  assert.deepEqual(a2aCard.acpVersions, ['2.0-draft', '1.0']);
  assert.deepEqual(a2aCard.skills.map((s) => s.id), ['coding', 'research']);
  assert.equal(a2aCard.capabilities.streaming, false); // stdio transport
});

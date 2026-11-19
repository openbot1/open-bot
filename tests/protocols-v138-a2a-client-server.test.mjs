/**
 * Protocols v7 — A2A v1.0.1 client/server tests (v1.38, Team T2).
 *
 * Covers packages/core/src/protocolsV7/a2aServerV7.ts and
 * a2aClientV7.ts: loopback pair (connect with JWS card verify +
 * trust, send/stream/get/cancel/list/resubscribe, push configs),
 * tenant isolation, per-tenant auth, rate limiting, unknown
 * methods, batch dispatch.
 *
 * Run after building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/protocols-v138-a2a-client-server.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  A2aV7CardIssuer,
  A2aV7CardRegistry,
  A2aV7Client,
  A2aV7LoopbackTransport,
  A2aV7Server,
  A2aV7TaskEngine,
  A2aV7TaskStore,
  A2aV7TrustStore,
  buildA2aV7AgentCard,
  createLoopbackA2aV7Pair,
} from '../packages/core/dist/index.js';

const echoRunner = async (task) => {
  const first = task.history.find((m) => m.role === 'user');
  const text = first?.parts.find((p) => p.kind === 'text')?.text ?? '';
  return { text: `agent says: ${text}` };
};

function makePair(options = {}) {
  const issuer = new A2aV7CardIssuer();
  const registry = new A2aV7CardRegistry();
  const store = new A2aV7TaskStore();
  const engine = new A2aV7TaskEngine(store, echoRunner);
  const server = new A2aV7Server({
    store, engine, cardRegistry: registry, tenantTokens: options.tenantTokens,
    rateLimitPerMinute: options.rateLimitPerMinute,
  });
  const card = buildA2aV7AgentCard({
    name: 'loopback-agent', description: 'Loopback test agent.', version: '1.38.0',
    url: 'http://localhost:8080', capabilities: ['echo'],
    skills: [{ id: 'echo', name: 'Echo', description: 'Echoes.' }],
    authSchemes: ['none'], tenant: 'default',
  });
  const issued = issuer.issue(card);
  registry.register(card, issued.jws, issuer.activeKey().publicKeyPem);
  const client = new A2aV7Client(new A2aV7LoopbackTransport(server), {
    peerPublicKeyPem: issuer.activeKey().publicKeyPem,
    trustStore: new A2aV7TrustStore('tofu'),
    sleep: () => Promise.resolve(),
    bearerToken: options.bearerToken,
  });
  return { issuer, registry, store, engine, server, client, card };
}

test('loopback pair: connect verifies the card and negotiates 1.0.1', async () => {
  const { client } = makePair();
  assert.equal(client.isConnected(), false);
  const conn = await client.connect();
  assert.equal(conn.negotiatedVersion, '1.0.1');
  assert.equal(conn.tenant, 'default');
  assert.equal(conn.trusted, true);
  assert.match(conn.trustReason, /TOFU/);
  assert.equal(client.isConnected(), true);
  assert.equal(client.getConnection().card.name, 'loopback-agent');
});

test('connect fails closed: no verification key / wrong key / TOFU key change', async () => {
  const { server } = makePair();
  const noKey = new A2aV7Client(new A2aV7LoopbackTransport(server), {});
  await assert.rejects(() => noKey.connect(), /no peerPublicKeyPem/);
  const other = new A2aV7CardIssuer();
  const wrongKey = new A2aV7Client(new A2aV7LoopbackTransport(server), {
    peerPublicKeyPem: other.activeKey().publicKeyPem,
  });
  await assert.rejects(() => wrongKey.connect(), /failed verification/);
  // TOFU: one trust store pins the first key it sees for an agent
  // name; a rotated key for the same name is refused by that store.
  const { issuer, store, server: pairServer } = makePair();
  const sharedStore = new A2aV7TrustStore('tofu');
  const firstClient = new A2aV7Client(new A2aV7LoopbackTransport(pairServer), {
    peerPublicKeyPem: issuer.activeKey().publicKeyPem,
    trustStore: sharedStore,
  });
  await firstClient.connect();
  // Rotate the issuer key and serve a new card for the same agent.
  issuer.rotate();
  const card2 = buildA2aV7AgentCard({
    name: 'loopback-agent', description: 'Loopback test agent.', version: '1.38.0',
    url: 'http://localhost:8080', capabilities: ['echo'],
    skills: [{ id: 'echo', name: 'Echo', description: 'Echoes.' }],
    authSchemes: ['none'], tenant: 'default',
  });
  const registry2 = new A2aV7CardRegistry();
  registry2.register(card2, issuer.issue(card2).jws, issuer.activeKey().publicKeyPem);
  const server2 = new A2aV7Server({ store, cardRegistry: registry2 });
  const secondClient = new A2aV7Client(new A2aV7LoopbackTransport(server2), {
    peerPublicKeyPem: issuer.activeKey().publicKeyPem,
    trustStore: sharedStore,
  });
  await assert.rejects(() => secondClient.connect(), /not trusted/);
  // A fresh store trusts the new key (first sight).
  const freshClient = new A2aV7Client(new A2aV7LoopbackTransport(server2), {
    peerPublicKeyPem: issuer.activeKey().publicKeyPem,
    trustStore: new A2aV7TrustStore('tofu'),
  });
  assert.equal((await freshClient.connect()).trusted, true);
});

test('client: send (async + wait), stream, get, list, resubscribe', async () => {
  const { client } = makePair();
  await client.connect();
  const sent = await client.sendMessage('hello loopback');
  assert.equal(sent.task.status, 'working');
  assert.equal(sent.task.history[0].parts[0].text, 'hello loopback');
  const waited = await client.sendMessage('wait for me', { waitForCompletion: true });
  assert.equal(waited.task.status, 'completed');
  assert.equal(waited.task.history.at(-1).parts[0].text, 'agent says: wait for me');
  const streamed = await client.streamMessage('stream me');
  assert.equal(streamed.task.status, 'completed');
  const kinds = streamed.events.map((e) => e.kind);
  assert.ok(kinds.includes('status'));
  assert.ok(kinds.includes('message'));
  assert.ok(kinds.includes('done'));
  assert.equal(streamed.events.at(-1).state, 'completed');
  const got = await client.getTask(streamed.taskId);
  assert.equal(got.id, streamed.taskId);
  const listed = await client.listTasks();
  assert.ok(listed.total >= 3);
  assert.ok(listed.tasks.every((t) => t.tenant === 'default'));
  const replay = await client.resubscribe(streamed.taskId);
  assert.equal(replay.taskId, streamed.taskId);
  assert.ok(replay.events.length >= 2);
  await assert.rejects(() => client.getTask('no-such-task'), /does not exist/);
});

test('client: cancel + push configs round-trip', async () => {
  const store = new A2aV7TaskStore();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const engine = new A2aV7TaskEngine(store, async () => {
    await gate;
    return { text: 'late' };
  });
  const issuer = new A2aV7CardIssuer();
  const registry = new A2aV7CardRegistry();
  const server = new A2aV7Server({ store, engine, cardRegistry: registry });
  const card = buildA2aV7AgentCard({
    name: 'slow-agent', description: 'Slow.', version: '1.0',
    url: 'http://localhost:8080', capabilities: ['slow'],
    skills: [], authSchemes: ['none'], tenant: 'default',
  });
  registry.register(card, issuer.issue(card).jws, issuer.activeKey().publicKeyPem);
  const client = new A2aV7Client(new A2aV7LoopbackTransport(server), {
    peerPublicKeyPem: issuer.activeKey().publicKeyPem,
    trustStore: new A2aV7TrustStore('tofu'),
    sleep: () => Promise.resolve(),
  });
  await client.connect();
  const sent = await client.sendMessage('take your time');
  const pushed = await client.setPushConfig(sent.task.id, 'https://hooks.example.com/done');
  assert.equal(pushed.config.taskId, sent.task.id);
  assert.equal((await client.listPushConfigs(sent.task.id)).configs.length, 1);
  assert.equal((await client.getPushConfig(sent.task.id, pushed.config.id)).config.id, pushed.config.id);
  const canceled = await client.cancelTask(sent.task.id);
  assert.equal(canceled.status, 'canceled');
  release();
  assert.equal((await client.deletePushConfig(sent.task.id, pushed.config.id)).removed, true);
  assert.equal((await client.listPushConfigs(sent.task.id)).configs.length, 0);
});

test('server: tenant isolation — a task in another tenant is invisible', async () => {
  const { server } = makePair();
  const created = await server.handle({
    jsonrpc: '2.0', id: 1, method: 'message/send',
    params: { message: 'secret task' },
  }, { 'x-a2a-tenant': 'acme' });
  assert.ok(!('error' in created));
  const taskId = created.result.task.id;
  const otherTenant = await server.handle({
    jsonrpc: '2.0', id: 2, method: 'tasks/get', params: { taskId },
  }, { 'x-a2a-tenant': 'globex' });
  assert.ok('error' in otherTenant);
  assert.equal(otherTenant.error.code, -32002);
  const sameTenant = await server.handle({
    jsonrpc: '2.0', id: 3, method: 'tasks/get', params: { taskId },
  }, { 'x-a2a-tenant': 'acme' });
  assert.ok(!('error' in sameTenant));
});

test('server: auth, unknown method, invalid request, batch, rate limit', async () => {
  const { server } = makePair({
    tenantTokens: { default: 'secret-token' },
    rateLimitPerMinute: 2,
  });
  const noAuth = await server.handle(
    { jsonrpc: '2.0', id: 1, method: 'tasks/list', params: {} }, {},
  );
  assert.ok('error' in noAuth);
  assert.equal(noAuth.error.code, -32001);
  const wrongAuth = await server.handle(
    { jsonrpc: '2.0', id: 2, method: 'tasks/list', params: {} },
    { authorization: 'Bearer wrong' },
  );
  assert.ok('error' in wrongAuth);
  const headers = { authorization: 'Bearer secret-token' };
  const unknown = await server.handle(
    { jsonrpc: '2.0', id: 3, method: 'tasks/explode', params: {} }, headers,
  );
  assert.ok('error' in unknown);
  assert.equal(unknown.error.code, -32601);
  const bad = await server.handle({ jsonrpc: '1.0', id: 4, method: 'tasks/list' }, headers);
  assert.ok('error' in bad);
  assert.equal(bad.error.code, -32600);
  const batch = await server.handleBatch([
    { jsonrpc: '2.0', id: 10, method: 'tasks/list', params: {} },
    { jsonrpc: '2.0', id: 11, method: 'nope', params: {} },
  ], headers);
  assert.equal(batch.length, 2);
  assert.ok(!('error' in batch[0]));
  assert.ok('error' in batch[1]);
  // Rate limit: 2/minute — the third call in this window is refused.
  const limited = await server.handle(
    { jsonrpc: '2.0', id: 20, method: 'tasks/list', params: {} }, headers,
  );
  assert.ok('error' in limited);
  assert.equal(limited.error.code, -32004);
});

test('server: agentCard serving + createLoopbackA2aV7Pair helper', async () => {
  const { server, client } = makePair();
  const card = server.agentCard('default');
  assert.ok(card);
  assert.equal(card.mediaType, 'application/a2a-agent-card+json');
  assert.equal(card.json.name, 'loopback-agent');
  assert.equal(server.agentCard('no-such-tenant'), null);
  const pair = createLoopbackA2aV7Pair(server, {
    peerPublicKeyPem: makePair().issuer.activeKey().publicKeyPem,
  });
  assert.equal(pair.server, server);
  assert.ok(pair.client instanceof A2aV7Client);
  assert.ok(pair.transport instanceof A2aV7LoopbackTransport);
});

test('client: retries transient failures then succeeds; gives up after max retries', async () => {
  const { server, issuer } = makePair();
  let calls = 0;
  const flaky = {
    async send(request, headers) {
      calls += 1;
      if (calls <= 2) throw new Error('network blip');
      return server.handle(request, headers);
    },
    async fetchCardJson() { return server.agentCard('default').json; },
    async fetchCardJws() { return server.agentCard('default').jws; },
  };
  const client = new A2aV7Client(flaky, {
    peerPublicKeyPem: issuer.activeKey().publicKeyPem,
    trustStore: new A2aV7TrustStore('tofu'),
    sleep: () => Promise.resolve(),
    maxRetries: 3,
  });
  await client.connect();
  const sent = await client.sendMessage('flaky but fine');
  assert.equal(sent.task.history[0].parts[0].text, 'flaky but fine');
  assert.ok(calls >= 3);
  const alwaysDown = {
    async send() { throw new Error('down'); },
    async fetchCardJson() { throw new Error('down'); },
    async fetchCardJws() { throw new Error('down'); },
  };
  const down = new A2aV7Client(alwaysDown, { sleep: () => Promise.resolve(), maxRetries: 1 });
  await assert.rejects(() => down.connect(), /down/);
});

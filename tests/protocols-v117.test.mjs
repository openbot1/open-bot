/**
 * Tests for v1.17 — protocol v2 (Team T2).
 *
 *   1. A2A v1.0 (a2aV117.ts): Agent Card store (write/read/list/
 *      remove, invalid rejected), discovery over the well-known
 *      paths (alias fallback, invalid card, not found), client +
 *      in-process server delegation (delegateAndWait, artifacts,
 *      artifact text, cancel, wrong agent, unknown task), artifact
 *      store (create/append/read/drop), two-way streaming session
 *      (input/cancel/ack/ping, closed refuses input, replay).
 *   2. MCP stateless (mcpStatelessV117.ts): connect auto
 *      (stateless via server/discover; handshake fallback for a
 *      pre-2.0 server), tools/resources/prompts calls, `_meta`
 *      on every request, no session id kept, timeout, transient
 *      retry, not-connected guard, notify-unsupported guard.
 *   3. Unified renderer (unifiedRenderer.ts): AG-UI events build
 *      text/status/tool nodes (deltas accumulate, out-of-order
 *      ignored), A2UI frames mount/update/answer/dismiss, MCP
 *      Apps ui:// loads (valid app, bad URI, bad HTML rejected),
 *      snapshot diff, tree cap, reset.
 *   4. UHP harness manifest (harnessManifest.ts): parse/build/
 *      validate (good + every bad shape), canonical hash,
 *      tool checks (allow/deny/approval), controller tasks
 *      (start/waitFor/subscribe/cancel/timeout), sandboxed file
 *      control (read/write/list, traversal + absolute refused,
 *      size cap), denied tool inside a runner.
 *   5. i18n: protocols.v117.* keys in all 6 locales, non-empty,
 *      same count everywhere.
 *
 * No network (loopback/fake transports only), no sound card.
 * Run after building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/protocols-v117.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  A2aV117Client,
  A2aV117Server,
  AgentCardStore,
  ArtifactStore,
  TwoWayTaskSession,
  discoverAgentCard,
  fetchAgentCardDirect,
} from '../packages/core/dist/protocolsV2/a2aV117.js';
import { buildAgentCard } from '../packages/core/dist/a2a/card.js';
import { makeTextMessage } from '../packages/core/dist/a2a/types.js';
import {
  MCP_V117_PROTOCOL_VERSION,
  StatelessMcpClientV117,
  isTransientMcpError,
  statelessTransportFromRequest,
} from '../packages/core/dist/protocolsV2/mcpStatelessV117.js';
import {
  UnifiedRenderer,
  a2uiKindToUnifiedNodeKind,
  validateUnifiedTreeSnapshot,
} from '../packages/core/dist/protocolsV2/unifiedRenderer.js';
import { A2uiV2Catalog } from '../packages/core/dist/protocolsV2/a2uiV2.js';
import { AgUiV2Stream } from '../packages/core/dist/protocolsV2/aguiStreamV2.js';
import {
  HarnessManifestController,
  buildHarnessManifest,
  checkHarnessTool,
  diffHarnessManifests,
  hashHarnessManifest,
  loadHarnessManifestFromFile,
  parseHarnessManifest,
  saveHarnessManifestToFile,
  validateHarnessManifest,
} from '../packages/core/dist/protocolsV2/harnessManifest.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOCALES_DIR = path.join(__dirname, '..', 'apps', 'desktop', 'src', 'renderer', 'i18n', 'locales');

function tmpDir(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `open-bot-protocols-v117-${name}-${process.pid}-`));
}

const CARD_INPUT = {
  name: 'Helper Agent',
  description: 'A fake agent for v117 protocol tests.',
  url: 'http://127.0.0.1:9101/',
  version: '1.0.0',
  streaming: true,
  skills: [{ id: 'echo', name: 'Echo', description: 'Echoes the input back.' }],
};

function echoServer() {
  const card = buildAgentCard(CARD_INPUT);
  return new A2aV117Server(card, async ({ text, session }) => {
    session.emitDownstream({ kind: 'message-append', messageText: `got: ${text}` });
    return { text: `echo: ${text}` };
  });
}

// ---------------------------------------------------------------------------
// 1. A2A v1.0
// ---------------------------------------------------------------------------

test('v117 a2a: card store write/read/list/remove, invalid rejected', () => {
  const store = new AgentCardStore();
  assert.equal(store.size(), 0);
  const card = store.writeCard(CARD_INPUT);
  assert.equal(card.protocolVersion, '1.0');
  assert.equal(store.size(), 1);
  assert.equal(store.readCard(CARD_INPUT.url)?.name, 'Helper Agent');
  assert.equal(store.listCards().length, 1);
  assert.throws(() => store.writeCard({ ...CARD_INPUT, url: 'ftp://x/' }), /http\(s\)/);
  assert.throws(() => store.storeCard({ name: '', description: '', url: 'http://127.0.0.1:1/' }), /Cannot store card/);
  assert.equal(store.removeCard(CARD_INPUT.url), true);
  assert.equal(store.removeCard(CARD_INPUT.url), false);
  assert.equal(store.size(), 0);
});

test('v117 a2a: discovery tries well-known paths, falls back to the alias', async () => {
  const card = buildAgentCard(CARD_INPUT);
  const fetcher = async (url) => {
    if (url.endsWith('/.well-known/agent-card.json')) throw new Error('404');
    if (url.endsWith('/.well-known/agent.json')) return card;
    throw new Error(`unexpected ${url}`);
  };
  const found = await discoverAgentCard('http://127.0.0.1:9101', fetcher);
  assert.equal(found.source, 'well-known-alias');
  assert.equal(found.card.name, 'Helper Agent');
  assert.equal(found.unsigned, true);
  assert.equal(found.protocolVersion, '1.0');
});

test('v117 a2a: discovery rejects an invalid card and reports not-found', async () => {
  const badFetcher = async () => ({ name: 'x' });
  await assert.rejects(() => discoverAgentCard('http://127.0.0.1:9101', badFetcher), /No valid Agent Card/);
  const failFetcher = async () => { throw new Error('connection refused'); };
  await assert.rejects(() => discoverAgentCard('http://127.0.0.1:9101', failFetcher), /No valid Agent Card/);
  const direct = await fetchAgentCardDirect('http://127.0.0.1:9101/card.json', async () => buildAgentCard(CARD_INPUT));
  assert.equal(direct.source, 'direct');
});

test('v117 a2a: client delegates to the in-process server and reads artifacts', async () => {
  const server = echoServer();
  const client = new A2aV117Client(server.asTransport());
  client.cards.writeCard(CARD_INPUT);
  const task = await client.delegateAndWait(CARD_INPUT.url, 'hello v117');
  assert.equal(task.status.state, 'completed');
  assert.equal(task.artifacts?.length, 1);
  assert.equal(await client.artifactText(server.card, task.id), 'echo: hello v117');
  const artifacts = await client.artifacts(server.card, task.id);
  assert.equal(artifacts[0].name, 'result');
  assert.equal(await client.getTask(server.card, task.id).then((t) => t.status.state), 'completed');
});

test('v117 a2a: delegate refuses unknown cards and empty messages', async () => {
  const server = echoServer();
  const client = new A2aV117Client(server.asTransport());
  await assert.rejects(() => client.delegate(CARD_INPUT.url, 'hi'), /No stored card/);
  client.cards.writeCard(CARD_INPUT);
  await assert.rejects(() => client.delegate(CARD_INPUT.url, '   '), /empty message/i);
});

test('v117 a2a: server refuses the wrong agent url and unknown tasks', async () => {
  const server = echoServer();
  const otherCard = buildAgentCard({ ...CARD_INPUT, url: 'http://127.0.0.1:9999/' });
  await assert.rejects(() => server.sendTask(otherCard, makeTextMessage('user', 'hi')), /This server is/);
  await assert.rejects(() => server.getTask('task-nope'), /No task .* on/);
  await assert.rejects(() => server.cancelTask('task-nope'), /No task .* on/);
  assert.throws(() => server.streamTask('task-nope', () => {}), /No task .* on/);
});

test('v117 a2a: cancel stops a slow task; terminal tasks cannot be re-cancelled', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const card = buildAgentCard(CARD_INPUT);
  const server = new A2aV117Server(card, async ({ signal }) => {
    await gate;
    if (signal.aborted) return { error: 'aborted' };
    return { text: 'late' };
  });
  const client = new A2aV117Client(server.asTransport());
  const task = await client.delegate(card, 'slow please');
  assert.equal(task.status.state, 'submitted');
  const cancelled = await client.cancelTask(card, task.id, 'user changed mind');
  assert.equal(cancelled.status.state, 'cancelled');
  release();
  const again = await client.cancelTask(card, task.id);
  assert.equal(again.status.state, 'cancelled');
});

test('v117 a2a: artifact store create/append/read/drop', () => {
  const store = new ArtifactStore();
  const artifact = store.createArtifact('t1', { name: 'notes', parts: [{ kind: 'text', text: 'hel' }] });
  assert.ok(artifact.artifactId.startsWith('artifact-'));
  const appended = store.appendArtifactText('t1', artifact.artifactId, 'lo');
  assert.equal(store.readArtifactText('t1', artifact.artifactId), 'hello');
  assert.equal(appended.parts[0].text, 'hello');
  assert.equal(store.listArtifacts('t1').length, 1);
  assert.equal(store.listArtifacts('t2').length, 0);
  assert.throws(() => store.getArtifact('t1', 'artifact-999'), /No artifact/);
  assert.throws(() => store.createArtifact('t1', { parts: [] }), /at least one part/);
  assert.equal(store.dropTask('t1'), 1);
  assert.equal(store.listArtifacts('t1').length, 0);
});

test('v117 a2a: two-way session — input, ack, ping, cancel, closed refuses input', () => {
  const task = {
    id: 'task-1', contextId: 'ctx-1',
    status: { state: 'submitted' },
  };
  const session = new TwoWayTaskSession(task);
  assert.equal(session.getStatus(), 'open');
  assert.equal(session.sendUpstream({ type: 'ping' }).accepted, true);
  const acked = session.sendUpstream({ type: 'ack', sequence: 3 });
  assert.equal(acked.accepted, true);
  assert.equal(session.lastAcked(), 3);
  const input = session.sendUpstream({ type: 'input', message: makeTextMessage('user', 'more context') });
  assert.equal(input.sessionStatus, 'input-required');
  assert.equal(session.consumeInput().length, 1);
  assert.equal(session.getStatus(), 'open');
  assert.equal(session.getTask().history?.length, 1);
  const replayed = session.replayFrom(0);
  assert.ok(replayed.length >= 1);
  assert.equal(replayed[0].kind, 'message-append');
  const cancelled = session.sendUpstream({ type: 'cancel', reason: 'done here' });
  assert.equal(cancelled.sessionStatus, 'closed');
  assert.equal(session.getTask().status.state, 'cancelled');
  assert.throws(() => session.sendUpstream({ type: 'input', message: makeTextMessage('user', 'too late') }), /is finished; cannot send/);
  assert.throws(() => session.close('working'), /needs a terminal state/);
});

test('v117 a2a: two-way stream handle sends upstream cancel into a running task', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const card = buildAgentCard(CARD_INPUT);
  const server = new A2aV117Server(card, async () => {
    await gate;
    return { text: 'never' };
  });
  const client = new A2aV117Client(server.asTransport());
  const task = await client.delegate(card, 'stream me');
  const seen = [];
  const handle = client.streamTask(card, task.id, (event) => seen.push(event));
  const result = handle.sendUpstream({ type: 'cancel', reason: 'stop streaming' });
  assert.equal(result.accepted, true);
  assert.equal(result.sessionStatus, 'closed');
  assert.ok(seen.some((e) => e.kind === 'status-update' && e.state === 'cancelled'));
  handle.close();
  release();
});

// ---------------------------------------------------------------------------
// 2. MCP stateless client
// ---------------------------------------------------------------------------

function fakeMcpTransport(handlers, seen = []) {
  return {
    request: async (method, params) => {
      seen.push({ method, params });
      if (handlers[method]) return handlers[method](params);
      throw Object.assign(new Error(`Method not found: ${method}`), { code: -32601 });
    },
  };
}

const DISCOVER_DOC = {
  protocolVersion: MCP_V117_PROTOCOL_VERSION,
  capabilities: { tools: {}, resources: {}, prompts: {} },
  serverInfo: { name: 'fake-mcp', version: '1.0.0' },
  extensions: [],
};

function statelessHandlers(seen) {
  return {
    'server/discover': () => DISCOVER_DOC,
    initialize: () => ({ protocolVersion: '2025-11-25' }),
    ping: () => ({}),
    'tools/list': () => ({ tools: [{ name: 'echo', description: 'Echo tool', inputSchema: { type: 'object' } }] }),
    'tools/call': (params) => ({ content: [{ type: 'text', text: `called ${params.name}` }], isError: false }),
    'resources/list': () => ({ resources: [{ uri: 'ui://fake/app', name: 'App', mimeType: 'text/html' }] }),
    'resources/read': (params) => ({ contents: [{ uri: params.uri, mimeType: 'text/html', text: '<p>hi</p>' }] }),
    'prompts/list': () => ({ prompts: [{ name: 'greet', description: 'Greet' }] }),
    'prompts/get': (params) => ({ messages: [{ role: 'user', content: { type: 'text', text: `hi ${params.arguments?.name ?? ''}` } }] }),
  };
}

test('v117 mcp: connect auto negotiates stateless; tools/resources/prompts work', async () => {
  const seen = [];
  const client = new StatelessMcpClientV117(fakeMcpTransport(statelessHandlers(seen), seen));
  assert.equal(client.connectionState(), 'disconnected');
  const negotiation = await client.connect('auto');
  assert.equal(negotiation.mode, 'stateless');
  assert.equal(client.isStateless(), true);
  assert.equal(client.effectiveProtocolVersion(), MCP_V117_PROTOCOL_VERSION);
  assert.equal(client.connectionState(), 'connected');
  assert.equal(await client.ping(), true);
  const tools = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name), ['echo']);
  const called = await client.callTool('echo', { text: 'hi' });
  assert.equal(called.isError, false);
  assert.equal(called.content[0].text, 'called echo');
  const resources = await client.listResources();
  assert.equal(resources[0].uri, 'ui://fake/app');
  const contents = await client.readResource('ui://fake/app');
  assert.equal(contents[0].text, '<p>hi</p>');
  assert.deepEqual((await client.listPrompts()).map((p) => p.name), ['greet']);
  assert.ok(await client.getPrompt('greet', { name: 'Huy' }));
  // Every request carried stateless _meta, and no session id was ever sent or kept.
  const toolCall = seen.find((s) => s.method === 'tools/call');
  assert.equal(toolCall.params._meta.protocolVersion, MCP_V117_PROTOCOL_VERSION);
  assert.equal(toolCall.params._meta.clientCapabilities.apps, true);
  assert.ok(!seen.some((s) => JSON.stringify(s.params).includes('sessionId')));
  assert.equal('sessionId' in client, false);
  assert.ok(client.recentRequests().length >= 8);
  assert.ok(client.recentRequests().every((r) => r.ok));
});

test('v117 mcp: pre-2.0 server falls back to the initialize handshake', async () => {
  const seen = [];
  const handlers = statelessHandlers(seen);
  handlers['server/discover'] = () => { throw Object.assign(new Error('Method not found'), { code: -32601 }); };
  const client = new StatelessMcpClientV117(fakeMcpTransport(handlers, seen));
  const negotiation = await client.connect('auto');
  assert.equal(negotiation.mode, 'handshake');
  assert.equal(negotiation.fellBack, true);
  assert.equal(negotiation.protocolVersion, '2025-11-25');
  assert.equal(client.isStateless(), false);
  assert.equal(await client.ping(), true);
});

test('v117 mcp: methods refuse before connect; notify needs a notify transport', async () => {
  const client = new StatelessMcpClientV117(fakeMcpTransport(statelessHandlers([])));
  await assert.rejects(() => client.listTools(), /not connected/);
  await client.connect('auto');
  await assert.rejects(() => client.notify('notifications/progress', {}), /cannot send notifications/);
  await assert.rejects(() => client.callTool('', {}), /needs a tool name/);
  await assert.rejects(() => client.readResource(''), /needs a uri/);
  client.disconnect();
  assert.equal(client.connectionState(), 'disconnected');
  assert.equal(client.lastNegotiation(), null);
});

test('v117 mcp: timeout fails fast; transient -32603 retries once then succeeds', async () => {
  const hanging = { request: async () => new Promise(() => {}) };
  const slow = new StatelessMcpClientV117(hanging, { timeoutMs: 50, maxRetries: 0 });
  await slow.connect('auto').catch(() => {}); // discover hangs -> connect fails with timeout
  assert.equal(slow.connectionState(), 'disconnected');

  let attempts = 0;
  const flaky = fakeMcpTransport({
    'server/discover': () => DISCOVER_DOC,
    'tools/list': () => {
      attempts += 1;
      if (attempts === 1) throw Object.assign(new Error('Internal error'), { code: -32603 });
      return { tools: [] };
    },
  });
  const client = new StatelessMcpClientV117(flaky, { timeoutMs: 5000, maxRetries: 1, retryBaseDelayMs: 1 });
  await client.connect('auto');
  assert.deepEqual(await client.listTools(), []);
  assert.equal(attempts, 2);
  assert.equal(isTransientMcpError(Object.assign(new Error('x'), { code: -32603 })), true);
  assert.equal(isTransientMcpError(new Error('plain')), false);
});

test('v117 mcp: statelessTransportFromRequest wraps an existing request fn', async () => {
  const seen = [];
  const transport = statelessTransportFromRequest(async (method, params) => {
    seen.push(method);
    if (method === 'server/discover') return DISCOVER_DOC;
    if (method === 'ping') return {};
    throw new Error(`no ${method}`);
  });
  const client = new StatelessMcpClientV117(transport);
  await client.connect(true);
  assert.equal(client.negotiatedMode(), 'stateless');
  assert.equal(await client.ping(), true);
  assert.deepEqual(seen, ['server/discover', 'ping']);
});

// ---------------------------------------------------------------------------
// 3. Unified renderer
// ---------------------------------------------------------------------------

test('v117 renderer: AG-UI events build text/status/tool nodes; deltas accumulate', () => {
  const renderer = new UnifiedRenderer();
  const stream = new AgUiV2Stream({ runId: 'run-1' });
  stream.startRun({ label: 'demo' });
  const stepId = stream.startStep('message');
  stream.textDelta('hello ', stepId);
  stream.textDelta('world', stepId);
  stream.endStep();
  stream.finishRun({ status: 'completed' });
  const touched = renderer.applyAgUiEvents(stream.bufferedEvents());
  assert.ok(touched.length > 0);
  const textNode = renderer.getNode(`agui:run-1:${stepId}`);
  assert.equal(textNode?.kind, 'text');
  assert.equal(textNode?.props.text, 'hello world');
  assert.equal(textNode?.status, 'done');
  const statusNode = renderer.getNode('agui:run-1:status');
  assert.equal(statusNode?.props.state, 'finished');
  assert.equal(renderer.snapshot().runIds[0], 'run-1');
  assert.equal(renderer.snapshot().bySource.agui, 2);
  // Replay is safe: re-applying the same events changes nothing.
  const before = renderer.snapshot().version;
  renderer.applyAgUiEvents(stream.bufferedEvents());
  assert.equal(renderer.snapshot().version, before);
});

test('v117 renderer: tool-call events merge into one node; invalid events rejected', () => {
  const renderer = new UnifiedRenderer();
  const stream = new AgUiV2Stream({ runId: 'run-2' });
  stream.startRun();
  stream.emit('TOOL_CALL_START', { toolCallId: 'tc-1', name: 'search', args: { q: 'x' } });
  stream.emit('TOOL_CALL_RESULT', { toolCallId: 'tc-1', name: 'search', result: 'ok' });
  renderer.applyAgUiEvents(stream.bufferedEvents());
  const node = renderer.getNode('agui:run-2:tool:tc-1');
  assert.equal(node?.kind, 'tool-call');
  assert.equal(node?.props.name, 'search');
  assert.equal(node?.props.result, 'ok');
  assert.equal(node?.status, 'done');
  assert.throws(() => renderer.applyAgUiEvent({ type: 'NOPE', runId: 'r', sequence: 0, timestamp: new Date().toISOString(), data: {} }), /not a known AG-UI/);
  assert.equal(a2uiKindToUnifiedNodeKind('form'), 'form');
  assert.equal(a2uiKindToUnifiedNodeKind('detail'), 'card');
});

test('v117 renderer: A2UI frames mount, update, answer and dismiss as nodes', () => {
  const catalog = new A2uiV2Catalog();
  const renderer = new UnifiedRenderer({ catalog });
  const frame = catalog.renderSurface(
    { componentId: 'generic-approval', kind: 'approval', runId: 'run-3', title: 'Approve?', data: { question: 'Proceed?', actions: [{ id: 'yes', label: 'Yes' }, { id: 'no', label: 'No' }] } },
    { text: 'Proceed?' },
  );
  const nodeId = renderer.mountA2uiFrame(frame);
  assert.equal(renderer.getNode(nodeId)?.kind, 'approval');
  assert.equal(renderer.getNode(nodeId)?.props.state.text, 'Proceed?');
  const updated = catalog.updateState(frame.surfaceId, { text: 'Proceed now?' });
  renderer.updateA2uiFrame(updated);
  assert.equal(renderer.getNode(nodeId)?.props.state.text, 'Proceed now?');
  assert.equal(renderer.getNode(nodeId)?.version, 2);
  const answered = renderer.answerA2uiSurface(frame.surfaceId, { actionId: 'yes' });
  assert.equal(answered, nodeId);
  assert.equal(renderer.getNode(nodeId)?.status, 'answered');

  const frame2 = catalog.renderSurface(
    { componentId: 'generic-message', kind: 'message', runId: 'run-3', title: 'Note 2', data: { text: 'bye' } },
    { text: 'bye' },
  );
  renderer.mountA2uiFrame(frame2);
  renderer.dismissA2uiSurface(frame2.surfaceId);
  assert.equal(renderer.getNode(`a2ui:${frame2.surfaceId}`)?.status, 'dismissed');
  assert.throws(() => renderer.answerA2uiSurface('surface-nope', {}), /Unknown surface/);
});

test('v117 renderer: MCP Apps ui:// loads as an app node; bad uri/html rejected', async () => {
  const renderer = new UnifiedRenderer();
  const loader = async (uri) => ({
    uri,
    title: 'Demo app',
    html: '<html><body><p>hello app</p></body></html>',
    mimeType: 'text/html',
  });
  const nodeId = await renderer.loadMcpApp('ui://fake/app', loader);
  const node = renderer.getNode(nodeId);
  assert.equal(node?.kind, 'app');
  assert.equal(node?.source, 'mcp-apps');
  assert.ok(String(node?.props.sandbox).includes('allow-scripts'));
  assert.ok(String(node?.props.csp).includes("default-src 'none'"));
  assert.equal(renderer.unloadMcpApp('ui://fake/app'), true);
  assert.equal(renderer.unloadMcpApp('ui://fake/app'), false);
  await assert.rejects(() => renderer.loadMcpApp('https://example.com/app', loader), /must be a ui:\/\/ URI/);
  await assert.rejects(
    () => renderer.loadMcpApp('ui://fake/bad', async () => ({ uri: 'ui://fake/bad', html: '<script src="https://evil.example/x.js"></script>' })),
    /app-remote-script/,
  );
});

test('v117 renderer: snapshot diff, tree cap and reset', () => {
  const renderer = new UnifiedRenderer({ maxNodes: 3 });
  const before = renderer.snapshot();
  const stream = new AgUiV2Stream({ runId: 'run-4' });
  stream.startRun();
  stream.textDelta('x', 'm1');
  renderer.applyAgUiEvents(stream.bufferedEvents());
  const after = renderer.snapshot();
  const diff = UnifiedRenderer.diffSnapshots(before, after);
  assert.equal(diff.added.length, 2); // status + text node
  assert.equal(diff.removed.length, 0);
  assert.equal(diff.rootChanged, false);
  // Third node would exceed the cap (root + 2 nodes already).
  const stream2 = new AgUiV2Stream({ runId: 'run-5' });
  stream2.startRun();
  assert.throws(() => renderer.applyAgUiEvents(stream2.bufferedEvents()), /tree is full/);
  renderer.reset();
  assert.equal(renderer.nodeCount(), 1);
  assert.deepEqual(renderer.snapshot().runIds, []);
  assert.equal(renderer.removeNode('root'), false);
});

// ---------------------------------------------------------------------------
// 4. UHP harness manifest
// ---------------------------------------------------------------------------

const GOOD_MANIFEST = {
  version: 'uhp/1.0',
  name: 'coding-harness',
  description: 'Fake harness for tests.',
  model: { provider: 'ollama', model: 'qwen2.5-coder:7b', temperature: 0.2 },
  skills: ['coding', 'review'],
  mcpServers: {
    fs: { transport: 'stdio', command: 'mcp-fs', args: ['--root', '.'] },
    web: { transport: 'http', url: 'http://127.0.0.1:8080/mcp' },
  },
  toolRestrictions: { allow: ['readFile', 'writeFile', 'search'], deny: ['shell'], requireApprovalFor: ['writeFile'] },
  limits: { maxTurns: 10, timeoutMs: 5000, maxFileBytes: 4096 },
};

test('v117 harness: parse/build/validate accept a good manifest', () => {
  assert.deepEqual(validateHarnessManifest(GOOD_MANIFEST), []);
  const parsed = parseHarnessManifest(JSON.stringify(GOOD_MANIFEST));
  assert.equal(parsed.name, 'coding-harness');
  const built = buildHarnessManifest({
    name: 'mini', model: { provider: 'ollama', model: 'llama3' },
    skills: ['coding'], mcpServers: {}, toolRestrictions: {},
  });
  assert.equal(built.version, 'uhp/1.0');
  assert.deepEqual(built.skills, ['coding']);
  assert.equal(hashHarnessManifest(parsed), hashHarnessManifest(GOOD_MANIFEST));
  assert.notEqual(hashHarnessManifest(built), hashHarnessManifest(parsed));
});

test('v117 harness: validation rejects every bad shape', () => {
  const cases = [
    [{ ...GOOD_MANIFEST, version: 'uhp/0.9' }, /version/],
    [{ ...GOOD_MANIFEST, name: 'bad name!' }, /name/],
    [{ ...GOOD_MANIFEST, model: { provider: 'ollama' } }, /model\.model/],
    [{ ...GOOD_MANIFEST, model: { provider: 'ollama', model: 'm', temperature: 5 } }, /temperature/],
    [{ ...GOOD_MANIFEST, skills: ['ok', 'bad skill!'] }, /skills/],
    [{ ...GOOD_MANIFEST, skills: ['dup', 'dup'] }, /duplicates/],
    [{ ...GOOD_MANIFEST, mcpServers: { s: { transport: 'stdio' } } }, /command/],
    [{ ...GOOD_MANIFEST, mcpServers: { s: { transport: 'http', url: 'ftp://x/' } } }, /http\(s\)/],
    [{ ...GOOD_MANIFEST, mcpServers: { s: { transport: 'grpc' } } }, /transport/],
    [{ ...GOOD_MANIFEST, toolRestrictions: { allow: ['shell'], deny: ['shell'] } }, /both allowed and denied/],
    [{ ...GOOD_MANIFEST, limits: { maxTurns: 0 } }, /maxTurns/],
    [null, /object/],
    ['not json', /not valid JSON/],
  ];
  for (const [value, pattern] of cases) {
    if (typeof value === 'string') {
      assert.throws(() => parseHarnessManifest(value), pattern);
    } else {
      assert.ok(validateHarnessManifest(value).some((p) => pattern.test(p)), `expected ${pattern} in ${validateHarnessManifest(value)}`);
      assert.throws(() => parseHarnessManifest(value), (err) => err.code === 'INVALID_MANIFEST');
    }
  }
});

test('v117 harness: tool checks — deny wins, allowlist closed, approval flagged', () => {
  assert.deepEqual(checkHarnessTool(GOOD_MANIFEST, 'shell'), { allowed: false, needsApproval: false, reason: 'tool "shell" is denied by the manifest' });
  assert.equal(checkHarnessTool(GOOD_MANIFEST, 'search').allowed, true);
  assert.equal(checkHarnessTool(GOOD_MANIFEST, 'search').needsApproval, false);
  assert.equal(checkHarnessTool(GOOD_MANIFEST, 'writeFile').needsApproval, true);
  assert.equal(checkHarnessTool(GOOD_MANIFEST, 'unknown-tool').allowed, false);
  const open = { ...GOOD_MANIFEST, toolRestrictions: { deny: ['shell'] } };
  assert.equal(checkHarnessTool(open, 'anything').allowed, true);
});

test('v117 harness: controller runs a task, streams events, writes files', async () => {
  const root = tmpDir('harness');
  const controller = new HarnessManifestController(GOOD_MANIFEST, {
    workspaceRoot: root,
    runner: async (ctx) => {
      ctx.emitText('working');
      const check = ctx.requireTool('readFile');
      assert.equal(check.allowed, true);
      ctx.emitTool('readFile', 'notes.md');
      await ctx.writeFile('out/result.md', '# done\n');
      const back = await ctx.readFile('out/result.md');
      assert.equal(back, '# done\n');
      return 'finished ok';
    },
  });
  assert.equal(controller.root(), root);
  assert.deepEqual(controller.skills(), ['coding', 'review']);
  assert.equal(Object.keys(controller.mcpServers()).length, 2);
  const seen = [];
  const task = controller.startTask('do the thing');
  const unsubscribe = controller.subscribe(task.id, (e) => seen.push(e));
  const done = await controller.waitFor(task.id);
  assert.equal(done.status, 'completed');
  assert.equal(done.resultText, 'finished ok');
  assert.equal(done.manifestName, 'coding-harness');
  assert.equal(done.manifestHash, controller.manifestHash);
  assert.ok(seen.some((e) => e.kind === 'text' && e.text === 'working'));
  assert.ok(seen.some((e) => e.kind === 'tool' && e.toolName === 'readFile'));
  assert.ok(seen.some((e) => e.kind === 'finished'));
  assert.deepEqual(await controller.listFiles('out'), ['result.md']);
  unsubscribe();
  assert.equal(controller.listTasks().length, 1);
});

test('v117 harness: file control refuses traversal, absolute paths and oversize writes', async () => {
  const root = tmpDir('harness-files');
  const controller = new HarnessManifestController(GOOD_MANIFEST, {
    workspaceRoot: root,
    runner: async () => 'ok',
  });
  await assert.rejects(() => controller.readFile('../escape.txt'), /escapes the workspace/);
  await assert.rejects(() => controller.readFile('/etc/passwd'), /relative/);
  await assert.rejects(() => controller.writeFile('../../escape.txt', 'x'), /escapes/);
  await assert.rejects(() => controller.readFile('missing.txt'), /Cannot read missing/);
  await assert.rejects(() => controller.writeFile('big.txt', 'x'.repeat(5000)), /exceeds/);
  assert.throws(() => controller.resolveWorkspacePath(''), /non-empty string/);
  await controller.writeFile('a/b/c.txt', 'deep');
  assert.equal(await controller.readFile('a/b/c.txt'), 'deep');
});

test('v117 harness: denied tool inside a runner fails the task; cancel works', async () => {
  const root = tmpDir('harness-deny');
  const denied = new HarnessManifestController(GOOD_MANIFEST, {
    workspaceRoot: root,
    runner: async (ctx) => {
      ctx.emitTool('shell', 'rm -rf /');
      return 'never';
    },
  });
  const task = denied.startTask('try shell');
  const done = await denied.waitFor(task.id);
  assert.equal(done.status, 'failed');
  assert.match(done.error ?? '', /denied by the manifest/);

  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const slow = new HarnessManifestController(GOOD_MANIFEST, {
    workspaceRoot: root,
    runner: async ({ signal }) => {
      await gate;
      if (signal.aborted) throw new Error('aborted');
      return 'late';
    },
  });
  const slowTask = slow.startTask('slow');
  const cancelled = slow.cancelTask(slowTask.id, 'user stopped it');
  assert.equal(cancelled.status, 'cancelled');
  release();
  const again = slow.cancelTask(slowTask.id);
  assert.equal(again.status, 'cancelled');

  const timeoutManifest = { ...GOOD_MANIFEST, limits: { timeoutMs: 50 } };
  const timingOut = new HarnessManifestController(timeoutManifest, {
    workspaceRoot: root,
    runner: async () => new Promise((resolve) => setTimeout(() => resolve('late'), 500)),
  });
  const t = timingOut.startTask('will time out');
  const timedOut = await timingOut.waitFor(t.id);
  assert.equal(timedOut.status, 'failed');
  assert.match(timedOut.error ?? '', /timed out/);
  await assert.rejects(() => timingOut.waitFor('task-nope'), /No harness task/);
  assert.throws(() => timingOut.startTask('   '), /needs a prompt/);
});

// ---------------------------------------------------------------------------
// 5. Extensions: streaming delegate, MCP pagination/notifications,
//    renderer export/import, manifest files/diff/export
// ---------------------------------------------------------------------------

test('v117 a2a ext: delegateAndStream yields events and returns the finished task', async () => {
  const server = echoServer();
  const client = new A2aV117Client(server.asTransport());
  const gen = client.delegateAndStream(server.card, 'stream this');
  const kinds = [];
  let finalTask;
  for (;;) {
    const step = await gen.next();
    if (step.done) {
      finalTask = step.value;
      break;
    }
    kinds.push(step.value.kind);
  }
  assert.equal(finalTask.status.state, 'completed');
  assert.ok(kinds.includes('status-update'));
  assert.ok(kinds.includes('artifact-complete'));
  const task = await client.delegateAndWait(server.card, 'check replay');
  const replayed = server.replayTask(task.id, 0);
  assert.ok(replayed.events.length >= 2);
  assert.equal(replayed.truncated, false);
  assert.throws(() => server.replayTask('task-nope', 0), /No task/);
});

test('v117 mcp ext: tools/list pagination walks pages; notifications fan out', async () => {
  const seen = [];
  const handlers = statelessHandlers(seen);
  handlers['tools/list'] = (params) => {
    if (!params.cursor) return { tools: [{ name: 'a' }], nextCursor: 'p2' };
    if (params.cursor === 'p2') return { tools: [{ name: 'b' }] };
    return { tools: [] };
  };
  const client = new StatelessMcpClientV117(fakeMcpTransport(handlers, seen));
  await client.connect('auto');
  assert.deepEqual(client.serverInfo(), { name: 'fake-mcp', version: '1.0.0' });
  const page1 = await client.listToolsPage();
  assert.deepEqual(page1.tools.map((t) => t.name), ['a']);
  assert.equal(page1.nextCursor, 'p2');
  assert.deepEqual((await client.listTools()).map((t) => t.name), ['a', 'b']);
  const got = [];
  const off = client.onNotification('notifications/tools/list_changed', (n) => got.push(n.method));
  const offAll = client.onNotification('*', (n) => got.push(`*${n.method}`));
  client.handleNotification({ method: 'notifications/tools/list_changed' });
  client.handleNotification({ method: 'notifications/unknown', params: {} });
  assert.deepEqual(got, ['notifications/tools/list_changed', '*notifications/tools/list_changed', '*notifications/unknown']);
  assert.equal(client.notificationCount(), 2);
  off();
  offAll();
  client.handleNotification({ method: 'notifications/tools/list_changed' });
  assert.equal(got.length, 3); // unsubscribed: nothing more delivered
  assert.equal(client.notificationCount(), 3);
});

test('v117 renderer ext: export/import round-trips the tree; bad snapshots refused', () => {
  const renderer = new UnifiedRenderer();
  const stream = new AgUiV2Stream({ runId: 'run-x' });
  stream.startRun();
  stream.textDelta('keep me', 'm1');
  renderer.applyAgUiEvents(stream.bufferedEvents());
  assert.equal(renderer.nodesOfKind('text').length, 1);
  assert.equal(renderer.findNodes((n) => n.source === 'agui').length, 2);
  const exported = renderer.exportTree();
  const restored = new UnifiedRenderer();
  restored.importTree(exported);
  assert.equal(restored.getNode('agui:run-x:m1')?.props.text, 'keep me');
  assert.equal(restored.nodeCount(), renderer.nodeCount());
  assert.deepEqual(validateUnifiedTreeSnapshot(JSON.parse(exported)), []);
  assert.throws(() => restored.importTree('not json'), /not valid JSON/);
  assert.throws(() => restored.importTree(JSON.stringify({ rootId: 'root', nodes: [] })), /non-empty array/);
  assert.throws(
    () => restored.importTree(JSON.stringify({ rootId: 'root', nodes: [{ id: 'root', kind: 'root', source: 'system', props: {}, children: ['ghost'] }] })),
    /unknown child/,
  );
  assert.equal(restored.nodeCount(), renderer.nodeCount()); // failed imports left the tree untouched
});

test('v117 harness ext: manifest save/load round-trip and diff', async () => {
  const dir = tmpDir('harness-manifest');
  const file = path.join(dir, 'harness.json');
  await saveHarnessManifestToFile(GOOD_MANIFEST, file);
  const loaded = await loadHarnessManifestFromFile(file);
  assert.equal(loaded.name, 'coding-harness');
  assert.equal(hashHarnessManifest(loaded), hashHarnessManifest(GOOD_MANIFEST));
  await assert.rejects(() => loadHarnessManifestFromFile(path.join(dir, 'missing.json')), /Cannot read manifest/);
  await assert.rejects(() => saveHarnessManifestToFile({ ...GOOD_MANIFEST, version: 'uhp/0.1' }, file), (err) => err.code === 'INVALID_MANIFEST');
  assert.deepEqual(diffHarnessManifests(GOOD_MANIFEST, GOOD_MANIFEST), []);
  const changed = {
    ...GOOD_MANIFEST,
    model: { provider: 'ollama', model: 'qwen2.5-coder:14b' },
    skills: ['coding'],
    mcpServers: { fs: GOOD_MANIFEST.mcpServers.fs, extra: { transport: 'http', url: 'http://127.0.0.1:9090/mcp' } },
  };
  const diffs = diffHarnessManifests(GOOD_MANIFEST, changed);
  assert.ok(diffs.some((d) => d.path === 'model.model'));
  assert.ok(diffs.some((d) => d.path === 'skills.-review'));
  assert.ok(diffs.some((d) => d.path === 'mcpServers.+extra'));
  assert.ok(diffs.some((d) => d.path === 'mcpServers.-web'));
});

test('v117 harness ext: controller exports task events as NDJSON', async () => {
  const root = tmpDir('harness-export');
  const controller = new HarnessManifestController(GOOD_MANIFEST, {
    workspaceRoot: root,
    runner: async (ctx) => {
      ctx.emitText('one');
      ctx.emitText('two');
      return 'done';
    },
  });
  const task = controller.startTask('export me');
  const done = await controller.waitFor(task.id);
  assert.equal(done.status, 'completed');
  const rel = await controller.exportTaskEvents(task.id);
  assert.equal(rel, `harness-events/${task.id}.ndjson`);
  const lines = (await controller.readFile(rel)).trim().split('\n');
  assert.ok(lines.length >= 3);
  const parsed = lines.map((l) => JSON.parse(l));
  assert.ok(parsed.every((e) => e.taskId === task.id));
  assert.ok(parsed.some((e) => e.kind === 'finished'));
  await assert.rejects(() => controller.exportTaskEvents('task-nope'), /No harness task/);
});

test('v117 a2a ext2: verified card store accepts signed, refuses bad/unsigned-when-required', () => {
  const store = new AgentCardStore();
  const signed = { ...buildAgentCard(CARD_INPUT), signature: { algorithm: 'Ed25519', keyId: 'k1', publicKey: 'abc', value: 'sig', signedAt: new Date().toISOString() } };
  const ok = store.storeVerifiedCard(signed, () => true);
  assert.equal(ok.unsigned, false);
  assert.equal(store.size(), 1);
  assert.throws(() => store.storeVerifiedCard(signed, () => false), /Signature check failed/);
  const unsigned = buildAgentCard({ ...CARD_INPUT, url: 'http://127.0.0.1:9102/' });
  assert.throws(() => store.storeVerifiedCard(unsigned, () => true, { requireSignature: true }), /no signature/);
  const stored = store.storeVerifiedCard(unsigned, () => true);
  assert.equal(stored.unsigned, true);
  assert.equal(store.size(), 2);
});

test('v117 mcp ext2: resource subscribe fans out only its own uri updates', async () => {
  const seen = [];
  const handlers = statelessHandlers(seen);
  handlers['resources/subscribe'] = () => ({});
  handlers['resources/unsubscribe'] = () => ({});
  const client = new StatelessMcpClientV117(fakeMcpTransport(handlers, seen));
  await client.connect('auto');
  const got = [];
  const unsubscribe = await client.subscribeResource('ui://fake/app', (n) => got.push(n.params.uri));
  client.handleNotification({ method: 'notifications/resources/updated', params: { uri: 'ui://fake/app' } });
  client.handleNotification({ method: 'notifications/resources/updated', params: { uri: 'ui://other/app' } });
  assert.deepEqual(got, ['ui://fake/app']);
  await unsubscribe();
  client.handleNotification({ method: 'notifications/resources/updated', params: { uri: 'ui://fake/app' } });
  assert.deepEqual(got, ['ui://fake/app']); // unsubscribed: nothing more
  await assert.rejects(() => client.subscribeResource('  ', () => {}), /needs a uri/);
});

test('v117 renderer ext2: interrupt nodes list as pending and resolve from the tree', () => {
  const renderer = new UnifiedRenderer();
  const stream = new AgUiV2Stream({ runId: 'run-int' });
  stream.startRun();
  stream.emit('INTERRUPT_STARTED', { interruptId: 'i-1', kind: 'approval', payload: { question: 'ok?' } });
  renderer.applyAgUiEvents(stream.bufferedEvents());
  assert.equal(renderer.pendingInterrupts().length, 1);
  assert.equal(renderer.pendingInterrupts('run-int').length, 1);
  assert.equal(renderer.pendingInterrupts('run-other').length, 0);
  const nodeId = renderer.resolveAgUiInterrupt('run-int', { approved: true });
  assert.equal(renderer.getNode(nodeId)?.status, 'answered');
  assert.deepEqual(renderer.getNode(nodeId)?.props.answer, { approved: true });
  assert.equal(renderer.pendingInterrupts().length, 0);
  assert.throws(() => renderer.resolveAgUiInterrupt('run-int', {}), /already answered/);
  assert.throws(() => renderer.resolveAgUiInterrupt('run-nope', {}), /No interrupt node/);
});

test('v117 harness ext2: task snapshots save/load; running tasks fail honestly on load', async () => {
  const root = tmpDir('harness-snap');
  const controller = new HarnessManifestController(GOOD_MANIFEST, {
    workspaceRoot: root,
    runner: async (ctx) => {
      ctx.emitText('work');
      return 'all good';
    },
  });
  const task = controller.startTask('snapshot me');
  const done = await controller.waitFor(task.id);
  const rel = await controller.saveTaskSnapshot(task.id);
  assert.equal(rel, `harness-tasks/${task.id}.json`);
  const restored = new HarnessManifestController(GOOD_MANIFEST, {
    workspaceRoot: root,
    runner: async () => 'unused',
  });
  const loaded = await restored.loadTaskSnapshot(rel);
  assert.equal(loaded.id, task.id);
  assert.equal(loaded.status, 'completed');
  assert.equal(loaded.resultText, 'all good');
  assert.equal(loaded.events.length, done.events.length);
  // A snapshot of a task that was still running is failed on load, not resumed.
  const runningSnap = { ...done, id: 'harness-task-99', status: 'running', resultText: undefined };
  await controller.writeFile('harness-tasks/running.json', JSON.stringify(runningSnap));
  const loadedRunning = await restored.loadTaskSnapshot('harness-tasks/running.json');
  assert.equal(loadedRunning.status, 'failed');
  assert.match(loadedRunning.error ?? '', /did not survive|running when/);
  await assert.rejects(() => restored.loadTaskSnapshot('harness-tasks/nope.json'), /Cannot read/);
  await controller.writeFile('harness-tasks/bad.json', '{oops');
  await assert.rejects(() => restored.loadTaskSnapshot('harness-tasks/bad.json'), /not valid JSON/);
});

// ---------------------------------------------------------------------------
// 6. i18n
// ---------------------------------------------------------------------------

test('v117 i18n: protocols.v117.* keys exist in all 6 locales, non-empty, same count', () => {
  const counts = {};
  for (const locale of ['vi', 'en', 'es', 'fr', 'ja', 'zh']) {
    const data = JSON.parse(fs.readFileSync(path.join(LOCALES_DIR, `${locale}.json`), 'utf8'));
    const keys = Object.keys(data).filter((k) => k.startsWith('protocols.v117'));
    counts[locale] = keys.length;
    assert.ok(keys.length >= 20, `${locale} has only ${keys.length} v117 keys`);
    for (const key of keys) {
      assert.equal(typeof data[key], 'string', `${locale}:${key} is not a string`);
      assert.ok(data[key].trim().length > 0, `${locale}:${key} is empty`);
    }
  }
  const unique = new Set(Object.values(counts));
  assert.equal(unique.size, 1, `v117 key counts differ across locales: ${JSON.stringify(counts)}`);
});

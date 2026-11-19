/**
 * Tests for v1.40 (Team T2) — protocols v9 tools:
 * packages/tools/src/protocolV117Tools.ts
 * packages/tools/src/registry.ts (registerProtocolV117Tools)
 * packages/tools/src/tools.ts (ALL_TOOLS spread + bind)
 *
 * Covers:
 *  - 12 tools, unique names, object parameters, descriptions,
 *    registry registration (fresh ToolRegistry -> 12 tools)
 *  - protocol_v9_versions: matrix / changes / downgrade /
 *    negotiate / features (loopback guard must stay on)
 *  - protocol_v9_apps: register / render / validate / csp /
 *    callback-check
 *  - protocol_v9_apps_lifecycle: open / close / reopen /
 *    suspend / resume / focus / counts / snapshot
 *  - protocol_v9_acp_detect: 3 detections, shape only (the
 *    real machine probe runs here — usability varies)
 *  - protocol_v9_acp_sessions + protocol_v9_acp_prompt:
 *    create (allowUnverified for determinism) / send-prompt /
 *    history / suspend / resume / cancel
 *  - protocol_v9_a2a_cards: build / register / discover /
 *    well-known; non-loopback refused
 *  - protocol_v9_a2a_tasks + protocol_v9_a2a_messages:
 *    create / message / artifact / transition / complete
 *  - protocol_v9_a2a_delegate: delegate / match / policy /
 *    push-add
 *  - protocol_v9_registry + protocol_v9_snapshots:
 *    unified counts / save-all / restore-all
 *  - ALL_TOOLS contains the 12 v9 tools exactly once, and the
 *    bind path replaces them in place (same count, no duplicates)
 *
 * Run after building core + tools:
 *   npm run build --workspace=@open-bot/core
 *   npm run build --workspace=@open-bot/tools
 *   node --test tests/protocols-v9-tools.test.mjs
 *
 * No network, no model, no credential access.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PROTOCOL_V117_TOOLS,
  PROTOCOL_V117_TOOL_NAMES,
  createProtocolV117Tools,
  isProtocolV117ToolName,
} from '../packages/tools/dist/protocolV117Tools.js';
import { ALL_TOOLS, createDefaultTools } from '../packages/tools/dist/tools.js';
import { ToolRegistry } from '../packages/tools/dist/registry.js';

async function call(tools, name, args) {
  const tool = tools.find((t) => t.definition.name === name);
  assert.notEqual(tool, undefined, `tool ${name} missing`);
  const out = await tool.execute(args);
  if (typeof out === 'string' && out.startsWith('Error:')) {
    throw new Error(`tool ${name} failed: ${out}`);
  }
  return JSON.parse(out);
}

const EXPECTED_NAMES = [
  'protocol_v9_versions',
  'protocol_v9_apps',
  'protocol_v9_apps_lifecycle',
  'protocol_v9_acp_detect',
  'protocol_v9_acp_sessions',
  'protocol_v9_acp_prompt',
  'protocol_v9_a2a_cards',
  'protocol_v9_a2a_tasks',
  'protocol_v9_a2a_messages',
  'protocol_v9_a2a_delegate',
  'protocol_v9_registry',
  'protocol_v9_snapshots',
];

const GOOD_HTML = `<!doctype html><html><head><style>body{color:#111}</style></head><body>
<h1>Weather</h1><img src="https://cdn.example.com/icon.png" alt="">
<button id="go">Refresh</button>
</body></html>`;

function goodCard(name = 'summariser') {
  return {
    name,
    description: 'Summarises documents.',
    url: 'http://127.0.0.1:8765',
    version: '1.0.0',
    protocolVersions: ['1.1'],
    capabilities: { streaming: true },
    skills: [{ id: 'summarise', name: 'Summarise', description: 'Summarise a document.', tags: ['docs'] }],
  };
}

test('12 tools: names, shape, factory idempotent, name guard', () => {
  assert.deepEqual([...PROTOCOL_V117_TOOL_NAMES], EXPECTED_NAMES);
  assert.equal(PROTOCOL_V117_TOOLS.length, 12);
  assert.equal(createProtocolV117Tools().length, 12);
  const names = PROTOCOL_V117_TOOLS.map((t) => t.definition.name);
  assert.deepEqual([...names].sort(), [...EXPECTED_NAMES].sort());
  assert.equal(new Set(names).size, 12);
  for (const tool of PROTOCOL_V117_TOOLS) {
    assert.equal(typeof tool.definition.description, 'string');
    assert.ok(tool.definition.description.length > 20);
    assert.equal(tool.definition.parameters.type, 'object');
    assert.equal(tool.definition.parameters.additionalProperties, false);
  }
  assert.equal(isProtocolV117ToolName('protocol_v9_versions'), true);
  assert.equal(isProtocolV117ToolName('protocol_v8_versions'), false);
  assert.equal(isProtocolV117ToolName('nope'), false);
});

test('registry: fresh ToolRegistry registers exactly the 12 v9 tools; duplicate refused', () => {
  const registry = new ToolRegistry();
  registry.registerProtocolV117Tools();
  assert.equal(registry.list().length, 12);
  assert.equal(registry.has('protocol_v9_versions'), true);
  assert.equal(registry.get('protocol_v9_a2a_tasks')?.definition.name, 'protocol_v9_a2a_tasks');
  assert.throws(() => registry.registerProtocolV117Tools(), /already registered/);
});

test('protocol_v9_versions: matrix / changes / downgrade / negotiate / features', async () => {
  const tools = createProtocolV117Tools();
  const matrix = await call(tools, 'protocol_v9_versions', { action: 'matrix' });
  assert.equal(matrix.current.a2a, '1.1');
  assert.equal(matrix.current.mcp, '2026-07-28');
  assert.equal(matrix.current.acp, 'draft');
  assert.match(matrix.summary, /a2a 1\.1/);
  const changes = await call(tools, 'protocol_v9_versions', { action: 'changes' });
  assert.ok(changes.changes.length >= 5);
  const down = await call(tools, 'protocol_v9_versions', { action: 'downgrade' });
  assert.match(down.downgradeToV8.a2a, /1\.1 -> 1\.0\.1/);
  const neg = await call(tools, 'protocol_v9_versions', { action: 'negotiate', family: 'a2a', serverVersions: ['1.0.1', '1.1'] });
  assert.equal(neg.negotiation.agreed, '1.1');
  const all = await call(tools, 'protocol_v9_versions', { action: 'negotiate-all', serverVersions: { a2a: ['1.1'] } });
  assert.equal(all.negotiations.a2a.agreed, '1.1');
  const features = await call(tools, 'protocol_v9_versions', { action: 'features', loopbackOnly: true });
  assert.equal(features.valid, true);
  const badFeatures = await call(tools, 'protocol_v9_versions', { action: 'features', loopbackOnly: false });
  assert.equal(badFeatures.valid, false);
  assert.equal(badFeatures.problems.length, 1);
});

test('protocol_v9_apps: register / render / validate / csp / callback-check', async () => {
  const tools = createProtocolV117Tools();
  const reg = await call(tools, 'protocol_v9_apps', {
    action: 'register',
    uri: 'ui://weather-card/main',
    name: 'Weather card',
    html: GOOD_HTML,
    domains: ['cdn.example.com'],
    allowedTools: ['weather-refresh'],
    toolName: 'weather',
  });
  assert.equal(reg.registration.uri, 'ui://weather-card/main');
  assert.deepEqual(reg.registration.undeclaredDomains, []);
  const rendered = await call(tools, 'protocol_v9_apps', {
    action: 'render', uri: 'ui://weather-card/main', toolName: 'weather',
  });
  assert.match(rendered.descriptor.csp, /cdn\.example\.com/);
  assert.match(rendered.descriptor.sandbox, /allow-scripts/);
  const validated = await call(tools, 'protocol_v9_apps', {
    action: 'validate', html: GOOD_HTML, domains: ['cdn.example.com'],
  });
  assert.equal(validated.validation.ok, true);
  const bad = await call(tools, 'protocol_v9_apps', {
    action: 'validate',
    html: GOOD_HTML.replace('cdn.example.com', 'evil.example.com'),
    domains: ['cdn.example.com'],
  });
  assert.equal(bad.validation.ok, false);
  const csp = await call(tools, 'protocol_v9_apps', { action: 'csp', uri: 'ui://weather-card/main' });
  assert.match(csp.csp, /default-src 'none'/);
  const okCb = await call(tools, 'protocol_v9_apps', {
    action: 'callback-check', uri: 'ui://weather-card/main', tool: 'weather-refresh', arguments: {},
  });
  assert.equal(okCb.check.ok, true);
  const badCb = await call(tools, 'protocol_v9_apps', {
    action: 'callback-check', uri: 'ui://weather-card/main', tool: 'delete-everything', arguments: {},
  });
  assert.equal(badCb.check.ok, false);
  const listed = await call(tools, 'protocol_v9_apps', { action: 'list' });
  assert.deepEqual(listed.uris, ['ui://weather-card/main']);
});

test('protocol_v9_apps_lifecycle: open / close / reopen / suspend / resume / focus', async () => {
  const tools = createProtocolV117Tools();
  await call(tools, 'protocol_v9_apps', {
    action: 'register', uri: 'ui://weather-card/main', name: 'Weather card',
    html: GOOD_HTML, domains: ['cdn.example.com'], allowedTools: ['weather-refresh'], toolName: 'weather',
  });
  const opened = await call(tools, 'protocol_v9_apps_lifecycle', {
    action: 'open', uri: 'ui://weather-card/main', toolName: 'weather', slot: 'left',
  });
  assert.equal(opened.app.state, 'active');
  assert.equal(opened.app.slot, 'left');
  const appId = opened.app.id;
  const focused = await call(tools, 'protocol_v9_apps_lifecycle', { action: 'focus', appId });
  assert.equal(focused.app.id, appId);
  const cb = await call(tools, 'protocol_v9_apps_lifecycle', {
    action: 'callback', appId, tool: 'weather-refresh', arguments: {},
  });
  assert.equal(cb.check.ok, true);
  const suspended = await call(tools, 'protocol_v9_apps_lifecycle', { action: 'suspend', appId });
  assert.equal(suspended.app.state, 'suspended');
  const resumed = await call(tools, 'protocol_v9_apps_lifecycle', { action: 'resume', appId });
  assert.equal(resumed.app.state, 'active');
  const counts = await call(tools, 'protocol_v9_apps_lifecycle', { action: 'counts' });
  assert.equal(counts.counts.active, 1);
  const moved = await call(tools, 'protocol_v9_apps_lifecycle', { action: 'move-slot', appId, slot: 'bottom' });
  assert.equal(moved.app.slot, 'bottom');
  const closed = await call(tools, 'protocol_v9_apps_lifecycle', { action: 'close', appId });
  assert.equal(closed.app.state, 'closed');
  const reopened = await call(tools, 'protocol_v9_apps_lifecycle', { action: 'reopen', appId });
  assert.equal(reopened.app.state, 'active');
  assert.equal(reopened.app.reopenCount, 1);
  const snap = await call(tools, 'protocol_v9_apps_lifecycle', { action: 'snapshot' });
  assert.equal(snap.snapshot.version, 9);
});

test('protocol_v9_acp_detect: three detections with the documented shape', async () => {
  const tools = createProtocolV117Tools();
  const all = await call(tools, 'protocol_v9_acp_detect', {});
  assert.equal(all.detections.length, 3);
  assert.deepEqual(all.detections.map((d) => d.agent), ['claude', 'codex', 'gemini']);
  for (const d of all.detections) {
    assert.equal(typeof d.binaryFound, 'boolean');
    assert.equal(typeof d.loginMarkerPresent, 'boolean');
    assert.equal(typeof d.usable, 'boolean');
    assert.equal(typeof d.note, 'string');
    assert.ok(d.loginMarkerPath.length > 0);
  }
  const one = await call(tools, 'protocol_v9_acp_detect', { agent: 'claude' });
  assert.equal(one.detection.agent, 'claude');
  assert.equal(one.detection.displayName, 'Claude Code');
});

test('protocol_v9_acp_sessions + prompt: create / prompt / history / suspend / resume / cancel', async () => {
  const tools = createProtocolV117Tools();
  const created = await call(tools, 'protocol_v9_acp_sessions', {
    action: 'create', agent: 'claude', allowUnverified: true, mode: 'ask',
  });
  const sessionId = created.session.id;
  assert.equal(created.session.agent, 'claude');
  assert.equal(created.session.status, 'idle');
  const prompted = await call(tools, 'protocol_v9_acp_prompt', {
    action: 'send-prompt', sessionId, prompt: 'hello agent',
  });
  assert.equal(prompted.session.status, 'idle');
  assert.equal(prompted.session.messages.length, 2);
  assert.match(prompted.reply.text, /hello agent/);
  const history = await call(tools, 'protocol_v9_acp_prompt', { action: 'history', sessionId });
  assert.equal(history.messageCount, 2);
  assert.equal(history.messages[0].role, 'user');
  const suspended = await call(tools, 'protocol_v9_acp_sessions', { action: 'suspend', sessionId });
  assert.equal(suspended.session.status, 'suspended');
  const resumed = await call(tools, 'protocol_v9_acp_sessions', { action: 'resume-suspended', sessionId });
  assert.equal(resumed.session.status, 'idle');
  const counts = await call(tools, 'protocol_v9_acp_sessions', { action: 'counts' });
  assert.equal(counts.counts.total, 1);
  assert.equal(counts.counts.running, 1);
  const resumedThread = await call(tools, 'protocol_v9_acp_sessions', { action: 'resume', sessionId });
  assert.equal(resumedThread.session.parentSessionId, sessionId);
  assert.equal(resumedThread.session.messages.length, 2);
  assert.equal(resumedThread.session.resumeCount, 1);
  const cancelled = await call(tools, 'protocol_v9_acp_sessions', { action: 'cancel', sessionId: resumedThread.session.id });
  assert.equal(cancelled.session.status, 'cancelled');
  const snap = await call(tools, 'protocol_v9_acp_sessions', { action: 'snapshot' });
  assert.equal(snap.snapshot.version, 9);
  assert.equal(snap.snapshot.sessions.length, 2);
});

test('protocol_v9_a2a_cards: build / register / discover / well-known; non-loopback refused', async () => {
  const tools = createProtocolV117Tools();
  const built = await call(tools, 'protocol_v9_a2a_cards', { action: 'build', card: goodCard() });
  assert.equal(built.card.name, 'summariser');
  assert.equal(built.wellKnownUrl, 'http://127.0.0.1:8765/.well-known/agent-card.json');
  const registered = await call(tools, 'protocol_v9_a2a_cards', { action: 'register', card: goodCard() });
  assert.equal(registered.registered.card.name, 'summariser');
  const found = await call(tools, 'protocol_v9_a2a_cards', { action: 'discover-skill', skillId: 'summarise' });
  assert.equal(found.cards.length, 1);
  const byTag = await call(tools, 'protocol_v9_a2a_cards', { action: 'discover-tag', tag: 'docs' });
  assert.equal(byTag.cards.length, 1);
  const byCap = await call(tools, 'protocol_v9_a2a_cards', { action: 'discover-capability', capability: 'streaming' });
  assert.equal(byCap.cards.length, 1);
  const searched = await call(tools, 'protocol_v9_a2a_cards', { action: 'search', query: 'summar' });
  assert.equal(searched.cards.length, 1);
  const wk = await call(tools, 'protocol_v9_a2a_cards', { action: 'well-known', url: 'http://localhost:9000' });
  assert.equal(wk.wellKnownUrl, 'http://localhost:9000/.well-known/agent-card.json');
  const bad = await tools.find((t) => t.definition.name === 'protocol_v9_a2a_cards')
    .execute({ action: 'register', card: { ...goodCard('outsider'), url: 'https://agents.example.com' } });
  assert.ok(bad.startsWith('Error:'), 'non-loopback card URL must be refused');
  assert.match(bad, /not loopback/);
});

test('protocol_v9_a2a_tasks + messages: create / message / artifact / lifecycle', async () => {
  const tools = createProtocolV117Tools();
  const created = await call(tools, 'protocol_v9_a2a_tasks', {
    action: 'create', contextId: 'ctx-1', agentName: 'summariser', skillId: 'summarise', initialMessage: 'go',
  });
  const taskId = created.task.id;
  assert.equal(created.task.state, 'submitted');
  const msg = await call(tools, 'protocol_v9_a2a_messages', {
    action: 'send-message', taskId, role: 'agent', text: 'working on it',
  });
  assert.equal(msg.message.role, 'agent');
  const art = await call(tools, 'protocol_v9_a2a_messages', {
    action: 'add-artifact', taskId, kind: 'data', name: 'points.json',
    payload: '{"points":[1]}', producedBy: 'summariser',
  });
  assert.equal(art.artifact.kind, 'data');
  const listed = await call(tools, 'protocol_v9_a2a_messages', { action: 'list-artifacts', taskId });
  assert.equal(listed.artifacts.length, 1);
  const working = await call(tools, 'protocol_v9_a2a_tasks', { action: 'transition', taskId, state: 'working' });
  assert.equal(working.task.state, 'working');
  const waiting = await call(tools, 'protocol_v9_a2a_tasks', { action: 'request-input', taskId, reason: 'which doc?' });
  assert.equal(waiting.task.state, 'input-required');
  const back = await call(tools, 'protocol_v9_a2a_tasks', { action: 'provide-input', taskId, text: 'the report' });
  assert.equal(back.task.state, 'working');
  const done = await call(tools, 'protocol_v9_a2a_tasks', { action: 'complete', taskId, reason: 'delivered' });
  assert.equal(done.task.state, 'completed');
  const counts = await call(tools, 'protocol_v9_a2a_tasks', { action: 'counts' });
  assert.equal(counts.counts.completed, 1);
  const history = await call(tools, 'protocol_v9_a2a_messages', { action: 'history', taskId });
  assert.ok(history.messageCount >= 3);
});

test('protocol_v9_a2a_delegate: delegate / match / policy / push configs', async () => {
  const tools = createProtocolV117Tools();
  await call(tools, 'protocol_v9_a2a_cards', { action: 'register', card: goodCard() });
  const matched = await call(tools, 'protocol_v9_a2a_delegate', { action: 'match', skillId: 'summarise' });
  assert.deepEqual(matched.candidates, ['summariser']);
  const delegated = await call(tools, 'protocol_v9_a2a_delegate', {
    action: 'delegate', contextId: 'ctx-2', skillId: 'summarise', initialMessage: 'summarise this',
  });
  assert.equal(delegated.agentName, 'summariser');
  assert.equal(delegated.task.state, 'submitted');
  const taskId = delegated.task.id;
  const policyOk = await call(tools, 'protocol_v9_a2a_delegate', { action: 'policy', url: 'http://127.0.0.1:9999/hook' });
  assert.equal(policyOk.loopback, true);
  assert.equal(policyOk.allowed, true);
  const policyBad = await call(tools, 'protocol_v9_a2a_delegate', { action: 'policy', url: 'https://hooks.example.com/x' });
  assert.equal(policyBad.loopback, false);
  assert.equal(policyBad.allowed, false);
  const push = await call(tools, 'protocol_v9_a2a_delegate', {
    action: 'push-add', taskId, url: 'http://localhost:9999/hook', states: ['completed'],
  });
  assert.equal(push.pushConfig.taskId, taskId);
  const listed = await call(tools, 'protocol_v9_a2a_delegate', { action: 'push-list', taskId });
  assert.equal(listed.pushConfigs.length, 1);
  const removed = await call(tools, 'protocol_v9_a2a_delegate', { action: 'push-remove', configId: push.pushConfig.configId });
  assert.equal(removed.removed, true);
  const noAgent = await tools.find((t) => t.definition.name === 'protocol_v9_a2a_delegate')
    .execute({ action: 'delegate', contextId: 'ctx-3', skillId: 'no-such-skill' });
  assert.ok(noAgent.startsWith('Error:'));
  assert.match(noAgent, /No registered agent offers skill/);
});

test('protocol_v9_registry + snapshots: unified counts, save-all / restore-all', async () => {
  const tools = createProtocolV117Tools();
  await call(tools, 'protocol_v9_apps', {
    action: 'register', uri: 'ui://weather-card/main', name: 'Weather card',
    html: GOOD_HTML, domains: ['cdn.example.com'], allowedTools: [], toolName: 'weather',
  });
  await call(tools, 'protocol_v9_acp_sessions', { action: 'create', agent: 'claude', allowUnverified: true });
  await call(tools, 'protocol_v9_a2a_cards', { action: 'register', card: goodCard() });
  await call(tools, 'protocol_v9_a2a_tasks', { action: 'create', contextId: 'c', agentName: 'summariser' });
  const counts = await call(tools, 'protocol_v9_registry', {});
  assert.equal(counts.counts.apps.resources, 1);
  assert.equal(counts.counts.acpSessions.total, 1);
  assert.equal(counts.counts.a2aCards.size, 1);
  assert.equal(counts.counts.a2aTasks.total, 1);
  const appsSection = await call(tools, 'protocol_v9_registry', { section: 'apps' });
  assert.equal(appsSection.resources.length, 1);
  const saved = await call(tools, 'protocol_v9_snapshots', { action: 'save-all' });
  assert.equal(saved.snapshot.version, 9);
  assert.equal(saved.snapshot.apps.instances.length, 0);
  assert.equal(saved.snapshot.acpSessions.sessions.length, 1);
  assert.equal(saved.snapshot.a2aTasks.tasks.length, 1);
  const tools2 = createProtocolV117Tools();
  await call(tools2, 'protocol_v9_apps', {
    action: 'register', uri: 'ui://weather-card/main', name: 'Weather card',
    html: GOOD_HTML, domains: ['cdn.example.com'], allowedTools: [], toolName: 'weather',
  });
  const restored = await call(tools2, 'protocol_v9_snapshots', { action: 'restore-all', snapshot: saved.snapshot });
  assert.equal(restored.restore.acpSessions.restored, 1);
  assert.equal(restored.restore.a2aTasks.restored, 1);
});

test('ALL_TOOLS contains the 12 v9 tools exactly once; bind replaces in place', () => {
  for (const name of EXPECTED_NAMES) {
    const found = ALL_TOOLS.filter((t) => t.definition.name === name);
    assert.equal(found.length, 1, `ALL_TOOLS must contain ${name} exactly once`);
  }
  const bound = createDefaultTools({ getProtocolV117ToolOptions: () => ({}) });
  assert.equal(bound.length, ALL_TOOLS.length);
  assert.equal(new Set(bound.map((t) => t.definition.name)).size, bound.length);
  for (const name of EXPECTED_NAMES) {
    assert.equal(bound.filter((t) => t.definition.name === name).length, 1);
  }
  // NOTE (v1.40 T2): the pinned ALL_TOOLS total in
  // tests/agent-teams-v3-v111.test.mjs and
  // tests/coding-v2-tools.test.mjs (1078) needs a re-pin at
  // merge time (+12 here, plus the other v140 teams' tools).
});

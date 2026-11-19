/**
 * Tests for v1.40 (Team T2) — protocols v9 A2A v1.1:
 * packages/core/src/protocolsV9/a2aV9.ts
 *
 * Covers:
 *  - loopback guard (localhost / 127.0.0.1 / [::1] pass;
 *    *.local, 10.x, 192.168.x, public hosts, non-http and
 *    garbage all fail)
 *  - well-known URL builder (loopback base only)
 *  - Agent Card build / validate (loopback URL, supported
 *    protocol version, unique skill ids, skill shape)
 *  - card registry (register / discover by skill, tag,
 *    capability / search / unregister)
 *  - task lifecycle (create / transition guards / cancel /
 *    complete / input-required round-trip)
 *  - message + artifact exchange (terminal tasks refuse;
 *    data artifacts must be JSON; payload size capped)
 *  - delegation with capability matching (no agent for the
 *    skill throws; capability prefers the matching agent)
 *  - push configs (loopback URL only)
 *  - overdue sweep + prune
 *  - snapshot / restore (working tasks come back submitted;
 *    non-loopback push configs dropped)
 *
 * Run after building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/protocols-v9-a2a.test.mjs
 *
 * No network, no model — delegation records the task against
 * a locally registered card; nothing is ever sent.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  A2aV9CardRegistry,
  A2aV9TaskStore,
  buildA2aV9AgentCard,
  buildA2aV9WellKnownUrl,
  isA2aV9LoopbackUrl,
  validateA2aV9AgentCard,
} from '../packages/core/dist/index.js';

function goodCard(overrides = {}) {
  return {
    name: 'summariser',
    description: 'Summarises documents.',
    url: 'http://127.0.0.1:8765',
    version: '1.0.0',
    protocolVersions: ['1.1'],
    capabilities: { streaming: true, pushNotifications: false, extendedTask: true, fileArtifacts: true },
    skills: [
      { id: 'summarise', name: 'Summarise', description: 'Summarise a document.', tags: ['docs', 'summary'] },
      { id: 'extract', name: 'Extract', description: 'Extract key points.', tags: ['docs'] },
    ],
    ...overrides,
  };
}

function registryWithTwoAgents() {
  const registry = new A2aV9CardRegistry();
  registry.register(buildA2aV9AgentCard(goodCard()));
  registry.register(buildA2aV9AgentCard(goodCard({
    name: 'streamer',
    description: 'Streams answers.',
    url: 'http://localhost:9000',
    capabilities: { streaming: true, pushNotifications: true },
    skills: [{ id: 'summarise', name: 'Summarise', description: 'Summarise live.', tags: ['live'] }],
  })));
  return registry;
}

test('loopback guard: only localhost / 127.0.0.1 / [::1] over http(s)', () => {
  assert.equal(isA2aV9LoopbackUrl('http://localhost:8080/x'), true);
  assert.equal(isA2aV9LoopbackUrl('http://localhost/x'), true);
  assert.equal(isA2aV9LoopbackUrl('https://127.0.0.1:9000/'), true);
  assert.equal(isA2aV9LoopbackUrl('http://[::1]:8080/'), true);
  assert.equal(isA2aV9LoopbackUrl('http://agent.local:8080/'), false);
  assert.equal(isA2aV9LoopbackUrl('http://10.0.0.5/'), false);
  assert.equal(isA2aV9LoopbackUrl('http://192.168.1.2/'), false);
  assert.equal(isA2aV9LoopbackUrl('https://example.com/'), false);
  assert.equal(isA2aV9LoopbackUrl('http://evil-localhost.example.com/'), false);
  assert.equal(isA2aV9LoopbackUrl('ftp://localhost/'), false);
  assert.equal(isA2aV9LoopbackUrl('not a url'), false);
  assert.equal(isA2aV9LoopbackUrl(''), false);
});

test('well-known URL builder: loopback base only, trailing slashes trimmed', () => {
  assert.equal(
    buildA2aV9WellKnownUrl('http://127.0.0.1:8765/'),
    'http://127.0.0.1:8765/.well-known/agent-card.json',
  );
  assert.equal(
    buildA2aV9WellKnownUrl('http://localhost:9000'),
    'http://localhost:9000/.well-known/agent-card.json',
  );
  assert.throws(() => buildA2aV9WellKnownUrl('https://example.com'), /not loopback/);
});

test('Agent Card build / validate', () => {
  const card = buildA2aV9AgentCard(goodCard());
  assert.equal(card.protocolVersions[0], '1.1');
  assert.deepEqual(validateA2aV9AgentCard(card), []);
  // Defaults to the current version when omitted.
  const { protocolVersions, ...rest } = goodCard();
  assert.equal(buildA2aV9AgentCard(rest).protocolVersions[0], '1.1');
  // Non-loopback URL refused.
  assert.throws(
    () => buildA2aV9AgentCard(goodCard({ url: 'https://agents.example.com' })),
    /not loopback/,
  );
  // No supported protocol version refused.
  assert.throws(
    () => buildA2aV9AgentCard(goodCard({ protocolVersions: ['9.9'] })),
    /no version open-bot speaks/,
  );
  // Duplicate skill ids refused.
  assert.throws(
    () => buildA2aV9AgentCard(goodCard({
      skills: [
        { id: 'dup', name: 'A', description: 'a' },
        { id: 'dup', name: 'B', description: 'b' },
      ],
    })),
    /Duplicate skill id/,
  );
  // Empty skill description refused.
  assert.throws(
    () => buildA2aV9AgentCard(goodCard({
      skills: [{ id: 'x', name: 'X', description: '' }],
    })),
    /non-empty description/,
  );
  // Too many skills refused.
  const many = Array.from({ length: 65 }, (_, i) => ({ id: `s${i}`, name: `S${i}`, description: 'd' }));
  assert.throws(() => buildA2aV9AgentCard(goodCard({ skills: many })), /max 64/);
});

test('card registry: register / discover / search / unregister', () => {
  const registry = registryWithTwoAgents();
  assert.equal(registry.size(), 2);
  assert.deepEqual(registry.names(), ['streamer', 'summariser']);
  assert.equal(registry.get('summariser').wellKnownUrl, 'http://127.0.0.1:8765/.well-known/agent-card.json');
  assert.equal(registry.discoverBySkill('summarise').length, 2);
  assert.equal(registry.discoverBySkill('extract').length, 1);
  assert.equal(registry.discoverBySkill('nope').length, 0);
  assert.deepEqual(registry.discoverByTag('docs').map((c) => c.card.name), ['summariser']);
  assert.deepEqual(registry.discoverByTag('live').map((c) => c.card.name), ['streamer']);
  assert.deepEqual(registry.discoverByCapability('pushNotifications').map((c) => c.card.name), ['streamer']);
  assert.equal(registry.discoverByCapability('streaming').length, 2);
  assert.deepEqual(registry.search('stream').map((c) => c.card.name), ['streamer']);
  assert.deepEqual(registry.search('summar').map((c) => c.card.name), ['streamer', 'summariser']);
  assert.equal(registry.unregister('streamer'), true);
  assert.equal(registry.unregister('streamer'), false);
  assert.equal(registry.size(), 1);
  assert.equal(registry.get('streamer'), undefined);
  assert.throws(() => registry.register(buildA2aV9AgentCard(goodCard({ url: 'https://x.example.com' }))), /not loopback/);
});

test('task lifecycle: transitions, guards, input-required round-trip', () => {
  const store = new A2aV9TaskStore();
  const task = store.create({ contextId: 'ctx-1', agentName: 'summariser', skillId: 'summarise', initialMessage: 'summarise this' });
  assert.equal(task.state, 'submitted');
  assert.equal(task.history.length, 1);
  assert.equal(task.history[0].role, 'user');
  assert.throws(() => store.transition(task.id, 'completed'), /Cannot move task/);
  assert.equal(store.transition(task.id, 'working').state, 'working');
  const waiting = store.requestInput(task.id, 'which document?');
  assert.equal(waiting.state, 'input-required');
  assert.equal(waiting.reason, 'which document?');
  assert.throws(() => store.complete(task.id), /Cannot move task/);
  const back = store.provideInput(task.id, 'the quarterly report');
  assert.equal(back.state, 'working');
  assert.equal(back.history.length, 2);
  assert.equal(back.history.at(-1).text, 'the quarterly report');
  assert.equal(store.complete(task.id, 'summary delivered').state, 'completed');
  assert.throws(() => store.cancel(task.id), /Cannot move task/);
  assert.throws(() => store.sendMessage(task.id, 'user', 'more'), /is completed/);
  assert.throws(() => store.provideInput(task.id, 'x'), /not input-required/);
  const counts = store.counts();
  assert.equal(counts.completed, 1);
  assert.equal(counts.total, 1);
  assert.equal(counts.open, 0);
  assert.equal(store.listForAgent('summariser').length, 1);
  assert.equal(store.listForContext('ctx-1').length, 1);
  assert.equal(store.listForContext('other').length, 0);
});

test('cancel and reject paths', () => {
  const store = new A2aV9TaskStore();
  const a = store.create({ contextId: 'c', agentName: 'summariser' });
  assert.equal(store.cancel(a.id, 'user changed their mind').state, 'canceled');
  const b = store.create({ contextId: 'c', agentName: 'summariser' });
  assert.equal(store.transition(b.id, 'rejected', 'skill not supported').state, 'rejected');
  assert.throws(() => store.create({ contextId: '', agentName: 'x' }), /non-empty contextId/);
  assert.throws(() => store.create({ contextId: 'c', agentName: '' }), /non-empty agentName/);
  assert.throws(() => store.create({ contextId: 'c', agentName: 'x', deadlineMs: Date.now() - 1000 }), /future timestamp/);
});

test('message + artifact exchange: terminal refusal, JSON data, size cap', () => {
  const store = new A2aV9TaskStore();
  const task = store.create({ contextId: 'c', agentName: 'summariser' });
  store.transition(task.id, 'working');
  const msg = store.sendMessage(task.id, 'agent', 'working on it');
  assert.equal(msg.role, 'agent');
  assert.equal(msg.taskId, task.id);
  const text = store.addArtifact(task.id, { kind: 'text', name: 'summary.md', payload: '# Summary\nDone.', mimeType: 'text/markdown', producedBy: 'summariser' });
  assert.equal(text.kind, 'text');
  assert.equal(store.listArtifacts(task.id).length, 1);
  const data = store.addArtifact(task.id, { kind: 'data', name: 'points.json', payload: '{"points":[1,2]}', producedBy: 'summariser' });
  assert.equal(data.kind, 'data');
  assert.throws(
    () => store.addArtifact(task.id, { kind: 'data', name: 'bad.json', payload: '{not json', producedBy: 'summariser' }),
    /must be valid JSON/,
  );
  assert.throws(
    () => store.addArtifact(task.id, { kind: 'video', name: 'v.mp4', payload: 'x', producedBy: 'summariser' }),
    /Artifact kind/,
  );
  assert.throws(
    () => store.addArtifact(task.id, { kind: 'text', name: 'big.txt', payload: 'x'.repeat(256 * 1024 + 1), producedBy: 'summariser' }),
    /max 262144/,
  );
  assert.throws(() => store.sendMessage(task.id, 'user', '   '), /non-empty/);
  store.complete(task.id);
  assert.throws(() => store.sendMessage(task.id, 'agent', 'late'), /is completed/);
  assert.throws(
    () => store.addArtifact(task.id, { kind: 'text', name: 'late.md', payload: 'x', producedBy: 'summariser' }),
    /is completed/,
  );
});

test('delegation with capability matching', () => {
  const registry = registryWithTwoAgents();
  const store = new A2aV9TaskStore();
  // Both agents offer 'summarise'; only 'streamer' has pushNotifications.
  const { task, agentName, candidates } = store.delegate(registry, {
    contextId: 'ctx-9', skillId: 'summarise', capability: 'pushNotifications', initialMessage: 'go',
  });
  assert.equal(agentName, 'streamer');
  assert.equal(task.agentName, 'streamer');
  assert.equal(task.skillId, 'summarise');
  assert.equal(task.state, 'submitted');
  assert.deepEqual(candidates.sort(), ['streamer', 'summariser']);
  // Without a capability preference the first registered match wins.
  const plain = store.delegate(registry, { contextId: 'ctx-10', skillId: 'extract' });
  assert.equal(plain.agentName, 'summariser');
  // No agent offers the skill.
  assert.throws(
    () => store.delegate(registry, { contextId: 'ctx-11', skillId: 'no-such-skill' }),
    /No registered agent offers skill/,
  );
  assert.equal(store.eventsFor(task.id).at(-1).kind, 'delegated');
});

test('push configs: loopback URL only', () => {
  const store = new A2aV9TaskStore();
  const task = store.create({ contextId: 'c', agentName: 'summariser' });
  const config = store.addPushConfig(task.id, 'http://127.0.0.1:9999/hook', ['completed', 'failed']);
  assert.equal(config.taskId, task.id);
  assert.deepEqual(config.states, ['completed', 'failed']);
  assert.equal(store.listPushConfigs(task.id).length, 1);
  assert.throws(() => store.addPushConfig(task.id, 'https://hooks.example.com/x'), /not loopback/);
  assert.equal(store.removePushConfig(config.configId), true);
  assert.equal(store.removePushConfig(config.configId), false);
  assert.equal(store.listPushConfigs(task.id).length, 0);
});

test('overdue sweep and prune', () => {
  const store = new A2aV9TaskStore();
  const task = store.create({ contextId: 'c', agentName: 'summariser', deadlineMs: Date.now() + 60_000 });
  assert.deepEqual(store.sweepOverdue(Date.now()), []);
  assert.deepEqual(store.sweepOverdue(Date.now() + 61_000), [task.id]);
  assert.equal(store.get(task.id).state, 'failed');
  assert.match(store.get(task.id).reason, /Deadline passed/);
  // Prune needs an age; a fresh terminal task is not pruned.
  assert.equal(store.pruneTerminal(60_000), 0);
  const snap = store.snapshot();
  snap.tasks[0].updatedAt = Date.now() - 100_000;
  const store2 = new A2aV9TaskStore();
  store2.restore(snap);
  assert.equal(store2.pruneTerminal(60_000), 1);
  assert.equal(store2.get(task.id), undefined);
});

test('snapshot / restore: working tasks come back submitted, bad push URLs dropped', () => {
  const store = new A2aV9TaskStore();
  const task = store.create({ contextId: 'c', agentName: 'summariser' });
  store.transition(task.id, 'working');
  store.sendMessage(task.id, 'agent', 'half done');
  store.addArtifact(task.id, { kind: 'text', name: 'draft.md', payload: 'draft', producedBy: 'summariser' });
  store.addPushConfig(task.id, 'http://localhost:9999/hook');
  const snapshot = store.snapshot();
  assert.equal(snapshot.version, 9);
  assert.equal(snapshot.tasks.length, 1);
  assert.equal(snapshot.pushConfigs.length, 1);

  const store2 = new A2aV9TaskStore();
  const restored = store2.restore(snapshot);
  assert.equal(restored.restored, 1);
  assert.deepEqual(restored.dropped, []);
  // Working -> submitted: no live runner survives a restart.
  assert.equal(store2.get(task.id).state, 'submitted');
  assert.equal(store2.get(task.id).history.length, 1);
  assert.equal(store2.get(task.id).artifacts.length, 1);
  assert.equal(store2.listPushConfigs(task.id).length, 1);

  // A non-loopback push config in the snapshot is dropped.
  const tampered = structuredClone(snapshot);
  tampered.pushConfigs[0].url = 'https://hooks.example.com/x';
  const store3 = new A2aV9TaskStore();
  const r3 = store3.restore(tampered);
  assert.equal(r3.restored, 1);
  assert.equal(r3.dropped.length, 1);
  assert.match(r3.dropped[0], /not loopback/);
  assert.equal(store3.listPushConfigs(task.id).length, 0);
  assert.throws(() => store3.restore({ version: 8, tasks: [] }), /version 9/);
});

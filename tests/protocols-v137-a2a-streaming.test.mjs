/**
 * Protocols v6 — A2A 1.1 two-way streaming tests (v1.37, Team T2).
 *
 * Covers packages/core/src/protocolsV6/a2aStreamingV6.ts:
 * loopback pair, client input -> agent echo, interrupt/resume
 * mid-task, cancel (terminal), agent status/message/artifact/
 * input-required/finish/fail, frame validation + out-of-order
 * rejection, pause/resume delivery, resume tokens, artifact
 * split + reassemble.
 *
 * No network: both sides run in-process via the loopback pair.
 *
 * Run after building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/protocols-v137-a2a-streaming.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  A2aV6Stream,
  createLoopbackA2aV6Pair,
  parseA2aV6ResumeToken,
  reassembleA2aV6Artifact,
  splitA2aV6Artifact,
  validateA2aV6Frame,
} from '../packages/core/dist/index.js';

test('frame validation: good frames pass, bad frames are named', () => {
  const good = validateA2aV6Frame({ seq: 0, taskId: 't1', direction: 'upstream', kind: 'input', payload: { text: 'hi' }, at: 1 });
  assert.equal(good.ok, true);
  assert.equal(validateA2aV6Frame({ seq: 0, taskId: 't1', direction: 'upstream', kind: 'message', payload: {}, at: 1 }).ok, false);
  assert.equal(validateA2aV6Frame({ seq: -1, taskId: 't1', direction: 'upstream', kind: 'input', payload: {}, at: 1 }).ok, false);
  assert.equal(validateA2aV6Frame({ seq: 0, taskId: '', direction: 'upstream', kind: 'input', payload: {}, at: 1 }).ok, false);
  assert.equal(validateA2aV6Frame('nope').ok, false);
  assert.equal(validateA2aV6Frame({ seq: 0, taskId: 't1', direction: 'sideways', kind: 'input', payload: {}, at: 1 }).ok, false);
});

test('loopback pair: client input reaches the agent, agent message reaches the client', () => {
  const { client, agent } = createLoopbackA2aV6Pair('task-1');
  const clientSeen = [];
  const agentSeen = [];
  client.onFrame((f) => clientSeen.push(f));
  agent.onFrame((f) => agentSeen.push(f));
  client.sendInput('do the thing');
  assert.equal(agentSeen.length, 1);
  assert.equal(agentSeen[0]?.kind, 'input');
  assert.equal(agentSeen[0]?.payload['text'], 'do the thing');
  assert.equal(agent.getTaskState(), 'working');
  agent.sendMessage('working on it');
  assert.equal(clientSeen.length, 1);
  assert.equal(clientSeen[0]?.kind, 'message');
  assert.equal(client.getTaskState(), 'working');
  agent.sendStatus('working', 'half done', 50);
  assert.equal(clientSeen.length, 2);
  assert.equal(clientSeen[1]?.payload['progressPercent'], 50);
  assert.throws(() => agent.sendStatus('working', undefined, 101), /0\.\.100/);
  client.close();
  agent.close();
});

test('wrong side refuses: only the client sends input, only the agent sends messages', () => {
  const { client, agent } = createLoopbackA2aV6Pair('task-2');
  assert.throws(() => agent.sendInput('x'), /Only the client side/);
  assert.throws(() => client.sendMessage('x'), /Only the agent side/);
  assert.throws(() => client.sendStatus('working'), /Only the agent side/);
  assert.throws(() => agent.interrupt(), /Only the client side/);
  client.close();
  agent.close();
});

test('interrupt pauses, resume continues, cancel is terminal', () => {
  const { client, agent } = createLoopbackA2aV6Pair('task-3');
  client.sendInput('start');
  client.interrupt('wait');
  assert.equal(client.getTaskState(), 'paused');
  assert.equal(agent.getTaskState(), 'paused');
  client.resumeTask();
  assert.equal(client.getTaskState(), 'working');
  assert.equal(agent.getTaskState(), 'working');
  client.cancelTask('no longer needed');
  assert.equal(client.getTaskState(), 'cancelled');
  assert.equal(agent.getTaskState(), 'cancelled');
  assert.equal(client.isClosed(), true);
  assert.throws(() => client.sendInput('more'), /closed/);
  assert.throws(() => client.resumeTask(), /Only a paused/);
});

test('agent requests input, client answers, agent finishes', () => {
  const { client, agent } = createLoopbackA2aV6Pair('task-4');
  client.sendInput('start');
  agent.requestInput('Which color?', 'elicit-1');
  assert.equal(client.getTaskState(), 'input-required');
  client.sendInput('blue');
  assert.equal(client.getTaskState(), 'working');
  const done = agent.finish('all done');
  assert.equal(done.kind, 'done');
  assert.equal(client.getTaskState(), 'completed');
  assert.equal(agent.getTaskState(), 'completed');
  assert.equal(client.isClosed(), true);
});

test('agent fail ends the task as failed', () => {
  const { client, agent } = createLoopbackA2aV6Pair('task-5');
  client.sendInput('start');
  agent.fail('agent-error', 'something broke');
  assert.equal(client.getTaskState(), 'failed');
  assert.equal(agent.getTaskState(), 'failed');
});

test('out-of-order frames are rejected', () => {
  const { client, agent } = createLoopbackA2aV6Pair('task-6');
  // Deliver a frame with the wrong sequence directly.
  assert.throws(
    () => agent.receive({ seq: 5, taskId: 'task-6', direction: 'upstream', kind: 'input', payload: { text: 'x' }, at: 1 }),
    /Out-of-order/,
  );
  assert.throws(
    () => agent.receive({ seq: 0, taskId: 'other-task', direction: 'upstream', kind: 'input', payload: { text: 'x' }, at: 1 }),
    /does not match/,
  );
  client.close();
  agent.close();
});

test('pause queues delivery, resume drains in order', () => {
  const { client, agent } = createLoopbackA2aV6Pair('task-7');
  const seen = [];
  client.onFrame((f) => seen.push(f));
  client.pause();
  assert.equal(client.getStatus(), 'paused');
  agent.sendMessage('one');
  agent.sendMessage('two');
  assert.equal(seen.length, 0);
  assert.equal(client.view().queuedInbound, 2);
  client.resumeDelivery();
  assert.equal(seen.length, 2);
  assert.equal(seen[0]?.payload['text'], 'one');
  assert.equal(seen[1]?.payload['text'], 'two');
  client.close();
  agent.close();
});

test('resume token round-trips and bad tokens throw', () => {
  const { client, agent } = createLoopbackA2aV6Pair('task-8');
  client.sendInput('start');
  const token = client.makeResumeToken();
  const parsed = parseA2aV6ResumeToken(token);
  assert.equal(parsed.taskId, 'task-8');
  assert.equal(parsed.taskState, 'working');
  assert.equal(typeof parsed.receivedSeq, 'number');
  assert.throws(() => parseA2aV6ResumeToken('not-a-token!!!'), /Invalid A2A resume token/);
  assert.throws(() => parseA2aV6ResumeToken(Buffer.from('{"v":2}', 'utf8').toString('base64url')), /Invalid A2A resume token/);
  client.close();
  agent.close();
});

test('resume with a bad token is refused before sending', () => {
  const { client, agent } = createLoopbackA2aV6Pair('task-9');
  client.sendInput('start');
  client.interrupt();
  assert.throws(() => client.resumeTask('garbage'), /Invalid A2A resume token/);
  const token = client.makeResumeToken();
  client.resumeTask(token);
  assert.equal(client.getTaskState(), 'working');
  client.close();
  agent.close();
});

test('artifact split + reassemble round-trips; bad chunks are refused', () => {
  const content = 'hello artifact world, this is a longer piece of content to split.';
  const chunks = splitA2aV6Artifact('art-1', content, 10);
  assert.ok(chunks.length > 1);
  assert.equal(chunks[0]?.index, 0);
  assert.equal(chunks[chunks.length - 1]?.last, true);
  assert.equal(chunks.every((c) => c.total === chunks.length), true);
  assert.equal(reassembleA2aV6Artifact(chunks), content);
  // Stream the chunks through a live pair and reassemble from the wire.
  const { client, agent } = createLoopbackA2aV6Pair('task-10');
  const received = [];
  client.onFrame((f) => {
    if (f.kind === 'artifact-chunk') received.push(f.payload);
  });
  client.sendInput('start');
  for (const chunk of chunks) {
    agent.sendArtifactChunk(chunk.artifactId, chunk.index, chunk.total, chunk.data, chunk.last);
  }
  assert.equal(received.length, chunks.length);
  assert.equal(reassembleA2aV6Artifact(received), content);
  client.close();
  agent.close();
  // Incomplete / out-of-order / disagreeing chunks fail.
  assert.throws(() => reassembleA2aV6Artifact(chunks.slice(0, -1)), /incomplete/);
  assert.throws(() => reassembleA2aV6Artifact([]), /No artifact chunks/);
  const shuffled = [...chunks];
  const first = shuffled.shift();
  shuffled.push(first);
  assert.throws(() => reassembleA2aV6Artifact(shuffled.map((c, i) => ({ ...c, index: i === shuffled.length - 1 ? 99 : c.index }))), /missing/);
  assert.throws(() => agent.sendArtifactChunk('a', 5, 2, 'x', false), /out of range/);
});

test('connect refuses mismatched tasks and same roles', () => {
  const a = new A2aV6Stream('t-a', 'client', { heartbeatMs: 0 });
  const b = new A2aV6Stream('t-b', 'agent', { heartbeatMs: 0 });
  assert.throws(() => a.connect(b), /does not match/);
  const c = new A2aV6Stream('t-a', 'client', { heartbeatMs: 0 });
  assert.throws(() => a.connect(c), /opposite role/);
  a.close();
  b.close();
  c.close();
});

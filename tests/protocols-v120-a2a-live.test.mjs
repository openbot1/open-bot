/**
 * Protocols v4 — A2A v1.1 RC SendLiveMessage live session tests (v1.20, Team T2).
 *
 * Covers packages/core/src/protocolsV4/a2aLiveV4.ts: negotiation,
 * the message/sendLive JSON-RPC envelope, resume tokens, the
 * loopback live session (input / status / message round-trip),
 * client-written artifacts, backpressure (flicker + window queue),
 * resume / dedup after a dropped frame, generation bump on
 * reconnect, coherent history ordering, and the terminal-state
 * guard on sendDone.
 *
 * No network, no provider: everything runs in-process against
 * the built core dist.
 *
 * Run after building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/protocols-v120-a2a-live.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  A2A_V4_LIVE_METHOD,
  A2aLiveV4History,
  createLoopbackLiveSession,
  makeA2aLiveResumeToken,
  negotiateA2aLiveV4,
  buildSendLiveRequest,
  parseA2aLiveResumeToken,
  parseSendLiveRequest,
} from '../packages/core/dist/index.js';

function task(id = 'task-1') {
  return { id, contextId: 'ctx-1', status: { state: 'submitted' } };
}

function userMessage(messageId = 'm-1', text = 'hello') {
  return { kind: 'message', messageId, role: 'user', parts: [{ kind: 'text', text }] };
}

function agentMessage(messageId = 'm-2', text = 'working on it') {
  return { kind: 'message', messageId, role: 'agent', parts: [{ kind: 'text', text }] };
}

test('negotiation: live session needs A2A 1.1-rc/1.1 AND liveStreaming', () => {
  const ok = negotiateA2aLiveV4(['1.1-rc', '1.0'], { streaming: true, liveStreaming: true });
  assert.equal(ok.supported, true);
  assert.equal(ok.negotiatedVersion, '1.1-rc');

  const old = negotiateA2aLiveV4(['1.0'], { streaming: true, liveStreaming: true });
  assert.equal(old.supported, false);
  assert.match(old.reason, /1\.1/);

  const noCap = negotiateA2aLiveV4(['1.1-rc'], { streaming: true });
  assert.equal(noCap.supported, false);
  assert.match(noCap.reason, /liveStreaming/);

  const none = negotiateA2aLiveV4([], {});
  assert.equal(none.supported, false);
  assert.equal(none.negotiatedVersion, null);
});

test('message/sendLive envelope builds and parses; bad envelopes rejected', () => {
  const req = buildSendLiveRequest('req-1', { message: userMessage(), taskId: 'task-1' });
  assert.equal(req.jsonrpc, '2.0');
  assert.equal(req.method, 'message/sendLive');
  assert.equal(req.method, A2A_V4_LIVE_METHOD);
  assert.equal(parseSendLiveRequest(req).ok, true);

  assert.equal(parseSendLiveRequest({ ...req, method: 'message/send' }).ok, false);
  assert.equal(
    parseSendLiveRequest({ jsonrpc: '2.0', id: 1, method: 'message/sendLive', params: { message: { messageId: '', parts: [] } } }).ok,
    false,
  );
  assert.equal(
    parseSendLiveRequest({ jsonrpc: '2.0', id: 1, method: 'message/sendLive', params: { message: { messageId: 'm-1', parts: 'nope' } } }).ok,
    false,
  );
  assert.equal(
    parseSendLiveRequest({ jsonrpc: '2.0', id: 1, method: 'message/sendLive', params: { message: userMessage(), generation: -1 } }).ok,
    false,
  );
});

test('resume tokens round-trip; malformed tokens return null', () => {
  const token = makeA2aLiveResumeToken('task-1', 2, 7);
  assert.equal(token, 'live:task-1:2:7');
  assert.deepEqual(parseA2aLiveResumeToken(token), { taskId: 'task-1', generation: 2, lastAckedSequence: 7 });
  assert.equal(parseA2aLiveResumeToken('live:task-1:2'), null);
  assert.equal(parseA2aLiveResumeToken('bogus'), null);
  assert.equal(parseA2aLiveResumeToken('live:task-1:x:7'), null);
});

test('loopback live session: input / status / message round-trip with generation 0', async () => {
  const inputs = [];
  const statuses = [];
  const messages = [];
  const { client, agent } = createLoopbackLiveSession(task(), {
    onStatus: (s) => statuses.push(s),
    onMessage: (m, g) => messages.push([m, g]),
  }, {
    onInput: (m) => inputs.push(m),
  }, { heartbeatMs: 0 });
  try {
    await client.sendInput(userMessage());
    assert.equal(inputs.length, 1);
    assert.equal(inputs[0].messageId, 'm-1');

    await agent.sendStatus('working', 'started');
    assert.equal(client.getTaskState(), 'working');
    assert.deepEqual(statuses, ['working']);

    await agent.sendMessage(agentMessage());
    assert.equal(messages.length, 1);
    assert.equal(messages[0][0].messageId, 'm-2');
    assert.equal(messages[0][1], 0);
  } finally {
    client.close();
    agent.close();
  }
});

test('client-written artifacts reach the agent end (v1.1); agent end cannot write them', async () => {
  const seen = [];
  const { client, agent } = createLoopbackLiveSession(task(), {}, {
    onClientArtifact: (a, g) => seen.push([a, g]),
  }, { heartbeatMs: 0 });
  try {
    const artifact = { artifactId: 'art-1', name: 'notes', parts: [{ kind: 'text', text: 'client note' }] };
    await client.sendClientArtifact(artifact);
    assert.equal(seen.length, 1);
    assert.equal(seen[0][0].artifactId, 'art-1');
    assert.equal(seen[0][1], 0);
    assert.equal(agent.receivedClientArtifacts().length, 1);

    await assert.rejects(agent.sendClientArtifact(artifact), /Only the client end/);
    await assert.rejects(
      client.sendClientArtifact({ artifactId: '', parts: [] }),
      /non-empty artifactId/,
    );
    await assert.rejects(
      client.sendClientArtifact({ artifactId: 'x', parts: 'nope' }),
      /parts must be an array/,
    );
  } finally {
    client.close();
    agent.close();
  }
});

test('backpressure flickers and clears in loopback; window queues past its size', async () => {
  const bp = [];
  const inputs = [];
  const { client, agent } = createLoopbackLiveSession(
    task(),
    { onBackpressure: (v, u) => bp.push([v, u]) },
    { onInput: (m) => inputs.push(m) },
    { heartbeatMs: 0, windowSize: 1, highWaterMark: 1, lowWaterMark: 0 },
  );
  try {
    await client.sendInput(userMessage('m-1'));
    // Sent past the high-water mark, then the ack drained it.
    assert.deepEqual(bp, [[true, 1], [false, 0]]);
    assert.equal(client.backpressureStats().backpressured, false);
    assert.equal(client.backpressureStats().backpressureEvents, 2);

    // Two rapid sends both arrive in order (window queueing itself
    // is the v3 send window's path; here the loopback acks drain it
    // synchronously between the two sends).
    const p1 = client.sendInput(userMessage('m-2'));
    const p2 = client.sendInput(userMessage('m-3'));
    await Promise.all([p1, p2]);
    assert.deepEqual(inputs.map((m) => m.messageId), ['m-1', 'm-2', 'm-3']);
  } finally {
    client.close();
    agent.close();
  }
});

test('resume re-sends unacked frames and the peer drops duplicates', async () => {
  // Holding transport: frames wait in an outbox until flush().
  const clientOutbox = [];
  const agentOutbox = [];
  const clientHandlers = new Set();
  const agentHandlers = new Set();
  const flush = () => {
    const c = clientOutbox.splice(0);
    const a = agentOutbox.splice(0);
    for (const f of c) for (const h of [...agentHandlers]) h(f);
    for (const f of a) for (const h of [...clientHandlers]) h(f);
  };
  const { A2aLiveV4Channel } = await import('../packages/core/dist/index.js');
  const t = task();
  const inputs = [];
  const client = new A2aLiveV4Channel(t, 'client', {
    send: (f) => { clientOutbox.push(f); },
    onFrame: (h) => { clientHandlers.add(h); return () => clientHandlers.delete(h); },
  }, {}, { heartbeatMs: 0 });
  const agent = new A2aLiveV4Channel(t, 'agent', {
    send: (f) => { agentOutbox.push(f); },
    onFrame: (h) => { agentHandlers.add(h); return () => agentHandlers.delete(h); },
  }, { onInput: (m) => inputs.push(m) }, { heartbeatMs: 0 });
  try {
    await client.sendInput(userMessage());
    assert.equal(inputs.length, 0, 'frame held, not delivered yet');
    const resent = await client.resume();
    assert.equal(resent, 1, 'one unacked frame re-sent');
    flush();
    assert.equal(inputs.length, 1, 'agent got the re-sent frame');
    // Deliver the same input frame again by hand: dedup drops it.
    clientOutbox.push({ direction: 'up', kind: 'input', taskId: 'task-1', sequence: 0, payload: { message: userMessage() }, at: new Date().toISOString() });
    flush();
    assert.equal(inputs.length, 1, 'duplicate sequence dropped');
  } finally {
    client.close();
    agent.close();
  }
});

test('reconnect bumps generation and returns a matching resume token', async () => {
  const messages = [];
  const { client, agent } = createLoopbackLiveSession(task(), {
    onMessage: (m, g) => messages.push([m, g]),
  }, {}, { heartbeatMs: 0 });
  try {
    assert.equal(client.getGeneration(), 0);
    const token = await client.reconnect();
    assert.equal(client.getGeneration(), 1);
    assert.deepEqual(parseA2aLiveResumeToken(token), { taskId: 'task-1', generation: 1, lastAckedSequence: -1 });

    await agent.sendMessage(agentMessage());
    assert.equal(messages[0][1], 0, 'agent generation is still 0 (only the reconnecting end bumps)');
  } finally {
    client.close();
    agent.close();
  }
});

test('coherent history orders by generation then sequence', async () => {
  const { client, agent } = createLoopbackLiveSession(task(), {}, {}, { heartbeatMs: 0 });
  try {
    await agent.sendStatus('working');
    await agent.sendMessage(agentMessage());
    const done = { ...task(), status: { state: 'completed' } };
    await agent.sendDone(done);
    const ordered = client.history().ordered();
    assert.deepEqual(ordered.map((e) => e.kind), ['status', 'message', 'done']);
    assert.equal(client.history().atGeneration(0).length, 3);
    assert.equal(client.history().atGeneration(1).length, 0);
  } finally {
    client.close();
    agent.close();
  }
});

test('history orders out-of-order appends by (generation, sequence)', () => {
  const h = new A2aLiveV4History();
  h.append({ generation: 1, sequence: 0, kind: 'status', summary: 'gen1', at: new Date().toISOString() });
  h.append({ generation: 0, sequence: 5, kind: 'message', summary: 'gen0-late', at: new Date().toISOString() });
  h.append({ generation: 0, sequence: 1, kind: 'status', summary: 'gen0-early', at: new Date().toISOString() });
  assert.deepEqual(h.ordered().map((e) => e.summary), ['gen0-early', 'gen0-late', 'gen1']);
});

test('sendDone requires a terminal state; wrong-role sends reject', async () => {
  const { client, agent } = createLoopbackLiveSession(task(), {}, {}, { heartbeatMs: 0 });
  try {
    await assert.rejects(agent.sendDone({ ...task(), status: { state: 'working' } }), /terminal/);
    await assert.rejects(client.sendStatus('working'), /Only the agent end/);
    await assert.rejects(agent.sendInput(userMessage()), /Only the client end/);
    client.close();
    await assert.rejects(client.sendInput(userMessage()), /closed/);
  } finally {
    agent.close();
  }
});

/**
 * Tests v1.07 (Đội T3): task state machine có guard + loopback
 * end-to-end thật (server + client + SSE + discovery qua cả hai
 * well-known path + JWS card).
 *
 * Run after building the core package:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/a2a-v107-state-machine-loopback.test.mjs
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';

import {
  A2aClient,
  A2aIllegalTransitionError,
  A2aTaskStateMachine,
  createA2aTaskWithStateMachine,
  createEchoA2aRunner,
  fetchAgentCard,
  fetchAgentCardJws,
  generateA2aSigningKey,
  startLoopbackA2aPair,
} from '../packages/core/dist/index.js';
import { isLegalA2aTransition } from '../packages/core/dist/a2a/history.js';

const pairsToClose = [];
after(async () => {
  for (const pair of pairsToClose.splice(0)) {
    try {
      await pair.close();
    } catch {}
  }
});

function makeTask(id = 'task-1') {
  return {
    id,
    contextId: 'ctx-1',
    status: { state: 'submitted', timestamp: new Date().toISOString() },
    history: [],
  };
}

// ---------------------------------------------------------------------------
// State machine
// ---------------------------------------------------------------------------

test('state machine: happy path submitted -> working -> completed, history recorded', () => {
  const { task, machine } = createA2aTaskWithStateMachine({ id: 'task-1', contextId: 'ctx-1' });
  assert.equal(machine.state, 'submitted');
  assert.equal(machine.summarizeHistory(), 'submitted');
  machine.start();
  assert.equal(machine.state, 'working');
  machine.complete([{ artifactId: 'a1', parts: [{ kind: 'text', text: 'done' }] }]);
  assert.equal(machine.state, 'completed');
  assert.equal(machine.isTerminal, true);
  assert.equal(task.artifacts.length, 1);
  assert.equal(machine.summarizeHistory(), 'submitted → working → completed');
  assert.ok(task.transitions.every((t) => t.legal));
  assert.equal(task.updatedAt, task.status.timestamp);
});

test('state machine: illegal transition throws in strict mode (default)', () => {
  const machine = new A2aTaskStateMachine(makeTask());
  machine.start();
  machine.complete();
  assert.throws(() => machine.complete(), A2aIllegalTransitionError);
  assert.throws(() => machine.start(), /illegal A2A state transition completed → working/);
  // Trạng thái không đổi sau lần chuyển sai.
  assert.equal(machine.state, 'completed');
  // Nhưng lịch sử vẫn ghi lại lần chuyển sai (legal: false).
  assert.equal(machine.current.transitions.at(-1).legal, false);
  // submitted -> completed trực tiếp là bất hợp pháp theo bảng.
  const fresh = new A2aTaskStateMachine(makeTask('task-2'));
  assert.throws(() => fresh.complete(), /submitted → completed/);
  assert.equal(isLegalA2aTransition('submitted', 'working'), true);
  assert.equal(isLegalA2aTransition('completed', 'working'), false);
});

test('state machine: lenient mode records + warns instead of throwing', () => {
  const warned = [];
  const machine = new A2aTaskStateMachine(makeTask(), {
    lenient: true,
    onIllegalTransition: (err) => warned.push(err.message),
  });
  machine.start();
  machine.complete();
  machine.start(); // completed -> working: bất hợp pháp nhưng lenient vẫn chuyển
  assert.equal(machine.state, 'working');
  assert.equal(warned.length, 1);
  assert.match(warned[0], /completed → working/);
});

test('state machine: requestInput/resume/fail/cancel/reject + applyRunnerResult', () => {
  const events = [];
  const machine = new A2aTaskStateMachine(makeTask());
  machine.onEvent((e) => events.push(e.kind));
  machine.start();
  machine.requestInput('Cần thêm đường dẫn file?');
  assert.equal(machine.state, 'input-required');
  assert.match(machine.current.status.message.parts[0].text, /Cần thêm đường dẫn/);
  machine.resume();
  assert.equal(machine.state, 'working');
  machine.applyRunnerResult({ needsInput: 'Vẫn thiếu thông tin.' });
  assert.equal(machine.state, 'input-required');
  machine.resume();
  machine.applyRunnerResult({ text: 'xong rồi' });
  assert.equal(machine.state, 'completed');
  assert.equal(machine.current.artifacts[0].parts[0].text, 'xong rồi');
  // fail / cancel / reject trên task mới.
  const failing = new A2aTaskStateMachine(makeTask('t-fail'));
  failing.start();
  failing.applyRunnerResult({ error: 'model lỗi' });
  assert.equal(failing.state, 'failed');
  const cancelling = new A2aTaskStateMachine(makeTask('t-cancel'));
  cancelling.cancel('user hủy');
  assert.equal(cancelling.state, 'cancelled');
  const rejecting = new A2aTaskStateMachine(makeTask('t-reject'));
  rejecting.reject('không nhận task này');
  assert.equal(rejecting.state, 'rejected');
  // applyRunnerResult: error thắng needsInput.
  const both = new A2aTaskStateMachine(makeTask('t-both'));
  both.start();
  both.applyRunnerResult({ error: 'lỗi nặng', needsInput: 'cần thêm?' });
  assert.equal(both.state, 'failed');
  // Event đã phát cho mỗi lần chuyển + artifact.
  assert.ok(events.includes('state-changed'));
  assert.ok(events.includes('artifact'));
});

test('state machine: addArtifact throws on a terminal task', () => {
  const machine = new A2aTaskStateMachine(makeTask());
  machine.start();
  machine.addArtifact({ artifactId: 'a1', parts: [{ kind: 'text', text: 'partial' }] });
  assert.equal(machine.current.artifacts.length, 1);
  machine.complete();
  assert.throws(
    () => machine.addArtifact({ artifactId: 'a2', parts: [{ kind: 'text', text: 'too late' }] }),
    /cannot add an artifact to a completed task/,
  );
});

// ---------------------------------------------------------------------------
// Loopback end-to-end (server + client thật, SSE thật)
// ---------------------------------------------------------------------------

test('loopback: discovery via both well-known paths returns the same card', async () => {
  const pair = await startLoopbackA2aPair({ name: 'loopback-agent' });
  pairsToClose.push(pair);
  assert.match(pair.baseUrl, /^http:\/\/127\.0\.0\.1:\d+\/$/);
  const viaStandard = await fetch(`${pair.baseUrl}.well-known/agent-card.json`);
  assert.equal(viaStandard.status, 200);
  const cardA = await viaStandard.json();
  const viaAlias = await fetch(`${pair.baseUrl}.well-known/agent.json`);
  assert.equal(viaAlias.status, 200);
  const cardB = await viaAlias.json();
  assert.deepEqual(cardB, cardA);
  assert.equal(cardA.name, 'loopback-agent');
  // Client fetchAgentCard dùng path chuẩn.
  const viaClient = await fetchAgentCard(pair.baseUrl);
  assert.equal(viaClient.name, 'loopback-agent');
  assert.equal(viaClient.capabilities.streaming, true);
  assert.equal(viaClient.capabilities.stateTransitionHistory, true);
});

test('loopback: send + stream via SSE, artifacts stream back, task completes', async () => {
  const pair = await startLoopbackA2aPair();
  pairsToClose.push(pair);
  const progress = [];
  const statuses = [];
  const artifacts = [];
  const task = await pair.client.streamMessage('hello loopback', {
    onProgress: (text) => progress.push(text),
    onStatus: (state) => statuses.push(state),
    onArtifact: (artifact) => artifacts.push(artifact),
  });
  assert.equal(task.status.state, 'completed');
  assert.ok(task.artifacts.length >= 1);
  assert.match(task.artifacts[0].parts[0].text, /echo: hello loopback/);
  assert.ok(progress.length >= 1, `phải có progress SSE, thực tế ${progress.length}`);
  assert.ok(progress.some((p) => p.includes('hello loopback')));
  assert.ok(statuses.includes('working'));
  assert.ok(statuses.includes('completed'));
  assert.ok(artifacts.length >= 1);
  // Task lưu trong server thật, đọc lại được qua client.
  const again = await pair.client.getTask(task.id);
  assert.equal(again.id, task.id);
  assert.equal(again.status.state, 'completed');
  assert.ok((again.transitions ?? []).length >= 2);
  // Lịch sử chuyển trạng thái đi qua server thật.
  const transitions = pair.server.getTaskTransitions(task.id);
  assert.ok(transitions.length >= 2);
  assert.ok(transitions.every((t) => t.legal));
  // sendMessage (không stream) cũng chạy.
  const task2 = await pair.client.sendMessage('second task');
  assert.equal(task2.status.state, 'completed');
  const listed = await pair.client.listTasks({});
  assert.ok(listed.total >= 2);
});

test('loopback: stream + cancel mid-run ends the task as cancelled', async () => {
  const slowRunner = async (input) => {
    for (let i = 0; i < 50; i++) {
      if (input.signal.aborted) return { error: 'Task đã bị hủy.' };
      input.onProgress(`chunk ${i}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return { text: 'finished slowly' };
  };
  const pair = await startLoopbackA2aPair({ runner: slowRunner });
  pairsToClose.push(pair);
  const client = new A2aClient({ baseUrl: pair.baseUrl, timeoutMs: 30000 });
  const streamPromise = client.streamMessage('slow stream', {
    onProgress: () => undefined,
  });
  // Đợi task bắt đầu rồi hủy qua client khác (cùng baseUrl).
  await new Promise((resolve) => setTimeout(resolve, 350));
  const tasks = await client.listTasks({});
  const running = tasks.tasks.find((t) => t.status.state === 'working');
  assert.ok(running, 'phải có task đang working để hủy');
  const cancelled = await client.cancelTask(running.id);
  assert.equal(cancelled.status.state, 'cancelled');
  const final = await streamPromise;
  assert.equal(final.status.state, 'cancelled');
});

test('loopback: signed card serves JWS at /.well-known/agent-card.jws, verified by client', async () => {
  const keyPair = generateA2aSigningKey();
  const pair = await startLoopbackA2aPair({ name: 'signed-agent', signer: keyPair });
  pairsToClose.push(pair);
  // Card JSON có chữ ký nhúng kiểu cũ.
  const card = await fetchAgentCard(pair.baseUrl);
  assert.ok(card.signature);
  assert.equal(card.signature.keyId, keyPair.keyId);
  // JWS endpoint phục vụ token, client verify bằng public key trong card.
  const { card: jwsCard, verification } = await fetchAgentCardJws(pair.baseUrl, card.signature.publicKey);
  assert.equal(verification.ok, true);
  assert.equal(verification.keyId, keyPair.keyId);
  assert.equal(jwsCard.name, 'signed-agent');
  // Endpoint JWS trả đúng media type.
  const raw = await fetch(`${pair.baseUrl}.well-known/agent-card.jws`);
  assert.equal(raw.status, 200);
  assert.match(raw.headers.get('content-type'), /application\/jwt/);
  const token = await raw.text();
  assert.equal(token.split('.').length, 3);
});

test('loopback: unsigned server has no JWS endpoint (404)', async () => {
  const pair = await startLoopbackA2aPair({ name: 'unsigned-agent' });
  pairsToClose.push(pair);
  const card = await fetchAgentCard(pair.baseUrl);
  assert.equal(card.signature, undefined);
  const res = await fetch(`${pair.baseUrl}.well-known/agent-card.jws`);
  assert.equal(res.status, 404);
  await assert.rejects(
    () => fetchAgentCardJws(pair.baseUrl, generateA2aSigningKey().publicKeyBase64),
    /HTTP 404/,
  );
});

test('loopback: echo runner helper returns prefixed text', async () => {
  const runner = createEchoA2aRunner('hi:');
  const result = await runner({
    taskId: 't',
    contextId: 'c',
    text: 'abc',
    message: { kind: 'message', messageId: 'm', role: 'user', parts: [{ kind: 'text', text: 'abc' }] },
    signal: new AbortController().signal,
    onProgress: () => undefined,
  });
  assert.equal(result.text, 'hi: abc');
});

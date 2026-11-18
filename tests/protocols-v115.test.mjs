/**
 * Tests for v1.15 — protocol triad (Team T2).
 *
 *   1. AG-UI 1.0 stream (aguiEvents.ts): 31 event types in 8
 *      groups with the exact per-group counts, terminal types,
 *      emitter ordering (runId/stepId/sequence), AsyncIterable
 *      stream with replay, finish/fail/cancel with per-provider
 *      token usage, drop-after-terminal, sanitisation (secret
 *      keys dropped, long text truncated), validation, and the
 *      bridge down to the legacy 16-type vocabulary.
 *   2. Interrupt-and-resume (interrupt.ts): approval/form/
 *      choice payload validation, raise/resume round-trip,
 *      answer validation (required + unknown fields), cancel,
 *      timeout, double-resolve already-resolved, cancelForRun,
 *      stream events published onto the emitter.
 *   3. A2UI surfaces (a2ui.ts): 10-kind catalog, hand-written
 *      JSON-Schema-style validation (valid + invalid specs,
 *      script URLs refused), negotiation fallbacks (chart ->
 *      table, non-interactive -> message), registry lifecycle
 *      (register/answer/dismiss/expire, no double answer).
 *   4. A2A signed cards (a2aCard.ts): HMAC-SHA256 build +
 *      verify, tamper/wrong-key rejection, stale signatures,
 *      version negotiation (highest common, none), binding
 *      descriptors for all three bindings, and a real JSON-RPC
 *      binding over HTTP loopback (server + client + well-known
 *      card + negotiate endpoint).
 *   5. MCP stateless 2026-07-28 (mcpStateless.ts): discover
 *      first, `_meta` on every request, no initialize/session
 *      id, input_required multi round-trip loop + round limit,
 *      Tasks extension (create/get/waitFor/update, unsupported
 *      server), legacy adapter (deprecated, warns once).
 *   6. Tools (protocolV115Tools.ts): 9 tools, unique names,
 *      registry registration, catalog/emit/negotiate through
 *      the tools, card signing refuses without a key, MCP
 *      discover refuses without a transport.
 *   7. Renderer panel (protocolPanelV115.ts): view building
 *      from defensive IPC payloads, usage formatting, urgent
 *      interrupts, summary counts.
 *   8. i18n: protocols.v115.* keys in all 6 locales, non-empty.
 *
 * No network (loopback only), no sound card. Run after building
 * core + tools:
 *   npm run build --workspace=@open-bot/core
 *   npm run build --workspace=@open-bot/tools
 *   node --test tests/protocols-v115.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  PROTOCOL_AGUI_EVENT_TYPES,
  PROTOCOL_AGUI_TERMINAL_EVENT_TYPES,
  ProtocolAgUiEmitter,
  isProtocolAgUiEventType,
  isValidProtocolAgUiEvent,
  makeProtocolTokenUsage,
  protocolAgUiEventGroup,
  protocolAgUiEventTypesOfGroup,
  protocolAgUiToLegacyType,
  validateProtocolAgUiEvent,
} from '../packages/core/dist/protocols/aguiEvents.js';
import {
  ProtocolInterruptCancelledError,
  ProtocolInterruptManager,
  ProtocolInterruptTimeoutError,
  validateProtocolInterruptAnswer,
  validateProtocolInterruptPayload,
} from '../packages/core/dist/protocols/interrupt.js';
import {
  A2UI_COMPONENT_KINDS,
  A2uiSurfaceRegistry,
  isValidA2uiSpec,
  negotiateA2uiSpec,
  validateA2uiSpec,
  validateA2uiAnswer,
} from '../packages/core/dist/protocols/a2ui.js';
import {
  A2aJsonRpcServer,
  buildSignedAgentCard,
  compareA2aVersions,
  describeA2aBinding,
  describeAllA2aBindings,
  fetchSignedAgentCard,
  negotiateA2aVersion,
  sendA2aJsonRpcMessage,
  verifySignedAgentCard,
} from '../packages/core/dist/protocols/a2aCard.js';
import {
  LegacyMcpClientAdapter,
  McpHttpTransport,
  McpStatelessClientV115,
  McpStatelessError,
  StatelessMcpTasks,
  parseMcpInputRequired,
} from '../packages/core/dist/protocols/mcpStateless.js';
import {
  PROTOCOL_V115_TOOLS,
  PROTOCOL_V115_TOOL_NAMES,
  createProtocolV115Tools,
  isProtocolV115ToolName,
} from '../packages/tools/dist/protocolV115Tools.js';
import { ToolRegistry } from '../packages/tools/dist/registry.js';
import {
  buildProtocolPanelView,
  formatProtocolUsage,
  protocolCardRowFromPayload,
  protocolInterruptRowFromPayload,
  protocolRunRowFromPayload,
} from '../apps/desktop/src/renderer/protocols/protocolPanelV115.ts';

const HMAC_KEY = 'test-hmac-key-0123456789abcdef';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOCALES_DIR = path.join(__dirname, '..', 'apps', 'desktop', 'src', 'renderer', 'i18n', 'locales');

function readLocale(locale) {
  return JSON.parse(fs.readFileSync(path.join(LOCALES_DIR, `${locale}.json`), 'utf8'));
}

// ---------------------------------------------------------------- AG-UI ---

test('v115 AG-UI: 31 event types in 8 groups with exact counts', () => {
  assert.equal(PROTOCOL_AGUI_EVENT_TYPES.length, 31);
  assert.equal(new Set(PROTOCOL_AGUI_EVENT_TYPES).size, 31);
  const counts = {
    lifecycle: 5,
    text: 4,
    toolCall: 5,
    state: 3,
    interrupt: 4,
    subagent: 3,
    generativeUi: 4,
    custom: 3,
  };
  for (const [group, expected] of Object.entries(counts)) {
    assert.equal(protocolAgUiEventTypesOfGroup(group).length, expected, group);
  }
  for (const type of PROTOCOL_AGUI_EVENT_TYPES) {
    assert.ok(isProtocolAgUiEventType(type), type);
    assert.equal(protocolAgUiEventGroup(type), protocolAgUiEventGroup(type));
  }
  assert.ok(!isProtocolAgUiEventType('RUN_START'));
  assert.ok(!isProtocolAgUiEventType(42));
  assert.deepEqual([...PROTOCOL_AGUI_TERMINAL_EVENT_TYPES], ['RUN_FINISHED', 'RUN_ERROR', 'RUN_CANCELLED']);
});

test('v115 AG-UI: emitter orders events, assigns sequence, replays via stream', async () => {
  const emitter = new ProtocolAgUiEmitter('run-1');
  emitter.start({ botId: 'bot-a', model: 'gpt-5', provider: 'openai' }, 'step-1');
  emitter.emit('TEXT_MESSAGE_START', { messageId: 'm1' }, 'step-1');
  emitter.emit('TEXT_MESSAGE_CONTENT', { messageId: 'm1', delta: 'hello' }, 'step-1');
  emitter.emit('TEXT_MESSAGE_END', { messageId: 'm1', text: 'hello' }, 'step-1');
  emitter.finish({ finalText: 'hello', usage: makeProtocolTokenUsage('openai', 'gpt-5', 10, 5) });
  assert.equal(emitter.count, 5);
  assert.deepEqual(emitter.events().map((e) => e.sequence), [0, 1, 2, 3, 4]);
  assert.ok(emitter.events().every((e) => e.runId === 'run-1'));
  assert.equal(emitter.events()[0].stepId, 'step-1');
  assert.equal(emitter.terminalType, 'RUN_FINISHED');
  assert.ok(emitter.isTerminal);

  const seen = [];
  for await (const event of emitter.stream()) seen.push(event.type);
  assert.deepEqual(seen, ['RUN_STARTED', 'TEXT_MESSAGE_START', 'TEXT_MESSAGE_CONTENT', 'TEXT_MESSAGE_END', 'RUN_FINISHED']);
  const finished = emitter.events()[4];
  assert.equal(finished.data.usage.provider, 'openai');
  assert.equal(finished.data.usage.model, 'gpt-5');
  assert.equal(finished.data.usage.totalTokens, 15);
});

test('v115 AG-UI: stream delivers live events in order until terminal', async () => {
  const emitter = new ProtocolAgUiEmitter('run-live');
  const collected = (async () => {
    const types = [];
    for await (const event of emitter.stream()) types.push(event.type);
    return types;
  })();
  emitter.emit('RUN_STARTED', {});
  emitter.emit('TEXT_MESSAGE_CONTENT', { messageId: 'm1', delta: 'x' });
  emitter.fail('provider exploded', makeProtocolTokenUsage('gemini', 'gemini-2.5-flash', 3, 0));
  assert.deepEqual(await collected, ['RUN_STARTED', 'TEXT_MESSAGE_CONTENT', 'RUN_ERROR']);
  assert.equal(emitter.events()[2].data.usage.provider, 'gemini');
});

test('v115 AG-UI: events after terminal are dropped and counted', () => {
  const emitter = new ProtocolAgUiEmitter('run-drop');
  emitter.start({});
  emitter.cancel();
  assert.equal(emitter.emit('TEXT_MESSAGE_CONTENT', { messageId: 'm1', delta: 'late' }), null);
  assert.equal(emitter.droppedCount, 1);
  assert.equal(emitter.count, 2);
});

test('v115 AG-UI: sanitisation drops secret keys and truncates long text', () => {
  const emitter = new ProtocolAgUiEmitter('run-clean');
  emitter.emit('STATE_SNAPSHOT', {
    state: { api_key: 'sk-secret', visible: 'ok', nested: { token: 't', keep: 1 } },
  });
  const state = emitter.events()[0].data.state;
  assert.equal(state.api_key, undefined);
  assert.equal(state.visible, 'ok');
  assert.equal(state.nested.token, undefined);
  assert.equal(state.nested.keep, 1);
  emitter.emit('TEXT_MESSAGE_CONTENT', { messageId: 'm1', delta: 'x'.repeat(9000) });
  assert.equal(emitter.events()[1].data.delta.length, 8000);
  emitter.emit('TOOL_CALL_ARGS', { toolCallId: 't1', argsJson: 'y'.repeat(5000) });
  assert.equal(emitter.events()[2].data.argsJson.length, 4000);
});

test('v115 AG-UI: validation accepts good events and rejects bad ones', () => {
  const good = {
    type: 'RUN_STARTED', runId: 'r', sequence: 0,
    timestamp: new Date().toISOString(), data: {},
  };
  assert.ok(isValidProtocolAgUiEvent(good));
  assert.deepEqual(validateProtocolAgUiEvent(good), []);
  assert.ok(validateProtocolAgUiEvent({ ...good, type: 'NOPE' }).length > 0);
  assert.ok(validateProtocolAgUiEvent({ ...good, sequence: -1 }).length > 0);
  assert.ok(validateProtocolAgUiEvent({ ...good, timestamp: 'not-a-date' }).length > 0);
  assert.ok(validateProtocolAgUiEvent({ ...good, runId: '' }).length > 0);
  assert.ok(validateProtocolAgUiEvent(null).length > 0);
});

test('v115 AG-UI: legacy bridge maps v1.15-only types down', () => {
  assert.equal(protocolAgUiToLegacyType('RUN_STARTED'), 'RUN_STARTED');
  assert.equal(protocolAgUiToLegacyType('RUN_CANCELLED'), 'RUN_FINISHED');
  assert.equal(protocolAgUiToLegacyType('THINKING_CONTENT'), 'TEXT_MESSAGE_CONTENT');
  assert.equal(protocolAgUiToLegacyType('INTERRUPT_STARTED'), 'CUSTOM');
  assert.equal(protocolAgUiToLegacyType('SUBAGENT_FINISHED'), 'CUSTOM');
  assert.equal(protocolAgUiToLegacyType('GENERATIVE_UI_START'), 'CUSTOM');
  assert.equal(protocolAgUiToLegacyType('MESSAGES_SNAPSHOT'), 'STATE_SNAPSHOT');
});

// ------------------------------------------------------------- interrupt ---

test('v115 interrupt: approval raise/resume round-trip publishes stream events', async () => {
  const emitter = new ProtocolAgUiEmitter('run-int');
  const manager = new ProtocolInterruptManager();
  manager.attachEmitters((runId) => (runId === 'run-int' ? emitter : undefined));
  const pending = manager.raise('run-int', {
    kind: 'approval',
    title: 'Delete the file?',
    approvalText: 'Delete /tmp/x.txt',
  });
  assert.equal(manager.pendingForRun('run-int').length, 1);
  const interrupt = manager.pendingForRun('run-int')[0];
  assert.equal(interrupt.status, 'pending');
  const resolution = manager.resume(interrupt.id, { approved: true, note: 'go ahead' });
  assert.equal(resolution.applied, true);
  assert.equal(resolution.outcome, 'resolved');
  assert.deepEqual(await pending, { approved: true, note: 'go ahead' });
  assert.equal(manager.pendingForRun('run-int').length, 0);
  assert.deepEqual(
    emitter.events().map((e) => e.type),
    ['INTERRUPT_STARTED', 'RUN_PAUSED', 'INTERRUPT_RESOLVED'],
  );
  // Second resolution loses the race.
  const again = manager.resume(interrupt.id, { approved: true });
  assert.equal(again.applied, false);
  assert.equal(again.outcome, 'already-resolved');
});

test('v115 interrupt: payload and answer validation fail closed', () => {
  assert.deepEqual(validateProtocolInterruptPayload({ kind: 'approval', title: 'ok' }), []);
  assert.ok(validateProtocolInterruptPayload({ kind: 'approval', title: '' }).length > 0);
  assert.ok(validateProtocolInterruptPayload({ kind: 'form', title: 't', fields: [] }).length > 0);
  assert.ok(validateProtocolInterruptPayload({
    kind: 'form', title: 't',
    fields: [{ name: 'bad-name!', label: 'x', kind: 'text' }],
  }).length > 0);
  assert.ok(validateProtocolInterruptPayload({
    kind: 'choice', title: 't', choices: [{ id: 'a', label: 'A' }, { id: 'a', label: 'dup' }],
  }).length > 0);
  assert.ok(validateProtocolInterruptPayload({ kind: 'approval', title: 't', timeoutMs: 10 }).length > 0);

  const manager = new ProtocolInterruptManager();
  const interrupt = {
    id: 'i1', runId: 'r', status: 'pending', createdAt: new Date().toISOString(),
    payload: {
      kind: 'form', title: 't',
      fields: [
        { name: 'email', label: 'Email', kind: 'text', required: true },
        { name: 'count', label: 'Count', kind: 'number' },
      ],
    },
  };
  assert.deepEqual(validateProtocolInterruptAnswer(interrupt, { email: 'a@b.c', count: 2 }), []);
  assert.ok(validateProtocolInterruptAnswer(interrupt, { count: 2 }).length > 0); // required missing
  assert.ok(validateProtocolInterruptAnswer(interrupt, { email: 'a@b.c', extra: 1 }).length > 0);
  assert.ok(validateProtocolInterruptAnswer(interrupt, { email: 'a@b.c', count: 'two' }).length > 0);
  assert.throws(() => manager.raise('r', { kind: 'nope', title: 't' }), /Invalid interrupt payload/);
});

test('v115 interrupt: cancel rejects the waiting run; timeout auto-cancels', async () => {
  const manager = new ProtocolInterruptManager();
  const waiting = manager.raise('run-c', { kind: 'choice', title: 'Pick one', choices: [{ id: 'a', label: 'A' }] });
  const interrupt = manager.pendingForRun('run-c')[0];
  const outcome = manager.cancel(interrupt.id, 'user said no');
  assert.equal(outcome.outcome, 'cancelled');
  await assert.rejects(waiting, (err) => err instanceof ProtocolInterruptCancelledError);

  const manager2 = new ProtocolInterruptManager();
  const timed = manager2.raise('run-t', {
    kind: 'approval', title: 'Hurry', timeoutMs: 1000,
  });
  await assert.rejects(timed, (err) => err instanceof ProtocolInterruptTimeoutError && err.timeoutMs === 1000);
  assert.equal(manager2.pendingForRun('run-t').length, 0);
  assert.equal(manager2.get(manager2.allInterrupts()[0].id).status, 'timed-out');
});

test('v115 interrupt: cancelForRun cancels every pending interrupt of a run', async () => {
  const manager = new ProtocolInterruptManager();
  const p1 = manager.raise('run-x', { kind: 'approval', title: 'one' });
  const p2 = manager.raise('run-x', { kind: 'approval', title: 'two' });
  const p3 = manager.raise('run-y', { kind: 'approval', title: 'other run' });
  p1.catch(() => {});
  p2.catch(() => {});
  assert.equal(manager.cancelForRun('run-x', 'Run aborted.'), 2);
  assert.equal(manager.pendingForRun('run-x').length, 0);
  assert.equal(manager.pendingForRun('run-y').length, 1);
  await assert.rejects(p1, ProtocolInterruptCancelledError);
  await assert.rejects(p2, ProtocolInterruptCancelledError);
  manager.cancelForRun('run-y');
  await assert.rejects(p3, ProtocolInterruptCancelledError);
});

// ------------------------------------------------------------------ A2UI ---

test('v115 A2UI: catalog has 10 kinds and valid specs pass', () => {
  assert.equal(A2UI_COMPONENT_KINDS.length, 10);
  assert.deepEqual([...A2UI_COMPONENT_KINDS], [
    'card', 'form', 'table', 'chart', 'approval', 'options', 'message', 'progress', 'list', 'detail',
  ]);
  const base = { componentId: 'c1', runId: 'r1', title: 'T' };
  assert.ok(isValidA2uiSpec({ ...base, kind: 'card', data: { rows: [{ key: 'a', value: 'b' }] } }));
  assert.ok(isValidA2uiSpec({ ...base, kind: 'form', data: { fields: [{ name: 'n', label: 'N', kind: 'text' }] } }));
  assert.ok(isValidA2uiSpec({ ...base, kind: 'table', data: { columns: [{ key: 'a', label: 'A' }], rows: [{ a: 'x' }] } }));
  assert.ok(isValidA2uiSpec({ ...base, kind: 'chart', data: { chartType: 'bar', points: [{ label: 'a', value: 1 }] } }));
  assert.ok(isValidA2uiSpec({ ...base, kind: 'approval', data: { question: 'Sure?', actions: [{ id: 'yes', label: 'Yes' }] } }));
  assert.ok(isValidA2uiSpec({ ...base, kind: 'options', data: { options: [{ id: 'a', label: 'A' }] } }));
  assert.ok(isValidA2uiSpec({ ...base, kind: 'message', data: { text: 'hi' } }));
  assert.ok(isValidA2uiSpec({ ...base, kind: 'progress', data: { value: 3, max: 10 } }));
  assert.ok(isValidA2uiSpec({ ...base, kind: 'list', data: { items: [{ id: 'i', title: 'Item' }] } }));
  assert.ok(isValidA2uiSpec({ ...base, kind: 'detail', data: { title: 'D', rows: [{ key: 'a', value: 'b' }] } }));
});

test('v115 A2UI: invalid specs are refused with problems', () => {
  const base = { componentId: 'c1', runId: 'r1', title: 'T' };
  assert.ok(validateA2uiSpec({ ...base, kind: 'nope', data: {} }).length > 0);
  assert.ok(validateA2uiSpec({ ...base, componentId: 'bad id!', kind: 'message', data: { text: 'x' } }).length > 0);
  assert.ok(validateA2uiSpec({ ...base, kind: 'table', data: { columns: [{ key: 'a', label: 'A' }], rows: [{ a: 'javascript:alert(1)' }] } }).length > 0);
  assert.ok(validateA2uiSpec({ ...base, kind: 'table', data: { columns: [{ key: 'a', label: 'A' }], rows: [{ b: 'unknown column' }] } }).length > 0);
  assert.ok(validateA2uiSpec({ ...base, kind: 'card', data: { rows: [], actions: [{ id: 'x', label: 'X', href: 'http://plain' }] } }).length > 0);
  assert.ok(validateA2uiSpec({ ...base, kind: 'progress', data: { value: 11, max: 10 } }).length > 0);
  assert.ok(validateA2uiSpec({ ...base, kind: 'chart', data: { chartType: 'pie', points: [] } }).length > 0);
  assert.ok(validateA2uiSpec({ ...base, kind: 'form', data: { fields: [{ name: 'a', label: 'A', kind: 'text' }, { name: 'a', label: 'dup', kind: 'text' }] } }).length > 0);
  assert.ok(validateA2uiSpec(null).length > 0);
  assert.ok(validateA2uiSpec({ ...base, kind: 'options', data: { options: [] } }).length > 0);
});

test('v115 A2UI: negotiation falls back chart -> table, non-interactive -> message', () => {
  const chart = { componentId: 'ch1', kind: 'chart', runId: 'r', title: 'Chart', data: { chartType: 'bar', points: [{ label: 'a', value: 2 }] } };
  const noChart = negotiateA2uiSpec(chart, { kinds: ['table', 'message'], charts: false, interactive: true });
  assert.equal(noChart.spec.kind, 'table');
  assert.equal(noChart.fallbackApplied, true);
  assert.equal(noChart.fallbackFrom, 'chart');
  assert.deepEqual(noChart.spec.data.rows, [{ label: 'a', value: 2 }]);
  const full = negotiateA2uiSpec(chart, { kinds: ['chart', 'table'], charts: true, interactive: true });
  assert.equal(full.fallbackApplied, false);
  assert.equal(full.spec.kind, 'chart');
  const form = { componentId: 'f1', kind: 'form', runId: 'r', title: 'Form', data: { fields: [{ name: 'n', label: 'N', kind: 'text' }] } };
  const plain = negotiateA2uiSpec(form, { kinds: ['message'], interactive: false });
  assert.equal(plain.spec.kind, 'message');
  assert.equal(plain.fallbackApplied, true);
  const table = { componentId: 't1', kind: 'table', runId: 'r', title: 'T', data: { columns: [{ key: 'a', label: 'A' }], rows: [{ a: 1 }, { a: 2 }, { a: 3 }] } };
  const trimmed = negotiateA2uiSpec(table, { kinds: ['table'], maxTableRows: 2, interactive: true });
  assert.equal(trimmed.spec.data.rows.length, 2);
  assert.equal(trimmed.fallbackApplied, true);
});

test('v115 A2UI: registry lifecycle — register, answer, no double answer, dismiss, expire', () => {
  const registry = new A2uiSurfaceRegistry();
  const emitter = new ProtocolAgUiEmitter('run-ui');
  registry.attachEmitters((runId) => (runId === 'run-ui' ? emitter : undefined));
  const spec = { componentId: 's1', kind: 'options', runId: 'run-ui', title: 'Pick', data: { options: [{ id: 'a', label: 'A' }] } };
  const surface = registry.register(spec);
  assert.equal(surface.status, 'pending');
  assert.equal(registry.pending('run-ui').length, 1);
  assert.equal(emitter.events()[0].type, 'GENERATIVE_UI_START');
  assert.throws(() => registry.register(spec), /already exists/);
  assert.throws(() => registry.register({ ...spec, componentId: 's2', kind: 'nope', data: {} }), /Invalid A2UI spec/);
  const answered = registry.answer('s1', { selectedId: 'a' });
  assert.equal(answered.applied, true);
  assert.equal(answered.outcome, 'answered');
  assert.equal(emitter.events()[1].type, 'GENERATIVE_UI_RESPONSE');
  const again = registry.answer('s1', { selectedId: 'a' });
  assert.equal(again.applied, false);
  assert.equal(again.outcome, 'already-resolved');
  assert.deepEqual(registry.answer('missing', {}), { applied: false, outcome: 'not-found' });

  const form = { componentId: 's2', kind: 'form', runId: 'run-ui', title: 'F', data: { fields: [{ name: 'n', label: 'N', kind: 'text', required: true }] } };
  registry.register(form);
  assert.throws(() => registry.answer('s2', {}), /required field n is missing/);
  assert.equal(registry.dismiss('s2').outcome, 'dismissed');
  assert.equal(registry.expire('s2').outcome, 'already-resolved');

  const msg = { componentId: 's3', kind: 'message', runId: 'run-ui', title: 'M', data: { text: 'hi' } };
  registry.register(msg);
  assert.equal(registry.expire('s3').outcome, 'expired');
  assert.ok(validateA2uiAnswer(msg, { unexpected: 1 }).length > 0);
  assert.deepEqual(validateA2uiAnswer(msg, {}), []);
});

// ------------------------------------------------------------------- A2A ---

test('v115 A2A: HMAC-signed card verifies; tamper and wrong key fail', () => {
  const signed = buildSignedAgentCard({
    name: 'open-bot', description: 'Local agent', url: 'http://127.0.0.1:4000',
    hmacKey: HMAC_KEY,
  });
  assert.equal(signed.signature.algorithm, 'HMAC-SHA256');
  assert.equal(signed.signature.trust, 'internal-hmac');
  assert.equal(signed.card.protocolVersion, '1.0.1');
  const check = verifySignedAgentCard(signed, HMAC_KEY);
  assert.equal(check.valid, true);
  assert.equal(typeof check.ageMs, 'number');
  assert.ok((check.ageMs ?? -1) >= 0);
  assert.equal(verifySignedAgentCard(signed, 'wrong-key-0123456789').valid, false);
  assert.equal(verifySignedAgentCard(signed, 'wrong-key-0123456789').reason, 'bad-signature');
  const tampered = JSON.parse(JSON.stringify(signed));
  tampered.card.name = 'evil-bot';
  assert.equal(verifySignedAgentCard(tampered, HMAC_KEY).reason, 'bad-signature');
  assert.equal(verifySignedAgentCard({ card: signed.card }, HMAC_KEY).reason, 'bad-envelope');
  assert.equal(verifySignedAgentCard(null, HMAC_KEY).reason, 'bad-envelope');
  assert.throws(() => buildSignedAgentCard({ name: 'x', description: 'y', url: 'http://127.0.0.1:1', hmacKey: 'short' }), /at least 16/);
  assert.throws(() => buildSignedAgentCard({ name: '', description: 'y', url: 'http://127.0.0.1:1', hmacKey: HMAC_KEY }), /name/);
});

test('v115 A2A: stale signatures rejected with maxAgeMs', () => {
  const signed = buildSignedAgentCard({
    name: 'open-bot', description: 'Local agent', url: 'http://127.0.0.1:4000', hmacKey: HMAC_KEY,
  });
  // Verify with a clock far in the future: the signature is stale.
  const future = Date.parse(signed.signature.signedAt) + 3_600_000;
  const check = verifySignedAgentCard(signed, HMAC_KEY, { maxAgeMs: 60_000, now: () => future });
  assert.equal(check.valid, false);
  assert.equal(check.reason, 'stale-signature');
  assert.ok((check.ageMs ?? 0) > 3_000_000);
});

test('v115 A2A: version negotiation picks the highest common version', () => {
  assert.equal(negotiateA2aVersion(['1.0', '1.0.1'], ['1.0.1']).agreed, '1.0.1');
  assert.equal(negotiateA2aVersion(['1.0'], ['1.0.1']).agreed, null);
  assert.equal(negotiateA2aVersion(['1.0', '1.1'], ['1.0', '1.1', '2.0']).agreed, '1.1');
  assert.deepEqual(negotiateA2aVersion([], ['1.0']), { agreed: null, clientVersions: [], serverVersions: ['1.0'], clientOnly: [], serverOnly: ['1.0'] });
  assert.equal(compareA2aVersions('1.0.1', '1.0'), 1);
  assert.equal(compareA2aVersions('1.0', '1.0.1'), -1);
  assert.equal(compareA2aVersions('1.0.1', '1.0.1'), 0);
});

test('v115 A2A: all three bindings described; JSON-RPC is the one that runs', () => {
  const bindings = describeAllA2aBindings('http://127.0.0.1:4000');
  assert.equal(bindings.length, 3);
  assert.deepEqual(bindings.map((b) => b.protocolBinding), ['JSONRPC', 'GRPC', 'HTTP_JSON']);
  assert.ok(bindings[0].implemented.includes('Runs for real'));
  assert.ok(bindings[1].implemented.includes('Interface only'));
  assert.ok(bindings[2].implemented.includes('Interface only'));
  assert.equal(describeA2aBinding('GRPC', 'http://127.0.0.1:4000').protocolVersion, '1.0.1');
});

test('v115 A2A: JSON-RPC binding works over HTTP loopback', async () => {
  const signed = buildSignedAgentCard({
    name: 'open-bot', description: 'Local agent', url: 'http://127.0.0.1:4000',
    hmacKey: HMAC_KEY,
    bindings: describeAllA2aBindings('http://127.0.0.1:4000'),
  });
  const server = new A2aJsonRpcServer(
    async (message) => ({
      taskId: 'task-1',
      state: 'completed',
      reply: `echo: ${message.parts.map((p) => p.text).join(' ')}`,
    }),
    { signedCard: signed },
  );
  const baseUrl = await server.start();
  try {
    assert.ok(baseUrl.startsWith('http://127.0.0.1:'));
    const fetched = await fetchSignedAgentCard(baseUrl);
    assert.equal(fetched.card.name, 'open-bot');
    assert.equal(verifySignedAgentCard(fetched, HMAC_KEY).valid, true);
    const result = await sendA2aJsonRpcMessage(baseUrl, {
      role: 'user',
      parts: [{ kind: 'text', text: 'hello' }],
    });
    assert.equal(result.taskId, 'task-1');
    assert.equal(result.state, 'completed');
    assert.equal(result.reply, 'echo: hello');
    const streamResult = await sendA2aJsonRpcMessage(baseUrl, {
      role: 'user',
      parts: [{ kind: 'text', text: 'hi' }],
    }, { stream: true });
    assert.ok((streamResult.streamingNote ?? '').includes('non-streaming'));
    // Negotiate endpoint.
    const res = await fetch(`${baseUrl}/a2a/negotiate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ clientVersions: ['1.0', '1.0.1'] }),
    });
    const negotiation = await res.json();
    assert.equal(negotiation.agreed, '1.0.1');
    // Unknown method -> JSON-RPC -32601.
    const bad = await fetch(`${baseUrl}/a2a/message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'tasks/cancel', params: {}, id: 9 }),
    });
    const badPayload = await bad.json();
    assert.equal(badPayload.error.code, -32601);
  } finally {
    await server.stop();
  }
});

// ------------------------------------------------------------------- MCP ---

/** Fake JSON-RPC transport recording every request (no network). */
function makeFakeMcpTransport(handlers) {
  const requests = [];
  return {
    requests,
    async request(req) {
      requests.push(req);
      const handler = handlers[req.method];
      if (!handler) return { jsonrpc: '2.0', id: req.id, error: { code: -32601, message: `Method not found: ${req.method}` } };
      return { jsonrpc: '2.0', id: req.id, result: handler(req) };
    },
  };
}

test('v115 MCP: discover first, _meta on every request, no initialize', async () => {
  const transport = makeFakeMcpTransport({
    'server/discover': () => ({
      protocolVersion: '2026-07-28',
      serverInfo: { name: 'fake', version: '1' },
      capabilities: { tools: {}, tasks: {} },
    }),
    'tools/list': () => ({ tools: [{ name: 'search', description: 'Search' }] }),
  });
  const client = new McpStatelessClientV115(transport);
  assert.equal(client.isDiscovered, false);
  await assert.rejects(client.listTools(), /discover\(\) before/);
  const discovered = await client.discover();
  assert.equal(discovered.protocolVersion, '2026-07-28');
  assert.equal(client.isDiscovered, true);
  const tools = await client.listTools();
  assert.deepEqual(tools, [{ name: 'search', description: 'Search' }]);
  // Every request carried _meta with the version; none called initialize.
  assert.ok(transport.requests.length >= 2);
  for (const req of transport.requests) {
    assert.equal(req.params._meta.protocolVersion, '2026-07-28');
    assert.ok(req.params._meta.clientCapabilities);
  }
  assert.ok(!transport.requests.some((r) => r.method === 'initialize'));
  assert.ok(!transport.requests.some((r) => JSON.stringify(r).includes('Mcp-Session-Id')));
  assert.equal(client.meta().protocolVersion, '2026-07-28');
});

test('v115 MCP: input_required multi round-trip loop retries with the answer', async () => {
  let calls = 0;
  const transport = makeFakeMcpTransport({
    'server/discover': () => ({
      protocolVersion: '2026-07-28',
      serverInfo: { name: 'fake', version: '1' },
      capabilities: { tools: {} },
    }),
    'tools/call': (req) => {
      calls += 1;
      if (calls === 1) {
        return { input_required: { requestId: 'r1', prompt: 'Which city?', fields: ['city'], toolName: 'search' } };
      }
      return { content: `weather for ${req.params.arguments._inputAnswer.values.city}` };
    },
  });
  const client = new McpStatelessClientV115(transport);
  await client.discover();
  const asked = [];
  const out = await client.callToolWithInput('search', { q: 'weather' }, async (req) => {
    asked.push(req);
    return { city: 'Saigon' };
  });
  assert.equal(out.inputRounds, 1);
  assert.equal(out.inputRequests.length, 1);
  assert.equal(out.inputRequests[0].prompt, 'Which city?');
  assert.equal(out.result.content, 'weather for Saigon');
  assert.equal(asked.length, 1);
  assert.deepEqual(parseMcpInputRequired({ input_required: { requestId: 'r', prompt: 'p', fields: ['a'] } }).fields, ['a']);
  assert.equal(parseMcpInputRequired({ content: 'plain' }), null);
  assert.equal(parseMcpInputRequired(null), null);
});

test('v115 MCP: input loop fails loudly after the round limit', async () => {
  const transport = makeFakeMcpTransport({
    'server/discover': () => ({
      protocolVersion: '2026-07-28',
      serverInfo: { name: 'fake', version: '1' },
      capabilities: { tools: {} },
    }),
    'tools/call': () => ({ input_required: { requestId: 'r1', prompt: 'Again?', fields: ['x'] } }),
  });
  const client = new McpStatelessClientV115(transport, { maxInputRounds: 2 });
  await client.discover();
  await assert.rejects(
    client.callToolWithInput('ask', {}, async () => ({ x: 1 })),
    (err) => err instanceof McpStatelessError && /after 2 round/.test(err.message),
  );
});

test('v115 MCP: Tasks extension create/get/waitFor/update + unsupported server', async () => {
  let polls = 0;
  const transport = makeFakeMcpTransport({
    'server/discover': () => ({
      protocolVersion: '2026-07-28',
      serverInfo: { name: 'fake', version: '1' },
      capabilities: { tools: {}, tasks: {} },
    }),
    'tasks/create': () => ({ taskId: 't1', state: 'running', progress: 0.5, statusText: 'halfway' }),
    'tasks/get': () => {
      polls += 1;
      return polls < 2
        ? { taskId: 't1', state: 'running', progress: 0.5 }
        : { taskId: 't1', state: 'completed', progress: 1, result: { answer: 42 } };
    },
    'tasks/update': () => ({ taskId: 't1', state: 'cancelled' }),
  });
  const client = new McpStatelessClientV115(transport);
  await client.discover();
  const tasks = new StatelessMcpTasks(client, { sleep: async () => {} });
  const created = await tasks.create('long-job', { n: 1 });
  assert.equal(created.supported, true);
  assert.equal(created.task.taskId, 't1');
  assert.equal(created.task.state, 'running');
  assert.equal(created.task.progress, 0.5);
  const done = await tasks.waitFor('t1');
  assert.equal(done.state, 'completed');
  assert.equal(done.result.answer, 42);
  assert.equal(tasks.list().length, 1);
  const cancelled = await tasks.update('t1', { state: 'cancelled' });
  assert.equal(cancelled.state, 'cancelled');

  const oldTransport = makeFakeMcpTransport({
    'server/discover': () => ({
      protocolVersion: '2026-07-28',
      serverInfo: { name: 'old', version: '1' },
      capabilities: { tools: {} },
    }),
  });
  const oldClient = new McpStatelessClientV115(oldTransport);
  await oldClient.discover();
  const oldTasks = new StatelessMcpTasks(oldClient, { sleep: async () => {} });
  const unsupported = await oldTasks.create('long-job', {});
  assert.equal(unsupported.supported, false);
  assert.ok((unsupported.message ?? '').includes('does not offer tasks/create'));
});

test('v115 MCP: legacy adapter wraps the handshake and warns once (deprecated)', async () => {
  const warnings = [];
  let initializes = 0;
  const legacy = {
    sessionId: 'sess-1',
    async initialize() {
      initializes += 1;
      return { protocolVersion: '2025-11-25' };
    },
    async call(method, params) {
      assert.equal(method, 'tools/call');
      assert.ok(params._meta);
      return { content: 'legacy ok' };
    },
  };
  const adapter = new LegacyMcpClientAdapter(legacy, {
    onDeprecatedUse: (detail) => warnings.push(detail),
  });
  const discovered = await adapter.discover();
  assert.equal(discovered.protocolVersion, '2025-11-25');
  assert.equal(initializes, 1);
  const out = await adapter.callTool('search', { q: 'x' });
  assert.equal(out.content, 'legacy ok');
  await adapter.callTool('search', { q: 'y' });
  assert.equal(warnings.length, 1);
  assert.ok(warnings[0].includes('Deprecated'));
  assert.ok(warnings[0].includes('28/07/2027'));
});

test('v115 MCP: HTTP transport refuses non-http endpoints', () => {
  assert.throws(() => new McpHttpTransport('ws://127.0.0.1:1'), /http\(s\)/);
  assert.ok(new McpHttpTransport('http://127.0.0.1:4000') instanceof McpHttpTransport);
});

// ------------------------------------------------------------------ tools ---

test('v115 tools: 9 tools, unique names, registry registration', async () => {
  assert.equal(PROTOCOL_V115_TOOL_NAMES.length, 9);
  assert.equal(new Set(PROTOCOL_V115_TOOL_NAMES).size, 9);
  assert.equal(PROTOCOL_V115_TOOLS.length, 9);
  for (const tool of PROTOCOL_V115_TOOLS) {
    assert.ok(isProtocolV115ToolName(tool.definition.name));
    assert.equal(tool.definition.parameters.type, 'object');
    assert.ok(tool.definition.description.length > 20);
  }
  const registry = new ToolRegistry();
  registry.registerProtocolV115Tools();
  assert.equal(registry.list().length, 9);
  assert.ok(registry.has('protocol_agui_catalog'));
  assert.ok(registry.has('protocol_mcp_discover'));
  assert.throws(() => registry.registerProtocolV115Tools(), /already registered|duplicate/i);
});

test('v115 tools: catalog, emit and negotiate work through the tools', async () => {
  const tools = createProtocolV115Tools();
  const byName = new Map(tools.map((t) => [t.definition.name, t]));
  const catalogOut = JSON.parse(await byName.get('protocol_agui_catalog').execute({}));
  assert.equal(catalogOut.count, 31);
  assert.equal(catalogOut.version, 'agui/1.0');
  const groupOut = JSON.parse(await byName.get('protocol_agui_catalog').execute({ group: 'interrupt' }));
  assert.equal(groupOut.count, 4);
  const emitOut = JSON.parse(await byName.get('protocol_agui_emit').execute({
    runId: 'tool-run', type: 'TEXT_MESSAGE_CONTENT', data: { messageId: 'm1', delta: 'hi' },
  }));
  assert.equal(emitOut.event.type, 'TEXT_MESSAGE_CONTENT');
  assert.equal(emitOut.event.sequence, 0);
  const badEmit = await byName.get('protocol_agui_emit').execute({
    runId: 'tool-run', type: 'NOPE', data: {},
  });
  assert.ok(badEmit.startsWith('Error:'));
  const negotiateOut = JSON.parse(await byName.get('protocol_a2a_negotiate').execute({
    clientVersions: ['1.0', '1.0.1'], serverVersions: ['1.0'],
  }));
  assert.equal(negotiateOut.negotiation.agreed, '1.0');
});

test('v115 tools: card signing refuses without a key, works with one; MCP discover needs a transport', async () => {
  const noKey = createProtocolV115Tools();
  const byNameNoKey = new Map(noKey.map((t) => [t.definition.name, t]));
  const refused = await byNameNoKey.get('protocol_a2a_card').execute({
    name: 'a', description: 'd', url: 'http://127.0.0.1:4000',
  });
  assert.ok(refused.startsWith('Error:'));
  assert.ok(refused.includes('HMAC key'));
  const mcpRefused = await byNameNoKey.get('protocol_mcp_discover').execute({});
  assert.ok(mcpRefused.startsWith('Error:'));

  const transport = makeFakeMcpTransport({
    'server/discover': () => ({
      protocolVersion: '2026-07-28',
      serverInfo: { name: 'fake', version: '1' },
      capabilities: { tools: {} },
    }),
    'tools/list': () => ({ tools: [{ name: 'search' }] }),
  });
  const bound = createProtocolV115Tools({
    getHmacKey: () => HMAC_KEY,
    getMcpTransport: () => transport,
  });
  const byName = new Map(bound.map((t) => [t.definition.name, t]));
  const cardOut = JSON.parse(await byName.get('protocol_a2a_card').execute({
    name: 'open-bot', description: 'Local agent', url: 'http://127.0.0.1:4000',
    bindings: ['JSONRPC', 'GRPC'],
  }));
  assert.equal(cardOut.signedCard.card.name, 'open-bot');
  assert.equal(cardOut.selfCheck.valid, true);
  // buildAgentCard already advertises JSONRPC; the tool adds GRPC -> 2.
  assert.equal(cardOut.signedCard.card.supportedInterfaces.length, 2);
  assert.deepEqual(
    cardOut.signedCard.card.supportedInterfaces.map((i) => i.protocolBinding).sort(),
    ['GRPC', 'JSONRPC'],
  );
  const mcpOut = JSON.parse(await byName.get('protocol_mcp_discover').execute({}));
  assert.equal(mcpOut.discovered.protocolVersion, '2026-07-28');
  assert.deepEqual(mcpOut.tools, [{ name: 'search' }]);

  // A2UI render + answer through the tools, with negotiation.
  const renderOut = JSON.parse(await byName.get('protocol_a2ui_render').execute({
    spec: {
      componentId: 'tool-chart', kind: 'chart', runId: 'r1', title: 'C',
      data: { chartType: 'bar', points: [{ label: 'a', value: 1 }] },
    },
    capabilities: { kinds: ['table', 'message'], charts: false, interactive: true },
  }));
  assert.equal(renderOut.surface.spec.kind, 'table');
  assert.equal(renderOut.negotiated.fallbackApplied, true);
  const answerOut = JSON.parse(await byName.get('protocol_a2ui_answer').execute({
    componentId: 'tool-chart', answer: {},
  }));
  assert.equal(answerOut.outcome.outcome, 'answered');

  // Interrupt resolve through the tool (needs a live interrupt first).
  const manager = new ProtocolInterruptManager();
  const withManager = createProtocolV115Tools({ getInterruptManager: () => manager });
  const byName2 = new Map(withManager.map((t) => [t.definition.name, t]));
  const raisePromise = manager.raise('run-tool', { kind: 'approval', title: 'Ok?' });
  const interrupt = manager.pendingForRun('run-tool')[0];
  const resolveOut = JSON.parse(await byName2.get('protocol_interrupt_resolve').execute({
    interruptId: interrupt.id, outcome: 'resume', answer: { approved: true },
  }));
  assert.equal(resolveOut.resolution.outcome, 'resolved');
  assert.deepEqual(await raisePromise, { approved: true });
});

// --------------------------------------------------------- renderer panel ---

test('v115 panel: builds rows and summary from IPC payloads', () => {
  const now = Date.now();
  const view = buildProtocolPanelView({
    runs: [{
      runId: 'r1', status: 'running', eventCount: 12, lastEventType: 'TEXT_MESSAGE_CONTENT',
      startedAt: new Date(now - 5000).toISOString(),
      usage: { provider: 'openai', model: 'gpt-5', promptTokens: 100, completionTokens: 50, totalTokens: 150 },
      pendingInterrupts: 1, pendingSurfaces: 2,
    }],
    interrupts: [{
      id: 'int-1', runId: 'r1', kind: 'approval', title: 'Delete?', detail: 'Delete x',
      createdAt: new Date(now - 1000).toISOString(), timeoutMs: 600000,
    }],
    surfaces: [
      { spec: { componentId: 's1', runId: 'r1', kind: 'form', title: 'F', blocking: true }, status: 'pending' },
      { spec: { componentId: 's2', runId: 'r1', kind: 'message', title: 'M' }, status: 'answered' },
    ],
    cards: [{
      card: {
        name: 'open-bot', url: 'http://127.0.0.1:4000', protocolVersion: '1.0.1',
        supportedInterfaces: [{ protocolBinding: 'JSONRPC' }, { protocolBinding: 'GRPC' }],
      },
      signature: { trust: 'internal-hmac', keyId: 'local-v1' },
      verified: true,
    }],
    mcpServers: [
      { name: 'fs', endpoint: 'http://127.0.0.1:4001', protocolVersion: '2026-07-28', discovered: true, tools: 3, tasks: 1 },
      { name: 'old', endpoint: 'http://127.0.0.1:4002', discovered: true, legacy: true, tools: 0, tasks: 0 },
    ],
  }, now);
  assert.equal(view.source, 'local');
  assert.equal(view.runs.length, 1);
  assert.equal(view.runs[0].usageLabel, 'openai/gpt-5: 150 tokens');
  assert.equal(view.summary.runsActive, 1);
  assert.equal(view.summary.interruptsPending, 1);
  assert.equal(view.summary.surfacesPending, 1);
  assert.equal(view.summary.cardsVerified, 1);
  assert.equal(view.summary.mcpDiscovered, 2);
  assert.equal(view.summary.mcpLegacy, 1);
  assert.equal(view.interrupts[0].urgent, false);
  assert.ok((view.interrupts[0].msLeft ?? 0) > 500000);
  assert.deepEqual(view.cards[0].bindings, ['JSONRPC', 'GRPC']);
  assert.equal(view.cards[0].trust, 'internal-hmac');
  assert.equal(view.mcpServers[1].legacy, true);
});

test('v115 panel: defensive parsing drops bad payloads, empty payload is an empty view', () => {
  assert.equal(protocolRunRowFromPayload(null), null);
  assert.equal(protocolRunRowFromPayload({ runId: '' }), null);
  const row = protocolRunRowFromPayload({ runId: 'r', status: 'weird', eventCount: -5 });
  assert.equal(row.status, 'running');
  assert.equal(row.eventCount, 0);
  assert.equal(row.usageLabel, null);
  assert.equal(formatProtocolUsage({ provider: 'x', model: 'm', totalTokens: 1234 }), 'x/m: 1,234 tokens');
  assert.equal(formatProtocolUsage({ provider: 'x' }), null);
  assert.equal(formatProtocolUsage('nope'), null);
  assert.equal(protocolCardRowFromPayload({ card: { name: 'a' } }), null);
  assert.equal(protocolInterruptRowFromPayload({ id: 'i', runId: 'r', kind: 'approval', title: 't' }, Date.now()).urgent, false);
  const empty = buildProtocolPanelView(undefined);
  assert.deepEqual(empty.summary, {
    runsActive: 0, interruptsPending: 0, surfacesPending: 0,
    cardsVerified: 0, mcpDiscovered: 0, mcpLegacy: 0,
  });
});

// ------------------------------------------------------------------- i18n ---

test('v115 i18n: protocols.v115.* keys exist and are non-empty in all 6 locales', () => {
  const locales = ['vi', 'en', 'es', 'fr', 'ja', 'zh'];
  const keys = [
    'protocols.v115Title', 'protocols.v115Intro', 'protocols.v115Runs',
    'protocols.v115Interrupts', 'protocols.v115Surfaces', 'protocols.v115Cards',
    'protocols.v115Mcp', 'protocols.v115Pending', 'protocols.v115Resume',
    'protocols.v115Cancel', 'protocols.v115Verified', 'protocols.v115InternalHmac',
    'protocols.v115LegacyWarning', 'protocols.v115Empty', 'protocols.v115Usage',
  ];
  const counts = new Set();
  for (const locale of locales) {
    const data = readLocale(locale);
    counts.add(Object.keys(data).length);
    for (const key of keys) {
      assert.equal(typeof data[key], 'string', `${locale}:${key}`);
      assert.ok(data[key].trim().length > 0, `${locale}:${key} is empty`);
    }
  }
  assert.equal(counts.size, 1, 'all locales must have the same key count');
});

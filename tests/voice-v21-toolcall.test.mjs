/**
 * Tests for voice v21 intent parsing + voice-driven tool calls
 * + spoken confirmation + the realtime session flow (v1.34, Team T5).
 *
 * All offline, deterministic, no key / network / audio. The
 * session uses the mock executor and the mock TTS synthesiser;
 * time is a virtual clock passed in explicitly.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseVoiceIntentV21,
  isVoiceConfirmationV21,
  isVoiceRefusalV21,
  extractFreeTextV21,
  extractArgsV21,
  defaultVoiceToolDescriptorsV21,
  defaultIntentParserV21Options,
  validateIntentParserV21Options,
  intentV21Summary,
} from '../packages/core/dist/voiceV21/intentParserV21.js';
import {
  VoiceToolCallEngineV21,
  createVoiceToolCallEngineV21,
  createMockVoiceToolExecutorV21,
  decideVoiceToolPolicyV21,
  defaultVoiceToolPolicyV21,
  validateVoiceToolPolicyV21,
  speakableResultV21,
} from '../packages/core/dist/voiceV21/voiceToolCallV21.js';
import {
  VoiceSessionV21,
  createVoiceSessionV21,
} from '../packages/core/dist/voiceV21/sessionV21.js';

const DESCRIPTORS = defaultVoiceToolDescriptorsV21();

// ---------------------------------------------------------------- intent parsing
test('voice v21: intent parser matches triggers and extracts args', () => {
  const intent = parseVoiceIntentV21('search the web for cats in Hanoi', DESCRIPTORS);
  assert.equal(intent.toolName, 'web_search');
  assert.equal(intent.args.query, 'cats in hanoi');
  assert.ok(intent.confidence >= 0.4);
  assert.equal(intent.trigger, 'search the web for');

  const vi = parseVoiceIntentV21('tìm kiếm quán cà phê gần đây', DESCRIPTORS);
  assert.equal(vi.toolName, 'web_search');
  assert.equal(vi.args.query, 'quán cà phê gần đây');

  const time = parseVoiceIntentV21('What time is it?', DESCRIPTORS);
  assert.equal(time.toolName, 'get_time');

  const none = parseVoiceIntentV21('hello, how are you today?', DESCRIPTORS);
  assert.equal(none.toolName, '');
  assert.equal(none.confidence, 0);
});

test('voice v21: intent parser extracts quoted args and numbers', () => {
  const d = DESCRIPTORS.find((x) => x.name === 'set_reminder');
  assert.ok(d);
  const intent = parseVoiceIntentV21('remind me to "call mom" in 30 minutes', DESCRIPTORS);
  assert.equal(intent.toolName, 'set_reminder');
  assert.equal(intent.args.text, 'call mom');
  assert.equal(intent.args.minutes, 30);
  assert.deepEqual(extractArgsV21('take a note "buy milk"', 'take a note', DESCRIPTORS.find((x) => x.name === 'take_note')), { text: 'buy milk' });
  assert.equal(extractFreeTextV21('search the web for cats', 'search the web for'), 'cats');
});

test('voice v21: confirmation / refusal detection (vi + en)', () => {
  assert.equal(isVoiceConfirmationV21('yes, do it'), true);
  assert.equal(isVoiceConfirmationV21('Đồng ý, làm đi'), true);
  assert.equal(isVoiceConfirmationV21('ok làm đi'), true);
  assert.equal(isVoiceConfirmationV21('search the web for cats'), false);
  assert.equal(isVoiceRefusalV21('no, cancel it'), true);
  assert.equal(isVoiceRefusalV21('Không, hủy đi'), true);
  assert.equal(isVoiceRefusalV21('thôi đừng'), true);
  assert.equal(isVoiceRefusalV21('yes please'), false);
  assert.equal(isVoiceRefusalV21(''), false);
  assert.deepEqual(validateIntentParserV21Options({ minConfidence: 2 }), ['minConfidence must be 0..1']);
  assert.deepEqual(validateIntentParserV21Options({}), []);
  assert.equal(defaultIntentParserV21Options().minConfidence, 0.4);
  assert.match(intentV21Summary(parseVoiceIntentV21('search the web for cats', DESCRIPTORS)), /web_search/);
});

// ---------------------------------------------------------------- policy
test('voice v21: policy defaults — read runs, write/send/delete confirm, deny overrides', () => {
  const policy = defaultVoiceToolPolicyV21();
  assert.equal(decideVoiceToolPolicyV21({ name: 'web_search', description: '', effect: 'read', triggers: [], argNames: [] }, policy), 'allow');
  assert.equal(decideVoiceToolPolicyV21({ name: 'take_note', description: '', effect: 'local-write', triggers: [], argNames: [] }, policy), 'confirm');
  assert.equal(decideVoiceToolPolicyV21({ name: 'send_message', description: '', effect: 'send', triggers: [], argNames: [] }, policy), 'confirm');
  assert.equal(decideVoiceToolPolicyV21({ name: 'delete_note', description: '', effect: 'delete', triggers: [], argNames: [] }, policy), 'confirm');
  const denied = { ...defaultVoiceToolPolicyV21(), perTool: { delete_note: 'deny' } };
  assert.equal(decideVoiceToolPolicyV21({ name: 'delete_note', description: '', effect: 'delete', triggers: [], argNames: [] }, denied), 'deny');
  assert.deepEqual(validateVoiceToolPolicyV21({ defaultForEffect: { read: 'maybe' }, perTool: {} }), ['defaultForEffect.read must be allow/confirm/deny']);
  assert.equal(speakableResultV21('short', 500), 'short');
  assert.ok(speakableResultV21('word '.repeat(200), 50).length <= 51);
});

// ---------------------------------------------------------------- tool-call engine
test('voice v21: read tool runs at once via the engine', async () => {
  const engine = createVoiceToolCallEngineV21('s1');
  const intent = parseVoiceIntentV21('search the web for cats', DESCRIPTORS);
  const record = await engine.request(intent, 'turn-1', 1000);
  assert.ok(record);
  assert.equal(record.status, 'succeeded');
  assert.match(record.resultText ?? '', /cats/);
  assert.equal(engine.stats(1000).succeeded, 1);
  assert.equal(engine.pending(1000), undefined);
});

test('voice v21: side-effect tool waits for spoken confirmation, then runs', async () => {
  const engine = createVoiceToolCallEngineV21('s1');
  const intent = parseVoiceIntentV21('take a note buy milk', DESCRIPTORS);
  const record = await engine.request(intent, 'turn-1', 1000);
  assert.ok(record);
  assert.equal(record.status, 'pending-confirmation');
  assert.equal(record.confirmationRequired, true);
  assert.match(engine.confirmationPrompt(record), /take_note|buy milk/);

  // A "yes" transcript confirms it; the note is then really saved.
  const yes = parseVoiceIntentV21('yes, do it', DESCRIPTORS);
  const handled = await engine.handleConfirmationIntent(yes, 2000);
  assert.equal(handled.action, 'confirmed');
  assert.equal(handled.record?.status, 'succeeded');
  assert.match(handled.record?.resultText ?? '', /buy milk/);
  assert.equal(engine.pending(2000), undefined);
});

test('voice v21: spoken refusal declines the pending call, nothing runs', async () => {
  const { executor, notes } = createMockVoiceToolExecutorV21();
  const engine = createVoiceToolCallEngineV21('s1', { executor });
  const intent = parseVoiceIntentV21('delete note buy milk', DESCRIPTORS);
  const record = await engine.request(intent, 'turn-1', 1000);
  assert.equal(record?.status, 'pending-confirmation');
  const no = parseVoiceIntentV21('không, hủy đi', DESCRIPTORS);
  const handled = await engine.handleConfirmationIntent(no, 2000);
  assert.equal(handled.action, 'declined');
  assert.equal(handled.record?.status, 'declined');
  assert.deepEqual(notes, []);
  assert.equal(engine.stats(2000).declined, 1);
});

test('voice v21: denied tool never runs; unknown tool is denied with a reason', async () => {
  const policy = { ...defaultVoiceToolPolicyV21(), perTool: { send_message: 'deny' } };
  const engine = createVoiceToolCallEngineV21('s1', { policy });
  const denied = await engine.request(parseVoiceIntentV21('send a message to mom hello', DESCRIPTORS), 'turn-1', 1000);
  assert.equal(denied?.status, 'denied');
  assert.match(denied?.denialReason ?? '', /denied by voice policy/);
  const unknown = await engine.request({ toolName: 'fly_rocket', args: {}, confidence: 1, transcript: 'fly rocket' }, 'turn-2', 2000);
  assert.equal(unknown?.status, 'denied');
  assert.match(unknown?.denialReason ?? '', /Unknown tool/);
  assert.equal(engine.stats(2000).denied, 2);
});

test('voice v21: pending confirmation expires after the timeout', async () => {
  const engine = createVoiceToolCallEngineV21('s1', { confirmTimeoutMs: 5000 });
  await engine.request(parseVoiceIntentV21('take a note buy milk', DESCRIPTORS), 'turn-1', 1000);
  assert.ok(engine.pending(2000));
  assert.equal(engine.pending(7000), undefined);
  assert.equal(engine.stats(7000).declined, 1);
  assert.equal(engine.summary(7000).includes('declined'), true);
});

test('voice v21: executor failure is reported, not thrown', async () => {
  const engine = createVoiceToolCallEngineV21('s1', {
    executor: async () => { throw new Error('boom'); },
  });
  const record = await engine.request(parseVoiceIntentV21('what time is it', DESCRIPTORS), 'turn-1', 1000);
  assert.equal(record?.status, 'failed');
  assert.match(record?.resultText ?? '', /boom/);
});

// ---------------------------------------------------------------- session flow
test('voice v21: session runs a read tool call end to end and speaks the result', async () => {
  const session = createVoiceSessionV21('sess-1');
  session.start(0);
  const record = await session.feedFinal('search the web for cats in Hanoi', 1000);
  assert.ok(record);
  assert.equal(record.toolName, 'web_search');
  assert.equal(record.status, 'succeeded');
  assert.equal(session.state(), 'listening');
  assert.ok(session.stats().ttsChunksSpoken >= 1);
  assert.ok(session.latencySamples().some((s) => s.stage === 'tool'));
  assert.ok(session.latencySamples().some((s) => s.stage === 'stt'));
  const monitor = session.monitor(1000);
  assert.equal(monitor.turnState, 'listening');
  assert.ok(monitor.finalTranscript.some((l) => l.includes('cats')));
  assert.ok(monitor.recentToolCalls.some((c) => c.toolName === 'web_search'));
});

test('voice v21: session asks for confirmation, spoken yes runs the tool', async () => {
  const session = createVoiceSessionV21('sess-2');
  session.start(0);
  const pending = await session.feedFinal('take a note buy milk', 1000);
  assert.equal(pending?.status, 'pending-confirmation');
  assert.equal(session.state(), 'confirming');
  const done = await session.feedFinal('Đồng ý, làm đi', 2000);
  assert.equal(done?.status, 'succeeded');
  assert.equal(session.state(), 'listening');
  // The note really landed in the mock executor: read it back.
  const readBack = await session.feedFinal('read my notes', 3000);
  assert.match(readBack?.resultText ?? '', /buy milk/);
});

test('voice v21: session handles plain chat with scripted replies and partials', async () => {
  const session = createVoiceSessionV21('sess-3');
  session.start(0);
  await session.feedPartial('xin ch', 500);
  assert.equal(session.monitor(500).livePartial, 'xin ch');
  const record = await session.feedFinal('xin chào', 1000);
  assert.equal(record, null);
  assert.equal(session.monitor(1000).livePartial, '');
  assert.ok(session.eventLog().some((e) => e.kind === 'transcript'));
  assert.ok(session.eventLog().some((e) => e.kind === 'intent'));
  assert.ok(session.summary().includes('sess-3'));
  session.close(2000);
  assert.equal(await session.feedFinal('hello', 3000), null);
});

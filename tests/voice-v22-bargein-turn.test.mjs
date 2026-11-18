/**
 * Tests for voice v22 barge-in v2 + turn-taking v2 (v1.35, Team T5).
 *
 * Covers the four-level barge-in decision (ignore / duck-soft /
 * duck-hard / interrupt), the interrupt cooldown, the cut-reply
 * resume queue with dispositions, the partial-transcript keeper,
 * the floor-arbitrating turn machine, and the session-level
 * barge-in (duck holds the reply, interrupt cuts and queues it).
 * All offline, deterministic, no key / network / audio.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BargeInEngineV22,
  createBargeInEngineV22,
  PartialTranscriptKeeperV22,
  scoreBargeInV22,
  decideBargeInV22,
  evaluateBargeInBurstV22,
  splitReplyAtCutV22,
  isBackchannelBurstV22,
  realWordsInBurstV22,
  defaultBargeInV22Options,
  validateBargeInV22Options,
  VOICE_V22_BACKCHANNEL_WORDS,
} from '../packages/core/dist/voiceV22/bargeInV22.js';
import {
  TurnTakingMachineV22,
  createTurnTakingMachineV22,
  defaultTurnTakingV22Options,
  validateTurnTakingV22Options,
  floorPriorityRankV22,
} from '../packages/core/dist/voiceV22/turnTakingV22.js';
import {
  VoiceSessionV22,
  createVoiceSessionV22,
} from '../packages/core/dist/voiceV22/sessionV22.js';

const LOUD = { atMs: 100, energy: 0.9, sustainMs: 800, words: ['stop', 'wait', 'listen', 'to', 'me'], agentSpeaking: true };
const SOFT = { atMs: 100, energy: 0.5, sustainMs: 400, words: ['ừm'], agentSpeaking: true };
const MEDIUM = { atMs: 100, energy: 0.5, sustainMs: 300, words: ['wait', 'a'], agentSpeaking: true };

// ---------------------------------------------------------------- scoring
test('voice v22: barge-in scoring — four levels, echo scores zero', () => {
  assert.equal(evaluateBargeInBurstV22(LOUD).decision, 'interrupt');
  assert.equal(evaluateBargeInBurstV22(SOFT).decision, 'duck-soft');
  assert.equal(evaluateBargeInBurstV22(MEDIUM).decision, 'duck-hard');
  const quiet = evaluateBargeInBurstV22({ ...LOUD, energy: 0.05, sustainMs: 50, words: [] });
  assert.equal(quiet.decision, 'ignore');
  const echo = evaluateBargeInBurstV22({ ...LOUD, echo: true });
  assert.equal(echo.score.total, 0);
  assert.equal(echo.score.echoPenalty, 1);
  assert.equal(echo.decision, 'ignore');
  const notSpeaking = evaluateBargeInBurstV22({ ...LOUD, agentSpeaking: false });
  assert.equal(notSpeaking.decision, 'ignore');
  const scored = scoreBargeInV22(LOUD);
  assert.ok(scored.total >= 0.65);
  assert.ok(scored.energyScore > 0.8);
  assert.equal(decideBargeInV22({ ...scored, total: 0.9 }), 'interrupt');
  assert.equal(decideBargeInV22({ ...scored, total: 0.55 }), 'duck-hard');
  assert.equal(decideBargeInV22({ ...scored, total: 0.4 }), 'duck-soft');
  assert.equal(decideBargeInV22({ ...scored, total: 0.1 }), 'ignore');
});

test('voice v22: barge-in options defaults + validation', () => {
  const d = defaultBargeInV22Options();
  assert.equal(d.interruptThreshold, 0.65);
  assert.equal(d.duckHardThreshold, 0.5);
  assert.equal(d.duckSoftThreshold, 0.35);
  assert.equal(d.interruptCooldownMs, 1500);
  assert.deepEqual(validateBargeInV22Options({}), []);
  assert.ok(validateBargeInV22Options({ duckSoftThreshold: 0.6, duckHardThreshold: 0.5 }).length > 0);
  assert.ok(validateBargeInV22Options({ duckHardThreshold: 0.7, interruptThreshold: 0.65 }).length > 0);
  assert.ok(validateBargeInV22Options({ maxQueuedReplies: 0 }).length > 0);
  assert.ok(validateBargeInV22Options({ dropSpokenFraction: 2 }).length > 0);
});

test('voice v22: backchannel bursts are real speech, not interruptions', () => {
  assert.equal(isBackchannelBurstV22(['ừ', 'ừm']), true);
  assert.equal(isBackchannelBurstV22(['yeah']), true);
  assert.equal(isBackchannelBurstV22(['yeah', 'stop']), false);
  assert.equal(isBackchannelBurstV22([]), false);
  assert.equal(realWordsInBurstV22(['ừ', 'stop', 'now']), 2);
  assert.ok(VOICE_V22_BACKCHANNEL_WORDS.length >= 10);
});

// ---------------------------------------------------------------- reply cut + queue
test('voice v22: reply cut is word-boundary + disposition by spoken fraction', () => {
  const reply = 'The quick brown fox jumps.';
  const cut = splitReplyAtCutV22(reply, 10);
  assert.equal(cut.spoken, 'The quick');
  assert.equal(cut.remaining, 'brown fox jumps.');
  assert.equal(cut.disposition, 'resume');
  const nearlyDone = splitReplyAtCutV22('The quick brown fox jumps over the lazy dog and runs away.', 56);
  assert.equal(nearlyDone.disposition, 'drop');
  const long = splitReplyAtCutV22('word '.repeat(50).trim(), 12);
  assert.equal(long.disposition, 'summarise');
  assert.deepEqual(splitReplyAtCutV22(reply, 0), {
    spoken: '', remaining: reply, spokenChars: 0, remainingChars: reply.length, disposition: 'resume',
  });
  assert.equal(splitReplyAtCutV22(reply, 999).disposition, 'drop');
  assert.equal(splitReplyAtCutV22('', 0).remaining, '');
});

test('voice v22: interrupt cooldown downgrades the second interrupt to duck-hard', () => {
  const engine = createBargeInEngineV22('s1');
  const first = engine.observe(LOUD);
  assert.equal(first.decision, 'interrupt');
  assert.equal(first.cooledDown, false);
  assert.equal(engine.inCooldown(1000), true);
  assert.ok(engine.cooldownRemainingMs(1000) > 0);
  const second = engine.observe({ ...LOUD, atMs: 1200 });
  assert.equal(second.decision, 'duck-hard');
  assert.equal(second.cooledDown, true);
  const third = engine.observe({ ...LOUD, atMs: 3000 });
  assert.equal(third.decision, 'interrupt');
  assert.equal(engine.stats().interrupted, 2);
  assert.equal(engine.stats().cooledDown, 1);
  assert.equal(engine.stats().duckedHard, 1);
  assert.match(engine.summary(), /2 interrupts/);
});

test('voice v22: cut reply is queued; take/drop/summarise work', () => {
  const engine = createBargeInEngineV22('s1');
  engine.observe(LOUD);
  const reply = 'The quick brown fox jumps over the lazy dog and runs away to the forest.';
  const cut = engine.cutReply(reply, 10, 200, 'turn-1');
  assert.equal(cut.disposition, 'summarise');
  assert.equal(engine.queuedReplies().length, 1);
  assert.equal(engine.queuedReplies()[0].cut.remaining, 'brown fox jumps over the lazy dog and runs away to the forest.');
  engine.noteUserWords(['actually', 'never', 'mind']);
  assert.deepEqual(engine.queuedReplies()[0].userWordsSinceCut, ['actually', 'never', 'mind']);
  assert.equal(engine.summariseCut(cut), 'brown fox jumps over the lazy dog and runs away to the forest.');
  const longCut = splitReplyAtCutV22('First sentence here. Second sentence follows. Third one too.', 5);
  assert.equal(engine.summariseCut(longCut), 'sentence here.');
  const taken = engine.takeQueued();
  assert.equal(taken?.turnId, 'turn-1');
  assert.equal(engine.queuedReplies().length, 0);
  assert.equal(engine.takeQueued(), null);
  engine.observe({ ...LOUD, atMs: 5000 });
  engine.cutReply(reply, 10, 5100, 'turn-2');
  const id = engine.queuedReplies()[0].id;
  assert.equal(engine.dropQueued('nope'), false);
  assert.equal(engine.dropQueued(id), true);
  assert.equal(engine.queuedReplies().length, 0);
  const history = engine.history();
  assert.equal(history.length, 2);
  assert.equal(history[0].cut?.disposition, 'summarise');
});

// ---------------------------------------------------------------- partial transcript keeper
test('voice v22: partial transcript keeper preserves half-heard words', () => {
  const keeper = new PartialTranscriptKeeperV22();
  keeper.add('t1', 'xin', 100);
  keeper.add('t1', 'xin chào', 200);
  assert.equal(keeper.heardSoFar('t1'), 'xin chào');
  assert.equal(keeper.unfinalised().length, 1);
  keeper.finalise('t1', 'xin chào bạn', 300);
  assert.equal(keeper.heardSoFar('t1'), 'xin chào bạn');
  assert.equal(keeper.unfinalised().length, 0);
  assert.equal(keeper.finalise('t2', 'new turn', 400)?.finalised, true);
  keeper.clearTurn('t1');
  assert.equal(keeper.heardSoFar('t1'), '');
  keeper.clear();
  assert.equal(keeper.all().length, 0);
});

// ---------------------------------------------------------------- turn-taking v2
test('voice v22: turn machine walks the v2 states incl. yielded + paused', () => {
  const m = createTurnTakingMachineV22('s1');
  assert.equal(m.currentState(), 'idle');
  assert.equal(m.currentFloor(), 'none');
  m.setListening(0);
  assert.equal(m.currentFloor(), 'user');
  m.handle('user-speech-start', 100);
  m.handle('user-speech-end', 1500, { text: 'hello there' });
  assert.equal(m.currentState(), 'waiting');
  m.handle('agent-speak-start', 1800, { text: 'hi!' });
  assert.equal(m.currentState(), 'speaking');
  assert.equal(m.currentFloor(), 'agent');
  m.handle('duck-hard', 2000, { text: 'hi!' });
  assert.equal(m.currentState(), 'yielded');
  assert.equal(m.heldReplyText(), 'hi!');
  m.handle('resume-held', 2500);
  assert.equal(m.currentState(), 'speaking');
  m.handle('agent-speak-end', 3000, { text: 'hi!' });
  assert.equal(m.currentState(), 'listening');
  assert.equal(m.currentFloor(), 'user');
  m.handle('pause', 3500);
  assert.equal(m.currentState(), 'paused');
  assert.equal(m.currentFloor(), 'none');
  m.handle('resume', 4000);
  assert.equal(m.currentState(), 'listening');
  const stats = m.stats();
  assert.equal(stats.turns, 2);
  assert.equal(stats.ducks, 1);
  assert.equal(stats.pauses, 1);
  assert.equal(stats.invalidTransitions, 0);
  assert.match(m.summary(), /floor=user/);
});

test('voice v22: turn machine rejects invalid transitions without changing state', () => {
  const m = createTurnTakingMachineV22('s1');
  const rejected = m.handle('agent-speak-end', 0);
  assert.equal(rejected.rejectedReason !== undefined, true);
  assert.equal(m.currentState(), 'idle');
  assert.equal(m.stats().invalidTransitions, 1);
  const badListen = m.setListening(10);
  assert.equal(badListen.to, 'listening');
  const badListen2 = m.setListening(20);
  assert.ok(badListen2.rejectedReason !== undefined);
  assert.deepEqual(validateTurnTakingV22Options({}), []);
  assert.ok(validateTurnTakingV22Options({ silenceYieldMs: 1000, silenceNudgeMs: 5000 }).length > 0);
  assert.ok(validateTurnTakingV22Options({ waitingTimeoutMs: 10 }).length > 0);
  assert.deepEqual(defaultTurnTakingV22Options().silenceNudgeMs, 8000);
});

test('voice v22: floor requests — interrupt grants, polite queues, paused refuses', () => {
  const m = createTurnTakingMachineV22('s1');
  m.setListening(0);
  const polite = m.requestFloor('agent', 'polite', 'answer the question', 100);
  assert.equal(polite.outcome, 'queued');
  assert.match(polite.note ?? '', /floor held by user/);
  const interrupt = m.requestFloor('agent', 'interrupt', 'urgent alert', 200);
  assert.equal(interrupt.outcome, 'granted');
  assert.equal(m.currentFloor(), 'agent');
  const duck = m.requestFloor('user', 'duck', 'user spoke', 300);
  assert.equal(duck.outcome, 'granted');
  assert.equal(m.currentFloor(), 'user');
  m.handle('pause', 400);
  const refused = m.requestFloor('agent', 'interrupt', 'too late', 500);
  assert.equal(refused.outcome, 'refused');
  const stats = m.stats();
  assert.equal(stats.floorRequests, 4);
  assert.equal(stats.floorGrants, 2);
  assert.equal(stats.floorRefusals, 1);
  assert.equal(floorPriorityRankV22('interrupt'), 3);
  assert.ok(floorPriorityRankV22('duck') > floorPriorityRankV22('polite'));
  m.releaseFloor(600);
  assert.equal(m.currentFloor(), 'none');
});

test('voice v22: silence nudge then floor yield; waiting timeout fires', () => {
  const m = createTurnTakingMachineV22('s1', { silenceNudgeMs: 1000, silenceYieldMs: 3000, waitingTimeoutMs: 2000 });
  m.setListening(0);
  assert.equal(m.checkSilence(500), 'none');
  assert.equal(m.checkSilence(1200), 'nudged');
  assert.equal(m.stats().silenceNudges, 1);
  assert.equal(m.checkSilence(1500), 'none'); // nudge only once
  assert.equal(m.checkSilence(5000), 'yielded'); // nudge reset stateSinceMs at 1200
  assert.equal(m.currentFloor(), 'none');
  m.handle('user-speech-start', 4000);
  m.handle('user-speech-end', 4500, { text: 'hi' });
  assert.equal(m.checkWaitingTimeout(7000), true);
  assert.equal(m.currentState(), 'idle');
  assert.equal(m.classifyOverlap(100), 'backchannel');
  assert.equal(m.classifyOverlap(300), 'overlap');
  assert.equal(m.classifyOverlap(500), 'barge-in');
});

test('voice v22: overlap records distinguish barge-in from backchannel', () => {
  const m = createTurnTakingMachineV22('s1');
  m.setListening(0);
  m.handle('user-speech-start', 100);
  m.handle('user-speech-end', 500, { text: 'q' });
  m.handle('agent-speak-start', 600, { text: 'a long answer' });
  m.handle('user-speech-start', 700);
  m.handle('barge-in', 1200, { text: 'stop' });
  assert.equal(m.overlapHistory().length, 1);
  assert.equal(m.overlapHistory()[0].durationMs, 500);
  assert.equal(m.overlapHistory()[0].becameBargeIn, true);
  assert.equal(m.stats().bargeIns, 1);
  assert.equal(m.turnHistory().filter((t) => t.bargeInCut).length, 1);
});

// ---------------------------------------------------------------- session-level barge-in
test('voice v22: session interrupt cuts the reply and queues the remainder', async () => {
  const longReply = 'Alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau upsilon phi chi psi omega. ' +
    'Second sentence follows here with more words to speak. Third sentence keeps going on and on and on.';
  const session = createVoiceSessionV22('s1', {
    scriptedReplies: { hello: longReply },
    ttsChunkChars: 30,
  });
  session.start(0);
  const feed = session.feedFinal('hello', 100);
  // Wait until the agent has actually spoken a chunk, then interrupt.
  for (let i = 0; i < 100 && session.stats().ttsChunksSpoken === 0; i += 1) {
    await new Promise((r) => setTimeout(r, 2));
  }
  assert.ok(session.stats().ttsChunksSpoken > 0);
  assert.equal(session.state(), 'speaking');
  const { decision, cut } = await session.feedBargeIn(
    { atMs: 150, energy: 0.9, sustainMs: 800, words: ['stop', 'wait', 'listen', 'to', 'me'] },
    150,
  );
  assert.equal(decision, 'interrupt');
  assert.notEqual(cut, null);
  assert.ok(cut.spokenChars > 0);
  assert.ok(cut.remainingChars > 0);
  await feed;
  assert.equal(session.state(), 'listening');
  assert.equal(session.stats().bargeIns, 1);
  assert.equal(session.bargeIn.queuedReplies().length, 1);
  const spoken = await session.resumeQueuedReply(500);
  assert.ok(spoken.length > 0);
  assert.equal(session.bargeIn.queuedReplies().length, 0);
});

test('voice v22: session duck-hard holds the reply; duck-soft keeps talking', async () => {
  const longReply = 'Alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau upsilon. ' +
    'More words follow in the second sentence of this long reply.';
  const session = createVoiceSessionV22('s1', {
    scriptedReplies: { hello: longReply },
    ttsChunkChars: 30,
  });
  session.start(0);
  const feed = session.feedFinal('hello', 100);
  for (let i = 0; i < 100 && session.stats().ttsChunksSpoken === 0; i += 1) {
    await new Promise((r) => setTimeout(r, 2));
  }
  assert.ok(session.stats().ttsChunksSpoken > 0);
  assert.equal(session.state(), 'speaking');
  const soft = await session.feedBargeIn(
    { atMs: 150, energy: 0.5, sustainMs: 400, words: ['ừm'] },
    150,
  );
  assert.equal(soft.decision, 'duck-soft');
  assert.equal(soft.cut, null);
  await feed;
  assert.equal(session.stats().ducks, 1);
  assert.equal(session.stats().bargeIns, 0);
});

test('voice v22: barge-in while idle is ignored, not an error', async () => {
  const session = createVoiceSessionV22('s1');
  session.start(0);
  const { decision, cut } = await session.feedBargeIn(
    { atMs: 100, energy: 0.9, sustainMs: 800, words: ['stop', 'now', 'please', 'stop'] },
    100,
  );
  assert.equal(decision, 'ignore');
  assert.equal(cut, null);
  assert.equal(session.stats().bargeIns, 0);
});

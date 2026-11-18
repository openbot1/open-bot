/**
 * Tests for open-turn v20 (v1.29, Team T5).
 *
 * Covers silence classification (thinking / trailing /
 * listening), the v8 barge-in scorer (cut / warn /
 * backchannel / ignore, echo discount, speaker-change),
 * mid-sentence interruption (word-boundary cut + prosody
 * carry) and overlap arbitration, plus the stateful engine.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  OpenTurnEngineV20,
  createOpenTurnEngineV20,
  classifySilenceV20,
  scoreOpenTurnBargeInV20,
  isBackchannelV20,
  interruptSentenceV20,
  carryProsodyV20,
  arbitrateOverlapV20,
  defaultSilenceV20Options,
  validateSilenceV20Options,
  defaultBargeInScoreV20Options,
  validateBargeInScoreV20Options,
  openTurnV20Markdown,
} from '../packages/core/dist/voiceV20/openTurnV20.js';
import {
  ProsodyTtsV20,
  createProsodyTtsV20,
} from '../packages/core/dist/voiceV20/ttsProsodyV20.js';

// ---------------------------------------------------------------- silence
test('voice v129-t5: silence after a complete sentence ends the turn', () => {
  const d = classifySilenceV20('Cho tôi biết bây giờ là mấy giờ?', 800);
  assert.equal(d.kind, 'trailing-silence');
  assert.equal(d.endTurn, true);
  assert.equal(d.nudge, false);
  assert.ok(d.confidence >= 0.8);
});

test('voice v129-t5: silence after a filler or continuer holds the turn', () => {
  const filler = classifySilenceV20('Tôi muốn đặt vé… ừm…', 800);
  assert.equal(filler.kind, 'thinking-pause');
  assert.equal(filler.endTurn, false);

  const cont = classifySilenceV20('Tôi muốn đi Đà Nẵng và', 900);
  assert.equal(cont.kind, 'thinking-pause');
  assert.equal(cont.endTurn, false);

  const unfinished = classifySilenceV20('Tôi muốn đặt vé đi', 800);
  assert.equal(unfinished.kind, 'thinking-pause');
  assert.equal(unfinished.endTurn, false);

  const enFiller = classifySilenceV20('I want to book a ticket, um…', 900);
  assert.equal(enFiller.kind, 'thinking-pause');
  assert.equal(enFiller.endTurn, false);
});

test('voice v129-t5: short gaps never end a turn; huge gaps always do', () => {
  assert.equal(classifySilenceV20('Xin chào.', 150).endTurn, false);
  assert.equal(classifySilenceV20('Tôi muốn đặt vé… ừm…', 8000).endTurn, true);
  assert.equal(classifySilenceV20('Tôi muốn đặt vé… ừm…', 8000).kind, 'trailing-silence');
  // No speech yet + long wait → listening pause with a nudge.
  const waiting = classifySilenceV20('', 5000);
  assert.equal(waiting.kind, 'listening-pause');
  assert.equal(waiting.nudge, true);
  assert.equal(waiting.endTurn, false);
  assert.deepEqual(validateSilenceV20Options({ thinkingMaxMs: -1 }), ['thinkingMaxMs must be >= 0']);
  assert.deepEqual(validateSilenceV20Options({}), []);
  assert.equal(defaultSilenceV20Options().minEndGapMs, 300);
});

// ---------------------------------------------------------------- barge-in scoring
test('voice v129-t5: strong sustained speech cuts; weak bursts do not', () => {
  const cut = scoreOpenTurnBargeInV20({
    energy: 0.9, sustainMs: 600, transcriptWords: ['dừng', 'lại', 'đi'],
    echo: false, speakerChange: true, msSinceChunkStart: 500,
  });
  assert.equal(cut.verdict, 'cut');
  assert.ok(cut.score >= 0.75);

  const weak = scoreOpenTurnBargeInV20({
    energy: 0.4, sustainMs: 120, transcriptWords: [],
    echo: false, speakerChange: false, msSinceChunkStart: 600,
  });
  assert.equal(weak.verdict, 'ignore');

  const quiet = scoreOpenTurnBargeInV20({
    energy: 0.1, sustainMs: 500, transcriptWords: ['a', 'b', 'c'],
    echo: false, speakerChange: false, msSinceChunkStart: 500,
  });
  assert.equal(quiet.verdict, 'ignore');
  assert.match(quiet.reason, /below min/);

  // Mid-strength → early warning, not a cut.
  const warn = scoreOpenTurnBargeInV20({
    energy: 0.6, sustainMs: 400, transcriptWords: ['khoan'],
    echo: false, speakerChange: false, msSinceChunkStart: 500,
  });
  assert.equal(warn.verdict, 'warn');
  assert.deepEqual(validateBargeInScoreV20Options({ cutThreshold: 0.4, warnThreshold: 0.5 }), ['warnThreshold must be < cutThreshold']);
  assert.deepEqual(validateBargeInScoreV20Options({}), []);
  assert.equal(defaultBargeInScoreV20Options().cutThreshold, 0.75);
});

test('voice v129-t5: echo inside the window is discounted; backchannel never cuts', () => {
  const echo = scoreOpenTurnBargeInV20({
    energy: 0.9, sustainMs: 500, transcriptWords: ['hello'],
    echo: true, speakerChange: false, msSinceChunkStart: 60,
  });
  assert.equal(echo.echoDiscounted, true);
  assert.equal(echo.verdict, 'ignore');
  assert.ok(echo.score < echo.rawScore);

  assert.equal(isBackchannelV20(['ừ']), true);
  assert.equal(isBackchannelV20(['yeah']), true);
  assert.equal(isBackchannelV20(['ok']), true);
  assert.equal(isBackchannelV20(['dừng', 'lại']), false);
  assert.equal(isBackchannelV20([]), false);
  assert.equal(isBackchannelV20(['ừ', 'ừ', 'ừ']), false);

  const bc = scoreOpenTurnBargeInV20({
    energy: 0.8, sustainMs: 500, transcriptWords: ['ừ'],
    echo: false, speakerChange: false, msSinceChunkStart: 800,
  });
  assert.equal(bc.verdict, 'backchannel');
  assert.equal(bc.isBackchannel, true);
});

// ---------------------------------------------------------------- sentence interruption
test('voice v129-t5: mid-sentence cut splits at a word boundary and drops the fragment', () => {
  const tts = createProsodyTtsV20();
  const reply = 'Hà Nội là thủ đô của Việt Nam, nổi tiếng với phố cổ và hồ Hoàn Kiếm.';
  const chunks = tts.plan(reply);
  assert.ok(chunks.filter((c) => c.kind === 'speech').length >= 1);
  const cut = interruptSentenceV20(chunks, 20);
  assert.ok(cut.spokenPrefix.length > 0);
  assert.ok(cut.remainingText.length > 0);
  // Prefix + remaining reconstruct the reply (modulo the dropped fragment + spaces).
  assert.ok((cut.spokenPrefix + ' ' + cut.remainingText).length <= reply.length + 1);
  assert.ok(!cut.spokenPrefix.endsWith(' '));
  assert.ok(!cut.remainingText.startsWith(' '));
  assert.equal(cut.droppedChars, 20 - cut.spokenPrefix.length);
  assert.ok(cut.chunkIndex >= 0);

  const atStart = interruptSentenceV20(chunks, 0);
  assert.equal(atStart.spokenPrefix, '');
  assert.ok(atStart.remainingText.length > 0);
  const atEnd = interruptSentenceV20(chunks, 10000);
  assert.equal(atEnd.remainingText, '');
  assert.equal(atEnd.spokenPrefix, reply);
});

test('voice v129-t5: prosody carry keeps the cut pitch and eases the rate', () => {
  const plan = { rate: 0.85, pitchSt: 2.5, volume: 1.15, emphasis: 'strong', contour: 'question', pauseBeforeMs: 320 };
  const carried = carryProsodyV20(plan, 'phần còn lại của câu trả lời');
  assert.equal(carried.pitchSt, 2.5);
  assert.equal(carried.volume, 1.15);
  assert.equal(carried.pauseBeforeMs, 0);
  assert.ok(carried.rate > 0.85 && carried.rate < 1);
  assert.equal(carryProsodyV20(plan, '   ').pitchSt, 2.5);
});

// ---------------------------------------------------------------- overlap
test('voice v129-t5: overlap arbitration gives the floor to a confident user', () => {
  assert.equal(arbitrateOverlapV20({
    userConfidence: 0.9, agentAskingQuestion: false, agentChunkLowPriority: false,
    userIsBackchannel: false, overlapMs: 200,
  }).decision, 'user-takes-floor');
  assert.equal(arbitrateOverlapV20({
    userConfidence: 0.9, agentAskingQuestion: false, agentChunkLowPriority: false,
    userIsBackchannel: true, overlapMs: 200,
  }).decision, 'backchannel-noted');
  assert.equal(arbitrateOverlapV20({
    userConfidence: 0.5, agentAskingQuestion: true, agentChunkLowPriority: false,
    userIsBackchannel: false, overlapMs: 200,
  }).decision, 'agent-holds-floor');
  assert.equal(arbitrateOverlapV20({
    userConfidence: 0.5, agentAskingQuestion: false, agentChunkLowPriority: true,
    userIsBackchannel: false, overlapMs: 200,
  }).decision, 'user-takes-floor');
  assert.equal(arbitrateOverlapV20({
    userConfidence: 0.3, agentAskingQuestion: false, agentChunkLowPriority: false,
    userIsBackchannel: false, overlapMs: 200,
  }).decision, 'agent-holds-floor');
});

// ---------------------------------------------------------------- engine
test('voice v129-t5: open-turn engine tracks decisions, stats and events', () => {
  const events = [];
  const engine = createOpenTurnEngineV20({}, {}, (e) => events.push(e));
  engine.onSilence('Cho tôi biết bây giờ là mấy giờ?', 800, 100);
  engine.onSilence('Tôi muốn đặt vé… ừm…', 800, 200);
  engine.onBargeInCandidate({
    energy: 0.9, sustainMs: 600, transcriptWords: ['dừng', 'lại'], echo: false,
    speakerChange: true, msSinceChunkStart: 500,
  }, 300);
  engine.onBargeInCandidate({
    energy: 0.5, sustainMs: 300, transcriptWords: ['ừ'], echo: false,
    speakerChange: false, msSinceChunkStart: 800,
  }, 400);
  const tts = new ProsodyTtsV20();
  const chunks = tts.plan('Hà Nội là thủ đô của Việt Nam, nổi tiếng với phố cổ.');
  engine.onSentenceCut(chunks, 10, 500);
  engine.onOverlap({
    userConfidence: 0.9, agentAskingQuestion: false, agentChunkLowPriority: false,
    userIsBackchannel: false, overlapMs: 100,
  }, 600);
  const s = engine.getStats();
  assert.equal(s.silences, 2);
  assert.equal(s.thinkingPauses, 1);
  assert.equal(s.trailingSilences, 1);
  assert.equal(s.cuts, 1);
  assert.equal(s.backchannels, 1);
  assert.equal(s.sentenceCuts, 1);
  assert.equal(s.overlaps, 1);
  assert.equal(s.userTakesFloor, 1);
  assert.equal(events.length, 7);
  assert.ok(engine.summary().includes('Open-turn v20'));
  assert.ok(openTurnV20Markdown(engine).includes('# Open-turn v20'));
  assert.equal(engine.frameEnergy({ seq: 0, atMs: 0, samples: new Int16Array(320).fill(0) }), 0);
});

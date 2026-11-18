/**
 * Tests for voice v20 tools + i18n + registry wiring (v1.29, Team T5).
 *
 * Covers voiceV20Tools (all 8 tools end to end against the
 * default mock instances), the v19 tools wiring into ALL_TOOLS
 * (fixed vs v128), and the voice.v128 / voice.v129 i18n keys
 * in all 6 locales.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createVoiceV20Tools,
  VOICE_V20_TOOLS,
  VOICE_V20_TOOL_NAMES,
  isVoiceV20ToolName,
} from '../packages/tools/dist/voiceV20Tools.js';
import {
  createVoiceV19Tools,
  VOICE_V19_TOOLS,
  VOICE_V19_TOOL_NAMES,
  isVoiceV19ToolName,
} from '../packages/tools/dist/voiceV19Tools.js';
import {
  ALL_TOOLS,
  createDefaultTools,
} from '../packages/tools/dist/tools.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOCALES_DIR = path.join(__dirname, '..', 'apps', 'desktop', 'src', 'renderer', 'i18n', 'locales');
const LOCALES = ['en', 'es', 'fr', 'ja', 'vi', 'zh'];

function toolMap(tools) {
  const m = new Map();
  for (const t of tools) m.set(t.definition.name, t);
  return m;
}

async function run(tools, name, args) {
  const t = toolMap(tools).get(name);
  assert.ok(t, `tool ${name} exists`);
  const out = await t.execute(args);
  assert.equal(typeof out, 'string');
  return out;
}

function parseOk(out) {
  assert.ok(!out.startsWith('Error:'), `expected ok, got: ${out}`);
  return JSON.parse(out);
}

const SNAPSHOT = JSON.stringify({
  phase: 'listening',
  turnCounter: 2,
  turns: [{ id: 'turn-1', role: 'user', text: 'Xin chào', atMs: 0, durationMs: 200 }],
  committedTranscript: 'Xin chào',
  stats: {
    phase: 'listening', frames: 10, turns: 1, userTurns: 1, agentTurns: 0,
    cuts: 0, ttsChunksPlayed: 0, ttsCharsSpoken: 0, events: 3,
  },
});

// ---------------------------------------------------------------- tool inventory
test('voice v129-t5: voice v20 tools — 8 tools, names + factory', () => {
  assert.equal(VOICE_V20_TOOLS.length, 8);
  assert.deepEqual([...VOICE_V20_TOOL_NAMES], [
    'voice_v20_persist_save',
    'voice_v20_persist_load',
    'voice_v20_persist_list',
    'voice_v20_persist_delete',
    'voice_v20_resume',
    'voice_v20_open_turn',
    'voice_v20_transcript_accuracy',
    'voice_v20_eval_extended',
  ]);
  assert.equal(isVoiceV20ToolName('voice_v20_resume'), true);
  assert.equal(isVoiceV20ToolName('voice_v19_eval'), false);
  assert.equal(createVoiceV20Tools().length, 8);
  assert.equal(new Set(VOICE_V20_TOOLS.map((t) => t.definition.name)).size, 8);
  for (const t of VOICE_V20_TOOLS) {
    assert.equal(t.definition.parameters.additionalProperties, false);
    assert.equal(t.needsApproval, false);
  }
});

test('voice v129-t5: voice v19 tools — 13 tools (ported from v128)', () => {
  assert.equal(VOICE_V19_TOOLS.length, 13);
  assert.deepEqual([...VOICE_V19_TOOL_NAMES].slice(0, 3), [
    'voice_v19_session_create', 'voice_v19_session_list', 'voice_v19_session_snapshot',
  ]);
  assert.equal(isVoiceV19ToolName('voice_v19_eval'), true);
  assert.equal(isVoiceV19ToolName('voice_v20_eval_extended'), false);
});

// ---------------------------------------------------------------- registry
test('voice v129-t5: ALL_TOOLS contains v19 + v20 once each, no duplicates', () => {
  const names = ALL_TOOLS.map((t) => t.definition.name);
  assert.equal(new Set(names).size, names.length, 'duplicate tool names in ALL_TOOLS');
  for (const n of VOICE_V19_TOOL_NAMES) assert.ok(names.includes(n), `ALL_TOOLS missing ${n}`);
  for (const n of VOICE_V20_TOOL_NAMES) assert.ok(names.includes(n), `ALL_TOOLS missing ${n}`);
  // Base 604 (v1.14 pin) + 6 coding v14 (T3 v129) + 12 protocol v5 (T2 v129)
  // + 10 memory v21 (T1 v129) + 13 voice v19 + 8 voice v20 = 653 (v129);
  // v1.36 re-pin: 825 + 74 = 899.
  assert.equal(ALL_TOOLS.length, 899); // v1.36 re-pin: 825 + 74 = 899.
  const bound = createDefaultTools();
  assert.equal(bound.length, ALL_TOOLS.length, 'bind must not add/remove tools');
  assert.equal(new Set(bound.map((t) => t.definition.name)).size, bound.length);
});

// ---------------------------------------------------------------- persistence tools
test('voice v129-t5: persist tools save → list → load → delete', async () => {
  const tools = createVoiceV20Tools();
  const saved = parseOk(await run(tools, 'voice_v20_persist_save', {
    sessionId: 'tool-s1', number: 1, atMs: 100, snapshotJson: SNAPSHOT,
    spokenPrefix: 'Chào', remainingText: 'bạn', resumeAction: 'resume',
  }));
  assert.equal(saved.ok, true);
  assert.equal(saved.sessionId, 'tool-s1');
  assert.equal(saved.number, 1);
  assert.ok(saved.checksum);
  assert.equal(saved.checkpoints, 1);

  const listed = parseOk(await run(tools, 'voice_v20_persist_list', {}));
  assert.equal(listed.ok, true);
  assert.ok(listed.sessions.some((s) => s.sessionId === 'tool-s1'));

  const loaded = parseOk(await run(tools, 'voice_v20_persist_load', { sessionId: 'tool-s1' }));
  assert.equal(loaded.ok, true);
  assert.equal(loaded.number, 1);
  assert.equal(loaded.phase, 'listening');
  assert.equal(loaded.committedTranscript, 'Xin chào');
  assert.equal(loaded.spokenPrefix, 'Chào');
  assert.equal(loaded.remainingText, 'bạn');

  const deleted = parseOk(await run(tools, 'voice_v20_persist_delete', { sessionId: 'tool-s1', number: 1 }));
  assert.equal(deleted.removed, true);
  assert.ok((await run(tools, 'voice_v20_persist_load', { sessionId: 'tool-s1' })).startsWith('Error:'));

  // Bad inputs are plain errors, not crashes.
  assert.ok((await run(tools, 'voice_v20_persist_save', {
    sessionId: 'tool-s1', number: 1, atMs: 0, snapshotJson: '{"phase":"x"}',
  })).startsWith('Error:'));
  assert.ok((await run(tools, 'voice_v20_persist_save', {
    sessionId: '../escape', number: 1, atMs: 0, snapshotJson: SNAPSHOT,
  })).startsWith('Error:'));
  assert.ok((await run(tools, 'voice_v20_persist_save', {
    sessionId: 'tool-s1', number: 1, atMs: 0, snapshotJson: 'not json',
  })).startsWith('Error:'));
  assert.ok((await run(tools, 'voice_v20_persist_load', { sessionId: 'nope' })).startsWith('Error:'));
});

// ---------------------------------------------------------------- resume tool
test('voice v129-t5: resume tool interrupt → plan → confirm → status', async () => {
  const tools = createVoiceV20Tools();
  const reply = 'Hà Nội là thủ đô của Việt Nam, nổi tiếng với phố cổ, hồ Hoàn Kiếm và ẩm thực đường phố rất phong phú.';
  const interrupted = parseOk(await run(tools, 'voice_v20_resume', {
    action: 'interrupt', sessionId: 'tool-r1', turnId: 'turn-2',
    replyText: reply, spokenChars: 30, reason: 'barge-in', atMs: 1000,
  }));
  assert.equal(interrupted.ok, true);
  assert.equal(interrupted.interrupts, 1);

  const planned = parseOk(await run(tools, 'voice_v20_resume', { action: 'plan', sessionId: 'tool-r1', atMs: 1100 }));
  assert.equal(planned.ok, true);
  assert.equal(planned.action, 'resume');
  assert.ok(planned.speakText.length > 0);
  assert.ok(planned.speakChunks > 0);

  const confirmed = parseOk(await run(tools, 'voice_v20_resume', { action: 'confirm', sessionId: 'tool-r1', atMs: 1200 }));
  assert.equal(confirmed.action, 'resume');

  const status = parseOk(await run(tools, 'voice_v20_resume', { action: 'status', sessionId: 'tool-r1' }));
  assert.equal(status.ok, true);
  assert.equal(status.canResume.ok, true);
  assert.equal(status.state.resumes, 1);

  // Decline path + bad inputs.
  await run(tools, 'voice_v20_resume', {
    action: 'interrupt', sessionId: 'tool-r2', turnId: 't1',
    replyText: reply, spokenChars: 5, reason: 'crash', atMs: 0,
  });
  const declined = parseOk(await run(tools, 'voice_v20_resume', { action: 'decline', sessionId: 'tool-r2', atMs: 10 }));
  assert.equal(declined.action, 'drop');
  assert.ok((await run(tools, 'voice_v20_resume', { action: 'plan', sessionId: 'tool-r2' })).startsWith('Error:'));
  assert.ok((await run(tools, 'voice_v20_resume', { action: 'explode', sessionId: 'tool-r2' })).startsWith('Error:'));
  assert.ok((await run(tools, 'voice_v20_resume', {
    action: 'interrupt', sessionId: 'tool-r2', turnId: 't', replyText: 'x', spokenChars: 0, reason: 'nope',
  })).startsWith('Error:'));
});

// ---------------------------------------------------------------- open-turn tool
test('voice v129-t5: open-turn tool classifies, scores, cuts and arbitrates', async () => {
  const tools = createVoiceV20Tools();
  const end = parseOk(await run(tools, 'voice_v20_open_turn', {
    action: 'classify-silence', text: 'Cho tôi biết bây giờ là mấy giờ?', gapMs: 800, atMs: 0,
  }));
  assert.equal(end.kind, 'trailing-silence');
  assert.equal(end.endTurn, true);
  const hold = parseOk(await run(tools, 'voice_v20_open_turn', {
    action: 'classify-silence', text: 'Tôi muốn đặt vé… ừm…', gapMs: 800, atMs: 0,
  }));
  assert.equal(hold.kind, 'thinking-pause');
  assert.equal(hold.endTurn, false);

  const cut = parseOk(await run(tools, 'voice_v20_open_turn', {
    action: 'score-barge-in', energy: 0.9, sustainMs: 600,
    transcriptWordsJson: JSON.stringify(['dừng', 'lại', 'đi']),
    echo: false, speakerChange: true, msSinceChunkStart: 500, atMs: 0,
  }));
  assert.equal(cut.verdict, 'cut');

  const bc = parseOk(await run(tools, 'voice_v20_open_turn', {
    action: 'score-barge-in', energy: 0.5, sustainMs: 300,
    transcriptWordsJson: JSON.stringify(['ừ']),
    echo: false, speakerChange: false, msSinceChunkStart: 800, atMs: 0,
  }));
  assert.equal(bc.verdict, 'backchannel');

  const sentence = parseOk(await run(tools, 'voice_v20_open_turn', {
    action: 'interrupt-sentence',
    text: 'Hà Nội là thủ đô của Việt Nam, nổi tiếng với phố cổ.',
    spokenChars: 10, atMs: 0,
  }));
  assert.ok(sentence.spokenPrefix.length > 0);
  assert.ok(sentence.remainingText.length > 0);

  const overlap = parseOk(await run(tools, 'voice_v20_open_turn', {
    action: 'overlap', userConfidence: 0.9, agentAskingQuestion: false,
    agentChunkLowPriority: false, userIsBackchannel: false, overlapMs: 100, atMs: 0,
  }));
  assert.equal(overlap.decision, 'user-takes-floor');
  assert.ok((await run(tools, 'voice_v20_open_turn', { action: 'nope' })).startsWith('Error:'));
});

// ---------------------------------------------------------------- accuracy + eval tools
test('voice v129-t5: transcript accuracy tool scores a pair and the corpus', async () => {
  const tools = createVoiceV20Tools();
  const pair = parseOk(await run(tools, 'voice_v20_transcript_accuracy', {
    action: 'pair',
    reference: 'Tôi muốn mua hai vé xem phim',
    hypothesis: 'Tôi muốn mua hai vé xem phím',
  }));
  // Reference has 7 words ("Tôi/muốn/mua/hai/vé/xem/phim"), 1 substitution
  // → WER 1/7 = 0.1429 (was pinned 0.125 = 1/8: the author miscounted).
  assert.equal(pair.wer, 0.1429);
  assert.equal(pair.substitutions, 1);
  const corpus = parseOk(await run(tools, 'voice_v20_transcript_accuracy', { action: 'corpus' }));
  assert.equal(corpus.aggregate.pairs, 12);
  assert.ok(corpus.aggregate.meanWer < 0.15);
  assert.ok((await run(tools, 'voice_v20_transcript_accuracy', { action: 'nope' })).startsWith('Error:'));
});

test('voice v129-t5: extended eval tool runs and compares against a baseline', async () => {
  const tools = createVoiceV20Tools();
  const out = await run(tools, 'voice_v20_eval_extended', { action: 'run' });
  const runResult = parseOk(out);
  assert.equal(runResult.ok, true);
  assert.equal(runResult.pass, true);
  assert.ok(runResult.summary.includes('PASS'));
  assert.equal(runResult.report.dialogues.length, 6);

  const md = await run(tools, 'voice_v20_eval_extended', { action: 'run', markdown: true });
  assert.ok(md.includes('# Voice eval harness v20'));
  assert.ok(md.includes('PASS'));

  const compared = parseOk(await run(tools, 'voice_v20_eval_extended', {
    action: 'compare', baselineJson: JSON.stringify(runResult.report),
  }));
  assert.equal(compared.ok, true);
  assert.deepEqual(compared.regressed, []);

  // A baseline BETTER than the fresh run flags a regression: compare
  // checks the fresh run against the supplied baseline, so the report
  // with the worse WER belongs in the fresh run, not in the baseline
  // (was backwards: the worse report was passed as the baseline, which
  // makes the fresh run look like an improvement).
  const betterBaseline = {
    ...runResult.report,
    transcript: { ...runResult.report.transcript, meanWer: 0 },
  };
  const comparedWorse = parseOk(await run(tools, 'voice_v20_eval_extended', {
    action: 'compare', baselineJson: JSON.stringify(betterBaseline),
  }));
  assert.ok(comparedWorse.regressed.includes('wer'));
  assert.ok((await run(tools, 'voice_v20_eval_extended', { action: 'compare', baselineJson: '{}' })).startsWith('Error:'));
});

// ---------------------------------------------------------------- v19 tools smoke
test('voice v129-t5: v19 session + prosody + eval tools work from the placeholder', async () => {
  const tools = createVoiceV19Tools();
  const created = parseOk(await run(tools, 'voice_v19_session_create', {
    sessionId: 'v19-smoke', botId: 'b1', language: 'vi', voiceContext: 'chat', connect: true,
  }));
  assert.equal(created.created, true);
  assert.equal(created.snapshot.state, 'listening');
  const listed = parseOk(await run(tools, 'voice_v19_session_list', {}));
  assert.equal(listed.sessions.length, 1);
  assert.equal(listed.stats.live, 1);
  const prosody = parseOk(await run(tools, 'voice_v19_prosody', { action: 'get' }));
  assert.equal(prosody.emotion, 'neutral');
  const plan = parseOk(await run(tools, 'voice_v19_prosody', { action: 'plan', text: 'Cẩn thận! Dừng lại ngay.' }));
  assert.equal(plan.segments.length, 2);
  const evaluated = parseOk(await run(tools, 'voice_v19_eval', { action: 'run' }));
  assert.equal(evaluated.report.passed, true);
});

// ---------------------------------------------------------------- i18n
test('voice v129-t5: voice.v128 + voice.v129 keys exist in all 6 locales', () => {
  const v128Keys = [
    'agentSpeaking', 'compacted', 'eval', 'failover', 'handoff', 'interrupted',
    'listening', 'noProvider', 'pipeline', 'providers', 'reconnect', 'resumed',
    'sessions', 'title',
  ];
  const v129Keys = [
    'title', 'persisted', 'restored', 'resumed', 'summarised', 'dropped', 'eval',
    'wer', 'cer', 'prosody', 'turnTaking', 'bargeIn', 'thinkingPause',
    'trailingSilence', 'listeningPause', 'backchannel', 'openTurn', 'sessions',
    'checkpoints', 'noCheckpoint',
  ];
  for (const loc of LOCALES) {
    const data = JSON.parse(fs.readFileSync(path.join(LOCALES_DIR, `${loc}.json`), 'utf-8'));
    const keys = Object.keys(data);
    assert.equal(keys.length, new Set(keys).size, `${loc}: duplicate keys`);
    assert.deepEqual(keys, [...keys].sort(), `${loc}: keys must stay sorted`);
    for (const k of v128Keys) {
      assert.equal(typeof data[`voice.v128.${k}`], 'string', `${loc}: missing voice.v128.${k}`);
      assert.ok(data[`voice.v128.${k}`].length > 0);
    }
    for (const k of v129Keys) {
      assert.equal(typeof data[`voice.v129.${k}`], 'string', `${loc}: missing voice.v129.${k}`);
      assert.ok(data[`voice.v129.${k}`].length > 0);
    }
  }
  const vi = JSON.parse(fs.readFileSync(path.join(LOCALES_DIR, 'vi.json'), 'utf-8'));
  assert.equal(vi['voice.v129.title'], 'Giọng nói realtime v20 (v1.29)');
  assert.equal(vi['voice.v129.wer'], 'Tỉ lệ lỗi từ (WER)');
  assert.equal(Object.keys(vi).length, 7540); // v1.36 re-pin: 7540.
});

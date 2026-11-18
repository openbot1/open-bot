/**
 * Extended eval harness v20 (voice v20, v1.29 Team T5).
 *
 * Eval v18 scored turn latency, barge-in P/R/F1 and mock TTS
 * quality from scripted scenarios; eval v19 added naturalness,
 * clarity and a regression gate. Both left two questions
 * unanswered — was the transcript right, and did the reply
 * *sound* right (prosody)? — and neither ever drove a real
 * dialogue through the pipeline. This harness closes those
 * gaps, still fully offline on the sample corpus:
 *
 *   1. Transcript accuracy. Every corpus transcript pair is
 *      scored (WER/CER + alignment) and aggregated: mean/p95
 *      WER and CER, pass rate, top confusions.
 *   2. Prosody. Every corpus prosody script is rendered to
 *      reply text (`renderScriptReplyV20`) and scored against
 *      its expectations (contour / emphasis / pause / rate).
 *   3. Turn-taking. Every corpus turn scenario is classified
 *      (`classifySilenceV20`): did the classifier end the turn
 *      exactly when the scenario says it should — and hold
 *      when the user is still thinking?
 *   4. Barge-in. Labelled candidates (real speech, noise, echo,
 *      backchannel) are scored with the v8 scorer and reduced
 *      to precision / recall / F1 with `scoreBargeInDecisionsV20`.
 *   5. Pipeline dialogues. Every corpus dialogue is driven
 *      through a real `VoicePipelineV20` (synthetic frames with
 *      the v128 test driver recipe, mock STT segments, virtual
 *      clock): turn latency percentiles and the pipeline's own
 *      eval report come from the live path, not a formula.
 *   6. Regression gate. A run can be compared against a
 *      baseline report (`compareWithBaselineV20`): any
 *      dimension worse than the tolerance is flagged, so a
 *      "better prosody" change that quietly wrecks WER cannot
 *      land silently.
 *
 * One `EvalHarnessV20Report` per run: per-dimension results, an
 * overall pass/fail at the configured budgets, and a markdown
 * rendering for the panel and the session log. No provider, no
 * sound card, no key — the same run is reproducible to the
 * millisecond.
 */
import {
  createVoicePipelineV20,
  type PipelineV20Snapshot,
} from './pipelineV20';
import {
  scoreBargeInDecisionsV20,
  type BargeInV20LabelledEvent,
  type VoiceEvalV20Report,
} from './metricsV20';
import {
  aggregateTranscriptAccuracyV20,
  scoreTranscriptV20,
  type TranscriptV20AccuracyOptions,
  type TranscriptV20Aggregate,
} from './transcriptAccuracyV20';
import {
  evalProsodyScriptV20,
  renderScriptReplyV20,
  type ProsodyV20EvalOptions,
  type ProsodyV20Report,
} from './prosodyEvalV20';
import {
  EVAL_CORPUS_V20_DIALOGUES,
  EVAL_CORPUS_V20_PROSODY,
  EVAL_CORPUS_V20_TRANSCRIPTS,
  EVAL_CORPUS_V20_TURNS,
  evalCorpusV20Counts,
  type EvalCorpusV20Dialogue,
} from './evalCorpusV20';
import {
  classifySilenceV20,
  scoreOpenTurnBargeInV20,
  type BargeInV20ScoreOptions,
  type SilenceV20Options,
} from './openTurnV20';
import { silentFrameV20, syntheticFrameV20 } from './types';

export interface EvalHarnessV20Options {
  /** p95 turn latency budget (ms, default 1200). */
  turnLatencyP95BudgetMs: number;
  /** Mean WER budget (default 0.15). */
  werBudget: number;
  /** Mean CER budget (default 0.10, calibrated to the reference corpus). */
  cerBudget: number;
  /** Prosody mean-score floor (default 0.7). */
  prosodyFloor: number;
  /** Barge-in F1 floor (default 0.8). */
  bargeInF1Floor: number;
  /** Turn-classification accuracy floor (default 0.8). */
  turnAccuracyFloor: number;
  transcript: Partial<TranscriptV20AccuracyOptions>;
  prosody: Partial<ProsodyV20EvalOptions>;
  silence: Partial<SilenceV20Options>;
  bargeIn: Partial<BargeInV20ScoreOptions>;
}

export function defaultEvalHarnessV20Options(): EvalHarnessV20Options {
  return {
    turnLatencyP95BudgetMs: 1200,
    werBudget: 0.15,
    cerBudget: 0.10,
    prosodyFloor: 0.7,
    bargeInF1Floor: 0.8,
    turnAccuracyFloor: 0.8,
    transcript: {},
    prosody: {},
    silence: {},
    bargeIn: {},
  };
}

export function validateEvalHarnessV20Options(o: Partial<EvalHarnessV20Options>): string[] {
  const e: string[] = [];
  if (o.turnLatencyP95BudgetMs !== undefined && o.turnLatencyP95BudgetMs <= 0) e.push('turnLatencyP95BudgetMs must be > 0');
  if (o.werBudget !== undefined && (o.werBudget < 0 || o.werBudget > 1)) e.push('werBudget must be 0..1');
  if (o.cerBudget !== undefined && (o.cerBudget < 0 || o.cerBudget > 1)) e.push('cerBudget must be 0..1');
  if (o.prosodyFloor !== undefined && (o.prosodyFloor < 0 || o.prosodyFloor > 1)) e.push('prosodyFloor must be 0..1');
  if (o.bargeInF1Floor !== undefined && (o.bargeInF1Floor < 0 || o.bargeInF1Floor > 1)) e.push('bargeInF1Floor must be 0..1');
  if (o.turnAccuracyFloor !== undefined && (o.turnAccuracyFloor < 0 || o.turnAccuracyFloor > 1)) e.push('turnAccuracyFloor must be 0..1');
  return e;
}

export interface EvalHarnessV20TurnResult {
  scenarioId: string;
  expectedEnd: 'end' | 'hold';
  classifiedEnd: boolean;
  correct: boolean;
  kind: string;
  confidence: number;
  reason: string;
}

export interface EvalHarnessV20BargeInResult {
  precision: number;
  recall: number;
  f1: number;
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
  trueNegatives: number;
  /** Per-candidate verdicts (label → what the scorer decided). */
  candidates: { label: string; verdict: string; score: number }[];
}

export interface EvalHarnessV20DialogueResult {
  dialogueId: string;
  turns: number;
  userTurns: number;
  agentTurns: number;
  cuts: number;
  ttsCharsSpoken: number;
  latencyP50Ms: number;
  latencyP95Ms: number;
  latencyMeanMs: number;
  verdict: VoiceEvalV20Report['verdict'];
}

export interface EvalHarnessV20Report {
  atMs: number;
  corpus: ReturnType<typeof evalCorpusV20Counts>;
  transcript: TranscriptV20Aggregate;
  transcriptPass: boolean;
  prosody: ProsodyV20Report[];
  prosodyMean: number;
  prosodyPass: boolean;
  turns: EvalHarnessV20TurnResult[];
  turnAccuracy: number;
  turnPass: boolean;
  bargeIn: EvalHarnessV20BargeInResult;
  bargeInPass: boolean;
  dialogues: EvalHarnessV20DialogueResult[];
  dialoguesLatencyP95Ms: number;
  dialoguesPass: boolean;
  pass: boolean;
  /** Dimensions that failed (empty when the run passes). */
  failedDimensions: string[];
}

export interface EvalHarnessV20Regression {
  dimension: 'wer' | 'cer' | 'prosody' | 'bargeInF1' | 'turnAccuracy' | 'latencyP95Ms';
  baseline: number;
  current: number;
  delta: number;
  tolerance: number;
  regressed: boolean;
}

/** A labelled barge-in candidate for the harness table. */
export interface EvalHarnessV20BargeInCase {
  id: string;
  label: 'speech' | 'noise';
  energy: number;
  sustainMs: number;
  transcriptWords: string[];
  echo: boolean;
  speakerChange: boolean;
  msSinceChunkStart: number;
}

export const EVAL_HARNESS_V20_BARGE_IN_CASES: readonly EvalHarnessV20BargeInCase[] = [
  { id: 'bi-speech-long', label: 'speech', energy: 0.9, sustainMs: 600, transcriptWords: ['dừng', 'lại', 'đi'], echo: false, speakerChange: true, msSinceChunkStart: 500 },
  { id: 'bi-speech-short', label: 'speech', energy: 0.85, sustainMs: 500, transcriptWords: ['khoan', 'đã', 'nào'], echo: false, speakerChange: false, msSinceChunkStart: 900 },
  { id: 'bi-speech-en', label: 'speech', energy: 0.95, sustainMs: 500, transcriptWords: ['stop', 'right', 'there'], echo: false, speakerChange: true, msSinceChunkStart: 700 },
  { id: 'bi-noise-quiet', label: 'noise', energy: 0.1, sustainMs: 200, transcriptWords: [], echo: false, speakerChange: false, msSinceChunkStart: 500 },
  { id: 'bi-noise-cough', label: 'noise', energy: 0.4, sustainMs: 120, transcriptWords: [], echo: false, speakerChange: false, msSinceChunkStart: 600 },
  { id: 'bi-echo', label: 'noise', energy: 0.9, sustainMs: 500, transcriptWords: ['hello'], echo: true, speakerChange: false, msSinceChunkStart: 60 },
  { id: 'bi-backchannel', label: 'noise', energy: 0.5, sustainMs: 300, transcriptWords: ['ừ'], echo: false, speakerChange: false, msSinceChunkStart: 800 },
  { id: 'bi-backchannel-en', label: 'noise', energy: 0.5, sustainMs: 300, transcriptWords: ['yeah'], echo: false, speakerChange: false, msSinceChunkStart: 800 },
];

/** Score the labelled barge-in table with the v8 scorer. */
export function runBargeInEvalV20(
  opts: Partial<BargeInV20ScoreOptions> = {},
  cases: readonly EvalHarnessV20BargeInCase[] = EVAL_HARNESS_V20_BARGE_IN_CASES,
): EvalHarnessV20BargeInResult {
  const events: BargeInV20LabelledEvent[] = [];
  const candidates: EvalHarnessV20BargeInResult['candidates'] = [];
  cases.forEach((c, i) => {
    const scored = scoreOpenTurnBargeInV20(
      {
        energy: c.energy,
        sustainMs: c.sustainMs,
        transcriptWords: c.transcriptWords,
        echo: c.echo,
        speakerChange: c.speakerChange,
        msSinceChunkStart: c.msSinceChunkStart,
      },
      opts,
    );
    const decision: BargeInV20LabelledEvent['decision'] =
      scored.verdict === 'cut' ? 'cut' : scored.verdict === 'warn' ? 'warn' : 'ignore';
    events.push({
      atMs: i * 1000,
      truth: c.label === 'speech' ? 'interruption' : 'non-interruption',
      decision,
    });
    candidates.push({ label: c.label, verdict: scored.verdict, score: scored.score });
  });
  const scores = scoreBargeInDecisionsV20(events);
  return {
    precision: scores.precision,
    recall: scores.recall,
    f1: scores.f1,
    truePositives: scores.truePositives,
    falsePositives: scores.falsePositives,
    falseNegatives: scores.falseNegatives,
    trueNegatives: scores.trueNegatives,
    candidates,
  };
}

export interface DialogueDriveV20Result {
  snapshot: PipelineV20Snapshot;
  evalReport: VoiceEvalV20Report;
  turns: number;
}

/**
 * Drive one corpus dialogue through a real pipeline (virtual
 * clock, synthetic frames, mock STT segments). Mirrors the v128
 * test driver recipe: speech frames arrive with a 70ms delay so
 * the jitter buffer releases them at once.
 */
export function driveDialogueV20(
  dialogue: EvalCorpusV20Dialogue,
  sessionId = `eval-${dialogue.id}`,
): DialogueDriveV20Result {
  const replies = new Map<string, string>();
  for (const t of dialogue.turns) {
    if (t.role === 'user' && t.reply) replies.set(t.text, t.reply);
  }
  const pipeline = createVoicePipelineV20(sessionId, {}, {
    replyFor: (userText) => replies.get(userText) ?? `Bạn vừa nói: ${userText}`,
  });
  let seq = 0;
  let nowMs = 0;
  const feedSpeech = (atMs: number, count: number): void => {
    for (let i = 0; i < count; i += 1) {
      const t = atMs + i * 20;
      pipeline.feedFrame(syntheticFrameV20(seq, t, 8000), t + 70);
      seq += 1;
    }
  };
  const feedSilence = (atMs: number, count: number): void => {
    for (let i = 0; i < count; i += 1) {
      const t = atMs + i * 20;
      pipeline.feedFrame(silentFrameV20(seq, t), t + 70);
      seq += 1;
    }
  };
  pipeline.start(0);
  for (const turn of dialogue.turns) {
    if (turn.role !== 'user') continue;
    // Speak: 12 frames (~240ms) of speech, then the final transcript.
    feedSpeech(nowMs, 12);
    nowMs += 240;
    const turnId = `turn-${pipeline.getTurns().length + 1}`;
    pipeline.ingestTranscript({
      id: `seg-${turnId}`,
      turnId: '',
      text: turn.text,
      status: 'final',
      confidence: 0.95,
      atMs: nowMs,
      throughSeq: seq - 1,
    });
    // Silence until the turn finalises and the agent starts speaking.
    let guard = 0;
    while (pipeline.currentPhase !== 'agent-speaking' && guard < 60) {
      feedSilence(nowMs, 5);
      nowMs += 100;
      guard += 1;
    }
    // Play the whole reply, then settle back to listening.
    pipeline.playAllChunks(nowMs);
    guard = 0;
    while (pipeline.currentPhase !== 'listening' && guard < 60) {
      feedSilence(nowMs, 5);
      nowMs += 100;
      guard += 1;
    }
    // Feed silence through the inter-turn gap instead of jumping the
    // clock: a real mic keeps producing silence frames, and the jitter
    // buffer anchors its 20ms grid on the first frame — jumping nowMs
    // 800ms with no frames desyncs that grid, so the buffer conceals
    // the next turn's frames as a gap and drops the real ones as
    // too-late, and the second user turn never starts.
    const gapMs = turn.silenceAfterMs ?? 500;
    const gapFrames = Math.max(0, Math.round(gapMs / 20));
    feedSilence(nowMs, gapFrames);
    nowMs += gapFrames * 20;
  }
  pipeline.end(nowMs);
  return { snapshot: pipeline.snapshot(), evalReport: pipeline.evaluator.report(), turns: pipeline.getTurns().length };
}

/** The extended harness: offline scoring + pipeline dialogues. */
export class EvalHarnessV20 {
  private opts: EvalHarnessV20Options;

  constructor(opts: Partial<EvalHarnessV20Options> = {}) {
    const errors = validateEvalHarnessV20Options(opts);
    if (errors.length > 0) throw new Error(`Invalid EvalHarnessV20 options: ${errors.join('; ')}`);
    this.opts = { ...defaultEvalHarnessV20Options(), ...opts };
  }

  get options(): EvalHarnessV20Options { return { ...this.opts }; }

  runTranscriptEval(): TranscriptV20Aggregate {
    const scored = EVAL_CORPUS_V20_TRANSCRIPTS.map((p) => scoreTranscriptV20(p.reference, p.hypothesis));
    return aggregateTranscriptAccuracyV20(scored, this.opts.transcript);
  }

  runProsodyEval(): ProsodyV20Report[] {
    return EVAL_CORPUS_V20_PROSODY.map((script) =>
      evalProsodyScriptV20(script, renderScriptReplyV20(script), this.opts.prosody),
    );
  }

  runTurnEval(): EvalHarnessV20TurnResult[] {
    return EVAL_CORPUS_V20_TURNS.map((s) => {
      const d = classifySilenceV20(s.userText, s.silenceAfterMs, this.opts.silence);
      const correct = d.endTurn === (s.expectedEnd === 'end');
      return {
        scenarioId: s.id,
        expectedEnd: s.expectedEnd,
        classifiedEnd: d.endTurn,
        correct,
        kind: d.kind,
        confidence: d.confidence,
        reason: d.reason,
      };
    });
  }

  runBargeInEval(): EvalHarnessV20BargeInResult {
    return runBargeInEvalV20(this.opts.bargeIn);
  }

  runDialogueEval(dialogue: EvalCorpusV20Dialogue): EvalHarnessV20DialogueResult {
    const driven = driveDialogueV20(dialogue);
    const s = driven.snapshot.stats;
    return {
      dialogueId: dialogue.id,
      turns: driven.turns,
      userTurns: s.userTurns,
      agentTurns: s.agentTurns,
      cuts: s.cuts,
      ttsCharsSpoken: s.ttsCharsSpoken,
      latencyP50Ms: driven.evalReport.turnLatency.p50,
      latencyP95Ms: driven.evalReport.turnLatency.p95,
      latencyMeanMs: driven.evalReport.turnLatency.mean,
      verdict: driven.evalReport.verdict,
    };
  }

  /** Run every dimension and reduce to one report. */
  runAll(atMs = 0): EvalHarnessV20Report {
    const transcript = this.runTranscriptEval();
    const transcriptPass = transcript.meanWer <= this.opts.werBudget && transcript.meanCer <= this.opts.cerBudget;
    const prosody = this.runProsodyEval();
    const prosodyMean = prosody.length === 0
      ? 0
      : Math.round((prosody.reduce((s, r) => s + r.score, 0) / prosody.length) * 10000) / 10000;
    const prosodyPass = prosodyMean >= this.opts.prosodyFloor && prosody.every((r) => r.pass);
    const turns = this.runTurnEval();
    const turnAccuracy = turns.length === 0
      ? 0
      : Math.round((turns.filter((t) => t.correct).length / turns.length) * 10000) / 10000;
    const turnPass = turnAccuracy >= this.opts.turnAccuracyFloor;
    const bargeIn = this.runBargeInEval();
    const bargeInPass = bargeIn.f1 >= this.opts.bargeInF1Floor;
    const dialogues = EVAL_CORPUS_V20_DIALOGUES.map((d) => this.runDialogueEval(d));
    const p95s = dialogues.map((d) => d.latencyP95Ms).sort((a, b) => a - b);
    const dialoguesLatencyP95Ms = p95s.length === 0 ? 0 : p95s[Math.min(p95s.length - 1, Math.floor(0.95 * p95s.length))] ?? 0;
    const dialoguesPass = dialoguesLatencyP95Ms <= this.opts.turnLatencyP95BudgetMs
      && dialogues.every((d) => d.userTurns > 0);
    const failedDimensions: string[] = [];
    if (!transcriptPass) failedDimensions.push('transcript');
    if (!prosodyPass) failedDimensions.push('prosody');
    if (!turnPass) failedDimensions.push('turn-taking');
    if (!bargeInPass) failedDimensions.push('barge-in');
    if (!dialoguesPass) failedDimensions.push('dialogue-latency');
    return {
      atMs,
      corpus: evalCorpusV20Counts(),
      transcript,
      transcriptPass,
      prosody,
      prosodyMean,
      prosodyPass,
      turns,
      turnAccuracy,
      turnPass,
      bargeIn,
      bargeInPass,
      dialogues,
      dialoguesLatencyP95Ms,
      dialoguesPass,
      pass: failedDimensions.length === 0,
      failedDimensions,
    };
  }

  summary(report: EvalHarnessV20Report): string {
    return `Eval harness v20: ${report.pass ? 'PASS' : 'FAIL'} — ` +
      `WER ${(report.transcript.meanWer * 100).toFixed(1)}%, CER ${(report.transcript.meanCer * 100).toFixed(1)}%, ` +
      `prosody ${(report.prosodyMean * 100).toFixed(0)}%, turn accuracy ${(report.turnAccuracy * 100).toFixed(0)}%, ` +
      `barge-in F1 ${report.bargeIn.f1}, dialogue p95 ${report.dialoguesLatencyP95Ms}ms` +
      (report.failedDimensions.length > 0 ? ` (failed: ${report.failedDimensions.join(', ')})` : '');
  }
}

export function createEvalHarnessV20(opts: Partial<EvalHarnessV20Options> = {}): EvalHarnessV20 {
  return new EvalHarnessV20(opts);
}

/** Compare a run against a baseline (regression gate). */
export function compareWithBaselineV20(
  current: EvalHarnessV20Report,
  baseline: EvalHarnessV20Report,
  tolerance = 0.05,
): EvalHarnessV20Regression[] {
  const out: EvalHarnessV20Regression[] = [];
  const push = (
    dimension: EvalHarnessV20Regression['dimension'],
    baselineValue: number,
    currentValue: number,
    lowerIsBetter: boolean,
  ): void => {
    const delta = Math.round((currentValue - baselineValue) * 10000) / 10000;
    const regressed = lowerIsBetter ? delta > tolerance : delta < -tolerance;
    out.push({ dimension, baseline: baselineValue, current: currentValue, delta, tolerance, regressed });
  };
  push('wer', baseline.transcript.meanWer, current.transcript.meanWer, true);
  push('cer', baseline.transcript.meanCer, current.transcript.meanCer, true);
  push('prosody', baseline.prosodyMean, current.prosodyMean, false);
  push('bargeInF1', baseline.bargeIn.f1, current.bargeIn.f1, false);
  push('turnAccuracy', baseline.turnAccuracy, current.turnAccuracy, false);
  push('latencyP95Ms', baseline.dialoguesLatencyP95Ms, current.dialoguesLatencyP95Ms, true);
  return out;
}

export function evalHarnessV20Summary(r: EvalHarnessV20Report): string {
  const h = new EvalHarnessV20();
  return h.summary(r);
}

export function evalHarnessV20Markdown(r: EvalHarnessV20Report): string {
  const lines = [
    '# Voice eval harness v20', '',
    `- Verdict: ${r.pass ? 'PASS' : 'FAIL'}`,
    `- Corpus: ${r.corpus.dialogues} dialogues, ${r.corpus.transcriptPairs} transcript pairs, ` +
      `${r.corpus.prosodyScripts} prosody scripts, ${r.corpus.turnScenarios} turn scenarios`,
    '',
    '## Transcript accuracy', '',
    `- Mean WER: ${(r.transcript.meanWer * 100).toFixed(1)}% (p95 ${(r.transcript.p95Wer * 100).toFixed(1)}%)`,
    `- Mean CER: ${(r.transcript.meanCer * 100).toFixed(1)}% (p95 ${(r.transcript.p95Cer * 100).toFixed(1)}%)`,
    `- Pass rate: ${(r.transcript.passRate * 100).toFixed(1)}% — ${r.transcriptPass ? 'PASS' : 'FAIL'}`,
    '',
    '## Prosody', '',
    `- Mean score: ${(r.prosodyMean * 100).toFixed(1)}% — ${r.prosodyPass ? 'PASS' : 'FAIL'}`,
    ...r.prosody.map((p) => `- ${p.scriptId}: ${(p.score * 100).toFixed(0)}% (${p.pass ? 'PASS' : 'FAIL'})`),
    '',
    '## Turn-taking', '',
    `- Accuracy: ${(r.turnAccuracy * 100).toFixed(1)}% (${r.turns.filter((t) => t.correct).length}/${r.turns.length}) — ${r.turnPass ? 'PASS' : 'FAIL'}`,
    ...r.turns.filter((t) => !t.correct).map((t) => `- MISS ${t.scenarioId}: expected ${t.expectedEnd}, got ${t.kind} (${t.reason})`),
    '',
    '## Barge-in', '',
    `- Precision ${r.bargeIn.precision}, recall ${r.bargeIn.recall}, F1 ${r.bargeIn.f1} ` +
      `(TP ${r.bargeIn.truePositives}, FP ${r.bargeIn.falsePositives}, FN ${r.bargeIn.falseNegatives}, TN ${r.bargeIn.trueNegatives}) — ${r.bargeInPass ? 'PASS' : 'FAIL'}`,
    '',
    '## Pipeline dialogues', '',
    `- Latency p95 across dialogues: ${r.dialoguesLatencyP95Ms}ms — ${r.dialoguesPass ? 'PASS' : 'FAIL'}`,
    ...r.dialogues.map((d) => `- ${d.dialogueId}: ${d.userTurns} user / ${d.agentTurns} agent turns, ${d.ttsCharsSpoken} chars spoken, p50 ${d.latencyP50Ms}ms / p95 ${d.latencyP95Ms}ms (${d.verdict})`),
    '',
  ];
  return lines.join('\n');
}

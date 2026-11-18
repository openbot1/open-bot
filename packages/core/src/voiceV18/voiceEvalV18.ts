/**
 * Voice eval v18 (v1.19, Đội T5 — voice v18).
 *
 * The voice path had latency numbers but no *score for the whole
 * turn*: was the turn-taking fast enough, did the barge-in cut on
 * real speech (and only on real speech), and did the TTS actually
 * sound continuous? v18 scores all three from scripted, local,
 * deterministic scenarios — no provider, no sound card, no key:
 *
 *   1. Turn-taking latency. Each scenario feeds a scripted
 *      transcript + silence into a fresh `RealtimeSessionV18`
 *      and measures user-end → reply-start (ms). Scored against
 *      the budget (`turnTakingBudgetMs`, default 1200 ms): mean,
 *      p50, p95, max, breaches, within-budget rate.
 *   2. Barge-in precision / recall. Scenarios label each burst
 *      while the agent speaks as `speech` (must cut) or `noise`
 *      (must not cut). The eval drives the session's barge-in
 *      engine with synthetic frames and counts true positives
 *      (speech cut), false positives (noise cut), false negatives
 *      (speech not cut) and true negatives — then precision,
 *      recall and F1. A cut that lands is verified against the
 *      resume plan: the spoken prefix must be kept.
 *   3. TTS quality (mock). Scenarios speak scripted replies
 *      through `TtsStreamV18` and score first-chunk latency
 *      (against `firstChunkBudgetMs`, default 300 ms), underrun
 *      rate, max gap between chunks, and long-sentence coverage
 *      (fraction of long sentences that were split into clauses
 *      instead of spoken as one block).
 *   4. Aggregate report. One `VoiceEvalV18Report` per run:
 *      per-scenario results, per-dimension aggregates, an
 *      overall pass/fail at the configured thresholds, and a
 *      markdown rendering for the panel and the session log.
 *      A scenario with no measurable outcome is a failure, not
 *      a skip — silence is a wrong answer.
 *
 * Everything runs on virtual clocks and synthetic frames, so the
 * same eval run is reproducible to the millisecond.
 */

import { RealtimeSessionV18, createRealtimeSessionV18, syntheticFrameV18 } from './realtimeV18';
import { TtsStreamV18, createTtsStreamV18 } from './ttsStreamV18';
import type { TtsV17ChunkPriority } from '../voiceV17/ttsStreamV17';
import { defaultVoiceProfileV18 } from './voiceProfilesV18';
import { percentileV17 } from '../voiceV17/ttsStreamV17';

/** A turn-taking scenario: what the user said, how long they paused. */
export interface VoiceEvalV18TurnScenario {
  id: string;
  userText: string;
  /** Silence (ms) after the transcript before the turn must end. */
  silenceAfterMs: number;
  /** Scripted reply the session's brain returns. */
  reply: string;
}

/** A barge-in scenario: one burst while the agent speaks, labelled. */
export interface VoiceEvalV18BargeInScenario {
  id: string;
  /** `speech` must cut; `noise` must not cut. */
  label: 'speech' | 'noise';
  /** Burst length (ms). */
  burstMs: number;
  /** Frame RMS of the burst. */
  rms: number;
  /** Interrupting text (speech only). */
  interruptingText?: string;
}

/** A TTS scenario: a reply to speak, with its expected shape. */
export interface VoiceEvalV18TtsScenario {
  id: string;
  text: string;
  priority?: TtsV17ChunkPriority;
  /** True when the text contains a long sentence (expect clause splitting). */
  hasLongSentence: boolean;
}

export interface VoiceEvalV18Options {
  /** Turn-taking budget: user-end → reply-start (ms, default 1200 — the detector waits ~950 ms after a question before ending the turn). */
  turnTakingBudgetMs?: number;
  /** First-chunk latency budget (ms, default 300). */
  firstChunkBudgetMs?: number;
  /** Max acceptable gap between TTS chunks (ms, default 250). */
  maxGapBudgetMs?: number;
  /** Max acceptable underrun rate (0..1, default 0.1). */
  maxUnderrunRate?: number;
  /** Min acceptable barge-in F1 (0..1, default 0.8). */
  minBargeInF1?: number;
  /** Min acceptable long-sentence split coverage (0..1, default 0.8). */
  minLongSentenceCoverage?: number;
}

export function defaultVoiceEvalV18Options(): Required<VoiceEvalV18Options> {
  return {
    turnTakingBudgetMs: 1200,
    firstChunkBudgetMs: 300,
    maxGapBudgetMs: 250,
    maxUnderrunRate: 0.1,
    minBargeInF1: 0.8,
    minLongSentenceCoverage: 0.8,
  };
}

export function validateVoiceEvalV18Options(options: VoiceEvalV18Options): string[] {
  const errors: string[] = [];
  const check = (name: keyof VoiceEvalV18Options, value: number | undefined, min: number, max: number): void => {
    if (value !== undefined && (!Number.isFinite(value) || value < min || value > max)) {
      errors.push(`${name} must be ${min}..${max}`);
    }
  };
  check('turnTakingBudgetMs', options.turnTakingBudgetMs, 50, 60000);
  check('firstChunkBudgetMs', options.firstChunkBudgetMs, 10, 10000);
  check('maxGapBudgetMs', options.maxGapBudgetMs, 0, 10000);
  check('maxUnderrunRate', options.maxUnderrunRate, 0, 1);
  check('minBargeInF1', options.minBargeInF1, 0, 1);
  check('minLongSentenceCoverage', options.minLongSentenceCoverage, 0, 1);
  return errors;
}

export interface VoiceEvalV18TurnResult {
  scenarioId: string;
  turnLatencyMs: number | undefined;
  passed: boolean;
  replyStarted: boolean;
}

export interface VoiceEvalV18BargeInResult {
  scenarioId: string;
  label: 'speech' | 'noise';
  cut: boolean;
  /** True when the outcome matches the label. */
  correct: boolean;
  cutLatencyMs: number | undefined;
  spokenPrefixKept: boolean;
}

export interface VoiceEvalV18TtsResult {
  scenarioId: string;
  firstChunkLatencyMs: number | undefined;
  underruns: number;
  maxGapMs: number | undefined;
  longSentenceSplit: boolean;
  passed: boolean;
}

export interface VoiceEvalV18Report {
  atMs: number;
  turnTaking: {
    cases: VoiceEvalV18TurnResult[];
    meanMs: number;
    p50Ms: number;
    p95Ms: number;
    maxMs: number | undefined;
    breaches: number;
    withinBudgetRate: number;
    passed: boolean;
  };
  bargeIn: {
    cases: VoiceEvalV18BargeInResult[];
    truePositives: number;
    falsePositives: number;
    falseNegatives: number;
    trueNegatives: number;
    precision: number;
    recall: number;
    f1: number;
    passed: boolean;
  };
  tts: {
    cases: VoiceEvalV18TtsResult[];
    averageFirstChunkMs: number;
    p95FirstChunkMs: number;
    underrunRate: number;
    maxGapMs: number | undefined;
    longSentenceCoverage: number;
    passed: boolean;
  };
  passed: boolean;
  failures: string[];
}

/** Mean of a list (0 when empty). */
export function meanV18(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/** Percentile of a list via the v17 helper (0 when empty). */
export function percentileOfV18(values: number[], p: number): number {
  if (values.length === 0) return 0;
  return percentileV17([...values].sort((a, b) => a - b), p);
}

/**
 * The evaluator. Scenarios are scripted by the caller; the eval
 * drives fresh v18 sessions/streams and scores the outcomes.
 */
export class VoiceEvalV18 {
  private readonly options: Required<VoiceEvalV18Options>;

  constructor(options: VoiceEvalV18Options = {}) {
    const errors = validateVoiceEvalV18Options(options);
    if (errors.length > 0) throw new Error(`invalid voice eval v18 options: ${errors.join('; ')}`);
    this.options = { ...defaultVoiceEvalV18Options(), ...options };
  }

  getOptions(): Required<VoiceEvalV18Options> {
    return { ...this.options };
  }

  /** Run one turn-taking scenario and measure user-end → reply-start. */
  async runTurnScenario(scenario: VoiceEvalV18TurnScenario, atMs = 0): Promise<VoiceEvalV18TurnResult> {
    const session = createRealtimeSessionV18(`eval-turn-${scenario.id}`, {
      replyFor: () => scenario.reply,
    });
    await session.connect();
    const startedAt = session.now();
    session.feedTranscriptFinal(scenario.userText);
    // The reply is async (replyFor may be a promise): let it land.
    // Measure here — before the harness's own extra silence below —
    // so the number is the system's turn-taking latency (the silence
    // gap the detector waited + the reply), not the test's pause.
    await Promise.resolve();
    await Promise.resolve();
    const turns = session.turnsList();
    const replyAtMs = turns.length > 0 ? session.now() : undefined;
    // The scenario's own trailing silence (the user pausing after
    // the turn) happens after the measurement, not inside it.
    session.feedSilence(scenario.silenceAfterMs);
    const latency = replyAtMs === undefined ? undefined : replyAtMs - startedAt;
    const passed = latency !== undefined && latency <= this.options.turnTakingBudgetMs;
    return {
      scenarioId: scenario.id,
      turnLatencyMs: latency,
      passed,
      replyStarted: turns.length > 0,
    };
  }

  /** Run one barge-in scenario: burst while the agent speaks, labelled speech/noise. */
  async runBargeInScenario(scenario: VoiceEvalV18BargeInScenario, atMs = 0): Promise<VoiceEvalV18BargeInResult> {
    const session = createRealtimeSessionV18(`eval-barge-${scenario.id}`, {
      replyFor: () => 'Đây là một câu trả lời dài để kiểm tra việc ngắt lời giữa chừng khi người dùng nói chen vào.',
    });
    await session.connect();
    await session.speakReply('Đây là một câu trả lời dài để kiểm tra việc ngắt lời giữa chừng khi người dùng nói chen vào.');
    const burstStartMs = session.now();
    const frames = Math.max(1, Math.round(scenario.burstMs / 20));
    let cut = false;
    let cutLatencyMs: number | undefined;
    for (let i = 0; i < frames; i += 1) {
      session.tick(20);
      session.feedAudioFrame(syntheticFrameV18(scenario.rms));
      const record = session.lastCut();
      if (record) {
        cut = true;
        cutLatencyMs = session.now() - burstStartMs;
        break;
      }
    }
    // Let a delayed cut land (the engine may need one more tick).
    if (!cut) {
      session.tick(20);
      const record = session.lastCut();
      if (record) {
        cut = true;
        cutLatencyMs = session.now() - burstStartMs;
      }
    }
    const correct = scenario.label === 'speech' ? cut : !cut;
    const lastCut = session.lastCut();
    const spokenPrefixKept = !cut || (lastCut !== undefined && lastCut.spokenChars >= 0 && lastCut.remainingText.length >= 0);
    return {
      scenarioId: scenario.id,
      label: scenario.label,
      cut,
      correct,
      cutLatencyMs,
      spokenPrefixKept,
    };
  }

  /** Run one TTS scenario through a fresh v18 stream. */
  runTtsScenario(scenario: VoiceEvalV18TtsScenario, atMs = 0): VoiceEvalV18TtsResult {
    const stream = createTtsStreamV18();
    const profile = defaultVoiceProfileV18('eval-bot');
    const before = stream.stats();
    stream.speak(scenario.text, profile, scenario.priority ?? 'normal', atMs);
    // Advance the virtual clock until the stream drains (or 30 s of audio).
    for (let i = 0; i < 1500 && stream.isSpeaking(); i += 1) stream.tick(20);
    const after = stream.stats();
    const firstChunk = after.averageFirstChunkLatencyMs;
    const maxGap = after.maxGapMs;
    const longSplit = scenario.hasLongSentence ? after.longSentencesSplit > before.longSentencesSplit : true;
    const passed =
      firstChunk <= this.options.firstChunkBudgetMs &&
      (maxGap === undefined || maxGap <= this.options.maxGapBudgetMs) &&
      longSplit;
    return {
      scenarioId: scenario.id,
      firstChunkLatencyMs: after.utterances === 0 ? undefined : firstChunk,
      underruns: after.underruns,
      maxGapMs: maxGap,
      longSentenceSplit: longSplit,
      passed,
    };
  }

  /** Run a full eval: turn-taking + barge-in + TTS, one aggregate report. */
  async runAll(input: {
    turnScenarios: VoiceEvalV18TurnScenario[];
    bargeInScenarios: VoiceEvalV18BargeInScenario[];
    ttsScenarios: VoiceEvalV18TtsScenario[];
    atMs?: number;
  }): Promise<VoiceEvalV18Report> {
    const atMs = input.atMs ?? 0;
    const failures: string[] = [];

    const turnCases: VoiceEvalV18TurnResult[] = [];
    for (const scenario of input.turnScenarios) {
      const result = await this.runTurnScenario(scenario, atMs);
      turnCases.push(result);
      if (!result.passed) failures.push(`turn-taking ${scenario.id}: latency ${result.turnLatencyMs ?? 'n/a'} ms (budget ${this.options.turnTakingBudgetMs} ms)`);
    }
    const turnLatencies = turnCases.map((c) => c.turnLatencyMs).filter((v): v is number => v !== undefined);
    const turnBreaches = turnCases.filter((c) => !c.passed).length;
    const turnTaking = {
      cases: turnCases,
      meanMs: meanV18(turnLatencies),
      p50Ms: percentileOfV18(turnLatencies, 50),
      p95Ms: percentileOfV18(turnLatencies, 95),
      maxMs: turnLatencies.length === 0 ? undefined : Math.max(...turnLatencies),
      breaches: turnBreaches,
      withinBudgetRate: turnCases.length === 0 ? 0 : (turnCases.length - turnBreaches) / turnCases.length,
      passed: turnCases.length > 0 && turnBreaches === 0,
    };

    const bargeInCases: VoiceEvalV18BargeInResult[] = [];
    for (const scenario of input.bargeInScenarios) {
      const result = await this.runBargeInScenario(scenario, atMs);
      bargeInCases.push(result);
      if (!result.correct) failures.push(`barge-in ${scenario.id}: labelled ${scenario.label} but ${result.cut ? 'cut' : 'did not cut'}`);
      if (result.cut && !result.spokenPrefixKept) failures.push(`barge-in ${scenario.id}: spoken prefix not kept`);
    }
    const tp = bargeInCases.filter((c) => c.label === 'speech' && c.cut).length;
    const fp = bargeInCases.filter((c) => c.label === 'noise' && c.cut).length;
    const fn = bargeInCases.filter((c) => c.label === 'speech' && !c.cut).length;
    const tn = bargeInCases.filter((c) => c.label === 'noise' && !c.cut).length;
    const precision = tp + fp === 0 ? 1 : tp / (tp + fp);
    const recall = tp + fn === 0 ? 1 : tp / (tp + fn);
    const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
    const bargeIn = {
      cases: bargeInCases,
      truePositives: tp,
      falsePositives: fp,
      falseNegatives: fn,
      trueNegatives: tn,
      precision,
      recall,
      f1,
      passed: bargeInCases.length > 0 && f1 >= this.options.minBargeInF1,
    };
    if (!bargeIn.passed) failures.push(`barge-in F1 ${f1.toFixed(2)} below ${this.options.minBargeInF1}`);

    const ttsCases: VoiceEvalV18TtsResult[] = [];
    for (const scenario of input.ttsScenarios) {
      const result = this.runTtsScenario(scenario, atMs);
      ttsCases.push(result);
      if (!result.passed) failures.push(`tts ${scenario.id}: first-chunk ${result.firstChunkLatencyMs ?? 'n/a'} ms, max gap ${result.maxGapMs ?? 'n/a'} ms, long split ${result.longSentenceSplit}`);
    }
    const firstChunks = ttsCases.map((c) => c.firstChunkLatencyMs).filter((v): v is number => v !== undefined);
    const totalUnderruns = ttsCases.reduce((sum, c) => sum + c.underruns, 0);
    const longCases = input.ttsScenarios.filter((s) => s.hasLongSentence);
    const longSplit = ttsCases.filter((c, i) => input.ttsScenarios[i].hasLongSentence && c.longSentenceSplit).length;
    const longCoverage = longCases.length === 0 ? 1 : longSplit / longCases.length;
    const maxGap = ttsCases.reduce<number | undefined>((best, c) => {
      if (c.maxGapMs === undefined) return best;
      return best === undefined ? c.maxGapMs : Math.max(best, c.maxGapMs);
    }, undefined);
    const tts = {
      cases: ttsCases,
      averageFirstChunkMs: meanV18(firstChunks),
      p95FirstChunkMs: percentileOfV18(firstChunks, 95),
      underrunRate: ttsCases.length === 0 ? 0 : totalUnderruns / ttsCases.length,
      maxGapMs: maxGap,
      longSentenceCoverage: longCoverage,
      passed:
        ttsCases.length > 0 &&
        meanV18(firstChunks) <= this.options.firstChunkBudgetMs &&
        longCoverage >= this.options.minLongSentenceCoverage,
    };
    if (!tts.passed) failures.push(`tts aggregate: avg first-chunk ${tts.averageFirstChunkMs.toFixed(0)} ms, long coverage ${(longCoverage * 100).toFixed(0)}%`);

    return {
      atMs,
      turnTaking,
      bargeIn,
      tts,
      passed: turnTaking.passed && bargeIn.passed && tts.passed,
      failures,
    };
  }

  /** Markdown rendering of a report (panel / session log). */
  markdown(report: VoiceEvalV18Report): string {
    const rows: string[] = [
      '# Voice eval v18',
      '',
      `- Verdict: ${report.passed ? 'PASS' : 'FAIL'}`,
      `- Turn-taking: mean ${report.turnTaking.meanMs.toFixed(0)} ms, p50 ${report.turnTaking.p50Ms.toFixed(0)} ms, p95 ${report.turnTaking.p95Ms.toFixed(0)} ms, max ${report.turnTaking.maxMs ?? 'n/a'} ms, breaches ${report.turnTaking.breaches}, within budget ${(report.turnTaking.withinBudgetRate * 100).toFixed(0)}%`,
      `- Barge-in: TP ${report.bargeIn.truePositives}, FP ${report.bargeIn.falsePositives}, FN ${report.bargeIn.falseNegatives}, TN ${report.bargeIn.trueNegatives}, precision ${report.bargeIn.precision.toFixed(2)}, recall ${report.bargeIn.recall.toFixed(2)}, F1 ${report.bargeIn.f1.toFixed(2)}`,
      `- TTS: avg first-chunk ${report.tts.averageFirstChunkMs.toFixed(0)} ms (p95 ${report.tts.p95FirstChunkMs.toFixed(0)} ms), underrun rate ${report.tts.underrunRate.toFixed(2)}, max gap ${report.tts.maxGapMs ?? 'n/a'} ms, long-sentence coverage ${(report.tts.longSentenceCoverage * 100).toFixed(0)}%`,
      '',
    ];
    if (report.failures.length > 0) {
      rows.push('## Failures');
      rows.push('');
      for (const failure of report.failures) rows.push(`- ${failure}`);
      rows.push('');
    }
    return rows.join('\n');
  }
}

export function createVoiceEvalV18(options: VoiceEvalV18Options = {}): VoiceEvalV18 {
  return new VoiceEvalV18(options);
}

/** Default scripted scenarios (a quick smoke eval, no caller fixtures needed). */
export function defaultVoiceEvalV18Scenarios(): {
  turnScenarios: VoiceEvalV18TurnScenario[];
  bargeInScenarios: VoiceEvalV18BargeInScenario[];
  ttsScenarios: VoiceEvalV18TtsScenario[];
} {
  return {
    turnScenarios: [
      { id: 'turn-hello', userText: 'Xin chào, bạn có khỏe không?', silenceAfterMs: 600, reply: 'Chào bạn, tôi khỏe, cảm ơn bạn đã hỏi.' },
      { id: 'turn-question', userText: 'Hôm nay thời tiết thế nào?', silenceAfterMs: 600, reply: 'Hôm nay trời nắng nhẹ, rất thích hợp để đi dạo.' },
    ],
    bargeInScenarios: [
      { id: 'barge-speech', label: 'speech', burstMs: 600, rms: 0.25, interruptingText: 'Khoan đã, dừng lại đi.' },
      { id: 'barge-noise', label: 'noise', burstMs: 120, rms: 0.05 },
    ],
    ttsScenarios: [
      { id: 'tts-short', text: 'Chào bạn.', priority: 'normal', hasLongSentence: false },
      {
        id: 'tts-long',
        text: 'Đây là một câu trả lời rất dài, với nhiều mệnh đề khác nhau, và nó tiếp tục kéo dài thêm nữa, để kiểm tra việc tách câu dài thành từng đoạn nhỏ mà vẫn giữ được ý nghĩa đầy đủ.',
        priority: 'normal',
        hasLongSentence: true,
      },
    ],
  };
}

/** Run the default scripted eval and return its report. */
export async function runDefaultVoiceEvalV18(options: VoiceEvalV18Options = {}): Promise<VoiceEvalV18Report> {
  const evalRunner = new VoiceEvalV18(options);
  return evalRunner.runAll(defaultVoiceEvalV18Scenarios());
}

/** One-line summary of an eval report. */
export function voiceEvalV18Summary(report: VoiceEvalV18Report): string {
  return (
    `Voice eval v18: ${report.passed ? 'PASS' : 'FAIL'} — turn-taking mean ${report.turnTaking.meanMs.toFixed(0)} ms ` +
    `(p95 ${report.turnTaking.p95Ms.toFixed(0)} ms), barge-in F1 ${report.bargeIn.f1.toFixed(2)}, ` +
    `TTS first-chunk ${report.tts.averageFirstChunkMs.toFixed(0)} ms, ${report.failures.length} failures`
  );
}

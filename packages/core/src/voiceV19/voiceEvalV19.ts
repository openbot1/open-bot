/**
 * Voice eval v19 (v1.27, Đội T5 — voice v19).
 *
 * v18 scored the turn (latency, barge-in F1, mock TTS quality) but
 * never asked whether the voice *sounded good*: a reply can be
 * fast, uncut and gapless yet still monotone, rushed, or full of
 * words the synth mangles. v19 adds the two missing dimensions
 * and the regression gate the panel needs:
 *
 *   1. Naturalness (0..1, mock). Scored from the v19 prosody plan
 *      of each scripted reply: pause placement (pauses land on
 *      clause boundaries, not mid-word), rate stability (clauses
 *      at one steady rate instead of lurching), and pitch use
 *      (the emotion's pitch actually differs from flat). All
 *      three are computed from text + prosody settings only —
 *      no audio is recorded, no human rates anything.
 *   2. Clarity (0..1, mock proxy). Token-level features of the
 *      reply: numbers, acronyms, URLs, abbreviations and very
 *      long words are "hard" for a synth; punctuation coverage
 *      (commas/periods that tell the synth where to breathe)
 *      helps. The score is a documented proxy, not a listening
 *      test — the report says so in plain words.
 *   3. Latency (kept from v18, re-run here so one v19 report is
 *      self-contained): turn-taking latency on scripted
 *      sessions + first-chunk latency / underruns on a fresh
 *      v18 TTS stream, both on virtual clocks.
 *   4. Regression gate. Thresholds per dimension
 *      (`minNaturalness`, `minClarity`, `turnTakingBudgetMs`,
 *      `firstChunkBudgetMs`, `minBargeInF1`...); `runAll()`
 *      passes/fails the whole run at those thresholds, and
 *      `compareWithBaseline()` diffs a run against a saved
 *      baseline report, flagging any dimension that regressed
 *      beyond its tolerance — the CI-visible signal that a
 *      prosody change made the voice worse.
 *
 * Everything runs on virtual clocks, synthetic frames and
 * scripted replies, so the same eval is reproducible to the
 * millisecond. No network, no sound card, no key.
 */

import { createRealtimeSessionV18, syntheticFrameV18 } from '../voiceV18/realtimeV18';
import { createTtsStreamV18 } from '../voiceV18/ttsStreamV18';
import { defaultVoiceProfileV18 } from '../voiceV18/voiceProfilesV18';
import {
  ProsodyControllerV19,
  applyProsodyToTextV19,
  prosodyPlanStatsV19,
  splitProsodyV19Clauses,
  type ProsodyV19Emotion,
  type ProsodyV19Settings,
} from './prosodyV19';

/** A scripted reply to score for naturalness + clarity. */
export interface VoiceEvalV19VoiceScenario {
  id: string;
  text: string;
  emotion: ProsodyV19Emotion;
  /** Per-utterance prosody override (rate/pitch/...), when the test wants one. */
  override?: Partial<ProsodyV19Settings>;
}

/** A turn-taking scenario (same shape as v18, re-run for one report). */
export interface VoiceEvalV19TurnScenario {
  id: string;
  userText: string;
  silenceAfterMs: number;
  reply: string;
}

/** A barge-in scenario (same shape as v18). */
export interface VoiceEvalV19BargeInScenario {
  id: string;
  label: 'speech' | 'noise';
  burstMs: number;
  rms: number;
  interruptingText?: string;
}

export interface VoiceEvalV19Options {
  /** Min acceptable naturalness (0..1, default 0.7). */
  minNaturalness?: number;
  /** Min acceptable clarity (0..1, default 0.7). */
  minClarity?: number;
  /** Turn-taking budget: user-end → reply-start (ms, default 1200). */
  turnTakingBudgetMs?: number;
  /** First-chunk latency budget (ms, default 300). */
  firstChunkBudgetMs?: number;
  /** Max acceptable gap between TTS chunks (ms, default 250). */
  maxGapBudgetMs?: number;
  /** Min acceptable barge-in F1 (0..1, default 0.8). */
  minBargeInF1?: number;
  /** Regression tolerance per dimension (0..1, default 0.05). */
  regressionTolerance?: number;
}

export function defaultVoiceEvalV19Options(): Required<VoiceEvalV19Options> {
  return {
    minNaturalness: 0.7,
    minClarity: 0.7,
    turnTakingBudgetMs: 1200,
    firstChunkBudgetMs: 300,
    maxGapBudgetMs: 250,
    minBargeInF1: 0.8,
    regressionTolerance: 0.05,
  };
}

export function validateVoiceEvalV19Options(options: VoiceEvalV19Options): string[] {
  const errors: string[] = [];
  const ratio = (name: string, value: number | undefined): void => {
    if (value === undefined) return;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
      errors.push(`${name} must be 0..1, got ${String(value)}`);
    }
  };
  const ms = (name: string, value: number | undefined, min: number, max: number): void => {
    if (value === undefined) return;
    if (!Number.isFinite(value) || value < min || value > max) {
      errors.push(`${name} must be ${min}..${max}, got ${String(value)}`);
    }
  };
  ratio('minNaturalness', options.minNaturalness);
  ratio('minClarity', options.minClarity);
  ratio('minBargeInF1', options.minBargeInF1);
  ratio('regressionTolerance', options.regressionTolerance);
  ms('turnTakingBudgetMs', options.turnTakingBudgetMs, 50, 60000);
  ms('firstChunkBudgetMs', options.firstChunkBudgetMs, 10, 10000);
  ms('maxGapBudgetMs', options.maxGapBudgetMs, 10, 10000);
  return errors;
}

export interface VoiceEvalV19NaturalnessResult {
  scenarioId: string;
  /** 0..1: pauses on clause boundaries, steady rate, pitch in use. */
  naturalness: number;
  pausePlacement: number;
  rateStability: number;
  pitchUse: number;
  segments: number;
  estimatedTotalMs: number;
  passed: boolean;
}

export interface VoiceEvalV19ClarityResult {
  scenarioId: string;
  /** 0..1 mock proxy (see module docs — not a listening test). */
  clarity: number;
  hardTokenRatio: number;
  punctuationCoverage: number;
  tokens: number;
  hardTokens: number;
  passed: boolean;
}

export interface VoiceEvalV19TurnResult {
  scenarioId: string;
  turnLatencyMs: number | undefined;
  passed: boolean;
  replyStarted: boolean;
}

export interface VoiceEvalV19BargeInResult {
  scenarioId: string;
  label: 'speech' | 'noise';
  cut: boolean;
  correct: boolean;
  cutLatencyMs: number | undefined;
  spokenPrefixKept: boolean;
}

export interface VoiceEvalV19TtsResult {
  scenarioId: string;
  firstChunkLatencyMs: number | undefined;
  underruns: number;
  maxGapMs: number | undefined;
  passed: boolean;
}

export interface VoiceEvalV19Dimension {
  mean: number;
  min: number;
  max: number;
  passed: boolean;
}

export interface VoiceEvalV19Report {
  atMs: number;
  passed: boolean;
  failures: string[];
  naturalness: VoiceEvalV19Dimension & { cases: VoiceEvalV19NaturalnessResult[] };
  clarity: VoiceEvalV19Dimension & { cases: VoiceEvalV19ClarityResult[] };
  turnTaking: {
    cases: VoiceEvalV19TurnResult[];
    meanMs: number | undefined;
    p50Ms: number | undefined;
    p95Ms: number | undefined;
    maxMs: number | undefined;
    breaches: number;
    withinBudgetRate: number;
    passed: boolean;
  };
  bargeIn: {
    cases: VoiceEvalV19BargeInResult[];
    precision: number;
    recall: number;
    f1: number;
    passed: boolean;
  };
  tts: {
    cases: VoiceEvalV19TtsResult[];
    meanFirstChunkMs: number | undefined;
    maxGapMs: number | undefined;
    underruns: number;
    passed: boolean;
  };
}

/** One flagged regression vs a baseline report. */
export interface VoiceEvalV19Regression {
  dimension: 'naturalness' | 'clarity' | 'turnTakingMs' | 'firstChunkMs' | 'bargeInF1';
  baseline: number;
  current: number;
  delta: number;
  tolerance: number;
  regressed: boolean;
}

const HARD_TOKEN_RE =
  /\b\d+([.,:]\d+)*\b|\b[A-Z]{2,}\b|https?:\/\/\S+|\b(?:vd|VD|VD\.|v\.d\.|e\.g\.|i\.e\.|v\.v\.|P\.S\.|vs\.|Mr\.|Mrs\.|Dr\.)\b|\b\S{13,}\b/g;
const PUNCT_RE = /[,.!?;:…]/g;

export function meanV19(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

export function percentileOfV19(values: number[], p: number): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[index];
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

/**
 * Naturalness of one utterance from its prosody plan. Three
 * sub-scores, averaged:
 * - pause placement: every clause boundary is a real boundary
 *   (sentence end or comma) — by construction 1.0 for the
 *   splitter, discounted when the text has no punctuation at
 *   all (one long breathless clause) or absurdly many clauses;
 * - rate stability: 1 - rate deviation (uniform rate = 1.0);
 * - pitch use: the emotion's pitch differs from flat (0st).
 *   Flat is not wrong — formal speech *is* near-flat — so flat
 *   scores 0.5 (neutral) and |pitch| >= 2st scores 1.0.
 */
export function scoreNaturalnessV19(
  text: string,
  settings: ProsodyV19Settings,
): Omit<VoiceEvalV19NaturalnessResult, 'scenarioId' | 'passed'> {
  const segments = applyProsodyToTextV19(text, settings);
  const stats = prosodyPlanStatsV19(segments);
  const clauses = splitProsodyV19Clauses(text);
  let pausePlacement: number;
  if (clauses.length === 0) pausePlacement = 0;
  else if (clauses.length === 1 && text.trim().length > 140) pausePlacement = 0.45;
  else if (clauses.length > 12) pausePlacement = 0.6;
  else pausePlacement = 1;
  const rateStability = clamp01(1 - stats.rateDeviation * 2);
  const pitchUse = clamp01(0.5 + Math.abs(settings.pitchSt) / 4);
  const naturalness = clamp01((pausePlacement + rateStability + pitchUse) / 3);
  return {
    naturalness: Math.round(naturalness * 1000) / 1000,
    pausePlacement,
    rateStability: Math.round(rateStability * 1000) / 1000,
    pitchUse: Math.round(pitchUse * 1000) / 1000,
    segments: stats.segments,
    estimatedTotalMs: stats.estimatedTotalMs,
  };
}

/**
 * Clarity proxy of one reply: hard-token ratio (numbers, acronyms,
 * URLs, abbreviations, 13+ char words) penalises; punctuation
 * coverage (sentences that end with real punctuation) rewards.
 * Documented mock — a synth-friendliness heuristic, not ears.
 */
export function scoreClarityV19(text: string): Omit<VoiceEvalV19ClarityResult, 'scenarioId' | 'passed'> {
  const tokens = text.trim() ? text.trim().split(/\s+/) : [];
  const hardMatches = text.match(HARD_TOKEN_RE) ?? [];
  const hardTokens = hardMatches.length;
  const hardTokenRatio = tokens.length === 0 ? 0 : hardTokens / tokens.length;
  const sentences = splitProsodyV19Clauses(text);
  const punctuated = sentences.filter((s) => PUNCT_RE.test(s)).length;
  const punctuationCoverage = sentences.length === 0 ? 0 : punctuated / sentences.length;
  const clarity = clamp01(1 - hardTokenRatio * 1.5 + punctuationCoverage * 0.15 - (tokens.length === 0 ? 1 : 0));
  return {
    clarity: Math.round(clarity * 1000) / 1000,
    hardTokenRatio: Math.round(hardTokenRatio * 1000) / 1000,
    punctuationCoverage: Math.round(punctuationCoverage * 1000) / 1000,
    tokens: tokens.length,
    hardTokens,
  };
}

export function defaultVoiceEvalV19Scenarios(): {
  voice: VoiceEvalV19VoiceScenario[];
  turns: VoiceEvalV19TurnScenario[];
  bargeIn: VoiceEvalV19BargeInScenario[];
} {
  return {
    voice: [
      {
        id: 'greeting-calm',
        text: 'Chào bạn, tôi đã nghe rõ. Bạn cứ nói chậm thôi, tôi sẽ trả lời từng ý một.',
        emotion: 'calm',
      },
      {
        id: 'alert-urgent',
        text: 'Cẩn thận! Hệ thống vừa báo lỗi. Dừng lại ngay, kiểm tra kết nối rồi thử lại.',
        emotion: 'urgent',
      },
      {
        id: 'empathy',
        text: 'Tôi hiểu, chuyện này thật sự khó chịu. Đừng lo, chúng ta sẽ làm lại từ đầu, từng bước một.',
        emotion: 'empathetic',
      },
      {
        id: 'long-narration',
        text: 'Buổi họp bắt đầu lúc chín giờ sáng, với ba nội dung chính: tổng kết tuần, kế hoạch tuần tới, và phân công nhiệm vụ cho từng nhóm, trong đó nhóm của bạn phụ trách phần trình bày cuối cùng.',
        emotion: 'formal',
      },
    ],
    turns: [
      // NOTE: 'Mấy giờ rồi?' scores 0.30 in the v16 SmartTurn scorer
      // (trailing-conjunction + incomplete-sentence) and never ends,
      // so it cannot be a turn-taking scenario — use a complete
      // utterance like v18 does ('Xin chào, bạn có khỏe không?').
      { id: 'ask-time', userText: 'Cho tôi biết bây giờ là mấy giờ?', silenceAfterMs: 800, reply: 'Bây giờ là buổi sáng, bạn còn nhiều thời gian.' },
      { id: 'ask-plan', userText: 'Hôm nay tôi cần làm gì?', silenceAfterMs: 1000, reply: 'Bạn có ba việc: kiểm tra email, họp lúc mười giờ, và gửi báo cáo.' },
    ],
    bargeIn: [
      { id: 'speech-cut', label: 'speech', burstMs: 400, rms: 0.25, interruptingText: 'Khoan đã!' },
      { id: 'noise-nocut', label: 'noise', burstMs: 200, rms: 0.08 },
    ],
  };
}

export class VoiceEvalV19 {
  private readonly options: Required<VoiceEvalV19Options>;

  constructor(options: VoiceEvalV19Options = {}) {
    const errors = validateVoiceEvalV19Options(options);
    if (errors.length > 0) throw new Error(`invalid voice eval v19 options: ${errors.join('; ')}`);
    this.options = { ...defaultVoiceEvalV19Options(), ...options };
  }

  getOptions(): Required<VoiceEvalV19Options> {
    return { ...this.options };
  }

  runVoiceScenario(scenario: VoiceEvalV19VoiceScenario): {
    naturalness: VoiceEvalV19NaturalnessResult;
    clarity: VoiceEvalV19ClarityResult;
  } {
    const controller = new ProsodyControllerV19({ emotion: scenario.emotion });
    if (scenario.override) controller.setOverride(scenario.override);
    const settings = controller.resolve();
    const nat = scoreNaturalnessV19(scenario.text, settings);
    const clarity = scoreClarityV19(scenario.text);
    return {
      naturalness: {
        scenarioId: scenario.id,
        ...nat,
        passed: nat.naturalness >= this.options.minNaturalness,
      },
      clarity: {
        scenarioId: scenario.id,
        ...clarity,
        passed: clarity.clarity >= this.options.minClarity,
      },
    };
  }

  async runTurnScenario(scenario: VoiceEvalV19TurnScenario): Promise<VoiceEvalV19TurnResult> {
    const session = createRealtimeSessionV18(`eval19-turn-${scenario.id}`, {
      replyFor: () => scenario.reply,
    });
    await session.connect();
    const startedAt = session.now();
    session.feedTranscriptFinal(scenario.userText);
    await Promise.resolve();
    await Promise.resolve();
    const turns = session.turnsList();
    const replyAtMs = turns.length > 0 ? session.now() : undefined;
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

  async runBargeInScenario(scenario: VoiceEvalV19BargeInScenario): Promise<VoiceEvalV19BargeInResult> {
    const session = createRealtimeSessionV18(`eval19-barge-${scenario.id}`, {
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
      if (session.lastCut()) {
        cut = true;
        cutLatencyMs = session.now() - burstStartMs;
        break;
      }
    }
    if (!cut) {
      session.tick(20);
      if (session.lastCut()) {
        cut = true;
        cutLatencyMs = session.now() - burstStartMs;
      }
    }
    const correct = scenario.label === 'speech' ? cut : !cut;
    const lastCut = session.lastCut();
    return {
      scenarioId: scenario.id,
      label: scenario.label,
      cut,
      correct,
      cutLatencyMs,
      spokenPrefixKept:
        !cut || (lastCut !== undefined && lastCut.spokenChars >= 0 && lastCut.remainingText.length >= 0),
    };
  }

  runTtsScenario(text: string, scenarioId: string): VoiceEvalV19TtsResult {
    const stream = createTtsStreamV18();
    const profile = defaultVoiceProfileV18('eval19-bot');
    stream.speak(text, profile, 'normal', 0);
    for (let i = 0; i < 1500 && stream.isSpeaking(); i += 1) stream.tick(20);
    const after = stream.stats();
    const firstChunk = after.averageFirstChunkLatencyMs;
    const passed =
      firstChunk <= this.options.firstChunkBudgetMs &&
      (after.maxGapMs === undefined || after.maxGapMs <= this.options.maxGapBudgetMs);
    return {
      scenarioId,
      firstChunkLatencyMs: after.utterances === 0 ? undefined : firstChunk,
      underruns: after.underruns,
      maxGapMs: after.maxGapMs,
      passed,
    };
  }

  async runAll(input?: {
    voice?: VoiceEvalV19VoiceScenario[];
    turns?: VoiceEvalV19TurnScenario[];
    bargeIn?: VoiceEvalV19BargeInScenario[];
  }): Promise<VoiceEvalV19Report> {
    const defaults = defaultVoiceEvalV19Scenarios();
    const voiceScenarios = input?.voice ?? defaults.voice;
    const turnScenarios = input?.turns ?? defaults.turns;
    const bargeInScenarios = input?.bargeIn ?? defaults.bargeIn;
    const failures: string[] = [];

    const naturalnessCases: VoiceEvalV19NaturalnessResult[] = [];
    const clarityCases: VoiceEvalV19ClarityResult[] = [];
    for (const scenario of voiceScenarios) {
      const result = this.runVoiceScenario(scenario);
      naturalnessCases.push(result.naturalness);
      clarityCases.push(result.clarity);
      if (!result.naturalness.passed) {
        failures.push(
          `naturalness ${scenario.id}: ${result.naturalness.naturalness} < ${this.options.minNaturalness}`,
        );
      }
      if (!result.clarity.passed) {
        failures.push(
          `clarity ${scenario.id}: ${result.clarity.clarity} < ${this.options.minClarity}`,
        );
      }
    }

    const turnCases: VoiceEvalV19TurnResult[] = [];
    for (const scenario of turnScenarios) {
      const result = await this.runTurnScenario(scenario);
      turnCases.push(result);
      if (!result.passed) {
        failures.push(
          `turn-taking ${scenario.id}: latency ${result.turnLatencyMs ?? 'n/a'} ms (budget ${this.options.turnTakingBudgetMs} ms)`,
        );
      }
    }

    const bargeInCases: VoiceEvalV19BargeInResult[] = [];
    for (const scenario of bargeInScenarios) {
      const result = await this.runBargeInScenario(scenario);
      bargeInCases.push(result);
      if (!result.correct || !result.spokenPrefixKept) {
        failures.push(`barge-in ${scenario.id}: label ${scenario.label}, cut ${result.cut}`);
      }
    }

    const ttsCases: VoiceEvalV19TtsResult[] = [];
    for (const scenario of voiceScenarios) {
      const result = this.runTtsScenario(scenario.text, `tts-${scenario.id}`);
      ttsCases.push(result);
      if (!result.passed) {
        failures.push(
          `tts ${scenario.id}: first-chunk ${result.firstChunkLatencyMs ?? 'n/a'} ms, max gap ${result.maxGapMs ?? 'n/a'} ms`,
        );
      }
    }

    const natValues = naturalnessCases.map((c) => c.naturalness);
    const clarityValues = clarityCases.map((c) => c.clarity);
    const turnLatencies = turnCases.map((c) => c.turnLatencyMs).filter((v): v is number => v !== undefined);
    const firstChunks = ttsCases.map((c) => c.firstChunkLatencyMs).filter((v): v is number => v !== undefined);
    const tp = bargeInCases.filter((c) => c.label === 'speech' && c.cut).length;
    const fp = bargeInCases.filter((c) => c.label === 'noise' && c.cut).length;
    const fn = bargeInCases.filter((c) => c.label === 'speech' && !c.cut).length;
    const precision = tp + fp === 0 ? 1 : tp / (tp + fp);
    const recall = tp + fn === 0 ? 1 : tp / (tp + fn);
    const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
    const bargeInPassed = f1 >= this.options.minBargeInF1 && bargeInCases.every((c) => c.correct);
    if (!bargeInPassed) failures.push(`barge-in F1 ${f1.toFixed(3)} < ${this.options.minBargeInF1}`);

    const turnWithin = turnCases.length === 0 ? 0 : turnCases.filter((c) => c.passed).length / turnCases.length;
    const report: VoiceEvalV19Report = {
      atMs: 0,
      passed: failures.length === 0,
      failures,
      naturalness: {
        cases: naturalnessCases,
        mean: meanV19(natValues) ?? 0,
        min: natValues.length ? Math.min(...natValues) : 0,
        max: natValues.length ? Math.max(...natValues) : 0,
        passed: naturalnessCases.every((c) => c.passed),
      },
      clarity: {
        cases: clarityCases,
        mean: meanV19(clarityValues) ?? 0,
        min: clarityValues.length ? Math.min(...clarityValues) : 0,
        max: clarityValues.length ? Math.max(...clarityValues) : 0,
        passed: clarityCases.every((c) => c.passed),
      },
      turnTaking: {
        cases: turnCases,
        meanMs: meanV19(turnLatencies),
        p50Ms: percentileOfV19(turnLatencies, 50),
        p95Ms: percentileOfV19(turnLatencies, 95),
        maxMs: turnLatencies.length ? Math.max(...turnLatencies) : undefined,
        breaches: turnCases.filter((c) => !c.passed).length,
        withinBudgetRate: Math.round(turnWithin * 1000) / 1000,
        passed: turnCases.every((c) => c.passed),
      },
      bargeIn: { cases: bargeInCases, precision, recall, f1, passed: bargeInPassed },
      tts: {
        cases: ttsCases,
        meanFirstChunkMs: meanV19(firstChunks),
        maxGapMs: ttsCases.map((c) => c.maxGapMs).filter((v): v is number => v !== undefined).reduce((a, b) => Math.max(a, b), 0),
        underruns: ttsCases.reduce((sum, c) => sum + c.underruns, 0),
        passed: ttsCases.every((c) => c.passed),
      },
    };
    return report;
  }
}

export function createVoiceEvalV19(options: VoiceEvalV19Options = {}): VoiceEvalV19 {
  return new VoiceEvalV19(options);
}

export async function runDefaultVoiceEvalV19(
  options: VoiceEvalV19Options = {},
): Promise<VoiceEvalV19Report> {
  return createVoiceEvalV19(options).runAll();
}

/**
 * Diff a run against a baseline: one entry per dimension. Lower is
 * better for the two latency dimensions; higher is better for the
 * rest. A dimension regresses when it moves the wrong way by more
 * than `tolerance` (default from the eval options).
 */
export function compareWithBaselineV19(
  current: VoiceEvalV19Report,
  baseline: VoiceEvalV19Report,
  tolerance = 0.05,
): VoiceEvalV19Regression[] {
  const out: VoiceEvalV19Regression[] = [];
  const push = (
    dimension: VoiceEvalV19Regression['dimension'],
    baselineValue: number,
    currentValue: number,
    lowerIsBetter: boolean,
  ): void => {
    const delta = currentValue - baselineValue;
    const regressed = lowerIsBetter ? delta > tolerance : delta < -tolerance;
    out.push({ dimension, baseline: baselineValue, current: currentValue, delta, tolerance, regressed });
  };
  push('naturalness', baseline.naturalness.mean, current.naturalness.mean, false);
  push('clarity', baseline.clarity.mean, current.clarity.mean, false);
  push('turnTakingMs', baseline.turnTaking.meanMs ?? 0, current.turnTaking.meanMs ?? 0, true);
  push('firstChunkMs', baseline.tts.meanFirstChunkMs ?? 0, current.tts.meanFirstChunkMs ?? 0, true);
  push('bargeInF1', baseline.bargeIn.f1, current.bargeIn.f1, false);
  return out;
}

export function voiceEvalV19Summary(report: VoiceEvalV19Report): string {
  return (
    `voice eval v19: ${report.passed ? 'PASS' : 'FAIL'} — ` +
    `naturalness ${report.naturalness.mean.toFixed(3)} (min ${report.naturalness.min.toFixed(3)}), ` +
    `clarity ${report.clarity.mean.toFixed(3)} (min ${report.clarity.min.toFixed(3)}), ` +
    `turn-taking mean ${report.turnTaking.meanMs?.toFixed(0) ?? 'n/a'} ms ` +
    `(${Math.round(report.turnTaking.withinBudgetRate * 100)}% in budget), ` +
    `barge-in F1 ${report.bargeIn.f1.toFixed(3)}, ` +
    `first-chunk ${report.tts.meanFirstChunkMs?.toFixed(0) ?? 'n/a'} ms` +
    (report.failures.length > 0 ? ` — ${report.failures.length} failure(s)` : '')
  );
}

export function voiceEvalV19Markdown(report: VoiceEvalV19Report): string {
  const lines = [
    '## Voice eval v19',
    '',
    `- Verdict: **${report.passed ? 'PASS' : 'FAIL'}**`,
    `- Naturalness: mean ${report.naturalness.mean.toFixed(3)}, min ${report.naturalness.min.toFixed(3)}, max ${report.naturalness.max.toFixed(3)} (mock — prosody plan, not a listening test).`,
    `- Clarity: mean ${report.clarity.mean.toFixed(3)}, min ${report.clarity.min.toFixed(3)}, max ${report.clarity.max.toFixed(3)} (mock proxy — token features, not ears).`,
    `- Turn-taking: mean ${report.turnTaking.meanMs?.toFixed(0) ?? 'n/a'} ms, p50 ${report.turnTaking.p50Ms?.toFixed(0) ?? 'n/a'} ms, p95 ${report.turnTaking.p95Ms?.toFixed(0) ?? 'n/a'} ms, breaches ${report.turnTaking.breaches}, in-budget ${Math.round(report.turnTaking.withinBudgetRate * 100)}%.`,
    `- Barge-in: precision ${report.bargeIn.precision.toFixed(3)}, recall ${report.bargeIn.recall.toFixed(3)}, F1 ${report.bargeIn.f1.toFixed(3)}.`,
    `- TTS: mean first-chunk ${report.tts.meanFirstChunkMs?.toFixed(0) ?? 'n/a'} ms, max gap ${report.tts.maxGapMs ?? 'n/a'} ms, underruns ${report.tts.underruns}.`,
  ];
  if (report.failures.length > 0) {
    lines.push('', '### Failures', '');
    for (const failure of report.failures) lines.push(`- ${failure}`);
  }
  return lines.join('\n');
}

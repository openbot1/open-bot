/**
 * Voice realtime v4 (v1.05, Team T5 — latency pipeline).
 *
 * v3 made long calls durable (checkpoints + resume + media) and
 * barge-in kinder (backchannel + duck). v4 asks the next question:
 * *how slow is each leg of the voice path, and can the call get
 * faster while it is running?* This module is the measurement
 * layer — no audio is captured or played here, only timed:
 *
 *   - `LatencyHistogram` — one stage's samples with a bucket
 *     histogram plus p50 / p95 / p99. p99 matters for voice: a
 *     p95 of 300 ms can still hide a 2 s stall that kills a turn.
 *   - `VoiceLatencyPipeline` — the six stages of one spoken turn
 *     (capture → VAD → STT → LLM → TTS → playback), recorded in
 *     stage order with an injectable clock, plus the end-to-end
 *     turn latency. Stages the caller cannot observe stay
 *     unrecorded — the report says "not measured", it never
 *     invents a number.
 *   - `AdaptiveJitterBuffer` — the playout buffer that grows when
 *     arrival jitter grows and shrinks when the network calms
 *     down, so playback stays smooth without adding latency the
 *     call does not need.
 *   - Latency modes (`balanced` / `low-latency`): one place that
 *     says what "low latency" actually changes — smaller audio
 *     chunks, a shorter VAD hangover, a smaller jitter-buffer
 *     ceiling — so the panel's mode switch is a real config
 *     change, not a label.
 *
 * Pure + clock-injectable: tests drive every stage with a fake
 * clock and never touch a microphone, a socket, or a provider.
 */

/** One leg of the voice path, in pipeline order. */
export type VoiceLatencyStage =
  | 'capture'
  | 'vad'
  | 'stt'
  | 'llm'
  | 'tts'
  | 'playback';

/** The six stages, in the order audio flows through them. */
export const VOICE_LATENCY_STAGES: readonly VoiceLatencyStage[] = [
  'capture',
  'vad',
  'stt',
  'llm',
  'tts',
  'playback',
];

/** Latency mode: what the panel's switch actually changes. */
export type VoiceLatencyMode = 'balanced' | 'low-latency';

/** What one latency mode sets (all ms unless noted). */
export interface VoiceLatencyModeConfig {
  mode: VoiceLatencyMode;
  /** Audio chunk handed to the pipeline (smaller = faster VAD). */
  chunkMs: number;
  /** VAD hangover: silence needed before a turn is "done". */
  vadHangoverMs: number;
  /** Jitter-buffer depth the mode starts from. */
  jitterBufferMs: number;
  /** Jitter-buffer ceiling the mode allows. */
  maxJitterBufferMs: number;
  /** Skip the local VAD pre-pass (server VAD already does it). */
  skipLocalVad: boolean;
  /** Start TTS synthesis before the full LLM reply arrives. */
  prefetchTts: boolean;
}

/** The two modes, with the numbers the panel shows. */
export const VOICE_LATENCY_MODES: Record<VoiceLatencyMode, VoiceLatencyModeConfig> = {
  balanced: {
    mode: 'balanced',
    chunkMs: 20,
    vadHangoverMs: 300,
    jitterBufferMs: 120,
    maxJitterBufferMs: 400,
    skipLocalVad: false,
    prefetchTts: false,
  },
  'low-latency': {
    mode: 'low-latency',
    chunkMs: 10,
    vadHangoverMs: 100,
    jitterBufferMs: 60,
    maxJitterBufferMs: 160,
    skipLocalVad: true,
    prefetchTts: true,
  },
};

export function isVoiceLatencyMode(value: unknown): value is VoiceLatencyMode {
  return value === 'balanced' || value === 'low-latency';
}

/** Default histogram bucket edges (ms). */
export const LATENCY_HISTOGRAM_EDGES_MS: readonly number[] = [
  1, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000,
];

/** Summary of one stage's samples. */
export interface LatencyHistogramSummary {
  count: number;
  minMs: number;
  maxMs: number;
  meanMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  lastMs: number;
  /** Counts per bucket edge: index i counts samples <= edges[i];
   *  the last bucket counts samples above the largest edge. */
  buckets: number[];
}

function percentileOf(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx] as number;
}

/**
 * One stage's latency samples: a bounded rolling window plus a
 * bucket histogram and p50 / p95 / p99. Negative / NaN samples
 * are ignored — a broken clock must not poison the report.
 */
export class LatencyHistogram {
  private readonly maxSamples: number;
  private readonly edges: readonly number[];
  private readonly values: number[] = [];

  constructor(maxSamples = 500, edges: readonly number[] = LATENCY_HISTOGRAM_EDGES_MS) {
    this.maxSamples = Math.max(1, Math.floor(maxSamples));
    this.edges = edges;
  }

  record(ms: number): void {
    if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return;
    this.values.push(ms);
    while (this.values.length > this.maxSamples) this.values.shift();
  }

  get count(): number {
    return this.values.length;
  }

  /** Samples in arrival order (copies, oldest first). */
  samples(): number[] {
    return [...this.values];
  }

  summary(): LatencyHistogramSummary | null {
    if (this.values.length === 0) return null;
    const sorted = [...this.values].sort((a, b) => a - b);
    const sum = sorted.reduce((n, v) => n + v, 0);
    const buckets = this.edges.map((edge) => sorted.filter((v) => v <= edge).length);
    // The last bucket counts samples above the largest edge.
    buckets.push(sorted.filter((v) => v > (this.edges[this.edges.length - 1] as number)).length);
    return {
      count: sorted.length,
      minMs: sorted[0] as number,
      maxMs: sorted[sorted.length - 1] as number,
      meanMs: Math.round((sum / sorted.length) * 10) / 10,
      p50Ms: percentileOf(sorted, 50),
      p95Ms: percentileOf(sorted, 95),
      p99Ms: percentileOf(sorted, 99),
      lastMs: this.values[this.values.length - 1] as number,
      buckets,
    };
  }

  clear(): void {
    this.values.length = 0;
  }
}

/** Per-stage report: a summary per stage, null when unmeasured. */
export type VoiceLatencyStageReport = Record<VoiceLatencyStage, LatencyHistogramSummary | null>;

/** One session's latency report, as the panel renders it. */
export interface VoiceLatencyReport {
  sessionId: string;
  mode: VoiceLatencyMode;
  modeConfig: VoiceLatencyModeConfig;
  turns: number;
  stages: VoiceLatencyStageReport;
  /** End-to-end turn latency (turn start → first playback). */
  endToEnd: LatencyHistogramSummary | null;
  /** Slowest measured stage by p95 (null when nothing measured). */
  slowestStage: { stage: VoiceLatencyStage; p95Ms: number } | null;
  /** Jitter-buffer depth in use (ms). */
  jitterBufferMs: number;
  at: number;
}

export interface VoiceLatencyPipelineOptions {
  /** Session this pipeline measures (shown in the report). */
  sessionId?: string;
  /** Starting latency mode. Default 'balanced'. */
  mode?: VoiceLatencyMode;
  /** Max samples kept per stage. Default 500. */
  maxSamplesPerStage?: number;
  /** Inject the clock (tests). Defaults to `Date.now`. */
  clock?: () => number;
}

/**
 * Measures one voice session's pipeline, turn by turn.
 *
 * A turn is `startTurn()` (the user finished speaking) to the
 * first playback (`markStage('playback')` — or `endTurn()`).
 * Between them the caller marks each stage as it completes, in
 * pipeline order; a stage's duration is the gap since the
 * previous mark (the first stage is measured from the turn
 * start). Marks out of order are ignored — a stage that runs
 * before its predecessor cannot be timed against it, and the
 * pipeline says so by not recording it rather than by guessing.
 */
export class VoiceLatencyPipeline {
  private readonly sessionId: string;
  private readonly clock: () => number;
  private readonly histograms = new Map<VoiceLatencyStage, LatencyHistogram>();
  private readonly endToEnd = new LatencyHistogram();
  private mode: VoiceLatencyMode;
  private turnStartAt: number | null = null;
  private lastMarkAt: number | null = null;
  private lastMarkStage: VoiceLatencyStage | null = null;
  private turns = 0;
  private jitterBufferMs: number;

  constructor(options: VoiceLatencyPipelineOptions = {}) {
    this.sessionId = options.sessionId ?? '';
    this.clock = options.clock ?? Date.now;
    this.mode = isVoiceLatencyMode(options.mode) ? options.mode : 'balanced';
    this.jitterBufferMs = VOICE_LATENCY_MODES[this.mode].jitterBufferMs;
    const maxSamples = options.maxSamplesPerStage ?? 500;
    for (const stage of VOICE_LATENCY_STAGES) {
      this.histograms.set(stage, new LatencyHistogram(maxSamples));
    }
  }

  getMode(): VoiceLatencyMode {
    return this.mode;
  }

  getModeConfig(): VoiceLatencyModeConfig {
    return { ...VOICE_LATENCY_MODES[this.mode] };
  }

  /** Switch mode mid-call; returns the config now in effect. */
  setMode(mode: VoiceLatencyMode): VoiceLatencyModeConfig {
    if (!isVoiceLatencyMode(mode)) return this.getModeConfig();
    this.mode = mode;
    this.jitterBufferMs = VOICE_LATENCY_MODES[mode].jitterBufferMs;
    return this.getModeConfig();
  }

  getJitterBufferMs(): number {
    return this.jitterBufferMs;
  }

  /** The jitter buffer asked for a new depth (clamped by mode). */
  setJitterBufferMs(ms: number): number {
    const cfg = VOICE_LATENCY_MODES[this.mode];
    this.jitterBufferMs = Math.min(cfg.maxJitterBufferMs, Math.max(0, Math.floor(ms)));
    return this.jitterBufferMs;
  }

  /** A turn starts when the user finished speaking (commit / request). */
  startTurn(at?: number): void {
    this.turnStartAt = at ?? this.clock();
    this.lastMarkAt = this.turnStartAt;
    this.lastMarkStage = null;
  }

  /**
   * Mark a stage complete. Returns the recorded duration (ms),
   * or null when it could not be timed (no turn started, or the
   * stage arrived before its predecessor in pipeline order).
   */
  markStage(stage: VoiceLatencyStage, at?: number): number | null {
    if (this.turnStartAt === null || this.lastMarkAt === null) return null;
    const now = at ?? this.clock();
    const stageIdx = VOICE_LATENCY_STAGES.indexOf(stage);
    const lastIdx = this.lastMarkStage === null ? -1 : VOICE_LATENCY_STAGES.indexOf(this.lastMarkStage);
    if (stageIdx <= lastIdx) return null;
    const ms = now - this.lastMarkAt;
    if (ms < 0) return null;
    this.histograms.get(stage)?.record(ms);
    this.lastMarkAt = now;
    this.lastMarkStage = stage;
    return ms;
  }

  /**
   * Record a stage duration directly (the caller timed it
   * itself, e.g. a local STT engine that reports its own ms).
   */
  recordStage(stage: VoiceLatencyStage, ms: number): void {
    this.histograms.get(stage)?.record(ms);
  }

  /**
   * End the turn: records the end-to-end latency (turn start →
   * now) and counts the turn. Returns the end-to-end ms, or
   * null when no turn was started.
   */
  endTurn(at?: number): number | null {
    if (this.turnStartAt === null) return null;
    const now = at ?? this.clock();
    const ms = now - this.turnStartAt;
    if (ms >= 0) this.endToEnd.record(ms);
    this.turns += 1;
    this.turnStartAt = null;
    this.lastMarkAt = null;
    this.lastMarkStage = null;
    return ms >= 0 ? ms : null;
  }

  getTurnCount(): number {
    return this.turns;
  }

  isTurnOpen(): boolean {
    return this.turnStartAt !== null;
  }

  getStageSummary(stage: VoiceLatencyStage): LatencyHistogramSummary | null {
    return this.histograms.get(stage)?.summary() ?? null;
  }

  getEndToEndSummary(): LatencyHistogramSummary | null {
    return this.endToEnd.summary();
  }

  /** End-to-end turn latencies in order (oldest first, copies). */
  getEndToEndSamples(): number[] {
    return this.endToEnd.samples();
  }

  /** Full per-session report (stages never measured stay null). */
  getReport(): VoiceLatencyReport {    const stages = {} as VoiceLatencyStageReport;
    let slowest: { stage: VoiceLatencyStage; p95Ms: number } | null = null;
    for (const stage of VOICE_LATENCY_STAGES) {
      const summary = this.getStageSummary(stage);
      stages[stage] = summary;
      if (summary && (!slowest || summary.p95Ms > slowest.p95Ms)) {
        slowest = { stage, p95Ms: summary.p95Ms };
      }
    }
    return {
      sessionId: this.sessionId,
      mode: this.mode,
      modeConfig: this.getModeConfig(),
      turns: this.turns,
      stages,
      endToEnd: this.getEndToEndSummary(),
      slowestStage: slowest,
      jitterBufferMs: this.jitterBufferMs,
      at: this.clock(),
    };
  }

  clear(): void {
    for (const h of this.histograms.values()) h.clear();
    this.endToEnd.clear();
    this.turns = 0;
    this.turnStartAt = null;
    this.lastMarkAt = null;
    this.lastMarkStage = null;
  }
}

// ---------------------------------------------------------------------------
// Adaptive jitter buffer
// ---------------------------------------------------------------------------

export interface AdaptiveJitterBufferOptions {
  /** Starting depth (ms). Default: the mode's jitterBufferMs (120). */
  startMs?: number;
  /** Floor (ms). Default 40. */
  minMs?: number;
  /** Ceiling (ms). Default 400. */
  maxMs?: number;
  /** Grow step (ms) per high-jitter observation. Default 20. */
  growMs?: number;
  /** Shrink step (ms) per calm observation. Default 10. */
  shrinkMs?: number;
  /** Jitter above this (ms) grows the buffer. Default 30. */
  highJitterMs?: number;
  /** Jitter below this (ms) shrinks the buffer. Default 10. */
  lowJitterMs?: number;
}

/**
 * Playout buffer that follows the network: each observed arrival
 * gap updates an EWMA of jitter (mean absolute deviation from
 * the expected gap). High jitter grows the buffer a step, calm
 * arrival shrinks it a step — never below the floor, never above
 * the ceiling. Pure: no timers, no audio, just the depth number
 * the player should use.
 */
export class AdaptiveJitterBuffer {
  private readonly minMs: number;
  private readonly maxMs: number;
  private readonly growMs: number;
  private readonly shrinkMs: number;
  private readonly highJitterMs: number;
  private readonly lowJitterMs: number;
  private depthMs: number;
  private expectedGapMs: number | null = null;
  private jitterEwma = 0;
  private observations = 0;
  private grows = 0;
  private shrinks = 0;

  constructor(options: AdaptiveJitterBufferOptions = {}) {
    this.depthMs = Math.max(0, options.startMs ?? 120);
    this.minMs = Math.max(0, options.minMs ?? 40);
    this.maxMs = Math.max(this.minMs, options.maxMs ?? 400);
    this.growMs = Math.max(1, options.growMs ?? 20);
    this.shrinkMs = Math.max(1, options.shrinkMs ?? 10);
    this.highJitterMs = Math.max(0, options.highJitterMs ?? 30);
    this.lowJitterMs = Math.max(0, options.lowJitterMs ?? 10);
    this.depthMs = Math.min(this.maxMs, Math.max(this.minMs, this.depthMs));
  }

  getDepthMs(): number {
    return this.depthMs;
  }

  getJitterMs(): number {
    return Math.round(this.jitterEwma * 10) / 10;
  }

  getObservations(): number {
    return this.observations;
  }

  getStats(): { depthMs: number; jitterMs: number; observations: number; grows: number; shrinks: number } {
    return {
      depthMs: this.depthMs,
      jitterMs: this.getJitterMs(),
      observations: this.observations,
      grows: this.grows,
      shrinks: this.shrinks,
    };
  }

  /**
   * Observe one arrival gap (ms between consecutive audio
   * packets). The first gap sets the expectation; later gaps
   * move the jitter EWMA (alpha 0.2) and the depth follows.
   * Returns the depth now in effect.
   */
  observeGap(gapMs: number): number {
    if (typeof gapMs !== 'number' || !Number.isFinite(gapMs) || gapMs < 0) return this.depthMs;
    this.observations += 1;
    if (this.expectedGapMs === null) {
      this.expectedGapMs = gapMs;
      return this.depthMs;
    }
    const deviation = Math.abs(gapMs - this.expectedGapMs);
    this.jitterEwma = this.jitterEwma * 0.8 + deviation * 0.2;
    this.expectedGapMs = this.expectedGapMs * 0.9 + gapMs * 0.1;
    if (this.jitterEwma > this.highJitterMs && this.depthMs < this.maxMs) {
      this.depthMs = Math.min(this.maxMs, this.depthMs + this.growMs);
      this.grows += 1;
    } else if (this.jitterEwma < this.lowJitterMs && this.depthMs > this.minMs) {
      this.depthMs = Math.max(this.minMs, this.depthMs - this.shrinkMs);
      this.shrinks += 1;
    }
    return this.depthMs;
  }

  reset(): void {
    this.expectedGapMs = null;
    this.jitterEwma = 0;
    this.observations = 0;
    this.grows = 0;
    this.shrinks = 0;
  }
}

/** Markdown rendering of one latency report (panel + session log). */
export function voiceLatencyReportMarkdown(report: VoiceLatencyReport): string {
  const lines = [
    `# Voice latency — session ${report.sessionId || '(no session)'} (${report.mode})`,
    '',
    `- Turns: ${report.turns}, jitter buffer: ${report.jitterBufferMs}ms`,
    report.endToEnd
      ? `- End-to-end: p50 ${report.endToEnd.p50Ms}ms, p95 ${report.endToEnd.p95Ms}ms, p99 ${report.endToEnd.p99Ms}ms (n=${report.endToEnd.count})`
      : '- End-to-end: not measured yet',
    report.slowestStage
      ? `- Slowest stage: ${report.slowestStage.stage} (p95 ${report.slowestStage.p95Ms}ms)`
      : '- Slowest stage: none measured',
    '',
    '| Stage | p50 | p95 | p99 | n |',
    '|---|---|---|---|---|',
  ];
  for (const stage of VOICE_LATENCY_STAGES) {
    const s = report.stages[stage];
    lines.push(
      s
        ? `| ${stage} | ${s.p50Ms} | ${s.p95Ms} | ${s.p99Ms} | ${s.count} |`
        : `| ${stage} | — | — | — | 0 |`,
    );
  }
  return lines.join('\n');
}

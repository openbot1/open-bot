/**
 * Barge-in v3 (v1.16, Đội T5 — voice v15).
 *
 * The user talks over the bot; the bot must stop *fast* and *only* when
 * it really is the user. v14 queued the cut through stage queues and
 * split the reply mid-sentence. v15 owns the *decision* that precedes
 * the cut, because a wrong decision is worse than a slow one: cutting
 * on a cough, a breath, room noise or the bot's own echo makes the
 * conversation feel broken, while missing a real interruption makes
 * the bot feel deaf.
 *
 * Decision chain per 20 ms PCM16 frame (virtual clock, no mic):
 *
 *   1. Energy gate — RMS of the frame vs an adaptive noise floor
 *      (EMA learned from silence frames) times a ratio, plus an
 *      absolute floor so a very quiet room does not amplify dust.
 *      A frame below the gate is silence, whatever the VAD says.
 *   2. Burst classification — a speech burst shorter than
 *      `coughMaxMs` (default 120 ms) is a cough / click / pop, not a
 *      turn; a burst whose energy never rises above the *breath*
 *      band (floor × breathRatio, sustained low energy) is a breath
 *      or sigh; a burst that flickers on/off faster than the
 *      debounce window is noise. Only a burst that stays above the
 *      gate for `minSpeechMs` (default 250 ms, the research value)
 *      becomes `speech-started`.
 *   3. Debounce — `speech-started` fires once the sustained burst
 *      passes min-speech; `speech-ended` fires once silence lasts
 *      `minSilenceMs` (default 450 ms). Both are configurable per
 *      room / per user.
 *   4. Cancel scope — when the detector fires while the agent is
 *      speaking, `BargeInEngineV15.interrupt()` cancels exactly what
 *      the caller says is live: TTS audio still queued/playing,
 *      LLM work still generating (stale — its reply must never be
 *      spoken after the cut), and any STT partials for the old turn.
 *      The receipt records what was discarded and the cut latency
 *      (speech-start → cancel issued), so the session can prove the
 *      cut was fast.
 *
 * Echo guard: frames flagged `echo: true` (the caller knows this
 * frame is the bot's own audio leaking back through the mic) never
 * start a burst. Cooldown after a cut prevents one long utterance
 * from cutting twice.
 */

export interface BargeInV15Options {
  /** Sustained speech needed before a cut (ms). Research value: 250. */
  minSpeechMs?: number;
  /** Silence needed before the burst is considered ended (ms). */
  minSilenceMs?: number;
  /** Burst shorter than this is a cough / click, not speech (ms). */
  coughMaxMs?: number;
  /** RMS ratio over the adaptive noise floor to count as speech. */
  energyRatio?: number;
  /** Absolute RMS floor (quiet-room guard). */
  absoluteEnergyFloor?: number;
  /** Sustained energy below floor × this ratio is breath, not speech. */
  breathRatio?: number;
  /** Frames must stay above the gate this long before counting (ms). */
  debounceMs?: number;
  /** ms after a cut during which a new cut is ignored. */
  cooldownMs?: number;
  /** EMA alpha for the adaptive noise floor (0..1). */
  noiseFloorAlpha?: number;
}

export function defaultBargeInV15Options(): Required<BargeInV15Options> {
  return {
    minSpeechMs: 250,
    minSilenceMs: 450,
    coughMaxMs: 120,
    energyRatio: 2.5,
    absoluteEnergyFloor: 0.008,
    breathRatio: 1.4,
    debounceMs: 40,
    cooldownMs: 300,
    noiseFloorAlpha: 0.05,
  };
}

export function validateBargeInV15Options(options: BargeInV15Options): string[] {
  const errors: string[] = [];
  const check = (name: keyof BargeInV15Options, value: number | undefined, min: number, max: number): void => {
    if (value !== undefined && (!Number.isFinite(value) || value < min || value > max)) {
      errors.push(`${name} must be ${min}..${max}`);
    }
  };
  check('minSpeechMs', options.minSpeechMs, 50, 2000);
  check('minSilenceMs', options.minSilenceMs, 100, 3000);
  check('coughMaxMs', options.coughMaxMs, 0, 500);
  check('energyRatio', options.energyRatio, 1, 20);
  check('absoluteEnergyFloor', options.absoluteEnergyFloor, 0, 1);
  check('breathRatio', options.breathRatio, 1, 5);
  check('debounceMs', options.debounceMs, 0, 500);
  check('cooldownMs', options.cooldownMs, 0, 5000);
  check('noiseFloorAlpha', options.noiseFloorAlpha, 0.001, 1);
  if (options.coughMaxMs !== undefined && options.minSpeechMs !== undefined && options.coughMaxMs >= options.minSpeechMs) {
    errors.push('coughMaxMs must be smaller than minSpeechMs');
  }
  return errors;
}

/** RMS energy of a PCM16 frame, normalised to 0..1. */
export function frameRmsV15(frame: Int16Array): number {
  if (frame.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < frame.length; i += 1) {
    const v = frame[i] / 32768;
    sum += v * v;
  }
  return Math.sqrt(sum / frame.length);
}

/** Build a synthetic frame with a given RMS (tests / calibration). */
export function syntheticFrameV15(rms: number, samples = 480): Int16Array {
  const frame = new Int16Array(samples);
  const amplitude = Math.max(0, Math.min(1, rms)) * 32767;
  for (let i = 0; i < samples; i += 1) {
    frame[i] = Math.round(amplitude * Math.sin((i / samples) * Math.PI * 4));
  }
  return frame;
}

export type BargeInV15RejectionReason = 'cough' | 'breath' | 'noise' | 'echo' | 'cooldown';

export interface BargeInV15Frame {
  frame: Int16Array;
  atMs: number;
  /** True when the caller knows this frame is the bot's own echo. */
  echo?: boolean;
}

export type BargeInV15EventKind = 'speech-started' | 'speech-ended' | 'rejected' | 'cut';

export interface BargeInV15Event {
  kind: BargeInV15EventKind;
  atMs: number;
  /** Burst length at the time of the event (ms). */
  burstMs?: number;
  reason?: BargeInV15RejectionReason;
  rms?: number;
}

export type BargeInV15EventSink = (event: BargeInV15Event) => void;

export interface BargeInV15CancelScope {
  /** Cancel TTS audio still queued / playing. */
  tts?: boolean;
  /** Discard LLM work still generating (its reply must not be spoken). */
  llm?: boolean;
  /** Drop STT partials belonging to the interrupted turn. */
  stt?: boolean;
}

export interface BargeInV15CutReceipt {
  atMs: number;
  speechStartedAtMs: number;
  cutLatencyMs: number;
  scope: Required<BargeInV15CancelScope>;
  discardedTtsChunks: number;
  discardedLlmTokens: number;
  discardedSttPartials: number;
}

export interface BargeInV15Stats {
  speechBursts: number;
  cuts: number;
  rejections: Partial<Record<BargeInV15RejectionReason, number>>;
  totalRejections: number;
  lastCutLatencyMs: number | undefined;
  averageCutLatencyMs: number;
  noiseFloor: number;
}

/**
 * Energy gate + burst classifier. Pure: feed frames, get events.
 * `agentSpeaking` is set by the session so a cut is only *requested*
 * while the agent is actually speaking; detection itself runs always
 * (the session needs speech-started even when the agent is silent,
 * to start a turn).
 */
export class BargeInDetectorV15 {
  private readonly options: Required<BargeInV15Options>;
  private readonly sink: BargeInV15EventSink | undefined;
  private noiseFloor = 0.01;
  private burstStartMs: number | undefined;
  private burstPeakRms = 0;
  private burstAboveBreath = false;
  /** Start of a sustained low-energy burst (breath band: breathGate..gate). */
  private lowBurstStartMs: number | undefined;
  private speechStarted = false;
  private speechStartedAtMs = 0;
  private silenceStartMs: number | undefined;
  private lastCutAtMs: number | undefined;
  private bursts = 0;
  private readonly rejections = new Map<BargeInV15RejectionReason, number>();

  constructor(options: BargeInV15Options = {}, sink?: BargeInV15EventSink) {
    const merged = { ...defaultBargeInV15Options(), ...options };
    const errors = validateBargeInV15Options(merged);
    if (errors.length > 0) throw new Error(`invalid barge-in options: ${errors.join('; ')}`);
    this.options = merged;
    this.sink = sink;
  }

  getNoiseFloor(): number {
    return this.noiseFloor;
  }

  isSpeechActive(): boolean {
    return this.speechStarted;
  }

  /** Feed one 20 ms frame. Returns the event fired, if any. */
  feed(frame: BargeInV15Frame): BargeInV15Event | undefined {
    const rms = frameRmsV15(frame.frame);
    const atMs = frame.atMs;
    if (frame.echo === true) {
      this.learnFloor(rms);
      return this.reject('echo', atMs, rms);
    }
    const gate = Math.max(this.options.absoluteEnergyFloor, this.noiseFloor * this.options.energyRatio);
    const breathGate = Math.max(this.options.absoluteEnergyFloor, this.noiseFloor * this.options.breathRatio);
    if (rms < gate) {
      // Only true silence teaches the noise floor: learning from the
      // breath band would raise the floor until the breath gate
      // overtakes the breath itself and the burst fragments.
      if (rms < breathGate) this.learnFloor(rms);
      this.silenceStartMs = this.silenceStartMs ?? atMs;
      if (this.speechStarted && this.silenceStartMs !== undefined && atMs - this.silenceStartMs >= this.options.minSilenceMs) {
        this.speechStarted = false;
        const burstMs = atMs - this.speechStartedAtMs;
        this.silenceStartMs = undefined;
        const event: BargeInV15Event = { kind: 'speech-ended', atMs, burstMs, rms };
        this.sink?.(event);
        return event;
      }
      // A burst that died before min-speech: classify it now.
      if (this.burstStartMs !== undefined && !this.speechStarted) {
        const burstMs = atMs - this.burstStartMs;
        const reason = this.classifyShortBurst(burstMs);
        this.burstStartMs = undefined;
        this.burstPeakRms = 0;
        this.burstAboveBreath = false;
        return this.reject(reason, atMs, rms, burstMs);
      }
      // Low-energy band (breathGate..gate): a sustained low burst is a
      // breath / sigh, not speech — it never crosses the speech gate.
      if (rms >= breathGate) {
        if (this.lowBurstStartMs === undefined) this.lowBurstStartMs = atMs;
        return undefined;
      }
      if (this.lowBurstStartMs !== undefined) {
        const lowMs = atMs - this.lowBurstStartMs;
        this.lowBurstStartMs = undefined;
        if (lowMs >= this.options.minSpeechMs) {
          return this.reject('breath', atMs, rms, lowMs);
        }
      }
      return undefined;
    }

    // Above the gate: speech candidate.
    this.silenceStartMs = undefined;
    if (this.burstStartMs === undefined) {
      this.burstStartMs = atMs;
      this.burstPeakRms = rms;
      this.burstAboveBreath = rms >= breathGate;
    } else {
      this.burstPeakRms = Math.max(this.burstPeakRms, rms);
      if (rms >= breathGate) this.burstAboveBreath = true;
    }
    if (this.speechStarted) return undefined;
    const burstMs = atMs - this.burstStartMs;
    if (burstMs < this.options.debounceMs) return undefined;
    if (burstMs < this.options.minSpeechMs) return undefined;
    if (this.lastCutAtMs !== undefined && atMs - this.lastCutAtMs < this.options.cooldownMs) {
      return this.reject('cooldown', atMs, rms, burstMs);
    }
    if (!this.burstAboveBreath) {
      this.burstStartMs = undefined;
      return this.reject('breath', atMs, rms, burstMs);
    }
    this.speechStarted = true;
    this.speechStartedAtMs = this.burstStartMs;
    this.bursts += 1;
    const event: BargeInV15Event = { kind: 'speech-started', atMs, burstMs, rms };
    this.sink?.(event);
    return event;
  }

  /** Record that a cut was issued (starts the cooldown). */
  noteCut(atMs: number): void {
    this.lastCutAtMs = atMs;
  }

  stats(): BargeInV15Stats {
    const rejections: Partial<Record<BargeInV15RejectionReason, number>> = {};
    let total = 0;
    for (const [reason, count] of this.rejections) {
      rejections[reason] = count;
      total += count;
    }
    return {
      speechBursts: this.bursts,
      cuts: 0,
      rejections,
      totalRejections: total,
      lastCutLatencyMs: undefined,
      averageCutLatencyMs: 0,
      noiseFloor: this.noiseFloor,
    };
  }

  private learnFloor(rms: number): void {
    const alpha = this.options.noiseFloorAlpha;
    this.noiseFloor = this.noiseFloor * (1 - alpha) + rms * alpha;
    if (this.noiseFloor < 0.0005) this.noiseFloor = 0.0005;
  }

  private classifyShortBurst(burstMs: number): BargeInV15RejectionReason {
    if (burstMs <= this.options.coughMaxMs) return 'cough';
    if (!this.burstAboveBreath) return 'breath';
    return 'noise';
  }

  private reject(reason: BargeInV15RejectionReason, atMs: number, rms: number, burstMs?: number): BargeInV15Event {
    this.rejections.set(reason, (this.rejections.get(reason) ?? 0) + 1);
    const event: BargeInV15Event = { kind: 'rejected', atMs, reason, rms, burstMs };
    this.sink?.(event);
    return event;
  }
}

export interface BargeInEngineV15Options extends BargeInV15Options {
  /** Discard counters the caller reports when a scope is cancelled. */
  discardCounts?: { ttsChunks: number; llmTokens: number; sttPartials: number };
}

/**
 * Detector + cancel scope. The session calls `interrupt()` when the
 * detector fires `speech-started` while the agent is speaking; the
 * engine builds the cut receipt and starts the cooldown.
 */
export class BargeInEngineV15 {
  readonly detector: BargeInDetectorV15;
  private readonly cuts: BargeInV15CutReceipt[] = [];
  private readonly rejections = new Map<BargeInV15RejectionReason, number>();
  private discardCounts = { ttsChunks: 0, llmTokens: 0, sttPartials: 0 };

  constructor(options: BargeInEngineV15Options = {}, sink?: BargeInV15EventSink) {
    this.detector = new BargeInDetectorV15(options, (event) => {
      if (event.kind === 'rejected' && event.reason) {
        this.rejections.set(event.reason, (this.rejections.get(event.reason) ?? 0) + 1);
      }
      sink?.(event);
    });
    if (options.discardCounts) this.discardCounts = { ...options.discardCounts };
  }

  setDiscardCounts(counts: Partial<{ ttsChunks: number; llmTokens: number; sttPartials: number }>): void {
    this.discardCounts = { ...this.discardCounts, ...counts };
  }

  feed(frame: BargeInV15Frame): BargeInV15Event | undefined {
    return this.detector.feed(frame);
  }

  /**
   * Cancel the live scope. `speechStartedAtMs` comes from the
   * detector's speech-started event; `atMs` is now (virtual clock).
   */
  interrupt(speechStartedAtMs: number, atMs: number, scope: BargeInV15CancelScope): BargeInV15CutReceipt {
    const full: Required<BargeInV15CancelScope> = {
      tts: scope.tts ?? true,
      llm: scope.llm ?? true,
      stt: scope.stt ?? false,
    };
    const receipt: BargeInV15CutReceipt = {
      atMs,
      speechStartedAtMs,
      cutLatencyMs: Math.max(0, atMs - speechStartedAtMs),
      scope: full,
      discardedTtsChunks: full.tts ? this.discardCounts.ttsChunks : 0,
      discardedLlmTokens: full.llm ? this.discardCounts.llmTokens : 0,
      discardedSttPartials: full.stt ? this.discardCounts.sttPartials : 0,
    };
    this.cuts.push(receipt);
    this.detector.noteCut(atMs);
    return receipt;
  }

  lastCut(): BargeInV15CutReceipt | undefined {
    return this.cuts[this.cuts.length - 1];
  }

  cutsList(): BargeInV15CutReceipt[] {
    return [...this.cuts];
  }

  stats(): BargeInV15Stats {
    const detectorStats = this.detector.stats();
    const latencies = this.cuts.map((c) => c.cutLatencyMs);
    const rejections: Partial<Record<BargeInV15RejectionReason, number>> = {};
    let total = 0;
    for (const [reason, count] of this.rejections) {
      rejections[reason] = count;
      total += count;
    }
    return {
      speechBursts: detectorStats.speechBursts,
      cuts: this.cuts.length,
      rejections,
      totalRejections: total,
      lastCutLatencyMs: latencies.length > 0 ? latencies[latencies.length - 1] : undefined,
      averageCutLatencyMs: latencies.length > 0 ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : 0,
      noiseFloor: detectorStats.noiseFloor,
    };
  }

  summary(): string {
    const s = this.stats();
    return `barge-in v15: ${s.speechBursts} bursts, ${s.cuts} cuts, avg cut ${s.averageCutLatencyMs} ms, ` +
      `${s.totalRejections} rejected (${Object.entries(s.rejections).map(([k, v]) => `${k}=${v}`).join(', ') || 'none'})`;
  }

  markdown(): string {
    const s = this.stats();
    const lines = [
      '## Barge-in v15',
      '',
      `- Speech bursts: ${s.speechBursts}; cuts: ${s.cuts}`,
      `- Average cut latency: ${s.averageCutLatencyMs} ms${s.lastCutLatencyMs !== undefined ? ` (last ${s.lastCutLatencyMs} ms)` : ''}`,
      `- Rejected bursts: ${s.totalRejections}`,
      `- Noise floor (RMS): ${s.noiseFloor.toFixed(4)}`,
      '',
      '| Reason | Count |',
      '| --- | ---: |',
    ];
    const reasons: BargeInV15RejectionReason[] = ['cough', 'breath', 'noise', 'echo', 'cooldown'];
    for (const reason of reasons) {
      lines.push(`| ${reason} | ${s.rejections[reason] ?? 0} |`);
    }
    lines.push('');
    for (const cut of this.cuts) {
      lines.push(`- Cut @${cut.atMs} ms: latency ${cut.cutLatencyMs} ms, discarded TTS ${cut.discardedTtsChunks} chunks / LLM ${cut.discardedLlmTokens} tokens / STT ${cut.discardedSttPartials} partials.`);
    }
    lines.push('');
    return lines.join('\n');
  }
}

export function createBargeInEngineV15(
  options: BargeInEngineV15Options = {},
  sink?: BargeInV15EventSink,
): BargeInEngineV15 {
  return new BargeInEngineV15(options, sink);
}

export function bargeInV15Summary(engine: BargeInEngineV15): string {
  return engine.summary();
}

export function bargeInV15Markdown(engine: BargeInEngineV15): string {
  return engine.markdown();
}

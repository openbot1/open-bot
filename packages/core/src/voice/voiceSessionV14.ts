/**
 * Realtime voice session v14 (v1.15, Đội T5 — voice realtime v14).
 *
 * v13 wraps v12 and layers six components on top. v14 wraps
 * v13 the same way and layers the five v14 components on top,
 * driven by the v13 session's own events and one shared
 * virtual clock:
 *
 *   mic frame ──▶ v13 session ──▶ VAD queue (pipeline)
 *   host STT text ──▶ SmartTurnDetectorV14 (clause / question /
 *   │                   filler / backchannel) + WakeWordDetectorV14
 *   │                   (multi-word + VAD confirmation)
 *   speakReply(text) ──▶ BargeInEngineV14.beginSpeaking +
 *   │                   pipeline LLM/TTS items (the reply is
 *   │                   queued work until it is cut)
 *   interrupt() ──▶ v13 interrupt + engine v14 cutNow
 *                   (pipeline flush + scope cancel + cut
 *                    latency) + mid-sentence split
 *   every stage ──▶ LatencyBudgetV14 (per-session p50/p95/
 *                   p99, network stage, profiles, warn/critical)
 *   provider ──▶ VoiceProviderRegistryV14 (Deepgram /
 *                Cartesia / Whisper local / Pocket TTS /
 *                mock / realtime-api, picked by goal)
 *
 * Rules (same as v13):
 * - One virtual clock: the session clock is the v13 session's
 *   clock (`feedAudio` +20 ms per frame, `tick(ms)` manual).
 *   Every v14 layer reads it; nothing here reads wall time.
 * - The v13 session still owns VAD, turn-taking, overlap,
 *   playback, the v13 barge-in engine, clause TTS, Smart Turn
 *   v13, latency v13 and wake word v13. v14 never bypasses
 *   it: a cut goes through the inner session first, a reply
 *   through `inner.speakReply()`.
 * - The v14 Smart Turn and wake-word detectors run *in
 *   parallel* with the v13 ones on the same transcripts, so a
 *   host can compare the v13 and v14 verdicts turn by turn.
 * - Providers are a *selection*, not a live call: the mock
 *   adapters model timing and scripted transcripts so the
 *   session runs with no key, no model file and no network.
 *
 * Determinism: mock replies + mock TTS + scripted provider
 * transcripts, same as v13. No sound card, no network, no key.
 */

import { isValidPcm16Frame } from './audio';
import {
  RealtimeVoiceSessionV13,
  type VoiceSessionV13Options,
  type VoiceSessionV13Event,
  type VoiceSessionV13Stats,
  type VoiceSessionV13Status,
} from './voiceSessionV13';
import {
  LatencyBudgetV14,
  type LatencyBudgetV14Options,
  type LatencyBudgetV14Event,
  type LatencyBudgetV14Stats,
  type LatencyBudgetV14Stage,
  type LatencyBudgetV14SessionReport,
  type LatencyBudgetV14SessionStageReport,
  type LatencyBudgetV14Profile,
  type LatencyBudgetV14Alert,
} from './latencyBudgetV14';
import {
  VoiceProviderRegistryV14,
  type VoiceProviderV14,
  type VoiceProviderV14Kind,
  type VoiceProviderV14Options,
  type VoiceProviderV14PickGoal,
} from './voiceProvidersV14';
import {
  SmartTurnDetectorV14,
  type SmartTurnV14Options,
  type SmartTurnV14Event,
  type SmartTurnV14Stats,
  type SmartTurnV14Decision,
} from './smartTurnV14';
import {
  WakeWordDetectorV14,
  type WakeWordV14Options,
  type WakeWordV14Event,
  type WakeWordV14Stats,
  type WakeWordV14Activation,
} from './wakeWordV14';
import {
  BargeInEngineV14,
  cutMidSentenceV14,
  type BargeInV14Options,
  type BargeInV14Event,
  type BargeInV14Stats,
  type BargeInV14CutResult,
} from './bargeInV14';
import type { InterruptedUtteranceV12 } from './bargeInV12';
import type { TtsClauseV13 } from './ttsClauseV13';

/** UI status of a v14 voice session (what the panel renders). */
export type VoiceSessionV14Status = VoiceSessionV13Status;

/** Events emitted by a v14 session. */
export type VoiceSessionV14Event =
  | { kind: 'state'; state: VoiceSessionV14Status; atMs: number }
  | { kind: 'v13'; event: VoiceSessionV13Event }
  | { kind: 'barge-in-v14'; event: BargeInV14Event }
  | { kind: 'smart-turn-v14'; event: SmartTurnV14Event }
  | { kind: 'latency-v14'; event: LatencyBudgetV14Event }
  | { kind: 'wake-word-v14'; event: WakeWordV14Event }
  | { kind: 'wake-ignored-frame'; atMs: number }
  | { kind: 'turn-ended-smart-v14'; decision: SmartTurnV14Decision }
  | { kind: 'provider-changed-v14'; kindName: string; atMs: number }
  | { kind: 'reply-cut-v14'; result: BargeInV14CutResult };

export type VoiceSessionV14EventSink = (event: VoiceSessionV14Event) => void;

/** Options for creating a `RealtimeVoiceSessionV14`. */
export interface VoiceSessionV14Options extends VoiceSessionV13Options {
  /** Latency budget v2 options (profile + overrides). */
  latencyBudgetV14?: LatencyBudgetV14Options;
  /** Smart Turn v2 options (sensitivity preset + thresholds). */
  smartTurnV14?: SmartTurnV14Options;
  /** Wake-word v2 options (per-word configs + near-misses). */
  wakeWordV14?: WakeWordV14Options;
  /** Barge-in v2 options (pipeline queue capacities). */
  bargeInV14?: BargeInV14Options;
  /** Provider kind to use (default 'mock'). */
  providerKindV14?: VoiceProviderV14Kind;
  /** Options passed to the v14 provider registry. */
  providerOptionsV14?: VoiceProviderV14Options;
  /** Enable the wake-word v2 gate (default false — sessions listen immediately, as in v13). */
  wakeWordV14Enabled?: boolean;
}

/** Counters for one v14 session (v13 stats + v14 layers). */
export interface VoiceSessionV14Stats extends VoiceSessionV13Stats {
  latencyBudgetV14: LatencyBudgetV14Stats;
  smartTurnV14: SmartTurnV14Stats;
  wakeWordV14: WakeWordV14Stats;
  bargeInV14: BargeInV14Stats;
  /** Provider kind in use (v14 registry). */
  providerKindV14: string;
  /** True when the v14 provider in use is ready. */
  providerReadyV14: boolean;
  /** Mic frames ignored while the wake-word v2 gate was asleep. */
  wakeV14IgnoredFrames: number;
}

/** In-memory registry options. */
export interface VoiceV14ManagerOptions {
  mockReplies?: string[];
}

/**
 * Realtime voice session v14: a v13 session plus latency
 * budget v2, Smart Turn v2, wake word v2, barge-in v2 and the
 * v14 provider registry — one clock.
 */
export class RealtimeVoiceSessionV14 {
  private readonly sessionId: string;
  private readonly inner: RealtimeVoiceSessionV13;
  private readonly latencyV14: LatencyBudgetV14;
  private readonly smartTurnV14: SmartTurnDetectorV14;
  private readonly wakeWordV14: WakeWordDetectorV14;
  private readonly engineV14: BargeInEngineV14;
  private readonly providersV14: VoiceProviderRegistryV14;
  private providerV14: VoiceProviderV14;
  private readonly wakeWordV14Enabled: boolean;
  private readonly sink: VoiceSessionV14EventSink | null;
  private closed = false;
  private wakeV14IgnoredFrames = 0;
  private currentReplyText = '';
  private frameSeq = 0;

  constructor(options: VoiceSessionV14Options, sink: VoiceSessionV14EventSink | null = null) {
    this.sessionId = options.sessionId;
    this.sink = sink;
    this.wakeWordV14Enabled = options.wakeWordV14Enabled ?? false;
    this.latencyV14 = new LatencyBudgetV14(options.latencyBudgetV14 ?? {}, (event) => {
      this.sink?.({ kind: 'latency-v14', event });
    });
    this.smartTurnV14 = new SmartTurnDetectorV14(options.smartTurnV14 ?? {}, (event) => {
      this.sink?.({ kind: 'smart-turn-v14', event });
      if (event.kind === 'turn-ended') this.sink?.({ kind: 'turn-ended-smart-v14', decision: event.decision });
    });
    this.wakeWordV14 = new WakeWordDetectorV14(
      { ...(options.wakeWordV14 ?? {}), startAsleep: this.wakeWordV14Enabled ? true : false },
      (event) => this.sink?.({ kind: 'wake-word-v14', event }),
    );
    this.engineV14 = new BargeInEngineV14(options.bargeInV14 ?? {}, (event) => {
      this.sink?.({ kind: 'barge-in-v14', event });
    });
    this.engineV14.setTtsQueue(this.innerTtsQueue());
    this.providersV14 = new VoiceProviderRegistryV14(options.providerOptionsV14 ?? {});
    const kind = options.providerKindV14 ?? 'mock';
    const selected = this.providersV14.get(kind);
    if (!selected) throw new Error(`Voice v14 unknown provider kind "${kind}".`);
    this.providerV14 = selected;
    const { latencyBudgetV14: _lb, smartTurnV14: _st, wakeWordV14: _ww, bargeInV14: _bi, providerKindV14: _pk, providerOptionsV14: _po, wakeWordV14Enabled: _we, ...v13Options } = options;
    void _lb; void _st; void _ww; void _bi; void _pk; void _po; void _we;
    this.inner = new RealtimeVoiceSessionV13(v13Options, (event) => this.onV13Event(event));
  }

  /** The v13 clause TTS stream, as a TTS queue the v14 engine can flush. */
  private innerTtsQueue(): { cancelPending(): { cancelled: boolean; chunksCancelled: number; charsDiscarded: number; cutPlaying: boolean; cutChunkText: string; playedMs: number; discardedMs: number; atMs: number } } {
    // The v14 engine flushes the clause TTS through the inner
    // session's own stream; the shape matches TtsStreamCancelResult.
    return {
      cancelPending: () => this.inner.getClauseTts().cancelPending(),
    };
  }

  getSessionId(): string {
    return this.sessionId;
  }

  getBotId(): string {
    return this.inner.getBotId();
  }

  getLanguage(): string {
    return this.inner.getLanguage();
  }

  getVoice(): string {
    return this.inner.getVoice();
  }

  getStatus(): VoiceSessionV14Status {
    return this.inner.getStatus();
  }

  getNowMs(): number {
    return this.inner.getNowMs();
  }

  isConnected(): boolean {
    return this.inner.isConnected();
  }

  getInner(): RealtimeVoiceSessionV13 {
    return this.inner;
  }

  getLatencyBudgetV14(): LatencyBudgetV14 {
    return this.latencyV14;
  }

  getSmartTurnV14(): SmartTurnDetectorV14 {
    return this.smartTurnV14;
  }

  getWakeWordV14(): WakeWordDetectorV14 {
    return this.wakeWordV14;
  }

  getBargeInEngineV14(): BargeInEngineV14 {
    return this.engineV14;
  }

  getProviderV14(): VoiceProviderV14 {
    return this.providerV14;
  }

  getProviderRegistryV14(): VoiceProviderRegistryV14 {
    return this.providersV14;
  }

  /** Switch the v14 provider (also switches the v13 provider when the kind exists there). */
  setProviderV14(kind: string): VoiceProviderV14 {
    const next = this.providersV14.get(kind);
    if (!next) throw new Error(`Voice v14 unknown provider kind "${kind}".`);
    this.providerV14 = next;
    const v13Kinds = ['mock', 'edge-tts', 'whisper-local', 'realtime-api'];
    if (v13Kinds.includes(kind)) {
      try {
        this.inner.setProvider(kind);
      } catch {
        // The v13 registry may not have the kind (custom builds);
        // the v14 selection still stands.
      }
    }
    this.sink?.({ kind: 'provider-changed-v14', kindName: kind, atMs: this.getNowMs() });
    return next;
  }

  /** Pick the best ready v14 provider for a goal (+ optional capability). */
  pickProviderV14(goal: VoiceProviderV14PickGoal = 'balanced', capability?: 'stt' | 'tts' | 'realtime'): VoiceProviderV14 | null {
    return this.providersV14.pick({ goal, capability });
  }

  /** Pick the best ready STT + TTS pair for a goal. */
  pickProviderPairV14(goal: VoiceProviderV14PickGoal = 'balanced'): { stt: VoiceProviderV14 | null; tts: VoiceProviderV14 | null } {
    return this.providersV14.pickPair(goal);
  }

  getClauses(): TtsClauseV13[] {
    return this.inner.getClauses();
  }

  getLastInterrupt(): InterruptedUtteranceV12 | null {
    return this.inner.getLastInterrupt();
  }

  getLastCutV14(): BargeInV14CutResult | null {
    return this.engineV14.getLastCut();
  }

  getPlayedTranscript(): string {
    return this.inner.getPlayedTranscript();
  }

  getLatencyReportsV14(): LatencyBudgetV14SessionStageReport[] {
    return this.latencyV14.getSessionStageReports(this.sessionId);
  }

  getSessionLatencyReport(): LatencyBudgetV14SessionReport {
    return this.latencyV14.getSessionReport(this.sessionId);
  }

  getLatencyAlertsV14(): LatencyBudgetV14Alert[] {
    return this.latencyV14.getAlerts(this.sessionId);
  }

  getStats(): VoiceSessionV14Stats {
    const v13 = this.inner.getStats();
    return {
      ...v13,
      latencyBudgetV14: this.latencyV14.getStats(),
      smartTurnV14: this.smartTurnV14.getStats(),
      wakeWordV14: this.wakeWordV14.getStats(),
      bargeInV14: this.engineV14.getStats(),
      providerKindV14: this.providerV14.kind,
      providerReadyV14: this.providerV14.isReady(),
      wakeV14IgnoredFrames: this.wakeV14IgnoredFrames,
    };
  }

  getSummary(): string {
    const s = this.getStats();
    return (
      `Realtime v14: ${s.state}, ${s.turns} turns, ` +
      `barge-in v14 ${s.bargeInV14.v13.cuts} cuts (pipeline discarded ${s.bargeInV14.pipeline.cutDiscarded}), ` +
      `smart turns v14 ${s.smartTurnV14.turns}, wake word v14 ${s.wakeWordV14.state}, ` +
      `provider ${s.providerKindV14}${s.providerReadyV14 ? '' : ' (not ready)'}, ` +
      `latency profile ${s.latencyBudgetV14.sessions > 0 ? 'active' : 'no samples yet'}`
    );
  }

  transcriptMarkdown(): string {
    return this.inner.transcriptMarkdown();
  }

  async connect(): Promise<void> {
    await this.inner.connect();
  }

  disconnect(): void {
    if (this.closed) return;
    this.closed = true;
    this.inner.disconnect();
  }

  /**
   * Feed one 20 ms PCM16 mic frame. While the wake-word v2
   * gate is asleep the frame is counted and dropped; otherwise
   * it goes to the inner session and one VAD queue item is
   * enqueued in the v14 pipeline.
   */
  feedAudio(frame: Uint8Array, input: { echo?: boolean } = {}): void {
    if (!isValidPcm16Frame(frame)) {
      throw new Error('Realtime v14 expects a 20 ms PCM16 frame (320 samples at 16 kHz).');
    }
    if (this.wakeWordV14Enabled && !this.wakeWordV14.isActive()) {
      this.wakeV14IgnoredFrames += 1;
      this.sink?.({ kind: 'wake-ignored-frame', atMs: this.getNowMs() });
      return;
    }
    this.frameSeq += 1;
    this.engineV14.getPipeline().enqueue('vad', {
      id: `vad-${this.frameSeq}`,
      payload: frame,
      atMs: this.getNowMs(),
      cost: 20,
    });
    this.inner.feedAudio(frame, input);
  }

  /** Advance the virtual clock (drives TTS, cooldowns, timeouts, wake-word auto-sleep). */
  tick(ms: number): void {
    this.inner.tick(ms);
    this.wakeWordV14.tick(this.getNowMs());
    this.smartTurnV14.noteSilence(ms);
  }

  /**
   * Feed a partial transcript from the host STT: feeds the
   * v13 session (wake v13 + Smart Turn v13), the v14 Smart
   * Turn and the v14 wake word. Returns the v14 decision.
   */
  noteTranscript(text: string, atMs?: number): SmartTurnV14Decision | null {
    const nowMs = atMs ?? this.getNowMs();
    this.wakeWordV14.noteTranscript(text, nowMs);
    this.smartTurnV14.notePartialText(text, nowMs);
    this.inner.noteTranscript(text, nowMs);
    return this.smartTurnV14.decide(nowMs);
  }

  /** Feed VAD speech (ms) to the v14 wake word (confirmation after a keyword hit). */
  noteVadSpeech(ms: number, atMs?: number): WakeWordV14Activation | null {
    return this.wakeWordV14.noteVadSpeech(ms, atMs ?? this.getNowMs());
  }

  /** Wake the v14 session now, without a transcript (host button / test). */
  wakeNowV14(atMs?: number): WakeWordV14Activation | null {
    const nowMs = atMs ?? this.getNowMs();
    const activation = this.wakeWordV14.noteTranscript(this.wakeWordV14.getKeywords()[0] ?? 'hey bot', nowMs);
    if (activation) return activation;
    return this.wakeWordV14.noteVadSpeech(300, nowMs + 100);
  }

  /** Put the v14 wake-word gate back to sleep. */
  sleepNowV14(atMs?: number): void {
    this.wakeWordV14.sleep(atMs ?? this.getNowMs(), 'explicit');
  }

  /** Record one measured latency stage sample for this session (v13 + v14). */
  recordLatencyStage(turnId: string, stage: LatencyBudgetV14Stage, ms: number): LatencyBudgetV14SessionStageReport {
    if (stage !== 'network') {
      this.inner.recordLatencyStage(turnId, stage, ms);
    }
    return this.latencyV14.recordStage({ sessionId: this.sessionId, turnId, stage, ms, atMs: this.getNowMs() });
  }

  /** Change one stage's latency budget (ms) in the v14 dashboard (and v13 when applicable). */
  setLatencyBudgetV14(stage: LatencyBudgetV14Stage, ms: number): number {
    if (stage !== 'network') {
      try {
        this.inner.setLatencyBudget(stage, Math.max(1, ms));
      } catch {
        // The v13 dashboard rejects a 0 budget; v14 allows it
        // for the network stage only — already excluded above.
      }
    }
    return this.latencyV14.setBudget(stage, ms);
  }

  /** Record a whole turn's latency at once for this session. */
  recordLatencyTurn(turnId: string, stages: Partial<Record<LatencyBudgetV14Stage, number>>): LatencyBudgetV14SessionReport {
    return this.latencyV14.recordTurn(this.sessionId, turnId, stages, this.getNowMs());
  }

  /** Get the latency budget profile in use. */
  getLatencyProfile(): LatencyBudgetV14Profile {
    return this.latencyV14.getProfile();
  }

  speakReply(text: string): boolean {
    if (typeof text !== 'string' || text.trim().length === 0) {
      throw new Error('Realtime v14 speakReply needs non-empty text.');
    }
    const started = this.inner.speakReply(text);
    if (!started) return false;
    this.currentReplyText = text.trim();
    // Queue the reply as LLM + TTS work in the pipeline, then
    // arm the v14 barge-in engine for the cut.
    this.engineV14.getPipeline().enqueue('llm', {
      id: `llm-${this.getNowMs()}`,
      payload: text.trim(),
      atMs: this.getNowMs(),
      cost: text.trim().length,
    });
    this.engineV14.getPipeline().enqueue('tts', {
      id: `tts-${this.getNowMs()}`,
      payload: text.trim(),
      atMs: this.getNowMs(),
      cost: text.trim().length,
    });
    this.engineV14.beginSpeaking(text.trim(), this.getNowMs());
    return true;
  }

  async simulateTurn(userText: string, modelReply?: string): Promise<boolean> {
    return this.inner.simulateTurn(userText, modelReply);
  }

  /**
   * Interrupt the agent reply now (explicit user action): cut
   * the inner session first, then the v14 engine (pipeline
   * flush + scope cancel + mid-sentence split of the current
   * reply at the played point).
   */
  interrupt(reason = 'user'): BargeInV14CutResult | null {
    const innerResult = this.inner.interrupt(reason);
    void innerResult;
    const playedChars = this.inner.getPlayedTranscript().length;
    const cut = this.engineV14.cutNow(this.getNowMs(), reason, this.getNowMs() - 120);
    if (!cut) return null;
    const result: BargeInV14CutResult = {
      ...cut,
      midSentence: this.currentReplyText ? cutMidSentenceV14(this.currentReplyText, playedChars) : null,
    };
    this.sink?.({ kind: 'reply-cut-v14', result });
    return result;
  }

  /** Cut the current reply mid-sentence at a played char count. */
  cutMidSentence(playedChars: number, atMs?: number): BargeInV14CutResult | null {
    const nowMs = atMs ?? this.getNowMs();
    const result = this.engineV14.cutMidSentence(this.currentReplyText || '', playedChars, nowMs, nowMs - 120);
    if (result) this.sink?.({ kind: 'reply-cut-v14', result });
    return result;
  }

  resumeReply(strategy?: Parameters<RealtimeVoiceSessionV13['resumeReply']>[0]): boolean {
    return this.inner.resumeReply(strategy);
  }

  noteUserWord(word: string, atMs?: number, confidence = 1): void {
    const nowMs = atMs ?? this.getNowMs();
    this.engineV14.noteUserWord(word, nowMs, confidence);
    this.inner.noteUserWord(word, nowMs, confidence);
  }

  duck(): boolean {
    return this.inner.duck();
  }

  resumePlayback(): boolean {
    return this.inner.resumePlayback();
  }

  pauseTts(): boolean {
    return this.inner.pauseTts();
  }

  resumeTts(): boolean {
    return this.inner.resumeTts();
  }

  private onV13Event(event: VoiceSessionV13Event): void {
    if (event.kind === 'state') {
      this.sink?.({ kind: 'state', state: event.state, atMs: event.atMs });
      return;
    }
    this.sink?.({ kind: 'v13', event });
  }
}

/** Create a v14 session (factory). */
export function createRealtimeVoiceSessionV14(
  options: VoiceSessionV14Options,
  sink: VoiceSessionV14EventSink | null = null,
): RealtimeVoiceSessionV14 {
  return new RealtimeVoiceSessionV14(options, sink);
}

/**
 * In-memory registry of v14 sessions. Everything is local:
 * sessions run on the mock TTS synth unless the host wires a
 * live provider; no key is ever read here.
 */
export class VoiceV14Manager {
  private readonly sessions = new Map<string, RealtimeVoiceSessionV14>();
  private readonly mockReplies: string[] | undefined;

  constructor(options: VoiceV14ManagerOptions = {}) {
    this.mockReplies = options.mockReplies;
  }

  create(options: VoiceSessionV14Options & { connectNow?: boolean }): RealtimeVoiceSessionV14 {
    if (this.sessions.has(options.sessionId)) {
      throw new Error(`Voice v14 session "${options.sessionId}" already exists.`);
    }
    const session = new RealtimeVoiceSessionV14(
      { ...(this.mockReplies ? { mockReplies: this.mockReplies } : {}), ...options },
      null,
    );
    this.sessions.set(options.sessionId, session);
    if (options.connectNow) void session.connect();
    return session;
  }

  get(sessionId: string): RealtimeVoiceSessionV14 | undefined {
    return this.sessions.get(sessionId);
  }

  list(): RealtimeVoiceSessionV14[] {
    return [...this.sessions.values()];
  }

  ids(): string[] {
    return [...this.sessions.keys()];
  }

  remove(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    session.disconnect();
    return this.sessions.delete(sessionId);
  }

  size(): number {
    return this.sessions.size;
  }
}

/** Create a v14 session manager (factory). */
export function createVoiceV14Manager(options: VoiceV14ManagerOptions = {}): VoiceV14Manager {
  return new VoiceV14Manager(options);
}

/** One-line summary of a v14 session's stats. */
export function voiceSessionV14Summary(stats: VoiceSessionV14Stats): string {
  return (
    `Voice v14 session ${stats.sessionId} (${stats.botId}, ${stats.language}/${stats.voice || 'default'}): ` +
    `${stats.state}, ${stats.turns} turns, ${stats.bargeInV14.v13.cuts} barge-in v14 cuts, ` +
    `smart turns v14 ${stats.smartTurnV14.turns}, wake word v14 ${stats.wakeWordV14.state}, ` +
    `provider ${stats.providerKindV14}, latency sessions ${stats.latencyBudgetV14.sessions}`
  );
}

/** Session stats as Markdown (for the diagnostics panel). */
export function voiceSessionV14Markdown(stats: VoiceSessionV14Stats): string {
  const lines = [
    `## Voice session v14 — ${stats.sessionId}`,
    '',
    `- state: ${stats.state}, turns: ${stats.turns}, provider: ${stats.providerKindV14} (${stats.providerReadyV14 ? 'ready' : 'not ready'})`,
    `- barge-in v14: ${stats.bargeInV14.v13.cuts} cuts, pipeline discarded ${stats.bargeInV14.pipeline.cutDiscarded} items, mean cut latency ${stats.bargeInV14.pipeline.meanCutLatencyMs} ms`,
    `- smart turn v14: ${stats.smartTurnV14.turns} turns (open ${stats.smartTurnV14.openQuestions}, closed ${stats.smartTurnV14.closedQuestions}), backchannels ack ${stats.smartTurnV14.backchannelAck} / continue ${stats.smartTurnV14.backchannelContinue}`,
    `- wake word v14: ${stats.wakeWordV14.state}, activations ${stats.wakeWordV14.activations}, suppressed ${stats.wakeWordV14.suppressed}`,
    `- latency v14: ${stats.latencyBudgetV14.sessions} sessions, ${stats.latencyBudgetV14.alerts} alerts (${stats.latencyBudgetV14.criticalAlerts} critical)`,
  ];
  return lines.join('\n');
}

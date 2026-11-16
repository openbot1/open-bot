/**
 * Realtime voice session v13 (v1.14, Đội T5 — voice realtime v13).
 *
 * v12 wraps a v11 session and layers interrupt context, planned
 * TTS, a turn machine, an end-of-turn detector and an overlap
 * tracker on top. v13 wraps v12 the same way and layers the
 * six v13 components on top, driven by the v12 session's own
 * events and one shared virtual clock:
 *
 *   mic frame ──▶ v12 session ──▶ VAD speech-start
 *                                      └─▶ BargeInEngineV13
 *                                           (policy gate → the
 *                                            inner cut is already
 *                                            made by v11; v13
 *                                            cancels the scope,
 *                                            flushes clause TTS
 *                                            and records the cut)
 *                  v12 session ──▶ 'reply-cut'
 *                                      └─▶ engine.recordObservedCut
 *                  speakReply(text) ──▶ ClauseTtsStreamV13
 *                                      (clause-by-clause, first
 *                                       clause out immediately)
 *                                      └─▶ engine.beginSpeaking
 *                  host STT text ──▶ SmartTurnDetectorV13
 *                                      (semantic end-of-turn)
 *                                      └─▶ WakeWordDetectorV13
 *                                           (asleep until the
 *                                            keyword is heard)
 *                  every stage ──▶ LatencyBudgetV13
 *                                      (budget vs reality)
 *                  provider ──▶ VoiceProviderRegistryV13
 *                                      (mock / edge-tts /
 *                                       whisper-local /
 *                                       realtime-api)
 *
 * Rules:
 * - One virtual clock: the session clock is the v12 session's
 *   clock (`feedAudio` +20 ms per frame, `tick(ms)` manual).
 *   Every v13 layer reads it; nothing here reads wall time.
 * - The v12 session still owns VAD, turn-taking, overlap and
 *   playback. v13 never bypasses it: a cut goes through the
 *   inner session (`inner.interrupt()` for the explicit path),
 *   a reply through `inner.speakReply()`, ducking through
 *   `inner.duck()` / `inner.resumePlayback()`.
 * - Wake-word gating: while the detector is asleep, mic frames
 *   are counted as ignored and NOT forwarded to the inner
 *   session (the room is not listened to); the host wakes the
 *   session by feeding a transcript with the keyword
 *   (`noteTranscript`) or by calling `wakeNow()`.
 * - The provider is a *selection*, not a live call: the mock
 *   adapters model timing and scripted transcripts so the
 *   session runs with no key, no model file and no network.
 *   A host that binds a live adapter keeps the same session.
 *
 * Determinism: mock replies + mock TTS + scripted provider
 * transcripts, same as v12. No sound card, no network, no key.
 */

import { isValidPcm16Frame } from './audio';
import {
  RealtimeVoiceSessionV12,
  type VoiceSessionV12Options,
  type VoiceSessionV12Event,
  type VoiceSessionV12Stats,
  type VoiceSessionV12Status,
} from './voiceSessionV12';
import {
  BargeInEngineV13,
  type BargeInV13Options,
  type BargeInV13Event,
  type BargeInV13Stats,
  type BargeInV13CutResult,
} from './bargeInV13';
import {
  ClauseTtsStreamV13,
  type TtsClauseV13Options,
  type TtsClauseV13Event,
  type TtsClauseV13Stats,
  type TtsClauseV13,
} from './ttsClauseV13';
import {
  SmartTurnDetectorV13,
  type SmartTurnV13Options,
  type SmartTurnV13Event,
  type SmartTurnV13Stats,
  type SmartTurnV13Decision,
} from './smartTurnV13';
import {
  LatencyBudgetV13,
  type LatencyBudgetV13Options,
  type LatencyBudgetV13Event,
  type LatencyBudgetV13Stats,
  type LatencyBudgetV13Stage,
  type LatencyBudgetV13StageReport,
  type LatencyBudgetV13TurnReport,
} from './latencyBudgetV13';
import {
  WakeWordDetectorV13,
  type WakeWordV13Options,
  type WakeWordV13Event,
  type WakeWordV13Stats,
  type WakeWordV13Activation,
} from './wakeWordV13';
import {
  VoiceProviderRegistryV13,
  type VoiceProviderV13,
  type VoiceProviderV13Kind,
  type VoiceProviderV13Options,
} from './voiceProvidersV13';
import type { InterruptedUtteranceV12 } from './bargeInV12';

/** UI status of a v13 voice session (what the panel renders). */
export type VoiceSessionV13Status = VoiceSessionV12Status;

/** Events emitted by a v13 session. */
export type VoiceSessionV13Event =
  | { kind: 'state'; state: VoiceSessionV13Status; atMs: number }
  | { kind: 'v12'; event: VoiceSessionV12Event }
  | { kind: 'barge-in-v13'; event: BargeInV13Event }
  | { kind: 'clause-tts'; event: TtsClauseV13Event }
  | { kind: 'smart-turn'; event: SmartTurnV13Event }
  | { kind: 'latency'; event: LatencyBudgetV13Event }
  | { kind: 'wake-word'; event: WakeWordV13Event }
  | { kind: 'wake-ignored-frame'; atMs: number }
  | { kind: 'turn-ended-smart'; decision: SmartTurnV13Decision }
  | { kind: 'provider-changed'; kindName: string; atMs: number }
  | { kind: 'reply-cut-v13'; result: BargeInV13CutResult };

export type VoiceSessionV13EventSink = (event: VoiceSessionV13Event) => void;

/** Options for creating a `RealtimeVoiceSessionV13`. */
export interface VoiceSessionV13Options {
  sessionId: string;
  botId?: string;
  language?: string;
  voice?: string;
  vad?: VoiceSessionV12Options['vad'];
  bargeIn?: VoiceSessionV12Options['bargeIn'];
  turnTaking?: VoiceSessionV12Options['turnTaking'];
  tts?: VoiceSessionV12Options['tts'];
  /** Scripted mock replies, in order (last repeats). */
  mockReplies?: string[];
  /** Start a scripted mock reply on every user speech-end (default true). */
  autoReply?: boolean;
  bargeInV12?: VoiceSessionV12Options['bargeInV12'];
  ttsV12?: VoiceSessionV12Options['ttsV12'];
  turnMachine?: VoiceSessionV12Options['turnMachine'];
  endOfTurn?: VoiceSessionV12Options['endOfTurn'];
  overlap?: VoiceSessionV12Options['overlap'];
  /** Barge-in engine options (default: immediate policy). */
  bargeInV13?: BargeInV13Options;
  /** Clause TTS options. */
  ttsClauseV13?: TtsClauseV13Options;
  /** Smart Turn options. */
  smartTurnV13?: SmartTurnV13Options;
  /** Latency budget options. */
  latencyBudgetV13?: LatencyBudgetV13Options;
  /** Wake-word options. `startAsleep: false` disables gating (default: gating off — see below). */
  wakeWordV13?: WakeWordV13Options;
  /** Enable the wake-word gate (default false — sessions listen immediately, as in v12). */
  wakeWordEnabled?: boolean;
  /** Provider kind to use (default 'mock'). */
  providerKind?: VoiceProviderV13Kind;
  /** Options passed to the provider registry. */
  providerOptions?: VoiceProviderV13Options;
}

/** Counters for one v13 session (v12 stats + v13 layers). */
export interface VoiceSessionV13Stats extends VoiceSessionV12Stats {
  bargeInV13: BargeInV13Stats;
  clauseTts: TtsClauseV13Stats;
  smartTurn: SmartTurnV13Stats;
  latencyBudget: LatencyBudgetV13Stats;
  wakeWord: WakeWordV13Stats;
  /** Provider kind in use. */
  providerKind: string;
  /** True when the provider in use is ready. */
  providerReady: boolean;
  /** Mic frames ignored while the wake-word gate was asleep. */
  wakeIgnoredFrames: number;
  /** Clauses spoken for the current / last reply. */
  clauses: number;
}

/** In-memory registry options. */
export interface VoiceV13ManagerOptions {
  mockReplies?: string[];
}

/**
 * Realtime voice session v13: a v12 session plus the barge-in
 * engine, clause TTS, Smart Turn, latency budget, wake word
 * and a pluggable provider — one clock.
 */
export class RealtimeVoiceSessionV13 {
  private readonly sessionId: string;
  private readonly inner: RealtimeVoiceSessionV12;
  private readonly engine: BargeInEngineV13;
  private readonly clauseTts: ClauseTtsStreamV13;
  private readonly smartTurn: SmartTurnDetectorV13;
  private readonly latency: LatencyBudgetV13;
  private readonly wakeWord: WakeWordDetectorV13;
  private readonly providers: VoiceProviderRegistryV13;
  private provider: VoiceProviderV13;
  private readonly wakeWordEnabled: boolean;
  private readonly sink: VoiceSessionV13EventSink | null;
  private closed = false;
  private wakeIgnoredFrames = 0;
  private currentReplyText = '';

  constructor(options: VoiceSessionV13Options, sink: VoiceSessionV13EventSink | null = null) {
    this.sessionId = options.sessionId;
    this.sink = sink;
    this.wakeWordEnabled = options.wakeWordEnabled ?? false;
    this.engine = new BargeInEngineV13(options.bargeInV13 ?? {}, (event) => {
      this.sink?.({ kind: 'barge-in-v13', event });
    });
    this.clauseTts = new ClauseTtsStreamV13(options.ttsClauseV13 ?? {}, (event) => {
      this.sink?.({ kind: 'clause-tts', event });
    });
    this.engine.setTtsQueue(this.clauseTts);
    this.smartTurn = new SmartTurnDetectorV13(options.smartTurnV13 ?? {}, (event) => {
      this.sink?.({ kind: 'smart-turn', event });
      if (event.kind === 'turn-ended') this.sink?.({ kind: 'turn-ended-smart', decision: event.decision });
    });
    this.latency = new LatencyBudgetV13(options.latencyBudgetV13 ?? {}, (event) => {
      this.sink?.({ kind: 'latency', event });
    });
    this.wakeWord = new WakeWordDetectorV13(
      { ...(options.wakeWordV13 ?? {}), startAsleep: this.wakeWordEnabled ? true : false },
      (event) => this.sink?.({ kind: 'wake-word', event }),
    );
    this.providers = new VoiceProviderRegistryV13(options.providerOptions ?? {});
    const kind = options.providerKind ?? 'mock';
    const selected = this.providers.get(kind);
    if (!selected) throw new Error(`Voice v13 unknown provider kind "${kind}".`);
    this.provider = selected;
    this.inner = new RealtimeVoiceSessionV12(
      {
        sessionId: options.sessionId,
        ...(options.botId !== undefined ? { botId: options.botId } : {}),
        ...(options.language !== undefined ? { language: options.language } : {}),
        ...(options.voice !== undefined ? { voice: options.voice } : {}),
        ...(options.vad !== undefined ? { vad: options.vad } : {}),
        ...(options.bargeIn !== undefined ? { bargeIn: options.bargeIn } : {}),
        ...(options.turnTaking !== undefined ? { turnTaking: options.turnTaking } : {}),
        ...(options.tts !== undefined ? { tts: options.tts } : {}),
        ...(options.mockReplies !== undefined ? { mockReplies: options.mockReplies } : {}),
        ...(options.autoReply !== undefined ? { autoReply: options.autoReply } : {}),
        ...(options.bargeInV12 !== undefined ? { bargeInV12: options.bargeInV12 } : {}),
        ...(options.ttsV12 !== undefined ? { ttsV12: options.ttsV12 } : {}),
        ...(options.turnMachine !== undefined ? { turnMachine: options.turnMachine } : {}),
        ...(options.endOfTurn !== undefined ? { endOfTurn: options.endOfTurn } : {}),
        ...(options.overlap !== undefined ? { overlap: options.overlap } : {}),
      },
      (event) => this.onV12Event(event),
    );
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

  getStatus(): VoiceSessionV13Status {
    return this.inner.getStatus();
  }

  getNowMs(): number {
    return this.inner.getNowMs();
  }

  isConnected(): boolean {
    return this.inner.isConnected();
  }

  getInner(): RealtimeVoiceSessionV12 {
    return this.inner;
  }

  getBargeInEngine(): BargeInEngineV13 {
    return this.engine;
  }

  getClauseTts(): ClauseTtsStreamV13 {
    return this.clauseTts;
  }

  getSmartTurn(): SmartTurnDetectorV13 {
    return this.smartTurn;
  }

  getLatencyBudget(): LatencyBudgetV13 {
    return this.latency;
  }

  getWakeWord(): WakeWordDetectorV13 {
    return this.wakeWord;
  }

  getProvider(): VoiceProviderV13 {
    return this.provider;
  }

  getProviderRegistry(): VoiceProviderRegistryV13 {
    return this.providers;
  }

  /** Switch the provider in use (by kind). Throws on an unknown kind. */
  setProvider(kind: string): VoiceProviderV13 {
    const next = this.providers.get(kind);
    if (!next) throw new Error(`Voice v13 unknown provider kind "${kind}".`);
    this.provider = next;
    this.sink?.({ kind: 'provider-changed', kindName: kind, atMs: this.getNowMs() });
    return next;
  }

  /** Clauses spoken for the current / last reply. */
  getClauses(): TtsClauseV13[] {
    return this.clauseTts.getClauses();
  }

  /** Last interrupted utterance (v13 engine record), or null when none. */
  getLastInterrupt(): InterruptedUtteranceV12 | null {
    return this.engine.getLastInterrupt();
  }

  /** Text the user actually heard before the cuts (played parts kept). */
  getPlayedTranscript(): string {
    return this.engine.getPlayedTranscript();
  }

  /** Latency stage reports (budget vs reality). */
  getLatencyReports(): LatencyBudgetV13StageReport[] {
    return this.latency.getStageReports();
  }

  /** Last turn latency report, or null when none. */
  getLastLatencyTurn(): LatencyBudgetV13TurnReport | null {
    return this.latency.getLastTurn();
  }

  getStats(): VoiceSessionV13Stats {
    const v12 = this.inner.getStats();
    return {
      ...v12,
      bargeInV13: this.engine.getStats(),
      clauseTts: this.clauseTts.getStats(),
      smartTurn: this.smartTurn.getStats(),
      latencyBudget: this.latency.getStats(),
      wakeWord: this.wakeWord.getStats(),
      providerKind: this.provider.kind,
      providerReady: this.provider.isReady(),
      wakeIgnoredFrames: this.wakeIgnoredFrames,
      clauses: this.clauseTts.getClauses().length,
    };
  }

  getSummary(): string {
    const s = this.getStats();
    return (
      `Realtime v13: ${s.state}, ${s.turns} turns, ${s.bargeInV13.cuts} barge-in cuts, ` +
      `${s.clauses} clauses (first ${s.clauseTts.firstClauseLatencyMs === null ? '-' : `${s.clauseTts.firstClauseLatencyMs} ms`}), ` +
      `smart turns ${s.smartTurn.turns}, wake word ${s.wakeWord.state}, provider ${s.providerKind}${s.providerReady ? '' : ' (not ready)'}`
    );
  }

  transcriptMarkdown(): string {
    const s = this.getStats();
    return [
      this.inner.transcriptMarkdown(),
      '',
      `## Voice v13 — ${this.sessionId}`,
      '',
      `- provider: ${s.providerKind} (${s.providerReady ? 'ready' : `not ready: ${this.provider.readinessReason()}`})`,
      `- wake word: ${s.wakeWord.state} (ignored frames: ${s.wakeIgnoredFrames})`,
      `- played transcript kept: ${this.getPlayedTranscript() || '-'}`,
      '',
      `Clauses: ${s.clauses}, first-clause latency: ${s.clauseTts.firstClauseLatencyMs === null ? '-' : `${s.clauseTts.firstClauseLatencyMs} ms`}`,
    ].join('\n');
  }

  /** Open the session (mock transport — no socket, no key) and start listening. */
  async connect(): Promise<void> {
    await this.inner.connect();
  }

  /** Close the session intentionally (no reconnect). */
  disconnect(): void {
    if (this.closed) return;
    this.closed = true;
    this.inner.disconnect();
  }

  /**
   * Feed one 20 ms PCM16 mic frame. While the wake-word gate
   * is asleep the frame is counted and dropped (the room is
   * not listened to). Otherwise it goes to the inner session.
   */
  feedAudio(frame: Uint8Array, input: { echo?: boolean } = {}): void {
    if (!isValidPcm16Frame(frame)) {
      throw new Error('Realtime v13 expects a 20 ms PCM16 frame (320 samples at 16 kHz).');
    }
    if (this.wakeWordEnabled && !this.wakeWord.isActive()) {
      this.wakeIgnoredFrames += 1;
      this.sink?.({ kind: 'wake-ignored-frame', atMs: this.getNowMs() });
      return;
    }
    this.inner.feedAudio(frame, input);
  }

  /** Advance the virtual clock (drives TTS, cooldowns, timeouts, wake-word auto-sleep). */
  tick(ms: number): void {
    this.inner.tick(ms);
    this.clauseTts.tick(ms);
    this.wakeWord.tick(this.getNowMs());
    this.smartTurn.noteSilence(ms);
  }

  /**
   * Feed a partial transcript from the host STT: wakes the
   * session when the keyword is heard, feeds Smart Turn, and
   * feeds the v12 interrupt context / overlap tracker as user
   * words. Returns the Smart Turn decision (or null when no
   * decision was taken yet).
   */
  noteTranscript(text: string, atMs?: number): SmartTurnV13Decision | null {
    const nowMs = atMs ?? this.getNowMs();
    const activation = this.wakeWord.noteTranscript(text, nowMs);
    void activation;
    this.smartTurn.notePartialText(text, nowMs);
    const words = text.trim().split(/\s+/).filter((w) => w.length > 0);
    for (const word of words) this.inner.noteUserWord(word, nowMs);
    return this.smartTurn.decide(nowMs);
  }

  /** Wake the session now, without a transcript (host button / test). */
  wakeNow(atMs?: number): WakeWordV13Activation | null {
    const nowMs = atMs ?? this.getNowMs();
    return this.wakeWord.noteTranscript(this.wakeWord.getKeywords()[0] ?? 'hey bot', nowMs);
  }

  /** Put the session back to sleep (wake-word gate only; the inner session stays connected). */
  sleepNow(atMs?: number): void {
    this.wakeWord.sleep(atMs ?? this.getNowMs(), 'explicit');
  }

  /** Record one measured latency stage sample for the current turn. */
  recordLatencyStage(turnId: string, stage: LatencyBudgetV13Stage, ms: number): LatencyBudgetV13StageReport {
    return this.latency.recordStage({ turnId, stage, ms, atMs: this.getNowMs() });
  }

  /** Change one stage's latency budget (ms). Returns the new budget. */
  setLatencyBudget(stage: LatencyBudgetV13Stage, ms: number): number {
    return this.latency.setBudget(stage, ms);
  }

  /** Record a whole turn's latency at once. */
  recordLatencyTurn(turnId: string, stages: Partial<Record<LatencyBudgetV13Stage, number>>): LatencyBudgetV13TurnReport {
    return this.latency.recordTurn(turnId, stages, this.getNowMs());
  }

  /** Feed streaming reply text (model deltas); `final` flushes the tail clause. */
  feedTextDelta(delta: string, input: { final?: boolean } = {}): { clauses: TtsClauseV13[] } {
    const fed = this.clauseTts.feedTextDelta(delta, { final: input.final, atMs: this.getNowMs() });
    return { clauses: fed.clauses };
  }

  /**
   * Start speaking a reply: plan clauses immediately (first
   * clause out at once), arm the barge-in engine, then speak
   * through the v12 session. Returns false when the agent is
   * already speaking / thinking.
   */
  speakReply(text: string): boolean {
    if (typeof text !== 'string' || text.trim().length === 0) {
      throw new Error('Realtime v13 speakReply needs non-empty text.');
    }
    const started = this.inner.speakReply(text);
    if (!started) return false;
    this.currentReplyText = text.trim();
    this.engine.beginSpeaking(text.trim(), this.getNowMs());
    this.clauseTts.feedTextDelta(text.trim(), { final: true, atMs: this.getNowMs() });
    return true;
  }

  /** Drive one scripted mock turn without real audio. */
  async simulateTurn(userText: string, modelReply?: string): Promise<boolean> {
    return this.inner.simulateTurn(userText, modelReply);
  }

  /**
   * Interrupt the agent reply now (explicit user action): cut
   * the inner playback first — its 'reply-cut' event records
   * the cut in the v13 engine (scope + clause flush + record).
   * Only when the inner session had nothing to cut does the
   * engine cut its own mirror directly.
   */
  interrupt(reason = 'user'): BargeInV13CutResult | null {
    const innerResult = this.inner.interrupt(reason);
    if (innerResult && innerResult.interrupted) {
      return this.engine.getLastCut();
    }
    return this.engine.cutNow(this.getNowMs(), reason);
  }

  /** Resume the last interrupted reply under its strategy (v12 resume). */
  resumeReply(strategy?: Parameters<RealtimeVoiceSessionV12['resumeReply']>[0]): boolean {
    return this.inner.resumeReply(strategy);
  }

  /** Feed one partial-STT word the user spoke (interruption / overlap transcript). */
  noteUserWord(word: string, atMs?: number, confidence = 1): void {
    const nowMs = atMs ?? this.getNowMs();
    this.engine.noteUserWord(word, nowMs, confidence);
    this.inner.noteUserWord(word, nowMs, confidence);
  }

  /** Duck playback while the user speaks over the agent. */
  duck(): boolean {
    return this.inner.duck();
  }

  /** Restore playback volume after ducking. */
  resumePlayback(): boolean {
    return this.inner.resumePlayback();
  }

  /** Pause TTS playback (keeps the queue). */
  pauseTts(): boolean {
    return this.inner.pauseTts();
  }

  /** Resume TTS playback after a pause. */
  resumeTts(): boolean {
    return this.inner.resumeTts();
  }

  private onV12Event(event: VoiceSessionV12Event): void {
    // The inner session already made the cut on a VAD
    // speech-start (its own policy). Record it in the v13
    // engine too: cancel the stale scope, flush clause TTS
    // and keep the played text in the transcript.
    if (event.kind === 'v11' && event.event.kind === 'reply-cut') {
      const cut = this.engine.recordObservedCut({
        receipt: event.event.result,
        tts: event.event.tts,
        replyText: this.currentReplyText,
        atMs: event.event.atMs,
      });
      if (cut) this.sink?.({ kind: 'reply-cut-v13', result: cut });
    }
    this.sink?.({ kind: 'v12', event });
  }
}

/** Create a v13 session (factory). */
export function createRealtimeVoiceSessionV13(options: VoiceSessionV13Options, sink: VoiceSessionV13EventSink | null = null): RealtimeVoiceSessionV13 {
  return new RealtimeVoiceSessionV13(options, sink);
}

/**
 * In-memory registry of v13 sessions. Everything is local:
 * sessions run on the mock TTS synth unless the host wires a
 * live provider; no key is ever read here.
 */
export class VoiceV13Manager {
  private readonly sessions = new Map<string, RealtimeVoiceSessionV13>();
  private readonly mockReplies: string[] | undefined;

  constructor(options: VoiceV13ManagerOptions = {}) {
    this.mockReplies = options.mockReplies;
  }

  create(options: VoiceSessionV13Options & { connectNow?: boolean }): RealtimeVoiceSessionV13 {
    if (this.sessions.has(options.sessionId)) {
      throw new Error(`Voice v13 session "${options.sessionId}" already exists.`);
    }
    const session = new RealtimeVoiceSessionV13(
      { ...(this.mockReplies ? { mockReplies: this.mockReplies } : {}), ...options },
      null,
    );
    this.sessions.set(options.sessionId, session);
    if (options.connectNow) void session.connect();
    return session;
  }

  get(sessionId: string): RealtimeVoiceSessionV13 | undefined {
    return this.sessions.get(sessionId);
  }

  list(): RealtimeVoiceSessionV13[] {
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

/** Create a v13 session manager (factory). */
export function createVoiceV13Manager(options: VoiceV13ManagerOptions = {}): VoiceV13Manager {
  return new VoiceV13Manager(options);
}

/** One-line summary of a v13 session's stats. */
export function voiceSessionV13Summary(stats: VoiceSessionV13Stats): string {
  return (
    `Voice v13 session ${stats.sessionId} (${stats.botId}, ${stats.language}/${stats.voice || 'default'}): ` +
    `${stats.state}, ${stats.turns} turns, ${stats.bargeInV13.cuts} barge-in cuts, ` +
    `${stats.clauses} clauses, smart turns ${stats.smartTurn.turns}, ` +
    `wake word ${stats.wakeWord.state}, provider ${stats.providerKind}`
  );
}

/** Session stats as Markdown (for the diagnostics panel). */
export function voiceSessionV13Markdown(stats: VoiceSessionV13Stats): string {
  const lines = [
    `# Voice session v13 — ${stats.sessionId}`,
    '',
    `- state: ${stats.state}, bot: ${stats.botId}, language: ${stats.language}, voice: ${stats.voice || 'default'}`,
    `- turns: ${stats.turns} (user ${stats.userTurns}, agent ${stats.agentTurns})`,
    `- barge-in cuts: ${stats.bargeInV13.cuts}, clauses: ${stats.clauses}`,
    `- smart turns: ${stats.smartTurn.turns} (backchannels ${stats.smartTurn.backchannels})`,
    `- wake word: ${stats.wakeWord.state}, provider: ${stats.providerKind} (${stats.providerReady ? 'ready' : 'not ready'})`,
    `- now: ${stats.nowMs} ms`,
  ];
  return lines.join('\n');
}

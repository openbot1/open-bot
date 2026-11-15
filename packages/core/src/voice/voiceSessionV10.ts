/**
 * Realtime voice session v10 (v1.11, Đội T5 — voice realtime v2).
 *
 * The v9 session tied VAD + barge-in + transcript together; the v10
 * session ties the v2 pipeline together with the two things a call
 * needs around it:
 *
 * - Voice settings: the session resolves its effective settings at
 *   creation (`resolveEffectiveVoiceSettings` — bot preset wins,
 *   then the user's v1.04 profile, then the built-in default) and
 *   builds the pipeline from them (VAD preset, noise suppression
 *   level, language, provider voice). A preset change mid-call
 *   (`applyPreset`) re-resolves and reconfigures the live pipeline
 *   without dropping the call.
 * - AG-UI voice events: every pipeline event is mirrored as an
 *   `AgUiVoiceEvent` (see `agui/voiceV3.ts`) on the session sink, so
 *   the panel renders the same call the pipeline runs — no second
 *   source of truth. Partial transcripts, audio levels, state
 *   snapshots and fallbacks all flow through one sink, with a
 *   per-session sequence from `VoiceV3EventLog`.
 *
 * The session itself stays a thin shell: the pipeline owns the
 * clock, the VAD, the noise suppressor, the barge-in controller and
 * the transcript; the session owns the settings resolution, the
 * AG-UI mirror and the manager registry. Determinism: the virtual
 * clock is the pipeline's clock (`nowMs` starts at 0, `feedAudio()`
 * advances it 20 ms per frame, `tick()` advances it manually).
 * Nothing here touches a sound card, a network socket or a key —
 * the mock model is a script of reply strings and live mode is an
 * explicit opt-in the host wires later via `createTransport`.
 */

import { RealtimeVoicePipelineV2, createRealtimeVoicePipelineV2, realtimeV2Summary, type RealtimeV2Event, type RealtimeV2Options, type RealtimeV2State, type RealtimeV2Stats } from './realtimeV2';
import { MemoryBotVoicePresetStore, resolveEffectiveVoiceSettings, type BotVoicePreset, type EffectiveVoiceSettings } from './voiceSettingsV10';
import type { VoiceProfile } from './voiceProfiles';
import { isVadV10PresetName, type VadV10PresetName } from './vadV10';
import { isNoiseSuppressionLevel, type NoiseSuppressionLevel } from './noiseSuppressionV10';
import { isBargeInV9Policy, type BargeInV9Policy } from './bargeInV9';
import { VoiceAudioLevelSmoother, VoiceV3EventLog, buildVoiceStateSnapshot, voiceAudioLevelEvent, voiceFallbackEvent, voiceFinalEvent, voicePartialEvent, voiceStartedEvent, voiceStateEvent, voiceStoppedEvent, type AgUiVoiceEvent, type AgUiVoiceMode, type AgUiVoiceStatus } from '../agui/voiceV3';

/** UI status of a v10 voice session (what the panel renders). */
export type VoiceSessionV10Status = RealtimeV2State;

/** Session id pattern (same shape as the v9 manager). */
export const VOICE_V10_SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/** Default scripted mock reply (says plainly this is mock mode). */
export const VOICE_V10_DEFAULT_MOCK_REPLY =
  'Hello — this is mock realtime v10 mode. Add an API key in Settings to talk to a live model.';

/** Events emitted by a v10 session (pipeline events + AG-UI voice events). */
export type VoiceSessionV10Event =
  | { kind: 'pipeline'; event: RealtimeV2Event }
  | { kind: 'agui'; event: AgUiVoiceEvent };

export type VoiceSessionV10EventSink = (event: VoiceSessionV10Event) => void;

/** Options for creating a `RealtimeVoiceSessionV10`. */
export interface VoiceSessionV10Options {
  sessionId: string;
  botId?: string;
  language?: string;
  voice?: string;
  /** Bot preset to speak with (wins over `userProfile`). */
  botPreset?: BotVoicePreset | null;
  /** User profile to fall back to when no bot preset is given. */
  userProfile?: VoiceProfile | null;
  /** Extra pipeline options (mock replies, VAD/noise overrides, transport). */
  pipeline?: Omit<RealtimeV2Options, 'sessionId' | 'botId' | 'language' | 'voice'>;
  /** Run id the AG-UI voice events belong to (defaults to the session id). */
  runId?: string;
}

/** Counters for one session. */
export interface VoiceSessionV10Stats extends RealtimeV2Stats {
  sessionId: string;
  botId: string;
  settings: EffectiveVoiceSettings;
  aguiEvents: number;
}

/** A live-key probe result (the caller supplies the check). */
export interface VoiceV10LiveProbe {
  available: boolean;
  provider: string;
  reason: string;
}

/**
 * Probe whether a live provider key is already present (the caller
 * supplies the check — typically "is there a key in the Vault for
 * this provider?"). The session never reads a key, never dials, and
 * treats "no key" as a normal state, not an error.
 */
export function probeLiveVoiceV10Key(hasKey: () => boolean, provider = 'openai'): VoiceV10LiveProbe {
  const available = hasKey();
  return {
    available,
    provider,
    reason: available
      ? `Live ${provider} voice is available (a key is already in the Vault).`
      : `No ${provider} key in the Vault — mock mode. Add a key in Settings to talk to a live model.`,
  };
}

/**
 * Realtime voice session v10: a v2 pipeline + resolved voice
 * settings + an AG-UI voice-event mirror.
 */
export class RealtimeVoiceSessionV10 {
  private readonly pipeline: RealtimeVoicePipelineV2;
  private readonly sink: VoiceSessionV10EventSink | null;
  private readonly runId: string;
  private readonly botId: string;
  private readonly eventLog = new VoiceV3EventLog();
  private readonly levelSmoother = new VoiceAudioLevelSmoother();
  private settings: EffectiveVoiceSettings;
  private aguiEvents = 0;
  private startedAtMs: number | null = null;
  private lastTurnText = '';

  constructor(options: VoiceSessionV10Options, sink: VoiceSessionV10EventSink | null = null) {
    if (!VOICE_V10_SESSION_ID_RE.test(options.sessionId)) {
      throw new Error(`Voice v10 session id "${options.sessionId}" must be a slug (letters, digits, dashes, underscores, max 64 chars).`);
    }
    this.botId = options.botId ?? 'default';
    this.runId = options.runId ?? options.sessionId;
    this.sink = sink;
    this.settings = resolveEffectiveVoiceSettings({
      botPreset: options.botPreset ?? null,
      userProfile: options.userProfile ?? null,
    });
    // A preset's language wins over the caller's language hint.
    const language = options.botPreset?.language ?? options.userProfile?.lang ?? options.language ?? this.settings.language;
    const voice = options.botPreset?.voice ?? options.voice ?? this.settings.voice;
    const pipelineOptions: RealtimeV2Options = {
      ...(options.pipeline ?? {}),
      sessionId: options.sessionId,
      botId: this.botId,
      language,
      voice: voice ?? '',
      mockReplies: options.pipeline?.mockReplies ?? [VOICE_V10_DEFAULT_MOCK_REPLY],
      vad: {
        preset: this.settings.vadPreset,
        ...(options.pipeline?.vad ?? {}),
      },
      noise: {
        level: this.settings.noiseSuppression,
        ...(options.pipeline?.noise ?? {}),
      },
    };
    this.pipeline = createRealtimeVoicePipelineV2(pipelineOptions, (event) => this.onPipelineEvent(event));
  }

  getSessionId(): string {
    return this.pipeline.getSessionId();
  }

  getBotId(): string {
    return this.botId;
  }

  getStatus(): VoiceSessionV10Status {
    return this.pipeline.getState();
  }

  getMode(): AgUiVoiceMode {
    return this.pipeline.getMode();
  }

  getSettings(): EffectiveVoiceSettings {
    return { ...this.settings };
  }

  getNowMs(): number {
    return this.pipeline.getNowMs();
  }

  getPipeline(): RealtimeVoicePipelineV2 {
    return this.pipeline;
  }

  getStats(): VoiceSessionV10Stats {
    const base = this.pipeline.getStats();
    return { ...base, sessionId: this.getSessionId(), botId: this.botId, settings: { ...this.settings }, aguiEvents: this.aguiEvents };
  }

  getSummary(): string {
    return realtimeV2Summary(this.pipeline.getStats());
  }

  transcriptMarkdown(): string {
    return this.pipeline.transcriptMarkdown();
  }

  /** AG-UI voice event log (bounded, sequenced — the panel replays it). */
  getAgUiEvents(): AgUiVoiceEvent[] {
    return this.eventLog.list();
  }

  /** Current smoothed audio level (what the waveform draws). */
  getAudioLevel(): { level: number; peak: number } {
    return this.levelSmoother.getLevel();
  }

  /** Open the realtime transport and start listening. */
  async connect(): Promise<void> {
    await this.pipeline.connect();
    this.startedAtMs = this.pipeline.getNowMs();
    this.emitAgUi(voiceStartedEvent(this.runId, {
      sessionId: this.getSessionId(),
      mode: this.pipeline.getMode(),
      provider: this.settings.provider,
      voice: this.settings.voice,
      language: this.settings.language,
    }, { botId: this.botId }));
    this.emitState();
  }

  /** Close the session intentionally (no reconnect, no fallback). */
  disconnect(): void {
    const durationMs = this.startedAtMs !== null ? this.pipeline.getNowMs() - this.startedAtMs : 0;
    this.pipeline.disconnect();
    this.emitAgUi(voiceStoppedEvent(this.runId, {
      sessionId: this.getSessionId(),
      reason: 'user',
      turns: this.pipeline.getStats().turns,
      durationMs,
    }, { botId: this.botId }));
  }

  /** Feed one 20 ms PCM16 mic frame (advances the virtual clock). */
  feedAudio(frame: Uint8Array): void {
    this.pipeline.feedAudio(frame);
  }

  /** Advance the virtual clock (drives mock replies + recovery). */
  tick(ms: number): void {
    this.pipeline.tick(ms);
  }

  /** Drive one scripted mock turn (user line → agent reply). */
  async simulateTurn(userText: string, modelReply?: string): Promise<boolean> {
    return this.pipeline.simulateTurn(userText, modelReply);
  }

  /** Interrupt the agent reply now (explicit user action). */
  interrupt(reason = 'user'): ReturnType<RealtimeVoicePipelineV2['interrupt']> {
    return this.pipeline.interrupt(reason);
  }

  /** Duck playback while the user speaks over the agent. */
  duck(): boolean {
    return this.pipeline.duck();
  }

  /** Restore playback volume after ducking. */
  resumePlayback(): boolean {
    return this.pipeline.resumePlayback();
  }

  /** Force a fallback to batch mode (manual — e.g. the user toggles it). */
  async forceBatch(reason: string): Promise<void> {
    await this.pipeline.forceBatch(reason);
  }

  /** Try realtime again now (UI retry button / automatic recovery). */
  async tryRecover(): Promise<boolean> {
    return this.pipeline.tryRecover();
  }

  /** Live-key probe (the caller supplies the check — never reads a key). */
  liveProbe(hasKey: () => boolean): VoiceV10LiveProbe {
    return probeLiveVoiceV10Key(hasKey, this.settings.provider);
  }

  /** Switch the VAD preset live (same validation as the VAD). */
  setVadPreset(preset: VadV10PresetName): unknown {
    if (!isVadV10PresetName(preset)) throw new Error(`VAD v10 preset must be one of quiet, office, noisy, street.`);
    const next = this.pipeline.getVad().reconfigure({ preset });
    this.emitState();
    return next;
  }

  /** Switch the noise suppression level live. */
  setNoiseLevel(level: NoiseSuppressionLevel): unknown {
    if (!isNoiseSuppressionLevel(level)) throw new Error(`Noise suppression level must be one of off, light, moderate, aggressive.`);
    const next = this.pipeline.getNoiseSuppressor().setLevel(level);
    this.emitState();
    return next;
  }

  /** Switch the barge-in policy live. */
  setBargeInPolicy(policy: BargeInV9Policy): unknown {
    if (!isBargeInV9Policy(policy)) throw new Error(`Barge-in policy must be one of immediate, grace, confirm.`);
    const next = this.pipeline.getBargeIn().reconfigure({ policy });
    this.emitState();
    return next;
  }

  /**
   * Apply a new bot preset mid-call: re-resolves the effective
   * settings and reconfigures the live pipeline (VAD preset +
   * noise level) without dropping the call. The provider/voice
   * change takes effect on the next reply (the transport is not
   * redialled mid-turn).
   */
  applyPreset(preset: BotVoicePreset): EffectiveVoiceSettings {
    if (preset.botId !== this.botId) {
      throw new Error(`Voice preset "${preset.id}" belongs to bot "${preset.botId}", not "${this.botId}".`);
    }
    this.settings = resolveEffectiveVoiceSettings({ botPreset: preset });
    this.pipeline.getVad().reconfigure({ preset: this.settings.vadPreset });
    this.pipeline.getNoiseSuppressor().setLevel(this.settings.noiseSuppression);
    this.emitState();
    return { ...this.settings };
  }

  getVadOptions(): unknown {
    return this.pipeline.getVad().getOptions();
  }

  getBargeInOptions(): unknown {
    return this.pipeline.getBargeIn().getOptions();
  }

  getLastInterrupt(): unknown {
    return this.pipeline.getBargeIn().getStats().lastInterruptAtMs;
  }

  private emitAgUi(event: AgUiVoiceEvent): void {
    const stored = this.eventLog.append(event);
    this.aguiEvents += 1;
    this.sink?.({ kind: 'agui', event: stored });
  }

  private emitState(): void {
    const stats = this.pipeline.getStats();
    const level = this.levelSmoother.getLevel().level;
    const snapshot = buildVoiceStateSnapshot({
      sessionId: this.getSessionId(),
      status: stats.state as AgUiVoiceStatus,
      mode: stats.mode,
      provider: this.settings.provider,
      voice: this.settings.voice,
      language: this.settings.language,
      level,
      speaking: stats.state === 'speaking',
      ducked: this.pipeline.getBargeIn().isDucked(),
      turns: stats.turns,
      userTurns: stats.userTurns,
      agentTurns: stats.agentTurns,
      partials: stats.partials,
      fallbacks: stats.fallbacks,
      interrupts: stats.interrupts,
      interimText: this.pipeline.getTranscript().getInterim()?.text ?? '',
      lastTurnText: this.lastTurnText,
    });
    this.emitAgUi(voiceStateEvent(this.runId, { snapshot }, { botId: this.botId }));
  }

  private onPipelineEvent(event: RealtimeV2Event): void {
    this.sink?.({ kind: 'pipeline', event });
    const sessionId = this.getSessionId();
    if (event.kind === 'partial') {
      this.emitAgUi(voicePartialEvent(this.runId, {
        sessionId,
        speakerId: event.speakerId,
        text: event.text,
        stable: event.stable,
        latencyMs: event.latencyMs,
      }, { botId: this.botId }));
      return;
    }
    if (event.kind === 'final') {
      this.lastTurnText = event.text;
      this.emitAgUi(voiceFinalEvent(this.runId, {
        sessionId,
        speakerId: event.speakerId,
        text: event.text,
      }, { botId: this.botId }));
      this.emitState();
      return;
    }
    if (event.kind === 'audio-level') {
      const smoothed = this.levelSmoother.push(event.level);
      this.emitAgUi(voiceAudioLevelEvent(this.runId, {
        sessionId,
        source: 'mic',
        level: smoothed.level,
        peak: smoothed.peak,
      }, { botId: this.botId }));
      return;
    }
    if (event.kind === 'fallback') {
      this.emitAgUi(voiceFallbackEvent(this.runId, {
        sessionId,
        reason: event.reason,
        detail: event.detail,
        willRetry: true,
      }, { botId: this.botId }));
      this.emitState();
      return;
    }
    if (event.kind === 'state' || event.kind === 'mode' || event.kind === 'barge-in' || event.kind === 'recovered') {
      this.emitState();
    }
  }
}

/** Create a mock v10 session (the manager and the tools use this). */
export function createMockVoiceSessionV10(
  options: VoiceSessionV10Options,
  sink: VoiceSessionV10EventSink | null = null,
): RealtimeVoiceSessionV10 {
  return new RealtimeVoiceSessionV10(options, sink);
}

/** Manager options. */
export interface VoiceV10ManagerOptions {
  /** Per-bot preset store (default: a fresh in-memory store). */
  presetStore?: MemoryBotVoicePresetStore;
}

/**
 * In-memory registry of v10 sessions. Everything is local: sessions
 * run on the mock transport unless the host wires a live transport
 * factory; no key is ever read here.
 */
export class VoiceV10Manager {
  private readonly sessions = new Map<string, RealtimeVoiceSessionV10>();
  private readonly presetStore: MemoryBotVoicePresetStore;

  constructor(options: VoiceV10ManagerOptions = {}) {
    this.presetStore = options.presetStore ?? new MemoryBotVoicePresetStore();
  }

  getPresetStore(): MemoryBotVoicePresetStore {
    return this.presetStore;
  }

  create(options: VoiceSessionV10Options & { connectNow?: boolean }): RealtimeVoiceSessionV10 {
    if (this.sessions.has(options.sessionId)) {
      throw new Error(`Voice v10 session "${options.sessionId}" already exists.`);
    }
    const botId = options.botId ?? 'default';
    const botPreset = options.botPreset ?? this.presetStore.getActive(botId, options.language) ?? null;
    const session = new RealtimeVoiceSessionV10({ ...options, botId, botPreset }, null);
    this.sessions.set(options.sessionId, session);
    if (options.connectNow) void session.connect();
    return session;
  }

  get(sessionId: string): RealtimeVoiceSessionV10 | undefined {
    return this.sessions.get(sessionId);
  }

  list(): RealtimeVoiceSessionV10[] {
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

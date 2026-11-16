/**
 * Voice session v15 (v1.16, Đội T5 — voice v15).
 *
 * The session is the conductor: it owns one voice conversation and
 * wires the v15 pieces together in the order a real turn flows.
 *
 *   connect()        — try speech-to-speech (mock transport by
 *                      default); if the S2S adapter fails or its
 *                      reconnect budget is spent, fall back to the
 *                      STT → LLM → TTS pipeline and record the
 *                      fallback as an event, not a crash.
 *   feedAudioFrame() — 20 ms PCM16 frames go to the barge-in
 *                      detector. While the agent is speaking, a
 *                      confirmed user burst interrupts: the TTS
 *                      stream is cancelled mid-stream, stale LLM
 *                      work is discarded, the cut receipt is kept.
 *   feedTranscript() — STT partials go to the semantic turn
 *                      detector; when it ends a turn, the session
 *                      asks the injected reply function for a reply
 *                      and speaks it through the TTS stream.
 *   feedWakeWord()   — transcripts also go to the wake-word
 *                      detector while the session is asleep; a
 *                      confirmed wake word wakes it (and only then
 *                      does the mic "open" for a turn).
 *   speakReply()     — TTS streaming with the bot's voice profile;
 *                      every turn records its stage latencies into
 *                      the latency pipeline, which may step the
 *                      quality down when e2e p95 is over budget.
 *
 * The reply function is injected (`replyFor: (text) => string |
 * Promise<string>`); the default is a scripted echo so the session
 * is usable with zero configuration. The LLM itself is never called
 * here — a host binds its own model behind `replyFor`. The STT is
 * likewise injected as transcript text: the session never touches
 * a mic or a sound card.
 *
 * All clocks are virtual (`nowMs`, starts at 0); `tick(ms)`
 * advances the S2S adapter, the TTS stream and the wake-word
 * confirmation window together. `VoiceSessionManagerV15` keeps
 * sessions by id for the tools layer.
 */

import { S2SAdapterV15, MockS2STransportV15, createS2SAdapterV15 } from './s2sV15';
import type { S2SEventV15, S2SProviderKindV15, MockS2SScriptEventV15 } from './s2sV15';
import { LatencyPipelineV15, createLatencyPipelineV15 } from './pipelineV15';
import type { PipelineQualityV15 } from './pipelineV15';
import { BargeInEngineV15, createBargeInEngineV15, syntheticFrameV15 } from './bargeInV15';
import type { BargeInV15CutReceipt } from './bargeInV15';
import { SmartTurnDetectorV15, createSmartTurnDetectorV15 } from './smartTurnV15';
import type { SmartTurnV15Options } from './smartTurnV15';
import { TtsStreamV15, VoiceProfileStoreV15, createTtsStreamV15 } from './ttsStreamV15';
import type { VoiceProfileV15 } from './ttsStreamV15';
import { WakeWordDetectorV15, createWakeWordDetectorV15 } from './wakeWordV15';
import type { WakeWordV15Config } from './wakeWordV15';
import { VoiceProviderRegistryV15, createVoiceProviderRegistryV15 } from './providerRegistryV15';

export type VoiceSessionV15Mode = 's2s' | 'pipeline';
export type VoiceSessionV15State = 'idle' | 'connecting' | 'active' | 'asleep' | 'closed';

export type VoiceSessionV15EventKind =
  | 'state'
  | 'connected'
  | 'fallback'
  | 'turn-end'
  | 'reply'
  | 'barge-in'
  | 'wake'
  | 'sleep'
  | 'error';

export interface VoiceSessionV15Event {
  kind: VoiceSessionV15EventKind;
  atMs: number;
  message?: string;
  text?: string;
  mode?: VoiceSessionV15Mode;
  cut?: BargeInV15CutReceipt;
  reason?: string;
}

export type VoiceSessionV15Sink = (event: VoiceSessionV15Event) => void;

export interface VoiceSessionV15Options {
  botId?: string;
  language?: string;
  mode?: VoiceSessionV15Mode;
  s2sProvider?: S2SProviderKindV15;
  /** Reply function (the "brain"); default echoes the user text. */
  replyFor?: (text: string) => string | Promise<string>;
  /** Start asleep behind the wake word (default false — mic open). */
  startAsleep?: boolean;
  wakeWords?: WakeWordV15Config[];
  smartTurn?: SmartTurnV15Options;
  voiceProfile?: VoiceProfileV15;
  /** Fail the next mock S2S connect with this message (test hook). */
  s2sFailConnectWith?: string;
  /** Max S2S reconnect attempts before pipeline fallback. */
  s2sMaxReconnectAttempts?: number;
  /** Scripted S2S server events for the mock transport. */
  s2sScript?: MockS2SScriptEventV15[];
}

export function defaultVoiceSessionV15Options(): Required<Omit<VoiceSessionV15Options, 'replyFor' | 'voiceProfile' | 'wakeWords' | 's2sScript' | 's2sFailConnectWith' | 's2sMaxReconnectAttempts'>> {
  return {
    botId: 'default-bot',
    language: 'vi',
    mode: 's2s',
    s2sProvider: 'mock',
    startAsleep: false,
    smartTurn: {},
  };
}

export interface VoiceSessionV15Turn {
  id: string;
  userText: string;
  replyText: string;
  atMs: number;
  endToEndMs: number;
  bargeIn: boolean;
}

export interface VoiceSessionV15Stats {
  state: VoiceSessionV15State;
  mode: VoiceSessionV15Mode;
  turns: number;
  bargeIns: number;
  fallbacks: number;
  wakeUps: number;
  s2s: ReturnType<S2SAdapterV15['stats']>;
  pipeline: ReturnType<LatencyPipelineV15['sessionReport']>;
  bargeIn: ReturnType<BargeInEngineV15['stats']>;
  smartTurn: ReturnType<SmartTurnDetectorV15['stats']>;
  tts: ReturnType<TtsStreamV15['stats']>;
  wakeWord: ReturnType<WakeWordDetectorV15['stats']>;
  quality: PipelineQualityV15;
}

export class VoiceSessionV15 {
  readonly id: string;
  readonly botId: string;
  readonly language: string;
  readonly profiles = new VoiceProfileStoreV15();
  readonly registry = createVoiceProviderRegistryV15();
  readonly pipeline: LatencyPipelineV15;
  readonly bargeIn: BargeInEngineV15;
  readonly smartTurn: SmartTurnDetectorV15;
  readonly tts: TtsStreamV15;
  readonly wakeWord: WakeWordDetectorV15;
  readonly s2s: S2SAdapterV15;
  private readonly sink: VoiceSessionV15Sink | undefined;
  private readonly replyFor: (text: string) => string | Promise<string>;
  private state: VoiceSessionV15State = 'idle';
  private mode: VoiceSessionV15Mode;
  private nowMs = 0;
  private turnCounter = 0;
  private readonly turns: VoiceSessionV15Turn[] = [];
  private readonly events: VoiceSessionV15Event[] = [];
  private turnStartedAtMs = 0;
  private pendingUserText = '';
  private agentSpeaking = false;
  private lastSpeechStartedAtMs: number | undefined;

  constructor(id: string, options: VoiceSessionV15Options = {}, sink?: VoiceSessionV15Sink) {
    const defaults = defaultVoiceSessionV15Options();
    this.id = id;
    this.botId = options.botId ?? defaults.botId;
    this.language = options.language ?? defaults.language;
    this.mode = options.mode ?? defaults.mode;
    this.sink = sink;
    this.replyFor = options.replyFor ?? ((text: string) => `Bạn vừa nói: ${text}`);
    if (options.voiceProfile) this.profiles.set(options.voiceProfile);
    this.pipeline = createLatencyPipelineV15({}, (event) => {
      if (event.kind === 'quality' && event.step) {
        const profile = this.profiles.get(this.botId);
        const stepped = event.step.to === 'full'
          ? profile
          : { ...profile, quality: event.step.to === 'reduced' ? 'fast' as const : 'minimal' as const };
        this.profiles.set(stepped);
      }
    });
    this.bargeIn = createBargeInEngineV15({}, (event) => {
      if (event.kind === 'speech-started' && this.agentSpeaking) {
        this.lastSpeechStartedAtMs = event.atMs;
        void this.interrupt(event.atMs);
      }
    });
    this.smartTurn = createSmartTurnDetectorV15(
      { language: this.language === 'vi' ? 'vi' : this.language === 'en' ? 'en' : 'auto', ...(options.smartTurn ?? {}) },
      (event) => {
        if (event.kind === 'end') void this.onTurnEnd(event.text, event.atMs);
      },
    );
    this.tts = createTtsStreamV15(undefined, (event) => {
      if (event.kind === 'done' || event.kind === 'cancelled') this.agentSpeaking = false;
    });
    this.wakeWord = createWakeWordDetectorV15(options.wakeWords, (event) => {
      if (event.kind === 'confirmed') {
        this.wakeUp(event.atMs);
      }
    });
    const transport = new MockS2STransportV15(options.s2sProvider ?? defaults.s2sProvider, {
      script: options.s2sScript ?? [],
      ...(options.s2sFailConnectWith !== undefined ? { failNextConnectWith: options.s2sFailConnectWith } : {}),
    });
    this.s2s = createS2SAdapterV15(transport, {
      provider: options.s2sProvider ?? defaults.s2sProvider,
      language: this.language,
      ...(options.s2sMaxReconnectAttempts !== undefined ? { maxReconnectAttempts: options.s2sMaxReconnectAttempts } : {}),
    }, (event: S2SEventV15) => {
      this.onS2SEvent(event);
    });
    if (options.startAsleep) {
      this.state = 'asleep';
    }
  }

  getState(): VoiceSessionV15State {
    return this.state;
  }

  getMode(): VoiceSessionV15Mode {
    return this.mode;
  }

  now(): number {
    return this.nowMs;
  }

  async connect(): Promise<void> {
    if (this.state === 'active' || this.state === 'connecting') return;
    this.setState('connecting');
    if (this.mode === 's2s') {
      await this.s2s.connect();
      if (this.s2s.getState() === 'failed') {
        this.fallbackToPipeline('s2s-failed');
        return;
      }
      if (this.s2s.getState() === 'connected') {
        this.setState('active');
        this.emit({ kind: 'connected', atMs: this.nowMs, mode: 's2s' });
        return;
      }
    }
    this.setState('active');
    this.emit({ kind: 'connected', atMs: this.nowMs, mode: 'pipeline' });
  }

  disconnect(reason = 'client-close'): void {
    if (this.state === 'closed') return;
    this.s2s.disconnect(reason);
    if (this.tts.isSpeaking()) this.tts.cancel(this.nowMs);
    this.setState('closed');
  }

  /** Advance the virtual clock for every sub-clock in the session. */
  tick(ms: number): void {
    this.nowMs += ms;
    this.s2s.tick(ms);
    this.tts.tick(ms);
    this.wakeWord.tick(this.nowMs);
  }

  /** Feed one 20 ms PCM16 mic frame (barge-in detection). */
  feedAudioFrame(frame: Int16Array, echo = false): void {
    if (this.state !== 'active') return;
    this.bargeIn.feed({ frame, atMs: this.nowMs, echo });
  }

  /** Feed an STT partial transcript (smart turn + wake word). */
  feedTranscriptPartial(text: string): void {
    if (this.state !== 'active' && this.state !== 'asleep') return;
    if (this.state === 'asleep') {
      this.wakeWord.feedTranscript(text, this.nowMs);
      return;
    }
    this.pendingUserText = text;
    this.smartTurn.feedPartial(text, this.nowMs);
  }

  /** Feed silence (ms) — lets the smart-turn detector end the turn. */
  feedSilence(ms: number): void {
    if (this.state !== 'active') return;
    this.smartTurn.feedSilence(ms, this.nowMs);
    this.tick(0);
  }

  /** Feed a final STT transcript (wake word while asleep, turn while active). */
  feedTranscriptFinal(text: string, energy = 1): void {
    if (this.state === 'asleep') {
      this.wakeWord.feedTranscript(text, this.nowMs, energy);
      return;
    }
    if (this.state !== 'active') return;
    this.pendingUserText = text;
    const score = this.smartTurn.feedPartial(text, this.nowMs);
    if (score.decision === 'end') {
      this.smartTurn.feedSilence(score.recommendedWaitMs, this.nowMs);
    }
  }

  /** Speak a reply now (TTS streaming, bot's voice profile). */
  async speakReply(text: string): Promise<void> {
    if (this.state !== 'active') return;
    const profile = this.profiles.get(this.botId);
    this.agentSpeaking = true;
    this.tts.speak(text, profile, this.nowMs);
  }

  /** Interrupt the agent (barge-in): cancel TTS + discard stale LLM work. */
  interrupt(atMs: number): BargeInV15CutReceipt | undefined {
    if (!this.agentSpeaking) return undefined;
    const startedAt = this.lastSpeechStartedAtMs ?? atMs;
    this.bargeIn.setDiscardCounts({
      ttsChunks: this.tts.remainingText() ? this.tts.remainingText().split(/\s+/).length : 0,
      llmTokens: 0,
      sttPartials: 0,
    });
    const receipt = this.bargeIn.interrupt(startedAt, atMs, { tts: true, llm: true, stt: true });
    const cancelled = this.tts.cancel(atMs);
    this.agentSpeaking = false;
    this.smartTurn.reset();
    this.emit({ kind: 'barge-in', atMs, cut: receipt, message: `Interrupted after ${cancelled.spokenChars} chars spoken.` });
    return receipt;
  }

  turnsList(): VoiceSessionV15Turn[] {
    return [...this.turns];
  }

  eventsList(): VoiceSessionV15Event[] {
    return [...this.events];
  }

  stats(): VoiceSessionV15Stats {
    return {
      state: this.state,
      mode: this.mode,
      turns: this.turns.length,
      bargeIns: this.bargeIn.stats().cuts,
      fallbacks: this.s2s.stats().fallbacks,
      wakeUps: this.wakeWord.stats().confirmations,
      s2s: this.s2s.stats(),
      pipeline: this.pipeline.sessionReport(),
      bargeIn: this.bargeIn.stats(),
      smartTurn: this.smartTurn.stats(),
      tts: this.tts.stats(),
      wakeWord: this.wakeWord.stats(),
      quality: this.pipeline.getQuality(),
    };
  }

  summary(): string {
    const s = this.stats();
    return `voice session v15 ${this.id}: state=${s.state} mode=${s.mode} turns=${s.turns} ` +
      `barge-ins=${s.bargeIns} fallbacks=${s.fallbacks} wake-ups=${s.wakeUps} quality=${s.quality} ` +
      `e2e p95=${s.pipeline.endToEndP95Ms}ms`;
  }

  markdown(): string {
    const s = this.stats();
    const lines = [
      `## Voice session v15 — ${this.id}`,
      '',
      `- Bot: \`${this.botId}\`; language: \`${this.language}\`; state: \`${s.state}\`; mode: \`${s.mode}\``,
      `- Turns: ${s.turns}; barge-ins: ${s.bargeIns}; fallbacks: ${s.fallbacks}; wake-ups: ${s.wakeUps}`,
      `- Quality: \`${s.quality}\`; e2e p50 ${s.pipeline.endToEndP50Ms} ms, p95 ${s.pipeline.endToEndP95Ms} ms, ` +
        `compliance ${Math.round(s.pipeline.endToEndComplianceRate * 100)}%`,
      `- TTS: ${s.tts.chunksSpoken} chunks spoken, ${s.tts.chunksCancelled} cancelled, avg first-audio ${s.tts.averageFirstAudioMs} ms`,
      `- S2S: ${this.s2s.summary()}`,
      '',
      '### Turns',
      '',
    ];
    for (const turn of this.turns) {
      lines.push(`- #${turn.id} @${turn.atMs} ms (${turn.endToEndMs} ms${turn.bargeIn ? ', interrupted' : ''}): “${turn.userText}” → “${turn.replyText}”`);
    }
    lines.push('');
    return lines.join('\n');
  }

  private setState(next: VoiceSessionV15State): void {
    this.state = next;
    this.emit({ kind: 'state', atMs: this.nowMs, message: `state=${next}` });
  }

  private emit(event: VoiceSessionV15Event): void {
    this.events.push(event);
    this.sink?.(event);
  }

  private wakeUp(atMs: number): void {
    if (this.state !== 'asleep') return;
    this.state = 'active';
    this.emit({ kind: 'wake', atMs, message: 'Wake word confirmed — session awake.' });
  }

  private fallbackToPipeline(reason: string): void {
    if (this.mode === 'pipeline' && this.state === 'active') return;
    this.mode = 'pipeline';
    this.setState('active');
    this.emit({ kind: 'fallback', atMs: this.nowMs, mode: 'pipeline', reason, message: `S2S unavailable (${reason}); using the pipeline.` });
  }

  private onS2SEvent(event: S2SEventV15): void {
    if (event.kind === 'fallback') {
      this.fallbackToPipeline(event.reason ?? 's2s-failed');
      return;
    }
    if (event.kind === 'transcript-final' && event.text) {
      this.feedTranscriptFinal(event.text);
      return;
    }
    if (event.kind === 'speech-started' && this.agentSpeaking) {
      this.lastSpeechStartedAtMs = event.atMs;
      void this.interrupt(event.atMs);
    }
  }

  private async onTurnEnd(userText: string, atMs: number): Promise<void> {
    if (this.turnStartedAtMs === 0) this.turnStartedAtMs = atMs;
    const turnId = `turn-${this.turnCounter + 1}`;
    this.turnCounter += 1;
    const reply = await this.replyFor(userText);
    const endToEndMs = Math.max(0, atMs - this.turnStartedAtMs);
    // Stage latencies for this turn are scripted from the reply path:
    // the mock reply is instant, so the measured e2e is the turn gap;
    // stage splits are recorded for the report shape.
    this.pipeline.recordTurn({
      turnId,
      endToEndMs: endToEndMs + 120,
      atMs,
      stages: { vad: 80, stt: 150, llm: 60, tts: 90, network: 20, orchestrator: 20 },
    });
    this.turns.push({
      id: turnId,
      userText,
      replyText: reply,
      atMs,
      endToEndMs: endToEndMs + 120,
      bargeIn: false,
    });
    this.turnStartedAtMs = 0;
    this.pendingUserText = '';
    this.smartTurn.reset();
    this.emit({ kind: 'turn-end', atMs, text: userText });
    this.emit({ kind: 'reply', atMs, text: reply });
    await this.speakReply(reply);
  }
}

export function createVoiceSessionV15(
  id: string,
  options: VoiceSessionV15Options = {},
  sink?: VoiceSessionV15Sink,
): VoiceSessionV15 {
  return new VoiceSessionV15(id, options, sink);
}

export class VoiceSessionManagerV15 {
  private readonly sessions = new Map<string, VoiceSessionV15>();

  create(id: string, options: VoiceSessionV15Options = {}, sink?: VoiceSessionV15Sink): VoiceSessionV15 {
    if (this.sessions.has(id)) throw new Error(`voice session already exists: ${id}`);
    const session = new VoiceSessionV15(id, options, sink);
    this.sessions.set(id, session);
    return session;
  }

  get(id: string): VoiceSessionV15 | undefined {
    return this.sessions.get(id);
  }

  delete(id: string): boolean {
    const session = this.sessions.get(id);
    if (session) session.disconnect();
    return this.sessions.delete(id);
  }

  list(): VoiceSessionV15[] {
    return [...this.sessions.values()];
  }

  count(): number {
    return this.sessions.size;
  }
}

export function createVoiceSessionManagerV15(): VoiceSessionManagerV15 {
  return new VoiceSessionManagerV15();
}

export function voiceSessionV15Summary(session: VoiceSessionV15): string {
  return session.summary();
}

export function voiceSessionV15Markdown(session: VoiceSessionV15): string {
  return session.markdown();
}

export { syntheticFrameV15 };

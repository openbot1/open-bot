/**
 * Voice session v16 (v1.17, Đội T5 — voice v16).
 *
 * The session is the conductor for one voice conversation, wiring
 * the v16 pieces together in the order a real turn flows:
 *
 *   wake → listen → think → speak → (barge-in) → listen …
 *
 *   connect()        — start the S2S pipeline v4 (mic → STT
 *                      streaming → agent → TTS streaming → speaker)
 *                      with backpressure; if the S2S stream fails
 *                      or its reconnect budget is spent, the
 *                      pipeline falls back to the classic stages
 *                      and the session records the fallback.
 *   feedAudioFrame() — 20 ms PCM16 frames go to the barge-in v4
 *                      engine. While the agent speaks, a confirmed
 *                      user burst cuts the TTS stream *now* and
 *                      the receipt keeps the spoken prefix, the
 *                      remaining text and the turn context; the
 *                      interrupting speech is captured as the next
 *                      turn's input.
 *   feedTranscript() — STT partials go to the semantic turn-taking
 *                      v4 detector (completeness + silence gap +
 *                      max-wait timeout); when it ends a turn the
 *                      session asks the injected reply function for
 *                      a reply and speaks it through TTS streaming
 *                      v2 (small chunks, first chunk at once,
 *                      gapless joins).
 *   feedWakeWord()   — transcripts also go to the wake-word v4
 *                      detector while the session is asleep; a
 *                      confirmed wake word (or a wake word + a
 *                      command in the same breath) wakes it, and
 *                      silence while awake eventually sleeps it
 *                      again.
 *
 * States: idle → connecting → asleep | listening → thinking →
 * speaking → (interrupted → listening) → closed. The reply
 * function is injected (`replyFor`); the default is a scripted
 * echo. The LLM itself is never called here and the STT is
 * likewise injected as transcript text: the session never touches
 * a mic or a sound card.
 *
 * All clocks are virtual (`nowMs`, starts at 0); `tick(ms)`
 * advances the pipeline, the TTS stream, the wake-word timers
 * and the turn-taking timeout together.
 * `VoiceSessionManagerV16` keeps sessions by id for the tools layer.
 */

import { SpeechToSpeechPipelineV16, createS2SPipelineV16 } from './s2sV16';
import type { S2SPipelineOptionsV16 } from './s2sV16';
import { BargeInEngineV16, createBargeInEngineV16 } from './bargeInV16';
import type { BargeInV16CutReceipt, BargeInV16Options } from './bargeInV16';
import { SmartTurnDetectorV16, createSmartTurnDetectorV16 } from './smartTurnV16';
import type { SmartTurnV16Options } from './smartTurnV16';
import { TtsStreamV16, createTtsStreamV16 } from './ttsStreamV16';
import type { TtsStreamV16Options } from './ttsStreamV16';
import { WakeWordDetectorV16, createWakeWordDetectorV16 } from './wakeWordV16';
import type { WakeWordV16Config, WakeWordV16Options } from './wakeWordV16';
import { VoiceProfileStoreV15 } from '../voiceV15/ttsStreamV15';
import type { VoiceProfileV15 } from '../voiceV15/ttsStreamV15';
import { syntheticFrameV15 } from '../voiceV15/bargeInV15';

export type VoiceSessionV16Mode = 's2s' | 'pipeline';
export type VoiceSessionV16State =
  | 'idle'
  | 'connecting'
  | 'asleep'
  | 'listening'
  | 'thinking'
  | 'speaking'
  | 'interrupted'
  | 'closed';

export type VoiceSessionV16EventKind =
  | 'state'
  | 'connected'
  | 'fallback'
  | 'wake'
  | 'sleep'
  | 'turn-end'
  | 'reply'
  | 'barge-in'
  | 'resumed'
  | 'prompt'
  | 'error';

export interface VoiceSessionV16Event {
  kind: VoiceSessionV16EventKind;
  atMs: number;
  message?: string;
  text?: string;
  mode?: VoiceSessionV16Mode;
  cut?: BargeInV16CutReceipt;
  reason?: string;
  resumeTurnId?: string;
}

export type VoiceSessionV16Sink = (event: VoiceSessionV16Event) => void;

export interface VoiceSessionV16Options {
  botId?: string;
  language?: string;
  mode?: VoiceSessionV16Mode;
  /** Reply function (the "brain"); default echoes the user text. */
  replyFor?: (text: string) => string | Promise<string>;
  /** Streaming reply chunks (overrides replyFor when set). */
  replyChunksFor?: (text: string) => string[];
  /** Start asleep behind the wake word (default false — mic open). */
  startAsleep?: boolean;
  wakeWords?: WakeWordV16Config[];
  wakeWordOptions?: WakeWordV16Options;
  smartTurn?: SmartTurnV16Options;
  bargeIn?: BargeInV16Options;
  ttsStream?: TtsStreamV16Options;
  voiceProfile?: VoiceProfileV15;
  pipeline?: Omit<S2SPipelineOptionsV16, 'replyChunksFor'>;
  /** Fail the next mock S2S connect with this message (test hook). */
  s2sFailConnectWith?: string;
}

export function defaultVoiceSessionV16Options(): Required<Omit<VoiceSessionV16Options, 'replyFor' | 'replyChunksFor' | 'voiceProfile' | 'wakeWords' | 'wakeWordOptions' | 'smartTurn' | 'bargeIn' | 'ttsStream' | 'pipeline' | 's2sFailConnectWith'>> {
  return {
    botId: 'default-bot',
    language: 'vi',
    mode: 's2s',
    startAsleep: false,
  };
}

export interface VoiceSessionV16Turn {
  id: string;
  userText: string;
  replyText: string;
  atMs: number;
  endToEndMs: number;
  bargeIn: boolean;
  /** What the agent had said before the cut ('' when uninterrupted). */
  spokenBeforeCut?: string;
}

export interface VoiceSessionV16Stats {
  state: VoiceSessionV16State;
  mode: VoiceSessionV16Mode;
  turns: number;
  bargeIns: number;
  fallbacks: number;
  wakeUps: number;
  sleeps: number;
  resumes: number;
  pipeline: ReturnType<SpeechToSpeechPipelineV16['stats']>;
  bargeIn: ReturnType<BargeInEngineV16['stats']>;
  smartTurn: ReturnType<SmartTurnDetectorV16['stats']>;
  tts: ReturnType<TtsStreamV16['stats']>;
  wakeWord: ReturnType<WakeWordDetectorV16['stats']>;
}

export class VoiceSessionV16 {
  readonly id: string;
  readonly botId: string;
  readonly language: string;
  readonly profiles = new VoiceProfileStoreV15();
  readonly pipeline: SpeechToSpeechPipelineV16;
  readonly bargeIn: BargeInEngineV16;
  readonly smartTurn: SmartTurnDetectorV16;
  readonly tts: TtsStreamV16;
  readonly wakeWord: WakeWordDetectorV16;
  private readonly sink: VoiceSessionV16Sink | undefined;
  private readonly replyFor: (text: string) => string | Promise<string>;
  private state: VoiceSessionV16State = 'idle';
  private mode: VoiceSessionV16Mode;
  private nowMs = 0;
  private turnCounter = 0;
  private readonly turns: VoiceSessionV16Turn[] = [];
  private readonly events: VoiceSessionV16Event[] = [];
  private turnStartedAtMs = 0;
  private pendingUserText = '';
  private currentTurnId = '';
  private lastCut: BargeInV16CutReceipt | undefined;

  constructor(id: string, options: VoiceSessionV16Options = {}, sink?: VoiceSessionV16Sink) {
    const defaults = defaultVoiceSessionV16Options();
    this.id = id;
    this.botId = options.botId ?? defaults.botId;
    this.language = options.language ?? defaults.language;
    this.mode = options.mode ?? defaults.mode;
    this.sink = sink;
    this.replyFor = options.replyFor ?? ((text: string) => `Bạn vừa nói: ${text}`);
    if (options.voiceProfile) this.profiles.set(options.voiceProfile);
    this.pipeline = createS2SPipelineV16(
      {
        provider: 'mock',
        language: this.language,
        mode: this.mode,
        ...(options.replyChunksFor !== undefined ? { replyChunksFor: options.replyChunksFor } : {}),
        ...(options.pipeline ?? {}),
        ...(options.s2sFailConnectWith !== undefined ? { s2sFailConnectWith: options.s2sFailConnectWith } : {}),
      },
      (event) => {
        if (event.kind === 'fallback') this.fallbackToPipeline(event.reason ?? 's2s-failed');
        if (event.kind === 'resumed' && event.resumeToken) {
          this.emit({ kind: 'resumed', atMs: this.nowMs, resumeTurnId: event.resumeToken.turnId, message: event.message });
        }
      },
    );
    this.bargeIn = createBargeInEngineV16(
      options.bargeIn ?? {},
      {
        stopTts: (atMs) => {
          const cancelled = this.tts.cancel(atMs);
          return { spokenText: this.tts.spokenText(), remainingText: cancelled.remainingText };
        },
        discardLlm: () => 0,
      },
      (event) => {
        if (event.kind === 'cut' && event.receipt) this.onCut(event.receipt);
      },
    );
    this.smartTurn = createSmartTurnDetectorV16(
      {
        language: this.language === 'vi' ? 'vi' : this.language === 'en' ? 'en' : 'auto',
        ...(options.smartTurn ?? {}),
      },
      (event) => {
        if (event.kind === 'end' || event.kind === 'timeout') void this.onTurnEnd(event.text, event.atMs);
        if (event.kind === 'prompt') this.emit({ kind: 'prompt', atMs: event.atMs, text: event.text, message: 'User seems to be still thinking; prompting.' });
      },
    );
    this.tts = createTtsStreamV16(undefined, options.ttsStream ?? {}, (event) => {
      if (event.kind === 'done' || event.kind === 'cancelled') {
        if (this.state === 'speaking') this.setState('listening');
      }
    });
    this.wakeWord = createWakeWordDetectorV16(options.wakeWords, options.wakeWordOptions ?? {}, (event) => {
      if (event.kind === 'confirmed' || event.kind === 'wake-command') {
        this.wakeUp(event.atMs);
        if (event.kind === 'wake-command' && event.command) {
          this.pendingUserText = event.command;
          void this.onTurnEnd(event.command, event.atMs);
        }
      }
      if (event.kind === 'sleep') {
        if (this.state !== 'closed') this.setState('asleep');
        this.emit({ kind: 'sleep', atMs: event.atMs, reason: event.reason, message: 'Silence — session asleep behind the wake word.' });
      }
    });
    if (options.startAsleep) {
      this.state = 'asleep';
    }
  }

  getState(): VoiceSessionV16State {
    return this.state;
  }

  getMode(): VoiceSessionV16Mode {
    return this.mode;
  }

  now(): number {
    return this.nowMs;
  }

  async connect(): Promise<void> {
    if (this.state === 'listening' || this.state === 'speaking' || this.state === 'connecting') return;
    if (this.state === 'asleep') return;
    this.setState('connecting');
    await this.pipeline.connect();
    if (this.pipeline.getState() === 'fallback' || this.pipeline.getMode() === 'pipeline') {
      this.mode = 'pipeline';
    }
    this.setState('listening');
    this.emit({ kind: 'connected', atMs: this.nowMs, mode: this.mode });
  }

  disconnect(reason = 'client-close'): void {
    if (this.state === 'closed') return;
    this.pipeline.disconnect(reason);
    if (this.tts.isSpeaking()) this.tts.cancel(this.nowMs);
    this.setState('closed');
  }

  /** Advance the virtual clock for every sub-clock in the session. */
  tick(ms: number): void {
    this.nowMs += ms;
    this.pipeline.tick(ms);
    this.tts.tick(ms);
    this.wakeWord.tick(this.nowMs);
    this.smartTurn.tick(this.nowMs);
    this.bargeIn.tick(this.nowMs);
  }

  /** Feed one 20 ms PCM16 mic frame (barge-in detection + STT path). */
  feedAudioFrame(frame: Int16Array, echo = false): void {
    if (this.state !== 'listening' && this.state !== 'speaking' && this.state !== 'interrupted') return;
    this.bargeIn.feed({ frame, atMs: this.nowMs, echo });
    this.pipeline.feedMicFrame(frame);
    if (this.state === 'listening' || this.state === 'speaking') {
      this.wakeWord.feedSpeechActivity(this.nowMs);
    }
  }

  /** Feed an STT partial transcript (smart turn + wake word). */
  feedTranscriptPartial(text: string): void {
    if (this.state !== 'listening' && this.state !== 'speaking' && this.state !== 'asleep' && this.state !== 'interrupted') return;
    if (this.state === 'asleep') {
      this.wakeWord.feedTranscript(text, this.nowMs);
      return;
    }
    this.pendingUserText = text;
    this.smartTurn.feedPartial(text, this.nowMs);
    this.bargeIn.feedInterruptingText(text, this.nowMs);
  }

  /** Feed silence (ms) — lets the smart-turn detector end the turn. */
  feedSilence(ms: number): void {
    if (this.state !== 'listening' && this.state !== 'speaking') return;
    this.smartTurn.feedSilence(ms, this.nowMs);
    this.pipeline.feedSilence(ms);
    this.tick(0);
  }

  /** Feed a final STT transcript (wake word while asleep, turn while active). */
  feedTranscriptFinal(text: string, energy = 1): void {
    if (this.state === 'asleep') {
      this.wakeWord.feedTranscript(text, this.nowMs, energy);
      return;
    }
    if (this.state !== 'listening' && this.state !== 'speaking' && this.state !== 'interrupted') return;
    this.pendingUserText = text;
    const out = this.smartTurn.feedPartial(text, this.nowMs);
    if (out && out.decision === 'end') {
      this.smartTurn.feedSilence(out.requiredSilenceMs, this.nowMs);
    }
  }

  /** Speak a reply now (TTS streaming v2, bot's voice profile). */
  async speakReply(text: string): Promise<void> {
    if (this.state !== 'listening' && this.state !== 'thinking' && this.state !== 'speaking') return;
    const profile = this.profiles.get(this.botId);
    // The turn id is the last recorded turn's id, so a barge-in cut
    // can mark exactly that turn as interrupted.
    const lastTurn = this.turns[this.turns.length - 1];
    this.turnCounter += 1;
    this.currentTurnId = lastTurn?.id ?? `turn-${this.turnCounter}`;
    this.bargeIn.beginAgentTurn(this.currentTurnId, this.pendingUserText, text, this.nowMs);
    this.setState('speaking');
    if (this.tts.isSpeaking() || this.tts.isPaused()) this.tts.cancel(this.nowMs);
    this.tts.speak(text, profile, this.nowMs);
  }

  /** Interrupt the agent (barge-in): stop TTS now, keep the spoken prefix. */
  interrupt(atMs: number): BargeInV16CutReceipt | undefined {
    if (this.state !== 'speaking') return undefined;
    // The engine's 'cut' sink fires onCut synchronously, which
    // records the receipt, marks the turn and moves the state.
    const receipt = this.bargeIn.interrupt(atMs);
    if (receipt) this.lastCut = receipt;
    return receipt;
  }

  lastCutReceipt(): BargeInV16CutReceipt | undefined {
    return this.lastCut;
  }

  turnsList(): VoiceSessionV16Turn[] {
    return [...this.turns];
  }

  eventsList(): VoiceSessionV16Event[] {
    return [...this.events];
  }

  stats(): VoiceSessionV16Stats {
    return {
      state: this.state,
      mode: this.mode,
      turns: this.turns.length,
      bargeIns: this.bargeIn.stats().cuts,
      fallbacks: this.pipeline.stats().fallbacks,
      wakeUps: this.wakeWord.stats().confirmations + this.wakeWord.stats().wakeCommands,
      sleeps: this.wakeWord.stats().sleeps,
      resumes: this.pipeline.stats().resumes,
      pipeline: this.pipeline.stats(),
      bargeIn: this.bargeIn.stats(),
      smartTurn: this.smartTurn.stats(),
      tts: this.tts.stats(),
      wakeWord: this.wakeWord.stats(),
    };
  }

  summary(): string {
    const s = this.stats();
    return `voice session v16 ${this.id}: state=${s.state} mode=${s.mode} turns=${s.turns} ` +
      `barge-ins=${s.bargeIns} fallbacks=${s.fallbacks} wake-ups=${s.wakeUps} sleeps=${s.sleeps} resumes=${s.resumes} ` +
      `first-audio=${s.tts.averageFirstAudioMs}ms max-gap=${s.tts.maxGapMs ?? -1}ms`;
  }

  markdown(): string {
    const s = this.stats();
    const lines = [
      `## Voice session v16 — ${this.id}`,
      '',
      `- Bot: \`${this.botId}\`; language: \`${this.language}\`; state: \`${s.state}\`; mode: \`${s.mode}\``,
      `- Turns: ${s.turns}; barge-ins: ${s.bargeIns}; fallbacks: ${s.fallbacks}; wake-ups: ${s.wakeUps}; sleeps: ${s.sleeps}; resumes: ${s.resumes}`,
      `- TTS v2: ${s.tts.chunksSpoken} chunks spoken, ${s.tts.chunksCancelled} cancelled, avg first-audio ${s.tts.averageFirstAudioMs} ms, ` +
        `max join gap ${s.tts.maxGapMs !== undefined ? `${s.tts.maxGapMs} ms` : 'n/a'}, underruns ${s.tts.underruns}`,
      `- Pipeline v4: ${this.pipeline.summary()}`,
      '',
      '### Turns',
      '',
    ];
    for (const turn of this.turns) {
      lines.push(`- #${turn.id} @${turn.atMs} ms (${turn.endToEndMs} ms${turn.bargeIn ? ', interrupted' : ''}): “${turn.userText}” → “${turn.replyText}”` +
        (turn.spokenBeforeCut ? ` (cut after “${turn.spokenBeforeCut}”)` : ''));
    }
    lines.push('');
    return lines.join('\n');
  }

  private setState(next: VoiceSessionV16State): void {
    this.state = next;
    this.emit({ kind: 'state', atMs: this.nowMs, message: `state=${next}` });
  }

  private emit(event: VoiceSessionV16Event): void {
    this.events.push(event);
    this.sink?.(event);
  }

  private wakeUp(atMs: number): void {
    if (this.state !== 'asleep') return;
    this.setState('listening');
    this.emit({ kind: 'wake', atMs, message: 'Wake word confirmed — session awake.' });
  }

  private onCut(receipt: BargeInV16CutReceipt): void {
    this.lastCut = receipt;
    const turn = this.turns[this.turns.length - 1];
    if (turn && turn.id === receipt.context.turnId) {
      turn.bargeIn = true;
      turn.spokenBeforeCut = receipt.context.spokenText;
    }
    // A cut means the agent was speaking: report the interruption
    // even when the TTS-cancel callback already moved the state
    // back to listening (it fires first, inside the cut).
    this.setState('interrupted');
    this.emit({ kind: 'barge-in', atMs: receipt.atMs, cut: receipt, message: `Interrupted after “${receipt.context.spokenText}”.` });
    this.setState('listening');
  }

  private fallbackToPipeline(reason: string): void {
    if (this.mode === 'pipeline') return;
    this.mode = 'pipeline';
    this.emit({ kind: 'fallback', atMs: this.nowMs, mode: 'pipeline', reason, message: `S2S unavailable (${reason}); using the pipeline.` });
  }

  private async onTurnEnd(userText: string, atMs: number): Promise<void> {
    if (this.turnStartedAtMs === 0) this.turnStartedAtMs = atMs;
    const reply = await this.replyFor(userText);
    const endToEndMs = Math.max(0, atMs - this.turnStartedAtMs);
    const turnId = `turn-${this.turns.length + 1}`;
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
    if (reply.trim().endsWith('?')) this.smartTurn.noteAgentQuestion();
    this.smartTurn.reset();
    this.emit({ kind: 'turn-end', atMs, text: userText });
    this.emit({ kind: 'reply', atMs, text: reply });
    this.setState('thinking');
    await this.speakReply(reply);
  }
}

export function createVoiceSessionV16(
  id: string,
  options: VoiceSessionV16Options = {},
  sink?: VoiceSessionV16Sink,
): VoiceSessionV16 {
  return new VoiceSessionV16(id, options, sink);
}

export class VoiceSessionManagerV16 {
  private readonly sessions = new Map<string, VoiceSessionV16>();

  create(id: string, options: VoiceSessionV16Options = {}, sink?: VoiceSessionV16Sink): VoiceSessionV16 {
    if (this.sessions.has(id)) throw new Error(`voice session already exists: ${id}`);
    const session = new VoiceSessionV16(id, options, sink);
    this.sessions.set(id, session);
    return session;
  }

  get(id: string): VoiceSessionV16 | undefined {
    return this.sessions.get(id);
  }

  delete(id: string): boolean {
    const session = this.sessions.get(id);
    if (session) session.disconnect();
    return this.sessions.delete(id);
  }

  list(): VoiceSessionV16[] {
    return [...this.sessions.values()];
  }

  count(): number {
    return this.sessions.size;
  }
}

export function createVoiceSessionManagerV16(): VoiceSessionManagerV16 {
  return new VoiceSessionManagerV16();
}

export function voiceSessionV16Summary(session: VoiceSessionV16): string {
  return session.summary();
}

export function voiceSessionV16Markdown(session: VoiceSessionV16): string {
  return session.markdown();
}

export { syntheticFrameV15 };

/**
 * Full-duplex voice loop v2 (v1.04, Team T5 — voice realtime v3).
 *
 * The pieces existed separately — VAD (`audio.ts`), barge-in v3
 * (`bargeInV3.ts`), the sentence TTS queue (`ttsQueue.ts`), live
 * transcription (`liveTranscription.ts`), voice tool commands
 * (`voiceToolCommander.ts`), voice profiles (`voiceProfiles.ts`) —
 * but no one component owned the *conversation*: who is speaking
 * right now, when a turn ends, what happens when both sides talk
 * at once, and where a spoken tool command goes. This loop owns
 * exactly that. It is composition, not a rewrite: every decision
 * still lives in the module that owns it, and this file only wires
 * them into one state machine.
 *
 * States: `idle` → `listening` → `user-speaking` → `processing` →
 * `model-speaking` → (barge-in) → `listening`; a spoken tool
 * command that needs confirmation parks the loop in
 * `confirming-tool` until the user answers yes/no.
 *
 *   - Turn-taking: the VAD opens a user turn (`user-speaking`); the
 *     transcription stream commits it (`turn` event); the loop
 *     sends the text to the model (`onUserTurn`) and speaks the
 *     reply sentence by sentence through the TTS queue
 *     (`model-speaking`); the queue going idle closes the turn and
 *     the loop listens again.
 *   - Barge-in: while the model speaks, mic frames below
 *     `bargeInEnergyThreshold` are dropped — an energy echo guard,
 *     not true acoustic echo cancellation (the doc says so
 *     plainly): the model's own voice coming back through the mic
 *     must not interrupt itself. A loud frame reaches the VAD, the
 *     v3 controller decides backchannel / duck / interrupt, and an
 *     interrupt stops the TTS queue and measures the latency from
 *     speech-start to silence (`interruptLatencyMs`).
 *   - Duck: a soft interrupt first ducks (the event tells the UI
 *     to lower playback); if the user keeps talking past the
 *     confirm window the interrupt is confirmed, if they stop the
 *     duck is cancelled and the reply resumes — the queue was
 *     never stopped for a duck, so resuming costs nothing.
 *   - Voice tools: a committed turn is offered to the commander
 *     first. A `safe` tool runs and its summary is spoken; a
 *     `confirm` tool parks the loop in `confirming-tool` and the
 *     prompt is spoken; the user's next turn answers it. A
 *     `blocked` intent is spoken back as a refusal. Only when the
 *     turn is ordinary conversation does it reach `onUserTurn`.
 *   - Safety valves: a user turn longer than `maxUserSpeechMs`
 *     is force-committed (the user may have walked away mid-word);
 *     a turn that arrives while another is processing is queued
 *     and handled in order, never dropped, never run in parallel.
 *
 * The loop never touches the network and never executes a tool
 * itself: the model reply comes from the injected `onUserTurn`, the
 * tools run through the injected commander executor, and the audio
 * flows through injected `TtsHarness` / STT inputs. With the mock
 * engine and a stub `onUserTurn`, the whole conversation runs in a
 * unit test with no sound card and no key.
 */
import { LocalVad, isValidPcm16Frame, pcm16Rms } from './audio';
import { BargeInV3Controller, type BargeInV3Decision, type BargeInV3Options } from './bargeInV3';
import {
  LiveTranscriptionStream,
  type LiveTranscriptInput,
  type LiveTranscriptTurn,
  type LiveTranscriptionEvent,
  type LiveTranscriptionOptions,
} from './liveTranscription';
import { TtsHarness, MockTtsEngine } from './tts';
import { TtsQueue } from './ttsQueue';
import {
  VoiceToolCommander,
  type VoiceCommandOutcome,
  type VoiceConfirmationOutcome,
} from './voiceToolCommander';
import {
  resolveProfileTtsOptions,
  type VoiceProfile,
} from './voiceProfiles';

export type VoiceLoopState =
  | 'idle'
  | 'listening'
  | 'user-speaking'
  | 'processing'
  | 'model-speaking'
  | 'confirming-tool'
  | 'ended';

export type FullDuplexVoiceLoopEvent =
  | { kind: 'state'; from: VoiceLoopState; to: VoiceLoopState; at: number }
  | { kind: 'interim'; segmentId: string; text: string; at: number }
  | { kind: 'final'; segmentId: string; text: string; at: number }
  | { kind: 'turn'; turn: LiveTranscriptTurn }
  | { kind: 'backchannel'; at: number }
  | { kind: 'ducked'; at: number }
  | { kind: 'duck-cancelled'; at: number }
  | {
      kind: 'interrupted';
      /** ms from user speech start to the TTS queue going silent. */
      latencyMs: number;
      /** The cut reply (for resume), if the v3 controller kept one. */
      partialText: string | null;
      at: number;
    }
  | { kind: 'tool'; outcome: VoiceCommandOutcome | VoiceConfirmationOutcome; at: number }
  | { kind: 'model-reply'; text: string; at: number }
  | { kind: 'error'; message: string; at: number };

export type FullDuplexVoiceLoopEventSink = (event: FullDuplexVoiceLoopEvent) => void;

export interface FullDuplexVoiceLoopStats {
  state: VoiceLoopState;
  turnsHandled: number;
  interrupts: number;
  backchannels: number;
  ducks: number;
  duckCancelled: number;
  /** Interrupt latencies (ms), oldest first. */
  interruptLatenciesMs: number[];
  avgInterruptLatencyMs: number | null;
  maxInterruptLatencyMs: number | null;
  toolExecuted: number;
  toolBlocked: number;
  toolAwaitingConfirmation: number;
}

export interface FullDuplexVoiceLoopOptions {
  /** Model reply for one user turn (injected — a real agent call in production). */
  onUserTurn: (text: string) => Promise<string>;
  /** Voice profile: lang / voice / rate for the TTS queue. */
  profile?: VoiceProfile;
  /** TTS harness the queue speaks through. Default: system engine. */
  ttsHarness?: TtsHarness;
  /** Commander (inject to bind real tool handlers). Default: no executor. */
  commander?: VoiceToolCommander;
  /** Barge-in v3 options (grace, soft interrupt, adaptive grace). */
  bargeIn?: BargeInV3Options;
  /** VAD energy threshold (RMS 0..1). Default 0.02. */
  vadThreshold?: number;
  /** VAD hangover (ms). Default 300. */
  vadHangoverMs?: number;
  /** Mic sample rate (Hz). Default 16000. */
  sampleRateHz?: number;
  /**
   * RMS a mic frame must reach while the model speaks to count as
   * the user interrupting (echo guard). Default 0.08 — well above
   * the VAD threshold, so speaker bleed does not barge in.
   */
  bargeInEnergyThreshold?: number;
  /** Force-commit a user turn after this long (ms). Default 60_000. */
  maxUserSpeechMs?: number;
  /** Transcription stream options. */
  transcription?: LiveTranscriptionOptions;
  /** Event sink. */
  sink?: FullDuplexVoiceLoopEventSink;
  /** Clock (ms). Default Date.now. */
  clock?: () => number;
}

export const FULL_DUPLEX_DEFAULT_VAD_THRESHOLD = 0.02;
export const FULL_DUPLEX_DEFAULT_VAD_HANGOVER_MS = 300;
export const FULL_DUPLEX_DEFAULT_SAMPLE_RATE_HZ = 16000;
export const FULL_DUPLEX_DEFAULT_BARGE_IN_ENERGY_THRESHOLD = 0.08;
export const FULL_DUPLEX_DEFAULT_MAX_USER_SPEECH_MS = 60_000;
/** Max chars of a tool summary spoken back to the user. */
export const FULL_DUPLEX_TOOL_SUMMARY_MAX_CHARS = 200;

function truncateSpoken(text: string, maxChars: number): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > maxChars ? `${clean.slice(0, maxChars)}…` : clean;
}

export class FullDuplexVoiceLoop {
  private readonly onUserTurn: (text: string) => Promise<string>;
  private readonly profile?: VoiceProfile;
  private readonly commander: VoiceToolCommander;
  private readonly bargeIn: BargeInV3Controller;
  private readonly vad: LocalVad;
  private readonly transcription: LiveTranscriptionStream;
  private readonly ttsQueue: TtsQueue;
  private readonly bargeInEnergyThreshold: number;
  private readonly maxUserSpeechMs: number;
  private readonly sink?: FullDuplexVoiceLoopEventSink;
  private readonly clock: () => number;
  private state: VoiceLoopState = 'idle';
  /** Serial chain: turns are handled in order, never in parallel. */
  private turnChain: Promise<void> = Promise.resolve();
  private userSpeechStartedAt: number | null = null;
  private interruptStartedAt: number | null = null;
  private pendingConfirmationId: string | null = null;
  private currentReplyText = '';
  private readonly interruptLatencies: number[] = [];
  private turnsHandled = 0;
  private interrupts = 0;
  private backchannels = 0;
  private ducks = 0;
  private duckCancelled = 0;

  constructor(options: FullDuplexVoiceLoopOptions) {
    this.onUserTurn = options.onUserTurn;
    this.profile = options.profile;
    this.clock = options.clock ?? Date.now;
    this.commander = options.commander ?? new VoiceToolCommander({ clock: this.clock });
    // The barge-in controller shares the loop clock (a fake clock in
    // tests must move its grace window too, or speechAtMs goes
    // negative and every interrupt lands "in grace" forever).
    this.bargeIn = new BargeInV3Controller({ ...options.bargeIn, clock: this.clock });
    this.bargeInEnergyThreshold =
      options.bargeInEnergyThreshold ?? FULL_DUPLEX_DEFAULT_BARGE_IN_ENERGY_THRESHOLD;
    this.maxUserSpeechMs = Math.max(1000, options.maxUserSpeechMs ?? FULL_DUPLEX_DEFAULT_MAX_USER_SPEECH_MS);
    this.sink = options.sink;
    const sampleRateHz = options.sampleRateHz ?? FULL_DUPLEX_DEFAULT_SAMPLE_RATE_HZ;
    this.vad = new LocalVad({
      threshold: options.vadThreshold ?? FULL_DUPLEX_DEFAULT_VAD_THRESHOLD,
      hangoverMs: options.vadHangoverMs ?? FULL_DUPLEX_DEFAULT_VAD_HANGOVER_MS,
      sampleRateHz,
      callbacks: {
        onSpeechStart: () => this.handleVadSpeechStart(),
        onSpeechEnd: () => this.handleVadSpeechEnd(),
      },
    });
    this.transcription = new LiveTranscriptionStream({
      ...(options.transcription ?? {}),
      sink: (event) => this.handleTranscriptionEvent(event),
      clock: this.clock,
    });
    const ttsOpts = this.profile ? resolveProfileTtsOptions(this.profile) : undefined;
    this.ttsQueue = new TtsQueue({
      harness: options.ttsHarness ?? new TtsHarness([new MockTtsEngine()]),
      defaultOpts: ttsOpts,
      callbacks: {
        onSentenceStart: (sentence) => {
          this.bargeIn.noteModelTranscript(sentence.text, false);
        },
        onIdle: () => this.handleTtsIdle(),
      },
    });
  }

  getState(): VoiceLoopState {
    return this.state;
  }

  /** True while the model is speaking through the TTS queue. */
  isModelSpeaking(): boolean {
    return this.state === 'model-speaking';
  }

  getTranscription(): LiveTranscriptionStream {
    return this.transcription;
  }

  getCommander(): VoiceToolCommander {
    return this.commander;
  }

  getBargeIn(): BargeInV3Controller {
    return this.bargeIn;
  }

  getTtsQueue(): TtsQueue {
    return this.ttsQueue;
  }

  getStats(): FullDuplexVoiceLoopStats {
    const latencies = [...this.interruptLatencies];
    const avg =
      latencies.length > 0
        ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length)
        : null;
    const max = latencies.length > 0 ? Math.max(...latencies) : null;
    const commanderStats = this.commander.getStats();
    return {
      state: this.state,
      turnsHandled: this.turnsHandled,
      interrupts: this.interrupts,
      backchannels: this.backchannels,
      ducks: this.ducks,
      duckCancelled: this.duckCancelled,
      interruptLatenciesMs: latencies,
      avgInterruptLatencyMs: avg,
      maxInterruptLatencyMs: max,
      toolExecuted: commanderStats.executed,
      toolBlocked: commanderStats.blocked,
      toolAwaitingConfirmation: commanderStats.pending,
    };
  }

  /** Start listening. No-op when already started. */
  start(): void {
    if (this.state !== 'idle') return;
    this.setState('listening');
  }

  /**
   * Feed one mic frame (PCM16). Invalid frames are reported, never
   * thrown. While the model speaks, quiet frames are dropped by the
   * echo guard before they reach the VAD.
   */
  feedAudio(frame: Uint8Array): void {
    if (this.state === 'idle' || this.state === 'ended') return;
    if (!isValidPcm16Frame(frame)) {
      this.emit({ kind: 'error', message: 'invalid PCM16 audio frame', at: this.clock() });
      return;
    }
    if (this.state === 'model-speaking') {
      let rms = 0;
      try {
        rms = pcm16Rms(frame);
      } catch {
        rms = 0;
      }
      if (rms < this.bargeInEnergyThreshold) return;
    }
    // Watchdog: a user turn that never ends is force-committed.
    if (
      this.state === 'user-speaking' &&
      this.userSpeechStartedAt !== null &&
      this.clock() - this.userSpeechStartedAt > this.maxUserSpeechMs
    ) {
      const turn = this.transcription.endTurn();
      if (turn) this.queueTurn(turn.text);
      this.userSpeechStartedAt = this.clock();
    }
    try {
      this.vad.feed(frame);
    } catch (e) {
      this.emit({
        kind: 'error',
        message: e instanceof Error ? e.message : 'VAD feed failed',
        at: this.clock(),
      });
    }
  }

  /** Feed one STT result (partial or final) into the live transcript. */
  feedSttResult(input: LiveTranscriptInput): void {
    if (this.state === 'idle' || this.state === 'ended') return;
    this.transcription.feed(input);
  }

  /** Stop speaking, drop the queue, end the loop. */
  async end(): Promise<void> {
    if (this.state === 'ended') return;
    await this.ttsQueue.stop();
    this.transcription.endTurn();
    this.bargeIn.reset();
    this.setState('ended');
  }

  private setState(to: VoiceLoopState): void {
    if (this.state === to) return;
    const from = this.state;
    this.state = to;
    this.emit({ kind: 'state', from, to, at: this.clock() });
  }

  private emit(event: FullDuplexVoiceLoopEvent): void {
    this.sink?.(event);
  }

  private handleTranscriptionEvent(event: LiveTranscriptionEvent): void {
    if (event.kind === 'interim') {
      this.emit({ kind: 'interim', segmentId: event.segmentId, text: event.text, at: event.at });
    } else if (event.kind === 'final') {
      this.emit({ kind: 'final', segmentId: event.segmentId, text: event.text, at: event.at });
    } else if (event.kind === 'turn') {
      this.emit({ kind: 'turn', turn: { ...event.turn } });
      this.queueTurn(event.turn.text);
    }
  }

  /** Queue a user turn behind any turn already processing. */
  private queueTurn(text: string): void {
    this.turnChain = this.turnChain.then(() => this.handleUserTurn(text)).catch((e) => {
      this.emit({
        kind: 'error',
        message: e instanceof Error ? e.message : 'turn handling failed',
        at: this.clock(),
      });
    });
  }

  /** Wait until every queued turn has been handled (tests / shutdown). */
  async drainTurns(): Promise<void> {
    await this.turnChain;
  }

  private latestInterimText(): string {
    const interims = this.transcription.getInterims();
    return interims.length > 0 ? interims[interims.length - 1].text : '';
  }

  private handleVadSpeechStart(): void {
    const now = this.clock();
    if (this.state === 'model-speaking') {
      this.interruptStartedAt = now;
      const decision = this.bargeIn.noteSpeech('local_vad', {
        transcript: this.latestInterimText() || undefined,
        now,
      });
      this.applyBargeInDecision(decision);
      return;
    }
    if (this.state === 'listening' || this.state === 'confirming-tool') {
      this.userSpeechStartedAt = now;
      this.setState('user-speaking');
    }
  }

  private handleVadSpeechEnd(): void {
    const now = this.clock();
    if (this.bargeIn.isDuckPending()) {
      // The user stopped: resolve the duck. Past the confirm window
      // the duck is cancelled and the reply resumes; inside it the
      // v3 controller still cancels (a half-second "wait—" never
      // killed a reply the user wanted to hear).
      const decision = this.bargeIn.confirmDuck(false, 'local_vad', now);
      if (decision.action === 'ignore' && decision.reason === 'duck-cancelled') {
        this.duckCancelled += 1;
        this.emit({ kind: 'duck-cancelled', at: now });
      }
      return;
    }
    if (this.state === 'user-speaking') {
      this.userSpeechStartedAt = null;
      // The turn commits when the transcription stream emits it
      // (final segment + gap, or the caller's endTurn); the VAD
      // only marks the end of speech, it never finalises text.
      this.setState('listening');
    }
  }

  private applyBargeInDecision(decision: BargeInV3Decision): void {
    const now = this.clock();
    if (decision.action === 'backchannel') {
      this.backchannels += 1;
      this.emit({ kind: 'backchannel', at: now });
      return;
    }
    if (decision.action === 'duck') {
      this.ducks += 1;
      this.emit({ kind: 'ducked', at: now });
      return;
    }
    if (decision.action === 'interrupt') {
      void this.interrupt(decision);
    }
    // 'ignore': the model keeps talking.
  }

  private async interrupt(decision: BargeInV3Decision): Promise<void> {
    const startedAt = this.interruptStartedAt ?? this.clock();
    const partial = this.bargeIn.getPartialTurns()[0] ?? null;
    await this.ttsQueue.stop();
    this.bargeIn.cancelSent();
    this.bargeIn.playbackFlushed();
    this.bargeIn.backToListening();
    const latencyMs = this.clock() - startedAt;
    this.interruptLatencies.push(latencyMs);
    this.interrupts += 1;
    this.interruptStartedAt = null;
    this.setState('user-speaking');
    this.userSpeechStartedAt = this.clock();
    this.emit({
      kind: 'interrupted',
      latencyMs,
      partialText: partial ? partial.text : null,
      at: this.clock(),
    });
    void decision;
  }

  private handleTtsIdle(): void {
    if (this.state !== 'model-speaking') return;
    if (this.currentReplyText) {
      this.bargeIn.noteModelTranscript(this.currentReplyText, true);
      this.currentReplyText = '';
    }
    this.bargeIn.modelSpeechEnded();
    this.setState('listening');
  }

  private async handleUserTurn(text: string): Promise<void> {
    if (this.state === 'ended') return;
    const clean = text.trim();
    if (!clean) return;
    this.turnsHandled += 1;

    // A pending confirmation is answered by this turn, not by the
    // model. The check is on the pending id, not on the state: the
    // prompt finishes speaking (state back to `listening`) before
    // the user answers, so a state check would miss the answer.
    if (this.pendingConfirmationId) {
      const confirmationId = this.pendingConfirmationId;
      const outcome = await this.commander.answerConfirmation(confirmationId, clean);
      this.emit({ kind: 'tool', outcome, at: this.clock() });
      if (outcome.status === 'unclear') {
        this.speak(outcome.prompt);
        return;
      }
      this.pendingConfirmationId = null;
      if (outcome.status === 'executed') {
        this.speakAck(outcome.result.summary);
        this.setState('listening');
        return;
      }
      if (outcome.status === 'cancelled') {
        this.speakAck(this.lang() === 'vi' ? 'Đã hủy.' : 'Cancelled.');
        this.setState('listening');
        return;
      }
      // expired / unknown: the confirmation is gone; listen again.
      this.setState('listening');
      return;
    }

    // Voice tools first: a command never reaches the model as chat.
    const outcome = await this.commander.handleTranscript(clean);
    this.emit({ kind: 'tool', outcome, at: this.clock() });
    if (outcome.status === 'awaiting-confirmation') {
      this.pendingConfirmationId = outcome.confirmationId;
      this.setState('confirming-tool');
      this.speak(outcome.prompt);
      return;
    }
    if (outcome.status === 'blocked') {
      this.speakAck(outcome.reason);
      return;
    }
    if (outcome.status === 'invalid-args') {
      this.speakAck(outcome.error);
      return;
    }
    if (outcome.status === 'executed') {
      this.speakAck(outcome.result.summary);
      return;
    }
    if (outcome.status !== 'no-command') return;

    // Ordinary conversation: ask the model, then speak the reply.
    this.setState('processing');
    let reply = '';
    try {
      reply = await this.onUserTurn(clean);
    } catch (e) {
      reply =
        this.lang() === 'vi'
          ? `Xin lỗi, tôi chưa trả lời được: ${e instanceof Error ? e.message : 'lỗi không rõ'}.`
          : `Sorry, I could not answer: ${e instanceof Error ? e.message : 'unknown error'}.`;
    }
    this.emit({ kind: 'model-reply', text: reply, at: this.clock() });
    this.speak(reply);
  }

  /** Speak a short acknowledgement / refusal through the TTS queue. */
  private speakAck(text: string): void {
    const clean = truncateSpoken(text, FULL_DUPLEX_TOOL_SUMMARY_MAX_CHARS);
    if (!clean) return;
    this.speak(clean);
  }

  /** Enqueue a model reply for speaking (state → model-speaking). */
  private speak(text: string): void {
    const clean = text.trim();
    if (!clean) {
      if (this.state === 'processing') this.setState('listening');
      return;
    }
    this.currentReplyText = clean;
    this.bargeIn.modelSpeechStarted();
    this.setState('model-speaking');
    this.ttsQueue.enqueue(clean);
  }

  private lang(): 'vi' | 'en' {
    return (this.profile?.lang ?? 'vi').toLowerCase().startsWith('en') ? 'en' : 'vi';
  }
}

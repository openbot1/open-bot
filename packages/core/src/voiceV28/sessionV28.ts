/**
 * Realtime voice session v28 (v1.41, Team T5).
 *
 * The session wires the v28 pieces into one live loop:
 *
 *   mic chunks ───> MockRealtimeTransportV28 ──> VadHookV28
 *                     (streaming in/out, jitter)    (speech
 *                     start / end / silence timeout)
 *   persona/human -> MemoryVoiceStyleBridgeV28 -> voice config
 *                     (rate / pitch / style / greeting)
 *   turns ────────> TranscriptRecorderV28 (record + summary)
 *   "dừng lại" ───> VoiceCommandRouterV28 (route to tool)
 *   bot roles ────> VoiceCastingV28 (voice per role)
 *
 * Lifecycle (virtual clock, `atMs` everywhere):
 *   idle -> connecting -> listening -> thinking -> speaking
 *   -> listening ... ; pause from listening / thinking /
 *   speaking; resume back to listening (or speaking when a
 *   reply was cut mid-way and must resume); stop -> ended.
 *
 * Barge-in: while the agent is speaking, user speech that
 * passes the VAD hook (and the grace window + minimum
 * speech) stops playback at once — the spoken prefix is
 * cut at a word boundary, the unspoken remainder is kept
 * with the turn, the floor passes to the user, and the
 * interruption is logged. Nothing is lost: the remainder
 * can be resumed, summarised, or dropped by the caller.
 *
 * The session produces no audio: `agentReply` arms the
 * mock TTS stream (synthetic chunks through the transport)
 * and records the reply text, but no sound is ever played
 * (this machine has no TTS engine and no sound card).
 * Every state change is appended to the session log, so
 * the whole conversation can be audited after the fact.
 */

import {
  MockRealtimeTransportV28,
  chunkEnergyV28,
  createMockRealtimeTransportV28,
  synthToneChunkV28,
  type MockRealtimeTransportV28Options,
} from './transportV28';
import {
  VadHookV28,
  createVadHookV28,
  type VadHookV28Options,
} from './vadHookV28';
import {
  MemoryVoiceStyleBridgeV28,
  createMemoryVoiceStyleBridgeV28,
  type MemoryVoiceStyleBridgeV28Options,
} from './styleV28';
import {
  TranscriptRecorderV28,
  createTranscriptRecorderV28,
} from './transcriptV28';
import {
  VoiceCastingV28,
  createVoiceCastingV28,
  type VoiceCastingV28Options,
} from './castingV28';
import {
  VoiceCommandRouterV28,
  createVoiceCommandRouterV28,
  type VoiceCommandRouterV28Options,
} from './commandsV28';
import {
  VOICE_V28_BARGE_IN_GRACE_DEFAULT_MS,
  VOICE_V28_BARGE_IN_MIN_SPEECH_DEFAULT_MS,
  VOICE_V28_MAX_LOG_EVENTS_DEFAULT,
  VOICE_V28_STATE_TRANSITIONS,
  clampV28,
  cutAtWordBoundaryV28,
  defaultVadHookConfigV28,
  estimateSpeechDurationMsV28,
  type VoiceV28AudioChunk,
  type VoiceV28FloorHolder,
  type VoiceV28SessionLogEvent,
  type VoiceV28SessionSnapshot,
  type VoiceV28SessionState,
  type VoiceV28StopReason,
  type VoiceV28VadFrame,
} from './types';

export interface RealtimeVoiceSessionV28Options {
  transport?: MockRealtimeTransportV28Options;
  vad?: VadHookV28Options;
  styleBridge?: MemoryVoiceStyleBridgeV28Options | null;
  casting?: VoiceCastingV28Options;
  commands?: VoiceCommandRouterV28Options;
  /** Bot this session belongs to (null = unassigned). */
  botId?: string | null;
  /** Barge-in grace after the agent starts speaking (ms). */
  bargeInGraceMs?: number;
  /** Minimum user speech to count as a barge-in (ms). */
  bargeInMinSpeechMs?: number;
  /** Max session log events kept. */
  maxLogEvents?: number;
  /** Idle timeout (ms) — 0 = disabled. */
  idleTimeoutMs?: number;
  /** Max session length (ms) — 0 = unlimited. */
  maxSessionMs?: number;
}

export interface VoiceV28AgentReply {
  text: string;
  /** Chars actually spoken (mock playback) before a cut. */
  spokenChars: number;
  /** Chars never spoken (kept for resume / summarise / drop). */
  remainingChars: number;
  /** Estimated full spoken duration (ms). */
  estimatedDurationMs: number;
  voiceId: string | null;
  castRole: string;
}

export interface VoiceV28BargeInResult {
  /** True when the user burst stopped the agent's speech. */
  interrupted: boolean;
  /** Why the burst did (or did not) interrupt. */
  reason: string;
  /** Spoken prefix, cut at a word boundary ('' when nothing spoken). */
  spokenText: string;
  /** Remainder kept with the turn. */
  remainingText: string;
  /** ms from the agent starting to speak to the stop. */
  stopLatencyMs: number | null;
}

export interface VoiceV28SessionStats {
  chunksIn: number;
  chunksOut: number;
  chunksDropped: number;
  underruns: number;
  latencyP50Ms: number | null;
  latencyP95Ms: number | null;
  turns: number;
  interruptions: number;
  commands: number;
  unknownCommands: number;
  styleChanges: number;
  castSwitches: number;
  vadSpeechStarts: number;
  vadSilenceTimeouts: number;
}

export function createRealtimeVoiceSessionV28(
  sessionId: string,
  opts: RealtimeVoiceSessionV28Options = {},
): RealtimeVoiceSessionV28 {
  return new RealtimeVoiceSessionV28(sessionId, opts);
}

export class RealtimeVoiceSessionV28 {
  readonly sessionId: string;
  readonly botId: string | null;
  readonly transport: MockRealtimeTransportV28;
  readonly vad: VadHookV28;
  readonly transcript: TranscriptRecorderV28;
  readonly casting: VoiceCastingV28;
  readonly commands: VoiceCommandRouterV28;
  readonly styleBridge: MemoryVoiceStyleBridgeV28 | null;
  private state: VoiceV28SessionState = 'idle';
  private floor: VoiceV28FloorHolder = 'none';
  private log: VoiceV28SessionLogEvent[] = [];
  private readonly maxLogEvents: number;
  private readonly bargeInGraceMs: number;
  private readonly bargeInMinSpeechMs: number;
  private readonly idleTimeoutMs: number;
  private readonly maxSessionMs: number;
  private startedAtMs: number | null = null;
  private updatedAtMs = 0;
  private endedAtMs: number | null = null;
  private stopReason: VoiceV28StopReason | null = null;
  private turnIndex = 0;
  private interruptions = 0;
  private styleChanges = 0;
  private agentSpeaking = false;
  private agentReplyStartedAtMs: number | null = null;
  private currentReply: string | null = null;
  private spokenChars = 0;
  private lastUserActivityAtMs: number | null = null;
  private lastAgentActivityAtMs: number | null = null;
  private outSeq = 0;
  private pausedFrom: VoiceV28SessionState | null = null;
  private pendingResumeReply: string | null = null;

  constructor(sessionId: string, opts: RealtimeVoiceSessionV28Options = {}) {
    if (typeof sessionId !== 'string' || sessionId.trim() === '') {
      throw new Error('sessionId must be a non-empty string');
    }
    this.sessionId = sessionId;
    this.botId = opts.botId ?? null;
    this.transport = createMockRealtimeTransportV28(opts.transport ?? {});
    this.casting = createVoiceCastingV28(opts.casting ?? {});
    this.commands = createVoiceCommandRouterV28(opts.commands ?? {});
    this.transcript = createTranscriptRecorderV28({ sessionId, botId: this.botId });
    this.styleBridge = opts.styleBridge
      ? createMemoryVoiceStyleBridgeV28(opts.styleBridge)
      : null;
    this.vad = createVadHookV28(opts.vad ?? {}, {
      onSpeechStart: (atMs) => this.onUserSpeechStart(atMs),
      onSpeechEnd: (atMs) => this.onUserSpeechEnd(atMs),
      onSilenceTimeout: (atMs, silenceMs) => this.onSilenceTimeout(atMs, silenceMs),
    });
    if (this.styleBridge) {
      this.styleBridge.subscribe(() => {
        this.styleChanges += 1;
        this.appendLog(this.updatedAtMs, 'style-change', 'voice config re-derived from memory blocks');
      });
    }
    this.bargeInGraceMs = Math.max(0, opts.bargeInGraceMs ?? VOICE_V28_BARGE_IN_GRACE_DEFAULT_MS);
    this.bargeInMinSpeechMs = Math.max(0, opts.bargeInMinSpeechMs ?? VOICE_V28_BARGE_IN_MIN_SPEECH_DEFAULT_MS);
    this.maxLogEvents = Math.max(1, opts.maxLogEvents ?? VOICE_V28_MAX_LOG_EVENTS_DEFAULT);
    this.idleTimeoutMs = Math.max(0, opts.idleTimeoutMs ?? 0);
    this.maxSessionMs = Math.max(0, opts.maxSessionMs ?? 0);
  }

  // -- lifecycle -------------------------------------------------------

  get currentState(): VoiceV28SessionState {
    return this.state;
  }

  get floorHolder(): VoiceV28FloorHolder {
    return this.floor;
  }

  /** Open the session: idle -> connecting -> listening. */
  start(atMs: number): VoiceV28SessionSnapshot {
    this.assertAtMs(atMs);
    if (this.state !== 'idle') throw new Error(`cannot start a session in state ${this.state}`);
    this.transition('connecting', atMs, 'start');
    this.appendLog(atMs, 'connect', 'mock transport connected (no network)');
    this.startedAtMs = atMs;
    this.updatedAtMs = atMs;
    this.lastUserActivityAtMs = atMs;
    this.transition('listening', atMs, 'listen');
    this.floor = 'user';
    return this.snapshot();
  }

  /** Pause: listening / thinking / speaking -> paused (remembers where it came from). */
  pause(atMs: number): VoiceV28SessionSnapshot {
    this.assertAtMs(atMs);
    this.requireLive('pause');
    if (this.state === 'paused') return this.snapshot();
    this.pausedFrom = this.state;
    if (this.agentSpeaking) this.stopPlayback(atMs, 'paused');
    this.transition('paused', atMs, 'pause');
    this.floor = 'none';
    return this.snapshot();
  }

  /** Resume: paused -> the state it was paused from (listening, or speaking when a reply was cut). */
  resume(atMs: number): VoiceV28SessionSnapshot {
    this.assertAtMs(atMs);
    if (this.state !== 'paused') throw new Error(`cannot resume a session in state ${this.state}`);
    const back = this.pausedFrom ?? 'listening';
    this.pausedFrom = null;
    const resumeReply = this.pendingResumeReply;
    // Use a local: TS narrows this.state to 'paused' after the
    // guard above and keeps the narrowing across method calls.
    const target: VoiceV28SessionState =
      back === 'speaking' ? (resumeReply ? 'speaking' : 'listening') : back;
    this.transition(target, atMs, 'resume');
    this.floor = target === 'speaking' ? 'agent' : 'user';
    if (target === 'speaking' && resumeReply) {
      this.pendingResumeReply = null;
      this.agentReply(resumeReply, atMs);
    }
    return this.snapshot();
  }

  /** Stop: any live state -> ended (closes the transcript, closes the transport). */
  stop(atMs: number, reason: VoiceV28StopReason = 'user-request'): VoiceV28SessionSnapshot {
    this.assertAtMs(atMs);
    if (this.state === 'ended') return this.snapshot();
    if (this.agentSpeaking) this.stopPlayback(atMs, 'stopped');
    this.transcript.endSession(atMs);
    this.transport.close(atMs);
    this.stopReason = reason;
    this.endedAtMs = atMs;
    this.transition('ended', atMs, 'stop');
    this.floor = 'none';
    return this.snapshot();
  }

  // -- user audio in ---------------------------------------------------

  /** Feed one inbound (mic) chunk: through the transport, then the VAD hook. */
  feedUserChunk(chunk: VoiceV28AudioChunk, atMs: number): { accepted: boolean; energy: number } {
    this.assertAtMs(atMs);
    this.requireLive('feed user audio');
    if (chunk.source !== 'mic') throw new Error('feedUserChunk expects a mic chunk');
    // Idle/max-session timeouts are evaluated against the
    // *previous* activity timestamp: a frame that arrives
    // after a long gap means the session already went idle
    // during the gap, so check before recording this frame
    // as activity.
    this.checkTimeouts(atMs);
    const energy = chunkEnergyV28(chunk);
    const accepted = this.transport.pushIn(chunk);
    if (this.state === 'ended') return { accepted, energy };
    if (!accepted) {
      this.appendLog(atMs, 'chunk-drop', `inbound chunk ${chunk.seq} dropped (transport full)`);
      return { accepted, energy };
    }
    this.lastUserActivityAtMs = atMs;
    const frame: VoiceV28VadFrame = { atMs, energy, isSpeech: energy >= this.vad.threshold };
    this.vad.feed(frame);
    return { accepted, energy };
  }

  /** Feed raw energy frames directly (no audio chunks) — the light path for tests/hosts. */
  feedUserFrames(frames: readonly VoiceV28VadFrame[]): void {
    this.requireLive('feed user frames');
    for (const frame of frames) {
      // See feedUserChunk: evaluate timeouts against the
      // previous activity timestamp, before this frame
      // counts as activity.
      this.checkTimeouts(frame.atMs);
      if (this.state === 'ended') break;
      this.lastUserActivityAtMs = frame.atMs;
      this.vad.feed(frame);
    }
  }

  /** Feed a user transcript fragment (opens/appends a user turn). */
  userSaid(text: string, atMs: number): void {
    this.assertAtMs(atMs);
    this.requireLive('record user speech');
    if (!text || !text.trim()) return;
    this.checkTimeouts(atMs);
    if (this.state === 'ended') return;
    this.lastUserActivityAtMs = atMs;
    this.transcript.appendText(text, atMs, 'user');
    this.appendLog(atMs, 'user-end', `user: ${text.slice(0, 120)}`);
  }

  // -- agent speech out ------------------------------------------------

  /**
   * Speak a reply as the agent: arms the mock TTS stream
   * (synthetic chunks through the transport) and records the
   * turn. Returns the reply with spoken/remaining chars
   * (remaining is 0 until a barge-in cuts it short).
   */
  agentReply(text: string, atMs: number, castRole: 'narrator' | 'assistant' | 'announcer' | 'alert' = 'assistant'): VoiceV28AgentReply {
    this.assertAtMs(atMs);
    this.requireLive('agent reply');
    if (!text || !text.trim()) throw new Error('agentReply needs non-empty text');
    if (this.state === 'paused') throw new Error('cannot speak while paused — resume first');
    this.transition('speaking', atMs, 'agent-start');
    this.floor = 'agent';
    const resolved = this.botId ? this.casting.voiceFor(this.botId, castRole) : null;
    const voiceId = resolved?.voiceId ?? this.styleBridge?.current.voice ?? 'mock-default';
    const rate = this.styleBridge?.current.rate ?? 1;
    this.currentReply = text;
    this.spokenChars = 0;
    this.agentSpeaking = true;
    this.agentReplyStartedAtMs = atMs;
    this.lastAgentActivityAtMs = atMs;
    this.transcript.openTurn('agent', atMs, { voiceId, castRole });
    this.transcript.appendText(text, atMs, 'agent');
    // Mock TTS: one synthetic chunk per ~30 ms of estimated speech.
    const durationMs = estimateSpeechDurationMsV28(text, rate);
    const chunks = Math.max(1, Math.ceil(durationMs / 30));
    for (let i = 0; i < chunks; i += 1) {
      const chunk = synthToneChunkV28(this.outSeq, atMs + i * 30, 'tts', {
        sampleRate: this.transport.config.sampleRate,
        chunkSamples: this.transport.config.chunkSamples,
        frequencyHz: 440,
        amplitude: 0.4,
        final: i === chunks - 1,
      });
      this.outSeq += 1;
      this.transport.pushOut(chunk);
    }
    this.appendLog(atMs, 'agent-start', `agent (${voiceId}, ${castRole}): ${text.slice(0, 120)}`);
    return {
      text,
      spokenChars: 0,
      remainingChars: text.length,
      estimatedDurationMs: durationMs,
      voiceId,
      castRole,
    };
  }

  /** Finish the current agent reply (mock playback done). */
  agentReplyDone(atMs: number): VoiceV28SessionSnapshot {
    this.assertAtMs(atMs);
    this.requireLive('finish agent reply');
    if (!this.agentSpeaking) return this.snapshot();
    const reply = this.currentReply ?? '';
    this.spokenChars = reply.length;
    this.agentSpeaking = false;
    this.currentReply = null;
    this.agentReplyStartedAtMs = null;
    this.transcript.closeTurn(atMs, false);
    this.appendLog(atMs, 'agent-done', 'agent reply finished');
    this.transition('listening', atMs, 'listen');
    this.floor = 'user';
    return this.snapshot();
  }

  // -- barge-in ----------------------------------------------------------

  /**
   * Handle a user burst while the agent is speaking. Returns
   * whether the burst interrupted, the spoken prefix (word
   * boundary) and the kept remainder.
   */
  handleBargeIn(speechMs: number, atMs: number, userText = ''): VoiceV28BargeInResult {
    this.assertAtMs(atMs);
    this.requireLive('barge-in');
    const empty: VoiceV28BargeInResult = {
      interrupted: false,
      reason: '',
      spokenText: '',
      remainingText: this.currentReply ?? '',
      stopLatencyMs: null,
    };
    if (!this.agentSpeaking || !this.currentReply) {
      return { ...empty, reason: 'not-speaking' };
    }
    if (this.agentReplyStartedAtMs !== null && atMs - this.agentReplyStartedAtMs < this.bargeInGraceMs) {
      return { ...empty, reason: 'grace-period' };
    }
    if (speechMs < this.bargeInMinSpeechMs) {
      return { ...empty, reason: 'too-short' };
    }
    const reply = this.currentReply;
    const startedAt = this.agentReplyStartedAtMs ?? atMs;
    const elapsedMs = Math.max(0, atMs - startedAt);
    const rate = this.styleBridge?.current.rate ?? 1;
    const totalMs = Math.max(1, estimateSpeechDurationMsV28(reply, rate));
    const fraction = clampV28(elapsedMs / totalMs, 0, 1);
    const spokenChars = Math.floor(reply.length * fraction);
    const spokenText = cutAtWordBoundaryV28(reply, spokenChars);
    const remainingText = reply.slice(spokenText.length).trimStart();
    const stopLatencyMs = Math.max(0, atMs - startedAt);
    this.stopPlayback(atMs, 'barge-in', { spokenText, remainingText, userText });
    this.interruptions += 1;
    this.turnIndex += 1;
    this.appendLog(atMs, 'barge-in', `user interrupted after ${elapsedMs}ms: "${userText.slice(0, 80)}"`);
    this.transition('listening', atMs, 'listen');
    this.floor = 'user';
    return { interrupted: true, reason: 'confirmed', spokenText, remainingText, stopLatencyMs };
  }

  /** Resume the remainder of the last cut reply (if any was kept). */
  resumeRemainder(atMs: number): VoiceV28AgentReply | null {
    this.assertAtMs(atMs);
    this.requireLive('resume remainder');
    if (!this.pendingResumeReply) return null;
    const text = this.pendingResumeReply;
    this.pendingResumeReply = null;
    return this.agentReply(text, atMs);
  }

  /** The unspoken remainder kept from the last barge-in (null = none). */
  get keptRemainder(): string | null {
    return this.pendingResumeReply;
  }

  // -- voice commands ----------------------------------------------------

  /** Route a spoken transcript to a command match (logs it). */
  routeCommand(transcript: string, atMs: number): ReturnType<VoiceCommandRouterV28['route']> {
    this.assertAtMs(atMs);
    const match = this.commands.route(transcript, atMs);
    this.appendLog(atMs, 'command', `${match.kind} (${match.confidence}) -> ${match.toolName ?? 'session-internal'} [${match.execution}]`);
    return match;
  }

  // -- style ---------------------------------------------------------------

  /** Re-read the memory blocks and re-derive the voice config. */
  refreshStyle(atMs: number): ReturnType<MemoryVoiceStyleBridgeV28['refresh']> | null {
    this.assertAtMs(atMs);
    if (!this.styleBridge) return null;
    const result = this.styleBridge.refresh(atMs);
    if (result.changed) {
      this.appendLog(atMs, 'style-change', `voice config changed: ${result.changedFields.join(', ')}`);
    }
    return result;
  }

  /** Apply a speaking-style preset directly (overrides blocks until the next refresh). */
  applyStylePreset(style: string, atMs: number): ReturnType<MemoryVoiceStyleBridgeV28['applyPreset']> | null {
    this.assertAtMs(atMs);
    if (!this.styleBridge) return null;
    const result = this.styleBridge.applyPreset(style as never, atMs);
    this.appendLog(atMs, 'style-change', `preset applied: ${style}`);
    return result;
  }

  /** Greeting for the current voice config (memory-driven). */
  greeting(): string {
    return this.styleBridge?.greeting() ?? 'Hello friend!';
  }

  // -- snapshots / stats / log --------------------------------------------

  snapshot(): VoiceV28SessionSnapshot {
    const t = this.transport.stats();
    const reply = this.currentReply ?? '';
    return {
      sessionId: this.sessionId,
      botId: this.botId,
      state: this.state,
      floor: this.floor,
      style: this.styleBridge?.current.style ?? 'default',
      voiceId: this.styleBridge?.current.voice ?? null,
      rate: this.styleBridge?.current.rate ?? 1,
      pitch: this.styleBridge?.current.pitch ?? 0,
      language: this.styleBridge?.current.language ?? 'en',
      addressForm: this.styleBridge?.current.addressForm ?? 'you',
      userName: this.styleBridge?.current.userName ?? '',
      turnIndex: this.turnIndex,
      turns: this.transcript.turnCount,
      interruptions: this.interruptions,
      chunksIn: t.chunksIn,
      chunksOut: t.chunksOut,
      chunksDropped: t.droppedIn + t.droppedOut,
      startedAtMs: this.startedAtMs,
      updatedAtMs: this.updatedAtMs,
      endedAtMs: this.endedAtMs,
      stopReason: this.stopReason,
      agentSpeaking: this.agentSpeaking,
      currentReply: this.currentReply,
      spokenChars: this.spokenChars,
      remainingChars: Math.max(0, reply.length - this.spokenChars),
      events: this.log.length,
    };
  }

  stats(): VoiceV28SessionStats {
    const t = this.transport.stats();
    const cmd = this.commands.stats();
    return {
      chunksIn: t.chunksIn,
      chunksOut: t.chunksOut,
      chunksDropped: t.droppedIn + t.droppedOut,
      underruns: t.underruns,
      latencyP50Ms: t.latencyP50Ms,
      latencyP95Ms: t.latencyP95Ms,
      turns: this.transcript.turnCount,
      interruptions: this.interruptions,
      commands: cmd.matches,
      unknownCommands: cmd.unknowns,
      styleChanges: this.styleChanges,
      castSwitches: this.botId ? this.casting.switchEvents(this.botId).length : 0,
      vadSpeechStarts: this.vad.stats().speechStarts,
      vadSilenceTimeouts: this.vad.stats().silenceTimeouts,
    };
  }

  sessionLog(): VoiceV28SessionLogEvent[] {
    return [...this.log];
  }

  /** Summary of the transcript so far. */
  summarise(atMs: number): ReturnType<TranscriptRecorderV28['summarise']> {
    return this.transcript.summarise(atMs, {
      style: this.styleBridge?.current.style ?? 'default',
      voiceId: this.styleBridge?.current.voice ?? null,
    });
  }

  // -- internals ----------------------------------------------------------

  private onUserSpeechStart(atMs: number): void {
    this.lastUserActivityAtMs = atMs;
    if (this.state === 'listening' || this.state === 'thinking') {
      this.floor = 'user';
      this.appendLog(atMs, 'user-start', 'user started speaking');
    }
  }

  private onUserSpeechEnd(atMs: number): void {
    this.appendLog(atMs, 'user-end', 'user stopped speaking');
  }

  private onSilenceTimeout(atMs: number, silenceMs: number): void {
    this.appendLog(atMs, 'user-end', `silence timeout after ${silenceMs}ms — turn over`);
    if (this.state === 'listening') {
      this.turnIndex += 1;
      this.transcript.closeTurn(atMs, false);
      this.transition('thinking', atMs, 'think');
      this.floor = 'agent';
    }
  }

  private stopPlayback(
    atMs: number,
    why: 'barge-in' | 'paused' | 'stopped',
    cut?: { spokenText: string; remainingText: string; userText: string },
  ): void {
    const flushed = this.transport.flush(atMs);
    if (cut) {
      this.spokenChars = cut.spokenText.length;
      this.pendingResumeReply = cut.remainingText || null;
      this.transcript.closeTurn(atMs, true);
      this.appendLog(atMs, 'interrupt-stop', `playback stopped (${why}): spoke "${cut.spokenText.slice(0, 80)}", kept ${cut.remainingText.length} chars, flushed ${flushed.flushedOut} chunks`);
    } else {
      this.pendingResumeReply = this.currentReply;
      this.appendLog(atMs, 'interrupt-stop', `playback stopped (${why}), flushed ${flushed.flushedOut} chunks`);
    }
    this.agentSpeaking = false;
    this.currentReply = null;
    this.agentReplyStartedAtMs = null;
  }

  private checkTimeouts(atMs: number): void {
    if (this.state === 'ended' || this.state === 'idle') return;
    if (this.maxSessionMs > 0 && this.startedAtMs !== null && atMs - this.startedAtMs >= this.maxSessionMs) {
      this.appendLog(atMs, 'timeout', `max session length ${this.maxSessionMs}ms reached`);
      this.stop(atMs, 'timeout');
      return;
    }
    if (this.idleTimeoutMs > 0 && this.lastUserActivityAtMs !== null && atMs - this.lastUserActivityAtMs >= this.idleTimeoutMs) {
      this.appendLog(atMs, 'timeout', `idle timeout ${this.idleTimeoutMs}ms reached`);
      this.stop(atMs, 'idle-timeout');
    }
  }

  private transition(next: VoiceV28SessionState, atMs: number, kind: VoiceV28SessionLogEvent['kind']): void {
    const allowed = VOICE_V28_STATE_TRANSITIONS[this.state] ?? [];
    if (!allowed.includes(next) && next !== this.state) {
      throw new Error(`invalid voice v28 transition: ${this.state} -> ${next}`);
    }
    this.state = next;
    this.updatedAtMs = atMs;
    this.appendLog(atMs, kind, `${this.state}`);
  }

  private appendLog(atMs: number, kind: VoiceV28SessionLogEvent['kind'], detail: string): void {
    this.log.push({ atMs, kind, detail });
    if (this.log.length > this.maxLogEvents) this.log.shift();
    this.updatedAtMs = Math.max(this.updatedAtMs, atMs);
  }

  private requireLive(action: string): void {
    if (this.state === 'idle') throw new Error(`cannot ${action}: session has not started`);
    if (this.state === 'ended') throw new Error(`cannot ${action}: session has ended`);
  }

  private assertAtMs(atMs: number): void {
    if (!Number.isFinite(atMs) || atMs < 0) throw new Error('atMs must be a non-negative finite number');
  }
}

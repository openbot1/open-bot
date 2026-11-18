/**
 * Realtime pipeline v3 (v1.19, Đội T5 — voice v18).
 *
 * v17 wired VAD v5 + barge-in v5 + TTS v3 + turn-taking v5 into
 * one session — but a dropped connection ended the conversation:
 * there was no record of *where* the session was, so a reconnect
 * started from silence and the interrupted reply was lost. v18
 * keeps the v17 turn flow and adds the session layer a long call
 * needs:
 *
 *   1. Session lifecycle. `connection` is explicit:
 *      `connecting` → `connected` → (`reconnecting` → `connected`)*
 *      → `closed`. `connect()` resolves the voice profile, opens
 *      the turn-taking machine and marks the session live;
 *      `disconnect()` cancels the TTS stream and closes cleanly.
 *   2. Checkpoints. Every turn boundary and every barge-in cut
 *      writes a checkpoint: turn id, user text, reply text, spoken
 *      chars, remaining text, voice profile id, turn-taking state
 *      and the virtual clock. Checkpoints are numbered, kept in a
 *      bounded ring (`maxCheckpoints`, default 20), and emitted as
 *      `checkpoint` events — the panel can show "checkpoint #7".
 *   3. Recovery. `simulateDrop()` drops the connection (the test
 *      double for a dead socket); `reconnect()` restores the last
 *      checkpoint: the turn-taking machine resets to `listening`,
 *      the interrupted reply is re-spoken from the cut point when
 *      the resume plan says `resume` (or restarted / summarised /
 *      dropped per the plan), and a `recovered` event reports how
 *      many turns were restored and whether anything was lost.
 *      A resume token (`resumeToken()` / `restoreFromToken()`)
 *      serialises the last checkpoint so a *new* session object
 *      can pick up where the old one died.
 *   4. Interruption handling. While the agent speaks, mic frames
 *      flow through the noise chain → VAD v18 → barge-in v18:
 *      an early warning ducks the TTS, a confirmed cut stops the
 *      stream *now*, checkpoints the cut, and applies the resume
 *      plan (auto or held for `resumeAfterCut()`).
 *   5. The v18 audio chain, wired. Frames go noise-chain →
 *      AdaptiveVadV18 → (barge-in while speaking); transcripts go
 *      Smart Turn v16 → reply function → TTS streaming v18 with
 *      the profile resolved per user + bot + context from the
 *      v18 profile store (with tuning + switch rules + usage).
 *
 * All clocks are virtual (`nowMs`, starts at 0); `tick(ms)`
 * advances the TTS stream, the turn-taking watchdog, the barge-in
 * capture window and the smart-turn timer together. The reply
 * function is injected (`replyFor`); the default is a scripted
 * echo. No network, no sound card, no key — mock audio only.
 */

import { AdaptiveVadV18, createVadV18, type VadV18Options } from './vadV18';
import { NoiseChainV18, createNoiseChainV18, type NoiseChainV18Options } from './noiseSuppressionV18';
import { BargeInEngineV18, createBargeInEngineV18, type BargeInV18CutRecord, type BargeInV18Options } from './bargeInV18';
import { TtsStreamV18, createTtsStreamV18, type TtsStreamV18Options } from './ttsStreamV18';
import type { TtsV17ChunkPriority } from '../voiceV17/ttsStreamV17';
import type { VoiceProfileV17Context } from '../voiceV17/voiceProfilesV17';
import {
  VoiceProfileStoreV18,
  createVoiceProfileStoreV18,
  type VoiceProfileV18,
} from './voiceProfilesV18';
import {
  TurnTakingMachineV17,
  createTurnTakingMachineV17,
  type TurnTakingV17Options,
  type TurnTakingV17State,
} from '../voiceV17/turnTakingV17';
import { SmartTurnDetectorV16, createSmartTurnDetectorV16, type SmartTurnV16Options } from '../voiceV16/smartTurnV16';
import { syntheticFrameV15 } from '../voiceV15/bargeInV15';

export type RealtimeV18ConnectionState = 'connecting' | 'connected' | 'reconnecting' | 'closed';
export type VoiceSessionV18State = TurnTakingV17State;

export type RealtimeV18EventKind =
  | 'connected'
  | 'state'
  | 'turn-end'
  | 'reply'
  | 'barge-in'
  | 'resume-plan'
  | 'resumed'
  | 'checkpoint'
  | 'recovered'
  | 'dropped'
  | 'vad-noise'
  | 'false-trigger'
  | 'threshold-adapted'
  | 'error';

export interface RealtimeV18Event {
  kind: RealtimeV18EventKind;
  atMs: number;
  message?: string;
  text?: string;
  cut?: BargeInV18CutRecord;
  reason?: string;
  checkpointSeq?: number;
  turnsRestored?: number;
}

export type RealtimeV18Sink = (event: RealtimeV18Event) => void;

/** One saved point in a session's life (numbered, bounded ring). */
export interface RealtimeV18Checkpoint {
  seq: number;
  atMs: number;
  turnId: string;
  userText: string;
  replyText: string;
  spokenChars: number;
  remainingText: string;
  profileId: string | undefined;
  turnState: VoiceSessionV18State;
  connectionState: RealtimeV18ConnectionState;
  resumeAction: string | undefined;
}

export interface RealtimeV18Turn {
  id: string;
  userText: string;
  replyText: string;
  spokenBeforeCut?: string;
  atMs: number;
}

export interface RealtimeV18Options {
  botId?: string;
  userId?: string;
  language?: string;
  voiceContext?: VoiceProfileV17Context;
  replyFor?: (text: string) => string | Promise<string>;
  autoResume?: boolean;
  profiles?: VoiceProfileStoreV18;
  maxCheckpoints?: number;
  maxReconnectAttempts?: number;
  vad?: VadV18Options;
  noise?: NoiseChainV18Options;
  bargeIn?: BargeInV18Options;
  ttsStream?: TtsStreamV18Options;
  turnTaking?: TurnTakingV17Options;
  smartTurn?: SmartTurnV16Options;
}

export function defaultRealtimeV18Options(): Required<Omit<RealtimeV18Options, 'replyFor' | 'profiles' | 'vad' | 'noise' | 'bargeIn' | 'ttsStream' | 'turnTaking' | 'smartTurn' | 'userId'>> {
  return {
    botId: 'default-bot',
    language: 'vi',
    voiceContext: 'chat',
    autoResume: true,
    maxCheckpoints: 20,
    maxReconnectAttempts: 3,
  };
}

export interface RealtimeV18Stats {
  connection: RealtimeV18ConnectionState;
  state: VoiceSessionV18State;
  turns: number;
  bargeIns: number;
  resumes: number;
  restarts: number;
  summarises: number;
  drops: number;
  checkpoints: number;
  lastCheckpointSeq: number | undefined;
  reconnects: number;
  reconnectAttempts: number;
  recoveredTurns: number;
  lostTurns: number;
  vad: ReturnType<AdaptiveVadV18['stats']>;
  noise: ReturnType<NoiseChainV18['stats']>;
  bargeIn: ReturnType<BargeInEngineV18['stats']>;
  smartTurn: ReturnType<SmartTurnDetectorV16['stats']>;
  tts: ReturnType<TtsStreamV18['stats']>;
  turnTaking: ReturnType<TurnTakingMachineV17['getStats']>;
  profiles: ReturnType<VoiceProfileStoreV18['stats']>;
}

export class RealtimeSessionV18 {
  readonly id: string;
  readonly botId: string;
  readonly userId: string | undefined;
  readonly language: string;
  readonly voiceContext: VoiceProfileV17Context;
  readonly profiles: VoiceProfileStoreV18;
  readonly vad: AdaptiveVadV18;
  readonly noise: NoiseChainV18;
  readonly bargeIn: BargeInEngineV18;
  readonly smartTurn: SmartTurnDetectorV16;
  readonly tts: TtsStreamV18;
  readonly turnTaking: TurnTakingMachineV17;
  private readonly sink: RealtimeV18Sink | undefined;
  private readonly replyFor: (text: string) => string | Promise<string>;
  private readonly autoResume: boolean;
  private readonly maxCheckpoints: number;
  private readonly maxReconnectAttempts: number;
  private nowMs = 0;
  private connection: RealtimeV18ConnectionState = 'connecting';
  private turns: RealtimeV18Turn[] = [];
  private turnCounter = 0;
  private currentTurnId = '';
  private pendingUserText = '';
  private pendingCut: BargeInV18CutRecord | undefined;
  private lastCutHandled: BargeInV18CutRecord | undefined;
  private checkpoints: RealtimeV18Checkpoint[] = [];
  private checkpointSeq = 0;
  private reconnects = 0;
  private reconnectAttempts = 0;
  private recoveredTurns = 0;
  private lostTurns = 0;
  private resumes = 0;
  private restarts = 0;
  private summarises = 0;
  private drops = 0;
  private events: RealtimeV18Event[] = [];

  constructor(id: string, options: RealtimeV18Options = {}, sink?: RealtimeV18Sink) {
    const defaults = defaultRealtimeV18Options();
    this.id = id;
    this.botId = options.botId ?? defaults.botId;
    this.userId = options.userId;
    this.language = options.language ?? defaults.language;
    this.voiceContext = options.voiceContext ?? defaults.voiceContext;
    this.replyFor = options.replyFor ?? ((text: string) => `Bạn nói: ${text}`);
    this.autoResume = options.autoResume ?? defaults.autoResume;
    this.maxCheckpoints = options.maxCheckpoints ?? defaults.maxCheckpoints;
    this.maxReconnectAttempts = options.maxReconnectAttempts ?? defaults.maxReconnectAttempts;
    this.profiles = options.profiles ?? createVoiceProfileStoreV18(this.botId);
    this.sink = sink;
    this.noise = createNoiseChainV18(options.noise);
    this.vad = createVadV18({ calibrationFrames: 0, ...(options.vad ?? {}) }, (event) => {
      if (event.kind === 'speech-start') this.turnTaking.handle({ kind: 'vad-speech-start', atMs: event.atMs });
      if (event.kind === 'speech-end') this.turnTaking.handle({ kind: 'vad-speech-end', atMs: event.atMs });
      if (event.kind === 'noise-burst') this.turnTaking.handle({ kind: 'vad-noise', atMs: event.atMs });
      if (event.kind === 'false-trigger') this.emit({ kind: 'false-trigger', atMs: event.atMs, text: event.falseTrigger?.id });
      if (event.kind === 'threshold-adapted') this.emit({ kind: 'threshold-adapted', atMs: event.atMs });
    });
    this.bargeIn = createBargeInEngineV18(options.bargeIn, (event) => {
      if (event.kind === 'early-warning') {
        // Duck the TTS stream while the user starts talking.
        this.tts.pause(this.nowMs);
        this.tts.resume(this.nowMs);
      }
      // NOTE: a 'cut' event is NOT handled here. The v17 engine
      // re-decides the resume plan with the interrupting text
      // *after* the cut event fires (interrupt path), so a record
      // handled from the sink would carry the stale cut-time plan.
      // Cuts are handled once, from the tick()/interrupt() return
      // values in tick()/interrupt() below — onCut() guards
      // duplicates anyway.
    });
    this.smartTurn = createSmartTurnDetectorV16(
      {
        language: this.language === 'vi' ? 'vi' : this.language === 'en' ? 'en' : 'auto',
        ...(options.smartTurn ?? {}),
      },
      (event) => {
        if (event.kind === 'end' || event.kind === 'timeout') void this.onTurnEnd(event.text, event.atMs);
        if (event.kind === 'prompt') this.emit({ kind: 'state', atMs: event.atMs, message: 'User seems to be still thinking; prompting.' });
      },
    );
    this.tts = createTtsStreamV18(undefined, options.ttsStream, (event) => {
      if (event.kind === 'done') {
        this.turnTaking.handle({ kind: 'reply-done', atMs: event.atMs });
      }
      if (event.kind === 'sentence-queued' && this.turnTaking.getState() === 'speaking') {
        this.turnTaking.handle({ kind: 'sentence-end', atMs: event.atMs });
      }
    });
    this.turnTaking = createTurnTakingMachineV17(
      { initialState: 'idle', ...(options.turnTaking ?? {}) },
      (event) => {
        if (event.kind === 'turn-state') {
          this.emit({ kind: 'state', atMs: event.transition.atMs, message: `${event.transition.from} → ${event.transition.to}` });
        }
        if (event.kind === 'turn-prompt') {
          this.emit({ kind: 'state', atMs: event.atMs, message: `prompt: ${event.reason}` });
        }
        if (event.kind === 'turn-recovered') {
          this.emit({ kind: 'recovered', atMs: event.transition.atMs, reason: event.transition.reason, message: `Recovered stuck state → listening (${event.transition.reason}).` });
        }
      },
    );
  }

  private emit(event: RealtimeV18Event): void {
    this.events.push(event);
    if (this.sink) this.sink(event);
  }

  getState(): VoiceSessionV18State {
    return this.turnTaking.getState();
  }

  getConnection(): RealtimeV18ConnectionState {
    return this.connection;
  }

  now(): number {
    return this.nowMs;
  }

  resolveProfile(): { profile: VoiceProfileV18; via: string } {
    const result = this.profiles.resolve({
      ...(this.userId !== undefined ? { userId: this.userId } : {}),
      botId: this.botId,
      context: this.voiceContext,
      language: this.language,
    });
    return { profile: result.tunedProfile, via: result.via };
  }

  async connect(): Promise<void> {
    if (this.connection === 'closed') this.turnTaking.reset('reconnect');
    this.connection = 'connected';
    this.turnTaking.handle({ kind: 'connect', atMs: this.nowMs });
    this.emit({ kind: 'connected', atMs: this.nowMs });
  }

  disconnect(reason = 'client-close'): void {
    if (this.tts.isSpeaking()) this.tts.cancel(this.nowMs);
    this.connection = 'closed';
    this.turnTaking.handle({ kind: 'disconnect', atMs: this.nowMs, reason });
    this.emit({ kind: 'state', atMs: this.nowMs, message: `closed (${reason})` });
  }

  /** Advance the virtual clock (TTS, watchdog, barge-in, smart-turn together). */
  tick(ms: number): void {
    this.nowMs += ms;
    this.tts.tick(ms);
    this.turnTaking.tick(this.nowMs);
    const cut = this.bargeIn.tick(this.nowMs);
    if (cut) this.onCut(cut);
    this.smartTurn.tick(this.nowMs);
  }

  /** Feed one 20 ms PCM16 frame through the noise chain → VAD → barge-in. */
  feedAudioFrame(frame: Int16Array, echo = false): void {
    const cleaned = this.noise.process(frame, this.nowMs, this.vad.isSpeaking());
    this.vad.feed(cleaned.frame, this.nowMs, echo);
    if (this.bargeIn.isAgentSpeaking()) {
      // Mock TTS level: low enough that normal user speech (true RMS
      // ~0.18 for a 0.25 synthetic frame) clears the echo margin
      // (level × 1.6), while quiet room noise does not.
      this.bargeIn.setTtsLevel(0.05);
      // A cut born here arrives via the barge-in sink → onCut().
      this.bargeIn.feed({ frame: cleaned.frame, atMs: this.nowMs, echo });
    }
  }

  feedTranscriptPartial(text: string): void {
    this.smartTurn.feedPartial(text, this.nowMs);
    this.bargeIn.feedInterruptingText(text, this.nowMs);
  }

  feedSilence(ms: number): void {
    const state = this.getState();
    if (state !== 'listening' && state !== 'speaking') return;
    // Silence is measured on the virtual clock (atMs − last speech):
    // advance the clock first, then report the silence at the new time.
    this.tick(ms);
    this.smartTurn.feedSilence(ms, this.nowMs);
  }

  feedTranscriptFinal(text: string): void {
    const state = this.getState();
    if (state !== 'listening' && state !== 'speaking' && state !== 'interrupted') return;
    const out = this.smartTurn.feedPartial(text, this.nowMs);
    // The detector needs silence after the words before it decides:
    // advance past the gap it asked for, feed the silence at the new
    // time, and let its sink fire 'end' (or hold, when the sentence
    // is incomplete — the detector guards that itself).
    if (out) {
      this.tick(out.requiredSilenceMs);
      this.smartTurn.feedSilence(out.requiredSilenceMs, this.nowMs);
    }
  }

  /** Speak a reply now, through TTS streaming v18 with the resolved profile. */
  async speakReply(text: string, priority: TtsV17ChunkPriority = 'normal'): Promise<void> {
    const state = this.getState();
    if (state !== 'listening' && state !== 'thinking' && state !== 'speaking') return;
    const { profile } = this.resolveProfile();
    this.turnCounter += 1;
    this.currentTurnId = `turn-${this.turnCounter}`;
    this.bargeIn.beginAgentTurn(this.currentTurnId, this.pendingUserText, text, this.nowMs);
    this.turnTaking.handle({ kind: 'reply-start', atMs: this.nowMs });
    if (this.tts.isSpeaking() || this.tts.isPaused()) this.tts.cancel(this.nowMs);
    this.tts.speak(text, profile, priority, this.nowMs);
    this.profiles.noteUsage(profile.id, text.length, this.nowMs);
    this.turns.push({ id: this.currentTurnId, userText: this.pendingUserText, replyText: text, atMs: this.nowMs });
    this.emit({ kind: 'reply', atMs: this.nowMs, text });
    this.writeCheckpoint(text, this.tts.spokenText().length, profile.id, undefined);
  }

  interrupt(atMs: number, interruptingText?: string): BargeInV18CutRecord | undefined {
    const record = this.bargeIn.interrupt(atMs, interruptingText);
    if (record) this.onCut(record);
    return record;
  }

  lastCut(): BargeInV18CutRecord | undefined {
    return this.bargeIn.lastCut();
  }

  pendingResumePlan(): BargeInV18CutRecord | undefined {
    return this.pendingCut;
  }

  async resumeAfterCut(): Promise<void> {
    const record = this.pendingCut;
    if (!record) return;
    this.pendingCut = undefined;
    await this.applyPlan(record);
  }

  // --- checkpoints + recovery -------------------------------------------------

  /** Write a checkpoint for the current turn (bounded ring). */
  writeCheckpoint(replyText: string, spokenChars: number, profileId: string | undefined, resumeAction: string | undefined): RealtimeV18Checkpoint {
    this.checkpointSeq += 1;
    const checkpoint: RealtimeV18Checkpoint = {
      seq: this.checkpointSeq,
      atMs: this.nowMs,
      turnId: this.currentTurnId,
      userText: this.pendingUserText,
      replyText,
      spokenChars,
      remainingText: replyText.slice(spokenChars),
      profileId,
      turnState: this.getState(),
      connectionState: this.connection,
      resumeAction,
    };
    this.checkpoints.push(checkpoint);
    while (this.checkpoints.length > this.maxCheckpoints) this.checkpoints.shift();
    this.emit({ kind: 'checkpoint', atMs: this.nowMs, checkpointSeq: checkpoint.seq });
    return checkpoint;
  }

  checkpointsList(): RealtimeV18Checkpoint[] {
    return [...this.checkpoints];
  }

  lastCheckpoint(): RealtimeV18Checkpoint | undefined {
    return this.checkpoints.length > 0 ? this.checkpoints[this.checkpoints.length - 1] : undefined;
  }

  /** Opaque resume token for the last checkpoint (a new session can restore from it). */
  resumeToken(): string | undefined {
    const checkpoint = this.lastCheckpoint();
    if (!checkpoint) return undefined;
    return JSON.stringify({ version: 1, checkpoint });
  }

  /** Restore a session from a resume token (returns false when the token is invalid). */
  restoreFromToken(token: string): boolean {
    let parsed: unknown;
    try {
      parsed = JSON.parse(token);
    } catch {
      return false;
    }
    if (typeof parsed !== 'object' || parsed === null) return false;
    const obj = parsed as { version?: unknown; checkpoint?: unknown };
    if (obj.version !== 1 || typeof obj.checkpoint !== 'object' || obj.checkpoint === null) return false;
    const checkpoint = obj.checkpoint as RealtimeV18Checkpoint;
    if (typeof checkpoint.turnId !== 'string' || typeof checkpoint.replyText !== 'string') return false;
    this.checkpoints.push(checkpoint);
    this.currentTurnId = checkpoint.turnId;
    this.pendingUserText = checkpoint.userText;
    this.recoveredTurns += 1;
    return true;
  }

  /** Drop the connection (test double for a dead socket). */
  simulateDrop(reason = 'transport-lost'): void {
    if (this.connection !== 'connected') return;
    this.connection = 'reconnecting';
    if (this.tts.isSpeaking()) this.tts.pause(this.nowMs);
    this.emit({ kind: 'dropped', atMs: this.nowMs, reason });
  }

  /** Reconnect and restore the last checkpoint (up to `maxReconnectAttempts`). */
  async reconnect(): Promise<boolean> {
    if (this.connection !== 'reconnecting') return this.connection === 'connected';
    this.reconnectAttempts += 1;
    if (this.reconnectAttempts > this.maxReconnectAttempts) {
      this.lostTurns += 1;
      this.connection = 'closed';
      this.emit({ kind: 'error', atMs: this.nowMs, message: `reconnect failed after ${this.maxReconnectAttempts} attempts` });
      return false;
    }
    const checkpoint = this.lastCheckpoint();
    this.connection = 'connected';
    this.reconnects += 1;
    this.turnTaking.reset('reconnect');
    this.turnTaking.handle({ kind: 'connect', atMs: this.nowMs });
    if (checkpoint && checkpoint.remainingText.length > 0 && checkpoint.resumeAction !== 'drop') {
      this.recoveredTurns += 1;
      this.pendingUserText = checkpoint.userText;
      await this.speakReply(checkpoint.remainingText);
    }
    this.emit({ kind: 'recovered', atMs: this.nowMs, checkpointSeq: checkpoint?.seq, turnsRestored: checkpoint ? 1 : 0 });
    return true;
  }

  // --- internals ---------------------------------------------------------------

  private onCut(record: BargeInV18CutRecord): void {
    // One cut, one handling: the same record reaches onCut() from
    // the barge-in sink and again from tick()/interrupt() returns.
    if (this.lastCutHandled === record) return;
    this.lastCutHandled = record;
    const cancelled = this.tts.cancelUnplayed(this.nowMs);
    this.bargeIn.setSpokenProgress(cancelled.spokenChars);
    const lastTurn = this.turns[this.turns.length - 1];
    if (lastTurn) lastTurn.spokenBeforeCut = this.tts.spokenText();
    this.pendingCut = record;
    this.turnTaking.handle({ kind: 'barge-in', atMs: this.nowMs });
    this.writeCheckpoint(record.replyText, cancelled.spokenChars, this.resolveProfile().profile.id, record.cut.plan.action);
    this.emit({ kind: 'barge-in', atMs: this.nowMs, cut: record, text: record.interruptingText });
    this.emit({ kind: 'resume-plan', atMs: this.nowMs, text: record.cut.plan.action });
    if (this.autoResume) void this.applyPlan(record);
  }

  private async applyPlan(record: BargeInV18CutRecord): Promise<void> {
    const plan = record.cut.plan;
    if (plan.action === 'resume') {
      this.resumes += 1;
      if (plan.resumeText.length > 0) await this.speakReply(plan.resumeText);
      this.emit({ kind: 'resumed', atMs: this.nowMs, text: plan.resumeText });
    } else if (plan.action === 'restart') {
      this.restarts += 1;
      await this.speakReply(record.replyText);
      this.emit({ kind: 'resumed', atMs: this.nowMs, text: record.replyText });
    } else if (plan.action === 'summarise') {
      this.summarises += 1;
      await this.speakReply(plan.resumeText);
      this.emit({ kind: 'resumed', atMs: this.nowMs, text: plan.resumeText });
    } else {
      this.drops += 1;
    }
    if (this.pendingCut === record) this.pendingCut = undefined;
  }

  private async onTurnEnd(userText: string, atMs: number): Promise<void> {
    this.pendingUserText = userText;
    this.turnTaking.handle({ kind: 'vad-speech-end', atMs, reason: 'turn-end' });
    this.emit({ kind: 'turn-end', atMs, text: userText });
    const reply = await this.replyFor(userText);
    await this.speakReply(reply);
  }

  turnsList(): RealtimeV18Turn[] {
    return [...this.turns];
  }

  eventsList(): RealtimeV18Event[] {
    return [...this.events];
  }

  stats(): RealtimeV18Stats {
    const bargeInStats = this.bargeIn.stats();
    return {
      connection: this.connection,
      state: this.getState(),
      turns: this.turns.length,
      bargeIns: bargeInStats.cuts,
      resumes: this.resumes,
      restarts: this.restarts,
      summarises: this.summarises,
      drops: this.drops,
      checkpoints: this.checkpoints.length,
      lastCheckpointSeq: this.lastCheckpoint()?.seq,
      reconnects: this.reconnects,
      reconnectAttempts: this.reconnectAttempts,
      recoveredTurns: this.recoveredTurns,
      lostTurns: this.lostTurns,
      vad: this.vad.stats(),
      noise: this.noise.stats(this.nowMs),
      bargeIn: bargeInStats,
      smartTurn: this.smartTurn.stats(),
      tts: this.tts.stats(),
      turnTaking: this.turnTaking.getStats(),
      profiles: this.profiles.stats(),
    };
  }

  summary(): string {
    const s = this.stats();
    return (
      `Realtime v18 session ${this.id}: ${s.connection}/${s.state}, ${s.turns} turns, ` +
      `${s.bargeIns} barge-ins (${s.resumes} resumed), ${s.checkpoints} checkpoints, ` +
      `${s.reconnects} reconnects (${s.recoveredTurns} turns recovered, ${s.lostTurns} lost)`
    );
  }

  markdown(): string {
    const s = this.stats();
    const rows: string[] = [
      `# Realtime v18 session ${this.id}`,
      '',
      `- Connection: ${s.connection}, turn state: ${s.state}`,
      `- Turns: ${s.turns}, barge-ins: ${s.bargeIns} (resumed ${s.resumes}, restarted ${s.restarts}, summarised ${s.summarises}, dropped ${s.drops})`,
      `- Checkpoints: ${s.checkpoints} (last #${s.lastCheckpointSeq ?? 'none'}), reconnects: ${s.reconnects} (recovered ${s.recoveredTurns} turns, lost ${s.lostTurns})`,
      `- VAD v18: ${s.vad.frames} frames, ${s.vad.confirmedSpeechStarts} confirmed starts, ${s.vad.falseTriggers} false triggers, threshold ${s.vad.startThreshold.toFixed(2)}`,
      `- Noise chain: ${s.noise.frames} frames, suppression ${s.noise.suppressor.averageSuppressionDb.toFixed(1)} dB, gate closed ${s.noise.gate.gatedFrames} frames`,
      `- Barge-in v18: ${s.bargeIn.earlyWarnings} early warnings, ${s.bargeIn.echoSuppressedFrames} echo frames suppressed`,
      `- TTS v18: ${s.tts.chunksSpoken} chunks spoken, first-chunk ${s.tts.averageFirstChunkLatencyMs.toFixed(0)} ms avg (p95 ${s.tts.p95FirstChunkLatencyMs.toFixed(0)} ms), ${s.tts.longSentencesSplit} long sentences split`,
      '',
    ];
    return rows.join('\n');
  }
}

export function createRealtimeSessionV18(id: string, options: RealtimeV18Options = {}, sink?: RealtimeV18Sink): RealtimeSessionV18 {
  return new RealtimeSessionV18(id, options, sink);
}

/** A session manager: sessions by id, one shared v18 profile store. */
export class RealtimeSessionManagerV18 {
  readonly profiles: VoiceProfileStoreV18;
  private readonly sessions = new Map<string, RealtimeSessionV18>();

  constructor(seedPresetsForBot?: string) {
    this.profiles = createVoiceProfileStoreV18(seedPresetsForBot);
  }

  create(id: string, options: RealtimeV18Options = {}, sink?: RealtimeV18Sink): RealtimeSessionV18 {
    if (this.sessions.has(id)) throw new Error(`Voice realtime v18 session "${id}" already exists.`);
    const session = new RealtimeSessionV18(id, { ...options, profiles: options.profiles ?? this.profiles }, sink);
    this.sessions.set(id, session);
    return session;
  }

  get(id: string): RealtimeSessionV18 | undefined {
    return this.sessions.get(id);
  }

  delete(id: string): boolean {
    const session = this.sessions.get(id);
    if (!session) return false;
    session.disconnect('deleted');
    return this.sessions.delete(id);
  }

  list(): RealtimeSessionV18[] {
    return [...this.sessions.values()];
  }

  count(): number {
    return this.sessions.size;
  }
}

export function createRealtimeSessionManagerV18(seedPresetsForBot?: string): RealtimeSessionManagerV18 {
  return new RealtimeSessionManagerV18(seedPresetsForBot);
}

/** Build a synthetic 20 ms frame (tests / calibration). */
export function syntheticFrameV18(rms: number): Int16Array {
  return syntheticFrameV15(rms, 320);
}

/** One-line summary of a realtime v18 session. */
export function realtimeV18Summary(session: RealtimeSessionV18): string {
  return session.summary();
}

/** Markdown report of a realtime v18 session. */
export function realtimeV18Markdown(session: RealtimeSessionV18): string {
  return session.markdown();
}

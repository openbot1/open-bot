/**
 * Durable realtime session v22 (voice v22, v1.35 Team T5).
 *
 * The orchestrator that wires the subsystem together into one
 * session that survives a dropped transport:
 *
 *   transcript ──► turn-taking (floor) ──► model ──► TTS (profile)
 *        ▲              │  (barge-in: duck / cut / queue)      │
 *        └──────────────┴──────────────────────────────────────┘
 *   journal ──► checkpoint ──► disconnect ──► backoff ──► resume
 *
 * The host drives it with transcripts, barge-in bursts and
 * heartbeats, and reads the outputs as events plus the
 * durability report. The STT and the model are injected as
 * functions so tests can drive the session with scripted
 * replies and the product can bind real providers later; the
 * defaults are deterministic mocks (the model answers from a
 * small script table, falling back to echoing the transcript).
 *
 * Durability flow:
 *
 *   1. Every state change is journalled in the store; a
 *      checkpoint is written on demand and automatically
 *      every N journal entries.
 *   2. A missed-heartbeat window degrades the session, then
 *      disconnects it. The recovery engine schedules a
 *      reconnect with exponential backoff.
 *   3. On reconnect the resume engine rehydrates from the
 *      checkpoint and replays the journal tail. A session
 *      that was speaking resumes paused, with the cut reply
 *      queued for the user to ask for — it never talks at an
 *      empty room.
 *   4. A barge-in while speaking ducks (soft: volume dip, hard:
 *      hold the reply) or interrupts (cut + queue the
 *      remainder). The queued remainder resumes, drops, or is
 *      summarised depending on how much was already spoken.
 */
import {
  round2V22,
  zeroCountersV22,
  type VoiceV22BargeInDecision,
  type VoiceV22DurabilityPhase,
  type VoiceV22Event,
  type VoiceV22EventKind,
  type VoiceV22EventSink,
  type VoiceV22FloorHolder,
  type VoiceV22JournalKind,
  type VoiceV22ReplyCut,
  type VoiceV22ResumeDisposition,
  type VoiceV22SessionCounters,
  type VoiceV22TranscriptSegment,
  type VoiceV22TurnRecord,
  type VoiceV22TurnState,
} from './types';
import {
  DurableSessionStoreV22,
  createDurableSessionStoreV22,
  type VoiceV22StoreOptions,
} from './sessionStoreV22';
import {
  ResumeEngineV22,
  createResumeEngineV22,
  type VoiceV22RebuiltState,
  type VoiceV22ResumeOptions,
  type VoiceV22ResumeReport,
} from './resumeV22';
import {
  BargeInEngineV22,
  createBargeInEngineV22,
  type VoiceV22BargeInCandidate,
} from './bargeInV22';
import {
  TurnTakingMachineV22,
  createTurnTakingMachineV22,
  type VoiceV22TurnTakingOptions,
} from './turnTakingV22';
import {
  VoiceProfileRegistryV22,
  createVoiceProfileRegistryV22,
  profileCharsPerSecondV22,
  type VoiceV22ProfileOptions,
} from './voiceProfilesV22';
import {
  RecoveryEngineV22,
  createRecoveryEngineV22,
  type VoiceV22Heartbeat,
  type VoiceV22RecoveryOptions,
} from './recoveryV22';

/** A model reply: text to speak for one final transcript. */
export type VoiceV22ModelReply = (transcript: string) => Promise<string>;

/** One mock TTS chunk (synthetic PCM). */
export interface VoiceV22TtsChunk {
  index: number;
  bytes: Uint8Array;
  /** Chars of text this chunk covers. */
  chars: number;
}

export interface VoiceV22SessionOptions {
  turnTaking?: Partial<VoiceV22TurnTakingOptions>;
  bargeIn?: Parameters<typeof createBargeInEngineV22>[1];
  store?: Partial<VoiceV22StoreOptions>;
  resume?: Partial<VoiceV22ResumeOptions>;
  recovery?: Partial<VoiceV22RecoveryOptions>;
  profiles?: Partial<VoiceV22ProfileOptions>;
  /** Starting voice profile id (default 'voice-v22-default'). */
  profileId?: string;
  /** Scripted model replies, matched by normalised transcript. */
  scriptedReplies?: Record<string, string>;
  /** Model function (default: scripted/echo mock). */
  modelReply?: VoiceV22ModelReply;
  /** Virtual clock start, ms (default 0). */
  startMs?: number;
  /** Chars per TTS chunk (default 120). */
  ttsChunkChars?: number;
}

export interface VoiceV22RealtimeSessionStats {
  turns: number;
  bargeIns: number;
  ducks: number;
  disconnects: number;
  resumes: number;
  recoveries: number;
  profileSwitches: number;
  ttsChunksSpoken: number;
  checkpoints: number;
  durabilityScore: number;
  phase: VoiceV22DurabilityPhase;
  state: VoiceV22TurnState;
  floor: VoiceV22FloorHolder;
  profileId: string;
  queuedReplies: number;
  meanResponseLatencyMs: number;
}

/** Durability report for the monitor panel. */
export interface VoiceV22DurabilityReport {
  sessionId: string;
  atMs: number;
  phase: VoiceV22DurabilityPhase;
  state: VoiceV22TurnState;
  floor: VoiceV22FloorHolder;
  profileId: string;
  journalSeq: number;
  lastCheckpointSeq: number | null;
  durabilityScore: number;
  counters: VoiceV22SessionCounters;
  lastResume: VoiceV22ResumeReport | null;
  nextReconnectAtMs: number | null;
}

export class VoiceSessionV22 {
  readonly sessionId: string;
  readonly turns: TurnTakingMachineV22;
  readonly bargeIn: BargeInEngineV22;
  readonly profiles: VoiceProfileRegistryV22;
  readonly recovery: RecoveryEngineV22;
  readonly resumeEngine: ResumeEngineV22;
  readonly store: DurableSessionStoreV22;
  private readonly opts: VoiceV22SessionOptions;
  private readonly sink?: VoiceV22EventSink;
  private readonly events: VoiceV22Event[] = [];
  private readonly transcript: VoiceV22TranscriptSegment[] = [];
  private readonly turnRecords: VoiceV22TurnRecord[] = [];
  private counters: VoiceV22SessionCounters = zeroCountersV22();
  private clockMs: number;
  private turnCounter = 0;
  private segmentCounter = 0;
  private currentReply = '';
  private currentReplySpokenChars = 0;
  private speaking = false;
  private ducked = false;
  private closed = false;
  private lastResume: VoiceV22ResumeReport | null = null;
  private lastCheckpointAtMs: number | null = null;

  constructor(sessionId: string, opts: VoiceV22SessionOptions = {}, sink?: VoiceV22EventSink) {
    this.sessionId = sessionId;
    this.opts = opts;
    this.clockMs = opts.startMs ?? 0;
    const fanout: VoiceV22EventSink = (e) => {
      this.events.push(e);
      sink?.(e);
    };
    this.sink = fanout;
    this.store = createDurableSessionStoreV22(sessionId, opts.store, fanout);
    this.resumeEngine = createResumeEngineV22(sessionId, opts.resume, fanout);
    this.turns = createTurnTakingMachineV22(sessionId, opts.turnTaking, fanout);
    this.bargeIn = createBargeInEngineV22(sessionId, opts.bargeIn, fanout);
    this.profiles = createVoiceProfileRegistryV22(sessionId, opts.profiles, fanout);
    this.recovery = createRecoveryEngineV22(sessionId, opts.recovery, fanout);
    if (opts.profileId !== undefined) {
      this.profiles.restoreCurrent(opts.profileId, this.clockMs);
    }
    this.store.append('session-open', this.clockMs, { profileId: this.profiles.current() });
  }

  nowMs(): number {
    return this.clockMs;
  }

  /** Advance the virtual clock (tests drive time explicitly). */
  advance(ms: number): void {
    this.clockMs += Math.max(0, ms);
    this.turns.checkWaitingTimeout(this.clockMs);
    this.turns.checkSilence(this.clockMs);
    this.recovery.checkClock(this.clockMs);
    if (this.recovery.phaseNow() === 'disconnected' && this.recovery.attemptDue(this.clockMs)) {
      // The host reports the attempt outcome; the session only
      // notes that one is due. Nothing is dialled here.
      this.store.append('reconnect', this.clockMs, { due: true });
    }
  }

  state(): VoiceV22TurnState {
    return this.turns.currentState();
  }

  phase(): VoiceV22DurabilityPhase {
    return this.recovery.phaseNow();
  }

  floor(): VoiceV22FloorHolder {
    return this.turns.currentFloor();
  }

  eventLog(): VoiceV22Event[] {
    return [...this.events];
  }

  eventsOf(kind: VoiceV22EventKind): VoiceV22Event[] {
    return this.events.filter((e) => e.kind === kind);
  }

  private journal(kind: VoiceV22JournalKind, atMs: number, detail?: Record<string, unknown>): void {
    this.store.append(kind, atMs, detail);
  }

  private newTurnId(): string {
    return `v22-turn-${++this.turnCounter}`;
  }

  private newSegmentId(): string {
    return `v22-seg-${++this.segmentCounter}`;
  }

  /** Open the session: idle → listening. */
  start(atMs?: number): void {
    const t = atMs ?? this.clockMs;
    this.clockMs = t;
    if (this.turns.currentState() === 'idle') {
      this.turns.setListening(t);
    }
    this.journal('turn-state', t, { to: 'listening', floor: 'user' });
  }

  /** Pause the session (manual park): any state → paused. */
  pause(atMs?: number): void {
    const t = atMs ?? this.clockMs;
    this.clockMs = t;
    this.speaking = false;
    this.turns.handle('pause', t);
    this.journal('turn-state', t, { to: 'paused' });
  }

  /** Resume a paused session: paused → listening. */
  resumePaused(atMs?: number): void {
    const t = atMs ?? this.clockMs;
    this.clockMs = t;
    this.turns.handle('resume', t);
    this.journal('turn-state', t, { to: 'listening', from: 'paused' });
  }

  /** Partial transcript update (live line on the panel). */
  async feedPartial(text: string, atMs?: number): Promise<void> {
    const t = atMs ?? this.clockMs;
    this.clockMs = t;
    const turn = this.turns.currentTurnRecord();
    const turnId = turn?.id ?? this.newTurnId();
    this.bargeIn.keeper.add(turnId, text, t);
    this.journal('transcript', t, { segmentId: this.newSegmentId(), turnId, text, status: 'partial' });
    this.sink?.({ kind: 'transcript', atMs: t, sessionId: this.sessionId, detail: { text, status: 'partial', turnId } });
  }

  /**
   * One final transcript line: closes the user turn, gets the
   * model reply, and speaks it. Returns the text actually
   * spoken (the summarised form when the session is degraded).
   */
  async feedFinal(text: string, atMs?: number): Promise<string> {
    const t = atMs ?? this.clockMs;
    this.clockMs = t;
    if (this.closed) return '';
    const turnId = this.newTurnId();
    const state = this.turns.currentState();
    if (state === 'idle' || state === 'listening' || state === 'speaking') {
      this.turns.handle('user-speech-start', t, { text });
    }
    this.bargeIn.keeper.finalise(turnId, text, t);
    this.bargeIn.noteUserWords(text.split(/\s+/).filter(Boolean));
    const segment: VoiceV22TranscriptSegment = {
      id: this.newSegmentId(),
      turnId,
      text,
      status: 'final',
      confidence: 0.95,
      atMs: t,
      throughSeq: 0,
    };
    this.transcript.push(segment);
    this.journal('transcript', t, { segmentId: segment.id, turnId, text, status: 'final', confidence: 0.95 });
    this.sink?.({ kind: 'transcript', atMs: t, sessionId: this.sessionId, detail: { text, status: 'final', turnId } });
    this.turns.handle('user-speech-end', t, { text });
    this.turnRecords.push({ id: turnId, role: 'user', text, atMs: t, durationMs: 0 });
    this.counters.turns += 1;
    this.journal('turn-state', t, { to: this.turns.currentState(), turnId });

    const reply = await this.modelReply(text);
    const spoken = await this.speak(reply, turnId, t);
    this.maybeCheckpoint(t);
    return spoken;
  }

  private async modelReply(transcript: string): Promise<string> {
    if (this.opts.modelReply !== undefined) return this.opts.modelReply(transcript);
    const normalised = transcript.toLowerCase().replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ').trim();
    const scripted = this.opts.scriptedReplies ?? {};
    for (const [key, reply] of Object.entries(scripted)) {
      if (normalised.includes(key.toLowerCase())) return reply;
    }
    return `I heard: ${transcript}`;
  }

  /**
   * Speak text through the mock TTS, chunk by chunk, in the
   * current voice profile. Chunks stream out as they arrive;
   * a barge-in stops the stream mid-sentence. When the
   * recovery engine has shed the TTS cache the reply is
   * summarised first (degraded mode speaks less). Returns the
   * text actually spoken (the summarised form when degraded).
   */
  async speak(text: string, turnId: string, atMs?: number): Promise<string> {
    const t = atMs ?? this.clockMs;
    this.clockMs = t;
    if (text.trim() === '') return '';
    const effective = this.recovery.isDegraded('replies-summarised') && text.length > 200
      ? `${text.slice(0, 197).trimEnd()}…`
      : text;
    this.currentReply = effective;
    this.currentReplySpokenChars = 0;
    this.turns.handle('agent-speak-start', t, { text: effective });
    this.speaking = true;
    this.ducked = false;
    this.sink?.({ kind: 'tts-start', atMs: t, sessionId: this.sessionId, detail: { text: effective, turnId, profileId: this.profiles.current() } });
    const chunks = this.synthesise(effective);
    for (const chunk of chunks) {
      // Yield per chunk so a barge-in can interleave mid-stream.
      // A macrotask yield (not just a microtask) so the host can
      // actually observe the agent mid-sentence and interrupt.
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (!this.speaking) break;
      this.counters.ttsChunksSpoken += 1;
      this.currentReplySpokenChars = Math.min(
        effective.length,
        this.currentReplySpokenChars + chunk.chars,
      );
      this.journal('tts-chunk', t, { chunkIndex: chunk.index, chars: chunk.chars });
      this.sink?.({ kind: 'tts-chunk', atMs: t, sessionId: this.sessionId, detail: { chunkIndex: chunk.index, bytes: chunk.bytes.byteLength } });
      if (this.ducked) {
        // Duck-hard holds the reply: stop here, keep the rest.
        // (The turn machine already handled the duck-hard event
        // in feedBargeIn; only hold the text here.)
        if (this.turns.heldReplyText() === null) {
          this.turns.holdReply(effective.slice(this.currentReplySpokenChars));
        }
        break;
      }
    }
    if (this.speaking && !this.ducked) {
      this.turns.handle('agent-speak-end', t, { text: effective });
      this.sink?.({ kind: 'tts-end', atMs: t, sessionId: this.sessionId, detail: { turnId, chunks: chunks.length } });
      const applied = this.profiles.applyPending(t);
      if (applied !== null) this.counters.profileSwitches += 1;
    }
    this.speaking = false;
    this.ducked = false;
    this.turnRecords.push({
      id: `${turnId}-agent`,
      role: 'agent',
      text: effective.slice(0, this.currentReplySpokenChars),
      atMs: t,
      durationMs: 0,
      profileId: this.profiles.current(),
      ...(this.currentReplySpokenChars < effective.length ? { bargeInCut: true } : {}),
    });
    return effective;
  }

  /** Deterministic mock synthesis: text → fixed-size PCM chunks. */
  synthesise(text: string): VoiceV22TtsChunk[] {
    const chunkChars = this.opts.ttsChunkChars ?? 120;
    const profile = this.profiles.currentProfile();
    const cps = profileCharsPerSecondV22(profile);
    void cps;
    const chunks: VoiceV22TtsChunk[] = [];
    let index = 0;
    for (let start = 0; start < text.length; start += chunkChars) {
      const slice = text.slice(start, start + chunkChars);
      const bytes = new Uint8Array(slice.length * 2);
      for (let i = 0; i < slice.length; i += 1) {
        const sample = Math.round(8000 * Math.sin((2 * Math.PI * 440 * (start + i)) / 16000) * profile.prosody.volume);
        bytes[i * 2] = sample & 0xff;
        bytes[i * 2 + 1] = (sample >> 8) & 0xff;
      }
      chunks.push({ index: index + 1, bytes, chars: slice.length });
      index += 1;
    }
    return chunks.length === 0 ? [{ index: 1, bytes: new Uint8Array(0), chars: 0 }] : chunks;
  }

  /**
   * A burst of user audio while the agent speaks. Returns the
   * decision; on `interrupt` the TTS stops, the reply is cut
   * and queued, and the session returns to listening. On
   * `duck-hard` the reply is held; on `duck-soft` it keeps
   * playing (the volume dip is a panel hint).
   */
  async feedBargeIn(
    candidate: Omit<VoiceV22BargeInCandidate, 'agentSpeaking'>,
    atMs?: number,
  ): Promise<{ decision: VoiceV22BargeInDecision; cut: VoiceV22ReplyCut | null }> {
    const t = atMs ?? this.clockMs;
    this.clockMs = t;
    const { decision } = this.bargeIn.observe({ ...candidate, agentSpeaking: this.speaking });
    this.journal('barge-in', t, { decision, words: candidate.words.join(' ') });
    if (decision === 'duck-soft') {
      this.counters.ducks += 1;
      this.turns.handle('duck-soft', t);
      return { decision, cut: null };
    }
    if (decision === 'duck-hard') {
      this.counters.ducks += 1;
      this.ducked = true;
      this.turns.handle('duck-hard', t, { text: this.currentReply.slice(this.currentReplySpokenChars) });
      this.turns.holdReply(this.currentReply.slice(this.currentReplySpokenChars));
      return { decision, cut: null };
    }
    if (decision !== 'interrupt') return { decision, cut: null };
    const turn = this.turns.currentTurnRecord();
    const turnId = turn?.id ?? this.newTurnId();
    const cut = this.bargeIn.cutReply(this.currentReply, this.currentReplySpokenChars, t, turnId);
    this.counters.bargeIns += 1;
    this.speaking = false; // Stops the speak() loop at the next chunk.
    this.turns.handle('barge-in', t, { text: cut.spoken });
    this.journal('barge-in', t, { decision, cutRemaining: cut.remaining, disposition: cut.disposition });
    return { decision, cut };
  }

  /**
   * Resume the oldest queued cut reply (after the user has had
   * their say). `drop` and `summarise` dispositions are honoured:
   * a dropped remainder is discarded, a summarised one speaks
   * one short sentence. Returns what was spoken ('' when none).
   */
  async resumeQueuedReply(atMs?: number): Promise<string> {
    const t = atMs ?? this.clockMs;
    this.clockMs = t;
    const queued = this.bargeIn.takeQueued();
    if (queued === null) return '';
    const held = this.turns.heldReplyText();
    if (held !== null) this.turns.clearHeldReply();
    const disposition: VoiceV22ResumeDisposition = queued.cut.disposition;
    if (disposition === 'drop' || queued.cut.remaining === '') return '';
    const text = disposition === 'summarise'
      ? this.bargeIn.summariseCut(queued.cut)
      : queued.cut.remaining;
    return this.speak(text, queued.turnId, t);
  }

  /** Switch voice profile (parked until the reply ends when speaking). */
  switchProfile(profileId: string, atMs?: number, reason?: string): string[] {
    const t = atMs ?? this.clockMs;
    this.clockMs = t;
    const errors = this.profiles.switchTo(profileId, t, this.speaking, reason);
    if (errors.length === 0) {
      this.journal('profile-switch', t, { profileId, speaking: this.speaking });
      if (!this.speaking) this.counters.profileSwitches += 1;
    }
    return errors;
  }

  /** Feed one heartbeat into the recovery engine. */
  heartbeat(beat: VoiceV22Heartbeat): VoiceV22DurabilityPhase {
    const phase = this.recovery.heartbeat(beat);
    if (phase === 'live' && this.turns.currentState() === 'paused' && this.recovery.stats().recoveries > 0) {
      // A recovered session unpauses itself once the transport is back.
      this.turns.handle('resume', beat.atMs);
    }
    return phase;
  }

  /** The transport reported the loss: disconnect at once. */
  simulateDisconnect(atMs: number, message = 'transport lost'): void {
    const t = atMs ?? this.clockMs;
    this.clockMs = t;
    this.speaking = false;
    this.recovery.markDisconnected(t, 'transport-lost', message, this.store.latestSeq());
    this.counters.disconnects += 1;
    this.turns.handle('pause', t);
    this.journal('disconnect', t, { message, journalSeq: this.store.latestSeq() });
    this.checkpointNow(t);
  }

  /**
   * Report a reconnect attempt outcome. On success the resume
   * engine rehydrates from the checkpoint + journal tail and
   * the session comes back paused, with the cut reply queued.
   */
  async attemptReconnect(atMs: number, outcome: 'success' | 'failure'): Promise<VoiceV22ResumeReport | null> {
    const t = atMs ?? this.clockMs;
    this.clockMs = t;
    const phase = this.recovery.reportAttempt(t, outcome, outcome === 'failure' ? 'transport-lost' : undefined);
    if (outcome === 'failure' || phase !== 'reconnecting') return null;
    this.journal('reconnect', t, { outcome: 'success' });
    return this.resumeFromStore(t);
  }

  /**
   * Resume from the store's checkpoint + journal tail, using
   * the checkpoint's own token. Returns the resume report.
   */
  resumeFromStore(atMs?: number): VoiceV22ResumeReport {
    const t = atMs ?? this.clockMs;
    this.clockMs = t;
    const checkpoint = this.store.latestCheckpoint();
    if (checkpoint === null) {
      const { report } = this.resumeEngine.resume(null, [], '', t);
      this.lastResume = report;
      this.recovery.markResumed(t, false);
      return report;
    }
    const tail = this.store.entriesSince(checkpoint.journalSeq);
    const { report, state } = this.resumeEngine.resume(checkpoint, tail, checkpoint.resumeToken, t);
    this.lastResume = report;
    if (state !== null) this.applyRebuiltState(state, t);
    this.recovery.markResumed(t, report.outcome === 'resumed-with-gaps');
    this.journal('resume', t, { outcome: report.outcome, coveredSeq: report.coveredSeq, missing: report.missingSeqs.length });
    return report;
  }

  /** Resume from an explicit token (client-presented). */
  resumeWithToken(token: string, atMs?: number): VoiceV22ResumeReport {
    const t = atMs ?? this.clockMs;
    this.clockMs = t;
    const checkpoint = this.store.latestCheckpoint();
    if (checkpoint === null) {
      const { report } = this.resumeEngine.resume(null, [], token, t);
      this.lastResume = report;
      return report;
    }
    const tail = this.store.entriesSince(checkpoint.journalSeq);
    const { report, state } = this.resumeEngine.resume(checkpoint, tail, token, t);
    this.lastResume = report;
    if (state !== null) this.applyRebuiltState(state, t);
    if (report.outcome === 'resumed' || report.outcome === 'resumed-with-gaps') {
      this.recovery.markResumed(t, report.outcome === 'resumed-with-gaps');
    }
    this.journal('resume', t, { outcome: report.outcome, coveredSeq: report.coveredSeq });
    return report;
  }

  private applyRebuiltState(state: VoiceV22RebuiltState, atMs: number): void {
    this.turnRecords.length = 0;
    for (const turn of state.turns) this.turnRecords.push({ ...turn });
    this.transcript.length = 0;
    for (const seg of state.transcript) this.transcript.push({ ...seg });
    this.counters = { ...state.counters };
    this.counters.resumes = state.counters.resumes;
    this.turns.restoreHistory(state.turns, atMs);
    this.turns.restoreState(state.turnState, state.floor, atMs);
    this.profiles.restoreCurrent(state.profileId, atMs);
    if (state.pendingReply !== null && state.pendingReply.remaining !== '') {
      this.bargeIn.cutReply(
        `${state.pendingReply.spoken} ${state.pendingReply.remaining}`.trim(),
        state.pendingReply.spokenChars,
        atMs,
        state.turns[state.turns.length - 1]?.id ?? this.newTurnId(),
      );
    }
    if (state.unfinalisedPartial !== '') {
      const turnId = state.turns[state.turns.length - 1]?.id ?? this.newTurnId();
      this.bargeIn.keeper.add(turnId, state.unfinalisedPartial, atMs);
    }
  }

  /** Write a checkpoint of the live state. */
  checkpointNow(atMs?: number): { checkpoint: import('./types').VoiceV22Checkpoint; checksum: string } | null {
    const t = atMs ?? this.clockMs;
    this.clockMs = t;
    const pendingReply = this.speaking && this.currentReply !== ''
      ? {
          spoken: this.currentReply.slice(0, this.currentReplySpokenChars),
          remaining: this.currentReply.slice(this.currentReplySpokenChars),
          spokenChars: this.currentReplySpokenChars,
          remainingChars: this.currentReply.length - this.currentReplySpokenChars,
          disposition: 'resume' as VoiceV22ResumeDisposition,
        }
      : null;
    const result = this.store.checkpointNow({
      atMs: t,
      turnState: this.turns.currentState(),
      durability: this.recovery.phaseNow(),
      floor: this.turns.currentFloor(),
      profileId: this.profiles.current(),
      turns: this.turnRecords.map((r) => ({ ...r })),
      transcript: this.transcript.map((s) => ({ ...s })),
      pendingReply,
      unfinalisedPartial: this.bargeIn.keeper.unfinalised().map((s) => s.text).join(' '),
      counters: { ...this.counters },
    });
    this.counters.checkpoints += 1;
    this.lastCheckpointAtMs = t;
    return result;
  }

  private maybeCheckpoint(atMs: number): void {
    const result = this.store.maybeAutoCheckpoint({
      atMs,
      turnState: this.turns.currentState(),
      durability: this.recovery.phaseNow(),
      floor: this.turns.currentFloor(),
      profileId: this.profiles.current(),
      turns: this.turnRecords.map((r) => ({ ...r })),
      transcript: this.transcript.map((s) => ({ ...s })),
      pendingReply: null,
      unfinalisedPartial: '',
      counters: { ...this.counters },
    });
    if (result !== null) {
      this.counters.checkpoints += 1;
      this.lastCheckpointAtMs = atMs;
    }
  }

  /** Serialise the whole durable store (for the host to persist). */
  snapshotJson(atMs?: number): string {
    return this.store.snapshotJson(atMs ?? this.clockMs);
  }

  /** Restore the store from a snapshot string; returns errors. */
  restoreSnapshotJson(json: string): string[] {
    return this.store.restoreJson(json);
  }

  /** Durability report for the monitor panel. */
  durabilityReport(atMs?: number): VoiceV22DurabilityReport {
    const t = atMs ?? this.clockMs;
    const checkpoint = this.store.latestCheckpoint();
    return {
      sessionId: this.sessionId,
      atMs: t,
      phase: this.recovery.phaseNow(),
      state: this.turns.currentState(),
      floor: this.turns.currentFloor(),
      profileId: this.profiles.current(),
      journalSeq: this.store.latestSeq(),
      lastCheckpointSeq: checkpoint?.journalSeq ?? null,
      durabilityScore: this.store.durabilityScore(),
      counters: { ...this.counters },
      lastResume: this.lastResume,
      nextReconnectAtMs: this.recovery.nextAttemptAt(),
    };
  }

  transcriptHistory(): VoiceV22TranscriptSegment[] {
    return this.transcript.map((s) => ({ ...s }));
  }

  turnHistory(): VoiceV22TurnRecord[] {
    return this.turnRecords.map((r) => ({ ...r }));
  }

  stats(): VoiceV22RealtimeSessionStats {
    const turnStats = this.turns.stats();
    return {
      turns: this.counters.turns,
      bargeIns: this.counters.bargeIns,
      ducks: this.counters.ducks,
      disconnects: this.counters.disconnects,
      resumes: this.counters.resumes,
      recoveries: this.recovery.stats().recoveries,
      profileSwitches: this.counters.profileSwitches,
      ttsChunksSpoken: this.counters.ttsChunksSpoken,
      checkpoints: this.counters.checkpoints,
      durabilityScore: this.store.durabilityScore(),
      phase: this.recovery.phaseNow(),
      state: this.turns.currentState(),
      floor: this.turns.currentFloor(),
      profileId: this.profiles.current(),
      queuedReplies: this.bargeIn.queuedReplies().length,
      meanResponseLatencyMs: turnStats.meanResponseLatencyMs,
    };
  }

  summary(): string {
    const s = this.stats();
    return `voice session v22 ${this.sessionId}: phase=${s.phase}, state=${s.state}, floor=${s.floor}, ` +
      `profile=${s.profileId}, turns=${s.turns}, barge-ins=${s.bargeIns}, ducks=${s.ducks}, ` +
      `disconnects=${s.disconnects}, resumes=${s.resumes}, checkpoints=${s.checkpoints}, ` +
      `durability=${(s.durabilityScore * 100).toFixed(0)}%`;
  }

  close(atMs?: number): void {
    const t = atMs ?? this.clockMs;
    this.closed = true;
    this.speaking = false;
    this.journal('closed', t, {});
    this.checkpointNow(t);
    this.sink?.({ kind: 'closed', atMs: t, sessionId: this.sessionId });
  }
}

export function createVoiceSessionV22(
  sessionId: string,
  opts: VoiceV22SessionOptions = {},
  sink?: VoiceV22EventSink,
): VoiceSessionV22 {
  return new VoiceSessionV22(sessionId, opts, sink);
}

/** Default scripted replies for the mock model (greetings + help). */
export const VOICE_V22_SCRIPTED_REPLIES: Record<string, string> = {
  'xin chào': 'Xin chào! Tôi có thể giúp gì cho bạn?',
  hello: 'Hello! How can I help?',
  'cảm ơn': 'Không có gì!',
  'thank you': "You're welcome!",
};

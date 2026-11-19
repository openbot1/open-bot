/**
 * Realtime voice session v27 (v1.40, Team T5).
 *
 * The session wires the v27 pieces into one live loop on top of
 * v26's frame loop:
 *
 *   user speech burst ──> InterruptPolicyV27 ──> stop TTS, keep
 *                         prefix + resume decision, log the event
 *   VAD frames ─────────> TurnManagerV27 ───────> open/end turns
 *                         on silence / keyword / timeout
 *   bot voice ──────────> PersonaRegistryV27 ───> remembered
 *                         persona per bot, mid-session switching
 *   every transition ───> DurableSessionStoreV27 > JSON file per
 *                         session, state confirmed before each op
 *
 * One session is one conversation. The host drives it with
 * virtual-clock calls; every state change is saved durably
 * before the call returns, so a restart resumes the session
 * from the file instead of losing it. The TTS itself is a mock
 * stub — this machine has no TTS engine and no sound card —
 * so `agentReply` arms the interrupt policy and records the
 * reply, but produces no audio.
 */
import {
  InterruptPolicyV27,
  createInterruptPolicyV27,
  type InterruptPolicyV27Options,
} from './interruptV27';
import {
  PersonaRegistryV27,
  createPersonaRegistryV27,
  type PersonaRegistryV27Options,
} from './personasV27';
import {
  DurableSessionStoreV27,
  createDurableSessionStoreV27,
  type DurableSessionStoreV27Options,
  type VoiceV27StateGuard,
} from './sessionStoreV27';
import {
  TurnManagerV27,
  createTurnManagerV27,
  type TurnManagerV27Options,
} from './vadV27';
import {
  formatDurationV27,
  type VoiceV27DurableSession,
  type VoiceV27InterruptEvent,
  type VoiceV27InterruptMode,
  type VoiceV27PersonaDef,
  type VoiceV27SessionState,
  type VoiceV27VadPreset,
} from './types';

export interface VoiceSessionV27Options {
  interrupt?: Partial<InterruptPolicyV27Options>;
  turnManager?: Partial<TurnManagerV27Options>;
  personas?: Partial<PersonaRegistryV27Options>;
  store?: Partial<DurableSessionStoreV27Options>;
  /** Bot this session belongs to (null = unassigned). */
  botId?: string | null;
  /** Persona id to assign at open (null = the bot's remembered persona). */
  personaId?: string | null;
}

export interface VoiceV27SessionEvent {
  atMs: number;
  kind:
    | 'open'
    | 'user-start'
    | 'user-frame'
    | 'user-end'
    | 'agent-start'
    | 'agent-done'
    | 'interrupt-confirmed'
    | 'interrupt-stopped'
    | 'interrupt-ignored'
    | 'pause'
    | 'resume'
    | 'persona-switch'
    | 'checkpoint'
    | 'restore'
    | 'timeout'
    | 'close';
  detail: string;
}

/** Plain-JSON snapshot of a whole v27 session. */
export interface VoiceV27SessionSnapshot {
  sessionId: string;
  botId: string | null;
  persona: VoiceV27PersonaDef | null;
  state: VoiceV27SessionState;
  floor: string;
  turnIndex: number;
  turns: number;
  interrupts: number;
  recovered: boolean;
  vadPreset: VoiceV27VadPreset;
  interruptMode: VoiceV27InterruptMode;
  currentTurn: { id: string; role: string; status: string } | null;
  agentSpeaking: boolean;
  openedAtMs: number;
  updatedAtMs: number;
  closedAtMs: number | null;
  checkpoints: { label: string; atMs: number }[];
  events: number;
}

export function createVoiceSessionV27(
  sessionId: string,
  opts: VoiceSessionV27Options = {},
): VoiceSessionV27 {
  return new VoiceSessionV27(sessionId, opts);
}

export class VoiceSessionV27 {
  readonly sessionId: string;
  readonly interrupt: InterruptPolicyV27;
  readonly turns: TurnManagerV27;
  readonly personas: PersonaRegistryV27;
  readonly store: DurableSessionStoreV27;
  private readonly botId: string | null;
  private readonly defaultPersonaId: string | null;
  private events: VoiceV27SessionEvent[] = [];
  private record: VoiceV27DurableSession | null = null;

  constructor(sessionId: string, opts: VoiceSessionV27Options = {}) {
    if (typeof sessionId !== 'string' || sessionId === '') throw new Error('sessionId must be a non-empty string');
    this.sessionId = sessionId;
    this.botId = opts.botId ?? null;
    this.defaultPersonaId = opts.personaId ?? null;
    this.interrupt = createInterruptPolicyV27(sessionId, opts.interrupt ?? {});
    this.turns = createTurnManagerV27(sessionId, {
      ...(opts.turnManager ?? {}),
      botId: this.botId,
    });
    this.personas = createPersonaRegistryV27(opts.personas ?? {});
    this.store = createDurableSessionStoreV27(opts.store ?? {});
  }

  private log(atMs: number, kind: VoiceV27SessionEvent['kind'], detail: string): void {
    this.events.push({ atMs, kind, detail });
    while (this.events.length > 500) this.events.shift();
  }

  private refreshRecord(): VoiceV27DurableSession | null {
    this.record = this.store.load(this.sessionId);
    return this.record;
  }

  private saveRecord(mutator: (r: VoiceV27DurableSession) => void): VoiceV27DurableSession | null {
    const record = this.store.load(this.sessionId);
    if (record === null) return null;
    mutator(record);
    this.record = this.store.save(record);
    return this.record;
  }

  /** Open the session: create the durable record, go listening. */
  open(atMs: number, input: { botId?: string | null; personaId?: string | null } = {}): VoiceV27SessionSnapshot {
    const botId = input.botId ?? this.botId;
    const personaId = input.personaId ?? this.defaultPersonaId;
    if (personaId !== null) {
      if (botId === null) throw new Error('personaId needs a botId to remember the assignment');
      this.personas.assign(botId, personaId, atMs);
    }
    const record = this.store.newRecord({
      sessionId: this.sessionId,
      botId,
      personaId: botId === null ? null : this.personas.personaFor(botId).id,
      vadPreset: this.turns.vad.presetNow(),
      interruptMode: this.interrupt.policyNow().mode,
      atMs,
    });
    this.record = this.store.save(record);
    this.store.transition(this.sessionId, 'listening', atMs, 'open');
    this.refreshRecord();
    this.log(atMs, 'open', `session opened for bot ${botId ?? '-'}`);
    return this.snapshot();
  }

  /** State confirmation before an operation (reads the saved state). */
  requireState(
    allowed: readonly VoiceV27SessionState[],
    operation: string,
  ): VoiceV27StateGuard {
    return this.store.requireState(this.sessionId, allowed, operation);
  }

  stateNow(): VoiceV27SessionState {
    return this.store.load(this.sessionId)?.state ?? 'idle';
  }

  /** Rehydrate this session object from its durable record. */
  restore(atMs: number): VoiceV27SessionSnapshot | null {
    const record = this.store.load(this.sessionId);
    if (record === null) return null;
    this.record = record;
    if (record.botId !== null && record.personaId !== null) {
      this.personas.assign(record.botId, record.personaId, atMs);
    }
    this.log(atMs, 'restore', `restored state ${record.state}${record.recovered ? ' (recovered)' : ''}`);
    return this.snapshot();
  }

  personaNow(): VoiceV27PersonaDef | null {
    const record = this.store.load(this.sessionId);
    if (record?.botId === null || record?.botId === undefined) return null;
    return this.personas.personaFor(record.botId as string);
  }

  switchPersona(personaId: string, atMs: number): VoiceV27SessionSnapshot {
    const record = this.store.load(this.sessionId);
    if (record === null) throw new Error(`Unknown session: "${this.sessionId}"`);
    if (record.botId === null) throw new Error('Cannot switch persona: session has no bot');
    const speaking = record.state === 'speaking';
    const result = this.personas.switchPersona(record.botId, personaId, { atMs, midSession: speaking });
    this.saveRecord((r) => {
      r.personaId = result.currentPersonaId;
      r.updatedAtMs = atMs;
    });
    this.log(atMs, 'persona-switch', `${result.previousPersonaId ?? '-'} -> ${result.currentPersonaId}${speaking ? ' (mid-session)' : ''}`);
    return this.snapshot();
  }

  userStart(atMs: number, text = ''): VoiceV27SessionSnapshot {
    const guard = this.requireState(['listening', 'paused'], 'user-start');
    if (!guard.ok) throw new Error(guard.reason);
    this.turns.userStart(atMs, text);
    this.log(atMs, 'user-start', text === '' ? 'user started speaking' : `user: ${text}`);
    return this.snapshot();
  }

  /**
   * Feed one VAD frame. While listening it drives turn-taking;
   * while speaking it is a potential interruption (sustained
   * speech stops the reply, short bursts are backchannels).
   */
  userFrame(input: {
    atMs: number;
    energy: number;
    isSpeech?: boolean;
    text?: string | null;
    speechMs?: number | null;
    stopLatencyMs?: number | null;
  }): {
    snapshot: VoiceV27SessionSnapshot;
    frame: ReturnType<TurnManagerV27['vad']['classifyFrame']> | null;
    interrupt: VoiceV27InterruptEvent | null;
  } {
    const state = this.stateNow();
    if (state === 'speaking') {
      const speechMs = input.speechMs ?? (input.isSpeech === true ? 300 : 0);
      const feed = this.interrupt.feedBurst({
        atMs: input.atMs,
        speechMs,
        energy: input.energy,
        text: input.text ?? null,
      });
      if (!feed.confirmed || feed.eventId === null) {
        const event = feed.eventId === null ? null : this.interrupt.get(feed.eventId);
        if (event !== null) this.log(input.atMs, 'interrupt-ignored', `${event.kind} ignored (${event.ignoreReason ?? '?'})`);
        return { snapshot: this.snapshot(), frame: null, interrupt: event };
      }
      const stopped = this.interrupt.stop({
        eventId: feed.eventId,
        atMs: input.atMs,
        stopLatencyMs: input.stopLatencyMs ?? 0,
        userText: input.text ?? null,
      });
      if (stopped !== null) {
        this.turns.agentInterrupted(input.atMs, stopped.eventId);
        this.saveRecord((r) => {
          r.interrupts += 1;
          r.turns = this.turns.stats().turns;
          r.turnIndex = this.turns.stats().turns - 1;
          r.updatedAtMs = input.atMs;
        });
        this.store.transition(this.sessionId, 'listening', input.atMs, `interrupted by ${stopped.eventId}`);
        this.log(input.atMs, 'interrupt-stopped', `stopped after ${stopped.stopLatencyMs}ms, resume ${stopped.resume}`);
      }
      this.refreshRecord();
      const event = this.interrupt.get(feed.eventId);
      if (event !== null) this.log(input.atMs, 'interrupt-confirmed', `confirmed ${event.kind} (${event.speechMs}ms)`);
      return { snapshot: this.snapshot(), frame: null, interrupt: event };
    }
    const guard = this.requireState(['listening'], 'user-frame');
    if (!guard.ok) throw new Error(guard.reason);
    const { frame, turn } = this.turns.userFrame({
      atMs: input.atMs,
      energy: input.energy,
      isSpeech: input.isSpeech,
      text: input.text ?? null,
    });
    if (turn !== null) {
      this.saveRecord((r) => {
        r.turnIndex = turn.index;
        r.turns = this.turns.stats().turns;
        r.updatedAtMs = input.atMs;
      });
    }
    if (frame.turnEnded) this.log(input.atMs, 'user-end', `turn ended (${frame.endReason ?? 'silence'})`);
    return { snapshot: this.snapshot(), frame, interrupt: null };
  }

  userEnd(atMs: number, text?: string | null): VoiceV27SessionSnapshot {
    const guard = this.requireState(['listening'], 'user-end');
    if (!guard.ok) throw new Error(guard.reason);
    const turn = this.turns.userEnd(atMs, text);
    if (turn !== null) {
      this.saveRecord((r) => {
        r.turns = this.turns.stats().turns;
        r.updatedAtMs = atMs;
      });
    }
    this.log(atMs, 'user-end', text ?? 'user turn ended');
    return this.snapshot();
  }

  /** Start the agent reply (arms the interrupt policy, speaks as the persona). */
  agentReply(input: { atMs: number; text: string; critical?: boolean }): VoiceV27SessionSnapshot {
    const guard = this.requireState(['listening', 'thinking'], 'agent-reply');
    if (!guard.ok) throw new Error(guard.reason);
    const persona = this.personaNow();
    this.turns.agentStart(input.atMs, input.text);
    this.interrupt.armReply({
      turnId: this.turns.currentTurn()?.id ?? '',
      replyText: input.text,
      critical: input.critical ?? false,
      atMs: input.atMs,
    });
    this.store.transition(this.sessionId, 'speaking', input.atMs, 'agent reply started');
    this.saveRecord((r) => {
      r.turns = this.turns.stats().turns;
      r.turnIndex = this.turns.stats().turns - 1;
      r.updatedAtMs = input.atMs;
    });
    this.refreshRecord();
    this.log(input.atMs, 'agent-start', `reply as ${persona?.id ?? 'default'} (${input.text.length} chars)`);
    return this.snapshot();
  }

  agentSpeechProgress(atMs: number, spokenChars: number): void {
    this.interrupt.noteProgress(atMs, spokenChars);
  }

  agentDone(atMs: number, spokenChars?: number | null): VoiceV27SessionSnapshot {
    const guard = this.requireState(['speaking'], 'agent-done');
    if (!guard.ok) throw new Error(guard.reason);
    this.turns.agentDone(atMs, spokenChars);
    this.store.transition(this.sessionId, 'listening', atMs, 'agent reply done');
    this.saveRecord((r) => {
      r.turns = this.turns.stats().turns;
      r.turnIndex = this.turns.stats().turns - 1;
      r.updatedAtMs = atMs;
    });
    this.refreshRecord();
    this.log(atMs, 'agent-done', `reply done (${spokenChars ?? '?'} chars spoken)`);
    return this.snapshot();
  }

  pause(atMs: number): VoiceV27SessionSnapshot {
    const moved = this.store.transition(this.sessionId, 'paused', atMs, 'paused by host');
    if (moved === null) throw new Error(this.store.requireState(this.sessionId, ['listening', 'thinking', 'speaking'], 'pause').reason);
    this.refreshRecord();
    this.log(atMs, 'pause', 'session paused');
    return this.snapshot();
  }

  resume(atMs: number): VoiceV27SessionSnapshot {
    const moved = this.store.transition(this.sessionId, 'listening', atMs, 'resumed');
    if (moved === null) throw new Error(this.store.requireState(this.sessionId, ['paused'], 'resume').reason);
    this.refreshRecord();
    this.log(atMs, 'resume', 'session resumed');
    return this.snapshot();
  }

  timeoutCheck(atMs: number): VoiceV27SessionSnapshot {
    const timedOut = this.turns.timeoutCheck(atMs);
    if (timedOut !== null) {
      this.log(atMs, 'timeout', `turn ${timedOut.id} timed out`);
      this.store.transition(this.sessionId, 'listening', atMs, 'turn timeout');
      this.saveRecord((r) => {
        r.turns = this.turns.stats().turns;
        r.updatedAtMs = atMs;
      });
      this.refreshRecord();
    }
    return this.snapshot();
  }

  checkpoint(label: string, atMs: number): VoiceV27SessionSnapshot {
    this.store.checkpoint(this.sessionId, label, atMs);
    this.refreshRecord();
    this.log(atMs, 'checkpoint', label);
    return this.snapshot();
  }

  close(atMs: number): VoiceV27SessionSnapshot {
    const moved = this.store.transition(this.sessionId, 'ended', atMs, 'closed by host');
    if (moved === null) throw new Error(this.store.requireState(this.sessionId, ['idle', 'listening', 'thinking', 'speaking', 'paused'], 'close').reason);
    this.refreshRecord();
    this.log(atMs, 'close', 'session closed');
    return this.snapshot();
  }

  statusSnapshot(): VoiceV27SessionSnapshot {
    return this.snapshot();
  }

  snapshot(): VoiceV27SessionSnapshot {
    const record = this.store.load(this.sessionId) ?? this.record;
    const current = this.turns.currentTurn();
    return {
      sessionId: this.sessionId,
      botId: record?.botId ?? this.botId,
      persona: this.personaNow(),
      state: record?.state ?? 'idle',
      floor: record?.floor ?? 'none',
      turnIndex: record?.turnIndex ?? 0,
      turns: record?.turns ?? 0,
      interrupts: record?.interrupts ?? 0,
      recovered: record?.recovered ?? false,
      vadPreset: record?.vadPreset ?? this.turns.vad.presetNow(),
      interruptMode: record?.interruptMode ?? this.interrupt.policyNow().mode,
      currentTurn: current === null ? null : { id: current.id, role: current.role, status: current.status },
      agentSpeaking: this.interrupt.isAgentSpeaking(),
      openedAtMs: record?.openedAtMs ?? 0,
      updatedAtMs: record?.updatedAtMs ?? 0,
      closedAtMs: record?.closedAtMs ?? null,
      checkpoints: record?.checkpoints.map((c) => ({ ...c })) ?? [],
      events: this.events.length,
    };
  }

  eventsList(): VoiceV27SessionEvent[] {
    return this.events.map((e) => ({ ...e }));
  }

  summary(): string {
    const s = this.snapshot();
    const t = this.turns.stats();
    const i = this.interrupt.stats();
    return [
      `Voice session v27 ${this.sessionId} (${s.botId ?? 'no bot'}): ${s.state}`,
      `Persona: ${s.persona?.id ?? '-'} · VAD preset ${s.vadPreset} · interrupt mode ${s.interruptMode}`,
      `Turns: ${t.turns} (${t.completed} completed, ${t.interrupted} interrupted, ${t.timeouts} timeouts) · mean ${formatDurationV27(t.meanTurnMs)}`,
      `Interrupts: ${i.confirmed} confirmed / ${i.events} events · mean stop ${formatDurationV27(i.meanStopLatencyMs)} · storms ${i.storms}`,
      `Durable: ${s.recovered ? 'recovered after restart' : 'clean'} · checkpoints ${s.checkpoints.length} · events ${s.events}`,
    ].join('\n');
  }

  markdown(): string {
    const s = this.snapshot();
    const lines = [
      '# Voice session v27',
      '',
      `- Session: ${this.sessionId} · bot ${s.botId ?? '-'} · state ${s.state} · floor ${s.floor}`,
      `- Persona: ${s.persona?.id ?? '-'} (${s.persona?.voice ?? '-'}, rate ${s.persona?.rate ?? '-'}, pitch ${s.persona?.pitch ?? '-'})`,
      `- Turns: ${s.turns} · interrupts: ${s.interrupts} · recovered: ${s.recovered}`,
      `- VAD preset ${s.vadPreset} · interrupt mode ${s.interruptMode}`,
      '',
      '## Turns',
      '',
      this.turns.markdown(),
      '',
      '## Interrupts',
      '',
      this.interrupt.markdown(),
      '',
      '## Events',
      '',
    ];
    for (const e of this.events.slice(-20)) {
      lines.push(`- ${e.atMs}ms ${e.kind}: ${e.detail}`);
    }
    return lines.join('\n');
  }
}

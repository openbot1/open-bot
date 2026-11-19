/**
 * Per-voice-turn timers for voice v25 (v1.38, Team T5).
 *
 * The v24 per-tool-call timers extended to whole voice turns.
 * v24 answers "how long did the search call inside turn 3
 * take"; v25 answers "how long did turn 3 itself take, and
 * where did the time go":
 *
 *   - every turn gets start / end / duration, with phase
 *     spans (listening / silence-wait / thinking / speaking /
 *     interrupted) so the UI shows the time *inside* the turn,
 *     not just the total;
 *   - per-session aggregates (turn count, mean / p95 turn
 *     time, mean think / speak / listen / silence-wait,
 *     interrupted and timed-out turns) for the session row;
 *   - threshold alerts: a turn past `slowTurnMs` raises a
 *     `slow-turn` alert, a turn whose silence runs past
 *     `longSilenceMs` raises a `long-silence` alert — the UI
 *     can flag the turn live via `checkRunning`, without
 *     waiting for it to finish;
 *   - an attached v24 tool-call timer registry contributes
 *     the tool time inside each turn (v24 records carry the
 *     turn index), so the panel can show "turn 3: 4.2s total,
 *     1.9s of it in tool calls".
 *
 * A turn id is supplied by the caller (usually the id the
 * turn-taking manager assigned) so the timer, the floor
 * machine and the panel all talk about the same turn; when
 * no id is given the registry mints one. All clocks virtual.
 */
import type { ToolCallTimerRegistryV24 } from '../voiceV24/toolCallTimersV24';
import {
  clampV25,
  durationBucketV25,
  formatDurationV25,
  isValidVoiceV25Id,
  meanV25,
  percentileV25,
  round2V25,
  VOICE_V25_LONG_SILENCE_DEFAULT_MS,
  VOICE_V25_MAX_TURN_DEFAULT_MS,
  VOICE_V25_SLOW_TURN_DEFAULT_MS,
  type VoiceV25DurationBucket,
  type VoiceV25TurnAlert,
  type VoiceV25TurnAlertKind,
  type VoiceV25TurnPhase,
  type VoiceV25TurnRecord,
  type VoiceV25TurnRole,
  type VoiceV25TurnStatus,
} from './types';

export interface TurnTimerV25Options {
  /** A finished turn past this is `slow` (default 15000 ms). */
  slowTurnMs: number;
  /** A turn past this is a `timeout` (default 120000 ms). */
  timeoutTurnMs: number;
  /** Silence inside one turn past this raises long-silence (default 5000). */
  longSilenceMs: number;
  /** Max turn records kept (oldest finished dropped, default 1000). */
  maxTurns: number;
}

export function defaultTurnTimerV25Options(): TurnTimerV25Options {
  return {
    slowTurnMs: VOICE_V25_SLOW_TURN_DEFAULT_MS,
    timeoutTurnMs: VOICE_V25_MAX_TURN_DEFAULT_MS,
    longSilenceMs: VOICE_V25_LONG_SILENCE_DEFAULT_MS,
    maxTurns: 1000,
  };
}

export function validateTurnTimerV25Options(o: Partial<TurnTimerV25Options>): string[] {
  const errors: string[] = [];
  if (o.slowTurnMs !== undefined && !(o.slowTurnMs > 0 && o.slowTurnMs <= 600000)) {
    errors.push('slowTurnMs must be > 0 and <= 600000');
  }
  if (o.timeoutTurnMs !== undefined && !(o.timeoutTurnMs > 0 && o.timeoutTurnMs <= 3600000)) {
    errors.push('timeoutTurnMs must be > 0 and <= 3600000');
  }
  if (o.slowTurnMs !== undefined && o.timeoutTurnMs !== undefined && o.timeoutTurnMs <= o.slowTurnMs) {
    errors.push('timeoutTurnMs must be greater than slowTurnMs');
  }
  if (o.longSilenceMs !== undefined && !(o.longSilenceMs > 0 && o.longSilenceMs <= 600000)) {
    errors.push('longSilenceMs must be > 0 and <= 600000');
  }
  if (o.maxTurns !== undefined && (!Number.isInteger(o.maxTurns) || o.maxTurns < 10 || o.maxTurns > 100000)) {
    errors.push('maxTurns must be an integer 10..100000');
  }
  return errors;
}

/** Aggregate over the turns of one session. */
export interface VoiceV25SessionTurnStats {
  sessionId: string;
  turns: number;
  running: number;
  completed: number;
  interrupted: number;
  abandoned: number;
  timeouts: number;
  totalMs: number;
  meanMs: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
  slowest: VoiceV25TurnRecord | null;
  slowTurns: number;
  longSilenceTurns: number;
  meanThinkMs: number;
  meanSpeakMs: number;
  meanListenMs: number;
  meanSilenceWaitMs: number;
  meanSilenceMs: number;
  /** Tool-call time inside these turns (0 when no v24 registry attached). */
  toolTimeMs: number;
  alerts: number;
  /** Per-role breakdown, slowest role first. */
  byRole: VoiceV25RoleTurnStats[];
}

/** Aggregate over the turns of one role (user / assistant). */
export interface VoiceV25RoleTurnStats {
  role: VoiceV25TurnRole;
  turns: number;
  completed: number;
  interrupted: number;
  meanMs: number;
  p95Ms: number;
  maxMs: number;
  totalMs: number;
}

/** One live running turn, as the UI row renders it. */
export interface VoiceV25RunningTurn {
  record: VoiceV25TurnRecord;
  elapsedMs: number;
  /** Phase the turn is in right now. */
  phase: VoiceV25TurnPhase;
  /** ms in the current phase. */
  phaseElapsedMs: number;
  bucket: VoiceV25DurationBucket;
  overSlowThreshold: boolean;
  overTimeout: boolean;
  /** Tool-call time inside this turn so far (0 when unattached). */
  toolTimeMs: number;
}

export function createTurnTimerRegistryV25(
  opts: Partial<TurnTimerV25Options> = {},
): TurnTimerRegistryV25 {
  return new TurnTimerRegistryV25(opts);
}

export class TurnTimerRegistryV25 {
  private readonly opts: TurnTimerV25Options;
  private readonly turns = new Map<string, VoiceV25TurnRecord>();
  private readonly order: string[] = [];
  private readonly alerts: VoiceV25TurnAlert[] = [];
  private readonly alertedSlow = new Set<string>();
  private readonly alertedTimeout = new Set<string>();
  private readonly alertedLongSilence = new Set<string>();
  private toolTimers: ToolCallTimerRegistryV24 | null = null;
  private seq = 0;
  private alertSeq = 0;

  constructor(opts: Partial<TurnTimerV25Options> = {}) {
    const errors = validateTurnTimerV25Options(opts);
    if (errors.length > 0) {
      throw new Error(`Invalid TurnTimerRegistryV25 options: ${errors.join('; ')}`);
    }
    const merged = { ...defaultTurnTimerV25Options(), ...opts };
    if (merged.timeoutTurnMs <= merged.slowTurnMs) {
      throw new Error('Invalid TurnTimerRegistryV25 options: timeoutTurnMs must be greater than slowTurnMs');
    }
    this.opts = merged;
  }

  options(): TurnTimerV25Options {
    return { ...this.opts };
  }

  /** Attach a v24 tool-call timer registry for per-turn tool time. */
  attachToolTimers(registry: ToolCallTimerRegistryV24 | null): void {
    this.toolTimers = registry;
  }

  attachedToolTimers(): ToolCallTimerRegistryV24 | null {
    return this.toolTimers;
  }

  /** Start a turn timer. Returns the turn id (the caller's, when given). */
  startTurn(
    sessionId: string,
    role: VoiceV25TurnRole,
    atMs: number,
    extra: {
      turnId?: string;
      index?: number;
      providerId?: string | null;
      model?: string | null;
      text?: string;
    } = {},
  ): string {
    if (!isValidVoiceV25Id(sessionId)) throw new Error(`Invalid sessionId "${sessionId}"`);
    if (role !== 'user' && role !== 'assistant') throw new Error('role must be "user" | "assistant"');
    if (!Number.isFinite(atMs) || atMs < 0) throw new Error('atMs must be a finite number >= 0');
    const id = extra.turnId ?? `tt-${++this.seq}`;
    if (!isValidVoiceV25Id(id)) throw new Error(`Invalid turnId "${id}"`);
    if (this.turns.has(id)) throw new Error(`Turn "${id}" already exists`);
    const firstPhase: VoiceV25TurnPhase = role === 'user' ? 'listening' : 'thinking';
    const turn: VoiceV25TurnRecord = {
      id,
      sessionId,
      index: extra.index ?? this.order.length,
      role,
      startedAtMs: atMs,
      endedAtMs: null,
      durationMs: null,
      status: 'active',
      phases: [{ phase: firstPhase, startedAtMs: atMs, endedAtMs: null, durationMs: null }],
      silenceMs: 0,
      speechMs: 0,
      longestSilenceMs: 0,
      text: extra.text ?? '',
      spokenChars: null,
      plannedChars: null,
      bargeInId: null,
      interruptedAtMs: null,
      providerId: extra.providerId ?? null,
      model: extra.model ?? null,
    };
    this.turns.set(id, turn);
    this.order.push(id);
    this.prune();
    return id;
  }

  /** Move a turn into a new phase (closes the previous phase span). */
  enterPhase(turnId: string, phase: VoiceV25TurnPhase, atMs: number): VoiceV25TurnRecord {
    const turn = this.requireActive(turnId);
    if (!Number.isFinite(atMs) || atMs < turn.startedAtMs) {
      throw new Error(`atMs ${atMs} is before turn start ${turn.startedAtMs}`);
    }
    const open = turn.phases[turn.phases.length - 1];
    if (open !== undefined && open.endedAtMs === null) {
      open.endedAtMs = atMs;
      open.durationMs = atMs - open.startedAtMs;
    }
    turn.phases.push({ phase, startedAtMs: atMs, endedAtMs: null, durationMs: null });
    return this.cloneTurn(turn);
  }

  /** Add measured silence/speech ms to a turn. */
  addAudio(turnId: string, silenceMs: number, speechMs: number, longestSilenceMs?: number): VoiceV25TurnRecord {
    const turn = this.turns.get(turnId);
    if (turn === undefined) throw new Error(`No turn "${turnId}"`);
    if (silenceMs < 0 || speechMs < 0) throw new Error('silenceMs/speechMs must be >= 0');
    turn.silenceMs += silenceMs;
    turn.speechMs += speechMs;
    if (longestSilenceMs !== undefined) {
      if (longestSilenceMs < 0) throw new Error('longestSilenceMs must be >= 0');
      if (longestSilenceMs > turn.longestSilenceMs) turn.longestSilenceMs = longestSilenceMs;
    }
    return this.cloneTurn(turn);
  }

  /** Finish a turn successfully. */
  endTurn(turnId: string, atMs: number): VoiceV25TurnRecord {
    return this.finish(turnId, atMs, 'completed');
  }

  /** Finish a turn as interrupted by a barge-in (spoken prefix kept). */
  interruptTurn(
    turnId: string,
    atMs: number,
    bargeInId: string,
    spokenText: string,
    spokenChars: number,
  ): VoiceV25TurnRecord {
    const turn = this.requireActive(turnId);
    if (!isValidVoiceV25Id(bargeInId)) throw new Error(`Invalid bargeInId "${bargeInId}"`);
    if (typeof spokenText !== 'string') throw new Error('spokenText must be a string');
    if (!Number.isInteger(spokenChars) || spokenChars < 0) {
      throw new Error('spokenChars must be an integer >= 0');
    }
    this.enterPhase(turnId, 'interrupted', atMs);
    turn.bargeInId = bargeInId;
    turn.interruptedAtMs = atMs;
    turn.text = spokenText;
    turn.spokenChars = spokenChars;
    return this.finish(turnId, atMs, 'interrupted');
  }

  /** Finish a turn as abandoned (user hung up, session error). */
  abandonTurn(turnId: string, atMs: number): VoiceV25TurnRecord {
    return this.finish(turnId, atMs, 'abandoned');
  }

  /** Finish a turn as timed out (past the max turn duration). */
  timeoutTurn(turnId: string, atMs: number): VoiceV25TurnRecord {
    return this.finish(turnId, atMs, 'timeout');
  }

  private finish(turnId: string, atMs: number, status: VoiceV25TurnStatus): VoiceV25TurnRecord {
    const turn = this.requireActive(turnId);
    if (atMs < turn.startedAtMs) {
      throw new Error(`end atMs ${atMs} is before start ${turn.startedAtMs}`);
    }
    const open = turn.phases[turn.phases.length - 1];
    if (open !== undefined && open.endedAtMs === null) {
      open.endedAtMs = atMs;
      open.durationMs = atMs - open.startedAtMs;
    }
    turn.endedAtMs = atMs;
    turn.durationMs = atMs - turn.startedAtMs;
    turn.status = status;
    if (status === 'completed' || status === 'interrupted' || status === 'timeout') {
      this.maybeThresholdAlerts(turn);
    }
    if (turn.silenceMs >= this.opts.longSilenceMs && !this.alertedLongSilence.has(turn.id)) {
      this.alertedLongSilence.add(turn.id);
      this.raiseAlert(turn, 'long-silence', this.opts.longSilenceMs, turn.silenceMs);
    }
    return this.cloneTurn(turn);
  }

  private maybeThresholdAlerts(turn: VoiceV25TurnRecord): void {
    const durationMs = turn.durationMs ?? 0;
    if (durationMs >= this.opts.timeoutTurnMs && !this.alertedTimeout.has(turn.id)) {
      this.alertedTimeout.add(turn.id);
      this.raiseAlert(turn, 'slow-turn', this.opts.timeoutTurnMs, durationMs, 'timed out');
      return;
    }
    if (durationMs >= this.opts.slowTurnMs && !this.alertedSlow.has(turn.id)) {
      this.alertedSlow.add(turn.id);
      this.raiseAlert(turn, 'slow-turn', this.opts.slowTurnMs, durationMs, 'ran slow');
    }
  }

  private raiseAlert(
    turn: VoiceV25TurnRecord,
    kind: VoiceV25TurnAlertKind,
    thresholdMs: number,
    durationMs: number,
    verb?: string,
  ): void {
    this.alertSeq += 1;
    const label =
      kind === 'slow-turn'
        ? `${turn.role} turn ${verb ?? 'ran slow'}`
        : kind === 'long-silence'
          ? `${turn.role} turn had a long silence`
          : `${turn.role} turn alert`;
    this.alerts.push({
      id: `alert-${this.alertSeq}`,
      sessionId: turn.sessionId,
      turnId: turn.id,
      kind,
      thresholdMs,
      durationMs,
      atMs: turn.endedAtMs ?? turn.startedAtMs,
      message:
        `${label} after ${formatDurationV25(durationMs)} ` +
        `(threshold ${formatDurationV25(thresholdMs)}) in session ${turn.sessionId}`,
    });
  }

  /**
   * Check running turns against the thresholds at `atMs` and
   * raise alerts for any that crossed a line while still
   * running — the UI does not have to wait for the turn to
   * finish to flag it. Returns the newly raised alerts.
   */
  checkRunning(atMs: number): VoiceV25TurnAlert[] {
    const raised: VoiceV25TurnAlert[] = [];
    for (const turn of this.turns.values()) {
      if (turn.status !== 'active') continue;
      const elapsed = atMs - turn.startedAtMs;
      if (elapsed < 0) continue;
      if (elapsed >= this.opts.timeoutTurnMs && !this.alertedTimeout.has(turn.id)) {
        this.alertedTimeout.add(turn.id);
        raised.push(this.liveAlert(turn, 'slow-turn', this.opts.timeoutTurnMs, elapsed, atMs, 'timed out'));
      } else if (elapsed >= this.opts.slowTurnMs && !this.alertedSlow.has(turn.id)) {
        this.alertedSlow.add(turn.id);
        raised.push(this.liveAlert(turn, 'slow-turn', this.opts.slowTurnMs, elapsed, atMs, 'ran slow'));
      }
      if (turn.silenceMs >= this.opts.longSilenceMs && !this.alertedLongSilence.has(turn.id)) {
        this.alertedLongSilence.add(turn.id);
        raised.push(this.liveAlert(turn, 'long-silence', this.opts.longSilenceMs, turn.silenceMs, atMs));
      }
    }
    return raised;
  }

  private liveAlert(
    turn: VoiceV25TurnRecord,
    kind: VoiceV25TurnAlertKind,
    thresholdMs: number,
    durationMs: number,
    atMs: number,
    verb?: string,
  ): VoiceV25TurnAlert {
    this.alertSeq += 1;
    const label =
      kind === 'slow-turn'
        ? `${turn.role} turn still running after ${formatDurationV25(durationMs)}`
        : `${turn.role} turn silence reached ${formatDurationV25(durationMs)}`;
    const alert: VoiceV25TurnAlert = {
      id: `alert-${this.alertSeq}`,
      sessionId: turn.sessionId,
      turnId: turn.id,
      kind,
      thresholdMs,
      durationMs,
      atMs,
      message:
        `${label} (threshold ${formatDurationV25(thresholdMs)}) in session ${turn.sessionId}` +
        (verb !== undefined ? ` — ${verb}` : ''),
    };
    this.alerts.push(alert);
    return alert;
  }

  get(turnId: string): VoiceV25TurnRecord | null {
    const turn = this.turns.get(turnId);
    return turn === undefined ? null : this.cloneTurn(turn);
  }

  list(filter: { sessionId?: string; role?: VoiceV25TurnRole; status?: VoiceV25TurnStatus } = {}): VoiceV25TurnRecord[] {
    const out: VoiceV25TurnRecord[] = [];
    for (const id of this.order) {
      const turn = this.turns.get(id);
      if (turn === undefined) continue;
      if (filter.sessionId !== undefined && turn.sessionId !== filter.sessionId) continue;
      if (filter.role !== undefined && turn.role !== filter.role) continue;
      if (filter.status !== undefined && turn.status !== filter.status) continue;
      out.push(this.cloneTurn(turn));
    }
    return out;
  }

  /** Live running turns, with elapsed time, phase and threshold state. */
  running(sessionId?: string, atMs = 0): VoiceV25RunningTurn[] {
    const out: VoiceV25RunningTurn[] = [];
    for (const turn of this.list({ status: 'active' })) {
      if (sessionId !== undefined && turn.sessionId !== sessionId) continue;
      const elapsedMs = Math.max(0, atMs - turn.startedAtMs);
      const open = turn.phases[turn.phases.length - 1];
      const phase = open === undefined ? 'done' : open.phase;
      const phaseElapsedMs = open === undefined ? 0 : Math.max(0, atMs - open.startedAtMs);
      out.push({
        record: turn,
        elapsedMs,
        phase,
        phaseElapsedMs,
        bucket: durationBucketV25(elapsedMs, this.opts.slowTurnMs, this.opts.timeoutTurnMs),
        overSlowThreshold: elapsedMs >= this.opts.slowTurnMs,
        overTimeout: elapsedMs >= this.opts.timeoutTurnMs,
        toolTimeMs: this.toolTimeForTurn(turn),
      });
    }
    return out;
  }

  /** Tool-call time inside one turn (0 when no v24 registry attached). */
  toolTimeForTurn(turn: VoiceV25TurnRecord): number {
    if (this.toolTimers === null) return 0;
    return this.toolTimers
      .list({ sessionId: turn.sessionId })
      .filter((c) => c.turnIndex === turn.index && c.durationMs !== null)
      .reduce((a, c) => a + (c.durationMs ?? 0), 0);
  }

  /** Phase total across one turn's spans (helper for stats + panel). */
  phaseMs(turn: VoiceV25TurnRecord, phase: VoiceV25TurnPhase): number {
    let total = 0;
    for (const span of turn.phases) {
      if (span.phase === phase && span.durationMs !== null) total += span.durationMs;
    }
    return total;
  }

  roleStats(role: VoiceV25TurnRole, sessionId?: string): VoiceV25RoleTurnStats {
    const turns = this.list({ role, sessionId }).filter((t) => t.durationMs !== null);
    const durations = turns.map((t) => t.durationMs as number);
    return {
      role,
      turns: this.list({ role, sessionId }).length,
      completed: this.list({ role, sessionId, status: 'completed' }).length,
      interrupted: this.list({ role, sessionId, status: 'interrupted' }).length,
      meanMs: round2V25(meanV25(durations)),
      p95Ms: round2V25(percentileV25(durations, 95)),
      maxMs: durations.length === 0 ? 0 : Math.max(...durations),
      totalMs: durations.reduce((a, b) => a + b, 0),
    };
  }

  /** Per-session aggregate, with the per-role breakdown inside. */
  sessionStats(sessionId: string): VoiceV25SessionTurnStats {
    const turns = this.list({ sessionId });
    const finished = turns.filter((t) => t.durationMs !== null);
    const durations = finished.map((t) => t.durationMs as number);
    let slowest: VoiceV25TurnRecord | null = null;
    for (const turn of finished) {
      if (slowest === null || (turn.durationMs ?? 0) > (slowest.durationMs ?? 0)) slowest = turn;
    }
    const meanPhase = (phase: VoiceV25TurnPhase): number => {
      if (finished.length === 0) return 0;
      const total = finished.reduce((a, t) => a + this.phaseMs(t, phase), 0);
      return round2V25(total / finished.length);
    };
    const toolTimeMs = this.toolTimers === null
      ? 0
      : this.toolTimers.list({ sessionId }).reduce((a, c) => a + (c.durationMs ?? 0), 0);
    return {
      sessionId,
      turns: turns.length,
      running: turns.filter((t) => t.status === 'active').length,
      completed: turns.filter((t) => t.status === 'completed').length,
      interrupted: turns.filter((t) => t.status === 'interrupted').length,
      abandoned: turns.filter((t) => t.status === 'abandoned').length,
      timeouts: turns.filter((t) => t.status === 'timeout').length,
      totalMs: durations.reduce((a, b) => a + b, 0),
      meanMs: round2V25(meanV25(durations)),
      p50Ms: round2V25(percentileV25(durations, 50)),
      p95Ms: round2V25(percentileV25(durations, 95)),
      maxMs: durations.length === 0 ? 0 : Math.max(...durations),
      slowest: slowest === null ? null : this.cloneTurn(slowest),
      slowTurns: finished.filter((t) => (t.durationMs ?? 0) >= this.opts.slowTurnMs).length,
      longSilenceTurns: finished.filter((t) => t.silenceMs >= this.opts.longSilenceMs).length,
      meanThinkMs: meanPhase('thinking'),
      meanSpeakMs: meanPhase('speaking'),
      meanListenMs: meanPhase('listening'),
      meanSilenceWaitMs: meanPhase('silence-wait'),
      meanSilenceMs: finished.length === 0
        ? 0
        : round2V25(finished.reduce((a, t) => a + t.silenceMs, 0) / finished.length),
      toolTimeMs,
      alerts: this.alerts.filter((a) => a.sessionId === sessionId).length,
      byRole: [this.roleStats('user', sessionId), this.roleStats('assistant', sessionId)]
        .sort((a, b) => b.p95Ms - a.p95Ms),
    };
  }

  alertsList(sessionId?: string): VoiceV25TurnAlert[] {
    return this.alerts
      .filter((a) => sessionId === undefined || a.sessionId === sessionId)
      .map((a) => ({ ...a }));
  }

  clearAlerts(sessionId?: string): number {
    if (sessionId === undefined) {
      const n = this.alerts.length;
      this.alerts.length = 0;
      return n;
    }
    const before = this.alerts.length;
    for (let i = this.alerts.length - 1; i >= 0; i -= 1) {
      if (this.alerts[i].sessionId === sessionId) this.alerts.splice(i, 1);
    }
    return before - this.alerts.length;
  }

  /** Close every running turn of a session (session closed mid-turn). */
  closeSession(sessionId: string, atMs: number): number {
    let n = 0;
    for (const turn of this.list({ sessionId, status: 'active' })) {
      this.abandonTurn(turn.id, atMs);
      n += 1;
    }
    return n;
  }

  count(): number {
    return this.turns.size;
  }

  reset(): void {
    this.turns.clear();
    this.order.length = 0;
    this.alerts.length = 0;
    this.alertedSlow.clear();
    this.alertedTimeout.clear();
    this.alertedLongSilence.clear();
    this.seq = 0;
    this.alertSeq = 0;
  }

  private requireActive(turnId: string): VoiceV25TurnRecord {
    const turn = this.turns.get(turnId);
    if (turn === undefined) throw new Error(`No turn "${turnId}"`);
    if (turn.status !== 'active') {
      throw new Error(`Turn "${turnId}" already finished (${turn.status})`);
    }
    return turn;
  }

  private cloneTurn(turn: VoiceV25TurnRecord): VoiceV25TurnRecord {
    return { ...turn, phases: turn.phases.map((p) => ({ ...p })) };
  }

  private prune(): void {
    while (this.order.length > this.opts.maxTurns) {
      const oldestId = this.order[0];
      const oldest = this.turns.get(oldestId);
      if (oldest !== undefined && oldest.status === 'active') {
        const finishedIdx = this.order.findIndex(
          (id) => this.turns.get(id)?.status !== 'active',
        );
        if (finishedIdx === -1) return;
        const dropId = this.order[finishedIdx];
        this.order.splice(finishedIdx, 1);
        this.turns.delete(dropId);
      } else {
        this.order.shift();
        this.turns.delete(oldestId);
      }
    }
  }

  summary(sessionId?: string): string {
    if (sessionId === undefined) {
      const total = this.turns.size;
      return `${total} turns across sessions, ${this.alerts.length} alerts.`;
    }
    const stats = this.sessionStats(sessionId);
    const slowest = stats.slowest === null
      ? 'none'
      : `${stats.slowest.role} turn ${stats.slowest.index} ${formatDurationV25(stats.slowest.durationMs ?? 0)}`;
    return (
      `Session ${sessionId}: ${stats.turns} turns, ${formatDurationV25(stats.totalMs)} total, ` +
      `mean ${formatDurationV25(stats.meanMs)}, p95 ${formatDurationV25(stats.p95Ms)}, ` +
      `slowest ${slowest}, ${stats.interrupted} interrupted, ${stats.slowTurns} slow, ` +
      `${stats.longSilenceTurns} long-silence, tool time ${formatDurationV25(stats.toolTimeMs)}, ${stats.alerts} alerts.`
    );
  }

  markdown(sessionId: string): string {
    const stats = this.sessionStats(sessionId);
    const lines: string[] = [`# Voice v25 turn timers — session ${sessionId}`, ''];
    lines.push(
      `Turns: ${stats.turns} (running ${stats.running}, completed ${stats.completed}, interrupted ${stats.interrupted}, timeouts ${stats.timeouts})`,
    );
    lines.push(
      `Total: ${formatDurationV25(stats.totalMs)}; mean ${formatDurationV25(stats.meanMs)}; p95 ${formatDurationV25(stats.p95Ms)}; ` +
      `mean think ${formatDurationV25(stats.meanThinkMs)}, speak ${formatDurationV25(stats.meanSpeakMs)}, ` +
      `listen ${formatDurationV25(stats.meanListenMs)}, silence-wait ${formatDurationV25(stats.meanSilenceWaitMs)}; ` +
      `tool time ${formatDurationV25(stats.toolTimeMs)}.`,
    );
    lines.push('');
    lines.push('| Turn | Role | Status | Duration | Listen | Silence-wait | Think | Speak | Silence | Tool time |');
    lines.push('| ---: | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
    for (const t of this.list({ sessionId })) {
      lines.push(
        `| ${t.index} | ${t.role} | ${t.status} | ${t.durationMs === null ? 'active' : formatDurationV25(t.durationMs)} | ` +
        `${formatDurationV25(this.phaseMs(t, 'listening'))} | ${formatDurationV25(this.phaseMs(t, 'silence-wait'))} | ` +
        `${formatDurationV25(this.phaseMs(t, 'thinking'))} | ${formatDurationV25(this.phaseMs(t, 'speaking'))} | ` +
        `${formatDurationV25(t.silenceMs)} | ${formatDurationV25(this.toolTimeForTurn(t))} |`,
      );
    }
    const alerts = this.alertsList(sessionId);
    if (alerts.length > 0) {
      lines.push('', '## Alerts');
      for (const a of alerts) lines.push(`- [${a.kind}] ${a.message}`);
    }
    return lines.join('\n');
  }
}

/** Clamp helper re-exported for callers that only import this module. */
export { clampV25 };

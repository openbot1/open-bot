/**
 * Session manager v20 (voice v20, v1.28 Team T5).
 *
 * One pipeline is one call; the manager owns many. It creates
 * sessions, enforces per-session budgets (max turns, max age, max
 * concurrent sessions), checkpoints them on a virtual-clock
 * schedule, hands a session from one pipeline to another (handoff:
 * the new pipeline restores the old snapshot, the old one ends),
 * and compacts long sessions — dropping old turns into a summary
 * so memory stays bounded while the conversation stays coherent.
 *
 * Checkpoints are plain JSON snapshots held in memory (the app may
 * persist them); recovery replays a checkpoint into a fresh
 * pipeline. Handoff and compaction are explicit, logged events —
 * nothing silent. Virtual clock, mock audio only.
 */
import {
  createVoicePipelineV20,
  VoicePipelineV20,
  type PipelineV20Hooks,
  type PipelineV20Options,
  type PipelineV20Snapshot,
} from './pipelineV20';
import type { VoiceV20Event, VoiceV20EventSink } from './types';

export type SessionV20State = 'active' | 'idle' | 'handed-off' | 'compacted' | 'ended' | 'expired';

export interface SessionV20Options {
  /** Max concurrent active sessions. Creating beyond this expires the oldest idle one. */
  maxSessions: number;
  /** Max turns kept per session before compaction is forced. */
  maxTurnsPerSession: number;
  /** Checkpoint every this many virtual ms of session age. */
  checkpointIntervalMs: number;
  /** Idle sessions older than this (virtual ms) expire. */
  idleExpireMs: number;
  /** Max age of a session (virtual ms) before it is expired. */
  maxSessionAgeMs: number;
  /** Turns kept verbatim after compaction; older turns are summarised. */
  keepTurnsAfterCompaction: number;
}

export function defaultSessionV20Options(): SessionV20Options {
  return {
    maxSessions: 8,
    maxTurnsPerSession: 100,
    checkpointIntervalMs: 30000,
    idleExpireMs: 600000,
    maxSessionAgeMs: 3600000,
    keepTurnsAfterCompaction: 20,
  };
}

export function validateSessionV20Options(o: Partial<SessionV20Options>): string[] {
  const e: string[] = [];
  if (o.maxSessions !== undefined && o.maxSessions < 1) e.push('maxSessions must be >= 1');
  if (o.maxTurnsPerSession !== undefined && o.maxTurnsPerSession < 1) e.push('maxTurnsPerSession must be >= 1');
  if (o.checkpointIntervalMs !== undefined && o.checkpointIntervalMs <= 0) e.push('checkpointIntervalMs must be > 0');
  if (o.idleExpireMs !== undefined && o.idleExpireMs <= 0) e.push('idleExpireMs must be > 0');
  if (o.maxSessionAgeMs !== undefined && o.maxSessionAgeMs <= 0) e.push('maxSessionAgeMs must be > 0');
  if (o.keepTurnsAfterCompaction !== undefined && o.keepTurnsAfterCompaction < 0) e.push('keepTurnsAfterCompaction must be >= 0');
  if (o.keepTurnsAfterCompaction !== undefined && o.maxTurnsPerSession !== undefined
    && o.keepTurnsAfterCompaction > o.maxTurnsPerSession) {
    e.push('keepTurnsAfterCompaction must be <= maxTurnsPerSession');
  }
  return e;
}

export interface SessionV20Checkpoint {
  id: string;
  sessionId: string;
  /** Monotonic checkpoint number for this session. */
  number: number;
  atMs: number;
  snapshot: PipelineV20Snapshot;
  /** Turns summarised away by compaction up to this checkpoint. */
  compactedSummary: string;
}

export interface SessionV20Record {
  id: string;
  pipeline: VoicePipelineV20;
  state: SessionV20State;
  createdAtMs: number;
  lastActiveAtMs: number;
  lastCheckpointAtMs: number;
  checkpointNumber: number;
  checkpoints: SessionV20Checkpoint[];
  compactedSummary: string;
  compactedTurns: number;
  handoffs: number;
}

export interface SessionV20Stats {
  sessions: number;
  active: number;
  idle: number;
  ended: number;
  expired: number;
  handedOff: number;
  checkpoints: number;
  compactions: number;
  totalTurns: number;
}

export type SessionManagerV20EventKind =
  | 'created'
  | 'ended'
  | 'expired'
  | 'checkpoint'
  | 'handoff'
  | 'compacted'
  | 'recovered';
export type SessionManagerV20Event = {
  kind: SessionManagerV20EventKind;
  atMs: number;
  sessionId?: string;
  detail?: Record<string, unknown>;
};
export type SessionManagerV20EventSink = (event: SessionManagerV20Event) => void;

/** Summarise dropped turns into one line each (first words + role), for the compacted summary. */
export function summariseTurnsV20(turns: { role: string; text: string }[]): string {
  return turns.map((t) => {
    const words = t.text.trim().split(/\s+/).slice(0, 8).join(' ');
    return `[${t.role}] ${words}${t.text.trim().split(/\s+/).length > 8 ? ' …' : ''}`;
  }).join(' | ');
}

export class SessionManagerV20 {
  private opts: SessionV20Options;
  private pipelineOpts: Partial<PipelineV20Options>;
  private pipelineHooks: PipelineV20Hooks;
  private sink?: SessionManagerV20EventSink;
  private eventSink?: VoiceV20EventSink;
  private sessions = new Map<string, SessionV20Record>();
  private counter = 0;
  private stats = { checkpoints: 0, compactions: 0, handedOff: 0 };

  constructor(
    opts: Partial<SessionV20Options> = {},
    pipelineOpts: Partial<PipelineV20Options> = {},
    pipelineHooks: PipelineV20Hooks = {},
    sink?: SessionManagerV20EventSink,
    eventSink?: VoiceV20EventSink,
  ) {
    this.opts = { ...defaultSessionV20Options(), ...opts };
    this.pipelineOpts = pipelineOpts;
    this.pipelineHooks = pipelineHooks;
    this.sink = sink;
    this.eventSink = eventSink;
  }

  get options(): SessionV20Options { return { ...this.opts }; }
  get size(): number { return this.sessions.size; }

  /** Create a session and start its pipeline. Evicts the oldest idle (else oldest live) session if full. */
  create(atMs: number): SessionV20Record {
    if (this.liveCount() >= this.opts.maxSessions) {
      const victim = this.oldestIdle() ?? this.oldestLive();
      if (victim) this.expire(victim.id, atMs, 'capacity');
    }
    this.counter += 1;
    const id = `voice-v20-${this.counter}`;
    const pipeline = createVoicePipelineV20(id, this.pipelineOpts, this.pipelineHooks, this.eventSink);
    pipeline.start(atMs);
    const record: SessionV20Record = {
      id,
      pipeline,
      state: 'active',
      createdAtMs: atMs,
      lastActiveAtMs: atMs,
      lastCheckpointAtMs: atMs,
      checkpointNumber: 0,
      checkpoints: [],
      compactedSummary: '',
      compactedTurns: 0,
      handoffs: 0,
    };
    this.sessions.set(id, record);
    this.sink?.({ kind: 'created', atMs, sessionId: id, detail: {} });
    return record;
  }

  get(id: string): SessionV20Record | undefined {
    return this.sessions.get(id);
  }

  list(): SessionV20Record[] {
    return [...this.sessions.values()];
  }

  activeCount(): number {
    return [...this.sessions.values()].filter((s) => s.state === 'active').length;
  }

  /** Sessions still holding resources (active or idle). */
  liveCount(): number {
    return [...this.sessions.values()].filter((s) => s.state === 'active' || s.state === 'idle').length;
  }

  private oldestIdle(): SessionV20Record | undefined {
    const idle = [...this.sessions.values()]
      .filter((s) => s.state === 'idle')
      .sort((a, b) => a.lastActiveAtMs - b.lastActiveAtMs);
    return idle[0];
  }

  private oldestLive(): SessionV20Record | undefined {
    const live = [...this.sessions.values()]
      .filter((s) => s.state === 'active' || s.state === 'idle')
      .sort((a, b) => a.createdAtMs - b.createdAtMs);
    return live[0];
  }

  /** Mark a session idle (call paused, pipeline kept). */
  markIdle(id: string, atMs: number): boolean {
    const s = this.sessions.get(id);
    if (!s || s.state !== 'active') return false;
    s.state = 'idle';
    s.lastActiveAtMs = atMs;
    return true;
  }

  /** Wake an idle session back to active. */
  markActive(id: string, atMs: number): boolean {
    const s = this.sessions.get(id);
    if (!s || s.state !== 'idle') return false;
    s.state = 'active';
    s.lastActiveAtMs = atMs;
    return true;
  }

  /** Touch a session: it did work at `atMs` (resets idle expiry). */
  touch(id: string, atMs: number): void {
    const s = this.sessions.get(id);
    if (s && s.state === 'active') s.lastActiveAtMs = atMs;
  }

  /** End a session: pipeline ends, record kept for inspection. */
  end(id: string, atMs: number): boolean {
    const s = this.sessions.get(id);
    if (!s || s.state === 'ended') return false;
    s.pipeline.end(atMs);
    s.state = 'ended';
    s.lastActiveAtMs = atMs;
    this.sink?.({ kind: 'ended', atMs, sessionId: id, detail: { turns: s.pipeline.getTurns().length } });
    return true;
  }

  private expire(id: string, atMs: number, reason: string): boolean {
    const s = this.sessions.get(id);
    if (!s || s.state === 'expired' || s.state === 'ended') return false;
    s.pipeline.end(atMs);
    s.state = 'expired';
    this.sink?.({ kind: 'expired', atMs, sessionId: id, detail: { reason } });
    return true;
  }

  /**
   * Virtual-clock sweep: expire sessions past max age, expire idle
   * sessions past the idle window, and checkpoint sessions whose
   * interval has elapsed. Returns the ids that expired.
   */
  sweep(nowMs: number): string[] {
    const expired: string[] = [];
    for (const s of [...this.sessions.values()]) {
      if (s.state === 'ended' || s.state === 'expired') continue;
      if (nowMs - s.createdAtMs >= this.opts.maxSessionAgeMs) {
        if (this.expire(s.id, nowMs, 'max-age')) expired.push(s.id);
        continue;
      }
      if (s.state === 'idle' && nowMs - s.lastActiveAtMs >= this.opts.idleExpireMs) {
        if (this.expire(s.id, nowMs, 'idle')) expired.push(s.id);
        continue;
      }
      if (s.state === 'active' && nowMs - s.lastCheckpointAtMs >= this.opts.checkpointIntervalMs) {
        this.checkpoint(s.id, nowMs);
      }
    }
    return expired;
  }

  /** Checkpoint a session now. Returns the checkpoint, or null when the session is gone. */
  checkpoint(id: string, atMs: number): SessionV20Checkpoint | null {
    const s = this.sessions.get(id);
    if (!s || s.state === 'ended' || s.state === 'expired') return null;
    s.checkpointNumber += 1;
    const cp: SessionV20Checkpoint = {
      id: `${id}-cp${s.checkpointNumber}`,
      sessionId: id,
      number: s.checkpointNumber,
      atMs,
      snapshot: s.pipeline.snapshot(),
      compactedSummary: s.compactedSummary,
    };
    s.checkpoints.push(cp);
    if (s.checkpoints.length > 10) s.checkpoints.shift();
    s.lastCheckpointAtMs = atMs;
    this.stats.checkpoints += 1;
    this.sink?.({ kind: 'checkpoint', atMs, sessionId: id, detail: { number: cp.number, turns: cp.snapshot.turns.length } });
    return cp;
  }

  /**
   * Hand a session off to a fresh pipeline (e.g. provider failover
   * or process restart): the old pipeline ends, the new one restores
   * the latest checkpoint, the record keeps its id and history.
   */
  handoff(id: string, atMs: number): SessionV20Record | null {
    const s = this.sessions.get(id);
    if (!s || s.state === 'ended' || s.state === 'expired') return null;
    const cp = this.checkpoint(id, atMs);
    const snapshot = cp?.snapshot ?? s.pipeline.snapshot();
    s.pipeline.end(atMs);
    const pipeline = createVoicePipelineV20(id, this.pipelineOpts, this.pipelineHooks, this.eventSink);
    pipeline.start(atMs);
    pipeline.restore(snapshot, atMs);
    s.pipeline = pipeline;
    s.state = 'active';
    s.handoffs += 1;
    this.stats.handedOff += 1;
    s.lastActiveAtMs = atMs;
    this.sink?.({ kind: 'handoff', atMs, sessionId: id, detail: { handoffs: s.handoffs, turns: snapshot.turns.length } });
    return s;
  }

  /**
   * Compact a long session: the oldest turns (beyond the keep
   * window) are folded into the summary and dropped from the live
   * history. Returns how many turns were compacted away.
   */
  compact(id: string, atMs: number): number {
    const s = this.sessions.get(id);
    if (!s || s.state === 'ended' || s.state === 'expired') return 0;
    const turns = s.pipeline.getTurns();
    if (turns.length <= this.opts.keepTurnsAfterCompaction) return 0;
    const drop = turns.length - this.opts.keepTurnsAfterCompaction;
    const dropped = turns.slice(0, drop);
    const summary = summariseTurnsV20(dropped);
    s.compactedSummary = s.compactedSummary ? `${s.compactedSummary} | ${summary}` : summary;
    s.compactedTurns += drop;
    this.stats.compactions += 1;
    // Rebuild the live history from the kept tail via a snapshot.
    const snap = s.pipeline.snapshot();
    const kept = snap.turns.slice(drop);
    const rebuilt: PipelineV20Snapshot = { ...snap, turns: kept };
    s.pipeline.restore(rebuilt, atMs);
    this.sink?.({ kind: 'compacted', atMs, sessionId: id, detail: { dropped: drop, kept: kept.length } });
    return drop;
  }

  /** Compact every session that is over the turn budget. Returns total turns compacted. */
  compactOverBudget(atMs: number): number {
    let total = 0;
    for (const s of this.sessions.values()) {
      if (s.state === 'active' && s.pipeline.getTurns().length > this.opts.maxTurnsPerSession) {
        total += this.compact(s.id, atMs);
      }
    }
    return total;
  }

  /**
   * Recover a session from one of its checkpoints into a fresh
   * pipeline. The old pipeline (if any) is ended first.
   */
  recover(id: string, checkpointNumber: number, atMs: number): SessionV20Record | null {
    const s = this.sessions.get(id);
    if (!s) return null;
    const cp = s.checkpoints.find((c) => c.number === checkpointNumber);
    if (!cp) return null;
    s.pipeline.end(atMs);
    const pipeline = createVoicePipelineV20(id, this.pipelineOpts, this.pipelineHooks, this.eventSink);
    pipeline.start(atMs);
    pipeline.restore(cp.snapshot, atMs);
    s.pipeline = pipeline;
    s.state = 'active';
    s.compactedSummary = cp.compactedSummary;
    s.lastActiveAtMs = atMs;
    this.sink?.({ kind: 'recovered', atMs, sessionId: id, detail: { checkpoint: checkpointNumber, turns: cp.snapshot.turns.length } });
    return s;
  }

  getStats(): SessionV20Stats {
    let active = 0; let idle = 0; let ended = 0; let expired = 0; let handedOff = 0; let checkpoints = 0; let totalTurns = 0;
    for (const s of this.sessions.values()) {
      if (s.state === 'active') active += 1;
      if (s.state === 'idle') idle += 1;
      if (s.state === 'ended') ended += 1;
      if (s.state === 'expired') expired += 1;
      handedOff += s.handoffs;
      checkpoints += s.checkpoints.length;
      totalTurns += s.pipeline.getTurns().length;
    }
    return {
      sessions: this.sessions.size,
      active, idle, ended, expired,
      handedOff,
      checkpoints,
      compactions: this.stats.compactions,
      totalTurns,
    };
  }

  summary(): string {
    const s = this.getStats();
    return `Sessions v20: ${s.sessions} total, ${s.active} active, ${s.idle} idle, ` +
      `${s.ended} ended, ${s.expired} expired, ${s.handedOff} handoffs, ` +
      `${s.checkpoints} checkpoints, ${s.compactions} compactions, ${s.totalTurns} turns`;
  }
}

export function createSessionManagerV20(
  opts: Partial<SessionV20Options> = {},
  pipelineOpts: Partial<PipelineV20Options> = {},
  pipelineHooks: PipelineV20Hooks = {},
  sink?: SessionManagerV20EventSink,
  eventSink?: VoiceV20EventSink,
): SessionManagerV20 {
  return new SessionManagerV20(opts, pipelineOpts, pipelineHooks, sink, eventSink);
}

export function sessionManagerV20Markdown(m: SessionManagerV20): string {
  const s = m.getStats();
  return `# Sessions v20\n\n- Sessions: ${s.sessions}\n- Active: ${s.active}\n- Idle: ${s.idle}\n` +
    `- Ended: ${s.ended}\n- Expired: ${s.expired}\n- Handoffs: ${s.handedOff}\n` +
    `- Checkpoints: ${s.checkpoints}\n- Compactions: ${s.compactions}\n- Total turns: ${s.totalTurns}\n`;
}

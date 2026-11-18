/**
 * Voice session manager v19 (v1.27, Đội T5 — voice v19).
 *
 * NOTE ON NUMBERING: the wave brief asked for "voice realtime v24,
 * continuing v23", but the code on base merge/v126 tops out at voice
 * v18 (packages/core/src/voiceV18, v1.19) — there is no v19–v24
 * anywhere in the tree. v19 is therefore the correct next number,
 * and this module is the v19 session layer ("Session v5" in the
 * brief: the fifth session-management generation, counting the
 * voiceSessionV2 manager, the v11/v12 store-backed sessions and the
 * v18 realtime session + manager). Nothing is copied from any
 * outside repo; the ideas are our own, built on our own v18.
 *
 * v18 gave a single realtime session a connection lifecycle
 * (connect → drop → reconnect → resume from a checkpoint) — but a
 * long-lived app needs the *fleet* view of sessions: many sessions
 * alive at once, each with a bounded lifetime, idle sessions that
 * must be reaped before they leak, and a UI that always shows the
 * same state the engine has. v19 adds that layer on top of v18:
 *
 *   1. Lifecycle. `create` / `connect` / `close` / `delete` plus
 *      `restore` (rebuild a session from an exported snapshot,
 *      re-applying the v18 resume token when one was saved).
 *      State is the five states the UI shows — `idle`,
 *      `listening`, `speaking`, `interrupted` — plus `closed`
 *      and `expired`; it is derived from the v18 turn-taking
 *      state + connection, so the manager can never disagree
 *      with the engine underneath.
 *   2. Duration limits. `maxSessionMs` (default 30 min) caps a
 *      session's whole life; `maxIdleMs` (default 5 min) caps
 *      silence. `sweep()` expires anything over either limit
 *      (disconnecting the v18 session first), keeps a bounded
 *      tombstone so the UI can still show "expired 2 min ago",
 *      and reports exactly what it reaped and why.
 *   3. UI sync. Every state change emits a UI event to all
 *      subscribers (`subscribe()`), and `uiSnapshot()` returns
 *      one JSON-able object per session (state, connection, age,
 *      idle time, time-to-expiry, turns, barge-ins, checkpoints)
 *      — the panel renders from snapshots only, never by
 *      reaching into the engine.
 *   4. Virtual clock. The manager owns one clock (`nowMs`,
 *      starts at 0); `tick(ms)` advances it and every live v18
 *      session together, so tests are deterministic and a
 *      swept session's age is always reproducible.
 *
 * No network, no sound card, no key — the sessions underneath are
 * the mock v18 sessions (scripted replies, mock TTS, synthetic
 * PCM). Duration limits are enforced by the sweeper, not by wall
 * clock, so a test can fast-forward 31 minutes in one call.
 */

import {
  RealtimeSessionManagerV18,
  createRealtimeSessionManagerV18,
  type RealtimeSessionV18,
  type RealtimeV18Checkpoint,
  type RealtimeV18Event,
  type RealtimeV18Options,
  type RealtimeV18Stats,
} from '../voiceV18/realtimeV18';
import type { TurnTakingV17State } from '../voiceV17/turnTakingV17';

/** The six states the UI shows for a v19 session. */
export type VoiceSessionV19State =
  | 'idle'
  | 'listening'
  | 'speaking'
  | 'interrupted'
  | 'closed'
  | 'expired';

export const VOICE_SESSION_V19_STATES: readonly VoiceSessionV19State[] = [
  'idle',
  'listening',
  'speaking',
  'interrupted',
  'closed',
  'expired',
];

export function isVoiceSessionV19State(value: unknown): value is VoiceSessionV19State {
  return (
    typeof value === 'string' &&
    (VOICE_SESSION_V19_STATES as readonly string[]).includes(value)
  );
}

/** Why a session ended. */
export type VoiceSessionV19CloseReason =
  | 'client-close'
  | 'deleted'
  | 'max-duration'
  | 'idle-timeout'
  | 'replaced'
  | 'error';

export const VOICE_SESSION_V19_CLOSE_REASONS: readonly VoiceSessionV19CloseReason[] = [
  'client-close',
  'deleted',
  'max-duration',
  'idle-timeout',
  'replaced',
  'error',
];

export function isVoiceSessionV19CloseReason(value: unknown): value is VoiceSessionV19CloseReason {
  return (
    typeof value === 'string' &&
    (VOICE_SESSION_V19_CLOSE_REASONS as readonly string[]).includes(value)
  );
}

export interface VoiceSessionV19Options {
  /** Whole-life cap for one session (ms, default 1_800_000 = 30 min). */
  maxSessionMs?: number;
  /** Silence cap before the sweeper expires an idle session (ms, default 300_000 = 5 min). */
  maxIdleMs?: number;
  /** Max live sessions (default 20; creating beyond it throws). */
  maxSessions?: number;
  /** Max expired/closed tombstones kept for the UI (default 20). */
  maxTombstones?: number;
  /** Options forwarded to every v18 session created by this manager. */
  realtime?: RealtimeV18Options;
}

export function defaultVoiceSessionV19Options(): Required<
  Omit<VoiceSessionV19Options, 'realtime'>
> {
  return {
    maxSessionMs: 1_800_000,
    maxIdleMs: 300_000,
    maxSessions: 20,
    maxTombstones: 20,
  };
}

export function validateVoiceSessionV19Options(options: VoiceSessionV19Options): string[] {
  const errors: string[] = [];
  const check = (name: string, value: number | undefined, min: number, max: number): void => {
    if (value === undefined) return;
    if (!Number.isFinite(value) || Math.floor(value) !== value) {
      errors.push(`${name} must be an integer, got ${String(value)}`);
    } else if (value < min || value > max) {
      errors.push(`${name} must be ${min}..${max}, got ${value}`);
    }
  };
  check('maxSessionMs', options.maxSessionMs, 1_000, 86_400_000);
  check('maxIdleMs', options.maxIdleMs, 1_000, 86_400_000);
  check('maxSessions', options.maxSessions, 1, 1_000);
  check('maxTombstones', options.maxTombstones, 0, 1_000);
  return errors;
}

/** One UI-sync event: what changed, on which session, when. */
export type VoiceSessionV19UiEventKind =
  | 'created'
  | 'connected'
  | 'state'
  | 'turn'
  | 'barge-in'
  | 'checkpoint'
  | 'recovered'
  | 'closed'
  | 'expired'
  | 'restored'
  | 'swept';

export interface VoiceSessionV19UiEvent {
  kind: VoiceSessionV19UiEventKind;
  sessionId: string;
  atMs: number;
  state: VoiceSessionV19State;
  message?: string;
  reason?: string;
}

export type VoiceSessionV19UiSink = (event: VoiceSessionV19UiEvent) => void;

/** The lifecycle record the manager keeps per session. */
export interface VoiceSessionV19Record {
  id: string;
  state: VoiceSessionV19State;
  createdAtMs: number;
  lastActivityAtMs: number;
  closedAtMs: number | undefined;
  closeReason: VoiceSessionV19CloseReason | undefined;
  /** Resume token of the last v18 checkpoint, when one exists. */
  resumeToken: string | undefined;
  turns: number;
  bargeIns: number;
  checkpoints: number;
  reconnects: number;
}

/** One JSON-able snapshot for the UI panel. */
export interface VoiceSessionV19UiSnapshot {
  id: string;
  state: VoiceSessionV19State;
  connection: string;
  botId: string;
  language: string;
  createdAtMs: number;
  lastActivityAtMs: number;
  ageMs: number;
  idleMs: number;
  /** ms until the sooner of the two limits bites (0 when already past). */
  expiresInMs: number;
  /** Which limit will bite first: 'duration' | 'idle' | 'none' (closed). */
  expiresBy: 'duration' | 'idle' | 'none';
  turns: number;
  bargeIns: number;
  checkpoints: number;
  reconnects: number;
  closeReason: VoiceSessionV19CloseReason | undefined;
  hasResumeToken: boolean;
}

/** What one `sweep()` run reaped. */
export interface VoiceSessionV19SweepEntry {
  sessionId: string;
  reason: VoiceSessionV19CloseReason;
  ageMs: number;
  idleMs: number;
}

export interface VoiceSessionV19SweepReport {
  atMs: number;
  examined: number;
  expired: VoiceSessionV19SweepEntry[];
  keptTombstones: number;
}

export interface VoiceSessionV19Stats {
  nowMs: number;
  live: number;
  closed: number;
  expired: number;
  totalCreated: number;
  totalExpired: number;
  totalClosed: number;
  totalRestored: number;
  sweeps: number;
  totalSwept: number;
}

/** Exported snapshot: everything `restore()` needs. */
export interface VoiceSessionV19Export {
  version: 1;
  id: string;
  botId: string;
  userId: string | undefined;
  language: string;
  createdAtMs: number;
  lastActivityAtMs: number;
  resumeToken: string | undefined;
  lastCheckpoint: RealtimeV18Checkpoint | undefined;
  record: VoiceSessionV19Record;
}

/** Map a v18 turn-taking state + connection onto the v19 UI state. */
export function mapV18StateToV19(
  turnState: TurnTakingV17State,
  connection: string,
  closed: boolean,
): VoiceSessionV19State {
  if (closed || connection === 'closed') return 'closed';
  if (turnState === 'interrupted') return 'interrupted';
  if (turnState === 'speaking') return 'speaking';
  if (turnState === 'listening') return 'listening';
  // 'thinking' is the beat between listening and speaking: the user
  // sees it as still listening (the agent has not spoken yet).
  if (turnState === 'thinking') return 'listening';
  return 'idle';
}

function clampInt(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.floor(value)));
}

export class VoiceSessionManagerV19 {
  readonly inner: RealtimeSessionManagerV18;
  private readonly options: Required<Omit<VoiceSessionV19Options, 'realtime'>> & {
    realtime: RealtimeV18Options;
  };
  private nowMs = 0;
  private readonly records = new Map<string, VoiceSessionV19Record>();
  private readonly tombstones: VoiceSessionV19Record[] = [];
  private readonly sinks = new Set<VoiceSessionV19UiSink>();
  private readonly events: VoiceSessionV19UiEvent[] = [];
  private totalCreated = 0;
  private totalExpired = 0;
  private totalClosed = 0;
  private totalRestored = 0;
  private sweeps = 0;
  private totalSwept = 0;

  constructor(options: VoiceSessionV19Options = {}) {
    const errors = validateVoiceSessionV19Options(options);
    if (errors.length > 0) {
      throw new Error(`invalid voice session v19 options: ${errors.join('; ')}`);
    }
    const defaults = defaultVoiceSessionV19Options();
    this.options = {
      maxSessionMs: options.maxSessionMs ?? defaults.maxSessionMs,
      maxIdleMs: options.maxIdleMs ?? defaults.maxIdleMs,
      maxSessions: options.maxSessions ?? defaults.maxSessions,
      maxTombstones: options.maxTombstones ?? defaults.maxTombstones,
      realtime: options.realtime ?? {},
    };
    this.inner = createRealtimeSessionManagerV18();
  }

  getOptions(): Required<Omit<VoiceSessionV19Options, 'realtime'>> {
    return {
      maxSessionMs: this.options.maxSessionMs,
      maxIdleMs: this.options.maxIdleMs,
      maxSessions: this.options.maxSessions,
      maxTombstones: this.options.maxTombstones,
    };
  }

  now(): number {
    return this.nowMs;
  }

  /** Advance the manager clock and every live v18 session together. */
  tick(ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) throw new Error(`tick(ms) must be >= 0, got ${ms}`);
    this.nowMs += Math.floor(ms);
    for (const session of this.inner.list()) {
      if (session.getConnection() !== 'closed') session.tick(Math.floor(ms));
    }
  }

  /** Subscribe to UI-sync events (returns an unsubscribe function). */
  subscribe(sink: VoiceSessionV19UiSink): () => void {
    this.sinks.add(sink);
    return () => {
      this.sinks.delete(sink);
    };
  }

  private emit(event: VoiceSessionV19UiEvent): void {
    this.events.push(event);
    for (const sink of this.sinks) sink(event);
  }

  eventsList(): VoiceSessionV19UiEvent[] {
    return [...this.events];
  }

  private refreshRecord(id: string): void {
    const record = this.records.get(id);
    const session = this.inner.get(id);
    if (!record || !session) return;
    const stats = session.stats();
    record.turns = stats.turns;
    record.bargeIns = stats.bargeIns;
    record.checkpoints = stats.checkpoints;
    record.reconnects = stats.reconnects;
    record.resumeToken = session.resumeToken();
    if (record.state !== 'closed' && record.state !== 'expired') {
      record.state = mapV18StateToV19(
        session.getState(),
        session.getConnection(),
        false,
      );
    }
  }

  private onInnerEvent(id: string, event: RealtimeV18Event): void {
    const record = this.records.get(id);
    if (!record) return;
    record.lastActivityAtMs = this.nowMs;
    this.refreshRecord(id);
    const kindMap: Record<string, VoiceSessionV19UiEventKind | undefined> = {
      connected: 'connected',
      state: 'state',
      'turn-end': 'turn',
      reply: 'turn',
      'barge-in': 'barge-in',
      checkpoint: 'checkpoint',
      recovered: 'recovered',
      dropped: 'state',
      error: 'state',
    };
    const kind = kindMap[event.kind] ?? 'state';
    this.emit({
      kind,
      sessionId: id,
      atMs: this.nowMs,
      state: record.state,
      message: event.message ?? event.text,
      reason: event.reason,
    });
  }

  /** Create a session (not connected yet — call `connect(id)` next). */
  create(id: string, options: RealtimeV18Options = {}): RealtimeSessionV18 {
    if (!id || typeof id !== 'string') throw new Error('Voice session v19 id must be a non-empty string.');
    if (this.records.has(id)) {
      throw new Error(`Voice session v19 "${id}" already exists.`);
    }
    if (this.liveCount() >= this.options.maxSessions) {
      throw new Error(
        `Voice session v19 limit reached (${this.options.maxSessions} live sessions).`,
      );
    }
    const session = this.inner.create(
      id,
      { ...this.options.realtime, ...options },
      (event) => this.onInnerEvent(id, event),
    );
    const record: VoiceSessionV19Record = {
      id,
      state: 'idle',
      createdAtMs: this.nowMs,
      lastActivityAtMs: this.nowMs,
      closedAtMs: undefined,
      closeReason: undefined,
      resumeToken: undefined,
      turns: 0,
      bargeIns: 0,
      checkpoints: 0,
      reconnects: 0,
    };
    this.records.set(id, record);
    this.totalCreated += 1;
    this.emit({ kind: 'created', sessionId: id, atMs: this.nowMs, state: 'idle' });
    return session;
  }

  get(id: string): RealtimeSessionV18 | undefined {
    return this.inner.get(id);
  }

  record(id: string): VoiceSessionV19Record | undefined {
    const found = this.records.get(id);
    return found ? { ...found } : undefined;
  }

  listRecords(): VoiceSessionV19Record[] {
    return [...this.records.values()].map((r) => ({ ...r }));
  }

  liveCount(): number {
    let count = 0;
    for (const record of this.records.values()) {
      if (record.state !== 'closed' && record.state !== 'expired') count += 1;
    }
    return count;
  }

  count(): number {
    return this.records.size;
  }

  tombstoneCount(): number {
    return this.tombstones.length;
  }

  /** Connect a created session (resolves the profile, opens the turn machine). */
  async connect(id: string): Promise<void> {
    const session = this.inner.get(id);
    if (!session) throw new Error(`Voice session v19 "${id}" does not exist.`);
    await session.connect();
    const record = this.records.get(id);
    if (record) {
      record.lastActivityAtMs = this.nowMs;
      this.refreshRecord(id);
      this.emit({ kind: 'connected', sessionId: id, atMs: this.nowMs, state: record.state });
    }
  }

  /** Close a session but keep its record (inspectable until swept/deleted). */
  close(id: string, reason: VoiceSessionV19CloseReason = 'client-close'): boolean {
    const session = this.inner.get(id);
    const record = this.records.get(id);
    if (!session || !record) return false;
    if (record.state === 'closed' || record.state === 'expired') return false;
    session.disconnect(reason);
    record.state = 'closed';
    record.closedAtMs = this.nowMs;
    record.closeReason = reason;
    record.resumeToken = session.resumeToken();
    this.refreshRecord(id);
    // refreshRecord must not resurrect a closed session: re-assert.
    record.state = 'closed';
    this.totalClosed += 1;
    this.emit({ kind: 'closed', sessionId: id, atMs: this.nowMs, state: 'closed', reason });
    return true;
  }

  /** Disconnect + drop the session and its record entirely. */
  delete(id: string): boolean {
    const record = this.records.get(id);
    if (!record) return false;
    this.inner.delete(id);
    this.records.delete(id);
    return true;
  }

  /**
   * Expire every live session past either limit. Closed sessions are
   * never re-expired. Returns what was reaped, in creation order.
   */
  sweep(): VoiceSessionV19SweepReport {
    this.sweeps += 1;
    const expired: VoiceSessionV19SweepEntry[] = [];
    let examined = 0;
    for (const record of [...this.records.values()]) {
      if (record.state === 'closed' || record.state === 'expired') continue;
      examined += 1;
      const ageMs = this.nowMs - record.createdAtMs;
      const idleMs = this.nowMs - record.lastActivityAtMs;
      let reason: VoiceSessionV19CloseReason | undefined;
      if (ageMs > this.options.maxSessionMs) reason = 'max-duration';
      else if (idleMs > this.options.maxIdleMs) reason = 'idle-timeout';
      if (!reason) continue;
      const session = this.inner.get(record.id);
      if (session) session.disconnect(reason);
      record.state = 'expired';
      record.closedAtMs = this.nowMs;
      record.closeReason = reason;
      record.resumeToken = session?.resumeToken();
      this.refreshRecord(record.id);
      record.state = 'expired';
      expired.push({ sessionId: record.id, reason, ageMs, idleMs });
      this.totalExpired += 1;
      this.totalSwept += 1;
      this.tombstones.push({ ...record });
      this.emit({
        kind: 'expired',
        sessionId: record.id,
        atMs: this.nowMs,
        state: 'expired',
        reason,
      });
    }
    // Bound the tombstones (oldest first out).
    while (this.tombstones.length > this.options.maxTombstones) {
      this.tombstones.shift();
    }
    this.emit({
      kind: 'swept',
      sessionId: '',
      atMs: this.nowMs,
      state: 'idle',
      message: `${expired.length} session(s) expired`,
    });
    return { atMs: this.nowMs, examined, expired, keptTombstones: this.tombstones.length };
  }

  /** One JSON-able snapshot for the UI panel (undefined when unknown). */
  uiSnapshot(id: string): VoiceSessionV19UiSnapshot | undefined {
    const record = this.records.get(id);
    const session = this.inner.get(id);
    if (!record || !session) return undefined;
    this.refreshRecord(id);
    const ageMs = this.nowMs - record.createdAtMs;
    const idleMs = this.nowMs - record.lastActivityAtMs;
    const closed = record.state === 'closed' || record.state === 'expired';
    const durationLeft = this.options.maxSessionMs - ageMs;
    const idleLeft = this.options.maxIdleMs - idleMs;
    const expiresInMs = closed ? 0 : Math.max(0, Math.min(durationLeft, idleLeft));
    const expiresBy: VoiceSessionV19UiSnapshot['expiresBy'] = closed
      ? 'none'
      : durationLeft <= idleLeft
        ? 'duration'
        : 'idle';
    const stats: RealtimeV18Stats = session.stats();
    return {
      id,
      state: record.state,
      connection: session.getConnection(),
      botId: session.botId,
      language: session.language,
      createdAtMs: record.createdAtMs,
      lastActivityAtMs: record.lastActivityAtMs,
      ageMs,
      idleMs,
      expiresInMs,
      expiresBy,
      turns: stats.turns,
      bargeIns: stats.bargeIns,
      checkpoints: stats.checkpoints,
      reconnects: stats.reconnects,
      closeReason: record.closeReason,
      hasResumeToken: record.resumeToken !== undefined,
    };
  }

  /** Snapshots for every session the manager still knows, live first. */
  uiSnapshots(): VoiceSessionV19UiSnapshot[] {
    const live: VoiceSessionV19UiSnapshot[] = [];
    const done: VoiceSessionV19UiSnapshot[] = [];
    for (const record of this.records.values()) {
      const snap = this.uiSnapshot(record.id);
      if (!snap) continue;
      if (snap.state === 'closed' || snap.state === 'expired') done.push(snap);
      else live.push(snap);
    }
    return [...live, ...done];
  }

  /** Export a session so `restore()` can rebuild it later (even after a crash). */
  exportSession(id: string): VoiceSessionV19Export | undefined {
    const record = this.records.get(id);
    const session = this.inner.get(id);
    if (!record || !session) return undefined;
    this.refreshRecord(id);
    return {
      version: 1,
      id,
      botId: session.botId,
      userId: session.userId,
      language: session.language,
      createdAtMs: record.createdAtMs,
      lastActivityAtMs: record.lastActivityAtMs,
      resumeToken: session.resumeToken(),
      lastCheckpoint: session.lastCheckpoint(),
      record: { ...record },
    };
  }

  /**
   * Rebuild a session from an export. The new session gets a fresh
   * v18 engine; when the export carries a resume token the last
   * checkpoint is re-applied, so the turn that was cut can resume
   * instead of restarting from silence. Returns the new session,
   * or undefined when the export is invalid / the id is taken.
   */
  restore(exported: VoiceSessionV19Export, options: RealtimeV18Options = {}): RealtimeSessionV18 | undefined {
    if (!exported || exported.version !== 1 || typeof exported.id !== 'string') return undefined;
    if (this.records.has(exported.id)) return undefined;
    if (this.liveCount() >= this.options.maxSessions) return undefined;
    const session = this.inner.create(
      exported.id,
      {
        ...this.options.realtime,
        ...options,
        botId: exported.botId,
        userId: exported.userId,
        language: exported.language,
      },
      (event) => this.onInnerEvent(exported.id, event),
    );
    let restored = false;
    if (exported.resumeToken) {
      restored = session.restoreFromToken(exported.resumeToken);
    }
    const record: VoiceSessionV19Record = {
      ...exported.record,
      state: 'idle',
      createdAtMs: this.nowMs,
      lastActivityAtMs: this.nowMs,
      closedAtMs: undefined,
      closeReason: undefined,
      resumeToken: session.resumeToken(),
    };
    this.records.set(exported.id, record);
    this.totalCreated += 1;
    this.totalRestored += 1;
    this.emit({
      kind: 'restored',
      sessionId: exported.id,
      atMs: this.nowMs,
      state: 'idle',
      message: restored ? 'checkpoint restored' : 'no checkpoint to restore',
    });
    return session;
  }

  stats(): VoiceSessionV19Stats {
    let closed = 0;
    let expired = 0;
    for (const record of this.records.values()) {
      if (record.state === 'closed') closed += 1;
      if (record.state === 'expired') expired += 1;
    }
    return {
      nowMs: this.nowMs,
      live: this.liveCount(),
      closed,
      expired,
      totalCreated: this.totalCreated,
      totalExpired: this.totalExpired,
      totalClosed: this.totalClosed,
      totalRestored: this.totalRestored,
      sweeps: this.sweeps,
      totalSwept: this.totalSwept,
    };
  }

  summary(): string {
    const s = this.stats();
    return (
      `voice session v19: ${s.live} live, ${s.closed} closed, ${s.expired} expired ` +
      `(${s.totalCreated} created, ${s.totalRestored} restored, ${s.totalSwept} swept in ${s.sweeps} sweep(s), clock ${s.nowMs} ms)`
    );
  }

  markdown(): string {
    const s = this.stats();
    const lines = [
      '## Voice sessions v19',
      '',
      `- Clock: ${s.nowMs} ms — live ${s.live}, closed ${s.closed}, expired ${s.expired}.`,
      `- Created ${s.totalCreated} (restored ${s.totalRestored}); swept ${s.totalSwept} in ${s.sweeps} sweep(s).`,
      `- Limits: session ${this.options.maxSessionMs} ms, idle ${this.options.maxIdleMs} ms, max ${this.options.maxSessions} live.`,
      '',
      '| Session | State | Age (ms) | Idle (ms) | Turns | Barge-ins | Checkpoints |',
      '|---|---|---|---|---|---|---|',
    ];
    for (const snap of this.uiSnapshots()) {
      lines.push(
        `| ${snap.id} | ${snap.state} | ${snap.ageMs} | ${snap.idleMs} | ${snap.turns} | ${snap.bargeIns} | ${snap.checkpoints} |`,
      );
    }
    return lines.join('\n');
  }
}

export function createVoiceSessionManagerV19(
  options: VoiceSessionV19Options = {},
): VoiceSessionManagerV19 {
  return new VoiceSessionManagerV19(options);
}

/** Clamp helper re-exported for the eval (rate stability needs it too). */
export function clampIntV19(value: number, min: number, max: number): number {
  return clampInt(value, min, max);
}

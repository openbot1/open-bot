/**
 * Realtime session manager v2 for voice v23 (v1.36, Team T5).
 *
 * v22 owns one durable session (its store, resume engine and
 * recovery loop). v23 manages *many* v22 sessions and the
 * space between them:
 *
 *   - open / close / list sessions, each a live VoiceSessionV22;
 *   - reconnect orchestration: a disconnect starts a scheduled
 *     attempt series (v22 exponential backoff + deterministic
 *     jitter); each attempt is reported, the next attempt time
 *     is visible, and the series gives up after `maxAttempts`;
 *   - resume orchestration: a successful attempt resumes from
 *     the store checkpoint and refreshes the resume token, so
 *     the token a client holds never goes stale mid-outage;
 *   - handover: move a session's snapshot to a new session id
 *     (the old device hands over to the new one) without
 *     losing the transcript or the queued cut replies;
 *   - per-session + aggregate stats, so the panel can show the
 *     whole fleet of voice sessions at a glance.
 *
 * All transport is the v22 mock (no socket is dialled, no
 * network, no key). All clocks virtual.
 */
import {
  VoiceSessionV22,
  backoffDelayV22,
  resumeTokenV22,
  type VoiceV22DurabilityReport,
  type VoiceV22ResumeReport,
  type VoiceV22SessionOptions,
} from '../voiceV22/index';
import type { VoiceV23ManagedPhase } from './types';

export interface SessionManagerV23Options {
  /** Max reconnect attempts before the session is marked failed (default 5). */
  maxAttempts: number;
  /** Backoff options passed to the v22 delay function. */
  backoff?: { backoffBaseMs?: number; backoffMaxMs?: number };
  /** Auto-checkpoint a session when it is handed over (default true). */
  checkpointOnHandover: boolean;
}

export function defaultSessionManagerV23Options(): SessionManagerV23Options {
  return { maxAttempts: 5, backoff: {}, checkpointOnHandover: true };
}

export function validateSessionManagerV23Options(o: Partial<SessionManagerV23Options>): string[] {
  const errors: string[] = [];
  if (o.maxAttempts !== undefined && (!Number.isInteger(o.maxAttempts) || o.maxAttempts < 1 || o.maxAttempts > 20)) {
    errors.push('maxAttempts must be an integer 1..20');
  }
  if (o.backoff?.backoffBaseMs !== undefined && !(o.backoff.backoffBaseMs > 0)) errors.push('backoffBaseMs must be positive');
  if (o.backoff?.backoffMaxMs !== undefined && !(o.backoff.backoffMaxMs > 0)) errors.push('backoffMaxMs must be positive');
  return errors;
}

/** One reconnect attempt, as the manager scheduled and reported it. */
export interface VoiceV23ReconnectAttempt {
  sessionId: string;
  attempt: number;
  atMs: number;
  delayMs: number;
  outcome: 'success' | 'failure';
  nextAttemptAtMs: number | null;
}

export interface VoiceV23ManagedSession {
  sessionId: string;
  phase: VoiceV23ManagedPhase;
  attempts: number;
  nextAttemptAtMs: number | null;
  lastResume: VoiceV22ResumeReport | null;
  resumeToken: string | null;
  openedAtMs: number;
  closedAtMs: number | null;
  handovers: number;
}

export interface VoiceV23SessionManagerStats {
  sessions: number;
  live: number;
  reconnecting: number;
  failed: number;
  closed: number;
  totalAttempts: number;
  totalResumes: number;
  totalHandovers: number;
}

/**
 * Re-key a v22 store snapshot from one session id to another:
 * the snapshot, its journal entries and its checkpoint all
 * carry the old id, and the checkpoint's resume token is
 * derived from it (`v22-resume-<id>-<seq>`). v22 restore
 * refuses a snapshot for a different session, so a handover
 * must rewrite all three before restoring — the journal tail,
 * the turns and the transcript are content, not identity, and
 * survive the rewrite untouched.
 */
export function rekeySnapshotV23(snapshotJson: string, fromId: string, toId: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(snapshotJson) as unknown;
  } catch {
    throw new Error('Handover snapshot JSON is not valid JSON');
  }
  if (typeof parsed !== 'object' || parsed === null) throw new Error('Handover snapshot must be a JSON object');
  const snapshot = parsed as Record<string, unknown>;
  if (snapshot.sessionId !== fromId) throw new Error(`Handover snapshot sessionId "${String(snapshot.sessionId)}" does not match "${fromId}"`);
  snapshot.sessionId = toId;
  if (Array.isArray(snapshot.journal)) {
    for (const entry of snapshot.journal) {
      if (typeof entry === 'object' && entry !== null && (entry as Record<string, unknown>).sessionId === fromId) {
        (entry as Record<string, unknown>).sessionId = toId;
      }
    }
  }
  if (typeof snapshot.checkpoint === 'object' && snapshot.checkpoint !== null) {
    const checkpoint = snapshot.checkpoint as Record<string, unknown>;
    if (checkpoint.sessionId !== fromId) throw new Error('Handover checkpoint sessionId does not match the snapshot session');
    checkpoint.sessionId = toId;
    if (typeof checkpoint.journalSeq === 'number') {
      checkpoint.resumeToken = resumeTokenV22(toId, checkpoint.journalSeq);
    }
  }
  return JSON.stringify(snapshot);
}

export class RealtimeSessionManagerV23 {
  private readonly opts: SessionManagerV23Options;
  private readonly sessions = new Map<string, VoiceSessionV22>();
  private readonly managed = new Map<string, VoiceV23ManagedSession>();
  private readonly attempts: VoiceV23ReconnectAttempt[] = [];

  constructor(opts: Partial<SessionManagerV23Options> = {}) {
    const errors = validateSessionManagerV23Options(opts);
    if (errors.length > 0) throw new Error(`Invalid SessionManagerV23 options: ${errors.join('; ')}`);
    this.opts = { ...defaultSessionManagerV23Options(), ...opts };
  }

  options(): SessionManagerV23Options {
    return { ...this.opts, backoff: { ...this.opts.backoff } };
  }

  /** Open a new managed v22 session (id must be fresh). */
  open(sessionId: string, opts: VoiceV22SessionOptions = {}, atMs = 0): VoiceSessionV22 {
    if (this.sessions.has(sessionId)) throw new Error(`Session "${sessionId}" already exists`);
    const session = new VoiceSessionV22(sessionId, opts);
    session.start(atMs);
    this.sessions.set(sessionId, session);
    this.managed.set(sessionId, {
      sessionId,
      phase: 'live',
      attempts: 0,
      nextAttemptAtMs: null,
      lastResume: null,
      resumeToken: null,
      openedAtMs: atMs,
      closedAtMs: null,
      handovers: 0,
    });
    return session;
  }

  get(sessionId: string): VoiceSessionV22 | null {
    return this.sessions.get(sessionId) ?? null;
  }

  ids(): string[] {
    return [...this.sessions.keys()];
  }

  managedState(sessionId: string): VoiceV23ManagedSession | null {
    const m = this.managed.get(sessionId);
    return m === undefined ? null : { ...m };
  }

  phaseOf(sessionId: string): VoiceV23ManagedPhase | null {
    return this.managed.get(sessionId)?.phase ?? null;
  }

  /**
   * Simulate a transport drop for a session and schedule the
   * first reconnect attempt. Returns the delay before it.
   */
  disconnect(sessionId: string, atMs: number, message = 'transport lost'): number {
    const session = this.need(sessionId);
    const m = this.needManaged(sessionId);
    session.simulateDisconnect(atMs, message);
    m.phase = 'reconnecting';
    m.attempts = 0;
    const delayMs = backoffDelayV22(1, this.opts.backoff);
    m.nextAttemptAtMs = atMs + delayMs;
    return delayMs;
  }

  /** True when a reconnect attempt is due at `atMs`. */
  attemptDue(sessionId: string, atMs: number): boolean {
    const m = this.managed.get(sessionId);
    return m !== undefined && m.phase === 'reconnecting' && m.nextAttemptAtMs !== null && atMs >= m.nextAttemptAtMs;
  }

  /**
   * Report one reconnect attempt. On success the session
   * resumes from its checkpoint and the resume token is
   * refreshed; on failure the next attempt is scheduled, or
   * the session is marked failed after `maxAttempts`.
   */
  async reportAttempt(
    sessionId: string,
    atMs: number,
    outcome: 'success' | 'failure',
  ): Promise<{ phase: VoiceV23ManagedPhase; report: VoiceV22ResumeReport | null; nextAttemptAtMs: number | null }> {
    const session = this.need(sessionId);
    const m = this.needManaged(sessionId);
    if (m.phase !== 'reconnecting') throw new Error(`Session "${sessionId}" is not reconnecting (phase ${m.phase})`);
    m.attempts += 1;
    if (outcome === 'success') {
      m.phase = 'resuming';
      const report = await session.attemptReconnect(atMs, 'success');
      m.lastResume = report;
      m.phase = 'live';
      m.nextAttemptAtMs = null;
      const checkpoint = session.checkpointNow(atMs);
      m.resumeToken = checkpoint === null ? null : checkpoint.checkpoint.resumeToken;
      this.attempts.push({ sessionId, attempt: m.attempts, atMs, delayMs: 0, outcome, nextAttemptAtMs: null });
      return { phase: m.phase, report, nextAttemptAtMs: null };
    }
    await session.attemptReconnect(atMs, 'failure');
    if (m.attempts >= this.opts.maxAttempts) {
      m.phase = 'failed';
      m.nextAttemptAtMs = null;
      this.attempts.push({ sessionId, attempt: m.attempts, atMs, delayMs: 0, outcome, nextAttemptAtMs: null });
      return { phase: m.phase, report: null, nextAttemptAtMs: null };
    }
    const delayMs = backoffDelayV22(m.attempts + 1, this.opts.backoff);
    m.nextAttemptAtMs = atMs + delayMs;
    this.attempts.push({ sessionId, attempt: m.attempts, atMs, delayMs, outcome, nextAttemptAtMs: m.nextAttemptAtMs });
    return { phase: m.phase, report: null, nextAttemptAtMs: m.nextAttemptAtMs };
  }

  /** Delay before attempt N (v22 exponential backoff + jitter). */
  backoffFor(attempt: number): number {
    return backoffDelayV22(attempt, this.opts.backoff);
  }

  /**
   * Hand a session over to a new id: snapshot the old session,
   * re-key the snapshot to the new id, open the new session
   * from it and resume so the live turns/transcript are
   * rehydrated, then close the old one. The transcript,
   * counters and queued replies survive.
   */
  async handover(fromId: string, toId: string, atMs: number): Promise<VoiceSessionV22> {
    const from = this.need(fromId);
    if (this.sessions.has(toId)) throw new Error(`Session "${toId}" already exists`);
    if (this.opts.checkpointOnHandover) from.checkpointNow(atMs);
    const snapshot = from.snapshotJson(atMs);
    const rekeyed = rekeySnapshotV23(snapshot, fromId, toId);
    const to = new VoiceSessionV22(toId, {});
    const errors = to.restoreSnapshotJson(rekeyed);
    if (errors.length > 0) throw new Error(`Handover restore failed: ${errors.join('; ')}`);
    await to.resumeFromStore(atMs);
    to.start(atMs);
    this.sessions.set(toId, to);
    const fromManaged = this.needManaged(fromId);
    fromManaged.phase = 'handed-over';
    fromManaged.closedAtMs = atMs;
    from.close(atMs);
    this.managed.set(toId, {
      sessionId: toId,
      phase: 'live',
      attempts: 0,
      nextAttemptAtMs: null,
      lastResume: fromManaged.lastResume,
      resumeToken: to.store.latestCheckpoint()?.resumeToken ?? fromManaged.resumeToken,
      openedAtMs: atMs,
      closedAtMs: null,
      handovers: fromManaged.handovers + 1,
    });
    return to;
  }

  /** Durability report of one managed session. */
  durabilityReport(sessionId: string, atMs: number): VoiceV22DurabilityReport {
    return this.need(sessionId).durabilityReport(atMs);
  }

  /**
   * Export a managed session as a snapshot JSON (for persist /
   * transfer). A checkpoint is written first so the snapshot
   * always carries one — without it an import could not
   * rehydrate the live turns and transcript.
   */
  exportSession(sessionId: string, atMs: number): string {
    const session = this.need(sessionId);
    session.checkpointNow(atMs);
    return session.snapshotJson(atMs);
  }

  /**
   * Import a snapshot exported by `exportSession` (possibly
   * from another manager) under a new id: the snapshot is
   * re-keyed, restored, and resumed so the live turns and
   * transcript are rehydrated.
   */
  async importSession(snapshotJson: string, newId: string, atMs: number): Promise<VoiceSessionV22> {
    if (this.sessions.has(newId)) throw new Error(`Session "${newId}" already exists`);
    let parsed: unknown;
    try {
      parsed = JSON.parse(snapshotJson) as unknown;
    } catch {
      throw new Error('Import snapshot JSON is not valid JSON');
    }
    if (typeof parsed !== 'object' || parsed === null || typeof (parsed as Record<string, unknown>).sessionId !== 'string') {
      throw new Error('Import snapshot must be a JSON object with a sessionId');
    }
    const fromId = (parsed as Record<string, unknown>).sessionId as string;
    const rekeyed = rekeySnapshotV23(snapshotJson, fromId, newId);
    const session = new VoiceSessionV22(newId, {});
    const errors = session.restoreSnapshotJson(rekeyed);
    if (errors.length > 0) throw new Error(`Import restore failed: ${errors.join('; ')}`);
    await session.resumeFromStore(atMs);
    session.start(atMs);
    this.sessions.set(newId, session);
    this.managed.set(newId, {
      sessionId: newId,
      phase: 'live',
      attempts: 0,
      nextAttemptAtMs: null,
      lastResume: null,
      resumeToken: session.store.latestCheckpoint()?.resumeToken ?? null,
      openedAtMs: atMs,
      closedAtMs: null,
      handovers: 0,
    });
    return session;
  }

  close(sessionId: string, atMs: number): void {
    const session = this.need(sessionId);
    const m = this.needManaged(sessionId);
    session.close(atMs);
    m.phase = 'closed';
    m.closedAtMs = atMs;
    m.nextAttemptAtMs = null;
  }

  attemptsHistory(): VoiceV23ReconnectAttempt[] {
    return [...this.attempts];
  }

  stats(): VoiceV23SessionManagerStats {
    const all = [...this.managed.values()];
    return {
      sessions: all.length,
      live: all.filter((m) => m.phase === 'live').length,
      reconnecting: all.filter((m) => m.phase === 'reconnecting' || m.phase === 'resuming').length,
      failed: all.filter((m) => m.phase === 'failed').length,
      closed: all.filter((m) => m.phase === 'closed' || m.phase === 'handed-over').length,
      totalAttempts: this.attempts.length,
      totalResumes: all.filter((m) => m.lastResume !== null).length,
      totalHandovers: all.reduce((a, m) => a + m.handovers, 0),
    };
  }

  summary(): string {
    const s = this.stats();
    return `session manager v2: ${s.sessions} sessions (${s.live} live, ${s.reconnecting} reconnecting, ${s.failed} failed, ${s.closed} closed), ${s.totalAttempts} reconnect attempts, ${s.totalHandovers} handovers`;
  }

  private need(sessionId: string): VoiceSessionV22 {
    const session = this.sessions.get(sessionId);
    if (session === undefined) throw new Error(`No session "${sessionId}"`);
    return session;
  }

  private needManaged(sessionId: string): VoiceV23ManagedSession {
    const m = this.managed.get(sessionId);
    if (m === undefined) throw new Error(`No managed session "${sessionId}"`);
    return m;
  }
}

export function createRealtimeSessionManagerV23(opts: Partial<SessionManagerV23Options> = {}): RealtimeSessionManagerV23 {
  return new RealtimeSessionManagerV23(opts);
}

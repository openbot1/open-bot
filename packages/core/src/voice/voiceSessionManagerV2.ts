/**
 * Voice session manager v2 (v1.05, Team T5 — multi-session).
 *
 * One voice call was v3's job. The app can now hold several:
 * a call in the foreground, a dictation session parked, a second
 * bot listening. This manager owns the set:
 *
 *   - Lifecycle per session: start / pause / resume / stop.
 *     Pause disconnects the transport but keeps the wrapper
 *     (its checkpoint survives — v3 checkpoints on disconnect);
 *     resume reconnects with the same config. Stop removes the
 *     session from the set.
 *   - Concurrency cap: at most `maxConcurrentSessions` active
 *     sessions (default 3). Starting past the cap is refused
 *     with the ids that are active — the caller decides what to
 *     stop, the manager never kills a call silently.
 *   - Session log: every lifecycle event + reconnect attempt is
 *     appended to a log store (memory in tests, JSON-lines file
 *     in the app) so a dropped call can be explained afterwards.
 *   - Reconnect after a drop: when a session's transport dies
 *     unexpectedly, the manager redials it with backoff + jitter
 *     (the shared `Backoff` from transport health), up to
 *     `maxReconnectAttempts` per drop. A planned pause/stop never
 *     triggers a reconnect.
 *
 * The manager never dials a live provider itself: sessions come
 * from the injected `sessionFactory` (mock by default — see
 * `createMockVoiceSessionV4`). Live transports arrive the same
 * way v3 gets them, through the factory the host passes in.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Backoff } from './transportHealth';
import type { VoiceLatencyMode } from './latencyPipeline';
import {
  createMockVoiceSessionV4,
  VoiceSessionV4,
  type VoiceSessionV4Event,
} from './voiceSessionV4';

/** Lifecycle state of one managed session. */
export type ManagedVoiceSessionStatus =
  | 'active'
  | 'paused'
  | 'reconnecting'
  | 'stopped'
  | 'error';

/** One session-log line (what happened, when, to which call). */
export type VoiceSessionLogKind =
  | 'start'
  | 'pause'
  | 'resume'
  | 'stop'
  | 'reconnect'
  | 'reconnect-failed'
  | 'mode'
  | 'error';

export interface VoiceSessionLogEntry {
  seq: number;
  sessionId: string;
  kind: VoiceSessionLogKind;
  at: number;
  detail: string;
}

/** Store for the session log (memory or file). */
export interface VoiceSessionLogStore {
  append(entry: VoiceSessionLogEntry): void;
  list(sessionId?: string): VoiceSessionLogEntry[];
  clear(): void;
}

/** In-memory log store (tests + fallback). */
export class MemoryVoiceSessionLogStore implements VoiceSessionLogStore {
  private readonly entries: VoiceSessionLogEntry[] = [];
  private readonly maxEntries: number;

  constructor(maxEntries = 1000) {
    this.maxEntries = Math.max(1, Math.floor(maxEntries));
  }

  append(entry: VoiceSessionLogEntry): void {
    this.entries.push({ ...entry });
    while (this.entries.length > this.maxEntries) this.entries.shift();
  }

  list(sessionId?: string): VoiceSessionLogEntry[] {
    const all = this.entries.map((e) => ({ ...e }));
    return sessionId ? all.filter((e) => e.sessionId === sessionId) : all;
  }

  clear(): void {
    this.entries.length = 0;
  }
}

/** Default directory for the file-backed session log. */
export function defaultVoiceSessionLogDir(): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? '.';
  return path.join(home, '.open-bot', 'voice-sessions-v4');
}

/** File-backed log store: one JSON-lines file, appended per entry. */
export class FileVoiceSessionLogStore implements VoiceSessionLogStore {
  private readonly filePath: string;
  private readonly maxEntries: number;

  constructor(dir?: string, maxEntries = 1000) {
    this.filePath = path.join(dir ?? defaultVoiceSessionLogDir(), 'session-log.jsonl');
    this.maxEntries = Math.max(1, Math.floor(maxEntries));
  }

  getFilePath(): string {
    return this.filePath;
  }

  append(entry: VoiceSessionLogEntry): void {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      const line = `${JSON.stringify(entry)}\n`;
      const existing = this.readAll();
      if (existing.length >= this.maxEntries) {
        // Rewrite trimmed instead of growing forever.
        const kept = [...existing.slice(-(this.maxEntries - 1)), entry];
        fs.writeFileSync(this.filePath, kept.map((e) => `${JSON.stringify(e)}\n`).join(''), 'utf8');
      } else {
        fs.appendFileSync(this.filePath, line, 'utf8');
      }
    } catch {
      // The log must never break a call: a failed append is lost,
      // the session keeps running.
    }
  }

  list(sessionId?: string): VoiceSessionLogEntry[] {
    const all = this.readAll();
    return sessionId ? all.filter((e) => e.sessionId === sessionId) : all;
  }

  clear(): void {
    try {
      fs.writeFileSync(this.filePath, '', 'utf8');
    } catch {
      // Best-effort.
    }
  }

  private readAll(): VoiceSessionLogEntry[] {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8');
      const out: VoiceSessionLogEntry[] = [];
      for (const line of raw.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const parsed = JSON.parse(trimmed) as VoiceSessionLogEntry;
          if (parsed && typeof parsed.seq === 'number' && typeof parsed.sessionId === 'string') {
            out.push(parsed);
          }
        } catch {
          // One corrupt line does not kill the whole log.
        }
      }
      return out;
    } catch {
      return [];
    }
  }
}

/** What the manager needs from a session (the v4 wrapper fits). */
export interface ManagedVoiceSession {
  getSessionId(): string;
  isConnected(): boolean;
  connect(config: { instructions?: string }): Promise<void>;
  disconnect(): void;
  dispose(): void;
}

export interface VoiceSessionManagerV2Options {
  /** Max simultaneously active sessions. Default 3. */
  maxConcurrentSessions?: number;
  /** How a session is built (mock by default). Receives the
   *  start config (latency mode, instructions) so the factory can
   *  honour it. */
  sessionFactory?: (
    sessionId: string,
    config?: { latencyMode?: VoiceLatencyMode; instructions?: string },
  ) => ManagedVoiceSession;
  /** Where lifecycle events are logged. Default in-memory. */
  logStore?: VoiceSessionLogStore;
  /** Reconnect attempts per drop. Default 3. */
  maxReconnectAttempts?: number;
  /** Base reconnect delay (ms). Default 500. */
  reconnectBaseDelayMs?: number;
  /** Max reconnect delay (ms). Default 5000. */
  reconnectMaxDelayMs?: number;
  /** Sleep between reconnect attempts (injectable in tests). */
  sleep?: (ms: number) => Promise<void>;
  /** Inject the clock (tests). Defaults to `Date.now`. */
  clock?: () => number;
  /** Event sink (manager events). */
  onEvent?: (event: VoiceSessionManagerEvent) => void;
}

export interface VoiceSessionManagerEvent {
  kind: 'session-started' | 'session-paused' | 'session-resumed' | 'session-stopped' | 'session-reconnecting' | 'session-error';
  sessionId: string;
  detail: string;
  at: number;
}

/** One managed session + its bookkeeping. */
export interface ManagedVoiceSessionRecord {
  id: string;
  session: ManagedVoiceSession;
  status: ManagedVoiceSessionStatus;
  config: { instructions?: string };
  startedAt: number;
  reconnectAttempts: number;
  lastError: string;
}

/** Manager stats, as the panel / tools render them. */
export interface VoiceSessionManagerStats {
  active: number;
  paused: number;
  reconnecting: number;
  total: number;
  maxConcurrentSessions: number;
  logEntries: number;
  sessions: Array<{ id: string; status: ManagedVoiceSessionStatus; startedAt: number; reconnectAttempts: number }>;
}

/** Default max simultaneously active voice sessions. */
export const VOICE_MANAGER_DEFAULT_MAX_CONCURRENT = 3;
/** Default reconnect attempts per unexpected drop. */
export const VOICE_MANAGER_DEFAULT_MAX_RECONNECTS = 3;

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export class VoiceSessionManagerV2 {
  private readonly maxConcurrentSessions: number;
  private readonly sessionFactory: (
    sessionId: string,
    config?: { latencyMode?: VoiceLatencyMode; instructions?: string },
  ) => ManagedVoiceSession;
  private readonly logStore: VoiceSessionLogStore;
  private readonly maxReconnectAttempts: number;
  private readonly reconnectBaseDelayMs: number;
  private readonly reconnectMaxDelayMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly clock: () => number;
  private readonly onEvent: VoiceSessionManagerV2Options['onEvent'];
  private readonly sessions = new Map<string, ManagedVoiceSessionRecord>();
  private logSeq = 0;

  constructor(options: VoiceSessionManagerV2Options = {}) {
    this.maxConcurrentSessions = Math.max(1, options.maxConcurrentSessions ?? VOICE_MANAGER_DEFAULT_MAX_CONCURRENT);
    this.sessionFactory =
      options.sessionFactory ??
      ((id, cfg) =>
        createMockVoiceSessionV4({
          sessionId: id,
          latencyMode: cfg?.latencyMode,
          clock: options.clock,
        }) as unknown as ManagedVoiceSession);
    this.logStore = options.logStore ?? new MemoryVoiceSessionLogStore();
    this.maxReconnectAttempts = Math.max(0, options.maxReconnectAttempts ?? VOICE_MANAGER_DEFAULT_MAX_RECONNECTS);
    this.reconnectBaseDelayMs = Math.max(1, options.reconnectBaseDelayMs ?? 500);
    this.reconnectMaxDelayMs = Math.max(this.reconnectBaseDelayMs, options.reconnectMaxDelayMs ?? 5000);
    this.sleep = options.sleep ?? defaultSleep;
    this.clock = options.clock ?? Date.now;
    this.onEvent = options.onEvent;
  }

  /** Active session count (paused sessions do not count). */
  getActiveCount(): number {
    let n = 0;
    for (const rec of this.sessions.values()) {
      if (rec.status === 'active' || rec.status === 'reconnecting') n += 1;
    }
    return n;
  }

  getMaxConcurrentSessions(): number {
    return this.maxConcurrentSessions;
  }

  listSessionIds(): string[] {
    return [...this.sessions.keys()];
  }

  getSession(id: string): ManagedVoiceSessionRecord | null {
    const rec = this.sessions.get(id);
    return rec ?? null;
  }

  /**
   * Start a session: build it, connect it (mock transport by
   * default), log it. Refused when the id already exists or the
   * concurrency cap is hit — the refusal names the active ids.
   */
  async startSession(
    id: string,
    config: { instructions?: string; latencyMode?: VoiceLatencyMode } = {},
  ): Promise<{ ok: boolean; session?: ManagedVoiceSession; reason?: string }> {
    const cleanId = id.trim();
    if (!cleanId) return { ok: false, reason: 'Session id must not be empty.' };
    if (this.sessions.has(cleanId)) {
      return { ok: false, reason: `Session "${cleanId}" already exists.` };
    }
    if (this.getActiveCount() >= this.maxConcurrentSessions) {
      const active = [...this.sessions.values()]
        .filter((r) => r.status === 'active' || r.status === 'reconnecting')
        .map((r) => r.id);
      return {
        ok: false,
        reason: `Concurrency cap reached (${this.maxConcurrentSessions} active: ${active.join(', ')}). Stop one first.`,
      };
    }
    const session = this.sessionFactory(cleanId, {
      latencyMode: config.latencyMode,
      instructions: config.instructions,
    });
    const record: ManagedVoiceSessionRecord = {
      id: cleanId,
      session,
      status: 'active',
      config: { instructions: config.instructions },
      startedAt: this.clock(),
      reconnectAttempts: 0,
      lastError: '',
    };
    this.sessions.set(cleanId, record);
    try {
      await session.connect({ instructions: config.instructions });
    } catch (err) {
      record.status = 'error';
      record.lastError = err instanceof Error ? err.message : String(err);
      this.log(cleanId, 'error', `connect failed: ${record.lastError}`);
      this.emit('session-error', cleanId, record.lastError);
      return { ok: false, reason: `Could not connect session "${cleanId}": ${record.lastError}` };
    }
    this.log(cleanId, 'start', `provider session started (latency mode ${config.latencyMode ?? 'balanced'})`);
    this.emit('session-started', cleanId, 'started');
    return { ok: true, session };
  }

  /**
   * Pause a session: disconnect the transport, keep the wrapper
   * (its checkpoint survives). A paused session frees a
   * concurrency slot. Returns false when the id is unknown.
   */
  pauseSession(id: string): boolean {
    const rec = this.sessions.get(id);
    if (!rec || rec.status !== 'active') return false;
    try {
      rec.session.disconnect();
    } catch (err) {
      rec.status = 'error';
      rec.lastError = err instanceof Error ? err.message : String(err);
      this.log(id, 'error', `pause failed: ${rec.lastError}`);
      return false;
    }
    rec.status = 'paused';
    this.log(id, 'pause', 'transport disconnected, wrapper kept');
    this.emit('session-paused', id, 'paused');
    return true;
  }

  /** Resume a paused session: reconnect with the same config. */
  async resumeSession(id: string): Promise<boolean> {
    const rec = this.sessions.get(id);
    if (!rec || rec.status !== 'paused') return false;
    if (this.getActiveCount() >= this.maxConcurrentSessions) return false;
    try {
      await rec.session.connect(rec.config);
    } catch (err) {
      rec.status = 'error';
      rec.lastError = err instanceof Error ? err.message : String(err);
      this.log(id, 'error', `resume failed: ${rec.lastError}`);
      this.emit('session-error', id, rec.lastError);
      return false;
    }
    rec.status = 'active';
    this.log(id, 'resume', 'reconnected with the same config');
    this.emit('session-resumed', id, 'resumed');
    return true;
  }

  /**
   * Switch a session's latency mode mid-call. Returns the mode
   * now in effect, or null when the session is unknown or does
   * not expose a mode switch.
   */
  setSessionLatencyMode(id: string, mode: VoiceLatencyMode): VoiceLatencyMode | null {
    const rec = this.sessions.get(id);
    if (!rec) return null;
    const session = rec.session as unknown as {
      setLatencyMode?: (mode: VoiceLatencyMode) => unknown;
      getLatencyMode?: () => VoiceLatencyMode;
    };
    if (typeof session.setLatencyMode !== 'function') return null;
    try {
      session.setLatencyMode(mode);
    } catch {
      return null;
    }
    const current =
      typeof session.getLatencyMode === 'function' ? session.getLatencyMode() : mode;
    this.log(id, 'mode', `latency mode switched to ${current}`);
    return current;
  }

  /** Stop a session: disconnect, dispose, remove from the set. */
  stopSession(id: string): boolean {    const rec = this.sessions.get(id);
    if (!rec) return false;
    try {
      rec.session.disconnect();
    } catch {
      // Best-effort — the session is being removed either way.
    }
    try {
      rec.session.dispose();
    } catch {
      // Best-effort.
    }
    this.sessions.delete(id);
    this.log(id, 'stop', 'session removed');
    this.emit('session-stopped', id, 'stopped');
    return true;
  }

  /**
   * Reconnect after an unexpected drop (mock transport in
   * tests): redial with backoff + jitter, up to
   * `maxReconnectAttempts`. A planned pause/stop never calls
   * this. Returns true when the session is live again.
   */
  async reconnectSession(id: string): Promise<boolean> {
    const rec = this.sessions.get(id);
    if (!rec || rec.status === 'stopped') return false;
    rec.status = 'reconnecting';
    const backoff = new Backoff({
      baseMs: this.reconnectBaseDelayMs,
      maxMs: this.reconnectMaxDelayMs,
      jitter: 0.2,
    });
    for (let attempt = 1; attempt <= this.maxReconnectAttempts; attempt += 1) {
      rec.reconnectAttempts = attempt;
      this.log(id, 'reconnect', `attempt ${attempt}/${this.maxReconnectAttempts}`);
      this.emit('session-reconnecting', id, `attempt ${attempt}/${this.maxReconnectAttempts}`);
      try {
        await rec.session.connect(rec.config);
        rec.status = 'active';
        this.log(id, 'resume', `reconnected on attempt ${attempt}`);
        this.emit('session-resumed', id, `reconnected on attempt ${attempt}`);
        return true;
      } catch (err) {
        rec.lastError = err instanceof Error ? err.message : String(err);
        if (attempt < this.maxReconnectAttempts) {
          await this.sleep(backoff.nextDelay());
        }
      }
    }
    rec.status = 'error';
    this.log(id, 'reconnect-failed', `gave up after ${this.maxReconnectAttempts} attempts: ${rec.lastError}`);
    this.emit('session-error', id, rec.lastError);
    return false;
  }

  /** Log entries, optionally for one session only. */
  getSessionLog(sessionId?: string): VoiceSessionLogEntry[] {
    return this.logStore.list(sessionId);
  }

  getStats(): VoiceSessionManagerStats {
    const sessions = [...this.sessions.values()].map((r) => ({
      id: r.id,
      status: r.status,
      startedAt: r.startedAt,
      reconnectAttempts: r.reconnectAttempts,
    }));
    return {
      active: sessions.filter((s) => s.status === 'active').length,
      paused: sessions.filter((s) => s.status === 'paused').length,
      reconnecting: sessions.filter((s) => s.status === 'reconnecting').length,
      total: sessions.length,
      maxConcurrentSessions: this.maxConcurrentSessions,
      logEntries: this.logStore.list().length,
      sessions,
    };
  }

  /** Stop every session (shutdown). */
  stopAll(): void {
    for (const id of [...this.sessions.keys()]) this.stopSession(id);
  }

  private log(sessionId: string, kind: VoiceSessionLogKind, detail: string): void {
    this.logSeq += 1;
    this.logStore.append({ seq: this.logSeq, sessionId, kind, at: this.clock(), detail });
  }

  private emit(kind: VoiceSessionManagerEvent['kind'], sessionId: string, detail: string): void {
    try {
      this.onEvent?.({ kind, sessionId, detail, at: this.clock() });
    } catch {
      // A throwing sink must not break the manager.
    }
  }
}

export type { VoiceSessionV4, VoiceSessionV4Event };

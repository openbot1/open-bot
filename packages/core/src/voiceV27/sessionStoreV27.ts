/**
 * Durable voice session state (voice v27).
 *
 * v26 sessions live in memory: a restart loses the floor, the
 * turn index, the persona and the interrupt count. v27 persists
 * every session as one JSON file (`<baseDir>/<sessionId>.json`)
 * and treats that file as the source of truth:
 *
 *   - save on every transition: open, pause, resume, interrupt,
 *     checkpoint, close — the file is rewritten atomically
 *     (write tmp + rename) so a crash mid-write never leaves a
 *     half-written record;
 *   - state confirmation: `requireState` / `transition` check
 *     the *saved* state before an operation runs, and refuse
 *     with the current state when the operation does not apply
 *     (no speaking on an ended session, no resuming a session
 *     that was never paused);
 *   - allowed transitions are an explicit table (idle ->
 *     listening -> thinking -> speaking -> listening ...,
 *     paused <-> listening, anything -> ended, ended is
 *     terminal);
 *   - crash recovery: a record whose `cleanClose` is false
 *     (the process died or the machine restarted before close)
 *     is detected by `recoverUnclean`, marked `recovered`, and
 *     parked in `paused` so the user can resume it instead of
 *     losing it;
 *   - verification + expiry: `verify` reports a missing or
 *     corrupt file per session; `purgeExpired` drops ended
 *     sessions older than the TTL.
 *
 * Memory-only mode (no baseDir) keeps the same API and the same
 * guards in-process — the tools use it when the host does not
 * wire a directory, and the tests use it for hermetic runs.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  VOICE_V27_MAX_CHECKPOINTS_DEFAULT,
  VOICE_V27_SESSION_TTL_DEFAULT_MS,
  VOICE_V27_STATE_TRANSITIONS,
  type VoiceV27DurableSession,
  type VoiceV27FloorHolder,
  type VoiceV27InterruptMode,
  type VoiceV27SessionState,
  type VoiceV27VadPreset,
} from './types';

export interface DurableSessionStoreV27Options {
  /** Directory holding `<sessionId>.json` files (null = memory-only). */
  baseDir: string | null;
  /** Drop ended sessions older than this (ms). */
  sessionTtlMs: number;
  /** Max checkpoints kept per session. */
  maxCheckpoints: number;
}

export function defaultDurableSessionStoreV27Options(): DurableSessionStoreV27Options {
  return {
    baseDir: null,
    sessionTtlMs: VOICE_V27_SESSION_TTL_DEFAULT_MS,
    maxCheckpoints: VOICE_V27_MAX_CHECKPOINTS_DEFAULT,
  };
}

export interface VoiceV27StateGuard {
  ok: boolean;
  current: VoiceV27SessionState | null;
  required: readonly VoiceV27SessionState[];
  operation: string;
  reason: string;
}

export interface VoiceV27StoreVerifyResult {
  sessionId: string;
  ok: boolean;
  exists: boolean;
  corrupt: boolean;
  issues: string[];
  state: VoiceV27SessionState | null;
}

export interface VoiceV27StoreStats {
  sessions: number;
  open: number;
  ended: number;
  paused: number;
  recovered: number;
  checkpoints: number;
  memoryOnly: boolean;
  baseDir: string | null;
}

function fileNameFor(sessionId: string): string {
  return `${sessionId}.json`;
}

function isSafeSessionId(sessionId: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(sessionId) && !sessionId.includes('..');
}

export function createDurableSessionStoreV27(
  opts: Partial<DurableSessionStoreV27Options> = {},
): DurableSessionStoreV27 {
  return new DurableSessionStoreV27(opts);
}

export class DurableSessionStoreV27 {
  private readonly baseDir: string | null;
  private readonly sessionTtlMs: number;
  private readonly maxCheckpoints: number;
  private readonly memory = new Map<string, VoiceV27DurableSession>();

  constructor(opts: Partial<DurableSessionStoreV27Options> = {}) {
    const defaults = defaultDurableSessionStoreV27Options();
    this.baseDir = opts.baseDir ?? defaults.baseDir;
    this.sessionTtlMs = opts.sessionTtlMs ?? defaults.sessionTtlMs;
    this.maxCheckpoints = opts.maxCheckpoints ?? defaults.maxCheckpoints;
    if (this.baseDir !== null) {
      fs.mkdirSync(this.baseDir, { recursive: true });
    }
  }

  memoryOnly(): boolean {
    return this.baseDir === null;
  }

  baseDirNow(): string | null {
    return this.baseDir;
  }

  newRecord(input: {
    sessionId: string;
    botId?: string | null;
    personaId?: string | null;
    vadPreset?: VoiceV27VadPreset;
    interruptMode?: VoiceV27InterruptMode;
    atMs: number;
  }): VoiceV27DurableSession {
    if (!isSafeSessionId(input.sessionId)) throw new Error(`Unsafe sessionId: "${input.sessionId}"`);
    return {
      sessionId: input.sessionId,
      botId: input.botId ?? null,
      personaId: input.personaId ?? null,
      state: 'idle',
      floor: 'none',
      turnIndex: 0,
      turns: 0,
      interrupts: 0,
      vadPreset: input.vadPreset ?? 'balanced',
      interruptMode: input.interruptMode ?? 'always',
      openedAtMs: input.atMs,
      updatedAtMs: input.atMs,
      closedAtMs: null,
      cleanClose: false,
      recovered: false,
      recoveredAtMs: null,
      checkpoints: [],
      notes: [],
    };
  }

  private filePath(sessionId: string): string | null {
    if (this.baseDir === null) return null;
    return path.join(this.baseDir, fileNameFor(sessionId));
  }

  private writeFile(record: VoiceV27DurableSession): void {
    const file = this.filePath(record.sessionId);
    if (file === null) return;
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
    fs.renameSync(tmp, file);
  }

  /** Save (insert or overwrite) a record; returns a copy. */
  save(record: VoiceV27DurableSession): VoiceV27DurableSession {
    if (!isSafeSessionId(record.sessionId)) throw new Error(`Unsafe sessionId: "${record.sessionId}"`);
    const copy: VoiceV27DurableSession = {
      ...record,
      checkpoints: record.checkpoints.map((c) => ({ ...c })),
      notes: [...record.notes],
    };
    this.memory.set(copy.sessionId, copy);
    this.writeFile(copy);
    return { ...copy, checkpoints: copy.checkpoints.map((c) => ({ ...c })), notes: [...copy.notes] };
  }

  /** Load a record (file first, memory fallback); null when missing/corrupt. */
  load(sessionId: string): VoiceV27DurableSession | null {
    if (!isSafeSessionId(sessionId)) return null;
    const file = this.filePath(sessionId);
    if (file !== null) {
      try {
        const raw = fs.readFileSync(file, 'utf8');
        const parsed = JSON.parse(raw) as VoiceV27DurableSession;
        if (typeof parsed !== 'object' || parsed === null || parsed.sessionId !== sessionId) return null;
        this.memory.set(sessionId, parsed);
        return { ...parsed, checkpoints: [...(parsed.checkpoints ?? [])], notes: [...(parsed.notes ?? [])] };
      } catch {
        return null;
      }
    }
    const found = this.memory.get(sessionId);
    return found === undefined
      ? null
      : { ...found, checkpoints: [...found.checkpoints], notes: [...found.notes] };
  }

  exists(sessionId: string): boolean {
    return this.load(sessionId) !== null;
  }

  remove(sessionId: string): boolean {
    if (!isSafeSessionId(sessionId)) return false;
    const had = this.memory.delete(sessionId);
    const file = this.filePath(sessionId);
    if (file !== null) {
      try {
        fs.unlinkSync(file);
        return true;
      } catch {
        return had;
      }
    }
    return had;
  }

  list(): VoiceV27DurableSession[] {
    const ids = new Set<string>(this.memory.keys());
    if (this.baseDir !== null) {
      try {
        for (const entry of fs.readdirSync(this.baseDir)) {
          if (entry.endsWith('.json')) ids.add(entry.slice(0, -'.json'.length));
        }
      } catch {
        // Unreadable directory: report what memory holds.
      }
    }
    const out: VoiceV27DurableSession[] = [];
    for (const id of [...ids].sort()) {
      const record = this.load(id);
      if (record !== null) out.push(record);
    }
    return out;
  }

  /**
   * State confirmation guard: check the *saved* state before an
   * operation runs. Returns ok=false (never throws) when the
   * session is missing or in the wrong state.
   */
  requireState(
    sessionId: string,
    allowed: readonly VoiceV27SessionState[],
    operation: string,
  ): VoiceV27StateGuard {
    const record = this.load(sessionId);
    if (record === null) {
      return { ok: false, current: null, required: allowed, operation, reason: `Unknown session: "${sessionId}"` };
    }
    if (!allowed.includes(record.state)) {
      return {
        ok: false,
        current: record.state,
        required: allowed,
        operation,
        reason: `Session "${sessionId}" is ${record.state}; "${operation}" needs ${allowed.join(' | ')}`,
      };
    }
    return { ok: true, current: record.state, required: allowed, operation, reason: '' };
  }

  /**
   * Move a session to a new state through the allowed-transition
   * table, saving immediately. Returns null on an illegal move.
   */
  transition(
    sessionId: string,
    to: VoiceV27SessionState,
    atMs: number,
    note?: string,
  ): VoiceV27DurableSession | null {
    const record = this.load(sessionId);
    if (record === null) return null;
    const allowed = VOICE_V27_STATE_TRANSITIONS[record.state];
    if (!allowed.includes(to)) return null;
    record.state = to;
    record.floor = to === 'listening' ? 'user' : to === 'speaking' ? 'agent' : to === 'ended' ? 'none' : record.floor;
    record.updatedAtMs = atMs;
    if (to === 'ended') {
      record.closedAtMs = atMs;
      record.cleanClose = true;
    }
    if (note !== undefined && note !== '') record.notes.push(note);
    return this.save(record);
  }

  /** Append a named checkpoint to a session (saved immediately). */
  checkpoint(sessionId: string, label: string, atMs: number): VoiceV27DurableSession | null {
    const record = this.load(sessionId);
    if (record === null) return null;
    if (typeof label !== 'string' || label === '') throw new Error('checkpoint label must be a non-empty string');
    record.checkpoints.push({ label, atMs });
    while (record.checkpoints.length > this.maxCheckpoints) record.checkpoints.shift();
    record.updatedAtMs = atMs;
    return this.save(record);
  }

  /** Verify one session: missing file, corrupt JSON, stale state. */
  verify(sessionId: string): VoiceV27StoreVerifyResult {
    const issues: string[] = [];
    const file = this.filePath(sessionId);
    let exists = false;
    let corrupt = false;
    if (file !== null) {
      try {
        const raw = fs.readFileSync(file, 'utf8');
        const parsed = JSON.parse(raw) as unknown;
        exists = true;
        if (typeof parsed !== 'object' || parsed === null || (parsed as { sessionId?: unknown }).sessionId !== sessionId) {
          corrupt = true;
          issues.push('file content does not match the session id');
        }
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          issues.push('no durable file for this session');
        } else {
          // The file exists but cannot be read / parsed.
          exists = true;
          corrupt = true;
          issues.push(`durable file is corrupt: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    } else {
      exists = this.memory.has(sessionId);
      if (!exists) issues.push('no record for this session (memory-only store)');
    }
    const record = corrupt ? null : this.load(sessionId);
    if (record !== null && record.state === 'ended' && record.cleanClose === false) {
      issues.push('session ended without a clean close');
    }
    return { sessionId, ok: issues.length === 0, exists, corrupt, issues, state: record?.state ?? null };
  }

  /**
   * Recover sessions left open by a crash/restart: mark them
   * `recovered`, park them in `paused` (never silently resume
   * speaking), save, and return them.
   */
  recoverUnclean(atMs: number): VoiceV27DurableSession[] {
    const recovered: VoiceV27DurableSession[] = [];
    for (const record of this.list()) {
      if (record.closedAtMs === null && record.cleanClose === false && record.state !== 'ended' && record.recovered === false) {
        record.recovered = true;
        record.recoveredAtMs = atMs;
        record.state = 'paused';
        record.floor = 'none';
        record.updatedAtMs = atMs;
        record.notes.push(`recovered after unclean shutdown at ${atMs}`);
        recovered.push(this.save(record));
      }
    }
    return recovered;
  }

  /** Drop ended sessions older than the TTL; returns dropped ids. */
  purgeExpired(atMs: number): string[] {
    const dropped: string[] = [];
    for (const record of this.list()) {
      if (record.state === 'ended' && record.closedAtMs !== null && atMs - record.closedAtMs > this.sessionTtlMs) {
        if (this.remove(record.sessionId)) dropped.push(record.sessionId);
      }
    }
    return dropped;
  }

  stats(): VoiceV27StoreStats {
    const all = this.list();
    return {
      sessions: all.length,
      open: all.filter((r) => r.closedAtMs === null).length,
      ended: all.filter((r) => r.state === 'ended').length,
      paused: all.filter((r) => r.state === 'paused').length,
      recovered: all.filter((r) => r.recovered).length,
      checkpoints: all.reduce((a, r) => a + r.checkpoints.length, 0),
      memoryOnly: this.memoryOnly(),
      baseDir: this.baseDir,
    };
  }

  markdown(): string {
    const s = this.stats();
    const lines = [
      '# Durable session state v27',
      '',
      `- Store: ${s.memoryOnly ? 'memory-only (no baseDir)' : s.baseDir}`,
      `- Sessions: ${s.sessions} (${s.open} open, ${s.ended} ended, ${s.paused} paused, ${s.recovered} recovered) · checkpoints: ${s.checkpoints}`,
      '',
      '| session | bot | persona | state | turns | interrupts | opened | closed | recovered |',
      '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ];
    for (const r of this.list()) {
      lines.push(`| ${r.sessionId} | ${r.botId ?? '-'} | ${r.personaId ?? '-'} | ${r.state} | ${r.turns} | ${r.interrupts} | ${r.openedAtMs} | ${r.closedAtMs ?? '-'} | ${r.recovered} |`);
    }
    return lines.join('\n');
  }
}

export type { VoiceV27DurableSession, VoiceV27FloorHolder, VoiceV27SessionState };

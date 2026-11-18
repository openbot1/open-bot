/**
 * Session persistence v20 (voice v20, v1.29 Team T5).
 *
 * Realtime v3 (v18) checkpointed in memory and the v20 session
 * manager kept checkpoints in a ring — but a crashed process
 * lost all of it: the transcript, the turn history, the cut
 * reply and its prosody plan. This module makes checkpoints
 * durable: a session can be saved to disk at every turn
 * boundary and cut, and a fresh process can load the latest
 * checkpoint and resume the conversation where it died.
 *
 *   1. Envelope. A persisted checkpoint is a versioned JSON
 *      envelope: session id, checkpoint number, virtual clock,
 *      the pipeline snapshot (phase, turns, committed
 *      transcript), the raw transcript segments, the prosody
 *      carry-over (last plan + spoken prefix + remaining text
 *      of a cut reply) and the resume action the user picked.
 *      Format version 1; a loader rejects newer versions
 *      instead of guessing.
 *   2. Integrity. The payload is checksummed with FNV-1a over
 *      a canonical (key-sorted) JSON string. A load that fails
 *      the checksum is reported as corrupt and never applied —
 *      a half-written file can never resurrect a wrong turn.
 *   3. Atomic writes. Saves go to a temp file in the same
 *      directory and are renamed into place, so a crash
 *      mid-save leaves either the old checkpoint or the new
 *      one, never a torn file.
 *   4. Retention. Bounded per session (`maxPerSession`,
 *      default 10) and per file (`maxBytes`, default 1 MiB):
 *      saving beyond the cap prunes the oldest checkpoint,
 *      and oversized payloads are refused with a plain error.
 *      Session ids are validated (`[A-Za-z0-9._-]+`) so a
 *      hostile id can never escape the store directory.
 *   5. Memory mode. With no base directory the store keeps
 *      checkpoints in a Map — same API, no disk — so tests and
 *      the mock pipeline can persist without touching fs.
 *
 * All clocks are virtual (`nowMs` passed in); nothing reads
 * Date.now(). No network, no key.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { PipelineV20Snapshot } from './pipelineV20';
import type { TtsV20ProsodyPlan } from './ttsProsodyV20';
import type { TurnResumeV19Action } from '../voiceV19/turnResumeV19';
import type { VoiceV20TranscriptSegment } from './types';

export const SESSION_PERSISTENCE_V20_FORMAT = 1;
export const SESSION_PERSISTENCE_V20_MAX_BYTES_DEFAULT = 1024 * 1024;

export interface PersistedSessionV20Checkpoint {
  formatVersion: number;
  sessionId: string;
  /** Monotonic checkpoint number for this session. */
  number: number;
  /** Virtual clock at checkpoint time. */
  atMs: number;
  /** Virtual clock at save time. */
  savedAtMs: number;
  /** FNV-1a checksum of the canonical payload JSON. */
  checksum: string;
  snapshot: PipelineV20Snapshot;
  /** Raw transcript segments (partial/final/corrected) at save time. */
  transcriptSegments: VoiceV20TranscriptSegment[];
  /** Prosody plan of the last spoken chunk (carry-over across a cut). */
  lastProsodyPlan?: TtsV20ProsodyPlan;
  /** Spoken prefix of the cut reply, if the checkpoint is a cut. */
  spokenPrefix?: string;
  /** Remaining reply text after the cut point. */
  remainingText?: string;
  /** Resume action the user picked for the cut reply, if any. */
  resumeAction?: TurnResumeV19Action;
}

export interface SessionPersistenceV20Options {
  /** Base directory for checkpoint files. Undefined = memory-only. */
  baseDir?: string;
  /** Max checkpoints kept per session (default 10). */
  maxPerSession: number;
  /** Max bytes per checkpoint file (default 1 MiB). */
  maxBytes: number;
}

export function defaultSessionPersistenceV20Options(): SessionPersistenceV20Options {
  return { baseDir: undefined, maxPerSession: 10, maxBytes: SESSION_PERSISTENCE_V20_MAX_BYTES_DEFAULT };
}

export function validateSessionPersistenceV20Options(o: Partial<SessionPersistenceV20Options>): string[] {
  const e: string[] = [];
  if (o.maxPerSession !== undefined && o.maxPerSession < 1) e.push('maxPerSession must be >= 1');
  if (o.maxBytes !== undefined && o.maxBytes < 1024) e.push('maxBytes must be >= 1024');
  if (o.baseDir !== undefined && o.baseDir.trim() === '') e.push('baseDir must not be empty');
  return e;
}

export function isSafeSessionIdV20(sessionId: string): boolean {
  return /^[A-Za-z0-9._-]{1,128}$/.test(sessionId) && sessionId !== '.' && sessionId !== '..';
}

/** Canonical JSON: object keys sorted recursively, so checksums are stable. */
export function stableStringifyV20(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((v) => stableStringifyV20(v)).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const parts = keys.map((k) => `${JSON.stringify(k)}:${stableStringifyV20(obj[k])}`);
  return `{${parts.join(',')}}`;
}

/** FNV-1a 32-bit hash, hex-encoded. */
export function fnv1aV20(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export function checkpointChecksumV20(
  payload: Omit<PersistedSessionV20Checkpoint, 'checksum'>,
): string {
  return fnv1aV20(stableStringifyV20(payload));
}

/** Build a checksummed envelope from a checkpoint payload. */
export function sealCheckpointV20(
  payload: Omit<PersistedSessionV20Checkpoint, 'checksum' | 'formatVersion' | 'savedAtMs'> & { formatVersion?: number; savedAtMs?: number },
): PersistedSessionV20Checkpoint {
  // savedAtMs is required by parse, so a directly-sealed envelope must
  // carry one: default to the checkpoint's own virtual clock (atMs).
  // Before, seal left it out and parse rejected the envelope it had
  // just sealed (seal/parse asymmetry).
  const withVersion = { formatVersion: SESSION_PERSISTENCE_V20_FORMAT, savedAtMs: payload.atMs, ...payload };
  return { ...withVersion, checksum: checkpointChecksumV20(withVersion) };
}

export interface CheckpointParseV20Result {
  ok: boolean;
  checkpoint?: PersistedSessionV20Checkpoint;
  errors: string[];
}

/** Parse + validate a stored checkpoint (version + checksum + shape). */
export function parseCheckpointV20(jsonText: string): CheckpointParseV20Result {
  let raw: unknown;
  try {
    raw = JSON.parse(jsonText) as unknown;
  } catch {
    return { ok: false, errors: ['not valid JSON'] };
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, errors: ['checkpoint must be a JSON object'] };
  }
  const obj = raw as Record<string, unknown>;
  const errors: string[] = [];
  if (obj.formatVersion !== SESSION_PERSISTENCE_V20_FORMAT) {
    errors.push(`unsupported formatVersion ${String(obj.formatVersion)} (expected ${SESSION_PERSISTENCE_V20_FORMAT})`);
  }
  if (typeof obj.sessionId !== 'string' || !isSafeSessionIdV20(obj.sessionId)) {
    errors.push('sessionId is missing or unsafe');
  }
  if (typeof obj.number !== 'number' || obj.number < 0 || !Number.isInteger(obj.number)) {
    errors.push('number must be a non-negative integer');
  }
  if (typeof obj.atMs !== 'number' || obj.atMs < 0) errors.push('atMs must be >= 0');
  if (typeof obj.savedAtMs !== 'number' || obj.savedAtMs < 0) errors.push('savedAtMs must be >= 0');
  if (typeof obj.checksum !== 'string' || obj.checksum === '') errors.push('checksum is missing');
  if (typeof obj.snapshot !== 'object' || obj.snapshot === null) errors.push('snapshot is missing');
  if (!Array.isArray(obj.transcriptSegments)) errors.push('transcriptSegments must be an array');
  if (errors.length > 0) return { ok: false, errors };
  const { checksum, ...payload } = obj as unknown as PersistedSessionV20Checkpoint & Record<string, unknown>;
  const expect = checkpointChecksumV20(payload as Omit<PersistedSessionV20Checkpoint, 'checksum'>);
  if (checksum !== expect) {
    return { ok: false, errors: [`checksum mismatch (stored ${checksum}, computed ${expect})`] };
  }
  return { ok: true, checkpoint: obj as unknown as PersistedSessionV20Checkpoint, errors: [] };
}

export interface SessionPersistenceV20Entry {
  sessionId: string;
  number: number;
  atMs: number;
  savedAtMs: number;
  bytes: number;
}

export interface SessionPersistenceV20Stats {
  sessions: number;
  checkpoints: number;
  saves: number;
  loads: number;
  corruptLoads: number;
  pruned: number;
  bytesWritten: number;
}

function checkpointFileNameV20(sessionId: string, number: number): string {
  return `${sessionId}.${String(number).padStart(6, '0')}.json`;
}

function parseCheckpointNumberV20(fileName: string, sessionId: string): number | null {
  const prefix = `${sessionId}.`;
  if (!fileName.startsWith(prefix) || !fileName.endsWith('.json')) return null;
  const num = Number(fileName.slice(prefix.length, -'.json'.length));
  return Number.isInteger(num) && num >= 0 ? num : null;
}

/** Durable (or in-memory) checkpoint store for voice v20 sessions. */
export class SessionPersistenceStoreV20 {
  private opts: SessionPersistenceV20Options;
  private memory = new Map<string, Map<number, string>>();
  private stats: SessionPersistenceV20Stats = {
    sessions: 0, checkpoints: 0, saves: 0, loads: 0, corruptLoads: 0, pruned: 0, bytesWritten: 0,
  };

  constructor(opts: Partial<SessionPersistenceV20Options> = {}) {
    const errors = validateSessionPersistenceV20Options(opts);
    if (errors.length > 0) throw new Error(`Invalid SessionPersistenceV20 options: ${errors.join('; ')}`);
    this.opts = { ...defaultSessionPersistenceV20Options(), ...opts };
    if (this.opts.baseDir) fs.mkdirSync(this.opts.baseDir, { recursive: true });
  }

  get options(): SessionPersistenceV20Options { return { ...this.opts }; }
  getStats(): SessionPersistenceV20Stats { return { ...this.stats }; }

  private dirFor(sessionId: string): string {
    return path.join(this.opts.baseDir as string, sessionId);
  }

  private listNumbers(sessionId: string): number[] {
    if (!this.opts.baseDir) {
      const m = this.memory.get(sessionId);
      return m ? [...m.keys()].sort((a, b) => a - b) : [];
    }
    const dir = this.dirFor(sessionId);
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
      .map((f) => parseCheckpointNumberV20(f, sessionId))
      .filter((n): n is number => n !== null)
      .sort((a, b) => a - b);
  }

  private readRaw(sessionId: string, number: number): string | null {
    if (!this.opts.baseDir) return this.memory.get(sessionId)?.get(number) ?? null;
    const file = path.join(this.dirFor(sessionId), checkpointFileNameV20(sessionId, number));
    if (!fs.existsSync(file)) return null;
    return fs.readFileSync(file, 'utf-8');
  }

  private writeRaw(sessionId: string, number: number, text: string): void {
    if (!this.opts.baseDir) {
      let m = this.memory.get(sessionId);
      if (!m) {
        m = new Map();
        this.memory.set(sessionId, m);
      }
      m.set(number, text);
      return;
    }
    const dir = this.dirFor(sessionId);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = path.join(dir, `.tmp-${process.pid}-${number}.json`);
    const file = path.join(dir, checkpointFileNameV20(sessionId, number));
    fs.writeFileSync(tmp, text, 'utf-8');
    fs.renameSync(tmp, file);
  }

  private removeRaw(sessionId: string, number: number): boolean {
    if (!this.opts.baseDir) {
      const m = this.memory.get(sessionId);
      if (!m) return false;
      return m.delete(number);
    }
    const file = path.join(this.dirFor(sessionId), checkpointFileNameV20(sessionId, number));
    if (!fs.existsSync(file)) return false;
    fs.unlinkSync(file);
    return true;
  }

  /** Save a checkpoint (seals + checksums + enforces retention). */
  save(
    payload: Omit<PersistedSessionV20Checkpoint, 'checksum' | 'formatVersion' | 'savedAtMs'> & { savedAtMs?: number },
    nowMs: number,
  ): { ok: boolean; checkpoint?: PersistedSessionV20Checkpoint; bytes?: number; error?: string } {
    if (!isSafeSessionIdV20(payload.sessionId)) {
      return { ok: false, error: `unsafe sessionId "${payload.sessionId}"` };
    }
    const sealed = sealCheckpointV20({ ...payload, savedAtMs: payload.savedAtMs ?? nowMs });
    const text = JSON.stringify(sealed, null, 2);
    if (Buffer.byteLength(text, 'utf-8') > this.opts.maxBytes) {
      return { ok: false, error: `checkpoint ${Buffer.byteLength(text, 'utf-8')} bytes exceeds maxBytes ${this.opts.maxBytes}` };
    }
    this.writeRaw(payload.sessionId, payload.number, text);
    this.stats.saves += 1;
    this.stats.bytesWritten += Buffer.byteLength(text, 'utf-8');
    this.prune(payload.sessionId, nowMs);
    this.refreshCounts();
    return { ok: true, checkpoint: sealed, bytes: Buffer.byteLength(text, 'utf-8') };
  }

  /** Load one checkpoint by number (validates version + checksum). */
  load(sessionId: string, number: number): CheckpointParseV20Result & { corrupt?: boolean } {
    if (!isSafeSessionIdV20(sessionId)) return { ok: false, errors: [`unsafe sessionId "${sessionId}"`] };
    const raw = this.readRaw(sessionId, number);
    this.stats.loads += 1;
    if (raw === null) return { ok: false, errors: [`no checkpoint #${number} for session "${sessionId}"`] };
    const parsed = parseCheckpointV20(raw);
    if (!parsed.ok) {
      this.stats.corruptLoads += 1;
      return { ...parsed, corrupt: true };
    }
    return parsed;
  }

  /** Load the latest checkpoint for a session (highest number). */
  loadLatest(sessionId: string): CheckpointParseV20Result & { corrupt?: boolean } {
    const numbers = this.listNumbers(sessionId);
    if (numbers.length === 0) return { ok: false, errors: [`no checkpoints for session "${sessionId}"`] };
    return this.load(sessionId, numbers[numbers.length - 1]!);
  }

  /** List checkpoint entries for a session, oldest first. */
  list(sessionId: string): SessionPersistenceV20Entry[] {
    if (!isSafeSessionIdV20(sessionId)) return [];
    return this.listNumbers(sessionId).map((number) => {
      const raw = this.readRaw(sessionId, number) ?? '';
      let atMs = 0;
      let savedAtMs = 0;
      try {
        const obj = JSON.parse(raw) as { atMs?: number; savedAtMs?: number };
        atMs = obj.atMs ?? 0;
        savedAtMs = obj.savedAtMs ?? 0;
      } catch {
        atMs = 0;
        savedAtMs = 0;
      }
      return { sessionId, number, atMs, savedAtMs, bytes: Buffer.byteLength(raw, 'utf-8') };
    });
  }

  /** Delete one checkpoint. Returns true when something was removed. */
  delete(sessionId: string, number: number): boolean {
    if (!isSafeSessionIdV20(sessionId)) return false;
    const removed = this.removeRaw(sessionId, number);
    if (removed) this.refreshCounts();
    return removed;
  }

  /** Delete every checkpoint of a session. Returns the count removed. */
  deleteSession(sessionId: string): number {
    if (!isSafeSessionIdV20(sessionId)) return 0;
    const numbers = this.listNumbers(sessionId);
    let removed = 0;
    for (const n of numbers) if (this.removeRaw(sessionId, n)) removed += 1;
    if (!this.opts.baseDir) this.memory.delete(sessionId);
    else {
      const dir = this.dirFor(sessionId);
      try {
        if (fs.existsSync(dir) && fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
      } catch {
        // Non-empty or already gone — not fatal.
      }
    }
    this.refreshCounts();
    return removed;
  }

  /** Prune checkpoints beyond maxPerSession (oldest first). */
  prune(sessionId: string, _nowMs: number): number {
    const numbers = this.listNumbers(sessionId);
    const excess = numbers.length - this.opts.maxPerSession;
    if (excess <= 0) return 0;
    let pruned = 0;
    for (const n of numbers.slice(0, excess)) {
      if (this.removeRaw(sessionId, n)) pruned += 1;
    }
    this.stats.pruned += pruned;
    this.refreshCounts();
    return pruned;
  }

  /** Session ids the store currently knows about. */
  listSessions(): string[] {
    if (!this.opts.baseDir) return [...this.memory.keys()].sort();
    if (!fs.existsSync(this.opts.baseDir)) return [];
    return fs.readdirSync(this.opts.baseDir)
      .filter((name) => {
        try {
          return fs.statSync(path.join(this.opts.baseDir as string, name)).isDirectory();
        } catch {
          return false;
        }
      })
      .sort();
  }

  private refreshCounts(): void {
    const sessions = this.listSessions();
    let checkpoints = 0;
    for (const s of sessions) checkpoints += this.listNumbers(s).length;
    this.stats.sessions = sessions.length;
    this.stats.checkpoints = checkpoints;
  }

  summary(): string {
    const s = this.stats;
    return `Session persistence v20: ${s.sessions} sessions, ${s.checkpoints} checkpoints, ` +
      `${s.saves} saves, ${s.loads} loads (${s.corruptLoads} corrupt), ${s.pruned} pruned, ` +
      `${s.bytesWritten} bytes written${this.opts.baseDir ? ` — disk: ${this.opts.baseDir}` : ' — memory-only'}`;
  }
}

export function createSessionPersistenceStoreV20(
  opts: Partial<SessionPersistenceV20Options> = {},
): SessionPersistenceStoreV20 {
  return new SessionPersistenceStoreV20(opts);
}

export function sessionPersistenceV20Markdown(store: SessionPersistenceStoreV20): string {
  const s = store.getStats();
  const lines = [
    '# Session persistence v20', '',
    `- Sessions: ${s.sessions}`,
    `- Checkpoints: ${s.checkpoints}`,
    `- Saves: ${s.saves}`,
    `- Loads: ${s.loads} (corrupt: ${s.corruptLoads})`,
    `- Pruned: ${s.pruned}`,
    `- Bytes written: ${s.bytesWritten}`,
    `- Mode: ${store.options.baseDir ? `disk (${store.options.baseDir})` : 'memory-only'}`,
    '',
  ];
  for (const sessionId of store.listSessions()) {
    lines.push(`## ${sessionId}`, '');
    for (const e of store.list(sessionId)) {
      lines.push(`- #${e.number} at ${e.atMs}ms (saved ${e.savedAtMs}ms, ${e.bytes} bytes)`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

/** Build a persistable payload from a live pipeline snapshot. */
export function payloadFromSnapshotV20(args: {
  sessionId: string;
  number: number;
  atMs: number;
  snapshot: PipelineV20Snapshot;
  transcriptSegments?: VoiceV20TranscriptSegment[];
  lastProsodyPlan?: TtsV20ProsodyPlan;
  spokenPrefix?: string;
  remainingText?: string;
  resumeAction?: TurnResumeV19Action;
}): Omit<PersistedSessionV20Checkpoint, 'checksum' | 'formatVersion' | 'savedAtMs'> {
  return {
    sessionId: args.sessionId,
    number: args.number,
    atMs: args.atMs,
    snapshot: args.snapshot,
    transcriptSegments: args.transcriptSegments ?? [],
    ...(args.lastProsodyPlan ? { lastProsodyPlan: args.lastProsodyPlan } : {}),
    ...(args.spokenPrefix !== undefined ? { spokenPrefix: args.spokenPrefix } : {}),
    ...(args.remainingText !== undefined ? { remainingText: args.remainingText } : {}),
    ...(args.resumeAction ? { resumeAction: args.resumeAction } : {}),
  };
}

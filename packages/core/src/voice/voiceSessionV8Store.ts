/**
 * Durable voice session store v8 (v1.09, Đội T5 — voice realtime v8).
 *
 * v7 has a snapshot store, but a resume after a dropped call needs
 * more than "the last checkpoint": it needs to know *where the
 * reply stopped* (which word, how many ms of audio were played),
 * which voice the user picked mid-call, and whether the snapshot
 * on disk is even intact. v8 is the durable layer for that:
 *
 *   - Versioned snapshot schema (`voice-session-v8/1`): session
 *     id, provider, voice, VAD preset + engine, barge-in
 *     sensitivity, PTT/auto mode, turn history (capped), the
 *     interrupted reply's cut point (word index + audio offset
 *     ms + remaining text), reconnect budget state, and the
 *     wall-clock timestamps that bound the session.
 *   - Atomic writes: write to `<id>.json.tmp` + `fsync` + rename,
 *     so a crash mid-write never leaves a half-written snapshot
 *     behind; a torn write is detected by the checksum and the
 *     previous good snapshot survives.
 *   - Checksum + validation: every snapshot carries a checksum
 *     over its payload; `load` refuses corrupt or future-version
 *     snapshots and reports *why* (corrupt / version / schema),
 *     instead of restoring garbage into a live call.
 *   - Corruption quarantine: a bad file is moved to
 *     `<id>.corrupt-<timestamp>.json` (never deleted silently),
 *     so the user can inspect it and the next save starts clean.
 *   - Compaction + prune: history is capped (default 50 turns),
 *     old snapshots are pruned by age (default 7 days), and
 *     `list` reports sizes so the panel can show disk usage.
 *   - Resume instructions: `buildResumeInstructions` turns a
 *     snapshot back into model instructions — base instructions
 *     plus the recent turns plus the cut reply ("you were cut off
 *     after saying X; the rest was Y"), so the model picks up
 *     where the call left off instead of starting cold.
 *
 * Pure file I/O, no network, no provider. The session owns the
 * *decision* to save (on turn end, on interrupt, on disconnect);
 * the store owns the bytes.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';

/** Current snapshot schema version. */
export const VOICE_SESSION_V8_STORE_VERSION = 1;
/** Snapshot file suffix. */
export const VOICE_SESSION_V8_SNAPSHOT_EXT = '.voice-v8.json';
/** Max turns kept per snapshot. */
export const VOICE_SESSION_V8_DEFAULT_MAX_TURNS = 50;
/** Max transcript chars kept per turn. */
export const VOICE_SESSION_V8_DEFAULT_MAX_TURN_CHARS = 4000;
/** Snapshots older than this are prunable (ms, default 7 days). */
export const VOICE_SESSION_V8_DEFAULT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** One turn in the saved history. */
export interface VoiceSessionV8Turn {
  speaker: 'user' | 'agent';
  text: string;
  /** ms since the session started (sample-derived clock of the session). */
  atMs: number;
  /** True when the agent line was cut by a barge-in. */
  interrupted?: boolean;
  /** Word index where the agent line was cut (interrupted lines only). */
  cutWordIndex?: number;
}

/** Where the reply stopped when the session was saved. */
export interface VoiceSessionV8CutPoint {
  /** Words already spoken. */
  wordsPlayed: number;
  /** Audio ms already played. */
  audioPlayedMs: number;
  /** Text already spoken. */
  spokenText: string;
  /** Text queued but never spoken. */
  remainingText: string;
  /** Word index of the cut. */
  cutWordIndex: number;
}

/** The durable snapshot (what is written to disk, minus the envelope). */
export interface VoiceSessionV8Snapshot {
  schema: 'voice-session-v8/1';
  version: 1;
  sessionId: string;
  provider: string;
  voiceId: string | null;
  voiceName: string | null;
  vadPreset: string;
  vadEngine: string;
  bargeInSensitivity: number;
  inputMode: 'auto' | 'push-to-talk';
  createdAtMs: number;
  updatedAtMs: number;
  /** ms the session had been alive when saved. */
  durationMs: number;
  /** Turns, oldest first, capped. */
  turns: VoiceSessionV8Turn[];
  /** Cut point of the interrupted reply (null when the reply finished). */
  cutPoint: VoiceSessionV8CutPoint | null;
  /** Reconnect attempts spent on the current drop. */
  reconnectAttempts: number;
  /** Total reconnects over the session. */
  reconnects: number;
  /** Total downtime (ms) over the session. */
  totalDowntimeMs: number;
  /** True when the snapshot was written at a clean disconnect. */
  cleanShutdown: boolean;
}

/** Envelope on disk: payload + checksum. */
export interface VoiceSessionV8Envelope {
  checksum: string;
  snapshot: VoiceSessionV8Snapshot;
}

/** Why a snapshot could not be loaded. */
export type VoiceSessionV8LoadError =
  | 'missing'
  | 'corrupt-json'
  | 'checksum-mismatch'
  | 'bad-schema'
  | 'unsupported-version'
  | 'io-error';

/** Result of a load. */
export type VoiceSessionV8LoadResult =
  | { ok: true; snapshot: VoiceSessionV8Snapshot; path: string }
  | { ok: false; error: VoiceSessionV8LoadError; detail: string; path: string };

/** Result of a save. */
export interface VoiceSessionV8SaveResult {
  ok: boolean;
  path: string;
  bytes: number;
  turns: number;
  error?: string;
}

/** Store options. */
export interface VoiceSessionV8StoreOptions {
  /** Directory holding the snapshots. Created on demand. */
  dir: string;
  maxTurns?: number;
  maxTurnChars?: number;
  maxAgeMs?: number;
  /** Clock (tests). Defaults to Date.now. */
  clock?: () => number;
}

export function voiceSessionV8SnapshotPath(dir: string, sessionId: string): string {
  return path.join(dir, `${sessionId}${VOICE_SESSION_V8_SNAPSHOT_EXT}`);
}

function checksumOf(payload: string): string {
  return crypto.createHash('sha256').update(payload, 'utf8').digest('hex');
}

/** Build a fresh snapshot (no turns yet). */
export function createVoiceSessionV8Snapshot(input: {
  sessionId: string;
  provider: string;
  voiceId?: string | null;
  voiceName?: string | null;
  vadPreset?: string;
  vadEngine?: string;
  bargeInSensitivity?: number;
  inputMode?: 'auto' | 'push-to-talk';
  nowMs?: number;
}): VoiceSessionV8Snapshot {
  const now = input.nowMs ?? Date.now();
  return {
    schema: 'voice-session-v8/1',
    version: 1,
    sessionId: input.sessionId,
    provider: input.provider,
    voiceId: input.voiceId ?? null,
    voiceName: input.voiceName ?? null,
    vadPreset: input.vadPreset ?? 'office',
    vadEngine: input.vadEngine ?? 'auto',
    bargeInSensitivity: input.bargeInSensitivity ?? 0.5,
    inputMode: input.inputMode ?? 'auto',
    createdAtMs: now,
    updatedAtMs: now,
    durationMs: 0,
    turns: [],
    cutPoint: null,
    reconnectAttempts: 0,
    reconnects: 0,
    totalDowntimeMs: 0,
    cleanShutdown: false,
  };
}

/** Validate a parsed snapshot; returns problems (empty = valid). */
export function validateVoiceSessionV8Snapshot(value: unknown): string[] {
  const problems: string[] = [];
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return ['snapshot must be an object'];
  }
  const s = value as Record<string, unknown>;
  if (s['schema'] !== 'voice-session-v8/1') problems.push('schema must be "voice-session-v8/1"');
  if (s['version'] !== 1) problems.push('version must be 1');
  if (typeof s['sessionId'] !== 'string' || (s['sessionId'] as string).length === 0) {
    problems.push('sessionId must be a non-empty string');
  }
  if (typeof s['provider'] !== 'string' || (s['provider'] as string).length === 0) {
    problems.push('provider must be a non-empty string');
  }
  if (!Array.isArray(s['turns'])) {
    problems.push('turns must be an array');
  } else {
    for (let i = 0; i < (s['turns'] as unknown[]).length; i += 1) {
      const t = (s['turns'] as unknown[])[i] as Record<string, unknown>;
      if (!t || typeof t !== 'object') {
        problems.push(`turns[${i}] must be an object`);
        continue;
      }
      if (t['speaker'] !== 'user' && t['speaker'] !== 'agent') {
        problems.push(`turns[${i}].speaker must be "user" or "agent"`);
      }
      if (typeof t['text'] !== 'string') problems.push(`turns[${i}].text must be a string`);
      if (typeof t['atMs'] !== 'number' || !Number.isFinite(t['atMs'] as number)) {
        problems.push(`turns[${i}].atMs must be a finite number`);
      }
    }
  }
  if (s['cutPoint'] !== null && s['cutPoint'] !== undefined) {
    const c = s['cutPoint'] as Record<string, unknown>;
    if (typeof c !== 'object' || Array.isArray(c)) problems.push('cutPoint must be an object or null');
    else {
      for (const k of ['wordsPlayed', 'audioPlayedMs', 'cutWordIndex'] as const) {
        if (typeof c[k] !== 'number' || !Number.isFinite(c[k] as number)) {
          problems.push(`cutPoint.${k} must be a finite number`);
        }
      }
      if (typeof c['spokenText'] !== 'string') problems.push('cutPoint.spokenText must be a string');
      if (typeof c['remainingText'] !== 'string') problems.push('cutPoint.remainingText must be a string');
    }
  }
  for (const k of ['createdAtMs', 'updatedAtMs', 'durationMs'] as const) {
    if (typeof s[k] !== 'number' || !Number.isFinite(s[k] as number)) {
      problems.push(`${k} must be a finite number`);
    }
  }
  if (s['inputMode'] !== 'auto' && s['inputMode'] !== 'push-to-talk') {
    problems.push('inputMode must be "auto" or "push-to-talk"');
  }
  return problems;
}

/** Cap + truncate turns for storage. */
export function capVoiceSessionV8Turns(
  turns: VoiceSessionV8Turn[],
  maxTurns: number,
  maxTurnChars: number,
): VoiceSessionV8Turn[] {
  const trimmed = turns.map((t) => ({
    ...t,
    text: t.text.length > maxTurnChars ? t.text.slice(0, maxTurnChars) : t.text,
  }));
  return trimmed.slice(Math.max(0, trimmed.length - Math.max(1, maxTurns)));
}

/**
 * Resume instructions for the model: base instructions plus the
 * recent turns plus the cut reply, so the model picks up where the
 * call left off instead of starting cold.
 */
export function buildVoiceSessionV8ResumeInstructions(
  snapshot: VoiceSessionV8Snapshot,
  baseInstructions: string,
  maxTurns = 8,
): string {
  const lines: string[] = [baseInstructions.trim()];
  lines.push('');
  lines.push(
    `[Resumed voice session ${snapshot.sessionId} — the call dropped and reconnected. ` +
      `Do not start over. Continue the conversation from the history below. ` +
      `The session had run for ${Math.round(snapshot.durationMs / 1000)}s with ` +
      `${snapshot.reconnects} reconnect(s).]`,
  );
  if (snapshot.cutPoint && snapshot.cutPoint.remainingText) {
    lines.push(
      `[You were cut off mid-reply after saying: "${snapshot.cutPoint.spokenText}". ` +
        `The rest of that reply was never spoken: "${snapshot.cutPoint.remainingText}". ` +
        `If the user asks you to continue, resume from the unspoken part instead of restarting the reply.]`,
    );
  }
  const recent = snapshot.turns.slice(Math.max(0, snapshot.turns.length - maxTurns));
  if (recent.length > 0) {
    lines.push('[Recent turns:]');
    for (const t of recent) {
      const cut = t.interrupted ? ' (cut off)' : '';
      lines.push(`${t.speaker === 'user' ? 'User' : 'Assistant'}: ${t.text}${cut}`);
    }
  }
  return lines.join('\n');
}

/** Markdown rendering of a snapshot (diagnostics / export). */
export function voiceSessionV8SnapshotMarkdown(snapshot: VoiceSessionV8Snapshot): string {
  const lines: string[] = [
    `# Voice session ${snapshot.sessionId} (v8)`,
    '',
    `- Provider: ${snapshot.provider}`,
    `- Voice: ${snapshot.voiceName ?? snapshot.voiceId ?? 'default'}`,
    `- VAD: ${snapshot.vadEngine}/${snapshot.vadPreset} · barge-in sensitivity ${snapshot.bargeInSensitivity}`,
    `- Input mode: ${snapshot.inputMode}`,
    `- Duration: ${Math.round(snapshot.durationMs / 1000)}s · turns ${snapshot.turns.length} · reconnects ${snapshot.reconnects} · downtime ${snapshot.totalDowntimeMs}ms`,
    `- Clean shutdown: ${snapshot.cleanShutdown ? 'yes' : 'no'}`,
  ];
  if (snapshot.cutPoint) {
    lines.push(
      `- Cut reply: spoke "${snapshot.cutPoint.spokenText}" (${snapshot.cutPoint.wordsPlayed} words, ${snapshot.cutPoint.audioPlayedMs}ms), unspoken: "${snapshot.cutPoint.remainingText}"`,
    );
  }
  lines.push('', '## Turns', '');
  for (const t of snapshot.turns) {
    lines.push(`- **${t.speaker}**: ${t.text}${t.interrupted ? ' *(cut off)*' : ''}`);
  }
  return lines.join('\n');
}

/** The durable store: atomic saves, checksum-validated loads, prune. */
export class VoiceSessionV8Store {
  private readonly dir: string;
  private readonly maxTurns: number;
  private readonly maxTurnChars: number;
  private readonly maxAgeMs: number;
  private readonly clock: () => number;

  constructor(options: VoiceSessionV8StoreOptions) {
    if (!options.dir || typeof options.dir !== 'string') {
      throw new Error('VoiceSessionV8Store: dir is required.');
    }
    this.dir = options.dir;
    this.maxTurns = Math.max(1, options.maxTurns ?? VOICE_SESSION_V8_DEFAULT_MAX_TURNS);
    this.maxTurnChars = Math.max(100, options.maxTurnChars ?? VOICE_SESSION_V8_DEFAULT_MAX_TURN_CHARS);
    this.maxAgeMs = Math.max(0, options.maxAgeMs ?? VOICE_SESSION_V8_DEFAULT_MAX_AGE_MS);
    this.clock = options.clock ?? Date.now;
  }

  getDir(): string {
    return this.dir;
  }

  /** Atomic save: tmp file + fsync + rename. Returns the byte count. */
  save(snapshot: VoiceSessionV8Snapshot): VoiceSessionV8SaveResult {
    const capped: VoiceSessionV8Snapshot = {
      ...snapshot,
      turns: capVoiceSessionV8Turns(snapshot.turns, this.maxTurns, this.maxTurnChars),
      updatedAtMs: this.clock(),
    };
    const payload = JSON.stringify(capped);
    const envelope: VoiceSessionV8Envelope = { checksum: checksumOf(payload), snapshot: capped };
    const text = JSON.stringify(envelope);
    const filePath = voiceSessionV8SnapshotPath(this.dir, capped.sessionId);
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      const tmpPath = `${filePath}.tmp`;
      const fd = fs.openSync(tmpPath, 'w');
      try {
        fs.writeFileSync(fd, text, 'utf8');
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(tmpPath, filePath);
      return { ok: true, path: filePath, bytes: Buffer.byteLength(text, 'utf8'), turns: capped.turns.length };
    } catch (err) {
      return {
        ok: false,
        path: filePath,
        bytes: 0,
        turns: capped.turns.length,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /** Load + validate. Corrupt files are quarantined, never deleted silently. */
  load(sessionId: string): VoiceSessionV8LoadResult {
    const filePath = voiceSessionV8SnapshotPath(this.dir, sessionId);
    let raw: string;
    try {
      raw = fs.readFileSync(filePath, 'utf8');
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return { ok: false, error: 'missing', detail: 'no snapshot on disk', path: filePath };
      return { ok: false, error: 'io-error', detail: err instanceof Error ? err.message : String(err), path: filePath };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.quarantine(filePath);
      return { ok: false, error: 'corrupt-json', detail: 'snapshot is not valid JSON', path: filePath };
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      this.quarantine(filePath);
      return { ok: false, error: 'bad-schema', detail: 'envelope must be an object', path: filePath };
    }
    const env = parsed as Record<string, unknown>;
    const snapshot = env['snapshot'];
    if (!snapshot || typeof snapshot !== 'object') {
      this.quarantine(filePath);
      return { ok: false, error: 'bad-schema', detail: 'envelope has no snapshot', path: filePath };
    }
    const payload = JSON.stringify(snapshot);
    if (typeof env['checksum'] !== 'string' || env['checksum'] !== checksumOf(payload)) {
      this.quarantine(filePath);
      return { ok: false, error: 'checksum-mismatch', detail: 'snapshot checksum does not match', path: filePath };
    }
    const snap = snapshot as VoiceSessionV8Snapshot;
    if (snap.version !== VOICE_SESSION_V8_STORE_VERSION) {
      return {
        ok: false,
        error: 'unsupported-version',
        detail: `snapshot version ${String((snap as { version?: unknown }).version)} is not ${VOICE_SESSION_V8_STORE_VERSION}`,
        path: filePath,
      };
    }
    const problems = validateVoiceSessionV8Snapshot(snap);
    if (problems.length > 0) {
      this.quarantine(filePath);
      return { ok: false, error: 'bad-schema', detail: problems.join('; '), path: filePath };
    }
    return { ok: true, snapshot: snap, path: filePath };
  }

  /** Move a bad file aside (never delete it). Returns the quarantine path or null. */
  quarantine(filePath: string): string | null {
    try {
      const dest = `${filePath}.corrupt-${this.clock()}.json`;
      fs.renameSync(filePath, dest);
      return dest;
    } catch {
      return null;
    }
  }

  /** True when a snapshot exists on disk for this session. */
  has(sessionId: string): boolean {
    return fs.existsSync(voiceSessionV8SnapshotPath(this.dir, sessionId));
  }

  /** Delete a snapshot. False when there was none. */
  delete(sessionId: string): boolean {
    try {
      fs.unlinkSync(voiceSessionV8SnapshotPath(this.dir, sessionId));
      return true;
    } catch {
      return false;
    }
  }

  /** List snapshots (id, age, size, turns). */
  list(): { sessionId: string; path: string; sizeBytes: number; updatedAtMs: number; turns: number }[] {
    let names: string[] = [];
    try {
      names = fs.readdirSync(this.dir);
    } catch {
      return [];
    }
    const out: { sessionId: string; path: string; sizeBytes: number; updatedAtMs: number; turns: number }[] = [];
    for (const name of names) {
      if (!name.endsWith(VOICE_SESSION_V8_SNAPSHOT_EXT)) continue;
      const filePath = path.join(this.dir, name);
      try {
        const stat = fs.statSync(filePath);
        const raw = fs.readFileSync(filePath, 'utf8');
        const env = JSON.parse(raw) as VoiceSessionV8Envelope;
        out.push({
          sessionId: name.slice(0, -VOICE_SESSION_V8_SNAPSHOT_EXT.length),
          path: filePath,
          sizeBytes: stat.size,
          updatedAtMs: env.snapshot.updatedAtMs,
          turns: env.snapshot.turns.length,
        });
      } catch {
        // Unreadable entry: still listed with zeros so the panel can show it.
        try {
          const stat = fs.statSync(filePath);
          out.push({
            sessionId: name.slice(0, -VOICE_SESSION_V8_SNAPSHOT_EXT.length),
            path: filePath,
            sizeBytes: stat.size,
            updatedAtMs: 0,
            turns: 0,
          });
        } catch {
          // Gone between readdir and stat — skip.
        }
      }
    }
    out.sort((a, b) => b.updatedAtMs - a.updatedAtMs);
    return out;
  }

  /**
   * Prune snapshots older than `maxAgeMs` (default: the store's).
   * Returns the deleted ids.
   */
  prune(maxAgeMs?: number): string[] {
    const limit = maxAgeMs ?? this.maxAgeMs;
    const now = this.clock();
    const deleted: string[] = [];
    for (const entry of this.list()) {
      if (entry.updatedAtMs > 0 && now - entry.updatedAtMs > limit) {
        if (this.delete(entry.sessionId)) deleted.push(entry.sessionId);
      }
    }
    return deleted;
  }
}

/**
 * Voice session checkpoints (v1.03, Team T5 — realtime voice v3).
 *
 * A long voice call dies for boring reasons: the socket drops, the
 * app restarts, the provider sends `goAway`. The transcript, the
 * media the user showed, and the barge-in history should not die
 * with it. A checkpoint is a small JSON snapshot of everything a
 * call needs to resume — long-session turns + summaries, attached
 * media (metadata + descriptions only, never raw bytes), barge-in
 * counters and partial turns, turn counts, and the base
 * instructions the model was seeded with:
 *
 *   turn / summary / media event ──▶ maybeCheckpoint()
 *        (every N turns, every N ms, or on demand)
 *        ──▶ CheckpointStore.save(checkpoint)
 *
 *   disconnect / reconnect ──▶ load(sessionId) ──▶ restore()
 *        ──▶ new dial, re-seeded from the checkpoint
 *        (the socket itself is never restored — see
 *        voice/voicePersistence.ts for the same rule).
 *
 * Two stores: `MemoryCheckpointStore` (tests, and the in-process
 * fallback when the app has nowhere to write) and
 * `FileCheckpointStore` (atomic tmp + rename, corrupt files are
 * quarantined, old checkpoints pruned — same discipline as
 * `VoiceSessionStore`). Checkpoints are versioned (`version: 1`);
 * a checkpoint from another version or another session is refused
 * by `restore()`, never applied half-way.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { LongVoiceSession } from './longSession';
import type { VoiceMediaItem, MediaAnswer } from './mediaContext';
import type { PartialModelTurn } from './bargeInV2';
import type { MediaConversationSnapshot } from './mediaConversation';
import { sanitizeVoiceSessionId } from './voicePersistence';

/** Checkpoint schema version. Bump when the shape changes. */
export const VOICE_CHECKPOINT_VERSION = 1;
/** Default: checkpoint every N turns of the long session. */
export const VOICE_CHECKPOINT_EVERY_TURNS = 10;
/** Default: checkpoint at most every N ms (time-based trigger). */
export const VOICE_CHECKPOINT_EVERY_MS = 60_000;
/** Default max checkpoints kept per session on disk (one file per
 *  session — this caps the *history* the memory store keeps). */
export const VOICE_CHECKPOINT_MAX_HISTORY = 5;
/** Default max age of a checkpoint file (30 days, like sessions). */
export const VOICE_CHECKPOINT_DEFAULT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
/** Default max checkpoint files kept on disk. */
export const VOICE_CHECKPOINT_DEFAULT_MAX_FILES = 50;

/** Why this checkpoint was written (diagnostics + panel). */
export type VoiceCheckpointReason =
  | 'turn'
  | 'summary'
  | 'media'
  | 'manual'
  | 'disconnect'
  | 'interval';

/** One media item as stored in a checkpoint: everything except the
 *  raw bytes. `bytesOmitted` is true when the live item held base64
 *  that was deliberately not persisted (the description survives,
 *  the pixels do not — re-attach to show them again). */
export interface CheckpointMediaItem {
  id: string;
  kind: 'image' | 'video';
  mimeType: string;
  name?: string;
  caption?: string;
  durationSec?: number;
  turnSeq?: number;
  description: string;
  describedAt: number;
  status: 'pending' | 'described' | 'failed';
  error?: string;
  addedAt: number;
  /** True when the live item held base64 bytes that were dropped. */
  bytesOmitted: boolean;
}

/** A durable snapshot of one voice call at one moment. */
export interface VoiceSessionCheckpoint {
  version: typeof VOICE_CHECKPOINT_VERSION;
  /** Session this checkpoint belongs to (the realtime session id). */
  sessionId: string;
  /** Provider the call was on ('openai' | 'gemini' | ...). */
  provider: string;
  /** Monotonic checkpoint number inside the session (1-based). */
  seq: number;
  reason: VoiceCheckpointReason;
  createdAt: number;
  /** Model turns + user turns recorded so far. */
  turnCount: number;
  /** Barge-ins handled so far. */
  bargeInCount: number;
  /** Long-session snapshot (turns + summaries + counters). */
  longSession: ReturnType<LongVoiceSession['snapshot']>;
  /** Attached media (metadata + descriptions, no bytes). */
  media: {
    items: CheckpointMediaItem[];
    answers: MediaAnswer[];
    /** Media-conversation snapshot (audio transcripts, video
     *  frames, per-item Q&A, image/video items) when the call
     *  used one. */
    conversation?: MediaConversationSnapshot;
  };
  /** Barge-in v2 counters + cut-off replies kept so far. */
  bargeIn: {
    interrupts: number;
    ignored: Record<string, number>;
    partialTurns: PartialModelTurn[];
  };
  /** Base instructions the call was seeded with (no context block). */
  instructions: string;
}

/** Where checkpoints live. `save` replaces the latest checkpoint
 *  for the session; `load` returns it (null when none / corrupt). */
export interface CheckpointStore {
  save(checkpoint: VoiceSessionCheckpoint): boolean;
  load(sessionId: string): VoiceSessionCheckpoint | null;
  /** Latest checkpoint per session, newest first. */
  list(): VoiceSessionCheckpoint[];
  delete(sessionId: string): boolean;
  /** Drop checkpoints older than `maxAgeMs` / beyond `maxFiles`. */
  prune(maxAgeMs?: number, maxFiles?: number): number;
}

/** Strip raw bytes from a live media item for checkpointing. */
export function checkpointMediaItem(item: VoiceMediaItem): CheckpointMediaItem {
  return {
    id: item.id,
    kind: item.kind,
    mimeType: item.mimeType,
    ...(item.name ? { name: item.name } : {}),
    ...(item.caption ? { caption: item.caption } : {}),
    ...(typeof item.durationSec === 'number' ? { durationSec: item.durationSec } : {}),
    ...(typeof item.turnSeq === 'number' ? { turnSeq: item.turnSeq } : {}),
    description: item.description,
    describedAt: item.describedAt,
    status: item.status,
    ...(item.error ? { error: item.error } : {}),
    addedAt: item.addedAt,
    bytesOmitted: Boolean(item.base64 || item.posterBase64),
  };
}

/** True when the value looks like a checkpoint for this session. */
export function isVoiceSessionCheckpoint(
  value: unknown,
  sessionId?: string,
): value is VoiceSessionCheckpoint {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  if (v.version !== VOICE_CHECKPOINT_VERSION) return false;
  if (typeof v.sessionId !== 'string' || !v.sessionId) return false;
  if (sessionId !== undefined && v.sessionId !== sessionId) return false;
  if (typeof v.provider !== 'string') return false;
  if (typeof v.seq !== 'number' || typeof v.createdAt !== 'number') return false;
  if (!v.longSession || typeof v.longSession !== 'object') return false;
  const ls = v.longSession as Record<string, unknown>;
  if (!Array.isArray(ls.turns) || !Array.isArray(ls.summaries)) return false;
  if (!v.media || typeof v.media !== 'object') return false;
  const media = v.media as Record<string, unknown>;
  if (!Array.isArray(media.items) || !Array.isArray(media.answers)) return false;
  if (
    media.conversation !== undefined &&
    (typeof media.conversation !== 'object' || media.conversation === null)
  ) {
    return false;
  }
  if (!v.bargeIn || typeof v.bargeIn !== 'object') return false;
  if (typeof v.instructions !== 'string') return false;
  return true;
}

/** In-memory checkpoint store: one latest checkpoint per session,
 *  plus a short history for `list()`. No disk, no fs — tests and
 *  the fallback when the app cannot write. */
export class MemoryCheckpointStore implements CheckpointStore {
  private readonly latest = new Map<string, VoiceSessionCheckpoint>();
  private readonly history = new Map<string, VoiceSessionCheckpoint[]>();
  private readonly maxHistory: number;

  constructor(maxHistory: number = VOICE_CHECKPOINT_MAX_HISTORY) {
    this.maxHistory = Math.max(1, maxHistory);
  }

  save(checkpoint: VoiceSessionCheckpoint): boolean {
    if (!isVoiceSessionCheckpoint(checkpoint)) return false;
    const copy: VoiceSessionCheckpoint = JSON.parse(
      JSON.stringify(checkpoint),
    ) as VoiceSessionCheckpoint;
    this.latest.set(copy.sessionId, copy);
    const hist = this.history.get(copy.sessionId) ?? [];
    hist.push(copy);
    while (hist.length > this.maxHistory) hist.shift();
    this.history.set(copy.sessionId, hist);
    return true;
  }

  load(sessionId: string): VoiceSessionCheckpoint | null {
    const found = this.latest.get(sessionId);
    return found
      ? (JSON.parse(JSON.stringify(found)) as VoiceSessionCheckpoint)
      : null;
  }

  list(): VoiceSessionCheckpoint[] {
    return [...this.latest.values()]
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((c) => JSON.parse(JSON.stringify(c)) as VoiceSessionCheckpoint);
  }

  delete(sessionId: string): boolean {
    const had = this.latest.delete(sessionId);
    this.history.delete(sessionId);
    return had;
  }

  prune(maxAgeMs: number = VOICE_CHECKPOINT_DEFAULT_MAX_AGE_MS, maxFiles: number = VOICE_CHECKPOINT_DEFAULT_MAX_FILES): number {
    const now = Date.now();
    let dropped = 0;
    for (const [id, cp] of [...this.latest.entries()]) {
      if (now - cp.createdAt > maxAgeMs) {
        this.latest.delete(id);
        this.history.delete(id);
        dropped += 1;
      }
    }
    const sorted = [...this.latest.values()].sort((a, b) => b.createdAt - a.createdAt);
    for (const cp of sorted.slice(maxFiles)) {
      this.latest.delete(cp.sessionId);
      this.history.delete(cp.sessionId);
      dropped += 1;
    }
    return dropped;
  }
}

/** Default checkpoint directory: `~/.open-bot/voice-checkpoints`. */
export function defaultVoiceCheckpointsDir(): string {
  return path.join(os.homedir(), '.open-bot', 'voice-checkpoints');
}

export interface FileCheckpointStoreOptions {
  dir?: string;
  maxAgeMs?: number;
  maxFiles?: number;
}

/**
 * File-backed checkpoint store: one JSON file per session
 * (`<dir>/<sessionId>.json`), written atomically (tmp + rename).
 * A corrupt file loads as null and is quarantined to
 * `<sessionId>.corrupt-<ts>` so it never blocks the next resume.
 * `prune()` drops files older than `maxAgeMs` / beyond `maxFiles`
 * (oldest first). Never throws — every failure returns false/null.
 */
export class FileCheckpointStore implements CheckpointStore {
  private readonly dir: string;
  private readonly maxAgeMs: number;
  private readonly maxFiles: number;

  constructor(options: FileCheckpointStoreOptions = {}) {
    this.dir = options.dir ?? defaultVoiceCheckpointsDir();
    this.maxAgeMs = options.maxAgeMs ?? VOICE_CHECKPOINT_DEFAULT_MAX_AGE_MS;
    this.maxFiles = options.maxFiles ?? VOICE_CHECKPOINT_DEFAULT_MAX_FILES;
  }

  get directory(): string {
    return this.dir;
  }

  filePath(sessionId: string): string {
    const clean = sanitizeVoiceSessionId(sessionId);
    if (!clean) return '';
    return path.join(this.dir, `${clean}.json`);
  }

  save(checkpoint: VoiceSessionCheckpoint): boolean {
    if (!isVoiceSessionCheckpoint(checkpoint)) return false;
    const file = this.filePath(checkpoint.sessionId);
    if (!file) return false;
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
      fs.writeFileSync(tmp, JSON.stringify(checkpoint, null, 2), 'utf8');
      fs.renameSync(tmp, file);
      return true;
    } catch {
      return false;
    }
  }

  load(sessionId: string): VoiceSessionCheckpoint | null {
    const file = this.filePath(sessionId);
    if (!file) return null;
    let raw: string;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch {
      return null;
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!isVoiceSessionCheckpoint(parsed, sessionId)) {
        this.quarantine(file);
        return null;
      }
      return parsed;
    } catch {
      this.quarantine(file);
      return null;
    }
  }

  list(): VoiceSessionCheckpoint[] {
    let names: string[];
    try {
      names = fs.readdirSync(this.dir);
    } catch {
      return [];
    }
    const out: VoiceSessionCheckpoint[] = [];
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const cp = this.load(name.slice(0, -'.json'.length));
      if (cp) out.push(cp);
    }
    return out.sort((a, b) => b.createdAt - a.createdAt);
  }

  delete(sessionId: string): boolean {
    const file = this.filePath(sessionId);
    if (!file) return false;
    try {
      fs.unlinkSync(file);
      return true;
    } catch {
      return false;
    }
  }

  prune(maxAgeMs: number = this.maxAgeMs, maxFiles: number = this.maxFiles): number {
    let names: string[];
    try {
      names = fs.readdirSync(this.dir);
    } catch {
      return 0;
    }
    const now = Date.now();
    let dropped = 0;
    const live: Array<{ file: string; at: number }> = [];
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const file = path.join(this.dir, name);
      let mtime = 0;
      try {
        mtime = fs.statSync(file).mtimeMs;
      } catch {
        continue;
      }
      if (now - mtime > maxAgeMs) {
        try {
          fs.unlinkSync(file);
          dropped += 1;
        } catch {
          // Best-effort — the next prune retries.
        }
      } else {
        live.push({ file, at: mtime });
      }
    }
    live.sort((a, b) => b.at - a.at);
    for (const entry of live.slice(maxFiles)) {
      try {
        fs.unlinkSync(entry.file);
        dropped += 1;
      } catch {
        // Best-effort.
      }
    }
    return dropped;
  }

  private quarantine(file: string): void {
    try {
      fs.renameSync(file, `${file}.corrupt-${Date.now()}`);
    } catch {
      // Best-effort — the corrupt file stays, load keeps refusing it.
    }
  }
}

/** Everything the checkpointer reads from the live call. The
 *  getters are callbacks so the checkpointer never owns the
 *  session, the media context, or the barge-in controller — it
 *  only snapshots them. */
export interface CheckpointSources {
  sessionId: () => string;
  provider: () => string;
  instructions: () => string;
  turnCount: () => number;
  bargeInCount: () => number;
  longSession: () => Pick<LongVoiceSession, 'snapshot'>;
  mediaItems: () => VoiceMediaItem[];
  mediaAnswers: () => MediaAnswer[];
  bargeInInterrupts: () => number;
  bargeInIgnored: () => Record<string, number>;
  bargeInPartials: () => PartialModelTurn[];
  /** Media-conversation snapshot (audio/frames/Q&A), when used. */
  conversationSnapshot?: () => MediaConversationSnapshot;
}

export interface SessionCheckpointerOptions {
  store?: CheckpointStore;
  /** Checkpoint every N long-session turns. Default 10. */
  everyTurns?: number;
  /** Checkpoint at most every N ms. Default 60_000. */
  everyMs?: number;
  /** Inject the clock (tests). Defaults to `Date.now`. */
  clock?: () => number;
}

/** Stats for the panel / diagnostics. */
export interface SessionCheckpointerStats {
  checkpoints: number;
  lastSeq: number;
  lastReason: VoiceCheckpointReason | null;
  lastAt: number;
  lastTurnCount: number;
  skippedNoChange: number;
}

/**
 * Owns checkpointing for one call: builds the checkpoint from the
 * live sources, writes it through the store, and decides when a
 * checkpoint is due. `maybeCheckpoint()` is called on every turn /
 * summary / media event — it writes only when the turn budget or
 * the time budget says so, so a chatty call does not fsync on
 * every word. `checkpointNow()` always writes (manual save,
 * disconnect). `restore()` loads the latest checkpoint for a
 * session id and validates it before returning it.
 */
export class SessionCheckpointer {
  private readonly store: CheckpointStore;
  private readonly everyTurns: number;
  private readonly everyMs: number;
  private readonly clock: () => number;
  private seq = 0;
  private checkpoints = 0;
  private lastReason: VoiceCheckpointReason | null = null;
  private lastAt = 0;
  private lastTurnCount = 0;
  private lastCheckpointTurns = 0;
  private lastCheckpointAt = 0;
  private skippedNoChange = 0;

  constructor(options: SessionCheckpointerOptions = {}) {
    this.store = options.store ?? new MemoryCheckpointStore();
    this.everyTurns = Math.max(1, options.everyTurns ?? VOICE_CHECKPOINT_EVERY_TURNS);
    this.everyMs = Math.max(0, options.everyMs ?? VOICE_CHECKPOINT_EVERY_MS);
    this.clock = options.clock ?? Date.now;
  }

  getStats(): SessionCheckpointerStats {
    return {
      checkpoints: this.checkpoints,
      lastSeq: this.seq,
      lastReason: this.lastReason,
      lastAt: this.lastAt,
      lastTurnCount: this.lastTurnCount,
      skippedNoChange: this.skippedNoChange,
    };
  }

  /** True when a checkpoint is due (turn budget or time budget). */
  isDue(sources: CheckpointSources): boolean {
    const turns = sources.turnCount();
    const now = this.clock();
    if (turns - this.lastCheckpointTurns >= this.everyTurns) return true;
    if (
      this.everyMs > 0 &&
      this.lastCheckpointAt > 0 &&
      now - this.lastCheckpointAt >= this.everyMs &&
      turns > this.lastCheckpointTurns
    ) {
      return true;
    }
    return false;
  }

  /**
   * Checkpoint when due; returns the checkpoint, or null when not
   * due / nothing changed since the last checkpoint. `forceReason`
   * writes regardless (summary + media events always checkpoint —
   * they change state the turn counter does not see).
   */
  maybeCheckpoint(
    sources: CheckpointSources,
    reason: VoiceCheckpointReason,
  ): VoiceSessionCheckpoint | null {
    const force = reason === 'summary' || reason === 'media' || reason === 'manual' || reason === 'disconnect';
    if (!force && !this.isDue(sources)) {
      // Asked, but nothing new to save — count the skip so the
      // panel can tell "checked, no checkpoint needed" apart from
      // "never checked".
      if (this.checkpoints > 0) this.skippedNoChange += 1;
      return null;
    }
    return this.checkpointNow(sources, reason);
  }

  /** Build + store a checkpoint now, whatever the budgets say. */
  checkpointNow(
    sources: CheckpointSources,
    reason: VoiceCheckpointReason,
  ): VoiceSessionCheckpoint | null {
    const now = this.clock();
    const longSession = sources.longSession();
    const checkpoint: VoiceSessionCheckpoint = {
      version: VOICE_CHECKPOINT_VERSION,
      sessionId: sources.sessionId(),
      provider: sources.provider(),
      seq: (this.seq += 1),
      reason,
      createdAt: now,
      turnCount: sources.turnCount(),
      bargeInCount: sources.bargeInCount(),
      longSession: longSession.snapshot(),
      media: {
        items: sources.mediaItems().map((i) => checkpointMediaItem(i)),
        answers: sources.mediaAnswers().map((a) => ({ ...a })),
        ...(sources.conversationSnapshot
          ? { conversation: sources.conversationSnapshot() }
          : {}),
      },
      bargeIn: {
        interrupts: sources.bargeInInterrupts(),
        ignored: sources.bargeInIgnored(),
        partialTurns: sources.bargeInPartials().map((p) => ({ ...p })),
      },
      instructions: sources.instructions(),
    };
    if (!this.store.save(checkpoint)) return null;
    this.checkpoints += 1;
    this.lastReason = reason;
    this.lastAt = now;
    this.lastTurnCount = checkpoint.turnCount;
    this.lastCheckpointTurns = checkpoint.turnCount;
    this.lastCheckpointAt = now;
    return JSON.parse(JSON.stringify(checkpoint)) as VoiceSessionCheckpoint;
  }

  /** Latest checkpoint for a session (validated), or null. */
  restore(sessionId: string): VoiceSessionCheckpoint | null {
    if (!sessionId) return null;
    return this.store.load(sessionId);
  }

  /** Drop the stored checkpoint for a session (call ended cleanly). */
  discard(sessionId: string): boolean {
    return this.store.delete(sessionId);
  }

  /** Reset the counters (new call). The store is left alone. */
  reset(): void {
    this.seq = 0;
    this.checkpoints = 0;
    this.lastReason = null;
    this.lastAt = 0;
    this.lastTurnCount = 0;
    this.lastCheckpointTurns = 0;
    this.lastCheckpointAt = 0;
    this.skippedNoChange = 0;
  }
}

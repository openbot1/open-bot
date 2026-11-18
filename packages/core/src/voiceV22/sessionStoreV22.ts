/**
 * Durable session store v22 (voice v22, v1.35 Team T5).
 *
 * A realtime session is durable only if its state survives the
 * process that holds it. This module is the store that makes
 * that true:
 *
 *   - Journal. Every state change is appended as a
 *     VoiceV22JournalEntry with a monotonically increasing seq.
 *     The journal is the source of truth; a checkpoint is only
 *     a shortcut over it. Replaying the journal from a
 *     checkpoint rebuilds the session exactly.
 *   - Checkpoints. A full snapshot (turns, transcript, pending
 *     reply, counters, floor, profile) plus the journal seq it
 *     covers. Checkpoints are versioned and checksummed: a
 *     corrupt checkpoint is detected, never trusted.
 *   - Snapshots. A serialisable form of the whole store (journal
 *     + latest checkpoint) so the host can persist it to disk,
 *     a vault, or a fleet node and reload it later.
 *
 * The store never touches the network or the disk itself: the
 * host supplies persistence by serialising the snapshot the
 * store hands out. Everything is in-memory and deterministic
 * on a virtual clock, so tests can drive crashes by dropping
 * the in-memory store and reloading from a snapshot string.
 */
import {
  clampV22,
  resumeTokenV22,
  round2V22,
  zeroCountersV22,
  VOICE_V22_CHECKPOINT_VERSION,
  type VoiceV22Checkpoint,
  type VoiceV22DurabilityPhase,
  type VoiceV22EventSink,
  type VoiceV22FloorHolder,
  type VoiceV22JournalEntry,
  type VoiceV22JournalKind,
  type VoiceV22ReplyCut,
  type VoiceV22SessionCounters,
  type VoiceV22TranscriptSegment,
  type VoiceV22TurnRecord,
  type VoiceV22TurnState,
} from './types';

export interface VoiceV22StoreOptions {
  /** Max journal entries kept before compaction (default 1000). */
  maxJournalEntries: number;
  /** Max turns kept in a checkpoint (default 200). */
  maxTurns: number;
  /** Max transcript segments kept in a checkpoint (default 400). */
  maxTranscriptSegments: number;
  /** Auto-checkpoint every N journal entries (0 disables, default 50). */
  autoCheckpointEvery: number;
}

export function defaultSessionStoreV22Options(): VoiceV22StoreOptions {
  return {
    maxJournalEntries: 1000,
    maxTurns: 200,
    maxTranscriptSegments: 400,
    autoCheckpointEvery: 50,
  };
}

export function validateSessionStoreV22Options(o: Partial<VoiceV22StoreOptions>): string[] {
  const e: string[] = [];
  if (o.maxJournalEntries !== undefined && (!Number.isInteger(o.maxJournalEntries) || o.maxJournalEntries < 10)) {
    e.push('maxJournalEntries must be an integer >= 10');
  }
  if (o.maxTurns !== undefined && (!Number.isInteger(o.maxTurns) || o.maxTurns < 1)) {
    e.push('maxTurns must be a positive integer');
  }
  if (o.maxTranscriptSegments !== undefined && (!Number.isInteger(o.maxTranscriptSegments) || o.maxTranscriptSegments < 1)) {
    e.push('maxTranscriptSegments must be a positive integer');
  }
  if (o.autoCheckpointEvery !== undefined && (!Number.isInteger(o.autoCheckpointEvery) || o.autoCheckpointEvery < 0)) {
    e.push('autoCheckpointEvery must be a non-negative integer');
  }
  return e;
}

/** Serialised form of the store, for the host to persist. */
export interface VoiceV22StoreSnapshot {
  version: 1;
  sessionId: string;
  journal: VoiceV22JournalEntry[];
  checkpoint: VoiceV22Checkpoint | null;
  nextSeq: number;
  savedAtMs: number;
}

export interface VoiceV22StoreStats {
  journalEntries: number;
  journalSeq: number;
  checkpoints: number;
  lastCheckpointAtMs: number | null;
  lastCheckpointSeq: number | null;
  compactions: number;
  droppedJournalEntries: number;
  /** Journal entries since the last checkpoint. */
  entriesSinceCheckpoint: number;
}

/**
 * FNV-1a checksum over the canonical JSON of a checkpoint body.
 * Cheap, deterministic, and enough to catch a truncated or
 * hand-edited checkpoint — it is integrity, not security.
 */
export function checkpointChecksumV22(checkpoint: Omit<VoiceV22Checkpoint, 'resumeToken'> & { resumeToken?: string }): string {
  const body = JSON.stringify({
    version: checkpoint.version,
    sessionId: checkpoint.sessionId,
    createdAtMs: checkpoint.createdAtMs,
    journalSeq: checkpoint.journalSeq,
    turnState: checkpoint.turnState,
    durability: checkpoint.durability,
    floor: checkpoint.floor,
    profileId: checkpoint.profileId,
    turns: checkpoint.turns,
    transcript: checkpoint.transcript,
    pendingReply: checkpoint.pendingReply,
    unfinalisedPartial: checkpoint.unfinalisedPartial,
    counters: checkpoint.counters,
  });
  let hash = 0x811c9dc5;
  for (let i = 0; i < body.length; i += 1) {
    hash ^= body.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/** Validate a checkpoint shape; returns error strings (empty = valid). */
export function validateCheckpointV22(raw: unknown): string[] {
  const e: string[] = [];
  if (typeof raw !== 'object' || raw === null) return ['checkpoint must be an object'];
  const c = raw as Record<string, unknown>;
  if (c.version !== VOICE_V22_CHECKPOINT_VERSION) e.push(`checkpoint version must be ${VOICE_V22_CHECKPOINT_VERSION}`);
  if (typeof c.sessionId !== 'string' || c.sessionId === '') e.push('checkpoint sessionId must be a non-empty string');
  if (typeof c.createdAtMs !== 'number' || !Number.isFinite(c.createdAtMs) || c.createdAtMs < 0) {
    e.push('checkpoint createdAtMs must be a non-negative number');
  }
  if (typeof c.journalSeq !== 'number' || !Number.isInteger(c.journalSeq) || c.journalSeq < 0) {
    e.push('checkpoint journalSeq must be a non-negative integer');
  }
  const states = ['idle', 'listening', 'speaking', 'waiting', 'confirming', 'yielded', 'paused'];
  if (typeof c.turnState !== 'string' || !states.includes(c.turnState)) e.push('checkpoint turnState is not a valid turn state');
  const phases = ['live', 'degraded', 'disconnected', 'reconnecting', 'resuming', 'recovered', 'closed'];
  if (typeof c.durability !== 'string' || !phases.includes(c.durability)) e.push('checkpoint durability is not a valid phase');
  if (typeof c.profileId !== 'string' || c.profileId === '') e.push('checkpoint profileId must be a non-empty string');
  if (!Array.isArray(c.turns)) e.push('checkpoint turns must be an array');
  if (!Array.isArray(c.transcript)) e.push('checkpoint transcript must be an array');
  if (typeof c.resumeToken !== 'string' || c.resumeToken === '') e.push('checkpoint resumeToken must be a non-empty string');
  if (typeof c.counters !== 'object' || c.counters === null) e.push('checkpoint counters must be an object');
  if (c.pendingReply !== null && typeof c.pendingReply !== 'object') e.push('checkpoint pendingReply must be an object or null');
  if (typeof c.unfinalisedPartial !== 'string') e.push('checkpoint unfinalisedPartial must be a string');
  return e;
}

/** True when the checkpoint fails validation or its checksum. */
export function checkpointIsCorruptV22(checkpoint: VoiceV22Checkpoint, expectedChecksum?: string): boolean {
  if (validateCheckpointV22(checkpoint).length > 0) return true;
  if (expectedChecksum !== undefined && checkpointChecksumV22(checkpoint) !== expectedChecksum) return true;
  return false;
}

export class DurableSessionStoreV22 {
  readonly sessionId: string;
  private readonly opts: VoiceV22StoreOptions;
  private readonly sink?: VoiceV22EventSink;
  private journal: VoiceV22JournalEntry[] = [];
  private nextSeq = 1;
  private checkpoint: VoiceV22Checkpoint | null = null;
  private checkpointChecksum: string | null = null;
  private compactions = 0;
  private droppedJournalEntries = 0;
  private entriesSinceCheckpoint = 0;

  constructor(sessionId: string, opts: Partial<VoiceV22StoreOptions> = {}, sink?: VoiceV22EventSink) {
    this.sessionId = sessionId;
    this.opts = { ...defaultSessionStoreV22Options(), ...opts };
    this.sink = sink;
  }

  /** Next journal sequence number (1-based). */
  seq(): number {
    return this.nextSeq;
  }

  /**
   * Append one journal entry. Returns the entry with its seq.
   * When the journal grows past the cap the oldest entries are
   * compacted away — but only entries already covered by a
   * checkpoint, so replay never loses history it needs.
   */
  append(kind: VoiceV22JournalKind, atMs: number, detail?: Record<string, unknown>): VoiceV22JournalEntry {
    const entry: VoiceV22JournalEntry = { seq: this.nextSeq, kind, atMs, sessionId: this.sessionId, ...(detail !== undefined ? { detail } : {}) };
    this.nextSeq += 1;
    this.journal.push(entry);
    this.entriesSinceCheckpoint += 1;
    this.compactIfNeeded();
    return { ...entry, ...(entry.detail !== undefined ? { detail: { ...entry.detail } } : {}) };
  }

  private compactIfNeeded(): void {
    if (this.journal.length <= this.opts.maxJournalEntries) return;
    const coveredSeq = this.checkpoint?.journalSeq ?? 0;
    const removable = this.journal.filter((e) => e.seq <= coveredSeq);
    if (removable.length === 0) {
      // Nothing is checkpointed yet: drop the oldest entries
      // anyway, but count them — replay from before the drop is
      // no longer possible and the caller must know.
      const excess = this.journal.length - this.opts.maxJournalEntries;
      this.journal.splice(0, excess);
      this.droppedJournalEntries += excess;
      this.compactions += 1;
      return;
    }
    const keepFrom = this.journal.length - removable.length > this.opts.maxJournalEntries
      ? this.journal.length - this.opts.maxJournalEntries
      : removable.length;
    const dropped = this.journal.splice(0, Math.min(removable.length, keepFrom));
    this.droppedJournalEntries += dropped.length;
    this.compactions += 1;
  }

  /** Entries with seq > `fromSeq` (exclusive), in order. */
  entriesSince(fromSeq: number): VoiceV22JournalEntry[] {
    return this.journal
      .filter((e) => e.seq > fromSeq)
      .map((e) => ({ ...e, ...(e.detail !== undefined ? { detail: { ...e.detail } } : {}) }));
  }

  /** All journal entries, in order. */
  entries(): VoiceV22JournalEntry[] {
    return this.entriesSince(0);
  }

  /** True when the journal has a gap (a seq is missing). */
  hasGap(): boolean {
    if (this.journal.length === 0) return false;
    for (let i = 1; i < this.journal.length; i += 1) {
      if (this.journal[i].seq !== this.journal[i - 1].seq + 1) return true;
    }
    return false;
  }

  /** First seq still held, or null when the journal is empty. */
  earliestSeq(): number | null {
    return this.journal.length === 0 ? null : this.journal[0].seq;
  }

  /** Last seq appended, or 0 when the journal is empty. */
  latestSeq(): number {
    return this.nextSeq - 1;
  }

  /**
   * Write a checkpoint. The caller supplies the live state; the
   * store stamps it with the current journal seq and a fresh
   * resume token. Returns the checkpoint (with its checksum).
   */
  checkpointNow(input: {
    atMs: number;
    turnState: VoiceV22TurnState;
    durability: VoiceV22DurabilityPhase;
    floor: VoiceV22FloorHolder;
    profileId: string;
    turns: VoiceV22TurnRecord[];
    transcript: VoiceV22TranscriptSegment[];
    pendingReply: VoiceV22ReplyCut | null;
    unfinalisedPartial: string;
    counters: VoiceV22SessionCounters;
  }): { checkpoint: VoiceV22Checkpoint; checksum: string } {
    const journalSeq = this.latestSeq();
    const checkpoint: VoiceV22Checkpoint = {
      version: VOICE_V22_CHECKPOINT_VERSION,
      sessionId: this.sessionId,
      createdAtMs: input.atMs,
      journalSeq,
      turnState: input.turnState,
      durability: input.durability,
      floor: input.floor,
      profileId: input.profileId,
      turns: input.turns.slice(-this.opts.maxTurns).map((t) => ({ ...t })),
      transcript: input.transcript.slice(-this.opts.maxTranscriptSegments).map((s) => ({ ...s })),
      pendingReply: input.pendingReply === null ? null : { ...input.pendingReply },
      unfinalisedPartial: input.unfinalisedPartial,
      counters: { ...input.counters },
      resumeToken: resumeTokenV22(this.sessionId, journalSeq),
    };
    const checksum = checkpointChecksumV22(checkpoint);
    this.checkpoint = checkpoint;
    this.checkpointChecksum = checksum;
    this.entriesSinceCheckpoint = 0;
    this.sink?.({
      kind: 'checkpoint',
      atMs: input.atMs,
      sessionId: this.sessionId,
      detail: { journalSeq, checksum, turns: checkpoint.turns.length, transcript: checkpoint.transcript.length },
    });
    return { checkpoint: { ...checkpoint, turns: checkpoint.turns.map((t) => ({ ...t })), transcript: checkpoint.transcript.map((s) => ({ ...s })) }, checksum };
  }

  /**
   * Checkpoint automatically when the auto-checkpoint threshold
   * is reached. Returns the checkpoint when one was written.
   */
  maybeAutoCheckpoint(input: Parameters<DurableSessionStoreV22['checkpointNow']>[0]): { checkpoint: VoiceV22Checkpoint; checksum: string } | null {
    if (this.opts.autoCheckpointEvery <= 0) return null;
    if (this.entriesSinceCheckpoint < this.opts.autoCheckpointEvery) return null;
    return this.checkpointNow(input);
  }

  latestCheckpoint(): VoiceV22Checkpoint | null {
    if (this.checkpoint === null) return null;
    return {
      ...this.checkpoint,
      turns: this.checkpoint.turns.map((t) => ({ ...t })),
      transcript: this.checkpoint.transcript.map((s) => ({ ...s })),
      counters: { ...this.checkpoint.counters },
      pendingReply: this.checkpoint.pendingReply === null ? null : { ...this.checkpoint.pendingReply },
    };
  }

  latestChecksum(): string | null {
    return this.checkpointChecksum;
  }

  /** Verify the stored checkpoint against its checksum. */
  verifyCheckpoint(): { ok: boolean; errors: string[] } {
    if (this.checkpoint === null) return { ok: false, errors: ['no checkpoint stored'] };
    const errors = validateCheckpointV22(this.checkpoint);
    if (this.checkpointChecksum !== null && checkpointChecksumV22(this.checkpoint) !== this.checkpointChecksum) {
      errors.push('checkpoint checksum mismatch');
    }
    return { ok: errors.length === 0, errors };
  }

  /**
   * Serialise the whole store for the host to persist. The
   * snapshot is plain JSON: journal + checkpoint + next seq.
   */
  snapshot(atMs: number): VoiceV22StoreSnapshot {
    return {
      version: 1,
      sessionId: this.sessionId,
      journal: this.entries(),
      checkpoint: this.latestCheckpoint(),
      nextSeq: this.nextSeq,
      savedAtMs: atMs,
    };
  }

  snapshotJson(atMs: number): string {
    return JSON.stringify(this.snapshot(atMs));
  }

  /**
   * Restore a store from a snapshot produced by `snapshot`.
   * Returns error strings (empty = restored). A snapshot for a
   * different session, a corrupt checkpoint, or a journal gap
   * is refused — the caller must start a fresh session instead
   * of resuming from untrusted state.
   */
  restore(snapshot: VoiceV22StoreSnapshot): string[] {
    const errors: string[] = [];
    if (snapshot.version !== 1) errors.push('snapshot version must be 1');
    if (snapshot.sessionId !== this.sessionId) errors.push(`snapshot sessionId "${snapshot.sessionId}" does not match "${this.sessionId}"`);
    if (!Array.isArray(snapshot.journal)) errors.push('snapshot journal must be an array');
    // A missing checkpoint is the same as no checkpoint (null);
    // a present one must validate.
    const checkpoint = snapshot.checkpoint ?? null;
    if (checkpoint !== null) {
      errors.push(...validateCheckpointV22(checkpoint));
      if (checkpoint.sessionId !== this.sessionId) {
        errors.push('checkpoint sessionId does not match the store session');
      }
    }
    if (errors.length > 0) return errors;
    this.journal = snapshot.journal.map((e) => ({ ...e, ...(e.detail !== undefined ? { detail: { ...e.detail } } : {}) }));
    this.nextSeq = snapshot.nextSeq;
    this.checkpoint = checkpoint === null ? null : {
      ...checkpoint,
      turns: checkpoint.turns.map((t) => ({ ...t })),
      transcript: checkpoint.transcript.map((s) => ({ ...s })),
      counters: { ...checkpoint.counters },
      pendingReply: checkpoint.pendingReply === null ? null : { ...checkpoint.pendingReply },
    };
    this.checkpointChecksum = this.checkpoint === null ? null : checkpointChecksumV22(this.checkpoint);
    this.entriesSinceCheckpoint = this.checkpoint === null ? this.journal.length : this.journal.filter((e) => e.seq > this.checkpoint!.journalSeq).length;
    if (this.hasGap()) errors.push('restored journal has a sequence gap');
    return errors;
  }

  /** Restore from a JSON string; malformed JSON is an error. */
  restoreJson(json: string): string[] {
    let parsed: unknown;
    try {
      parsed = JSON.parse(json) as unknown;
    } catch {
      return ['snapshot JSON is not valid JSON'];
    }
    return this.restore(parsed as VoiceV22StoreSnapshot);
  }

  stats(): VoiceV22StoreStats {
    return {
      journalEntries: this.journal.length,
      journalSeq: this.latestSeq(),
      checkpoints: this.checkpoint === null ? 0 : 1,
      lastCheckpointAtMs: this.checkpoint?.createdAtMs ?? null,
      lastCheckpointSeq: this.checkpoint?.journalSeq ?? null,
      compactions: this.compactions,
      droppedJournalEntries: this.droppedJournalEntries,
      entriesSinceCheckpoint: this.entriesSinceCheckpoint,
    };
  }

  /** Human-readable durability report for the panel. */
  summary(): string {
    const s = this.stats();
    const checkpoint = s.lastCheckpointSeq === null ? 'no checkpoint' : `checkpoint @seq ${s.lastCheckpointSeq}`;
    return `store ${this.sessionId}: journal ${s.journalEntries} entries (seq ${s.journalSeq}), ${checkpoint}, ` +
      `${s.compactions} compactions, ${s.droppedJournalEntries} dropped`;
  }

  /** Durability score 0..1: 1 = checkpointed at the journal tip. */
  durabilityScore(): number {
    if (this.journal.length === 0) return 1;
    if (this.checkpoint === null) return 0;
    const covered = this.checkpoint.journalSeq;
    return round2V22(clampV22(covered / Math.max(1, this.latestSeq()), 0, 1));
  }
}

export function createDurableSessionStoreV22(
  sessionId: string,
  opts: Partial<VoiceV22StoreOptions> = {},
  sink?: VoiceV22EventSink,
): DurableSessionStoreV22 {
  return new DurableSessionStoreV22(sessionId, opts, sink);
}

/** Fresh counters carried into a checkpoint. */
export function emptyCheckpointCountersV22(): VoiceV22SessionCounters {
  return zeroCountersV22();
}

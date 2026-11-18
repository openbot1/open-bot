/**
 * Resume engine v22 (voice v22, v1.35 Team T5).
 *
 * A dropped realtime session comes back in three steps:
 *
 *   1. Validate the resume token. A token names a session and
 *      the journal seq its checkpoint covered. Unknown tokens,
 *      tokens for another session, and expired tokens (older
 *      than the retention window) are refused — resuming from
 *      the wrong state is worse than starting fresh.
 *   2. Rehydrate from the checkpoint. Turns, transcript,
 *      pending reply, floor, profile and counters are restored
 *      as they were; every restored turn is marked `restored`
 *      so the panel and the eval can tell live history from
 *      recovered history.
 *   3. Replay the journal tail. Entries after the checkpoint
 *      seq are re-applied in order (transcript finals, turn
 *      changes, barge-ins, profile switches). A gap in the tail
 *      — entries lost between checkpoint and crash — is
 *      reported, not papered over: the resume result names the
 *      missing seqs so the session can ask the client to
 *      re-send the unfinalised transcript instead of inventing
 *      it.
 *
 * The engine is pure state: it owns no store and no transport.
 * The session hands it a checkpoint + journal tail and gets
 * back the rebuilt state plus a resume report.
 */
import {
  round2V22,
  resumeTokenV22,
  type VoiceV22Checkpoint,
  type VoiceV22EventSink,
  type VoiceV22Failure,
  type VoiceV22FloorHolder,
  type VoiceV22JournalEntry,
  type VoiceV22ReplyCut,
  type VoiceV22SessionCounters,
  type VoiceV22TranscriptSegment,
  type VoiceV22TurnRecord,
  type VoiceV22TurnState,
} from './types';

export interface VoiceV22ResumeOptions {
  /** Resume tokens older than this are expired (default 3_600_000 ms = 1 h). */
  tokenTtlMs: number;
  /** Max journal tail entries to replay (default 500). */
  maxReplayEntries: number;
  /** Max turns kept after replay (default 200). */
  maxTurns: number;
  /** Max transcript segments kept after replay (default 400). */
  maxTranscriptSegments: number;
}

export function defaultResumeV22Options(): VoiceV22ResumeOptions {
  return {
    tokenTtlMs: 3_600_000,
    maxReplayEntries: 500,
    maxTurns: 200,
    maxTranscriptSegments: 400,
  };
}

export function validateResumeV22Options(o: Partial<VoiceV22ResumeOptions>): string[] {
  const e: string[] = [];
  if (o.tokenTtlMs !== undefined && (o.tokenTtlMs < 60_000 || o.tokenTtlMs > 86_400_000)) {
    e.push('tokenTtlMs must be 60000..86400000');
  }
  if (o.maxReplayEntries !== undefined && (!Number.isInteger(o.maxReplayEntries) || o.maxReplayEntries < 1)) {
    e.push('maxReplayEntries must be a positive integer');
  }
  if (o.maxTurns !== undefined && (!Number.isInteger(o.maxTurns) || o.maxTurns < 1)) {
    e.push('maxTurns must be a positive integer');
  }
  if (o.maxTranscriptSegments !== undefined && (!Number.isInteger(o.maxTranscriptSegments) || o.maxTranscriptSegments < 1)) {
    e.push('maxTranscriptSegments must be a positive integer');
  }
  return e;
}

/** Outcome of one resume attempt. */
export type VoiceV22ResumeOutcome = 'resumed' | 'resumed-with-gaps' | 'fresh-start' | 'rejected';

export interface VoiceV22ResumeReport {
  outcome: VoiceV22ResumeOutcome;
  sessionId: string;
  atMs: number;
  /** Journal seq the rebuilt state covers. */
  coveredSeq: number;
  /** Journal entries replayed after the checkpoint. */
  replayedEntries: number;
  /** Seq numbers missing from the replayed tail (gaps). */
  missingSeqs: number[];
  /** Turns rebuilt (checkpoint + replay). */
  turns: number;
  /** Transcript segments rebuilt. */
  transcriptSegments: number;
  /** Pending reply carried across the resume (null when none). */
  pendingReply: VoiceV22ReplyCut | null;
  /** Unfinalised partial the client should re-send / confirm. */
  unfinalisedPartial: string;
  /** Human-readable explanation of the outcome. */
  reason: string;
  /** Failure record when the outcome is rejected. */
  failure?: VoiceV22Failure;
}

/** Rebuilt session state, handed back to the session. */
export interface VoiceV22RebuiltState {
  turnState: VoiceV22TurnState;
  floor: VoiceV22FloorHolder;
  profileId: string;
  turns: VoiceV22TurnRecord[];
  transcript: VoiceV22TranscriptSegment[];
  pendingReply: VoiceV22ReplyCut | null;
  unfinalisedPartial: string;
  counters: VoiceV22SessionCounters;
}

export interface VoiceV22ResumeStats {
  attempts: number;
  resumed: number;
  resumedWithGaps: number;
  freshStarts: number;
  rejected: number;
  totalReplayed: number;
  totalMissingSeqs: number;
}

/** Parse a resume token into session id + journal seq, or null. */
export function parseResumeTokenV22(token: string): { sessionId: string; journalSeq: number } | null {
  const m = /^v22-resume-(.+)-(\d+)$/.exec(token);
  if (m === null) return null;
  const journalSeq = Number.parseInt(m[2], 10);
  if (!Number.isInteger(journalSeq) || journalSeq < 0) return null;
  return { sessionId: m[1], journalSeq };
}

/**
 * Validate a token for a session at a wall time: right session,
 * right shape, and not expired (checkpoint age <= tokenTtlMs).
 * Returns error strings (empty = valid).
 */
export function validateResumeTokenV22(
  token: string,
  sessionId: string,
  checkpointCreatedAtMs: number,
  nowMs: number,
  opts: Partial<VoiceV22ResumeOptions> = {},
): string[] {
  const o = { ...defaultResumeV22Options(), ...opts };
  const e: string[] = [];
  const parsed = parseResumeTokenV22(token);
  if (parsed === null) {
    e.push('resume token is malformed');
    return e;
  }
  if (parsed.sessionId !== sessionId) e.push('resume token belongs to a different session');
  if (nowMs - checkpointCreatedAtMs > o.tokenTtlMs) e.push('resume token expired');
  if (nowMs < checkpointCreatedAtMs) e.push('resume token is from the future');
  return e;
}

/**
 * Find the missing seq numbers in a journal tail that should
 * run contiguously from `fromSeqExclusive + 1` to `toSeq`.
 */
export function findJournalGapsV22(entries: VoiceV22JournalEntry[], fromSeqExclusive: number, toSeq: number): number[] {
  const present = new Set(entries.map((e) => e.seq));
  const missing: number[] = [];
  for (let seq = fromSeqExclusive + 1; seq <= toSeq; seq += 1) {
    if (!present.has(seq)) missing.push(seq);
  }
  return missing;
}

/**
 * Merge a replayed transcript segment into the rebuilt list:
 * a final/corrected segment replaces the partial it names; a
 * restored segment keeps its `restored` status; duplicates by
 * id are ignored (replay must be idempotent).
 */
export function mergeTranscriptSegmentV22(
  list: VoiceV22TranscriptSegment[],
  segment: VoiceV22TranscriptSegment,
): VoiceV22TranscriptSegment[] {
  if (list.some((s) => s.id === segment.id)) return list;
  let next = list;
  if (segment.replacesId !== undefined) {
    next = list.filter((s) => s.id !== segment.replacesId);
  }
  return [...next, { ...segment }];
}

export class ResumeEngineV22 {
  private readonly opts: VoiceV22ResumeOptions;
  private readonly sink?: VoiceV22EventSink;
  private readonly sessionId: string;
  private attempts = 0;
  private resumed = 0;
  private resumedWithGaps = 0;
  private freshStarts = 0;
  private rejected = 0;
  private totalReplayed = 0;
  private totalMissingSeqs = 0;

  constructor(sessionId: string, opts: Partial<VoiceV22ResumeOptions> = {}, sink?: VoiceV22EventSink) {
    this.sessionId = sessionId;
    this.opts = { ...defaultResumeV22Options(), ...opts };
    this.sink = sink;
  }

  /**
   * Resume from a checkpoint plus the journal tail after it.
   * `tail` must be the entries with seq > checkpoint.journalSeq
   * (the store hands them out). The caller may pass an empty
   * tail when nothing happened after the checkpoint.
   */
  resume(
    checkpoint: VoiceV22Checkpoint | null,
    tail: VoiceV22JournalEntry[],
    token: string,
    atMs: number,
  ): { report: VoiceV22ResumeReport; state: VoiceV22RebuiltState | null } {
    this.attempts += 1;
    if (checkpoint === null) {
      this.freshStarts += 1;
      const report: VoiceV22ResumeReport = {
        outcome: 'fresh-start',
        sessionId: this.sessionId,
        atMs,
        coveredSeq: 0,
        replayedEntries: 0,
        missingSeqs: [],
        turns: 0,
        transcriptSegments: 0,
        pendingReply: null,
        unfinalisedPartial: '',
        reason: 'no checkpoint stored; starting a fresh session',
      };
      this.sink?.({ kind: 'resume', atMs, sessionId: this.sessionId, detail: { outcome: 'fresh-start' } });
      return { report, state: null };
    }
    const tokenErrors = validateResumeTokenV22(token, this.sessionId, checkpoint.createdAtMs, atMs, this.opts);
    if (tokenErrors.length > 0) {
      this.rejected += 1;
      const kind = tokenErrors.some((e) => e.includes('expired')) ? 'resume-token-expired' : 'resume-token-unknown';
      const report: VoiceV22ResumeReport = {
        outcome: 'rejected',
        sessionId: this.sessionId,
        atMs,
        coveredSeq: checkpoint.journalSeq,
        replayedEntries: 0,
        missingSeqs: [],
        turns: 0,
        transcriptSegments: 0,
        pendingReply: null,
        unfinalisedPartial: '',
        reason: tokenErrors.join('; '),
        failure: {
          kind,
          atMs,
          message: tokenErrors.join('; '),
          journalSeq: checkpoint.journalSeq,
          recoverable: false,
        },
      };
      this.sink?.({ kind: 'recovery-failed', atMs, sessionId: this.sessionId, detail: { reason: report.reason } });
      return { report, state: null };
    }

    // Rehydrate: every restored turn is marked so the panel can
    // distinguish recovered history from live history.
    const turns: VoiceV22TurnRecord[] = checkpoint.turns.map((t) => ({ ...t, restored: true }));
    let transcript: VoiceV22TranscriptSegment[] = checkpoint.transcript.map((s) => ({
      ...s,
      status: s.status === 'partial' ? 'restored' as const : s.status,
    }));
    let turnState = checkpoint.turnState;
    let floor: VoiceV22FloorHolder = checkpoint.floor;
    let profileId = checkpoint.profileId;
    let pendingReply: VoiceV22ReplyCut | null = checkpoint.pendingReply === null ? null : { ...checkpoint.pendingReply };
    let unfinalisedPartial = checkpoint.unfinalisedPartial;
    const counters: VoiceV22SessionCounters = { ...checkpoint.counters, resumes: checkpoint.counters.resumes + 1 };

    // Replay the tail in seq order; the tail is capped so a
    // runaway journal cannot stall the resume.
    const ordered = [...tail].sort((a, b) => a.seq - b.seq).slice(0, this.opts.maxReplayEntries);
    const maxTailSeq = ordered.length === 0 ? checkpoint.journalSeq : ordered[ordered.length - 1].seq;
    const missingSeqs = findJournalGapsV22(ordered, checkpoint.journalSeq, maxTailSeq);
    let replayed = 0;
    for (const entry of ordered) {
      replayed += 1;
      const d = entry.detail ?? {};
      switch (entry.kind) {
        case 'turn-state': {
          if (typeof d.to === 'string') turnState = d.to as VoiceV22TurnState;
          if (typeof d.floor === 'string') floor = d.floor as VoiceV22FloorHolder;
          break;
        }
        case 'transcript': {
          if (typeof d.text === 'string' && typeof d.segmentId === 'string') {
            const segment: VoiceV22TranscriptSegment = {
              id: d.segmentId,
              turnId: typeof d.turnId === 'string' ? d.turnId : `replayed-${entry.seq}`,
              text: d.text,
              status: d.status === 'final' ? 'final' : d.status === 'corrected' ? 'corrected' : 'partial',
              confidence: typeof d.confidence === 'number' ? d.confidence : 0.9,
              atMs: entry.atMs,
              throughSeq: typeof d.throughSeq === 'number' ? d.throughSeq : 0,
              ...(typeof d.replacesId === 'string' ? { replacesId: d.replacesId } : {}),
            };
            transcript = mergeTranscriptSegmentV22(transcript, segment);
            if (segment.status === 'final') unfinalisedPartial = '';
            else unfinalisedPartial = segment.text;
          }
          break;
        }
        case 'barge-in': {
          if (typeof d.cutRemaining === 'string' && pendingReply !== null) {
            pendingReply = { ...pendingReply, remaining: d.cutRemaining, remainingChars: d.cutRemaining.length };
          }
          break;
        }
        case 'profile-switch': {
          if (typeof d.profileId === 'string') profileId = d.profileId;
          break;
        }
        case 'disconnect':
        case 'reconnect':
        case 'recovery':
        case 'resume':
        case 'checkpoint':
        case 'session-open':
        case 'tts-chunk':
        case 'closed':
          break;
        default:
          break;
      }
    }
    // A session that was speaking when it dropped resumes in
    // `paused`: the agent must not keep talking at a user who
    // may have walked away. The host re-starts the reply.
    // A session that was paused (e.g. parked by the disconnect
    // itself) resumes in `listening`: resuming is an explicit
    // act of coming back, so the user is present. (else-if on
    // purpose: speaking must stay paused, never fall through.)
    if (turnState === 'speaking') {
      turnState = 'paused';
    } else if (turnState === 'paused') {
      turnState = 'listening';
      floor = 'user';
    }
    if (turnState === 'confirming') turnState = 'waiting';

    const state: VoiceV22RebuiltState = {
      turnState,
      floor,
      profileId,
      turns: turns.slice(-this.opts.maxTurns),
      transcript: transcript.slice(-this.opts.maxTranscriptSegments),
      pendingReply,
      unfinalisedPartial,
      counters,
    };
    const outcome: VoiceV22ResumeOutcome = missingSeqs.length > 0 ? 'resumed-with-gaps' : 'resumed';
    if (outcome === 'resumed') this.resumed += 1;
    else this.resumedWithGaps += 1;
    this.totalReplayed += replayed;
    this.totalMissingSeqs += missingSeqs.length;
    const report: VoiceV22ResumeReport = {
      outcome,
      sessionId: this.sessionId,
      atMs,
      coveredSeq: maxTailSeq,
      replayedEntries: replayed,
      missingSeqs,
      turns: state.turns.length,
      transcriptSegments: state.transcript.length,
      pendingReply,
      unfinalisedPartial,
      reason: missingSeqs.length > 0
        ? `resumed with ${missingSeqs.length} missing journal seq(s): ${missingSeqs.join(', ')}; re-send unfinalised transcript`
        : `resumed from checkpoint @seq ${checkpoint.journalSeq} + ${replayed} journal entries`,
    };
    this.sink?.({
      kind: 'resume',
      atMs,
      sessionId: this.sessionId,
      detail: { outcome, coveredSeq: maxTailSeq, replayed, missing: missingSeqs.length },
    });
    return { report, state };
  }

  /** Fresh-start state for a session with no checkpoint. */
  freshState(profileId: string): VoiceV22RebuiltState {
    return {
      turnState: 'idle',
      floor: 'none',
      profileId,
      turns: [],
      transcript: [],
      pendingReply: null,
      unfinalisedPartial: '',
      counters: {
        turns: 0, bargeIns: 0, ducks: 0, disconnects: 0,
        resumes: 0, recoveries: 0, profileSwitches: 0, ttsChunksSpoken: 0, checkpoints: 0,
      },
    };
  }

  /** Expected token for a checkpoint (what the client must present). */
  expectedToken(checkpoint: VoiceV22Checkpoint): string {
    return resumeTokenV22(this.sessionId, checkpoint.journalSeq);
  }

  stats(): VoiceV22ResumeStats {
    return {
      attempts: this.attempts,
      resumed: this.resumed,
      resumedWithGaps: this.resumedWithGaps,
      freshStarts: this.freshStarts,
      rejected: this.rejected,
      totalReplayed: this.totalReplayed,
      totalMissingSeqs: this.totalMissingSeqs,
    };
  }

  /** Resume success rate 0..1 (resumed / attempts, gaps count as success). */
  successRate(): number {
    if (this.attempts === 0) return 0;
    return round2V22((this.resumed + this.resumedWithGaps) / this.attempts);
  }

  summary(): string {
    const s = this.stats();
    return `resume: ${s.attempts} attempts, ${s.resumed} clean, ${s.resumedWithGaps} with gaps, ` +
      `${s.freshStarts} fresh starts, ${s.rejected} rejected, ${s.totalReplayed} entries replayed`;
  }
}

export function createResumeEngineV22(
  sessionId: string,
  opts: Partial<VoiceV22ResumeOptions> = {},
  sink?: VoiceV22EventSink,
): ResumeEngineV22 {
  return new ResumeEngineV22(sessionId, opts, sink);
}

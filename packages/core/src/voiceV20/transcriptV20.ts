/**
 * Transcript reconciliation v20 (voice v20, v1.28 Team T5).
 *
 * A streaming STT (mock) emits partial segments that revise
 * themselves word by word, then a final segment, and sometimes a
 * correction that rewrites an already-final segment (late
 * disambiguation, speaker fix). This module owns that mess:
 * partials replace their predecessors by id, finals commit, a
 * correction supersedes a final and keeps the audit trail, and a
 * speaker-change hint from the VAD re-attributes the open segment.
 * The committed transcript is the single source of truth the
 * session, the turn machine and the UI read from.
 *
 * Pure text bookkeeping, virtual clock, mock transcripts only.
 */
import type { VoiceV20TranscriptSegment, VoiceV20TranscriptStatus } from './types';

export type TranscriptV20EventKind =
  | 'partial'
  | 'final'
  | 'corrected'
  | 'superseded'
  | 'speaker-change'
  | 'pruned';
export type TranscriptV20Event = {
  kind: TranscriptV20EventKind;
  atMs: number;
  detail?: Record<string, unknown>;
};
export type TranscriptV20EventSink = (event: TranscriptV20Event) => void;

export interface TranscriptV20Options {
  /** Max committed segments kept before the oldest are pruned. */
  maxCommittedSegments: number;
  /** Max open (partial) segments tracked at once. */
  maxOpenSegments: number;
  /** Min confidence for a partial to be shown at all. */
  minPartialConfidence: number;
  /** A final below this confidence is kept but flagged low-confidence. */
  lowConfidenceThreshold: number;
  /** Max characters kept in the live (rendered) text window. */
  maxLiveChars: number;
}

export function defaultTranscriptV20Options(): TranscriptV20Options {
  return {
    maxCommittedSegments: 200,
    maxOpenSegments: 8,
    minPartialConfidence: 0.15,
    lowConfidenceThreshold: 0.55,
    maxLiveChars: 4000,
  };
}

export function validateTranscriptV20Options(o: Partial<TranscriptV20Options>): string[] {
  const e: string[] = [];
  if (o.maxCommittedSegments !== undefined && o.maxCommittedSegments < 1) e.push('maxCommittedSegments must be >= 1');
  if (o.maxOpenSegments !== undefined && o.maxOpenSegments < 1) e.push('maxOpenSegments must be >= 1');
  if (o.minPartialConfidence !== undefined && (o.minPartialConfidence < 0 || o.minPartialConfidence > 1)) e.push('minPartialConfidence must be 0..1');
  if (o.lowConfidenceThreshold !== undefined && (o.lowConfidenceThreshold < 0 || o.lowConfidenceThreshold > 1)) e.push('lowConfidenceThreshold must be 0..1');
  if (o.maxLiveChars !== undefined && o.maxLiveChars < 100) e.push('maxLiveChars must be >= 100');
  return e;
}

export interface TranscriptV20Committed extends VoiceV20TranscriptSegment {
  /** Ids of segments this one replaced (partials, then the final it corrected). */
  supersedes: string[];
  /** Speaker label assigned at commit time, e.g. 'user', 'user-2'. */
  speaker: string;
  /** True when confidence fell below the low-confidence threshold. */
  lowConfidence: boolean;
}

export interface TranscriptV20Stats {
  partials: number;
  finals: number;
  corrections: number;
  superseded: number;
  pruned: number;
  droppedLowConfidencePartials: number;
  committed: number;
  open: number;
  wordsCommitted: number;
  lowConfidenceFinals: number;
}

export type TranscriptV20LiveView = {
  /** Committed text, oldest first, trimmed to maxLiveChars. */
  committedText: string;
  /** The newest open partial, if any. */
  openPartial: string;
  /** Full live text = committed + open partial. */
  text: string;
};

/** Count words the way the UI does: whitespace-separated tokens. */
export function countTranscriptWordsV20(text: string): number {
  const t = text.trim();
  return t === '' ? 0 : t.split(/\s+/).length;
}

/**
 * Word-level diff between an old partial and its replacement:
 * returns the shared prefix length in words, so the UI can keep
 * the stable prefix and only repaint the tail.
 */
export function transcriptStablePrefixWordsV20(oldText: string, newText: string): number {
  const a = oldText.trim() === '' ? [] : oldText.trim().split(/\s+/);
  const b = newText.trim() === '' ? [] : newText.trim().split(/\s+/);
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n += 1;
  return n;
}

/** True when the new text only extends the old text (no rewrite). */
export function isTranscriptExtensionV20(oldText: string, newText: string): boolean {
  if (oldText.trim() === '') return true;
  const a = oldText.trim().split(/\s+/);
  const b = newText.trim().split(/\s+/);
  if (b.length < a.length) return false;
  return a.every((w, i) => b[i] === w);
}

export class TranscriptReconcilerV20 {
  private opts: TranscriptV20Options;
  private sink?: TranscriptV20EventSink;
  private open = new Map<string, VoiceV20TranscriptSegment>();
  private committed: TranscriptV20Committed[] = [];
  private stats: TranscriptV20Stats = {
    partials: 0, finals: 0, corrections: 0, superseded: 0, pruned: 0,
    droppedLowConfidencePartials: 0, committed: 0, open: 0, wordsCommitted: 0, lowConfidenceFinals: 0,
  };

  constructor(opts: Partial<TranscriptV20Options> = {}, sink?: TranscriptV20EventSink) {
    this.opts = { ...defaultTranscriptV20Options(), ...opts };
    this.sink = sink;
  }

  get options(): TranscriptV20Options { return { ...this.opts }; }
  getStats(): TranscriptV20Stats {
    return { ...this.stats, committed: this.committed.length, open: this.open.size };
  }
  getCommitted(): TranscriptV20Committed[] { return [...this.committed]; }
  getOpen(): VoiceV20TranscriptSegment[] { return [...this.open.values()]; }

  /** Feed one segment from the (mock) STT. Returns the committed record, if it committed. */
  ingest(segment: VoiceV20TranscriptSegment): TranscriptV20Committed | null {
    if (segment.status === 'partial') return this.ingestPartial(segment);
    if (segment.status === 'final') return this.ingestFinal(segment);
    return this.ingestCorrection(segment);
  }

  private ingestPartial(segment: VoiceV20TranscriptSegment): null {
    if (segment.confidence < this.opts.minPartialConfidence) {
      this.stats.droppedLowConfidencePartials += 1;
      return null;
    }
    const prev = this.open.get(segment.id);
    if (prev && segment.throughSeq < prev.throughSeq) {
      // Stale partial arriving after a newer one: ignore it.
      return null;
    }
    if (this.open.size >= this.opts.maxOpenSegments && !this.open.has(segment.id)) {
      // Evict the oldest open partial to stay bounded.
      const oldest = this.open.keys().next().value;
      if (oldest !== undefined) this.open.delete(oldest);
    }
    this.open.set(segment.id, { ...segment });
    this.stats.partials += 1;
    this.sink?.({ kind: 'partial', atMs: segment.atMs, detail: { id: segment.id, turnId: segment.turnId } });
    return null;
  }

  private ingestFinal(segment: VoiceV20TranscriptSegment): TranscriptV20Committed {
    const supersedes: string[] = [];
    const open = this.open.get(segment.id);
    if (open) {
      supersedes.push(open.id);
      this.open.delete(segment.id);
      this.stats.superseded += 1;
    }
    // Any other open partial of the same turn is superseded too:
    // the final closes the turn's open window.
    for (const [id, other] of [...this.open.entries()]) {
      if (other.turnId === segment.turnId) {
        supersedes.push(id);
        this.open.delete(id);
        this.stats.superseded += 1;
        this.sink?.({ kind: 'superseded', atMs: segment.atMs, detail: { id, by: segment.id } });
      }
    }
    const record: TranscriptV20Committed = {
      ...segment,
      status: 'final',
      supersedes,
      speaker: 'user',
      lowConfidence: segment.confidence < this.opts.lowConfidenceThreshold,
    };
    this.committed.push(record);
    this.stats.finals += 1;
    this.stats.wordsCommitted += countTranscriptWordsV20(segment.text);
    if (record.lowConfidence) this.stats.lowConfidenceFinals += 1;
    this.sink?.({ kind: 'final', atMs: segment.atMs, detail: { id: segment.id, turnId: segment.turnId } });
    this.prune();
    return record;
  }

  private ingestCorrection(segment: VoiceV20TranscriptSegment): TranscriptV20Committed | null {
    const targetId = segment.replacesId;
    const idx = targetId ? this.committed.findIndex((c) => c.id === targetId) : -1;
    if (idx < 0) {
      // Correction for something we never committed (pruned or
      // unknown): treat it as a fresh final so the text is not lost.
      return this.ingestFinal({ ...segment, status: 'final', replacesId: undefined });
    }
    const target = this.committed[idx];
    const record: TranscriptV20Committed = {
      ...segment,
      status: 'corrected',
      supersedes: [...target.supersedes, target.id],
      speaker: target.speaker,
      lowConfidence: segment.confidence < this.opts.lowConfidenceThreshold,
    };
    this.stats.wordsCommitted += countTranscriptWordsV20(segment.text) - countTranscriptWordsV20(target.text);
    this.committed[idx] = record;
    this.stats.corrections += 1;
    this.sink?.({ kind: 'corrected', atMs: segment.atMs, detail: { id: segment.id, replaces: target.id } });
    return record;
  }

  /** Re-attribute the newest open segment (and the last committed one) to a new speaker. */
  noteSpeakerChange(atMs: number, speaker: string): void {
    let changed = false;
    for (const seg of this.open.values()) {
      if (seg.turnId) { changed = true; }
    }
    const last = this.committed[this.committed.length - 1];
    if (last && last.speaker !== speaker) {
      last.speaker = speaker;
      changed = true;
    }
    if (changed) {
      this.sink?.({ kind: 'speaker-change', atMs, detail: { speaker } });
    }
  }

  /** Live text for the UI: committed tail + newest open partial. */
  liveView(): TranscriptV20LiveView {
    let committedText = this.committed.map((c) => c.text).join(' ');
    if (committedText.length > this.opts.maxLiveChars) {
      committedText = '…' + committedText.slice(committedText.length - this.opts.maxLiveChars);
    }
    const openSegs = [...this.open.values()].sort((a, b) => a.atMs - b.atMs);
    const openPartial = openSegs.length > 0 ? openSegs[openSegs.length - 1].text : '';
    const text = openPartial ? `${committedText} ${openPartial}`.trim() : committedText;
    return { committedText, openPartial, text };
  }

  /** Committed segments for one turn, in order. */
  segmentsForTurn(turnId: string): TranscriptV20Committed[] {
    return this.committed.filter((c) => c.turnId === turnId);
  }

  /** Full committed transcript as one string. */
  fullText(): string {
    return this.committed.map((c) => c.text).join(' ').trim();
  }

  private prune(): void {
    while (this.committed.length > this.opts.maxCommittedSegments) {
      this.committed.shift();
      this.stats.pruned += 1;
      this.sink?.({ kind: 'pruned', atMs: Date.now(), detail: { kept: this.committed.length } });
    }
  }

  reset(): void {
    this.open.clear();
    this.committed = [];
  }
}

export function createTranscriptReconcilerV20(
  opts: Partial<TranscriptV20Options> = {},
  sink?: TranscriptV20EventSink,
): TranscriptReconcilerV20 {
  return new TranscriptReconcilerV20(opts, sink);
}

export function transcriptV20Summary(r: TranscriptReconcilerV20): string {
  const s = r.getStats();
  return `Transcript v20: ${s.finals} finals, ${s.partials} partials, ${s.corrections} corrections, ` +
    `${s.superseded} superseded, ${s.wordsCommitted} words, ${s.lowConfidenceFinals} low-confidence finals`;
}

export function transcriptV20Markdown(r: TranscriptReconcilerV20): string {
  const s = r.getStats();
  return `# Transcript v20\n\n- Finals: ${s.finals}\n- Partials: ${s.partials}\n- Corrections: ${s.corrections}\n` +
    `- Superseded: ${s.superseded}\n- Pruned: ${s.pruned}\n- Words committed: ${s.wordsCommitted}\n` +
    `- Low-confidence finals: ${s.lowConfidenceFinals}\n- Committed segments: ${s.committed}\n- Open segments: ${s.open}\n`;
}

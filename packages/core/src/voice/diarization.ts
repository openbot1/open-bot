/**
 * Basic speaker diarization (v1.06, Đội T4 — voice realtime v5).
 *
 * "Who is speaking?" for a voice session, without a cloud model
 * and without a microphone: every finished speech segment gets a
 * small voice embedding computed locally from its PCM, and the
 * embedding is matched against the speakers seen so far in this
 * session.
 *
 * How it works:
 *
 *   - `extractVoiceEmbedding(frame, sampleRateHz)`: a 15-number
 *     voice fingerprint — log-energy in 12 frequency bands
 *     (Goertzel at 100–4800 Hz, denser below 1 kHz where voice
 *     fundamentals live, relative to the strongest band),
 *     zero-crossing rate, a pitch estimate (autocorrelation lag
 *     for 80–400 Hz) and RMS. The vector is L2-normalised, so
 *     loudness does not change identity. Two sine tones at
 *     different pitches produce clearly different embeddings;
 *     the same tone twice produces (near-)identical ones.
 *   - `DiarizationSession`: holds the speakers of one call.
 *     `identify()` matches a segment embedding to the nearest
 *     profile by cosine distance (below `matchThreshold`) or
 *     creates `speaker-N`. Profiles are running means — each new
 *     segment nudges the profile toward the speaker — and carry
 *     turn counts, total speech ms and first/last-seen times.
 *     `renameSpeaker()` gives a speaker a display name ("Huy",
 *     "Khách"); `mergeSpeakers()` folds a split speaker back
 *     into one. Turns are recorded with `noteTurn()` and read
 *     back as a diarized transcript (`getTranscript()`), which
 *     the transcript tool renders.
 *   - `FileSpeakerProfileStore`: persist a session's profiles as
 *     JSON under a directory (local only — embeddings never
 *     leave the machine). A later call can reload them so a
 *     returning speaker keeps their name.
 *
 * Limits, stated plainly: this is energy/spectral matching, not
 * a neural speaker-embedding model. It separates voices that
 * differ in pitch/timbre well (different people, different
 * pitch) and can confuse similar voices, overlapping speech or
 * very short segments (< 200 ms). The threshold and the profile
 * update rate are tunable per session for that reason.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { isValidPcm16Frame, pcm16Sample } from './audio';

/** Frequencies (Hz) of the 12 embedding bands (denser below 1 kHz, where voice fundamentals live). */
export const DIARIZATION_BAND_FREQUENCIES_HZ = [100, 150, 200, 300, 400, 600, 800, 1200, 1600, 2400, 3200, 4800] as const;
/** Embedding length: 12 bands + zero-crossing rate + pitch + RMS. */
export const DIARIZATION_EMBEDDING_SIZE = 15;
/** Default cosine-distance ceiling for "same speaker". */
export const DIARIZATION_DEFAULT_MATCH_THRESHOLD = 0.25;
/** Default max speakers per session (9th voice joins the nearest). */
export const DIARIZATION_DEFAULT_MAX_SPEAKERS = 8;
/** Default profile update rate (0..1) per matched segment. */
export const DIARIZATION_DEFAULT_UPDATE_RATE = 0.2;
/** Speaker id prefix. */
export const DIARIZATION_SPEAKER_PREFIX = 'speaker-';

/** A speaker seen in a session. */
export interface SpeakerProfile {
  /** Stable id (`speaker-1`, `speaker-2`, ...). */
  id: string;
  /** Display label — the id until renamed. */
  label: string;
  /** Optional display name set by the user / agent. */
  displayName?: string;
  /** Running-mean voice embedding (L2-normalised). */
  embedding: number[];
  /** Segments attributed to this speaker. */
  turns: number;
  /** Total speech ms attributed to this speaker. */
  totalMs: number;
  /** ms (session clock) this speaker was first seen. */
  firstSeenAtMs: number;
  /** ms (session clock) this speaker was last seen. */
  lastSeenAtMs: number;
}

/** One diarized transcript turn. */
export interface DiarizedTurn {
  /** Turn index (0-based, per session). */
  index: number;
  speakerId: string;
  /** Label at commit time (display name when set, else the id). */
  speakerLabel: string;
  /** Transcript text (empty until STT attaches it). */
  text: string;
  startedAtMs: number;
  endedAtMs: number;
  /** Segment duration (ms). */
  durationMs: number;
  /** Peak RMS of the segment. */
  peakRms: number;
  /** Cosine distance to the matched profile (0 = identical). */
  matchDistance: number;
  /** True when this turn created a new speaker. */
  isNewSpeaker: boolean;
}

/** Result of identifying one segment. */
export interface SpeakerIdentification {
  speakerId: string;
  isNew: boolean;
  /** Cosine distance to the matched profile. */
  distance: number;
  /** 0..1 confidence (1 - distance, clamped). */
  confidence: number;
}

/** Options for `DiarizationSession`. */
export interface DiarizationOptions {
  sampleRateHz?: number;
  matchThreshold?: number;
  maxSpeakers?: number;
  updateRate?: number;
}

/** Goertzel power at one frequency for a PCM16 frame. */
function goertzelPower(frame: Uint8Array, sampleRateHz: number, freqHz: number): number {
  const n = frame.length / 2;
  const k = Math.round((n * freqHz) / sampleRateHz);
  const omega = (2 * Math.PI * k) / n;
  const coeff = 2 * Math.cos(omega);
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < n; i++) {
    // Hann window: without it, a pure tone at an integer frequency
    // over an exact-second window has a perfect DFT delta — every
    // off-bin reads exactly zero and all bands look identical.
    // The window spreads the tone's energy into neighbouring
    // bins, so different pitches give different band patterns.
    const w = 0.5 * (1 - Math.cos((2 * Math.PI * i) / Math.max(1, n - 1)));
    const s0 = pcm16Sample(frame, i) * w + coeff * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  const power = s1 * s1 + s2 * s2 - coeff * s1 * s2;
  return Math.max(0, power) / (n * n);
}

/** Zero-crossing rate (0..1) of a PCM16 frame. */
function zeroCrossingRate(frame: Uint8Array): number {
  const n = frame.length / 2;
  if (n < 2) return 0;
  let crossings = 0;
  let prev = pcm16Sample(frame, 0);
  for (let i = 1; i < n; i++) {
    const cur = pcm16Sample(frame, i);
    if ((prev >= 0 && cur < 0) || (prev < 0 && cur >= 0)) crossings += 1;
    prev = cur;
  }
  return crossings / (n - 1);
}

/**
 * Pitch estimate (Hz) by autocorrelation over 80–400 Hz. Returns
 * 0 when no clear periodicity is found (noise / silence).
 */
function estimatePitchHz(frame: Uint8Array, sampleRateHz: number): number {
  const n = frame.length / 2;
  if (n < 64) return 0;
  const minLag = Math.max(2, Math.floor(sampleRateHz / 400));
  const maxLag = Math.min(Math.floor(n / 2), Math.ceil(sampleRateHz / 80));
  let bestLag = 0;
  let bestCorr = 0;
  let energy = 0;
  for (let i = 0; i < n; i++) {
    const s = pcm16Sample(frame, i);
    energy += s * s;
  }
  if (energy <= 0) return 0;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let corr = 0;
    for (let i = 0; i < n - lag; i++) {
      corr += pcm16Sample(frame, i) * pcm16Sample(frame, i + lag);
    }
    corr /= energy;
    if (corr > bestCorr) {
      bestCorr = corr;
      bestLag = lag;
    }
  }
  if (bestCorr < 0.3 || bestLag === 0) return 0;
  return sampleRateHz / bestLag;
}

/**
 * Voice embedding for a PCM16 segment: 12 log band energies
 * (relative to the strongest band, so loudness does not change
 * identity) + zero-crossing rate + normalised pitch + RMS,
 * L2-normalised. Throws on an invalid frame. Deterministic for
 * the same audio.
 */
export function extractVoiceEmbedding(frame: Uint8Array, sampleRateHz = 16000): number[] {
  if (!isValidPcm16Frame(frame)) {
    throw new Error('extractVoiceEmbedding: frame must be a non-empty even-length PCM16 buffer.');
  }
  const powers = DIARIZATION_BAND_FREQUENCIES_HZ.map((freq) => goertzelPower(frame, sampleRateHz, freq));
  // Relative energies: a band's share of the strongest band, in
  // log space. An absolute floor (log10(power + 1e-9)) would drown
  // every band — Goertzel leakage powers are far below 1e-9.
  const maxPower = Math.max(...powers, 1e-18);
  const bands = powers.map((power) => Math.log10(power / maxPower + 1e-6) + 6);
  const zcr = zeroCrossingRate(frame);
  const pitch = estimatePitchHz(frame, sampleRateHz);
  const pitchNorm = pitch > 0 ? (pitch - 80) / 320 : 0;
  let rms = 0;
  const n = frame.length / 2;
  for (let i = 0; i < n; i++) {
    const s = pcm16Sample(frame, i);
    rms += s * s;
  }
  rms = Math.sqrt(rms / Math.max(1, n));
  const raw = [...bands, zcr * 4, pitchNorm * 4, rms * 4];
  const norm = Math.sqrt(raw.reduce((sum, v) => sum + v * v, 0)) || 1;
  return raw.map((v) => v / norm);
}

/** Cosine distance (0 = identical, 2 = opposite) between embeddings. */
export function embeddingDistance(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length) {
    throw new Error(`embeddingDistance: length mismatch ${a.length} vs ${b.length}.`);
  }
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const av = a[i] as number;
    const bv = b[i] as number;
    dot += av * bv;
    normA += av * av;
    normB += bv * bv;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  if (denom === 0) return 1;
  // Clamp: float rounding can push the cosine a hair past 1 and
  // yield a tiny negative distance for identical vectors.
  return Math.max(0, Math.min(2, 1 - dot / denom));
}

function cloneEmbedding(embedding: readonly number[]): number[] {
  return [...embedding];
}

/**
 * One session's speakers + diarized turns. Pure in-memory state;
 * serialise with `toJSON()` / `fromJSON()` for the file store.
 */
export class DiarizationSession {
  private readonly sampleRateHz: number;
  private readonly matchThreshold: number;
  private readonly maxSpeakers: number;
  private readonly updateRate: number;
  private speakers: SpeakerProfile[] = [];
  private turns: DiarizedTurn[] = [];
  private nextSpeaker = 1;

  constructor(options: DiarizationOptions = {}) {
    this.sampleRateHz = options.sampleRateHz ?? 16000;
    this.matchThreshold = options.matchThreshold ?? DIARIZATION_DEFAULT_MATCH_THRESHOLD;
    this.maxSpeakers = options.maxSpeakers ?? DIARIZATION_DEFAULT_MAX_SPEAKERS;
    this.updateRate = options.updateRate ?? DIARIZATION_DEFAULT_UPDATE_RATE;
  }

  get sampleRate(): number {
    return this.sampleRateHz;
  }

  /** Speakers seen so far (most turns first). */
  listSpeakers(): SpeakerProfile[] {
    return [...this.speakers]
      .sort((a, b) => b.turns - a.turns || a.firstSeenAtMs - b.firstSeenAtMs)
      .map((s) => ({ ...s, embedding: cloneEmbedding(s.embedding) }));
  }

  getSpeaker(id: string): SpeakerProfile | undefined {
    const found = this.speakers.find((s) => s.id === id);
    return found ? { ...found, embedding: cloneEmbedding(found.embedding) } : undefined;
  }

  /** Display label for a speaker (display name when set, else id). */
  speakerLabel(id: string): string {
    const found = this.speakers.find((s) => s.id === id);
    if (!found) return id;
    return found.displayName ?? found.label;
  }

  /**
   * Identify one finished speech segment. `audio` is the segment's
   * PCM (any length); `atMs`/`durationMs` come from the VAD turn.
   * Returns the speaker id + whether a new speaker was created.
   */
  identify(input: {
    audio: Uint8Array;
    startedAtMs: number;
    endedAtMs: number;
    peakRms?: number;
  }): SpeakerIdentification {
    const embedding = extractVoiceEmbedding(input.audio, this.sampleRateHz);
    return this.identifyEmbedding(embedding, input);
  }

  /** Same as `identify()`, but the caller computed the embedding. */
  identifyEmbedding(
    embedding: readonly number[],
    input: { startedAtMs: number; endedAtMs: number; peakRms?: number },
  ): SpeakerIdentification {
    if (embedding.length !== DIARIZATION_EMBEDDING_SIZE) {
      throw new Error(
        `identifyEmbedding: expected ${DIARIZATION_EMBEDDING_SIZE} numbers, got ${embedding.length}.`,
      );
    }
    let best: SpeakerProfile | undefined;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const speaker of this.speakers) {
      const distance = embeddingDistance(embedding, speaker.embedding);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = speaker;
      }
    }
    const durationMs = Math.max(0, input.endedAtMs - input.startedAtMs);
    if (best && bestDistance <= this.matchThreshold) {
      // Running mean: the profile follows the speaker slowly.
      for (let i = 0; i < best.embedding.length; i++) {
        best.embedding[i] = (best.embedding[i] as number) * (1 - this.updateRate) +
          (embedding[i] as number) * this.updateRate;
      }
      const norm = Math.sqrt(best.embedding.reduce((sum, v) => sum + v * v, 0)) || 1;
      best.embedding = best.embedding.map((v) => v / norm);
      best.turns += 1;
      best.totalMs += durationMs;
      best.lastSeenAtMs = input.endedAtMs;
      return {
        speakerId: best.id,
        isNew: false,
        distance: bestDistance,
        confidence: Math.max(0, Math.min(1, 1 - bestDistance)),
      };
    }
    if (this.speakers.length >= this.maxSpeakers && best) {
      // Cap reached: attribute to the nearest speaker and note it
      // with the (large) distance — better than inventing a 9th.
      best.turns += 1;
      best.totalMs += durationMs;
      best.lastSeenAtMs = input.endedAtMs;
      return {
        speakerId: best.id,
        isNew: false,
        distance: bestDistance,
        confidence: Math.max(0, Math.min(1, 1 - bestDistance)),
      };
    }
    const id = `${DIARIZATION_SPEAKER_PREFIX}${this.nextSpeaker}`;
    this.nextSpeaker += 1;
    this.speakers.push({
      id,
      label: id,
      embedding: cloneEmbedding(embedding),
      turns: 1,
      totalMs: durationMs,
      firstSeenAtMs: input.startedAtMs,
      lastSeenAtMs: input.endedAtMs,
    });
    return {
      speakerId: id,
      isNew: true,
      distance: best ? bestDistance : 1,
      confidence: best ? Math.max(0, Math.min(1, 1 - bestDistance)) : 1,
    };
  }

  /**
   * Record a transcript turn for a segment already identified
   * (or identify + record in one call via `audio`). Text may be
   * attached later with `attachText()`.
   */
  noteTurn(input: {
    speakerId: string;
    text?: string;
    startedAtMs: number;
    endedAtMs: number;
    peakRms?: number;
    matchDistance?: number;
    isNewSpeaker?: boolean;
  }): DiarizedTurn {
    const turn: DiarizedTurn = {
      index: this.turns.length,
      speakerId: input.speakerId,
      speakerLabel: this.speakerLabel(input.speakerId),
      text: input.text ?? '',
      startedAtMs: input.startedAtMs,
      endedAtMs: input.endedAtMs,
      durationMs: Math.max(0, input.endedAtMs - input.startedAtMs),
      peakRms: input.peakRms ?? 0,
      matchDistance: input.matchDistance ?? 0,
      isNewSpeaker: input.isNewSpeaker ?? false,
    };
    this.turns.push(turn);
    return { ...turn };
  }

  /** Attach / replace STT text for a turn (by index). */
  attachText(index: number, text: string): DiarizedTurn | null {
    const turn = this.turns[index];
    if (!turn) return null;
    turn.text = text;
    return { ...turn };
  }

  /** Attach text to the most recent turn without text. */
  attachTextToLatest(text: string): DiarizedTurn | null {
    for (let i = this.turns.length - 1; i >= 0; i--) {
      const turn = this.turns[i] as DiarizedTurn;
      if (turn.text === '') {
        turn.text = text;
        return { ...turn };
      }
    }
    return null;
  }

  getTranscript(): DiarizedTurn[] {
    return this.turns.map((t) => ({ ...t }));
  }

  /** Rename a speaker (display name). Returns false when unknown. */
  renameSpeaker(id: string, displayName: string): boolean {
    const found = this.speakers.find((s) => s.id === id);
    if (!found) return false;
    const name = displayName.trim();
    if (name === '') return false;
    found.displayName = name.slice(0, 80);
    for (const turn of this.turns) {
      if (turn.speakerId === id) turn.speakerLabel = found.displayName;
    }
    return true;
  }

  /**
   * Merge speaker `fromId` into `toId` (the same person was split
   * into two profiles): turns + totals move, the profile becomes
   * the turn-weighted mean. Returns false when either is unknown.
   */
  mergeSpeakers(fromId: string, toId: string): boolean {
    if (fromId === toId) return false;
    const from = this.speakers.find((s) => s.id === fromId);
    const to = this.speakers.find((s) => s.id === toId);
    if (!from || !to) return false;
    const totalTurns = from.turns + to.turns;
    const weight = totalTurns > 0 ? from.turns / totalTurns : 0.5;
    for (let i = 0; i < to.embedding.length; i++) {
      to.embedding[i] = (to.embedding[i] as number) * (1 - weight) +
        (from.embedding[i] as number) * weight;
    }
    const norm = Math.sqrt(to.embedding.reduce((sum, v) => sum + v * v, 0)) || 1;
    to.embedding = to.embedding.map((v) => v / norm);
    to.turns = totalTurns;
    to.totalMs += from.totalMs;
    to.firstSeenAtMs = Math.min(to.firstSeenAtMs, from.firstSeenAtMs);
    to.lastSeenAtMs = Math.max(to.lastSeenAtMs, from.lastSeenAtMs);
    this.speakers = this.speakers.filter((s) => s.id !== fromId);
    for (const turn of this.turns) {
      if (turn.speakerId === fromId) {
        turn.speakerId = toId;
        turn.speakerLabel = this.speakerLabel(toId);
      }
    }
    return true;
  }

  reset(): void {
    this.speakers = [];
    this.turns = [];
    this.nextSpeaker = 1;
  }

  toJSON(): {
    version: 1;
    speakers: SpeakerProfile[];
    turns: DiarizedTurn[];
    nextSpeaker: number;
  } {
    return {
      version: 1,
      speakers: this.listSpeakers(),
      turns: this.getTranscript(),
      nextSpeaker: this.nextSpeaker,
    };
  }

  static fromJSON(data: unknown): DiarizationSession {
    const session = new DiarizationSession();
    if (!data || typeof data !== 'object') return session;
    const d = data as { speakers?: unknown; turns?: unknown; nextSpeaker?: unknown };
    if (Array.isArray(d.speakers)) {
      session.speakers = (d.speakers as SpeakerProfile[]).filter(
        (s) =>
          s &&
          typeof s.id === 'string' &&
          Array.isArray(s.embedding) &&
          s.embedding.length === DIARIZATION_EMBEDDING_SIZE,
      );
    }
    if (Array.isArray(d.turns)) {
      session.turns = (d.turns as DiarizedTurn[]).filter(
        (t) => t && typeof t.speakerId === 'string' && typeof t.index === 'number',
      );
    }
    if (typeof d.nextSpeaker === 'number' && Number.isInteger(d.nextSpeaker) && d.nextSpeaker > 0) {
      session.nextSpeaker = d.nextSpeaker;
    } else if (session.speakers.length > 0) {
      const max = Math.max(
        ...session.speakers.map((s) => Number.parseInt(s.id.replace(DIARIZATION_SPEAKER_PREFIX, ''), 10) || 0),
      );
      session.nextSpeaker = max + 1;
    }
    return session;
  }
}

/** Short markdown rendering of a diarized transcript. */
export function diarizedTranscriptMarkdown(turns: readonly DiarizedTurn[]): string {
  if (turns.length === 0) return '_No transcript turns yet._';
  const lines = ['## Diarized transcript', ''];
  for (const turn of turns) {
    const stamp = `${(turn.startedAtMs / 1000).toFixed(1)}s–${(turn.endedAtMs / 1000).toFixed(1)}s`;
    const text = turn.text === '' ? '_(no text yet)_' : turn.text;
    lines.push(`- **${turn.speakerLabel}** [${stamp}]: ${text}`);
  }
  return lines.join('\n');
}

function sanitizeFileName(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 80) || 'session';
}

/**
 * File-backed store for speaker profiles (one JSON file per
 * session id). Local only. Corrupt files are ignored on read
 * (empty session) rather than crashing the call.
 */
export class FileSpeakerProfileStore {
  private readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

  private fileFor(sessionId: string): string {
    return path.join(this.dir, `${sanitizeFileName(sessionId)}.speakers.json`);
  }

  save(sessionId: string, session: DiarizationSession): void {
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(this.fileFor(sessionId), JSON.stringify(session.toJSON(), null, 2), 'utf8');
  }

  load(sessionId: string): DiarizationSession | null {
    try {
      const raw = fs.readFileSync(this.fileFor(sessionId), 'utf8');
      return DiarizationSession.fromJSON(JSON.parse(raw) as unknown);
    } catch {
      return null;
    }
  }

  delete(sessionId: string): boolean {
    try {
      fs.unlinkSync(this.fileFor(sessionId));
      return true;
    } catch {
      return false;
    }
  }
}

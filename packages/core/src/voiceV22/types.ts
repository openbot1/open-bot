/**
 * Shared types for voice realtime v22 (v1.35, Team T5).
 *
 * Durable realtime voice sessions: a session that survives a
 * dropped transport, resumes from a checkpoint, keeps the
 * half-heard transcript and the cut reply, arbitrates the floor
 * between user and agent, and speaks in the voice profile the
 * user picked. All clocks virtual, all audio mock/synthetic,
 * no network, no key, no mic/sound card.
 *
 * v22 builds on v21 without touching it: v21 owns the
 * single-connection realtime loop (intent → tool call → TTS);
 * v22 owns durability around that loop — the store, the resume,
 * the recovery, the profiles and the floor. A v22 session wraps
 * the same turn/barge-in/TTS vocabulary and adds a journal so
 * every state change can be replayed after a crash.
 */
export type VoiceV22Clock = { nowMs: number };

/** Durability phase of a realtime session. */
export type VoiceV22DurabilityPhase =
  | 'live'
  | 'degraded'
  | 'disconnected'
  | 'reconnecting'
  | 'resuming'
  | 'recovered'
  | 'closed';

/** Turn-taking state of a durable session (extends the v21 set). */
export type VoiceV22TurnState =
  | 'idle'
  | 'listening'
  | 'speaking'
  | 'waiting'
  | 'confirming'
  | 'yielded'
  | 'paused';

export type VoiceV22TurnRole = 'user' | 'agent' | 'system';

/** Who currently holds the conversational floor. */
export type VoiceV22FloorHolder = 'user' | 'agent' | 'none';

export interface VoiceV22TurnRecord {
  id: string;
  role: VoiceV22TurnRole;
  text: string;
  atMs: number;
  durationMs: number;
  /** True when this agent turn was cut short by a barge-in. */
  bargeInCut?: boolean;
  /** True when the turn was restored from a checkpoint, not live. */
  restored?: boolean;
  /** Tool call this turn produced, if any. */
  toolCallId?: string;
  /** Voice profile id that spoke this turn (agent turns). */
  profileId?: string;
}

/** One audio frame (20 ms @ 16 kHz, PCM16) from the mock capture layer. */
export interface VoiceV22Frame {
  seq: number;
  atMs: number;
  samples: Int16Array;
  /** 0..1 speech energy hint supplied by the (mock) capture layer. */
  energy?: number;
  /** True when the frame is known to be agent echo, not user speech. */
  echo?: boolean;
}

export type VoiceV22TranscriptStatus = 'partial' | 'final' | 'corrected' | 'restored';

export interface VoiceV22TranscriptSegment {
  id: string;
  turnId: string;
  text: string;
  status: VoiceV22TranscriptStatus;
  confidence: number;
  atMs: number;
  /** Sequence number of the last audio frame this segment covers. */
  throughSeq: number;
  /** Id of the partial segment this final/corrected segment replaces. */
  replacesId?: string;
}

/** Barge-in decision levels in v22 (duck splits into two depths). */
export type VoiceV22BargeInDecision = 'ignore' | 'duck-soft' | 'duck-hard' | 'interrupt';

/** What happens to the cut reply after an interrupt. */
export type VoiceV22ResumeDisposition = 'resume' | 'drop' | 'summarise';

export interface VoiceV22ReplyCut {
  /** Text already spoken (word-boundary cut). */
  spoken: string;
  /** Text not yet spoken. */
  remaining: string;
  /** Characters spoken. */
  spokenChars: number;
  /** Characters remaining. */
  remainingChars: number;
  /** What the session should do with `remaining` after the interrupt. */
  disposition: VoiceV22ResumeDisposition;
}

/** Kinds of journal entries a durable session records. */
export type VoiceV22JournalKind =
  | 'session-open'
  | 'turn-state'
  | 'transcript'
  | 'barge-in'
  | 'profile-switch'
  | 'checkpoint'
  | 'disconnect'
  | 'reconnect'
  | 'resume'
  | 'recovery'
  | 'tts-chunk'
  | 'closed';

export interface VoiceV22JournalEntry {
  seq: number;
  kind: VoiceV22JournalKind;
  atMs: number;
  sessionId: string;
  detail?: Record<string, unknown>;
}

/** A durable checkpoint: everything needed to rebuild the session. */
export interface VoiceV22Checkpoint {
  version: 1;
  sessionId: string;
  createdAtMs: number;
  /** Journal sequence number covered by this checkpoint. */
  journalSeq: number;
  turnState: VoiceV22TurnState;
  durability: VoiceV22DurabilityPhase;
  floor: VoiceV22FloorHolder;
  profileId: string;
  turns: VoiceV22TurnRecord[];
  transcript: VoiceV22TranscriptSegment[];
  /** Agent reply cut at the checkpoint ('' when not speaking). */
  pendingReply: VoiceV22ReplyCut | null;
  /** Partial transcript not yet finalised. */
  unfinalisedPartial: string;
  /** Live counters carried across a resume. */
  counters: VoiceV22SessionCounters;
  /** Opaque resume token the client presents to resume. */
  resumeToken: string;
}

export interface VoiceV22SessionCounters {
  turns: number;
  bargeIns: number;
  ducks: number;
  disconnects: number;
  resumes: number;
  recoveries: number;
  profileSwitches: number;
  ttsChunksSpoken: number;
  checkpoints: number;
}

/** Why a session dropped or failed to recover. */
export type VoiceV22FailureKind =
  | 'transport-lost'
  | 'heartbeat-timeout'
  | 'checkpoint-corrupt'
  | 'journal-gap'
  | 'resume-token-expired'
  | 'resume-token-unknown'
  | 'provider-error'
  | 'unknown';

export interface VoiceV22Failure {
  kind: VoiceV22FailureKind;
  atMs: number;
  message: string;
  /** Journal seq where the failure was detected (-1 when unknown). */
  journalSeq: number;
  recoverable: boolean;
}

export type VoiceV22EventKind =
  | 'turn-state'
  | 'floor'
  | 'speech-start'
  | 'speech-end'
  | 'transcript'
  | 'barge-in'
  | 'duck'
  | 'tts-start'
  | 'tts-chunk'
  | 'tts-end'
  | 'profile-switch'
  | 'checkpoint'
  | 'disconnect'
  | 'reconnect'
  | 'resume'
  | 'recovered'
  | 'recovery-failed'
  | 'degraded'
  | 'closed';

export interface VoiceV22Event {
  kind: VoiceV22EventKind;
  atMs: number;
  sessionId?: string;
  detail?: Record<string, unknown>;
}

export type VoiceV22EventSink = (event: VoiceV22Event) => void;

export const VOICE_V22_FRAME_MS = 20;
export const VOICE_V22_FRAME_SAMPLES = 320;
export const VOICE_V22_SAMPLE_RATE = 16000;
export const VOICE_V22_CHECKPOINT_VERSION = 1;

/** A synthetic 440 Hz frame, for tests and the mock capture layer. */
export function syntheticFrameV22(seq: number, atMs: number, amplitude = 8000): VoiceV22Frame {
  const samples = new Int16Array(VOICE_V22_FRAME_SAMPLES);
  for (let i = 0; i < samples.length; i += 1) {
    samples[i] = Math.round(
      (amplitude * Math.sin((2 * Math.PI * 440 * (seq * VOICE_V22_FRAME_SAMPLES + i)) / VOICE_V22_SAMPLE_RATE)),
    );
  }
  return { seq, atMs, samples, energy: Math.min(1, Math.abs(amplitude) / 32768) };
}

export function silentFrameV22(seq: number, atMs: number): VoiceV22Frame {
  return { seq, atMs, samples: new Int16Array(VOICE_V22_FRAME_SAMPLES), energy: 0 };
}

export function pcm16RmsV22(samples: Int16Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (const s of samples) sum += s * s;
  return Math.sqrt(sum / samples.length);
}

/** Normalise speech text for matching: lowercase, strip punctuation, collapse space. */
export function normaliseSpeechV22(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Split normalised text into words (keeps Vietnamese diacritics). */
export function speechWordsV22(text: string): string[] {
  const n = normaliseSpeechV22(text);
  return n === '' ? [] : n.split(' ');
}

/** Clamp a number into [min, max]; NaN becomes min. */
export function clampV22(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

/** Round to 2 decimals for display (latency, rates). */
export function round2V22(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Round to 4 decimals for display (rates, scores). */
export function round4V22(value: number): number {
  return Math.round(value * 10000) / 10000;
}

/** Empty counters for a fresh session. */
export function zeroCountersV22(): VoiceV22SessionCounters {
  return {
    turns: 0,
    bargeIns: 0,
    ducks: 0,
    disconnects: 0,
    resumes: 0,
    recoveries: 0,
    profileSwitches: 0,
    ttsChunksSpoken: 0,
    checkpoints: 0,
  };
}

/** Deterministic resume token for a session at a journal seq. */
export function resumeTokenV22(sessionId: string, journalSeq: number): string {
  return `v22-resume-${sessionId}-${journalSeq}`;
}

/**
 * Shared types for voice realtime v21 (v1.34, Team T5).
 *
 * Voice-driven tool calls inside a realtime session, turn-taking
 * with barge-in, WER/latency eval, a streaming TTS cache and a
 * monitor panel. All clocks virtual, all audio mock/synthetic,
 * no network, no key, no mic/sound card.
 *
 * The session is the unit of work: one user, one realtime
 * connection, a turn state machine, a transcript that grows
 * live, tool calls the user asked for out loud, and a TTS
 * stream that can be cut off mid-sentence when the user barges
 * in. Every module in this subsystem speaks these types so the
 * session orchestrator, the tools layer and the panel all agree
 * on what a turn, a tool call and a latency sample are.
 */

export type VoiceV21Clock = { nowMs: number };

/** Turn-taking state of a realtime session. */
export type VoiceV21TurnState =
  | 'idle'
  | 'listening'
  | 'speaking'
  | 'waiting'
  | 'confirming';

/** What the user (or the agent) is doing in one turn. */
export type VoiceV21TurnRole = 'user' | 'agent';

export interface VoiceV21TurnRecord {
  id: string;
  role: VoiceV21TurnRole;
  text: string;
  atMs: number;
  durationMs: number;
  /** True when this agent turn was cut short by a barge-in. */
  bargeInCut?: boolean;
  /** Tool call this turn produced, if any. */
  toolCallId?: string;
}

/** One audio frame (20 ms @ 16 kHz, PCM16) from the mock capture layer. */
export interface VoiceV21Frame {
  seq: number;
  atMs: number;
  samples: Int16Array;
  /** 0..1 speech energy hint supplied by the (mock) capture layer. */
  energy?: number;
  /** True when the frame is known to be agent echo, not user speech. */
  echo?: boolean;
}

export type VoiceV21TranscriptStatus = 'partial' | 'final' | 'corrected';

export interface VoiceV21TranscriptSegment {
  id: string;
  turnId: string;
  text: string;
  status: VoiceV21TranscriptStatus;
  confidence: number;
  atMs: number;
  /** Sequence number of the last audio frame this segment covers. */
  throughSeq: number;
  /** Id of the partial segment this final/corrected segment replaces. */
  replacesId?: string;
}

/** Side-effect class of a tool, used by the confirmation policy. */
export type VoiceV21ToolEffect = 'read' | 'local-write' | 'send' | 'delete';

/** A tool the voice layer is allowed to call, with its effect class. */
export interface VoiceV21ToolDescriptor {
  name: string;
  description: string;
  effect: VoiceV21ToolEffect;
  /** Voice phrases that map to this tool (lowercase, no punctuation). */
  triggers: string[];
  /** Argument names the intent parser may fill from speech. */
  argNames: string[];
}

/** What the intent parser heard in one final transcript. */
export interface VoiceV21Intent {
  /** Tool name, or '' when no tool was recognised. */
  toolName: string;
  /** Arguments extracted from the transcript. */
  args: Record<string, unknown>;
  /** 0..1 confidence of the match. */
  confidence: number;
  /** Trigger phrase that matched, if any. */
  trigger?: string;
  /** Raw transcript this intent came from. */
  transcript: string;
  /** True when the transcript sounds like a confirmation ("yes", "đồng ý"). */
  isConfirmation?: boolean;
  /** True when the transcript sounds like a refusal ("no", "hủy"). */
  isRefusal?: boolean;
}

/** Lifecycle of one voice-driven tool call. */
export type VoiceV21ToolCallStatus =
  | 'pending-confirmation'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'declined'
  | 'denied';

export interface VoiceV21ToolCallRecord {
  id: string;
  sessionId: string;
  turnId: string;
  toolName: string;
  args: Record<string, unknown>;
  effect: VoiceV21ToolEffect;
  status: VoiceV21ToolCallStatus;
  requestedAtMs: number;
  startedAtMs?: number;
  finishedAtMs?: number;
  /** Human-readable result (or error) to read back aloud. */
  resultText?: string;
  /** Why a call was denied/declined, for the panel and the spoken reply. */
  denialReason?: string;
  /** Whether a spoken confirmation was required and given. */
  confirmationRequired: boolean;
  confirmationGiven?: boolean;
}

/** One stage of the voice pipeline, for latency measurement. */
export type VoiceV21LatencyStage = 'vad' | 'stt' | 'intent' | 'model' | 'tool' | 'tts';

export interface VoiceV21LatencySample {
  stage: VoiceV21LatencyStage;
  turnId: string;
  durationMs: number;
  atMs: number;
}

export type VoiceV21EventKind =
  | 'turn-state'
  | 'speech-start'
  | 'speech-end'
  | 'transcript'
  | 'intent'
  | 'tool-call-requested'
  | 'tool-call-confirmed'
  | 'tool-call-declined'
  | 'tool-call-denied'
  | 'tool-call-finished'
  | 'barge-in'
  | 'tts-start'
  | 'tts-chunk'
  | 'tts-end'
  | 'tts-cache-hit'
  | 'tts-cache-miss'
  | 'eval'
  | 'closed';

export interface VoiceV21Event {
  kind: VoiceV21EventKind;
  atMs: number;
  sessionId?: string;
  detail?: Record<string, unknown>;
}

export type VoiceV21EventSink = (event: VoiceV21Event) => void;

export const VOICE_V21_FRAME_MS = 20;
export const VOICE_V21_FRAME_SAMPLES = 320;
export const VOICE_V21_SAMPLE_RATE = 16000;

/** A synthetic 440 Hz frame, for tests and the mock capture layer. */
export function syntheticFrameV21(seq: number, atMs: number, amplitude = 8000): VoiceV21Frame {
  const samples = new Int16Array(VOICE_V21_FRAME_SAMPLES);
  for (let i = 0; i < samples.length; i += 1) {
    samples[i] = Math.round(
      (amplitude * Math.sin((2 * Math.PI * 440 * (seq * VOICE_V21_FRAME_SAMPLES + i)) / VOICE_V21_SAMPLE_RATE)),
    );
  }
  return { seq, atMs, samples, energy: Math.min(1, Math.abs(amplitude) / 32768) };
}

export function silentFrameV21(seq: number, atMs: number): VoiceV21Frame {
  return { seq, atMs, samples: new Int16Array(VOICE_V21_FRAME_SAMPLES), energy: 0 };
}

export function pcm16RmsV21(samples: Int16Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (const s of samples) sum += s * s;
  return Math.sqrt(sum / samples.length);
}

/** Normalise speech text for matching: lowercase, strip punctuation, collapse space. */
export function normaliseSpeechV21(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Split normalised text into words (keeps Vietnamese diacritics). */
export function speechWordsV21(text: string): string[] {
  const n = normaliseSpeechV21(text);
  return n === '' ? [] : n.split(' ');
}

/** Clamp a number into [min, max]; NaN becomes min. */
export function clampV21(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

/** Round to 2 decimals for display (latency, rates). */
export function round2V21(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Round to 4 decimals for display (WER, hit rate). */
export function round4V21(value: number): number {
  return Math.round(value * 10000) / 10000;
}

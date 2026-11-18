/**
 * Shared types for voice realtime v20 (v1.28, Team T5).
 * Realtime v4 — the "adaptive session fabric" on top of v18:
 * jitter-buffered frames, partial→final transcript reconciliation,
 * confidence-scored barge-in v7, prosody-aware TTS v5, mock
 * provider registry with failover, multi-session manager with
 * handoff, and long-session compaction. All clocks virtual,
 * all audio mock/synthetic, no network, no key.
 */
export type VoiceV20Clock = { nowMs: number };
export type VoiceV20Frame = {
  seq: number;
  atMs: number;
  samples: Int16Array;
  /** 0..1 speech energy hint supplied by the (mock) capture layer. */
  energy?: number;
  /** True when the frame is known to be agent echo, not user speech. */
  echo?: boolean;
};
export type VoiceV20TranscriptStatus = 'partial' | 'final' | 'corrected';
export type VoiceV20TranscriptSegment = {
  id: string;
  turnId: string;
  text: string;
  status: VoiceV20TranscriptStatus;
  confidence: number;
  atMs: number;
  /** Sequence number of the last audio frame this segment covers. */
  throughSeq: number;
  /** Id of the partial segment this final/corrected segment replaces. */
  replacesId?: string;
};
export type VoiceV20TurnRole = 'user' | 'agent';
export type VoiceV20TurnRecord = {
  id: string;
  role: VoiceV20TurnRole;
  text: string;
  atMs: number;
  durationMs: number;
  bargeInCut?: boolean;
  providerId?: string;
};
export type VoiceV20ProviderKind = 'stt' | 'tts' | 's2s';
export type VoiceV20ProviderHealth = 'healthy' | 'degraded' | 'down';
export type VoiceV20EventKind =
  | 'frame'
  | 'speech-start'
  | 'speech-end'
  | 'transcript'
  | 'barge-in'
  | 'tts-start'
  | 'tts-chunk'
  | 'tts-end'
  | 'turn-end'
  | 'failover'
  | 'compacted'
  | 'checkpoint'
  | 'recovered'
  | 'handoff'
  | 'closed';
export type VoiceV20Event = {
  kind: VoiceV20EventKind;
  atMs: number;
  sessionId?: string;
  detail?: Record<string, unknown>;
};
export type VoiceV20EventSink = (event: VoiceV20Event) => void;
export const VOICE_V20_FRAME_MS = 20;
export const VOICE_V20_FRAME_SAMPLES = 320;
export const VOICE_V20_SAMPLE_RATE = 16000;
export function syntheticFrameV20(seq: number, atMs: number, amplitude = 8000): VoiceV20Frame {
  const samples = new Int16Array(VOICE_V20_FRAME_SAMPLES);
  for (let i = 0; i < samples.length; i += 1) {
    samples[i] = Math.round(amplitude * Math.sin((2 * Math.PI * 440 * (seq * VOICE_V20_FRAME_SAMPLES + i)) / VOICE_V20_SAMPLE_RATE));
  }
  return { seq, atMs, samples, energy: Math.min(1, Math.abs(amplitude) / 32768) };
}
export function silentFrameV20(seq: number, atMs: number): VoiceV20Frame {
  return { seq, atMs, samples: new Int16Array(VOICE_V20_FRAME_SAMPLES), energy: 0 };
}
export function pcm16RmsV20(samples: Int16Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (const s of samples) sum += s * s;
  return Math.sqrt(sum / samples.length);
}

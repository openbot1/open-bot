/**
 * Mock audio generator v11 (v1.12, Đội T5 — voice realtime v11).
 *
 * v10's tests built their frames inline with `sinePcm16Frame` from
 * `audio.ts`; every team re-derived the same helpers (a seeded
 * noise source, an amplitude-modulated "speech-like" burst, an echo
 * copy) and the copies drifted. This module is the single shared
 * source of deterministic mock audio for the v11 voice stack:
 *
 * - `mulberry32` — a tiny seeded PRNG, so a "random" noise frame
 *   is byte-identical on every run and on every machine.
 * - Frame builders: silence, pure tone, white noise, speech-like
 *   (a 180 Hz fundamental + 360 Hz harmonic under a slow syllabic
 *   envelope, so it carries energy in both VAD bands and a
 *   speech-like zero-crossing rate), hum (50 Hz, low band only),
 *   hiss (white noise through a first-difference, high band only),
 *   echo (a scaled copy of another frame, i.e. agent playback
 *   leaking into the mic).
 * - `buildMockAudioScript` — assemble a labelled sequence of frames
 *   (`silence 500ms`, `speech 800ms`, …) into one frame list the
 *   tests and the session can feed frame by frame, with the label
 *   of every frame kept alongside for assertions.
 * - `frameRms` / `frameZcr` — the two scalar features the VAD
 *   scores, exposed here so tests can assert on the input itself
 *   (not only on the detector's verdict).
 *
 * Everything is pure arithmetic on PCM16 buffers. No sound card,
 * no microphone, no network, no model. Sample rate is fixed at
 * 16 kHz, frames are 20 ms (320 samples) unless a builder says
 * otherwise.
 */

/** Samples per 20 ms frame at 16 kHz. */
export const MOCK_AUDIO_FRAME_SAMPLES = 320;
/** Sample rate the mock audio is generated at (Hz). */
export const MOCK_AUDIO_SAMPLE_RATE_HZ = 16000;
/** Bytes per 20 ms PCM16 frame. */
export const MOCK_AUDIO_FRAME_BYTES = MOCK_AUDIO_FRAME_SAMPLES * 2;

/** Write one normalised sample (-1..1) into a PCM16 frame. */
export function writeMockSample(frame: Uint8Array, i: number, value: number): void {
  const clamped = Math.max(-1, Math.min(1, value));
  const s = Math.round(clamped * 32767);
  const v = s < 0 ? s + 65536 : s;
  frame[i * 2] = v & 0xff;
  frame[i * 2 + 1] = (v >> 8) & 0xff;
}

/** Read one normalised sample (-1..1) from a PCM16 frame. */
export function readMockSample(frame: Uint8Array, i: number): number {
  const lo = frame[i * 2] ?? 0;
  const hi = frame[i * 2 + 1] ?? 0;
  let v = (hi << 8) | lo;
  if (v >= 0x8000) v -= 0x10000;
  return v / 32768;
}

/**
 * Seeded PRNG (mulberry32). Deterministic: the same seed always
 * yields the same stream, so noise frames are reproducible.
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** RMS energy (0..1) of a PCM16 frame. */
export function frameRms(frame: Uint8Array): number {
  const n = Math.floor(frame.length / 2);
  if (n === 0) return 0;
  let sum = 0;
  for (let i = 0; i < n; i += 1) {
    const v = readMockSample(frame, i);
    sum += v * v;
  }
  return Math.sqrt(sum / n);
}

/** Zero-crossing count of a PCM16 frame. */
export function frameZcr(frame: Uint8Array): number {
  const n = Math.floor(frame.length / 2);
  let crossings = 0;
  let prev = 0;
  for (let i = 0; i < n; i += 1) {
    const v = readMockSample(frame, i);
    if (prev !== 0 && ((prev < 0 && v >= 0) || (prev >= 0 && v < 0))) crossings += 1;
    prev = v;
  }
  return crossings;
}

/** Silence: every sample zero. */
export function silenceFrame(samples: number = MOCK_AUDIO_FRAME_SAMPLES): Uint8Array {
  return new Uint8Array(samples * 2);
}

/**
 * Pure tone at `frequencyHz` and peak `amplitude` (0..1).
 * `phaseOffset` keeps consecutive frames continuous when a caller
 * stitches frames into a longer tone.
 */
export function toneFrame(
  frequencyHz: number,
  amplitude = 0.2,
  samples: number = MOCK_AUDIO_FRAME_SAMPLES,
  phaseOffset = 0,
): Uint8Array {
  const frame = new Uint8Array(samples * 2);
  for (let i = 0; i < samples; i += 1) {
    const phase = (2 * Math.PI * frequencyHz * (i + phaseOffset)) / MOCK_AUDIO_SAMPLE_RATE_HZ;
    writeMockSample(frame, i, amplitude * Math.sin(phase));
  }
  return frame;
}

/**
 * White noise at peak `amplitude` (0..1), from a seeded PRNG.
 * The same seed + amplitude always builds the same frame.
 */
export function noiseFrame(
  amplitude = 0.05,
  seed = 1,
  samples: number = MOCK_AUDIO_FRAME_SAMPLES,
): Uint8Array {
  const rand = mulberry32(seed);
  const frame = new Uint8Array(samples * 2);
  for (let i = 0; i < samples; i += 1) {
    writeMockSample(frame, i, (rand() * 2 - 1) * amplitude);
  }
  return frame;
}

/**
 * Speech-like frame: a 180 Hz fundamental plus a 360 Hz harmonic
 * under a slow syllabic envelope (4 Hz), so the frame carries
 * energy in both VAD bands and a speech-like zero-crossing rate.
 * `energy` (0..1) scales the overall loudness; `phaseOffset`
 * keeps a multi-frame utterance continuous.
 */
export function speechLikeFrame(
  energy = 0.25,
  phaseOffset = 0,
  samples: number = MOCK_AUDIO_FRAME_SAMPLES,
): Uint8Array {
  const frame = new Uint8Array(samples * 2);
  for (let i = 0; i < samples; i += 1) {
    const t = (i + phaseOffset) / MOCK_AUDIO_SAMPLE_RATE_HZ;
    // Syllabic envelope: swells and dips a few times a second,
    // like real speech energy — never fully silent mid-frame.
    const envelope = 0.55 + 0.45 * Math.sin(2 * Math.PI * 4 * t);
    const v =
      0.6 * Math.sin(2 * Math.PI * 180 * t) +
      0.3 * Math.sin(2 * Math.PI * 360 * t) +
      0.1 * Math.sin(2 * Math.PI * 720 * t);
    writeMockSample(frame, i, energy * envelope * v);
  }
  return frame;
}

/** 50 Hz hum (low band only): the fan / mains case. */
export function humFrame(
  amplitude = 0.2,
  samples: number = MOCK_AUDIO_FRAME_SAMPLES,
): Uint8Array {
  return toneFrame(50, amplitude, samples);
}

/**
 * Hiss: white noise with its low frequencies removed by a
 * first-difference, so almost all energy sits in the high band
 * (the air-conditioner case). Amplitude is the pre-filter peak.
 */
export function hissFrame(
  amplitude = 0.1,
  seed = 7,
  samples: number = MOCK_AUDIO_FRAME_SAMPLES,
): Uint8Array {
  const rand = mulberry32(seed);
  const frame = new Uint8Array(samples * 2);
  let prev = 0;
  for (let i = 0; i < samples; i += 1) {
    const v = (rand() * 2 - 1) * amplitude;
    // First difference kills the DC / low end; rescale so the
    // frame stays audible (diff halves white-noise energy).
    writeMockSample(frame, i, (v - prev) * 1.4);
    prev = v;
  }
  return frame;
}

/**
 * Echo frame: a scaled copy of `source` (agent playback leaking
 * into the mic). `factor` 0..1 is the leakage; 0 is silence.
 */
export function echoFrame(source: Uint8Array, factor = 0.5): Uint8Array {
  if (!Number.isFinite(factor) || factor < 0 || factor > 1) {
    throw new Error('Mock audio echo factor must be a finite number in 0..1.');
  }
  const n = Math.floor(source.length / 2);
  const frame = new Uint8Array(n * 2);
  for (let i = 0; i < n; i += 1) {
    writeMockSample(frame, i, readMockSample(source, i) * factor);
  }
  return frame;
}

/** One labelled segment of a mock audio script. */
export interface MockAudioSegment {
  /** Label the caller asserts on (`silence`, `speech`, `noise`, `hum`, `hiss`). */
  label: 'silence' | 'speech' | 'noise' | 'hum' | 'hiss' | 'tone';
  /** Segment length (ms, rounded up to whole 20 ms frames). */
  durationMs: number;
  /** Loudness / amplitude for the segment (0..1). */
  amplitude?: number;
  /** Tone frequency for `tone` segments (Hz). */
  frequencyHz?: number;
  /** PRNG seed for `noise` / `hiss` segments. */
  seed?: number;
}

/** One frame of a built script, with its segment label. */
export interface MockAudioScriptFrame {
  frame: Uint8Array;
  label: MockAudioSegment['label'];
  /** Offset of this frame inside its segment (ms). */
  offsetMs: number;
}

/**
 * Assemble labelled segments into frames. A segment's frames
 * share one continuous phase (speech / tone stay continuous
 * across frame boundaries); noise segments advance the seed per
 * frame so the noise does not repeat identically. Returns the
 * frames in order with their labels — the caller feeds them to
 * the VAD one by one and asserts per label.
 */
export function buildMockAudioScript(segments: MockAudioSegment[]): MockAudioScriptFrame[] {
  const out: MockAudioScriptFrame[] = [];
  for (const segment of segments) {
    if (!Number.isFinite(segment.durationMs) || segment.durationMs <= 0) {
      throw new Error(`Mock audio segment "${segment.label}" needs a positive durationMs.`);
    }
    const frames = Math.max(1, Math.ceil(segment.durationMs / 20));
    const amplitude = segment.amplitude ?? (segment.label === 'speech' ? 0.25 : segment.label === 'silence' ? 0 : 0.05);
    let phaseOffset = 0;
    for (let f = 0; f < frames; f += 1) {
      let frame: Uint8Array;
      switch (segment.label) {
        case 'silence':
          frame = silenceFrame();
          break;
        case 'speech':
          frame = speechLikeFrame(amplitude, phaseOffset);
          break;
        case 'tone':
          frame = toneFrame(segment.frequencyHz ?? 300, amplitude, MOCK_AUDIO_FRAME_SAMPLES, phaseOffset);
          break;
        case 'noise':
          frame = noiseFrame(amplitude, (segment.seed ?? 1) + f);
          break;
        case 'hum':
          frame = humFrame(amplitude);
          break;
        case 'hiss':
          frame = hissFrame(amplitude, (segment.seed ?? 7) + f);
          break;
        default:
          frame = silenceFrame();
          break;
      }
      out.push({ frame, label: segment.label, offsetMs: f * 20 });
      phaseOffset += MOCK_AUDIO_FRAME_SAMPLES;
    }
  }
  return out;
}

/** One-line summary of a frame's features (for test failure messages). */
export function mockFrameSummary(frame: Uint8Array): string {
  return `rms=${frameRms(frame).toFixed(4)} zcr=${frameZcr(frame)}`;
}

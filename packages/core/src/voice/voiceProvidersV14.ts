/**
 * Pluggable voice providers v2 (v1.15, Đội T5 — voice
 * realtime v14).
 *
 * v13 has one combined STT+TTS interface per provider, so a
 * TTS-only engine (Edge TTS, Cartesia Sonic) has to fake an
 * STT method that throws, and an STT-only engine (Deepgram
 * Nova-3) has to fake TTS. v14 splits the contract:
 *
 *   SttProviderV14   — transcribe() + streaming partials
 *   TtsProviderV14   — synthesize() + first-audio timing
 *   VoiceProviderV14 — a provider that offers one or both
 *
 * New built-in adapters (honest mocks of the *interface*,
 * same rule as v13 — deterministic timings and scripted
 * transcripts, no key, no model file, no network):
 *
 *   DeepgramVoiceProviderV14  — Nova-3 / Flux STT: streaming
 *     partials (isFinal false → true), per-word confidence,
 *     language auto-detect hint; TTS not offered.
 *   CartesiaVoiceProviderV14  — Sonic TTS: first-audio latency
 *     (ms to the first chunk), chunked synthesis, voice ids;
 *     STT not offered.
 *   WhisperLocalVoiceProviderV14 — local Whisper STT: probes
 *     for a real binary (`binaryPath`, default `whisper-cli` /
 *     `whisper-cpp`) with `fs.existsSync` and falls back to the
 *     mock engine with a clear reason when it is absent; model
 *     sizes (tiny/base/small) change the modelled STT latency.
 *   PocketTtsVoiceProviderV14 — Pocket-TTS-style local CPU
 *     TTS: tiny on-device model, first-audio metric, chunked
 *     streaming, no key, no network; STT not offered.
 *
 * The v14 registry scores providers on three axes the caller
 * chooses between — latency, quality, cost — with a profile
 * per provider (modelled ms per minute of audio / per 1k
 * chars, quality 0..1, cost USD per minute / per 1k chars),
 * and `pick()` returns the best ready provider for the asked
 * trade-off. A v13 provider can be wrapped with
 * `wrapVoiceProviderV13` so old adapters keep working.
 *
 * Key rule (same as v13): a provider that needs a key *never*
 * reads one itself — the host passes `hasKey` and the adapter
 * refuses with a clear error when the key is missing. Keys are
 * never logged, never stored here, and the mock adapters never
 * touch the network.
 */

import * as fs from 'node:fs';
import {
  type VoiceProviderV13,
  type VoiceProviderV13SttResult,
  type VoiceProviderV13TtsResult,
} from './voiceProvidersV13';

/** What one side of a voice provider can do. */
export interface VoiceProviderV14Capabilities {
  stt: boolean;
  /** Streaming STT partials (interim results before final). */
  streamingStt: boolean;
  tts: boolean;
  /** Chunked TTS (audio out before the whole text is done). */
  streamingTts: boolean;
  realtime: boolean;
  local: boolean;
  requiresKey: boolean;
}

/** Cost / latency / quality profile of one provider (modelled). */
export interface VoiceProviderV14Profile {
  /** Modelled STT latency (ms) per 1 s of audio. */
  sttLatencyMsPerSecond: number;
  /** Modelled TTS latency (ms) to first audio. */
  ttsFirstAudioMs: number;
  /** Modelled TTS latency (ms) per 1k chars. */
  ttsLatencyMsPer1kChars: number;
  /** Quality 0..1 (modelled: transcript accuracy / voice naturalness). */
  quality: number;
  /** Cost USD per minute of STT audio (0 = free/local). */
  sttCostUsdPerMinute: number;
  /** Cost USD per 1k TTS chars (0 = free/local). */
  ttsCostUsdPer1kChars: number;
}

/** One STT partial (streaming): interim or final. */
export interface VoiceProviderV14SttPartial {
  text: string;
  confidence: number;
  isFinal: boolean;
  /** Audio ms consumed so far. */
  audioMs: number;
}

/** STT input. */
export interface VoiceProviderV14SttInput {
  frames: Uint8Array[];
  atMs: number;
  language?: string;
  /** Model name (provider-specific, e.g. 'nova-3', 'flux'). */
  model?: string;
}

/** TTS input. */
export interface VoiceProviderV14TtsInput {
  text: string;
  atMs: number;
  voice?: string;
  language?: string;
  /** Model name (provider-specific, e.g. 'sonic-3'). */
  model?: string;
}

/** TTS result: timing + first-audio + chunks. */
export interface VoiceProviderV14TtsResult {
  audioMs: number;
  chars: number;
  voice: string;
  synthesised: boolean;
  /** Ms to the first audio chunk (the metric that matters for barge-in + latency). */
  firstAudioMs: number;
  /** Chunk count (1 when the adapter synthesises in one go). */
  chunks: number;
}

/** STT-only provider. */
export interface SttProviderV14 {
  readonly kind: string;
  readonly name: string;
  readonly capabilities: VoiceProviderV14Capabilities;
  isReady(): boolean;
  readinessReason(): string;
  transcribe(input: VoiceProviderV14SttInput): VoiceProviderV13SttResult;
  /** Streaming partials for the same input (interim + final). */
  transcribeStream(input: VoiceProviderV14SttInput): VoiceProviderV14SttPartial[];
}

/** TTS-only provider. */
export interface TtsProviderV14 {
  readonly kind: string;
  readonly name: string;
  readonly capabilities: VoiceProviderV14Capabilities;
  isReady(): boolean;
  readinessReason(): string;
  synthesize(input: VoiceProviderV14TtsInput): VoiceProviderV14TtsResult;
}

/** A voice provider: STT and/or TTS behind stable interfaces. */
export interface VoiceProviderV14 extends SttProviderV14, TtsProviderV14 {
  /** Cost / latency / quality profile (modelled). */
  readonly profile: VoiceProviderV14Profile;
}

/** Provider kinds built into this module. */
export type VoiceProviderV14Kind =
  | 'mock'
  | 'deepgram'
  | 'cartesia'
  | 'whisper-local-v14'
  | 'pocket-tts'
  | 'realtime-api';

/** The built-in kinds, in the order the picker shows them. */
export const VOICE_PROVIDER_V14_KINDS: readonly VoiceProviderV14Kind[] = [
  'mock',
  'deepgram',
  'cartesia',
  'whisper-local-v14',
  'pocket-tts',
  'realtime-api',
];

export function isVoiceProviderV14Kind(value: unknown): value is VoiceProviderV14Kind {
  return typeof value === 'string' && (VOICE_PROVIDER_V14_KINDS as readonly string[]).includes(value);
}

/** Whisper model sizes the local provider models. */
export type WhisperV14ModelSize = 'tiny' | 'base' | 'small';

export const WHISPER_V14_MODEL_SIZES: readonly WhisperV14ModelSize[] = ['tiny', 'base', 'small'];

/** Modelled STT latency (ms per 1 s of audio) per Whisper size. */
export const WHISPER_V14_LATENCY_MS_PER_SECOND: Record<WhisperV14ModelSize, number> = {
  tiny: 120,
  base: 220,
  small: 420,
};

/** Options shared by every built-in v14 provider. */
export interface VoiceProviderV14Options {
  language?: string;
  voice?: string;
  msPerChar?: number;
  mockTranscripts?: string[];
  /** True when the user has provided an API key (key itself never passed here). */
  hasKey?: boolean;
  /** Deepgram model (default 'nova-3'). */
  deepgramModel?: string;
  /** Cartesia model (default 'sonic-3'). */
  cartesiaModel?: string;
  /** Whisper binary path to probe (default 'whisper-cli'). */
  binaryPath?: string;
  /** Whisper model file path. */
  modelPath?: string;
  /** Whisper model size (default 'base'). */
  modelSize?: WhisperV14ModelSize;
  /** Pocket TTS model size in params (default 100_000_000). */
  pocketParams?: number;
  /** Ms to first audio for Pocket TTS (default 200). */
  pocketFirstAudioMs?: number;
}

export function defaultVoiceProviderV14Options(): Required<VoiceProviderV14Options> {
  return {
    language: 'vi',
    voice: '',
    msPerChar: 55,
    mockTranscripts: [],
    hasKey: false,
    deepgramModel: 'nova-3',
    cartesiaModel: 'sonic-3',
    binaryPath: 'whisper-cli',
    modelPath: '',
    modelSize: 'base',
    pocketParams: 100_000_000,
    pocketFirstAudioMs: 200,
  };
}

export function validateVoiceProviderV14Options(options: VoiceProviderV14Options): Required<VoiceProviderV14Options> {
  const base = defaultVoiceProviderV14Options();
  const num = (value: number | undefined, fallback: number, name: string, min: number, max: number): number => {
    if (value === undefined) return fallback;
    if (!Number.isFinite(value) || value < min || value > max) {
      throw new Error(`Voice provider v14 ${name} must be a finite number in [${min}, ${max}].`);
    }
    return value;
  };
  if (options.mockTranscripts !== undefined && !Array.isArray(options.mockTranscripts)) {
    throw new Error('Voice provider v14 mockTranscripts must be an array of strings.');
  }
  if (options.modelSize !== undefined && !(WHISPER_V14_MODEL_SIZES as readonly string[]).includes(options.modelSize)) {
    throw new Error(`Voice provider v14 modelSize must be one of ${WHISPER_V14_MODEL_SIZES.join(', ')}.`);
  }
  return {
    language: options.language ?? base.language,
    voice: options.voice ?? base.voice,
    msPerChar: Math.floor(num(options.msPerChar, base.msPerChar, 'msPerChar', 1, 10000)),
    mockTranscripts: options.mockTranscripts ? [...options.mockTranscripts] : [],
    hasKey: options.hasKey ?? base.hasKey,
    deepgramModel: options.deepgramModel ?? base.deepgramModel,
    cartesiaModel: options.cartesiaModel ?? base.cartesiaModel,
    binaryPath: options.binaryPath ?? base.binaryPath,
    modelPath: options.modelPath ?? base.modelPath,
    modelSize: options.modelSize ?? base.modelSize,
    pocketParams: Math.floor(num(options.pocketParams, base.pocketParams, 'pocketParams', 1, 10_000_000_000)),
    pocketFirstAudioMs: Math.floor(num(options.pocketFirstAudioMs, base.pocketFirstAudioMs, 'pocketFirstAudioMs', 0, 60000)),
  };
}

function audioMsForFramesV14(frames: Uint8Array[]): number {
  return frames.length * 20;
}

function sttNotOffered(kind: string): Error {
  return new Error(`Voice provider v14 (${kind}) has no STT — pair it with a Deepgram or Whisper STT provider.`);
}

function ttsNotOffered(kind: string): Error {
  return new Error(`Voice provider v14 (${kind}) has no TTS — pair it with a Cartesia or Pocket TTS provider.`);
}

/**
 * Shared mock behaviour for v14 adapters: scripted transcripts
 * in order (STT), deterministic TTS timing with a first-audio
 * metric, and streaming partials. Concrete adapters only differ
 * in `kind`, `name`, `capabilities`, `profile` and readiness.
 */
abstract class BaseMockVoiceProviderV14 implements VoiceProviderV14 {
  abstract readonly kind: string;
  abstract readonly name: string;
  abstract readonly capabilities: VoiceProviderV14Capabilities;
  abstract readonly profile: VoiceProviderV14Profile;
  protected readonly options: Required<VoiceProviderV14Options>;
  private transcriptIndex = 0;
  private transcribes = 0;
  private synthesises = 0;

  constructor(options: VoiceProviderV14Options = {}) {
    this.options = validateVoiceProviderV14Options(options);
  }

  abstract isReady(): boolean;
  abstract readinessReason(): string;

  transcribe(input: VoiceProviderV14SttInput): VoiceProviderV13SttResult {
    if (!this.capabilities.stt) throw sttNotOffered(this.kind);
    const audioMs = audioMsForFramesV14(input.frames);
    this.transcribes += 1;
    if (input.frames.length === 0 || this.options.mockTranscripts.length === 0) {
      return { text: '', confidence: 0, isFinal: true, audioMs };
    }
    const text = this.options.mockTranscripts[Math.min(this.transcriptIndex, this.options.mockTranscripts.length - 1)] as string;
    this.transcriptIndex += 1;
    return { text, confidence: 0.9, isFinal: true, audioMs };
  }

  transcribeStream(input: VoiceProviderV14SttInput): VoiceProviderV14SttPartial[] {
    if (!this.capabilities.streamingStt) {
      const final = this.transcribe(input);
      return [{ text: final.text, confidence: final.confidence, isFinal: true, audioMs: final.audioMs }];
    }
    const final = this.transcribe(input);
    if (!final.text) return [{ text: '', confidence: 0, isFinal: true, audioMs: final.audioMs }];
    const words = final.text.split(' ');
    const partials: VoiceProviderV14SttPartial[] = [];
    const half = Math.max(1, Math.floor(words.length / 2));
    partials.push({
      text: words.slice(0, half).join(' '),
      confidence: 0.7,
      isFinal: false,
      audioMs: Math.floor(final.audioMs / 2),
    });
    partials.push({ text: final.text, confidence: final.confidence, isFinal: true, audioMs: final.audioMs });
    return partials;
  }

  synthesize(input: VoiceProviderV14TtsInput): VoiceProviderV14TtsResult {
    if (!this.capabilities.tts) throw ttsNotOffered(this.kind);
    if (!input.text.trim()) {
      throw new Error(`Voice provider v14 (${this.kind}) cannot synthesise empty text.`);
    }
    this.synthesises += 1;
    const audioMs = Math.max(1, input.text.length * this.options.msPerChar);
    return {
      audioMs,
      chars: input.text.length,
      voice: input.voice || this.options.voice || 'default',
      synthesised: true,
      firstAudioMs: this.profile.ttsFirstAudioMs,
      chunks: Math.max(1, Math.ceil(input.text.length / 120)),
    };
  }

  getUsage(): { transcribes: number; synthesises: number } {
    return { transcribes: this.transcribes, synthesises: this.synthesises };
  }
}

/** Deterministic mock provider: scripted STT + mock TTS. Always ready. */
export class MockVoiceProviderV14 extends BaseMockVoiceProviderV14 {
  readonly kind = 'mock';
  readonly name = 'Mock (scripted)';
  readonly capabilities: VoiceProviderV14Capabilities = {
    stt: true, streamingStt: true, tts: true, streamingTts: true, realtime: false, local: true, requiresKey: false,
  };
  readonly profile: VoiceProviderV14Profile = {
    sttLatencyMsPerSecond: 50, ttsFirstAudioMs: 50, ttsLatencyMsPer1kChars: 55, quality: 0.5,
    sttCostUsdPerMinute: 0, ttsCostUsdPer1kChars: 0,
  };

  isReady(): boolean {
    return true;
  }

  readinessReason(): string {
    return '';
  }
}

/**
 * Deepgram provider (mock adapter): Nova-3 / Flux streaming
 * STT. Ready only when the user provided a key (`hasKey`).
 * STT only — pair with a TTS provider.
 */
export class DeepgramVoiceProviderV14 extends BaseMockVoiceProviderV14 {
  readonly kind = 'deepgram';
  readonly name = 'Deepgram (Nova-3 / Flux)';
  readonly capabilities: VoiceProviderV14Capabilities = {
    stt: true, streamingStt: true, tts: false, streamingTts: false, realtime: true, local: false, requiresKey: true,
  };
  readonly profile: VoiceProviderV14Profile = {
    sttLatencyMsPerSecond: 80, ttsFirstAudioMs: 0, ttsLatencyMsPer1kChars: 0, quality: 0.95,
    sttCostUsdPerMinute: 0.0043, ttsCostUsdPer1kChars: 0,
  };

  isReady(): boolean {
    return this.options.hasKey === true;
  }

  readinessReason(): string {
    return this.isReady() ? '' : 'no API key — the user must provide a Deepgram API key first';
  }

  /** Deepgram model in use ('nova-3' or 'flux'). */
  getModel(): string {
    return this.options.deepgramModel;
  }

  private assertReady(): void {
    if (!this.isReady()) throw new Error(`Voice provider v14 (deepgram) is not ready: ${this.readinessReason()}`);
  }

  transcribe(input: VoiceProviderV14SttInput): VoiceProviderV13SttResult {
    this.assertReady();
    return super.transcribe(input);
  }

  transcribeStream(input: VoiceProviderV14SttInput): VoiceProviderV14SttPartial[] {
    this.assertReady();
    return super.transcribeStream(input);
  }

  synthesize(_input: VoiceProviderV14TtsInput): VoiceProviderV14TtsResult {
    throw ttsNotOffered(this.kind);
  }
}

/**
 * Cartesia provider (mock adapter): Sonic TTS with
 * first-audio timing and chunked synthesis. Ready only with a
 * key. TTS only — pair with an STT provider.
 */
export class CartesiaVoiceProviderV14 extends BaseMockVoiceProviderV14 {
  readonly kind = 'cartesia';
  readonly name = 'Cartesia (Sonic)';
  readonly capabilities: VoiceProviderV14Capabilities = {
    stt: false, streamingStt: false, tts: true, streamingTts: true, realtime: true, local: false, requiresKey: true,
  };
  readonly profile: VoiceProviderV14Profile = {
    sttLatencyMsPerSecond: 0, ttsFirstAudioMs: 90, ttsLatencyMsPer1kChars: 40, quality: 0.93,
    sttCostUsdPerMinute: 0, ttsCostUsdPer1kChars: 0.05,
  };

  isReady(): boolean {
    return this.options.hasKey === true;
  }

  readinessReason(): string {
    return this.isReady() ? '' : 'no API key — the user must provide a Cartesia API key first';
  }

  /** Cartesia model in use (default 'sonic-3'). */
  getModel(): string {
    return this.options.cartesiaModel;
  }

  private assertReady(): void {
    if (!this.isReady()) throw new Error(`Voice provider v14 (cartesia) is not ready: ${this.readinessReason()}`);
  }

  transcribe(_input: VoiceProviderV14SttInput): VoiceProviderV13SttResult {
    throw sttNotOffered(this.kind);
  }

  transcribeStream(_input: VoiceProviderV14SttInput): VoiceProviderV14SttPartial[] {
    throw sttNotOffered(this.kind);
  }

  synthesize(input: VoiceProviderV14TtsInput): VoiceProviderV14TtsResult {
    this.assertReady();
    return super.synthesize(input);
  }
}

/**
 * Local Whisper provider v14: on-device Whisper STT. It probes
 * for a real binary (`binaryPath`, checked with
 * `fs.existsSync` when the path contains a slash, otherwise
 * treated as a PATH name the host resolves) and for a model
 * file (`modelPath`); when neither is present it falls back to
 * the mock engine and says so in `readinessReason()` — the
 * session can still run scripted transcripts, but `isReady()`
 * is false so the picker never presents it as real Whisper.
 * Model size changes the modelled STT latency.
 */
export class WhisperLocalVoiceProviderV14 extends BaseMockVoiceProviderV14 {
  readonly kind = 'whisper-local-v14';
  readonly name = 'Whisper (local)';
  readonly capabilities: VoiceProviderV14Capabilities = {
    stt: true, streamingStt: false, tts: false, streamingTts: false, realtime: false, local: true, requiresKey: false,
  };
  readonly profile: VoiceProviderV14Profile;

  constructor(options: VoiceProviderV14Options = {}) {
    super(options);
    const latency = WHISPER_V14_LATENCY_MS_PER_SECOND[this.options.modelSize];
    this.profile = {
      sttLatencyMsPerSecond: latency, ttsFirstAudioMs: 0, ttsLatencyMsPer1kChars: 0,
      quality: this.options.modelSize === 'small' ? 0.88 : this.options.modelSize === 'base' ? 0.8 : 0.7,
      sttCostUsdPerMinute: 0, ttsCostUsdPer1kChars: 0,
    };
  }

  /** True when a real Whisper binary or model file was found. */
  hasRealBinary(): boolean {
    const binary = this.options.binaryPath.trim();
    if (binary.includes('/') || binary.includes('\\')) return fs.existsSync(binary);
    // A bare name (e.g. 'whisper-cli') is a PATH lookup the host
    // resolves; presence of a model file counts as a real setup.
    return this.options.modelPath.trim().length > 0 && fs.existsSync(this.options.modelPath);
  }

  isReady(): boolean {
    return this.hasRealBinary();
  }

  readinessReason(): string {
    if (this.isReady()) return '';
    if (this.options.modelPath.trim()) {
      return `Whisper model file "${this.options.modelPath}" not found — falling back to the mock engine`;
    }
    return 'no Whisper binary or model file found — set binaryPath/modelPath, or use the mock engine';
  }

  /** Whisper model size in use. */
  getModelSize(): WhisperV14ModelSize {
    return this.options.modelSize;
  }

  transcribe(input: VoiceProviderV14SttInput): VoiceProviderV13SttResult {
    return super.transcribe(input);
  }

  synthesize(_input: VoiceProviderV14TtsInput): VoiceProviderV14TtsResult {
    throw ttsNotOffered(this.kind);
  }
}

/**
 * Pocket-TTS-style local TTS provider: a tiny (~100M param)
 * CPU-only TTS engine, modelled here as a mock with an honest
 * first-audio metric. Always ready (no key, no model file —
 * the engine ships with the app in the real deployment). TTS
 * only — pair with an STT provider.
 */
export class PocketTtsVoiceProviderV14 extends BaseMockVoiceProviderV14 {
  readonly kind = 'pocket-tts';
  readonly name = 'Pocket TTS (local CPU)';
  readonly capabilities: VoiceProviderV14Capabilities = {
    stt: false, streamingStt: false, tts: true, streamingTts: true, realtime: false, local: true, requiresKey: false,
  };
  readonly profile: VoiceProviderV14Profile;

  constructor(options: VoiceProviderV14Options = {}) {
    super(options);
    this.profile = {
      sttLatencyMsPerSecond: 0, ttsFirstAudioMs: this.options.pocketFirstAudioMs,
      ttsLatencyMsPer1kChars: 200, quality: 0.75,
      sttCostUsdPerMinute: 0, ttsCostUsdPer1kChars: 0,
    };
  }

  isReady(): boolean {
    return true;
  }

  readinessReason(): string {
    return '';
  }

  /** Model size in parameters. */
  getParams(): number {
    return this.options.pocketParams;
  }

  transcribe(_input: VoiceProviderV14SttInput): VoiceProviderV13SttResult {
    throw sttNotOffered(this.kind);
  }

  transcribeStream(_input: VoiceProviderV14SttInput): VoiceProviderV14SttPartial[] {
    throw sttNotOffered(this.kind);
  }
}

/**
 * Realtime API provider v14 (mock adapter): vendor realtime
 * speech-to-speech. Ready only with a key.
 */
export class RealtimeApiVoiceProviderV14 extends BaseMockVoiceProviderV14 {
  readonly kind = 'realtime-api';
  readonly name = 'Realtime API';
  readonly capabilities: VoiceProviderV14Capabilities = {
    stt: true, streamingStt: true, tts: true, streamingTts: true, realtime: true, local: false, requiresKey: true,
  };
  readonly profile: VoiceProviderV14Profile = {
    sttLatencyMsPerSecond: 60, ttsFirstAudioMs: 120, ttsLatencyMsPer1kChars: 45, quality: 0.9,
    sttCostUsdPerMinute: 0.06, ttsCostUsdPer1kChars: 0.06,
  };

  isReady(): boolean {
    return this.options.hasKey === true;
  }

  readinessReason(): string {
    return this.isReady() ? '' : 'no API key — the user must provide a realtime API key first';
  }

  private assertReady(): void {
    if (!this.isReady()) throw new Error(`Voice provider v14 (realtime-api) is not ready: ${this.readinessReason()}`);
  }

  transcribe(input: VoiceProviderV14SttInput): VoiceProviderV13SttResult {
    this.assertReady();
    return super.transcribe(input);
  }

  transcribeStream(input: VoiceProviderV14SttInput): VoiceProviderV14SttPartial[] {
    this.assertReady();
    return super.transcribeStream(input);
  }

  synthesize(input: VoiceProviderV14TtsInput): VoiceProviderV14TtsResult {
    this.assertReady();
    return super.synthesize(input);
  }
}

/** Factory: build a built-in v14 provider by kind. */
export function createVoiceProviderV14(kind: VoiceProviderV14Kind, options: VoiceProviderV14Options = {}): VoiceProviderV14 {
  switch (kind) {
    case 'mock': return new MockVoiceProviderV14(options);
    case 'deepgram': return new DeepgramVoiceProviderV14(options);
    case 'cartesia': return new CartesiaVoiceProviderV14(options);
    case 'whisper-local-v14': return new WhisperLocalVoiceProviderV14(options);
    case 'pocket-tts': return new PocketTtsVoiceProviderV14(options);
    case 'realtime-api': return new RealtimeApiVoiceProviderV14(options);
    default: throw new Error(`Voice provider v14 unknown kind "${kind as string}".`);
  }
}

/**
 * Wrap a v13 provider as a v14 provider (no streaming: the
 * v13 interface has no partials, so `transcribeStream` returns
 * the single final result). Lets old adapters keep working
 * behind the split interface.
 */
export function wrapVoiceProviderV13(provider: VoiceProviderV13): VoiceProviderV14 {
  const capabilities: VoiceProviderV14Capabilities = {
    stt: provider.capabilities.stt,
    streamingStt: false,
    tts: provider.capabilities.tts,
    streamingTts: false,
    realtime: provider.capabilities.realtime,
    local: provider.capabilities.local,
    requiresKey: provider.capabilities.requiresKey,
  };
  return {
    kind: provider.kind,
    name: provider.name,
    capabilities,
    profile: {
      sttLatencyMsPerSecond: 200, ttsFirstAudioMs: 150, ttsLatencyMsPer1kChars: 55, quality: 0.6,
      sttCostUsdPerMinute: 0, ttsCostUsdPer1kChars: 0,
    },
    isReady: () => provider.isReady(),
    readinessReason: () => provider.readinessReason(),
    transcribe: (input) => provider.transcribe({ frames: input.frames, atMs: input.atMs, language: input.language }),
    transcribeStream: (input) => {
      const final = provider.transcribe({ frames: input.frames, atMs: input.atMs, language: input.language });
      return [{ text: final.text, confidence: final.confidence, isFinal: true, audioMs: final.audioMs }];
    },
    synthesize: (input) => {
      const result: VoiceProviderV13TtsResult = provider.synthesize({
        text: input.text, atMs: input.atMs, voice: input.voice, language: input.language,
      });
      return { ...result, firstAudioMs: 150, chunks: 1 };
    },
  };
}

/** How the picker trades latency / quality / cost off. */
export type VoiceProviderV14PickGoal = 'latency' | 'quality' | 'cost' | 'balanced';

/** Options for `pick()`. */
export interface VoiceProviderV14PickOptions {
  goal?: VoiceProviderV14PickGoal;
  /** Only providers offering this capability. */
  capability?: 'stt' | 'tts' | 'realtime';
  /** Only local (on-device) providers. */
  localOnly?: boolean;
  /** Only providers that need no key. */
  noKeyOnly?: boolean;
}

/** Score one provider for a goal (0..1, higher is better). Pure. */
export function scoreVoiceProviderV14(
  provider: VoiceProviderV14,
  goal: VoiceProviderV14PickGoal,
  audioMinutesPerHour = 30,
  ttsCharsPerHour = 6000,
): number {
  const p = provider.profile;
  // Normalise each axis to 0..1 against the modelled ranges.
  const latencyMs = p.sttLatencyMsPerSecond * 10 + p.ttsFirstAudioMs;
  const latencyScore = Math.max(0, 1 - latencyMs / 3000);
  const qualityScore = p.quality;
  const hourlyCost = p.sttCostUsdPerMinute * audioMinutesPerHour + (p.ttsCostUsdPer1kChars * ttsCharsPerHour) / 1000;
  const costScore = Math.max(0, 1 - hourlyCost / 5);
  switch (goal) {
    case 'latency': return Math.round((latencyScore * 0.7 + qualityScore * 0.2 + costScore * 0.1) * 100) / 100;
    case 'quality': return Math.round((qualityScore * 0.7 + latencyScore * 0.2 + costScore * 0.1) * 100) / 100;
    case 'cost': return Math.round((costScore * 0.7 + latencyScore * 0.2 + qualityScore * 0.1) * 100) / 100;
    case 'balanced': return Math.round(((latencyScore + qualityScore + costScore) / 3) * 100) / 100;
    default: throw new Error(`Voice provider v14 unknown pick goal "${goal as string}".`);
  }
}

/** Modelled hourly cost (USD) of one provider at a usage level. Pure. */
export function estimateVoiceProviderV14HourlyCost(
  provider: VoiceProviderV14,
  audioMinutesPerHour: number,
  ttsCharsPerHour: number,
): number {
  if (!Number.isFinite(audioMinutesPerHour) || audioMinutesPerHour < 0) {
    throw new Error('Voice provider v14 audioMinutesPerHour must be a finite number >= 0.');
  }
  if (!Number.isFinite(ttsCharsPerHour) || ttsCharsPerHour < 0) {
    throw new Error('Voice provider v14 ttsCharsPerHour must be a finite number >= 0.');
  }
  const p = provider.profile;
  return Math.round((p.sttCostUsdPerMinute * audioMinutesPerHour + (p.ttsCostUsdPer1kChars * ttsCharsPerHour) / 1000) * 10000) / 10000;
}

/** Registry of v14 voice providers. */
export class VoiceProviderRegistryV14 {
  private readonly providers = new Map<string, VoiceProviderV14>();

  constructor(options: VoiceProviderV14Options = {}) {
    for (const kind of VOICE_PROVIDER_V14_KINDS) {
      this.providers.set(kind, createVoiceProviderV14(kind, options));
    }
  }

  register(provider: VoiceProviderV14): void {
    if (!provider || typeof provider.kind !== 'string' || !provider.kind.trim()) {
      throw new Error('Voice provider v14 registry needs a provider with a non-empty kind.');
    }
    if (typeof provider.transcribe !== 'function' || typeof provider.synthesize !== 'function' || typeof provider.isReady !== 'function') {
      throw new Error(`Voice provider v14 "${provider.kind}" must implement transcribe, synthesize and isReady.`);
    }
    this.providers.set(provider.kind, provider);
  }

  /** Register a v13 provider (wrapped to the v14 interface). */
  registerV13(provider: VoiceProviderV13): void {
    this.register(wrapVoiceProviderV13(provider));
  }

  get(kind: string): VoiceProviderV14 | undefined {
    return this.providers.get(kind);
  }

  has(kind: string): boolean {
    return this.providers.has(kind);
  }

  list(): VoiceProviderV14[] {
    return [...this.providers.values()];
  }

  readyKinds(): string[] {
    return this.list().filter((p) => p.isReady()).map((p) => p.kind);
  }

  /** Ready STT providers. */
  sttProviders(): VoiceProviderV14[] {
    return this.list().filter((p) => p.isReady() && p.capabilities.stt);
  }

  /** Ready TTS providers. */
  ttsProviders(): VoiceProviderV14[] {
    return this.list().filter((p) => p.isReady() && p.capabilities.tts);
  }

  /**
   * Pick the best ready provider for a goal + capability
   * filter, or null when none qualifies. Ties break by
   * registration order (deterministic).
   */
  pick(options: VoiceProviderV14PickOptions = {}): VoiceProviderV14 | null {
    const goal = options.goal ?? 'balanced';
    if (!['latency', 'quality', 'cost', 'balanced'].includes(goal)) {
      throw new Error(`Voice provider v14 unknown pick goal "${goal}".`);
    }
    let best: VoiceProviderV14 | null = null;
    let bestScore = -1;
    for (const provider of this.list()) {
      if (!provider.isReady()) continue;
      if (options.capability === 'stt' && !provider.capabilities.stt) continue;
      if (options.capability === 'tts' && !provider.capabilities.tts) continue;
      if (options.capability === 'realtime' && !provider.capabilities.realtime) continue;
      if (options.localOnly && !provider.capabilities.local) continue;
      if (options.noKeyOnly && provider.capabilities.requiresKey) continue;
      const score = scoreVoiceProviderV14(provider, goal);
      if (score > bestScore) {
        bestScore = score;
        best = provider;
      }
    }
    return best;
  }

  /** Pick the best ready STT + TTS pair (may be two providers). */
  pickPair(goal: VoiceProviderV14PickGoal = 'balanced'): { stt: VoiceProviderV14 | null; tts: VoiceProviderV14 | null } {
    return {
      stt: this.pick({ goal, capability: 'stt' }),
      tts: this.pick({ goal, capability: 'tts' }),
    };
  }

  size(): number {
    return this.providers.size;
  }
}

/** Create a registry preloaded with the six built-in providers (factory). */
export function createVoiceProviderRegistryV14(options: VoiceProviderV14Options = {}): VoiceProviderRegistryV14 {
  return new VoiceProviderRegistryV14(options);
}

/** One-line summary of a v14 provider (for the panel). */
export function voiceProviderV14Summary(provider: VoiceProviderV14): string {
  const caps = provider.capabilities;
  const capList = [
    caps.stt ? 'STT' : null,
    caps.streamingStt ? 'stream-STT' : null,
    caps.tts ? 'TTS' : null,
    caps.streamingTts ? 'stream-TTS' : null,
    caps.realtime ? 'realtime' : null,
    caps.local ? 'local' : 'cloud',
    caps.requiresKey ? 'needs key' : 'no key',
  ].filter((c): c is string => c !== null).join(', ');
  return (
    `${provider.name} (${provider.kind}): ${capList} — ` +
    `${provider.isReady() ? 'ready' : `not ready: ${provider.readinessReason()}`} ` +
    `(quality ${provider.profile.quality}, first-audio ${provider.profile.ttsFirstAudioMs} ms)`
  );
}

/** Registry as Markdown (for the diagnostics panel). */
export function voiceProviderRegistryV14Markdown(registry: VoiceProviderRegistryV14): string {
  const lines = ['## Voice providers v14', ''];
  for (const provider of registry.list()) {
    lines.push(`- ${voiceProviderV14Summary(provider)}`);
  }
  return lines.join('\n');
}

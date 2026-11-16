/**
 * Pluggable voice providers v13 (v1.14, Đội T5 — voice
 * realtime v13).
 *
 * Voice v12 and earlier hard-wire the mock synth: every
 * session speaks with the same mock sine TTS and the same
 * scripted STT. v13 splits "what the session does" from "who
 * speaks and listens": one `VoiceProviderV13` interface (STT +
 * TTS + capabilities), one adapter per engine, and a registry
 * the session asks for a provider by name.
 *
 *   session ──▶ VoiceProviderRegistryV13.get('edge-tts')
 *                  ├─ EdgeTtsVoiceProviderV13   (no key, cloud
 *                  │   Edge TTS voice; mock synth in tests)
 *                  ├─ WhisperLocalVoiceProviderV13 (local
 *                  │   Whisper model file, no key, no network)
 *                  ├─ RealtimeApiVoiceProviderV13 (vendor
 *                  │   realtime API, needs the user's key)
 *                  └─ MockVoiceProviderV13      (deterministic
 *                      scripted STT + mock synth, for tests)
 *
 * Key rule (same as the rest of open-bot): a provider that
 * needs a key *never* reads one itself — the host passes
 * `hasKey` (or an `apiKey` the host owns) and the adapter
 * refuses with a clear error when the key is missing. Keys
 * are never logged, never stored here, and the mock adapters
 * never touch the network.
 *
 * Adapters in this module are honest mocks of the *interface*:
 * they synthesise deterministic audio timings and scripted
 * transcripts so sessions, tools and tests can run with no
 * key, no model file and no network. A host that wants real
 * audio wires its own adapter behind the same interface —
 * `registerProvider` accepts any object that implements it.
 */

/** What a voice provider can do. */
export interface VoiceProviderV13Capabilities {
  /** Speech-to-text. */
  stt: boolean;
  /** Text-to-speech. */
  tts: boolean;
  /** Full-duplex realtime (interruptible streaming). */
  realtime: boolean;
  /** Runs fully on the user's machine (no network). */
  local: boolean;
  /** Needs the user's API key to run. */
  requiresKey: boolean;
}

/** STT input: audio frames + the virtual clock. */
export interface VoiceProviderV13SttInput {
  /** PCM16 frames (opaque here — adapters read length, not samples). */
  frames: Uint8Array[];
  /** Virtual time (ms). */
  atMs: number;
  /** Language hint (e.g. 'vi', 'en'). */
  language?: string;
}

/** STT result. */
export interface VoiceProviderV13SttResult {
  /** Transcript ('' when nothing was recognised). */
  text: string;
  /** Confidence 0..1. */
  confidence: number;
  /** True when the transcript is final (false = partial). */
  isFinal: boolean;
  /** Audio ms consumed. */
  audioMs: number;
}

/** TTS input. */
export interface VoiceProviderV13TtsInput {
  text: string;
  /** Virtual time (ms). */
  atMs: number;
  /** Voice name (provider-specific, '' = default). */
  voice?: string;
  /** Language hint. */
  language?: string;
}

/** TTS result (deterministic mock audio timing). */
export interface VoiceProviderV13TtsResult {
  /** Audio ms the synthesised speech would last. */
  audioMs: number;
  /** Chars synthesised. */
  chars: number;
  /** Voice actually used. */
  voice: string;
  /** True when the adapter really synthesised (mock adapters report true — they model the timing). */
  synthesised: boolean;
}

/** One voice provider: STT + TTS behind a stable interface. */
export interface VoiceProviderV13 {
  /** Provider kind (registry key). */
  readonly kind: string;
  /** Human-readable name. */
  readonly name: string;
  /** What this provider can do. */
  readonly capabilities: VoiceProviderV13Capabilities;
  /** True when the provider can run right now (key present / model present / always for mock). */
  isReady(): boolean;
  /** Why the provider cannot run ('' when ready). */
  readinessReason(): string;
  /** Transcribe audio frames. */
  transcribe(input: VoiceProviderV13SttInput): VoiceProviderV13SttResult;
  /** Synthesise text. */
  synthesize(input: VoiceProviderV13TtsInput): VoiceProviderV13TtsResult;
}

/** Provider kinds built into this module. */
export type VoiceProviderV13Kind = 'mock' | 'edge-tts' | 'whisper-local' | 'realtime-api';

/** The built-in kinds, in the order the picker shows them. */
export const VOICE_PROVIDER_V13_KINDS: readonly VoiceProviderV13Kind[] = [
  'mock',
  'edge-tts',
  'whisper-local',
  'realtime-api',
];

export function isVoiceProviderV13Kind(value: unknown): value is VoiceProviderV13Kind {
  return typeof value === 'string' && (VOICE_PROVIDER_V13_KINDS as readonly string[]).includes(value);
}

/** Options shared by every built-in provider. */
export interface VoiceProviderV13Options {
  /** Language hint (default 'vi'). */
  language?: string;
  /** Voice name (default '' = provider default). */
  voice?: string;
  /** Ms of audio per synthesised char (default 55). */
  msPerChar?: number;
  /** Scripted transcripts the mock STT returns, in order (last repeats). */
  mockTranscripts?: string[];
  /** Local Whisper model file path (whisper-local only). */
  modelPath?: string;
  /** True when the user has provided an API key (realtime-api only — the key itself is never passed here). */
  hasKey?: boolean;
  /** Realtime API model name (realtime-api only, default 'gpt-realtime'). */
  model?: string;
}

export function defaultVoiceProviderV13Options(): Required<VoiceProviderV13Options> {
  return {
    language: 'vi',
    voice: '',
    msPerChar: 55,
    mockTranscripts: [],
    modelPath: '',
    hasKey: false,
    model: 'gpt-realtime',
  };
}

export function validateVoiceProviderV13Options(options: VoiceProviderV13Options): Required<VoiceProviderV13Options> {
  const base = defaultVoiceProviderV13Options();
  const num = (value: number | undefined, fallback: number, name: string, min: number, max: number): number => {
    if (value === undefined) return fallback;
    if (!Number.isFinite(value) || value < min || value > max) {
      throw new Error(`Voice provider v13 ${name} must be a finite number in [${min}, ${max}].`);
    }
    return value;
  };
  if (options.mockTranscripts !== undefined && !Array.isArray(options.mockTranscripts)) {
    throw new Error('Voice provider v13 mockTranscripts must be an array of strings.');
  }
  if (options.modelPath !== undefined && typeof options.modelPath !== 'string') {
    throw new Error('Voice provider v13 modelPath must be a string.');
  }
  if (options.model !== undefined && typeof options.model !== 'string') {
    throw new Error('Voice provider v13 model must be a string.');
  }
  return {
    language: options.language ?? base.language,
    voice: options.voice ?? base.voice,
    msPerChar: Math.floor(num(options.msPerChar, base.msPerChar, 'msPerChar', 1, 10000)),
    mockTranscripts: options.mockTranscripts ? [...options.mockTranscripts] : [],
    modelPath: options.modelPath ?? base.modelPath,
    hasKey: options.hasKey ?? base.hasKey,
    model: options.model ?? base.model,
  };
}

function audioMsForFramesV13(frames: Uint8Array[]): number {
  // 20 ms per frame is the mock-audio convention across the voice modules.
  return frames.length * 20;
}

/**
 * Shared mock behaviour: scripted transcripts in order, and
 * deterministic TTS timing. Concrete adapters only differ in
 * `kind`, `name`, `capabilities` and readiness.
 */
abstract class BaseMockVoiceProviderV13 implements VoiceProviderV13 {
  abstract readonly kind: string;
  abstract readonly name: string;
  abstract readonly capabilities: VoiceProviderV13Capabilities;
  protected readonly options: Required<VoiceProviderV13Options>;
  private transcriptIndex = 0;
  private transcribes = 0;
  private synthesises = 0;

  constructor(options: VoiceProviderV13Options = {}) {
    this.options = validateVoiceProviderV13Options(options);
  }

  abstract isReady(): boolean;
  abstract readinessReason(): string;

  transcribe(input: VoiceProviderV13SttInput): VoiceProviderV13SttResult {
    const audioMs = audioMsForFramesV13(input.frames);
    this.transcribes += 1;
    if (input.frames.length === 0 || this.options.mockTranscripts.length === 0) {
      return { text: '', confidence: 0, isFinal: true, audioMs };
    }
    const text = this.options.mockTranscripts[Math.min(this.transcriptIndex, this.options.mockTranscripts.length - 1)] as string;
    this.transcriptIndex += 1;
    return { text, confidence: 0.9, isFinal: true, audioMs };
  }

  synthesize(input: VoiceProviderV13TtsInput): VoiceProviderV13TtsResult {
    if (!input.text.trim()) {
      throw new Error(`Voice provider v13 (${this.kind}) cannot synthesise empty text.`);
    }
    this.synthesises += 1;
    return {
      audioMs: Math.max(1, input.text.length * this.options.msPerChar),
      chars: input.text.length,
      voice: input.voice || this.options.voice || 'default',
      synthesised: true,
    };
  }

  /** Counters (for diagnostics, not part of the interface). */
  getUsage(): { transcribes: number; synthesises: number } {
    return { transcribes: this.transcribes, synthesises: this.synthesises };
  }
}

/** Deterministic mock provider: scripted STT + mock TTS. Always ready. */
export class MockVoiceProviderV13 extends BaseMockVoiceProviderV13 {
  readonly kind = 'mock';
  readonly name = 'Mock (scripted)';
  readonly capabilities: VoiceProviderV13Capabilities = {
    stt: true, tts: true, realtime: false, local: true, requiresKey: false,
  };

  isReady(): boolean {
    return true;
  }

  readinessReason(): string {
    return '';
  }
}

/**
 * Edge TTS provider (mock adapter): cloud Edge TTS voice, no
 * key needed. Ready always in this mock — a live host adapter
 * replaces `transcribe`/`synthesize` with real Edge TTS calls
 * and keeps the same `kind` so sessions need no change.
 */
export class EdgeTtsVoiceProviderV13 extends BaseMockVoiceProviderV13 {
  readonly kind = 'edge-tts';
  readonly name = 'Edge TTS';
  readonly capabilities: VoiceProviderV13Capabilities = {
    stt: false, tts: true, realtime: false, local: false, requiresKey: false,
  };

  isReady(): boolean {
    return true;
  }

  readinessReason(): string {
    return '';
  }

  transcribe(_input: VoiceProviderV13SttInput): VoiceProviderV13SttResult {
    throw new Error('Voice provider v13 (edge-tts) has no STT — pair it with a whisper-local or mock STT provider.');
  }
}

/**
 * Local Whisper provider (mock adapter): on-device Whisper
 * STT + mock TTS. Ready only when the host configured a model
 * path — without a model file there is nothing to run.
 */
export class WhisperLocalVoiceProviderV13 extends BaseMockVoiceProviderV13 {
  readonly kind = 'whisper-local';
  readonly name = 'Whisper (local)';
  readonly capabilities: VoiceProviderV13Capabilities = {
    stt: true, tts: true, realtime: false, local: true, requiresKey: false,
  };

  isReady(): boolean {
    return this.options.modelPath.trim().length > 0;
  }

  readinessReason(): string {
    return this.isReady() ? '' : 'no Whisper model path configured — set modelPath to a local model file';
  }
}

/**
 * Realtime API provider (mock adapter): vendor realtime
 * speech-to-speech. Ready only when the user provided a key
 * (`hasKey: true` — the key itself is never passed here, never
 * logged, never stored). Without a key every call refuses.
 */
export class RealtimeApiVoiceProviderV13 extends BaseMockVoiceProviderV13 {
  readonly kind = 'realtime-api';
  readonly name = 'Realtime API';
  readonly capabilities: VoiceProviderV13Capabilities = {
    stt: true, tts: true, realtime: true, local: false, requiresKey: true,
  };

  isReady(): boolean {
    return this.options.hasKey === true;
  }

  readinessReason(): string {
    return this.isReady() ? '' : 'no API key — the user must provide a realtime API key first';
  }

  private assertReady(): void {
    if (!this.isReady()) throw new Error(`Voice provider v13 (realtime-api) is not ready: ${this.readinessReason()}`);
  }

  transcribe(input: VoiceProviderV13SttInput): VoiceProviderV13SttResult {
    this.assertReady();
    return super.transcribe(input);
  }

  synthesize(input: VoiceProviderV13TtsInput): VoiceProviderV13TtsResult {
    this.assertReady();
    return super.synthesize(input);
  }
}

/**
 * Factory: build a built-in provider by kind. Unknown kinds
 * throw — custom providers go through the registry, not here.
 */
export function createVoiceProviderV13(kind: VoiceProviderV13Kind, options: VoiceProviderV13Options = {}): VoiceProviderV13 {
  switch (kind) {
    case 'mock': return new MockVoiceProviderV13(options);
    case 'edge-tts': return new EdgeTtsVoiceProviderV13(options);
    case 'whisper-local': return new WhisperLocalVoiceProviderV13(options);
    case 'realtime-api': return new RealtimeApiVoiceProviderV13(options);
    default: throw new Error(`Voice provider v13 unknown kind "${kind as string}".`);
  }
}

/**
 * Registry of voice providers: built-ins are registered by
 * default; hosts register custom adapters (any object that
 * implements `VoiceProviderV13`) under their own kind name.
 */
export class VoiceProviderRegistryV13 {
  private readonly providers = new Map<string, VoiceProviderV13>();

  constructor(options: VoiceProviderV13Options = {}) {
    for (const kind of VOICE_PROVIDER_V13_KINDS) {
      this.providers.set(kind, createVoiceProviderV13(kind, options));
    }
  }

  /** Register (or replace) a provider under `provider.kind`. */
  register(provider: VoiceProviderV13): void {
    if (!provider || typeof provider.kind !== 'string' || !provider.kind.trim()) {
      throw new Error('Voice provider v13 registry needs a provider with a non-empty kind.');
    }
    if (typeof provider.transcribe !== 'function' || typeof provider.synthesize !== 'function' || typeof provider.isReady !== 'function') {
      throw new Error(`Voice provider v13 "${provider.kind}" must implement transcribe, synthesize and isReady.`);
    }
    this.providers.set(provider.kind, provider);
  }

  get(kind: string): VoiceProviderV13 | undefined {
    return this.providers.get(kind);
  }

  has(kind: string): boolean {
    return this.providers.has(kind);
  }

  /** All providers, in registration order. */
  list(): VoiceProviderV13[] {
    return [...this.providers.values()];
  }

  /** Kinds of the providers that are ready right now. */
  readyKinds(): string[] {
    return this.list().filter((p) => p.isReady()).map((p) => p.kind);
  }

  /** Pick the first ready provider that offers the capability (or null). */
  pickFor(capability: 'stt' | 'tts' | 'realtime'): VoiceProviderV13 | null {
    for (const provider of this.list()) {
      if (provider.isReady() && provider.capabilities[capability]) return provider;
    }
    return null;
  }

  size(): number {
    return this.providers.size;
  }
}

/** Create a registry preloaded with the four built-in providers (factory). */
export function createVoiceProviderRegistryV13(options: VoiceProviderV13Options = {}): VoiceProviderRegistryV13 {
  return new VoiceProviderRegistryV13(options);
}

/** One-line summary of a provider (for the panel). */
export function voiceProviderV13Summary(provider: VoiceProviderV13): string {
  const caps = provider.capabilities;
  const capList = [
    caps.stt ? 'STT' : null,
    caps.tts ? 'TTS' : null,
    caps.realtime ? 'realtime' : null,
    caps.local ? 'local' : 'cloud',
    caps.requiresKey ? 'needs key' : 'no key',
  ].filter((c): c is string => c !== null).join(', ');
  return `${provider.name} (${provider.kind}): ${capList} — ${provider.isReady() ? 'ready' : `not ready: ${provider.readinessReason()}`}`;
}

/** Registry as Markdown (for the diagnostics panel). */
export function voiceProviderRegistryV13Markdown(registry: VoiceProviderRegistryV13): string {
  const lines = ['## Voice providers v13', ''];
  for (const provider of registry.list()) {
    lines.push(`- ${voiceProviderV13Summary(provider)}`);
  }
  return lines.join('\n');
}

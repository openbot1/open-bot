/**
 * Shared types for voice realtime v28 (v1.41, Team T5).
 *
 * v28 is the realtime v3 layer on top of v27. v27 owns the frame
 * loop (barge-in policy, VAD tuning, personas, durable session
 * state). v28 owns the things a live realtime session needs
 * *around* that loop to feel like a real voice conversation:
 *
 *   - a mock realtime transport: streaming audio chunks in and
 *     out (PCM16 frames, sequence numbers, jitter buffer,
 *     backpressure / drop policy, latency stats) that a real
 *     provider transport can replace later — no network, no key,
 *     no mic, no sound card, so every chunk here is synthetic;
 *   - a VAD hook: a small, tunable voice-activity detector with
 *     a silence timeout, hangover and an adaptive noise floor,
 *     firing onSpeechStart / onSpeechEnd / onSilenceTimeout
 *     callbacks the session wires into turn-taking;
 *   - a realtime session: lifecycle start / pause / resume /
 *     stop, streaming chunks through the transport, VAD-driven
 *     turns, barge-in that stops playback and keeps the
 *     context (unspoken remainder + turn), floor control, and
 *     a full session log;
 *   - memory-block voice style: the `persona` block (tone,
 *     pace, speaking style) and the `human` block (how to
 *     address the user, name, preferences, language) are read
 *     and turned into a voice config (rate, pitch, style
 *     preset, greeting); when a block changes the config is
 *     re-derived and subscribers are notified; when no block
 *     exists a default preset applies (idea: Letta shared
 *     memory blocks, §2 of docs/repo-survey-v141.md — the
 *     parsing and the bridge are our own design);
 *   - voice command routing: a spoken transcript is matched
 *     against builtin intents (English + Vietnamese) and routed
 *     to a tool call, with a confirmation policy for
 *     destructive / costly commands;
 *   - transcript + summary: every turn is recorded and the
 *     session can be summarised (counts, durations, key
 *     phrases, key sentences) and exported as JSON/Markdown;
 *   - multi-voice casting: one bot can speak in several
 *     voices by role (narrator / assistant / announcer /
 *     alert), with a fallback chain per role and mid-session
 *     role switching.
 *
 * All clocks virtual (the caller passes `atMs`); all audio is
 * mock/synthetic frame energy; TTS playback is a mock stub.
 * v28 consumes nothing from v27 at runtime except its
 * vocabulary (floor states, word-boundary cuts) re-expressed
 * in its own types — v27 stays untouched.
 */

export type VoiceV28Clock = { nowMs: number };

/** Lifecycle of a realtime v28 session. */
export type VoiceV28SessionState =
  | 'idle'
  | 'connecting'
  | 'listening'
  | 'thinking'
  | 'speaking'
  | 'paused'
  | 'ended';

/** Who holds the conversation floor right now. */
export type VoiceV28FloorHolder = 'none' | 'user' | 'agent';

/** Which side a transport chunk belongs to. */
export type VoiceV28ChunkSource = 'mic' | 'tts';

/** Why a session stopped. */
export type VoiceV28StopReason =
  | 'user-request'
  | 'command'
  | 'timeout'
  | 'transport-error'
  | 'idle-timeout';

/** Why a turn ended. */
export type VoiceV28TurnEndReason =
  | 'silence'
  | 'keyword'
  | 'timeout'
  | 'barge-in'
  | 'explicit'
  | 'abandoned';

/** Speaking style presets (a style is a way of talking). */
export type VoiceV28SpeakingStyle =
  | 'formal'
  | 'intimate'
  | 'concise'
  | 'storyteller'
  | 'default';

/** Voice role inside one bot's cast. */
export type VoiceV28CastRole =
  | 'narrator'
  | 'assistant'
  | 'announcer'
  | 'alert';

/** What a voice command resolved to. */
export type VoiceV28CommandKind =
  | 'stop-session'
  | 'pause-session'
  | 'resume-session'
  | 'switch-voice'
  | 'switch-style'
  | 'repeat-last'
  | 'summarise-session'
  | 'speak-slower'
  | 'speak-faster'
  | 'speak-softer'
  | 'speak-louder'
  | 'open-settings'
  | 'unknown';

/** How a voice command is executed. */
export type VoiceV28CommandExecution = 'direct' | 'confirm-first' | 'rejected';

/** Where a transcript turn came from. */
export type VoiceV28TurnSpeaker = 'user' | 'agent';

/** One audio chunk flowing through the mock transport. */
export interface VoiceV28AudioChunk {
  /** Monotonic sequence number within the stream. */
  seq: number;
  /** Virtual timestamp the chunk was produced (ms). */
  atMs: number;
  /** Which side produced the chunk. */
  source: VoiceV28ChunkSource;
  /** PCM16 samples, normalised to -1..1. */
  samples: number[];
  /** Sample rate of the samples (Hz). */
  sampleRate: number;
  /** Channel count (1 = mono). */
  channels: number;
  /** True when this chunk ends a burst / utterance. */
  final: boolean;
}

/** Transport drop policy when a queue is full. */
export type VoiceV28DropPolicy = 'drop-oldest' | 'drop-newest' | 'block';

/** Tunables for the mock realtime transport. */
export interface VoiceV28TransportConfig {
  /** Samples per chunk (default 480 @ 16 kHz = 30 ms). */
  chunkSamples: number;
  /** Sample rate (Hz). */
  sampleRate: number;
  /** Channel count. */
  channels: number;
  /** Max chunks buffered per direction before the drop policy fires. */
  maxBufferedChunks: number;
  /** What to do when a queue is full. */
  dropPolicy: VoiceV28DropPolicy;
  /** Simulated one-way network latency applied to delivery (ms). */
  simulatedLatencyMs: number;
  /** Simulated jitter added to delivery (ms, 0 = none). */
  simulatedJitterMs: number;
}

export const VOICE_V28_SAMPLE_RATE_DEFAULT = 16000;
export const VOICE_V28_CHUNK_SAMPLES_DEFAULT = 480;
export const VOICE_V28_CHANNELS_DEFAULT = 1;
export const VOICE_V28_MAX_BUFFERED_CHUNKS_DEFAULT = 120;
export const VOICE_V28_SIMULATED_LATENCY_DEFAULT_MS = 40;
export const VOICE_V28_MAX_CHUNKS_PER_SESSION_DEFAULT = 200_000;
export const VOICE_V28_MAX_TRANSPORT_EVENTS_DEFAULT = 1000;
export const VOICE_V28_JITTER_BUFFER_TARGET_DEFAULT_MS = 120;

/** One VAD frame fed to the hook (energy-based, caller-supplied). */
export interface VoiceV28VadFrame {
  atMs: number;
  /** Normalised frame energy 0..1. */
  energy: number;
  /** Optional caller-supplied VAD verdict for this frame. */
  isSpeech?: boolean;
  /** Optional transcript fragment for keyword end detection. */
  text?: string | null;
}

/** Tunable VAD hook configuration. */
export interface VoiceV28VadHookConfig {
  /** Energy above this counts as speech (0..1). */
  threshold: number;
  /** ms of silence after speech before the turn is over. */
  silenceTimeoutMs: number;
  /** Extra ms of speech kept after the level drops. */
  hangoverMs: number;
  /** Speech shorter than this is treated as noise (ms). */
  minSpeechMs: number;
  /** Learned background level, 0..1 (adaptive when enabled). */
  noiseFloor: number;
  /** Learn the noise floor from observed silence frames. */
  adaptive: boolean;
  /** Keyword that ends a turn immediately (null = none). */
  endKeyword: string | null;
}

export const VOICE_V28_VAD_THRESHOLD_DEFAULT = 0.18;
export const VOICE_V28_VAD_SILENCE_TIMEOUT_DEFAULT_MS = 800;
export const VOICE_V28_VAD_HANGOVER_DEFAULT_MS = 150;
export const VOICE_V28_VAD_MIN_SPEECH_DEFAULT_MS = 220;
export const VOICE_V28_VAD_NOISE_FLOOR_DEFAULT = 0.05;
export const VOICE_V28_VAD_NOISE_FLOOR_LEARN_RATE = 0.08;
export const VOICE_V28_VAD_FRAME_MS_DEFAULT = 50;
export const VOICE_V28_VAD_MAX_SEGMENTS_DEFAULT = 500;

/** What the VAD hook classified one frame as. */
export type VoiceV28VadFrameKind = 'speech' | 'silence' | 'noise';

/** Result of feeding one frame to the VAD hook. */
export interface VoiceV28VadHookFrameResult {
  kind: VoiceV28VadFrameKind;
  /** Effective threshold in force for this frame, 0..1. */
  threshold: number;
  /** Current noise-floor estimate, 0..1. */
  noiseFloor: number;
  /** ms of continuous speech so far (0 while silent). */
  speechMs: number;
  /** ms of continuous silence so far (0 while speaking). */
  silenceMs: number;
  /** True when this frame fired onSpeechStart. */
  speechStarted: boolean;
  /** True when this frame fired onSpeechEnd. */
  speechEnded: boolean;
  /** True when this frame fired onSilenceTimeout. */
  silenceTimedOut: boolean;
  /** True when this frame ended the current turn. */
  turnEnded: boolean;
  /** Why the turn ended (null when it did not end). */
  endReason: VoiceV28TurnEndReason | null;
  /** True when this frame was a short burst rejected as noise. */
  noiseRejected: boolean;
}

/** One contiguous speech segment found by the VAD hook. */
export interface VoiceV28SpeechSegment {
  id: string;
  startedAtMs: number;
  endedAtMs: number | null;
  durationMs: number | null;
  /** Peak energy seen inside the segment, 0..1. */
  peakEnergy: number;
  /** Frames classified as speech inside the segment. */
  frames: number;
  /** True when the segment was rejected as too short (noise). */
  rejectedAsNoise: boolean;
  endReason: VoiceV28TurnEndReason | null;
}

/** A voice config derived from memory blocks + style preset. */
export interface VoiceV28VoiceConfig {
  /** Speech rate multiplier (0.5..2). */
  rate: number;
  /** Pitch shift in semitones (-12..12). */
  pitch: number;
  /** Speaking style preset in force. */
  style: VoiceV28SpeakingStyle;
  /** BCP-47 language tag the voice speaks. */
  language: string;
  /** Provider voice name (mock voice when no engine). */
  voice: string;
  /** How to address the user (e.g. "anh", "bạn", "you"). */
  addressForm: string;
  /** The user's name as remembered ('' = unknown). */
  userName: string;
  /** Greeting template with {name} / {address} placeholders. */
  greetingTemplate: string;
  /** Where the config came from. */
  source: 'memory-blocks' | 'preset' | 'fallback';
  /** Memory block versions the config was derived from. */
  blockVersions: { persona: number | null; human: number | null };
}

/** One speaking-style preset (rate / pitch / phrasing hints). */
export interface VoiceV28StylePreset {
  id: VoiceV28SpeakingStyle;
  name: string;
  description: string;
  /** Rate multiplier. */
  rate: number;
  /** Pitch shift in semitones. */
  pitch: number;
  /** Max words per spoken sentence (guidance for phrasing). */
  maxWordsPerSentence: number;
  /** True when the style prefers short answers. */
  prefersShortAnswers: boolean;
  /** True when the style tells stories / uses narrative phrasing. */
  narrative: boolean;
  /** Greeting template with {name} / {address} placeholders. */
  greetingTemplate: string;
}

/** Builtin speaking-style presets. */
export const VOICE_V28_STYLE_PRESETS: readonly VoiceV28StylePreset[] = [
  {
    id: 'default',
    name: 'Default',
    description: 'Warm everyday voice, balanced pace and length.',
    rate: 1,
    pitch: 0,
    maxWordsPerSentence: 22,
    prefersShortAnswers: false,
    narrative: false,
    greetingTemplate: 'Hello {name}!',
  },
  {
    id: 'formal',
    name: 'Formal',
    description: 'Measured, precise voice for work, reports and meetings.',
    rate: 0.95,
    pitch: -1,
    maxWordsPerSentence: 25,
    prefersShortAnswers: false,
    narrative: false,
    greetingTemplate: 'Good day {address}. How may I help you today?',
  },
  {
    id: 'intimate',
    name: 'Intimate',
    description: 'Close, warm voice for a trusted companion — soft and slow.',
    rate: 0.9,
    pitch: 1,
    maxWordsPerSentence: 18,
    prefersShortAnswers: false,
    narrative: false,
    greetingTemplate: 'Hi {name}, good to hear you.',
  },
  {
    id: 'concise',
    name: 'Concise',
    description: 'Fast, clipped voice that wastes no words.',
    rate: 1.25,
    pitch: 0,
    maxWordsPerSentence: 12,
    prefersShortAnswers: true,
    narrative: false,
    greetingTemplate: 'Hi {name}. Go ahead.',
  },
  {
    id: 'storyteller',
    name: 'Storyteller',
    description: 'Slow, expressive voice for reading and stories.',
    rate: 0.88,
    pitch: -2,
    maxWordsPerSentence: 30,
    prefersShortAnswers: false,
    narrative: true,
    greetingTemplate: 'Hello {name}. Settle in — let me tell you.',
  },
];

/** Vietnamese greeting templates, one per style (used when language is vi). */
export const VOICE_V28_STYLE_GREETINGS_VI: Record<VoiceV28SpeakingStyle, string> = {
  default: 'Chào {name}!',
  formal: 'Chào {address}. Hôm nay tôi có thể giúp gì cho {address}?',
  intimate: 'Chào {name}, nghe được giọng {address} thật vui.',
  concise: 'Chào {name}. Nói đi.',
  storyteller: 'Chào {name}. Ngồi xuống nhé — để tôi kể cho nghe.',
};

/** English greeting templates, one per style (used when language is en). */
export const VOICE_V28_STYLE_GREETINGS_EN: Record<VoiceV28SpeakingStyle, string> = {
  default: 'Hello {name}!',
  formal: 'Good day {address}. How may I help you today?',
  intimate: 'Hi {name}, good to hear you.',
  concise: 'Hi {name}. Go ahead.',
  storyteller: 'Hello {name}. Settle in — let me tell you.',
};

/** One memory block as seen by the voice style bridge. */
export interface VoiceV28MemoryBlockView {
  label: string;
  content: string;
  version: number;
}

/** Minimal block source the style bridge reads from. */
export interface VoiceV28BlockSource {
  /** Read one block by label (null when missing). */
  getBlock(label: string): VoiceV28MemoryBlockView | null;
  /** List blocks attached to a bot (empty when the source cannot answer). */
  listAttached?(botId: string): VoiceV28MemoryBlockView[];
}

/** What changed when the bridge re-read the blocks. */
export interface VoiceV28BlockChange {
  atMs: number;
  label: string;
  /** Previous version (null = block did not exist). */
  previousVersion: number | null;
  /** New version (null = block was deleted). */
  newVersion: number | null;
  kind: 'created' | 'updated' | 'deleted' | 'unchanged';
}

/** Result of re-deriving the voice config from the blocks. */
export interface VoiceV28StyleRefreshResult {
  atMs: number;
  config: VoiceV28VoiceConfig;
  changes: VoiceV28BlockChange[];
  /** True when the config actually changed. */
  changed: boolean;
  /** What changed about the config, in plain words. */
  changedFields: string[];
}

/** One voice command matched from a transcript. */
export interface VoiceV28CommandMatch {
  kind: VoiceV28CommandKind;
  /** Raw transcript that matched. */
  transcript: string;
  /** Confidence 0..1 of the match. */
  confidence: number;
  /** Tool this command routes to (null = session-internal, no tool). */
  toolName: string | null;
  /** Arguments for the tool call (JSON-safe). */
  toolArgs: Record<string, unknown>;
  /** How the command may run. */
  execution: VoiceV28CommandExecution;
  /** Human reason for confirm-first / rejected. */
  reason: string | null;
  /** Matched pattern (for debugging / audit). */
  pattern: string | null;
  /** Detected language of the transcript. */
  language: 'en' | 'vi' | 'other';
}

/** One transcript turn inside a session. */
export interface VoiceV28TranscriptTurn {
  id: string;
  sessionId: string;
  index: number;
  speaker: VoiceV28TurnSpeaker;
  text: string;
  startedAtMs: number;
  endedAtMs: number | null;
  durationMs: number | null;
  /** True when this turn was cut short by a barge-in. */
  interrupted: boolean;
  /** Voice / role that spoke this turn (agent turns only). */
  voiceId: string | null;
  castRole: VoiceV28CastRole | null;
}

/** Summary of one voice session's transcript. */
export interface VoiceV28SessionSummary {
  sessionId: string;
  botId: string | null;
  startedAtMs: number | null;
  endedAtMs: number | null;
  durationMs: number | null;
  turns: number;
  userTurns: number;
  agentTurns: number;
  interruptions: number;
  words: number;
  userWords: number;
  agentWords: number;
  /** Most frequent content words (lowercased, stopwords removed). */
  topPhrases: { phrase: string; count: number }[];
  /** One key sentence per turn (first sentence, trimmed). */
  keySentences: string[];
  /** Style preset in force at summary time. */
  style: VoiceV28SpeakingStyle;
  /** Voice id in force at summary time. */
  voiceId: string | null;
}

/** One voice assignment inside a bot's cast. */
export interface VoiceV28CastAssignment {
  botId: string;
  role: VoiceV28CastRole;
  voiceId: string;
  assignedAtMs: number;
  lastSwitchedAtMs: number | null;
  switches: number;
}

/** One cast switch event (audit). */
export interface VoiceV28CastSwitchEvent {
  atMs: number;
  botId: string;
  role: VoiceV28CastRole;
  fromVoiceId: string | null;
  toVoiceId: string;
  reason: string;
}

/** One event in a realtime session log. */
export interface VoiceV28SessionLogEvent {
  atMs: number;
  kind:
    | 'start'
    | 'connect'
    | 'listen'
    | 'think'
    | 'speak'
    | 'user-start'
    | 'user-end'
    | 'agent-start'
    | 'agent-done'
    | 'barge-in'
    | 'interrupt-stop'
    | 'pause'
    | 'resume'
    | 'style-change'
    | 'cast-switch'
    | 'command'
    | 'chunk-drop'
    | 'transport-error'
    | 'timeout'
    | 'stop';
  detail: string;
}

/** Plain-JSON snapshot of a whole v28 session. */
export interface VoiceV28SessionSnapshot {
  sessionId: string;
  botId: string | null;
  state: VoiceV28SessionState;
  floor: VoiceV28FloorHolder;
  style: VoiceV28SpeakingStyle;
  voiceId: string | null;
  rate: number;
  pitch: number;
  language: string;
  addressForm: string;
  userName: string;
  turnIndex: number;
  turns: number;
  interruptions: number;
  chunksIn: number;
  chunksOut: number;
  chunksDropped: number;
  startedAtMs: number | null;
  updatedAtMs: number;
  endedAtMs: number | null;
  stopReason: VoiceV28StopReason | null;
  agentSpeaking: boolean;
  currentReply: string | null;
  spokenChars: number;
  remainingChars: number;
  events: number;
}

/** Allowed state transitions for the realtime session machine. */
export const VOICE_V28_STATE_TRANSITIONS: Record<
  VoiceV28SessionState,
  readonly VoiceV28SessionState[]
> = {
  idle: ['connecting', 'ended'],
  connecting: ['listening', 'ended'],
  listening: ['thinking', 'speaking', 'paused', 'ended'],
  thinking: ['speaking', 'listening', 'paused', 'ended'],
  speaking: ['listening', 'paused', 'ended'],
  paused: ['listening', 'speaking', 'ended'],
  ended: [],
};

/** Max session log events kept in memory (oldest dropped first). */
export const VOICE_V28_MAX_LOG_EVENTS_DEFAULT = 1000;
/** Max transcript turns kept per session. */
export const VOICE_V28_MAX_TRANSCRIPT_TURNS_DEFAULT = 500;
/** Max words counted for the top-phrases list. */
export const VOICE_V28_MAX_TOP_PHRASES_DEFAULT = 10;
/** Max commands kept in the router log. */
export const VOICE_V28_MAX_COMMAND_LOG_DEFAULT = 200;
/** Max cast switch events kept per bot. */
export const VOICE_V28_MAX_CAST_EVENTS_DEFAULT = 200;
/** Default per-session idle timeout (ms) — 0 = disabled. */
export const VOICE_V28_IDLE_TIMEOUT_DEFAULT_MS = 0;
/** Default max session length (ms) — 0 = unlimited. */
export const VOICE_V28_MAX_SESSION_DEFAULT_MS = 0;
/** Barge-in grace: ignore user bursts this soon after the agent starts (ms). */
export const VOICE_V28_BARGE_IN_GRACE_DEFAULT_MS = 300;
/** Minimum user speech to count as a barge-in (ms). */
export const VOICE_V28_BARGE_IN_MIN_SPEECH_DEFAULT_MS = 250;

/** Default fallback voice config (no memory blocks at all). */
export function defaultVoiceConfigV28(): VoiceV28VoiceConfig {
  return {
    rate: 1,
    pitch: 0,
    style: 'default',
    language: 'en',
    voice: 'mock-default',
    addressForm: 'you',
    userName: '',
    greetingTemplate: 'Hello {name}!',
    source: 'fallback',
    blockVersions: { persona: null, human: null },
  };
}

/** Default transport config (mock, 16 kHz mono, 30 ms chunks). */
export function defaultTransportConfigV28(): VoiceV28TransportConfig {
  return {
    chunkSamples: VOICE_V28_CHUNK_SAMPLES_DEFAULT,
    sampleRate: VOICE_V28_SAMPLE_RATE_DEFAULT,
    channels: VOICE_V28_CHANNELS_DEFAULT,
    maxBufferedChunks: VOICE_V28_MAX_BUFFERED_CHUNKS_DEFAULT,
    dropPolicy: 'drop-oldest',
    simulatedLatencyMs: VOICE_V28_SIMULATED_LATENCY_DEFAULT_MS,
    simulatedJitterMs: 0,
  };
}

/** Default VAD hook config (balanced). */
export function defaultVadHookConfigV28(): VoiceV28VadHookConfig {
  return {
    threshold: VOICE_V28_VAD_THRESHOLD_DEFAULT,
    silenceTimeoutMs: VOICE_V28_VAD_SILENCE_TIMEOUT_DEFAULT_MS,
    hangoverMs: VOICE_V28_VAD_HANGOVER_DEFAULT_MS,
    minSpeechMs: VOICE_V28_VAD_MIN_SPEECH_DEFAULT_MS,
    noiseFloor: VOICE_V28_VAD_NOISE_FLOOR_DEFAULT,
    adaptive: true,
    endKeyword: null,
  };
}

/** Look a style preset up by id (null when unknown). */
export function stylePresetV28(id: string): VoiceV28StylePreset | null {
  return VOICE_V28_STYLE_PRESETS.find((p) => p.id === id) ?? null;
}

/** Greeting template for a style + language (falls back to English). */
export function greetingTemplateV28(
  style: VoiceV28SpeakingStyle,
  language: string,
): string {
  const lang = (language ?? 'en').toLowerCase().slice(0, 2);
  if (lang === 'vi') return VOICE_V28_STYLE_GREETINGS_VI[style];
  return VOICE_V28_STYLE_GREETINGS_EN[style];
}

/** Render a greeting from a template ({name} / {address}). */
export function renderGreetingV28(
  template: string,
  config: Pick<VoiceV28VoiceConfig, 'userName' | 'addressForm'>,
): string {
  const name = config.userName.trim() || 'friend';
  return template
    .replaceAll('{name}', name)
    .replaceAll('{address}', config.addressForm || 'you');
}

/** Clamp a number into [min, max] (non-finite -> min). */
export function clampV28(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

export function round2V28(value: number): number {
  return Math.round(value * 100) / 100;
}

export function round4V28(value: number): number {
  return Math.round(value * 10000) / 10000;
}

export function meanV28(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

export function percentileV28(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

export function isValidVoiceV28Id(id: string): boolean {
  return /^[a-z0-9][a-z0-9_-]{0,63}$/.test(id);
}

/** Cut text at a word boundary at or before `chars` (never mid-word). */
export function cutAtWordBoundaryV28(text: string, chars: number): string {
  if (chars <= 0) return '';
  if (chars >= text.length) return text;
  const cut = text.slice(0, chars);
  const lastSpace = cut.lastIndexOf(' ');
  if (lastSpace <= 0) return cut;
  return cut.slice(0, lastSpace);
}

/** Count words (whitespace split, empty-safe). */
export function countWordsV28(text: string): number {
  const trimmed = (text ?? '').trim();
  if (trimmed === '') return 0;
  return trimmed.split(/\s+/).length;
}

/** Split text into sentences (keeps the terminator). */
export function splitSentencesV28(text: string): string[] {
  const parts = (text ?? '')
    .split(/(?<=[.!?…])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return parts;
}

/** Effective VAD threshold for a config (sensitivity is folded into the threshold itself in v28). */
export function effectiveThresholdV28(config: VoiceV28VadHookConfig): number {
  return round4V28(Math.max(config.noiseFloor + 0.02, config.threshold));
}

/** Format a duration for display (ms / s). */
export function formatDurationV28(ms: number | null): string {
  if (ms === null || ms === undefined) return '-';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${round2V28(ms / 1000)}s`;
}

/** Estimate spoken duration for text at a rate (mock: 15 chars/s at rate 1). */
export function estimateSpeechDurationMsV28(text: string, rate: number): number {
  const safeRate = clampV28(rate, 0.5, 2);
  if (!text) return 0;
  return Math.round((text.length / 15 / safeRate) * 1000);
}

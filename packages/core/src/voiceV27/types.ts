/**
 * Shared types for voice realtime v27 (v1.40, Team T5).
 *
 * v27 is the realtime v2 layer on top of v26. v26 owns the
 * frame-level loop (energy frames -> suspect -> duck -> confirm
 * -> stop, guarded floor machine, latency budget, provider
 * registry). v27 owns the four things a live loop needs *around*
 * that frame loop to behave like a real conversation partner:
 *
 *   - barge-in v2 (interrupt policy + event log): *when* an
 *     interruption is allowed at all (grace window after the
 *     agent starts, keyword-only mode, critical-turn protection,
 *     cooldown after a stop, storm protection when the user
 *     interrupts over and over), the stop itself (measured stop
 *     latency, spoken prefix cut at a word boundary, resume
 *     decision), and a durable per-session log of every
 *     interruption event so the behaviour can be audited;
 *   - turn-taking v2 + VAD tuning: an explicit, tunable VAD
 *     (silence threshold, sensitivity, minimum speech, end-of-
 *     turn silence, hangover, adaptive noise floor) with named
 *     presets, a calibration run that suggests a config from
 *     real samples, short-noise rejection (coughs / door slams
 *     never open a turn), and a turn manager that ends turns on
 *     silence / keyword / timeout and keeps turn history +
 *     analytics per bot;
 *   - multi-voice personas: voice *characters* layered on top
 *     of providers (a persona is a voice + rate + pitch +
 *     style, not an engine) — builtin personas, custom
 *     personas, one remembered persona per bot, mid-session
 *     switching, mock preview, fallback when a persona voice
 *     is unavailable;
 *   - durable session state: the session state (listening /
 *     speaking / thinking / paused / ended) is saved to a JSON
 *     file on every transition (atomic tmp + rename), can be
 *     restored after a restart, is verified before every
 *     operation (state confirmation guard), and unclean
 *     shutdowns are detected and recovered instead of lost.
 *
 * All clocks virtual (the caller passes `atMs`); all audio is
 * mock/synthetic frame energy; TTS playback is a mock stub —
 * this machine has no TTS engine and no sound card, so only
 * the control logic (barge-in, turn-taking, persona, session
 * state) is real and tested. No network, no key, no mic.
 */
export type VoiceV27Clock = { nowMs: number };

/** Durable voice session state (what the session is doing). */
export type VoiceV27SessionState =
  | 'idle'
  | 'listening'
  | 'thinking'
  | 'speaking'
  | 'paused'
  | 'ended';

/** Who holds the conversation floor right now. */
export type VoiceV27FloorHolder = 'none' | 'user' | 'agent';

/** When an interruption is allowed at all. */
export type VoiceV27InterruptMode =
  | 'always'
  | 'keyword-only'
  | 'never-critical'
  | 'disabled';

/** What a cut reply does with its unspoken remainder. */
export type VoiceV27ResumeDecision =
  | 'resume-remaining'
  | 'summarise-remainder'
  | 'drop-remainder';

/** What the interrupt policy decided a user burst was. */
export type VoiceV27InterruptKind =
  | 'speech'
  | 'keyword'
  | 'backchannel'
  | 'noise';

/** Decision of the interrupt policy for one user burst. */
export type VoiceV27InterruptDecision =
  | 'ignored'
  | 'pending'
  | 'confirmed'
  | 'storm-blocked';

/** Why an interruption was ignored or blocked. */
export type VoiceV27InterruptIgnoreReason =
  | 'mode-disabled'
  | 'grace-period'
  | 'cooldown'
  | 'not-keyword'
  | 'critical-turn'
  | 'too-short'
  | 'not-speaking'
  | 'storm'
  | 'backchannel'
  | 'noise';

/** Named VAD tuning presets. */
export type VoiceV27VadPreset = 'sensitive' | 'balanced' | 'strict' | 'custom';

/** How one VAD frame was classified. */
export type VoiceV27FrameKind = 'speech' | 'silence' | 'noise';

/** Why a turn ended. */
export type VoiceV27TurnEndReason =
  | 'silence'
  | 'keyword'
  | 'timeout'
  | 'barge-in'
  | 'explicit'
  | 'abandoned';

/** Lifecycle status of one turn. */
export type VoiceV27TurnStatus =
  | 'active'
  | 'completed'
  | 'interrupted'
  | 'timeout'
  | 'abandoned';

/** Persona style tags (a persona may carry several). */
export type VoiceV27PersonaStyle =
  | 'calm'
  | 'energetic'
  | 'formal'
  | 'friendly'
  | 'concise'
  | 'warm'
  | 'storyteller'
  | 'professional';

/** One frame of user audio energy fed to the VAD. */
export interface VoiceV27VadFrame {
  atMs: number;
  /** Normalised frame energy 0..1. */
  energy: number;
  /** Optional caller-supplied VAD verdict for this frame. */
  isSpeech?: boolean;
  /** Optional transcript fragment for keyword end detection. */
  text?: string | null;
}

/** Tunable VAD configuration (all thresholds caller-visible). */
export interface VoiceV27VadConfig {
  /** Energy above this counts as speech (0..1). */
  silenceThreshold: number;
  /** Sensitivity 0..1: higher hears quieter speech (scales the threshold down). */
  sensitivity: number;
  /** Speech shorter than this is treated as noise (ms). */
  minSpeechMs: number;
  /** Silence this long after speech ends the turn (ms). */
  endSilenceMs: number;
  /** Extra ms of speech kept after the level drops (ms). */
  hangoverMs: number;
  /** Learned background level, 0..1 (adaptive when enabled). */
  noiseFloor: number;
  /** Learn the noise floor from observed silence frames. */
  adaptive: boolean;
  /** Keyword that ends a turn immediately (null = none). */
  endKeyword: string | null;
}

export const VOICE_V27_SILENCE_THRESHOLD_DEFAULT = 0.18;
export const VOICE_V27_SENSITIVITY_DEFAULT = 0.5;
export const VOICE_V27_MIN_SPEECH_DEFAULT_MS = 220;
export const VOICE_V27_END_SILENCE_DEFAULT_MS = 700;
export const VOICE_V27_HANGOVER_DEFAULT_MS = 150;
export const VOICE_V27_NOISE_FLOOR_DEFAULT = 0.05;
export const VOICE_V27_NOISE_FLOOR_LEARN_RATE = 0.08;
export const VOICE_V27_FRAME_MS_DEFAULT = 50;
export const VOICE_V27_MAX_VAD_SAMPLES_DEFAULT = 2000;
export const VOICE_V27_MAX_TURNS_DEFAULT = 500;
export const VOICE_V27_MAX_TURN_DEFAULT_MS = 120_000;
export const VOICE_V27_MAX_LISTENING_DEFAULT_MS = 60_000;
export const VOICE_V27_MAX_THINKING_DEFAULT_MS = 30_000;
export const VOICE_V27_MAX_SPEAKING_DEFAULT_MS = 120_000;

/** Named VAD presets (threshold / sensitivity / timings). */
export const VOICE_V27_VAD_PRESETS: Record<
  Exclude<VoiceV27VadPreset, 'custom'>,
  Omit<VoiceV27VadConfig, 'noiseFloor' | 'adaptive' | 'endKeyword'>
> = {
  sensitive: {
    silenceThreshold: 0.1,
    sensitivity: 0.85,
    minSpeechMs: 150,
    endSilenceMs: 900,
    hangoverMs: 200,
  },
  balanced: {
    silenceThreshold: VOICE_V27_SILENCE_THRESHOLD_DEFAULT,
    sensitivity: VOICE_V27_SENSITIVITY_DEFAULT,
    minSpeechMs: VOICE_V27_MIN_SPEECH_DEFAULT_MS,
    endSilenceMs: VOICE_V27_END_SILENCE_DEFAULT_MS,
    hangoverMs: VOICE_V27_HANGOVER_DEFAULT_MS,
  },
  strict: {
    silenceThreshold: 0.3,
    sensitivity: 0.25,
    minSpeechMs: 350,
    endSilenceMs: 500,
    hangoverMs: 100,
  },
};

/** Interrupt-policy tunables. */
export const VOICE_V27_GRACE_AFTER_REPLY_START_DEFAULT_MS = 400;
export const VOICE_V27_INTERRUPT_COOLDOWN_DEFAULT_MS = 800;
export const VOICE_V27_MIN_INTERRUPT_SPEECH_DEFAULT_MS = 300;
export const VOICE_V27_STORM_WINDOW_DEFAULT_MS = 10_000;
export const VOICE_V27_STORM_THRESHOLD_DEFAULT = 4;
export const VOICE_V27_STORM_COOLDOWN_DEFAULT_MS = 5_000;
export const VOICE_V27_MAX_INTERRUPT_EVENTS_DEFAULT = 500;
export const VOICE_V27_BACKCHANNEL_MAX_DEFAULT_MS = 600;
export const VOICE_V27_STOP_LATENCY_SLOW_DEFAULT_MS = 500;

/** Durable session store tunables. */
export const VOICE_V27_SESSION_TTL_DEFAULT_MS = 24 * 60 * 60 * 1000;
export const VOICE_V27_MAX_CHECKPOINTS_DEFAULT = 50;

/** One interruption event, from first burst to stop (or ignore). */
export interface VoiceV27InterruptEvent {
  id: string;
  sessionId: string;
  turnId: string | null;
  kind: VoiceV27InterruptKind;
  decision: VoiceV27InterruptDecision;
  ignoreReason: VoiceV27InterruptIgnoreReason | null;
  /** ms the user had been speaking when decided. */
  speechMs: number;
  /** Peak energy seen in the burst, 0..1. */
  peakEnergy: number;
  /** ms from first burst frame to the decision. */
  decisionMs: number | null;
  /** ms from confirm to the TTS actually stopping. */
  stopLatencyMs: number | null;
  /** Chars of the reply actually spoken before the cut. */
  spokenChars: number | null;
  /** Spoken prefix, cut at a word boundary. */
  spokenText: string | null;
  /** Remainder of the reply that was never spoken. */
  remainingText: string | null;
  resume: VoiceV27ResumeDecision | null;
  /** What the user said to interrupt (caller-supplied). */
  userText: string | null;
  startedAtMs: number;
  decidedAtMs: number | null;
  stoppedAtMs: number | null;
  /** True when the burst turned out not to be a real interruption. */
  falsePositive: boolean;
}

/** Result of feeding one speech burst to the interrupt policy. */
export interface VoiceV27InterruptFeedResult {
  decision: VoiceV27InterruptDecision;
  ignoreReason: VoiceV27InterruptIgnoreReason | null;
  eventId: string | null;
  /** True when this burst confirmed a real interruption. */
  confirmed: boolean;
  /** True when storm protection blocked this burst. */
  stormBlocked: boolean;
  /** ms until the next interruption may be accepted (0 = now). */
  cooldownRemainingMs: number;
}

/** Result of stopping the TTS after a confirmed interruption. */
export interface VoiceV27InterruptStopResult {
  eventId: string;
  stoppedAtMs: number;
  stopLatencyMs: number;
  spokenChars: number;
  spokenText: string;
  remainingText: string;
  resume: VoiceV27ResumeDecision;
  /** True when the stop was slower than the slow threshold. */
  slow: boolean;
}

/** One VAD classification result for a single frame. */
export interface VoiceV27VadFrameResult {
  kind: VoiceV27FrameKind;
  /** Effective threshold in force for this frame, 0..1. */
  threshold: number;
  /** Current noise-floor estimate, 0..1. */
  noiseFloor: number;
  /** ms of continuous speech so far (0 while silent). */
  speechMs: number;
  /** ms of continuous silence so far (0 while speaking). */
  silenceMs: number;
  /** True when this frame ended the current turn. */
  turnEnded: boolean;
  /** Why the turn ended (null when it did not end). */
  endReason: VoiceV27TurnEndReason | null;
  /** True when this frame was a short burst rejected as noise. */
  noiseRejected: boolean;
}

/** One turn managed by the v27 turn manager. */
export interface VoiceV27TurnRecord {
  id: string;
  sessionId: string;
  botId: string | null;
  index: number;
  role: 'user' | 'assistant';
  startedAtMs: number;
  endedAtMs: number | null;
  durationMs: number | null;
  status: VoiceV27TurnStatus;
  endReason: VoiceV27TurnEndReason | null;
  text: string;
  /** ms of speech detected inside this turn. */
  speechMs: number;
  /** ms of silence detected inside this turn. */
  silenceMs: number;
  /** Short bursts rejected as noise inside this turn. */
  noiseRejections: number;
  spokenChars: number | null;
  plannedChars: number | null;
  interruptId: string | null;
  /** VAD preset in force when the turn started. */
  vadPreset: VoiceV27VadPreset;
}

/** A voice persona: a character layered on a provider voice. */
export interface VoiceV27PersonaDef {
  id: string;
  name: string;
  /** BCP-47 language tag this persona speaks. */
  language: string;
  /** Provider voice name the persona uses (mock voice when no engine). */
  voice: string;
  /** Speech rate multiplier (0.5..2). */
  rate: number;
  /** Pitch shift in semitones (-12..12). */
  pitch: number;
  styles: VoiceV27PersonaStyle[];
  description: string;
  builtin: boolean;
}

/** One bot's remembered persona assignment. */
export interface VoiceV27PersonaAssignment {
  botId: string;
  personaId: string;
  assignedAtMs: number;
  lastSwitchedAtMs: number | null;
  switches: number;
  midSessionSwitches: number;
}

/** Mock preview of a persona (no audio is ever produced). */
export interface VoiceV27PersonaPreview {
  personaId: string;
  voice: string;
  rate: number;
  pitch: number;
  language: string;
  sampleText: string;
  /** Estimated spoken duration for the sample, ms. */
  durationEstimateMs: number;
  mock: true;
}

/** Durable session record: the JSON saved per session. */
export interface VoiceV27DurableSession {
  sessionId: string;
  botId: string | null;
  personaId: string | null;
  state: VoiceV27SessionState;
  floor: VoiceV27FloorHolder;
  turnIndex: number;
  turns: number;
  interrupts: number;
  vadPreset: VoiceV27VadPreset;
  interruptMode: VoiceV27InterruptMode;
  openedAtMs: number;
  updatedAtMs: number;
  closedAtMs: number | null;
  /** True when close() ran cleanly (false = crash / restart pending). */
  cleanClose: boolean;
  /** True when this record was recovered from an unclean shutdown. */
  recovered: boolean;
  recoveredAtMs: number | null;
  checkpoints: { label: string; atMs: number }[];
  notes: string[];
}

/** Allowed state transitions for the durable session machine. */
export const VOICE_V27_STATE_TRANSITIONS: Record<
  VoiceV27SessionState,
  readonly VoiceV27SessionState[]
> = {
  idle: ['listening', 'ended'],
  listening: ['thinking', 'speaking', 'paused', 'ended'],
  thinking: ['speaking', 'listening', 'paused', 'ended'],
  speaking: ['listening', 'paused', 'ended'],
  paused: ['listening', 'ended'],
  ended: [],
};

/** Builtin voice personas (mock voices — no engine, no sound card). */
export const VOICE_V27_BUILTIN_PERSONAS: readonly VoiceV27PersonaDef[] = [
  {
    id: 'v27-calm',
    name: 'Calm',
    language: 'en',
    voice: 'mock-calm',
    rate: 0.95,
    pitch: -1,
    styles: ['calm', 'warm'],
    description: 'Slow, steady, low-energy voice for focus work.',
    builtin: true,
  },
  {
    id: 'v27-energetic',
    name: 'Energetic',
    language: 'en',
    voice: 'mock-energetic',
    rate: 1.15,
    pitch: 2,
    styles: ['energetic', 'friendly'],
    description: 'Bright, fast voice for brainstorming and demos.',
    builtin: true,
  },
  {
    id: 'v27-formal',
    name: 'Formal',
    language: 'en',
    voice: 'mock-formal',
    rate: 1,
    pitch: 0,
    styles: ['formal', 'professional'],
    description: 'Measured, precise voice for work and reports.',
    builtin: true,
  },
  {
    id: 'v27-friendly',
    name: 'Friendly',
    language: 'en',
    voice: 'mock-friendly',
    rate: 1.05,
    pitch: 1,
    styles: ['friendly', 'warm'],
    description: 'Warm everyday voice, the default companion.',
    builtin: true,
  },
  {
    id: 'v27-storyteller',
    name: 'Storyteller',
    language: 'en',
    voice: 'mock-storyteller',
    rate: 0.9,
    pitch: -2,
    styles: ['storyteller', 'calm'],
    description: 'Slow, expressive voice for reading and stories.',
    builtin: true,
  },
  {
    id: 'v27-concise',
    name: 'Concise',
    language: 'en',
    voice: 'mock-concise',
    rate: 1.25,
    pitch: 0,
    styles: ['concise', 'formal'],
    description: 'Fast, clipped voice that wastes no words.',
    builtin: true,
  },
  {
    id: 'v27-warm-vi',
    name: 'Ấm áp',
    language: 'vi',
    voice: 'mock-warm-vi',
    rate: 1,
    pitch: 0,
    styles: ['warm', 'friendly'],
    description: 'Giọng Việt ấm áp, chậm rãi, dễ nghe.',
    builtin: true,
  },
  {
    id: 'v27-formal-vi',
    name: 'Trang trọng',
    language: 'vi',
    voice: 'mock-formal-vi',
    rate: 0.95,
    pitch: -1,
    styles: ['formal', 'professional'],
    description: 'Giọng Việt trang trọng cho công việc và báo cáo.',
    builtin: true,
  },
];

export function clampV27(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

export function round2V27(value: number): number {
  return Math.round(value * 100) / 100;
}

export function round4V27(value: number): number {
  return Math.round(value * 10000) / 10000;
}

export function meanV27(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

export function percentileV27(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

export function isValidVoiceV27Id(id: string): boolean {
  return /^[a-z0-9][a-z0-9_-]{0,63}$/.test(id);
}

/** Cut text at a word boundary at or before `chars` (never mid-word). */
export function cutAtWordBoundaryV27(text: string, chars: number): string {
  if (chars <= 0) return '';
  if (chars >= text.length) return text;
  const cut = text.slice(0, chars);
  const lastSpace = cut.lastIndexOf(' ');
  if (lastSpace <= 0) return cut;
  return cut.slice(0, lastSpace);
}

export function formatDurationV27(ms: number | null): string {
  if (ms === null || ms === undefined) return '-';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${round2V27(ms / 1000)}s`;
}

/** Bucket a duration for histograms: short / medium / long. */
export function durationBucketV27(ms: number): 'short' | 'medium' | 'long' {
  if (ms < 1000) return 'short';
  if (ms < 5000) return 'medium';
  return 'long';
}

/** Effective VAD threshold for a config (sensitivity pulls it down). */
export function effectiveThresholdV27(config: VoiceV27VadConfig): number {
  const sensitivity = clampV27(config.sensitivity, 0, 1);
  const pulled = config.silenceThreshold * (1 - 0.5 * sensitivity);
  return round4V27(Math.max(config.noiseFloor + 0.02, pulled));
}

/** Default VAD config (balanced preset, adaptive floor learning on). */
export function defaultVadConfigV27(): VoiceV27VadConfig {
  return {
    silenceThreshold: VOICE_V27_SILENCE_THRESHOLD_DEFAULT,
    sensitivity: VOICE_V27_SENSITIVITY_DEFAULT,
    minSpeechMs: VOICE_V27_MIN_SPEECH_DEFAULT_MS,
    endSilenceMs: VOICE_V27_END_SILENCE_DEFAULT_MS,
    hangoverMs: VOICE_V27_HANGOVER_DEFAULT_MS,
    noiseFloor: VOICE_V27_NOISE_FLOOR_DEFAULT,
    adaptive: true,
    endKeyword: null,
  };
}

/** Decide the resume strategy from how much of a reply was spoken. */
export function resumeDecisionForSpokenFractionV27(spokenFraction: number): VoiceV27ResumeDecision {
  if (spokenFraction < 0.25) return 'resume-remaining';
  if (spokenFraction < 0.75) return 'summarise-remainder';
  return 'drop-remainder';
}

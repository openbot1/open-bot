/**
 * Shared types for voice realtime v26 (v1.39, Team T5).
 *
 * v26 continues v25 without touching it. v25 owns the turn-level
 * consequences of a barge-in (stop at a measured offset, keep the
 * spoken prefix, queue the interrupting turn), the floor machine
 * (who holds the floor, silence yield) and per-provider latency
 * samples with a latency-threshold fallback. v26 owns the
 * *realtime loop itself* — the things a live loop must decide
 * every few hundred milliseconds while audio is flowing:
 *
 *   - interruption / barging at frame level: energy frames arrive
 *     while the agent speaks; v26 decides, frame by frame, whether
 *     the user is really cutting in (sustained speech above an
 *     adaptive noise floor), ducks the TTS first, then stops it,
 *     and keeps the spoken prefix plus a resume context so the
 *     reply can continue, be summarised, or be dropped;
 *   - turn-taking as an explicit floor state machine with an
 *     anti-overlap guard: the agent can never start speaking
 *     while the user holds the floor — a reply requested early
 *     is queued, never spoken over the user — plus per-phase
 *     timeouts (listening / thinking / speaking) so no phase
 *     can hold the conversation forever;
 *   - a latency budget for the whole end-to-end path (STT ->
 *     model -> TTS): a per-stage budget and a total budget,
 *     measured per turn, with breach alerts and a degraded
 *     mode that trades quality for latency when the budget
 *     keeps breaking (shorter replies, faster voice, lighter
 *     STT) and recovers when turns run clean again;
 *   - an expanded TTS/STT provider registry: local providers
 *     (on-device / system voice) and API-key providers side
 *     by side, configured through Vault references (the vault
 *     key *name* only — never a key value), with capability
 *     matrix, health, latency/quality/cost selection and a
 *     fallback chain; every provider ships a deterministic
 *     mock so tests never dial a network or a sound card;
 *   - a live status model for the UI: floor state, audio
 *     level meter, current latency vs budget, active provider,
 *     degraded-mode flag — renderable as a normal panel and
 *     as an MCP Apps `ui://` resource.
 *
 * All clocks virtual (the caller passes `atMs`); all audio is
 * mock/synthetic frame energy and level samples; latency samples
 * are caller-supplied measurements; providers are never dialled
 * by this module — the mock providers synthesise deterministic
 * placeholder output. No network, no key, no mic/sound card.
 */
import { clampV24, meanV24, percentileV24, round2V24, round4V24 } from '../voiceV24/types';

export type VoiceV26Clock = { nowMs: number };

/** Who holds the conversation floor right now. */
export type VoiceV26FloorState =
  | 'idle'
  | 'listening'
  | 'thinking'
  | 'speaking'
  | 'interrupted'
  | 'done';

/** Floor holder, for snapshots and the panel. */
export type VoiceV26FloorHolder = 'none' | 'user' | 'agent';

/** Stages of one interruption, from first suspicion to stop. */
export type VoiceV26BargeInStage =
  | 'none'
  | 'suspect'
  | 'ducking'
  | 'confirmed'
  | 'stopped';

/** How a cut reply is resumed (or not) after a barge-in. */
export type VoiceV26ResumeStrategy =
  | 'resume-remaining'
  | 'summarise-remainder'
  | 'drop-remainder'
  | 'ask-clarify';

/** What the detector decided a user burst was. */
export type VoiceV26BargeInKind =
  | 'speech'
  | 'backchannel'
  | 'echo'
  | 'noise'
  | 'keyword';

/** One stage of the end-to-end voice pipeline. */
export type VoiceV26LatencyStage = 'stt' | 'model' | 'tts' | 'total';

/** Latency budget profile names. */
export type VoiceV26BudgetProfile = 'realtime' | 'balanced' | 'quality';

/** Degraded-mode levels: quality traded for latency. */
export type VoiceV26DegradedLevel = 'off' | 'light' | 'heavy';

/** TTS or STT provider. */
export type VoiceV26ProviderKind = 'stt' | 'tts';

/** Where a provider runs / how it is paid for. */
export type VoiceV26ProviderOrigin = 'local' | 'system' | 'api-key' | 'mock';

/** Latency / quality / cost classes used for selection. */
export type VoiceV26ProviderClass = 'fast' | 'balanced' | 'quality';

/** Voice status shown in the UI. */
export type VoiceV26StatusState =
  | 'idle'
  | 'listening'
  | 'thinking'
  | 'speaking'
  | 'interrupted'
  | 'degraded'
  | 'error';

/** One frame of user audio energy fed to the detector. */
export interface VoiceV26AudioFrame {
  atMs: number;
  /** Normalised frame energy 0..1. */
  energy: number;
  /** Optional VAD verdict for this frame (caller-supplied). */
  isSpeech?: boolean;
}

/** One barge-in event, from suspicion to stop. */
export interface VoiceV26BargeInRecord {
  id: string;
  sessionId: string;
  turnId: string | null;
  turnIndex: number | null;
  kind: VoiceV26BargeInKind;
  stage: VoiceV26BargeInStage;
  /** ms the user had been speaking when confirmed. */
  speechMs: number;
  /** Peak energy seen in the burst, 0..1. */
  peakEnergy: number;
  /** Energy threshold in force when confirmed, 0..1. */
  thresholdAtConfirm: number;
  /** Was the TTS ducked before the stop? */
  ducked: boolean;
  /** ms from first suspect frame to the stop decision. */
  decisionMs: number | null;
  /** ms from confirm to the TTS actually stopping. */
  stopLatencyMs: number | null;
  /** Chars of the reply actually spoken before the cut. */
  spokenChars: number | null;
  /** Spoken prefix, cut at a word boundary. */
  spokenText: string | null;
  /** Remainder of the reply that was never spoken. */
  remainingText: string | null;
  resumeStrategy: VoiceV26ResumeStrategy | null;
  /** What the user said to interrupt (caller-supplied). */
  userText: string | null;
  startedAtMs: number;
  confirmedAtMs: number | null;
  stoppedAtMs: number | null;
  /** True when the burst turned out not to be a real barge-in. */
  falsePositive: boolean;
}

/** Result of feeding one frame to the detector. */
export interface VoiceV26FrameResult {
  stage: VoiceV26BargeInStage;
  /** True when this frame confirmed a real barge-in. */
  confirmed: boolean;
  /** True when this frame started ducking the TTS. */
  ducking: boolean;
  /** True when this frame was classified backchannel (no state change). */
  backchannel: boolean;
  /** True when this frame was classified echo (no state change). */
  echo: boolean;
  /** Current adaptive threshold, 0..1. */
  threshold: number;
  /** Current noise-floor estimate, 0..1. */
  noiseFloor: number;
  bargeInId: string | null;
}

/** Result of stopping the TTS after a confirmed barge-in. */
export interface VoiceV26StopResult {
  bargeInId: string;
  stoppedAtMs: number;
  stopLatencyMs: number;
  spokenChars: number;
  spokenText: string;
  remainingText: string;
  resumeStrategy: VoiceV26ResumeStrategy;
  /** Context kept so the reply can resume or be summarised. */
  context: VoiceV26ResumeContext;
}

/** Context kept after a cut reply, for resume / summary. */
export interface VoiceV26ResumeContext {
  turnId: string | null;
  turnIndex: number | null;
  replyText: string;
  spokenText: string;
  remainingText: string;
  spokenChars: number;
  remainingChars: number;
  /** Fraction of the reply actually spoken, 0..1. */
  spokenFraction: number;
  strategy: VoiceV26ResumeStrategy;
  userText: string | null;
  atMs: number;
}

/** One phase span inside a v26 turn. */
export interface VoiceV26PhaseSpan {
  phase: VoiceV26FloorState;
  startedAtMs: number;
  endedAtMs: number | null;
  durationMs: number | null;
}

/** One v26 turn: a user segment + the agent reply that follows. */
export interface VoiceV26TurnRecord {
  id: string;
  sessionId: string;
  index: number;
  role: 'user' | 'assistant';
  startedAtMs: number;
  endedAtMs: number | null;
  durationMs: number | null;
  status: 'active' | 'completed' | 'interrupted' | 'abandoned' | 'timeout' | 'queued';
  phases: VoiceV26PhaseSpan[];
  text: string;
  spokenChars: number | null;
  plannedChars: number | null;
  bargeInId: string | null;
  /** Queued agent reply text waiting for the floor (assistant turns). */
  queuedText: string | null;
}

/** A floor transition, for the audit trail. */
export interface VoiceV26Transition {
  from: VoiceV26FloorState;
  to: VoiceV26FloorState;
  atMs: number;
  reason: string;
  turnId: string | null;
}

/** Per-stage latency budget (ms). */
export interface VoiceV26StageBudgets {
  sttMs: number;
  modelMs: number;
  ttsMs: number;
  totalMs: number;
}

/** One measured latency sample for one stage of one turn. */
export interface VoiceV26LatencySample {
  sessionId: string;
  turnId: string | null;
  turnIndex: number | null;
  stage: VoiceV26LatencyStage;
  ms: number;
  providerId: string | null;
  atMs: number;
}

/** Rolling stats for one latency stage. */
export interface VoiceV26StageStats {
  stage: VoiceV26LatencyStage;
  samples: number;
  meanMs: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
  budgetMs: number;
  breaches: number;
  breachRate: number;
}

/** One budget breach. */
export interface VoiceV26BudgetBreach {
  id: string;
  sessionId: string;
  turnId: string | null;
  stage: VoiceV26LatencyStage;
  ms: number;
  budgetMs: number;
  overMs: number;
  overPct: number;
  atMs: number;
  degradedLevel: VoiceV26DegradedLevel;
}

/** One degraded-mode change. */
export interface VoiceV26DegradedEvent {
  atMs: number;
  from: VoiceV26DegradedLevel;
  to: VoiceV26DegradedLevel;
  reason: string;
  consecutiveBreaches: number;
}

/** What degraded mode does to the pipeline. */
export interface VoiceV26DegradedPolicy {
  level: VoiceV26DegradedLevel;
  /** Cap reply length (chars); null = no cap. */
  maxReplyChars: number | null;
  /** Prefer the fastest TTS voice. */
  fastVoice: boolean;
  /** Skip prosody / SSML embellishment. */
  skipProsody: boolean;
  /** Use the lighter STT model. */
  lightStt: boolean;
  /** Skip the eval / MOS pass on this turn. */
  skipEval: boolean;
}

/** A TTS/STT provider definition (config, never a key value). */
export interface VoiceV26ProviderDef {
  id: string;
  kind: VoiceV26ProviderKind;
  origin: VoiceV26ProviderOrigin;
  name: string;
  /** Model / voice identifier, e.g. "whisper-base" or "en-US-neural". */
  model: string;
  /** Languages served, BCP-47 tags. */
  languages: string[];
  /** Voice names offered (TTS only). */
  voices: string[];
  streaming: boolean;
  latencyClass: VoiceV26ProviderClass;
  qualityClass: VoiceV26ProviderClass;
  costClass: VoiceV26ProviderClass;
  /** Max input chars per call (TTS) / seconds per call (STT). */
  maxInput: number;
  /** Vault key *name* holding the API key (api-key origin only). */
  vaultKeyRef: string | null;
  /** True when the provider is a deterministic mock (tests only). */
  mock: boolean;
  enabled: boolean;
  /** Health score 0..100, maintained by the registry. */
  health: number;
}

/** Result of selecting a provider for a turn. */
export interface VoiceV26ProviderSelection {
  kind: VoiceV26ProviderKind;
  providerId: string;
  providerName: string;
  origin: VoiceV26ProviderOrigin;
  model: string;
  reason: string;
  /** Providers tried before this one, in order. */
  triedIds: string[];
  degradedLevel: VoiceV26DegradedLevel;
  atMs: number;
}

/** Deterministic mock synthesis / transcription output. */
export interface VoiceV26MockAudioResult {
  providerId: string;
  kind: VoiceV26ProviderKind;
  /** For TTS: fake audio length; for STT: fake transcript. */
  text: string;
  /** Simulated audio duration ms (TTS) / processed ms (STT). */
  durationMs: number;
  /** Simulated first-chunk latency ms. */
  firstChunkMs: number;
  chars: number;
  voice: string | null;
  language: string;
}

/** One audio-level sample for the status meter. */
export interface VoiceV26LevelSample {
  atMs: number;
  /** Instantaneous level 0..1. */
  level: number;
  /** Smoothed level 0..1 (exponential moving average). */
  smoothed: number;
  /** Peak-hold level 0..1. */
  peak: number;
  /** True while the agent is speaking. */
  speaking: boolean;
}

/** Snapshot of the live voice status (panel + ui:// resource). */
export interface VoiceV26StatusSnapshot {
  sessionId: string;
  state: VoiceV26StatusState;
  floor: VoiceV26FloorState;
  floorHolder: VoiceV26FloorHolder;
  level: VoiceV26LevelSample | null;
  /** Current turn latency (total, ms) or null. */
  latencyMs: number | null;
  /** p50 total latency over the window, ms, or null. */
  latencyP50Ms: number | null;
  /** Total budget ms in force. */
  budgetMs: number;
  /** True when the current turn is over budget. */
  overBudget: boolean;
  degradedLevel: VoiceV26DegradedLevel;
  providerId: string | null;
  providerName: string | null;
  turnId: string | null;
  turnIndex: number | null;
  bargeIns: number;
  turns: number;
  updatedAtMs: number;
}

/** MCP Apps `ui://` resource descriptor for the status panel. */
export interface VoiceV26UiResource {
  uri: string;
  mimeType: string;
  title: string;
  description: string;
  /** Panel kind, so the host can render it as panel or resource. */
  kind: 'voice-status';
  version: number;
  snapshot: VoiceV26StatusSnapshot;
  /** i18n keys the host should resolve for labels. */
  i18nKeys: string[];
}

// ---------------------------------------------------------------------------
// Defaults and helpers (v26 reuses the v24 numeric helpers).
// ---------------------------------------------------------------------------

export const VOICE_V26_NOISE_FLOOR_DEFAULT = 0.08;
export const VOICE_V26_THRESHOLD_MARGIN_DEFAULT = 0.12;
export const VOICE_V26_MIN_SPEECH_DEFAULT_MS = 250;
export const VOICE_V26_DUCK_AFTER_MS_DEFAULT = 120;
export const VOICE_V26_CONFIRM_AFTER_MS_DEFAULT = 350;
export const VOICE_V26_GRACE_AFTER_REPLY_START_MS_DEFAULT = 600;
export const VOICE_V26_BACKCHANNEL_MAX_MS_DEFAULT = 400;
export const VOICE_V26_MAX_TURN_DEFAULT_MS = 120000;
export const VOICE_V26_MAX_USER_TURN_DEFAULT_MS = 60000;
export const VOICE_V26_MAX_THINKING_DEFAULT_MS = 30000;
export const VOICE_V26_MAX_LISTENING_DEFAULT_MS = 60000;
export const VOICE_V26_MAX_SPEAKING_DEFAULT_MS = 120000;
export const VOICE_V26_STOP_LATENCY_SLOW_DEFAULT_MS = 300;
export const VOICE_V26_LATENCY_P95_WINDOW = 100;
export const VOICE_V26_CONSECUTIVE_BREACHES_DEFAULT = 3;
export const VOICE_V26_CONSECUTIVE_CLEAN_DEFAULT = 5;
export const VOICE_V26_LEVEL_SMOOTHING_DEFAULT = 0.35;
export const VOICE_V26_PEAK_DECAY_PER_MS = 0.0004;
export const VOICE_V26_MAX_TURNS_DEFAULT = 1000;
export const VOICE_V26_MAX_RECORDS_DEFAULT = 1000;
export const VOICE_V26_MAX_SAMPLES_DEFAULT = 5000;

/** Budget profiles: per-stage and total budgets in ms. */
export const VOICE_V26_BUDGET_PROFILES: Record<VoiceV26BudgetProfile, VoiceV26StageBudgets> = {
  realtime: { sttMs: 400, modelMs: 800, ttsMs: 600, totalMs: 1800 },
  balanced: { sttMs: 800, modelMs: 2000, ttsMs: 1200, totalMs: 4000 },
  quality: { sttMs: 1500, modelMs: 5000, ttsMs: 2500, totalMs: 9000 },
};

/** Degraded-mode policies: what each level trades away. */
export const VOICE_V26_DEGRADED_POLICIES: Record<VoiceV26DegradedLevel, VoiceV26DegradedPolicy> = {
  off: { level: 'off', maxReplyChars: null, fastVoice: false, skipProsody: false, lightStt: false, skipEval: false },
  light: { level: 'light', maxReplyChars: 600, fastVoice: true, skipProsody: true, lightStt: false, skipEval: true },
  heavy: { level: 'heavy', maxReplyChars: 240, fastVoice: true, skipProsody: true, lightStt: true, skipEval: true },
};

/** Built-in mock providers (deterministic, no network, no sound card). */
export const VOICE_V26_MOCK_PROVIDERS: Array<Omit<VoiceV26ProviderDef, 'health'>> = [
  {
    id: 'mock-local-stt', kind: 'stt', origin: 'mock', name: 'Mock Local STT',
    model: 'mock-whisper-base', languages: ['en', 'vi'], voices: [], streaming: true,
    latencyClass: 'fast', qualityClass: 'balanced', costClass: 'fast', maxInput: 3600,
    vaultKeyRef: null, mock: true, enabled: true,
  },
  {
    id: 'mock-local-tts', kind: 'tts', origin: 'mock', name: 'Mock Local TTS',
    model: 'mock-piper-en', languages: ['en', 'vi'], voices: ['mock-voice-a', 'mock-voice-b'],
    streaming: true, latencyClass: 'fast', qualityClass: 'balanced', costClass: 'fast',
    maxInput: 4000, vaultKeyRef: null, mock: true, enabled: true,
  },
  {
    id: 'mock-system-tts', kind: 'tts', origin: 'system', name: 'Mock System TTS',
    model: 'mock-system-default', languages: ['en'], voices: ['mock-system-default'],
    streaming: false, latencyClass: 'balanced', qualityClass: 'balanced', costClass: 'fast',
    maxInput: 2000, vaultKeyRef: null, mock: true, enabled: true,
  },
  {
    id: 'mock-api-stt', kind: 'stt', origin: 'api-key', name: 'Mock API STT',
    model: 'mock-api-stt-large', languages: ['en', 'vi', 'zh', 'ja', 'es', 'fr'], voices: [],
    streaming: true, latencyClass: 'balanced', qualityClass: 'quality', costClass: 'quality',
    maxInput: 7200, vaultKeyRef: 'voice-v26-api-stt-key', mock: true, enabled: true,
  },
  {
    id: 'mock-api-tts', kind: 'tts', origin: 'api-key', name: 'Mock API TTS',
    model: 'mock-api-tts-neural', languages: ['en', 'vi', 'zh', 'ja', 'es', 'fr'],
    voices: ['mock-neural-a', 'mock-neural-b', 'mock-neural-c'],
    streaming: true, latencyClass: 'balanced', qualityClass: 'quality', costClass: 'quality',
    maxInput: 8000, vaultKeyRef: 'voice-v26-api-tts-key', mock: true, enabled: true,
  },
];

export function clampV26(value: number, min: number, max: number): number {
  return clampV24(value, min, max);
}

export function round2V26(value: number): number {
  return round2V24(value);
}

export function round4V26(value: number): number {
  return round4V24(value);
}

export function meanV26(values: number[]): number {
  return meanV24(values);
}

export function percentileV26(values: number[], pct: number): number {
  return percentileV24(values, pct);
}

export function formatDurationV26(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '0ms';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${round2V26(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = round2V26(seconds - minutes * 60);
  return `${minutes}m ${rest}s`;
}

export function formatDurationShortV26(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '0ms';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${round2V26(ms / 1000)}s`;
}

/** Bucket a duration for histograms: short / medium / long / very-long. */
export function durationBucketV26(ms: number): 'short' | 'medium' | 'long' | 'very-long' {
  if (ms < 500) return 'short';
  if (ms < 2000) return 'medium';
  if (ms < 5000) return 'long';
  return 'very-long';
}

const VOICE_V26_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export function isValidVoiceV26Id(id: string): boolean {
  return typeof id === 'string' && VOICE_V26_ID_RE.test(id);
}

/** Deterministic checksum of a string (FNV-1a, 32-bit). */
export function turnChecksumV26(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** Cut text at a word boundary at or before `chars` characters. */
export function cutAtWordBoundaryV26(text: string, chars: number): string {
  if (chars <= 0) return '';
  if (chars >= text.length) return text;
  const prefix = text.slice(0, chars);
  const lastSpace = prefix.lastIndexOf(' ');
  if (lastSpace <= 0) return prefix;
  return prefix.slice(0, lastSpace);
}

/** Floor holder for a floor state. */
export function floorHolderForStateV26(state: VoiceV26FloorState): VoiceV26FloorHolder {
  if (state === 'listening') return 'user';
  if (state === 'thinking' || state === 'speaking') return 'agent';
  return 'none';
}

/** UI status state for a floor state + degraded flag. */
export function statusStateForFloorV26(
  floor: VoiceV26FloorState,
  degraded: VoiceV26DegradedLevel,
): VoiceV26StatusState {
  if (floor === 'interrupted') return 'interrupted';
  if (degraded !== 'off') return 'degraded';
  if (floor === 'idle') return 'idle';
  if (floor === 'listening') return 'listening';
  if (floor === 'thinking') return 'thinking';
  if (floor === 'speaking') return 'speaking';
  return 'idle';
}

/** Pick a resume strategy from how much of the reply was spoken. */
export function strategyForSpokenFractionV26(
  spokenFraction: number,
  userText: string | null,
): VoiceV26ResumeStrategy {
  if (userText && userText.trim().length > 0) return 'ask-clarify';
  if (spokenFraction >= 0.8) return 'drop-remainder';
  if (spokenFraction >= 0.35) return 'summarise-remainder';
  return 'resume-remaining';
}

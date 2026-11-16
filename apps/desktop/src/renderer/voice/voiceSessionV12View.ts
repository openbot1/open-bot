/**
 * Voice session v12 view models (v1.13, Team T5 - voice v12 + UI).
 *
 * Renderer-local mirror of the core v12 session shapes (the
 * BudgetMeter pattern): the renderer must NOT value-import from
 * `@open-bot/core` — the core bundles are CJS and vite inlines
 * them verbatim, which throws `ReferenceError: exports is not
 * defined` at startup and leaves a blank screen. This module
 * owns the view contract instead: defensive parsing of the IPC
 * payloads (`voice-v12:*` returns plain JSON), the six-state
 * turn machine (idle / listening / thinking / speaking /
 * interrupted / cooldown), the overlap list (who won, agent
 * words lost, ducking volume), the interrupt-context card (cut
 * word, played vs remaining text, resume strategy + prompt),
 * the end-of-turn readout (turns, backchannels, false starts,
 * merged pauses) and the planned TTS chunks with per-word
 * timings and prosody pauses. Pure functions, no React, no
 * DOM, no IPC — unit-tested with plain node --test (see
 * tests/voice-v113.test.mjs).
 */

/** UI status of a v12 voice session (what the panel renders). */
export type VoiceSessionV12StatusView =
  | 'idle' | 'listening' | 'thinking' | 'speaking' | 'interrupted' | 'cooldown' | 'closed';

/** Turn-machine states the panel shows. */
export type VoiceV12TurnStateView = VoiceSessionV12StatusView;

/** Resume strategies the panel shows. */
export type VoiceV12ResumeStrategyView = 'continue' | 'restart' | 'summarize' | 'drop';

/** Overlap policies the panel shows. */
export type VoiceV12OverlapPolicyView = 'user-wins' | 'agent-keeps' | 'confirm';

/** One row in the voice session list (as the IPC returns it). */
export interface VoiceSessionV12RowView {
  id: string;
  status: VoiceSessionV12StatusView;
  botId: string;
  language: string;
  voice: string;
  connected: boolean;
  durationMs: number;
  turns: number;
  userTurns: number;
  agentTurns: number;
  interrupts: number;
  overlaps: number;
  resumes: number;
  drops: number;
  /** Current playback volume factor (ducking envelope). */
  volume: number;
}

/** Turn-machine stats for the panel. */
export interface VoiceV12TurnMachineView {
  state: VoiceSessionV12StatusView;
  turns: number;
  userTurns: number;
  agentTurns: number;
  interrupts: number;
  silenceTimeouts: number;
  nudges: number;
  thinkingTimeouts: number;
  illegalTransitions: number;
  stateMs: number;
  listeningIdleMs: number;
}

/** End-of-turn detector stats for the panel. */
export interface VoiceV12EndOfTurnView {
  turns: number;
  backchannels: number;
  falseStarts: number;
  merged: number;
  timeouts: number;
  speaking: boolean;
  currentSpeechMs: number;
  currentSilenceMs: number;
}

/** One overlap segment row for the overlap list. */
export interface VoiceV12OverlapRowView {
  id: number;
  startedAtMs: number;
  endedAtMs: number | null;
  durationMs: number;
  winner: 'user' | 'agent' | 'unresolved';
  resolutionReason: string;
  agentWordsLost: string[];
  userWords: string[];
  /** 0..100 bar width for the duck depth (1 - minVolume). */
  duckDepthPct: number;
  /** Short label: "#3 · 420 ms · user wins". */
  label: string;
}

/** Overlap stats for the panel. */
export interface VoiceV12OverlapView {
  overlaps: number;
  open: boolean;
  userWins: number;
  agentKeeps: number;
  backchannels: number;
  totalOverlapMs: number;
  meanOverlapMs: number;
  maxOverlapMs: number;
  agentWordsLost: number;
  volume: number;
  /** 0..100 bar width for the current volume. */
  volumePct: number;
}

/** The interrupt-context card the panel renders. */
export interface VoiceV12InterruptContextView {
  id: number;
  atMs: number;
  cutWord: string;
  cutWordIndex: number;
  playedText: string;
  remainingText: string;
  playedMs: number;
  discardedMs: number;
  wasThinking: boolean;
  latencyMs: number | null;
  userText: string;
  userConfidence: number;
  resumeStrategy: VoiceV12ResumeStrategyView;
  resumeReason: string;
  resumeText: string;
  resumePrompt: string;
  ttsChunksCancelled: number;
  ttsCharsDiscarded: number;
}

/** One planned TTS chunk row (word timings + prosody). */
export interface VoiceV12PlannedChunkRowView {
  id: number;
  text: string;
  estDurationMs: number;
  urgent: boolean;
  pacingFactor: number;
  /** Words with start/end offsets (ms) inside the chunk. */
  words: { word: string; startMs: number; endMs: number }[];
  /** Prosody pauses inside the chunk. */
  pauses: { afterCharIndex: number; mark: string; pauseMs: number }[];
  /** Truncated text for the row (the full text is in `text`). */
  shortText: string;
  /** The word being spoken right now at `playedMs` ('' when none). */
  currentWord: string;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function asBoolean(value: unknown, fallback = false): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function asNullableNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string');
}

const V12_STATUSES: VoiceSessionV12StatusView[] = [
  'idle', 'listening', 'thinking', 'speaking', 'interrupted', 'cooldown', 'closed',
];

/** Parse a status string defensively (unknown → 'idle'). */
export function parseVoiceV12Status(value: unknown): VoiceSessionV12StatusView {
  return typeof value === 'string' && (V12_STATUSES as string[]).includes(value)
    ? (value as VoiceSessionV12StatusView)
    : 'idle';
}

/** Parse a resume strategy defensively (unknown → 'drop'). */
export function parseVoiceV12ResumeStrategy(value: unknown): VoiceV12ResumeStrategyView {
  return value === 'continue' || value === 'restart' || value === 'summarize' || value === 'drop'
    ? value
    : 'drop';
}

/** Parse an overlap policy defensively (unknown → 'user-wins'). */
export function parseVoiceV12OverlapPolicy(value: unknown): VoiceV12OverlapPolicyView {
  return value === 'user-wins' || value === 'agent-keeps' || value === 'confirm'
    ? value
    : 'user-wins';
}

/** i18n key for a v12 status (the panel calls `t(key)`). */
export function voiceV12StatusKey(status: VoiceSessionV12StatusView): string {
  return `voice.realtime.v12.status.${status}`;
}

/** i18n key for a resume strategy. */
export function voiceV12ResumeStrategyKey(strategy: VoiceV12ResumeStrategyView): string {
  return `voice.realtime.v12.resume.${strategy}`;
}

/** i18n key for an overlap winner. */
export function voiceV12OverlapWinnerKey(winner: 'user' | 'agent' | 'unresolved'): string {
  return `voice.realtime.v12.overlap.${winner}`;
}

/** Parse a v12 session row (IPC payload → view). Never throws. */
export function parseVoiceSessionV12Row(value: unknown): VoiceSessionV12RowView {
  const r = asRecord(value);
  const stats = asRecord(r['stats']);
  const overlap = asRecord(stats['overlap']);
  return {
    id: asString(r['sessionId'] ?? r['id'], 'unknown'),
    status: parseVoiceV12Status(r['status'] ?? stats['state']),
    botId: asString(r['botId'] ?? stats['botId'], 'default'),
    language: asString(r['language'] ?? stats['language'], 'en'),
    voice: asString(r['voice'] ?? stats['voice'], ''),
    connected: asBoolean(r['connected'], false),
    durationMs: asNumber(r['durationMs'] ?? stats['nowMs'], 0),
    turns: asNumber(stats['turns'], 0),
    userTurns: asNumber(stats['userTurns'], 0),
    agentTurns: asNumber(stats['agentTurns'], 0),
    interrupts: asNumber(stats['interrupts'], 0),
    overlaps: asNumber(overlap['overlaps'], 0),
    resumes: asNumber(stats['resumes'], 0),
    drops: asNumber(stats['drops'], 0),
    volume: asNumber(r['volume'] ?? overlap['volume'], 1),
  };
}

/** Parse turn-machine stats (IPC payload → view). Never throws. */
export function parseVoiceV12TurnMachine(value: unknown): VoiceV12TurnMachineView {
  const r = asRecord(value);
  return {
    state: parseVoiceV12Status(r['state']),
    turns: asNumber(r['turns'], 0),
    userTurns: asNumber(r['userTurns'], 0),
    agentTurns: asNumber(r['agentTurns'], 0),
    interrupts: asNumber(r['interrupts'], 0),
    silenceTimeouts: asNumber(r['silenceTimeouts'], 0),
    nudges: asNumber(r['nudges'], 0),
    thinkingTimeouts: asNumber(r['thinkingTimeouts'], 0),
    illegalTransitions: asNumber(r['illegalTransitions'], 0),
    stateMs: asNumber(r['stateMs'], 0),
    listeningIdleMs: asNumber(r['listeningIdleMs'], 0),
  };
}

/** Parse end-of-turn detector stats (IPC payload → view). Never throws. */
export function parseVoiceV12EndOfTurn(value: unknown): VoiceV12EndOfTurnView {
  const r = asRecord(value);
  return {
    turns: asNumber(r['turns'], 0),
    backchannels: asNumber(r['backchannels'], 0),
    falseStarts: asNumber(r['falseStarts'], 0),
    merged: asNumber(r['merged'], 0),
    timeouts: asNumber(r['timeouts'], 0),
    speaking: asBoolean(r['speaking'], false),
    currentSpeechMs: asNumber(r['currentSpeechMs'], 0),
    currentSilenceMs: asNumber(r['currentSilenceMs'], 0),
  };
}

/** Parse overlap stats (IPC payload → view). Never throws. */
export function parseVoiceV12Overlap(value: unknown): VoiceV12OverlapView {
  const r = asRecord(value);
  const volume = asNumber(r['volume'], 1);
  return {
    overlaps: asNumber(r['overlaps'], 0),
    open: asBoolean(r['open'], false),
    userWins: asNumber(r['userWins'], 0),
    agentKeeps: asNumber(r['agentKeeps'], 0),
    backchannels: asNumber(r['backchannels'], 0),
    totalOverlapMs: asNumber(r['totalOverlapMs'], 0),
    meanOverlapMs: asNumber(r['meanOverlapMs'], 0),
    maxOverlapMs: asNumber(r['maxOverlapMs'], 0),
    agentWordsLost: asNumber(r['agentWordsLost'], 0),
    volume,
    volumePct: Math.round(Math.max(0, Math.min(1, volume)) * 100),
  };
}

/** Parse one overlap segment (IPC payload → row). Never throws. */
export function parseVoiceV12OverlapRow(value: unknown): VoiceV12OverlapRowView {
  const r = asRecord(value);
  const id = asNumber(r['id'], 0);
  const durationMs = asNumber(r['durationMs'], 0);
  const winner = r['winner'] === 'user' || r['winner'] === 'agent' ? r['winner'] : 'unresolved';
  const minVolume = asNumber(r['minVolume'], 1);
  return {
    id,
    startedAtMs: asNumber(r['startedAtMs'], 0),
    endedAtMs: asNullableNumber(r['endedAtMs']),
    durationMs,
    winner,
    resolutionReason: asString(r['resolutionReason'], ''),
    agentWordsLost: asStringArray(r['agentWordsLost']),
    userWords: asStringArray(r['userWords']),
    duckDepthPct: Math.round(Math.max(0, Math.min(1, 1 - minVolume)) * 100),
    label: `#${id} · ${durationMs} ms · ${winner}`,
  };
}

/** Parse overlap segment rows (IPC payload → rows). Never throws. */
export function parseVoiceV12OverlapRows(value: unknown): VoiceV12OverlapRowView[] {
  if (!Array.isArray(value)) return [];
  return value.map((v) => parseVoiceV12OverlapRow(v));
}

/** Parse the interrupt-context card (IPC payload → view). Null when nothing was cut yet. */
export function parseVoiceV12InterruptContext(value: unknown): VoiceV12InterruptContextView | null {
  const r = asRecord(value);
  if (Object.keys(r).length === 0) return null;
  const userInterruption = asRecord(r['userInterruption']);
  return {
    id: asNumber(r['id'], 0),
    atMs: asNumber(r['atMs'], 0),
    cutWord: asString(r['cutWord'], ''),
    cutWordIndex: asNumber(r['cutWordIndex'], -1),
    playedText: asString(r['playedText'], ''),
    remainingText: asString(r['remainingText'], ''),
    playedMs: asNumber(r['playedMs'], 0),
    discardedMs: asNumber(r['discardedMs'], 0),
    wasThinking: asBoolean(r['wasThinking'], false),
    latencyMs: asNullableNumber(r['latencyMs']),
    userText: asString(userInterruption['text'], ''),
    userConfidence: asNumber(userInterruption['confidence'], 1),
    resumeStrategy: parseVoiceV12ResumeStrategy(r['resumeStrategy']),
    resumeReason: asString(r['resumeReason'], ''),
    resumeText: asString(r['resumeText'], ''),
    resumePrompt: asString(r['resumePrompt'], ''),
    ttsChunksCancelled: asNumber(r['ttsChunksCancelled'], 0),
    ttsCharsDiscarded: asNumber(r['ttsCharsDiscarded'], 0),
  };
}

/** Parse planned TTS chunk rows (IPC payload → rows). Never throws. */
export function parseVoiceV12PlannedChunkRows(value: unknown, playedMs = 0): VoiceV12PlannedChunkRowView[] {
  if (!Array.isArray(value)) return [];
  return value.map((v) => {
    const r = asRecord(v);
    const text = asString(r['text'], '');
    const timings = Array.isArray(r['wordTimings'])
      ? r['wordTimings'].map((w) => {
        const wr = asRecord(w);
        return { word: asString(wr['word'], ''), startMs: asNumber(wr['startMs'], 0), endMs: asNumber(wr['endMs'], 0) };
      })
      : [];
    const pauses = Array.isArray(r['prosody'])
      ? r['prosody'].map((p) => {
        const pr = asRecord(p);
        return { afterCharIndex: asNumber(pr['afterCharIndex'], 0), mark: asString(pr['mark'], ''), pauseMs: asNumber(pr['pauseMs'], 0) };
      })
      : [];
    const current = timings.find((w) => playedMs >= w.startMs && playedMs < w.endMs);
    return {
      id: asNumber(r['id'], 0),
      text,
      estDurationMs: asNumber(r['estDurationMs'], 0),
      urgent: asBoolean(r['urgent'], false),
      pacingFactor: asNumber(r['pacingFactor'], 1),
      words: timings,
      pauses,
      shortText: text.length > 60 ? `${text.slice(0, 60)}…` : text,
      currentWord: current ? current.word : '',
    };
  });
}

/** Format a duration (ms) as `1,2s` / `340 ms` for the panel. */
export function formatVoiceV12Duration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '0 ms';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(1).replace('.', ',')}s`;
}

/** Format a volume factor (0..1) as a percent. */
export function formatVoiceV12Volume(volume: number): string {
  if (!Number.isFinite(volume)) return '100%';
  return `${Math.round(Math.max(0, Math.min(1, volume)) * 100)}%`;
}

/** Summary lines for the v12 panel header (already localised by the caller). */
export function voiceV12SummaryLines(stats: {
  state: VoiceSessionV12StatusView;
  turns: number;
  interrupts: number;
  overlaps: number;
  resumes: number;
}): string[] {
  return [
    `state: ${stats.state}`,
    `turns: ${stats.turns}`,
    `interrupts: ${stats.interrupts}`,
    `overlaps: ${stats.overlaps}`,
    `resumes: ${stats.resumes}`,
  ];
}

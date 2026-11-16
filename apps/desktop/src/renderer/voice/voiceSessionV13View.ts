/**
 * Voice session v13 view models (v1.14, Team T5 - voice v13 + UI).
 *
 * Renderer-local mirror of the core v13 session shapes (the
 * BudgetMeter pattern, same as v12): the renderer must NOT
 * value-import from `@open-bot/core` — the core bundles are
 * CJS and vite inlines them verbatim, which throws
 * `ReferenceError: exports is not defined` at startup and
 * leaves a blank screen. This module owns the view contract
 * instead: defensive parsing of the IPC payloads
 * (`voice-v13:*` returns plain JSON), the barge-in engine card
 * (cuts, gated, played text kept, stale work cancelled), the
 * clause list (clause text, terminator, join pause, first
 * clause latency), the Smart Turn readout (score, signals,
 * reason), the latency budget dashboard (budget vs p50 / p95 /
 * max per stage, overruns, worst stage), the wake-word card
 * (state, keywords, activations) and the provider list
 * (capabilities, ready / not ready + reason). Pure functions,
 * no React, no DOM, no IPC — unit-tested with plain
 * node --test (see tests/voice-v114.test.mjs).
 */

/** UI status of a v13 voice session (what the panel renders). */
export type VoiceSessionV13StatusView =
  | 'idle' | 'listening' | 'thinking' | 'speaking' | 'interrupted' | 'cooldown' | 'closed';

/** Barge-in v13 policies the panel shows. */
export type VoiceV13BargeInPolicyView = 'immediate' | 'after-min-speech' | 'confirm';

/** Latency stages the dashboard shows. */
export type VoiceV13LatencyStageView = 'capture' | 'vad' | 'stt' | 'llm' | 'tts' | 'playback' | 'e2e';

/** Wake-word states the panel shows. */
export type VoiceV13WakeWordStateView = 'asleep' | 'active' | 'cooldown';

/** Provider kinds the panel shows. */
export type VoiceV13ProviderKindView = 'mock' | 'edge-tts' | 'whisper-local' | 'realtime-api';

/** One row in the voice session list (as the IPC returns it). */
export interface VoiceSessionV13RowView {
  id: string;
  status: VoiceSessionV13StatusView;
  botId: string;
  language: string;
  voice: string;
  connected: boolean;
  durationMs: number;
  turns: number;
  userTurns: number;
  agentTurns: number;
  interrupts: number;
  bargeInCuts: number;
  clauses: number;
  smartTurns: number;
  providerKind: VoiceV13ProviderKindView;
  providerReady: boolean;
  wakeWordState: VoiceV13WakeWordStateView;
  wakeIgnoredFrames: number;
}

/** Barge-in engine stats for the panel. */
export interface VoiceV13BargeInView {
  speechStarts: number;
  cuts: number;
  ignored: number;
  gated: number;
  notSpeaking: number;
  echoIgnored: number;
  lastCutAtMs: number | null;
  playedCharsKept: number;
  ttsCharsDiscarded: number;
  staleWorkCancelled: number;
  scopePending: number;
  scopeCancelled: number;
  interrupts: number;
}

/** One clause row (clause text, terminator, join pause). */
export interface VoiceV13ClauseRowView {
  index: number;
  text: string;
  terminator: string;
  isTail: boolean;
  joinPauseMs: number;
  completedAtMs: number;
  endChar: number;
  /** Truncated text for the row (the full text is in `text`). */
  shortText: string;
}

/** Smart Turn stats for the panel. */
export interface VoiceV13SmartTurnView {
  turns: number;
  endedByContent: number;
  endedBySilence: number;
  endedByTimeout: number;
  backchannels: number;
  decisions: number;
  meanScore: number;
  meanConfidence: number;
}

/** One latency stage row for the budget dashboard. */
export interface VoiceV13LatencyRowView {
  stage: VoiceV13LatencyStageView;
  budgetMs: number;
  samples: number;
  p50Ms: number | null;
  p95Ms: number | null;
  maxMs: number | null;
  meanMs: number | null;
  over: number;
  overRate: number;
  overBudget: boolean;
  /** 0..100 bar width for p95 vs budget (capped at 100). */
  p95VsBudgetPct: number;
  /** Short label: "stt · 520/400 ms · 3 over". */
  label: string;
}

/** Latency budget dashboard for the panel. */
export interface VoiceV13LatencyDashboardView {
  rows: VoiceV13LatencyRowView[];
  samples: number;
  turns: number;
  alerts: number;
  overrunTurns: number;
  worstStage: VoiceV13LatencyStageView | null;
  worstOverRate: number;
}

/** Wake-word card for the panel. */
export interface VoiceV13WakeWordView {
  state: VoiceV13WakeWordStateView;
  keywords: string[];
  activations: number;
  refused: number;
  checked: number;
  lastKeyword: string;
  lastConfidence: number | null;
  lastAtMs: number | null;
}

/** One provider row for the provider list. */
export interface VoiceV13ProviderRowView {
  kind: VoiceV13ProviderKindView;
  name: string;
  stt: boolean;
  tts: boolean;
  realtime: boolean;
  local: boolean;
  requiresKey: boolean;
  ready: boolean;
  readinessReason: string;
  /** Short label: "Edge TTS · TTS · ready". */
  label: string;
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

const V13_STATUSES: VoiceSessionV13StatusView[] = [
  'idle', 'listening', 'thinking', 'speaking', 'interrupted', 'cooldown', 'closed',
];

const V13_LATENCY_STAGES: VoiceV13LatencyStageView[] = [
  'capture', 'vad', 'stt', 'llm', 'tts', 'playback', 'e2e',
];

const V13_PROVIDER_KINDS: VoiceV13ProviderKindView[] = [
  'mock', 'edge-tts', 'whisper-local', 'realtime-api',
];

/** Parse a status string defensively (unknown → 'idle'). */
export function parseVoiceV13Status(value: unknown): VoiceSessionV13StatusView {
  return typeof value === 'string' && (V13_STATUSES as readonly string[]).includes(value)
    ? (value as VoiceSessionV13StatusView)
    : 'idle';
}

/** Parse a barge-in v13 policy defensively (unknown → 'immediate'). */
export function parseVoiceV13BargeInPolicy(value: unknown): VoiceV13BargeInPolicyView {
  return value === 'after-min-speech' || value === 'confirm' ? value : 'immediate';
}

/** Parse a latency stage defensively (unknown → 'e2e'). */
export function parseVoiceV13LatencyStage(value: unknown): VoiceV13LatencyStageView {
  return typeof value === 'string' && (V13_LATENCY_STAGES as readonly string[]).includes(value)
    ? (value as VoiceV13LatencyStageView)
    : 'e2e';
}

/** Parse a wake-word state defensively (unknown → 'asleep'). */
export function parseVoiceV13WakeWordState(value: unknown): VoiceV13WakeWordStateView {
  return value === 'active' || value === 'cooldown' ? value : 'asleep';
}

/** Parse a provider kind defensively (unknown → 'mock'). */
export function parseVoiceV13ProviderKind(value: unknown): VoiceV13ProviderKindView {
  return typeof value === 'string' && (V13_PROVIDER_KINDS as readonly string[]).includes(value)
    ? (value as VoiceV13ProviderKindView)
    : 'mock';
}

/** i18n key for a v13 session status (renderer looks it up). */
export function voiceV13StatusKey(status: VoiceSessionV13StatusView): string {
  return `voice.realtime.v13.status.${status}`;
}

/** i18n key for a latency stage (renderer looks it up). */
export function voiceV13LatencyStageKey(stage: VoiceV13LatencyStageView): string {
  return `voice.realtime.v13.latency.stage.${stage}`;
}

/** i18n key for a provider kind (renderer looks it up). */
export function voiceV13ProviderKindKey(kind: VoiceV13ProviderKindView): string {
  return `voice.realtime.v13.provider.${kind}`;
}

/** i18n key for a wake-word state (renderer looks it up). */
export function voiceV13WakeWordStateKey(state: VoiceV13WakeWordStateView): string {
  return `voice.realtime.v13.wakeWord.state.${state}`;
}

/** Parse one v13 session row defensively. */
export function parseVoiceSessionV13Row(value: unknown): VoiceSessionV13RowView {
  const r = asRecord(value);
  const stats = asRecord(r['stats']);
  const wakeWord = asRecord(stats['wakeWord']);
  const smartTurn = asRecord(stats['smartTurn']);
  return {
    id: asString(r['sessionId'] ?? r['id']),
    status: parseVoiceV13Status(r['status'] ?? stats['state']),
    botId: asString(r['botId'] ?? stats['botId']),
    language: asString(r['language'] ?? stats['language']),
    voice: asString(r['voice'] ?? stats['voice']),
    connected: asBoolean(r['connected'] ?? stats['connected'], true),
    durationMs: asNumber(r['durationMs'] ?? stats['nowMs']),
    turns: asNumber(stats['turns']),
    userTurns: asNumber(stats['userTurns']),
    agentTurns: asNumber(stats['agentTurns']),
    interrupts: asNumber(stats['interrupts']),
    bargeInCuts: asNumber(asRecord(stats['bargeInV13'])['cuts']),
    clauses: asNumber(stats['clauses']),
    smartTurns: asNumber(smartTurn['turns']),
    providerKind: parseVoiceV13ProviderKind(stats['providerKind']),
    providerReady: asBoolean(stats['providerReady']),
    wakeWordState: parseVoiceV13WakeWordState(wakeWord['state']),
    wakeIgnoredFrames: asNumber(stats['wakeIgnoredFrames']),
  };
}

/** Parse barge-in engine stats defensively. */
export function parseVoiceV13BargeIn(value: unknown): VoiceV13BargeInView {
  const r = asRecord(value);
  const scope = asRecord(r['scope']);
  const context = asRecord(r['context']);
  return {
    speechStarts: asNumber(r['speechStarts']),
    cuts: asNumber(r['cuts']),
    ignored: asNumber(r['ignored']),
    gated: asNumber(r['gated']),
    notSpeaking: asNumber(r['notSpeaking']),
    echoIgnored: asNumber(r['echoIgnored']),
    lastCutAtMs: asNullableNumber(r['lastCutAtMs']),
    playedCharsKept: asNumber(r['playedCharsKept']),
    ttsCharsDiscarded: asNumber(r['ttsCharsDiscarded']),
    staleWorkCancelled: asNumber(r['staleWorkCancelled']),
    scopePending: asNumber(scope['pending']),
    scopeCancelled: asNumber(scope['cancelled']),
    interrupts: asNumber(context['interrupts']),
  };
}

/** Parse Smart Turn stats defensively. */
export function parseVoiceV13SmartTurn(value: unknown): VoiceV13SmartTurnView {
  const r = asRecord(value);
  return {
    turns: asNumber(r['turns']),
    endedByContent: asNumber(r['endedByContent']),
    endedBySilence: asNumber(r['endedBySilence']),
    endedByTimeout: asNumber(r['endedByTimeout']),
    backchannels: asNumber(r['backchannels']),
    decisions: asNumber(r['decisions']),
    meanScore: asNumber(r['meanScore']),
    meanConfidence: asNumber(r['meanConfidence']),
  };
}

/** Parse one latency stage report into a dashboard row. */
export function parseVoiceV13LatencyRow(value: unknown): VoiceV13LatencyRowView {
  const r = asRecord(value);
  const stage = parseVoiceV13LatencyStage(r['stage']);
  const budgetMs = asNumber(r['budgetMs']);
  const p95Ms = asNullableNumber(r['p95Ms']);
  const over = asNumber(r['over']);
  const samples = asNumber(r['samples']);
  return {
    stage,
    budgetMs,
    samples,
    p50Ms: asNullableNumber(r['p50Ms']),
    p95Ms,
    maxMs: asNullableNumber(r['maxMs']),
    meanMs: asNullableNumber(r['meanMs']),
    over,
    overRate: asNumber(r['overRate']),
    overBudget: asBoolean(r['overBudget']),
    p95VsBudgetPct: budgetMs > 0 && p95Ms !== null ? Math.min(100, Math.round((p95Ms / budgetMs) * 100)) : 0,
    label: `${stage} · ${p95Ms === null ? '-' : `${p95Ms}`} / ${budgetMs} ms · ${over} over`,
  };
}

/** Parse a list of latency stage reports into dashboard rows (in stage order). */
export function parseVoiceV13LatencyRows(value: unknown): VoiceV13LatencyRowView[] {
  if (!Array.isArray(value)) return [];
  const rows = value.map((v) => parseVoiceV13LatencyRow(v));
  const order = new Map(V13_LATENCY_STAGES.map((s, i) => [s, i]));
  return rows.sort((a, b) => (order.get(a.stage) ?? 99) - (order.get(b.stage) ?? 99));
}

/** Parse the whole latency dashboard (rows + counters). */
export function parseVoiceV13LatencyDashboard(value: unknown): VoiceV13LatencyDashboardView {
  const r = asRecord(value);
  const rows = parseVoiceV13LatencyRows(r['reports'] ?? r['rows']);
  const stats = asRecord(r['stats']);
  const worst = rows.reduce<VoiceV13LatencyRowView | null>(
    (acc, row) => (acc === null || row.overRate > acc.overRate ? row : acc),
    null,
  );
  return {
    rows,
    samples: asNumber(r['samples'] ?? stats['samples']),
    turns: asNumber(r['turns'] ?? stats['turns']),
    alerts: asNumber(r['alerts'] ?? stats['alerts']),
    overrunTurns: asNumber(r['overrunTurns'] ?? stats['overrunTurns']),
    worstStage: worst ? worst.stage : null,
    worstOverRate: worst ? worst.overRate : 0,
  };
}

/** Parse the wake-word card defensively. */
export function parseVoiceV13WakeWord(value: unknown): VoiceV13WakeWordView {
  const r = asRecord(value);
  const last = asRecord(r['lastActivation']);
  return {
    state: parseVoiceV13WakeWordState(r['state']),
    keywords: asStringArray(r['keywords']),
    activations: asNumber(r['activations']),
    refused: asNumber(r['refused']),
    checked: asNumber(r['checked']),
    lastKeyword: asString(last['keyword']),
    lastConfidence: asNullableNumber(last['confidence']),
    lastAtMs: asNullableNumber(last['atMs']),
  };
}

/** Parse one provider into a list row. */
export function parseVoiceV13ProviderRow(value: unknown): VoiceV13ProviderRowView {
  const r = asRecord(value);
  const caps = asRecord(r['capabilities']);
  const kind = parseVoiceV13ProviderKind(r['kind']);
  const ready = asBoolean(r['ready'] ?? r['isReady']);
  const name = asString(r['name'], kind);
  const stt = asBoolean(caps['stt']);
  const tts = asBoolean(caps['tts']);
  return {
    kind,
    name,
    stt,
    tts,
    realtime: asBoolean(caps['realtime']),
    local: asBoolean(caps['local']),
    requiresKey: asBoolean(caps['requiresKey']),
    ready,
    readinessReason: asString(r['readinessReason']),
    label: `${name} · ${[stt ? 'STT' : null, tts ? 'TTS' : null].filter(Boolean).join(' + ') || '—'} · ${ready ? 'ready' : 'not ready'}`,
  };
}

/** Parse a list of providers into rows. */
export function parseVoiceV13ProviderRows(value: unknown): VoiceV13ProviderRowView[] {
  if (!Array.isArray(value)) return [];
  return value.map((v) => parseVoiceV13ProviderRow(v));
}

/** Parse clause rows (clause text, terminator, join pause). */
export function parseVoiceV13ClauseRows(value: unknown): VoiceV13ClauseRowView[] {
  if (!Array.isArray(value)) return [];
  return value.map((v) => {
    const r = asRecord(v);
    const text = asString(r['text']);
    return {
      index: asNumber(r['index']),
      text,
      terminator: asString(r['terminator']),
      isTail: asBoolean(r['isTail']),
      joinPauseMs: asNumber(r['joinPauseMs']),
      completedAtMs: asNumber(r['completedAtMs']),
      endChar: asNumber(r['endChar']),
      shortText: text.length > 60 ? `${text.slice(0, 60)}…` : text,
    };
  });
}

/** Format a millisecond duration for the panel ("1.2 s", "350 ms"). */
export function formatVoiceV13Duration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '-';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

/** Format an over-rate (0..1) as a percentage. */
export function formatVoiceV13OverRate(rate: number): string {
  if (!Number.isFinite(rate) || rate < 0) return '-';
  return `${Math.round(rate * 100)}%`;
}

/** Summary lines for the v13 session header (status, provider, wake word, latency). */
export function voiceV13SummaryLines(stats: {
  state?: unknown;
  turns?: unknown;
  bargeInCuts?: unknown;
  clauses?: unknown;
  providerKind?: unknown;
  providerReady?: unknown;
  wakeWordState?: unknown;
}): string[] {
  return [
    `state: ${asString(stats.state, 'idle')}`,
    `turns: ${asNumber(stats.turns)}`,
    `barge-in cuts: ${asNumber(stats.bargeInCuts)}`,
    `clauses: ${asNumber(stats.clauses)}`,
    `provider: ${asString(stats.providerKind, 'mock')}${asBoolean(stats.providerReady) ? '' : ' (not ready)'}`,
    `wake word: ${asString(stats.wakeWordState, 'asleep')}`,
  ];
}

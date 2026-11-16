/**
 * Voice session v14 view models (v1.15, Team T5 - voice v14 + UI).
 *
 * Renderer-local mirror of the core v14 session shapes (the
 * BudgetMeter pattern, same as v13): the renderer must NOT
 * value-import from `@open-bot/core` — the core bundles are
 * CJS and vite inlines them verbatim, which throws
 * `ReferenceError: exports is not defined` at startup and
 * leaves a blank screen. This module owns the view contract
 * instead: defensive parsing of the IPC payloads
 * (`voice-v14:*` returns plain JSON), the latency budget v2
 * dashboard (per-session p50 / p95 / p99, network stage,
 * profile, warn/critical alerts, compliance rate), the
 * provider v2 list (Deepgram / Cartesia / Whisper local /
 * Pocket TTS, split STT/TTS capabilities, first-audio, pick
 * goal scores), the Smart Turn v2 readout (clause boundary,
 * open/closed question, filler density, backchannel class,
 * sensitivity), the wake-word v2 card (multi-word configs,
 * pending-confirm state, suppressed false positives, test-set
 * evaluation) and the barge-in v2 card (pipeline queue depths,
 * cut latency, mid-sentence split). Pure functions, no React,
 * no DOM, no IPC — unit-tested with plain node --test (see
 * tests/voice-v115.test.mjs).
 */

/** UI status of a v14 voice session (what the panel renders). */
export type VoiceSessionV14StatusView =
  | 'idle' | 'listening' | 'thinking' | 'speaking' | 'interrupted' | 'cooldown' | 'closed';

/** Latency stages the v14 dashboard shows. */
export type VoiceV14LatencyStageView = 'capture' | 'vad' | 'stt' | 'llm' | 'tts' | 'playback' | 'network' | 'e2e';

/** Latency budget profiles the panel shows. */
export type VoiceV14LatencyProfileView = 'local' | 'cloud' | 'realtime' | 'custom';

/** Alert levels the panel shows. */
export type VoiceV14AlertLevelView = 'warn' | 'critical';

/** Provider kinds the panel shows. */
export type VoiceV14ProviderKindView = 'mock' | 'deepgram' | 'cartesia' | 'whisper-local-v14' | 'pocket-tts' | 'realtime-api';

/** Provider pick goals the panel shows. */
export type VoiceV14PickGoalView = 'latency' | 'quality' | 'cost' | 'balanced';

/** Wake-word v2 states the panel shows. */
export type VoiceV14WakeWordStateView = 'asleep' | 'pending-confirm' | 'active' | 'cooldown';

/** Smart Turn v2 sensitivities the panel shows. */
export type VoiceV14SensitivityView = 'low' | 'balanced' | 'high';

/** Question kinds the panel shows. */
export type VoiceV14QuestionKindView = 'open' | 'closed' | 'none';

/** Backchannel classes the panel shows. */
export type VoiceV14BackchannelView = 'ack' | 'continue' | 'filler' | 'none';

/** Pipeline stages the panel shows. */
export type VoiceV14PipelineStageView = 'vad' | 'stt' | 'llm' | 'tts';

/** One row in the voice session list (as the IPC returns it). */
export interface VoiceSessionV14RowView {
  id: string;
  status: VoiceSessionV14StatusView;
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
  pipelineDiscarded: number;
  meanCutLatencyMs: number;
  clauses: number;
  smartTurns: number;
  smartTurnsV14: number;
  providerKind: VoiceV14ProviderKindView;
  providerReady: boolean;
  wakeWordState: VoiceV14WakeWordStateView;
  wakeActivations: number;
  wakeSuppressed: number;
  latencyProfile: VoiceV14LatencyProfileView;
  latencyAlerts: number;
  latencyCriticalAlerts: number;
  complianceRate: number;
}

/** One per-stage latency row (v14: p99 + network + level). */
export interface VoiceV14LatencyRowView {
  stage: VoiceV14LatencyStageView;
  budgetMs: number;
  samples: number;
  p50Ms: number | null;
  p95Ms: number | null;
  p99Ms: number | null;
  maxMs: number | null;
  over: number;
  overRate: number;
  overBudget: boolean;
}

/** One v14 latency alert row. */
export interface VoiceV14AlertRowView {
  sessionId: string;
  turnId: string;
  stage: VoiceV14LatencyStageView;
  ms: number;
  budgetMs: number;
  overMs: number;
  level: VoiceV14AlertLevelView;
  kind: 'sample' | 'p95';
  atMs: number;
}

/** One v14 provider row. */
export interface VoiceV14ProviderRowView {
  kind: VoiceV14ProviderKindView;
  name: string;
  stt: boolean;
  streamingStt: boolean;
  tts: boolean;
  streamingTts: boolean;
  realtime: boolean;
  local: boolean;
  requiresKey: boolean;
  ready: boolean;
  reason: string;
  quality: number;
  ttsFirstAudioMs: number;
  sttCostUsdPerMinute: number;
  ttsCostUsdPer1kChars: number;
  scoreLatency: number;
  scoreQuality: number;
  scoreCost: number;
  scoreBalanced: number;
}

/** One Smart Turn v14 readout row. */
export interface VoiceV14SmartTurnRowView {
  score: number;
  complete: boolean;
  clauses: number;
  endsAtClauseBoundary: boolean;
  questionKind: VoiceV14QuestionKindView;
  fillerDensity: number;
  backchannel: VoiceV14BackchannelView;
  signals: string[];
}

/** One wake-word v2 row (per word config). */
export interface VoiceV14WakeWordRowView {
  keyword: string;
  minConfidence: number;
  cooldownMs: number;
  requireVadConfirm: boolean;
  confirmWindowMs: number;
  activations: number;
  suppressed: number;
}

/** One pipeline queue row. */
export interface VoiceV14PipelineRowView {
  stage: VoiceV14PipelineStageView;
  depth: number;
  maxDepth: number;
  enqueued: number;
  dequeued: number;
  dropped: number;
  rejected: number;
  flushed: number;
  queuedCost: number;
}

/** One wake-word evaluation row. */
export interface VoiceV14EvalRowView {
  keyword: string;
  tp: number;
  fp: number;
  fn: number;
  tn: number;
  falseAcceptRate: number;
  falseRejectRate: number;
  accuracy: number;
  samples: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function asNullableNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function asBoolean(value: unknown, fallback = false): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function asStringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

const V14_STATUSES: readonly string[] = ['idle', 'listening', 'thinking', 'speaking', 'interrupted', 'cooldown', 'closed'];
const V14_LATENCY_STAGES: readonly string[] = ['capture', 'vad', 'stt', 'llm', 'tts', 'playback', 'network', 'e2e'];
const V14_PROFILES: readonly string[] = ['local', 'cloud', 'realtime', 'custom'];
const V14_PROVIDER_KINDS: readonly string[] = ['mock', 'deepgram', 'cartesia', 'whisper-local-v14', 'pocket-tts', 'realtime-api'];
const V14_WAKE_STATES: readonly string[] = ['asleep', 'pending-confirm', 'active', 'cooldown'];
const V14_PIPELINE_STAGES: readonly string[] = ['vad', 'stt', 'llm', 'tts'];

export function parseVoiceV14Status(value: unknown): VoiceSessionV14StatusView {
  return typeof value === 'string' && V14_STATUSES.includes(value)
    ? (value as VoiceSessionV14StatusView)
    : 'idle';
}

export function parseVoiceV14LatencyStage(value: unknown): VoiceV14LatencyStageView | null {
  return typeof value === 'string' && V14_LATENCY_STAGES.includes(value)
    ? (value as VoiceV14LatencyStageView)
    : null;
}

export function parseVoiceV14LatencyProfile(value: unknown): VoiceV14LatencyProfileView {
  return typeof value === 'string' && V14_PROFILES.includes(value)
    ? (value as VoiceV14LatencyProfileView)
    : 'cloud';
}

export function parseVoiceV14ProviderKind(value: unknown): VoiceV14ProviderKindView {
  return typeof value === 'string' && V14_PROVIDER_KINDS.includes(value)
    ? (value as VoiceV14ProviderKindView)
    : 'mock';
}

export function parseVoiceV14WakeWordState(value: unknown): VoiceV14WakeWordStateView {
  return typeof value === 'string' && V14_WAKE_STATES.includes(value)
    ? (value as VoiceV14WakeWordStateView)
    : 'asleep';
}

/** Parse one session row from the IPC payload (defensive: missing fields fall back). */
export function parseVoiceSessionV14Row(input: unknown): VoiceSessionV14RowView | null {
  if (!isRecord(input)) return null;
  const stats = isRecord(input['stats']) ? input['stats'] : {};
  const bargeInV14 = isRecord(stats['bargeInV14']) ? stats['bargeInV14'] : {};
  const pipeline = isRecord(bargeInV14['pipeline']) ? bargeInV14['pipeline'] : {};
  const smartTurnV14 = isRecord(stats['smartTurnV14']) ? stats['smartTurnV14'] : {};
  const wakeWordV14 = isRecord(stats['wakeWordV14']) ? stats['wakeWordV14'] : {};
  const latencyV14 = isRecord(stats['latencyBudgetV14']) ? stats['latencyBudgetV14'] : {};
  const v13 = isRecord(bargeInV14['v13']) ? bargeInV14['v13'] : {};
  return {
    id: asString(input['sessionId'] ?? input['id']),
    status: parseVoiceV14Status(input['status'] ?? stats['state']),
    botId: asString(stats['botId']),
    language: asString(stats['language']),
    voice: asString(stats['voice']),
    connected: asBoolean(input['connected'], asBoolean(stats['connected'], true)),
    durationMs: asNumber(input['durationMs'] ?? stats['durationMs']),
    turns: asNumber(stats['turns']),
    userTurns: asNumber(stats['userTurns']),
    agentTurns: asNumber(stats['agentTurns']),
    interrupts: asNumber(stats['interrupts']),
    bargeInCuts: asNumber(v13['cuts']),
    pipelineDiscarded: asNumber(pipeline['cutDiscarded']),
    meanCutLatencyMs: asNumber(pipeline['meanCutLatencyMs']),
    clauses: asNumber(stats['clauses']),
    smartTurns: asNumber(isRecord(stats['smartTurn']) ? stats['smartTurn']['turns'] : 0),
    smartTurnsV14: asNumber(smartTurnV14['turns']),
    providerKind: parseVoiceV14ProviderKind(stats['providerKindV14'] ?? stats['providerKind']),
    providerReady: asBoolean(stats['providerReadyV14'], asBoolean(stats['providerReady'])),
    wakeWordState: parseVoiceV14WakeWordState(wakeWordV14['state']),
    wakeActivations: asNumber(wakeWordV14['activations']),
    wakeSuppressed: asNumber(wakeWordV14['suppressed']),
    latencyProfile: parseVoiceV14LatencyProfile(input['latencyProfile']),
    latencyAlerts: asNumber(latencyV14['alerts']),
    latencyCriticalAlerts: asNumber(latencyV14['criticalAlerts']),
    complianceRate: 0,
  };
}

/** Parse a list of session rows (skips unparseable entries). */
export function parseVoiceSessionV14Rows(input: unknown): VoiceSessionV14RowView[] {
  if (!Array.isArray(input)) return [];
  const rows: VoiceSessionV14RowView[] = [];
  for (const entry of input) {
    const row = parseVoiceSessionV14Row(entry);
    if (row) rows.push(row);
  }
  return rows;
}

/** Parse per-stage latency rows for one session report. */
export function parseVoiceV14LatencyRows(input: unknown): VoiceV14LatencyRowView[] {
  const stages = isRecord(input) && Array.isArray(input['stages']) ? input['stages'] : [];
  const rows: VoiceV14LatencyRowView[] = [];
  for (const entry of stages) {
    if (!isRecord(entry)) continue;
    const stage = parseVoiceV14LatencyStage(entry['stage']);
    if (!stage) continue;
    rows.push({
      stage,
      budgetMs: asNumber(entry['budgetMs']),
      samples: asNumber(entry['samples']),
      p50Ms: asNullableNumber(entry['p50Ms']),
      p95Ms: asNullableNumber(entry['p95Ms']),
      p99Ms: asNullableNumber(entry['p99Ms']),
      maxMs: asNullableNumber(entry['maxMs']),
      over: asNumber(entry['over']),
      overRate: asNumber(entry['overRate']),
      overBudget: asBoolean(entry['overBudget']),
    });
  }
  return rows;
}

/** Parse v14 latency alerts (warn / critical). */
export function parseVoiceV14AlertRows(input: unknown): VoiceV14AlertRowView[] {
  if (!Array.isArray(input)) return [];
  const rows: VoiceV14AlertRowView[] = [];
  for (const entry of input) {
    if (!isRecord(entry)) continue;
    const stage = parseVoiceV14LatencyStage(entry['stage']);
    if (!stage) continue;
    const level = entry['level'] === 'critical' ? 'critical' : 'warn';
    rows.push({
      sessionId: asString(entry['sessionId']),
      turnId: asString(entry['turnId']),
      stage,
      ms: asNumber(entry['ms']),
      budgetMs: asNumber(entry['budgetMs']),
      overMs: asNumber(entry['overMs']),
      level,
      kind: entry['kind'] === 'p95' ? 'p95' : 'sample',
      atMs: asNumber(entry['atMs']),
    });
  }
  return rows;
}

/** Score helper (mirrors the core scoring ranges for the panel). */
export function scoreVoiceV14ProviderRow(row: VoiceV14ProviderRowView, goal: VoiceV14PickGoalView): number {
  switch (goal) {
    case 'latency': return row.scoreLatency;
    case 'quality': return row.scoreQuality;
    case 'cost': return row.scoreCost;
    case 'balanced': return row.scoreBalanced;
    default: return row.scoreBalanced;
  }
}

/** Parse v14 provider rows from the registry payload. */
export function parseVoiceV14ProviderRows(input: unknown): VoiceV14ProviderRowView[] {
  if (!Array.isArray(input)) return [];
  const rows: VoiceV14ProviderRowView[] = [];
  for (const entry of input) {
    if (!isRecord(entry)) continue;
    const kind = parseVoiceV14ProviderKind(entry['kind']);
    const caps = isRecord(entry['capabilities']) ? entry['capabilities'] : {};
    const profile = isRecord(entry['profile']) ? entry['profile'] : {};
    const latencyMs = asNumber(profile['sttLatencyMsPerSecond']) * 10 + asNumber(profile['ttsFirstAudioMs']);
    const latencyScore = Math.max(0, 1 - latencyMs / 3000);
    const qualityScore = asNumber(profile['quality']);
    const hourlyCost = asNumber(profile['sttCostUsdPerMinute']) * 30 + (asNumber(profile['ttsCostUsdPer1kChars']) * 6000) / 1000;
    const costScore = Math.max(0, 1 - hourlyCost / 5);
    const round2 = (v: number): number => Math.round(v * 100) / 100;
    rows.push({
      kind,
      name: asString(entry['name']),
      stt: asBoolean(caps['stt']),
      streamingStt: asBoolean(caps['streamingStt']),
      tts: asBoolean(caps['tts']),
      streamingTts: asBoolean(caps['streamingTts']),
      realtime: asBoolean(caps['realtime']),
      local: asBoolean(caps['local']),
      requiresKey: asBoolean(caps['requiresKey']),
      ready: asBoolean(entry['ready'], asBoolean(entry['isReady'])),
      reason: asString(entry['reason'] ?? entry['readinessReason']),
      quality: qualityScore,
      ttsFirstAudioMs: asNumber(profile['ttsFirstAudioMs']),
      sttCostUsdPerMinute: asNumber(profile['sttCostUsdPerMinute']),
      ttsCostUsdPer1kChars: asNumber(profile['ttsCostUsdPer1kChars']),
      scoreLatency: round2(latencyScore * 0.7 + qualityScore * 0.2 + costScore * 0.1),
      scoreQuality: round2(qualityScore * 0.7 + latencyScore * 0.2 + costScore * 0.1),
      scoreCost: round2(costScore * 0.7 + latencyScore * 0.2 + qualityScore * 0.1),
      scoreBalanced: round2((latencyScore + qualityScore + costScore) / 3),
    });
  }
  return rows;
}

/** Parse one Smart Turn v14 readout. */
export function parseVoiceV14SmartTurnRow(input: unknown): VoiceV14SmartTurnRowView | null {
  if (!isRecord(input)) return null;
  const questionKind = input['questionKind'] === 'open' || input['questionKind'] === 'closed' ? input['questionKind'] : 'none';
  const backchannel = ['ack', 'continue', 'filler'].includes(asString(input['backchannel'])) ? asString(input['backchannel']) : 'none';
  return {
    score: asNumber(input['score']),
    complete: asBoolean(input['complete']),
    clauses: Array.isArray(input['clauses']) ? input['clauses'].length : asNumber(input['clauses']),
    endsAtClauseBoundary: asBoolean(input['endsAtClauseBoundary']),
    questionKind: questionKind as VoiceV14QuestionKindView,
    fillerDensity: asNumber(input['fillerDensity']),
    backchannel: backchannel as VoiceV14BackchannelView,
    signals: Array.isArray(input['signals'])
      ? (input['signals'] as unknown[]).map((s) => (isRecord(s) ? asString(s['name']) : asString(s))).filter((s) => s.length > 0)
      : asStringList(input['signals']),
  };
}

/** Parse wake-word v2 rows (one per word config). */
export function parseVoiceV14WakeWordRows(input: unknown): VoiceV14WakeWordRowView[] {
  const stats = isRecord(input) ? input : {};
  const words = Array.isArray(stats['words']) ? stats['words'] : [];
  const byKeyword = isRecord(stats['byKeyword']) ? stats['byKeyword'] : {};
  const suppressedByKeyword = isRecord(stats['suppressedByKeyword']) ? stats['suppressedByKeyword'] : {};
  const rows: VoiceV14WakeWordRowView[] = [];
  for (const entry of words) {
    if (!isRecord(entry)) continue;
    const keyword = asString(entry['keyword']);
    if (!keyword) continue;
    rows.push({
      keyword,
      minConfidence: asNumber(entry['minConfidence'], 0.5),
      cooldownMs: asNumber(entry['cooldownMs'], 3000),
      requireVadConfirm: asBoolean(entry['requireVadConfirm'], true),
      confirmWindowMs: asNumber(entry['confirmWindowMs'], 2000),
      activations: asNumber(byKeyword[keyword]),
      suppressed: asNumber(suppressedByKeyword[keyword]),
    });
  }
  return rows;
}

/** Parse pipeline queue rows from the barge-in v14 stats payload. */
export function parseVoiceV14PipelineRows(input: unknown): VoiceV14PipelineRowView[] {
  const pipeline = isRecord(input) && isRecord(input['pipeline']) ? input['pipeline'] : isRecord(input) ? input : {};
  const queues = isRecord(pipeline['queues']) ? pipeline['queues'] : {};
  const rows: VoiceV14PipelineRowView[] = [];
  for (const stage of V14_PIPELINE_STAGES) {
    const q = isRecord(queues[stage]) ? queues[stage] : {};
    rows.push({
      stage: stage as VoiceV14PipelineStageView,
      depth: asNumber(q['depth']),
      maxDepth: asNumber(q['maxDepth']),
      enqueued: asNumber(q['enqueued']),
      dequeued: asNumber(q['dequeued']),
      dropped: asNumber(q['dropped']),
      rejected: asNumber(q['rejected']),
      flushed: asNumber(q['flushed']),
      queuedCost: asNumber(q['queuedCost']),
    });
  }
  return rows;
}

/** Parse wake-word evaluation rows (overall + per keyword). */
export function parseVoiceV14EvalRows(input: unknown): VoiceV14EvalRowView[] {
  const evaluation = isRecord(input) ? input : {};
  const perKeyword = Array.isArray(evaluation['perKeyword']) ? evaluation['perKeyword'] : [];
  const rows: VoiceV14EvalRowView[] = [];
  const overall = isRecord(evaluation['overall']) ? evaluation['overall'] : null;
  if (overall) {
    rows.push({
      keyword: 'overall',
      tp: asNumber(overall['tp']),
      fp: asNumber(overall['fp']),
      fn: asNumber(overall['fn']),
      tn: asNumber(overall['tn']),
      falseAcceptRate: asNumber(overall['falseAcceptRate']),
      falseRejectRate: asNumber(overall['falseRejectRate']),
      accuracy: asNumber(overall['accuracy']),
      samples: asNumber(overall['samples']),
    });
  }
  for (const entry of perKeyword) {
    if (!isRecord(entry)) continue;
    rows.push({
      keyword: asString(entry['keyword']),
      tp: asNumber(entry['tp']),
      fp: asNumber(entry['fp']),
      fn: asNumber(entry['fn']),
      tn: asNumber(entry['tn']),
      falseAcceptRate: asNumber(entry['falseAcceptRate']),
      falseRejectRate: asNumber(entry['falseRejectRate']),
      accuracy: asNumber(entry['accuracy']),
      samples: asNumber(entry['samples']),
    });
  }
  return rows;
}

/** Format ms for the panel (e.g. 650 → "650 ms"). */
export function formatVoiceV14Ms(ms: number | null): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '-';
  return `${Math.round(ms)} ms`;
}

/** Format a rate 0..1 as a percentage (e.g. 0.85 → "85%"). */
export function formatVoiceV14Rate(rate: number): string {
  if (!Number.isFinite(rate)) return '-';
  return `${Math.round(rate * 100)}%`;
}

/** Format a USD cost (e.g. 0.0043 → "$0.0043"). */
export function formatVoiceV14Usd(usd: number): string {
  if (!Number.isFinite(usd)) return '-';
  return `$${usd.toFixed(4)}`;
}

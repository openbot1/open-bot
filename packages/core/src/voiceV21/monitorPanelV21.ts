/**
 * Realtime monitor panel v21 (voice v21, v1.34 Team T5).
 *
 * The view-model behind the realtime session monitor: one
 * snapshot that the renderer can paint without knowing anything
 * about the session internals. It follows the same pattern as
 * the earlier voice panels — a plain-data snapshot (no DOM, no
 * React), a markdown rendering for logs, and i18n keys for every
 * user-visible string so the panel reads the same in all six
 * locales.
 *
 * The panel shows, live:
 *
 *   - turn state (listening / speaking / waiting / confirming)
 *     and how long the session has been in it;
 *   - the live transcript: the partial text being heard right
 *     now plus the last finalised lines;
 *   - the tool call currently running (or waiting for a spoken
 *     confirmation) and the last few finished calls;
 *   - latency: mean/p95 response latency and per-stage means;
 *   - TTS cache hit rate, entries and bytes;
 *   - barge-in counts and the last decision;
 *   - the latest eval verdict (WER, latency) when one exists;
 *   - alerts: a pending confirmation going stale, a latency
 *     budget breach, a low cache hit rate, a failing eval.
 *
 * The panel never drives the session — it only observes. The
 * session (or the tools layer) pushes updates in; `snapshot()`
 * pulls a frozen copy out. All timestamps use the virtual clock
 * the caller passes in, so tests are deterministic.
 */
import {
  round2V21,
  round4V21,
  type VoiceV21LatencySample,
  type VoiceV21LatencyStage,
  type VoiceV21ToolCallRecord,
  type VoiceV21TurnState,
} from './types';
import type { VoiceV21EvalReport } from './evalV21';

export interface VoiceV21PanelToolCallView {
  id: string;
  toolName: string;
  status: string;
  effect: string;
  resultText?: string;
  startedAtMs?: number;
  finishedAtMs?: number;
}

export interface VoiceV21PanelLatencyView {
  meanResponseMs: number;
  p95ResponseMs: number;
  /** Mean ms per stage (only stages with samples). */
  stageMeanMs: Partial<Record<VoiceV21LatencyStage, number>>;
  /** Stages currently over budget. */
  breachedStages: VoiceV21LatencyStage[];
}

export interface VoiceV21PanelCacheView {
  entries: number;
  bytes: number;
  hitRate: number;
  hits: number;
  misses: number;
  evictions: number;
}

export interface VoiceV21PanelEvalView {
  verdict: 'pass' | 'fail';
  meanWer: number;
  meanCer: number;
  endToEndP95Ms: number;
  warnings: string[];
}

export interface VoiceV21MonitorSnapshot {
  sessionId: string;
  updatedAtMs: number;
  turnState: VoiceV21TurnState;
  msInState: number;
  /** Partial transcript being heard right now ('' when none). */
  livePartial: string;
  /** Last finalised transcript lines, newest last (max 10). */
  finalTranscript: string[];
  currentToolCall: VoiceV21PanelToolCallView | null;
  recentToolCalls: VoiceV21PanelToolCallView[];
  latency: VoiceV21PanelLatencyView;
  cache: VoiceV21PanelCacheView;
  bargeIns: number;
  ducks: number;
  lastBargeInDecision: string | null;
  eval: VoiceV21PanelEvalView | null;
  alerts: string[];
}

/** i18n keys the panel uses (renderer resolves them). */
export const VOICE_V21_PANEL_I18N_KEYS = [
  'voice.v21.panel.title',
  'voice.v21.panel.listening',
  'voice.v21.panel.speaking',
  'voice.v21.panel.waiting',
  'voice.v21.panel.confirming',
  'voice.v21.panel.idle',
  'voice.v21.panel.liveTranscript',
  'voice.v21.panel.toolCall',
  'voice.v21.panel.latency',
  'voice.v21.panel.cacheHitRate',
  'voice.v21.panel.bargeIns',
  'voice.v21.panel.eval',
  'voice.v21.panel.alerts',
  'voice.v21.panel.noAlerts',
  'voice.v21.panel.pendingConfirmation',
  'voice.v21.panel.noToolCall',
] as const;

export interface VoiceV21MonitorPanelOptions {
  /** Max final transcript lines kept (default 10). */
  maxTranscriptLines: number;
  /** Max recent tool calls kept (default 5). */
  maxRecentToolCalls: number;
  /** Cache hit rate below this raises an alert (default 0.3). */
  lowHitRateThreshold: number;
  /** Pending confirmation older than this raises an alert (default 30_000 ms). */
  staleConfirmationMs: number;
}

export function defaultMonitorPanelV21Options(): VoiceV21MonitorPanelOptions {
  return {
    maxTranscriptLines: 10,
    maxRecentToolCalls: 5,
    lowHitRateThreshold: 0.3,
    staleConfirmationMs: 30_000,
  };
}

export function validateMonitorPanelV21Options(o: Partial<VoiceV21MonitorPanelOptions>): string[] {
  const e: string[] = [];
  if (o.maxTranscriptLines !== undefined && (!Number.isInteger(o.maxTranscriptLines) || o.maxTranscriptLines < 1)) {
    e.push('maxTranscriptLines must be a positive integer');
  }
  if (o.maxRecentToolCalls !== undefined && (!Number.isInteger(o.maxRecentToolCalls) || o.maxRecentToolCalls < 1)) {
    e.push('maxRecentToolCalls must be a positive integer');
  }
  if (o.lowHitRateThreshold !== undefined && (o.lowHitRateThreshold < 0 || o.lowHitRateThreshold > 1)) {
    e.push('lowHitRateThreshold must be 0..1');
  }
  if (o.staleConfirmationMs !== undefined && o.staleConfirmationMs < 1000) {
    e.push('staleConfirmationMs must be at least 1000');
  }
  return e;
}

function toToolCallView(r: VoiceV21ToolCallRecord): VoiceV21PanelToolCallView {
  return {
    id: r.id,
    toolName: r.toolName,
    status: r.status,
    effect: r.effect,
    ...(r.resultText !== undefined ? { resultText: r.resultText } : {}),
    ...(r.startedAtMs !== undefined ? { startedAtMs: r.startedAtMs } : {}),
    ...(r.finishedAtMs !== undefined ? { finishedAtMs: r.finishedAtMs } : {}),
  };
}

export class MonitorPanelV21 {
  private readonly opts: VoiceV21MonitorPanelOptions;
  private readonly sessionId: string;
  private turnState: VoiceV21TurnState = 'idle';
  private stateSinceMs = 0;
  private updatedAtMs = 0;
  private livePartial = '';
  private finalTranscript: string[] = [];
  private currentToolCall: VoiceV21ToolCallRecord | null = null;
  private recentToolCalls: VoiceV21ToolCallRecord[] = [];
  private readonly latencySamples: VoiceV21LatencySample[] = [];
  private responseLatencies: number[] = [];
  private breachedStages: VoiceV21LatencyStage[] = [];
  private cache: VoiceV21PanelCacheView = { entries: 0, bytes: 0, hitRate: 0, hits: 0, misses: 0, evictions: 0 };
  private bargeIns = 0;
  private ducks = 0;
  private lastBargeInDecision: string | null = null;
  private evalView: VoiceV21PanelEvalView | null = null;

  constructor(sessionId: string, opts: Partial<VoiceV21MonitorPanelOptions> = {}) {
    this.sessionId = sessionId;
    this.opts = { ...defaultMonitorPanelV21Options(), ...opts };
  }

  setTurnState(state: VoiceV21TurnState, atMs: number): void {
    if (state !== this.turnState) {
      this.turnState = state;
      this.stateSinceMs = atMs;
    }
    this.updatedAtMs = atMs;
  }

  setLivePartial(text: string, atMs: number): void {
    this.livePartial = text;
    this.updatedAtMs = atMs;
  }

  /** A transcript line finalised — moves from live to history. */
  addFinalTranscript(text: string, atMs: number): void {
    const line = text.trim();
    if (line !== '') {
      this.finalTranscript.push(line);
      while (this.finalTranscript.length > this.opts.maxTranscriptLines) this.finalTranscript.shift();
    }
    this.livePartial = '';
    this.updatedAtMs = atMs;
  }

  setToolCall(record: VoiceV21ToolCallRecord | null, atMs: number): void {
    if (record !== null && (record.status === 'running' || record.status === 'pending-confirmation')) {
      this.currentToolCall = record;
    } else {
      if (record !== null) {
        this.recentToolCalls.push(record);
        while (this.recentToolCalls.length > this.opts.maxRecentToolCalls) this.recentToolCalls.shift();
      }
      this.currentToolCall = null;
    }
    this.updatedAtMs = atMs;
  }

  recordLatency(sample: VoiceV21LatencySample): void {
    this.latencySamples.push(sample);
    if (this.latencySamples.length > 500) this.latencySamples.splice(0, this.latencySamples.length - 500);
    this.updatedAtMs = sample.atMs;
  }

  recordResponseLatency(latencyMs: number, atMs: number): void {
    this.responseLatencies.push(latencyMs);
    if (this.responseLatencies.length > 200) this.responseLatencies.splice(0, this.responseLatencies.length - 200);
    this.updatedAtMs = atMs;
  }

  setBreachedStages(stages: VoiceV21LatencyStage[], atMs: number): void {
    this.breachedStages = [...stages];
    this.updatedAtMs = atMs;
  }

  setCache(cache: VoiceV21PanelCacheView, atMs: number): void {
    this.cache = { ...cache };
    this.updatedAtMs = atMs;
  }

  recordBargeIn(decision: 'ignore' | 'duck' | 'interrupt', atMs: number): void {
    if (decision === 'interrupt') this.bargeIns += 1;
    if (decision === 'duck') this.ducks += 1;
    this.lastBargeInDecision = decision;
    this.updatedAtMs = atMs;
  }

  setEval(report: VoiceV21EvalReport, atMs: number): void {
    this.evalView = {
      verdict: report.overallPass ? 'pass' : 'fail',
      meanWer: report.meanWer,
      meanCer: report.meanCer,
      endToEndP95Ms: report.endToEndP95Ms,
      warnings: [...report.warnings],
    };
    this.updatedAtMs = atMs;
  }

  private computeAlerts(atMs: number): string[] {
    const alerts: string[] = [];
    if (this.currentToolCall !== null && this.currentToolCall.status === 'pending-confirmation'
      && atMs - this.currentToolCall.requestedAtMs > this.opts.staleConfirmationMs) {
      alerts.push(`Confirmation for ${this.currentToolCall.toolName} has been waiting over ${Math.round(this.opts.staleConfirmationMs / 1000)}s.`);
    }
    for (const stage of this.breachedStages) alerts.push(`Latency budget breached: ${stage}.`);
    const totalCache = this.cache.hits + this.cache.misses;
    if (totalCache >= 10 && this.cache.hitRate < this.opts.lowHitRateThreshold) {
      alerts.push(`TTS cache hit rate low: ${(this.cache.hitRate * 100).toFixed(0)}%.`);
    }
    if (this.evalView !== null && this.evalView.verdict === 'fail') {
      alerts.push(`Voice eval failing (mean WER ${(this.evalView.meanWer * 100).toFixed(1)}%).`);
    }
    return alerts;
  }

  snapshot(atMs: number): VoiceV21MonitorSnapshot {
    const stageMeanMs: Partial<Record<VoiceV21LatencyStage, number>> = {};
    const byStage = new Map<VoiceV21LatencyStage, number[]>();
    for (const s of this.latencySamples) {
      const list = byStage.get(s.stage) ?? [];
      list.push(s.durationMs);
      byStage.set(s.stage, list);
    }
    for (const [stage, xs] of byStage) {
      stageMeanMs[stage] = round2V21(xs.reduce((a, b) => a + b, 0) / xs.length);
    }
    const sorted = [...this.responseLatencies].sort((a, b) => a - b);
    const p95 = sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.floor(0.95 * sorted.length))] ?? 0;
    return {
      sessionId: this.sessionId,
      updatedAtMs: this.updatedAtMs,
      turnState: this.turnState,
      msInState: Math.max(0, atMs - this.stateSinceMs),
      livePartial: this.livePartial,
      finalTranscript: [...this.finalTranscript],
      currentToolCall: this.currentToolCall === null ? null : toToolCallView(this.currentToolCall),
      recentToolCalls: this.recentToolCalls.map(toToolCallView),
      latency: {
        meanResponseMs: this.responseLatencies.length === 0
          ? 0
          : round2V21(this.responseLatencies.reduce((a, b) => a + b, 0) / this.responseLatencies.length),
        p95ResponseMs: round2V21(p95),
        stageMeanMs,
        breachedStages: [...this.breachedStages],
      },
      cache: { ...this.cache },
      bargeIns: this.bargeIns,
      ducks: this.ducks,
      lastBargeInDecision: this.lastBargeInDecision,
      eval: this.evalView === null ? null : { ...this.evalView, warnings: [...this.evalView.warnings] },
      alerts: this.computeAlerts(atMs),
    };
  }

  /** Markdown rendering of the current snapshot, for logs. */
  markdown(atMs: number): string {
    const s = this.snapshot(atMs);
    const lines = [
      '# Voice monitor v21',
      '',
      `- Session: ${s.sessionId} — state: ${s.turnState} (${s.msInState} ms)`,
      `- Live: ${s.livePartial === '' ? '(silence)' : s.livePartial}`,
      `- Tool call: ${s.currentToolCall === null ? 'none' : `${s.currentToolCall.toolName} (${s.currentToolCall.status})`}`,
      `- Response latency: mean ${s.latency.meanResponseMs} ms, p95 ${s.latency.p95ResponseMs} ms`,
      `- TTS cache: ${s.cache.entries} entries, hit rate ${(s.cache.hitRate * 100).toFixed(1)}%`,
      `- Barge-ins: ${s.bargeIns} interrupts, ${s.ducks} ducks (last: ${s.lastBargeInDecision ?? 'none'})`,
      `- Eval: ${s.eval === null ? 'not run' : `${s.eval.verdict} (WER ${(s.eval.meanWer * 100).toFixed(1)}%)`}`,
      '',
    ];
    if (s.finalTranscript.length > 0) {
      lines.push('## Transcript', '');
      for (const line of s.finalTranscript) lines.push(`- ${line}`);
      lines.push('');
    }
    if (s.recentToolCalls.length > 0) {
      lines.push('## Recent tool calls', '');
      for (const c of s.recentToolCalls) lines.push(`- ${c.toolName}: ${c.status}`);
      lines.push('');
    }
    lines.push('## Alerts', '');
    if (s.alerts.length === 0) lines.push('- None');
    else for (const a of s.alerts) lines.push(`- ${a}`);
    lines.push('');
    return lines.join('\n');
  }

  summary(atMs: number): string {
    const s = this.snapshot(atMs);
    return `monitor: ${s.turnState} (${s.msInState} ms), tool=${s.currentToolCall?.toolName ?? 'none'}, ` +
      `latency p95=${s.latency.p95ResponseMs} ms, cache hit=${(s.cache.hitRate * 100).toFixed(0)}%, ` +
      `barge-ins=${s.bargeIns}, alerts=${s.alerts.length}`;
  }
}

export function createMonitorPanelV21(
  sessionId: string,
  opts: Partial<VoiceV21MonitorPanelOptions> = {},
): MonitorPanelV21 {
  return new MonitorPanelV21(sessionId, opts);
}

/** Cache hit rate as a 0..1 number (0 when no requests yet). */
export function cacheHitRateV21(hits: number, misses: number): number {
  const total = hits + misses;
  return total === 0 ? 0 : round4V21(hits / total);
}

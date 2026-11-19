/**
 * Live voice status panel for voice v26 (v1.39, Team T5).
 *
 * v25 owns the turn panel (running turns, finished-turn table,
 * floor state, barge-ins, silence, provider latency, alerts).
 * v26 owns the *live status* panel — the small, always-visible
 * strip a user watches while talking:
 *
 *   - floor state: listening / thinking / speaking /
 *     interrupted, with the floor holder;
 *   - audio level meter: instantaneous, smoothed and peak-hold
 *     levels fed by the host (synthetic levels in tests — the
 *     host never needs a real mic, and this panel never opens
 *     one);
 *   - latency now: current turn total vs the total budget,
 *     p50 over the window, over-budget flag;
 *   - degraded mode: off / light / heavy, with what it trades;
 *   - active provider: the TTS provider speaking right now.
 *
 * The panel renders two ways from the same snapshot:
 *   1. as a normal desktop panel (the React component
 *      `VoiceStatusPanelV26` consumes `VoiceV26StatusSnapshot`
 *      directly);
 *   2. as an MCP Apps `ui://` resource — `uiResource()` returns
 *      a descriptor with uri `ui://voice-v26/status`, mime type
 *      `application/vnd.open-bot.voice-status+json`, and the
 *      snapshot plus the i18n keys the host resolves for labels
 *      (survey v139 item 1: the voice panel renders as a
 *      `ui://` resource).
 *
 * All levels are caller-supplied samples; all clocks virtual.
 */
import {
  VOICE_V26_LEVEL_SMOOTHING_DEFAULT,
  VOICE_V26_PEAK_DECAY_PER_MS,
  clampV26,
  floorHolderForStateV26,
  formatDurationV26,
  round2V26,
  statusStateForFloorV26,
  type VoiceV26DegradedLevel,
  type VoiceV26FloorState,
  type VoiceV26LevelSample,
  type VoiceV26StatusSnapshot,
  type VoiceV26StatusState,
  type VoiceV26UiResource,
} from './types';

/** i18n keys the status panel needs (all 6 locales carry them). */
export const VOICE_V26_PANEL_I18N_KEYS = [
  'voice.v26.panel.title',
  'voice.v26.panel.listening',
  'voice.v26.panel.thinking',
  'voice.v26.panel.speaking',
  'voice.v26.panel.interrupted',
  'voice.v26.panel.idle',
  'voice.v26.panel.degraded',
  'voice.v26.panel.error',
  'voice.v26.panel.state',
  'voice.v26.panel.peak',
  'voice.v26.panel.turns',
  'voice.v26.panel.demo',
  'voice.v26.panel.level',
  'voice.v26.panel.latency',
  'voice.v26.panel.budget',
  'voice.v26.panel.provider',
  'voice.v26.panel.turn',
  'voice.v26.panel.bargeIns',
  'voice.v26.panel.overBudget',
  'voice.v26.panel.withinBudget',
  'voice.v26.panel.noSession',
  'voice.v26.panel.light',
  'voice.v26.panel.heavy',
  'voice.v26.panel.off',
  'voice.v26.panel.floorUser',
  'voice.v26.panel.floorAgent',
  'voice.v26.panel.floorNone',
  'voice.v26.panel.openAsResource',
  'voice.v26.panel.resourceUri',
];

/** i18n keys for barge-in / latency / provider labels. */
export const VOICE_V26_I18N_KEYS = [
  ...VOICE_V26_PANEL_I18N_KEYS,
  'voice.v26.bargeIn.title',
  'voice.v26.bargeIn.confirmed',
  'voice.v26.bargeIn.stopped',
  'voice.v26.bargeIn.falsePositive',
  'voice.v26.bargeIn.backchannel',
  'voice.v26.bargeIn.resumeRemaining',
  'voice.v26.bargeIn.summariseRemainder',
  'voice.v26.bargeIn.dropRemainder',
  'voice.v26.bargeIn.askClarify',
  'voice.v26.latency.title',
  'voice.v26.latency.stt',
  'voice.v26.latency.model',
  'voice.v26.latency.tts',
  'voice.v26.latency.total',
  'voice.v26.latency.breach',
  'voice.v26.latency.bottleneck',
  'voice.v26.providers.title',
  'voice.v26.providers.local',
  'voice.v26.providers.apiKey',
  'voice.v26.providers.mock',
  'voice.v26.providers.select',
  'voice.v26.providers.fallback',
  'voice.v26.turn.title',
  'voice.v26.turn.queued',
  'voice.v26.turn.timeout',
  'voice.v26.turn.antiOverlap',
  'voice.v26.session.title',
  'voice.v26.session.open',
  'voice.v26.session.closed',
  'voice.v26.status.title',
];

export interface StatusPanelV26Options {
  /** EMA smoothing for the level meter (default 0.35). */
  levelSmoothing: number;
  /** Peak-hold decay per ms (default 0.0004). */
  peakDecayPerMs: number;
  /** Max level samples kept (default 1000). */
  maxSamples: number;
}

export function defaultStatusPanelV26Options(): StatusPanelV26Options {
  return {
    levelSmoothing: VOICE_V26_LEVEL_SMOOTHING_DEFAULT,
    peakDecayPerMs: VOICE_V26_PEAK_DECAY_PER_MS,
    maxSamples: 1000,
  };
}

export function validateStatusPanelV26Options(o: Partial<StatusPanelV26Options>): string[] {
  const errors: string[] = [];
  if (o.levelSmoothing !== undefined && !(o.levelSmoothing > 0 && o.levelSmoothing <= 1)) {
    errors.push('levelSmoothing must be 0..1');
  }
  if (o.peakDecayPerMs !== undefined && !(o.peakDecayPerMs >= 0 && o.peakDecayPerMs <= 0.1)) {
    errors.push('peakDecayPerMs must be 0..0.1');
  }
  if (o.maxSamples !== undefined && (!Number.isInteger(o.maxSamples) || o.maxSamples < 10 || o.maxSamples > 100000)) {
    errors.push('maxSamples must be an integer 10..100000');
  }
  return errors;
}

/** One row of the panel: a compact, render-ready status line. */
export interface VoiceV26PanelRow {
  labelKey: string;
  value: string;
  /** 'ok' | 'warn' | 'bad' — for colouring the row. */
  tone: 'ok' | 'warn' | 'bad';
}

export function createStatusPanelV26(
  sessionId: string,
  opts: Partial<StatusPanelV26Options> = {},
): StatusPanelV26 {
  return new StatusPanelV26(sessionId, opts);
}

export class StatusPanelV26 {
  private readonly sessionId: string;
  private readonly opts: StatusPanelV26Options;
  private snapshot: VoiceV26StatusSnapshot | null = null;
  private readonly levels: VoiceV26LevelSample[] = [];
  private smoothed = 0;
  private peak = 0;
  private lastLevelMs: number | null = null;

  constructor(sessionId: string, opts: Partial<StatusPanelV26Options> = {}) {
    const errors = validateStatusPanelV26Options(opts);
    if (errors.length > 0) throw new Error(`Invalid StatusPanelV26Options: ${errors.join('; ')}`);
    this.sessionId = sessionId;
    this.opts = { ...defaultStatusPanelV26Options(), ...opts };
  }

  options(): StatusPanelV26Options {
    return { ...this.opts };
  }

  /** Push a fresh status snapshot (from the session). */
  update(snapshot: VoiceV26StatusSnapshot): void {
    this.snapshot = { ...snapshot, level: snapshot.level ? { ...snapshot.level } : null };
  }

  /** Current snapshot (null until the first update). */
  snapshotNow(): VoiceV26StatusSnapshot | null {
    if (!this.snapshot) return null;
    return { ...this.snapshot, level: this.snapshot.level ? { ...this.snapshot.level } : null };
  }

  /**
   * Feed one audio-level sample. Returns the smoothed + peak
   * sample. Levels are caller-supplied (synthetic in tests);
   * the panel never opens a mic.
   */
  feedLevel(input: { atMs: number; level: number; speaking: boolean }): VoiceV26LevelSample {
    const level = clampV26(input.level, 0, 1);
    if (this.lastLevelMs !== null && input.atMs > this.lastLevelMs) {
      const dt = input.atMs - this.lastLevelMs;
      this.peak = Math.max(0, this.peak - this.opts.peakDecayPerMs * dt);
    }
    this.smoothed = this.smoothed * (1 - this.opts.levelSmoothing) + level * this.opts.levelSmoothing;
    this.peak = Math.max(this.peak, level);
    this.lastLevelMs = input.atMs;
    const sample: VoiceV26LevelSample = {
      atMs: input.atMs,
      level: round2V26(level),
      smoothed: round2V26(this.smoothed),
      peak: round2V26(this.peak),
      speaking: input.speaking,
    };
    this.levels.push(sample);
    if (this.levels.length > this.opts.maxSamples) this.levels.shift();
    if (this.snapshot) {
      this.snapshot = { ...this.snapshot, level: { ...sample }, updatedAtMs: input.atMs };
    }
    return sample;
  }

  /** Level history (newest last). */
  levelsList(): VoiceV26LevelSample[] {
    return this.levels.map((l) => ({ ...l }));
  }

  /** Current level (null until the first sample). */
  currentLevel(): VoiceV26LevelSample | null {
    const last = this.levels[this.levels.length - 1];
    return last ? { ...last } : null;
  }

  /** Reset the meter (levels cleared, snapshot kept). */
  resetMeter(): void {
    this.levels.length = 0;
    this.smoothed = 0;
    this.peak = 0;
    this.lastLevelMs = null;
  }

  /** Render-ready rows for the panel (label key + value + tone). */
  rows(): VoiceV26PanelRow[] {
    const snap = this.snapshot;
    if (!snap) {
      return [{ labelKey: 'voice.v26.panel.noSession', value: this.sessionId, tone: 'warn' }];
    }
    const stateKey = `voice.v26.panel.${snap.state === 'degraded' ? 'degraded' : snap.floor}`;
    const rows: VoiceV26PanelRow[] = [
      { labelKey: 'voice.v26.panel.title', value: snap.sessionId, tone: 'ok' },
      { labelKey: stateKey, value: snap.floor, tone: snap.state === 'interrupted' ? 'bad' : 'ok' },
      {
        labelKey: snap.floorHolder === 'user'
          ? 'voice.v26.panel.floorUser'
          : snap.floorHolder === 'agent'
            ? 'voice.v26.panel.floorAgent'
            : 'voice.v26.panel.floorNone',
        value: snap.floorHolder,
        tone: 'ok',
      },
    ];
    const level = snap.level;
    rows.push({
      labelKey: 'voice.v26.panel.level',
      value: level ? `${Math.round(level.smoothed * 100)}% (peak ${Math.round(level.peak * 100)}%)` : '-',
      tone: 'ok',
    });
    rows.push({
      labelKey: 'voice.v26.panel.latency',
      value: snap.latencyMs === null
        ? '-'
        : `${formatDurationV26(snap.latencyMs)} / ${formatDurationV26(snap.budgetMs)}`,
      tone: snap.overBudget ? 'bad' : 'ok',
    });
    rows.push({
      labelKey: snap.overBudget ? 'voice.v26.panel.overBudget' : 'voice.v26.panel.withinBudget',
      value: snap.overBudget ? 'over' : 'within',
      tone: snap.overBudget ? 'bad' : 'ok',
    });
    rows.push({
      labelKey: 'voice.v26.panel.provider',
      value: snap.providerName ?? snap.providerId ?? '-',
      tone: 'ok',
    });
    rows.push({
      labelKey: 'voice.v26.panel.degraded',
      value: snap.degradedLevel,
      tone: snap.degradedLevel === 'off' ? 'ok' : snap.degradedLevel === 'light' ? 'warn' : 'bad',
    });
    rows.push({
      labelKey: 'voice.v26.panel.turn',
      value: snap.turnIndex === null ? '-' : `#${snap.turnIndex}`,
      tone: 'ok',
    });
    rows.push({
      labelKey: 'voice.v26.panel.bargeIns',
      value: String(snap.bargeIns),
      tone: snap.bargeIns > 0 ? 'warn' : 'ok',
    });
    return rows;
  }

  /**
   * The MCP Apps `ui://` resource descriptor for this panel.
   * The host renders the same snapshot as a panel or as a
   * `ui://voice-v26/status` resource; nothing here fetches or
   * embeds remote content.
   */
  uiResource(): VoiceV26UiResource | null {
    const snap = this.snapshot;
    if (!snap) return null;
    return {
      uri: `ui://voice-v26/status?session=${encodeURIComponent(this.sessionId)}`,
      mimeType: 'application/vnd.open-bot.voice-status+json',
      title: `Voice status — ${this.sessionId}`,
      description: 'Live voice status: floor state, audio level, latency vs budget, degraded mode, active provider.',
      kind: 'voice-status',
      version: 26,
      snapshot: { ...snap, level: snap.level ? { ...snap.level } : null },
      i18nKeys: [...VOICE_V26_PANEL_I18N_KEYS],
    };
  }

  /** Canonical `ui://` URI for this session (no snapshot needed). */
  uiUri(): string {
    return `ui://voice-v26/status?session=${encodeURIComponent(this.sessionId)}`;
  }

  summary(): string {
    const snap = this.snapshot;
    if (!snap) return `status v26 ${this.sessionId}: no snapshot yet`;
    return (
      `status v26 ${this.sessionId}: ${snap.state} (floor ${snap.floorHolder}), ` +
      `latency ${snap.latencyMs === null ? '-' : `${snap.latencyMs}ms`} / ${snap.budgetMs}ms` +
      `${snap.overBudget ? ' OVER BUDGET' : ''}, degraded ${snap.degradedLevel}, ` +
      `provider ${snap.providerName ?? '-'}, ${snap.bargeIns} barge-ins`
    );
  }

  markdown(): string {
    const snap = this.snapshot;
    if (!snap) {
      return `# Voice status v26\n\nSession: \`${this.sessionId}\`\n\nNo snapshot yet.`;
    }
    const lines = [
      '# Voice status v26',
      '',
      `Session: \`${snap.sessionId}\``,
      '',
      `- State: \`${snap.state}\` — floor \`${snap.floor}\` (${snap.floorHolder})`,
      `- Level: ${snap.level ? `${Math.round(snap.level.smoothed * 100)}% (peak ${Math.round(snap.level.peak * 100)}%)` : '-'}`,
      `- Latency: ${snap.latencyMs === null ? '-' : `${snap.latencyMs}ms`} / budget ${snap.budgetMs}ms${snap.overBudget ? ' — OVER BUDGET' : ''}`,
      `- Latency p50: ${snap.latencyP50Ms === null ? '-' : `${snap.latencyP50Ms}ms`}`,
      `- Degraded: \`${snap.degradedLevel}\``,
      `- Provider: ${snap.providerName ?? snap.providerId ?? '-'}`,
      `- Turn: ${snap.turnIndex === null ? '-' : `#${snap.turnIndex}`}`,
      `- Barge-ins: ${snap.bargeIns}`,
      `- Updated: ${snap.updatedAtMs}ms`,
      '',
      `UI resource: \`${this.uiUri()}\``,
    ];
    return lines.join('\n');
  }
}

/** Build a status snapshot from parts (for hosts without a session). */
export function buildStatusSnapshotV26(input: {
  sessionId: string;
  floor: VoiceV26FloorState;
  level?: VoiceV26LevelSample | null;
  latencyMs?: number | null;
  latencyP50Ms?: number | null;
  budgetMs: number;
  degradedLevel?: VoiceV26DegradedLevel;
  providerId?: string | null;
  providerName?: string | null;
  turnId?: string | null;
  turnIndex?: number | null;
  bargeIns?: number;
  turns?: number;
  atMs: number;
}): VoiceV26StatusSnapshot {
  const degraded = input.degradedLevel ?? 'off';
  const state: VoiceV26StatusState = statusStateForFloorV26(input.floor, degraded);
  return {
    sessionId: input.sessionId,
    state,
    floor: input.floor,
    floorHolder: floorHolderForStateV26(input.floor),
    level: input.level ?? null,
    latencyMs: input.latencyMs ?? null,
    latencyP50Ms: input.latencyP50Ms ?? null,
    budgetMs: input.budgetMs,
    overBudget: input.latencyMs !== null && input.latencyMs !== undefined && input.latencyMs > input.budgetMs,
    degradedLevel: degraded,
    providerId: input.providerId ?? null,
    providerName: input.providerName ?? null,
    turnId: input.turnId ?? null,
    turnIndex: input.turnIndex ?? null,
    bargeIns: input.bargeIns ?? 0,
    turns: input.turns ?? 0,
    updatedAtMs: input.atMs,
  };
}

/**
 * Turn panel for voice v25 (v1.38, Team T5).
 *
 * The v24 panel answers "what is this voice session doing
 * right now" for tool calls and models. The v25 panel
 * answers the same question for the *conversation flow*:
 *
 *   - live turn timers: one row per running turn with its
 *     elapsed time, current phase and threshold state, plus
 *     the finished-turn table (per-turn listen /
 *     silence-wait / think / speak durations, silence and
 *     tool time inside the turn);
 *   - turn-taking state: who holds the floor right now and
 *     which state the machine is in (idle / user-speaking /
 *     agent-thinking / ...), so a stuck floor is visible;
 *   - barge-ins: the interruptions that cut agent replies,
 *     with stop latency and resume strategy;
 *   - silence: gap counts, total / longest silence, and
 *     whether the floor is currently yielded;
 *   - provider latency: the p95 ranking from the latency
 *     tracker, slowest first, with slow/failing flags;
 *   - threshold alerts: slow-turn / long-silence /
 *     barge-in-burst alerts, newest first.
 *
 * The panel is a plain data holder + markdown renderer: it
 * never opens audio, never dials a network. All text goes
 * through the `voice.v25.panel.*` i18n keys listed below.
 */
import type { BargeInManagerV25, VoiceV25BargeInStats } from './bargeInV25';
import type { ProviderLatencyTrackerV25, VoiceV25ProviderLatencyRank } from './latencyProbeV25';
import type { SilenceDetectorV25, VoiceV25SilenceStats } from './silenceDetectionV25';
import type {
  TurnTimerRegistryV25,
  VoiceV25RunningTurn,
  VoiceV25SessionTurnStats,
} from './turnTimersV25';
import type { TurnTakingManagerV25 } from './turnTakingV25';
import {
  formatDurationV25,
  type VoiceV25FloorHolder,
  type VoiceV25TurnAlert,
  type VoiceV25TurnRecord,
  type VoiceV25TurnTakingState,
} from './types';

export const VOICE_V25_PANEL_I18N_KEYS = [
  'voice.v25.panel.title',
  'voice.v25.panel.turns',
  'voice.v25.panel.turn',
  'voice.v25.panel.role',
  'voice.v25.panel.started',
  'voice.v25.panel.elapsed',
  'voice.v25.panel.duration',
  'voice.v25.panel.status',
  'voice.v25.panel.phase',
  'voice.v25.panel.listening',
  'voice.v25.panel.silenceWait',
  'voice.v25.panel.thinking',
  'voice.v25.panel.speaking',
  'voice.v25.panel.interrupted',
  'voice.v25.panel.completed',
  'voice.v25.panel.abandoned',
  'voice.v25.panel.timeout',
  'voice.v25.panel.slow',
  'voice.v25.panel.noTurns',
  'voice.v25.panel.noRunning',
  'voice.v25.panel.alerts',
  'voice.v25.panel.noAlerts',
  'voice.v25.panel.floor',
  'voice.v25.panel.floorUser',
  'voice.v25.panel.floorAgent',
  'voice.v25.panel.floorNone',
  'voice.v25.panel.bargeIns',
  'voice.v25.panel.noBargeIns',
  'voice.v25.panel.stopLatency',
  'voice.v25.panel.resumeStrategy',
  'voice.v25.panel.silence',
  'voice.v25.panel.longestSilence',
  'voice.v25.panel.latency',
  'voice.v25.panel.noLatency',
  'voice.v25.panel.provider',
  'voice.v25.panel.p95',
  'voice.v25.panel.session',
  'voice.v25.panel.totalTime',
  'voice.v25.panel.mean',
  'voice.v25.panel.toolTime',
] as const;

export interface TurnPanelV25Options {
  /** Max alerts shown in the snapshot (default 20, newest first). */
  maxAlerts: number;
  /** Max barge-ins shown in the snapshot (default 20, newest first). */
  maxBargeIns: number;
  /** Max turn rows shown in the snapshot (default 50, newest first). */
  maxTurns: number;
}

export function defaultTurnPanelV25Options(): TurnPanelV25Options {
  return { maxAlerts: 20, maxBargeIns: 20, maxTurns: 50 };
}

export function validateTurnPanelV25Options(o: Partial<TurnPanelV25Options>): string[] {
  const errors: string[] = [];
  if (o.maxAlerts !== undefined && (!Number.isInteger(o.maxAlerts) || o.maxAlerts < 1 || o.maxAlerts > 200)) {
    errors.push('maxAlerts must be an integer 1..200');
  }
  if (o.maxBargeIns !== undefined && (!Number.isInteger(o.maxBargeIns) || o.maxBargeIns < 1 || o.maxBargeIns > 200)) {
    errors.push('maxBargeIns must be an integer 1..200');
  }
  if (o.maxTurns !== undefined && (!Number.isInteger(o.maxTurns) || o.maxTurns < 1 || o.maxTurns > 200)) {
    errors.push('maxTurns must be an integer 1..200');
  }
  return errors;
}

/** One finished-turn row in the panel table. */
export interface VoiceV25PanelTurnRow {
  turnId: string;
  index: number;
  role: 'user' | 'assistant';
  status: string;
  durationMs: number | null;
  listenMs: number;
  silenceWaitMs: number;
  thinkMs: number;
  speakMs: number;
  silenceMs: number;
  toolTimeMs: number;
  interrupted: boolean;
}

/** Full panel snapshot at one virtual time. */
export interface VoiceV25PanelSnapshot {
  sessionId: string;
  atMs: number;
  running: VoiceV25RunningTurn[];
  finished: VoiceV25PanelTurnRow[];
  totals: VoiceV25SessionTurnStats;
  alerts: VoiceV25TurnAlert[];
  floorHolder: VoiceV25FloorHolder;
  turnTakingState: VoiceV25TurnTakingState;
  bargeIns: ReturnType<BargeInManagerV25['list']>;
  bargeInStats: VoiceV25BargeInStats | null;
  silence: VoiceV25SilenceStats | null;
  latency: VoiceV25ProviderLatencyRank[];
  latencySummary: string;
}

export function createTurnPanelV25(opts: Partial<TurnPanelV25Options> = {}): TurnPanelV25 {
  return new TurnPanelV25(opts);
}

export class TurnPanelV25 {
  private readonly opts: TurnPanelV25Options;

  constructor(opts: Partial<TurnPanelV25Options> = {}) {
    const errors = validateTurnPanelV25Options(opts);
    if (errors.length > 0) {
      throw new Error(`Invalid TurnPanelV25 options: ${errors.join('; ')}`);
    }
    this.opts = { ...defaultTurnPanelV25Options(), ...opts };
  }

  options(): TurnPanelV25Options {
    return { ...this.opts };
  }

  snapshot(input: {
    sessionId: string;
    timers: TurnTimerRegistryV25;
    atMs: number;
    turnTaking?: TurnTakingManagerV25;
    bargeIn?: BargeInManagerV25;
    silence?: SilenceDetectorV25;
    latency?: ProviderLatencyTrackerV25;
  }): VoiceV25PanelSnapshot {
    const { sessionId, timers, atMs } = input;
    const totals = timers.sessionStats(sessionId);
    const timerAlerts = timers.alertsList(sessionId);
    const bargeInAlerts = input.bargeIn?.alertsList() ?? [];
    const alerts = [...timerAlerts, ...bargeInAlerts]
      .sort((a, b) => b.atMs - a.atMs)
      .slice(0, this.opts.maxAlerts);
    const finishedTurns = timers
      .list({ sessionId })
      .filter((t) => t.status !== 'active')
      .sort((a, b) => b.startedAtMs - a.startedAtMs)
      .slice(0, this.opts.maxTurns);
    const bargeIns = (input.bargeIn?.list() ?? [])
      .slice()
      .sort((a, b) => b.atMs - a.atMs)
      .slice(0, this.opts.maxBargeIns);
    return {
      sessionId,
      atMs,
      running: timers.running(sessionId, atMs),
      finished: finishedTurns.map((t) => this.rowOf(timers, t)),
      totals,
      alerts,
      floorHolder: input.turnTaking?.floorHolder() ?? 'none',
      turnTakingState: input.turnTaking?.stateOf() ?? 'idle',
      bargeIns,
      bargeInStats: input.bargeIn?.stats() ?? null,
      silence: input.silence?.stats(undefined, atMs) ?? null,
      latency: input.latency?.rankProviders(sessionId) ?? [],
      latencySummary: input.latency?.summary(sessionId) ?? 'No latency samples yet.',
    };
  }

  private rowOf(timers: TurnTimerRegistryV25, turn: VoiceV25TurnRecord): VoiceV25PanelTurnRow {
    return {
      turnId: turn.id,
      index: turn.index,
      role: turn.role,
      status: turn.status,
      durationMs: turn.durationMs,
      listenMs: timers.phaseMs(turn, 'listening'),
      silenceWaitMs: timers.phaseMs(turn, 'silence-wait'),
      thinkMs: timers.phaseMs(turn, 'thinking'),
      speakMs: timers.phaseMs(turn, 'speaking'),
      silenceMs: turn.silenceMs,
      toolTimeMs: timers.toolTimeForTurn(turn),
      interrupted: turn.status === 'interrupted',
    };
  }

  summary(snapshot: VoiceV25PanelSnapshot): string {
    const running = snapshot.running.length;
    const total = snapshot.totals.turns;
    return (
      `Session ${snapshot.sessionId}: ${total} turns ` +
      `(${running} running, ${formatDurationV25(snapshot.totals.totalMs)} total turn time, ` +
      `tool time ${formatDurationV25(snapshot.totals.toolTimeMs)}), ` +
      `floor ${snapshot.floorHolder} (${snapshot.turnTakingState}), ` +
      `${snapshot.bargeIns.length} barge-ins, ${snapshot.alerts.length} alerts.`
    );
  }

  markdown(snapshot: VoiceV25PanelSnapshot): string {
    const lines: string[] = [`# Voice v25 — session ${snapshot.sessionId}`, ''];
    lines.push(this.summary(snapshot));
    lines.push(`Floor: ${snapshot.floorHolder} · state: ${snapshot.turnTakingState} · latency: ${snapshot.latencySummary}`);
    lines.push('');
    lines.push('## Running turns');
    if (snapshot.running.length === 0) {
      lines.push('No turns running.');
    } else {
      lines.push('| Turn | Role | Phase | Elapsed | State |');
      lines.push('| ---: | --- | --- | ---: | --- |');
      for (const turn of snapshot.running) {
        const state = turn.overTimeout
          ? 'timeout'
          : turn.overSlowThreshold
            ? 'slow'
            : turn.bucket;
        lines.push(
          `| ${turn.record.index} | ${turn.record.role} | ${turn.phase} | ${formatDurationV25(turn.elapsedMs)} | ${state} |`,
        );
      }
    }
    lines.push('', '## Finished turns');
    if (snapshot.finished.length === 0) {
      lines.push('No finished turns yet.');
    } else {
      lines.push('| Turn | Role | Status | Duration | Listen | Silence-wait | Think | Speak | Silence | Tool time |');
      lines.push('| ---: | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
      for (const row of snapshot.finished) {
        lines.push(
          `| ${row.index} | ${row.role} | ${row.status} | ${row.durationMs === null ? '—' : formatDurationV25(row.durationMs)} | ` +
          `${formatDurationV25(row.listenMs)} | ${formatDurationV25(row.silenceWaitMs)} | ` +
          `${formatDurationV25(row.thinkMs)} | ${formatDurationV25(row.speakMs)} | ` +
          `${formatDurationV25(row.silenceMs)} | ${formatDurationV25(row.toolTimeMs)} |`,
        );
      }
    }
    if (snapshot.alerts.length > 0) {
      lines.push('', '## Alerts');
      for (const alert of snapshot.alerts) lines.push(`- [${alert.kind}] ${alert.message}`);
    }
    lines.push('', '## Barge-ins');
    if (snapshot.bargeIns.length === 0) {
      lines.push('No barge-ins yet.');
    } else {
      for (const b of snapshot.bargeIns) {
        lines.push(
          `- ${b.id}: turn ${b.turnIndex} cut at ${b.atMs}ms, agent spoke ${Math.round((b.agentSpokenChars / Math.max(1, b.agentPlannedChars)) * 100)}%, ` +
          `stop latency ${b.stopLatencyMs < 0 ? 'pending' : formatDurationV25(b.stopLatencyMs)}, strategy ${b.resumeStrategy}` +
          `${b.falsePositive ? ' (false positive)' : ''}.`,
        );
      }
    }
    if (snapshot.silence !== null) {
      lines.push('', '## Silence');
      lines.push(
        `${snapshot.silence.gaps} gaps, ${formatDurationV25(snapshot.silence.totalSilenceMs)} total, ` +
        `longest ${formatDurationV25(snapshot.silence.longestSilenceMs)}, ${snapshot.silence.yieldedGaps} yielded the floor, ` +
        `state ${snapshot.silence.state}.`,
      );
    }
    lines.push('', '## Provider latency');
    if (snapshot.latency.length === 0) {
      lines.push('No latency samples yet.');
    } else {
      lines.push('| Provider | p95 total | Mean total | Samples | State |');
      lines.push('| --- | ---: | ---: | ---: | --- |');
      for (const r of snapshot.latency) {
        const state = r.isFailing ? 'failing' : r.isSlow ? 'slow' : 'healthy';
        lines.push(
          `| ${r.providerId} | ${r.hasData ? formatDurationV25(r.p95TotalMs) : '—'} | ${formatDurationV25(r.meanTotalMs)} | ${r.samples} | ${state} |`,
        );
      }
    }
    return lines.join('\n');
  }
}

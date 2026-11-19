/**
 * Timer + provider panel for voice v24 (v1.37, Team T5).
 *
 * The v23 panel answered "is voice healthy?". The v24 panel
 * answers "what is this voice session doing right now, and
 * can I change its model?":
 *
 *   - live tool-call timers: one row per running call with
 *     its elapsed time and threshold state, plus the
 *     finished-call table (per-tool mean / p95 / max / slow
 *     count) and the session totals;
 *   - threshold alerts: slow / timeout / error-burst alerts
 *     raised by the timer registry, newest first;
 *   - dynamic providers: the catalogue snapshot at panel
 *     time — online first — with per-provider status and
 *     the current model highlighted, so the picker never
 *     shows a stale list;
 *   - model switches: the switch history of the session,
 *     with transcript-preservation on every entry;
 *   - provider health: the worst / mean health scores, so
 *     a flapping provider is visible next to its status.
 *
 * The panel is a plain data holder + markdown renderer: it
 * never opens audio, never dials a network. All text goes
 * through the `voice.v24.panel.*` i18n keys listed below.
 */
import type { DynamicProviderCatalogV24, VoiceV24ProviderSnapshot } from './providerCatalogV24';
import type { ProviderHealthTrackerV24, VoiceV24ProviderHealth } from './providerHealthV24';
import type { ToolCallTimerRegistryV24, VoiceV24SessionTimerStats } from './toolCallTimersV24';
import type { VoiceV24RunningCall } from './toolCallTimersV24';
import type { VoiceModelSwitcherV24 } from './modelSwitchV24';
import {
  formatDurationV24,
  type VoiceV24ModelSwitchEvent,
  type VoiceV24TimerAlert,
} from './types';

export const VOICE_V24_PANEL_I18N_KEYS = [
  'voice.v24.panel.title',
  'voice.v24.panel.timers',
  'voice.v24.panel.tool',
  'voice.v24.panel.started',
  'voice.v24.panel.elapsed',
  'voice.v24.panel.duration',
  'voice.v24.panel.status',
  'voice.v24.panel.running',
  'voice.v24.panel.completed',
  'voice.v24.panel.failed',
  'voice.v24.panel.cancelled',
  'voice.v24.panel.timeout',
  'voice.v24.panel.slow',
  'voice.v24.panel.noCalls',
  'voice.v24.panel.noRunning',
  'voice.v24.panel.alerts',
  'voice.v24.panel.noAlerts',
  'voice.v24.panel.providers',
  'voice.v24.panel.provider',
  'voice.v24.panel.model',
  'voice.v24.panel.currentModel',
  'voice.v24.panel.switchModel',
  'voice.v24.panel.switches',
  'voice.v24.panel.noSwitches',
  'voice.v24.panel.transcriptKept',
  'voice.v24.panel.health',
  'voice.v24.panel.session',
  'voice.v24.panel.totalTime',
  'voice.v24.panel.mean',
  'voice.v24.panel.p95',
  'voice.v24.panel.max',
] as const;

export interface TimerPanelV24Options {
  /** Max alerts shown in the snapshot (default 20, newest first). */
  maxAlerts: number;
  /** Max switch events shown in the snapshot (default 20, newest first). */
  maxSwitches: number;
}

export function defaultTimerPanelV24Options(): TimerPanelV24Options {
  return { maxAlerts: 20, maxSwitches: 20 };
}

export function validateTimerPanelV24Options(o: Partial<TimerPanelV24Options>): string[] {
  const errors: string[] = [];
  if (o.maxAlerts !== undefined && (!Number.isInteger(o.maxAlerts) || o.maxAlerts < 1 || o.maxAlerts > 200)) {
    errors.push('maxAlerts must be an integer 1..200');
  }
  if (o.maxSwitches !== undefined && (!Number.isInteger(o.maxSwitches) || o.maxSwitches < 1 || o.maxSwitches > 200)) {
    errors.push('maxSwitches must be an integer 1..200');
  }
  return errors;
}

/** One finished-call row in the panel table. */
export interface VoiceV24PanelToolRow {
  toolName: string;
  calls: number;
  meanMs: number;
  p95Ms: number;
  maxMs: number;
  slowCalls: number;
  failed: number;
}

/** Full panel snapshot at one virtual time. */
export interface VoiceV24PanelSnapshot {
  sessionId: string;
  atMs: number;
  running: VoiceV24RunningCall[];
  finished: VoiceV24PanelToolRow[];
  totals: VoiceV24SessionTimerStats;
  alerts: VoiceV24TimerAlert[];
  providers: VoiceV24ProviderSnapshot[];
  usableProviders: number;
  currentModel: { providerId: string; model: string } | null;
  switches: VoiceV24ModelSwitchEvent[];
  health: VoiceV24ProviderHealth[];
  meanHealth: number | null;
}

export function createTimerPanelV24(opts: Partial<TimerPanelV24Options> = {}): TimerPanelV24 {
  return new TimerPanelV24(opts);
}

export class TimerPanelV24 {
  private readonly opts: TimerPanelV24Options;

  constructor(opts: Partial<TimerPanelV24Options> = {}) {
    const errors = validateTimerPanelV24Options(opts);
    if (errors.length > 0) {
      throw new Error(`Invalid TimerPanelV24 options: ${errors.join('; ')}`);
    }
    this.opts = { ...defaultTimerPanelV24Options(), ...opts };
  }

  options(): TimerPanelV24Options {
    return { ...this.opts };
  }

  snapshot(input: {
    sessionId: string;
    timers: ToolCallTimerRegistryV24;
    catalog: DynamicProviderCatalogV24;
    atMs: number;
    switcher?: VoiceModelSwitcherV24;
    health?: ProviderHealthTrackerV24;
  }): VoiceV24PanelSnapshot {
    const { sessionId, timers, catalog, atMs } = input;
    const totals = timers.sessionStats(sessionId);
    const alerts = timers
      .alertsList(sessionId)
      .sort((a, b) => b.atMs - a.atMs)
      .slice(0, this.opts.maxAlerts);
    const switches = (input.switcher?.historyList() ?? [])
      .slice()
      .sort((a, b) => b.atMs - a.atMs)
      .slice(0, this.opts.maxSwitches);
    const health = input.health?.allScores(atMs) ?? [];
    return {
      sessionId,
      atMs,
      running: timers.running(sessionId, atMs),
      finished: totals.byTool.map((t) => ({
        toolName: t.toolName,
        calls: t.calls,
        meanMs: t.meanMs,
        p95Ms: t.p95Ms,
        maxMs: t.maxMs,
        slowCalls: t.slowCalls,
        failed: t.failed,
      })),
      totals,
      alerts,
      providers: catalog.list(atMs),
      usableProviders: catalog.usable(atMs).length,
      currentModel: input.switcher ? input.switcher.currentModel() : null,
      switches,
      health,
      meanHealth: input.health?.meanScore(atMs) ?? null,
    };
  }

  summary(snapshot: VoiceV24PanelSnapshot): string {
    const running = snapshot.running.length;
    const total = snapshot.totals.calls;
    const model = snapshot.currentModel
      ? `${snapshot.currentModel.providerId}/${snapshot.currentModel.model}`
      : 'no model';
    return (
      `Session ${snapshot.sessionId}: model ${model}, ${total} tool calls ` +
      `(${running} running, ${formatDurationV24(snapshot.totals.totalMs)} total tool time), ` +
      `${snapshot.alerts.length} alerts, ${snapshot.providers.length} providers ` +
      `(${snapshot.usableProviders} usable), ${snapshot.switches.length} model switches.`
    );
  }

  markdown(snapshot: VoiceV24PanelSnapshot): string {
    const lines: string[] = [`# Voice v24 — session ${snapshot.sessionId}`, ''];
    lines.push(this.summary(snapshot));
    lines.push('');
    lines.push('## Running tool calls');
    if (snapshot.running.length === 0) {
      lines.push('No tool calls running.');
    } else {
      lines.push('| Tool | Elapsed | State |');
      lines.push('| --- | ---: | --- |');
      for (const call of snapshot.running) {
        const state = call.overTimeout
          ? 'timeout'
          : call.overSlowThreshold
            ? 'slow'
            : call.bucket;
        lines.push(`| ${call.record.toolName} | ${formatDurationV24(call.elapsedMs)} | ${state} |`);
      }
    }
    lines.push('', '## Finished tool calls');
    if (snapshot.finished.length === 0) {
      lines.push('No finished tool calls yet.');
    } else {
      lines.push('| Tool | Calls | Mean | p95 | Max | Slow | Failed |');
      lines.push('| --- | ---: | ---: | ---: | ---: | ---: | ---: |');
      for (const row of snapshot.finished) {
        lines.push(
          `| ${row.toolName} | ${row.calls} | ${formatDurationV24(row.meanMs)} | ${formatDurationV24(row.p95Ms)} | ${formatDurationV24(row.maxMs)} | ${row.slowCalls} | ${row.failed} |`,
        );
      }
    }
    if (snapshot.alerts.length > 0) {
      lines.push('', '## Alerts');
      for (const alert of snapshot.alerts) lines.push(`- [${alert.kind}] ${alert.message}`);
    }
    lines.push('', '## Providers (dynamic, at panel time)');
    if (snapshot.providers.length === 0) {
      lines.push('No providers registered yet.');
    } else {
      lines.push('| Provider | Kind | Status | Models |');
      lines.push('| --- | --- | --- | ---: |');
      for (const provider of snapshot.providers) {
        const current =
          snapshot.currentModel !== null && snapshot.currentModel.providerId === provider.id
            ? ' (current)'
            : '';
        lines.push(
          `| ${provider.label}${current} | ${provider.kind} | ${provider.status} | ${provider.models.length} |`,
        );
      }
    }
    if (snapshot.switches.length > 0) {
      lines.push('', '## Model switches');
      for (const event of snapshot.switches) {
        lines.push(
          `- ${event.from.providerId}/${event.from.model} -> ${event.to.providerId}/${event.to.model} at ${event.atMs}ms, ${event.transcriptTurns} turns kept${event.rolledBack ? ' (rolled back)' : ''}.`,
        );
      }
    }
    if (snapshot.health.length > 0) {
      lines.push('', '## Provider health');
      for (const h of snapshot.health) {
        lines.push(
          `- ${h.providerId}: score ${h.score} (grade ${h.grade}), success ${(h.successRate * 100).toFixed(0)}%, mean latency ${h.meanLatencyMs}ms${h.degraded ? ', DEGRADED' : ''}.`,
        );
      }
    }
    return lines.join('\n');
  }
}

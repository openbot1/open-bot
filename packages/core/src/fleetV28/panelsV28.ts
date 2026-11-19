/**
 * Panels v28 — view-models for the fleet v28 UI (v1.41, Team T6).
 *
 * Pure view-models: each builder takes the core stores and returns a
 * JSON-able snapshot the desktop panels render. No React here, no
 * IPC here — the host builds these (via the v28 tools or directly)
 * and hands them to the panels. Follows `fleetV27/panelsV27.ts`.
 *
 * Safety rule (the v1.40 lesson): a panel NEVER carries a secret
 * value — the secrets panel carries names + metadata only. Budget
 * numbers are rounded for display; the raw meter keeps full
 * precision. Every string the panels build is English; the UI
 * renders through `fleet.v28.*` i18n keys.
 */

import {
  type FleetV28BudgetMeter,
  type FleetV28BudgetStore,
} from './budget';
import {
  breakdownFleetV28ByModel,
  computeFleetV28BurnRate,
  computeFleetV28CapRunways,
  forecastFleetV28Spend,
  type FleetV28BurnRate,
  type FleetV28CapRunway,
  type FleetV28Forecast,
  type FleetV28ModelBreakdownRow,
} from './forecast';
import { listFleetV28Presets, type FleetV28PresetStore } from './presets';
import {
  type ConversationRuntime,
  type FleetV28RuntimeStore,
} from './runtime';
import type { FleetV28SecretStore } from './secrets';

/** One runtime row in the runtime panel. */
export interface FleetV28RuntimeRow {
  /** Conversation id. */
  conversationId: string;
  /** Owning profile. */
  profileId: string;
  /** Bot id (empty when none). */
  botId: string;
  /** Lifecycle state. */
  state: ConversationRuntime['state'];
  /** Probe health. */
  health: ConversationRuntime['health'];
  /** CPU limit (cores). */
  cpuLimit: number;
  /** CPU used (cores). */
  cpuUsed: number;
  /** RAM limit (MiB). */
  ramLimitMB: number;
  /** RAM used (MiB). */
  ramUsedMB: number;
  /** Disk limit (MiB). */
  diskLimitMB: number;
  /** Disk used (MiB). */
  diskUsedMB: number;
  /** Resources over their limit. */
  overLimit: string[];
  /** Idle time, ms (null when not running). */
  idleMs: number | null;
  /** Idle timeout, ms. */
  idleTimeoutMs: number;
  /** Restart count. */
  restarts: number;
  /** Whether a state snapshot is saved. */
  hasSavedState: boolean;
}

/** The runtime panel view-model. */
export interface FleetV28RuntimePanel {
  /** One-line summary (English; UI uses i18n keys). */
  summary: string;
  /** Max runtimes running at once. */
  maxConcurrent: number;
  /** Currently running. */
  running: number;
  /** Waiting for a slot. */
  queued: number;
  /** Aggregate CPU used (cores). */
  totalCpuUsed: number;
  /** Aggregate RAM used (MiB). */
  totalRamUsedMB: number;
  /** Aggregate disk used (MiB). */
  totalDiskUsedMB: number;
  /** Runtime rows (running first). */
  runtimes: FleetV28RuntimeRow[];
  /** Waiting queue (conversation ids, head first). */
  queue: string[];
  /** Recent evictions (newest first, max 10). */
  recentEvictions: Array<{
    conversationId: string;
    profileId: string;
    evictedAtMs: number;
    idleMs: number;
    stateSaved: boolean;
  }>;
}

/** Build the runtime panel from the runtime store. */
export function buildFleetV28RuntimePanel(
  store: FleetV28RuntimeStore,
  nowMs: number = Date.now(),
): FleetV28RuntimePanel {
  const runtimes = store.listRuntimes();
  const agg = store.aggregateUsage();
  const rows: FleetV28RuntimeRow[] = runtimes.map((r) => ({
    conversationId: r.conversationId,
    profileId: r.profileId,
    botId: r.botId,
    state: r.state,
    health: r.health,
    cpuLimit: r.limits.cpuCores,
    cpuUsed: r.usage.cpuCores,
    ramLimitMB: r.limits.ramMB,
    ramUsedMB: r.usage.ramMB,
    diskLimitMB: r.limits.diskMB,
    diskUsedMB: r.usage.diskMB,
    overLimit: [...r.overLimit],
    idleMs: r.state === 'running' ? nowMs - r.lastActivityMs : null,
    idleTimeoutMs: r.limits.idleTimeoutMs,
    restarts: r.restarts,
    hasSavedState: r.savedState !== null,
  }));
  const evictions = store.listEvictions().slice(0, 10);
  return {
    summary: `Fleet v28 runtimes: ${agg.running} running, ${agg.queued} queued, ${rows.length} total (max ${store.getConfig().maxConcurrentRuntimes} concurrent).`,
    maxConcurrent: store.getConfig().maxConcurrentRuntimes,
    running: agg.running,
    queued: agg.queued,
    totalCpuUsed: agg.cpuCores,
    totalRamUsedMB: agg.ramMB,
    totalDiskUsedMB: agg.diskMB,
    runtimes: rows,
    queue: store.listQueue().map((q) => q.conversationId),
    recentEvictions: evictions.map((e) => ({
      conversationId: e.conversationId,
      profileId: e.profileId,
      evictedAtMs: e.evictedAtMs,
      idleMs: e.idleMs,
      stateSaved: e.stateSaved,
    })),
  };
}

/** One secret row (metadata only — never a value). */
export interface FleetV28SecretRow {
  /** Secret name. */
  name: string;
  /** Current version. */
  version: number;
  /** When first set. */
  createdAtMs: number;
  /** When last changed. */
  updatedAtMs: number;
  /** When last rotated (null = never). */
  rotatedAtMs: number | null;
  /** Whether a previous value is still inside its grace window. */
  hasGraceValue: boolean;
}

/** The secrets panel view-model (one profile; values never included). */
export interface FleetV28SecretsPanel {
  /** Owning profile. */
  profileId: string;
  /** One-line summary (English; UI uses i18n keys). */
  summary: string;
  /** Secret rows (by name). */
  secrets: FleetV28SecretRow[];
  /** Recent audit entries for the profile (newest first, max 10). */
  recentAudit: Array<{ name: string; action: string; version: number; atMs: number; note: string }>;
}

/** Build the secrets panel for one profile. */
export function buildFleetV28SecretsPanel(
  store: FleetV28SecretStore,
  profileId: string,
): FleetV28SecretsPanel {
  const secrets = store.listSecrets(profileId);
  return {
    profileId,
    summary: `Profile ${profileId}: ${secrets.length} secret(s).`,
    secrets: secrets.map((s) => ({
      name: s.name,
      version: s.version,
      createdAtMs: s.createdAtMs,
      updatedAtMs: s.updatedAtMs,
      rotatedAtMs: s.rotatedAtMs,
      hasGraceValue: s.hasGraceValue,
    })),
    recentAudit: store.listAudit(profileId).slice(0, 10).map((e) => ({
      name: e.name,
      action: e.action,
      version: e.version,
      atMs: e.atMs,
      note: e.note,
    })),
  };
}

/** One budget meter row in the budget panel. */
export interface FleetV28BudgetRow {
  /** Conversation id. */
  conversationId: string;
  /** Owning profile. */
  profileId: string;
  /** Model of the latest record. */
  model: string;
  /** Input tokens. */
  inputTokens: number;
  /** Output tokens. */
  outputTokens: number;
  /** Cost, USD. */
  costUsd: number;
  /** Hard cap, USD (null = no cap). */
  capUsd: number | null;
  /** Meter level. */
  level: FleetV28BudgetMeter['level'];
  /** Percent of the cap used (null = no cap). */
  percentUsed: number | null;
  /** Cost remaining (null = no cap). */
  remainingUsd: number | null;
  /** Whether any record used the fallback price. */
  hasUnpricedUsage: boolean;
  /** How many records the hard cap refused. */
  blockedRecords: number;
}

/** The budget panel view-model (meter + session cost + warnings). */
export interface FleetV28BudgetPanel {
  /** One-line summary (English; UI uses i18n keys). */
  summary: string;
  /** Total cost across listed meters, USD. */
  totalCostUsd: number;
  /** Total tokens across listed meters. */
  totalTokens: number;
  /** Meter rows (highest cost first). */
  meters: FleetV28BudgetRow[];
  /** Active alerts (meters at/over warn). */
  alerts: Array<{
    conversationId: string;
    profileId: string;
    level: string;
    costUsd: number;
    capUsd: number | null;
    percentUsed: number;
    message: string;
  }>;
  /** Daily report for today (UTC) — null when the store has no entries. */
  today: { totalCostUsd: number; totalTokens: number; records: number; conversations: number } | null;
}

/** Build the budget panel from the budget store (optional profile filter). */
export function buildFleetV28BudgetPanel(
  store: FleetV28BudgetStore,
  opts: { profileId?: string; nowMs?: number } = {},
): FleetV28BudgetPanel {
  const nowMs = opts.nowMs ?? Date.now();
  const meters = store.listMeters(opts.profileId);
  const alerts = store.listAlerts().filter((a) => !opts.profileId || a.profileId === opts.profileId);
  const totalCostUsd = Math.round(meters.reduce((sum, m) => sum + m.costUsd, 0) * 1e6) / 1e6;
  const totalTokens = meters.reduce((sum, m) => sum + m.inputTokens + m.outputTokens, 0);
  const day = new Date(nowMs).toISOString().slice(0, 10);
  const daily = store.dailyReport(day);
  return {
    summary: `Fleet v28 budget: $${totalCostUsd.toFixed(4)} across ${meters.length} conversation(s), ${alerts.length} alert(s).`,
    totalCostUsd,
    totalTokens,
    meters: meters.map((m) => ({
      conversationId: m.conversationId,
      profileId: m.profileId,
      model: m.model,
      inputTokens: m.inputTokens,
      outputTokens: m.outputTokens,
      costUsd: m.costUsd,
      capUsd: m.capUsd,
      level: m.level,
      percentUsed: m.percentUsed,
      remainingUsd: m.remainingUsd,
      hasUnpricedUsage: m.hasUnpricedUsage,
      blockedRecords: m.blockedRecords,
    })),
    alerts: alerts.map((a) => ({
      conversationId: a.conversationId,
      profileId: a.profileId,
      level: a.level,
      costUsd: a.costUsd,
      capUsd: a.capUsd,
      percentUsed: a.percentUsed,
      message: a.message,
    })),
    today:
      daily.records === 0
        ? null
        : {
            totalCostUsd: daily.totalCostUsd,
            totalTokens: daily.totalTokens,
            records: daily.records,
            conversations: daily.conversations,
          },
  };
}

/** One preset row in the presets panel. */
export interface FleetV28PresetRow {
  /** Preset name. */
  name: string;
  /** Label. */
  label: string;
  /** Description. */
  description: string;
  /** CPU cores. */
  cpuCores: number;
  /** RAM, MiB. */
  ramMB: number;
  /** Disk, MiB. */
  diskMB: number;
  /** Budget cap, USD (null = no cap). */
  capUsd: number | null;
}

/** The presets panel view-model. */
export interface FleetV28PresetsPanel {
  /** One-line summary. */
  summary: string;
  /** Built-in presets. */
  presets: FleetV28PresetRow[];
  /** The profile's current bundle (null when no profile given). */
  current: { presetName: string; cpuCores: number; ramMB: number; diskMB: number; capUsd: number | null } | null;
}

/** Build the presets panel (optionally resolved for one profile). */
export function buildFleetV28PresetsPanel(
  presets: FleetV28PresetStore,
  profileId?: string,
): FleetV28PresetsPanel {
  const rows: FleetV28PresetRow[] = listFleetV28Presets().map((p) => ({
    name: p.name,
    label: p.label,
    description: p.description,
    cpuCores: p.limits.cpuCores,
    ramMB: p.limits.ramMB,
    diskMB: p.limits.diskMB,
    capUsd: p.capUsd,
  }));
  const current = profileId
    ? (() => {
        const resolved = presets.resolveForProfile(profileId);
        return {
          presetName: resolved.preset.name,
          cpuCores: resolved.preset.limits.cpuCores,
          ramMB: resolved.preset.limits.ramMB,
          diskMB: resolved.preset.limits.diskMB,
          capUsd: resolved.preset.capUsd,
        };
      })()
    : null;
  return {
    summary: `Fleet v28 presets: ${rows.length} built-in preset(s)${current ? `; profile ${profileId} uses ${current.presetName}` : ''}.`,
    presets: rows,
    current,
  };
}

/** The combined fleet v28 dashboard. */
export interface FleetV28Dashboard {
  /** One-line summary (English; UI uses i18n keys). */
  summary: string;
  /** Runtime area. */
  runtimes: FleetV28RuntimePanel;
  /** Secrets area (null when no profile given — secrets are per-profile). */
  secrets: FleetV28SecretsPanel | null;
  /** Budget area. */
  budget: FleetV28BudgetPanel;
  /** Presets area. */
  presets: FleetV28PresetsPanel;
  /** Forecast area (null when no forecast window was given). */
  forecast: FleetV28ForecastPanel | null;
}

/** The forecast panel view-model (burn rate + projection + runway). */
export interface FleetV28ForecastPanel {
  /** One-line summary (English; UI uses i18n keys). */
  summary: string;
  /** Window start (UTC `YYYY-MM-DD`). */
  windowStart: string;
  /** Window end (UTC `YYYY-MM-DD`). */
  windowEnd: string;
  /** Horizon date (UTC `YYYY-MM-DD`). */
  horizon: string;
  /** Burn rate per profile (highest first). */
  burnRates: FleetV28BurnRate[];
  /** Forecast per profile (highest projected total first). */
  forecasts: FleetV28Forecast[];
  /** Cap runway per capped meter (shortest runway first). */
  runways: FleetV28CapRunway[];
  /** Per-model cost breakdown (highest first). */
  models: FleetV28ModelBreakdownRow[];
}

/** Build the forecast panel from the budget store over a window. */
export function buildFleetV28ForecastPanel(
  store: FleetV28BudgetStore,
  opts: { windowStart: string; windowEnd: string; horizon: string; profileId?: string },
): FleetV28ForecastPanel {
  const entries = store.listEntries(opts.profileId ? { profileId: opts.profileId } : {});
  const profiles = [...new Set(entries.map((e) => e.profileId))].sort();
  const burnRates = profiles.map((p) =>
    computeFleetV28BurnRate(p, entries.filter((e) => e.profileId === p), opts.windowStart, opts.windowEnd),
  );
  const forecasts = burnRates
    .map((r) => forecastFleetV28Spend(r, opts.horizon))
    .sort((a, b) => b.projectedTotalUsd - a.projectedTotalUsd);
  const runways = computeFleetV28CapRunways(store, opts.windowStart, opts.windowEnd).filter(
    (r) => !opts.profileId || store.getMeter(r.conversationId)?.profileId === opts.profileId,
  );
  const models = breakdownFleetV28ByModel(entries, opts.windowStart, opts.windowEnd);
  const totalProjected = Math.round(forecasts.reduce((s, f) => s + f.projectedTotalUsd, 0) * 1e6) / 1e6;
  return {
    summary: `Fleet v28 forecast to ${opts.horizon}: projected $${totalProjected.toFixed(4)} across ${profiles.length} profile(s), ${runways.length} capped meter(s).`,
    windowStart: opts.windowStart,
    windowEnd: opts.windowEnd,
    horizon: opts.horizon,
    burnRates: burnRates.sort((a, b) => b.costPerDayUsd - a.costPerDayUsd),
    forecasts,
    runways,
    models,
  };
}

/** Build the combined dashboard from all four stores. */
export function buildFleetV28Dashboard(input: {
  runtimes: FleetV28RuntimeStore;
  secrets: FleetV28SecretStore;
  budget: FleetV28BudgetStore;
  presets: FleetV28PresetStore;
  profileId?: string;
  nowMs?: number;
  forecastWindow?: { windowStart: string; windowEnd: string; horizon: string };
}): FleetV28Dashboard {
  const nowMs = input.nowMs ?? Date.now();
  const runtimes = buildFleetV28RuntimePanel(input.runtimes, nowMs);
  const budget = buildFleetV28BudgetPanel(input.budget, { profileId: input.profileId, nowMs });
  const secrets = input.profileId ? buildFleetV28SecretsPanel(input.secrets, input.profileId) : null;
  const presets = buildFleetV28PresetsPanel(input.presets, input.profileId);
  const forecast = input.forecastWindow
    ? buildFleetV28ForecastPanel(input.budget, { ...input.forecastWindow, profileId: input.profileId })
    : null;
  return {
    summary: `Fleet v28: ${runtimes.summary} ${budget.summary} ${presets.summary}`,
    runtimes,
    secrets,
    budget,
    presets,
    forecast,
  };
}

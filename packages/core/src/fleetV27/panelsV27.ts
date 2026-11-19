/**
 * Panels v27 — view-models for the fleet v27 UI (v1.40, Team T6).
 *
 * Pure view-models: each builder takes the core stores and returns a
 * JSON-able snapshot the desktop panels render. No React here, no
 * IPC here — the host builds these (via the v27 tools or directly)
 * and hands them to the panels. Follows `fleetV26/panelsV26.ts`.
 */

import {
  aggregateFleetV27Run,
  summarizeFleetV27Run,
  type FleetV27CampaignRun,
  type FleetV27CampaignStore,
  type FleetV27RunAggregate,
} from './campaigns';
import {
  FLEET_V27_TEMPLATES,
  listFleetV27Templates,
  suggestFleetV27Templates,
  type FleetV27AutomationStore,
  type FleetV27SuggestContext,
  type FleetV27TemplateSuggestion,
} from './templates';
import {
  checkFleetV27QuotaAlerts,
  type FleetV27QuotaAlert,
  type FleetV27QuotaStore,
} from './quotaV2';

/** One campaign row in the campaign panel. */
export interface FleetV27CampaignRow {
  /** Campaign id. */
  id: string;
  /** Campaign name. */
  name: string;
  /** Total bots in the campaign. */
  bots: number;
  /** Concurrency. */
  concurrency: number;
  /** Tags. */
  tags: string[];
  /** Latest run id (null = never ran). */
  latestRunId: string | null;
  /** Latest run status (null = never ran). */
  latestStatus: FleetV27CampaignRun['status'] | null;
  /** Latest run aggregate (null = never ran). */
  latestAggregate: FleetV27RunAggregate | null;
  /** One-line summary of the latest run (or 'never ran'). */
  summary: string;
}

/** The campaign panel view-model. */
export interface FleetV27CampaignPanel {
  /** One-line summary (English; UI uses i18n keys). */
  summary: string;
  /** Campaign rows (newest first). */
  campaigns: FleetV27CampaignRow[];
  /** Active runs (running/pending) with progress. */
  activeRuns: Array<{
    runId: string;
    campaignId: string;
    status: FleetV27CampaignRun['status'];
    aggregate: FleetV27RunAggregate;
    summary: string;
  }>;
  /** Finished runs (history, newest first, max 20). */
  finishedRuns: Array<{
    runId: string;
    campaignId: string;
    status: FleetV27CampaignRun['status'];
    aggregate: FleetV27RunAggregate;
    summary: string;
  }>;
}

/** Build the campaign panel from the campaign store. */
export function buildFleetV27CampaignPanel(store: FleetV27CampaignStore): FleetV27CampaignPanel {
  const campaigns = store.listCampaigns().slice().reverse();
  const rows: FleetV27CampaignRow[] = campaigns.map((c) => {
    const runs = store.listRuns(c.id);
    const latest = runs[0] ?? null;
    const aggregate = latest ? aggregateFleetV27Run(latest.entries) : null;
    return {
      id: c.id,
      name: c.name,
      bots: c.bots.length,
      concurrency: c.concurrency,
      tags: [...c.tags],
      latestRunId: latest ? latest.id : null,
      latestStatus: latest ? latest.status : null,
      latestAggregate: aggregate,
      summary: latest
        ? `${c.name}: ${latest.status} — ${summarizeFleetV27Run(aggregate as FleetV27RunAggregate)}`
        : `${c.name}: never ran (${c.bots.length} bot(s), concurrency ${c.concurrency})`,
    };
  });
  const allRuns = store.listRuns();
  const active = allRuns
    .filter((r) => r.status === 'running' || r.status === 'pending')
    .map((r) => ({
      runId: r.id,
      campaignId: r.campaignId,
      status: r.status,
      aggregate: aggregateFleetV27Run(r.entries),
      summary: store.summarizeRun(r.id) ?? r.id,
    }));
  const finished = store.listFinishedRuns().slice(0, 20).map((r) => ({
    runId: r.id,
    campaignId: r.campaignId,
    status: r.status,
    aggregate: aggregateFleetV27Run(r.entries),
    summary: store.summarizeRun(r.id) ?? r.id,
  }));
  return {
    summary: `${rows.length} campaign(s), ${active.length} active run(s), ${finished.length} finished run(s) in history.`,
    campaigns: rows,
    activeRuns: active,
    finishedRuns: finished,
  };
}

/** One automation row in the automation panel. */
export interface FleetV27AutomationRow {
  /** Automation id. */
  id: string;
  /** Automation name. */
  name: string;
  /** Template id. */
  templateId: string;
  /** Bot id. */
  botId: string;
  /** Schedule as entered. */
  cron: string;
  /** Enabled? */
  enabled: boolean;
  /** Next run (null = none). */
  nextRunAtMs: number | null;
  /** Last run (null = never). */
  lastRunAtMs: number | null;
  /** Run count. */
  runCount: number;
}

/** The automation template + schedule panel view-model. */
export interface FleetV27AutomationPanel {
  /** One-line summary. */
  summary: string;
  /** Built-in templates (id, name, category, default cron). */
  templates: Array<{ id: string; name: string; category: string; defaultCron: string; description: string }>;
  /** Automations created from templates. */
  automations: FleetV27AutomationRow[];
  /** Ranked suggestions for the current context. */
  suggestions: FleetV27TemplateSuggestion[];
  /** Automations due right now. */
  dueNow: string[];
}

/** Build the automation panel from the automation store + context. */
export function buildFleetV27AutomationPanel(
  store: FleetV27AutomationStore,
  ctx: FleetV27SuggestContext = {},
  nowMs: number = Date.now(),
): FleetV27AutomationPanel {
  const automations = store.listAutomations().map((a) => ({
    id: a.id,
    name: a.name,
    templateId: a.templateId,
    botId: a.botId,
    cron: a.cron,
    enabled: a.enabled,
    nextRunAtMs: a.nextRunAtMs,
    lastRunAtMs: a.lastRunAtMs,
    runCount: a.runCount,
  }));
  const suggestions = suggestFleetV27Templates(ctx, 5);
  return {
    summary: `${FLEET_V27_TEMPLATES.length} template(s), ${automations.length} automation(s) (${automations.filter((a) => a.enabled).length} enabled), ${store.dueAutomations(nowMs).length} due now.`,
    templates: listFleetV27Templates().map((t) => ({
      id: t.id,
      name: t.name,
      category: t.category,
      defaultCron: t.defaultCron,
      description: t.description,
    })),
    automations,
    suggestions,
    dueNow: store.dueAutomations(nowMs).map((a) => a.id),
  };
}

/** The quota panel view-model. */
export interface FleetV27QuotaPanel {
  /** One-line summary. */
  summary: string;
  /** Limits. */
  limits: ReturnType<FleetV27QuotaStore['getLimits']>;
  /** Live usage. */
  usage: ReturnType<FleetV27QuotaStore['getUsage']>;
  /** Per-resource alerts. */
  alerts: FleetV27QuotaAlert[];
  /** Worst alert level overall. */
  worstLevel: 'ok' | 'warn' | 'critical';
  /** Queued requests (head first). */
  queue: Array<{ id: string; kind: string; position: number; expiresAtMs: number }>;
  /** Recent decisions (newest first, max 10). */
  recentDecisions: Array<{ atMs: number; kind: string; decision: string; reasons: string[] }>;
}

/** Build the quota panel from the quota store. */
export function buildFleetV27QuotaPanel(store: FleetV27QuotaStore): FleetV27QuotaPanel {
  const alerts = store.alerts();
  const worstLevel = alerts.some((a) => a.level === 'critical')
    ? 'critical'
    : alerts.some((a) => a.level === 'warn')
      ? 'warn'
      : 'ok';
  return {
    summary: store.summarize(),
    limits: store.getLimits(),
    usage: store.getUsage(),
    alerts,
    worstLevel,
    queue: store.listQueue().map((q) => ({ id: q.id, kind: q.request.kind, position: q.position, expiresAtMs: q.expiresAtMs })),
    recentDecisions: store.getLedger().slice(-10).reverse().map((e) => ({
      atMs: e.atMs,
      kind: e.kind,
      decision: e.decision,
      reasons: [...e.reasons],
    })),
  };
}

/** The combined fleet v27 dashboard. */
export interface FleetV27Dashboard {
  /** One-line summary. */
  summary: string;
  /** Campaign area. */
  campaigns: FleetV27CampaignPanel;
  /** Automation area. */
  automations: FleetV27AutomationPanel;
  /** Quota area. */
  quota: FleetV27QuotaPanel;
}

/** Build the combined fleet v27 dashboard. */
export function buildFleetV27Dashboard(input: {
  campaigns: FleetV27CampaignStore;
  automations: FleetV27AutomationStore;
  quota: FleetV27QuotaStore;
  suggestContext?: FleetV27SuggestContext;
  nowMs?: number;
}): FleetV27Dashboard {
  const nowMs = input.nowMs ?? Date.now();
  const campaigns = buildFleetV27CampaignPanel(input.campaigns);
  const automations = buildFleetV27AutomationPanel(input.automations, input.suggestContext ?? {}, nowMs);
  const quota = buildFleetV27QuotaPanel(input.quota);
  return {
    summary: `Fleet v27: ${campaigns.summary} ${automations.summary} ${quota.summary}`,
    campaigns,
    automations,
    quota,
  };
}

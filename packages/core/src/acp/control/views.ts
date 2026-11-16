/**
 * IPC view shapes for the ACP Control Center (v1.12, Team T4).
 *
 * Plain-JSON mirrors of the core records, built for the desktop IPC
 * boundary (`acp-control:*` in apps/desktop/src/main/main.ts).
 * The renderer keeps its own mirror types in
 * apps/desktop/src/renderer/types.ts (same field names, `*View`
 * suffix) — the renderer never imports @open-bot/core, and preload
 * imports these core shapes. No secrets ever appear in a view:
 * budgets, token counts and login labels only.
 */

import type { AcpControlCenter } from './manager';
import type {
  AgentBudget,
  AgentUsageSummary,
  AgentUsageTurn,
  BudgetDimensionState,
  DiscoveredControlAgent,
  ManagedAgentView,
} from './types';

export interface AcpControlAgentSnapshot {
  id: string;
  backendId: string;
  name: string;
  command: string;
  args: string[];
  resolvedPath?: string;
  agentName?: string;
  agentVersion?: string;
  speaksAcp: boolean;
  loginLabel?: string;
  loginMethod?: string;
  loggedIn: boolean;
  enabled: boolean;
  status: string;
  budget: AgentBudget;
  createdAt: string;
  startedAt?: string;
  stoppedAt?: string;
  lastError?: string;
  restarts: number;
  today: AgentUsageSummary;
  total: AgentUsageSummary;
  dimensions: BudgetDimensionState[];
  blocked: boolean;
  warned: boolean;
  reasons: string[];
}

export interface AcpControlTurnSnapshot {
  id: string;
  agentId: string;
  sessionId: string;
  at: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
  durationMs: number;
  stopReason: string;
  status: string;
  toolCalls: number;
}

export interface AcpControlDiscoveredSnapshot {
  backendId: string;
  name: string;
  command: string;
  args: string[];
  resolvedPath?: string;
  installed: boolean;
  speaksAcp: boolean;
  agentName?: string;
  agentVersion?: string;
  loginLabel?: string;
  loginMethod?: string;
  loggedIn: boolean;
  verifiedInRepo: boolean;
  error?: string;
  alreadyRegistered: boolean;
}

export interface AcpControlSnapshot {
  agents: AcpControlAgentSnapshot[];
  today: AgentUsageSummary;
  total: AgentUsageSummary;
}

/** Per-day usage + recent budget alerts for one agent (IPC `acp-control:report`). */
export interface AcpControlReportSnapshot {
  agentId: string;
  days: Array<{ day: string; summary: AgentUsageSummary; blocked: boolean }>;
  total: AgentUsageSummary;
  alerts: Array<{ id: string; kind: string; reasons: string[]; day: string; at: string }>;
}

/** Build the per-day report for one agent (last `days` local days). */
export function buildAcpControlReport(center: AcpControlCenter, agentId: string, days = 7): AcpControlReportSnapshot {
  const report = center.usageReport(agentId, days);
  return {
    agentId,
    days: report.days.map((d) => ({ day: d.day, summary: { ...d.summary }, blocked: d.blocked })),
    total: { ...report.total },
    alerts: center.alertsFor(agentId, 10).map((a) => ({ id: a.id, kind: a.kind, reasons: [...a.reasons], day: a.day, at: a.at })),
  };
}

/** One managed-agent row for the UI (record + usage + budget evaluation). */
export function buildAcpControlAgentView(view: ManagedAgentView): AcpControlAgentSnapshot {
  const r = view.record;
  return {
    id: r.id,
    backendId: r.backendId,
    name: r.name,
    command: r.command,
    args: [...r.args],
    resolvedPath: r.resolvedPath,
    agentName: r.agentName,
    agentVersion: r.agentVersion,
    speaksAcp: r.speaksAcp,
    loginLabel: r.loginLabel,
    loginMethod: r.loginMethod,
    loggedIn: r.loggedIn,
    enabled: r.enabled,
    status: r.status,
    budget: { ...r.budget },
    createdAt: r.createdAt,
    startedAt: r.startedAt,
    stoppedAt: r.stoppedAt,
    lastError: r.lastError,
    restarts: r.restarts,
    today: { ...view.today },
    total: { ...view.total },
    dimensions: view.budget.dimensions.map((d) => ({ ...d })),
    blocked: view.budget.blocked,
    warned: view.budget.warned,
    reasons: [...view.budget.reasons],
  };
}

/** Whole-panel snapshot (all agents + center totals). */
export function buildAcpControlSnapshot(center: AcpControlCenter): AcpControlSnapshot {
  const totals = center.totals();
  return {
    agents: center.views().map(buildAcpControlAgentView),
    today: totals.today,
    total: totals.total,
  };
}

export function toAcpControlTurnView(turn: AgentUsageTurn): AcpControlTurnSnapshot {
  return {
    id: turn.id,
    agentId: turn.agentId,
    sessionId: turn.sessionId,
    at: turn.at,
    inputTokens: turn.inputTokens,
    outputTokens: turn.outputTokens,
    costUsd: turn.costUsd,
    durationMs: turn.durationMs,
    stopReason: turn.stopReason,
    status: turn.status,
    toolCalls: turn.toolCalls,
  };
}

export function toAcpControlDiscoveredView(found: DiscoveredControlAgent): AcpControlDiscoveredSnapshot {
  return {
    backendId: found.backendId,
    name: found.name,
    command: found.command,
    args: [...found.args],
    resolvedPath: found.resolvedPath,
    installed: found.installed,
    speaksAcp: found.speaksAcp,
    agentName: found.agentName,
    agentVersion: found.agentVersion,
    loginLabel: found.loginLabel,
    loginMethod: found.loginMethod,
    loggedIn: found.loggedIn,
    verifiedInRepo: found.verifiedInRepo,
    error: found.error,
    alreadyRegistered: found.alreadyRegistered,
  };
}

/**
 * Panels v26 — view-models for the fleet v26 UI (v1.39, Team T6).
 *
 * Follows the `fleetV25/panelsV25.ts` pattern: a pure module that
 * turns core state into JSON-able display data (rounded numbers,
 * one-line summaries) — it never renders and never reads i18n
 * directly (the UI uses the `fleet.v26.*` keys).
 *
 * The memory panel deserves a note: MemFS (memory v24, Team T1) owns
 * the tree, the evidence, and admission — this panel only PROJECTS
 * provider-supplied data into display rows (counts, depth, orphans).
 * The host passes the tree in as plain data (`FleetV26MemFsNode[]`);
 * nothing here reads a memory store, so the panel keeps working
 * whether memory v24 is wired or the host hands it a snapshot.
 *
 * The combined dashboard joins all nine v26 areas so the fleet page
 * can show the whole platform picture in one place. Panels are
 * progressive-disclosure friendly: each panel carries its own
 * summary + counts, so the UI can show the summary row first and
 * expand the detail on demand.
 */

import type { FleetV26AdmissionStore } from './admission';
import { summarizeFleetV26Admission } from './admission';
import type { FleetV26BotRegistry } from './bots';
import { summarizeFleetV26Bots } from './bots';
import type { FleetV26FleetHealth } from './health';
import { summarizeFleetV26Health } from './health';
import type { FleetV26HookRegistry } from './hooks';
import { summarizeFleetV26Hooks } from './hooks';
import type { FleetV26McpAppRegistry } from './mcpApps';
import { summarizeFleetV26McpApps } from './mcpApps';
import type { FleetV26PluginRegistry } from './plugins';
import { summarizeFleetV26Plugins } from './plugins';
import type { FleetV26ResourceAllocator } from './resources';
import { summarizeFleetV26Resources } from './resources';
import type { FleetV26SharedBlockRegistry } from './sharedBlocks';
import { summarizeFleetV26SharedBlocks } from './sharedBlocks';
import type { FleetV26SkillPack } from './skills';
import { summarizeFleetV26SkillPack } from './skills';

/** View-model: resources panel. */
export interface FleetV26ResourcesPanel {
  summary: string;
  cpuCores: number;
  totalRamMB: number;
  freeRamMB: number;
  totalDiskMB: number | null;
  reserveCpuCores: number;
  reserveRamMB: number;
  remainingCpuCores: number;
  remainingRamMB: number;
  remainingDiskMB: number | null;
  grantedBots: number;
  grantedCpuCores: number;
  grantedRamMB: number;
  grantedDiskMB: number;
  cpuUtilization: number;
  ramUtilization: number;
  diskUtilization: number | null;
  quotas: ReturnType<FleetV26ResourceAllocator['list']>;
}

/** Build the resources panel. */
export function buildFleetV26ResourcesPanel(alloc: FleetV26ResourceAllocator): FleetV26ResourcesPanel {
  const cap = alloc.getCapacity();
  const reserve = alloc.getReserve();
  const remaining = alloc.remaining();
  const granted = alloc.grantedTotals();
  const util = alloc.utilization();
  return {
    summary: summarizeFleetV26Resources(alloc),
    cpuCores: cap.cpuCores,
    totalRamMB: cap.totalRamMB,
    freeRamMB: cap.freeRamMB,
    totalDiskMB: cap.totalDiskMB,
    reserveCpuCores: reserve.cpuCores,
    reserveRamMB: reserve.ramMB,
    remainingCpuCores: remaining.cpuCores,
    remainingRamMB: remaining.ramMB,
    remainingDiskMB: remaining.diskMB,
    grantedBots: granted.bots,
    grantedCpuCores: granted.cpuCores,
    grantedRamMB: granted.ramMB,
    grantedDiskMB: granted.diskMB,
    cpuUtilization: util.cpu,
    ramUtilization: util.ram,
    diskUtilization: util.disk,
    quotas: alloc.list(),
  };
}

/** View-model: one bot row (display-safe). */
export interface FleetV26BotRow {
  id: string;
  name: string;
  state: string;
  ownerId: string | null;
  tags: string[];
  cpuCores: number | null;
  ramMB: number | null;
  diskMB: number | null;
  uptimeMs: number | null;
  lastHeartbeatMs: number | null;
  totalRestarts: number;
  restartsInWindow: number;
  lastError: string | null;
}

/** View-model: bots panel. */
export interface FleetV26BotsPanel {
  summary: string;
  counts: ReturnType<FleetV26BotRegistry['counts']>;
  bots: FleetV26BotRow[];
  running: FleetV26BotRow[];
  failed: FleetV26BotRow[];
  stale: FleetV26BotRow[];
}

/** Build the bots panel. */
export function buildFleetV26BotsPanel(reg: FleetV26BotRegistry, nowMs: number = Date.now()): FleetV26BotsPanel {
  const rows: FleetV26BotRow[] = reg.list().map((b) => ({
    id: b.spec.id,
    name: b.spec.name,
    state: b.state,
    ownerId: b.spec.ownerId,
    tags: [...b.spec.tags],
    cpuCores: b.quota ? b.quota.cpuCores : null,
    ramMB: b.quota ? b.quota.ramMB : null,
    diskMB: b.quota ? b.quota.diskMB : null,
    uptimeMs: reg.uptimeMs(b.spec.id, nowMs),
    lastHeartbeatMs: b.lastHeartbeatMs,
    totalRestarts: b.totalRestarts,
    restartsInWindow: b.restartsInWindow,
    lastError: b.lastError,
  }));
  const staleIds = new Set(reg.staleBots(nowMs).map((b) => b.spec.id));
  return {
    summary: summarizeFleetV26Bots(reg),
    counts: reg.counts(),
    bots: rows,
    running: rows.filter((r) => r.state === 'running'),
    failed: rows.filter((r) => r.state === 'failed'),
    stale: rows.filter((r) => staleIds.has(r.id)),
  };
}

/** View-model: health panel. */
export interface FleetV26HealthPanel {
  summary: string;
  health: FleetV26FleetHealth;
}

/** Build the health panel from an already-computed fleet health roll-up. */
export function buildFleetV26HealthPanel(health: FleetV26FleetHealth): FleetV26HealthPanel {
  return { summary: summarizeFleetV26Health(health), health };
}

/** View-model: shared-blocks panel. */
export interface FleetV26SharedBlockRow {
  id: string;
  title: string;
  version: number;
  attachedBotIds: string[];
  attachedCount: number;
  updatedByBotId: string;
  updatedAtMs: number;
  leased: boolean;
  leaseHolderBotId: string | null;
  historyLength: number;
  tags: string[];
}

/** View-model: shared-blocks panel. */
export interface FleetV26SharedBlocksPanel {
  summary: string;
  counts: ReturnType<FleetV26SharedBlockRegistry['counts']>;
  providerName: string | null;
  blocks: FleetV26SharedBlockRow[];
  leased: FleetV26SharedBlockRow[];
}

/** Build the shared-blocks panel. */
export function buildFleetV26SharedBlocksPanel(reg: FleetV26SharedBlockRegistry): FleetV26SharedBlocksPanel {
  const rows: FleetV26SharedBlockRow[] = reg.list().map((b) => ({
    id: b.id,
    title: b.title,
    version: b.version,
    attachedBotIds: [...b.attachedBotIds],
    attachedCount: b.attachedBotIds.length,
    updatedByBotId: b.updatedByBotId,
    updatedAtMs: b.updatedAtMs,
    leased: b.leaseHolderBotId !== null,
    leaseHolderBotId: b.leaseHolderBotId,
    historyLength: b.history.length,
    tags: [...b.tags],
  }));
  return {
    summary: summarizeFleetV26SharedBlocks(reg),
    counts: reg.counts(),
    providerName: reg.providerName(),
    blocks: rows,
    leased: rows.filter((r) => r.leased),
  };
}

/** View-model: skill-pack panel. */
export interface FleetV26SkillPackPanel {
  summary: string;
  counts: ReturnType<FleetV26SkillPack['counts']>;
  metadata: ReturnType<FleetV26SkillPack['listMetadata']>;
  loadedBodies: string[];
}

/** Build the skill-pack panel (metadata tier only — bodies stay lazy). */
export function buildFleetV26SkillPackPanel(pack: FleetV26SkillPack): FleetV26SkillPackPanel {
  return {
    summary: summarizeFleetV26SkillPack(pack),
    counts: pack.counts(),
    metadata: pack.listMetadata(),
    loadedBodies: pack.loadedBodyNames(),
  };
}

/** View-model: hooks panel. */
export interface FleetV26HooksPanel {
  summary: string;
  counts: ReturnType<FleetV26HookRegistry['counts']>;
  logCounts: ReturnType<FleetV26HookRegistry['logCounts']>;
  hooks: ReturnType<FleetV26HookRegistry['list']>;
  recentLog: ReturnType<FleetV26HookRegistry['recentLog']>;
}

/** Build the hooks panel. */
export function buildFleetV26HooksPanel(reg: FleetV26HookRegistry): FleetV26HooksPanel {
  return {
    summary: summarizeFleetV26Hooks(reg),
    counts: reg.counts(),
    logCounts: reg.logCounts(),
    hooks: reg.list(),
    recentLog: reg.recentLog(20),
  };
}

/** View-model: plugins panel. */
export interface FleetV26PluginsPanel {
  summary: string;
  counts: ReturnType<FleetV26PluginRegistry['counts']>;
  plugins: ReturnType<FleetV26PluginRegistry['list']>;
}

/** Build the plugins panel. */
export function buildFleetV26PluginsPanel(reg: FleetV26PluginRegistry): FleetV26PluginsPanel {
  return { summary: summarizeFleetV26Plugins(reg), counts: reg.counts(), plugins: reg.list() };
}

/** View-model: MCP Apps panel. */
export interface FleetV26McpAppRow {
  uri: string;
  serverId: string;
  toolName: string;
  title: string;
  declaredDomains: string[];
  allowedTools: string[];
  renderAllowed: boolean;
  renderReason: string;
  needsAsk: boolean;
  csp: string;
}

/** View-model: MCP Apps panel. */
export interface FleetV26McpAppsPanel {
  summary: string;
  counts: ReturnType<FleetV26McpAppRegistry['counts']>;
  settings: ReturnType<FleetV26McpAppRegistry['getSettings']>;
  apps: FleetV26McpAppRow[];
  needsAsk: FleetV26McpAppRow[];
}

/** Build the MCP Apps panel. */
export function buildFleetV26McpAppsPanel(reg: FleetV26McpAppRegistry): FleetV26McpAppsPanel {
  const settings = reg.getSettings();
  const apps: FleetV26McpAppRow[] = reg.list().map((r) => {
    const decision = reg.renderDecision(r.uri) ?? { allowed: false, reason: 'Unknown resource.', needsAsk: false };
    return {
      uri: r.uri,
      serverId: r.serverId,
      toolName: r.toolName,
      title: r.title,
      declaredDomains: [...r.declaredDomains],
      allowedTools: [...r.allowedTools],
      renderAllowed: decision.allowed,
      renderReason: decision.reason,
      needsAsk: decision.needsAsk,
      csp: reg.cspFor(r.uri) ?? '',
    };
  });
  return {
    summary: summarizeFleetV26McpApps(reg),
    counts: reg.counts(),
    settings,
    apps,
    needsAsk: apps.filter((a) => a.needsAsk),
  };
}

/**
 * One MemFS tree node, as the host hands it to the panel (memory v24
 * owns the tree; this type is the projection contract, not a store).
 */
export interface FleetV26MemFsNode {
  id: string;
  name: string;
  kind: 'folder' | 'fact' | 'block';
  /** Parent id (null = tree root). */
  parentId: string | null;
  /** Child ids (folders/facts under this node). */
  children: string[];
  /** Evidence attached (source quote / link), if any. */
  evidence: string | null;
  /** Admission state of this node. */
  admission: 'admitted' | 'pending' | 'denied';
  updatedAtMs: number;
}

/** View-model: one MemFS row (flattened for the tree UI). */
export interface FleetV26MemFsRow {
  id: string;
  name: string;
  kind: FleetV26MemFsNode['kind'];
  depth: number;
  hasEvidence: boolean;
  admission: FleetV26MemFsNode['admission'];
  childrenCount: number;
}

/** View-model: memory panel (MemFS tree + evidence + admission). */
export interface FleetV26MemoryPanel {
  summary: string;
  nodes: number;
  folders: number;
  facts: number;
  blocks: number;
  withEvidence: number;
  withoutEvidence: number;
  admitted: number;
  pending: number;
  denied: number;
  maxDepth: number;
  /** Orphan facts: facts without evidence AND still pending. */
  orphans: FleetV26MemFsRow[];
  /** Flattened tree rows, depth-first (UI renders the indent). */
  rows: FleetV26MemFsRow[];
  admissionSummary: string;
}

/** Flatten a MemFS tree (depth-first, cycle-safe) into display rows. */
export function flattenFleetV26MemFs(nodes: FleetV26MemFsNode[]): FleetV26MemFsRow[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const rows: FleetV26MemFsRow[] = [];
  const visited = new Set<string>();
  const walk = (node: FleetV26MemFsNode, depth: number): void => {
    if (visited.has(node.id)) return; // cycle guard: a node renders once
    visited.add(node.id);
    rows.push({
      id: node.id,
      name: node.name,
      kind: node.kind,
      depth,
      hasEvidence: Boolean(node.evidence?.trim()),
      admission: node.admission,
      childrenCount: node.children.length,
    });
    for (const childId of node.children) {
      const child = byId.get(childId);
      if (child) walk(child, depth + 1);
    }
  };
  const roots = nodes.filter((n) => n.parentId === null || !byId.has(n.parentId));
  for (const r of roots) walk(r, 0);
  // Any node unreachable from a root (broken parent link) still renders, at depth 0.
  for (const n of nodes) if (!visited.has(n.id)) walk(n, 0);
  return rows;
}

/** Build the memory panel from a provider-supplied MemFS snapshot. */
export function buildFleetV26MemoryPanel(
  nodes: FleetV26MemFsNode[],
  admission: FleetV26AdmissionStore,
): FleetV26MemoryPanel {
  const rows = flattenFleetV26MemFs(nodes);
  const folders = rows.filter((r) => r.kind === 'folder').length;
  const facts = rows.filter((r) => r.kind === 'fact').length;
  const blocks = rows.filter((r) => r.kind === 'block').length;
  const withEvidence = rows.filter((r) => r.hasEvidence).length;
  const admitted = rows.filter((r) => r.admission === 'admitted').length;
  const pending = rows.filter((r) => r.admission === 'pending').length;
  const denied = rows.filter((r) => r.admission === 'denied').length;
  const maxDepth = rows.reduce((m, r) => Math.max(m, r.depth), 0);
  const orphans = rows.filter((r) => r.kind === 'fact' && !r.hasEvidence && r.admission === 'pending');
  const admissionSummary = summarizeFleetV26Admission(admission);
  return {
    summary:
      `MemFS: ${nodes.length} node(s) (${folders} folders, ${facts} facts, ${blocks} blocks), ` +
      `${withEvidence} with evidence, ${nodes.length - withEvidence} without; ` +
      `admission ${admitted} admitted / ${pending} pending / ${denied} denied; max depth ${maxDepth}`,
    nodes: nodes.length,
    folders,
    facts,
    blocks,
    withEvidence,
    withoutEvidence: nodes.length - withEvidence,
    admitted,
    pending,
    denied,
    maxDepth,
    orphans,
    rows,
    admissionSummary,
  };
}

/** View-model: settings panel (admission policy + MCP Apps settings). */
export interface FleetV26SettingsPanel {
  summary: string;
  admissionPolicy: ReturnType<FleetV26AdmissionStore['getPolicy']>;
  admissionCounts: ReturnType<FleetV26AdmissionStore['counts']>;
  mcpAppsSettings: ReturnType<FleetV26McpAppRegistry['getSettings']>;
}

/** Build the settings panel. */
export function buildFleetV26SettingsPanel(
  admission: FleetV26AdmissionStore,
  mcpApps: FleetV26McpAppRegistry,
): FleetV26SettingsPanel {
  return {
    summary:
      `${summarizeFleetV26Admission(admission)} — ${summarizeFleetV26McpApps(mcpApps)}`,
    admissionPolicy: admission.getPolicy(),
    admissionCounts: admission.counts(),
    mcpAppsSettings: mcpApps.getSettings(),
  };
}

/** Combined fleet v26 dashboard. */
export interface FleetV26Dashboard {
  summary: string;
  resources: FleetV26ResourcesPanel;
  bots: FleetV26BotsPanel;
  health: FleetV26HealthPanel;
  sharedBlocks: FleetV26SharedBlocksPanel;
  skills: FleetV26SkillPackPanel;
  hooks: FleetV26HooksPanel;
  plugins: FleetV26PluginsPanel;
  mcpApps: FleetV26McpAppsPanel;
  memory: FleetV26MemoryPanel;
  settings: FleetV26SettingsPanel;
}

/** Build the combined dashboard. */
export function buildFleetV26Dashboard(input: {
  allocator: FleetV26ResourceAllocator;
  bots: FleetV26BotRegistry;
  health: FleetV26FleetHealth;
  sharedBlocks: FleetV26SharedBlockRegistry;
  skills: FleetV26SkillPack;
  hooks: FleetV26HookRegistry;
  plugins: FleetV26PluginRegistry;
  mcpApps: FleetV26McpAppRegistry;
  memFsNodes: FleetV26MemFsNode[];
  admission: FleetV26AdmissionStore;
  nowMs?: number;
}): FleetV26Dashboard {
  const nowMs = input.nowMs ?? Date.now();
  const resources = buildFleetV26ResourcesPanel(input.allocator);
  const bots = buildFleetV26BotsPanel(input.bots, nowMs);
  const health = buildFleetV26HealthPanel(input.health);
  const sharedBlocks = buildFleetV26SharedBlocksPanel(input.sharedBlocks);
  const skills = buildFleetV26SkillPackPanel(input.skills);
  const hooks = buildFleetV26HooksPanel(input.hooks);
  const plugins = buildFleetV26PluginsPanel(input.plugins);
  const mcpApps = buildFleetV26McpAppsPanel(input.mcpApps);
  const memory = buildFleetV26MemoryPanel(input.memFsNodes, input.admission);
  const settings = buildFleetV26SettingsPanel(input.admission, input.mcpApps);
  return {
    summary:
      `${resources.summary} — ${bots.summary} — ${health.summary} — ` +
      `${sharedBlocks.summary} — ${skills.summary} — ${hooks.summary} — ` +
      `${plugins.summary} — ${mcpApps.summary} — ${memory.summary}`,
    resources,
    bots,
    health,
    sharedBlocks,
    skills,
    hooks,
    plugins,
    mcpApps,
    memory,
    settings,
  };
}

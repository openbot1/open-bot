/**
 * Panels v15 — view-model cho admin panels + audit log panel +
 * fleet v15 panel (v1.18, Đội T6).
 *
 * Theo pattern panels v14 (`fleetV14/panelsV14.ts`): panel RIÊNG,
 * không nhồi vào màn chat chính (progressive disclosure); module
 * này chỉ xây VIEW-MODEL thuần (dữ liệu đã lọc/sắp xếp + tóm tắt)
 * từ dữ liệu thật của các tầng dưới; component React ở
 * `apps/desktop/src/renderer/components/AdminPanelsV15.tsx` /
 * `AuditLogV15Panel.tsx` / `FleetV15Panel.tsx` render từ đó.
 *
 * LƯU Ý: các hệ thống v1.18 (memory v17, router v3, Composio v3,
 * voice v17) do các đội T1–T5 xây song song — module này KHÔNG
 * import code của họ (tránh phụ thuộc chéo giữa các worktree). Nó
 * định nghĩa input interface tối thiểu (dạng dữ liệu mà các đội đó
 * sẽ cung cấp qua IPC) và xây view-model từ đó; khi các đội gộp,
 * host chỉ cần map dữ liệu thật vào đúng interface này.
 *
 * - Memory v17 panel: temporal knowledge-graph (fact + cạnh
 *   before/after/supersedes), Mem0-style consolidation v3, fact
 *   validity + poisoning quarantine (nối tiếp v16).
 * - Router v3 panel: local-model router v3 (Ollama/LM Studio/
 *   llama.cpp auto-detect + fallback chain), Architect–Editor v3,
 *   repo map v5.
 * - Composio v3 panel: connections (toolkit, trạng thái, user-id
 *   đã cấu hình chưa), polling trigger v3, app integrations.
 * - Voice v17 panel: realtime v5 sessions, barge-in, TTS streaming
 *   v3, wake-word v5.
 * - Audit log panel: view-model cho trang audit (filter + phân
 *   trang + export) — xây trên `auditLogV15.ts`.
 * - Fleet v15 panel: health score, capacity forecast, rebalance,
 *   safe drain — xây trên `fleetV15.ts` + `multiUserV15.ts` /
 *   `rolloutV15.ts`.
 *
 * Tất cả hàm đều thuần, không đọc file, không chạm mạng. Dữ liệu
 * mock chỉ xuất hiện ở component demo — module này không chứa mock.
 */

import type { AuditEvent } from '../team/audit';
import type { ComposioV14TriggerCheckpoint } from '../fleetV14/composioPollingV14';
import { summarizeComposioV14Trigger } from '../fleetV14/composioPollingV14';
import type { FleetV14Snapshot } from '../fleetV14/fleetV14';
import { buildFleetV14CapacityReport, fleetV14NodeLoad } from '../fleetV14/fleetV14';
import type { TeamV14UserAuditEvent } from '../fleetV14/multiUserV14';
import type {
  AuditV15Filter,
  AuditV15Page,
  AuditV15Row,
} from './auditLogV15';
import {
  buildAuditV15Rows,
  filterAuditV15Rows,
  paginateAuditV15Rows,
  summarizeAuditV15Rows,
} from './auditLogV15';
import type {
  FleetV15CapacityForecast,
  FleetV15HealthScore,
  FleetV15RebalancePlan,
} from './fleetV15';
import { buildFleetV15Overview } from './fleetV15';
import type { TeamV15State } from './multiUserV15';
import { summarizeTeamV15User } from './multiUserV15';
import type { TeamV15Rollout } from './rolloutV15';
import { summarizeTeamV15Rollout } from './rolloutV15';

// ---------------------------------------------------------------------------
// Khung chung: trạng thái hệ thống + cấu hình cơ bản (admin panels)
// ---------------------------------------------------------------------------

/** Trạng thái của một hệ thống trong admin panel. */
export type FleetV15SystemStatus = 'ok' | 'degraded' | 'down' | 'not-configured' | 'disabled';

export const FLEET_V15_SYSTEM_STATUSES: readonly FleetV15SystemStatus[] = [
  'ok',
  'degraded',
  'down',
  'not-configured',
  'disabled',
];

/** Một dòng cấu hình cơ bản của hệ thống (toggle / số / chuỗi). */
export interface FleetV15AdminConfigRow {
  key: string;
  /** Hệ thống: 'memory' | 'router' | 'composio' | 'voice' | 'fleet' | 'multi-user' | 'rollout'. */
  group: string;
  kind: 'toggle' | 'number' | 'text';
  labelKey: string;
  boolValue: boolean;
  numberValue: number;
  textValue: string;
  hintKey: string;
}

/** Validate một giá trị cấu hình mới (trả lý do, '' = hợp lệ). */
export function validateFleetV15AdminConfigValue(
  row: FleetV15AdminConfigRow,
  next: { boolValue?: boolean; numberValue?: number; textValue?: string },
): string {
  if (row.kind === 'toggle' && typeof next.boolValue !== 'boolean') return 'toggle needs a boolean value';
  if (row.kind === 'number') {
    if (typeof next.numberValue !== 'number' || !Number.isFinite(next.numberValue)) {
      return 'number setting needs a finite number';
    }
    if (next.numberValue < 0) return 'number setting must be >= 0';
  }
  if (row.kind === 'text' && typeof next.textValue !== 'string') return 'text setting needs a string';
  return '';
}

/** Áp dụng một giá trị cấu hình mới (trả danh sách mới; không đổi khi lỗi). */
export function applyFleetV15AdminConfig(
  settings: readonly FleetV15AdminConfigRow[],
  key: string,
  next: { boolValue?: boolean; numberValue?: number; textValue?: string },
): { settings: FleetV15AdminConfigRow[]; ok: boolean; reason: string } {
  const row = settings.find((s) => s.key === key);
  if (!row) return { settings: [...settings], ok: false, reason: `unknown setting: ${key}` };
  const problem = validateFleetV15AdminConfigValue(row, next);
  if (problem !== '') return { settings: [...settings], ok: false, reason: problem };
  const updated = settings.map((s) => {
    if (s.key !== key) return s;
    return {
      ...s,
      boolValue: next.boolValue ?? s.boolValue,
      numberValue: next.numberValue ?? s.numberValue,
      textValue: next.textValue ?? s.textValue,
    };
  });
  return { settings: updated, ok: true, reason: '' };
}

/** Cài đặt mặc định v15 cho các hệ thống mới (label/hint key ở i18n `adminV15.*`). */
export function defaultFleetV15AdminSettings(): FleetV15AdminConfigRow[] {
  return [
    { key: 'memory.temporalKg', group: 'memory', kind: 'toggle', labelKey: 'adminV15.memoryTemporalKg', boolValue: true, numberValue: 0, textValue: '', hintKey: 'adminV15.memoryTemporalKgHint' },
    { key: 'memory.consolidationV3', group: 'memory', kind: 'toggle', labelKey: 'adminV15.memoryConsolidation', boolValue: true, numberValue: 0, textValue: '', hintKey: 'adminV15.memoryConsolidationHint' },
    { key: 'memory.validityWindowDays', group: 'memory', kind: 'number', labelKey: 'adminV15.memoryValidity', boolValue: false, numberValue: 90, textValue: '', hintKey: 'adminV15.memoryValidityHint' },
    { key: 'router.localFallback', group: 'router', kind: 'toggle', labelKey: 'adminV15.routerFallback', boolValue: true, numberValue: 0, textValue: '', hintKey: 'adminV15.routerFallbackHint' },
    { key: 'router.maxLocalModels', group: 'router', kind: 'number', labelKey: 'adminV15.routerMaxLocal', boolValue: false, numberValue: 10, textValue: '', hintKey: 'adminV15.routerMaxLocalHint' },
    { key: 'router.architectEditorV3', group: 'router', kind: 'toggle', labelKey: 'adminV15.routerArchitect', boolValue: true, numberValue: 0, textValue: '', hintKey: 'adminV15.routerArchitectHint' },
    { key: 'composio.userIdConfigured', group: 'composio', kind: 'toggle', labelKey: 'adminV15.composioUserId', boolValue: false, numberValue: 0, textValue: '', hintKey: 'adminV15.composioUserIdHint' },
    { key: 'composio.pollBaseIntervalMs', group: 'composio', kind: 'number', labelKey: 'adminV15.composioPollInterval', boolValue: false, numberValue: 60000, textValue: '', hintKey: 'adminV15.composioPollIntervalHint' },
    { key: 'composio.maxTriggers', group: 'composio', kind: 'number', labelKey: 'adminV15.composioMaxTriggers', boolValue: false, numberValue: 200, textValue: '', hintKey: 'adminV15.composioMaxTriggersHint' },
    { key: 'voice.realtimeV5', group: 'voice', kind: 'toggle', labelKey: 'adminV15.voiceRealtime', boolValue: true, numberValue: 0, textValue: '', hintKey: 'adminV15.voiceRealtimeHint' },
    { key: 'voice.wakeWordV5', group: 'voice', kind: 'toggle', labelKey: 'adminV15.voiceWakeWord', boolValue: false, numberValue: 0, textValue: '', hintKey: 'adminV15.voiceWakeWordHint' },
    { key: 'voice.ttsStreamingV3', group: 'voice', kind: 'toggle', labelKey: 'adminV15.voiceTts', boolValue: true, numberValue: 0, textValue: '', hintKey: 'adminV15.voiceTtsHint' },
    { key: 'fleet.healthScoring', group: 'fleet', kind: 'toggle', labelKey: 'adminV15.fleetHealthScoring', boolValue: true, numberValue: 0, textValue: '', hintKey: 'adminV15.fleetHealthScoringHint' },
    { key: 'fleet.rebalanceMaxLoad', group: 'fleet', kind: 'number', labelKey: 'adminV15.fleetRebalanceMaxLoad', boolValue: false, numberValue: 70, textValue: '', hintKey: 'adminV15.fleetRebalanceMaxLoadHint' },
    { key: 'fleet.safeDrainHeadroomPct', group: 'fleet', kind: 'number', labelKey: 'adminV15.fleetDrainHeadroom', boolValue: false, numberValue: 15, textValue: '', hintKey: 'adminV15.fleetDrainHeadroomHint' },
    { key: 'multi-user.sessionTtlHours', group: 'multi-user', kind: 'number', labelKey: 'adminV15.sessionTtl', boolValue: false, numberValue: 8, textValue: '', hintKey: 'adminV15.sessionTtlHint' },
    { key: 'rollout.defaultApprovals', group: 'rollout', kind: 'number', labelKey: 'adminV15.rolloutApprovals', boolValue: false, numberValue: 2, textValue: '', hintKey: 'adminV15.rolloutApprovalsHint' },
  ];
}

/** Lọc cài đặt theo nhóm hệ thống. */
export function fleetV15AdminSettingsByGroup(
  settings: readonly FleetV15AdminConfigRow[],
  group: string,
): FleetV15AdminConfigRow[] {
  return settings.filter((s) => s.group === group);
}

// ---------------------------------------------------------------------------
// Memory v17 admin panel (temporal KG + consolidation v3)
// ---------------------------------------------------------------------------

/** Một cạnh trong temporal knowledge-graph (fact A quan hệ fact B). */
export interface FleetV15TemporalEdge {
  edgeId: string;
  fromFactId: string;
  toFactId: string;
  /** 'before' | 'after' | 'supersedes' | 'caused-by' | 'related'. */
  relation: string;
  confidence: number;
  createdAt: number;
}

/** Một fact memory v17 (nối tiếp v16 + thêm temporal). */
export interface FleetV15MemoryFact {
  id: string;
  text: string;
  confidence: number;
  source: string;
  createdBy: string;
  createdAt: number;
  validUntil: number;
  supersededBy: string;
  quarantined: boolean;
  quarantineReason: string;
  entities: string[];
}

/** Một lần chạy consolidation v3 (Mem0-style + temporal). */
export interface FleetV15ConsolidationRun {
  runId: string;
  at: number;
  added: number;
  updated: number;
  deleted: number;
  dropped: number;
  entitiesLinked: number;
  quarantined: number;
  /** Số cạnh temporal tạo mới trong lần chạy. */
  temporalEdgesCreated: number;
  durationMs: number;
}

/** View-model panel Memory v17. */
export interface FleetV15MemoryPanel {
  status: FleetV15SystemStatus;
  facts: { id: string; text: string; confidence: number; source: string; status: string; createdAt: number }[];
  totalFacts: number;
  activeCount: number;
  expiredCount: number;
  supersededCount: number;
  quarantinedCount: number;
  edges: FleetV15TemporalEdge[];
  edgeCount: number;
  runs: FleetV15ConsolidationRun[];
  totalTemporalEdges: number;
  summary: string;
}

function fleetV15MemoryFactStatus(fact: FleetV15MemoryFact, now = Date.now()): string {
  if (fact.quarantined) return 'quarantined';
  if (fact.supersededBy !== '') return 'superseded';
  if (fact.validUntil > 0 && fact.validUntil <= now) return 'expired';
  return 'active';
}

export function buildFleetV15MemoryPanel(
  facts: readonly FleetV15MemoryFact[],
  edges: readonly FleetV15TemporalEdge[],
  runs: readonly FleetV15ConsolidationRun[],
  enabled: boolean,
  now = Date.now(),
): FleetV15MemoryPanel {
  const rows = facts
    .map((f) => ({
      id: f.id,
      text: f.text,
      confidence: f.confidence,
      source: f.source,
      status: fleetV15MemoryFactStatus(f, now),
      createdAt: f.createdAt,
    }))
    .sort((a, b) => b.createdAt - a.createdAt);
  const count = (status: string): number => rows.filter((r) => r.status === status).length;
  const totalEdges = runs.reduce((s, r) => s + r.temporalEdgesCreated, 0);
  const status: FleetV15SystemStatus = !enabled
    ? 'disabled'
    : count('quarantined') > 0
      ? 'degraded'
      : 'ok';
  return {
    status,
    facts: rows,
    totalFacts: rows.length,
    activeCount: count('active'),
    expiredCount: count('expired'),
    supersededCount: count('superseded'),
    quarantinedCount: count('quarantined'),
    edges: [...edges].sort((a, b) => b.createdAt - a.createdAt),
    edgeCount: edges.length,
    runs: [...runs].sort((a, b) => b.at - a.at),
    totalTemporalEdges: totalEdges,
    summary: `Memory v17: ${rows.length} facts (${count('active')} active, ${count('expired')} expired, ${count('superseded')} superseded, ${count('quarantined')} quarantined), ${edges.length} temporal edges (${totalEdges} created by consolidation), ${runs.length} consolidation runs.`,
  };
}

// ---------------------------------------------------------------------------
// Router v3 admin panel (local-model router + fallback chain)
// ---------------------------------------------------------------------------

/** Một nguồn model local v3 (Ollama / LM Studio / llama.cpp). */
export interface FleetV15LocalModelSource {
  sourceId: string;
  kind: string;
  endpoint: string;
  detected: boolean;
  modelCount: number;
  lastScanAt: number;
  error: string;
}

/** Một mắt xích trong fallback chain (model này lỗi → model sau). */
export interface FleetV15FallbackLink {
  fromModel: string;
  toModel: string;
  reason: string;
}

/** View-model panel Router v3. */
export interface FleetV15RouterPanel {
  status: FleetV15SystemStatus;
  sources: FleetV15LocalModelSource[];
  detectedSources: number;
  totalLocalModels: number;
  fallbackChain: FleetV15FallbackLink[];
  architectEditorPairs: number;
  totalRouted: number;
  repoMapFiles: number;
  repoMapCompressionPct: number;
  summary: string;
}

export function buildFleetV15RouterPanel(
  sources: readonly FleetV15LocalModelSource[],
  fallbackChain: readonly FleetV15FallbackLink[],
  architectEditorPairs: number,
  totalRouted: number,
  repoMapFiles: number,
  repoMapCompressionPct: number,
  enabled: boolean,
): FleetV15RouterPanel {
  const detected = sources.filter((s) => s.detected);
  const status: FleetV15SystemStatus = !enabled
    ? 'disabled'
    : detected.length === 0 && sources.length > 0
      ? 'degraded'
      : sources.some((s) => s.detected && s.error !== '')
        ? 'degraded'
        : 'ok';
  return {
    status,
    sources: [...sources].sort((a, b) => a.kind.localeCompare(b.kind)),
    detectedSources: detected.length,
    totalLocalModels: detected.reduce((s, x) => s + x.modelCount, 0),
    fallbackChain: [...fallbackChain],
    architectEditorPairs,
    totalRouted,
    repoMapFiles,
    repoMapCompressionPct,
    summary: `Router v3: ${detected.length}/${sources.length} local sources detected (${detected.reduce((s, x) => s + x.modelCount, 0)} local models), fallback chain ${fallbackChain.length} link(s), ${architectEditorPairs} Architect–Editor pairs (${totalRouted} tasks routed), repo map ${repoMapFiles} files, ${repoMapCompressionPct}% token compression.`,
  };
}

// ---------------------------------------------------------------------------
// Composio v3 admin panel (connections + polling)
// ---------------------------------------------------------------------------

/** Một connection Composio (toolkit + tài khoản đã nối). */
export interface FleetV15ComposioConnection {
  connectionId: string;
  toolkit: string;
  accountLabel: string;
  /** 'active' | 'inactive' | 'error'. */
  status: string;
  lastSyncAt: number;
  error: string;
}

/** View-model panel Composio v3. */
export interface FleetV15ComposioPanel {
  status: FleetV15SystemStatus;
  userIdConfigured: boolean;
  apiKeyConfigured: boolean;
  connections: FleetV15ComposioConnection[];
  activeConnections: number;
  triggers: { triggerId: string; toolkit: string; triggerSlug: string; status: string; currentIntervalMs: number; totalNewEvents: number; totalDuplicates: number; consecutiveErrors: number }[];
  totalNewEvents: number;
  totalDuplicates: number;
  summary: string;
}

export function buildFleetV15ComposioPanel(
  userIdConfigured: boolean,
  apiKeyConfigured: boolean,
  connections: readonly FleetV15ComposioConnection[],
  triggers: readonly ComposioV14TriggerCheckpoint[],
  now = Date.now(),
): FleetV15ComposioPanel {
  const active = connections.filter((c) => c.status === 'active');
  const status: FleetV15SystemStatus = !userIdConfigured || !apiKeyConfigured
    ? 'not-configured'
    : connections.some((c) => c.status === 'error')
      ? 'degraded'
      : 'ok';
  const triggerRows = triggers.map((t) => {
    const s = summarizeComposioV14Trigger(t, now);
    return {
      triggerId: s.triggerId,
      toolkit: s.toolkit,
      triggerSlug: s.triggerSlug,
      status: s.status,
      currentIntervalMs: s.currentIntervalMs,
      totalNewEvents: s.totalNewEvents,
      totalDuplicates: s.totalDuplicates,
      consecutiveErrors: s.consecutiveErrors,
    };
  });
  return {
    status,
    userIdConfigured,
    apiKeyConfigured,
    connections: [...connections].sort((a, b) => a.toolkit.localeCompare(b.toolkit)),
    activeConnections: active.length,
    triggers: triggerRows,
    totalNewEvents: triggerRows.reduce((s, t) => s + t.totalNewEvents, 0),
    totalDuplicates: triggerRows.reduce((s, t) => s + t.totalDuplicates, 0),
    summary: `Composio v3: ${active.length}/${connections.length} connections active (user id ${userIdConfigured ? 'configured' : 'missing'}, API key ${apiKeyConfigured ? 'configured' : 'missing'}), ${triggerRows.length} polling triggers, ${triggerRows.reduce((s, t) => s + t.totalNewEvents, 0)} new events, ${triggerRows.reduce((s, t) => s + t.totalDuplicates, 0)} duplicates.`,
  };
}

// ---------------------------------------------------------------------------
// Voice v17 admin panel (realtime v5 + TTS streaming v3 + wake-word v5)
// ---------------------------------------------------------------------------

/** Một phiên realtime v5. */
export interface FleetV15VoiceSession {
  sessionId: string;
  startedAt: number;
  endedAt: number;
  bargeIns: number;
  turnTakes: number;
  wakeWordHits: number;
  ttsOnTimeFraction: number;
  status: string;
}

/** View-model panel Voice v17. */
export interface FleetV15VoicePanel {
  status: FleetV15SystemStatus;
  sessions: FleetV15VoiceSession[];
  activeSessions: number;
  totalBargeIns: number;
  totalTurnTakes: number;
  totalWakeWordHits: number;
  avgTtsOnTime: number;
  wakeWordEnabled: boolean;
  summary: string;
}

export function buildFleetV15VoicePanel(
  sessions: readonly FleetV15VoiceSession[],
  wakeWordEnabled: boolean,
  realtimeEnabled: boolean,
): FleetV15VoicePanel {
  const sorted = [...sessions].sort((a, b) => b.startedAt - a.startedAt);
  const ended = sorted.filter((s) => s.status === 'ended');
  const status: FleetV15SystemStatus = !realtimeEnabled
    ? 'disabled'
    : sorted.some((s) => s.status === 'error')
      ? 'degraded'
      : 'ok';
  return {
    status,
    sessions: sorted,
    activeSessions: sorted.filter((s) => s.status === 'active').length,
    totalBargeIns: sorted.reduce((s, x) => s + x.bargeIns, 0),
    totalTurnTakes: sorted.reduce((s, x) => s + x.turnTakes, 0),
    totalWakeWordHits: sorted.reduce((s, x) => s + x.wakeWordHits, 0),
    avgTtsOnTime: ended.length > 0 ? ended.reduce((s, x) => s + x.ttsOnTimeFraction, 0) / ended.length : 0,
    wakeWordEnabled,
    summary: `Voice v17: ${sorted.length} realtime sessions (${sorted.filter((s) => s.status === 'active').length} active), ${sorted.reduce((s, x) => s + x.bargeIns, 0)} barge-ins, ${sorted.reduce((s, x) => s + x.turnTakes, 0)} turn-takes, ${sorted.reduce((s, x) => s + x.wakeWordHits, 0)} wake-word hits, TTS on-time ${ended.length > 0 ? Math.round((ended.reduce((s, x) => s + x.ttsOnTimeFraction, 0) / ended.length) * 100) : 0}%.`,
  };
}

// ---------------------------------------------------------------------------
// Admin panel gộp (4 hệ thống) + Audit log panel + Fleet v15 panel
// ---------------------------------------------------------------------------

/** View-model admin panel gộp: trạng thái 4 hệ thống + cài đặt. */
export interface FleetV15AdminPanel {
  memory: FleetV15MemoryPanel;
  router: FleetV15RouterPanel;
  composio: FleetV15ComposioPanel;
  voice: FleetV15VoicePanel;
  settings: FleetV15AdminConfigRow[];
  systemStatuses: { system: string; status: FleetV15SystemStatus }[];
  summary: string;
}

export function buildFleetV15AdminPanel(
  memory: FleetV15MemoryPanel,
  router: FleetV15RouterPanel,
  composio: FleetV15ComposioPanel,
  voice: FleetV15VoicePanel,
  settings: readonly FleetV15AdminConfigRow[] = defaultFleetV15AdminSettings(),
): FleetV15AdminPanel {
  const systemStatuses = [
    { system: 'memory', status: memory.status },
    { system: 'router', status: router.status },
    { system: 'composio', status: composio.status },
    { system: 'voice', status: voice.status },
  ];
  const bad = systemStatuses.filter((s) => s.status === 'down' || s.status === 'degraded').map((s) => s.system);
  return {
    memory,
    router,
    composio,
    voice,
    settings: [...settings],
    systemStatuses,
    summary: `Admin v15: memory ${memory.status}, router ${router.status}, Composio ${composio.status}, voice ${voice.status}` +
      (bad.length > 0 ? ` — attention needed: ${bad.join(', ')}` : ' — all systems nominal.'),
  };
}

/** View-model trang audit log (filter + phân trang + tóm tắt). */
export interface FleetV15AuditPanel {
  filter: AuditV15Filter;
  page: AuditV15Page;
  totalFiltered: number;
  byAction: Record<string, number>;
  bySource: Record<string, number>;
  userChainOk: boolean;
  userChainBadSeq: number;
  summary: string;
}

export function buildFleetV15AuditPanel(input: {
  userEvents: readonly TeamV14UserAuditEvent[];
  fleetEvents?: readonly AuditEvent[];
  teamEvents?: readonly AuditEvent[];
  userVerified?: boolean;
  fleetVerified?: boolean;
  teamVerified?: boolean;
  filter?: AuditV15Filter;
  page?: number;
  pageSize?: number;
}): FleetV15AuditPanel {
  const rows: AuditV15Row[] = buildAuditV15Rows({
    userEvents: input.userEvents,
    fleetEvents: input.fleetEvents,
    teamEvents: input.teamEvents,
    userVerified: input.userVerified,
    fleetVerified: input.fleetVerified,
    teamVerified: input.teamVerified,
  });
  const filter: AuditV15Filter = input.filter ?? {};
  const filtered = filterAuditV15Rows(rows, filter);
  const page = paginateAuditV15Rows(filtered, input.page ?? 1, input.pageSize ?? 50);
  const summary = summarizeAuditV15Rows(rows, input.userEvents);
  return {
    filter,
    page,
    totalFiltered: filtered.length,
    byAction: summary.byAction,
    bySource: summary.bySource,
    userChainOk: summary.userChain.ok,
    userChainBadSeq: summary.userChain.badSeq,
    summary: `Audit log: ${rows.length} events total (${filtered.length} after filter), page ${page.page}/${page.totalPages}; user hash chain ${summary.userChain.ok ? 'verified OK' : `BROKEN at seq ${summary.userChain.badSeq}`}.`,
  };
}

/** Một node trong panel Fleet v15 (điểm health + forecast). */
export interface FleetV15PanelNodeRow {
  nodeId: string;
  hostname: string;
  status: string;
  healthScore: number;
  healthGrade: string;
  healthTrend: string;
  load: number;
  runningTasks: number;
  maxTasks: number;
}

/** Một user trong panel Fleet v15 (quota v4 + session). */
export interface FleetV15PanelUserRow {
  userId: string;
  roleRef: string;
  tightestQuota: string;
  tightestFraction: number;
  activeSessions: number;
  switchCount: number;
}

/** Một rollout trong panel Fleet v15. */
export interface FleetV15PanelRolloutRow {
  id: string;
  feature: string;
  version: string;
  stage: string;
  stageLabel: string;
  percent: number;
  approvalsHave: number;
  approvalsNeed: number;
  targetedNodeCount: number;
  nodesOnNewVersion: number;
  autoAction: string;
}

/** View-model panel Fleet v15. */
export interface FleetV15Panel {
  nodes: FleetV15PanelNodeRow[];
  nodeCount: number;
  activeNodeCount: number;
  overloadedNodeIds: string[];
  capacitySummary: string;
  forecastSummary: string;
  tightestResource: string;
  daysUntilFirstFull: number | null;
  rebalanceMoves: { taskId: string; fromNodeId: string; toNodeId: string; reason: string }[];
  stillOverloaded: string[];
  users: FleetV15PanelUserRow[];
  rollouts: FleetV15PanelRolloutRow[];
  summary: string;
}

/** Xây view-model panel Fleet v15 từ snapshot + health score + forecast + rebalance + multi-user + rollout. */
export function buildFleetV15Panel(
  snapshot: FleetV14Snapshot,
  healthScores: readonly FleetV15HealthScore[],
  forecast: FleetV15CapacityForecast,
  rebalance: FleetV15RebalancePlan,
  quotaState: TeamV15State,
  users: readonly { id: string; roleRef: string }[],
  rollouts: readonly TeamV15Rollout[],
  now = Date.now(),
): FleetV15Panel {
  const report = buildFleetV14CapacityReport(snapshot);
  const scoreByNode = new Map(healthScores.map((h) => [h.nodeId, h]));
  const nodes: FleetV15PanelNodeRow[] = snapshot.nodes
    .filter((n) => n.status !== 'removed')
    .map((n) => {
      const h = scoreByNode.get(n.nodeId);
      return {
        nodeId: n.nodeId,
        hostname: n.hostname,
        status: n.status,
        healthScore: h ? h.score : -1,
        healthGrade: h ? h.grade : 'unknown',
        healthTrend: h ? h.trend : 'unknown',
        load: Math.round(fleetV14NodeLoad(n) * 1000) / 1000,
        runningTasks: n.runningTaskIds.length,
        maxTasks: n.capacity.maxTasks,
      };
    })
    .sort((a, b) => a.healthScore - b.healthScore);
  const userRows: FleetV15PanelUserRow[] = users.map((u) => {
    const s = summarizeTeamV15User(quotaState, u.id, u.roleRef, now);
    return {
      userId: u.id,
      roleRef: u.roleRef,
      tightestQuota: s.tightestQuota,
      tightestFraction: s.tightestFraction,
      activeSessions: s.activeSessions,
      switchCount: s.switchCount,
    };
  });
  const rolloutRows: FleetV15PanelRolloutRow[] = rollouts.map((r) => {
    const s = summarizeTeamV15Rollout(r, snapshot.nodes);
    return {
      id: r.v14.id,
      feature: r.v14.feature,
      version: r.v14.version,
      stage: r.v14.stage,
      stageLabel: s.stageLabel,
      percent: s.percent,
      approvalsHave: s.approvalsHave,
      approvalsNeed: s.approvalsNeed,
      targetedNodeCount: s.targetedNodeCount,
      nodesOnNewVersion: s.nodesOnNewVersion,
      autoAction: s.autoDecision.action,
    };
  });
  const overview = buildFleetV15Overview(snapshot, healthScores, forecast, rebalance);
  return {
    nodes,
    nodeCount: report.nodeCount,
    activeNodeCount: report.activeNodeCount,
    overloadedNodeIds: report.overloadedNodeIds,
    capacitySummary: `Fleet v15: ${report.nodeCount} nodes (${report.activeNodeCount} active), ${report.runningTaskCount} running tasks, CPU ${report.usedCpuCores}/${report.totalCpuCores} cores, RAM ${report.usedRamMb}/${report.totalRamMb} MB, VRAM ${report.usedVramMb}/${report.totalVramMb} MB.`,
    forecastSummary: forecast.summary,
    tightestResource: forecast.tightestResource,
    daysUntilFirstFull: forecast.daysUntilFirstFull,
    rebalanceMoves: rebalance.moves.map((m) => ({ taskId: m.taskId, fromNodeId: m.fromNodeId, toNodeId: m.toNodeId, reason: m.reason })),
    stillOverloaded: rebalance.stillOverloaded,
    users: userRows,
    rollouts: rolloutRows,
    summary: overview.summary,
  };
}

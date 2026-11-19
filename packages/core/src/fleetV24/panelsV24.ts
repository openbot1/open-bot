/**
 * Panels v24 — view-model cho UI fleet v24 (v1.37, Đội T6).
 *
 * Theo pattern `fleetV23/panelsV23.ts`: module thuần, chỉ biến state
 * core thành dữ liệu hiển thị (JSON-able, đã làm tròn, có chuỗi tóm
 * tắt) — không tự render, không đọc i18n trực tiếp (UI dùng key
 * `fleet.v24.*`). Dashboard tổng hợp gộp 3 mảng: automation dashboard
 * (gom theo tag, lọc theo owner), stop hook feedback, và CIDR sandbox
 * rules trong router.
 */

import type { FleetV24Automation, FleetV24AutomationStats, FleetV24OwnerSlice, FleetV24TagGroup } from './automationDashboard';
import { FleetV24AutomationRegistry, summarizeFleetV24Automations } from './automationDashboard';
import type { FleetV24Run, FleetV24RunTiming } from './automationRuns';
import { FleetV24RunLedger } from './automationRuns';
import type { FleetV24CidrAuditEntry, FleetV24CidrDecision, FleetV24CidrOverlap, FleetV24CidrRule } from './cidrSandbox';
import { FleetV24CidrRuleSet } from './cidrSandbox';
import type { FleetV24StopHookFeedback, FleetV24StopHookSummary } from './stopHookFeedback';
import { FleetV24StopHookFeedbackStore, summarizeFleetV24StopHookFeedback } from './stopHookFeedback';

/** View-model một automation trong dashboard (đã gọn cho UI). */
export interface FleetV24AutomationRow {
  id: string;
  name: string;
  owner: string;
  tags: string[];
  status: FleetV24Automation['status'];
  schedule: string | null;
  runs: number;
  successes: number;
  failures: number;
  stopped: number;
  /** Success rate over finished runs, 0-100, rounded. */
  successRatePct: number;
  lastRunAtMs: number | null;
  lastFinishedAtMs: number | null;
  note: string | null;
}

/** Build một row automation từ record core. */
export function buildFleetV24AutomationRow(a: FleetV24Automation): FleetV24AutomationRow {
  const finished = a.successCount + a.failureCount;
  return {
    id: a.id,
    name: a.name,
    owner: a.owner,
    tags: [...a.tags],
    status: a.status,
    schedule: a.schedule,
    runs: a.runCount,
    successes: a.successCount,
    failures: a.failureCount,
    stopped: a.stoppedCount,
    successRatePct: finished > 0 ? Math.round((a.successCount / finished) * 100) : 0,
    lastRunAtMs: a.lastRunAtMs,
    lastFinishedAtMs: a.lastFinishedAtMs,
    note: a.note,
  };
}

/** View-model dashboard automation: gom theo tag + lọc theo owner. */
export interface FleetV24AutomationDashboardPanel {
  /** Tóm tắt một dòng cho header. */
  summary: string;
  /** Thống kê toàn fleet. */
  stats: FleetV24AutomationStats;
  /** Nhóm theo tag (mỗi nhóm có stats + owners). */
  tagGroups: FleetV24TagGroup[];
  /** Lát theo owner. */
  ownerSlices: FleetV24OwnerSlice[];
  /** Automations đang chạy (cũ nhất trước). */
  running: FleetV24AutomationRow[];
  /** Automations vừa lỗi (mới nhất trước). */
  failed: FleetV24AutomationRow[];
  /** Automations bị pause. */
  paused: FleetV24AutomationRow[];
  /** Mọi automation (đã sort theo id). */
  all: FleetV24AutomationRow[];
  /** Tag đang được lọc (null = không lọc). */
  activeTagFilter: string | null;
  /** Owner đang được lọc (null = không lọc). */
  activeOwnerFilter: string | null;
  /** Automations sau khi áp filter tag/owner (null khi không lọc). */
  filtered: FleetV24AutomationRow[] | null;
  /** Thống kê của nhóm đã lọc (null khi không lọc). */
  filteredStats: FleetV24AutomationStats | null;
}

/**
 * Build panel dashboard automation từ registry.
 *
 * `tagFilter`/`ownerFilter` là filter đang chọn trên UI: panel trả về
 * cả danh sách đã lọc + stats của nó để UI không phải tự tính.
 */
export function buildFleetV24AutomationDashboardPanel(
  registry: FleetV24AutomationRegistry,
  tagFilter?: string | null,
  ownerFilter?: string | null,
): FleetV24AutomationDashboardPanel {
  const all = registry.list();
  const stats = summarizeFleetV24Automations(all);
  const tagGroups = registry.groupByTag();
  const ownerSlices = registry.groupByOwner();
  const running = registry.running().map(buildFleetV24AutomationRow);
  const failed = registry.failed().map(buildFleetV24AutomationRow);
  const paused = registry.byStatus('paused').map(buildFleetV24AutomationRow);
  const tag = tagFilter?.trim() ? tagFilter.trim().toLowerCase() : null;
  const owner = ownerFilter?.trim() ? ownerFilter.trim() : null;
  let filtered: FleetV24AutomationRow[] | null = null;
  let filteredStats: FleetV24AutomationStats | null = null;
  if (tag !== null || owner !== null) {
    const subset = all.filter(
      (a) => (tag === null || a.tags.includes(tag)) && (owner === null || a.owner === owner),
    );
    filtered = subset.map(buildFleetV24AutomationRow);
    filteredStats = summarizeFleetV24Automations(subset);
  }
  const summary =
    `${stats.total} automations · ${stats.running} running · ${stats.failed} failed · ` +
    `${stats.paused} paused · ${stats.disabled} disabled · ` +
    `${stats.runs} runs (${stats.successes} ok, ${stats.failures} failed, ${stats.stopped} stopped)`;
  return {
    summary,
    stats,
    tagGroups,
    ownerSlices,
    running,
    failed,
    paused,
    all: all.map(buildFleetV24AutomationRow),
    activeTagFilter: tag,
    activeOwnerFilter: owner,
    filtered,
    filteredStats,
  };
}

/** View-model một run trong panel (đã gọn cho UI). */
export interface FleetV24RunRow {
  id: string;
  automationId: string;
  owner: string;
  tags: string[];
  startedAtMs: number;
  finishedAtMs: number | null;
  outcome: FleetV24Run['outcome'];
  durationMs: number | null;
  error: string | null;
  stopHookFeedbackId: string | null;
  trigger: string | null;
}

/** Build một row run từ record core. */
export function buildFleetV24RunRow(run: FleetV24Run): FleetV24RunRow {
  return {
    id: run.id,
    automationId: run.automationId,
    owner: run.owner,
    tags: [...run.tags],
    startedAtMs: run.startedAtMs,
    finishedAtMs: run.finishedAtMs,
    outcome: run.outcome,
    durationMs: run.durationMs,
    error: run.error,
    stopHookFeedbackId: run.stopHookFeedbackId,
    trigger: run.trigger,
  };
}

/** View-model panel run ledger: recent + stuck + timing. */
export interface FleetV24RunsPanel {
  summary: string;
  countsByOutcome: Record<FleetV24Run['outcome'], number>;
  recent: FleetV24RunRow[];
  failed: FleetV24RunRow[];
  stoppedByHook: FleetV24RunRow[];
  stuck: FleetV24RunRow[];
  longest: FleetV24RunRow[];
  timing: FleetV24RunTiming;
}

/** Build panel run ledger từ ledger (stuck = đang chạy quá `stuckAfterMs`). */
export function buildFleetV24RunsPanel(
  ledger: FleetV24RunLedger,
  nowMs: number,
  stuckAfterMs = 30 * 60 * 1000,
): FleetV24RunsPanel {
  const counts = ledger.countsByOutcome();
  const timing = ledger.list().length > 0
    ? {
        count: 0,
        meanMs: 0,
        medianMs: 0,
        maxMs: 0,
        minMs: 0,
        p95Ms: 0,
      }
    : { count: 0, meanMs: 0, medianMs: 0, maxMs: 0, minMs: 0, p95Ms: 0 };
  const finished = ledger.list().filter((r) => r.durationMs !== null);
  const durations = finished.map((r) => r.durationMs as number).sort((a, b) => a - b);
  if (durations.length > 0) {
    const sum = durations.reduce((acc, d) => acc + d, 0);
    const mid = Math.floor(durations.length / 2);
    timing.count = durations.length;
    timing.meanMs = Math.round(sum / durations.length);
    timing.medianMs = Math.round(
      durations.length % 2 === 0 ? (durations[mid - 1] + durations[mid]) / 2 : durations[mid],
    );
    timing.maxMs = durations[durations.length - 1];
    timing.minMs = durations[0];
    timing.p95Ms = durations[Math.min(durations.length - 1, Math.floor(durations.length * 0.95))];
  }
  const summary =
    `${ledger.size} runs · ${counts.running} in flight · ${counts.completed} completed · ` +
    `${counts.failed} failed · ${counts.stopped} stopped · ${counts.cancelled} cancelled`;
  return {
    summary,
    countsByOutcome: counts,
    recent: ledger.recent(20).map(buildFleetV24RunRow),
    failed: ledger.failed(20).map(buildFleetV24RunRow),
    stoppedByHook: ledger.stoppedByHook(20).map(buildFleetV24RunRow),
    stuck: ledger.stuckRuns(nowMs, stuckAfterMs).map(buildFleetV24RunRow),
    longest: ledger.longest(10).map(buildFleetV24RunRow),
    timing,
  };
}

/** View-model một feedback stop hook trong panel. */
export interface FleetV24StopHookRow {
  id: string;
  runId: string;
  automationId: string;
  reason: string;
  triggeredBy: FleetV24StopHookFeedback['triggeredBy'];
  triggeredByName: string;
  action: FleetV24StopHookFeedback['action'];
  suggestedNextAction: string;
  stoppedAtMs: number;
  acknowledged: boolean;
  acknowledgedBy: string | null;
  acknowledgedAtMs: number | null;
}

/** Build một row feedback từ record core. */
export function buildFleetV24StopHookRow(f: FleetV24StopHookFeedback): FleetV24StopHookRow {
  return {
    id: f.id,
    runId: f.runId,
    automationId: f.automationId,
    reason: f.reason,
    triggeredBy: f.triggeredBy,
    triggeredByName: f.triggeredByName,
    action: f.action,
    suggestedNextAction: f.suggestedNextAction,
    stoppedAtMs: f.stoppedAtMs,
    acknowledged: f.acknowledged,
    acknowledgedBy: f.acknowledgedBy,
    acknowledgedAtMs: f.acknowledgedAtMs,
  };
}

/** View-model panel stop hook feedback. */
export interface FleetV24StopHookPanel {
  summary: string;
  /** Tóm tắt toàn fleet. */
  stats: FleetV24StopHookSummary;
  /** Feedback chưa xác nhận — to-do list của operator. */
  unacknowledged: FleetV24StopHookRow[];
  /** Feedback mới nhất. */
  recent: FleetV24StopHookRow[];
  /** Tóm tắt theo automation (nhiều stop nhất trước). */
  byAutomation: FleetV24StopHookSummary[];
  /** Tóm tắt theo trigger (chỉ trigger đã từng kích hoạt). */
  byTrigger: FleetV24StopHookSummary[];
  /** Feedback của automation đang được xem (null khi không chọn). */
  forAutomation: FleetV24StopHookRow[] | null;
  /** Feedback của run đang được xem (null khi không chọn). */
  forRun: FleetV24StopHookRow[] | null;
}

/** Build panel stop hook feedback từ store (+ automation/run đang chọn). */
export function buildFleetV24StopHookPanel(
  store: FleetV24StopHookFeedbackStore,
  automationId?: string | null,
  runId?: string | null,
): FleetV24StopHookPanel {
  const stats = store.summary();
  const summary =
    `${stats.total} stop-hook events · ${stats.unacknowledged} unacknowledged · ` +
    `user ${stats.byTrigger.user} · process ${stats.byTrigger.process} · ` +
    `rule ${stats.byTrigger.rule} · timeout ${stats.byTrigger.timeout} · ` +
    `approval ${stats.byTrigger.approval} · system ${stats.byTrigger.system}`;
  const automation = automationId?.trim() ? automationId.trim() : null;
  const run = runId?.trim() ? runId.trim() : null;
  return {
    summary,
    stats,
    unacknowledged: store.unacknowledged(50).map(buildFleetV24StopHookRow),
    recent: store.recent(20).map(buildFleetV24StopHookRow),
    byAutomation: store.summariesByAutomation(),
    byTrigger: store.summariesByTrigger(),
    forAutomation: automation === null ? null : store.forAutomation(automation).map(buildFleetV24StopHookRow),
    forRun: run === null ? null : store.forRun(run).map(buildFleetV24StopHookRow),
  };
}

/** View-model một CIDR rule trong panel router. */
export interface FleetV24CidrRuleRow {
  id: string;
  cidr: string;
  action: FleetV24CidrRule['action'];
  routeId: string | null;
  priority: number;
  enabled: boolean;
  description: string;
  createdBy: string;
  createdAtMs: number;
  updatedAtMs: number;
}

/** Build một row rule từ record core. */
export function buildFleetV24CidrRuleRow(rule: FleetV24CidrRule): FleetV24CidrRuleRow {
  return {
    id: rule.id,
    cidr: rule.cidr,
    action: rule.action,
    routeId: rule.routeId,
    priority: rule.priority,
    enabled: rule.enabled,
    description: rule.description,
    createdBy: rule.createdBy,
    createdAtMs: rule.createdAtMs,
    updatedAtMs: rule.updatedAtMs,
  };
}

/** View-model một audit entry CIDR trong panel. */
export interface FleetV24CidrAuditRow {
  seq: number;
  atMs: number;
  ruleId: string;
  action: string;
  actor: string;
  detail: string;
}

/** View-model panel CIDR router: rules + đánh giá thử + audit. */
export interface FleetV24CidrRouterPanel {
  summary: string;
  /** Default decision khi không rule nào khớp. */
  defaultAction: FleetV24CidrRuleSet['defaultAction'];
  /** Mọi rule, theo thứ tự đánh giá. */
  rules: FleetV24CidrRuleRow[];
  /** Rule đang bật. */
  enabledRules: FleetV24CidrRuleRow[];
  /** Rule của route đang được xem (null khi không chọn route). */
  rulesForRoute: FleetV24CidrRuleRow[] | null;
  /** Route đang được xem (null khi không chọn). */
  activeRouteId: string | null;
  /** Cảnh báo chồng lấn giữa các rule đang bật. */
  overlaps: FleetV24CidrOverlap[];
  /** Kết quả đánh giá thử (route, IP) — null khi chưa đánh giá. */
  probe: FleetV24CidrDecision | null;
  /** Audit trail mới nhất. */
  audit: FleetV24CidrAuditRow[];
}

/**
 * Build panel CIDR router từ rule set.
 *
 * `routeId` là route đang được xem trong UI; `probeIp` là IP operator
 * đang thử đánh giá cho route đó (cả hai null = panel tổng, không probe).
 */
export function buildFleetV24CidrRouterPanel(
  ruleSet: FleetV24CidrRuleSet,
  routeId?: string | null,
  probeIp?: string | null,
): FleetV24CidrRouterPanel {
  const route = routeId?.trim() ? routeId.trim() : null;
  const probeText = probeIp?.trim() ? probeIp.trim() : null;
  const rules = ruleSet.list().map(buildFleetV24CidrRuleRow);
  const enabled = ruleSet.enabledRules().map(buildFleetV24CidrRuleRow);
  const overlaps = ruleSet.overlaps();
  const probe = probeText === null ? null : ruleSet.evaluate(route, probeText);
  const conflicting = overlaps.filter((o) => o.conflicting).length;
  const summary =
    `${rules.length} rules (${enabled.length} enabled) · default ${ruleSet.defaultAction} · ` +
    `${overlaps.length} overlaps (${conflicting} conflicting)`;
  return {
    summary,
    defaultAction: ruleSet.defaultAction,
    rules,
    enabledRules: enabled,
    rulesForRoute: route === null ? null : ruleSet.rulesForRoute(route).map(buildFleetV24CidrRuleRow),
    activeRouteId: route,
    overlaps,
    probe,
    audit: ruleSet.auditTrail(50).map((e: FleetV24CidrAuditEntry) => ({
      seq: e.seq,
      atMs: e.atMs,
      ruleId: e.ruleId,
      action: e.action,
      actor: e.actor,
      detail: e.detail,
    })),
  };
}

/** View-model dashboard tổng hợp fleet v24 (3 mảng). */
export interface FleetV24Dashboard {
  summary: string;
  automation: FleetV24AutomationDashboardPanel;
  runs: FleetV24RunsPanel;
  stopHook: FleetV24StopHookPanel;
  cidr: FleetV24CidrRouterPanel;
}

/** Build dashboard tổng hợp fleet v24 từ 4 store. */
export function buildFleetV24Dashboard(
  registry: FleetV24AutomationRegistry,
  ledger: FleetV24RunLedger,
  feedback: FleetV24StopHookFeedbackStore,
  ruleSet: FleetV24CidrRuleSet,
  nowMs: number,
): FleetV24Dashboard {
  const automation = buildFleetV24AutomationDashboardPanel(registry);
  const runs = buildFleetV24RunsPanel(ledger, nowMs);
  const stopHook = buildFleetV24StopHookPanel(feedback);
  const cidr = buildFleetV24CidrRouterPanel(ruleSet);
  const summary =
    `${automation.summary} · ${runs.summary} · ` +
    `${stopHook.stats.total} stop-hook events (${stopHook.stats.unacknowledged} unacknowledged) · ` +
    `${cidr.rules.length} CIDR rules (${cidr.enabledRules.length} enabled)`;
  return { summary, automation, runs, stopHook, cidr };
}

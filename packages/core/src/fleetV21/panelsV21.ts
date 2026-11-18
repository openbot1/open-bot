/**
 * Panels + fleet dashboard v21 (v1.34, Đội T6).
 *
 * Theo pattern panels v20: module chỉ xây VIEW-MODEL thuần từ dữ liệu
 * thật của các tầng dưới; component React render từ đó. Không đọc file,
 * không chạm mạng, không chứa mock.
 *
 * Dashboard v21 gộp TOÀN fleet vào một màn hình vào duy nhất (progressive
 * disclosure — chi tiết nằm sau từng panel con):
 *
 * - NODE: node nào online/draining/offline/dead, tier tối đa, tải
 *   CPU/RAM/disk, độ tin cậy, bao nhiêu run đang chạy.
 * - RUN: run đang chạy ở node nào, tier nào, chạy được bao lâu, có vượt
 *   lifetime cap không.
 * - AUTOMATION: automation nào tới hạn, lần chạy cuối khi nào, lỗi gì,
 *   automation nào fail liên tiếp / đã dead-letter.
 * - CẢNH BÁO: node quá tải, run vượt lifetime cap, automation fail liên
 *   tiếp, node chết còn run kẹt — error trước, warning sau.
 *
 * Chuỗi tóm tắt trong view-model viết tiếng Việt như panels v20 (chuỗi
 * hiển thị dài hơn dùng i18n `fleet.v21.*` ở desktop).
 */

import type { DurableAutomationV2 } from '../durable/automationV2';
import type { FleetV21Node } from './nodes';
import { nodeCpuFractionV21, nodeIsOverloadedV21, nodeLoadV21, nodeRamFractionV21 } from './nodes';
import type { FleetV21PlacementRecord } from './placement';
import type { SandboxTierV21 } from './tiers';

// ---------------------------------------------------------------------------
// Input: run đang chạy (host lấy từ scheduler/placement state)
// ---------------------------------------------------------------------------

/** Một run đang chạy trên fleet (đầu vào cho dashboard). */
export interface FleetV21RunningRunView {
  runId: string;
  botId: string;
  nodeId: string;
  minTier: SandboxTierV21;
  startedAt: number;
  /** Thời gian sống tối đa (ms) — hết là vi phạm cap. */
  maxLifetimeMs?: number;
  /** Trạng thái run (mặc định 'running'). */
  status?: 'running' | 'starting' | 'stopping';
}

// ---------------------------------------------------------------------------
// Node panel
// ---------------------------------------------------------------------------

export interface FleetV21NodeRow {
  id: string;
  name: string;
  maxTier: SandboxTierV21;
  status: string;
  statusReason?: string;
  cpuUsed: number;
  cpuCores: number;
  cpuFraction: number;
  ramUsed: number;
  ramBytes: number;
  ramFraction: number;
  diskUsed: number;
  diskBytes: number;
  diskFraction: number;
  /** Tải nặng nhất (max CPU/RAM/disk) 0..1. */
  load: number;
  overloaded: boolean;
  hot: boolean;
  latencyMs: number | null;
  reliability: number;
  runCount: number;
  labels: string[];
  /** Node online được bao lâu (ms) — null khi không online. */
  uptimeMs: number | null;
}

export interface FleetV21NodePanelView {
  summary: string;
  total: number;
  online: number;
  draining: number;
  offline: number;
  dead: number;
  overloaded: number;
  totalCpuCores: number;
  totalCpuUsed: number;
  totalRamBytes: number;
  totalRamUsed: number;
  totalRuns: number;
  rows: FleetV21NodeRow[];
  overloadedNodeIds: string[];
  deadNodeIds: string[];
}

export function buildFleetV21NodePanel(nodes: readonly FleetV21Node[], now: number = Date.now()): FleetV21NodePanelView {
  const rows: FleetV21NodeRow[] = [...nodes]
    .sort((a, b) => nodeLoadV21(b) - nodeLoadV21(a) || a.id.localeCompare(b.id))
    .map((n) => ({
      id: n.id,
      name: n.name,
      maxTier: n.maxTier,
      status: n.status,
      ...(n.statusReason ? { statusReason: n.statusReason } : {}),
      cpuUsed: n.cpuUsed,
      cpuCores: n.cpuCores,
      cpuFraction: Math.round(nodeCpuFractionV21(n) * 1000) / 1000,
      ramUsed: n.ramUsed,
      ramBytes: n.ramBytes,
      ramFraction: Math.round(nodeRamFractionV21(n) * 1000) / 1000,
      diskUsed: n.diskUsed,
      diskBytes: n.diskBytes,
      diskFraction: Math.round((n.diskBytes > 0 ? n.diskUsed / n.diskBytes : 1) * 1000) / 1000,
      load: Math.round(nodeLoadV21(n) * 1000) / 1000,
      overloaded: nodeIsOverloadedV21(n),
      hot: nodeCpuFractionV21(n) >= 0.75 || nodeRamFractionV21(n) >= 0.75,
      latencyMs: n.latencyMs,
      reliability: n.reliability,
      runCount: n.runCount,
      labels: [...n.labels],
      uptimeMs: n.status === 'online' ? Math.max(0, now - n.joinedAt) : null,
    }));
  const online = rows.filter((r) => r.status === 'online').length;
  const dead = rows.filter((r) => r.status === 'dead').length;
  const overloaded = rows.filter((r) => r.overloaded).length;
  return {
    summary:
      nodes.length === 0
        ? 'Fleet chưa có node nào — thêm node trước khi đặt run.'
        : `${online}/${nodes.length} node online, ${rows.reduce((s, r) => s + r.runCount, 0)} run đang chạy` +
          (overloaded > 0 ? `, ${overloaded} node quá tải` : '') +
          (dead > 0 ? `, ${dead} node chết` : '') +
          '.',
    total: nodes.length,
    online,
    draining: rows.filter((r) => r.status === 'draining').length,
    offline: rows.filter((r) => r.status === 'offline').length,
    dead,
    overloaded,
    totalCpuCores: rows.reduce((s, r) => s + r.cpuCores, 0),
    totalCpuUsed: rows.reduce((s, r) => s + r.cpuUsed, 0),
    totalRamBytes: rows.reduce((s, r) => s + r.ramBytes, 0),
    totalRamUsed: rows.reduce((s, r) => s + r.ramUsed, 0),
    totalRuns: rows.reduce((s, r) => s + r.runCount, 0),
    rows,
    overloadedNodeIds: rows.filter((r) => r.overloaded).map((r) => r.id),
    deadNodeIds: rows.filter((r) => r.status === 'dead').map((r) => r.id),
  };
}

// ---------------------------------------------------------------------------
// Run panel
// ---------------------------------------------------------------------------

export interface FleetV21RunRow {
  runId: string;
  botId: string;
  nodeId: string;
  /** Tên node (hoặc nodeId khi node không còn trong fleet). */
  nodeName: string;
  /** Node còn tồn tại trong fleet không (false = run mồ côi, cần rebalance). */
  nodeExists: boolean;
  minTier: SandboxTierV21;
  status: string;
  /** Tuổi run (ms). */
  ageMs: number;
  /** true khi run vượt lifetime cap. */
  overLifetimeCap: boolean;
  /** Còn bao lâu tới cap (ms, null khi không đặt cap). */
  msToCap: number | null;
}

export interface FleetV21RunPanelView {
  summary: string;
  total: number;
  running: number;
  overLifetimeCap: number;
  orphaned: number;
  byTier: Record<string, number>;
  byNode: Record<string, number>;
  rows: FleetV21RunRow[];
  overLifetimeCapRunIds: string[];
  orphanedRunIds: string[];
}

export function buildFleetV21RunPanel(
  runs: readonly FleetV21RunningRunView[],
  nodes: readonly FleetV21Node[],
  now: number = Date.now(),
): FleetV21RunPanelView {
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  const rows: FleetV21RunRow[] = [...runs]
    .sort((a, b) => a.startedAt - b.startedAt)
    .map((r) => {
      const node = nodeById.get(r.nodeId);
      const ageMs = Math.max(0, now - r.startedAt);
      const overLifetimeCap = r.maxLifetimeMs !== undefined && ageMs > r.maxLifetimeMs;
      return {
        runId: r.runId,
        botId: r.botId,
        nodeId: r.nodeId,
        nodeName: node?.name ?? r.nodeId,
        nodeExists: node !== undefined,
        minTier: r.minTier,
        status: r.status ?? 'running',
        ageMs,
        overLifetimeCap,
        msToCap: r.maxLifetimeMs !== undefined ? r.maxLifetimeMs - ageMs : null,
      };
    });
  const byTier: Record<string, number> = {};
  const byNode: Record<string, number> = {};
  for (const r of rows) {
    byTier[r.minTier] = (byTier[r.minTier] ?? 0) + 1;
    byNode[r.nodeId] = (byNode[r.nodeId] ?? 0) + 1;
  }
  const over = rows.filter((r) => r.overLifetimeCap).length;
  const orphaned = rows.filter((r) => !r.nodeExists).length;
  return {
    summary:
      runs.length === 0
        ? 'Không có run nào đang chạy.'
        : `${runs.length} run đang chạy trên ${Object.keys(byNode).length} node` +
          (over > 0 ? `, ${over} run vượt lifetime cap` : '') +
          (orphaned > 0 ? `, ${orphaned} run mồ côi (node không còn)` : '') +
          '.',
    total: runs.length,
    running: rows.filter((r) => r.status === 'running').length,
    overLifetimeCap: over,
    orphaned,
    byTier,
    byNode,
    rows,
    overLifetimeCapRunIds: rows.filter((r) => r.overLifetimeCap).map((r) => r.runId),
    orphanedRunIds: rows.filter((r) => !r.nodeExists).map((r) => r.runId),
  };
}

// ---------------------------------------------------------------------------
// Automation panel
// ---------------------------------------------------------------------------

export interface FleetV21AutomationRow {
  id: string;
  name: string;
  triggerKind: string;
  triggerLabel: string;
  botId: string;
  status: string;
  consecutiveFailures: number;
  totalRuns: number;
  totalSuccesses: number;
  nextRunAt: number | null;
  /** Sắp tới hạn (trong 5 phút tới) hay không. */
  dueSoon: boolean;
  lastRunAt: number | null;
  lastSuccessAt: number | null;
  lastError: string | null;
  lastTraceMessage: string | null;
}

export interface FleetV21AutomationPanelView {
  summary: string;
  total: number;
  idle: number;
  running: number;
  waitingRetry: number;
  deadLetter: number;
  paused: number;
  failingConsecutively: number;
  rows: FleetV21AutomationRow[];
  deadLetterIds: string[];
  failingIds: string[];
}

export function buildFleetV21AutomationPanel(
  automations: readonly DurableAutomationV2[],
  now: number = Date.now(),
): FleetV21AutomationPanelView {
  const rows: FleetV21AutomationRow[] = [...automations]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((a) => {
      const lastTrace = a.traces[a.traces.length - 1];
      return {
        id: a.id,
        name: a.name,
        triggerKind: a.trigger.kind,
        triggerLabel:
          a.trigger.kind === 'schedule'
            ? `mỗi ${Math.round(a.trigger.intervalMs / 1000)}s`
            : `event ${a.trigger.eventPattern}`,
        botId: a.action.botId,
        status: a.status,
        consecutiveFailures: a.consecutiveFailures,
        totalRuns: a.totalRuns,
        totalSuccesses: a.totalSuccesses,
        nextRunAt: a.nextRunAt,
        dueSoon: a.nextRunAt !== null && a.nextRunAt - now <= 5 * 60 * 1000 && a.status !== 'paused' && a.status !== 'dead-letter',
        lastRunAt: a.lastRunAt,
        lastSuccessAt: a.lastSuccessAt,
        lastError: a.lastError,
        lastTraceMessage: lastTrace?.message ?? null,
      };
    });
  const deadLetter = rows.filter((r) => r.status === 'dead-letter').length;
  const failing = rows.filter((r) => r.consecutiveFailures >= 2).length;
  return {
    summary:
      automations.length === 0
        ? 'Chưa có automation nào — tạo automation để bot tự chạy theo lịch hoặc sự kiện.'
        : `${automations.length} automation: ${rows.filter((r) => r.status === 'idle').length} chờ, ` +
          `${rows.filter((r) => r.status === 'running').length} đang chạy, ` +
          `${rows.filter((r) => r.status === 'waiting-retry').length} chờ retry` +
          (deadLetter > 0 ? `, ${deadLetter} dead-letter` : '') +
          (failing > 0 ? `, ${failing} fail liên tiếp` : '') +
          '.',
    total: automations.length,
    idle: rows.filter((r) => r.status === 'idle').length,
    running: rows.filter((r) => r.status === 'running').length,
    waitingRetry: rows.filter((r) => r.status === 'waiting-retry').length,
    deadLetter,
    paused: rows.filter((r) => r.status === 'paused').length,
    failingConsecutively: failing,
    rows,
    deadLetterIds: rows.filter((r) => r.status === 'dead-letter').map((r) => r.id),
    failingIds: rows.filter((r) => r.consecutiveFailures >= 2).map((r) => r.id),
  };
}

// ---------------------------------------------------------------------------
// Dashboard tổng hợp
// ---------------------------------------------------------------------------

/** Một mục cần chú ý trên dashboard — panel nào, mức nào, mô tả ngắn. */
export interface FleetV21DashboardAttention {
  panel: 'node' | 'run' | 'automation' | 'placement';
  level: 'error' | 'warning' | 'info';
  message: string;
}

export interface FleetV21DashboardView {
  summary: string;
  nodeSummary: string;
  runSummary: string;
  automationSummary: string;
  /** Số mục cần chú ý (error + warning). */
  attentionCount: number;
  /** Mục cần chú ý: error trước, warning sau, info cuối. */
  attention: FleetV21DashboardAttention[];
  /** Đếm nhanh để menu hiện badge. */
  counts: {
    nodesOnline: number;
    nodesTotal: number;
    nodesOverloaded: number;
    runsTotal: number;
    runsOverLifetimeCap: number;
    automationsTotal: number;
    automationsDeadLetter: number;
    automationsFailing: number;
  };
  /** Placement gần đây nhất (mới nhất trước, tối đa 10) — để biết ai dời run nào. */
  recentPlacements: FleetV21PlacementRecord[];
}

export interface FleetV21DashboardInput {
  nodes: readonly FleetV21Node[];
  runs: readonly FleetV21RunningRunView[];
  automations: readonly DurableAutomationV2[];
  /** Lịch sử placement (mới nhất cuối — dashboard tự lấy 10 mới nhất). */
  placementHistory?: readonly FleetV21PlacementRecord[];
  now?: number;
}

/**
 * Build dashboard v21 từ 3 nguồn thật (node + run + automation) và lịch
 * sử placement (nếu host truyền vào). Dashboard chỉ liệt kê, không sửa
 * gì: bấm vào mục cần chú ý thì mở đúng panel con để xử lý.
 */
export function buildFleetV21Dashboard(input: FleetV21DashboardInput): FleetV21DashboardView {
  const now = input.now ?? Date.now();
  const nodePanel = buildFleetV21NodePanel(input.nodes, now);
  const runPanel = buildFleetV21RunPanel(input.runs, input.nodes, now);
  const automationPanel = buildFleetV21AutomationPanel(input.automations, now);

  const attention: FleetV21DashboardAttention[] = [];
  for (const row of nodePanel.rows) {
    if (row.status === 'dead') {
      const strandedRuns = runPanel.rows.filter((r) => r.nodeId === row.id).length;
      attention.push({
        panel: 'node',
        level: 'error',
        message:
          `Node "${row.id}" chết` +
          (row.statusReason ? ` (${row.statusReason})` : '') +
          (strandedRuns > 0 ? ` — ${strandedRuns} run kẹt lại, cần rebalance.` : '.'),
      });
    } else if (row.overloaded) {
      attention.push({
        panel: 'node',
        level: 'warning',
        message: `Node "${row.id}" quá tải (CPU ${Math.round(row.cpuFraction * 100)}%, RAM ${Math.round(row.ramFraction * 100)}%) — cân nhắc rebalance hoặc thêm node.`,
      });
    } else if (row.status === 'offline') {
      attention.push({
        panel: 'node',
        level: 'warning',
        message: `Node "${row.id}" mất heartbeat — run của nó có thể cần dời nếu node không quay lại.`,
      });
    }
  }
  for (const row of runPanel.rows) {
    if (row.overLifetimeCap) {
      attention.push({
        panel: 'run',
        level: 'error',
        message: `Run "${row.runId}" (bot ${row.botId}) vượt lifetime cap ${Math.round(row.ageMs / 1000)}s trên node ${row.nodeId} — kiểm tra run có kẹt không.`,
      });
    }
    if (!row.nodeExists) {
      attention.push({
        panel: 'run',
        level: 'error',
        message: `Run "${row.runId}" mồ côi — node ${row.nodeId} không còn trong fleet, cần đặt lại.`,
      });
    }
  }
  for (const row of automationPanel.rows) {
    if (row.status === 'dead-letter') {
      attention.push({
        panel: 'automation',
        level: 'error',
        message: `Automation "${row.id}" đã dead-letter sau ${row.consecutiveFailures} lần fail liên tiếp${row.lastError ? `: ${row.lastError}` : ''}.`,
      });
    } else if (row.consecutiveFailures >= 2) {
      attention.push({
        panel: 'automation',
        level: 'warning',
        message: `Automation "${row.id}" fail ${row.consecutiveFailures} lần liên tiếp${row.lastError ? `: ${row.lastError}` : ''}.`,
      });
    }
  }
  const recentPlacements = [...(input.placementHistory ?? [])].slice(-10).reverse();

  const levelRank: Record<string, number> = { error: 0, warning: 1, info: 2 };
  attention.sort((a, b) => levelRank[a.level] - levelRank[b.level]);

  return {
    summary:
      `${nodePanel.summary} ${runPanel.summary} ${automationPanel.summary}` +
      (attention.length > 0 ? ` Có ${attention.length} mục cần chú ý.` : ' Không có mục nào cần chú ý.'),
    nodeSummary: nodePanel.summary,
    runSummary: runPanel.summary,
    automationSummary: automationPanel.summary,
    attentionCount: attention.filter((a) => a.level !== 'info').length,
    attention,
    counts: {
      nodesOnline: nodePanel.online,
      nodesTotal: nodePanel.total,
      nodesOverloaded: nodePanel.overloaded,
      runsTotal: runPanel.total,
      runsOverLifetimeCap: runPanel.overLifetimeCap,
      automationsTotal: automationPanel.total,
      automationsDeadLetter: automationPanel.deadLetter,
      automationsFailing: automationPanel.failingConsecutively,
    },
    recentPlacements,
  };
}

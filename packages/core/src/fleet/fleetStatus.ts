/**
 * Fleet status v4 — trạng thái fleet / node / bot trong một cái nhìn
 * (v1.06, Đội T6).
 *
 * Ghép 3 nguồn đã có thành một view duy nhất để UI/CLI/tool trả lời
 * "fleet đang thế nào" mà không phải đọc 3 file rời:
 *
 * - node: registry node (`fleet/nodes.ts`) + liveness từ heartbeat
 *   (alive/stale/dead/never-seen — node không heartbeat thì không
 *   bao giờ được báo là sống);
 * - bot run: hàng đợi + run của `fleet/botScheduling.ts` (queued /
 *   scheduled / running / done / failed, gắn với node nào);
 * - utilisation: tài nguyên khai báo của node so với reservation của
 *   các run active + load node tự báo (cpuUsedFraction, ramUsedBytes).
 *   Số nào không đo được thì báo `null` / "unknown", không đoán là 0.
 *
 * Cảnh báo (`FleetStatusWarning`) chỉ ra vấn đề thật: node chết mà
 * còn run scheduled/running (run đó cần requeue), node quá tải
 * concurrency, run queued quá lâu (starving), node stale lâu. View
 * này chỉ đọc — không ghi, không đổi trạng thái, không requeue hộ.
 */

import {
  listFleetNodeViews,
  loadFleetNodes,
  nodeLiveness,
  type FleetNode,
  type FleetNodeLiveness,
  type FleetNodeView,
} from './nodes';
import {
  loadBotRuns,
  reservedResourcesOnNode,
  summarizeBotScheduling,
  type BotRun,
  type BotSchedulingSummary,
} from './botScheduling';

/** Utilisation đo được của một node (null = không đo được). */
export interface FleetNodeUtilization {
  /** Phần CPU đã đặt chỗ (reservation / khai báo), 0..1 — null khi node không khai báo. */
  cpuReservedFraction: number | null;
  /** Phần RAM đã đặt chỗ, 0..1. */
  ramReservedFraction: number | null;
  /** Phần đĩa đã đặt chỗ, 0..1. */
  diskReservedFraction: number | null;
  /** CPU node tự báo đang dùng (0..1) — null khi node không báo. */
  cpuUsedFraction: number | null;
  /** RAM node tự báo đang dùng (bytes) — null khi node không báo. */
  ramUsedBytes: number | null;
  /** Số run active (scheduled/running) đang đặt chỗ trên node. */
  activeRuns: number;
  /** Số run queued đang CHỜ node này (chưa gắn node — chỉ đếm toàn cục ở summary). */
  queuedRuns: number;
}

/** Một node kèm liveness + utilisation + run của nó. */
export interface FleetNodeStatus {
  view: FleetNodeView;
  utilization: FleetNodeUtilization;
  runs: BotRun[];
  /** True khi node đã vượt giới hạn concurrency (activeRuns > maxConcurrentPerNode). */
  overConcurrencyLimit: boolean;
}

/** Trạng thái của một bot (gộp tất cả run của nó). */
export interface FleetBotStatus {
  botId: string;
  totalRuns: number;
  queued: number;
  scheduled: number;
  running: number;
  done: number;
  failed: number;
  cancelled: number;
  /** Node run đang chạy/scheduled gần nhất — null khi không chạy đâu. */
  currentNodeId: string | null;
  /** Lỗi cuối cùng (khi run mới nhất fail). */
  lastError?: string;
  /** Epoch ms run mới nhất được tạo. */
  lastRunAt: number;
}

/** Một cảnh báo về sức khoẻ fleet. */
export interface FleetStatusWarning {
  level: 'warning' | 'critical';
  code:
    | 'dead-node-has-runs'
    | 'node-over-concurrency'
    | 'queued-run-starving'
    | 'node-stale'
    | 'no-alive-node'
    | 'failed-runs';
  message: string;
  /** Node liên quan (nếu có). */
  nodeId?: string;
  /** Bot liên quan (nếu có). */
  botId?: string;
}

/** View tổng hợp toàn fleet. */
export interface FleetStatus {
  at: number;
  nodes: FleetNodeStatus[];
  bots: FleetBotStatus[];
  scheduling: BotSchedulingSummary;
  counts: {
    totalNodes: number;
    aliveNodes: number;
    staleNodes: number;
    deadNodes: number;
    neverSeenNodes: number;
    totalBots: number;
  };
  warnings: FleetStatusWarning[];
}

/** Run queued quá lâu thì cảnh báo starving (mặc định 5 phút). */
export const DEFAULT_STARVING_RUN_MS = 5 * 60_000;
/** Node stale quá lâu thì cảnh báo (mặc định 2 phút từ heartbeat). */
export const DEFAULT_STALE_WARNING_MS = 2 * 60_000;

/** Tính utilisation của một node từ reservation + load tự báo. */
export function nodeUtilization(
  node: FleetNode,
  allRuns: BotRun[],
  maxConcurrentPerNode: number,
): { utilization: FleetNodeUtilization; overConcurrencyLimit: boolean } {
  const reserved = reservedResourcesOnNode(allRuns, node.id);
  const utilization: FleetNodeUtilization = {
    cpuReservedFraction: node.cpuCores > 0 ? reserved.cpuCores / node.cpuCores : null,
    ramReservedFraction: node.ramBytes > 0 ? reserved.ramBytes / node.ramBytes : null,
    diskReservedFraction: node.diskBytes > 0 ? reserved.diskBytes / node.diskBytes : null,
    cpuUsedFraction: node.lastLoad?.cpuUsedFraction ?? null,
    ramUsedBytes: node.lastLoad?.ramUsedBytes ?? null,
    activeRuns: reserved.activeRuns,
    queuedRuns: allRuns.filter((r) => r.status === 'queued').length,
  };
  return {
    utilization,
    overConcurrencyLimit:
      maxConcurrentPerNode > 0 && reserved.activeRuns > maxConcurrentPerNode,
  };
}

/** Gộp tất cả run của một bot thành một trạng thái bot. */
export function buildFleetBotStatus(botId: string, runs: BotRun[]): FleetBotStatus {
  const mine = runs.filter((r) => r.botId === botId);
  const status: FleetBotStatus = {
    botId,
    totalRuns: mine.length,
    queued: 0,
    scheduled: 0,
    running: 0,
    done: 0,
    failed: 0,
    cancelled: 0,
    currentNodeId: null,
    lastRunAt: 0,
  };
  let latest: BotRun | null = null;
  for (const run of mine) {
    status[run.status] += 1;
    if (run.createdAt >= status.lastRunAt) status.lastRunAt = run.createdAt;
    if (latest === null || run.createdAt >= latest.createdAt) latest = run;
    if ((run.status === 'running' || run.status === 'scheduled') && run.nodeId !== null) {
      status.currentNodeId = run.nodeId;
    }
  }
  if (latest !== null && latest.status === 'failed' && latest.lastError !== undefined) {
    status.lastError = latest.lastError;
  }
  return status;
}

/** Tính các cảnh báo sức khoẻ fleet (pure — dễ test). */
export function fleetHealthWarnings(
  nodes: FleetNode[],
  runs: BotRun[],
  now = Date.now(),
  options: { starvingMs?: number; staleWarningMs?: number; maxConcurrentPerNode?: number } = {},
): FleetStatusWarning[] {
  const starvingMs = options.starvingMs ?? DEFAULT_STARVING_RUN_MS;
  const staleWarningMs = options.staleWarningMs ?? DEFAULT_STALE_WARNING_MS;
  const maxConcurrentPerNode = options.maxConcurrentPerNode ?? 0;
  const warnings: FleetStatusWarning[] = [];
  const aliveCount = nodes.filter((n) => nodeLiveness(n, now) === 'alive').length;
  if (nodes.length > 0 && aliveCount === 0) {
    warnings.push({
      level: 'critical',
      code: 'no-alive-node',
      message: `No alive node in the fleet (${nodes.length} registered) — queued bot runs cannot be scheduled.`,
    });
  }
  for (const node of nodes) {
    const liveness: FleetNodeLiveness = nodeLiveness(node, now);
    const nodeRuns = runs.filter(
      (r) => r.nodeId === node.id && (r.status === 'scheduled' || r.status === 'running'),
    );
    if ((liveness === 'dead' || liveness === 'never-seen') && nodeRuns.length > 0) {
      warnings.push({
        level: 'critical',
        code: 'dead-node-has-runs',
        message: `Node "${node.hostname}" is ${liveness} but still holds ${nodeRuns.length} scheduled/running bot run(s) — requeue them.`,
        nodeId: node.id,
      });
    }
    if (liveness === 'stale' && node.lastHeartbeatAt !== null && now - node.lastHeartbeatAt >= staleWarningMs) {
      warnings.push({
        level: 'warning',
        code: 'node-stale',
        message: `Node "${node.hostname}" has not sent a heartbeat for ${Math.round((now - node.lastHeartbeatAt) / 1000)}s.`,
        nodeId: node.id,
      });
    }
    if (maxConcurrentPerNode > 0) {
      const reserved = reservedResourcesOnNode(runs, node.id);
      if (reserved.activeRuns > maxConcurrentPerNode) {
        warnings.push({
          level: 'warning',
          code: 'node-over-concurrency',
          message: `Node "${node.hostname}" runs ${reserved.activeRuns} bot runs, over the limit of ${maxConcurrentPerNode}.`,
          nodeId: node.id,
        });
      }
    }
  }
  const failedRuns = runs.filter((r) => r.status === 'failed');
  if (failedRuns.length > 0) {
    warnings.push({
      level: 'warning',
      code: 'failed-runs',
      message: `${failedRuns.length} bot run(s) failed permanently (no more retries).`,
    });
  }
  for (const run of runs) {
    if (run.status === 'queued' && now - run.createdAt >= starvingMs) {
      warnings.push({
        level: 'warning',
        code: 'queued-run-starving',
        message: `Bot run "${run.id}" (bot "${run.botId}") has waited in the queue for ${Math.round((now - run.createdAt) / 1000)}s.`,
        botId: run.botId,
      });
    }
  }
  return warnings;
}

/**
 * Build view trạng thái fleet đầy đủ (chỉ đọc — không ghi file nào).
 * `maxConcurrentPerNode` chỉ dùng để tính cảnh báo over-concurrency
 * (0 = không giới hạn, không cảnh báo).
 */
export function buildFleetStatus(
  fleetRoot: string,
  now = Date.now(),
  options: {
    starvingMs?: number;
    staleWarningMs?: number;
    maxConcurrentPerNode?: number;
  } = {},
): FleetStatus {
  const nodes = loadFleetNodes(fleetRoot);
  const views = listFleetNodeViews(fleetRoot, now);
  const viewById = new Map(views.map((v) => [v.node.id, v]));
  const runs = loadBotRuns(fleetRoot);
  const maxConcurrentPerNode = options.maxConcurrentPerNode ?? 0;
  const nodeStatuses: FleetNodeStatus[] = nodes.map((node) => {
    const { utilization, overConcurrencyLimit } = nodeUtilization(node, runs, maxConcurrentPerNode);
    return {
      view: viewById.get(node.id) ?? { node, liveness: nodeLiveness(node, now), msSinceHeartbeat: node.lastHeartbeatAt === null ? null : now - node.lastHeartbeatAt },
      utilization,
      runs: runs.filter((r) => r.nodeId === node.id),
      overConcurrencyLimit,
    };
  });
  const botIds = [...new Set(runs.map((r) => r.botId))].sort();
  const bots = botIds.map((botId) => buildFleetBotStatus(botId, runs));
  const counts = {
    totalNodes: nodes.length,
    aliveNodes: nodes.filter((n) => nodeLiveness(n, now) === 'alive').length,
    staleNodes: nodes.filter((n) => nodeLiveness(n, now) === 'stale').length,
    deadNodes: nodes.filter((n) => nodeLiveness(n, now) === 'dead').length,
    neverSeenNodes: nodes.filter((n) => nodeLiveness(n, now) === 'never-seen').length,
    totalBots: botIds.length,
  };
  return {
    at: now,
    nodes: nodeStatuses,
    bots,
    scheduling: summarizeBotScheduling(fleetRoot, now),
    counts,
    warnings: fleetHealthWarnings(nodes, runs, now, options),
  };
}

/** Tóm tắt một dòng trạng thái fleet (để CLI/tool in nhanh). */
export function formatFleetStatusLine(status: FleetStatus): string {
  const { counts, scheduling } = status;
  const parts = [
    `nodes ${counts.aliveNodes}/${counts.totalNodes} alive`,
    counts.staleNodes > 0 ? `${counts.staleNodes} stale` : null,
    counts.deadNodes > 0 ? `${counts.deadNodes} dead` : null,
    `bots ${counts.totalBots}`,
    `runs queued=${scheduling.queued} running=${scheduling.running} done=${scheduling.done} failed=${scheduling.failed}`,
  ].filter((p): p is string => p !== null);
  const warnings = status.warnings.length > 0 ? ` — ${status.warnings.length} warning(s)` : '';
  return `${parts.join(', ')}${warnings}`;
}

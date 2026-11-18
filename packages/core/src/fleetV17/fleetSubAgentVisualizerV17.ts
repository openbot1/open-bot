/**
 * Fleet sub-agent visualizer v17 — hiển thị trực quan các sub-agent
 * đang chạy trên fleet: node nào, task nào, tài nguyên đang dùng,
 * cây cha-con, node quá tải (v1.20, Đội T6).
 *
 * Tầng trên của snapshot fleet v14 (`fleetV14/fleetV14.ts` — node,
 * task đã phân bổ, event) + health check v17 (`fleetV17.ts` —
 * điểm health 0..100, mức healthy/degraded/unhealthy/down) +
 * capacity v17 (tổng hợp headroom). V14 trả lời "task đang chạy
 * ở node nào"; visualizer trả lời 4 câu UI cần để vẽ bản đồ fleet:
 *
 * - BẢN ĐỒ NODE → AGENT: mỗi node thành một "cột" có vị trí lưới
 *   xác định (x/y tính sẵn, không phụ thuộc thứ tự render), mỗi
 *   sub-agent là một "thẻ" trong cột của node đang chạy nó, kèm
 *   CPU/RAM đang chiếm, owner, trạng thái, thời gian bắt đầu.
 * - CÂY CHA-CON: task có `parentTaskId` (sub-agent do một agent
 *   khác spawn) thì vẽ edge cha → con kèm độ sâu (depth) — agent
 *   mồ côi (cha không còn trong snapshot) được đánh dấu riêng
 *   thay vì biến mất khỏi bản đồ.
 * - QUÁ TẢI NỔI BẬT: node nào CPU/RAM > 80% hoặc hết task slot
 *   thì gắn cờ `overloaded` + lý do; node health xấu (unhealthy/
 *   down) thì gắn cờ `atRisk`; UI tô màu theo cờ mà không cần
 *   tính lại.
 * - TÓM TẮT TOÀN FLEET: tổng số sub-agent theo trạng thái, theo
 *   node, theo owner; chuỗi spawn sâu nhất; agent chạy lâu nhất;
 *   node "nóng" nhất — để dashboard hiển thị số liệu ngay mà
 *   không duyệt lại toàn bộ map.
 *
 * Module này chỉ XÂY VIEW-MODEL thuần từ snapshot + health đã có:
 * không spawn agent, không chạm mạng, không đo tài nguyên thật.
 * Tọa độ lưới là gợi ý bố cục cho component React render — không
 * phải vị trí vật lý của máy.
 */

import type { FleetV14Snapshot, FleetV14TaskStatus } from '../fleetV14/fleetV14';
import type { FleetV17CapacitySummary, FleetV17HealthCheck } from './fleetV17';

/** Chiều rộng một cột node trên lưới (px, gợi ý cho UI). */
export const FLEET_V17_VIS_NODE_COLUMN_WIDTH = 320;
/** Chiều cao một thẻ agent (px, gợi ý cho UI). */
export const FLEET_V17_VIS_AGENT_CARD_HEIGHT = 96;
/** Ngưỡng % CPU/RAM coi là quá tải. */
export const FLEET_V17_VIS_OVERLOAD_FRACTION = 0.8;

/** Liên kết cha-con giữa các task (sub-agent spawn bởi agent khác). */
export interface FleetV17AgentParentLink {
  taskId: string;
  parentTaskId: string;
}

/** Một sub-agent trên bản đồ. */
export interface FleetV17VisualAgent {
  agentId: string;
  taskId: string;
  kind: string;
  nodeId: string;
  /** Agent cha ('' = agent gốc). */
  parentAgentId: string;
  /** true = cha không còn trong snapshot (mồ côi). */
  orphan: boolean;
  /** Độ sâu trong cây spawn (0 = gốc). */
  depth: number;
  owner: string;
  status: FleetV14TaskStatus;
  cpuCores: number;
  ramMb: number;
  /** Epoch ms bắt đầu chạy (allocatedAt). */
  startedAt: number;
  /** Vị trí thẻ trong cột node (px, tính từ đầu cột). */
  x: number;
  y: number;
}

/** Một node trên bản đồ. */
export interface FleetV17VisualNode {
  nodeId: string;
  hostname: string;
  health: string;
  healthScore: number;
  /** Cờ quá tải / rủi ro (UI tô màu theo cờ). */
  overloaded: boolean;
  atRisk: boolean;
  overloadReasons: string[];
  cpuFraction: number;
  ramFraction: number;
  taskSlotsUsed: number;
  taskSlotsTotal: number;
  labels: Record<string, string>;
  agentIds: string[];
  /** Vị trí cột node trên lưới (px). */
  x: number;
  y: number;
}

/** Một edge cha → con trên bản đồ. */
export interface FleetV17VisualEdge {
  fromAgentId: string;
  toAgentId: string;
  /** true = edge tới agent mồ côi (cha đã mất — vẽ nét đứt). */
  orphan: boolean;
}

/** Tóm tắt toàn fleet trên bản đồ. */
export interface FleetV17VisualSummary {
  totalAgents: number;
  runningAgents: number;
  pendingAgents: number;
  migratingAgents: number;
  orphanAgents: number;
  nodeCount: number;
  overloadedNodeCount: number;
  atRiskNodeCount: number;
  /** Chuỗi spawn sâu nhất (depth lớn nhất). */
  maxDepth: number;
  /** Agent chạy lâu nhất (taskId + số ms đã chạy). */
  longestRunning: { agentId: string; runningMs: number } | null;
  /** Node "nóng" nhất (CPU cao nhất). */
  hottestNode: { nodeId: string; cpuFraction: number } | null;
  /** Số agent theo owner (top 5). */
  topOwners: { owner: string; count: number }[];
}

/** Toàn bộ bản đồ sub-agent. */
export interface FleetV17SubAgentMap {
  nodes: FleetV17VisualNode[];
  agents: FleetV17VisualAgent[];
  edges: FleetV17VisualEdge[];
  summary: FleetV17VisualSummary;
  at: number;
}

/**
 * Xây bản đồ sub-agent từ snapshot fleet + health check v17 +
 * capacity summary + liên kết cha-con (caller cung cấp — vd từ
 * event `agent.spawn` của tầng agent). Node removed không lên bản
 * đồ; task done/failed/cancelled không lên bản đồ.
 */
export function buildFleetV17SubAgentMap(
  snapshot: FleetV14Snapshot,
  healthChecks: readonly FleetV17HealthCheck[],
  capacity: FleetV17CapacitySummary,
  parentLinks: readonly FleetV17AgentParentLink[] = [],
  now = Date.now(),
): FleetV17SubAgentMap {
  const healthByNode = new Map(healthChecks.map((h) => [h.nodeId, h]));
  const parentByTask = new Map(parentLinks.map((l) => [l.taskId, l.parentTaskId]));
  const liveNodes = snapshot.nodes.filter((n) => n.status !== 'removed');
  const liveTasks = snapshot.tasks.filter(
    (t) => t.status === 'pending' || t.status === 'running' || t.status === 'migrating',
  );
  const liveTaskIds = new Set(liveTasks.map((t) => t.task.taskId));

  // Độ sâu trong cây spawn (đi ngược parent chain, chống vòng lặp).
  const depthOf = (taskId: string): number => {
    let depth = 0;
    let current = taskId;
    const seen = new Set<string>([taskId]);
    for (let i = 0; i < 100; i++) {
      const parent = parentByTask.get(current);
      if (!parent || !liveTaskIds.has(parent)) break;
      if (seen.has(parent)) break;
      seen.add(parent);
      depth += 1;
      current = parent;
    }
    return depth;
  };

  // Vị trí: node xếp theo cột (x = index * width), agent xếp dọc
  // trong cột node (y = thứ tự trong node * card height).
  const agentIndexByNode = new Map<string, number>();
  const agents: FleetV17VisualAgent[] = liveTasks
    .map((allocated) => {
      const task = allocated.task;
      const parent = parentByTask.get(task.taskId) ?? '';
      const orphan = parent !== '' && !liveTaskIds.has(parent);
      const node = snapshot.nodes.find((n) => n.nodeId === allocated.nodeId);
      const nodeIndex = Math.max(0, liveNodes.findIndex((n) => n.nodeId === allocated.nodeId));
      const slot = agentIndexByNode.get(allocated.nodeId) ?? 0;
      agentIndexByNode.set(allocated.nodeId, slot + 1);
      return {
        agentId: task.taskId,
        taskId: task.taskId,
        kind: task.kind,
        nodeId: allocated.nodeId,
        parentAgentId: parent,
        orphan,
        depth: depthOf(task.taskId),
        owner: task.createdBy,
        status: allocated.status,
        cpuCores: task.cpuCores,
        ramMb: task.ramMb,
        startedAt: allocated.allocatedAt,
        x: nodeIndex * FLEET_V17_VIS_NODE_COLUMN_WIDTH + 8,
        y: 64 + slot * FLEET_V17_VIS_AGENT_CARD_HEIGHT,
      } satisfies FleetV17VisualAgent;
    })
    .sort((a, b) => a.depth - b.depth || a.startedAt - b.startedAt);

  const nodes: FleetV17VisualNode[] = liveNodes.map((node, index) => {
    const health = healthByNode.get(node.nodeId);
    const cpuFraction = node.capacity.cpuCores === 0 ? 0 : node.usedCpuCores / node.capacity.cpuCores;
    const ramFraction = node.capacity.ramTotalMb === 0 ? 0 : node.usedRamMb / node.capacity.ramTotalMb;
    const overloadReasons: string[] = [];
    if (cpuFraction >= FLEET_V17_VIS_OVERLOAD_FRACTION) {
      overloadReasons.push(`CPU ${(cpuFraction * 100).toFixed(0)}% >= 80%`);
    }
    if (ramFraction >= FLEET_V17_VIS_OVERLOAD_FRACTION) {
      overloadReasons.push(`RAM ${(ramFraction * 100).toFixed(0)}% >= 80%`);
    }
    if (node.runningTaskIds.length >= node.capacity.maxTasks) {
      overloadReasons.push(`hết task slot (${node.runningTaskIds.length}/${node.capacity.maxTasks})`);
    }
    const atRisk = (health?.health ?? 'healthy') === 'unhealthy' || (health?.health ?? 'healthy') === 'down';
    return {
      nodeId: node.nodeId,
      hostname: node.hostname,
      health: health?.health ?? 'healthy',
      healthScore: health?.score ?? 100,
      overloaded: overloadReasons.length > 0,
      atRisk,
      overloadReasons,
      cpuFraction: Math.round(cpuFraction * 1000) / 1000,
      ramFraction: Math.round(ramFraction * 1000) / 1000,
      taskSlotsUsed: node.runningTaskIds.length,
      taskSlotsTotal: node.capacity.maxTasks,
      labels: { ...node.labels },
      agentIds: agents.filter((a) => a.nodeId === node.nodeId).map((a) => a.agentId),
      x: index * FLEET_V17_VIS_NODE_COLUMN_WIDTH,
      y: 0,
    } satisfies FleetV17VisualNode;
  });

  const edges: FleetV17VisualEdge[] = agents
    .filter((a) => a.parentAgentId !== '')
    .map((a) => ({ fromAgentId: a.parentAgentId, toAgentId: a.agentId, orphan: a.orphan }));

  const ownerCounts = new Map<string, number>();
  for (const a of agents) ownerCounts.set(a.owner, (ownerCounts.get(a.owner) ?? 0) + 1);
  const topOwners = [...ownerCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([owner, count]) => ({ owner, count }));

  let longestRunning: FleetV17VisualSummary['longestRunning'] = null;
  for (const a of agents) {
    const runningMs = now - a.startedAt;
    if (!longestRunning || runningMs > longestRunning.runningMs) {
      longestRunning = { agentId: a.agentId, runningMs };
    }
  }
  let hottestNode: FleetV17VisualSummary['hottestNode'] = null;
  for (const n of nodes) {
    if (!hottestNode || n.cpuFraction > hottestNode.cpuFraction) {
      hottestNode = { nodeId: n.nodeId, cpuFraction: n.cpuFraction };
    }
  }

  const summary: FleetV17VisualSummary = {
    totalAgents: agents.length,
    runningAgents: agents.filter((a) => a.status === 'running').length,
    pendingAgents: agents.filter((a) => a.status === 'pending').length,
    migratingAgents: agents.filter((a) => a.status === 'migrating').length,
    orphanAgents: agents.filter((a) => a.orphan).length,
    nodeCount: nodes.length,
    overloadedNodeCount: nodes.filter((n) => n.overloaded).length,
    atRiskNodeCount: nodes.filter((n) => n.atRisk).length,
    maxDepth: agents.reduce((m, a) => Math.max(m, a.depth), 0),
    longestRunning,
    hottestNode,
    topOwners,
  };
  void capacity;
  return { nodes, agents, edges, summary, at: now };
}

/** Lỗi validate bản đồ (dùng khi UI nhận map qua IPC), '' = hợp lệ. */
export function validateFleetV17SubAgentMap(map: FleetV17SubAgentMap): string {
  const nodeIds = new Set(map.nodes.map((n) => n.nodeId));
  for (const agent of map.agents) {
    if (!nodeIds.has(agent.nodeId)) return `agent ${agent.agentId} trỏ tới node không có trên bản đồ: ${agent.nodeId}`;
  }
  const agentIds = new Set(map.agents.map((a) => a.agentId));
  for (const edge of map.edges) {
    if (!agentIds.has(edge.toAgentId)) return `edge trỏ tới agent không có trên bản đồ: ${edge.toAgentId}`;
    if (!edge.orphan && !agentIds.has(edge.fromAgentId)) {
      return `edge trỏ từ agent không có trên bản đồ: ${edge.fromAgentId}`;
    }
  }
  for (const node of map.nodes) {
    for (const agentId of node.agentIds) {
      if (!agentIds.has(agentId)) return `node ${node.nodeId} liệt kê agent không có trên bản đồ: ${agentId}`;
    }
  }
  return '';
}

/** Tóm tắt bản đồ thành một dòng text (để log / tooltip dashboard). */
export function fleetV17SubAgentMapSummaryText(map: FleetV17SubAgentMap): string {
  const s = map.summary;
  return (
    `${s.totalAgents} sub-agent trên ${s.nodeCount} node ` +
    `(${s.runningAgents} running, ${s.pendingAgents} pending, ${s.migratingAgents} migrating` +
    `${s.orphanAgents > 0 ? `, ${s.orphanAgents} mồ côi` : ''}` +
    `${s.overloadedNodeCount > 0 ? `, ${s.overloadedNodeCount} node quá tải` : ''}` +
    `${s.atRiskNodeCount > 0 ? `, ${s.atRiskNodeCount} node rủi ro` : ''})`
  );
}

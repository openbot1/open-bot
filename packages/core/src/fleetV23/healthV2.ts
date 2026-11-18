/**
 * Fleet health v2 cho fleet v23 (v1.36, Đội T6) — chấm sức khoẻ node
 * / zone / fleet + alert.
 *
 * Fleet v21 biết node online/offline và heartbeat ageing, nhưng không
 * chấm SỨC KHOẺ: một node online nhưng lỗi liên tục, heartbeat cũ,
 * tải 99% vẫn được tính như node tốt. Fleet v22 probe tài nguyên host
 * nhưng không rollup sức khoẻ fleet. Module này chấm điểm và báo động:
 *
 * - Node health 0..100, 4 thành phần: availability (online + uptime),
 *   reliability (độ tin cậy lịch sử), load (tải càng cao càng trừ),
 *   freshness (heartbeat càng cũ càng trừ). Trạng thái: healthy /
 *   degraded / critical / dead.
 * - Fleet health rollup: điểm trung bình, số node mỗi trạng thái,
 *   node tệ nhất, zone nào đang degraded (≥ 50% node trong zone
 *   dead/critical), group nào có nguy cơ mất quorum (bot của group
 *   đang nằm trên node dead/critical).
 * - Alert rules: node chết, node critical, zone degraded, group có
 *   nguy cơ mất quorum, heartbeat cũ (node online nhưng không báo cáo
 *   lâu). Mỗi alert có severity + thông điệp 1 dòng.
 * - Health history: lưu snapshot theo thời gian, xu hướng
 *   (improving/declining/stable) qua N snapshot gần nhất, lần incident
 *   gần nhất (lần đầu fleet có node critical/dead).
 *
 * Module thuần: host đo input thật (heartbeat, lỗi, tải) rồi đưa vào;
 * module chỉ chấm + kết luận.
 */

import type { FleetV23Topology } from './topology';

/** Trạng thái sức khoẻ node. */
export type FleetV23HealthStatus = 'healthy' | 'degraded' | 'critical' | 'dead';

/** Mọi trạng thái sức khoẻ. */
export const FLEET_V23_HEALTH_STATUSES: readonly FleetV23HealthStatus[] = ['healthy', 'degraded', 'critical', 'dead'];

/** Ngưỡng heartbeat: mới hơn thì tươi, cũ hơn thì coi như chết. */
export const FLEET_V23_HEARTBEAT_FRESH_MS = 30_000;
export const FLEET_V23_HEARTBEAT_STALE_MS = 5 * 60_000;

/** Input chấm sức khoẻ một node (host đo thật). */
export interface FleetV23NodeHealthInput {
  /** Id node. */
  nodeId: string;
  /** Zone node thuộc (null khi chưa gắn zone). */
  zoneId: string | null;
  /** Node có online không. */
  online: boolean;
  /** Lần heartbeat gần nhất (epoch ms) — null khi chưa từng heartbeat. */
  lastHeartbeatAtMs: number | null;
  /** Độ tin cậy lịch sử 0..100 (100 = chưa từng lỗi). */
  reliability: number;
  /** Tỉ lệ CPU đang dùng (0..1). */
  cpuUsedFraction: number;
  /** Tỉ lệ RAM đang dùng (0..1). */
  ramUsedFraction: number;
  /** Số lần lỗi liên tiếp gần đây (để trừ điểm reliability thực tế). */
  consecutiveFailures: number;
  /** Thời gian node chạy liên tục (ms) — null khi không biết. */
  uptimeMs: number | null;
}

/** Điểm sức khoẻ một node. */
export interface FleetV23NodeHealth {
  nodeId: string;
  zoneId: string | null;
  /** Tổng điểm 0..100. */
  score: number;
  /** Điểm thành phần (tổng = score). */
  breakdown: {
    availability: number;
    reliability: number;
    load: number;
    freshness: number;
  };
  status: FleetV23HealthStatus;
  /** Lý do chính (1 dòng, để UI/alert). */
  reason: string;
  /** Tuổi heartbeat (ms; null khi chưa từng heartbeat). */
  heartbeatAgeMs: number | null;
}

/** Validate input chấm sức khoẻ (lỗi → danh sách). */
export function validateFleetV23NodeHealthInput(input: unknown): string[] {
  const errors: string[] = [];
  if (typeof input !== 'object' || input === null) return ['node health input phải là object.'];
  const n = input as Record<string, unknown>;
  if (typeof n.nodeId !== 'string' || n.nodeId.trim().length === 0) errors.push('input.nodeId phải là chuỗi không rỗng.');
  if (typeof n.reliability !== 'number' || (n.reliability as number) < 0 || (n.reliability as number) > 100) {
    errors.push('input.reliability phải là số 0..100.');
  }
  for (const field of ['cpuUsedFraction', 'ramUsedFraction'] as const) {
    if (typeof n[field] !== 'number' || (n[field] as number) < 0 || (n[field] as number) > 1) {
      errors.push(`input.${field} phải là số 0..1.`);
    }
  }
  if (typeof n.consecutiveFailures !== 'number' || !Number.isInteger(n.consecutiveFailures) || (n.consecutiveFailures as number) < 0) {
    errors.push('input.consecutiveFailures phải là số nguyên >= 0.');
  }
  if (typeof n.online !== 'boolean') errors.push('input.online phải là boolean.');
  if (n.lastHeartbeatAtMs !== null && (typeof n.lastHeartbeatAtMs !== 'number' || (n.lastHeartbeatAtMs as number) < 0)) {
    errors.push('input.lastHeartbeatAtMs phải là epoch ms >= 0 hoặc null.');
  }
  return errors;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Chấm sức khoẻ một node (trọng số: availability 40, reliability 25,
 * load 20, freshness 15 — tổng 100):
 * - availability: offline → 0; online → 40 (uptime < 1 phút trừ một
 *   nửa vì node vừa lên chưa chứng minh được gì — tránh dồn job vào
 *   node mới lên chưa ổn định).
 * - reliability: reliability/100 × 25, trừ thêm 3 điểm mỗi lần lỗi
 *   liên tiếp (tối đa trừ hết 25 — node lỗi hoài thì không tin được).
 * - load: tải cao nhất (CPU/RAM) càng cao càng trừ: 0% tải = 20 điểm,
 *   100% tải = 0 điểm (node đầy không nhận thêm job).
 * - freshness: heartbeat < 30s = 15 điểm; 30s..5 phút giảm tuyến tính
 *   về 0; > 5 phút hoặc chưa từng heartbeat = 0.
 * Trạng thái: dead khi offline hoặc heartbeat > 5 phút; critical khi
 * điểm < 40; degraded khi < 70; còn lại healthy.
 */
export function scoreFleetV23NodeHealth(
  input: FleetV23NodeHealthInput,
  now: number = Date.now(),
): FleetV23NodeHealth {
  const errors = validateFleetV23NodeHealthInput(input);
  if (errors.length > 0) throw new Error(`Node health input không hợp lệ: ${errors.join(' ')}`);
  const heartbeatAgeMs = input.lastHeartbeatAtMs === null ? null : Math.max(0, now - input.lastHeartbeatAtMs);
  const availability = !input.online
    ? 0
    : input.uptimeMs !== null && input.uptimeMs < 60_000
      ? 20
      : 40;
  const reliability = Math.max(
    0,
    round2((25 * input.reliability) / 100) - Math.min(25, input.consecutiveFailures * 3),
  );
  const maxLoad = Math.max(input.cpuUsedFraction, input.ramUsedFraction);
  const load = round2(20 * (1 - maxLoad));
  let freshness: number;
  if (heartbeatAgeMs === null) freshness = 0;
  else if (heartbeatAgeMs <= FLEET_V23_HEARTBEAT_FRESH_MS) freshness = 15;
  else if (heartbeatAgeMs >= FLEET_V23_HEARTBEAT_STALE_MS) freshness = 0;
  else {
    freshness = round2(15 * (1 - (heartbeatAgeMs - FLEET_V23_HEARTBEAT_FRESH_MS) / (FLEET_V23_HEARTBEAT_STALE_MS - FLEET_V23_HEARTBEAT_FRESH_MS)));
  }
  const score = round2(availability + reliability + load + freshness);
  let status: FleetV23HealthStatus;
  let reason: string;
  if (!input.online) {
    status = 'dead';
    reason = `Node "${input.nodeId}" offline.`;
  } else if (heartbeatAgeMs !== null && heartbeatAgeMs >= FLEET_V23_HEARTBEAT_STALE_MS) {
    status = 'dead';
    reason = `Node "${input.nodeId}" online nhưng heartbeat cũ ${Math.round(heartbeatAgeMs / 1000)}s (ngưỡng ${FLEET_V23_HEARTBEAT_STALE_MS / 1000}s) — coi như chết.`;
  } else if (heartbeatAgeMs === null) {
    status = 'critical';
    reason = `Node "${input.nodeId}" chưa từng heartbeat — không biết nó còn sống không.`;
  } else if (score < 40) {
    status = 'critical';
    reason = `Node "${input.nodeId}" điểm sức khoẻ ${score}/100 (< 40): ${describeWeakest(input, { availability, reliability, load, freshness })}.`;
  } else if (score < 70) {
    status = 'degraded';
    reason = `Node "${input.nodeId}" điểm sức khoẻ ${score}/100 (< 70): ${describeWeakest(input, { availability, reliability, load, freshness })}.`;
  } else {
    status = 'healthy';
    reason = `Node "${input.nodeId}" khoẻ (${score}/100).`;
  }
  return {
    nodeId: input.nodeId,
    zoneId: input.zoneId,
    score,
    breakdown: { availability, reliability, load, freshness },
    status,
    reason,
    heartbeatAgeMs,
  };
}

function describeWeakest(
  input: FleetV23NodeHealthInput,
  breakdown: { availability: number; reliability: number; load: number; freshness: number },
): string {
  const parts: [string, number, number][] = [
    ['reliability', breakdown.reliability, 25],
    ['load', breakdown.load, 20],
    ['freshness', breakdown.freshness, 15],
    ['availability', breakdown.availability, 40],
  ];
  const weakest = parts
    .map(([name, got, max]) => ({ name, frac: got / max }))
    .sort((a, b) => a.frac - b.frac)[0];
  switch (weakest?.name) {
    case 'reliability':
      return `độ tin cậy thấp (${input.reliability}/100, ${input.consecutiveFailures} lỗi liên tiếp)`;
    case 'load':
      return `tải cao (CPU ${Math.round(input.cpuUsedFraction * 100)}%, RAM ${Math.round(input.ramUsedFraction * 100)}%)`;
    case 'freshness':
      return 'heartbeat cũ';
    default:
      return 'availability thấp';
  }
}

// ---------------------------------------------------------------------------
// Fleet health rollup
// ---------------------------------------------------------------------------

/** Sức khoẻ tổng hợp của fleet. */
export interface FleetV23FleetHealth {
  /** Điểm trung bình các node (null khi không có node). */
  meanScore: number | null;
  /** Số node mỗi trạng thái. */
  byStatus: Record<FleetV23HealthStatus, number>;
  /** Node tệ nhất (điểm thấp nhất; hoà → id nhỏ hơn). */
  worstNodeId: string | null;
  /** Zone đang degraded (≥ 50% node trong zone dead/critical). */
  degradedZones: string[];
  /** Group có nguy cơ mất quorum (bot của group trên node dead/critical). */
  groupsAtRisk: string[];
  /** true khi fleet có node dead/critical. */
  hasIncident: boolean;
  /** Tóm tắt 1 dòng. */
  summary: string;
}

/**
 * Rollup sức khoẻ fleet từ điểm từng node + topology + placement:
 * - Zone degraded khi ≥ 50% node trong zone dead/critical (zone chỉ
 *   có 1 node mà node đó chết → zone degraded luôn).
 * - Group at risk khi số bot của group còn sống (trên node healthy /
 *   degraded) < quorum của group.
 */
export function rollupFleetV23Health(input: {
  nodeHealth: readonly FleetV23NodeHealth[];
  topology?: FleetV23Topology;
  placement?: ReadonlyMap<string, string> | Record<string, string>;
}): FleetV23FleetHealth {
  const { nodeHealth } = input;
  const byStatus: Record<FleetV23HealthStatus, number> = { healthy: 0, degraded: 0, critical: 0, dead: 0 };
  for (const h of nodeHealth) byStatus[h.status] += 1;
  const meanScore =
    nodeHealth.length === 0
      ? null
      : round2(nodeHealth.reduce((s, h) => s + h.score, 0) / nodeHealth.length);
  const worst =
    nodeHealth.length === 0
      ? null
      : [...nodeHealth].sort((a, b) => a.score - b.score || a.nodeId.localeCompare(b.nodeId))[0];
  // Zone degraded: nhóm node theo zone, tính tỉ lệ dead/critical.
  const byZone = new Map<string, FleetV23NodeHealth[]>();
  for (const h of nodeHealth) {
    if (h.zoneId === null) continue;
    const list = byZone.get(h.zoneId) ?? [];
    list.push(h);
    byZone.set(h.zoneId, list);
  }
  const degradedZones: string[] = [];
  for (const [zoneId, list] of byZone) {
    const bad = list.filter((h) => h.status === 'dead' || h.status === 'critical').length;
    if (list.length > 0 && bad / list.length >= 0.5) degradedZones.push(zoneId);
  }
  degradedZones.sort();
  // Group at risk: bot trên node dead/critical thì coi như mất.
  const groupsAtRisk: string[] = [];
  if (input.topology && input.placement !== undefined) {
    const placement = input.placement;
    const nodeStatus = new Map(nodeHealth.map((h) => [h.nodeId, h.status]));
    const nodeOf = (botId: string): string | undefined =>
      placement instanceof Map ? placement.get(botId) : (placement as Record<string, string>)[botId];
    for (const group of input.topology.groups) {
      const alive = group.botIds.filter((botId) => {
        const nodeId = nodeOf(botId);
        if (nodeId === undefined) return false;
        const status = nodeStatus.get(nodeId);
        return status === 'healthy' || status === 'degraded';
      }).length;
      if (alive < group.quorum) groupsAtRisk.push(group.id);
    }
  }
  groupsAtRisk.sort();
  const hasIncident = byStatus.dead > 0 || byStatus.critical > 0;
  const summary =
    nodeHealth.length === 0
      ? 'Fleet không có node nào để chấm sức khoẻ.'
      : `Fleet ${nodeHealth.length} node, điểm trung bình ${meanScore}/100: ${byStatus.healthy} healthy, ${byStatus.degraded} degraded, ${byStatus.critical} critical, ${byStatus.dead} dead` +
        (degradedZones.length > 0 ? `; zone degraded: ${degradedZones.join(', ')}` : '') +
        (groupsAtRisk.length > 0 ? `; group nguy cơ mất quorum: ${groupsAtRisk.join(', ')}` : '') +
        '.';
  return {
    meanScore,
    byStatus,
    worstNodeId: worst?.nodeId ?? null,
    degradedZones,
    groupsAtRisk,
    hasIncident,
    summary,
  };
}

// ---------------------------------------------------------------------------
// Alerts
// ---------------------------------------------------------------------------

/** Mức độ alert. */
export type FleetV23AlertSeverity = 'critical' | 'warning' | 'info';

/** Một alert sức khoẻ. */
export interface FleetV23HealthAlert {
  severity: FleetV23AlertSeverity;
  /** Loại: node-dead | node-critical | zone-degraded | group-quorum-risk | stale-heartbeat. */
  kind: 'node-dead' | 'node-critical' | 'zone-degraded' | 'group-quorum-risk' | 'stale-heartbeat';
  /** Node/group/zone liên quan. */
  targetId: string;
  /** Thông điệp 1 dòng. */
  message: string;
}

/**
 * Sinh alert từ điểm node + rollup fleet:
 * - node dead → critical; node critical → critical; node degraded +
 *   heartbeat cũ (> 30s nhưng < 5 phút) → warning stale-heartbeat;
 * - zone degraded → warning; group nguy cơ mất quorum → critical.
 * Sắp theo severity (critical trước) rồi targetId.
 */
export function fleetV23HealthAlerts(input: {
  nodeHealth: readonly FleetV23NodeHealth[];
  fleetHealth: FleetV23FleetHealth;
}): FleetV23HealthAlert[] {
  const alerts: FleetV23HealthAlert[] = [];
  for (const h of input.nodeHealth) {
    if (h.status === 'dead') {
      alerts.push({ severity: 'critical', kind: 'node-dead', targetId: h.nodeId, message: h.reason });
    } else if (h.status === 'critical') {
      alerts.push({ severity: 'critical', kind: 'node-critical', targetId: h.nodeId, message: h.reason });
    } else if (
      h.status === 'degraded' &&
      h.heartbeatAgeMs !== null &&
      h.heartbeatAgeMs > FLEET_V23_HEARTBEAT_FRESH_MS
    ) {
      alerts.push({
        severity: 'warning',
        kind: 'stale-heartbeat',
        targetId: h.nodeId,
        message: `Node "${h.nodeId}" heartbeat cũ ${Math.round(h.heartbeatAgeMs / 1000)}s (tươi < ${FLEET_V23_HEARTBEAT_FRESH_MS / 1000}s).`,
      });
    }
  }
  for (const zoneId of input.fleetHealth.degradedZones) {
    alerts.push({
      severity: 'warning',
      kind: 'zone-degraded',
      targetId: zoneId,
      message: `Zone "${zoneId}" degraded (≥ 50% node trong zone dead/critical).`,
    });
  }
  for (const groupId of input.fleetHealth.groupsAtRisk) {
    alerts.push({
      severity: 'critical',
      kind: 'group-quorum-risk',
      targetId: groupId,
      message: `Group "${groupId}" có nguy cơ mất quorum (bot còn sống < quorum — bot đang nằm trên node dead/critical).`,
    });
  }
  const rank = (s: FleetV23AlertSeverity): number => (s === 'critical' ? 0 : s === 'warning' ? 1 : 2);
  return alerts.sort((a, b) => rank(a.severity) - rank(b.severity) || a.targetId.localeCompare(b.targetId));
}

// ---------------------------------------------------------------------------
// History: snapshot + trend
// ---------------------------------------------------------------------------

/** Một snapshot sức khoẻ fleet tại một thời điểm. */
export interface FleetV23HealthSnapshot {
  at: number;
  meanScore: number | null;
  healthy: number;
  degraded: number;
  critical: number;
  dead: number;
}

/** Lịch sử sức khoẻ (append-only, giới hạn để không phình). */
export class FleetV23HealthHistory {
  private readonly snapshots: FleetV23HealthSnapshot[] = [];

  constructor(private readonly maxEntries: number = 500) {}

  /** Ghi một snapshot từ rollup fleet. */
  record(health: FleetV23FleetHealth, at: number = Date.now()): FleetV23HealthSnapshot {
    const snapshot: FleetV23HealthSnapshot = {
      at,
      meanScore: health.meanScore,
      healthy: health.byStatus.healthy,
      degraded: health.byStatus.degraded,
      critical: health.byStatus.critical,
      dead: health.byStatus.dead,
    };
    this.snapshots.push(snapshot);
    while (this.snapshots.length > this.maxEntries) this.snapshots.shift();
    return snapshot;
  }

  /** Mọi snapshot (cũ → mới). */
  list(): FleetV23HealthSnapshot[] {
    return [...this.snapshots];
  }

  /** Xu hướng điểm trung bình qua N snapshot gần nhất. */
  trend(lastN = 5): 'improving' | 'declining' | 'stable' | 'unknown' {
    const recent = this.snapshots.slice(-lastN).filter((s) => s.meanScore !== null);
    if (recent.length < 2) return 'unknown';
    const first = recent[0]?.meanScore as number;
    const last = recent[recent.length - 1]?.meanScore as number;
    if (last - first >= 5) return 'improving';
    if (first - last >= 5) return 'declining';
    return 'stable';
  }

  /** Lần incident gần nhất (snapshot đầu tiên có dead/critical, từ mới về cũ). */
  lastIncident(): FleetV23HealthSnapshot | undefined {
    return [...this.snapshots].reverse().find((s) => s.dead > 0 || s.critical > 0);
  }

  get size(): number {
    return this.snapshots.length;
  }
}

/**
 * Fleet health monitoring v19 — giám sát sức khỏe fleet theo lịch sử
 * (v1.29, Đội T6).
 *
 * Tầng trên của health v17 (`fleetV17/fleetV17.ts` — điểm health 0..100
 * từ probe gần nhất + heartbeat stale) và health v15 (scoring + trend
 * đơn giản). V17 trả lời "node này khỏe mấy điểm NGAY BÂY GIỜ"; v19
 * trả lời 5 câu vận hành theo THỜI GIAN:
 *
 * - LỊCH SỬ HEALTH: mỗi node giữ một cửa sổ trượt các health sample
 *   (điểm 0..100 + mức + lý do), cắt bớt khi quá dài; từ đó tính trung
 *   bình, min/max, độ lệch, uptime % trong cửa sổ — để UI vẽ sparkline
 *   và biết node "hay chập chờn" chứ không chỉ "đang khỏe".
 * - XU HƯỚNG (TREND): so sánh nửa đầu / nửa sau cửa sổ (độ dốc tuyến
 *   tính đơn giản): improving / stable / degrading / volatile (dao
 *   động mạnh); degrading liên tục N cửa sổ → cảnh báo sớm trước khi
 *   node rớt hẳn.
 * - ĐIỂM FLEET TỔNG HỢP: điểm fleet = trung bình có trọng số theo số
 *   task đang chạy (node càng gánh nhiều task càng nặng); kèm phân bố
 *   mức health toàn fleet và node tệ nhất — một con số để dashboard
 *   hiển thị ngay.
 * - CẢNH BÁO (ALERT): rule theo ngưỡng (điểm < X, fail liên tiếp >= N,
 *   flapping: đổi mức >= K lần trong cửa sổ, node down quá T); alert
 *   có vòng đời raise → ack → resolve (+ auto-resolve khi điều kiện
 *   hết), dedupe theo (rule, node) trong cooldown, và mức độ
 *   critical/warning/info.
 * - FLAPPING: phát hiện node đổi mức health liên tục (probe chập chờn
 *   / mạng không ổn định) để không spam alert từng lần đổi mức.
 *
 * Module này KHÔNG đo probe thật, KHÔNG chạm mạng, KHÔNG gửi thông
 * báo: nó nhận sample/check do caller đo thật và quyết định "xu hướng
 * ra sao, có cảnh báo không, cảnh báo nào đang mở" — việc đo và gửi
 * cảnh báo do caller làm.
 */

import type { FleetV14NodeHealth } from '../fleetV14/fleetV14';
import { FLEET_V14_NODE_HEALTHS } from '../fleetV14/fleetV14';
import type { FleetV17HealthCheck } from '../fleetV17/fleetV17';

/** Số health sample tối đa giữ mỗi node trong cửa sổ trượt. */
export const FLEET_V19_MAX_HISTORY_SAMPLES = 120;
/** Cửa sổ mặc định để tính trend/uptime: 1 giờ. */
export const FLEET_V19_DEFAULT_WINDOW_MS = 60 * 60 * 1000;
/** Độ dốc (điểm/phút) mà trend được coi là improving/degrading. */
export const FLEET_V19_TREND_SLOPE_PER_MIN = 0.5;
/** Độ lệch chuẩn mà trend được coi là volatile (dao động mạnh). */
export const FLEET_V19_VOLATILE_STDDEV = 18;
/** Số lần đổi mức trong cửa sổ → node bị coi là flapping. */
export const FLEET_V19_FLAP_CHANGES = 4;
/** Cooldown mặc định giữa hai alert cùng (rule, node): 15 phút. */
export const FLEET_V19_ALERT_COOLDOWN_MS = 15 * 60 * 1000;

// ---------------------------------------------------------------------------
// Lịch sử health theo node
// ---------------------------------------------------------------------------

/** Một điểm health trong lịch sử của một node. */
export interface FleetV19HealthPoint {
  nodeId: string;
  /** Điểm 0..100 (100 = hoàn toàn khỏe). */
  score: number;
  health: FleetV14NodeHealth;
  /** Số probe fail liên tiếp tại thời điểm này (0 = không fail). */
  consecutiveFailures: number;
  at: number;
}

/** Lỗi validate health point, '' = hợp lệ. */
export function validateFleetV19HealthPoint(point: FleetV19HealthPoint): string {
  if (typeof point.nodeId !== 'string' || point.nodeId.length === 0) return 'nodeId không được rỗng';
  if (!Number.isFinite(point.score) || point.score < 0 || point.score > 100) return 'score phải trong 0..100';
  if (!FLEET_V14_NODE_HEALTHS.includes(point.health)) return `health không hợp lệ: ${point.health}`;
  if (!Number.isInteger(point.consecutiveFailures) || point.consecutiveFailures < 0) {
    return 'consecutiveFailures phải là số nguyên >= 0';
  }
  if (!Number.isFinite(point.at) || point.at <= 0) return 'at phải là epoch ms > 0';
  return '';
}

/** Lịch sử health toàn fleet: nodeId -> các điểm, cũ nhất ở đầu. */
export type FleetV19HealthHistory = Record<string, FleetV19HealthPoint[]>;

/**
 * Thêm một điểm health vào lịch sử (trả về lịch sử mới, không mutate):
 * điểm mới vào cuối, cắt bớt đầu khi vượt quá maxSamples, và loại các
 * điểm cũ hơn windowMs so với điểm mới nhất.
 */
export function appendFleetV19HealthPoint(
  history: FleetV19HealthHistory,
  point: FleetV19HealthPoint,
  opts: { maxSamples?: number; windowMs?: number } = {},
): FleetV19HealthHistory {
  const err = validateFleetV19HealthPoint(point);
  if (err !== '') throw new Error(err);
  const maxSamples = opts.maxSamples ?? FLEET_V19_MAX_HISTORY_SAMPLES;
  const windowMs = opts.windowMs ?? FLEET_V19_DEFAULT_WINDOW_MS;
  const prev = history[point.nodeId] ?? [];
  const kept = [...prev, point]
    .filter((p) => point.at - p.at <= windowMs)
    .slice(-Math.max(1, maxSamples));
  return { ...history, [point.nodeId]: kept };
}

/** Chuyển một FleetV17HealthCheck thành health point v19. */
export function fleetV19PointFromV17Check(
  check: FleetV17HealthCheck,
): FleetV19HealthPoint {
  return {
    nodeId: check.nodeId,
    score: check.score,
    health: check.health,
    consecutiveFailures: check.consecutiveFailures,
    at: check.at,
  };
}

// ---------------------------------------------------------------------------
// Thống kê cửa sổ + xu hướng
// ---------------------------------------------------------------------------

/** Xu hướng sức khỏe của một node trong cửa sổ. */
export type FleetV19Trend = 'improving' | 'stable' | 'degrading' | 'volatile' | 'unknown';

/** Thống kê sức khỏe của một node trong cửa sổ. */
export interface FleetV19NodeStats {
  nodeId: string;
  /** Số sample trong cửa sổ. */
  samples: number;
  /** Điểm trung bình (null = chưa có sample). */
  avgScore: number | null;
  minScore: number | null;
  maxScore: number | null;
  /** Độ lệch chuẩn của điểm (đo độ dao động). */
  stddev: number | null;
  /** % thời gian node ở mức healthy trong cửa sổ (0..100, null = chưa có sample). */
  uptimePct: number | null;
  /** Mức health của sample mới nhất (null = chưa có sample). */
  latestHealth: FleetV14NodeHealth | null;
  latestScore: number | null;
  /** Số lần đổi mức health trong cửa sổ. */
  levelChanges: number;
  /** true = node đổi mức quá nhiều (flapping). */
  flapping: boolean;
  trend: FleetV19Trend;
  /** Độ dốc điểm/phút (null = không đủ sample để tính). */
  slopePerMin: number | null;
  /** Epoch ms của sample đầu / cuối trong cửa sổ (null = chưa có sample). */
  windowStartAt: number | null;
  windowEndAt: number | null;
}

/** Thống kê rỗng cho node chưa có sample nào. */
export function emptyFleetV19NodeStats(nodeId: string): FleetV19NodeStats {
  return {
    nodeId,
    samples: 0,
    avgScore: null,
    minScore: null,
    maxScore: null,
    stddev: null,
    uptimePct: null,
    latestHealth: null,
    latestScore: null,
    levelChanges: 0,
    flapping: false,
    trend: 'unknown',
    slopePerMin: null,
    windowStartAt: null,
    windowEndAt: null,
  };
}

/**
 * Tính độ dốc tuyến tính (least squares) của điểm theo thời gian,
 * đơn vị điểm/phút. Trả null khi < 2 sample hoặc toàn bộ cùng thời điểm.
 */
export function fleetV19SlopePerMin(points: readonly FleetV19HealthPoint[]): number | null {
  if (points.length < 2) return null;
  const n = points.length;
  let sumX = 0;
  let sumY = 0;
  let sumXy = 0;
  let sumX2 = 0;
  for (const p of points) {
    const x = p.at / 60000;
    sumX += x;
    sumY += p.score;
    sumXy += x * p.score;
    sumX2 += x * x;
  }
  const denom = n * sumX2 - sumX * sumX;
  if (denom === 0) return null;
  return (n * sumXy - sumX * sumY) / denom;
}

/** Tính thống kê cửa sổ của một node từ các điểm đã sắp theo thời gian. */
export function summarizeFleetV19NodeHistory(
  nodeId: string,
  points: readonly FleetV19HealthPoint[],
): FleetV19NodeStats {
  if (points.length === 0) return emptyFleetV19NodeStats(nodeId);
  const scores = points.map((p) => p.score);
  const sum = scores.reduce((a, b) => a + b, 0);
  const avg = sum / scores.length;
  const min = Math.min(...scores);
  const max = Math.max(...scores);
  const variance =
    scores.reduce((a, s) => a + (s - avg) * (s - avg), 0) / scores.length;
  const stddev = Math.sqrt(variance);
  const healthyCount = points.filter((p) => p.health === 'healthy').length;
  let levelChanges = 0;
  for (let i = 1; i < points.length; i++) {
    if (points[i].health !== points[i - 1].health) levelChanges++;
  }
  const slope = fleetV19SlopePerMin(points);
  let trend: FleetV19Trend = 'stable';
  if (stddev >= FLEET_V19_VOLATILE_STDDEV || levelChanges >= FLEET_V19_FLAP_CHANGES) {
    trend = 'volatile';
  } else if (slope !== null && slope >= FLEET_V19_TREND_SLOPE_PER_MIN) {
    trend = 'improving';
  } else if (slope !== null && slope <= -FLEET_V19_TREND_SLOPE_PER_MIN) {
    trend = 'degrading';
  }
  const latest = points[points.length - 1];
  return {
    nodeId,
    samples: points.length,
    avgScore: Math.round(avg * 10) / 10,
    minScore: min,
    maxScore: max,
    stddev: Math.round(stddev * 10) / 10,
    uptimePct: Math.round((healthyCount / points.length) * 1000) / 10,
    latestHealth: latest.health,
    latestScore: latest.score,
    levelChanges,
    flapping: levelChanges >= FLEET_V19_FLAP_CHANGES,
    trend,
    slopePerMin: slope === null ? null : Math.round(slope * 100) / 100,
    windowStartAt: points[0].at,
    windowEndAt: latest.at,
  };
}

// ---------------------------------------------------------------------------
// Điểm fleet tổng hợp
// ---------------------------------------------------------------------------

/** Điểm sức khỏe tổng hợp toàn fleet. */
export interface FleetV19FleetScore {
  at: number;
  /** Điểm fleet 0..100 (trung bình có trọng số theo task đang chạy). */
  score: number;
  /** Số node được tính (node có sample). */
  nodeCount: number;
  /** Số node đang chạy task (có trọng số > 0). */
  weightedNodeCount: number;
  /** Phân bố mức health: healthy/degraded/unhealthy/down -> số node. */
  byHealth: Record<FleetV14NodeHealth, number>;
  /** Node tệ nhất (điểm thấp nhất, null = không có node nào). */
  worstNodeId: string | null;
  worstScore: number | null;
  /** Node tốt nhất (điểm cao nhất, null = không có node nào). */
  bestNodeId: string | null;
  bestScore: number | null;
  /** % node đang healthy (0..100). */
  healthyPct: number;
}

/**
 * Tính điểm fleet: mỗi node đóng góp điểm mới nhất của nó, trọng số =
 * 1 + số task đang chạy (node gánh nhiều task thì ảnh hưởng nhiều hơn).
 * Node không có sample bị bỏ qua. Fleet rỗng → score 100 (không có gì
 * hỏng) nhưng nodeCount 0 để UI phân biệt.
 */
export function summarizeFleetV19Score(
  statsByNode: ReadonlyMap<string, FleetV19NodeStats> | Record<string, FleetV19NodeStats>,
  runningTasksByNode: ReadonlyMap<string, number> | Record<string, number>,
  at: number,
): FleetV19FleetScore {
  const entries: [string, FleetV19NodeStats][] =
    statsByNode instanceof Map
      ? [...statsByNode.entries()]
      : Object.entries(statsByNode);
  const tasksOf = (nodeId: string): number => {
    if (runningTasksByNode instanceof Map) return runningTasksByNode.get(nodeId) ?? 0;
    return (runningTasksByNode as Record<string, number>)[nodeId] ?? 0;
  };
  const byHealth: Record<FleetV14NodeHealth, number> = {
    healthy: 0,
    degraded: 0,
    unhealthy: 0,
    down: 0,
  };
  let weightedSum = 0;
  let weightTotal = 0;
  let weightedNodeCount = 0;
  let worstNodeId: string | null = null;
  let worstScore: number | null = null;
  let bestNodeId: string | null = null;
  let bestScore: number | null = null;
  let counted = 0;
  for (const [nodeId, stats] of entries) {
    if (stats.latestScore === null || stats.latestHealth === null) continue;
    counted++;
    byHealth[stats.latestHealth]++;
    const weight = 1 + Math.max(0, tasksOf(nodeId));
    weightedSum += stats.latestScore * weight;
    weightTotal += weight;
    if (tasksOf(nodeId) > 0) weightedNodeCount++;
    if (worstScore === null || stats.latestScore < worstScore) {
      worstScore = stats.latestScore;
      worstNodeId = nodeId;
    }
    if (bestScore === null || stats.latestScore > bestScore) {
      bestScore = stats.latestScore;
      bestNodeId = nodeId;
    }
  }
  return {
    at,
    score: weightTotal === 0 ? 100 : Math.round((weightedSum / weightTotal) * 10) / 10,
    nodeCount: counted,
    weightedNodeCount,
    byHealth,
    worstNodeId,
    worstScore,
    bestNodeId,
    bestScore,
    healthyPct: counted === 0 ? 100 : Math.round((byHealth.healthy / counted) * 1000) / 10,
  };
}

// ---------------------------------------------------------------------------
// Cảnh báo (alert) — rule + vòng đời
// ---------------------------------------------------------------------------

/** Mức độ cảnh báo. */
export type FleetV19AlertLevel = 'critical' | 'warning' | 'info';

export const FLEET_V19_ALERT_LEVELS: readonly FleetV19AlertLevel[] = [
  'critical',
  'warning',
  'info',
];

/** Loại điều kiện kích hoạt alert. */
export type FleetV19AlertRuleKind =
  | 'score-below' // điểm node < threshold
  | 'fail-streak' // fail liên tiếp >= threshold
  | 'flapping' // node đổi mức quá nhiều trong cửa sổ
  | 'degrading-trend' // trend degrading với điểm đang giảm
  | 'node-down' // node ở mức down
  | 'fleet-score-below'; // điểm fleet < threshold

export const FLEET_V19_ALERT_RULE_KINDS: readonly FleetV19AlertRuleKind[] = [
  'score-below',
  'fail-streak',
  'flapping',
  'degrading-trend',
  'node-down',
  'fleet-score-below',
];

/** Một rule cảnh báo (do admin cấu hình, lưu file). */
export interface FleetV19AlertRule {
  id: string;
  kind: FleetV19AlertRuleKind;
  level: FleetV19AlertLevel;
  /** Ngưỡng (điểm / số lần fail / số lần đổi mức — tùy kind). */
  threshold: number;
  /** Bật hay tắt rule. */
  enabled: boolean;
  /** Cooldown riêng của rule (ms); null = dùng mặc định 15 phút. */
  cooldownMs: number | null;
  /** Chỉ áp dụng cho các node này (rỗng = mọi node). */
  nodeIds: string[];
}

/** Lỗi validate rule, '' = hợp lệ. */
export function validateFleetV19AlertRule(rule: FleetV19AlertRule): string {
  if (typeof rule.id !== 'string' || rule.id.length === 0) return 'id không được rỗng';
  if (!FLEET_V19_ALERT_RULE_KINDS.includes(rule.kind)) return `kind không hợp lệ: ${rule.kind}`;
  if (!FLEET_V19_ALERT_LEVELS.includes(rule.level)) return `level không hợp lệ: ${rule.level}`;
  if (!Number.isFinite(rule.threshold)) return 'threshold phải là số';
  if (rule.kind === 'score-below' || rule.kind === 'fleet-score-below') {
    if (rule.threshold < 0 || rule.threshold > 100) return 'threshold điểm phải trong 0..100';
  } else if (rule.threshold < 1 || !Number.isInteger(rule.threshold)) {
    return 'threshold số lần phải là số nguyên >= 1';
  }
  if (rule.cooldownMs !== null && (!Number.isFinite(rule.cooldownMs) || rule.cooldownMs < 0)) {
    return 'cooldownMs phải >= 0 hoặc null';
  }
  return '';
}

/** Trạng thái vòng đời của một alert. */
export type FleetV19AlertStatus = 'open' | 'acked' | 'resolved';

/** Một alert đã kích hoạt. */
export interface FleetV19Alert {
  id: string;
  ruleId: string;
  kind: FleetV19AlertRuleKind;
  level: FleetV19AlertLevel;
  /** '' = alert cấp fleet (không gắn node cụ thể). */
  nodeId: string;
  message: string;
  status: FleetV19AlertStatus;
  raisedAt: number;
  ackedAt: number | null;
  ackedBy: string;
  resolvedAt: number | null;
  /** Số lần rule kích hoạt lại trong lúc alert đang mở (để UI thấy mức độ lặp). */
  retriggerCount: number;
  lastTriggeredAt: number;
}

/** Đầu vào để đánh giá rule: stats + điểm fleet hiện tại. */
export interface FleetV19AlertInput {
  statsByNode: ReadonlyMap<string, FleetV19NodeStats> | Record<string, FleetV19NodeStats>;
  fleetScore: FleetV19FleetScore;
  /** Điểm fail-streak mới nhất mỗi node (nodeId -> số lần). */
  failStreakByNode: ReadonlyMap<string, number> | Record<string, number>;
  at: number;
}

function streakOf(
  map: ReadonlyMap<string, number> | Record<string, number>,
  nodeId: string,
): number {
  if (map instanceof Map) return map.get(nodeId) ?? 0;
  return (map as Record<string, number>)[nodeId] ?? 0;
}

/**
 * Đánh giá các rule trên dữ liệu hiện tại và trả về các alert MỚI CẦN
 * RAISE (chưa có alert open/acked cùng rule+node, hoặc đã hết cooldown
 * kể từ lần trigger cuối của alert đang mở). Caller chịu trách nhiệm
 * gộp vào store (xem `raiseFleetV19Alerts`); hàm này chỉ quyết định
 * "rule nào đang vi phạm" — tách riêng để test rule không cần store.
 */
export function evaluateFleetV19AlertRules(
  rules: readonly FleetV19AlertRule[],
  input: FleetV19AlertInput,
): { rule: FleetV19AlertRule; nodeId: string; message: string }[] {
  const out: { rule: FleetV19AlertRule; nodeId: string; message: string }[] = [];
  const statsEntries =
    input.statsByNode instanceof Map
      ? [...input.statsByNode.entries()]
      : Object.entries(input.statsByNode);
  for (const rule of rules) {
    if (!rule.enabled) continue;
    if (validateFleetV19AlertRule(rule) !== '') continue;
    if (rule.kind === 'fleet-score-below') {
      if (input.fleetScore.nodeCount > 0 && input.fleetScore.score < rule.threshold) {
        out.push({
          rule,
          nodeId: '',
          message: `Điểm fleet ${input.fleetScore.score} dưới ngưỡng ${rule.threshold}`,
        });
      }
      continue;
    }
    for (const [nodeId, stats] of statsEntries) {
      if (rule.nodeIds.length > 0 && !rule.nodeIds.includes(nodeId)) continue;
      if (stats.latestScore === null || stats.latestHealth === null) continue;
      switch (rule.kind) {
        case 'score-below':
          if (stats.latestScore < rule.threshold) {
            out.push({
              rule,
              nodeId,
              message: `Node ${nodeId} điểm ${stats.latestScore} dưới ngưỡng ${rule.threshold}`,
            });
          }
          break;
        case 'fail-streak': {
          const streak = streakOf(input.failStreakByNode, nodeId);
          if (streak >= rule.threshold) {
            out.push({
              rule,
              nodeId,
              message: `Node ${nodeId} fail liên tiếp ${streak} lần (>= ${rule.threshold})`,
            });
          }
          break;
        }
        case 'flapping':
          if (stats.levelChanges >= rule.threshold) {
            out.push({
              rule,
              nodeId,
              message: `Node ${nodeId} đổi mức sức khỏe ${stats.levelChanges} lần trong cửa sổ (>= ${rule.threshold})`,
            });
          }
          break;
        case 'degrading-trend':
          if (stats.trend === 'degrading' && stats.latestScore < rule.threshold) {
            out.push({
              rule,
              nodeId,
              message: `Node ${nodeId} đang xấu dần (điểm ${stats.latestScore} < ${rule.threshold})`,
            });
          }
          break;
        case 'node-down':
          if (stats.latestHealth === 'down') {
            out.push({
              rule,
              nodeId,
              message: `Node ${nodeId} đang down`,
            });
          }
          break;
        default:
          break;
      }
    }
  }
  return out;
}

/** Store alert: danh sách alert + seq để sinh id. */
export interface FleetV19AlertStore {
  alerts: FleetV19Alert[];
  seq: number;
}

/** Store alert rỗng. */
export function createFleetV19AlertStore(): FleetV19AlertStore {
  return { alerts: [], seq: 0 };
}

/**
 * Gộp các trigger mới vào store (trả store mới, không mutate):
 * - trigger (rule, node) đã có alert open/acked → tăng retriggerCount
 *   (chỉ khi đã hết cooldown của rule, nếu không thì bỏ qua để chống spam);
 * - chưa có → tạo alert open mới, id `alert-<seq>`.
 */
export function raiseFleetV19Alerts(
  store: FleetV19AlertStore,
  triggers: readonly { rule: FleetV19AlertRule; nodeId: string; message: string }[],
  at: number,
): FleetV19AlertStore {
  let alerts = [...store.alerts];
  let seq = store.seq;
  for (const trigger of triggers) {
    const cooldown = trigger.rule.cooldownMs ?? FLEET_V19_ALERT_COOLDOWN_MS;
    const existing = alerts.find(
      (a) =>
        a.ruleId === trigger.rule.id &&
        a.nodeId === trigger.nodeId &&
        a.status !== 'resolved',
    );
    if (existing) {
      if (at - existing.lastTriggeredAt < cooldown) continue;
      alerts = alerts.map((a) =>
        a.id === existing.id
          ? { ...a, retriggerCount: a.retriggerCount + 1, lastTriggeredAt: at }
          : a,
      );
      continue;
    }
    seq++;
    alerts = [
      ...alerts,
      {
        id: `alert-${seq}`,
        ruleId: trigger.rule.id,
        kind: trigger.rule.kind,
        level: trigger.rule.level,
        nodeId: trigger.nodeId,
        message: trigger.message,
        status: 'open',
        raisedAt: at,
        ackedAt: null,
        ackedBy: '',
        resolvedAt: null,
        retriggerCount: 0,
        lastTriggeredAt: at,
      },
    ];
  }
  return { alerts, seq };
}

/** Ack một alert đang open (trả store mới; ack alert đã resolve/acked = không đổi). */
export function ackFleetV19Alert(
  store: FleetV19AlertStore,
  alertId: string,
  userId: string,
  at: number,
): FleetV19AlertStore {
  return {
    ...store,
    alerts: store.alerts.map((a) =>
      a.id === alertId && a.status === 'open'
        ? { ...a, status: 'acked', ackedAt: at, ackedBy: userId }
        : a,
    ),
  };
}

/** Resolve một alert đang open/acked (trả store mới). */
export function resolveFleetV19Alert(
  store: FleetV19AlertStore,
  alertId: string,
  at: number,
): FleetV19AlertStore {
  return {
    ...store,
    alerts: store.alerts.map((a) =>
      a.id === alertId && a.status !== 'resolved'
        ? { ...a, status: 'resolved', resolvedAt: at }
        : a,
    ),
  };
}

/**
 * Auto-resolve: các alert open/acked mà điều kiện đã hết (rule+node
 * không còn trong danh sách trigger hiện tại) thì resolve. Trả store
 * mới + số alert đã resolve.
 */
export function autoResolveFleetV19Alerts(
  store: FleetV19AlertStore,
  activeTriggers: readonly { rule: FleetV19AlertRule; nodeId: string }[],
  at: number,
): { store: FleetV19AlertStore; resolvedCount: number } {
  const activeKeys = new Set(activeTriggers.map((t) => `${t.rule.id}\n${t.nodeId}`));
  let resolvedCount = 0;
  const alerts = store.alerts.map((a) => {
    if (a.status === 'resolved') return a;
    if (activeKeys.has(`${a.ruleId}\n${a.nodeId}`)) return a;
    resolvedCount++;
    return { ...a, status: 'resolved' as const, resolvedAt: at };
  });
  return { store: { ...store, alerts }, resolvedCount };
}

/** Liệt kê alert đang mở (open + acked), nghiêm trọng trước, mới trước. */
export function listFleetV19OpenAlerts(store: FleetV19AlertStore): FleetV19Alert[] {
  const rank: Record<FleetV19AlertLevel, number> = { critical: 0, warning: 1, info: 2 };
  return store.alerts
    .filter((a) => a.status !== 'resolved')
    .sort((a, b) => rank[a.level] - rank[b.level] || b.raisedAt - a.raisedAt);
}

/** Tóm tắt alert: số open theo mức + tổng đã resolve. */
export function summarizeFleetV19Alerts(store: FleetV19AlertStore): {
  open: number;
  acked: number;
  resolved: number;
  byLevel: Record<FleetV19AlertLevel, number>;
} {
  const byLevel: Record<FleetV19AlertLevel, number> = { critical: 0, warning: 0, info: 0 };
  let open = 0;
  let acked = 0;
  let resolved = 0;
  for (const a of store.alerts) {
    if (a.status === 'resolved') resolved++;
    else {
      byLevel[a.level]++;
      if (a.status === 'open') open++;
      else acked++;
    }
  }
  return { open, acked, resolved, byLevel };
}

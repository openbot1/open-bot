/**
 * Fleet health v12 — health dashboard mở rộng theo node, có model
 * local đang chạy + alert rule cấu hình được + history ngắn hạn
 * (v1.15, Đội T6).
 *
 * Tầng trên của health v11 (`fleetV11Health.ts` — đánh giá node/bot
 * theo CPU/RAM/disk/heartbeat, alert theo ngưỡng cố định, incident
 * log). V11 trả lời "node này có khỏe không"; module này trả lời
 * "node này đang chạy model gì, có đúng model đã pin không, rule nào
 * đang bắn, và xu hướng 15 phút qua ra sao".
 *
 * - Sample mở rộng: `FleetV12NodeSample` nối tiếp sample v11, thêm
 *   model đang load (`loadedModelId`, `modelStatus` — verified /
 *   drift / unverified / none), tốc độ sinh token (tok/s, null khi
 *   không chạy inference) và số request đang chờ.
 * - Alert rule cấu hình được: mỗi rule chọn một metric (cpu/ram/disk/
 *   heartbeat-stale/model-drift/tokens-per-sec), toán tử so sánh,
 *   ngưỡng, thời lượng vi phạm liên tục tối thiểu (ms) và mức
 *   (info/warning/critical). Rule tắt thì không bắn. Rule không hợp
 *   lệ bị `validateFleetV12AlertRule` từ chối kèm lý do.
 * - History ngắn hạn: ring buffer tối đa N sample/node (mặc định 60,
 *   ~15 phút nếu probe mỗi 15s) — đủ để vẽ sparkline và tính xu
 *   hướng (tăng/giảm) mà không phình file. Lưu trong
 *   `<fleetRoot>/fleet-health-v115.json` (atomic tmp + rename, mode
 *   0600); alert đã bắn + cooldown lưu cùng file để không spam.
 * - Dashboard: `buildFleetV12HealthDashboard` — rollup toàn fleet
 *   (node theo trạng thái + theo model, tài nguyên trung bình, alert
 *   đang mở theo mức, node tệ nhất, model drift) từ sample + rule +
 *   history, hàm thuần, không đọc file.
 *
 * Module này KHÔNG spawn process, KHÔNG tự restart/drain node: nó
 * quyết định "nên cảnh báo gì, mức nào, xu hướng ra sao" — việc thực
 * hiện do FleetServiceManager / caller làm. Probe local đo thật bằng
 * `node:os` + `fs.statfsSync` (như v11); node LAN xa do caller cung
 * cấp sample qua heartbeat.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/** File lưu trạng thái health v12 trong fleet root. */
export const FLEET_V12_HEALTH_FILE = 'fleet-health-v115.json';
/** Số sample tối đa giữ lại cho mỗi node trong history ngắn hạn. */
export const FLEET_V12_MAX_SAMPLES_PER_NODE = 60;
/** Số node tối đa theo dõi trong file trạng thái. */
export const FLEET_V12_MAX_TRACKED_NODES = 200;
/** Số alert đang mở tối đa trong dashboard (mới nhất trước). */
export const FLEET_V12_MAX_OPEN_ALERTS = 200;
/** Cooldown tối thiểu giữa hai lần bắn cùng một rule trên cùng node (ms). */
export const FLEET_V12_DEFAULT_ALERT_COOLDOWN_MS = 5 * 60_000;
/** Heartbeat quá từng này ms chưa thấy thì coi là stale (mặc định). */
export const FLEET_V12_DEFAULT_HEARTBEAT_TIMEOUT_MS = 60_000;
/** Heartbeat quá từng này ms chưa thấy thì coi node là down (mặc định). */
export const FLEET_V12_DEFAULT_DOWN_AFTER_MS = 5 * 60_000;

/** Trạng thái sức khoẻ của một node v12. */
export type FleetV12HealthStatus = 'healthy' | 'degraded' | 'unhealthy' | 'down';

export const FLEET_V12_HEALTH_STATUSES: readonly FleetV12HealthStatus[] = [
  'healthy',
  'degraded',
  'unhealthy',
  'down',
];

/** Mức độ alert v12. */
export type FleetV12AlertLevel = 'info' | 'warning' | 'critical';

export const FLEET_V12_ALERT_LEVELS: readonly FleetV12AlertLevel[] = [
  'info',
  'warning',
  'critical',
];

/** Trạng thái model local đang load trên node. */
export type FleetV12ModelStatus = 'verified' | 'drift' | 'unverified' | 'none';

export const FLEET_V12_MODEL_STATUSES: readonly FleetV12ModelStatus[] = [
  'verified',
  'drift',
  'unverified',
  'none',
];

/** Metric mà một alert rule có thể theo dõi. */
export type FleetV12AlertMetric =
  | 'cpuPct'
  | 'ramPct'
  | 'diskPct'
  | 'heartbeatStaleMs'
  | 'modelDrift'
  | 'tokensPerSec';

export const FLEET_V12_ALERT_METRICS: readonly FleetV12AlertMetric[] = [
  'cpuPct',
  'ramPct',
  'diskPct',
  'heartbeatStaleMs',
  'modelDrift',
  'tokensPerSec',
];

/** Toán tử so sánh của alert rule. */
export type FleetV12AlertOperator = '>' | '>=' | '<' | '<=' | '==';

export const FLEET_V12_ALERT_OPERATORS: readonly FleetV12AlertOperator[] = [
  '>',
  '>=',
  '<',
  '<=',
  '==',
];

/** Một sample sức khỏe của node (mở rộng từ sample v11). */
export interface FleetV12NodeSample {
  nodeId: string;
  /** Epoch ms lúc lấy sample. */
  at: number;
  cpuPct: number;
  ramPct: number;
  diskPct: number;
  uptimeMs: number;
  /** Epoch ms heartbeat cuối (null = chưa bao giờ thấy). */
  lastHeartbeatAt: number | null;
  botCount: number;
  botCapacity: number;
  /** Model GGUF đang load trên node ('' = không load model nào). */
  loadedModelId: string;
  /** Trạng thái verify của model đang load (so với pin manifest). */
  modelStatus: FleetV12ModelStatus;
  /** Tốc độ sinh token (tok/s, null = không chạy inference lúc này). */
  tokensPerSec: number | null;
  /** Số request đang chờ xử lý trên node. */
  pendingRequests: number;
}

/** Một alert rule cấu hình được. */
export interface FleetV12AlertRule {
  id: string;
  /** Tên hiển thị, vd `CPU cao`. */
  name: string;
  metric: FleetV12AlertMetric;
  operator: FleetV12AlertOperator;
  /** Ngưỡng so sánh (đơn vị theo metric: % cho cpu/ram/disk, ms cho heartbeat, tok/s cho tokensPerSec, 1/0 cho modelDrift). */
  threshold: number;
  /** Vi phạm liên tục tối thiểu từng này ms mới bắn alert (0 = bắn ngay). */
  durationMs: number;
  level: FleetV12AlertLevel;
  enabled: boolean;
  /** Cooldown giữa hai lần bắn cùng rule trên cùng node (ms). */
  cooldownMs: number;
}

/** Rule mặc định: CPU/RAM/disk cao, heartbeat stale, model drift. */
export const DEFAULT_FLEET_V12_ALERT_RULES: readonly FleetV12AlertRule[] = [
  {
    id: 'cpu-high',
    name: 'CPU cao',
    metric: 'cpuPct',
    operator: '>',
    threshold: 80,
    durationMs: 60_000,
    level: 'warning',
    enabled: true,
    cooldownMs: FLEET_V12_DEFAULT_ALERT_COOLDOWN_MS,
  },
  {
    id: 'cpu-critical',
    name: 'CPU rất cao',
    metric: 'cpuPct',
    operator: '>',
    threshold: 95,
    durationMs: 30_000,
    level: 'critical',
    enabled: true,
    cooldownMs: FLEET_V12_DEFAULT_ALERT_COOLDOWN_MS,
  },
  {
    id: 'ram-high',
    name: 'RAM cao',
    metric: 'ramPct',
    operator: '>',
    threshold: 80,
    durationMs: 60_000,
    level: 'warning',
    enabled: true,
    cooldownMs: FLEET_V12_DEFAULT_ALERT_COOLDOWN_MS,
  },
  {
    id: 'ram-critical',
    name: 'RAM rất cao',
    metric: 'ramPct',
    operator: '>',
    threshold: 95,
    durationMs: 30_000,
    level: 'critical',
    enabled: true,
    cooldownMs: FLEET_V12_DEFAULT_ALERT_COOLDOWN_MS,
  },
  {
    id: 'disk-high',
    name: 'Đĩa gần đầy',
    metric: 'diskPct',
    operator: '>',
    threshold: 85,
    durationMs: 60_000,
    level: 'warning',
    enabled: true,
    cooldownMs: FLEET_V12_DEFAULT_ALERT_COOLDOWN_MS,
  },
  {
    id: 'heartbeat-stale',
    name: 'Heartbeat quá hạn',
    metric: 'heartbeatStaleMs',
    operator: '>',
    threshold: FLEET_V12_DEFAULT_HEARTBEAT_TIMEOUT_MS,
    durationMs: 0,
    level: 'warning',
    enabled: true,
    cooldownMs: FLEET_V12_DEFAULT_ALERT_COOLDOWN_MS,
  },
  {
    id: 'model-drift',
    name: 'Model bị thay đổi',
    metric: 'modelDrift',
    operator: '==',
    threshold: 1,
    durationMs: 0,
    level: 'critical',
    enabled: true,
    cooldownMs: FLEET_V12_DEFAULT_ALERT_COOLDOWN_MS,
  },
  {
    id: 'tokens-low',
    name: 'Tốc độ sinh token thấp',
    metric: 'tokensPerSec',
    operator: '<',
    threshold: 5,
    durationMs: 120_000,
    level: 'warning',
    enabled: true,
    cooldownMs: FLEET_V12_DEFAULT_ALERT_COOLDOWN_MS,
  },
];

/** Một alert đang mở (đã bắn, chưa hết). */
export interface FleetV12Alert {
  id: string;
  ruleId: string;
  ruleName: string;
  nodeId: string;
  metric: FleetV12AlertMetric;
  level: FleetV12AlertLevel;
  /** Giá trị đo được lúc bắn. */
  value: number;
  threshold: number;
  message: string;
  firstSeenAt: number;
  lastSeenAt: number;
  acknowledged: boolean;
  acknowledgedBy: string | null;
}

/** Một check riêng lẻ trong kết quả đánh giá node. */
export interface FleetV12HealthCheck {
  name: string;
  passed: boolean;
  level: FleetV12AlertLevel;
  detail: string;
}

/** Kết quả đánh giá sức khỏe một node. */
export interface FleetV12HealthResult {
  nodeId: string;
  status: FleetV12HealthStatus;
  checks: FleetV12HealthCheck[];
  worstReason: string;
  loadedModelId: string;
  modelStatus: FleetV12ModelStatus;
}

/** Xu hướng của một metric trong history ngắn hạn. */
export type FleetV12Trend = 'rising' | 'falling' | 'stable' | 'unknown';

export const FLEET_V12_TRENDS: readonly FleetV12Trend[] = [
  'rising',
  'falling',
  'stable',
  'unknown',
];

/** Tóm tắt history ngắn hạn của một node (để vẽ sparkline/xu hướng). */
export interface FleetV12NodeHistorySummary {
  nodeId: string;
  sampleCount: number;
  firstAt: number | null;
  lastAt: number | null;
  avgCpuPct: number | null;
  avgRamPct: number | null;
  maxCpuPct: number | null;
  maxRamPct: number | null;
  cpuTrend: FleetV12Trend;
  ramTrend: FleetV12Trend;
  /** % sample có model drift trong cửa sổ. */
  driftSamplePct: number;
}

/** Trạng thái theo dõi health v12 (lưu file). */
export interface FleetV12HealthState {
  version: 1;
  rules: FleetV12AlertRule[];
  /** History ngắn hạn: nodeId -> sample (mới nhất cuối). */
  history: Record<string, FleetV12NodeSample[]>;
  /** Alert đang mở. */
  openAlerts: FleetV12Alert[];
  /** Lần bắn cuối của (ruleId + nodeId) — để enforce cooldown. */
  lastFiredAt: Record<string, number>;
  /** Epoch ms sample đầu tiên vi phạm liên tục của (ruleId + nodeId). */
  violationStartedAt: Record<string, number>;
  updatedAt: number;
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

function clampPct(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(100, v));
}

/** Validate một alert rule. Trả về danh sách lỗi (rỗng = hợp lệ). */
export function validateFleetV12AlertRule(rule: FleetV12AlertRule): string[] {
  const errors: string[] = [];
  if (!isNonEmptyString(rule?.id)) errors.push('id rule không được trống');
  if (!isNonEmptyString(rule?.name)) errors.push('tên rule không được trống');
  if (!FLEET_V12_ALERT_METRICS.includes(rule?.metric)) {
    errors.push(`metric phải là một trong: ${FLEET_V12_ALERT_METRICS.join(', ')}`);
  }
  if (!FLEET_V12_ALERT_OPERATORS.includes(rule?.operator)) {
    errors.push(`operator phải là một trong: ${FLEET_V12_ALERT_OPERATORS.join(', ')}`);
  }
  if (typeof rule?.threshold !== 'number' || !Number.isFinite(rule.threshold)) {
    errors.push('threshold phải là số');
  } else if (
    (rule.metric === 'cpuPct' || rule.metric === 'ramPct' || rule.metric === 'diskPct') &&
    (rule.threshold < 0 || rule.threshold > 100)
  ) {
    errors.push('threshold cho cpu/ram/disk phải trong 0–100 (%)');
  } else if (rule.metric === 'modelDrift' && rule.threshold !== 0 && rule.threshold !== 1) {
    errors.push('threshold cho modelDrift phải là 0 hoặc 1');
  }
  if (typeof rule?.durationMs !== 'number' || !Number.isFinite(rule.durationMs) || rule.durationMs < 0) {
    errors.push('durationMs phải >= 0');
  }
  if (!FLEET_V12_ALERT_LEVELS.includes(rule?.level)) {
    errors.push(`level phải là một trong: ${FLEET_V12_ALERT_LEVELS.join(', ')}`);
  }
  if (typeof rule?.cooldownMs !== 'number' || !Number.isFinite(rule.cooldownMs) || rule.cooldownMs < 0) {
    errors.push('cooldownMs phải >= 0');
  }
  return errors;
}

/** Tạo state health v12 mới (rule mặc định, chưa có history/alert). */
export function createFleetV12HealthState(now = Date.now()): FleetV12HealthState {
  return {
    version: 1,
    rules: DEFAULT_FLEET_V12_ALERT_RULES.map((r) => ({ ...r })),
    history: {},
    openAlerts: [],
    lastFiredAt: {},
    violationStartedAt: {},
    updatedAt: now,
  };
}

/** Lấy giá trị metric từ một sample (null = không đo được). */
export function fleetV12MetricValue(
  sample: FleetV12NodeSample,
  metric: FleetV12AlertMetric,
  now = Date.now(),
): number | null {
  switch (metric) {
    case 'cpuPct':
      return clampPct(sample.cpuPct);
    case 'ramPct':
      return clampPct(sample.ramPct);
    case 'diskPct':
      return clampPct(sample.diskPct);
    case 'heartbeatStaleMs':
      return sample.lastHeartbeatAt === null ? null : Math.max(0, now - sample.lastHeartbeatAt);
    case 'modelDrift':
      return sample.modelStatus === 'drift' ? 1 : 0;
    case 'tokensPerSec':
      return sample.tokensPerSec === null ? null : sample.tokensPerSec;
    default:
      return null;
  }
}

/** So sánh một giá trị với ngưỡng theo toán tử của rule. */
export function fleetV12Compare(
  value: number,
  operator: FleetV12AlertOperator,
  threshold: number,
): boolean {
  switch (operator) {
    case '>':
      return value > threshold;
    case '>=':
      return value >= threshold;
    case '<':
      return value < threshold;
    case '<=':
      return value <= threshold;
    case '==':
      return value === threshold;
    default:
      return false;
  }
}

/**
 * Đánh giá sức khỏe một node từ một sample (hàm thuần): từng check
 * riêng lẻ (cpu/ram/disk/heartbeat/model/tokens) với ngưỡng warn/crit
 * riêng; kết quả `healthy | degraded | unhealthy | down`. Node down
 * khi heartbeat quá hạn downAfterMs hoặc stale mà chưa bao giờ thấy
 * heartbeat. Model drift → ít nhất degraded (không load model đã
 * verify thì không tin được node đó).
 */
export function evaluateFleetV12NodeHealth(
  sample: FleetV12NodeSample,
  opts?: {
    cpuWarnPct?: number;
    cpuCritPct?: number;
    ramWarnPct?: number;
    ramCritPct?: number;
    diskWarnPct?: number;
    diskCritPct?: number;
    heartbeatTimeoutMs?: number;
    downAfterMs?: number;
  },
  now = Date.now(),
): FleetV12HealthResult {
  const cpuWarn = opts?.cpuWarnPct ?? 80;
  const cpuCrit = opts?.cpuCritPct ?? 95;
  const ramWarn = opts?.ramWarnPct ?? 80;
  const ramCrit = opts?.ramCritPct ?? 95;
  const diskWarn = opts?.diskWarnPct ?? 85;
  const diskCrit = opts?.diskCritPct ?? 95;
  const heartbeatTimeoutMs = opts?.heartbeatTimeoutMs ?? FLEET_V12_DEFAULT_HEARTBEAT_TIMEOUT_MS;
  const downAfterMs = opts?.downAfterMs ?? FLEET_V12_DEFAULT_DOWN_AFTER_MS;
  const checks: FleetV12HealthCheck[] = [];
  const cpu = clampPct(sample.cpuPct);
  checks.push({
    name: 'cpu',
    passed: cpu <= cpuWarn,
    level: cpu > cpuCrit ? 'critical' : 'warning',
    detail: `CPU ${cpu.toFixed(1)}% (warn ${cpuWarn}%, crit ${cpuCrit}%)`,
  });
  const ram = clampPct(sample.ramPct);
  checks.push({
    name: 'ram',
    passed: ram <= ramWarn,
    level: ram > ramCrit ? 'critical' : 'warning',
    detail: `RAM ${ram.toFixed(1)}% (warn ${ramWarn}%, crit ${ramCrit}%)`,
  });
  const disk = clampPct(sample.diskPct);
  checks.push({
    name: 'disk',
    passed: disk <= diskWarn,
    level: disk > diskCrit ? 'critical' : 'warning',
    detail: `Đĩa ${disk.toFixed(1)}% (warn ${diskWarn}%, crit ${diskCrit}%)`,
  });
  const staleMs =
    sample.lastHeartbeatAt === null ? Number.POSITIVE_INFINITY : now - sample.lastHeartbeatAt;
  checks.push({
    name: 'heartbeat',
    passed: staleMs <= heartbeatTimeoutMs,
    level: staleMs > downAfterMs ? 'critical' : 'warning',
    detail:
      sample.lastHeartbeatAt === null
        ? 'chưa bao giờ thấy heartbeat'
        : `heartbeat cách đây ${Math.round(staleMs / 1000)}s (ngưỡng ${Math.round(heartbeatTimeoutMs / 1000)}s)`,
  });
  checks.push({
    name: 'model',
    passed: sample.modelStatus === 'verified' || sample.modelStatus === 'none',
    level: sample.modelStatus === 'drift' ? 'critical' : 'warning',
    detail:
      sample.modelStatus === 'none'
        ? 'node không load model local nào'
        : sample.modelStatus === 'verified'
          ? `model ${sample.loadedModelId || '(không rõ)'} đã verify hash`
          : sample.modelStatus === 'drift'
            ? `model ${sample.loadedModelId || '(không rõ)'} bị thay đổi so với bản pin`
            : `model ${sample.loadedModelId || '(không rõ)'} chưa verify hash`,
  });
  if (sample.tokensPerSec !== null) {
    checks.push({
      name: 'tokens',
      passed: sample.tokensPerSec >= 5,
      level: 'warning',
      detail: `tốc độ sinh token ${sample.tokensPerSec.toFixed(1)} tok/s`,
    });
  }
  let status: FleetV12HealthStatus = 'healthy';
  const critFails = checks.filter((c) => !c.passed && c.level === 'critical');
  const warnFails = checks.filter((c) => !c.passed && c.level === 'warning');
  if (staleMs > downAfterMs || sample.lastHeartbeatAt === null) {
    status = 'down';
  } else if (critFails.length > 0) {
    status = 'unhealthy';
  } else if (warnFails.length > 0) {
    status = 'degraded';
  }
  const worst = [...critFails, ...warnFails][0];
  return {
    nodeId: sample.nodeId,
    status,
    checks,
    worstReason: worst?.detail ?? '',
    loadedModelId: sample.loadedModelId,
    modelStatus: sample.modelStatus,
  };
}

/**
 * Tính xu hướng của một dãy số: so trung bình nửa sau với nửa đầu;
 * chênh lệch > 5% thang đo thì rising/falling, ngược lại stable.
 * Ít hơn 4 điểm thì unknown.
 */
export function fleetV12Trend(values: number[]): FleetV12Trend {
  if (values.length < 4) return 'unknown';
  const half = Math.floor(values.length / 2);
  const first = values.slice(0, half);
  const second = values.slice(half);
  const avg = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;
  const diff = avg(second) - avg(first);
  if (diff > 5) return 'rising';
  if (diff < -5) return 'falling';
  return 'stable';
}

/** Tóm tắt history ngắn hạn của một node (hàm thuần). */
export function summarizeFleetV12NodeHistory(
  nodeId: string,
  samples: FleetV12NodeSample[],
): FleetV12NodeHistorySummary {
  const sorted = [...samples].sort((a, b) => a.at - b.at);
  if (sorted.length === 0) {
    return {
      nodeId,
      sampleCount: 0,
      firstAt: null,
      lastAt: null,
      avgCpuPct: null,
      avgRamPct: null,
      maxCpuPct: null,
      maxRamPct: null,
      cpuTrend: 'unknown',
      ramTrend: 'unknown',
      driftSamplePct: 0,
    };
  }
  const avg = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;
  const cpus = sorted.map((s) => clampPct(s.cpuPct));
  const rams = sorted.map((s) => clampPct(s.ramPct));
  const driftCount = sorted.filter((s) => s.modelStatus === 'drift').length;
  return {
    nodeId,
    sampleCount: sorted.length,
    firstAt: sorted[0].at,
    lastAt: sorted[sorted.length - 1].at,
    avgCpuPct: avg(cpus),
    avgRamPct: avg(rams),
    maxCpuPct: Math.max(...cpus),
    maxRamPct: Math.max(...rams),
    cpuTrend: fleetV12Trend(cpus),
    ramTrend: fleetV12Trend(rams),
    driftSamplePct: sorted.length > 0 ? (driftCount / sorted.length) * 100 : 0,
  };
}

/**
 * Ghi một sample mới vào state (hàm thuần, không mutate): append vào
 * history của node (cắt về tối đa N sample), đánh giá các rule đã bật
 * trên sample này (kèm duration + cooldown), trả về state mới + alert
 * vừa bắn + alert đã hết (không còn vi phạm).
 */
export interface FleetV12RecordSampleResult {
  state: FleetV12HealthState;
  /** Alert vừa bắn từ sample này. */
  fired: FleetV12Alert[];
  /** Alert đang mở đã hết vi phạm (đóng lại). */
  resolved: FleetV12Alert[];
  result: FleetV12HealthResult;
}

export function recordFleetV12Sample(
  state: FleetV12HealthState,
  sample: FleetV12NodeSample,
  now = Date.now(),
): FleetV12RecordSampleResult {
  const result = evaluateFleetV12NodeHealth(sample, undefined, now);
  const historyForNode = [...(state.history[sample.nodeId] ?? []), sample]
    .sort((a, b) => a.at - b.at)
    .slice(-FLEET_V12_MAX_SAMPLES_PER_NODE);
  const history = { ...state.history, [sample.nodeId]: historyForNode };
  const lastFiredAt = { ...state.lastFiredAt };
  const violationStartedAt = { ...state.violationStartedAt };
  const fired: FleetV12Alert[] = [];
  const openAlerts = [...state.openAlerts];
  for (const rule of state.rules) {
    if (!rule.enabled) continue;
    if (validateFleetV12AlertRule(rule).length > 0) continue;
    const key = `${rule.id}::${sample.nodeId}`;
    const value = fleetV12MetricValue(sample, rule.metric, now);
    const violating = value !== null && fleetV12Compare(value, rule.operator, rule.threshold);
    if (!violating) {
      delete violationStartedAt[key];
      continue;
    }
    if (violationStartedAt[key] === undefined) violationStartedAt[key] = sample.at;
    const violatedForMs = sample.at - violationStartedAt[key];
    if (violatedForMs < rule.durationMs) continue;
    const lastFired = lastFiredAt[key];
    if (lastFired !== undefined && now - lastFired < rule.cooldownMs) continue;
    const existingIdx = openAlerts.findIndex(
      (a) => a.ruleId === rule.id && a.nodeId === sample.nodeId,
    );
    if (existingIdx >= 0) {
      openAlerts[existingIdx] = {
        ...openAlerts[existingIdx],
        lastSeenAt: now,
        value: value ?? 0,
      };
      continue;
    }
    const alert: FleetV12Alert = {
      id: `al12-${rule.id}-${sample.nodeId}-${now.toString(36)}`,
      ruleId: rule.id,
      ruleName: rule.name,
      nodeId: sample.nodeId,
      metric: rule.metric,
      level: rule.level,
      value: value ?? 0,
      threshold: rule.threshold,
      message: `${rule.name} trên node ${sample.nodeId}: ${value} ${rule.operator} ${rule.threshold}`,
      firstSeenAt: now,
      lastSeenAt: now,
      acknowledged: false,
      acknowledgedBy: null,
    };
    openAlerts.push(alert);
    fired.push(alert);
    lastFiredAt[key] = now;
  }
  // Đóng alert đang mở mà sample mới không còn vi phạm rule của nó.
  const resolved: FleetV12Alert[] = [];
  const keptAlerts: FleetV12Alert[] = [];
  for (const alert of openAlerts) {
    const rule = state.rules.find((r) => r.id === alert.ruleId);
    if (!rule || !rule.enabled) {
      keptAlerts.push(alert);
      continue;
    }
    const value = fleetV12MetricValue(sample, rule.metric, now);
    const stillViolating =
      value !== null && fleetV12Compare(value, rule.operator, rule.threshold);
    if (alert.nodeId === sample.nodeId && !stillViolating) {
      resolved.push(alert);
    } else {
      keptAlerts.push(alert);
    }
  }
  const nextState: FleetV12HealthState = {
    ...state,
    history,
    openAlerts: keptAlerts.slice(0, FLEET_V12_MAX_OPEN_ALERTS),
    lastFiredAt,
    violationStartedAt,
    updatedAt: now,
  };
  return { state: nextState, fired, resolved, result };
}

/** Đánh dấu alert đã xem (ack không xóa alert). */
export function acknowledgeFleetV12Alert(
  state: FleetV12HealthState,
  alertId: string,
  actorUserId: string,
  now = Date.now(),
): FleetV12HealthState {
  if (!isNonEmptyString(alertId) || !isNonEmptyString(actorUserId)) return state;
  return {
    ...state,
    openAlerts: state.openAlerts.map((a) =>
      a.id === alertId ? { ...a, acknowledged: true, acknowledgedBy: actorUserId } : a,
    ),
    updatedAt: now,
  };
}

/** Gộp alert trùng (cùng rule + node) giữ bản mới nhất. */
export function dedupeFleetV12Alerts(alerts: FleetV12Alert[]): FleetV12Alert[] {
  const byKey = new Map<string, FleetV12Alert>();
  for (const alert of alerts) {
    const key = `${alert.ruleId}::${alert.nodeId}`;
    const prev = byKey.get(key);
    if (!prev || alert.lastSeenAt >= prev.lastSeenAt) byKey.set(key, alert);
  }
  return [...byKey.values()].sort((a, b) => b.lastSeenAt - a.lastSeenAt);
}

/** Dashboard health v12: rollup toàn fleet. */
export interface FleetV12HealthDashboard {
  summary: string;
  nodeCount: number;
  byStatus: Record<FleetV12HealthStatus, number>;
  byModel: Record<string, number>;
  driftNodeIds: string[];
  downNodeIds: string[];
  avgCpuPct: number | null;
  avgRamPct: number | null;
  avgTokensPerSec: number | null;
  openAlerts: FleetV12Alert[];
  alertsByLevel: Record<FleetV12AlertLevel, number>;
  worstNodes: { nodeId: string; status: FleetV12HealthStatus; reason: string }[];
  nodeHistories: FleetV12NodeHistorySummary[];
}

/**
 * Xây dashboard từ sample mới nhất của từng node + state (rule/alert/
 * history). Hàm thuần, không đọc file.
 */
export function buildFleetV12HealthDashboard(
  samples: FleetV12NodeSample[],
  state: FleetV12HealthState,
  now = Date.now(),
): FleetV12HealthDashboard {
  const latestByNode = new Map<string, FleetV12NodeSample>();
  for (const s of samples) {
    const prev = latestByNode.get(s.nodeId);
    if (!prev || s.at >= prev.at) latestByNode.set(s.nodeId, s);
  }
  const results = [...latestByNode.values()].map((s) => evaluateFleetV12NodeHealth(s, undefined, now));
  const byStatus: Record<FleetV12HealthStatus, number> = {
    healthy: 0,
    degraded: 0,
    unhealthy: 0,
    down: 0,
  };
  const byModel: Record<string, number> = {};
  const driftNodeIds: string[] = [];
  const downNodeIds: string[] = [];
  let cpuSum = 0;
  let ramSum = 0;
  let tokSum = 0;
  let tokCount = 0;
  for (const r of results) {
    byStatus[r.status] += 1;
    const modelKey = r.loadedModelId || '(không load model)';
    byModel[modelKey] = (byModel[modelKey] ?? 0) + 1;
    if (r.modelStatus === 'drift') driftNodeIds.push(r.nodeId);
    if (r.status === 'down') downNodeIds.push(r.nodeId);
    const sample = latestByNode.get(r.nodeId);
    if (sample) {
      cpuSum += clampPct(sample.cpuPct);
      ramSum += clampPct(sample.ramPct);
      if (sample.tokensPerSec !== null) {
        tokSum += sample.tokensPerSec;
        tokCount += 1;
      }
    }
  }
  const openAlerts = dedupeFleetV12Alerts(state.openAlerts);
  const alertsByLevel: Record<FleetV12AlertLevel, number> = { info: 0, warning: 0, critical: 0 };
  for (const a of openAlerts) alertsByLevel[a.level] += 1;
  const rank: Record<FleetV12HealthStatus, number> = { down: 0, unhealthy: 1, degraded: 2, healthy: 3 };
  const worstNodes = results
    .filter((r) => r.status !== 'healthy')
    .sort((a, b) => rank[a.status] - rank[b.status])
    .slice(0, 5)
    .map((r) => ({ nodeId: r.nodeId, status: r.status, reason: r.worstReason }));
  const nodeHistories = [...latestByNode.keys()].map((nodeId) =>
    summarizeFleetV12NodeHistory(nodeId, state.history[nodeId] ?? []),
  );
  const n = results.length;
  const summary =
    n === 0
      ? 'Chưa có sample health nào cho fleet v12.'
      : `${n} node: ${byStatus.healthy} khỏe, ${byStatus.degraded} giảm, ${byStatus.unhealthy} không khỏe, ${byStatus.down} down; ` +
        `${driftNodeIds.length} node model drift; ${openAlerts.length} alert đang mở ` +
        `(${alertsByLevel.critical} nghiêm trọng).`;
  return {
    summary,
    nodeCount: n,
    byStatus,
    byModel,
    driftNodeIds,
    downNodeIds,
    avgCpuPct: n > 0 ? cpuSum / n : null,
    avgRamPct: n > 0 ? ramSum / n : null,
    avgTokensPerSec: tokCount > 0 ? tokSum / tokCount : null,
    openAlerts,
    alertsByLevel,
    worstNodes,
    nodeHistories,
  };
}

/** Probe local: đo thật máy local bằng node:os + fs.statfsSync. */
export function probeFleetV12LocalNode(
  nodeId: string,
  loadedModelId: string,
  modelStatus: FleetV12ModelStatus,
  tokensPerSec: number | null,
  pendingRequests: number,
  now = Date.now(),
): FleetV12NodeSample {
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const ramPct = totalMem > 0 ? ((totalMem - freeMem) / totalMem) * 100 : 0;
  const load1 = os.loadavg()[0] ?? 0;
  const cpus = Math.max(1, os.cpus().length);
  const cpuPct = clampPct((load1 / cpus) * 100);
  let diskPct = 0;
  try {
    const stat = fs.statfsSync(process.cwd());
    if (stat.bsize > 0 && stat.blocks > 0) {
      diskPct = clampPct(((stat.blocks - stat.bfree) / stat.blocks) * 100);
    }
  } catch {
    diskPct = 0;
  }
  return {
    nodeId,
    at: now,
    cpuPct,
    ramPct,
    diskPct,
    uptimeMs: Math.round(os.uptime() * 1000),
    lastHeartbeatAt: now,
    botCount: 0,
    botCapacity: 1,
    loadedModelId,
    modelStatus,
    tokensPerSec,
    pendingRequests: Math.max(0, Math.floor(pendingRequests)),
  };
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

export function getFleetV12HealthPath(fleetRoot: string): string {
  return path.join(fleetRoot, FLEET_V12_HEALTH_FILE);
}

function atomicWriteFile(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, content, { mode: 0o600 });
  fs.renameSync(tmp, filePath);
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // Nền tảng không hỗ trợ chmod (Windows) — file vẫn dùng được.
  }
}

function isValidRule(v: unknown): v is FleetV12AlertRule {
  if (!v || typeof v !== 'object') return false;
  const r = v as Partial<FleetV12AlertRule>;
  return (
    typeof r.id === 'string' &&
    typeof r.name === 'string' &&
    FLEET_V12_ALERT_METRICS.includes(r.metric as FleetV12AlertMetric) &&
    validateFleetV12AlertRule(r as FleetV12AlertRule).length === 0
  );
}

function isValidSample(v: unknown): v is FleetV12NodeSample {
  if (!v || typeof v !== 'object') return false;
  const s = v as Partial<FleetV12NodeSample>;
  return (
    typeof s.nodeId === 'string' &&
    typeof s.at === 'number' &&
    typeof s.cpuPct === 'number' &&
    typeof s.ramPct === 'number' &&
    typeof s.diskPct === 'number' &&
    FLEET_V12_MODEL_STATUSES.includes(s.modelStatus as FleetV12ModelStatus)
  );
}

function isValidAlert(v: unknown): v is FleetV12Alert {
  if (!v || typeof v !== 'object') return false;
  const a = v as Partial<FleetV12Alert>;
  return (
    typeof a.id === 'string' &&
    typeof a.ruleId === 'string' &&
    typeof a.nodeId === 'string' &&
    FLEET_V12_ALERT_LEVELS.includes(a.level as FleetV12AlertLevel)
  );
}

export function loadFleetV12HealthState(fleetRoot: string): FleetV12HealthState | null {
  try {
    const raw = fs.readFileSync(getFleetV12HealthPath(fleetRoot), 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return null;
    const p = parsed as Partial<FleetV12HealthState>;
    if (p.version !== 1) return null;
    const rules = Array.isArray(p.rules) ? p.rules.filter(isValidRule) : [];
    const history: Record<string, FleetV12NodeSample[]> = {};
    if (p.history && typeof p.history === 'object') {
      for (const [nodeId, samples] of Object.entries(p.history)) {
        if (!Array.isArray(samples)) continue;
        history[nodeId] = samples
          .filter(isValidSample)
          .slice(-FLEET_V12_MAX_SAMPLES_PER_NODE);
      }
    }
    return {
      version: 1,
      rules: rules.length > 0 ? rules : DEFAULT_FLEET_V12_ALERT_RULES.map((r) => ({ ...r })),
      history,
      openAlerts: Array.isArray(p.openAlerts)
        ? p.openAlerts.filter(isValidAlert).slice(0, FLEET_V12_MAX_OPEN_ALERTS)
        : [],
      lastFiredAt:
        p.lastFiredAt && typeof p.lastFiredAt === 'object' ? p.lastFiredAt : {},
      violationStartedAt:
        p.violationStartedAt && typeof p.violationStartedAt === 'object'
          ? p.violationStartedAt
          : {},
      updatedAt: typeof p.updatedAt === 'number' ? p.updatedAt : 0,
    };
  } catch {
    return null;
  }
}

export function saveFleetV12HealthState(
  fleetRoot: string,
  state: FleetV12HealthState,
): void {
  atomicWriteFile(
    getFleetV12HealthPath(fleetRoot),
    `${JSON.stringify(state, null, 2)}\n`,
  );
}

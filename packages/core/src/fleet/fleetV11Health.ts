/**
 * Fleet health v11 — theo dõi sức khỏe từng node/bot trong fleet (v1.14, Đội T6).
 *
 * Tầng trên của fleet v6 (`fleetV6Health.ts` — health theo BOT, restart với
 * backoff) và fleet v8 (`fleetV8Health.ts` — health theo NODE, drain /
 * evacuate / rebalance) và dashboard v10 (`fleetV10Dashboard.ts` — trạng
 * thái runtime agent + cảnh báo heartbeat/hàng đợi). Các module trước trả
 * lời "node/bot này còn sống không"; module này trả lời "fleet đang khỏe
 * tới mức nào, chỗ nào sắp hỏng, và alert nào đang mở".
 *
 * - `evaluateFleetV11NodeHealth`: đánh giá thuần cho một node từ một
 *   sample (CPU% / RAM% / disk% / uptime / heartbeat): từng check riêng
 *   lẻ (cpu/ram/disk/heartbeat/uptime) với ngưỡng warn/crit riêng, kết
 *   quả `healthy | degraded | unhealthy | down`, kèm lý do để UI vẽ rõ.
 * - `evaluateFleetV11BotHealth`: đánh giá thuần cho một bot (heartbeat,
 *   CPU/RAM so với quota được cấp, số lỗi gần đây, số restart gần đây).
 * - Alert: `buildFleetV11Alerts` tổng hợp alert từ tất cả node + bot
 *   (mức `info | warning | critical`), kèm ngưỡng đã vượt và giá trị đo
 *   được. `acknowledgeFleetV11Alert` đánh dấu đã xem (ack không xóa
 *   alert — alert chỉ hết khi mẫu mới hết vượt ngưỡng; ack chỉ tắt
 *   tiếng chuông). `dedupeFleetV11Alerts` gộp alert trùng (cùng
 *   target + rule) giữ lại bản mới nhất, để UI không bị spam.
 * - Rollup: `buildFleetV11HealthSnapshot` — toàn cảnh fleet (số node/bot
 *   theo trạng thái, tài nguyên dùng/tổng, alert đang mở theo mức,
 *   node/bot tệ nhất) từ dữ liệu đầu vào, không đọc file, không chạm mạng.
 * - Bền vững: trạng thái theo dõi (số lần down liên tiếp, alert đã ack)
 *   lưu trong `<fleetRoot>/fleet-health-v114.json` (atomic tmp + rename,
 *   mode 0600); incident log `<fleetRoot>/fleet-incidents-v114.jsonl`
 *   (append, giữ tối đa N dòng mới nhất). Tách khỏi log v6/v8 để không
 *   trộn thế hệ.
 * - Probe local: `probeFleetV11LocalNode` đo thật máy local bằng
 *   `node:os` (load 1m, RAM) + `fs.statfsSync` cho đĩa. Probe node LAN
 *   xa do caller cung cấp (node tự báo qua heartbeat — xem
 *   `fleet/nodes.ts`); module này không đoán số liệu node xa.
 *
 * Module này KHÔNG spawn process và KHÔNG tự restart/drain bot: nó quyết
 * định "nên cảnh báo gì, mức nào" — việc thực hiện do
 * FleetServiceManager / caller làm.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/** File lưu trạng thái theo dõi health v11 trong fleet root. */
export const FLEET_V11_HEALTH_FILE = 'fleet-health-v114.json';
/** File incident log v11 trong fleet root (JSONL, append). */
export const FLEET_V11_INCIDENTS_FILE = 'fleet-incidents-v114.jsonl';
/** Heartbeat quá từng này ms chưa thấy thì coi là stale (mặc định). */
export const FLEET_V11_DEFAULT_HEARTBEAT_TIMEOUT_MS = 60_000;
/** Heartbeat quá từng này ms chưa thấy thì coi node/bot là down (mặc định). */
export const FLEET_V11_DEFAULT_DOWN_AFTER_MS = 5 * 60_000;
/** CPU% vượt ngưỡng này thì degraded (mặc định). */
export const FLEET_V11_DEFAULT_CPU_WARN_PCT = 80;
/** CPU% vượt ngưỡng này thì unhealthy (mặc định). */
export const FLEET_V11_DEFAULT_CPU_CRIT_PCT = 95;
/** RAM% vượt ngưỡng này thì degraded (mặc định). */
export const FLEET_V11_DEFAULT_RAM_WARN_PCT = 80;
/** RAM% vượt ngưỡng này thì unhealthy (mặc định). */
export const FLEET_V11_DEFAULT_RAM_CRIT_PCT = 95;
/** Disk% vượt ngưỡng này thì degraded (mặc định). */
export const FLEET_V11_DEFAULT_DISK_WARN_PCT = 80;
/** Disk% vượt ngưỡng này thì unhealthy (mặc định). */
export const FLEET_V11_DEFAULT_DISK_CRIT_PCT = 95;
/** Uptime dưới từng này ms thì node/bot mới khởi động lại gần đây (info). */
export const FLEET_V11_DEFAULT_MIN_UPTIME_MS = 60_000;
/** Số lỗi liên tiếp tối đa trước khi bot bị đánh unhealthy (mặc định). */
export const FLEET_V11_DEFAULT_UNHEALTHY_AFTER_FAILURES = 3;
/** Số restart trong cửa sổ này thì bot bị đánh degraded (mặc định). */
export const FLEET_V11_DEFAULT_RESTARTS_DEGRADED = 3;
/** Giữ tối đa từng này incident trong file log. */
export const FLEET_V11_MAX_INCIDENTS = 500;
/** Giữ tối đa từng này node/bot trong file trạng thái. */
export const FLEET_V11_MAX_TRACKED = 200;
/** Giữ tối đa từng này alert đang mở trong snapshot (mới nhất trước). */
export const FLEET_V11_MAX_OPEN_ALERTS = 200;

/** Trạng thái sức khoẻ của một node/bot. */
export type FleetV11HealthStatus = 'healthy' | 'degraded' | 'unhealthy' | 'down';

export const FLEET_V11_HEALTH_STATUSES: readonly FleetV11HealthStatus[] = [
  'healthy',
  'degraded',
  'unhealthy',
  'down',
];

/** Mức độ alert. */
export type FleetV11AlertLevel = 'info' | 'warning' | 'critical';

export const FLEET_V11_ALERT_LEVELS: readonly FleetV11AlertLevel[] = [
  'info',
  'warning',
  'critical',
];

/** Ngưỡng đánh giá health v11 (đơn vị % cho cpu/ram/disk, ms cho thời gian). */
export interface FleetV11HealthThresholds {
  cpuWarnPct: number;
  cpuCritPct: number;
  ramWarnPct: number;
  ramCritPct: number;
  diskWarnPct: number;
  diskCritPct: number;
  heartbeatTimeoutMs: number;
  downAfterMs: number;
  minUptimeMs: number;
  unhealthyAfterFailures: number;
  restartsDegraded: number;
}

export const DEFAULT_FLEET_V11_THRESHOLDS: FleetV11HealthThresholds = {
  cpuWarnPct: FLEET_V11_DEFAULT_CPU_WARN_PCT,
  cpuCritPct: FLEET_V11_DEFAULT_CPU_CRIT_PCT,
  ramWarnPct: FLEET_V11_DEFAULT_RAM_WARN_PCT,
  ramCritPct: FLEET_V11_DEFAULT_RAM_CRIT_PCT,
  diskWarnPct: FLEET_V11_DEFAULT_DISK_WARN_PCT,
  diskCritPct: FLEET_V11_DEFAULT_DISK_CRIT_PCT,
  heartbeatTimeoutMs: FLEET_V11_DEFAULT_HEARTBEAT_TIMEOUT_MS,
  downAfterMs: FLEET_V11_DEFAULT_DOWN_AFTER_MS,
  minUptimeMs: FLEET_V11_DEFAULT_MIN_UPTIME_MS,
  unhealthyAfterFailures: FLEET_V11_DEFAULT_UNHEALTHY_AFTER_FAILURES,
  restartsDegraded: FLEET_V11_DEFAULT_RESTARTS_DEGRADED,
};

/**
 * Chuẩn hoá ngưỡng do caller truyền vào: số không hợp lệ (NaN, âm,
 * warn >= crit) thì rơi về mặc định từng trường, không throw — health
 * check không được crash vì config xấu.
 */
export function normalizeFleetV11Thresholds(
  input: Partial<FleetV11HealthThresholds> | null | undefined,
): FleetV11HealthThresholds {
  const d = DEFAULT_FLEET_V11_THRESHOLDS;
  const pct = (v: unknown, fallback: number): number =>
    typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 100 ? v : fallback;
  const ms = (v: unknown, fallback: number): number =>
    typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : fallback;
  const count = (v: unknown, fallback: number): number =>
    typeof v === 'number' && Number.isFinite(v) && v >= 1 ? Math.floor(v) : fallback;
  const out: FleetV11HealthThresholds = {
    cpuWarnPct: pct(input?.cpuWarnPct, d.cpuWarnPct),
    cpuCritPct: pct(input?.cpuCritPct, d.cpuCritPct),
    ramWarnPct: pct(input?.ramWarnPct, d.ramWarnPct),
    ramCritPct: pct(input?.ramCritPct, d.ramCritPct),
    diskWarnPct: pct(input?.diskWarnPct, d.diskWarnPct),
    diskCritPct: pct(input?.diskCritPct, d.diskCritPct),
    heartbeatTimeoutMs: ms(input?.heartbeatTimeoutMs, d.heartbeatTimeoutMs),
    downAfterMs: ms(input?.downAfterMs, d.downAfterMs),
    minUptimeMs: ms(input?.minUptimeMs, d.minUptimeMs),
    unhealthyAfterFailures: count(input?.unhealthyAfterFailures, d.unhealthyAfterFailures),
    restartsDegraded: count(input?.restartsDegraded, d.restartsDegraded),
  };
  // warn phải < crit, nếu không thì đẩy crit lên warn + 1 (kẹp 100).
  for (const pair of [
    ['cpuWarnPct', 'cpuCritPct'],
    ['ramWarnPct', 'ramCritPct'],
    ['diskWarnPct', 'diskCritPct'],
  ] as const) {
    if (out[pair[0]] >= out[pair[1]]) {
      out[pair[1]] = Math.min(100, out[pair[0]] + 1);
    }
  }
  if (out.heartbeatTimeoutMs >= out.downAfterMs) {
    out.downAfterMs = out.heartbeatTimeoutMs * 2;
  }
  return out;
}

/** Một mẫu đo của node (null = không đo được trường đó). */
export interface FleetV11NodeSample {
  nodeId: string;
  /** Tên hiển thị (vắng = dùng nodeId). */
  name?: string;
  /** CPU đang dùng, % (0–100, có thể >100 khi đo load/core — kẹp ở eval). */
  cpuPct: number | null;
  /** RAM đang dùng, % (0–100). */
  ramPct: number | null;
  /** Đĩa đang dùng, % (0–100). */
  diskPct: number | null;
  /** Uptime của node, ms (null = không biết). */
  uptimeMs: number | null;
  /** Epoch ms heartbeat gần nhất (null = chưa từng có). */
  lastHeartbeatAt: number | null;
  /** Số bot đang chạy trên node. */
  botCount: number;
  /** Sức chứa bot tối đa của node (0 = không giới hạn / không biết). */
  botCapacity: number;
}

/** Một mẫu đo của bot. */
export interface FleetV11BotSample {
  botId: string;
  /** Tên hiển thị (vắng = dùng botId). */
  name?: string;
  /** Node đang chạy bot ('' = không biết). */
  nodeId: string;
  /** CPU đang dùng, % so với quota được cấp (null = không đo). */
  cpuPct: number | null;
  /** RAM đang dùng, % so với quota được cấp (null = không đo). */
  ramPct: number | null;
  /** Epoch ms heartbeat gần nhất (null = chưa từng có). */
  lastHeartbeatAt: number | null;
  /** Uptime của lần chạy hiện tại, ms (null = không chạy). */
  uptimeMs: number | null;
  /** Số lỗi liên tiếp gần đây. */
  consecutiveFailures: number;
  /** Số lần restart trong cửa sổ gần đây. */
  recentRestarts: number;
  /** Bot có đang chạy không (false = stopped — không đánh down vì heartbeat). */
  running: boolean;
}

/** Một check riêng lẻ trong đánh giá health. */
export interface FleetV11HealthCheck {
  /** Tên check: cpu | ram | disk | heartbeat | uptime | failures | restarts | capacity. */
  name: string;
  /** passed | warn | crit — check down được biểu diễn bằng crit + reason. */
  level: 'passed' | 'warn' | 'crit';
  /** Giá trị đo được (null = không đo được). */
  value: number | null;
  /** Ngưỡng đã so (null = check không có ngưỡng số). */
  threshold: number | null;
  /** Giải thích ngắn gọn, tiếng Việt, để UI hiển thị. */
  reason: string;
}

/** Kết quả đánh giá health cho một node/bot. */
export interface FleetV11HealthResult {
  targetId: string;
  targetKind: 'node' | 'bot';
  name: string;
  status: FleetV11HealthStatus;
  checks: FleetV11HealthCheck[];
  /** Lý do gộp (check tệ nhất) — '' khi healthy. */
  worstReason: string;
  evaluatedAt: number;
}

function clampPct(v: number | null): number | null {
  if (v === null || !Number.isFinite(v)) return null;
  return Math.max(0, Math.min(100, v));
}

function worstLevel(a: FleetV11HealthStatus, b: FleetV11HealthStatus): FleetV11HealthStatus {
  const rank: Record<FleetV11HealthStatus, number> = {
    healthy: 0,
    degraded: 1,
    unhealthy: 2,
    down: 3,
  };
  return rank[a] >= rank[b] ? a : b;
}

function checkPct(
  name: string,
  label: string,
  value: number | null,
  warn: number,
  crit: number,
): FleetV11HealthCheck {
  const v = clampPct(value);
  if (v === null) {
    return { name, level: 'passed', value: null, threshold: null, reason: `${label}: không đo được` };
  }
  if (v >= crit) {
    return { name, level: 'crit', value: v, threshold: crit, reason: `${label} ${v.toFixed(0)}% vượt ngưỡng nguy hiểm ${crit}%` };
  }
  if (v >= warn) {
    return { name, level: 'warn', value: v, threshold: warn, reason: `${label} ${v.toFixed(0)}% vượt ngưỡng cảnh báo ${warn}%` };
  }
  return { name, level: 'passed', value: v, threshold: warn, reason: `${label} ${v.toFixed(0)}% trong ngưỡng` };
}

function checkHeartbeat(
  lastHeartbeatAt: number | null,
  now: number,
  thresholds: FleetV11HealthThresholds,
): FleetV11HealthCheck {
  if (lastHeartbeatAt === null) {
    return { name: 'heartbeat', level: 'crit', value: null, threshold: null, reason: 'chưa từng có heartbeat' };
  }
  const ageMs = now - lastHeartbeatAt;
  if (ageMs < 0) {
    return { name: 'heartbeat', level: 'passed', value: 0, threshold: null, reason: 'heartbeat ở tương lai (đồng hồ lệch)' };
  }
  if (ageMs >= thresholds.downAfterMs) {
    return { name: 'heartbeat', level: 'crit', value: ageMs, threshold: thresholds.downAfterMs, reason: `không có heartbeat ${Math.round(ageMs / 1000)}s (quá ${Math.round(thresholds.downAfterMs / 1000)}s)` };
  }
  if (ageMs >= thresholds.heartbeatTimeoutMs) {
    return { name: 'heartbeat', level: 'warn', value: ageMs, threshold: thresholds.heartbeatTimeoutMs, reason: `heartbeat cũ ${Math.round(ageMs / 1000)}s` };
  }
  return { name: 'heartbeat', level: 'passed', value: ageMs, threshold: thresholds.heartbeatTimeoutMs, reason: `heartbeat mới ${Math.round(ageMs / 1000)}s trước` };
}

/**
 * Đánh giá health thuần cho một node. `down` chỉ khi heartbeat quá
 * `downAfterMs` (hoặc chưa từng có heartbeat VÀ uptime cũng null —
 * node chưa từng lên); các vượt ngưỡng tài nguyên cho tối đa `unhealthy`.
 */
export function evaluateFleetV11NodeHealth(
  sample: FleetV11NodeSample,
  thresholdsInput?: Partial<FleetV11HealthThresholds>,
  now = Date.now(),
): FleetV11HealthResult {
  const thresholds = normalizeFleetV11Thresholds(thresholdsInput);
  const checks: FleetV11HealthCheck[] = [
    checkPct('cpu', 'CPU', sample.cpuPct, thresholds.cpuWarnPct, thresholds.cpuCritPct),
    checkPct('ram', 'RAM', sample.ramPct, thresholds.ramWarnPct, thresholds.ramCritPct),
    checkPct('disk', 'Đĩa', sample.diskPct, thresholds.diskWarnPct, thresholds.diskCritPct),
    checkHeartbeat(sample.lastHeartbeatAt, now, thresholds),
  ];
  if (sample.uptimeMs !== null && sample.uptimeMs < thresholds.minUptimeMs) {
    checks.push({
      name: 'uptime',
      level: 'warn',
      value: sample.uptimeMs,
      threshold: thresholds.minUptimeMs,
      reason: `node mới khởi động lại ${Math.round(sample.uptimeMs / 1000)}s trước`,
    });
  }
  if (sample.botCapacity > 0 && sample.botCount > sample.botCapacity) {
    checks.push({
      name: 'capacity',
      level: 'warn',
      value: sample.botCount,
      threshold: sample.botCapacity,
      reason: `đang chạy ${sample.botCount}/${sample.botCapacity} bot (quá sức chứa)`,
    });
  }
  let status: FleetV11HealthStatus = 'healthy';
  for (const c of checks) {
    if (c.name === 'heartbeat' && c.level === 'crit') status = worstLevel(status, 'down');
    else if (c.level === 'crit') status = worstLevel(status, 'unhealthy');
    else if (c.level === 'warn') status = worstLevel(status, 'degraded');
  }
  // Node chưa từng heartbeat và cũng chưa từng uptime = chưa từng lên -> down.
  if (sample.lastHeartbeatAt === null && sample.uptimeMs === null) status = 'down';
  const worst = checks
    .filter((c) => c.level !== 'passed')
    .sort((a, b) => (a.level === 'crit' ? 0 : 1) - (b.level === 'crit' ? 0 : 1))[0];
  return {
    targetId: sample.nodeId,
    targetKind: 'node',
    name: sample.name ?? sample.nodeId,
    status,
    checks,
    worstReason: worst ? worst.reason : '',
    evaluatedAt: now,
  };
}

/**
 * Đánh giá health thuần cho một bot. Bot stopped không bị đánh `down`
 * vì thiếu heartbeat (đó là trạng thái chủ đích, không phải sự cố);
 * bot đang chạy mà mất heartbeat thì `down`.
 */
export function evaluateFleetV11BotHealth(
  sample: FleetV11BotSample,
  thresholdsInput?: Partial<FleetV11HealthThresholds>,
  now = Date.now(),
): FleetV11HealthResult {
  const thresholds = normalizeFleetV11Thresholds(thresholdsInput);
  const checks: FleetV11HealthCheck[] = [
    checkPct('cpu', 'CPU', sample.cpuPct, thresholds.cpuWarnPct, thresholds.cpuCritPct),
    checkPct('ram', 'RAM', sample.ramPct, thresholds.ramWarnPct, thresholds.ramCritPct),
  ];
  if (sample.running) {
    checks.push(checkHeartbeat(sample.lastHeartbeatAt, now, thresholds));
  } else {
    checks.push({
      name: 'heartbeat',
      level: 'passed',
      value: null,
      threshold: null,
      reason: 'bot đang dừng (không yêu cầu heartbeat)',
    });
  }
  if (sample.consecutiveFailures >= thresholds.unhealthyAfterFailures) {
    checks.push({
      name: 'failures',
      level: 'crit',
      value: sample.consecutiveFailures,
      threshold: thresholds.unhealthyAfterFailures,
      reason: `${sample.consecutiveFailures} lỗi liên tiếp`,
    });
  } else if (sample.consecutiveFailures > 0) {
    checks.push({
      name: 'failures',
      level: 'warn',
      value: sample.consecutiveFailures,
      threshold: thresholds.unhealthyAfterFailures,
      reason: `${sample.consecutiveFailures} lỗi liên tiếp`,
    });
  }
  if (sample.recentRestarts >= thresholds.restartsDegraded) {
    checks.push({
      name: 'restarts',
      level: 'warn',
      value: sample.recentRestarts,
      threshold: thresholds.restartsDegraded,
      reason: `đã restart ${sample.recentRestarts} lần gần đây`,
    });
  }
  let status: FleetV11HealthStatus = 'healthy';
  if (!sample.running) {
    // Bot stopped: chỉ lỗi liên tiếp mới kéo xuống unhealthy, còn lại healthy.
    const failCheck = checks.find((c) => c.name === 'failures');
    if (failCheck?.level === 'crit') status = 'unhealthy';
    else if (failCheck?.level === 'warn') status = 'degraded';
    else {
      for (const c of checks) {
        if (c.level === 'crit') status = worstLevel(status, 'unhealthy');
        else if (c.level === 'warn') status = worstLevel(status, 'degraded');
      }
    }
  } else {
    for (const c of checks) {
      if (c.name === 'heartbeat' && c.level === 'crit') status = worstLevel(status, 'down');
      else if (c.level === 'crit') status = worstLevel(status, 'unhealthy');
      else if (c.level === 'warn') status = worstLevel(status, 'degraded');
    }
  }
  const worst = checks
    .filter((c) => c.level !== 'passed')
    .sort((a, b) => (a.level === 'crit' ? 0 : 1) - (b.level === 'crit' ? 0 : 1))[0];
  return {
    targetId: sample.botId,
    targetKind: 'bot',
    name: sample.name ?? sample.botId,
    status,
    checks,
    worstReason: worst ? worst.reason : '',
    evaluatedAt: now,
  };
}

/** Một alert đang mở trong fleet. */
export interface FleetV11Alert {
  /** Id ổn định: `<kind>:<targetId>:<rule>` — để dedupe + ack bền. */
  id: string;
  targetKind: 'node' | 'bot';
  targetId: string;
  targetName: string;
  /** Rule sinh alert: cpu | ram | disk | heartbeat | failures | restarts | capacity | uptime. */
  rule: string;
  level: FleetV11AlertLevel;
  message: string;
  /** Giá trị đo được lúc sinh alert (null = không có số đo). */
  value: number | null;
  /** Ngưỡng đã vượt (null = không có ngưỡng số). */
  threshold: number | null;
  /** Epoch ms lần đầu thấy alert này. */
  firstSeenAt: number;
  /** Epoch ms lần gần nhất thấy alert này còn đúng. */
  lastSeenAt: number;
  /** Số lần mẫu liên tiếp còn đúng. */
  occurrences: number;
  acknowledged: boolean;
  acknowledgedBy?: string;
  acknowledgedAt?: number;
}

function alertLevelForCheck(check: FleetV11HealthCheck, status: FleetV11HealthStatus): FleetV11AlertLevel {
  if (check.level === 'crit') return status === 'down' ? 'critical' : 'critical';
  return 'warning';
}

/**
 * Sinh alert từ kết quả đánh giá health (chỉ các check warn/crit).
 * `previous` (alert đang mở từ lần đánh giá trước, khớp theo id) được
 * giữ lại để `occurrences`/`firstSeenAt`/`acknowledged` không reset
 * mỗi lần đánh giá.
 */
export function buildFleetV11Alerts(
  results: FleetV11HealthResult[],
  previous: FleetV11Alert[] = [],
  now = Date.now(),
): FleetV11Alert[] {
  const prevById = new Map(previous.map((a) => [a.id, a]));
  const alerts: FleetV11Alert[] = [];
  for (const r of results) {
    for (const c of r.checks) {
      if (c.level === 'passed') continue;
      const id = `${r.targetKind}:${r.targetId}:${c.name}`;
      const prev = prevById.get(id);
      alerts.push({
        id,
        targetKind: r.targetKind,
        targetId: r.targetId,
        targetName: r.name,
        rule: c.name,
        level: alertLevelForCheck(c, r.status),
        message: `${r.name}: ${c.reason}`,
        value: c.value,
        threshold: c.threshold,
        firstSeenAt: prev?.firstSeenAt ?? now,
        lastSeenAt: now,
        occurrences: (prev?.occurrences ?? 0) + 1,
        acknowledged: prev?.acknowledged ?? false,
        acknowledgedBy: prev?.acknowledgedBy,
        acknowledgedAt: prev?.acknowledgedAt,
      });
    }
  }
  return dedupeFleetV11Alerts(alerts);
}

/** Gộp alert trùng id, giữ bản mới nhất (occurrences cộng dồn lấy max). */
export function dedupeFleetV11Alerts(alerts: FleetV11Alert[]): FleetV11Alert[] {
  const byId = new Map<string, FleetV11Alert>();
  for (const a of alerts) {
    const prev = byId.get(a.id);
    if (!prev) {
      byId.set(a.id, a);
      continue;
    }
    byId.set(a.id, {
      ...a,
      firstSeenAt: Math.min(prev.firstSeenAt, a.firstSeenAt),
      occurrences: Math.max(prev.occurrences, a.occurrences),
      acknowledged: prev.acknowledged || a.acknowledged,
    });
  }
  const levelRank: Record<FleetV11AlertLevel, number> = { critical: 0, warning: 1, info: 2 };
  return [...byId.values()].sort(
    (a, b) => levelRank[a.level] - levelRank[b.level] || b.lastSeenAt - a.lastSeenAt,
  );
}

/**
 * Đánh dấu alert đã xem. Ack không xóa alert — lần đánh giá sau nếu
 * mẫu hết vượt ngưỡng thì alert tự biến mất (không còn trong danh sách
 * mở); ack chỉ ghi lại ai đã xem, khi nào. Trả về danh sách mới (không
 * mutate đầu vào); id không tồn tại thì trả về nguyên danh sách.
 */
export function acknowledgeFleetV11Alert(
  alerts: FleetV11Alert[],
  alertId: string,
  actorUserId: string,
  now = Date.now(),
): FleetV11Alert[] {
  if (!alertId || !actorUserId) return alerts;
  let changed = false;
  const out = alerts.map((a) => {
    if (a.id !== alertId || a.acknowledged) return a;
    changed = true;
    return { ...a, acknowledged: true, acknowledgedBy: actorUserId, acknowledgedAt: now };
  });
  return changed ? out : alerts;
}

/** Toàn cảnh sức khỏe fleet (đầu vào đã là kết quả đánh giá + alert mở). */
export interface FleetV11HealthSnapshot {
  evaluatedAt: number;
  nodes: { total: number; healthy: number; degraded: number; unhealthy: number; down: number };
  bots: { total: number; healthy: number; degraded: number; unhealthy: number; down: number };
  /** Alert đang mở theo mức (chưa ack + đã ack gộp). */
  alerts: { total: number; critical: number; warning: number; info: number; unacknowledged: number };
  /** CPU/RAM/disk trung bình các node đo được (null = không đo được node nào). */
  avgCpuPct: number | null;
  avgRamPct: number | null;
  avgDiskPct: number | null;
  /** Node/bot tệ nhất (theo thứ tự down > unhealthy > degraded), tối đa 5. */
  worst: FleetV11HealthResult[];
  /** Alert đang mở, mới nhất/critical trước, tối đa FLEET_V11_MAX_OPEN_ALERTS. */
  openAlerts: FleetV11Alert[];
  /** Một dòng tóm tắt tiếng Việt cho UI. */
  summary: string;
}

function avgOrNull(values: (number | null)[]): number | null {
  const xs = values.filter((v): v is number => v !== null && Number.isFinite(v));
  if (xs.length === 0) return null;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function countByStatus(results: FleetV11HealthResult[]): {
  total: number;
  healthy: number;
  degraded: number;
  unhealthy: number;
  down: number;
} {
  const c = { total: results.length, healthy: 0, degraded: 0, unhealthy: 0, down: 0 };
  for (const r of results) c[r.status] += 1;
  return c;
}

/**
 * Xây snapshot toàn cảnh fleet (hàm thuần). `nodeSamples` dùng để tính
 * trung bình tài nguyên; `results` là kết quả đã đánh giá; `openAlerts`
 * là alert đang mở (đã dedupe). Snapshot không tự đánh giá lại — host
 * gọi evaluate* trước rồi đưa kết quả vào.
 */
export function buildFleetV11HealthSnapshot(
  nodeSamples: FleetV11NodeSample[],
  nodeResults: FleetV11HealthResult[],
  botResults: FleetV11HealthResult[],
  openAlerts: FleetV11Alert[],
  now = Date.now(),
): FleetV11HealthSnapshot {
  const nodes = countByStatus(nodeResults);
  const bots = countByStatus(botResults);
  const alerts = {
    total: openAlerts.length,
    critical: openAlerts.filter((a) => a.level === 'critical').length,
    warning: openAlerts.filter((a) => a.level === 'warning').length,
    info: openAlerts.filter((a) => a.level === 'info').length,
    unacknowledged: openAlerts.filter((a) => !a.acknowledged).length,
  };
  const rank: Record<FleetV11HealthStatus, number> = {
    down: 0,
    unhealthy: 1,
    degraded: 2,
    healthy: 3,
  };
  const worst = [...nodeResults, ...botResults]
    .filter((r) => r.status !== 'healthy')
    .sort((a, b) => rank[a.status] - rank[b.status] || a.targetId.localeCompare(b.targetId))
    .slice(0, 5);
  const problemNodes = nodes.degraded + nodes.unhealthy + nodes.down;
  const problemBots = bots.degraded + bots.unhealthy + bots.down;
  const summary =
    alerts.critical > 0
      ? `Fleet gặp sự cố: ${alerts.critical} alert nghiêm trọng, ${problemNodes}/${nodes.total} node và ${problemBots}/${bots.total} bot có vấn đề.`
      : problemNodes + problemBots > 0
        ? `Fleet có ${problemNodes} node và ${problemBots} bot cần chú ý, ${alerts.total} alert đang mở.`
        : `Fleet khỏe: ${nodes.total} node, ${bots.total} bot, không có alert đang mở.`;
  return {
    evaluatedAt: now,
    nodes,
    bots,
    alerts,
    avgCpuPct: avgOrNull(nodeSamples.map((s) => clampPct(s.cpuPct))),
    avgRamPct: avgOrNull(nodeSamples.map((s) => clampPct(s.ramPct))),
    avgDiskPct: avgOrNull(nodeSamples.map((s) => clampPct(s.diskPct))),
    worst,
    openAlerts: dedupeFleetV11Alerts(openAlerts).slice(0, FLEET_V11_MAX_OPEN_ALERTS),
    summary,
  };
}

/** Trạng thái theo dõi bền vững của health v11 (file JSON). */
export interface FleetV11HealthState {
  version: 1;
  /** nodeId/botId -> số lần down liên tiếp. */
  consecutiveDowns: Record<string, number>;
  /** Alert đã ack (id -> {by, at}) — giữ lại qua lần đánh giá sau. */
  acknowledgedAlerts: Record<string, { by: string; at: number }>;
  /** Epoch ms lần đánh giá gần nhất. */
  lastEvaluatedAt: number | null;
}

export function createFleetV11HealthState(): FleetV11HealthState {
  return { version: 1, consecutiveDowns: {}, acknowledgedAlerts: {}, lastEvaluatedAt: null };
}

export function getFleetV11HealthPath(fleetRoot: string): string {
  return path.join(fleetRoot, FLEET_V11_HEALTH_FILE);
}

export function getFleetV11IncidentsPath(fleetRoot: string): string {
  return path.join(fleetRoot, FLEET_V11_INCIDENTS_FILE);
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

export function loadFleetV11HealthState(fleetRoot: string): FleetV11HealthState {
  try {
    const raw = fs.readFileSync(getFleetV11HealthPath(fleetRoot), 'utf8');
    const parsed = JSON.parse(raw) as Partial<FleetV11HealthState>;
    if (parsed?.version !== 1) return createFleetV11HealthState();
    return {
      version: 1,
      consecutiveDowns:
        parsed.consecutiveDowns && typeof parsed.consecutiveDowns === 'object'
          ? parsed.consecutiveDowns
          : {},
      acknowledgedAlerts:
        parsed.acknowledgedAlerts && typeof parsed.acknowledgedAlerts === 'object'
          ? parsed.acknowledgedAlerts
          : {},
      lastEvaluatedAt:
        typeof parsed.lastEvaluatedAt === 'number' ? parsed.lastEvaluatedAt : null,
    };
  } catch {
    return createFleetV11HealthState();
  }
}

export function saveFleetV11HealthState(fleetRoot: string, state: FleetV11HealthState): void {
  atomicWriteFile(getFleetV11HealthPath(fleetRoot), `${JSON.stringify(state, null, 2)}\n`);
}

/**
 * Cập nhật số lần down liên tiếp từ kết quả đánh giá mới: down thì +1,
 * còn lại reset về 0. Trả về state mới (không mutate đầu vào).
 */
export function trackFleetV11Downs(
  state: FleetV11HealthState,
  results: FleetV11HealthResult[],
  now = Date.now(),
): FleetV11HealthState {
  const consecutiveDowns: Record<string, number> = {};
  for (const r of results) {
    const key = `${r.targetKind}:${r.targetId}`;
    consecutiveDowns[key] = r.status === 'down' ? (state.consecutiveDowns[key] ?? 0) + 1 : 0;
  }
  // Giữ lại entry cũ của target không còn trong đợt đánh giá này (tối đa N).
  for (const [k, v] of Object.entries(state.consecutiveDowns)) {
    if (!(k in consecutiveDowns)) consecutiveDowns[k] = v;
  }
  const trimmed = Object.fromEntries(
    Object.entries(consecutiveDowns).slice(0, FLEET_V11_MAX_TRACKED),
  );
  return { ...state, consecutiveDowns: trimmed, lastEvaluatedAt: now };
}

/** Một dòng incident trong log v11. */
export interface FleetV11Incident {
  at: number;
  kind: 'node-down' | 'node-degraded' | 'bot-down' | 'bot-unhealthy' | 'alert-raised' | 'alert-acked';
  targetKind: 'node' | 'bot';
  targetId: string;
  message: string;
  level: FleetV11AlertLevel;
}

/** Append một incident (best-effort, không throw khi ghi lỗi). */
export function appendFleetV11Incident(fleetRoot: string, incident: FleetV11Incident): boolean {
  try {
    const filePath = getFleetV11IncidentsPath(fleetRoot);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.appendFileSync(filePath, `${JSON.stringify(incident)}\n`, { mode: 0o600 });
    // Cắt log về tối đa N dòng mới nhất.
    const lines = fs
      .readFileSync(filePath, 'utf8')
      .split('\n')
      .filter((l) => l.length > 0);
    if (lines.length > FLEET_V11_MAX_INCIDENTS) {
      atomicWriteFile(filePath, `${lines.slice(-FLEET_V11_MAX_INCIDENTS).join('\n')}\n`);
    }
    return true;
  } catch {
    return false;
  }
}

/** Đọc incident log (mới nhất trước, tối đa `limit` dòng). */
export function readFleetV11Incidents(fleetRoot: string, limit = 100): FleetV11Incident[] {
  try {
    const lines = fs
      .readFileSync(getFleetV11IncidentsPath(fleetRoot), 'utf8')
      .split('\n')
      .filter((l) => l.length > 0);
    const out: FleetV11Incident[] = [];
    for (const line of lines.slice(-limit).reverse()) {
      try {
        out.push(JSON.parse(line) as FleetV11Incident);
      } catch {
        // Dòng hỏng thì bỏ qua, không làm hỏng cả log.
      }
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * Probe tài nguyên thật của máy local: load 1m / số core (ước lượng CPU%),
 * RAM total/free, đĩa qua `statfsSync` (fallback null khi nền tảng không
 * hỗ trợ). Không gọi mạng, không spawn process.
 */
export function probeFleetV11LocalNode(nodeId: string, now = Date.now()): FleetV11NodeSample {
  const cores = Math.max(1, os.cpus().length);
  const load1m = os.loadavg()[0] ?? 0;
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  let diskPct: number | null = null;
  try {
    const stat = fs.statfsSync(process.cwd());
    if (typeof stat.bsize === 'number' && typeof stat.blocks === 'number' && stat.blocks > 0) {
      const used = stat.blocks - stat.bfree;
      diskPct = (used / stat.blocks) * 100;
    }
  } catch {
    diskPct = null;
  }
  return {
    nodeId,
    name: os.hostname(),
    cpuPct: (load1m / cores) * 100,
    ramPct: totalMem > 0 ? ((totalMem - freeMem) / totalMem) * 100 : null,
    diskPct,
    uptimeMs: os.uptime() * 1000,
    lastHeartbeatAt: now,
    botCount: 0,
    botCapacity: 0,
  };
}

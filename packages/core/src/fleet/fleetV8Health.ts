/**
 * Fleet health v8 — node health + auto-restart + rebalance (v1.11, Đội T6).
 *
 * Tầng trên của fleet v6 (`fleetV6Health.ts` — health theo BOT, restart
 * với backoff) và fleet v7 (`fleetV7Campaign.ts` — rollout theo BOT trên
 * nhiều NODE). Module này trả lời câu hỏi riêng của NODE (máy): một
 * máy trong fleet còn đủ sức chạy bot không, và khi máy yếu/chết thì
 * làm gì với bot đang chạy trên nó.
 *
 * - `probeFleetV8LocalNode`: probe tài nguyên thật của máy local bằng
 *   `node:os` (CPU cores, load 1m, RAM total/free) + `fs.statfsSync`
 *   cho đĩa (fallback null khi nền tảng không hỗ trợ). Không gọi mạng,
 *   không spawn process. Probe cho node LAN xa do caller cung cấp
 *   (node tự báo qua heartbeat — xem `fleet/nodes.ts`).
 * - `checkFleetV8NodeHealth`: đánh giá thuần cho một node — heartbeat
 *   còn tươi không, CPU load / RAM / đĩa so với ngưỡng, số bot so với
 *   sức chứa. Kết quả: `healthy` | `degraded` | `unhealthy` | `down`,
 *   kèm từng check riêng lẻ để UI vẽ rõ lý do.
 * - `decideFleetV8NodeAction`: chính sách khi node xấu — `none` /
 *   `drain` (ngừng nhận bot mới, để bot cũ chạy hết) / `restart-bots`
 *   (khởi động lại bot trên node với backoff tăng dần) / `evacuate`
 *   (chuyển bot sang node khác — xem `planFleetV8Rebalance`). Node
 *   down N lần liên tiếp thì bị đánh `evacuate` thay vì restart mãi.
 * - `planFleetV8Rebalance`: kế hoạch chuyển bot khỏi node quá tải /
 *   draining / down sang node healthy còn chỗ, ưu tiên loopback rồi
 *   tới node có tỉ lệ tài nguyên trống cao nhất. Chỉ là kế hoạch
 *   (dry-run): việc chuyển thật do caller / FleetServiceManager làm.
 * - Incident log: `<fleetRoot>/fleet-incidents-v111.jsonl` — append
 *   từng dòng JSON (node-down / node-degraded / node-evacuated /
 *   bot-restart / rebalance), giữ tối đa N dòng mới nhất. Tách khỏi
 *   log v6 (`fleet-incidents-v109.jsonl`) để không trộn hai thế hệ.
 * - Trạng thái theo dõi node (số lần down liên tiếp, lần check cuối)
 *   lưu bền trong `<fleetRoot>/fleet-health-v111.json` (atomic tmp +
 *   rename, mode 0600).
 *
 * Module này KHÔNG spawn process thật và KHÔNG tự restart bot: nó
 * quyết định "nên làm gì, sau bao lâu, chuyển bot nào đi đâu" — việc
 * thực hiện do FleetServiceManager / caller làm. Tách bạch như vậy để
 * logic test được thuần túy.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/** File lưu trạng thái theo dõi node v8 trong fleet root. */
export const FLEET_V8_HEALTH_FILE = 'fleet-health-v111.json';
/** File incident log v8 trong fleet root (JSONL, append). */
export const FLEET_V8_INCIDENTS_FILE = 'fleet-incidents-v111.jsonl';
/** Heartbeat quá từng này ms chưa thấy thì coi là stale (mặc định). */
export const FLEET_V8_DEFAULT_HEARTBEAT_TIMEOUT_MS = 60_000;
/** Heartbeat quá từng này ms chưa thấy thì coi node là down (mặc định). */
export const FLEET_V8_DEFAULT_DOWN_AFTER_MS = 5 * 60_000;
/** CPU load 1m trên mỗi core vượt ngưỡng này thì node degraded. */
export const FLEET_V8_DEFAULT_CPU_LOAD_WARN = 0.85;
/** CPU load 1m trên mỗi core vượt ngưỡng này thì node unhealthy. */
export const FLEET_V8_DEFAULT_CPU_LOAD_CRIT = 1.5;
/** RAM trống dưới tỉ lệ này thì node degraded. */
export const FLEET_V8_DEFAULT_RAM_FREE_WARN = 0.15;
/** RAM trống dưới tỉ lệ này thì node unhealthy. */
export const FLEET_V8_DEFAULT_RAM_FREE_CRIT = 0.05;
/** Đĩa trống dưới tỉ lệ này thì node degraded. */
export const FLEET_V8_DEFAULT_DISK_FREE_WARN = 0.15;
/** Đĩa trống dưới tỉ lệ này thì node unhealthy. */
export const FLEET_V8_DEFAULT_DISK_FREE_CRIT = 0.05;
/** Số lần down liên tiếp tối đa trước khi node bị đánh evacuate thay vì restart. */
export const FLEET_V8_DEFAULT_EVACUATE_AFTER_DOWNS = 3;
/** Backoff cơ số giữa các lần restart bot trên node xấu (ms). */
export const FLEET_V8_DEFAULT_RESTART_BASE_BACKOFF_MS = 5_000;
/** Backoff tối đa giữa các lần restart bot (ms). */
export const FLEET_V8_DEFAULT_RESTART_MAX_BACKOFF_MS = 5 * 60 * 1000;
/** Giữ tối đa từng này incident trong file log. */
export const FLEET_V8_MAX_INCIDENTS = 500;
/** Giữ tối đa từng này node trong file trạng thái. */
export const FLEET_V8_MAX_TRACKED_NODES = 200;

/** Trạng thái sức khoẻ của một node. */
export type FleetV8NodeHealthStatus = 'healthy' | 'degraded' | 'unhealthy' | 'down';

export const FLEET_V8_NODE_HEALTH_STATUSES: readonly FleetV8NodeHealthStatus[] = [
  'healthy',
  'degraded',
  'unhealthy',
  'down',
];

/** Một check riêng lẻ trong kết quả đánh giá node. */
export interface FleetV8NodeHealthCheck {
  /** Tên check, vd 'heartbeat', 'cpu-load', 'ram-free', 'disk-free', 'bot-capacity'. */
  name: string;
  /** true = check này đạt. */
  ok: boolean;
  /** Mức độ khi check trượt: 'warn' (degraded) hay 'crit' (unhealthy). */
  level: 'warn' | 'crit';
  /** Chi tiết đọc được, vd 'load 1m 3.20 trên 2 core'. */
  detail: string;
}

/** Đầu vào đánh giá sức khoẻ một node. */
export interface FleetV8NodeHealthInput {
  /** Id ổn định của node (vd 'fn-<uuid>' hoặc id campaign v7). */
  nodeId: string;
  /** Số core CPU node khai báo (<= 0 = không biết, bỏ qua check load). */
  cpuCores: number;
  /** Load trung bình 1 phút (os.loadavg()[0]) — null khi node không báo. */
  cpuLoad1m: number | null;
  /** RAM tổng (bytes) — null khi không biết. */
  ramTotalBytes: number | null;
  /** RAM trống (bytes) — null khi không biết. */
  ramFreeBytes: number | null;
  /** Đĩa tổng (bytes) — null khi không biết. */
  diskTotalBytes: number | null;
  /** Đĩa trống (bytes) — null khi không biết. */
  diskFreeBytes: number | null;
  /** ms từ lần heartbeat cuối tới lúc check — null = chưa từng thấy. */
  heartbeatAgeMs: number | null;
  /** Số bot đang chạy trên node. */
  runningBots: number;
  /** Số bot tối đa node nhận — null = không giới hạn. */
  maxBots: number | null;
  /** true khi node đang draining (chỉ cảnh báo, không tính là xấu). */
  draining?: boolean;
}

/** Kết quả đánh giá sức khoẻ một node. */
export interface FleetV8NodeHealthResult {
  nodeId: string;
  status: FleetV8NodeHealthStatus;
  checks: FleetV8NodeHealthCheck[];
  /** Lý do ngắn gọn cho UI (rỗng khi healthy). */
  reasons: string[];
  /** ms epoch lúc check. */
  checkedAtMs: number;
}

/** Ngưỡng đánh giá node (caller có thể siết/nới từng ngưỡng). */
export interface FleetV8NodeHealthThresholds {
  heartbeatTimeoutMs: number;
  downAfterMs: number;
  cpuLoadWarn: number;
  cpuLoadCrit: number;
  ramFreeWarn: number;
  ramFreeCrit: number;
  diskFreeWarn: number;
  diskFreeCrit: number;
}

export const DEFAULT_FLEET_V8_THRESHOLDS: FleetV8NodeHealthThresholds = {
  heartbeatTimeoutMs: FLEET_V8_DEFAULT_HEARTBEAT_TIMEOUT_MS,
  downAfterMs: FLEET_V8_DEFAULT_DOWN_AFTER_MS,
  cpuLoadWarn: FLEET_V8_DEFAULT_CPU_LOAD_WARN,
  cpuLoadCrit: FLEET_V8_DEFAULT_CPU_LOAD_CRIT,
  ramFreeWarn: FLEET_V8_DEFAULT_RAM_FREE_WARN,
  ramFreeCrit: FLEET_V8_DEFAULT_RAM_FREE_CRIT,
  diskFreeWarn: FLEET_V8_DEFAULT_DISK_FREE_WARN,
  diskFreeCrit: FLEET_V8_DEFAULT_DISK_FREE_CRIT,
};

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function fraction(free: number | null, total: number | null): number | null {
  if (!isFiniteNumber(free) || !isFiniteNumber(total) || total <= 0) return null;
  return Math.max(0, Math.min(1, free / total));
}

/**
 * Đánh giá sức khoẻ một node — hàm thuần, không đọc/ghi file.
 * Thứ tự nghiêm trọng: down (không heartbeat) > unhealthy (crit) >
 * degraded (warn) > healthy. Node draining không bị trừ điểm vì
 * draining — nhưng các check tài nguyên vẫn tính như thường.
 */
export function checkFleetV8NodeHealth(
  input: FleetV8NodeHealthInput,
  thresholds: Partial<FleetV8NodeHealthThresholds> = {},
  nowMs: number = Date.now(),
): FleetV8NodeHealthResult {
  const t: FleetV8NodeHealthThresholds = { ...DEFAULT_FLEET_V8_THRESHOLDS, ...thresholds };
  const checks: FleetV8NodeHealthCheck[] = [];
  const reasons: string[] = [];
  let worst: FleetV8NodeHealthStatus = 'healthy';

  const mark = (level: 'warn' | 'crit', reason: string) => {
    reasons.push(reason);
    if (level === 'crit' && worst !== 'down') worst = 'unhealthy';
    else if (level === 'warn' && worst === 'healthy') worst = 'degraded';
  };

  // Heartbeat: chưa từng thấy hoặc quá hạn down = down; quá hạn stale = warn.
  if (input.heartbeatAgeMs === null) {
    checks.push({ name: 'heartbeat', ok: false, level: 'crit', detail: 'chưa từng thấy heartbeat' });
    worst = 'down';
    reasons.push('node chưa từng gửi heartbeat');
  } else if (input.heartbeatAgeMs >= t.downAfterMs) {
    checks.push({ name: 'heartbeat', ok: false, level: 'crit', detail: `heartbeat cũ ${Math.round(input.heartbeatAgeMs / 1000)}s` });
    worst = 'down';
    reasons.push(`node mất heartbeat ${Math.round(input.heartbeatAgeMs / 1000)}s`);
  } else if (input.heartbeatAgeMs >= t.heartbeatTimeoutMs) {
    checks.push({ name: 'heartbeat', ok: false, level: 'warn', detail: `heartbeat cũ ${Math.round(input.heartbeatAgeMs / 1000)}s` });
    mark('warn', `heartbeat cũ ${Math.round(input.heartbeatAgeMs / 1000)}s`);
  } else {
    checks.push({ name: 'heartbeat', ok: true, level: 'warn', detail: `heartbeat ${Math.round(input.heartbeatAgeMs / 1000)}s trước` });
  }

  // CPU load 1m trên mỗi core.
  if (isFiniteNumber(input.cpuLoad1m) && isFiniteNumber(input.cpuCores) && input.cpuCores > 0) {
    const perCore = input.cpuLoad1m / input.cpuCores;
    const detail = `load 1m ${input.cpuLoad1m.toFixed(2)} trên ${input.cpuCores} core (${perCore.toFixed(2)}/core)`;
    if (perCore >= t.cpuLoadCrit) {
      checks.push({ name: 'cpu-load', ok: false, level: 'crit', detail });
      mark('crit', `CPU quá tải: ${detail}`);
    } else if (perCore >= t.cpuLoadWarn) {
      checks.push({ name: 'cpu-load', ok: false, level: 'warn', detail });
      mark('warn', `CPU cao: ${detail}`);
    } else {
      checks.push({ name: 'cpu-load', ok: true, level: 'warn', detail });
    }
  } else {
    checks.push({ name: 'cpu-load', ok: true, level: 'warn', detail: 'node không báo load CPU' });
  }

  // RAM trống.
  const ramFree = fraction(input.ramFreeBytes, input.ramTotalBytes);
  if (ramFree !== null) {
    const detail = `RAM trống ${(ramFree * 100).toFixed(1)}%`;
    if (ramFree < t.ramFreeCrit) {
      checks.push({ name: 'ram-free', ok: false, level: 'crit', detail });
      mark('crit', `RAM gần hết: ${detail}`);
    } else if (ramFree < t.ramFreeWarn) {
      checks.push({ name: 'ram-free', ok: false, level: 'warn', detail });
      mark('warn', `RAM thấp: ${detail}`);
    } else {
      checks.push({ name: 'ram-free', ok: true, level: 'warn', detail });
    }
  } else {
    checks.push({ name: 'ram-free', ok: true, level: 'warn', detail: 'node không báo RAM' });
  }

  // Đĩa trống.
  const diskFree = fraction(input.diskFreeBytes, input.diskTotalBytes);
  if (diskFree !== null) {
    const detail = `đĩa trống ${(diskFree * 100).toFixed(1)}%`;
    if (diskFree < t.diskFreeCrit) {
      checks.push({ name: 'disk-free', ok: false, level: 'crit', detail });
      mark('crit', `Đĩa gần hết: ${detail}`);
    } else if (diskFree < t.diskFreeWarn) {
      checks.push({ name: 'disk-free', ok: false, level: 'warn', detail });
      mark('warn', `Đĩa thấp: ${detail}`);
    } else {
      checks.push({ name: 'disk-free', ok: true, level: 'warn', detail });
    }
  } else {
    checks.push({ name: 'disk-free', ok: true, level: 'warn', detail: 'node không báo đĩa' });
  }

  // Sức chứa bot.
  if (isFiniteNumber(input.maxBots) && input.maxBots !== null) {
    const detail = `${input.runningBots}/${input.maxBots} bot`;
    if (input.runningBots > input.maxBots) {
      checks.push({ name: 'bot-capacity', ok: false, level: 'crit', detail });
      mark('crit', `Node quá tải bot: ${detail}`);
    } else if (input.runningBots === input.maxBots && input.maxBots > 0) {
      checks.push({ name: 'bot-capacity', ok: false, level: 'warn', detail });
      mark('warn', `Node đầy bot: ${detail}`);
    } else {
      checks.push({ name: 'bot-capacity', ok: true, level: 'warn', detail });
    }
  } else {
    checks.push({ name: 'bot-capacity', ok: true, level: 'warn', detail: `${input.runningBots} bot (không giới hạn)` });
  }

  return { nodeId: input.nodeId, status: worst, checks, reasons, checkedAtMs: nowMs };
}

/** Hành động fleet v8 quyết định cho một node xấu. */
export type FleetV8NodeAction = 'none' | 'drain' | 'restart-bots' | 'evacuate';

/** Chính sách hành động theo trạng thái node. */
export interface FleetV8NodeActionPolicy {
  /** Số lần down liên tiếp thì evacuate thay vì restart-bot. */
  evacuateAfterDowns: number;
  /** Backoff cơ số giữa các lần restart bot (ms). */
  restartBaseBackoffMs: number;
  /** Backoff tối đa giữa các lần restart bot (ms). */
  restartMaxBackoffMs: number;
}

export const DEFAULT_FLEET_V8_ACTION_POLICY: FleetV8NodeActionPolicy = {
  evacuateAfterDowns: FLEET_V8_DEFAULT_EVACUATE_AFTER_DOWNS,
  restartBaseBackoffMs: FLEET_V8_DEFAULT_RESTART_BASE_BACKOFF_MS,
  restartMaxBackoffMs: FLEET_V8_DEFAULT_RESTART_MAX_BACKOFF_MS,
};

/** Kết quả quyết định hành động cho một node. */
export interface FleetV8NodeActionDecision {
  nodeId: string;
  status: FleetV8NodeHealthStatus;
  action: FleetV8NodeAction;
  /** ms nên đợi trước khi thực hiện hành động (0 = ngay). */
  delayMs: number;
  /** Số lần down liên tiếp đã ghi nhận (để UI thấy node sắp bị evacuate). */
  consecutiveDowns: number;
  reason: string;
}

/** Backoff tăng dần: base * 2^attempt, chặn trên max (attempt < 0 coi như 0). */
export function fleetV8RestartBackoffMs(policy: FleetV8NodeActionPolicy, attempt: number): number {
  const safeAttempt = Math.max(0, Math.floor(attempt));
  const raw = policy.restartBaseBackoffMs * 2 ** safeAttempt;
  return Math.min(policy.restartMaxBackoffMs, raw);
}

/**
 * Quyết định hành động cho một node theo trạng thái + lịch sử down.
 * - healthy → none. degraded → drain (ngừng nhận bot mới).
 * - unhealthy → restart-bots (backoff theo số lần restart đã thử).
 * - down → restart-bots lần đầu, evacuate khi down liên tiếp đủ ngưỡng.
 * Hàm thuần: không đọc/ghi file, không restart thật.
 */
export function decideFleetV8NodeAction(
  result: FleetV8NodeHealthResult,
  opts: {
    consecutiveDowns?: number;
    restartAttempts?: number;
    policy?: Partial<FleetV8NodeActionPolicy>;
  } = {},
): FleetV8NodeActionDecision {
  const policy: FleetV8NodeActionPolicy = { ...DEFAULT_FLEET_V8_ACTION_POLICY, ...opts.policy };
  const consecutiveDowns = Math.max(0, Math.floor(opts.consecutiveDowns ?? 0));
  const restartAttempts = Math.max(0, Math.floor(opts.restartAttempts ?? 0));
  const { nodeId, status } = result;
  if (status === 'healthy') {
    return { nodeId, status, action: 'none', delayMs: 0, consecutiveDowns, reason: 'node khoẻ, không cần làm gì' };
  }
  if (status === 'degraded') {
    return { nodeId, status, action: 'drain', delayMs: 0, consecutiveDowns, reason: 'node yếu — ngừng nhận bot mới, để bot cũ chạy hết' };
  }
  if (status === 'unhealthy') {
    return {
      nodeId,
      status,
      action: 'restart-bots',
      delayMs: fleetV8RestartBackoffMs(policy, restartAttempts),
      consecutiveDowns,
      reason: 'node không khoẻ — khởi động lại bot trên node (backoff tăng dần)',
    };
  }
  // down
  if (consecutiveDowns + 1 >= policy.evacuateAfterDowns) {
    return {
      nodeId,
      status,
      action: 'evacuate',
      delayMs: 0,
      consecutiveDowns: consecutiveDowns + 1,
      reason: `node down ${consecutiveDowns + 1} lần liên tiếp — chuyển bot sang node khác thay vì restart mãi`,
    };
  }
  return {
    nodeId,
    status,
    action: 'restart-bots',
    delayMs: fleetV8RestartBackoffMs(policy, restartAttempts),
    consecutiveDowns: consecutiveDowns + 1,
    reason: 'node mất heartbeat — thử khởi động lại bot trên node',
  };
}

// ---------------------------------------------------------------------------
// Probe tài nguyên máy local (node:os + statfs)
// ---------------------------------------------------------------------------

/** Kết quả probe tài nguyên thật của máy local. */
export interface FleetV8LocalProbe {
  cpuCores: number;
  cpuLoad1m: number | null;
  ramTotalBytes: number;
  ramFreeBytes: number;
  /** null khi nền tảng không hỗ trợ statfs (vd Windows cũ / fs ảo). */
  diskTotalBytes: number | null;
  /** null khi nền tảng không hỗ trợ statfs. */
  diskFreeBytes: number | null;
  /** Đường dẫn đã probe đĩa (mặc định: thư mục home). */
  diskPath: string;
  probedAtMs: number;
}

/**
 * Probe máy local: CPU cores + load 1m + RAM + đĩa. Không gọi mạng,
 * không spawn. `diskPath` mặc định là home dir của user (nơi app đặt
 * userData); caller có thể chỉ đường dẫn khác (vd fleet root).
 */
export function probeFleetV8LocalNode(diskPath: string = os.homedir(), nowMs: number = Date.now()): FleetV8LocalProbe {
  const load = os.loadavg();
  let diskTotalBytes: number | null = null;
  let diskFreeBytes: number | null = null;
  try {
    const statfs = (fs as unknown as { statfsSync?: (p: string) => { bsize: number; blocks: number; bfree: number } }).statfsSync;
    if (typeof statfs === 'function') {
      const s = statfs(diskPath);
      diskTotalBytes = s.bsize * s.blocks;
      diskFreeBytes = s.bsize * s.bfree;
    }
  } catch {
    diskTotalBytes = null;
    diskFreeBytes = null;
  }
  return {
    cpuCores: Math.max(1, os.cpus().length),
    cpuLoad1m: load.length > 0 && isFiniteNumber(load[0]) ? load[0] as number : null,
    ramTotalBytes: os.totalmem(),
    ramFreeBytes: os.freemem(),
    diskTotalBytes,
    diskFreeBytes,
    diskPath,
    probedAtMs: nowMs,
  };
}

/** Gộp probe local thành input đánh giá node (heartbeat do caller đưa). */
export function fleetV8NodeHealthInputFromProbe(
  nodeId: string,
  probe: FleetV8LocalProbe,
  opts: { heartbeatAgeMs?: number | null; runningBots?: number; maxBots?: number | null; draining?: boolean } = {},
): FleetV8NodeHealthInput {
  return {
    nodeId,
    cpuCores: probe.cpuCores,
    cpuLoad1m: probe.cpuLoad1m,
    ramTotalBytes: probe.ramTotalBytes,
    ramFreeBytes: probe.ramFreeBytes,
    diskTotalBytes: probe.diskTotalBytes,
    diskFreeBytes: probe.diskFreeBytes,
    heartbeatAgeMs: opts.heartbeatAgeMs ?? 0,
    runningBots: opts.runningBots ?? 0,
    maxBots: opts.maxBots ?? null,
    draining: opts.draining ?? false,
  };
}

// ---------------------------------------------------------------------------
// Trạng thái theo dõi node (durable) + incident log
// ---------------------------------------------------------------------------

/** Trạng thái theo dõi một node qua các lần check. */
export interface FleetV8NodeTrackState {
  nodeId: string;
  /** Trạng thái lần check cuối. */
  lastStatus: FleetV8NodeHealthStatus;
  /** ms epoch lần check cuối. */
  lastCheckedAtMs: number;
  /** Số lần down liên tiếp (reset khi node sống lại). */
  consecutiveDowns: number;
  /** Số lần restart bot đã thử trên node này. */
  restartAttempts: number;
  /** Tổng số lần node từng down. */
  totalDowns: number;
  /** Tổng số lần node từng bị evacuate. */
  totalEvacuations: number;
}

export function emptyFleetV8NodeTrackState(nodeId: string, nowMs: number = Date.now()): FleetV8NodeTrackState {
  return {
    nodeId,
    lastStatus: 'healthy',
    lastCheckedAtMs: nowMs,
    consecutiveDowns: 0,
    restartAttempts: 0,
    totalDowns: 0,
    totalEvacuations: 0,
  };
}

export function validateFleetV8NodeTrackState(raw: unknown): FleetV8NodeTrackState {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('FleetV8NodeTrackState must be an object.');
  }
  const rec = raw as Record<string, unknown>;
  if (typeof rec['nodeId'] !== 'string' || (rec['nodeId'] as string).trim() === '') {
    throw new Error('FleetV8NodeTrackState.nodeId must be a non-empty string.');
  }
  const status = rec['lastStatus'];
  if (typeof status !== 'string' || !(FLEET_V8_NODE_HEALTH_STATUSES as readonly string[]).includes(status)) {
    throw new Error('FleetV8NodeTrackState.lastStatus is invalid.');
  }
  for (const key of ['lastCheckedAtMs', 'consecutiveDowns', 'restartAttempts', 'totalDowns', 'totalEvacuations'] as const) {
    const v = rec[key];
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
      throw new Error(`FleetV8NodeTrackState.${key} must be a non-negative number.`);
    }
  }
  return {
    nodeId: (rec['nodeId'] as string).trim(),
    lastStatus: status as FleetV8NodeHealthStatus,
    lastCheckedAtMs: rec['lastCheckedAtMs'] as number,
    consecutiveDowns: Math.floor(rec['consecutiveDowns'] as number),
    restartAttempts: Math.floor(rec['restartAttempts'] as number),
    totalDowns: Math.floor(rec['totalDowns'] as number),
    totalEvacuations: Math.floor(rec['totalEvacuations'] as number),
  };
}

/** Cập nhật trạng thái theo dõi sau một lần check (hàm thuần). */
export function updateFleetV8NodeTrackState(
  prev: FleetV8NodeTrackState | undefined,
  result: FleetV8NodeHealthResult,
  action: FleetV8NodeAction,
): FleetV8NodeTrackState {
  const base = prev ?? emptyFleetV8NodeTrackState(result.nodeId, result.checkedAtMs);
  const down = result.status === 'down';
  return {
    nodeId: result.nodeId,
    lastStatus: result.status,
    lastCheckedAtMs: result.checkedAtMs,
    consecutiveDowns: down ? base.consecutiveDowns + 1 : 0,
    restartAttempts: action === 'restart-bots' ? base.restartAttempts + 1 : result.status === 'healthy' ? 0 : base.restartAttempts,
    totalDowns: down ? base.totalDowns + 1 : base.totalDowns,
    totalEvacuations: action === 'evacuate' ? base.totalEvacuations + 1 : base.totalEvacuations,
  };
}

export function getFleetV8HealthPath(rootDir: string): string {
  return path.join(rootDir, FLEET_V8_HEALTH_FILE);
}

export function getFleetV8IncidentsPath(rootDir: string): string {
  return path.join(rootDir, FLEET_V8_INCIDENTS_FILE);
}

export function loadFleetV8NodeStates(rootDir: string): FleetV8NodeTrackState[] {
  const file = getFleetV8HealthPath(rootDir);
  if (!fs.existsSync(file)) return [];
  const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
  if (!Array.isArray(raw)) throw new Error(`Invalid ${FLEET_V8_HEALTH_FILE}: expected an array.`);
  return raw.map((entry) => validateFleetV8NodeTrackState(entry));
}

export function saveFleetV8NodeStates(rootDir: string, states: FleetV8NodeTrackState[]): void {
  const file = getFleetV8HealthPath(rootDir);
  fs.mkdirSync(rootDir, { recursive: true });
  const trimmed = states.slice(-FLEET_V8_MAX_TRACKED_NODES);
  const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  fs.writeFileSync(tmp, `${JSON.stringify(trimmed, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // Windows không có chmod unix — bỏ qua.
  }
}

/** Loại incident v8. */
export type FleetV8IncidentKind =
  | 'node-down'
  | 'node-degraded'
  | 'node-recovered'
  | 'node-evacuated'
  | 'bot-restart'
  | 'bot-restart-exhausted'
  | 'rebalance';

export const FLEET_V8_INCIDENT_KINDS: readonly FleetV8IncidentKind[] = [
  'node-down',
  'node-degraded',
  'node-recovered',
  'node-evacuated',
  'bot-restart',
  'bot-restart-exhausted',
  'rebalance',
];

export interface FleetV8Incident {
  id: string;
  kind: FleetV8IncidentKind;
  nodeId: string;
  /** Bot liên quan (nếu có). */
  botId?: string;
  message: string;
  atMs: number;
}

export function createFleetV8Incident(
  kind: FleetV8IncidentKind,
  nodeId: string,
  message: string,
  opts: { botId?: string; atMs?: number } = {},
): FleetV8Incident {
  if (!FLEET_V8_INCIDENT_KINDS.includes(kind)) throw new Error(`Unknown FleetV8IncidentKind: ${kind}`);
  if (nodeId.trim() === '') throw new Error('FleetV8Incident.nodeId must be a non-empty string.');
  if (message.trim() === '') throw new Error('FleetV8Incident.message must be a non-empty string.');
  return {
    id: `vi8-${crypto.randomUUID()}`,
    kind,
    nodeId: nodeId.trim(),
    ...(opts.botId ? { botId: opts.botId } : {}),
    message: message.trim(),
    atMs: opts.atMs ?? Date.now(),
  };
}

export function validateFleetV8Incident(raw: unknown): FleetV8Incident {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('FleetV8Incident must be an object.');
  }
  const rec = raw as Record<string, unknown>;
  if (typeof rec['id'] !== 'string' || (rec['id'] as string).trim() === '') {
    throw new Error('FleetV8Incident.id must be a non-empty string.');
  }
  if (typeof rec['kind'] !== 'string' || !(FLEET_V8_INCIDENT_KINDS as readonly string[]).includes(rec['kind'])) {
    throw new Error('FleetV8Incident.kind is invalid.');
  }
  if (typeof rec['nodeId'] !== 'string' || (rec['nodeId'] as string).trim() === '') {
    throw new Error('FleetV8Incident.nodeId must be a non-empty string.');
  }
  if (typeof rec['message'] !== 'string' || (rec['message'] as string).trim() === '') {
    throw new Error('FleetV8Incident.message must be a non-empty string.');
  }
  if (typeof rec['atMs'] !== 'number' || !Number.isFinite(rec['atMs'])) {
    throw new Error('FleetV8Incident.atMs must be a number.');
  }
  if (rec['botId'] !== undefined && typeof rec['botId'] !== 'string') {
    throw new Error('FleetV8Incident.botId must be a string when present.');
  }
  return {
    id: rec['id'] as string,
    kind: rec['kind'] as FleetV8IncidentKind,
    nodeId: rec['nodeId'] as string,
    ...(typeof rec['botId'] === 'string' ? { botId: rec['botId'] } : {}),
    message: rec['message'] as string,
    atMs: rec['atMs'] as number,
  };
}

/** Append một incident vào JSONL, giữ tối đa FLEET_V8_MAX_INCIDENTS dòng mới nhất. */
export function appendFleetV8Incident(rootDir: string, incident: FleetV8Incident): void {
  const file = getFleetV8IncidentsPath(rootDir);
  fs.mkdirSync(rootDir, { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(incident)}\n`, { mode: 0o600 });
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim() !== '');
  if (lines.length > FLEET_V8_MAX_INCIDENTS) {
    const kept = lines.slice(-FLEET_V8_MAX_INCIDENTS);
    const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
    fs.writeFileSync(tmp, `${kept.join('\n')}\n`, { mode: 0o600 });
    fs.renameSync(tmp, file);
  }
}

export function listFleetV8Incidents(
  rootDir: string,
  opts: { kind?: FleetV8IncidentKind; nodeId?: string; limit?: number } = {},
): FleetV8Incident[] {
  const file = getFleetV8IncidentsPath(rootDir);
  if (!fs.existsSync(file)) return [];
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim() !== '');
  const all = lines.map((line) => validateFleetV8Incident(JSON.parse(line) as unknown));
  const filtered = all.filter(
    (i) => (opts.kind === undefined || i.kind === opts.kind) && (opts.nodeId === undefined || i.nodeId === opts.nodeId),
  );
  // Mới nhất trước.
  const reversed = filtered.reverse();
  return opts.limit !== undefined ? reversed.slice(0, Math.max(0, opts.limit)) : reversed;
}

export function formatFleetV8IncidentLine(incident: FleetV8Incident): string {
  const when = new Date(incident.atMs).toISOString();
  const bot = incident.botId ? ` bot=${incident.botId}` : '';
  return `[${when}] ${incident.kind} node=${incident.nodeId}${bot} — ${incident.message}`;
}

// ---------------------------------------------------------------------------
// Rebalance — chuyển bot khỏi node xấu sang node khoẻ
// ---------------------------------------------------------------------------

/** Một node tham gia rebalance (đánh giá + sức chứa + vị trí bot). */
export interface FleetV8RebalanceNode {
  nodeId: string;
  status: FleetV8NodeHealthStatus;
  /** true = node local/loopback — ưu tiên nhận bot hơn node LAN xa. */
  loopback: boolean;
  /** Số bot tối đa — null = không giới hạn. */
  maxBots: number | null;
  /** Tỉ lệ tài nguyên trống 0..1 (RAM trống là chính) — null = không biết. */
  freeFraction: number | null;
  /** true khi node đang draining — không nhận bot mới, bot cũ được chuyển đi. */
  draining: boolean;
}

/** Một bot đang đặt trên một node. */
export interface FleetV8RebalanceBot {
  botId: string;
  nodeId: string;
}

/** Một lần chuyển bot trong kế hoạch rebalance. */
export interface FleetV8RebalanceMove {
  botId: string;
  fromNodeId: string;
  toNodeId: string;
  reason: string;
}

/** Kết quả kế hoạch rebalance (dry-run, chỉ đọc). */
export interface FleetV8RebalancePlan {
  moves: FleetV8RebalanceMove[];
  /** Bot không chuyển được vì không còn node nào nhận (kèm lý do). */
  unplaced: { botId: string; fromNodeId: string; reason: string }[];
  /** Node nguồn đã hết bot cần chuyển / node đích đã đầy. */
  summary: string;
  plannedAtMs: number;
}

/**
 * Lập kế hoạch chuyển bot: bot trên node down/unhealthy/draining hoặc
 * quá tải được chuyển sang node healthy còn chỗ. Node đích được xếp
 * hạng: loopback trước, rồi freeFraction cao, rồi còn nhiều slot trống.
 * Hàm thuần — không di chuyển bot thật, không ghi file.
 */
export function planFleetV8Rebalance(
  nodes: FleetV8RebalanceNode[],
  bots: FleetV8RebalanceBot[],
  nowMs: number = Date.now(),
): FleetV8RebalancePlan {
  const byId = new Map(nodes.map((n) => [n.nodeId, n]));
  const used = new Map<string, number>();
  for (const bot of bots) used.set(bot.nodeId, (used.get(bot.nodeId) ?? 0) + 1);

  const freeSlots = (node: FleetV8RebalanceNode): number => {
    if (node.maxBots === null) return Number.POSITIVE_INFINITY;
    return Math.max(0, node.maxBots - (used.get(node.nodeId) ?? 0));
  };

  const destinations = nodes
    .filter((n) => n.status === 'healthy' && !n.draining)
    .sort((a, b) => {
      if (a.loopback !== b.loopback) return a.loopback ? -1 : 1;
      const fa = a.freeFraction ?? 0;
      const fb = b.freeFraction ?? 0;
      if (fa !== fb) return fb - fa;
      return freeSlots(b) - freeSlots(a);
    });

  const needsMove = (node: FleetV8RebalanceNode | undefined, botCount: number): string | null => {
    if (!node) return 'node nguồn không còn trong fleet';
    if (node.status === 'down') return 'node down — chuyển bot sang node khoẻ';
    if (node.status === 'unhealthy') return 'node không khoẻ — chuyển bot sang node khoẻ';
    if (node.draining) return 'node đang draining — chuyển bot sang node khác';
    if (node.maxBots !== null && botCount > node.maxBots) return `node quá tải bot (${botCount}/${node.maxBots})`;
    return null;
  };

  const moves: FleetV8RebalanceMove[] = [];
  const unplaced: FleetV8RebalancePlan['unplaced'] = [];
  // Bot trên node cần chuyển, xử lý theo thứ tự botId để kết quả ổn định.
  const sortedBots = [...bots].sort((a, b) => (a.botId < b.botId ? -1 : a.botId > b.botId ? 1 : 0));
  for (const bot of sortedBots) {
    const source = byId.get(bot.nodeId);
    const reason = needsMove(source, used.get(bot.nodeId) ?? 0);
    if (reason === null) continue;
    // Tìm đích còn slot (bỏ qua chính node nguồn).
    const dest = destinations.find((d) => d.nodeId !== bot.nodeId && freeSlots(d) > 0);
    if (!dest) {
      unplaced.push({ botId: bot.botId, fromNodeId: bot.nodeId, reason: 'không còn node khoẻ nào nhận bot' });
      continue;
    }
    moves.push({ botId: bot.botId, fromNodeId: bot.nodeId, toNodeId: dest.nodeId, reason });
    used.set(bot.nodeId, (used.get(bot.nodeId) ?? 1) - 1);
    used.set(dest.nodeId, (used.get(dest.nodeId) ?? 0) + 1);
  }

  const summary =
    moves.length === 0 && unplaced.length === 0
      ? 'Fleet cân bằng — không cần chuyển bot nào.'
      : `${moves.length} bot cần chuyển, ${unplaced.length} bot chưa đặt được (hết node khoẻ).`;
  return { moves, unplaced, summary, plannedAtMs: nowMs };
}

/** Rollup nhanh toàn fleet từ kết quả check từng node (hàm thuần). */
export interface FleetV8HealthRollup {
  totalNodes: number;
  healthy: number;
  degraded: number;
  unhealthy: number;
  down: number;
  /** true khi có ít nhất một node down/unhealthy. */
  needsAttention: boolean;
  worstStatus: FleetV8NodeHealthStatus | 'none';
}

export function rollupFleetV8NodeHealth(results: FleetV8NodeHealthResult[]): FleetV8HealthRollup {
  const rollup: FleetV8HealthRollup = {
    totalNodes: results.length,
    healthy: 0,
    degraded: 0,
    unhealthy: 0,
    down: 0,
    needsAttention: false,
    worstStatus: 'none',
  };
  for (const r of results) {
    rollup[r.status] += 1;
  }
  rollup.needsAttention = rollup.down > 0 || rollup.unhealthy > 0;
  rollup.worstStatus =
    rollup.down > 0 ? 'down' : rollup.unhealthy > 0 ? 'unhealthy' : rollup.degraded > 0 ? 'degraded' : results.length > 0 ? 'healthy' : 'none';
  return rollup;
}

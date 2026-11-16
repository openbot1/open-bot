/**
 * Fleet rollout v12 — rollout cấu hình/phiên bản theo nhóm phần trăm
 * (v1.15, Đội T6).
 *
 * Tầng trên của rollout v11 (`fleetV11Rollout.ts` — nhóm đặt tên
 * canary/pilot/all, gate mở rộng, auto-rollback đề xuất). V11 trả lời
 * "nhóm nào trước"; module này trả lời "bao nhiêu phần trăm fleet,
 * node nào nằm trong từng phần trăm, và khi nào phải dừng lại tự động".
 *
 * - Nhóm phần trăm cố định: canary (1 node) → 25% → 50% → 100%.
 *   Cohort (tập node trong một mức phần trăm) được chọn DETERMINISTIC
 *   bằng hash (nodeId + rolloutId): cùng một rollout + cùng danh sách
 *   node thì cohort không đổi giữa các lần tính — node không bị nhảy
 *   nhóm khi operator mở lại dashboard.
 * - Máy trạng thái (hàm thuần): `draft -> canary -> expanding ->
 *   complete`, `paused`, `rolled-back`. Chuyển đổi không hợp lệ bị từ
 *   chối kèm lý do.
 * - Health gate trước mỗi lần mở rộng: tỉ lệ lỗi cohort hiện tại,
 *   số node down trong cohort, alert critical đang mở trên cohort
 *   tiếp theo. Gate trả từng điều kiện riêng để UI vẽ rõ lý do chặn.
 * - Pause/rollback tự động: `decideFleetV12AutoAction` — khi health
 *   check fail (lỗi vượt ngưỡng, quá nhiều node down, hoặc alert
 *   critical mới trên cohort đang chạy) thì đề xuất `pause` (lỗi nhẹ,
 *   có thể resume) hoặc `rollback` (lỗi nặng). Module chỉ ĐỀ XUẤT;
 *   việc áp dụng do caller gọi `applyFleetV12RolloutAction`.
 * - Bền vững: tất cả rollout lưu trong
 *   `<fleetRoot>/fleet-rollouts-v115.json` (atomic tmp + rename, mode
 *   0600); mỗi lần chuyển trạng thái ghi một entry vào history
 *   (actor + lý do + thời điểm) để audit.
 *
 * Module này KHÔNG chạm mạng, KHÔNG spawn process, KHÔNG tự triển
 * khai thật lên node: nó quyết định "mức phần trăm nào, node nào,
 * dừng hay lùi" — việc đẩy config thật do FleetServiceManager làm.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

/** File lưu rollout v12 trong fleet root. */
export const FLEET_V12_ROLLOUTS_FILE = 'fleet-rollouts-v115.json';
/** Tỉ lệ lỗi tối đa cho phép trong cohort trước khi gate chặn (mặc định). */
export const FLEET_V12_DEFAULT_MAX_ERROR_RATE = 0.05;
/** Tỉ lệ lỗi vượt ngưỡng này thì đề xuất rollback (mặc định). */
export const FLEET_V12_DEFAULT_ROLLBACK_ERROR_RATE = 0.2;
/** Tỉ lệ lỗi vượt ngưỡng này (nhưng dưới ngưỡng rollback) thì đề xuất pause. */
export const FLEET_V12_DEFAULT_PAUSE_ERROR_RATE = 0.1;
/** Số node down tối đa cho phép trước khi đề xuất pause (mặc định). */
export const FLEET_V12_DEFAULT_MAX_DOWN_NODES = 1;
/** Số node down vượt ngưỡng này thì đề xuất rollback (mặc định). */
export const FLEET_V12_DEFAULT_ROLLBACK_DOWN_NODES = 3;
/** Số rollout tối đa lưu trong file. */
export const FLEET_V12_MAX_ROLLOUTS = 100;

/** Các mức phần trăm rollout, theo thứ tự triển khai. */
export const FLEET_V12_ROLLOUT_PERCENTAGES = [1, 25, 50, 100] as const;

export type FleetV12RolloutPercentage = (typeof FLEET_V12_ROLLOUT_PERCENTAGES)[number];

/** Nhãn hiển thị cho từng mức phần trăm. */
export function fleetV12PercentageLabel(pct: number): string {
  if (pct === 1) return 'canary (1 node)';
  return `${pct}%`;
}

/** Giai đoạn của một rollout v12. */
export type FleetV12RolloutStage =
  | 'draft'
  | 'canary'
  | 'expanding'
  | 'paused'
  | 'complete'
  | 'rolled-back';

export const FLEET_V12_ROLLOUT_STAGES: readonly FleetV12RolloutStage[] = [
  'draft',
  'canary',
  'expanding',
  'paused',
  'complete',
  'rolled-back',
];

/** Hành động điều khiển rollout v12. */
export type FleetV12RolloutAction =
  | 'start'
  | 'advance'
  | 'pause'
  | 'resume'
  | 'complete'
  | 'rollback';

export const FLEET_V12_ROLLOUT_ACTIONS: readonly FleetV12RolloutAction[] = [
  'start',
  'advance',
  'pause',
  'resume',
  'complete',
  'rollback',
];

/** Chuyển đổi trạng thái hợp lệ của máy trạng thái rollout v12. */
export const FLEET_V12_ROLLOUT_TRANSITIONS: Record<
  FleetV12RolloutStage,
  readonly FleetV12RolloutAction[]
> = {
  draft: ['start', 'rollback'],
  canary: ['advance', 'pause', 'complete', 'rollback'],
  expanding: ['advance', 'pause', 'complete', 'rollback'],
  paused: ['resume', 'rollback', 'complete'],
  complete: [],
  'rolled-back': [],
};

/** Trạng thái của một mức phần trăm trong rollout. */
export type FleetV12CohortStatus = 'pending' | 'active' | 'done' | 'failed' | 'rolled-back';

export const FLEET_V12_COHORT_STATUSES: readonly FleetV12CohortStatus[] = [
  'pending',
  'active',
  'done',
  'failed',
  'rolled-back',
];

/** Một mức phần trăm (cohort) trong rollout. */
export interface FleetV12RolloutCohort {
  /** Phần trăm fleet ở mức này (1 = canary 1 node, rồi 25/50/100). */
  percentage: number;
  /** Node id trong cohort này (tính deterministic từ danh sách node). */
  nodeIds: string[];
  status: FleetV12CohortStatus;
  startedAt: number | null;
  finishedAt: number | null;
  appliedCount: number;
  errorCount: number;
}

/** Một entry history của rollout v12 (audit). */
export interface FleetV12RolloutHistoryEntry {
  at: number;
  action: FleetV12RolloutAction | 'create' | 'gate-blocked' | 'auto-pause-suggested' | 'auto-rollback-suggested';
  fromStage: FleetV12RolloutStage;
  toStage: FleetV12RolloutStage;
  actorUserId: string;
  reason: string;
  detail?: string;
}

/** Một rollout v12. */
export interface FleetV12Rollout {
  id: string;
  name: string;
  description: string;
  /** Tên tính năng/config được triển khai. */
  feature: string;
  version: string;
  /** Version đang chạy trước rollout (để rollback về). */
  previousVersion: string;
  /** Toàn bộ node của fleet lúc tạo rollout (cohort tính từ đây). */
  allNodeIds: string[];
  stage: FleetV12RolloutStage;
  cohorts: FleetV12RolloutCohort[];
  /** Chỉ số cohort đang active (null = chưa bắt đầu / đã xong). */
  activeCohortIndex: number | null;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
  history: FleetV12RolloutHistoryEntry[];
}

/** Input tạo rollout v12 (chưa có id/stage/history/cohort). */
export interface CreateFleetV12RolloutInput {
  name: string;
  description?: string;
  feature: string;
  version: string;
  previousVersion: string;
  /** Toàn bộ node id của fleet (ít nhất 1). Cohort tính từ đây. */
  allNodeIds: string[];
  createdBy: string;
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

function slugifyName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-_]/g, '')
    .slice(0, 64);
}

/**
 * Hash deterministic của một node trong một rollout: 0..2^32-1.
 * Dùng SHA-256 của `rolloutId + '\n' + nodeId`, lấy 8 ký tự hex đầu.
 * Cùng rollout + cùng node → cùng giá trị → cohort ổn định.
 */
export function fleetV12NodeHash(rolloutId: string, nodeId: string): number {
  const hex = crypto
    .createHash('sha256')
    .update(`${rolloutId}\n${nodeId}`, 'utf8')
    .digest('hex')
    .slice(0, 8);
  return Number.parseInt(hex, 16);
}

/**
 * Tính cohort cho một mức phần trăm: sắp xếp node theo hash tăng dần,
 * lấy N node đầu (N = ceil(pct% * tổng), canary lấy đúng 1 node).
 * Cohort mức cao hơn BAO HÀM cohort mức thấp hơn (mở rộng, không đổi
 * nhóm) — node đã nhận rollout ở canary vẫn nằm trong 25%.
 */
export function computeFleetV12Cohort(
  rolloutId: string,
  allNodeIds: string[],
  percentage: number,
): string[] {
  const unique = [...new Set(allNodeIds.filter((n) => isNonEmptyString(n)))];
  if (unique.length === 0) return [];
  const count =
    percentage <= 1
      ? 1
      : Math.min(unique.length, Math.max(1, Math.ceil((unique.length * percentage) / 100)));
  return unique
    .map((nodeId) => ({ nodeId, h: fleetV12NodeHash(rolloutId, nodeId) }))
    .sort((a, b) => a.h - b.h || a.nodeId.localeCompare(b.nodeId))
    .slice(0, count)
    .map((x) => x.nodeId);
}

/** Validate input tạo rollout v12. Trả về danh sách lỗi (rỗng = hợp lệ). */
export function validateFleetV12RolloutInput(input: CreateFleetV12RolloutInput): string[] {
  const errors: string[] = [];
  if (!isNonEmptyString(input?.name)) errors.push('tên rollout không được trống');
  if (!isNonEmptyString(input?.feature)) errors.push('tên tính năng không được trống');
  if (!isNonEmptyString(input?.version)) errors.push('version triển khai không được trống');
  if (!isNonEmptyString(input?.previousVersion)) errors.push('previousVersion không được trống');
  if (!isNonEmptyString(input?.createdBy)) errors.push('createdBy không được trống');
  if (!Array.isArray(input?.allNodeIds) || input.allNodeIds.length === 0) {
    errors.push('rollout cần ít nhất 1 node');
    return errors;
  }
  const seen = new Set<string>();
  for (const n of input.allNodeIds) {
    if (!isNonEmptyString(n)) {
      errors.push('node id không được trống');
      continue;
    }
    if (seen.has(n)) errors.push(`node "${n}" bị trùng`);
    seen.add(n);
  }
  return errors;
}

export function createFleetV12Rollout(
  input: CreateFleetV12RolloutInput,
  now = Date.now(),
): FleetV12Rollout {
  const errors = validateFleetV12RolloutInput(input);
  if (errors.length > 0) {
    throw new Error(`rollout không hợp lệ: ${errors.join('; ')}`);
  }
  const id = `ro12-${slugifyName(input.name)}-${now.toString(36)}`;
  const cohorts: FleetV12RolloutCohort[] = FLEET_V12_ROLLOUT_PERCENTAGES.map((pct) => ({
    percentage: pct,
    nodeIds: computeFleetV12Cohort(id, input.allNodeIds, pct),
    status: 'pending' as FleetV12CohortStatus,
    startedAt: null,
    finishedAt: null,
    appliedCount: 0,
    errorCount: 0,
  }));
  return {
    id,
    name: input.name.trim(),
    description: input.description?.trim() ?? '',
    feature: input.feature.trim(),
    version: input.version.trim(),
    previousVersion: input.previousVersion.trim(),
    allNodeIds: [...input.allNodeIds],
    stage: 'draft',
    cohorts,
    activeCohortIndex: null,
    createdBy: input.createdBy.trim(),
    createdAt: now,
    updatedAt: now,
    history: [
      {
        at: now,
        action: 'create',
        fromStage: 'draft',
        toStage: 'draft',
        actorUserId: input.createdBy.trim(),
        reason: 'tạo rollout',
      },
    ],
  };
}

/** Kết quả áp dụng một hành động lên rollout v12 (hàm thuần). */
export type FleetV12RolloutActionResult =
  | { ok: true; rollout: FleetV12Rollout }
  | { ok: false; rollout: FleetV12Rollout; error: string };

function withHistory(
  rollout: FleetV12Rollout,
  action: FleetV12RolloutAction,
  fromStage: FleetV12RolloutStage,
  toStage: FleetV12RolloutStage,
  actorUserId: string,
  reason: string,
  now: number,
): FleetV12Rollout {
  return {
    ...rollout,
    stage: toStage,
    updatedAt: now,
    history: [
      ...rollout.history,
      { at: now, action, fromStage, toStage, actorUserId, reason },
    ],
  };
}

function fail(rollout: FleetV12Rollout, error: string): FleetV12RolloutActionResult {
  return { ok: false, rollout, error };
}

/**
 * Áp dụng một hành động điều khiển rollout v12 (hàm thuần, không mutate).
 * - start: draft -> canary, kích hoạt cohort đầu (1 node).
 * - advance: cohort active phải done (đánh qua `markFleetV12CohortDone`)
 *   rồi kích hoạt cohort tiếp theo; hết cohort thì -> complete.
 * - pause/resume: tạm dừng / tiếp tục (resume về canary nếu đang ở
 *   cohort đầu, expanding nếu sau).
 * - complete: kết thúc sớm (cohort active được đánh done).
 * - rollback: tất cả cohort active/done -> rolled-back.
 */
export function applyFleetV12RolloutAction(
  rollout: FleetV12Rollout,
  action: FleetV12RolloutAction,
  actorUserId: string,
  reason: string,
  now = Date.now(),
): FleetV12RolloutActionResult {
  if (!isNonEmptyString(actorUserId)) return fail(rollout, 'actorUserId không được trống');
  if (!isNonEmptyString(reason)) return fail(rollout, 'reason không được trống');
  const allowed = FLEET_V12_ROLLOUT_TRANSITIONS[rollout.stage] ?? [];
  if (!allowed.includes(action)) {
    return fail(rollout, `không thể ${action} rollout đang ở giai đoạn ${rollout.stage}`);
  }
  const fromStage = rollout.stage;
  if (action === 'start') {
    const cohorts = rollout.cohorts.map((c, i) =>
      i === 0 ? { ...c, status: 'active' as FleetV12CohortStatus, startedAt: now } : c,
    );
    return {
      ok: true,
      rollout: withHistory(
        { ...rollout, cohorts, activeCohortIndex: 0 },
        action,
        fromStage,
        'canary',
        actorUserId,
        reason,
        now,
      ),
    };
  }
  if (action === 'advance') {
    const idx = rollout.activeCohortIndex;
    if (idx === null || !rollout.cohorts[idx]) {
      return fail(rollout, 'không có cohort đang active để mở rộng');
    }
    const active = rollout.cohorts[idx];
    if (active.status !== 'done') {
      return fail(
        rollout,
        `cohort ${fleetV12PercentageLabel(active.percentage)} chưa xong (trạng thái ${active.status}) — đánh dấu xong trước khi mở rộng`,
      );
    }
    const nextIdx = idx + 1;
    if (nextIdx >= rollout.cohorts.length) {
      return {
        ok: true,
        rollout: withHistory(
          { ...rollout, activeCohortIndex: null },
          action,
          fromStage,
          'complete',
          actorUserId,
          reason,
          now,
        ),
      };
    }
    const cohorts = rollout.cohorts.map((c, i) =>
      i === nextIdx ? { ...c, status: 'active' as FleetV12CohortStatus, startedAt: now } : c,
    );
    return {
      ok: true,
      rollout: withHistory(
        { ...rollout, cohorts, activeCohortIndex: nextIdx },
        action,
        fromStage,
        'expanding',
        actorUserId,
        reason,
        now,
      ),
    };
  }
  if (action === 'pause') {
    return {
      ok: true,
      rollout: withHistory(rollout, action, fromStage, 'paused', actorUserId, reason, now),
    };
  }
  if (action === 'resume') {
    const toStage: FleetV12RolloutStage =
      rollout.activeCohortIndex === 0 || rollout.activeCohortIndex === null
        ? 'canary'
        : 'expanding';
    return {
      ok: true,
      rollout: withHistory(rollout, action, fromStage, toStage, actorUserId, reason, now),
    };
  }
  if (action === 'complete') {
    const cohorts = rollout.cohorts.map((c) =>
      c.status === 'active' ? { ...c, status: 'done' as FleetV12CohortStatus, finishedAt: now } : c,
    );
    return {
      ok: true,
      rollout: withHistory(
        { ...rollout, cohorts, activeCohortIndex: null },
        action,
        fromStage,
        'complete',
        actorUserId,
        reason,
        now,
      ),
    };
  }
  // rollback
  const cohorts = rollout.cohorts.map((c) =>
    c.status === 'active' || c.status === 'done'
      ? { ...c, status: 'rolled-back' as FleetV12CohortStatus, finishedAt: now }
      : c,
  );
  return {
    ok: true,
    rollout: withHistory(
      { ...rollout, cohorts, activeCohortIndex: null },
      action,
      fromStage,
      'rolled-back',
      actorUserId,
      reason,
      now,
    ),
  };
}

/** Đánh dấu cohort active đã xong (hàm thuần). */
export function markFleetV12CohortDone(
  rollout: FleetV12Rollout,
  percentage: number,
  now = Date.now(),
): FleetV12Rollout {
  const cohorts = rollout.cohorts.map((c) =>
    c.percentage === percentage && c.status === 'active'
      ? { ...c, status: 'done' as FleetV12CohortStatus, finishedAt: now }
      : c,
  );
  return { ...rollout, cohorts, updatedAt: now };
}

/** Cập nhật tiến độ áp dụng của một cohort (số áp dụng/lỗi, kẹp hợp lệ). */
export function recordFleetV12CohortProgress(
  rollout: FleetV12Rollout,
  percentage: number,
  appliedCount: number,
  errorCount: number,
  now = Date.now(),
): FleetV12Rollout {
  const cohorts = rollout.cohorts.map((c) => {
    if (c.percentage !== percentage) return c;
    const total = c.nodeIds.length;
    return {
      ...c,
      appliedCount: Math.max(0, Math.min(total, Math.floor(appliedCount))),
      errorCount: Math.max(0, Math.min(total, Math.floor(errorCount))),
    };
  });
  return { ...rollout, cohorts, updatedAt: now };
}

/** Tỉ lệ lỗi của một cohort (0 khi chưa áp dụng node nào). */
export function fleetV12CohortErrorRate(cohort: FleetV12RolloutCohort): number {
  const total = cohort.appliedCount + cohort.errorCount;
  if (total <= 0) return 0;
  return cohort.errorCount / total;
}

/** Một điều kiện gate (mở rộng rollout sang mức phần trăm tiếp theo). */
export interface FleetV12GateCheck {
  name: string;
  passed: boolean;
  detail: string;
}

/** Kết quả kiểm tra gate mở rộng v12. */
export interface FleetV12GateResult {
  allowed: boolean;
  checks: FleetV12GateCheck[];
  nextPercentage: number | null;
}

/** Đầu vào cho gate v12: alert critical + node down + node healthy. */
export interface FleetV12GateInput {
  /** Node id đang có alert critical (chỉ tính node trong cohort tiếp theo). */
  criticalAlertNodeIds: string[];
  /** Node id đang down (chỉ tính node trong cohort đang chạy). */
  downNodeIds: string[];
  /** Node id đang healthy (chỉ tính node trong cohort tiếp theo). */
  healthyNodeIds: string[];
  maxErrorRate?: number;
  maxDownNodes?: number;
}

/**
 * Kiểm tra gate mở rộng rollout sang mức phần trăm tiếp theo (hàm thuần):
 * cohort active phải done, tỉ lệ lỗi dưới ngưỡng, không quá nhiều node
 * down trong cohort active, không có alert critical trên cohort tiếp
 * theo, và ít nhất một nửa node cohort tiếp theo đang healthy.
 */
export function checkFleetV12RolloutGate(
  rollout: FleetV12Rollout,
  input: FleetV12GateInput,
): FleetV12GateResult {
  const checks: FleetV12GateCheck[] = [];
  if (rollout.stage !== 'canary' && rollout.stage !== 'expanding') {
    return {
      allowed: false,
      checks: [
        {
          name: 'stage',
          passed: false,
          detail: `rollout đang ở giai đoạn ${rollout.stage}, chỉ mở rộng được khi đang chạy (canary/expanding)`,
        },
      ],
      nextPercentage: null,
    };
  }
  const idx = rollout.activeCohortIndex;
  if (idx === null || !rollout.cohorts[idx]) {
    checks.push({ name: 'active-cohort', passed: false, detail: 'không có cohort đang active' });
    return { allowed: false, checks, nextPercentage: null };
  }
  const active = rollout.cohorts[idx];
  const maxErrorRate =
    typeof input.maxErrorRate === 'number' && Number.isFinite(input.maxErrorRate)
      ? Math.max(0, Math.min(1, input.maxErrorRate))
      : FLEET_V12_DEFAULT_MAX_ERROR_RATE;
  const maxDownNodes =
    typeof input.maxDownNodes === 'number' && Number.isFinite(input.maxDownNodes)
      ? Math.max(0, Math.floor(input.maxDownNodes))
      : FLEET_V12_DEFAULT_MAX_DOWN_NODES;
  const errorRate = fleetV12CohortErrorRate(active);
  checks.push({
    name: 'cohort-done',
    passed: active.status === 'done',
    detail:
      active.status === 'done'
        ? `cohort ${fleetV12PercentageLabel(active.percentage)} đã xong`
        : `cohort ${fleetV12PercentageLabel(active.percentage)} chưa xong (trạng thái ${active.status})`,
  });
  checks.push({
    name: 'error-rate',
    passed: errorRate <= maxErrorRate,
    detail: `tỉ lệ lỗi cohort ${fleetV12PercentageLabel(active.percentage)} là ${(errorRate * 100).toFixed(1)}% (ngưỡng ${(maxErrorRate * 100).toFixed(1)}%)`,
  });
  const downInActive = active.nodeIds.filter((n) => input.downNodeIds.includes(n)).length;
  checks.push({
    name: 'down-nodes',
    passed: downInActive <= maxDownNodes,
    detail: `${downInActive} node down trong cohort đang chạy (tối đa ${maxDownNodes})`,
  });
  const nextIdx = idx + 1;
  if (nextIdx >= rollout.cohorts.length) {
    checks.push({ name: 'next-cohort', passed: true, detail: 'đã hết mức — advance sẽ hoàn tất rollout' });
    return { allowed: checks.every((c) => c.passed), checks, nextPercentage: null };
  }
  const next = rollout.cohorts[nextIdx];
  const criticalOnNext = next.nodeIds.filter((n) => input.criticalAlertNodeIds.includes(n));
  checks.push({
    name: 'no-critical-alert',
    passed: criticalOnNext.length === 0,
    detail:
      criticalOnNext.length === 0
        ? `không có alert nghiêm trọng trên cohort ${fleetV12PercentageLabel(next.percentage)}`
        : `${criticalOnNext.length} node cohort ${fleetV12PercentageLabel(next.percentage)} đang có alert nghiêm trọng: ${criticalOnNext.slice(0, 5).join(', ')}`,
  });
  const healthyCount = next.nodeIds.filter((n) => input.healthyNodeIds.includes(n)).length;
  const needHealthy = Math.ceil(next.nodeIds.length / 2);
  checks.push({
    name: 'next-cohort-healthy',
    passed: healthyCount >= needHealthy,
    detail: `${healthyCount}/${next.nodeIds.length} node cohort ${fleetV12PercentageLabel(next.percentage)} đang healthy (cần ít nhất ${needHealthy})`,
  });
  return { allowed: checks.every((c) => c.passed), checks, nextPercentage: next.percentage };
}

/** Đề xuất hành động tự động khi health check fail. */
export interface FleetV12AutoActionDecision {
  /** 'none' = không làm gì; 'pause' = tạm dừng; 'rollback' = lùi về version cũ. */
  action: 'none' | 'pause' | 'rollback';
  reasons: string[];
  errorRate: number;
  downNodes: number;
  criticalAlerts: number;
}

/**
 * Quyết định pause/rollback tự động (chỉ đề xuất, không tự thực hiện):
 * - rollback khi tỉ lệ lỗi vượt ngưỡng rollback, hoặc số node down
 *   vượt ngưỡng rollback, hoặc có alert critical trên cohort đang chạy.
 * - pause khi tỉ lệ lỗi vượt ngưỡng pause (nhưng dưới ngưỡng rollback)
 *   hoặc số node down vượt ngưỡng pause.
 * - không đề xuất khi rollout không đang chạy.
 */
export function decideFleetV12AutoAction(
  rollout: FleetV12Rollout,
  health: {
    downNodeIds: string[];
    criticalAlertNodeIds: string[];
  },
  opts?: {
    pauseErrorRate?: number;
    rollbackErrorRate?: number;
    maxDownNodes?: number;
    rollbackDownNodes?: number;
  },
): FleetV12AutoActionDecision {
  const reasons: string[] = [];
  const idx = rollout.activeCohortIndex;
  let errorRate = 0;
  let downNodes = 0;
  let criticalAlerts = 0;
  if (idx !== null && rollout.cohorts[idx]) {
    const active = rollout.cohorts[idx];
    errorRate = fleetV12CohortErrorRate(active);
    downNodes = active.nodeIds.filter((n) => health.downNodeIds.includes(n)).length;
    criticalAlerts = active.nodeIds.filter((n) => health.criticalAlertNodeIds.includes(n)).length;
  }
  if (rollout.stage !== 'canary' && rollout.stage !== 'expanding') {
    return {
      action: 'none',
      reasons: [`rollout không đang chạy (giai đoạn ${rollout.stage})`],
      errorRate,
      downNodes,
      criticalAlerts,
    };
  }
  const pauseErrorRate =
    typeof opts?.pauseErrorRate === 'number' && Number.isFinite(opts.pauseErrorRate)
      ? Math.max(0, Math.min(1, opts.pauseErrorRate))
      : FLEET_V12_DEFAULT_PAUSE_ERROR_RATE;
  const rollbackErrorRate =
    typeof opts?.rollbackErrorRate === 'number' && Number.isFinite(opts.rollbackErrorRate)
      ? Math.max(0, Math.min(1, opts.rollbackErrorRate))
      : FLEET_V12_DEFAULT_ROLLBACK_ERROR_RATE;
  const maxDownNodes =
    typeof opts?.maxDownNodes === 'number' && Number.isFinite(opts.maxDownNodes)
      ? Math.max(0, Math.floor(opts.maxDownNodes))
      : FLEET_V12_DEFAULT_MAX_DOWN_NODES;
  const rollbackDownNodes =
    typeof opts?.rollbackDownNodes === 'number' && Number.isFinite(opts.rollbackDownNodes)
      ? Math.max(0, Math.floor(opts.rollbackDownNodes))
      : FLEET_V12_DEFAULT_ROLLBACK_DOWN_NODES;
  if (errorRate > rollbackErrorRate) {
    reasons.push(
      `tỉ lệ lỗi ${(errorRate * 100).toFixed(1)}% vượt ngưỡng rollback ${(rollbackErrorRate * 100).toFixed(1)}%`,
    );
  }
  if (downNodes > rollbackDownNodes) {
    reasons.push(`${downNodes} node down, vượt ngưỡng rollback ${rollbackDownNodes}`);
  }
  if (criticalAlerts > 0) {
    reasons.push(`${criticalAlerts} node trong cohort đang chạy có alert nghiêm trọng`);
  }
  if (reasons.length > 0) {
    return { action: 'rollback', reasons, errorRate, downNodes, criticalAlerts };
  }
  if (errorRate > pauseErrorRate) {
    reasons.push(
      `tỉ lệ lỗi ${(errorRate * 100).toFixed(1)}% vượt ngưỡng pause ${(pauseErrorRate * 100).toFixed(1)}%`,
    );
  }
  if (downNodes > maxDownNodes) {
    reasons.push(`${downNodes} node down, vượt ngưỡng pause ${maxDownNodes}`);
  }
  return {
    action: reasons.length > 0 ? 'pause' : 'none',
    reasons,
    errorRate,
    downNodes,
    criticalAlerts,
  };
}

/** Tiến độ tổng của rollout v12 (0–1) + tóm tắt cho UI. */
export interface FleetV12RolloutProgress {
  applied: number;
  errors: number;
  total: number;
  fraction: number;
  activePercentage: number | null;
  doneCohorts: number;
  totalCohorts: number;
  summary: string;
}

export function summarizeFleetV12Rollout(rollout: FleetV12Rollout): FleetV12RolloutProgress {
  const total = rollout.allNodeIds.length;
  const applied = rollout.cohorts.reduce((a, c) => a + c.appliedCount, 0);
  const errors = rollout.cohorts.reduce((a, c) => a + c.errorCount, 0);
  const doneCohorts = rollout.cohorts.filter((c) => c.status === 'done').length;
  const active =
    rollout.activeCohortIndex !== null ? rollout.cohorts[rollout.activeCohortIndex] : undefined;
  const fraction = total > 0 ? applied / total : 0;
  const summary =
    rollout.stage === 'complete'
      ? `Rollout "${rollout.name}" hoàn tất: ${applied}/${total} node, ${errors} lỗi.`
      : rollout.stage === 'rolled-back'
        ? `Rollout "${rollout.name}" đã rollback về ${rollout.previousVersion}.`
        : rollout.stage === 'draft'
          ? `Rollout "${rollout.name}" đang nháp: ${total} node qua ${rollout.cohorts.length} mức (canary → 25% → 50% → 100%).`
          : `Rollout "${rollout.name}" đang ở mức ${active ? fleetV12PercentageLabel(active.percentage) : '?'} (${doneCohorts}/${rollout.cohorts.length} mức xong): ${applied}/${total} node, ${errors} lỗi.`;
  return {
    applied,
    errors,
    total,
    fraction,
    activePercentage: active?.percentage ?? null,
    doneCohorts,
    totalCohorts: rollout.cohorts.length,
    summary,
  };
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

export function getFleetV12RolloutsPath(fleetRoot: string): string {
  return path.join(fleetRoot, FLEET_V12_ROLLOUTS_FILE);
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

function isValidRollout(v: unknown): v is FleetV12Rollout {
  if (!v || typeof v !== 'object') return false;
  const r = v as Partial<FleetV12Rollout>;
  return (
    typeof r.id === 'string' &&
    typeof r.name === 'string' &&
    typeof r.feature === 'string' &&
    typeof r.version === 'string' &&
    Array.isArray(r.cohorts) &&
    Array.isArray(r.allNodeIds) &&
    FLEET_V12_ROLLOUT_STAGES.includes(r.stage as FleetV12RolloutStage)
  );
}

export function loadFleetV12Rollouts(fleetRoot: string): FleetV12Rollout[] {
  try {
    const raw = fs.readFileSync(getFleetV12RolloutsPath(fleetRoot), 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isValidRollout);
  } catch {
    return [];
  }
}

export function saveFleetV12Rollouts(fleetRoot: string, rollouts: FleetV12Rollout[]): void {
  atomicWriteFile(
    getFleetV12RolloutsPath(fleetRoot),
    `${JSON.stringify(rollouts.slice(0, FLEET_V12_MAX_ROLLOUTS), null, 2)}\n`,
  );
}

export function findFleetV12Rollout(rollouts: FleetV12Rollout[], id: string): FleetV12Rollout | null {
  return rollouts.find((r) => r.id === id) ?? null;
}

/** Thêm rollout mới (id trùng thì không thêm). Mới nhất trước. */
export function addFleetV12Rollout(
  rollouts: FleetV12Rollout[],
  rollout: FleetV12Rollout,
): FleetV12Rollout[] {
  if (rollouts.some((r) => r.id === rollout.id)) return rollouts;
  return [rollout, ...rollouts].slice(0, FLEET_V12_MAX_ROLLOUTS);
}

/** Thay rollout đã có bằng bản mới (id không tồn tại thì trả về cũ). */
export function updateFleetV12Rollout(
  rollouts: FleetV12Rollout[],
  rollout: FleetV12Rollout,
): FleetV12Rollout[] {
  if (!rollouts.some((r) => r.id === rollout.id)) return rollouts;
  return rollouts.map((r) => (r.id === rollout.id ? rollout : r));
}

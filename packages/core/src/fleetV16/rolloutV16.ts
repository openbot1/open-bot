/**
 * Rollout v5 — triển khai theo giai đoạn nâng cao: canary ramp theo
 * thời gian, feature flag có targeting + kill switch, auto-rollback
 * theo error budget (v1.19, Đội T6).
 *
 * Tầng trên của rollout v4 (`fleetV15/rolloutV15.ts` — rollout theo
 * node, approve theo stage, history gộp, auto-rollback đơn giản theo
 * ngưỡng lỗi) và rollout v3/v2 (`fleetV14/rolloutV14.ts` — stage
 * plan canary→all, nhóm user theo role/hash-bucket, ngưỡng lỗi).
 * V4 trả lời "stage nào, ai duyệt, node nào đã lên version mới";
 * v5 trả lời 3 câu vận hành tiếp theo:
 *
 * - CANARY RAMP: một canary plan là dãy bước {percent, dwellMs} —
 *   phần trăm user nhận tính năng tăng dần theo thời gian kể từ
 *   lúc bắt đầu (vd 1% → 5% → 25% → 100%, mỗi bước ở tối thiểu
 *   1 giờ); `teamV16CanaryPercentAt` cho biết tại thời điểm t thì
 *   đang ở bước nào; validate plan bắt buộc tăng đơn điệu, bước
 *   cuối phải 100%, dwell không âm.
 * - FEATURE FLAG: cờ tính năng độc lập với rollout version — bật/
 *   tắt toàn cục, giới hạn theo % user (hash bucket ổn định),
 *   targeting theo user/role/tenant, kill switch tắt ngay lập tức
 *   bất chấp targeting. Flag quyết định "user này có thấy tính
 *   năng không" mà không cần deploy lại.
 * - AUTO-ROLLBACK THEO ERROR BUDGET: thay vì một ngưỡng lỗi duy
 *   nhất, v5 dùng error budget theo cửa sổ thời gian — error rate
 *   vượt max + đủ mẫu tối thiểu → rollback; lỗi liên tiếp vượt
 *   ngưỡng → rollback ngay; error rate vượt mức pause (thấp hơn)
 *   → chỉ tạm dừng ramp (không rollback) để quan sát. Quyết định
 *   trả về `none | pause | rollback` kèm lý do để caller ghi
 *   history và thực thi (v5 không tự deploy/rollback thật).
 *
 * Module này KHÔNG deploy code, KHÔNG chạm mạng: nó quyết định
 * "lúc này mở cho bao nhiêu %, user này có cờ không, có nên dừng/
 * rollback không" — việc mở rộng/rollback thật do caller làm theo
 * kết quả trả về (kết hợp `advanceTeamV15Rollout` /
 * `rollbackTeamV15Rollout` của v4).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { teamV14UserBucket } from '../fleetV14/rolloutV14';

/** File lưu rollout v5 + feature flag trong team root. */
export const TEAM_V16_ROLLOUTS_FILE = 'rollouts-v119.json';
/** Phiên bản định dạng state v5. */
export const TEAM_V16_ROLLOUT_STATE_VERSION = 1;
/** Số rollout v5 tối đa. */
export const TEAM_V16_MAX_ROLLOUTS = 100;
/** Số feature flag tối đa. */
export const TEAM_V16_MAX_FEATURE_FLAGS = 200;
/** Số history entry tối đa mỗi rollout v5. */
export const TEAM_V16_MAX_HISTORY_ENTRIES = 200;
/** Dwell tối thiểu mặc định mỗi bước canary: 1 giờ. */
export const TEAM_V16_DEFAULT_CANARY_DWELL_MS = 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Canary ramp
// ---------------------------------------------------------------------------

/** Một bước trong canary plan. */
export interface TeamV16CanaryStep {
  /** % user nhận tính năng ở bước này (0 < percent <= 100). */
  percent: number;
  /** Thời gian ở tối thiểu tại bước này trước khi lên bước sau (ms). */
  dwellMs: number;
}

/** Lỗi validate canary plan, '' = hợp lệ. */
export function validateTeamV16CanaryPlan(plan: readonly TeamV16CanaryStep[]): string {
  if (plan.length === 0) return 'canary plan không được rỗng';
  if (plan.length > 20) return 'canary plan tối đa 20 bước';
  let prev = 0;
  for (const step of plan) {
    if (!Number.isFinite(step.percent) || step.percent <= 0 || step.percent > 100) {
      return `percent mỗi bước phải trong (0, 100], nhận được ${step.percent}`;
    }
    if (step.percent <= prev) return 'percent các bước canary phải tăng đơn điệu';
    if (!Number.isFinite(step.dwellMs) || step.dwellMs < 0) {
      return 'dwellMs không được âm';
    }
    prev = step.percent;
  }
  if (plan[plan.length - 1].percent !== 100) {
    return 'bước cuối của canary plan phải là 100%';
  }
  return '';
}

/** Canary plan mặc định: 1% → 5% → 25% → 50% → 100%, mỗi bước 1 giờ. */
export function defaultTeamV16CanaryPlan(): TeamV16CanaryStep[] {
  return [
    { percent: 1, dwellMs: TEAM_V16_DEFAULT_CANARY_DWELL_MS },
    { percent: 5, dwellMs: TEAM_V16_DEFAULT_CANARY_DWELL_MS },
    { percent: 25, dwellMs: TEAM_V16_DEFAULT_CANARY_DWELL_MS },
    { percent: 50, dwellMs: TEAM_V16_DEFAULT_CANARY_DWELL_MS },
    { percent: 100, dwellMs: 0 },
  ];
}

/**
 * % canary tại thời điểm `now` (ms kể từ `startedAt`). Bước cuối
 * không có dwell nên ở lại đó mãi. Chưa bắt đầu → bước đầu tiên.
 */
export function teamV16CanaryPercentAt(
  plan: readonly TeamV16CanaryStep[],
  startedAt: number,
  now = Date.now(),
): { percent: number; stepIndex: number; nextStepAt: number | null } {
  if (plan.length === 0) return { percent: 0, stepIndex: -1, nextStepAt: null };
  let elapsed = Math.max(0, now - startedAt);
  for (let i = 0; i < plan.length; i++) {
    const step = plan[i];
    if (i === plan.length - 1) return { percent: step.percent, stepIndex: i, nextStepAt: null };
    if (elapsed < step.dwellMs) {
      return { percent: step.percent, stepIndex: i, nextStepAt: startedAt + elapsed + (step.dwellMs - elapsed) };
    }
    elapsed -= step.dwellMs;
  }
  const last = plan[plan.length - 1];
  return { percent: last.percent, stepIndex: plan.length - 1, nextStepAt: null };
}

/** User có nằm trong % canary hiện tại không (bucket ổn định theo rollout id). */
export function teamV16UserInCanary(
  rolloutId: string,
  userId: string,
  percent: number,
): boolean {
  if (percent <= 0) return false;
  if (percent >= 100) return true;
  // Bucket v14 trả về thang 0..9999 (xem teamV14UserBucket): so
  // với percent*100, như cách v14 tự dùng — so trực tiếp với
  // percent sẽ làm canary nhỏ đi 100 lần (50% chỉ còn 0,5%).
  return teamV14UserBucket(rolloutId, userId) < Math.round(percent * 100);
}

// ---------------------------------------------------------------------------
// Feature flag
// ---------------------------------------------------------------------------

/** Targeting của feature flag (rỗng = không giới hạn theo chiều đó). */
export interface TeamV16FlagTargeting {
  /** Chỉ những user này (rỗng = mọi user). */
  userIds: string[];
  /** Chỉ những role này — role cứng hoặc `custom:<id>` (rỗng = mọi role). */
  roles: string[];
  /** Chỉ những tenant này (rỗng = mọi tenant). */
  tenantIds: string[];
}

/** Một feature flag. */
export interface TeamV16FeatureFlag {
  id: string;
  name: string;
  description: string;
  /** Bật/tắt toàn cục (tắt = không ai thấy, bất chấp targeting). */
  enabled: boolean;
  /** Kill switch: true = tắt NGAY LẬP TỨC, ghi đè mọi thứ (kể cả enabled). */
  killed: boolean;
  /** % user nhận cờ (0..100) — áp sau targeting, theo hash bucket. */
  rolloutPercent: number;
  targeting: TeamV16FlagTargeting;
  createdAt: number;
  updatedAt: number;
}

/** Lỗi validate feature flag, '' = hợp lệ. */
export function validateTeamV16FeatureFlag(
  flag: Omit<TeamV16FeatureFlag, 'createdAt' | 'updatedAt'>,
): string {
  if (typeof flag.id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(flag.id)) {
    return 'id flag phải là slug: chữ thường/số/gạch nối, bắt đầu bằng chữ/số';
  }
  if (typeof flag.name !== 'string' || flag.name.trim().length === 0 || flag.name.length > 80) {
    return 'tên flag không được rỗng và tối đa 80 ký tự';
  }
  if (!Number.isFinite(flag.rolloutPercent) || flag.rolloutPercent < 0 || flag.rolloutPercent > 100) {
    return 'rolloutPercent phải trong 0..100';
  }
  for (const list of [flag.targeting.userIds, flag.targeting.roles, flag.targeting.tenantIds]) {
    if (!Array.isArray(list)) return 'targeting phải là mảng';
    if (list.length > 500) return 'mỗi danh sách targeting tối đa 500 mục';
    if (list.some((v) => typeof v !== 'string' || v.length === 0)) {
      return 'targeting không được chứa chuỗi rỗng';
    }
  }
  return '';
}

export function createTeamV16FeatureFlag(
  input: Omit<TeamV16FeatureFlag, 'createdAt' | 'updatedAt'>,
  now = Date.now(),
): { ok: boolean; flag: TeamV16FeatureFlag | null; error: string } {
  const invalid = validateTeamV16FeatureFlag(input);
  if (invalid) return { ok: false, flag: null, error: invalid };
  return {
    ok: true,
    flag: {
      ...input,
      name: input.name.trim(),
      targeting: {
        userIds: [...input.targeting.userIds],
        roles: [...input.targeting.roles],
        tenantIds: [...input.targeting.tenantIds],
      },
      createdAt: now,
      updatedAt: now,
    },
    error: '',
  };
}

export interface TeamV16FlagEvalContext {
  userId: string;
  roleRef: string;
  tenantId: string;
}

/**
 * User có thấy feature flag không? Thứ tự: killed → !enabled →
 * targeting (user/role/tenant) → hash bucket theo rolloutPercent.
 * Fail-closed: flag không hợp lệ → false.
 */
export function isTeamV16FlagEnabledFor(
  flag: TeamV16FeatureFlag,
  ctx: TeamV16FlagEvalContext,
): boolean {
  // Fail-closed đúng như doc: flag không hợp lệ (rolloutPercent
  // ngoài 0..100) → false, thay vì coi >100 như 100%.
  if (!Number.isFinite(flag.rolloutPercent) || flag.rolloutPercent < 0 || flag.rolloutPercent > 100) {
    return false;
  }
  if (flag.killed) return false;
  if (!flag.enabled) return false;
  const t = flag.targeting;
  if (t.userIds.length > 0 && !t.userIds.includes(ctx.userId)) return false;
  if (t.roles.length > 0 && !t.roles.includes(ctx.roleRef)) return false;
  if (t.tenantIds.length > 0 && !t.tenantIds.includes(ctx.tenantId)) return false;
  if (flag.rolloutPercent <= 0) return false;
  if (flag.rolloutPercent >= 100) return true;
  // Như trên: bucket thang 0..9999, so với percent*100.
  return teamV14UserBucket(`flag:${flag.id}`, ctx.userId) < Math.round(flag.rolloutPercent * 100);
}

/** Bật kill switch cho flag (trả về flag mới, không mutate). */
export function killTeamV16FeatureFlag(flag: TeamV16FeatureFlag, now = Date.now()): TeamV16FeatureFlag {
  return { ...flag, killed: true, updatedAt: now };
}

/** Gỡ kill switch (flag trở lại theo `enabled` + targeting). */
export function reviveTeamV16FeatureFlag(flag: TeamV16FeatureFlag, now = Date.now()): TeamV16FeatureFlag {
  return { ...flag, killed: false, updatedAt: now };
}

// ---------------------------------------------------------------------------
// Auto-rollback theo error budget
// ---------------------------------------------------------------------------

/** Ngưỡng error budget của một rollout v5. */
export interface TeamV16ErrorBudget {
  /** Cửa sổ đo (ms) — metrics do caller tổng hợp trong cửa sổ này. */
  windowMs: number;
  /** Error rate vượt mức này → rollback (0..1). */
  maxErrorRate: number;
  /** Error rate vượt mức này → chỉ pause ramp (0..1, <= maxErrorRate). */
  pauseErrorRate: number;
  /** Số mẫu tối thiểu mới được quyết định (tránh nhiễu mẫu nhỏ). */
  minSamples: number;
  /** Số lỗi liên tiếp tối đa cho phép — vượt → rollback ngay. */
  maxConsecutiveFailures: number;
}

export function defaultTeamV16ErrorBudget(): TeamV16ErrorBudget {
  return {
    windowMs: 60 * 60 * 1000,
    maxErrorRate: 0.2,
    pauseErrorRate: 0.1,
    minSamples: 10,
    maxConsecutiveFailures: 5,
  };
}

/** Lỗi validate error budget, '' = hợp lệ. */
export function validateTeamV16ErrorBudget(budget: TeamV16ErrorBudget): string {
  if (!Number.isFinite(budget.windowMs) || budget.windowMs <= 0) return 'windowMs phải > 0';
  if (budget.maxErrorRate < 0 || budget.maxErrorRate > 1) return 'maxErrorRate phải trong 0..1';
  if (budget.pauseErrorRate < 0 || budget.pauseErrorRate > 1) return 'pauseErrorRate phải trong 0..1';
  if (budget.pauseErrorRate > budget.maxErrorRate) return 'pauseErrorRate phải <= maxErrorRate';
  if (!Number.isInteger(budget.minSamples) || budget.minSamples < 1) return 'minSamples phải là số nguyên >= 1';
  if (!Number.isInteger(budget.maxConsecutiveFailures) || budget.maxConsecutiveFailures < 1) {
    return 'maxConsecutiveFailures phải là số nguyên >= 1';
  }
  return '';
}

/** Metrics lỗi trong cửa sổ (do caller đo thật từ log/telemetry). */
export interface TeamV16RolloutMetrics {
  /** Tổng số request/task mẫu trong cửa sổ. */
  samples: number;
  /** Số lỗi trong cửa sổ. */
  errors: number;
  /** Số lỗi liên tiếp gần nhất (chưa bị ngắt bởi một lần thành công). */
  consecutiveFailures: number;
}

export type TeamV16AutoAction = 'none' | 'pause' | 'rollback';

export interface TeamV16AutoRollbackDecision {
  action: TeamV16AutoAction;
  errorRate: number;
  reason: string;
}

/**
 * Quyết định auto-rollback/pause từ metrics + budget. Thứ tự ưu
 * tiên: lỗi liên tiếp → error rate vượt max → error rate vượt
 * mức pause → không làm gì. Chưa đủ mẫu → `none` (không quyết
 * định trên nhiễu).
 */
export function evaluateTeamV16AutoRollback(
  metrics: TeamV16RolloutMetrics,
  budget: TeamV16ErrorBudget,
): TeamV16AutoRollbackDecision {
  if (metrics.samples < budget.minSamples) {
    return {
      action: 'none',
      errorRate: metrics.samples > 0 ? metrics.errors / metrics.samples : 0,
      reason: `chưa đủ mẫu (${metrics.samples}/${budget.minSamples})`,
    };
  }
  const errorRate = metrics.errors / metrics.samples;
  if (metrics.consecutiveFailures >= budget.maxConsecutiveFailures) {
    return {
      action: 'rollback',
      errorRate,
      reason: `lỗi liên tiếp ${metrics.consecutiveFailures} >= ${budget.maxConsecutiveFailures}`,
    };
  }
  if (errorRate > budget.maxErrorRate) {
    return {
      action: 'rollback',
      errorRate,
      reason: `error rate ${(errorRate * 100).toFixed(1)}% > ${(budget.maxErrorRate * 100).toFixed(1)}%`,
    };
  }
  if (errorRate > budget.pauseErrorRate) {
    return {
      action: 'pause',
      errorRate,
      reason: `error rate ${(errorRate * 100).toFixed(1)}% > mức pause ${(budget.pauseErrorRate * 100).toFixed(1)}%`,
    };
  }
  return { action: 'none', errorRate, reason: 'error rate trong ngân sách' };
}

// ---------------------------------------------------------------------------
// Rollout v5 record + store
// ---------------------------------------------------------------------------

/** Trạng thái rollout v5. */
export type TeamV16RolloutStatus =
  | 'draft'
  | 'canary'
  | 'paused'
  | 'rolling-out'
  | 'complete'
  | 'rolled-back';

/** Một history entry của rollout v5. */
export interface TeamV16RolloutHistoryEntry {
  at: number;
  action: string;
  detail: string;
}

/** Một rollout v5: nối với rollout v4 bằng `rolloutV15Id`. */
export interface TeamV16Rollout {
  id: string;
  feature: string;
  version: string;
  /** Id rollout v4 tương ứng ('' = rollout chỉ có ở v5). */
  rolloutV15Id: string;
  status: TeamV16RolloutStatus;
  canaryPlan: TeamV16CanaryStep[];
  /** Epoch ms bắt đầu canary (null = chưa bắt đầu). */
  canaryStartedAt: number | null;
  errorBudget: TeamV16ErrorBudget;
  /** Metrics mới nhất (do caller cập nhật). */
  latestMetrics: TeamV16RolloutMetrics | null;
  /** Quyết định auto gần nhất ('' = chưa có). */
  lastAutoAction: TeamV16AutoAction | '';
  /** Id feature flag gắn với rollout ('' = không gắn). */
  flagId: string;
  history: TeamV16RolloutHistoryEntry[];
  createdAt: number;
  updatedAt: number;
}

/** Lỗi validate rollout v5, '' = hợp lệ. */
export function validateTeamV16Rollout(
  input: Pick<TeamV16Rollout, 'id' | 'feature' | 'version' | 'canaryPlan' | 'errorBudget'>,
): string {
  if (typeof input.id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(input.id)) {
    return 'id rollout phải là slug: chữ thường/số/gạch nối, bắt đầu bằng chữ/số';
  }
  if (typeof input.feature !== 'string' || input.feature.trim().length === 0) {
    return 'feature không được rỗng';
  }
  if (typeof input.version !== 'string' || input.version.trim().length === 0) {
    return 'version không được rỗng';
  }
  const planError = validateTeamV16CanaryPlan(input.canaryPlan);
  if (planError) return planError;
  return validateTeamV16ErrorBudget(input.errorBudget);
}

export function createTeamV16Rollout(
  input: Pick<TeamV16Rollout, 'id' | 'feature' | 'version'> & {
    rolloutV15Id?: string;
    canaryPlan?: TeamV16CanaryStep[];
    errorBudget?: TeamV16ErrorBudget;
    flagId?: string;
  },
  now = Date.now(),
): { ok: boolean; rollout: TeamV16Rollout | null; error: string } {
  const rollout: TeamV16Rollout = {
    id: input.id,
    feature: input.feature,
    version: input.version,
    rolloutV15Id: input.rolloutV15Id ?? '',
    status: 'draft',
    canaryPlan: input.canaryPlan ?? defaultTeamV16CanaryPlan(),
    canaryStartedAt: null,
    errorBudget: input.errorBudget ?? defaultTeamV16ErrorBudget(),
    latestMetrics: null,
    lastAutoAction: '',
    flagId: input.flagId ?? '',
    history: [{ at: now, action: 'created', detail: `feature=${input.feature} version=${input.version}` }],
    createdAt: now,
    updatedAt: now,
  };
  const invalid = validateTeamV16Rollout(rollout);
  if (invalid) return { ok: false, rollout: null, error: invalid };
  return { ok: true, rollout, error: '' };
}

function appendTeamV16History(
  rollout: TeamV16Rollout,
  action: string,
  detail: string,
  now = Date.now(),
): TeamV16Rollout {
  const history = [...rollout.history, { at: now, action, detail }].slice(-TEAM_V16_MAX_HISTORY_ENTRIES);
  return { ...rollout, history, updatedAt: now };
}

/** Bắt đầu canary (draft → canary, đặt mốc thời gian). */
export function startTeamV16Canary(
  rollout: TeamV16Rollout,
  now = Date.now(),
): { ok: boolean; rollout: TeamV16Rollout; error: string } {
  if (rollout.status !== 'draft') {
    return { ok: false, rollout, error: `chỉ bắt đầu canary từ draft, hiện tại: ${rollout.status}` };
  }
  const next = appendTeamV16History(
    { ...rollout, status: 'canary', canaryStartedAt: now },
    'canary.start',
    `plan=${rollout.canaryPlan.map((s) => `${s.percent}%`).join(' → ')}`,
    now,
  );
  return { ok: true, rollout: next, error: '' };
}

/** Tạm dừng ramp canary (giữ nguyên % hiện tại). */
export function pauseTeamV16Rollout(
  rollout: TeamV16Rollout,
  reason: string,
  now = Date.now(),
): { ok: boolean; rollout: TeamV16Rollout; error: string } {
  if (rollout.status !== 'canary' && rollout.status !== 'rolling-out') {
    return { ok: false, rollout, error: `chỉ pause rollout đang canary/rolling-out, hiện tại: ${rollout.status}` };
  }
  const next = appendTeamV16History({ ...rollout, status: 'paused' }, 'paused', reason, now);
  return { ok: true, rollout: next, error: '' };
}

/** Tiếp tục rollout đã pause (về lại canary, giữ nguyên mốc bắt đầu). */
export function resumeTeamV16Rollout(
  rollout: TeamV16Rollout,
  now = Date.now(),
): { ok: boolean; rollout: TeamV16Rollout; error: string } {
  if (rollout.status !== 'paused') {
    return { ok: false, rollout, error: `chỉ resume rollout đang paused, hiện tại: ${rollout.status}` };
  }
  const next = appendTeamV16History({ ...rollout, status: 'canary' }, 'resumed', '', now);
  return { ok: true, rollout: next, error: '' };
}

/**
 * Áp dụng quyết định auto (từ `evaluateTeamV16AutoRollback`) lên
 * rollout: `rollback` → rolled-back, `pause` → paused, `none` →
 * không đổi trạng thái (chỉ ghi metrics + quyết định).
 */
export function applyTeamV16AutoDecision(
  rollout: TeamV16Rollout,
  metrics: TeamV16RolloutMetrics,
  now = Date.now(),
): { rollout: TeamV16Rollout; decision: TeamV16AutoRollbackDecision } {
  const decision = evaluateTeamV16AutoRollback(metrics, rollout.errorBudget);
  let next: TeamV16Rollout = { ...rollout, latestMetrics: { ...metrics }, lastAutoAction: decision.action };
  if (decision.action === 'rollback' && rollout.status !== 'rolled-back' && rollout.status !== 'complete') {
    next = appendTeamV16History({ ...next, status: 'rolled-back' }, 'auto-rollback', decision.reason, now);
  } else if (decision.action === 'pause' && (rollout.status === 'canary' || rollout.status === 'rolling-out')) {
    next = appendTeamV16History({ ...next, status: 'paused' }, 'auto-pause', decision.reason, now);
  } else {
    next = { ...next, updatedAt: now };
  }
  return { rollout: next, decision };
}

/** Đánh dấu rollout hoàn tất (chỉ từ canary/rolling-out). */
export function completeTeamV16Rollout(
  rollout: TeamV16Rollout,
  now = Date.now(),
): { ok: boolean; rollout: TeamV16Rollout; error: string } {
  if (rollout.status !== 'canary' && rollout.status !== 'rolling-out') {
    return { ok: false, rollout, error: `chỉ complete rollout đang canary/rolling-out, hiện tại: ${rollout.status}` };
  }
  const next = appendTeamV16History({ ...rollout, status: 'complete' }, 'completed', '', now);
  return { ok: true, rollout: next, error: '' };
}

/** % canary hiện tại của rollout (0 khi chưa bắt đầu). */
export function teamV16RolloutPercent(
  rollout: TeamV16Rollout,
  now = Date.now(),
): { percent: number; stepIndex: number; nextStepAt: number | null } {
  if (rollout.canaryStartedAt === null) return { percent: 0, stepIndex: -1, nextStepAt: null };
  return teamV16CanaryPercentAt(rollout.canaryPlan, rollout.canaryStartedAt, now);
}

/** Tóm tắt rollout v5 cho panel. */
export interface TeamV16RolloutSummary {
  id: string;
  feature: string;
  version: string;
  status: TeamV16RolloutStatus;
  percent: number;
  stepIndex: number;
  nextStepAt: number | null;
  lastAutoAction: TeamV16AutoAction | '';
  errorRate: number | null;
  flagId: string;
}

export function summarizeTeamV16Rollout(
  rollout: TeamV16Rollout,
  now = Date.now(),
): TeamV16RolloutSummary {
  const { percent, stepIndex, nextStepAt } = teamV16RolloutPercent(rollout, now);
  return {
    id: rollout.id,
    feature: rollout.feature,
    version: rollout.version,
    status: rollout.status,
    percent,
    stepIndex,
    nextStepAt,
    lastAutoAction: rollout.lastAutoAction,
    errorRate:
      rollout.latestMetrics && rollout.latestMetrics.samples > 0
        ? rollout.latestMetrics.errors / rollout.latestMetrics.samples
        : null,
    flagId: rollout.flagId,
  };
}

// ---------------------------------------------------------------------------
// Store: rollout v5 + feature flag
// ---------------------------------------------------------------------------

export interface TeamV16RolloutStore {
  version: number;
  rollouts: TeamV16Rollout[];
  flags: TeamV16FeatureFlag[];
  createdAt: number;
  updatedAt: number;
}

export function createTeamV16RolloutStore(now = Date.now()): TeamV16RolloutStore {
  return { version: TEAM_V16_ROLLOUT_STATE_VERSION, rollouts: [], flags: [], createdAt: now, updatedAt: now };
}

/** Thêm rollout vào store (trùng id → lỗi, store không đổi). */
export function upsertTeamV16Rollout(
  store: TeamV16RolloutStore,
  rollout: TeamV16Rollout,
  now = Date.now(),
): { ok: boolean; store: TeamV16RolloutStore; error: string } {
  const invalid = validateTeamV16Rollout(rollout);
  if (invalid) return { ok: false, store, error: invalid };
  if (store.rollouts.some((r) => r.id === rollout.id)) {
    return { ok: false, store, error: `rollout đã tồn tại: ${rollout.id}` };
  }
  if (store.rollouts.length >= TEAM_V16_MAX_ROLLOUTS) {
    return { ok: false, store, error: `đã đạt tối đa ${TEAM_V16_MAX_ROLLOUTS} rollout` };
  }
  return { ok: true, store: { ...store, rollouts: [...store.rollouts, rollout], updatedAt: now }, error: '' };
}

/** Thêm/cập nhật feature flag trong store (theo id). */
export function upsertTeamV16FeatureFlag(
  store: TeamV16RolloutStore,
  flag: TeamV16FeatureFlag,
  now = Date.now(),
): { ok: boolean; store: TeamV16RolloutStore; error: string } {
  const invalid = validateTeamV16FeatureFlag(flag);
  if (invalid) return { ok: false, store, error: invalid };
  const exists = store.flags.some((f) => f.id === flag.id);
  if (!exists && store.flags.length >= TEAM_V16_MAX_FEATURE_FLAGS) {
    return { ok: false, store, error: `đã đạt tối đa ${TEAM_V16_MAX_FEATURE_FLAGS} flag` };
  }
  const flags = exists
    ? store.flags.map((f) => (f.id === flag.id ? { ...flag, updatedAt: now } : f))
    : [...store.flags, { ...flag, updatedAt: now }];
  return { ok: true, store: { ...store, flags, updatedAt: now }, error: '' };
}

export function saveTeamV16Rollouts(teamRoot: string, store: TeamV16RolloutStore): void {
  fs.mkdirSync(teamRoot, { recursive: true });
  fs.writeFileSync(path.join(teamRoot, TEAM_V16_ROLLOUTS_FILE), `${JSON.stringify(store, null, 2)}\n`, 'utf8');
}

export function loadTeamV16Rollouts(teamRoot: string): TeamV16RolloutStore | null {
  try {
    const raw = fs.readFileSync(path.join(teamRoot, TEAM_V16_ROLLOUTS_FILE), 'utf8');
    const parsed = JSON.parse(raw) as TeamV16RolloutStore;
    if (parsed.version !== TEAM_V16_ROLLOUT_STATE_VERSION || !Array.isArray(parsed.rollouts)) return null;
    return parsed;
  } catch {
    return null;
  }
}

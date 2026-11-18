/**
 * Rollout v3 — rollout theo giai đoạn (canary → % dần → full), rollback
 * tự động khi lỗi vượt ngưỡng, rollout theo nhóm user (v1.17, Đội T6).
 *
 * Tầng trên của rollout v2 (`fleetV13/rolloutV13.ts` — stage cố định
 * theo % user, cohort hash deterministic, health gate trước mỗi lần
 * mở rộng, auto-decision pause/rollback, history). V2 trả lời "user
 * nào nhận tính năng mới, khi nào dừng lại giữa các stage"; v3 thêm
 * 3 thứ còn thiếu để rollout chạy thật trong app nhiều user:
 *
 * - Stage LINH HOẠT + dwell time: mỗi rollout mang plan stage riêng
 *   (tên + % + thời gian ở tối thiểu trong stage). `advance` bị chặn
 *   khi chưa đủ dwell — tránh operator bấm mở rộng liên tục trong
 *   5 phút rồi đổ lỗi cho gate. Stage sau luôn bao trọn stage trước
 *   (mở rộng đơn điệu, cohort hash như v2).
 * - Rollout theo NHÓM user: nhóm định nghĩa bằng role, danh sách
 *   user tường minh, hoặc dải hash-bucket (vd nhóm "internal" =
 *   bucket 0–499). Một rollout có thể bật cho 1..n nhóm trước rồi
 *   mới mở theo % toàn bộ user — nhóm là lớp lọc TRƯỚC cohort %:
 *   user phải thuộc nhóm được bật VÀ nằm trong cohort % của stage.
 * - Rollback TỰ ĐỘNG thật sự: `evaluateTeamV14AutoAction` không chỉ
 *   đề xuất mà `applyTeamV14AutoRollback` áp dụng luôn khi operator
 *   đã bật `autoRollbackEnabled`: lỗi vượt ngưỡng rollback → trạng
 *   thái `rolled-back`, ghi rõ version khôi phục (`previousVersion`)
 *   + metric gây rollback + thời điểm; lỗi vượt ngưỡng pause → trạng
 *   thái `paused` (resume được). Rollback thủ công vẫn có
 *   (`rollbackTeamV14Rollout`) và cũng ghi history.
 *
 * Module này KHÔNG chạm mạng, KHÔNG tự bật flag thật lên user: nó
 * quyết định "stage nào, nhóm nào, dừng hay lùi" — việc bật flag
 * thật do caller (feature-flag service) làm theo cohort trả về.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

/** File lưu rollout v3 trong team root. */
export const TEAM_V14_ROLLOUTS_FILE = 'rollouts-v117.json';
/** Tỉ lệ lỗi tối đa cho phép trước khi gate chặn mở rộng stage. */
export const TEAM_V14_DEFAULT_MAX_ERROR_RATE = 0.05;
/** Tỉ lệ lỗi vượt ngưỡng này thì tự động rollback. */
export const TEAM_V14_DEFAULT_ROLLBACK_ERROR_RATE = 0.2;
/** Tỉ lệ lỗi vượt ngưỡng này (dưới ngưỡng rollback) thì tự động pause. */
export const TEAM_V14_DEFAULT_PAUSE_ERROR_RATE = 0.1;
/** Số user báo lỗi tối đa cho phép trước khi gate chặn. */
export const TEAM_V14_DEFAULT_MAX_REPORTING_USERS = 5;
/** Số user báo lỗi vượt ngưỡng này thì tự động rollback. */
export const TEAM_V14_DEFAULT_ROLLBACK_REPORTING_USERS = 20;
/** Cỡ mẫu tối thiểu (số user đã dùng tính năng) để gate có ý nghĩa. */
export const TEAM_V14_DEFAULT_MIN_SAMPLE_USERS = 10;
/** Thời gian ở tối thiểu trong một stage trước khi được mở rộng (mặc định 1 giờ). */
export const TEAM_V14_DEFAULT_MIN_DWELL_MS = 60 * 60 * 1000;
/** Số rollout tối đa lưu trong file. */
export const TEAM_V14_MAX_ROLLOUTS = 100;
/** Số history entry tối đa giữ mỗi rollout. */
export const TEAM_V14_MAX_HISTORY_ENTRIES = 200;
/** Số nhóm tối đa mỗi rollout. */
export const TEAM_V14_MAX_GROUPS_PER_ROLLOUT = 20;

/** Các stage triển khai (thứ tự tăng dần %). */
export type TeamV14RolloutStage =
  | 'draft'
  | 'canary'
  | 'pilot'
  | 'early'
  | 'general'
  | 'all'
  | 'paused'
  | 'complete'
  | 'rolled-back';

export const TEAM_V14_ROLLOUT_STAGES: readonly TeamV14RolloutStage[] = [
  'draft',
  'canary',
  'pilot',
  'early',
  'general',
  'all',
  'paused',
  'complete',
  'rolled-back',
];

/** Stage triển khai theo thứ tự (dùng để tính stage kế tiếp). */
export const TEAM_V14_DEPLOY_STAGES: readonly TeamV14RolloutStage[] = [
  'canary',
  'pilot',
  'early',
  'general',
  'all',
];

/** % user mặc định của từng stage triển khai. */
export const TEAM_V14_STAGE_PERCENTAGES: Readonly<Record<string, number>> = {
  canary: 1,
  pilot: 5,
  early: 25,
  general: 50,
  all: 100,
};

/** Một stage trong plan của rollout (có thể tùy chỉnh %). */
export interface TeamV14StagePlan {
  stage: TeamV14RolloutStage;
  /** % user của stage này (0..100, tăng đơn điệu theo plan). */
  percent: number;
  /** Thời gian ở tối thiểu trong stage trước khi được mở rộng (ms). */
  minDwellMs: number;
}

/** Plan stage mặc định (canary → all). */
export function defaultTeamV14StagePlan(): TeamV14StagePlan[] {
  return TEAM_V14_DEPLOY_STAGES.map((stage) => ({
    stage,
    percent: TEAM_V14_STAGE_PERCENTAGES[stage] ?? 100,
    minDwellMs: TEAM_V14_DEFAULT_MIN_DWELL_MS,
  }));
}

/** Nhãn hiển thị cho từng stage. */
export function teamV14StageLabel(stage: TeamV14RolloutStage): string {
  switch (stage) {
    case 'draft':
      return 'draft';
    case 'canary':
      return 'canary (1% users)';
    case 'pilot':
      return 'pilot (5% users)';
    case 'early':
      return 'early (25% users)';
    case 'general':
      return 'general (50% users)';
    case 'all':
      return 'all (100% users)';
    case 'paused':
      return 'paused';
    case 'complete':
      return 'complete';
    case 'rolled-back':
      return 'rolled back';
    default:
      return String(stage);
  }
}

/** % user của một stage theo plan (stage không triển khai → 0). */
export function teamV14StagePercent(plan: readonly TeamV14StagePlan[], stage: TeamV14RolloutStage): number {
  const found = plan.find((p) => p.stage === stage);
  return found ? found.percent : 0;
}

/** Stage triển khai kế tiếp sau stage hiện tại ('' = không còn). */
export function teamV14NextStage(plan: readonly TeamV14StagePlan[], stage: TeamV14RolloutStage): TeamV14RolloutStage | '' {
  const idx = plan.findIndex((p) => p.stage === stage);
  if (idx < 0 || idx + 1 >= plan.length) return '';
  return plan[idx + 1].stage;
}

// ---------------------------------------------------------------------------
// Nhóm user cho rollout
// ---------------------------------------------------------------------------

/** Cách một nhóm chọn user: theo role / danh sách tường minh / dải hash-bucket. */
export type TeamV14GroupKind = 'role' | 'explicit' | 'hash-bucket';

export const TEAM_V14_GROUP_KINDS: readonly TeamV14GroupKind[] = ['role', 'explicit', 'hash-bucket'];

/** Một nhóm user để rollout theo nhóm. */
export interface TeamV14RolloutGroup {
  id: string;
  name: string;
  kind: TeamV14GroupKind;
  /** kind=role: role được chọn (vd `admin`). */
  role: string;
  /** kind=explicit: danh sách user id. */
  userIds: string[];
  /** kind=hash-bucket: dải bucket [min, max) trên thang 0..10000. */
  bucketMin: number;
  bucketMax: number;
}

/** Bucket hash xác định 0..9999 của (rolloutId, userId) — như v2. */
export function teamV14UserBucket(rolloutId: string, userId: string): number {
  const hash = crypto.createHash('sha256').update(`${rolloutId}:${userId}`).digest();
  return hash.readUInt32BE(0) % 10000;
}

/** True khi user thuộc nhóm (cần role của user cho kind=role). */
export function teamV14UserInGroup(
  group: TeamV14RolloutGroup,
  userId: string,
  userRole: string,
  rolloutId: string,
): boolean {
  switch (group.kind) {
    case 'role':
      return userRole === group.role;
    case 'explicit':
      return group.userIds.includes(userId);
    case 'hash-bucket': {
      const bucket = teamV14UserBucket(rolloutId, userId);
      return bucket >= group.bucketMin && bucket < group.bucketMax;
    }
    default:
      return false;
  }
}

/** Validate một nhóm (trả lý do, '' = hợp lệ). */
export function validateTeamV14Group(group: TeamV14RolloutGroup): string {
  if (!group.id || !group.id.trim()) return 'group id is required';
  if (!group.name || !group.name.trim()) return 'group name is required';
  if (!TEAM_V14_GROUP_KINDS.includes(group.kind)) return `unknown group kind: ${String(group.kind)}`;
  if (group.kind === 'role' && !group.role.trim()) return 'role group needs a role';
  if (group.kind === 'explicit' && group.userIds.length === 0) return 'explicit group needs at least one user';
  if (group.kind === 'hash-bucket') {
    if (!Number.isInteger(group.bucketMin) || !Number.isInteger(group.bucketMax)) {
      return 'hash-bucket group needs integer bucket bounds';
    }
    if (group.bucketMin < 0 || group.bucketMax > 10000 || group.bucketMin >= group.bucketMax) {
      return 'hash-bucket range must satisfy 0 <= min < max <= 10000';
    }
  }
  return '';
}

// ---------------------------------------------------------------------------
// Rollout: state + metrics + history
// ---------------------------------------------------------------------------

/** Metric sức khỏe của cohort hiện tại (do caller đo thật). */
export interface TeamV14RolloutMetrics {
  /** Số user đã dùng tính năng trong stage hiện tại. */
  sampleUsers: number;
  /** Số lần gọi lỗi / tổng lần gọi (0..1). */
  errorRate: number;
  /** Tổng số lỗi ghi nhận. */
  errorCount: number;
  /** Số user khác nhau đã báo lỗi. */
  reportingUsers: number;
  /** Số alert critical đang mở liên quan tính năng. */
  criticalAlerts: number;
  /** Số crash ghi nhận trong cohort. */
  crashes: number;
}

/** Ngưỡng tự động pause/rollback (có thể tùy chỉnh mỗi rollout). */
export interface TeamV14RolloutThresholds {
  maxErrorRate: number;
  pauseErrorRate: number;
  rollbackErrorRate: number;
  maxReportingUsers: number;
  rollbackReportingUsers: number;
  minSampleUsers: number;
  /** Số crash tối đa trước khi tự động rollback. */
  maxCrashes: number;
}

export function defaultTeamV14Thresholds(): TeamV14RolloutThresholds {
  return {
    maxErrorRate: TEAM_V14_DEFAULT_MAX_ERROR_RATE,
    pauseErrorRate: TEAM_V14_DEFAULT_PAUSE_ERROR_RATE,
    rollbackErrorRate: TEAM_V14_DEFAULT_ROLLBACK_ERROR_RATE,
    maxReportingUsers: TEAM_V14_DEFAULT_MAX_REPORTING_USERS,
    rollbackReportingUsers: TEAM_V14_DEFAULT_ROLLBACK_REPORTING_USERS,
    minSampleUsers: TEAM_V14_DEFAULT_MIN_SAMPLE_USERS,
    maxCrashes: 5,
  };
}

/** Một entry history: ai, khi nào, từ stage nào sang stage nào, vì sao. */
export interface TeamV14RolloutHistoryEntry {
  at: number;
  actorUserId: string;
  fromStage: TeamV14RolloutStage;
  toStage: TeamV14RolloutStage;
  reason: string;
  /** Metric tại thời điểm chuyển (null = chuyển không kèm metric). */
  metrics: TeamV14RolloutMetrics | null;
}

/** Một rollout v3. */
export interface TeamV14Rollout {
  id: string;
  feature: string;
  version: string;
  /** Version đang chạy trước rollout (khôi phục khi rollback). */
  previousVersion: string;
  description: string;
  stage: TeamV14RolloutStage;
  /** Stage triển khai trước khi pause (để resume về đúng stage). */
  stageBeforePause: TeamV14RolloutStage | '';
  plan: TeamV14StagePlan[];
  /** Nhóm user đã bật (rỗng = mở cho mọi user theo % stage). */
  groups: TeamV14RolloutGroup[];
  /** Id nhóm đang bật (rỗng = tất cả nhóm trong `groups`). */
  enabledGroupIds: string[];
  thresholds: TeamV14RolloutThresholds;
  autoRollbackEnabled: boolean;
  metrics: TeamV14RolloutMetrics;
  /** Epoch ms vào stage hiện tại (dùng kiểm dwell). */
  stageEnteredAt: number;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
  history: TeamV14RolloutHistoryEntry[];
}

/** Tạo rollout mới ở stage draft. */
export function createTeamV14Rollout(
  input: {
    id: string;
    feature: string;
    version: string;
    previousVersion: string;
    description?: string;
    plan?: TeamV14StagePlan[];
    groups?: TeamV14RolloutGroup[];
    thresholds?: Partial<TeamV14RolloutThresholds>;
    autoRollbackEnabled?: boolean;
  },
  createdBy: string,
  now = Date.now(),
): TeamV14Rollout {
  return {
    id: input.id.trim(),
    feature: input.feature.trim(),
    version: input.version.trim(),
    previousVersion: input.previousVersion.trim(),
    description: (input.description ?? '').trim(),
    stage: 'draft',
    stageBeforePause: '',
    plan: input.plan ?? defaultTeamV14StagePlan(),
    groups: input.groups ?? [],
    enabledGroupIds: [],
    thresholds: { ...defaultTeamV14Thresholds(), ...(input.thresholds ?? {}) },
    autoRollbackEnabled: input.autoRollbackEnabled ?? true,
    metrics: { sampleUsers: 0, errorRate: 0, errorCount: 0, reportingUsers: 0, criticalAlerts: 0, crashes: 0 },
    stageEnteredAt: now,
    createdBy,
    createdAt: now,
    updatedAt: now,
    history: [{ at: now, actorUserId: createdBy, fromStage: 'draft', toStage: 'draft', reason: 'created', metrics: null }],
  };
}

/** Validate plan stage: % tăng đơn điệu, 0 < % <= 100, dwell >= 0. */
export function validateTeamV14StagePlan(plan: readonly TeamV14StagePlan[]): string {
  if (plan.length === 0) return 'plan needs at least one stage';
  let prev = 0;
  for (const p of plan) {
    if (!TEAM_V14_DEPLOY_STAGES.includes(p.stage)) return `not a deploy stage: ${String(p.stage)}`;
    if (!Number.isFinite(p.percent) || p.percent <= 0 || p.percent > 100) return `bad percent for ${p.stage}: ${String(p.percent)}`;
    if (p.percent <= prev) return `plan percents must strictly increase (stage ${p.stage})`;
    if (!Number.isFinite(p.minDwellMs) || p.minDwellMs < 0) return `bad minDwellMs for ${p.stage}`;
    prev = p.percent;
  }
  return '';
}

/** Nhóm đang bật của rollout (rỗng enabledGroupIds = tất cả nhóm). */
export function teamV14EnabledGroups(rollout: TeamV14Rollout): TeamV14RolloutGroup[] {
  if (rollout.enabledGroupIds.length === 0) return rollout.groups;
  return rollout.groups.filter((g) => rollout.enabledGroupIds.includes(g.id));
}

/**
 * User có nhận tính năng này không? Nhóm là lớp lọc TRƯỚC: nếu
 * rollout có nhóm thì user phải thuộc ít nhất một nhóm đang bật;
 * sau đó user phải nằm trong cohort % của stage hiện tại.
 */
export function teamV14UserReceivesFeature(
  rollout: TeamV14Rollout,
  userId: string,
  userRole: string,
): boolean {
  if (rollout.stage === 'draft' || rollout.stage === 'paused' || rollout.stage === 'rolled-back') return false;
  if (rollout.stage === 'complete') return true;
  const groups = teamV14EnabledGroups(rollout);
  if (groups.length > 0 && !groups.some((g) => teamV14UserInGroup(g, userId, userRole, rollout.id))) {
    return false;
  }
  const percent = teamV14StagePercent(rollout.plan, rollout.stage);
  if (percent >= 100) return true;
  if (percent <= 0) return false;
  const bucket = teamV14UserBucket(rollout.id, userId);
  return bucket < Math.round(percent * 100);
}

/** Số user trong cohort của stage (từ danh sách ứng viên, kèm role map). */
export function teamV14CohortUsers(
  rollout: TeamV14Rollout,
  users: readonly { id: string; role: string }[],
): string[] {
  return users.filter((u) => teamV14UserReceivesFeature(rollout, u.id, u.role)).map((u) => u.id);
}

// ---------------------------------------------------------------------------
// Health gate + auto-decision + chuyển trạng thái
// ---------------------------------------------------------------------------

/** Kết quả từng điều kiện của health gate (để UI vẽ rõ lý do chặn). */
export interface TeamV14GateCheck {
  name: string;
  pass: boolean;
  reason: string;
}

export interface TeamV14GateResult {
  pass: boolean;
  checks: TeamV14GateCheck[];
}

/** Health gate TRƯỚC khi mở rộng stage: lỗi, số user báo lỗi, alert, cỡ mẫu. */
export function evaluateTeamV14HealthGate(
  rollout: TeamV14Rollout,
  metrics: TeamV14RolloutMetrics = rollout.metrics,
): TeamV14GateResult {
  const t = rollout.thresholds;
  const checks: TeamV14GateCheck[] = [
    {
      name: 'sample-size',
      pass: metrics.sampleUsers >= t.minSampleUsers,
      reason:
        metrics.sampleUsers >= t.minSampleUsers
          ? `sample ${metrics.sampleUsers} users >= ${t.minSampleUsers}`
          : `sample too small: ${metrics.sampleUsers} < ${t.minSampleUsers} users (gate inconclusive)`,
    },
    {
      name: 'error-rate',
      pass: metrics.errorRate <= t.maxErrorRate,
      reason:
        metrics.errorRate <= t.maxErrorRate
          ? `error rate ${(metrics.errorRate * 100).toFixed(1)}% <= ${(t.maxErrorRate * 100).toFixed(1)}%`
          : `error rate ${(metrics.errorRate * 100).toFixed(1)}% > ${(t.maxErrorRate * 100).toFixed(1)}%`,
    },
    {
      name: 'reporting-users',
      pass: metrics.reportingUsers <= t.maxReportingUsers,
      reason:
        metrics.reportingUsers <= t.maxReportingUsers
          ? `${metrics.reportingUsers} reporting users <= ${t.maxReportingUsers}`
          : `${metrics.reportingUsers} reporting users > ${t.maxReportingUsers}`,
    },
    {
      name: 'critical-alerts',
      pass: metrics.criticalAlerts === 0,
      reason: metrics.criticalAlerts === 0 ? 'no critical alerts' : `${metrics.criticalAlerts} critical alerts open`,
    },
    {
      name: 'crashes',
      pass: metrics.crashes <= t.maxCrashes,
      reason:
        metrics.crashes <= t.maxCrashes
          ? `${metrics.crashes} crashes <= ${t.maxCrashes}`
          : `${metrics.crashes} crashes > ${t.maxCrashes}`,
    },
  ];
  return { pass: checks.every((c) => c.pass), checks };
}

/** Hành động tự động mà metric hiện tại gợi ý. */
export type TeamV14AutoAction = 'none' | 'pause' | 'rollback';

export interface TeamV14AutoDecision {
  action: TeamV14AutoAction;
  reasons: string[];
}

/**
 * Quyết định tự động từ metric (hàm thuần, CHỈ đề xuất — việc áp
 * dụng do `applyTeamV14AutoRollback` / caller gọi chuyển trạng thái).
 * Rollback thắng pause khi cả hai ngưỡng đều vượt.
 */
export function decideTeamV14AutoAction(
  rollout: TeamV14Rollout,
  metrics: TeamV14RolloutMetrics = rollout.metrics,
): TeamV14AutoDecision {
  const t = rollout.thresholds;
  const reasons: string[] = [];
  let action: TeamV14AutoAction = 'none';
  if (metrics.errorRate >= t.rollbackErrorRate) {
    reasons.push(`error rate ${(metrics.errorRate * 100).toFixed(1)}% >= rollback threshold ${(t.rollbackErrorRate * 100).toFixed(1)}%`);
    action = 'rollback';
  }
  if (metrics.reportingUsers >= t.rollbackReportingUsers) {
    reasons.push(`${metrics.reportingUsers} reporting users >= rollback threshold ${t.rollbackReportingUsers}`);
    action = 'rollback';
  }
  if (metrics.crashes > t.maxCrashes) {
    reasons.push(`${metrics.crashes} crashes > max ${t.maxCrashes}`);
    action = 'rollback';
  }
  if (action === 'rollback') return { action, reasons };
  if (metrics.errorRate >= t.pauseErrorRate) {
    reasons.push(`error rate ${(metrics.errorRate * 100).toFixed(1)}% >= pause threshold ${(t.pauseErrorRate * 100).toFixed(1)}%`);
    action = 'pause';
  }
  if (metrics.reportingUsers > t.maxReportingUsers) {
    reasons.push(`${metrics.reportingUsers} reporting users > ${t.maxReportingUsers}`);
    action = 'pause';
  }
  if (metrics.criticalAlerts > 0) {
    reasons.push(`${metrics.criticalAlerts} critical alerts open`);
    action = 'pause';
  }
  return { action, reasons };
}

function withHistory(
  rollout: TeamV14Rollout,
  toStage: TeamV14RolloutStage,
  actorUserId: string,
  reason: string,
  metrics: TeamV14RolloutMetrics | null,
  now: number,
): TeamV14Rollout {
  const entry: TeamV14RolloutHistoryEntry = {
    at: now,
    actorUserId,
    fromStage: rollout.stage,
    toStage,
    reason,
    metrics,
  };
  const history = [...rollout.history, entry];
  const trimmed = history.length > TEAM_V14_MAX_HISTORY_ENTRIES
    ? history.slice(history.length - TEAM_V14_MAX_HISTORY_ENTRIES)
    : history;
  return { ...rollout, stage: toStage, stageEnteredAt: now, updatedAt: now, history: trimmed };
}

export interface TeamV14TransitionResult {
  ok: boolean;
  rollout: TeamV14Rollout;
  reason: string;
}

/** Các chuyển đổi trạng thái hợp lệ (ngoài advance/pause/resume/rollback). */
const TEAM_V14_ALLOWED_TRANSITIONS: Readonly<Record<string, readonly TeamV14RolloutStage[]>> = {
  draft: ['canary'],
  canary: ['pilot', 'paused', 'rolled-back', 'complete'],
  pilot: ['early', 'paused', 'rolled-back', 'complete'],
  early: ['general', 'paused', 'rolled-back', 'complete'],
  general: ['all', 'paused', 'rolled-back', 'complete'],
  all: ['paused', 'rolled-back', 'complete'],
  paused: ['rolled-back', 'complete'],
  complete: [],
  'rolled-back': [],
};

/**
 * Mở rộng sang stage kế tiếp: chặn khi chưa đủ dwell, khi gate fail,
 * hoặc khi chuyển đổi không hợp lệ. Trả reason rõ ràng cho UI.
 */
export function advanceTeamV14Rollout(
  rollout: TeamV14Rollout,
  actorUserId: string,
  now = Date.now(),
): TeamV14TransitionResult {
  const next = teamV14NextStage(rollout.plan, rollout.stage);
  if (next === '') {
    // Đang ở stage cuối của plan → complete thay vì advance.
    if (rollout.stage === 'all') {
      return {
        ok: true,
        rollout: withHistory(rollout, 'complete', actorUserId, 'final stage reached', null, now),
        reason: '',
      };
    }
    return { ok: false, rollout, reason: `cannot advance from stage ${rollout.stage}` };
  }
  const planEntry = rollout.plan.find((p) => p.stage === rollout.stage);
  const dwellMs = planEntry ? planEntry.minDwellMs : 0;
  if (now - rollout.stageEnteredAt < dwellMs) {
    const remainMin = Math.ceil((dwellMs - (now - rollout.stageEnteredAt)) / 60000);
    return { ok: false, rollout, reason: `stage dwell not met: stay in ${rollout.stage} for ${remainMin} more minute(s)` };
  }
  const gate = evaluateTeamV14HealthGate(rollout);
  if (!gate.pass) {
    const failed = gate.checks.filter((c) => !c.pass).map((c) => c.reason).join('; ');
    return { ok: false, rollout, reason: `health gate failed: ${failed}` };
  }
  return {
    ok: true,
    rollout: withHistory(rollout, next, actorUserId, `advanced to ${teamV14StageLabel(next)}`, { ...rollout.metrics }, now),
    reason: '',
  };
}

/** Tạm dừng rollout (ghi nhớ stage trước để resume). */
export function pauseTeamV14Rollout(
  rollout: TeamV14Rollout,
  actorUserId: string,
  reason: string,
  now = Date.now(),
): TeamV14TransitionResult {
  if (rollout.stage === 'paused') return { ok: false, rollout, reason: 'rollout already paused' };
  if (rollout.stage === 'draft' || rollout.stage === 'complete' || rollout.stage === 'rolled-back') {
    return { ok: false, rollout, reason: `cannot pause from stage ${rollout.stage}` };
  }
  const paused = withHistory(rollout, 'paused', actorUserId, reason || 'paused', { ...rollout.metrics }, now);
  return { ok: true, rollout: { ...paused, stageBeforePause: rollout.stage }, reason: '' };
}

/** Resume rollout đã pause về đúng stage trước khi pause. */
export function resumeTeamV14Rollout(
  rollout: TeamV14Rollout,
  actorUserId: string,
  now = Date.now(),
): TeamV14TransitionResult {
  if (rollout.stage !== 'paused') return { ok: false, rollout, reason: `cannot resume from stage ${rollout.stage}` };
  const target = rollout.stageBeforePause && rollout.stageBeforePause !== 'paused' ? rollout.stageBeforePause : 'canary';
  return {
    ok: true,
    rollout: { ...withHistory(rollout, target, actorUserId, `resumed to ${target}`, null, now), stageBeforePause: '' },
    reason: '',
  };
}

/** Rollback thủ công: về `rolled-back`, ghi version khôi phục vào history. */
export function rollbackTeamV14Rollout(
  rollout: TeamV14Rollout,
  actorUserId: string,
  reason: string,
  now = Date.now(),
): TeamV14TransitionResult {
  if (rollout.stage === 'rolled-back') return { ok: false, rollout, reason: 'rollout already rolled back' };
  if (rollout.stage === 'draft') return { ok: false, rollout, reason: 'cannot roll back a draft (nothing deployed)' };
  const detail = `rolled back to ${rollout.previousVersion || 'previous version'}${reason ? `: ${reason}` : ''}`;
  return {
    ok: true,
    rollout: withHistory(rollout, 'rolled-back', actorUserId, detail, { ...rollout.metrics }, now),
    reason: '',
  };
}

/**
 * Áp dụng quyết định tự động: khi `autoRollbackEnabled` và metric
 * vượt ngưỡng rollback → rollback thật; vượt ngưỡng pause → pause
 * thật. Trả action đã áp dụng (để caller ghi audit / thông báo).
 */
export function applyTeamV14AutoRollback(
  rollout: TeamV14Rollout,
  metrics: TeamV14RolloutMetrics,
  actorUserId = 'system:auto-rollback',
  now = Date.now(),
): { rollout: TeamV14Rollout; appliedAction: TeamV14AutoAction; decision: TeamV14AutoDecision } {
  const decision = decideTeamV14AutoAction(rollout, metrics);
  const withMetrics: TeamV14Rollout = { ...rollout, metrics, updatedAt: now };
  if (!rollout.autoRollbackEnabled) return { rollout: withMetrics, appliedAction: 'none', decision };
  if (decision.action === 'rollback') {
    const res = rollbackTeamV14Rollout(withMetrics, actorUserId, `auto-rollback: ${decision.reasons.join('; ')}`, now);
    return { rollout: res.rollout, appliedAction: res.ok ? 'rollback' : 'none', decision };
  }
  if (decision.action === 'pause') {
    const res = pauseTeamV14Rollout(withMetrics, actorUserId, `auto-pause: ${decision.reasons.join('; ')}`, now);
    return { rollout: res.rollout, appliedAction: res.ok ? 'pause' : 'none', decision };
  }
  return { rollout: withMetrics, appliedAction: 'none', decision };
}

/** Cập nhật metric của rollout (hàm thuần, trả rollout mới). */
export function updateTeamV14RolloutMetrics(
  rollout: TeamV14Rollout,
  metrics: Partial<TeamV14RolloutMetrics>,
  now = Date.now(),
): TeamV14Rollout {
  return { ...rollout, metrics: { ...rollout.metrics, ...metrics }, updatedAt: now };
}

/** Bật / tắt nhóm cho rollout (validate group id tồn tại). */
export function setTeamV14RolloutGroups(
  rollout: TeamV14Rollout,
  enabledGroupIds: string[],
  now = Date.now(),
): TeamV14TransitionResult {
  const unknown = enabledGroupIds.filter((id) => !rollout.groups.some((g) => g.id === id));
  if (unknown.length > 0) {
    return { ok: false, rollout, reason: `unknown group(s): ${unknown.join(', ')}` };
  }
  if (enabledGroupIds.length > TEAM_V14_MAX_GROUPS_PER_ROLLOUT) {
    return { ok: false, rollout, reason: 'too many enabled groups' };
  }
  return {
    ok: true,
    rollout: { ...rollout, enabledGroupIds: [...enabledGroupIds], updatedAt: now },
    reason: '',
  };
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

function atomicWriteFile(filePath: string, content: string): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, content, { mode: 0o600 });
  fs.renameSync(tmp, filePath);
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // Windows không có chmod unix — bỏ qua.
  }
}

/** Toàn bộ state rollout v3 (lưu file). */
export interface TeamV14RolloutStore {
  version: 1;
  rollouts: TeamV14Rollout[];
  updatedAt: number;
}

export function createTeamV14RolloutStore(now = Date.now()): TeamV14RolloutStore {
  return { version: 1, rollouts: [], updatedAt: now };
}

export function saveTeamV14Rollouts(teamRoot: string, store: TeamV14RolloutStore): void {
  atomicWriteFile(path.join(teamRoot, TEAM_V14_ROLLOUTS_FILE), JSON.stringify(store, null, 2));
}

export function loadTeamV14Rollouts(teamRoot: string): TeamV14RolloutStore | null {
  const file = path.join(teamRoot, TEAM_V14_ROLLOUTS_FILE);
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as TeamV14RolloutStore;
    if (parsed.version !== 1 || !Array.isArray(parsed.rollouts)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Thêm / thay thế một rollout trong store (trả store mới). */
export function upsertTeamV14Rollout(store: TeamV14RolloutStore, rollout: TeamV14Rollout, now = Date.now()): TeamV14RolloutStore {
  const rollouts = store.rollouts.filter((r) => r.id !== rollout.id);
  rollouts.push(rollout);
  const trimmed = rollouts.length > TEAM_V14_MAX_ROLLOUTS ? rollouts.slice(rollouts.length - TEAM_V14_MAX_ROLLOUTS) : rollouts;
  return { ...store, rollouts: trimmed, updatedAt: now };
}

/** Tóm tắt một rollout cho panel: stage, %, cohort, gate, auto-decision. */
export interface TeamV14RolloutSummary {
  id: string;
  feature: string;
  version: string;
  stage: TeamV14RolloutStage;
  stageLabel: string;
  percent: number;
  enabledGroups: string[];
  gate: TeamV14GateResult;
  autoDecision: TeamV14AutoDecision;
  historyCount: number;
}

export function summarizeTeamV14Rollout(rollout: TeamV14Rollout): TeamV14RolloutSummary {
  return {
    id: rollout.id,
    feature: rollout.feature,
    version: rollout.version,
    stage: rollout.stage,
    stageLabel: teamV14StageLabel(rollout.stage),
    percent: teamV14StagePercent(rollout.plan, rollout.stage),
    enabledGroups: teamV14EnabledGroups(rollout).map((g) => g.name),
    gate: evaluateTeamV14HealthGate(rollout),
    autoDecision: decideTeamV14AutoAction(rollout),
    historyCount: rollout.history.length,
  };
}

/**
 * Rollout theo nhóm v2 — canary theo % user, staged rollout có gate
 * sức khỏe giữa các stage, rollback một nút, rollout history
 * (v1.16, Đội T6).
 *
 * Tầng trên của rollout v12 (`fleet/fleetV12Rollout.ts` — % theo
 * NODE, cohort hash nodeId+rolloutId). V12 trả lời "node nào nhận
 * config mới"; module này trả lời "USER nào nhận tính năng mới, theo
 * từng nhóm phần trăm, và khi nào phải dừng lại giữa các stage":
 *
 * - Stage cố định theo % user: canary (1%) → pilot (5%) → early
 *   (25%) → general (50%) → all (100%). Cohort (tập user trong một
 *   stage) được chọn DETERMINISTIC bằng hash SHA-256
 *   (rolloutId + userId): cùng rollout + cùng danh sách user thì
 *   cohort không đổi giữa các lần tính — user không bị nhảy nhóm khi
 *   operator mở lại dashboard, và stage sau luôn bao trọn stage
 *   trước (mở rộng đơn điệu).
 * - Máy trạng thái (hàm thuần): `draft -> canary -> pilot -> early
 *   -> general -> all -> complete`, `paused`, `rolled-back`. Chuyển
 *   đổi không hợp lệ bị từ chối kèm lý do. Rollback là một nút:
 *   `rollbackTeamV13Rollout` đưa rollout về `rolled-back`, ghi rõ
 *   version đang chạy trước đó để caller khôi phục.
 * - Health gate TRƯỚC mỗi lần mở rộng stage: tỉ lệ lỗi của cohort
 *   hiện tại, số user báo lỗi, alert critical đang mở, cỡ mẫu tối
 *   thiểu. Gate trả từng điều kiện riêng (pass/fail + lý do) để UI
 *   vẽ rõ lý do chặn — không gộp thành một boolean mù.
 * - Auto-decision: `decideTeamV13AutoAction` — lỗi vượt ngưỡng thì
 *   đề xuất `pause` (nhẹ, resume được) hoặc `rollback` (nặng).
 *   Module chỉ ĐỀ XUẤT; việc áp dụng do caller gọi hàm chuyển
 *   trạng thái.
 * - History: mỗi lần chuyển trạng thái ghi một entry (actor + lý do
 *   + thời điểm + stage trước/sau) để audit; toàn bộ rollout lưu
 *   `<teamRoot>/rollouts-v116.json` (atomic tmp + rename, 0600).
 *
 * Module này KHÔNG chạm mạng, KHÔNG tự triển khai tính năng thật
 * lên user: nó quyết định "stage nào, user nào, dừng hay lùi" —
 * việc bật flag thật do caller (feature-flag service) làm.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

/** File lưu rollout v13 trong team root. */
export const TEAM_V13_ROLLOUTS_FILE = 'rollouts-v116.json';
/** Tỉ lệ lỗi tối đa cho phép trong cohort trước khi gate chặn. */
export const TEAM_V13_DEFAULT_MAX_ERROR_RATE = 0.05;
/** Tỉ lệ lỗi vượt ngưỡng này thì đề xuất rollback. */
export const TEAM_V13_DEFAULT_ROLLBACK_ERROR_RATE = 0.2;
/** Tỉ lệ lỗi vượt ngưỡng này (dưới ngưỡng rollback) thì đề xuất pause. */
export const TEAM_V13_DEFAULT_PAUSE_ERROR_RATE = 0.1;
/** Số user báo lỗi tối đa cho phép trước khi đề xuất pause. */
export const TEAM_V13_DEFAULT_MAX_REPORTING_USERS = 5;
/** Số user báo lỗi vượt ngưỡng này thì đề xuất rollback. */
export const TEAM_V13_DEFAULT_ROLLBACK_REPORTING_USERS = 20;
/** Cỡ mẫu tối thiểu (số user đã dùng tính năng) để gate có ý nghĩa. */
export const TEAM_V13_DEFAULT_MIN_SAMPLE_USERS = 10;
/** Số rollout tối đa lưu trong file. */
export const TEAM_V13_MAX_ROLLOUTS = 100;
/** Số history entry tối đa giữ mỗi rollout. */
export const TEAM_V13_MAX_HISTORY_ENTRIES = 200;

/** Các stage rollout theo % user, theo thứ tự triển khai. */
export type TeamV13RolloutStage =
  | 'draft'
  | 'canary'
  | 'pilot'
  | 'early'
  | 'general'
  | 'all'
  | 'paused'
  | 'complete'
  | 'rolled-back';

export const TEAM_V13_ROLLOUT_STAGES: readonly TeamV13RolloutStage[] = [
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

/** % user của từng stage triển khai (paused/complete/rolled-back không có %). */
export const TEAM_V13_STAGE_PERCENTAGES: Readonly<Record<string, number>> = {
  canary: 1,
  pilot: 5,
  early: 25,
  general: 50,
  all: 100,
};

/** Stage triển khai theo thứ tự (dùng để tính stage kế tiếp). */
export const TEAM_V13_DEPLOY_STAGES: readonly TeamV13RolloutStage[] = [
  'canary',
  'pilot',
  'early',
  'general',
  'all',
];

/** Nhãn hiển thị cho từng stage. */
export function teamV13StageLabel(stage: TeamV13RolloutStage): string {
  switch (stage) {
    case 'draft':
      return 'nháp';
    case 'canary':
      return 'canary (1% user)';
    case 'pilot':
      return 'pilot (5% user)';
    case 'early':
      return 'early (25% user)';
    case 'general':
      return 'general (50% user)';
    case 'all':
      return 'toàn bộ (100% user)';
    case 'paused':
      return 'tạm dừng';
    case 'complete':
      return 'hoàn tất';
    case 'rolled-back':
      return 'đã rollback';
    default:
      return stage;
  }
}

/** Hành động điều khiển rollout v13. */
export type TeamV13RolloutAction =
  | 'start'
  | 'advance'
  | 'pause'
  | 'resume'
  | 'complete'
  | 'rollback';

export const TEAM_V13_ROLLOUT_ACTIONS: readonly TeamV13RolloutAction[] = [
  'start',
  'advance',
  'pause',
  'resume',
  'complete',
  'rollback',
];

/** Chuyển đổi trạng thái hợp lệ của máy trạng thái rollout v13. */
export const TEAM_V13_ROLLOUT_TRANSITIONS: Record<
  TeamV13RolloutStage,
  readonly TeamV13RolloutAction[]
> = {
  draft: ['start', 'rollback'],
  canary: ['advance', 'pause', 'complete', 'rollback'],
  pilot: ['advance', 'pause', 'complete', 'rollback'],
  early: ['advance', 'pause', 'complete', 'rollback'],
  general: ['advance', 'pause', 'complete', 'rollback'],
  all: ['pause', 'complete', 'rollback'],
  paused: ['resume', 'rollback', 'complete'],
  complete: [],
  'rolled-back': [],
};

/** Một entry trong history của rollout. */
export interface TeamV13RolloutHistoryEntry {
  at: number;
  actorUserId: string;
  action: TeamV13RolloutAction | 'created';
  fromStage: TeamV13RolloutStage | '';
  toStage: TeamV13RolloutStage;
  reason: string;
}

/** Một rollout tính năng theo nhóm % user. */
export interface TeamV13Rollout {
  /** Id ổn định, vd `rollout-voice-v15`. */
  id: string;
  /** Tên tính năng/config đang rollout, vd `voice-v15`. */
  feature: string;
  /** Version tính năng đang rollout (để rollback biết quay về đâu). */
  version: string;
  /** Version đang chạy trước rollout (khôi phục khi rollback). */
  previousVersion: string;
  stage: TeamV13RolloutStage;
  /** Stage triển khai trước khi pause (để resume quay lại đúng stage). */
  stageBeforePause: TeamV13RolloutStage | null;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
  updatedBy: string;
  /** Ghi chú vận hành hiện tại (vd lý do pause). */
  note: string;
  history: TeamV13RolloutHistoryEntry[];
}

/** Toàn bộ store rollout v13 (lưu file). */
export interface TeamV13RolloutStore {
  version: 1;
  rollouts: TeamV13Rollout[];
  updatedAt: number;
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

/** Hash deterministic userId+rolloutId → số [0, 1) để xếp cohort. */
export function teamV13UserRolloutHash(rolloutId: string, userId: string): number {
  const digest = crypto
    .createHash('sha256')
    .update(`${rolloutId.trim()}\n${userId.trim()}`)
    .digest();
  // 6 byte đầu → số nguyên, chia cho 2^48 → [0, 1).
  const int = digest.readUIntBE(0, 6);
  return int / 2 ** 48;
}

/**
 * Cohort của một stage: user nào nằm trong % của stage đó. Vì stage
 * sau bao trọn stage trước (cùng một hàm hash, ngưỡng % tăng dần),
 * user đã nhận tính năng ở stage trước không bao giờ bị mất ở stage
 * sau — mở rộng đơn điệu. Kết quả sắp xếp theo userId để ổn định.
 */
export function teamV13StageCohort(
  rolloutId: string,
  stage: TeamV13RolloutStage,
  userIds: readonly string[],
): string[] {
  const pct = TEAM_V13_STAGE_PERCENTAGES[stage];
  if (pct === undefined) return [];
  const threshold = pct / 100;
  return [...userIds]
    .filter((u) => isNonEmptyString(u) && teamV13UserRolloutHash(rolloutId, u) < threshold)
    .sort();
}

/** True khi user nằm trong cohort của stage hiện tại của rollout. */
export function teamV13UserInRollout(
  rollout: TeamV13Rollout,
  userId: string,
): boolean {
  if (!isNonEmptyString(userId)) return false;
  const pct = TEAM_V13_STAGE_PERCENTAGES[rollout.stage];
  if (pct === undefined) return false;
  return teamV13UserRolloutHash(rollout.id, userId) < pct / 100;
}

/** Stage triển khai kế tiếp sau stage hiện tại (null khi đã ở `all`). */
export function teamV13NextStage(stage: TeamV13RolloutStage): TeamV13RolloutStage | null {
  const idx = TEAM_V13_DEPLOY_STAGES.indexOf(stage);
  if (idx === -1 || idx + 1 >= TEAM_V13_DEPLOY_STAGES.length) return null;
  return TEAM_V13_DEPLOY_STAGES[idx + 1];
}

/** Validate input tạo rollout. Trả về danh sách lỗi (rỗng = hợp lệ). */
export function validateTeamV13RolloutInput(input: {
  id?: string;
  feature?: string;
  version?: string;
  previousVersion?: string;
  createdBy?: string;
}): string[] {
  const errors: string[] = [];
  if (!isNonEmptyString(input?.id)) errors.push('id rollout không được trống');
  else if (!/^[a-z0-9][a-z0-9_-]*$/i.test(input.id.trim())) {
    errors.push('id rollout chỉ được chứa chữ, số, "-" và "_"');
  }
  if (!isNonEmptyString(input?.feature)) errors.push('feature không được trống');
  if (!isNonEmptyString(input?.version)) errors.push('version không được trống');
  if (!isNonEmptyString(input?.previousVersion)) errors.push('previousVersion không được trống');
  if (isNonEmptyString(input?.version) && isNonEmptyString(input?.previousVersion)) {
    if (input.version.trim() === input.previousVersion.trim()) {
      errors.push('version rollout phải khác previousVersion (không thì rollback vô nghĩa)');
    }
  }
  if (!isNonEmptyString(input?.createdBy)) errors.push('createdBy không được trống');
  return errors;
}

export function createTeamV13RolloutStore(now = Date.now()): TeamV13RolloutStore {
  return { version: 1, rollouts: [], updatedAt: now };
}

export type TeamV13CreateRolloutResult =
  | { ok: true; store: TeamV13RolloutStore; rollout: TeamV13Rollout }
  | { ok: false; store: TeamV13RolloutStore; error: string };

export function createTeamV13Rollout(
  store: TeamV13RolloutStore,
  input: { id: string; feature: string; version: string; previousVersion: string; createdBy: string },
  now = Date.now(),
): TeamV13CreateRolloutResult {
  const errors = validateTeamV13RolloutInput(input);
  if (errors.length > 0) {
    return { ok: false, store, error: `rollout không hợp lệ: ${errors.join('; ')}` };
  }
  if (store.rollouts.length >= TEAM_V13_MAX_ROLLOUTS) {
    return { ok: false, store, error: `đã đủ ${TEAM_V13_MAX_ROLLOUTS} rollout tối đa` };
  }
  if (store.rollouts.some((r) => r.id === input.id.trim())) {
    return { ok: false, store, error: `rollout "${input.id}" đã tồn tại` };
  }
  const rollout: TeamV13Rollout = {
    id: input.id.trim(),
    feature: input.feature.trim(),
    version: input.version.trim(),
    previousVersion: input.previousVersion.trim(),
    stage: 'draft',
    stageBeforePause: null,
    createdBy: input.createdBy.trim(),
    createdAt: now,
    updatedAt: now,
    updatedBy: input.createdBy.trim(),
    note: '',
    history: [
      { at: now, actorUserId: input.createdBy.trim(), action: 'created', fromStage: '', toStage: 'draft', reason: 'tạo rollout' },
    ],
  };
  return {
    ok: true,
    store: { ...store, rollouts: [...store.rollouts, rollout], updatedAt: now },
    rollout,
  };
}

export function findTeamV13Rollout(store: TeamV13RolloutStore, rolloutId: string): TeamV13Rollout | null {
  if (!isNonEmptyString(rolloutId)) return null;
  return store.rollouts.find((r) => r.id === rolloutId.trim()) ?? null;
}

function pushHistory(
  rollout: TeamV13Rollout,
  entry: TeamV13RolloutHistoryEntry,
): TeamV13RolloutHistoryEntry[] {
  return [...rollout.history, entry].slice(-TEAM_V13_MAX_HISTORY_ENTRIES);
}

function replaceRollout(
  store: TeamV13RolloutStore,
  rollout: TeamV13Rollout,
  now: number,
): TeamV13RolloutStore {
  return {
    ...store,
    rollouts: store.rollouts.map((r) => (r.id === rollout.id ? rollout : r)),
    updatedAt: now,
  };
}

export type TeamV13RolloutActionResult =
  | { ok: true; store: TeamV13RolloutStore; rollout: TeamV13Rollout }
  | { ok: false; store: TeamV13RolloutStore; error: string };

/**
 * Áp dụng một hành động lên rollout (hàm thuần, kiểm tra máy trạng
 * thái): `start` draft→canary; `advance` stage→stage kế tiếp;
 * `pause` lưu stage trước khi pause; `resume` quay lại stage trước
 * khi pause; `complete` kết thúc; `rollback` về `rolled-back` và
 * ghi rõ version khôi phục trong note. Mọi chuyển đổi đều ghi
 * history (actor + lý do).
 */
export function applyTeamV13RolloutAction(
  store: TeamV13RolloutStore,
  rolloutId: string,
  action: TeamV13RolloutAction,
  actorUserId: string,
  reason = '',
  now = Date.now(),
): TeamV13RolloutActionResult {
  const rollout = findTeamV13Rollout(store, rolloutId);
  if (!rollout) return { ok: false, store, error: `không tìm thấy rollout "${rolloutId}"` };
  if (!TEAM_V13_ROLLOUT_ACTIONS.includes(action)) {
    return { ok: false, store, error: `action "${action}" không hợp lệ` };
  }
  if (!isNonEmptyString(actorUserId)) {
    return { ok: false, store, error: 'actorUserId không được trống' };
  }
  const allowed = TEAM_V13_ROLLOUT_TRANSITIONS[rollout.stage];
  if (!allowed.includes(action)) {
    return {
      ok: false,
      store,
      error: `không thể "${action}" khi rollout đang ở stage "${rollout.stage}" (cho phép: ${allowed.join(', ') || 'không có'})`,
    };
  }
  let nextStage: TeamV13RolloutStage = rollout.stage;
  let stageBeforePause = rollout.stageBeforePause;
  let note = rollout.note;
  switch (action) {
    case 'start':
      nextStage = 'canary';
      break;
    case 'advance': {
      const next = teamV13NextStage(rollout.stage);
      if (!next) return { ok: false, store, error: 'rollout đã ở stage cuối, không advance được nữa' };
      nextStage = next;
      break;
    }
    case 'pause':
      stageBeforePause = rollout.stage;
      nextStage = 'paused';
      note = reason.trim() || rollout.note;
      break;
    case 'resume':
      nextStage = rollout.stageBeforePause ?? 'canary';
      stageBeforePause = null;
      break;
    case 'complete':
      nextStage = 'complete';
      break;
    case 'rollback':
      nextStage = 'rolled-back';
      stageBeforePause = null;
      note =
        reason.trim() ||
        `rollback về version ${rollout.previousVersion} (từ ${rollout.version})`;
      break;
    default:
      break;
  }
  const updated: TeamV13Rollout = {
    ...rollout,
    stage: nextStage,
    stageBeforePause,
    updatedAt: now,
    updatedBy: actorUserId.trim(),
    note,
    history: pushHistory(rollout, {
      at: now,
      actorUserId: actorUserId.trim(),
      action,
      fromStage: rollout.stage,
      toStage: nextStage,
      reason: reason.trim(),
    }),
  };
  return { ok: true, store: replaceRollout(store, updated, now), rollout: updated };
}

/**
 * Rollback một nút: gọi `applyTeamV13RolloutAction` với `rollback`
 * nhưng kèm kiểm tra riêng — rollout đã `complete`/`rolled-back`
 * thì không rollback được nữa. Trả về version cần khôi phục để
 * caller bật lại flag cũ.
 */
export type TeamV13RollbackResult =
  | { ok: true; store: TeamV13RolloutStore; rollout: TeamV13Rollout; restoreVersion: string }
  | { ok: false; store: TeamV13RolloutStore; error: string };

export function rollbackTeamV13Rollout(
  store: TeamV13RolloutStore,
  rolloutId: string,
  actorUserId: string,
  reason = '',
  now = Date.now(),
): TeamV13RollbackResult {
  const rollout = findTeamV13Rollout(store, rolloutId);
  if (!rollout) return { ok: false, store, error: `không tìm thấy rollout "${rolloutId}"` };
  if (rollout.stage === 'complete' || rollout.stage === 'rolled-back') {
    return {
      ok: false,
      store,
      error: `rollout đang ở stage "${rollout.stage}" — không rollback được nữa`,
    };
  }
  const applied = applyTeamV13RolloutAction(store, rolloutId, 'rollback', actorUserId, reason, now);
  if (!applied.ok) return applied;
  return { ...applied, restoreVersion: rollout.previousVersion };
}

// ---------------------------------------------------------------------------
// Health gate giữa các stage
// ---------------------------------------------------------------------------

/** Số liệu sức khỏe của cohort hiện tại (do caller đo, module chỉ xét). */
export interface TeamV13CohortHealth {
  /** Số user trong cohort đã dùng tính năng (cỡ mẫu). */
  sampleUsers: number;
  /** Tỉ lệ lỗi (0..1) trong cohort. */
  errorRate: number;
  /** Số user đã báo lỗi / phàn nàn. */
  reportingUsers: number;
  /** Số alert critical đang mở liên quan tới tính năng. */
  openCriticalAlerts: number;
}

/** Ngưỡng gate (caller có thể chỉnh, mặc định theo hằng số trên). */
export interface TeamV13GateThresholds {
  maxErrorRate: number;
  maxReportingUsers: number;
  minSampleUsers: number;
}

/** Một điều kiện gate riêng (để UI vẽ rõ lý do chặn). */
export interface TeamV13GateCheck {
  name: string;
  passed: boolean;
  detail: string;
}

/** Kết quả gate: pass thì mới được advance sang stage kế. */
export interface TeamV13GateResult {
  passed: boolean;
  fromStage: TeamV13RolloutStage;
  toStage: TeamV13RolloutStage | null;
  checks: TeamV13GateCheck[];
  summary: string;
}

export const TEAM_V13_DEFAULT_GATE_THRESHOLDS: TeamV13GateThresholds = {
  maxErrorRate: TEAM_V13_DEFAULT_MAX_ERROR_RATE,
  maxReportingUsers: TEAM_V13_DEFAULT_MAX_REPORTING_USERS,
  minSampleUsers: TEAM_V13_DEFAULT_MIN_SAMPLE_USERS,
};

/**
 * Gate sức khỏe trước khi mở rộng stage: 4 điều kiện — cỡ mẫu đủ
 * lớn (chưa đủ mẫu thì gate fail để khỏi mở rộng mù), tỉ lệ lỗi
 * dưới ngưỡng, số user báo lỗi dưới ngưỡng, không có alert
 * critical đang mở. Draft/paused/complete/rolled-back không có
 * stage kế → gate fail kèm lý do.
 */
export function checkTeamV13RolloutGate(
  rollout: TeamV13Rollout,
  health: TeamV13CohortHealth,
  thresholds: TeamV13GateThresholds = TEAM_V13_DEFAULT_GATE_THRESHOLDS,
): TeamV13GateResult {
  const toStage = teamV13NextStage(rollout.stage);
  if (!toStage) {
    return {
      passed: false,
      fromStage: rollout.stage,
      toStage: null,
      checks: [
        {
          name: 'next-stage',
          passed: false,
          detail: `rollout đang ở stage "${rollout.stage}" — không có stage kế tiếp để mở rộng`,
        },
      ],
      summary: `Không mở rộng được từ stage "${teamV13StageLabel(rollout.stage)}".`,
    };
  }
  const checks: TeamV13GateCheck[] = [
    {
      name: 'sample',
      passed: health.sampleUsers >= thresholds.minSampleUsers,
      detail:
        health.sampleUsers >= thresholds.minSampleUsers
          ? `đủ mẫu: ${health.sampleUsers} user đã dùng (tối thiểu ${thresholds.minSampleUsers})`
          : `chưa đủ mẫu: mới ${health.sampleUsers}/${thresholds.minSampleUsers} user đã dùng — chờ thêm dữ liệu`,
    },
    {
      name: 'error-rate',
      passed: health.errorRate <= thresholds.maxErrorRate,
      detail: `tỉ lệ lỗi ${(health.errorRate * 100).toFixed(1)}% (ngưỡng ${(thresholds.maxErrorRate * 100).toFixed(1)}%)`,
    },
    {
      name: 'reporting-users',
      passed: health.reportingUsers <= thresholds.maxReportingUsers,
      detail: `${health.reportingUsers} user báo lỗi (tối đa ${thresholds.maxReportingUsers})`,
    },
    {
      name: 'critical-alerts',
      passed: health.openCriticalAlerts === 0,
      detail:
        health.openCriticalAlerts === 0
          ? 'không có alert critical đang mở'
          : `${health.openCriticalAlerts} alert critical đang mở — phải xử lý trước khi mở rộng`,
    },
  ];
  const passed = checks.every((c) => c.passed);
  return {
    passed,
    fromStage: rollout.stage,
    toStage,
    checks,
    summary: passed
      ? `Gate đạt: mở rộng được từ ${teamV13StageLabel(rollout.stage)} → ${teamV13StageLabel(toStage)}.`
      : `Gate chặn: chưa mở rộng được từ ${teamV13StageLabel(rollout.stage)} → ${teamV13StageLabel(toStage)} (${checks.filter((c) => !c.passed).length} điều kiện fail).`,
  };
}

/** Hành động tự động đề xuất khi health xấu (module chỉ đề xuất). */
export type TeamV13AutoAction = 'none' | 'pause' | 'rollback';

export interface TeamV13AutoActionDecision {
  action: TeamV13AutoAction;
  reason: string;
}

/**
 * Quyết định tự động: lỗi vượt ngưỡng rollback (hoặc quá nhiều user
 * báo lỗi / alert critical mới) → `rollback`; lỗi vượt ngưỡng pause
 * → `pause`; còn lại → `none`. Ngưỡng mặc định theo hằng số trên.
 */
export function decideTeamV13AutoAction(
  health: TeamV13CohortHealth,
  thresholds: {
    pauseErrorRate?: number;
    rollbackErrorRate?: number;
    maxDownUsers?: number;
    rollbackReportingUsers?: number;
  } = {},
): TeamV13AutoActionDecision {
  const pauseErrorRate = thresholds.pauseErrorRate ?? TEAM_V13_DEFAULT_PAUSE_ERROR_RATE;
  const rollbackErrorRate = thresholds.rollbackErrorRate ?? TEAM_V13_DEFAULT_ROLLBACK_ERROR_RATE;
  const rollbackReportingUsers =
    thresholds.rollbackReportingUsers ?? TEAM_V13_DEFAULT_ROLLBACK_REPORTING_USERS;
  if (health.errorRate >= rollbackErrorRate) {
    return {
      action: 'rollback',
      reason: `tỉ lệ lỗi ${(health.errorRate * 100).toFixed(1)}% vượt ngưỡng rollback ${(rollbackErrorRate * 100).toFixed(0)}%`,
    };
  }
  if (health.reportingUsers >= rollbackReportingUsers) {
    return {
      action: 'rollback',
      reason: `${health.reportingUsers} user báo lỗi, vượt ngưỡng rollback ${rollbackReportingUsers}`,
    };
  }
  if (health.openCriticalAlerts > 0 && health.errorRate >= pauseErrorRate) {
    return {
      action: 'rollback',
      reason: `${health.openCriticalAlerts} alert critical đang mở kèm tỉ lệ lỗi ${(health.errorRate * 100).toFixed(1)}%`,
    };
  }
  if (health.errorRate >= pauseErrorRate) {
    return {
      action: 'pause',
      reason: `tỉ lệ lỗi ${(health.errorRate * 100).toFixed(1)}% vượt ngưỡng pause ${(pauseErrorRate * 100).toFixed(0)}% — tạm dừng để kiểm tra`,
    };
  }
  return { action: 'none', reason: 'sức khỏe cohort trong ngưỡng, không cần hành động tự động' };
}

/** Tóm tắt rollout cho UI: stage, % user, cohort, history. */
export interface TeamV13RolloutSummary {
  rolloutId: string;
  feature: string;
  version: string;
  stage: TeamV13RolloutStage;
  stageLabel: string;
  percent: number | null;
  cohortSize: number;
  totalUsers: number;
  historyCount: number;
  summary: string;
}

export function summarizeTeamV13Rollout(
  rollout: TeamV13Rollout,
  userIds: readonly string[],
): TeamV13RolloutSummary {
  const percent = TEAM_V13_STAGE_PERCENTAGES[rollout.stage] ?? null;
  const cohort = percent === null ? [] : teamV13StageCohort(rollout.id, rollout.stage, userIds);
  return {
    rolloutId: rollout.id,
    feature: rollout.feature,
    version: rollout.version,
    stage: rollout.stage,
    stageLabel: teamV13StageLabel(rollout.stage),
    percent,
    cohortSize: cohort.length,
    totalUsers: userIds.length,
    historyCount: rollout.history.length,
    summary:
      percent === null
        ? `Rollout "${rollout.feature}" ${rollout.version} đang ở stage ${teamV13StageLabel(rollout.stage)}.`
        : `Rollout "${rollout.feature}" ${rollout.version}: ${teamV13StageLabel(rollout.stage)} — ${cohort.length}/${userIds.length} user trong cohort.`,
  };
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

export function getTeamV13RolloutsPath(teamRoot: string): string {
  return path.join(teamRoot, TEAM_V13_ROLLOUTS_FILE);
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

function isValidRollout(v: unknown): v is TeamV13Rollout {
  if (!v || typeof v !== 'object') return false;
  const r = v as Partial<TeamV13Rollout>;
  return (
    typeof r.id === 'string' &&
    typeof r.feature === 'string' &&
    typeof r.version === 'string' &&
    TEAM_V13_ROLLOUT_STAGES.includes(r.stage as TeamV13RolloutStage) &&
    Array.isArray(r.history)
  );
}

export function loadTeamV13RolloutStore(teamRoot: string): TeamV13RolloutStore | null {
  try {
    const raw = fs.readFileSync(getTeamV13RolloutsPath(teamRoot), 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return null;
    const p = parsed as Partial<TeamV13RolloutStore>;
    if (p.version !== 1 || !Array.isArray(p.rollouts)) return null;
    return {
      version: 1,
      rollouts: p.rollouts.filter(isValidRollout).slice(0, TEAM_V13_MAX_ROLLOUTS),
      updatedAt: typeof p.updatedAt === 'number' ? p.updatedAt : 0,
    };
  } catch {
    return null;
  }
}

export function saveTeamV13RolloutStore(teamRoot: string, store: TeamV13RolloutStore): void {
  atomicWriteFile(getTeamV13RolloutsPath(teamRoot), `${JSON.stringify(store, null, 2)}\n`);
}

/**
 * Rollout v6 — rollout engine: staged rollout theo user group, canary
 * theo %, auto-rollback khi error rate vượt ngưỡng, rollout history
 * đầy đủ (v1.20, Đội T6).
 *
 * Tầng trên của rollout v5 (`fleetV16/rolloutV16.ts` — canary ramp
 * theo thời gian, feature flag + kill switch, auto-rollback theo
 * error budget) và rollout v4 (`fleetV15/rolloutV15.ts` — rollout
 * theo node, approve theo stage). V5 trả lời "mở cho bao nhiêu %,
 * user này có cờ không, có nên pause/rollback không"; v6 trả lời
 * 4 câu triển khai tiếp theo:
 *
 * - STAGED THEO NHÓM USER: rollout đi qua các stage, mỗi stage
 *   gắn một nhóm user (vd `internal` → `beta` → `all`) + % trong
 *   nhóm đó; stage chỉ advance khi stage trước đủ điều kiện
 *   (dwell tối thiểu + error rate dưới ngưỡng + có approve nếu
 *   stage yêu cầu). Nhóm `all` là nhóm đặc biệt = mọi user.
 * - CANARY THEO % TRONG NHÓM: user trong nhóm được chọn bằng
 *   hash bucket ổn định (kế thừa `teamV14UserBucket`) — cùng user
 *   luôn cùng bucket qua các lần đánh giá, nên tăng % không làm
 *   user đang dùng bị rớt ra.
 * - AUTO-ROLLBACK KHI ERROR RATE VƯỢT NGƯỠNG: cửa sổ trượt
 *   (mặc định 10 phút) đếm error/total; vượt ngưỡng + đủ mẫu tối
 *   thiểu → rollback; lỗi liên tiếp vượt ngưỡng → rollback ngay;
 *   vượt ngưỡng pause (thấp hơn) → chỉ pause stage. Mỗi quyết định
 *   kèm lý do + số liệu để ghi history.
 * - ROLLOUT HISTORY: mọi chuyển đổi (create/start/advance/pause/
 *   resume/rollback/complete/auto-*) ghi entry có actor, lý do,
 *   from→to, số liệu tại thời điểm đó; history là append-only,
 *   tối đa 500 entry/rollout (cắt cũ nhất).
 *
 * Module này KHÔNG deploy code, KHÔNG chạm mạng: nó quyết định
 * "stage nào, user này có nhận version mới không, có nên dừng/
 * rollback không" — việc deploy/rollback thật do caller làm theo
 * kết quả trả về.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { teamV14UserBucket } from '../fleetV14/rolloutV14';

/** File lưu rollout v6 trong team root. */
export const TEAM_V17_ROLLOUTS_FILE = 'rollouts-v120.json';
/** Phiên bản định dạng state v6. */
export const TEAM_V17_ROLLOUT_STATE_VERSION = 1;
/** Số rollout v6 tối đa. */
export const TEAM_V17_MAX_ROLLOUTS = 100;
/** Số stage tối đa mỗi rollout. */
export const TEAM_V17_MAX_STAGES = 20;
/** Số history entry tối đa mỗi rollout. */
export const TEAM_V17_MAX_HISTORY_ENTRIES = 500;
/** Cửa sổ mặc định đánh giá error rate: 10 phút. */
export const TEAM_V17_ROLLOUT_ERROR_WINDOW_MS = 10 * 60 * 1000;
/** Số mẫu tối thiểu để kết luận error rate. */
export const TEAM_V17_ROLLOUT_MIN_SAMPLES = 50;
/** Số lỗi liên tiếp mặc định → rollback ngay. */
export const TEAM_V17_ROLLOUT_MAX_CONSECUTIVE_ERRORS = 10;

/** Nhóm đặc biệt: mọi user. */
export const TEAM_V17_ROLLOUT_GROUP_ALL = 'all';

/** Một stage trong rollout v6. */
export interface TeamV17RolloutStage {
  /** Tên stage (vd `internal`, `beta`, `general`). */
  name: string;
  /** Nhóm user của stage (`all` = mọi user). */
  groupId: string;
  /** % user trong nhóm nhận version mới ở stage này (0..100). */
  percent: number;
  /** Thời gian tối thiểu ở stage này trước khi advance (ms). */
  dwellMs: number;
  /** Stage này có cần approve thủ công trước khi advance không. */
  requiresApproval: boolean;
}

/** Lỗi validate một stage, '' = hợp lệ. */
export function validateTeamV17RolloutStage(stage: TeamV17RolloutStage): string {
  if (typeof stage.name !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(stage.name)) {
    return 'tên stage phải là slug: chữ thường/số/gạch nối';
  }
  if (typeof stage.groupId !== 'string' || stage.groupId.length === 0 || stage.groupId.length > 80) {
    return 'groupId của stage không được rỗng và tối đa 80 ký tự';
  }
  if (!Number.isFinite(stage.percent) || stage.percent < 0 || stage.percent > 100) {
    return 'percent của stage phải trong 0..100';
  }
  if (!Number.isFinite(stage.dwellMs) || stage.dwellMs < 0) {
    return 'dwellMs của stage phải >= 0';
  }
  return '';
}

/** Lỗi validate toàn bộ plan stage, '' = hợp lệ. */
export function validateTeamV17RolloutPlan(stages: readonly TeamV17RolloutStage[]): string {
  if (stages.length === 0) return 'rollout cần ít nhất 1 stage';
  if (stages.length > TEAM_V17_MAX_STAGES) return `rollout tối đa ${TEAM_V17_MAX_STAGES} stage`;
  const names = new Set<string>();
  for (const s of stages) {
    const err = validateTeamV17RolloutStage(s);
    if (err) return err;
    if (names.has(s.name)) return `trùng tên stage: ${s.name}`;
    names.add(s.name);
  }
  const percents = stages.map((s) => s.percent);
  for (let i = 1; i < percents.length; i++) {
    if (percents[i] < percents[i - 1]) return 'percent các stage phải tăng đơn điệu (không giảm)';
  }
  const last = stages[stages.length - 1];
  if (last.groupId !== TEAM_V17_ROLLOUT_GROUP_ALL || last.percent !== 100) {
    return 'stage cuối phải là group "all" với percent 100 (mở hết cho mọi user)';
  }
  return '';
}

/** Trạng thái rollout v6. */
export type TeamV17RolloutStatus =
  | 'draft'
  | 'running'
  | 'paused'
  | 'rolled-back'
  | 'completed'
  | 'cancelled';

export const TEAM_V17_ROLLOUT_STATUSES: readonly TeamV17RolloutStatus[] = [
  'draft',
  'running',
  'paused',
  'rolled-back',
  'completed',
  'cancelled',
];

/** Một entry history của rollout (append-only). */
export interface TeamV17RolloutHistoryEntry {
  seq: number;
  at: number;
  actorUserId: string;
  /** vd `create`, `start`, `advance`, `pause`, `resume`, `rollback`, `complete`, `cancel`, `auto-pause`, `auto-rollback`, `approve`. */
  action: string;
  fromStageIndex: number;
  toStageIndex: number;
  fromStatus: TeamV17RolloutStatus;
  toStatus: TeamV17RolloutStatus;
  reason: string;
  /** Số liệu error rate tại thời điểm ghi (null = không áp dụng). */
  errorRate: number | null;
  sampleCount: number | null;
}

/** Một rollout v6. */
export interface TeamV17Rollout {
  id: string;
  name: string;
  /** Version đích (vd `1.20.0`). */
  targetVersion: string;
  /** Version đang chạy trước rollout (để rollback về). */
  previousVersion: string;
  stages: TeamV17RolloutStage[];
  /** Index stage hiện tại (-1 = chưa start). */
  currentStageIndex: number;
  status: TeamV17RolloutStatus;
  createdByUserId: string;
  createdAt: number;
  updatedAt: number;
  /** Epoch ms bắt đầu stage hiện tại (null = chưa start). */
  stageStartedAt: number | null;
  /** Stage đã approve (tên stage) — approve rồi mới được advance khỏi stage requiresApproval. */
  approvedStages: string[];
  /** Ngưỡng error rate → rollback (0..1). */
  rollbackErrorRate: number;
  /** Ngưỡng error rate → pause (0..1, phải < rollbackErrorRate). */
  pauseErrorRate: number;
  /** Số lỗi liên tiếp → rollback ngay. */
  maxConsecutiveErrors: number;
  /** Số mẫu tối thiểu để kết luận. */
  minSamples: number;
  history: TeamV17RolloutHistoryEntry[];
  nextHistorySeq: number;
}

/** Lỗi validate rollout, '' = hợp lệ. */
export function validateTeamV17Rollout(input: {
  id?: string;
  name?: string;
  targetVersion?: string;
  previousVersion?: string;
  rollbackErrorRate?: number;
  pauseErrorRate?: number;
  maxConsecutiveErrors?: number;
  minSamples?: number;
}): string {
  if (typeof input.id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(input.id)) {
    return 'id rollout phải là slug: chữ thường/số/gạch nối';
  }
  if (typeof input.name !== 'string' || input.name.trim().length === 0 || input.name.length > 120) {
    return 'tên rollout không được rỗng và tối đa 120 ký tự';
  }
  if (typeof input.targetVersion !== 'string' || input.targetVersion.trim().length === 0) {
    return 'targetVersion không được rỗng';
  }
  if (typeof input.previousVersion !== 'string' || input.previousVersion.trim().length === 0) {
    return 'previousVersion không được rỗng';
  }
  if (input.targetVersion === input.previousVersion) return 'targetVersion phải khác previousVersion';
  const rb = input.rollbackErrorRate ?? 0.05;
  const pa = input.pauseErrorRate ?? 0.02;
  if (!Number.isFinite(rb) || rb <= 0 || rb > 1) return 'rollbackErrorRate phải trong (0, 1]';
  if (!Number.isFinite(pa) || pa < 0 || pa >= rb) return 'pauseErrorRate phải trong [0, rollbackErrorRate)';
  if (input.maxConsecutiveErrors !== undefined && (!Number.isInteger(input.maxConsecutiveErrors) || input.maxConsecutiveErrors <= 0)) {
    return 'maxConsecutiveErrors phải là số nguyên > 0';
  }
  if (input.minSamples !== undefined && (!Number.isInteger(input.minSamples) || input.minSamples <= 0)) {
    return 'minSamples phải là số nguyên > 0';
  }
  return '';
}

// ---------------------------------------------------------------------------
// Store + tạo rollout
// ---------------------------------------------------------------------------

/** Store rollout v6. */
export interface TeamV17RolloutStore {
  version: number;
  rollouts: TeamV17Rollout[];
  createdAt: number;
  updatedAt: number;
}

export function createTeamV17RolloutStore(now = Date.now()): TeamV17RolloutStore {
  return { version: TEAM_V17_ROLLOUT_STATE_VERSION, rollouts: [], createdAt: now, updatedAt: now };
}

export function findTeamV17Rollout(store: TeamV17RolloutStore, rolloutId: string): TeamV17Rollout | null {
  return store.rollouts.find((r) => r.id === rolloutId) ?? null;
}

/** Ghi một entry history (cắt cũ khi quá giới hạn). */
function appendTeamV17History(
  rollout: TeamV17Rollout,
  entry: Omit<TeamV17RolloutHistoryEntry, 'seq'>,
): TeamV17Rollout {
  const full: TeamV17RolloutHistoryEntry = { ...entry, seq: rollout.nextHistorySeq };
  const history = [...rollout.history, full].slice(-TEAM_V17_MAX_HISTORY_ENTRIES);
  return { ...rollout, history, nextHistorySeq: rollout.nextHistorySeq + 1 };
}

/** Tạo rollout mới ở trạng thái draft. */
export function createTeamV17Rollout(
  store: TeamV17RolloutStore,
  input: {
    id: string;
    name: string;
    targetVersion: string;
    previousVersion: string;
    stages: TeamV17RolloutStage[];
    createdByUserId: string;
    rollbackErrorRate?: number;
    pauseErrorRate?: number;
    maxConsecutiveErrors?: number;
    minSamples?: number;
  },
  now = Date.now(),
): { ok: boolean; store: TeamV17RolloutStore; error: string; rollout: TeamV17Rollout | null } {
  const fail = (error: string) => ({ ok: false, store, error, rollout: null });
  const err = validateTeamV17Rollout(input);
  if (err) return fail(err);
  const planErr = validateTeamV17RolloutPlan(input.stages);
  if (planErr) return fail(planErr);
  if (findTeamV17Rollout(store, input.id)) return fail(`rollout đã tồn tại: ${input.id}`);
  if (store.rollouts.length >= TEAM_V17_MAX_ROLLOUTS) return fail('đã đủ số rollout tối đa');
  let rollout: TeamV17Rollout = {
    id: input.id,
    name: input.name.trim(),
    targetVersion: input.targetVersion.trim(),
    previousVersion: input.previousVersion.trim(),
    stages: input.stages.map((s) => ({ ...s })),
    currentStageIndex: -1,
    status: 'draft',
    createdByUserId: input.createdByUserId,
    createdAt: now,
    updatedAt: now,
    stageStartedAt: null,
    approvedStages: [],
    rollbackErrorRate: input.rollbackErrorRate ?? 0.05,
    pauseErrorRate: input.pauseErrorRate ?? 0.02,
    maxConsecutiveErrors: input.maxConsecutiveErrors ?? TEAM_V17_ROLLOUT_MAX_CONSECUTIVE_ERRORS,
    minSamples: input.minSamples ?? TEAM_V17_ROLLOUT_MIN_SAMPLES,
    history: [],
    nextHistorySeq: 1,
  };
  rollout = appendTeamV17History(rollout, {
    at: now,
    actorUserId: input.createdByUserId,
    action: 'create',
    fromStageIndex: -1,
    toStageIndex: -1,
    fromStatus: 'draft',
    toStatus: 'draft',
    reason: `tạo rollout ${input.targetVersion} (${input.stages.length} stage)`,
    errorRate: null,
    sampleCount: null,
  });
  return {
    ok: true,
    store: { ...store, rollouts: [...store.rollouts, rollout], updatedAt: now },
    error: '',
    rollout,
  };
}

/** Thay rollout trong store bằng bản mới. */
function replaceTeamV17Rollout(store: TeamV17RolloutStore, rollout: TeamV17Rollout, now = Date.now()): TeamV17RolloutStore {
  return {
    ...store,
    rollouts: store.rollouts.map((r) => (r.id === rollout.id ? { ...rollout, updatedAt: now } : r)),
    updatedAt: now,
  };
}

export interface TeamV17RolloutResult {
  ok: boolean;
  store: TeamV17RolloutStore;
  error: string;
  rollout: TeamV17Rollout | null;
}

function failRollout(store: TeamV17RolloutStore, error: string): TeamV17RolloutResult {
  return { ok: false, store, error, rollout: null };
}

// ---------------------------------------------------------------------------
// Chuyển đổi trạng thái
// ---------------------------------------------------------------------------

/** Start rollout: draft → running, vào stage 0. */
export function startTeamV17Rollout(
  store: TeamV17RolloutStore,
  rolloutId: string,
  actorUserId: string,
  now = Date.now(),
): TeamV17RolloutResult {
  const rollout = findTeamV17Rollout(store, rolloutId);
  if (!rollout) return failRollout(store, `không có rollout ${rolloutId}`);
  if (rollout.status !== 'draft') return failRollout(store, `chỉ start được rollout draft (đang ${rollout.status})`);
  let next = appendTeamV17History(
    { ...rollout, status: 'running', currentStageIndex: 0, stageStartedAt: now },
    {
      at: now,
      actorUserId,
      action: 'start',
      fromStageIndex: -1,
      toStageIndex: 0,
      fromStatus: 'draft',
      toStatus: 'running',
      reason: `bắt đầu stage ${rollout.stages[0].name} (${rollout.stages[0].percent}% nhóm ${rollout.stages[0].groupId})`,
      errorRate: null,
      sampleCount: null,
    },
  );
  return { ok: true, store: replaceTeamV17Rollout(store, next, now), error: '', rollout: next };
}

/** Stage hiện tại của rollout (null khi chưa start). */
export function teamV17CurrentStage(rollout: TeamV17Rollout): TeamV17RolloutStage | null {
  if (rollout.currentStageIndex < 0 || rollout.currentStageIndex >= rollout.stages.length) return null;
  return rollout.stages[rollout.currentStageIndex];
}

/** Stage đã ở đủ dwell chưa (tại `now`). */
export function teamV17StageDwellSatisfied(rollout: TeamV17Rollout, now = Date.now()): boolean {
  const stage = teamV17CurrentStage(rollout);
  if (!stage || rollout.stageStartedAt === null) return false;
  return now - rollout.stageStartedAt >= stage.dwellMs;
}

/** Lý do chưa advance được ('' = advance được). */
export function teamV17AdvanceBlockReason(
  rollout: TeamV17Rollout,
  metrics: { errorRate: number; sampleCount: number } | null,
  now = Date.now(),
): string {
  if (rollout.status !== 'running') return `rollout đang ${rollout.status}, không advance được`;
  const stage = teamV17CurrentStage(rollout);
  if (!stage) return 'rollout chưa start';
  if (rollout.currentStageIndex >= rollout.stages.length - 1) return 'đã ở stage cuối — hãy complete thay vì advance';
  if (!teamV17StageDwellSatisfied(rollout, now)) {
    return `stage ${stage.name} chưa đủ dwell (${stage.dwellMs}ms)`;
  }
  if (stage.requiresApproval && !rollout.approvedStages.includes(stage.name)) {
    return `stage ${stage.name} cần approve trước khi advance`;
  }
  if (metrics && metrics.sampleCount >= rollout.minSamples && metrics.errorRate >= rollout.pauseErrorRate) {
    return `error rate ${(metrics.errorRate * 100).toFixed(1)}% >= ngưỡng pause ${(rollout.pauseErrorRate * 100).toFixed(1)}% — hãy pause hoặc chờ error giảm`;
  }
  return '';
}

/** Approve stage hiện tại (để advance khỏi stage requiresApproval). */
export function approveTeamV17Stage(
  store: TeamV17RolloutStore,
  rolloutId: string,
  actorUserId: string,
  now = Date.now(),
): TeamV17RolloutResult {
  const rollout = findTeamV17Rollout(store, rolloutId);
  if (!rollout) return failRollout(store, `không có rollout ${rolloutId}`);
  if (rollout.status !== 'running' && rollout.status !== 'paused') {
    return failRollout(store, `chỉ approve được rollout running/paused (đang ${rollout.status})`);
  }
  const stage = teamV17CurrentStage(rollout);
  if (!stage) return failRollout(store, 'rollout chưa start');
  if (rollout.approvedStages.includes(stage.name)) return failRollout(store, `stage ${stage.name} đã approve rồi`);
  let next = appendTeamV17History(
    { ...rollout, approvedStages: [...rollout.approvedStages, stage.name] },
    {
      at: now,
      actorUserId,
      action: 'approve',
      fromStageIndex: rollout.currentStageIndex,
      toStageIndex: rollout.currentStageIndex,
      fromStatus: rollout.status,
      toStatus: rollout.status,
      reason: `approve stage ${stage.name}`,
      errorRate: null,
      sampleCount: null,
    },
  );
  return { ok: true, store: replaceTeamV17Rollout(store, next, now), error: '', rollout: next };
}

/** Advance sang stage tiếp theo. */
export function advanceTeamV17Rollout(
  store: TeamV17RolloutStore,
  rolloutId: string,
  actorUserId: string,
  metrics: { errorRate: number; sampleCount: number } | null = null,
  now = Date.now(),
): TeamV17RolloutResult {
  const rollout = findTeamV17Rollout(store, rolloutId);
  if (!rollout) return failRollout(store, `không có rollout ${rolloutId}`);
  const block = teamV17AdvanceBlockReason(rollout, metrics, now);
  if (block) return failRollout(store, block);
  const from = rollout.currentStageIndex;
  const to = from + 1;
  const stage = rollout.stages[to];
  let next = appendTeamV17History(
    { ...rollout, currentStageIndex: to, stageStartedAt: now },
    {
      at: now,
      actorUserId,
      action: 'advance',
      fromStageIndex: from,
      toStageIndex: to,
      fromStatus: 'running',
      toStatus: 'running',
      reason: `sang stage ${stage.name} (${stage.percent}% nhóm ${stage.groupId})`,
      errorRate: metrics?.errorRate ?? null,
      sampleCount: metrics?.sampleCount ?? null,
    },
  );
  return { ok: true, store: replaceTeamV17Rollout(store, next, now), error: '', rollout: next };
}

/** Pause rollout đang running. */
export function pauseTeamV17Rollout(
  store: TeamV17RolloutStore,
  rolloutId: string,
  actorUserId: string,
  reason: string,
  now = Date.now(),
): TeamV17RolloutResult {
  const rollout = findTeamV17Rollout(store, rolloutId);
  if (!rollout) return failRollout(store, `không có rollout ${rolloutId}`);
  if (rollout.status !== 'running') return failRollout(store, `chỉ pause được rollout running (đang ${rollout.status})`);
  let next = appendTeamV17History(
    { ...rollout, status: 'paused' },
    {
      at: now,
      actorUserId,
      action: 'pause',
      fromStageIndex: rollout.currentStageIndex,
      toStageIndex: rollout.currentStageIndex,
      fromStatus: 'running',
      toStatus: 'paused',
      reason,
      errorRate: null,
      sampleCount: null,
    },
  );
  return { ok: true, store: replaceTeamV17Rollout(store, next, now), error: '', rollout: next };
}

/** Resume rollout đang paused. */
export function resumeTeamV17Rollout(
  store: TeamV17RolloutStore,
  rolloutId: string,
  actorUserId: string,
  now = Date.now(),
): TeamV17RolloutResult {
  const rollout = findTeamV17Rollout(store, rolloutId);
  if (!rollout) return failRollout(store, `không có rollout ${rolloutId}`);
  if (rollout.status !== 'paused') return failRollout(store, `chỉ resume được rollout paused (đang ${rollout.status})`);
  let next = appendTeamV17History(
    { ...rollout, status: 'running' },
    {
      at: now,
      actorUserId,
      action: 'resume',
      fromStageIndex: rollout.currentStageIndex,
      toStageIndex: rollout.currentStageIndex,
      fromStatus: 'paused',
      toStatus: 'running',
      reason: 'tiếp tục rollout',
      errorRate: null,
      sampleCount: null,
    },
  );
  return { ok: true, store: replaceTeamV17Rollout(store, next, now), error: '', rollout: next };
}

/** Rollback về previousVersion (từ running/paused). */
export function rollbackTeamV17Rollout(
  store: TeamV17RolloutStore,
  rolloutId: string,
  actorUserId: string,
  reason: string,
  now = Date.now(),
): TeamV17RolloutResult {
  const rollout = findTeamV17Rollout(store, rolloutId);
  if (!rollout) return failRollout(store, `không có rollout ${rolloutId}`);
  if (rollout.status !== 'running' && rollout.status !== 'paused') {
    return failRollout(store, `chỉ rollback được rollout running/paused (đang ${rollout.status})`);
  }
  let next = appendTeamV17History(
    { ...rollout, status: 'rolled-back' },
    {
      at: now,
      actorUserId,
      action: 'rollback',
      fromStageIndex: rollout.currentStageIndex,
      toStageIndex: -1,
      fromStatus: rollout.status,
      toStatus: 'rolled-back',
      reason,
      errorRate: null,
      sampleCount: null,
    },
  );
  return { ok: true, store: replaceTeamV17Rollout(store, next, now), error: '', rollout: next };
}

/** Complete rollout (chỉ khi đang ở stage cuối và running). */
export function completeTeamV17Rollout(
  store: TeamV17RolloutStore,
  rolloutId: string,
  actorUserId: string,
  now = Date.now(),
): TeamV17RolloutResult {
  const rollout = findTeamV17Rollout(store, rolloutId);
  if (!rollout) return failRollout(store, `không có rollout ${rolloutId}`);
  if (rollout.status !== 'running') return failRollout(store, `chỉ complete được rollout running (đang ${rollout.status})`);
  if (rollout.currentStageIndex !== rollout.stages.length - 1) {
    return failRollout(store, 'chỉ complete được khi đang ở stage cuối (100% all)');
  }
  let next = appendTeamV17History(
    { ...rollout, status: 'completed' },
    {
      at: now,
      actorUserId,
      action: 'complete',
      fromStageIndex: rollout.currentStageIndex,
      toStageIndex: rollout.currentStageIndex,
      fromStatus: 'running',
      toStatus: 'completed',
      reason: `hoàn tất rollout ${rollout.targetVersion} cho 100% user`,
      errorRate: null,
      sampleCount: null,
    },
  );
  return { ok: true, store: replaceTeamV17Rollout(store, next, now), error: '', rollout: next };
}

/** Cancel rollout draft/running/paused (không dùng cho completed/rolled-back). */
export function cancelTeamV17Rollout(
  store: TeamV17RolloutStore,
  rolloutId: string,
  actorUserId: string,
  reason: string,
  now = Date.now(),
): TeamV17RolloutResult {
  const rollout = findTeamV17Rollout(store, rolloutId);
  if (!rollout) return failRollout(store, `không có rollout ${rolloutId}`);
  if (rollout.status === 'completed' || rollout.status === 'rolled-back' || rollout.status === 'cancelled') {
    return failRollout(store, `không cancel được rollout ${rollout.status}`);
  }
  let next = appendTeamV17History(
    { ...rollout, status: 'cancelled' },
    {
      at: now,
      actorUserId,
      action: 'cancel',
      fromStageIndex: rollout.currentStageIndex,
      toStageIndex: rollout.currentStageIndex,
      fromStatus: rollout.status,
      toStatus: 'cancelled',
      reason,
      errorRate: null,
      sampleCount: null,
    },
  );
  return { ok: true, store: replaceTeamV17Rollout(store, next, now), error: '', rollout: next };
}

// ---------------------------------------------------------------------------
// User có nhận version mới không + auto-rollback
// ---------------------------------------------------------------------------

/**
 * User có nhận version mới của rollout không? Chỉ khi rollout đang
 * running, user thuộc nhóm của stage hiện tại (hoặc nhóm `all`),
 * và hash bucket của user < percent của stage. `isUserInGroup`
 * do caller cung cấp (nhóm có thể là group v6 của multiUserV17
 * hoặc danh sách tĩnh) — mặc định mọi user đều thuộc `all`.
 */
export function teamV17UserInRollout(
  rollout: TeamV17Rollout,
  userId: string,
  isUserInGroup: (groupId: string, userId: string) => boolean = () => true,
): boolean {
  if (rollout.status !== 'running') return false;
  const stage = teamV17CurrentStage(rollout);
  if (!stage) return false;
  if (stage.groupId !== TEAM_V17_ROLLOUT_GROUP_ALL && !isUserInGroup(stage.groupId, userId)) return false;
  if (stage.percent >= 100) return true;
  if (stage.percent <= 0) return false;
  return teamV14UserBucket(rollout.id, userId) < stage.percent;
}

/** % hiệu lực của rollout tại thời điểm hiện tại (0 khi chưa start/draft). */
export function teamV17RolloutPercent(rollout: TeamV17Rollout): number {
  if (rollout.status !== 'running' && rollout.status !== 'paused') return 0;
  const stage = teamV17CurrentStage(rollout);
  return stage ? stage.percent : 0;
}

/** Một mẫu lỗi trong cửa sổ đánh giá. */
export interface TeamV17ErrorSample {
  at: number;
  /** true = lần gọi lỗi, false = thành công. */
  isError: boolean;
}

/** Số liệu error rate trong cửa sổ trượt (mẫu cũ hơn windowMs bị loại). */
export interface TeamV17ErrorWindowStats {
  total: number;
  errors: number;
  errorRate: number;
  consecutiveErrors: number;
}

export function teamV17ErrorWindowStats(
  samples: readonly TeamV17ErrorSample[],
  windowMs: number = TEAM_V17_ROLLOUT_ERROR_WINDOW_MS,
  now = Date.now(),
): TeamV17ErrorWindowStats {
  const inWindow = samples.filter((s) => s.at > now - windowMs && s.at <= now);
  let consecutive = 0;
  for (let i = inWindow.length - 1; i >= 0; i--) {
    if (inWindow[i].isError) consecutive += 1;
    else break;
  }
  const total = inWindow.length;
  const errors = inWindow.filter((s) => s.isError).length;
  return { total, errors, errorRate: total === 0 ? 0 : errors / total, consecutiveErrors: consecutive };
}

/** Quyết định auto: none | pause | rollback. */
export type TeamV17AutoAction = 'none' | 'pause' | 'rollback';

export interface TeamV17AutoDecision {
  action: TeamV17AutoAction;
  reason: string;
  errorRate: number;
  sampleCount: number;
  consecutiveErrors: number;
}

/**
 * Đánh giá auto-rollback/pause cho rollout đang running từ các mẫu
 * lỗi trong cửa sổ. Thứ tự: lỗi liên tiếp → rollback ngay; error
 * rate vượt ngưỡng rollback + đủ mẫu → rollback; vượt ngưỡng
 * pause + đủ mẫu → pause; còn lại none.
 */
export function evaluateTeamV17AutoRollback(
  rollout: TeamV17Rollout,
  samples: readonly TeamV17ErrorSample[],
  now = Date.now(),
): TeamV17AutoDecision {
  const stats = teamV17ErrorWindowStats(samples, TEAM_V17_ROLLOUT_ERROR_WINDOW_MS, now);
  if (stats.consecutiveErrors >= rollout.maxConsecutiveErrors) {
    return {
      action: 'rollback',
      reason: `${stats.consecutiveErrors} lỗi liên tiếp >= ${rollout.maxConsecutiveErrors}`,
      errorRate: stats.errorRate,
      sampleCount: stats.total,
      consecutiveErrors: stats.consecutiveErrors,
    };
  }
  if (stats.total >= rollout.minSamples && stats.errorRate >= rollout.rollbackErrorRate) {
    return {
      action: 'rollback',
      reason: `error rate ${(stats.errorRate * 100).toFixed(1)}% >= ngưỡng rollback ${(rollout.rollbackErrorRate * 100).toFixed(1)}% (${stats.errors}/${stats.total} mẫu)`,
      errorRate: stats.errorRate,
      sampleCount: stats.total,
      consecutiveErrors: stats.consecutiveErrors,
    };
  }
  if (stats.total >= rollout.minSamples && stats.errorRate >= rollout.pauseErrorRate) {
    return {
      action: 'pause',
      reason: `error rate ${(stats.errorRate * 100).toFixed(1)}% >= ngưỡng pause ${(rollout.pauseErrorRate * 100).toFixed(1)}% (${stats.errors}/${stats.total} mẫu)`,
      errorRate: stats.errorRate,
      sampleCount: stats.total,
      consecutiveErrors: stats.consecutiveErrors,
    };
  }
  return {
    action: 'none',
    reason: `error rate ${(stats.errorRate * 100).toFixed(1)}% trong ngưỡng (${stats.errors}/${stats.total} mẫu)`,
    errorRate: stats.errorRate,
    sampleCount: stats.total,
    consecutiveErrors: stats.consecutiveErrors,
  };
}

/**
 * Áp quyết định auto vào store: rollback → rolled-back (ghi history
 * `auto-rollback`), pause → paused (ghi `auto-pause`), none → giữ
 * nguyên. Chỉ áp dụng cho rollout đang running.
 */
export function applyTeamV17AutoDecision(
  store: TeamV17RolloutStore,
  rolloutId: string,
  decision: TeamV17AutoDecision,
  now = Date.now(),
): TeamV17RolloutResult {
  const rollout = findTeamV17Rollout(store, rolloutId);
  if (!rollout) return failRollout(store, `không có rollout ${rolloutId}`);
  if (decision.action === 'none') return { ok: true, store, error: '', rollout };
  if (rollout.status !== 'running') {
    return failRollout(store, `chỉ áp auto-decision cho rollout running (đang ${rollout.status})`);
  }
  const toStatus: TeamV17RolloutStatus = decision.action === 'rollback' ? 'rolled-back' : 'paused';
  const actionName = decision.action === 'rollback' ? 'auto-rollback' : 'auto-pause';
  let next = appendTeamV17History(
    { ...rollout, status: toStatus },
    {
      at: now,
      actorUserId: 'system:auto-rollback',
      action: actionName,
      fromStageIndex: rollout.currentStageIndex,
      toStageIndex: decision.action === 'rollback' ? -1 : rollout.currentStageIndex,
      fromStatus: 'running',
      toStatus,
      reason: decision.reason,
      errorRate: decision.errorRate,
      sampleCount: decision.sampleCount,
    },
  );
  return { ok: true, store: replaceTeamV17Rollout(store, next, now), error: '', rollout: next };
}

// ---------------------------------------------------------------------------
// Tóm tắt + persistence
// ---------------------------------------------------------------------------

/** Tóm tắt một rollout (để panel vẽ). */
export interface TeamV17RolloutSummary {
  id: string;
  name: string;
  targetVersion: string;
  previousVersion: string;
  status: TeamV17RolloutStatus;
  currentStage: string | null;
  currentPercent: number;
  stageIndex: number;
  stageCount: number;
  dwellSatisfied: boolean;
  historyCount: number;
  lastAction: string | null;
  lastActionAt: number | null;
}

export function summarizeTeamV17Rollout(rollout: TeamV17Rollout, now = Date.now()): TeamV17RolloutSummary {
  const stage = teamV17CurrentStage(rollout);
  const last = rollout.history[rollout.history.length - 1] ?? null;
  return {
    id: rollout.id,
    name: rollout.name,
    targetVersion: rollout.targetVersion,
    previousVersion: rollout.previousVersion,
    status: rollout.status,
    currentStage: stage ? stage.name : null,
    currentPercent: teamV17RolloutPercent(rollout),
    stageIndex: rollout.currentStageIndex,
    stageCount: rollout.stages.length,
    dwellSatisfied: teamV17StageDwellSatisfied(rollout, now),
    historyCount: rollout.history.length,
    lastAction: last ? last.action : null,
    lastActionAt: last ? last.at : null,
  };
}

/** Tóm tắt toàn store rollout. */
export interface TeamV17RolloutStoreSummary {
  total: number;
  byStatus: Record<TeamV17RolloutStatus, number>;
  running: TeamV17RolloutSummary[];
}

export function summarizeTeamV17RolloutStore(store: TeamV17RolloutStore, now = Date.now()): TeamV17RolloutStoreSummary {
  const byStatus = Object.fromEntries(TEAM_V17_ROLLOUT_STATUSES.map((s) => [s, 0])) as Record<TeamV17RolloutStatus, number>;
  for (const r of store.rollouts) byStatus[r.status] += 1;
  return {
    total: store.rollouts.length,
    byStatus,
    running: store.rollouts.filter((r) => r.status === 'running').map((r) => summarizeTeamV17Rollout(r, now)),
  };
}

/** Lưu store xuống file trong team root. */
export function saveTeamV17Rollouts(teamRoot: string, store: TeamV17RolloutStore): void {
  fs.mkdirSync(teamRoot, { recursive: true });
  fs.writeFileSync(path.join(teamRoot, TEAM_V17_ROLLOUTS_FILE), `${JSON.stringify(store, null, 2)}\n`, 'utf8');
}

/** Đọc store từ file (null khi chưa có / file hỏng). */
export function loadTeamV17Rollouts(teamRoot: string): TeamV17RolloutStore | null {
  try {
    const raw = fs.readFileSync(path.join(teamRoot, TEAM_V17_ROLLOUTS_FILE), 'utf8');
    const parsed = JSON.parse(raw) as TeamV17RolloutStore;
    if (!parsed || parsed.version !== TEAM_V17_ROLLOUT_STATE_VERSION || !Array.isArray(parsed.rollouts)) return null;
    return parsed;
  } catch {
    return null;
  }
}

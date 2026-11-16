/**
 * Fleet rollout v11 — triển khai theo nhóm: canary → nhóm nhỏ → toàn fleet (v1.14, Đội T6).
 *
 * Tầng trên của fleet v7 (`fleetV7Campaign.ts` — rollout theo BOT trên nhiều
 * NODE) và fleet v10 (`fleetV10Dashboard.ts` — điều khiển agent từ xa +
 * dashboard). Campaign v7 triển khai "cái gì chạy ở đâu"; module này trả
 * lời "triển khai theo thứ tự nào, khi nào được mở rộng, khi nào phải
 * lùi lại".
 *
 * - Nhóm rollout: mỗi rollout có danh sách nhóm theo thứ tự (vd `canary`
 *   1 node → `pilot` 10% → `all` toàn fleet). Mỗi nhóm có danh sách
 *   target (node/bot id) + trạng thái riêng (pending → active → done /
 *   failed / rolled-back). Nhóm sau chỉ mở khi nhóm trước xong.
 * - Máy trạng thái rollout (hàm thuần): `draft -> canary -> expanding ->
 *   complete`, `paused` (tạm dừng ở bất kỳ giai đoạn đang chạy nào, rồi
 *   `resume`), `rolled-back` (kết thúc, chỉ đi từ trạng thái đang chạy
 *   hoặc paused). Chuyển đổi không hợp lệ bị từ chối kèm lý do rõ ràng.
 * - Gate mở rộng: `checkFleetV11RolloutGate` — nhóm chỉ được mở rộng khi
 *   (a) nhóm trước done, (b) tỉ lệ lỗi trong nhóm hiện tại dưới ngưỡng,
 *   (c) không có alert critical đang mở trên target của nhóm, (d) đủ
 *   node/bot healthy trong nhóm tiếp theo. Gate trả về từng điều kiện
 *   riêng lẻ để UI vẽ rõ lý do chặn.
 * - Auto-rollback: `decideFleetV11AutoRollback` — khi tỉ lệ lỗi của nhóm
 *   đang chạy vượt ngưỡng, hoặc số target down vượt ngưỡng, thì đề xuất
 *   rollback (kèm lý do + số liệu). Module chỉ ĐỀ XUẤT; việc rollback
 *   thật do caller gọi `applyFleetV11RolloutAction('rollback', ...)`.
 * - Bền vững: tất cả rollout lưu trong
 *   `<fleetRoot>/fleet-rollouts-v114.json` (atomic tmp + rename, mode
 *   0600); mỗi lần chuyển trạng thái ghi một entry vào history của
 *   rollout (actor + lý do + thời điểm) để audit.
 *
 * Module này KHÔNG chạm mạng, KHÔNG spawn process, KHÔNG tự triển khai
 * thật lên node: nó quyết định "nhóm nào, khi nào, lùi hay tiến" — việc
 * đẩy config/code thật do FleetServiceManager / caller làm.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

/** File lưu rollout v11 trong fleet root. */
export const FLEET_V11_ROLLOUTS_FILE = 'fleet-rollouts-v114.json';
/** Tỉ lệ lỗi tối đa cho phép trong nhóm trước khi gate chặn mở rộng (mặc định). */
export const FLEET_V11_DEFAULT_MAX_ERROR_RATE = 0.05;
/** Tỉ lệ lỗi vượt ngưỡng này thì đề xuất auto-rollback (mặc định). */
export const FLEET_V11_DEFAULT_ROLLBACK_ERROR_RATE = 0.2;
/** Số target down tối đa cho phép trước khi đề xuất rollback (mặc định). */
export const FLEET_V11_DEFAULT_MAX_DOWN_TARGETS = 2;
/** Số rollout tối đa lưu trong file. */
export const FLEET_V11_MAX_ROLLOUTS = 100;
/** Số nhóm tối đa trong một rollout. */
export const FLEET_V11_MAX_GROUPS = 10;
/** Số target tối đa trong một nhóm. */
export const FLEET_V11_MAX_TARGETS_PER_GROUP = 500;

/** Giai đoạn của một rollout. */
export type FleetV11RolloutStage =
  | 'draft'
  | 'canary'
  | 'expanding'
  | 'paused'
  | 'complete'
  | 'rolled-back';

export const FLEET_V11_ROLLOUT_STAGES: readonly FleetV11RolloutStage[] = [
  'draft',
  'canary',
  'expanding',
  'paused',
  'complete',
  'rolled-back',
];

/** Trạng thái của một nhóm trong rollout. */
export type FleetV11GroupStatus = 'pending' | 'active' | 'done' | 'failed' | 'rolled-back';

export const FLEET_V11_GROUP_STATUSES: readonly FleetV11GroupStatus[] = [
  'pending',
  'active',
  'done',
  'failed',
  'rolled-back',
];

/** Hành động điều khiển rollout. */
export type FleetV11RolloutAction =
  | 'start'
  | 'advance'
  | 'pause'
  | 'resume'
  | 'complete'
  | 'rollback';

export const FLEET_V11_ROLLOUT_ACTIONS: readonly FleetV11RolloutAction[] = [
  'start',
  'advance',
  'pause',
  'resume',
  'complete',
  'rollback',
];

/** Chuyển đổi trạng thái hợp lệ của máy trạng thái rollout. */
export const FLEET_V11_ROLLOUT_TRANSITIONS: Record<
  FleetV11RolloutStage,
  readonly FleetV11RolloutAction[]
> = {
  draft: ['start', 'rollback'],
  canary: ['advance', 'pause', 'complete', 'rollback'],
  expanding: ['advance', 'pause', 'complete', 'rollback'],
  paused: ['resume', 'rollback', 'complete'],
  complete: [],
  'rolled-back': [],
};

/** Một nhóm target trong rollout. */
export interface FleetV11RolloutGroup {
  /** Tên nhóm (vd `canary`, `pilot`, `all`). Duy nhất trong rollout. */
  name: string;
  /** Target của nhóm: node id hoặc bot id (tùy `targetKind`). */
  targets: string[];
  status: FleetV11GroupStatus;
  /** Epoch ms bắt đầu nhóm (null = chưa bắt đầu). */
  startedAt: number | null;
  /** Epoch ms xong nhóm (null = chưa xong). */
  finishedAt: number | null;
  /** Số target đã áp dụng xong trong nhóm. */
  appliedCount: number;
  /** Số target lỗi trong nhóm. */
  errorCount: number;
}

/** Một entry history của rollout (audit). */
export interface FleetV11RolloutHistoryEntry {
  at: number;
  action: FleetV11RolloutAction | 'create' | 'gate-blocked' | 'auto-rollback-suggested';
  fromStage: FleetV11RolloutStage;
  toStage: FleetV11RolloutStage;
  actorUserId: string;
  reason: string;
  detail?: string;
}

/** Một rollout. */
export interface FleetV11Rollout {
  id: string;
  name: string;
  /** Mô tả ngắn: triển khai cái gì. */
  description: string;
  /** Loại target: node hay bot. */
  targetKind: 'node' | 'bot';
  /** Tên tính năng/config được triển khai (vd tên feature flag). */
  feature: string;
  /** Version của tính năng/config (vd `2.4.0`). */
  version: string;
  /** Version đang chạy trước rollout (để rollback về). */
  previousVersion: string;
  stage: FleetV11RolloutStage;
  groups: FleetV11RolloutGroup[];
  /** Chỉ số nhóm đang active (null = chưa bắt đầu / đã xong). */
  activeGroupIndex: number | null;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
  history: FleetV11RolloutHistoryEntry[];
}

/** Input tạo rollout (chưa có id/stage/history). */
export interface CreateFleetV11RolloutInput {
  name: string;
  description?: string;
  targetKind: 'node' | 'bot';
  feature: string;
  version: string;
  previousVersion: string;
  /** Nhóm theo thứ tự triển khai: [{name, targets}]. Ít nhất 1 nhóm. */
  groups: { name: string; targets: string[] }[];
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
 * Validate input tạo rollout. Trả về danh sách lỗi (rỗng = hợp lệ).
 * Nhóm `all` (nếu có) phải là nhóm cuối cùng — triển khai toàn fleet
 * không được đi trước canary.
 */
export function validateFleetV11RolloutInput(input: CreateFleetV11RolloutInput): string[] {
  const errors: string[] = [];
  if (!isNonEmptyString(input?.name)) errors.push('tên rollout không được trống');
  if (!isNonEmptyString(input?.feature)) errors.push('tên tính năng không được trống');
  if (!isNonEmptyString(input?.version)) errors.push('version triển khai không được trống');
  if (!isNonEmptyString(input?.previousVersion)) errors.push('previousVersion không được trống');
  if (input?.targetKind !== 'node' && input?.targetKind !== 'bot') {
    errors.push('targetKind phải là node hoặc bot');
  }
  if (!isNonEmptyString(input?.createdBy)) errors.push('createdBy không được trống');
  if (!Array.isArray(input?.groups) || input.groups.length === 0) {
    errors.push('rollout cần ít nhất 1 nhóm');
    return errors;
  }
  if (input.groups.length > FLEET_V11_MAX_GROUPS) {
    errors.push(`tối đa ${FLEET_V11_MAX_GROUPS} nhóm`);
  }
  const seenNames = new Set<string>();
  const seenTargets = new Set<string>();
  input.groups.forEach((g, i) => {
    if (!isNonEmptyString(g?.name)) {
      errors.push(`nhóm ${i + 1}: tên không được trống`);
      return;
    }
    const slug = slugifyName(g.name);
    if (seenNames.has(slug)) errors.push(`nhóm ${i + 1}: tên nhóm "${g.name}" bị trùng`);
    seenNames.add(slug);
    if (!Array.isArray(g.targets) || g.targets.length === 0) {
      errors.push(`nhóm "${g.name}": cần ít nhất 1 target`);
      return;
    }
    if (g.targets.length > FLEET_V11_MAX_TARGETS_PER_GROUP) {
      errors.push(`nhóm "${g.name}": tối đa ${FLEET_V11_MAX_TARGETS_PER_GROUP} target`);
    }
    for (const t of g.targets) {
      if (!isNonEmptyString(t)) {
        errors.push(`nhóm "${g.name}": target không được trống`);
        continue;
      }
      if (seenTargets.has(t)) errors.push(`target "${t}" xuất hiện ở nhiều nhóm`);
      seenTargets.add(t);
    }
  });
  const allIdx = input.groups.findIndex((g) => slugifyName(g?.name ?? '') === 'all');
  if (allIdx >= 0 && allIdx !== input.groups.length - 1) {
    errors.push('nhóm "all" (toàn fleet) phải là nhóm cuối cùng');
  }
  return errors;
}

export function createFleetV11Rollout(
  input: CreateFleetV11RolloutInput,
  now = Date.now(),
): FleetV11Rollout {
  const errors = validateFleetV11RolloutInput(input);
  if (errors.length > 0) {
    throw new Error(`rollout không hợp lệ: ${errors.join('; ')}`);
  }
  const id = `ro-${slugifyName(input.name)}-${now.toString(36)}`;
  return {
    id,
    name: input.name.trim(),
    description: input.description?.trim() ?? '',
    targetKind: input.targetKind,
    feature: input.feature.trim(),
    version: input.version.trim(),
    previousVersion: input.previousVersion.trim(),
    stage: 'draft',
    groups: input.groups.map((g) => ({
      name: g.name.trim(),
      targets: [...g.targets],
      status: 'pending' as FleetV11GroupStatus,
      startedAt: null,
      finishedAt: null,
      appliedCount: 0,
      errorCount: 0,
    })),
    activeGroupIndex: null,
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

/** Kết quả áp dụng một hành động lên rollout (hàm thuần). */
export type FleetV11RolloutActionResult =
  | { ok: true; rollout: FleetV11Rollout }
  | { ok: false; rollout: FleetV11Rollout; error: string };

function withHistory(
  rollout: FleetV11Rollout,
  action: FleetV11RolloutAction,
  fromStage: FleetV11RolloutStage,
  toStage: FleetV11RolloutStage,
  actorUserId: string,
  reason: string,
  now: number,
): FleetV11Rollout {
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

function fail(rollout: FleetV11Rollout, error: string): FleetV11RolloutActionResult {
  return { ok: false, rollout, error };
}

/**
 * Áp dụng một hành động điều khiển rollout (hàm thuần, không mutate).
 * - start: draft -> canary, kích hoạt nhóm đầu tiên.
 * - advance: nhóm active -> done, kích hoạt nhóm tiếp theo; hết nhóm thì
 *   -> complete. Chỉ hợp lệ khi nhóm active đã done đủ điều kiện (caller
 *   kiểm tra gate trước; hàm này chỉ kiểm tra máy trạng thái + nhóm
 *   active đã được đánh done qua `markFleetV11GroupDone` hoặc applied
 *   hết target).
 * - pause/resume: tạm dừng / tiếp tục.
 * - complete: kết thúc sớm (nhóm active hiện tại được đánh done).
 * - rollback: tất cả nhóm active/done -> rolled-back, stage -> rolled-back.
 */
export function applyFleetV11RolloutAction(
  rollout: FleetV11Rollout,
  action: FleetV11RolloutAction,
  actorUserId: string,
  reason: string,
  now = Date.now(),
): FleetV11RolloutActionResult {
  if (!isNonEmptyString(actorUserId)) return fail(rollout, 'actorUserId không được trống');
  if (!isNonEmptyString(reason)) return fail(rollout, 'reason không được trống');
  const allowed = FLEET_V11_ROLLOUT_TRANSITIONS[rollout.stage] ?? [];
  if (!allowed.includes(action)) {
    return fail(rollout, `không thể ${action} rollout đang ở giai đoạn ${rollout.stage}`);
  }
  const fromStage = rollout.stage;
  if (action === 'start') {
    const groups = rollout.groups.map((g, i) =>
      i === 0
        ? { ...g, status: 'active' as FleetV11GroupStatus, startedAt: now }
        : g,
    );
    return {
      ok: true,
      rollout: withHistory(
        { ...rollout, groups, activeGroupIndex: 0 },
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
    const idx = rollout.activeGroupIndex;
    if (idx === null || !rollout.groups[idx]) {
      return fail(rollout, 'không có nhóm đang active để mở rộng');
    }
    const active = rollout.groups[idx];
    if (active.status !== 'done') {
      return fail(
        rollout,
        `nhóm "${active.name}" chưa xong (trạng thái ${active.status}) — đánh dấu xong trước khi mở rộng`,
      );
    }
    const nextIdx = idx + 1;
    if (nextIdx >= rollout.groups.length) {
      return {
        ok: true,
        rollout: withHistory(
          { ...rollout, activeGroupIndex: null },
          action,
          fromStage,
          'complete',
          actorUserId,
          reason,
          now,
        ),
      };
    }
    const groups = rollout.groups.map((g, i) =>
      i === nextIdx
        ? { ...g, status: 'active' as FleetV11GroupStatus, startedAt: now }
        : g,
    );
    return {
      ok: true,
      rollout: withHistory(
        { ...rollout, groups, activeGroupIndex: nextIdx },
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
    // Quay lại giai đoạn trước khi pause: canary nếu đang ở nhóm đầu, expanding nếu sau.
    const toStage: FleetV11RolloutStage =
      rollout.activeGroupIndex === 0 || rollout.activeGroupIndex === null
        ? 'canary'
        : 'expanding';
    return {
      ok: true,
      rollout: withHistory(rollout, action, fromStage, toStage, actorUserId, reason, now),
    };
  }
  if (action === 'complete') {
    const groups = rollout.groups.map((g) =>
      g.status === 'active' ? { ...g, status: 'done' as FleetV11GroupStatus, finishedAt: now } : g,
    );
    return {
      ok: true,
      rollout: withHistory(
        { ...rollout, groups, activeGroupIndex: null },
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
  const groups = rollout.groups.map((g) =>
    g.status === 'active' || g.status === 'done'
      ? { ...g, status: 'rolled-back' as FleetV11GroupStatus, finishedAt: now }
      : g,
  );
  return {
    ok: true,
    rollout: withHistory(
      { ...rollout, groups, activeGroupIndex: null },
      action,
      fromStage,
      'rolled-back',
      actorUserId,
      reason,
      now,
    ),
  };
}

/**
 * Đánh dấu nhóm active đã xong (applied hết target, errorCount đã cập
 * nhật qua `recordFleetV11GroupProgress`). Nhóm xong thì status = done
 * (errorCount > 0 vẫn done — lỗi lẻ được theo dõi ở gate; chỉ khi lỗi
 * vượt ngưỡng thì gate chặn advance). Trả về rollout mới.
 */
export function markFleetV11GroupDone(
  rollout: FleetV11Rollout,
  groupName: string,
  now = Date.now(),
): FleetV11Rollout {
  const groups = rollout.groups.map((g) =>
    g.name === groupName && g.status === 'active'
      ? { ...g, status: 'done' as FleetV11GroupStatus, finishedAt: now }
      : g,
  );
  return { ...rollout, groups, updatedAt: now };
}

/**
 * Cập nhật tiến độ áp dụng của một nhóm (số target đã áp dụng / lỗi).
 * Số âm hoặc vượt tổng target đều bị kẹp về khoảng hợp lệ.
 */
export function recordFleetV11GroupProgress(
  rollout: FleetV11Rollout,
  groupName: string,
  appliedCount: number,
  errorCount: number,
  now = Date.now(),
): FleetV11Rollout {
  const groups = rollout.groups.map((g) => {
    if (g.name !== groupName) return g;
    const total = g.targets.length;
    return {
      ...g,
      appliedCount: Math.max(0, Math.min(total, Math.floor(appliedCount))),
      errorCount: Math.max(0, Math.min(total, Math.floor(errorCount))),
    };
  });
  return { ...rollout, groups, updatedAt: now };
}

/** Tỉ lệ lỗi của một nhóm (0 khi chưa áp dụng target nào). */
export function fleetV11GroupErrorRate(group: FleetV11RolloutGroup): number {
  const total = group.appliedCount + group.errorCount;
  if (total <= 0) return 0;
  return group.errorCount / total;
}

/** Một điều kiện gate (mở rộng rollout sang nhóm tiếp theo). */
export interface FleetV11GateCheck {
  name: string;
  passed: boolean;
  detail: string;
}

/** Kết quả kiểm tra gate mở rộng. */
export interface FleetV11GateResult {
  allowed: boolean;
  checks: FleetV11GateCheck[];
  /** Nhóm tiếp theo sẽ được kích hoạt (null = hết nhóm, advance sẽ complete). */
  nextGroupName: string | null;
}

/** Đầu vào cho gate: alert critical + trạng thái target của nhóm tiếp theo. */
export interface FleetV11GateInput {
  /** Id các target của nhóm tiếp theo đang có alert critical. */
  criticalAlertTargetIds: string[];
  /** Id các target của nhóm tiếp theo đang healthy (đủ điều kiện nhận rollout). */
  healthyTargetIds: string[];
  /** Tỉ lệ lỗi tối đa cho phép (mặc định FLEET_V11_DEFAULT_MAX_ERROR_RATE). */
  maxErrorRate?: number;
}

/**
 * Kiểm tra gate mở rộng rollout sang nhóm tiếp theo (hàm thuần):
 * nhóm active phải done, tỉ lệ lỗi nhóm active dưới ngưỡng, không có
 * alert critical trên target nhóm tiếp theo, và ít nhất một nửa target
 * nhóm tiếp theo đang healthy. Hết nhóm thì gate "allowed" với
 * nextGroupName = null (advance sẽ complete rollout).
 */
export function checkFleetV11RolloutGate(
  rollout: FleetV11Rollout,
  input: FleetV11GateInput,
): FleetV11GateResult {
  const checks: FleetV11GateCheck[] = [];
  const idx = rollout.activeGroupIndex;
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
      nextGroupName: null,
    };
  }
  if (idx === null || !rollout.groups[idx]) {
    checks.push({ name: 'active-group', passed: false, detail: 'không có nhóm đang active' });
    return { allowed: false, checks, nextGroupName: null };
  }
  const active = rollout.groups[idx];
  const maxErrorRate =
    typeof input.maxErrorRate === 'number' && Number.isFinite(input.maxErrorRate)
      ? Math.max(0, Math.min(1, input.maxErrorRate))
      : FLEET_V11_DEFAULT_MAX_ERROR_RATE;
  const errorRate = fleetV11GroupErrorRate(active);
  checks.push({
    name: 'group-done',
    passed: active.status === 'done',
    detail:
      active.status === 'done'
        ? `nhóm "${active.name}" đã xong`
        : `nhóm "${active.name}" chưa xong (trạng thái ${active.status})`,
  });
  checks.push({
    name: 'error-rate',
    passed: errorRate <= maxErrorRate,
    detail: `tỉ lệ lỗi nhóm "${active.name}" là ${(errorRate * 100).toFixed(1)}% (ngưỡng ${(maxErrorRate * 100).toFixed(1)}%)`,
  });
  const nextIdx = idx + 1;
  if (nextIdx >= rollout.groups.length) {
    checks.push({ name: 'next-group', passed: true, detail: 'đã hết nhóm — advance sẽ hoàn tất rollout' });
    return { allowed: checks.every((c) => c.passed), checks, nextGroupName: null };
  }
  const next = rollout.groups[nextIdx];
  const criticalOnNext = next.targets.filter((t) => input.criticalAlertTargetIds.includes(t));
  checks.push({
    name: 'no-critical-alert',
    passed: criticalOnNext.length === 0,
    detail:
      criticalOnNext.length === 0
        ? `không có alert nghiêm trọng trên nhóm "${next.name}"`
        : `${criticalOnNext.length} target nhóm "${next.name}" đang có alert nghiêm trọng: ${criticalOnNext.slice(0, 5).join(', ')}`,
  });
  const healthyCount = next.targets.filter((t) => input.healthyTargetIds.includes(t)).length;
  const needHealthy = Math.ceil(next.targets.length / 2);
  checks.push({
    name: 'next-group-healthy',
    passed: healthyCount >= needHealthy,
    detail: `${healthyCount}/${next.targets.length} target nhóm "${next.name}" đang healthy (cần ít nhất ${needHealthy})`,
  });
  return { allowed: checks.every((c) => c.passed), checks, nextGroupName: next.name };
}

/** Đề xuất auto-rollback (chỉ đề xuất, không tự thực hiện). */
export interface FleetV11AutoRollbackDecision {
  shouldRollback: boolean;
  reasons: string[];
  errorRate: number;
  downTargets: number;
}

/**
 * Quyết định có nên đề xuất rollback không: tỉ lệ lỗi nhóm active vượt
 * ngưỡng rollback, hoặc số target down trong nhóm active vượt ngưỡng.
 * Bot/node stopped chủ đích không tính là down ở đây — caller chỉ đưa
 * target thật sự down vào `downTargetIds`.
 */
export function decideFleetV11AutoRollback(
  rollout: FleetV11Rollout,
  downTargetIds: string[],
  opts?: { rollbackErrorRate?: number; maxDownTargets?: number },
): FleetV11AutoRollbackDecision {
  const reasons: string[] = [];
  const idx = rollout.activeGroupIndex;
  let errorRate = 0;
  if (idx !== null && rollout.groups[idx]) {
    errorRate = fleetV11GroupErrorRate(rollout.groups[idx]);
  }
  const rollbackErrorRate =
    typeof opts?.rollbackErrorRate === 'number' && Number.isFinite(opts.rollbackErrorRate)
      ? Math.max(0, Math.min(1, opts.rollbackErrorRate))
      : FLEET_V11_DEFAULT_ROLLBACK_ERROR_RATE;
  const maxDownTargets =
    typeof opts?.maxDownTargets === 'number' && Number.isFinite(opts.maxDownTargets)
      ? Math.max(0, Math.floor(opts.maxDownTargets))
      : FLEET_V11_DEFAULT_MAX_DOWN_TARGETS;
  const activeTargets = idx !== null && rollout.groups[idx] ? rollout.groups[idx].targets : [];
  const downTargets = activeTargets.filter((t) => downTargetIds.includes(t)).length;
  if (rollout.stage !== 'canary' && rollout.stage !== 'expanding') {
    return { shouldRollback: false, reasons: [`rollout không đang chạy (giai đoạn ${rollout.stage})`], errorRate, downTargets };
  }
  if (errorRate > rollbackErrorRate) {
    reasons.push(
      `tỉ lệ lỗi ${(errorRate * 100).toFixed(1)}% vượt ngưỡng rollback ${(rollbackErrorRate * 100).toFixed(1)}%`,
    );
  }
  if (downTargets > maxDownTargets) {
    reasons.push(`${downTargets} target down, vượt ngưỡng ${maxDownTargets}`);
  }
  return { shouldRollback: reasons.length > 0, reasons, errorRate, downTargets };
}

/** Tiến độ tổng của rollout (0–1) + tóm tắt cho UI. */
export interface FleetV11RolloutProgress {
  /** Số target đã áp dụng (done + active) / tổng target. */
  applied: number;
  errors: number;
  total: number;
  /** 0–1. */
  fraction: number;
  activeGroupName: string | null;
  doneGroups: number;
  totalGroups: number;
  summary: string;
}

export function summarizeFleetV11Rollout(rollout: FleetV11Rollout): FleetV11RolloutProgress {
  const total = rollout.groups.reduce((a, g) => a + g.targets.length, 0);
  const applied = rollout.groups.reduce((a, g) => a + g.appliedCount, 0);
  const errors = rollout.groups.reduce((a, g) => a + g.errorCount, 0);
  const doneGroups = rollout.groups.filter((g) => g.status === 'done').length;
  const active =
    rollout.activeGroupIndex !== null ? rollout.groups[rollout.activeGroupIndex] : undefined;
  const fraction = total > 0 ? applied / total : 0;
  const summary =
    rollout.stage === 'complete'
      ? `Rollout "${rollout.name}" hoàn tất: ${applied}/${total} target, ${errors} lỗi.`
      : rollout.stage === 'rolled-back'
        ? `Rollout "${rollout.name}" đã rollback về ${rollout.previousVersion}.`
        : rollout.stage === 'draft'
          ? `Rollout "${rollout.name}" đang nháp: ${total} target qua ${rollout.groups.length} nhóm.`
          : `Rollout "${rollout.name}" đang ở nhóm "${active?.name ?? '?'}" (${doneGroups}/${rollout.groups.length} nhóm xong): ${applied}/${total} target, ${errors} lỗi.`;
  return {
    applied,
    errors,
    total,
    fraction,
    activeGroupName: active?.name ?? null,
    doneGroups,
    totalGroups: rollout.groups.length,
    summary,
  };
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

export function getFleetV11RolloutsPath(fleetRoot: string): string {
  return path.join(fleetRoot, FLEET_V11_ROLLOUTS_FILE);
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

function isValidRollout(v: unknown): v is FleetV11Rollout {
  if (!v || typeof v !== 'object') return false;
  const r = v as Partial<FleetV11Rollout>;
  return (
    typeof r.id === 'string' &&
    typeof r.name === 'string' &&
    typeof r.feature === 'string' &&
    typeof r.version === 'string' &&
    Array.isArray(r.groups) &&
    FLEET_V11_ROLLOUT_STAGES.includes(r.stage as FleetV11RolloutStage)
  );
}

export function loadFleetV11Rollouts(fleetRoot: string): FleetV11Rollout[] {
  try {
    const raw = fs.readFileSync(getFleetV11RolloutsPath(fleetRoot), 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isValidRollout);
  } catch {
    return [];
  }
}

export function saveFleetV11Rollouts(fleetRoot: string, rollouts: FleetV11Rollout[]): void {
  atomicWriteFile(
    getFleetV11RolloutsPath(fleetRoot),
    `${JSON.stringify(rollouts.slice(0, FLEET_V11_MAX_ROLLOUTS), null, 2)}\n`,
  );
}

export function findFleetV11Rollout(rollouts: FleetV11Rollout[], id: string): FleetV11Rollout | null {
  return rollouts.find((r) => r.id === id) ?? null;
}

/**
 * Thêm rollout mới vào danh sách (id trùng thì không thêm, trả về danh
 * sách cũ). Trả về danh sách mới, mới nhất trước.
 */
export function addFleetV11Rollout(
  rollouts: FleetV11Rollout[],
  rollout: FleetV11Rollout,
): FleetV11Rollout[] {
  if (rollouts.some((r) => r.id === rollout.id)) return rollouts;
  return [rollout, ...rollouts].slice(0, FLEET_V11_MAX_ROLLOUTS);
}

/** Thay rollout đã có bằng bản mới (id không tồn tại thì trả về cũ). */
export function updateFleetV11Rollout(
  rollouts: FleetV11Rollout[],
  rollout: FleetV11Rollout,
): FleetV11Rollout[] {
  if (!rollouts.some((r) => r.id === rollout.id)) return rollouts;
  return rollouts.map((r) => (r.id === rollout.id ? rollout : r));
}

/**
 * Rollout v4 — rollout theo fleet node, approve step, history mở rộng
 * (v1.18, Đội T6).
 *
 * Tầng trên của rollout v3 (`fleetV14/rolloutV14.ts` — stage linh
 * hoạt + dwell, nhóm user theo role/explicit/hash-bucket, auto
 * pause/rollback theo ngưỡng lỗi). V3 trả lời "user nào nhận tính
 * năng, khi nào dừng/lùi"; v4 trả lời 3 câu còn thiếu để rollout
 * chạy thật trên fleet nhiều máy:
 *
 * - ROLLOUT THEO NODE: ngoài cohort theo user, rollout còn nhắm
 *   tới node — `all-nodes` (mọi node), `label-selector` (node khớp
 *   label, vd `region=home`), `node-ids` (danh sách node tường
 *   minh). Một node chỉ nhận version mới khi node đó thuộc target
 *   VÀ user trên node đó thuộc cohort v3 (cả hai lớp lọc đều phải
 *   qua). Trạng thái từng node (đang chạy version nào, stage nào)
 *   được theo dõi riêng để panel vẽ "node A đã lên v2, node B còn
 *   v1".
 * - APPROVE STEP: mỗi lần advance sang stage kế tiếp cần đủ số
 *   approve của admin/owner (mặc định 1 approve cho canary/pilot,
 *   2 approve từ stage `early` trở đi — cấu hình được). Approve
 *   trùng người bị từ chối (2 approve phải là 2 người khác nhau);
 *   approve chỉ có hiệu lực cho đúng stage đích đó (advance xong
 *   thì approve cũ hết hiệu lực, stage sau cần approve mới).
 *   Rollback thủ công KHÔNG cần approve (an toàn trước đã).
 * - HISTORY MỞ RỘNG: history v3 (stage chuyển + metric) được giữ
 *   nguyên; v4 thêm nhật ký approve (ai approve, khi nào, ghi chú)
 *   và nhật ký theo node (node nào đổi version khi nào) — gộp lại
 *   thành timeline duy nhất, sắp xếp theo thời gian, để UI vẽ
 *   "toàn bộ câu chuyện của rollout này".
 *
 * Module này KHÔNG chạm mạng, KHÔNG tự bật flag thật lên user hay
 * node: nó quyết định "node nào, cần mấy approve, dừng hay lùi" —
 * việc bật flag / deploy version thật do caller làm theo cohort và
 * node-status trả về.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { FleetV14Node } from '../fleetV14/fleetV14';
import type {
  TeamV14AutoAction,
  TeamV14AutoDecision,
  TeamV14GateResult,
  TeamV14Rollout,
  TeamV14RolloutMetrics,
  TeamV14RolloutStage,
  TeamV14TransitionResult,
} from '../fleetV14/rolloutV14';
import {
  advanceTeamV14Rollout,
  applyTeamV14AutoRollback,
  createTeamV14Rollout,
  decideTeamV14AutoAction,
  evaluateTeamV14HealthGate,
  rollbackTeamV14Rollout,
  summarizeTeamV14Rollout,
  teamV14NextStage,
  teamV14StagePercent,
  teamV14UserReceivesFeature,
} from '../fleetV14/rolloutV14';

/** File lưu rollout v4 trong team root. */
export const TEAM_V15_ROLLOUTS_FILE = 'rollouts-v118.json';
/** Số rollout tối đa lưu trong file. */
export const TEAM_V15_MAX_ROLLOUTS = 100;
/** Số approve-event tối đa giữ mỗi rollout. */
export const TEAM_V15_MAX_APPROVAL_EVENTS = 200;
/** Số node-status event tối đa giữ mỗi rollout. */
export const TEAM_V15_MAX_NODE_EVENTS = 500;
/** Số approve mặc định cho stage canary/pilot. */
export const TEAM_V15_DEFAULT_EARLY_APPROVALS = 1;
/** Số approve mặc định cho stage early trở đi. */
export const TEAM_V15_DEFAULT_LATE_APPROVALS = 2;

/** Cách rollout nhắm tới node. */
export type TeamV15NodeTargetKind = 'all-nodes' | 'label-selector' | 'node-ids';

export const TEAM_V15_NODE_TARGET_KINDS: readonly TeamV15NodeTargetKind[] = [
  'all-nodes',
  'label-selector',
  'node-ids',
];

/** Target node của rollout. */
export interface TeamV15NodeTarget {
  kind: TeamV15NodeTargetKind;
  /** kind=label-selector: node phải khớp TẤT CẢ label này. */
  labels: Record<string, string>;
  /** kind=node-ids: danh sách node id tường minh. */
  nodeIds: string[];
}

/** Target mặc định: mọi node. */
export function defaultTeamV15NodeTarget(): TeamV15NodeTarget {
  return { kind: 'all-nodes', labels: {}, nodeIds: [] };
}

/** Validate node target (trả lý do, '' = hợp lệ). */
export function validateTeamV15NodeTarget(target: TeamV15NodeTarget): string {
  if (!TEAM_V15_NODE_TARGET_KINDS.includes(target.kind)) {
    return `unknown node target kind: ${String(target.kind)}`;
  }
  if (target.kind === 'label-selector' && Object.keys(target.labels).length === 0) {
    return 'label-selector target needs at least one label';
  }
  if (target.kind === 'node-ids' && target.nodeIds.length === 0) {
    return 'node-ids target needs at least one node id';
  }
  if (new Set(target.nodeIds).size !== target.nodeIds.length) return 'nodeIds has duplicates';
  return '';
}

/** True khi một node thuộc target (bỏ qua node đã removed). */
export function teamV15NodeMatchesTarget(target: TeamV15NodeTarget, node: FleetV14Node): boolean {
  if (node.status === 'removed') return false;
  switch (target.kind) {
    case 'all-nodes':
      return true;
    case 'label-selector':
      return Object.entries(target.labels).every(([k, v]) => node.labels[k] === v);
    case 'node-ids':
      return target.nodeIds.includes(node.nodeId);
    default:
      return false;
  }
}

/** Một lần approve cho một stage đích cụ thể. */
export interface TeamV15Approval {
  approverUserId: string;
  approverRole: string;
  /** Stage đích mà approve này cấp cho (vd 'pilot'). */
  forStage: TeamV14RolloutStage;
  at: number;
  note: string;
}

/** Một sự kiện approve (ghi lại cả approve bị từ chối để audit). */
export interface TeamV15ApprovalEvent {
  at: number;
  approverUserId: string;
  approverRole: string;
  /** Stage đích mà approve này nhắm tới ('' = không có stage đích, vd rollout đã hoàn tất). */
  forStage: TeamV14RolloutStage | '';
  accepted: boolean;
  reason: string;
}

/** Trạng thái rollout của một node: đang chạy version nào. */
export interface TeamV15NodeRolloutStatus {
  nodeId: string;
  /** Version node đang chạy ('' = chưa nhận rollout). */
  version: string;
  stage: TeamV14RolloutStage;
  updatedAt: number;
  updatedBy: string;
}

/** Một sự kiện đổi version của node trong rollout. */
export interface TeamV15NodeEvent {
  at: number;
  nodeId: string;
  fromVersion: string;
  toVersion: string;
  actorUserId: string;
}

/** Một rollout v4: rollout v3 + target node + approve step + node status. */
export interface TeamV15Rollout {
  v14: TeamV14Rollout;
  nodeTarget: TeamV15NodeTarget;
  /** Số approve cần cho stage sớm (canary/pilot). */
  earlyApprovals: number;
  /** Số approve cần cho stage muộn (early trở đi). */
  lateApprovals: number;
  /** Approve đang hiệu lực (chỉ tính approve cho stage đích kế tiếp). */
  approvals: TeamV15Approval[];
  approvalEvents: TeamV15ApprovalEvent[];
  nodeStatus: TeamV15NodeRolloutStatus[];
  nodeEvents: TeamV15NodeEvent[];
}

/** Số approve cần để advance từ stage hiện tại sang stage kế tiếp. */
export function teamV15RequiredApprovals(
  rollout: TeamV15Rollout,
  fromStage: TeamV14RolloutStage = rollout.v14.stage,
): number {
  const next =
    fromStage === 'draft'
      ? (rollout.v14.plan[0]?.stage ?? '')
      : teamV14NextStage(rollout.v14.plan, fromStage);
  if (next === '') return 0;
  if (next === 'early' || next === 'general' || next === 'all') return rollout.lateApprovals;
  return rollout.earlyApprovals;
}

/** Stage đích kế tiếp của rollout (draft → stage đầu tiên của plan). */
export function teamV15NextStage(rollout: TeamV15Rollout): TeamV14RolloutStage | '' {
  if (rollout.v14.stage === 'draft') return rollout.v14.plan[0]?.stage ?? '';
  return teamV14NextStage(rollout.v14.plan, rollout.v14.stage);
}

/** Tạo rollout v4 mới ở stage draft (wrap create v3). */
export function createTeamV15Rollout(
  input: {
    id: string;
    feature: string;
    version: string;
    previousVersion: string;
    description?: string;
    plan?: TeamV14Rollout['plan'];
    groups?: TeamV14Rollout['groups'];
    thresholds?: Partial<TeamV14Rollout['thresholds']>;
    autoRollbackEnabled?: boolean;
    nodeTarget?: TeamV15NodeTarget;
    earlyApprovals?: number;
    lateApprovals?: number;
  },
  createdBy: string,
  now = Date.now(),
): TeamV15Rollout {
  const target = input.nodeTarget ?? defaultTeamV15NodeTarget();
  return {
    v14: createTeamV14Rollout(
      {
        id: input.id,
        feature: input.feature,
        version: input.version,
        previousVersion: input.previousVersion,
        description: input.description,
        plan: input.plan,
        groups: input.groups,
        thresholds: input.thresholds,
        autoRollbackEnabled: input.autoRollbackEnabled,
      },
      createdBy,
      now,
    ),
    nodeTarget: target,
    earlyApprovals: input.earlyApprovals ?? TEAM_V15_DEFAULT_EARLY_APPROVALS,
    lateApprovals: input.lateApprovals ?? TEAM_V15_DEFAULT_LATE_APPROVALS,
    approvals: [],
    approvalEvents: [],
    nodeStatus: [],
    nodeEvents: [],
  };
}

/** Validate cấu hình approve (số approve 0..5, early <= late không bắt buộc). */
export function validateTeamV15ApprovalConfig(rollout: TeamV15Rollout): string {
  if (!Number.isInteger(rollout.earlyApprovals) || rollout.earlyApprovals < 0 || rollout.earlyApprovals > 5) {
    return 'earlyApprovals must be an integer 0..5';
  }
  if (!Number.isInteger(rollout.lateApprovals) || rollout.lateApprovals < 0 || rollout.lateApprovals > 5) {
    return 'lateApprovals must be an integer 0..5';
  }
  return validateTeamV15NodeTarget(rollout.nodeTarget);
}

/**
 * Node có nhận version mới không? Node phải thuộc target VÀ (khi
 * có user đại diện) user đó thuộc cohort v3. Khi không truyền
 * userId thì chỉ kiểm tra lớp node.
 */
export function teamV15NodeReceivesFeature(
  rollout: TeamV15Rollout,
  node: FleetV14Node,
  userId?: string,
  userRole?: string,
): boolean {
  if (rollout.v14.stage === 'draft' || rollout.v14.stage === 'paused' || rollout.v14.stage === 'rolled-back') {
    return false;
  }
  if (!teamV15NodeMatchesTarget(rollout.nodeTarget, node)) return false;
  if (rollout.v14.stage === 'complete') return true;
  if (userId !== undefined) {
    return teamV14UserReceivesFeature(rollout.v14, userId, userRole ?? '');
  }
  return true;
}

/** Danh sách node thuộc target trong một snapshot node. */
export function teamV15TargetedNodes(
  rollout: TeamV15Rollout,
  nodes: readonly FleetV14Node[],
): FleetV14Node[] {
  return nodes.filter((n) => teamV15NodeMatchesTarget(rollout.nodeTarget, n));
}

// ---------------------------------------------------------------------------
// Approve step
// ---------------------------------------------------------------------------

/** Số approve còn hiệu lực cho stage đích kế tiếp (người khác nhau). */
export function teamV15ApprovalCount(rollout: TeamV15Rollout): number {
  const next = teamV15NextStage(rollout);
  if (next === '') return 0;
  const approvers = new Set(
    rollout.approvals.filter((a) => a.forStage === next).map((a) => a.approverUserId),
  );
  return approvers.size;
}

/** True khi đã đủ approve để advance. */
export function teamV15ApprovalsMet(rollout: TeamV15Rollout): boolean {
  return teamV15ApprovalCount(rollout) >= teamV15RequiredApprovals(rollout);
}

export interface TeamV15ApproveResult {
  ok: boolean;
  rollout: TeamV15Rollout;
  reason: string;
}

/**
 * Approve cho stage đích kế tiếp. Chỉ admin/owner (hoặc role có
 * quyền manage-rollout — caller kiểm tra) được approve; cùng một
 * người approve 2 lần chỉ tính 1; approve cho stage đã qua/khác
 * bị từ chối. Mọi lần gọi (kể cả bị từ chối) đều ghi approvalEvents
 * để audit.
 */
export function approveTeamV15Rollout(
  rollout: TeamV15Rollout,
  approverUserId: string,
  approverRole: string,
  note = '',
  now = Date.now(),
): TeamV15ApproveResult {
  const recordEvent = (accepted: boolean, reason: string): TeamV15ApprovalEvent => ({
    at: now,
    approverUserId,
    approverRole,
    forStage: teamV15NextStage(rollout),
    accepted,
    reason,
  });
  const withEvent = (event: TeamV15ApprovalEvent, approvals: TeamV15Approval[]): TeamV15Rollout => {
    const events = [...rollout.approvalEvents, event];
    const trimmed = events.length > TEAM_V15_MAX_APPROVAL_EVENTS
      ? events.slice(events.length - TEAM_V15_MAX_APPROVAL_EVENTS)
      : events;
    return { ...rollout, approvals, approvalEvents: trimmed };
  };
  if (!approverUserId || !approverUserId.trim()) {
    return { ok: false, rollout: withEvent(recordEvent(false, 'approverUserId is required'), rollout.approvals), reason: 'approverUserId is required' };
  }
  const next = teamV15NextStage(rollout);
  if (next === '') {
    return { ok: false, rollout: withEvent(recordEvent(false, 'no next stage to approve'), rollout.approvals), reason: 'no next stage to approve' };
  }
  // Approve được cấp ngay cả khi còn draft (cho stage canary đầu
  // tiên); chỉ pause/complete/rolled-back là không có stage đích để approve.
  if (rollout.v14.stage === 'paused' || rollout.v14.stage === 'complete' || rollout.v14.stage === 'rolled-back') {
    const reason = `cannot approve from stage ${rollout.v14.stage}`;
    return { ok: false, rollout: withEvent(recordEvent(false, reason), rollout.approvals), reason };
  }
  if (rollout.approvals.some((a) => a.forStage === next && a.approverUserId === approverUserId)) {
    const reason = `${approverUserId} already approved stage ${next}`;
    return { ok: false, rollout: withEvent(recordEvent(false, reason), rollout.approvals), reason };
  }
  const approval: TeamV15Approval = {
    approverUserId,
    approverRole,
    forStage: next,
    at: now,
    note: note.trim(),
  };
  return {
    ok: true,
    rollout: withEvent(recordEvent(true, ''), [...rollout.approvals, approval]),
    reason: '',
  };
}

/** Đặt lại target node của rollout (chỉ khi còn draft — tránh đổi đích giữa chừng). */
export function setTeamV15NodeTarget(
  rollout: TeamV15Rollout,
  target: TeamV15NodeTarget,
  now = Date.now(),
): TeamV15ApproveResult {
  const problem = validateTeamV15NodeTarget(target);
  if (problem !== '') return { ok: false, rollout, reason: problem };
  if (rollout.v14.stage !== 'draft') {
    return { ok: false, rollout, reason: `cannot change node target after rollout left draft (stage ${rollout.v14.stage})` };
  }
  return { ok: true, rollout: { ...rollout, nodeTarget: target, v14: { ...rollout.v14, updatedAt: now } }, reason: '' };
}

// ---------------------------------------------------------------------------
// Advance / rollback (v4 = approve gate + ủy thác v3)
// ---------------------------------------------------------------------------

export interface TeamV15TransitionResult {
  ok: boolean;
  rollout: TeamV15Rollout;
  reason: string;
}

/**
 * Advance sang stage kế tiếp: chặn khi chưa đủ approve, rồi ủy
 * thác dwell/gate cho v3. Advance thành công thì approve cũ hết
 * hiệu lực (chỉ giữ approve cho stage đích mới, nếu có — thực tế
 * là xóa hết vì approve gắn với stage đích cũ).
 *
 * Ngoại lệ: từ `draft`, v3 không có đường advance (plan chỉ chứa
 * stage triển khai) nên v4 tự làm bước "start": đủ approve là vào
 * stage đầu tiên của plan, KHÔNG kiểm dwell/gate (chưa có gì được
 * deploy nên gate với 0 sample là vô nghĩa — gate bắt đầu có tác
 * dụng từ lần advance sau).
 */
export function advanceTeamV15Rollout(
  rollout: TeamV15Rollout,
  actorUserId: string,
  now = Date.now(),
): TeamV15TransitionResult {
  // Đang ở stage cuối ('all'): v3 hoàn tất rollout, không cần approve thêm.
  if (teamV15NextStage(rollout) !== '' && !teamV15ApprovalsMet(rollout)) {
    const need = teamV15RequiredApprovals(rollout);
    const have = teamV15ApprovalCount(rollout);
    return {
      ok: false,
      rollout,
      reason: `waiting for approvals: ${have}/${need} approval(s) for stage ${teamV15NextStage(rollout)}`,
    };
  }
  if (rollout.v14.stage === 'draft') {
    const first = rollout.v14.plan[0];
    if (!first) return { ok: false, rollout, reason: 'rollout plan is empty' };
    const v14: TeamV14Rollout = {
      ...rollout.v14,
      stage: first.stage,
      stageEnteredAt: now,
      updatedAt: now,
      history: [
        ...rollout.v14.history,
        {
          at: now,
          actorUserId,
          fromStage: 'draft' as TeamV14RolloutStage,
          toStage: first.stage,
          reason: `started rollout (approved ${teamV15ApprovalCount(rollout)}/${teamV15RequiredApprovals(rollout)})`,
          metrics: null,
        },
      ],
    };
    return { ok: true, rollout: { ...rollout, v14, approvals: [] }, reason: '' };
  }
  const res: TeamV14TransitionResult = advanceTeamV14Rollout(rollout.v14, actorUserId, now);
  if (!res.ok) return { ok: false, rollout, reason: res.reason };
  return { ok: true, rollout: { ...rollout, v14: res.rollout, approvals: [] }, reason: '' };
}

/** Rollback thủ công: KHÔNG cần approve (an toàn trước đã), ủy thác v3. */
export function rollbackTeamV15Rollout(
  rollout: TeamV15Rollout,
  actorUserId: string,
  reason: string,
  now = Date.now(),
): TeamV15TransitionResult {
  const res: TeamV14TransitionResult = rollbackTeamV14Rollout(rollout.v14, actorUserId, reason, now);
  if (!res.ok) return { ok: false, rollout, reason: res.reason };
  const nodeStatus = rollout.nodeStatus.map((s) => ({
    ...s,
    version: rollout.v14.previousVersion,
    stage: 'rolled-back' as TeamV14RolloutStage,
    updatedAt: now,
    updatedBy: actorUserId,
  }));
  return { ok: true, rollout: { ...rollout, v14: res.rollout, approvals: [], nodeStatus }, reason: '' };
}

/**
 * Áp dụng quyết định tự động v3 (auto pause/rollback theo metric).
 * Khi rollback tự động xảy ra, nodeStatus cũng về previousVersion.
 */
export function applyTeamV15AutoRollback(
  rollout: TeamV15Rollout,
  metrics: TeamV14RolloutMetrics,
  actorUserId = 'system:auto-rollback',
  now = Date.now(),
): { rollout: TeamV15Rollout; appliedAction: TeamV14AutoAction; decision: TeamV14AutoDecision } {
  const res = applyTeamV14AutoRollback(rollout.v14, metrics, actorUserId, now);
  let next: TeamV15Rollout = { ...rollout, v14: res.rollout };
  if (res.appliedAction === 'rollback') {
    next = {
      ...next,
      approvals: [],
      nodeStatus: rollout.nodeStatus.map((s) => ({
        ...s,
        version: rollout.v14.previousVersion,
        stage: 'rolled-back' as TeamV14RolloutStage,
        updatedAt: now,
        updatedBy: actorUserId,
      })),
    };
  }
  return { rollout: next, appliedAction: res.appliedAction, decision: res.decision };
}

// ---------------------------------------------------------------------------
// Node status
// ---------------------------------------------------------------------------

/** Cập nhật version/stage của một node trong rollout (ghi nodeEvents). */
export function applyTeamV15NodeStage(
  rollout: TeamV15Rollout,
  nodeId: string,
  version: string,
  stage: TeamV14RolloutStage,
  actorUserId: string,
  now = Date.now(),
): TeamV15Rollout {
  const prev = rollout.nodeStatus.find((s) => s.nodeId === nodeId);
  const status: TeamV15NodeRolloutStatus = {
    nodeId,
    version,
    stage,
    updatedAt: now,
    updatedBy: actorUserId,
  };
  const nodeStatus = prev
    ? rollout.nodeStatus.map((s) => (s.nodeId === nodeId ? status : s))
    : [...rollout.nodeStatus, status];
  const nodeEvents = [
    ...rollout.nodeEvents,
    { at: now, nodeId, fromVersion: prev ? prev.version : '', toVersion: version, actorUserId },
  ];
  const trimmed = nodeEvents.length > TEAM_V15_MAX_NODE_EVENTS
    ? nodeEvents.slice(nodeEvents.length - TEAM_V15_MAX_NODE_EVENTS)
    : nodeEvents;
  return { ...rollout, nodeStatus, nodeEvents: trimmed, v14: { ...rollout.v14, updatedAt: now } };
}

/** Đếm node theo version đang chạy (để panel vẽ "bao nhiêu node đã lên v2"). */
export function teamV15NodeVersionCounts(rollout: TeamV15Rollout): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const s of rollout.nodeStatus) counts[s.version] = (counts[s.version] ?? 0) + 1;
  return counts;
}

// ---------------------------------------------------------------------------
// History gộp (timeline duy nhất)
// ---------------------------------------------------------------------------

/** Một dòng trong timeline gộp của rollout. */
export interface TeamV15HistoryItem {
  at: number;
  kind: 'stage' | 'approval' | 'node';
  actorUserId: string;
  summary: string;
}

/** Timeline gộp: stage chuyển (v3) + approve + node đổi version, mới nhất trước. */
export function teamV15RolloutHistory(rollout: TeamV15Rollout, limit = 100): TeamV15HistoryItem[] {
  const items: TeamV15HistoryItem[] = [];
  for (const h of rollout.v14.history) {
    items.push({
      at: h.at,
      kind: 'stage',
      actorUserId: h.actorUserId,
      summary: `${h.fromStage} -> ${h.toStage}: ${h.reason}`,
    });
  }
  for (const e of rollout.approvalEvents) {
    items.push({
      at: e.at,
      kind: 'approval',
      actorUserId: e.approverUserId,
      summary: e.accepted
        ? `approved stage ${e.forStage}`
        : `approval rejected for stage ${e.forStage}: ${e.reason}`,
    });
  }
  for (const e of rollout.nodeEvents) {
    items.push({
      at: e.at,
      kind: 'node',
      actorUserId: e.actorUserId,
      summary: `node ${e.nodeId}: ${e.fromVersion || '(none)'} -> ${e.toVersion}`,
    });
  }
  items.sort((a, b) => b.at - a.at);
  return items.slice(0, Math.max(0, limit));
}

// ---------------------------------------------------------------------------
// Tóm tắt + persistence
// ---------------------------------------------------------------------------

/** Tóm tắt một rollout v4 cho panel. */
export interface TeamV15RolloutSummary {
  id: string;
  feature: string;
  version: string;
  previousVersion: string;
  stage: TeamV14RolloutStage;
  stageLabel: string;
  percent: number;
  nodeTargetKind: TeamV15NodeTargetKind;
  targetedNodeCount: number;
  nodesOnNewVersion: number;
  approvalsHave: number;
  approvalsNeed: number;
  approvalsMet: boolean;
  nextStage: TeamV14RolloutStage | '';
  gate: TeamV14GateResult;
  autoDecision: TeamV14AutoDecision;
  historyCount: number;
}

export function summarizeTeamV15Rollout(
  rollout: TeamV15Rollout,
  allNodes: readonly FleetV14Node[] = [],
): TeamV15RolloutSummary {
  const v14 = summarizeTeamV14Rollout(rollout.v14);
  const targeted = teamV15TargetedNodes(rollout, allNodes);
  return {
    id: rollout.v14.id,
    feature: rollout.v14.feature,
    version: rollout.v14.version,
    previousVersion: rollout.v14.previousVersion,
    stage: rollout.v14.stage,
    stageLabel: v14.stageLabel,
    percent: v14.percent,
    nodeTargetKind: rollout.nodeTarget.kind,
    targetedNodeCount: targeted.length,
    nodesOnNewVersion: rollout.nodeStatus.filter((s) => s.version === rollout.v14.version).length,
    approvalsHave: teamV15ApprovalCount(rollout),
    approvalsNeed: teamV15RequiredApprovals(rollout),
    approvalsMet: teamV15ApprovalsMet(rollout),
    nextStage: teamV15NextStage(rollout),
    gate: v14.gate,
    autoDecision: v14.autoDecision,
    historyCount: rollout.v14.history.length + rollout.approvalEvents.length + rollout.nodeEvents.length,
  };
}

/** Toàn bộ store rollout v4 (lưu file). */
export interface TeamV15RolloutStore {
  version: 1;
  rollouts: TeamV15Rollout[];
  updatedAt: number;
}

export function createTeamV15RolloutStore(now = Date.now()): TeamV15RolloutStore {
  return { version: 1, rollouts: [], updatedAt: now };
}

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

export function saveTeamV15Rollouts(teamRoot: string, store: TeamV15RolloutStore): void {
  atomicWriteFile(path.join(teamRoot, TEAM_V15_ROLLOUTS_FILE), JSON.stringify(store, null, 2));
}

export function loadTeamV15Rollouts(teamRoot: string): TeamV15RolloutStore | null {
  const file = path.join(teamRoot, TEAM_V15_ROLLOUTS_FILE);
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as TeamV15RolloutStore;
    if (parsed.version !== 1 || !Array.isArray(parsed.rollouts)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Thêm / thay thế một rollout v4 trong store (trả store mới). */
export function upsertTeamV15Rollout(
  store: TeamV15RolloutStore,
  rollout: TeamV15Rollout,
  now = Date.now(),
): TeamV15RolloutStore {
  const rollouts = store.rollouts.filter((r) => r.v14.id !== rollout.v14.id);
  rollouts.push(rollout);
  const trimmed = rollouts.length > TEAM_V15_MAX_ROLLOUTS
    ? rollouts.slice(rollouts.length - TEAM_V15_MAX_ROLLOUTS)
    : rollouts;
  return { ...store, rollouts: trimmed, updatedAt: now };
}

/** Re-export để caller v4 không phải import 2 module. */
export { decideTeamV14AutoAction, evaluateTeamV14HealthGate, teamV14StagePercent };

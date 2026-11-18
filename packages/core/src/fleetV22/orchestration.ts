/**
 * Orchestrator fleet v22 (v1.35, Đội T6) — ghép 2 mẫu orchestration
 * thành một bộ máy duy nhất.
 *
 * Orchestrator quyết định, với mỗi việc cần làm, dùng mẫu nào:
 *
 * - DELEGATION (subagent, giữ quyền kiểm soát): việc là "làm hộ" —
 *   nghiên cứu, viết code, kiểm tra, tóm tắt. Parent giữ cuộc nói
 *   chuyện với user; subagent làm xong báo cáo tóm tắt + artifacts.
 * - HANDOFF (chuyển giao toàn bộ hội thoại): việc là "đổi người nói
 *   chuyện" — user cần chuyên môn khác (billing, support, coding...),
 *   agent hiện tại không đủ chuyên môn. Agent mới tiếp quản hội thoại.
 *
 * Luật chọn mẫu (mặc định, host có thể override bằng rule riêng):
 * - User hỏi về lĩnh vực khác hẳn chuyên môn agent hiện tại VÀ agent
 *   chuyên môn đó đã đăng ký → HANDOFF.
 * - Việc cần làm ngầm, không đổi người nói chuyện → DELEGATION.
 * - Việc cần tool nguy hiểm (ghi file, chạy shell, thanh toán) mà
 *   agent hiện tại không có quyền → DELEGATION cho subagent có quyền
 *   đó (parent kiểm soát), KHÔNG handoff để tránh agent mới tự ý ghi.
 * - Khi cả hai mẫu đều hợp lý → ưu tiên DELEGATION (an toàn hơn: parent
 *   vẫn kiểm soát, hội thoại không đổi chủ).
 *
 * Ngoài ra orchestrator lo:
 * - Escalation: delegation fail/timeout quá N lần → escalate lên
 *   parent (dừng, báo user) hoặc chuyển sang handoff cho agent chuyên
 *   môn sâu hơn — có giới hạn số lần escalate để không lặp vô hạn.
 * - Audit trail: mọi quyết định orchestration (chọn mẫu nào, vì sao,
 *   ai quyết) đều ghi lại, append-only — để xem lại "sao việc này lại
 *   đi đường này".
 * - Router: rule-based routing theo từ khoá + chuyên môn agent (không
 *   dùng model) — host có thể thay bằng router model sau, interface
 *   giữ nguyên.
 */

import type { FleetV22Delegation } from './delegation';
import type { FleetV22Handoff, FleetV22HandoffAgentRegistry } from './handoff';
import { handoffToolNameV22 } from './handoff';

/** Mẫu orchestration. */
export type FleetV22OrchestrationMode = 'delegation' | 'handoff';

/** Mọi mẫu orchestration. */
export const FLEET_V22_ORCHESTRATION_MODES: readonly FleetV22OrchestrationMode[] = ['delegation', 'handoff'];

/** Một rule routing: khi nào thì dùng mẫu nào / chuyển cho ai. */
export interface FleetV22RoutingRule {
  /** Id rule (ổn định để audit trích dẫn). */
  id: string;
  /** Tên hiển thị. */
  name: string;
  /** Từ khoá (không phân biệt hoa thường) — message chứa từ khoá thì rule khớp. */
  keywords: string[];
  /** Mẫu rule này chỉ định. */
  mode: FleetV22OrchestrationMode;
  /** Agent đích khi mode = handoff (undefined = delegation, không có đích cụ thể). */
  targetAgentId?: string;
  /** Subagent (tên) khi mode = delegation. */
  subagentName?: string;
  /** Mức ưu tiên rule (số lớn khớp trước; mặc định 0). */
  priority?: number;
  /** true = rule đang bật (tắt thì không khớp). */
  enabled: boolean;
}

/** Tạo rule routing mới. */
export function createFleetV22RoutingRule(input: {
  id: string;
  name: string;
  keywords: string[];
  mode: FleetV22OrchestrationMode;
  targetAgentId?: string;
  subagentName?: string;
  priority?: number;
  enabled?: boolean;
}): FleetV22RoutingRule {
  return {
    id: input.id,
    name: input.name,
    keywords: [...input.keywords],
    mode: input.mode,
    ...(input.targetAgentId ? { targetAgentId: input.targetAgentId } : {}),
    ...(input.subagentName ? { subagentName: input.subagentName } : {}),
    priority: input.priority ?? 0,
    enabled: input.enabled ?? true,
  };
}

/** Kết quả router: chọn mẫu nào + rule nào khớp + giải thích. */
export interface FleetV22RouteDecision {
  mode: FleetV22OrchestrationMode;
  /** Rule đã khớp (undefined = không rule nào khớp, dùng mặc định). */
  ruleId: string | null;
  /** Agent đích (handoff) hoặc subagent (delegation). */
  targetId: string | null;
  /** Giải thích 1 dòng (để audit + UI). */
  reason: string;
}

/**
 * Router theo rule: duyệt rule đang bật theo ưu tiên giảm dần, rule
 * đầu tiên có từ khoá xuất hiện trong message thì thắng. Không rule
 * nào khớp → mặc định DELEGATION (an toàn hơn, xem đầu file).
 */
export function routeFleetV22Task(
  message: string,
  rules: readonly FleetV22RoutingRule[],
  fallbackSubagentName = 'generalist',
): FleetV22RouteDecision {
  const lower = message.toLowerCase();
  const active = [...rules]
    .filter((r) => r.enabled)
    .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0) || a.id.localeCompare(b.id));
  for (const rule of active) {
    const matched = rule.keywords.filter((k) => k.length > 0 && lower.includes(k.toLowerCase()));
    if (matched.length === 0) continue;
    return {
      mode: rule.mode,
      ruleId: rule.id,
      targetId: rule.mode === 'handoff' ? (rule.targetAgentId ?? null) : (rule.subagentName ?? fallbackSubagentName),
      reason: `Rule "${rule.name}" khớp từ khoá: ${matched.join(', ')} → ${rule.mode === 'handoff' ? `handoff sang "${rule.targetAgentId ?? '?'}"` : `delegation cho subagent "${rule.subagentName ?? fallbackSubagentName}"`}.`,
    };
  }
  return {
    mode: 'delegation',
    ruleId: null,
    targetId: fallbackSubagentName,
    reason: `Không rule nào khớp — mặc định delegation cho subagent "${fallbackSubagentName}" (an toàn: parent giữ hội thoại).`,
  };
}

/**
 * Kiểm tra một quyết định handoff có hợp lệ không trước khi chạy:
 * agent đích phải đăng ký, và không được handoff sang chính mình.
 * Trả về lỗi (rỗng = chạy được).
 */
export function validateHandoffDecisionV22(
  decision: FleetV22RouteDecision,
  currentAgentId: string,
  agentRegistry: FleetV22HandoffAgentRegistry,
): string[] {
  const errors: string[] = [];
  if (decision.mode !== 'handoff') return errors;
  if (!decision.targetId) {
    errors.push('Quyết định handoff không có agent đích — kiểm tra rule routing (thiếu targetAgentId).');
    return errors;
  }
  if (decision.targetId === currentAgentId) {
    errors.push(`Agent đích "${decision.targetId}" chính là agent hiện tại — không handoff sang chính mình.`);
  }
  const agent = agentRegistry.get(decision.targetId);
  if (!agent) {
    errors.push(`Agent đích "${decision.targetId}" chưa đăng ký nhận handoff.`);
  }
  return errors;
}

// ---------------------------------------------------------------------------
// Escalation
// ---------------------------------------------------------------------------

/** Cấu hình escalation khi delegation fail/timeout. */
export interface FleetV22EscalationPolicy {
  /** Số lần delegation fail liên tiếp thì escalate. */
  maxConsecutiveFailures: number;
  /** Sau khi escalate, làm gì: `notify-parent` (dừng, báo parent) hay `handoff-specialist` (chuyển cho agent chuyên môn). */
  onEscalate: 'notify-parent' | 'handoff-specialist';
  /** Agent chuyên môn khi onEscalate = handoff-specialist. */
  specialistAgentId?: string;
}

/** Escalation mặc định: fail 2 lần liên tiếp → báo parent, dừng. */
export const DEFAULT_FLEET_V22_ESCALATION_POLICY: FleetV22EscalationPolicy = {
  maxConsecutiveFailures: 2,
  onEscalate: 'notify-parent',
};

/** Kết quả đánh giá escalation cho một chuỗi delegation. */
export interface FleetV22EscalationCheck {
  /** Có cần escalate không. */
  shouldEscalate: boolean;
  /** Số lần fail liên tiếp đếm được. */
  consecutiveFailures: number;
  /** Hành động escalate theo policy. */
  action: FleetV22EscalationPolicy['onEscalate'] | 'none';
  reason: string;
}

/**
 * Đếm fail liên tiếp trong danh sách delegation (mới nhất trước) rồi
 * so với policy: đủ ngưỡng thì escalate.
 */
export function checkFleetV22Escalation(
  recentDelegations: readonly FleetV22Delegation[],
  policy: FleetV22EscalationPolicy = DEFAULT_FLEET_V22_ESCALATION_POLICY,
): FleetV22EscalationCheck {
  let consecutiveFailures = 0;
  const sorted = [...recentDelegations].sort((a, b) => b.createdAt - a.createdAt);
  for (const d of sorted) {
    if (d.status === 'failed' || d.status === 'timed-out') consecutiveFailures += 1;
    else if (d.status === 'completed') break;
    else break; // đang chạy / chờ xác minh → dừng đếm, chưa kết luận fail
  }
  const shouldEscalate = consecutiveFailures >= policy.maxConsecutiveFailures;
  return {
    shouldEscalate,
    consecutiveFailures,
    action: shouldEscalate ? policy.onEscalate : 'none',
    reason: shouldEscalate
      ? `Delegation fail ${consecutiveFailures} lần liên tiếp (ngưỡng ${policy.maxConsecutiveFailures}) → ${policy.onEscalate === 'notify-parent' ? 'báo parent và dừng' : `handoff sang agent chuyên môn "${policy.specialistAgentId ?? '?'}"`}.`
      : `Delegation fail ${consecutiveFailures} lần liên tiếp, chưa tới ngưỡng ${policy.maxConsecutiveFailures} — thử lại được.`,
  };
}

// ---------------------------------------------------------------------------
// Audit trail
// ---------------------------------------------------------------------------

/** Một mục audit của orchestrator. */
export interface FleetV22OrchestrationAuditEntry {
  id: string;
  /** Loại quyết định: route | delegate | handoff | escalate | verify | cancel. */
  kind: 'route' | 'delegate' | 'handoff' | 'escalate' | 'verify' | 'cancel';
  /** Id hội thoại / run liên quan. */
  conversationId: string;
  /** Id run liên quan. */
  runId: string;
  /** Id user sở hữu. */
  ownerId: string;
  /** Tóm tắt quyết định. */
  summary: string;
  /** Chi tiết (rule id, delegation id, handoff id, ...). */
  detail: Record<string, string>;
  /** Lúc quyết định (epoch ms). */
  at: number;
}

/** Audit trail append-only (giới hạn để không phình). */
export class FleetV22OrchestrationAuditLog {
  private readonly entries: FleetV22OrchestrationAuditEntry[] = [];
  private counter = 0;

  constructor(private readonly maxEntries: number = 2000) {}

  /** Ghi một mục (tự sinh id). */
  record(entry: Omit<FleetV22OrchestrationAuditEntry, 'id' | 'at'> & { at?: number }): FleetV22OrchestrationAuditEntry {
    this.counter += 1;
    const rec: FleetV22OrchestrationAuditEntry = { ...entry, id: `orc-${this.counter}`, at: entry.at ?? Date.now() };
    this.entries.push(rec);
    while (this.entries.length > this.maxEntries) this.entries.shift();
    return rec;
  }

  /** Mọi mục (cũ → mới). */
  list(): FleetV22OrchestrationAuditEntry[] {
    return [...this.entries];
  }

  /** Mục của một hội thoại. */
  byConversation(conversationId: string): FleetV22OrchestrationAuditEntry[] {
    return this.list().filter((e) => e.conversationId === conversationId);
  }

  /** Mục theo loại quyết định. */
  byKind(kind: FleetV22OrchestrationAuditEntry['kind']): FleetV22OrchestrationAuditEntry[] {
    return this.list().filter((e) => e.kind === kind);
  }

  /** Mục của một user. */
  byOwner(ownerId: string): FleetV22OrchestrationAuditEntry[] {
    return this.list().filter((e) => e.ownerId === ownerId);
  }

  get size(): number {
    return this.entries.length;
  }
}

// ---------------------------------------------------------------------------
// Trạng thái orchestration tổng hợp (để dashboard đọc)
// ---------------------------------------------------------------------------

/** Ảnh chụp trạng thái orchestration: bao nhiêu delegation/handoff ở từng trạng thái. */
export interface FleetV22OrchestrationSnapshot {
  delegations: {
    total: number;
    pending: number;
    running: number;
    awaitingVerification: number;
    completed: number;
    failed: number;
    cancelled: number;
    timedOut: number;
  };
  handoffs: {
    total: number;
    pendingApproval: number;
    transferred: number;
    rejected: number;
    failed: number;
  };
  /** Delegation đang chờ xác minh (cần parent xử lý). */
  awaitingVerificationIds: string[];
  /** Handoff đang chờ duyệt. */
  pendingApprovalHandoffIds: string[];
  /** Số mục audit đã ghi. */
  auditEntries: number;
}

/** Build snapshot từ delegation + handoff + audit log. */
export function snapshotFleetV22Orchestration(input: {
  delegations: readonly FleetV22Delegation[];
  handoffs: readonly FleetV22Handoff[];
  auditEntries: number;
}): FleetV22OrchestrationSnapshot {
  const countStatus = (status: FleetV22Delegation['status']): number =>
    input.delegations.filter((d) => d.status === status).length;
  const countHandoff = (status: FleetV22Handoff['status']): number =>
    input.handoffs.filter((h) => h.status === status).length;
  return {
    delegations: {
      total: input.delegations.length,
      pending: countStatus('pending'),
      running: countStatus('running'),
      awaitingVerification: countStatus('awaiting-verification'),
      completed: countStatus('completed'),
      failed: countStatus('failed'),
      cancelled: countStatus('cancelled'),
      timedOut: countStatus('timed-out'),
    },
    handoffs: {
      total: input.handoffs.length,
      pendingApproval: countHandoff('pending-approval'),
      transferred: countHandoff('transferred'),
      rejected: countHandoff('rejected'),
      failed: countHandoff('failed'),
    },
    awaitingVerificationIds: input.delegations
      .filter((d) => d.status === 'awaiting-verification')
      .map((d) => d.id),
    pendingApprovalHandoffIds: input.handoffs.filter((h) => h.status === 'pending-approval').map((h) => h.id),
    auditEntries: input.auditEntries,
  };
}

/** Validate rule routing từ dữ liệu ngoài (lỗi → danh sách). */
export function validateFleetV22RoutingRule(input: unknown): string[] {
  const errors: string[] = [];
  if (typeof input !== 'object' || input === null) return ['routing rule phải là object.'];
  const r = input as Record<string, unknown>;
  if (typeof r.id !== 'string' || r.id.trim().length === 0) errors.push('routing rule.id phải là chuỗi không rỗng.');
  if (!Array.isArray(r.keywords) || (r.keywords as unknown[]).length === 0) {
    errors.push('routing rule.keywords phải là mảng không rỗng.');
  }
  if (typeof r.mode !== 'string' || !['delegation', 'handoff'].includes(r.mode)) {
    errors.push('routing rule.mode phải là delegation hoặc handoff.');
  }
  if (r.mode === 'handoff' && (typeof r.targetAgentId !== 'string' || (r.targetAgentId as string).trim().length === 0)) {
    errors.push('routing rule handoff phải có targetAgentId.');
  }
  if (r.mode === 'delegation' && r.subagentName !== undefined && typeof r.subagentName !== 'string') {
    errors.push('routing rule.subagentName phải là chuỗi.');
  }
  return errors;
}

/** Tóm tắt tên tool handoff cho một agent (tiện cho UI/tool listing). */
export function handoffToolNameForAgentV22(agentId: string): string {
  return handoffToolNameV22(agentId);
}

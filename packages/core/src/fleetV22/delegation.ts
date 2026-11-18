/**
 * Subagent delegation cho fleet v22 (v1.35, Đội T6) — mẫu 1 trong 2 mẫu
 * orchestration của v22.
 *
 * Ý tưởng (học từ Claude Agent SDK — chỉ học ý tưởng, không copy):
 * parent agent UỶ QUYỀN cho subagent làm một việc, nhưng GIỮ QUYỀN
 * KIỂM SOÁT toàn bộ:
 *
 * - Subagent chạy trong CONTEXT RIÊNG: nó chỉ thấy task được giao +
 *   tài liệu parent đưa — KHÔNG thấy toàn bộ hội thoại của parent,
 *   không thấy bí mật của user, không thấy các subagent khác.
 * - Parent chỉ nhận KẾT QUẢ TÓM TẮT (summary + artifacts), không nhận
 *   toàn bộ transcript dài của subagent — context parent không phình.
 * - Parent kiểm soát: giới hạn tool subagent được dùng, giới hạn
 *   budget (số lượt tool / thời gian / chi phí ước tính), huỷ subagent
 *   bất cứ lúc nào; subagent KHÔNG được tự tạo subagent con vượt quá
 *   độ sâu cho phép, KHÔNG được tự đổi giới hạn của mình.
 * - Kết quả subagent phải qua KIỂM CHỨNG trước khi parent dùng: mỗi
 *   artifact có checksum + người tạo + lúc tạo; parent đánh dấu
 *   verified / rejected rõ ràng.
 *
 * Module thuần: không gọi model thật — host chạy subagent rồi ghi kết
 * quả vào đây (record), hoặc dùng `FleetV22DelegationRunner` giả lập
 * chạy bằng executor do host cung cấp (xem `orchestration.ts`).
 *
 * Khác với handoff (`handoff.ts`): delegation KHÔNG chuyển hội thoại —
 * parent vẫn là người nói chuyện với user, subagent chỉ là "tay chân"
 * làm việc nền rồi báo cáo lại.
 */

/** Trạng thái của một lần delegation. */
export type FleetV22DelegationStatus =
  | 'pending'
  | 'running'
  | 'awaiting-verification'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'timed-out';

/** Mọi trạng thái delegation. */
export const FLEET_V22_DELEGATION_STATUSES: readonly FleetV22DelegationStatus[] = [
  'pending',
  'running',
  'awaiting-verification',
  'completed',
  'failed',
  'cancelled',
  'timed-out',
];

/** Trạng thái kết thúc (không chạy tiếp được nữa). */
export const FLEET_V22_DELEGATION_TERMINAL: readonly FleetV22DelegationStatus[] = [
  'completed',
  'failed',
  'cancelled',
  'timed-out',
];

/** Giới hạn parent đặt cho subagent (budget). */
export interface FleetV22DelegationBudget {
  /** Tối đa lượt gọi tool. */
  maxToolCalls: number;
  /** Tối đa thời gian chạy (ms). */
  maxDurationMs: number;
  /** Tối đa độ sâu subagent con (0 = subagent không được tạo subagent con). */
  maxDepth: number;
  /** Tối đa chi phí ước tính (đơn vị tiền của provider, vd USD) — null = không giới hạn tiền. */
  maxEstimatedCost: number | null;
}

/** Budget mặc định: 50 tool call, 10 phút, không tạo con, không giới hạn tiền. */
export const DEFAULT_FLEET_V22_DELEGATION_BUDGET: FleetV22DelegationBudget = {
  maxToolCalls: 50,
  maxDurationMs: 10 * 60 * 1000,
  maxDepth: 0,
  maxEstimatedCost: null,
};

/** Một artifact subagent trả về (file / kết quả có thể kiểm chứng). */
export interface FleetV22DelegationArtifact {
  /** Id artifact (ổn định để parent trích dẫn). */
  id: string;
  /** Loại: file, text, diff, url, ... */
  kind: string;
  /** Tên hiển thị / đường dẫn. */
  name: string;
  /** Nội dung tóm tắt (không phải toàn bộ nội dung dài — nội dung dài nằm ở `location`). */
  summary: string;
  /** Nơi lấy nội dung đầy đủ (đường dẫn file / URL). */
  location: string;
  /** Checksum (vd sha256 hex) để parent kiểm chứng nội dung không bị sửa sau khi tạo. */
  checksum?: string;
  /** Kích thước (byte) — null khi không biết. */
  sizeBytes: number | null;
}

/** Một lần delegation (parent → subagent). */
export interface FleetV22Delegation {
  /** Id duy nhất. */
  id: string;
  /** Id agent parent (người giao việc). */
  parentAgentId: string;
  /** Id subagent (người nhận việc). */
  subagentId: string;
  /** Tên subagent (vd `researcher`, `coder`) — để UI hiện. */
  subagentName: string;
  /** Task giao cho subagent (mô tả đầy đủ — đây là TẤT CẢ context subagent thấy). */
  task: string;
  /** Tool subagent ĐƯỢC dùng (allowlist — tool ngoài danh sách này bị chặn). */
  allowedTools: string[];
  /** Budget parent đặt. */
  budget: FleetV22DelegationBudget;
  /** Độ sâu của delegation này (0 = parent giao trực tiếp). */
  depth: number;
  /** Id delegation cha (khi subagent tạo subagent con) — null khi là gốc. */
  parentDelegationId: string | null;
  status: FleetV22DelegationStatus;
  /** Lượt tool đã dùng. */
  toolCallsUsed: number;
  /** Chi phí ước tính đã dùng. */
  estimatedCostUsed: number;
  /** Tóm tắt kết quả (subagent viết — parent đọc cái này, không đọc transcript). */
  summary: string | null;
  /** Artifacts subagent trả về. */
  artifacts: FleetV22DelegationArtifact[];
  /** Kết quả đã được parent xác minh chưa (null = chưa xác minh). */
  verified: boolean | null;
  /** Ghi chú xác minh của parent (vd "đã kiểm tra file, đúng"). */
  verificationNote: string | null;
  /** Lỗi (khi failed/timed-out). */
  error: string | null;
  /** Id run/bot chứa delegation này (để trace). */
  runId: string;
  /** Id user sở hữu (để kiểm tra quyền xem kết quả). */
  ownerId: string;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
}

/** Tạo một delegation mới (trạng thái `pending`, chưa chạy). */
export function createFleetV22Delegation(input: {
  id: string;
  parentAgentId: string;
  subagentId: string;
  subagentName: string;
  task: string;
  allowedTools: string[];
  budget?: Partial<FleetV22DelegationBudget>;
  depth?: number;
  parentDelegationId?: string | null;
  runId: string;
  ownerId: string;
  now?: number;
}): FleetV22Delegation {
  const now = input.now ?? Date.now();
  return {
    id: input.id,
    parentAgentId: input.parentAgentId,
    subagentId: input.subagentId,
    subagentName: input.subagentName,
    task: input.task,
    allowedTools: [...input.allowedTools],
    budget: { ...DEFAULT_FLEET_V22_DELEGATION_BUDGET, ...(input.budget ?? {}) },
    depth: input.depth ?? 0,
    parentDelegationId: input.parentDelegationId ?? null,
    status: 'pending',
    toolCallsUsed: 0,
    estimatedCostUsed: 0,
    summary: null,
    artifacts: [],
    verified: null,
    verificationNote: null,
    error: null,
    runId: input.runId,
    ownerId: input.ownerId,
    createdAt: now,
    startedAt: null,
    finishedAt: null,
  };
}

// ---------------------------------------------------------------------------
// Vòng đời
// ---------------------------------------------------------------------------

/** Các chuyển trạng thái hợp lệ của delegation. */
export const FLEET_V22_DELEGATION_TRANSITIONS: Readonly<
  Record<FleetV22DelegationStatus, readonly FleetV22DelegationStatus[]>
> = {
  pending: ['running', 'cancelled'],
  running: ['awaiting-verification', 'failed', 'cancelled', 'timed-out'],
  'awaiting-verification': ['completed', 'failed'],
  completed: [],
  failed: [],
  cancelled: [],
  'timed-out': [],
};

/** true khi chuyển trạng thái được phép. */
export function delegationTransitionAllowedV22(
  from: FleetV22DelegationStatus,
  to: FleetV22DelegationStatus,
): boolean {
  return (FLEET_V22_DELEGATION_TRANSITIONS[from] as readonly FleetV22DelegationStatus[]).includes(to);
}

/** Chuyển trạng thái (không hợp lệ → throw). */
export function transitionFleetV22Delegation(
  delegation: FleetV22Delegation,
  to: FleetV22DelegationStatus,
  now: number = Date.now(),
): FleetV22Delegation {
  if (!delegationTransitionAllowedV22(delegation.status, to)) {
    throw new Error(
      `Delegation "${delegation.id}" không chuyển được từ "${delegation.status}" sang "${to}".`,
    );
  }
  return {
    ...delegation,
    status: to,
    ...(to === 'running' && delegation.startedAt === null ? { startedAt: now } : {}),
    ...((FLEET_V22_DELEGATION_TERMINAL as readonly FleetV22DelegationStatus[]).includes(to) && delegation.finishedAt === null
      ? { finishedAt: now }
      : {}),
  };
}

/**
 * Ghi nhận subagent đã xong việc: chuyển sang `awaiting-verification`
 * kèm summary + artifacts. Parent PHẢI xác minh (verify/reject) sau
 * bước này thì delegation mới `completed` — không tự động completed.
 */
export function delegationFinishV22(
  delegation: FleetV22Delegation,
  input: { summary: string; artifacts?: FleetV22DelegationArtifact[] },
  now: number = Date.now(),
): FleetV22Delegation {
  if (delegation.status !== 'running') {
    throw new Error(`Delegation "${delegation.id}" đang "${delegation.status}" — chỉ delegation đang chạy mới finish được.`);
  }
  return {
    ...delegation,
    status: 'awaiting-verification',
    summary: input.summary,
    artifacts: [...(input.artifacts ?? [])],
  };
}

/** Parent xác minh kết quả: đúng → completed, sai → failed (kèm ghi chú). */
export function delegationVerifyV22(
  delegation: FleetV22Delegation,
  verified: boolean,
  note?: string,
  now: number = Date.now(),
): FleetV22Delegation {
  if (delegation.status !== 'awaiting-verification') {
    throw new Error(
      `Delegation "${delegation.id}" đang "${delegation.status}" — chỉ delegation chờ xác minh mới verify được.`,
    );
  }
  return {
    ...delegation,
    status: verified ? 'completed' : 'failed',
    verified,
    verificationNote: note ?? null,
    finishedAt: now,
    ...(verified ? {} : { error: note ?? 'Parent từ chối kết quả của subagent.' }),
  };
}

/** Ghi nhận subagent gọi thêm tool (vượt budget → throw, host phải dừng subagent). */
export function delegationRecordToolCallV22(
  delegation: FleetV22Delegation,
  estimatedCost?: number,
): FleetV22Delegation {
  if (delegation.status !== 'running') {
    throw new Error(`Delegation "${delegation.id}" đang "${delegation.status}" — chỉ delegation đang chạy mới ghi tool call.`);
  }
  const toolCallsUsed = delegation.toolCallsUsed + 1;
  if (toolCallsUsed > delegation.budget.maxToolCalls) {
    throw new Error(
      `Delegation "${delegation.id}" vượt budget tool call (${toolCallsUsed}/${delegation.budget.maxToolCalls}) — dừng subagent.`,
    );
  }
  const estimatedCostUsed = delegation.estimatedCostUsed + (estimatedCost ?? 0);
  if (
    delegation.budget.maxEstimatedCost !== null &&
    estimatedCostUsed > delegation.budget.maxEstimatedCost
  ) {
    throw new Error(
      `Delegation "${delegation.id}" vượt budget chi phí (${estimatedCostUsed}/${delegation.budget.maxEstimatedCost}) — dừng subagent.`,
    );
  }
  return { ...delegation, toolCallsUsed, estimatedCostUsed };
}

/** Kiểm tra timeout: chạy quá maxDurationMs thì đánh dấu timed-out (trả về bản mới + có timeout không). */
export function delegationCheckTimeoutV22(
  delegation: FleetV22Delegation,
  now: number = Date.now(),
): { delegation: FleetV22Delegation; timedOut: boolean } {
  if (delegation.status !== 'running' || delegation.startedAt === null) return { delegation, timedOut: false };
  if (now - delegation.startedAt <= delegation.budget.maxDurationMs) return { delegation, timedOut: false };
  return {
    delegation: {
      ...delegation,
      status: 'timed-out',
      finishedAt: now,
      error: `Subagent chạy quá ${Math.round(delegation.budget.maxDurationMs / 1000)}s (budget).`,
    },
    timedOut: true,
  };
}

/** true khi subagent được dùng tool này (allowlist). */
export function delegationToolAllowedV22(delegation: FleetV22Delegation, toolName: string): boolean {
  return delegation.allowedTools.includes(toolName);
}

/** true khi delegation này được tạo subagent con (depth < maxDepth của budget). */
export function delegationCanSpawnChildV22(delegation: FleetV22Delegation): boolean {
  return delegation.depth < delegation.budget.maxDepth;
}

/** Thời gian đã chạy (ms) — null khi chưa bắt đầu. */
export function delegationElapsedMsV22(delegation: FleetV22Delegation, now: number = Date.now()): number | null {
  if (delegation.startedAt === null) return null;
  return Math.max(0, (delegation.finishedAt ?? now) - delegation.startedAt);
}

/** true khi delegation đã kết thúc (terminal). */
export function delegationIsTerminalV22(delegation: FleetV22Delegation): boolean {
  return (FLEET_V22_DELEGATION_TERMINAL as readonly FleetV22DelegationStatus[]).includes(delegation.status);
}

// ---------------------------------------------------------------------------
// Registry delegation trong bộ nhớ
// ---------------------------------------------------------------------------

/** Registry delegation trong bộ nhớ — host giữ 1 instance. */
export class FleetV22DelegationRegistry {
  private readonly delegations = new Map<string, FleetV22Delegation>();

  add(delegation: FleetV22Delegation): void {
    if (this.delegations.has(delegation.id)) throw new Error(`Delegation "${delegation.id}" đã tồn tại.`);
    this.delegations.set(delegation.id, structuredClone(delegation));
  }

  update(delegation: FleetV22Delegation): void {
    if (!this.delegations.has(delegation.id)) throw new Error(`Delegation "${delegation.id}" chưa có trong registry.`);
    this.delegations.set(delegation.id, structuredClone(delegation));
  }

  remove(delegationId: string): boolean {
    return this.delegations.delete(delegationId);
  }

  get(delegationId: string): FleetV22Delegation | undefined {
    const d = this.delegations.get(delegationId);
    return d ? structuredClone(d) : undefined;
  }

  list(): FleetV22Delegation[] {
    return [...this.delegations.values()].map((d) => structuredClone(d));
  }

  /** Delegation đang chạy (chưa terminal). */
  active(): FleetV22Delegation[] {
    return this.list().filter((d) => !delegationIsTerminalV22(d));
  }

  /** Delegation của một run. */
  byRun(runId: string): FleetV22Delegation[] {
    return this.list().filter((d) => d.runId === runId);
  }

  /** Delegation của một user. */
  byOwner(ownerId: string): FleetV22Delegation[] {
    return this.list().filter((d) => d.ownerId === ownerId);
  }

  /** Delegation chờ parent xác minh (cần xử lý — không để treo). */
  awaitingVerification(): FleetV22Delegation[] {
    return this.list().filter((d) => d.status === 'awaiting-verification');
  }

  /** Áp timeout cho mọi delegation đang chạy, trả về id các delegation vừa timeout. */
  checkTimeouts(now: number = Date.now()): string[] {
    const timedOut: string[] = [];
    for (const d of this.delegations.values()) {
      const checked = delegationCheckTimeoutV22(d, now);
      if (checked.timedOut) {
        this.delegations.set(d.id, checked.delegation);
        timedOut.push(d.id);
      }
    }
    return timedOut;
  }

  get size(): number {
    return this.delegations.size;
  }
}

/** Validate delegation từ dữ liệu ngoài (lỗi → danh sách). */
export function validateFleetV22Delegation(input: unknown): string[] {
  const errors: string[] = [];
  if (typeof input !== 'object' || input === null) return ['delegation phải là object.'];
  const d = input as Record<string, unknown>;
  if (typeof d.id !== 'string' || d.id.trim().length === 0) errors.push('delegation.id phải là chuỗi không rỗng.');
  if (typeof d.task !== 'string' || d.task.trim().length === 0) errors.push('delegation.task phải là chuỗi không rỗng.');
  if (!Array.isArray(d.allowedTools)) errors.push('delegation.allowedTools phải là mảng tên tool.');
  const budget = d.budget as Record<string, unknown> | undefined;
  if (typeof budget !== 'object' || budget === null) {
    errors.push('delegation.budget phải là object.');
  } else {
    for (const field of ['maxToolCalls', 'maxDurationMs', 'maxDepth'] as const) {
      if (typeof budget[field] !== 'number' || !Number.isFinite(budget[field]) || (budget[field] as number) < 0) {
        errors.push(`delegation.budget.${field} phải là số >= 0.`);
      }
    }
  }
  if (typeof d.status === 'string' && !(FLEET_V22_DELEGATION_STATUSES as readonly string[]).includes(d.status)) {
    errors.push(`delegation.status phải là một trong: ${FLEET_V22_DELEGATION_STATUSES.join(', ')}.`);
  }
  return errors;
}

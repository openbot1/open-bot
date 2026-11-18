/**
 * Handoff chuyển giao cho fleet v22 (v1.35, Đội T6) — mẫu 2 trong 2 mẫu
 * orchestration của v22.
 *
 * Ý tưởng (học từ OpenAI Agents SDK — chỉ học ý tưởng, không copy):
 * agent đang nói chuyện với user có thể CHUYỂN TOÀN BỘ hội thoại sang
 * một agent chuyên môn khác bằng một "tool chuyển giao" tên dạng
 * `transfer_to_<agent>` (vd `transfer_to_billing`, `transfer_to_coder`).
 * Agent mới nhận:
 * - toàn bộ lịch sử hội thoại (không phải chỉ tóm tắt như delegation),
 * - vai trò + hướng dẫn của chính nó,
 * - và TRỞ THÀNH agent đang nói chuyện — user từ đó nói với agent mới.
 *
 * Điểm khác delegation (`delegation.ts`):
 * - Delegation: parent giữ cuộc nói chuyện, subagent làm việc nền.
 * - Handoff: agent cũ RỜI cuộc nói chuyện, agent mới TIẾP QUẢN.
 *
 * Luật cứng của module:
 * 1. Handoff chỉ tới agent ĐÃ ĐĂNG KÝ trong registry handoff (không
 *    chuyển tới tên lạ chưa đăng ký — tránh chuyển nhầm sang agent
 *    không tồn tại rồi mất hội thoại).
 * 2. Mỗi lần handoff ghi lại ĐẦY ĐỦ: từ agent nào, sang agent nào, vì
 *    sao (lý do + message kích hoạt), lúc nào — chuỗi handoff (chain)
 *    phải truy vết được từ đầu tới cuối.
 * 3. Chống vòng lặp: cùng một hội thoại không được handoff qua lại
 *    giữa 2 agent quá `maxHandoffsPerConversation` lần, và không được
 *    quay lại agent vừa rời trong cùng một bước (A → B → A liên tục).
 * 4. Handoff KHÔNG xoá lịch sử: agent mới thấy toàn bộ message cũ;
 *    context chuyển giao là bản sao — agent cũ vẫn giữ bản của nó.
 * 5. Guardrail: một số handoff cần duyệt (vd chuyển sang agent có
 *    quyền ghi / quyền thanh toán) — `requiresApproval` trên agent
 *    đích; chưa duyệt thì handoff ở trạng thái `pending-approval`.
 */

/** Một message trong hội thoại (tối thiểu để chuyển giao — host map từ dạng message thật của nó). */
export interface FleetV22HandoffMessage {
  /** `user` | `assistant` | `system` | `tool`. */
  role: string;
  content: string;
  /** Id agent đã viết message (khi role = assistant). */
  agentId?: string;
  /** Lúc viết (epoch ms). */
  at: number;
}

/** Một agent có thể nhận handoff. */
export interface FleetV22HandoffAgent {
  /** Id duy nhất (phần sau `transfer_to_`: vd `billing` → `transfer_to_billing`). */
  id: string;
  /** Tên hiển thị. */
  name: string;
  /** Mô tả chuyên môn — agent hiện tại dùng để quyết định "có nên chuyển sang agent này". */
  description: string;
  /** Hướng dẫn hệ thống của agent này (agent mới chạy theo hướng dẫn này). */
  instructions: string;
  /** Tool agent này được dùng (allowlist riêng của nó). */
  allowedTools: string[];
  /** true = handoff sang agent này cần user/admin duyệt trước. */
  requiresApproval: boolean;
  /** Chuyên môn (vd `billing`, `coding`, `support`) — để lọc / gợi ý. */
  specialty: string;
}

/** Tên tool chuyển giao cho một agent (`transfer_to_<id>`). */
export function handoffToolNameV22(agentId: string): string {
  return `transfer_to_${agentId.replace(/[^a-zA-Z0-9_]/g, '_')}`;
}

/** Trạng thái của một lần handoff. */
export type FleetV22HandoffStatus = 'pending-approval' | 'transferred' | 'rejected' | 'failed';

/** Mọi trạng thái handoff. */
export const FLEET_V22_HANDOFF_STATUSES: readonly FleetV22HandoffStatus[] = [
  'pending-approval',
  'transferred',
  'rejected',
  'failed',
];

/** Tối đa số lần handoff trong một hội thoại (chống vòng lặp). */
export const MAX_HANDOFFS_PER_CONVERSATION_V22 = 10;

/** Một lần handoff (một bước chuyển trong chuỗi). */
export interface FleetV22Handoff {
  /** Id duy nhất. */
  id: string;
  /** Id hội thoại đang chuyển. */
  conversationId: string;
  /** Agent đang giữ hội thoại trước khi chuyển. */
  fromAgentId: string;
  /** Agent nhận hội thoại. */
  toAgentId: string;
  /** Tên tool chuyển giao đã dùng (vd `transfer_to_billing`). */
  toolName: string;
  /** Lý do chuyển (agent cũ viết — vd "user hỏi về hoá đơn, ngoài chuyên môn của tôi"). */
  reason: string;
  /** Message của user (hoặc message kích hoạt) dẫn tới handoff — để audit. */
  triggerMessage: string | null;
  status: FleetV22HandoffStatus;
  /** Số message đã chuyển giao trong bước này. */
  messagesTransferred: number;
  /** Ai duyệt (khi requiresApproval) — null khi không cần duyệt. */
  approvedBy: string | null;
  /** Lý do từ chối (khi rejected/failed). */
  rejectionReason: string | null;
  /** Id run/bot chứa handoff. */
  runId: string;
  /** Id user sở hữu hội thoại. */
  ownerId: string;
  createdAt: number;
  resolvedAt: number | null;
}

/** Registry agent nhận handoff (đăng ký trước, handoff chỉ tới agent trong này). */
export class FleetV22HandoffAgentRegistry {
  private readonly agents = new Map<string, FleetV22HandoffAgent>();

  /** Đăng ký agent (id trùng → throw). */
  register(agent: FleetV22HandoffAgent): void {
    if (this.agents.has(agent.id)) throw new Error(`Handoff agent "${agent.id}" đã đăng ký rồi.`);
    this.agents.set(agent.id, structuredClone(agent));
  }

  /** Cập nhật agent đã đăng ký (chưa có → throw). */
  update(agent: FleetV22HandoffAgent): void {
    if (!this.agents.has(agent.id)) throw new Error(`Handoff agent "${agent.id}" chưa đăng ký.`);
    this.agents.set(agent.id, structuredClone(agent));
  }

  /** Gỡ đăng ký (không có → false). */
  unregister(agentId: string): boolean {
    return this.agents.delete(agentId);
  }

  get(agentId: string): FleetV22HandoffAgent | undefined {
    const a = this.agents.get(agentId);
    return a ? structuredClone(a) : undefined;
  }

  list(): FleetV22HandoffAgent[] {
    return [...this.agents.values()].map((a) => structuredClone(a));
  }

  /** Agent theo chuyên môn. */
  bySpecialty(specialty: string): FleetV22HandoffAgent[] {
    return this.list().filter((a) => a.specialty === specialty);
  }

  /** Tên các tool chuyển giao đã đăng ký (để agent hiện tại biết mình chuyển đi đâu được). */
  toolNames(): string[] {
    return this.list().map((a) => handoffToolNameV22(a.id));
  }

  get size(): number {
    return this.agents.size;
  }
}

/** Tạo một lần handoff (trạng thái ban đầu theo requiresApproval của agent đích). */
export function createFleetV22Handoff(input: {
  id: string;
  conversationId: string;
  fromAgentId: string;
  toAgent: FleetV22HandoffAgent;
  reason: string;
  triggerMessage?: string | null;
  messagesTransferred: number;
  runId: string;
  ownerId: string;
  now?: number;
}): FleetV22Handoff {
  const now = input.now ?? Date.now();
  return {
    id: input.id,
    conversationId: input.conversationId,
    fromAgentId: input.fromAgentId,
    toAgentId: input.toAgent.id,
    toolName: handoffToolNameV22(input.toAgent.id),
    reason: input.reason,
    triggerMessage: input.triggerMessage ?? null,
    status: input.toAgent.requiresApproval ? 'pending-approval' : 'transferred',
    messagesTransferred: input.messagesTransferred,
    approvedBy: input.toAgent.requiresApproval ? null : 'auto (không cần duyệt)',
    rejectionReason: null,
    runId: input.runId,
    ownerId: input.ownerId,
    createdAt: now,
    resolvedAt: input.toAgent.requiresApproval ? null : now,
  };
}

/** Duyệt một handoff đang chờ (người duyệt ghi rõ id). */
export function approveFleetV22Handoff(
  handoff: FleetV22Handoff,
  approvedBy: string,
  now: number = Date.now(),
): FleetV22Handoff {
  if (handoff.status !== 'pending-approval') {
    throw new Error(`Handoff "${handoff.id}" đang "${handoff.status}" — chỉ handoff chờ duyệt mới approve được.`);
  }
  return { ...handoff, status: 'transferred', approvedBy, resolvedAt: now };
}

/** Từ chối một handoff đang chờ (hội thoại ở lại agent cũ). */
export function rejectFleetV22Handoff(
  handoff: FleetV22Handoff,
  reason: string,
  now: number = Date.now(),
): FleetV22Handoff {
  if (handoff.status !== 'pending-approval') {
    throw new Error(`Handoff "${handoff.id}" đang "${handoff.status}" — chỉ handoff chờ duyệt mới reject được.`);
  }
  return { ...handoff, status: 'rejected', rejectionReason: reason, resolvedAt: now };
}

/** Đánh dấu handoff thất bại khi thực thi (vd agent đích crash khi nhận). */
export function failFleetV22Handoff(
  handoff: FleetV22Handoff,
  reason: string,
  now: number = Date.now(),
): FleetV22Handoff {
  if (handoff.status === 'transferred' || handoff.status === 'rejected') {
    throw new Error(`Handoff "${handoff.id}" đã "${handoff.status}" — không fail được nữa.`);
  }
  return { ...handoff, status: 'failed', rejectionReason: reason, resolvedAt: now };
}

// ---------------------------------------------------------------------------
// Chuỗi handoff (chain) của một hội thoại
// ---------------------------------------------------------------------------

/** Chuỗi handoff của một hội thoại — truy vết ai giữ hội thoại lúc nào. */
export class FleetV22HandoffChain {
  private readonly steps: FleetV22Handoff[] = [];

  constructor(
    readonly conversationId: string,
    readonly initialAgentId: string,
  ) {}

  /** Thêm một bước handoff đã transferred (bước pending/rejected không đổi người giữ). */
  append(handoff: FleetV22Handoff): void {
    if (handoff.conversationId !== this.conversationId) {
      throw new Error(`Handoff "${handoff.id}" thuộc hội thoại "${handoff.conversationId}", không phải "${this.conversationId}".`);
    }
    if (handoff.status !== 'transferred') {
      throw new Error(`Chỉ handoff đã transferred mới được append vào chain (handoff "${handoff.id}" đang "${handoff.status}").`);
    }
    const current = this.currentAgentId();
    if (handoff.fromAgentId !== current) {
      throw new Error(
        `Handoff "${handoff.id}" đi từ "${handoff.fromAgentId}" nhưng hội thoại đang do "${current}" giữ — chain bị lệch.`,
      );
    }
    this.steps.push(structuredClone(handoff));
  }

  /** Agent đang giữ hội thoại (ban đầu là initialAgentId). */
  currentAgentId(): string {
    return this.steps.length === 0 ? this.initialAgentId : this.steps[this.steps.length - 1].toAgentId;
  }

  /** Mọi bước (cũ → mới). */
  list(): FleetV22Handoff[] {
    return this.steps.map((s) => structuredClone(s));
  }

  /** Số lần handoff đã xảy ra. */
  get count(): number {
    return this.steps.length;
  }

  /** true khi hội thoại đã handoff quá số lần cho phép (chống vòng lặp). */
  isOverLimit(maxHandoffs: number = MAX_HANDOFFS_PER_CONVERSATION_V22): boolean {
    return this.steps.length >= maxHandoffs;
  }

  /**
   * true khi handoff tiếp theo sẽ tạo vòng lặp ping-pong: agent đích
   * chính là agent vừa rời ở bước trước (A → B → A...).
   */
  wouldPingPong(toAgentId: string): boolean {
    if (this.steps.length === 0) return false;
    const last = this.steps[this.steps.length - 1];
    return last.fromAgentId === toAgentId;
  }

  /**
   * Kiểm tra một handoff sắp diễn ra: trả về lỗi (rỗng = được phép).
   * Kiểm tra: đích khác agent hiện tại, chưa quá giới hạn, không
   * ping-pong, agent đích đã đăng ký.
   */
  validateNext(
    toAgentId: string,
    agentRegistry: FleetV22HandoffAgentRegistry,
    maxHandoffs: number = MAX_HANDOFFS_PER_CONVERSATION_V22,
  ): string[] {
    const errors: string[] = [];
    const current = this.currentAgentId();
    if (toAgentId === current) errors.push(`Agent đích "${toAgentId}" đang giữ hội thoại rồi — không cần handoff.`);
    if (this.isOverLimit(maxHandoffs)) {
      errors.push(`Hội thoại đã handoff ${this.steps.length} lần (tối đa ${maxHandoffs}) — dừng để chống vòng lặp.`);
    }
    if (this.wouldPingPong(toAgentId)) {
      errors.push(`Handoff sang "${toAgentId}" sẽ quay lại agent vừa rời — ping-pong, không cho phép.`);
    }
    if (!agentRegistry.get(toAgentId)) {
      errors.push(`Agent "${toAgentId}" chưa đăng ký nhận handoff — đăng ký trước khi chuyển.`);
    }
    return errors;
  }

  /** Lịch sử agent đã giữ hội thoại (theo thứ tự). */
  agentTrail(): string[] {
    const trail = [this.initialAgentId];
    for (const step of this.steps) trail.push(step.toAgentId);
    return trail;
  }
}

/**
 * Chuẩn bị context chuyển giao cho agent mới: toàn bộ message cũ (bản
 * sao) + ghi chú handoff (ai chuyển, vì sao) + instructions của agent
 * mới. Agent mới nhận context này và tiếp tục hội thoại.
 */
export function buildHandoffContextV22(input: {
  messages: readonly FleetV22HandoffMessage[];
  handoff: FleetV22Handoff;
  toAgent: FleetV22HandoffAgent;
}): { messages: FleetV22HandoffMessage[]; systemNote: string; instructions: string } {
  const messages = input.messages.map((m) => ({ ...m }));
  const systemNote =
    `Handoff từ agent "${input.handoff.fromAgentId}" sang "${input.handoff.toAgentId}" ` +
    `qua ${input.handoff.toolName} lúc ${new Date(input.handoff.createdAt).toISOString()}. ` +
    `Lý do: ${input.handoff.reason}` +
    (input.handoff.triggerMessage ? ` Kích hoạt bởi: "${input.handoff.triggerMessage}"` : '') +
    ` Đã chuyển ${messages.length} message. Bạn là agent tiếp quản — tiếp tục hội thoại, đừng hỏi lại những gì user đã nói.`;
  return { messages, systemNote, instructions: input.toAgent.instructions };
}

/** Gợi ý agent nhận handoff theo từ khoá trong mô tả chuyên môn (điểm khớp đơn giản, không dùng model). */
export function suggestHandoffAgentsV22(
  registry: FleetV22HandoffAgentRegistry,
  query: string,
  limit = 3,
): { agent: FleetV22HandoffAgent; score: number }[] {
  const words = query.toLowerCase().split(/[^a-z0-9à-ỹ]+/i).filter((w) => w.length >= 3);
  const scored = registry.list().map((agent) => {
    const haystack = `${agent.name} ${agent.description} ${agent.specialty} ${agent.instructions}`.toLowerCase();
    let score = 0;
    for (const word of words) {
      if (haystack.includes(word)) score += 1;
    }
    return { agent, score };
  });
  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || a.agent.id.localeCompare(b.agent.id))
    .slice(0, limit);
}

/** Validate agent handoff từ dữ liệu ngoài (lỗi → danh sách). */
export function validateFleetV22HandoffAgent(input: unknown): string[] {
  const errors: string[] = [];
  if (typeof input !== 'object' || input === null) return ['handoff agent phải là object.'];
  const a = input as Record<string, unknown>;
  if (typeof a.id !== 'string' || a.id.trim().length === 0) errors.push('handoff agent.id phải là chuỗi không rỗng.');
  if (typeof a.id === 'string' && !/^[a-zA-Z0-9_]+$/.test(a.id)) {
    errors.push('handoff agent.id chỉ gồm chữ, số và gạch dưới (để ghép tên tool transfer_to_<id>).');
  }
  if (typeof a.description !== 'string' || a.description.trim().length === 0) {
    errors.push('handoff agent.description phải là chuỗi không rỗng.');
  }
  if (typeof a.instructions !== 'string' || a.instructions.trim().length === 0) {
    errors.push('handoff agent.instructions phải là chuỗi không rỗng.');
  }
  if (!Array.isArray(a.allowedTools)) errors.push('handoff agent.allowedTools phải là mảng tên tool.');
  return errors;
}

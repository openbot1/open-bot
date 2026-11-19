/**
 * Confirmation policy (v1.40, Doi T3) — y tuong tu OpenHands V1 SDK
 * Confirmation policy (chi hoc y tuong, khong copy code/text cua repo nao).
 *
 * - `AlwaysConfirm`: moi tool call deu pause cho user xac nhan.
 * - `NeverConfirm`: khong bao gio pause (chi dung khi user tin agent).
 * - `ConfirmRisky(threshold)`: chi pause khi risk >= threshold
 *   (mac dinh HIGH). UNKNOWN duoc tinh nhu HIGH (fail-closed).
 * - Tool call bi pause o trang thai `WAITING_FOR_CONFIRMATION` cho den
 *   khi user approve/reject (hoac het han theo TTL).
 * - Moi quyet dinh (approve/reject/expire + ca truong hop khong can
 *   confirm) deu ghi log de audit day du cung voi log route + risk.
 *
 * Thuan logic (khong goi model that). Host chiu trach nhiem dung
 * vong lap conversation khi co pending (khong tu chay tool).
 */

import { riskAtLeast, type SecurityRisk } from './riskScoringV117';

export type ConfirmPolicyMode = 'AlwaysConfirm' | 'NeverConfirm' | 'ConfirmRisky';

export const CONFIRM_POLICY_MODES: readonly ConfirmPolicyMode[] = [
  'AlwaysConfirm',
  'NeverConfirm',
  'ConfirmRisky',
];

export interface ConfirmPolicy {
  mode: ConfirmPolicyMode;
  /** Nguong cho ConfirmRisky (mac dinh HIGH). */
  threshold: SecurityRisk;
  /** Thoi gian cho toi da truoc khi pending het han (ms, mac dinh 10 phut). */
  ttlMs: number;
  /** So pending toi da giu cung luc (mac dinh 50). */
  maxPending: number;
}

export type PendingConfirmationStatus =
  | 'WAITING_FOR_CONFIRMATION'
  | 'APPROVED'
  | 'REJECTED'
  | 'EXPIRED';

export interface PendingConfirmation {
  id: string;
  toolName: string;
  argsSummary: string;
  risk: SecurityRisk;
  score: number | null;
  status: PendingConfirmationStatus;
  createdAt: number;
  expiresAt: number;
  decidedAt?: number;
  decidedBy?: string;
  decisionReason?: string;
}

export type ConfirmDecisionKind = 'APPROVED' | 'REJECTED' | 'EXPIRED' | 'AUTO_ALLOWED';

export interface ConfirmDecisionRecord {
  id: string;
  pendingId: string | null;
  toolName: string;
  risk: SecurityRisk;
  decision: ConfirmDecisionKind;
  decidedAt: number;
  decidedBy?: string;
  reason?: string;
}

export function defaultConfirmPolicy(): ConfirmPolicy {
  return {
    mode: 'ConfirmRisky',
    threshold: 'HIGH',
    ttlMs: 10 * 60 * 1000,
    maxPending: 50,
  };
}

/**
 * Override xac nhan theo tung tool — uu tien hon policy chung:
 * - `always`: luon pause tool nay (ke ca khi risk thap), vd shell_exec.
 * - `never`: khong bao gio pause tool nay (chi dung cho tool da tin),
 *   vd mot tool chi doc noi bo.
 * - `default`: dung policy chung (mac dinh khi chua dat override).
 */
export type ToolConfirmOverride = 'always' | 'never' | 'default';

export const TOOL_CONFIRM_OVERRIDES: readonly ToolConfirmOverride[] = ['always', 'never', 'default'];

export interface SubmitToolCallResult {
  /** true = phai doi user xac nhan truoc khi chay tool. */
  requiresConfirmation: boolean;
  pending?: PendingConfirmation;
  /** Ly do (de log/audit). */
  reason: string;
}

let confirmCounter = 0;
let confirmDecisionCounter = 0;

/**
 * ConfirmationGate — giu policy + hang doi cho xac nhan + log quyet dinh.
 */
export class ConfirmationGate {
  private policy: ConfirmPolicy;
  private readonly pending = new Map<string, PendingConfirmation>();
  private readonly decisions: ConfirmDecisionRecord[] = [];
  private readonly decisionsCapacity: number;
  private readonly toolOverrides = new Map<string, ToolConfirmOverride>();

  constructor(policy?: Partial<ConfirmPolicy>, decisionsCapacity = 200) {
    this.policy = { ...defaultConfirmPolicy(), ...(policy ?? {}) };
    this.decisionsCapacity = Math.max(1, decisionsCapacity);
  }

  getPolicy(): ConfirmPolicy {
    return { ...this.policy };
  }

  setPolicy(partial: Partial<ConfirmPolicy>): ConfirmPolicy {
    if (partial.mode !== undefined && !CONFIRM_POLICY_MODES.includes(partial.mode)) {
      throw new Error(`mode phai la mot trong: ${CONFIRM_POLICY_MODES.join(', ')}.`);
    }
    if (partial.threshold !== undefined
      && !['LOW', 'MEDIUM', 'HIGH', 'UNKNOWN'].includes(partial.threshold)) {
      throw new Error('threshold phai la LOW, MEDIUM, HIGH hoac UNKNOWN.');
    }
    if (partial.ttlMs !== undefined
      && (typeof partial.ttlMs !== 'number' || partial.ttlMs <= 0)) {
      throw new Error('ttlMs phai la so > 0.');
    }
    if (partial.maxPending !== undefined
      && (!Number.isInteger(partial.maxPending) || partial.maxPending < 1)) {
      throw new Error('maxPending phai la so nguyen >= 1.');
    }
    this.policy = { ...this.policy, ...partial };
    return this.getPolicy();
  }

  /** Tool call co risk nay co can xac nhan khong (theo policy hien tai). */
  requiresConfirmation(risk: SecurityRisk, toolName?: string): boolean {
    if (toolName !== undefined) {
      const override = this.toolOverrides.get(toolName);
      if (override === 'always') return true;
      if (override === 'never') return false;
    }
    if (this.policy.mode === 'AlwaysConfirm') return true;
    if (this.policy.mode === 'NeverConfirm') return false;
    return riskAtLeast(risk, this.policy.threshold);
  }

  /** Dat override xac nhan cho mot tool ('default' = xoa override). */
  setToolOverride(toolName: string, override: ToolConfirmOverride): ToolConfirmOverride {
    if (typeof toolName !== 'string' || toolName.trim() === '') {
      throw new Error('toolName phai la string khong rong.');
    }
    if (!TOOL_CONFIRM_OVERRIDES.includes(override)) {
      throw new Error(`override phai la mot trong: ${TOOL_CONFIRM_OVERRIDES.join(', ')}.`);
    }
    if (override === 'default') {
      this.toolOverrides.delete(toolName);
    } else {
      this.toolOverrides.set(toolName, override);
    }
    return override;
  }

  getToolOverride(toolName: string): ToolConfirmOverride {
    return this.toolOverrides.get(toolName) ?? 'default';
  }

  listToolOverrides(): Array<{ toolName: string; override: ToolConfirmOverride }> {
    return [...this.toolOverrides.entries()]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([toolName, override]) => ({ toolName, override }));
  }

  private recordDecision(record: Omit<ConfirmDecisionRecord, 'id'>): ConfirmDecisionRecord {
    const full: ConfirmDecisionRecord = { ...record, id: `confirm-decision-${++confirmDecisionCounter}` };
    this.decisions.push(full);
    if (this.decisions.length > this.decisionsCapacity) {
      this.decisions.splice(0, this.decisions.length - this.decisionsCapacity);
    }
    return full;
  }

  /**
   * Nop mot tool call (da cham risk) vao gate. Neu can xac nhan thi
   * tao pending WAITING_FOR_CONFIRMATION; neu khong thi ghi log
   * AUTO_ALLOWED va tra requiresConfirmation=false.
   */
  submit(
    toolName: string,
    args: unknown,
    risk: SecurityRisk,
    score: number | null,
    now = Date.now(),
  ): SubmitToolCallResult {
    if (typeof toolName !== 'string' || toolName.trim() === '') {
      throw new Error('toolName phai la string khong rong.');
    }
    if (!this.requiresConfirmation(risk, toolName)) {
      const override = this.toolOverrides.get(toolName);
      this.recordDecision({
        pendingId: null,
        toolName,
        risk,
        decision: 'AUTO_ALLOWED',
        decidedAt: now,
        reason: (override === 'never'
          ? `Override "never" cho tool ${toolName}`
          : `Policy ${this.policy.mode}`
            + (this.policy.mode === 'ConfirmRisky' ? `(threshold=${this.policy.threshold})` : ''))
          + ` — risk ${risk} khong can xac nhan.`,
      });
      return {
        requiresConfirmation: false,
        reason: `Risk ${risk} duoi nguong — cho chay ngay theo policy ${this.policy.mode}.`,
      };
    }
    if (this.pendingCount() >= this.policy.maxPending) {
      throw new Error(`Hang doi xac nhan da day (${this.policy.maxPending} pending) — xu ly het truoc khi nop them.`);
    }
    const pending: PendingConfirmation = {
      id: `confirm-${++confirmCounter}`,
      toolName,
      argsSummary: args === undefined || args === null
        ? '(no args)'
        : JSON.stringify(args).slice(0, 240),
      risk,
      score,
      status: 'WAITING_FOR_CONFIRMATION',
      createdAt: now,
      expiresAt: now + this.policy.ttlMs,
    };
    this.pending.set(pending.id, pending);
    return {
      requiresConfirmation: true,
      pending: { ...pending },
      reason: `Risk ${risk} — pause o WAITING_FOR_CONFIRMATION cho user xac nhan (id ${pending.id}).`,
    };
  }

  pendingCount(): number {
    let count = 0;
    for (const p of this.pending.values()) {
      if (p.status === 'WAITING_FOR_CONFIRMATION') count += 1;
    }
    return count;
  }

  listPending(): PendingConfirmation[] {
    return [...this.pending.values()]
      .filter((p) => p.status === 'WAITING_FOR_CONFIRMATION')
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((p) => ({ ...p }));
  }

  getPending(id: string): PendingConfirmation | undefined {
    const found = this.pending.get(id);
    return found ? { ...found } : undefined;
  }

  approve(id: string, by = 'user', now = Date.now()): PendingConfirmation {
    const pending = this.pending.get(id);
    if (!pending) throw new Error(`Khong co yeu cau xac nhan nao co id "${id}".`);
    if (pending.status !== 'WAITING_FOR_CONFIRMATION') {
      throw new Error(`Yeu cau "${id}" da o trang thai ${pending.status}, khong the approve.`);
    }
    pending.status = 'APPROVED';
    pending.decidedAt = now;
    pending.decidedBy = by;
    this.recordDecision({
      pendingId: id,
      toolName: pending.toolName,
      risk: pending.risk,
      decision: 'APPROVED',
      decidedAt: now,
      decidedBy: by,
    });
    return { ...pending };
  }

  reject(id: string, by = 'user', reason?: string, now = Date.now()): PendingConfirmation {
    const pending = this.pending.get(id);
    if (!pending) throw new Error(`Khong co yeu cau xac nhan nao co id "${id}".`);
    if (pending.status !== 'WAITING_FOR_CONFIRMATION') {
      throw new Error(`Yeu cau "${id}" da o trang thai ${pending.status}, khong the reject.`);
    }
    pending.status = 'REJECTED';
    pending.decidedAt = now;
    pending.decidedBy = by;
    pending.decisionReason = reason;
    this.recordDecision({
      pendingId: id,
      toolName: pending.toolName,
      risk: pending.risk,
      decision: 'REJECTED',
      decidedAt: now,
      decidedBy: by,
      reason,
    });
    return { ...pending };
  }

  /**
   * Quet het han: pending nao qua expiresAt thi chuyen EXPIRED + ghi log.
   * Tra danh sach id vua het han.
   */
  sweepExpired(now = Date.now()): string[] {
    const expired: string[] = [];
    for (const pending of this.pending.values()) {
      if (pending.status === 'WAITING_FOR_CONFIRMATION' && now >= pending.expiresAt) {
        pending.status = 'EXPIRED';
        pending.decidedAt = now;
        expired.push(pending.id);
        this.recordDecision({
          pendingId: pending.id,
          toolName: pending.toolName,
          risk: pending.risk,
          decision: 'EXPIRED',
          decidedAt: now,
          reason: `Het han sau ${this.policy.ttlMs}ms cho xac nhan.`,
        });
      }
    }
    return expired;
  }

  getDecisionLog(): ConfirmDecisionRecord[] {
    return [...this.decisions].reverse().map((d) => ({ ...d }));
  }

  /** Tat ca pending (ca da quyet dinh) — de audit. */
  listAllPending(): PendingConfirmation[] {
    return [...this.pending.values()]
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((p) => ({ ...p }));
  }

  clearLogs(): void {
    this.decisions.length = 0;
    this.pending.clear();
  }
}

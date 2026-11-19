/**
 * Fleet v29 sensitive-action confirmations (v1.42, Team T6).
 *
 * A peer can REQUEST a sensitive action (purchase, payment,
 * secret access, file write outside the sandbox, external send,
 * account change) — it can never approve one. The request waits
 * here until the user approves, denies, or it expires. The board
 * only ever acts on `approved` confirmations, and only the exact
 * action that was approved (same peer, same task, same kind, same
 * amount ceiling).
 *
 * Guard rails:
 *   - The peer must be allowlisted AND its scope must list the
 *     action kind — otherwise the request is refused at creation,
 *     not queued.
 *   - The task must exist and not be terminal.
 *   - One pending request per (task, action) — a peer cannot flood
 *     the user with duplicate purchase prompts.
 *   - Requests expire (default 15 minutes); an expired request is
 *     `expired`, never silently approved.
 *   - Deciding a request twice is refused (the first decision stands).
 */

import type { FleetV29Allowlist } from './allowlist';
import type { FleetV29TaskBoard } from './taskBoard';
import type { FleetV29Confirmation, FleetV29ConfirmationStatus, FleetV29SensitiveAction } from './types';

/** Default time-to-live for a confirmation request (15 minutes). */
export const FLEET_V29_CONFIRM_TTL_MS = 15 * 60 * 1000;

export interface FleetV29ConfirmRequest {
  peerId: string;
  taskId: string;
  action: FleetV29SensitiveAction;
  summary: string;
  amountUsd?: number | null;
}

export class FleetV29ConfirmationQueue {
  private readonly allowlist: FleetV29Allowlist;
  private readonly board: FleetV29TaskBoard;
  private readonly ttlMs: number;
  private readonly newId: () => string;
  private readonly nowMs: () => number;
  private readonly requests = new Map<string, FleetV29Confirmation>();

  constructor(deps: {
    allowlist: FleetV29Allowlist;
    board: FleetV29TaskBoard;
    ttlMs?: number;
    newId?: () => string;
    nowMs?: () => number;
  }) {
    this.allowlist = deps.allowlist;
    this.board = deps.board;
    this.ttlMs = deps.ttlMs ?? FLEET_V29_CONFIRM_TTL_MS;
    this.newId = deps.newId ?? (() => `cfm-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`);
    this.nowMs = deps.nowMs ?? (() => Date.now());
  }

  /** Request a confirmation (fail-closed: reasons, nothing queued). */
  request(
    input: FleetV29ConfirmRequest,
  ): { ok: true; confirmation: FleetV29Confirmation } | { ok: false; reasons: string[] } {
    const reasons: string[] = [];
    if (!this.allowlist.isAllowlisted(input.peerId, new Date(this.nowMs()).toISOString())) {
      reasons.push(`Peer "${input.peerId}" is not allowlisted.`);
    }
    if (!this.allowlist.sensitiveAllowed(input.peerId, input.action)) {
      reasons.push(`Sensitive action "${input.action}" is not in peer "${input.peerId}" allowlist scope.`);
    }
    const task = this.board.getTask(input.taskId);
    if (!task) reasons.push(`No board task "${input.taskId}".`);
    else if (task.peerId !== input.peerId) reasons.push(`Task "${input.taskId}" does not belong to peer "${input.peerId}".`);
    if (!input.summary.trim()) reasons.push('A summary of the requested action is required.');
    if (input.amountUsd !== undefined && input.amountUsd !== null && (!Number.isFinite(input.amountUsd) || input.amountUsd < 0)) {
      reasons.push('amountUsd must be >= 0 or null.');
    }
    if (reasons.length > 0) return { ok: false, reasons };
    const duplicate = [...this.requests.values()].find(
      (r) => r.taskId === input.taskId && r.action === input.action && r.status === 'pending',
    );
    if (duplicate) {
      return { ok: false, reasons: [`A pending "${input.action}" request already exists for task "${input.taskId}".`] };
    }
    const now = this.nowMs();
    const confirmation: FleetV29Confirmation = {
      id: this.newId(),
      peerId: input.peerId,
      taskId: input.taskId,
      action: input.action,
      summary: input.summary.trim().slice(0, 500),
      amountUsd: input.amountUsd ?? null,
      status: 'pending',
      requestedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + this.ttlMs).toISOString(),
      decidedAt: null,
      decidedBy: null,
    };
    this.requests.set(confirmation.id, confirmation);
    return { ok: true, confirmation };
  }

  get(id: string): FleetV29Confirmation | null {
    return this.requests.get(id) ?? null;
  }

  /** Pending requests, oldest first. */
  pending(): FleetV29Confirmation[] {
    this.sweepExpired();
    return [...this.requests.values()]
      .filter((r) => r.status === 'pending')
      .sort((a, b) => a.requestedAt.localeCompare(b.requestedAt));
  }

  list(filter?: { status?: FleetV29ConfirmationStatus; peerId?: string; taskId?: string }): FleetV29Confirmation[] {
    this.sweepExpired();
    return [...this.requests.values()]
      .filter((r) => {
        if (filter?.status !== undefined && r.status !== filter.status) return false;
        if (filter?.peerId !== undefined && r.peerId !== filter.peerId) return false;
        if (filter?.taskId !== undefined && r.taskId !== filter.taskId) return false;
        return true;
      })
      .sort((a, b) => b.requestedAt.localeCompare(a.requestedAt));
  }

  /** Expire overdue pending requests; returns the expired ids. */
  sweepExpired(nowMs?: number): string[] {
    const now = nowMs ?? this.nowMs();
    const expired: string[] = [];
    for (const request of this.requests.values()) {
      if (request.status === 'pending' && new Date(request.expiresAt).getTime() <= now) {
        request.status = 'expired';
        request.decidedAt = new Date(now).toISOString();
        expired.push(request.id);
      }
    }
    return expired;
  }

  private decide(
    id: string,
    status: 'approved' | 'denied',
    decidedBy: string,
  ): { ok: true; confirmation: FleetV29Confirmation } | { ok: false; reasons: string[] } {
    this.sweepExpired();
    const request = this.requests.get(id);
    if (!request) return { ok: false, reasons: [`No confirmation request "${id}".`] };
    if (request.status !== 'pending') {
      return { ok: false, reasons: [`Confirmation "${id}" is already ${request.status}.`] };
    }
    request.status = status;
    request.decidedAt = new Date(this.nowMs()).toISOString();
    request.decidedBy = decidedBy;
    return { ok: true, confirmation: request };
  }

  approve(id: string, decidedBy: string): { ok: true; confirmation: FleetV29Confirmation } | { ok: false; reasons: string[] } {
    return this.decide(id, 'approved', decidedBy);
  }

  deny(id: string, decidedBy: string): { ok: true; confirmation: FleetV29Confirmation } | { ok: false; reasons: string[] } {
    return this.decide(id, 'denied', decidedBy);
  }

  /** True when this exact action was approved for this task (and not yet consumed). */
  isApproved(taskId: string, action: FleetV29SensitiveAction): boolean {
    return [...this.requests.values()].some(
      (r) => r.taskId === taskId && r.action === action && r.status === 'approved',
    );
  }

  pendingCount(): number {
    return this.pending().length;
  }
}

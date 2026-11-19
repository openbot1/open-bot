/**
 * Fleet v29 A2A task board (v1.42, Team T6).
 *
 * The board is the fleet's coordination surface for A2A tasks: one
 * entry per delegated task, with its A2A state, streaming progress,
 * cost, latency, and the peer it runs on. It owns the delegation
 * gate and the task lifecycle — it does NOT own the wire transport.
 *
 * Delegation gate (fail-closed, in order — first failure stops the
 * delegation and is reported, nothing is sent):
 *   1. Peer is registered.
 *   2. Peer is on the allowlist (live entry: not suspended, not expired).
 *   3. Peer's card verifies (`verified`, or `unsigned` when the card
 *      policy allows it) — a `stale` / `invalid` / `unverified` card
 *      blocks delegation even for an allowlisted peer.
 *   4. Requested skill + operation are inside the allowlist scope.
 *   5. Peer is under its concurrency cap.
 *   6. Requested operation is supported by the peer's card
 *      (streaming needs `capabilities.streaming`).
 *
 * Transport handoff (Team T1, A2A v11): the board accepts a
 * `FleetV29TransportPort`. When a port with `sendMessage` is
 * wired, `submit()` hands the message to the real transport and
 * tracks the returned task. When no port is wired, the board runs
 * in LOCAL-SIMULATION mode: it creates a board task in `submitted`
 * state and marks it `simulated: true` in metadata — the UI shows
 * it as a simulation, and the audit entry says so. The board never
 * pretends a simulated task reached a real peer.
 *
 * State changes go through the A2A legal-transition table
 * (`a2a/history.ts`): illegal transitions are refused (the caller
 * gets the reason), never silently recorded as legal. Streaming
 * progress is a `working → working` self-transition with partial
 * text; `input-required` parks the task until the user answers;
 * cancel is user-initiated or peer-initiated, recorded distinctly.
 */

import { appendA2aTransition, isLegalA2aTransition, makeA2aTransition } from '../a2a/history';
import { isA2aTerminalState } from '../a2a/types';
import type { A2aTask, A2aTaskState } from '../a2a/types';
import type { FleetV29Allowlist } from './allowlist';
import type { FleetV29PeerRegistry } from './peerRegistry';
import type {
  FleetV29BoardFilter,
  FleetV29BoardTask,
  FleetV29DelegateRequest,
  FleetV29DelegateResult,
  FleetV29TaskPage,
  FleetV29TransportPort,
} from './types';
import { fleetV29CardStatusUsable } from './cardVerify';

export const FLEET_V29_BOARD_PAGE_SIZE = 20;
export const FLEET_V29_MAX_PARTIAL_TEXT = 500;

/** Events the board emits (UI subscribes; the host forwards to SSE later). */
export type FleetV29BoardEvent =
  | { kind: 'task-created'; task: FleetV29BoardTask }
  | { kind: 'state-changed'; task: FleetV29BoardTask; from: A2aTaskState; to: A2aTaskState }
  | { kind: 'progress'; task: FleetV29BoardTask; partialText: string }
  | { kind: 'task-cancelled'; task: FleetV29BoardTask; byUser: boolean }
  | { kind: 'input-required'; task: FleetV29BoardTask; question: string };

export type FleetV29BoardListener = (event: FleetV29BoardEvent) => void;

export interface FleetV29BoardDeps {
  registry: FleetV29PeerRegistry;
  allowlist: FleetV29Allowlist;
  /** Optional transport (T1 A2A v11). Absent = local-simulation mode. */
  transport?: FleetV29TransportPort;
  /** Id generator (tests inject a deterministic one). */
  newId?: () => string;
  /** Clock (tests inject a fixed one). */
  nowIso?: () => string;
}

function defaultId(): string {
  return `task-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
}

export class FleetV29TaskBoard {
  private readonly registry: FleetV29PeerRegistry;
  private readonly allowlist: FleetV29Allowlist;
  private readonly transport: FleetV29TransportPort | undefined;
  private readonly newId: () => string;
  private readonly nowIso: () => string;
  private readonly tasks = new Map<string, FleetV29BoardTask>();
  private readonly listeners = new Set<FleetV29BoardListener>();

  constructor(deps: FleetV29BoardDeps) {
    this.registry = deps.registry;
    this.allowlist = deps.allowlist;
    this.transport = deps.transport;
    this.newId = deps.newId ?? defaultId;
    this.nowIso = deps.nowIso ?? (() => new Date().toISOString());
  }

  /** True when a real A2A transport is wired (false = local simulation). */
  get transportWired(): boolean {
    return typeof this.transport?.sendMessage === 'function';
  }

  onEvent(listener: FleetV29BoardListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(event: FleetV29BoardEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // A listener must never break the board.
      }
    }
  }

  /** The full delegation gate — returns every blocking reason (empty = pass). */
  checkDelegation(request: FleetV29DelegateRequest): string[] {
    const reasons: string[] = [];
    const peer = this.registry.getPeer(request.peerId);
    if (!peer) {
      reasons.push(`Peer "${request.peerId}" is not registered.`);
      return reasons;
    }
    const now = this.nowIso();
    if (!this.allowlist.isAllowlisted(request.peerId, now)) {
      const entry = this.allowlist.get(request.peerId);
      if (!entry) reasons.push(`Peer "${request.peerId}" is not on the allowlist.`);
      else if (entry.suspended) reasons.push(`Peer "${request.peerId}" is suspended on the allowlist.`);
      else reasons.push(`Peer "${request.peerId}" allowlist entry has expired.`);
    }
    if (!fleetV29CardStatusUsable(peer.cardStatus)) {
      reasons.push(
        `Peer "${request.peerId}" card is ${peer.cardStatus} — re-verify the Agent Card before delegating.`,
      );
    }
    const operation = request.operation ?? (peer.card.capabilities?.streaming ? 'SendStreamingMessage' : 'SendMessage');
    if (!this.allowlist.operationAllowed(request.peerId, operation)) {
      reasons.push(`Operation ${operation} is not in peer "${request.peerId}" allowlist scope.`);
    }
    if (request.skillId !== undefined && !this.allowlist.skillAllowed(request.peerId, request.skillId)) {
      reasons.push(`Skill "${request.skillId}" is not in peer "${request.peerId}" allowlist scope.`);
    }
    if (operation === 'SendStreamingMessage' && peer.card.capabilities?.streaming !== true) {
      reasons.push(`Peer "${request.peerId}" does not advertise streaming support.`);
    }
    const entry = this.allowlist.get(request.peerId);
    if (entry) {
      const active = this.activeCountForPeer(request.peerId);
      if (active >= entry.scope.maxConcurrentTasks) {
        reasons.push(
          `Peer "${request.peerId}" is at its concurrency cap (${entry.scope.maxConcurrentTasks} active tasks).`,
        );
      }
    }
    if (!request.title.trim()) reasons.push('A task title is required.');
    if (!request.messageText.trim()) reasons.push('A message to send is required.');
    return reasons;
  }

  /**
   * Delegate a task to a peer. In transport mode the message is sent
   * through T1's A2A v11 client; in simulation mode a local board
   * task is created and flagged `simulated`. Either way the gate
   * runs first and a failed gate sends nothing.
   */
  async submit(request: FleetV29DelegateRequest): Promise<FleetV29DelegateResult> {
    const reasons = this.checkDelegation(request);
    if (reasons.length > 0) return { ok: false, reasons };
    const peer = this.registry.getPeer(request.peerId) as NonNullable<ReturnType<FleetV29PeerRegistry['getPeer']>>;
    const now = this.nowIso();
    const operation = request.operation ?? (peer.card.capabilities?.streaming ? 'SendStreamingMessage' : 'SendMessage');
    const contextId = request.contextId ?? `ctx-${this.newId()}`;
    const simulated = !this.transportWired;
    let a2aTask: A2aTask;
    if (!simulated && this.transport?.sendMessage) {
      try {
        a2aTask = await this.transport.sendMessage({
          peerId: request.peerId,
          peerUrl: peer.card.url,
          messageText: request.messageText,
          contextId,
          streaming: operation === 'SendStreamingMessage',
        });
      } catch (err) {
        return { ok: false, reasons: [`A2A send failed: ${err instanceof Error ? err.message : String(err)}`] };
      }
    } else {
      const taskId = this.newId();
      a2aTask = {
        id: taskId,
        contextId,
        status: { state: 'submitted', timestamp: now },
        transitions: [makeA2aTransition(null, 'submitted', now)],
        metadata: { simulated: true, operation },
        ...(request.tenantId !== undefined ? { tenantId: request.tenantId } : {}),
      };
    }
    const boardTask: FleetV29BoardTask = {
      task: a2aTask,
      peerId: request.peerId,
      delegatedBy: request.delegatedBy,
      title: request.title.trim(),
      createdAt: now,
      updatedAt: now,
      progress: null,
      partialText: '',
      progressEvents: 0,
      costUsd: 0,
      lastLatencyMs: null,
      awaitingInput: false,
      inputQuestion: null,
      confirmationIds: [],
      cancelledByUser: false,
      cancelReason: null,
      pageCursor: null,
    };
    this.tasks.set(a2aTask.id, boardTask);
    this.registry.markSeen(request.peerId, now);
    this.emit({ kind: 'task-created', task: boardTask });
    return { ok: true, boardTask };
  }

  getTask(taskId: string): FleetV29BoardTask | null {
    return this.tasks.get(taskId) ?? null;
  }

  /** List board tasks with A2A 1.0 cursor pagination (opaque base64 offset cursor). */
  listTasks(filter?: FleetV29BoardFilter, cursor?: string | null, pageSize = FLEET_V29_BOARD_PAGE_SIZE): FleetV29TaskPage {
    const size = Math.max(1, Math.min(100, Math.floor(pageSize) || FLEET_V29_BOARD_PAGE_SIZE));
    let offset = 0;
    if (cursor) {
      try {
        const decoded = Buffer.from(cursor, 'base64').toString('utf-8');
        const parsed = Number.parseInt(decoded, 10);
        if (Number.isFinite(parsed) && parsed >= 0) offset = parsed;
      } catch {
        offset = 0;
      }
    }
    const query = filter?.query?.trim().toLowerCase();
    const matched = [...this.tasks.values()]
      .filter((t) => {
        if (filter?.peerId !== undefined && t.peerId !== filter.peerId) return false;
        if (filter?.state !== undefined && t.task.status.state !== filter.state) return false;
        if (filter?.activeOnly && isA2aTerminalState(t.task.status.state)) return false;
        if (filter?.delegatedBy !== undefined && t.delegatedBy !== filter.delegatedBy) return false;
        if (filter?.tenantId !== undefined && t.task.tenantId !== filter.tenantId) return false;
        if (query && !t.title.toLowerCase().includes(query) && !t.task.id.toLowerCase().includes(query)) return false;
        return true;
      })
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.task.id.localeCompare(a.task.id));
    const page = matched.slice(offset, offset + size);
    const nextOffset = offset + page.length;
    return {
      tasks: page,
      nextCursor: nextOffset < matched.length ? Buffer.from(String(nextOffset)).toString('base64') : null,
      total: matched.length,
    };
  }

  /** Active (non-terminal) tasks for one peer. */
  activeCountForPeer(peerId: string): number {
    let n = 0;
    for (const t of this.tasks.values()) {
      if (t.peerId === peerId && !isA2aTerminalState(t.task.status.state)) n += 1;
    }
    return n;
  }

  activeTasksByPeer(): Map<string, number> {
    const out = new Map<string, number>();
    for (const t of this.tasks.values()) {
      if (isA2aTerminalState(t.task.status.state)) continue;
      out.set(t.peerId, (out.get(t.peerId) ?? 0) + 1);
    }
    return out;
  }

  /** Change a task's state (guarded by the A2A legal-transition table). */
  transition(
    taskId: string,
    to: A2aTaskState,
    note?: string,
  ): { ok: true; task: FleetV29BoardTask } | { ok: false; reasons: string[] } {
    const boardTask = this.tasks.get(taskId);
    if (!boardTask) return { ok: false, reasons: [`No board task "${taskId}".`] };
    const from = boardTask.task.status.state;
    if (!isLegalA2aTransition(from, to)) {
      return { ok: false, reasons: [`Illegal A2A transition ${from} → ${to} for task "${taskId}".`] };
    }
    const now = this.nowIso();
    boardTask.task.transitions = appendA2aTransition(
      boardTask.task.transitions,
      makeA2aTransition(from, to, now, note),
    );
    boardTask.task.status = { state: to, timestamp: now };
    boardTask.updatedAt = now;
    if (to === 'input-required') {
      boardTask.awaitingInput = true;
      boardTask.inputQuestion = note ?? null;
      this.emit({ kind: 'input-required', task: boardTask, question: boardTask.inputQuestion ?? '' });
    } else if (to === 'working') {
      boardTask.awaitingInput = false;
      boardTask.inputQuestion = null;
    }
    if (isA2aTerminalState(to)) {
      this.registry.recordTaskOutcome(boardTask.peerId, to === 'completed' ? 'completed' : 'failed');
    }
    this.emit({ kind: 'state-changed', task: boardTask, from, to });
    return { ok: true, task: boardTask };
  }

  /** Streaming progress: working → working self-transition + partial text. */
  progress(taskId: string, partialText: string, progress: number | null): FleetV29BoardTask | null {
    const boardTask = this.tasks.get(taskId);
    if (!boardTask) return null;
    if (boardTask.task.status.state !== 'working') return null;
    const now = this.nowIso();
    boardTask.partialText = partialText.slice(-FLEET_V29_MAX_PARTIAL_TEXT);
    boardTask.progress = progress === null ? null : Math.max(0, Math.min(1, progress));
    boardTask.progressEvents += 1;
    boardTask.updatedAt = now;
    this.emit({ kind: 'progress', task: boardTask, partialText: boardTask.partialText });
    return boardTask;
  }

  /** Start a submitted task (submitted → working). */
  start(taskId: string): { ok: true; task: FleetV29BoardTask } | { ok: false; reasons: string[] } {
    return this.transition(taskId, 'working');
  }

  /** Complete a task (working/input-required → completed). */
  complete(taskId: string, resultText?: string): { ok: true; task: FleetV29BoardTask } | { ok: false; reasons: string[] } {
    const boardTask = this.tasks.get(taskId);
    if (!boardTask) return { ok: false, reasons: [`No board task "${taskId}".`] };
    if (resultText !== undefined && resultText.trim()) {
      boardTask.task.artifacts = [
        ...(boardTask.task.artifacts ?? []),
        { artifactId: `art-${this.newId()}`, name: 'result', parts: [{ kind: 'text', text: resultText.slice(0, 5000) }] },
      ];
    }
    return this.transition(taskId, 'completed');
  }

  /** Fail a task with a reason. */
  fail(taskId: string, reason: string): { ok: true; task: FleetV29BoardTask } | { ok: false; reasons: string[] } {
    return this.transition(taskId, 'failed', reason);
  }

  /** Cancel a task (user or peer). Cancelling a terminal task is refused. */
  async cancel(
    taskId: string,
    byUser: boolean,
    reason?: string,
  ): Promise<{ ok: true; task: FleetV29BoardTask } | { ok: false; reasons: string[] }> {
    const boardTask = this.tasks.get(taskId);
    if (!boardTask) return { ok: false, reasons: [`No board task "${taskId}".`] };
    if (isA2aTerminalState(boardTask.task.status.state)) {
      return { ok: false, reasons: [`Task "${taskId}" is already ${boardTask.task.status.state}.`] };
    }
    if (this.transportWired && this.transport?.cancelTask) {
      try {
        const peer = this.registry.getPeer(boardTask.peerId);
        if (peer) await this.transport.cancelTask({ peerId: boardTask.peerId, peerUrl: peer.card.url, taskId });
      } catch (err) {
        return { ok: false, reasons: [`A2A cancel failed: ${err instanceof Error ? err.message : String(err)}`] };
      }
    }
    const result = this.transition(taskId, 'cancelled', reason ?? (byUser ? 'Cancelled by user.' : 'Cancelled.'));
    if (!result.ok) return result;
    result.task.cancelledByUser = byUser;
    result.task.cancelReason = reason ?? null;
    this.emit({ kind: 'task-cancelled', task: result.task, byUser });
    return result;
  }

  /** Cancel every active task for one peer (e.g. peer going down). Returns cancelled ids + ids that refused (already terminal). */
  async cancelAllForPeer(
    peerId: string,
    byUser: boolean,
    reason?: string,
  ): Promise<{ cancelled: string[]; refused: Array<{ taskId: string; reasons: string[] }> }> {
    const cancelled: string[] = [];
    const refused: Array<{ taskId: string; reasons: string[] }> = [];
    for (const boardTask of [...this.tasks.values()]) {
      if (boardTask.peerId !== peerId) continue;
      if (isA2aTerminalState(boardTask.task.status.state)) continue;
      const result = await this.cancel(boardTask.task.id, byUser, reason);
      if (result.ok) cancelled.push(boardTask.task.id);
      else refused.push({ taskId: boardTask.task.id, reasons: result.reasons });
    }
    return { cancelled, refused };
  }

  /** Answer an `input-required` task (input-required → working). */  provideInput(
    taskId: string,
    answer: string,
  ): { ok: true; task: FleetV29BoardTask } | { ok: false; reasons: string[] } {
    const boardTask = this.tasks.get(taskId);
    if (!boardTask) return { ok: false, reasons: [`No board task "${taskId}".`] };
    if (boardTask.task.status.state !== 'input-required') {
      return { ok: false, reasons: [`Task "${taskId}" is not waiting for input (state: ${boardTask.task.status.state}).`] };
    }
    if (!answer.trim()) return { ok: false, reasons: ['An answer is required.'] };
    boardTask.task.history = [
      ...(boardTask.task.history ?? []),
      { kind: 'message', messageId: `msg-${this.newId()}`, role: 'user', parts: [{ kind: 'text', text: answer.slice(0, 2000) }] },
    ];
    return this.transition(taskId, 'working', 'User provided the requested input.');
  }

  /** Record cost/latency for a task (from the peer's accounting). */
  recordCost(taskId: string, costUsd: number, latencyMs: number | null): FleetV29BoardTask | null {
    const boardTask = this.tasks.get(taskId);
    if (!boardTask) return null;
    if (Number.isFinite(costUsd) && costUsd >= 0) boardTask.costUsd = Math.round((boardTask.costUsd + costUsd) * 10000) / 10000;
    if (latencyMs !== null && Number.isFinite(latencyMs) && latencyMs >= 0) boardTask.lastLatencyMs = latencyMs;
    // Over the per-task cap the board does not auto-cancel (that would
    // hide spend) — the caller sees the breach via costCapBreached().
    return boardTask;
  }

  /** True when a task has breached its peer's per-task cost cap. */
  costCapBreached(taskId: string): boolean {
    const boardTask = this.tasks.get(taskId);
    if (!boardTask) return false;
    const entry = this.allowlist.get(boardTask.peerId);
    const cap = entry?.scope.maxCostUsdPerTask;
    if (cap === null || cap === undefined) return false;
    return boardTask.costUsd > cap;
  }

  taskCount(): number {
    return this.tasks.size;
  }

  /** Counts per state (for the board summary). */
  countsByState(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const t of this.tasks.values()) {
      const state = t.task.status.state;
      out[state] = (out[state] ?? 0) + 1;
    }
    return out;
  }
}

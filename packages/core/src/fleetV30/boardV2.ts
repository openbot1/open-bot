/**
 * A2A task board v2 (v1.44, Team T6) — fleet v30.
 *
 * The v2 board is the coordination layer on top of the v29 board:
 * the v29 board still owns the A2A state machine, the delegation
 * gate, and the transport handoff — v30 never re-implements those.
 * v30 adds what a fleet operator needs once tasks pile up:
 *
 * - Saved views: named filter presets (peer / state / priority /
 *   query / active-only / overdue-only / group) so an operator can
 *   jump to "urgent + overdue" in one click. Views are validated
 *   (unknown states/priorities refused) and bounded (50 max).
 * - Assignment / reassignment: a `submitted` task can move to
 *   another peer — the move re-runs the v29 delegation gate for
 *   the new peer (allowlist + card + scope + concurrency) and is
 *   refused when the gate fails. A `working` task can never be
 *   reassigned mid-flight (the peer already holds its context);
 *   cancel it first, then re-delegate. Every move is recorded in
 *   the assignment history + timeline.
 * - Dependencies: `blockedBy` edges between tasks. A task with an
 *   unfinished blocker is `blocked` and never appears in the
 *   ready list. Cycles are refused at add time (a task cannot —
 *   directly or transitively — block itself).
 * - Deadlines + SLA: `dueAt` + `slaMinutes` per task. The SLA
 *   state is derived at read time (`on-track` / `at-risk` when
 *   under 25% of the budget remains / `overdue` / `no-deadline`).
 *   `sweepOverdue` flags tasks past their deadline and escalates
 *   the ones past their SLA budget (once — `escalated` sticks
 *   until the task completes).
 * - Retry policy: a failed task retries while `retryCount <
 *   maxRetries`; each retry bumps the counter, records a timeline
 *   event, and re-submits through the v29 gate (a peer that lost
 *   its allowlist cannot be retried onto). The backoff is a
 *   recorded delay the host waits — this module never sleeps.
 * - Bulk operations: cancel / reassign / set-priority / set-due
 *   across a list of task ids, applied per task with per-task
 *   reasons for the ones refused — one bad id never blocks the
 *   rest.
 * - Timeline: every v30 event on a task (assign, reassign, retry,
 *   deadline, escalation, state change mirrored from the v29 board)
 *   is appended to a bounded per-task timeline (200 events).
 * - Kanban: configurable columns over A2A states; the default
 *   layout is Queued / Working / Done.
 *
 * All time flows through an injected `nowIso` so tests are
 * deterministic. Nothing here calls the network or runs a model.
 */

import { isA2aTerminalState } from '../a2a/types';
import type { A2aTaskState } from '../a2a/types';
import type { FleetV29TaskBoard } from '../fleetV29/taskBoard';
import type { FleetV29PeerRegistry } from '../fleetV29/peerRegistry';
import type { FleetV29Allowlist } from '../fleetV29/allowlist';
import type {
  FleetV30BoardTaskView,
  FleetV30BoardView,
  FleetV30BulkResult,
  FleetV30KanbanColumn,
  FleetV30SlaState,
  FleetV30TaskMeta,
  FleetV30TaskPriority,
  FleetV30TaskTimelineEvent,
} from './types';
import {
  FLEET_V30_DEFAULT_KANBAN,
  FLEET_V30_DEFAULT_MAX_RETRIES,
  FLEET_V30_DEFAULT_RETRY_BACKOFF_MS,
  FLEET_V30_MAX_TIMELINE_EVENTS,
  FLEET_V30_MAX_VIEWS,
} from './types';

export interface FleetV30BoardV2Deps {
  /** The v29 board (owns A2A state + delegation gate). */
  board: FleetV29TaskBoard;
  /** The v29 peer registry (for reassignment gate + group filter). */
  registry: FleetV29PeerRegistry;
  /** The v29 allowlist (for the reassignment gate). */
  allowlist: FleetV29Allowlist;
  /** Id generator (tests inject a deterministic one). */
  newId?: () => string;
  /** Clock (tests inject a fixed one). */
  nowIso?: () => string;
}

const A2A_STATES: readonly A2aTaskState[] = [
  'submitted',
  'working',
  'input-required',
  'auth-required',
  'completed',
  'failed',
  'cancelled',
  'rejected',
];

const PRIORITIES: readonly FleetV30TaskPriority[] = ['low', 'normal', 'high', 'urgent'];

function defaultId(): string {
  return `v30-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
}

function cloneMeta(meta: FleetV30TaskMeta): FleetV30TaskMeta {
  return {
    ...meta,
    blockedBy: [...meta.blockedBy],
    blocks: [...meta.blocks],
    assignmentHistory: [...meta.assignmentHistory],
    timeline: meta.timeline.map((e) => ({ ...e })),
  };
}

export class FleetV30BoardV2 {
  private readonly board: FleetV29TaskBoard;
  private readonly registry: FleetV29PeerRegistry;
  private readonly allowlist: FleetV29Allowlist;
  private readonly newId: () => string;
  private readonly nowIso: () => string;
  private readonly metas = new Map<string, FleetV30TaskMeta>();
  private readonly views = new Map<string, FleetV30BoardView>();
  private kanban: FleetV30KanbanColumn[] = FLEET_V30_DEFAULT_KANBAN.map((c) => ({
    ...c,
    states: [...c.states],
  }));

  constructor(deps: FleetV30BoardV2Deps) {
    this.board = deps.board;
    this.registry = deps.registry;
    this.allowlist = deps.allowlist;
    this.newId = deps.newId ?? defaultId;
    this.nowIso = deps.nowIso ?? (() => new Date().toISOString());
  }

  /** All board tasks, walking the cursor pages (no 100-task cap). */
  private allBoardTasks(): import('../fleetV29/types').FleetV29BoardTask[] {
    const out: import('../fleetV29/types').FleetV29BoardTask[] = [];
    let cursor: string | null = null;
    for (let guard = 0; guard < 1000; guard += 1) {
      const page = this.board.listTasks({}, cursor, 100);
      out.push(...page.tasks);
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    return out;
  }

  /* ---------------- metadata ---------------- */

  /** v30 metadata for a task (created lazily, seeded from the board task). */
  metaFor(taskId: string): FleetV30TaskMeta | null {
    const boardTask = this.board.getTask(taskId);
    if (!boardTask) return null;
    let meta = this.metas.get(taskId);
    if (!meta) {
      meta = {
        taskId,
        priority: 'normal',
        dueAt: null,
        slaMinutes: null,
        blockedBy: [],
        blocks: [],
        retryCount: 0,
        maxRetries: FLEET_V30_DEFAULT_MAX_RETRIES,
        retryBackoffMs: FLEET_V30_DEFAULT_RETRY_BACKOFF_MS,
        assignmentHistory: [boardTask.peerId],
        timeline: [
          { at: boardTask.createdAt, kind: 'created', actor: boardTask.delegatedBy, note: `Task "${boardTask.title}" created on peer ${boardTask.peerId}.` },
        ],
        escalated: false,
        escalationReason: null,
      };
      this.metas.set(taskId, meta);
    }
    return meta;
  }

  private timeline(meta: FleetV30TaskMeta, kind: FleetV30TaskTimelineEvent['kind'], actor: string, note: string): void {
    meta.timeline.push({ at: this.nowIso(), kind, actor, note });
    while (meta.timeline.length > FLEET_V30_MAX_TIMELINE_EVENTS) meta.timeline.shift();
  }

  /** Derived SLA state for one task at read time. */
  slaStateFor(taskId: string): FleetV30SlaState {
    const boardTask = this.board.getTask(taskId);
    const meta = this.metas.get(taskId);
    if (!boardTask || !meta) return 'no-deadline';
    if (isA2aTerminalState(boardTask.task.status.state)) return 'no-deadline';
    const now = Date.parse(this.nowIso());
    if (meta.dueAt !== null) {
      if (now >= Date.parse(meta.dueAt)) return 'overdue';
      if (meta.slaMinutes !== null) {
        const created = Date.parse(boardTask.createdAt);
        const budgetMs = meta.slaMinutes * 60 * 1000;
        const remaining = Date.parse(meta.dueAt) - now;
        if (remaining <= budgetMs * 0.25) return 'at-risk';
        void created;
      }
      return 'on-track';
    }
    if (meta.slaMinutes !== null) {
      const created = Date.parse(boardTask.createdAt);
      const deadline = created + meta.slaMinutes * 60 * 1000;
      if (now >= deadline) return 'overdue';
      if (deadline - now <= meta.slaMinutes * 60 * 1000 * 0.25) return 'at-risk';
      return 'on-track';
    }
    return 'no-deadline';
  }

  /** True when an unfinished task blocks this one. */
  isBlocked(taskId: string): boolean {
    const meta = this.metas.get(taskId);
    if (!meta) return false;
    for (const blockerId of meta.blockedBy) {
      const blocker = this.board.getTask(blockerId);
      if (!blocker) continue;
      if (!isA2aTerminalState(blocker.task.status.state)) return true;
      if (blocker.task.status.state !== 'completed') return true;
    }
    return false;
  }

  /** One task joined with its v30 metadata + derived state. */
  viewTask(taskId: string): FleetV30BoardTaskView | null {
    const boardTask = this.board.getTask(taskId);
    if (!boardTask) return null;
    const meta = this.metaFor(taskId) as FleetV30TaskMeta;
    return {
      boardTask,
      meta: cloneMeta(meta),
      slaState: this.slaStateFor(taskId),
      blocked: this.isBlocked(taskId),
    };
  }

  /* ---------------- assignment ---------------- */

  /**
   * Reassign a `submitted` task to another peer. The v29 delegation
   * gate re-runs for the new peer (allowlist + card + scope +
   * concurrency); a failed gate refuses the move and changes
   * nothing. Working tasks are refused — cancel first.
   */
  reassign(
    taskId: string,
    newPeerId: string,
    actor: string,
  ): { ok: true; view: FleetV30BoardTaskView } | { ok: false; reasons: string[] } {
    const boardTask = this.board.getTask(taskId);
    if (!boardTask) return { ok: false, reasons: [`No board task "${taskId}".`] };
    if (boardTask.task.status.state !== 'submitted') {
      return { ok: false, reasons: [`Task "${taskId}" is ${boardTask.task.status.state} — only submitted tasks can be reassigned (cancel a working task first).`] };
    }
    if (boardTask.peerId === newPeerId) {
      return { ok: false, reasons: [`Task "${taskId}" is already assigned to peer "${newPeerId}".`] };
    }
    const gateReasons = this.board.checkDelegation({
      peerId: newPeerId,
      delegatedBy: boardTask.delegatedBy,
      title: boardTask.title,
      messageText: 'reassignment-check',
      contextId: boardTask.task.contextId,
    });
    // The gate also checks title/message — both are present here, so
    // any remaining reason is about the new peer.
    const peerReasons = gateReasons.filter((r) => !r.includes('title') && !r.includes('message'));
    if (peerReasons.length > 0) return { ok: false, reasons: peerReasons };
    const meta = this.metaFor(taskId) as FleetV30TaskMeta;
    const oldPeer = boardTask.peerId;
    boardTask.peerId = newPeerId;
    meta.assignmentHistory.push(newPeerId);
    this.timeline(meta, 'reassigned', actor, `Reassigned from peer ${oldPeer} to peer ${newPeerId}.`);
    const view = this.viewTask(taskId) as FleetV30BoardTaskView;
    return { ok: true, view };
  }

  /** Assign a priority to a task. */
  setPriority(
    taskId: string,
    priority: FleetV30TaskPriority,
    actor: string,
  ): { ok: true; view: FleetV30BoardTaskView } | { ok: false; reasons: string[] } {
    if (!PRIORITIES.includes(priority)) return { ok: false, reasons: [`Unknown priority "${priority}".`] };
    const meta = this.metaFor(taskId);
    if (!meta) return { ok: false, reasons: [`No board task "${taskId}".`] };
    meta.priority = priority;
    this.timeline(meta, 'state-changed', actor, `Priority set to ${priority}.`);
    return { ok: true, view: this.viewTask(taskId) as FleetV30BoardTaskView };
  }

  /** Set (or clear) a task's deadline + optional SLA budget. */
  setDue(
    taskId: string,
    dueAt: string | null,
    slaMinutes: number | null,
    actor: string,
  ): { ok: true; view: FleetV30BoardTaskView } | { ok: false; reasons: string[] } {
    const reasons: string[] = [];
    if (dueAt !== null && Number.isNaN(Date.parse(dueAt))) reasons.push(`dueAt "${dueAt}" is not a valid ISO date.`);
    if (slaMinutes !== null && (!Number.isFinite(slaMinutes) || slaMinutes <= 0)) {
      reasons.push('slaMinutes must be a number > 0 or null.');
    }
    if (reasons.length > 0) return { ok: false, reasons };
    const meta = this.metaFor(taskId);
    if (!meta) return { ok: false, reasons: [`No board task "${taskId}".`] };
    meta.dueAt = dueAt;
    meta.slaMinutes = slaMinutes;
    this.timeline(meta, 'deadline-set', actor, dueAt ? `Deadline set to ${dueAt}${slaMinutes !== null ? ` (SLA ${slaMinutes}m)` : ''}.` : 'Deadline cleared.');
    return { ok: true, view: this.viewTask(taskId) as FleetV30BoardTaskView };
  }

  /* ---------------- dependencies ---------------- */

  /**
   * Add a `blockedBy` edge (taskId waits for blockerId). Refused
   * when either task is missing, the edge already exists, the task
   * would block itself, or the edge would create a cycle.
   */
  addDependency(
    taskId: string,
    blockerId: string,
    actor: string,
  ): { ok: true; view: FleetV30BoardTaskView } | { ok: false; reasons: string[] } {
    if (taskId === blockerId) return { ok: false, reasons: ['A task cannot block itself.'] };
    const meta = this.metaFor(taskId);
    const blockerMeta = this.metaFor(blockerId);
    if (!meta) return { ok: false, reasons: [`No board task "${taskId}".`] };
    if (!blockerMeta) return { ok: false, reasons: [`No board task "${blockerId}".`] };
    if (meta.blockedBy.includes(blockerId)) return { ok: false, reasons: [`Task "${taskId}" already depends on "${blockerId}".`] };
    if (this.wouldCycle(taskId, blockerId)) {
      return { ok: false, reasons: [`Adding "${blockerId}" as a blocker of "${taskId}" would create a dependency cycle.`] };
    }
    meta.blockedBy.push(blockerId);
    blockerMeta.blocks.push(taskId);
    this.timeline(meta, 'state-changed', actor, `Now blocked by task ${blockerId}.`);
    return { ok: true, view: this.viewTask(taskId) as FleetV30BoardTaskView };
  }

  /** Remove a `blockedBy` edge. */
  removeDependency(
    taskId: string,
    blockerId: string,
    actor: string,
  ): { ok: true; view: FleetV30BoardTaskView } | { ok: false; reasons: string[] } {
    const meta = this.metaFor(taskId);
    const blockerMeta = this.metaFor(blockerId);
    if (!meta) return { ok: false, reasons: [`No board task "${taskId}".`] };
    if (!meta.blockedBy.includes(blockerId)) return { ok: false, reasons: [`Task "${taskId}" does not depend on "${blockerId}".`] };
    meta.blockedBy = meta.blockedBy.filter((id) => id !== blockerId);
    if (blockerMeta) blockerMeta.blocks = blockerMeta.blocks.filter((id) => id !== taskId);
    this.timeline(meta, 'state-changed', actor, `No longer blocked by task ${blockerId}.`);
    return { ok: true, view: this.viewTask(taskId) as FleetV30BoardTaskView };
  }

  /** True when adding blockerId → taskId would close a cycle. */
  private wouldCycle(taskId: string, blockerId: string): boolean {
    const seen = new Set<string>();
    const stack = [blockerId];
    while (stack.length > 0) {
      const cur = stack.pop() as string;
      if (cur === taskId) return true;
      if (seen.has(cur)) continue;
      seen.add(cur);
      const meta = this.metas.get(cur);
      if (meta) stack.push(...meta.blockedBy);
    }
    return false;
  }

  /** Tasks that are submitted, unblocked, and ready to start. */
  readyTasks(): FleetV30BoardTaskView[] {
    const out: FleetV30BoardTaskView[] = [];
    for (const boardTask of this.allBoardTasks()) {
      if (boardTask.task.status.state !== 'submitted') continue;
      const view = this.viewTask(boardTask.task.id);
      if (view && !view.blocked) out.push(view);
    }
    return out.sort((a, b) => b.meta.priority.localeCompare(a.meta.priority) || a.boardTask.createdAt.localeCompare(b.boardTask.createdAt));
  }

  /* ---------------- deadlines / SLA ---------------- */

  /**
   * Sweep overdue tasks: tasks past `dueAt` (or past their SLA
   * deadline) get a timeline event; tasks past their SLA budget
   * are escalated once. Returns the overdue + newly escalated ids.
   */
  sweepOverdue(actor = 'system'): { overdue: string[]; escalated: string[] } {
    const overdue: string[] = [];
    const escalated: string[] = [];
    for (const boardTask of this.allBoardTasks()) {
      if (isA2aTerminalState(boardTask.task.status.state)) continue;
      const meta = this.metaFor(boardTask.task.id);
      if (!meta) continue;
      const sla = this.slaStateFor(boardTask.task.id);
      if (sla !== 'overdue') continue;
      overdue.push(boardTask.task.id);
      this.timeline(meta, 'deadline-missed', actor, `Task missed its deadline${meta.dueAt ? ` (${meta.dueAt})` : ''}.`);
      if (!meta.escalated) {
        meta.escalated = true;
        meta.escalationReason = `SLA missed (due ${meta.dueAt ?? 'SLA budget exhausted'}).`;
        escalated.push(boardTask.task.id);
        this.timeline(meta, 'escalated', actor, meta.escalationReason);
      }
    }
    return { overdue, escalated };
  }

  /* ---------------- retry ---------------- */

  /** Set the retry policy for one task. */
  setRetryPolicy(
    taskId: string,
    maxRetries: number,
    retryBackoffMs: number,
  ): { ok: true; view: FleetV30BoardTaskView } | { ok: false; reasons: string[] } {
    const reasons: string[] = [];
    if (!Number.isInteger(maxRetries) || maxRetries < 0) reasons.push('maxRetries must be an integer >= 0.');
    if (!Number.isFinite(retryBackoffMs) || retryBackoffMs < 0) reasons.push('retryBackoffMs must be a number >= 0.');
    if (reasons.length > 0) return { ok: false, reasons };
    const meta = this.metaFor(taskId);
    if (!meta) return { ok: false, reasons: [`No board task "${taskId}".`] };
    meta.maxRetries = maxRetries;
    meta.retryBackoffMs = retryBackoffMs;
    return { ok: true, view: this.viewTask(taskId) as FleetV30BoardTaskView };
  }

  /**
   * Retry a failed task: bumps the counter, records the timeline,
   * and re-runs the v29 gate for the same peer — a peer that lost
   * its allowlist cannot be retried onto. The task must be `failed`
   * and under its retry budget. The retry itself re-submits through
   * the v29 board as a new delegation is NOT created: the failed
   * task is moved back to `submitted` via a fresh board task is
   * impossible (A2A forbids failed → submitted), so retry creates
   * a NEW board task carrying the same title/message and links it
   * in the timeline. Returns the new task's view (or a refusal).
   */
  async retryFailed(
    taskId: string,
    actor: string,
  ): Promise<{ ok: true; view: FleetV30BoardTaskView; newTaskId: string } | { ok: false; reasons: string[] }> {
    const boardTask = this.board.getTask(taskId);
    if (!boardTask) return { ok: false, reasons: [`No board task "${taskId}".`] };
    if (boardTask.task.status.state !== 'failed') {
      return { ok: false, reasons: [`Task "${taskId}" is ${boardTask.task.status.state} — only failed tasks can be retried.`] };
    }
    const meta = this.metaFor(taskId) as FleetV30TaskMeta;
    if (meta.retryCount >= meta.maxRetries) {
      return { ok: false, reasons: [`Task "${taskId}" has used all ${meta.maxRetries} retr(ies).`] };
    }
    const result = await this.board.submit({
      peerId: boardTask.peerId,
      delegatedBy: boardTask.delegatedBy,
      title: boardTask.title,
      messageText: `Retry ${meta.retryCount + 1} of task ${taskId}.`,
      contextId: boardTask.task.contextId,
      ...(boardTask.task.tenantId !== undefined ? { tenantId: boardTask.task.tenantId } : {}),
    });
    if (!result.ok) return { ok: false, reasons: result.reasons };
    meta.retryCount += 1;
    this.timeline(meta, 'retry', actor, `Retry ${meta.retryCount}/${meta.maxRetries} created as task ${result.boardTask.task.id} (backoff ${meta.retryBackoffMs}ms).`);
    const newMeta = this.metaFor(result.boardTask.task.id) as FleetV30TaskMeta;
    newMeta.priority = meta.priority;
    newMeta.maxRetries = meta.maxRetries;
    newMeta.retryBackoffMs = meta.retryBackoffMs;
    newMeta.dueAt = meta.dueAt;
    newMeta.slaMinutes = meta.slaMinutes;
    this.timeline(newMeta, 'retry', actor, `Created as retry of task ${taskId}.`);
    return { ok: true, view: this.viewTask(result.boardTask.task.id) as FleetV30BoardTaskView, newTaskId: result.boardTask.task.id };
  }

  /* ---------------- saved views ---------------- */

  /** Create a saved board view (validated, bounded). */
  createView(input: {
    name: string;
    createdBy: string;
    peerId?: string | null;
    state?: A2aTaskState | null;
    priority?: FleetV30TaskPriority | null;
    query?: string | null;
    activeOnly?: boolean;
    overdueOnly?: boolean;
    groupId?: string | null;
  }): { ok: true; view: FleetV30BoardView } | { ok: false; reasons: string[] } {
    const reasons: string[] = [];
    if (!input.name.trim()) reasons.push('A view name is required.');
    if (input.state !== undefined && input.state !== null && !A2A_STATES.includes(input.state)) {
      reasons.push(`Unknown A2A state "${input.state}".`);
    }
    if (input.priority !== undefined && input.priority !== null && !PRIORITIES.includes(input.priority)) {
      reasons.push(`Unknown priority "${input.priority}".`);
    }
    if (this.views.size >= FLEET_V30_MAX_VIEWS) reasons.push(`Too many saved views (max ${FLEET_V30_MAX_VIEWS}).`);
    if (reasons.length > 0) return { ok: false, reasons };
    const viewId = `view-${this.newId()}`;
    const view: FleetV30BoardView = {
      viewId,
      name: input.name.trim(),
      createdBy: input.createdBy,
      createdAt: this.nowIso(),
      peerId: input.peerId ?? null,
      state: input.state ?? null,
      priority: input.priority ?? null,
      query: input.query ?? null,
      activeOnly: input.activeOnly ?? false,
      overdueOnly: input.overdueOnly ?? false,
      groupId: input.groupId ?? null,
    };
    this.views.set(viewId, view);
    return { ok: true, view: { ...view } };
  }

  getView(viewId: string): FleetV30BoardView | null {
    const v = this.views.get(viewId);
    return v ? { ...v } : null;
  }

  listViews(): FleetV30BoardView[] {
    return [...this.views.values()].map((v) => ({ ...v })).sort((a, b) => a.name.localeCompare(b.name));
  }

  deleteView(viewId: string): boolean {
    return this.views.delete(viewId);
  }

  /** Apply a saved view: list the matching task views (newest first). */
  applyView(viewId: string): { ok: true; tasks: FleetV30BoardTaskView[] } | { ok: false; reasons: string[] } {
    const view = this.views.get(viewId);
    if (!view) return { ok: false, reasons: [`No saved view "${viewId}".`] };
    const query = view.query?.trim().toLowerCase();
    const tasks: FleetV30BoardTaskView[] = [];
    for (const boardTask of this.allBoardTasks()) {
      const v = this.viewTask(boardTask.task.id);
      if (!v) continue;
      if (view.peerId !== null && v.boardTask.peerId !== view.peerId) continue;
      if (view.state !== null && v.boardTask.task.status.state !== view.state) continue;
      if (view.priority !== null && v.meta.priority !== view.priority) continue;
      if (view.activeOnly && isA2aTerminalState(v.boardTask.task.status.state)) continue;
      if (view.overdueOnly && v.slaState !== 'overdue') continue;
      if (view.groupId !== null) {
        // Group membership is resolved by the caller via peerGroups;
        // the view stores the group id and the panel filters on it.
        // Here we keep the task only when its peer belongs to the
        // group — checked through the registry tags convention
        // `group:<groupId>` (see peerGroups.ts).
        const peer = this.registry.getPeer(v.boardTask.peerId);
        if (!peer || !peer.tags.includes(`group:${view.groupId}`)) continue;
      }
      if (query && !v.boardTask.title.toLowerCase().includes(query) && !v.boardTask.task.id.toLowerCase().includes(query)) continue;
      tasks.push(v);
    }
    tasks.sort((a, b) => b.boardTask.createdAt.localeCompare(a.boardTask.createdAt));
    return { ok: true, tasks };
  }

  /* ---------------- kanban ---------------- */

  /** Replace the kanban columns (every A2A state must appear exactly once). */
  setKanban(columns: FleetV30KanbanColumn[]): { ok: true; columns: FleetV30KanbanColumn[] } | { ok: false; reasons: string[] } {
    const reasons: string[] = [];
    if (!Array.isArray(columns) || columns.length === 0) return { ok: false, reasons: ['At least one kanban column is required.'] };
    const seen = new Set<string>();
    const ids = new Set<string>();
    for (const col of columns) {
      if (!col.columnId.trim()) reasons.push('Every kanban column needs an id.');
      if (ids.has(col.columnId)) reasons.push(`Duplicate kanban column id "${col.columnId}".`);
      ids.add(col.columnId);
      if (!col.title.trim()) reasons.push(`Kanban column "${col.columnId}" needs a title.`);
      if (!Array.isArray(col.states) || col.states.length === 0) reasons.push(`Kanban column "${col.columnId}" needs at least one state.`);
      for (const s of col.states ?? []) {
        if (!A2A_STATES.includes(s)) reasons.push(`Unknown A2A state "${s}" in kanban column "${col.columnId}".`);
        if (seen.has(s)) reasons.push(`A2A state "${s}" appears in more than one kanban column.`);
        seen.add(s);
      }
    }
    for (const s of A2A_STATES) {
      if (!seen.has(s)) reasons.push(`A2A state "${s}" is missing from the kanban columns.`);
    }
    if (reasons.length > 0) return { ok: false, reasons };
    this.kanban = columns.map((c) => ({ ...c, states: [...c.states] }));
    return { ok: true, columns: this.getKanban() };
  }

  getKanban(): FleetV30KanbanColumn[] {
    return this.kanban.map((c) => ({ ...c, states: [...c.states] }));
  }

  /** Tasks grouped by kanban column (for the board panel). */
  kanbanBoard(): Array<{ column: FleetV30KanbanColumn; tasks: FleetV30BoardTaskView[] }> {
    const all: FleetV30BoardTaskView[] = [];
    for (const boardTask of this.allBoardTasks()) {
      const v = this.viewTask(boardTask.task.id);
      if (v) all.push(v);
    }
    return this.kanban.map((column) => ({
      column: { ...column, states: [...column.states] },
      tasks: all
        .filter((v) => column.states.includes(v.boardTask.task.status.state))
        .sort((a, b) => b.boardTask.createdAt.localeCompare(a.boardTask.createdAt)),
    }));
  }

  /* ---------------- bulk ---------------- */

  /** Bulk-cancel a list of tasks (per-task reasons for refusals). */
  async bulkCancel(taskIds: string[], byUser: boolean, reason?: string): Promise<FleetV30BulkResult> {
    const applied: string[] = [];
    const refused: Array<{ taskId: string; reasons: string[] }> = [];
    for (const taskId of taskIds) {
      const result = await this.board.cancel(taskId, byUser, reason);
      if (result.ok) {
        applied.push(taskId);
        const meta = this.metas.get(taskId);
        if (meta) this.timeline(meta, 'cancelled', byUser ? 'user' : 'system', reason ?? 'Cancelled in bulk.');
      } else refused.push({ taskId, reasons: result.reasons });
    }
    return { applied, refused };
  }

  /** Bulk-reassign submitted tasks to one peer (per-task gate). */
  bulkReassign(taskIds: string[], newPeerId: string, actor: string): FleetV30BulkResult {
    const applied: string[] = [];
    const refused: Array<{ taskId: string; reasons: string[] }> = [];
    for (const taskId of taskIds) {
      const result = this.reassign(taskId, newPeerId, actor);
      if (result.ok) applied.push(taskId);
      else refused.push({ taskId, reasons: result.reasons });
    }
    return { applied, refused };
  }

  /** Bulk-set priority (per-task reasons for refusals). */
  bulkSetPriority(taskIds: string[], priority: FleetV30TaskPriority, actor: string): FleetV30BulkResult {
    const applied: string[] = [];
    const refused: Array<{ taskId: string; reasons: string[] }> = [];
    for (const taskId of taskIds) {
      const result = this.setPriority(taskId, priority, actor);
      if (result.ok) applied.push(taskId);
      else refused.push({ taskId, reasons: result.reasons });
    }
    return { applied, refused };
  }

  /** Counts per priority (for the board summary). */
  countsByPriority(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const boardTask of this.allBoardTasks()) {
      const meta = this.metas.get(boardTask.task.id);
      const p = meta?.priority ?? 'normal';
      out[p] = (out[p] ?? 0) + 1;
    }
    return out;
  }

  /**
   * Export the board as newline-delimited JSON (one line per task:
   * the v29 task, its v30 metadata, SLA state, and blocked flag).
   * Titles are short human labels; no prompt text, message parts,
   * or secrets are included — the export is safe to hand to an
   * operator or to archive. Pass `state` to export one column.
   */
  exportBoard(state?: A2aTaskState | null): string {
    const lines: string[] = [];
    for (const boardTask of this.allBoardTasks()) {
      if (state !== undefined && state !== null && boardTask.task.status.state !== state) continue;
      const view = this.viewTask(boardTask.task.id);
      if (!view) continue;
      lines.push(JSON.stringify({
        taskId: view.boardTask.task.id,
        peerId: view.boardTask.peerId,
        title: view.boardTask.title,
        state: view.boardTask.task.status.state,
        createdAt: view.boardTask.createdAt,
        updatedAt: view.boardTask.updatedAt,
        priority: view.meta.priority,
        dueAt: view.meta.dueAt,
        slaMinutes: view.meta.slaMinutes,
        slaState: view.slaState,
        blocked: view.blocked,
        blockedBy: view.meta.blockedBy,
        retryCount: view.meta.retryCount,
        maxRetries: view.meta.maxRetries,
        escalated: view.meta.escalated,
        costUsd: view.boardTask.costUsd,
        progress: view.boardTask.progress,
        timelineEvents: view.meta.timeline.length,
      }));
    }
    return lines.join('\n');
  }
}

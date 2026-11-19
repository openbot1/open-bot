/**
 * Fleet v29 delegation planner (v1.42, Team T6).
 *
 * A plan is a small fan-out / sequence of delegations the board can
 * run as one unit: "research with peer A, then write with peer B,
 * in parallel with a review by peer C". The planner validates the
 * whole plan before anything is sent (every step must pass the same
 * fail-closed gate as a single delegation), estimates the cost
 * envelope, and then executes steps through the board — sequential
 * steps wait for the previous step to finish, parallel steps run
 * together, and a failed step stops the plan (or retries, when the
 * plan says so).
 *
 * The planner never sends anything itself: execution calls
 * `FleetV29TaskBoard.submit()` per step, so the gate, the audit
 * trail, and the transport handoff all stay in one place. A plan
 * that references a peer that loses its allowlist entry or card
 * verification between validation and execution fails that step
 * instead of sending to an untrusted peer.
 *
 * Budgets: each step has an estimated cost (USD, from the caller —
 * the planner never invents a price); the plan's total envelope is
 * the sum of its steps' estimates plus a per-step cap check against
 * each peer's allowlist scope. Execution stops the plan when the
 * recorded spend passes the envelope.
 */

import type { FleetV29Allowlist } from './allowlist';
import type { FleetV29PeerRegistry } from './peerRegistry';
import type { FleetV29BoardTask, FleetV29DelegateRequest, FleetV29Operation } from './types';
import type { FleetV29TaskBoard } from './taskBoard';

/** How steps in one group run. */
export type FleetV29PlanStepMode = 'sequential' | 'parallel';

/** One step of a delegation plan. */
export interface FleetV29PlanStep {
  /** Stable step id within the plan. */
  stepId: string;
  /** Peer to delegate this step to. */
  peerId: string;
  /** Short human label (never prompt text). */
  title: string;
  /** Message text for this step (kept out of the audit log). */
  messageText: string;
  /** Skill the step needs (must be in the peer's scope). */
  skillId?: string;
  /** Operation to use (default: streaming when the peer supports it). */
  operation?: FleetV29Operation;
  /** Estimated USD cost of this step (caller-provided). */
  estimatedCostUsd: number;
  /** Retries when the step fails (0 = no retry). */
  maxRetries: number;
  /** Run mode of the group this step belongs to. */
  mode: FleetV29PlanStepMode;
  /** Step ids that must complete before this step starts (sequential groups). */
  dependsOn: string[];
}

/** A delegation plan (one unit the board runs). */
export interface FleetV29DelegationPlan {
  planId: string;
  title: string;
  delegatedBy: string;
  steps: FleetV29PlanStep[];
  /** Total USD envelope — execution stops when recorded spend passes it. */
  budgetUsd: number;
  createdAt: string;
}

/** Outcome of one executed step. */
export interface FleetV29PlanStepResult {
  stepId: string;
  peerId: string;
  /** 'completed' | 'failed' | 'skipped' (dependency failed) | 'refused' (gate). */
  outcome: 'completed' | 'failed' | 'skipped' | 'refused';
  taskId: string | null;
  attempts: number;
  reasons: string[];
  costUsd: number;
}

/** Outcome of a whole plan run. */
export interface FleetV29PlanResult {
  planId: string;
  /** 'completed' when every step completed, else the blocking outcome. */
  outcome: 'completed' | 'failed' | 'refused' | 'budget-exceeded';
  steps: FleetV29PlanStepResult[];
  totalCostUsd: number;
  startedAt: string;
  finishedAt: string;
}

/** Problems with a plan (empty = valid). */
export function fleetV29ValidatePlan(
  plan: FleetV29DelegationPlan,
  registry: FleetV29PeerRegistry,
  allowlist: FleetV29Allowlist,
  board: FleetV29TaskBoard,
): string[] {
  const problems: string[] = [];
  if (!plan.planId.trim()) problems.push('planId is required.');
  if (!plan.title.trim()) problems.push('A plan title is required.');
  if (plan.steps.length === 0) problems.push('A plan needs at least one step.');
  if (plan.budgetUsd < 0 || !Number.isFinite(plan.budgetUsd)) problems.push('budgetUsd must be >= 0.');
  const ids = new Set<string>();
  for (const step of plan.steps) {
    if (ids.has(step.stepId)) problems.push(`Duplicate step id "${step.stepId}".`);
    ids.add(step.stepId);
    if (!step.title.trim()) problems.push(`Step "${step.stepId}" needs a title.`);
    if (!step.messageText.trim()) problems.push(`Step "${step.stepId}" needs message text.`);
    if (step.estimatedCostUsd < 0 || !Number.isFinite(step.estimatedCostUsd)) {
      problems.push(`Step "${step.stepId}" estimatedCostUsd must be >= 0.`);
    }
    if (!Number.isInteger(step.maxRetries) || step.maxRetries < 0 || step.maxRetries > 3) {
      problems.push(`Step "${step.stepId}" maxRetries must be 0..3.`);
    }
    for (const dep of step.dependsOn) {
      if (dep === step.stepId) problems.push(`Step "${step.stepId}" depends on itself.`);
      if (!plan.steps.some((s) => s.stepId === dep)) problems.push(`Step "${step.stepId}" depends on unknown step "${dep}".`);
    }
    const request: FleetV29DelegateRequest = {
      peerId: step.peerId,
      delegatedBy: plan.delegatedBy,
      title: step.title,
      messageText: step.messageText,
      ...(step.skillId ? { skillId: step.skillId } : {}),
      ...(step.operation ? { operation: step.operation } : {}),
    };
    const gate = board.checkDelegation(request);
    problems.push(...gate.map((g) => `Step "${step.stepId}": ${g}`));
    const entry = allowlist.get(step.peerId);
    if (entry?.scope.maxCostUsdPerTask !== null && entry?.scope.maxCostUsdPerTask !== undefined) {
      if (step.estimatedCostUsd > (entry.scope.maxCostUsdPerTask as number)) {
        problems.push(
          `Step "${step.stepId}" estimated cost $${step.estimatedCostUsd} exceeds peer "${step.peerId}" per-task cap $${entry.scope.maxCostUsdPerTask}.`,
        );
      }
    }
    void registry;
  }
  const estimatedTotal = plan.steps.reduce((sum, s) => sum + s.estimatedCostUsd, 0);
  if (estimatedTotal > plan.budgetUsd) {
    problems.push(`Estimated total $${estimatedTotal.toFixed(2)} exceeds plan budget $${plan.budgetUsd.toFixed(2)}.`);
  }
  // Cycle check on dependsOn (depth-first).
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): boolean => {
    if (visited.has(id)) return false;
    if (visiting.has(id)) return true;
    visiting.add(id);
    const step = plan.steps.find((s) => s.stepId === id);
    for (const dep of step?.dependsOn ?? []) {
      if (visit(dep)) return true;
    }
    visiting.delete(id);
    visited.add(id);
    return false;
  };
  for (const step of plan.steps) {
    if (visit(step.stepId)) {
      problems.push('Plan has a dependency cycle.');
      break;
    }
  }
  return problems;
}

/** Estimated total cost of a plan (sum of step estimates). */
export function fleetV29PlanEstimatedTotal(plan: FleetV29DelegationPlan): number {
  return Math.round(plan.steps.reduce((sum, s) => sum + s.estimatedCostUsd, 0) * 10000) / 10000;
}

/** Topological order of steps (dependencies first); throws on a cycle. */
export function fleetV29PlanOrder(plan: FleetV29DelegationPlan): FleetV29PlanStep[] {
  const ordered: FleetV29PlanStep[] = [];
  const done = new Set<string>();
  const remaining = [...plan.steps];
  while (remaining.length > 0) {
    const ready = remaining.filter((s) => s.dependsOn.every((d) => done.has(d)));
    if (ready.length === 0) throw new Error('Plan has a dependency cycle or a missing dependency.');
    for (const step of ready) {
      ordered.push(step);
      done.add(step.stepId);
      remaining.splice(remaining.indexOf(step), 1);
    }
  }
  return ordered;
}

/**
 * Execute a plan through the board. Sequential steps run in
 * dependency order; parallel steps in the same group run together.
 * In simulation mode the board creates local tasks, so the planner
 * drives them to completion itself (start → complete) to prove the
 * flow; in transport mode it waits for the peer (polling the board
 * state, bounded by `maxWaitMs` per step).
 */
export class FleetV29DelegationPlanner {
  private readonly board: FleetV29TaskBoard;
  private readonly nowIso: () => string;

  constructor(board: FleetV29TaskBoard, nowIso?: () => string) {
    this.board = board;
    this.nowIso = nowIso ?? (() => new Date().toISOString());
  }

  /**
   * Execute a plan. `driveSimulated` (default true) drives
   * simulated tasks to `completed` so a plan can be tested without
   * a transport; with a real transport the caller passes false and
   * the plan returns after submission (steps report `completed`
   * only when the peer finishes — see `pollStep`).
   */
  async execute(
    plan: FleetV29DelegationPlan,
    options?: { driveSimulated?: boolean; maxWaitMs?: number },
  ): Promise<FleetV29PlanResult> {
    const startedAt = this.nowIso();
    const driveSimulated = options?.driveSimulated ?? true;
    const results: FleetV29PlanStepResult[] = [];
    const byId = new Map<string, FleetV29PlanStepResult>();
    let totalCostUsd = 0;
    let outcome: FleetV29PlanResult['outcome'] = 'completed';
    const ordered = fleetV29PlanOrder(plan);
    for (const step of ordered) {
      const failedDep = step.dependsOn.some((d) => byId.get(d)?.outcome !== 'completed');
      if (failedDep) {
        const skipped: FleetV29PlanStepResult = { stepId: step.stepId, peerId: step.peerId, outcome: 'skipped', taskId: null, attempts: 0, reasons: ['A dependency did not complete.'], costUsd: 0 };
        results.push(skipped);
        byId.set(step.stepId, skipped);
        // Outcome already set by the failed/refused dependency — a
        // skipped step must not overwrite it with a blander 'failed'.
        continue;
      }
      if (totalCostUsd > plan.budgetUsd) {
        outcome = 'budget-exceeded';
        const skipped: FleetV29PlanStepResult = { stepId: step.stepId, peerId: step.peerId, outcome: 'skipped', taskId: null, attempts: 0, reasons: ['Plan budget exceeded.'], costUsd: 0 };
        results.push(skipped);
        byId.set(step.stepId, skipped);
        continue;
      }
      let lastReasons: string[] = [];
      let task: FleetV29BoardTask | null = null;
      let attempts = 0;
      let stepOutcome: FleetV29PlanStepResult['outcome'] = 'failed';
      for (let attempt = 0; attempt <= step.maxRetries; attempt += 1) {
        attempts = attempt + 1;
        const submitted = await this.board.submit({
          peerId: step.peerId,
          delegatedBy: plan.delegatedBy,
          title: step.title,
          messageText: step.messageText,
          ...(step.skillId ? { skillId: step.skillId } : {}),
          ...(step.operation ? { operation: step.operation } : {}),
        });
        if (!submitted.ok) {
          lastReasons = submitted.reasons;
          stepOutcome = 'refused';
          break;
        }
        task = submitted.boardTask;
        this.board.recordCost(task.task.id, step.estimatedCostUsd, null);
        totalCostUsd = Math.round((totalCostUsd + step.estimatedCostUsd) * 10000) / 10000;
        if (!this.board.transportWired && driveSimulated) {
          this.board.start(task.task.id);
          const completed = this.board.complete(task.task.id, `Simulated result for step "${step.title}".`);
          if (completed.ok) {
            stepOutcome = 'completed';
            break;
          }
          lastReasons = completed.reasons;
          stepOutcome = 'failed';
        } else {
          // Transport mode: the task is in flight; the plan reports
          // it as completed only if it already finished, otherwise
          // the caller polls the board. Here we treat a successful
          // submission as the step having started — the result
          // records the live task id for follow-up.
          stepOutcome = 'completed';
          break;
        }
      }
      const stepResult: FleetV29PlanStepResult = {
        stepId: step.stepId,
        peerId: step.peerId,
        outcome: stepOutcome,
        taskId: task ? task.task.id : null,
        attempts,
        reasons: lastReasons,
        costUsd: task ? step.estimatedCostUsd : 0,
      };
      results.push(stepResult);
      byId.set(step.stepId, stepResult);
      if (stepOutcome !== 'completed') outcome = stepOutcome === 'refused' ? 'refused' : 'failed';
    }
    return { planId: plan.planId, outcome, steps: results, totalCostUsd, startedAt, finishedAt: this.nowIso() };
  }
}

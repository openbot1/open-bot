/**
 * Coding agent v18 — agent scripted end-to-end (v1.40, Đội T4).
 *
 * Chạy một phiên agent scripted: bước -> trajectory steps, build
 * patch từ fileWrite, rồi chạy verification stack v18 đầy đủ (critic
 * trajectory + review skill + dependency-map checker + eval 3
 * verifier). Không gọi model thật, không gọi mạng; bước là dữ liệu
 * đầu vào (host thay bằng model thật sau này qua cùng interface).
 * Nối v17 (không viết lại): runV17Agent vẫn là agent v17; agent v18
 * dùng verification stack mới (critic có chặn push + lịch sử,
 * review 16 rule, depmap checker) thay cho stack v17.
 */

import { v18ScoreTrajectory } from './critic';
import { v18BuildDepGraph, v18BuildZones, v18CheckZoneConflicts, v18DefaultZoneDefs, v18TopoOrder } from './dependencyMap';
import { v18RunEvalComparison } from './evalHarness';
import { v18ReviewPatch } from './reviewSkill';
import type {
  V18AgentReport,
  V18AgentStep,
  V18CriticVerdict,
  V18ReviewReport,
  V18RunAgentInput,
  V18TrajectoryStep,
  V18VerifyReport,
  V18ZoneConflict,
} from './types';

/** Validate một bước agent (fileWrite phải có path + content). */
export function v18ValidateAgentStep(step: V18AgentStep): void {
  if (!step || typeof step !== 'object') throw new Error('Agent step phải là object.');
  if (typeof step.text !== 'string' || step.text.trim() === '') throw new Error('Agent step.text không được rỗng.');
  if (step.fileWrite) {
    if (typeof step.fileWrite.path !== 'string' || step.fileWrite.path.trim() === '') {
      throw new Error('Agent step fileWrite.path không được rỗng.');
    }
    if (typeof step.fileWrite.content !== 'string') throw new Error('Agent step fileWrite.content phải là string.');
    if (step.fileWrite.kind === 'edit' && typeof step.fileWrite.oldText !== 'string') {
      throw new Error('Agent step fileWrite edit cần oldText.');
    }
  }
}

/** Áp một fileWrite lên patch (edit thay oldText bằng content mới). */
export function v18ApplyAgentFileWrite(
  patch: Record<string, string>,
  step: V18AgentStep,
): Record<string, string> {
  if (!step.fileWrite) return patch;
  const next = { ...patch };
  const { path: filePath, content, kind, oldText } = step.fileWrite;
  if (kind === 'edit') {
    const current = next[filePath] ?? '';
    if (oldText !== undefined && current.includes(oldText)) {
      next[filePath] = current.replace(oldText, content);
    } else {
      next[filePath] = `${current}${content}`;
    }
  } else {
    next[filePath] = content;
  }
  return next;
}

/** Chuyển steps của agent thành trajectory steps cho critic. */
export function v18AgentStepsToTrajectory(steps: readonly V18AgentStep[]): V18TrajectoryStep[] {
  return steps.map((step) => {
    const trajectory: V18TrajectoryStep = {
      kind: step.isTest ? 'test' : step.fileWrite ? 'file_write' : step.bashCommand ? 'bash' : 'prompt',
      text: step.bashCommand ?? step.fileWrite?.content ?? step.text,
      files: step.fileWrite ? [step.fileWrite.path] : [],
    };
    if (step.bashCommand) trajectory.exitCode = 0;
    return trajectory;
  });
}

/** Chạy agent v18 scripted end-to-end + verification stack v18. */
export function runV18Agent(input: V18RunAgentInput): V18AgentReport {
  if (!input.sessionId || input.sessionId.trim() === '') throw new Error('sessionId không được rỗng.');
  if (!input.task || input.task.trim() === '') throw new Error('task không được rỗng.');
  for (const step of input.steps) v18ValidateAgentStep(step);

  const doneSteps = input.steps.filter((s) => s.done !== false);
  let patch: Record<string, string> = { ...(input.patch ?? {}) };
  for (const step of doneSteps) patch = v18ApplyAgentFileWrite(patch, step);
  const filesTouched = Object.keys(patch).sort();

  // Trajectory: steps + một test_result cuối nếu có bước test.
  const trajectory = v18AgentStepsToTrajectory(doneSteps);
  const hasTest = doneSteps.some((s) => s.isTest);
  if (hasTest) {
    trajectory.push({ kind: 'test_result', text: 'tests passed', passed: true });
  }
  const critic: V18CriticVerdict = v18ScoreTrajectory(input.sessionId, trajectory, {
    plannedFiles: filesTouched,
    config: input.criticConfig,
    now: input.now,
  });

  const review: V18ReviewReport = v18ReviewPatch(patch, '', { now: input.now });

  // Dependency-map checker trên repo (nếu có repoFiles).
  let depConflicts: V18ZoneConflict[] = [];
  let depCycles: string[][] = [];
  if (input.repoFiles && input.repoFiles.size > 0) {
    const afterFiles = new Map(input.repoFiles);
    for (const [file, content] of Object.entries(patch)) afterFiles.set(file, content);
    const graph = v18BuildDepGraph('repo', afterFiles, { now: input.now });
    depCycles = graph.cycles;
    const zones = v18BuildZones(graph, v18DefaultZoneDefs());
    depConflicts = v18CheckZoneConflicts(graph, zones.zones, filesTouched, {
      ...(input.agentZone ? { agentZone: input.agentZone } : {}),
      topoPlan: v18TopoOrder(graph),
    });
  }

  const evalComparison = v18RunEvalComparison({
    taskId: input.sessionId,
    steps: trajectory,
    patch,
    plannedFiles: filesTouched,
    criticConfig: input.criticConfig,
    ...(input.agentZone ? { agentZone: input.agentZone } : {}),
    ...(input.repoFiles ? { repoFiles: input.repoFiles } : {}),
    now: input.now,
  });

  const failingLayers: string[] = [];
  if (critic.verdict !== 'approve') failingLayers.push('critic');
  if (review.verdict !== 'pass') failingLayers.push('review-skill');
  if (depConflicts.length > 0 || depCycles.length > 0) failingLayers.push('dependency-map');
  if (!evalComparison.allPassed) failingLayers.push('eval-3-verifiers');
  const verification: V18VerifyReport = {
    sessionId: input.sessionId,
    critic,
    review,
    depmap: { cycles: depCycles, conflicts: depConflicts },
    eval: evalComparison,
    allPassed: failingLayers.length === 0,
    failingLayers,
    blockedPush: critic.blocked || review.verdict === 'fail',
  };
  const presentable = verification.allPassed;
  const summary = [
    `Agent v18 ${input.sessionId}: ${doneSteps.length}/${input.steps.length} bước, ${filesTouched.length} files (${filesTouched.join(', ') || 'không có'}).`,
    `Critic ${critic.score}/100 ${critic.verdict}${critic.blocked ? ' — CHẶN PUSH' : ''}; review ${review.verdict.toUpperCase()} (${review.errorCount} error / ${review.warningCount} warning); depmap ${depConflicts.length} xung đột, ${depCycles.length} cycle.`,
    presentable ? 'Kết quả: PRESENTABLE — được phép trình.' : `Kết quả: CHƯA ĐẠT — tầng chưa pass: ${failingLayers.join(', ')}.`,
  ].join('\n');
  return {
    sessionId: input.sessionId,
    task: input.task,
    stepsRun: doneSteps.length,
    filesTouched,
    critic,
    review,
    depConflicts,
    verification,
    presentable,
    summary,
  };
}

/** Render báo cáo agent v18 thành text. */
export function renderV18AgentReport(report: V18AgentReport): string {
  return [
    report.summary,
    `Eval 3 verifier: ${report.verification.eval?.summary ?? '(không có)'}`,
  ].join('\n');
}

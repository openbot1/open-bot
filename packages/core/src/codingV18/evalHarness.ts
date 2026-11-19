/**
 * Coding agent v18 — eval harness mở rộng 3 verifier (v1.40, Đội T4).
 *
 * Ý tưởng học từ survey v140 §6: eval harness chạy verifier mới trên
 * cùng task để so sánh. Code của open-bot: 3 verifier xác định —
 * critic (chấm trajectory), review-skill (quét patch), dependency-map
 * checker (cycle + topo order + zone) — chạy trên cùng một task,
 * báo cáo pass/fail từng verifier + so sánh, chạy 2 lần phải đồng
 * nhất (determinism). Nối v17 (không viết lại): eval gate oracle của
 * v17 vẫn dùng cho task có oracle test; harness v18 so sánh verifier
 * chứ không thay eval task.
 */

import { v18ScorePatch, v18ScoreTrajectory } from './critic';
import {
  v18BuildDepGraph,
  v18BuildZones,
  v18CheckZoneConflicts,
  v18DefaultZoneDefs,
  v18TopoOrder,
} from './dependencyMap';
import type { V18ZoneDef } from './dependencyMap';
import { v18ReviewPatch } from './reviewSkill';
import type {
  V18CriticConfig,
  V18EvalComparison,
  V18EvalSuiteReport,
  V18TrajectoryStep,
  V18VerifierName,
  V18VerifierResult,
} from './types';

export const V18_VERIFIERS: readonly V18VerifierName[] = ['critic', 'review-skill', 'dependency-map'];

export interface V18EvalInput {
  taskId: string;
  /** Trajectory steps cho verifier critic (optional — không có thì critic chấm patch). */
  steps?: readonly V18TrajectoryStep[];
  /** Patch cho review-skill + critic-patch (path -> nội dung mới). */
  patch: Readonly<Record<string, string>>;
  /** Diff text cho review (optional — build từ patch khi rỗng). */
  diffText?: string;
  /** Toàn bộ file repo cho dependency-map checker (path -> nội dung). */
  repoFiles?: ReadonlyMap<string, string>;
  /** File trong plan (để critic chấm completeness / focus). */
  plannedFiles?: readonly string[];
  /** Ngưỡng critic (optional). */
  criticConfig?: V18CriticConfig;
  /** Vùng của agent chạy task (optional — để checker kiểm tra cross-zone). */
  agentZone?: string;
  /** Định nghĩa vùng sở hữu (optional — mặc định theo layout repo). */
  zoneDefs?: readonly V18ZoneDef[];
  /** Timestamp gốc (test dùng clock cố định). */
  now?: number;
}

/** Dựng diff text đơn giản từ patch (khi caller không đưa diff). */
export function v18BuildDiffText(patch: Readonly<Record<string, string>>): string {
  return Object.entries(patch)
    .map(([file, content]) => `--- a/${file}\n+++ b/${file}\n${content.split('\n').map((l) => `+${l}`).join('\n')}`)
    .join('\n');
}

/** Verifier critic: chấm trajectory (hoặc patch khi không có steps). */
export function v18RunVerifierCritic(input: V18EvalInput): V18VerifierResult {
  const started = Date.now();
  const verdict = input.steps && input.steps.length > 0
    ? v18ScoreTrajectory(input.taskId, input.steps, { plannedFiles: input.plannedFiles, config: input.criticConfig, now: input.now })
    : v18ScorePatch(input.patch, input.diffText ?? v18BuildDiffText(input.patch), { plannedFiles: input.plannedFiles, config: input.criticConfig, now: input.now });
  const findings = verdict.dimensions.flatMap((d) => d.reasons.map((r) => `[${d.name} ${d.score}] ${r}`));
  return {
    verifier: 'critic',
    passed: verdict.verdict === 'approve',
    score: verdict.score,
    details: `Critic ${verdict.score}/100 — ${verdict.verdict}${verdict.blocked ? ' (CHẶN PUSH)' : ''}.`,
    durationMs: Date.now() - started,
    findings,
  };
}

/** Verifier review-skill: quét patch bằng 16 rule. */
export function v18RunVerifierReview(input: V18EvalInput): V18VerifierResult {
  const started = Date.now();
  const report = v18ReviewPatch(input.patch, input.diffText ?? v18BuildDiffText(input.patch), { now: input.now });
  return {
    verifier: 'review-skill',
    passed: report.verdict === 'pass',
    details: `Review ${report.verdict.toUpperCase()} — ${report.errorCount} error / ${report.warningCount} warning / ${report.infoCount} info trên ${report.filesReviewed} files.`,
    durationMs: Date.now() - started,
    findings: report.findings.map((f) => `[${f.severity}] ${f.rule} (${f.file}): ${f.message}`),
  };
}

/** Verifier dependency-map: patch không tạo cycle mới, đúng topo order, đúng vùng. */
export function v18RunVerifierDepMap(input: V18EvalInput): V18VerifierResult {
  const started = Date.now();
  const findings: string[] = [];
  const patchFiles = Object.keys(input.patch);
  if (!input.repoFiles || input.repoFiles.size === 0) {
    return {
      verifier: 'dependency-map',
      passed: true,
      details: 'Dependency-map checker: không có repo files để kiểm tra — bỏ qua (pass).',
      durationMs: Date.now() - started,
      findings: ['Không có repo files — checker bỏ qua.'],
    };
  }
  // Graph trước patch (repo gốc) vs sau patch (repo + patch áp lên).
  const before = v18BuildDepGraph('repo', input.repoFiles, { now: input.now });
  const afterFiles = new Map(input.repoFiles);
  for (const [file, content] of Object.entries(input.patch)) afterFiles.set(file, content);
  const after = v18BuildDepGraph('repo', afterFiles, { now: input.now });
  const beforeCycles = new Set(before.cycles.map((c) => [...c].sort().join('|')));
  const newCycles = after.cycles.filter((c) => !beforeCycles.has([...c].sort().join('|')));
  if (newCycles.length > 0) {
    findings.push(`Patch tạo ${newCycles.length} cycle mới: ${newCycles.map((c) => c.join(' -> ')).join('; ')}.`);
  }
  const zones = v18BuildZones(after, input.zoneDefs ?? v18DefaultZoneDefs());
  const topo = v18TopoOrder(after);
  const conflicts = v18CheckZoneConflicts(after, zones.zones, patchFiles, {
    ...(input.agentZone ? { agentZone: input.agentZone } : {}),
    topoPlan: topo,
  });
  for (const conflict of conflicts) findings.push(`[${conflict.kind}] ${conflict.message}`);
  const passed = newCycles.length === 0 && conflicts.length === 0;
  return {
    verifier: 'dependency-map',
    passed,
    details: passed
      ? `Dependency-map checker PASS — ${after.fileCount} files, ${after.edges.length} edges, không cycle mới, không xung đột vùng/thứ tự.`
      : `Dependency-map checker FAIL — ${newCycles.length} cycle mới, ${conflicts.length} xung đột.`,
    durationMs: Date.now() - started,
    findings,
  };
}

/** Chạy một verifier theo tên. */
export function v18RunVerifier(name: V18VerifierName, input: V18EvalInput): V18VerifierResult {
  if (name === 'critic') return v18RunVerifierCritic(input);
  if (name === 'review-skill') return v18RunVerifierReview(input);
  return v18RunVerifierDepMap(input);
}

/** Chạy cả 3 verifier trên cùng task, so sánh kết quả. */
export function v18RunEvalComparison(input: V18EvalInput): V18EvalComparison {
  const results = V18_VERIFIERS.map((name) => v18RunVerifier(name, input));
  const failedVerifiers = results.filter((r) => !r.passed).map((r) => r.verifier);
  const passedCount = results.length - failedVerifiers.length;
  const allPassed = failedVerifiers.length === 0;
  const summary = [
    `Eval v18 task ${input.taskId}: ${passedCount}/3 verifier pass — ${results.map((r) => `${r.verifier}:${r.passed ? 'PASS' : 'FAIL'}${r.score !== undefined ? `(${r.score})` : ''}`).join(', ')}.`,
    allPassed ? 'Cả 3 verifier đồng ý: task đạt.' : `Verifier chưa pass: ${failedVerifiers.join(', ')} — xem chi tiết từng verifier trước khi trình.`,
  ].join('\n');
  return {
    taskId: input.taskId,
    results,
    allPassed,
    passedCount,
    failedVerifiers,
    summary,
    ranAt: input.now ?? Date.now(),
  };
}

/** Hai lần chạy comparison có đồng nhất không (determinism — bỏ qua durationMs). */
export function v18ComparisonsAgree(a: V18EvalComparison, b: V18EvalComparison): boolean {
  if (a.taskId !== b.taskId || a.allPassed !== b.allPassed || a.results.length !== b.results.length) return false;
  return a.results.every((result, idx) => {
    const other = b.results[idx];
    if (!other || result.verifier !== other.verifier || result.passed !== other.passed || result.score !== other.score) return false;
    if (result.details !== other.details) return false;
    return JSON.stringify(result.findings) === JSON.stringify(other.findings);
  });
}

/** Render comparison thành text. */
export function renderV18EvalComparison(comparison: V18EvalComparison): string {
  const lines = [comparison.summary];
  for (const result of comparison.results) {
    lines.push(`\n[${result.verifier}] ${result.passed ? 'PASS' : 'FAIL'} — ${result.details}`);
    for (const finding of result.findings.slice(0, 8)) lines.push(`  - ${finding}`);
    if (result.findings.length > 8) lines.push(`  … +${result.findings.length - 8} findings nữa`);
  }
  return lines.join('\n');
}

/** Tỉ lệ pass từng verifier trên một tập comparison (0..1). */
export function v18VerifierPassRates(comparisons: readonly V18EvalComparison[]): Record<V18VerifierName, number> {
  const rates: Record<V18VerifierName, number> = { critic: 0, 'review-skill': 0, 'dependency-map': 0 };
  if (comparisons.length === 0) return rates;
  for (const name of V18_VERIFIERS) {
    const passed = comparisons.filter((c) => c.results.find((r) => r.verifier === name)?.passed).length;
    rates[name] = Math.round((passed / comparisons.length) * 100) / 100;
  }
  return rates;
}

/**
 * Chạy eval suite: comparison 3 verifier trên NHIỀU task, tổng hợp tỉ
 * lệ pass từng verifier + task tệ nhất. Suite pass khi mọi task pass.
 */
export function v18RunEvalSuite(
  tasks: readonly V18EvalInput[],
  options: { now?: number } = {},
): V18EvalSuiteReport {
  if (tasks.length === 0) throw new Error('Eval suite cần ít nhất 1 task.');
  const taskIds = tasks.map((t) => t.taskId);
  if (new Set(taskIds).size !== taskIds.length) {
    throw new Error('Eval suite: taskId trùng nhau.');
  }
  const comparisons = tasks.map((task) => v18RunEvalComparison(task));
  const passedTasks = comparisons.filter((c) => c.allPassed).length;
  const verifierPassRates = v18VerifierPassRates(comparisons);
  // Task tệ nhất: ít verifier pass nhất, rồi điểm critic thấp nhất.
  const worst = [...comparisons].sort((a, b) => {
    if (a.passedCount !== b.passedCount) return a.passedCount - b.passedCount;
    const scoreA = a.results.find((r) => r.verifier === 'critic')?.score ?? 100;
    const scoreB = b.results.find((r) => r.verifier === 'critic')?.score ?? 100;
    return scoreA - scoreB;
  })[0];
  const weakest = (Object.entries(verifierPassRates) as Array<[V18VerifierName, number]>)
    .sort((a, b) => a[1] - b[1])[0];
  const summary = [
    `Eval suite v18: ${passedTasks}/${tasks.length} task pass cả 3 verifier.`,
    `Tỉ lệ pass từng verifier: ${V18_VERIFIERS.map((name) => `${name} ${Math.round(verifierPassRates[name] * 100)}%`).join(', ')}.`,
    weakest && weakest[1] < 1
      ? `Verifier yếu nhất: ${weakest[0]} (${Math.round(weakest[1] * 100)}% pass) — ưu tiên sửa tầng này trước.`
      : 'Cả 3 verifier đều pass 100% trên suite.',
    worst && !worst.allPassed ? `Task tệ nhất: ${worst.taskId} (${worst.passedCount}/3 verifier pass).` : '',
  ].filter((line) => line !== '').join('\n');
  return {
    taskIds,
    comparisons,
    allPassed: passedTasks === tasks.length,
    passedTasks,
    totalTasks: tasks.length,
    verifierPassRates,
    ...(worst && !worst.allPassed ? { worstTaskId: worst.taskId } : {}),
    summary,
    ranAt: options.now ?? Date.now(),
  };
}

/** Render eval suite report thành text. */
export function renderV18EvalSuiteReport(report: V18EvalSuiteReport): string {
  const lines = [report.summary];
  for (const comparison of report.comparisons) {
    lines.push(`\n- ${comparison.taskId}: ${comparison.passedCount}/3 verifier pass${comparison.allPassed ? '' : ` — chưa pass: ${comparison.failedVerifiers.join(', ')}`}`);
  }
  return lines.join('\n');
}

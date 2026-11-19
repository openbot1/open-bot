/**
 * Coding agent v15 — eval (chấm điểm run theo rubric).
 *
 * Verify scenarios trả lời "agent xử lý tình huống lỗi ra sao";
 * eval này trả lời "run này tốt đến mức nào" theo 5 chiều, mỗi
 * chiều 0..100, có trọng số, ra điểm tổng + hạng A–F + lý do từng
 * chiều. Rubric là heuristic trên dữ liệu run thật (không gọi
 * model chấm — điểm số là đo lường, không phải nhận xét chủ quan):
 *
 * - completion (30%): done? hết step mà chưa done thì trừ nặng.
 * - correctness signals (25%): tool error càng nhiều càng trừ;
 *   file ghi ra là tín hiệu làm được việc (nhưng không đủ để pass
 *   một mình — run done mà không ghi file nào vẫn được điểm tối đa
 *   ở chiều này nếu không có lỗi).
 * - efficiency (15%): step dùng / max step — càng ít step càng tốt
 *   (run done trong 1-2 step được điểm cao).
 * - budget discipline (15%): trong cap = 100; vượt cap trừ theo
 *   mức vượt (report-only nên vượt cap không auto-fail, chỉ trừ
 *   điểm chiều này).
 * - hook handling (15%): feedback của hook được xử lý (không còn
 *   pending) = tốt; pending càng nhiều càng trừ (feedback bị bỏ
 *   quên trong dialog là nợ).
 *
 * Điểm tổng >= 90: A, >= 80: B, >= 70: C, >= 60: D, còn lại: F.
 * Eval không chặn run, không sửa run — chỉ chấm sau khi run xong.
 */

import type { V15AgentRunResult } from './types';

/** Một chiều chấm điểm. */
export interface V15EvalDimension {
  name: string;
  /** Trọng số (tổng các chiều = 1). */
  weight: number;
  /** Điểm 0..100. */
  score: number;
  /** Lý do ngắn gọn. */
  reason: string;
}

/** Kết quả eval một run. */
export interface V15EvalResult {
  runId: string;
  profileId: string;
  /** Điểm tổng 0..100 (trung bình có trọng số). */
  total: number;
  /** Hạng A–F. */
  grade: string;
  dimensions: V15EvalDimension[];
  summary: string;
  evaluatedAt: string;
}

/** Trọng số các chiều (tổng = 1). */
export const V15_EVAL_WEIGHTS = {
  completion: 0.3,
  correctness: 0.25,
  efficiency: 0.15,
  budget: 0.15,
  hooks: 0.15,
} as const;

/** Ngưỡng hạng (điểm tổng tối thiểu). */
export const V15_EVAL_GRADE_THRESHOLDS = [
  { grade: 'A', min: 90 },
  { grade: 'B', min: 80 },
  { grade: 'C', min: 70 },
  { grade: 'D', min: 60 },
  { grade: 'F', min: 0 },
] as const;

function clampScore(score: number): number {
  if (!Number.isFinite(score)) return 0;
  return Math.max(0, Math.min(100, Math.round(score)));
}

function gradeFor(total: number): string {
  for (const t of V15_EVAL_GRADE_THRESHOLDS) {
    if (total >= t.min) return t.grade;
  }
  return 'F';
}

function evalCompletion(result: V15AgentRunResult): V15EvalDimension {
  if (result.done) {
    return { name: 'completion', weight: V15_EVAL_WEIGHTS.completion, score: 100, reason: 'Agent finished (done=true).' };
  }
  if (result.stoppedByMaxSteps) {
    return { name: 'completion', weight: V15_EVAL_WEIGHTS.completion, score: 30, reason: `Agent stopped by max steps after ${result.stepsExecuted} steps without finishing.` };
  }
  return { name: 'completion', weight: V15_EVAL_WEIGHTS.completion, score: 50, reason: `Agent stopped after ${result.stepsExecuted} steps without finishing.` };
}

function evalCorrectness(result: V15AgentRunResult): V15EvalDimension {
  const errors = result.toolErrors.length;
  if (errors === 0) {
    return {
      name: 'correctness',
      weight: V15_EVAL_WEIGHTS.correctness,
      score: 100,
      reason: result.filesWritten.length > 0
        ? `No tool errors; wrote ${result.filesWritten.length} file(s).`
        : 'No tool errors.',
    };
  }
  const score = clampScore(100 - errors * 25);
  return {
    name: 'correctness',
    weight: V15_EVAL_WEIGHTS.correctness,
    score,
    reason: `${errors} tool error(s): ${result.toolErrors.slice(0, 2).join(' | ')}${errors > 2 ? ` (+${errors - 2} more)` : ''}.`,
  };
}

function evalEfficiency(result: V15AgentRunResult): V15EvalDimension {
  if (result.stepsExecuted <= 0) {
    return { name: 'efficiency', weight: V15_EVAL_WEIGHTS.efficiency, score: 50, reason: 'No steps executed.' };
  }
  if (!result.done) {
    return { name: 'efficiency', weight: V15_EVAL_WEIGHTS.efficiency, score: 40, reason: `${result.stepsExecuted} steps without finishing.` };
  }
  // Done trong 1 step = 100; mỗi step thêm trừ 8, sàn 40.
  const score = clampScore(100 - (result.stepsExecuted - 1) * 8);
  const floored = Math.max(40, score);
  return {
    name: 'efficiency',
    weight: V15_EVAL_WEIGHTS.efficiency,
    score: floored,
    reason: `Finished in ${result.stepsExecuted} step(s).`,
  };
}

function evalBudget(result: V15AgentRunResult): V15EvalDimension {
  const s = result.budget.state;
  if (!s.overCap) {
    const percent = s.tokensPercent ?? s.costPercent ?? 0;
    return {
      name: 'budget',
      weight: V15_EVAL_WEIGHTS.budget,
      score: 100,
      reason: `Within cap (${s.totalTokens.toLocaleString('en-US')} tokens, ${percent === 0 ? 'no cap' : `${percent.toFixed(1)}% of cap`}).`,
    };
  }
  const over = Math.max(s.tokensPercent ?? 0, s.costPercent ?? 0) - 100;
  // Vượt 1-20% trừ 20, vượt càng nhiều trừ càng nặng, sàn 20 (report-only: không auto-F).
  const score = clampScore(Math.max(20, 80 - over));
  return {
    name: 'budget',
    weight: V15_EVAL_WEIGHTS.budget,
    score,
    reason: `Over cap by ${over.toFixed(1)}% (report-only — run continued).`,
  };
}

function evalHooks(result: V15AgentRunResult): V15EvalDimension {
  const d = result.hooksDialog;
  if (d.total === 0) {
    return { name: 'hooks', weight: V15_EVAL_WEIGHTS.hooks, score: 100, reason: 'No hook feedback to handle.' };
  }
  if (d.pending === 0) {
    return { name: 'hooks', weight: V15_EVAL_WEIGHTS.hooks, score: 100, reason: `All ${d.total} hook feedback item(s) handled (confirmed/dismissed).` };
  }
  const score = clampScore(100 - d.pending * 20);
  return {
    name: 'hooks',
    weight: V15_EVAL_WEIGHTS.hooks,
    score,
    reason: `${d.pending}/${d.total} hook feedback item(s) still pending in the dialog.`,
  };
}

/** Chấm điểm một run v15 theo rubric (không gọi model). */
export function v15EvalRun(result: V15AgentRunResult, now?: string): V15EvalResult {
  const dimensions = [
    evalCompletion(result),
    evalCorrectness(result),
    evalEfficiency(result),
    evalBudget(result),
    evalHooks(result),
  ];
  const total = Math.round(dimensions.reduce((sum, d) => sum + d.score * d.weight, 0));
  const grade = gradeFor(total);
  return {
    runId: result.runId,
    profileId: result.profileId,
    total,
    grade,
    dimensions,
    summary: `Eval run ${result.runId} (profile ${result.profileId}): ${total}/100 grade ${grade} — ` +
      dimensions.map((d) => `${d.name} ${d.score}`).join(', ') + '.',
    evaluatedAt: now ?? new Date().toISOString(),
  };
}

/** Render kết quả eval thành text. */
export function renderV15EvalResult(evalResult: V15EvalResult): string {
  const lines = [
    `Eval — run ${evalResult.runId} (profile ${evalResult.profileId}): ${evalResult.total}/100 — grade ${evalResult.grade}`,
  ];
  for (const d of evalResult.dimensions) {
    lines.push(`  ${d.name} (${Math.round(d.weight * 100)}%): ${d.score} — ${d.reason}`);
  }
  lines.push(`  ${evalResult.summary}`);
  return lines.join('\n');
}

/**
 * Coding agent v16 — Benchmark nội bộ: đo cost/accuracy trade-off
 * trên task mẫu có script (không gọi model thật).
 *
 * Mỗi task mẫu có script riêng cho từng harness (cùng task, khác
 * harness → khác preamble/token/step). Benchmark chạy script qua
 * minimal harness (đo token thật theo script) hoặc dùng token ghi
 * sẵn trong script, tính điểm từ expectedScore của task, ghi cost
 * record vào HarnessCostEstimator, rồi trả báo cáo trade-off tái dùng
 * từ harnessCost (so sánh điểm vs $ trên cùng bộ task). Rerun cùng
 * harness với script khác nhau cho thấy độ nhiễu (flaky) — benchmark
 * ghi rõ note 'rerun' khi task chạy lại.
 */

import { CodingV16Error } from './types';
import type { V16BenchmarkReport, V16BenchmarkTask, V16CostAccuracyReport } from './types';
import {
  HarnessCostEstimator,
  renderV16CostAccuracyReport,
  renderV16FlakinessSummary,
  v16AnalyzeFlakiness,
  v16BuildCostAccuracyReport,
  v16SummarizeFlakiness,
} from './harnessCost';
import type { V16FlakinessSummary, V16TaskFlakiness } from './harnessCost';
import { runV16Minimal } from './minimalHarness';

/** Validate một task benchmark (script cho từng harness, điểm 0..1). */
export function v16ValidateBenchmarkTask(task: unknown, index: number): V16BenchmarkTask {
  if (!task || typeof task !== 'object' || Array.isArray(task)) {
    throw new CodingV16Error('benchmark-invalid', `benchmark tasks[${index}] must be an object.`);
  }
  const t = task as Record<string, unknown>;
  if (typeof t['id'] !== 'string' || (t['id'] as string).trim() === '') {
    throw new CodingV16Error('benchmark-invalid', `benchmark tasks[${index}].id must be a non-empty string.`);
  }
  if (typeof t['prompt'] !== 'string' || (t['prompt'] as string).trim() === '') {
    throw new CodingV16Error('benchmark-invalid', `benchmark tasks[${index}].prompt must be a non-empty string.`);
  }
  if (typeof t['expectedScore'] !== 'number' || (t['expectedScore'] as number) < 0 || (t['expectedScore'] as number) > 1) {
    throw new CodingV16Error('benchmark-invalid', `benchmark tasks[${index}].expectedScore must be within [0, 1].`);
  }
  if (!t['scripts'] || typeof t['scripts'] !== 'object' || Array.isArray(t['scripts'])) {
    throw new CodingV16Error('benchmark-invalid', `benchmark tasks[${index}].scripts must be an object (harnessId -> steps).`);
  }
  const scripts = t['scripts'] as Record<string, unknown>;
  const harnessIds = Object.keys(scripts);
  if (harnessIds.length === 0) {
    throw new CodingV16Error('benchmark-invalid', `benchmark tasks[${index}].scripts needs at least one harness.`);
  }
  for (const hid of harnessIds) {
    if (!Array.isArray(scripts[hid]) || (scripts[hid] as unknown[]).length === 0) {
      throw new CodingV16Error('benchmark-invalid', `benchmark tasks[${index}].scripts["${hid}"] must be a non-empty array.`);
    }
  }
  return {
    id: t['id'] as string,
    prompt: t['prompt'] as string,
    scripts: scripts as unknown as V16BenchmarkTask['scripts'],
    expectedScore: t['expectedScore'] as number,
    ...(typeof t['passThreshold'] === 'number' ? { passThreshold: t['passThreshold'] as number } : {}),
  };
}

/** Input chạy benchmark. */
export interface V16RunBenchmarkInput {
  /** Task mẫu (ít nhất 1). */
  tasks: V16BenchmarkTask[];
  /** Harness cần đo (mặc định: mọi harness có script trong task). */
  harnessIds?: string[];
  /** Model dùng để tính tiền (mặc định 'claude-sonnet-4'). */
  model?: string;
  /** Estimator ngoài (mặc định: tạo mới). */
  estimator?: HarnessCostEstimator;
  /** Ghi chú chung cho mọi record (vd 'rerun-2'). */
  note?: string;
}

/** Chạy benchmark: đo từng harness trên từng task, trả báo cáo trade-off. */
export function runV16Benchmark(input: V16RunBenchmarkInput): V16BenchmarkReport {
  if (!Array.isArray(input.tasks) || input.tasks.length === 0) {
    throw new CodingV16Error('benchmark-no-tasks', 'Benchmark needs at least one task.');
  }
  const tasks = input.tasks.map((t, i) => v16ValidateBenchmarkTask(t, i));
  const model = input.model ?? 'claude-sonnet-4';
  const estimator = input.estimator ?? new HarnessCostEstimator();
  const harnessIds =
    input.harnessIds ??
    [...new Set(tasks.flatMap((t) => Object.keys(t.scripts)))];
  if (harnessIds.length === 0) {
    throw new CodingV16Error('benchmark-invalid', 'Benchmark needs at least one harness id.');
  }
  const preambleTokensByHarness: Record<string, number> = {};
  for (const harnessId of harnessIds) {
    const profile = estimator.getProfile(harnessId);
    preambleTokensByHarness[harnessId] = profile?.preambleTokens ?? 0;
  }
  for (const task of tasks) {
    for (const harnessId of harnessIds) {
      const script = task.scripts[harnessId];
      if (!script) continue;
      // Chạy script qua minimal harness để đo token/step thật theo
      // script (preamble + từng step), không gọi model.
      const { report } = runV16Minimal({
        runId: `${task.id}:${harnessId}`,
        prompt: task.prompt,
        steps: script,
        config: { maxSteps: script.length },
      });
      // Token của harness "đầy đủ" = token đo được + chênh preamble
      // (profile preamble trừ preamble minimal đã đo) — phản ánh đúng
      // chi phí harness nặng preamble lớn.
      const profilePreamble = estimator.getProfile(harnessId)?.preambleTokens ?? report.preambleTokens;
      const preambleDelta = Math.max(0, profilePreamble - report.preambleTokens);
      const promptTokens = report.promptTokens + preambleDelta;
      estimator.record({
        taskId: task.id,
        harnessId,
        model,
        score: task.expectedScore,
        promptTokens,
        completionTokens: report.completionTokens,
        steps: report.stepsRun,
        passThreshold: task.passThreshold ?? 1,
        ...(input.note !== undefined ? { note: input.note } : {}),
      });
    }
  }
  const taskIds = tasks.map((t) => t.id);
  const costAccuracy = v16BuildCostAccuracyReport(estimator.allRecords(), taskIds, harnessIds);
  return {
    generatedAt: Date.now(),
    harnessIds,
    taskIds,
    costAccuracy,
    preambleTokensByHarness,
    verdict: costAccuracy.verdict,
  };
}

/** Render báo cáo benchmark thành text. */
export function renderV16BenchmarkReport(report: V16BenchmarkReport): string {
  const lines: string[] = [];
  lines.push(`Benchmark v16 — ${report.taskIds.length} task(s) x ${report.harnessIds.length} harness(es)`);
  for (const hid of report.harnessIds) {
    lines.push(`- ${hid}: preamble ${report.preambleTokensByHarness[hid] ?? 0} tokens`);
  }
  lines.push(renderV16CostAccuracyReport(report.costAccuracy));
  return lines.join('\n');
}

/** Kết quả benchmark chạy lại (rerun): so sánh 2 lần chạy cùng task. */
export interface V16BenchmarkRerunReport {
  generatedAt: number;
  harnessIds: string[];
  taskIds: string[];
  /** Báo cáo trade-off gộp cả 2 lần chạy. */
  costAccuracy: V16CostAccuracyReport;
  /** Flakiness theo task (điểm lật giữa 2 lần chạy). */
  flakiness: V16TaskFlakiness[];
  flakinessSummary: V16FlakinessSummary;
  /** Báo cáo từng lần chạy (run 1 / run 2). */
  runs: V16BenchmarkReport[];
  /** Kết luận ngắn (gồm cả độ nhiễu). */
  verdict: string;
}

/**
 * Chạy benchmark 2 lần (rerun) trên cùng task mẫu để đo độ nhiễu:
 * lần 2 dùng cùng script nhưng note 'rerun' (giống nghiên cứu: rerun
 * cùng harness cũng lật ~13% task khó). Trả flakiness + trade-off gộp.
 */
export function runV16BenchmarkRerun(input: V16RunBenchmarkInput): V16BenchmarkRerunReport {
  if (!Array.isArray(input.tasks) || input.tasks.length === 0) {
    throw new CodingV16Error('benchmark-no-tasks', 'Benchmark needs at least one task.');
  }
  const estimator = input.estimator ?? new HarnessCostEstimator();
  const model = input.model ?? 'claude-sonnet-4';
  const run1 = runV16Benchmark({ ...input, model, estimator, note: 'run-1' });
  const run2 = runV16Benchmark({ ...input, model, estimator, note: 'rerun-2' });
  const taskIds = run1.taskIds;
  const harnessIds = run1.harnessIds;
  const costAccuracy = v16BuildCostAccuracyReport(estimator.allRecords(), taskIds, harnessIds);
  const flakiness = v16AnalyzeFlakiness(estimator.allRecords());
  const flakinessSummary = v16SummarizeFlakiness(flakiness);
  const verdict =
    `${costAccuracy.verdict} ${renderV16FlakinessSummary(flakinessSummary)}`;
  return {
    generatedAt: Date.now(),
    harnessIds,
    taskIds,
    costAccuracy,
    flakiness,
    flakinessSummary,
    runs: [run1, run2],
    verdict,
  };
}

/** Render báo cáo rerun thành text. */
export function renderV16BenchmarkRerunReport(report: V16BenchmarkRerunReport): string {
  const lines: string[] = [];
  lines.push(`Benchmark rerun v16 — ${report.taskIds.length} task(s) x ${report.harnessIds.length} harness(es), 2 runs each`);
  lines.push(renderV16CostAccuracyReport(report.costAccuracy));
  lines.push(renderV16FlakinessSummary(report.flakinessSummary));
  for (const f of report.flakiness) {
    if (f.flipped) {
      lines.push(`- FLIPPED ${f.taskId}: ${f.passes}/${f.runs} passes, score ${f.minScore}..${f.maxScore}, cost $${f.minCostUsd}..$${f.maxCostUsd}`);
    }
  }
  lines.push(`Verdict: ${report.verdict}`);
  return lines.join('\n');
}

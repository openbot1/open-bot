/**
 * Eval Harness v2 — regression gate cho CI (v1.34, Đội T4).
 *
 * So sánh điểm suite hiện tại với baseline đã lưu — tụt quá ngưỡng thì
 * gate FAIL, kèm báo cáo task nào tụt. Lưu baseline local-first (file
 * JSON dưới `<baseDir>/eval-harness-v2/baseline.json`, atomic tmp +
 * rename, mode 0600 — cùng posture với eval-reports/ của eval v1).
 *
 * Ngưỡng mặc định (có thể chỉnh theo suite):
 * - suite trial pass rate tụt > 0.05 → FAIL.
 * - một task tụt pass rate > 0.10 → FAIL (kèm tên task).
 * - thời gian trung bình / trial tăng > 2× → cảnh báo (không FAIL —
 *   máy CI tải khác nhau; chỉ ghi vào report, không chặn).
 * - chi phí trung bình / trial tăng > 2× → cảnh báo (không FAIL).
 *
 * Gate chỉ FAIL trên điểm (pass rate) — thời gian/chi phí chỉ cảnh
 * báo, vì chúng phụ thuộc máy chạy và giá model, không phản ánh đúng
 * sai của agent. Không có baseline → gate PASS kèm ghi chú "no
 * baseline" (lần chạy đầu tiên không thể tụt so với cái chưa có).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type {
  EvalHarnessV2SuiteResult,
  EvalHarnessV2TaskResult,
} from './types.js';

export const EVAL_HARNESS_V2_DIR = 'eval-harness-v2';
export const EVAL_HARNESS_V2_BASELINE_FILE = 'baseline.json';
export const EVAL_HARNESS_V2_REPORTS_DIR = 'eval-harness-v2-reports';

/** Baseline đã lưu của một suite (snapshot điểm, không lưu toàn bộ trial). */
export interface EvalHarnessV2Baseline {
  suiteId: string;
  agentLabel: string;
  runId: string;
  at: number;
  trialPassRate: number;
  taskPassRate: number;
  meanScore: number;
  totalTrials: number;
  perTask: Record<
    string,
    {
      passRate: number;
      meanScore: number;
      meanDurationMs: number;
      meanSteps: number;
      meanCostUsd: number;
      trials: number;
    }
  >;
}

/** Ngưỡng regression của gate. */
export interface EvalHarnessV2GateThresholds {
  /** Suite trial pass rate được tụt tối đa. Mặc định 0.05. */
  suitePassRateDrop: number;
  /** Một task được tụt pass rate tối đa. Mặc định 0.10. */
  taskPassRateDrop: number;
  /** Thời gian / trial tăng quá bội này → cảnh báo. Mặc định 2. */
  durationRiseFactor: number;
  /** Chi phí / trial tăng quá bội này → cảnh báo. Mặc định 2. */
  costRiseFactor: number;
}

export const DEFAULT_EVAL_HARNESS_V2_GATE_THRESHOLDS: EvalHarnessV2GateThresholds = {
  suitePassRateDrop: 0.05,
  taskPassRateDrop: 0.1,
  durationRiseFactor: 2,
  costRiseFactor: 2,
};

/** Một lần tụt điểm (FAIL) hoặc cảnh báo của gate. */
export interface EvalHarnessV2GateFinding {
  /** 'fail' chặn CI; 'warn' chỉ ghi chú. */
  level: 'fail' | 'warn';
  /** Phạm vi: 'suite' hay id task. */
  scope: string;
  metric: 'trialPassRate' | 'taskPassRate' | 'meanDurationMs' | 'meanCostUsd';
  baseline: number;
  current: number;
  /** current − baseline (âm = tụt / giảm; dương = tăng với duration/cost). */
  delta: number;
  threshold: number;
  message: string;
}

/** Kết quả gate: pass = CI được đi tiếp. */
export interface EvalHarnessV2GateResult {
  /** true khi không có finding 'fail' (kể cả khi chưa có baseline). */
  passed: boolean;
  /** true khi không có baseline để so (lần chạy đầu). */
  noBaseline: boolean;
  baselineAt: number | null;
  currentRunId: string;
  suiteId: string;
  findings: EvalHarnessV2GateFinding[];
}

export function getEvalHarnessV2Dir(baseDir: string): string {
  return path.join(baseDir, EVAL_HARNESS_V2_DIR);
}

export function getEvalHarnessV2BaselinePath(baseDir: string): string {
  return path.join(getEvalHarnessV2Dir(baseDir), EVAL_HARNESS_V2_BASELINE_FILE);
}

export function getEvalHarnessV2ReportsDir(baseDir: string): string {
  return path.join(baseDir, EVAL_HARNESS_V2_REPORTS_DIR);
}

/** Build baseline từ kết quả suite vừa chạy (snapshot điểm, không lưu trial). */
export function buildEvalHarnessV2Baseline(
  result: EvalHarnessV2SuiteResult,
): EvalHarnessV2Baseline {
  const perTask: EvalHarnessV2Baseline['perTask'] = {};
  for (const task of result.tasks) {
    perTask[task.taskId] = {
      passRate: task.passRate,
      meanScore: task.meanScore,
      meanDurationMs: task.meanDurationMs,
      meanSteps: task.meanSteps,
      meanCostUsd: task.meanCostUsd,
      trials: task.trials.length,
    };
  }
  return {
    suiteId: result.suiteId,
    agentLabel: result.agentLabel,
    runId: result.runId,
    at: result.finishedAt,
    trialPassRate: result.trialPassRate,
    taskPassRate: result.taskPassRate,
    meanScore: result.meanScore,
    totalTrials: result.tasks.flatMap((t) => t.trials).length,
    perTask,
  };
}

/** Lưu baseline (atomic tmp + rename, mode 0600). */
export function saveEvalHarnessV2Baseline(
  baseDir: string,
  baseline: EvalHarnessV2Baseline,
): string {
  const dir = getEvalHarnessV2Dir(baseDir);
  fs.mkdirSync(dir, { recursive: true });
  const filePath = getEvalHarnessV2BaselinePath(baseDir);
  const tmpPath = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(baseline, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmpPath, filePath);
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // Filesystem không hỗ trợ chmod — bỏ qua.
  }
  return filePath;
}

/** Đọc baseline đã lưu (không có → null). */
export function loadEvalHarnessV2Baseline(baseDir: string): EvalHarnessV2Baseline | null {
  let raw: string;
  try {
    raw = fs.readFileSync(getEvalHarnessV2BaselinePath(baseDir), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  const parsed = JSON.parse(raw) as EvalHarnessV2Baseline;
  if (typeof parsed !== 'object' || parsed === null || typeof parsed.suiteId !== 'string') {
    throw new Error('Baseline eval-harness-v2 hỏng: thiếu suiteId.');
  }
  return parsed;
}

/** Lưu báo cáo suite đầy đủ (để CLI/tool/UI đọc lại). */
export function saveEvalHarnessV2Report(
  baseDir: string,
  result: EvalHarnessV2SuiteResult,
): string {
  const dir = getEvalHarnessV2ReportsDir(baseDir);
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${result.runId}.json`);
  const tmpPath = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmpPath, filePath);
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // Bỏ qua.
  }
  return filePath;
}

/** So sánh kết quả suite hiện tại với baseline → gate result. */
export function checkEvalHarnessV2Regression(
  baseline: EvalHarnessV2Baseline | null,
  current: EvalHarnessV2SuiteResult,
  thresholds: EvalHarnessV2GateThresholds = DEFAULT_EVAL_HARNESS_V2_GATE_THRESHOLDS,
): EvalHarnessV2GateResult {
  if (baseline === null) {
    return {
      passed: true,
      noBaseline: true,
      baselineAt: null,
      currentRunId: current.runId,
      suiteId: current.suiteId,
      findings: [],
    };
  }
  const findings: EvalHarnessV2GateFinding[] = [];
  const pct = (n: number): string => `${(n * 100).toFixed(1)}%`;

  // 1. Suite trial pass rate.
  const suiteDrop = current.trialPassRate - baseline.trialPassRate;
  if (suiteDrop < -thresholds.suitePassRateDrop) {
    findings.push({
      level: 'fail',
      scope: 'suite',
      metric: 'trialPassRate',
      baseline: baseline.trialPassRate,
      current: current.trialPassRate,
      delta: suiteDrop,
      threshold: thresholds.suitePassRateDrop,
      message:
        `Suite trial pass rate tụt từ ${pct(baseline.trialPassRate)} xuống ${pct(current.trialPassRate)} ` +
        `(tụt ${pct(-suiteDrop)}, ngưỡng ${pct(thresholds.suitePassRateDrop)}).`,
    });
  }

  // 2. Từng task: pass rate tụt quá ngưỡng → FAIL kèm tên task.
  const currentById = new Map<string, EvalHarnessV2TaskResult>(
    current.tasks.map((t) => [t.taskId, t]),
  );
  for (const [taskId, base] of Object.entries(baseline.perTask)) {
    const cur = currentById.get(taskId);
    if (cur === undefined) continue; // Task không còn trong suite — không so.
    const drop = cur.passRate - base.passRate;
    if (drop < -thresholds.taskPassRateDrop) {
      findings.push({
        level: 'fail',
        scope: taskId,
        metric: 'taskPassRate',
        baseline: base.passRate,
        current: cur.passRate,
        delta: drop,
        threshold: thresholds.taskPassRateDrop,
        message:
          `Task ${taskId} tụt pass rate từ ${pct(base.passRate)} xuống ${pct(cur.passRate)} ` +
          `(tụt ${pct(-drop)}, ngưỡng ${pct(thresholds.taskPassRateDrop)}).`,
      });
    }
    // 3. Thời gian / chi phí tăng mạnh → chỉ cảnh báo, không FAIL.
    if (base.meanDurationMs > 0 && cur.meanDurationMs > base.meanDurationMs * thresholds.durationRiseFactor) {
      findings.push({
        level: 'warn',
        scope: taskId,
        metric: 'meanDurationMs',
        baseline: base.meanDurationMs,
        current: cur.meanDurationMs,
        delta: cur.meanDurationMs - base.meanDurationMs,
        threshold: thresholds.durationRiseFactor,
        message:
          `Task ${taskId} chậm hơn ${(cur.meanDurationMs / base.meanDurationMs).toFixed(1)}× ` +
          `(${base.meanDurationMs.toFixed(0)}ms → ${cur.meanDurationMs.toFixed(0)}ms/trial).`,
      });
    }
    if (base.meanCostUsd > 0 && cur.meanCostUsd > base.meanCostUsd * thresholds.costRiseFactor) {
      findings.push({
        level: 'warn',
        scope: taskId,
        metric: 'meanCostUsd',
        baseline: base.meanCostUsd,
        current: cur.meanCostUsd,
        delta: cur.meanCostUsd - base.meanCostUsd,
        threshold: thresholds.costRiseFactor,
        message:
          `Task ${taskId} đắt hơn ${(cur.meanCostUsd / base.meanCostUsd).toFixed(1)}× ` +
          `($${base.meanCostUsd.toFixed(4)} → $${cur.meanCostUsd.toFixed(4)}/trial).`,
      });
    }
  }

  return {
    passed: !findings.some((f) => f.level === 'fail'),
    noBaseline: false,
    baselineAt: baseline.at,
    currentRunId: current.runId,
    suiteId: current.suiteId,
    findings,
  };
}

/** Render kết quả gate thành text (CI log / CLI in ra). */
export function renderEvalHarnessV2GateText(result: EvalHarnessV2GateResult): string {
  const lines: string[] = [];
  if (result.noBaseline) {
    lines.push(
      `Eval Harness v2 gate: PASS (chưa có baseline — lần chạy đầu tiên, đã lưu baseline mới).`,
    );
    return `${lines.join('\n')}\n`;
  }
  lines.push(
    `Eval Harness v2 gate: ${result.passed ? 'PASS' : 'FAIL'} ` +
      `(suite ${result.suiteId}, run ${result.currentRunId}, baseline lúc ${new Date(result.baselineAt ?? 0).toISOString()})`,
  );
  if (result.findings.length === 0) {
    lines.push('  Không có task nào tụt quá ngưỡng.');
  }
  for (const f of result.findings) {
    lines.push(`  ${f.level === 'fail' ? 'FAIL' : 'WARN'}  [${f.scope}] ${f.message}`);
  }
  return `${lines.join('\n')}\n`;
}

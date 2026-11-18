/**
 * Eval Harness v3 — regression gates (v1.35, Đội T4).
 *
 * Gate chặn merge khi eval hồi quy: chạy suite rồi so với baseline đã
 * lưu (điểm chuẩn) — tụt quá ngưỡng thì gate FAIL, CI dừng lại.
 *
 * Ngưỡng v3 (mạnh hơn v2 — v2 chỉ so pass rate):
 * - suitePassRateDrop: suite trial pass rate tụt tối đa cho phép.
 * - taskPassRateDrop: pass rate từng task tụt tối đa cho phép.
 * - meanScoreDrop: điểm trung bình suite tụt tối đa cho phép.
 * - maxCostIncreaseUsd: chi phí suite tăng tối đa cho phép (USD).
 * - maxDurationIncreaseMs: thời gian suite tăng tối đa cho phép (ms).
 * - maxGuardrailTrips: số guardrail trip tối đa cho phép trong suite.
 * Mỗi ngưỡng đều có thể tắt (đặt null) khi team chưa muốn chặn theo
 * chiều đó — gate chỉ so những ngưỡng đang bật.
 *
 * Baseline lưu kèm set id + version + runId để không so nhầm: gate
 * so suite hiện tại với baseline của CÙNG suite (cùng set version);
 * khác version → gate báo `versionMismatch` (không fail oan, nhưng
 * yêu cầu lưu baseline mới).
 *
 * Lịch sử gate (`gate-history.jsonl`): mỗi lần gate chạy ghi một dòng
 * (pass/fail, thời điểm, suite, runId) để truy vết hồi quy theo thời
 * gian — CI xem được gate bắt đầu đỏ từ commit nào.
 *
 * Report suite lưu JSON (`<baseDir>/eval-harness-v3-reports/`) mode
 * 0600, tên file theo runId để không ghi đè report cũ.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { scoreDelta } from './scorer.js';
import type { EvalHarnessV3SuiteResult } from './types.js';

export const EVAL_HARNESS_V3_BASELINE_FILE = 'baseline.json';
export const EVAL_HARNESS_V3_REPORTS_DIR = 'eval-harness-v3-reports';
export const EVAL_HARNESS_V3_GATE_HISTORY_FILE = 'gate-history.jsonl';

/** Baseline: điểm chuẩn của một suite để gate so sánh. */
export interface EvalHarnessV3Baseline {
  /** Id suite/set mà baseline này thuộc về. */
  suiteId: string;
  /** Version của set lúc lưu baseline (để phát hiện so nhầm version). */
  setVersion?: number;
  /** RunId của lần chạy đã tạo baseline. */
  runId: string;
  /** Nhãn agent lúc chạy baseline. */
  agentLabel: string;
  /** Thời điểm lưu baseline (epoch ms). */
  createdAt: number;
  /** Điểm chuẩn: trial pass rate toàn suite. */
  trialPassRate: number;
  /** Điểm chuẩn: điểm trung bình toàn suite. */
  meanScore: number;
  /** Điểm chuẩn: chi phí toàn suite (USD). */
  totalCostUsd: number;
  /** Điểm chuẩn: thời gian toàn suite (ms). */
  durationMs: number;
  /** Điểm chuẩn: số guardrail trip toàn suite. */
  guardrailTripCount: number;
  /** Điểm chuẩn từng task: taskId → pass rate. */
  taskPassRates: Record<string, number>;
  /** Điểm chuẩn từng task: taskId → điểm trung bình. */
  taskScores: Record<string, number>;
}

/** Ngưỡng gate (null = tắt ngưỡng đó). */
export interface EvalHarnessV3GateThresholds {
  suitePassRateDrop: number | null;
  taskPassRateDrop: number | null;
  meanScoreDrop: number | null;
  maxCostIncreaseUsd: number | null;
  maxDurationIncreaseMs: number | null;
  maxGuardrailTrips: number | null;
}

/** Ngưỡng mặc định của gate v3. */
export const DEFAULT_EVAL_HARNESS_V3_GATE_THRESHOLDS: EvalHarnessV3GateThresholds = {
  suitePassRateDrop: 0.05,
  taskPassRateDrop: 0.1,
  meanScoreDrop: 0.05,
  maxCostIncreaseUsd: 1,
  maxDurationIncreaseMs: 60_000,
  maxGuardrailTrips: 0,
};

/** Một finding của gate: ngưỡng nào, task nào, tụt bao nhiêu. */
export interface EvalHarnessV3GateFinding {
  /** Loại ngưỡng bị vượt. */
  kind: 'suite-pass-rate' | 'task-pass-rate' | 'mean-score' | 'cost' | 'duration' | 'guardrail-trips' | 'version-mismatch' | 'missing-task';
  /** Task liên quan (undefined = mức suite). */
  taskId?: string;
  message: string;
  /** Giá trị hiện tại / baseline / ngưỡng (để UI hiện số). */
  current?: number;
  baseline?: number;
  threshold?: number;
}

/** Kết quả gate. */
export interface EvalHarnessV3GateResult {
  /** true = được merge (không có finding block nào). */
  passed: boolean;
  /** true khi chưa có baseline — lần chạy đầu, gate không chặn. */
  noBaseline: boolean;
  /** true khi baseline thuộc version set khác — cần lưu baseline mới. */
  versionMismatch: boolean;
  suiteId: string;
  runId: string;
  baselineRunId?: string;
  findings: EvalHarnessV3GateFinding[];
  checkedAt: number;
}

/** Một dòng lịch sử gate. */
export interface EvalHarnessV3GateHistoryEntry {
  checkedAt: number;
  suiteId: string;
  runId: string;
  passed: boolean;
  noBaseline: boolean;
  findingKinds: string[];
}

/** Thư mục dữ liệu v3 trong baseDir. */
export function getEvalHarnessV3Dir(baseDir: string): string {
  return path.join(baseDir, 'eval-harness-v3');
}

/** Đường dẫn file baseline. */
export function getEvalHarnessV3BaselinePath(baseDir: string): string {
  return path.join(getEvalHarnessV3Dir(baseDir), EVAL_HARNESS_V3_BASELINE_FILE);
}

/** Thư mục report suite. */
export function getEvalHarnessV3ReportsDir(baseDir: string): string {
  return path.join(baseDir, EVAL_HARNESS_V3_REPORTS_DIR);
}

/** Đường dẫn file lịch sử gate. */
export function getEvalHarnessV3GateHistoryPath(baseDir: string): string {
  return path.join(getEvalHarnessV3Dir(baseDir), EVAL_HARNESS_V3_GATE_HISTORY_FILE);
}

/** Tạo baseline từ kết quả một lần chạy suite. */
export function buildEvalHarnessV3Baseline(
  result: EvalHarnessV3SuiteResult,
  setVersion?: number,
): EvalHarnessV3Baseline {
  const taskPassRates: Record<string, number> = {};
  const taskScores: Record<string, number> = {};
  for (const task of result.tasks) {
    taskPassRates[task.taskId] = task.passRate;
    taskScores[task.taskId] = task.meanScore;
  }
  return {
    suiteId: result.suiteId,
    ...(setVersion !== undefined ? { setVersion } : {}),
    runId: result.runId,
    agentLabel: result.agentLabel,
    createdAt: Date.now(),
    trialPassRate: result.trialPassRate,
    meanScore: result.meanScore,
    totalCostUsd: result.totalCostUsd,
    durationMs: result.durationMs,
    guardrailTripCount: result.guardrailTripCount,
    taskPassRates,
    taskScores,
  };
}

/** Lưu baseline ra đĩa (mode 0600). */
export function saveEvalHarnessV3Baseline(baseDir: string, baseline: EvalHarnessV3Baseline): string {
  const filePath = getEvalHarnessV3BaselinePath(baseDir);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(baseline, null, 2)}\n`, 'utf8');
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // chmod fail trên Windows — không chặn lưu baseline.
  }
  return filePath;
}

/** Đọc baseline đã lưu (null khi chưa có hoặc file hỏng). */
export function loadEvalHarnessV3Baseline(baseDir: string): EvalHarnessV3Baseline | null {
  const filePath = getEvalHarnessV3BaselinePath(baseDir);
  if (!fs.existsSync(filePath)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as EvalHarnessV3Baseline;
    if (typeof parsed !== 'object' || parsed === null || typeof parsed.suiteId !== 'string') return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Lưu report suite JSON (tên file theo runId, mode 0600). */
export function saveEvalHarnessV3Report(baseDir: string, result: EvalHarnessV3SuiteResult): string {
  const reportsDir = getEvalHarnessV3ReportsDir(baseDir);
  fs.mkdirSync(reportsDir, { recursive: true });
  const filePath = path.join(reportsDir, `${result.runId}.json`);
  fs.writeFileSync(filePath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // chmod fail trên Windows — không chặn lưu report.
  }
  return filePath;
}

/** Đọc report suite theo runId (null khi không có). */
export function loadEvalHarnessV3Report(baseDir: string, runId: string): EvalHarnessV3SuiteResult | null {
  const filePath = path.join(getEvalHarnessV3ReportsDir(baseDir), `${runId}.json`);
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as EvalHarnessV3SuiteResult;
  } catch {
    return null;
  }
}

/**
 * So kết quả suite hiện tại với baseline theo ngưỡng gate.
 * - Chưa có baseline → passed=true, noBaseline=true (không chặn lần chạy đầu).
 * - Khác suite id → finding version-mismatch, passed=false (so nhầm bộ).
 * - Khác set version → versionMismatch=true, passed=false, yêu cầu baseline mới.
 * - Ngưỡng null = tắt, không so chiều đó.
 */
export function checkEvalHarnessV3Regression(
  baseline: EvalHarnessV3Baseline | null,
  result: EvalHarnessV3SuiteResult,
  thresholds: EvalHarnessV3GateThresholds = DEFAULT_EVAL_HARNESS_V3_GATE_THRESHOLDS,
  setVersion?: number,
): EvalHarnessV3GateResult {
  const checkedAt = Date.now();
  if (baseline === null) {
    return {
      passed: true,
      noBaseline: true,
      versionMismatch: false,
      suiteId: result.suiteId,
      runId: result.runId,
      findings: [],
      checkedAt,
    };
  }
  const findings: EvalHarnessV3GateFinding[] = [];
  if (baseline.suiteId !== result.suiteId) {
    findings.push({
      kind: 'version-mismatch',
      message: `Baseline thuộc suite "${baseline.suiteId}", không so được với suite "${result.suiteId}" — lưu baseline mới cho suite này.`,
    });
    return {
      passed: false,
      noBaseline: false,
      versionMismatch: true,
      suiteId: result.suiteId,
      runId: result.runId,
      baselineRunId: baseline.runId,
      findings,
      checkedAt,
    };
  }
  const versionMismatch =
    setVersion !== undefined && baseline.setVersion !== undefined && baseline.setVersion !== setVersion;
  if (versionMismatch) {
    findings.push({
      kind: 'version-mismatch',
      message: `Baseline ở set version ${baseline.setVersion}, suite hiện tại version ${setVersion} — lưu baseline mới trước khi gate.`,
      current: setVersion,
      baseline: baseline.setVersion,
    });
  }

  if (thresholds.suitePassRateDrop !== null) {
    const { delta } = scoreDelta(result.trialPassRate, baseline.trialPassRate);
    if (delta < -thresholds.suitePassRateDrop) {
      findings.push({
        kind: 'suite-pass-rate',
        message: `Suite trial pass rate tụt ${(Math.abs(delta) * 100).toFixed(1)}% (ngưỡng ${(thresholds.suitePassRateDrop * 100).toFixed(1)}%).`,
        current: result.trialPassRate,
        baseline: baseline.trialPassRate,
        threshold: thresholds.suitePassRateDrop,
      });
    }
  }
  if (thresholds.meanScoreDrop !== null) {
    const { delta } = scoreDelta(result.meanScore, baseline.meanScore);
    if (delta < -thresholds.meanScoreDrop) {
      findings.push({
        kind: 'mean-score',
        message: `Mean score suite tụt ${(Math.abs(delta) * 100).toFixed(1)}% (ngưỡng ${(thresholds.meanScoreDrop * 100).toFixed(1)}%).`,
        current: result.meanScore,
        baseline: baseline.meanScore,
        threshold: thresholds.meanScoreDrop,
      });
    }
  }
  if (thresholds.maxCostIncreaseUsd !== null) {
    const increase = result.totalCostUsd - baseline.totalCostUsd;
    if (increase > thresholds.maxCostIncreaseUsd) {
      findings.push({
        kind: 'cost',
        message: `Chi phí suite tăng $${increase.toFixed(4)} (ngưỡng $${thresholds.maxCostIncreaseUsd.toFixed(4)}).`,
        current: result.totalCostUsd,
        baseline: baseline.totalCostUsd,
        threshold: thresholds.maxCostIncreaseUsd,
      });
    }
  }
  if (thresholds.maxDurationIncreaseMs !== null) {
    const increase = result.durationMs - baseline.durationMs;
    if (increase > thresholds.maxDurationIncreaseMs) {
      findings.push({
        kind: 'duration',
        message: `Thời gian suite tăng ${increase}ms (ngưỡng ${thresholds.maxDurationIncreaseMs}ms).`,
        current: result.durationMs,
        baseline: baseline.durationMs,
        threshold: thresholds.maxDurationIncreaseMs,
      });
    }
  }
  if (thresholds.maxGuardrailTrips !== null && result.guardrailTripCount > thresholds.maxGuardrailTrips) {
    findings.push({
      kind: 'guardrail-trips',
      message: `Suite có ${result.guardrailTripCount} guardrail trip (ngưỡng ${thresholds.maxGuardrailTrips}).`,
      current: result.guardrailTripCount,
      threshold: thresholds.maxGuardrailTrips,
    });
  }
  if (thresholds.taskPassRateDrop !== null) {
    for (const task of result.tasks) {
      const baseRate = baseline.taskPassRates[task.taskId];
      if (baseRate === undefined) {
        findings.push({
          kind: 'missing-task',
          taskId: task.taskId,
          message: `Task "${task.taskId}" chưa có trong baseline — lưu baseline mới để gate so được task này.`,
        });
        continue;
      }
      const { delta } = scoreDelta(task.passRate, baseRate);
      if (delta < -thresholds.taskPassRateDrop) {
        findings.push({
          kind: 'task-pass-rate',
          taskId: task.taskId,
          message: `Task "${task.taskId}" pass rate tụt ${(Math.abs(delta) * 100).toFixed(1)}% (ngưỡng ${(thresholds.taskPassRateDrop * 100).toFixed(1)}%).`,
          current: task.passRate,
          baseline: baseRate,
          threshold: thresholds.taskPassRateDrop,
        });
      }
    }
  }
  return {
    passed: findings.length === 0,
    noBaseline: false,
    versionMismatch,
    suiteId: result.suiteId,
    runId: result.runId,
    baselineRunId: baseline.runId,
    findings,
    checkedAt,
  };
}

/** Ghi một lần gate vào lịch sử (append JSONL, mode 0600 khi tạo mới). */
export function appendEvalHarnessV3GateHistory(baseDir: string, gate: EvalHarnessV3GateResult): string {
  const filePath = getEvalHarnessV3GateHistoryPath(baseDir);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const isNew = !fs.existsSync(filePath);
  const entry: EvalHarnessV3GateHistoryEntry = {
    checkedAt: gate.checkedAt,
    suiteId: gate.suiteId,
    runId: gate.runId,
    passed: gate.passed,
    noBaseline: gate.noBaseline,
    findingKinds: gate.findings.map((f) => f.kind),
  };
  fs.appendFileSync(filePath, `${JSON.stringify(entry)}\n`, 'utf8');
  if (isNew) {
    try {
      fs.chmodSync(filePath, 0o600);
    } catch {
      // chmod fail trên Windows — không chặn ghi lịch sử.
    }
  }
  return filePath;
}

/** Đọc lịch sử gate (bỏ dòng hỏng). */
export function readEvalHarnessV3GateHistory(baseDir: string): EvalHarnessV3GateHistoryEntry[] {
  const filePath = getEvalHarnessV3GateHistoryPath(baseDir);
  if (!fs.existsSync(filePath)) return [];
  const entries: EvalHarnessV3GateHistoryEntry[] = [];
  for (const line of fs.readFileSync(filePath, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    try {
      entries.push(JSON.parse(trimmed) as EvalHarnessV3GateHistoryEntry);
    } catch {
      // Dòng hỏng — bỏ qua.
    }
  }
  return entries;
}

/** Render kết quả gate thành text đọc được (CI log). */
export function renderEvalHarnessV3GateText(result: EvalHarnessV3GateResult): string {
  const lines: string[] = [];
  if (result.noBaseline) {
    lines.push(`Gate ${result.suiteId}: PASS (chưa có baseline — lần chạy đầu, đã lưu baseline mới).`);
    return `${lines.join('\n')}\n`;
  }
  lines.push(`Gate ${result.suiteId}: ${result.passed ? 'PASS' : 'FAIL'} (${result.findings.length} finding)`);
  for (const finding of result.findings) {
    lines.push(`  ✗ [${finding.kind}]${finding.taskId !== undefined ? ` ${finding.taskId}` : ''}: ${finding.message}`);
  }
  if (result.passed) lines.push('  (không có task nào tụt quá ngưỡng)');
  return `${lines.join('\n')}\n`;
}

/**
 * Eval runner v3 (v1.05, Team T6) — chạy suite eval memory theo cấu
 * hình/lịch, lưu lịch sử, so sánh baseline vs hiện tại, cảnh báo
 * regression khi điểm giảm quá ngưỡng.
 *
 * Nối tiếp eval harness v2 (`observability/evalHarness.ts` chấm run
 * đã ghi): runner này chạy eval MEMORY (dataset fixture + retriever)
 * và giữ lịch sử các lần chạy để thấy xu hướng theo thời gian.
 *
 * Lưu trữ: `<baseDir>/eval-memory-history.json` (atomic tmp + rename,
 * cùng posture với evals.json / fleet-schedule.json). Mỗi entry là
 * một `MemoryEvalReport` đầy đủ (kèm nhãn retrieverVersion) nên so
 * sánh baseline vs hiện tại không cần chạy lại.
 *
 * Regression: so lần chạy mới nhất với lần chạy baseline gần nhất
 * (mặc định: lần chạy trước đó cùng dataset, khác retrieverVersion
 * hoặc lần chạy ngay trước). Một metric giảm hơn ngưỡng của nó →
 * một alert. Ngưỡng mặc định: F1 −0.05, recall −0.05, temporal
 * −0.10, multi-hop −0.10, judge −0.05.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { MemoryEvalDataset } from './memoryDataset';
import type { MemoryEvalReport, MemoryRetriever, RunMemoryEvalOptions } from './memoryEval';
import { runMemoryEval } from './memoryEval';

export const EVAL_MEMORY_HISTORY_FILE = 'eval-memory-history.json';

/** Ngưỡng regression: mức giảm tối đa cho phép trước khi cảnh báo. */
export interface RegressionThresholds {
  /** Giảm F1 tổng (0..1). Mặc định 0.05. */
  f1Drop: number;
  /** Giảm recall tổng. Mặc định 0.05. */
  recallDrop: number;
  /** Giảm temporal accuracy. Mặc định 0.10. */
  temporalDrop: number;
  /** Giảm multi-hop score. Mặc định 0.10. */
  multiHopDrop: number;
  /** Giảm judge score. Mặc định 0.05. */
  judgeDrop: number;
}

export const DEFAULT_REGRESSION_THRESHOLDS: RegressionThresholds = {
  f1Drop: 0.05,
  recallDrop: 0.05,
  temporalDrop: 0.1,
  multiHopDrop: 0.1,
  judgeDrop: 0.05,
};

/** Lịch chạy eval tự động (do scheduler/automation gọi, không tự chạy ngầm ở đây). */
export interface EvalScheduleConfig {
  /** Bật lịch hay không. */
  enabled: boolean;
  /** Khoảng cách giữa hai lần chạy (ms). Mặc định 7 ngày. */
  intervalMs: number;
  /** Lần chạy tự động gần nhất (epoch ms), null khi chưa chạy lần nào. */
  lastRunAt: number | null;
}

export const DEFAULT_EVAL_SCHEDULE: EvalScheduleConfig = {
  enabled: false,
  intervalMs: 7 * 24 * 60 * 60 * 1000,
  lastRunAt: null,
};

/** Cấu hình một lần chạy eval memory qua runner. */
export interface EvalRunnerConfig {
  /** Nhãn phiên bản memory/retriever đang đo (vd 'memory-v5.2'). */
  retrieverVersion: string;
  /** Số fact lấy tối đa mỗi câu. Mặc định 5. */
  topK?: number;
  /** Ngưỡng regression (mặc định DEFAULT_REGRESSION_THRESHOLDS). */
  thresholds?: RegressionThresholds;
  /** Lịch chạy (mặc định tắt). */
  schedule?: EvalScheduleConfig;
  /** Thời điểm chạy (epoch ms, mặc định Date.now()). */
  at?: number;
}

/** Một cảnh báo regression: metric nào, giảm bao nhiêu, quá ngưỡng nào. */
export interface RegressionAlert {
  metric: 'f1' | 'recall' | 'temporalAccuracy' | 'multiHopScore' | 'judgeScore';
  category: string;
  baseline: number;
  current: number;
  /** current − baseline (số âm = giảm). */
  drop: number;
  threshold: number;
  at: number;
  baselineAt: number;
  message: string;
}

/** Chênh lệch giữa hai báo cáo, theo từng metric + từng loại câu hỏi. */
export interface EvalComparison {
  baseline: { retrieverVersion: string; at: number };
  current: { retrieverVersion: string; at: number };
  /** current − baseline cho mỗi metric tổng. */
  overallDelta: {
    f1: number;
    recall: number;
    precision: number;
    temporalAccuracy: number | null;
    multiHopScore: number | null;
    judgeScore: number;
  };
  /** current − baseline cho mỗi loại câu hỏi. */
  byCategoryDelta: Array<{
    category: string;
    f1: number;
    recall: number;
    temporalAccuracy: number | null;
    multiHopScore: number | null;
    judgeScore: number;
  }>;
  /** Số câu hỏi cải thiện / tệ đi / giữ nguyên (theo F1 từng câu). */
  questionMoves: { improved: number; worsened: number; unchanged: number };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function evalMemoryHistoryPath(baseDir: string): string {
  if (typeof baseDir !== 'string' || baseDir.trim().length === 0) {
    throw new Error('eval runner needs a non-empty baseDir.');
  }
  return path.join(baseDir, EVAL_MEMORY_HISTORY_FILE);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function validateReport(raw: unknown): MemoryEvalReport | null {
  if (!isRecord(raw)) return null;
  const { datasetId, datasetVersion, retrieverName, retrieverVersion, topK, at, perQuestion, byCategory, overall } = raw;
  if (typeof datasetId !== 'string' || datasetId.trim() === '') return null;
  if (!isFiniteNumber(datasetVersion)) return null;
  if (typeof retrieverName !== 'string' || retrieverName.trim() === '') return null;
  if (typeof retrieverVersion !== 'string' || retrieverVersion.trim() === '') return null;
  if (!Number.isInteger(topK) || (topK as number) <= 0) return null;
  if (!isFiniteNumber(at)) return null;
  if (!Array.isArray(perQuestion) || !Array.isArray(byCategory)) return null;
  if (!isRecord(overall) || !isFiniteNumber(overall.f1)) return null;
  return raw as unknown as MemoryEvalReport;
}

/** Toàn bộ lịch sử chạy eval (file thiếu = chưa chạy lần nào). */
export function listMemoryEvalHistory(baseDir: string): MemoryEvalReport[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(evalMemoryHistoryPath(baseDir), 'utf8'));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  if (!Array.isArray(parsed)) return [];
  return parsed
    .map((row) => validateReport(row))
    .filter((r): r is MemoryEvalReport => r !== null)
    .sort((a, b) => a.at - b.at);
}

/**
 * Cắt lịch sử chỉ giữ lại N lần chạy mới nhất (mặc định 50) để
 * file history không phình vô hạn. Trả về số lần chạy đã xóa.
 */
export function pruneMemoryEvalHistory(baseDir: string, keepLast = 50): number {
  if (!Number.isInteger(keepLast) || keepLast < 1) {
    throw new Error('pruneMemoryEvalHistory needs keepLast as an integer >= 1.');
  }
  const history = listMemoryEvalHistory(baseDir);
  if (history.length <= keepLast) return 0;
  const kept = history.slice(history.length - keepLast);
  saveMemoryEvalHistory(baseDir, kept);
  return history.length - kept.length;
}

function saveMemoryEvalHistory(baseDir: string, history: MemoryEvalReport[]): void {
  const filePath = evalMemoryHistoryPath(baseDir);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(history, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, filePath);
}

/** Validate ngưỡng regression (throws khi sai). */
export function validateRegressionThresholds(raw: unknown): RegressionThresholds {
  if (!isRecord(raw)) throw new Error('regression thresholds must be an object.');
  const out: RegressionThresholds = { ...DEFAULT_REGRESSION_THRESHOLDS };
  for (const key of ['f1Drop', 'recallDrop', 'temporalDrop', 'multiHopDrop', 'judgeDrop'] as const) {
    const value = raw[key];
    if (value === undefined) continue;
    if (!isFiniteNumber(value) || (value as number) < 0 || (value as number) > 1) {
      throw new Error(`regression threshold ${key} must be a number in [0, 1].`);
    }
    out[key] = value as number;
  }
  return out;
}

/** Validate cấu hình runner (throws khi sai). */
export function validateEvalRunnerConfig(raw: unknown): EvalRunnerConfig {
  if (!isRecord(raw)) throw new Error('eval runner config must be an object.');
  if (typeof raw.retrieverVersion !== 'string' || raw.retrieverVersion.trim() === '') {
    throw new Error('eval runner config needs a non-empty retrieverVersion.');
  }
  const config: EvalRunnerConfig = { retrieverVersion: raw.retrieverVersion.trim() };
  if (raw.topK !== undefined) {
    if (!Number.isInteger(raw.topK) || (raw.topK as number) <= 0) {
      throw new Error('eval runner config topK must be an integer > 0.');
    }
    config.topK = raw.topK as number;
  }
  if (raw.thresholds !== undefined) config.thresholds = validateRegressionThresholds(raw.thresholds);
  if (raw.schedule !== undefined) {
    if (!isRecord(raw.schedule)) throw new Error('eval runner schedule must be an object.');
    const s = raw.schedule as Record<string, unknown>;
    if (typeof s.enabled !== 'boolean') throw new Error('eval schedule enabled must be a boolean.');
    if (!isFiniteNumber(s.intervalMs) || (s.intervalMs as number) <= 0) {
      throw new Error('eval schedule intervalMs must be a number > 0.');
    }
    if (s.lastRunAt !== null && !isFiniteNumber(s.lastRunAt)) {
      throw new Error('eval schedule lastRunAt must be a number or null.');
    }
    config.schedule = {
      enabled: s.enabled,
      intervalMs: s.intervalMs as number,
      lastRunAt: (s.lastRunAt as number | null) ?? null,
    };
  }
  if (raw.at !== undefined) {
    if (!isFiniteNumber(raw.at)) throw new Error('eval runner config at must be a number.');
    config.at = raw.at as number;
  }
  return config;
}

/**
 * Lần chạy tiếp theo theo lịch: null khi lịch tắt hoặc chưa tới hạn.
 * `now` mặc định là Date.now() — truyền vào để test xác định.
 */
export function nextScheduledRunMs(schedule: EvalScheduleConfig, now: number = Date.now()): number | null {
  if (!schedule.enabled) return null;
  if (schedule.lastRunAt === null) return now;
  return schedule.lastRunAt + schedule.intervalMs;
}

/** Có tới hạn chạy theo lịch không. */
export function isEvalRunDue(schedule: EvalScheduleConfig, now: number = Date.now()): boolean {
  const next = nextScheduledRunMs(schedule, now);
  return next !== null && now >= next;
}

/** So sánh hai báo cáo: delta từng metric, từng loại, từng câu hỏi. */
export function compareMemoryEvalReports(
  baseline: MemoryEvalReport,
  current: MemoryEvalReport,
): EvalComparison {
  const delta = (a: number | null, b: number | null): number | null => {
    if (a === null || b === null) return null;
    return b - a;
  };
  const byCategoryDelta = current.byCategory.map((cur) => {
    const base = baseline.byCategory.find((b) => b.category === cur.category);
    return {
      category: cur.category,
      f1: cur.f1 - (base?.f1 ?? 0),
      recall: cur.recall - (base?.recall ?? 0),
      temporalAccuracy: delta(base?.temporalAccuracy ?? null, cur.temporalAccuracy),
      multiHopScore: delta(base?.multiHopScore ?? null, cur.multiHopScore),
      judgeScore: cur.judgeScore - (base?.judgeScore ?? 0),
    };
  });
  const baseByQuestion = new Map(baseline.perQuestion.map((q) => [q.questionId, q]));
  let improved = 0;
  let worsened = 0;
  let unchanged = 0;
  for (const cur of current.perQuestion) {
    const base = baseByQuestion.get(cur.questionId);
    if (!base) continue;
    const d = cur.f1 - base.f1;
    if (d > 0.001) improved++;
    else if (d < -0.001) worsened++;
    else unchanged++;
  }
  return {
    baseline: { retrieverVersion: baseline.retrieverVersion, at: baseline.at },
    current: { retrieverVersion: current.retrieverVersion, at: current.at },
    overallDelta: {
      f1: current.overall.f1 - baseline.overall.f1,
      recall: current.overall.recall - baseline.overall.recall,
      precision: current.overall.precision - baseline.overall.precision,
      temporalAccuracy: delta(baseline.overall.temporalAccuracy, current.overall.temporalAccuracy),
      multiHopScore: delta(baseline.overall.multiHopScore, current.overall.multiHopScore),
      judgeScore: current.overall.judgeScore - baseline.overall.judgeScore,
    },
    byCategoryDelta,
    questionMoves: { improved, worsened, unchanged },
  };
}

/**
 * Kiểm tra regression: so báo cáo mới nhất với baseline (mặc định:
 * lần chạy ngay trước nó cùng dataset). Trả về danh sách alert —
 * rỗng khi không có metric nào giảm quá ngưỡng.
 */
export function checkMemoryEvalRegression(
  history: readonly MemoryEvalReport[],
  thresholds: RegressionThresholds = DEFAULT_REGRESSION_THRESHOLDS,
): RegressionAlert[] {
  if (history.length < 2) return [];
  const sorted = [...history].sort((a, b) => a.at - b.at);
  const current = sorted[sorted.length - 1];
  const baseline = sorted[sorted.length - 2];
  if (current.datasetId !== baseline.datasetId) return [];
  const alerts: RegressionAlert[] = [];
  const check = (
    metric: RegressionAlert['metric'],
    category: string,
    baseValue: number | null,
    curValue: number | null,
    threshold: number,
  ): void => {
    if (baseValue === null || curValue === null) return;
    const drop = curValue - baseValue;
    if (drop < -threshold) {
      alerts.push({
        metric,
        category,
        baseline: baseValue,
        current: curValue,
        drop,
        threshold,
        at: current.at,
        baselineAt: baseline.at,
        message:
          `${metric} (${category}) dropped from ${baseValue.toFixed(3)} to ${curValue.toFixed(3)} ` +
          `(drop ${(-drop).toFixed(3)} > threshold ${threshold.toFixed(3)}) ` +
          `between ${baseline.retrieverVersion} and ${current.retrieverVersion}.`,
      });
    }
  };
  check('f1', 'overall', baseline.overall.f1, current.overall.f1, thresholds.f1Drop);
  check('recall', 'overall', baseline.overall.recall, current.overall.recall, thresholds.recallDrop);
  check('temporalAccuracy', 'overall', baseline.overall.temporalAccuracy, current.overall.temporalAccuracy, thresholds.temporalDrop);
  check('multiHopScore', 'overall', baseline.overall.multiHopScore, current.overall.multiHopScore, thresholds.multiHopDrop);
  check('judgeScore', 'overall', baseline.overall.judgeScore, current.overall.judgeScore, thresholds.judgeDrop);
  for (const curCat of current.byCategory) {
    const baseCat = baseline.byCategory.find((b) => b.category === curCat.category);
    if (!baseCat) continue;
    check('f1', curCat.category, baseCat.f1, curCat.f1, thresholds.f1Drop);
    check('recall', curCat.category, baseCat.recall, curCat.recall, thresholds.recallDrop);
  }
  return alerts;
}

export interface RunMemoryEvalSuiteResult {
  report: MemoryEvalReport;
  /** Lịch sử sau khi đã ghi lần chạy này. */
  history: MemoryEvalReport[];
  /** Alert regression so với lần chạy trước (rỗng khi không có). */
  alerts: RegressionAlert[];
  /** So sánh với lần chạy trước (null khi đây là lần đầu). */
  comparison: EvalComparison | null;
}

/**
 * Chạy một suite eval memory hoàn chỉnh: đo dataset qua retriever,
 * lưu báo cáo vào lịch sử, so với lần chạy trước, cảnh báo regression.
 * Trả về report + history + alerts + comparison để UI/tool hiển thị.
 */
export async function runMemoryEvalSuite(
  baseDir: string,
  dataset: MemoryEvalDataset,
  retriever: MemoryRetriever,
  config: EvalRunnerConfig,
): Promise<RunMemoryEvalSuiteResult> {
  const cfg = validateEvalRunnerConfig(config);
  const thresholds = cfg.thresholds ?? DEFAULT_REGRESSION_THRESHOLDS;
  const opts: RunMemoryEvalOptions = {
    retrieverVersion: cfg.retrieverVersion,
    ...(cfg.topK !== undefined ? { topK: cfg.topK } : {}),
    ...(cfg.at !== undefined ? { at: cfg.at } : {}),
  };
  const report = await runMemoryEval(dataset, retriever, opts);
  const previous = listMemoryEvalHistory(baseDir);
  const history = [...previous, report];
  saveMemoryEvalHistory(baseDir, history);
  const comparison =
    previous.length > 0 ? compareMemoryEvalReports(previous[previous.length - 1], report) : null;
  const alerts = checkMemoryEvalRegression(history, thresholds);
  return { report, history, alerts, comparison };
}

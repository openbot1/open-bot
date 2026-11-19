/**
 * Lịch sử chạy của Eval Harness v4 (v1.44, Đội T2).
 *
 * Mỗi lần chạy suite là một `EvalHarnessV4RunRecord`, lưu 2 dạng:
 *
 *   - `<historyDir>/runs.jsonl` — một dòng JSON = một run (append-only,
 *     đọc tuần tự, giống phong cách rollout JSONL của Harbor v1.11);
 *   - `<historyDir>/runs/<runId>.json` — bản đầy đủ từng run (để
 *     đọc lại một run mà không quét cả file JSONL).
 *
 * Baseline pin trong `<historyDir>/baseline.json` (`{ runId, ... }`).
 * Mọi hàm load đều khoan dung với file hỏng: dòng JSON lỗi bị bỏ qua
 * (ghi lại số dòng hỏng) thay vì fail cả lịch sử — giống phong cách
 * của `eval/trends.ts` (báo cáo hỏng thì bỏ qua, không fail cả trend).
 *
 * So sánh 2 run (`compareEvalHarnessV4Runs`) là nền cho hồi quy:
 * delta reward từng task, test mới fail/pass, task thêm/bớt.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  EVAL_HARNESS_V4_BASELINE_FILE,
  EVAL_HARNESS_V4_HISTORY_FILE,
  EVAL_HARNESS_V4_RUNS_DIR,
} from './types';
import type {
  EvalHarnessV4Baseline,
  EvalHarnessV4HistorySummary,
  EvalHarnessV4RunComparison,
  EvalHarnessV4RunRecord,
  EvalHarnessV4TaskDelta,
  EvalHarnessV4TaskResult,
  EvalHarnessV4TrendPoint,
} from './types';

/** File pointer tới run mới nhất (JSON `{ runId, at }`). */
export const EVAL_HARNESS_V4_LATEST_FILE = 'latest.json' as const;
export function getEvalHarnessV4HistoryDir(baseDir: string, historyDirOverride: string): string {
  if (historyDirOverride !== '') {
    return path.isAbsolute(historyDirOverride) ? historyDirOverride : path.join(baseDir, historyDirOverride);
  }
  return path.join(baseDir, 'eval-harness-v4');
}

/** Đường dẫn file runs.jsonl trong thư mục lịch sử. */
export function getEvalHarnessV4HistoryFile(historyDir: string): string {
  return path.join(historyDir, EVAL_HARNESS_V4_HISTORY_FILE);
}

/** Đường dẫn thư mục runs/ (một file JSON / run). */
export function getEvalHarnessV4RunsDir(historyDir: string): string {
  return path.join(historyDir, EVAL_HARNESS_V4_RUNS_DIR);
}

/** Đường dẫn file baseline.json. */
export function getEvalHarnessV4BaselineFile(historyDir: string): string {
  return path.join(historyDir, EVAL_HARNESS_V4_BASELINE_FILE);
}

/**
 * Ghi một run record vào lịch sử (append JSONL + ghi file runs/<id>.json).
 * Trả về đường dẫn file runs/<id>.json. Không throw khi ghi JSONL lỗi?
 * Có throw — lịch sử là cam kết của harness, ghi không được thì caller
 * phải biết (runner báo lỗi rõ thay vì im lặng mất lịch sử).
 */
export function appendEvalHarnessV4RunRecord(historyDir: string, record: EvalHarnessV4RunRecord): string {
  fs.mkdirSync(getEvalHarnessV4RunsDir(historyDir), { recursive: true });
  const runFile = path.join(getEvalHarnessV4RunsDir(historyDir), `${record.runId}.json`);
  fs.writeFileSync(runFile, `${JSON.stringify(record, null, 2)}\n`, 'utf-8');
  const historyFile = getEvalHarnessV4HistoryFile(historyDir);
  fs.appendFileSync(historyFile, `${JSON.stringify(record)}\n`, 'utf-8');
  // Pointer latest.json: tool/UI đọc 1 file là biết run mới nhất.
  fs.writeFileSync(
    path.join(historyDir, EVAL_HARNESS_V4_LATEST_FILE),
    `${JSON.stringify({ runId: record.runId, at: record.finishedAt }, null, 2)}\n`,
    'utf-8',
  );
  return runFile;
}

/** Đọc pointer run mới nhất (undefined khi chưa có run nào). */
export function readEvalHarnessV4LatestRunId(historyDir: string): { runId: string; at: number } | undefined {
  const file = path.join(historyDir, EVAL_HARNESS_V4_LATEST_FILE);
  if (!fs.existsSync(file)) return undefined;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as { runId: string; at: number };
    if (typeof parsed.runId !== 'string' || parsed.runId === '') return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

/** Kết quả load lịch sử (records + số dòng hỏng đã bỏ qua). */
export interface EvalHarnessV4HistoryLoad {
  records: EvalHarnessV4RunRecord[];
  /** Số dòng JSONL hỏng đã bỏ qua (0 = lịch sử sạch). */
  corruptLines: number;
  /** File lịch sử có tồn tại không. */
  exists: boolean;
}

/**
 * Load toàn bộ lịch sử (cũ → mới theo startedAt). Giới hạn `limit`
 * (0 = không giới hạn) chỉ lấy N run mới nhất — để dashboard không
 * phải đọc hàng trăm run khi chỉ cần 20 run gần nhất.
 */
export function loadEvalHarnessV4History(
  historyDir: string,
  options: { limit?: number } = {},
): EvalHarnessV4HistoryLoad {
  const historyFile = getEvalHarnessV4HistoryFile(historyDir);
  if (!fs.existsSync(historyFile)) return { records: [], corruptLines: 0, exists: false };
  const lines = fs.readFileSync(historyFile, 'utf-8').split(/\r?\n/);
  const records: EvalHarnessV4RunRecord[] = [];
  let corruptLines = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    try {
      const parsed = JSON.parse(trimmed) as EvalHarnessV4RunRecord;
      if (typeof parsed.runId !== 'string' || !Array.isArray(parsed.tasks)) {
        corruptLines += 1;
        continue;
      }
      records.push(parsed);
    } catch {
      corruptLines += 1;
    }
  }
  records.sort((a, b) => a.startedAt - b.startedAt);
  const limit = options.limit ?? 0;
  const sliced = limit > 0 ? records.slice(-limit) : records;
  return { records: sliced, corruptLines, exists: true };
}

/** Đọc một run theo id (ưu tiên file runs/<id>.json, fallback quét JSONL). */
export function loadEvalHarnessV4Run(historyDir: string, runId: string): EvalHarnessV4RunRecord | undefined {
  const runFile = path.join(getEvalHarnessV4RunsDir(historyDir), `${runId}.json`);
  if (fs.existsSync(runFile)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(runFile, 'utf-8')) as EvalHarnessV4RunRecord;
      if (parsed.runId === runId) return parsed;
    } catch {
      // File run hỏng thì fallback quét JSONL bên dưới.
    }
  }
  const { records } = loadEvalHarnessV4History(historyDir);
  return records.find((r) => r.runId === runId);
}

/** Run mới nhất trong lịch sử (undefined khi chưa có run nào). */
export function latestEvalHarnessV4Run(historyDir: string): EvalHarnessV4RunRecord | undefined {
  const { records } = loadEvalHarnessV4History(historyDir, { limit: 1 });
  return records[records.length - 1];
}

/** Liệt kê id của mọi run trong lịch sử (mới nhất trước). */
export function listEvalHarnessV4RunIds(historyDir: string): string[] {
  const { records } = loadEvalHarnessV4History(historyDir);
  return records.map((r) => r.runId).reverse();
}

/**
 * Xoá run cũ theo 2 luật của config: giữ tối đa `maxRuns` run mới
 * nhất + xoá run cũ hơn `maxAgeDays` ngày. Trả về số run đã xoá
 * (cả JSONL lẫn file runs/<id>.json được viết lại cho khớp).
 */
export function pruneEvalHarnessV4History(
  historyDir: string,
  options: { maxRuns: number; maxAgeDays: number; now?: number },
): { removed: number; kept: number } {
  const now = options.now ?? Date.now();
  const { records } = loadEvalHarnessV4History(historyDir);
  if (records.length === 0) return { removed: 0, kept: 0 };
  const cutoff = options.maxAgeDays > 0 ? now - options.maxAgeDays * 24 * 60 * 60 * 1000 : 0;
  let kept = records.filter((r) => cutoff === 0 || r.startedAt >= cutoff);
  if (options.maxRuns > 0 && kept.length > options.maxRuns) {
    kept = kept.slice(-options.maxRuns);
  }
  const keptIds = new Set(kept.map((r) => r.runId));
  const removed = records.filter((r) => !keptIds.has(r.runId));
  if (removed.length === 0) return { removed: 0, kept: kept.length };
  const historyFile = getEvalHarnessV4HistoryFile(historyDir);
  fs.writeFileSync(historyFile, kept.map((r) => JSON.stringify(r)).join('\n') + (kept.length > 0 ? '\n' : ''), 'utf-8');
  for (const run of removed) {
    const runFile = path.join(getEvalHarnessV4RunsDir(historyDir), `${run.runId}.json`);
    try {
      if (fs.existsSync(runFile)) fs.unlinkSync(runFile);
    } catch {
      // Xoá file run lẻ không được cũng không sao — JSONL mới là nguồn chính.
    }
  }
  return { removed: removed.length, kept: kept.length };
}

/** Pin một run làm baseline (ghi baseline.json). */
export function pinEvalHarnessV4Baseline(historyDir: string, runId: string, note: string): EvalHarnessV4Baseline {
  fs.mkdirSync(historyDir, { recursive: true });
  const baseline: EvalHarnessV4Baseline = { runId, pinnedAt: Date.now(), note };
  fs.writeFileSync(getEvalHarnessV4BaselineFile(historyDir), `${JSON.stringify(baseline, null, 2)}\n`, 'utf-8');
  return baseline;
}

/** Đọc baseline đã pin (undefined khi chưa pin). */
export function readEvalHarnessV4Baseline(historyDir: string): EvalHarnessV4Baseline | undefined {
  const file = getEvalHarnessV4BaselineFile(historyDir);
  if (!fs.existsSync(file)) return undefined;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as EvalHarnessV4Baseline;
    if (typeof parsed.runId !== 'string' || parsed.runId === '') return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

/** Xoá baseline đã pin (về chế độ so với lần chạy trước đó). */
export function unpinEvalHarnessV4Baseline(historyDir: string): boolean {
  const file = getEvalHarnessV4BaselineFile(historyDir);
  if (!fs.existsSync(file)) return false;
  fs.unlinkSync(file);
  return true;
}

/**
 * Resolve baseline thực tế cho một run mới: config.baselineRunId >
 * baseline đã pin > run gần nhất trước đó (không tính chính nó).
 * Trả về undefined khi chưa có run nào để so sánh.
 */
export function resolveEvalHarnessV4BaselineRun(
  historyDir: string,
  configBaselineRunId: string,
  currentRunId: string,
): EvalHarnessV4RunRecord | undefined {
  const pinned = readEvalHarnessV4Baseline(historyDir);
  const wantedId = configBaselineRunId !== '' ? configBaselineRunId : pinned?.runId;
  if (wantedId !== undefined && wantedId !== '' && wantedId !== currentRunId) {
    const pinnedRun = loadEvalHarnessV4Run(historyDir, wantedId);
    if (pinnedRun) return pinnedRun;
    // Baseline yêu cầu không còn trong lịch sử (đã prune) → fallback lần trước.
  }
  const { records } = loadEvalHarnessV4History(historyDir);
  const previous = records.filter((r) => r.runId !== currentRunId);
  return previous[previous.length - 1];
}

/** Lấy kết quả một task trong một run (undefined khi task không chạy ở run đó). */
export function findEvalHarnessV4TaskResult(
  record: EvalHarnessV4RunRecord,
  taskId: string,
): EvalHarnessV4TaskResult | undefined {
  return record.tasks.find((t) => t.taskId === taskId);
}

/** Test fail trong một task result (gom từ attempt: test fail ở ÍT NHẤT một attempt). */
export function failingTestsOfTaskResult(task: EvalHarnessV4TaskResult): string[] {
  const failing = new Set<string>();
  for (const attempt of task.attempts) {
    for (const test of attempt.perTest) {
      if (!test.passed) failing.add(test.name);
    }
  }
  return [...failing].sort();
}

/** Test pass trong một task result (pass ở ÍT NHẤT một attempt). */
export function passingTestsOfTaskResult(task: EvalHarnessV4TaskResult): string[] {
  const passing = new Set<string>();
  for (const attempt of task.attempts) {
    for (const test of attempt.perTest) {
      if (test.passed) passing.add(test.name);
    }
  }
  return [...passing].sort();
}

/**
 * So sánh 2 run: delta reward từng task + test mới fail/pass +
 * task thêm/bớt. Dùng cho báo cáo hồi quy và dashboard.
 * `baseline` null = không có gì để so (run đầu tiên): mọi task
 * đều là "mới", delta null.
 */
export function compareEvalHarnessV4Runs(
  current: EvalHarnessV4RunRecord,
  baseline: EvalHarnessV4RunRecord | null,
): EvalHarnessV4RunComparison {
  const deltas: EvalHarnessV4TaskDelta[] = [];
  const baselineById = new Map<string, EvalHarnessV4TaskResult>();
  if (baseline) {
    for (const task of baseline.tasks) baselineById.set(task.taskId, task);
  }
  const currentById = new Map<string, EvalHarnessV4TaskResult>();
  for (const task of current.tasks) currentById.set(task.taskId, task);
  const addedTasks: string[] = [];
  const removedTasks: string[] = [];
  for (const task of current.tasks) {
    const base = baselineById.get(task.taskId);
    if (!base) {
      addedTasks.push(task.taskId);
      deltas.push({
        taskId: task.taskId,
        baselineReward: null,
        currentReward: task.meanReward,
        delta: null,
        baselinePassed: null,
        currentPassed: task.passed,
        newlyFailingTests: [],
        newlyPassingTests: passingTestsOfTaskResult(task),
        inBaseline: false,
        inCurrent: true,
      });
      continue;
    }
    const baseFailing = failingTestsOfTaskResult(base);
    const currentFailing = failingTestsOfTaskResult(task);
    const basePassing = passingTestsOfTaskResult(base);
    const currentPassing = passingTestsOfTaskResult(task);
    deltas.push({
      taskId: task.taskId,
      baselineReward: base.meanReward,
      currentReward: task.meanReward,
      delta: task.meanReward - base.meanReward,
      baselinePassed: base.passed,
      currentPassed: task.passed,
      newlyFailingTests: currentFailing.filter((t) => !baseFailing.includes(t)),
      newlyPassingTests: currentPassing.filter((t) => !basePassing.includes(t)),
      inBaseline: true,
      inCurrent: true,
    });
  }
  if (baseline) {
    for (const task of baseline.tasks) {
      if (!currentById.has(task.taskId)) {
        removedTasks.push(task.taskId);
        deltas.push({
          taskId: task.taskId,
          baselineReward: task.meanReward,
          currentReward: null,
          delta: null,
          baselinePassed: task.passed,
          currentPassed: null,
          newlyFailingTests: [],
          newlyPassingTests: [],
          inBaseline: true,
          inCurrent: false,
        });
      }
    }
  }
  deltas.sort((a, b) => a.taskId.localeCompare(b.taskId));
  const paired = deltas.filter((d) => d.delta !== null);
  const meanRewardDelta =
    paired.length > 0 ? paired.reduce((sum, d) => sum + (d.delta ?? 0), 0) / paired.length : null;
  const passRateDelta =
    baseline !== null ? current.passRate - baseline.passRate : null;
  return {
    currentRunId: current.runId,
    baselineRunId: baseline?.runId ?? '',
    comparedAt: Date.now(),
    deltas,
    meanRewardDelta,
    passRateDelta,
    addedTasks: addedTasks.sort(),
    removedTasks: removedTasks.sort(),
  };
}

/** Chuỗi điểm xu thế của một task qua nhiều run (cũ → mới). */
export function getEvalHarnessV4TaskSeries(
  records: readonly EvalHarnessV4RunRecord[],
  taskId: string,
): EvalHarnessV4TrendPoint[] {
  const points: EvalHarnessV4TrendPoint[] = [];
  for (const record of records) {
    const task = findEvalHarnessV4TaskResult(record, taskId);
    if (!task) continue;
    points.push({ runId: record.runId, at: record.startedAt, reward: task.meanReward, passed: task.passed });
  }
  return points.sort((a, b) => a.at - b.at);
}

/**
 * Chuỗi điểm xu thế của một test đơn lẻ qua nhiều run (cũ → mới).
 * `passed` = test pass ở ÍT NHẤT một attempt của run đó.
 */
export function getEvalHarnessV4TestSeries(
  records: readonly EvalHarnessV4RunRecord[],
  taskId: string,
  testName: string,
): { runId: string; at: number; passed: boolean }[] {
  const points: { runId: string; at: number; passed: boolean }[] = [];
  for (const record of records) {
    const task = findEvalHarnessV4TaskResult(record, taskId);
    if (!task) continue;
    let seen = false;
    let passed = false;
    for (const attempt of task.attempts) {
      for (const test of attempt.perTest) {
        if (test.name === testName) {
          seen = true;
          if (test.passed) passed = true;
        }
      }
    }
    if (seen) points.push({ runId: record.runId, at: record.startedAt, passed });
  }
  return points.sort((a, b) => a.at - b.at);
}

/** Tóm tắt nhanh lịch sử (đếm + khoảng thời gian + task đã từng chạy). */
export function summarizeEvalHarnessV4History(historyDir: string): EvalHarnessV4HistorySummary {
  const { records } = loadEvalHarnessV4History(historyDir);
  const taskIds = new Set<string>();
  for (const record of records) {
    for (const task of record.tasks) taskIds.add(task.taskId);
  }
  const baseline = readEvalHarnessV4Baseline(historyDir);
  return {
    runs: records.length,
    range:
      records.length > 0
        ? { from: records[0].startedAt, to: records[records.length - 1].startedAt }
        : null,
    latestRunId: records.length > 0 ? records[records.length - 1].runId : null,
    baselineRunId: baseline?.runId ?? null,
    taskIds: [...taskIds].sort(),
  };
}

/** Một dòng CSV cho một task trong một run (để phân tích bằng spreadsheet). */
export function evalHarnessV4HistoryCsvHeader(): string {
  return 'runId,startedAt,configName,taskId,taskVersion,attempts,passes,meanReward,passed,flaky,durationMs,promptTokens,completionTokens\n';
}

/**
 * Export lịch sử ra CSV (một dòng / task / run — attempt chi tiết
 * vẫn nằm trong file runs/<runId>.json). Dùng để phân tích bằng
 * spreadsheet hoặc script ngoài, không cần đọc JSONL.
 */
export function exportEvalHarnessV4HistoryCsv(records: readonly EvalHarnessV4RunRecord[]): string {
  const lines: string[] = [evalHarnessV4HistoryCsvHeader().trimEnd()];
  const sorted = [...records].sort((a, b) => a.startedAt - b.startedAt);
  for (const record of sorted) {
    for (const task of record.tasks) {
      lines.push(
        [
          record.runId,
          String(record.startedAt),
          record.configName,
          task.taskId,
          String(task.taskVersion),
          String(task.attempts.length),
          String(task.passes),
          task.meanReward.toFixed(4),
          task.passed ? '1' : '0',
          task.flaky ? '1' : '0',
          String(record.durationMs),
          String(task.totalPromptTokens),
          String(task.totalCompletionTokens),
        ].join(','),
      );
    }
  }
  return `${lines.join('\n')}\n`;
}

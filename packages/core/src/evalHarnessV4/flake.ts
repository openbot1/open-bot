/**
 * Phân tích flake của Eval Harness v4 (v1.44, Đội T2).
 *
 * Một task "flaky" khi lúc pass lúc fail qua các lần chạy — dấu
 * hiệu của TEST không ổn định (hoặc agent không xác định), không
 * phải của code hỏng thật. Phân biệt 2 trường hợp mà dashboard
 * thường gộp chung:
 *
 *   - flaky: pass rate ở giữa (không gần 0 cũng không gần 1) —
 *     cần xem lại test (timeout, thứ tự, phụ thuộc giờ/mạng).
 *   - always-failing: fail liên tục — hỏng thật, cần sửa code.
 *
 * Flake rate của một task/test với pass rate p qua N lần chạy:
 * `flakeRate = 1 - |2p - 1|` (0 khi luôn pass hoặc luôn fail,
 * 1 khi pass đúng một nửa). Chỉ tính khi N >= `minRuns` (mặc
 * định 3) — ít hơn thì kết luận "chưa đủ dữ liệu" thay vì đoán.
 *
 * Quarantine: task có flakeRate >= `quarantineThreshold` (mặc
 * định 0.5) được gợi ý đưa vào danh sách cách ly — suite vẫn
 * chạy nó nhưng không tính vào gate (quyết định cuối là của
 * user; module này chỉ gợi ý, không tự loại task khỏi suite).
 *
 * Module này thuần tính toán (nhận records đã load, không I/O).
 */

import { loadEvalHarnessV4History } from './history';
import type { EvalHarnessV4RunRecord } from './types';

/** Ngưỡng flake rate để gợi ý quarantine (mặc định 0.5). */
export const EVAL_HARNESS_V4_DEFAULT_QUARANTINE_THRESHOLD = 0.5 as const;
/** Số run tối thiểu để kết luận flake (mặc định 3). */
export const EVAL_HARNESS_V4_DEFAULT_MIN_RUNS = 3 as const;

/** Kết luận ổn định của một task qua lịch sử. */
export type EvalHarnessV4FlakeVerdict = 'stable-pass' | 'stable-fail' | 'flaky' | 'insufficient-data';

/** Flake của một task qua lịch sử. */
export interface EvalHarnessV4TaskFlake {
  taskId: string;
  taskName: string;
  /** Số run task đã chạy. */
  runs: number;
  passes: number;
  passRate: number;
  /** 0 = ổn định tuyệt đối, 1 = pass đúng một nửa. */
  flakeRate: number;
  verdict: EvalHarnessV4FlakeVerdict;
  consecutiveFailures: number;
  /** True khi lần chạy gần nhất pass. */
  lastPassed: boolean | null;
  /** True khi nên quarantine (flakeRate cao + đủ run). */
  quarantine: boolean;
  /** Lý do quarantine (rỗng khi không quarantine). */
  quarantineReason: string;
}

/** Flake của một test đơn lẻ (trong một task) qua lịch sử. */
export interface EvalHarnessV4TestFlake {
  taskId: string;
  testName: string;
  /** Số run test đã được chấm (task chạy ở run đó). */
  runs: number;
  passes: number;
  passRate: number;
  flakeRate: number;
  verdict: EvalHarnessV4FlakeVerdict;
}

/** Báo cáo flake đầy đủ qua toàn bộ lịch sử. */
export interface EvalHarnessV4FlakeReport {
  generatedAt: number;
  runs: number;
  /** Task flaky nhất trước (theo flakeRate giảm dần). */
  tasks: EvalHarnessV4TaskFlake[];
  /** Test flaky nhất trước. */
  tests: EvalHarnessV4TestFlake[];
  /** Task gợi ý quarantine (kèm lý do). */
  quarantine: { taskId: string; reason: string }[];
  /** Task fail liên tục (hỏng thật, không phải flake). */
  alwaysFailing: string[];
}

/** Flake rate từ pass rate p: 0 khi p = 0 hoặc 1, 1 khi p = 0.5. */
export function evalHarnessV4FlakeRate(passRate: number): number {
  if (!Number.isFinite(passRate)) return 0;
  const clamped = Math.min(1, Math.max(0, passRate));
  return 1 - Math.abs(2 * clamped - 1);
}

/** Kết luận từ pass rate + số run (ngưỡng flake = 0.25). */
export function evalHarnessV4FlakeVerdict(
  passRate: number,
  runs: number,
  minRuns: number,
): EvalHarnessV4FlakeVerdict {
  if (runs < minRuns) return 'insufficient-data';
  const flakeRate = evalHarnessV4FlakeRate(passRate);
  if (flakeRate >= 0.25) return 'flaky';
  if (passRate >= 0.99) return 'stable-pass';
  return 'stable-fail';
}

/**
 * Phân tích flake từ lịch sử đã load (records cũ → mới).
 * Task/test chỉ xuất hiện trong report khi đã chạy ÍT NHẤT 1 run;
 * verdict `insufficient-data` khi runs < minRuns.
 */
export function analyzeEvalHarnessV4Flakes(
  records: readonly EvalHarnessV4RunRecord[],
  options: { quarantineThreshold?: number; minRuns?: number } = {},
): EvalHarnessV4FlakeReport {
  const quarantineThreshold = options.quarantineThreshold ?? EVAL_HARNESS_V4_DEFAULT_QUARANTINE_THRESHOLD;
  const minRuns = options.minRuns ?? EVAL_HARNESS_V4_DEFAULT_MIN_RUNS;
  const sorted = [...records].sort((a, b) => a.startedAt - b.startedAt);
  const taskStats = new Map<string, { name: string; runs: number; passes: number; consecutiveFailures: number; lastPassed: boolean | null }>();
  const testStats = new Map<string, { taskId: string; testName: string; runs: number; passes: number }>();
  for (const record of sorted) {
    for (const task of record.tasks) {
      let stat = taskStats.get(task.taskId);
      if (!stat) {
        stat = { name: task.taskName, runs: 0, passes: 0, consecutiveFailures: 0, lastPassed: null };
        taskStats.set(task.taskId, stat);
      }
      stat.runs += 1;
      if (task.passed) {
        stat.passes += 1;
        stat.consecutiveFailures = 0;
        stat.lastPassed = true;
      } else {
        stat.consecutiveFailures += 1;
        stat.lastPassed = false;
      }
      // Test: pass khi pass ở ÍT NHẤT một attempt của run đó.
      const testPass = new Map<string, boolean>();
      for (const attempt of task.attempts) {
        for (const test of attempt.perTest) {
          if (test.passed) testPass.set(test.name, true);
          else if (!testPass.has(test.name)) testPass.set(test.name, false);
        }
      }
      for (const [testName, passed] of testPass) {
        const key = `${task.taskId}::${testName}`;
        let testStat = testStats.get(key);
        if (!testStat) {
          testStat = { taskId: task.taskId, testName, runs: 0, passes: 0 };
          testStats.set(key, testStat);
        }
        testStat.runs += 1;
        if (passed) testStat.passes += 1;
      }
    }
  }
  const tasks: EvalHarnessV4TaskFlake[] = [];
  const alwaysFailing: string[] = [];
  for (const [taskId, stat] of [...taskStats.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const passRate = stat.runs > 0 ? stat.passes / stat.runs : 0;
    const flakeRate = evalHarnessV4FlakeRate(passRate);
    const verdict = evalHarnessV4FlakeVerdict(passRate, stat.runs, minRuns);
    const quarantine = verdict === 'flaky' && flakeRate >= quarantineThreshold;
    if (stat.consecutiveFailures >= 3 && stat.lastPassed === false) alwaysFailing.push(taskId);
    tasks.push({
      taskId,
      taskName: stat.name,
      runs: stat.runs,
      passes: stat.passes,
      passRate,
      flakeRate,
      verdict,
      consecutiveFailures: stat.consecutiveFailures,
      lastPassed: stat.lastPassed,
      quarantine,
      quarantineReason: quarantine
        ? `Task "${taskId}" flaky (pass rate ${(passRate * 100).toFixed(0)}% qua ${stat.runs} run, flake rate ${flakeRate.toFixed(2)} >= ngưỡng ${quarantineThreshold}).`
        : '',
    });
  }
  tasks.sort((a, b) => b.flakeRate - a.flakeRate || a.taskId.localeCompare(b.taskId));
  const tests: EvalHarnessV4TestFlake[] = [];
  for (const stat of testStats.values()) {
    const passRate = stat.runs > 0 ? stat.passes / stat.runs : 0;
    tests.push({
      taskId: stat.taskId,
      testName: stat.testName,
      runs: stat.runs,
      passes: stat.passes,
      passRate,
      flakeRate: evalHarnessV4FlakeRate(passRate),
      verdict: evalHarnessV4FlakeVerdict(passRate, stat.runs, minRuns),
    });
  }
  tests.sort((a, b) => b.flakeRate - a.flakeRate || a.taskId.localeCompare(b.taskId) || a.testName.localeCompare(b.testName));
  const quarantine = tasks
    .filter((t) => t.quarantine)
    .map((t) => ({ taskId: t.taskId, reason: t.quarantineReason }));
  return {
    generatedAt: Date.now(),
    runs: sorted.length,
    tasks,
    tests,
    quarantine,
    alwaysFailing: alwaysFailing.sort(),
  };
}

/** Phân tích flake trực tiếp từ thư mục lịch sử trên đĩa. */
export function analyzeEvalHarnessV4FlakesFromHistory(
  historyDir: string,
  options: { quarantineThreshold?: number; minRuns?: number; limit?: number } = {},
): EvalHarnessV4FlakeReport {
  const { records } = loadEvalHarnessV4History(historyDir, { limit: options.limit ?? 0 });
  return analyzeEvalHarnessV4Flakes(records, options);
}

/** Gợi ý quarantine: danh sách task id + lý do (để user quyết định). */
export function suggestEvalHarnessV4Quarantine(report: EvalHarnessV4FlakeReport): { taskId: string; reason: string }[] {
  return report.quarantine;
}

/** Render báo cáo flake dạng text (CLI in ra terminal). */
export function formatEvalHarnessV4FlakeText(report: EvalHarnessV4FlakeReport): string {
  const lines: string[] = [];
  lines.push(`Flake: ${report.runs} run trong lịch sử, ${report.tasks.length} task, ${report.tests.length} test.`);
  const flaky = report.tasks.filter((t) => t.verdict === 'flaky');
  lines.push(`Task flaky: ${flaky.length} (quarantine gợi ý: ${report.quarantine.length}).`);
  if (report.alwaysFailing.length > 0) {
    lines.push(`Fail liên tục (hỏng thật): ${report.alwaysFailing.join(', ')}.`);
  }
  for (const task of report.tasks) {
    lines.push(
      `  ${task.taskId}: ${task.verdict} (pass ${(task.passRate * 100).toFixed(0)}% qua ${task.runs} run, flake ${task.flakeRate.toFixed(2)})${task.quarantine ? ' [quarantine]' : ''}`,
    );
  }
  const flakyTests = report.tests.filter((t) => t.verdict === 'flaky').slice(0, 10);
  if (flakyTests.length > 0) {
    lines.push('Test flaky nhất:');
    for (const test of flakyTests) {
      lines.push(`  ${test.taskId}/${test.testName}: pass ${(test.passRate * 100).toFixed(0)}% qua ${test.runs} run (flake ${test.flakeRate.toFixed(2)}).`);
    }
  }
  return `${lines.join('\n')}\n`;
}

/** Render báo cáo flake dạng Markdown. */
export function formatEvalHarnessV4FlakeMarkdown(report: EvalHarnessV4FlakeReport): string {
  const lines: string[] = [];
  lines.push('## Eval Harness v4 — Flake report');
  lines.push('');
  lines.push(`- Số run: ${report.runs}`);
  lines.push(`- Task flaky: ${report.tasks.filter((t) => t.verdict === 'flaky').length}`);
  lines.push(`- Quarantine gợi ý: ${report.quarantine.length}`);
  lines.push(`- Fail liên tục: ${report.alwaysFailing.length > 0 ? report.alwaysFailing.join(', ') : 'không có'}`);
  lines.push('');
  lines.push('| Task | Runs | Pass rate | Flake rate | Verdict | Quarantine |');
  lines.push('|---|---|---|---|---|---|');
  for (const task of report.tasks) {
    lines.push(`| ${task.taskId} | ${task.runs} | ${(task.passRate * 100).toFixed(0)}% | ${task.flakeRate.toFixed(2)} | ${task.verdict} | ${task.quarantine ? 'yes' : 'no'} |`);
  }
  lines.push('');
  if (report.quarantine.length > 0) {
    lines.push('### Quarantine gợi ý');
    lines.push('');
    for (const item of report.quarantine) {
      lines.push(`- ${item.reason}`);
    }
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}

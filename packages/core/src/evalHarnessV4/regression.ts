/**
 * Phát hiện hồi quy của Eval Harness v4 (v1.44, Đội T2).
 *
 * Một lần chạy được so với baseline (run đã pin, hoặc run gần
 * nhất trước đó) và kết luận gate:
 *
 *   - `block`  — có ÍT NHẤT một hồi quy `blocker`: task từ pass
 *     thành fail, reward sụt hơn `maxRegressionDrop`, task lỗi
 *     setup/timeout mới, hoặc pass rate suite sụt hơn ngưỡng.
 *   - `warn`   — chỉ có hồi quy `major`/`minor`: reward sụt nhẹ,
 *     task mới flaky, test mới fail nhưng task vẫn pass nhờ
 *     trọng số thấp.
 *   - `pass`   — không có hồi quy nào (chỉ có cải thiện / ổn định).
 *
 * Quy tắc mức nghiêm trọng (đọc được, kiểm chứng bằng test):
 *
 *   - pass → fail (bất kể reward): `blocker`, kind `new-failure`.
 *   - reward sụt >= maxRegressionDrop: `blocker`, kind `reward-drop`.
 *   - reward sụt > 0 nhưng < ngưỡng: `major`, kind `reward-drop`.
 *   - test mới fail nhưng task vẫn pass: `minor`, kind `new-failure`.
 *   - task lần này flaky (lúc pass lúc fail qua các repeat) mà
 *     baseline ổn định: `minor`, kind `newly-flaky`.
 *   - attempt timeout mới / lỗi executor mới: `blocker` khi task
 *     từ pass thành fail, còn không thì `major`.
 *   - pass rate suite sụt >= maxRegressionDrop: `blocker`, kind
 *     `suite-drop` (gắn vào taskId `*suite*`).
 *   - Ngược lại (reward tăng, test mới pass): ghi vào
 *     `improvements`, không tính là hồi quy.
 *
 * Module này thuần tính toán (không I/O): nhận 2 run record +
 * thresholds, trả về báo cáo hồi quy đầy đủ.
 */

import { compareEvalHarnessV4Runs } from './history';
import type {
  EvalHarnessV4GateVerdict,
  EvalHarnessV4Improvement,
  EvalHarnessV4Regression,
  EvalHarnessV4RegressionReport,
  EvalHarnessV4RegressionSeverity,
  EvalHarnessV4RunRecord,
  EvalHarnessV4Thresholds,
} from './types';

/** Task id giả dùng cho hồi quy cấp suite (không phải một task thật). */
export const EVAL_HARNESS_V4_SUITE_TASK_ID = '*suite*' as const;

function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}

function formatReward(value: number | null): string {
  if (value === null) return '—';
  return value.toFixed(2);
}

function formatDelta(delta: number | null): string {
  if (delta === null) return '';
  const sign = delta > 0 ? '+' : '';
  return `${sign}${delta.toFixed(2)}`;
}

/**
 * Phát hiện hồi quy của `current` so với `baseline`.
 * `baseline` null = run đầu tiên: không có hồi quy (không có gì
 * để so), mọi task đều ghi vào improvements dạng "task mới".
 */
export function detectEvalHarnessV4Regressions(
  current: EvalHarnessV4RunRecord,
  baseline: EvalHarnessV4RunRecord | null,
  thresholds: EvalHarnessV4Thresholds,
): EvalHarnessV4RegressionReport {
  const comparison = compareEvalHarnessV4Runs(current, baseline);
  const regressions: EvalHarnessV4Regression[] = [];
  const improvements: EvalHarnessV4Improvement[] = [];
  const currentById = new Map(current.tasks.map((t) => [t.taskId, t]));
  const baselineById = new Map<string, EvalHarnessV4RunRecord['tasks'][number]>(
    (baseline?.tasks ?? []).map((t) => [t.taskId, t]),
  );
  for (const delta of comparison.deltas) {
    const task = currentById.get(delta.taskId);
    const baseTask = baselineById.get(delta.taskId);
    if (!task) continue;
    // Task mới (chưa có ở baseline): không phải hồi quy, cũng không
    // phải cải thiện — bỏ qua để dashboard không ồn.
    if (!baseTask) continue;
    const wasPassing = baseTask.passed;
    const nowPassing = task.passed;
    const timedOutAttempts = task.attempts.filter((a) => a.timedOut).length;
    const errorAttempts = task.attempts.filter((a) => a.error !== null).length;
    const baseTimedOut = baseTask.attempts.filter((a) => a.timedOut).length;
    const baseErrors = baseTask.attempts.filter((a) => a.error !== null).length;
    // 1. Pass -> fail: blocker, bất kể reward sụt bao nhiêu.
    if (wasPassing && !nowPassing) {
      const kind = timedOutAttempts > baseTimedOut ? 'timeout' : errorAttempts > baseErrors ? 'error' : 'new-failure';
      const severity: EvalHarnessV4RegressionSeverity = 'blocker';
      regressions.push({
        taskId: delta.taskId,
        kind,
        severity,
        previousReward: delta.baselineReward,
        currentReward: delta.currentReward,
        delta: delta.delta,
        previousPassed: wasPassing,
        currentPassed: nowPassing,
        newlyFailingTests: delta.newlyFailingTests,
        detail:
          delta.newlyFailingTests.length > 0
            ? `Task "${delta.taskId}" từ pass thành fail (reward ${formatReward(delta.baselineReward)} → ${formatReward(delta.currentReward)}); test mới fail: ${delta.newlyFailingTests.join(', ')}.`
            : `Task "${delta.taskId}" từ pass thành fail (reward ${formatReward(delta.baselineReward)} → ${formatReward(delta.currentReward)}).`,
        firstSeenRunId: current.runId,
      });
      continue;
    }
    // 2. Reward sụt (task vẫn pass hoặc vẫn fail như cũ).
    if (delta.delta !== null && delta.delta < 0) {
      const drop = -delta.delta;
      if (drop >= thresholds.maxRegressionDrop) {
        regressions.push({
          taskId: delta.taskId,
          kind: 'reward-drop',
          severity: 'blocker',
          previousReward: delta.baselineReward,
          currentReward: delta.currentReward,
          delta: delta.delta,
          previousPassed: wasPassing,
          currentPassed: nowPassing,
          newlyFailingTests: delta.newlyFailingTests,
          detail: `Task "${delta.taskId}" sụt reward ${formatDelta(delta.delta)} (${formatReward(delta.baselineReward)} → ${formatReward(delta.currentReward)}), vượt ngưỡng ${thresholds.maxRegressionDrop}.`,
          firstSeenRunId: current.runId,
        });
      } else {
        regressions.push({
          taskId: delta.taskId,
          kind: 'reward-drop',
          severity: 'major',
          previousReward: delta.baselineReward,
          currentReward: delta.currentReward,
          delta: delta.delta,
          previousPassed: wasPassing,
          currentPassed: nowPassing,
          newlyFailingTests: delta.newlyFailingTests,
          detail: `Task "${delta.taskId}" sụt reward nhẹ ${formatDelta(delta.delta)} (${formatReward(delta.baselineReward)} → ${formatReward(delta.currentReward)}).`,
          firstSeenRunId: current.runId,
        });
      }
    }
    // 3. Test mới fail nhưng task vẫn pass (trọng số thấp) — minor.
    if (delta.newlyFailingTests.length > 0 && nowPassing && !(wasPassing && !nowPassing)) {
      const alreadyReported = regressions.some((r) => r.taskId === delta.taskId && r.kind === 'reward-drop');
      if (!alreadyReported) {
        regressions.push({
          taskId: delta.taskId,
          kind: 'new-failure',
          severity: 'minor',
          previousReward: delta.baselineReward,
          currentReward: delta.currentReward,
          delta: delta.delta,
          previousPassed: wasPassing,
          currentPassed: nowPassing,
          newlyFailingTests: delta.newlyFailingTests,
          detail: `Task "${delta.taskId}" vẫn pass nhưng test mới fail: ${delta.newlyFailingTests.join(', ')}.`,
          firstSeenRunId: current.runId,
        });
      } else {
        // Đã báo reward-drop thì gộp test mới fail vào cùng hồi quy đó.
        const existing = regressions.find((r) => r.taskId === delta.taskId && r.kind === 'reward-drop');
        if (existing) existing.newlyFailingTests = delta.newlyFailingTests;
      }
    }
    // 4. Task mới flaky (baseline ổn định, lần này lúc pass lúc fail).
    if (task.flaky && !baseTask.flaky) {
      regressions.push({
        taskId: delta.taskId,
        kind: 'newly-flaky',
        severity: 'minor',
        previousReward: delta.baselineReward,
        currentReward: delta.currentReward,
        delta: delta.delta,
        previousPassed: wasPassing,
        currentPassed: nowPassing,
        newlyFailingTests: delta.newlyFailingTests,
        detail: `Task "${delta.taskId}" mới flaky: ${task.passes}/${task.attempts.length} attempt pass (baseline ổn định ${baseTask.passes}/${baseTask.attempts.length}).`,
        firstSeenRunId: current.runId,
      });
    }
    // 5. Timeout / lỗi mới xuất hiện (task vẫn pass nhờ attempt khác).
    if (timedOutAttempts > baseTimedOut && nowPassing) {
      regressions.push({
        taskId: delta.taskId,
        kind: 'timeout',
        severity: 'major',
        previousReward: delta.baselineReward,
        currentReward: delta.currentReward,
        delta: delta.delta,
        previousPassed: wasPassing,
        currentPassed: nowPassing,
        newlyFailingTests: delta.newlyFailingTests,
        detail: `Task "${delta.taskId}" mới timeout ở ${timedOutAttempts} attempt (baseline ${baseTimedOut}).`,
        firstSeenRunId: current.runId,
      });
    }
    if (errorAttempts > baseErrors && nowPassing) {
      regressions.push({
        taskId: delta.taskId,
        kind: 'error',
        severity: 'major',
        previousReward: delta.baselineReward,
        currentReward: delta.currentReward,
        delta: delta.delta,
        previousPassed: wasPassing,
        currentPassed: nowPassing,
        newlyFailingTests: delta.newlyFailingTests,
        detail: `Task "${delta.taskId}" mới lỗi executor ở ${errorAttempts} attempt (baseline ${baseErrors}).`,
        firstSeenRunId: current.runId,
      });
    }
    // 6. Cải thiện: reward tăng hoặc test mới pass.
    if ((delta.delta !== null && delta.delta > 0) || delta.newlyPassingTests.length > 0) {
      improvements.push({
        taskId: delta.taskId,
        previousReward: delta.baselineReward,
        currentReward: delta.currentReward,
        delta: delta.delta,
        newlyPassingTests: delta.newlyPassingTests,
        detail:
          delta.newlyPassingTests.length > 0
            ? `Task "${delta.taskId}" tốt lên ${formatDelta(delta.delta)} (${formatReward(delta.baselineReward)} → ${formatReward(delta.currentReward)}); test mới pass: ${delta.newlyPassingTests.join(', ')}.`
            : `Task "${delta.taskId}" tốt lên ${formatDelta(delta.delta)} (${formatReward(delta.baselineReward)} → ${formatReward(delta.currentReward)}).`,
      });
    }
  }
  // 7. Hồi quy cấp suite: pass rate sụt mạnh dù từng task chưa đủ ngưỡng.
  if (baseline && comparison.passRateDelta !== null && -comparison.passRateDelta >= thresholds.maxRegressionDrop) {
    regressions.push({
      taskId: EVAL_HARNESS_V4_SUITE_TASK_ID,
      kind: 'suite-drop',
      severity: 'blocker',
      previousReward: baseline.meanReward,
      currentReward: current.meanReward,
      delta: round4(current.meanReward - baseline.meanReward),
      previousPassed: null,
      currentPassed: null,
      newlyFailingTests: [],
      detail: `Cả suite sụt pass rate ${formatDelta(comparison.passRateDelta)} (${baseline.passRate.toFixed(2)} → ${current.passRate.toFixed(2)}), vượt ngưỡng ${thresholds.maxRegressionDrop}.`,
      firstSeenRunId: current.runId,
    });
  }
  // Sắp xếp: blocker trước, rồi major, minor, info; trong cùng mức theo taskId.
  const severityRank: Record<EvalHarnessV4RegressionSeverity, number> = {
    blocker: 0,
    major: 1,
    minor: 2,
    info: 3,
  };
  regressions.sort(
    (a, b) => severityRank[a.severity] - severityRank[b.severity] || a.taskId.localeCompare(b.taskId),
  );
  improvements.sort((a, b) => (b.delta ?? 0) - (a.delta ?? 0) || a.taskId.localeCompare(b.taskId));
  const bySeverity: Record<EvalHarnessV4RegressionSeverity, number> = {
    blocker: 0,
    major: 0,
    minor: 0,
    info: 0,
  };
  for (const regression of regressions) bySeverity[regression.severity] += 1;
  const gate = gateEvalHarnessV4Regressions(regressions, current, thresholds);
  const gateReason = describeEvalHarnessV4Gate(gate, regressions, current, thresholds);
  return {
    currentRunId: current.runId,
    baselineRunId: baseline?.runId ?? '',
    comparedAt: Date.now(),
    regressions,
    improvements,
    bySeverity,
    gate,
    gateReason,
    comparison,
  };
}

/**
 * Kết luận gate từ danh sách hồi quy + ngưỡng suite của config.
 * - `block` khi có blocker, hoặc pass rate / mean reward suite
 *   dưới ngưỡng tối thiểu (dù không có hồi quy từng task).
 * - `warn` khi chỉ có major/minor.
 * - `pass` khi không có hồi quy và suite đạt ngưỡng.
 */
export function gateEvalHarnessV4Regressions(
  regressions: readonly EvalHarnessV4Regression[],
  current: EvalHarnessV4RunRecord,
  thresholds: EvalHarnessV4Thresholds,
): EvalHarnessV4GateVerdict {
  if (regressions.some((r) => r.severity === 'blocker')) return 'block';
  if (current.total > 0 && current.passRate < thresholds.minPassRate) return 'block';
  if (current.total > 0 && current.meanReward < thresholds.minMeanReward) return 'block';
  if (regressions.length > 0) return 'warn';
  return 'pass';
}

/** Mô tả gate bằng 1 dòng (hiện trong CLI + dashboard). */
export function describeEvalHarnessV4Gate(
  gate: EvalHarnessV4GateVerdict,
  regressions: readonly EvalHarnessV4Regression[],
  current: EvalHarnessV4RunRecord,
  thresholds: EvalHarnessV4Thresholds,
): string {
  if (gate === 'pass') {
    return `Gate pass: không có hồi quy; suite ${current.passed}/${current.total} pass (pass rate ${current.passRate.toFixed(2)}, mean reward ${current.meanReward.toFixed(2)}).`;
  }
  const blockers = regressions.filter((r) => r.severity === 'blocker');
  if (blockers.length > 0) {
    const first = blockers.slice(0, 3).map((r) => r.taskId).join(', ');
    return `Gate block: ${blockers.length} hồi quy blocker (${first}${blockers.length > 3 ? ', …' : ''}).`;
  }
  if (current.total > 0 && current.passRate < thresholds.minPassRate) {
    return `Gate block: pass rate ${current.passRate.toFixed(2)} dưới ngưỡng tối thiểu ${thresholds.minPassRate}.`;
  }
  if (current.total > 0 && current.meanReward < thresholds.minMeanReward) {
    return `Gate block: mean reward ${current.meanReward.toFixed(2)} dưới ngưỡng tối thiểu ${thresholds.minMeanReward}.`;
  }
  const majors = regressions.filter((r) => r.severity === 'major').length;
  const minors = regressions.filter((r) => r.severity === 'minor').length;
  return `Gate warn: ${regressions.length} hồi quy (${majors} major, ${minors} minor), không có blocker.`;
}

/** Exit code cho CI/script: 0 = pass/warn, 1 = block khi failOnRegression. */
export function evalHarnessV4GateExitCode(
  gate: EvalHarnessV4GateVerdict,
  failOnRegression: boolean,
): number {
  if (gate === 'block') return failOnRegression ? 1 : 0;
  return 0;
}

/** Render báo cáo hồi quy dạng text (CLI in ra terminal). */
export function formatEvalHarnessV4RegressionText(report: EvalHarnessV4RegressionReport): string {
  const lines: string[] = [];
  lines.push(`Hồi quy: ${report.currentRunId} so với ${report.baselineRunId || '(không có baseline)'}`);
  lines.push(`Gate: ${report.gate} — ${report.gateReason}`);
  lines.push(`Hồi quy: ${report.regressions.length} (blocker ${report.bySeverity.blocker}, major ${report.bySeverity.major}, minor ${report.bySeverity.minor}, info ${report.bySeverity.info})`);
  lines.push(`Cải thiện: ${report.improvements.length}`);
  if (report.regressions.length > 0) {
    lines.push('');
    lines.push('Hồi quy:');
    for (const regression of report.regressions) {
      lines.push(`  [${regression.severity}] ${regression.taskId} (${regression.kind}): ${regression.detail}`);
    }
  }
  if (report.improvements.length > 0) {
    lines.push('');
    lines.push('Cải thiện:');
    for (const improvement of report.improvements) {
      lines.push(`  [+] ${improvement.taskId}: ${improvement.detail}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

/** Render báo cáo hồi quy dạng Markdown (dán vào issue/PR, lưu dashboard). */
export function formatEvalHarnessV4RegressionMarkdown(report: EvalHarnessV4RegressionReport): string {
  const lines: string[] = [];
  lines.push('## Eval Harness v4 — Regression report');
  lines.push('');
  lines.push(`- Current: \`${report.currentRunId}\``);
  lines.push(`- Baseline: \`${report.baselineRunId || '(không có baseline)'}\``);
  lines.push(`- Gate: **${report.gate}** — ${report.gateReason}`);
  lines.push(`- Hồi quy: ${report.regressions.length} (blocker ${report.bySeverity.blocker}, major ${report.bySeverity.major}, minor ${report.bySeverity.minor})`);
  lines.push(`- Cải thiện: ${report.improvements.length}`);
  lines.push('');
  if (report.regressions.length > 0) {
    lines.push('| Task | Kind | Severity | Reward (trước → sau) | Chi tiết |');
    lines.push('|---|---|---|---|---|');
    for (const r of report.regressions) {
      lines.push(`| ${r.taskId} | ${r.kind} | ${r.severity} | ${formatReward(r.previousReward)} → ${formatReward(r.currentReward)} | ${r.detail} |`);
    }
    lines.push('');
  }
  if (report.improvements.length > 0) {
    lines.push('### Cải thiện');
    lines.push('');
    for (const improvement of report.improvements) {
      lines.push(`- ${improvement.detail}`);
    }
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}

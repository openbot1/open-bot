/**
 * Dashboard hồi quy của Eval Harness v4 (v1.44, Đội T2).
 *
 * Dashboard trả lời 4 câu hỏi mà một báo cáo eval đơn lẻ không
 * trả lời được:
 *
 *   - Suite đang tốt lên hay xấu đi? (xu thế pass rate / mean
 *     reward qua các lần chạy — nửa sau so với nửa đầu.)
 *   - Task nào thụt lùi so với lần chạy trước / baseline?
 *     (lấy từ `regression.ts`, gắn vào dashboard của run mới nhất.)
 *   - Task nào flaky (lúc pass lúc fail) — cần xem lại test,
 *     không phải sửa code.
 *   - Task nào fail liên tục — hỏng thật, cần sửa ngay.
 *
 * Dữ liệu dashboard (`EvalHarnessV4Dashboard`) là JSON thuần để
 * UI/CLI/tool đọc lại; `renderEvalHarnessV4DashboardMarkdown`
 * và `renderEvalHarnessV4DashboardHtml` chỉ là 2 cách trình bày
 * cùng một dữ liệu. HTML là file standalone (CSS inline, không
 * tài sản ngoài, không gọi mạng) nên mở được offline.
 *
 * Module này thuần tính toán + render chuỗi (đọc lịch sử qua
 * `history.ts` khi build từ đĩa, nhưng bản thân hàm build chỉ
 * nhận records đã load — tách riêng để test không cần đĩa).
 */

import { getEvalHarnessV4TaskSeries, getEvalHarnessV4TestSeries, loadEvalHarnessV4History, readEvalHarnessV4Baseline } from './history';
import { detectEvalHarnessV4Regressions } from './regression';
import type {
  EvalHarnessV4Dashboard,
  EvalHarnessV4RunRecord,
  EvalHarnessV4TaskTrend,
  EvalHarnessV4TestTrend,
  EvalHarnessV4Thresholds,
  EvalHarnessV4TrendDirection,
  EvalHarnessV4TrendPoint,
} from './types';

/** Ngưỡng |slope| để coi xu thế là improving/worsening (reward/run). */
export const EVAL_HARNESS_V4_TREND_SLOPE_EPSILON = 0.02 as const;

/**
 * Độ dốc hồi quy tuyến tính (least squares) của reward theo thứ
 * tự run (x = 0..n-1). n < 2 → slope 0 (không đủ điểm để kết luận).
 */
export function computeEvalHarnessV4Slope(points: readonly EvalHarnessV4TrendPoint[]): number {
  const n = points.length;
  if (n < 2) return 0;
  let sumX = 0;
  let sumY = 0;
  let sumXY = 0;
  let sumXX = 0;
  for (let i = 0; i < n; i++) {
    const y = points[i].reward;
    sumX += i;
    sumY += y;
    sumXY += i * y;
    sumXX += i * i;
  }
  const denom = n * sumXX - sumX * sumX;
  if (denom === 0) return 0;
  return (n * sumXY - sumX * sumY) / denom;
}

/** Hướng xu thế từ slope: vượt epsilon thì improving/worsening, còn lại stable. */
export function trendDirectionFromSlope(slope: number): EvalHarnessV4TrendDirection {
  if (slope > EVAL_HARNESS_V4_TREND_SLOPE_EPSILON) return 'improving';
  if (slope < -EVAL_HARNESS_V4_TREND_SLOPE_EPSILON) return 'worsening';
  return 'stable';
}

/**
 * Hướng xu thế từ 2 nửa của chuỗi điểm: so mean reward nửa sau
 * với nửa đầu (dùng cho suite — ít điểm hơn task, slope dễ nhiễu).
 */
export function trendDirectionFromHalves(values: readonly number[]): EvalHarnessV4TrendDirection {
  if (values.length < 2) return 'stable';
  const half = Math.floor(values.length / 2);
  const first = values.slice(0, half);
  const second = values.slice(half);
  if (first.length === 0 || second.length === 0) return 'stable';
  const mean = (xs: readonly number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;
  const diff = mean(second) - mean(first);
  if (diff > EVAL_HARNESS_V4_TREND_SLOPE_EPSILON) return 'improving';
  if (diff < -EVAL_HARNESS_V4_TREND_SLOPE_EPSILON) return 'worsening';
  return 'stable';
}

/** Xu thế của một task từ chuỗi điểm của nó. */
export function buildEvalHarnessV4TaskTrend(
  taskId: string,
  taskName: string,
  points: readonly EvalHarnessV4TrendPoint[],
  alwaysFailingRuns: number,
): EvalHarnessV4TaskTrend {
  const sorted = [...points].sort((a, b) => a.at - b.at);
  const slope = computeEvalHarnessV4Slope(sorted);
  const passes = sorted.filter((p) => p.passed).length;
  let consecutiveFailures = 0;
  for (let i = sorted.length - 1; i >= 0; i--) {
    if (sorted[i].passed) break;
    consecutiveFailures += 1;
  }
  const hasPass = passes > 0;
  const hasFail = sorted.some((p) => !p.passed);
  return {
    taskId,
    taskName,
    points: sorted,
    runs: sorted.length,
    meanReward: sorted.length > 0 ? sorted.reduce((sum, p) => sum + p.reward, 0) / sorted.length : 0,
    lastReward: sorted.length > 0 ? sorted[sorted.length - 1].reward : null,
    firstReward: sorted.length > 0 ? sorted[0].reward : null,
    slope,
    direction: trendDirectionFromSlope(slope),
    passRate: sorted.length > 0 ? passes / sorted.length : 0,
    flaky: hasPass && hasFail,
    consecutiveFailures,
    alwaysFailing: consecutiveFailures >= alwaysFailingRuns && consecutiveFailures > 0,
  };
}

/** Tên hiển thị của task (fallback = id khi không tìm thấy tên). */
function taskDisplayName(records: readonly EvalHarnessV4RunRecord[], taskId: string): string {
  for (let i = records.length - 1; i >= 0; i--) {
    const task = records[i].tasks.find((t) => t.taskId === taskId);
    if (task) return task.taskName;
  }
  return taskId;
}

/**
 * Build dashboard từ lịch sử đã load (records cũ → mới).
 * `baseline` là run dùng để so hồi quy cho run mới nhất
 * (null = so với run trước đó; undefined = không so hồi quy).
 */
export function buildEvalHarnessV4Dashboard(
  records: readonly EvalHarnessV4RunRecord[],
  options: {
    baseline?: EvalHarnessV4RunRecord | null;
    thresholds: EvalHarnessV4Thresholds;
  },
): EvalHarnessV4Dashboard {
  const sorted = [...records].sort((a, b) => a.startedAt - b.startedAt);
  const latest = sorted.length > 0 ? sorted[sorted.length - 1] : null;
  const suitePoints = sorted.map((r) => ({
    runId: r.runId,
    at: r.startedAt,
    passRate: r.passRate,
    meanReward: r.meanReward,
  }));
  const meanPassRate =
    suitePoints.length > 0 ? suitePoints.reduce((sum, p) => sum + p.passRate, 0) / suitePoints.length : null;
  const meanReward =
    suitePoints.length > 0 ? suitePoints.reduce((sum, p) => sum + p.meanReward, 0) / suitePoints.length : null;
  const suiteDirection = trendDirectionFromHalves(suitePoints.map((p) => p.meanReward));
  const taskIds = new Set<string>();
  for (const record of sorted) {
    for (const task of record.tasks) taskIds.add(task.taskId);
  }
  const tasks: EvalHarnessV4TaskTrend[] = [];
  for (const taskId of [...taskIds].sort()) {
    const points = getEvalHarnessV4TaskSeries(sorted, taskId);
    tasks.push(
      buildEvalHarnessV4TaskTrend(taskId, taskDisplayName(sorted, taskId), points, options.thresholds.alwaysFailingRuns),
    );
  }
  // Xu thế từng test: gom mọi (taskId, testName) đã từng được chấm,
  // flaky nhất trước (pass rate càng gần 0.5 càng flaky).
  const testKeys = new Map<string, { taskId: string; testName: string }>();
  for (const record of sorted) {
    for (const task of record.tasks) {
      for (const attempt of task.attempts) {
        for (const test of attempt.perTest) {
          const key = `${task.taskId}::${test.name}`;
          if (!testKeys.has(key)) testKeys.set(key, { taskId: task.taskId, testName: test.name });
        }
      }
    }
  }
  const testTrends: EvalHarnessV4TestTrend[] = [];
  for (const { taskId, testName } of testKeys.values()) {
    const points = getEvalHarnessV4TestSeries(sorted, taskId, testName);
    if (points.length === 0) continue;
    const passes = points.filter((p) => p.passed).length;
    const passRate = passes / points.length;
    const slope = computeEvalHarnessV4Slope(points.map((p) => ({ ...p, reward: p.passed ? 1 : 0 })));
    testTrends.push({
      taskId,
      testName,
      points,
      runs: points.length,
      passRate,
      flaky: passes > 0 && passes < points.length,
      direction: trendDirectionFromSlope(slope),
    });
  }
  testTrends.sort(
    (a, b) =>
      (1 - Math.abs(2 * b.passRate - 1)) - (1 - Math.abs(2 * a.passRate - 1)) ||
      a.taskId.localeCompare(b.taskId) ||
      a.testName.localeCompare(b.testName),
  );
  // Hồi quy của run mới nhất (so với baseline hoặc run trước đó).
  let latestRegressions: EvalHarnessV4Dashboard['latestRegressions'] = [];
  let latestImprovements: EvalHarnessV4Dashboard['latestImprovements'] = [];
  let gate: EvalHarnessV4Dashboard['gate'] = 'pass';
  let gateReason = 'Chưa có run nào để đánh giá gate.';
  let baselineRunId: string | null = null;
  if (latest) {
    const baseline = options.baseline !== undefined ? options.baseline : sorted.length >= 2 ? sorted[sorted.length - 2] : null;
    baselineRunId = baseline?.runId ?? null;
    const report = detectEvalHarnessV4Regressions(latest, baseline, options.thresholds);
    latestRegressions = report.regressions;
    latestImprovements = report.improvements;
    gate = report.gate;
    gateReason = report.gateReason;
  }
  return {
    generatedAt: Date.now(),
    latestRunId: latest?.runId ?? null,
    baselineRunId,
    runs: sorted.length,
    range: sorted.length > 0 ? { from: sorted[0].startedAt, to: sorted[sorted.length - 1].startedAt } : null,
    suite: {
      runs: suitePoints.length,
      points: suitePoints,
      meanPassRate,
      latestPassRate: suitePoints.length > 0 ? suitePoints[suitePoints.length - 1].passRate : null,
      meanReward,
      latestMeanReward: suitePoints.length > 0 ? suitePoints[suitePoints.length - 1].meanReward : null,
      direction: suiteDirection,
    },
    tasks,
    testTrends,
    latestRegressions,
    latestImprovements,
    gate,
    gateReason,
    flakyTasks: tasks.filter((t) => t.flaky).map((t) => t.taskId),
    alwaysFailingTasks: tasks.filter((t) => t.alwaysFailing).map((t) => t.taskId),
    worseningTasks: tasks.filter((t) => t.direction === 'worsening').map((t) => t.taskId),
    improvingTasks: tasks.filter((t) => t.direction === 'improving').map((t) => t.taskId),
  };
}

/** Build dashboard trực tiếp từ thư mục lịch sử trên đĩa. */
export function buildEvalHarnessV4DashboardFromHistory(
  historyDir: string,
  options: { thresholds: EvalHarnessV4Thresholds; limit?: number },
): EvalHarnessV4Dashboard {
  const { records } = loadEvalHarnessV4History(historyDir, { limit: options.limit ?? 0 });
  const baseline = readEvalHarnessV4Baseline(historyDir);
  const baselineRun = baseline ? records.find((r) => r.runId === baseline.runId) ?? null : null;
  return buildEvalHarnessV4Dashboard(records, {
    baseline: baseline ? baselineRun : undefined,
    thresholds: options.thresholds,
  });
}

function formatPct(value: number | null): string {
  if (value === null) return '—';
  return `${(value * 100).toFixed(0)}%`;
}

function formatReward(value: number | null): string {
  if (value === null) return '—';
  return value.toFixed(2);
}

function formatDate(at: number): string {
  return new Date(at).toISOString().replace('T', ' ').slice(0, 19);
}

function trendArrow(direction: EvalHarnessV4TrendDirection): string {
  if (direction === 'improving') return '↑';
  if (direction === 'worsening') return '↓';
  return '→';
}

/** Render dashboard dạng Markdown (để dán vào issue/PR hoặc lưu file). */
export function renderEvalHarnessV4DashboardMarkdown(dashboard: EvalHarnessV4Dashboard): string {
  const lines: string[] = [];
  lines.push('# Eval Harness v4 — Regression dashboard');
  lines.push('');
  lines.push(`- Tạo lúc: ${formatDate(dashboard.generatedAt)}`);
  lines.push(`- Số run trong lịch sử: ${dashboard.runs}`);
  if (dashboard.range) {
    lines.push(`- Khoảng thời gian: ${formatDate(dashboard.range.from)} → ${formatDate(dashboard.range.to)}`);
  }
  lines.push(`- Run mới nhất: \`${dashboard.latestRunId ?? '(chưa có)'}\``);
  lines.push(`- Baseline: \`${dashboard.baselineRunId ?? '(lần chạy trước đó)'}\``);
  lines.push(`- Gate: **${dashboard.gate}** — ${dashboard.gateReason}`);
  lines.push('');
  lines.push('## Suite');
  lines.push('');
  lines.push(`- Xu thế: ${trendArrow(dashboard.suite.direction)} ${dashboard.suite.direction}`);
  lines.push(`- Pass rate trung bình: ${formatPct(dashboard.suite.meanPassRate)} (mới nhất: ${formatPct(dashboard.suite.latestPassRate)})`);
  lines.push(`- Mean reward trung bình: ${formatReward(dashboard.suite.meanReward)} (mới nhất: ${formatReward(dashboard.suite.latestMeanReward)})`);
  lines.push('');
  if (dashboard.latestRegressions.length > 0) {
    lines.push('## Hồi quy (run mới nhất so với baseline)');
    lines.push('');
    for (const regression of dashboard.latestRegressions) {
      lines.push(`- [${regression.severity}] ${regression.taskId}: ${regression.detail}`);
    }
    lines.push('');
  } else {
    lines.push('## Hồi quy');
    lines.push('');
    lines.push('Không có hồi quy ở run mới nhất.');
    lines.push('');
  }
  if (dashboard.latestImprovements.length > 0) {
    lines.push('## Cải thiện');
    lines.push('');
    for (const improvement of dashboard.latestImprovements) {
      lines.push(`- ${improvement.detail}`);
    }
    lines.push('');
  }
  lines.push('## Task');
  lines.push('');
  lines.push('| Task | Runs | Pass rate | Mean reward | Gần nhất | Xu thế | Flaky | Fail liên tiếp |');
  lines.push('|---|---|---|---|---|---|---|---|');
  for (const task of dashboard.tasks) {
    lines.push(
      `| ${task.taskId} | ${task.runs} | ${formatPct(task.passRate)} | ${formatReward(task.meanReward)} | ${formatReward(task.lastReward)} | ${trendArrow(task.direction)} ${task.direction} | ${task.flaky ? 'yes' : 'no'} | ${task.consecutiveFailures} |`,
    );
  }
  lines.push('');
  if (dashboard.alwaysFailingTasks.length > 0) {
    lines.push(`**Fail liên tục (cần sửa ngay):** ${dashboard.alwaysFailingTasks.join(', ')}`);
    lines.push('');
  }
  if (dashboard.flakyTasks.length > 0) {
    lines.push(`**Flaky (lúc pass lúc fail — xem lại test):** ${dashboard.flakyTasks.join(', ')}`);
    lines.push('');
  }
  const flakyTests = dashboard.testTrends.filter((t) => t.flaky).slice(0, 5);
  if (flakyTests.length > 0) {
    lines.push('## Test flaky nhất');
    lines.push('');
    lines.push('| Test | Runs | Pass rate | Xu thế |');
    lines.push('|---|---|---|---|');
    for (const test of flakyTests) {
      lines.push(`| ${test.taskId}/${test.testName} | ${test.runs} | ${formatPct(test.passRate)} | ${trendArrow(test.direction)} ${test.direction} |`);
    }
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}

/** Escape HTML để tên task / detail không phá vỡ dashboard HTML. */
export function escapeEvalHarnessV4Html(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Render dashboard dạng HTML standalone (CSS inline, không tài sản ngoài). */
export function renderEvalHarnessV4DashboardHtml(dashboard: EvalHarnessV4Dashboard): string {
  const gateClass = dashboard.gate === 'pass' ? 'gate-pass' : dashboard.gate === 'warn' ? 'gate-warn' : 'gate-block';
  const taskRows = dashboard.tasks
    .map(
      (task) => `<tr>
        <td>${escapeEvalHarnessV4Html(task.taskId)}</td>
        <td>${task.runs}</td>
        <td>${formatPct(task.passRate)}</td>
        <td>${formatReward(task.meanReward)}</td>
        <td>${formatReward(task.lastReward)}</td>
        <td>${trendArrow(task.direction)} ${task.direction}</td>
        <td>${task.flaky ? 'yes' : 'no'}</td>
        <td>${task.consecutiveFailures}</td>
      </tr>`,
    )
    .join('\n');
  const regressionItems =
    dashboard.latestRegressions.length > 0
      ? dashboard.latestRegressions
          .map((r) => `<li><strong>[${escapeEvalHarnessV4Html(r.severity)}]</strong> ${escapeEvalHarnessV4Html(r.taskId)}: ${escapeEvalHarnessV4Html(r.detail)}</li>`)
          .join('\n')
      : '<li>Không có hồi quy ở run mới nhất.</li>';
  const improvementItems =
    dashboard.latestImprovements.length > 0
      ? dashboard.latestImprovements
          .map((i) => `<li>${escapeEvalHarnessV4Html(i.detail)}</li>`)
          .join('\n')
      : '<li>Không có cải thiện ở run mới nhất.</li>';
  const suiteBars = dashboard.suite.points
    .map((p) => {
      const height = Math.round(p.meanReward * 100);
      const title = `${escapeEvalHarnessV4Html(p.runId)}: reward ${p.meanReward.toFixed(2)}, pass ${formatPct(p.passRate)}`;
      return `<div class="bar" style="height:${height}px" title="${title}"></div>`;
    })
    .join('\n');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Eval Harness v4 — Regression dashboard</title>
<style>
body { font-family: system-ui, sans-serif; margin: 24px; color: #1a1a1a; background: #fff; }
h1 { font-size: 22px; } h2 { font-size: 17px; margin-top: 28px; }
table { border-collapse: collapse; width: 100%; }
th, td { border: 1px solid #ccc; padding: 6px 8px; text-align: left; font-size: 14px; }
th { background: #f2f2f2; }
.gate-pass { color: #0a7a2e; } .gate-warn { color: #8a6d00; } .gate-block { color: #b00020; }
.bars { display: flex; align-items: flex-end; gap: 3px; height: 120px; border-bottom: 1px solid #ccc; padding: 4px 0; }
.bar { width: 18px; background: #2f6fed; min-height: 2px; }
.meta { color: #555; font-size: 14px; }
</style>
</head>
<body>
<h1>Eval Harness v4 — Regression dashboard</h1>
<p class="meta">Tạo lúc: ${formatDate(dashboard.generatedAt)} &middot; Số run: ${dashboard.runs} &middot; Run mới nhất: ${escapeEvalHarnessV4Html(dashboard.latestRunId ?? '(chưa có)')} &middot; Baseline: ${escapeEvalHarnessV4Html(dashboard.baselineRunId ?? '(lần chạy trước đó)')}</p>
<p>Gate: <strong class="${gateClass}">${dashboard.gate}</strong> — ${escapeEvalHarnessV4Html(dashboard.gateReason)}</p>
<h2>Suite</h2>
<p>Xu thế: ${trendArrow(dashboard.suite.direction)} ${dashboard.suite.direction} &middot; Pass rate trung bình: ${formatPct(dashboard.suite.meanPassRate)} (mới nhất: ${formatPct(dashboard.suite.latestPassRate)}) &middot; Mean reward trung bình: ${formatReward(dashboard.suite.meanReward)} (mới nhất: ${formatReward(dashboard.suite.latestMeanReward)})</p>
<div class="bars">${suiteBars}</div>
<h2>Hồi quy (run mới nhất so với baseline)</h2>
<ul>${regressionItems}</ul>
<h2>Cải thiện</h2>
<ul>${improvementItems}</ul>
<h2>Task</h2>
<table>
<thead><tr><th>Task</th><th>Runs</th><th>Pass rate</th><th>Mean reward</th><th>Gần nhất</th><th>Xu thế</th><th>Flaky</th><th>Fail liên tiếp</th></tr></thead>
<tbody>
${taskRows}
</tbody>
</table>
<p class="meta">Fail liên tục: ${dashboard.alwaysFailingTasks.length > 0 ? escapeEvalHarnessV4Html(dashboard.alwaysFailingTasks.join(', ')) : 'không có'} &middot; Flaky: ${dashboard.flakyTasks.length > 0 ? escapeEvalHarnessV4Html(dashboard.flakyTasks.join(', ')) : 'không có'}</p>
</body>
</html>
`;
}

/**
 * Eval report rendering (v1.05, Team T6) — biến báo cáo eval memory
 * thành văn bản đọc được (Markdown) và tóm tắt xu hướng lịch sử.
 *
 * Pure, không ghi file: caller (tool/UI) tự quyết định lưu ở đâu.
 * Dùng để dán vào chat, ghi vào file, hoặc hiển thị trong UI mà
 * không cần render bảng.
 */

import type { EvalComparison, MemoryEvalReport, RegressionAlert } from './index';

function pct(value: number | null): string {
  if (value === null) return '—';
  return `${(value * 100).toFixed(1)}%`;
}

function signed(value: number): string {
  return `${value >= 0 ? '+' : ''}${(value * 100).toFixed(1)}pp`;
}

function categoryRow(category: string, f1: number, recall: number, precision: number, temporal: number | null, hops: number | null, judge: number, count: number): string {
  return `| ${category} (${count}) | ${pct(f1)} | ${pct(recall)} | ${pct(precision)} | ${pct(temporal)} | ${pct(hops)} | ${pct(judge)} |`;
}

/** Render một báo cáo eval thành Markdown. */
export function renderMemoryEvalReportMarkdown(report: MemoryEvalReport): string {
  const lines: string[] = [
    `# Memory eval report — ${report.datasetId} (v${report.datasetVersion})`,
    '',
    `- Retriever: ${report.retrieverName} (${report.retrieverVersion})`,
    `- Run at: ${new Date(report.at).toISOString()}`,
    `- TopK: ${report.topK}`,
    '',
    '## Overall',
    '',
    '| Category | F1 | Recall | Precision | Temporal | Multi-hop | Judge |',
    '|---|---:|---:|---:|---:|---:|---:|',
    ...report.byCategory.map((c) =>
      categoryRow(c.category, c.f1, c.recall, c.precision, c.temporalAccuracy, c.multiHopScore, c.judgeScore, c.count),
    ),
    categoryRow('overall', report.overall.f1, report.overall.recall, report.overall.precision, report.overall.temporalAccuracy, report.overall.multiHopScore, report.overall.judgeScore, report.overall.count),
    '',
    '## Per-question detail',
    '',
    '| Question | Category | F1 | Recall | Temporal | Multi-hop | Judge | Retrieved expected |',
    '|---|---|---:|---:|---:|---:|---:|---|',
  ];
  for (const q of report.perQuestion) {
    lines.push(
      `| ${q.questionId} | ${q.category} | ${pct(q.f1)} | ${pct(q.recall)} | ${pct(q.temporalAccuracy)} | ${pct(q.multiHopScore)} | ${pct(q.judgeScore)} | ${q.retrievedExpectedIds.join(', ') || '—'} |`,
    );
  }
  return `${lines.join('\n')}\n`;
}

/** Render một so sánh baseline vs hiện tại thành Markdown. */
export function renderEvalComparisonMarkdown(comparison: EvalComparison): string {
  const lines: string[] = [
    '# Memory eval comparison',
    '',
    `- Baseline: ${comparison.baseline.retrieverVersion} (${new Date(comparison.baseline.at).toISOString()})`,
    `- Current: ${comparison.current.retrieverVersion} (${new Date(comparison.current.at).toISOString()})`,
    `- Questions: ${comparison.questionMoves.improved} improved, ${comparison.questionMoves.worsened} worsened, ${comparison.questionMoves.unchanged} unchanged`,
    '',
    '## Overall deltas (current − baseline, percentage points)',
    '',
    '| Metric | Delta |',
    '|---|---:|',
    `| F1 | ${signed(comparison.overallDelta.f1)} |`,
    `| Recall | ${signed(comparison.overallDelta.recall)} |`,
    `| Precision | ${signed(comparison.overallDelta.precision)} |`,
    `| Temporal accuracy | ${comparison.overallDelta.temporalAccuracy === null ? '—' : signed(comparison.overallDelta.temporalAccuracy)} |`,
    `| Multi-hop score | ${comparison.overallDelta.multiHopScore === null ? '—' : signed(comparison.overallDelta.multiHopScore)} |`,
    `| Judge score | ${signed(comparison.overallDelta.judgeScore)} |`,
    '',
    '## Per-category F1 deltas',
    '',
    '| Category | F1 delta | Recall delta |',
    '|---|---:|---:|',
  ];
  for (const c of comparison.byCategoryDelta) {
    lines.push(`| ${c.category} | ${signed(c.f1)} | ${signed(c.recall)} |`);
  }
  return `${lines.join('\n')}\n`;
}

/** Render danh sách regression alert thành Markdown (rỗng = "no regression"). */
export function renderRegressionAlertsMarkdown(alerts: readonly RegressionAlert[]): string {
  if (alerts.length === 0) return 'No regression alerts.\n';
  const lines = ['# Regression alerts', ''];
  for (const alert of alerts) {
    lines.push(`- ${alert.message}`);
  }
  return `${lines.join('\n')}\n`;
}

/** Xu hướng lịch sử: độ dốc F1 tổng qua các lần chạy + chạy tốt nhất/tệ nhất. */
export interface EvalHistoryTrend {
  runs: number;
  /** Độ dốc F1 (điểm/run, hồi quy tuyến tính đơn giản). Dương = đang cải thiện. */
  f1SlopePerRun: number;
  bestRun: { retrieverVersion: string; at: number; f1: number } | null;
  worstRun: { retrieverVersion: string; at: number; f1: number } | null;
  latestF1: number | null;
  firstF1: number | null;
}

/** Tóm tắt xu hướng từ lịch sử chạy (cùng dataset; khác dataset bị bỏ qua). */
export function summarizeEvalHistory(history: readonly MemoryEvalReport[]): EvalHistoryTrend {
  if (history.length === 0) {
    return { runs: 0, f1SlopePerRun: 0, bestRun: null, worstRun: null, latestF1: null, firstF1: null };
  }
  const sorted = [...history].sort((a, b) => a.at - b.at);
  const datasetId = sorted[sorted.length - 1].datasetId;
  const same = sorted.filter((r) => r.datasetId === datasetId);
  const n = same.length;
  const xs = same.map((_, i) => i);
  const ys = same.map((r) => r.overall.f1);
  const meanX = xs.reduce((s, x) => s + x, 0) / n;
  const meanY = ys.reduce((s, y) => s + y, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i] - meanX) * (ys[i] - meanY);
    den += (xs[i] - meanX) ** 2;
  }
  const slope = den === 0 ? 0 : num / den;
  let best = same[0];
  let worst = same[0];
  for (const r of same) {
    if (r.overall.f1 > best.overall.f1) best = r;
    if (r.overall.f1 < worst.overall.f1) worst = r;
  }
  return {
    runs: n,
    f1SlopePerRun: slope,
    bestRun: { retrieverVersion: best.retrieverVersion, at: best.at, f1: best.overall.f1 },
    worstRun: { retrieverVersion: worst.retrieverVersion, at: worst.at, f1: worst.overall.f1 },
    latestF1: same[n - 1].overall.f1,
    firstF1: same[0].overall.f1,
  };
}

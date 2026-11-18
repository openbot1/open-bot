/**
 * Coding agent v11 — render báo cáo (text ngắn cho log/UI).
 */

import type { V11AgentReport, V11CallGraphData, V11PatchReview } from './types';
import { renderV11PatchReviewSummary } from './patchReview';

/** Định dạng thời gian ms thành chuỗi ngắn (vd `1.2s`, `350ms`). */
export function v11FormatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/** Tóm tắt call graph v11 thành text ngắn. */
export function renderV11CallGraphSummary(graph: V11CallGraphData): string {
  const topFiles = graph.files.slice(0, 5).map((f) => `${f.path} (${f.pageRank.toFixed(4)})`).join(', ');
  const topSymbols = graph.symbols.slice(0, 5).map((s) => `${s.qualifiedName} (${s.pageRank.toFixed(4)})`).join(', ');
  return [
    `Call graph v11: ${graph.stats.files} files, ${graph.stats.symbols} symbols, ${graph.stats.resolvedEdges} cạnh call đã resolve, ${graph.stats.unresolvedCalls} chưa resolve, ${graph.stats.cyclicComponents} chu trình.`,
    `Top files: ${topFiles || '(none)'}.`,
    `Top symbols: ${topSymbols || '(none)'}.`,
  ].join('\n');
}

/** Tóm tắt patch review thành text ngắn (dùng lại renderer của patchReview). */
export function renderV11PatchReviewText(review: V11PatchReview): string {
  return renderV11PatchReviewSummary(review);
}

/** Render báo cáo agent v11 đầy đủ thành text. */
export function renderV11AgentReport(report: V11AgentReport): string {
  const lines = [
    `Agent v11: ${report.title} — ${report.ok ? 'OK' : 'FAILED'} (${v11FormatDuration(report.totalDurationMs)})`,
  ];
  for (const step of report.steps) {
    lines.push(`  [${step.status}] ${step.name}: ${step.detail} (${v11FormatDuration(step.durationMs)})`);
  }
  if (report.codeAct) {
    lines.push(
      `  CodeAct v9: ${report.codeAct.okCount} ok / ${report.codeAct.failedCount} failed / ${report.codeAct.skippedCount} skipped (dry-run: ${report.codeAct.dryRun ? 'yes' : 'no'}).`,
    );
  }
  if (report.refactorResult) {
    lines.push(
      `  Refactor: ${report.refactorResult.kind} ${report.refactorResult.ok ? 'ok' : 'failed'} — ${report.refactorResult.filesChanged.join(', ') || '(no files)'}.`,
    );
  }
  if (report.patchReview) {
    lines.push(`  ${renderV11PatchReviewSummary(report.patchReview).replace(/\n/g, '\n  ')}`);
  }
  if (report.testGen && report.testGenRun) {
    lines.push(
      `  Testgen v2: ${report.testGen.generated.length} file test, ${report.testGen.functionsCovered}/${report.testGen.functionsConsidered} function — chạy ${report.testGenRun.filesPassed} pass / ${report.testGenRun.filesFailed} fail.`,
    );
  }
  if (report.commitSha) lines.push(`  Commit: ${report.commitSha.slice(0, 7)}.`);
  if (report.combinedDiff.trim() !== '') {
    lines.push(`  Diff: ${report.combinedDiff.split('\n').length} dòng.`);
  }
  return lines.join('\n');
}

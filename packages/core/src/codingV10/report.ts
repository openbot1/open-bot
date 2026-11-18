/**
 * Coding agent v10 — report rendering (text, để host/UI hiển thị).
 */

import { v10FormatDuration, v10FormatPercent } from './reportUtil';
import type { V10AgentReport, V10RepoMapRender, V10SessionState } from './types';

export { v10FormatDuration, v10FormatPercent };

/** Render tóm tắt trạng thái phiên thành text. */
export function renderV10SessionReport(state: V10SessionState): string {
  const lines = [
    `session ${state.sessionId} — ${state.title}`,
    `status: ${state.status} | events: ${state.eventCount} (actions ${state.actionCount}, observations ${state.observationCount})`,
    `working dir: ${state.workingDir}`,
    `files changed: ${state.filesChanged.join(', ') || '(none)'}`,
    `commits: ${state.commits.join(', ') || '(none)'}`,
    `codeact: ${state.codeActPassed}/${state.codeActRuns} passed | verify rounds: ${state.verifyRounds} (${state.verifyPassed} passed)`,
    `pause/resume: ${state.pauseCount}/${state.resumeCount}`,
  ];
  if (state.parentSessionId) lines.push(`forked from ${state.parentSessionId} @seq ${state.forkFromSeq ?? '?'}`);
  if (state.lastError) lines.push(`last error: ${state.lastError}`);
  if (state.startedAt) lines.push(`started: ${state.startedAt}${state.endedAt ? ` | ended: ${state.endedAt}` : ''}`);
  return lines.join('\n');
}

/** Render kết quả render repo map (đã nén theo ngân sách). */
export function renderV10RepoMapSummary(render: V10RepoMapRender): string {
  return [
    `repo map: ${render.filesKept}/${render.filesTotal} files, ${render.symbolsKept}/${render.symbolsTotal} symbols kept`,
    `tokens: ~${render.tokenEstimate} / budget ${render.budget}${render.compressed ? ' (compressed)' : ''}`,
    render.text,
  ].join('\n');
}

/** Render báo cáo agent v10 thành text. */
export function renderV10AgentReport(report: V10AgentReport): string {
  const lines = [
    `coding agent v10 — ${report.title}`,
    `session: ${report.sessionId} | ok: ${report.ok ? 'yes' : 'no'} | ${v10FormatDuration(report.totalDurationMs)}`,
    `steps:`,
  ];
  for (const step of report.steps) {
    lines.push(`  [${step.status}] ${step.name}: ${step.detail} (${step.durationMs}ms)`);
  }
  lines.push(`edits: ${report.edits.length}`);
  for (const edit of report.edits) {
    lines.push(
      `  ${edit.strategy} ${edit.path} (+${edit.linesAdded}/-${edit.linesRemoved}) score ${edit.score}${edit.usedFallback ? ' [fallback]' : ''}${edit.commitSha ? ` commit ${edit.commitSha}` : ''}`,
    );
  }
  if (report.codeActResults.length > 0) {
    lines.push(`codeact runs: ${report.codeActResults.length}`);
    for (const r of report.codeActResults) {
      lines.push(`  ${r.kind}: ${r.status} exit ${r.exitCode ?? 'n/a'} (${r.durationMs}ms)`);
    }
  }
  if (report.loop) {
    lines.push(`verify loop: ${report.loop.passed ? 'passed' : 'failed'} after ${report.loop.roundsUsed} round(s) (${report.loop.stopReason})`);
  }
  if (report.commit) {
    lines.push(`commit: ${report.commit.shortSha} (+${report.commit.totalAdded}/-${report.commit.totalRemoved})`);
  }
  if (report.snapshot) {
    lines.push(`snapshot: seq ${report.snapshot.atSeq} digest ${report.snapshot.stateDigest.slice(0, 12)}…`);
  }
  return lines.join('\n');
}

/** Tóm tắt một dòng về eval version (dùng trong bảng so sánh). */
export function v10SummarizeEvalVersion(passAtK: number, tasksPassed: number, taskCount: number): string {
  return `pass@k ${v10FormatPercent(passAtK)} (${tasksPassed}/${taskCount} tasks)`;
}

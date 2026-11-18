/**
 * Render báo cáo markdown cho coding agent v9 (v1.17, Đội T4).
 *
 * Host/UI cần một bản tóm tắt đọc được cho con người sau mỗi task:
 * vòng lặp nào đã chạy, edit nào đã áp, commit nào đã tạo, eval đạt
 * bao nhiêu. Module này chỉ render text từ các report đã có (không
 * chạy thêm gì, không gọi model) — dùng cho log, PR body, panel UI.
 */

import type {
  V9AgentReport,
  V9AtomicCommit,
  V9DraftPr,
  V9EditResult,
  V9EvalReport,
  V9LoopResult,
} from './types';

/** Định dạng ms thành chuỗi đọc được (vd `1.2s`, `3m 04s`). */
export function v9FormatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.floor(seconds % 60);
  return `${minutes}m ${String(rest).padStart(2, '0')}s`;
}

/** Định dạng tỉ lệ thành phần trăm (1 chữ số thập phân). */
export function v9FormatPercent(ratio: number): string {
  return `${(ratio * 100).toFixed(1)}%`;
}

/** Một dòng tóm tắt cho một edit (dùng trong report + log). */
export function v9SummarizeEdit(edit: V9EditResult): string {
  const fallback = edit.usedFallback ? ' [fallback search-replace]' : '';
  return (
    `${edit.appliedKind} ${edit.path}` +
    `${edit.symbolName ? `:${edit.symbolName}` : ''} ` +
    `(+${edit.linesAdded}/-${edit.linesRemoved}, lines ${edit.startLine}-${edit.endLine})${fallback}`
  );
}

/** Render kết quả một vòng sandbox loop thành markdown. */
export function renderV9LoopReport(loop: V9LoopResult): string {
  const lines: string[] = [];
  lines.push('## Sandbox loop');
  lines.push('');
  lines.push(
    `- Result: **${loop.passed ? 'passed' : 'failed'}** (${loop.stopReason}) after ` +
      `${loop.roundsUsed}/${loop.maxRounds} round(s) in ${v9FormatDuration(loop.totalDurationMs)}.`,
  );
  lines.push(`- Total lines changed: ${loop.totalLinesChanged}.`);
  lines.push('');
  lines.push('| Round | Note | Verify | Duration |');
  lines.push('| ----- | ---- | ------ | -------- |');
  for (const round of loop.rounds) {
    const failedCmds = round.commands.filter((c) => c.status !== 'ok');
    const verify =
      round.commands.length === 0
        ? '—'
        : round.passed
          ? `pass (${round.commands.length} cmd${round.commands.length > 1 ? 's' : ''})`
          : `fail (${failedCmds.map((c) => c.argv[0]).join(', ')})`;
    lines.push(`| ${round.round} | ${round.note} | ${verify} | ${v9FormatDuration(round.durationMs)} |`);
  }
  const lastFailed = [...loop.rounds].reverse().find((r) => !r.passed);
  if (lastFailed && lastFailed.failureExcerpt) {
    lines.push('');
    lines.push('### Last failure excerpt');
    lines.push('');
    lines.push('```');
    lines.push(lastFailed.failureExcerpt.slice(0, 2000));
    lines.push('```');
  }
  return lines.join('\n');
}

/** Render một commit atomic thành một dòng markdown. */
export function renderV9CommitLine(commit: V9AtomicCommit): string {
  return (
    `Commit \`${commit.shortSha}\`: ${commit.files.length} file(s), ` +
    `+${commit.totalAdded}/-${commit.totalRemoved}.`
  );
}

/** Render draft-PR description thành markdown (title + body). */
export function renderV9DraftPr(pr: V9DraftPr): string {
  const lines: string[] = [];
  lines.push(`# ${pr.title}`);
  lines.push('');
  lines.push(`Base: \`${pr.baseBranch}\` ← head: \`${pr.headBranch}\` (${pr.commitCount} commit(s)).`);
  lines.push('');
  lines.push(pr.body);
  return lines.join('\n');
}

/**
 * Render báo cáo đầy đủ của một task agent v9: tiêu đề, trạng thái,
 * các bước, edit, sandbox loop, commit, draft-PR.
 */
export function renderV9AgentReport(report: V9AgentReport): string {
  const lines: string[] = [];
  lines.push(`# Coding agent v9: ${report.title}`);
  lines.push('');
  lines.push(`- Task: ${report.task}`);
  lines.push(`- Result: **${report.ok ? 'done' : 'failed'}** in ${v9FormatDuration(report.totalDurationMs)}.`);
  lines.push('');
  lines.push('## Steps');
  lines.push('');
  lines.push('| Step | Status | Detail | Duration |');
  lines.push('| ---- | ------ | ------ | -------- |');
  for (const step of report.steps) {
    lines.push(`| ${step.name} | ${step.status} | ${step.detail} | ${v9FormatDuration(step.durationMs)} |`);
  }
  lines.push('');
  if (report.edits.length > 0) {
    lines.push('## Edits');
    lines.push('');
    for (const edit of report.edits) {
      lines.push(`- ${v9SummarizeEdit(edit)}`);
    }
    lines.push('');
  }
  if (report.loop) {
    lines.push(renderV9LoopReport(report.loop));
    lines.push('');
  }
  if (report.commit) {
    lines.push('## Commit');
    lines.push('');
    lines.push(`- ${renderV9CommitLine(report.commit)}`);
    lines.push('');
    lines.push('```');
    lines.push(report.commit.message);
    lines.push('```');
    lines.push('');
  }
  if (report.draftPr) {
    lines.push('## Draft PR');
    lines.push('');
    lines.push(renderV9DraftPr(report.draftPr));
    lines.push('');
  }
  if (report.combinedDiff) {
    lines.push('## Combined diff');
    lines.push('');
    lines.push('```diff');
    lines.push(report.combinedDiff.slice(0, 8000));
    lines.push('```');
  }
  return lines.join('\n');
}

/**
 * Render báo cáo eval thành một dòng tóm tắt (dùng cho commit
 * message footer / log một dòng).
 */
export function v9SummarizeEvalReport(report: V9EvalReport): string {
  return (
    `Eval ${report.suiteName}: pass@${report.attemptsPerTask} ` +
    `${report.tasksPassed}/${report.taskCount} (${v9FormatPercent(report.passAtK)}), ` +
    `attempt rate ${v9FormatPercent(report.attemptPassRate)}, ` +
    `avg ${report.avgRounds.toFixed(2)} rounds, ${report.avgTokens.toFixed(0)} tokens/attempt, ` +
    `${v9FormatDuration(report.totalDurationMs)}.`
  );
}

/**
 * Báo cáo tổng hợp cho Harbor eval (v1.11, Đội T2).
 *
 * Gom nhiều HarborRunResult (có thể từ nhiều lần chạy suite khác
 * nhau) thành một báo cáo duy nhất: pass rate, reward trung bình,
 * thời gian, token — theo task, theo profile, theo model. Render
 * Markdown để UI/CLI hiển thị và để user dán vào issue/PR.
 *
 * Báo cáo này chỉ tổng hợp số liệu đã có — không chạy lại task,
 * không gọi model, không chạm mạng.
 */

import type { HarborRunResult, HarborSuiteResult } from './harborRunner';

/** Thống kê cho một task (gom từ nhiều rollout của cùng task). */
export interface HarborTaskSummary {
  taskId: string;
  runs: number;
  passed: number;
  passRate: number;
  meanReward: number;
  bestReward: number;
  meanDurationMs: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
}

/** Thống kê cho một profile (gom từ nhiều rollout dùng cùng profile). */
export interface HarborProfileSummary {
  profileId: string;
  runs: number;
  passed: number;
  passRate: number;
  meanReward: number;
}

/** Báo cáo tổng hợp Harbor eval. */
export interface HarborAggregateReport {
  /** Số rollout đã gom. */
  runs: number;
  passed: number;
  failed: number;
  passRate: number;
  meanReward: number;
  totalDurationMs: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalTokens: number;
  byTask: HarborTaskSummary[];
  byProfile: HarborProfileSummary[];
  /** Rollout tệ nhất (reward thấp nhất) — để user xem trước khi debug. */
  worstRuns: { rolloutId: string; taskId: string; reward: number; error: string | null }[];
  createdAt: number;
}

function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/** Gom các kết quả chạy thành báo cáo tổng hợp. */
export function aggregateHarborResults(results: readonly HarborRunResult[]): HarborAggregateReport {
  const byTaskMap = new Map<string, HarborRunResult[]>();
  const byProfileMap = new Map<string, HarborRunResult[]>();
  for (const result of results) {
    const taskList = byTaskMap.get(result.taskId) ?? [];
    taskList.push(result);
    byTaskMap.set(result.taskId, taskList);
    const profileList = byProfileMap.get(result.profileId) ?? [];
    profileList.push(result);
    byProfileMap.set(result.profileId, profileList);
  }
  const byTask: HarborTaskSummary[] = [...byTaskMap.entries()]
    .map(([taskId, runs]) => ({
      taskId,
      runs: runs.length,
      passed: runs.filter((r) => r.passed).length,
      passRate: runs.length > 0 ? runs.filter((r) => r.passed).length / runs.length : 0,
      meanReward: mean(runs.map((r) => r.reward)),
      bestReward: runs.reduce((best, r) => Math.max(best, r.reward), 0),
      meanDurationMs: mean(runs.map((r) => r.durationMs)),
      totalPromptTokens: runs.reduce((sum, r) => sum + r.usage.promptTokens, 0),
      totalCompletionTokens: runs.reduce((sum, r) => sum + r.usage.completionTokens, 0),
    }))
    .sort((a, b) => a.taskId.localeCompare(b.taskId));
  const byProfile: HarborProfileSummary[] = [...byProfileMap.entries()]
    .map(([profileId, runs]) => ({
      profileId: profileId === '' ? '(no profile)' : profileId,
      runs: runs.length,
      passed: runs.filter((r) => r.passed).length,
      passRate: runs.length > 0 ? runs.filter((r) => r.passed).length / runs.length : 0,
      meanReward: mean(runs.map((r) => r.reward)),
    }))
    .sort((a, b) => b.meanReward - a.meanReward);
  const passed = results.filter((r) => r.passed).length;
  const worstRuns = [...results]
    .sort((a, b) => a.reward - b.reward)
    .slice(0, 5)
    .map((r) => ({ rolloutId: r.rolloutId, taskId: r.taskId, reward: r.reward, error: r.error }));
  return {
    runs: results.length,
    passed,
    failed: results.length - passed,
    passRate: results.length > 0 ? passed / results.length : 0,
    meanReward: mean(results.map((r) => r.reward)),
    totalDurationMs: results.reduce((sum, r) => sum + r.durationMs, 0),
    totalPromptTokens: results.reduce((sum, r) => sum + r.usage.promptTokens, 0),
    totalCompletionTokens: results.reduce((sum, r) => sum + r.usage.completionTokens, 0),
    totalTokens: results.reduce((sum, r) => sum + r.usage.totalTokens, 0),
    byTask,
    byProfile,
    worstRuns,
    createdAt: Date.now(),
  };
}

/** Gom một HarborSuiteResult thành aggregate (tiện cho tool/UI). */
export function aggregateHarborSuite(suite: HarborSuiteResult): HarborAggregateReport {
  return aggregateHarborResults(suite.results);
}

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/** Render báo cáo tổng hợp thành Markdown (dán được vào issue/PR). */
export function renderHarborReportMarkdown(report: HarborAggregateReport): string {
  const lines: string[] = [];
  lines.push('# Harbor eval report');
  lines.push('');
  lines.push(`- Runs: ${report.runs} (passed ${report.passed}, failed ${report.failed})`);
  lines.push(`- Pass rate: ${percent(report.passRate)}`);
  lines.push(`- Mean reward: ${report.meanReward.toFixed(3)}`);
  lines.push(`- Total time: ${formatMs(report.totalDurationMs)}`);
  lines.push(`- Total tokens: ${report.totalTokens} (prompt ${report.totalPromptTokens}, completion ${report.totalCompletionTokens})`);
  lines.push('');
  if (report.byTask.length > 0) {
    lines.push('## By task');
    lines.push('');
    lines.push('| Task | Runs | Pass rate | Mean reward | Best | Mean time |');
    lines.push('| --- | ---: | ---: | ---: | ---: | ---: |');
    for (const task of report.byTask) {
      lines.push(
        `| ${task.taskId} | ${task.runs} | ${percent(task.passRate)} | ${task.meanReward.toFixed(3)} | ${task.bestReward.toFixed(3)} | ${formatMs(task.meanDurationMs)} |`,
      );
    }
    lines.push('');
  }
  if (report.byProfile.length > 0) {
    lines.push('## By profile');
    lines.push('');
    lines.push('| Profile | Runs | Pass rate | Mean reward |');
    lines.push('| --- | ---: | ---: | ---: |');
    for (const profile of report.byProfile) {
      lines.push(`| ${profile.profileId} | ${profile.runs} | ${percent(profile.passRate)} | ${profile.meanReward.toFixed(3)} |`);
    }
    lines.push('');
  }
  if (report.worstRuns.length > 0) {
    lines.push('## Worst runs');
    lines.push('');
    for (const run of report.worstRuns) {
      lines.push(`- ${run.taskId} (${run.rolloutId}): reward ${run.reward.toFixed(3)}${run.error ? ` — ${run.error}` : ''}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

/** Render một lần chạy task thành một dòng tóm tắt (log/CLI). */
export function formatHarborRunSummary(result: HarborRunResult): string {
  const status = result.passed ? 'PASS' : result.error !== null ? 'ERROR' : 'FAIL';
  const tests = `${result.testRun.passedCount}/${result.testRun.totalCount} tests`;
  return (
    `[${status}] ${result.taskId} reward=${result.reward.toFixed(3)} (${tests}) ` +
    `${formatMs(result.durationMs)} ${result.usage.totalTokens} tokens isolation=${result.isolation}` +
    (result.error ? ` error=${result.error}` : '')
  );
}

/** Render kết quả suite thành text ngắn (log/CLI). */
export function formatHarborSuiteSummary(suite: HarborSuiteResult): string {
  const lines: string[] = [];
  lines.push(
    `Harbor suite: ${suite.passed}/${suite.results.length} passed ` +
      `(pass rate ${percent(suite.passRate)}, mean reward ${suite.meanReward.toFixed(3)}) ` +
      `in ${formatMs(suite.durationMs)}, ${suite.totalPromptTokens + suite.totalCompletionTokens} tokens.`,
  );
  for (const result of suite.results) lines.push(`  ${formatHarborRunSummary(result)}`);
  return lines.join('\n');
}

/**
 * Coding agent v10 — eval harness mở rộng (theo phiên bản agent).
 *
 * Nối harness v9 (chạy task mẫu kiểu SWE-bench qua harness chấm
 * patch của v5, đo pass@k, lưu/so sánh báo cáo theo LẦN CHẠY): v10
 * giữ nguyên cách chấm điểm, thêm 2 thứ:
 *
 * 1. Task mẫu nội bộ mới: 3 task (dedupe / capitalize / max) cộng
 *    với 3 task mẫu của v9 thành suite 6 task `coding-v10-sample`;
 *    agent mẫu scripted sửa đúng 5/6 (cố tình sai task sort như v9
 *    để demo pass@k < 100%).
 * 2. Lưu kết quả THEO PHIÊN BẢN agent: mỗi phiên bản (`v9`, `v10`,
 *    `scripted-v10`, ...) có thư mục riêng; bảng so sánh liệt kê
 *    pass@k từng phiên bản + delta giữa hai phiên bản, để thấy
 *    agent tiến bộ hay thụt lùi qua các version — v9 chỉ so sánh
 *    hai lần chạy, không gắn version.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { CodingV5SweTask } from '../codingV5/sweBenchEval';
import {
  V9_EVAL_SAMPLE_TASKS,
  compareV9EvalReports,
  loadV9EvalReport,
  runV9EvalSuite,
  scriptedV9Agent,
} from '../codingV9/evalHarness';
import type { V9EvalAgentFn, V9EvalRunOptions } from '../codingV9/evalHarness';
import type { V9EvalReport } from '../codingV9/types';
import { CodingV10Error } from './types';
import type { V10EvalVersionComparison, V10EvalVersionRow, V10VersionedEvalReport } from './types';

/** Tên suite eval v10 (6 task: 3 của v9 + 3 mới). */
export const V10_EVAL_SUITE_NAME = 'coding-v10-sample';
/** Số attempt mặc định mỗi task (k của pass@k). */
export const V10_EVAL_DEFAULT_ATTEMPTS = 3;
/** Phiên bản agent mặc định cho suite v10. */
export const V10_EVAL_DEFAULT_AGENT_VERSION = 'v10';

/* ------------------------- task mẫu mới ------------------------- */

const SAMPLE_DEDUPE_FIXTURE = `export function dedupe(values) {
  return values;
}

export function first(values) {
  return values[0];
}
`;

const SAMPLE_DEDUPE_TEST = `import { dedupe } from './util.mjs';
import assert from 'node:assert/strict';
assert.deepEqual(dedupe([1, 2, 2, 3, 1]), [1, 2, 3]);
assert.deepEqual(dedupe([]), []);
`;

const SAMPLE_DEDUPE_PASSTO_PASS = `import { first } from './util.mjs';
import assert from 'node:assert/strict';
assert.equal(first([9, 8]), 9);
`;

const SAMPLE_CAPITALIZE_FIXTURE = `export function capitalize(word) {
  return word;
}

export function lower(word) {
  return word.toLowerCase();
}
`;

const SAMPLE_CAPITALIZE_TEST = `import { capitalize } from './util.mjs';
import assert from 'node:assert/strict';
assert.equal(capitalize('an'), 'An');
assert.equal(capitalize('binh'), 'Binh');
`;

const SAMPLE_CAPITALIZE_PASSTO_PASS = `import { lower } from './util.mjs';
import assert from 'node:assert/strict';
assert.equal(lower('ABC'), 'abc');
`;

const SAMPLE_MAX_FIXTURE = `export function maxOf(values) {
  return values[0];
}

export function minOf(values) {
  return Math.min(...values);
}
`;

const SAMPLE_MAX_TEST = `import { maxOf } from './util.mjs';
import assert from 'node:assert/strict';
assert.equal(maxOf([1, 9, 3]), 9);
assert.equal(maxOf([-5, -1]), -1);
`;

const SAMPLE_MAX_PASSTO_PASS = `import { minOf } from './util.mjs';
import assert from 'node:assert/strict';
assert.equal(minOf([1, 9, 3]), 1);
`;

function v10Task(
  id: string,
  title: string,
  issue: string,
  fixture: string,
  failTest: string,
  passTest: string,
): CodingV5SweTask {
  return {
    id,
    title,
    issue,
    fixtures: { 'util.mjs': fixture, 'test-fail.mjs': failTest, 'test-pass.mjs': passTest },
    patch: '',
    testCommands: [
      { name: 'fail-to-pass', argv: ['node', 'test-fail.mjs'] },
      { name: 'pass-to-pass', argv: ['node', 'test-pass.mjs'] },
    ],
    failToPass: ['fail-to-pass'],
    passToPass: ['pass-to-pass'],
    timeoutMs: 10_000,
  };
}

/** 3 task mẫu mới của v10. */
export const V10_EVAL_NEW_TASKS: CodingV5SweTask[] = [
  v10Task(
    'v10-eval-dedupe',
    'Fix dedupe() returning the input unchanged instead of removing duplicates',
    'dedupe([1, 2, 2, 3, 1]) should return [1, 2, 3] but returns the input unchanged. Fix dedupe in util.mjs.',
    SAMPLE_DEDUPE_FIXTURE,
    SAMPLE_DEDUPE_TEST,
    SAMPLE_DEDUPE_PASSTO_PASS,
  ),
  v10Task(
    'v10-eval-capitalize',
    'Fix capitalize() returning the word unchanged instead of uppercasing the first letter',
    "capitalize('an') should return 'An' but returns 'an'. Fix capitalize in util.mjs.",
    SAMPLE_CAPITALIZE_FIXTURE,
    SAMPLE_CAPITALIZE_TEST,
    SAMPLE_CAPITALIZE_PASSTO_PASS,
  ),
  v10Task(
    'v10-eval-max',
    'Fix maxOf() returning the first element instead of the maximum',
    'maxOf([1, 9, 3]) should return 9 but returns 1. Fix maxOf in util.mjs.',
    SAMPLE_MAX_FIXTURE,
    SAMPLE_MAX_TEST,
    SAMPLE_MAX_PASSTO_PASS,
  ),
];

/** Toàn bộ suite v10: 3 task v9 + 3 task mới. */
export const V10_EVAL_SAMPLE_TASKS: CodingV5SweTask[] = [...V9_EVAL_SAMPLE_TASKS, ...V10_EVAL_NEW_TASKS];

/** Patch đúng cho task dedupe. */
export const V10_SAMPLE_PATCH_DEDUPE = `--- a/util.mjs
+++ b/util.mjs
@@ -1,3 +1,3 @@
 export function dedupe(values) {
-  return values;
+  return [...new Set(values)];
 }
`;

/** Patch đúng cho task capitalize. */
export const V10_SAMPLE_PATCH_CAPITALIZE = `--- a/util.mjs
+++ b/util.mjs
@@ -1,3 +1,3 @@
 export function capitalize(word) {
-  return word;
+  return word.charAt(0).toUpperCase() + word.slice(1);
 }
`;

/** Patch đúng cho task max. */
export const V10_SAMPLE_PATCH_MAX = `--- a/util.mjs
+++ b/util.mjs
@@ -1,3 +1,3 @@
 export function maxOf(values) {
-  return values[0];
+  return Math.max(...values);
 }
`;

/**
 * Agent mẫu scripted v10: sửa đúng 5/6 task (add, greet, dedupe,
 * capitalize, max); cố tình sai task sort (kế thừa patch sai của v9)
 * để demo pass@k = 5/6 < 100%.
 */
export const scriptedV10Agent: V9EvalAgentFn = (task, attempt) => {
  void attempt;
  if (task.id === 'v10-eval-dedupe') {
    return { patch: V10_SAMPLE_PATCH_DEDUPE, roundsUsed: 1, model: 'scripted-v10' };
  }
  if (task.id === 'v10-eval-capitalize') {
    return { patch: V10_SAMPLE_PATCH_CAPITALIZE, roundsUsed: 1, model: 'scripted-v10' };
  }
  if (task.id === 'v10-eval-max') {
    return { patch: V10_SAMPLE_PATCH_MAX, roundsUsed: 1, model: 'scripted-v10' };
  }
  return scriptedV9Agent(task, attempt);
};

/* ------------------------- chạy suite ------------------------- */

export interface V10EvalSuiteOptions extends V9EvalRunOptions {
  /** Phiên bản agent chạy suite (ghi vào báo cáo versioned). */
  agentVersion?: string;
}

/** Chạy suite v10 (6 task) với một agent, trả report v9 + version. */
export async function runV10EvalSuite(
  agentFn: V9EvalAgentFn,
  options: V10EvalSuiteOptions = {},
): Promise<{ report: V9EvalReport; agentVersion: string }> {
  const agentVersion = options.agentVersion ?? V10_EVAL_DEFAULT_AGENT_VERSION;
  const report = await runV9EvalSuite(V10_EVAL_SAMPLE_TASKS, agentFn, {
    ...options,
    suiteName: V10_EVAL_SUITE_NAME,
  });
  return { report, agentVersion };
}

/* ------------------- lưu trữ theo phiên bản ------------------- */

/** Tên thư mục version an toàn (tránh path traversal). */
export function v10SafeVersionName(agentVersion: string): string {
  const safe = agentVersion.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 64) || 'unknown';
  if (safe === '.' || safe === '..') return 'unknown';
  return safe;
}

/** Validate tên phiên bản agent (không rỗng, không chứa `/` hay `..`). */
export function validateV10AgentVersion(agentVersion: string): void {
  if (typeof agentVersion !== 'string' || agentVersion.trim() === '') {
    throw new CodingV10Error('eval-version-invalid', 'Agent version rỗng.');
  }
  if (agentVersion.includes('/') || agentVersion.includes('\\') || agentVersion.includes('..')) {
    throw new CodingV10Error('eval-version-invalid', `Agent version không hợp lệ: ${agentVersion}`);
  }
}

/**
 * Lưu báo cáo eval vào thư mục của phiên bản agent:
 * `<dir>/<version>/<suite>-<stamp>.json` (report v9 đầy đủ) +
 * `<dir>/<version>/summary.json` (bản tóm tắt versioned, ghi đè
 * mỗi lần chạy để `list` luôn thấy mới nhất).
 */
export function saveV10EvalReport(
  report: V9EvalReport,
  agentVersion: string,
  dir: string,
): { detailFile: string; summaryFile: string; summary: V10VersionedEvalReport } {
  validateV10AgentVersion(agentVersion);
  const versionDir = path.join(dir, v10SafeVersionName(agentVersion));
  fs.mkdirSync(versionDir, { recursive: true });
  const stamp = report.startedAt.replace(/[:.]/g, '-');
  const detailFile = path.join(versionDir, `${report.suiteName}-${stamp}.json`);
  fs.writeFileSync(detailFile, JSON.stringify(report, null, 2), 'utf8');
  const summary: V10VersionedEvalReport = {
    version: 1,
    agentVersion,
    suiteName: report.suiteName,
    passAtK: report.passAtK,
    attemptPassRate: report.attemptPassRate,
    avgRounds: report.avgRounds,
    avgTokens: report.avgTokens,
    taskCount: report.taskCount,
    tasksPassed: report.tasksPassed,
    attemptsPerTask: report.attemptsPerTask,
    startedAt: report.startedAt,
    finishedAt: report.finishedAt,
    detailFile: path.basename(detailFile),
  };
  const summaryFile = path.join(versionDir, 'summary.json');
  fs.writeFileSync(summaryFile, JSON.stringify(summary, null, 2), 'utf8');
  return { detailFile, summaryFile, summary };
}

/** Liệt kê các phiên bản agent đã có báo cáo trong dir. */
export function listV10EvalVersions(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .filter((name) => fs.existsSync(path.join(dir, name, 'summary.json')))
    .sort();
}

/** Đọc summary mới nhất của một phiên bản (null khi chưa có). */
export function loadV10EvalSummary(dir: string, agentVersion: string): V10VersionedEvalReport | null {
  const summaryFile = path.join(dir, v10SafeVersionName(agentVersion), 'summary.json');
  try {
    const data = JSON.parse(fs.readFileSync(summaryFile, 'utf8')) as V10VersionedEvalReport;
    if (!data || data.version !== 1 || typeof data.passAtK !== 'number') return null;
    return data;
  } catch {
    return null;
  }
}

/** Đọc report v9 đầy đủ mới nhất của một phiên bản (null khi chưa có). */
export function loadV10LatestDetailReport(dir: string, agentVersion: string): V9EvalReport | null {
  const summary = loadV10EvalSummary(dir, agentVersion);
  if (!summary) return null;
  const detailPath = path.join(dir, v10SafeVersionName(agentVersion), summary.detailFile);
  try {
    return loadV9EvalReport(detailPath);
  } catch {
    return null;
  }
}

/** Bảng so sánh pass@k của mọi phiên bản đã có báo cáo. */
export function v10EvalVersionTable(dir: string): V10EvalVersionRow[] {
  const versions = listV10EvalVersions(dir);
  const rows: V10EvalVersionRow[] = [];
  for (const version of versions) {
    const summary = loadV10EvalSummary(dir, version);
    if (!summary) continue;
    rows.push({
      agentVersion: version,
      passAtK: summary.passAtK,
      attemptPassRate: summary.attemptPassRate,
      avgRounds: summary.avgRounds,
      avgTokens: summary.avgTokens,
      taskCount: summary.taskCount,
      tasksPassed: summary.tasksPassed,
      best: false,
    });
  }
  if (rows.length === 0) return rows;
  let bestIdx = 0;
  for (let i = 1; i < rows.length; i += 1) {
    const row = rows[i] as V10EvalVersionRow;
    const best = rows[bestIdx] as V10EvalVersionRow;
    if (row.passAtK > best.passAtK || (row.passAtK === best.passAtK && row.attemptPassRate > best.attemptPassRate)) {
      bestIdx = i;
    }
  }
  (rows[bestIdx] as V10EvalVersionRow).best = true;
  return rows;
}

/** So sánh hai phiên bản agent (cũ vs mới) theo báo cáo mới nhất. */
export function compareV10EvalVersions(
  dir: string,
  olderVersion: string,
  newerVersion: string,
): V10EvalVersionComparison {
  const older = loadV10LatestDetailReport(dir, olderVersion);
  const newer = loadV10LatestDetailReport(dir, newerVersion);
  if (!older) {
    throw new CodingV10Error('eval-version-invalid', `Không có báo cáo eval cho phiên bản ${olderVersion}.`);
  }
  if (!newer) {
    throw new CodingV10Error('eval-version-invalid', `Không có báo cáo eval cho phiên bản ${newerVersion}.`);
  }
  const base = compareV9EvalReports(older, newer);
  return {
    olderVersion,
    newerVersion,
    passAtKDelta: base.passAtKDelta,
    attemptPassRateDelta: base.attemptPassRateDelta,
    avgRoundsDelta: base.avgRoundsDelta,
    avgTokensDelta: base.avgTokensDelta,
    changedTasks: base.changedTasks,
  };
}

/** Render bảng so sánh các phiên bản thành text. */
export function renderV10EvalVersionTable(rows: readonly V10EvalVersionRow[]): string {
  if (rows.length === 0) return 'No eval versions recorded yet.';
  const lines = ['agent version | pass@k | attempt pass rate | avg rounds | avg tokens | tasks passed'];
  for (const row of rows) {
    lines.push(
      `${row.agentVersion}${row.best ? ' (best)' : ''} | ${(row.passAtK * 100).toFixed(1)}% | ${(row.attemptPassRate * 100).toFixed(1)}% | ${row.avgRounds.toFixed(2)} | ${row.avgTokens.toFixed(0)} | ${row.tasksPassed}/${row.taskCount}`,
    );
  }
  return lines.join('\n');
}

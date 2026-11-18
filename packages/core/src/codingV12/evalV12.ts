/**
 * Coding agent v12 — eval v3 cho coding agent.
 *
 * Nối eval v11 (trọng số + partial credit, flaky, baseline
 * regression): v3 thêm 2 chiều chấm mới để đo chất lượng EDIT chứ
 * không chỉ đo test pass — đúng file và diff gọn — và chạy local
 * hoàn toàn trên repo tạm git thật. Module này làm 5 việc:
 *
 *   1. Chạy task: tạo repo tạm (git thật: init + commit fixture) →
 *      apply patch agent nộp bằng `git apply` → chạy từng test bằng
 *      argv (không shell, có timeout) → chấm theo exit code.
 *   2. Chấm 4 chiều (mỗi chiều 0..1):
 *      - fileAccuracy (đúng file): file sửa nằm trong expected,
 *        không chạm forbidden; sửa sai file / chạm file cấm thì trừ.
 *      - testScore: test pass có trọng số (fail-to-pass +
 *        pass-to-pass + lint).
 *      - noRegression: pass-to-pass vẫn pass (chiều riêng để
 *        regression không bị chìm trong điểm tổng).
 *      - diffEconomy (diff gọn): phạt diff quá lớn so với cần thiết
 *        — diff nhỏ, đúng chỗ thì điểm cao.
 *   3. Điểm tổng 0..100 (trọng số 25/40/20/15) + xếp loại
 *      excellent/good/fair/poor.
 *   4. Suite: nhiều task, nhiều attempt (best attempt), phát hiện
 *      flaky (chạy lặp, đổi trạng thái pass thì đánh dấu), lưu/đọc
 *      báo cáo, so sánh với baseline (regressions/improvements).
 *   5. Task mẫu + agent scripted (sửa đúng 2/3 task) để demo và để
 *      test tự kiểm tra harness.
 *
 * Không gọi model thật, không gọi mạng. Giới hạn trung thực: repo
 * tạm dùng git thật nên cần `git` trên PATH; không phải Docker
 * sandbox thật — chỉ dùng task tự viết/tin cậy; diffEconomy chấm
 * theo SỐ DÒNG diff (ước lượng độ gọn, không hiểu ngữ nghĩa);
 * token agent không báo thì ước lượng chars/4.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runV9Git, runV9GitOrThrow } from '../codingV9/gitAtomic';
import { CodingV12Error } from './types';
import { runV12Command } from './editStrategyV12';
import type {
  V12EvalAgentAttempt,
  V12EvalComparison,
  V12EvalReport,
  V12EvalScores,
  V12EvalTask,
  V12EvalTaskSummary,
  V12EvalTestResult,
} from './types';

/** Số attempt mặc định mỗi task (k của pass@k). */
export const V12_EVAL_DEFAULT_ATTEMPTS = 3;
/** Số attempt tối đa mỗi task. */
export const V12_EVAL_MAX_ATTEMPTS = 10;
/** Số task tối đa mỗi suite. */
export const V12_EVAL_MAX_TASKS_PER_SUITE = 100;
/** Số ký tự output test giữ lại trong report khi fail. */
export const V12_EVAL_FAILURE_EXCERPT_CHARS = 2000;
/** Timeout mặc định mỗi lệnh test, ms. */
export const V12_EVAL_DEFAULT_TEST_TIMEOUT_MS = 30_000;
/** Hệ số ước lượng token khi agent không báo (chars / 4). */
export const V12_EVAL_TOKEN_CHARS_PER_TOKEN = 4;
/** Tên suite mẫu. */
export const V12_EVAL_SUITE_NAME = 'coding-v12-sample-suite';
/** Tên file lưu báo cáo eval trong evalDir. */
export const V12_EVAL_DETAIL_FILE = 'report.json';
/** Trọng số 4 chiều chấm (tổng = 1). */
export const V12_EVAL_DIMENSION_WEIGHTS = {
  fileAccuracy: 0.25,
  testScore: 0.4,
  noRegression: 0.2,
  diffEconomy: 0.15,
} as const;
/** Ngưỡng dòng diff: dưới ngưỡng này diff được coi là gọn (điểm 1). */
export const V12_EVAL_ECONOMY_FREE_LINES = 30;
/** Số dòng diff mà tại đó diffEconomy chạm sàn. */
export const V12_EVAL_ECONOMY_FLOOR_LINES = 430;
/** Sàn điểm diffEconomy (diff rất lớn vẫn không 0 hẳn). */
export const V12_EVAL_ECONOMY_FLOOR = 0.3;
/** Chênh điểm tối thiểu để một task được liệt kê là "đổi rõ rệt". */
export const V12_EVAL_CHANGED_TASK_DELTA = 10;

/** Hàm agent eval v3: nhận task + số attempt → patch nộp. */
export type V12EvalAgentFn = (task: V12EvalTask, attemptNo: number) => V12EvalAgentAttempt | Promise<V12EvalAgentAttempt>;

/** Validate một task eval v3 (throw khi không hợp lệ). */
export function validateV12EvalTask(task: V12EvalTask): void {
  if (!task || typeof task !== 'object') {
    throw new CodingV12Error('eval-task-invalid', 'Eval v12: task không hợp lệ.');
  }
  if (typeof task.id !== 'string' || task.id.trim() === '') {
    throw new CodingV12Error('eval-task-invalid', 'Eval v12: task.id không được rỗng.');
  }
  if (typeof task.title !== 'string' || task.title.trim() === '') {
    throw new CodingV12Error('eval-task-invalid', 'Eval v12: task.title không được rỗng.');
  }
  if (!task.files || typeof task.files !== 'object' || Object.keys(task.files).length === 0) {
    throw new CodingV12Error('eval-task-invalid', `Eval v12: task "${task.id}" không có file fixture nào.`);
  }
  for (const [rel, content] of Object.entries(task.files)) {
    if (typeof rel !== 'string' || rel.trim() === '' || rel.startsWith('/') || rel.includes('..')) {
      throw new CodingV12Error('eval-task-invalid', `Eval v12: task "${task.id}" có file fixture không hợp lệ: "${rel}".`);
    }
    if (typeof content !== 'string') {
      throw new CodingV12Error('eval-task-invalid', `Eval v12: task "${task.id}" file "${rel}" không phải chuỗi.`);
    }
  }
  if (!Array.isArray(task.tests) || task.tests.length === 0) {
    throw new CodingV12Error('eval-task-invalid', `Eval v12: task "${task.id}" không có test nào.`);
  }
  for (const t of task.tests) {
    if (typeof t.name !== 'string' || t.name.trim() === '') {
      throw new CodingV12Error('eval-task-invalid', `Eval v12: task "${task.id}" có test không có tên.`);
    }
    if (!Array.isArray(t.command) || t.command.length === 0) {
      throw new CodingV12Error('eval-task-invalid', `Eval v12: test "${t.name}" không có command.`);
    }
    if (!['fail-to-pass', 'pass-to-pass', 'lint'].includes(t.kind)) {
      throw new CodingV12Error('eval-task-invalid', `Eval v12: test "${t.name}" có kind không hỗ trợ: "${String(t.kind)}".`);
    }
    if (t.weight !== undefined && (typeof t.weight !== 'number' || t.weight <= 0)) {
      throw new CodingV12Error('eval-task-invalid', `Eval v12: test "${t.name}" có weight không hợp lệ.`);
    }
  }
  if (!Array.isArray(task.expectedFiles)) {
    throw new CodingV12Error('eval-task-invalid', `Eval v12: task "${task.id}" thiếu expectedFiles (cho [] khi không chấm chiều đúng file).`);
  }
}

/** Tên version an toàn để làm tên thư mục/file (như v11). */
export function v12SafeVersionName(version: string): string {
  return version.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 80) || 'v12';
}

/**
 * Chấm chiều đúng file: 1 khi mọi file sửa nằm trong expected và
 * không chạm forbidden; mỗi file sai trừ đều; không sửa file nào
 * trong khi expected non-empty thì 0.
 */
export function v12ScoreFileAccuracy(changedFiles: string[], expectedFiles: string[], forbiddenFiles: string[] = []): number {
  if (expectedFiles.length === 0 && forbiddenFiles.length === 0) return 1;
  if (changedFiles.length === 0) return 0;
  const forbidden = new Set(forbiddenFiles);
  if (changedFiles.some((f) => forbidden.has(f))) return 0;
  if (expectedFiles.length === 0) return 1;
  const expected = new Set(expectedFiles);
  const correct = changedFiles.filter((f) => expected.has(f)).length;
  const wrong = changedFiles.length - correct;
  const score = (correct - wrong) / expectedFiles.length;
  return Math.max(0, Math.min(1, score));
}

/**
 * Chấm chiều diff gọn theo số dòng diff: <= 30 dòng thì 1, giảm tuyến
 * tính tới sàn 0.3 ở 430 dòng. Patch không áp được thì 0 (không có
 * diff để đo).
 */
export function v12ScoreDiffEconomy(changedLines: number, patchApplied: boolean): number {
  if (!patchApplied) return 0;
  if (changedLines <= V12_EVAL_ECONOMY_FREE_LINES) return 1;
  const t = Math.min(1, (changedLines - V12_EVAL_ECONOMY_FREE_LINES) / (V12_EVAL_ECONOMY_FLOOR_LINES - V12_EVAL_ECONOMY_FREE_LINES));
  return Math.max(V12_EVAL_ECONOMY_FLOOR, 1 - (1 - V12_EVAL_ECONOMY_FLOOR) * t);
}

/** Gộp 4 chiều thành điểm tổng 0..100 + xếp loại. */
export function v12ScoreEval(dims: Omit<V12EvalScores, 'total' | 'grade'>): V12EvalScores {
  const w = V12_EVAL_DIMENSION_WEIGHTS;
  const total = Math.round(
    (dims.fileAccuracy * w.fileAccuracy + dims.testScore * w.testScore + dims.noRegression * w.noRegression + dims.diffEconomy * w.diffEconomy) * 100,
  );
  const grade: V12EvalScores['grade'] = total >= 90 ? 'excellent' : total >= 70 ? 'good' : total >= 40 ? 'fair' : 'poor';
  return { ...dims, total, grade };
}

/** Ghi file fixture (tạo thư mục cha khi cần). */
function writeFixtureFile(dir: string, rel: string, content: string): void {
  const abs = path.join(dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf8');
}

/** File agent đã sửa (so với commit fixture) + tổng dòng đổi. */
async function changedFilesAndLines(tmpDir: string): Promise<{ files: string[]; lines: number }> {
  const names = await runV9Git(['diff', '--name-only', 'HEAD'], { workingDir: tmpDir });
  const files = names.exitCode === 0 ? names.stdout.split('\n').map((s) => s.trim()).filter(Boolean) : [];
  const stat = await runV9Git(['diff', '--numstat', 'HEAD'], { workingDir: tmpDir });
  let lines = 0;
  if (stat.exitCode === 0) {
    for (const line of stat.stdout.split('\n')) {
      const [a, r] = line.split('\t');
      if (a === undefined) continue;
      lines += (a === '-' ? 0 : Number(a) || 0) + (r === '-' ? 0 : Number(r) || 0);
    }
  }
  return { files, lines };
}

export interface V12EvalAttemptDetail {
  attempt: number;
  passed: boolean;
  scores: V12EvalScores;
  tests: V12EvalTestResult[];
  filesChanged: string[];
  changedLines: number;
  error?: string;
  tokensUsed: number | null;
  durationMs: number;
}

/**
 * Chạy MỘT attempt của một task: repo tạm git thật → apply patch →
 * chạy từng test → chấm 4 chiều. Patch không áp được thì attempt
 * fail với fileAccuracy/testScore/noRegression = 0 (diffEconomy = 0).
 */
export async function runV12EvalAttempt(
  task: V12EvalTask,
  attempt: V12EvalAgentAttempt,
  attemptNo: number,
  options: { testTimeoutMs?: number } = {},
): Promise<V12EvalAttemptDetail> {
  validateV12EvalTask(task);
  const started = Date.now();
  const timeoutMs = options.testTimeoutMs ?? V12_EVAL_DEFAULT_TEST_TIMEOUT_MS;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-eval-v12-'));
  const tokensUsed = attempt.tokensUsed ?? null;
  const finish = (partial: Omit<V12EvalAttemptDetail, 'attempt' | 'tokensUsed' | 'durationMs'>): V12EvalAttemptDetail => ({
    attempt: attemptNo,
    tokensUsed,
    durationMs: Date.now() - started,
    ...partial,
  });
  try {
    for (const [rel, content] of Object.entries(task.files)) writeFixtureFile(tmpDir, rel, content);
    const gitOpts = { workingDir: tmpDir, timeoutMs, authorName: 'open-bot-eval-v12', authorEmail: 'eval-v12@open-bot.local' };
    await runV9GitOrThrow(['init', '--quiet'], gitOpts);
    await runV9GitOrThrow(['add', '-A'], gitOpts);
    // runV9Git không tự truyền identity (chỉ commitV9Atomic mới có
    // `-c user.name/email`) nên commit fixture phải kèm -c, nếu không
    // sẽ fail "Author identity unknown" trên máy chưa cấu hình git.
    await runV9GitOrThrow(
      ['-c', 'user.name=open-bot-eval-v12', '-c', 'user.email=eval-v12@open-bot.local', 'commit', '--quiet', '-m', 'fixture'],
      gitOpts,
    );
    if (!attempt.patch || attempt.patch.trim() === '') {
      return finish({
        passed: false,
        scores: v12ScoreEval({ fileAccuracy: 0, testScore: 0, noRegression: 0, diffEconomy: 0 }),
        tests: [],
        filesChanged: [],
        changedLines: 0,
        error: 'Agent không nộp patch.',
      });
    }
    const patchPath = path.join(tmpDir, 'agent.patch');
    fs.writeFileSync(patchPath, attempt.patch, 'utf8');
    const applied = await runV9Git(['apply', '--whitespace=nowarn', 'agent.patch'], gitOpts);
    if (applied.exitCode !== 0) {
      return finish({
        passed: false,
        scores: v12ScoreEval({ fileAccuracy: 0, testScore: 0, noRegression: 0, diffEconomy: 0 }),
        tests: [],
        filesChanged: [],
        changedLines: 0,
        error: `Patch không áp được: ${(applied.stderr || applied.stdout).trim().slice(0, 500) || `git apply exit ${applied.exitCode}`}`,
      });
    }
    const { files: filesChanged, lines: changedLines } = await changedFilesAndLines(tmpDir);
    const results: V12EvalTestResult[] = [];
    let weightPassed = 0;
    let weightTotal = 0;
    let ptpWeightPassed = 0;
    let ptpWeightTotal = 0;
    let allFailToPass = true;
    let hasFailToPass = false;
    for (const test of task.tests) {
      const weight = test.weight ?? 1;
      weightTotal += weight;
      const run = await runV12Command(test.command, tmpDir, timeoutMs);
      const passed = run.ok;
      if (passed) weightPassed += weight;
      if (test.kind === 'fail-to-pass') {
        hasFailToPass = true;
        if (!passed) allFailToPass = false;
      }
      if (test.kind === 'pass-to-pass') {
        ptpWeightTotal += weight;
        if (passed) ptpWeightPassed += weight;
      }
      results.push({
        name: test.name,
        kind: test.kind,
        weight,
        passed,
        exitCode: run.exitCode,
        outputExcerpt: passed
          ? ''
          : `${run.timedOut ? 'timeout' : `exit ${run.exitCode}`}: ${run.output.trim().slice(-V12_EVAL_FAILURE_EXCERPT_CHARS) || '(no output)'}`,
      });
    }
    const fileAccuracy = v12ScoreFileAccuracy(filesChanged, task.expectedFiles, task.forbiddenFiles ?? []);
    const testScore = weightTotal > 0 ? weightPassed / weightTotal : 0;
    const noRegression = ptpWeightTotal > 0 ? ptpWeightPassed / ptpWeightTotal : 1;
    const diffEconomy = v12ScoreDiffEconomy(changedLines, true);
    const passed = hasFailToPass ? allFailToPass : testScore === 1;
    return finish({
      passed,
      scores: v12ScoreEval({ fileAccuracy, testScore, noRegression, diffEconomy }),
      tests: results,
      filesChanged,
      changedLines,
    });
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Thư mục tạm không dọn được — không chặn kết quả.
    }
  }
}

/** Chạy toàn bộ MỘT task (k attempt, lấy attempt tốt nhất) + phát hiện flaky khi yêu cầu. */
async function runV12EvalTask(
  task: V12EvalTask,
  agent: V12EvalAgentFn,
  attemptsPerTask: number,
  options: { testTimeoutMs?: number; detectFlaky?: boolean },
): Promise<V12EvalTaskSummary> {
  const started = Date.now();
  const attempts: V12EvalAttemptDetail[] = [];
  for (let attemptNo = 1; attemptNo <= attemptsPerTask; attemptNo++) {
    const submitted = await agent(task, attemptNo);
    const normalized: V12EvalAgentAttempt = {
      patch: submitted.patch,
      tokensUsed: submitted.tokensUsed ?? Math.ceil(submitted.patch.length / V12_EVAL_TOKEN_CHARS_PER_TOKEN),
    };
    attempts.push(await runV12EvalAttempt(task, normalized, attemptNo, options));
  }
  const best = attempts.reduce((b, a) => (a.scores.total > b.scores.total ? a : b), attempts[0]);
  let flaky = false;
  if (options.detectFlaky) {
    const repeat: V12EvalAttemptDetail[] = [];
    for (let attemptNo = 1; attemptNo <= attemptsPerTask; attemptNo++) {
      const submitted = await agent(task, attemptNo);
      repeat.push(await runV12EvalAttempt(task, { patch: submitted.patch, tokensUsed: submitted.tokensUsed }, attemptNo, options));
    }
    const repeatBest = repeat.reduce((b, a) => (a.scores.total > b.scores.total ? a : b), repeat[0]);
    if (repeatBest.passed !== best.passed || Math.abs(repeatBest.scores.total - best.scores.total) >= V12_EVAL_CHANGED_TASK_DELTA) {
      flaky = true;
    }
  }
  return {
    taskId: task.id,
    title: task.title,
    passed: best.passed,
    scores: best.scores,
    attempts: attempts.length,
    filesChanged: best.filesChanged,
    testsPassed: best.tests.filter((t) => t.passed).length,
    testsTotal: best.tests.length,
    flaky,
    tokensUsed: best.tokensUsed,
    durationMs: Date.now() - started,
  };
}

export interface V12EvalSuiteOptions {
  /** Số attempt mỗi task (k của pass@k). Mặc định 3. */
  attemptsPerTask?: number;
  /** Timeout mỗi lệnh test, ms. Mặc định 30_000. */
  testTimeoutMs?: number;
  /** true = chạy lặp để phát hiện flaky. Mặc định false. */
  detectFlaky?: boolean;
  /** Tên suite trong báo cáo. */
  suiteName?: string;
  /** Version agent trong báo cáo. */
  agentVersion?: string;
}

/** Chạy toàn bộ suite eval v3 (nhiều task) → báo cáo V12EvalReport. */
export async function runV12EvalSuite(
  tasks: readonly V12EvalTask[],
  agent: V12EvalAgentFn,
  options: V12EvalSuiteOptions = {},
): Promise<V12EvalReport> {
  if (!Array.isArray(tasks) || tasks.length === 0) {
    throw new CodingV12Error('eval-task-invalid', 'Eval v12: suite không có task nào.');
  }
  if (tasks.length > V12_EVAL_MAX_TASKS_PER_SUITE) {
    throw new CodingV12Error('eval-task-invalid', `Eval v12: suite quá nhiều task (${tasks.length}).`);
  }
  const started = Date.now();
  const attemptsPerTask = Math.max(1, Math.min(options.attemptsPerTask ?? V12_EVAL_DEFAULT_ATTEMPTS, V12_EVAL_MAX_ATTEMPTS));
  const summaries: V12EvalTaskSummary[] = [];
  for (const task of tasks) {
    summaries.push(await runV12EvalTask(task, agent, attemptsPerTask, options));
  }
  const passedCount = summaries.filter((s) => s.passed).length;
  const mean = (pick: (s: V12EvalScores) => number): number =>
    summaries.length === 0 ? 0 : summaries.reduce((n, s) => n + pick(s.scores), 0) / summaries.length;
  const meanScore = mean((s) => s.total);
  const report: V12EvalReport = {
    runId: `v12eval-${Date.now().toString(36)}-${Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, '0')}`,
    suiteName: options.suiteName ?? V12_EVAL_SUITE_NAME,
    agentVersion: options.agentVersion ?? 'coding-v12',
    at: new Date().toISOString(),
    tasks: summaries,
    passRate: summaries.length === 0 ? 0 : passedCount / summaries.length,
    meanScore,
    meanDimensions: {
      fileAccuracy: mean((s) => s.fileAccuracy),
      testScore: mean((s) => s.testScore),
      noRegression: mean((s) => s.noRegression),
      diffEconomy: mean((s) => s.diffEconomy),
    },
    flakyTasks: summaries.filter((s) => s.flaky).map((s) => s.taskId),
    regressions: [],
    improvements: [],
    totalDurationMs: Date.now() - started,
  };
  return report;
}

/** Lưu báo cáo eval v3 xuống evalDir/<version>/report.json, trả path file. */
export function saveV12EvalReport(evalDir: string, report: V12EvalReport): string {
  const dir = path.join(evalDir, v12SafeVersionName(report.agentVersion));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, V12_EVAL_DETAIL_FILE);
  fs.writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return file;
}

/** Đọc báo cáo eval v3 của một version (null khi chưa có). */
export function loadV12EvalReport(evalDir: string, agentVersion: string): V12EvalReport | null {
  const file = path.join(evalDir, v12SafeVersionName(agentVersion), V12_EVAL_DETAIL_FILE);
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as V12EvalReport;
  } catch {
    return null;
  }
}

/** Liệt kê các version đã có báo cáo eval v3 trong evalDir. */
export function listV12EvalVersions(evalDir: string): string[] {
  try {
    return fs
      .readdirSync(evalDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .filter((name) => loadV12EvalReport(evalDir, name) !== null)
      .sort();
  } catch {
    return [];
  }
}

/** So sánh 2 báo cáo eval v3: baseline (cũ) vs current (mới). */
export function compareV12EvalReports(baseline: V12EvalReport, current: V12EvalReport): V12EvalComparison {
  const byId = (r: V12EvalReport): Map<string, V12EvalTaskSummary> => new Map(r.tasks.map((t) => [t.taskId, t]));
  const baseMap = byId(baseline);
  const curMap = byId(current);
  const regressions: string[] = [];
  const improvements: string[] = [];
  const changedTasks: { taskId: string; baselineScore: number; currentScore: number }[] = [];
  for (const [taskId, cur] of curMap) {
    const base = baseMap.get(taskId);
    if (!base) continue;
    if (base.passed && !cur.passed) regressions.push(taskId);
    if (!base.passed && cur.passed) improvements.push(taskId);
    const delta = cur.scores.total - base.scores.total;
    if (Math.abs(delta) >= V12_EVAL_CHANGED_TASK_DELTA) {
      changedTasks.push({ taskId, baselineScore: base.scores.total, currentScore: cur.scores.total });
    }
  }
  return {
    baselineVersion: baseline.agentVersion,
    currentVersion: current.agentVersion,
    baselineMeanScore: baseline.meanScore,
    currentMeanScore: current.meanScore,
    scoreDelta: current.meanScore - baseline.meanScore,
    baselinePassRate: baseline.passRate,
    currentPassRate: current.passRate,
    regressions,
    improvements,
    changedTasks,
  };
}

/** Tóm tắt một báo cáo eval v3 thành 1 dòng. */
export function v12SummarizeEvalReport(report: V12EvalReport): string {
  const passed = report.tasks.filter((t) => t.passed).length;
  return `Eval v12 ${report.suiteName} (${report.agentVersion}): ${passed}/${report.tasks.length} task pass (${Math.round(report.passRate * 100)}%), điểm trung bình ${report.meanScore.toFixed(1)}/100` +
    ` — đúng file ${report.meanDimensions.fileAccuracy.toFixed(2)}, test ${report.meanDimensions.testScore.toFixed(2)}, không regression ${report.meanDimensions.noRegression.toFixed(2)}, diff gọn ${report.meanDimensions.diffEconomy.toFixed(2)}` +
    (report.flakyTasks.length > 0 ? ` — flaky: ${report.flakyTasks.join(', ')}` : '');
}

/** Render báo cáo eval v3 thành text nhiều dòng (để log/UI). */
export function renderV12EvalReport(report: V12EvalReport): string {
  const lines = [v12SummarizeEvalReport(report)];
  for (const t of report.tasks) {
    lines.push(
      `  ${t.passed ? 'PASS' : 'FAIL'} ${t.taskId}: ${t.scores.total}/100 (${t.scores.grade}) — file ${t.scores.fileAccuracy.toFixed(2)}, test ${t.scores.testScore.toFixed(2)}, no-regr ${t.scores.noRegression.toFixed(2)}, gọn ${t.scores.diffEconomy.toFixed(2)} — ${t.testsPassed}/${t.testsTotal} test, file sửa: ${t.filesChanged.join(', ') || '(không có)'}${t.flaky ? ' [flaky]' : ''}`,
    );
  }
  return lines.join('\n');
}

/* ================================================================== */
/* Task mẫu + agent scripted (demo / tự kiểm tra harness)              */
/* ================================================================== */

/** 3 task mẫu kiểu SWE-bench (mjs, chạy bằng node thật). */
export const V12_EVAL_SAMPLE_TASKS: readonly V12EvalTask[] = [
  {
    id: 'v12-sample-add',
    title: 'Sửa hàm add trả về tổng đúng',
    files: {
      'src/math.mjs': `export function add(a, b) {\n  return 0;\n}\n`,
      'test/math.test.mjs': `import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { add } from '../src/math.mjs';\ntest('add', () => { assert.equal(add(2, 3), 5); assert.equal(add(-1, 1), 0); });\n`,
    },
    tests: [
      { name: 'math', command: ['node', '--test', 'test/math.test.mjs'], kind: 'fail-to-pass' },
      { name: 'lint-math', command: ['node', '--check', 'src/math.mjs'], kind: 'lint' },
    ],
    expectedFiles: ['src/math.mjs'],
  },
  {
    id: 'v12-sample-capitalize',
    title: 'Sửa hàm capitalize viết hoa chữ đầu',
    files: {
      'src/text.mjs': `export function capitalize(s) {\n  return s;\n}\n`,
      'test/text.test.mjs': `import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { capitalize } from '../src/text.mjs';\ntest('capitalize', () => { assert.equal(capitalize('abc'), 'Abc'); assert.equal(capitalize(''), ''); });\n`,
    },
    tests: [
      { name: 'text', command: ['node', '--test', 'test/text.test.mjs'], kind: 'fail-to-pass' },
      { name: 'lint-text', command: ['node', '--check', 'src/text.mjs'], kind: 'lint' },
    ],
    expectedFiles: ['src/text.mjs'],
  },
  {
    id: 'v12-sample-max',
    title: 'Sửa hàm maxOf trả về lớn nhất (scripted agent cố tình sửa sai)',
    files: {
      'src/array.mjs': `export function maxOf(arr) {\n  return arr[0];\n}\n`,
      'test/array.test.mjs': `import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { maxOf } from '../src/array.mjs';\ntest('maxOf', () => { assert.equal(maxOf([1, 9, 3]), 9); assert.equal(maxOf([-5, -2]), -2); });\n`,
    },
    tests: [
      { name: 'array', command: ['node', '--test', 'test/array.test.mjs'], kind: 'fail-to-pass' },
      { name: 'lint-array', command: ['node', '--check', 'src/array.mjs'], kind: 'lint' },
    ],
    expectedFiles: ['src/array.mjs'],
  },
];

export const V12_SAMPLE_PATCH_ADD = `--- a/src/math.mjs\n+++ b/src/math.mjs\n@@ -1,3 +1,3 @@\n export function add(a, b) {\n-  return 0;\n+  return a + b;\n }\n`;

export const V12_SAMPLE_PATCH_CAPITALIZE = `--- a/src/text.mjs\n+++ b/src/text.mjs\n@@ -1,3 +1,3 @@\n export function capitalize(s) {\n-  return s;\n+  return s.length === 0 ? s : s[0].toUpperCase() + s.slice(1);\n }\n`;

/** Patch sai cố tình cho task maxOf (trả về phần tử đầu, vẫn fail test). */
export const V12_SAMPLE_PATCH_MAX_WRONG = `--- a/src/array.mjs\n+++ b/src/array.mjs\n@@ -1,3 +1,3 @@\n export function maxOf(arr) {\n-  return arr[0];\n+  return arr[0] + 0;\n }\n`;

/**
 * Agent scripted cho eval mẫu: sửa đúng 2/3 task (add, capitalize),
 * task maxOf nộp patch sai cố tình — để demo pass rate < 100%.
 */
export function scriptedV12Agent(task: V12EvalTask, _attempt: number): V12EvalAgentAttempt {
  if (task.id === 'v12-sample-add') return { patch: V12_SAMPLE_PATCH_ADD };
  if (task.id === 'v12-sample-capitalize') return { patch: V12_SAMPLE_PATCH_CAPITALIZE };
  if (task.id === 'v12-sample-max') return { patch: V12_SAMPLE_PATCH_MAX_WRONG };
  return { patch: '' };
}

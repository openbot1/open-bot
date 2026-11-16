/**
 * Eval harness kieu SWE-bench cho coding agent v5 (v1.13, Doi T4).
 *
 * Y tuong hoc tu SWE-bench (issue -> patch -> chay test FAIL_TO_PASS
 * va PASS_TO_PASS, cham pass/fail tung bai, bao cao ti le) — chi hoc
 * y tuong, tu thiet ke va viet lai hoan toan tu dau, KHONG doc, KHONG
 * copy code/text/tai san cua SWE-bench hay bat ky repo nao:
 *
 *   - Mot task: mo ta issue + fixture repo (file ban dau) + patch
 *     ung vien + danh sach lenh test (argv, khong shell) + 2 nhom
 *     test: FAIL_TO_PASS (phai fail truoc patch, pass sau patch) va
 *     PASS_TO_PASS (phai pass ca truoc va sau patch).
 *   - Runner: tao repo git tam (git init + commit base), chay test
 *     tren base, apply patch (`git apply` qua stdin), chay lai test,
 *     cham theo dung quy tac SWE-bench — khong chi "test sau patch
 *     pass" (patch rong hoac patch pha test cu cung bi bat).
 *   - Ket qua luu JSON tung task + bao cao suite (pass rate, thoi
 *     gian, ly do fail) de so sanh giua cac lan chay.
 *
 * Tai dung runner lenh cua v3 (`runCodingV3EvalCommand`, argv tach
 * san, khong shell, timeout giet ca cay process) de khong viet lap
 * lai logic chay lenh an toan.
 *
 * An toan: lenh chay KHONG qua shell (argv), cwd luon la repo tam
 * vua tao, timeout giet ca cay process, env toi thieu (PATH + bien
 * caller cho phep + identity git danh rieng cho eval). Patch apply
 * qua `git apply --check` truoc — patch khong apply duoc thi task
 * `error` (loi patch, khong tinh fail).
 *
 * Gioi han trung thuc:
 *   - Khong phai Docker sandbox that — chi la thu muc tam tren may
 *     nay; task doc hai van co the cham file ngoai cwd qua duong dan
 *     tuyet doi (chi dung task tu viet/tin cay).
 *   - Cham theo exit code tung lenh test, khong cham theo noi dung
 *     output; ten test trong failToPass/passToPass phai khop `name`
 *     cua lenh test — ten khong khop thi task `error`.
 *   - Repo tam dung git that nen can `git` tren PATH.
 */

import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  CODING_V3_EVAL_MAX_OUTPUT_CHARS,
  runCodingV3EvalCommand,
} from '../codingV3/evalHarness';
import type { CodingV3EvalCommand } from '../codingV3/evalHarness';
import { findCodingV5PatchPathViolations } from './gitV5';

export const CODING_V5_SWE_DEFAULT_TIMEOUT_MS = 30_000;
export const CODING_V5_SWE_MAX_TASKS_PER_SUITE = 100;
/** Identity git danh rieng cho repo tam cua eval (khong dung config user). */
export const CODING_V5_SWE_GIT_AUTHOR_NAME = 'open-bot-eval';
export const CODING_V5_SWE_GIT_AUTHOR_EMAIL = 'eval@open-bot.local';

export interface CodingV5SweTask {
  id: string;
  title: string;
  /** Mo ta issue (de agent doc hieu bai can sua). */
  issue: string;
  /** File fixture ghi vao repo tam truoc khi commit base: relPath -> noi dung. */
  fixtures?: Record<string, string>;
  /** Patch ung vien (unified diff text) — agent tao ra de sua issue. */
  patch: string;
  /** Lenh test cham diem (exit 0 = pass). It nhat 1 lenh. */
  testCommands: CodingV3EvalCommand[];
  /** Ten lenh test phai fail o base, pass sau patch. */
  failToPass: string[];
  /** Ten lenh test phai pass ca truoc va sau patch. */
  passToPass: string[];
  /** Timeout mac dinh moi lenh (ms). Mac dinh 30_000. */
  timeoutMs?: number;
  /** Bien moi truong them cho lenh (ngoai PATH). */
  env?: Record<string, string>;
}

export interface CodingV5SweTestRun {
  name: string;
  argv: string[];
  /** Nhom: 'failToPass' | 'passToPass' | 'unclassified'. */
  group: 'failToPass' | 'passToPass' | 'unclassified';
  baseExitCode: number | null;
  baseTimedOut: boolean;
  basePassed: boolean;
  afterExitCode: number | null;
  afterTimedOut: boolean;
  afterPassed: boolean;
  /** true khi test nay dong gop vao quyet dinh pass/fail cua task. */
  countsTowardScore: boolean;
  /** true khi test thoa ky vong cua nhom no (vd failToPass: fail truoc + pass sau). */
  expectationMet: boolean;
  stdout: string;
  stderr: string;
  durationMs: number;
}

export type CodingV5SweTaskStatus = 'pass' | 'fail' | 'error';

export interface CodingV5SweTaskResult {
  taskId: string;
  title: string;
  status: CodingV5SweTaskStatus;
  /** true khi patch apply duoc vao repo tam. */
  patchApplied: boolean;
  workDir: string;
  /** true khi thu muc tam da duoc don (mac dinh don sau khi chay). */
  workDirKept: boolean;
  failToPassPassed: number;
  failToPassTotal: number;
  passToPassPassed: number;
  passToPassTotal: number;
  tests: CodingV5SweTestRun[];
  durationMs: number;
  /** Ly do error/fail ngan gon. */
  reason: string;
  startedAt: string;
  finishedAt: string;
}

export interface CodingV5SweSuiteReport {
  suiteId: string;
  totalTasks: number;
  passed: number;
  failed: number;
  errored: number;
  /** passed / totalTasks (0 khi khong co task). */
  passRate: number;
  results: CodingV5SweTaskResult[];
  durationMs: number;
  startedAt: string;
  finishedAt: string;
  summary: string;
}

export class CodingV5SweError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CodingV5SweError';
  }
}

export interface CodingV5SweRunOptions {
  /** Giu repo tam sau khi chay (mac dinh false: don). */
  keepWorkDir?: boolean;
  /** Thu muc cha cho repo tam (mac dinh os.tmpdir()). */
  tmpBase?: string;
  /** Repo lam viec co san thay vi tao repo tam (phai ton tai; KHONG don). */
  workDir?: string;
}

function truncateOutput(text: string): string {
  if (text.length <= CODING_V3_EVAL_MAX_OUTPUT_CHARS) return text;
  return `${text.slice(0, CODING_V3_EVAL_MAX_OUTPUT_CHARS)}\n... (output da cat)`;
}

/** Validate mot task SWE (export de host/tool kiem tra truoc khi chay). */
export function validateCodingV5SweTask(task: CodingV5SweTask): void {
  if (!task || typeof task.id !== 'string' || task.id.trim() === '') {
    throw new CodingV5SweError('Eval task can id (chuoi khong rong).');
  }
  if (typeof task.title !== 'string' || task.title.trim() === '') {
    throw new CodingV5SweError(`Eval task "${task.id}" can title.`);
  }
  if (!Array.isArray(task.testCommands) || task.testCommands.length === 0) {
    throw new CodingV5SweError(`Eval task "${task.id}" can it nhat 1 testCommands.`);
  }
  if (task.testCommands.length > 20) {
    throw new CodingV5SweError(`Eval task "${task.id}" co qua 20 testCommands (tran an toan).`);
  }
  const names = new Set<string>();
  for (const cmd of task.testCommands) {
    if (typeof cmd.name !== 'string' || cmd.name.trim() === '') {
      throw new CodingV5SweError(`Eval task "${task.id}" co testCommand thieu name.`);
    }
    if (names.has(cmd.name)) {
      throw new CodingV5SweError(`Eval task "${task.id}" co 2 testCommand cung name "${cmd.name}".`);
    }
    names.add(cmd.name);
    if (!Array.isArray(cmd.argv) || cmd.argv.length === 0 || typeof cmd.argv[0] !== 'string') {
      throw new CodingV5SweError(`Eval task "${task.id}" test "${cmd.name}" can argv khong rong.`);
    }
  }
  for (const groupName of ['failToPass', 'passToPass'] as const) {
    const group = task[groupName] ?? [];
    if (!Array.isArray(group)) {
      throw new CodingV5SweError(`Eval task "${task.id}" ${groupName} phai la mang ten test.`);
    }
    for (const name of group) {
      if (!names.has(name)) {
        throw new CodingV5SweError(
          `Eval task "${task.id}" ${groupName} chua ten test khong ton tai: "${name}".`,
        );
      }
    }
  }
  const overlap = (task.failToPass ?? []).filter((n) => (task.passToPass ?? []).includes(n));
  if (overlap.length > 0) {
    throw new CodingV5SweError(
      `Eval task "${task.id}" co test vua failToPass vua passToPass: ${overlap.join(', ')}.`,
    );
  }
  if (typeof task.patch !== 'string') {
    throw new CodingV5SweError(`Eval task "${task.id}" patch phai la chuoi (co the rong).`);
  }
}

/** Chay `git` trong repo tam (execFile, khong shell), identity rieng cho eval. */
function runSweGit(
  repoDir: string,
  args: string[],
  options: { stdinText?: string; timeoutMs?: number } = {},
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      'git',
      ['-C', repoDir, ...args],
      {
        timeout: options.timeoutMs ?? CODING_V5_SWE_DEFAULT_TIMEOUT_MS,
        maxBuffer: 10 * 1024 * 1024,
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: CODING_V5_SWE_GIT_AUTHOR_NAME,
          GIT_AUTHOR_EMAIL: CODING_V5_SWE_GIT_AUTHOR_EMAIL,
          GIT_COMMITTER_NAME: CODING_V5_SWE_GIT_AUTHOR_NAME,
          GIT_COMMITTER_EMAIL: CODING_V5_SWE_GIT_AUTHOR_EMAIL,
        },
      },
      (error, stdout, stderr) => {
        if (error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
          reject(new CodingV5SweError('Khong tim thay lenh `git` tren may (can git tren PATH).'));
          return;
        }
        const exitCode = typeof error?.code === 'number' ? error.code : 0;
        if (error && exitCode !== 0) {
          reject(
            new CodingV5SweError(
              `git ${args.join(' ')} that bai (exit ${exitCode}): ${String(stderr).trim() || error.message}`,
            ),
          );
          return;
        }
        resolve({ stdout: String(stdout), stderr: String(stderr), exitCode });
      },
    );
    if (options.stdinText !== undefined) {
      child.stdin?.end(options.stdinText);
    }
  });
}

/** Ghi fixture vao repo tam (tu choi duong dan thoat khoi repo). */
function writeSweFixtures(workDir: string, fixtures: Record<string, string>): void {
  for (const [relPath, content] of Object.entries(fixtures)) {
    const resolved = path.resolve(workDir, relPath);
    if (resolved !== workDir && !resolved.startsWith(workDir + path.sep)) {
      throw new CodingV5SweError(`Fixture "${relPath}" thoat khoi workDir — tu choi.`);
    }
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    fs.writeFileSync(resolved, content, 'utf8');
  }
}

interface SwePhaseOutcome {
  exitCode: number | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  durationMs: number;
}

/**
 * Runner SWE-bench local: base test -> apply patch -> re-test ->
 * cham theo FAIL_TO_PASS / PASS_TO_PASS.
 */
export class CodingV5SweHarness {
  async runTask(task: CodingV5SweTask, options: CodingV5SweRunOptions = {}): Promise<CodingV5SweTaskResult> {
    validateCodingV5SweTask(task);
    const startedAt = Date.now();
    const defaultTimeout = Math.max(
      1000,
      Math.floor(task.timeoutMs ?? CODING_V5_SWE_DEFAULT_TIMEOUT_MS),
    );
    let workDir: string;
    let createdTempDir = false;
    if (options.workDir) {
      if (!fs.existsSync(options.workDir) || !fs.statSync(options.workDir).isDirectory()) {
        throw new CodingV5SweError(`Eval workDir khong ton tai: ${options.workDir}`);
      }
      workDir = path.resolve(options.workDir);
    } else {
      workDir = fs.mkdtempSync(path.join(options.tmpBase ?? os.tmpdir(), `open-bot-swe-${task.id}-`));
      createdTempDir = true;
    }
    const keepWorkDir = options.keepWorkDir ?? false;

    let status: CodingV5SweTaskStatus = 'pass';
    let reason = '';
    let patchApplied = false;
    const tests: CodingV5SweTestRun[] = [];
    const failToPassSet = new Set(task.failToPass ?? []);
    const passToPassSet = new Set(task.passToPass ?? []);

    try {
      writeSweFixtures(workDir, task.fixtures ?? {});
      // Repo git tam: init + commit base (de `git apply` co co so).
      await runSweGit(workDir, ['init', '--quiet']);
      await runSweGit(workDir, ['add', '-A']);
      await runSweGit(workDir, ['commit', '--quiet', '--allow-empty', '-m', `swe base: ${task.id}`]);

      const runPhase = async (
        cmd: CodingV3EvalCommand,
      ): Promise<SwePhaseOutcome> => {
        const phaseStarted = Date.now();
        const timeoutMs = Math.max(100, Math.floor(cmd.timeoutMs ?? defaultTimeout));
        const outcome = await runCodingV3EvalCommand(cmd.argv, {
          cwd: workDir,
          timeoutMs,
          env: task.env,
        });
        return {
          exitCode: outcome.exitCode,
          timedOut: outcome.timedOut,
          stdout: truncateOutput(outcome.stdout),
          stderr: truncateOutput(outcome.stderr),
          durationMs: Date.now() - phaseStarted,
        };
      };

      // Phase 1: chay test tren base.
      const baseOutcomes = new Map<string, SwePhaseOutcome>();
      for (const cmd of task.testCommands) {
        baseOutcomes.set(cmd.name, await runPhase(cmd));
      }

      // Phase 2: apply patch (check truoc — patch loi thi task error).
      if (task.patch.trim() === '') {
        status = 'error';
        reason = 'Patch rong — khong co gi de apply.';
      } else {
        const violations = findCodingV5PatchPathViolations(task.patch);
        if (violations.length > 0) {
          status = 'error';
          reason = `Patch chua duong dan thoat khoi repo: ${violations.join(', ')}.`;
        } else {
          try {
            await runSweGit(workDir, ['apply', '--check'], { stdinText: task.patch });
            await runSweGit(workDir, ['apply'], { stdinText: task.patch });
            patchApplied = true;
          } catch (e) {
            status = 'error';
            reason = `Patch khong apply duoc: ${e instanceof Error ? e.message : String(e)}`;
          }
        }
      }

      // Phase 3: chay lai test sau patch (chi khi patch apply duoc).
      const afterOutcomes = new Map<string, SwePhaseOutcome>();
      if (patchApplied) {
        for (const cmd of task.testCommands) {
          afterOutcomes.set(cmd.name, await runPhase(cmd));
        }
      }

      // Cham diem theo tung nhom.
      for (const cmd of task.testCommands) {
        const base = baseOutcomes.get(cmd.name) as SwePhaseOutcome;
        const after = afterOutcomes.get(cmd.name);
        const group: CodingV5SweTestRun['group'] = failToPassSet.has(cmd.name)
          ? 'failToPass'
          : passToPassSet.has(cmd.name)
            ? 'passToPass'
            : 'unclassified';
        const countsTowardScore = group !== 'unclassified';
        const basePassed = !base.timedOut && base.exitCode === 0;
        const afterPassed = after ? !after.timedOut && after.exitCode === 0 : false;
        let expectationMet: boolean;
        if (group === 'failToPass') {
          expectationMet = patchApplied && !basePassed && afterPassed;
        } else if (group === 'passToPass') {
          expectationMet = patchApplied && basePassed && afterPassed;
        } else {
          expectationMet = afterPassed;
        }
        tests.push({
          name: cmd.name,
          argv: cmd.argv,
          group,
          baseExitCode: base.exitCode,
          baseTimedOut: base.timedOut,
          basePassed,
          afterExitCode: after ? after.exitCode : null,
          afterTimedOut: after ? after.timedOut : false,
          afterPassed,
          countsTowardScore,
          expectationMet,
          stdout: after ? after.stdout : base.stdout,
          stderr: after ? after.stderr : base.stderr,
          durationMs: base.durationMs + (after ? after.durationMs : 0),
        });
      }

      if (status === 'pass') {
        const unmet = tests.filter((t) => t.countsTowardScore && !t.expectationMet);
        if (unmet.length > 0) {
          status = 'fail';
          const details = unmet.map((t) => {
            if (t.group === 'failToPass') {
              if (t.basePassed) return `"${t.name}" da pass o base (khong phai bug can sua)`;
              return `"${t.name}" van fail sau patch (exit ${String(t.afterExitCode)})`;
            }
            if (t.group === 'passToPass') {
              if (!t.basePassed) return `"${t.name}" da fail o base (test cu hong san)`;
              return `"${t.name}" bi pha vo sau patch (exit ${String(t.afterExitCode)})`;
            }
            return `"${t.name}" khong dat`;
          });
          reason = `Khong dat ${unmet.length} test cham diem: ${details.join('; ')}.`;
        } else {
          reason = `Tat ca test cham diem dat (${tests.filter((t) => t.countsTowardScore).length} test).`;
        }
      }
    } catch (e) {
      status = 'error';
      reason = e instanceof Error ? e.message : String(e);
    } finally {
      if (createdTempDir && !keepWorkDir) {
        try {
          fs.rmSync(workDir, { recursive: true, force: true });
        } catch {
          // Don that bai: bao qua workDirKept = true.
        }
      }
    }

    const finishedAt = Date.now();
    const workDirKept = keepWorkDir || !createdTempDir || fs.existsSync(workDir);
    const failToPassTotal = tests.filter((t) => t.group === 'failToPass').length;
    const passToPassTotal = tests.filter((t) => t.group === 'passToPass').length;
    return {
      taskId: task.id,
      title: task.title,
      status,
      patchApplied,
      workDir,
      workDirKept,
      failToPassPassed: tests.filter((t) => t.group === 'failToPass' && t.expectationMet).length,
      failToPassTotal,
      passToPassPassed: tests.filter((t) => t.group === 'passToPass' && t.expectationMet).length,
      passToPassTotal,
      tests,
      durationMs: finishedAt - startedAt,
      reason,
      startedAt: new Date(startedAt).toISOString(),
      finishedAt: new Date(finishedAt).toISOString(),
    };
  }

  /** Chay nhieu task lien tiep, tra ve bao cao suite (pass rate...). */
  async runSuite(
    tasks: CodingV5SweTask[],
    options: CodingV5SweRunOptions = {},
  ): Promise<CodingV5SweSuiteReport> {
    if (tasks.length > CODING_V5_SWE_MAX_TASKS_PER_SUITE) {
      throw new CodingV5SweError(
        `Suite co ${tasks.length} task(s) — vuot tran ${CODING_V5_SWE_MAX_TASKS_PER_SUITE}.`,
      );
    }
    const startedAt = Date.now();
    const suiteId = `swe-suite-${startedAt}`;
    const results: CodingV5SweTaskResult[] = [];
    for (const task of tasks) {
      try {
        results.push(await this.runTask(task, options));
      } catch (e) {
        // validateTask loi: ghi mot result error thay vi dung ca suite.
        const now = new Date().toISOString();
        results.push({
          taskId: task.id || '(unknown)',
          title: task.title || '(unknown)',
          status: 'error',
          patchApplied: false,
          workDir: '',
          workDirKept: false,
          failToPassPassed: 0,
          failToPassTotal: Array.isArray(task.failToPass) ? task.failToPass.length : 0,
          passToPassPassed: 0,
          passToPassTotal: Array.isArray(task.passToPass) ? task.passToPass.length : 0,
          tests: [],
          durationMs: 0,
          reason: e instanceof Error ? e.message : String(e),
          startedAt: now,
          finishedAt: now,
        });
      }
    }
    const passed = results.filter((r) => r.status === 'pass').length;
    const failed = results.filter((r) => r.status === 'fail').length;
    const errored = results.filter((r) => r.status === 'error').length;
    const finishedAt = Date.now();
    return {
      suiteId,
      totalTasks: results.length,
      passed,
      failed,
      errored,
      passRate: results.length > 0 ? passed / results.length : 0,
      results,
      durationMs: finishedAt - startedAt,
      startedAt: new Date(startedAt).toISOString(),
      finishedAt: new Date(finishedAt).toISOString(),
      summary:
        `SWE suite ${suiteId}: ${passed}/${results.length} task(s) pass ` +
        `(${(passed / Math.max(1, results.length)) * 100}%, ${failed} fail, ${errored} error) ` +
        `in ${finishedAt - startedAt}ms.`,
    };
  }
}

/** Luu bao cao suite thanh JSON (de so sanh giua cac lan chay). */
export function saveCodingV5SweReport(report: CodingV5SweSuiteReport, dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${report.suiteId}.json`);
  fs.writeFileSync(filePath, JSON.stringify(report, null, 2), 'utf8');
  return filePath;
}

/** Doc lai bao cao suite tu JSON. */
export function loadCodingV5SweReport(filePath: string): CodingV5SweSuiteReport {
  const text = fs.readFileSync(filePath, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new CodingV5SweError(`Bao cao SWE JSON khong doc duoc: ${filePath}.`);
  }
  if (typeof parsed !== 'object' || parsed === null || !Array.isArray((parsed as { results?: unknown }).results)) {
    throw new CodingV5SweError(`Bao cao SWE JSON sai dinh dang: ${filePath}.`);
  }
  return parsed as CodingV5SweSuiteReport;
}

/** Liet ke file bao cao suite da luu trong mot thu muc (moi nhat truoc). */
export function listCodingV5SweReports(dir: string): string[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return entries
    .filter((name) => name.startsWith('swe-suite-') && name.endsWith('.json'))
    .sort()
    .reverse()
    .map((name) => path.join(dir, name));
}

/** Ket qua so sanh 2 bao cao suite (de thay tien bo / hoi quy giua 2 lan chay). */
export interface CodingV5SweReportComparison {
  beforeSuiteId: string;
  afterSuiteId: string;
  /** Chenh lech pass rate (sau - truoc), vd +0.25. */
  passRateDelta: number;
  beforePassRate: number;
  afterPassRate: number;
  /** Task tu fail/error -> pass. */
  fixed: string[];
  /** Task tu pass -> fail/error. */
  regressed: string[];
  /** Task van fail ca 2 lan. */
  stillFailing: string[];
  /** Task chi co o mot trong 2 bao cao (them/bot task). */
  onlyInBefore: string[];
  onlyInAfter: string[];
  summary: string;
}

/**
 * So sanh 2 bao cao suite: task nao duoc sua (fixed), task nao bi pha
 * vo (regressed), pass rate doi bao nhieu. Dung de danh gia mot dot
 * cai tien agent qua cac lan chay eval (vd truoc/sau mot wave).
 */
export function compareCodingV5SweReports(
  before: CodingV5SweSuiteReport,
  after: CodingV5SweSuiteReport,
): CodingV5SweReportComparison {
  const beforeById = new Map(before.results.map((r) => [r.taskId, r]));
  const afterById = new Map(after.results.map((r) => [r.taskId, r]));
  const fixed: string[] = [];
  const regressed: string[] = [];
  const stillFailing: string[] = [];
  const onlyInBefore: string[] = [];
  const onlyInAfter: string[] = [];
  for (const [id, b] of beforeById) {
    const a = afterById.get(id);
    if (!a) {
      onlyInBefore.push(id);
      continue;
    }
    if (b.status !== 'pass' && a.status === 'pass') fixed.push(id);
    else if (b.status === 'pass' && a.status !== 'pass') regressed.push(id);
    else if (b.status !== 'pass' && a.status !== 'pass') stillFailing.push(id);
  }
  for (const id of afterById.keys()) {
    if (!beforeById.has(id)) onlyInAfter.push(id);
  }
  const passRateDelta = after.passRate - before.passRate;
  const sign = passRateDelta > 0 ? '+' : '';
  return {
    beforeSuiteId: before.suiteId,
    afterSuiteId: after.suiteId,
    passRateDelta,
    beforePassRate: before.passRate,
    afterPassRate: after.passRate,
    fixed,
    regressed,
    stillFailing,
    onlyInBefore,
    onlyInAfter,
    summary:
      `SWE compare ${before.suiteId} -> ${after.suiteId}: ` +
      `pass rate ${(before.passRate * 100).toFixed(1)}% -> ${(after.passRate * 100).toFixed(1)}% ` +
      `(${sign}${(passRateDelta * 100).toFixed(1)}%), ` +
      `${fixed.length} fixed, ${regressed.length} regressed, ${stillFailing.length} still failing.`,
  };
}

/** Render ket qua so sanh 2 bao cao dang text ngan gon. */
export function renderCodingV5SweComparison(comparison: CodingV5SweReportComparison): string {
  const lines = [comparison.summary];
  if (comparison.fixed.length > 0) lines.push(`  Fixed: ${comparison.fixed.join(', ')}`);
  if (comparison.regressed.length > 0) lines.push(`  Regressed: ${comparison.regressed.join(', ')}`);
  if (comparison.stillFailing.length > 0) lines.push(`  Still failing: ${comparison.stillFailing.join(', ')}`);
  if (comparison.onlyInBefore.length > 0) lines.push(`  Removed tasks: ${comparison.onlyInBefore.join(', ')}`);
  if (comparison.onlyInAfter.length > 0) lines.push(`  New tasks: ${comparison.onlyInAfter.join(', ')}`);
  return lines.join('\n');
}

/** Render bao cao suite dang text ngan gon. */
export function renderCodingV5SweReport(report: CodingV5SweSuiteReport): string {
  const lines = [
    report.summary,
    `Pass rate: ${(report.passRate * 100).toFixed(1)}% (${report.passed}/${report.totalTasks})`,
  ];
  for (const r of report.results) {
    const mark = r.status === 'pass' ? 'PASS' : r.status === 'fail' ? 'FAIL' : 'ERROR';
    lines.push(
      `  [${mark}] ${r.taskId} — ${r.title} ` +
        `(failToPass ${r.failToPassPassed}/${r.failToPassTotal}, ` +
        `passToPass ${r.passToPassPassed}/${r.passToPassTotal}, ${r.durationMs}ms) — ${r.reason}`,
    );
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Bo task mau (tu viet, chay duoc that — khong can repo ngoai)
// ---------------------------------------------------------------------------

/** Task mau 1: sua ham cong bi sai dau (failToPass pass sau patch dung). */
export const CODING_V5_SWE_SAMPLE_TASK_FIX_ADD: CodingV5SweTask = {
  id: 'swe-sample-fix-add',
  title: 'Sua ham add tra ve hieu thay vi tong',
  issue: 'Ham add(a, b) trong calc.js tra ve a - b thay vi a + b. Sua de add(2, 3) tra ve 5.',
  fixtures: {
    'calc.js': 'function add(a, b) {\n  return a - b;\n}\n\nmodule.exports = { add };\n',
    'calc.test.js':
      "const assert = require('node:assert/strict');\nconst { add } = require('./calc');\nassert.equal(add(2, 3), 5);\nassert.equal(add(-1, 1), 0);\n",
  },
  patch:
    'diff --git a/calc.js b/calc.js\n' +
    '--- a/calc.js\n' +
    '+++ b/calc.js\n' +
    '@@ -1,3 +1,3 @@ function add(a, b) {\n' +
    ' function add(a, b) {\n' +
    '-  return a - b;\n' +
    '+  return a + b;\n' +
    ' }\n',
  testCommands: [{ name: 'calc-tests', argv: ['node', 'calc.test.js'] }],
  failToPass: ['calc-tests'],
  passToPass: [],
};

/** Task mau 2: patch sai (khong sua bug) — phai FAIL de kiem tra cham diem. */
export const CODING_V5_SWE_SAMPLE_TASK_WRONG_PATCH: CodingV5SweTask = {
  id: 'swe-sample-wrong-patch',
  title: 'Patch sai: doi ten bien nhung khong sua phep tinh',
  issue: 'Ham add(a, b) trong calc.js tra ve a - b thay vi a + b. Sua de add(2, 3) tra ve 5.',
  fixtures: {
    'calc.js': 'function add(a, b) {\n  return a - b;\n}\n\nmodule.exports = { add };\n',
    'calc.test.js':
      "const assert = require('node:assert/strict');\nconst { add } = require('./calc');\nassert.equal(add(2, 3), 5);\nassert.equal(add(-1, 1), 0);\n",
  },
  patch:
    'diff --git a/calc.js b/calc.js\n' +
    '--- a/calc.js\n' +
    '+++ b/calc.js\n' +
    '@@ -1,3 +1,3 @@ function add(a, b) {\n' +
    ' function add(a, b) {\n' +
    '-  return a - b;\n' +
    '+  return a - b; // renamed nothing, still wrong\n' +
    ' }\n',
  testCommands: [{ name: 'calc-tests', argv: ['node', 'calc.test.js'] }],
  failToPass: ['calc-tests'],
  passToPass: [],
};

/**
 * Task mau 3: patch pha vo test cu (passToPass) — kiem tra phat hien
 * hoi quy: sua add dung nhung xoa export cua ham mul.
 */
export const CODING_V5_SWE_SAMPLE_TASK_REGRESSION: CodingV5SweTask = {
  id: 'swe-sample-regression',
  title: 'Patch sua add dung nhung pha vo ham mul',
  issue: 'Ham add(a, b) trong calc.js tra ve a - b thay vi a + b. Sua de add(2, 3) tra ve 5.',
  fixtures: {
    'calc.js':
      'function add(a, b) {\n  return a - b;\n}\n\nfunction mul(a, b) {\n  return a * b;\n}\n\nmodule.exports = { add, mul };\n',
    'calc.test.js':
      "const assert = require('node:assert/strict');\nconst { add } = require('./calc');\nassert.equal(add(2, 3), 5);\n",
    'mul.test.js':
      "const assert = require('node:assert/strict');\nconst { mul } = require('./calc');\nassert.equal(mul(2, 3), 6);\n",
  },
  patch:
    'diff --git a/calc.js b/calc.js\n' +
    '--- a/calc.js\n' +
    '+++ b/calc.js\n' +
    '@@ -1,9 +1,5 @@ function add(a, b) {\n' +
    ' function add(a, b) {\n' +
    '-  return a - b;\n' +
    '+  return a + b;\n' +
    ' }\n' +
    ' \n' +
    '-function mul(a, b) {\n' +
    '-  return a * b;\n' +
    '-}\n' +
    '-\n' +
    '-module.exports = { add, mul };\n' +
    '+module.exports = { add };\n',
  testCommands: [
    { name: 'calc-tests', argv: ['node', 'calc.test.js'] },
    { name: 'mul-tests', argv: ['node', 'mul.test.js'] },
  ],
  failToPass: ['calc-tests'],
  passToPass: ['mul-tests'],
};

export const CODING_V5_SWE_SAMPLE_TASKS: CodingV5SweTask[] = [
  CODING_V5_SWE_SAMPLE_TASK_FIX_ADD,
  CODING_V5_SWE_SAMPLE_TASK_WRONG_PATCH,
  CODING_V5_SWE_SAMPLE_TASK_REGRESSION,
];

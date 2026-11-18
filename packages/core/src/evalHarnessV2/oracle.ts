/**
 * Eval Harness v2 — oracle solution validation (v1.34, Đội T4).
 *
 * Mỗi task mẫu kèm oracle solution chứng minh giải được + bộ test
 * pass/fail quyết định (không cần LLM judge). Task không có oracle
 * hợp lệ thì bị từ chối khi load/chạy:
 *
 * 1. Oracle phải chạy được: ghi oracle.files vào workdir, chạy
 *    oracle.commands (nếu có) — lệnh oracle lỗi → oracle không hợp lệ.
 * 2. Sau khi áp oracle, TOÀN BỘ test phải pass. Test nào fail sau
 *    oracle → oracle không chứng minh được task giải được → task bị
 *    từ chối (kèm tên test fail).
 * 3. Với issue-patch: test fail-to-pass phải FAIL trước khi áp oracle
 *    (trên repo snapshot gốc). Nếu đã pass sẵn thì test không phân
 *    biệt được đúng/sai (bug không tái hiện) → oracle không hợp lệ.
 * 4. Với state-check: không đo "trước" (trạng thái cuối mới là thứ
 *    chấm); chỉ cần oracle pass toàn bộ test sau khi áp.
 *
 * Validation chạy trong workdir tạm riêng (sandbox.ts), không chạm
 * host, timeout theo task.timeoutMs. Kết quả gồm chi tiết từng test
 * để người viết task sửa cho đúng.
 */

import {
  createEvalTrialWorkDir,
  removeEvalTrialWorkDir,
  runInEvalSandbox,
  writeFilesToWorkDir,
  type EvalHarnessV2SandboxResult,
} from './sandbox.js';
import type {
  EvalHarnessV2Task,
  EvalHarnessV2TestResult,
} from './types.js';

/** Kết quả validate oracle của một task. */
export interface EvalHarnessV2OracleValidation {
  taskId: string;
  /** true khi oracle chứng minh được task giải được. */
  valid: boolean;
  /** Chi tiết từng test sau khi áp oracle. */
  tests: EvalHarnessV2TestResult[];
  /** Test fail-to-pass nào đã pass sẵn trước oracle (chỉ issue-patch). */
  alreadyPassingBeforeOracle: string[];
  /** Lỗi chạy oracle (lệnh oracle fail/timeout) nếu có. */
  oracleError?: string;
  /** Cảnh báo (vd chạy fallback local, không cách ly). */
  sandboxWarning?: string;
  /** Tổng thời gian validate (ms). */
  durationMs: number;
}

/** Lỗi khi oracle không hợp lệ — task bị từ chối. */
export class EvalHarnessV2OracleError extends Error {
  readonly taskId: string;
  constructor(taskId: string, message: string) {
    super(message);
    this.name = 'EvalHarnessV2OracleError';
    this.taskId = taskId;
  }
}

async function runTestsInWorkDir(
  task: EvalHarnessV2Task,
  workDir: string,
): Promise<EvalHarnessV2TestResult[]> {
  const results: EvalHarnessV2TestResult[] = [];
  for (const test of task.tests) {
    const testStarted = Date.now();
    const timeoutMs = Math.min(test.timeoutMs ?? task.timeoutMs, task.timeoutMs);
    const res = await runInEvalSandbox(test.command, workDir, timeoutMs);
    results.push({
      testId: test.id,
      name: test.name,
      group: test.group ?? (task.kind === 'issue-patch' ? 'fail-to-pass' : 'state-check'),
      basePassed: null,
      afterPassed: res.passed,
      expectationMet: res.passed,
      weight: test.weight ?? 1,
      durationMs: Date.now() - testStarted,
      stdout: res.stdout,
      ...(res.passed ? {} : { stderr: res.stderr }),
      ...(res.timedOut ? { timedOut: true } : {}),
    });
  }
  return results;
}

/**
 * Chạy oracle của task trong workdir tạm và kiểm tra toàn bộ test.
 * Không throw khi oracle fail — trả về valid=false kèm chi tiết.
 * Chỉ throw khi workdir không tạo được (lỗi hệ thống).
 */
export async function validateOracleSolution(
  task: EvalHarnessV2Task,
): Promise<EvalHarnessV2OracleValidation> {
  const started = Date.now();
  const workDir = createEvalTrialWorkDir('eval-harness-v2-oracle-');
  let sandboxWarning: string | undefined;
  try {
    // 1. Materialize input: repo snapshot (issue-patch) + environment.
    const initialFiles: Record<string, string> = {
      ...(task.input.repoSnapshot ?? {}),
      ...(task.input.environmentFiles ?? {}),
    };
    writeFilesToWorkDir(workDir, initialFiles);

    // 2. Issue-patch: test fail-to-pass phải FAIL trước oracle.
    const alreadyPassingBeforeOracle: string[] = [];
    if (task.kind === 'issue-patch') {
      for (const test of task.tests) {
        const group = test.group ?? 'fail-to-pass';
        if (group !== 'fail-to-pass') continue;
        const res: EvalHarnessV2SandboxResult = await runInEvalSandbox(
          test.command,
          workDir,
          Math.min(test.timeoutMs ?? task.timeoutMs, task.timeoutMs),
        );
        if (res.sandboxWarning !== undefined) sandboxWarning = res.sandboxWarning;
        if (res.passed) alreadyPassingBeforeOracle.push(test.id);
      }
    }

    // 3. Áp oracle: ghi files rồi chạy commands.
    let oracleError: string | undefined;
    if (task.oracle.files !== undefined) {
      writeFilesToWorkDir(workDir, task.oracle.files);
    }
    for (const command of task.oracle.commands ?? []) {
      const res = await runInEvalSandbox(command, workDir, task.timeoutMs);
      if (res.sandboxWarning !== undefined) sandboxWarning = res.sandboxWarning;
      if (!res.passed) {
        oracleError = res.timedOut
          ? `Lệnh oracle timeout sau ${task.timeoutMs}ms: "${command.slice(0, 120)}"`
          : `Lệnh oracle fail (exit ${String(res.exitCode)}): "${command.slice(0, 120)}" — ${res.stderr.slice(0, 300)}`;
        break;
      }
    }

    // 4. Chạy toàn bộ test sau oracle.
    const tests = oracleError === undefined
      ? await runTestsInWorkDir(task, workDir)
      : [];
    const failedAfterOracle = tests.filter((t) => !t.afterPassed).map((t) => t.testId);
    const valid =
      oracleError === undefined &&
      alreadyPassingBeforeOracle.length === 0 &&
      tests.length > 0 &&
      failedAfterOracle.length === 0;

    return {
      taskId: task.id,
      valid,
      tests,
      alreadyPassingBeforeOracle,
      ...(oracleError !== undefined ? { oracleError } : {}),
      ...(sandboxWarning !== undefined ? { sandboxWarning } : {}),
      durationMs: Date.now() - started,
    };
  } finally {
    removeEvalTrialWorkDir(workDir);
  }
}

/**
 * Validate oracle và throw EvalHarnessV2OracleError khi không hợp lệ
 * (dùng khi load task: task không oracle hợp lệ thì bị từ chối).
 */
export async function assertValidOracleSolution(task: EvalHarnessV2Task): Promise<EvalHarnessV2OracleValidation> {
  const result = await validateOracleSolution(task);
  if (!result.valid) {
    const reasons: string[] = [];
    if (result.oracleError !== undefined) reasons.push(result.oracleError);
    if (result.alreadyPassingBeforeOracle.length > 0) {
      reasons.push(
        `Test fail-to-pass đã pass sẵn trước oracle (bug không tái hiện): ${result.alreadyPassingBeforeOracle.join(', ')}.`,
      );
    }
    const failed = result.tests.filter((t) => !t.afterPassed).map((t) => t.testId);
    if (failed.length > 0) {
      reasons.push(`Oracle không qua được test: ${failed.join(', ')}.`);
    }
    if (result.tests.length === 0 && result.oracleError === undefined) {
      reasons.push('Task không có test nào để oracle chứng minh.');
    }
    throw new EvalHarnessV2OracleError(
      task.id,
      `Oracle không hợp lệ cho task "${task.id}": ${reasons.join(' ')}`,
    );
  }
  return result;
}

/** Render kết quả validate oracle thành text (CLI/tool in ra). */
export function renderOracleValidationText(result: EvalHarnessV2OracleValidation): string {
  const lines: string[] = [
    `Oracle task ${result.taskId}: ${result.valid ? 'VALID' : 'INVALID'} (${result.durationMs}ms)`,
  ];
  if (result.oracleError !== undefined) lines.push(`  oracle error: ${result.oracleError}`);
  for (const id of result.alreadyPassingBeforeOracle) {
    lines.push(`  already passing before oracle: ${id}`);
  }
  for (const t of result.tests) {
    lines.push(`  ${t.afterPassed ? 'PASS' : 'FAIL'}  ${t.testId} (${t.durationMs}ms)`);
  }
  if (result.sandboxWarning !== undefined) lines.push(`  warning: ${result.sandboxWarning}`);
  return `${lines.join('\n')}\n`;
}

/**
 * Eval Harness v3 — oracle validation (v1.35, Đội T4).
 *
 * Oracle là bằng chứng task giải được: áp oracle (files + commands)
 * lên workdir sạch rồi chạy toàn bộ test — mọi test phải pass, và
 * phải pass ỔN ĐỊNH qua N lần chạy (mặc định 3). Một test pass lần 1
 * fail lần 2 là test flaky → task bị từ chối, vì điểm eval lúc đó
 * phụ thuộc may rủi chứ không phụ thuộc agent.
 *
 * Với task issue-patch còn kiểm tra thêm chiều ngược: test
 * fail-to-pass PHẢI FAIL trước khi áp oracle (nếu nó pass sẵn thì
 * task vô nghĩa — agent không cần làm gì cũng pass).
 *
 * Validation chạy trong cùng container với trial (sandbox.ts) nên
 * kết quả oracle khớp với kết quả trial: cùng image, cùng lệnh, cùng
 * timeout. Lỗi setup container → oracle `error`, không phải `invalid`
 * vì test fail — phân biệt rõ để người sửa task biết lỗi ở đâu.
 */

import {
  createEvalHarnessV3TrialWorkDir,
  removeEvalHarnessV3TrialWorkDir,
  runInEvalContainer,
  writeEvalHarnessV3FilesToWorkDir,
} from './sandbox.js';
import {
  EVAL_HARNESS_V3_DEFAULT_ORACLE_REPEATS,
  defaultEvalHarnessV3TestGroup,
  normalizeContainerSpec,
  type EvalHarnessV3Task,
} from './types.js';

/** Kết quả validate oracle của một task. */
export interface EvalHarnessV3OracleValidation {
  taskId: string;
  /** true khi oracle qua hết test, ổn định qua N lần, và fail-to-pass fail trước oracle. */
  valid: boolean;
  /** Lỗi setup container (image pull fail, bwrap lỗi...) — khác với test fail. */
  setupError?: string;
  /** Mỗi test: pass bao nhiêu lần / tổng số lần chạy oracle. */
  perTest: Array<{
    testId: string;
    name: string;
    group: 'fail-to-pass' | 'pass-to-pass' | 'state-check';
    /** Pass trước khi áp oracle (chỉ issue-patch; null = không đo). */
    basePassed: boolean | null;
    /** Số lần pass sau oracle / tổng số lần chạy. */
    passes: number;
    runs: number;
    /** Test có flaky không (kết quả khác nhau giữa các lần chạy). */
    flaky: boolean;
  }>;
  /** Số lần chạy oracle (mặc định 3). */
  repeats: number;
  /** Lý do ngắn khi invalid (vd `test add-returns-sum flaky 2/3`). */
  reason: string;
  /** Thời gian validate (ms). */
  durationMs: number;
}

/** Lỗi khi oracle không hợp lệ (dùng cho assertValidOracleSolutionV3). */
export class EvalHarnessV3OracleError extends Error {
  readonly validation: EvalHarnessV3OracleValidation;
  constructor(validation: EvalHarnessV3OracleValidation) {
    super(`Oracle không hợp lệ cho task ${validation.taskId}: ${validation.reason}`);
    this.name = 'EvalHarnessV3OracleError';
    this.validation = validation;
  }
}

export interface EvalHarnessV3OracleOptions {
  /** Số lần chạy oracle để kiểm tra ổn định (mặc định 3). */
  repeats?: number;
  /** Giữ lại workdir sau lần chạy cuối để debug (mặc định false). */
  keepWorkDir?: boolean;
  /** Timeout mỗi lần chạy test (mặc định = task.timeoutMs). */
  timeoutMs?: number;
}

/**
 * Chạy oracle validation cho một task. Không throw vì oracle fail —
 * fail là kết quả (valid=false). Chỉ throw khi không tạo được workdir.
 */
export async function validateOracleSolutionV3(
  task: EvalHarnessV3Task,
  options: EvalHarnessV3OracleOptions = {},
): Promise<EvalHarnessV3OracleValidation> {
  const startedAt = Date.now();
  const repeats = Math.max(1, Math.min(options.repeats ?? EVAL_HARNESS_V3_DEFAULT_ORACLE_REPEATS, 10));
  const timeoutMs = options.timeoutMs ?? task.timeoutMs;
  const container = normalizeContainerSpec(task.container);
  const workDir = createEvalHarnessV3TrialWorkDir('eval-harness-v3-oracle-');
  try {
    // 1. Materialize input (snapshot + environment).
    writeEvalHarnessV3FilesToWorkDir(workDir, {
      ...(task.input.repoSnapshot ?? {}),
      ...(task.input.environmentFiles ?? {}),
    });

    // 2. Base test (chỉ issue-patch): fail-to-pass phải fail trước oracle.
    const basePassed = new Map<string, boolean>();
    if (task.kind === 'issue-patch') {
      for (const test of task.tests) {
        const group = test.group ?? defaultEvalHarnessV3TestGroup(task.kind);
        if (group !== 'fail-to-pass') continue;
        const res = await runInEvalContainer(test.command, workDir, container, Math.min(test.timeoutMs ?? timeoutMs, timeoutMs));
        if (res.setupError !== undefined) {
          return {
            taskId: task.id,
            valid: false,
            setupError: res.setupError,
            perTest: [],
            repeats,
            reason: `Lỗi setup container khi đo base test: ${res.setupError.slice(0, 200)}`,
            durationMs: Date.now() - startedAt,
          };
        }
        basePassed.set(test.id, res.passed);
      }
    }

    // 3. Áp oracle: ghi files rồi chạy commands.
    writeEvalHarnessV3FilesToWorkDir(workDir, task.oracle.files ?? {});
    for (const command of task.oracle.commands ?? []) {
      const res = await runInEvalContainer(command, workDir, container, timeoutMs);
      if (res.setupError !== undefined) {
        return {
          taskId: task.id,
          valid: false,
          setupError: res.setupError,
          perTest: [],
          repeats,
          reason: `Lỗi setup container khi chạy oracle command: ${res.setupError.slice(0, 200)}`,
          durationMs: Date.now() - startedAt,
        };
      }
      if (!res.passed) {
        return {
          taskId: task.id,
          valid: false,
          perTest: [],
          repeats,
          reason: `Oracle command fail (exit ${String(res.exitCode)}): "${command.slice(0, 120)}".`,
          durationMs: Date.now() - startedAt,
        };
      }
    }

    // 4. Chạy toàn bộ test N lần trên cùng workdir đã áp oracle.
    // (Oracle files đã ghi — các lần chạy sau kiểm tra test có ổn
    // định không, không áp lại oracle.)
    const passes = new Map<string, number>();
    const seenOutcomes = new Map<string, Set<boolean>>();
    for (const test of task.tests) {
      passes.set(test.id, 0);
      seenOutcomes.set(test.id, new Set());
    }
    for (let run = 0; run < repeats; run += 1) {
      for (const test of task.tests) {
        const res = await runInEvalContainer(
          test.command,
          workDir,
          container,
          Math.min(test.timeoutMs ?? timeoutMs, timeoutMs),
        );
        if (res.setupError !== undefined) {
          return {
            taskId: task.id,
            valid: false,
            setupError: res.setupError,
            perTest: [],
            repeats,
            reason: `Lỗi setup container khi chạy test oracle (lần ${run + 1}): ${res.setupError.slice(0, 200)}`,
            durationMs: Date.now() - startedAt,
          };
        }
        if (res.passed) passes.set(test.id, (passes.get(test.id) ?? 0) + 1);
        seenOutcomes.get(test.id)?.add(res.passed);
      }
    }

    // 5. Kết luận: mọi test pass đủ N lần + fail-to-pass fail trước oracle.
    const perTest: EvalHarnessV3OracleValidation['perTest'] = task.tests.map((test) => {
      const group = test.group ?? defaultEvalHarnessV3TestGroup(task.kind);
      const outcomes = seenOutcomes.get(test.id) ?? new Set<boolean>();
      return {
        testId: test.id,
        name: test.name,
        group,
        basePassed: basePassed.has(test.id) ? basePassed.get(test.id) ?? null : null,
        passes: passes.get(test.id) ?? 0,
        runs: repeats,
        flaky: outcomes.size > 1,
      };
    });
    const failures: string[] = [];
    for (const entry of perTest) {
      if (entry.group === 'fail-to-pass' && entry.basePassed === true) {
        failures.push(`test ${entry.testId} pass sẵn trước oracle (fail-to-pass phải fail trước patch)`);
      }
      if (entry.passes !== entry.runs) {
        failures.push(`test ${entry.testId} chỉ pass ${entry.passes}/${entry.runs} lần sau oracle`);
      }
      if (entry.flaky) {
        failures.push(`test ${entry.testId} flaky (kết quả khác nhau giữa các lần chạy)`);
      }
    }
    return {
      taskId: task.id,
      valid: failures.length === 0,
      perTest,
      repeats,
      reason: failures.length === 0
        ? `Oracle qua hết ${task.tests.length} test, ổn định ${repeats}/${repeats} lần.`
        : failures.join('; '),
      durationMs: Date.now() - startedAt,
    };
  } finally {
    if (!options.keepWorkDir) removeEvalHarnessV3TrialWorkDir(workDir);
  }
}

/** Validate oracle và throw EvalHarnessV3OracleError khi không hợp lệ. */
export async function assertValidOracleSolutionV3(
  task: EvalHarnessV3Task,
  options: EvalHarnessV3OracleOptions = {},
): Promise<EvalHarnessV3OracleValidation> {
  const result = await validateOracleSolutionV3(task, options);
  if (!result.valid) throw new EvalHarnessV3OracleError(result);
  return result;
}

/** Render kết quả oracle validation thành text đọc được. */
export function renderOracleValidationTextV3(result: EvalHarnessV3OracleValidation): string {
  const lines: string[] = [
    `Oracle task ${result.taskId}: ${result.valid ? 'VALID' : 'INVALID'} — ${result.reason}`,
  ];
  if (result.setupError !== undefined) {
    lines.push(`  Lỗi setup: ${result.setupError}`);
  }
  for (const entry of result.perTest) {
    const base =
      entry.basePassed === null ? '' : entry.basePassed ? ' (base: pass)' : ' (base: fail)';
    const flaky = entry.flaky ? ' FLAKY' : '';
    lines.push(`  ${entry.passes}/${entry.runs} ${entry.testId} [${entry.group}]${base}${flaky}`);
  }
  return `${lines.join('\n')}\n`;
}

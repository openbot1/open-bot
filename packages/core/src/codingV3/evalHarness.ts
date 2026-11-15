/**
 * Eval harness kiểu Terminal-Bench cho coding agent v3 (v1.10, Đội T4).
 *
 * Ý tưởng học từ Terminal-Bench (task = repo + lệnh setup + lệnh test
 * chấm điểm, chạy trong sandbox, chấm pass/fail tự động): chỉ học ý
 * tưởng, tự thiết kế và viết lại hoàn toàn — KHÔNG đọc, KHÔNG copy
 * code/text/tài sản của repo nào.
 *
 *   - Một eval task: id + mô tả + lệnh setup (chuẩn bị fixture) +
 *     lệnh test (chấm điểm, exit 0 = pass) + timeout.
 *   - Runner: tạo thư mục tạm (mkdtemp, tiền tố `open-bot-eval-`),
 *     chạy setup rồi test bằng `spawn` (argv tách sẵn, không shell
 *     string — tránh command injection), capture stdout/stderr có
 *     cắt ngắn, chấm điểm từng lệnh test.
 *   - Chấm điểm: task pass khi setup ok VÀ mọi lệnh test exit 0.
 *     Setup lỗi => status `error` (không tính fail — lỗi hạ tầng).
 *     Test lỗi/timeout => `fail`.
 *   - Báo cáo suite: pass rate, thời gian từng task, log đầy đủ.
 *
 * An toàn: lệnh chạy KHÔNG qua shell (argv), cwd luôn là thư mục
 * tạm vừa tạo (hoặc workDir caller chỉ định và phải tồn tại), timeout
 * giết cả cây process (detached + kill nhóm khi có thể), env tối
 * thiểu (chỉ PATH + biến caller cho phép).
 *
 * Giới hạn trung thực:
 *   - Không phải Docker sandbox thật — chỉ là thư mục tạm trên máy
 *     này; task độc hại vẫn có thể chạm file ngoài cwd qua đường
 *     dẫn tuyệt đối (chỉ dùng task tự viết/tin cậy).
 *   - Chấm điểm theo exit code, không chấm theo nội dung output.
 */

import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// ---------------------------------------------------------------------------
// Kiểu dữ liệu
// ---------------------------------------------------------------------------

export interface CodingV3EvalCommand {
  /** Tên hiển thị (vd "setup: npm install"). */
  name: string;
  /** Lệnh, dạng argv (không shell string). */
  argv: string[];
  /** Timeout riêng cho lệnh này (ms). Mặc định lấy task timeout. */
  timeoutMs?: number;
}

export interface CodingV3EvalTask {
  id: string;
  title: string;
  description?: string;
  /** Lệnh setup chạy trước test (chuẩn bị fixture). */
  setupCommands?: CodingV3EvalCommand[];
  /** Lệnh test chấm điểm (exit 0 = pass). Ít nhất 1 lệnh. */
  testCommands: CodingV3EvalCommand[];
  /** Timeout mặc định mỗi lệnh (ms). Mặc định 30_000. */
  timeoutMs?: number;
  /** Biến môi trường thêm cho lệnh (ngoài PATH). */
  env?: Record<string, string>;
  /** File fixture ghi vào thư mục tạm trước khi setup: relPath -> nội dung. */
  fixtures?: Record<string, string>;
}

export interface CodingV3EvalCommandResult {
  name: string;
  argv: string[];
  /** 'setup' | 'test'. */
  phase: 'setup' | 'test';
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  passed: boolean;
  stdout: string;
  stderr: string;
  durationMs: number;
}

export type CodingV3EvalTaskStatus = 'pass' | 'fail' | 'error';

export interface CodingV3EvalTaskResult {
  taskId: string;
  title: string;
  status: CodingV3EvalTaskStatus;
  workDir: string;
  /** true khi thư mục tạm đã được dọn (mặc định dọn sau khi chạy). */
  workDirKept: boolean;
  setup: CodingV3EvalCommandResult[];
  tests: CodingV3EvalCommandResult[];
  passedTests: number;
  totalTests: number;
  durationMs: number;
  /** Lý do error/fail ngắn gọn. */
  reason: string;
  startedAt: string;
  finishedAt: string;
}

export interface CodingV3EvalSuiteReport {
  suiteId: string;
  totalTasks: number;
  passed: number;
  failed: number;
  errored: number;
  passRate: number;
  results: CodingV3EvalTaskResult[];
  durationMs: number;
  startedAt: string;
  finishedAt: string;
  summary: string;
}

export const CODING_V3_EVAL_DEFAULT_TIMEOUT_MS = 30_000;
/** Trần output giữ lại mỗi lệnh (ký tự). */
export const CODING_V3_EVAL_MAX_OUTPUT_CHARS = 20_000;
/** Trần lệnh test mỗi task (chống task vô hạn). */
export const CODING_V3_EVAL_MAX_COMMANDS_PER_TASK = 20;

function truncateOutput(text: string): string {
  if (text.length <= CODING_V3_EVAL_MAX_OUTPUT_CHARS) return text;
  return `${text.slice(0, CODING_V3_EVAL_MAX_OUTPUT_CHARS)}\n... (truncated, ${text.length - CODING_V3_EVAL_MAX_OUTPUT_CHARS} chars omitted)`;
}

function validateTask(task: CodingV3EvalTask): void {
  if (!task.id || typeof task.id !== 'string' || task.id.trim() === '') {
    throw new Error('Eval task cần id không rỗng.');
  }
  if (!/^[a-z0-9][a-z0-9-]*$/.test(task.id)) {
    throw new Error(`Eval task id "${task.id}" chỉ dùng chữ thường/số/gạch ngang, bắt đầu bằng chữ/số.`);
  }
  if (!Array.isArray(task.testCommands) || task.testCommands.length === 0) {
    throw new Error(`Eval task "${task.id}" cần ít nhất 1 test command.`);
  }
  const all = [...(task.setupCommands ?? []), ...task.testCommands];
  if (all.length > CODING_V3_EVAL_MAX_COMMANDS_PER_TASK) {
    throw new Error(
      `Eval task "${task.id}" có ${all.length} lệnh, vượt trần ${CODING_V3_EVAL_MAX_COMMANDS_PER_TASK}.`,
    );
  }
  for (const cmd of all) {
    if (!cmd.name || typeof cmd.name !== 'string') {
      throw new Error(`Eval task "${task.id}" có lệnh thiếu name.`);
    }
    if (!Array.isArray(cmd.argv) || cmd.argv.length === 0 || cmd.argv.some((a) => typeof a !== 'string')) {
      throw new Error(`Eval task "${task.id}" lệnh "${cmd.name}" cần argv là mảng string không rỗng.`);
    }
  }
}

interface SpawnOutcome {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
}

/** Chạy một lệnh argv (không shell), có timeout, capture output. */
export function runCodingV3EvalCommand(
  argv: string[],
  options: { cwd: string; timeoutMs: number; env?: Record<string, string> },
): Promise<SpawnOutcome> {
  return new Promise((resolve) => {
    const [command, ...args] = argv as [string, ...string[]];
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, args, {
        cwd: options.cwd,
        env: { PATH: process.env.PATH ?? '', ...(options.env ?? {}) },
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
        shell: false,
      });
    } catch (e) {
      resolve({
        exitCode: null,
        signal: null,
        timedOut: false,
        stdout: '',
        stderr: e instanceof Error ? e.message : String(e),
      });
      return;
    }
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    // stdio đã đặt ['ignore', 'pipe', 'pipe'] nên stdout/stderr luôn có.
    const stdoutStream = child.stdout!;
    const stderrStream = child.stderr!;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (child.pid !== undefined && process.platform !== 'win32') {
          process.kill(-child.pid, 'SIGKILL');
        } else {
          child.kill('SIGKILL');
        }
      } catch {
        child.kill('SIGKILL');
      }
    }, options.timeoutMs);
    stdoutStream.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    stderrStream.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ exitCode: null, signal: null, timedOut, stdout, stderr: err.message });
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ exitCode: code, signal: signal ? String(signal) : null, timedOut, stdout, stderr });
    });
  });
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

export interface CodingV3EvalRunOptions {
  /** Giữ thư mục tạm sau khi chạy (mặc định false: dọn). */
  keepWorkDir?: boolean;
  /** Thư mục cha cho thư mục tạm (mặc định os.tmpdir()). */
  tmpBase?: string;
  /** Thư mục làm việc có sẵn thay vì tạo thư mục tạm (phải tồn tại). */
  workDir?: string;
}

export class CodingV3EvalHarness {
  async runTask(
    task: CodingV3EvalTask,
    options: CodingV3EvalRunOptions = {},
  ): Promise<CodingV3EvalTaskResult> {
    validateTask(task);
    const startedAt = Date.now();
    const defaultTimeout = Math.max(
      1000,
      Math.floor(task.timeoutMs ?? CODING_V3_EVAL_DEFAULT_TIMEOUT_MS),
    );
    let workDir: string;
    let createdTempDir = false;
    if (options.workDir) {
      if (!fs.existsSync(options.workDir) || !fs.statSync(options.workDir).isDirectory()) {
        throw new Error(`Eval workDir không tồn tại: ${options.workDir}`);
      }
      workDir = path.resolve(options.workDir);
    } else {
      workDir = fs.mkdtempSync(path.join(options.tmpBase ?? os.tmpdir(), `open-bot-eval-${task.id}-`));
      createdTempDir = true;
    }
    const keepWorkDir = options.keepWorkDir ?? false;

    const setup: CodingV3EvalCommandResult[] = [];
    const tests: CodingV3EvalCommandResult[] = [];
    let reason = '';
    let status: CodingV3EvalTaskStatus = 'pass';

    try {
      // Fixture: ghi file trước setup.
      for (const [relPath, content] of Object.entries(task.fixtures ?? {})) {
        const resolved = path.resolve(workDir, relPath);
        if (resolved !== workDir && !resolved.startsWith(workDir + path.sep)) {
          throw new Error(`Fixture "${relPath}" thoát khỏi workDir — từ chối.`);
        }
        fs.mkdirSync(path.dirname(resolved), { recursive: true });
        fs.writeFileSync(resolved, content, 'utf8');
      }

      const runOne = async (
        cmd: CodingV3EvalCommand,
        phase: 'setup' | 'test',
      ): Promise<CodingV3EvalCommandResult> => {
        const cmdStartedAt = Date.now();
        const timeoutMs = Math.max(100, Math.floor(cmd.timeoutMs ?? defaultTimeout));
        const outcome = await runCodingV3EvalCommand(cmd.argv, { cwd: workDir, timeoutMs, env: task.env });
        return {
          name: cmd.name,
          argv: cmd.argv,
          phase,
          exitCode: outcome.exitCode,
          signal: outcome.signal,
          timedOut: outcome.timedOut,
          passed: !outcome.timedOut && outcome.exitCode === 0,
          stdout: truncateOutput(outcome.stdout),
          stderr: truncateOutput(outcome.stderr),
          durationMs: Date.now() - cmdStartedAt,
        };
      };

      for (const cmd of task.setupCommands ?? []) {
        const result = await runOne(cmd, 'setup');
        setup.push(result);
        if (!result.passed) {
          status = 'error';
          reason = result.timedOut
            ? `Setup "${cmd.name}" timeout sau ${result.durationMs}ms.`
            : `Setup "${cmd.name}" exit ${String(result.exitCode)}${result.stderr ? `: ${result.stderr.split('\n')[0]}` : ''}`;
          break;
        }
      }

      if (status === 'pass') {
        for (const cmd of task.testCommands) {
          const result = await runOne(cmd, 'test');
          tests.push(result);
          if (!result.passed) {
            status = 'fail';
            reason = result.timedOut
              ? `Test "${cmd.name}" timeout sau ${result.durationMs}ms.`
              : `Test "${cmd.name}" exit ${String(result.exitCode)}${result.stderr ? `: ${result.stderr.split('\n')[0]}` : ''}`;
          }
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
          // Dọn thất bại: báo qua workDirKept = true (thư mục vẫn còn).
        }
      }
    }

    const finishedAt = Date.now();
    const workDirKept = keepWorkDir || !createdTempDir || fs.existsSync(workDir);
    const passedTests = tests.filter((t) => t.passed).length;
    if (status === 'pass') reason = `Tất cả ${tests.length} test(s) pass.`;
    return {
      taskId: task.id,
      title: task.title,
      status,
      workDir,
      workDirKept,
      setup,
      tests,
      passedTests,
      totalTests: task.testCommands.length,
      durationMs: finishedAt - startedAt,
      reason,
      startedAt: new Date(startedAt).toISOString(),
      finishedAt: new Date(finishedAt).toISOString(),
    };
  }

  async runSuite(
    tasks: CodingV3EvalTask[],
    options: CodingV3EvalRunOptions = {},
  ): Promise<CodingV3EvalSuiteReport> {
    const startedAt = Date.now();
    const suiteId = `eval-suite-${startedAt}`;
    const results: CodingV3EvalTaskResult[] = [];
    for (const task of tasks) {
      try {
        results.push(await this.runTask(task, options));
      } catch (e) {
        // validateTask lỗi: ghi một result error thay vì dừng cả suite.
        const now = new Date().toISOString();
        results.push({
          taskId: task.id || '(unknown)',
          title: task.title || '(unknown)',
          status: 'error',
          workDir: '',
          workDirKept: false,
          setup: [],
          tests: [],
          passedTests: 0,
          totalTests: Array.isArray(task.testCommands) ? task.testCommands.length : 0,
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
      summary: `Eval suite ${suiteId}: ${passed}/${results.length} task(s) pass (${failed} fail, ${errored} error) in ${finishedAt - startedAt}ms.`,
    };
  }
}

// ---------------------------------------------------------------------------
// Bộ task mẫu (tự viết, chạy được thật — không cần repo ngoài)
// ---------------------------------------------------------------------------

/**
 * Task mẫu 1: agent viết hàm cộng rồi test tự kiểm tra.
 * Setup ghi `add.js`, test chạy node assert kết quả.
 */
export const CODING_V3_SAMPLE_TASK_ADD: CodingV3EvalTask = {
  id: 'sample-add',
  title: 'Viết hàm cộng và kiểm tra',
  description: 'Setup tạo add.js; test assert add(2, 3) === 5 và add(-1, 1) === 0.',
  fixtures: {
    'add.js': `function add(a, b) { return a + b; }\nmodule.exports = { add };\n`,
  },
  testCommands: [
    {
      name: 'assert add',
      argv: [
        process.execPath,
        '-e',
        `const { add } = require('./add.js'); if (add(2, 3) !== 5) { console.error('add(2,3) wrong'); process.exit(1); } if (add(-1, 1) !== 0) { console.error('add(-1,1) wrong'); process.exit(1); } console.log('add ok');`,
      ],
    },
  ],
};

/**
 * Task mẫu 2: agent sửa lỗi — fixture cố tình sai, setup sửa lại
 * bằng node script, test kiểm tra kết quả đúng.
 */
export const CODING_V3_SAMPLE_TASK_FIX: CodingV3EvalTask = {
  id: 'sample-fix',
  title: 'Sửa hàm trừ bị sai dấu',
  description: 'Fixture sub.js trừ ngược (b - a); setup sửa thành a - b; test assert sub(5, 3) === 2.',
  fixtures: {
    'sub.js': `function sub(a, b) { return b - a; }\nmodule.exports = { sub };\n`,
  },
  setupCommands: [
    {
      name: 'fix sub.js',
      argv: [
        process.execPath,
        '-e',
        `const fs = require('fs'); const s = fs.readFileSync('./sub.js', 'utf8'); fs.writeFileSync('./sub.js', s.replace('return b - a;', 'return a - b;')); console.log('fixed');`,
      ],
    },
  ],
  testCommands: [
    {
      name: 'assert sub',
      argv: [
        process.execPath,
        '-e',
        `const { sub } = require('./sub.js'); if (sub(5, 3) !== 2) { console.error('sub(5,3) wrong:', sub(5, 3)); process.exit(1); } console.log('sub ok');`,
      ],
    },
  ],
};

/**
 * Task mẫu 3: agent tạo file mới từ spec rồi test đọc lại.
 */
export const CODING_V3_SAMPLE_TASK_CREATE: CodingV3EvalTask = {
  id: 'sample-create',
  title: 'Tạo module greet theo spec',
  description: 'Setup tạo greet.js theo spec; test assert greet("Huy") chứa "Huy" và bắt đầu bằng "Xin chào".',
  setupCommands: [
    {
      name: 'create greet.js',
      argv: [
        process.execPath,
        '-e',
        `const fs = require('fs'); fs.writeFileSync('./greet.js', 'function greet(name) { return "Xin chào " + name; }\\nmodule.exports = { greet };\\n'); console.log('created');`,
      ],
    },
  ],
  testCommands: [
    {
      name: 'assert greet',
      argv: [
        process.execPath,
        '-e',
        `const { greet } = require('./greet.js'); const out = greet('Huy'); if (!out.startsWith('Xin chào') || !out.includes('Huy')) { console.error('greet wrong:', out); process.exit(1); } console.log('greet ok:', out);`,
      ],
    },
    {
      name: 'greet file exists',
      argv: [process.execPath, '-e', `const fs = require('fs'); if (!fs.existsSync('./greet.js')) process.exit(1); console.log('file exists');`],
    },
  ],
};

/** Toàn bộ task mẫu (chạy thật, không cần mạng/key). */
export const CODING_V3_SAMPLE_TASKS: CodingV3EvalTask[] = [
  CODING_V3_SAMPLE_TASK_ADD,
  CODING_V3_SAMPLE_TASK_FIX,
  CODING_V3_SAMPLE_TASK_CREATE,
];

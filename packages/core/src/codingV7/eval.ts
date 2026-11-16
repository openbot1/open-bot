/**
 * Eval v7 (v1.15, Đội T4) — đo pass rate của coding agent trên repo mẫu.
 *
 * Ý tưởng học benchmark (SWE-Bench/GAIA) mà OpenHands V1 SDK báo cáo
 * (survey v1.15 §3): task có repo khởi tạo + lệnh kiểm tra khách quan
 * (exit 0 = pass). v7 thu nhỏ về 3 task mẫu chạy thật trong /tmp:
 * - `v7eval-fix-off-by-one`: sửa bug off-by-one trong hàm sum_range.
 * - `v7eval-add-function`: thêm hàm `is_prime` + test cho nó.
 * - `v7eval-fix-failing-test`: sửa code để test đang đỏ thành xanh.
 *
 * Harness:
 * - `createV7SampleRepo(task, dir)`: ghi seed files ra thư mục.
 * - `runV7EvalTask(task, generate, opts)`: tạo repo mẫu → chạy
 *   CodingAgentV7 với model generator do caller tiêm (scripted hoặc
 *   model thật) → chạy checkCommand → pass/fail.
 * - `runV7Eval(tasks, generate, opts)`: chạy cả bộ, trả V7EvalReport
 *   (pass rate). Dọn repo mẫu sau mỗi task (trừ khi keepRepos=true).
 *
 * Model generator KHÔNG đi kèm eval: test/scripted model quyết định
 * agent "giỏi" tới đâu; eval chỉ đo khách quan bằng checkCommand.
 * Không gọi model thật, không gọi mạng.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { V7EvalReport, V7EvalTask, V7EvalTaskResult, V7ModelGenerator } from './types';
import { CodingV7Log } from './conversationLog';
import { CodingAgentV7 } from './agent';
import { V7CodeActExecutor, runV7Shell } from './codeactV3';

/**
 * Lệnh kiểm tra không phụ thuộc pytest (chỉ dùng stdlib): import
 * module test và gọi mọi hàm `test_*`. pytest có thể không có trên
 * máy CI/VM khác; eval phải chạy được ở mọi nơi có python3.
 */
export function v7PythonCheckCommand(testModule: string): string {
  return (
    `python3 -c "import ${testModule}; ` +
    `[f() for n, f in vars(${testModule}).items() if n.startswith('test_')]; ` +
    `print('all tests passed')"`
  );
}

/** 3 task mẫu của eval v7 (seed + check đều chạy thật). */
export const V7_EVAL_TASKS: readonly V7EvalTask[] = [
  {
    id: 'v7eval-fix-off-by-one',
    title: 'Fix off-by-one in sum_range',
    prompt: 'Fix the bug in calc.py: sum_range(n) should return 1+2+...+n. Run the tests to confirm.',
    seedFiles: {
      'calc.py': [
        'def sum_range(n):',
        '    total = 0',
        '    for i in range(n):  # BUG: misses n itself',
        '        total += i',
        '    return total',
        '',
      ].join('\n'),
      'test_calc.py': [
        'from calc import sum_range',
        '',
        'def test_sum_range():',
        '    assert sum_range(5) == 15',
        '    assert sum_range(1) == 1',
        '    assert sum_range(0) == 0',
        '',
      ].join('\n'),
    },
    checkCommand: v7PythonCheckCommand('test_calc'),
  },
  {
    id: 'v7eval-add-function',
    title: 'Add is_prime function with test',
    prompt: 'Add a function is_prime(n) to calc.py that returns True for prime numbers, and add a test for it in test_calc.py. Run the tests to confirm.',
    seedFiles: {
      'calc.py': [
        'def sum_range(n):',
        '    return sum(range(n + 1))',
        '',
      ].join('\n'),
      'test_calc.py': [
        'from calc import sum_range',
        '',
        'def test_sum_range():',
        '    assert sum_range(5) == 15',
        '',
      ].join('\n'),
    },
    checkCommand: v7PythonCheckCommand('test_calc'),
  },
  {
    id: 'v7eval-fix-failing-test',
    title: 'Fix failing test: greet returns wrong case',
    prompt: 'The test in test_greet.py is failing. Fix greet.py so greet("huy") returns "Hello, Huy" (capitalized name). Run the tests to confirm.',
    seedFiles: {
      'greet.py': [
        'def greet(name):',
        '    return f"Hello, {name}"  # BUG: name not capitalized',
        '',
      ].join('\n'),
      'test_greet.py': [
        'from greet import greet',
        '',
        'def test_greet_capitalizes():',
        '    assert greet("huy") == "Hello, Huy"',
        '    assert greet("an") == "Hello, An"',
        '',
      ].join('\n'),
    },
    checkCommand: v7PythonCheckCommand('test_greet'),
  },
];

/** Tùy chọn chạy eval. */
export interface V7EvalOptions {
  /** Thư mục cha chứa repo mẫu (mặc định os.tmpdir()). */
  baseDir?: string;
  /** Số step tối đa mỗi task. Mặc định 12. */
  maxSteps?: number;
  /** Giữ lại repo mẫu sau khi chạy (mặc định false = dọn). */
  keepRepos?: boolean;
  /** Token budget cho agent mỗi task. */
  tokenBudget?: number;
}

/** Ghi seed files của task ra thư mục (tạo thư mục nếu chưa có). */
export function createV7SampleRepo(task: V7EvalTask, dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  for (const [relPath, content] of Object.entries(task.seedFiles)) {
    const target = path.join(dir, relPath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, 'utf8');
  }
  return dir;
}

/** Chạy một task eval (repo mẫu thật + agent thật + check thật). */
export async function runV7EvalTask(
  task: V7EvalTask,
  generate: V7ModelGenerator,
  options: V7EvalOptions = {},
): Promise<V7EvalTaskResult> {
  const started = Date.now();
  const baseDir = options.baseDir ?? os.tmpdir();
  const repoDir = fs.mkdtempSync(path.join(baseDir, `open-bot-v7eval-${task.id}-`));
  try {
    createV7SampleRepo(task, repoDir);
    const log = new CodingV7Log(`eval-${task.id}`);
    const executor = new V7CodeActExecutor({ workingDir: repoDir });
    const agent = new CodingAgentV7(log, {
      generate,
      executor,
      maxSteps: options.maxSteps ?? 12,
      ...(options.tokenBudget !== undefined ? { tokenBudget: options.tokenBudget } : {}),
    });
    agent.startTask(task.title, task.prompt);
    const turn = await agent.runTurn();
    const state = log.state();

    const check = await runV7Shell(task.checkCommand, repoDir, task.checkTimeoutMs ?? 30_000);
    const passed = check.exitCode === 0 && !check.timedOut;
    return {
      taskId: task.id,
      title: task.title,
      passed,
      steps: turn.steps,
      actions: state.actionsExecuted,
      blocked: turn.blocked,
      durationMs: Date.now() - started,
      checkOutput: [check.stdout, check.stderr].filter(Boolean).join('\n').slice(0, 2000),
    };
  } catch (err) {
    return {
      taskId: task.id,
      title: task.title,
      passed: false,
      steps: 0,
      actions: 0,
      blocked: 0,
      durationMs: Date.now() - started,
      checkOutput: '',
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    if (!options.keepRepos) {
      fs.rmSync(repoDir, { recursive: true, force: true });
    }
  }
}

/** Chạy cả bộ eval, trả report có pass rate. */
export async function runV7Eval(
  tasks: readonly V7EvalTask[],
  generate: V7ModelGenerator,
  options: V7EvalOptions = {},
): Promise<V7EvalReport> {
  const results: V7EvalTaskResult[] = [];
  for (const task of tasks) {
    results.push(await runV7EvalTask(task, generate, options));
  }
  const passed = results.filter((r) => r.passed).length;
  return {
    at: new Date().toISOString(),
    total: results.length,
    passed,
    passRate: results.length === 0 ? 0 : passed / results.length,
    results,
  };
}

/**
 * Scripted model generator cho eval/test: trả lần lượt các text trong
 * danh sách (mỗi lần generate lấy phần tử tiếp theo; hết danh sách thì
 * trả finish). Dùng để đo harness một cách xác định mà không cần model thật.
 */
export function scriptedV7Generator(script: readonly string[]): V7ModelGenerator {
  let index = 0;
  return () => {
    if (index >= script.length) return '```finish\nDone.\n```';
    const text = script[index] as string;
    index += 1;
    return text;
  };
}

/** Script mẫu giải đúng task fix-off-by-one (dùng trong test/demo). */
export const V7_SCRIPT_FIX_OFF_BY_ONE: readonly string[] = [
  '```read\ncalc.py\n```',
  '```edit\ncalc.py\ndef sum_range(n):\n    total = 0\n    for i in range(n + 1):\n        total += i\n    return total\n```',
  '```bash\npython3 -c "import test_calc; [f() for n, f in vars(test_calc).items() if n.startswith(\'test_\')]; print(\'all tests passed\')"\n```',
  '```finish\nFixed off-by-one: range(n) now range(n + 1). Tests pass.\n```',
];

/** Script mẫu giải đúng task fix-failing-test greet. */
export const V7_SCRIPT_FIX_GREET: readonly string[] = [
  '```read\ngreet.py\n```',
  '```edit\ngreet.py\ndef greet(name):\n    return f"Hello, {name.capitalize()}"\n```',
  '```bash\npython3 -c "import test_greet; [f() for n, f in vars(test_greet).items() if n.startswith(\'test_\')]; print(\'all tests passed\')"\n```',
  '```finish\nFixed greet to capitalize the name. Tests pass.\n```',
];

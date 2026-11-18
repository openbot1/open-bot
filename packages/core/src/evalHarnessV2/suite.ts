/**
 * Eval Harness v2 — builtin sample suite (v1.34, Đội T4).
 *
 * Bộ task mẫu local-first, nhỏ + nhanh + không cần Docker thật, không
 * gọi mạng, không cần model: CLI `eval-harness` và tool chạy được ngay
 * trên máy user bằng executor scripted/noop.
 *
 * 3 task mẫu (mỗi task đều có oracle hợp lệ — đã kiểm chứng bằng tay
 * khi viết: oracle qua hết test, fail-to-pass fail trước oracle):
 *
 * 1. `v2-sample-add` (issue-patch, easy): repo snapshot có `add.js`
 *    cộng sai (`a - b`); test `node test-add.js` fail trước patch,
 *    pass sau khi oracle sửa thành `a + b`; test pass-to-pass kiểm
 *    tra module vẫn load được.
 * 2. `v2-sample-greet` (state-check, easy): agent tạo `hello.txt`
 *    chứa `HELLO EVAL`; test kiểm tra trạng thái cuối của file.
 * 3. `v2-sample-sum` (state-check, medium): environment có
 *    `numbers.csv` (10/20/30); agent tạo `sum.txt` chứa `60`; test
 *    kiểm tra trạng thái cuối.
 *
 * Suite id: `v2-sample`. Task mẫu KHÔNG dùng để đo model thật — chỉ
 * để smoke-test harness, CLI, tool và regression gate chạy đúng.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseEvalHarnessV2Task } from './taskLoader.js';
import { buildSuiteResult, runEvalHarnessV2Tasks, type EvalHarnessV2Executor, type EvalHarnessV2RunnerOptions } from './runner.js';
import { saveEvalHarnessV2Report } from './regressionGate.js';
import type {
  EvalHarnessV2Suite,
  EvalHarnessV2SuiteResult,
  EvalHarnessV2Task,
} from './types.js';

export const EVAL_HARNESS_V2_SAMPLE_SUITE_ID = 'v2-sample';

/** Task mẫu 1: issue-patch — sửa hàm cộng sai thành cộng đúng. */
export const EVAL_HARNESS_V2_SAMPLE_TASK_ADD: EvalHarnessV2Task = parseEvalHarnessV2Task({
  format: 'eval-harness-v2',
  version: 2,
  id: 'v2-sample-add',
  name: 'Sample: fix add()',
  description: 'Issue-patch mẫu: sửa hàm add() cộng sai thành cộng đúng.',
  kind: 'issue-patch',
  difficulty: 'easy',
  timeoutMs: 60_000,
  maxTrials: 2,
  maxSteps: 10,
  input: {
    instruction:
      'Sửa hàm add(a, b) trong add.js để nó trả về tổng a + b. Chạy node test-add.js để kiểm tra.',
    issue: 'add(2, 3) trả về -1 thay vì 5 — hàm add() đang trừ thay vì cộng.',
    repoSnapshot: {
      'add.js': 'function add(a, b) {\n  return a - b;\n}\n\nmodule.exports = { add };\n',
      'test-add.js':
        "const assert = require('assert');\nconst { add } = require('./add.js');\nassert.strictEqual(add(2, 3), 5);\nassert.strictEqual(add(-1, 1), 0);\nassert.strictEqual(add(0, 0), 0);\nconsole.log('add() OK');\n",
    },
  },
  output: {
    description: 'add.js sửa thành return a + b; node test-add.js pass.',
    expectedFiles: ['add.js'],
  },
  oracle: {
    files: {
      'add.js': 'function add(a, b) {\n  return a + b;\n}\n\nmodule.exports = { add };\n',
    },
    note: 'Oracle: thay a - b thành a + b trong add.js.',
  },
  tests: [
    { id: 'add-returns-sum', name: 'add() returns sum', command: 'node test-add.js', group: 'fail-to-pass', weight: 2 },
    { id: 'add-module-loads', name: 'add.js loads', command: "node -e \"require('./add.js'); console.log('loads')\"", group: 'pass-to-pass', weight: 1 },
  ],
  tags: ['node', 'sample'],
});

/** Task mẫu 2: state-check — tạo file hello.txt đúng nội dung. */
export const EVAL_HARNESS_V2_SAMPLE_TASK_GREET: EvalHarnessV2Task = parseEvalHarnessV2Task({
  format: 'eval-harness-v2',
  version: 2,
  id: 'v2-sample-greet',
  name: 'Sample: create hello.txt',
  description: 'State-check mẫu: tạo hello.txt chứa HELLO EVAL.',
  kind: 'state-check',
  difficulty: 'easy',
  timeoutMs: 60_000,
  maxTrials: 2,
  maxSteps: 5,
  input: {
    instruction: 'Tạo file hello.txt trong thư mục làm việc, nội dung chứa dòng HELLO EVAL.',
  },
  output: {
    description: 'File hello.txt tồn tại và chứa HELLO EVAL.',
    expectedFiles: ['hello.txt'],
  },
  oracle: {
    files: { 'hello.txt': 'HELLO EVAL\n' },
    note: 'Oracle: ghi hello.txt với nội dung HELLO EVAL.',
  },
  tests: [
    {
      id: 'hello-file-content',
      name: 'hello.txt contains HELLO EVAL',
      command:
        "node -e \"const fs=require('fs'); const s=fs.readFileSync('hello.txt','utf8'); if(!s.includes('HELLO EVAL')) { console.error('missing HELLO EVAL'); process.exit(1); } console.log('hello OK');\"",
      group: 'state-check',
      weight: 1,
    },
  ],
  tags: ['node', 'file-io', 'sample'],
});

/** Task mẫu 3: state-check — tính tổng từ numbers.csv. */
export const EVAL_HARNESS_V2_SAMPLE_TASK_SUM: EvalHarnessV2Task = parseEvalHarnessV2Task({
  format: 'eval-harness-v2',
  version: 2,
  id: 'v2-sample-sum',
  name: 'Sample: sum numbers.csv',
  description: 'State-check mẫu: cộng các số trong numbers.csv, ghi kết quả vào sum.txt.',
  kind: 'state-check',
  difficulty: 'medium',
  timeoutMs: 60_000,
  maxTrials: 2,
  maxSteps: 10,
  input: {
    instruction:
      'Đọc numbers.csv (mỗi dòng một số), tính tổng và ghi kết quả (chỉ số, vd 60) vào sum.txt.',
    environmentFiles: {
      'numbers.csv': '10\n20\n30\n',
    },
  },
  output: {
    description: 'File sum.txt chứa 60.',
    expectedFiles: ['sum.txt'],
  },
  oracle: {
    files: { 'sum.txt': '60\n' },
    note: 'Oracle: 10 + 20 + 30 = 60, ghi vào sum.txt.',
  },
  tests: [
    {
      id: 'sum-file-value',
      name: 'sum.txt equals 60',
      command:
        "node -e \"const fs=require('fs'); const s=fs.readFileSync('sum.txt','utf8').trim(); if(s!=='60') { console.error('sum.txt is '+JSON.stringify(s)+', expected 60'); process.exit(1); } console.log('sum OK');\"",
      group: 'state-check',
      weight: 1,
    },
  ],
  tags: ['node', 'data', 'sample'],
});

/** Toàn bộ task mẫu (theo thứ tự id). */
export const EVAL_HARNESS_V2_SAMPLE_TASKS: readonly EvalHarnessV2Task[] = [
  EVAL_HARNESS_V2_SAMPLE_TASK_ADD,
  EVAL_HARNESS_V2_SAMPLE_TASK_GREET,
  EVAL_HARNESS_V2_SAMPLE_TASK_SUM,
];

/** Id các task mẫu. */
export const EVAL_HARNESS_V2_SAMPLE_TASK_IDS: readonly string[] = EVAL_HARNESS_V2_SAMPLE_TASKS.map(
  (t) => t.id,
);

/** Suite mẫu builtin. */
export const BUILTIN_EVAL_HARNESS_V2_SUITE: EvalHarnessV2Suite = {
  id: EVAL_HARNESS_V2_SAMPLE_SUITE_ID,
  name: 'Eval Harness v2 — sample suite',
  description:
    'Bộ task mẫu local-first (3 task, nhỏ + nhanh, không cần Docker/model): smoke-test harness, CLI, tool và regression gate.',
  tasks: [...EVAL_HARNESS_V2_SAMPLE_TASKS],
};

/** Lấy task mẫu theo id (không có → undefined). */
export function getBuiltinEvalHarnessV2Task(id: string): EvalHarnessV2Task | undefined {
  return EVAL_HARNESS_V2_SAMPLE_TASKS.find((t) => t.id === id);
}

/** Liệt kê task mẫu (bản sao — caller không sửa được builtin). */
export function builtinEvalHarnessV2Tasks(): EvalHarnessV2Task[] {
  return [...EVAL_HARNESS_V2_SAMPLE_TASKS];
}

/** Thư mục task v2 trên đĩa của user (`<baseDir>/eval-harness-v2-tasks`). */
export function defaultEvalHarnessV2TasksDir(baseDir: string): string {
  return path.join(baseDir, 'eval-harness-v2-tasks');
}

/**
 * Ghi suite mẫu ra thư mục task trên đĩa (task.json + instruction.md +
 * environment/ + oracle/ + tests/tests.json) để CLI `list`/`validate`
 * và người dùng xem/sửa được. Ghi đè task mẫu đã có, không xoá task
 * lạ của user trong cùng thư mục.
 */
export function materializeBuiltinEvalHarnessV2Tasks(tasksDir: string): string[] {
  fs.mkdirSync(tasksDir, { recursive: true });
  const written: string[] = [];
  for (const task of EVAL_HARNESS_V2_SAMPLE_TASKS) {
    const dir = path.join(tasksDir, task.id);
    fs.mkdirSync(path.join(dir, 'environment'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'oracle'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'tests'), { recursive: true });
    const { dir: _dir, ...meta } = task;
    void _dir;
    fs.writeFileSync(path.join(dir, 'task.json'), `${JSON.stringify(meta, null, 2)}\n`, 'utf8');
    fs.writeFileSync(path.join(dir, 'instruction.md'), `${task.input.instruction}\n`, 'utf8');
    for (const [rel, content] of Object.entries(task.input.environmentFiles ?? {})) {
      const target = path.join(dir, 'environment', rel);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content, 'utf8');
    }
    for (const [rel, content] of Object.entries(task.oracle.files ?? {})) {
      const target = path.join(dir, 'oracle', rel);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content, 'utf8');
    }
    if (task.oracle.commands !== undefined) {
      fs.writeFileSync(
        path.join(dir, 'oracle', 'commands.json'),
        `${JSON.stringify(task.oracle.commands, null, 2)}\n`,
        'utf8',
      );
    }
    if (task.oracle.note !== undefined) {
      fs.writeFileSync(path.join(dir, 'oracle', 'note.txt'), `${task.oracle.note}\n`, 'utf8');
    }
    fs.writeFileSync(
      path.join(dir, 'tests', 'tests.json'),
      `${JSON.stringify(task.tests, null, 2)}\n`,
      'utf8',
    );
    written.push(dir);
  }
  return written;
}

export interface EvalHarnessV2RunSuiteOptions extends EvalHarnessV2RunnerOptions {
  /** Nhãn agent/executor ghi vào report (mặc định 'scripted'). */
  agentLabel?: string;
  /** Lưu report JSON vào baseDir (mặc định true khi có baseDir). */
  saveReport?: boolean;
  /** Thư mục dữ liệu để lưu report (bắt buộc khi saveReport=true). */
  baseDir?: string;
}

/**
 * Chạy một suite (mặc định = suite mẫu) bằng executor cho trước, gộp
 * thành SuiteResult. Không throw vì task fail — fail là kết quả.
 */
export async function runEvalHarnessV2Suite(
  suite: EvalHarnessV2Suite,
  executor: EvalHarnessV2Executor,
  options: EvalHarnessV2RunSuiteOptions = {},
): Promise<EvalHarnessV2SuiteResult> {
  const startedAt = Date.now();
  const taskResults = await runEvalHarnessV2Tasks(suite.tasks, executor, options);
  const result = buildSuiteResult(suite.id, options.agentLabel ?? 'scripted', taskResults, startedAt);
  if ((options.saveReport ?? true) && options.baseDir !== undefined) {
    saveEvalHarnessV2Report(options.baseDir, result);
  }
  return result;
}

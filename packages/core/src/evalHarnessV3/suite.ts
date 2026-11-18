/**
 * Eval Harness v3 — builtin sample suite + eval sets (v1.35, Đội T4).
 *
 * Bộ task mẫu local-first, nhỏ + nhanh + không cần Docker thật, không
 * gọi mạng, không cần model: CLI/tool chạy được ngay trên máy user
 * bằng executor scripted/noop.
 *
 * 4 task mẫu (mỗi task đều có oracle hợp lệ — oracle qua hết test,
 * ổn định, fail-to-pass fail trước oracle):
 *
 * 1. `v3-sample-add` (issue-patch, easy): repo snapshot có `add.js`
 *    cộng sai (`a - b`); test `node test-add.js` fail trước patch,
 *    pass sau khi oracle sửa thành `a + b`; test pass-to-pass kiểm
 *    tra module vẫn load được. Container: node:22-slim, không mạng.
 * 2. `v3-sample-greet` (state-check, easy): agent tạo `hello.txt`
 *    chứa `HELLO EVAL`; test kiểm tra trạng thái cuối của file.
 * 3. `v3-sample-sum` (state-check, medium): environment có
 *    `numbers.csv` (10/20/30); agent tạo `sum.txt` chứa `60`.
 * 4. `v3-sample-guardrail` (state-check, easy): agent tạo `report.txt`
 *    tóm tắt số liệu — và task này cấm tool `delete_file` + cấm
 *    output chứa secret: agent nào ghi secret vào report sẽ bị
 *    output guardrail trip (status `guardrail-trip`), minh hoạ
 *    tripwire dừng run trước khi chấm test.
 *
 * Suite id: `v3-sample`. Eval set `v3-smoke` (task 1+2, chạy nhanh
 * mỗi commit) và `v3-sample` (cả 4 task). Task mẫu KHÔNG dùng để đo
 * model thật — chỉ để smoke-test harness, tool, guardrail, trace và
 * regression gate chạy đúng.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseEvalHarnessV3Task } from './taskLoader.js';
import { buildEvalHarnessV3SuiteResult, runEvalHarnessV3Tasks, type EvalHarnessV3Executor, type EvalHarnessV3RunnerOptions } from './runner.js';
import { saveEvalHarnessV3Report } from './regressionGate.js';
import type {
  EvalHarnessV3Suite,
  EvalHarnessV3SuiteResult,
  EvalHarnessV3Task,
} from './types.js';

export const EVAL_HARNESS_V3_SAMPLE_SUITE_ID = 'v3-sample';
export const EVAL_HARNESS_V3_SMOKE_SET_ID = 'v3-smoke';

/** Task mẫu 1: issue-patch — sửa hàm cộng sai thành cộng đúng. */
export const EVAL_HARNESS_V3_SAMPLE_TASK_ADD: EvalHarnessV3Task = parseEvalHarnessV3Task({
  format: 'eval-harness-v3',
  version: 3,
  id: 'v3-sample-add',
  name: 'Sample: fix add()',
  description: 'Issue-patch mẫu: sửa hàm add() cộng sai thành cộng đúng.',
  kind: 'issue-patch',
  difficulty: 'easy',
  timeoutMs: 60_000,
  maxTrials: 2,
  maxSteps: 10,
  container: { image: 'node:22-slim', tag: 'latest', network: 'none', workdir: '/work' },
  input: {
    instruction:
      'Sửa hàm add(a, b) trong add.js để nó trả về tổng a + b. Chạy node test-add.js để kiểm tra.',
    issue: 'add(2, 3) trả về -1 thay vì 5 — hàm add() đang trừ thay vì cộng.',
    baseCommit: 'v3-sample-base-add',
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
export const EVAL_HARNESS_V3_SAMPLE_TASK_GREET: EvalHarnessV3Task = parseEvalHarnessV3Task({
  format: 'eval-harness-v3',
  version: 3,
  id: 'v3-sample-greet',
  name: 'Sample: create hello.txt',
  description: 'State-check mẫu: tạo hello.txt chứa HELLO EVAL.',
  kind: 'state-check',
  difficulty: 'easy',
  timeoutMs: 60_000,
  maxTrials: 2,
  maxSteps: 5,
  container: { image: 'node:22-slim', tag: 'latest', network: 'none', workdir: '/work' },
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
export const EVAL_HARNESS_V3_SAMPLE_TASK_SUM: EvalHarnessV3Task = parseEvalHarnessV3Task({
  format: 'eval-harness-v3',
  version: 3,
  id: 'v3-sample-sum',
  name: 'Sample: sum numbers.csv',
  description: 'State-check mẫu: cộng các số trong numbers.csv, ghi kết quả vào sum.txt.',
  kind: 'state-check',
  difficulty: 'medium',
  timeoutMs: 60_000,
  maxTrials: 2,
  maxSteps: 10,
  container: { image: 'node:22-slim', tag: 'latest', network: 'none', workdir: '/work' },
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

/** Task mẫu 4: state-check + guardrail — tạo report sạch, không secret, không xoá file. */
export const EVAL_HARNESS_V3_SAMPLE_TASK_GUARDRAIL: EvalHarnessV3Task = parseEvalHarnessV3Task({
  format: 'eval-harness-v3',
  version: 3,
  id: 'v3-sample-guardrail',
  name: 'Sample: clean report (guardrail)',
  description: 'State-check mẫu có guardrail: tạo report.txt sạch, không secret, không gọi tool bị cấm.',
  kind: 'state-check',
  difficulty: 'easy',
  timeoutMs: 60_000,
  maxTrials: 2,
  maxSteps: 5,
  container: { image: 'node:22-slim', tag: 'latest', network: 'none', workdir: '/work' },
  guardrails: {
    enabled: true,
    mode: 'parallel',
    deniedTools: ['delete_file', 'run_shell'],
    maxToolCalls: 10,
  },
  input: {
    instruction:
      'Đọc metrics.csv (mỗi dòng: tên,số), tạo report.txt liệt kê mỗi dòng dạng "tên: số", KHÔNG ghi thêm thông tin khác, KHÔNG gọi tool xoá file.',
    environmentFiles: {
      'metrics.csv': 'builds,12\nfailures,2\n',
    },
  },
  output: {
    description: 'File report.txt chứa "builds: 12" và "failures: 2".',
    expectedFiles: ['report.txt'],
  },
  oracle: {
    files: { 'report.txt': 'builds: 12\nfailures: 2\n' },
    note: 'Oracle: chép số liệu từ metrics.csv sang report.txt, không thêm gì khác.',
  },
  tests: [
    {
      id: 'report-file-content',
      name: 'report.txt lists metrics',
      command:
        "node -e \"const fs=require('fs'); const s=fs.readFileSync('report.txt','utf8'); if(!s.includes('builds: 12')||!s.includes('failures: 2')) { console.error('report missing metrics'); process.exit(1); } console.log('report OK');\"",
      group: 'state-check',
      weight: 1,
    },
  ],
  tags: ['node', 'guardrail', 'sample'],
});

/** Toàn bộ task mẫu (theo thứ tự id). */
export const EVAL_HARNESS_V3_SAMPLE_TASKS: readonly EvalHarnessV3Task[] = [
  EVAL_HARNESS_V3_SAMPLE_TASK_ADD,
  EVAL_HARNESS_V3_SAMPLE_TASK_GREET,
  EVAL_HARNESS_V3_SAMPLE_TASK_SUM,
  EVAL_HARNESS_V3_SAMPLE_TASK_GUARDRAIL,
];

/** Id các task mẫu. */
export const EVAL_HARNESS_V3_SAMPLE_TASK_IDS: readonly string[] = EVAL_HARNESS_V3_SAMPLE_TASKS.map(
  (t) => t.id,
);

/** Suite mẫu builtin. */
export const BUILTIN_EVAL_HARNESS_V3_SUITE: EvalHarnessV3Suite = {
  id: EVAL_HARNESS_V3_SAMPLE_SUITE_ID,
  name: 'Eval Harness v3 — sample suite',
  description:
    'Bộ task mẫu local-first (4 task, nhỏ + nhanh, không cần Docker/model): smoke-test harness, guardrail, trace và regression gate.',
  tasks: [...EVAL_HARNESS_V3_SAMPLE_TASKS],
};

/** Suite smoke builtin: 2 task nhanh nhất (add + greet). */
export const BUILTIN_EVAL_HARNESS_V3_SMOKE_SUITE: EvalHarnessV3Suite = {
  id: EVAL_HARNESS_V3_SMOKE_SET_ID,
  name: 'Eval Harness v3 — smoke suite',
  description: 'Bộ smoke nhanh (2 task): chạy mỗi commit để kiểm tra harness còn sống.',
  tasks: [EVAL_HARNESS_V3_SAMPLE_TASK_ADD, EVAL_HARNESS_V3_SAMPLE_TASK_GREET],
};

/** Lấy task mẫu theo id (không có → undefined). */
export function getBuiltinEvalHarnessV3Task(id: string): EvalHarnessV3Task | undefined {
  return EVAL_HARNESS_V3_SAMPLE_TASKS.find((t) => t.id === id);
}

/** Liệt kê task mẫu (bản sao — caller không sửa được builtin). */
export function builtinEvalHarnessV3Tasks(): EvalHarnessV3Task[] {
  return [...EVAL_HARNESS_V3_SAMPLE_TASKS];
}

/** Thư mục task v3 trên đĩa của user (`<baseDir>/eval-harness-v3-tasks`). */
export function defaultEvalHarnessV3TasksDir(baseDir: string): string {
  return path.join(baseDir, 'eval-harness-v3-tasks');
}

/**
 * Ghi suite mẫu ra thư mục task trên đĩa (task.json + instruction.md +
 * container.json + guardrails.json + environment/ + oracle/ +
 * tests/tests.json) để CLI `list`/`validate` và người dùng xem/sửa
 * được. Ghi đè task mẫu đã có, không xoá task lạ của user trong cùng
 * thư mục.
 */
export function materializeBuiltinEvalHarnessV3Tasks(tasksDir: string): string[] {
  fs.mkdirSync(tasksDir, { recursive: true });
  const written: string[] = [];
  for (const task of EVAL_HARNESS_V3_SAMPLE_TASKS) {
    const dir = path.join(tasksDir, task.id);
    fs.mkdirSync(path.join(dir, 'environment'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'oracle'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'tests'), { recursive: true });
    const { dir: _dir, ...meta } = task;
    void _dir;
    fs.writeFileSync(path.join(dir, 'task.json'), `${JSON.stringify(meta, null, 2)}\n`, 'utf8');
    fs.writeFileSync(path.join(dir, 'instruction.md'), `${task.input.instruction}\n`, 'utf8');
    fs.writeFileSync(
      path.join(dir, 'container.json'),
      `${JSON.stringify(task.container ?? {}, null, 2)}\n`,
      'utf8',
    );
    if (task.guardrails !== undefined) {
      fs.writeFileSync(
        path.join(dir, 'guardrails.json'),
        `${JSON.stringify(task.guardrails, null, 2)}\n`,
        'utf8',
      );
    }
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
    if (task.oracle.patch !== undefined) {
      fs.writeFileSync(path.join(dir, 'oracle', 'patch.diff'), `${task.oracle.patch}\n`, 'utf8');
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

export interface EvalHarnessV3RunSuiteOptions extends EvalHarnessV3RunnerOptions {
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
 * Trace của từng trial được gom qua onTrace (tool lưu JSONL).
 */
export async function runEvalHarnessV3Suite(
  suite: EvalHarnessV3Suite,
  executor: EvalHarnessV3Executor,
  options: EvalHarnessV3RunSuiteOptions = {},
): Promise<EvalHarnessV3SuiteResult> {
  const startedAt = Date.now();
  const taskResults = await runEvalHarnessV3Tasks(suite.tasks, executor, options);
  const result = buildEvalHarnessV3SuiteResult(suite.id, options.agentLabel ?? 'scripted', taskResults, startedAt);
  if ((options.saveReport ?? true) && options.baseDir !== undefined) {
    saveEvalHarnessV3Report(options.baseDir, result);
  }
  return result;
}

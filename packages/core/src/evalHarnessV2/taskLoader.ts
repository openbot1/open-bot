/**
 * Eval Harness v2 — task loader + validator (v1.34, Đội T4).
 *
 * Đọc task từ object JSON hoặc từ thư mục task trên đĩa:
 *
 *   <taskDir>/
 *     task.json       — EvalHarnessV2Task (trừ input.instruction, có thể
 *                       để trong instruction.md thay cho inline)
 *     instruction.md  — đề bài (ưu tiên hơn task.json.input.instruction
 *                       khi cả hai đều có? Không — instruction.md THẮNG,
 *                       vì đó là file người viết đề sửa trực tiếp)
 *     environment/    — file khởi đầu → input.environmentFiles
 *     oracle/         — oracle solution: files (giữ nguyên cây) +
 *                       commands.json (mảng lệnh, tùy chọn) + note.txt
 *     tests/          — tests.json (mảng EvalHarnessV2Test) hoặc
 *                       <testId>.sh (mỗi file = 1 test, lệnh là nội
 *                       dung file; tên file = test id)
 *
 * Quy tắc validate (task không đạt → bị từ chối khi load, kèm lý do
 * rõ từng trường — KHÔNG tự sửa lặng lẽ, trừ default timeout/weight):
 * - format phải là 'eval-harness-v2', version phải là 2.
 * - id khớp EVAL_HARNESS_V2_TASK_ID_RE; kind/difficulty hợp lệ.
 * - timeoutMs trong [5_000, 1_800_000]; maxTrials (nếu có) 1..20.
 * - instruction không rỗng; issue-patch bắt buộc có issue + repoSnapshot
 *   (ít nhất 1 file); state-check KHÔNG được có repoSnapshot (đó là
 *   nhầm loại — state-check chấm trạng thái, không chấm patch).
 * - oracle bắt buộc: phải có files (ít nhất 1 file) hoặc commands
 *   (ít nhất 1 lệnh) — task không có oracle thì load fail, để
 *   oracle.ts kiểm chứng sau đó (xem validateOracleSolution).
 * - ít nhất 1 test; mỗi test có id/name/command; group phải phù hợp
 *   loại task (fail-to-pass/pass-to-pass chỉ cho issue-patch,
 *   state-check chỉ cho state-check); weight > 0; không trùng id test.
 * - mọi đường dẫn file (snapshot/environment/oracle) phải tương đối
 *   và không thoát khỏi workdir (`..`, tuyệt đối đều bị chặn).
 * - lệnh test/oracle không chứa mẫu phá hoại
 *   (EVAL_HARNESS_V2_FORBIDDEN_COMMAND_PATTERNS).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  EVAL_HARNESS_V2_DEFAULT_MAX_TRIALS,
  EVAL_HARNESS_V2_DEFAULT_TIMEOUT_MS,
  EVAL_HARNESS_V2_DIFFICULTIES,
  EVAL_HARNESS_V2_FORMAT,
  EVAL_HARNESS_V2_FORBIDDEN_COMMAND_PATTERNS,
  EVAL_HARNESS_V2_KINDS,
  EVAL_HARNESS_V2_MAX_TIMEOUT_MS,
  EVAL_HARNESS_V2_MIN_TIMEOUT_MS,
  EVAL_HARNESS_V2_TASK_ID_RE,
  EVAL_HARNESS_V2_VERSION,
  defaultTestGroup,
  isUnsafeRelativePath,
  type EvalHarnessV2Difficulty,
  type EvalHarnessV2Oracle,
  type EvalHarnessV2Task,
  type EvalHarnessV2TaskKind,
  type EvalHarnessV2Test,
  type EvalHarnessV2ValidationIssue,
  type EvalHarnessV2ValidationResult,
} from './types.js';

export const EVAL_HARNESS_V2_META_FILE = 'task.json';
export const EVAL_HARNESS_V2_INSTRUCTION_FILE = 'instruction.md';
export const EVAL_HARNESS_V2_ENVIRONMENT_DIR = 'environment';
export const EVAL_HARNESS_V2_ORACLE_DIR = 'oracle';
export const EVAL_HARNESS_V2_ORACLE_COMMANDS_FILE = 'commands.json';
export const EVAL_HARNESS_V2_ORACLE_NOTE_FILE = 'note.txt';
export const EVAL_HARNESS_V2_TESTS_DIR = 'tests';
export const EVAL_HARNESS_V2_TESTS_FILE = 'tests.json';

/** Lỗi load/validate task — kèm field để báo rõ. */
export class EvalHarnessV2TaskError extends Error {
  readonly field: string;
  constructor(field: string, message: string) {
    super(message);
    this.name = 'EvalHarnessV2TaskError';
    this.field = field;
  }
}

function issue(field: string, message: string): EvalHarnessV2ValidationIssue {
  return { field, message };
}

function checkForbiddenCommands(
  command: string,
  field: string,
  issues: EvalHarnessV2ValidationIssue[],
): void {
  for (const { pattern, reason } of EVAL_HARNESS_V2_FORBIDDEN_COMMAND_PATTERNS) {
    if (pattern.test(command)) {
      issues.push(issue(field, `Lệnh bị cấm (${reason}): "${command.slice(0, 80)}"`));
      return;
    }
  }
}

function checkFileMap(
  files: Record<string, string> | undefined,
  field: string,
  issues: EvalHarnessV2ValidationIssue[],
): void {
  if (files === undefined) return;
  if (typeof files !== 'object' || files === null || Array.isArray(files)) {
    issues.push(issue(field, 'Phải là object map đường dẫn → nội dung file.'));
    return;
  }
  for (const [p, content] of Object.entries(files)) {
    if (isUnsafeRelativePath(p)) {
      issues.push(issue(field, `Đường dẫn không an toàn (thoát khỏi workdir): "${p}".`));
    }
    if (typeof content !== 'string') {
      issues.push(issue(field, `Nội dung file "${p}" phải là chuỗi.`));
    }
  }
}

/**
 * Validate một task object thô (chưa chuẩn hoá). Trả về danh sách lỗi
 * + cảnh báo; `valid` false khi có lỗi. Không throw.
 */
export function validateEvalHarnessV2Task(
  raw: unknown,
): EvalHarnessV2ValidationResult {
  const issues: EvalHarnessV2ValidationIssue[] = [];
  const warnings: EvalHarnessV2ValidationIssue[] = [];
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { valid: false, issues: [issue('task', 'Task phải là một object JSON.')], warnings };
  }
  const t = raw as Record<string, unknown>;

  if (t['format'] !== EVAL_HARNESS_V2_FORMAT) {
    issues.push(issue('format', `format phải là "${EVAL_HARNESS_V2_FORMAT}".`));
  }
  if (t['version'] !== EVAL_HARNESS_V2_VERSION) {
    issues.push(issue('version', `version phải là ${EVAL_HARNESS_V2_VERSION}.`));
  }
  if (typeof t['id'] !== 'string' || !EVAL_HARNESS_V2_TASK_ID_RE.test(t['id'])) {
    issues.push(issue('id', 'id chỉ gồm chữ thường, số, "-", "_" và bắt đầu bằng chữ/số.'));
  }
  if (typeof t['name'] !== 'string' || t['name'].trim() === '') {
    issues.push(issue('name', 'name không được rỗng.'));
  }
  if (typeof t['description'] !== 'string' || t['description'].trim() === '') {
    issues.push(issue('description', 'description không được rỗng.'));
  }
  const kind = t['kind'] as EvalHarnessV2TaskKind;
  if (!(EVAL_HARNESS_V2_KINDS as readonly string[]).includes(kind)) {
    issues.push(issue('kind', 'kind phải là "issue-patch" hoặc "state-check".'));
  }
  const difficulty = t['difficulty'] as EvalHarnessV2Difficulty;
  if (!(EVAL_HARNESS_V2_DIFFICULTIES as readonly string[]).includes(difficulty)) {
    issues.push(issue('difficulty', 'difficulty phải là "easy", "medium" hoặc "hard".'));
  }
  const timeoutMs = t['timeoutMs'] as number;
  if (
    typeof timeoutMs !== 'number' ||
    !Number.isFinite(timeoutMs) ||
    timeoutMs < EVAL_HARNESS_V2_MIN_TIMEOUT_MS ||
    timeoutMs > EVAL_HARNESS_V2_MAX_TIMEOUT_MS
  ) {
    issues.push(
      issue(
        'timeoutMs',
        `timeoutMs phải trong khoảng ${EVAL_HARNESS_V2_MIN_TIMEOUT_MS}..${EVAL_HARNESS_V2_MAX_TIMEOUT_MS} ms.`,
      ),
    );
  }
  if (t['maxTrials'] !== undefined) {
    const n = t['maxTrials'] as number;
    if (!Number.isInteger(n) || n < 1 || n > 20) {
      issues.push(issue('maxTrials', 'maxTrials phải là số nguyên 1..20.'));
    }
  }
  if (t['maxSteps'] !== undefined) {
    const n = t['maxSteps'] as number;
    if (!Number.isInteger(n) || n < 1 || n > 1000) {
      issues.push(issue('maxSteps', 'maxSteps phải là số nguyên 1..1000.'));
    }
  }

  // --- input ---
  const input = t['input'] as Record<string, unknown> | undefined;
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    issues.push(issue('input', 'input phải là object.'));
  } else {
    if (typeof input['instruction'] !== 'string' || input['instruction'].trim() === '') {
      issues.push(issue('input.instruction', 'input.instruction không được rỗng.'));
    }
    if (kind === 'issue-patch') {
      if (typeof input['issue'] !== 'string' || input['issue'].trim() === '') {
        issues.push(issue('input.issue', 'Task issue-patch bắt buộc có input.issue mô tả issue.'));
      }
      const snap = input['repoSnapshot'] as Record<string, string> | undefined;
      if (snap === undefined || Object.keys(snap).length === 0) {
        issues.push(issue('input.repoSnapshot', 'Task issue-patch bắt buộc có input.repoSnapshot (ít nhất 1 file).'));
      } else {
        checkFileMap(snap, 'input.repoSnapshot', issues);
      }
    } else if (kind === 'state-check') {
      if (input['repoSnapshot'] !== undefined) {
        issues.push(
          issue('input.repoSnapshot', 'Task state-check không được có repoSnapshot (đó là input của issue-patch).'),
        );
      }
    }
    checkFileMap(
      input['environmentFiles'] as Record<string, string> | undefined,
      'input.environmentFiles',
      issues,
    );
  }

  // --- output ---
  const output = t['output'] as Record<string, unknown> | undefined;
  if (typeof output !== 'object' || output === null || Array.isArray(output)) {
    issues.push(issue('output', 'output phải là object.'));
  } else {
    if (typeof output['description'] !== 'string' || output['description'].trim() === '') {
      issues.push(issue('output.description', 'output.description không được rỗng.'));
    }
    if (output['expectedFiles'] !== undefined) {
      if (!Array.isArray(output['expectedFiles'])) {
        issues.push(issue('output.expectedFiles', 'output.expectedFiles phải là mảng đường dẫn.'));
      } else {
        for (const p of output['expectedFiles'] as unknown[]) {
          if (typeof p !== 'string' || isUnsafeRelativePath(p)) {
            issues.push(issue('output.expectedFiles', `Đường dẫn expectedFiles không an toàn: "${String(p)}".`));
          }
        }
      }
    }
  }

  // --- oracle (bắt buộc có — task không oracle thì load fail) ---
  const oracle = t['oracle'] as EvalHarnessV2Oracle | undefined;
  if (typeof oracle !== 'object' || oracle === null || Array.isArray(oracle)) {
    issues.push(issue('oracle', 'oracle bắt buộc: task phải kèm oracle solution (files hoặc commands).'));
  } else {
    const files = oracle.files ?? {};
    const commands = oracle.commands ?? [];
    const hasFiles = Object.keys(files).length > 0;
    const hasCommands = commands.length > 0;
    if (!hasFiles && !hasCommands) {
      issues.push(
        issue('oracle', 'oracle phải có ít nhất 1 file (oracle.files) hoặc 1 lệnh (oracle.commands) — task không có oracle thì bị từ chối khi load.'),
      );
    }
    checkFileMap(files, 'oracle.files', issues);
    if (!Array.isArray(commands)) {
      issues.push(issue('oracle.commands', 'oracle.commands phải là mảng lệnh.'));
    } else {
      for (const cmd of commands as unknown[]) {
        if (typeof cmd !== 'string' || cmd.trim() === '') {
          issues.push(issue('oracle.commands', 'Mỗi lệnh oracle phải là chuỗi không rỗng.'));
        } else {
          checkForbiddenCommands(cmd, 'oracle.commands', issues);
        }
      }
    }
  }

  // --- tests ---
  const tests = t['tests'] as unknown;
  if (!Array.isArray(tests) || tests.length === 0) {
    issues.push(issue('tests', 'tests phải là mảng có ít nhất 1 test xác định.'));
  } else {
    const seen = new Set<string>();
    for (let i = 0; i < tests.length; i++) {
      const field = `tests[${i}]`;
      const test = tests[i] as Record<string, unknown>;
      if (typeof test !== 'object' || test === null) {
        issues.push(issue(field, 'Mỗi test phải là object.'));
        continue;
      }
      if (typeof test['id'] !== 'string' || test['id'].trim() === '') {
        issues.push(issue(`${field}.id`, 'Test id không được rỗng.'));
      } else if (seen.has(test['id'])) {
        issues.push(issue(`${field}.id`, `Trùng test id: "${test['id']}".`));
      } else {
        seen.add(test['id']);
      }
      if (typeof test['name'] !== 'string' || test['name'].trim() === '') {
        issues.push(issue(`${field}.name`, 'Test name không được rỗng.'));
      }
      if (typeof test['command'] !== 'string' || test['command'].trim() === '') {
        issues.push(issue(`${field}.command`, 'Test command không được rỗng.'));
      } else {
        checkForbiddenCommands(test['command'], `${field}.command`, issues);
      }
      const group = test['group'] as string | undefined;
      if (group !== undefined) {
        if (kind === 'issue-patch' && group === 'state-check') {
          issues.push(issue(`${field}.group`, 'Task issue-patch không dùng test group "state-check".'));
        }
        if (kind === 'state-check' && group !== 'state-check') {
          issues.push(issue(`${field}.group`, 'Task state-check chỉ dùng test group "state-check".'));
        }
        if (group !== 'fail-to-pass' && group !== 'pass-to-pass' && group !== 'state-check') {
          issues.push(issue(`${field}.group`, 'Test group phải là "fail-to-pass", "pass-to-pass" hoặc "state-check".'));
        }
      }
      if (test['weight'] !== undefined) {
        const w = test['weight'] as number;
        if (typeof w !== 'number' || !Number.isFinite(w) || w <= 0) {
          issues.push(issue(`${field}.weight`, 'Test weight phải là số > 0.'));
        }
      } else {
        warnings.push(issue(`${field}.weight`, 'Test không đặt weight — dùng mặc định 1.'));
      }
      if (test['timeoutMs'] !== undefined) {
        const tm = test['timeoutMs'] as number;
        if (typeof tm !== 'number' || tm < 1_000 || tm > EVAL_HARNESS_V2_MAX_TIMEOUT_MS) {
          issues.push(issue(`${field}.timeoutMs`, 'Test timeoutMs phải trong khoảng 1000..1800000 ms.'));
        }
      }
    }
  }

  if (Array.isArray(t['tags'])) {
    for (const tag of t['tags'] as unknown[]) {
      if (typeof tag !== 'string' || tag.trim() === '') {
        issues.push(issue('tags', 'Mỗi tag phải là chuỗi không rỗng.'));
      }
    }
  }

  return { valid: issues.length === 0, issues, warnings };
}

/**
 * Parse + chuẩn hoá một task object thô thành EvalHarnessV2Task đầy đủ
 * (điền default timeout/maxTrials/maxSteps/weight/group). Throw
 * EvalHarnessV2TaskError khi validate fail.
 */
export function parseEvalHarnessV2Task(raw: unknown): EvalHarnessV2Task {
  const result = validateEvalHarnessV2Task(raw);
  if (!result.valid) {
    const first = result.issues[0];
    throw new EvalHarnessV2TaskError(
      first.field,
      `Task không hợp lệ (${result.issues.length} lỗi, lỗi đầu ${first.field}: ${first.message})`,
    );
  }
  const t = raw as Record<string, unknown>;
  const kind = t['kind'] as EvalHarnessV2TaskKind;
  const input = t['input'] as Record<string, unknown>;
  const oracle = t['oracle'] as EvalHarnessV2Oracle;
  const tests = (t['tests'] as EvalHarnessV2Test[]).map((test) => ({
    ...test,
    group: test.group ?? defaultTestGroup(kind),
    weight: test.weight ?? 1,
  }));
  return {
    format: EVAL_HARNESS_V2_FORMAT,
    version: EVAL_HARNESS_V2_VERSION,
    id: t['id'] as string,
    name: t['name'] as string,
    description: t['description'] as string,
    kind,
    difficulty: t['difficulty'] as EvalHarnessV2Difficulty,
    timeoutMs: (t['timeoutMs'] as number) ?? EVAL_HARNESS_V2_DEFAULT_TIMEOUT_MS,
    maxTrials: (t['maxTrials'] as number) ?? EVAL_HARNESS_V2_DEFAULT_MAX_TRIALS,
    maxSteps: (t['maxSteps'] as number) ?? 20,
    input: {
      instruction: input['instruction'] as string,
      ...(typeof input['issue'] === 'string' ? { issue: input['issue'] } : {}),
      ...(input['repoSnapshot'] !== undefined
        ? { repoSnapshot: input['repoSnapshot'] as Record<string, string> }
        : {}),
      ...(input['environmentFiles'] !== undefined
        ? { environmentFiles: input['environmentFiles'] as Record<string, string> }
        : {}),
    },
    output: t['output'] as EvalHarnessV2Task['output'],
    oracle: {
      ...(oracle.files !== undefined ? { files: oracle.files } : {}),
      ...(oracle.commands !== undefined ? { commands: oracle.commands } : {}),
      ...(oracle.note !== undefined ? { note: oracle.note } : {}),
    },
    tests,
    ...(Array.isArray(t['tags']) ? { tags: t['tags'] as string[] } : {}),
  };
}

/** Đọc cây thư mục thành map đường dẫn tương đối → nội dung (UTF-8, bỏ qua thư mục rỗng). */
export function readDirAsFileMap(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!fs.existsSync(dir)) return out;
  const walk = (current: string, prefix: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) walk(full, rel);
      else if (entry.isFile()) out[rel] = fs.readFileSync(full, 'utf8');
    }
  };
  walk(dir, '');
  return out;
}

/**
 * Load một task từ thư mục trên đĩa (task.json + instruction.md +
 * environment/ + oracle/ + tests/). Throw EvalHarnessV2TaskError khi
 * thiếu file bắt buộc hoặc validate fail. Trả về task đã chuẩn hoá
 * (kèm `dir`).
 */
export function loadEvalHarnessV2TaskFromDir(dir: string): EvalHarnessV2Task {
  const metaPath = path.join(dir, EVAL_HARNESS_V2_META_FILE);
  if (!fs.existsSync(metaPath)) {
    throw new EvalHarnessV2TaskError('task.json', `Không có task.json trong "${dir}".`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(metaPath, 'utf8')) as unknown;
  } catch (err) {
    throw new EvalHarnessV2TaskError('task.json', `task.json không parse được: ${(err as Error).message}`);
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new EvalHarnessV2TaskError('task.json', 'task.json phải là một object JSON.');
  }
  const t = { ...(raw as Record<string, unknown>) };

  // instruction.md thắng task.json.input.instruction (file đề là nguồn chính).
  const instructionPath = path.join(dir, EVAL_HARNESS_V2_INSTRUCTION_FILE);
  const input = (typeof t['input'] === 'object' && t['input'] !== null
    ? { ...(t['input'] as Record<string, unknown>) }
    : {}) as Record<string, unknown>;
  if (fs.existsSync(instructionPath)) {
    input['instruction'] = fs.readFileSync(instructionPath, 'utf8');
  }
  // environment/ thắng input.environmentFiles khi cả hai đều có.
  const envFiles = readDirAsFileMap(path.join(dir, EVAL_HARNESS_V2_ENVIRONMENT_DIR));
  if (Object.keys(envFiles).length > 0) {
    input['environmentFiles'] = { ...((input['environmentFiles'] as Record<string, string>) ?? {}), ...envFiles };
  }
  t['input'] = input;

  // oracle/: files = toàn bộ cây oracle/ (trừ commands.json/note.txt);
  // commands.json = mảng lệnh; note.txt = ghi chú.
  const oracleDir = path.join(dir, EVAL_HARNESS_V2_ORACLE_DIR);
  if (fs.existsSync(oracleDir)) {
    const oracleFiles = readDirAsFileMap(oracleDir);
    const commandsRaw = oracleFiles[EVAL_HARNESS_V2_ORACLE_COMMANDS_FILE];
    const noteRaw = oracleFiles[EVAL_HARNESS_V2_ORACLE_NOTE_FILE];
    delete oracleFiles[EVAL_HARNESS_V2_ORACLE_COMMANDS_FILE];
    delete oracleFiles[EVAL_HARNESS_V2_ORACLE_NOTE_FILE];
    const oracle: Record<string, unknown> = {
      ...((t['oracle'] as Record<string, unknown>) ?? {}),
    };
    if (Object.keys(oracleFiles).length > 0) {
      oracle['files'] = { ...((oracle['files'] as Record<string, string>) ?? {}), ...oracleFiles };
    }
    if (commandsRaw !== undefined) {
      try {
        oracle['commands'] = JSON.parse(commandsRaw) as unknown;
      } catch (err) {
        throw new EvalHarnessV2TaskError('oracle/commands.json', `commands.json không parse được: ${(err as Error).message}`);
      }
    }
    if (noteRaw !== undefined) oracle['note'] = noteRaw;
    t['oracle'] = oracle;
  }

  // tests/: tests.json thắng; nếu không có thì mỗi *.sh là 1 test.
  const testsDir = path.join(dir, EVAL_HARNESS_V2_TESTS_DIR);
  const testsJsonPath = path.join(testsDir, EVAL_HARNESS_V2_TESTS_FILE);
  if (fs.existsSync(testsJsonPath)) {
    try {
      t['tests'] = JSON.parse(fs.readFileSync(testsJsonPath, 'utf8')) as unknown;
    } catch (err) {
      throw new EvalHarnessV2TaskError('tests/tests.json', `tests.json không parse được: ${(err as Error).message}`);
    }
  } else if (fs.existsSync(testsDir)) {
    const shFiles = fs.readdirSync(testsDir).filter((f) => f.endsWith('.sh')).sort();
    if (shFiles.length > 0) {
      const kind = t['kind'] as EvalHarnessV2TaskKind;
      t['tests'] = shFiles.map((f) => ({
        id: f.replace(/\.sh$/, ''),
        name: f.replace(/\.sh$/, ''),
        command: `sh tests/${f}`,
        group: defaultTestGroup(kind),
        weight: 1,
      }));
    }
  }

  const task = parseEvalHarnessV2Task(t);
  task.dir = dir;
  return task;
}

/** Load mọi task trong một thư mục suite (mỗi thư mục con = 1 task). Task lỗi bị bỏ qua kèm lý do. */
export function loadEvalHarnessV2TasksFromDir(dir: string): {
  tasks: EvalHarnessV2Task[];
  skipped: Array<{ dir: string; reason: string }>;
} {
  const tasks: EvalHarnessV2Task[] = [];
  const skipped: Array<{ dir: string; reason: string }> = [];
  if (!fs.existsSync(dir)) return { tasks, skipped };
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue;
    const taskDir = path.join(dir, entry.name);
    if (!fs.existsSync(path.join(taskDir, EVAL_HARNESS_V2_META_FILE))) continue;
    try {
      tasks.push(loadEvalHarnessV2TaskFromDir(taskDir));
    } catch (err) {
      skipped.push({ dir: taskDir, reason: (err as Error).message });
    }
  }
  tasks.sort((a, b) => a.id.localeCompare(b.id));
  return { tasks, skipped };
}

/** Render kết quả validate thành text đọc được (CLI/tool in ra). */
export function renderEvalHarnessV2ValidationText(
  taskId: string,
  result: EvalHarnessV2ValidationResult,
): string {
  const lines: string[] = [`Task ${taskId}: ${result.valid ? 'VALID' : 'INVALID'} (${result.issues.length} lỗi, ${result.warnings.length} cảnh báo)`];
  for (const i of result.issues) lines.push(`  ERROR  ${i.field}: ${i.message}`);
  for (const w of result.warnings) lines.push(`  WARN   ${w.field}: ${w.message}`);
  return `${lines.join('\n')}\n`;
}

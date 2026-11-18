/**
 * Eval Harness v3 — task loader + validation (v1.35, Đội T4).
 *
 * Load task v3 từ object JSON hoặc từ thư mục trên đĩa:
 *
 *   task.json        — metadata + input/output + tests + container
 *   instruction.md   — đề bài (ghi đè instruction trong task.json khi có)
 *   container.json   — container spec (ghi đè container trong task.json)
 *   environment/     — file khởi đầu (ghi đè environmentFiles)
 *   oracle/          — oracle files + commands.json + note.txt + patch.diff
 *   tests/tests.json — bộ test (ghi đè tests trong task.json)
 *   guardrails.json  — cấu hình guardrail riêng cho task (tùy chọn)
 *
 * Validation chặn sớm: format/version sai, id sai, thiếu oracle,
 * test rỗng/lệnh cấm/đường dẫn thoát workdir, container spec sai
 * (image trống, digest sai, memory sai, network mode lạ), guardrail
 * config sai (regex không compile được, maxToolCalls <= 0).
 * Validation KHÔNG chạy test — kiểm tra oracle ở oracle.ts.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  EVAL_HARNESS_V3_DIFFICULTIES,
  EVAL_HARNESS_V3_FORMAT,
  EVAL_HARNESS_V3_KINDS,
  EVAL_HARNESS_V3_MAX_TIMEOUT_MS,
  EVAL_HARNESS_V3_MIN_TIMEOUT_MS,
  EVAL_HARNESS_V3_NETWORK_MODES,
  EVAL_HARNESS_V3_TASK_ID_RE,
  EVAL_HARNESS_V3_VERSION,
  EVAL_HARNESS_V3_FORBIDDEN_COMMAND_PATTERNS,
  defaultEvalHarnessV3TestGroup,
  isUnsafeEvalHarnessV3RelativePath,
  isValidContainerDigest,
  isValidMemoryLimit,
  normalizeContainerSpec,
  type EvalHarnessV3ContainerSpec,
  type EvalHarnessV3Difficulty,
  type EvalHarnessV3Task,
  type EvalHarnessV3TaskKind,
  type EvalHarnessV3Test,
  type EvalHarnessV3ValidationIssue,
  type EvalHarnessV3ValidationResult,
} from './types.js';

export const EVAL_HARNESS_V3_META_FILE = 'task.json';
export const EVAL_HARNESS_V3_INSTRUCTION_FILE = 'instruction.md';
export const EVAL_HARNESS_V3_CONTAINER_FILE = 'container.json';
export const EVAL_HARNESS_V3_GUARDRAILS_FILE = 'guardrails.json';
export const EVAL_HARNESS_V3_ENVIRONMENT_DIR = 'environment';
export const EVAL_HARNESS_V3_ORACLE_DIR = 'oracle';
export const EVAL_HARNESS_V3_ORACLE_COMMANDS_FILE = 'commands.json';
export const EVAL_HARNESS_V3_ORACLE_PATCH_FILE = 'patch.diff';
export const EVAL_HARNESS_V3_TESTS_DIR = 'tests';
export const EVAL_HARNESS_V3_TESTS_FILE = 'tests.json';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function issue(field: string, message: string): EvalHarnessV3ValidationIssue {
  return { field, message };
}

/** Kiểm tra một lệnh shell có chứa mẫu phá hoại bị cấm không. */
export function findForbiddenCommand(command: string): string | null {
  for (const { pattern, reason } of EVAL_HARNESS_V3_FORBIDDEN_COMMAND_PATTERNS) {
    if (pattern.test(command)) return reason;
  }
  return null;
}

function validateContainerSpec(
  raw: unknown,
  issues: EvalHarnessV3ValidationIssue[],
  warnings: EvalHarnessV3ValidationIssue[],
): EvalHarnessV3ContainerSpec | undefined {
  if (raw === undefined) return undefined;
  if (!isRecord(raw)) {
    issues.push(issue('container', 'container phải là object.'));
    return undefined;
  }
  const image = raw['image'];
  if (typeof image !== 'string' || image.trim() === '') {
    issues.push(issue('container.image', 'container.image bắt buộc, không được trống.'));
  } else if (/\s/.test(image)) {
    issues.push(issue('container.image', 'container.image không được chứa khoảng trắng.'));
  }
  if (raw['tag'] !== undefined && (typeof raw['tag'] !== 'string' || raw['tag'].trim() === '')) {
    issues.push(issue('container.tag', 'container.tag phải là chuỗi không trống.'));
  }
  if (raw['digest'] !== undefined) {
    if (typeof raw['digest'] !== 'string' || !isValidContainerDigest(raw['digest'])) {
      issues.push(issue('container.digest', 'container.digest phải có dạng sha256:<64 ký tự hex>.'));
    }
  }
  if (raw['tag'] === undefined && raw['digest'] === undefined) {
    warnings.push(issue('container', 'container không pin tag/digest — nên pin để trial ổn định.'));
  }
  if (raw['network'] !== undefined) {
    if (
      typeof raw['network'] !== 'string' ||
      !(EVAL_HARNESS_V3_NETWORK_MODES as readonly string[]).includes(raw['network'])
    ) {
      issues.push(
        issue('container.network', `container.network phải là một trong: ${EVAL_HARNESS_V3_NETWORK_MODES.join(', ')}.`),
      );
    }
  }
  if (raw['setupCommands'] !== undefined) {
    if (
      !Array.isArray(raw['setupCommands']) ||
      raw['setupCommands'].some((c) => typeof c !== 'string' || c.trim() === '')
    ) {
      issues.push(issue('container.setupCommands', 'container.setupCommands phải là mảng chuỗi không trống.'));
    } else {
      for (const cmd of raw['setupCommands'] as string[]) {
        const forbidden = findForbiddenCommand(cmd);
        if (forbidden !== null) {
          issues.push(issue('container.setupCommands', `Lệnh setup bị cấm (${forbidden}): "${cmd.slice(0, 80)}".`));
        }
      }
    }
  }
  if (raw['env'] !== undefined) {
    if (!isRecord(raw['env']) || Object.values(raw['env']).some((v) => typeof v !== 'string')) {
      issues.push(issue('container.env', 'container.env phải là map chuỗi → chuỗi.'));
    } else {
      for (const key of Object.keys(raw['env'])) {
        if (/SECRET|TOKEN|PASSWORD|API[_-]?KEY/i.test(key)) {
          warnings.push(issue('container.env', `Biến "${key}" trông như secret — không đưa secret vào container spec.`));
        }
      }
    }
  }
  if (raw['resources'] !== undefined) {
    if (!isRecord(raw['resources'])) {
      issues.push(issue('container.resources', 'container.resources phải là object.'));
    } else {
      const res = raw['resources'];
      if (res['cpus'] !== undefined && (typeof res['cpus'] !== 'number' || res['cpus'] <= 0 || res['cpus'] > 64)) {
        issues.push(issue('container.resources.cpus', 'container.resources.cpus phải là số > 0 và <= 64.'));
      }
      if (res['memory'] !== undefined && (typeof res['memory'] !== 'string' || !isValidMemoryLimit(res['memory']))) {
        issues.push(issue('container.resources.memory', 'container.resources.memory phải có dạng 512m / 2g / 1024.'));
      }
      if (res['disk'] !== undefined && (typeof res['disk'] !== 'string' || !isValidMemoryLimit(res['disk']))) {
        issues.push(issue('container.resources.disk', 'container.resources.disk phải có dạng 1g / 512m.'));
      }
      if (res['pids'] !== undefined && (typeof res['pids'] !== 'number' || !Number.isInteger(res['pids']) || res['pids'] <= 0)) {
        issues.push(issue('container.resources.pids', 'container.resources.pids phải là số nguyên > 0.'));
      }
    }
  }
  if (raw['workdir'] !== undefined && (typeof raw['workdir'] !== 'string' || !raw['workdir'].startsWith('/'))) {
    issues.push(issue('container.workdir', 'container.workdir phải là đường dẫn tuyệt đối (vd /work).'));
  }
  return undefined;
}

function validateGuardrailsConfig(
  raw: unknown,
  issues: EvalHarnessV3ValidationIssue[],
): void {
  if (raw === undefined) return;
  if (!isRecord(raw)) {
    issues.push(issue('guardrails', 'guardrails phải là object.'));
    return;
  }
  if (raw['mode'] !== undefined && raw['mode'] !== 'parallel' && raw['mode'] !== 'sequential') {
    issues.push(issue('guardrails.mode', 'guardrails.mode phải là "parallel" hoặc "sequential".'));
  }
  for (const field of ['allowedTools', 'deniedTools'] as const) {
    if (
      raw[field] !== undefined &&
      (!Array.isArray(raw[field]) || raw[field].some((t) => typeof t !== 'string' || t.trim() === ''))
    ) {
      issues.push(issue(`guardrails.${field}`, `guardrails.${field} phải là mảng chuỗi không trống.`));
    }
  }
  for (const field of ['extraInputPatterns', 'extraOutputPatterns'] as const) {
    if (raw[field] !== undefined) {
      if (!Array.isArray(raw[field]) || raw[field].some((t) => typeof t !== 'string')) {
        issues.push(issue(`guardrails.${field}`, `guardrails.${field} phải là mảng chuỗi regex.`));
      } else {
        for (const pattern of raw[field] as string[]) {
          try {
            new RegExp(pattern, 'i');
          } catch {
            issues.push(issue(`guardrails.${field}`, `Regex không compile được: "${pattern}".`));
          }
        }
      }
    }
  }
  if (
    raw['maxToolCalls'] !== undefined &&
    (typeof raw['maxToolCalls'] !== 'number' || !Number.isInteger(raw['maxToolCalls']) || raw['maxToolCalls'] <= 0)
  ) {
    issues.push(issue('guardrails.maxToolCalls', 'guardrails.maxToolCalls phải là số nguyên > 0.'));
  }
}

/**
 * Validate một task thô (object JSON chưa parse qua task). Trả về lỗi +
 * cảnh báo; `valid` true khi không còn lỗi nào. Không chạy test.
 */
export function validateEvalHarnessV3Task(raw: unknown): EvalHarnessV3ValidationResult {
  const issues: EvalHarnessV3ValidationIssue[] = [];
  const warnings: EvalHarnessV3ValidationIssue[] = [];
  if (!isRecord(raw)) {
    return { valid: false, issues: [issue('', 'Task phải là object JSON.')], warnings };
  }
  if (raw['format'] !== EVAL_HARNESS_V3_FORMAT) {
    issues.push(issue('format', `format phải là "${EVAL_HARNESS_V3_FORMAT}".`));
  }
  if (raw['version'] !== EVAL_HARNESS_V3_VERSION) {
    issues.push(issue('version', `version phải là ${EVAL_HARNESS_V3_VERSION}.`));
  }
  const id = raw['id'];
  if (typeof id !== 'string' || !EVAL_HARNESS_V3_TASK_ID_RE.test(id)) {
    issues.push(issue('id', 'id chỉ gồm chữ thường, số, "-" và "_", bắt đầu bằng chữ/số.'));
  }
  if (typeof raw['name'] !== 'string' || raw['name'].trim() === '') {
    issues.push(issue('name', 'name bắt buộc, không được trống.'));
  }
  if (typeof raw['description'] !== 'string' || raw['description'].trim() === '') {
    issues.push(issue('description', 'description bắt buộc, không được trống.'));
  }
  const kind = raw['kind'];
  if (typeof kind !== 'string' || !(EVAL_HARNESS_V3_KINDS as readonly string[]).includes(kind)) {
    issues.push(issue('kind', `kind phải là một trong: ${EVAL_HARNESS_V3_KINDS.join(', ')}.`));
  }
  const difficulty = raw['difficulty'];
  if (
    typeof difficulty !== 'string' ||
    !(EVAL_HARNESS_V3_DIFFICULTIES as readonly string[]).includes(difficulty)
  ) {
    issues.push(issue('difficulty', `difficulty phải là một trong: ${EVAL_HARNESS_V3_DIFFICULTIES.join(', ')}.`));
  }
  const timeoutMs = raw['timeoutMs'];
  if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs)) {
    issues.push(issue('timeoutMs', 'timeoutMs bắt buộc, phải là số (ms).'));
  } else if (timeoutMs < EVAL_HARNESS_V3_MIN_TIMEOUT_MS || timeoutMs > EVAL_HARNESS_V3_MAX_TIMEOUT_MS) {
    issues.push(
      issue('timeoutMs', `timeoutMs phải trong khoảng ${EVAL_HARNESS_V3_MIN_TIMEOUT_MS}..${EVAL_HARNESS_V3_MAX_TIMEOUT_MS} ms.`),
    );
  }
  if (
    raw['maxTrials'] !== undefined &&
    (typeof raw['maxTrials'] !== 'number' || !Number.isInteger(raw['maxTrials']) || raw['maxTrials'] < 1 || raw['maxTrials'] > 20)
  ) {
    issues.push(issue('maxTrials', 'maxTrials phải là số nguyên 1..20.'));
  }
  if (
    raw['maxSteps'] !== undefined &&
    (typeof raw['maxSteps'] !== 'number' || !Number.isInteger(raw['maxSteps']) || raw['maxSteps'] < 1)
  ) {
    issues.push(issue('maxSteps', 'maxSteps phải là số nguyên >= 1.'));
  }

  validateContainerSpec(raw['container'], issues, warnings);
  validateGuardrailsConfig(raw['guardrails'], issues);

  // Input.
  const input = raw['input'];
  if (!isRecord(input)) {
    issues.push(issue('input', 'input bắt buộc, phải là object.'));
  } else {
    if (typeof input['instruction'] !== 'string' || input['instruction'].trim() === '') {
      issues.push(issue('input.instruction', 'input.instruction bắt buộc, không được trống.'));
    }
    if (kind === 'issue-patch') {
      if (typeof input['issue'] !== 'string' || input['issue'].trim() === '') {
        issues.push(issue('input.issue', 'Task issue-patch bắt buộc có input.issue.'));
      }
      if (!isRecord(input['repoSnapshot']) || Object.keys(input['repoSnapshot']).length === 0) {
        issues.push(issue('input.repoSnapshot', 'Task issue-patch bắt buộc có input.repoSnapshot không trống.'));
      }
      if (input['baseCommit'] !== undefined && (typeof input['baseCommit'] !== 'string' || input['baseCommit'].trim() === '')) {
        issues.push(issue('input.baseCommit', 'input.baseCommit phải là chuỗi không trống khi có.'));
      }
    }
    for (const field of ['repoSnapshot', 'environmentFiles'] as const) {
      const files = input[field];
      if (files === undefined) continue;
      if (!isRecord(files)) {
        issues.push(issue(`input.${field}`, `input.${field} phải là map đường dẫn → nội dung.`));
        continue;
      }
      for (const [rel, content] of Object.entries(files)) {
        if (isUnsafeEvalHarnessV3RelativePath(rel)) {
          issues.push(issue(`input.${field}`, `Đường dẫn thoát khỏi workdir: "${rel}".`));
        }
        if (typeof content !== 'string') {
          issues.push(issue(`input.${field}`, `Nội dung file "${rel}" phải là chuỗi.`));
        }
      }
    }
  }

  // Output.
  const output = raw['output'];
  if (!isRecord(output)) {
    issues.push(issue('output', 'output bắt buộc, phải là object.'));
  } else if (typeof output['description'] !== 'string' || output['description'].trim() === '') {
    issues.push(issue('output.description', 'output.description bắt buộc, không được trống.'));
  }

  // Oracle — bắt buộc, phải có files hoặc commands.
  const oracle = raw['oracle'];
  if (!isRecord(oracle)) {
    issues.push(issue('oracle', 'oracle bắt buộc, phải là object.'));
  } else {
    const files = oracle['files'];
    const commands = oracle['commands'];
    const hasFiles = isRecord(files) && Object.keys(files).length > 0;
    const hasCommands = Array.isArray(commands) && commands.length > 0;
    if (!hasFiles && !hasCommands) {
      issues.push(issue('oracle', 'oracle phải có files hoặc commands (task phải chứng minh giải được).'));
    }
    if (files !== undefined) {
      if (!isRecord(files)) {
        issues.push(issue('oracle.files', 'oracle.files phải là map đường dẫn → nội dung.'));
      } else {
        for (const rel of Object.keys(files)) {
          if (isUnsafeEvalHarnessV3RelativePath(rel)) {
            issues.push(issue('oracle.files', `Đường dẫn oracle thoát khỏi workdir: "${rel}".`));
          }
        }
      }
    }
    if (commands !== undefined) {
      if (!Array.isArray(commands) || commands.some((c) => typeof c !== 'string' || c.trim() === '')) {
        issues.push(issue('oracle.commands', 'oracle.commands phải là mảng chuỗi không trống.'));
      } else {
        for (const cmd of commands as string[]) {
          const forbidden = findForbiddenCommand(cmd);
          if (forbidden !== null) {
            issues.push(issue('oracle.commands', `Lệnh oracle bị cấm (${forbidden}): "${cmd.slice(0, 80)}".`));
          }
        }
      }
    }
    if (oracle['patch'] !== undefined && typeof oracle['patch'] !== 'string') {
      issues.push(issue('oracle.patch', 'oracle.patch phải là chuỗi diff.'));
    }
  }

  // Tests — ít nhất 1, mỗi test có lệnh hợp lệ, không chứa mẫu cấm.
  const tests = raw['tests'];
  if (!Array.isArray(tests) || tests.length === 0) {
    issues.push(issue('tests', 'tests bắt buộc, ít nhất 1 test.'));
  } else {
    const seen = new Set<string>();
    tests.forEach((t, idx) => {
      const field = `tests[${idx}]`;
      if (!isRecord(t)) {
        issues.push(issue(field, 'Test phải là object.'));
        return;
      }
      if (typeof t['id'] !== 'string' || t['id'].trim() === '') {
        issues.push(issue(`${field}.id`, 'Test id bắt buộc.'));
      } else if (seen.has(t['id'])) {
        issues.push(issue(`${field}.id`, `Test id trùng: "${t['id']}".`));
      } else {
        seen.add(t['id']);
      }
      if (typeof t['name'] !== 'string' || t['name'].trim() === '') {
        issues.push(issue(`${field}.name`, 'Test name bắt buộc.'));
      }
      if (typeof t['command'] !== 'string' || t['command'].trim() === '') {
        issues.push(issue(`${field}.command`, 'Test command bắt buộc.'));
      } else {
        const forbidden = findForbiddenCommand(t['command']);
        if (forbidden !== null) {
          issues.push(issue(`${field}.command`, `Lệnh test bị cấm (${forbidden}): "${String(t['command']).slice(0, 80)}".`));
        }
      }
      const group = t['group'];
      if (group !== undefined && group !== 'fail-to-pass' && group !== 'pass-to-pass' && group !== 'state-check') {
        issues.push(issue(`${field}.group`, 'Test group phải là fail-to-pass, pass-to-pass hoặc state-check.'));
      } else if (group !== undefined && kind === 'issue-patch' && group === 'state-check') {
        issues.push(issue(`${field}.group`, 'Task issue-patch không dùng test group state-check.'));
      } else if (group !== undefined && kind === 'state-check' && group !== 'state-check') {
        issues.push(issue(`${field}.group`, 'Task state-check chỉ dùng test group state-check.'));
      }
      if (t['weight'] !== undefined && (typeof t['weight'] !== 'number' || t['weight'] <= 0)) {
        issues.push(issue(`${field}.weight`, 'Test weight phải là số > 0.'));
      }
      if (
        t['timeoutMs'] !== undefined &&
        (typeof t['timeoutMs'] !== 'number' || t['timeoutMs'] < 1000 || t['timeoutMs'] > EVAL_HARNESS_V3_MAX_TIMEOUT_MS)
      ) {
        issues.push(issue(`${field}.timeoutMs`, 'Test timeoutMs phải là số 1000..3600000.'));
      }
    });
    if (kind === 'issue-patch' && Array.isArray(tests)) {
      const hasFtp = tests.some(
        (t) => isRecord(t) && (t['group'] === 'fail-to-pass' || t['group'] === undefined),
      );
      if (!hasFtp) {
        issues.push(issue('tests', 'Task issue-patch cần ít nhất 1 test fail-to-pass.'));
      }
    }
  }

  if (raw['tags'] !== undefined) {
    if (!Array.isArray(raw['tags']) || raw['tags'].some((t) => typeof t !== 'string' || t.trim() === '')) {
      issues.push(issue('tags', 'tags phải là mảng chuỗi không trống.'));
    }
  }
  return { valid: issues.length === 0, issues, warnings };
}

/** Parse object JSON thô thành EvalHarnessV3Task (throw khi không valid). */
export function parseEvalHarnessV3Task(raw: unknown): EvalHarnessV3Task {
  const validation = validateEvalHarnessV3Task(raw);
  if (!validation.valid) {
    const first = validation.issues[0];
    throw new Error(
      `Task eval v3 không hợp lệ (${validation.issues.length} lỗi): ${first?.field ?? ''} ${first?.message ?? ''}`,
    );
  }
  const r = raw as Record<string, unknown>;
  const input = r['input'] as Record<string, unknown>;
  const output = r['output'] as Record<string, unknown>;
  const oracle = r['oracle'] as Record<string, unknown>;
  const tests = (r['tests'] as Array<Record<string, unknown>>).map((t) => ({
    id: t['id'] as string,
    name: t['name'] as string,
    command: t['command'] as string,
    group: (t['group'] as EvalHarnessV3Test['group']) ?? defaultEvalHarnessV3TestGroup(r['kind'] as EvalHarnessV3TaskKind),
    weight: (t['weight'] as number | undefined) ?? 1,
    ...(t['timeoutMs'] !== undefined ? { timeoutMs: t['timeoutMs'] as number } : {}),
    ...(t['retryOnFlake'] !== undefined ? { retryOnFlake: t['retryOnFlake'] as boolean } : {}),
  }));
  const task: EvalHarnessV3Task = {
    format: EVAL_HARNESS_V3_FORMAT,
    version: EVAL_HARNESS_V3_VERSION,
    id: r['id'] as string,
    name: r['name'] as string,
    description: r['description'] as string,
    kind: r['kind'] as EvalHarnessV3TaskKind,
    difficulty: r['difficulty'] as EvalHarnessV3Difficulty,
    timeoutMs: r['timeoutMs'] as number,
    ...(r['maxTrials'] !== undefined ? { maxTrials: r['maxTrials'] as number } : {}),
    ...(r['maxSteps'] !== undefined ? { maxSteps: r['maxSteps'] as number } : {}),
    container: normalizeContainerSpec(r['container'] as EvalHarnessV3ContainerSpec | undefined),
    ...(r['guardrails'] !== undefined ? { guardrails: r['guardrails'] as EvalHarnessV3Task['guardrails'] } : {}),
    input: {
      instruction: input['instruction'] as string,
      ...(input['issue'] !== undefined ? { issue: input['issue'] as string } : {}),
      ...(input['repoSnapshot'] !== undefined
        ? { repoSnapshot: input['repoSnapshot'] as Record<string, string> }
        : {}),
      ...(input['baseCommit'] !== undefined ? { baseCommit: input['baseCommit'] as string } : {}),
      ...(input['environmentFiles'] !== undefined
        ? { environmentFiles: input['environmentFiles'] as Record<string, string> }
        : {}),
    },
    output: {
      description: output['description'] as string,
      ...(output['expectedFiles'] !== undefined
        ? { expectedFiles: output['expectedFiles'] as string[] }
        : {}),
    },
    oracle: {
      ...(oracle['files'] !== undefined ? { files: oracle['files'] as Record<string, string> } : {}),
      ...(oracle['commands'] !== undefined ? { commands: oracle['commands'] as string[] } : {}),
      ...(oracle['note'] !== undefined ? { note: oracle['note'] as string } : {}),
      ...(oracle['patch'] !== undefined ? { patch: oracle['patch'] as string } : {}),
    },
    tests,
    ...(r['tags'] !== undefined ? { tags: r['tags'] as string[] } : {}),
  };
  return task;
}

/** Đọc JSON từ file (throw với message rõ khi file sai). */
function readJsonFile(filePath: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
  } catch (err) {
    throw new Error(`Không đọc được JSON ${filePath}: ${(err as Error).message}`);
  }
}

/** Đọc toàn bộ file trong một thư mục thành map đường dẫn tương đối → nội dung. */
function readFilesRecursive(dir: string, base = dir): Record<string, string> {
  const out: Record<string, string> = {};
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      Object.assign(out, readFilesRecursive(full, base));
    } else if (entry.isFile()) {
      out[path.relative(base, full).split(path.sep).join('/')] = fs.readFileSync(full, 'utf8');
    }
  }
  return out;
}

/**
 * Load một task từ thư mục trên đĩa. File trong thư mục ghi đè trường
 * tương ứng trong task.json (instruction.md > instruction, container.json
 * > container, guardrails.json > guardrails, environment/ > input,
 * oracle/ > oracle, tests/tests.json > tests).
 */
export function loadEvalHarnessV3TaskFromDir(taskDir: string): EvalHarnessV3Task {
  const metaPath = path.join(taskDir, EVAL_HARNESS_V3_META_FILE);
  if (!fs.existsSync(metaPath)) {
    throw new Error(`Thư mục task thiếu ${EVAL_HARNESS_V3_META_FILE}: ${taskDir}`);
  }
  const raw = readJsonFile(metaPath) as Record<string, unknown>;
  const instructionPath = path.join(taskDir, EVAL_HARNESS_V3_INSTRUCTION_FILE);
  if (fs.existsSync(instructionPath)) {
    const instruction = fs.readFileSync(instructionPath, 'utf8').trim();
    if (instruction !== '') {
      const input = (raw['input'] ?? {}) as Record<string, unknown>;
      input['instruction'] = instruction;
      raw['input'] = input;
    }
  }
  const containerPath = path.join(taskDir, EVAL_HARNESS_V3_CONTAINER_FILE);
  if (fs.existsSync(containerPath)) {
    raw['container'] = readJsonFile(containerPath);
  }
  const guardrailsPath = path.join(taskDir, EVAL_HARNESS_V3_GUARDRAILS_FILE);
  if (fs.existsSync(guardrailsPath)) {
    raw['guardrails'] = readJsonFile(guardrailsPath);
  }
  const envDir = path.join(taskDir, EVAL_HARNESS_V3_ENVIRONMENT_DIR);
  const envFiles = readFilesRecursive(envDir);
  if (Object.keys(envFiles).length > 0) {
    const input = (raw['input'] ?? {}) as Record<string, unknown>;
    input['environmentFiles'] = { ...((input['environmentFiles'] as Record<string, string> | undefined) ?? {}), ...envFiles };
    raw['input'] = input;
  }
  const oracleDir = path.join(taskDir, EVAL_HARNESS_V3_ORACLE_DIR);
  if (fs.existsSync(oracleDir)) {
    const oracle = (raw['oracle'] ?? {}) as Record<string, unknown>;
    const oracleFiles = readFilesRecursive(oracleDir);
    // commands.json / note.txt / patch.diff là metadata, không phải file oracle.
    const commandsRaw = oracleFiles[EVAL_HARNESS_V3_ORACLE_COMMANDS_FILE];
    if (commandsRaw !== undefined) {
      try {
        oracle['commands'] = JSON.parse(commandsRaw) as unknown;
      } catch {
        throw new Error(`oracle/${EVAL_HARNESS_V3_ORACLE_COMMANDS_FILE} không phải JSON hợp lệ.`);
      }
      delete oracleFiles[EVAL_HARNESS_V3_ORACLE_COMMANDS_FILE];
    }
    const noteRaw = oracleFiles['note.txt'];
    if (noteRaw !== undefined) {
      oracle['note'] = noteRaw.trim();
      delete oracleFiles['note.txt'];
    }
    const patchRaw = oracleFiles[EVAL_HARNESS_V3_ORACLE_PATCH_FILE];
    if (patchRaw !== undefined) {
      oracle['patch'] = patchRaw;
      delete oracleFiles[EVAL_HARNESS_V3_ORACLE_PATCH_FILE];
    }
    if (Object.keys(oracleFiles).length > 0) {
      oracle['files'] = { ...((oracle['files'] as Record<string, string> | undefined) ?? {}), ...oracleFiles };
    }
    raw['oracle'] = oracle;
  }
  const testsPath = path.join(taskDir, EVAL_HARNESS_V3_TESTS_DIR, EVAL_HARNESS_V3_TESTS_FILE);
  if (fs.existsSync(testsPath)) {
    raw['tests'] = readJsonFile(testsPath);
  }
  const task = parseEvalHarnessV3Task(raw);
  task.dir = taskDir;
  return task;
}

/** Kết quả load nhiều task từ một thư mục (mỗi thư mục con = 1 task). */
export interface EvalHarnessV3LoadDirResult {
  tasks: EvalHarnessV3Task[];
  skipped: Array<{ dir: string; reason: string }>;
}

/** Load toàn bộ task trong một thư mục (thư mục con có task.json). */
export function loadEvalHarnessV3TasksFromDir(tasksDir: string): EvalHarnessV3LoadDirResult {
  const tasks: EvalHarnessV3Task[] = [];
  const skipped: Array<{ dir: string; reason: string }> = [];
  if (!fs.existsSync(tasksDir)) return { tasks, skipped };
  for (const entry of fs.readdirSync(tasksDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(tasksDir, entry.name);
    if (!fs.existsSync(path.join(dir, EVAL_HARNESS_V3_META_FILE))) continue;
    try {
      tasks.push(loadEvalHarnessV3TaskFromDir(dir));
    } catch (err) {
      skipped.push({ dir, reason: (err as Error).message });
    }
  }
  tasks.sort((a, b) => a.id.localeCompare(b.id));
  return { tasks, skipped };
}

/** Render kết quả validation thành text đọc được (CLI/tool). */
export function renderEvalHarnessV3ValidationText(
  taskId: string,
  validation: EvalHarnessV3ValidationResult,
): string {
  const lines: string[] = [`Task ${taskId}: ${validation.valid ? 'VALID' : 'INVALID'}`];
  for (const i of validation.issues) lines.push(`  ✗ ${i.field}: ${i.message}`);
  for (const w of validation.warnings) lines.push(`  ! ${w.field}: ${w.message}`);
  if (validation.valid && validation.warnings.length === 0) lines.push('  (không có lỗi hay cảnh báo)');
  return `${lines.join('\n')}\n`;
}

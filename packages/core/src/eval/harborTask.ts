/**
 * Harbor-format eval task (v1.11, Đội T2).
 *
 * Định dạng task mượn Ý TƯỞNG từ Harbor (OpenHands/Snowflake RL):
 * một task là một thư mục với 3 thành phần — KHÔNG copy code hay
 * text của Harbor, chỉ cùng bố cục:
 *
 *   <taskDir>/
 *     task.json       — metadata + trọng số từng test (xem HarborTaskMeta)
 *     instruction.md  — đề bài giao cho agent (đọc được, tự chứa)
 *     environment/    — file khởi đầu, copy nguyên vẹn vào workspace
 *                       của sandbox trước khi agent chạy
 *     tests/test.sh   — script chấm: chạy trong workspace, in một
 *                       dòng `PASS <tên-test>` hoặc `FAIL <tên-test>`
 *                       cho mỗi test; exit code 0 khi mọi test pass.
 *
 * Điểm của task = reward = tổng trọng số test pass / tổng trọng số
 * (xem harborRunner.ts). Task KHÔNG chứa đáp án trong instruction;
 * test.sh là nguồn chân lý duy nhất.
 *
 * An toàn (local-first, loopback-only):
 *  - mọi đường dẫn trong environment/ và test.sh đều tương đối và
 *    không được thoát khỏi thư mục task/workspace (`..`, đường dẫn
 *    tuyệt đối đều bị validator chặn);
 *  - test.sh bị chặn các mẫu phá hoại (`rm -rf /`, `mkfs`, ghi đè
 *    ngoài workspace); test.sh vẫn chạy trong sandbox box (xem
 *    sandbox/box.ts) nên lỗi validator cũng không chạm được host.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

/** Loại task — trùng với AgentProfileKind (xem profiles.ts). */
export type HarborTaskKind = 'coding' | 'research' | 'writing' | 'review' | 'general';

/** Metadata của một Harbor task (nội dung file task.json). */
export interface HarborTaskMeta {
  /** Id ổn định, vd `hello-file`. Chỉ chữ thường, số, `-`, `_`. */
  id: string;
  /** Tên hiển thị ngắn. */
  name: string;
  /** Loại task — dùng để chọn Agent Profile mặc định khi chạy. */
  kind: HarborTaskKind;
  /** Mô tả một dòng (hiện trong UI/list). */
  description: string;
  /** Phiên bản task (tăng khi sửa instruction/test). */
  version: number;
  /**
   * Timeout toàn task (agent + test), ms. Mặc định 120_000.
   * Validator chặn ngoài khoảng [5_000, 1_800_000].
   */
  timeoutMs: number;
  /** Số turn tối đa gợi ý cho agent (mặc định 20). */
  maxTurns: number;
  /** Trọng số từng test: key = tên test in ra bởi test.sh. */
  testWeights: Record<string, number>;
  /** Tag tự do để lọc task (vd `python`, `file-io`). */
  tags: string[];
}

/** Một file trong environment/ của task. */
export interface HarborEnvironmentFile {
  /** Đường dẫn tương đối trong workspace (vd `data/numbers.csv`). */
  relativePath: string;
  /** Nội dung file (UTF-8). */
  content: string;
}

/** Một Harbor task đã load xong (sẵn sàng chạy). */
export interface HarborTask {
  meta: HarborTaskMeta;
  /** Nội dung instruction.md (đề bài). */
  instruction: string;
  /** File khởi đầu trong environment/. */
  environment: HarborEnvironmentFile[];
  /** Nội dung tests/test.sh. */
  testScript: string;
  /** Thư mục gốc task trên đĩa (undefined khi task tạo trong RAM). */
  dir?: string;
}

/** Một lỗi validation — kèm trường lỗi để UI/tool báo rõ. */
export interface HarborValidationIssue {
  /** Trường liên quan (`task.json`, `instruction.md`, ...). */
  field: string;
  /** Thông điệp tiếng Việt, cụ thể. */
  message: string;
}

/** Kết quả validate: `valid` true khi không còn lỗi nào. */
export interface HarborValidationResult {
  valid: boolean;
  issues: HarborValidationIssue[];
}

/** Tên file/thư mục chuẩn của định dạng Harbor. */
export const HARBOR_META_FILE = 'task.json';
export const HARBOR_INSTRUCTION_FILE = 'instruction.md';
export const HARBOR_ENVIRONMENT_DIR = 'environment';
export const HARBOR_TESTS_DIR = 'tests';
export const HARBOR_TEST_SCRIPT = 'test.sh';

export const HARBOR_TASK_ID_RE = /^[a-z0-9][a-z0-9_-]*$/;
export const HARBOR_TASK_KINDS: readonly HarborTaskKind[] = [
  'coding',
  'research',
  'writing',
  'review',
  'general',
];
export const HARBOR_MIN_TIMEOUT_MS = 5_000;
export const HARBOR_MAX_TIMEOUT_MS = 1_800_000;
export const HARBOR_DEFAULT_TIMEOUT_MS = 120_000;
export const HARBOR_DEFAULT_MAX_TURNS = 20;

/** Mẫu phá hoại bị cấm trong test.sh (chạy trong sandbox nhưng vẫn chặn sớm). */
export const HARBOR_FORBIDDEN_TEST_PATTERNS: readonly { pattern: RegExp; reason: string }[] = [
  { pattern: /(^|\s)rm\s+(-[a-z]*r[a-z]*f?|--recursive)\s+\//, reason: 'xoá đệ quy từ gốc hệ thống' },
  { pattern: /\brm\s+-rf\s+\//, reason: 'xoá đệ quy từ gốc hệ thống' },
  { pattern: /\bmkfs(\.|$|\s)/, reason: 'format ổ đĩa' },
  { pattern: /\bdd\s+.*of=\/dev\//, reason: 'ghi trực tiếp lên thiết bị' },
  { pattern: />\s*\/etc\//, reason: 'ghi đè file hệ thống /etc' },
  { pattern: />\s*\/usr\//, reason: 'ghi đè file hệ thống /usr' },
  { pattern: /\bchmod\s+(-R\s+)?777\s+\//, reason: 'mở quyền 777 từ gốc' },
];

/** Mẫu đáng ngờ trong test.sh: không cấm, chỉ cảnh báo (issue dạng warning). */
export const HARBOR_SUSPICIOUS_TEST_PATTERNS: readonly { pattern: RegExp; reason: string }[] = [
  { pattern: /\bcurl\b|\bwget\b/, reason: 'test.sh gọi mạng — test nên tự chứa, không phụ thuộc mạng' },
  { pattern: /\bshutdown\b|\breboot\b/, reason: 'test.sh yêu cầu tắt/khởi động lại máy' },
  { pattern: /\bkill\s+-9\s+1\b/, reason: 'test.sh kill tiến trình init' },
];

export function isHarborTaskKind(value: unknown): value is HarborTaskKind {
  return typeof value === 'string' && (HARBOR_TASK_KINDS as readonly string[]).includes(value);
}

export function isHarborTaskId(value: unknown): value is string {
  return typeof value === 'string' && HARBOR_TASK_ID_RE.test(value);
}

/** Đường dẫn tương đối an toàn: không tuyệt đối, không `..`, không rỗng. */
export function isSafeRelativePath(value: string): boolean {
  if (typeof value !== 'string' || value.trim() === '') return false;
  if (path.isAbsolute(value)) return false;
  const normalized = path.posix.normalize(value.replace(/\\/g, '/'));
  if (normalized === '.' || normalized.startsWith('../') || normalized === '..') return false;
  if (normalized.includes('\0')) return false;
  return true;
}

/** Metadata mặc định cho một task mới (caller ghi đè các field cần thiết). */
export function defaultHarborTaskMeta(id: string): HarborTaskMeta {
  return {
    id,
    name: id,
    kind: 'general',
    description: '',
    version: 1,
    timeoutMs: HARBOR_DEFAULT_TIMEOUT_MS,
    maxTurns: HARBOR_DEFAULT_MAX_TURNS,
    testWeights: {},
    tags: [],
  };
}

/**
 * Validate metadata (đọc từ task.json). Trả về danh sách lỗi; rỗng
 * nghĩa là hợp lệ. Không throw — loader gom lỗi từ mọi file lại.
 */
export function validateHarborTaskMeta(meta: unknown): HarborValidationIssue[] {
  const issues: HarborValidationIssue[] = [];
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) {
    issues.push({ field: HARBOR_META_FILE, message: 'task.json phải là một JSON object.' });
    return issues;
  }
  const m = meta as Record<string, unknown>;
  if (!isHarborTaskId(m['id'])) {
    issues.push({
      field: 'task.json:id',
      message: 'id phải là chuỗi chữ thường/số/`-`/`_` (vd "hello-file"), không rỗng.',
    });
  }
  if (typeof m['name'] !== 'string' || m['name'].trim() === '') {
    issues.push({ field: 'task.json:name', message: 'name phải là chuỗi không rỗng.' });
  }
  if (!isHarborTaskKind(m['kind'])) {
    issues.push({
      field: 'task.json:kind',
      message: `kind phải là một trong: ${HARBOR_TASK_KINDS.join(', ')}.`,
    });
  }
  if (typeof m['description'] !== 'string' || m['description'].trim() === '') {
    issues.push({ field: 'task.json:description', message: 'description phải là chuỗi không rỗng.' });
  }
  if (typeof m['version'] !== 'number' || !Number.isInteger(m['version']) || (m['version'] as number) < 1) {
    issues.push({ field: 'task.json:version', message: 'version phải là số nguyên >= 1.' });
  }
  if (
    typeof m['timeoutMs'] !== 'number' ||
    !Number.isFinite(m['timeoutMs']) ||
    (m['timeoutMs'] as number) < HARBOR_MIN_TIMEOUT_MS ||
    (m['timeoutMs'] as number) > HARBOR_MAX_TIMEOUT_MS
  ) {
    issues.push({
      field: 'task.json:timeoutMs',
      message: `timeoutMs phải nằm trong [${HARBOR_MIN_TIMEOUT_MS}, ${HARBOR_MAX_TIMEOUT_MS}] ms.`,
    });
  }
  if (
    typeof m['maxTurns'] !== 'number' ||
    !Number.isInteger(m['maxTurns']) ||
    (m['maxTurns'] as number) < 1 ||
    (m['maxTurns'] as number) > 200
  ) {
    issues.push({ field: 'task.json:maxTurns', message: 'maxTurns phải là số nguyên trong [1, 200].' });
  }
  if (!m['testWeights'] || typeof m['testWeights'] !== 'object' || Array.isArray(m['testWeights'])) {
    issues.push({ field: 'task.json:testWeights', message: 'testWeights phải là object { tên-test: trọng số }.' });
  } else {
    const weights = m['testWeights'] as Record<string, unknown>;
    const names = Object.keys(weights);
    if (names.length === 0) {
      issues.push({ field: 'task.json:testWeights', message: 'testWeights phải có ít nhất một test.' });
    }
    let total = 0;
    for (const name of names) {
      const w = weights[name];
      if (typeof name !== 'string' || name.trim() === '' || /\s/.test(name)) {
        issues.push({ field: 'task.json:testWeights', message: `tên test "${name}" không hợp lệ (không rỗng, không chứa khoảng trắng).` });
      }
      if (typeof w !== 'number' || !Number.isFinite(w) || w <= 0) {
        issues.push({ field: 'task.json:testWeights', message: `trọng số của test "${name}" phải là số > 0.` });
      } else {
        total += w;
      }
    }
    if (total <= 0) {
      issues.push({ field: 'task.json:testWeights', message: 'tổng trọng số test phải > 0.' });
    }
  }
  if (m['tags'] !== undefined) {
    if (!Array.isArray(m['tags']) || m['tags'].some((t) => typeof t !== 'string' || t.trim() === '')) {
      issues.push({ field: 'task.json:tags', message: 'tags (nếu có) phải là mảng chuỗi không rỗng.' });
    }
  }
  return issues;
}

/** Validate instruction.md: không rỗng, đủ dài để làm đề bài thật. */
export function validateHarborInstruction(instruction: string): HarborValidationIssue[] {
  const issues: HarborValidationIssue[] = [];
  if (typeof instruction !== 'string' || instruction.trim() === '') {
    issues.push({ field: HARBOR_INSTRUCTION_FILE, message: 'instruction.md rỗng — task cần một đề bài.' });
    return issues;
  }
  if (instruction.trim().length < 20) {
    issues.push({
      field: HARBOR_INSTRUCTION_FILE,
      message: 'instruction.md quá ngắn (< 20 ký tự) — đề bài phải mô tả rõ việc cần làm.',
    });
  }
  return issues;
}

/** Validate test.sh: không rỗng, không chứa mẫu phá hoại. */
export function validateHarborTestScript(testScript: string): HarborValidationIssue[] {
  const issues: HarborValidationIssue[] = [];
  if (typeof testScript !== 'string' || testScript.trim() === '') {
    issues.push({ field: `tests/${HARBOR_TEST_SCRIPT}`, message: 'tests/test.sh rỗng — task cần script chấm.' });
    return issues;
  }
  for (const { pattern, reason } of HARBOR_FORBIDDEN_TEST_PATTERNS) {
    if (pattern.test(testScript)) {
      issues.push({
        field: `tests/${HARBOR_TEST_SCRIPT}`,
        message: `test.sh chứa mẫu bị cấm (${reason}) — script chấm không được phá hoại hệ thống.`,
      });
    }
  }
  return issues;
}

/** Cảnh báo (không chặn) cho test.sh: gọi mạng, shutdown... */
export function harborTestScriptWarnings(testScript: string): HarborValidationIssue[] {
  const warnings: HarborValidationIssue[] = [];
  if (typeof testScript !== 'string') return warnings;
  for (const { pattern, reason } of HARBOR_SUSPICIOUS_TEST_PATTERNS) {
    if (pattern.test(testScript)) {
      warnings.push({ field: `tests/${HARBOR_TEST_SCRIPT}`, message: `Cảnh báo: ${reason}.` });
    }
  }
  return warnings;
}

/** Validate danh sách file environment: đường dẫn an toàn, không trùng. */
export function validateHarborEnvironment(files: readonly HarborEnvironmentFile[]): HarborValidationIssue[] {
  const issues: HarborValidationIssue[] = [];
  const seen = new Set<string>();
  for (const file of files) {
    if (!isSafeRelativePath(file.relativePath)) {
      issues.push({
        field: HARBOR_ENVIRONMENT_DIR,
        message: `đường dẫn environment không an toàn: "${file.relativePath}" (phải tương đối, không "..", không tuyệt đối).`,
      });
      continue;
    }
    const normalized = path.posix.normalize(file.relativePath.replace(/\\/g, '/'));
    if (seen.has(normalized)) {
      issues.push({ field: HARBOR_ENVIRONMENT_DIR, message: `file environment trùng nhau: "${normalized}".` });
    }
    seen.add(normalized);
    if (typeof file.content !== 'string') {
      issues.push({ field: HARBOR_ENVIRONMENT_DIR, message: `nội dung file "${normalized}" phải là chuỗi UTF-8.` });
    }
  }
  return issues;
}

/** Validate toàn bộ một HarborTask đã load (meta + instruction + env + test). */
export function validateHarborTask(task: HarborTask): HarborValidationResult {
  const issues: HarborValidationIssue[] = [];
  issues.push(...validateHarborTaskMeta(task.meta));
  issues.push(...validateHarborInstruction(task.instruction));
  issues.push(...validateHarborEnvironment(task.environment));
  issues.push(...validateHarborTestScript(task.testScript));
  // Mọi test có trọng số đều nên được test.sh in ra — kiểm tra tĩnh
  // đơn giản: tên test phải xuất hiện trong test.sh (dạng PASS/FAIL).
  for (const testName of Object.keys(task.meta.testWeights)) {
    if (!task.testScript.includes(testName)) {
      issues.push({
        field: `tests/${HARBOR_TEST_SCRIPT}`,
        message: `test "${testName}" có trọng số trong task.json nhưng không xuất hiện trong test.sh — script chấm phải in PASS/FAIL cho test này.`,
      });
    }
  }
  return { valid: issues.length === 0, issues };
}

/** Lỗi load/validate task — mang theo toàn bộ issues để caller báo rõ. */
export class HarborTaskError extends Error {
  readonly issues: HarborValidationIssue[];
  constructor(message: string, issues: HarborValidationIssue[]) {
    super(message);
    this.name = 'HarborTaskError';
    this.issues = issues;
  }
}

/** Đọc đệ quy mọi file dưới một thư mục, trả về đường dẫn tương đối (posix). */
function listFilesRecursive(dir: string, base: string = dir): string[] {
  const out: string[] = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFilesRecursive(full, base));
    else if (entry.isFile()) out.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return out.sort();
}

/**
 * Load một Harbor task từ thư mục trên đĩa. Ném HarborTaskError khi
 * thiếu file bắt buộc hoặc validation fail (kèm toàn bộ issues).
 * Thư mục task KHÔNG được chứa symlink thoát ra ngoài: file
 * environment là symlink sẽ bị chặn.
 */
export function loadHarborTaskFromDir(dir: string): HarborTask {
  const issues: HarborValidationIssue[] = [];
  const metaPath = path.join(dir, HARBOR_META_FILE);
  const instructionPath = path.join(dir, HARBOR_INSTRUCTION_FILE);
  const testPath = path.join(dir, HARBOR_TESTS_DIR, HARBOR_TEST_SCRIPT);
  const envDir = path.join(dir, HARBOR_ENVIRONMENT_DIR);

  if (!fs.existsSync(metaPath)) {
    issues.push({ field: HARBOR_META_FILE, message: `thiếu file ${HARBOR_META_FILE} trong thư mục task.` });
  }
  if (!fs.existsSync(instructionPath)) {
    issues.push({ field: HARBOR_INSTRUCTION_FILE, message: `thiếu file ${HARBOR_INSTRUCTION_FILE} trong thư mục task.` });
  }
  if (!fs.existsSync(testPath)) {
    issues.push({ field: `tests/${HARBOR_TEST_SCRIPT}`, message: `thiếu file tests/${HARBOR_TEST_SCRIPT} trong thư mục task.` });
  }
  if (issues.length > 0) throw new HarborTaskError(`Không load được Harbor task từ "${dir}".`, issues);

  let metaRaw: unknown;
  try {
    metaRaw = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
  } catch (err) {
    throw new HarborTaskError(`Không load được Harbor task từ "${dir}".`, [
      { field: HARBOR_META_FILE, message: `task.json không phải JSON hợp lệ: ${(err as Error).message}` },
    ]);
  }
  issues.push(...validateHarborTaskMeta(metaRaw));
  const meta = metaRaw as HarborTaskMeta;

  const instruction = fs.readFileSync(instructionPath, 'utf-8');
  issues.push(...validateHarborInstruction(instruction));

  const testScript = fs.readFileSync(testPath, 'utf-8');
  issues.push(...validateHarborTestScript(testScript));

  // Environment: đọc mọi file, chặn symlink + đường dẫn không an toàn.
  const environment: HarborEnvironmentFile[] = [];
  if (fs.existsSync(envDir)) {
    for (const rel of listFilesRecursive(envDir)) {
      const full = path.join(envDir, rel);
      if (fs.lstatSync(full).isSymbolicLink()) {
        issues.push({ field: HARBOR_ENVIRONMENT_DIR, message: `file environment là symlink (bị chặn): "${rel}".` });
        continue;
      }
      if (!isSafeRelativePath(rel)) {
        issues.push({ field: HARBOR_ENVIRONMENT_DIR, message: `đường dẫn environment không an toàn: "${rel}".` });
        continue;
      }
      environment.push({ relativePath: rel, content: fs.readFileSync(full, 'utf-8') });
    }
  }
  issues.push(...validateHarborEnvironment(environment));

  if (issues.length > 0) {
    throw new HarborTaskError(`Harbor task "${typeof metaRaw === 'object' && metaRaw !== null ? (metaRaw as Record<string, unknown>)['id'] : dir}" không hợp lệ.`, issues);
  }
  // Cross-check test names vs test.sh (nằm trong validateHarborTask).
  const task: HarborTask = { meta, instruction, environment, testScript, dir };
  const cross = validateHarborTask(task);
  if (!cross.valid) throw new HarborTaskError(`Harbor task "${meta.id}" không hợp lệ.`, cross.issues);
  return task;
}

/**
 * Ghi một HarborTask ra thư mục trên đĩa (tạo thư mục nếu chưa có).
 * Dùng để materialize task mẫu (harborLibrary.ts) hoặc export task
 * do user tạo trong RAM. Ghi đè file cùng tên trong thư mục đích.
 */
export function writeHarborTaskToDir(task: HarborTask, dir: string): string {
  const validation = validateHarborTask(task);
  if (!validation.valid) {
    throw new HarborTaskError(`Không ghi được Harbor task "${task.meta.id}" (không hợp lệ).`, validation.issues);
  }
  fs.mkdirSync(path.join(dir, HARBOR_ENVIRONMENT_DIR), { recursive: true });
  fs.mkdirSync(path.join(dir, HARBOR_TESTS_DIR), { recursive: true });
  fs.writeFileSync(path.join(dir, HARBOR_META_FILE), `${JSON.stringify(task.meta, null, 2)}\n`, 'utf-8');
  fs.writeFileSync(path.join(dir, HARBOR_INSTRUCTION_FILE), task.instruction, 'utf-8');
  fs.writeFileSync(path.join(dir, HARBOR_TESTS_DIR, HARBOR_TEST_SCRIPT), task.testScript, 'utf-8');
  try {
    fs.chmodSync(path.join(dir, HARBOR_TESTS_DIR, HARBOR_TEST_SCRIPT), 0o755);
  } catch {
    // Windows không có chmod POSIX — bỏ qua, runner gọi qua `sh test.sh`.
  }
  for (const file of task.environment) {
    const dest = path.join(dir, HARBOR_ENVIRONMENT_DIR, file.relativePath);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, file.content, 'utf-8');
  }
  return dir;
}

/** Liệt kê các thư mục con trong `tasksDir`, mỗi thư mục là một task. */
export function listHarborTaskDirs(tasksDir: string): string[] {
  if (!fs.existsSync(tasksDir)) return [];
  return fs
    .readdirSync(tasksDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => path.join(tasksDir, e.name))
    .sort();
}

/**
 * Load mọi task hợp lệ trong một thư mục (mỗi thư mục con = 1 task).
 * Task lỗi được bỏ qua nhưng ghi lại vào `skipped` (kèm lý do) để
 * caller báo cho user thay vì im lặng mất task.
 */
export function loadHarborTasksFromDir(tasksDir: string): {
  tasks: HarborTask[];
  skipped: { dir: string; issues: HarborValidationIssue[] }[];
} {
  const tasks: HarborTask[] = [];
  const skipped: { dir: string; issues: HarborValidationIssue[] }[] = [];
  for (const dir of listHarborTaskDirs(tasksDir)) {
    try {
      tasks.push(loadHarborTaskFromDir(dir));
    } catch (err) {
      if (err instanceof HarborTaskError) skipped.push({ dir, issues: err.issues });
      else skipped.push({ dir, issues: [{ field: 'task', message: (err as Error).message }] });
    }
  }
  return { tasks, skipped };
}

/** Kết quả parse output của test.sh: dòng `PASS <name>` / `FAIL <name>`. */
export interface HarborTestOutput {
  passed: string[];
  failed: string[];
  /** Dòng không hiểu (log thường của test) — giữ lại để debug. */
  otherLines: string[];
}

/**
 * Parse stdout/stderr của test.sh. Mỗi test in đúng một dòng
 * `PASS <tên>` hoặc `FAIL <tên>`; dòng khác được giữ nguyên làm log.
 * Test in cả PASS lẫn FAIL (chạy 2 lần) thì lần FAIL thắng — kết quả
 * cuối cùng mới tính.
 */
export function parseHarborTestOutput(output: string): HarborTestOutput {
  const passed = new Set<string>();
  const failed = new Set<string>();
  const otherLines: string[] = [];
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '') continue;
    const passMatch = /^PASS\s+(\S+)\s*$/.exec(line);
    if (passMatch) {
      passed.add(passMatch[1]);
      failed.delete(passMatch[1]);
      continue;
    }
    const failMatch = /^FAIL\s+(\S+)\s*$/.exec(line);
    if (failMatch) {
      failed.add(failMatch[1]);
      passed.delete(failMatch[1]);
      continue;
    }
    otherLines.push(rawLine);
  }
  return { passed: [...passed].sort(), failed: [...failed].sort(), otherLines };
}

/**
 * Tính reward (điểm) của một task từ kết quả test: tổng trọng số
 * test pass / tổng trọng số. Test không được test.sh nhắc tới coi
 * như FAIL (trọng số vẫn tính vào mẫu số) — test im lặng không
 * được điểm. Trả về cả chi tiết từng test để báo cáo.
 */
export function scoreHarborTests(
  testWeights: Record<string, number>,
  output: HarborTestOutput,
): { reward: number; passedWeight: number; totalWeight: number; perTest: { name: string; weight: number; passed: boolean }[] } {
  const perTest = Object.entries(testWeights)
    .map(([name, weight]) => ({ name, weight, passed: output.passed.includes(name) }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const totalWeight = perTest.reduce((sum, t) => sum + t.weight, 0);
  const passedWeight = perTest.filter((t) => t.passed).reduce((sum, t) => sum + t.weight, 0);
  return {
    reward: totalWeight > 0 ? passedWeight / totalWeight : 0,
    passedWeight,
    totalWeight,
    perTest,
  };
}

/**
 * Eval Harness v2 — task format + result types (v1.34, Đội T4).
 *
 * Ý tưởng học từ Terminal-Bench 2.0 / SWE-bench Pro / Harbor (theo survey
 * docs/repo-survey-v134.md §4): KHÔNG copy code/text/tài sản của bất kỳ
 * repo nào. Chỉ cùng bố cục kiến trúc 3 lớp: rollout worker (stateless,
 * sandbox), judge (test xác định, không LLM judge), aggregation (điểm +
 * khoảng tin cậy).
 *
 * Một task v2 là một thư mục hoặc một object JSON:
 *
 *   task.json        — metadata + input/output + tests (xem EvalHarnessV2Task)
 *   instruction.md   — đề bài giao cho agent (tự chứa, đọc được)
 *   environment/     — file khởi đầu, copy vào workdir trước khi agent chạy
 *   oracle/          — oracle solution: file agent "đáng lẽ" tạo ra, hoặc
 *                      script chứng minh task giải được (xem OracleSolution)
 *   tests/           — mỗi test là một lệnh shell chạy trong workdir;
 *                      exit 0 = pass, khác 0 = fail (không LLM judge)
 *
 * Hai loại task:
 * - `issue-patch` (kiểu SWE-bench): task có issue + repo snapshot; patch
 *   của agent phải làm test `fail-to-pass` chuyển fail → pass và giữ
 *   `pass-to-pass` vẫn pass.
 * - `state-check` (kiểu terminal-bench): agent làm gì tùy ý trong
 *   workdir (ghi file, chạy lệnh); test kiểm tra TRẠNG THÁI CUỐI của
 *   máy (file, process, build) thay vì chấm patch.
 *
 * Task KHÔNG có oracle hợp lệ thì bị từ chối khi load (xem oracle.ts):
 * oracle phải chạy qua được toàn bộ test thì task mới được coi là
 * giải được.
 */

export const EVAL_HARNESS_V2_FORMAT = 'eval-harness-v2' as const;
export const EVAL_HARNESS_V2_VERSION = 2 as const;

/** Loại task v2. */
export type EvalHarnessV2TaskKind = 'issue-patch' | 'state-check';

/** Độ khó — ghi rõ trong định dạng task, dùng để lọc + báo cáo. */
export type EvalHarnessV2Difficulty = 'easy' | 'medium' | 'hard';

export const EVAL_HARNESS_V2_KINDS: readonly EvalHarnessV2TaskKind[] = [
  'issue-patch',
  'state-check',
];

export const EVAL_HARNESS_V2_DIFFICULTIES: readonly EvalHarnessV2Difficulty[] = [
  'easy',
  'medium',
  'hard',
];

/** Id task: chữ thường, số, `-`, `_`, bắt đầu bằng chữ/số. */
export const EVAL_HARNESS_V2_TASK_ID_RE = /^[a-z0-9][a-z0-9_-]*$/;

export const EVAL_HARNESS_V2_MIN_TIMEOUT_MS = 5_000;
export const EVAL_HARNESS_V2_MAX_TIMEOUT_MS = 1_800_000;
export const EVAL_HARNESS_V2_DEFAULT_TIMEOUT_MS = 120_000;
export const EVAL_HARNESS_V2_DEFAULT_MAX_TRIALS = 3;
export const EVAL_HARNESS_V2_DEFAULT_CONCURRENCY = 4;
export const EVAL_HARNESS_V2_MAX_CONCURRENCY = 32;

/** Một test xác định: lệnh shell chạy trong workdir, exit 0 = pass. */
export interface EvalHarnessV2Test {
  /** Id ổn định, vd `add-returns-sum`. */
  id: string;
  /** Tên hiển thị ngắn. */
  name: string;
  /** Lệnh shell (chạy bằng `sh -c` trong workdir, timeout riêng). */
  command: string;
  /**
   * Nhóm chấm: `fail-to-pass` (phải fail trước patch, pass sau patch —
   * chỉ dùng cho issue-patch), `pass-to-pass` (phải pass cả trước và
   * sau patch), `state-check` (kiểm tra trạng thái cuối — chỉ dùng
   * cho state-check). Mặc định: `state-check` cho task state-check,
   * `fail-to-pass` cho task issue-patch.
   */
  group?: 'fail-to-pass' | 'pass-to-pass' | 'state-check';
  /** Trọng số khi tính điểm task (mặc định 1, phải > 0). */
  weight?: number;
  /** Timeout riêng cho test này (ms). Mặc định = timeout của task. */
  timeoutMs?: number;
}

/** Input của task: mô tả những gì agent nhận được. */
export interface EvalHarnessV2Input {
  /** Đề bài đầy đủ (nội dung instruction.md). */
  instruction: string;
  /**
   * Mô tả issue (chỉ issue-patch): vd tiêu đề + thân issue GitHub.
   * State-check để trống.
   */
  issue?: string;
  /**
   * Repo snapshot (chỉ issue-patch): map đường dẫn tương đối → nội
   * dung file. Agent patch được áp lên snapshot này.
   */
  repoSnapshot?: Record<string, string>;
  /**
   * File môi trường khởi đầu (cả 2 loại): map đường dẫn tương đối →
   * nội dung file, copy vào workdir trước khi agent chạy.
   */
  environmentFiles?: Record<string, string>;
}

/** Output kỳ vọng của task: agent phải tạo ra cái gì để test pass. */
export interface EvalHarnessV2Output {
  /** Mô tả ngắn output kỳ vọng (để người đọc hiểu task, không chấm bằng nó). */
  description: string;
  /**
   * File agent phải tạo/sửa (đường dẫn tương đối). Chỉ là gợi ý cho
   * người đọc — test mới là nguồn chân lý, không chấm theo danh sách này.
   */
  expectedFiles?: string[];
}

/** Oracle solution: bằng chứng task giải được (xem oracle.ts). */
export interface EvalHarnessV2Oracle {
  /**
   * File oracle sẽ tạo/ghi đè trong workdir (map đường dẫn → nội
   * dung). Với issue-patch đây chính là patch đúng; với state-check
   * đây là trạng thái cuối đúng.
   */
  files?: Record<string, string>;
  /**
   * Lệnh oracle chạy trong workdir (sau khi ghi `files`), vd tạo
   * file bằng script. Tùy chọn — dùng khi trạng thái cuối không
   * diễn tả được bằng file tĩnh.
   */
  commands?: string[];
  /** Ghi chú vì sao oracle này giải được task (để người review hiểu). */
  note?: string;
}

/** Metadata + nội dung đầy đủ của một task v2. */
export interface EvalHarnessV2Task {
  /** Định dạng — luôn là `'eval-harness-v2'`. */
  format: typeof EVAL_HARNESS_V2_FORMAT;
  /** Phiên bản định dạng — luôn là 2. */
  version: typeof EVAL_HARNESS_V2_VERSION;
  /** Id ổn định, vd `v2-sample-add`. */
  id: string;
  /** Tên hiển thị ngắn. */
  name: string;
  /** Mô tả một dòng (hiện trong UI/list). */
  description: string;
  /** Loại task: issue-patch hay state-check. */
  kind: EvalHarnessV2TaskKind;
  /** Độ khó: easy | medium | hard. */
  difficulty: EvalHarnessV2Difficulty;
  /** Timeout toàn task (agent + test), ms. Mặc định 120_000. */
  timeoutMs: number;
  /** Số trial mặc định khi chạy task này (mặc định 3). */
  maxTrials?: number;
  /** Số bước/tool call tối đa gợi ý cho agent (mặc định 20). */
  maxSteps?: number;
  /** Input: instruction + issue + snapshot + environment. */
  input: EvalHarnessV2Input;
  /** Output kỳ vọng (mô tả, không dùng để chấm). */
  output: EvalHarnessV2Output;
  /** Oracle solution — bắt buộc, phải qua hết test (xem oracle.ts). */
  oracle: EvalHarnessV2Oracle;
  /** Bộ test xác định — ít nhất 1 test. */
  tests: EvalHarnessV2Test[];
  /** Tag tự do để lọc task (vd `node`, `file-io`). */
  tags?: string[];
  /** Thư mục gốc task trên đĩa (undefined khi task tạo trong RAM). */
  dir?: string;
}

/** Kết quả chạy một test xác định trong một trial. */
export interface EvalHarnessV2TestResult {
  testId: string;
  name: string;
  group: 'fail-to-pass' | 'pass-to-pass' | 'state-check';
  /** Pass trước khi agent chạy (chỉ issue-patch mới đo; state-check = null). */
  basePassed: boolean | null;
  /** Pass sau khi agent chạy. */
  afterPassed: boolean;
  /** Kỳ vọng có đạt không (fail-to-pass: !base && after; còn lại: after). */
  expectationMet: boolean;
  /** Trọng số của test. */
  weight: number;
  /** Thời gian chạy test (ms). */
  durationMs: number;
  /** stdout (cắt ngắn) của test — để debug, không chấm bằng nó. */
  stdout?: string;
  /** stderr (cắt ngắn) khi fail. */
  stderr?: string;
  /** Timeout hay không. */
  timedOut?: boolean;
}

/** Trạng thái kết thúc của một trial. */
export type EvalHarnessV2TrialStatus =
  | 'pass'
  | 'fail'
  | 'timeout'
  | 'cancelled'
  | 'error';

/** Kết quả một trial (một lần chạy task). */
export interface EvalHarnessV2TrialResult {
  /** Id trial: `<taskId>-t<trialIndex>`. */
  trialId: string;
  taskId: string;
  /** Số thứ tự trial (0-based). */
  trialIndex: number;
  status: EvalHarnessV2TrialStatus;
  /** Điểm có trọng số 0..1 = tổng weight test đạt / tổng weight. */
  score: number;
  /** Kết quả từng test. */
  tests: EvalHarnessV2TestResult[];
  /** Số test đạt kỳ vọng / tổng số test. */
  passedTests: number;
  totalTests: number;
  /** Thời gian trial (ms, từ lúc tạo workdir tới lúc chấm xong). */
  durationMs: number;
  /** Số bước/tool call agent đã dùng (executor báo cáo). */
  steps: number;
  /** Token ước tính agent đã dùng (executor báo cáo, 0 khi không rõ). */
  inputTokens: number;
  outputTokens: number;
  /** Chi phí USD ước tính (scorer tính, xem scorer.ts). */
  estimatedCostUsd: number;
  /** Agent chạy trong sandbox (bwrap) hay fallback local (xem sandbox.ts). */
  sandboxed: boolean;
  /** Cảnh báo khi chạy fallback local (sandbox không có). */
  sandboxWarning?: string;
  /** Trace OTel: traceId nối vào hệ tracing sẵn có của repo. */
  otelTraceId?: string;
  /** Lý do ngắn khi status != pass (vd `2/3 test fail`, `timeout 120000ms`). */
  reason: string;
  /** Thời điểm bắt đầu trial (epoch ms). */
  startedAt: number;
  /** Thời điểm kết thúc trial (epoch ms). */
  finishedAt: number;
}

/** Kết quả chạy một task (gộp N trial). */
export interface EvalHarnessV2TaskResult {
  taskId: string;
  taskName: string;
  kind: EvalHarnessV2TaskKind;
  difficulty: EvalHarnessV2Difficulty;
  trials: EvalHarnessV2TrialResult[];
  /** Tỉ lệ trial pass (0..1). */
  passRate: number;
  /** Điểm trung bình các trial (0..1). */
  meanScore: number;
  /** Thời gian trung bình / trial (ms). */
  meanDurationMs: number;
  /** Số bước trung bình / trial. */
  meanSteps: number;
  /** Chi phí trung bình / trial (USD). */
  meanCostUsd: number;
}

/** Kết quả chạy một suite (nhiều task). */
export interface EvalHarnessV2SuiteResult {
  /** Id suite, vd `v2-sample`. */
  suiteId: string;
  /** Id chạy ổn định: `eval-harness-v2-<uuid>`. */
  runId: string;
  /** Nhãn agent/executor đã chạy (vd `scripted`, `noop`). */
  agentLabel: string;
  startedAt: number;
  finishedAt: number;
  durationMs: number;
  tasks: EvalHarnessV2TaskResult[];
  /** Tỉ lệ task có passRate = 1 (task nào trial nào cũng pass mới tính). */
  taskPassRate: number;
  /** Tỉ lệ trial pass trên toàn suite. */
  trialPassRate: number;
  /** Điểm trung bình toàn suite (0..1). */
  meanScore: number;
  /** Khoảng tin cậy Wilson 95% cho trialPassRate (xem scorer.ts). */
  trialPassRateCi95: { lower: number; upper: number };
  /** Tổng chi phí ước tính toàn suite (USD). */
  totalCostUsd: number;
  /** Tổng thời gian chạy trial (ms, cộng dồn — khác durationMs khi chạy song song). */
  totalTrialMs: number;
}

/** Một suite: danh sách task + metadata. */
export interface EvalHarnessV2Suite {
  id: string;
  name: string;
  description: string;
  tasks: EvalHarnessV2Task[];
}

/** Lỗi validation — kèm trường lỗi để UI/tool/CLI báo rõ. */
export interface EvalHarnessV2ValidationIssue {
  field: string;
  message: string;
}

/** Kết quả validate: `valid` true khi không còn lỗi nào. */
export interface EvalHarnessV2ValidationResult {
  valid: boolean;
  issues: EvalHarnessV2ValidationIssue[];
  /** Cảnh báo (không chặn load, vd test không có trọng số → dùng 1). */
  warnings: EvalHarnessV2ValidationIssue[];
}

/** Mẫu phá hoại bị cấm trong lệnh test/oracle (chạy trong sandbox nhưng vẫn chặn sớm). */
export const EVAL_HARNESS_V2_FORBIDDEN_COMMAND_PATTERNS: readonly {
  pattern: RegExp;
  reason: string;
}[] = [
  { pattern: /(^|\s)rm\s+(-[a-z]*r[a-z]*f?|--recursive)\s+\//, reason: 'xoá đệ quy từ gốc hệ thống' },
  { pattern: /\brm\s+-rf\s+\//, reason: 'xoá đệ quy từ gốc hệ thống' },
  { pattern: /\bmkfs(\.|$|\s)/, reason: 'format ổ đĩa' },
  { pattern: /\bdd\s+.*\bof=\/dev\//, reason: 'ghi trực tiếp lên thiết bị' },
  { pattern: />\s*\/dev\/[a-z]+/, reason: 'ghi trực tiếp lên thiết bị' },
  { pattern: /\bchmod\s+(-R\s+)?777\s+\//, reason: 'mở quyền toàn hệ thống' },
  { pattern: /\bcurl\b.*\|\s*(sh|bash)\b/, reason: 'chạy code tải từ mạng' },
  { pattern: /\bwget\b.*\|\s*(sh|bash)\b/, reason: 'chạy code tải từ mạng' },
];

/** Mẫu đường dẫn thoát khỏi workdir/task — bị chặn khi load. */
export function isUnsafeRelativePath(p: string): boolean {
  if (typeof p !== 'string' || p.length === 0) return true;
  if (p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p)) return true;
  const parts = p.split(/[\\/]+/);
  return parts.includes('..') || parts.includes('') && p !== '';
}

/** Chuẩn hoá group của test theo loại task (dùng khi group bỏ trống). */
export function defaultTestGroup(
  kind: EvalHarnessV2TaskKind,
): 'fail-to-pass' | 'pass-to-pass' | 'state-check' {
  return kind === 'issue-patch' ? 'fail-to-pass' : 'state-check';
}

/**
 * Eval Harness v3 — task format + result types (v1.35, Đội T4).
 *
 * V3 kế thừa v2 (cùng bố cục 3 lớp: rollout worker stateless trong
 * container, judge là test xác định, aggregation điểm + khoảng tin
 * cậy) và thêm 3 trụ mới — ý tưởng học từ SWE-bench (issue → patch
 * có container + oracle + test fail-to-pass/pass-to-pass) và từ
 * OpenAI Agents SDK (guardrails kiểu input/output/tool + tripwire):
 * KHÔNG copy code/text/tài sản của bất kỳ repo nào.
 *
 * Điểm mới so với v2:
 * - Container spec tường minh cho mỗi task: image (name/tag/digest),
 *   giới hạn tài nguyên (CPU/RAM/disk), chế độ mạng, setup commands,
 *   biến môi trường. Runner chạy trong Docker khi có, bwrap khi
 *   không, local fallback có cảnh báo (xem sandbox.ts).
 * - Guardrails (xem guardrails.ts): input/output/tool guardrail với
 *   tripwire dừng run; chạy song song hoặc tuần tự.
 * - Decision tracing (xem tracing.ts): ghi lại từng bước đánh giá
 *   (span) để truy vết vì sao một trial pass/fail/trip.
 * - Registry (xem registry.ts): đăng ký eval theo bộ (eval set),
 *   chạy theo bộ, pin version.
 * - Regression gates mạnh hơn (xem regressionGate.ts): ngưỡng riêng
 *   cho pass rate / score / cost / duration, lịch sử gate, chặn merge.
 * - Scorer (xem scorer.ts): pass@k, Wilson CI, điểm đã hiệu chỉnh
 *   flake (test không ổn định chạy lại N lần).
 *
 * Một task v3 là một thư mục hoặc một object JSON:
 *
 *   task.json        — metadata + input/output + tests + container
 *   instruction.md   — đề bài giao cho agent (tự chứa, đọc được)
 *   container.json   — container spec (image, resources, network)
 *   environment/     — file khởi đầu, copy vào workdir trước khi agent chạy
 *   oracle/          — oracle solution: file agent "đáng lẽ" tạo ra, hoặc
 *                      script chứng minh task giải được (xem OracleSolution)
 *   tests/           — mỗi test là một lệnh shell chạy trong workdir;
 *                      exit 0 = pass, khác 0 = fail (không LLM judge)
 *   guardrails.json  — cấu hình guardrail riêng cho task (tùy chọn)
 *
 * Hai loại task (như v2):
 * - `issue-patch` (kiểu SWE-bench): task có issue + repo snapshot;
 *   patch của agent phải làm test `fail-to-pass` chuyển fail → pass
 *   và giữ `pass-to-pass` vẫn pass. Patch được áp trong container
 *   từ base commit ghi trong task.
 * - `state-check` (kiểu terminal-bench): agent làm gì tùy ý trong
 *   workdir (ghi file, chạy lệnh); test kiểm tra TRẠNG THÁI CUỐI của
 *   máy (file, process, build) thay vì chấm patch.
 *
 * Task KHÔNG có oracle hợp lệ thì bị từ chối khi load (xem oracle.ts):
 * oracle phải chạy qua được toàn bộ test, và phải ổn định qua N lần
 * chạy (không flaky) thì task mới được coi là giải được.
 */

export const EVAL_HARNESS_V3_FORMAT = 'eval-harness-v3' as const;
export const EVAL_HARNESS_V3_VERSION = 3 as const;

/** Loại task v3 (giữ nguyên 2 loại của v2). */
export type EvalHarnessV3TaskKind = 'issue-patch' | 'state-check';

/** Độ khó — ghi rõ trong định dạng task, dùng để lọc + báo cáo. */
export type EvalHarnessV3Difficulty = 'easy' | 'medium' | 'hard';

export const EVAL_HARNESS_V3_KINDS: readonly EvalHarnessV3TaskKind[] = [
  'issue-patch',
  'state-check',
];

export const EVAL_HARNESS_V3_DIFFICULTIES: readonly EvalHarnessV3Difficulty[] = [
  'easy',
  'medium',
  'hard',
];

/** Id task: chữ thường, số, `-`, `_`, bắt đầu bằng chữ/số. */
export const EVAL_HARNESS_V3_TASK_ID_RE = /^[a-z0-9][a-z0-9_-]*$/;

/** Id eval set: cùng quy tắc như id task. */
export const EVAL_HARNESS_V3_SET_ID_RE = /^[a-z0-9][a-z0-9_-]*$/;

export const EVAL_HARNESS_V3_MIN_TIMEOUT_MS = 5_000;
export const EVAL_HARNESS_V3_MAX_TIMEOUT_MS = 3_600_000;
export const EVAL_HARNESS_V3_DEFAULT_TIMEOUT_MS = 180_000;
export const EVAL_HARNESS_V3_DEFAULT_MAX_TRIALS = 3;
export const EVAL_HARNESS_V3_DEFAULT_CONCURRENCY = 4;
export const EVAL_HARNESS_V3_MAX_CONCURRENCY = 32;
/** Số lần chạy lại mặc định khi kiểm tra oracle có flaky hay không. */
export const EVAL_HARNESS_V3_DEFAULT_ORACLE_REPEATS = 3;
/** Số lần chạy lại mặc định cho test bị nghi flaky khi chấm. */
export const EVAL_HARNESS_V3_DEFAULT_FLAKE_RETRIES = 2;

// ---------------------------------------------------------------------------
// Container spec
// ---------------------------------------------------------------------------

/** Chế độ mạng của container chạy trial. */
export type EvalHarnessV3NetworkMode = 'none' | 'loopback' | 'proxy';

/** Backend thực thi container. */
export type EvalHarnessV3ContainerBackend = 'docker' | 'bwrap' | 'local';

export const EVAL_HARNESS_V3_NETWORK_MODES: readonly EvalHarnessV3NetworkMode[] = [
  'none',
  'loopback',
  'proxy',
];

/** Giới hạn tài nguyên cho container chạy một trial. */
export interface EvalHarnessV3ResourceLimits {
  /** Số CPU (vd 1, 2; có thể là số thập phân như 0.5). */
  cpus?: number;
  /** RAM tối đa, vd `512m`, `2g`. */
  memory?: string;
  /** Disk tối đa cho workdir, vd `1g`, `5g`. */
  disk?: string;
  /** Số process tối đa (pids limit). */
  pids?: number;
}

/** Container spec của một task v3. */
export interface EvalHarnessV3ContainerSpec {
  /** Image: vd `node:22-slim`. Bắt buộc phải có tên. */
  image: string;
  /** Tag image (mặc định `latest` khi không ghi — nhưng task nên pin tag). */
  tag?: string;
  /** Digest sha256 của image khi muốn pin tuyệt đối (vd `sha256:abc...`). */
  digest?: string;
  /** Lệnh setup chạy trong container trước khi agent bắt đầu (vd `npm ci`). */
  setupCommands?: string[];
  /** Biến môi trường đưa vào container (không chứa secret — xem guardrails). */
  env?: Record<string, string>;
  /** Chế độ mạng (mặc định `none` — không mạng). */
  network?: EvalHarnessV3NetworkMode;
  /** Giới hạn tài nguyên (mặc định theo DEFAULT_CONTAINER_LIMITS). */
  resources?: EvalHarnessV3ResourceLimits;
  /** Thư mục làm việc trong container (mặc định `/work`). */
  workdir?: string;
}

/** Container spec mặc định khi task không khai báo. */
export const DEFAULT_EVAL_HARNESS_V3_CONTAINER: EvalHarnessV3ContainerSpec = {
  image: 'node:22-slim',
  tag: 'latest',
  network: 'none',
  workdir: '/work',
  resources: { cpus: 1, memory: '512m', disk: '1g', pids: 256 },
};

/** Chuẩn hoá container spec: điền mặc định cho các trường thiếu. */
export function normalizeContainerSpec(
  spec: EvalHarnessV3ContainerSpec | undefined,
): EvalHarnessV3ContainerSpec {
  const base = DEFAULT_EVAL_HARNESS_V3_CONTAINER;
  return {
    image: spec?.image ?? base.image,
    tag: spec?.tag ?? base.tag,
    ...(spec?.digest !== undefined ? { digest: spec.digest } : {}),
    setupCommands: [...(spec?.setupCommands ?? [])],
    env: { ...(spec?.env ?? {}) },
    network: spec?.network ?? base.network,
    workdir: spec?.workdir ?? base.workdir,
    resources: {
      cpus: spec?.resources?.cpus ?? base.resources?.cpus,
      memory: spec?.resources?.memory ?? base.resources?.memory,
      disk: spec?.resources?.disk ?? base.resources?.disk,
      pids: spec?.resources?.pids ?? base.resources?.pids,
    },
  };
}

// ---------------------------------------------------------------------------
// Test + task
// ---------------------------------------------------------------------------

/** Một test xác định: lệnh shell chạy trong workdir, exit 0 = pass. */
export interface EvalHarnessV3Test {
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
  /**
   * Test này có được chạy lại khi kết quả không ổn định không
   * (mặc định true). Test gọi mạng/giờ thật nên đặt false để khỏi
   * bị đánh dấu flaky oan.
   */
  retryOnFlake?: boolean;
}

/** Input của task: mô tả những gì agent nhận được. */
export interface EvalHarnessV3Input {
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
   * Base commit mà snapshot được lấy từ đó (chỉ issue-patch, vd
   * `abc1234`). Dùng để truy vết: patch nào, trên commit nào.
   */
  baseCommit?: string;
  /**
   * File môi trường khởi đầu (cả 2 loại): map đường dẫn tương đối →
   * nội dung file, copy vào workdir trước khi agent chạy.
   */
  environmentFiles?: Record<string, string>;
}

/** Output kỳ vọng của task: agent phải tạo ra cái gì để test pass. */
export interface EvalHarnessV3Output {
  /** Mô tả ngắn output kỳ vọng (để người đọc hiểu task, không chấm bằng nó). */
  description: string;
  /**
   * File agent phải tạo/sửa (đường dẫn tương đối). Chỉ là gợi ý cho
   * người đọc — test mới là nguồn chân lý, không chấm theo danh sách này.
   */
  expectedFiles?: string[];
}

/** Oracle solution: bằng chứng task giải được (xem oracle.ts). */
export interface EvalHarnessV3Oracle {
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
  /**
   * Patch dạng unified diff (tùy chọn, chỉ issue-patch): oracle
   * patch "chính thức" để đối chiếu với patch của agent khi debug.
   * Không dùng để chấm — test mới là nguồn chân lý.
   */
  patch?: string;
}

/** Cấu hình guardrail riêng cho một task (tùy chọn — xem guardrails.ts). */
export interface EvalHarnessV3TaskGuardrails {
  /** Bật/tắt guardrail cho task này (mặc định true). */
  enabled?: boolean;
  /** Chế độ chạy guardrail: `parallel` (chạy hết, gom trip) hay `sequential` (dừng ở trip đầu). */
  mode?: 'parallel' | 'sequential';
  /** Danh sách tool agent được phép gọi (undefined = không giới hạn theo tên). */
  allowedTools?: string[];
  /** Danh sách tool agent bị cấm gọi (ưu tiên hơn allowedTools). */
  deniedTools?: string[];
  /** Mẫu input bị cấm thêm cho task này (regex string, ngoài mẫu mặc định). */
  extraInputPatterns?: string[];
  /** Mẫu output bị cấm thêm cho task này (regex string, ngoài mẫu mặc định). */
  extraOutputPatterns?: string[];
  /** Số tool call tối đa cho phép trong một trial (mặc định 100). */
  maxToolCalls?: number;
}

/** Metadata + nội dung đầy đủ của một task v3. */
export interface EvalHarnessV3Task {
  /** Định dạng — luôn là `'eval-harness-v3'`. */
  format: typeof EVAL_HARNESS_V3_FORMAT;
  /** Phiên bản định dạng — luôn là 3. */
  version: typeof EVAL_HARNESS_V3_VERSION;
  /** Id ổn định, vd `v3-sample-add`. */
  id: string;
  /** Tên hiển thị ngắn. */
  name: string;
  /** Mô tả một dòng (hiện trong UI/list). */
  description: string;
  /** Loại task: issue-patch hay state-check. */
  kind: EvalHarnessV3TaskKind;
  /** Độ khó: easy | medium | hard. */
  difficulty: EvalHarnessV3Difficulty;
  /** Timeout toàn task (agent + test), ms. Mặc định 180_000. */
  timeoutMs: number;
  /** Số trial mặc định khi chạy task này (mặc định 3). */
  maxTrials?: number;
  /** Số bước/tool call tối đa gợi ý cho agent (mặc định 20). */
  maxSteps?: number;
  /** Container spec (mặc định = DEFAULT_EVAL_HARNESS_V3_CONTAINER). */
  container?: EvalHarnessV3ContainerSpec;
  /** Cấu hình guardrail riêng cho task (mặc định = guardrail mặc định). */
  guardrails?: EvalHarnessV3TaskGuardrails;
  /** Input: instruction + issue + snapshot + environment. */
  input: EvalHarnessV3Input;
  /** Output kỳ vọng (mô tả, không dùng để chấm). */
  output: EvalHarnessV3Output;
  /** Oracle solution — bắt buộc, phải qua hết test và ổn định (xem oracle.ts). */
  oracle: EvalHarnessV3Oracle;
  /** Bộ test xác định — ít nhất 1 test. */
  tests: EvalHarnessV3Test[];
  /** Tag tự do để lọc task (vd `node`, `file-io`). */
  tags?: string[];
  /** Thư mục gốc task trên đĩa (undefined khi task tạo trong RAM). */
  dir?: string;
}

// ---------------------------------------------------------------------------
// Kết quả chạy
// ---------------------------------------------------------------------------

/** Kết quả chạy một test xác định trong một trial. */
export interface EvalHarnessV3TestResult {
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
  /**
   * Test có flaky trong trial này không: chạy lại cho kết quả khác
   * lần đầu (xem scorer.ts — flake-adjusted scoring). `false` khi
   * chỉ chạy 1 lần hoặc kết quả ổn định.
   */
  flaky?: boolean;
  /** Số lần test đã chạy trong trial này (1 khi không chạy lại). */
  runs?: number;
}

/** Trạng thái kết thúc của một trial. */
export type EvalHarnessV3TrialStatus =
  | 'pass'
  | 'fail'
  | 'timeout'
  | 'cancelled'
  | 'error'
  /** Guardrail tripwire đã dừng trial (xem guardrails.ts). */
  | 'guardrail-trip';

/** Kết quả một trial (một lần chạy task). */
export interface EvalHarnessV3TrialResult {
  /** Id trial: `<taskId>-t<trialIndex>`. */
  trialId: string;
  taskId: string;
  /** Số thứ tự trial (0-based). */
  trialIndex: number;
  status: EvalHarnessV3TrialStatus;
  /** Điểm có trọng số 0..1 = tổng weight test đạt / tổng weight. */
  score: number;
  /** Kết quả từng test. */
  tests: EvalHarnessV3TestResult[];
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
  /** Backend container đã chạy trial: docker/bwrap/local. */
  containerBackend: EvalHarnessV3ContainerBackend;
  /** Agent chạy trong container (docker/bwrap) hay fallback local. */
  sandboxed: boolean;
  /** Cảnh báo khi chạy fallback local (sandbox không có). */
  sandboxWarning?: string;
  /** Trace OTel: traceId nối vào hệ tracing sẵn có của repo. */
  otelTraceId?: string;
  /** Id trace quyết định v3 (xem tracing.ts) — truy vết từng bước trial. */
  traceId?: string;
  /**
   * Guardrail đã trip trong trial này (undefined khi không trip).
   * Trial `guardrail-trip` luôn có ít nhất một trip ở đây.
   */
  guardrailTrips?: EvalHarnessV3GuardrailTrip[];
  /** Lý do ngắn khi status != pass (vd `2/3 test fail`, `timeout 120000ms`). */
  reason: string;
  /** Thời điểm bắt đầu trial (epoch ms). */
  startedAt: number;
  /** Thời điểm kết thúc trial (epoch ms). */
  finishedAt: number;
}

/** Kết quả chạy một task (gộp N trial). */
export interface EvalHarnessV3TaskResult {
  taskId: string;
  taskName: string;
  kind: EvalHarnessV3TaskKind;
  difficulty: EvalHarnessV3Difficulty;
  trials: EvalHarnessV3TrialResult[];
  /** Tỉ lệ trial pass (0..1). */
  passRate: number;
  /** Điểm trung bình các trial (0..1). */
  meanScore: number;
  /** Điểm đã hiệu chỉnh flake (trung bình điểm flake-adjusted các trial). */
  meanFlakeAdjustedScore: number;
  /** Ước tính pass@k (k = số trial, xem scorer.ts). */
  passAtK: number;
  /** Thời gian trung bình / trial (ms). */
  meanDurationMs: number;
  /** Số bước trung bình / trial. */
  meanSteps: number;
  /** Chi phí trung bình / trial (USD). */
  meanCostUsd: number;
  /** Số trial bị guardrail trip / tổng số trial. */
  guardrailTrips: number;
}

/** Kết quả chạy một suite (nhiều task). */
export interface EvalHarnessV3SuiteResult {
  /** Id suite, vd `v3-sample`. */
  suiteId: string;
  /** Id chạy ổn định: `eval-harness-v3-<uuid>`. */
  runId: string;
  /** Nhãn agent/executor đã chạy (vd `scripted`, `noop`). */
  agentLabel: string;
  startedAt: number;
  finishedAt: number;
  durationMs: number;
  tasks: EvalHarnessV3TaskResult[];
  /** Tỉ lệ task có passRate = 1 (task nào trial nào cũng pass mới tính). */
  taskPassRate: number;
  /** Tỉ lệ trial pass trên toàn suite. */
  trialPassRate: number;
  /** Điểm trung bình toàn suite (0..1). */
  meanScore: number;
  /** Điểm flake-adjusted trung bình toàn suite (0..1). */
  meanFlakeAdjustedScore: number;
  /** Khoảng tin cậy Wilson 95% cho trialPassRate (xem scorer.ts). */
  trialPassRateCi95: { lower: number; upper: number };
  /** Tổng chi phí ước tính toàn suite (USD). */
  totalCostUsd: number;
  /** Tổng thời gian chạy trial (ms, cộng dồn — khác durationMs khi chạy song song). */
  totalTrialMs: number;
  /** Tổng số trial bị guardrail trip trong suite. */
  guardrailTripCount: number;
}

/** Một suite: danh sách task + metadata. */
export interface EvalHarnessV3Suite {
  id: string;
  name: string;
  description: string;
  tasks: EvalHarnessV3Task[];
}

/** Lỗi validation — kèm trường lỗi để UI/tool/CLI báo rõ. */
export interface EvalHarnessV3ValidationIssue {
  field: string;
  message: string;
}

/** Kết quả validate: `valid` true khi không còn lỗi nào. */
export interface EvalHarnessV3ValidationResult {
  valid: boolean;
  issues: EvalHarnessV3ValidationIssue[];
  /** Cảnh báo (không chặn load, vd test không có trọng số → dùng 1). */
  warnings: EvalHarnessV3ValidationIssue[];
}

// ---------------------------------------------------------------------------
// Guardrail types (chi tiết chạy ở guardrails.ts)
// ---------------------------------------------------------------------------

/** Giai đoạn guardrail chạy. */
export type EvalHarnessV3GuardrailStage = 'input' | 'output' | 'tool';

/** Một guardrail trip: guardrail nào, ở giai đoạn nào, vì sao. */
export interface EvalHarnessV3GuardrailTrip {
  /** Id guardrail đã trip, vd `input-prompt-injection`. */
  guardrailId: string;
  /** Giai đoạn: input / output / tool. */
  stage: EvalHarnessV3GuardrailStage;
  /** Lý do ngắn, hiển thị được (không chứa nội dung nhạy cảm). */
  reason: string;
  /** Mức độ: `block` (dừng trial) hay `warn` (ghi log, vẫn chạy tiếp). */
  severity: 'block' | 'warn';
  /** Thời điểm trip (epoch ms). */
  trippedAt: number;
  /** Chi tiết phụ để debug (mẫu nào khớp, tool nào, ...). */
  detail?: string;
}

/** Kết quả chạy một guardrail đơn. */
export interface EvalHarnessV3GuardrailResult {
  guardrailId: string;
  stage: EvalHarnessV3GuardrailStage;
  /** true = trip (vi phạm), false = qua. */
  tripped: boolean;
  severity: 'block' | 'warn';
  reason: string;
  detail?: string;
}

/** Kết quả chạy một bộ guardrail (một giai đoạn hoặc cả bộ). */
export interface EvalHarnessV3GuardrailCheck {
  stage: EvalHarnessV3GuardrailStage | 'all';
  /** Có trip block nào không — true thì caller phải dừng run. */
  blocked: boolean;
  trips: EvalHarnessV3GuardrailTrip[];
  /** Số guardrail đã chạy. */
  checked: number;
  /** Thời gian chạy bộ guardrail (ms). */
  durationMs: number;
}

// ---------------------------------------------------------------------------
// Tracing types (chi tiết chạy ở tracing.ts)
// ---------------------------------------------------------------------------

/** Loại span trong trace quyết định. */
export type EvalHarnessV3SpanKind =
  | 'trial'
  | 'materialize'
  | 'base-test'
  | 'guardrail'
  | 'executor'
  | 'agent-command'
  | 'test'
  | 'score'
  | 'gate';

/** Một span: một bước trong quá trình đánh giá. */
export interface EvalHarnessV3TraceSpan {
  /** Id span ổn định trong trace. */
  spanId: string;
  /** Id span cha (undefined = span gốc của trial). */
  parentSpanId?: string;
  kind: EvalHarnessV3SpanKind;
  /** Nhãn đọc được, vd `test:add-returns-sum`. */
  name: string;
  startedAt: number;
  /** Thời gian chạy (ms). */
  durationMs: number;
  /** Kết quả bước: pass/fail/trip/error/timeout/cancelled. */
  status: 'pass' | 'fail' | 'trip' | 'error' | 'timeout' | 'cancelled' | 'info';
  /** Thuộc tính phụ (đã redact secret — xem tracing.ts). */
  attributes?: Record<string, string | number | boolean>;
  /** Ghi chú ngắn khi fail/trip. */
  note?: string;
}

/** Trace quyết định của một trial: toàn bộ span theo thứ tự. */
export interface EvalHarnessV3Trace {
  /** Id trace: `<trialId>-<uuid ngắn>`. */
  traceId: string;
  trialId: string;
  taskId: string;
  trialIndex: number;
  startedAt: number;
  finishedAt: number;
  /** Kết quả cuối của trial. */
  outcome: EvalHarnessV3TrialStatus;
  spans: EvalHarnessV3TraceSpan[];
}

// ---------------------------------------------------------------------------
// Registry types (chi tiết chạy ở registry.ts)
// ---------------------------------------------------------------------------

/** Một eval set: nhóm task có tên, version, mô tả. */
export interface EvalHarnessV3EvalSet {
  /** Id set, vd `v3-core`. */
  id: string;
  /** Tên hiển thị. */
  name: string;
  /** Mô tả một dòng. */
  description: string;
  /** Version của set (tăng khi đổi danh sách task). */
  version: number;
  /** Id các task trong set (theo thứ tự chạy). */
  taskIds: string[];
  /** Tag của set (vd `smoke`, `nightly`). */
  tags?: string[];
  /** Thời điểm tạo set (epoch ms). */
  createdAt: number;
  /** Thời điểm sửa set lần cuối (epoch ms). */
  updatedAt: number;
}

/** Mục đăng ký một task trong registry (task + set chứa nó). */
export interface EvalHarnessV3RegistryEntry {
  task: EvalHarnessV3Task;
  /** Id các set chứa task này. */
  setIds: string[];
  /** Thời điểm đăng ký (epoch ms). */
  registeredAt: number;
}

// ---------------------------------------------------------------------------
// Hằng + helper dùng chung
// ---------------------------------------------------------------------------

/** Mẫu phá hoại bị cấm trong lệnh test/oracle (chạy trong sandbox nhưng vẫn chặn sớm). */
export const EVAL_HARNESS_V3_FORBIDDEN_COMMAND_PATTERNS: readonly {
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
  { pattern: /\bshutdown\b|\breboot\b/, reason: 'tắt/khởi động lại máy' },
  { pattern: /:\(\)\s*\{\s*:\|:/, reason: 'fork bomb' },
];

/** Mẫu đường dẫn thoát khỏi workdir/task — bị chặn khi load. */
export function isUnsafeEvalHarnessV3RelativePath(p: string): boolean {
  if (typeof p !== 'string' || p.length === 0) return true;
  if (p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p)) return true;
  const parts = p.split(/[\\/]+/);
  return parts.includes('..') || (parts.includes('') && p !== '');
}

/** Chuẩn hoá group của test theo loại task (dùng khi group bỏ trống). */
export function defaultEvalHarnessV3TestGroup(
  kind: EvalHarnessV3TaskKind,
): 'fail-to-pass' | 'pass-to-pass' | 'state-check' {
  return kind === 'issue-patch' ? 'fail-to-pass' : 'state-check';
}

/** Tên image đầy đủ của container spec (image:tag hoặc image@digest). */
export function containerImageRef(spec: EvalHarnessV3ContainerSpec): string {
  const normalized = normalizeContainerSpec(spec);
  if (normalized.digest !== undefined && normalized.digest !== '') {
    return `${normalized.image}@${normalized.digest}`;
  }
  return `${normalized.image}:${normalized.tag ?? 'latest'}`;
}

/** Kiểm tra một chuỗi có phải digest sha256 hợp lệ không (`sha256:<64 hex>`). */
export function isValidContainerDigest(digest: string): boolean {
  return /^sha256:[0-9a-f]{64}$/.test(digest);
}

/** Kiểm tra chuỗi memory limit hợp lệ không (`512m`, `2g`, `1024k`, số byte). */
export function isValidMemoryLimit(value: string): boolean {
  return /^\d+([kmg])?$/i.test(value.trim());
}

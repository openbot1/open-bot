/**
 * Eval Harness v4 — Harbor-native eval harness (v1.44, Đội T2).
 *
 * V4 thống nhất các thế hệ eval trước của repo thành MỘT harness
 * Harbor-native, chạy local-first, theo đúng 5 yêu cầu của sóng v1.44:
 *
 *   1. Định dạng task Harbor: `instruction.md` + `environment/` +
 *      `tests/test.sh`, điểm test.sh là reward (xem `eval/harborTask.ts`,
 *      v1.11 — V4 tái dùng định dạng đó, không định nghĩa lại).
 *   2. Mỗi task chạy trong sandbox riêng (BotBoxManager qua
 *      `HarborRunner` — bwrap/unshare khi có, chạy thường + báo rõ
 *      khi không có cách ly; KHÔNG cloud, KHÔNG Docker bắt buộc).
 *   3. Chạy bộ task, chấm theo reward, lưu lịch sử từng lần chạy
 *      (xem `history.ts`) để so sánh theo thời gian.
 *   4. Báo cáo eval + dashboard hồi quy: task nào thụt lùi so với
 *      lần chạy trước/baseline, xu hướng điểm, bảng tổng hợp
 *      (xem `regression.ts`, `dashboard.ts`).
 *   5. CLI/lệnh chạy eval + cấu hình chọn tập task, timeout, số lần
 *      lặp (xem `config.ts`, `cli.ts`).
 *
 * V4 KHÔNG thay thế evalHarnessV3 (container spec + guardrails +
 * tracing vẫn sống riêng): V4 là lớp điều phối Harbor — chọn tập
 * task, chạy lặp, lưu sử, phát hiện hồi quy, vẽ dashboard. Một task
 * V4 chính là một HarborTask; V4 không copy định dạng task của bất
 * kỳ repo nào khác, chỉ dùng định dạng Harbor đã có trong repo.
 *
 * File này chỉ chứa kiểu dữ liệu + hằng số + hàm thuần (không I/O).
 * Mọi hàm ở đây đều không chạm đĩa, không chạy process, không gọi
 * model — nên test được mà không cần sandbox.
 */

/** Định dạng + phiên bản của harness này. */
export const EVAL_HARNESS_V4_FORMAT = 'eval-harness-v4' as const;
export const EVAL_HARNESS_V4_VERSION = 4 as const;

/** Thư mục dữ liệu mặc định của V4 trong `<dataDir>`. */
export const EVAL_HARNESS_V4_DATA_DIR = 'eval-harness-v4' as const;
/** File lịch sử chạy (JSONL, một dòng = một run record). */
export const EVAL_HARNESS_V4_HISTORY_FILE = 'runs.jsonl' as const;
/** File baseline đã pin (JSON `{ runId, pinnedAt, note }`). */
export const EVAL_HARNESS_V4_BASELINE_FILE = 'baseline.json' as const;
/** Thư mục chứa dashboard đã render. */
export const EVAL_HARNESS_V4_DASHBOARD_DIR = 'dashboards' as const;
/** Thư mục chứa run record từng lần chạy (một file JSON / run). */
export const EVAL_HARNESS_V4_RUNS_DIR = 'runs' as const;

/** Chế độ sandbox cho mỗi task (ghi lại trung thực, không giả vờ). */
export type EvalHarnessV4SandboxMode = 'auto' | 'bwrap' | 'plain';

/** Nguồn task trong một task set đã resolve. */
export type EvalHarnessV4TaskSource = 'builtin' | 'builtin-v4' | 'directory';

/** Cách chọn tập task: lọc theo id / tag / kind / glob, rồi loại trừ. */
export interface EvalHarnessV4TaskSelection {
  /** Chỉ chạy các id này (rỗng = không lọc theo id). */
  includeIds: string[];
  /** Bỏ các id này (áp dụng sau includeIds). */
  excludeIds: string[];
  /** Chỉ chạy task có ÍT NHẤT một tag này (rỗng = không lọc theo tag). */
  tags: string[];
  /** Chỉ chạy task thuộc các kind này (rỗng = không lọc theo kind). */
  kinds: string[];
  /** Glob đơn giản (`*`, `?`) khớp id — vd `fix-*`, `*-csv`. */
  includeGlobs: string[];
  /** Glob loại trừ khớp id — áp dụng sau includeGlobs. */
  excludeGlobs: string[];
}

/** Ngưỡng hồi quy + gate của một lần chạy. */
export interface EvalHarnessV4Thresholds {
  /**
   * Reward tối thiểu của một task để coi là pass từng task
   * (mặc định 1 — task chỉ pass khi mọi test pass; nới ra khi
   * task có test nặng ký không bắt buộc).
   */
  minReward: number;
  /**
   * Mức sụt reward tối đa cho phép so với baseline/lần trước
   * (mặc định 0.05): sụt hơn mức này = hồi quy `blocker`.
   */
  maxRegressionDrop: number;
  /** Pass rate tối thiểu của cả suite (mặc định 0.8). */
  minPassRate: number;
  /** Reward trung bình tối thiểu của cả suite (mặc định 0.8). */
  minMeanReward: number;
  /**
   * Số lần fail liên tiếp của một task để coi là `always-failing`
   * (mặc định 3 — dùng cho dashboard, không chặn gate).
   */
  alwaysFailingRuns: number;
}

/** Cấu hình lịch sử chạy. */
export interface EvalHarnessV4HistoryConfig {
  /** Thư mục lưu lịch sử (mặc định `<dataDir>/eval-harness-v4`). */
  dir: string;
  /** Giữ tối đa bao nhiêu run record (mặc định 100; 0 = không giới hạn). */
  maxRuns: number;
  /** Xoá run cũ hơn bao nhiêu ngày (mặc định 90; 0 = không xoá theo tuổi). */
  maxAgeDays: number;
}

/** Cấu hình output (dashboard + report). */
export interface EvalHarnessV4OutputConfig {
  /** Thư mục ghi dashboard/report (mặc định `<dataDir>/eval-harness-v4`). */
  dir: string;
  /** Định dạng dashboard muốn render: `markdown`, `html`, `json`. */
  formats: Array<'markdown' | 'html' | 'json'>;
}

/** Cấu hình đầy đủ của Eval Harness v4 (nội dung `eval.config.json`). */
export interface EvalHarnessV4Config {
  /** Phiên bản format config (luôn 4). */
  version: 4;
  /** Tên gợi nhớ của bộ config (vd `nightly`, `smoke`). */
  name: string;
  /** Thư mục chứa task Harbor trên đĩa (mỗi thư mục con = 1 task). */
  taskDirs: string[];
  /** Có nạp task mẫu v1.11 (`hello-file`, `sum-csv`, ...) không. */
  includeBuiltin: boolean;
  /** Có nạp task mẫu V4 (`json-transform`, `sort-lines`, ...) không. */
  includeBuiltinV4: boolean;
  /** Bộ lọc chọn tập task. */
  selection: EvalHarnessV4TaskSelection;
  /** Số lần lặp mỗi task (mặc định 1; >1 để đo flake). */
  repeats: number;
  /** Timeout toàn task (agent + test), ms — ghi đè task.meta.timeoutMs. */
  taskTimeoutMs: number | null;
  /** Timeout chạy tests/test.sh, ms (mặc định 60_000). */
  testTimeoutMs: number;
  /** Profile agent mặc định khi chạy (rỗng = không ép profile). */
  profileId: string;
  /** Model mặc định (vd `{ provider: 'ollama', model: 'llama3' }`). */
  model: { provider: string; model: string } | null;
  /** Chế độ sandbox + giữ workspace sau khi chạy hay không. */
  sandbox: { mode: EvalHarnessV4SandboxMode; keepWorkspace: boolean };
  /** Ngưỡng hồi quy + gate. */
  thresholds: EvalHarnessV4Thresholds;
  /** Cấu hình lịch sử. */
  history: EvalHarnessV4HistoryConfig;
  /** Cấu hình output. */
  output: EvalHarnessV4OutputConfig;
  /** Run id đã pin làm baseline (rỗng = so với lần chạy trước đó). */
  baselineRunId: string;
  /** Có chặn (exit != 0) khi gate = block không (mặc định true). */
  failOnRegression: boolean;
}

/** Một test đơn lẻ trong một lần chạy (đã chấm). */
export interface EvalHarnessV4TestResult {
  name: string;
  weight: number;
  passed: boolean;
}

/** Một lần chạy (attempt) của một task — đúng 1 lần vào sandbox. */
export interface EvalHarnessV4Attempt {
  /** Số thứ tự attempt trong task (bắt đầu từ 1). */
  attempt: number;
  /** Rollout id của HarborRunner (để đối chiếu rollouts.jsonl). */
  rolloutId: string;
  startedAt: number;
  finishedAt: number;
  durationMs: number;
  passed: boolean;
  /** Reward = trọng số test pass / tổng trọng số (0..1). */
  reward: number;
  /** Kết quả từng test của test.sh. */
  perTest: EvalHarnessV4TestResult[];
  /** Cách ly sandbox thật sự đạt được (`bwrap`, `unshare`, `none`, ...). */
  isolation: string;
  /** Exit code của test.sh (null khi chưa chạy tới test). */
  testExitCode: number | null;
  /** True khi test.sh hoặc agent vượt timeout. */
  timedOut: boolean;
  /** Lỗi setup/executor (null khi chạy tới được bước chấm). */
  error: string | null;
  promptTokens: number;
  completionTokens: number;
}

/** Kết quả gom của một task sau N lần lặp. */
export interface EvalHarnessV4TaskResult {
  taskId: string;
  taskVersion: number;
  taskName: string;
  taskKind: string;
  source: EvalHarnessV4TaskSource;
  /** Mọi attempt (theo thứ tự chạy). */
  attempts: EvalHarnessV4Attempt[];
  /** Số attempt pass / tổng attempt. */
  passes: number;
  /** True khi ÍT NHẤT một attempt pass (pass@repeats). */
  passed: boolean;
  /** True khi MỌI attempt đều pass. */
  allPassed: boolean;
  /** True khi có cả pass lẫn fail qua các attempt (flake). */
  flaky: boolean;
  meanReward: number;
  bestReward: number;
  worstReward: number;
  meanDurationMs: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  /** Test fail ở ÍT NHẤT một attempt (để báo cáo hồi quy). */
  failingTests: string[];
  /**
   * Số vòng retry hạ tầng đã dùng (0 khi không retry). Retry chỉ
   * chạy khi MỌI attempt đều lỗi hạ tầng (executor/timeout) —
   * test fail thì KHÔNG retry (fail test là kết quả thật).
   */
  retriesUsed: number;
}

/** Một run record đầy đủ — đơn vị lưu trong lịch sử V4. */
export interface EvalHarnessV4RunRecord {
  /** Định dạng (luôn `eval-harness-v4`). */
  format: typeof EVAL_HARNESS_V4_FORMAT;
  /** Id ổn định: `v4-<ISO>-<random6>`. */
  runId: string;
  /** Tên config đã chạy (vd `nightly`). */
  configName: string;
  startedAt: number;
  finishedAt: number;
  durationMs: number;
  /** Snapshot config lúc chạy (để lần sau tái tạo đúng tập task). */
  configSnapshot: EvalHarnessV4Config;
  /** Kết quả từng task (theo thứ tự task set). */
  tasks: EvalHarnessV4TaskResult[];
  /** Task nào bị skip khi resolve task set (kèm lý do). */
  skipped: { id: string; reason: string }[];
  /** Tổng hợp suite. */
  passed: number;
  failed: number;
  total: number;
  passRate: number;
  meanReward: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  /** Số task flaky trong run này. */
  flakyTasks: number;
  /** Chế độ sandbox thật sự dùng trong run (bwrap/plain/...). */
  isolationModes: string[];
  /** Ghi chú tự do (vd lý do chạy tay). */
  note: string;
}

/** Điểm so sánh của một task giữa 2 run. */
export interface EvalHarnessV4TaskDelta {
  taskId: string;
  baselineReward: number | null;
  currentReward: number | null;
  /** current - baseline (null khi thiếu một đầu). */
  delta: number | null;
  baselinePassed: boolean | null;
  currentPassed: boolean | null;
  /** Test mới fail so với baseline. */
  newlyFailingTests: string[];
  /** Test mới pass so với baseline. */
  newlyPassingTests: string[];
  /** Task có trong cả 2 run không. */
  inBaseline: boolean;
  inCurrent: boolean;
}

/** So sánh 2 run (current vs baseline/lần trước). */
export interface EvalHarnessV4RunComparison {
  currentRunId: string;
  baselineRunId: string;
  comparedAt: number;
  deltas: EvalHarnessV4TaskDelta[];
  meanRewardDelta: number | null;
  passRateDelta: number | null;
  /** Task mới xuất hiện trong current (chưa có ở baseline). */
  addedTasks: string[];
  /** Task biến mất khỏi current (có ở baseline, không còn chạy). */
  removedTasks: string[];
}

/** Loại hồi quy phát hiện được. */
export type EvalHarnessV4RegressionKind =
  | 'reward-drop'
  | 'new-failure'
  | 'newly-flaky'
  | 'timeout'
  | 'error'
  | 'suite-drop';

/** Mức nghiêm trọng của một hồi quy. */
export type EvalHarnessV4RegressionSeverity = 'blocker' | 'major' | 'minor' | 'info';

/** Một hồi quy (hoặc cải thiện) của một task. */
export interface EvalHarnessV4Regression {
  taskId: string;
  kind: EvalHarnessV4RegressionKind;
  severity: EvalHarnessV4RegressionSeverity;
  /** Reward baseline (null khi task mới). */
  previousReward: number | null;
  /** Reward lần này (null khi task không còn chạy / lỗi setup). */
  currentReward: number | null;
  /** current - previous (null khi thiếu một đầu). */
  delta: number | null;
  previousPassed: boolean | null;
  currentPassed: boolean | null;
  /** Test mới fail (cho kind `new-failure`). */
  newlyFailingTests: string[];
  /** Mô tả ngắn, đọc được (hiện trong dashboard/CLI). */
  detail: string;
  /** Run id đầu tiên thấy hồi quy này (để truy vết). */
  firstSeenRunId: string;
}

/** Cải thiện (ngược với hồi quy) — task tốt lên so với baseline. */
export interface EvalHarnessV4Improvement {
  taskId: string;
  previousReward: number | null;
  currentReward: number | null;
  delta: number | null;
  newlyPassingTests: string[];
  detail: string;
}

/** Kết luận gate của một lần so sánh hồi quy. */
export type EvalHarnessV4GateVerdict = 'pass' | 'warn' | 'block';

/** Báo cáo hồi quy đầy đủ của một lần chạy so với baseline. */
export interface EvalHarnessV4RegressionReport {
  currentRunId: string;
  baselineRunId: string;
  comparedAt: number;
  regressions: EvalHarnessV4Regression[];
  improvements: EvalHarnessV4Improvement[];
  /** Số hồi quy theo mức. */
  bySeverity: Record<EvalHarnessV4RegressionSeverity, number>;
  gate: EvalHarnessV4GateVerdict;
  /** Lý do gate (1 dòng, vd `2 blocker: task X sụt reward 0.40`). */
  gateReason: string;
  comparison: EvalHarnessV4RunComparison;
}

/** Hướng xu thế của một task/suite qua các lần chạy. */
export type EvalHarnessV4TrendDirection = 'improving' | 'stable' | 'worsening';

/** Một điểm trên đường xu thế của một task. */
export interface EvalHarnessV4TrendPoint {
  runId: string;
  at: number;
  reward: number;
  passed: boolean;
}

/** Xu thế của một task qua lịch sử. */
export interface EvalHarnessV4TaskTrend {
  taskId: string;
  taskName: string;
  points: EvalHarnessV4TrendPoint[];
  runs: number;
  meanReward: number;
  lastReward: number | null;
  firstReward: number | null;
  /** Độ dốc hồi quy tuyến tính (reward / run). */
  slope: number;
  direction: EvalHarnessV4TrendDirection;
  /** Pass rate qua toàn bộ điểm. */
  passRate: number;
  /** True khi task lúc pass lúc fail trong lịch sử (flake dài hạn). */
  flaky: boolean;
  /** Số run gần nhất fail liên tiếp (0 khi lần gần nhất pass). */
  consecutiveFailures: number;
  /** True khi fail liên tiếp >= ngưỡng alwaysFailingRuns. */
  alwaysFailing: boolean;
}

/** Xu thế của cả suite qua lịch sử. */
export interface EvalHarnessV4SuiteTrend {
  runs: number;
  points: { runId: string; at: number; passRate: number; meanReward: number }[];
  meanPassRate: number | null;
  latestPassRate: number | null;
  meanReward: number | null;
  latestMeanReward: number | null;
  direction: EvalHarnessV4TrendDirection;
}

/** Xu thế của một test đơn lẻ (trong một task) qua lịch sử. */
export interface EvalHarnessV4TestTrend {
  taskId: string;
  testName: string;
  points: { runId: string; at: number; passed: boolean }[];
  runs: number;
  passRate: number;
  /** True khi test lúc pass lúc fail trong lịch sử. */
  flaky: boolean;
  direction: EvalHarnessV4TrendDirection;
}

/** Dashboard hồi quy — dữ liệu đã tính sẵn để render. */
export interface EvalHarnessV4Dashboard {
  generatedAt: number;
  /** Run mới nhất trong lịch sử (null khi chưa có run nào). */
  latestRunId: string | null;
  /** Baseline đang pin (null khi chưa pin). */
  baselineRunId: string | null;
  runs: number;
  /** Khoảng thời gian lịch sử bao phủ (null khi chưa có run). */
  range: { from: number; to: number } | null;
  suite: EvalHarnessV4SuiteTrend;
  tasks: EvalHarnessV4TaskTrend[];
  /** Xu thế từng test (flaky nhất trước) — để pinpoint test không ổn định. */
  testTrends: EvalHarnessV4TestTrend[];
  /** Hồi quy của lần chạy mới nhất so với baseline/lần trước. */
  latestRegressions: EvalHarnessV4Regression[];
  /** Cải thiện của lần chạy mới nhất. */
  latestImprovements: EvalHarnessV4Improvement[];
  gate: EvalHarnessV4GateVerdict;
  gateReason: string;
  /** Task flaky (lúc pass lúc fail) — cần xem lại test. */
  flakyTasks: string[];
  /** Task fail liên tục — hỏng thật, cần sửa ngay. */
  alwaysFailingTasks: string[];
  /** Task đang xấu đi (direction = worsening). */
  worseningTasks: string[];
  /** Task đang tốt lên. */
  improvingTasks: string[];
}

/** Baseline đã pin (nội dung `baseline.json`). */
export interface EvalHarnessV4Baseline {
  runId: string;
  pinnedAt: number;
  note: string;
}

/** Lỗi validation của config / task set (field + message). */
export interface EvalHarnessV4Issue {
  field: string;
  message: string;
}

/** Kết quả validate (dùng chung cho config + task set). */
export interface EvalHarnessV4ValidationResult {
  valid: boolean;
  issues: EvalHarnessV4Issue[];
}

/** Một task trong task set đã resolve (kèm nguồn + lý do chọn). */
export interface EvalHarnessV4ResolvedTask {
  taskId: string;
  source: EvalHarnessV4TaskSource;
  /** Thư mục task trên đĩa (undefined với task builtin trong RAM). */
  dir?: string;
}

/** Kết quả resolve task set. */
export interface EvalHarnessV4TaskSet {
  /** Task đã chọn (theo thứ tự: builtin, builtin-v4, directory, sort theo id). */
  tasks: EvalHarnessV4ResolvedTask[];
  /** Task/dir bị skip khi load (kèm lý do — không im lặng mất task). */
  skipped: { id: string; reason: string }[];
  /** Số task trước khi lọc selection. */
  totalAvailable: number;
  /** Bộ lọc đã áp dụng (để hiển thị lại trong report). */
  appliedSelection: EvalHarnessV4TaskSelection;
}

/** Tóm tắt lịch sử (đếm nhanh, không load toàn bộ record). */
export interface EvalHarnessV4HistorySummary {
  runs: number;
  range: { from: number; to: number } | null;
  latestRunId: string | null;
  baselineRunId: string | null;
  taskIds: string[];
}

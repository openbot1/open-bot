/**
 * Coding agent v12 (v1.20, Đội T3) — shared types.
 *
 * Học ý tưởng (chỉ học ý tưởng, không copy code/text/tài sản của bất
 * kỳ repo nào, của xAI/Cursor):
 * - OpenHands Large Codebase SDK: edit lớn được chia theo dependency
 *   graph, file lá trước — file gốc sau, nhiều agent con chạy song
 *   song theo thứ tự đó, coordinator theo dõi từng edit.
 * - OpenHands sub-agent task visualizer: cây task live trong chat UI.
 * - Aider v2 (git-first): mỗi edit là một commit riêng, hỗ trợ cả
 *   diff format lẫn patch format, rollback từng edit.
 * - ACP model switching: đổi model giữa chừng vẫn giữ context.
 * - Conversation budget meters + eval v3 đo chất lượng edit.
 *
 * v12 NỐI v11 (không viết lại): dùng lại call graph v11 để bổ sung
 * xếp hạng khi build dependency graph, dùng gitAtomic v9 cho commit,
 * dùng eval v11 làm baseline so sánh cho eval v3, dùng pricing của
 * `usage/pricing` để ước lượng cost cho budget meters. v12 thêm 6
 * lớp mới (mỗi lớp một file):
 *
 *   1. `dependencyGraph.ts`: parse import TS/JS → dependency graph,
 *      sắp xếp topological (lá trước, gốc sau), phát hiện chu trình,
 *      chia task edit lớn thành các edit nhỏ có thứ tự, coordinator
 *      nội bộ theo dõi tiến độ từng edit.
 *   2. `visualizerV12.ts`: cây sub-agent v2 — event stream realtime
 *      (subscribe/unsubscribe), node ghi file đang sửa + token +
 *      cost, diff snapshot cho UI chỉ render phần đổi.
 *   3. `budgetMeters.ts`: meter token/cost/time/steps của một
 *      conversation, cảnh báo ngưỡng 50/80/100%, tự động tóm tắt
 *      (compaction) khi gần hết budget.
 *   4. `acpModelSwitch.ts`: chuyển model GIỮA CHỪNG trong ACP
 *      session (v4 chỉ cho đổi giữa các run): giữ nguyên context,
 *      re-announce capabilities (diff cũ → mới), rollback.
 *   5. `editStrategyV12.ts`: edit strategy diff/patch kiểu Aider v2
 *      — mỗi edit là một commit git riêng (atomic), hỗ trợ cả unified
 *      diff format và patch format (search/replace block), rollback
 *      từng edit, verify build/test sau mỗi edit.
 *   6. `evalV12.ts`: eval v3 — chấm chất lượng edit theo 4 chiều
 *      (đúng file, test pass, không regression, diff gọn), chạy
 *      local trên repo tạm git thật, báo cáo điểm 0..100.
 *   7. `agent.ts`: pipeline nối 6 lớp trên + agent v11.
 */

/** Lỗi riêng của coding agent v12. */
export class CodingV12Error extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'CodingV12Error';
    this.code = code;
  }
}

/** Mã lỗi dùng chung cho v12. */
export const V12_ERROR_CODES = [
  'depgraph-not-built',
  'depgraph-cycle',
  'depgraph-file-not-found',
  'depgraph-edit-invalid',
  'visualizer-node-not-found',
  'visualizer-parent-not-found',
  'budget-invalid',
  'budget-exceeded',
  'budget-summary-failed',
  'acp-model-invalid',
  'acp-model-unknown',
  'acp-switch-in-flight',
  'acp-no-switch-to-rollback',
  'edit-invalid',
  'edit-apply-failed',
  'edit-verify-failed',
  'edit-rollback-failed',
  'edit-not-found',
  'eval-task-invalid',
  'eval-version-invalid',
  'agent-plan-invalid',
] as const;
export type V12ErrorCode = (typeof V12_ERROR_CODES)[number];

/* ================================================================== */
/* 1. Dependency graph — Large Codebase SDK                             */
/* ================================================================== */

/** Một file trong dependency graph. */
export interface V12DepFile {
  /** Path repo-relative, dùng `/` (vd `src/a.ts`). */
  path: string;
  /** File này import (phụ thuộc vào) các file này. */
  imports: string[];
  /** Các file import file này (đảo ngược của imports). */
  importedBy: string[];
  /** Độ sâu dependency: 0 = lá (không import file nội bộ nào). */
  depth: number;
  /** Số file (trực tiếp + gián tiếp) phụ thuộc vào file này. */
  dependentsCount: number;
}

/** Thống kê của dependency graph. */
export interface V12DepGraphStats {
  files: number;
  edges: number;
  /** Số thành phần liên thông yếu (nhóm file không nối nhau). */
  components: number;
  /** Số chu trình (strongly connected component > 1 node, hoặc tự import). */
  cycles: number;
  /** Độ sâu lớn nhất. */
  maxDepth: number;
  /** Số file lá (depth 0). */
  leaves: number;
}

/** Toàn bộ dependency graph. */
export interface V12DepGraph {
  files: Map<string, V12DepFile>;
  stats: V12DepGraphStats;
  /** Thứ tự topological: lá trước, gốc sau (file sau chỉ import file trước nó). */
  order: string[];
  /** Các chu trình tìm được (mỗi chu trình là danh sách path, khép kín). */
  cycles: string[][];
}

/** Một edit nhỏ trong task edit lớn (đã sắp theo dependency). */
export interface V12OrderedEdit {
  /** Id edit (`e1`, `e2`, … theo thứ tự áp). */
  id: string;
  /** File cần sửa. */
  file: string;
  /** Mô tả ngắn việc cần làm với file này. */
  summary: string;
  /** Độ sâu dependency của file (lá = 0, áp trước). */
  depth: number;
  /** Các edit phải xong trước edit này (id của edit phụ thuộc). */
  dependsOn: string[];
  /** Các edit có thể chạy song song với edit này (cùng depth, không phụ thuộc nhau). */
  parallelGroup: number;
}

/** Trạng thái một edit trong coordinator nội bộ. */
export type V12EditStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped';

/** Bản ghi tiến độ một edit (coordinator theo dõi). */
export interface V12EditProgress {
  edit: V12OrderedEdit;
  status: V12EditStatus;
  /** Lỗi khi failed. */
  error?: string;
  startedAt?: string;
  finishedAt?: string;
  /** Số token agent con đã dùng cho edit này (nếu báo). */
  tokensUsed?: number;
}

/** Tóm tắt tiến độ toàn bộ task edit lớn. */
export interface V12EditPlanSummary {
  planId: string;
  title: string;
  totalEdits: number;
  done: number;
  failed: number;
  running: number;
  pending: number;
  skipped: number;
  /** Số nhóm song song (mỗi nhóm chạy được cùng lúc). */
  parallelGroups: number;
  overallProgress: number;
}

/* ================================================================== */
/* 2. Sub-agent task visualizer v2                                      */
/* ================================================================== */

/** Trạng thái node trong cây visualizer v2 (mở rộng v4: thêm `blocked`, `waiting`). */
export type V12TaskStatus = 'pending' | 'running' | 'done' | 'failed' | 'cancelled' | 'blocked' | 'waiting';

/** Một node task trong cây visualizer v2. */
export interface V12TaskNode {
  id: string;
  parentId: string | null;
  title: string;
  detail?: string;
  status: V12TaskStatus;
  /** Tiến độ 0-100. */
  progress: number;
  log: string[];
  logTruncated: number;
  /** Model đang chạy node này. */
  model?: string;
  /** Token đã dùng cho node này (cộng dồn cả con khi aggregate). */
  tokensUsed: number;
  /** Cost ước lượng USD (cộng dồn cả con khi aggregate). */
  costUsd: number | null;
  /** File node này đang sửa (hiện trong UI). */
  editingFile?: string;
  /** Các file node này đã sửa xong. */
  editedFiles: string[];
  error?: string;
  startedAt?: string;
  finishedAt?: string;
  children: V12TaskNode[];
}

/** Snapshot cây visualizer v2. */
export interface V12TaskTreeSnapshot {
  version: number;
  root: V12TaskNode;
  counts: Record<V12TaskStatus, number>;
  totalNodes: number;
  overallProgress: number;
  /** Tổng token toàn cây (cộng dồn, không đếm trùng con vào cha). */
  totalTokens: number;
  /** Tổng cost ước lượng toàn cây. */
  totalCostUsd: number | null;
  updatedAt: string;
}

/** Một event realtime phát ra khi cây đổi (UI subscribe để render lại). */
export interface V12VisualizerEvent {
  /** Loại thay đổi. */
  kind: 'node-added' | 'node-updated' | 'node-removed' | 'tree-reset';
  nodeId: string | null;
  /** Version snapshot sau thay đổi. */
  version: number;
  at: string;
}

/** Listener nhận event realtime của visualizer. */
export type V12VisualizerListener = (event: V12VisualizerEvent, snapshot: V12TaskTreeSnapshot) => void;

/* ================================================================== */
/* 3. Conversation budget meters                                        */
/* ================================================================== */

/** Loại budget mà meter theo dõi. */
export type V12BudgetKind = 'tokens' | 'cost' | 'time' | 'steps';

/** Ngưỡng cảnh báo đã vượt qua. */
export type V12BudgetWarningLevel = 'none' | 'warn50' | 'warn80' | 'critical100';

/** Cấu hình budget cho một conversation. */
export interface V12ConversationBudget {
  /** Tổng token tối đa (input + output). */
  maxTokens?: number;
  /** Cost ước lượng tối đa, USD. */
  maxCostUsd?: number;
  /** Thời gian tối đa, ms. */
  maxTimeMs?: number;
  /** Số bước (turn model) tối đa. */
  maxSteps?: number;
  /** Ngưỡng tự động tóm tắt (phần trăm token đã dùng, mặc định 80). */
  autoSummarizeAtPercent?: number;
  /** Số message gần nhất giữ nguyên khi tóm tắt (mặc định 6). */
  keepRecentMessages?: number;
}

/** Một message trong conversation (đủ để tóm tắt + đếm token). */
export interface V12BudgetMessage {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  /** Token đã dùng (nếu model báo; không có thì ước lượng chars/4). */
  inputTokens?: number;
  outputTokens?: number;
}

/** Mức sử dụng hiện tại của một meter. */
export interface V12MeterReading {
  kind: V12BudgetKind;
  used: number;
  limit: number | null;
  /** Phần trăm đã dùng (null khi không có limit). */
  percentUsed: number | null;
  remaining: number | null;
  warning: V12BudgetWarningLevel;
  exceeded: boolean;
}

/** Toàn bộ trạng thái budget của một conversation. */
export interface V12BudgetState {
  conversationId: string;
  modelId: string;
  meters: V12MeterReading[];
  /** Cảnh báo cao nhất trong các meter. */
  worstWarning: V12BudgetWarningLevel;
  /** true khi bất kỳ meter nào đã vượt limit. */
  anyExceeded: boolean;
  /** Số lần đã tự động tóm tắt. */
  summariesDone: number;
  /** Token ước lượng (khi model không báo). */
  tokensEstimated: boolean;
  updatedAt: string;
}

/** Kết quả một lần tự động tóm tắt (compaction). */
export interface V12BudgetSummaryResult {
  /** Message tóm tắt thay thế phần cũ (role system). */
  summaryMessage: V12BudgetMessage;
  /** Số message cũ đã gộp vào tóm tắt. */
  summarizedMessages: number;
  /** Số message gần nhất giữ nguyên. */
  keptMessages: number;
  /** Token ước lượng đã giải phóng (chars cũ / 4, gần đúng). */
  tokensFreedEstimate: number;
  at: string;
}

/* ================================================================== */
/* 4. ACP model switching (giữa chừng)                                  */
/* ================================================================== */

/** Capability của một model trong ACP session (để re-announce khi switch). */
export interface V12ModelCapability {
  /** Tên capability (vd `code-edit`, `tool-call`, `vision`, `long-context`). */
  name: string;
  /** Mô tả ngắn cho client. */
  description?: string;
  /** true = capability bật. */
  enabled: boolean;
}

/** Một model trong catalog ACP (id + capabilities + giới hạn context). */
export interface V12AcpModel {
  id: string;
  /** Tên hiển thị. */
  displayName?: string;
  /** Context window (token). */
  contextWindowTokens?: number;
  capabilities: V12ModelCapability[];
}

/** Một message trong transcript ACP (giữ nguyên khi switch model). */
export interface V12AcpMessage {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  /** Model đã trả lời message này (chỉ assistant). */
  modelId?: string;
  at: string;
}

/** Bản ghi một lần switch model giữa chừng. */
export interface V12AcpSwitchRecord {
  id: string;
  at: string;
  fromModelId: string;
  toModelId: string;
  reason: string;
  /** Số message transcript lúc switch (tất cả được giữ). */
  preservedMessages: number;
  /** Capability mới xuất hiện sau switch. */
  capabilitiesAdded: string[];
  /** Capability mất đi sau switch. */
  capabilitiesRemoved: string[];
  /** true khi bản ghi này là rollback. */
  rolledBack?: boolean;
}

/** Tóm tắt session ACP (để UI hiện model hiện tại + lịch sử). */
export interface V12AcpSessionSummary {
  sessionId: string;
  modelId: string;
  messages: number;
  transcriptChars: number;
  switches: number;
  modelsUsed: string[];
  /** Capabilities đang announce cho client. */
  capabilities: V12ModelCapability[];
  lastSwitchAt?: string;
  createdAt: string;
  updatedAt: string;
}

/* ================================================================== */
/* 5. Edit strategy diff/patch kiểu Aider v2 (git-first)                */
/* ================================================================== */

/** Định dạng edit mà strategy v12 hỗ trợ. */
export type V12EditFormat = 'diff' | 'patch';

/** Một edit v12: nội dung thay đổi cho một file. */
export interface V12Edit {
  /** Id edit (`v12e-<hex>`). */
  id: string;
  /** File đích (repo-relative). */
  file: string;
  format: V12EditFormat;
  /** Unified diff (format `diff`): áp bằng `git apply`. */
  diff?: string;
  /** Khối search/replace (format `patch`): cặp old → new. */
  blocks?: V12PatchBlock[];
  /** Tóm tắt dùng cho commit message. */
  summary: string;
}

/** Một khối search/replace trong patch format. */
export interface V12PatchBlock {
  /** Đoạn cũ phải khớp đúng 1 lần trong file. */
  oldText: string;
  /** Đoạn mới thay vào. */
  newText: string;
}

/** Kết quả áp một edit v12. */
export interface V12EditApplyResult {
  edit: V12Edit;
  ok: boolean;
  /** SHA commit riêng của edit này (khi commit=true và ok). */
  commitSha?: string;
  /** SHA commit cha (để rollback). */
  parentSha?: string;
  /** Số dòng thêm/xóa. */
  linesAdded: number;
  linesRemoved: number;
  /** Kết quả verify sau edit (khi có verify command). */
  verify?: V12VerifyResult;
  error?: string;
  durationMs: number;
}

/** Kết quả chạy lệnh verify (build/test) sau một edit. */
export interface V12VerifyResult {
  /** Lệnh argv đã chạy. */
  command: string[];
  exitCode: number | null;
  ok: boolean;
  /** Output giữ lại (cắt ngắn). */
  output: string;
  timedOut: boolean;
  durationMs: number;
}

/** Bản ghi lịch sử edit (để rollback từng edit + xem lại). */
export interface V12EditHistoryEntry {
  editId: string;
  file: string;
  format: V12EditFormat;
  summary: string;
  commitSha: string;
  parentSha: string;
  appliedAt: string;
  /** SHA rollback (revert commit) khi đã rollback, nếu có. */
  rolledBackAt?: string;
  rollbackSha?: string;
}

/* ================================================================== */
/* 6. Eval v3 cho coding agent                                          */
/* ================================================================== */

/** Loại test trong eval v3 (kế thừa v11 + thêm `lint`). */
export type V12EvalTestKind = 'fail-to-pass' | 'pass-to-pass' | 'lint';

/** Một test trong task eval v3. */
export interface V12EvalTest {
  name: string;
  command: string[];
  kind: V12EvalTestKind;
  /** Trọng số (mặc định 1). */
  weight?: number;
}

/** Một task eval v3: fixture + test + đáp án kỳ vọng. */
export interface V12EvalTask {
  id: string;
  title: string;
  /** File fixture ban đầu (repo-relative → nội dung). */
  files: Record<string, string>;
  tests: V12EvalTest[];
  /** File agent PHẢI sửa (để chấm đúng file); rỗng = không chấm chiều này. */
  expectedFiles: string[];
  /** File agent KHÔNG ĐƯỢC sửa (sửa là trừ điểm chiều đúng file). */
  forbiddenFiles?: string[];
}

/** Kết quả agent nộp cho một attempt eval v3. */
export interface V12EvalAgentAttempt {
  /** Unified diff agent nộp (áp bằng `git apply`). */
  patch: string;
  /** Số token agent tự báo (nếu có). */
  tokensUsed?: number;
}

/** Kết quả một test trong eval v3. */
export interface V12EvalTestResult {
  name: string;
  kind: V12EvalTestKind;
  weight: number;
  passed: boolean;
  exitCode: number | null;
  outputExcerpt: string;
}

/** Điểm 4 chiều của một task eval v3. */
export interface V12EvalScores {
  /** Đúng file: file sửa nằm trong expected, không chạm forbidden (0..1). */
  fileAccuracy: number;
  /** Test pass có trọng số (fail-to-pass + pass-to-pass + lint, 0..1). */
  testScore: number;
  /** Không regression: pass-to-pass vẫn pass (0..1). */
  noRegression: number;
  /** Diff gọn: phạt diff quá lớn so với cần thiết (0..1). */
  diffEconomy: number;
  /** Điểm tổng 0..100 (trọng số các chiều). */
  total: number;
  /** Xếp loại theo tổng điểm. */
  grade: 'excellent' | 'good' | 'fair' | 'poor';
}

/** Tóm tắt một task trong báo cáo eval v3. */
export interface V12EvalTaskSummary {
  taskId: string;
  title: string;
  passed: boolean;
  scores: V12EvalScores;
  attempts: number;
  /** File agent đã sửa. */
  filesChanged: string[];
  testsPassed: number;
  testsTotal: number;
  flaky: boolean;
  tokensUsed: number | null;
  durationMs: number;
}

/** Báo cáo đầy đủ một lần chạy eval v3. */
export interface V12EvalReport {
  runId: string;
  suiteName: string;
  agentVersion: string;
  at: string;
  tasks: V12EvalTaskSummary[];
  /** Tỉ lệ task pass. */
  passRate: number;
  /** Điểm trung bình 0..100. */
  meanScore: number;
  /** Điểm từng chiều, trung bình toàn suite. */
  meanDimensions: Omit<V12EvalScores, 'total' | 'grade'>;
  flakyTasks: string[];
  regressions: string[];
  improvements: string[];
  totalDurationMs: number;
}

/** So sánh 2 báo cáo eval v3 (phiên bản mới vs baseline). */
export interface V12EvalComparison {
  baselineVersion: string;
  currentVersion: string;
  baselineMeanScore: number;
  currentMeanScore: number;
  scoreDelta: number;
  baselinePassRate: number;
  currentPassRate: number;
  regressions: string[];
  improvements: string[];
  /** Task có điểm đổi rõ rệt (|delta| >= 10). */
  changedTasks: { taskId: string; baselineScore: number; currentScore: number }[];
}

/* ================================================================== */
/* 7. Agent v12 — pipeline                                              */
/* ================================================================== */

/** Một bước trong báo cáo agent v12. */
export interface V12AgentStep {
  name: string;
  status: 'ok' | 'failed' | 'skipped';
  detail: string;
  durationMs: number;
}

/** Báo cáo đầy đủ một lần chạy agent v12. */
export interface V12AgentReport {
  taskId: string;
  title: string;
  ok: boolean;
  /** Lỗi (khi fail). */
  error?: string;
  steps: V12AgentStep[];
  /** Thứ tự edit theo dependency (file lá trước). */
  editOrder: string[];
  /** Commit SHA từng edit đã áp (theo thứ tự). */
  editCommits: { editId: string; file: string; sha: string }[];
  /** Điểm eval v3 (khi chạy eval sau task). */
  evalScores?: V12EvalScores;
  /** Trạng thái budget lúc kết thúc. */
  budget?: V12BudgetState;
  /** Snapshot cây visualizer lúc kết thúc. */
  visualizer?: V12TaskTreeSnapshot;
  totalDurationMs: number;
}

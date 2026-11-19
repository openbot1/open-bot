/**
 * Coding agent v17 (v1.39, Đội T4) — shared types.
 *
 * Học ý tưởng (chỉ học ý tưởng, không copy code/text/tài sản của bất
 * kỳ repo nào, của xAI/Cursor), từ docs/repo-survey-v139.md §4
 * (OpenHands 1.x: Software Agent SDK, "mọi thứ là event", security
 * là vòng lặp, verification stack, Plan Mode, CodeAct):
 *
 * - Mọi bước (prompt, bash, file change, lỗi compiler) là event bất
 *   biến trong append-only trajectory log → deterministic replay +
 *   session recovery (trajectory.ts).
 * - Repo-map PageRank v+1: ranking tốt hơn v4 (PageRank + reference
 *   frequency + freshness), cập nhật tăng dần khi file đổi (repoMap.ts).
 * - Eval harness mở rộng: task container hoá (ở đây là box bwrap),
 *   oracle rõ ràng, test xác định, chấm patch trước khi trình
 *   (evalHarness.ts).
 * - Verification stack nhiều tầng: critic chấm trajectory/patch,
 *   review skill tự động trên mọi thay đổi, Plan Mode bắt buộc với
 *   task đa file (critic.ts, planMode.ts).
 * - Sandbox bwrap DÙNG THẬT (bài học audit OB-005: BotBoxManager
 *   bwrap đã có sẵn nhưng đường code bị kiểm toán không dùng):
 *   coding agent v17 chạy code qua BotBoxManager.runInBox với
 *   isolation 'bwrap', giới hạn CPU/RAM từng bot, chạy non-root,
 *   fallback ghi rõ khi bwrap không có (sandboxExec.ts).
 *
 * v17 nối (không viết lại): coding agent v16 (token budget, harness
 * cost, minimal harness, file window, edit linter, history trimmer,
 * benchmark) và repo map v4 (PageRank + reference frequency +
 * freshness + cache invalidation).
 */

/** Lỗi riêng của coding agent v17. */
export class CodingV17Error extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'CodingV17Error';
    this.code = code;
  }
}

/** Mã lỗi dùng chung cho v17. */
export const V17_ERROR_CODES = [
  'trajectory-invalid',
  'trajectory-corrupt',
  'trajectory-empty',
  'trajectory-seq-gap',
  'trajectory-hash-mismatch',
  'trajectory-not-found',
  'repomap-invalid',
  'repomap-empty',
  'repomap-file-not-found',
  'repomap-stale',
  'eval-invalid',
  'eval-no-tests',
  'eval-oracle-invalid',
  'eval-timeout',
  'eval-nondeterministic',
  'critic-invalid',
  'critic-no-trajectory',
  'critic-no-patch',
  'review-invalid',
  'review-blocked',
  'plan-invalid',
  'plan-not-approved',
  'plan-multi-file-required',
  'plan-step-invalid',
  'plan-deviation',
  'sandbox-invalid',
  'sandbox-unavailable',
  'sandbox-denied',
  'sandbox-timeout',
  'sandbox-not-root-check',
  'agent-invalid',
  'agent-step-invalid',
  'agent-blocked-by-verification',
] as const;

export type V17ErrorCode = (typeof V17_ERROR_CODES)[number];

/** Kind của một event trong trajectory log (OpenHands: mọi thứ là event). */
export const V17_TRAJECTORY_EVENT_KINDS = [
  'session_start',
  'prompt',
  'plan_created',
  'plan_refined',
  'plan_approved',
  'repomap_built',
  'repomap_updated',
  'bash',
  'bash_output',
  'file_read',
  'file_write',
  'file_edit',
  'file_delete',
  'compiler_error',
  'test_run',
  'test_result',
  'critic_score',
  'review_result',
  'eval_result',
  'confirmation_requested',
  'confirmation_granted',
  'confirmation_denied',
  'sandbox_run',
  'sandbox_fallback',
  'error',
  'recovery',
  'snapshot',
  'session_end',
] as const;

export type V17TrajectoryEventKind = (typeof V17_TRAJECTORY_EVENT_KINDS)[number];

/** Một event bất biến trong append-only trajectory log. */
export interface V17TrajectoryEvent {
  /** Số thứ tự trong log (0-based, liên tục, không khoảng trống). */
  seq: number;
  /** Id phiên coding sở hữu event. */
  sessionId: string;
  /** Kind của event. */
  kind: V17TrajectoryEventKind;
  /** Thời điểm ghi (ms epoch). */
  at: number;
  /** Payload tự do theo kind (phải JSON-serializable). */
  payload: Record<string, unknown>;
  /** Hash chuỗi: sha256(prevHash + canonical(event không hash)). */
  hash: string;
  /** Hash của event trước ('' cho event đầu tiên). */
  prevHash: string;
}

/** Trạng thái tái tạo được từ trajectory log bằng replay. */
export interface V17ReplayState {
  sessionId: string;
  /** Số event đã replay. */
  eventsReplayed: number;
  /** File đã ghi/sửa theo thứ tự replay (path -> nội dung cuối). */
  files: Record<string, string>;
  /** File đã xoá trong quá trình replay. */
  deletedFiles: string[];
  /** Lệnh bash đã chạy (theo thứ tự). */
  bashCommands: string[];
  /** Lỗi compiler gặp phải (theo thứ tự). */
  compilerErrors: string[];
  /** Kết quả test cuối cùng (nếu có). */
  lastTestResult?: V17TestResult;
  /** Plan hiện tại sau replay (nếu có). */
  plan?: V17Plan;
  /** Phiên đã kết thúc chưa (có session_end). */
  ended: boolean;
  /** Lý do kết thúc (nếu có). */
  endReason?: string;
}

/** Kết quả kiểm tra chuỗi hash của trajectory log. */
export interface V17TrajectoryVerification {
  ok: boolean;
  eventsChecked: number;
  /** Seq đầu tiên bị hỏng (undefined khi ok). */
  firstBadSeq?: number;
  /** Lý do hỏng (undefined khi ok). */
  reason?: string;
}

/** Kết quả recovery: cắt đuôi hỏng, giữ prefix hợp lệ. */
export interface V17TrajectoryRecovery {
  keptEvents: number;
  droppedEvents: number;
  /** Seq của event hỏng đầu tiên (undefined khi log nguyên vẹn). */
  firstBadSeq?: number;
  reason?: string;
  /** Trạng thái tái tạo từ prefix còn lại. */
  state: V17ReplayState;
}

/** Một node file trong repo-map graph. */
export interface V17RepoMapNode {
  /** Đường dẫn tương đối tới file (từ gốc repo). */
  path: string;
  /** Ký tự trong file (ước lượng token = chars/4). */
  chars: number;
  /** Thời điểm sửa lần cuối (ms epoch, 0 khi không biết). */
  mtimeMs: number;
  /** Số symbol định nghĩa trong file (hàm/class/export). */
  symbols: number;
}

/** Một cạnh có hướng file -> file (import / require / tham chiếu). */
export interface V17RepoMapEdge {
  from: string;
  to: string;
  /** Loại cạnh: import trực tiếp hay tham chiếu tên symbol. */
  kind: 'import' | 'reference';
  /** Trọng số cạnh (import = 1, reference = 0.5 mặc định). */
  weight: number;
}

/** Kết quả xếp hạng của một file trong repo map. */
export interface V17RepoMapRank {
  path: string;
  /** Điểm PageRank chuẩn hoá (tổng mọi file = 1). */
  pageRank: number;
  /** Điểm reference frequency chuẩn hoá (0..1). */
  referenceScore: number;
  /** Điểm freshness chuẩn hoá (0..1, 1 = mới sửa nhất). */
  freshnessScore: number;
  /** Điểm tổng hợp v17 (tổ hợp có trọng số 3 tín hiệu). */
  score: number;
}

/** Trọng số tổ hợp điểm repo-map v17. */
export interface V17RepoMapWeights {
  /** Trọng số PageRank (mặc định 0.5). */
  pageRank: number;
  /** Trọng số reference frequency (mặc định 0.3). */
  reference: number;
  /** Trọng số freshness (mặc định 0.2). */
  freshness: number;
}

/** Repo map đã build xong (kèm metadata để cập nhật tăng dần). */
export interface V17RepoMap {
  /** Gốc repo mà map này thuộc về. */
  root: string;
  /** Phiên bản thuật toán ('v17'). */
  version: 'v17';
  /** Thời điểm build / cập nhật lần cuối (ms epoch). */
  builtAt: number;
  /** Số vòng lặp PageRank đã chạy tới hội tụ. */
  iterations: number;
  /** Nodes (file) trong graph. */
  nodes: V17RepoMapNode[];
  /** Edges (import/reference) trong graph. */
  edges: V17RepoMapEdge[];
  /** Xếp hạng cuối cùng, giảm dần theo score. */
  ranks: V17RepoMapRank[];
  /** Fingerprint từng file (mtimeMs:size) để phát hiện file đổi. */
  fingerprints: Record<string, string>;
  /** Trọng số tổ hợp đã dùng. */
  weights: V17RepoMapWeights;
  /** Half-life freshness (ms). */
  freshnessHalfLifeMs: number;
  /** Damping factor PageRank. */
  damping: number;
}

/** Kết quả cập nhật tăng dần của repo map. */
export interface V17RepoMapUpdate {
  /** Files đã đổi (thêm/sửa/xoá) so với fingerprint cũ. */
  changedFiles: string[];
  /** Files bị ảnh hưởng phải tính lại rank (changed + reverse-reachable). */
  affectedFiles: string[];
  /** Files không đổi, rank tái sử dụng. */
  reusedFiles: number;
  /** Map mới sau cập nhật. */
  map: V17RepoMap;
}

/** Một test xác định trong eval oracle. */
export interface V17EvalTest {
  /** Id test (duy nhất trong task). */
  id: string;
  /** Lệnh chạy test (chạy trong box, cwd = workspace task). */
  command: string;
  /** Chuỗi phải xuất hiện trong stdout/stderr khi pass (optional). */
  expectContains?: string;
  /** Chuỗi KHÔNG được xuất hiện (optional). */
  expectNotContains?: string;
  /** Exit code kỳ vọng (mặc định 0). */
  expectExitCode?: number;
  /** Timeout riêng cho test này (ms, mặc định 30_000). */
  timeoutMs?: number;
}

/** Task eval: môi trường + oracle rõ ràng + test xác định. */
export interface V17EvalTask {
  /** Id task (duy nhất). */
  id: string;
  /** Mô tả ngắn cho người đọc. */
  title: string;
  /** File khởi đầu (path -> nội dung) để dựng workspace task. */
  startFiles: Record<string, string>;
  /** Lệnh setup (chạy 1 lần trước test, vd cài deps) — optional. */
  setupCommand?: string;
  /** Danh sách test xác định (oracle). */
  tests: V17EvalTest[];
  /** File bắt buộc phải tồn tại sau khi patch (optional). */
  requiredFiles?: string[];
  /** File bắt buộc KHÔNG được đổi (oracle bảo vệ, vd test gốc). */
  protectedFiles?: string[];
  /** Số lần chạy lại để chứng minh tính xác định (mặc định 2). */
  determinismRuns?: number;
}

/** Kết quả một test trong eval run. */
export interface V17TestResult {
  testId: string;
  passed: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  /** Lý do fail (undefined khi pass). */
  reason?: string;
}

/** Kết quả chấm một patch trên eval task (gate trước khi trình). */
export interface V17EvalReport {
  taskId: string;
  /** Patch đã chấm (path -> nội dung sau patch; file vắng = xoá). */
  patchFiles: string[];
  results: V17TestResult[];
  passed: number;
  failed: number;
  /** true khi mọi test pass VÀ không vi phạm protected files. */
  gatePassed: boolean;
  /** File protected bị đổi (rỗng khi không vi phạm). */
  protectedViolations: string[];
  /** File required còn thiếu (rỗng khi đủ). */
  missingRequiredFiles: string[];
  /** true khi chạy lại cho cùng kết quả (tính xác định). */
  deterministic: boolean;
  /** Tổng thời gian chạy (ms). */
  durationMs: number;
  /** Isolation đã dùng cho lần chạy (bwrap / unshare / none). */
  isolation: string;
}

/** Verdict của critic trên trajectory hoặc patch. */
export type V17CriticVerdict = 'approve' | 'request-changes' | 'block';

/** Điểm critic trên một trajectory. */
export interface V17TrajectoryCriticScore {
  sessionId: string;
  /** Điểm tổng 0..100. */
  score: number;
  /** Điểm thành phần 0..100 từng trục. */
  axes: {
    /** Mức độ hoàn thành mục tiêu (có session_end thành công, test pass). */
    completeness: number;
    /** Hiệu quả: ít bước thừa, ít bash lặp lại. */
    efficiency: number;
    /** Phục hồi lỗi: compiler error có được xử lý, không lặp lỗi cũ. */
    errorRecovery: number;
    /** An toàn: không lệnh phá hoại, không secret lộ trong log. */
    safety: number;
  };
  verdict: V17CriticVerdict;
  /** Lý do từng điểm trừ / khen, theo thứ tự quan trọng. */
  reasons: string[];
  /** Số bước thừa ước tính (bash lặp / file ghi đè không đổi). */
  wastedSteps: number;
  /** Số lỗi compiler chưa được xử lý. */
  unresolvedErrors: number;
}

/** Điểm critic trên một patch. */
export interface V17PatchCriticScore {
  /** Điểm tổng 0..100. */
  score: number;
  axes: {
    /** Patch có giải quyết đúng vấn đề (dựa trên eval gate khi có). */
    correctness: number;
    /** Patch nhỏ, tập trung, không sửa file không liên quan. */
    focus: number;
    /** Có test đi kèm / test pass. */
    testCoverage: number;
    /** Không pattern rủi ro (xem review skill). */
    safety: number;
  };
  verdict: V17CriticVerdict;
  reasons: string[];
  /** Số file trong patch. */
  filesChanged: number;
  /** Số dòng thêm/xoá (ước lượng từ diff text). */
  linesAdded: number;
  linesRemoved: number;
}

/** Một finding của review skill tự động. */
export interface V17ReviewFinding {
  /** Mức: error (block) | warning (request-changes) | note. */
  severity: 'error' | 'warning' | 'note';
  /** Rule đã vi phạm, vd 'secret-in-diff', 'destructive-command'. */
  rule: string;
  /** File liên quan ('' khi là finding toàn patch). */
  file: string;
  /** Dòng liên quan (0 khi không xác định). */
  line: number;
  message: string;
}

/** Kết quả review skill tự động trên một thay đổi. */
export interface V17ReviewResult {
  /** true = không finding error nào → được trình tiếp. */
  passed: boolean;
  findings: V17ReviewFinding[];
  errors: number;
  warnings: number;
  notes: number;
  /** Số file đã review. */
  filesReviewed: number;
}

/** Trạng thái của một plan (Plan Mode). */
export type V17PlanStatus =
  | 'draft'
  | 'refining'
  | 'awaiting-approval'
  | 'approved'
  | 'building'
  | 'done'
  | 'rejected';

/** Một bước trong plan. */
export interface V17PlanStep {
  /** Id bước (duy nhất trong plan). */
  id: string;
  /** Mô tả việc cần làm. */
  title: string;
  /** File bước này chạm tới (rỗng khi chỉ là bước phân tích). */
  files: string[];
  /** Bước đã xong chưa. */
  done: boolean;
  /** Ghi chú khi refine / khi thực hiện lệch plan. */
  note?: string;
}

/** Plan của một task coding (Plan Mode). */
export interface V17Plan {
  /** Id plan (thường trùng sessionId). */
  id: string;
  /** Id task / phiên sở hữu plan. */
  taskId: string;
  /** Mô tả task gốc. */
  task: string;
  status: V17PlanStatus;
  steps: V17PlanStep[];
  /** Số file khác nhau plan chạm tới. */
  fileCount: number;
  /** true khi task đa file → Plan Mode bắt buộc. */
  multiFile: boolean;
  /** Lịch sử refine (mỗi lần refine thêm một dòng). */
  refinements: string[];
  /** Thời điểm tạo / cập nhật (ms epoch). */
  createdAt: number;
  updatedAt: number;
  /** Lý do reject (khi status = rejected). */
  rejectReason?: string;
}

/** Giới hạn tài nguyên cho một lần chạy sandbox của coding agent. */
export interface V17SandboxLimits {
  /** Giới hạn CPU (giây CPU, prlimit qua box; undefined = không giới hạn thêm). */
  cpuSeconds?: number;
  /** Giới hạn RAM (bytes, prlimit --as qua box; undefined = không giới hạn thêm). */
  maxMemoryBytes?: number;
  /** Giới hạn số process (prlimit --nproc; undefined = không giới hạn thêm). */
  maxProcesses?: number;
  /** Timeout lần chạy (ms, mặc định 60_000). */
  timeoutMs?: number;
  /** Cap ghi workspace (bytes, mặc định 50MB). */
  maxWriteBytes?: number;
  /** Cap output (ký tự, mặc định 50_000). */
  maxOutputChars?: number;
}

/** Kết quả một lần chạy code trong sandbox (ghi rõ isolation + fallback). */
export interface V17SandboxRun {
  botId: string;
  /** Lệnh đã chạy (program). */
  command: string;
  args: string[];
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** Isolation thật đã dùng: 'bwrap' | 'unshare' | 'sandbox-exec' | 'none'. */
  isolation: string;
  /** true khi isolation là bwrap/unshare/sandbox-exec (đã cách ly thật). */
  isolated: boolean;
  /** Lý do fallback khi không cách ly ('' khi đã cách ly). */
  fallbackReason: string;
  /** UID của tiến trình host đã chạy (chứng minh non-root khi != 0). */
  uid: number;
  /** true khi chạy non-root (uid != 0). */
  nonRoot: boolean;
  /** Giới hạn đã áp dụng thật (từ box) — undefined khi box không áp. */
  limitsApplied?: Record<string, unknown>;
  durationMs: number;
  workspaceBytes: number;
}

/** Kết quả probe khả năng sandbox trên máy này. */
export interface V17SandboxProbe {
  platform: string;
  /** Backend cách ly tốt nhất phát hiện được. */
  isolation: string;
  /** true khi bwrap có mặt. */
  bwrapAvailable: boolean;
  /** true khi unshare có mặt. */
  unshareAvailable: boolean;
  /** true khi prlimit có mặt (enforce CPU/RAM). */
  prlimitAvailable: boolean;
  /** UID hiện tại (0 = đang chạy root — cảnh báo). */
  uid: number;
  /** Khuyến nghị cho coding agent trên máy này. */
  recommendation: string;
}

/** Kết quả verification stack nhiều tầng cho một phiên coding. */
export interface V17VerificationReport {
  sessionId: string;
  trajectoryScore?: V17TrajectoryCriticScore;
  patchScore?: V17PatchCriticScore;
  review?: V17ReviewResult;
  eval?: V17EvalReport;
  plan?: V17Plan;
  /** true khi MỌI tầng đã chạy đều pass (critic không block, review pass, eval gate pass, plan approved/done). */
  allPassed: boolean;
  /** Tầng nào chưa pass (rỗng khi allPassed). */
  failingLayers: string[];
  /** true khi được trình cho người dùng (allPassed). */
  presentable: boolean;
}

/** Báo cáo chạy của CodingAgentV17 (một phiên scripted, không model thật). */
export interface V17AgentReport {
  sessionId: string;
  task: string;
  /** Số event trong trajectory log cuối phiên. */
  events: number;
  /** Số file đã ghi/sửa trong phiên. */
  filesChanged: string[];
  /** Plan đã dùng (undefined khi task đơn file, Plan Mode không bắt buộc). */
  plan?: V17Plan;
  /** Điểm critic trajectory (khi chạy critic). */
  trajectoryScore?: V17TrajectoryCriticScore;
  /** Kết quả review skill (khi chạy review). */
  review?: V17ReviewResult;
  /** Kết quả eval gate (khi có eval task). */
  eval?: V17EvalReport;
  /** Verification stack tổng hợp. */
  verification: V17VerificationReport;
  /** true khi phiên xong và được trình (verification allPassed). */
  presentable: boolean;
  /** Repo map top files đã dùng làm context (khi có repo map). */
  contextFiles: string[];
  durationMs: number;
}

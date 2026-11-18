/**
 * Coding agent v9 (v1.17, Đội T4) — shared types.
 *
 * Học ý tưởng (survey v1.17 §2, chỉ học ý tưởng, không copy code/text/
 * tài sản của bất kỳ repo nào, của xAI/Cursor):
 * - Aider: git-first, mỗi edit = 1 commit atomic + message tự sinh;
 *   edit kiểu search-and-replace block (ít token hơn whole-file).
 * - OpenHands: Editor + Shell là tool hạng nhất, chạy trong sandbox;
 *   vòng lặp plan → edit → run test → lặp; commit + mở draft PR.
 * - Claude Code: apply-diff workflow, dev review trước khi áp.
 * - SWE-bench: task mẫu + test FAIL_TO_PASS / PASS_TO_PASS, đo pass@k.
 *
 * v9 nối coding agent v8 (v1.16): dùng lại parser tree-sitter-lite
 * của v8 (`v8ParseFile`, symbol có line/endLine) làm nền AST, dùng
 * lại harness SWE-bench của v5 (`CodingV5SweHarness`) để chấm patch,
 * dùng lại policy sandbox của v8 (`checkV8Policy`) để chặn lệnh nguy
 * hiểm. v9 KHÔNG viết lại parser, harness chấm điểm hay policy — chỉ
 * thêm lớp mới trên nền đó:
 *
 *   1. AST-aware edit (`astEdit.ts`): thay function/class/import cụ
 *      thể theo vị trí AST, fallback search-and-replace block.
 *   2. Sandbox execution loop (`sandboxLoop.ts`): edit → test/lint →
 *      đọc lỗi → sửa lại, tối đa N vòng, chạy trong thư mục riêng.
 *   3. Git-first atomic commit (`gitAtomic.ts`): mỗi edit thành công
 *      = 1 commit atomic + message tự sinh, draft-PR description.
 *   4. Eval harness (`evalHarness.ts`): task mẫu, chạy agent trên
 *      task, đo pass@k, lưu kết quả, báo cáo so sánh giữa các lần chạy.
 *   5. Agent v9 (`agent.ts`): pipeline nối 4 lớp trên thành một task.
 */

/** Lỗi riêng của coding agent v9 (để host phân biệt với lỗi hệ thống). */
export class CodingV9Error extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'CodingV9Error';
    this.code = code;
  }
}

/** Mã lỗi dùng chung cho v9. */
export const V9_ERROR_CODES = [
  'symbol-not-found',
  'ambiguous-symbol',
  'block-not-found',
  'block-ambiguous',
  'edit-too-large',
  'verify-failed',
  'command-denied',
  'command-timeout',
  'git-failed',
  'eval-task-invalid',
  'eval-no-patch',
] as const;
export type V9ErrorCode = (typeof V9_ERROR_CODES)[number];

/** Loại thao tác edit mà AST-aware editor hỗ trợ. */
export type V9EditKind =
  | 'replace-symbol'
  | 'replace-import'
  | 'insert-after'
  | 'rename-symbol'
  | 'search-replace';

/** Một thao tác edit duy nhất (đầu vào của `applyV9AstEdit`). */
export interface V9EditOperation {
  kind: V9EditKind;
  /** File repo-relative (dùng `/`), vd `src/util.ts`. */
  path: string;
  /** Tên symbol đích (function/class/interface/type/enum/method). */
  symbolName?: string;
  /** Qualified name khi cần phân biệt (vd `Calc.sum`). */
  qualifiedName?: string;
  /** Kind symbol đích (lọc khi trùng tên). */
  symbolKind?: string;
  /** Nội dung mới thay thế symbol / nội dung chèn sau symbol. */
  newText?: string;
  /** Module specifier mới cho replace-import (vd `./new-util`). */
  newSpecifier?: string;
  /** Tên mới cho rename-symbol. */
  newName?: string;
  /** Block cũ (exact) cho search-replace fallback. */
  oldBlock?: string;
  /** Block mới cho search-replace fallback. */
  newBlock?: string;
  /** Dòng context trước block (giúp phân biệt khi trùng). */
  contextBefore?: string;
  /** Dòng context sau block (giúp phân biệt khi trùng). */
  contextAfter?: string;
}

/** Kết quả một lần edit AST-aware (đã verify). */
export interface V9EditResult {
  /** true = edit đã áp dụng + verify lại bằng parse thành công. */
  ok: boolean;
  /** Loại edit đã thực thi (có thể là fallback). */
  appliedKind: V9EditKind;
  /** true = đã dùng fallback search-replace (không tìm được AST). */
  usedFallback: boolean;
  /** File đã sửa (repo-relative). */
  path: string;
  /** Symbol đã sửa (tên ngắn) hoặc '' khi là search-replace. */
  symbolName: string;
  /** Dòng bắt đầu của vùng sửa (1-based). */
  startLine: number;
  /** Dòng kết thúc của vùng sửa (1-based). */
  endLine: number;
  /** Số dòng đã thêm. */
  linesAdded: number;
  /** Số dòng đã xoá. */
  linesRemoved: number;
  /** Unified diff của lần edit này. */
  diff: string;
  /** Ghi chú verify (vd symbol còn tồn tại sau edit, hash đổi). */
  verifyNote: string;
  /** Lý do khi ok=false. */
  error?: string;
}

/** Một hunk trong unified diff (dùng cho preview + đếm dòng đổi). */
export interface V9DiffHunk {
  /** Dòng bắt đầu bên cũ (1-based, 0 khi chỉ thêm). */
  oldStart: number;
  /** Số dòng cũ trong hunk. */
  oldLines: number;
  /** Dòng bắt đầu bên mới (1-based, 0 khi chỉ xoá). */
  newStart: number;
  /** Số dòng mới trong hunk. */
  newLines: number;
  /** Các dòng diff (bắt đầu bằng ' ', '+' hoặc '-'). */
  lines: string[];
}

/** Kết quả tạo unified diff. */
export interface V9UnifiedDiff {
  /** Text diff đầy đủ (định dạng unified, có header ---/+++). */
  text: string;
  hunks: V9DiffHunk[];
  linesAdded: number;
  linesRemoved: number;
}

/** Trạng thái một lệnh chạy trong sandbox loop. */
export type V9CommandStatus = 'ok' | 'failed' | 'timeout' | 'denied';

/** Kết quả một lệnh chạy trong sandbox (argv, không shell). */
export interface V9CommandResult {
  /** Lệnh đã chạy (argv). */
  argv: string[];
  status: V9CommandStatus;
  /** Exit code (null khi timeout/denied/chưa chạy). */
  exitCode: number | null;
  /** stdout (đã cắt ngắn theo giới hạn). */
  stdout: string;
  /** stderr (đã cắt ngắn theo giới hạn). */
  stderr: string;
  /** Thời gian chạy, ms. */
  durationMs: number;
  /** true = đã hết timeout và bị kill cả process group. */
  timedOut: boolean;
  /** Lý do khi denied (rule nào chặn) hoặc timeout. */
  reason?: string;
}

/** Một vòng trong sandbox execution loop. */
export interface V9LoopRound {
  /** Số thứ tự vòng, bắt đầu từ 1. */
  round: number;
  /** Ghi chú vòng này làm gì (vd `edit: replace greet`, `fix: ...`). */
  note: string;
  /** Kết quả edit ở vòng này (nếu có). */
  edit?: V9EditResult;
  /** Kết quả các lệnh verify ở vòng này. */
  commands: V9CommandResult[];
  /** true = mọi lệnh verify đều ok ở vòng này. */
  passed: boolean;
  /** Đoạn lỗi trích ra để đưa cho fix provider (rỗng khi pass). */
  failureExcerpt: string;
  /** Thời gian vòng này, ms. */
  durationMs: number;
}

/** Kết quả đầy đủ của sandbox execution loop. */
export interface V9LoopResult {
  /** true = verify xanh trước khi hết vòng. */
  passed: boolean;
  /** Số vòng đã chạy. */
  roundsUsed: number;
  /** Số vòng tối đa cho phép. */
  maxRounds: number;
  /** Lý do dừng: `passed` | `max-rounds` | `edit-failed` | `denied` | `timeout`. */
  stopReason: 'passed' | 'max-rounds' | 'edit-failed' | 'denied' | 'timeout';
  /** Chi tiết từng vòng. */
  rounds: V9LoopRound[];
  /** Tổng thời gian, ms. */
  totalDurationMs: number;
  /** Tổng số dòng đã đổi (cộng dồn các edit thành công). */
  totalLinesChanged: number;
}

/** Trạng thái làm việc của git (porcelain v1, đã parse). */
export interface V9GitStatus {
  /** true = repo sạch (không có thay đổi nào). */
  clean: boolean;
  /** File đã staged (X != ' ' và != '?'). */
  staged: string[];
  /** File đã sửa nhưng chưa staged. */
  modified: string[];
  /** File chưa track. */
  untracked: string[];
  /** File đã xoá. */
  deleted: string[];
  /** Nhánh hiện tại ('' khi detached). */
  branch: string;
}

/** Thống kê diff một file (numstat). */
export interface V9FileChangeStat {
  path: string;
  added: number;
  removed: number;
}

/** Kết quả một commit atomic. */
export interface V9AtomicCommit {
  /** SHA đầy đủ của commit vừa tạo. */
  sha: string;
  /** SHA rút gọn (7 ký tự). */
  shortSha: string;
  /** Message đã dùng. */
  message: string;
  /** File đã commit. */
  files: string[];
  /** Thống kê dòng đổi từng file. */
  stats: V9FileChangeStat[];
  /** Tổng dòng thêm / xoá. */
  totalAdded: number;
  totalRemoved: number;
}

/** Một commit trong lịch sử (dùng cho draft-PR description). */
export interface V9CommitSummary {
  sha: string;
  shortSha: string;
  message: string;
  /** Dòng đầu của message (tiêu đề). */
  subject: string;
  authorName: string;
  authorEmail: string;
  date: string;
  filesChanged: number;
  added: number;
  removed: number;
}

/** Mô tả draft-PR tự sinh từ lịch sử commit. */
export interface V9DraftPr {
  /** Tiêu đề PR. */
  title: string;
  /** Body markdown đầy đủ. */
  body: string;
  /** Nhánh nguồn. */
  headBranch: string;
  /** Nhánh đích. */
  baseBranch: string;
  /** Số commit trong PR. */
  commitCount: number;
  /** Tổng file đổi. */
  filesChanged: number;
  totalAdded: number;
  totalRemoved: number;
}

/** Trạng thái một task eval (chuẩn SWE-bench). */
export type V9EvalTaskStatus = 'pass' | 'fail' | 'error';

/** Kết quả chạy agent trên MỘT task, MỘT lần thử (attempt). */
export interface V9EvalAttemptResult {
  /** Id task. */
  taskId: string;
  /** Số thứ tự attempt (bắt đầu từ 1). */
  attempt: number;
  status: V9EvalTaskStatus;
  /** Số vòng sandbox loop agent đã dùng (0 khi agent không báo). */
  roundsUsed: number;
  /** Token vào (model báo, hoặc ước lượng chars/4). */
  tokensIn: number;
  /** Token ra (model báo, hoặc ước lượng chars/4). */
  tokensOut: number;
  /** true = token là ước lượng (agent không báo số thật). */
  tokensEstimated: boolean;
  /** Model agent dùng (agent báo, '' khi không rõ). */
  model: string;
  /** Lý do fail/error (tên test failToPass chưa pass, ...). */
  reason: string;
  /** Thời gian attempt, ms. */
  durationMs: number;
  /** Patch agent đã nộp (cắt ngắn khi lưu). */
  patchPreview: string;
}

/** Kết quả tổng hợp của một task sau k attempt (để tính pass@k). */
export interface V9EvalTaskSummary {
  taskId: string;
  title: string;
  attempts: V9EvalAttemptResult[];
  /** true = có ít nhất 1 attempt pass. */
  anyPass: boolean;
  /** Số attempt pass / tổng attempt. */
  passCount: number;
  /** Vòng lặp trung bình (chỉ tính attempt có roundsUsed > 0). */
  avgRounds: number;
  /** Token trung bình mỗi attempt (in + out). */
  avgTokens: number;
}

/** Báo cáo một lần chạy eval suite (lưu JSON để so sánh). */
export interface V9EvalReport {
  /** Định dạng báo cáo, để tương thích về sau. */
  version: 1;
  /** Tên suite (vd `coding-v9-sample`). */
  suiteName: string;
  /** Thời điểm chạy (ISO). */
  startedAt: string;
  /** Thời điểm kết thúc (ISO). */
  finishedAt: string;
  /** Số attempt mỗi task (k của pass@k). */
  attemptsPerTask: number;
  /** Tổng số task. */
  taskCount: number;
  /** Số task có ít nhất 1 attempt pass. */
  tasksPassed: number;
  /** pass@k = tasksPassed / taskCount. */
  passAtK: number;
  /** Tỉ lệ attempt pass trên tổng attempt. */
  attemptPassRate: number;
  /** Vòng lặp trung bình (chỉ attempt có roundsUsed > 0). */
  avgRounds: number;
  /** Token trung bình mỗi attempt. */
  avgTokens: number;
  /** Tổng thời gian, ms. */
  totalDurationMs: number;
  tasks: V9EvalTaskSummary[];
}

/** So sánh hai báo cáo eval (lần chạy cũ vs mới). */
export interface V9EvalComparison {
  olderFile: string;
  newerFile: string;
  /** Delta pass@k (mới - cũ, điểm phần trăm dạng thập phân). */
  passAtKDelta: number;
  /** Delta tỉ lệ attempt pass. */
  attemptPassRateDelta: number;
  /** Delta vòng lặp trung bình. */
  avgRoundsDelta: number;
  /** Delta token trung bình. */
  avgTokensDelta: number;
  /** Task đổi trạng thái giữa hai lần chạy. */
  changedTasks: Array<{
    taskId: string;
    olderAnyPass: boolean;
    newerAnyPass: boolean;
  }>;
  /** Task mới xuất hiện / biến mất. */
  addedTasks: string[];
  removedTasks: string[];
}

/** Một bước trong pipeline agent v9 (ghi vào report). */
export interface V9AgentStep {
  name: string;
  status: 'ok' | 'failed' | 'skipped';
  detail: string;
  durationMs: number;
}

/** Báo cáo đầy đủ của một task chạy qua CodingAgentV9. */
export interface V9AgentReport {
  /** Tiêu đề task. */
  title: string;
  /** Mô tả task (đầu vào). */
  task: string;
  /** true = pipeline kết thúc với verify xanh + commit thành công. */
  ok: boolean;
  steps: V9AgentStep[];
  /** Edit đã áp dụng (AST-aware). */
  edits: V9EditResult[];
  /** Kết quả sandbox loop (nếu có verify). */
  loop?: V9LoopResult;
  /** Commit atomic (nếu đã commit). */
  commit?: V9AtomicCommit;
  /** Draft-PR description (nếu đã sinh). */
  draftPr?: V9DraftPr;
  /** Diff tổng hợp của toàn bộ task. */
  combinedDiff: string;
  /** Thời gian toàn bộ task, ms. */
  totalDurationMs: number;
}

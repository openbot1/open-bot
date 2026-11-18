/**
 * Coding agent v11 (v1.19, Đội T2) — shared types.
 *
 * Học ý tưởng (chỉ học ý tưởng, không copy code/text/tài sản của bất
 * kỳ repo nào, của xAI/Cursor):
 * - OpenHands CodeAct (agent viết code rồi chạy, đọc kết quả rồi lặp)
 *   + Aider repo map / Architect–Editor + SWE-bench eval: v11 nối
 *   coding agent v10 (event-sourced session, CodeAct executor,
 *   repo map v10 hierarchical, edit strategies, eval theo version)
 *   bằng 6 lớp mới, KHÔNG viết lại v10:
 *
 *   1. CodeAct v9 (`codeactV9.ts`): engine hành động code — nhiều
 *      loại action hơn v10 (đọc/ghi/append/xóa/di chuyển file, chạy
 *      code, chạy lệnh allowlist, commit git), dry-run mô phỏng toàn
 *      bộ trước khi chạm đĩa, xác nhận bắt buộc cho action rủi ro
 *      cao, rollback theo patch (khôi phục nội dung cũ từng file).
 *   2. Call graph + PageRank v2 (`callGraph.ts`): đồ thị lời gọi
 *      hàm resolve theo import (không chỉ tên ngắn như v8), PageRank
 *      v2 có personalization theo truy vấn + HITS hub/authority,
 *      xếp hạng file/hàm quan trọng, map theo truy vấn, impact set
 *      (ai gọi hàm này, đệ quy), phát hiện chu trình (Tarjan SCC).
 *   3. Multi-file refactor (`refactorV11.ts`): đổi tên symbol, tách
 *      file, di chuyển hàm xuyên nhiều file — kiểm tra tham chiếu
 *      đầy đủ trước khi áp, preview diff từng file, apply qua plan
 *      v8 (backup + rollback khi verify fail).
 *   4. Eval harness v2 (`evalV11.ts`): task mẫu có trọng số từng
 *      test (partial credit), chạy lặp phát hiện flaky, so sánh với
 *      baseline để báo regression, lưu/so sánh theo phiên bản.
 *   5. Patch review (`patchReview.ts`): review patch tự động — chấm
 *      rủi ro, quét secret, kiểm tra style, phát hiện test thiếu,
 *      gợi ý sửa, verdict approve/comment/request-changes.
 *   6. Test generation v2 (`testgenV11.ts`): sinh test từ code thay
 *      đổi (diff) — mock-first (stub dependency khi hàm nhận deps),
 *      chạy test sinh ra thật bằng `node --test`, báo function
 *      coverage delta.
 *   7. Agent v11 (`agent.ts`): pipeline nối 6 lớp trên + ghi event
 *      vào phiên v10.
 */

/** Lỗi riêng của coding agent v11. */
export class CodingV11Error extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'CodingV11Error';
    this.code = code;
  }
}

/** Mã lỗi dùng chung cho v11. */
export const V11_ERROR_CODES = [
  'codeact-denied',
  'codeact-needs-confirmation',
  'codeact-timeout',
  'codeact-too-large',
  'codeact-action-invalid',
  'codeact-rollback-failed',
  'callgraph-not-built',
  'callgraph-symbol-not-found',
  'refactor-ambiguous',
  'refactor-reference-missing',
  'refactor-symbol-not-found',
  'refactor-no-change',
  'eval-task-invalid',
  'eval-version-invalid',
  'patch-invalid',
  'testgen-no-target',
  'agent-plan-invalid',
] as const;
export type V11ErrorCode = (typeof V11_ERROR_CODES)[number];

/* ================================================================== */
/* 1. CodeAct v9 — action engine                                       */
/* ================================================================== */

/** Loại action mà CodeAct v9 hỗ trợ (rộng hơn v10: chỉ run code). */
export type V11CodeActActionKind =
  | 'read-file'
  | 'write-file'
  | 'append-file'
  | 'delete-file'
  | 'move-file'
  | 'run-code'
  | 'run-command'
  | 'git-commit';

/** Mức rủi ro của một action (quyết định có cần xác nhận không). */
export type V11ActionRisk = 'low' | 'medium' | 'high';

/** Một action trong plan CodeAct v9. */
export interface V11CodeActAction {
  /** Id duy nhất trong plan (vd `a1`, `a2`, …). */
  id: string;
  kind: V11CodeActActionKind;
  /** Path repo-relative (read/write/append/delete/move nguồn). */
  path?: string;
  /** Path đích (move-file). */
  targetPath?: string;
  /** Nội dung ghi (write-file) / nội dung thêm (append-file). */
  content?: string;
  /** Code chạy (run-code: node/python/bash, như V10CodeActRequest). */
  code?: string;
  /** Kind code chạy (run-code). */
  codeKind?: 'node' | 'python' | 'bash';
  /** Lệnh argv chạy (run-command, không shell). */
  command?: string[];
  /** Commit message (git-commit). */
  message?: string;
  /** File đưa vào commit (git-commit, mặc định: file đã đổi trong plan). */
  files?: string[];
  /** Ghi chú ngắn cho agent/user đọc (hiện trong dry-run + log). */
  note?: string;
}

/** Một plan CodeAct v9: danh sách action chạy tuần tự. */
export interface V11CodeActPlan {
  /** Id plan (`v11ca-<hex>`). */
  id: string;
  /** Tiêu đề ngắn. */
  title: string;
  actions: V11CodeActAction[];
  /** Thời điểm tạo (ISO). */
  createdAt: string;
}

/** Kết quả mô phỏng MỘT action ở chế độ dry-run (không chạm đĩa). */
export interface V11DryRunActionResult {
  actionId: string;
  kind: V11CodeActActionKind;
  risk: V11ActionRisk;
  /** true = action này cần xác nhận trước khi áp thật. */
  needsConfirmation: boolean;
  /** true = dry-run thấy action hợp lệ (file tồn tại, path trong workspace…). */
  valid: boolean;
  /** Mô tả tác động (vd `ghi 12 dòng vào src/a.ts (đã có, sẽ bị thay)`). */
  effect: string;
  /** Unified diff preview (chỉ write/append/delete/move có nội dung). */
  diffPreview?: string;
  /** Lý do khi valid=false. */
  error?: string;
}

/** Kết quả dry-run toàn bộ plan. */
export interface V11DryRunResult {
  planId: string;
  title: string;
  actions: V11DryRunActionResult[];
  /** Số action hợp lệ / cần xác nhận / không hợp lệ. */
  validCount: number;
  needsConfirmationCount: number;
  invalidCount: number;
  /** true = toàn bộ plan áp được khi đã xác nhận đủ (không action invalid). */
  canApply: boolean;
  /** true = dry-run thấy có action ghi/xóa (thay đổi đĩa thật). */
  willModifyDisk: boolean;
}

/** Kết quả áp MỘT action thật. */
export interface V11CodeActActionResult {
  actionId: string;
  kind: V11CodeActActionKind;
  /** Trạng thái: ok | failed | denied | skipped-needs-confirmation. */
  status: 'ok' | 'failed' | 'denied' | 'skipped-needs-confirmation';
  /** Thời gian chạy, ms. */
  durationMs: number;
  /** stdout (run-code/run-command) hoặc mô tả kết quả. */
  stdout: string;
  /** stderr (run-code/run-command) hoặc lý do lỗi. */
  stderr: string;
  /** Exit code (chỉ run-code/run-command). */
  exitCode: number | null;
  /** Unified diff thật của action ghi file (nếu có). */
  diff?: string;
  /** Commit SHA (chỉ git-commit ok). */
  commitSha?: string;
  /** Lý do khi status != ok. */
  reason?: string;
}

/** Một mục trong patch stack dùng để rollback (nội dung cũ từng file). */
export interface V11PatchStackEntry {
  actionId: string;
  /** Path repo-relative đã đổi. */
  path: string;
  /** Nội dung cũ (null = file chưa tồn tại trước action). */
  oldContent: string | null;
  /** true = file đã tồn tại trước action (false = file mới tạo). */
  existed: boolean;
}

/** Kết quả chạy toàn bộ plan CodeAct v9 (dry-run hoặc áp thật). */
export interface V11CodeActRunResult {
  planId: string;
  title: string;
  /** true = chạy ở chế độ dry-run (không đổi đĩa). */
  dryRun: boolean;
  results: V11CodeActActionResult[];
  /** Số action ok / failed / denied / skipped. */
  okCount: number;
  failedCount: number;
  deniedCount: number;
  skippedCount: number;
  /** true = toàn bộ action ok (không failed/denied/skipped). */
  ok: boolean;
  /** Patch stack (chỉ khi áp thật): để `rollbackV11CodeAct` dùng. */
  patchStack: V11PatchStackEntry[];
  /** Thời gian toàn bộ plan, ms. */
  totalDurationMs: number;
}

/** Kết quả rollback một plan CodeAct v9 đã áp. */
export interface V11CodeActRollbackResult {
  planId: string;
  /** Số file đã khôi phục / số file rollback lỗi. */
  restored: number;
  failed: number;
  /** File rollback lỗi + lý do. */
  failures: Array<{ path: string; reason: string }>;
  /** true = toàn bộ file khôi phục đúng nội dung cũ. */
  ok: boolean;
}

/* ================================================================== */
/* 2. Call graph + PageRank v2                                         */
/* ================================================================== */

/** Một cạnh trong call graph v11 (caller → callee đã resolve). */
export interface V11CallEdge {
  /** Symbol gọi (qualified name), '' khi ở top-level. */
  caller: string;
  /** File chứa caller. */
  callerFile: string;
  /** Symbol được gọi (qualified name đã resolve). */
  callee: string;
  /** File chứa callee. */
  calleeFile: string;
  /** Dòng gọi, 1-based. */
  line: number;
  /** true = gọi qua member (`obj.method()`). */
  memberCall: boolean;
  /** Cách resolve: cùng file / import / tên ngắn duy nhất. */
  resolvedBy: 'same-file' | 'import' | 'unique-name' | 'unresolved';
}

/** Điểm xếp hạng của một symbol trong call graph v11. */
export interface V11SymbolRank {
  qualifiedName: string;
  file: string;
  kind: string;
  line: number;
  exported: boolean;
  /** Điểm PageRank v2 (tổng mọi symbol = 1). */
  pageRank: number;
  /** Điểm hub HITS (gọi nhiều symbol quan trọng). */
  hub: number;
  /** Điểm authority HITS (được nhiều symbol quan trọng gọi). */
  authority: number;
  /** Số caller trực tiếp / callee trực tiếp. */
  callerCount: number;
  calleeCount: number;
}

/** Điểm xếp hạng của một file trong call graph v11. */
export interface V11FileRank {
  path: string;
  /** Điểm PageRank file = điểm node file + tổng điểm symbol nó định nghĩa. */
  pageRank: number;
  /** Điểm hub/authority cộng dồn của symbol trong file. */
  hub: number;
  authority: number;
  symbolCount: number;
  /** Số file import file này / số file file này import. */
  importedByCount: number;
  importsCount: number;
}

/** Thống kê call graph v11. */
export interface V11CallGraphStats {
  files: number;
  symbols: number;
  /** Số cạnh call đã resolve / chưa resolve được. */
  resolvedEdges: number;
  unresolvedCalls: number;
  /** Số vòng PageRank + HITS đã chạy + delta cuối. */
  pageRankIterations: number;
  pageRankDelta: number;
  hitsIterations: number;
  /** Số thành phần liên thông mạnh (SCC) có chu trình (>1 node hoặc self-loop). */
  cyclicComponents: number;
}

/** Call graph v11 đầy đủ (đồ thị + điểm xếp hạng). */
export interface V11CallGraphData {
  rootDir: string;
  files: V11FileRank[];
  symbols: V11SymbolRank[];
  edges: V11CallEdge[];
  stats: V11CallGraphStats;
  /** Thời điểm build (ISO). */
  builtAt: string;
}

/** Một hit khi query map theo truy vấn (file/symbol liên quan nhất). */
export interface V11QueryMapHit {
  /** 'file' | 'symbol'. */
  kind: 'file' | 'symbol';
  path: string;
  symbol?: string;
  /** Điểm kết hợp (PageRank personalize + khớp tên). */
  score: number;
  /** Điểm PageRank v2 gốc. */
  pageRank: number;
  /** Vì sao hit này được chọn. */
  reasons: string[];
}

/** Kết quả query map theo truy vấn. */
export interface V11QueryMapResult {
  query: string;
  hits: V11QueryMapHit[];
  /** Số symbol/file đã xét. */
  searched: number;
}

/** Một thành phần liên thông mạnh có chu trình trong call graph. */
export interface V11CallCycle {
  /** Symbol trong chu trình (qualified name). */
  members: string[];
  /** File chứa các symbol trong chu trình. */
  files: string[];
}

/** Impact set: mọi symbol/file bị ảnh hưởng khi đổi một symbol. */
export interface V11ImpactSet {
  symbol: string;
  file: string;
  /** Symbol gọi trực tiếp/gián tiếp tới symbol này (kèm độ sâu). */
  affectedSymbols: Array<{ qualifiedName: string; file: string; depth: number }>;
  /** File chứa các symbol bị ảnh hưởng. */
  affectedFiles: string[];
  /** Độ sâu tối đa đã đi (bị cắt bởi maxDepth). */
  maxDepthReached: number;
}

/* ================================================================== */
/* 3. Multi-file refactor                                              */
/* ================================================================== */

/** Loại refactor mà engine v11 hỗ trợ. */
export type V11RefactorKind = 'rename-symbol' | 'split-file' | 'move-function';

/** Một tham chiếu tới symbol (tìm được khi kiểm tra tham chiếu). */
export interface V11SymbolReference {
  /** File chứa tham chiếu. */
  file: string;
  /** Dòng tham chiếu, 1-based. */
  line: number;
  /** Cột bắt đầu (0-based) của tên symbol trong dòng. */
  column: number;
  /** Vai trò: định nghĩa / gọi / import / tham chiếu khác. */
  role: 'definition' | 'call' | 'import' | 'reference';
  /** Nội dung dòng (đã cắt ngắn). */
  lineText: string;
}

/** Kết quả kiểm tra tham chiếu đầy đủ của một symbol. */
export interface V11ReferenceCheck {
  symbol: string;
  /** File định nghĩa symbol. */
  definitionFile: string;
  /** Mọi tham chiếu tìm được (kèm định nghĩa). */
  references: V11SymbolReference[];
  /** Số file chứa tham chiếu. */
  filesAffected: number;
  /** true = có tham chiếu mơ hồ (tên trùng ở symbol khác, không chắc là symbol này). */
  ambiguous: boolean;
  /** Symbol trùng tên ở file khác (gây mơ hồ) — để user quyết. */
  ambiguousSymbols: Array<{ qualifiedName: string; file: string; line: number }>;
  /** Tham chiếu không resolve được (vd import từ package ngoài). */
  unresolved: V11SymbolReference[];
}

/** Một file đổi trong plan refactor (preview diff trước khi áp). */
export interface V11RefactorFileChange {
  path: string;
  /** Nội dung mới (đầy đủ) sau refactor. */
  newContent: string;
  /** Nội dung cũ (null = file mới). */
  oldContent: string | null;
  /** Unified diff preview của file này. */
  diff: string;
  linesAdded: number;
  linesRemoved: number;
  description: string;
}

/** Plan refactor v11 (đã preview, chưa áp). */
export interface V11RefactorPlan {
  /** Id plan (`v11ref-<hex>`). */
  id: string;
  kind: V11RefactorKind;
  title: string;
  /** Thời điểm tạo (ISO). */
  createdAt: string;
  /** Kiểm tra tham chiếu đầy đủ (đổi tên / di chuyển hàm). */
  referenceCheck?: V11ReferenceCheck;
  changes: V11RefactorFileChange[];
  /** Tổng dòng thêm/xóa. */
  totalAdded: number;
  totalRemoved: number;
  /** Cảnh báo (vd symbol trùng tên, file đích đã tồn tại…). */
  warnings: string[];
}

/** Kết quả áp một plan refactor v11. */
export interface V11RefactorApplyResult {
  planId: string;
  kind: V11RefactorKind;
  ok: boolean;
  /** File đã ghi (repo-relative). */
  filesChanged: string[];
  /** Backup dir của plan v8 (để rollback thủ công khi cần). */
  backupDir: string;
  /** Commit atomic (khi caller yêu cầu commit sau apply). */
  commitSha?: string;
  /** Lý do khi ok=false (đã rollback về trạng thái cũ). */
  error?: string;
}

/* ================================================================== */
/* 4. Eval harness v2                                                  */
/* ================================================================== */

/** Một test có trọng số trong task eval v2 (partial credit). */
export interface V11EvalTestCase {
  /** Tên test (khớp tên lệnh test, như v9/v5). */
  name: string;
  /** Lệnh chạy test (argv, không shell), vd `['node', '--test', 'x.test.mjs']`. */
  command: string[];
  /** Trọng số (mặc định 1). */
  weight?: number;
  /** 'fail-to-pass' (phải pass sau patch) hay 'pass-to-pass' (phải giữ pass). */
  kind: 'fail-to-pass' | 'pass-to-pass';
}

/** Một task eval v2. */
export interface V11EvalTask {
  /** Id task duy nhất trong suite. */
  id: string;
  title: string;
  /** Mô tả task (đầu vào cho agent). */
  description: string;
  /** File fixture của repo nhỏ (repo-relative → nội dung). */
  files: Record<string, string>;
  /** Test có trọng số của task. */
  tests: V11EvalTestCase[];
  /** Điểm tối đa của task (tổng weight; mặc định = tổng weight test). */
  maxScore?: number;
}

/** Kết quả agent nộp cho một attempt (patch + số liệu tự báo). */
export interface V11EvalAgentAttempt {
  /** Unified diff patch agent nộp ('' = không nộp). */
  patch: string;
  roundsUsed: number;
  tokensIn: number;
  tokensOut: number;
  model?: string;
  /** true = token do agent tự báo (false = ước lượng chars/4). */
  tokensEstimated?: boolean;
}

/** Kết quả chấm MỘT test trong một attempt. */
export interface V11EvalTestResult {
  name: string;
  kind: 'fail-to-pass' | 'pass-to-pass';
  weight: number;
  passed: boolean;
  /** Thời gian chạy test, ms. */
  durationMs: number;
  /** Excerpt output khi fail (đã cắt ngắn). */
  failureExcerpt?: string;
}

/** Kết quả MỘT attempt của một task. */
export interface V11EvalAttemptResult {
  attempt: number;
  /** true = mọi fail-to-pass test pass (chuẩn SWE-bench). */
  passed: boolean;
  /** Điểm partial credit (0..1): tổng weight test pass / tổng weight. */
  score: number;
  tests: V11EvalTestResult[];
  roundsUsed: number;
  tokensIn: number;
  tokensOut: number;
  /** Lý do khi patch không áp được / agent không nộp patch. */
  error?: string;
}

/** Tóm tắt MỘT task trong suite eval v2. */
export interface V11EvalTaskSummary {
  taskId: string;
  title: string;
  /** true = ≥1 attempt pass (chuẩn pass@k). */
  anyPass: boolean;
  /** Điểm cao nhất trong các attempt (partial credit). */
  bestScore: number;
  attempts: V11EvalAttemptResult[];
  /** true = kết quả chạy lặp không ổn định (flaky, xem `flakyDetail`). */
  flaky: boolean;
  flakyDetail?: string;
}

/** Báo cáo suite eval v2 (một lần chạy). */
export interface V11EvalReport {
  version: 2;
  agentVersion: string;
  suiteName: string;
  /** pass@k = task có ≥1 attempt pass / tổng task. */
  passAtK: number;
  /** Tỉ lệ attempt pass. */
  attemptPassRate: number;
  /** Điểm partial credit trung bình (0..1). */
  avgScore: number;
  avgRounds: number;
  avgTokens: number;
  taskCount: number;
  tasksPassed: number;
  attemptsPerTask: number;
  /** Số task flaky trong lần chạy này. */
  flakyTasks: number;
  startedAt: string;
  finishedAt: string;
  tasks: V11EvalTaskSummary[];
  /** File report chi tiết (nằm cùng thư mục version). */
  detailFile: string;
}

/** So sánh hai báo cáo eval v2 (cũ vs mới) — phát hiện regression. */
export interface V11EvalComparison {
  olderVersion: string;
  newerVersion: string;
  passAtKDelta: number;
  avgScoreDelta: number;
  attemptPassRateDelta: number;
  /** Task đổi trạng thái pass giữa hai phiên bản. */
  changedTasks: Array<{
    taskId: string;
    olderAnyPass: boolean;
    newerAnyPass: boolean;
    olderBestScore: number;
    newerBestScore: number;
  }>;
  /** Task từng pass nay fail = regression (danh sách id). */
  regressions: string[];
  /** Task từng fail nay pass = tiến bộ. */
  improvements: string[];
}

/* ================================================================== */
/* 5. Patch review                                                     */
/* ================================================================== */

/** Mức nghiêm trọng của một finding trong patch review. */
export type V11ReviewSeverity = 'info' | 'warning' | 'error';

/** Một finding trong patch review. */
export interface V11ReviewFinding {
  severity: V11ReviewSeverity;
  /** Nhóm: risk | secret | style | test-gap | correctness. */
  category: 'risk' | 'secret' | 'style' | 'test-gap' | 'correctness';
  file: string;
  /** Dòng trong file mới (0 khi là finding cấp file/diff). */
  line: number;
  /** Tiêu đề ngắn. */
  title: string;
  /** Giải thích + gợi ý sửa cụ thể. */
  detail: string;
  /** Gợi ý sửa (code/text ngắn, nếu có). */
  suggestion?: string;
}

/** Kết quả review một patch. */
export interface V11PatchReview {
  /** Unified diff đã review (đã cắt ngắn khi quá dài). */
  diffPreview: string;
  /** Điểm rủi ro 0..100 (cao = rủi ro cao). */
  riskScore: number;
  /** Mức rủi ro: low (<30) | medium (30..59) | high (>=60). */
  riskLevel: 'low' | 'medium' | 'high';
  findings: V11ReviewFinding[];
  /** Số finding theo mức. */
  errorCount: number;
  warningCount: number;
  infoCount: number;
  /** File đổi / dòng thêm / dòng xóa. */
  filesChanged: number;
  linesAdded: number;
  linesRemoved: number;
  /** File nguồn đổi mà không có test đi kèm. */
  filesMissingTests: string[];
  /** Verdict: approve | comment | request-changes. */
  verdict: 'approve' | 'comment' | 'request-changes';
  /** Tóm tắt một dòng cho verdict. */
  summary: string;
}

/* ================================================================== */
/* 6. Test generation v2                                               */
/* ================================================================== */

/** Một test case sinh ra từ code thay đổi (v2, mock-first). */
export interface V11GeneratedTestCase {
  /** Tên test (hàm + case). */
  name: string;
  /** Tên hàm được test. */
  functionName: string;
  /** File nguồn chứa hàm. */
  sourceFile: string;
  /** Loại case: happy | edge | error | smoke. */
  kind: 'happy' | 'edge' | 'error' | 'smoke';
  /** true = case dùng mock dependency (hàm nhận deps) — không gọi API/fs thật. */
  mocked: boolean;
  /** Code test (node:test) của case này. */
  code: string;
  /** Vì sao sinh case này (suy ra từ signature/thân hàm). */
  rationale: string;
}

/** Một file test sinh ra (v2). */
export interface V11GeneratedTestFile {
  /** Path test sẽ ghi (repo-relative, không ghi đè test người viết). */
  testPath: string;
  /** File nguồn mà test này cover. */
  sourceFile: string;
  /** Nội dung file test đầy đủ (header GENERATED + import + cases). */
  content: string;
  cases: V11GeneratedTestCase[];
}

/** Kết quả sinh test v2 từ một diff / danh sách file đổi. */
export interface V11TestGenResult {
  /** File test đã sinh (nội dung, chưa ghi đĩa trừ khi caller ghi). */
  generated: V11GeneratedTestFile[];
  /** Số function export đã xét / đã có ≥1 case. */
  functionsConsidered: number;
  functionsCovered: number;
  /** Function export chưa sinh được case + lý do. */
  uncovered: Array<{ functionName: string; sourceFile: string; reason: string }>;
  /** Số case mock-first / smoke. */
  mockedCases: number;
  smokeCases: number;
}

/** Kết quả chạy test sinh ra thật bằng `node --test`. */
export interface V11TestGenRunResult {
  /** true = mọi file test sinh ra đều pass. */
  ok: boolean;
  /** Số file test pass / fail / tổng case. */
  filesPassed: number;
  filesFailed: number;
  totalCases: number;
  /** Output gộp (đã cắt ngắn). */
  output: string;
  /** File test fail + excerpt lỗi. */
  failures: Array<{ testPath: string; excerpt: string }>;
}

/** Function-coverage delta trước/sau khi sinh test. */
export interface V11CoverageDelta {
  /** Số function export có test trước / sau. */
  coveredBefore: number;
  coveredAfter: number;
  totalFunctions: number;
  /** Tỉ lệ cover trước / sau (0..1). */
  rateBefore: number;
  rateAfter: number;
  /** Function mới được cover nhờ test sinh ra. */
  newlyCovered: string[];
}

/* ================================================================== */
/* 7. Agent v11                                                        */
/* ================================================================== */

/** Một bước trong pipeline agent v11. */
export interface V11AgentStep {
  name: string;
  status: 'ok' | 'failed' | 'skipped';
  detail: string;
  durationMs: number;
}

/** Báo cáo đầy đủ của một task chạy qua CodingAgentV11. */
export interface V11AgentReport {
  /** Id phiên v10 (khi agent được gắn session). */
  sessionId?: string;
  /** Tiêu đề task. */
  title: string;
  /** Mô tả task (đầu vào). */
  task: string;
  /** true = pipeline kết thúc ok (review không request-changes + verify xanh). */
  ok: boolean;
  steps: V11AgentStep[];
  /** Kết quả CodeAct v9 (dry-run + apply). */
  codeAct?: V11CodeActRunResult;
  /** Plan + kết quả refactor (khi task yêu cầu refactor). */
  refactorPlan?: V11RefactorPlan;
  refactorResult?: V11RefactorApplyResult;
  /** Review patch của toàn bộ thay đổi. */
  patchReview?: V11PatchReview;
  /** Test sinh ra từ thay đổi + kết quả chạy. */
  testGen?: V11TestGenResult;
  testGenRun?: V11TestGenRunResult;
  /** Commit atomic (khi đã commit). */
  commitSha?: string;
  /** Diff tổng hợp của toàn bộ task. */
  combinedDiff: string;
  /** Thời gian toàn bộ task, ms. */
  totalDurationMs: number;
}

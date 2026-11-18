/**
 * Coding agent v10 (v1.18, Đội T2) — shared types.
 *
 * Học ý tưởng (chỉ học ý tưởng, không copy code/text/tài sản của bất
 * kỳ repo nào, của xAI/Cursor):
 * - OpenHands V1 SDK: event-sourced ConversationState (mọi bước là
 *   Action/Observation bất biến trong event log), CodeAct agent
 *   (agent viết code rồi chạy trong sandbox, đọc kết quả rồi lặp),
 *   Repository Map, sandbox/microVM execution, vòng lặp
 *   plan → edit → run test → lặp.
 * - Aider: git-first atomic commit, repo map tree-sitter,
 *   Architect–Editor pattern (plan rồi edit theo plan).
 *
 * v10 nối coding agent v9 (v1.17, Đội T4) và các nền đã có, KHÔNG
 * viết lại chúng — chỉ thêm lớp mới trên nền đó:
 *
 *   1. Event-sourced session (`eventSession.ts`): phiên coding là
 *      một event log append-only (Action/Observation bất biến, hash
 *      chain), trạng thái suy ra bằng fold; snapshot + replay toàn
 *      bộ phiên từ log, fork tại bất kỳ event nào, pause/resume có
 *      persist xuống đĩa. Khác run log ở `event-log/` (log theo run
 *      của AgentRunner, đã có fork/pause ở tầng run): v10 là log
 *      theo PHIÊN CODING (edit/codeact/repomap/eval), gắn với
 *      working dir + file đã đổi, để agent coding tự resume đúng
 *      chỗ sau khi dừng.
 *   2. CodeAct execution (`codeactExec.ts`): agent viết code
 *      (node/python/bash) rồi chạy trong sandbox local theo pattern
 *      sandbox hiện có (argv, không shell; allowlist + denylist của
 *      v9/codeact; timeout + cap output), kết quả thành Observation
 *      event (stdout/stderr/exit code).
 *   3. Repo map v3 mở rộng (`repoMapV10.ts`): trên nền PageRank v3
 *      của v8 (graph import/call + PageRank có trọng số) thêm tóm
 *      tắt phân cấp module → file → symbol, nén token theo ngân
 *      sách, cập nhật tăng dần theo content hash, query theo symbol.
 *   4. Edit strategies (`editStrategies.ts`): chọn chiến lược edit
 *      tốt nhất trong 3 loại — AST-aware (v9), search-replace block
 *      (v9), whole-file fallback (mới) — theo điểm số; mỗi edit ghi
 *      event + commit atomic git-first (v9).
 *   5. Eval harness mở rộng (`evalV10.ts`): thêm task mẫu nội bộ,
 *      đo pass@k, lưu kết quả THEO PHIÊN BẢN agent để so sánh các
 *      phiên bản với nhau (v9 chỉ lưu/so sánh theo lần chạy).
 *   6. Agent v10 (`agent.ts`): pipeline nối 5 lớp trên, mọi bước
 *      ghi event vào session.
 */

/** Lỗi riêng của coding agent v10. */
export class CodingV10Error extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'CodingV10Error';
    this.code = code;
  }
}

/** Mã lỗi dùng chung cho v10. */
export const V10_ERROR_CODES = [
  'session-not-found',
  'session-paused',
  'session-completed',
  'event-not-found',
  'event-chain-broken',
  'codeact-denied',
  'codeact-timeout',
  'codeact-too-large',
  'edit-no-strategy',
  'edit-verify-failed',
  'repomap-not-built',
  'symbol-not-found',
  'eval-task-invalid',
  'eval-version-invalid',
  'fork-seq-invalid',
] as const;
export type V10ErrorCode = (typeof V10_ERROR_CODES)[number];

/* ================================================================== */
/* 1. Event-sourced session                                            */
/* ================================================================== */

/** Loại sự kiện trong phiên coding v10 (Action / Observation). */
export type V10EventKind =
  | 'action'
  | 'observation'
  | 'snapshot'
  | 'pause'
  | 'resume'
  | 'fork'
  | 'complete'
  | 'error';

/** Loại action mà agent coding thực hiện (ghi vào event). */
export type V10ActionType =
  | 'plan'
  | 'edit'
  | 'codeact-run'
  | 'verify'
  | 'commit'
  | 'repomap-query'
  | 'eval-run'
  | 'message';

/** Loại observation mà môi trường trả về cho một action. */
export type V10ObservationType =
  | 'edit-result'
  | 'codeact-result'
  | 'verify-result'
  | 'commit-result'
  | 'repomap-result'
  | 'eval-result'
  | 'error';

/** Một event bất biến trong event log của phiên coding v10. */
export interface V10SessionEvent {
  /** Số thứ tự trong phiên, bắt đầu từ 1, tăng đều, không lỗ hổng. */
  seq: number;
  /** Id phiên sở hữu event. */
  sessionId: string;
  /** Thời điểm ghi (ISO 8601). */
  at: string;
  /** Nhóm event: action của agent hay observation của môi trường. */
  kind: V10EventKind;
  /** Loại chi tiết (vd `edit`, `codeact-result`). */
  type: string;
  /** Dữ liệu riêng từng loại (đã cắt ngắn, không secret). */
  payload: Record<string, unknown>;
  /** Hash event trước đó trong chuỗi ('' cho event đầu tiên). */
  prevHash: string;
  /** SHA-256 hash của event này (chuỗi hash chain). */
  hash: string;
}

/** Event mới (chưa có seq/hash) — đầu vào của `append`. */
export interface V10NewSessionEvent {
  kind: V10EventKind;
  type: string;
  payload: Record<string, unknown>;
}

/** Trạng thái phiên suy ra bằng fold từ event log (hàm thuần). */
export interface V10SessionState {
  sessionId: string;
  /** Tiêu đề ngắn của phiên. */
  title: string;
  /** Working dir của phiên (repo làm việc). */
  workingDir: string;
  /** Trạng thái hiện tại. */
  status: 'running' | 'paused' | 'completed' | 'failed' | 'forked';
  /** Số event đã fold. */
  eventCount: number;
  /** Seq cuối cùng đã fold (0 khi chưa có event). */
  lastSeq: number;
  /** Số action đã ghi. */
  actionCount: number;
  /** Số observation đã ghi. */
  observationCount: number;
  /** File đã đổi trong phiên (suy ra từ edit/commit events). */
  filesChanged: string[];
  /** Commit atomic đã tạo trong phiên (short SHA). */
  commits: string[];
  /** Số lệnh CodeAct đã chạy + số lần pass. */
  codeActRuns: number;
  codeActPassed: number;
  /** Vòng verify đã chạy + số vòng pass. */
  verifyRounds: number;
  verifyPassed: number;
  /** Lỗi cuối cùng (nếu có). */
  lastError?: string;
  /** Thời điểm bắt đầu / kết thúc (ISO). */
  startedAt: string;
  endedAt?: string;
  /** Phiên cha (khi phiên này fork ra) + seq fork. */
  parentSessionId?: string;
  forkFromSeq?: number;
  /** Số lần pause/resume. */
  pauseCount: number;
  resumeCount: number;
}

/** Snapshot của phiên: trạng thái đã fold + vị trí trong log. */
export interface V10SessionSnapshot {
  version: 1;
  sessionId: string;
  /** Seq cuối cùng snapshot bao gồm. */
  atSeq: number;
  /** Thời điểm chụp snapshot (ISO). */
  at: string;
  /** Trạng thái đã fold tới atSeq. */
  state: V10SessionState;
  /** Digest của trạng thái (để replay đối chiếu). */
  stateDigest: string;
}

/** Kết quả verify hash chain của event log. */
export interface V10ChainVerification {
  ok: boolean;
  /** Số event đã kiểm tra. */
  checked: number;
  /** Seq đầu tiên đứt chuỗi (-1 khi chuỗi nguyên vẹn). */
  firstBrokenSeq: number;
  reason?: string;
}

/** Kết quả fork một phiên tại một event. */
export interface V10ForkResult {
  /** Phiên mới (đã có event fork + bản sao prefix). */
  sessionId: string;
  /** Seq trong phiên gốc mà fork sao chép tới (bao gồm seq này). */
  fromSeq: number;
  /** Số event đã sao chép. */
  copiedEvents: number;
}

/* ================================================================== */
/* 2. CodeAct execution                                                */
/* ================================================================== */

/** Ngôn ngữ/kind code mà CodeAct v10 chạy. */
export type V10CodeActKind = 'node' | 'python' | 'bash';

/** Một lần chạy CodeAct (agent viết code rồi chạy). */
export interface V10CodeActRequest {
  kind: V10CodeActKind;
  /** Code nguồn (node/python) hoặc command (bash). */
  code: string;
  /** Đối số thêm cho script (node/python). */
  args?: string[];
  /** Timeout, ms. */
  timeoutMs?: number;
  /** Giới hạn ký tự output mỗi stream. */
  outputLimit?: number;
  /** Allowlist lệnh đầu tiên (bash) — undefined = dùng mặc định. */
  allowedCommands?: readonly string[];
}

/** Kết quả một lần chạy CodeAct (thành Observation event). */
export interface V10CodeActResult {
  kind: V10CodeActKind;
  /** Trạng thái: ok | failed | timeout | denied. */
  status: 'ok' | 'failed' | 'timeout' | 'denied';
  /** Exit code (null khi timeout/denied). */
  exitCode: number | null;
  /** stdout (đã cắt ngắn theo giới hạn). */
  stdout: string;
  /** stderr (đã cắt ngắn theo giới hạn). */
  stderr: string;
  /** Thời gian chạy, ms. */
  durationMs: number;
  /** true = đã hết timeout và bị kill. */
  timedOut: boolean;
  /** Lý do khi denied/timeout. */
  reason?: string;
  /** Lệnh argv thực tế đã chạy (để audit, không chứa code dài). */
  argvPreview: string[];
}

/* ================================================================== */
/* 3. Repo map v10 — hierarchical summaries + token compression       */
/* ================================================================== */

/** Tóm tắt một symbol (lá của cây phân cấp). */
export interface V10SymbolSummary {
  qualifiedName: string;
  kind: string;
  signature: string;
  line: number;
  exported: boolean;
  /** Điểm PageRank của node symbol (0 khi chưa có graph). */
  score: number;
}

/** Tóm tắt một file. */
export interface V10FileSummary {
  path: string;
  language: string;
  /** Tóm tắt một dòng về file (symbol export chính + số symbol). */
  summary: string;
  symbols: V10SymbolSummary[];
  /** Module import (specifier, đã resolve tương đối khi được). */
  imports: string[];
  /** Điểm PageRank của node file. */
  score: number;
  /** Ước lượng token của tóm tắt file này (chars/4). */
  tokenEstimate: number;
  /** SHA-256 nội dung file lúc tóm tắt (để incremental). */
  contentHash: string;
}

/** Tóm tắt một module = một thư mục. */
export interface V10ModuleSummary {
  /** Thư mục repo-relative ('.' = root). */
  dir: string;
  /** Tóm tắt một dòng về module. */
  summary: string;
  files: V10FileSummary[];
  /** Tổng số symbol trong module. */
  totalSymbols: number;
  /** Điểm PageRank cộng dồn của module. */
  score: number;
  /** Ước lượng token của tóm tắt module này. */
  tokenEstimate: number;
}

/** Repo map v10 đầy đủ (cây phân cấp + chỉ số). */
export interface V10RepoMapData {
  rootDir: string;
  modules: V10ModuleSummary[];
  /** Tổng số file / symbol / module. */
  fileCount: number;
  symbolCount: number;
  moduleCount: number;
  /** Tổng ước lượng token của toàn bộ map (chưa nén). */
  totalTokenEstimate: number;
  /** Thời điểm build (ISO). */
  builtAt: string;
}

/** Kết quả render repo map theo ngân sách token. */
export interface V10RepoMapRender {
  /** Text đã nén (module → file → symbol, theo ngân sách). */
  text: string;
  /** Ước lượng token của text đã render. */
  tokenEstimate: number;
  /** Ngân sách token caller cho. */
  budget: number;
  /** true = đã phải bỏ bớt symbol/file để vừa ngân sách. */
  compressed: boolean;
  /** Số symbol đã giữ / tổng số symbol. */
  symbolsKept: number;
  symbolsTotal: number;
  /** Số file đã giữ / tổng số file. */
  filesKept: number;
  filesTotal: number;
}

/** Một hit khi query repo map theo symbol. */
export interface V10SymbolQueryHit {
  qualifiedName: string;
  kind: string;
  file: string;
  line: number;
  signature: string;
  /** Điểm PageRank của symbol. */
  score: number;
  /** Vì sao hit này được chọn (khớp tên / prefix / PageRank cao). */
  reasons: string[];
}

/** Kết quả query theo symbol. */
export interface V10SymbolQueryResult {
  query: string;
  hits: V10SymbolQueryHit[];
  /** Số symbol đã xét. */
  symbolsSearched: number;
}

/** Kết quả cập nhật tăng dần repo map v10. */
export interface V10RepoMapUpdateResult {
  reparsed: string[];
  reused: string[];
  removed: string[];
  /** Số file summary đã build lại. */
  summariesRebuilt: number;
  /** Số file summary tái dùng. */
  summariesReused: number;
  /** Số node PageRank tính lại (từ v8 incremental). */
  subgraphNodesRecomputed: number;
}

/* ================================================================== */
/* 4. Edit strategies                                                  */
/* ================================================================== */

/** Chiến lược edit mà v10 hỗ trợ. */
export type V10EditStrategy = 'ast' | 'search-replace' | 'whole-file';

/** Một ứng viên chiến lược edit (đã preview, chưa áp). */
export interface V10EditCandidate {
  strategy: V10EditStrategy;
  /** Điểm số (cao hơn = ưu tiên hơn). */
  score: number;
  /** Vì sao chiến lược này khả thi / bị trừ điểm. */
  reasons: string[];
  /** Số dòng sẽ đổi (ước lượng từ preview). */
  linesChanged: number;
  /** true = ứng viên này áp được (preview ok). */
  applicable: boolean;
}

/** Kết quả áp một edit bằng chiến lược đã chọn. */
export interface V10EditApplyResult {
  ok: boolean;
  /** Chiến lược đã dùng (có thể khác chiến lược yêu cầu khi fallback). */
  strategy: V10EditStrategy;
  /** true = đã fallback sang chiến lược khác với yêu cầu. */
  usedFallback: boolean;
  /** File đã sửa (repo-relative). */
  path: string;
  /** Symbol đã sửa ('' khi whole-file / search-replace). */
  symbolName: string;
  startLine: number;
  endLine: number;
  linesAdded: number;
  linesRemoved: number;
  /** Unified diff của lần edit này. */
  diff: string;
  /** Ghi chú verify (parse lại ok, hash đổi). */
  verifyNote: string;
  /** Lý do khi ok=false. */
  error?: string;
  /** Điểm của chiến lược đã chọn. */
  score: number;
  /** Mọi ứng viên đã xét (để agent giải thích lựa chọn). */
  candidates: V10EditCandidate[];
  /** Commit atomic (khi caller yêu cầu commit sau edit). */
  commitSha?: string;
}

/* ================================================================== */
/* 5. Eval harness mở rộng — kết quả theo phiên bản agent             */
/* ================================================================== */

/** Báo cáo eval của MỘT phiên bản agent (bọc report v9). */
export interface V10VersionedEvalReport {
  version: 1;
  /** Phiên bản agent (vd `v10`, `v9`, `scripted-v10`). */
  agentVersion: string;
  /** Tên suite. */
  suiteName: string;
  /** pass@k của phiên bản này. */
  passAtK: number;
  /** Tỉ lệ attempt pass. */
  attemptPassRate: number;
  /** Vòng lặp trung bình / token trung bình. */
  avgRounds: number;
  avgTokens: number;
  /** Số task / số task pass. */
  taskCount: number;
  tasksPassed: number;
  /** Số attempt mỗi task (k). */
  attemptsPerTask: number;
  /** Thời điểm chạy (ISO). */
  startedAt: string;
  finishedAt: string;
  /** File report v9 đầy đủ (tên file, nằm cùng thư mục version). */
  detailFile: string;
}

/** Một dòng trong bảng so sánh các phiên bản agent. */
export interface V10EvalVersionRow {
  agentVersion: string;
  passAtK: number;
  attemptPassRate: number;
  avgRounds: number;
  avgTokens: number;
  taskCount: number;
  tasksPassed: number;
  /** true = phiên bản tốt nhất theo pass@k (hòa thì lấy mới nhất). */
  best: boolean;
}

/** So sánh hai phiên bản agent (cũ vs mới). */
export interface V10EvalVersionComparison {
  olderVersion: string;
  newerVersion: string;
  passAtKDelta: number;
  attemptPassRateDelta: number;
  avgRoundsDelta: number;
  avgTokensDelta: number;
  /** Task đổi trạng thái pass giữa hai phiên bản. */
  changedTasks: Array<{ taskId: string; olderAnyPass: boolean; newerAnyPass: boolean }>;
}

/* ================================================================== */
/* 6. Agent v10                                                        */
/* ================================================================== */

/** Một bước trong pipeline agent v10 (ghi vào report + event). */
export interface V10AgentStep {
  name: string;
  status: 'ok' | 'failed' | 'skipped';
  detail: string;
  durationMs: number;
}

/** Báo cáo đầy đủ của một task chạy qua CodingAgentV10. */
export interface V10AgentReport {
  /** Id phiên event-sourced của task này. */
  sessionId: string;
  /** Tiêu đề task. */
  title: string;
  /** Mô tả task (đầu vào). */
  task: string;
  /** true = pipeline kết thúc với verify xanh + commit thành công. */
  ok: boolean;
  steps: V10AgentStep[];
  /** Edit đã áp dụng (theo chiến lược). */
  edits: V10EditApplyResult[];
  /** Kết quả CodeAct đã chạy trong task (nếu có). */
  codeActResults: V10CodeActResult[];
  /** Kết quả sandbox loop (nếu có verify). */
  loop?: import('../codingV9/types').V9LoopResult;
  /** Commit atomic (nếu đã commit). */
  commit?: import('../codingV9/types').V9AtomicCommit;
  /** Snapshot cuối phiên (để resume/fork sau này). */
  snapshot?: V10SessionSnapshot;
  /** Diff tổng hợp của toàn bộ task. */
  combinedDiff: string;
  /** Thời gian toàn bộ task, ms. */
  totalDurationMs: number;
}

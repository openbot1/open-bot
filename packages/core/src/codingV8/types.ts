/**
 * Coding agent v8 — types (v1.16, Đội T4).
 *
 * Học ý tưởng OpenHands V1 SDK (survey v1.16 §5): agent = hàm thuần
 * history → next Action; ConversationState duy nhất mutable; EventLog
 * append-only là single source of truth (replay/fork/pause); CodeAct —
 * bash + Python + browser DSL thay vì 20 tool bespoke; Microagents →
 * Skills. Chỉ học ý tưởng — thiết kế và code của open-bot, KHÔNG đọc,
 * KHÔNG copy code/text/tài sản của bất kỳ repo nào, của xAI/Cursor.
 *
 * v8 khác v7 ở đâu (không viết lại v7):
 * - Repo map PageRank v3 (`repoMap.ts` + `parser.ts`): parser TS/JS
 *   tự viết theo phong cách tree-sitter (scope bằng brace, nhận diện
 *   class/interface/enum/namespace/method/arrow/export/decorator),
 *   graph có cạnh call (caller → callee) thật thay vì chỉ references
 *   theo tên, PageRank có trọng số theo kind cạnh + personalization,
 *   incremental update theo content hash + chỉ tính lại subgraph bị
 *   ảnh hưởng, query top symbol liên quan tới task.
 * - Multi-file refactor an toàn (`refactor.ts`): plan → preview diff
 *   (unified diff) → user approve → apply từng file có backup/rollback
 *   → verify (typecheck/test) sau apply, rollback tự động nếu fail.
 * - Test-generation tự động (`testgen.ts`): sinh test node:test từ
 *   signature + behavior suy ra từ code, chạy test sinh ra thật, báo
 *   function-coverage delta, test sinh ra gắn cờ `generated`.
 * - Security analyzer v2 (`securityV2.ts`): taint tracking lite
 *   (source → sink qua biến trong scope hàm), secret scan (pattern +
 *   entropy Shannon, KHÔNG log giá trị thật), dependency audit
 *   (lockfile parse + danh sách CVE pattern nội bộ).
 * - CodeAct-lite v4 (`codeactV4.ts`): nối v3 — sandbox policy tường
 *   minh (allowlist lệnh, chặn rm -rf ngoài workspace, timeout, env
 *   đã lược), observation chuẩn hóa, multi-step script.
 * - Agent v8 (`agent.ts`): pipeline coding task dùng lại log event
 *   v7 (append-only, replay/fork/pause) + 4 module trên, có approval
 *   gate trước mọi lần ghi file.
 *
 * Local-first: không X, không Grok Imagine, không cloud VM/tài khoản/
 * thanh toán. Module core thuần (không gọi model thật — model được tiêm
 * qua callback; executor chỉ chạy trong working dir được giao; không
 * có VM/container cách ly — policy là pattern + jail path, ghi rõ).
 */

/** Mức rủi ro / quyết định của security analyzer v2. */
export type V8SecurityLevel = 'allow' | 'warn' | 'block';

/** Trạng thái một phiên refactor. */
export type V8RefactorStatus =
  | 'planned'
  | 'previewed'
  | 'approved'
  | 'applied'
  | 'verified'
  | 'rolled-back'
  | 'failed';

/** Trạng thái một phiên coding agent v8. */
export type V8SessionStatus = 'running' | 'paused' | 'finished' | 'aborted' | 'blocked' | 'awaiting-approval';

/** Kind của symbol trong repo map v3. */
export type V8SymbolKind =
  | 'function'
  | 'class'
  | 'method'
  | 'interface'
  | 'type'
  | 'enum'
  | 'variable'
  | 'namespace'
  | 'property';

/** Ngôn ngữ file mà parser v8 hiểu. */
export type V8Language = 'typescript' | 'javascript' | 'python' | 'unknown';

/** Một symbol đã parse được trong một file. */
export interface V8Symbol {
  kind: V8SymbolKind;
  /** Tên ngắn, vd `save`. */
  name: string;
  /** Tên đầy đủ theo scope, vd `Foo.save` hay `Outer.Inner`. */
  qualifiedName: string;
  /** Dòng bắt đầu, 1-based. */
  line: number;
  /** Cột bắt đầu, 1-based. */
  column: number;
  /** Dòng kết thúc, 1-based (0 khi không xác định được). */
  endLine: number;
  /** true = được export khỏi file. */
  exported: boolean;
  /** true = async. */
  async: boolean;
  /** Chữ ký khai báo (đã cắt ngắn), vd `function save(id: string): boolean`. */
  signature: string;
  /** Tham số (tên + kiểu nếu parse được). */
  params: Array<{ name: string; type?: string }>;
  /** Kiểu trả về nếu parse được (undefined khi không có). */
  returnType?: string;
  /** Doc comment (JSDoc) ngay trên symbol, đã cắt ngắn. */
  doc?: string;
}

/** Một call site: một symbol gọi một tên khác. */
export interface V8CallSite {
  /** Symbol chứa call (qualified name), '' khi ở top-level. */
  caller: string;
  /** Tên được gọi (ngắn), vd `save` hoặc `fs.readFile`. */
  calleeName: string;
  /** Dòng gọi, 1-based. */
  line: number;
  /** true = gọi qua member (`obj.method()`), false = gọi trực tiếp. */
  memberCall: boolean;
}

/** Một import trong file. */
export interface V8Import {
  /** Module specifier gốc, vd `./auth` hay `node:fs`. */
  specifier: string;
  /** Path đã resolve (repo-relative) hoặc null khi là package ngoài / không resolve được. */
  resolved: string | null;
  /** Tên import, vd `readFile` hay `* as fs`. */
  names: string[];
  /** Dòng import, 1-based. */
  line: number;
}

/** Kết quả parse một file. */
export interface V8ParsedFile {
  /** Đường dẫn repo-relative, dùng `/`. */
  relPath: string;
  language: V8Language;
  /** SHA-256 hex của nội dung file (dùng cho incremental update). */
  contentHash: string;
  /** Kích thước nội dung, byte. */
  size: number;
  symbols: V8Symbol[];
  calls: V8CallSite[];
  imports: V8Import[];
  /** true khi file có lỗi parse (vẫn giữ phần parse được). */
  hasError: boolean;
  /** Ghi chú lỗi parse (nếu có). */
  parseErrors: string[];
}

/** Kind cạnh trong graph repo map v3. */
export type V8EdgeKind = 'defines' | 'imports' | 'calls' | 'references' | 'contains';

/** Một cạnh có trọng số trong graph. */
export interface V8GraphEdge {
  from: string;
  to: string;
  kind: V8EdgeKind;
  weight: number;
}

/** Một node trong graph (file hoặc symbol). */
export interface V8GraphNode {
  id: string;
  kind: 'file' | 'symbol';
  /** File chứa node (với node file thì chính nó). */
  file: string;
  /** Tên đầy đủ của symbol (chỉ node symbol). */
  symbol?: string;
  /** Điểm PageRank (chuẩn hoá: tổng mọi node = 1). */
  score: number;
}

/** Thống kê của graph repo map v3. */
export interface V8GraphStats {
  files: number;
  symbols: number;
  edges: number;
  edgesByKind: Record<V8EdgeKind, number>;
  /** Số symbol mơ hồ (định nghĩa ở > maxTargets file) bị bỏ cạnh references. */
  ambiguousSymbolsSkipped: number;
  /** Số vòng power iteration đã chạy. */
  pageRankIterations: number;
  /** Max |delta| ở vòng cuối. */
  pageRankDelta: number;
}

/** Đồ thị repo map v3 đã dựng + điểm xếp hạng. */
export interface V8Graph {
  nodes: Map<string, V8GraphNode>;
  edges: V8GraphEdge[];
  /** Điểm file = điểm node file + tổng điểm symbol nó định nghĩa (chuẩn hoá tổng = 1). */
  fileScores: Map<string, number>;
  /** Điểm symbol (chuẩn hoá tổng = 1 trên mọi symbol). */
  symbolScores: Map<string, number>;
  stats: V8GraphStats;
}

/** Kết quả query top symbol/file liên quan tới task. */
export interface V8RepoQueryHit {
  /** Id node (`file:<path>` hoặc `symbol:<path>#<qualified>`). */
  nodeId: string;
  kind: 'file' | 'symbol';
  file: string;
  symbol?: string;
  /** Điểm PageRank đã personalize theo query (chuẩn hoá tổng = 1 trong kết quả). */
  score: number;
  /** Vì sao hit: tên khớp query / import / call / PageRank cao. */
  reasons: string[];
}

/** Kết quả query repo map. */
export interface V8RepoQueryResult {
  query: string;
  symbols: V8RepoQueryHit[];
  files: V8RepoQueryHit[];
  /** Tổng số node đã xét. */
  nodesConsidered: number;
}

/** Một lần đổi file trong refactor plan. */
export interface V8FileChange {
  /** Path repo-relative. */
  path: string;
  /** Nội dung mới đầy đủ (sau đổi). */
  newContent: string;
  /** Nội dung cũ (đọc lúc plan; null = file mới). */
  oldContent: string | null;
  /** SHA-256 of the file contents at plan time (null means it did not exist). */
  baseHash: string | null;
  /** Mô tả đổi gì ở file này (một dòng). */
  description: string;
  /** Số dòng thêm / xóa so với nội dung cũ (tính lúc plan). */
  linesAdded: number;
  linesRemoved: number;
}

/** Plan refactor multi-file. */
export interface V8RefactorPlan {
  /** Id duy nhất của plan. */
  id: string;
  /** Tiêu đề plan. */
  title: string;
  /** Mô tả mục tiêu refactor. */
  goal: string;
  /** Thời điểm tạo (ISO 8601). */
  createdAt: string;
  changes: V8FileChange[];
  /** Trạng thái hiện tại. */
  status: V8RefactorStatus;
  /** Lý do / ghi chú trạng thái (vd lý do rollback). */
  statusNote?: string;
}

/** Một hunk trong unified diff preview. */
export interface V8DiffHunk {
  file: string;
  /** Header dạng `@@ -a,b +c,d @@`. */
  header: string;
  /** Dòng diff: bắt đầu bằng ` ` / `+` / `-` / `\`. */
  lines: string[];
}

/** Preview diff của một plan. */
export interface V8DiffPreview {
  planId: string;
  /** Diff dạng unified, gộp mọi file. */
  unifiedDiff: string;
  hunks: V8DiffHunk[];
  filesChanged: number;
  linesAdded: number;
  linesRemoved: number;
}

/** Kết quả apply một file trong plan. */
export interface V8ApplyFileResult {
  path: string;
  applied: boolean;
  /** Path backup (repo-relative trong backup dir), null khi file mới. */
  backupPath: string | null;
  /** Lỗi (nếu có). */
  error?: string;
}

/** Kết quả apply cả plan. */
export interface V8ApplyResult {
  planId: string;
  files: V8ApplyFileResult[];
  /** true = mọi file đều apply được. */
  ok: boolean;
  /** Thư mục chứa backup (tuyệt đối). */
  backupDir: string;
}

/** Kết quả verify sau apply. */
export interface V8VerifyResult {
  planId: string;
  /** Tên bước verify, vd `typecheck` / `tests`. */
  step: string;
  ok: boolean;
  /** Thời gian chạy, ms. */
  durationMs: number;
  /** Output đã cắt ngắn (đã redact secret). */
  output: string;
  /** true = đã rollback vì verify fail. */
  rolledBack: boolean;
}

/** Một test case đã sinh cho một function. */
export interface V8GeneratedTestCase {
  /** Tên test, vd `sum_range returns 15 for n=5`. */
  name: string;
  /** Code gọi hàm (thân test, không gồm wrapper test()). */
  body: string;
  /** Loại case: happy / edge / error. */
  kind: 'happy' | 'edge' | 'error';
  /** Giá trị / input đã suy ra (ghi chú cho user review). */
  rationale: string;
}

/** Kết quả sinh test cho một file. */
export interface V8GeneratedTestFile {
  /** Path file test sẽ ghi (repo-relative). */
  testPath: string;
  /** Path file nguồn được test. */
  sourcePath: string;
  /** Nội dung file test đã sinh. */
  content: string;
  /** true = test sinh ra, cần user review trước khi tin. */
  generated: true;
  /** Số test case sinh ra. */
  cases: V8GeneratedTestCase[];
  /** Function đã có test sinh ra (qualified name). */
  functionsCovered: string[];
  /** Function export nhưng KHÔNG sinh được test (lý do trong `uncoveredReasons`). */
  functionsUncovered: string[];
  uncoveredReasons: Record<string, string>;
}

/** Kết quả chạy test đã sinh. */
export interface V8TestRunResult {
  testPath: string;
  /** true = mọi test sinh ra đều pass. */
  passed: boolean;
  total: number;
  passedCount: number;
  failedCount: number;
  /** Thời gian chạy, ms. */
  durationMs: number;
  /** Output node --test đã cắt ngắn. */
  output: string;
  /** Tên test fail (nếu có). */
  failedNames: string[];
}

/** Function-coverage delta sau khi sinh test. */
export interface V8CoverageDelta {
  sourcePath: string;
  /** Số function export của file nguồn. */
  totalFunctions: number;
  /** Số function đã có test TRƯỚC khi sinh (đếm theo tên trong test cũ). */
  coveredBefore: number;
  /** Số function có test SAU khi sinh (test cũ + test sinh ra). */
  coveredAfter: number;
  /** Delta = coveredAfter - coveredBefore. */
  delta: number;
  /** Tỉ lệ cover sau sinh, 0..1. */
  coverageAfter: number;
}

/** Nguồn taint: dữ liệu không tin cậy đi vào code. */
export type V8TaintSourceKind =
  | 'user-input'
  | 'env-var'
  | 'file-read'
  | 'network-read'
  | 'cli-arg'
  | 'request-body';

/** Sink taint: nơi dữ liệu nguy hiểm nếu tới được. */
export type V8TaintSinkKind = 'exec' | 'eval' | 'file-write' | 'network-send' | 'sql' | 'redirect';

/** Một luồng taint source → sink đã phát hiện. */
export interface V8TaintFlow {
  source: { kind: V8TaintSourceKind; name: string; line: number; file: string };
  sink: { kind: V8TaintSinkKind; name: string; line: number; file: string };
  /** Chuỗi biến trung gian (tên biến theo thứ tự lan truyền). */
  via: string[];
  /** Mức: block khi sink là exec/eval, warn khi còn lại. */
  level: V8SecurityLevel;
  /** Mô tả một dòng. */
  message: string;
}

/** Một secret nghi ngờ tìm được trong code. */
export interface V8SecretFinding {
  /** Loại secret, vd `aws-access-key` / `generic-api-key` / `high-entropy`. */
  kind: string;
  file: string;
  line: number;
  /** Mức: block khi pattern chắc chắn, warn khi chỉ entropy cao. */
  level: V8SecurityLevel;
  /** Entropy Shannon của token (khi tính được). */
  entropy?: number;
  /** Đoạn khớp ĐÃ REDACT — không bao giờ chứa giá trị thật. */
  redactedMatch: string;
}

/** Một dependency có CVE pattern nội bộ khớp. */
export interface V8DependencyFinding {
  packageName: string;
  installedVersion: string;
  /** Pattern CVE nội bộ đã khớp, vd `CVE-2026-0001 (lodash < 4.17.22)`. */
  cvePattern: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  level: V8SecurityLevel;
  /** Gợi ý khắc phục (vd phiên bản an toàn tối thiểu). */
  fix: string;
}

/** Báo cáo đầy đủ của security analyzer v2 cho một lần quét. */
export interface V8SecurityReport {
  /** Thời điểm quét (ISO 8601). */
  at: string;
  filesScanned: number;
  taintFlows: V8TaintFlow[];
  secrets: V8SecretFinding[];
  dependencies: V8DependencyFinding[];
  /** Mức tổng hợp: block > warn > allow. */
  level: V8SecurityLevel;
  /** Tóm tắt một dòng. */
  summary: string;
}

/** Quyết định của sandbox policy cho một action CodeAct v4. */
export type V8PolicyDecision = 'allow' | 'deny';

/** Lý do policy deny (khi deny). */
export interface V8PolicyDenial {
  /** Mã rule policy, vd `V8POL-CMD-NOT-ALLOWED`. */
  ruleId: string;
  message: string;
}

/** Action CodeAct v4 (nối V7Action: bash/python/edit/read + script nhiều bước). */
export type V8CodeActAction = V8BashAction | V8PythonAction | V8EditAction | V8ReadAction | V8ScriptAction;

/** Chạy lệnh shell (qua policy allowlist). */
export interface V8BashAction {
  kind: 'bash';
  command: string;
  timeoutMs?: number;
}

/** Chạy code Python (qua `python3 -`). */
export interface V8PythonAction {
  kind: 'python';
  code: string;
  timeoutMs?: number;
}

/** Ghi/sửa file trong workspace. */
export interface V8EditAction {
  kind: 'edit';
  path: string;
  content: string;
  mode: 'write' | 'append';
}

/** Đọc file trong workspace. */
export interface V8ReadAction {
  kind: 'read';
  path: string;
  maxLines?: number;
}

/** Chạy nhiều bước bash/python liên tiếp, dừng ở lỗi đầu (mặc định). */
export interface V8ScriptAction {
  kind: 'script';
  steps: Array<{ kind: 'bash' | 'python'; code: string; timeoutMs?: number }>;
  stopOnFailure?: boolean;
}

/** Observation chuẩn hóa của CodeAct v4. */
export interface V8Observation {
  /** Action đã chạy (echo lại để replay). */
  action: V8CodeActAction;
  /** true = chạy thành công (exit 0 / edit ok). */
  ok: boolean;
  /** stdout đã chuẩn hóa: cắt ngắn + redact secret + trim. */
  stdout: string;
  /** stderr đã chuẩn hóa. */
  stderr: string;
  /** Exit code (null khi không áp dụng). */
  exitCode: number | null;
  /** True khi bị kill vì quá timeout. */
  timedOut: boolean;
  /** True khi bị policy/security chặn nên KHÔNG chạy. */
  blocked: boolean;
  /** Lý do chặn (khi blocked). */
  blockReason?: string;
  /** Quyết định policy. */
  policy: V8PolicyDecision;
  /** Denial của policy (khi deny). */
  policyDenial?: V8PolicyDenial;
  /** Mức security v2 của action (allow/warn/block). */
  securityLevel: V8SecurityLevel;
  /** Thời gian chạy, ms. */
  durationMs: number;
  /** File đã ghi (chỉ kind edit thành công). */
  fileWritten?: { path: string; bytes: number };
  /** Kết quả từng bước (chỉ kind script). */
  stepResults?: Array<{ index: number; ok: boolean; stdout: string; stderr: string; exitCode: number | null; timedOut: boolean }>;
}

/** Kết quả một step của agent v8. */
export interface V8StepReport {
  step: string;
  ok: boolean;
  detail: string;
  /** Số liệu kèm theo (vd số symbol, số file, pass rate). */
  metrics?: Record<string, number>;
}

/** Kết quả pipeline coding task của agent v8. */
export interface V8TaskReport {
  /** Id session (log v7). */
  sessionId: string;
  title: string;
  /** true = pipeline chạy tới cuối (refactor đã verify). */
  finished: boolean;
  /** true = đang chờ user approve refactor plan. */
  awaitingApproval: boolean;
  /** true = đã rollback vì verify fail. */
  rolledBack: boolean;
  steps: V8StepReport[];
  /** Plan refactor (khi đã tới bước plan). */
  plan?: V8RefactorPlan;
  /** Báo cáo security v2 (khi đã quét). */
  security?: V8SecurityReport;
  /** Kết quả chạy test sinh ra (khi đã sinh + chạy). */
  testRun?: V8TestRunResult;
  /** Coverage delta (khi đã sinh test). */
  coverage?: V8CoverageDelta;
  /** Lỗi pipeline (nếu có). */
  error?: string;
}

/** Model generator do host tiêm (giống v7, dùng cho agent v8 khi cần). */
export type V8ModelGenerator = (input: { prompt: string; task: string; repoContext: string }) => Promise<string> | string;

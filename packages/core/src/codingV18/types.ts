/**
 * Coding agent v18 — types (v1.40, Đội T4).
 *
 * Ý tưởng học từ survey v140 §6 (Large Codebase SDK + verification
 * stack 2026): critic model chấm trajectory trước khi push; review
 * skill tự động trên mỗi PR/diff; dependency map toàn repo với thứ tự
 * sửa topo + vùng sở hữu; eval harness chạy nhiều verifier trên cùng
 * task để so sánh. Thiết kế và code là của open-bot (không copy repo
 * khác, không gọi model thật — critic/review/depmap ở đây là scorer
 * xác định dựa trên dữ liệu đo được, host có thể thay bằng model
 * critic thật sau này qua cùng interface; nối coding agent v17,
 * không viết lại trajectory log / repo map / eval gate của v17).
 */

export class CodingV18Error extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CodingV18Error';
  }
}

/** Một bước trong trajectory đưa cho critic v18 chấm. */
export type V18TrajectoryStepKind =
  | 'prompt'
  | 'plan'
  | 'search'
  | 'read'
  | 'bash'
  | 'file_write'
  | 'file_edit'
  | 'test'
  | 'test_result'
  | 'compiler_error'
  | 'error'
  | 'review'
  | 'other';

export interface V18TrajectoryStep {
  kind: V18TrajectoryStepKind;
  /** Mô tả bước / nội dung lệnh / nội dung file (dùng để quét safety). */
  text?: string;
  /** File bước này chạm tới (để chấm completeness / focus). */
  files?: string[];
  /** Exit code (bash / test). */
  exitCode?: number;
  /** Test có pass không (khi kind=test_result). */
  passed?: boolean;
  /** Thời gian bước chạy (ms). */
  durationMs?: number;
}

/** Một trục chấm của critic. */
export interface V18CriticDimension {
  name: 'completeness' | 'efficiency' | 'errorRecovery' | 'safety' | 'testCoverage';
  score: number;
  weight: number;
  reasons: string[];
}

export type V18CriticVerdictKind = 'approve' | 'request-changes' | 'block';

/** Cấu hình critic: ngưỡng + trọng số từng trục (cấu hình được). */
export interface V18CriticConfig {
  /** Điểm tổng >= ngưỡng này => approve (mặc định 70). */
  approveScore: number;
  /** Điểm tổng < ngưỡng này => block + chặn push (mặc định 40). */
  blockScore: number;
  /** Trọng số từng trục; thiếu trục nào dùng mặc định. */
  weights?: Partial<Record<V18CriticDimension['name'], number>>;
  /** Tắt hẳn một trục (không tính vào điểm tổng). */
  disabledDimensions?: V18CriticDimension['name'][];
}

export const V18_CRITIC_DEFAULT_WEIGHTS: Record<V18CriticDimension['name'], number> = {
  completeness: 0.3,
  efficiency: 0.2,
  errorRecovery: 0.2,
  safety: 0.2,
  testCoverage: 0.1,
};

export const V18_DEFAULT_CRITIC_CONFIG: V18CriticConfig = {
  approveScore: 70,
  blockScore: 40,
  weights: { ...V18_CRITIC_DEFAULT_WEIGHTS },
  disabledDimensions: [],
};

/** Kết quả chấm của critic (trajectory hoặc patch). */
export interface V18CriticVerdict {
  target: 'trajectory' | 'patch';
  sessionId?: string;
  score: number;
  verdict: V18CriticVerdictKind;
  /** true khi verdict=block: chặn push / chặn trình patch. */
  blocked: boolean;
  threshold: { approveScore: number; blockScore: number };
  dimensions: V18CriticDimension[];
  reasons: string[];
  scoredAt: number;
}

/** Một dòng lịch sử chấm critic (lưu append-only, giữ tối đa N dòng). */
export interface V18CriticHistoryEntry {
  id: string;
  sessionId: string;
  target: 'trajectory' | 'patch';
  score: number;
  verdict: V18CriticVerdictKind;
  blocked: boolean;
  reason: string;
  at: number;
}

export interface V18CriticHistoryStats {
  total: number;
  approved: number;
  requestChanges: number;
  blocked: number;
  averageScore: number;
  lowestScore: number;
  highestScore: number;
}

export type V18ReviewSeverity = 'error' | 'warning' | 'info';

/** Một finding của review skill. */
export interface V18ReviewFinding {
  id: string;
  rule: string;
  severity: V18ReviewSeverity;
  file: string;
  line?: number;
  message: string;
  suggestion: string;
  /** Gợi ý sửa tự động (mô tả, không tự áp dụng). */
  autoFix?: string;
}

/** Một rule của review skill v18. */
export interface V18ReviewRule {
  id: string;
  severity: V18ReviewSeverity;
  title: string;
  description: string;
}

/** Kết quả review skill trên một patch/diff. */
export interface V18ReviewReport {
  verdict: 'pass' | 'fail';
  findings: V18ReviewFinding[];
  errorCount: number;
  warningCount: number;
  infoCount: number;
  filesReviewed: number;
  linesReviewed: number;
  rulesRun: string[];
  checkedAt: number;
}

/** Review trên PR: report + tóm tắt đăng PR + gate. */
export interface V18PrReview {
  report: V18ReviewReport;
  /** true khi PR được phép merge theo gate (không có error). */
  mergeable: boolean;
  summary: string;
  /** Danh sách rule đã tắt (nếu có). */
  disabledRules: string[];
}

/** Kết quả áp auto-fix lên patch. */
export interface V18AutoFixResult {
  /** Patch sau khi sửa (map path -> nội dung mới). */
  patch: Record<string, string>;
  /** Finding id đã sửa xong. */
  applied: string[];
  /** Finding id có autoFix mô tả nhưng chưa áp được (kèm lý do). */
  skipped: { findingId: string; reason: string }[];
}

/** Preset cấu hình critic theo tên. */
export type V18CriticPresetName = 'strict' | 'balanced' | 'lenient';

/** Thống kê đồ thị phụ thuộc. */
export interface V18DepGraphStats {
  fileCount: number;
  edgeCount: number;
  cycleCount: number;
  averageFanOut: number;
  averageFanIn: number;
  maxFanOut: { file: string; count: number };
  maxFanIn: { file: string; count: number };
  entryPoints: number;
  leafModules: number;
}

/** Node trong đồ thị phụ thuộc. */
export interface V18DepNode {
  path: string;
  kind: 'source' | 'test' | 'config' | 'other';
  imports: string[];
  importedBy: string[];
  /** Độ sâu dài nhất từ node gốc (file không bị import). */
  depth: number;
}

export type V18DepEdgeKind = 'import' | 'dynamic' | 'type';

export interface V18DepEdge {
  from: string;
  to: string;
  kind: V18DepEdgeKind;
}

/** Đồ thị phụ thuộc toàn repo. */
export interface V18DepGraph {
  root: string;
  nodes: V18DepNode[];
  edges: V18DepEdge[];
  /** Mỗi cycle là một danh sách file khép kín (SCC > 1 node hoặc self-loop). */
  cycles: string[][];
  builtAt: number;
  fileCount: number;
  /** Import ra ngoài repo (bare specifier) — ghi nhận, không tạo node. */
  externalImports: string[];
}

/** Một tầng trong thứ tự topo (các file cùng tầng sửa song song được). */
export interface V18TopoLevel {
  level: number;
  files: string[];
}

/** Kế hoạch thứ tự sửa theo topo. */
export interface V18TopoPlan {
  /** Thứ tự sửa tuyến tính (dependency trước, dependent sau). */
  order: string[];
  levels: V18TopoLevel[];
  cycles: string[][];
  /** File nằm trong cycle: không có thứ tự an toàn, phải phá cycle trước. */
  blockedFiles: string[];
}

/** Một vùng sở hữu: nhóm file + owner + tiền tố đường dẫn. */
export interface V18OwnershipZone {
  id: string;
  name: string;
  owner: string;
  prefixes: string[];
  files: string[];
  fileCount: number;
}

/** Chia repo thành vùng sở hữu theo đồ thị. */
export interface V18ZonePlan {
  zones: V18OwnershipZone[];
  unassigned: string[];
}

export type V18ZoneConflictKind = 'cross-zone' | 'out-of-order' | 'cycle';

/** Xung đột vùng / thứ tự phát hiện trước khi sửa. */
export interface V18ZoneConflict {
  kind: V18ZoneConflictKind;
  files: string[];
  zoneA?: string;
  zoneB?: string;
  message: string;
}

export type V18VerifierName = 'critic' | 'review-skill' | 'dependency-map';

/** Kết quả một verifier chạy trên cùng task. */
export interface V18VerifierResult {
  verifier: V18VerifierName;
  passed: boolean;
  /** Điểm 0..100 khi verifier có chấm điểm (critic). */
  score?: number;
  details: string;
  durationMs: number;
  findings: string[];
}

/** So sánh 3 verifier trên cùng task. */
export interface V18EvalComparison {
  taskId: string;
  results: V18VerifierResult[];
  allPassed: boolean;
  passedCount: number;
  failedVerifiers: V18VerifierName[];
  summary: string;
  ranAt: number;
}

/** Xu hướng chất lượng theo lịch sử chấm critic (nửa đầu vs nửa sau). */
export interface V18CriticTrend {
  /** Số entry dùng để tính trend. */
  entries: number;
  /** Điểm trung bình nửa đầu lịch sử. */
  firstHalfAverage: number;
  /** Điểm trung bình nửa sau lịch sử. */
  lastHalfAverage: number;
  /** Chênh lệch (dương = chất lượng tăng). */
  delta: number;
  direction: 'improving' | 'declining' | 'stable';
}

/** Báo cáo eval suite: chạy comparison trên nhiều task, tổng hợp theo verifier. */
export interface V18EvalSuiteReport {
  taskIds: string[];
  comparisons: V18EvalComparison[];
  allPassed: boolean;
  passedTasks: number;
  totalTasks: number;
  /** Tỉ lệ pass từng verifier trên toàn suite (0..1). */
  verifierPassRates: Record<V18VerifierName, number>;
  /** Task tệ nhất (ít verifier pass nhất, rồi điểm critic thấp nhất). */
  worstTaskId?: string;
  summary: string;
  ranAt: number;
}

/** Báo cáo verification stack v18 cho một phiên. */
export interface V18VerifyReport {
  sessionId: string;
  critic?: V18CriticVerdict;
  review?: V18ReviewReport;
  depmap?: { cycles: string[][]; conflicts: V18ZoneConflict[] };
  eval?: V18EvalComparison;
  allPassed: boolean;
  failingLayers: string[];
  /** true khi bất kỳ tầng nào block => chặn push. */
  blockedPush: boolean;
}

/** Một bước agent v18 (scripted, không gọi model thật). */
export interface V18AgentStep {
  text: string;
  bashCommand?: string;
  fileWrite?: { path: string; content: string; kind: 'create' | 'write' | 'edit'; oldText?: string };
  isTest?: boolean;
  done?: boolean;
}

export interface V18RunAgentInput {
  sessionId: string;
  task: string;
  botId: string;
  steps: V18AgentStep[];
  /** File repo để build dependency map (optional). */
  repoFiles?: Map<string, string>;
  /** File patch đã có sẵn (optional — mặc định lấy từ steps). */
  patch?: Record<string, string>;
  /** Ngưỡng critic (optional — mặc định 70/40). */
  criticConfig?: V18CriticConfig;
  /** Vùng sở hữu của agent này (optional — để kiểm tra xung đột). */
  agentZone?: string;
  /** Timestamp gốc (test dùng clock cố định). */
  now?: number;
}

/** Báo cáo chạy agent v18 end-to-end. */
export interface V18AgentReport {
  sessionId: string;
  task: string;
  stepsRun: number;
  filesTouched: string[];
  critic: V18CriticVerdict;
  review: V18ReviewReport;
  depConflicts: V18ZoneConflict[];
  verification: V18VerifyReport;
  presentable: boolean;
  summary: string;
}

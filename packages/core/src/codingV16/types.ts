/**
 * Coding agent v16 (v1.38, Đội T4) — shared types.
 *
 * Học ý tưởng (chỉ học ý tưởng, không copy code/text/tài sản của bất
 * kỳ repo nào, của xAI/Cursor), từ nghiên cứu harness-cost trong
 * docs/repo-survey-v138.md §3 ("What Does a Harness Buy? Tokens,
 * Mostly", Liu & Han 03/10/2026; HarnessTax, Berkeley Sky Lab +
 * Arena; nghiên cứu Princeton/SWE-agent):
 *
 * - Đổi harness chỉ xê dịch điểm số trong biên nhiễu (~5 điểm; rerun
 *   cùng harness cũng lật ~13% task khó), nhưng chi phí/task chênh
 *   tới 3x (HarnessTax: tới 5x). Harness mua token, không mua điểm.
 * - Preamble call đầu: ~16.600 token (Claude Code) vs ~7.000
 *   (OpenCode) vs 829 (mini-SWE-agent) — preamble gọn là đòn bẩy
 *   chi phí lớn nhất, rẻ hơn mọi tối ưu khác.
 * - Ba quyết định giao diện có số đo: cửa sổ file 100 dòng (+5.3
 *   điểm), chỉ giữ 5 tool-output gần nhất trong history (+3), edit
 *   tool có linter chặn thay đổi sai cú pháp (+3).
 *
 * v16 biến ba phát hiện đó thành 6 lớp đo + chặn + tối giản, nối
 * trên coding agent v14 (condenser tăng dần, stuck detection v2,
 * reasoning-block persistence) thay vì viết lại:
 *
 *   1. `tokenBudget.ts`: TokenBudgetMeter — đo token/task, cảnh báo
 *      khi vượt ngân sách đặt trước, dự báo hết ngân sách.
 *   2. `harnessCost.ts`: HarnessCostEstimator — đo chi phí/task theo
 *      từng harness, báo cáo cost/accuracy trade-off (điểm vs $).
 *   3. `minimalHarness.ts`: MinimalHarness — vòng lặp bash-only,
 *      preamble gọn (mục tiêu < 1.000 token), không tool thừa.
 *   4. `fileWindow.ts`: FileWindowViewer — xem file theo cửa sổ
 *      100 dòng (phân trang nội dung file lớn).
 *   5. `editLinter.ts`: EditLinterGate — chặn thay đổi sai cú pháp
 *      trước khi ghi file (không ghi file lỗi).
 *   6. `historyTrimmer.ts`: HistoryTrimmer — cắt gọn lịch sử
 *      hội thoại/task khi vượt ngưỡng (giữ 5 tool-output gần nhất).
 *   7. `benchmark.ts`: benchmark nội bộ đo cost/accuracy trade-off
 *      trên task mẫu có script (không gọi model thật).
 *   8. `agent.ts`: CodingAgentV16 — pipeline nối 6 lớp trên.
 */

/** Lỗi riêng của coding agent v16. */
export class CodingV16Error extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'CodingV16Error';
    this.code = code;
  }
}

/** Mã lỗi dùng chung cho v16. */
export const V16_ERROR_CODES = [
  'budget-invalid',
  'budget-exceeded',
  'budget-not-found',
  'cost-invalid',
  'cost-unknown-harness',
  'cost-unknown-model',
  'harness-invalid',
  'harness-step-invalid',
  'window-invalid',
  'window-out-of-range',
  'lint-blocked',
  'lint-parse-failed',
  'trim-invalid',
  'benchmark-invalid',
  'benchmark-no-tasks',
  'agent-invalid',
  'agent-step-invalid',
] as const;

export type V16ErrorCode = (typeof V16_ERROR_CODES)[number];

/** Một lần tiêu thụ token (một model call, một step, một tool call). */
export interface V16TokenSample {
  /** Id task/run sở hữu sample. */
  taskId: string;
  /** Số thứ tự step trong task (0 = preamble). */
  step: number;
  /** Nhãn call: 'preamble' | 'model' | 'tool' | 'condense' | 'retry'. */
  kind: 'preamble' | 'model' | 'tool' | 'condense' | 'retry';
  /** Token prompt (input). */
  promptTokens: number;
  /** Token completion (output). */
  completionTokens: number;
  /** Model đã dùng (để tính tiền), vd 'claude-sonnet-4'. */
  model?: string;
  /** Harness đã chạy call này, vd 'minimal' | 'claude-code'. */
  harness?: string;
  /** Thời điểm ghi (ms epoch). */
  at: number;
}

/** Tổng token của một task (cộng dồn từ các sample). */
export interface V16TaskTokenTotal {
  taskId: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  samples: number;
  preambleTokens: number;
  firstAt: number;
  lastAt: number;
}

/** Ngân sách token cho một task / một run / toàn phiên. */
export interface V16TokenBudget {
  /** Id ngân sách (thường trùng taskId hoặc 'session'). */
  id: string;
  /** Giới hạn token tổng (prompt + completion). */
  limitTokens: number;
  /** Ngưỡng cảnh báo sớm: phần trăm limit (mặc định 80). */
  warnAtPercent?: number;
  /** Ngưỡng chặn cứng: phần trăm limit (mặc định 100). */
  blockAtPercent?: number;
  /** Ghi chú do người dùng đặt. */
  note?: string;
}

/** Trạng thái ngân sách sau khi cộng một sample. */
export interface V16BudgetStatus {
  budgetId: string;
  limitTokens: number;
  usedTokens: number;
  remainingTokens: number;
  usedPercent: number;
  /** 'ok' | 'warn' | 'blocked' (đã vượt blockAtPercent). */
  state: 'ok' | 'warn' | 'blocked';
  /** Dự báo: còn đủ cho khoảng bao nhiêu step nữa (theo trung bình/step). */
  projectedStepsLeft: number | null;
  /** Token trung bình mỗi step (null khi chưa có step nào). */
  avgTokensPerStep: number | null;
  /** Đã vượt limit tuyệt đối hay chưa. */
  overLimit: boolean;
}

/** Một harness đã biết (profile đo chi phí). */
export interface V16HarnessProfile {
  /** Id harness: 'minimal' | 'claude-code' | 'opencode' | 'mini-swe-agent' | tên tự đặt. */
  id: string;
  /** Tên hiển thị. */
  label: string;
  /** Token preamble call đầu (đo được hoặc ước tính từ nghiên cứu). */
  preambleTokens: number;
  /** Số tool tối đa harness phơi ra cho model. */
  toolCount: number;
  /** Mô tả ngắn cách harness làm việc. */
  description?: string;
}

/** Bảng giá model (USD / 1M token) để quy token ra tiền. */
export interface V16ModelPrice {
  model: string;
  /** USD / 1M prompt token. */
  inputPerMillion: number;
  /** USD / 1M completion token. */
  outputPerMillion: number;
}

/** Một lần chạy task đã đo xong (điểm + chi phí). */
export interface V16CostRecord {
  taskId: string;
  harnessId: string;
  model: string;
  /** Điểm task: 0..1 (1 = pass) hoặc điểm từng phần. */
  score: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** Chi phí USD tính từ bảng giá. */
  costUsd: number;
  /** Số step đã chạy. */
  steps: number;
  /** Task pass hay không (score >= passThreshold). */
  passed: boolean;
  /** Thời điểm kết thúc (ms epoch). */
  at: number;
  /** Ghi chú (vd 'rerun', 'flaky'). */
  note?: string;
}

/** So sánh cost/accuracy giữa các harness trên cùng bộ task. */
export interface V16HarnessComparison {
  harnessId: string;
  tasks: number;
  passRate: number;
  avgScore: number;
  avgTokensPerTask: number;
  avgCostPerTaskUsd: number;
  totalCostUsd: number;
  avgStepsPerTask: number;
  /** Điểm trên mỗi đô la (avgScore / avgCost) — cao = hiệu quả. */
  scorePerDollar: number | null;
  /** Token trung bình để đạt 1 điểm pass. */
  tokensPerPass: number | null;
}

/** Báo cáo trade-off đầy đủ (so sánh N harness). */
export interface V16CostAccuracyReport {
  generatedAt: number;
  taskIds: string[];
  harnessIds: string[];
  comparisons: V16HarnessComparison[];
  /** Harness rẻ nhất trên mỗi task pass. */
  cheapestPerPass: string | null;
  /** Harness có điểm trung bình cao nhất. */
  highestScore: string | null;
  /** Harness hiệu quả nhất (scorePerDollar cao nhất). */
  mostEfficient: string | null;
  /** Chênh lệch chi phí lớn nhất giữa 2 harness (tỉ lệ, vd 3.0 = 3x). */
  maxCostRatio: number | null;
  /** Chênh lệch điểm lớn nhất giữa 2 harness (điểm tuyệt đối). */
  maxScoreGap: number | null;
  /** Kết luận: chênh chi phí có vượt chênh điểm không (harness mua token). */
  verdict: string;
}

/** Chế độ minimal harness: vòng lặp bash-only, preamble gọn. */
export interface V16MinimalConfig {
  /** Token tối đa cho preamble (mặc định 1000). */
  maxPreambleTokens?: number;
  /** Số step tối đa (mặc định 20). */
  maxSteps?: number;
  /** Cửa sổ file mặc định (dòng) khi đọc file (mặc định 100). */
  fileWindowLines?: number;
  /** Số tool-output gần nhất giữ trong history (mặc định 5). */
  keepRecentToolOutputs?: number;
  /** Bật linter gate trước mỗi lần ghi file (mặc định true). */
  lintBeforeWrite?: boolean;
  /** Ngưỡng token history thì trim (mặc định 8000). */
  trimThresholdTokens?: number;
}

/** Một step của minimal harness (do script cung cấp — không bịa). */
export interface V16MinimalStep {
  /** Text model trả về ở step này. */
  text: string;
  /** Lệnh bash chạy ở step này (rỗng = không chạy). */
  bashCommand?: string;
  /** Kết quả bash (do script cung cấp, không chạy shell thật ở core). */
  bashOutput?: string;
  /** File ghi ở step này (đã qua linter gate trước khi áp). */
  fileWrite?: V16FileWrite;
  /** Step này hoàn thành task chưa. */
  done: boolean;
  /** Token tiêu thụ ở step này (đo được hoặc ước tính). */
  promptTokens?: number;
  completionTokens?: number;
  /** Ghi chú. */
  note?: string;
}

/** Một lần ghi/sửa file đã qua linter gate. */
export interface V16FileWrite {
  path: string;
  /** 'create' | 'write' (ghi đè) | 'edit' (thay đoạn). */
  kind: 'create' | 'write' | 'edit';
  /** Nội dung mới đầy đủ (write/create) hoặc đoạn mới (edit). */
  content: string;
  /** Với edit: đoạn cũ cần thay (phải khớp đúng 1 lần). */
  oldText?: string;
}

/** Kết quả chạy minimal harness. */
export interface V16MinimalRunReport {
  runId: string;
  prompt: string;
  stepsRun: number;
  done: boolean;
  preambleTokens: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** Số lần linter chặn ghi file. */
  lintBlocks: number;
  /** Số lần history bị trim trong run. */
  trims: number;
  /** Số file đã ghi thành công. */
  filesWritten: string[];
  /** Transcript gọn (text + bash output từng step). */
  transcript: string[];
  /** Token tiết kiệm ước tính so với preamble đầy đủ 16.600 token. */
  preambleSavedVsFull: number;
}

/** Một cửa sổ (trang) của file lớn. */
export interface V16FileWindow {
  path: string;
  /** Dòng bắt đầu (1-based). */
  startLine: number;
  /** Dòng kết thúc (1-based, đã bao gồm). */
  endLine: number;
  /** Tổng số dòng của file. */
  totalLines: number;
  /** Số dòng mỗi cửa sổ. */
  windowLines: number;
  /** Số trang (cửa sổ) tổng cộng. */
  totalPages: number;
  /** Trang hiện tại (1-based). */
  page: number;
  /** Nội dung các dòng trong cửa sổ (không có số dòng). */
  lines: string[];
  /** Nội dung có đánh số dòng (định dạng "  12| ..."). */
  numbered: string;
}

/** Một vấn đề cú pháp linter tìm thấy. */
export interface V16LintIssue {
  /** 'error' (chặn ghi) | 'warning' (cho qua, vẫn ghi). */
  severity: 'error' | 'warning';
  /** Mã: 'unbalanced-delimiter' | 'json-invalid' | ... */
  code: string;
  message: string;
  /** Dòng (1-based) nếu xác định được. */
  line?: number;
  /** Cột (1-based) nếu xác định được. */
  column?: number;
}

/** Kết quả linter gate cho một lần ghi file. */
export interface V16LintResult {
  path: string;
  /** Ngôn ngữ suy ra từ đuôi file ('ts' | 'js' | 'json' | ...). */
  language: string;
  issues: V16LintIssue[];
  /** true = có lỗi error → CHẶN ghi. */
  blocked: boolean;
  /** Số lỗi error / warning. */
  errorCount: number;
  warningCount: number;
  /** Tóm tắt 1 dòng. */
  summary: string;
}

/** Một entry trong lịch sử hội thoại/task (để trim). */
export interface V16HistoryEntry {
  /** Id entry (duy nhất trong run). */
  id: string;
  /** 'user' | 'model' | 'tool' | 'system' | 'summary'. */
  role: 'user' | 'model' | 'tool' | 'system' | 'summary';
  /** Nội dung text. */
  text: string;
  /** Token ước tính của entry (đo bằng estimator, không đếm bằng model). */
  tokens: number;
  /** Số thứ tự (tăng dần). */
  seq: number;
  /** Thời điểm tạo (ms epoch). */
  at: number;
  /** true = không bao giờ trim (system prompt, quyết định đã chốt). */
  pinned?: boolean;
  /** Tên tool (khi role = 'tool'). */
  toolName?: string;
}

/** Chính sách trim lịch sử. */
export interface V16TrimPolicy {
  /** Ngưỡng token: trim khi history vượt số này. */
  maxTokens: number;
  /** Số tool-output gần nhất luôn giữ (mặc định 5 — theo nghiên cứu). */
  keepRecentToolOutputs?: number;
  /** Số entry model/user gần nhất luôn giữ (mặc định 4). */
  keepRecentEntries?: number;
  /** Có thay phần đã cắt bằng 1 summary entry không (mặc định true). */
  summarizeTrimmed?: boolean;
  /** Token tối đa của summary entry thay thế (mặc định 300). */
  summaryMaxTokens?: number;
}

/** Kết quả một lần trim. */
export interface V16TrimResult {
  beforeEntries: number;
  afterEntries: number;
  beforeTokens: number;
  afterTokens: number;
  trimmedEntries: number;
  tokensSaved: number;
  /** true = đã thay phần cắt bằng summary entry. */
  summarized: boolean;
  summaryText: string | null;
}

/** Một task mẫu cho benchmark nội bộ (scripted, không gọi model). */
export interface V16BenchmarkTask {
  /** Id task mẫu. */
  id: string;
  /** Mô tả task. */
  prompt: string;
  /** Script step cho từng harness (harnessId -> steps). */
  scripts: Record<string, V16MinimalStep[]>;
  /** Điểm pass khi script chạy xong (do script quyết — không bịa). */
  expectedScore: number;
  /** Ngưỡng pass (mặc định 1 = phải đúng hoàn toàn). */
  passThreshold?: number;
}

/** Kết quả benchmark nội bộ (cost/accuracy trade-off). */
export interface V16BenchmarkReport {
  generatedAt: number;
  harnessIds: string[];
  taskIds: string[];
  /** Báo cáo cost/accuracy (tái dùng từ harnessCost). */
  costAccuracy: V16CostAccuracyReport;
  /** Tổng token preamble từng harness (đo được). */
  preambleTokensByHarness: Record<string, number>;
  /** Kết luận ngắn. */
  verdict: string;
}

/** Trạng thái resume của CodingAgentV16. */
export interface V16AgentState {
  runId: string;
  prompt: string;
  stepsRun: number;
  done: boolean;
  totalTokens: number;
  budget: V16BudgetStatus | null;
  filesWritten: string[];
  lintBlocks: number;
  trims: number;
}

/** Báo cáo chạy CodingAgentV16 end-to-end. */
export interface V16AgentReport {
  runId: string;
  prompt: string;
  stepsRun: number;
  done: boolean;
  minimal: V16MinimalRunReport;
  budget: V16BudgetStatus | null;
  cost: V16CostRecord | null;
  trims: V16TrimResult[];
  /** Tóm tắt 1 đoạn. */
  summary: string;
}

/** Mặc định chung cho v16. */
export const V16_DEFAULTS = {
  /** Ngưỡng cảnh báo ngân sách: 80%. */
  warnAtPercent: 80,
  /** Ngưỡng chặn ngân sách: 100%. */
  blockAtPercent: 100,
  /** Cửa sổ file mặc định: 100 dòng (+5.3 điểm theo nghiên cứu). */
  fileWindowLines: 100,
  /** Tool-output gần nhất giữ trong history: 5 (+3 điểm). */
  keepRecentToolOutputs: 5,
  /** Preamble tối đa minimal harness: 1000 token (mục tiêu < 1000). */
  maxPreambleTokens: 1000,
  /** Preamble "đầy đủ" tham chiếu (Claude Code ~16.600 token). */
  fullPreambleTokens: 16600,
  /** Ngưỡng trim history mặc định: 8000 token. */
  trimThresholdTokens: 8000,
  /** Ký tự ≈ 1 token (ước tính heuristic, không đếm bằng model). */
  charsPerToken: 4,
} as const;

/** Bảng giá mặc định (USD/1M token) cho vài model phổ biến — ước tính công khai, chỉnh được. */
export const V16_DEFAULT_MODEL_PRICES: V16ModelPrice[] = [
  { model: 'claude-sonnet-4', inputPerMillion: 3, outputPerMillion: 15 },
  { model: 'claude-opus-4', inputPerMillion: 15, outputPerMillion: 75 },
  { model: 'gpt-5', inputPerMillion: 5, outputPerMillion: 15 },
  { model: 'gemini-2.5-flash', inputPerMillion: 0.3, outputPerMillion: 2.5 },
  { model: 'gemini-2.5-pro', inputPerMillion: 1.25, outputPerMillion: 10 },
  { model: 'grok-4', inputPerMillion: 3, outputPerMillion: 15 },
];

/** Profile harness mặc định (preamble đo được từ nghiên cứu — xem header file). */
export const V16_DEFAULT_HARNESS_PROFILES: V16HarnessProfile[] = [
  { id: 'minimal', label: 'Minimal (bash-only)', preambleTokens: 829, toolCount: 3, description: 'Vòng lặp bash-only, preamble gọn — baseline rẻ nhất.' },
  { id: 'mini-swe-agent', label: 'mini-SWE-agent', preambleTokens: 829, toolCount: 4, description: 'Harness tối giản tham chiếu trong nghiên cứu (preamble 829 token).' },
  { id: 'opencode', label: 'OpenCode', preambleTokens: 7000, toolCount: 12, description: 'Preamble ~7.000 token theo nghiên cứu.' },
  { id: 'claude-code', label: 'Claude Code', preambleTokens: 16600, toolCount: 24, description: 'Preamble ~16.600 token theo nghiên cứu.' },
];

/**
 * Coding agent v15 (v1.37, Đội T4) — shared types.
 *
 * Học ý tưởng (chỉ học ý tưởng, không copy code/text/tài sản của bất
 * kỳ repo nào):
 * - Agent profiles (persona + tool set + model theo profile, kiểu
 *   các coding agent có "mode" / "agent" riêng: reviewer khác
 *   implementer khác planner): một run luôn chạy dưới đúng một
 *   profile; profile quyết định system prompt, tool được phép dùng
 *   và model mặc định. Profile nào expose qua ACP thì hiển thị nhãn
 *   `ACP` để host ACP phân biệt được.
 * - Budget meter CHỈ-BÁO-CÁO (report-only): khác limiter ở chỗ vượt
 *   cap vẫn chạy — meter chỉ đo, ước tính chi phí và cảnh báo. Ý
 *   tưởng từ các budget meter của coding agent v12: ngưỡng 80% /
 *   100%, lịch sử theo run/bot, cost ước lượng qua bảng giá.
 * - Hooks dialog: stop hook của agent thường chèn feedback vào
 *   luồng chat làm loãng hội thoại; v15 giữ feedback ngoài chat —
 *   hiển thị trong dialog riêng, người dùng xem / xác nhận / bỏ qua
 *   từ dialog, luồng chat không bị chèn thêm message.
 * - Verify scenarios vượt happy path: một agent chỉ test đường
 *   hạnh phúc thì chưa đủ tin; v15 định nghĩa bộ scenario kiểm
 *   chứng (lỗi tool, timeout, output sai định dạng, xung đột file,
 *   test fail giữa chừng...) mỗi scenario có kỳ vọng rõ ràng và
 *   chạy được, báo cáo pass/fail từng scenario.
 *
 * v15 NỐI các tầng đã có (không viết lại): coding agent v14 (agent
 * pipeline + reasoning blocks + stuck recovery), budget meter v12
 * (ý tưởng ngưỡng + cost), ACP registry (profile expose qua ACP).
 * v15 thêm 5 lớp mới (mỗi lớp một file):
 *
 *   1. `profiles.ts`: store profile (CRUD + file JSON, built-in,
 *      validate, apply cho run, nhãn ACP).
 *   2. `budget.ts`: budget meter chỉ-báo-cáo (token + cost ước
 *      tính so với cap, ngưỡng 80%/100%, lịch sử run/bot, không
 *      bao giờ chặn run).
 *   3. `hooksDialog.ts`: dialog nhận feedback của stop hook ngoài
 *      chat (queue, confirm/dismiss/snooze, persistence JSON).
 *   4. `verifyScenarios.ts`: catalog scenario + runner kiểm chứng
 *      (kỳ vọng rõ ràng từng scenario, báo cáo pass/fail).
 *   5. `agent.ts`: pipeline nối 4 lớp trên (profile + budget +
 *      hooks dialog + verify, chạy scripted, không gọi model thật).
 */

/** Lỗi riêng của coding agent v15. */
export class CodingV15Error extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'CodingV15Error';
    this.code = code;
  }
}

/** Mã lỗi dùng chung cho v15. */
export const V15_ERROR_CODES = [
  'profile-invalid',
  'profile-not-found',
  'profile-duplicate',
  'profile-builtin-readonly',
  'profile-apply-invalid',
  'budget-invalid',
  'budget-record-invalid',
  'hooks-invalid',
  'hooks-feedback-not-found',
  'hooks-dialog-invalid',
  'verify-invalid',
  'verify-scenario-not-found',
  'verify-runner-invalid',
  'agent-plan-invalid',
  'agent-step-invalid',
  'agent-run-invalid',
] as const;
export type V15ErrorCode = (typeof V15_ERROR_CODES)[number];

/* ================================================================== */
/* Agent profiles                                                      */
/* ================================================================== */

/** Kind của profile — quyết định persona + tool set mặc định. */
export type V15ProfileKind =
  | 'general'
  | 'reviewer'
  | 'planner'
  | 'fixer'
  | 'explorer'
  | 'custom';

export const V15_PROFILE_KINDS: readonly V15ProfileKind[] = [
  'general',
  'reviewer',
  'planner',
  'fixer',
  'explorer',
  'custom',
] as const;

/** Một agent profile: persona + tool set + model theo profile. */
export interface V15AgentProfile {
  /** Id ổn định, slug lowercase `[a-z0-9][a-z0-9-]*`. */
  id: string;
  /** Tên hiển thị (không rỗng). */
  name: string;
  kind: V15ProfileKind;
  /** Mô tả ngắn cho UI / ACP listing. */
  description: string;
  /** Persona: 1-3 câu mô tả vai trò, giọng điệu, cách làm việc. */
  persona: string;
  /** System prompt đầy đủ mà profile chèn vào run (có thể rỗng — khi đó dùng persona). */
  systemPrompt: string;
  /** Model mặc định của profile (vd `gpt-5`, `claude-opus-4-6`); rỗng = dùng model của bot/run. */
  model: string;
  /** Tool được phép dùng (tên tool trong registry). Rỗng = mọi tool. */
  allowedTools: string[];
  /** Tool bị cấm dù có trong allowedTools (deny thắng allow). */
  deniedTools: string[];
  /** Số step tối đa của run dùng profile này (mặc định 20). */
  maxSteps: number;
  /** Temperature gợi ý (0..2); undefined = mặc định của model. */
  temperature?: number;
  /** true = profile expose qua ACP (UI hiển thị nhãn `ACP`). */
  exposeViaAcp: boolean;
  /** true = profile built-in của v15, không sửa/xóa (chỉ clone). */
  builtin: boolean;
  /** Thời điểm tạo (ISO 8601). */
  createdAt: string;
  /** Thời điểm sửa lần cuối (ISO 8601). */
  updatedAt: string;
  /** Version của profile (tăng mỗi lần update). */
  version: number;
}

/** Input khi tạo profile mới (store tự điền id mặc định/createdAt/version). */
export interface V15NewProfile {
  id?: string;
  name: string;
  kind?: V15ProfileKind;
  description?: string;
  persona: string;
  systemPrompt?: string;
  model?: string;
  allowedTools?: string[];
  deniedTools?: string[];
  maxSteps?: number;
  temperature?: number;
  exposeViaAcp?: boolean;
}

/** Patch khi sửa profile (chỉ field có mặt mới đổi). */
export interface V15ProfileUpdate {
  name?: string;
  kind?: V15ProfileKind;
  description?: string;
  persona?: string;
  systemPrompt?: string;
  model?: string;
  allowedTools?: string[];
  deniedTools?: string[];
  maxSteps?: number;
  temperature?: number | null;
  exposeViaAcp?: boolean;
}

/** Kết quả áp profile cho một run. */
export interface V15ProfileApplyResult {
  profile: V15AgentProfile;
  /** System prompt cuối cùng đưa vào run (persona + tool note + model note). */
  systemPrompt: string;
  /** Tool thật sự được phép sau khi trừ deniedTools. */
  effectiveTools: string[];
  /** Model của run (profile.model hoặc fallback). */
  model: string;
  /** Nhãn hiển thị trong ACP listing (`<name> [ACP]` khi expose). */
  acpDisplayName: string;
  /** true khi profile expose qua ACP. */
  exposedViaAcp: boolean;
}

/* ================================================================== */
/* Budget meter (report-only)                                          */
/* ================================================================== */

/** Cap của meter: token cap và/hoặc cost cap (USD). Rỗng = không cap. */
export interface V15BudgetCap {
  maxTokens?: number;
  maxCostUsd?: number;
}

/** Một lần ghi nhận tiêu thụ (một step / một lần gọi model). */
export interface V15UsageRecord {
  runId: string;
  botId: string;
  profileId: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  /** Chi phí USD ước tính (null khi model không có giá — không báo $0). */
  costUsd: number | null;
  /** true khi token là ước lượng (chars/4), không phải số model báo. */
  tokensEstimated: boolean;
  /** Step trong run (0-based). */
  step: number;
  /** Thời điểm ghi (ISO 8601). */
  at: string;
}

/** Input khi ghi nhận tiêu thụ (meter tự tính cost + at). */
export interface V15NewUsage {
  runId: string;
  botId?: string;
  profileId?: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  /** Chi phí thật nếu host biết (vd model local miễn phí → 0); không đưa = ước lượng qua bảng giá. */
  costUsd?: number | null;
  tokensEstimated?: boolean;
  step?: number;
  at?: string;
}

/** Mức cảnh báo của meter. */
export type V15BudgetWarningLevel = 'info' | 'warn80' | 'over100';

/** Một cảnh báo đã phát (mỗi ngưỡng phát đúng một lần mỗi run). */
export interface V15BudgetWarning {
  level: V15BudgetWarningLevel;
  /** Chiều bị vượt: 'tokens' | 'cost'. */
  dimension: 'tokens' | 'cost';
  /** Phần trăm đã dùng so với cap tại lúc phát. */
  percent: number;
  message: string;
  at: string;
}

/** Trạng thái meter của một run. */
export interface V15BudgetState {
  runId: string;
  botId: string;
  profileId: string;
  model: string;
  cap: V15BudgetCap;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  /** Tổng chi phí USD ước tính (null khi chưa có record nào có giá). */
  costUsd: number | null;
  /** true khi có ít nhất một record ước lượng token. */
  tokensEstimated: boolean;
  /** Phần trăm token đã dùng (null khi không có token cap). */
  tokensPercent: number | null;
  /** Phần trăm cost đã dùng (null khi không có cost cap). */
  costPercent: number | null;
  /** true khi token hoặc cost đã vượt 100% cap. */
  overCap: boolean;
  /** Cảnh báo đã phát cho run này (mỗi ngưỡng một lần). */
  warnings: V15BudgetWarning[];
  /** Số record đã ghi. */
  records: number;
}

/** Báo cáo meter của một run (đọc được, render cho UI). */
export interface V15BudgetReport {
  runId: string;
  botId: string;
  profileId: string;
  model: string;
  state: V15BudgetState;
  /** Ghi chú quan trọng nhất: meter chỉ báo cáo, vượt cap vẫn chạy. */
  reportOnlyNote: string;
  /** Tóm tắt một dòng. */
  summary: string;
}

/** Một mục lịch sử tiêu thụ theo run/bot. */
export interface V15BudgetHistoryEntry {
  runId: string;
  botId: string;
  profileId: string;
  model: string;
  totalTokens: number;
  costUsd: number | null;
  overCap: boolean;
  records: number;
  firstAt: string;
  lastAt: string;
}

/* ================================================================== */
/* Hooks dialog (stop-hook feedback ngoài chat)                        */
/* ================================================================== */

/** Loại hook sinh feedback. */
export type V15HookKind = 'stop' | 'permission' | 'notification';

/** Mức độ của feedback. */
export type V15HookSeverity = 'info' | 'warning' | 'error';

/** Trạng thái xử lý của một feedback trong dialog. */
export type V15HookFeedbackStatus = 'pending' | 'confirmed' | 'dismissed' | 'snoozed';

/** Một feedback của hook — hiển thị trong dialog, KHÔNG chèn vào chat. */
export interface V15HookFeedback {
  /** Id ổn định: `vhf-<runId>-<seq>`. */
  id: string;
  runId: string;
  hookKind: V15HookKind;
  /** Nguồn sinh feedback (vd tên hook / tên tool). */
  source: string;
  title: string;
  body: string;
  severity: V15HookSeverity;
  status: V15HookFeedbackStatus;
  createdAt: string;
  /** Thời điểm user quyết định (confirm/dismiss/snooze). */
  decidedAt?: string;
  /** Ghi chú của user khi confirm/dismiss (tuỳ chọn). */
  note?: string;
  /** Số lần snooze (mỗi lần snooze đẩy feedback xuống cuối queue). */
  snoozeCount: number;
}

/** Input khi thêm feedback mới (dialog tự điền id/status/createdAt). */
export interface V15NewHookFeedback {
  runId: string;
  hookKind?: V15HookKind;
  source: string;
  title: string;
  body: string;
  severity?: V15HookSeverity;
  createdAt?: string;
}

/** Quyết định của user trên một feedback. */
export type V15HookDecision = 'confirm' | 'dismiss' | 'snooze';

/** Trạng thái của hooks dialog. */
export interface V15HooksDialogState {
  /** true = dialog đang mở (có feedback pending chưa xem). */
  open: boolean;
  /** Tổng số feedback đã nhận. */
  total: number;
  /** Số feedback đang chờ xử lý. */
  pending: number;
  /** Số đã xác nhận / bỏ qua / tạm ẩn. */
  confirmed: number;
  dismissed: number;
  snoozed: number;
  /** Feedback pending theo thứ tự hiển thị (cũ nhất trước). */
  pendingItems: V15HookFeedback[];
  /** Id feedback đang được chọn trong dialog (nếu có). */
  selectedId: string | null;
}

/* ================================================================== */
/* Verify scenarios (vượt happy path)                                  */
/* ================================================================== */

/** Kind của scenario kiểm chứng. */
export type V15VerifyScenarioKind =
  | 'happy_path'
  | 'tool_error'
  | 'timeout'
  | 'malformed_output'
  | 'file_conflict'
  | 'mid_run_test_failure'
  | 'empty_response'
  | 'permission_denied'
  | 'large_diff';

export const V15_VERIFY_SCENARIO_KINDS: readonly V15VerifyScenarioKind[] = [
  'happy_path',
  'tool_error',
  'timeout',
  'malformed_output',
  'file_conflict',
  'mid_run_test_failure',
  'empty_response',
  'permission_denied',
  'large_diff',
] as const;

/** Một scenario kiểm chứng với kỳ vọng rõ ràng. */
export interface V15VerifyScenario {
  /** Id ổn định: `v15-<kind>` cho built-in. */
  id: string;
  kind: V15VerifyScenarioKind;
  /** Tên hiển thị. */
  name: string;
  /** Mô tả: agent phải làm gì trong scenario này. */
  description: string;
  /** Kỳ vọng rõ ràng: điều agent PHẢI làm (để runner đối chiếu). */
  expectation: string;
  /** Timeout của scenario (ms); step vượt quá thì tính là timeout. */
  timeoutMs: number;
  /** true = scenario built-in của v15. */
  builtin: boolean;
}

/** Kết quả mô phỏng của một step trong scenario (do host/script tiêm vào). */
export interface V15VerifyStepOutcome {
  /** Tool được gọi (nếu có). */
  tool?: string;
  /** Trạng thái: ok | error | timeout | malformed | conflict | denied. */
  status: 'ok' | 'error' | 'timeout' | 'malformed' | 'conflict' | 'denied';
  /** Output thô (có thể sai định dạng — để test parser). */
  output?: string;
  /** Thông điệp lỗi (khi status != ok). */
  error?: string;
  /** Thời gian step tốn (ms) — để test timeout. */
  durationMs?: number;
  /** File bị sửa trong step (để test xung đột). */
  filePath?: string;
  /** Nội dung file sau step (để test xung đột nội dung). */
  fileContent?: string;
  /** Test có pass không (cho scenario mid_run_test_failure). */
  testsPassed?: boolean;
  /** Số ký tự diff (cho scenario large_diff). */
  diffChars?: number;
  /** Agent đã dừng lại đúng cách? (runner đối chiếu với expectation). */
  agentStopped?: boolean;
  /** Agent đã báo lỗi rõ ràng cho user? */
  agentReportedError?: boolean;
  /** Agent đã thử lại? Số lần thử lại. */
  agentRetries?: number;
}

/** Kết quả chạy một scenario. */
export interface V15VerifyScenarioResult {
  scenarioId: string;
  kind: V15VerifyScenarioKind;
  name: string;
  passed: boolean;
  expectation: string;
  /** Điều thật sự xảy ra (ngắn gọn, để báo cáo). */
  actual: string;
  /** Chi tiết từng check bên trong scenario. */
  checks: V15VerifyCheck[];
  durationMs: number;
}

/** Một check nhỏ bên trong scenario. */
export interface V15VerifyCheck {
  name: string;
  passed: boolean;
  detail: string;
}

/** Báo cáo chạy toàn bộ bộ scenario. */
export interface V15VerifyReport {
  runId: string;
  profileId: string;
  total: number;
  passed: number;
  failed: number;
  results: V15VerifyScenarioResult[];
  /** Thời gian chạy toàn bộ (ms). */
  durationMs: number;
  /** Tóm tắt một dòng. */
  summary: string;
  createdAt: string;
}

/* ================================================================== */
/* Agent v15 (pipeline nối profile + budget + hooks + verify)          */
/* ================================================================== */

/** Một step scripted của agent v15 (test / tool, không gọi model thật). */
export interface V15AgentStep {
  text: string;
  toolCalls?: V15AgentToolCall[];
  /** true = agent kết thúc ở step này. */
  done?: boolean;
  /** Token tiêu thụ của step (để budget meter ghi nhận). */
  inputTokens?: number;
  outputTokens?: number;
  /** Model sinh step này (mặc định = model của profile). */
  model?: string;
  /** Feedback của stop hook sinh ra ở step này (đi vào dialog, không vào chat). */
  stopHookFeedback?: V15NewHookFeedback;
  /** true = step này giả lập lỗi tool (để verify). */
  simulateToolError?: boolean;
}

/** Một tool call trong step scripted. */
export interface V15AgentToolCall {
  tool: string;
  args: Record<string, unknown>;
  status: 'ok' | 'error';
  outputPreview?: string;
  error?: string;
  /** File change kèm theo (để agent ghi thật ra workspace khi có fileApplier). */
  fileChange?: { path: string; kind: 'edit' | 'create' | 'delete'; beforeContent?: string; afterContent?: string };
}

/** Input chạy agent v15. */
export interface V15AgentRunInput {
  runId: string;
  prompt: string;
  profileId?: string;
  botId?: string;
  maxSteps?: number;
  budgetCap?: V15BudgetCap;
  /** true = chạy bộ verify scenario sau khi agent xong (mặc định false). */
  runVerifyAfter?: boolean;
}

/** Kết quả chạy agent v15. */
export interface V15AgentRunResult {
  runId: string;
  profileId: string;
  botId: string;
  prompt: string;
  stepsExecuted: number;
  done: boolean;
  /** true = agent dừng vì hết step (chưa done). */
  stoppedByMaxSteps: boolean;
  budget: V15BudgetReport;
  hooksDialog: V15HooksDialogState;
  /** Báo cáo verify (chỉ có khi runVerifyAfter = true). */
  verify?: V15VerifyReport;
  /** Các file đã ghi (đường dẫn tương đối). */
  filesWritten: string[];
  /** Lỗi tool gặp trong run (không chặn run — ghi lại để báo cáo). */
  toolErrors: string[];
  createdAt: string;
}

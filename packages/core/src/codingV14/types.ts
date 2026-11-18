/**
 * Coding agent v14 (v1.29, Đội T3) — shared types.
 *
 * Học ý tưởng (chỉ học ý tưởng, không copy code/text/tài sản của bất
 * kỳ repo nào, của xAI/Cursor):
 * - OpenHands Software Agent SDK (event-sourced, condenser): mọi
 *   message/action/observation là event append-only; khi context vượt
 *   ngưỡng thì nén prefix thành summary event, event gốc vẫn còn để
 *   replay. v14 đem ý tưởng này lên một tầng mới: condenser tăng dần
 *   (incremental — chỉ nén phần chưa nén từ lần compact trước), chính
 *   sách giữ lại (retention policy) theo loại event, và context dựng
 *   lại được từ summary + phần giữ nguyên văn + tail.
 * - Harness engineering ("stuck detection" pattern): agent kẹt để lại
 *   dấu vết trong event stream — cùng action lặp lại, cùng lỗi lặp
 *   lại, dao động A→B→A, nhiều step không tiến triển. v14 thêm tầng
 *   recovery: chữ ký vòng lặp (loop signature), nhật ký edit để
 *   rollback lần sửa cuối, thang leo thang (redirect → thu hẹp scope
 *   → hỏi user → rollback → escalate).
 * - Reasoning-block persistence (thinking_blocks / reasoning_content
 *   của các provider hiện đại): khối suy luận là dữ liệu của run,
 *   phải lưu bền + replay được + khôi phục khi resume, không mất khi
 *   session ngắt giữa chừng. v14 lưu full text vào sidecar JSONL có
 *   hash chain riêng, đồng thời ghi digest event vào run log chung
 *   (hash-chained) để audit và đối chiếu.
 *
 * v14 NỐI các tầng đã có (không viết lại): condenser v1/v2 của
 * event-log (`condenser.ts`, `condenser-v2.ts`) làm máy nén trích xuất
 * và đo token; `detectStuck` của event-log (`stuck.ts`) làm detector
 * cơ sở; `RunLogStore` làm log append-only hash-chained; coding agent
 * v12 làm pipeline edit/verify. v14 thêm 5 lớp mới (mỗi lớp một file):
 *
 *   1. `reasoningBlocks.ts`: store khối suy luận (append-only JSONL +
 *      hash chain, redact secret, prune, replay/verify, resume).
 *   2. `condenserV14.ts`: condenser tăng dần + retention policy +
 *      dựng lại context từ summary + kept + tail.
 *   3. `stuckRecovery.ts`: detector v2 (loop signature, oscillation,
 *      no-progress) + recovery planner/executor + edit journal.
 *   4. `eventLogAdapter.ts`: cầu nối v14 ↔ RunLogStore (digest event
 *      `reasoning.block` / `stuck.recovered`, rebuild state by replay).
 *   5. `agent.ts`: pipeline nối 4 lớp trên (loop có inject step fn,
 *      auto-condense, auto-recover, resume).
 */

/** Lỗi riêng của coding agent v14. */
export class CodingV14Error extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'CodingV14Error';
    this.code = code;
  }
}

/** Mã lỗi dùng chung cho v14. */
export const V14_ERROR_CODES = [
  'reasoning-invalid',
  'reasoning-not-found',
  'reasoning-chain-broken',
  'reasoning-store-unavailable',
  'condense-invalid',
  'condense-nothing-to-condense',
  'condense-store-unavailable',
  'stuck-invalid',
  'recovery-no-strategy',
  'recovery-rollback-failed',
  'recovery-edit-not-found',
  'journal-edit-not-found',
  'agent-plan-invalid',
  'agent-step-invalid',
  'agent-resume-invalid',
] as const;
export type V14ErrorCode = (typeof V14_ERROR_CODES)[number];

/* ================================================================== */
/* Reasoning blocks                                                    */
/* ================================================================== */

/** Loại khối suy luận — khớp khái niệm thinking_blocks / reasoning_content. */
export type V14ReasoningKind = 'thinking' | 'reasoning_content' | 'plan' | 'self_critique';

/** Một khối suy luận của một step trong run. */
export interface V14ReasoningBlock {
  /** Id ổn định: `rb-<runId>-<step>-<n>`. */
  id: string;
  runId: string;
  /** Step (0-based) mà khối này thuộc về. */
  step: number;
  kind: V14ReasoningKind;
  /** Nội dung đầy đủ (chưa cắt — sidecar giữ nguyên văn). */
  text: string;
  /** Model đã sinh khối này (nếu biết). */
  model?: string;
  /** Thời điểm ghi (ISO 8601). */
  createdAt: string;
  /** Số ký tự của `text`. */
  chars: number;
  /** SHA-256 hex của `text` (đối chiếu với digest event trong run log). */
  sha256: string;
  /** true khi text đã qua redact secret. */
  redacted: boolean;
  /** true khi khối được ghim — prune không xoá. */
  pinned: boolean;
  /** Seq trong sidecar JSONL (1-based, theo thứ tự append). */
  seq: number;
  /** Hash chain của sidecar: hash của block trước ('' ở block đầu). */
  prevHash: string;
  /** Hash của block này (tính trên nội dung đã chuẩn hoá). */
  hash: string;
}

/** Input khi ghi một khối suy luận mới (store tự điền id/seq/hash). */
export interface V14NewReasoningBlock {
  runId: string;
  step: number;
  kind: V14ReasoningKind;
  text: string;
  model?: string;
  createdAt?: string;
  pinned?: boolean;
}

/** Kết quả verify hash chain của sidecar reasoning. */
export interface V14ReasoningChainReport {
  runId: string;
  blocks: number;
  /** true khi toàn bộ chain khớp (hash + prevHash + sha256 text). */
  ok: boolean;
  /** Seq đầu tiên bị hỏng (0 khi ok). */
  brokenAtSeq: number;
  /** Lý do hỏng ('' khi ok). */
  reason: string;
}

/** Trạng thái resume suy ra từ reasoning store (để agent tiếp tục). */
export interface V14ReasoningResumeState {
  runId: string;
  /** Step lớn nhất đã có reasoning (0 khi chưa có block nào). */
  lastStep: number;
  /** Tổng số block đã lưu. */
  totalBlocks: number;
  /** Các block gần nhất (theo `keepLast`, mặc định 10). */
  recentBlocks: V14ReasoningBlock[];
  /** Các block được ghim. */
  pinnedBlocks: V14ReasoningBlock[];
}

/* ================================================================== */
/* Condenser v14 — incremental + retention policy                      */
/* ================================================================== */

/** Chiến lược nén của condenser v14. */
export type V14CondenseStrategy =
  | 'incremental-summarize'
  | 'incremental-extract-keep'
  | 'full-summarize';

/** Lớp giữ lại (retention class) của một event khi nén. */
export type V14RetentionClass = 'keep' | 'summarize' | 'drop';

/** Chính sách giữ lại khi nén — event nào giữ nguyên văn, event nào tóm tắt. */
export interface V14RetentionPolicy {
  /** Giữ nguyên văn tool.result lỗi (mặc định true). */
  keepErrorToolResults: boolean;
  /** Giữ nguyên văn lần file.change mới nhất của mỗi file (mặc định true). */
  keepLatestEditPerFile: boolean;
  /** Giữ nguyên văn approval request/decision (mặc định true). */
  keepApprovals: boolean;
  /** Giữ nguyên văn N model.response cuối (mặc định 2). */
  keepLastModelResponses: number;
  /** Giữ nguyên văn N reasoning digest cuối (mặc định 2). */
  keepLastReasoningDigests: number;
  /** Giữ nguyên văn marker run.compacted / stuck.* (mặc định true). */
  keepMarkers: boolean;
  /** Giữ nguyên văn N event đầu log (mặc định 2: run.started + prompt). */
  keepHeadEvents: number;
}

/** Chính sách giữ lại mặc định của v14. */
export const V14_DEFAULT_RETENTION: V14RetentionPolicy = {
  keepErrorToolResults: true,
  keepLatestEditPerFile: true,
  keepApprovals: true,
  keepLastModelResponses: 2,
  keepLastReasoningDigests: 2,
  keepMarkers: true,
  keepHeadEvents: 2,
};

/** Tuỳ chọn condenser v14. */
export interface V14CondenseOptions {
  /** Chiến lược. Mặc định 'incremental-summarize'. */
  strategy?: V14CondenseStrategy;
  /** Nén khi phần chưa nén >= N event. Mặc định 40. */
  minEvents?: number;
  /** Nén khi phần chưa nén ước lượng >= N token. Mặc định 4000. */
  minTokens?: number;
  /** Tóm tắt tối đa bao nhiêu ký tự. Mặc định 1500. */
  maxSummaryChars?: number;
  /** Chính sách giữ lại (merge lên default khi chỉ set một phần). */
  retention?: Partial<V14RetentionPolicy>;
  /** Seq cuối bao phủ (mặc định = seq cuối của log). */
  upToSeq?: number;
}

/** Bản nén tăng dần của một run. */
export interface V14Condensation {
  runId: string;
  /** Chiến lược đã dùng. */
  strategy: V14CondenseStrategy;
  /** Seq bắt đầu của phần vừa nén (không bao gồm — phần sau lần compact trước). */
  fromSeq: number;
  /** Seq cuối mà bản nén bao phủ (bao gồm). */
  upToSeq: number;
  /** Số event trong phần vừa nén. */
  eventsCovered: number;
  /** Số event giữ nguyên văn trong bản nén. */
  eventsKept: number;
  /** Số event chỉ còn trong tóm tắt (không giữ nguyên văn). */
  eventsSummarized: number;
  /** Bản tóm tắt trích xuất của phần vừa nén. */
  summary: string;
  /** Phần giữ nguyên văn (mỗi dòng một event, để nạp thẳng vào context). */
  keptTranscript: string;
  /** Ước lượng token của phần gốc. */
  tokensBefore: number;
  /** Ước lượng token của bản nén (tóm tắt + phần giữ nguyên văn). */
  tokensAfter: number;
  /** Token tiết kiệm được (before − after, có thể âm trên log ngắn). */
  tokensSaved: number;
  /** Tỉ lệ tiết kiệm % (saved / before * 100). */
  savedRatioPct: number;
  /** Seq của event `run.compacted` vừa append (0 khi chưa ghi marker). */
  markerSeq: number;
}

/** Kết quả kiểm tra "có nên nén phần chưa nén không". */
export interface V14CondenseCheck {
  needed: boolean;
  reason: string;
  /** Seq bắt đầu của phần chưa nén. */
  fromSeq: number;
  /** Seq cuối hiện tại. */
  upToSeq: number;
  /** Số event chưa nén. */
  uncondensedEvents: number;
  /** Ước lượng token của phần chưa nén. */
  uncondensedTokens: number;
}

/* ================================================================== */
/* Stuck detection v2 + recovery                                       */
/* ================================================================== */

/** Các loại tín hiệu kẹt mà detector v2 nhận ra. */
export type V14StuckKind =
  | 'repeat_action'
  | 'repeat_error'
  | 'oscillation'
  | 'no_progress'
  | 'empty_response';

/** Một tín hiệu kẹt cụ thể, kèm bằng chứng. */
export interface V14StuckSignal {
  kind: V14StuckKind;
  /** Số lần mẫu lặp lại (hoặc số step không tiến triển). */
  count: number;
  /** Mô tả ngắn (chỉ tên tool / lỗi đã chuẩn hoá, không secret). */
  detail: string;
  /** Chữ ký vòng lặp gây ra tín hiệu ('' khi không phải loop). */
  signature: string;
  /** Seq đầu tiên của mẫu lặp. */
  firstSeq: number;
  /** Seq cuối cùng của mẫu lặp. */
  lastSeq: number;
}

/** Báo cáo phân tích kẹt của một run. */
export interface V14StuckReport {
  runId: string;
  /** true khi có ít nhất một tín hiệu vượt ngưỡng. */
  stuck: boolean;
  /** Step hiện tại (step lớn nhất trong log). */
  step: number;
  /** Mọi tín hiệu vượt ngưỡng (rỗng khi không kẹt). */
  signals: V14StuckSignal[];
  /** Chiến lược recovery được gợi ý mạnh nhất. */
  suggestedStrategy?: V14RecoveryStrategy;
  /** Key i18n của gợi ý can thiệp mạnh nhất. */
  suggestionKey?: string;
}

/** Ngưỡng của detector v2 — caller có thể nới/chặt. */
export interface V14StuckOptions {
  /** Cùng action (tool + args chuẩn hoá) lặp bao nhiêu lần thì kẹt. Mặc định 3. */
  repeatActionThreshold?: number;
  /** Cùng lỗi chuẩn hoá bao nhiêu lần thì kẹt. Mặc định 3. */
  repeatErrorThreshold?: number;
  /** Chu kỳ dao động A→B→A lặp bao nhiêu lần thì kẹt. Mặc định 2. */
  oscillationThreshold?: number;
  /** Model response rỗng kèm tool call bao nhiêu lần liên tiếp thì kẹt. Mặc định 3. */
  emptyResponseThreshold?: number;
  /** Bao nhiêu step không file change / không tool ok thì kẹt. Mặc định 8. */
  noProgressStepThreshold?: number;
  /** Số step gần nhất để xét (cửa sổ trượt). Mặc định 30. */
  windowSteps?: number;
}

/** Chiến lược recovery. */
export type V14RecoveryStrategy =
  | 'redirect'
  | 'narrow_scope'
  | 'ask_user'
  | 'rollback_last_edit'
  | 'escalate';

/** Một bước trong kế hoạch recovery. */
export interface V14RecoveryStep {
  strategy: V14RecoveryStrategy;
  /** Vì sao bước này được chọn (mô tả ngắn, tiếng Anh, không secret). */
  rationale: string;
  /** Hướng dẫn cụ thể cho agent (vd câu redirect, câu hỏi cho user). */
  instruction: string;
}

/** Kế hoạch recovery đầy đủ (thang leo thang, bước đầu là bước nên làm trước). */
export interface V14RecoveryPlan {
  runId: string;
  /** Tín hiệu kẹt đã kích hoạt kế hoạch. */
  signal: V14StuckSignal;
  /** Các bước theo thứ tự ưu tiên (bước đầu = nên thử trước). */
  steps: V14RecoveryStep[];
  /** true khi có bước rollback (cần edit journal có entry). */
  hasRollback: boolean;
}

/** Kết quả thực thi một bước recovery. */
export interface V14RecoveryResult {
  runId: string;
  strategy: V14RecoveryStrategy;
  /** true khi bước thực thi thành công (không tính hiệu quả — hiệu quả đo ở lần check sau). */
  applied: boolean;
  /** Mô tả những gì đã làm (vd file đã rollback, câu hỏi đã gửi). */
  detail: string;
  /** Seq của event `stuck.recovered` đã ghi (0 khi chưa ghi). */
  markerSeq: number;
}

/** Một entry trong nhật ký edit (để rollback lần sửa cuối). */
export interface V14EditJournalEntry {
  /** Id ổn định: `ej-<runId>-<n>`. */
  id: string;
  runId: string;
  /** Đường dẫn tương đối trong workspace. */
  path: string;
  /** Nội dung trước khi sửa (null = file chưa tồn tại). */
  beforeContent: string | null;
  /** Nội dung sau khi sửa (null = file đã bị xoá). */
  afterContent: string | null;
  /** Step đã sửa. */
  step: number;
  /** Seq của event file.change tương ứng (0 khi không có). */
  seq: number;
  /** true khi entry đã được rollback. */
  undone: boolean;
  /** Thời điểm ghi (ISO 8601). */
  createdAt: string;
}

/* ================================================================== */
/* Agent v14                                                           */
/* ================================================================== */

/** Một tool call trong một step của agent v14 (đầu vào của step fn). */
export interface V14StepToolCall {
  tool: string;
  args: Record<string, unknown>;
  /** Kết quả mô phỏng/thật của tool call (do step fn trả về). */
  status: 'ok' | 'error' | 'denied';
  /** Output preview (đã cắt ngắn). */
  outputPreview: string;
  /** File mà tool call này đã đổi (nếu có) — để ghi file.change + journal. */
  fileChange?: { path: string; kind: 'write' | 'edit' | 'delete' | 'create'; beforeContent?: string | null; afterContent?: string | null };
}

/** Kết quả một step do step fn trả về. */
export interface V14StepResult {
  /** Text trả về của model ở step này ('' = response rỗng). */
  text: string;
  /** Khối suy luận của step (nếu model có thinking/reasoning). */
  reasoning?: { kind: V14ReasoningKind; text: string; model?: string };
  /** Tool call của step (có thể rỗng). */
  toolCalls: V14StepToolCall[];
  /** true khi task đã xong (agent dừng, không cần step nữa). */
  done: boolean;
  /** Ghi chú ngắn của step fn (vd lý do done). */
  note?: string;
}

/** Hàm một step của agent — caller inject (model thật, scripted, hoặc mock). */
export type V14StepFn = (step: number, context: string) => V14StepResult;

/** Tuỳ chọn chạy agent v14. */
export interface V14AgentOptions {
  runId: string;
  /** Prompt/task ban đầu. */
  prompt: string;
  /** Số step tối đa. Mặc định 20. */
  maxSteps?: number;
  /** Hàm chạy một step (bắt buộc). */
  stepFn: V14StepFn;
  /** Thư mục lưu reasoning sidecar + condensation (undefined = chỉ memory). */
  dataDir?: string;
  /** Tuỳ chọn condenser (undefined = mặc định, auto-condense bật). */
  condenseOptions?: V14CondenseOptions;
  /** true = tự condense khi vượt ngưỡng (mặc định true). */
  autoCondense?: boolean;
  /** Tuỳ chọn stuck detector v2 (undefined = mặc định). */
  stuckOptions?: V14StuckOptions;
  /** true = tự recovery khi phát hiện kẹt (mặc định true). */
  autoRecover?: boolean;
  /** true = cho phép recovery hỏi user (khi false, bỏ qua bước ask_user). Mặc định false. */
  allowAskUser?: boolean;
  /** Hàm áp dụng rollback file (mặc định: ghi vào map file trong memory của agent). */
  fileApplier?: (path: string, content: string | null) => void;
  /** Trạng thái resume (từ lần chạy trước) — undefined = chạy mới. */
  resumeFrom?: V14ResumeState;
}

/** Trạng thái lưu lại để resume một run v14 (JSON-serializable). */
export interface V14ResumeState {
  runId: string;
  prompt: string;
  /** Step tiếp theo sẽ chạy. */
  nextStep: number;
  /** Các reasoning block đã lưu (đầy đủ). */
  reasoningBlocks: V14ReasoningBlock[];
  /** Nhật ký edit đã lưu. */
  editJournal: V14EditJournalEntry[];
  /** Các lần condense đã làm. */
  condensations: V14Condensation[];
  /** Các lần recovery đã làm. */
  recoveries: V14RecoveryResult[];
  /** Số step đã chạy trước khi dừng. */
  stepsRun: number;
}

/** Báo cáo chạy agent v14. */
export interface V14AgentReport {
  runId: string;
  /** 'completed' | 'stuck_unresolved' | 'max_steps' | 'failed'. */
  outcome: 'completed' | 'stuck_unresolved' | 'max_steps' | 'failed';
  stepsRun: number;
  toolCalls: number;
  toolErrors: number;
  filesChanged: string[];
  reasoningBlocks: number;
  condensations: V14Condensation[];
  stuckReports: V14StuckReport[];
  recoveries: V14RecoveryResult[];
  /** Text cuối cùng của run. */
  finalText: string;
  /** Trạng thái resume (để chạy tiếp sau này). */
  resumeState: V14ResumeState;
}

/** Hằng số mặc định của agent v14. */
export const V14_DEFAULT_MAX_STEPS = 20;
export const V14_DEFAULT_MIN_EVENTS = 40;
export const V14_DEFAULT_MIN_TOKENS = 4000;
export const V14_DEFAULT_MAX_SUMMARY_CHARS = 1500;
export const V14_TOKEN_CHARS_PER_TOKEN = 4;

/** Map từ loại tín hiệu kẹt v2 sang key i18n gợi ý. */
export const V14_STUCK_SUGGESTION_KEYS: Record<V14StuckKind, string> = {
  repeat_action: 'codingV14.stuckRepeatAction',
  repeat_error: 'codingV14.stuckRepeatError',
  oscillation: 'codingV14.stuckOscillation',
  no_progress: 'codingV14.stuckNoProgress',
  empty_response: 'codingV14.stuckEmptyResponse',
};

/** Map từ loại tín hiệu kẹt v2 sang chiến lược recovery mặc định. */
export const V14_STUCK_DEFAULT_STRATEGY: Record<V14StuckKind, V14RecoveryStrategy> = {
  repeat_action: 'redirect',
  repeat_error: 'narrow_scope',
  oscillation: 'redirect',
  no_progress: 'narrow_scope',
  empty_response: 'ask_user',
};

/** Key i18n cho từng chiến lược recovery. */
export const V14_RECOVERY_STRATEGY_KEYS: Record<V14RecoveryStrategy, string> = {
  redirect: 'codingV14.recoveryRedirect',
  narrow_scope: 'codingV14.recoveryNarrowScope',
  ask_user: 'codingV14.recoveryAskUser',
  rollback_last_edit: 'codingV14.recoveryRollback',
  escalate: 'codingV14.recoveryEscalate',
};

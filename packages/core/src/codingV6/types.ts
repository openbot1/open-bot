/**
 * Coding agent v6 — types (v1.14, Đội T3).
 *
 * Ý tưởng học từ OpenHands V1 SDK (survey v1.14 §2): Conversation =
 * stream event Action ↔ Observation, event log append-only là single
 * source of truth, CodeAct (bash + Python) làm action language,
 * SecurityAnalyzer chấm risk từng tool call, Condenser nén context,
 * RouterLLM leo thang model, delegation qua tool call, stuck
 * detection. Chỉ học ý tưởng — thiết kế và code của open-bot, KHÔNG
 * đọc, KHÔNG copy code/text/tài sản của bất kỳ repo nào, của xAI/Cursor.
 *
 * Lớp này NỐI các lớp đã có thay vì viết lại:
 * - event-log (v1.01–v1.04): run log append-only + hash chain,
 *   condenser v1/v2, stuck detection, replay/time-travel — v6 dùng
 *   cùng nguyên tắc trên log hội thoại của riêng coding agent
 *   (event `v6.*`, xem `conversationLog.ts`).
 * - codeact (v1.04) + conversationV112 CodeAct-lite (v1.12): bash /
 *   python / edit qua `CodeActExecutor` trong BotBox sandbox — v6
 *   thêm MỘT format action thống nhất (JSON | fenced block |
 *   tool-call args) + `think` / `finish` / `delegate`
 *   (xem `codeactV2.ts`).
 * - risk/analyzer (v1.01): `RiskAnalyzer` chấm low/medium/high — v6
 *   bọc thêm mức UNKNOWN + approval gate (xem `security.ts`).
 * - codingV5 (v1.13): git-native — v6 dùng `buildCodingV5Subject`
 *   để gợi ý commit message khi turn `finish` (xem `agent.ts`).
 * - delegation (v1.04) + subagents/nested (v1.01): ủy quyền qua
 *   tool call có budget — v6 thêm action `delegate` (xem `delegate.ts`).
 * - router (v0.96–v0.98): ModelRouter 3 tầng — v6 thêm RouterLLM
 *   leo thang theo độ khó task (xem `routerLlm.ts`).
 *
 * Local-first: không X, không Grok Imagine, không cloud VM/tài
 * khoản/thanh toán. Module core thuần (không fs, không mạng, không
 * gọi model thật — model được tiêm qua callback, xem `agent.ts`).
 */

/** Mức rủi ro v6: LOW/MEDIUM/HIGH theo RiskAnalyzer + UNKNOWN khi không chấm được. */
export type V6RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH' | 'UNKNOWN';

/** Bậc model của RouterLLM v6. */
export type V6ModelTier = 'light' | 'standard' | 'strong';

/** Trạng thái một turn/session của coding agent v6. */
export type V6SessionStatus = 'running' | 'paused' | 'stuck' | 'finished' | 'aborted';

/** Mọi loại event trong log hội thoại v6. */
export type V6EventType =
  | 'v6.session.started'
  | 'v6.user.message'
  | 'v6.model.message'
  | 'v6.model.routed'
  | 'v6.action.parsed'
  | 'v6.action.blocked'
  | 'v6.security.verdict'
  | 'v6.approval.requested'
  | 'v6.approval.decided'
  | 'v6.action.executed'
  | 'v6.observation'
  | 'v6.file.changed'
  | 'v6.error'
  | 'v6.stuck.detected'
  | 'v6.condensed'
  | 'v6.delegation.started'
  | 'v6.delegation.finished'
  | 'v6.turn.finished'
  | 'v6.forked';

/** Một event bất biến trong log v6 (append-only, nối hash chain). */
export interface V6Event {
  /** Số thứ tự trong log, bắt đầu từ 1, tăng đều, không lỗ hổng. */
  seq: number;
  /** Id của log/session sở hữu event. */
  sessionId: string;
  /** Thời điểm ghi (ISO 8601). */
  at: string;
  type: V6EventType;
  /** Payload riêng từng loại — đã cắt ngắn, không chứa secret. */
  payload: Record<string, unknown>;
  /** Hash của event trước ('' ở event đầu). */
  prevHash: string;
  /** Hash SHA-256 của event này (xem `conversationLog.ts`). */
  hash: string;
}

/** Action thống nhất của CodeAct-lite v2: MỘT format cho mọi nguồn. */
export type V6Action =
  | V6BashAction
  | V6PythonAction
  | V6EditAction
  | V6ThinkAction
  | V6FinishAction
  | V6DelegateAction;

/** Chạy lệnh shell trong BotBox sandbox. */
export interface V6BashAction {
  kind: 'bash';
  command: string;
  timeoutMs?: number;
}

/** Chạy code Python trong BotBox sandbox. */
export interface V6PythonAction {
  kind: 'python';
  code: string;
  args?: string[];
  timeoutMs?: number;
}

/** Ghi/sửa file trong workspace của box (không qua shell). */
export interface V6EditAction {
  kind: 'edit';
  /** Path tương đối trong workspace (không absolute, không `..`). */
  path: string;
  content: string;
  mode: 'write' | 'append';
}

/** Suy luận không commit action (ghi quyết định vào log). */
export interface V6ThinkAction {
  kind: 'think';
  text: string;
}

/** Kết thúc turn: tóm tắt + (tùy chọn) gợi ý commit message v5. */
export interface V6FinishAction {
  kind: 'finish';
  /** Tóm tắt những gì đã làm xong. */
  summary: string;
  /** true = agent muốn gợi ý commit message từ file đã đổi. */
  suggestCommit?: boolean;
}

/** Ủy quyền cho sub-agent qua tool call (chạy bởi `delegate.ts`). */
export interface V6DelegateAction {
  kind: 'delegate';
  /** Việc giao cho sub-agent (mô tả rõ ràng). */
  task: string;
  /** Phạm vi con được chạm (vd thư mục/file, tool cho phép). */
  scope?: string;
  /** Role chuyên biệt (nếu có). */
  role?: string;
  /** Ngân sách của con (xem `V6DelegateBudget`). */
  budget?: V6DelegateBudget;
}

/** Ngân sách cho một lần delegate. */
export interface V6DelegateBudget {
  /** Số step tối đa của con. Mặc định 20. */
  maxSteps?: number;
  /** Timeout của con, ms. Mặc định 120_000. */
  timeoutMs?: number;
  /** Token tối đa con được dùng (ước lượng). Mặc định 32_000. */
  maxTokens?: number;
}

/** Kết quả quan sát được sau khi một action chạy. */
export interface V6Observation {
  /** Action đã chạy (echo lại để replay). */
  action: V6Action;
  /** true = chạy thành công (exit 0 / edit ok / think / finish). */
  ok: boolean;
  /** stdout (bash/python) hoặc ghi chú (edit/think/finish/delegate). */
  stdout: string;
  /** stderr (bash/python) hoặc '' . */
  stderr: string;
  /** Exit code (null khi không áp dụng, vd think/finish). */
  exitCode: number | null;
  /** True khi bị kill vì quá timeout. */
  timedOut: boolean;
  /** True khi action bị chặn (policy/security) nên KHÔNG chạy. */
  blocked: boolean;
  /** Lý do chặn (khi blocked). */
  blockReason?: string;
  /** Thời gian chạy, ms. */
  durationMs: number;
  /** File đã ghi (chỉ kind edit thành công). */
  fileWritten?: { path: string; bytes: number };
}

/** File đã đổi trong session (fold từ event log). */
export interface V6ChangedFile {
  path: string;
  /** Lần đổi đầu / cuối (seq). */
  firstSeq: number;
  lastSeq: number;
  /** Số lần đổi. */
  changes: number;
}

/** Quyết định agent đã ghi (fold từ think/finish). */
export interface V6Decision {
  /** Seq của event ghi quyết định. */
  seq: number;
  /** Nội dung quyết định (đã cắt ngắn). */
  text: string;
}

/** Lỗi agent đã gặp (fold từ observation lỗi + v6.error). */
export interface V6EncounteredError {
  /** Seq của event ghi lỗi. */
  seq: number;
  /** Text lỗi (đã cắt ngắn). */
  text: string;
  /** Tool/action gây lỗi (nếu biết). */
  source?: string;
}

/** Trạng thái suy ra từ log (fold) — single source of truth là log. */
export interface V6State {
  sessionId: string;
  /** Seq cuối cùng đã fold (0 khi log rỗng). */
  lastSeq: number;
  status: V6SessionStatus;
  /** Prompt/task gốc của session. */
  title: string;
  /** Lịch sử message (user/model) theo thứ tự. */
  messages: Array<{ role: 'user' | 'model'; text: string; seq: number }>;
  /** File đã đổi (theo path). */
  filesChanged: V6ChangedFile[];
  /** Quyết định đã ghi. */
  decisions: V6Decision[];
  /** Lỗi đã gặp. */
  errors: V6EncounteredError[];
  /** Số action đã chạy (không tính think/finish). */
  actionsExecuted: number;
  /** Số observation lỗi. */
  failedObservations: number;
  /** Số lần delegate đã chạy. */
  delegations: number;
  /** Bậc model hiện tại (RouterLLM). */
  currentTier: V6ModelTier;
  /** Model hiện tại (tên đầy đủ, nếu router đã chọn). */
  currentModel?: string;
  /** Số lần đã condense. */
  condensations: number;
  /** Số lần stuck đã phát hiện. */
  stuckDetections: number;
  /** Seq của lần condense gần nhất (0 = chưa condense). */
  lastCondensedUpToSeq: number;
}

/** Một lần delegate đã chạy xong (kết quả trả về cho agent cha). */
export interface V6DelegateResult {
  /** Tên hiển thị của con. */
  name: string;
  status: 'done' | 'error' | 'timeout';
  /** Kết quả text của con. */
  output: string;
  /** Thời gian chạy, ms. */
  durationMs: number;
  /** Lỗi, chỉ có khi status = error/timeout. */
  error?: string;
}

/** Runner sub-agent do host tiêm (v6 không tự chạy model con). */
export type V6SubagentRunner = (input: {
  name: string;
  task: string;
  scope?: string;
  role?: string;
  model?: string;
  timeoutMs: number;
  maxSteps: number;
}) => Promise<V6DelegateResult>;

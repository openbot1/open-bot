/**
 * Coding agent v7 — types (v1.15, Đội T4).
 *
 * Ý tưởng học từ OpenHands V1 SDK (survey v1.15 §3): agent là hàm thuần
 * từ event history → next event; mọi state mutable nằm trong một
 * ConversationState event-sourced duy nhất; CodeAct thay cho tool
 * bespoke; Skills thay microagents. Chỉ học ý tưởng — thiết kế và code
 * của open-bot, KHÔNG đọc, KHÔNG copy code/text/tài sản của bất kỳ repo
 * nào, của xAI/Cursor.
 *
 * v7 khác v6 ở đâu (không viết lại v6):
 * - Stateless thật: `decideV7NextAction(events, generate)` là hàm thuần
 *   — cùng history + cùng model output thì cùng next action; không có
 *   field mutable nào ngoài log (xem `agent.ts`).
 * - Event log v7 có pause/resume hạng nhất + fork ghi rõ nhánh cha/con
 *   + serialize kèm snapshot state để nạp nhanh (xem `conversationLog.ts`).
 * - CodeAct-lite v3: DSL an toàn có 3 ngôn ngữ khối (bash/python/edit)
 *   + lệnh `run`/`write`/`append`/`read`/`list` trong một khối code duy
 *   nhất, executor tự chạy bằng child_process trong working dir bị
 *   nhốt, timeout + giới hạn output (xem `codeactV3.ts`). v6 dùng
 *   CodeActExecutor/BotBox của host; v7 tự chủ executor riêng để eval
 *   chạy được trong /tmp mà không cần BotBox.
 * - Security analyzer v7: quét trước khi chạy, 3 mức allow/warn/block
 *   + audit log append-only riêng (xem `security.ts`).
 * - Condenser v3: summary có cấu trúc 6 mục + khôi phục context từ
 *   summary + event log + đo token tiết kiệm được (xem `condenserV3.ts`).
 * - Skills kiểu microagents: Skill = file markdown có frontmatter
 *   (tên, trigger, hướng dẫn, ví dụ) + loader/discovery + kích hoạt
 *   theo trigger; 3 skill mẫu thật đi kèm (xem `skills.ts`).
 * - Eval v7: task coding mẫu chạy thật trên repo mẫu trong /tmp, đo
 *   pass rate (xem `eval.ts`).
 *
 * Local-first: không X, không Grok Imagine, không cloud VM/tài khoản/
 * thanh toán. Module core thuần (không gọi model thật — model được tiêm
 * qua callback; executor chỉ chạy trong working dir được giao).
 */

/** Mức rủi ro / quyết định của security analyzer v7. */
export type V7SecurityLevel = 'allow' | 'warn' | 'block';

/** Trạng thái một session coding agent v7. */
export type V7SessionStatus = 'running' | 'paused' | 'finished' | 'aborted' | 'blocked';

/** Mọi loại event trong log hội thoại v7. */
export type V7EventType =
  | 'v7.session.started'
  | 'v7.session.paused'
  | 'v7.session.resumed'
  | 'v7.session.aborted'
  | 'v7.user.message'
  | 'v7.model.message'
  | 'v7.skill.activated'
  | 'v7.action.parsed'
  | 'v7.action.blocked'
  | 'v7.security.verdict'
  | 'v7.action.executed'
  | 'v7.observation'
  | 'v7.file.changed'
  | 'v7.error'
  | 'v7.condensed'
  | 'v7.turn.finished'
  | 'v7.forked'
  | 'v7.eval.finished';

/** Một event bất biến trong log v7 (append-only, nối hash chain). */
export interface V7Event {
  /** Số thứ tự trong log, bắt đầu từ 1, tăng đều, không lỗ hổng. */
  seq: number;
  /** Id của log/session sở hữu event. */
  sessionId: string;
  /** Thời điểm ghi (ISO 8601). */
  at: string;
  type: V7EventType;
  /** Payload riêng từng loại — đã cắt ngắn, không chứa secret. */
  payload: Record<string, unknown>;
  /** Hash của event trước ('' ở event đầu). */
  prevHash: string;
  /** Hash SHA-256 của event này (xem `conversationLog.ts`). */
  hash: string;
}

/** Action thống nhất của CodeAct-lite v3. */
export type V7Action =
  | V7BashAction
  | V7PythonAction
  | V7EditAction
  | V7ReadAction
  | V7ThinkAction
  | V7FinishAction
  | V7AskAction;

/** Chạy lệnh shell trong working dir bị nhốt. */
export interface V7BashAction {
  kind: 'bash';
  command: string;
  timeoutMs?: number;
}

/** Chạy code Python (qua `python3 -`) trong working dir bị nhốt. */
export interface V7PythonAction {
  kind: 'python';
  code: string;
  timeoutMs?: number;
}

/** Ghi/sửa file trong working dir (không qua shell). */
export interface V7EditAction {
  kind: 'edit';
  /** Path tương đối trong workspace (không absolute, không `..`). */
  path: string;
  content: string;
  mode: 'write' | 'append';
}

/** Đọc file trong working dir (trả nội dung vào observation). */
export interface V7ReadAction {
  kind: 'read';
  /** Path tương đối trong workspace. */
  path: string;
  /** Số dòng tối đa trả về. Mặc định 200. */
  maxLines?: number;
}

/** Suy luận không commit action (ghi quyết định vào log). */
export interface V7ThinkAction {
  kind: 'think';
  text: string;
}

/** Kết thúc turn: tóm tắt + pass/fail tự đánh giá (cho eval). */
export interface V7FinishAction {
  kind: 'finish';
  /** Tóm tắt những gì đã làm xong. */
  summary: string;
  /** Agent tự cho rằng task đã xong hay chưa. */
  done?: boolean;
}

/** Hỏi user (pause chờ đáp án — interrupt-and-resume). */
export interface V7AskAction {
  kind: 'ask';
  /** Câu hỏi gửi cho user. */
  question: string;
  /** Các lựa chọn gợi ý (nếu có). */
  options?: string[];
}

/** Kết quả quan sát được sau khi một action chạy. */
export interface V7Observation {
  /** Action đã chạy (echo lại để replay). */
  action: V7Action;
  /** true = chạy thành công (exit 0 / edit ok / think / finish / ask). */
  ok: boolean;
  /** stdout (bash/python/read) hoặc ghi chú (edit/think/finish/ask). */
  stdout: string;
  /** stderr (bash/python) hoặc '' . */
  stderr: string;
  /** Exit code (null khi không áp dụng, vd think/finish/ask). */
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
export interface V7ChangedFile {
  path: string;
  /** Lần đổi đầu / cuối (seq). */
  firstSeq: number;
  lastSeq: number;
  /** Số lần đổi. */
  changes: number;
}

/** Quyết định agent đã ghi (fold từ think/finish). */
export interface V7Decision {
  /** Seq của event ghi quyết định. */
  seq: number;
  /** Nội dung quyết định (đã cắt ngắn). */
  text: string;
}

/** Lỗi agent đã gặp (fold từ observation lỗi + v7.error). */
export interface V7EncounteredError {
  /** Seq của event ghi lỗi. */
  seq: number;
  /** Text lỗi (đã cắt ngắn). */
  text: string;
  /** Tool/action gây lỗi (nếu biết). */
  source?: string;
}

/** Trạng thái suy ra từ log (fold) — single source of truth là log. */
export interface V7State {
  sessionId: string;
  /** Seq cuối cùng đã fold (0 khi log rỗng). */
  lastSeq: number;
  status: V7SessionStatus;
  /** Prompt/task gốc của session. */
  title: string;
  /** Lịch sử message (user/model) theo thứ tự. */
  messages: Array<{ role: 'user' | 'model'; text: string; seq: number }>;
  /** File đã đổi (theo path). */
  filesChanged: V7ChangedFile[];
  /** Quyết định đã ghi. */
  decisions: V7Decision[];
  /** Lỗi đã gặp. */
  errors: V7EncounteredError[];
  /** Skill đã kích hoạt (theo tên). */
  skillsActivated: string[];
  /** Số action đã chạy (không tính think/finish/ask). */
  actionsExecuted: number;
  /** Số observation lỗi. */
  failedObservations: number;
  /** Số action bị security chặn. */
  blockedActions: number;
  /** Số lần pause / resume. */
  pauses: number;
  resumes: number;
  /** Số lần đã condense. */
  condensations: number;
  /** Seq của lần condense gần nhất (0 = chưa condense). */
  lastCondensedUpToSeq: number;
  /** true = session bị fork từ log khác (ghi rõ nguồn). */
  forkedFrom?: { sessionId: string; seq: number };
}

/** Một phát hiện của security analyzer. */
export interface V7SecurityFinding {
  /** Mã rule, vd `V7SEC-RM-RF-ROOT`. */
  ruleId: string;
  /** Mức của rule này. */
  level: V7SecurityLevel;
  /** Mô tả ngắn cho người đọc. */
  message: string;
  /** Đoạn text khớp (đã cắt ngắn). */
  matched: string;
}

/** Verdict của security analyzer cho một action/code. */
export interface V7SecurityVerdict {
  /** Mức tổng hợp: block > warn > allow. */
  level: V7SecurityLevel;
  /** Mọi phát hiện (kể cả allow = rỗng). */
  findings: V7SecurityFinding[];
  /** true = được chạy (allow hoặc warn). */
  allowed: boolean;
  /** Tóm tắt một dòng cho log/audit. */
  summary: string;
}

/** Một dòng audit của security analyzer (append-only). */
export interface V7SecurityAuditEntry {
  /** Thời điểm quét (ISO 8601). */
  at: string;
  /** Loại nội dung đã quét: bash/python/edit/... */
  kind: string;
  /** Mức verdict. */
  level: V7SecurityLevel;
  /** Mã rule đã khớp (rỗng khi allow sạch). */
  ruleIds: string[];
  /** Text đã quét, đã cắt ngắn + redact secret. */
  scanned: string;
}

/** Summary có cấu trúc do condenser v3 tạo ra (6 mục). */
export interface V7CondensedSummary {
  /** Seq cuối cùng đã nén (state sau seq này vẫn còn nguyên trong log). */
  upToSeq: number;
  /** Số event đã nén. */
  eventsCondensed: number;
  /** Task/mục tiêu của session. */
  goal: string;
  /** Fact quan trọng còn đúng (mỗi fact một dòng). */
  facts: string[];
  /** Quyết định đã chốt. */
  decisions: string[];
  /** File đã đổi + đổi gì (mỗi file một dòng). */
  filesChanged: string[];
  /** Lỗi đã gặp + đã xử lý ra sao. */
  errorsEncountered: string[];
  /** Việc còn dở / bước tiếp theo. */
  openItems: string[];
  /** Ước lượng token trước / sau khi nén. */
  tokensBefore: number;
  tokensAfter: number;
}

/** Skill kiểu microagents: một file markdown + frontmatter. */
export interface V7Skill {
  /** Tên duy nhất, vd `fix-test-failure`. */
  name: string;
  /** Mô tả một dòng (hiện trong danh sách skill). */
  description: string;
  /** Từ khóa trigger (khớp trong task/message, không phân biệt hoa thường). */
  triggers: string[];
  /** Hướng dẫn chi tiết cho agent khi skill kích hoạt. */
  instructions: string;
  /** Ví dụ kích hoạt (mỗi ví dụ một dòng). */
  examples: string[];
  /** Nguồn: file path hoặc 'builtin'. */
  source: string;
}

/** Kết quả kích hoạt skill. */
export interface V7SkillActivation {
  skill: V7Skill;
  /** Text đã khớp trigger (từ khóa hoặc regex). */
  matchedTrigger: string;
  /** Điểm khớp (số từ khóa trùng, dùng để xếp hạng). */
  score: number;
}

/** Một task eval coding mẫu. */
export interface V7EvalTask {
  /** Id duy nhất, vd `v7eval-fix-off-by-one`. */
  id: string;
  /** Tên hiển thị. */
  title: string;
  /** Mô tả task đưa cho agent. */
  prompt: string;
  /** File khởi tạo của repo mẫu: path → nội dung. */
  seedFiles: Record<string, string>;
  /** Lệnh kiểm tra (chạy trong repo mẫu, exit 0 = pass). */
  checkCommand: string;
  /** Timeout cho lệnh kiểm tra, ms. Mặc định 30_000. */
  checkTimeoutMs?: number;
}

/** Kết quả một task eval. */
export interface V7EvalTaskResult {
  taskId: string;
  title: string;
  passed: boolean;
  /** Số step agent đã chạy. */
  steps: number;
  /** Số action đã chạy. */
  actions: number;
  /** Số action bị security chặn. */
  blocked: number;
  /** Thời gian chạy, ms. */
  durationMs: number;
  /** stdout/stderr của lệnh kiểm tra (đã cắt ngắn). */
  checkOutput: string;
  /** Lỗi harness (nếu có), vd không tạo được repo mẫu. */
  error?: string;
}

/** Kết quả cả bộ eval. */
export interface V7EvalReport {
  /** Thời điểm chạy (ISO 8601). */
  at: string;
  /** Tổng số task. */
  total: number;
  /** Số task pass. */
  passed: number;
  /** Tỉ lệ pass 0..1. */
  passRate: number;
  results: V7EvalTaskResult[];
}

/** Model generator do host tiêm: history text → text trả về của model. */
export type V7ModelGenerator = (input: {
  prompt: string;
  history: V7Event[];
  state: V7State;
}) => Promise<string> | string;

/** Kết quả một step stateless (hàm thuần). */
export interface V7StepResult {
  /** Action tiếp theo mà agent chọn (null = không có action, vd chỉ chat). */
  action: V7Action | null;
  /** Text thô model trả về (để ghi log). */
  modelText: string;
  /** Skill đã kích hoạt ở step này (nếu có). */
  skillActivated?: V7SkillActivation;
  /** Verdict bảo mật của action (nếu có action). */
  verdict?: V7SecurityVerdict;
}

/** Kết quả một turn chạy của CodingAgentV7. */
export interface V7TurnResult {
  /** Trạng thái cuối turn. */
  status: V7SessionStatus;
  /** Số step đã chạy trong turn này. */
  steps: number;
  /** Số action đã chạy trong turn này. */
  actionsExecuted: number;
  /** Số action bị chặn trong turn này. */
  blocked: number;
  /** true = turn kết thúc vì agent finish. */
  finished: boolean;
  /** true = turn dừng vì pause (ask / approval / manual). */
  paused: boolean;
  /** Tóm tắt finish (nếu agent finish). */
  finishSummary?: string;
  /** Summary condenser (nếu turn này đã condense). */
  condensed?: V7CondensedSummary;
}

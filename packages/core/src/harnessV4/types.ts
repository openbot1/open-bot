/**
 * Harness v4 — types (v1.08, Đội T3).
 *
 * Ý tưởng học từ survey v1.08 phần OpenHands (chỉ học ý tưởng, không
 * copy code/text/tài sản của bất kỳ repo nào):
 * - EventLog append-only bất biến cho mọi turn: mọi sự kiện ghi vào
 *   log chỉ-thêm-không-sửa, replay được toàn bộ phiên, debug bằng
 *   time-travel (xem lại trạng thái tại bước N, chạy lại từ bước N).
 * - CodeAct: agent viết code thật rồi thực thi trực tiếp trong
 *   sandbox, quan sát output rồi lặp lại.
 * - Dependency sweep cho repo lớn: biết thứ tự thay đổi đúng để
 *   nhiều agent song song không xung đột.
 *
 * Khác với event-log v1.01 (log theo *run* của AgentRunner, payload
 * đã sanitize, hash chain theo run) và harness v3 (V3Conversation
 * giữ event trong bộ nhớ): harness v4 là log theo *phiên làm việc*
 * (session) của một bot, persist JSONL trên đĩa, payload giữ nguyên
 * nội dung cần thiết cho time-travel (không cắt ngắn transcript),
 * và có API fork/resume tường minh để chạy lại từ bước N. Hai hệ
 * log cùng tồn tại, không thay thế nhau.
 */

import type { CodeActAction, CodeActObservation, CodeActResult } from '../codeact/types';

/** Mọi loại event mà EventLog v4 ghi (tiền tố `h4.` để không đụng run log v1). */
export type HarnessV4EventKind =
  | 'h4.session.started'
  | 'h4.user.message'
  | 'h4.model.reply'
  | 'h4.tool.call'
  | 'h4.tool.result'
  | 'h4.codeact.run'
  | 'h4.codeact.loop'
  | 'h4.error'
  | 'h4.checkpoint'
  | 'h4.session.ended';

/** Payload của `h4.session.started`. */
export interface H4SessionStartedPayload {
  botId: string;
  title?: string;
  model?: string;
  /** Phiên cha khi fork/resume từ một phiên khác. */
  parentSessionId?: string;
  /** Seq trong phiên cha mà fork bắt đầu sao chép từ đó. */
  forkFromSeq?: number;
}

/** Payload của `h4.user.message`. */
export interface H4UserMessagePayload {
  text: string;
  step: number;
}

/** Payload của `h4.model.reply`. */
export interface H4ModelReplyPayload {
  step: number;
  text: string;
  /** Tên tool model yêu cầu ở step này (không ghi args). */
  toolCalls?: string[];
  inputTokens?: number;
  outputTokens?: number;
}

/** Payload của `h4.tool.call` / `h4.tool.result`. */
export interface H4ToolPayload {
  callId: string;
  tool: string;
  step: number;
  /** Chỉ `h4.tool.result` có: ok | error | denied. */
  status?: 'ok' | 'error' | 'denied';
  /** Output đã cắt ở giới hạn của log (xem HARNESS_V4_MAX_PAYLOAD_CHARS). */
  outputPreview?: string;
  durationMs?: number;
}

/** Payload của `h4.codeact.run` — một lần chạy CodeAct đã ghi vào log. */
export interface H4CodeActRunPayload {
  /** Id lần chạy (khớp CodeActExecution.id). */
  runId: string;
  step: number;
  actionKind: 'bash' | 'python' | 'edit';
  /** Mô tả ngắn action (không chứa code dài — code nằm ở loop record). */
  summary: string;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  /** 500 ký tự đầu của stdout/stderr gộp lại (đủ để time-travel hiểu). */
  outputPreview: string;
}

/** Payload của `h4.codeact.loop` — kết quả một vòng lặp CodeAct. */
export interface H4CodeActLoopPayload {
  loopId: string;
  step: number;
  rounds: number;
  /** succeeded | failed | timed_out | max_rounds | blocked. */
  outcome: HarnessV4LoopOutcome;
  /** Phân loại lỗi cuối cùng (nếu có). */
  lastErrorKind?: HarnessV4ErrorKind;
  totalDurationMs: number;
}

/** Payload của `h4.error`. */
export interface H4ErrorPayload {
  step: number;
  /** Phân loại lỗi (để UI gợi ý can thiệp). */
  kind: HarnessV4ErrorKind;
  message: string;
  /** Tool / vòng lặp gây ra lỗi (nếu có). */
  source?: string;
}

/** Payload của `h4.checkpoint`. */
export interface H4CheckpointPayload {
  step: number;
  label: string;
  /** Số event đã có tới thời điểm checkpoint (bao gồm event này). */
  upToSeq: number;
}

/** Payload của `h4.session.ended`. */
export interface H4SessionEndedPayload {
  /** completed | failed | aborted. */
  status: 'completed' | 'failed' | 'aborted';
  steps: number;
  toolCalls: number;
  codeActRuns: number;
  errors: number;
  durationMs: number;
  finalText?: string;
  message?: string;
}

/** Map từ loại event v4 sang payload của nó. */
export interface HarnessV4EventPayloadMap {
  'h4.session.started': H4SessionStartedPayload;
  'h4.user.message': H4UserMessagePayload;
  'h4.model.reply': H4ModelReplyPayload;
  'h4.tool.call': H4ToolPayload;
  'h4.tool.result': H4ToolPayload;
  'h4.codeact.run': H4CodeActRunPayload;
  'h4.codeact.loop': H4CodeActLoopPayload;
  'h4.error': H4ErrorPayload;
  'h4.checkpoint': H4CheckpointPayload;
  'h4.session.ended': H4SessionEndedPayload;
}

/** Một event trong EventLog v4. */
export interface HarnessV4Event<K extends HarnessV4EventKind = HarnessV4EventKind> {
  seq: number;
  sessionId: string;
  at: string;
  type: K;
  payload: HarnessV4EventPayloadMap[K];
  /** Hash của event trước trong cùng session ('' ở event đầu tiên). */
  prevHash: string;
  /** SHA-256 hex của event này (tính trên nội dung đã chuẩn hoá). */
  hash: string;
}

/** Union mọi event v4. */
export type AnyHarnessV4Event = {
  [K in HarnessV4EventKind]: HarnessV4Event<K>;
}[HarnessV4EventKind];

/** Dữ liệu cần để tạo một event v4 mới (store tự điền seq/hash). */
export type NewHarnessV4Event<K extends HarnessV4EventKind = HarnessV4EventKind> = {
  type: K;
  payload: HarnessV4EventPayloadMap[K];
  at?: string;
};

/** Kết quả kiểm chứng hash chain của một session. */
export interface HarnessV4Verification {
  sessionId: string;
  ok: boolean;
  eventCount: number;
  firstBadSeq?: number;
  reason?: string;
}

/** Trạng thái một session được tái tạo bằng cách fold event (replay). */
export interface HarnessV4SessionState {
  sessionId: string;
  botId: string;
  status: 'running' | 'completed' | 'failed' | 'aborted';
  title?: string;
  /** Transcript: user/model/tool/codeact theo thứ tự. */
  transcript: HarnessV4TranscriptEntry[];
  toolCalls: HarnessV4ToolCallRecord[];
  codeActRuns: H4CodeActRunPayload[];
  errors: H4ErrorPayload[];
  checkpoints: H4CheckpointPayload[];
  steps: number;
  tokensUsed: number;
  startedAt: string;
  endedAt?: string;
  /** Digest SHA-256 của trạng thái — hai lần replay cùng log phải cho cùng digest. */
  digest: string;
}

/** Một dòng trong transcript tái tạo. */
export type HarnessV4TranscriptEntry =
  | { kind: 'user'; step: number; text: string }
  | { kind: 'model'; step: number; text: string }
  | { kind: 'tool_call'; step: number; callId: string; tool: string }
  | { kind: 'tool_result'; step: number; callId: string; tool: string; status: string; outputPreview: string }
  | { kind: 'codeact'; step: number; runId: string; actionKind: string; exitCode: number | null; outputPreview: string }
  | { kind: 'error'; step: number; message: string };

/** Một tool call trong trạng thái tái tạo. */
export interface HarnessV4ToolCallRecord {
  callId: string;
  tool: string;
  step: number;
  status?: 'ok' | 'error' | 'denied';
  outputPreview?: string;
  durationMs?: number;
}

/** Kết quả time-travel: trạng thái session tại một seq + bối cảnh. */
export interface HarnessV4TimeTravelResult {
  sessionId: string;
  atSeq: number;
  totalSeq: number;
  eventsUsed: number;
  state: HarnessV4SessionState;
  /** Diff số học so với trạng thái cuối (để UI hiện "đã lùi bao nhiêu"). */
  diffVsFinal: HarnessV4StateDiff;
}

/** Diff số học giữa hai trạng thái session đã fold. */
export interface HarnessV4StateDiff {
  stepsDelta: number;
  tokensDelta: number;
  toolCallsDelta: number;
  codeActRunsDelta: number;
  errorsDelta: number;
  transcriptDelta: number;
  statusChanged: boolean;
  summary: string;
}

/** Metadata tóm tắt của một session (đọc từ file log của nó). */
export interface HarnessV4SessionMeta {
  sessionId: string;
  botId: string;
  title?: string;
  status: 'running' | 'completed' | 'failed' | 'aborted';
  startedAt: string;
  endedAt?: string;
  eventCount: number;
  lastSeq: number;
  parentSessionId?: string;
  toolCalls: number;
  codeActRuns: number;
  errors: number;
}

// ---------------------------------------------------------------------------
// CodeAct v4 loop
// ---------------------------------------------------------------------------

/** Phân loại lỗi của một lần chạy CodeAct (để fixer biết sửa kiểu gì). */
export type HarnessV4ErrorKind =
  | 'syntax'
  | 'runtime'
  | 'timeout'
  | 'blocked'
  | 'validation'
  | 'not_found'
  | 'permission'
  | 'unknown';

/** Kết quả của vòng lặp CodeAct v4. */
export type HarnessV4LoopOutcome =
  | 'succeeded'
  | 'failed'
  | 'timed_out'
  | 'max_rounds'
  | 'blocked';

/** Một vòng trong loop: action đã thử + kết quả quan sát được. */
export interface HarnessV4LoopRound {
  round: number;
  action: CodeActAction;
  result: CodeActResult;
  /** Phân loại lỗi của vòng này (undefined khi thành công). */
  errorKind?: HarnessV4ErrorKind;
  /** Gợi ý sửa mà fixer đã dùng để sinh action vòng sau (nếu có). */
  fixHint?: string;
}

/** Kết quả đầy đủ của một vòng lặp CodeAct v4. */
export interface HarnessV4LoopResult {
  loopId: string;
  outcome: HarnessV4LoopOutcome;
  rounds: HarnessV4LoopRound[];
  /** Observation của vòng cuối (thứ agent nhìn thấy). */
  finalObservation: CodeActObservation;
  /** Phân loại lỗi cuối cùng (nếu có). */
  lastErrorKind?: HarnessV4ErrorKind;
  totalDurationMs: number;
  /** true khi dừng vì hết vòng mà chưa thành công. */
  hitMaxRounds: boolean;
}

/** Hàm sửa code: nhận action + observation lỗi, trả action mới hoặc null (= bỏ cuộc). */
export type HarnessV4Fixer = (
  attempt: { round: number; action: CodeActAction; observation: CodeActObservation; errorKind: HarnessV4ErrorKind },
) => Promise<CodeActAction | null> | CodeActAction | null;

/** Giới hạn của vòng lặp CodeAct v4. */
export interface HarnessV4LoopLimits {
  /** Số vòng tối đa (1..20). Mặc định 5. */
  maxRounds: number;
  /** Tổng thời gian tối đa cho cả loop, ms. Mặc định 300_000. */
  totalTimeoutMs: number;
}

/** Giới hạn mặc định của vòng lặp CodeAct v4. */
export const DEFAULT_HARNESS_V4_LOOP_LIMITS: HarnessV4LoopLimits = {
  maxRounds: 5,
  totalTimeoutMs: 300_000,
};

// ---------------------------------------------------------------------------
// Dependency sweep
// ---------------------------------------------------------------------------

/** Một file đầu vào cho dependency sweep (đường dẫn + nội dung). */
export interface HarnessV4SweepFile {
  path: string;
  content: string;
}

/** Một cạnh dependency: `from` phụ thuộc `to` (from import to). */
export interface HarnessV4DependencyEdge {
  from: string;
  to: string;
  /** Loại import: relative (trong repo) — bare import ngoài repo bị bỏ qua. */
  kind: 'relative';
}

/** Đồ thị dependency của một tập file. */
export interface HarnessV4DependencyGraph {
  /** Mọi file trong tập (đã chuẩn hoá đường dẫn, sắp xếp). */
  files: string[];
  edges: HarnessV4DependencyEdge[];
  /** File nào không import ai / không được ai import (điểm bắt đầu an toàn). */
  leaves: string[];
  /** Chu trình import (mỗi chu trình là danh sách file khép kín). */
  cycles: string[][];
  /** File import tới mà không có trong tập (thiếu file / ngoài phạm vi). */
  missing: string[];
  /** Số file bị lược vì quá giới hạn (0 khi không lược). */
  truncatedFiles: number;
}

/** Kết quả thứ tự an toàn: sửa theo từng tầng, tầng trước không phụ thuộc tầng sau. */
export interface HarnessV4SafeOrder {
  /** Thứ tự an toàn đầy đủ (dependency trước, file phụ thuộc sau). */
  order: string[];
  /** Các tầng song song: file cùng tầng không phụ thuộc nhau, sửa cùng lúc được. */
  levels: string[][];
  /** true khi có chu trình — thứ tự chỉ là tốt nhất có thể, không đảm bảo tuyệt đối. */
  hasCycles: boolean;
  /** Chu trình đã gặp (để caller báo rõ). */
  cycles: string[][];
  /** File import tới mà không có trong tập. */
  missing: string[];
}

/** Một agent được giao một tập file. */
export interface HarnessV4Assignment {
  agent: string;
  files: string[];
}

/** Một xung đột giữa hai agent. */
export interface HarnessV4Conflict {
  /** direct = cùng sửa một file; shared_dependency = cùng chạm dependency chung. */
  kind: 'direct' | 'shared_dependency';
  agents: [string, string];
  files: string[];
  detail: string;
  /** Mức độ: high = cùng file, medium = dependency chung. */
  severity: 'high' | 'medium';
}

/** Kết quả phát hiện xung đột cho một tập assignment. */
export interface HarnessV4ConflictReport {
  assignments: HarnessV4Assignment[];
  conflicts: HarnessV4Conflict[];
  /** true khi không có xung đột nào. */
  clean: boolean;
  /** Số cặp agent đã kiểm tra. */
  pairsChecked: number;
}

/** Đề xuất chia việc cho N agent. */
export interface HarnessV4Partition {
  agentCount: number;
  groups: HarnessV4Assignment[];
  /** File chưa xếp được vì nằm trong chu trình (giao cho agent đầu tiên, sửa cuối). */
  cyclicFiles: string[];
  /** Ghi chú cách chia (vd theo tầng topological). */
  rationale: string;
}

/** Kết quả phân tích ảnh hưởng: sửa các file này thì file nào bị ảnh hưởng theo. */
export interface HarnessV4Impact {
  /** File đã đổi (đầu vào, đã chuẩn hoá). */
  changedFiles: string[];
  /** Mọi file bị ảnh hưởng (phụ thuộc trực/gián tiếp vào file đã đổi), theo thứ tự an toàn. */
  affectedFiles: string[];
  /** File phụ thuộc TRỰC TIẾP vào file đã đổi (vòng đầu tiên). */
  directDependents: string[];
  /** Độ sâu ảnh hưởng lớn nhất (số cạnh từ file đã đổi tới file xa nhất). */
  maxDepth: number;
  /** Số file trong tập KHÔNG bị ảnh hưởng. */
  unaffectedCount: number;
}

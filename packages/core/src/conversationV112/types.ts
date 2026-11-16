/**
 * Event-sourced CONVERSATION log (v1.12, Đội T2) — types.
 *
 * Khác với run log ở `event-log/` (một *run* = một lượt chạy của
 * AgentRunner, scope hẹp trong một user turn): module này ghi toàn bộ
 * *conversation* — nhiều turn, nhiều run, nhiều branch — dưới dạng một
 * stream event append-only. Mọi thứ agent làm trong hội thoại đều là
 * event: tin nhắn user/agent, Action (tool call / CodeAct-lite) và
 * Observation (kết quả trả về), skill được nạp theo yêu cầu, branch /
 * snapshot / compaction. State của hội thoại (messages, skill đã nạp,
 * CodeAct ledger, trạng thái) được SUY RA hoàn toàn bằng cách fold
 * dãy event (xem `replay.ts`) — không có state thứ hai nào khác.
 *
 * Ý tưởng học từ OpenHands V1 SDK (event stream Action/Observation):
 * chỉ học ý tưởng (stream typed event bất biến + replay), không copy
 * code/text/tài sản của repo nào.
 *
 * Mọi event đều có:
 * - `seq`: số thứ tự trong conversation, bắt đầu từ 1, tăng đều,
 *   không lỗ hổng (trong một branch; branch con đếm lại từ 1 và ghi
 *   rõ `branchedFrom`).
 * - `conversationId`: id hội thoại sở hữu event.
 * - `branchId`: nhánh (mặc định `'main'`).
 * - `at`: thời điểm ghi (ISO 8601).
 * - `type`: loại event (xem `ConversationEventType`).
 * - `payload`: dữ liệu riêng từng loại — đã redact secret + cắt ngắn
 *   (xem `redact.ts`).
 * - `prevHash` / `hash`: hash chain SHA-256 (xem `canonical.ts`).
 *   Event đầu tiên có `prevHash` là chuỗi rỗng.
 *
 * Giới hạn nói rõ: hash chain chống sửa lén từng event, không chống
 * xoá toàn bộ file log, không phải chữ ký số.
 */

/** Mọi loại event của conversation log. */
export type ConversationEventType =
  | 'conversation.started'
  | 'user.message'
  | 'agent.message'
  | 'action.tool'
  | 'observation.tool'
  | 'action.codeact'
  | 'observation.codeact'
  | 'skill.loaded'
  | 'skill.suggested'
  | 'conversation.branched'
  | 'conversation.snapshot'
  | 'conversation.compacted'
  | 'conversation.ended';

/** Trạng thái cuối cùng (hoặc hiện tại) của một conversation. */
export type ConversationStatus =
  | 'active'
  | 'branched'
  | 'ended'
  | 'compacted';

/** Vai của một message trong state đã fold. */
export type ConversationMessageRole = 'user' | 'agent' | 'system';

/** Một message trong state đã fold (nội dung đã redact + cắt ngắn lúc ghi). */
export interface ConversationMessage {
  role: ConversationMessageRole;
  text: string;
  /** Seq của event đã sinh ra message này. */
  seq: number;
  at: string;
  /** Id tool call đang chờ kết quả (chỉ message agent kèm tool call). */
  toolCallId?: string;
}

/** Payload của `conversation.started`. */
export interface ConversationStartedPayload {
  /** Bot sở hữu conversation. */
  botId: string;
  /** Tiêu đề ngắn (vd 200 ký tự đầu của message đầu tiên). */
  title?: string;
  /** Model/provider đã route lúc bắt đầu (nếu có). */
  model?: string;
  providerId?: string;
  /** Conversation cha — chỉ có khi conversation này là branch. */
  parentConversationId?: string;
  /** Seq trong conversation cha mà branch bắt đầu sao chép từ đó. */
  branchedFromSeq?: number;
  /** Nhánh cha (thường 'main'). */
  parentBranchId?: string;
}

/** Payload của `user.message` / `agent.message`. */
export interface ConversationMessagePayload {
  /** Nội dung message (đã redact + cắt ngắn). */
  text: string;
  /** Số ký tự gốc trước khi cắt (để biết message đã bị cắt ngắn). */
  originalChars?: number;
  /** Có ảnh/file đính kèm hay không (không ghi nội dung). */
  hasAttachments?: boolean;
  /** Tool call model yêu cầu kèm message agent (chưa chạy). */
  toolCalls?: Array<{ callId: string; tool: string; argKeys: string[] }>;
}

/** Payload của `action.tool`. */
export interface ConversationToolActionPayload {
  callId: string;
  tool: string;
  /** Tên các key của args — không ghi value (tránh lộ secret/dữ liệu). */
  argKeys: string[];
  /** Step trong turn hiện tại (0-based, nếu session biết). */
  step?: number;
  /** Skill nào đã yêu cầu tool này (nếu có). */
  skillName?: string;
}

/** Payload của `observation.tool`. */
export interface ConversationToolObservationPayload {
  callId: string;
  tool: string;
  status: 'ok' | 'error' | 'denied';
  /** Output đã redact + cắt ngắn. */
  outputPreview: string;
  durationMs: number;
  /** True khi output đã bị cắt ngắn. */
  truncated?: boolean;
}

/** Payload của `action.codeact` (CodeAct-lite: code block trích từ text agent). */
export interface ConversationCodeActActionPayload {
  /** Id lần chạy (khớp với observation sau đó). */
  executionId: string;
  /** Loại code: bash | python. */
  kind: 'bash' | 'python';
  /** Code/lệnh đã chạy (đã redact + cắt ngắn ở mức lưu trữ). */
  codePreview: string;
  /** Số ký tự code gốc. */
  codeChars: number;
  /** Chỉ số thứ tự của action CodeAct trong turn hiện tại (1-based). */
  actionIndex: number;
  /** Lý do policy (nếu action này bị chặn thì không có observation chạy). */
  blockedReason?: string;
}

/** Payload của `observation.codeact`. */
export interface ConversationCodeActObservationPayload {
  executionId: string;
  kind: 'bash' | 'python';
  exitCode: number | null;
  stdoutPreview: string;
  stderrPreview: string;
  timedOut: boolean;
  truncated: boolean;
  durationMs: number;
  /** True khi action bị chặn bởi policy (không chạy thật). */
  blocked?: boolean;
  blockedReason?: string;
}

/** Payload của `skill.loaded` / `skill.suggested`. */
export interface ConversationSkillPayload {
  /** Tên skill (khớp tên file trong `.openbot/skills/`). */
  name: string;
  /** Phiên bản skill (frontmatter `version`, mặc định 1.0.0). */
  version?: string;
  /** Cách skill được nạp: user yêu cầu / model đề xuất / trigger khớp. */
  source: 'user' | 'model' | 'trigger';
  /** Số ký tự body đã inject vào prompt (sau khi cắt). */
  injectedChars?: number;
  /** Điểm khớp trigger (chỉ `skill.suggested`). */
  score?: number;
}

/** Payload của `conversation.branched`. */
export interface ConversationBranchedPayload {
  /** Id conversation mới (branch con). */
  childConversationId: string;
  /** Seq trong conversation hiện tại mà branch bắt đầu sao chép từ đó. */
  fromSeq: number;
  /** Nhánh của branch con (mặc định 'main'). */
  childBranchId?: string;
  /** Lý do branch (vd 'thử hướng khác', 'quay lại seq 12'). */
  reason?: string;
}

/** Payload của `conversation.snapshot`. */
export interface ConversationSnapshotPayload {
  /** Tên file snapshot (tương đối trong thư mục snapshot). */
  file: string;
  /** Seq cuối cùng đã đưa vào snapshot. */
  throughSeq: number;
  /** Số message trong snapshot. */
  messageCount: number;
  /** SHA-256 của nội dung snapshot (để verify khi restore). */
  sha256: string;
}

/** Payload của `conversation.compacted`. */
export interface ConversationCompactedPayload {
  /** Seq cuối cùng đã gộp vào snapshot trước khi cắt log. */
  throughSeq: number;
  /** Số event đã cắt khỏi đầu log. */
  removedEvents: number;
  /** File snapshot neo lại sau compaction. */
  snapshotFile: string;
}

/** Payload của `conversation.ended`. */
export interface ConversationEndedPayload {
  /** Lý do kết thúc: user đóng / hết hạn / lỗi. */
  reason: 'user-closed' | 'expired' | 'error';
  /** Số event tổng cộng trong conversation lúc kết thúc. */
  totalEvents: number;
  /** Số message tổng cộng. */
  totalMessages: number;
}

/** Union payload theo từng loại event. */
export type ConversationEventPayload =
  | ConversationStartedPayload
  | ConversationMessagePayload
  | ConversationToolActionPayload
  | ConversationToolObservationPayload
  | ConversationCodeActActionPayload
  | ConversationCodeActObservationPayload
  | ConversationSkillPayload
  | ConversationBranchedPayload
  | ConversationSnapshotPayload
  | ConversationCompactedPayload
  | ConversationEndedPayload;

/** Map type → payload (để `record()` kiểm tra kiểu ở compile time). */
export interface ConversationPayloadByType {
  'conversation.started': ConversationStartedPayload;
  'user.message': ConversationMessagePayload;
  'agent.message': ConversationMessagePayload;
  'action.tool': ConversationToolActionPayload;
  'observation.tool': ConversationToolObservationPayload;
  'action.codeact': ConversationCodeActActionPayload;
  'observation.codeact': ConversationCodeActObservationPayload;
  'skill.loaded': ConversationSkillPayload;
  'skill.suggested': ConversationSkillPayload;
  'conversation.branched': ConversationBranchedPayload;
  'conversation.snapshot': ConversationSnapshotPayload;
  'conversation.compacted': ConversationCompactedPayload;
  'conversation.ended': ConversationEndedPayload;
}

/** Một event bất biến trong conversation log. */
export interface ConversationEvent<T extends ConversationEventType = ConversationEventType> {
  seq: number;
  conversationId: string;
  branchId: string;
  at: string;
  type: T;
  payload: T extends keyof ConversationPayloadByType
    ? ConversationPayloadByType[T]
    : ConversationEventPayload;
  prevHash: string;
  hash: string;
}

/** Bất kỳ event nào của conversation (dùng khi đọc từ đĩa). */
export type AnyConversationEvent = ConversationEvent<ConversationEventType>;

/** State của một conversation, suy ra bằng cách fold dãy event. */
export interface ConversationState {
  conversationId: string;
  branchId: string;
  botId: string;
  title?: string;
  model?: string;
  providerId?: string;
  status: ConversationStatus;
  /** Seq cao nhất đã fold. */
  lastSeq: number;
  /** Thời điểm event cuối cùng. */
  lastAt?: string;
  /** Hash của event cuối cùng (để verify tiếp nối khi append). */
  lastHash: string;
  messages: ConversationMessage[];
  /** Tool call đã ghi action nhưng chưa có observation. */
  pendingToolCalls: Array<{ callId: string; tool: string; seq: number }>;
  /** CodeAct action đã ghi nhưng chưa có observation. */
  pendingCodeAct: Array<{ executionId: string; kind: 'bash' | 'python'; seq: number }>;
  /** Skill đã nạp (theo thứ tự nạp), kèm số ký tự đã inject. */
  loadedSkills: Array<{ name: string; version?: string; injectedChars: number; seq: number }>;
  /** Số lần chạy CodeAct (đã có observation). */
  codeActRuns: number;
  /** Số CodeAct action bị policy chặn. */
  codeActBlocked: number;
  /** Số tool call đã hoàn thành (có observation). */
  toolCallsCompleted: number;
  /** Tổng số event theo từng loại (để thống kê nhanh). */
  eventCounts: Partial<Record<ConversationEventType, number>>;
  /** Branch con đã tạo từ conversation này. */
  branches: Array<{ childConversationId: string; fromSeq: number; at: string }>;
  /** Snapshot gần nhất (nếu có). */
  latestSnapshot?: { file: string; throughSeq: number; sha256: string; at: string };
  /** Conversation cha (khi đây là branch). */
  parentConversationId?: string;
  branchedFromSeq?: number;
}

/** State rỗng ban đầu cho một conversation (trước event đầu tiên). */
export function emptyConversationState(
  conversationId: string,
  branchId = 'main',
): ConversationState {
  return {
    conversationId,
    branchId,
    botId: '',
    status: 'active',
    lastSeq: 0,
    lastHash: '',
    messages: [],
    pendingToolCalls: [],
    pendingCodeAct: [],
    loadedSkills: [],
    codeActRuns: 0,
    codeActBlocked: 0,
    toolCallsCompleted: 0,
    eventCounts: {},
    branches: [],
  };
}

/** Tên file an toàn cho một conversationId (tránh path traversal). */
export function safeConversationFileName(conversationId: string): string {
  const safe = conversationId.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 128) || 'conversation';
  return `${safe}.jsonl`;
}

/** Giới hạn lưu trữ mặc định của conversation log. */
export const CONVERSATION_V112_DEFAULTS = {
  /** Message text tối đa giữ lại mỗi event, ký tự. */
  maxMessageChars: 8000,
  /** Output tool/CodeAct tối đa giữ lại mỗi observation, ký tự. */
  maxOutputChars: 4000,
  /** Code preview tối đa giữ lại mỗi action CodeAct, ký tự. */
  maxCodePreviewChars: 2000,
  /** Kích thước file log tối đa trước khi store từ chối append, bytes. */
  maxFileBytes: 16 * 1024 * 1024,
  /** Số event tối đa giữ trong một file log (0 = không giới hạn số lượng). */
  maxEvents: 0,
} as const;

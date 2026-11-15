/**
 * Harness v3 — types (v1.07, Đội T2).
 *
 * Ý tưởng học từ survey v1.07 phần 1 (OpenHands v1.38 V1 SDK — chỉ học
 * ý tưởng, không copy code/text/tài sản của repo nào):
 *
 *   Agent (stateless, phát Action) + Conversation (chạy vòng lặp, lưu
 *   append-only EventLog) + Workspace (thực thi Action, trả
 *   Observation) + LLM (đổi provider tự do qua profile).
 *
 * QUYẾT ĐỊNH KIẾN TRÚC — KHÔNG CÓ CONTROLLER TRUNG GIAN:
 * OpenHands V1 bỏ AgentController vì "không xứng đáng với sự phức tạp":
 * vòng lặp + event log đã đủ. open-bot cũng vậy — `V3Conversation`
 * (conversation.ts) CHÍNH LÀ vòng lặp; `LocalHarness` (harness.ts)
 * vẫn giữ vai trò cũ của nó (registry instance + event bus + NDJSON
 * log + permission broker) và KHÔNG trở thành controller của vòng lặp
 * này. Hai tầng sống song song, không chồng nhau:
 *
 *   - LocalHarness: quản lý process/CLI driver đang sống + bus event
 *     + log NDJSON theo thread + broker duyệt permission.
 *   - V3Conversation: quản lý MỘT turn hội thoại — agent quyết định
 *     gì, workspace thực thi ra sao, event nào được ghi, budget còn
 *     bao nhiêu, critic nói gì. Không spawn process, không giữ
 *     credential, không biết CLI driver là gì.
 *
 * Nối tiếp, không viết lại: module này KHÔNG thay `agent/loop.ts`
 * (AgentRunner, vòng lặp production hiện tại) và KHÔNG thay
 * `event-log/RunLogStore` (log có hash chain cho audit). V3 là vòng
 * lặp gọn, nhẹ, dùng được độc lập (headless, eval, sub-agent) và cho
 * các bot mới; AgentRunner vẫn là đường chạy chính của desktop cho
 * tới khi coordinator quyết định chuyển. Mọi event V3 đều có thể
 * forward sang `LocalHarness.publishLoopEvent` (xem conversation.ts)
 * nên log NDJSON + bus hiện có vẫn thấy được turn V3.
 *
 * Event log V3 là append-only trong bộ nhớ (mảng `events`, seq tăng
 * đều từ 1, không sửa event cũ — muốn sửa thì append event mới).
 * Muốn bền vững qua restart thì host ghi `snapshot()` xuống đĩa
 * (JSON) rồi `restore()` lại; hash chain/audit đầy đủ vẫn thuộc về
 * RunLogStore, không nhân đôi ở đây.
 */

import type { CriticReport } from './critic';
import type { V3BudgetSnapshot } from './budget';
import type { DelegationRecord } from './delegation';

/** Các loại Action mà một V3 agent stateless có thể phát ra. */
export type V3ActionKind = 'message' | 'tool_call' | 'delegate' | 'finish';

/**
 * Một Action do agent phát ra. Agent là stateless: nó chỉ nhìn
 * `V3AgentState` (lịch sử rút gọn) rồi trả về Action tiếp theo, không
 * giữ gì giữa các lần gọi — mọi trạng thái sống trong Conversation.
 */
export interface V3Action {
  kind: V3ActionKind;
  /** Text khi kind = 'message' (nói với user) hoặc 'finish' (kết quả cuối). */
  text?: string;
  /** Tên tool khi kind = 'tool_call'. */
  tool?: string;
  /** Args tool (JSON thuần). */
  args?: Record<string, unknown>;
  /** Task giao cho sub-agent khi kind = 'delegate'. */
  task?: string;
  /** Vai trò sub-agent gợi ý (vd 'researcher', 'reviewer'). */
  role?: string;
  /** Lý do agent chọn action này (ghi log, giúp debug vòng lặp). */
  reason?: string;
}

/** Kết quả thực thi một Action trong Workspace. */
export interface V3Observation {
  /** 'ok' | 'error' | 'denied' (bị policy/approval chặn) | 'timeout'. */
  status: 'ok' | 'error' | 'denied' | 'timeout';
  /** Nội dung trả về (đã cắt ngắn bởi workspace khi quá dài). */
  output: string;
  /** Thời gian thực thi (ms). */
  durationMs: number;
  /** File đã đổi (khi action ghi file). */
  changedFiles?: string[];
  /** Tên tool đã chạy (khi action là tool_call). */
  tool?: string;
}

/**
 * Workspace thực thi Action và trả Observation. Host tự cài đặt:
 * nối vào tool registry hiện có, vào sandbox, hoặc vào một
 * workspace local giả trong test. V3 không ép một workspace cụ thể —
 * chỉ cần contract này.
 */
export interface V3Workspace {
  /**
   * Thực thi một Action. Không throw vì tool lỗi — trả Observation
   * status 'error' để vòng lặp tự quyết (retry / đổi hướng / dừng).
   * Chỉ throw khi workspace hỏng hẳn (vd mất thư mục làm việc).
   */
  execute(action: V3Action): Promise<V3Observation>;
}

/** Trạng thái rút gọn mà agent stateless nhìn thấy ở mỗi step. */
export interface V3AgentState {
  /** Id conversation. */
  conversationId: string;
  /** Prompt gốc của user cho turn này. */
  userPrompt: string;
  /** Step hiện tại (0-based). */
  step: number;
  /** Số step tối đa cho phép. */
  maxSteps: number;
  /** Các cặp Action → Observation đã chạy trong turn (rút gọn). */
  history: Array<{ action: V3Action; observation: V3Observation }>;
  /** Message cuối agent đã nói (khi có). */
  lastMessage?: string;
  /** Budget snapshot mới nhất (khi conversation có meter). */
  budget?: V3BudgetSnapshot;
}

/**
 * Agent stateless: nhìn state, phát Action. Không giữ field mutable
 * giữa các lần gọi (muốn nhớ thì ghi vào event log của Conversation).
 * Host có thể cài bằng LLM thật (gọi provider, parse tool call) hoặc
 * bằng agent giả trong test/scripted eval.
 */
export interface V3Agent {
  /** Tên agent (ghi log, hiển thị). */
  name: string;
  /** Phát Action tiếp theo cho state hiện tại. */
  decide(state: V3AgentState): Promise<V3Action>;
}

/** Các loại event trong EventLog append-only của V3Conversation. */
export type V3EventType =
  | 'turn.started'
  | 'user.message'
  | 'agent.action'
  | 'workspace.observation'
  | 'agent.message'
  | 'delegation.started'
  | 'delegation.completed'
  | 'critic.report'
  | 'budget.warning'
  | 'turn.completed'
  | 'turn.failed'
  | 'turn.stopped';

/** Một event bất biến trong EventLog của conversation. */
export interface V3ConversationEvent {
  /** Số thứ tự trong conversation, bắt đầu từ 1, tăng đều, không lỗ hổng. */
  seq: number;
  /** Thời điểm ghi (ISO 8601). */
  at: string;
  type: V3EventType;
  /** Dữ liệu riêng từng loại (đã cắt ngắn, không chứa secret). */
  payload: V3EventPayload;
}

/** Payload từng loại event (union có phân biệt theo `type`). */
export type V3EventPayload =
  | { kind: 'turn.started'; userPrompt: string; maxSteps: number }
  | { kind: 'user.message'; text: string }
  | { kind: 'agent.action'; step: number; action: V3Action }
  | { kind: 'workspace.observation'; step: number; observation: V3Observation }
  | { kind: 'agent.message'; step: number; text: string }
  | {
      kind: 'delegation.started';
      step: number;
      delegationId: string;
      task: string;
      role?: string;
    }
  | {
      kind: 'delegation.completed';
      step: number;
      delegationId: string;
      record: DelegationRecord;
    }
  | { kind: 'critic.report'; step: number; report: CriticReport }
  | { kind: 'budget.warning'; step: number; snapshot: V3BudgetSnapshot; message: string }
  | {
      kind: 'turn.completed';
      steps: number;
      finishReason: V3TurnFinishReason;
      finalText?: string;
    }
  | { kind: 'turn.failed'; steps: number; error: string }
  | { kind: 'turn.stopped'; steps: number; reason: string };

/** Lý do turn kết thúc (ghi vào `turn.completed`). */
export type V3TurnFinishReason =
  | 'agent_finished'
  | 'max_steps'
  | 'budget_exceeded'
  | 'workspace_failed'
  | 'agent_failed'
  | 'stopped';

/** Trạng thái hiện tại của một conversation (fold từ EventLog). */
export interface V3ConversationState {
  conversationId: string;
  /** 'idle' = chưa chạy turn nào / turn trước đã xong. */
  status: 'idle' | 'running' | 'completed' | 'failed' | 'stopped';
  /** Số event đã ghi. */
  eventCount: number;
  /** Seq cuối cùng (0 khi chưa có event). */
  lastSeq: number;
  /** Số step đã chạy trong turn hiện tại. */
  steps: number;
  /** Text kết quả cuối (khi agent finish). */
  finalText?: string;
  /** Lý do kết thúc turn gần nhất. */
  finishReason?: V3TurnFinishReason;
}

/** Kết quả một turn chạy qua V3Conversation. */
export interface V3TurnResult {
  conversationId: string;
  finishReason: V3TurnFinishReason;
  steps: number;
  /** Text kết quả cuối (undefined khi dừng vì max_steps/budget/lỗi). */
  finalText?: string;
  /** Số event đã ghi trong turn này. */
  eventsAppended: number;
  /** Critic report cuối (khi có critic + turn chạy tới finish). */
  critic?: CriticReport;
  /** Budget snapshot cuối (khi conversation có meter). */
  budget?: V3BudgetSnapshot;
}

/** Snapshot JSON của toàn bộ conversation (để persist/restore). */
export interface V3ConversationSnapshot {
  version: 1;
  conversationId: string;
  createdAt: string;
  events: V3ConversationEvent[];
}

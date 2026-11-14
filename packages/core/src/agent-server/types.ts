/**
 * Agent server v2 — types (v1.04, Đội T4).
 *
 * REST server chuyên conversations, treo trên event log:
 * - Mỗi conversation = một run trong `RunLogStore` (runId = conversation id).
 * - Trạng thái conversation suy ra từ log (fold), không lưu trạng thái
 *   riêng — server restart thì đọc lại log là có đủ.
 * - Server CHỈ bind `127.0.0.1` (loopback-only) + Bearer token sinh
 *   ngẫu nhiên mỗi lần khởi động (không lưu đĩa). Không cloud, không
 *   tài khoản, không thanh toán — local-first theo hướng đứng của Huy.
 */

import type { CondenseStrategyV2 } from '../event-log/condenser-v2';
import type { RunEventQuery, RunStatus } from '../event-log/types';

/** Phiên bản API của agent server v2. */
export const AGENT_SERVER_API_VERSION = 'v2';

/** Tùy chọn khởi động agent server v2. */
export interface AgentServerV2Options {
  /** Thư mục chứa run log (RunLogStore logDir). Bắt buộc. */
  logDir: string;
  /** Port lắng nghe. Mặc định 0 = chọn port trống. */
  port?: number;
  /**
   * Host bind. Mặc định `127.0.0.1`. Chỉ chấp nhận loopback
   * (`127.0.0.1` hoặc `::1`) — host khác bị từ chối ngay lúc khởi động.
   */
  host?: string;
  /**
   * Bearer token. Không set = sinh ngẫu nhiên, trả về trong handle để
   * caller dùng (không lưu đĩa, restart là token mới).
   */
  token?: string;
  /** Khoảng poll store cho SSE stream, ms. Mặc định 250. */
  ssePollMs?: number;
  /** Heartbeat SSE, ms. Mặc định 15_000. */
  sseHeartbeatMs?: number;
  /** Body JSON tối đa, bytes. Mặc định 1 MB. */
  maxBodyBytes?: number;
  /** Bot mặc định khi tạo conversation không ghi botId. */
  defaultBotId?: string;
}

/** Handle của server đang chạy (để caller lấy port/token + đóng). */
export interface AgentServerHandle {
  host: string;
  port: number;
  /** URL gốc (vd `http://127.0.0.1:12345`). */
  url: string;
  /** Bearer token của server này. */
  token: string;
  /** Đóng server (đợi connection đang mở xong hoặc ép đóng). */
  close(): Promise<void>;
}

/** Input tạo conversation mới. */
export interface CreateConversationInput {
  /** Bot chạy conversation (mặc định `defaultBotId` hoặc `default-bot`). */
  botId?: string;
  /** Prompt đầu tiên của user. Bắt buộc, không rỗng. */
  prompt: string;
  /** Tiêu đề ngắn (mặc định = 120 ký tự đầu của prompt). */
  title?: string;
  /** Model đã route (ghi vào event started để audit). */
  model?: string;
  /** Số step tối đa của run. */
  maxSteps?: number;
}

/** Một conversation (trạng thái suy ra từ run log). */
export interface AgentServerConversation {
  /** Id conversation = runId trong event log. */
  id: string;
  botId: string;
  title?: string;
  status: RunStatus;
  /** Prompt gốc của user. */
  prompt: string;
  createdAt: string;
  endedAt?: string;
  eventCount: number;
  lastSeq: number;
  steps: number;
  toolCalls: number;
  tokensUsed: number;
  /** Run cha (khi conversation này được fork ra). */
  parentRunId?: string;
  /** Seq trong run cha mà fork bắt đầu. */
  forkFromSeq?: number;
}

/** Input gửi message vào conversation đang chạy. */
export interface SendMessageInput {
  /** Nội dung message (ghi thành event `run.prompt`). */
  text: string;
}

/** Input pause/resume/cancel. */
export interface ConversationControlInput {
  reason?: string;
  message?: string;
}

/** Input fork conversation tại một seq. */
export interface ForkConversationInput {
  /** Seq trong conversation cha để fork (mặc định = seq cuối). */
  atSeq?: number;
}

/** Input nén conversation (condenser v2). */
export interface CondenseConversationInput {
  strategy?: CondenseStrategyV2;
  upToSeq?: number;
}

/** Query đọc event của conversation (dùng lại `RunEventQuery`). */
export type ConversationEventsQuery = RunEventQuery;

/** Lỗi HTTP của agent server (để handler map thành status). */
export class AgentServerError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'AgentServerError';
  }
}

/** 404 — conversation không tồn tại. */
export function conversationNotFound(runId: string): AgentServerError {
  return new AgentServerError(404, `Không tìm thấy conversation ${runId}.`);
}

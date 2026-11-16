/**
 * Adapter nối conversation log v112 vào agent loop hiện có (Đội T2).
 *
 * KHÔNG sửa `agent/loop.ts`: adapter implement đúng các interface
 * loop đã định nghĩa để coordinator truyền vào `AgentRunnerOptions`
 * mà không đổi code loop:
 *
 * - `toToolCallRecorder(session)` → `ToolCallRecorder` (loop gọi
 *   `record()` một lần cho mỗi tool call đã chạy, kèm cả timing +
 *   status + result preview): adapter ghi cặp event
 *   `action.tool` + `observation.tool` vào conversation log.
 *   Recorder là best-effort theo hợp đồng của loop: lỗi ghi log
 *   KHÔNG BAO GIỜ throw vào run (nuốt lỗi, đếm vào `dropped`).
 * - `ConversationLoopAdapter` → ghi user message / model response /
 *   kết thúc turn vào cùng conversation (host gọi ở các điểm loop
 *   đã có harnessSink/runLogSink).
 *
 * Vì loop nuốt lỗi sink, adapter cũng nuốt lỗi — nhưng vẫn đếm
 * `dropped` để host biết log đang rơi event (quan sát được qua
 * `droppedCount`, không im lặng hoàn toàn).
 */

import type { ToolCallRecorder } from '../agent/loop';
import type { ConversationV112Session } from './session';

/** Arg keys trích từ args_json (chỉ lấy tên key, không ghi value). */
export function argKeysFromJson(argsJson: string): string[] {
  try {
    const parsed: unknown = JSON.parse(argsJson);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return Object.keys(parsed as Record<string, unknown>);
    }
    return [];
  } catch {
    return [];
  }
}

/**
 * Adapter `ToolCallRecorder` cho session: mỗi `record()` ghi một cặp
 * action/observation. Lỗi ghi log được nuốt (hợp đồng loop) và đếm.
 */
export function toToolCallRecorder(session: ConversationV112Session): ToolCallRecorder & {
  /** Số record đã rơi do lỗi ghi log. */
  droppedCount: number;
} {
  let dropped = 0;
  const recorder = {
    get droppedCount() {
      return dropped;
    },
    record(record: {
      tool_call_id: string;
      tool_name: string;
      args_json: string;
      started_at_ms?: number;
      completed_at_ms?: number;
      status?: 'ok' | 'error' | 'denied';
      result_preview?: string;
    }): void {
      try {
        session.recordToolCall(record.tool_call_id, record.tool_name, argKeysFromJson(record.args_json));
        const durationMs =
          record.started_at_ms !== undefined && record.completed_at_ms !== undefined
            ? Math.max(0, record.completed_at_ms - record.started_at_ms)
            : 0;
        session.recordToolResult(
          record.tool_call_id,
          record.tool_name,
          record.status ?? 'ok',
          record.result_preview ?? '',
          durationMs,
        );
      } catch {
        dropped += 1;
      }
    },
  };
  return recorder;
}

/** Adapter ghi các điểm mốc của turn vào conversation log (best-effort). */
export class ConversationLoopAdapter {
  private readonly session: ConversationV112Session;
  private dropped = 0;

  constructor(session: ConversationV112Session) {
    this.session = session;
  }

  /** Số lần ghi đã rơi do lỗi. */
  get droppedCount(): number {
    return this.dropped;
  }

  /** Ghi tin nhắn user bắt đầu turn. */
  onUserMessage(text: string): void {
    try {
      this.session.recordUserMessage(text);
    } catch {
      this.dropped += 1;
    }
  }

  /** Ghi response của model (kèm tool call model yêu cầu). */
  onModelResponse(
    text: string,
    toolCalls?: Array<{ callId: string; tool: string; argKeys: string[] }>,
  ): void {
    try {
      this.session.recordAgentMessage(text, toolCalls);
    } catch {
      this.dropped += 1;
    }
  }

  /**
   * Chạy CodeAct-lite trên text agent vừa trả về (trích code block
   * → chạy trong box → ghi event). Trả về số run đã ghi (0 khi text
   * không có code block — không throw, vì không phải turn nào agent
   * cũng viết code).
   */
  async onAgentTextMaybeCodeAct(text: string): Promise<number> {
    try {
      const runs = await this.session.runCodeActText(text);
      return runs.length;
    } catch (err) {
      // Không có code block / chưa bind executor / code quá dài:
      // không phải lỗi của turn — chỉ đếm rơi khi lỗi ghi log thật.
      if ((err as Error).message.includes('chưa bind executor')) this.dropped += 1;
      return 0;
    }
  }

  /** Ghi kết thúc turn (không kết thúc conversation — chỉ là mốc). */
  onTurnEnd(): void {
    // Turn end không có event riêng trong v112 (tránh phình log);
    // mốc này giữ lại để host móc thêm sau này nếu cần.
  }
}

/**
 * Trả về phần options của AgentRunner để nối conversation log:
 * coordinator chỉ cần spread vào `AgentRunnerOptions`:
 *
 *   const runner = new AgentRunner({
 *     bot, events,
 *     ...attachConversationV112ToRunner(session),
 *   });
 */
export function attachConversationV112ToRunner(
  session: ConversationV112Session,
): { toolCallRecorder: ToolCallRecorder } {
  return { toolCallRecorder: toToolCallRecorder(session) };
}

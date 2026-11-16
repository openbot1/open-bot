/**
 * Replay cho conversation log v112 (Đội T2).
 *
 * `foldConversationEvents` là hàm thuần: cùng một dãy event luôn cho
 * cùng một state (không đọc đĩa, không random, không thời gian hiện
 * tại) — replay hai lần cho cùng một kết quả, test kiểm tra điều này.
 *
 * Luật fold (mỗi loại event làm gì với state):
 * - `conversation.started` → botId/title/model/branch, status active.
 * - `user.message` / `agent.message` → thêm message (toolCalls kèm
 *   agent message được ghi vào pendingToolCalls).
 * - `action.tool` → thêm pending tool call.
 * - `observation.tool` → xoá pending (khớp callId), tăng
 *   toolCallsCompleted.
 * - `action.codeact` → thêm pending CodeAct; bị chặn (blockedReason)
 *   thì tăng codeActBlocked ngay, không chờ observation.
 * - `observation.codeact` → xoá pending, tăng codeActRuns (trừ khi
 *   blocked — khi đó đã đếm ở action).
 * - `skill.loaded` → thêm vào loadedSkills (nạp lại cùng skill thì
 *   cập nhật injectedChars/seq, không trùng tên).
 * - `skill.suggested` → không đổi state (chỉ ghi nhận gợi ý).
 * - `conversation.branched` → thêm vào branches, status 'branched'.
 * - `conversation.snapshot` → cập nhật latestSnapshot.
 * - `conversation.compacted` → status 'compacted' (sau đó event mới
 *   vẫn fold bình thường; status quay lại 'active' khi có event
 *   message/action mới — xem ghi chú dưới).
 * - `conversation.ended` → status 'ended'.
 *
 * Sau `conversation.compacted`, event tiếp theo là message/action sẽ
 * đặt status về 'active' (compaction là trạng thái tạm, không phải
 * trạng thái cuối) — giống cách run log coi compact là checkpoint.
 */

import type {
  AnyConversationEvent,
  ConversationState,
  ConversationStatus,
} from './types';
import { emptyConversationState } from './types';

/** Fold một event vào state (mutate state truyền vào, trả về chính nó). */
export function foldConversationEvent(
  state: ConversationState,
  event: AnyConversationEvent,
): ConversationState {
  state.lastSeq = event.seq;
  state.lastAt = event.at;
  state.lastHash = event.hash;
  state.eventCounts[event.type] = (state.eventCounts[event.type] ?? 0) + 1;

  switch (event.type) {
    case 'conversation.started': {
      const payload = event.payload as {
        botId: string;
        title?: string;
        model?: string;
        providerId?: string;
        parentConversationId?: string;
        branchedFromSeq?: number;
      };
      state.botId = payload.botId;
      if (payload.title !== undefined) state.title = payload.title;
      if (payload.model !== undefined) state.model = payload.model;
      if (payload.providerId !== undefined) state.providerId = payload.providerId;
      if (payload.parentConversationId !== undefined) {
        state.parentConversationId = payload.parentConversationId;
      }
      if (payload.branchedFromSeq !== undefined) {
        state.branchedFromSeq = payload.branchedFromSeq;
      }
      state.status = 'active';
      break;
    }
    case 'user.message': {
      const payload = event.payload as { text: string };
      state.messages.push({ role: 'user', text: payload.text, seq: event.seq, at: event.at });
      if (state.status === 'compacted') state.status = 'active';
      break;
    }
    case 'agent.message': {
      const payload = event.payload as {
        text: string;
        toolCalls?: Array<{ callId: string; tool: string; argKeys: string[] }>;
      };
      const firstCall = payload.toolCalls?.[0];
      state.messages.push({
        role: 'agent',
        text: payload.text,
        seq: event.seq,
        at: event.at,
        toolCallId: firstCall?.callId,
      });
      for (const call of payload.toolCalls ?? []) {
        if (!state.pendingToolCalls.some((pending) => pending.callId === call.callId)) {
          state.pendingToolCalls.push({ callId: call.callId, tool: call.tool, seq: event.seq });
        }
      }
      if (state.status === 'compacted') state.status = 'active';
      break;
    }
    case 'action.tool': {
      const payload = event.payload as { callId: string; tool: string };
      if (!state.pendingToolCalls.some((pending) => pending.callId === payload.callId)) {
        state.pendingToolCalls.push({ callId: payload.callId, tool: payload.tool, seq: event.seq });
      }
      if (state.status === 'compacted') state.status = 'active';
      break;
    }
    case 'observation.tool': {
      const payload = event.payload as { callId: string };
      const idx = state.pendingToolCalls.findIndex((pending) => pending.callId === payload.callId);
      if (idx >= 0) state.pendingToolCalls.splice(idx, 1);
      state.toolCallsCompleted += 1;
      break;
    }
    case 'action.codeact': {
      const payload = event.payload as {
        executionId: string;
        kind: 'bash' | 'python';
        blockedReason?: string;
      };
      if (payload.blockedReason) {
        state.codeActBlocked += 1;
      } else if (!state.pendingCodeAct.some((pending) => pending.executionId === payload.executionId)) {
        state.pendingCodeAct.push({ executionId: payload.executionId, kind: payload.kind, seq: event.seq });
      }
      if (state.status === 'compacted') state.status = 'active';
      break;
    }
    case 'observation.codeact': {
      const payload = event.payload as { executionId: string; blocked?: boolean };
      const idx = state.pendingCodeAct.findIndex(
        (pending) => pending.executionId === payload.executionId,
      );
      if (idx >= 0) state.pendingCodeAct.splice(idx, 1);
      if (!payload.blocked) state.codeActRuns += 1;
      break;
    }
    case 'skill.loaded': {
      const payload = event.payload as {
        name: string;
        version?: string;
        injectedChars?: number;
      };
      const existing = state.loadedSkills.find((skill) => skill.name === payload.name);
      if (existing) {
        existing.injectedChars = payload.injectedChars ?? existing.injectedChars;
        existing.seq = event.seq;
        if (payload.version !== undefined) existing.version = payload.version;
      } else {
        state.loadedSkills.push({
          name: payload.name,
          version: payload.version,
          injectedChars: payload.injectedChars ?? 0,
          seq: event.seq,
        });
      }
      break;
    }
    case 'skill.suggested': {
      // Chỉ ghi nhận gợi ý — không đổi state.
      break;
    }
    case 'conversation.branched': {
      const payload = event.payload as { childConversationId: string; fromSeq: number };
      state.branches.push({ childConversationId: payload.childConversationId, fromSeq: payload.fromSeq, at: event.at });
      state.status = 'branched';
      break;
    }
    case 'conversation.snapshot': {
      const payload = event.payload as { file: string; throughSeq: number; sha256: string };
      state.latestSnapshot = { file: payload.file, throughSeq: payload.throughSeq, sha256: payload.sha256, at: event.at };
      break;
    }
    case 'conversation.compacted': {
      state.status = 'compacted';
      break;
    }
    case 'conversation.ended': {
      state.status = 'ended';
      break;
    }
    default: {
      // Loại event lạ (vd log viết bởi phiên bản mới hơn): bỏ qua
      // phần fold nhưng vẫn đếm + cập nhật lastSeq/lastHash ở trên.
      break;
    }
  }
  return state;
}

/** Fold toàn bộ dãy event (theo thứ tự seq) thành state. */
export function foldConversationEvents(
  events: AnyConversationEvent[],
  conversationId: string,
  branchId = 'main',
): ConversationState {
  const state = emptyConversationState(conversationId, branchId);
  for (const event of events) {
    foldConversationEvent(state, event);
  }
  return state;
}

/** So sánh sâu hai state (đủ cho test replay determinism). */
export function conversationStatesEqual(a: ConversationState, b: ConversationState): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Replay một dãy event hai lần và kiểm tra cho cùng state — dùng
 * trong test và trong tool `conversation_v112_replay` (khi host yêu
 * cầu verify determinism).
 */
export function replayDeterministicallyV112(
  events: AnyConversationEvent[],
  conversationId: string,
  branchId = 'main',
): { state: ConversationState; deterministic: boolean } {
  const first = foldConversationEvents(events, conversationId, branchId);
  const second = foldConversationEvents(events, conversationId, branchId);
  return { state: first, deterministic: conversationStatesEqual(first, second) };
}

/**
 * Tóm tắt state thành text ngắn (cho tool output / log). Không lộ
 * nội dung message — chỉ số lượng + trạng thái.
 */
export function summarizeConversationState(state: ConversationState): string {
  const lines = [
    `Conversation ${state.conversationId} (branch ${state.branchId}): ${state.status}`,
    `bot: ${state.botId || '(chưa bắt đầu)'}; seq cuối: ${state.lastSeq}`,
    `messages: ${state.messages.length} (user ${state.messages.filter((m) => m.role === 'user').length}, agent ${state.messages.filter((m) => m.role === 'agent').length})`,
    `tool calls: ${state.toolCallsCompleted} hoàn thành, ${state.pendingToolCalls.length} đang chờ`,
    `codeact: ${state.codeActRuns} lần chạy, ${state.codeActBlocked} bị chặn, ${state.pendingCodeAct.length} đang chờ`,
    `skills đã nạp: ${state.loadedSkills.length > 0 ? state.loadedSkills.map((s) => s.name).join(', ') : '(không)'}`,
    `branches: ${state.branches.length}`,
  ];
  if (state.latestSnapshot) {
    lines.push(`snapshot mới nhất: ${state.latestSnapshot.file} (through seq ${state.latestSnapshot.throughSeq})`);
  }
  return lines.join('\n');
}

/** Trạng thái hiện tại có đang ở cuối conversation không. */
export function isConversationTerminal(status: ConversationStatus): boolean {
  return status === 'ended';
}

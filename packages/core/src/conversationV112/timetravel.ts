/**
 * Time travel cho conversation log v112 (Đội T2).
 *
 * Vì state suy ra hoàn toàn từ event (replay), "quay lại quá khứ"
 * chỉ là fold tới một seq thay vì fold hết:
 * - `stateAtSeq(store, id, seq)` — state của conversation tại seq
 *   đó (dùng `foldStateAtSeq`, hiểu cả log đã compact).
 * - `diffConversationStates(before, after)` — khác biệt giữa hai
 *   state: message thêm vào, skill nạp thêm, CodeAct chạy thêm,
 *   tool hoàn thành thêm, status đổi.
 * - `timeTravel(store, id, seq)` — gói cả hai: state tại seq +
 *   diff so với state hiện tại + số event "tương lai" (sau seq).
 *
 * Time travel là READ-ONLY: không ghi event, không sửa log, không
 * đổi state của session đang mở. Muốn "quay lại và đi hướng khác"
 * thì dùng branch (xem branches.ts) — đó mới là hành động ghi.
 */

import { foldStateAtSeq } from './snapshots';
import type { ConversationLogStore } from './store';
import type { ConversationMessage, ConversationState } from './types';

/** Khác biệt giữa hai state của cùng một conversation. */
export interface ConversationStateDiff {
  /** Seq của state trước / sau. */
  fromSeq: number;
  toSeq: number;
  /** Message có trong `after` nhưng không có trong `before` (so theo seq). */
  addedMessages: ConversationMessage[];
  /** Message có trong `before` nhưng không có trong `after` (chỉ xảy ra khi diff ngược). */
  removedMessages: ConversationMessage[];
  /** Skill nạp thêm. */
  addedSkills: string[];
  /** Skill đã nạp trong `before` nhưng mất trong `after` (diff ngược). */
  removedSkills: string[];
  /** Số lần chạy CodeAct tăng thêm. */
  codeActRunsDelta: number;
  /** Số CodeAct bị chặn tăng thêm. */
  codeActBlockedDelta: number;
  /** Số tool call hoàn thành tăng thêm. */
  toolCallsCompletedDelta: number;
  /** Status có đổi không. */
  statusChanged: boolean;
  statusFrom?: string;
  statusTo?: string;
}

/** Kết quả time travel tới một seq. */
export interface ConversationTimeTravelResult {
  conversationId: string;
  /** Seq đã quay tới. */
  atSeq: number;
  /** State tại seq đó. */
  state: ConversationState;
  /** Diff từ state tại seq tới state hiện tại. */
  diffToPresent: ConversationStateDiff;
  /** Số event sau seq (phần "tương lai"). */
  futureEvents: number;
}

/** State của conversation tại một seq (read-only, không sửa log). */
export function stateAtSeq(
  store: ConversationLogStore,
  conversationId: string,
  seq: number,
): ConversationState {
  return foldStateAtSeq(store, conversationId, seq);
}

/** Diff hai state (so theo seq của message / tên skill). */
export function diffConversationStates(
  before: ConversationState,
  after: ConversationState,
): ConversationStateDiff {
  const beforeSeqs = new Set(before.messages.map((m) => m.seq));
  const afterSeqs = new Set(after.messages.map((m) => m.seq));
  const addedMessages = after.messages.filter((m) => !beforeSeqs.has(m.seq));
  const removedMessages = before.messages.filter((m) => !afterSeqs.has(m.seq));
  const beforeSkills = new Set(before.loadedSkills.map((s) => s.name));
  const afterSkills = new Set(after.loadedSkills.map((s) => s.name));
  const addedSkills = [...afterSkills].filter((name) => !beforeSkills.has(name));
  const removedSkills = [...beforeSkills].filter((name) => !afterSkills.has(name));
  return {
    fromSeq: before.lastSeq,
    toSeq: after.lastSeq,
    addedMessages,
    removedMessages,
    addedSkills,
    removedSkills,
    codeActRunsDelta: after.codeActRuns - before.codeActRuns,
    codeActBlockedDelta: after.codeActBlocked - before.codeActBlocked,
    toolCallsCompletedDelta: after.toolCallsCompleted - before.toolCallsCompleted,
    statusChanged: before.status !== after.status,
    statusFrom: before.status,
    statusTo: after.status,
  };
}

/**
 * Time travel: state tại `seq` + diff tới hiện tại + số event tương
 * lai. Ném lỗi khi seq ngoài khoảng (chưa có event / vượt seq cuối).
 */
export function timeTravelConversation(
  store: ConversationLogStore,
  conversationId: string,
  seq: number,
): ConversationTimeTravelResult {
  const { events } = store.readAll(conversationId, { verify: true });
  if (events.length === 0) {
    throw new Error(`Không time travel được: conversation ${conversationId} chưa có event nào.`);
  }
  const lastSeq = events[events.length - 1]!.seq;
  if (!Number.isInteger(seq) || seq < 1 || seq > lastSeq) {
    throw new Error(`Không time travel được: seq ${seq} ngoài khoảng 1..${lastSeq}.`);
  }
  const past = foldStateAtSeq(store, conversationId, seq);
  // State hiện tại: fold từ snapshot (nếu có) — dùng foldStateAtSeq
  // tới seq cuối để hiểu cả log đã compact.
  const present = foldStateAtSeq(store, conversationId, lastSeq);
  const futureEvents = events.filter((event) => event.seq > seq).length;
  return {
    conversationId,
    atSeq: seq,
    state: past,
    diffToPresent: diffConversationStates(past, present),
    futureEvents,
  };
}

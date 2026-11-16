/**
 * Branch cho conversation log v112 (Đội T2).
 *
 * Branch = fork một conversation tại một seq: tạo conversation mới
 * (id mới) chứa bản sao các event từ đầu tới `fromSeq` của conversation
 * cha, cộng một event `conversation.branched` ở cha (ghi rõ con) và
 * một event `conversation.started` ở con (ghi rõ cha + fromSeq).
 *
 * Hash chain của con được tính LẠI từ đầu (seq đếm lại từ 1) — chain
 * con độc lập với chain cha, vì seq/prevHash của con khác cha. Nhờ
 * đó verify chain của con vẫn đúng mà không cần giữ hash cha.
 * `branchedFromSeq` trong event started của con là cầu nối duy nhất
 * để truy vết nguồn gốc.
 *
 * Branch không chia sẻ file: mỗi conversation một file JSONL riêng,
 * nên sửa/xoá ở con không ảnh hưởng cha.
 */

import { randomUUID } from 'node:crypto';
import type { ConversationLogStore } from './store';
import type { AnyConversationEvent } from './types';

/** Kết quả tạo branch. */
export interface BranchConversationResult {
  /** Id conversation mới (branch con). */
  childConversationId: string;
  /** Seq trong cha mà branch sao chép tới. */
  fromSeq: number;
  /** Số event đã sao chép sang con. */
  copiedEvents: number;
  /** Seq của event `conversation.branched` vừa ghi ở cha. */
  branchEventSeq: number;
}

export interface BranchConversationOptions {
  /** Id cho conversation con (mặc định sinh UUID). */
  childConversationId?: string;
  /** Lý do branch (ghi vào event ở cha). */
  reason?: string;
  /** Nhánh của con (mặc định 'main'). */
  childBranchId?: string;
}

/**
 * Fork conversation `parentId` tại `fromSeq` (bao gồm event đó).
 * Ném lỗi khi fromSeq ngoài khoảng (chưa có event) hoặc cha chưa tồn tại.
 */
export function branchConversation(
  store: ConversationLogStore,
  parentId: string,
  fromSeq: number,
  options: BranchConversationOptions = {},
): BranchConversationResult {
  if (!Number.isInteger(fromSeq) || fromSeq < 1) {
    throw new Error('branchConversation cần fromSeq là số nguyên >= 1.');
  }
  const parent = store.readAll(parentId, { verify: true });
  if (parent.events.length === 0) {
    throw new Error(`Không branch được: conversation ${parentId} chưa có event nào.`);
  }
  if (fromSeq > parent.events.length) {
    throw new Error(
      `Không branch được: fromSeq ${fromSeq} vượt quá ${parent.events.length} event của ${parentId}.`,
    );
  }
  const childId = options.childConversationId ?? `conv-${randomUUID()}`;
  if (store.exists(childId)) {
    throw new Error(`Không branch được: conversation ${childId} đã tồn tại.`);
  }
  const childBranchId = options.childBranchId ?? 'main';
  const copied = parent.events.slice(0, fromSeq);

  // 1. Ghi event branched ở cha (đánh dấu điểm fork, status cha -> branched).
  const branchEvent = store.append(parentId, 'main', 'conversation.branched', {
    childConversationId: childId,
    fromSeq,
    childBranchId,
    reason: options.reason,
  });

  // 2. Sao chép event vào con — ghi LẠI qua store để chain con đúng
  // (seq đếm lại từ 1, hash tính lại). Event `conversation.started`
  // của con ghi đè event started gốc? Không: giữ nguyên event started
  // gốc của cha làm event đầu của con (giữ botId/title), rồi chèn
  // thêm một event started "branch" ngay sau đó để ghi parent pointer.
  // Cách đơn giản và rõ ràng hơn: con bắt đầu bằng event started mới
  // (parentConversationId + branchedFromSeq), rồi sao chép các event
  // sau event started gốc của cha.
  const startedParent = copied[0]!;
  const startedPayload = startedParent.payload as {
    botId: string;
    title?: string;
    model?: string;
    providerId?: string;
  };
  store.append(childId, childBranchId, 'conversation.started', {
    botId: startedPayload.botId,
    title: startedPayload.title,
    model: startedPayload.model,
    providerId: startedPayload.providerId,
    parentConversationId: parentId,
    branchedFromSeq: fromSeq,
    parentBranchId: 'main',
  });
  let copiedCount = 1;
  for (const event of copied.slice(1)) {
    // Ghi lại đúng type + payload của event gốc vào con.
    store.append(childId, childBranchId, event.type, event.payload as never);
    copiedCount += 1;
  }
  return {
    childConversationId: childId,
    fromSeq,
    copiedEvents: copiedCount,
    branchEventSeq: branchEvent.seq,
  };
}

/** Liệt kê branch con của một conversation (từ event `conversation.branched`). */
export function listConversationBranches(
  store: ConversationLogStore,
  conversationId: string,
): Array<{ childConversationId: string; fromSeq: number; at: string; reason?: string }> {
  const { events } = store.readAll(conversationId);
  const out: Array<{ childConversationId: string; fromSeq: number; at: string; reason?: string }> = [];
  for (const event of events) {
    if (event.type !== 'conversation.branched') continue;
    const payload = event.payload as { childConversationId: string; fromSeq: number; reason?: string };
    out.push({
      childConversationId: payload.childConversationId,
      fromSeq: payload.fromSeq,
      at: event.at,
      reason: payload.reason,
    });
  }
  return out;
}

/** Tìm tổ tiên của một conversation (đi ngược parentConversationId qua event started). */
export function conversationAncestors(
  store: ConversationLogStore,
  conversationId: string,
): Array<{ conversationId: string; branchedFromSeq: number }> {
  const ancestors: Array<{ conversationId: string; branchedFromSeq: number }> = [];
  const seen = new Set<string>();
  let current = conversationId;
  while (!seen.has(current)) {
    seen.add(current);
    const { events } = store.readAll(current);
    const started = events.find((event) => event.type === 'conversation.started');
    if (!started) break;
    const payload = started.payload as { parentConversationId?: string; branchedFromSeq?: number };
    if (!payload.parentConversationId) break;
    ancestors.push({
      conversationId: payload.parentConversationId,
      branchedFromSeq: payload.branchedFromSeq ?? 0,
    });
    current = payload.parentConversationId;
  }
  return ancestors;
}

/** Kiểm tra một event có thuộc về branch cha của conversation không (dùng trong test). */
export function isBranchEvent(event: AnyConversationEvent): boolean {
  return event.type === 'conversation.branched';
}

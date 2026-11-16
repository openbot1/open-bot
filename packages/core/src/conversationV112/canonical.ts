/**
 * Hash chain cho conversation log v112 (Đội T2).
 *
 * Cùng nguyên tắc với run log (`event-log/canonical.ts`) nhưng độc
 * lập: hash tính trên bản chuẩn hoá (key sắp xếp) của event, `prevHash`
 * nằm trong đầu vào nên sửa một event sẽ đổi hash của nó và của mọi
 * event sau. Viết riêng thay vì tái dùng `hashRunEvent` vì shape event
 * khác nhau (conversationId/branchId thay runId) — không ép kiểu.
 */

import { createHash } from 'node:crypto';
import type { AnyConversationEvent } from './types';

/** Hash của "không có event trước" — event đầu tiên của conversation. */
export const CONVERSATION_V112_GENESIS_PREV_HASH = '';

/**
 * JSON stringify với key sắp xếp theo thứ tự chữ cái (đệ quy).
 * Mảng giữ nguyên thứ tự; `undefined` trong object bị bỏ như
 * `JSON.stringify`.
 */
export function stableStringifyV112(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' || typeof value === 'boolean') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringifyV112(item)).join(',')}]`;
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const parts = entries.map(
      ([k, v]) => `${JSON.stringify(k)}:${stableStringifyV112(v)}`,
    );
    return `{${parts.join(',')}}`;
  }
  return JSON.stringify(String(value));
}

/** SHA-256 hex của một chuỗi UTF-8. */
export function sha256HexV112(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * Nội dung dùng để tính hash của một event: mọi field trừ `hash`
 * (vì hash của chính nó không thể nằm trong đầu vào của chính nó).
 * `prevHash` NẰM trong đầu vào — đó chính là mắt xích của chuỗi.
 */
export function conversationEventHashInput(event: {
  seq: number;
  conversationId: string;
  branchId: string;
  at: string;
  type: string;
  payload: unknown;
  prevHash: string;
}): string {
  return stableStringifyV112({
    at: event.at,
    branchId: event.branchId,
    conversationId: event.conversationId,
    payload: event.payload,
    prevHash: event.prevHash,
    seq: event.seq,
    type: event.type,
  });
}

/** Hash của một event (đã có đủ field trừ `hash`). */
export function hashConversationEvent(
  event: Omit<AnyConversationEvent, 'hash'>,
): string {
  return sha256HexV112(conversationEventHashInput(event));
}

/** Kiểm tra hash của một event đã lưu có đúng với nội dung của nó không. */
export function verifyConversationEventHash(event: AnyConversationEvent): boolean {
  if (typeof event.hash !== 'string' || event.hash.length !== 64) return false;
  return hashConversationEvent(event) === event.hash;
}

/**
 * Verify toàn bộ chain: seq tăng đều từ 1, prevHash nối đúng, hash
 * đúng nội dung. Trả về `{ ok: true }` hoặc lỗi ở seq đầu tiên sai.
 */
export function verifyConversationChain(events: AnyConversationEvent[]): {
  ok: boolean;
  badSeq?: number;
  reason?: string;
} {
  let prevHash = CONVERSATION_V112_GENESIS_PREV_HASH;
  for (let i = 0; i < events.length; i++) {
    const event = events[i]!;
    const expectedSeq = i + 1;
    if (event.seq !== expectedSeq) {
      return { ok: false, badSeq: event.seq, reason: `seq ${event.seq}, kỳ vọng ${expectedSeq} (lỗ hổng hoặc trùng seq)` };
    }
    if (event.prevHash !== prevHash) {
      return { ok: false, badSeq: event.seq, reason: `prevHash không nối với event trước (seq ${event.seq})` };
    }
    if (!verifyConversationEventHash(event)) {
      return { ok: false, badSeq: event.seq, reason: `hash không khớp nội dung (seq ${event.seq})` };
    }
    prevHash = event.hash;
  }
  return { ok: true };
}

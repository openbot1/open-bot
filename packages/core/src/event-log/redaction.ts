/**
 * Redaction cho run log (v1.03, Đội T1).
 *
 * Append-only: event gốc KHÔNG BAO GIỜ bị sửa hay xoá (hash chain
 * phải giữ nguyên để audit còn kiểm chứng được). Che nghĩa là append
 * thêm một event `event.redacted` trỏ tới seq cần che; `foldEvents`
 * áp dụng marker đó ngược lại trạng thái đã fold (xem `replay.ts`),
 * còn log trên đĩa vẫn giữ nguyên event gốc.
 *
 * Hệ quả cần hiểu rõ: redaction che được *bản hiển thị* (transcript,
 * tool result, prompt, compile error) — nó KHÔNG xoá dữ liệu khỏi
 * file log trên đĩa. Ai cầm file `.jsonl` vẫn đọc được event gốc.
 * Muốn xoá thật khỏi đĩa thì phải xoay/xoá file log (ngoài scope
 * module này) — UI phải nói rõ điều này khi user bấm "redact".
 */

import type { RunLogStore } from './store';
import type { AnyRunEvent } from './types';

/** Kết quả của một lần redact. */
export interface RedactResult {
  runId: string;
  /** Seq của event vừa bị che. */
  redactedSeq: number;
  /** Seq của event marker `event.redacted` vừa append. */
  markerSeq: number;
  reason: string;
}

/** Các loại event có nội dung text mà redaction che được khi fold. */
const REDACTABLE_TYPES = new Set(['run.prompt', 'model.response', 'tool.result', 'compile.error']);

/**
 * Che một event trong run: append marker `event.redacted`.
 * Ném lỗi khi seq ngoài khoảng log, hoặc khi event ở seq đó không
 * có nội dung text để che (vd `run.started`, `file.change` — che
 * chúng không có tác dụng gì, nên từ chối thẳng thay vì ghi marker
 * vô nghĩa). Che một seq hai lần vẫn được (marker thứ hai là no-op
 * khi fold) nhưng trả về marker mới để audit đủ vết.
 */
export function redactEvent(
  store: RunLogStore,
  runId: string,
  seq: number,
  reason: string,
  redactedBy?: string,
): RedactResult {
  if (!Number.isInteger(seq) || seq < 1) {
    throw new Error(`Không redact được: seq ${seq} không hợp lệ (seq bắt đầu từ 1).`);
  }
  if (reason.trim() === '') throw new Error('Không redact được: cần ghi lý do (reason).');
  const { events } = store.readRun(runId);
  const target = events.find((e) => e.seq === seq);
  if (!target) {
    throw new Error(`Không redact được: run ${runId} không có event seq ${seq}.`);
  }
  if (!REDACTABLE_TYPES.has(target.type)) {
    throw new Error(
      `Không redact được: event seq ${seq} là loại ${target.type}, không có nội dung text để che.`,
    );
  }
  const marker = store.append(runId, {
    type: 'event.redacted',
    payload: {
      seq,
      reason: reason.trim(),
      ...(redactedBy !== undefined ? { redactedBy } : {}),
    },
  });
  return { runId, redactedSeq: seq, markerSeq: marker.seq, reason: reason.trim() };
}

/**
 * Tìm các event trong run có chứa một chuỗi con (trong text prompt,
 * model text, outputPreview, firstError, message/finalText). Dùng để
 * định vị seq cần redact khi phát hiện secret lọt vào log. So khớp
 * không phân biệt hoa thường; trả về tối đa `limit` seq (mặc định 20).
 * Chỉ tìm trên nội dung đã sanitize trong log — không đọc file ngoài.
 */
export function findEventsContaining(
  store: RunLogStore,
  runId: string,
  needle: string,
  limit = 20,
): Array<{ seq: number; type: string; field: string }> {
  if (needle.trim() === '') return [];
  const lower = needle.toLowerCase();
  const { events } = store.readRun(runId);
  const hits: Array<{ seq: number; type: string; field: string }> = [];
  for (const event of events) {
    const p = event.payload as unknown as Record<string, unknown>;
    for (const field of ['text', 'outputPreview', 'firstError', 'message', 'finalText']) {
      const v = p[field];
      if (typeof v === 'string' && v.toLowerCase().includes(lower)) {
        hits.push({ seq: event.seq, type: event.type, field });
        break;
      }
    }
    if (hits.length >= limit) break;
  }
  return hits;
}

/** Lấy danh sách seq đã bị che trong một dãy event (đọc marker). */
export function redactedSeqs(events: readonly AnyRunEvent[]): number[] {
  const out: number[] = [];
  for (const event of events) {
    if (event.type !== 'event.redacted') continue;
    const p = event.payload as { seq?: number };
    if (typeof p.seq === 'number') out.push(p.seq);
  }
  return out;
}

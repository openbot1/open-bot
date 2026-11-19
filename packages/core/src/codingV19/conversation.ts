/**
 * Coding agent v19 — conversation (v1.41, Đội T4).
 *
 * Conversation = metadata + event log append-only. Tạo conversation
 * (áp preset nếu có), append event qua events.ts, replay để khôi phục
 * state, fork/branch từ một event giữa chừng (copy event tới seq đó
 * sang conversation mới, re-hash chain với conversationId mới, ghi
 * event `branch` vào log cha), đóng/kết thúc và archive. Module này
 * chỉ làm việc trên dữ liệu (meta + event array); tools layer lo
 * việc ghi JSONL/meta xuống đĩa.
 *
 * Nối v17 sessions (không viết lại): session registry của v17 vẫn quản
 * phiên v17; conversation v19 có vòng đời riêng (active/ended/archived)
 * và branch — thứ v17 chưa có.
 */

import { CodingV19Error } from './types';
import type {
  V19ConversationMeta,
  V19ConversationState,
  V19ConversationStatus,
  V19CreateConversationInput,
  V19Event,
  V19PresetApplyResult,
} from './types';
import { v19AppendEvent, v19EventId, v19ReplayEvents } from './events';

/** Id conversation ổn định: `conv-<millis>-<random 6 ký tự>`. */
export function v19NewConversationId(now: number): string {
  const rand = Math.random().toString(36).slice(2, 8).padEnd(6, '0');
  return `conv-${now}-${rand}`;
}

/** Title mặc định khi caller không đặt. */
export function v19DefaultConversationTitle(now: number): string {
  return `Conversation ${new Date(now).toISOString().slice(0, 19).replace('T', ' ')}`;
}

/** Validate id conversation (không rỗng, không chứa '/' hay '..'). */
export function v19ValidateConversationId(id: string): void {
  if (typeof id !== 'string' || id.trim() === '') {
    throw new CodingV19Error('conversationId không được rỗng.');
  }
  if (id.includes('/') || id.includes('\\') || id.includes('..')) {
    throw new CodingV19Error(`conversationId "${id}" không hợp lệ (không chứa '/', '\\', '..').`);
  }
}

/**
 * Tạo metadata conversation mới. Khi có preset đã resolve (presetId +
 * systemPrompt + pluginIds + allowlist) thì snapshot thẳng vào meta —
 * conversation sau này không bị ảnh hưởng nếu preset bị sửa/xoá.
 */
export function v19CreateConversationMeta(
  input: V19CreateConversationInput,
  resolvedPreset?: V19PresetApplyResult,
): V19ConversationMeta {
  const now = typeof input.now === 'number' ? input.now : Date.now();
  if (!Number.isFinite(now) || now < 0) throw new CodingV19Error('now phải là số ms epoch >= 0.');
  const id = v19NewConversationId(now);
  const profileId = input.profileId ?? resolvedPreset?.presetId ?? '';
  const systemPrompt = input.systemPrompt ?? resolvedPreset?.systemPrompt ?? '';
  const pluginIds = input.pluginIds ?? resolvedPreset?.pluginIds ?? [];
  const toolAllowlist = input.toolAllowlist ?? resolvedPreset?.toolAllowlist ?? [];
  if (typeof systemPrompt !== 'string') throw new CodingV19Error('systemPrompt phải là string.');
  for (const pluginId of pluginIds) {
    if (typeof pluginId !== 'string' || pluginId.trim() === '') {
      throw new CodingV19Error('pluginIds phải là mảng string không rỗng.');
    }
  }
  for (const tool of toolAllowlist) {
    if (typeof tool !== 'string' || tool.trim() === '') {
      throw new CodingV19Error('toolAllowlist phải là mảng string không rỗng.');
    }
  }
  if (new Set(pluginIds).size !== pluginIds.length) {
    throw new CodingV19Error('pluginIds không được trùng nhau.');
  }
  if (new Set(toolAllowlist).size !== toolAllowlist.length) {
    throw new CodingV19Error('toolAllowlist không được trùng nhau.');
  }
  return {
    id,
    title: typeof input.title === 'string' && input.title.trim() !== '' ? input.title.trim() : v19DefaultConversationTitle(now),
    profileId,
    systemPrompt,
    pluginIds: [...pluginIds],
    toolAllowlist: [...toolAllowlist],
    status: 'active',
    parentId: '',
    branchedFromSeq: 0,
    createdAt: now,
    updatedAt: now,
  };
}

/** Validate metadata conversation đã lưu (dùng khi load từ đĩa). */
export function v19ValidateConversationMeta(meta: V19ConversationMeta): void {
  if (!meta || typeof meta !== 'object') throw new CodingV19Error('Conversation meta phải là object.');
  v19ValidateConversationId(meta.id);
  if (typeof meta.title !== 'string' || meta.title.trim() === '') {
    throw new CodingV19Error('Conversation cần title không rỗng.');
  }
  if (typeof meta.profileId !== 'string') throw new CodingV19Error('Conversation profileId phải là string.');
  if (typeof meta.systemPrompt !== 'string') throw new CodingV19Error('Conversation systemPrompt phải là string.');
  if (!Array.isArray(meta.pluginIds) || !Array.isArray(meta.toolAllowlist)) {
    throw new CodingV19Error('Conversation pluginIds/toolAllowlist phải là array.');
  }
  const status: V19ConversationStatus[] = ['active', 'ended', 'archived'];
  if (!status.includes(meta.status)) {
    throw new CodingV19Error(`Conversation status "${String(meta.status)}" không hợp lệ.`);
  }
  if (typeof meta.parentId !== 'string') throw new CodingV19Error('Conversation parentId phải là string.');
  if (!Number.isInteger(meta.branchedFromSeq) || meta.branchedFromSeq < 0) {
    throw new CodingV19Error('Conversation branchedFromSeq phải là số nguyên >= 0.');
  }
  if (meta.parentId === '' && meta.branchedFromSeq !== 0) {
    throw new CodingV19Error('Conversation không phải branch nhưng branchedFromSeq != 0.');
  }
  if (meta.parentId !== '' && meta.branchedFromSeq < 1) {
    throw new CodingV19Error('Conversation branch cần branchedFromSeq >= 1.');
  }
}

/**
 * Mở conversation mới từ event log rỗng: session_start (+ preset_applied
 * khi có preset). Trả log mới (1–2 event).
 */
export function v19OpenConversationEvents(
  meta: V19ConversationMeta,
  now?: number,
): V19Event[] {
  let events: V19Event[] = [];
  events = v19AppendEvent(events, meta.id, {
    kind: 'session_start',
    actor: 'system',
    ...(now !== undefined ? { at: now } : {}),
    payload: { text: `Conversation "${meta.title}" bắt đầu.` },
  });
  if (meta.profileId !== '') {
    events = v19AppendEvent(events, meta.id, {
      kind: 'preset_applied',
      actor: 'system',
      ...(now !== undefined ? { at: now } : {}),
      payload: { presetId: meta.profileId },
    });
  }
  return events;
}

/** Kết thúc conversation: append session_end (state ended sau replay). */
export function v19EndConversationEvents(
  events: readonly V19Event[],
  conversationId: string,
  endReason: string,
  now?: number,
): V19Event[] {
  if (typeof endReason !== 'string' || endReason.trim() === '') {
    throw new CodingV19Error('endReason không được rỗng.');
  }
  return v19AppendEvent(events, conversationId, {
    kind: 'session_end',
    actor: 'system',
    ...(now !== undefined ? { at: now } : {}),
    payload: { endReason: endReason.trim() },
  });
}

/**
 * Fork/branch conversation từ một event giữa chừng: copy các event tới
 * `fromSeq` sang conversation mới (giữ nguyên kind/payload/at/actor,
 * đổi conversationId + re-hash chain), tạo meta con (parentId = cha,
 * branchedFromSeq = fromSeq, giữ nguyên preset snapshot của cha).
 * Log cha nhận thêm event `branch` trỏ sang con. Trả {childMeta,
 * childEvents, parentEvents} — caller tự lưu cả hai phía.
 */
export function v19ForkConversation(
  parentMeta: V19ConversationMeta,
  parentEvents: readonly V19Event[],
  fromSeq: number,
  title: string,
  now?: number,
): { childMeta: V19ConversationMeta; childEvents: V19Event[]; parentEvents: V19Event[] } {
  v19ValidateConversationMeta(parentMeta);
  if (!Number.isInteger(fromSeq) || fromSeq < 1 || fromSeq > parentEvents.length) {
    throw new CodingV19Error(
      `Không fork được từ seq ${fromSeq} (log cha có ${parentEvents.length} event, seq hợp lệ 1..${parentEvents.length}).`,
    );
  }
  if (typeof title !== 'string' || title.trim() === '') {
    throw new CodingV19Error('Title của branch không được rỗng.');
  }
  const at = typeof now === 'number' ? now : Date.now();
  const childMeta: V19ConversationMeta = {
    id: v19NewConversationId(at),
    title: title.trim(),
    profileId: parentMeta.profileId,
    systemPrompt: parentMeta.systemPrompt,
    pluginIds: [...parentMeta.pluginIds],
    toolAllowlist: [...parentMeta.toolAllowlist],
    status: 'active',
    parentId: parentMeta.id,
    branchedFromSeq: fromSeq,
    createdAt: at,
    updatedAt: at,
  };
  // Copy event tới fromSeq sang con (re-hash với conversationId mới).
  // Dùng append tuần tự để chain/hash/id sinh đúng luật của log mới.
  // Bỏ qua session_end của cha: con là branch đang mở, không kế thừa
  // trạng thái "đã kết thúc" (append sau session_end bị chặn).
  let childEvents: V19Event[] = [];
  for (const src of parentEvents) {
    if (src.seq > fromSeq) break;
    if (src.kind === 'session_end') continue;
    childEvents = v19AppendEvent(childEvents, childMeta.id, {
      kind: src.kind,
      actor: src.actor,
      at: src.at,
      payload: JSON.parse(JSON.stringify(src.payload)) as V19Event['payload'],
    });
  }
  // Đánh dấu branch trong log con (ngay sau event copy cuối) để replay
  // của con biết nó rẽ ra từ đâu — append sau khi copy xong.
  childEvents = v19AppendEvent(childEvents, childMeta.id, {
    kind: 'branch',
    actor: 'system',
    at,
    payload: { branchToConversationId: childMeta.id, branchFromSeq: fromSeq },
  });
  // Ghi branch vào log cha (trỏ sang con). Cha đã session_end thì
  // không append thêm được (log append-only đã đóng) — liên kết branch
  // vẫn còn trong meta của con (parentId) và event branch của con.
  const parentEnded = parentEvents.length > 0 && parentEvents[parentEvents.length - 1]!.kind === 'session_end';
  const nextParentEvents = parentEnded
    ? [...parentEvents]
    : v19AppendEvent(parentEvents, parentMeta.id, {
        kind: 'branch',
        actor: 'system',
        at,
        payload: { branchToConversationId: childMeta.id, branchFromSeq: fromSeq },
      });
  return { childMeta, childEvents, parentEvents: nextParentEvents };
}

/** Đổi status conversation (active -> ended -> archived; không quay lại). */
export function v19SetConversationStatus(
  meta: V19ConversationMeta,
  status: V19ConversationStatus,
  now?: number,
): V19ConversationMeta {
  const order: V19ConversationStatus[] = ['active', 'ended', 'archived'];
  if (!order.includes(status)) throw new CodingV19Error(`Status "${status}" không hợp lệ.`);
  if (order.indexOf(status) < order.indexOf(meta.status)) {
    throw new CodingV19Error(`Không chuyển conversation từ "${meta.status}" về "${status}".`);
  }
  const at = typeof now === 'number' ? now : Date.now();
  return { ...meta, status, updatedAt: at };
}

/** Archive conversation (chỉ archive khi đã ended hoặc active; giữ nguyên khi đã archived). */
export function v19ArchiveConversation(meta: V19ConversationMeta, now?: number): V19ConversationMeta {
  return v19SetConversationStatus(meta, 'archived', now);
}

/** Đổi title conversation (không đổi id/status/preset snapshot). */
export function v19RenameConversation(
  meta: V19ConversationMeta,
  title: string,
  now?: number,
): V19ConversationMeta {
  if (typeof title !== 'string' || title.trim() === '') {
    throw new CodingV19Error('Title mới của conversation không được rỗng.');
  }
  if (title.trim().length > 200) {
    throw new CodingV19Error('Title conversation tối đa 200 ký tự.');
  }
  const at = typeof now === 'number' ? now : Date.now();
  return { ...meta, title: title.trim(), updatedAt: at };
}

/** Serialize meta thành JSON (ghi file meta.json của conversation). */
export function v19ConversationMetaToJson(meta: V19ConversationMeta): string {
  v19ValidateConversationMeta(meta);
  return `${JSON.stringify(meta, null, 2)}\n`;
}

/** Parse meta từ JSON (validate đầy đủ). */
export function v19ConversationMetaFromJson(json: string): V19ConversationMeta {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new CodingV19Error('Conversation meta không phải JSON hợp lệ.');
  }
  v19ValidateConversationMeta(parsed as V19ConversationMeta);
  return parsed as V19ConversationMeta;
}

/** Tóm tắt một conversation từ meta + state replay (dùng cho list). */
export interface V19ConversationSummary {
  id: string;
  title: string;
  profileId: string;
  status: V19ConversationStatus;
  parentId: string;
  branchedFromSeq: number;
  events: number;
  messages: number;
  toolCalls: number;
  filesChanged: number;
  checkpoints: number;
  createdAt: number;
  lastAt: number;
  ended: boolean;
}

export function v19ConversationSummary(
  meta: V19ConversationMeta,
  state: V19ConversationState,
): V19ConversationSummary {
  return {
    id: meta.id,
    title: meta.title,
    profileId: meta.profileId,
    status: meta.status,
    parentId: meta.parentId,
    branchedFromSeq: meta.branchedFromSeq,
    events: state.eventsReplayed,
    messages: state.messages.length,
    toolCalls: state.toolCalls.length,
    filesChanged: state.filesChanged.length,
    checkpoints: state.checkpoints.length,
    createdAt: meta.createdAt,
    lastAt: state.lastAt,
    ended: state.ended,
  };
}

/** Tiện ích: replay + tóm tắt trong một lần gọi. */
export function v19SummarizeConversation(
  meta: V19ConversationMeta,
  events: readonly V19Event[],
): V19ConversationSummary {
  return v19ConversationSummary(meta, v19ReplayEvents(meta.id, events));
}

/** Render tóm tắt conversation (một đoạn ngắn cho tool output). */
export function renderV19ConversationSummary(summary: V19ConversationSummary): string {
  const branch = summary.parentId !== '' ? ` (branch của ${summary.parentId} @seq ${summary.branchedFromSeq})` : '';
  return (
    `${summary.title} [${summary.id}]${branch}\n` +
    `Profile: ${summary.profileId || '(không có)'} — trạng thái: ${summary.status}${summary.ended ? ' (đã kết thúc)' : ''}.\n` +
    `Event: ${summary.events}, tin nhắn: ${summary.messages}, tool call: ${summary.toolCalls}, file đổi: ${summary.filesChanged}, checkpoint: ${summary.checkpoints}.`
  );
}

/** Kiểm tra id event có thuộc conversation không (dùng khi fork theo event id). */
export function v19SeqOfEventId(events: readonly V19Event[], eventId: string): number {
  const found = events.find((e) => e.id === eventId);
  if (!found) throw new CodingV19Error(`Không có event "${eventId}" trong log.`);
  return found.seq;
}

/** Đảm bảo event id dùng để fork tồn tại — trả seq của nó. */
export function v19ForkSeqFromEventId(events: readonly V19Event[], eventId: string): number {
  return v19SeqOfEventId(events, eventId);
}

/** Lấy danh sách conversation con (branch) của một conversation cha. */
export function v19ChildConversations(
  metas: readonly V19ConversationMeta[],
  parentId: string,
): V19ConversationMeta[] {
  return metas.filter((m) => m.parentId === parentId).sort((a, b) => a.createdAt - b.createdAt);
}

/**
 * Coding agent v19 — event log (v1.41, Đội T4).
 *
 * Conversation lưu dưới dạng event log append-only có hash-chain:
 * mỗi event trỏ hash của event trước, sửa lén một event sẽ làm vỡ
 * chain (verify phát hiện). Replay event log để khôi phục trạng thái
 * conversation (tin nhắn, tool call + kết quả, file đã đổi, checkpoint,
 * preset/plugin đang áp). Không gọi model/mạng; hash dùng SHA-256
 * chuẩn của Node, serialize JSONL một event một dòng để tools layer
 * append thẳng ra file.
 *
 * Nối v17 (không viết lại): trajectory log JSONL + replay của v17 vẫn
 * là log của phiên v17; event log v19 là log của conversation v19
 * (kind rộng hơn: checkpoint/rollback/branch/preset/plugin).
 */

import { createHash } from 'node:crypto';
import { CodingV19Error, V19_EVENT_KINDS, V19_MAX_EVENTS_PER_CONVERSATION } from './types';
import type {
  V19AppendEventInput,
  V19ConversationState,
  V19Event,
  V19EventKind,
  V19EventPayload,
  V19FileChange,
  V19PluginRuntimeState,
} from './types';

/** Hash SHA-256 hex của một chuỗi. */
export function v19HashText(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Hash của một event (tính trên mọi field trừ chính `hash`). */
export function v19EventHash(event: Omit<V19Event, 'hash'>): string {
  const canonical = [
    event.prevHash,
    event.conversationId,
    String(event.seq),
    event.kind,
    String(event.at),
    event.actor,
    JSON.stringify(event.payload ?? {}),
  ].join('|');
  return v19HashText(canonical);
}

/** Id event ổn định: `ev-<conversationId>-<seq>` (đủ duy nhất trong log). */
export function v19EventId(conversationId: string, seq: number): string {
  return `ev-${conversationId}-${seq}`;
}

/** Validate kind có trong danh sách hợp lệ. */
export function v19ValidateEventKind(kind: string): V19EventKind {
  if ((V19_EVENT_KINDS as readonly string[]).includes(kind)) return kind as V19EventKind;
  throw new CodingV19Error(
    `Event kind "${kind}" không hợp lệ (hợp lệ: ${V19_EVENT_KINDS.join(', ')}).`,
  );
}

/** Validate payload tối thiểu theo kind (lỗi sớm, rõ ràng). */
export function v19ValidateEventPayload(kind: V19EventKind, payload: V19EventPayload): void {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new CodingV19Error('Event payload phải là object.');
  }
  switch (kind) {
    case 'user_message':
    case 'assistant_message':
    case 'note':
      if (typeof payload.text !== 'string' || payload.text.trim() === '') {
        throw new CodingV19Error(`Event ${kind} cần payload.text không rỗng.`);
      }
      break;
    case 'tool_call':
      if (typeof payload.toolName !== 'string' || payload.toolName.trim() === '') {
        throw new CodingV19Error('Event tool_call cần payload.toolName không rỗng.');
      }
      break;
    case 'tool_result':
      if (typeof payload.toolName !== 'string' || payload.toolName.trim() === '') {
        throw new CodingV19Error('Event tool_result cần payload.toolName không rỗng.');
      }
      if (payload.ok !== undefined && typeof payload.ok !== 'boolean') {
        throw new CodingV19Error('Event tool_result payload.ok phải là boolean.');
      }
      break;
    case 'file_edit':
      if (typeof payload.filePath !== 'string' || payload.filePath.trim() === '') {
        throw new CodingV19Error('Event file_edit cần payload.filePath không rỗng.');
      }
      if (payload.fileAction !== 'create' && payload.fileAction !== 'edit' && payload.fileAction !== 'delete') {
        throw new CodingV19Error('Event file_edit cần payload.fileAction là create | edit | delete.');
      }
      break;
    case 'checkpoint':
      if (typeof payload.checkpointId !== 'string' || payload.checkpointId.trim() === '') {
        throw new CodingV19Error('Event checkpoint cần payload.checkpointId không rỗng.');
      }
      break;
    case 'rollback':
      if (typeof payload.checkpointId !== 'string' || payload.checkpointId.trim() === '') {
        throw new CodingV19Error('Event rollback cần payload.checkpointId không rỗng.');
      }
      break;
    case 'branch':
      if (typeof payload.branchToConversationId !== 'string' || payload.branchToConversationId.trim() === '') {
        throw new CodingV19Error('Event branch cần payload.branchToConversationId không rỗng.');
      }
      if (typeof payload.branchFromSeq !== 'number' || payload.branchFromSeq < 1) {
        throw new CodingV19Error('Event branch cần payload.branchFromSeq >= 1.');
      }
      break;
    case 'preset_applied':
      if (typeof payload.presetId !== 'string' || payload.presetId.trim() === '') {
        throw new CodingV19Error('Event preset_applied cần payload.presetId không rỗng.');
      }
      break;
    case 'plugin_change':
      if (typeof payload.pluginId !== 'string' || payload.pluginId.trim() === '') {
        throw new CodingV19Error('Event plugin_change cần payload.pluginId không rỗng.');
      }
      if (!['load', 'unload', 'enable', 'disable', 'config'].includes(payload.pluginChange ?? '')) {
        throw new CodingV19Error('Event plugin_change cần payload.pluginChange là load | unload | enable | disable | config.');
      }
      break;
    case 'session_start':
    case 'session_end':
      break;
    default:
      throw new CodingV19Error(`Event kind "${kind}" chưa hỗ trợ validate payload.`);
  }
}

/** Validate một event đã có sẵn (dùng khi load log từ đĩa). */
export function v19ValidateEvent(event: V19Event): void {
  if (!event || typeof event !== 'object') throw new CodingV19Error('Event phải là object.');
  if (typeof event.id !== 'string' || event.id.trim() === '') {
    throw new CodingV19Error('Event cần id không rỗng.');
  }
  if (typeof event.conversationId !== 'string' || event.conversationId.trim() === '') {
    throw new CodingV19Error('Event cần conversationId không rỗng.');
  }
  if (!Number.isInteger(event.seq) || event.seq < 1) {
    throw new CodingV19Error(`Event seq phải là số nguyên >= 1 (nhận ${String(event.seq)}).`);
  }
  if (event.id !== v19EventId(event.conversationId, event.seq)) {
    throw new CodingV19Error(`Event id "${event.id}" không khớp seq ${event.seq} (kỳ vọng "${v19EventId(event.conversationId, event.seq)}").`);
  }
  v19ValidateEventKind(event.kind);
  v19ValidateEventPayload(event.kind, event.payload);
  if (typeof event.at !== 'number' || !Number.isFinite(event.at) || event.at < 0) {
    throw new CodingV19Error('Event at phải là số ms epoch >= 0.');
  }
  if (typeof event.actor !== 'string' || event.actor.trim() === '') {
    throw new CodingV19Error('Event cần actor không rỗng.');
  }
  if (typeof event.prevHash !== 'string' || typeof event.hash !== 'string' || event.hash === '') {
    throw new CodingV19Error('Event cần prevHash/hash là string (hash không rỗng).');
  }
  const expected = v19EventHash(event);
  if (expected !== event.hash) {
    throw new CodingV19Error(`Event seq ${event.seq} vỡ hash-chain (hash lưu "${event.hash.slice(0, 12)}…", tính lại "${expected.slice(0, 12)}…").`);
  }
}

/**
 * Append một event vào log (pure: không sửa mảng cũ, trả mảng mới).
 * Seq = seq cuối + 1, prevHash = hash event cuối ('' khi log rỗng).
 */
export function v19AppendEvent(
  events: readonly V19Event[],
  conversationId: string,
  input: V19AppendEventInput,
): V19Event[] {
  if (typeof conversationId !== 'string' || conversationId.trim() === '') {
    throw new CodingV19Error('conversationId không được rỗng.');
  }
  if (events.length >= V19_MAX_EVENTS_PER_CONVERSATION) {
    throw new CodingV19Error(
      `Event log đã đạt giới hạn ${V19_MAX_EVENTS_PER_CONVERSATION} event — compact log trước khi append tiếp.`,
    );
  }
  const kind = v19ValidateEventKind(input.kind);
  const payload: V19EventPayload = input.payload ?? {};
  v19ValidateEventPayload(kind, payload);
  const last = events[events.length - 1];
  if (last && last.conversationId !== conversationId) {
    throw new CodingV19Error(
      `Không append event của conversation "${conversationId}" vào log của "${last.conversationId}".`,
    );
  }
  if (last && last.seq >= V19_MAX_EVENTS_PER_CONVERSATION) {
    throw new CodingV19Error('Event log đã đạt giới hạn seq.');
  }
  // Không append sau session_end (trừ khi log rỗng): phiên đã kết thúc
  // thì phải mở conversation mới hoặc fork — tránh log mâu thuẫn.
  if (last && last.kind === 'session_end') {
    throw new CodingV19Error(
      'Conversation đã session_end — không append thêm event (hãy fork/branch hoặc tạo conversation mới).',
    );
  }
  const seq = (last?.seq ?? 0) + 1;
  const at = typeof input.at === 'number' ? input.at : Date.now();
  if (!Number.isFinite(at) || at < 0) throw new CodingV19Error('Event at phải là số ms epoch >= 0.');
  const actor = typeof input.actor === 'string' && input.actor.trim() !== '' ? input.actor : 'agent';
  const base: Omit<V19Event, 'hash'> = {
    id: v19EventId(conversationId, seq),
    conversationId,
    seq,
    kind,
    at,
    actor,
    payload,
    prevHash: last?.hash ?? '',
  };
  const event: V19Event = { ...base, hash: v19EventHash(base) };
  return [...events, event];
}

/** Serialize một event thành một dòng JSONL (không xuống dòng trong dòng). */
export function v19EventToJsonl(event: V19Event): string {
  return JSON.stringify(event);
}

/** Serialize cả log thành JSONL (một event một dòng, kết thúc bằng \n). */
export function v19EventsToJsonl(events: readonly V19Event[]): string {
  if (events.length === 0) return '';
  return `${events.map((e) => v19EventToJsonl(e)).join('\n')}\n`;
}

/** Parse một dòng JSONL thành event (validate đầy đủ, kèm số dòng khi lỗi). */
export function v19EventFromJsonl(line: string, lineNo: number): V19Event {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw new CodingV19Error(`Dòng JSONL ${lineNo} không phải JSON hợp lệ.`);
  }
  try {
    v19ValidateEvent(parsed as V19Event);
  } catch (err) {
    throw new CodingV19Error(`Dòng JSONL ${lineNo}: ${(err as Error).message}`);
  }
  return parsed as V19Event;
}

/** Parse toàn bộ JSONL thành log (bỏ dòng trống; seq phải liên tục từ 1). */
export function v19EventsFromJsonl(jsonl: string): V19Event[] {
  const lines = jsonl.split('\n').filter((l) => l.trim() !== '');
  const events = lines.map((line, idx) => v19EventFromJsonl(line, idx + 1));
  v19VerifyEventChain(events);
  return events;
}

/**
 * Verify hash-chain + seq liên tục của log. Trả về event đầu tiên bị
 * lỗi (chuỗi rỗng = log hợp lệ). Không throw để caller render lỗi.
 */
export function v19VerifyEventChain(events: readonly V19Event[]): string {
  let prevHash = '';
  for (let i = 0; i < events.length; i += 1) {
    const event = events[i]!;
    if (event.seq !== i + 1) {
      return `seq không liên tục tại vị trí ${i + 1} (nhận seq ${event.seq}, kỳ vọng ${i + 1}).`;
    }
    if (event.prevHash !== prevHash) {
      return `prevHash vỡ tại seq ${event.seq} (log đã bị chèn/xoá event).`;
    }
    if (v19EventHash(event) !== event.hash) {
      return `hash vỡ tại seq ${event.seq} (event đã bị sửa sau khi ghi).`;
    }
    prevHash = event.hash;
  }
  return '';
}

/** true khi log hợp lệ (chain + seq + từng event). */
export function v19IsValidEventLog(events: readonly V19Event[]): boolean {
  try {
    for (const event of events) v19ValidateEvent(event);
    return v19VerifyEventChain(events) === '';
  } catch {
    return false;
  }
}

/** Lấy event theo seq (undefined khi không có). */
export function v19EventBySeq(events: readonly V19Event[], seq: number): V19Event | undefined {
  return events.find((e) => e.seq === seq);
}

/** Lấy các event trong khoảng seq [fromSeq, toSeq] (bao cả hai đầu). */
export function v19EventsInRange(
  events: readonly V19Event[],
  fromSeq: number,
  toSeq?: number,
): V19Event[] {
  const end = toSeq ?? Number.MAX_SAFE_INTEGER;
  return events.filter((e) => e.seq >= fromSeq && e.seq <= end);
}

/** Đếm event theo kind (để thống kê conversation). */
export function v19CountEventsByKind(events: readonly V19Event[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const event of events) counts[event.kind] = (counts[event.kind] ?? 0) + 1;
  return counts;
}

/**
 * Replay event log thành trạng thái conversation. Replay là hàm thuần:
 * cùng một log luôn cho cùng một state (dùng để khôi phục sau restart,
 * hoặc kiểm chứng state đã lưu). Tool call ghép với tool_result kề
 * sau cùng toolName; file_edit cập nhật filesChanged; checkpoint /
 * preset / plugin lấy trạng thái gần nhất.
 */
export function v19ReplayEvents(
  conversationId: string,
  events: readonly V19Event[],
): V19ConversationState {
  const chainError = v19VerifyEventChain(events);
  if (chainError !== '') throw new CodingV19Error(`Không replay log vỡ: ${chainError}`);
  for (const event of events) {
    if (event.conversationId !== conversationId) {
      throw new CodingV19Error(
        `Event seq ${event.seq} thuộc conversation "${event.conversationId}", không phải "${conversationId}".`,
      );
    }
  }
  const state: V19ConversationState = {
    conversationId,
    ended: false,
    messages: [],
    toolCalls: [],
    filesChanged: [],
    checkpoints: [],
    plugins: [],
    eventsReplayed: events.length,
    lastSeq: events.length === 0 ? 0 : events[events.length - 1]!.seq,
    startedAt: events.length === 0 ? 0 : events[0]!.at,
    lastAt: events.length === 0 ? 0 : events[events.length - 1]!.at,
  };
  const fileIndex = new Map<string, V19FileChange>();
  const pluginIndex = new Map<string, V19PluginRuntimeState>();
  let pendingToolCall: V19Event | undefined;

  const flushPendingToolCall = (): void => {
    if (!pendingToolCall) return;
    state.toolCalls.push({
      seq: pendingToolCall.seq,
      toolName: pendingToolCall.payload.toolName ?? '',
      argsJson: pendingToolCall.payload.toolArgsJson ?? '{}',
      at: pendingToolCall.at,
    });
    pendingToolCall = undefined;
  };

  for (const event of events) {
    const p = event.payload;
    switch (event.kind) {
      case 'session_start':
        state.ended = false;
        break;
      case 'session_end':
        state.ended = true;
        if (typeof p.endReason === 'string') state.endReason = p.endReason;
        flushPendingToolCall();
        break;
      case 'user_message':
        state.messages.push({ seq: event.seq, role: 'user', text: p.text ?? '', at: event.at });
        break;
      case 'assistant_message':
        state.messages.push({ seq: event.seq, role: 'assistant', text: p.text ?? '', at: event.at });
        break;
      case 'tool_call':
        flushPendingToolCall();
        pendingToolCall = event;
        break;
      case 'tool_result': {
        if (pendingToolCall && pendingToolCall.payload.toolName === p.toolName) {
          state.toolCalls.push({
            seq: pendingToolCall.seq,
            toolName: pendingToolCall.payload.toolName ?? '',
            argsJson: pendingToolCall.payload.toolArgsJson ?? '{}',
            result: p.result,
            ok: p.ok,
            at: pendingToolCall.at,
          });
          pendingToolCall = undefined;
        } else {
          // tool_result mồ côi (không có tool_call trước đó): vẫn ghi
          // nhận để không mất thông tin, seq là seq của result.
          state.toolCalls.push({
            seq: event.seq,
            toolName: p.toolName ?? '',
            argsJson: '{}',
            result: p.result,
            ok: p.ok,
            at: event.at,
          });
        }
        break;
      }
      case 'file_edit': {
        const filePath = p.filePath ?? '';
        const action = p.fileAction ?? 'edit';
        fileIndex.set(filePath, { filePath, action, lastSeq: event.seq, at: event.at });
        break;
      }
      case 'checkpoint':
        state.checkpoints.push({
          checkpointId: p.checkpointId ?? '',
          label: p.checkpointLabel ?? '',
          seq: event.seq,
          at: event.at,
        });
        break;
      case 'rollback':
        // Rollback không xoá history: checkpoints trước đó vẫn còn
        // trong log; state giữ nguyên danh sách để UI thấy được.
        break;
      case 'branch':
        break;
      case 'preset_applied':
        state.presetId = p.presetId;
        break;
      case 'plugin_change': {
        const pluginId = p.pluginId ?? '';
        const change = p.pluginChange ?? 'load';
        const prev = pluginIndex.get(pluginId);
        const next: V19PluginRuntimeState = {
          pluginId,
          loaded: change === 'unload' ? false : prev?.loaded ?? change === 'load',
          enabled: change === 'disable' ? false : change === 'enable' ? true : prev?.enabled ?? change === 'load',
          lastChange: change,
          lastSeq: event.seq,
        };
        // load => loaded=true, enabled giữ nguyên (mặc định true khi mới load).
        if (change === 'load' && prev === undefined) next.enabled = true;
        pluginIndex.set(pluginId, next);
        break;
      }
      case 'note':
        break;
      default:
        break;
    }
  }
  flushPendingToolCall();
  state.filesChanged = [...fileIndex.values()].sort((a, b) => a.filePath.localeCompare(b.filePath));
  state.plugins = [...pluginIndex.values()].sort((a, b) => a.pluginId.localeCompare(b.pluginId));
  return state;
}

/**
 * Compact log: thay fileContent của các file_edit cũ (trừ N event gần
 * nhất) bằng marker đã cắt — log vẫn replay đúng messages/tool calls/
 * filesChanged (chỉ mất nội dung file cũ, vốn đã nằm trong snapshot
 * workspace). Trả log mới (re-hash chain vì payload đổi).
 */
export function v19CompactEvents(
  events: readonly V19Event[],
  keepRecent = 50,
): V19Event[] {
  if (events.length <= keepRecent) return [...events];
  const cutoff = events.length - keepRecent;
  const compacted: V19Event[] = [];
  let prevHash = '';
  for (let i = 0; i < events.length; i += 1) {
    const src = events[i]!;
    let payload = src.payload;
    if (i < cutoff && src.kind === 'file_edit' && typeof src.payload.fileContent === 'string') {
      payload = { ...src.payload, fileContent: '[compacted]', extra: { ...(src.payload.extra ?? {}), compacted: true } };
    }
    const base: Omit<V19Event, 'hash'> = {
      id: src.id,
      conversationId: src.conversationId,
      seq: src.seq,
      kind: src.kind,
      at: src.at,
      actor: src.actor,
      payload,
      prevHash,
    };
    const event: V19Event = { ...base, hash: v19EventHash(base) };
    compacted.push(event);
    prevHash = event.hash;
  }
  return compacted;
}

/** Render ngắn gọn một event (một dòng, dùng cho log/UI). */
export function renderV19Event(event: V19Event): string {
  const p = event.payload;
  switch (event.kind) {
    case 'user_message':
      return `#${event.seq} user: ${p.text ?? ''}`;
    case 'assistant_message':
      return `#${event.seq} assistant: ${p.text ?? ''}`;
    case 'tool_call':
      return `#${event.seq} tool_call ${p.toolName ?? ''} ${p.toolArgsJson ?? ''}`;
    case 'tool_result':
      return `#${event.seq} tool_result ${p.toolName ?? ''} ok=${p.ok === true ? 'true' : 'false'}: ${(p.result ?? '').slice(0, 120)}`;
    case 'file_edit':
      return `#${event.seq} file_edit ${p.fileAction ?? 'edit'} ${p.filePath ?? ''}`;
    case 'checkpoint':
      return `#${event.seq} checkpoint ${p.checkpointId ?? ''} (${p.checkpointLabel ?? ''})`;
    case 'rollback':
      return `#${event.seq} rollback -> ${p.checkpointId ?? ''}`;
    case 'branch':
      return `#${event.seq} branch -> ${p.branchToConversationId ?? ''} @seq ${p.branchFromSeq ?? 0}`;
    case 'preset_applied':
      return `#${event.seq} preset_applied ${p.presetId ?? ''}`;
    case 'plugin_change':
      return `#${event.seq} plugin_change ${p.pluginId ?? ''} ${p.pluginChange ?? ''}`;
    case 'session_start':
      return `#${event.seq} session_start`;
    case 'session_end':
      return `#${event.seq} session_end (${p.endReason ?? ''})`;
    case 'note':
      return `#${event.seq} note: ${p.text ?? ''}`;
    default:
      return `#${event.seq} ${event.kind}`;
  }
}

/** Render toàn bộ log thành text (mỗi event một dòng). */
export function renderV19EventLog(events: readonly V19Event[]): string {
  if (events.length === 0) return '(event log rỗng)';
  return events.map((e) => renderV19Event(e)).join('\n');
}

/** Render trạng thái conversation sau replay (tóm tắt cho UI/tool). */
export function renderV19ConversationState(state: V19ConversationState): string {
  const lines = [
    `Conversation ${state.conversationId}: ${state.eventsReplayed} event (seq ${state.lastSeq}), ${state.messages.length} tin nhắn, ${state.toolCalls.length} tool call, ${state.filesChanged.length} file đổi, ${state.checkpoints.length} checkpoint.`,
    `Trạng thái: ${state.ended ? `đã kết thúc${state.endReason ? ` (${state.endReason})` : ''}` : 'đang mở'}.`,
  ];
  if (state.presetId) lines.push(`Preset: ${state.presetId}.`);
  if (state.filesChanged.length > 0) {
    lines.push(`File đã đổi: ${state.filesChanged.map((f) => `${f.filePath} (${f.action})`).join(', ')}.`);
  }
  if (state.checkpoints.length > 0) {
    lines.push(`Checkpoint: ${state.checkpoints.map((c) => `${c.checkpointId} (${c.label})`).join(', ')}.`);
  }
  if (state.plugins.length > 0) {
    lines.push(
      `Plugin: ${state.plugins.map((p) => `${p.pluginId} (${p.loaded ? 'loaded' : 'unloaded'}${p.enabled ? ', enabled' : ', disabled'})`).join(', ')}.`,
    );
  }
  return lines.join('\n');
}

/**
 * Coding agent v17 — trajectory log (event-sourced, append-only).
 *
 * Ý tưởng học từ OpenHands 1.x (survey v139 §4): mọi thứ là event —
 * prompt, bash, file change, lỗi compiler đều là event bất biến trong
 * append-only log → deterministic replay + session recovery. Thiết kế
 * và code là của open-bot (nối trên coding v14 eventSession / v16
 * agent, không copy từ repo khác):
 *
 * - Event bất biến: một khi append, không sửa, không xoá (chỉ recovery
 *   cắt đuôi hỏng — và việc cắt đó cũng được ghi lại thành event
 *   'recovery' trong log mới).
 * - Hash chain: mỗi event mang sha256(prevHash + canonical payload),
 *   verify phát hiện event bị sửa/xoá/chèn.
 * - Replay: chạy lại event theo seq để tái tạo trạng thái phiên
 *   (file đã ghi, bash đã chạy, lỗi compiler, plan, test cuối) — cùng
 *   log luôn cho cùng trạng thái (deterministic).
 * - Recovery: log hỏng ở seq N → giữ prefix [0..N), replay prefix,
 *   phiên tiếp tục từ đó thay vì mất toàn bộ.
 * - Snapshot/compaction: snapshot = trạng thái replay tại seq K +
 *   con trỏ; log sau snapshot chỉ giữ event từ K trở đi.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { CodingV17Error } from './types';
import type {
  V17Plan,
  V17ReplayState,
  V17TestResult,
  V17TrajectoryEvent,
  V17TrajectoryEventKind,
  V17TrajectoryRecovery,
  V17TrajectoryVerification,
} from './types';

/** Canonical JSON: key sắp xếp, để hash ổn định giữa các lần chạy. */
export function v17CanonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((v) => v17CanonicalJson(v)).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${v17CanonicalJson(obj[k])}`).join(',')}}`;
}

/** Hash chuỗi cho một event (không tính field hash của chính nó). */
export function v17EventHash(
  seq: number,
  sessionId: string,
  kind: V17TrajectoryEventKind,
  at: number,
  payload: Record<string, unknown>,
  prevHash: string,
): string {
  const canonical = v17CanonicalJson({ seq, sessionId, kind, at, payload, prevHash });
  return crypto.createHash('sha256').update(canonical, 'utf8').digest('hex');
}

/** Validate payload phải là object JSON-serializable. */
export function v17ValidateEventPayload(payload: unknown): Record<string, unknown> {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new CodingV17Error('trajectory-invalid', 'payload phải là object.');
  }
  try {
    JSON.stringify(payload);
  } catch {
    throw new CodingV17Error('trajectory-invalid', 'payload phải JSON-serializable.');
  }
  return payload as Record<string, unknown>;
}

/** Validate một event đã đọc từ đĩa (đủ field, đúng kiểu). */
export function v17ValidateEvent(raw: unknown, index: number): V17TrajectoryEvent {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new CodingV17Error('trajectory-invalid', `event[${index}] phải là object.`);
  }
  const e = raw as Record<string, unknown>;
  if (typeof e['seq'] !== 'number' || !Number.isInteger(e['seq']) || (e['seq'] as number) < 0) {
    throw new CodingV17Error('trajectory-invalid', `event[${index}].seq phải là số nguyên >= 0.`);
  }
  if (typeof e['sessionId'] !== 'string' || (e['sessionId'] as string).trim() === '') {
    throw new CodingV17Error('trajectory-invalid', `event[${index}].sessionId không được rỗng.`);
  }
  if (typeof e['kind'] !== 'string' || (e['kind'] as string).trim() === '') {
    throw new CodingV17Error('trajectory-invalid', `event[${index}].kind không được rỗng.`);
  }
  if (typeof e['at'] !== 'number' || !Number.isFinite(e['at'] as number)) {
    throw new CodingV17Error('trajectory-invalid', `event[${index}].at phải là số hữu hạn.`);
  }
  if (typeof e['hash'] !== 'string' || (e['hash'] as string).length !== 64) {
    throw new CodingV17Error('trajectory-invalid', `event[${index}].hash phải là sha256 hex (64 ký tự).`);
  }
  if (typeof e['prevHash'] !== 'string') {
    throw new CodingV17Error('trajectory-invalid', `event[${index}].prevHash phải là string.`);
  }
  const payload = v17ValidateEventPayload(e['payload']);
  return {
    seq: e['seq'] as number,
    sessionId: e['sessionId'] as string,
    kind: e['kind'] as V17TrajectoryEventKind,
    at: e['at'] as number,
    payload,
    hash: e['hash'] as string,
    prevHash: e['prevHash'] as string,
  };
}

/** Một dòng JSONL của trajectory log (event + dòng trống bỏ qua). */
export function v17EventToJsonl(event: V17TrajectoryEvent): string {
  return `${JSON.stringify(event)}\n`;
}

/** Parse một dòng JSONL thành event (lỗi rõ ràng khi dòng hỏng). */
export function v17EventFromJsonl(line: string, index: number): V17TrajectoryEvent {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw new CodingV17Error('trajectory-corrupt', `dòng ${index} không phải JSON hợp lệ.`);
  }
  return v17ValidateEvent(parsed, index);
}

/** Parse toàn bộ nội dung JSONL thành danh sách event (bỏ dòng trống). */
export function v17EventsFromJsonl(content: string): V17TrajectoryEvent[] {
  const events: V17TrajectoryEvent[] = [];
  const lines = content.split('\n');
  let index = 0;
  for (const line of lines) {
    if (line.trim() === '') continue;
    events.push(v17EventFromJsonl(line, index));
    index += 1;
  }
  return events;
}

/**
 * Replay một danh sách event (đã sắp theo seq) thành trạng thái phiên.
 * Deterministic: cùng log → cùng trạng thái. Event lạ kind thì bỏ qua
 * (forward-compatible: log mới có kind cũ không biết vẫn replay được).
 */
export function v17ReplayEvents(
  events: readonly V17TrajectoryEvent[],
  sessionId: string,
): V17ReplayState {
  const sorted = [...events].sort((a, b) => a.seq - b.seq);
  const state: V17ReplayState = {
    sessionId,
    eventsReplayed: 0,
    files: {},
    deletedFiles: [],
    bashCommands: [],
    compilerErrors: [],
    ended: false,
  };
  for (const event of sorted) {
    if (event.sessionId !== sessionId) continue;
    state.eventsReplayed += 1;
    const p = event.payload;
    switch (event.kind) {
      case 'bash': {
        if (typeof p['command'] === 'string') state.bashCommands.push(p['command']);
        break;
      }
      case 'file_write':
      case 'file_edit': {
        if (typeof p['path'] === 'string' && typeof p['content'] === 'string') {
          state.files[p['path']] = p['content'];
          state.deletedFiles = state.deletedFiles.filter((d) => d !== p['path']);
        }
        break;
      }
      case 'file_delete': {
        if (typeof p['path'] === 'string') {
          delete state.files[p['path']];
          if (!state.deletedFiles.includes(p['path'])) state.deletedFiles.push(p['path']);
        }
        break;
      }
      case 'compiler_error': {
        if (typeof p['message'] === 'string') state.compilerErrors.push(p['message']);
        else if (typeof p['error'] === 'string') state.compilerErrors.push(p['error']);
        break;
      }
      case 'test_result': {
        if (p['result'] && typeof p['result'] === 'object') {
          state.lastTestResult = p['result'] as V17TestResult;
        }
        break;
      }
      case 'plan_created':
      case 'plan_refined':
      case 'plan_approved': {
        if (p['plan'] && typeof p['plan'] === 'object') {
          state.plan = p['plan'] as V17Plan;
        }
        break;
      }
      case 'session_end': {
        state.ended = true;
        if (typeof p['reason'] === 'string') state.endReason = p['reason'];
        break;
      }
      default:
        break;
    }
  }
  return state;
}

/** Kiểm tra chuỗi hash + tính liên tục seq của một danh sách event. */
export function v17VerifyEvents(events: readonly V17TrajectoryEvent[]): V17TrajectoryVerification {
  const sorted = [...events].sort((a, b) => a.seq - b.seq);
  let prevHash = '';
  for (let i = 0; i < sorted.length; i += 1) {
    const event = sorted[i] as V17TrajectoryEvent;
    if (event.seq !== i) {
      return {
        ok: false,
        eventsChecked: i,
        firstBadSeq: event.seq,
        reason: `seq không liên tục: mong ${i}, gặp ${event.seq}.`,
      };
    }
    if (event.prevHash !== prevHash) {
      return {
        ok: false,
        eventsChecked: i,
        firstBadSeq: event.seq,
        reason: `prevHash tại seq ${event.seq} không khớp hash event trước.`,
      };
    }
    const expected = v17EventHash(
      event.seq,
      event.sessionId,
      event.kind,
      event.at,
      event.payload,
      event.prevHash,
    );
    if (expected !== event.hash) {
      return {
        ok: false,
        eventsChecked: i,
        firstBadSeq: event.seq,
        reason: `hash tại seq ${event.seq} không khớp nội dung (event đã bị sửa).`,
      };
    }
    prevHash = event.hash;
  }
  return { ok: true, eventsChecked: sorted.length };
}

/**
 * Recovery: tìm prefix hợp lệ dài nhất, replay prefix đó.
 * Trả về số event giữ/bỏ + trạng thái tái tạo từ prefix.
 */
export function v17RecoverEvents(
  events: readonly V17TrajectoryEvent[],
  sessionId: string,
): V17TrajectoryRecovery {
  const sorted = [...events].sort((a, b) => a.seq - b.seq);
  const verification = v17VerifyEvents(sorted);
  if (verification.ok) {
    return {
      keptEvents: sorted.length,
      droppedEvents: 0,
      state: v17ReplayEvents(sorted, sessionId),
    };
  }
  const firstBad = verification.firstBadSeq ?? 0;
  const kept = sorted.filter((e) => e.seq < firstBad);
  return {
    keptEvents: kept.length,
    droppedEvents: sorted.length - kept.length,
    firstBadSeq: firstBad,
    reason: verification.reason,
    state: v17ReplayEvents(kept, sessionId),
  };
}

/** Tóm tắt một event thành một dòng đọc được (cho render log). */
export function v17SummarizeEvent(event: V17TrajectoryEvent): string {
  const p = event.payload;
  const short = (v: unknown, n = 80): string => {
    const s = typeof v === 'string' ? v : JSON.stringify(v) ?? '';
    return s.length > n ? `${s.slice(0, n)}…` : s;
  };
  switch (event.kind) {
    case 'prompt':
      return `prompt: ${short(p['text'] ?? p['prompt'])}`;
    case 'bash':
      return `bash: ${short(p['command'])}`;
    case 'bash_output':
      return `bash output (exit ${String(p['exitCode'] ?? '?')}): ${short(p['stdout'] ?? p['output'])}`;
    case 'file_write':
      return `write ${String(p['path'] ?? '?')} (${String(p['content'] ?? '').length} ký tự)`;
    case 'file_edit':
      return `edit ${String(p['path'] ?? '?')}`;
    case 'file_delete':
      return `delete ${String(p['path'] ?? '?')}`;
    case 'compiler_error':
      return `compiler error: ${short(p['message'] ?? p['error'])}`;
    case 'test_result':
      return `test: ${short(p['summary'] ?? JSON.stringify(p['result'] ?? {}))}`;
    case 'critic_score':
      return `critic: ${short(p['verdict'] ?? '?')} (${String(p['score'] ?? '?')}/100)`;
    case 'plan_created':
      return `plan created (${String((p['plan'] as { steps?: unknown[] } | undefined)?.steps?.length ?? '?')} bước)`;
    case 'plan_approved':
      return 'plan approved';
    case 'sandbox_run':
      return `sandbox ${String(p['isolation'] ?? '?')}: ${short(p['command'])} (exit ${String(p['exitCode'] ?? '?')})`;
    case 'sandbox_fallback':
      return `sandbox fallback: ${short(p['reason'] ?? '?')}`;
    case 'session_end':
      return `session end: ${short(p['reason'] ?? '')}`;
    case 'recovery':
      return `recovery: giữ ${String(p['keptEvents'] ?? '?')} event, bỏ ${String(p['droppedEvents'] ?? '?')}`;
    default:
      return `${event.kind}: ${short(p)}`;
  }
}

/** Render toàn bộ log thành text (một dòng / event). */
export function renderV17Trajectory(events: readonly V17TrajectoryEvent[]): string {
  if (events.length === 0) return 'Trajectory rỗng (chưa có event).';
  const sorted = [...events].sort((a, b) => a.seq - b.seq);
  const lines = sorted.map(
    (e) => `#${e.seq} [${e.kind}] ${v17SummarizeEvent(e)} (hash ${e.hash.slice(0, 8)})`,
  );
  return `Trajectory (${sorted.length} events):\n${lines.join('\n')}`;
}

/** Render trạng thái replay thành text. */
export function renderV17ReplayState(state: V17ReplayState): string {
  const lines = [
    `Session ${state.sessionId}: ${state.eventsReplayed} events replayed.`,
    `Files: ${Object.keys(state.files).length} (${Object.keys(state.files).join(', ') || 'không có'}).`,
    `Deleted: ${state.deletedFiles.length} (${state.deletedFiles.join(', ') || 'không có'}).`,
    `Bash: ${state.bashCommands.length} lệnh.`,
    `Compiler errors: ${state.compilerErrors.length}.`,
    state.lastTestResult
      ? `Test cuối: ${state.lastTestResult.testId} ${state.lastTestResult.passed ? 'PASS' : 'FAIL'}.`
      : 'Chưa có kết quả test.',
    state.plan ? `Plan: ${state.plan.status} (${state.plan.steps.length} bước).` : 'Không có plan.',
    state.ended ? `Đã kết thúc: ${state.endReason ?? ''}` : 'Chưa kết thúc.',
  ];
  return lines.join('\n');
}

/**
 * TrajectoryLog — append-only log bền trên đĩa (một file JSONL / session).
 *
 * - append(): ghi event mới (seq tiếp nối, hash chain), flush ra đĩa ngay.
 * - load(): đọc lại từ đĩa, verify; event hỏng → lỗi rõ ràng (dùng
 *   recover() để cắt đuôi hỏng thay vì mất log).
 * - recover(): cắt đuôi hỏng, ghi log mới + event 'recovery' ghi lại
 *   việc cắt (để lịch sử vẫn truy vết được).
 * - snapshot(): trạng thái replay tại seq hiện tại (để compaction sau này).
 */
export class TrajectoryLog {
  readonly sessionId: string;
  readonly file: string;
  private events: V17TrajectoryEvent[] = [];
  private loaded = false;

  constructor(sessionId: string, file: string) {
    if (sessionId.trim() === '') {
      throw new CodingV17Error('trajectory-invalid', 'sessionId không được rỗng.');
    }
    if (file.trim() === '') {
      throw new CodingV17Error('trajectory-invalid', 'file log không được rỗng.');
    }
    this.sessionId = sessionId;
    this.file = file;
  }

  /** Số event đã load/append. */
  get length(): number {
    return this.events.length;
  }

  /** Hash event cuối ('' khi log rỗng). */
  get lastHash(): string {
    return this.events.length === 0 ? '' : (this.events[this.events.length - 1] as V17TrajectoryEvent).hash;
  }

  /** Đọc log từ đĩa (nếu file chưa có → log rỗng). */
  load(): V17TrajectoryEvent[] {
    if (!fs.existsSync(this.file)) {
      this.events = [];
      this.loaded = true;
      return [];
    }
    const content = fs.readFileSync(this.file, 'utf8');
    const parsed = v17EventsFromJsonl(content);
    for (const event of parsed) {
      if (event.sessionId !== this.sessionId) {
        throw new CodingV17Error(
          'trajectory-invalid',
          `event seq ${event.seq} thuộc session khác (${event.sessionId}).`,
        );
      }
    }
    this.events = [...parsed].sort((a, b) => a.seq - b.seq);
    this.loaded = true;
    return [...this.events];
  }

  /** Append một event mới (ghi đĩa ngay, trả event đã hash). */
  append(
    kind: V17TrajectoryEventKind,
    payload: Record<string, unknown>,
    at = Date.now(),
  ): V17TrajectoryEvent {
    if (!this.loaded) this.load();
    const clean = v17ValidateEventPayload(payload);
    const seq = this.events.length;
    const prevHash = this.lastHash;
    const hash = v17EventHash(seq, this.sessionId, kind, at, clean, prevHash);
    const event: V17TrajectoryEvent = {
      seq,
      sessionId: this.sessionId,
      kind,
      at,
      payload: clean,
      hash,
      prevHash,
    };
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.appendFileSync(this.file, v17EventToJsonl(event), 'utf8');
    this.events.push(event);
    return event;
  }

  /** Mọi event (bản sao, đã sắp theo seq). */
  all(): V17TrajectoryEvent[] {
    if (!this.loaded) this.load();
    return [...this.events];
  }

  /** Event theo kind (giữ thứ tự seq). */
  byKind(kind: V17TrajectoryEventKind): V17TrajectoryEvent[] {
    return this.all().filter((e) => e.kind === kind);
  }

  /** Kiểm tra chuỗi hash + seq của log hiện tại. */
  verify(): V17TrajectoryVerification {
    return v17VerifyEvents(this.all());
  }

  /** Replay log hiện tại thành trạng thái phiên. */
  replay(): V17ReplayState {
    return v17ReplayEvents(this.all(), this.sessionId);
  }

  /**
   * Recovery: log hỏng → giữ prefix hợp lệ, ghi đè file bằng prefix +
   * một event 'recovery' ghi lại việc cắt đuôi. Trả báo cáo recovery.
   */
  recover(): V17TrajectoryRecovery {
    const all = this.all();
    const recovery = v17RecoverEvents(all, this.sessionId);
    if (recovery.droppedEvents === 0) return recovery;
    const kept = all.filter((e) => e.seq < (recovery.firstBadSeq ?? 0));
    const content = kept.map((e) => v17EventToJsonl(e)).join('');
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, content, 'utf8');
    this.events = kept;
    this.append('recovery', {
      keptEvents: recovery.keptEvents,
      droppedEvents: recovery.droppedEvents,
      firstBadSeq: recovery.firstBadSeq,
      reason: recovery.reason ?? '',
    });
    return recovery;
  }

  /** Snapshot trạng thái replay tại seq hiện tại (kèm seq để compaction). */
  snapshot(): { atSeq: number; state: V17ReplayState } {
    return { atSeq: this.events.length, state: this.replay() };
  }
}

/** Kết quả compaction của trajectory log. */
export interface V17TrajectoryCompaction {
  /** Seq mà snapshot chụp (mọi event < atSeq đã gộp vào snapshot). */
  atSeq: number;
  /** Số event đã gộp vào snapshot. */
  compactedEvents: number;
  /** Số event còn lại trong log sau snapshot. */
  remainingEvents: number;
  /** Trạng thái replay tại atSeq (để khôi phục mà không cần event cũ). */
  state: V17ReplayState;
}

/**
 * Compaction: snapshot trạng thái replay tại seq hiện tại, rồi viết
 * lại log chỉ giữ event 'snapshot' (mang state + atSeq) + các event
 * sau đó. Hash chain được bắt đầu lại từ snapshot (prevHash của
 * snapshot event là hash event cuối trước compaction — ghi rõ trong
 * payload để verify vẫn truy vết được).
 *
 * Lưu ý: compaction làm mất event gốc trước atSeq — chỉ dùng khi log
 * quá dài và snapshot đã được lưu riêng (caller giữ bản snapshot).
 * Hàm này KHÔNG tự xoá file gốc: nó trả về nội dung log mới, caller
 * quyết định ghi đè.
 */
export function v17CompactTrajectory(
  events: readonly V17TrajectoryEvent[],
  sessionId: string,
): { compaction: V17TrajectoryCompaction; newEvents: V17TrajectoryEvent[] } {
  const sorted = [...events].sort((a, b) => a.seq - b.seq);
  if (sorted.length === 0) {
    throw new CodingV17Error('trajectory-empty', 'không có event để compact.');
  }
  const verification = v17VerifyEvents(sorted);
  if (!verification.ok) {
    throw new CodingV17Error(
      'trajectory-corrupt',
      `không compact log hỏng (hỏng tại seq ${String(verification.firstBadSeq)}: ${verification.reason ?? ''}) — recover trước.`,
    );
  }
  const state = v17ReplayEvents(sorted, sessionId);
  const atSeq = sorted.length;
  const lastHash = (sorted[sorted.length - 1] as V17TrajectoryEvent).hash;
  const nowMs = Date.now();
  const snapshotPayload: Record<string, unknown> = {
    atSeq,
    prevHashBeforeCompaction: lastHash,
    state: JSON.parse(JSON.stringify(state)) as Record<string, unknown>,
  };
  const snapshotEvent: V17TrajectoryEvent = {
    seq: 0,
    sessionId,
    kind: 'snapshot',
    at: nowMs,
    payload: snapshotPayload,
    hash: v17EventHash(0, sessionId, 'snapshot', nowMs, snapshotPayload, ''),
    prevHash: '',
  };
  return {
    compaction: { atSeq, compactedEvents: sorted.length, remainingEvents: 1, state },
    newEvents: [snapshotEvent],
  };
}

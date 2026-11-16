/**
 * Event-sourced conversation log cho coding agent v6 (v1.14, Đội T3).
 *
 * Ý tưởng học từ OpenHands V1 SDK (survey v1.14 §2): Conversation =
 * stream event Action ↔ Observation, log append-only là single source
 * of truth — replay log là tái tạo toàn bộ hội thoại. Nối với
 * event-log của open-bot (v1.01–v1.04: hash chain, replay, time-travel,
 * fork) và conversationV112 (v1.12: session/branch/snapshot): cùng
 * nguyên tắc, nhưng event `v6.*` mang payload riêng của coding agent
 * (action đã parse, verdict bảo mật, delegation, router decision,
 * stuck, condensation) và fold ra `V6State` (file đã đổi, quyết định,
 * lỗi đã gặp) thay vì `ReplayedRunState` chung.
 *
 * Đảm bảo:
 * - Append-only: không có API sửa/xoá event. Muốn "quay lại" thì
 *   fork (`forkAt`) hoặc xem state tại seq (`stateAt`) — lịch sử cũ
 *   còn nguyên.
 * - Hash chain SHA-256: mỗi event nối `prevHash` của event trước;
 *   `verifyChain` phát hiện log bị sửa.
 * - Replay/time-travel: `replayFrom(seq)` chạy lại fold từ event N;
 *   `stateAt(seq)` trả state tại bất kỳ điểm nào; `forkAt(seq)` tạo
 *   log con sao chép prefix tới seq đó (ghi event `v6.forked` ở cả
 *   hai log — log cha ghi fork, log con ghi session.started với
 *   parentSessionId/forkFromSeq).
 * - Serialize: `toJsonl` / `fromJsonl` (một event một dòng) để tools
 *   lưu xuống đĩa; `fromJsonl` verify chain khi nạp.
 *
 * Module thuần (không fs): lưu đĩa nằm ở tầng tools.
 */

import { createHash, randomUUID } from 'node:crypto';
import type { V6ChangedFile, V6Decision, V6EncounteredError, V6Event, V6EventType, V6ModelTier, V6State } from './types';

/** Hash của event đầu tiên (không có prev). */
export const V6_GENESIS_PREV_HASH = '';

/** Cắt text payload để log không phình (secret đã redact ở tầng gọi). */
export const V6_LOG_TEXT_LIMIT = 4000;

/** Cắt ngắn text cho payload log. */
export function clipV6Text(text: string, limit: number = V6_LOG_TEXT_LIMIT): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}…`;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

/** Hash SHA-256 của một event (không tính trường `hash`). */
export function hashV6Event(event: Omit<V6Event, 'hash'>): string {
  const input = stableStringify({
    seq: event.seq,
    sessionId: event.sessionId,
    at: event.at,
    type: event.type,
    payload: event.payload,
    prevHash: event.prevHash,
  });
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/** Trạng thái rỗng cho một session mới. */
export function emptyV6State(sessionId: string, title = ''): V6State {
  return {
    sessionId,
    lastSeq: 0,
    status: 'running',
    title,
    messages: [],
    filesChanged: [],
    decisions: [],
    errors: [],
    actionsExecuted: 0,
    failedObservations: 0,
    delegations: 0,
    currentTier: 'standard',
    currentModel: undefined,
    condensations: 0,
    stuckDetections: 0,
    lastCondensedUpToSeq: 0,
  };
}

function recordFileChange(state: V6State, path: string, seq: number): void {
  const existing = state.filesChanged.find((f) => f.path === path);
  if (existing) {
    existing.lastSeq = seq;
    existing.changes += 1;
  } else {
    const entry: V6ChangedFile = { path, firstSeq: seq, lastSeq: seq, changes: 1 };
    state.filesChanged.push(entry);
  }
}

function recordError(state: V6State, text: string, seq: number, source?: string): void {
  if (text.trim() === '') return;
  const entry: V6EncounteredError = { seq, text: clipV6Text(text, 500) };
  if (source) entry.source = source;
  state.errors.push(entry);
}

/**
 * Fold một event vào state (pure — dùng cho replay lẫn stateAt).
 * Event lạ (type không biết) bị bỏ qua, không throw: log cũ/mới
 * vẫn replay được khi thêm type mới.
 */
export function foldV6Event(state: V6State, event: V6Event): V6State {
  const p = event.payload as Record<string, unknown>;
  state.lastSeq = Math.max(state.lastSeq, event.seq);
  switch (event.type) {
    case 'v6.session.started': {
      if (typeof p['title'] === 'string') state.title = p['title'] as string;
      break;
    }
    case 'v6.user.message': {
      if (typeof p['text'] === 'string') {
        state.messages.push({ role: 'user', text: p['text'] as string, seq: event.seq });
      }
      break;
    }
    case 'v6.model.message': {
      if (typeof p['text'] === 'string') {
        state.messages.push({ role: 'model', text: p['text'] as string, seq: event.seq });
      }
      break;
    }
    case 'v6.model.routed': {
      if (p['tier'] === 'light' || p['tier'] === 'standard' || p['tier'] === 'strong') {
        state.currentTier = p['tier'] as V6ModelTier;
      }
      if (typeof p['model'] === 'string') state.currentModel = p['model'] as string;
      break;
    }
    case 'v6.action.parsed': {
      if (p['kind'] === 'think' && typeof p['text'] === 'string') {
        const text = p['text'] as string;
        for (const line of text.split('\n')) {
          const m = line.match(/^\s*(?:Quyết định|Decision)\s*:\s*(.+)\s*$/i);
          if (m?.[1]) {
            const decision: V6Decision = { seq: event.seq, text: clipV6Text(m[1].trim(), 500) };
            state.decisions.push(decision);
          }
        }
      }
      if (p['kind'] === 'finish' && typeof p['summary'] === 'string') {
        const decision: V6Decision = { seq: event.seq, text: `Finish: ${clipV6Text(p['summary'] as string, 500)}` };
        state.decisions.push(decision);
      }
      break;
    }
    case 'v6.action.executed': {
      state.actionsExecuted += 1;
      if (p['kind'] === 'edit' && typeof p['path'] === 'string') {
        recordFileChange(state, p['path'] as string, event.seq);
      }
      break;
    }
    case 'v6.observation': {
      if (p['ok'] === false) {
        state.failedObservations += 1;
        const stderr = typeof p['stderr'] === 'string' ? (p['stderr'] as string) : '';
        const stdout = typeof p['stdout'] === 'string' ? (p['stdout'] as string) : '';
        const errText = stderr.trim() !== '' ? stderr : stdout;
        const kind = typeof p['kind'] === 'string' ? (p['kind'] as string) : undefined;
        recordError(state, errText, event.seq, kind);
      }
      break;
    }
    case 'v6.file.changed': {
      if (typeof p['path'] === 'string') recordFileChange(state, p['path'] as string, event.seq);
      break;
    }
    case 'v6.error': {
      if (typeof p['message'] === 'string') {
        const source = typeof p['source'] === 'string' ? (p['source'] as string) : undefined;
        recordError(state, p['message'] as string, event.seq, source);
      }
      break;
    }
    case 'v6.stuck.detected': {
      state.stuckDetections += 1;
      state.status = 'stuck';
      break;
    }
    case 'v6.condensed': {
      state.condensations += 1;
      if (typeof p['upToSeq'] === 'number') state.lastCondensedUpToSeq = p['upToSeq'] as number;
      break;
    }
    case 'v6.delegation.finished': {
      state.delegations += 1;
      if (p['status'] === 'error' || p['status'] === 'timeout') {
        recordError(state, `delegate ${String(p['name'] ?? '')} ${String(p['status'])}: ${String(p['error'] ?? '')}`, event.seq, 'delegate');
      }
      break;
    }
    case 'v6.turn.finished': {
      state.status = 'finished';
      break;
    }
    case 'v6.approval.requested': {
      state.status = 'paused';
      break;
    }
    case 'v6.approval.decided': {
      if (p['approved'] === true) state.status = 'running';
      break;
    }
    case 'v6.forked': {
      // Fork không đổi trạng thái nội dung của log cha.
      break;
    }
    default:
      break;
  }
  return state;
}

/** Fold toàn bộ log thành state hiện tại. */
export function foldV6Events(sessionId: string, events: readonly V6Event[]): V6State {
  const state = emptyV6State(sessionId);
  for (const event of [...events].sort((a, b) => a.seq - b.seq)) {
    foldV6Event(state, event);
  }
  return state;
}

/** Kết quả verify hash chain. */
export interface V6ChainVerification {
  ok: boolean;
  /** Số event đã kiểm tra. */
  checked: number;
  /** Seq đầu tiên sai (undefined khi ok). */
  firstBadSeq?: number;
  /** Lý do sai (undefined khi ok). */
  reason?: string;
}

/** Verify seq liên tục (1..N) + hash chain của một log. */
export function verifyV6Chain(events: readonly V6Event[]): V6ChainVerification {
  const sorted = [...events].sort((a, b) => a.seq - b.seq);
  let prevHash = V6_GENESIS_PREV_HASH;
  for (let i = 0; i < sorted.length; i += 1) {
    const event = sorted[i]!;
    if (event.seq !== i + 1) {
      return { ok: false, checked: i, firstBadSeq: event.seq, reason: `seq không liên tục: mong ${i + 1}, gặp ${event.seq}` };
    }
    if (event.prevHash !== prevHash) {
      return { ok: false, checked: i, firstBadSeq: event.seq, reason: 'prevHash không khớp event trước' };
    }
    const recomputed = hashV6Event(event);
    if (recomputed !== event.hash) {
      return { ok: false, checked: i, firstBadSeq: event.seq, reason: 'hash event không khớp nội dung' };
    }
    prevHash = event.hash;
  }
  return { ok: true, checked: sorted.length };
}

/**
 * Log hội thoại append-only của một coding session v6.
 * Giữ toàn bộ event trong bộ nhớ; tools chịu trách nhiệm persist
 * qua `toJsonl`/`fromJsonl`.
 */
export class CodingV6Log {
  readonly sessionId: string;
  private events: V6Event[] = [];
  private lastHash: string = V6_GENESIS_PREV_HASH;

  constructor(sessionId?: string) {
    this.sessionId = sessionId ?? randomUUID();
  }

  /** Số event trong log. */
  get length(): number {
    return this.events.length;
  }

  /** Seq tiếp theo sẽ ghi. */
  get nextSeq(): number {
    return this.events.length + 1;
  }

  /** Append một event (tự gán seq/at/hash). Trả event đã ghi. */
  append(type: V6EventType, payload: Record<string, unknown>, at?: string): V6Event {
    const seq = this.nextSeq;
    const base: Omit<V6Event, 'hash'> = {
      seq,
      sessionId: this.sessionId,
      at: at ?? new Date().toISOString(),
      type,
      payload,
      prevHash: this.lastHash,
    };
    const event: V6Event = { ...base, hash: hashV6Event(base) };
    this.events.push(event);
    this.lastHash = event.hash;
    return event;
  }

  /** Mọi event (bản sao, theo seq tăng dần). */
  all(): V6Event[] {
    return [...this.events];
  }

  /** Event tại seq (undefined khi ngoài khoảng). */
  atSeq(seq: number): V6Event | undefined {
    return this.events.find((e) => e.seq === seq);
  }

  /** State hiện tại (fold toàn bộ log). */
  state(): V6State {
    return foldV6Events(this.sessionId, this.events);
  }

  /**
   * Time-travel: state tại một seq bất kỳ (chỉ fold prefix tới seq
   * đó — lịch sử sau seq đó không bị xoá, chỉ không được tính).
   */
  stateAt(seq: number): V6State {
    const state = emptyV6State(this.sessionId);
    for (const event of this.events) {
      if (event.seq > seq) break;
      foldV6Event(state, event);
    }
    return state;
  }

  /**
   * Replay từ event N: fold lại từ seq N tới cuối, trả state tại
   * cuối + state "trước N" để caller so sánh. Dùng cho debug: chạy
   * lại từ một điểm giữa log để xem state suy ra có khớp không.
   */
  replayFrom(seq: number): { before: V6State; after: V6State; replayed: number } {
    const before = this.stateAt(seq - 1);
    // `after` fold toàn bộ log (prefix + phần replay) để state đầy đủ;
    // `replayed` đếm số event từ seq N trở đi (phần chạy lại).
    const after = this.state();
    const replayed = this.events.filter((e) => e.seq >= seq).length;
    return { before, after, replayed };
  }

  /**
   * Fork tại một seq: log con sao chép prefix tới seq đó (bao gồm
   * seq), rồi ghi `v6.forked` ở log cha và `v6.session.started`
   * (parentSessionId/forkFromSeq) ở log con. Log cha không đổi
   * ngoài event fork ghi chú.
   */
  forkAt(seq: number, childSessionId?: string): CodingV6Log {
    if (seq < 1 || seq > this.events.length) {
      throw new Error(`CodingV6Log.forkAt: seq ${seq} ngoài khoảng 1..${this.events.length}.`);
    }
    const child = new CodingV6Log(childSessionId);
    // Sao chép prefix tới seq (bao gồm seq), re-hash theo sessionId
    // của con (hash gốc tính trên sessionId cha nên không dùng lại
    // được — nội dung event giữ nguyên, chỉ sessionId/hash đổi).
    let prevHash = V6_GENESIS_PREV_HASH;
    for (const event of this.events) {
      if (event.seq > seq) break;
      const copy: Omit<V6Event, 'hash'> = {
        seq: event.seq,
        sessionId: child.sessionId,
        at: event.at,
        type: event.type,
        payload: event.payload,
        prevHash,
      };
      const hashed: V6Event = { ...copy, hash: hashV6Event(copy) };
      child.events.push(hashed);
      prevHash = hashed.hash;
    }
    child.lastHash = prevHash;
    // Ghi chú fork ở cả hai log (event mới, seq tiếp theo mỗi log).
    this.append('v6.forked', { childSessionId: child.sessionId, forkFromSeq: seq });
    child.append('v6.session.started', {
      title: `fork từ ${this.sessionId} @ seq ${seq}`,
      parentSessionId: this.sessionId,
      forkFromSeq: seq,
    });
    return child;
  }

  /** Verify hash chain của log này. */
  verify(): V6ChainVerification {
    return verifyV6Chain(this.events);
  }

  /** Serialize toàn bộ log thành JSONL (một event một dòng). */
  toJsonl(): string {
    return this.events.map((e) => JSON.stringify(e)).join('\n');
  }

  /** Nạp log từ JSONL (verify chain; throw khi sai). */
  static fromJsonl(sessionId: string, jsonl: string): CodingV6Log {
    const log = new CodingV6Log(sessionId);
    const lines = jsonl.split('\n').filter((l) => l.trim() !== '');
    for (const line of lines) {
      const event = JSON.parse(line) as V6Event;
      log.events.push(event);
      log.lastHash = event.hash;
    }
    const verification = log.verify();
    if (!verification.ok) {
      throw new Error(`CodingV6Log.fromJsonl: chain sai tại seq ${verification.firstBadSeq}: ${verification.reason}`);
    }
    return log;
  }

  /** So sánh hai state (dùng cho test replay determinism). */
  static statesEqual(a: V6State, b: V6State): boolean {
    return stableStringify(a) === stableStringify(b);
  }
}

/**
 * Event-sourced conversation log cho coding agent v7 (v1.15, Đội T4).
 *
 * Ý tưởng học từ OpenHands V1 SDK (survey v1.15 §3): Conversation =
 * stream event bất biến, log append-only là single source of truth,
 * replay log là tái tạo toàn bộ hội thoại. Nối event-log của open-bot
 * (v1.01–v1.04) và conversationLog v6 (v1.14), nhưng v7 viết lại từ
 * đầu với 3 điểm khác:
 * - Pause/resume hạng nhất: `pause()` / `resume()` ghi event riêng,
 *   fold ra số lần pause/resume trong state; agent dừng vòng lặp khi
 *   status = paused và tiếp tục đúng chỗ khi resume (không chạy lại
 *   step cũ — xem `agent.ts`).
 * - Fork ghi rõ quan hệ cha/con cả hai phía: log cha ghi `v7.forked`
 *   (forkSessionId, forkSeq), log con ghi `v7.session.started` với
 *   `forkedFrom: { sessionId, seq }` trong state.
 * - Snapshot nạp nhanh: `toSnapshot()` lưu kèm `V7State` đã fold tại
 *   seq cuối; `fromSnapshot()` khôi phục state mà không cần fold lại
 *   toàn bộ log (log vẫn là source of truth — snapshot chỉ là cache,
 *   verify chain trước khi tin).
 *
 * Đảm bảo:
 * - Append-only: không có API sửa/xoá event. Muốn "quay lại" thì fork
 *   (`forkAt`) hoặc xem state tại seq (`stateAt`) — lịch sử cũ còn
 *   nguyên.
 * - Hash chain SHA-256: mỗi event nối `prevHash` của event trước;
 *   `verifyChain` phát hiện log bị sửa.
 * - Replay/time-travel: `replayFrom(seq)` trả các event từ seq N;
 *   `stateAt(seq)` trả state tại bất kỳ điểm nào.
 * - Serialize: `toJsonl` / `fromJsonl` (một event một dòng) để tools
 *   lưu xuống đĩa; `fromJsonl` verify chain khi nạp.
 *
 * Module thuần (không fs): lưu đĩa nằm ở tầng tools.
 */

import { createHash, randomUUID } from 'node:crypto';
import type {
  V7ChangedFile,
  V7Decision,
  V7EncounteredError,
  V7Event,
  V7EventType,
  V7SessionStatus,
  V7State,
} from './types';

/** Hash của event đầu tiên (không có prev). */
export const V7_GENESIS_PREV_HASH = '';

/** Cắt text payload để log không phình (secret đã redact ở tầng gọi). */
export const V7_LOG_TEXT_LIMIT = 4000;

/** Cắt ngắn text cho payload log. */
export function clipV7Text(text: string, limit: number = V7_LOG_TEXT_LIMIT): string {
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
export function hashV7Event(event: Omit<V7Event, 'hash'>): string {
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

/** Kết quả verify hash chain. */
export interface V7ChainVerification {
  ok: boolean;
  /** Số event đã kiểm tra. */
  checked: number;
  /** Seq đầu tiên sai (khi !ok). */
  firstBadSeq?: number;
  /** Lý do sai (khi !ok). */
  reason?: string;
}

/** Verify hash chain + seq liên tục của một mảng event. */
export function verifyV7Chain(events: readonly V7Event[]): V7ChainVerification {
  let prevHash = V7_GENESIS_PREV_HASH;
  for (let i = 0; i < events.length; i++) {
    const event = events[i];
    if (event.seq !== i + 1) {
      return { ok: false, checked: i, firstBadSeq: event.seq, reason: `seq expected ${i + 1}, got ${event.seq}` };
    }
    if (event.prevHash !== prevHash) {
      return { ok: false, checked: i, firstBadSeq: event.seq, reason: 'prevHash mismatch' };
    }
    const { hash, ...rest } = event;
    if (hashV7Event(rest) !== hash) {
      return { ok: false, checked: i, firstBadSeq: event.seq, reason: 'hash mismatch (event tampered)' };
    }
    prevHash = hash;
  }
  return { ok: true, checked: events.length };
}

/** State rỗng cho một session mới. */
export function emptyV7State(sessionId: string): V7State {
  return {
    sessionId,
    lastSeq: 0,
    status: 'running',
    title: '',
    messages: [],
    filesChanged: [],
    decisions: [],
    errors: [],
    skillsActivated: [],
    actionsExecuted: 0,
    failedObservations: 0,
    blockedActions: 0,
    pauses: 0,
    resumes: 0,
    condensations: 0,
    lastCondensedUpToSeq: 0,
  };
}

function recordFileChange(state: V7State, pathValue: unknown, seq: number): void {
  if (typeof pathValue !== 'string' || pathValue.length === 0) return;
  const existing = state.filesChanged.find((f) => f.path === pathValue);
  if (existing) {
    existing.lastSeq = seq;
    existing.changes += 1;
  } else {
    state.filesChanged.push({ path: pathValue, firstSeq: seq, lastSeq: seq, changes: 1 });
  }
}

/**
 * Fold một event vào state (pure — không sửa event, chỉ sửa state đích).
 * Đây là reducer duy nhất: mọi state đều suy ra từ log qua hàm này.
 */
export function foldV7Event(state: V7State, event: V7Event): V7State {
  state.lastSeq = event.seq;
  const p = event.payload;
  switch (event.type) {
    case 'v7.session.started': {
      if (typeof p['title'] === 'string') state.title = p['title'] as string;
      if (p['forkedFrom'] && typeof p['forkedFrom'] === 'object') {
        const ff = p['forkedFrom'] as Record<string, unknown>;
        if (typeof ff['sessionId'] === 'string' && typeof ff['seq'] === 'number') {
          state.forkedFrom = { sessionId: ff['sessionId'] as string, seq: ff['seq'] as number };
        }
      }
      state.status = 'running';
      break;
    }
    case 'v7.session.paused':
      state.status = 'paused';
      state.pauses += 1;
      break;
    case 'v7.session.resumed':
      state.status = 'running';
      state.resumes += 1;
      break;
    case 'v7.session.aborted':
      state.status = 'aborted';
      break;
    case 'v7.user.message':
      if (typeof p['text'] === 'string') {
        state.messages.push({ role: 'user', text: p['text'] as string, seq: event.seq });
      }
      break;
    case 'v7.model.message':
      if (typeof p['text'] === 'string') {
        state.messages.push({ role: 'model', text: p['text'] as string, seq: event.seq });
      }
      break;
    case 'v7.skill.activated': {
      if (typeof p['skill'] === 'string' && !state.skillsActivated.includes(p['skill'] as string)) {
        state.skillsActivated.push(p['skill'] as string);
      }
      break;
    }
    case 'v7.action.parsed': {
      if (p['kind'] === 'think' && typeof p['text'] === 'string') {
        state.decisions.push({ seq: event.seq, text: p['text'] as string });
      }
      break;
    }
    case 'v7.action.blocked':
      state.blockedActions += 1;
      if (typeof p['reason'] === 'string') {
        state.errors.push({ seq: event.seq, text: p['reason'] as string, source: 'security' });
      }
      break;
    case 'v7.action.executed': {
      if (p['kind'] === 'edit') recordFileChange(state, p['path'], event.seq);
      if (p['kind'] === 'bash' || p['kind'] === 'python' || p['kind'] === 'edit' || p['kind'] === 'read') {
        state.actionsExecuted += 1;
      }
      break;
    }
    case 'v7.observation': {
      if (p['ok'] === false) {
        state.failedObservations += 1;
        const text = typeof p['stderr'] === 'string' && p['stderr']
          ? (p['stderr'] as string)
          : typeof p['stdout'] === 'string'
            ? (p['stdout'] as string)
            : 'action failed';
        state.errors.push({ seq: event.seq, text, source: typeof p['kind'] === 'string' ? (p['kind'] as string) : undefined });
      }
      break;
    }
    case 'v7.file.changed':
      recordFileChange(state, p['path'], event.seq);
      break;
    case 'v7.error':
      if (typeof p['message'] === 'string') {
        state.errors.push({ seq: event.seq, text: p['message'] as string, source: typeof p['source'] === 'string' ? (p['source'] as string) : undefined });
      }
      break;
    case 'v7.condensed':
      state.condensations += 1;
      if (typeof p['upToSeq'] === 'number') state.lastCondensedUpToSeq = p['upToSeq'] as number;
      break;
    case 'v7.turn.finished':
      state.status = 'finished';
      if (p['summary'] && typeof p['summary'] === 'string') {
        state.decisions.push({ seq: event.seq, text: p['summary'] as string });
      }
      break;
    case 'v7.forked':
    case 'v7.security.verdict':
    case 'v7.eval.finished':
      // Không đổi state suy ra (chỉ ghi dấu audit).
      break;
  }
  return state;
}

/** Fold nhiều event theo thứ tự vào state. */
export function foldV7Events(events: readonly V7Event[], initial?: V7State): V7State {
  const sessionId = initial?.sessionId ?? events[0]?.sessionId ?? 'unknown';
  const state = initial ?? emptyV7State(sessionId);
  for (const event of events) foldV7Event(state, event);
  return state;
}

/** Snapshot: log + state đã fold (cache nạp nhanh, log vẫn là truth). */
export interface V7Snapshot {
  version: 1;
  sessionId: string;
  /** Seq cuối của snapshot (= lastSeq của state). */
  lastSeq: number;
  events: V7Event[];
  state: V7State;
}

/**
 * Log hội thoại v7: append-only, hash chain, replay/fork/pause/resume,
 * serialize JSONL + snapshot.
 */
export class CodingV7Log {
  readonly sessionId: string;
  private events: V7Event[] = [];
  private cachedState: V7State | null = null;

  constructor(sessionId?: string) {
    this.sessionId = sessionId ?? `v7-${randomUUID()}`;
    this.cachedState = emptyV7State(this.sessionId);
  }

  /** Số event trong log. */
  get length(): number {
    return this.events.length;
  }

  /** Append một event (trả event đã ghi, có seq + hash). */
  append(type: V7EventType, payload: Record<string, unknown>, at?: string): V7Event {
    const prev = this.events[this.events.length - 1];
    const base: Omit<V7Event, 'hash'> = {
      seq: this.events.length + 1,
      sessionId: this.sessionId,
      at: at ?? new Date().toISOString(),
      type,
      payload: clipPayload(payload),
      prevHash: prev ? prev.hash : V7_GENESIS_PREV_HASH,
    };
    const event: V7Event = { ...base, hash: hashV7Event(base) };
    this.events.push(event);
    if (this.cachedState) foldV7Event(this.cachedState, event);
    return event;
  }

  /** Tất cả event (bản sao nông — caller không sửa được log gốc). */
  all(): V7Event[] {
    return [...this.events];
  }

  /** Event tại seq (1-based), undefined khi ngoài khoảng. */
  atSeq(seq: number): V7Event | undefined {
    return this.events[seq - 1];
  }

  /** State hiện tại (fold từ log; cache tăng dần theo append). */
  state(): V7State {
    if (!this.cachedState) this.cachedState = foldV7Events(this.events, emptyV7State(this.sessionId));
    return structuredCloneState(this.cachedState);
  }

  /** State tại seq N (fold prefix tới N, không sửa log). */
  stateAt(seq: number): V7State {
    const clamped = Math.max(0, Math.min(seq, this.events.length));
    return foldV7Events(this.events.slice(0, clamped), emptyV7State(this.sessionId));
  }

  /** Các event từ seq N trở đi (replay/time-travel). */
  replayFrom(seq: number): V7Event[] {
    const start = Math.max(1, seq);
    return this.events.filter((e) => e.seq >= start);
  }

  /** Verify hash chain của log. */
  verify(): V7ChainVerification {
    return verifyV7Chain(this.events);
  }

  /** Pause session (ghi event, agent dừng vòng lặp). */
  pause(reason?: string): V7Event {
    return this.append('v7.session.paused', reason ? { reason } : {});
  }

  /** Resume session đã pause (ghi event, agent tiếp tục đúng chỗ). */
  resume(reason?: string): V7Event {
    return this.append('v7.session.resumed', reason ? { reason } : {});
  }

  /**
   * Fork tại seq N: log con sao chép prefix tới N + ghi
   * `v7.session.started` với forkedFrom; log cha ghi `v7.forked`.
   * Lịch sử cha không đổi ngoài một event fork.
   */
  forkAt(seq: number, childSessionId?: string): CodingV7Log {
    const clamped = Math.max(0, Math.min(seq, this.events.length));
    const child = new CodingV7Log(childSessionId);
    const prefix = this.events.slice(0, clamped);
    for (const event of prefix) {
      // Sao chép event y nguyên (giữ seq/hash) — child tiếp nối chain.
      child.events.push({ ...event, sessionId: child.sessionId, payload: { ...event.payload } });
    }
    // Hash chain của child phải tính lại theo sessionId mới: rebuild.
    child.events = rebuildChain(child.sessionId, child.events);
    child.cachedState = foldV7Events(child.events, emptyV7State(child.sessionId));
    child.append('v7.session.started', {
      title: child.state().title,
      forkedFrom: { sessionId: this.sessionId, seq: clamped },
    });
    this.append('v7.forked', { forkSessionId: child.sessionId, forkSeq: clamped });
    return child;
  }

  /** Serialize thành JSONL (một event một dòng). */
  toJsonl(): string {
    return this.events.map((e) => JSON.stringify(e)).join('\n') + (this.events.length ? '\n' : '');
  }

  /** Nạp log từ JSONL (verify chain, throw khi chain sai). */
  static fromJsonl(jsonl: string, sessionId?: string): CodingV7Log {
    const lines = jsonl.split('\n').filter((l) => l.trim().length > 0);
    const events: V7Event[] = lines.map((line) => JSON.parse(line) as V7Event);
    const check = verifyV7Chain(events);
    if (!check.ok) {
      throw new Error(`V7 log chain invalid at seq ${check.firstBadSeq}: ${check.reason}`);
    }
    const log = new CodingV7Log(sessionId ?? events[0]?.sessionId);
    log.events = events;
    log.cachedState = foldV7Events(events, emptyV7State(log.sessionId));
    return log;
  }

  /** Snapshot kèm state đã fold (nạp nhanh). */
  toSnapshot(): V7Snapshot {
    const state = this.state();
    return { version: 1, sessionId: this.sessionId, lastSeq: state.lastSeq, events: this.all(), state };
  }

  /** Nạp từ snapshot (verify chain trước khi tin state cache). */
  static fromSnapshot(snapshot: V7Snapshot): CodingV7Log {
    if (snapshot.version !== 1) throw new Error(`Unsupported V7 snapshot version: ${snapshot.version}`);
    const check = verifyV7Chain(snapshot.events);
    if (!check.ok) {
      throw new Error(`V7 snapshot chain invalid at seq ${check.firstBadSeq}: ${check.reason}`);
    }
    if (snapshot.state.lastSeq !== snapshot.events.length) {
      throw new Error(`V7 snapshot state lastSeq ${snapshot.state.lastSeq} != events ${snapshot.events.length}`);
    }
    const log = new CodingV7Log(snapshot.sessionId);
    log.events = snapshot.events.map((e) => ({ ...e, payload: { ...e.payload } }));
    log.cachedState = structuredCloneState(snapshot.state);
    return log;
  }
}

function clipPayload(payload: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    out[key] = typeof value === 'string' ? clipV7Text(value) : value;
  }
  return out;
}

/** Tính lại hash chain cho một prefix đã đổi sessionId (dùng khi fork). */
function rebuildChain(sessionId: string, events: V7Event[]): V7Event[] {
  let prevHash = V7_GENESIS_PREV_HASH;
  return events.map((event, i) => {
    const base: Omit<V7Event, 'hash'> = {
      seq: i + 1,
      sessionId,
      at: event.at,
      type: event.type,
      payload: event.payload,
      prevHash,
    };
    const hash = hashV7Event(base);
    prevHash = hash;
    return { ...base, hash };
  });
}

function structuredCloneState(state: V7State): V7State {
  return JSON.parse(JSON.stringify(state)) as V7State;
}

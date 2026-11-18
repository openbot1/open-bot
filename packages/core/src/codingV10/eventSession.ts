/**
 * Coding agent v10 — event-sourced session (OpenHands-style).
 *
 * Một phiên coding là một event log append-only: mọi Action của agent
 * (plan/edit/codeact-run/verify/commit) và mọi Observation của môi
 * trường (kết quả edit, stdout/stderr, exit code) đều là event bất
 * biến, nối nhau bằng hash chain SHA-256. Trạng thái phiên được suy
 * ra hoàn toàn bằng fold — cùng log → cùng trạng thái.
 *
 * Khác run log ở `event-log/` (log theo run của AgentRunner): v10
 * log theo PHIÊN CODING, gắn working dir + file đã đổi, và có API
 * riêng cho coding: snapshot + replay toàn bộ phiên, fork tại bất kỳ
 * event nào (sao chép prefix log sang phiên mới), pause/resume có
 * persist xuống đĩa (resume đúng chỗ, không chạy lại bước đã xong).
 *
 * Bố cục đĩa (trong `sessionsDir`, vd `<userData>/coding-v10/`):
 * - `<sessionId>.jsonl`: 1 dòng = 1 event JSON (append-only, fsync
 *   mỗi lần append như RunLogStore).
 * - `<sessionId>.snapshot.json`: snapshot mới nhất (ghi đè khi chụp).
 * - Không bao giờ sửa dòng log cũ: fork tạo file log mới, pause/
 *   resume chỉ append event + cập nhật snapshot.
 */

import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { CodingV10Error } from './types';
import type {
  V10ChainVerification,
  V10ForkResult,
  V10NewSessionEvent,
  V10SessionEvent,
  V10SessionSnapshot,
  V10SessionState,
} from './types';

/** Hash của event đầu tiên (prevHash rỗng). */
export const V10_GENESIS_PREV_HASH = '';
/** Số ký tự payload tối đa giữ trong một event (cắt ngắn, chống phình log). */
export const V10_EVENT_MAX_PAYLOAD_CHARS = 8000;
/** Số ký tự tối đa của một chuỗi trong payload trước khi cắt. */
export const V10_EVENT_MAX_STRING_CHARS = 2000;

/** Tên file log an toàn cho một sessionId (tránh path traversal). */
export function v10SafeSessionFileName(sessionId: string): string {
  const safe = sessionId.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 128) || 'session';
  return `${safe}.jsonl`;
}

/** Cắt ngắn đệ quy mọi chuỗi trong payload về giới hạn. */
export function v10TruncatePayloadValue(value: unknown, maxChars = V10_EVENT_MAX_STRING_CHARS): unknown {
  if (typeof value === 'string') {
    return value.length > maxChars ? `${value.slice(0, maxChars)}... [truncated ${value.length - maxChars} chars]` : value;
  }
  if (Array.isArray(value)) return value.map((v) => v10TruncatePayloadValue(v, maxChars));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = v10TruncatePayloadValue(v, maxChars);
    }
    return out;
  }
  return value;
}

/** JSON ổn định (key sắp xếp) để hash — cùng event → cùng hash. */
export function v10StableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((v) => v10StableStringify(v)).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${v10StableStringify(obj[k])}`).join(',')}}`;
}

/** Hash của một event (trừ field `hash` của chính nó). */
export function v10HashEvent(event: Omit<V10SessionEvent, 'hash'>): string {
  const input = v10StableStringify({
    seq: event.seq,
    sessionId: event.sessionId,
    at: event.at,
    kind: event.kind,
    type: event.type,
    payload: event.payload,
    prevHash: event.prevHash,
  });
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/** Digest của trạng thái đã fold (để snapshot/replay đối chiếu). */
export function v10DigestState(state: V10SessionState): string {
  return createHash('sha256').update(v10StableStringify(state), 'utf8').digest('hex');
}

/** Fold một dãy event (theo seq tăng dần) thành trạng thái phiên. */
export function v10FoldEvents(
  sessionId: string,
  workingDir: string,
  title: string,
  events: readonly V10SessionEvent[],
): V10SessionState {
  const state: V10SessionState = {
    sessionId,
    title,
    workingDir,
    status: 'running',
    eventCount: 0,
    lastSeq: 0,
    actionCount: 0,
    observationCount: 0,
    filesChanged: [],
    commits: [],
    codeActRuns: 0,
    codeActPassed: 0,
    verifyRounds: 0,
    verifyPassed: 0,
    startedAt: '',
    pauseCount: 0,
    resumeCount: 0,
  };
  const files = new Set<string>();
  const commits = new Set<string>();
  for (const event of events) {
    state.eventCount += 1;
    state.lastSeq = Math.max(state.lastSeq, event.seq);
    const p = event.payload as Record<string, unknown>;
    if (event.kind === 'action') state.actionCount += 1;
    if (event.kind === 'observation') state.observationCount += 1;
    switch (event.type) {
      case 'session.started': {
        if (typeof p['title'] === 'string' && p['title']) state.title = p['title'] as string;
        if (typeof p['workingDir'] === 'string' && p['workingDir']) state.workingDir = p['workingDir'] as string;
        if (typeof p['parentSessionId'] === 'string') state.parentSessionId = p['parentSessionId'] as string;
        if (typeof p['forkFromSeq'] === 'number') state.forkFromSeq = p['forkFromSeq'] as number;
        state.startedAt = event.at;
        break;
      }
      case 'session.forked': {
        if (typeof p['parentSessionId'] === 'string') state.parentSessionId = p['parentSessionId'] as string;
        if (typeof p['forkFromSeq'] === 'number') state.forkFromSeq = p['forkFromSeq'] as number;
        break;
      }
      case 'edit-result': {
        if (typeof p['path'] === 'string' && p['path']) files.add(p['path'] as string);
        break;
      }
      case 'commit-result': {
        if (typeof p['shortSha'] === 'string' && p['shortSha']) commits.add(p['shortSha'] as string);
        if (Array.isArray(p['files'])) {
          for (const f of p['files'] as unknown[]) if (typeof f === 'string') files.add(f);
        }
        break;
      }
      case 'codeact-result': {
        state.codeActRuns += 1;
        if (p['status'] === 'ok') state.codeActPassed += 1;
        break;
      }
      case 'verify-result': {
        if (typeof p['roundsUsed'] === 'number') state.verifyRounds += p['roundsUsed'] as number;
        if (p['passed'] === true) state.verifyPassed += 1;
        break;
      }
      case 'error': {
        if (typeof p['message'] === 'string') state.lastError = p['message'] as string;
        break;
      }
      default:
        break;
    }
    if (event.kind === 'pause') {
      state.status = 'paused';
      state.pauseCount += 1;
    } else if (event.kind === 'resume') {
      state.status = 'running';
      state.resumeCount += 1;
    } else if (event.kind === 'complete') {
      state.status = 'completed';
      state.endedAt = event.at;
    } else if (event.kind === 'error') {
      state.status = 'failed';
      state.endedAt = event.at;
    } else if (event.kind === 'fork') {
      state.status = 'forked';
      state.endedAt = event.at;
    }
  }
  state.filesChanged = [...files].sort();
  state.commits = [...commits].sort();
  return state;
}

/** Verify hash chain của một dãy event (theo seq tăng dần). */
export function v10VerifyChain(events: readonly V10SessionEvent[]): V10ChainVerification {
  let prevHash = V10_GENESIS_PREV_HASH;
  for (let i = 0; i < events.length; i += 1) {
    const event = events[i] as V10SessionEvent;
    if (event.seq !== i + 1) {
      return { ok: false, checked: i, firstBrokenSeq: event.seq, reason: `seq không liên tục: mong ${i + 1}, gặp ${event.seq}` };
    }
    if (event.prevHash !== prevHash) {
      return { ok: false, checked: i, firstBrokenSeq: event.seq, reason: `prevHash sai tại seq ${event.seq}` };
    }
    const recomputed = v10HashEvent(event);
    if (recomputed !== event.hash) {
      return { ok: false, checked: i, firstBrokenSeq: event.seq, reason: `hash sai tại seq ${event.seq}` };
    }
    prevHash = event.hash;
  }
  return { ok: true, checked: events.length, firstBrokenSeq: -1 };
}

export interface CodingV10SessionOptions {
  /** Id phiên (mặc định sinh từ timestamp + random). */
  sessionId?: string;
  /** Thư mục chứa log + snapshot của phiên. Bắt buộc. */
  sessionsDir: string;
  /** Working dir của phiên (repo làm việc). */
  workingDir: string;
  /** Tiêu đề ngắn của phiên. */
  title?: string;
  /** Ghi đè `at` khi append — chủ yếu cho test determinism. */
  now?: () => string;
}

/**
 * Phiên coding event-sourced: sở hữu một file log JSONL append-only
 * + snapshot. Mọi thay đổi trạng thái đều đi qua `append` (ghi event
 * mới, không sửa event cũ). Pause/resume/fork đều là event.
 */
export class CodingV10Session {
  readonly sessionId: string;
  readonly sessionsDir: string;
  readonly workingDir: string;
  readonly title: string;
  private readonly now: () => string;
  private eventsCache: V10SessionEvent[] | null = null;

  constructor(options: CodingV10SessionOptions) {
    this.sessionId =
      options.sessionId ?? `v10-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    this.sessionsDir = path.resolve(options.sessionsDir);
    this.workingDir = path.resolve(options.workingDir);
    this.title = options.title ?? 'coding session';
    this.now = options.now ?? (() => new Date().toISOString());
    fs.mkdirSync(this.sessionsDir, { recursive: true });
  }

  /** Đường dẫn file log của phiên này. */
  logPath(): string {
    return path.join(this.sessionsDir, v10SafeSessionFileName(this.sessionId));
  }

  /** Đường dẫn file snapshot của phiên này. */
  snapshotPath(): string {
    return path.join(this.sessionsDir, `${v10SafeSessionFileName(this.sessionId).replace(/\.jsonl$/, '')}.snapshot.json`);
  }

  /** Đọc toàn bộ event của phiên (bỏ qua dòng JSON hỏng, báo số dòng hỏng). */
  readEvents(): { events: V10SessionEvent[]; corruptLines: number } {
    if (this.eventsCache) return { events: [...this.eventsCache], corruptLines: 0 };
    const file = this.logPath();
    let raw = '';
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch {
      return { events: [], corruptLines: 0 };
    }
    const events: V10SessionEvent[] = [];
    let corruptLines = 0;
    for (const line of raw.split('\n')) {
      if (line.trim() === '') continue;
      try {
        const parsed = JSON.parse(line) as V10SessionEvent;
        if (typeof parsed.seq !== 'number' || typeof parsed.hash !== 'string' || typeof parsed.type !== 'string') {
          corruptLines += 1;
          continue;
        }
        events.push(parsed);
      } catch {
        corruptLines += 1;
      }
    }
    events.sort((a, b) => a.seq - b.seq);
    this.eventsCache = events;
    return { events: [...events], corruptLines };
  }

  /** Append một event mới (điền seq/prevHash/hash, fsync). */
  append(input: V10NewSessionEvent): V10SessionEvent {
    const { events } = this.readEvents();
    const last = events[events.length - 1];
    const seq = (last?.seq ?? 0) + 1;
    const prevHash = last?.hash ?? V10_GENESIS_PREV_HASH;
    const truncated = v10TruncatePayloadValue(input.payload) as Record<string, unknown>;
    const payloadJson = JSON.stringify(truncated);
    const payload: Record<string, unknown> =
      payloadJson.length > V10_EVENT_MAX_PAYLOAD_CHARS
        ? { truncated: true, preview: payloadJson.slice(0, V10_EVENT_MAX_PAYLOAD_CHARS) }
        : truncated;
    const base: Omit<V10SessionEvent, 'hash'> = {
      seq,
      sessionId: this.sessionId,
      at: this.now(),
      kind: input.kind,
      type: input.type,
      payload,
      prevHash,
    };
    const event: V10SessionEvent = { ...base, hash: v10HashEvent(base) };
    fs.appendFileSync(this.logPath(), `${JSON.stringify(event)}\n`, 'utf8');
    const fd = fs.openSync(this.logPath(), 'r');
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    this.eventsCache = [...events, event];
    return event;
  }

  /** Ghi action của agent (vd `edit`, `codeact-run`). */
  recordAction(type: string, payload: Record<string, unknown>): V10SessionEvent {
    return this.append({ kind: 'action', type, payload });
  }

  /** Ghi observation của môi trường (vd `edit-result`, `codeact-result`). */
  recordObservation(type: string, payload: Record<string, unknown>): V10SessionEvent {
    return this.append({ kind: 'observation', type, payload });
  }

  /** Khởi tạo phiên: ghi event `session.started` (chỉ gọi một lần). */
  start(extra: Record<string, unknown> = {}): V10SessionEvent {
    const { events } = this.readEvents();
    if (events.length > 0) {
      throw new CodingV10Error('session-completed', `Session ${this.sessionId} đã có event — không start lại.`);
    }
    return this.append({
      kind: 'action',
      type: 'session.started',
      payload: { title: this.title, workingDir: this.workingDir, ...extra },
    });
  }

  /** Trạng thái hiện tại (fold từ log). */
  state(): V10SessionState {
    const { events } = this.readEvents();
    return v10FoldEvents(this.sessionId, this.workingDir, this.title, events);
  }

  /** true = phiên đang paused (không nhận action mới cho tới resume). */
  isPaused(): boolean {
    return this.state().status === 'paused';
  }

  /** Pause phiên: append event pause + snapshot (persist). */
  pause(reason = ''): V10SessionEvent {
    const st = this.state();
    if (st.status === 'paused') {
      throw new CodingV10Error('session-paused', `Session ${this.sessionId} đã paused.`);
    }
    if (st.status === 'completed' || st.status === 'failed') {
      throw new CodingV10Error('session-completed', `Session ${this.sessionId} đã kết thúc (${st.status}) — không pause được.`);
    }
    const event = this.append({ kind: 'pause', type: 'session.paused', payload: { reason } });
    this.snapshot();
    return event;
  }

  /** Resume phiên đã pause: append event resume + snapshot. */
  resume(reason = ''): V10SessionEvent {
    const st = this.state();
    if (st.status !== 'paused') {
      throw new CodingV10Error('session-paused', `Session ${this.sessionId} không ở trạng thái paused (đang ${st.status}) — không resume được.`);
    }
    const event = this.append({ kind: 'resume', type: 'session.resumed', payload: { reason } });
    this.snapshot();
    return event;
  }

  /** Hoàn thành phiên (ghi event complete + snapshot). */
  complete(summary = ''): V10SessionEvent {
    const event = this.append({ kind: 'complete', type: 'session.completed', payload: { summary } });
    this.snapshot();
    return event;
  }

  /** Ghi lỗi kết thúc phiên (ghi event error + snapshot). */
  fail(message: string): V10SessionEvent {
    const event = this.append({ kind: 'error', type: 'error', payload: { message } });
    this.snapshot();
    return event;
  }

  /** Chụp snapshot: fold tới seq hiện tại + digest, ghi file snapshot. */
  snapshot(): V10SessionSnapshot {
    const { events } = this.readEvents();
    const state = v10FoldEvents(this.sessionId, this.workingDir, this.title, events);
    const snap: V10SessionSnapshot = {
      version: 1,
      sessionId: this.sessionId,
      atSeq: state.lastSeq,
      at: this.now(),
      state,
      stateDigest: v10DigestState(state),
    };
    fs.writeFileSync(this.snapshotPath(), `${JSON.stringify(snap, null, 2)}\n`, 'utf8');
    return snap;
  }

  /** Đọc snapshot đã lưu (null khi chưa có). */
  readSnapshot(): V10SessionSnapshot | null {
    try {
      const data = JSON.parse(fs.readFileSync(this.snapshotPath(), 'utf8')) as V10SessionSnapshot;
      if (data.version !== 1 || data.sessionId !== this.sessionId) return null;
      return data;
    } catch {
      return null;
    }
  }

  /**
   * Replay toàn bộ phiên từ event log: fold lại từ đầu + verify hash
   * chain + đối chiếu digest với snapshot (nếu có). Trả về trạng thái
   * đã replay; throw khi chuỗi hash đứt.
   */
  replay(): { state: V10SessionState; verification: V10ChainVerification; snapshotMatches: boolean | null } {
    const { events, corruptLines } = this.readEvents();
    const verification = v10VerifyChain(events);
    if (!verification.ok) {
      throw new CodingV10Error(
        'event-chain-broken',
        `Hash chain đứt tại seq ${verification.firstBrokenSeq}: ${verification.reason ?? ''} (dòng hỏng: ${corruptLines}).`,
      );
    }
    const state = v10FoldEvents(this.sessionId, this.workingDir, this.title, events);
    const snap = this.readSnapshot();
    const snapshotMatches =
      snap === null ? null : snap.atSeq === state.lastSeq && snap.stateDigest === v10DigestState(state);
    return { state, verification, snapshotMatches };
  }

  /**
   * Fork phiên tại một event: tạo phiên mới, sao chép mọi event tới
   * `atSeq` (bao gồm seq đó) sang log mới (giữ nguyên seq/hash để
   * replay của phiên mới vẫn verify được prefix), rồi ghi event
   * `session.forked` vào phiên mới. Phiên gốc không đổi.
   */
  fork(atSeq: number, newSessionId?: string): V10ForkResult {
    const { events } = this.readEvents();
    if (!Number.isInteger(atSeq) || atSeq < 1 || atSeq > events.length) {
      throw new CodingV10Error(
        'fork-seq-invalid',
        `fork seq ${atSeq} không hợp lệ (phiên có ${events.length} event, seq 1..${events.length}).`,
      );
    }
    const child = new CodingV10Session({
      sessionId: newSessionId,
      sessionsDir: this.sessionsDir,
      workingDir: this.workingDir,
      title: `${this.title} (fork @${atSeq})`,
      now: this.now,
    });
    const prefix = events.filter((e) => e.seq <= atSeq);
    // Tính lại hash chain cho phiên con: hash input của v10 có chứa
    // sessionId nên đổi sessionId mà giữ hash cũ sẽ đứt chuỗi — tính
    // lại prevHash/hash tuần tự cho prefix đã sao chép.
    let prevHash = V10_GENESIS_PREV_HASH;
    const childEvents: V10SessionEvent[] = prefix.map((e) => {
      const base: Omit<V10SessionEvent, 'hash'> = { ...e, sessionId: child.sessionId, prevHash };
      const hash = v10HashEvent(base);
      prevHash = hash;
      return { ...base, hash };
    });
    const lines = childEvents.map((e) => JSON.stringify(e));
    fs.writeFileSync(child.logPath(), lines.length > 0 ? `${lines.join('\n')}\n` : '', 'utf8');
    child.eventsCache = [...childEvents];
    child.append({
      kind: 'fork',
      type: 'session.forked',
      payload: { parentSessionId: this.sessionId, forkFromSeq: atSeq, copiedEvents: prefix.length },
    });
    // Ghi event fork vào phiên gốc (đánh dấu đã fork, không đổi trạng thái chạy).
    this.append({
      kind: 'action',
      type: 'session.fork-created',
      payload: { childSessionId: child.sessionId, forkFromSeq: atSeq },
    });
    return { sessionId: child.sessionId, fromSeq: atSeq, copiedEvents: prefix.length };
  }

  /** Liệt kê mọi sessionId có log trong sessionsDir. */
  static listSessions(sessionsDir: string): string[] {
    let names: string[] = [];
    try {
      names = fs.readdirSync(sessionsDir);
    } catch {
      return [];
    }
    return names
      .filter((n) => n.endsWith('.jsonl'))
      .map((n) => n.replace(/\.jsonl$/, ''))
      .sort();
  }

  /** Mở một phiên đã có trên đĩa (không start lại). */
  static open(
    sessionsDir: string,
    sessionId: string,
    workingDir: string,
    options: { now?: () => string } = {},
  ): CodingV10Session {
    const session = new CodingV10Session({ sessionId, sessionsDir, workingDir, now: options.now });
    const { events } = session.readEvents();
    if (events.length === 0) {
      throw new CodingV10Error('session-not-found', `Không tìm thấy session ${sessionId} trong ${sessionsDir}.`);
    }
    return session;
  }
}

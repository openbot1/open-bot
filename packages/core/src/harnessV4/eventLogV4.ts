/**
 * EventLog v4 — session log append-only bất biến, persist JSONL (v1.08, Đội T3).
 *
 * Khác với RunLogStore v1.01 (log theo run, payload sanitize cắt ngắn):
 * EventLog v4 ghi theo *phiên* (session) làm việc của một bot, giữ
 * nguyên nội dung cần cho time-travel (transcript đầy đủ tới giới hạn
 * của log, codeact output preview 500 ký tự), và có API fork/resume
 * tường minh để "chạy lại từ bước N" — tạo session mới sao chép prefix
 * tới seq N, session gốc không bao giờ bị đổi.
 *
 * Bố cục đĩa (trong `logDir`, mặc định `<userDataDir>/harness-v4-logs/`):
 * - Một file cho một session: `<sessionId-an-toàn>.jsonl` (1 dòng = 1 event JSON).
 * - Không xoay file (session v4 ngắn hơn run log; file > maxFileBytes
 *   thì append ném lỗi rõ ràng thay vì âm thầm xoay — caller tự tạo
 *   session mới hoặc checkpoint).
 *
 * Tính chất:
 * - Append-only: chỉ `append` thêm dòng mới ở cuối, không bao giờ sửa
 *   dòng cũ. Mỗi lần append ghi xong đều `fsync` để event không mất
 *   khi process chết.
 * - Hash chain SHA-256 riêng (không dùng chung canonical của run log
 *   để hai hệ log độc lập): `hash = sha256(stableStringify({seq,
 *   sessionId, at, type, payload, prevHash}))`. `verify` tính lại
 *   toàn bộ chuỗi; `append` từ chối khi file trên đĩa đã hỏng
 *   (không nối tiếp chuỗi đã đứt).
 * - Đọc: `readSession` bỏ qua dòng JSON hỏng và báo qua `corruptLines`;
 *   `verify` báo seq đầu tiên đứt chuỗi. Một file hỏng không làm hỏng
 *   cả store.
 * - Time-travel: `stateAt(sessionId, atSeq)` fold prefix 1..atSeq;
 *   `resumeFrom(sessionId, atSeq)` fork prefix sang session mới
 *   (event `h4.session.started` của con ghi rõ `parentSessionId` +
 *   `forkFromSeq`).
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import type {
  AnyHarnessV4Event,
  H4SessionEndedPayload,
  H4SessionStartedPayload,
  HarnessV4Event,
  HarnessV4EventKind,
  HarnessV4SessionMeta,
  HarnessV4SessionState,
  HarnessV4StateDiff,
  HarnessV4TimeTravelResult,
  HarnessV4Verification,
  NewHarnessV4Event,
} from './types';

/** Hash genesis: prevHash của event đầu tiên trong session. */
export const HARNESS_V4_GENESIS_PREV_HASH = '';

/** Số ký tự tối đa của một payload text dài trong log (transcript/output preview). */
export const HARNESS_V4_MAX_PAYLOAD_CHARS = 10_000;

/** Số ký tự tối đa của output preview trong event codeact. */
export const HARNESS_V4_CODEACT_PREVIEW_CHARS = 500;

/** Dung lượng tối đa một file session (mặc định 16 MiB). */
export const HARNESS_V4_DEFAULT_MAX_FILE_BYTES = 16 * 1024 * 1024;

/** Chuẩn hoá object để hash ổn định: key sắp xếp, không phụ thuộc thứ tự chèn. */
export function harnessV4StableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((v) => harnessV4StableStringify(v)).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${harnessV4StableStringify(obj[k])}`).join(',')}}`;
}

/** SHA-256 hex của một chuỗi UTF-8. */
export function harnessV4Sha256Hex(text: string): string {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Nội dung dùng để tính hash của một event (không gồm trường `hash`). */
export function harnessV4EventHashInput(event: Omit<HarnessV4Event, 'hash'>): string {
  return harnessV4StableStringify({
    seq: event.seq,
    sessionId: event.sessionId,
    at: event.at,
    type: event.type,
    payload: event.payload,
    prevHash: event.prevHash,
  });
}

/** Tính hash cho một event chưa có hash. */
export function harnessV4HashEvent(event: Omit<HarnessV4Event, 'hash'>): string {
  return harnessV4Sha256Hex(harnessV4EventHashInput(event));
}

/** Kiểm tra hash của một event đã có sẵn. */
export function harnessV4VerifyEventHash(event: HarnessV4Event): boolean {
  return harnessV4HashEvent(event) === event.hash;
}

/** Tên file an toàn cho một sessionId (tránh path traversal). */
export function safeHarnessV4SessionFileName(sessionId: string): string {
  const safe = sessionId.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 128) || 'session';
  return `${safe}.jsonl`;
}

/** Cắt chuỗi dài về giới hạn (giữ đầu + marker). */
export function harnessV4TruncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}…[cắt ${text.length - maxChars} ký tự]`;
}

function isHarnessV4EventObject(value: unknown): value is AnyHarnessV4Event {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v['seq'] === 'number' &&
    typeof v['sessionId'] === 'string' &&
    typeof v['at'] === 'string' &&
    typeof v['type'] === 'string' &&
    typeof v['payload'] === 'object' &&
    v['payload'] !== null &&
    typeof v['prevHash'] === 'string' &&
    typeof v['hash'] === 'string'
  );
}

/** Digest SHA-256 của một trạng thái session đã fold (để replay so sánh). */
export function harnessV4DigestState(state: Omit<HarnessV4SessionState, 'digest'>): string {
  return harnessV4Sha256Hex(
    harnessV4StableStringify({
      sessionId: state.sessionId,
      botId: state.botId,
      status: state.status,
      transcript: state.transcript,
      toolCalls: state.toolCalls,
      codeActRuns: state.codeActRuns,
      errors: state.errors,
      steps: state.steps,
      tokensUsed: state.tokensUsed,
    }),
  );
}

/**
 * Fold một dãy event thành trạng thái session (hàm thuần — cùng log
 * cho cùng trạng thái, là nền của replay + time-travel).
 */
export function foldHarnessV4Events(
  sessionId: string,
  events: AnyHarnessV4Event[],
): HarnessV4SessionState {
  const sorted = [...events].sort((a, b) => a.seq - b.seq);
  const state: HarnessV4SessionState = {
    sessionId,
    botId: '',
    status: 'running',
    transcript: [],
    toolCalls: [],
    codeActRuns: [],
    errors: [],
    checkpoints: [],
    steps: 0,
    tokensUsed: 0,
    startedAt: '',
    digest: '',
  };
  const toolByCall = new Map<string, (typeof state.toolCalls)[number]>();
  for (const event of sorted) {
    const p = event.payload as unknown as Record<string, unknown>;
    switch (event.type) {
      case 'h4.session.started': {
        const sp = p as unknown as H4SessionStartedPayload;
        state.botId = sp.botId;
        if (typeof sp.title === 'string') state.title = sp.title;
        state.startedAt = event.at;
        break;
      }
      case 'h4.user.message': {
        const step = typeof p['step'] === 'number' ? p['step'] : 0;
        state.transcript.push({ kind: 'user', step, text: String(p['text'] ?? '') });
        state.steps = Math.max(state.steps, step + 1);
        break;
      }
      case 'h4.model.reply': {
        const step = typeof p['step'] === 'number' ? p['step'] : 0;
        state.transcript.push({ kind: 'model', step, text: String(p['text'] ?? '') });
        state.steps = Math.max(state.steps, step + 1);
        if (typeof p['inputTokens'] === 'number') state.tokensUsed += p['inputTokens'];
        if (typeof p['outputTokens'] === 'number') state.tokensUsed += p['outputTokens'];
        break;
      }
      case 'h4.tool.call': {
        const callId = String(p['callId'] ?? '');
        const step = typeof p['step'] === 'number' ? p['step'] : 0;
        const rec = { callId, tool: String(p['tool'] ?? ''), step };
        state.toolCalls.push(rec);
        toolByCall.set(callId, rec);
        state.transcript.push({ kind: 'tool_call', step, callId, tool: rec.tool });
        break;
      }
      case 'h4.tool.result': {
        const callId = String(p['callId'] ?? '');
        const step = typeof p['step'] === 'number' ? p['step'] : 0;
        const rec = toolByCall.get(callId);
        const status = p['status'];
        if (rec !== undefined) {
          if (status === 'ok' || status === 'error' || status === 'denied') rec.status = status;
          if (typeof p['outputPreview'] === 'string') rec.outputPreview = p['outputPreview'];
          if (typeof p['durationMs'] === 'number') rec.durationMs = p['durationMs'];
        }
        state.transcript.push({
          kind: 'tool_result',
          step,
          callId,
          tool: String(p['tool'] ?? ''),
          status: typeof status === 'string' ? status : 'ok',
          outputPreview: typeof p['outputPreview'] === 'string' ? p['outputPreview'] : '',
        });
        if (status === 'error') {
          state.errors.push({ step, kind: 'unknown', message: `Tool ${String(p['tool'] ?? '')} lỗi.` });
        }
        break;
      }
      case 'h4.codeact.run': {
        state.codeActRuns.push(event.payload as HarnessV4Event<'h4.codeact.run'>['payload']);
        const cp = event.payload as HarnessV4Event<'h4.codeact.run'>['payload'];
        state.transcript.push({
          kind: 'codeact',
          step: cp.step,
          runId: cp.runId,
          actionKind: cp.actionKind,
          exitCode: cp.exitCode,
          outputPreview: cp.outputPreview,
        });
        break;
      }
      case 'h4.codeact.loop': {
        // Loop chỉ là tóm tắt — chi tiết từng vòng nằm ở event h4.codeact.run.
        break;
      }
      case 'h4.error': {
        state.errors.push(event.payload as HarnessV4Event<'h4.error'>['payload']);
        const ep = event.payload as HarnessV4Event<'h4.error'>['payload'];
        state.transcript.push({ kind: 'error', step: ep.step, message: ep.message });
        break;
      }
      case 'h4.checkpoint': {
        state.checkpoints.push(event.payload as HarnessV4Event<'h4.checkpoint'>['payload']);
        break;
      }
      case 'h4.session.ended': {
        const ep = p as unknown as H4SessionEndedPayload;
        state.status = ep.status;
        state.endedAt = event.at;
        state.steps = Math.max(state.steps, ep.steps);
        break;
      }
      default:
        break;
    }
  }
  state.digest = harnessV4DigestState(state);
  return state;
}

/** Diff số học giữa hai trạng thái session đã fold. */
export function harnessV4CompareStates(
  a: HarnessV4SessionState,
  b: HarnessV4SessionState,
): HarnessV4StateDiff {
  const stepsDelta = b.steps - a.steps;
  const tokensDelta = b.tokensUsed - a.tokensUsed;
  const toolCallsDelta = b.toolCalls.length - a.toolCalls.length;
  const codeActRunsDelta = b.codeActRuns.length - a.codeActRuns.length;
  const errorsDelta = b.errors.length - a.errors.length;
  const transcriptDelta = b.transcript.length - a.transcript.length;
  const statusChanged = a.status !== b.status;
  const parts: string[] = [];
  if (stepsDelta !== 0) parts.push(`steps ${stepsDelta > 0 ? '+' : ''}${stepsDelta}`);
  if (tokensDelta !== 0) parts.push(`tokens ${tokensDelta > 0 ? '+' : ''}${tokensDelta}`);
  if (toolCallsDelta !== 0) parts.push(`tool calls ${toolCallsDelta > 0 ? '+' : ''}${toolCallsDelta}`);
  if (codeActRunsDelta !== 0) parts.push(`codeact ${codeActRunsDelta > 0 ? '+' : ''}${codeActRunsDelta}`);
  if (errorsDelta !== 0) parts.push(`errors ${errorsDelta > 0 ? '+' : ''}${errorsDelta}`);
  if (statusChanged) parts.push(`status ${a.status} → ${b.status}`);
  return {
    stepsDelta,
    tokensDelta,
    toolCallsDelta,
    codeActRunsDelta,
    errorsDelta,
    transcriptDelta,
    statusChanged,
    summary: parts.length > 0 ? parts.join(', ') : 'identical',
  };
}

/** Điều kiện lọc khi query event trong một session. */
export interface HarnessV4EventQuery {
  /** Chỉ lấy các loại này (không set = tất cả). */
  types?: HarnessV4EventKind[];
  /** Chỉ lấy seq >= giá trị này. */
  fromSeq?: number;
  /** Chỉ lấy seq <= giá trị này. */
  toSeq?: number;
  /** Giới hạn số event trả về (mặc định không giới hạn). */
  limit?: number;
  /** Bỏ qua N event đầu sau khi lọc (phân trang). */
  offset?: number;
}

/** Snapshot trạng thái đã fold của một session (để UI nạp nhanh không cần replay). */
export interface HarnessV4SessionSnapshot {
  version: 1;
  sessionId: string;
  /** Seq cuối cùng mà snapshot bao phủ (bao gồm). */
  upToSeq: number;
  /** Số event đã fold. */
  eventCount: number;
  /** Hash của event cuối (để kiểm tra snapshot khớp log hiện tại). */
  lastHash: string;
  /** Trạng thái đã fold tới upToSeq. */
  state: HarnessV4SessionState;
  savedAt: string;
}

export interface HarnessV4EventLogOptions {
  /** Thư mục chứa các file `.jsonl` của session. Bắt buộc. */
  logDir: string;
  /** Dung lượng tối đa một file session (mặc định 16 MiB). */
  maxFileBytes?: number;
  /** Ghi đè `at` khi append — chủ yếu cho test determinism. */
  now?: () => string;
}

export interface HarnessV4ReadResult {
  sessionId: string;
  events: AnyHarnessV4Event[];
  corruptLines: number;
  invalidLines: number;
}

export interface HarnessV4ResumeResult {
  /** Session mới (con) vừa tạo. */
  childSessionId: string;
  parentSessionId: string;
  fromSeq: number;
  /** Số event đã sao chép sang session con. */
  eventsCopied: number;
  /** Trạng thái của session con tại điểm fork. */
  childStateAtFork: HarnessV4SessionState;
}

/** Lỗi ném ra khi append vào log đã hỏng hoặc đã đầy. */
export class HarnessV4EventLogError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HarnessV4EventLogError';
  }
}

export class HarnessV4EventLog {
  private readonly logDir: string;
  private readonly maxFileBytes: number;
  private readonly now: () => string;
  /** Cache trạng thái cuối mỗi session (seq + hash cuối) để append không phải đọc lại file. */
  private readonly tails = new Map<string, { seq: number; hash: string }>();

  constructor(options: HarnessV4EventLogOptions) {
    this.logDir = options.logDir;
    this.maxFileBytes = options.maxFileBytes ?? HARNESS_V4_DEFAULT_MAX_FILE_BYTES;
    this.now = options.now ?? (() => new Date().toISOString());
    fs.mkdirSync(this.logDir, { recursive: true });
  }

  /** Đường dẫn file của một session. */
  sessionFilePath(sessionId: string): string {
    return path.join(this.logDir, safeHarnessV4SessionFileName(sessionId));
  }

  /** Tạo session mới (ghi event `h4.session.started` đầu tiên). */
  createSession(
    sessionId: string,
    payload: H4SessionStartedPayload,
  ): HarnessV4Event<'h4.session.started'> {
    const file = this.sessionFilePath(sessionId);
    if (fs.existsSync(file)) {
      throw new HarnessV4EventLogError(`Session ${sessionId} đã tồn tại (file ${file}).`);
    }
    return this.append(sessionId, { type: 'h4.session.started', payload });
  }

  /**
   * Append một event: tự điền seq (tiếp nối), prevHash (hash event
   * cuối), hash. Từ chối khi file trên đĩa đã hỏng (chuỗi đứt) hoặc
   * đã đầy — không nối tiếp chuỗi đã đứt.
   */
  append<K extends HarnessV4EventKind>(
    sessionId: string,
    event: NewHarnessV4Event<K>,
  ): HarnessV4Event<K> {
    const file = this.sessionFilePath(sessionId);
    let tail = this.tails.get(sessionId);
    if (tail === undefined) {
      if (fs.existsSync(file)) {
        const read = this.readSession(sessionId);
        if (read.corruptLines > 0 || read.invalidLines > 0) {
          throw new HarnessV4EventLogError(
            `Không append được: log session ${sessionId} có ${read.corruptLines} dòng hỏng / ${read.invalidLines} dòng không hợp lệ.`,
          );
        }
        const verification = this.verify(sessionId);
        if (!verification.ok) {
          throw new HarnessV4EventLogError(
            `Không append được: chuỗi hash session ${sessionId} đã đứt ở seq ${verification.firstBadSeq} (${verification.reason}).`,
          );
        }
        const last = read.events[read.events.length - 1];
        tail = last !== undefined ? { seq: last.seq, hash: last.hash } : { seq: 0, hash: HARNESS_V4_GENESIS_PREV_HASH };
      } else {
        tail = { seq: 0, hash: HARNESS_V4_GENESIS_PREV_HASH };
      }
      this.tails.set(sessionId, tail);
    }
    const seq = tail.seq + 1;
    const full: Omit<HarnessV4Event<K>, 'hash'> = {
      seq,
      sessionId,
      at: event.at ?? this.now(),
      type: event.type,
      payload: event.payload,
      prevHash: tail.hash,
    };
    const hashed: HarnessV4Event<K> = { ...full, hash: harnessV4HashEvent(full) };
    const line = `${JSON.stringify(hashed)}\n`;
    const currentSize = fs.existsSync(file) ? fs.statSync(file).size : 0;
    if (currentSize + Buffer.byteLength(line, 'utf8') > this.maxFileBytes) {
      throw new HarnessV4EventLogError(
        `Không append được: file session ${sessionId} đã đầy (${currentSize} bytes, giới hạn ${this.maxFileBytes}) — tạo session mới hoặc checkpoint.`,
      );
    }
    const fd = fs.openSync(file, 'a');
    try {
      fs.writeSync(fd, line, null, 'utf8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    this.tails.set(sessionId, { seq, hash: hashed.hash });
    return hashed;
  }

  /** Đọc toàn bộ event của một session (bỏ qua dòng hỏng, báo số lượng). */
  readSession(sessionId: string): HarnessV4ReadResult {
    const file = this.sessionFilePath(sessionId);
    if (!fs.existsSync(file)) {
      throw new HarnessV4EventLogError(`Không có session ${sessionId} (file ${file} không tồn tại).`);
    }
    const text = fs.readFileSync(file, 'utf8');
    const events: AnyHarnessV4Event[] = [];
    let corruptLines = 0;
    let invalidLines = 0;
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        corruptLines += 1;
        continue;
      }
      if (!isHarnessV4EventObject(parsed)) {
        invalidLines += 1;
        continue;
      }
      events.push(parsed);
    }
    events.sort((a, b) => a.seq - b.seq);
    return { sessionId, events, corruptLines, invalidLines };
  }

  /**
   * Query event trong một session: lọc theo loại / khoảng seq +
   * phân trang (để UI viewer nạp từng trang, không đọc cả log).
   */
  queryEvents(sessionId: string, query: HarnessV4EventQuery = {}): AnyHarnessV4Event[] {
    const { events } = this.readSession(sessionId);
    const wanted = query.types !== undefined && query.types.length > 0 ? new Set(query.types) : undefined;
    let out = events.filter((e) => {
      if (wanted !== undefined && !wanted.has(e.type)) return false;
      if (query.fromSeq !== undefined && e.seq < query.fromSeq) return false;
      if (query.toSeq !== undefined && e.seq > query.toSeq) return false;
      return true;
    });
    if (query.offset !== undefined && query.offset > 0) out = out.slice(query.offset);
    if (query.limit !== undefined && query.limit >= 0) out = out.slice(0, query.limit);
    return out;
  }

  /**
   * Lưu snapshot trạng thái đã fold của session (file
   * `<sessionId>.snapshot.json` cạnh file log): UI nạp snapshot thay
   * vì replay toàn bộ log; `loadSnapshot` kiểm tra digest + lastHash
   * để phát hiện snapshot cũ / log đã đổi sau khi snapshot.
   */
  saveSnapshot(sessionId: string): HarnessV4SessionSnapshot {
    const { events } = this.readSession(sessionId);
    if (events.length === 0) {
      throw new HarnessV4EventLogError(`Không snapshot được: session ${sessionId} chưa có event nào.`);
    }
    const last = events[events.length - 1]!;
    const state = foldHarnessV4Events(sessionId, events);
    const snapshot: HarnessV4SessionSnapshot = {
      version: 1,
      sessionId,
      upToSeq: last.seq,
      eventCount: events.length,
      lastHash: last.hash,
      state,
      savedAt: this.now(),
    };
    const file = this.snapshotFilePath(sessionId);
    const fd = fs.openSync(file, 'w');
    try {
      fs.writeSync(fd, `${JSON.stringify(snapshot, null, 2)}\n`, null, 'utf8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    return snapshot;
  }

  /** Đường dẫn file snapshot của một session. */
  snapshotFilePath(sessionId: string): string {
    return path.join(this.logDir, `${safeHarnessV4SessionFileName(sessionId).replace(/\.jsonl$/, '')}.snapshot.json`);
  }

  /**
   * Nạp snapshot đã lưu. Ném lỗi khi file không có, version lạ, hoặc
   * digest của state trong snapshot không khớp (snapshot hỏng).
   * Trả thêm `logMatches` = true khi log hiện tại vẫn khớp snapshot
   * (cùng eventCount + lastHash) — false nghĩa là log đã có thêm
   * event sau khi snapshot (snapshot vẫn dùng được tới upToSeq).
   */
  loadSnapshot(sessionId: string): HarnessV4SessionSnapshot & { logMatches: boolean } {
    const file = this.snapshotFilePath(sessionId);
    if (!fs.existsSync(file)) {
      throw new HarnessV4EventLogError(`Không có snapshot cho session ${sessionId} (file ${file} không tồn tại).`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      throw new HarnessV4EventLogError(`Snapshot của session ${sessionId} hỏng (không phải JSON).`);
    }
    if (
      parsed === null ||
      typeof parsed !== 'object' ||
      (parsed as Record<string, unknown>)['version'] !== 1 ||
      typeof (parsed as Record<string, unknown>)['sessionId'] !== 'string' ||
      typeof (parsed as Record<string, unknown>)['state'] !== 'object'
    ) {
      throw new HarnessV4EventLogError(`Snapshot của session ${sessionId} không hợp lệ (thiếu version/sessionId/state).`);
    }
    const snapshot = parsed as HarnessV4SessionSnapshot;
    const { digest, ...stateWithoutDigest } = snapshot.state;
    if (harnessV4DigestState(stateWithoutDigest) !== digest) {
      throw new HarnessV4EventLogError(`Snapshot của session ${sessionId} hỏng (digest của state không khớp).`);
    }
    let logMatches = false;
    try {
      const { events } = this.readSession(sessionId);
      const last = events[events.length - 1];
      logMatches =
        events.length === snapshot.eventCount && last !== undefined && last.hash === snapshot.lastHash;
    } catch {
      logMatches = false;
    }
    return { ...snapshot, logMatches };
  }

  /** Kiểm chứng hash chain + seq của một session. */
  verify(sessionId: string): HarnessV4Verification {
    const { events } = this.readSession(sessionId);
    let prevHash = HARNESS_V4_GENESIS_PREV_HASH;
    for (let i = 0; i < events.length; i += 1) {
      const event = events[i]!;
      if (event.seq !== i + 1) {
        return { sessionId, ok: false, eventCount: events.length, firstBadSeq: event.seq, reason: `seq ${event.seq} không tiếp nối (mong ${i + 1})` };
      }
      if (event.prevHash !== prevHash) {
        return { sessionId, ok: false, eventCount: events.length, firstBadSeq: event.seq, reason: `prevHash ở seq ${event.seq} không khớp hash event trước` };
      }
      if (!harnessV4VerifyEventHash(event)) {
        return { sessionId, ok: false, eventCount: events.length, firstBadSeq: event.seq, reason: `hash ở seq ${event.seq} không khớp nội dung (log có thể đã bị sửa)` };
      }
      prevHash = event.hash;
    }
    return { sessionId, ok: true, eventCount: events.length };
  }

  /** Replay toàn bộ session thành trạng thái (fold mọi event). */
  replay(sessionId: string): HarnessV4SessionState {
    const { events } = this.readSession(sessionId);
    if (events.length === 0) throw new HarnessV4EventLogError(`Không replay được: session ${sessionId} chưa có event nào.`);
    return foldHarnessV4Events(sessionId, events);
  }

  /** Time-travel: trạng thái session tại seq N (fold prefix 1..N). */
  stateAt(sessionId: string, atSeq: number): HarnessV4TimeTravelResult {
    const { events } = this.readSession(sessionId);
    if (events.length === 0) throw new HarnessV4EventLogError(`Không time-travel được: session ${sessionId} chưa có event nào.`);
    const totalSeq = events[events.length - 1]!.seq;
    if (!Number.isInteger(atSeq) || atSeq < 0 || atSeq > totalSeq) {
      throw new HarnessV4EventLogError(`atSeq ${atSeq} ngoài khoảng 0..${totalSeq} của session ${sessionId}.`);
    }
    const prefix = events.filter((e) => e.seq <= atSeq);
    const finalState = foldHarnessV4Events(sessionId, events);
    const state = foldHarnessV4Events(sessionId, prefix);
    return {
      sessionId,
      atSeq,
      totalSeq,
      eventsUsed: prefix.length,
      state,
      diffVsFinal: harnessV4CompareStates(state, finalState),
    };
  }

  /**
   * Chạy lại từ bước N: fork prefix 1..fromSeq sang session mới.
   * Session gốc không đổi; session con bắt đầu bằng event
   * `h4.session.started` ghi rõ parent + forkFromSeq, rồi sao chép
   * nguyên prefix (giữ seq/hash gốc — chuỗi hash của con tiếp nối
   * từ hash của event cuối prefix).
   */
  resumeFrom(
    sessionId: string,
    fromSeq: number,
    options: { childSessionId?: string; botId?: string; title?: string } = {},
  ): HarnessV4ResumeResult {
    const { events } = this.readSession(sessionId);
    if (events.length === 0) throw new HarnessV4EventLogError(`Không resume được: session ${sessionId} chưa có event nào.`);
    const totalSeq = events[events.length - 1]!.seq;
    if (!Number.isInteger(fromSeq) || fromSeq < 0 || fromSeq > totalSeq) {
      throw new HarnessV4EventLogError(`fromSeq ${fromSeq} ngoài khoảng 0..${totalSeq} của session ${sessionId}.`);
    }
    const childSessionId = options.childSessionId ?? `${sessionId}-resume-${fromSeq}-${Date.now()}`;
    const childFile = this.sessionFilePath(childSessionId);
    if (fs.existsSync(childFile)) {
      throw new HarnessV4EventLogError(`Session con ${childSessionId} đã tồn tại.`);
    }
    const parentState = foldHarnessV4Events(sessionId, events);
    const prefix = events.filter((e) => e.seq <= fromSeq);
    // Ghi session con: event started mới (seq 1) + sao chép prefix
    // (giữ nguyên seq/hash gốc, nối tiếp sau started bằng cách ghi
    // lại với prevHash là hash của started — hash gốc của prefix
    // không giữ được vì prevHash đổi, nên con lưu bản sao đã
    // re-hash; nội dung payload/seq/at giữ nguyên).
    const started = this.createSession(childSessionId, {
      botId: options.botId ?? parentState.botId,
      ...(options.title !== undefined || parentState.title !== undefined
        ? { title: options.title ?? parentState.title }
        : {}),
      parentSessionId: sessionId,
      forkFromSeq: fromSeq,
    });
    void started;
    for (const event of prefix) {
      if (event.type === 'h4.session.started') continue;
      this.append(childSessionId, { type: event.type, payload: event.payload as never, at: event.at });
    }
    const childEvents = this.readSession(childSessionId).events;
    return {
      childSessionId,
      parentSessionId: sessionId,
      fromSeq,
      eventsCopied: prefix.length,
      childStateAtFork: foldHarnessV4Events(childSessionId, childEvents),
    };
  }

  /** Liệt kê mọi session trong logDir (mới nhất trước, theo mtime). */  listSessions(): HarnessV4SessionMeta[] {
    const files = fs
      .readdirSync(this.logDir)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => ({ name: f, mtime: fs.statSync(path.join(this.logDir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    const out: HarnessV4SessionMeta[] = [];
    for (const { name } of files) {
      const sessionId = name.replace(/\.jsonl$/, '');
      try {
        const { events, corruptLines } = this.readSession(sessionId);
        if (events.length === 0) continue;
        const state = foldHarnessV4Events(sessionId, events);
        const last = events[events.length - 1]!;
        out.push({
          sessionId,
          botId: state.botId,
          ...(state.title !== undefined ? { title: state.title } : {}),
          status: state.status,
          startedAt: state.startedAt,
          ...(state.endedAt !== undefined ? { endedAt: state.endedAt } : {}),
          eventCount: events.length,
          lastSeq: last.seq,
          ...(corruptLines > 0 ? {} : {}),
          toolCalls: state.toolCalls.length,
          codeActRuns: state.codeActRuns.length,
          errors: state.errors.length,
        });
      } catch {
        // File hỏng một phần: bỏ qua trong list, verify sẽ báo rõ.
        continue;
      }
    }
    return out;
  }

  /** Kết thúc session (ghi event `h4.session.ended`). */
  endSession(
    sessionId: string,
    payload: Omit<H4SessionEndedPayload, 'steps' | 'toolCalls' | 'codeActRuns' | 'errors' | 'durationMs'> & {
      steps?: number;
      toolCalls?: number;
      codeActRuns?: number;
      errors?: number;
      durationMs?: number;
    },
  ): HarnessV4Event<'h4.session.ended'> {
    const state = this.replay(sessionId);
    const startedMs = state.startedAt !== '' ? Date.parse(state.startedAt) : Date.now();
    return this.append(sessionId, {
      type: 'h4.session.ended',
      payload: {
        status: payload.status,
        steps: payload.steps ?? state.steps,
        toolCalls: payload.toolCalls ?? state.toolCalls.length,
        codeActRuns: payload.codeActRuns ?? state.codeActRuns.length,
        errors: payload.errors ?? state.errors.length,
        durationMs: payload.durationMs ?? Math.max(0, Date.now() - startedMs),
        ...(payload.finalText !== undefined ? { finalText: payload.finalText } : {}),
        ...(payload.message !== undefined ? { message: payload.message } : {}),
      },
    });
  }
}

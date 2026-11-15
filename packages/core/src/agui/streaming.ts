/**
 * AG-UI streaming v1.1 (v1.09, Đội T4) — resumable stream sessions.
 *
 * Bus v0.97 đã có replay buffer (200 event/run) + `replay(runId,
 * fromSequence)`, nhưng chưa có khái niệm "session": client ngắt
 * kết nối rồi nối lại phải tự nhớ sequence, tự phát hiện mất event,
 * tự quyết replay hay xin snapshot. Module này thêm tầng session
 * trên bus:
 *  - `AgUiStreamSession`: một phiên xem stream của một run — subscribe
 *    bus, ghi checkpoint (lastSequence + snapshot state + text đã
 *    gộp), phát hiện gap (sequence nhảy cóc), đếm event mất, tự
 *    replay phần thiếu từ buffer khi nối lại.
 *  - `AgUiStreamCheckpoint`: checkpoint nhẹ (sequence + state +
 *    text) để resume nhanh mà không replay toàn bộ lịch sử.
 *  - Stall detection: không có event mới quá `stallAfterMs` → session
 *    báo `stalled` (renderer hiện "đang chờ agent…", khác với run đã
 *    xong).
 *  - Text delta coalescing: nhiều `TEXT_MESSAGE_CONTENT` liên tiếp
 *    trong cùng một tick được gộp thành một lần cập nhật UI (giảm
 *    re-render) mà không mất ký tự nào.
 *  - `AgUiStreamSessionManager`: giữ nhiều session (mỗi run một
 *    session), resume tất cả sau khi app mất kết nối bus.
 *
 * Chỉ dùng bus + state store đã có, không gọi mạng, không chạm disk.
 * Checkpoint lưu trong bộ nhớ; app muốn bền vững qua restart thì lưu
 * checkpoint JSON xuống disk bằng `resume.ts` (checkpoint store).
 */

import { AgUiEventBus } from './bus';
import { AgUiStateStore } from './state';
import type { AgUiEvent, AgUiEventFilter, AgUiStateOperation } from './types';

/** True khi event type là event cuối của run (RUN_FINISHED/RUN_ERROR). */
export function isAgUiTerminalType(type: string): boolean {
  return type === 'RUN_FINISHED' || type === 'RUN_ERROR';
}

/** Checkpoint nhẹ của một stream session (để resume). */
export interface AgUiStreamCheckpoint {
  runId: string;
  /** Sequence của event cuối đã nhận (inclusive). */
  lastSequence: number;
  /** Số event đã nhận. */
  receivedEvents: number;
  /** Số gap đã phát hiện tới lúc checkpoint. */
  gapsDetected: number;
  /** State snapshot của run tại checkpoint (null khi chưa có snapshot). */
  state: Record<string, unknown> | null;
  /** Text đã gộp của message đang stream (messageId → text). */
  textByMessage: Record<string, string>;
  /** ISO-8601 lúc tạo checkpoint. */
  createdAt: string;
  /** true khi run đã tới event cuối (RUN_FINISHED/RUN_ERROR). */
  terminal: boolean;
}

/** Trạng thái session. */
export type AgUiStreamSessionStatus =
  | 'live'
  | 'paused'
  | 'stalled'
  | 'resuming'
  | 'finished'
  | 'gap';

/** Thống kê session (để UI/debug). */
export interface AgUiStreamSessionStats {
  received: number;
  delivered: number;
  gaps: number;
  missingSequences: number[];
  replayed: number;
  duplicatesSkipped: number;
  lastSequence: number;
  status: AgUiStreamSessionStatus;
  stalledForMs: number | null;
}

/** Handler nhận event đã qua session (đã gộp delta, đã lọc trùng). */
export type AgUiStreamSessionHandler = (event: AgUiEvent) => void;

export interface AgUiStreamSessionOptions {
  /** Lọc event (vd chỉ một số type). */
  filter?: AgUiEventFilter;
  /** Không có event mới quá bao lâu thì báo stalled (mặc định 30s; 0 = tắt). */
  stallAfterMs?: number;
  /** Gộp text delta trong cùng tick (mặc định true). */
  coalesceTextDeltas?: boolean;
  /** State store dùng để snapshot checkpoint (mặc định tạo mới). */
  stateStore?: AgUiStateStore;
  /** Hàm lấy thời gian (để test ép stall). */
  now?: () => number;
}

/**
 * Một phiên xem stream của một run. Luồng:
 *   start() → subscribe bus, nhận event live.
 *   pause() → hủy subscribe (giữ checkpoint).
 *   resume() → replay phần thiếu từ bus buffer (từ lastSequence+1),
 *     rồi subscribe lại — không mất event nào còn trong buffer.
 */
export class AgUiStreamSession {
  private readonly bus: AgUiEventBus;
  private readonly runId: string;
  private readonly filter: AgUiEventFilter;
  private readonly stallAfterMs: number;
  private readonly coalesceTextDeltas: boolean;
  private readonly stateStore: AgUiStateStore;
  private readonly now: () => number;
  private readonly handlers = new Set<AgUiStreamSessionHandler>();
  private unsubscribe: (() => void) | null = null;
  private lastSequence = -1;
  private received = 0;
  private delivered = 0;
  private gaps = 0;
  private replayed = 0;
  private duplicatesSkipped = 0;
  private readonly missing = new Set<number>();
  private readonly textByMessage = new Map<string, string>();
  private readonly pendingDeltas = new Map<string, AgUiEvent[]>();
  private coalesceScheduled = false;
  private lastEventAt = 0;
  private terminal = false;
  private status: AgUiStreamSessionStatus = 'paused';

  constructor(bus: AgUiEventBus, runId: string, opts: AgUiStreamSessionOptions = {}) {
    if (!runId || typeof runId !== 'string') throw new Error('AgUiStreamSession cần runId.');
    this.bus = bus;
    this.runId = runId;
    this.filter = { ...(opts.filter ?? {}), runId };
    this.stallAfterMs = opts.stallAfterMs ?? 30_000;
    this.coalesceTextDeltas = opts.coalesceTextDeltas ?? true;
    this.stateStore = opts.stateStore ?? new AgUiStateStore();
    this.now = opts.now ?? (() => Date.now());
  }

  /** Run mà session này theo dõi. */
  get id(): string {
    return this.runId;
  }

  /** Trạng thái session hiện tại. */
  get currentStatus(): AgUiStreamSessionStatus {
    if (this.status === 'live' && this.isStalled()) return 'stalled';
    if (this.status === 'live' && this.missing.size > 0) return 'gap';
    return this.status;
  }

  /** Thống kê session. */
  get stats(): AgUiStreamSessionStats {
    return {
      received: this.received,
      delivered: this.delivered,
      gaps: this.gaps,
      missingSequences: [...this.missing].sort((a, b) => a - b),
      replayed: this.replayed,
      duplicatesSkipped: this.duplicatesSkipped,
      lastSequence: this.lastSequence,
      status: this.currentStatus,
      stalledForMs:
        this.status === 'live' && this.lastEventAt > 0 ? this.now() - this.lastEventAt : null,
    };
  }

  /** True khi không có event mới quá stallAfterMs (chỉ khi đang live). */
  isStalled(): boolean {
    if (this.stallAfterMs <= 0) return false;
    if (this.status !== 'live') return false;
    if (this.lastEventAt === 0) return false;
    return this.now() - this.lastEventAt > this.stallAfterMs;
  }

  /** Đăng ký handler nhận event (trả unsubscribe). */
  onEvent(handler: AgUiStreamSessionHandler): () => void {
    this.handlers.add(handler);
    let done = false;
    return () => {
      if (done) return;
      done = true;
      this.handlers.delete(handler);
    };
  }

  /**
   * Bắt đầu session: replay phần thiếu từ buffer (khi resume từ
   * checkpoint) rồi subscribe live. Gọi nhiều lần không sao (lần sau
   * là no-op khi đang live).
   */
  start(fromCheckpoint?: AgUiStreamCheckpoint | null): void {
    if (this.status === 'live') return;
    if (fromCheckpoint && fromCheckpoint.runId === this.runId) {
      this.loadCheckpoint(fromCheckpoint);
    }
    this.status = 'resuming';
    // Replay phần thiếu từ buffer trước khi subscribe live — thứ tự
    // đúng: replay (cũ) rồi live (mới), không đảo.
    const buffered = this.bus.replay(this.runId, this.lastSequence + 1);
    for (const event of buffered) {
      this.replayed += 1;
      this.handleEvent(event, true);
    }
    this.flushCoalesced();
    this.unsubscribe = this.bus.subscribe(this.filter, (event) => this.handleEvent(event, false));
    this.status = this.terminal ? 'finished' : 'live';
    if (this.lastEventAt === 0) this.lastEventAt = this.now();
  }

  /** Tạm dừng: hủy subscribe, giữ checkpoint để resume sau. */
  pause(): AgUiStreamCheckpoint {
    this.flushCoalesced();
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
    this.status = this.terminal ? 'finished' : 'paused';
    return this.checkpoint();
  }

  /** Nối lại sau pause/ngắt: replay phần thiếu rồi subscribe lại. */
  resume(): AgUiStreamCheckpoint | null {
    if (this.status === 'live') return this.checkpoint();
    if (this.terminal) return this.checkpoint();
    this.start();
    return this.checkpoint();
  }

  /** Dừng hẳn session (như pause nhưng không giữ trạng thái live nữa). */
  stop(): AgUiStreamCheckpoint {
    return this.pause();
  }

  /** Checkpoint hiện tại (để lưu disk / resume sau restart). */
  checkpoint(): AgUiStreamCheckpoint {
    this.flushCoalesced();
    const state = this.stateStore.get(this.runId);
    return {
      runId: this.runId,
      lastSequence: this.lastSequence,
      receivedEvents: this.received,
      gapsDetected: this.gaps,
      state: state ? { ...(state.state as Record<string, unknown>) } : null,
      textByMessage: Object.fromEntries(this.textByMessage),
      createdAt: new Date().toISOString(),
      terminal: this.terminal,
    };
  }

  /**
   * Nạp checkpoint (vd từ disk sau restart): khôi phục lastSequence
   * + text đã gộp + state, để `start()` chỉ replay phần sau đó.
   */
  loadCheckpoint(cp: AgUiStreamCheckpoint): void {
    if (cp.runId !== this.runId) return;
    if (cp.lastSequence < this.lastSequence) return;
    this.lastSequence = cp.lastSequence;
    this.received = cp.receivedEvents;
    this.gaps = cp.gapsDetected;
    this.terminal = cp.terminal;
    this.textByMessage.clear();
    for (const [messageId, text] of Object.entries(cp.textByMessage)) {
      this.textByMessage.set(messageId, text);
    }
    if (cp.state !== null) {
      this.stateStore.applySnapshot(this.runId, cp.state, cp.lastSequence);
    }
    this.missing.clear();
  }

  /**
   * Xin replay thủ công phần thiếu (khi gap vẫn còn sau resume —
   * vd buffer bus đã cắt event cũ). Trả số event replay được; event
   * đã bị cắt khỏi buffer thì không lấy lại được (caller xin
   * snapshot đầy đủ qua checkpoint store).
   */
  requestReplay(): { replayed: number; stillMissing: number[] } {
    if (this.missing.size === 0) return { replayed: 0, stillMissing: [] };
    const from = Math.min(...this.missing);
    const buffered = this.bus.replay(this.runId, from);
    let replayed = 0;
    for (const event of buffered) {
      if (this.missing.has(event.sequence ?? -1)) {
        replayed += 1;
        this.replayed += 1;
        this.handleEvent(event, true);
      }
    }
    this.flushCoalesced();
    return { replayed, stillMissing: [...this.missing].sort((a, b) => a - b) };
  }

  private handleEvent(event: AgUiEvent, isReplay: boolean): void {
    const sequence = event.sequence ?? -1;
    this.received += 1;
    this.lastEventAt = this.now();
    if (sequence >= 0 && sequence <= this.lastSequence) {
      this.duplicatesSkipped += 1;
      return;
    }
    if (sequence > this.lastSequence + 1) {
      this.gaps += 1;
      for (let s = this.lastSequence + 1; s < sequence; s++) this.missing.add(s);
    }
    if (sequence >= 0) {
      this.missing.delete(sequence);
      this.lastSequence = sequence;
    }
    // Cập nhật state store + text gộp trước khi giao cho handler.
    if (event.type === 'STATE_SNAPSHOT') {
      const state = (event.data as Record<string, unknown>)['state'];
      if (state && typeof state === 'object') {
        this.stateStore.applySnapshot(this.runId, state as Record<string, unknown>, sequence);
      }
    } else if (event.type === 'STATE_DELTA') {
      const operations = (event.data as Record<string, unknown>)['operations'];
      if (Array.isArray(operations)) {
        this.stateStore.applyDelta(
          this.runId,
          operations as AgUiStateOperation[],
          sequence,
        );
      }
    } else if (event.type === 'TEXT_MESSAGE_CONTENT') {
      const data = event.data as Record<string, unknown>;
      const messageId = typeof data['messageId'] === 'string' ? (data['messageId'] as string) : '';
      const delta = typeof data['delta'] === 'string' ? (data['delta'] as string) : '';
      if (messageId) {
        this.textByMessage.set(messageId, (this.textByMessage.get(messageId) ?? '') + delta);
      }
    }
    if (isAgUiTerminalType(event.type)) this.terminal = true;
    if (
      this.coalesceTextDeltas &&
      event.type === 'TEXT_MESSAGE_CONTENT' &&
      !isReplay
    ) {
      const messageId =
        typeof (event.data as Record<string, unknown>)['messageId'] === 'string'
          ? ((event.data as Record<string, unknown>)['messageId'] as string)
          : '';
      const queue = this.pendingDeltas.get(messageId) ?? [];
      queue.push(event);
      this.pendingDeltas.set(messageId, queue);
      if (!this.coalesceScheduled) {
        this.coalesceScheduled = true;
        queueMicrotask(() => this.flushCoalesced());
      }
      return;
    }
    this.deliver(event);
  }

  /** Gộp các delta đang chờ thành một event mỗi message rồi giao. */
  flushCoalesced(): void {
    if (this.pendingDeltas.size === 0) {
      this.coalesceScheduled = false;
      return;
    }
    this.coalesceScheduled = false;
    for (const [messageId, events] of [...this.pendingDeltas.entries()]) {
      this.pendingDeltas.delete(messageId);
      if (events.length === 0) continue;
      if (events.length === 1) {
        this.deliver(events[0]);
        continue;
      }
      const merged: AgUiEvent = {
        ...events[events.length - 1],
        data: {
          ...(events[events.length - 1].data as Record<string, unknown>),
          messageId,
          delta: events
            .map((e) => (e.data as Record<string, unknown>)['delta'] as string)
            .join(''),
        },
      };
      this.deliver(merged);
    }
  }

  private deliver(event: AgUiEvent): void {
    this.delivered += 1;
    for (const handler of [...this.handlers]) {
      try {
        handler(event);
      } catch {
        // Handler lỗi không làm chết session — bus cũng nuốt lỗi
        // handler theo cùng nguyên tắc (xem bus.ts).
      }
    }
    if (this.terminal && this.status === 'live') this.status = 'finished';
  }
}

/** Quản lý nhiều session (mỗi run một session). */
export class AgUiStreamSessionManager {
  private readonly sessions = new Map<string, AgUiStreamSession>();

  constructor(private readonly bus: AgUiEventBus) {}

  /** Số session đang quản lý. */
  get sessionCount(): number {
    return this.sessions.size;
  }

  /** Lấy hoặc tạo session cho một run. */
  sessionFor(runId: string, opts: AgUiStreamSessionOptions = {}): AgUiStreamSession {
    let session = this.sessions.get(runId);
    if (!session) {
      session = new AgUiStreamSession(this.bus, runId, opts);
      this.sessions.set(runId, session);
    }
    return session;
  }

  /** Session đã có (undefined khi chưa tạo). */
  getSession(runId: string): AgUiStreamSession | undefined {
    return this.sessions.get(runId);
  }

  /** Checkpoint của mọi session (để lưu disk trước khi tắt app). */
  checkpointAll(): AgUiStreamCheckpoint[] {
    return [...this.sessions.values()].map((s) => s.checkpoint());
  }

  /** Resume mọi session chưa xong (sau khi mất kết nối bus). */
  resumeAll(): { resumed: number; finished: number } {
    let resumed = 0;
    let finished = 0;
    for (const session of this.sessions.values()) {
      if (session.stats.status === 'finished') {
        finished += 1;
        continue;
      }
      session.resume();
      resumed += 1;
    }
    return { resumed, finished };
  }

  /** Dừng và quên một session. */
  dropSession(runId: string): boolean {
    const session = this.sessions.get(runId);
    if (!session) return false;
    session.stop();
    return this.sessions.delete(runId);
  }

  /** Dừng mọi session. */
  stopAll(): void {
    for (const session of [...this.sessions.values()]) session.stop();
  }
}

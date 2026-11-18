/**
 * Durable automation v2 (v1.34, Đội T6) — FILE MỚI trong `durable/`,
 * không sửa file hiện có (`journal.ts` / `recovery.ts` / `resume.ts` /
 * `session.ts` giữ nguyên).
 *
 * Automation bền vững qua restart: định nghĩa + trạng thái + trace đều
 * lưu xuống file JSON (ghi atomic qua tmp + rename) nên app crash hay
 * restart thì automation vẫn còn, và lần chạy dở dang được phát hiện
 * để resume thay vì mất hút.
 *
 * - Trigger: theo lịch (`schedule`, chạy lại mỗi `intervalMs`) hoặc
 *   theo sự kiện (`event`, pattern khớp event: chính xác, `prefix.*`,
 *   hoặc `*`).
 * - Action: dữ liệu thuần (`run-bot` với botId + task) — code CHẠY
 *   action là executor do host truyền vào (`runDueAutomations`), module
 *   này không tự spawn bot, không chạm mạng.
 * - Retry: fail thì đợi backoff mũ (`baseBackoffMs * 2^(n-1)`, chặn
 *   trên `maxBackoffMs`) rồi chạy lại; fail liên tiếp đủ `maxAttempts`
 *   → dead-letter (dừng hẳn, giữ trace để điều tra, không retry lén).
 * - Trace: mỗi lần chạy ghi 1 trace (bắt đầu / xong / lỗi / retry /
 *   dead-letter / resume) — tối đa 100 trace/automation, cũ nhất rớt.
 * - Resume sau crash: khi load store, automation nào đang `running`
 *   (app chết giữa chừng) → đánh dấu `interrupted`, ghi trace resume,
 *   xếp chạy lại ngay (trừ khi đã hết lần retry → dead-letter). Run
 *   đã xong trước crash không chạy lại — không double-run.
 *
 * Store có 2 chế độ: có `filePath` → bền vững qua restart; không có
 * → chỉ trong bộ nhớ (dùng cho test / host tự lưu snapshot qua
 * `serialize()` / `AutomationV2Store.fromSnapshot()`).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

/** Trigger theo lịch: chạy lại mỗi intervalMs. */
export interface AutomationV2ScheduleTrigger {
  kind: 'schedule';
  /** Khoảng giữa 2 lần chạy (ms, > 0). */
  intervalMs: number;
}

/** Trigger theo sự kiện: chạy khi event khớp pattern. */
export interface AutomationV2EventTrigger {
  kind: 'event';
  /** Pattern: tên chính xác, `prefix.*`, hoặc `*` (mọi event). */
  eventPattern: string;
}

export type DurableAutomationV2Trigger = AutomationV2ScheduleTrigger | AutomationV2EventTrigger;

/** Action automation chạy (dữ liệu thuần — executor của host diễn giải). */
export interface AutomationV2Action {
  kind: 'run-bot';
  botId: string;
  /** Task/mô tả ngắn giao cho bot (nếu có). */
  task?: string;
}

/** Trạng thái vòng đời của automation. */
export type AutomationV2Status =
  | 'idle'
  | 'running'
  | 'waiting-retry'
  | 'dead-letter'
  | 'paused';

/** Mọi trạng thái — dùng để validate / lọc ở UI. */
export const AUTOMATION_V2_STATUSES: readonly AutomationV2Status[] = [
  'idle',
  'running',
  'waiting-retry',
  'dead-letter',
  'paused',
];

/** Một trace của automation (append-only, giới hạn 100/automation). */
export interface AutomationV2Trace {
  id: string;
  automationId: string;
  /** 'started' | 'succeeded' | 'failed' | 'retry-scheduled' | 'dead-letter' | 'resumed' | 'paused' | 'resumed-manual'. */
  kind: string;
  /** Số lần thử của lần chạy này (1 = lần đầu). */
  attempt: number;
  message: string;
  at: number;
}

/** Định nghĩa + trạng thái runtime của một automation. */
export interface DurableAutomationV2 {
  id: string;
  name: string;
  description: string;
  trigger: DurableAutomationV2Trigger;
  action: AutomationV2Action;
  status: AutomationV2Status;
  /** Số lần chạy lại tối đa cho 1 lần kích hoạt (mặc định 3). */
  maxAttempts: number;
  /** Backoff cơ số (ms, mặc định 1000). */
  baseBackoffMs: number;
  /** Backoff tối đa (ms, mặc định 60000). */
  maxBackoffMs: number;
  /** Lần thử hiện tại của lần kích hoạt đang chạy (0 = chưa chạy). */
  attempt: number;
  /** Số lần fail liên tiếp (reset khi success). */
  consecutiveFailures: number;
  /** Tổng số lần chạy đã bắt đầu (kể cả retry). */
  totalRuns: number;
  /** Tổng số lần chạy thành công. */
  totalSuccesses: number;
  /** Lần chạy tiếp theo (epoch ms) — null khi không có lịch (event trigger / paused / dead-letter). */
  nextRunAt: number | null;
  lastRunAt: number | null;
  lastSuccessAt: number | null;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
  /** Trace của automation (mới nhất cuối). */
  traces: AutomationV2Trace[];
}

/** Tối đa trace giữ lại mỗi automation. */
export const AUTOMATION_V2_MAX_TRACES = 100;

/** Mặc định cho automation mới (host có thể override từng trường). */
export const AUTOMATION_V2_DEFAULTS = {
  maxAttempts: 3,
  baseBackoffMs: 1000,
  maxBackoffMs: 60000,
} as const;

// ---------------------------------------------------------------------------
// Pattern event + backoff (hàm thuần, test trực tiếp được)
// ---------------------------------------------------------------------------

/**
 * Khớp event với pattern: `*` khớp mọi event, `prefix.*` khớp event bắt
 * đầu bằng `prefix.`, còn lại khớp chính xác.
 */
export function matchAutomationV2Event(pattern: string, event: string): boolean {
  if (pattern === '*') return true;
  if (pattern.endsWith('.*')) return event.startsWith(pattern.slice(0, -1));
  return pattern === event;
}

/** Backoff cho lần thử `attempt` (1-based): base * 2^(n-1), chặn trên max. */
export function automationV2BackoffMs(attempt: number, baseBackoffMs: number, maxBackoffMs: number): number {
  if (attempt <= 1) return baseBackoffMs;
  return Math.min(maxBackoffMs, baseBackoffMs * 2 ** (attempt - 1));
}

/** Tính `nextRunAt` sau khi fail lần `attempt`: now + backoff. */
export function automationV2NextRetryAt(
  attempt: number,
  baseBackoffMs: number,
  maxBackoffMs: number,
  now: number,
): number {
  return now + automationV2BackoffMs(attempt, baseBackoffMs, maxBackoffMs);
}

// ---------------------------------------------------------------------------
// Validate
// ---------------------------------------------------------------------------

/** Validate input tạo automation: lỗi → danh sách (rỗng = hợp lệ). */
export function validateDurableAutomationV2(input: unknown): string[] {
  const errors: string[] = [];
  if (typeof input !== 'object' || input === null) return ['automation phải là object.'];
  const a = input as Record<string, unknown>;
  if (typeof a.id !== 'string' || a.id.trim().length === 0) errors.push('automation.id phải là chuỗi không rỗng.');
  if (typeof a.name !== 'string' || a.name.trim().length === 0) errors.push('automation.name phải là chuỗi không rỗng.');
  const trigger = a.trigger as Record<string, unknown> | undefined;
  if (typeof trigger !== 'object' || trigger === null) {
    errors.push('automation.trigger phải là object.');
  } else if (trigger.kind === 'schedule') {
    if (typeof trigger.intervalMs !== 'number' || !Number.isFinite(trigger.intervalMs) || trigger.intervalMs <= 0) {
      errors.push('trigger.intervalMs phải là số > 0.');
    }
  } else if (trigger.kind === 'event') {
    if (typeof trigger.eventPattern !== 'string' || trigger.eventPattern.trim().length === 0) {
      errors.push('trigger.eventPattern phải là chuỗi không rỗng.');
    }
  } else {
    errors.push("trigger.kind phải là 'schedule' hoặc 'event'.");
  }
  const action = a.action as Record<string, unknown> | undefined;
  if (typeof action !== 'object' || action === null) {
    errors.push('automation.action phải là object.');
  } else {
    if (action.kind !== 'run-bot') errors.push("action.kind phải là 'run-bot'.");
    if (typeof action.botId !== 'string' || action.botId.trim().length === 0) {
      errors.push('action.botId phải là chuỗi không rỗng.');
    }
  }
  if (a.maxAttempts !== undefined && (typeof a.maxAttempts !== 'number' || a.maxAttempts < 1)) {
    errors.push('maxAttempts (nếu có) phải là số >= 1.');
  }
  return errors;
}

// ---------------------------------------------------------------------------
// Store bền vững (file JSON, ghi atomic)
// ---------------------------------------------------------------------------

/** Executor host cung cấp: chạy action của automation, throw khi lỗi. */
export type AutomationV2Executor = (
  automation: DurableAutomationV2,
  attempt: number,
) => Promise<unknown>;

/** Snapshot JSON của store (để host tự lưu/khôi phục khi không dùng filePath). */
export interface AutomationV2Snapshot {
  version: 2;
  automations: DurableAutomationV2[];
}

export class AutomationV2Store {
  private readonly automations = new Map<string, DurableAutomationV2>();
  private traceCounter = 0;
  private readonly filePath: string | null;

  /**
   * @param filePath đường dẫn file JSON lưu store (null/undefined = chỉ bộ nhớ).
   *   File được load ngay trong constructor khi tồn tại (kèm resume sau crash).
   */
  constructor(filePath?: string | null, now: number = Date.now()) {
    this.filePath = filePath ?? null;
    if (this.filePath && fs.existsSync(this.filePath)) {
      this.loadFromDisk(now);
    }
  }

  /** Tạo store từ snapshot (host tự quản persistence). */
  static fromSnapshot(snapshot: AutomationV2Snapshot, filePath?: string | null): AutomationV2Store {
    const store = new AutomationV2Store(filePath);
    for (const a of snapshot.automations ?? []) {
      store.automations.set(a.id, { ...a, traces: [...(a.traces ?? [])] });
    }
    return store;
  }

  // -- CRUD ---------------------------------------------------------------

  /** Thêm automation mới (id trùng → throw). Trả về bản sao đã lưu. */
  add(
    input: {
      id: string;
      name: string;
      description?: string;
      trigger: DurableAutomationV2Trigger;
      action: AutomationV2Action;
      maxAttempts?: number;
      baseBackoffMs?: number;
      maxBackoffMs?: number;
    },
    now: number = Date.now(),
  ): DurableAutomationV2 {
    const errors = validateDurableAutomationV2(input);
    if (errors.length > 0) throw new Error(`Automation không hợp lệ: ${errors.join(' ')}`);
    if (this.automations.has(input.id)) throw new Error(`Automation "${input.id}" đã tồn tại.`);
    const automation: DurableAutomationV2 = {
      id: input.id,
      name: input.name,
      description: input.description ?? '',
      trigger: input.trigger,
      action: input.action,
      status: 'idle',
      maxAttempts: input.maxAttempts ?? AUTOMATION_V2_DEFAULTS.maxAttempts,
      baseBackoffMs: input.baseBackoffMs ?? AUTOMATION_V2_DEFAULTS.baseBackoffMs,
      maxBackoffMs: input.maxBackoffMs ?? AUTOMATION_V2_DEFAULTS.maxBackoffMs,
      attempt: 0,
      consecutiveFailures: 0,
      totalRuns: 0,
      totalSuccesses: 0,
      nextRunAt: input.trigger.kind === 'schedule' ? now + input.trigger.intervalMs : null,
      lastRunAt: null,
      lastSuccessAt: null,
      lastError: null,
      createdAt: now,
      updatedAt: now,
      traces: [],
    };
    this.automations.set(automation.id, automation);
    this.persist();
    return this.copy(automation);
  }

  /** Lấy 1 automation (bản sao — sửa ngoài không ảnh hưởng store). */
  get(id: string): DurableAutomationV2 | undefined {
    const a = this.automations.get(id);
    return a ? this.copy(a) : undefined;
  }

  /** Mọi automation (sắp theo id). */
  list(): DurableAutomationV2[] {
    return [...this.automations.values()].sort((a, b) => a.id.localeCompare(b.id)).map((a) => this.copy(a));
  }

  /** Xoá automation (không có → false). */
  remove(id: string): boolean {
    const gone = this.automations.delete(id);
    if (gone) this.persist();
    return gone;
  }

  /** Tạm dừng (running thì không dừng giữa chừng — chỉ đổi trạng thái chờ). */
  pause(id: string, now: number = Date.now()): DurableAutomationV2 {
    const a = this.require(id);
    a.status = 'paused';
    a.updatedAt = now;
    this.addTrace(a, 'paused', a.attempt, 'Automation tạm dừng (user).', now);
    this.persist();
    return this.copy(a);
  }

  /** Bật lại automation đã pause/dead-letter (dead-letter thì reset attempt/fail). */
  resumeManual(id: string, now: number = Date.now()): DurableAutomationV2 {
    const a = this.require(id);
    const wasDead = a.status === 'dead-letter';
    if (wasDead) {
      a.attempt = 0;
      a.consecutiveFailures = 0;
      a.lastError = null;
    }
    a.status = 'idle';
    a.nextRunAt = a.trigger.kind === 'schedule' ? now + a.trigger.intervalMs : null;
    a.updatedAt = now;
    this.addTrace(a, 'resumed-manual', a.attempt, wasDead ? 'Bật lại từ dead-letter (reset số lần thử).' : 'Bật lại automation.', now);
    this.persist();
    return this.copy(a);
  }

  // -- Trigger ------------------------------------------------------------

  /** Automation tới hạn chạy theo lịch (idle/waiting-retry, nextRunAt <= now). */
  dueAutomations(now: number = Date.now()): DurableAutomationV2[] {
    return this.list().filter(
      (a) =>
        (a.status === 'idle' || a.status === 'waiting-retry') &&
        a.trigger.kind === 'schedule' &&
        a.nextRunAt !== null &&
        a.nextRunAt <= now,
    );
  }

  /** Automation khớp event (không paused/dead-letter, không đang chạy). */
  automationsForEvent(event: string): DurableAutomationV2[] {
    return this.list().filter(
      (a) =>
        a.trigger.kind === 'event' &&
        (a.status === 'idle' || a.status === 'waiting-retry') &&
        matchAutomationV2Event(a.trigger.eventPattern, event),
    );
  }

  // -- Chạy + ghi trace ----------------------------------------------------

  /**
   * Chạy 1 automation qua executor (host gọi): ghi trace started, rồi
   * success (reset fail, hẹn lịch tiếp) hoặc failure (retry backoff /
   * dead-letter khi hết lần). Throw lại lỗi của executor để host biết.
   */
  async runOne(id: string, executor: AutomationV2Executor, now: number = Date.now()): Promise<void> {
    const a = this.require(id);
    if (a.status === 'paused' || a.status === 'dead-letter') {
      throw new Error(`Automation "${id}" đang ${a.status}, không chạy được.`);
    }
    if (a.status === 'running') {
      throw new Error(`Automation "${id}" đang chạy — không chạy trùng.`);
    }
    a.status = 'running';
    a.attempt += 1;
    a.totalRuns += 1;
    a.lastRunAt = now;
    a.updatedAt = now;
    this.addTrace(a, 'started', a.attempt, `Bắt đầu chạy lần thử ${a.attempt} (bot ${a.action.botId}).`, now);
    this.persist();
    try {
      await executor(this.copy(a), a.attempt);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.recordFailure(a, message, now);
      this.persist();
      throw err;
    }
    this.recordSuccess(a, now);
    this.persist();
  }

  /** Chạy mọi automation tới hạn lịch (lần lượt, lỗi 1 cái không chặn cái sau). */
  async runDue(executor: AutomationV2Executor, now: number = Date.now()): Promise<{ run: number; succeeded: number; failed: number }> {
    const due = this.dueAutomations(now);
    let succeeded = 0;
    let failed = 0;
    for (const a of due) {
      try {
        await this.runOne(a.id, executor, now);
        succeeded += 1;
      } catch {
        failed += 1;
      }
    }
    return { run: due.length, succeeded, failed };
  }

  /** Kích hoạt automation theo event (chạy ngay qua executor, không đợi lịch). */
  async fireEvent(event: string, executor: AutomationV2Executor, now: number = Date.now()): Promise<{ matched: number; succeeded: number; failed: number }> {
    const matched = this.automationsForEvent(event);
    let succeeded = 0;
    let failed = 0;
    for (const a of matched) {
      try {
        await this.runOne(a.id, executor, now);
        succeeded += 1;
      } catch {
        failed += 1;
      }
    }
    return { matched: matched.length, succeeded, failed };
  }

  // -- Resume sau crash ----------------------------------------------------

  /**
   * Resume sau crash/restart: automation nào đang `running` lúc load thì
   * app đã chết giữa chừng — đánh dấu interrupted, ghi trace resume,
   * xếp chạy lại ngay (attempt giữ nguyên để backoff tính tiếp; nếu đã
   * hết lần thử → dead-letter, không chạy lại mù). Trả về id các automation
   * được resume + id bị đưa vào dead-letter. Constructor đã gọi sẵn khi
   * load từ disk; host gọi lại sau khi tự khôi phục snapshot cũng được.
   */
  resumeAfterCrash(now: number = Date.now()): { resumed: string[]; deadLettered: string[] } {
    const resumed: string[] = [];
    const deadLettered: string[] = [];
    for (const a of this.automations.values()) {
      if (a.status !== 'running') continue;
      if (a.attempt >= a.maxAttempts) {
        a.status = 'dead-letter';
        a.lastError = 'App crash khi đang chạy lần thử cuối — chuyển dead-letter, không retry nữa.';
        a.updatedAt = now;
        this.addTrace(a, 'dead-letter', a.attempt, 'Resume sau crash: đã hết lần thử, chuyển dead-letter.', now);
        deadLettered.push(a.id);
      } else {
        a.status = 'waiting-retry';
        a.nextRunAt = now;
        a.updatedAt = now;
        this.addTrace(a, 'resumed', a.attempt, `Resume sau crash/restart: lần chạy ${a.attempt} bị gián đoạn, xếp chạy lại ngay.`, now);
        resumed.push(a.id);
      }
    }
    if (resumed.length > 0 || deadLettered.length > 0) this.persist();
    return { resumed, deadLettered };
  }

  // -- Snapshot / persistence ----------------------------------------------

  /** Snapshot JSON (để host lưu chỗ khác). */
  serialize(): AutomationV2Snapshot {
    return { version: 2, automations: this.list() };
  }

  /** Tóm tắt store (cho dashboard). */
  summarize(): {
    total: number;
    idle: number;
    running: number;
    waitingRetry: number;
    deadLetter: number;
    paused: number;
    totalRuns: number;
    totalSuccesses: number;
    failingConsecutively: string[];
  } {
    const list = this.list();
    return {
      total: list.length,
      idle: list.filter((a) => a.status === 'idle').length,
      running: list.filter((a) => a.status === 'running').length,
      waitingRetry: list.filter((a) => a.status === 'waiting-retry').length,
      deadLetter: list.filter((a) => a.status === 'dead-letter').length,
      paused: list.filter((a) => a.status === 'paused').length,
      totalRuns: list.reduce((s, a) => s + a.totalRuns, 0),
      totalSuccesses: list.reduce((s, a) => s + a.totalSuccesses, 0),
      failingConsecutively: list.filter((a) => a.consecutiveFailures >= 2).map((a) => a.id),
    };
  }

  get size(): number {
    return this.automations.size;
  }

  // -- Nội bộ ---------------------------------------------------------------

  private require(id: string): DurableAutomationV2 {
    const a = this.automations.get(id);
    if (!a) throw new Error(`Automation "${id}" không tồn tại.`);
    return a;
  }

  private copy(a: DurableAutomationV2): DurableAutomationV2 {
    return { ...a, trigger: { ...a.trigger }, action: { ...a.action }, traces: [...a.traces] };
  }

  private addTrace(a: DurableAutomationV2, kind: string, attempt: number, message: string, now: number): void {
    this.traceCounter += 1;
    a.traces.push({ id: `tr-${this.traceCounter}`, automationId: a.id, kind, attempt, message, at: now });
    while (a.traces.length > AUTOMATION_V2_MAX_TRACES) a.traces.shift();
  }

  private recordSuccess(a: DurableAutomationV2, now: number): void {
    a.status = 'idle';
    a.consecutiveFailures = 0;
    a.totalSuccesses += 1;
    a.lastSuccessAt = now;
    a.lastError = null;
    a.attempt = 0;
    a.updatedAt = now;
    a.nextRunAt = a.trigger.kind === 'schedule' ? now + a.trigger.intervalMs : null;
    this.addTrace(a, 'succeeded', a.totalRuns, 'Chạy thành công.', now);
  }

  private recordFailure(a: DurableAutomationV2, message: string, now: number): void {
    a.consecutiveFailures += 1;
    a.lastError = message;
    a.updatedAt = now;
    if (a.attempt >= a.maxAttempts) {
      a.status = 'dead-letter';
      a.nextRunAt = null;
      this.addTrace(a, 'dead-letter', a.attempt, `Thất bại lần ${a.attempt}/${a.maxAttempts} — chuyển dead-letter: ${message}`, now);
    } else {
      a.status = 'waiting-retry';
      const nextRetry = automationV2NextRetryAt(a.attempt, a.baseBackoffMs, a.maxBackoffMs, now);
      a.nextRunAt = nextRetry;
      this.addTrace(a, 'failed', a.attempt, `Thất bại lần ${a.attempt}/${a.maxAttempts}: ${message}`, now);
      this.addTrace(
        a,
        'retry-scheduled',
        a.attempt,
        `Hẹn chạy lại sau ${nextRetry - now}ms (backoff).`,
        now,
      );
    }
  }

  /** Ghi file atomic (tmp + rename) — crash giữa chừng không làm hỏng file chính. */
  private persist(): void {
    if (!this.filePath) return;
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true });
    const tmpPath = `${this.filePath}.tmp-${process.pid}`;
    fs.writeFileSync(tmpPath, JSON.stringify(this.serialize(), null, 2), 'utf8');
    fs.renameSync(tmpPath, this.filePath);
  }

  /** Load từ disk (kèm resume sau crash cho automation đang running). */
  private loadFromDisk(now: number): void {
    if (!this.filePath) return;
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8');
      const snapshot = JSON.parse(raw) as AutomationV2Snapshot;
      if (snapshot.version !== 2 || !Array.isArray(snapshot.automations)) return;
      for (const a of snapshot.automations) {
        if (typeof a.id === 'string') {
          this.automations.set(a.id, { ...a, traces: [...(a.traces ?? [])] });
        }
      }
      this.resumeAfterCrash(now);
    } catch {
      // File hỏng → bắt đầu store trống thay vì crash app; file cũ giữ nguyên
      // để host điều tra (không ghi đè cho tới lần persist tiếp theo).
      this.automations.clear();
    }
  }
}

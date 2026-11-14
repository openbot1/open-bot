/**
 * MRTR elicitation — phía server (v1.05, sóng T2).
 *
 * `mrtrElicitation.ts` là phía client (state machine
 * pending → input_required → responded/timeout/cancelled).
 * Module này là nửa còn lại phía server: một tool handler dài
 * cần hỏi user giữa chừng thì không block — nó trả
 * `needs_elicitation` cho client, giữ round state trong một
 * session, và resume khi client gửi follow-up với
 * `inputResponses`:
 *
 *   1. Handler gọi `session.requestElicitation(prompt, schema)` →
 *      nhận result `needs_elicitation` để trả cho client (round N).
 *   2. Client hỏi user rồi gọi lại cùng method với
 *      `_meta.roundTrip` + `answer` (xem `mrtr.ts:
 *      buildMrtrFollowUpParams`).
 *   3. Server gọi `session.resumeWithAnswer(answer)` → validate
 *      answer theo schema (qua `elicitation.ts:
 *      validateElicitedContent`) → trả `{ done: false }` (handler
 *      chạy tiếp, có thể hỏi vòng khác) hoặc handler tự trả
 *      `complete` ở round sau.
 *   4. Session có TTL (mặc định 10 phút): quá hạn thì
 *      `resumeWithAnswer` ném `MrtrServerError` rõ ràng thay vì
 *      resume một round đã chết; `sweepExpired()` dọn định kỳ.
 *   5. `MrtrServerSessionStore` giữ nhiều session (một server có
 *      thể có nhiều tool đang hỏi user cùng lúc), cap số lượng,
 *      evict session cũ nhất khi đầy.
 *
 * Module không chạm mạng, không gọi model, không hỏi user — nó chỉ
 * giữ state và validate. Không copy code từ SDK MCP nào.
 */

import {
  buildMrtrResult,
  type MrtrNeed,
  type MrtrResultType,
} from './mrtr';
import {
  parseElicitationSchema,
  validateElicitedContent,
  type ElicitationFormField,
} from './elicitation';

/** TTL mặc định của một MRTR server session (10 phút). */
export const DEFAULT_MRTR_SERVER_SESSION_TTL_MS = 10 * 60_000;
/** Số session tối đa một store giữ (mặc định). */
export const DEFAULT_MRTR_SERVER_MAX_SESSIONS = 100;

export class MrtrServerError extends Error {
  readonly roundTripId?: string;
  readonly round?: number;
  constructor(message: string, roundTripId?: string, round?: number) {
    super(message);
    this.name = 'MrtrServerError';
    if (roundTripId) this.roundTripId = roundTripId;
    if (round !== undefined) this.round = round;
  }
}

/** Trạng thái của một MRTR server session. */
export type MrtrServerSessionState =
  | 'active'
  | 'waiting_elicitation'
  | 'completed'
  | 'expired'
  | 'cancelled';

/** Một vòng elicitation server đã hỏi (log / debug). */
export interface MrtrServerRoundRecord {
  round: number;
  prompt: string;
  /** Schema đã gửi (JSON Schema thô). */
  schema?: Record<string, unknown>;
  /** Answer client trả (khi đã có). */
  answer?: Record<string, unknown>;
  /** Khi nào vòng này được hỏi (ms epoch). */
  askedAtMs: number;
  /** Khi nào client trả lời (ms epoch, khi có). */
  answeredAtMs?: number;
}

/** Tuỳ chọn khi tạo MrtrServerSession. */
export interface MrtrServerSessionOptions {
  /** TTL session (ms) — quá hạn thì resume bị từ chối. */
  ttlMs?: number;
  /** Clock injection cho test. */
  nowMs?: () => number;
  /** Id round-trip do caller cấp (mặc định random). */
  roundTripId?: string;
}

/** Kết quả resume một session với answer của client. */
export interface MrtrServerResumeOutcome {
  /** Answer đã validate (object sạch — key lạ đã loại). */
  content: Record<string, unknown>;
  /** Round vừa trả lời. */
  round: number;
  /** Mọi answer đã nhận từ đầu session (theo round). */
  allAnswers: Record<number, Record<string, unknown>>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function randomRoundTripId(method: string): string {
  const rand = Math.random().toString(36).slice(2, 10);
  return `mrtr-${method}-${Date.now().toString(36)}-${rand}`;
}

/**
 * Một phiên MRTR phía server cho một lần gọi method: giữ method +
 * params gốc, các vòng elicitation đã hỏi, và answer đã nhận.
 * Handler dùng session này qua các round thay vì giữ state trong
 * closure (stateless: server khác vẫn resume được từ roundTripId +
 * answer, vì mọi thứ cần thiết nằm trong session record).
 */
export class MrtrServerSession {
  readonly roundTripId: string;
  readonly method: string;
  readonly params: Record<string, unknown>;
  readonly createdAtMs: number;
  readonly expiresAtMs: number;
  private readonly ttlMs: number;
  private readonly nowMs: () => number;
  private state: MrtrServerSessionState = 'active';
  private round = 0;
  private readonly rounds: MrtrServerRoundRecord[] = [];
  private readonly answers = new Map<number, Record<string, unknown>>();

  constructor(
    method: string,
    params: Record<string, unknown> = {},
    options: MrtrServerSessionOptions = {},
  ) {
    if (typeof method !== 'string' || method.length === 0) {
      throw new MrtrServerError('MrtrServerSession cần method là chuỗi không rỗng.');
    }
    this.method = method;
    this.params = { ...params };
    this.nowMs = options.nowMs ?? Date.now;
    this.ttlMs = options.ttlMs ?? DEFAULT_MRTR_SERVER_SESSION_TTL_MS;
    this.roundTripId = options.roundTripId ?? randomRoundTripId(method);
    this.createdAtMs = this.nowMs();
    this.expiresAtMs = this.createdAtMs + this.ttlMs;
  }

  /** Trạng thái hiện tại. */
  get currentState(): MrtrServerSessionState {
    return this.state;
  }

  /** Round hiện tại (0 = chưa hỏi vòng nào). */
  get currentRound(): number {
    return this.round;
  }

  /** True khi session đã hết hạn (theo TTL). */
  get isExpired(): boolean {
    return this.nowMs() > this.expiresAtMs;
  }

  /** True khi session còn resume được. */
  get isResumable(): boolean {
    return (
      (this.state === 'active' || this.state === 'waiting_elicitation') && !this.isExpired
    );
  }

  /** Lịch sử các vòng (copy). */
  get roundHistory(): MrtrServerRoundRecord[] {
    return this.rounds.map((r) => ({ ...r }));
  }

  /**
   * Hỏi user một vòng elicitation: trả result `needs_elicitation`
   * để handler trả thẳng cho client (round N+1). Schema được parse
   * ngay ở đây — schema sai thì ném lỗi trước khi client thấy câu
   * hỏi dởm. Session chuyển sang `waiting_elicitation`.
   */
  requestElicitation(
    prompt: string,
    schema: Record<string, unknown>,
    options: { note?: string } = {},
  ): Record<string, unknown> {
    this.assertResumable();
    if (typeof prompt !== 'string' || prompt.trim().length === 0) {
      throw new MrtrServerError('requestElicitation cần prompt là chuỗi không rỗng.', this.roundTripId, this.round + 1);
    }
    let fields: ElicitationFormField[];
    try {
      fields = parseElicitationSchema(schema);
    } catch (err) {
      throw new MrtrServerError(
        `Schema elicitation vòng ${this.round + 1} không hợp lệ: ${(err as Error).message}`,
        this.roundTripId,
        this.round + 1,
      );
    }
    if (fields.length === 0) {
      throw new MrtrServerError(
        `Schema elicitation vòng ${this.round + 1} không có field nào — client không có gì để điền.`,
        this.roundTripId,
        this.round + 1,
      );
    }
    this.round += 1;
    this.state = 'waiting_elicitation';
    this.rounds.push({
      round: this.round,
      prompt: prompt.trim(),
      schema: { ...schema },
      askedAtMs: this.nowMs(),
    });
    return buildMrtrResult('needs_elicitation', {
      need: { prompt: prompt.trim(), schema: { ...schema } },
      roundTripId: this.roundTripId,
      ...(options.note ? { note: options.note } : {}),
    });
  }

  /**
   * Resume session với answer client gửi trong follow-up round.
   * Answer phải là `{ action, content }` (xem `mrtrElicitation.ts`):
   *  - `action: 'accept'` → validate content theo schema vòng
   *    đang chờ, lưu lại, session về `active`.
   *  - `action: 'decline'` → ném `MrtrServerError` để handler
   *    tự quyết (thường là fail task với lỗi rõ ràng).
   *  - `action: 'cancel'` → session chuyển `cancelled`, ném lỗi.
   *  - Answer không phải object / thiếu action → ném lỗi.
   */
  resumeWithAnswer(answer: unknown): MrtrServerResumeOutcome {
    this.assertResumable();
    if (this.state !== 'waiting_elicitation') {
      throw new MrtrServerError(
        `Session ${this.roundTripId} đang ở trạng thái "${this.state}" — không chờ answer.`,
        this.roundTripId,
        this.round,
      );
    }
    if (!isRecord(answer)) {
      throw new MrtrServerError(
        `Answer elicitation vòng ${this.round} phải là một object { action, content }.`,
        this.roundTripId,
        this.round,
      );
    }
    const action = answer['action'];
    if (action === 'cancel') {
      this.state = 'cancelled';
      throw new MrtrServerError(
        `Người dùng huỷ elicitation ở vòng ${this.round}.`,
        this.roundTripId,
        this.round,
      );
    }
    if (action === 'decline') {
      this.state = 'active';
      throw new MrtrServerError(
        `Người dùng từ chối elicitation ở vòng ${this.round} — handler nên dừng task.`,
        this.roundTripId,
        this.round,
      );
    }
    if (action !== 'accept') {
      throw new MrtrServerError(
        `Answer elicitation vòng ${this.round} có action không hợp lệ: ${JSON.stringify(action)} (chỉ accept / decline / cancel).`,
        this.roundTripId,
        this.round,
      );
    }
    const record = this.rounds[this.rounds.length - 1];
    if (!record) {
      throw new MrtrServerError(
        `Session ${this.roundTripId} không có vòng nào đang chờ.`,
        this.roundTripId,
        this.round,
      );
    }
    let fields: ElicitationFormField[];
    try {
      fields = parseElicitationSchema(record.schema ?? { type: 'object', properties: {} });
    } catch (err) {
      throw new MrtrServerError(
        `Schema vòng ${this.round} không parse được khi resume: ${(err as Error).message}`,
        this.roundTripId,
        this.round,
      );
    }
    let content: Record<string, unknown>;
    try {
      content = validateElicitedContent(fields, answer['content'] ?? {});
    } catch (err) {
      throw new MrtrServerError(
        `Answer elicitation vòng ${this.round} sai validate: ${(err as Error).message} — client cần hỏi lại user.`,
        this.roundTripId,
        this.round,
      );
    }
    record.answer = { ...content };
    record.answeredAtMs = this.nowMs();
    this.answers.set(this.round, { ...content });
    this.state = 'active';
    const allAnswers: Record<number, Record<string, unknown>> = {};
    for (const [round, value] of this.answers) allAnswers[round] = { ...value };
    return { content, round: this.round, allAnswers };
  }

  /** Build result `complete` cho round cuối (handler trả cho client). */
  complete(result: unknown, note?: string): Record<string, unknown> {
    this.assertResumable();
    this.state = 'completed';
    return buildMrtrResult('complete', {
      result,
      roundTripId: this.roundTripId,
      ...(note ? { note } : {}),
    });
  }

  /** Huỷ session (handler bỏ dở / client huỷ task). */
  cancel(reason = 'MRTR server session đã bị huỷ.'): void {
    if (this.state === 'completed' || this.state === 'expired' || this.state === 'cancelled') return;
    this.state = 'cancelled';
    void reason;
  }

  /** Đánh dấu hết hạn (store gọi khi sweep). */
  markExpired(): void {
    if (this.state === 'active' || this.state === 'waiting_elicitation') {
      this.state = 'expired';
    }
  }

  private assertResumable(): void {
    if (this.isExpired) {
      this.markExpired();
      throw new MrtrServerError(
        `MRTR session ${this.roundTripId} đã hết hạn (TTL ${this.ttlMs}ms) — client cần gọi lại từ đầu.`,
        this.roundTripId,
        this.round,
      );
    }
    if (this.state === 'completed' || this.state === 'expired' || this.state === 'cancelled') {
      throw new MrtrServerError(
        `MRTR session ${this.roundTripId} đã ở trạng thái cuối "${this.state}" — không resume được.`,
        this.roundTripId,
        this.round,
      );
    }
  }
}

/** Tuỳ chọn cho MrtrServerSessionStore. */
export interface MrtrServerSessionStoreOptions {
  /** Số session tối đa (mặc định 100). */
  maxSessions?: number;
  /** TTL mặc định cho session mới (ms). */
  ttlMs?: number;
  /** Clock injection cho test. */
  nowMs?: () => number;
}

/**
 * Store các MRTR server session đang chạy: tạo / lấy theo
 * roundTripId / dọn hết hạn. Cap số lượng — khi đầy thì evict
 * session cũ nhất (theo createdAtMs) thay vì tăng vô hạn.
 */
export class MrtrServerSessionStore {
  private readonly sessions = new Map<string, MrtrServerSession>();
  private readonly maxSessions: number;
  private readonly ttlMs: number;
  private readonly nowMs: () => number;

  constructor(options: MrtrServerSessionStoreOptions = {}) {
    this.maxSessions = Math.max(1, options.maxSessions ?? DEFAULT_MRTR_SERVER_MAX_SESSIONS);
    this.ttlMs = options.ttlMs ?? DEFAULT_MRTR_SERVER_SESSION_TTL_MS;
    this.nowMs = options.nowMs ?? Date.now;
  }

  /** Số session đang giữ. */
  get size(): number {
    return this.sessions.size;
  }

  /**
   * Tạo session mới cho một lần gọi method. Khi store đầy, evict
   * session cũ nhất (kể cả đang active — caller nhận session mới
   * và session cũ sẽ báo hết hạn khi resume).
   */
  create(
    method: string,
    params: Record<string, unknown> = {},
    options: MrtrServerSessionOptions = {},
  ): MrtrServerSession {
    this.sweepExpired();
    if (this.sessions.size >= this.maxSessions) {
      const oldest = [...this.sessions.values()].sort(
        (a, b) => a.createdAtMs - b.createdAtMs,
      )[0];
      if (oldest) {
        oldest.cancel('Evicted: MRTR session store đã đầy.');
        this.sessions.delete(oldest.roundTripId);
      }
    }
    const session = new MrtrServerSession(method, params, {
      ttlMs: options.ttlMs ?? this.ttlMs,
      nowMs: this.nowMs,
      ...(options.roundTripId ? { roundTripId: options.roundTripId } : {}),
    });
    this.sessions.set(session.roundTripId, session);
    return session;
  }

  /** Lấy session theo roundTripId (undefined khi không có / đã hết hạn). */
  get(roundTripId: string): MrtrServerSession | undefined {
    const session = this.sessions.get(roundTripId);
    if (!session) return undefined;
    if (session.isExpired) {
      session.markExpired();
      this.sessions.delete(roundTripId);
      return undefined;
    }
    return session;
  }

  /** Lấy session hoặc ném MrtrServerError rõ ràng. */
  getOrThrow(roundTripId: string): MrtrServerSession {
    const session = this.get(roundTripId);
    if (!session) {
      throw new MrtrServerError(`Không có MRTR session "${roundTripId}" (không tồn tại hoặc đã hết hạn).`, roundTripId);
    }
    return session;
  }

  /** Xoá một session (khi handler xong / huỷ). */
  remove(roundTripId: string): boolean {
    return this.sessions.delete(roundTripId);
  }

  /** Dọn session hết hạn. Trả số lượng đã dọn. */
  sweepExpired(nowMs: number = this.nowMs()): number {
    let removed = 0;
    for (const [id, session] of this.sessions) {
      if (session.expiresAtMs <= nowMs) {
        session.markExpired();
        this.sessions.delete(id);
        removed += 1;
      }
    }
    return removed;
  }
}

/**
 * Parse một follow-up request của client (round N+1): lấy
 * roundTripId + answer từ params. Trả null khi không phải
 * follow-up MRTR (thiếu roundTripId) — caller coi như request
 * mới, không phải resume.
 */
export function parseMrtrFollowUp(
  params: unknown,
): { roundTripId: string; round: number; answer: unknown } | null {
  if (!isRecord(params)) return null;
  const roundTripId = params['roundTripId'];
  if (typeof roundTripId !== 'string' || roundTripId.length === 0) return null;
  const round = typeof params['round'] === 'number' ? (params['round'] as number) : 1;
  return { roundTripId, round, answer: params['answer'] };
}

/** Kiểu result MRTR (re-export để handler không import lẻ). */
export type { MrtrNeed, MrtrResultType };

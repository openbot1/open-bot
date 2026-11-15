/**
 * MRTR elicitation — Multi Round-Trip Requests cho elicitation
 * (v1.05, sóng T2).
 *
 * Spec 2026-07-28 bỏ `elicitation/create` dạng server-initiated
 * callback (xem `deprecation.ts`: deprecated từ 2026-07-28, thay
 * bằng MRTR `needs_elicitation`). Module `elicitation.ts` vẫn giữ
 * parse/validate form + URL-mode cho server cũ; module này là lớp
 * MRTR phía client:
 *
 *   - `MrtrElicitationSession`: state machine đầy đủ cho một lượt
 *     elicitation chạy qua MRTR:
 *       `pending` → `input_required` → `responded`
 *                                    → `timeout` / `cancelled`
 *     Server trả `needs_elicitation` (round 1) → session hỏi user
 *     (qua `ElicitationPrompt` đã có trong `elicitation.ts`, form
 *     validate bằng `validateElicitedContent`) → gửi lại bằng
 *     follow-up request (`inputResponses`) → server trả `complete`
 *     hoặc lại `needs_elicitation` (hỏi tiếp vòng khác).
 *   - Timeout: mỗi vòng chờ user có timeout riêng
 *     (`promptTimeoutMs`); hết timeout → state `timeout`, session
 *     ném `MrtrElicitationError` rõ ràng thay vì treo. Toàn bộ
 *     session cũng có `overallTimeoutMs`.
 *   - Retry: user điền sai validate (vd thiếu field bắt buộc) →
 *     session hỏi lại tối đa `maxValidationRetries` lần rồi mới
 *     fail; mỗi lần retry vẫn là một round MRTR mới (server thấy
 *     `round` tăng trong `_meta.roundTrip`).
 *   - URL-mode: server hỏi URL thì session trả `accept` ngay và
 *     theo dõi `notifications/elicitation/complete` qua
 *     `ElicitationUrlTracker` đã có (không chờ trong MRTR round —
 *     round kết thúc khi user mở URL, completion báo sau).
 *
 * Module không chạm UI thật và không chạm mạng: prompt do caller
 * inject, transport là `MrtrTransport` của `mrtr.ts` (fake trong
 * test). Không copy code từ SDK MCP nào.
 */

import {
  ElicitationError,
  ElicitationUrlTracker,
  createElicitationHandler,
  handleElicitationRequest,
  isSensitiveElicitationField,
  parseElicitationRequest,
  validateElicitedContent,
  type ElicitResult,
  type ElicitationPrompt,
  type ElicitationRequest,
} from './elicitation';
import {
  MCP_MRTR_MAX_ROUNDS_DEFAULT,
  MrtrError,
  runMultiRoundTrip,
  type MrtrCallOutcome,
  type MrtrHandlers,
  type MrtrNeed,
  type MrtrResultType,
  type MrtrTransport,
} from './mrtr';

/** Trạng thái của một MRTR elicitation session. */
export type MrtrElicitationState =
  | 'pending'
  | 'input_required'
  | 'responded'
  | 'timeout'
  | 'cancelled';

/** Các trạng thái cuối — session không chuyển tiếp được nữa. */
export const MRTR_ELICITATION_TERMINAL_STATES: readonly MrtrElicitationState[] = [
  'responded',
  'timeout',
  'cancelled',
];

export function isMrtrElicitationTerminal(state: MrtrElicitationState): boolean {
  return (MRTR_ELICITATION_TERMINAL_STATES as readonly MrtrElicitationState[]).includes(state);
}

/** Timeout mặc định chờ user trả lời một vòng elicitation (2 phút). */
export const DEFAULT_MRTR_ELICITATION_PROMPT_TIMEOUT_MS = 2 * 60_000;
/** Timeout mặc định cho toàn bộ session (10 phút). */
export const DEFAULT_MRTR_ELICITATION_OVERALL_TIMEOUT_MS = 10 * 60_000;
/** Số lần hỏi lại tối đa khi user điền sai validate. */
export const DEFAULT_MRTR_ELICITATION_MAX_VALIDATION_RETRIES = 2;

export class MrtrElicitationError extends Error {
  readonly state?: MrtrElicitationState;
  readonly round?: number;
  constructor(message: string, state?: MrtrElicitationState, round?: number) {
    super(message);
    this.name = 'MrtrElicitationError';
    if (state) this.state = state;
    if (round !== undefined) this.round = round;
  }
}

/** Một vòng elicitation đã diễn ra (log / activity feed). */
export interface MrtrElicitationRoundRecord {
  round: number;
  state: MrtrElicitationState;
  /** Câu hỏi server gửi ở vòng này. */
  prompt?: string;
  /** Action user trả lời (accept / decline / cancel). */
  action?: ElicitResult['action'];
  /** Lỗi validate ở vòng này (khi retry). */
  validationError?: string;
  /** Khi nào vòng này kết thúc (ms epoch). */
  atMs: number;
}

/** Tuỳ chọn cho một MrtrElicitationSession. */
export interface MrtrElicitationOptions {
  /** Timeout chờ user trả lời mỗi vòng (ms). */
  promptTimeoutMs?: number;
  /** Timeout toàn bộ session (ms). */
  overallTimeoutMs?: number;
  /** Số lần hỏi lại tối đa khi validate fail. */
  maxValidationRetries?: number;
  /** Số round MRTR tối đa (mặc định 8, xem mrtr.ts). */
  maxRounds?: number;
  /** Theo dõi URL-mode completion (khi server hỏi URL). */
  urlTracker?: ElicitationUrlTracker;
  /** Timeout chờ URL-mode completion (mặc định 10 phút, xem elicitation.ts). */
  urlCompletionTimeoutMs?: number;
  /** Signal huỷ từ bên ngoài (đóng modal / huỷ task). */
  signal?: AbortSignal;
  /** Gọi mỗi khi state đổi (UI cập nhật). */
  onStateChange?: (state: MrtrElicitationState, round: number) => void;
  /** Gọi sau mỗi vòng (log / activity feed). */
  onRound?: (record: MrtrElicitationRoundRecord) => void;
  /** Clock injection cho test. */
  nowMs?: () => number;
}

/** Kết quả một session elicitation chạy xong. */
export interface MrtrElicitationOutcome {
  /** State cuối (responded / timeout / cancelled). */
  state: MrtrElicitationState;
  /** Kết quả cuối server trả ở round `complete` (khi responded). */
  result?: unknown;
  /** Số round MRTR đã chạy. */
  rounds: number;
  /** Id round-trip server cấp (khi có). */
  roundTripId?: string;
  /** Lịch sử các vòng. */
  history: MrtrElicitationRoundRecord[];
}

/**
 * Chuyển một `MrtrNeed` dạng `needs_elicitation` thành
 * `ElicitationRequest` để `elicitation.ts` parse/validate được.
 * `need.schema` là JSON Schema form; `need.detail.url` (khi có)
 * nghĩa là URL-mode; `need.prompt` là message.
 */
export function mrtrNeedToElicitationRequest(
  need: MrtrNeed,
  serverName: string,
): ElicitationRequest {
  const detail = need.detail ?? {};
  const url = typeof detail['url'] === 'string' ? (detail['url'] as string) : undefined;
  if (url !== undefined) {
    return parseElicitationRequest(
      { message: need.prompt ?? 'Server yêu cầu xác nhận qua URL.', mode: 'url', url },
      serverName,
    );
  }
  return parseElicitationRequest(
    {
      message: need.prompt ?? 'Server cần thêm thông tin.',
      mode: 'form',
      requestedSchema: need.schema ?? { type: 'object', properties: {} },
    },
    serverName,
  );
}

/**
 * Build `MrtrHandlers.onNeedsElicitation` từ một `ElicitationPrompt`
 * (UI modal / hàm hỏi user): parse need → hỏi user → validate
 * content → trả về. Validate fail thì ném `ElicitationError` để
 * driver MRTR dừng với lỗi rõ ràng (không gửi content sai lên
 * server).
 */
export function buildMrtrElicitationHandler(
  prompt: ElicitationPrompt,
  serverName: string,
  options: { signal?: AbortSignal; urlTracker?: ElicitationUrlTracker } = {},
): MrtrHandlers['onNeedsElicitation'] {
  return async (need: MrtrNeed, _round: number) => {
    const request = mrtrNeedToElicitationRequest(need, serverName);
    const result = await handleElicitationRequest(request, prompt, options);
    if (result.action !== 'accept') {
      // decline / cancel vẫn là một câu trả lời hợp lệ: server
      // nhận action và tự quyết định tiếp (thường là fail task).
      return { action: result.action };
    }
    if (request.mode === 'form') {
      const content = validateElicitedContent(request.fields ?? [], result.content ?? {});
      return { action: 'accept', content };
    }
    return { action: 'accept' };
  };
}

/**
 * Session elicitation qua MRTR: state machine đầy đủ, timeout từng
 * vòng + toàn session, retry khi validate fail.
 *
 * Cách dùng:
 * ```
 * const session = new MrtrElicitationSession(transport, {
 *   serverName: 'acme', prompt: askUserViaModal, maxRounds: 8,
 * });
 * const outcome = await session.run('tools/call', { name, arguments });
 * // outcome.state === 'responded' → outcome.result là kết quả cuối
 * ```
 */
export class MrtrElicitationSession {
  private readonly transport: MrtrTransport;
  private readonly serverName: string;
  private readonly prompt: ElicitationPrompt;
  private readonly options: MrtrElicitationOptions;
  private readonly nowMs: () => number;
  private state: MrtrElicitationState = 'pending';
  private readonly history: MrtrElicitationRoundRecord[] = [];
  private abortController: AbortController | null = null;

  constructor(
    transport: MrtrTransport,
    options: MrtrElicitationOptions & {
      serverName: string;
      prompt: ElicitationPrompt;
    },
  ) {
    this.transport = transport;
    this.serverName = options.serverName;
    this.prompt = options.prompt;
    this.options = options;
    this.nowMs = options.nowMs ?? Date.now;
  }

  /** Trạng thái hiện tại. */
  get currentState(): MrtrElicitationState {
    return this.state;
  }

  /** Lịch sử các vòng đã chạy (copy). */
  get rounds(): MrtrElicitationRoundRecord[] {
    return [...this.history];
  }

  /** Huỷ session từ bên ngoài (user đóng modal / huỷ task). */
  cancel(reason = 'Elicitation session đã bị huỷ'): void {
    if (isMrtrElicitationTerminal(this.state)) return;
    this.setState('cancelled', this.history.length + 1);
    this.abortController?.abort(new Error(reason));
  }

  /**
   * Chạy một method qua MRTR, trả lời mọi vòng `needs_elicitation`
   * bằng prompt. Các vòng `needs_*` khác (input / sampling / roots
   * / confirmation) đi qua `extraHandlers` khi caller cung cấp —
   * không có handler thì driver ném `MrtrError` như thường lệ.
   */
  async run(
    method: string,
    params: Record<string, unknown> = {},
    extraHandlers: Omit<MrtrHandlers, 'onNeedsElicitation'> = {},
  ): Promise<MrtrElicitationOutcome> {
    if (isMrtrElicitationTerminal(this.state) && this.state !== 'pending') {
      throw new MrtrElicitationError(
        `Elicitation session đã ở trạng thái cuối "${this.state}" — không chạy lại được.`,
        this.state,
      );
    }
    const promptTimeoutMs =
      this.options.promptTimeoutMs ?? DEFAULT_MRTR_ELICITATION_PROMPT_TIMEOUT_MS;
    const overallTimeoutMs =
      this.options.overallTimeoutMs ?? DEFAULT_MRTR_ELICITATION_OVERALL_TIMEOUT_MS;
    const maxValidationRetries =
      this.options.maxValidationRetries ?? DEFAULT_MRTR_ELICITATION_MAX_VALIDATION_RETRIES;
    const maxRounds = this.options.maxRounds ?? MCP_MRTR_MAX_ROUNDS_DEFAULT;
    const outerSignal = this.options.signal;
    if (outerSignal?.aborted) {
      this.setState('cancelled', 1);
      throw new MrtrElicitationError('Elicitation session đã bị huỷ trước khi chạy.', 'cancelled');
    }

    this.abortController = new AbortController();
    const controller = this.abortController;
    const onOuterAbort = (): void => {
      controller.abort(
        outerSignal?.reason instanceof Error
          ? outerSignal.reason
          : new Error('Elicitation session đã bị huỷ.'),
      );
    };
    outerSignal?.addEventListener('abort', onOuterAbort, { once: true });

    const overallTimer = setTimeout(() => {
      controller.abort(new Error(`Elicitation session hết thời gian chờ (${overallTimeoutMs}ms).`));
    }, overallTimeoutMs);
    overallTimer.unref?.();

    // Đếm số lần validate fail liên tiếp để retry có giới hạn.
    let currentRound = 0;

    const elicitationHandler: NonNullable<MrtrHandlers['onNeedsElicitation']> = async (
      need: MrtrNeed,
      round: number,
    ) => {
      currentRound = round;
      this.setState('input_required', round);
      const request = mrtrNeedToElicitationRequest(need, this.serverName);
      const record: MrtrElicitationRoundRecord = {
        round,
        state: 'input_required',
        ...(request.message ? { prompt: request.message } : {}),
        atMs: this.nowMs(),
      };
      this.history.push(record);
      this.options.onRound?.(record);

      // Hỏi user; validate fail thì hỏi lại ngay trong cùng vòng,
      // tối đa maxValidationRetries lần. Hết timeout từng vòng →
      // state timeout (promptWithTimeout ném MrtrElicitationError).
      let lastValidationError: ElicitationError | null = null;
      for (let attempt = 0; attempt <= maxValidationRetries; attempt += 1) {
        let answer: ElicitResult | null;
        try {
          answer = await this.promptWithTimeout(request, promptTimeoutMs, controller.signal);
        } catch (err) {
          if (err instanceof ElicitationError) {
            // handleElicitationRequest validate fail (form-mode):
            // hỏi lại user, vẫn trong cùng vòng.
            lastValidationError = err;
            record.validationError = err.message;
            continue;
          }
          if ((err as Error).name === 'MrtrElicitationError') throw err;
          throw new MrtrElicitationError(
            `Elicitation vòng ${round} lỗi: ${(err as Error).message}`,
            this.state,
            round,
          );
        }
        if (answer === null || answer.action === 'cancel') {
          record.action = 'cancel';
          record.state = 'cancelled';
          this.setState('cancelled', round);
          throw new MrtrElicitationError(
            `Người dùng huỷ elicitation ở vòng ${round}.`,
            'cancelled',
            round,
          );
        }
        record.action = answer.action;
        if (answer.action !== 'accept') {
          // decline: trả action về server, session vẫn tiếp tục chờ
          // server quyết định (thường server trả complete kèm lỗi).
          return { action: answer.action };
        }
        if (request.mode === 'form') {
          try {
            const content = validateElicitedContent(request.fields ?? [], answer.content ?? {});
            return { action: 'accept', content };
          } catch (err) {
            lastValidationError = err as ElicitationError;
            record.validationError = (err as Error).message;
            continue;
          }
        }
        // URL-mode: accept ngay; completion ngoài băng do urlTracker theo dõi.
        if (request.mode === 'url' && request.elicitationId && this.options.urlTracker) {
          void this.options.urlTracker
            .waitForCompletion(request.elicitationId, {
              timeoutMs: this.options.urlCompletionTimeoutMs,
              signal: controller.signal,
            })
            .catch(() => undefined);
        }
        return { action: 'accept' };
      }
      // Hết số lần hỏi lại mà vẫn validate fail.
      throw new MrtrElicitationError(
        `Elicitation vòng ${round}: dữ liệu sai validate sau ${maxValidationRetries + 1} lần hỏi: ${
          lastValidationError?.message ?? 'không rõ nguyên nhân'
        }`,
        this.state,
        round,
      );
    };

    const handlers: MrtrHandlers = {
      ...extraHandlers,
      onNeedsElicitation: elicitationHandler,
      onRound: (rec) => {
        extraHandlers.onRound?.(rec);
      },
    };

    let outcome: MrtrCallOutcome;
    try {
      outcome = await runMultiRoundTrip(this.transport, method, params, handlers, { maxRounds });
    } catch (err) {
      clearTimeout(overallTimer);
      outerSignal?.removeEventListener('abort', onOuterAbort);
      if (controller.signal.aborted) {
        const abortedError = controller.signal.reason;
        const isTimeout =
          abortedError instanceof Error && /hết thời gian chờ/.test(abortedError.message);
        this.setState(isTimeout ? 'timeout' : 'cancelled', currentRound || 1);
        throw new MrtrElicitationError(
          isTimeout
            ? `Elicitation session hết thời gian chờ (${overallTimeoutMs}ms).`
            : `Elicitation session đã bị huỷ: ${
                abortedError instanceof Error ? abortedError.message : String(abortedError)
              }`,
          this.state,
          currentRound || undefined,
        );
      }
      if (err instanceof MrtrElicitationError) throw err;
      throw err;
    }
    clearTimeout(overallTimer);
    outerSignal?.removeEventListener('abort', onOuterAbort);
    this.setState('responded', outcome.rounds);
    return {
      state: 'responded',
      result: outcome.result,
      rounds: outcome.rounds,
      ...(outcome.roundTripId ? { roundTripId: outcome.roundTripId } : {}),
      history: this.history,
    };
  }

  private setState(state: MrtrElicitationState, round: number): void {
    this.state = state;
    this.options.onStateChange?.(state, round);
  }

  /**
   * Hỏi user với timeout từng vòng. Prompt trả null / signal abort
   * → kết quả cancel; hết timeout → ném MrtrElicitationError state
   * `timeout` (session chuyển state trước khi ném).
   */
  private async promptWithTimeout(
    request: ElicitationRequest,
    timeoutMs: number,
    signal: AbortSignal,
  ): Promise<ElicitResult | null> {
    if (signal.aborted) {
      this.setState('cancelled', this.history.length + 1);
      return null;
    }
    let timer: NodeJS.Timeout | undefined;
    try {
      const timeout = new Promise<null>((_resolve, reject) => {
        timer = setTimeout(() => {
          this.setState('timeout', this.history.length + 1);
          reject(
            new MrtrElicitationError(
              `Hết thời gian chờ user trả lời elicitation (${timeoutMs}ms).`,
              'timeout',
            ),
          );
        }, timeoutMs);
        timer.unref?.();
      });
      const aborted = new Promise<null>((resolve) => {
        signal.addEventListener('abort', () => resolve(null), { once: true });
      });
      const answer = await Promise.race([
        handleElicitationRequest(request, this.prompt, { signal }),
        timeout,
        aborted,
      ]);
      return answer;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

/**
 * Tiện ích một dòng: chạy một `tools/call` qua MRTR elicitation
 * với một prompt function. Trả outcome của session.
 */
export async function runToolCallWithElicitation(
  transport: MrtrTransport,
  toolName: string,
  args: Record<string, unknown>,
  prompt: ElicitationPrompt,
  serverName: string,
  options: MrtrElicitationOptions = {},
): Promise<MrtrElicitationOutcome> {
  const session = new MrtrElicitationSession(transport, {
    ...options,
    serverName,
    prompt,
  });
  return session.run('tools/call', { name: toolName, arguments: args });
}

/**
 * Tạo handler `elicitation/create` kiểu cũ (server-initiated) nhưng
 * chạy qua MRTR session bên dưới — shim tương thích cho server cũ
 * vẫn gọi `elicitation/create`: request được chuyển thành một
 * session MRTR một vòng (pending → input_required → responded).
 * Ghi log deprecation qua `onDeprecatedUse` khi có (xem
 * `deprecation.ts`: elicitation/create deprecated từ 2026-07-28).
 */
export function createMrtrBackedElicitationHandler(
  prompt: ElicitationPrompt,
  options: {
    serverName?: string;
    onDeprecatedUse?: (method: string) => void;
  } = {},
): (params: unknown, serverName: string) => Promise<ElicitResult> {
  const base = createElicitationHandler(prompt);
  return async (params: unknown, serverName: string) => {
    options.onDeprecatedUse?.('elicitation/create');
    return base(params, serverName || options.serverName || 'unknown');
  };
}

/** Mô tả ngắn một state, cho UI / log. */
export function describeMrtrElicitationState(state: MrtrElicitationState): string {
  switch (state) {
    case 'pending':
      return 'Đang chờ server hỏi thêm thông tin.';
    case 'input_required':
      return 'Server đang chờ người dùng nhập thông tin.';
    case 'responded':
      return 'Đã trả lời elicitation, server đang xử lý tiếp.';
    case 'timeout':
      return 'Hết thời gian chờ người dùng trả lời elicitation.';
    case 'cancelled':
      return 'Elicitation đã bị huỷ.';
  }
}

/** Kiểu kết quả MRTR (re-export để caller không import lẻ). */
export type { MrtrResultType };

// ---------------------------------------------------------------------------
// v1.06 (Đội T2): handler onNeedsElicitation + secret guard + audit —
// gộp từ bản v1.06 (cùng file, API khác, không trùng tên với section trên).
// ---------------------------------------------------------------------------

/** Lỗi khi server xin secret qua form-mode — từ chối thẳng. */
export class MrtrElicitationRefusedError extends MrtrError {
  /** Tên các field nhạy cảm đã bị từ chối (chỉ tên, không giá trị). */
  readonly refusedFields: string[];
  constructor(refusedFields: string[], round?: number) {
    super(
      `MRTR elicitation: từ chối — server xin dữ liệu nhạy cảm qua form-mode: ${refusedFields.join(', ')}. ` +
        `Mật khẩu / API key / token phải đi URL-mode (OAuth / trang của provider), không điền qua form.`,
      'needs_elicitation',
      round,
    );
    this.name = 'MrtrElicitationRefusedError';
    this.refusedFields = [...refusedFields];
  }
}

/** Loại sự kiện audit của MRTR elicitation. */
export type MrtrElicitationAuditKind =
  | 'form-accepted'
  | 'form-declined'
  | 'secret-refused'
  | 'url-opened'
  | 'url-completed'
  | 'url-timeout'
  | 'parse-error';

/** Một sự kiện audit — chỉ metadata, không giá trị user nhập. */
export interface MrtrElicitationAuditEvent {
  kind: MrtrElicitationAuditKind;
  round: number;
  serverName: string;
  mode?: 'form' | 'url';
  /** Tên field (form-mode) hoặc elicitationId (url-mode). */
  detail?: string;
  atMs: number;
}

export type MrtrElicitationAuditListener = (event: MrtrElicitationAuditEvent) => void;

/** Nguồn dữ liệu / callback cho handler MRTR elicitation. */
export interface MrtrElicitationSources {
  /** Tên server MCP đang hỏi (UI phải hiển thị rõ cho user). */
  serverName: string;
  /** Hàm hỏi user (modal / prompt). Bắt buộc. */
  prompt: ElicitationPrompt;
  /**
   * Mở URL ngoài cho URL-mode (desktop: mở trình duyệt hệ thống).
   * Không có thì URL-mode lỗi rõ ràng thay vì lặng lẽ bỏ qua.
   */
  openUrl?: (url: string) => Promise<void> | void;
  /** Tracker chờ `notifications/elicitation/complete` (URL-mode). */
  urlTracker?: ElicitationUrlTracker;
  /** Timeout chờ hoàn tất URL-mode (ms). Mặc định 10 phút. */
  urlCompletionTimeoutMs?: number;
  /** Gọi khi server xin secret qua form (để UI/audit báo riêng). */
  onSecretRefused?: (fields: string[], round: number) => void;
  /** Nghe mọi sự kiện audit (activity feed). */
  onAudit?: MrtrElicitationAuditListener;
  /** Signal huỷ lượt chờ (đóng app / user huỷ tool call). */
  signal?: AbortSignal;
  /** Đồng hồ (test tiêm giờ cố định). */
  nowMs?: () => number;
}

/** Timeout mặc định chờ hoàn tất URL-mode (10 phút). */
export const DEFAULT_MRTR_ELICITATION_URL_TIMEOUT_MS = 10 * 60 * 1000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Quét schema elicitation, trả danh sách tên field nhạy cảm.
 * Khác với `parseElicitationSchema` (ném lỗi ở field nhạy cảm
 * đầu tiên): hàm này liệt kê HẾT các field nhạy cảm để thông báo
 * từ chối đầy đủ. Schema không phải object → trả [] (caller sẽ
 * báo lỗi parse riêng).
 */
export function findSensitiveElicitationFields(schema: unknown): string[] {
  if (!isRecord(schema)) return [];
  const properties = schema['properties'];
  if (!isRecord(properties)) return [];
  const sensitive: string[] = [];
  for (const [name, propSchema] of Object.entries(properties)) {
    if (
      isRecord(propSchema) &&
      isSensitiveElicitationField(name, propSchema)
    ) {
      sensitive.push(name);
    } else if (!isRecord(propSchema) && isSensitiveElicitationField(name, {})) {
      sensitive.push(name);
    }
  }
  return sensitive;
}

/**
 * Parse `MrtrNeed` của một round `needs_elicitation` thành
 * `ElicitationRequest` để UI/prompt dùng chung với đường
 * server-initiated cũ. Server gửi:
 *   - form-mode: `need.schema` (JSON Schema) + `need.prompt` làm message.
 *   - url-mode: `need.detail.url` (+ `need.detail.mode: 'url'`,
 *     `need.detail.elicitationId` khi có) + `need.prompt`.
 * Ném `MrtrError` khi need thiếu cả schema lẫn url (server sai spec).
 */
export function parseMrtrElicitationNeed(
  need: MrtrNeed,
  serverName: string,
): ElicitationRequest {
  const detail = isRecord(need.detail) ? need.detail : {};
  const message = need.prompt ?? (typeof detail['message'] === 'string' ? detail['message'] : '');
  const url =
    typeof detail['url'] === 'string'
      ? detail['url']
      : typeof detail['elicitationUrl'] === 'string'
        ? detail['elicitationUrl']
        : undefined;
  const modeHint =
    detail['mode'] === 'url' || detail['mode'] === 'form'
      ? detail['mode']
      : undefined;
  const mode = modeHint ?? (url ? 'url' : 'form');
  const elicitationId =
    typeof detail['elicitationId'] === 'string' ? detail['elicitationId'] : undefined;
  const params: Record<string, unknown> = {
    message: message || 'Server cần thêm thông tin từ bạn.',
    mode,
    ...(elicitationId ? { elicitationId } : {}),
    ...(mode === 'url'
      ? { url }
      : { requestedSchema: need.schema ?? detail['requestedSchema'] }),
  };
  try {
    return parseElicitationRequest(params, serverName);
  } catch (err) {
    throw new MrtrError(
      `MRTR elicitation: need không hợp lệ: ${(err as Error).message}`,
      'needs_elicitation',
    );
  }
}

/**
 * Handler `onNeedsElicitation` đầy đủ cho MRTR: form-mode có
 * secret guard, url-mode có mở URL + chờ callback. Dùng với
 * `runToolCallMultiRoundTrip` qua `MrtrHandlerSources.
 * onNeedsElicitation`, hoặc qua `buildDefaultMrtrHandlers`.
 */
export class MrtrElicitationHandler {
  private readonly serverName: string;
  private readonly prompt: ElicitationPrompt;
  private readonly openUrl?: (url: string) => Promise<void> | void;
  private readonly urlTracker?: ElicitationUrlTracker;
  private readonly urlCompletionTimeoutMs: number;
  private readonly onSecretRefused?: (fields: string[], round: number) => void;
  private readonly onAudit?: MrtrElicitationAuditListener;
  private readonly signal?: AbortSignal;
  private readonly nowMs: () => number;
  private readonly auditLog: MrtrElicitationAuditEvent[] = [];
  private secretRefusalCount = 0;

  constructor(sources: MrtrElicitationSources) {
    this.serverName = sources.serverName;
    this.prompt = sources.prompt;
    this.openUrl = sources.openUrl;
    this.urlTracker = sources.urlTracker;
    this.urlCompletionTimeoutMs =
      sources.urlCompletionTimeoutMs ?? DEFAULT_MRTR_ELICITATION_URL_TIMEOUT_MS;
    this.onSecretRefused = sources.onSecretRefused;
    this.onAudit = sources.onAudit;
    this.signal = sources.signal;
    this.nowMs = sources.nowMs ?? Date.now;
  }

  /** Số lần đã từ chối secret qua form-mode. */
  get secretRefusals(): number {
    return this.secretRefusalCount;
  }

  /** Toàn bộ audit đã ghi (bản sao). */
  get audit(): MrtrElicitationAuditEvent[] {
    return [...this.auditLog];
  }

  private record(
    kind: MrtrElicitationAuditKind,
    round: number,
    mode?: 'form' | 'url',
    detail?: string,
  ): void {
    const event: MrtrElicitationAuditEvent = {
      kind,
      round,
      serverName: this.serverName,
      ...(mode ? { mode } : {}),
      ...(detail ? { detail } : {}),
      atMs: this.nowMs(),
    };
    this.auditLog.push(event);
    this.onAudit?.(event);
  }

  /**
   * Trả lời một round `needs_elicitation`. Trả về `answer` cho
   * round sau (form-mode: object content đã validate; url-mode:
   * `{ completed: true }`). Ném `MrtrError` khi user từ chối/huỷ,
   * `MrtrElicitationRefusedError` khi server xin secret qua form,
   * hoặc lỗi timeout URL-mode — driver dừng cả tool call thay vì
   * bịa câu trả lời.
   */
  async handle(need: MrtrNeed, round: number): Promise<Record<string, unknown>> {
    if (this.signal?.aborted) {
      throw new MrtrError(
        `MRTR elicitation: đã bị huỷ ở round ${round}`,
        'needs_elicitation',
        round,
      );
    }
    let request: ElicitationRequest;
    // Secret guard chạy TRƯỚC KHI parse: `parseElicitationRequest`
    // ném lỗi ngay ở field nhạy cảm đầu tiên, nên quét ở đây để
    // liệt kê hết field + ném đúng `MrtrElicitationRefusedError`
    // (kèm audit + onSecretRefused) thay vì lỗi parse chung chung.
    // Chỉ áp cho form-mode (url-mode không dùng schema).
    const detail = isRecord(need.detail) ? need.detail : {};
    const isUrlMode =
      detail['mode'] === 'url' ||
      typeof detail['url'] === 'string' ||
      typeof detail['elicitationUrl'] === 'string';
    if (!isUrlMode) {
      const preSensitive = findSensitiveElicitationFields(
        need.schema ?? detail['requestedSchema'],
      );
      if (preSensitive.length > 0) {
        this.secretRefusalCount += 1;
        this.record('secret-refused', round, 'form', preSensitive.join(','));
        this.onSecretRefused?.(preSensitive, round);
        throw new MrtrElicitationRefusedError(preSensitive, round);
      }
    }
    try {
      request = parseMrtrElicitationNeed(need, this.serverName);
    } catch (err) {
      this.record('parse-error', round, undefined, (err as Error).message);
      throw err;
    }
    if (request.mode === 'form') {
      return this.handleForm(request, need, round);
    }
    return this.handleUrl(request, round);
  }

  private async handleForm(
    request: ElicitationRequest,
    need: MrtrNeed,
    round: number,
  ): Promise<Record<string, unknown>> {
    // Secret guard: quét TRƯỚC KHI hỏi user. `parseElicitationRequest`
    // đã ném lỗi ở field nhạy cảm đầu tiên, nhưng quét lại ở đây để
    // liệt kê hết field + ghi audit đầy đủ trước khi từ chối.
    const schema = need.schema ?? request.requestedSchema ?? {};
    const sensitive = findSensitiveElicitationFields(schema);
    if (sensitive.length > 0) {
      this.secretRefusalCount += 1;
      this.record('secret-refused', round, 'form', sensitive.join(','));
      this.onSecretRefused?.(sensitive, round);
      throw new MrtrElicitationRefusedError(sensitive, round);
    }
    const result = await handleElicitationRequest(request, this.prompt, {
      ...(this.signal ? { signal: this.signal } : {}),
    });
    if (result.action !== 'accept') {
      this.record('form-declined', round, 'form', result.action);
      throw new MrtrError(
        `MRTR elicitation: người dùng ${result.action === 'decline' ? 'từ chối' : 'huỷ'} yêu cầu ở round ${round}`,
        'needs_elicitation',
        round,
      );
    }
    const fieldNames = (request.fields ?? []).map((f) => f.name).join(',');
    this.record('form-accepted', round, 'form', fieldNames || undefined);
    return { ...(result.content ?? {}) };
  }

  private async handleUrl(
    request: ElicitationRequest,
    round: number,
  ): Promise<Record<string, unknown>> {
    const url = request.url as string;
    // Hỏi user trước khi mở URL ngoài (prompt chung — user thấy rõ
    // server nào, URL nào; decline/cancel thì không mở gì cả).
    const result = await handleElicitationRequest(request, this.prompt, {
      ...(this.signal ? { signal: this.signal } : {}),
    });
    if (result.action !== 'accept') {
      this.record('form-declined', round, 'url', result.action);
      throw new MrtrError(
        `MRTR elicitation: người dùng ${result.action === 'decline' ? 'từ chối' : 'huỷ'} mở URL ở round ${round}`,
        'needs_elicitation',
        round,
      );
    }
    if (!this.openUrl) {
      throw new MrtrError(
        `MRTR elicitation: URL-mode cần mở "${url}" nhưng client không có openUrl (không mở được trình duyệt ngoài)`,
        'needs_elicitation',
        round,
      );
    }
    await this.openUrl(url);
    this.record('url-opened', round, 'url', request.elicitationId ?? url);
    if (request.elicitationId && this.urlTracker) {
      try {
        await this.urlTracker.waitForCompletion(request.elicitationId, {
          timeoutMs: this.urlCompletionTimeoutMs,
          ...(this.signal ? { signal: this.signal } : {}),
        });
      } catch (err) {
        this.record('url-timeout', round, 'url', request.elicitationId);
        throw new MrtrError(
          `MRTR elicitation: hết thời gian chờ hoàn tất URL-mode (${this.urlCompletionTimeoutMs}ms) ở round ${round}: ${(err as Error).message}`,
          'needs_elicitation',
          round,
        );
      }
      this.record('url-completed', round, 'url', request.elicitationId);
      return { completed: true, elicitationId: request.elicitationId };
    }
    // Không có elicitationId/tracker: server không báo complete qua
    // notification — coi mở URL xong là xong (tương thích server cũ).
    return { completed: true, url };
  }
}

/**
 * Tạo callback `onNeedsElicitation` từ sources (để nối thẳng vào
 * `MrtrHandlerSources` / `buildDefaultMrtrHandlers`). Trả về hàm
 * đã bind + giữ `handler` để coordinator đọc audit / đếm từ chối.
 */
export function createMrtrElicitationHandler(
  sources: MrtrElicitationSources,
): {
  onNeedsElicitation: (need: MrtrNeed, round: number) => Promise<Record<string, unknown>>;
  handler: MrtrElicitationHandler;
} {
  const handler = new MrtrElicitationHandler(sources);
  return {
    onNeedsElicitation: (need, round) => handler.handle(need, round),
    handler,
  };
}

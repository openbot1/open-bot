/**
 * MRTR v16 — Multi Round-Trip Requests, SEP-2322 (v1.36, Đội T3).
 *
 * Sóng v0.97/v1.04/v1.05 đã xây driver MRTR tổng quát (`mrtr.ts`,
 * `mrtrClient.ts`, `mrtrServer.ts`): các kind `needs_input` /
 * `needs_sampling` / `needs_elicitation` / `needs_roots` /
 * `needs_confirmation`, handler đăng ký theo kind, follow-up qua
 * `_meta.roundTrip`. V16 xây lớp elicitation chuyên biệt theo đúng
 * hình thức SEP-2322 công bố cho MCP 2026-07-28:
 *
 *   - Server KHÔNG gửi request ngược giữa tool call. Server trả
 *     result với `resultType: "input_required"` + danh sách
 *     `inputRequests`; client thu thập đáp án rồi gọi LẠI method cũ
 *     kèm `inputResponses` + `requestState` (opaque).
 *   - `requestState` là token opaque do server cấp (hoặc do client
 *     tự ký HMAC khi chạy chế độ self-contained): chỉ chứa method
 *     hash, roundTripId, round, nonce, hạn dùng — KHÔNG BAO GIỜ
 *     chứa secret (password / token / API key). Module quét và từ
 *     chối mọi requestState chứa trường nhạy cảm.
 *   - Handler phải idempotent trước điểm cần input: cùng một
 *     (roundTripId, round, inputRequest id) chỉ thu thập đáp án một
 *     lần; gọi lại (retry / replay) trả đáp án đã cache, không hỏi
 *     user lần hai, không chạy lại side-effect trước điểm input.
 *   - Server-initiated request chỉ còn được phép trong lúc đang xử
 *     lý một client request (SEP-2260): v16 ghi lại `inFlight` và
 *     từ chối mọi follow-up phát sinh ngoài cửa sổ đó.
 *
 * Module này không chạm mạng, không hỏi user trực tiếp: nó lái một
 * hàm `call` do coordinator cung cấp và một `inputCollector` do UI
 * cung cấp. Ideas only — không copy code/text/tài sản của bất kỳ
 * repo nào, của xAI/Cursor.
 */

import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { isSensitiveElicitationField } from './elicitation';
import { MCP_MRTR_MAX_ROUNDS_DEFAULT } from './mrtr';

/** Result type elicitation của SEP-2322. */
export const MRTR_V16_RESULT_TYPE = 'input_required' as const;

/** Số vòng tối đa mặc định (kế thừa driver MRTR cũ). */
export const MRTR_V16_MAX_ROUNDS = MCP_MRTR_MAX_ROUNDS_DEFAULT;

/** Hạn dùng mặc định của một requestState (10 phút). */
export const MRTR_V16_STATE_TTL_MS = 10 * 60 * 1000;

/** Lỗi MRTR v16. */
export class MrtrV16Error extends Error {
  readonly code?: string;
  constructor(message: string, code?: string) {
    super(message);
    this.name = 'MrtrV16Error';
    if (code) this.code = code;
  }
}

/** Một yêu cầu input server gửi trong result `input_required`. */
export interface MrtrV16InputRequest {
  /** Id ổn định của input request (dùng cho idempotency + đáp án). */
  id: string;
  /** Câu hỏi / hướng dẫn hiển thị cho user. */
  prompt: string;
  /** JSON Schema ràng buộc đáp án (khi có). */
  schema?: Record<string, unknown>;
  /** Chế độ thu thập: form (nhập tay) hay url (mở link ngoài). */
  mode: 'form' | 'url';
  /** Đáp án có bắt buộc không (mặc định true). */
  required?: boolean;
  /** Gợi ý giá trị mặc định (không phải secret — secret bị cấm ở đây). */
  defaultValue?: unknown;
  /** URL dùng khi mode=url (vd trang OAuth sign-in, payment page). */
  url?: string;
}

/** Đáp án cho một input request. */
export interface MrtrV16InputResponse {
  /** Id khớp với MrtrV16InputRequest.id. */
  id: string;
  /** Đáp án của user (đã coerce theo schema nếu có). */
  value: unknown;
  /** User từ chối cung cấp input này. */
  declined?: boolean;
}

/** Result thô server trả (đã parse tối thiểu). */
export interface MrtrV16ServerResult {
  resultType: string;
  inputRequests?: MrtrV16InputRequest[];
  requestState?: string;
  /** Payload kết quả cuối khi resultType là complete. */
  data?: unknown;
  /** Thông báo lỗi nghiệp vụ của server (khi có). */
  error?: string;
}

/** Payload đã giải mã của một requestState do v16 tự ký. */
export interface MrtrV16RequestState {
  /** Hash (sha256 hex) của method đang gọi lại. */
  methodHash: string;
  /** Id phiên multi-round-trip. */
  roundTripId: string;
  /** Vòng hiện tại (0 = lần gọi đầu). */
  round: number;
  /** Nonce chống replay. */
  nonce: string;
  /** Hạn dùng (ms epoch). */
  expiresAtMs: number;
  /** Số input request đã được hỏi ở vòng này. */
  inputCount: number;
}

/** Một vòng đã chạy (audit log). */
export interface MrtrV16RoundRecord {
  round: number;
  method: string;
  roundTripId: string;
  resultType: string;
  inputIds: string[];
  answeredIds: string[];
  declinedIds: string[];
  atMs: number;
  durationMs: number;
}

/** Kết quả cuối của một phiên MRTR v16. */
export interface MrtrV16Outcome {
  /** true khi server trả result cuối (không còn input_required). */
  completed: boolean;
  /** Tổng số vòng đã chạy (tính cả vòng đầu). */
  rounds: number;
  /** Id phiên. */
  roundTripId: string;
  /** Kết quả cuối của server. */
  data: unknown;
  /** Audit log từng vòng. */
  history: MrtrV16RoundRecord[];
  /** true khi dừng vì user decline một input bắt buộc. */
  stoppedByDecline: boolean;
}

/** Hàm gọi method ở server (coordinator nối vào client thật). */
export type MrtrV16CallFn = (
  method: string,
  params: Record<string, unknown>,
) => Promise<unknown>;

/** Hàm thu thập đáp án từ user (UI nối vào). */
export type MrtrV16InputCollector = (
  requests: MrtrV16InputRequest[],
  context: { method: string; round: number; roundTripId: string },
) => Promise<MrtrV16InputResponse[]>;

/** Tuỳ chọn cho phiên MRTR v16. */
export interface MrtrV16Options {
  /** Số vòng tối đa (mặc định 8). */
  maxRounds?: number;
  /** Secret ký HMAC cho requestState tự cấp (bắt buộc khi tự cấp state). */
  hmacSecret?: string;
  /** TTL requestState tự cấp (ms, mặc định 10 phút). */
  stateTtlMs?: number;
  /** Đồng hồ (để test điều khiển thời gian). */
  now?: () => number;
  /** Hàm audit từng vòng (mặc định không làm gì). */
  onRound?: (record: MrtrV16RoundRecord) => void;
}

/** Mẫu tên trường nhạy cảm — cấm xuất hiện trong requestState. */
export const MRTR_V16_SECRET_FIELD_PATTERN =
  /(password|passwd|secret|api[-_ ]?key|access[-_ ]?token|auth[-_ ]?token|private[-_ ]?key|credential|credit[-_ ]?card|card[-_ ]?number|cvv|pin|otp)/i;

/**
 * Quét một object (đệ quy nông, tối đa 3 tầng) tìm trường nhạy cảm.
 * Trả về tên trường đầu tiên vi phạm, hoặc null khi sạch.
 */
export function findSecretFieldInState(value: unknown, depth = 0): string | null {
  if (depth > 3 || value === null || typeof value !== 'object') return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const hit = findSecretFieldInState(item, depth + 1);
      if (hit) return hit;
    }
    return null;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (MRTR_V16_SECRET_FIELD_PATTERN.test(key)) return key;
    const hit = findSecretFieldInState(child, depth + 1);
    if (hit) return hit;
  }
  return null;
}

/** SHA-256 hex của một chuỗi (dùng hash method cho requestState). */
export function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

function hmacSign(secret: string, payload: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

/**
 * Parse + validate result thô của server thành MrtrV16ServerResult.
 * Ném khi `input_required` mà thiếu `inputRequests` hợp lệ, hoặc
 * khi `requestState` chứa trường nhạy cảm.
 */
export function parseMrtrV16Result(value: unknown): MrtrV16ServerResult {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new MrtrV16Error('MRTR v16: result của server phải là object.', 'bad-result');
  }
  const rec = value as Record<string, unknown>;
  const resultType = rec['resultType'];
  if (typeof resultType !== 'string' || resultType.length === 0) {
    // Server cũ trả result thường (không có resultType): coi như complete.
    return { resultType: 'complete', data: value };
  }
  if (typeof rec['requestState'] === 'string') {
    const secretField = findSecretFieldInState(
      safeJsonParse(rec['requestState'] as string),
    );
    if (secretField) {
      throw new MrtrV16Error(
        `MRTR v16: requestState chứa trường nhạy cảm "${secretField}" — server vi phạm quy tắc không giữ secret trong requestState.`,
        'secret-in-state',
      );
    }
  }
  if (resultType !== MRTR_V16_RESULT_TYPE) {
    return {
      resultType,
      requestState: typeof rec['requestState'] === 'string' ? (rec['requestState'] as string) : undefined,
      data: rec['data'] ?? rec['result'] ?? value,
      error: typeof rec['error'] === 'string' ? (rec['error'] as string) : undefined,
    };
  }
  const rawRequests = rec['inputRequests'];
  if (!Array.isArray(rawRequests) || rawRequests.length === 0) {
    throw new MrtrV16Error(
      'MRTR v16: result input_required nhưng thiếu inputRequests.',
      'missing-input-requests',
    );
  }
  const inputRequests: MrtrV16InputRequest[] = rawRequests.map((raw, index) => {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new MrtrV16Error(
        `MRTR v16: inputRequests[${index}] không phải object.`,
        'bad-input-request',
      );
    }
    const r = raw as Record<string, unknown>;
    const id = typeof r['id'] === 'string' && r['id'].length > 0 ? (r['id'] as string) : `input-${index}`;
    const prompt = typeof r['prompt'] === 'string' && r['prompt'].length > 0
      ? (r['prompt'] as string)
      : `Cần thêm thông tin (${id})`;
    const mode = r['mode'] === 'url' ? 'url' : 'form';
    if (mode === 'url' && typeof r['url'] !== 'string') {
      throw new MrtrV16Error(
        `MRTR v16: inputRequest "${id}" mode=url nhưng thiếu url.`,
        'url-mode-missing-url',
      );
    }
    if (mode === 'form') {
      const schemaRecord = isRecord(r['schema']) ? (r['schema'] as Record<string, unknown>) : {};
      if (isSensitiveElicitationField(id, schemaRecord)) {
        throw new MrtrV16Error(
          `MRTR v16: form input "${id}" yêu cầu trường nhạy cảm — form mode bị cấm cho secret, dùng URL mode (xem elicitationUrlV16.ts).`,
          'secret-in-form',
        );
      }
    }
    return {
      id,
      prompt,
      ...(isRecord(r['schema']) ? { schema: r['schema'] as Record<string, unknown> } : {}),
      mode,
      required: r['required'] !== false,
      ...(r['defaultValue'] !== undefined ? { defaultValue: r['defaultValue'] } : {}),
      ...(mode === 'url' ? { url: r['url'] as string } : {}),
    };
  });
  return {
    resultType,
    inputRequests,
    requestState: typeof rec['requestState'] === 'string' ? (rec['requestState'] as string) : undefined,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

/**
 * Ký một requestState opaque (định dạng `v16.<base64url payload>.<sig>`).
 * Payload chỉ chứa methodHash / roundTripId / round / nonce /
 * expiresAtMs / inputCount — không chứa đáp án, không chứa secret.
 */
export function signMrtrV16RequestState(
  secret: string,
  state: Omit<MrtrV16RequestState, 'nonce'> & { nonce?: string },
): string {
  if (typeof secret !== 'string' || secret.length < 16) {
    throw new MrtrV16Error(
      'MRTR v16: hmacSecret phải dài ít nhất 16 ký tự để ký requestState.',
      'weak-secret',
    );
  }
  const payload: MrtrV16RequestState = {
    ...state,
    nonce: state.nonce ?? randomBytes(12).toString('base64url'),
  };
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `v16.${encoded}.${hmacSign(secret, encoded)}`;
}

/**
 * Kiểm tra + giải mã một requestState do v16 ký. Ném khi sai định
 * dạng, sai chữ ký, hết hạn, hoặc payload chứa trường nhạy cảm.
 */
export function verifyMrtrV16RequestState(
  secret: string,
  token: string,
  nowMs: number = Date.now(),
): MrtrV16RequestState {
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== 'v16') {
    throw new MrtrV16Error('MRTR v16: requestState sai định dạng.', 'bad-state');
  }
  const [encoded, sig] = [parts[1] as string, parts[2] as string];
  const expected = hmacSign(secret, encoded);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new MrtrV16Error('MRTR v16: requestState sai chữ ký — có thể đã bị sửa.', 'bad-signature');
  }
  const parsed = safeJsonParse(Buffer.from(encoded, 'base64url').toString('utf8'));
  if (!isRecord(parsed)) {
    throw new MrtrV16Error('MRTR v16: requestState không giải mã được.', 'bad-state');
  }
  const state = parsed as unknown as MrtrV16RequestState;
  if (
    typeof state.methodHash !== 'string' ||
    typeof state.roundTripId !== 'string' ||
    typeof state.round !== 'number' ||
    typeof state.nonce !== 'string' ||
    typeof state.expiresAtMs !== 'number'
  ) {
    throw new MrtrV16Error('MRTR v16: requestState thiếu trường bắt buộc.', 'bad-state');
  }
  if (nowMs > state.expiresAtMs) {
    throw new MrtrV16Error('MRTR v16: requestState đã hết hạn — gọi lại từ đầu.', 'state-expired');
  }
  if (findSecretFieldInState(parsed)) {
    throw new MrtrV16Error(
      'MRTR v16: requestState chứa trường nhạy cảm — từ chối.',
      'secret-in-state',
    );
  }
  return state;
}

/**
 * Kiểm tra một đáp án có khớp input request không: đủ id, không
 * thiếu giá trị bắt buộc, đúng kiểu cơ bản theo schema (khi schema
 * khai `type`). Trả về lỗi mô tả, hoặc null khi hợp lệ.
 */
export function validateMrtrV16Response(
  request: MrtrV16InputRequest,
  response: MrtrV16InputResponse | undefined,
): string | null {
  if (!response) {
    return request.required === false
      ? null
      : `Thiếu đáp án cho "${request.id}" (${request.prompt}).`;
  }
  if (response.declined) {
    // Decline là đáp án hợp lệ ở tầng validation — session quyết
    // định có dừng không (input bắt buộc → stoppedByDecline).
    return null;
  }
  if (response.value === undefined || response.value === null || response.value === '') {
    return request.required === false ? null : `Đáp án cho "${request.id}" đang trống.`;
  }
  const schemaType = isRecord(request.schema) ? request.schema['type'] : undefined;
  if (typeof schemaType === 'string') {
    const v = response.value;
    const ok =
      (schemaType === 'string' && typeof v === 'string') ||
      (schemaType === 'number' && typeof v === 'number') ||
      (schemaType === 'integer' && typeof v === 'number' && Number.isInteger(v)) ||
      (schemaType === 'boolean' && typeof v === 'boolean') ||
      (schemaType === 'array' && Array.isArray(v)) ||
      (schemaType === 'object' && isRecord(v));
    if (!ok) return `Đáp án cho "${request.id}" phải là ${schemaType}.`;
  }
  return null;
}

/**
 * Orchestrator MRTR v16: gọi method, gặp `input_required` thì thu
 * thập đáp án (idempotent: cùng roundTripId+round+id chỉ hỏi một
 * lần — đáp án đã thu được cache và dùng lại khi retry/replay),
 * rồi gọi lại method cũ kèm `inputResponses` + `requestState`.
 *
 * SEP-2260: follow-up chỉ diễn ra trong lúc đang xử lý một client
 * request — vòng lặp này chạy đồng bộ trong một lần `run()` nên
 * mọi follow-up đều nằm trong cửa sổ đó; không có callback nào
 * được giữ lại sau khi `run()` trả về.
 */
export class MrtrV16Session {
  private readonly callFn: MrtrV16CallFn;
  private readonly collector: MrtrV16InputCollector;
  private readonly maxRounds: number;
  private readonly hmacSecret?: string;
  private readonly stateTtlMs: number;
  private readonly now: () => number;
  private readonly onRound?: (record: MrtrV16RoundRecord) => void;
  /** Cache đáp án theo `${roundTripId}:${round}:${inputId}`. */
  private readonly answerCache = new Map<string, MrtrV16InputResponse>();
  /** Nonce đã dùng (chống replay cùng requestState hai lần). */
  private readonly usedNonces = new Set<string>();

  constructor(callFn: MrtrV16CallFn, collector: MrtrV16InputCollector, options: MrtrV16Options = {}) {
    if (typeof callFn !== 'function') {
      throw new MrtrV16Error('MRTR v16: thiếu hàm call.', 'no-call-fn');
    }
    if (typeof collector !== 'function') {
      throw new MrtrV16Error('MRTR v16: thiếu input collector.', 'no-collector');
    }
    this.callFn = callFn;
    this.collector = collector;
    this.maxRounds = options.maxRounds ?? MRTR_V16_MAX_ROUNDS;
    this.hmacSecret = options.hmacSecret;
    this.stateTtlMs = options.stateTtlMs ?? MRTR_V16_STATE_TTL_MS;
    this.now = options.now ?? Date.now;
    this.onRound = options.onRound;
  }

  /** Số đáp án đã cache (quan sát / test idempotency). */
  cachedAnswers(): number {
    return this.answerCache.size;
  }

  /**
   * Chạy một method tới khi complete hoặc hết vòng / user decline.
   * `initialParams` là params lần gọi đầu (không chứa inputResponses).
   */
  async run(
    method: string,
    initialParams: Record<string, unknown> = {},
  ): Promise<MrtrV16Outcome> {
    if (typeof method !== 'string' || method.length === 0) {
      throw new MrtrV16Error('MRTR v16: method rỗng.', 'bad-method');
    }
    const roundTripId = randomUUID();
    const methodHash = sha256Hex(method);
    const history: MrtrV16RoundRecord[] = [];
    let params: Record<string, unknown> = { ...initialParams };
    let serverState: string | undefined;
    let stoppedByDecline = false;

    for (let round = 0; round < this.maxRounds; round++) {
      const startedAt = this.now();
      const raw = await this.callFn(method, params);
      const parsed = parseMrtrV16Result(raw);
      const record: MrtrV16RoundRecord = {
        round,
        method,
        roundTripId,
        resultType: parsed.resultType,
        inputIds: (parsed.inputRequests ?? []).map((r) => r.id),
        answeredIds: [],
        declinedIds: [],
        atMs: startedAt,
        durationMs: this.now() - startedAt,
      };
      if (parsed.resultType !== MRTR_V16_RESULT_TYPE) {
        history.push(record);
        this.onRound?.(record);
        return {
          completed: true,
          rounds: round + 1,
          roundTripId,
          data: parsed.data,
          history,
          stoppedByDecline: false,
        };
      }
      const requests = parsed.inputRequests as MrtrV16InputRequest[];
      // Idempotency: chỉ hỏi những input chưa có đáp án cache.
      const uncached = requests.filter(
        (r) => !this.answerCache.has(`${roundTripId}:${round}:${r.id}`),
      );
      let fresh: MrtrV16InputResponse[] = [];
      if (uncached.length > 0) {
        fresh = await this.collector(uncached, { method, round, roundTripId });
        for (const response of fresh) {
          const request = uncached.find((r) => r.id === response.id);
          if (!request) continue;
          const problem = validateMrtrV16Response(request, response);
          if (problem) {
            throw new MrtrV16Error(`MRTR v16: đáp án không hợp lệ — ${problem}`, 'bad-answer');
          }
          this.answerCache.set(`${roundTripId}:${round}:${response.id}`, response);
        }
      }
      const responses: MrtrV16InputResponse[] = requests.map((r) => {
        const cached = this.answerCache.get(`${roundTripId}:${round}:${r.id}`);
        if (!cached) {
          throw new MrtrV16Error(
            `MRTR v16: không có đáp án cho input "${r.id}" (collector không trả).`,
            'missing-answer',
          );
        }
        return cached;
      });
      for (const response of responses) {
        if (response.declined) {
          record.declinedIds.push(response.id);
          if ((requests.find((r) => r.id === response.id)?.required ?? true)) {
            stoppedByDecline = true;
          }
        } else {
          record.answeredIds.push(response.id);
        }
      }
      record.durationMs = this.now() - startedAt;
      history.push(record);
      this.onRound?.(record);
      if (stoppedByDecline) {
        return {
          completed: false,
          rounds: round + 1,
          roundTripId,
          data: null,
          history,
          stoppedByDecline: true,
        };
      }
      // Gọi lại method cũ kèm inputResponses + requestState.
      // Ưu tiên state server trả; nếu server không cấp state mà
      // client có hmacSecret thì tự ký state (self-contained).
      if (typeof parsed.requestState === 'string') {
        serverState = parsed.requestState;
      } else if (this.hmacSecret) {
        const state: MrtrV16RequestState = {
          methodHash,
          roundTripId,
          round,
          nonce: randomBytes(12).toString('base64url'),
          expiresAtMs: this.now() + this.stateTtlMs,
          inputCount: requests.length,
        };
        if (this.usedNonces.has(state.nonce)) {
          throw new MrtrV16Error('MRTR v16: nonce trùng — từ chối replay.', 'nonce-reuse');
        }
        this.usedNonces.add(state.nonce);
        serverState = signMrtrV16RequestState(this.hmacSecret, state);
      }
      params = {
        ...initialParams,
        inputResponses: responses.map((r) => ({
          id: r.id,
          value: r.value,
          ...(r.declined ? { declined: true } : {}),
        })),
        ...(serverState ? { requestState: serverState } : {}),
        _meta: {
          roundTrip: { roundTripId, round: round + 1 },
        },
      };
    }
    throw new MrtrV16Error(
      `MRTR v16: vượt quá ${this.maxRounds} vòng cho method "${method}" — server cứ đòi thêm input.`,
      'max-rounds',
    );
  }
}

/** Chạy nhanh một phiên MRTR v16 mà không cần giữ session. */
export async function runMrtrV16(
  callFn: MrtrV16CallFn,
  collector: MrtrV16InputCollector,
  method: string,
  initialParams: Record<string, unknown> = {},
  options: MrtrV16Options = {},
): Promise<MrtrV16Outcome> {
  const session = new MrtrV16Session(callFn, collector, options);
  return session.run(method, initialParams);
}

/**
 * InputRequiredResult — MRTR theo MCP spec 2026-07-28 (v1.10, Team T2).
 *
 * Khác với MRTR v0.97 (`mrtr.ts`, SEP-2322 draft — `needs_input` /
 * `needs_sampling` / ...): spec 2026-07-28 thu gọn mọi server-initiated
 * request còn MỘT hình dạng duy nhất, `InputRequiredResult`:
 *
 *   { resultType: "input_required", input: { prompt, schema, ... },
 *     state, roundTripId, note }
 *
 * và bắt buộc MỌI result đều mang `resultType` — `complete` cho kết quả
 * cuối, `input_required` khi server còn cần thêm input. Một result không
 * có `resultType` KHÔNG còn được coi là legacy-complete (như driver cũ):
 * ở client 2026 đó là lỗi protocol, vì server 2026 phải luôn gắn
 * `resultType`. Server cũ (không có `resultType`) vẫn chạy qua driver
 * `mrtr.ts` cũ — module này chỉ nói chuyện với server 2026-07-28.
 *
 * Luồng client (`runInputRequiredLoop`):
 *   1. gửi request gốc (vd `tools/call`) như bình thường;
 *   2. server trả `input_required` kèm `input` (câu hỏi + JSON Schema
 *      cho đáp án) và `state` (trạng thái vòng lặp do server giữ —
 *      client chỉ mang về nguyên vẹn, không đọc, không sửa);
 *   3. client gọi `InputProvider` để lấy đáp án (hỏi user, tra
 *      argument đã cho trước, ...), validate đáp án theo `input.schema`;
 *   4. retry request GỐC, kèm đáp án (`params.answer`) + `state` trả
 *      lại (`params.state` và `_meta.roundTrip`) — server resume từ
 *      đó, không cần giữ session;
 *   5. lặp tới `complete` hoặc hết budget `maxRounds`.
 *
 * Module này không gọi model, không hỏi user, không chạm mạng: đáp án
 * tới từ `InputProvider` do coordinator tiêm vào; transport là JSON-RPC
 * thô. Ideas only — không copy code/text/tài sản của bất kỳ MCP
 * implementation, SDK nào, hay của xAI/Cursor.
 */

import { buildStatelessMeta, withStatelessMeta } from './stateless';

/** Protocol version của spec 2026-07-28. */
export const MCP_SPEC_VERSION_2026_07_28 = '2026-07-28';

/** Extension Tasks chính thức (dùng chung hằng số với tasksSpec.ts). */
export const MCP_INPUT_REQUIRED_EXTENSION = 'io.modelcontextprotocol/tasks';

/** `resultType` bắt buộc trên mọi result 2026-07-28. */
export type McpResultType2026 = 'complete' | 'input_required';

/** Mọi `resultType` hợp lệ ở spec 2026-07-28. */
export const MCP_RESULT_TYPES_2026: readonly McpResultType2026[] = [
  'complete',
  'input_required',
];

/** Số round tối đa mặc định cho một vòng lặp input (giống MRTR cũ). */
export const MCP_INPUT_REQUIRED_MAX_ROUNDS_DEFAULT = 8;

/** Lỗi liên quan tới vòng lặp input_required (parse / schema / budget). */
export class InputRequiredError extends Error {
  readonly resultType?: McpResultType2026;
  readonly round?: number;
  constructor(message: string, resultType?: McpResultType2026, round?: number) {
    super(message);
    this.name = 'InputRequiredError';
    this.resultType = resultType;
    this.round = round;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Cái server cần ở một round `input_required`: câu hỏi cho client/user,
 * JSON Schema ràng buộc đáp án, và dữ liệu phụ trợ (vd gợi ý giá trị).
 */
export interface InputRequest {
  /** Câu hỏi / hướng dẫn cho client hoặc user (hiển thị được). */
  prompt?: string;
  /** JSON Schema đáp án phải thỏa (khi có — validate trước khi retry). */
  schema?: Record<string, unknown>;
  /** Dữ liệu phụ trợ theo từng loại input (gợi ý, giá trị mặc định...). */
  detail?: Record<string, unknown>;
}

/** Result cuối của server 2026-07-28 (`resultType: "complete"`). */
export interface CompleteResult2026 {
  resultType: 'complete';
  /** Payload cuối (toàn bộ `tools/call` result, ...). */
  result: unknown;
  /** Id vòng lặp do server gán (ổn định qua các round). */
  roundTripId?: string;
  /** Ghi chú tiến độ của round cuối. */
  note?: string;
}

/** `InputRequiredResult` — server cần thêm input để tiếp tục. */
export interface InputRequiredResult {
  resultType: 'input_required';
  /** Server cần gì (câu hỏi + schema đáp án). */
  input: InputRequest;
  /**
   * Trạng thái vòng lặp do server giữ — client mang về nguyên vẹn ở
   * request retry, không đọc, không sửa. Server stateless resume
   * được chỉ từ `state` này + đáp án.
   */
  state?: unknown;
  /** Id vòng lặp do server gán (ổn định qua các round). */
  roundTripId?: string;
  /** Ghi chú tiến độ của round này. */
  note?: string;
}

/** Mọi result 2026-07-28: `resultType` bắt buộc, không có ngoại lệ. */
export type SpecResult2026 = CompleteResult2026 | InputRequiredResult;

/** True khi giá trị là một `resultType` hợp lệ của spec 2026-07-28. */
export function isSpecResultType2026(value: unknown): value is McpResultType2026 {
  return value === 'complete' || value === 'input_required';
}

/**
 * Parse một result thô thành `SpecResult2026`. NGHIÊM NGẶT hơn driver
 * MRTR cũ: result thiếu `resultType` hoặc mang giá trị lạ thì NÉM
 * `InputRequiredError` — ở spec 2026-07-28, `resultType` là bắt buộc
 * trên mọi result, nên thiếu nó là lỗi protocol, không phải legacy.
 */
export function parseSpecResult2026(value: unknown): SpecResult2026 {
  if (!isRecord(value)) {
    throw new InputRequiredError(
      'InputRequired (2026-07-28): result phải là object có "resultType" bắt buộc.',
    );
  }
  const rawType = value['resultType'];
  if (rawType === undefined) {
    throw new InputRequiredError(
      'InputRequired (2026-07-28): result thiếu "resultType" bắt buộc ' +
        '(server 2026-07-28 phải gắn resultType "complete" hoặc "input_required" trên mọi result).',
    );
  }
  if (!isSpecResultType2026(rawType)) {
    throw new InputRequiredError(
      `InputRequired (2026-07-28): resultType không hợp lệ: ${JSON.stringify(rawType)}`,
    );
  }
  if (rawType === 'complete') {
    return {
      resultType: 'complete',
      result: value['result'] !== undefined ? value['result'] : value,
      ...(typeof value['roundTripId'] === 'string' ? { roundTripId: value['roundTripId'] } : {}),
      ...(typeof value['note'] === 'string' ? { note: value['note'] } : {}),
    };
  }
  const inputRaw = isRecord(value['input']) ? value['input'] : {};
  const input: InputRequest = {
    ...(typeof inputRaw['prompt'] === 'string' ? { prompt: inputRaw['prompt'] } : {}),
    ...(typeof value['prompt'] === 'string' && !inputRaw['prompt']
      ? { prompt: value['prompt'] as string }
      : {}),
    ...(isRecord(inputRaw['schema']) ? { schema: inputRaw['schema'] } : {}),
    ...(isRecord(inputRaw['detail']) ? { detail: inputRaw['detail'] } : {}),
  };
  return {
    resultType: 'input_required',
    input,
    ...(value['state'] !== undefined ? { state: value['state'] } : {}),
    ...(typeof value['roundTripId'] === 'string' ? { roundTripId: value['roundTripId'] } : {}),
    ...(typeof value['note'] === 'string' ? { note: value['note'] } : {}),
  };
}

/** True khi result thô mang `resultType: "input_required"` kèm `input`. */
export function isInputRequiredResult(value: unknown): value is InputRequiredResult {
  if (!isRecord(value)) return false;
  if (value['resultType'] !== 'input_required') return false;
  if (!isRecord(value['input'])) return false;
  try {
    return parseSpecResult2026(value).resultType === 'input_required';
  } catch {
    return false;
  }
}

/**
 * Build một `InputRequiredResult` (phía server / test). `input` luôn
 * có mặt — một `input_required` không có `input` là result hỏng.
 */
export function buildInputRequiredResult(
  input: InputRequest,
  options: { state?: unknown; roundTripId?: string; note?: string } = {},
): Record<string, unknown> {
  const out: Record<string, unknown> = {
    resultType: 'input_required',
    input: { ...input },
  };
  if (options.state !== undefined) out['state'] = options.state;
  if (options.roundTripId) out['roundTripId'] = options.roundTripId;
  if (options.note) out['note'] = options.note;
  return out;
}

/** Build một result `complete` 2026-07-28 (phía server / test). */
export function buildCompleteResult2026(
  result: unknown,
  options: { roundTripId?: string; note?: string } = {},
): Record<string, unknown> {
  const out: Record<string, unknown> = { resultType: 'complete', result };
  if (options.roundTripId) out['roundTripId'] = options.roundTripId;
  if (options.note) out['note'] = options.note;
  return out;
}

// ---------------------------------------------------------------------------
// Validate đáp án theo JSON Schema (subset đủ dùng cho input_required)
// ---------------------------------------------------------------------------

/** Một lỗi validate schema (đường dẫn field + lý do). */
export interface InputSchemaIssue {
  path: string;
  message: string;
}

/** Kết quả validate đáp án theo schema. */
export interface InputSchemaValidation {
  valid: boolean;
  issues: InputSchemaIssue[];
}

function schemaTypeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (Number.isInteger(value)) return 'integer';
  return typeof value;
}

function checkType(value: unknown, expected: string, path: string, issues: InputSchemaIssue[]): void {
  if (expected === 'number' && typeof value === 'number') return;
  if (expected === 'integer' && Number.isInteger(value)) return;
  if (schemaTypeOf(value) !== expected) {
    issues.push({
      path,
      message: `kiểu phải là "${expected}", nhận ${schemaTypeOf(value)}`,
    });
  }
}

function validateAgainstSchema(
  value: unknown,
  schema: Record<string, unknown>,
  path: string,
  issues: InputSchemaIssue[],
): void {
  const type = schema['type'];
  if (typeof type === 'string') checkType(value, type, path, issues);
  if (Array.isArray(schema['enum'])) {
    const allowed = schema['enum'] as unknown[];
    if (!allowed.some((candidate) => JSON.stringify(candidate) === JSON.stringify(value))) {
      issues.push({ path, message: `giá trị phải là một trong ${JSON.stringify(allowed)}` });
    }
  }
  if (typeof value === 'number') {
    if (typeof schema['minimum'] === 'number' && value < schema['minimum']) {
      issues.push({ path, message: `phải >= ${schema['minimum']}` });
    }
    if (typeof schema['maximum'] === 'number' && value > schema['maximum']) {
      issues.push({ path, message: `phải <= ${schema['maximum']}` });
    }
  }
  if (typeof value === 'string') {
    if (typeof schema['minLength'] === 'number' && value.length < schema['minLength']) {
      issues.push({ path, message: `độ dài phải >= ${schema['minLength']}` });
    }
    if (typeof schema['maxLength'] === 'number' && value.length > schema['maxLength']) {
      issues.push({ path, message: `độ dài phải <= ${schema['maxLength']}` });
    }
    if (typeof schema['pattern'] === 'string') {
      let re: RegExp;
      try {
        re = new RegExp(schema['pattern']);
      } catch {
        issues.push({ path, message: `schema có pattern không hợp lệ: ${schema['pattern']}` });
        return;
      }
      if (!re.test(value)) {
        issues.push({ path, message: `không khớp pattern ${schema['pattern']}` });
      }
    }
  }
  if (isRecord(value) && isRecord(schema['properties'])) {
    const required = Array.isArray(schema['required'])
      ? (schema['required'] as unknown[]).filter((r) => typeof r === 'string')
      : [];
    for (const field of required) {
      if (value[field] === undefined) {
        issues.push({ path: path ? `${path}.${field}` : field, message: 'thiếu trường bắt buộc' });
      }
    }
    for (const [field, fieldSchema] of Object.entries(schema['properties'])) {
      if (value[field] === undefined) continue;
      if (isRecord(fieldSchema)) {
        validateAgainstSchema(value[field], fieldSchema, path ? `${path}.${field}` : field, issues);
      }
    }
    if (schema['additionalProperties'] === false) {
      for (const key of Object.keys(value)) {
        if (!(key in (schema['properties'] as Record<string, unknown>))) {
          issues.push({ path: path ? `${path}.${key}` : key, message: 'trường không có trong schema' });
        }
      }
    }
  }
  if (Array.isArray(value)) {
    if (typeof schema['minItems'] === 'number' && value.length < schema['minItems']) {
      issues.push({ path, message: `cần ít nhất ${schema['minItems']} phần tử` });
    }
    if (typeof schema['maxItems'] === 'number' && value.length > schema['maxItems']) {
      issues.push({ path, message: `tối đa ${schema['maxItems']} phần tử` });
    }
    if (isRecord(schema['items'])) {
      value.forEach((item, index) => {
        validateAgainstSchema(item, schema['items'] as Record<string, unknown>, `${path}[${index}]`, issues);
      });
    }
  }
}

/**
 * Validate một đáp án theo JSON Schema của `input` (subset: type,
 * enum, required/properties/additionalProperties, minimum/maximum,
 * minLength/maxLength/pattern, minItems/maxItems/items). Không có
 * schema → luôn valid (server không ràng buộc đáp án). Trả danh sách
 * issue thay vì throw để caller quyết định báo lỗi hay hỏi lại.
 */
export function validateInputAgainstSchema(
  answer: unknown,
  schema: Record<string, unknown> | undefined,
): InputSchemaValidation {
  if (!schema) return { valid: true, issues: [] };
  const issues: InputSchemaIssue[] = [];
  validateAgainstSchema(answer, schema, '', issues);
  return { valid: issues.length === 0, issues };
}

// ---------------------------------------------------------------------------
// Client driver: vòng lặp input_required
// ---------------------------------------------------------------------------

/** Transport JSON-RPC tối thiểu mà driver cần. */
export interface InputRequiredTransport {
  requestJsonRpc(method: string, params?: Record<string, unknown>): Promise<unknown>;
}

/**
 * Nguồn đáp án cho một round `input_required`. Trả đáp án + `state`
 * mới (tuỳ chọn) — `state` này được gửi lại cho server ở round sau
 * (client giữ hộ, không đọc). Provider NÉM lỗi khi không trả lời được
 * (vd user từ chối) — driver dừng vòng lặp ngay, không retry mò.
 */
export type InputProvider = (
  request: InputRequest,
  round: number,
  serverState: unknown,
) => Promise<{ answer: unknown; state?: unknown }>;

/** Một round đã diễn ra, cho log / activity feed. */
export interface InputRequiredRoundRecord {
  round: number;
  method: string;
  resultType: McpResultType2026;
  note?: string;
}

/** Tuỳ chọn cho `runInputRequiredLoop`. */
export interface InputRequiredLoopOptions {
  /** Budget round tối đa (mặc định 8). */
  maxRounds?: number;
  /** Gọi sau mỗi round (progress UI / tracing). */
  onRound?: (record: InputRequiredRoundRecord) => void;
  /**
   * Có validate đáp án theo `input.schema` trước khi retry không
   * (mặc định true). Tắt chỉ khi caller đã tự validate.
   */
  validateAnswer?: boolean;
}

/** Kết quả cuối của một vòng lặp input_required. */
export interface InputRequiredLoopOutcome {
  /** Payload cuối từ round `complete`. */
  result: unknown;
  /** Số round đã chạy (1 = server trả complete ngay). */
  rounds: number;
  /** Id vòng lặp server gán (khi có). */
  roundTripId?: string;
  /** Lịch sử từng round. */
  history: InputRequiredRoundRecord[];
}

/**
 * Build params retry cho round sau: request GỐC + đáp án + state trả
 * lại. Đáp án nằm ở `params.answer`, state server gửi ở `params.state`
 * (nguyên vẹn) và `_meta.roundTrip` (id + số round + state) để một
 * server instance khác cũng resume được.
 */
export function buildInputRequiredRetryParams(
  originalParams: Record<string, unknown>,
  roundTripId: string,
  round: number,
  answer: unknown,
  serverState: unknown,
): Record<string, unknown> {
  const params: Record<string, unknown> = { ...originalParams };
  const meta = buildStatelessMeta({
    roundTrip: { roundTripId, round, ...(serverState !== undefined ? { state: serverState } : {}) },
  });
  const withMeta = withStatelessMeta(params, meta);
  withMeta['answer'] = answer;
  withMeta['roundTripId'] = roundTripId;
  withMeta['round'] = round;
  if (serverState !== undefined) withMeta['state'] = serverState;
  return withMeta;
}

/**
 * Chạy một method qua các round `input_required` cho tới `complete`.
 * Server legacy (không trả `resultType`) bị TỪ CHỐI ở round đầu —
 * đó là lỗi protocol ở spec 2026, dùng driver `mrtr.ts` cũ cho
 * server đó. Provider trả đáp án sai schema → `InputRequiredError`
 * trước khi retry (không gửi đáp án hỏng lên server).
 */
export async function runInputRequiredLoop(
  transport: InputRequiredTransport,
  method: string,
  params: Record<string, unknown> | undefined,
  provider: InputProvider,
  options: InputRequiredLoopOptions = {},
): Promise<InputRequiredLoopOutcome> {
  const maxRounds = options.maxRounds ?? MCP_INPUT_REQUIRED_MAX_ROUNDS_DEFAULT;
  if (maxRounds < 1) throw new InputRequiredError('InputRequired: maxRounds phải >= 1');
  const validateAnswer = options.validateAnswer ?? true;
  const history: InputRequiredRoundRecord[] = [];
  let roundTripId: string | undefined;
  let serverState: unknown;
  let currentParams = params ? { ...params } : {};
  let round = 1;
  for (;;) {
    const raw = await transport.requestJsonRpc(method, currentParams);
    const parsed = parseSpecResult2026(raw);
    if (parsed.roundTripId) roundTripId = parsed.roundTripId;
    const record: InputRequiredRoundRecord = {
      round,
      method,
      resultType: parsed.resultType,
      ...(parsed.note ? { note: parsed.note } : {}),
    };
    history.push(record);
    options.onRound?.(record);
    if (parsed.resultType === 'complete') {
      return { result: parsed.result, rounds: round, roundTripId, history };
    }
    if (round >= maxRounds) {
      throw new InputRequiredError(
        `InputRequired: vượt quá ${maxRounds} round cho "${method}" (server vẫn cần input)`,
        'input_required',
        round,
      );
    }
    const input = parsed.input;
    if (parsed.state !== undefined) serverState = parsed.state;
    const { answer, state } = await provider(input, round, serverState);
    if (answer === undefined) {
      throw new InputRequiredError(
        `InputRequired: provider không trả đáp án ở round ${round} cho "${method}"`,
        'input_required',
        round,
      );
    }
    if (validateAnswer && input.schema) {
      const check = validateInputAgainstSchema(answer, input.schema);
      if (!check.valid) {
        throw new InputRequiredError(
          `InputRequired: đáp án round ${round} không khớp schema: ` +
            check.issues.map((i) => `${i.path || '(gốc)'} ${i.message}`).join('; '),
          'input_required',
          round,
        );
      }
    }
    const nextId = roundTripId ?? `ir-${method}-${Date.now()}`;
    roundTripId = nextId;
    if (state !== undefined) serverState = state;
    currentParams = buildInputRequiredRetryParams(
      params ?? {},
      nextId,
      round + 1,
      answer,
      serverState,
    );
    round += 1;
  }
}

/**
 * Chạy một `tools/call` qua vòng lặp input_required (tiện ích một
 * dòng trên `runInputRequiredLoop`). Kết quả cuối là payload thô của
 * round `complete` — caller tự parse theo dạng `tools/call`.
 */
export async function runToolCallInputRequired(
  transport: InputRequiredTransport,
  name: string,
  args: Record<string, unknown> = {},
  provider: InputProvider,
  options: InputRequiredLoopOptions = {},
): Promise<InputRequiredLoopOutcome> {
  return runInputRequiredLoop(
    transport,
    'tools/call',
    { name, arguments: args },
    provider,
    options,
  );
}

// ---------------------------------------------------------------------------
// Phía server: nhận diện + resume
// ---------------------------------------------------------------------------

/** Một tool handler result mang hình `InputRequiredResult`. */
export interface InputRequiredToolHandlerResult {
  resultType: 'input_required';
  input: InputRequest;
  state?: unknown;
  roundTripId?: string;
  note?: string;
}

/**
 * Nhận diện result của tool handler có phải `InputRequiredResult`
 * không (phía server). Handler trả hình này nghĩa là "chưa xong —
 * hỏi client rồi gọi lại tôi"; server phải trả thẳng, không bọc vào
 * content block (bọc vào thì client chỉ thấy text và vòng lặp chết).
 * Trả null khi result là tool result thường.
 */
export function extractInputRequiredResult(value: unknown): InputRequiredToolHandlerResult | null {
  if (!isRecord(value)) return null;
  if (value['resultType'] !== 'input_required') return null;
  const inputRaw = isRecord(value['input']) ? value['input'] : null;
  if (!inputRaw) return null;
  const out: InputRequiredToolHandlerResult = {
    resultType: 'input_required',
    input: {
      ...(typeof inputRaw['prompt'] === 'string' ? { prompt: inputRaw['prompt'] } : {}),
      ...(isRecord(inputRaw['schema']) ? { schema: inputRaw['schema'] } : {}),
      ...(isRecord(inputRaw['detail']) ? { detail: inputRaw['detail'] } : {}),
    },
  };
  if (value['state'] !== undefined) out.state = value['state'];
  if (typeof value['roundTripId'] === 'string') out.roundTripId = value['roundTripId'];
  if (typeof value['note'] === 'string') out.note = value['note'];
  return out;
}

/**
 * Đáp án + state một follow-up request mang theo (phía server resume).
 * Đọc từ params của request retry: `answer` + `state` + `roundTripId`
 * (+ `_meta.roundTrip` khi client gửi theo dạng stateless). Trả null
 * khi request không phải follow-up input_required.
 */
export function extractInputRequiredFollowUp(
  params: Record<string, unknown>,
): { answer: unknown; state?: unknown; roundTripId?: string; round?: number } | null {
  if (params['answer'] === undefined && params['state'] === undefined) return null;
  const meta = isRecord(params['_meta']) ? params['_meta'] : {};
  const roundTrip = isRecord(meta['roundTrip']) ? meta['roundTrip'] : {};
  return {
    answer: params['answer'],
    ...(params['state'] !== undefined ? { state: params['state'] } : {}),
    ...(typeof params['roundTripId'] === 'string'
      ? { roundTripId: params['roundTripId'] }
      : typeof roundTrip['roundTripId'] === 'string'
        ? { roundTripId: roundTrip['roundTripId'] as string }
        : {}),
    ...(typeof params['round'] === 'number'
      ? { round: params['round'] }
      : typeof roundTrip['round'] === 'number'
        ? { round: roundTrip['round'] as number }
        : {}),
  };
}

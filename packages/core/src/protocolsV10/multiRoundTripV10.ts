/**
 * Protocols v10 — multi round-trip requests (v1.41, Team T2).
 *
 * Idea only, learned from the public protocol descriptions in
 * docs/repo-survey-v141.md (section 1): multi round-trip
 * requests replace server-initiated requests (the old
 * sampling / elicitation callbacks, where the server called
 * back into the client mid-request). In the new shape the
 * server answers with an `input_required` result instead:
 * the client retries the original request with the answer
 * attached. The v8 Tasks layer already runs this loop inside
 * tasks; this module is the standalone, tool-call-level
 * version — any `tools/call` result may carry
 * `input_required`, and the client drives the rounds:
 *
 *   - `McpV10InputRequest`: what the server asks for — a
 *     named field, its type (`string` / `number` /
 *     `boolean` / `enum`), whether it is required, and an
 *     optional prompt for the user.
 *   - `validateMcpV10InputAnswer()`: schema-checks the
 *     client's answer before it is sent back (wrong type,
 *     missing required field, enum value outside the list
 *     are all refused locally, so a bad answer never reaches
 *     the server).
 *   - `McpV10RoundTripLoop`: runs a handler, and while the
 *     result asks for input, asks the caller's `answerInput`
 *     callback for the missing input and retries with the
 *     answer attached — up to `maxRounds` rounds, then fails
 *     loudly instead of looping forever. Every round is
 *     recorded, so the caller can show the user exactly what
 *     was asked and answered.
 *
 * No code, text or asset from any other repo is copied here.
 * No network: the handler and the answer callback are
 * host-supplied.
 */

/** Error raised by the multi round-trip layer. */
export class McpV10RoundTripError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'McpV10RoundTripError';
    this.code = code;
  }
}

/** Maximum input round-trips per call (loop guard). */
export const MCP_V10_MAX_INPUT_ROUNDS = 5;

/** Field types an `input_required` request may ask for. */
export const MCP_V10_INPUT_FIELD_TYPES = ['string', 'number', 'boolean', 'enum'] as const;
export type McpV10InputFieldType = (typeof MCP_V10_INPUT_FIELD_TYPES)[number];

/** One field the server asks the client to fill in. */
export interface McpV10InputField {
  /** Field name (the answer is keyed by this). */
  name: string;
  /** Field type. */
  type: McpV10InputFieldType;
  /** True when the answer must be present. */
  required?: boolean;
  /** Allowed values (enum only). */
  values?: string[];
  /** Prompt shown to the user (or the agent). */
  prompt?: string;
  /** Default value (used when the client answers with nothing and the field is optional). */
  default?: string | number | boolean;
}

/** What the server asks for in an `input_required` result. */
export interface McpV10InputRequest {
  /** Human-readable reason the input is needed. */
  reason: string;
  /** Fields to fill in. */
  fields: McpV10InputField[];
  /** How long the client has to answer (ms; undefined = no deadline). */
  timeoutMs?: number;
}

/** A tool result that asks for input (the server's answer shape). */
export interface McpV10InputRequiredResult {
  input_required: McpV10InputRequest;
  /** Partial progress the server already made (kept for the UI). */
  partial?: unknown;
}

/** True when a tool result carries `input_required`. */
export function isMcpV10InputRequiredResult(value: unknown): value is McpV10InputRequiredResult {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  if (typeof v.input_required !== 'object' || v.input_required === null || Array.isArray(v.input_required)) return false;
  const req = v.input_required as Record<string, unknown>;
  return typeof req.reason === 'string' && Array.isArray(req.fields);
}

/** Validate an `input_required` request. Returns problems. */
export function validateMcpV10InputRequest(request: unknown): string[] {
  const problems: string[] = [];
  if (typeof request !== 'object' || request === null || Array.isArray(request)) {
    problems.push('input_required must be an object.');
    return problems;
  }
  const r = request as Record<string, unknown>;
  if (typeof r.reason !== 'string' || r.reason.length === 0) {
    problems.push('input_required.reason must be a non-empty string.');
  }
  if (!Array.isArray(r.fields) || r.fields.length === 0) {
    problems.push('input_required.fields must be a non-empty array.');
    return problems;
  }
  const names = new Set<string>();
  for (let i = 0; i < r.fields.length; i += 1) {
    const f = r.fields[i] as Record<string, unknown>;
    if (typeof f !== 'object' || f === null || Array.isArray(f)) {
      problems.push(`input_required.fields[${i}] must be an object.`);
      continue;
    }
    if (typeof f.name !== 'string' || f.name.length === 0) {
      problems.push(`input_required.fields[${i}].name must be a non-empty string.`);
      continue;
    }
    if (names.has(f.name)) problems.push(`input_required.fields has a duplicate name "${f.name}".`);
    names.add(f.name);
    if (!(MCP_V10_INPUT_FIELD_TYPES as readonly string[]).includes(String(f.type))) {
      problems.push(`input_required.fields[${i}] ("${f.name}") has an unknown type "${String(f.type)}" (allowed: ${MCP_V10_INPUT_FIELD_TYPES.join(', ')}).`);
    }
    if (f.type === 'enum') {
      if (!Array.isArray(f.values) || f.values.length === 0 || f.values.some((v) => typeof v !== 'string')) {
        problems.push(`input_required.fields[${i}] ("${f.name}") is an enum and needs values (non-empty array of strings).`);
      }
    }
    if (f.required !== undefined && typeof f.required !== 'boolean') {
      problems.push(`input_required.fields[${i}] ("${f.name}") required must be a boolean.`);
    }
    if (f.prompt !== undefined && typeof f.prompt !== 'string') {
      problems.push(`input_required.fields[${i}] ("${f.name}") prompt must be a string.`);
    }
  }
  if (r.timeoutMs !== undefined && (!Number.isFinite(r.timeoutMs) || (r.timeoutMs as number) <= 0)) {
    problems.push('input_required.timeoutMs must be a positive number.');
  }
  return problems;
}

/** Validate one answer against one field. Returns problems. */
export function validateMcpV10InputAnswerField(
  field: McpV10InputField,
  answer: unknown,
): string[] {
  const problems: string[] = [];
  if (answer === undefined || answer === null) {
    if (field.required === true) problems.push(`Field "${field.name}" is required.`);
    return problems;
  }
  switch (field.type) {
    case 'string':
      if (typeof answer !== 'string') problems.push(`Field "${field.name}" must be a string.`);
      break;
    case 'number':
      if (typeof answer !== 'number' || !Number.isFinite(answer)) {
        problems.push(`Field "${field.name}" must be a finite number.`);
      }
      break;
    case 'boolean':
      if (typeof answer !== 'boolean') problems.push(`Field "${field.name}" must be a boolean.`);
      break;
    case 'enum':
      if (typeof answer !== 'string' || !(field.values ?? []).includes(answer)) {
        problems.push(`Field "${field.name}" must be one of: ${(field.values ?? []).join(', ')}.`);
      }
      break;
    default:
      problems.push(`Field "${field.name}" has an unknown type "${String(field.type)}".`);
  }
  return problems;
}

/**
 * Validate a whole answer object against an input request:
 * every required field must be present and correctly typed,
 * no unknown fields are allowed (a typo must not silently
 * pass), and optional fields fall back to their default.
 * Returns the normalised answer (defaults filled in) plus problems.
 */
export function validateMcpV10InputAnswer(
  request: McpV10InputRequest,
  answer: unknown,
): { ok: boolean; problems: string[]; normalised?: Record<string, unknown> } {
  const problems = validateMcpV10InputRequest(request);
  if (typeof answer !== 'object' || answer === null || Array.isArray(answer)) {
    problems.push('Answer must be an object keyed by field name.');
    return { ok: false, problems };
  }
  const a = answer as Record<string, unknown>;
  const known = new Set(request.fields.map((f) => f.name));
  for (const key of Object.keys(a)) {
    if (!known.has(key)) problems.push(`Answer has an unknown field "${key}".`);
  }
  const normalised: Record<string, unknown> = {};
  for (const field of request.fields) {
    const value = a[field.name];
    problems.push(...validateMcpV10InputAnswerField(field, value));
    if ((value === undefined || value === null) && field.default !== undefined) {
      normalised[field.name] = field.default;
    } else if (value !== undefined) {
      normalised[field.name] = value;
    }
  }
  return { ok: problems.length === 0, problems, normalised: problems.length === 0 ? normalised : undefined };
}

/** One completed round (what was asked, what was answered). */
export interface McpV10RoundTripRound {
  round: number;
  request: McpV10InputRequest;
  answer: Record<string, unknown>;
  /** Milliseconds the round took (ask → answer). */
  tookMs: number;
}

/** Result of driving a call through the round-trip loop. */
export interface McpV10RoundTripOutcome<T> {
  /** Final result (never an `input_required` — the loop finished or failed). */
  result: T;
  /** Rounds that ran (empty when the first call succeeded). */
  rounds: McpV10RoundTripRound[];
  /** Total rounds used (0 = no input was needed). */
  roundsUsed: number;
}

/** Answer provider: the caller fills in the requested fields. */
export type McpV10AnswerInput = (
  request: McpV10InputRequest,
  round: number,
) => Promise<Record<string, unknown>> | Record<string, unknown>;

/**
 * The round-trip loop: run a handler, and while its result
 * asks for input, ask the `answerInput` callback and retry
 * the handler with the answer attached — up to `maxRounds`
 * rounds, then fail loudly instead of looping forever.
 */
export class McpV10RoundTripLoop {
  readonly maxRounds: number;

  constructor(maxRounds = MCP_V10_MAX_INPUT_ROUNDS) {
    if (!Number.isInteger(maxRounds) || maxRounds < 1) {
      throw new McpV10RoundTripError('invalid-max-rounds', 'maxRounds must be a positive integer.');
    }
    this.maxRounds = maxRounds;
  }

  /**
   * Drive `handler(answersSoFar)` until it returns a result
   * that is not `input_required`. `answerInput` is called
   * once per round; its answer is schema-checked before the
   * retry, so a bad answer fails fast with a clear message.
   */
  async run<T>(
    handler: (answers: Record<string, unknown>) => Promise<T> | T,
    answerInput: McpV10AnswerInput,
  ): Promise<McpV10RoundTripOutcome<T>> {
    const answers: Record<string, unknown> = {};
    const rounds: McpV10RoundTripRound[] = [];
    for (let round = 1; ; round += 1) {
      const result = await handler({ ...answers });
      if (!isMcpV10InputRequiredResult(result)) {
        return { result, rounds, roundsUsed: rounds.length };
      }
      if (round > this.maxRounds) {
        throw new McpV10RoundTripError(
          'too-many-rounds',
          `Input round-trip exceeded ${this.maxRounds} rounds; refusing to loop forever. Last request: ${result.input_required.reason}`,
        );
      }
      const requestProblems = validateMcpV10InputRequest(result.input_required);
      if (requestProblems.length > 0) {
        throw new McpV10RoundTripError(
          'invalid-input-request',
          `Server asked for input with an invalid request: ${requestProblems.join(' ')}`,
        );
      }
      const startedAt = Date.now();
      const rawAnswer = await answerInput(result.input_required, round);
      const checked = validateMcpV10InputAnswer(result.input_required, rawAnswer);
      if (!checked.ok || !checked.normalised) {
        throw new McpV10RoundTripError(
          'invalid-answer',
          `Answer to round ${round} is invalid: ${checked.problems.join(' ')}`,
        );
      }
      Object.assign(answers, checked.normalised);
      rounds.push({
        round,
        request: result.input_required,
        answer: checked.normalised,
        tookMs: Date.now() - startedAt,
      });
    }
  }
}

/**
 * Build an `input_required` result (what a tool handler
 * returns when it needs input before it can finish).
 */
export function buildMcpV10InputRequiredResult(
  request: McpV10InputRequest,
  partial?: unknown,
): McpV10InputRequiredResult {
  const problems = validateMcpV10InputRequest(request);
  if (problems.length > 0) {
    throw new McpV10RoundTripError('invalid-input-request', `Cannot build input_required: ${problems.join(' ')}`);
  }
  return partial === undefined ? { input_required: request } : { input_required: request, partial };
}

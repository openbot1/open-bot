/**
 * Protocols v11 — Multi Round-Trip Requests, MRTR (v1.42, Team T2).
 *
 * Idea only, learned from the public MCP 2.0 description in
 * docs/repo-survey-v142.md (section 2): mid-request callbacks
 * (sampling, elicitation, roots) are dead; instead the server
 * answers a tool call with `resultType: "input_required"` and
 * the client calls again with the missing input (SEP-2322).
 * No code, text or asset from any other repo is copied here.
 *
 * What this module owns:
 *  - The `input_required` result shape + validation (the
 *    request must name the missing fields, each with a type
 *    and a prompt; the answer must satisfy the request).
 *  - Answer validation against a small JSON-schema subset
 *    (string / number / boolean / enum, required fields,
 *    min/max length, numeric bounds).
 *  - `McpV11RoundTripLoop`: drives a tool call through its
 *    rounds — at least 2 rounds are supported (the common
 *    case: first call asks, second call answers), up to
 *    `maxRounds` (default 5) before it fails loudly instead
 *    of looping forever. Every round is journaled so the
 *    host can audit what was asked and answered.
 *  - A demo tool handler (`mcpV11DemoConfirmHandler`) that
 *    asks for confirmation on round 1 and completes on
 *    round 2, for tests and for the tools layer.
 *
 * The loop never calls back into the server mid-request:
 * each round is a fresh, self-contained, stateless request
 * carrying its own `_meta`.
 */

/** One field the server asks the client (via the user) to fill in. */
export interface McpV11InputField {
  /** Field name, used as the key in the answer object. */
  name: string;
  /** Human-readable prompt shown to the user. */
  prompt: string;
  /** Field type. */
  type: 'string' | 'number' | 'boolean' | 'enum';
  /** Whether the answer must include this field. */
  required?: boolean;
  /** Allowed values (only for `enum`). */
  options?: string[];
  /** Minimum string length (only for `string`). */
  minLength?: number;
  /** Maximum string length (only for `string`). */
  maxLength?: number;
  /** Minimum value (only for `number`). */
  minimum?: number;
  /** Maximum value (only for `number`). */
  maximum?: number;
}

/** The server's request for more input. */
export interface McpV11InputRequest {
  /** Stable id for this input request (echoed in the answer). */
  id: string;
  /** Short title, e.g. "Confirm deletion". */
  title: string;
  /** Why the server needs this input. */
  reason: string;
  /** Fields the client must answer. */
  fields: McpV11InputField[];
}

/** A tool result that asks for more input. */
export interface McpV11InputRequiredResult {
  resultType: 'input_required';
  inputRequest: McpV11InputRequest;
  /** What the server already did before asking (partial progress). */
  partial?: Record<string, unknown>;
}

/** A tool result that is final. */
export interface McpV11FinalResult {
  resultType: 'completed';
  result: Record<string, unknown>;
}

/** Either shape a tool handler may return to the loop. */
export type McpV11RoundTripResult = McpV11InputRequiredResult | McpV11FinalResult;

/** One journal entry: what was asked, what was answered, when. */
export interface McpV11RoundJournalEntry {
  round: number;
  askedAtMs: number;
  inputRequest: McpV11InputRequest | null;
  answer: Record<string, unknown> | null;
  problems: string[];
}

/** Outcome of a full round-trip run. */
export interface McpV11RoundTripOutcome {
  /** Final tool result. */
  result: Record<string, unknown>;
  /** Number of rounds the run took (>= 1). */
  rounds: number;
  /** Full journal, one entry per round. */
  journal: McpV11RoundJournalEntry[];
  /** True when the run needed more than one round. */
  multiRound: boolean;
}

/** Error raised by the round-trip loop. */
export class McpV11RoundTripError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'McpV11RoundTripError';
    this.code = code;
  }
}

/** Maximum input rounds per tool call (loop guard). */
export const MCP_V11_MAX_INPUT_ROUNDS = 5;
/** Minimum rounds the loop is built to support (spec: at least 2). */
export const MCP_V11_MIN_SUPPORTED_ROUNDS = 2;

/** Is this result an `input_required` round? */
export function isMcpV11InputRequired(result: unknown): result is McpV11InputRequiredResult {
  return (
    typeof result === 'object' &&
    result !== null &&
    (result as Record<string, unknown>).resultType === 'input_required'
  );
}

/** Build an `input_required` result (server side). */
export function buildMcpV11InputRequiredResult(
  inputRequest: McpV11InputRequest,
  partial?: Record<string, unknown>,
): McpV11InputRequiredResult {
  return {
    resultType: 'input_required',
    inputRequest,
    ...(partial ? { partial } : {}),
  };
}

/** Validate an input request. Returns problems (empty = valid). */
export function validateMcpV11InputRequest(request: unknown): string[] {
  const problems: string[] = [];
  if (typeof request !== 'object' || request === null || Array.isArray(request)) {
    return ['inputRequest must be an object.'];
  }
  const r = request as Record<string, unknown>;
  if (typeof r.id !== 'string' || !r.id) problems.push('inputRequest.id is required.');
  if (typeof r.title !== 'string' || !r.title) problems.push('inputRequest.title is required.');
  if (typeof r.reason !== 'string' || !r.reason) problems.push('inputRequest.reason is required.');
  if (!Array.isArray(r.fields) || r.fields.length === 0) {
    problems.push('inputRequest.fields must be a non-empty array.');
    return problems;
  }
  const names = new Set<string>();
  for (const [i, field] of (r.fields as unknown[]).entries()) {
    const prefix = `inputRequest.fields[${i}]`;
    if (typeof field !== 'object' || field === null || Array.isArray(field)) {
      problems.push(`${prefix} must be an object.`);
      continue;
    }
    const f = field as Record<string, unknown>;
    if (typeof f.name !== 'string' || !f.name) problems.push(`${prefix}.name is required.`);
    else if (names.has(f.name)) problems.push(`${prefix}.name "${f.name}" is duplicated.`);
    else names.add(f.name);
    if (typeof f.prompt !== 'string' || !f.prompt) problems.push(`${prefix}.prompt is required.`);
    if (!['string', 'number', 'boolean', 'enum'].includes(String(f.type))) {
      problems.push(`${prefix}.type must be string | number | boolean | enum.`);
    }
    if (f.type === 'enum') {
      if (!Array.isArray(f.options) || f.options.length === 0 || f.options.some((o) => typeof o !== 'string')) {
        problems.push(`${prefix}.options must be a non-empty array of strings for enum fields.`);
      }
    }
    if (f.required !== undefined && typeof f.required !== 'boolean') {
      problems.push(`${prefix}.required must be a boolean.`);
    }
    if (f.minLength !== undefined && (typeof f.minLength !== 'number' || f.minLength < 0)) {
      problems.push(`${prefix}.minLength must be a non-negative number.`);
    }
    if (f.maxLength !== undefined && (typeof f.maxLength !== 'number' || f.maxLength < 0)) {
      problems.push(`${prefix}.maxLength must be a non-negative number.`);
    }
    if (f.minLength !== undefined && f.maxLength !== undefined && (f.minLength as number) > (f.maxLength as number)) {
      problems.push(`${prefix}.minLength must not exceed maxLength.`);
    }
    if (f.minimum !== undefined && f.maximum !== undefined && (f.minimum as number) > (f.maximum as number)) {
      problems.push(`${prefix}.minimum must not exceed maximum.`);
    }
  }
  return problems;
}

/** Validate an answer against an input request. Returns problems (empty = valid). */
export function validateMcpV11InputAnswer(
  request: McpV11InputRequest,
  answer: unknown,
): string[] {
  const problems: string[] = [];
  if (typeof answer !== 'object' || answer === null || Array.isArray(answer)) {
    return ['answer must be an object keyed by field name.'];
  }
  const a = answer as Record<string, unknown>;
  for (const field of request.fields) {
    const value = a[field.name];
    const label = `answer.${field.name}`;
    if (value === undefined || value === null) {
      if (field.required !== false) problems.push(`${label} is required.`);
      continue;
    }
    switch (field.type) {
      case 'string':
        if (typeof value !== 'string') problems.push(`${label} must be a string.`);
        else {
          if (field.minLength !== undefined && value.length < field.minLength) {
            problems.push(`${label} must be at least ${field.minLength} characters.`);
          }
          if (field.maxLength !== undefined && value.length > field.maxLength) {
            problems.push(`${label} must be at most ${field.maxLength} characters.`);
          }
        }
        break;
      case 'number':
        if (typeof value !== 'number' || Number.isNaN(value)) problems.push(`${label} must be a number.`);
        else {
          if (field.minimum !== undefined && value < field.minimum) {
            problems.push(`${label} must be >= ${field.minimum}.`);
          }
          if (field.maximum !== undefined && value > field.maximum) {
            problems.push(`${label} must be <= ${field.maximum}.`);
          }
        }
        break;
      case 'boolean':
        if (typeof value !== 'boolean') problems.push(`${label} must be a boolean.`);
        break;
      case 'enum':
        if (typeof value !== 'string' || !(field.options ?? []).includes(value)) {
          problems.push(`${label} must be one of: ${(field.options ?? []).join(', ')}.`);
        }
        break;
    }
  }
  for (const key of Object.keys(a)) {
    if (!request.fields.some((f) => f.name === key)) {
      problems.push(`answer.${key} is not a field in this input request.`);
    }
  }
  return problems;
}

/** A tool call the loop drives: (args, round) => result. */
export type McpV11RoundTripCall = (
  args: Record<string, unknown>,
  round: number,
) => McpV11RoundTripResult | Promise<McpV11RoundTripResult>;

/** How the loop gets an answer for an input request. */
export type McpV11AnswerInput = (
  request: McpV11InputRequest,
  round: number,
) => Record<string, unknown> | Promise<Record<string, unknown>>;

/**
 * Drive a tool call through its input rounds.
 *
 * Round 1 calls the tool with the original args. When the
 * tool answers `input_required`, the loop validates the
 * request, asks `answerInput` for the answer, validates the
 * answer, and calls the tool again with the answer merged
 * into the args (plus `_inputRequestId` so the tool can
 * match the round). The loop stops at the first `completed`
 * result, or throws when `maxRounds` is exceeded or an
 * answer fails validation.
 */
export class McpV11RoundTripLoop {
  constructor(private readonly maxRounds: number = MCP_V11_MAX_INPUT_ROUNDS) {}

  async run(opts: {
    args?: Record<string, unknown>;
    call: McpV11RoundTripCall;
    answerInput: McpV11AnswerInput;
  }): Promise<McpV11RoundTripOutcome> {
    const journal: McpV11RoundJournalEntry[] = [];
    let args: Record<string, unknown> = { ...(opts.args ?? {}) };
    let round = 0;
    for (;;) {
      round += 1;
      if (round > this.maxRounds) {
        throw new McpV11RoundTripError(
          'max-rounds',
          `max-rounds: Tool still asks for input after ${this.maxRounds} rounds; refusing to loop forever.`,
        );
      }
      const raw = await opts.call(args, round);
      if (!isMcpV11InputRequired(raw)) {
        const finalResult = (raw as McpV11FinalResult).result ?? (raw as unknown as Record<string, unknown>);
        journal.push({ round, askedAtMs: Date.now(), inputRequest: null, answer: null, problems: [] });
        return { result: finalResult, rounds: round, journal, multiRound: round > 1 };
      }
      const requestProblems = validateMcpV11InputRequest(raw.inputRequest);
      if (requestProblems.length > 0) {
        journal.push({ round, askedAtMs: Date.now(), inputRequest: raw.inputRequest, answer: null, problems: requestProblems });
        throw new McpV11RoundTripError('invalid-input-request', 'invalid-input-request: Server input request is invalid: ' + requestProblems.join(' '));
      }
      const answer = await opts.answerInput(raw.inputRequest, round);
      const answerProblems = validateMcpV11InputAnswer(raw.inputRequest, answer);
      journal.push({ round, askedAtMs: Date.now(), inputRequest: raw.inputRequest, answer, problems: answerProblems });
      if (answerProblems.length > 0) {
        throw new McpV11RoundTripError('invalid-answer', 'invalid-answer: Answer failed validation: ' + answerProblems.join(' '));
      }
      args = { ...args, ...answer, _inputRequestId: raw.inputRequest.id };
    }
  }
}

/**
 * Demo tool handler: asks for confirmation on round 1 and
 * completes on round 2. The tools layer wires this into the
 * loopback server so the MRTR path can be exercised without
 * any real server.
 */
export function mcpV11DemoConfirmHandler(
  args: Record<string, unknown>,
  round: number,
): McpV11RoundTripResult {
  if (round === 1 && args.confirmed !== true) {
    return buildMcpV11InputRequiredResult(
      {
        id: 'confirm-delete',
        title: 'Confirm deletion',
        reason: 'The tool is about to delete the named item and needs explicit confirmation first.',
        fields: [
          { name: 'confirmed', prompt: 'Do you really want to delete this item?', type: 'boolean', required: true },
          { name: 'reason', prompt: 'Why are you deleting it? (optional)', type: 'string', required: false, maxLength: 200 },
        ],
      },
      { plannedAction: 'delete', item: args.item ?? 'unnamed-item' },
    );
  }
  if (args.confirmed !== true) {
    return buildMcpV11InputRequiredResult(
      {
        id: 'confirm-delete',
        title: 'Confirm deletion',
        reason: 'Confirmation is still missing.',
        fields: [{ name: 'confirmed', prompt: 'Do you really want to delete this item?', type: 'boolean', required: true }],
      },
    );
  }
  return {
    resultType: 'completed',
    result: { deleted: true, item: args.item ?? 'unnamed-item', reason: args.reason ?? '', rounds: round },
  };
}

/** A second demo handler that asks twice (3 rounds total) for the multi-round test. */
export function mcpV11DemoTwoStepHandler(
  args: Record<string, unknown>,
  round: number,
): McpV11RoundTripResult {
  if (round === 1) {
    return buildMcpV11InputRequiredResult({
      id: 'pick-mode',
      title: 'Pick a mode',
      reason: 'The tool needs a mode before it can proceed.',
      fields: [{ name: 'mode', prompt: 'Which mode?', type: 'enum', required: true, options: ['fast', 'safe'] }],
    });
  }
  if (round === 2) {
    return buildMcpV11InputRequiredResult({
      id: 'pick-count',
      title: 'Pick a count',
      reason: 'The tool needs a count for the chosen mode.',
      fields: [{ name: 'count', prompt: 'How many?', type: 'number', required: true, minimum: 1, maximum: 10 }],
    });
  }
  return { resultType: 'completed', result: { mode: args.mode, count: args.count, rounds: round } };
}

/**
 * Protocols v3 — Multi Round-Trip Requests v3 (v1.19, Team T3).
 *
 * Idea only, learned from the public MCP spec 2026-07-28 description
 * in docs/repo-survey-v119.md section 2: Multi Round-Trip Requests
 * let a server answer a call with `input_required` (and the related
 * follow-up kinds) instead of failing, so the client supplies the
 * missing input and the same call continues — each round an
 * independent stateless request. No code, text or asset from any
 * other repo is copied here.
 *
 * This builds on the existing MRTR driver without touching it:
 *  - `mcp/mrtr.ts` — `MrtrResult` / `MrtrNeed`, `parseMrtrResult`,
 *    `buildMrtrResult`, `resolveMrtrNeed`, `runMultiRoundTrip`
 *    (rounds, budget, confirmation refusal, stateless continuation
 *    in `_meta.roundTrip`).
 * v3 adds the missing product layer:
 *   1. `input_required` as the canonical v3 result type — the spec
 *      name for "the server needs more input before it can answer";
 *      `needs_input` (v1) is accepted as its alias, and results are
 *      normalised to `input_required` on the way in;
 *   2. a v3 driver (`MrtrV3Driver`) with per-round timeout, explicit
 *      cancellation, a full transcript (every round's need + answer
 *      + duration), and a deprecated-kind policy: a server that asks
 *      for `needs_roots` / `needs_sampling` through the deprecated
 *      callback shape is warned or refused according to the
 *      `DeprecatedFeatureGate` from `mcpStatelessV3.ts`;
 *   3. answer validation — an answer for an `input_required` round
 *      is checked against the `schema` the server sent (required
 *      keys, primitive types) before it is sent, so a malformed
 *      answer fails locally instead of burning another round;
 *   4. a server-side helper (`MrtrV3Server`) that issues
 *      `input_required` rounds from a step function, so the built-in
 *      server and tests can drive multi-round tools without hand-
 *      rolling the protocol.
 *
 * Nothing here touches the network: the transport is injected.
 * Answers are never logged in full (only their key names + sizes).
 */

import {
  MCP_MRTR_MAX_ROUNDS_DEFAULT,
  buildMrtrResult,
  parseMrtrResult,
  resolveMrtrNeed,
  type MrtrHandlers,
  type MrtrNeed,
  type MrtrResult,
  type MrtrResultType,
  type MrtrRoundRecord,
  type MrtrTransport,
} from '../mcp/mrtr';
import { DeprecatedFeatureGate } from './mcpStatelessV3';

/** Error raised by the v3 MRTR driver. */
export class MrtrV3Error extends Error {
  readonly code: string;
  readonly round?: number;
  constructor(code: string, message: string, round?: number) {
    super(message);
    this.name = 'MrtrV3Error';
    this.code = code;
    this.round = round;
  }
}

/**
 * Canonical v3 result type. `input_required` is the spec 2026-07-28
 * name; `needs_input` is the v1 alias for the same thing.
 */
export type MrtrV3ResultType = MrtrResultType | 'input_required';

/** Follow-up kinds the v3 driver can answer. */
export const MRTR_V3_FOLLOW_UP_TYPES: readonly MrtrV3ResultType[] = [
  'input_required',
  'needs_input',
  'needs_sampling',
  'needs_elicitation',
  'needs_roots',
  'needs_confirmation',
];

/** Result types that come from a deprecated callback shape. */
export const MRTR_V3_DEPRECATED_TYPES: readonly MrtrResultType[] = [
  'needs_sampling',
  'needs_roots',
];

/** Normalise a server result type to the canonical v3 name. */
export function normaliseMrtrV3ResultType(value: unknown): MrtrV3ResultType | null {
  if (value === 'input_required' || value === 'needs_input') return 'input_required';
  if (
    value === 'complete' ||
    value === 'needs_sampling' ||
    value === 'needs_elicitation' ||
    value === 'needs_roots' ||
    value === 'needs_confirmation'
  ) {
    return value as MrtrResultType;
  }
  return null;
}

/** True when the result type is the v3 input round (`input_required`). */
export function isMrtrV3InputRequired(value: unknown): boolean {
  return value === 'input_required' || value === 'needs_input';
}

/** One round of a v3 transcript (need + answer + timing). */
export interface MrtrV3RoundTranscript {
  round: number;
  method: string;
  resultType: MrtrV3ResultType;
  /** What the server asked for (prompt + schema keys only, no values). */
  needSummary: string;
  /** Keys of the answer that was sent (values never recorded). */
  answerKeys: string[];
  /** Round duration in ms (server wait + handler time). */
  durationMs: number;
  note?: string;
}

/** Outcome of a full v3 multi-round-trip call. */
export interface MrtrV3CallOutcome {
  /** Final payload from the server's `complete` round. */
  result: unknown;
  /** How many rounds the call took (1 = single round). */
  rounds: number;
  /** Stable id the server assigned (when it assigned one). */
  roundTripId?: string;
  /** Per-round history (v1 shape, for the activity feed). */
  history: MrtrRoundRecord[];
  /** Full transcript (need + answer keys + timing). */
  transcript: MrtrV3RoundTranscript[];
  /** Total wall time in ms. */
  totalMs: number;
}

/** Options for the v3 driver. */
export interface MrtrV3DriverOptions {
  /** Max rounds (default 8, same as v1). */
  maxRounds?: number;
  /** Per-round timeout in ms (0 = no timeout). */
  roundTimeoutMs?: number;
  /** Deprecated-feature gate (default: warn on sampling/roots). */
  deprecationGate?: DeprecatedFeatureGate;
  /** Called after every round (live progress for the UI). */
  onRound?: (record: MrtrRoundRecord) => void;
  /** Called after every answered round (transcript entry). */
  onTranscript?: (entry: MrtrV3RoundTranscript) => void;
}

/** Minimal JSON-Schema subset the v3 driver validates answers against. */
export interface MrtrV3AnswerSchema {
  required?: string[];
  properties?: Record<string, { type?: string }>;
}

/**
 * Validate an `input_required` answer against the schema the server
 * sent. Checks required keys and primitive types (`string`,
 * `number`, `boolean`, `object`, `array`, `integer`); unknown extra
 * keys are allowed. Returns the problems (empty = valid).
 */
export function validateMrtrV3Answer(
  answer: unknown,
  schema: MrtrV3AnswerSchema | Record<string, unknown> | undefined,
): string[] {
  const problems: string[] = [];
  if (!schema || typeof schema !== 'object') return problems;
  const required = Array.isArray((schema as MrtrV3AnswerSchema).required)
    ? (schema as MrtrV3AnswerSchema).required!
    : [];
  const properties = (schema as MrtrV3AnswerSchema).properties ?? {};
  if (required.length > 0 || Object.keys(properties).length > 0) {
    if (typeof answer !== 'object' || answer === null || Array.isArray(answer)) {
      problems.push('Answer must be an object when the server sent a schema');
      return problems;
    }
    const record = answer as Record<string, unknown>;
    for (const key of required) {
      if (record[key] === undefined || record[key] === null) {
        problems.push(`Missing required field: ${key}`);
      }
    }
    for (const [key, prop] of Object.entries(properties)) {
      const value = record[key];
      if (value === undefined || value === null) continue;
      const expected = (prop as { type?: string }).type;
      if (!expected) continue;
      const actual = Array.isArray(value) ? 'array' : typeof value;
      const ok =
        expected === 'integer'
          ? typeof value === 'number' && Number.isInteger(value)
          : actual === expected;
      if (!ok) problems.push(`Field ${key} must be ${expected}, got ${actual}`);
    }
  }
  return problems;
}

/** Summarise a need for the transcript (no secret values). */
function summariseNeed(need: MrtrNeed): string {
  const parts: string[] = [need.resultType];
  if (need.prompt) parts.push(need.prompt.slice(0, 120));
  if (need.schema && typeof need.schema === 'object') {
    const required = (need.schema as { required?: unknown }).required;
    if (Array.isArray(required)) parts.push(`required: ${required.join(', ')}`);
  }
  return parts.join(' — ');
}

/** Keys of an answer (for the transcript; values never recorded). */
function answerKeysOf(answer: unknown): string[] {
  if (typeof answer === 'object' && answer !== null && !Array.isArray(answer)) {
    return Object.keys(answer as Record<string, unknown>);
  }
  if (typeof answer === 'string') return ['<text>'];
  return ['<value>'];
}

function withTimeout<T>(promise: Promise<T>, ms: number, round: number): Promise<T> {
  if (ms <= 0) return promise;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new MrtrV3Error('ROUND_TIMEOUT', `MRTR round ${round} timed out after ${ms}ms`, round)),
      ms,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/**
 * v3 MRTR driver: runs a method through as many rounds as the server
 * asks for, normalising `input_required` / `needs_input`, validating
 * answers against the server's schema, enforcing a per-round timeout
 * and a round budget, and honouring the deprecated-feature gate for
 * `needs_sampling` / `needs_roots`. Cancellation stops the loop
 * between rounds (the in-flight request is left to finish; the
 * transport owns its own abort).
 */
export class MrtrV3Driver {
  private readonly maxRounds: number;
  private readonly roundTimeoutMs: number;
  private readonly gate: DeprecatedFeatureGate;
  private readonly onRound?: (record: MrtrRoundRecord) => void;
  private readonly onTranscript?: (entry: MrtrV3RoundTranscript) => void;
  private cancelled = false;

  constructor(options: MrtrV3DriverOptions = {}) {
    this.maxRounds = options.maxRounds ?? MCP_MRTR_MAX_ROUNDS_DEFAULT;
    if (this.maxRounds < 1) {
      throw new MrtrV3Error('BAD_BUDGET', 'MRTR v3: maxRounds must be >= 1');
    }
    this.roundTimeoutMs = options.roundTimeoutMs ?? 0;
    this.gate = options.deprecationGate ?? new DeprecatedFeatureGate();
    this.onRound = options.onRound;
    this.onTranscript = options.onTranscript;
  }

  /** Cancel the loop (takes effect between rounds). */
  cancel(): void {
    this.cancelled = true;
  }

  /** True when `cancel()` was called. */
  isCancelled(): boolean {
    return this.cancelled;
  }

  /** The deprecation gate this driver uses. */
  getDeprecationGate(): DeprecatedFeatureGate {
    return this.gate;
  }

  async run(
    transport: MrtrTransport,
    method: string,
    params: Record<string, unknown> | undefined,
    handlers: MrtrHandlers,
  ): Promise<MrtrV3CallOutcome> {
    const startedAt = Date.now();
    const history: MrtrRoundRecord[] = [];
    const transcript: MrtrV3RoundTranscript[] = [];
    const answers: Record<string, unknown> = {};
    let roundTripId: string | undefined;
    let currentParams = params ? { ...params } : {};
    let round = 1;
    for (;;) {
      if (this.cancelled) {
        throw new MrtrV3Error('CANCELLED', `MRTR call to "${method}" cancelled before round ${round}`, round);
      }
      const roundStarted = Date.now();
      const raw = await withTimeout(
        transport.requestJsonRpc(method, currentParams),
        this.roundTimeoutMs,
        round,
      );
      // A v3 server sends the canonical `input_required` name on the
      // wire; the v1 parser only knows the `needs_input` alias, so
      // translate before parsing — otherwise the canonical name is
      // rejected before normalisation can ever see it.
      const rawForParse: unknown =
        typeof raw === 'object' && raw !== null && !Array.isArray(raw)
          && (raw as Record<string, unknown>)['resultType'] === 'input_required'
          ? { ...(raw as Record<string, unknown>), resultType: 'needs_input' }
          : raw;
      const parsed: MrtrResult = parseMrtrResult(rawForParse);
      const canonical = normaliseMrtrV3ResultType(parsed.resultType);
      if (canonical === null) {
        throw new MrtrV3Error(
          'UNKNOWN_RESULT_TYPE',
          `MRTR: unknown resultType ${JSON.stringify(parsed.resultType)} for "${method}"`,
          round,
        );
      }
      if (parsed.roundTripId) roundTripId = parsed.roundTripId;
      const record: MrtrRoundRecord = {
        round,
        method,
        resultType: parsed.resultType,
        ...(parsed.note ? { note: parsed.note } : {}),
      };
      history.push(record);
      this.onRound?.(record);
      if (canonical === 'complete') {
        return {
          result: parsed.result,
          rounds: round,
          roundTripId,
          history,
          transcript,
          totalMs: Date.now() - startedAt,
        };
      }
      if (round >= this.maxRounds) {
        throw new MrtrV3Error(
          'ROUND_BUDGET_EXCEEDED',
          `MRTR: exceeded ${this.maxRounds} rounds for "${method}" (server still needs ${canonical})`,
          round,
        );
      }
      // Deprecated-kind policy: sampling/roots through the old shape.
      if ((MRTR_V3_DEPRECATED_TYPES as readonly string[]).includes(canonical)) {
        const methodName =
          canonical === 'needs_sampling' ? 'sampling/createMessage' : 'roots/list';
        const check = this.gate.check(methodName);
        if (!check.ok) {
          throw new MrtrV3Error('DEPRECATED_BLOCKED', check.reason, round);
        }
      }
      // At this point `complete` has already returned above, so the
      // follow-up type is never 'complete' (the compiler narrows
      // `canonical` past the early return; the switch below is
      // exhaustive over the remaining cases).
      const followUpType: MrtrNeed['resultType'] = ((): MrtrNeed['resultType'] => {
        switch (canonical) {
          case 'input_required': return 'needs_input';
          case 'needs_input':
          case 'needs_sampling':
          case 'needs_elicitation':
          case 'needs_roots':
          case 'needs_confirmation': return canonical;
        }
      })();
      const need: MrtrNeed = parsed.need ?? { resultType: followUpType };
      const normalisedNeed: MrtrNeed = {
        ...need,
        resultType: followUpType,
      };
      const answer = await withTimeout(
        resolveMrtrNeed(normalisedNeed, round, handlers),
        this.roundTimeoutMs,
        round,
      );
      if (normalisedNeed.resultType === 'needs_confirmation' && answer === false) {
        throw new MrtrV3Error(
          'CONFIRMATION_DENIED',
          `MRTR: user denied confirmation at round ${round} for "${method}"`,
          round,
        );
      }
      // Validate input answers against the server's schema.
      if (canonical === 'input_required' && need.schema) {
        const problems = validateMrtrV3Answer(answer, need.schema as MrtrV3AnswerSchema);
        if (problems.length > 0) {
          throw new MrtrV3Error(
            'INVALID_ANSWER',
            `MRTR: answer for round ${round} failed the server schema: ${problems.join('; ')}`,
            round,
          );
        }
      }
      answers[`round${round}`] = answer;
      const entry: MrtrV3RoundTranscript = {
        round,
        method,
        resultType: canonical,
        needSummary: summariseNeed(need),
        answerKeys: answerKeysOf(answer),
        durationMs: Date.now() - roundStarted,
        ...(parsed.note ? { note: parsed.note } : {}),
      };
      transcript.push(entry);
      this.onTranscript?.(entry);
      const nextId = roundTripId ?? `mrtr-v3-${method}-${Date.now()}`;
      roundTripId = nextId;
      const followUp: Record<string, unknown> = {
        ...(params ?? {}),
        answer,
        roundTripId: nextId,
        round: round + 1,
        previousAnswers: { ...answers },
      };
      // Carry the stateless continuation in _meta like the v1 driver.
      const meta = { protocolVersion: '2026-07-28', roundTrip: { roundTripId: nextId, round: round + 1 } };
      followUp['_meta'] = meta;
      currentParams = followUp;
      round += 1;
    }
  }
}

/**
 * Build a server-side `input_required` result (v3 canonical shape).
 * A `complete` result is built the same way via `buildMrtrResult`.
 */
export function buildMrtrV3InputRequired(
  options: {
    prompt?: string;
    schema?: Record<string, unknown>;
    detail?: Record<string, unknown>;
    roundTripId?: string;
    note?: string;
  } = {},
): Record<string, unknown> {
  return buildMrtrResult('needs_input', {
    need: {
      prompt: options.prompt,
      schema: options.schema,
      detail: options.detail,
    },
    roundTripId: options.roundTripId,
    note: options.note,
  });
}

/** One step of a server-side multi-round tool. */
export interface MrtrV3ServerStep {
  /** What the step needs, or null when the step can finish. */
  need?: Omit<MrtrNeed, 'resultType'> & { resultType?: MrtrV3ResultType };
  /** Final result when the step finishes (ignored while `need` is set). */
  result?: unknown;
}

/**
 * Server-side helper: drives a step function through `input_required`
 * rounds. The step function receives the accumulated answers and
 * returns either the next need or the final result. The helper keeps
 * no session — the caller passes the accumulated answers back in on
 * every call (stateless, like the client driver).
 */
export class MrtrV3Server {
  private readonly roundTripId: string;

  constructor(roundTripId?: string) {
    this.roundTripId = roundTripId ?? `mrtr-v3-server-${Date.now()}`;
  }

  /** Stable id for this round trip. */
  getRoundTripId(): string {
    return this.roundTripId;
  }

  /**
   * Run one step. `answers` are the answers the client sent so far
   * (keyed `round1`, `round2`, ...). Returns the JSON-RPC result
   * object to send back: `input_required` with a need, or `complete`.
   */
  step(
    answers: Record<string, unknown>,
    stepFn: (answers: Record<string, unknown>) => MrtrV3ServerStep,
  ): Record<string, unknown> {
    const step = stepFn(answers);
    if (step.need) {
      const resultType = step.need.resultType ?? 'input_required';
      const v1Type: MrtrResultType =
        resultType === 'input_required' ? 'needs_input' : resultType;
      return buildMrtrResult(v1Type, {
        need: {
          prompt: step.need.prompt,
          schema: step.need.schema,
          detail: step.need.detail,
        },
        roundTripId: this.roundTripId,
      });
    }
    return buildMrtrResult('complete', {
      result: step.result ?? null,
      roundTripId: this.roundTripId,
    });
  }
}

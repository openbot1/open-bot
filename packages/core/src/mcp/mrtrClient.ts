/**
 * MRTR wired into tool calls (v1.04, Team T2).
 *
 * v0.97 built the MRTR driver (`mrtr.ts`: `runMultiRoundTrip`,
 * `parseMrtrResult`, `buildMrtrResult`) but only
 * `packages/tools/src/mcpV097Tools.ts` used it — the client itself
 * never noticed when a `tools/call` answered `resultType:
 * needs_input` (or any other follow-up kind). This module is the
 * missing wiring:
 *
 *   - `runToolCallMultiRoundTrip`: run one `tools/call` through
 *     as many rounds as the server asks for, on top of any
 *     transport that speaks raw JSON-RPC
 *     (`{ requestJsonRpc }` — the real client and fakes alike).
 *     The final `complete` round's payload is the raw `tools/call`
 *     result; the caller parses it with `parseToolCallResult`
 *     (kept in `client.ts` to avoid a client <-> mrtr import
 *     cycle — this module never imports `client.ts`).
 *   - `buildDefaultMrtrHandlers`: build the MRTR handlers from
 *     the pieces a coordinator already has — an elicitation
 *     function (ask the user), a roots provider (workspace list),
 *     a confirmation function (approve / refuse), an input
 *     supplier and a sampling function. Every handler is optional
 *     in the input; a missing handler for a kind the server asks
 *     for fails the call with `MrtrError` instead of inventing
 *     an answer — exactly like the driver.
 *   - `extractMrtrToolResult`: the server-side half — detect a
 *     tool handler result that IS an MRTR result (`resultType` at
 *     the top level) so `server.ts` can pass it through unwrapped
 *     instead of burying it inside a content block.
 *
 * Ideas only — no code copied from any MCP implementation, SDK,
 * or the Grok Bot / Cursor installers. This module never calls a
 * model, never prompts a user and never touches the network: it
 * only orchestrates round trips through injected callbacks.
 */

import {
  MCP_MRTR_MAX_ROUNDS_DEFAULT,
  runMultiRoundTrip,
  type MrtrCallOutcome,
  type MrtrHandlers,
  type MrtrNeed,
  type MrtrResultType,
} from './mrtr';

/** Minimal transport: raw JSON-RPC, one method at a time. */
export interface MrtrToolTransport {
  requestJsonRpc(method: string, params?: Record<string, unknown>): Promise<unknown>;
}

/** Options for one MRTR tool call. */
export interface MrtrToolCallOptions {
  /** Round budget (default 8, see `MCP_MRTR_MAX_ROUNDS_DEFAULT`). */
  maxRounds?: number;
  /** Protocol version to declare in each round's `_meta`. */
  protocolVersion?: string;
}

/** Outcome of one MRTR `tools/call`, with the final raw result. */
export interface MrtrToolCallOutcome {
  /** Raw `tools/call` result from the final `complete` round. */
  result: unknown;
  /** How many round trips the call took (1 = single round). */
  rounds: number;
  /** Stable id the server assigned (when it assigned one). */
  roundTripId?: string;
  /** Per-round history, for the activity feed / tracing. */
  history: MrtrCallOutcome['history'];
}

/**
 * Run `tools/call` through MRTR rounds on any JSON-RPC transport.
 * A legacy server that never returns `resultType` answers in one
 * round (the driver treats a result without `resultType` as
 * `complete`), so old servers keep working unchanged.
 */
export async function runToolCallMultiRoundTrip(
  transport: MrtrToolTransport,
  name: string,
  args: Record<string, unknown> = {},
  handlers: MrtrHandlers = {},
  options: MrtrToolCallOptions = {},
): Promise<MrtrToolCallOutcome> {
  const outcome = await runMultiRoundTrip(
    transport,
    'tools/call',
    { name, arguments: args },
    handlers,
    {
      maxRounds: options.maxRounds ?? MCP_MRTR_MAX_ROUNDS_DEFAULT,
      ...(options.protocolVersion ? { protocolVersion: options.protocolVersion } : {}),
    },
  );
  return {
    result: outcome.result,
    rounds: outcome.rounds,
    ...(outcome.roundTripId ? { roundTripId: outcome.roundTripId } : {}),
    history: outcome.history,
  };
}

/**
 * Pieces a coordinator can supply to answer MRTR follow-ups.
 * All optional — only the kinds the coordinator can actually
 * answer should be provided; the rest stay unregistered and the
 * driver fails loudly if the server asks for them.
 */
export interface MrtrHandlerSources {
  /** Answer `needs_input`: supply the missing arguments. */
  onNeedsInput?: (need: MrtrNeed, round: number) => Promise<Record<string, unknown>>;
  /** Answer `needs_sampling`: return a model completion. */
  onNeedsSampling?: (need: MrtrNeed, round: number) => Promise<string>;
  /**
   * Answer `needs_elicitation`: ask the user for the requested
   * fields and return them (replaces the old server-initiated
   * `elicitation/create` callback mid-request).
   */
  onNeedsElicitation?: (need: MrtrNeed, round: number) => Promise<Record<string, unknown>>;
  /** Answer `needs_roots`: return the workspace root list. */
  onNeedsRoots?: (need: MrtrNeed, round: number) => Promise<Array<{ uri: string; name?: string }>>;
  /**
   * Answer `needs_confirmation`: return true to proceed, false to
   * refuse (a refusal aborts the call with `MrtrError`).
   */
  onNeedsConfirmation?: (need: MrtrNeed, round: number) => Promise<boolean>;
  /** Called after every round (progress UI / tracing). */
  onRound?: MrtrHandlers['onRound'];
}

/**
 * Build MRTR handlers from the coordinator's sources. Only the
 * supplied kinds are registered — a server asking for an
 * unregistered kind gets a clear `MrtrError`, never a fabricated
 * answer.
 */
export function buildDefaultMrtrHandlers(sources: MrtrHandlerSources = {}): MrtrHandlers {
  const handlers: MrtrHandlers = {};
  if (sources.onNeedsInput) handlers.onNeedsInput = sources.onNeedsInput;
  if (sources.onNeedsSampling) handlers.onNeedsSampling = sources.onNeedsSampling;
  if (sources.onNeedsElicitation) handlers.onNeedsElicitation = sources.onNeedsElicitation;
  if (sources.onNeedsRoots) handlers.onNeedsRoots = sources.onNeedsRoots;
  if (sources.onNeedsConfirmation) handlers.onNeedsConfirmation = sources.onNeedsConfirmation;
  if (sources.onRound) handlers.onRound = sources.onRound;
  return handlers;
}

/**
 * Which MRTR kinds a handler set can answer (for capability
 * advertisement and for the UI to explain what a server may ask).
 */
export function mrtrCoveredKinds(handlers: MrtrHandlers): MrtrResultType[] {
  const covered: MrtrResultType[] = ['complete'];
  if (handlers.onNeedsInput) covered.push('needs_input');
  if (handlers.onNeedsSampling) covered.push('needs_sampling');
  if (handlers.onNeedsElicitation) covered.push('needs_elicitation');
  if (handlers.onNeedsRoots) covered.push('needs_roots');
  if (handlers.onNeedsConfirmation) covered.push('needs_confirmation');
  return covered;
}

/** A tool handler result that is itself an MRTR result. */
export interface MrtrToolHandlerResult {
  resultType: MrtrResultType;
  need?: Record<string, unknown>;
  result?: unknown;
  roundTripId?: string;
  note?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const MRTR_RESULT_TYPES: readonly string[] = [
  'complete',
  'needs_input',
  'needs_sampling',
  'needs_elicitation',
  'needs_roots',
  'needs_confirmation',
];

/**
 * Detect an MRTR-shaped tool handler result (server-side half).
 * A handler that returns `{ resultType: 'needs_input', need }`
 * means "I cannot finish yet — ask the client for this and call
 * me again", and the server must pass it through unwrapped: if it
 * were wrapped in a content block, the client would see plain
 * text and the round trip would die. Returns the parsed shape, or
 * null when the result is an ordinary tool result.
 */
export function extractMrtrToolResult(value: unknown): MrtrToolHandlerResult | null {
  if (!isRecord(value)) return null;
  const resultType = value['resultType'];
  if (typeof resultType !== 'string' || !MRTR_RESULT_TYPES.includes(resultType)) return null;
  const out: MrtrToolHandlerResult = { resultType: resultType as MrtrResultType };
  if (isRecord(value['need'])) out.need = value['need'];
  if (value['result'] !== undefined) out.result = value['result'];
  if (typeof value['roundTripId'] === 'string') out.roundTripId = value['roundTripId'];
  if (typeof value['note'] === 'string') out.note = value['note'];
  return out;
}

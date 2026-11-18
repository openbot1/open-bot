/**
 * Protocols v4 — MCP sampling cleanup (v1.20, Team T2).
 *
 * Idea only, learned from the public MCP 2026-07-28 description
 * researched for this wave (see docs/protocols-v120.md): SEP-2577
 * deprecates sampling, roots and logging — earliest removal is
 * the first revision released on or after 2027-07-28 — and
 * elicitation moves onto Multi Round-Trip Requests (SEP-2322):
 * the server answers with `input_required` / `needs_elicitation`
 * and the client drives the round, instead of the server pushing
 * a callback at the client. No code, text or asset from any other
 * repo is copied here.
 *
 * This builds on the existing deprecation layers without touching
 * them:
 *  - `mcp/deprecation.ts` — the method registry
 *    (`sampling/createMessage`, `roots/list`, `roots/subscribe`,
 *    `notifications/message`, `logging/setLevel`,
 *    `elicitation/create`), `DeprecationShim`;
 *  - `mcp/clientDeprecation.ts` — the client-side tracker that
 *    warns once per deprecated method;
 *  - `protocolsV3/mrtrV3.ts` — the MRTR driver that already
 *    answers `input_required` / `needs_elicitation` rounds.
 * v4 is the cleanup layer on top:
 *   1. an audit — `auditMcpSurfaceV4` scans a server's advertised
 *      capabilities + the method names it handles and reports
 *      every deprecated surface left, with its replacement;
 *   2. a capability stripper — `stripDeprecatedCapabilitiesV4`
 *      builds the `initialize` capability object WITHOUT
 *      sampling / roots / logging, so new clients stop
 *      advertising the old surface (old servers keep working:
 *      stripping is opt-in per client, never forced);
 *   3. a migration guard — `McpSamplingV4MigrationGuard` wraps a
 *      legacy sampling handler: warn mode (default) counts calls
 *      and warns once, strict mode refuses with an error that
 *      names the replacement, so a team can flip one server to
 *      strict and find every caller;
 *   4. a replacement builder — `buildElicitationReplacementV4`
 *      turns a sampling-shaped request ("the server needs an
 *      answer it cannot produce itself") into an MRTR
 *      `input_required` round that asks the USER, which is the
 *      spec-correct replacement when a human answer is what is
 *      really needed.
 *
 * Honest correction to the wave brief ("replace sampling with
 * elicitation/roots"): roots is ALSO deprecated (SEP-2577), and
 * the old `elicitation/create` callback is deprecated too — only
 * the MRTR round shape (`needs_elicitation` / `input_required`)
 * is current. The replacements in this module are therefore:
 * sampling -> direct provider call, or an MRTR `input_required`
 * round when a human must answer; roots -> per-request `_meta`
 * / local workspace config; logging -> stderr / OpenTelemetry.
 * Nothing here removes the legacy handlers themselves — they
 * stay working until the 2027-07-28 floor, as the spec promises.
 */

import {
  DEPRECATED_MCP_METHODS,
  MCP_DEPRECATION_REMOVE_AFTER,
  formatDeprecationWarning,
  getDeprecatedMethod,
  isDeprecatedMcpMethod,
  type DeprecatedMcpMethod,
} from '../mcp/deprecation';
import { MCP_V4_DEPRECATED_REMOVAL_FLOOR } from './versions';

/** Earliest removal of the deprecated MCP surface (spec promise). */
export const MCP_SAMPLING_V4_REMOVAL_FLOOR = MCP_V4_DEPRECATED_REMOVAL_FLOOR;
/** Same date, from the shared deprecation registry. */
export const MCP_SAMPLING_V4_REMOVE_AFTER = MCP_DEPRECATION_REMOVE_AFTER;

/** Error raised by the v4 sampling migration guard (strict mode). */
export class McpSamplingV4Error extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'McpSamplingV4Error';
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Replacement table
// ---------------------------------------------------------------------------

/** The spec-correct replacement for one deprecated MCP method. */
export interface McpSamplingV4Replacement {
  method: string;
  capability: string;
  deprecatedIn: string;
  removeAfter: string;
  /** What to use instead (spec-correct, v4 wording). */
  replacement: string;
  /** Why the old shape went away. */
  reason: string;
}

/**
 * v4 replacement table. It refines the shared registry where the
 * registry still points at a compat bridge: `needs_sampling` /
 * `needs_roots` MRTR kinds are themselves deprecated bridges, so
 * the table names the durable replacement first.
 */
export const MCP_SAMPLING_V4_REPLACEMENTS: readonly McpSamplingV4Replacement[] = [
  {
    method: 'sampling/createMessage',
    capability: 'sampling',
    deprecatedIn: '2026-07-28',
    removeAfter: MCP_SAMPLING_V4_REMOVAL_FLOOR,
    replacement:
      'Call the LLM provider API directly from the server (its own key/session), or ask the user through an MRTR input_required round when a human answer is needed.',
    reason: 'Server-initiated sampling callbacks were removed; the server must own its own model calls.',
  },
  {
    method: 'roots/list',
    capability: 'roots',
    deprecatedIn: '2026-07-28',
    removeAfter: MCP_SAMPLING_V4_REMOVAL_FLOOR,
    replacement:
      'Read the workspace roots from local configuration, or receive them per request in _meta (client-driven, no callback).',
    reason: 'Roots callbacks were removed with sampling; roots are supplied by the client, not requested by the server.',
  },
  {
    method: 'roots/subscribe',
    capability: 'roots',
    deprecatedIn: '2026-07-28',
    removeAfter: MCP_SAMPLING_V4_REMOVAL_FLOOR,
    replacement: 'Watch the workspace with the host file watcher instead of a roots subscription.',
    reason: 'Roots callbacks were removed with sampling.',
  },
  {
    method: 'notifications/message',
    capability: 'logging',
    deprecatedIn: '2026-07-28',
    removeAfter: MCP_SAMPLING_V4_REMOVAL_FLOOR,
    replacement:
      'Log to stderr or OpenTelemetry; surface user-visible progress with notifications/progress.',
    reason: 'Logging over the MCP channel was deprecated; servers log out of band.',
  },
  {
    method: 'logging/setLevel',
    capability: 'logging',
    deprecatedIn: '2026-07-28',
    removeAfter: MCP_SAMPLING_V4_REMOVAL_FLOOR,
    replacement: 'Configure the log level in the server configuration / environment.',
    reason: 'Logging over the MCP channel was deprecated.',
  },
  {
    method: 'elicitation/create',
    capability: 'elicitation',
    deprecatedIn: '2026-07-28',
    removeAfter: MCP_SAMPLING_V4_REMOVAL_FLOOR,
    replacement:
      'Use an MRTR needs_elicitation / input_required round: the server declares it needs input and the client drives the round (SEP-2322). Elicitation itself is NOT deprecated — only the server-initiated callback shape is.',
    reason: 'Server-initiated elicitation callbacks were removed; elicitation is now a client-driven MRTR round.',
  },
];

/** Look up the v4 replacement for a method, or null when it is current. */
export function samplingReplacementForV4(method: string): McpSamplingV4Replacement | null {
  return MCP_SAMPLING_V4_REPLACEMENTS.find((r) => r.method === method) ?? null;
}

/** All deprecated MCP methods known to the shared registry. */
export function deprecatedMcpMethodsV4(): readonly DeprecatedMcpMethod[] {
  return DEPRECATED_MCP_METHODS;
}

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

/** One deprecated surface found by the audit. */
export interface McpSamplingV4Finding {
  /** Where it was found: a method name or a capability key. */
  surface: string;
  kind: 'method' | 'capability';
  deprecatedIn: string;
  removeAfter: string;
  replacement: string;
}

/** Audit result for one server / client surface. */
export interface McpSamplingV4Audit {
  /** Deprecated surfaces found (empty = clean). */
  findings: McpSamplingV4Finding[];
  /** True when nothing deprecated was found. */
  clean: boolean;
  /** One-line summary for logs / UI. */
  summary: string;
}

function findingForMethod(method: string): McpSamplingV4Finding | null {
  const meta = getDeprecatedMethod(method) ?? samplingReplacementForV4(method);
  if (!meta) return null;
  return {
    surface: method,
    kind: 'method',
    deprecatedIn: meta.deprecatedIn,
    removeAfter: meta.removeAfter,
    replacement: meta.replacement,
  };
}

/**
 * Audit a server's (or client's) MCP surface: pass the method
 * names it handles and/or the capability keys it advertises.
 * Every deprecated surface is reported with its replacement;
 * unknown methods are ignored (they may be extensions).
 */
export function auditMcpSurfaceV4(input: {
  methods?: readonly string[];
  capabilities?: readonly string[] | Record<string, unknown>;
}): McpSamplingV4Audit {
  const findings: McpSamplingV4Finding[] = [];
  const seen = new Set<string>();
  for (const method of input.methods ?? []) {
    if (typeof method !== 'string') continue;
    const finding = findingForMethod(method);
    if (finding && !seen.has(`m:${method}`)) {
      seen.add(`m:${method}`);
      findings.push(finding);
    }
  }
  const caps = Array.isArray(input.capabilities)
    ? input.capabilities
    : Object.keys(input.capabilities ?? {});
  for (const cap of caps) {
    if (typeof cap !== 'string') continue;
    // A capability is deprecated when a method of that capability is.
    const meta = DEPRECATED_MCP_METHODS.find((m) => m.capability === cap);
    const replacement = MCP_SAMPLING_V4_REPLACEMENTS.find((r) => r.capability === cap);
    if ((meta ?? replacement) && !seen.has(`c:${cap}`)) {
      seen.add(`c:${cap}`);
      const row = replacement ?? meta!;
      findings.push({
        surface: cap,
        kind: 'capability',
        deprecatedIn: row.deprecatedIn,
        removeAfter: row.removeAfter,
        replacement: row.replacement,
      });
    }
  }
  findings.sort((a, b) => a.surface.localeCompare(b.surface));
  return {
    findings,
    clean: findings.length === 0,
    summary:
      findings.length === 0
        ? 'MCP surface is clean: no deprecated sampling / roots / logging surface.'
        : `${findings.length} deprecated MCP surface(s) (removal not before ${MCP_SAMPLING_V4_REMOVAL_FLOOR}): ${findings.map((f) => f.surface).join(', ')}.`,
  };
}

// ---------------------------------------------------------------------------
// Capability stripper
// ---------------------------------------------------------------------------

/** Result of stripping deprecated capabilities from a capability object. */
export interface McpSamplingV4StrippedCapabilities {
  /** Capability object without the deprecated keys (input untouched). */
  kept: Record<string, unknown>;
  /** Deprecated capability keys that were removed. */
  stripped: string[];
}

/**
 * Build the capability object a NEW client advertises: the input
 * minus `sampling` / `roots` / `logging` (and their sub-keys).
 * The input object is not mutated. Old servers keep working —
 * stripping only changes what this client offers, it never
 * refuses a peer that still speaks the old surface.
 */
export function stripDeprecatedCapabilitiesV4(
  capabilities: Record<string, unknown>,
): McpSamplingV4StrippedCapabilities {
  const deprecatedCaps = new Set(
    DEPRECATED_MCP_METHODS.map((m) => m.capability).filter((c) => c !== 'elicitation'),
  );
  const kept: Record<string, unknown> = {};
  const stripped: string[] = [];
  for (const [key, value] of Object.entries(capabilities)) {
    if (deprecatedCaps.has(key)) stripped.push(key);
    else kept[key] = value;
  }
  stripped.sort();
  return { kept, stripped };
}

// ---------------------------------------------------------------------------
// Migration guard (wraps a legacy sampling handler)
// ---------------------------------------------------------------------------

/** Options for the sampling migration guard. */
export interface McpSamplingV4GuardOptions {
  /** When true, sampling calls are refused instead of delegated. */
  strict?: boolean;
  /** Called exactly once, on the first sampling call (warn mode). */
  onWarning?: (message: string) => void;
  /** Server name, for the warning text. */
  serverName?: string;
}

/** Report of what the guard has seen. */
export interface McpSamplingV4GuardReport {
  calls: number;
  warned: boolean;
  strict: boolean;
  /** Replacement the guard tells callers to use. */
  replacement: string;
}

/**
 * Wrap a legacy `sampling/createMessage` handler.
 *
 * - Warn mode (default): the first call warns once (through
 *   `onWarning`, or silently counted when none is given — a stdio
 *   server must keep stdout clean), later calls only count, and
 *   the legacy handler still runs. Compat until the removal floor.
 * - Strict mode: every call is refused with an error naming the
 *   replacement, so a team can flip one server to strict and find
 *   every caller before the floor date.
 * The guard never logs on its own and never touches the network.
 */
export class McpSamplingV4MigrationGuard {
  private readonly handler: (params: unknown) => unknown | Promise<unknown>;
  private readonly strict: boolean;
  private readonly onWarning?: (message: string) => void;
  private readonly serverName?: string;
  private calls = 0;
  private warned = false;

  constructor(
    legacyHandler: (params: unknown) => unknown | Promise<unknown>,
    options: McpSamplingV4GuardOptions = {},
  ) {
    if (typeof legacyHandler !== 'function') {
      throw new McpSamplingV4Error('BAD_HANDLER', 'Migration guard needs a legacy sampling handler function');
    }
    this.handler = legacyHandler;
    this.strict = options.strict ?? false;
    this.onWarning = options.onWarning;
    this.serverName = options.serverName;
  }

  /** Replacement text the guard reports to callers. */
  static replacement(): string {
    return samplingReplacementForV4('sampling/createMessage')!.replacement;
  }

  /** Handle one `sampling/createMessage` call (warn or strict). */
  async call(params: unknown): Promise<unknown> {
    this.calls += 1;
    if (this.strict) {
      throw new McpSamplingV4Error(
        'SAMPLING_REMOVED_STRICT',
        `sampling/createMessage is disabled in strict mode${this.serverName ? ` for server "${this.serverName}"` : ''} ` +
          `(deprecated 2026-07-28, removal not before ${MCP_SAMPLING_V4_REMOVAL_FLOOR}). ` +
          `${McpSamplingV4MigrationGuard.replacement()}`,
      );
    }
    if (!this.warned) {
      this.warned = true;
      const meta = getDeprecatedMethod('sampling/createMessage');
      const message = meta
        ? formatDeprecationWarning(meta)
        : 'sampling/createMessage is deprecated (2026-07-28).';
      this.onWarning?.(message);
    }
    return this.handler(params);
  }

  /** What the guard has seen so far. */
  report(): McpSamplingV4GuardReport {
    return {
      calls: this.calls,
      warned: this.warned,
      strict: this.strict,
      replacement: McpSamplingV4MigrationGuard.replacement(),
    };
  }
}

// ---------------------------------------------------------------------------
// Replacement builder: sampling-shaped need -> MRTR input_required round
// ---------------------------------------------------------------------------

/** A sampling-shaped request the server can no longer send. */
export interface McpSamplingV4SamplingShape {
  /** What the server wanted the model to answer (free text). */
  prompt?: string;
  /** System prompt the server would have sent (never logged in full). */
  systemPrompt?: string;
  /** Max tokens the server asked for. */
  maxTokens?: number;
  /** Question the server actually needs a human to answer, if any. */
  userQuestion?: string;
}

/** An MRTR `input_required` round asking the user instead. */
export interface McpSamplingV4ElicitationReplacement {
  /** MRTR result type the server should answer with. */
  need: 'input_required';
  /** Elicitation schema: one field per question (form mode). */
  schema: {
    type: 'object';
    properties: Record<string, { type: 'string'; title: string; description?: string }>;
    required: string[];
  };
  /** Short message shown to the user (no model output inside). */
  message: string;
}

/**
 * Turn a sampling-shaped need into the spec-correct replacement.
 *
 * - When the server has a question a HUMAN can answer
 *   (`userQuestion`), build an MRTR `input_required` round with a
 *   form field for it: the client drives the round and the user
 *   answers, instead of the server silently sampling a model.
 * - When there is no human-answerable question (the server just
 *   wanted model output), there is no elicitation replacement:
 *   return `ok: false` and tell the caller to call its own LLM
 *   provider directly. Inventing a user question would be worse
 *   than refusing — the user cannot answer a model-only prompt.
 */
export function buildElicitationReplacementV4(
  shape: McpSamplingV4SamplingShape,
): { ok: true; replacement: McpSamplingV4ElicitationReplacement } | { ok: false; reason: string } {
  const question = typeof shape.userQuestion === 'string' ? shape.userQuestion.trim() : '';
  if (!question) {
    return {
      ok: false,
      reason:
        'No human-answerable question: this sampling call wanted model output, not a user answer. ' +
        'Call the LLM provider API directly from the server instead of asking the user.',
    };
  }
  if (question.length > 2000) {
    return { ok: false, reason: 'userQuestion is too long (max 2000 chars).' };
  }
  return {
    ok: true,
    replacement: {
      need: 'input_required',
      schema: {
        type: 'object',
        properties: {
          answer: { type: 'string', title: 'Your answer', description: question },
        },
        required: ['answer'],
      },
      message: question,
    },
  };
}

/** True when a method name is deprecated under MCP 2026-07-28. */
export function isDeprecatedMcpMethodV4(method: string): boolean {
  return isDeprecatedMcpMethod(method);
}

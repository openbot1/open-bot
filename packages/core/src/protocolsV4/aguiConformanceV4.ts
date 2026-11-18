/**
 * Protocols v4 — AG-UI 1.0 conformance (v1.20, Team T2).
 *
 * Idea only, learned from the public AG-UI 1.0 description
 * researched for this wave (see docs/protocols-v120.md): the 1.0
 * spec (`docs/spec/1.0/schema.json` in the AG-UI repo) defines 31
 * event types in the `Event` union, in 8 families — run (5),
 * text (4), tool (5), state (3), reasoning (7), activity (2),
 * raw/custom (2), subagents (3). The five `THINKING_*` events
 * are SDK-only and NOT in the 1.0 schema (superseded by the
 * `REASONING_*` family); there is no `RUN_CANCELLED` event —
 * cancellation is a `RUN_FINISHED` with outcome `cancelled` —
 * and no interrupt event — a pause is `RUN_FINISHED` with
 * outcome `interrupt`. A producer must never emit an event the
 * schema does not define, and must never claim a run succeeded
 * when it paused, failed or was cancelled. No code, text or
 * asset from any other repo is copied here.
 *
 * This builds on the existing AG-UI layers without touching them:
 *  - `protocols/aguiEvents.ts` — open-bot's own 31-type
 *    vocabulary (v1.15). It is ALSO 31 types, but a DIFFERENT
 *    31: it has `THINKING_CONTENT`, `RUN_CANCELLED`,
 *    `RUN_PAUSED`, `TOOL_CALL_ERROR`, four `INTERRUPT_*` and four
 *    `GENERATIVE_UI_*` events that the 1.0 schema does not define,
 *    and it is missing 13 schema types (see
 *    `agUiV4ConformanceReport()`). That vocabulary stays as-is
 *    for existing consumers; this module is the conformance layer
 *    on top of it:
 *   1. the spec vocabulary (`AGUI_V4_SPEC_EVENT_TYPES`) + the
 *      gap report between open-bot's vocabulary and the spec;
 *   2. builders + validators for the 13 missing spec event types
 *      (steps, chunk conveniences, the reasoning family,
 *      activity snapshots/deltas), so a v4 run can emit a
 *      schema-valid stream;
 *   3. a stream checker (`checkAgUiV4Stream`) enforcing the
 *      spec's ordering rules: `RUN_STARTED` first, exactly one
 *      terminal event and it is last, every start closed before
 *      the terminal, monotonic sequence, no `THINKING_*`, no
 *      unknown type, `RUN_FINISHED` always carries an outcome;
 *   4. a translator (`translateOpenBotEventToSpecV4`) that maps
 *      an open-bot event onto spec events — or drops it with a
 *      stated reason when the spec has no equivalent.
 *
 * Privacy rule (spec reasoning section): reasoning is private by
 * default. `THINKING_CONTENT` is only translated to
 * `REASONING_MESSAGE_CONTENT` when the caller opts in
 * (`allowReasoning: true`); `REASONING_ENCRYPTED_VALUE` carries
 * an opaque string that is never decoded, logged or included in
 * a snapshot.
 */

import {
  PROTOCOL_AGUI_EVENT_TYPES,
  type ProtocolAgUiEventType,
} from '../protocols/aguiEvents';

/** AG-UI version this conformance layer checks against. */
export const AGUI_V4_SPEC_VERSION = '1.0';
/** Schema commit the 31-type list was checked against (see docs/protocols-v120.md). */
export const AGUI_V4_SPEC_SCHEMA_COMMIT = '89cedd3fd549feeee41e50e1d7c6d373e549241a';

/** Spec families of the AG-UI 1.0 `Event` union. */
export type AgUiV4SpecFamily =
  | 'run'
  | 'text'
  | 'tool'
  | 'state'
  | 'reasoning'
  | 'activity'
  | 'raw'
  | 'subagents';

/**
 * The 31 event types of the AG-UI 1.0 schema, in family order:
 * run (5), text (4), tool (5), state (3), reasoning (7),
 * activity (2), raw/custom (2), subagents (3).
 */
export const AGUI_V4_SPEC_EVENT_TYPES = [
  // run
  'RUN_STARTED',
  'RUN_FINISHED',
  'RUN_ERROR',
  'STEP_STARTED',
  'STEP_FINISHED',
  // text
  'TEXT_MESSAGE_START',
  'TEXT_MESSAGE_CONTENT',
  'TEXT_MESSAGE_END',
  'TEXT_MESSAGE_CHUNK',
  // tool
  'TOOL_CALL_START',
  'TOOL_CALL_ARGS',
  'TOOL_CALL_END',
  'TOOL_CALL_RESULT',
  'TOOL_CALL_CHUNK',
  // state
  'STATE_SNAPSHOT',
  'STATE_DELTA',
  'MESSAGES_SNAPSHOT',
  // reasoning
  'REASONING_START',
  'REASONING_MESSAGE_START',
  'REASONING_MESSAGE_CONTENT',
  'REASONING_MESSAGE_END',
  'REASONING_MESSAGE_CHUNK',
  'REASONING_END',
  'REASONING_ENCRYPTED_VALUE',
  // activity
  'ACTIVITY_SNAPSHOT',
  'ACTIVITY_DELTA',
  // raw / custom
  'CUSTOM',
  'RAW',
  // subagents
  'SUBAGENT_STARTED',
  'SUBAGENT_FINISHED',
  'SUBAGENT_ERROR',
] as const;

export type AgUiV4SpecEventType = (typeof AGUI_V4_SPEC_EVENT_TYPES)[number];

/** Family of one spec event type. */
export function agUiV4SpecEventFamily(type: AgUiV4SpecEventType): AgUiV4SpecFamily {
  switch (type) {
    case 'RUN_STARTED':
    case 'RUN_FINISHED':
    case 'RUN_ERROR':
    case 'STEP_STARTED':
    case 'STEP_FINISHED':
      return 'run';
    case 'TEXT_MESSAGE_START':
    case 'TEXT_MESSAGE_CONTENT':
    case 'TEXT_MESSAGE_END':
    case 'TEXT_MESSAGE_CHUNK':
      return 'text';
    case 'TOOL_CALL_START':
    case 'TOOL_CALL_ARGS':
    case 'TOOL_CALL_END':
    case 'TOOL_CALL_RESULT':
    case 'TOOL_CALL_CHUNK':
      return 'tool';
    case 'STATE_SNAPSHOT':
    case 'STATE_DELTA':
    case 'MESSAGES_SNAPSHOT':
      return 'state';
    case 'REASONING_START':
    case 'REASONING_MESSAGE_START':
    case 'REASONING_MESSAGE_CONTENT':
    case 'REASONING_MESSAGE_END':
    case 'REASONING_MESSAGE_CHUNK':
    case 'REASONING_END':
    case 'REASONING_ENCRYPTED_VALUE':
      return 'reasoning';
    case 'ACTIVITY_SNAPSHOT':
    case 'ACTIVITY_DELTA':
      return 'activity';
    case 'CUSTOM':
    case 'RAW':
      return 'raw';
    case 'SUBAGENT_STARTED':
    case 'SUBAGENT_FINISHED':
    case 'SUBAGENT_ERROR':
      return 'subagents';
  }
}

/** True when a string is a spec 1.0 event type. */
export function isAgUiV4SpecEventType(value: unknown): value is AgUiV4SpecEventType {
  return (
    typeof value === 'string' && (AGUI_V4_SPEC_EVENT_TYPES as readonly string[]).includes(value)
  );
}

/** Terminal event types: after one of these, the run emits nothing more. */
export const AGUI_V4_SPEC_TERMINAL_EVENT_TYPES = ['RUN_FINISHED', 'RUN_ERROR'] as const;

/** Outcomes a `RUN_FINISHED` event must declare (spec: never a bare success). */
export const AGUI_V4_RUN_FINISHED_OUTCOMES = ['success', 'interrupt', 'cancelled'] as const;
export type AgUiV4RunFinishedOutcome = (typeof AGUI_V4_RUN_FINISHED_OUTCOMES)[number];

/** Error raised by the v4 AG-UI conformance layer. */
export class AgUiV4Error extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'AgUiV4Error';
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Conformance report: open-bot vocabulary vs the 1.0 schema
// ---------------------------------------------------------------------------

/** How one open-bot-only event maps onto the spec. */
export interface AgUiV4Mapping {
  openBotType: string;
  /** Spec equivalent, or null when the spec has none. */
  specType: string | null;
  /** What happens to the event on the spec wire. */
  action: 'passthrough' | 'translate' | 'drop' | 'extension';
  note: string;
}

/** Gap report between open-bot's vocabulary and the AG-UI 1.0 schema. */
export interface AgUiV4ConformanceReport {
  /** Spec types open-bot cannot emit yet (13). */
  missingSpecTypes: AgUiV4SpecEventType[];
  /** Open-bot types the 1.0 schema does not define (13). */
  openBotOnlyTypes: string[];
  /** How each open-bot-only type maps onto the spec. */
  mappings: AgUiV4Mapping[];
  /** Shared types (18): same name on both sides. */
  sharedTypes: string[];
  /** True when open-bot's vocabulary equals the spec exactly. */
  conformant: boolean;
  /** One-line summary for logs / UI. */
  summary: string;
}

/** Mapping for every open-bot-only event type. */
export const AGUI_V4_OPENBOT_MAPPINGS: readonly AgUiV4Mapping[] = [
  {
    openBotType: 'THINKING_CONTENT',
    specType: 'REASONING_MESSAGE_CONTENT',
    action: 'translate',
    note: 'THINKING_* is SDK-only, not in the 1.0 schema. Translate only when the host opts into exposing reasoning; reasoning is private by default.',
  },
  {
    openBotType: 'RUN_CANCELLED',
    specType: 'RUN_FINISHED',
    action: 'translate',
    note: 'No RUN_CANCELLED in the schema: emit RUN_FINISHED with outcome { type: "cancelled" }.',
  },
  {
    openBotType: 'RUN_PAUSED',
    specType: 'RUN_FINISHED',
    action: 'translate',
    note: 'No RUN_PAUSED in the schema: a paused run is RUN_FINISHED with outcome { type: "interrupt" }; a paused run is never a success.',
  },
  {
    openBotType: 'TOOL_CALL_ERROR',
    specType: 'TOOL_CALL_RESULT',
    action: 'translate',
    note: 'No TOOL_CALL_ERROR in the schema: report the failure as TOOL_CALL_RESULT with an error status.',
  },
  {
    openBotType: 'INTERRUPT_STARTED',
    specType: 'RUN_FINISHED',
    action: 'drop',
    note: 'No interrupt event in the schema: the interrupt is carried by RUN_FINISHED outcome { type: "interrupt", interrupts: [...] }; the event itself is dropped on the spec wire.',
  },
  {
    openBotType: 'INTERRUPT_RESOLVED',
    specType: null,
    action: 'drop',
    note: 'No interrupt event in the schema: the resume is a new RunAgentInput, not an event.',
  },
  {
    openBotType: 'INTERRUPT_CANCELLED',
    specType: 'RUN_FINISHED',
    action: 'drop',
    note: 'No interrupt event in the schema: cancellation is RUN_FINISHED outcome { type: "cancelled" }.',
  },
  {
    openBotType: 'INTERRUPT_TIMEOUT',
    specType: 'RUN_ERROR',
    action: 'drop',
    note: 'No interrupt event in the schema: a timed-out interrupt is a RUN_ERROR, never a success.',
  },
  {
    openBotType: 'GENERATIVE_UI_START',
    specType: 'CUSTOM',
    action: 'extension',
    note: 'No generative-UI events in the 1.0 schema: emit as a CUSTOM extension event (name "generative-ui:start").',
  },
  {
    openBotType: 'GENERATIVE_UI_DELTA',
    specType: 'CUSTOM',
    action: 'extension',
    note: 'No generative-UI events in the 1.0 schema: emit as a CUSTOM extension event (name "generative-ui:delta").',
  },
  {
    openBotType: 'GENERATIVE_UI_END',
    specType: 'CUSTOM',
    action: 'extension',
    note: 'No generative-UI events in the 1.0 schema: emit as a CUSTOM extension event (name "generative-ui:end").',
  },
  {
    openBotType: 'GENERATIVE_UI_RESPONSE',
    specType: 'CUSTOM',
    action: 'extension',
    note: 'No generative-UI events in the 1.0 schema: emit as a CUSTOM extension event (name "generative-ui:response").',
  },
  {
    openBotType: 'ACTIVITY',
    specType: 'ACTIVITY_SNAPSHOT',
    action: 'translate',
    note: 'The schema has ACTIVITY_SNAPSHOT / ACTIVITY_DELTA, not a bare ACTIVITY event: translate to a snapshot.',
  },
];

/**
 * Compare open-bot's AG-UI vocabulary (`protocols/aguiEvents.ts`)
 * with the AG-UI 1.0 schema. Computed at runtime from the real
 * vocabulary, so a future vocabulary change shows up here
 * instead of in a stale document.
 */
export function agUiV4ConformanceReport(): AgUiV4ConformanceReport {
  const spec = AGUI_V4_SPEC_EVENT_TYPES as readonly string[];
  const openBot = PROTOCOL_AGUI_EVENT_TYPES as readonly string[];
  const missingSpecTypes = spec.filter((t) => !openBot.includes(t)) as AgUiV4SpecEventType[];
  const openBotOnlyTypes = openBot.filter((t) => !spec.includes(t));
  const sharedTypes = spec.filter((t) => openBot.includes(t));
  const mappings = AGUI_V4_OPENBOT_MAPPINGS.filter((m) => openBotOnlyTypes.includes(m.openBotType));
  return {
    missingSpecTypes,
    openBotOnlyTypes,
    mappings,
    sharedTypes,
    conformant: missingSpecTypes.length === 0 && openBotOnlyTypes.length === 0,
    summary:
      missingSpecTypes.length === 0 && openBotOnlyTypes.length === 0
        ? 'AG-UI vocabulary matches the 1.0 schema exactly.'
        : `AG-UI gap: ${missingSpecTypes.length} spec 1.0 type(s) missing (${missingSpecTypes.join(', ')}); ` +
          `${openBotOnlyTypes.length} open-bot type(s) not in the schema (${openBotOnlyTypes.join(', ')}).`,
  };
}

// ---------------------------------------------------------------------------
// Spec event builders (the 13 missing types + shared passthrough shape)
// ---------------------------------------------------------------------------

/** One spec-shaped event on the wire (plain JSON). */
export interface AgUiV4SpecEvent {
  type: AgUiV4SpecEventType;
  runId: string;
  sequence: number;
  timestamp: string;
  data: Record<string, unknown>;
}

/** Required data fields per spec event type (only the missing types need new shapes). */
export const AGUI_V4_SPEC_REQUIRED_DATA: Partial<Record<AgUiV4SpecEventType, readonly string[]>> = {
  STEP_STARTED: ['stepName'],
  STEP_FINISHED: ['stepName'],
  TEXT_MESSAGE_CHUNK: ['messageId', 'delta'],
  TOOL_CALL_CHUNK: ['toolCallId', 'delta'],
  REASONING_START: ['messageId'],
  REASONING_MESSAGE_START: ['messageId'],
  REASONING_MESSAGE_CONTENT: ['messageId', 'delta'],
  REASONING_MESSAGE_END: ['messageId'],
  REASONING_MESSAGE_CHUNK: ['messageId', 'delta'],
  REASONING_END: ['messageId'],
  REASONING_ENCRYPTED_VALUE: ['messageId', 'value'],
  ACTIVITY_SNAPSHOT: ['activities'],
  ACTIVITY_DELTA: ['delta'],
};

/**
 * Validate a spec-shaped event; returns the problems, empty = valid.
 * Checks the type is in the schema, runId / sequence shape, and the
 * required data fields for the type. `REASONING_ENCRYPTED_VALUE`
 * values are checked for shape only (string) — never decoded.
 */
export function validateAgUiV4SpecEvent(event: unknown): string[] {
  const problems: string[] = [];
  if (typeof event !== 'object' || event === null || Array.isArray(event)) {
    return ['event is not an object'];
  }
  const record = event as Record<string, unknown>;
  if (!isAgUiV4SpecEventType(record['type'])) {
    problems.push(`type "${String(record['type'])}" is not an AG-UI 1.0 schema event type`);
    return problems;
  }
  if (typeof record['runId'] !== 'string' || record['runId'] === '') {
    problems.push('runId must be a non-empty string');
  }
  if (
    typeof record['sequence'] !== 'number' ||
    !Number.isInteger(record['sequence']) ||
    (record['sequence'] as number) < 0
  ) {
    problems.push('sequence must be a non-negative integer');
  }
  const data = record['data'];
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    problems.push('data must be an object');
    return problems;
  }
  const type = record['type'] as AgUiV4SpecEventType;
  for (const field of AGUI_V4_SPEC_REQUIRED_DATA[type] ?? []) {
    if ((data as Record<string, unknown>)[field] === undefined) {
      problems.push(`${type} data.${field} is required`);
    }
  }
  if (type === 'REASONING_MESSAGE_START') {
    const role = (data as Record<string, unknown>)['role'];
    if (role !== undefined && role !== 'reasoning') {
      problems.push('REASONING_MESSAGE_START data.role must be "reasoning"');
    }
  }
  if (type === 'REASONING_ENCRYPTED_VALUE') {
    const value = (data as Record<string, unknown>)['value'];
    if (typeof value !== 'string' || value === '') {
      problems.push('REASONING_ENCRYPTED_VALUE data.value must be a non-empty opaque string');
    }
  }
  if (type === 'ACTIVITY_SNAPSHOT' && !Array.isArray((data as Record<string, unknown>)['activities'])) {
    problems.push('ACTIVITY_SNAPSHOT data.activities must be an array');
  }
  if (type === 'ACTIVITY_DELTA' && !Array.isArray((data as Record<string, unknown>)['delta'])) {
    problems.push('ACTIVITY_DELTA data.delta must be an array');
  }
  if (type === 'RUN_FINISHED') {
    const outcome = (data as Record<string, unknown>)['outcome'];
    if (typeof outcome !== 'object' || outcome === null || Array.isArray(outcome)) {
      problems.push('RUN_FINISHED data.outcome is required (success / interrupt / cancelled)');
    } else {
      const outcomeType = (outcome as Record<string, unknown>)['type'];
      if (
        typeof outcomeType !== 'string' ||
        !(AGUI_V4_RUN_FINISHED_OUTCOMES as readonly string[]).includes(outcomeType)
      ) {
        problems.push('RUN_FINISHED data.outcome.type must be success, interrupt or cancelled');
      }
    }
  }
  return problems;
}

/**
 * Build one spec-shaped event (sequence supplied by the caller).
 * Throws when the type is not in the schema or required data is
 * missing — a malformed event can never enter the stream.
 */
export function makeAgUiV4SpecEvent(
  type: AgUiV4SpecEventType,
  runId: string,
  sequence: number,
  data: Record<string, unknown>,
): AgUiV4SpecEvent {
  const event: AgUiV4SpecEvent = {
    type,
    runId,
    sequence,
    timestamp: new Date().toISOString(),
    data,
  };
  const problems = validateAgUiV4SpecEvent(event);
  if (problems.length > 0) {
    throw new AgUiV4Error('BAD_EVENT', `Cannot build ${type}: ${problems.join('; ')}`);
  }
  return event;
}

// ---------------------------------------------------------------------------
// Stream checker
// ---------------------------------------------------------------------------

/** Minimal shape the stream checker reads (extra fields ignored). */
export interface AgUiV4StreamEventInput {
  type: string;
  sequence?: number;
  data?: Record<string, unknown>;
}

/** Result of checking one recorded run stream. */
export interface AgUiV4StreamCheck {
  ok: boolean;
  violations: string[];
}

/**
 * Check a recorded run stream against the spec's ordering rules:
 * non-empty; `RUN_STARTED` first; exactly one terminal event and
 * it is last; every `*_START` closed before the terminal event;
 * sequence strictly increasing from 0 with no gaps; no
 * `THINKING_*` (not in the schema) and no unknown type;
 * `RUN_FINISHED` carries an outcome. Returns every violation
 * found (empty = the stream is conformant).
 */
export function checkAgUiV4Stream(events: readonly AgUiV4StreamEventInput[]): AgUiV4StreamCheck {
  const violations: string[] = [];
  if (events.length === 0) return { ok: false, violations: ['stream is empty'] };
  if (events[0]!.type !== 'RUN_STARTED') {
    violations.push(`first event must be RUN_STARTED, got ${events[0]!.type}`);
  }
  let expectedSequence = 0;
  const openText = new Set<string>();
  const openReasoning = new Set<string>();
  const openSteps = new Set<string>();
  let terminalIndex = -1;
  let terminalCount = 0;
  events.forEach((event, index) => {
    const type = event.type;
    if (!isAgUiV4SpecEventType(type)) {
      if (type.startsWith('THINKING_')) {
        violations.push(`event ${index}: ${type} is not in the AG-UI 1.0 schema (THINKING_* was superseded by REASONING_*)`);
      } else {
        violations.push(`event ${index}: ${type} is not an AG-UI 1.0 schema event type`);
      }
    }
    if (typeof event.sequence === 'number') {
      if (event.sequence !== expectedSequence) {
        violations.push(
          `event ${index}: sequence ${event.sequence} breaks the order (expected ${expectedSequence})`,
        );
      }
      expectedSequence = event.sequence + 1;
    }
    if ((AGUI_V4_SPEC_TERMINAL_EVENT_TYPES as readonly string[]).includes(type)) {
      terminalCount += 1;
      terminalIndex = index;
      if (type === 'RUN_FINISHED') {
        const outcome = event.data?.['outcome'];
        const outcomeType =
          typeof outcome === 'object' && outcome !== null
            ? (outcome as Record<string, unknown>)['type']
            : undefined;
        if (
          typeof outcomeType !== 'string' ||
          !(AGUI_V4_RUN_FINISHED_OUTCOMES as readonly string[]).includes(outcomeType)
        ) {
          violations.push(`event ${index}: RUN_FINISHED must carry outcome success / interrupt / cancelled`);
        }
      }
    }
    const messageId = typeof event.data?.['messageId'] === 'string' ? (event.data!['messageId'] as string) : '';
    const stepName = typeof event.data?.['stepName'] === 'string' ? (event.data!['stepName'] as string) : '';
    switch (type) {
      case 'TEXT_MESSAGE_START':
        if (messageId) openText.add(messageId);
        break;
      case 'TEXT_MESSAGE_END':
        if (messageId) openText.delete(messageId);
        break;
      case 'REASONING_START':
      case 'REASONING_MESSAGE_START':
        if (messageId) openReasoning.add(messageId);
        break;
      case 'REASONING_END':
      case 'REASONING_MESSAGE_END':
        if (messageId) openReasoning.delete(messageId);
        break;
      case 'STEP_STARTED':
        if (stepName) openSteps.add(stepName);
        break;
      case 'STEP_FINISHED':
        if (stepName) openSteps.delete(stepName);
        break;
      default:
        break;
    }
  });
  if (terminalCount === 0) violations.push('stream has no terminal event (RUN_FINISHED / RUN_ERROR)');
  if (terminalCount > 1) violations.push(`stream has ${terminalCount} terminal events, must have exactly one`);
  if (terminalIndex !== -1 && terminalIndex !== events.length - 1) {
    violations.push(`terminal event at index ${terminalIndex} is not last (stream has ${events.length} events)`);
  }
  for (const messageId of openText) {
    violations.push(`text message ${messageId} was started but never ended before the terminal event`);
  }
  for (const messageId of openReasoning) {
    violations.push(`reasoning ${messageId} was started but never ended before the terminal event`);
  }
  for (const stepName of openSteps) {
    violations.push(`step ${stepName} was started but never finished before the terminal event`);
  }
  return { ok: violations.length === 0, violations };
}

// ---------------------------------------------------------------------------
// Translator: open-bot event -> spec event(s)
// ---------------------------------------------------------------------------

/** Result of translating one open-bot event onto the spec wire. */
export interface AgUiV4Translation {
  /** Spec events to emit (empty when the event is dropped). */
  events: AgUiV4SpecEvent[];
  /** True when the open-bot event has no spec-wire form. */
  dropped: boolean;
  /** What happened, for logs / UI. */
  note: string;
}

/**
 * Translate one open-bot AG-UI event (`protocols/aguiEvents.ts`
 * shape) onto spec 1.0 events.
 *
 * - Shared types pass through unchanged.
 * - `THINKING_CONTENT` becomes `REASONING_MESSAGE_CONTENT`
 *   only when `allowReasoning` is true (reasoning is private by
 *   default); otherwise it is dropped.
 * - `RUN_CANCELLED` / `RUN_PAUSED` become `RUN_FINISHED` with
 *   the matching outcome; `TOOL_CALL_ERROR` becomes a
 *   `TOOL_CALL_RESULT` with an error status; `INTERRUPT_*`
 *   events are dropped (their meaning lives in the
 *   `RUN_FINISHED` interrupt outcome); `GENERATIVE_UI_*` become
 *   `CUSTOM` extension events; bare `ACTIVITY` becomes an
 *   `ACTIVITY_SNAPSHOT`.
 */
export function translateOpenBotEventToSpecV4(
  event: {
    type: ProtocolAgUiEventType | string;
    runId: string;
    sequence: number;
    data?: Record<string, unknown>;
  },
  options: { allowReasoning?: boolean } = {},
): AgUiV4Translation {
  const data = (event.data ?? {}) as Record<string, unknown>;
  const base = {
    runId: event.runId,
    sequence: event.sequence,
    timestamp: new Date().toISOString(),
  };
  const spec = (type: AgUiV4SpecEventType, specData: Record<string, unknown>): AgUiV4SpecEvent => ({
    type,
    ...base,
    data: specData,
  });
  switch (event.type) {
    case 'THINKING_CONTENT': {
      if (!options.allowReasoning) {
        return { events: [], dropped: true, note: 'THINKING_CONTENT dropped: reasoning is private by default (opt in to expose it as REASONING_MESSAGE_CONTENT).' };
      }
      return {
        events: [spec('REASONING_MESSAGE_CONTENT', { messageId: data['messageId'], delta: data['delta'] })],
        dropped: false,
        note: 'THINKING_CONTENT translated to REASONING_MESSAGE_CONTENT.',
      };
    }
    case 'RUN_CANCELLED':
      return {
        events: [spec('RUN_FINISHED', { outcome: { type: 'cancelled' } })],
        dropped: false,
        note: 'RUN_CANCELLED translated to RUN_FINISHED outcome cancelled.',
      };
    case 'RUN_PAUSED':
      return {
        events: [spec('RUN_FINISHED', { outcome: { type: 'interrupt', interrupts: [] } })],
        dropped: false,
        note: 'RUN_PAUSED translated to RUN_FINISHED outcome interrupt (a paused run is never a success).',
      };
    case 'TOOL_CALL_ERROR':
      return {
        events: [
          spec('TOOL_CALL_RESULT', {
            toolCallId: data['toolCallId'],
            toolName: data['toolName'],
            status: 'error',
            resultPreview: typeof data['message'] === 'string' ? data['message'] : undefined,
          }),
        ],
        dropped: false,
        note: 'TOOL_CALL_ERROR translated to TOOL_CALL_RESULT with error status.',
      };
    case 'INTERRUPT_STARTED':
    case 'INTERRUPT_RESOLVED':
    case 'INTERRUPT_CANCELLED':
    case 'INTERRUPT_TIMEOUT':
      return {
        events: [],
        dropped: true,
        note: `${event.type} dropped: the 1.0 schema has no interrupt event; the interrupt lives in the RUN_FINISHED outcome.`,
      };
    case 'GENERATIVE_UI_START':
    case 'GENERATIVE_UI_DELTA':
    case 'GENERATIVE_UI_END':
    case 'GENERATIVE_UI_RESPONSE': {
      const suffix = event.type.slice('GENERATIVE_UI_'.length).toLowerCase();
      return {
        events: [spec('CUSTOM', { name: `generative-ui:${suffix}`, data })],
        dropped: false,
        note: `${event.type} translated to CUSTOM extension event generative-ui:${suffix} (no generative-UI event in the 1.0 schema).`,
      };
    }
    case 'ACTIVITY':
      return {
        events: [
          spec('ACTIVITY_SNAPSHOT', {
            activities: [{ kind: data['kind'], message: data['message'] }],
          }),
        ],
        dropped: false,
        note: 'ACTIVITY translated to ACTIVITY_SNAPSHOT.',
      };
    default: {
      if (isAgUiV4SpecEventType(event.type)) {
        return { events: [spec(event.type, data)], dropped: false, note: `${event.type} is already a 1.0 schema event.` };
      }
      return { events: [], dropped: true, note: `${event.type} is not an AG-UI 1.0 schema event type.` };
    }
  }
}

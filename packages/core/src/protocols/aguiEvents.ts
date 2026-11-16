/**
 * AG-UI 1.0 event stream — protocol triad v1.15 (Team T2).
 *
 * Idea only, learned from the public AG-UI 1.0 description in
 * docs/repo-survey-v115.md section 1: one request, one ordered
 * event stream; 31 event types in 8 groups; interrupt-and-resume
 * as a first-class feature; token usage (per provider/model) on
 * terminal events; subagent events carrying `subagentRunId`. No
 * code, text or asset from any other repo is copied here — the
 * shapes below are open-bot's own design, written from the
 * protocol idea.
 *
 * Relation to the older open-bot AG-UI layer (`agui/`): that
 * layer has 16 event types and a bus/SSE runtime. This module is
 * the v1.15 spec-complete stream: the full 31-type vocabulary,
 * per-run ordering with `runId`/`stepId`, an `AsyncIterable`
 * stream, and usage on terminal events. It does not replace
 * `agui/`; a bridge (`toLegacyAgUiEvent`) maps the overlapping
 * types down to the 16-type vocabulary for existing consumers.
 *
 * Design rules:
 * - Every event is a plain JSON object (no functions, no class
 *   instances) so it can travel over the harness bus, NDJSON
 *   logs, IPC, WebSocket and SSE unchanged.
 * - `sequence` is a per-run monotonic counter assigned by the
 *   emitter, so a consumer can detect gaps and reorder.
 * - Payloads are sanitised by the emitter: long strings are
 *   truncated, secret-shaped values are never included.
 * - Terminal events (`RUN_FINISHED`, `RUN_ERROR`,
 *   `RUN_CANCELLED`) carry `TokenUsage` when the provider
 *   reported it, always labelled with provider + model.
 */

/** AG-UI 1.0 protocol identifier for this stream. */
export const PROTOCOL_AGUI_VERSION = 'agui/1.0';

/** Maximum length of a single text delta / payload string (chars). */
export const PROTOCOL_AGUI_MAX_TEXT_CHARS = 8000;
/** Maximum length of a tool-call argument JSON string (chars). */
export const PROTOCOL_AGUI_MAX_ARGS_CHARS = 4000;
/** Maximum length of a tool result preview (chars). */
export const PROTOCOL_AGUI_MAX_RESULT_CHARS = 4000;
/** Maximum number of keys in a state snapshot / delta object. */
export const PROTOCOL_AGUI_MAX_STATE_KEYS = 64;
/** Maximum depth of a state value when it is cloned for transport. */
export const PROTOCOL_AGUI_MAX_STATE_DEPTH = 4;
/** Maximum number of generative-UI items per event. */
export const PROTOCOL_AGUI_MAX_GENUI_ITEMS = 50;

/**
 * The 8 event groups of the AG-UI 1.0 stream.
 *
 * - lifecycle: a run starts, finishes, errors, is cancelled, pauses.
 * - text: the agent's streamed message (and its thinking).
 * - toolCall: a tool call from start to result.
 * - state: snapshots and deltas of the agent's shared state.
 * - interrupt: the agent pauses mid-run for a human decision.
 * - subagent: a child run spawned by this run.
 * - generativeUi: declarative UI the agent asks the frontend to show.
 * - custom: extension points (custom events, raw passthrough, activity).
 */
export const PROTOCOL_AGUI_EVENT_GROUPS = [
  'lifecycle',
  'text',
  'toolCall',
  'state',
  'interrupt',
  'subagent',
  'generativeUi',
  'custom',
] as const;

export type ProtocolAgUiEventGroup = (typeof PROTOCOL_AGUI_EVENT_GROUPS)[number];

/**
 * The 31 AG-UI 1.0 event types, grouped:
 *
 * - lifecycle (5): RUN_STARTED, RUN_FINISHED, RUN_ERROR,
 *   RUN_CANCELLED, RUN_PAUSED
 * - text (4): TEXT_MESSAGE_START, TEXT_MESSAGE_CONTENT,
 *   TEXT_MESSAGE_END, THINKING_CONTENT
 * - toolCall (5): TOOL_CALL_START, TOOL_CALL_ARGS,
 *   TOOL_CALL_END, TOOL_CALL_RESULT, TOOL_CALL_ERROR
 * - state (3): STATE_SNAPSHOT, STATE_DELTA, MESSAGES_SNAPSHOT
 * - interrupt (4): INTERRUPT_STARTED, INTERRUPT_RESOLVED,
 *   INTERRUPT_CANCELLED, INTERRUPT_TIMEOUT
 * - subagent (3): SUBAGENT_STARTED, SUBAGENT_FINISHED,
 *   SUBAGENT_ERROR
 * - generativeUi (4): GENERATIVE_UI_START, GENERATIVE_UI_DELTA,
 *   GENERATIVE_UI_END, GENERATIVE_UI_RESPONSE
 * - custom (3): CUSTOM, RAW, ACTIVITY
 */
export const PROTOCOL_AGUI_EVENT_TYPES = [
  // lifecycle
  'RUN_STARTED',
  'RUN_FINISHED',
  'RUN_ERROR',
  'RUN_CANCELLED',
  'RUN_PAUSED',
  // text
  'TEXT_MESSAGE_START',
  'TEXT_MESSAGE_CONTENT',
  'TEXT_MESSAGE_END',
  'THINKING_CONTENT',
  // toolCall
  'TOOL_CALL_START',
  'TOOL_CALL_ARGS',
  'TOOL_CALL_END',
  'TOOL_CALL_RESULT',
  'TOOL_CALL_ERROR',
  // state
  'STATE_SNAPSHOT',
  'STATE_DELTA',
  'MESSAGES_SNAPSHOT',
  // interrupt
  'INTERRUPT_STARTED',
  'INTERRUPT_RESOLVED',
  'INTERRUPT_CANCELLED',
  'INTERRUPT_TIMEOUT',
  // subagent
  'SUBAGENT_STARTED',
  'SUBAGENT_FINISHED',
  'SUBAGENT_ERROR',
  // generativeUi
  'GENERATIVE_UI_START',
  'GENERATIVE_UI_DELTA',
  'GENERATIVE_UI_END',
  'GENERATIVE_UI_RESPONSE',
  // custom
  'CUSTOM',
  'RAW',
  'ACTIVITY',
] as const;

export type ProtocolAgUiEventType = (typeof PROTOCOL_AGUI_EVENT_TYPES)[number];

/** Group of one event type. */
export function protocolAgUiEventGroup(type: ProtocolAgUiEventType): ProtocolAgUiEventGroup {
  switch (type) {
    case 'RUN_STARTED':
    case 'RUN_FINISHED':
    case 'RUN_ERROR':
    case 'RUN_CANCELLED':
    case 'RUN_PAUSED':
      return 'lifecycle';
    case 'TEXT_MESSAGE_START':
    case 'TEXT_MESSAGE_CONTENT':
    case 'TEXT_MESSAGE_END':
    case 'THINKING_CONTENT':
      return 'text';
    case 'TOOL_CALL_START':
    case 'TOOL_CALL_ARGS':
    case 'TOOL_CALL_END':
    case 'TOOL_CALL_RESULT':
    case 'TOOL_CALL_ERROR':
      return 'toolCall';
    case 'STATE_SNAPSHOT':
    case 'STATE_DELTA':
    case 'MESSAGES_SNAPSHOT':
      return 'state';
    case 'INTERRUPT_STARTED':
    case 'INTERRUPT_RESOLVED':
    case 'INTERRUPT_CANCELLED':
    case 'INTERRUPT_TIMEOUT':
      return 'interrupt';
    case 'SUBAGENT_STARTED':
    case 'SUBAGENT_FINISHED':
    case 'SUBAGENT_ERROR':
      return 'subagent';
    case 'GENERATIVE_UI_START':
    case 'GENERATIVE_UI_DELTA':
    case 'GENERATIVE_UI_END':
    case 'GENERATIVE_UI_RESPONSE':
      return 'generativeUi';
    case 'CUSTOM':
    case 'RAW':
    case 'ACTIVITY':
      return 'custom';
  }
}

export function isProtocolAgUiEventType(value: unknown): value is ProtocolAgUiEventType {
  return (
    typeof value === 'string' &&
    (PROTOCOL_AGUI_EVENT_TYPES as readonly string[]).includes(value)
  );
}

/** The event types of one group, in stream order. */
export function protocolAgUiEventTypesOfGroup(
  group: ProtocolAgUiEventGroup,
): ProtocolAgUiEventType[] {
  return PROTOCOL_AGUI_EVENT_TYPES.filter((t) => protocolAgUiEventGroup(t) === group);
}

/** Terminal event types: after one of these, the run emits nothing more. */
export const PROTOCOL_AGUI_TERMINAL_EVENT_TYPES = [
  'RUN_FINISHED',
  'RUN_ERROR',
  'RUN_CANCELLED',
] as const;

export type ProtocolAgUiTerminalEventType = (typeof PROTOCOL_AGUI_TERMINAL_EVENT_TYPES)[number];

export function isProtocolAgUiTerminalEventType(
  value: unknown,
): value is ProtocolAgUiTerminalEventType {
  return (
    typeof value === 'string' &&
    (PROTOCOL_AGUI_TERMINAL_EVENT_TYPES as readonly string[]).includes(value)
  );
}

/**
 * Token usage reported on a terminal event, always labelled with
 * the provider and model that produced it (AG-UI 1.0: usage per
 * provider/model on terminal events). All counts are integers
 * >= 0; a provider that reports no usage yields `undefined`
 * usage on the event instead of zeroes.
 */
export interface ProtocolTokenUsage {
  /** Provider id, e.g. `openai`, `gemini`, `ollama`, `xai`. */
  provider: string;
  /** Model id as the provider reported it, e.g. `gpt-5`. */
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export function makeProtocolTokenUsage(
  provider: string,
  model: string,
  promptTokens: number,
  completionTokens: number,
): ProtocolTokenUsage {
  const prompt = Math.max(0, Math.floor(promptTokens));
  const completion = Math.max(0, Math.floor(completionTokens));
  return {
    provider,
    model,
    promptTokens: prompt,
    completionTokens: completion,
    totalTokens: prompt + completion,
  };
}

/** Run status reported on RUN_FINISHED. */
export type ProtocolRunStatus = 'completed' | 'stopped' | 'failed' | 'cancelled';

/** Tool-call outcome reported on TOOL_CALL_RESULT. */
export type ProtocolToolCallStatus = 'ok' | 'error' | 'denied';

/** Payload of a RUN_STARTED event. */
export interface ProtocolRunStartedData {
  botId?: string;
  threadId?: string;
  /** Human-readable label for the run (never a secret). */
  label?: string;
  model?: string;
  provider?: string;
}

/** Payload of a RUN_FINISHED event. */
export interface ProtocolRunFinishedData {
  status: ProtocolRunStatus;
  /** Final text of the run when there is one. */
  finalText?: string;
  /** Token usage, when the provider reported it. */
  usage?: ProtocolTokenUsage;
}

/** Payload of a RUN_ERROR / RUN_CANCELLED event. */
export interface ProtocolRunErrorData {
  message: string;
  /** Short machine-readable code, e.g. `provider_error`. */
  code?: string;
  usage?: ProtocolTokenUsage;
}

/** Payload of a RUN_PAUSED event (run waits on an interrupt). */
export interface ProtocolRunPausedData {
  interruptId: string;
  reason?: string;
}

/** Payload of a TEXT_MESSAGE_START event. */
export interface ProtocolTextMessageStartData {
  messageId: string;
  role?: 'assistant' | 'user';
}

/** Payload of a TEXT_MESSAGE_CONTENT event. */
export interface ProtocolTextMessageContentData {
  messageId: string;
  delta: string;
}

/** Payload of a TEXT_MESSAGE_END event. */
export interface ProtocolTextMessageEndData {
  messageId: string;
  /** Full assembled text (truncated at the transport limit). */
  text?: string;
}

/** Payload of a THINKING_CONTENT event. */
export interface ProtocolThinkingContentData {
  messageId?: string;
  delta: string;
}

/** Payload of a TOOL_CALL_START event. */
export interface ProtocolToolCallStartData {
  toolCallId: string;
  toolName: string;
  /** Argument key names only — never values (may hold secrets). */
  argKeys?: string[];
}

/** Payload of a TOOL_CALL_ARGS event. */
export interface ProtocolToolCallArgsData {
  toolCallId: string;
  /** Argument JSON, truncated at the transport limit. */
  argsJson: string;
}

/** Payload of a TOOL_CALL_END event. */
export interface ProtocolToolCallEndData {
  toolCallId: string;
  toolName: string;
}

/** Payload of a TOOL_CALL_RESULT event. */
export interface ProtocolToolCallResultData {
  toolCallId: string;
  toolName: string;
  status: ProtocolToolCallStatus;
  /** Result preview, truncated at the transport limit. */
  resultPreview?: string;
}

/** Payload of a TOOL_CALL_ERROR event. */
export interface ProtocolToolCallErrorData {
  toolCallId: string;
  toolName: string;
  message: string;
}

/** Payload of a STATE_SNAPSHOT event. */
export interface ProtocolStateSnapshotData {
  state: Record<string, unknown>;
}

/** Payload of a STATE_DELTA event. */
export interface ProtocolStateDeltaData {
  delta: Record<string, unknown>;
}

/** Payload of a MESSAGES_SNAPSHOT event. */
export interface ProtocolMessagesSnapshotData {
  messages: Array<{ role: string; content: string }>;
}

/** Payload of an INTERRUPT_STARTED event. */
export interface ProtocolInterruptStartedData {
  interruptId: string;
  kind: 'approval' | 'form' | 'choice';
  /** Short title shown to the user. */
  title: string;
  /** What the agent is waiting for (plain text, no secrets). */
  detail?: string;
}

/** Payload of an INTERRUPT_RESOLVED event. */
export interface ProtocolInterruptResolvedData {
  interruptId: string;
  /** The user's answer, JSON-safe (form values, approval flag). */
  answer: Record<string, unknown>;
}

/** Payload of an INTERRUPT_CANCELLED event. */
export interface ProtocolInterruptCancelledData {
  interruptId: string;
  reason?: string;
}

/** Payload of an INTERRUPT_TIMEOUT event. */
export interface ProtocolInterruptTimeoutData {
  interruptId: string;
  timeoutMs: number;
}

/** Payload of a SUBAGENT_STARTED event. */
export interface ProtocolSubagentStartedData {
  subagentRunId: string;
  task: string;
}

/** Payload of a SUBAGENT_FINISHED event. */
export interface ProtocolSubagentFinishedData {
  subagentRunId: string;
  summary?: string;
  usage?: ProtocolTokenUsage;
}

/** Payload of a SUBAGENT_ERROR event. */
export interface ProtocolSubagentErrorData {
  subagentRunId: string;
  message: string;
}

/** Payload of a GENERATIVE_UI_START event. */
export interface ProtocolGenerativeUiStartData {
  componentId: string;
  kind: string;
  title?: string;
}

/** Payload of a GENERATIVE_UI_DELTA event. */
export interface ProtocolGenerativeUiDeltaData {
  componentId: string;
  delta: Record<string, unknown>;
}

/** Payload of a GENERATIVE_UI_END event. */
export interface ProtocolGenerativeUiEndData {
  componentId: string;
}

/** Payload of a GENERATIVE_UI_RESPONSE event (user answered a surface). */
export interface ProtocolGenerativeUiResponseData {
  componentId: string;
  answer: Record<string, unknown>;
}

/** Payload of a CUSTOM event. */
export interface ProtocolCustomData {
  name: string;
  data?: Record<string, unknown>;
}

/** Payload of a RAW event (passthrough provider event, already sanitised). */
export interface ProtocolRawData {
  raw: Record<string, unknown>;
}

/** Payload of an ACTIVITY event (progress note for the feed). */
export interface ProtocolActivityData {
  kind: string;
  message: string;
}

/** Union of every event payload. */
export type ProtocolAgUiEventData =
  | ProtocolRunStartedData
  | ProtocolRunFinishedData
  | ProtocolRunErrorData
  | ProtocolRunPausedData
  | ProtocolTextMessageStartData
  | ProtocolTextMessageContentData
  | ProtocolTextMessageEndData
  | ProtocolThinkingContentData
  | ProtocolToolCallStartData
  | ProtocolToolCallArgsData
  | ProtocolToolCallEndData
  | ProtocolToolCallResultData
  | ProtocolToolCallErrorData
  | ProtocolStateSnapshotData
  | ProtocolStateDeltaData
  | ProtocolMessagesSnapshotData
  | ProtocolInterruptStartedData
  | ProtocolInterruptResolvedData
  | ProtocolInterruptCancelledData
  | ProtocolInterruptTimeoutData
  | ProtocolSubagentStartedData
  | ProtocolSubagentFinishedData
  | ProtocolSubagentErrorData
  | ProtocolGenerativeUiStartData
  | ProtocolGenerativeUiDeltaData
  | ProtocolGenerativeUiEndData
  | ProtocolGenerativeUiResponseData
  | ProtocolCustomData
  | ProtocolRawData
  | ProtocolActivityData;

/** One event on the AG-UI 1.0 stream. */
export interface ProtocolAgUiEvent {
  type: ProtocolAgUiEventType;
  runId: string;
  /** Step inside the run (tool-call step, subagent step, ...). */
  stepId?: string;
  /** Per-run monotonic counter, assigned by the emitter. */
  sequence: number;
  /** ISO-8601 timestamp, assigned by the emitter. */
  timestamp: string;
  data: ProtocolAgUiEventData;
}

export type ProtocolAgUiEventHandler = (event: ProtocolAgUiEvent) => void;

/** Build an event without an emitter (sequence supplied by the caller). */
export function makeProtocolAgUiEvent(
  type: ProtocolAgUiEventType,
  runId: string,
  sequence: number,
  data: ProtocolAgUiEventData,
  stepId?: string,
): ProtocolAgUiEvent {
  const event: ProtocolAgUiEvent = {
    type,
    runId,
    sequence,
    timestamp: new Date().toISOString(),
    data,
  };
  if (stepId !== undefined) event.stepId = stepId;
  return event;
}

function truncateText(value: string, max: number): string {
  if (value.length <= max) return value;
  return value.slice(0, max);
}

function isSecretShapedKey(key: string): boolean {
  return /(api[_-]?key|secret|token|password|passwd|auth|credential|private[_-]?key)/i.test(key);
}

/** Deep-clone a JSON-safe value, dropping secret-shaped keys, depth-capped. */
export function sanitiseProtocolStateValue(value: unknown, depth = 0): unknown {
  if (value === null || typeof value !== 'object') {
    return typeof value === 'string' ? truncateText(value, PROTOCOL_AGUI_MAX_TEXT_CHARS) : value;
  }
  if (depth >= PROTOCOL_AGUI_MAX_STATE_DEPTH) return '[truncated]';
  if (Array.isArray(value)) {
    return value.slice(0, PROTOCOL_AGUI_MAX_STATE_KEYS).map((v) => sanitiseProtocolStateValue(v, depth + 1));
  }
  const out: Record<string, unknown> = {};
  let count = 0;
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    if (count >= PROTOCOL_AGUI_MAX_STATE_KEYS) break;
    if (isSecretShapedKey(key)) continue;
    out[key] = sanitiseProtocolStateValue(val, depth + 1);
    count += 1;
  }
  return out;
}

/** Validate a parsed event; returns the problems, empty = valid. */
export function validateProtocolAgUiEvent(event: unknown): string[] {
  const problems: string[] = [];
  if (typeof event !== 'object' || event === null || Array.isArray(event)) {
    return ['event is not an object'];
  }
  const record = event as Record<string, unknown>;
  if (!isProtocolAgUiEventType(record['type'])) problems.push('type is not a known AG-UI 1.0 event type');
  if (typeof record['runId'] !== 'string' || record['runId'] === '') problems.push('runId must be a non-empty string');
  if (typeof record['sequence'] !== 'number' || !Number.isInteger(record['sequence']) || (record['sequence'] as number) < 0) {
    problems.push('sequence must be a non-negative integer');
  }
  if (typeof record['timestamp'] !== 'string' || Number.isNaN(Date.parse(record['timestamp'] as string))) {
    problems.push('timestamp must be an ISO-8601 string');
  }
  if (record['stepId'] !== undefined && typeof record['stepId'] !== 'string') {
    problems.push('stepId must be a string when present');
  }
  if (typeof record['data'] !== 'object' || record['data'] === null || Array.isArray(record['data'])) {
    problems.push('data must be an object');
  }
  return problems;
}

export function isValidProtocolAgUiEvent(event: unknown): event is ProtocolAgUiEvent {
  return validateProtocolAgUiEvent(event).length === 0;
}

/**
 * Ordered emitter for one run.
 *
 * - `emit()` assigns the next per-run `sequence` and timestamp,
 *   sanitises the payload, records the event in the run log and
 *   fans it out to subscribers and to the `AsyncIterable` stream.
 * - `stream()` is an async generator: a consumer can
 *   `for await (const event of emitter.stream())` and sees every
 *   event in order, including events emitted before it started
 *   consuming (replay from the log), then live events until a
 *   terminal event arrives.
 * - `finish()` / `fail()` / `cancel()` emit the terminal event
 *   with optional `TokenUsage`; after a terminal event the
 *   emitter refuses further events (they are dropped and
 *   counted, never silently reordered after the end).
 */
export class ProtocolAgUiEmitter {
  readonly runId: string;
  private sequence = 0;
  private readonly log: ProtocolAgUiEvent[] = [];
  private readonly handlers = new Set<ProtocolAgUiEventHandler>();
  private readonly waiters: Array<(event: ProtocolAgUiEvent | null) => void> = [];
  private terminal: ProtocolAgUiTerminalEventType | null = null;
  private droppedAfterTerminal = 0;

  constructor(runId: string) {
    if (!runId) throw new Error('ProtocolAgUiEmitter needs a non-empty runId.');
    this.runId = runId;
  }

  /** True once a terminal event was emitted. */
  get isTerminal(): boolean {
    return this.terminal !== null;
  }

  /** Which terminal event ended the run, if any. */
  get terminalType(): ProtocolAgUiTerminalEventType | null {
    return this.terminal;
  }

  /** Events dropped because they arrived after the terminal event. */
  get droppedCount(): number {
    return this.droppedAfterTerminal;
  }

  /** All events emitted so far, in order (a copy). */
  events(): ProtocolAgUiEvent[] {
    return [...this.log];
  }

  /** Number of events emitted so far. */
  get count(): number {
    return this.log.length;
  }

  subscribe(handler: ProtocolAgUiEventHandler): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  emit(
    type: ProtocolAgUiEventType,
    data: ProtocolAgUiEventData,
    stepId?: string,
  ): ProtocolAgUiEvent | null {
    if (this.terminal !== null) {
      this.droppedAfterTerminal += 1;
      return null;
    }
    const clean = this.sanitise(type, data);
    const event = makeProtocolAgUiEvent(type, this.runId, this.sequence, clean, stepId);
    this.sequence += 1;
    this.log.push(event);
    if (isProtocolAgUiTerminalEventType(type)) this.terminal = type;
    for (const handler of [...this.handlers]) handler(event);
    const waiter = this.waiters.shift();
    if (waiter) waiter(event);
    return event;
  }

  /** Convenience: emit RUN_STARTED. */
  start(data: ProtocolRunStartedData = {}, stepId?: string): ProtocolAgUiEvent | null {
    return this.emit('RUN_STARTED', data, stepId);
  }

  /** Convenience: emit RUN_FINISHED with usage. */
  finish(
    data: Omit<ProtocolRunFinishedData, 'status'> & { status?: ProtocolRunStatus } = {},
    stepId?: string,
  ): ProtocolAgUiEvent | null {
    return this.emit('RUN_FINISHED', { status: 'completed', ...data }, stepId);
  }

  /** Convenience: emit RUN_ERROR with usage. */
  fail(message: string, usage?: ProtocolTokenUsage, stepId?: string): ProtocolAgUiEvent | null {
    return this.emit(
      'RUN_ERROR',
      usage ? { message, usage } : { message },
      stepId,
    );
  }

  /** Convenience: emit RUN_CANCELLED with usage. */
  cancel(usage?: ProtocolTokenUsage, stepId?: string): ProtocolAgUiEvent | null {
    return this.emit(
      'RUN_CANCELLED',
      usage ? { message: 'Run cancelled.', usage } : { message: 'Run cancelled.' },
      stepId,
    );
  }

  /** Stream every event in order, then end after the terminal event. */
  async *stream(): AsyncIterable<ProtocolAgUiEvent> {
    let index = 0;
    while (true) {
      if (index < this.log.length) {
        const event = this.log[index] as ProtocolAgUiEvent;
        index += 1;
        yield event;
        if (isProtocolAgUiTerminalEventType(event.type)) return;
        continue;
      }
      if (this.terminal !== null) return;
      const event = await new Promise<ProtocolAgUiEvent | null>((resolve) => {
        this.waiters.push(resolve);
      });
      if (event === null) return;
    }
  }

  /** Wait for the terminal event (or null when the timeout elapses). */
  waitForTerminal(timeoutMs = 30_000): Promise<ProtocolAgUiEvent | null> {
    const existing = this.log.find((e) => isProtocolAgUiTerminalEventType(e.type));
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.handlers.delete(handler);
        resolve(null);
      }, timeoutMs);
      const handler: ProtocolAgUiEventHandler = (event) => {
        if (!isProtocolAgUiTerminalEventType(event.type)) return;
        clearTimeout(timer);
        this.handlers.delete(handler);
        resolve(event);
      };
      this.handlers.add(handler);
    });
  }

  private sanitise(type: ProtocolAgUiEventType, data: ProtocolAgUiEventData): ProtocolAgUiEventData {
    switch (type) {
      case 'TEXT_MESSAGE_CONTENT': {
        const d = data as ProtocolTextMessageContentData;
        return { ...d, delta: truncateText(d.delta, PROTOCOL_AGUI_MAX_TEXT_CHARS) };
      }
      case 'THINKING_CONTENT': {
        const d = data as ProtocolThinkingContentData;
        return { ...d, delta: truncateText(d.delta, PROTOCOL_AGUI_MAX_TEXT_CHARS) };
      }
      case 'TEXT_MESSAGE_END': {
        const d = data as ProtocolTextMessageEndData;
        return d.text === undefined
          ? d
          : { ...d, text: truncateText(d.text, PROTOCOL_AGUI_MAX_TEXT_CHARS) };
      }
      case 'TOOL_CALL_START': {
        const d = data as ProtocolToolCallStartData;
        return { ...d, argKeys: d.argKeys?.slice(0, 64) };
      }
      case 'TOOL_CALL_ARGS': {
        const d = data as ProtocolToolCallArgsData;
        return { ...d, argsJson: truncateText(d.argsJson, PROTOCOL_AGUI_MAX_ARGS_CHARS) };
      }
      case 'TOOL_CALL_RESULT': {
        const d = data as ProtocolToolCallResultData;
        return d.resultPreview === undefined
          ? d
          : { ...d, resultPreview: truncateText(d.resultPreview, PROTOCOL_AGUI_MAX_RESULT_CHARS) };
      }
      case 'STATE_SNAPSHOT': {
        const d = data as ProtocolStateSnapshotData;
        return { state: sanitiseProtocolStateValue(d.state) as Record<string, unknown> };
      }
      case 'STATE_DELTA': {
        const d = data as ProtocolStateDeltaData;
        return { delta: sanitiseProtocolStateValue(d.delta) as Record<string, unknown> };
      }
      case 'MESSAGES_SNAPSHOT': {
        const d = data as ProtocolMessagesSnapshotData;
        return {
          messages: d.messages.slice(0, 200).map((m) => ({
            role: m.role,
            content: truncateText(m.content, PROTOCOL_AGUI_MAX_TEXT_CHARS),
          })),
        };
      }
      default:
        return data;
    }
  }
}

/**
 * Bridge down to the older 16-type `agui/` vocabulary: the
 * overlapping types keep their names, the v1.15-only types map
 * to the closest legacy event (or to `CUSTOM` when there is no
 * close match). Returns null only for events with no legacy
 * equivalent at all — currently none, every type maps.
 */
export function protocolAgUiToLegacyType(type: ProtocolAgUiEventType): string {
  switch (type) {
    case 'RUN_CANCELLED':
      return 'RUN_FINISHED';
    case 'RUN_PAUSED':
      return 'CUSTOM';
    case 'THINKING_CONTENT':
      return 'TEXT_MESSAGE_CONTENT';
    case 'TOOL_CALL_ERROR':
      return 'TOOL_CALL_RESULT';
    case 'MESSAGES_SNAPSHOT':
      return 'STATE_SNAPSHOT';
    case 'INTERRUPT_STARTED':
    case 'INTERRUPT_RESOLVED':
    case 'INTERRUPT_CANCELLED':
    case 'INTERRUPT_TIMEOUT':
      return 'CUSTOM';
    case 'SUBAGENT_STARTED':
    case 'SUBAGENT_FINISHED':
    case 'SUBAGENT_ERROR':
      return 'CUSTOM';
    case 'GENERATIVE_UI_START':
    case 'GENERATIVE_UI_DELTA':
    case 'GENERATIVE_UI_END':
    case 'GENERATIVE_UI_RESPONSE':
      return 'CUSTOM';
    case 'RAW':
      return 'CUSTOM';
    case 'ACTIVITY':
      return 'CUSTOM';
    default:
      return type;
  }
}

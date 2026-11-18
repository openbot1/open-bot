/**
 * Protocols v3 — AG-UI 1.0 canonical event run (v1.19, Team T3).
 *
 * Idea only, learned from the public AG-UI 1.0 description in
 * docs/repo-survey-v119.md section 2: one request, one ordered
 * event stream (31 event types, 8 groups); interrupt-and-resume as
 * a first-class feature; subagent events. No code, text or asset
 * from any other repo is copied here.
 *
 * This builds on the existing AG-UI layers without touching them:
 *  - `protocols/aguiEvents.ts` — the 31-type vocabulary, groups,
 *    `makeProtocolAgUiEvent`, `validateProtocolAgUiEvent`;
 *  - `protocols/interrupt.ts` — the v1.15 interrupt manager;
 *  - `protocolsV2/aguiStreamV2.ts` — the v2 run state machine
 *    (idle/running/paused/finished, replay from a sequence).
 * v3 is the canonical run orchestrator on top:
 *   1. a typed builder for every event group — `runStarted`,
 *      `textDelta`, `toolCallStart/Args/End/Result/Error`,
 *      `stateSnapshot/Delta`, `interruptStarted/Resolved`,
 *      `subagentStarted/Finished/Error`, `generativeUiStart/Delta/
 *      End`, `activity` — each validated before it is emitted, so
 *      a malformed event can never enter the stream;
 *   2. a run orchestrator (`AgUiV3Run`) that owns the sequence
 *      counter, the text/tool-call accumulation, subagent runs
 *      (each with its own sequence space under the parent run),
 *      interrupt-and-resume with a timeout, and a snapshot of the
 *      run (text so far, tool calls, state) that a reconnecting
 *      client can fetch instead of replaying the whole stream;
 *   3. gap detection + replay: a consumer checks the sequence of
 *      every event it receives and asks for the missing range;
 *      `replayFrom(sequence)` re-emits buffered events.
 *
 * Events are plain JSON so they travel over NDJSON / IPC / SSE
 * unchanged. Secrets are never placed in event data (the v1.15
 * validator already truncates and redacts secret-shaped keys).
 */

import {
  PROTOCOL_AGUI_EVENT_TYPES,
  PROTOCOL_AGUI_TERMINAL_EVENT_TYPES,
  makeProtocolAgUiEvent,
  protocolAgUiEventGroup,
  protocolAgUiEventTypesOfGroup,
  validateProtocolAgUiEvent,
  type ProtocolAgUiEvent,
  type ProtocolAgUiEventData,
  type ProtocolAgUiEventGroup,
  type ProtocolAgUiEventType,
} from '../protocols/aguiEvents';

/** AG-UI version this run speaks. */
export const AGUI_V3_VERSION = '1.0';
/** Max events buffered per run for replay. */
export const AGUI_V3_MAX_BUFFERED_EVENTS = 2000;
/** Max chars of accumulated text kept in a run snapshot. */
export const AGUI_V3_MAX_SNAPSHOT_TEXT = 200_000;
/** Default interrupt timeout (0 = wait forever). */
export const AGUI_V3_DEFAULT_INTERRUPT_TIMEOUT_MS = 0;

/** Error raised by the v3 AG-UI run. */
export class AgUiV3Error extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'AgUiV3Error';
    this.code = code;
  }
}

/** Run lifecycle states (v3 adds `interrupted` as an explicit state). */
export type AgUiV3RunStatus =
  | 'idle'
  | 'running'
  | 'paused'
  | 'interrupted'
  | 'finished'
  | 'error'
  | 'cancelled';

/** One tool call tracked inside a run. */
export interface AgUiV3ToolCall {
  toolCallId: string;
  toolName: string;
  argsText: string;
  status: 'started' | 'args' | 'ended' | 'result' | 'error';
  resultText?: string;
  errorText?: string;
}

/** One subagent run tracked inside a parent run. */
export interface AgUiV3Subagent {
  subagentId: string;
  name?: string;
  status: 'started' | 'finished' | 'error';
  errorText?: string;
  events: number;
}

/** One pending interrupt. */
export interface AgUiV3Interrupt {
  interruptId: string;
  kind: 'approval' | 'form' | 'choice';
  payload: Record<string, unknown>;
  raisedAt: string;
  /** Resolve timer (cleared on resolve/cancel). */
  timer?: ReturnType<typeof setTimeout>;
  resolve: (answer: unknown) => void;
  reject: (error: Error) => void;
}

/** Snapshot of a run (for a reconnecting client). */
export interface AgUiV3RunSnapshot {
  runId: string;
  status: AgUiV3RunStatus;
  sequence: number;
  title?: string;
  text: string;
  thinkingText: string;
  toolCalls: AgUiV3ToolCall[];
  subagents: AgUiV3Subagent[];
  state: Record<string, unknown>;
  pendingInterruptId?: string;
  eventCount: number;
}

/** Options for a v3 run. */
export interface AgUiV3RunOptions {
  title?: string;
  /** Interrupt timeout in ms (0 = wait forever). */
  interruptTimeoutMs?: number;
  /** Listener for every emitted event. */
  onEvent?: (event: ProtocolAgUiEvent) => void;
}

/** Re-export the v1.15 vocabulary for callers that only import v3. */
export {
  PROTOCOL_AGUI_EVENT_TYPES,
  PROTOCOL_AGUI_TERMINAL_EVENT_TYPES,
  protocolAgUiEventGroup,
  protocolAgUiEventTypesOfGroup,
};
export type { ProtocolAgUiEvent, ProtocolAgUiEventData, ProtocolAgUiEventGroup, ProtocolAgUiEventType };

/**
 * Validate one event against the AG-UI 1.0 vocabulary and the
 * per-type data shape. Returns the problems (empty = valid).
 */
export function validateAgUiV3Event(event: unknown): string[] {
  return validateProtocolAgUiEvent(event);
}

/**
 * Build one AG-UI 1.0 event with an explicit sequence number.
 * Throws `AgUiV3Error` when the type is unknown or the event does
 * not validate.
 */
export function buildAgUiV3Event(
  type: ProtocolAgUiEventType,
  runId: string,
  sequence: number,
  data: ProtocolAgUiEventData,
  stepId?: string,
): ProtocolAgUiEvent {
  const event = makeProtocolAgUiEvent(type, runId, sequence, data, stepId);
  const problems = validateProtocolAgUiEvent(event);
  if (problems.length > 0) {
    throw new AgUiV3Error('INVALID_EVENT', `Invalid AG-UI event ${type}: ${problems.join('; ')}`);
  }
  return event;
}

/** Detect a sequence gap in a received event list (returns missing ranges). */
export function detectAgUiV3Gaps(events: readonly ProtocolAgUiEvent[]): Array<{ from: number; to: number }> {
  const gaps: Array<{ from: number; to: number }> = [];
  if (events.length === 0) return gaps;
  const sequences = [...new Set(events.map((e) => e.sequence))].sort((a, b) => a - b);
  for (let i = 1; i < sequences.length; i++) {
    const prev = sequences[i - 1];
    const current = sequences[i];
    if (current > prev + 1) gaps.push({ from: prev + 1, to: current - 1 });
  }
  return gaps;
}

/**
 * Canonical AG-UI 1.0 run orchestrator.
 *
 * State machine:
 *   idle -> running -> finished | error | cancelled
 *   running -> paused (interrupt) -> running (resume)
 *   running -> interrupted (explicit interrupt state) -> running
 * A run that finishes while an interrupt is pending finishes only
 * after the interrupt is resolved or cancelled — the stream never
 * strands a user-facing question.
 */
export class AgUiV3Run {
  readonly runId: string;
  private status: AgUiV3RunStatus = 'idle';
  private sequence = 0;
  private readonly events: ProtocolAgUiEvent[] = [];
  private readonly onEvent?: (event: ProtocolAgUiEvent) => void;
  private readonly interruptTimeoutMs: number;
  private readonly title?: string;
  private text = '';
  private thinkingText = '';
  private readonly toolCalls = new Map<string, AgUiV3ToolCall>();
  private readonly subagents = new Map<string, AgUiV3Subagent>();
  private state: Record<string, unknown> = {};
  private pendingInterrupt: AgUiV3Interrupt | null = null;
  private finishRequested = false;

  constructor(runId: string, options: AgUiV3RunOptions = {}) {
    if (!runId) throw new AgUiV3Error('BAD_RUN_ID', 'runId must be a non-empty string');
    this.runId = runId;
    this.title = options.title;
    this.interruptTimeoutMs = options.interruptTimeoutMs ?? AGUI_V3_DEFAULT_INTERRUPT_TIMEOUT_MS;
    this.onEvent = options.onEvent;
  }

  /** Current run status. */
  getStatus(): AgUiV3RunStatus {
    return this.status;
  }

  /** Next sequence number (also the count of emitted events). */
  eventCount(): number {
    return this.events.length;
  }

  /** All buffered events (oldest first). */
  bufferedEvents(): ProtocolAgUiEvent[] {
    return [...this.events];
  }

  /** Pending interrupt, if any. */
  getPendingInterrupt(): { interruptId: string; kind: string; payload: Record<string, unknown> } | null {
    if (!this.pendingInterrupt) return null;
    return {
      interruptId: this.pendingInterrupt.interruptId,
      kind: this.pendingInterrupt.kind,
      payload: this.pendingInterrupt.payload,
    };
  }

  private emit(
    type: ProtocolAgUiEventType,
    data: ProtocolAgUiEventData,
    stepId?: string,
  ): ProtocolAgUiEvent {
    const event = buildAgUiV3Event(type, this.runId, this.sequence, data, stepId);
    this.sequence += 1;
    if (this.events.length >= AGUI_V3_MAX_BUFFERED_EVENTS) this.events.shift();
    this.events.push(event);
    this.onEvent?.(event);
    return event;
  }

  /** Start the run (idle -> running). */
  start(): ProtocolAgUiEvent {
    if (this.status !== 'idle') {
      throw new AgUiV3Error('BAD_STATE', `Cannot start a run in state ${this.status}`);
    }
    this.status = 'running';
    return this.emit('RUN_STARTED', {
      ...(this.title ? { title: this.title } : {}),
    } as ProtocolAgUiEventData);
  }

  /** Append text delta (accumulates into the snapshot). */
  textDelta(delta: string, messageId?: string): ProtocolAgUiEvent {
    this.requireRunning('textDelta');
    this.text += delta;
    if (this.text.length > AGUI_V3_MAX_SNAPSHOT_TEXT) {
      this.text = this.text.slice(-AGUI_V3_MAX_SNAPSHOT_TEXT);
    }
    return this.emit('TEXT_MESSAGE_CONTENT', {
      delta,
      ...(messageId ? { messageId } : {}),
    } as ProtocolAgUiEventData);
  }

  /** Append thinking delta. */
  thinkingDelta(delta: string): ProtocolAgUiEvent {
    this.requireRunning('thinkingDelta');
    this.thinkingText += delta;
    return this.emit('THINKING_CONTENT', { delta } as ProtocolAgUiEventData);
  }

  /** Start a tool call. */
  toolCallStart(toolCallId: string, toolName: string, stepId?: string): ProtocolAgUiEvent {
    this.requireRunning('toolCallStart');
    this.toolCalls.set(toolCallId, { toolCallId, toolName, argsText: '', status: 'started' });
    return this.emit('TOOL_CALL_START', {
      toolCallId,
      toolName,
    } as ProtocolAgUiEventData, stepId);
  }

  /** Append tool-call arguments (JSON text chunks). */
  toolCallArgs(toolCallId: string, argsDelta: string, stepId?: string): ProtocolAgUiEvent {
    this.requireRunning('toolCallArgs');
    const call = this.toolCalls.get(toolCallId);
    if (!call) throw new AgUiV3Error('UNKNOWN_TOOL_CALL', `No tool call ${toolCallId} in this run`);
    call.argsText += argsDelta;
    call.status = 'args';
    return this.emit('TOOL_CALL_ARGS', {
      toolCallId,
      delta: argsDelta,
    } as ProtocolAgUiEventData, stepId);
  }

  /** End a tool call (arguments complete). */
  toolCallEnd(toolCallId: string, stepId?: string): ProtocolAgUiEvent {
    this.requireRunning('toolCallEnd');
    const call = this.toolCalls.get(toolCallId);
    if (!call) throw new AgUiV3Error('UNKNOWN_TOOL_CALL', `No tool call ${toolCallId} in this run`);
    call.status = 'ended';
    return this.emit('TOOL_CALL_END', { toolCallId } as ProtocolAgUiEventData, stepId);
  }

  /** Deliver a tool-call result. */
  toolCallResult(toolCallId: string, result: string, stepId?: string): ProtocolAgUiEvent {
    this.requireRunning('toolCallResult');
    const call = this.toolCalls.get(toolCallId);
    if (!call) throw new AgUiV3Error('UNKNOWN_TOOL_CALL', `No tool call ${toolCallId} in this run`);
    call.status = 'result';
    call.resultText = result;
    return this.emit('TOOL_CALL_RESULT', {
      toolCallId,
      result,
    } as ProtocolAgUiEventData, stepId);
  }

  /** Deliver a tool-call error. */
  toolCallError(toolCallId: string, error: string, stepId?: string): ProtocolAgUiEvent {
    this.requireRunning('toolCallError');
    const call = this.toolCalls.get(toolCallId);
    if (!call) throw new AgUiV3Error('UNKNOWN_TOOL_CALL', `No tool call ${toolCallId} in this run`);
    call.status = 'error';
    call.errorText = error;
    return this.emit('TOOL_CALL_ERROR', {
      toolCallId,
      error,
    } as ProtocolAgUiEventData, stepId);
  }

  /** Replace the shared state snapshot. */
  stateSnapshot(state: Record<string, unknown>): ProtocolAgUiEvent {
    this.requireRunning('stateSnapshot');
    this.state = { ...state };
    return this.emit('STATE_SNAPSHOT', { state: this.state } as ProtocolAgUiEventData);
  }

  /** Apply a state delta (shallow merge into the snapshot). */
  stateDelta(delta: Record<string, unknown>): ProtocolAgUiEvent {
    this.requireRunning('stateDelta');
    this.state = { ...this.state, ...delta };
    return this.emit('STATE_DELTA', { delta } as ProtocolAgUiEventData);
  }

  /** Start a subagent run (its events carry the subagent step id). */
  subagentStart(subagentId: string, name?: string): ProtocolAgUiEvent {
    this.requireRunning('subagentStart');
    this.subagents.set(subagentId, {
      subagentId,
      ...(name ? { name } : {}),
      status: 'started',
      events: 0,
    });
    return this.emit('SUBAGENT_STARTED', {
      subagentId,
      ...(name ? { name } : {}),
    } as ProtocolAgUiEventData, subagentId);
  }

  /** Finish a subagent run. */
  subagentFinish(subagentId: string): ProtocolAgUiEvent {
    this.requireRunning('subagentFinish');
    const sub = this.subagents.get(subagentId);
    if (!sub) throw new AgUiV3Error('UNKNOWN_SUBAGENT', `No subagent ${subagentId} in this run`);
    sub.status = 'finished';
    return this.emit('SUBAGENT_FINISHED', { subagentId } as ProtocolAgUiEventData, subagentId);
  }

  /** Fail a subagent run. */
  subagentError(subagentId: string, error: string): ProtocolAgUiEvent {
    this.requireRunning('subagentError');
    const sub = this.subagents.get(subagentId);
    if (!sub) throw new AgUiV3Error('UNKNOWN_SUBAGENT', `No subagent ${subagentId} in this run`);
    sub.status = 'error';
    sub.errorText = error;
    return this.emit('SUBAGENT_ERROR', {
      subagentId,
      error,
    } as ProtocolAgUiEventData, subagentId);
  }

  /** Start a generative-UI surface on the stream. */
  generativeUiStart(surfaceId: string, componentId: string): ProtocolAgUiEvent {
    this.requireRunning('generativeUiStart');
    return this.emit('GENERATIVE_UI_START', {
      surfaceId,
      componentId,
    } as ProtocolAgUiEventData);
  }

  /** Send a generative-UI delta (state patch). */
  generativeUiDelta(surfaceId: string, delta: Record<string, unknown>): ProtocolAgUiEvent {
    this.requireRunning('generativeUiDelta');
    return this.emit('GENERATIVE_UI_DELTA', {
      surfaceId,
      delta,
    } as ProtocolAgUiEventData);
  }

  /** End a generative-UI surface. */
  generativeUiEnd(surfaceId: string): ProtocolAgUiEvent {
    this.requireRunning('generativeUiEnd');
    return this.emit('GENERATIVE_UI_END', { surfaceId } as ProtocolAgUiEventData);
  }

  /** Emit a custom activity event (progress note for the UI). */
  activity(message: string): ProtocolAgUiEvent {
    this.requireRunning('activity');
    return this.emit('ACTIVITY', { message } as ProtocolAgUiEventData);
  }

  /**
   * Raise an interrupt: emits INTERRUPT_STARTED, moves the run to
   * `paused`, and returns a promise that resolves with the user's
   * answer (or rejects on cancel / timeout). The run cannot finish
   * while the interrupt is pending.
   */
  raiseInterrupt(
    kind: 'approval' | 'form' | 'choice',
    payload: Record<string, unknown>,
  ): { interruptId: string; answer: Promise<unknown> } {
    // Check the pending interrupt BEFORE requireRunning: a pending
    // interrupt pauses the run, so requireRunning would throw PAUSED
    // first and this INTERRUPT_PENDING branch could never fire.
    if (this.pendingInterrupt) {
      throw new AgUiV3Error('INTERRUPT_PENDING', 'An interrupt is already pending for this run');
    }
    this.requireRunning('raiseInterrupt');
    const interruptId = `int-${this.runId}-${this.sequence}`;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const answer = new Promise<unknown>((resolve, reject) => {
      const record: AgUiV3Interrupt = {
        interruptId,
        kind,
        payload,
        raisedAt: new Date().toISOString(),
        resolve: (value: unknown) => {
          if (timer) clearTimeout(timer);
          resolve(value);
        },
        reject: (error: Error) => {
          if (timer) clearTimeout(timer);
          reject(error);
        },
      };
      if (this.interruptTimeoutMs > 0) {
        timer = setTimeout(() => {
          record.timer = undefined;
          this.cancelInterrupt(interruptId, 'timeout');
        }, this.interruptTimeoutMs);
        record.timer = timer;
      }
      this.pendingInterrupt = record;
    });
    this.status = 'paused';
    this.emit('INTERRUPT_STARTED', {
      interruptId,
      kind,
      ...payload,
    } as ProtocolAgUiEventData);
    return { interruptId, answer };
  }

  /** Resolve the pending interrupt with the user's answer (paused -> running). */
  resolveInterrupt(interruptId: string, answer: unknown): ProtocolAgUiEvent {
    if (!this.pendingInterrupt || this.pendingInterrupt.interruptId !== interruptId) {
      throw new AgUiV3Error('NO_SUCH_INTERRUPT', `No pending interrupt ${interruptId}`);
    }
    const pending = this.pendingInterrupt;
    this.pendingInterrupt = null;
    this.status = 'running';
    pending.resolve(answer);
    const event = this.emit('INTERRUPT_RESOLVED', {
      interruptId,
      answer,
    } as ProtocolAgUiEventData);
    if (this.finishRequested) void this.finish();
    return event;
  }

  /** Cancel the pending interrupt (paused -> running, answer rejected). */
  cancelInterrupt(interruptId: string, reason: 'cancelled' | 'timeout' = 'cancelled'): ProtocolAgUiEvent {
    if (!this.pendingInterrupt || this.pendingInterrupt.interruptId !== interruptId) {
      throw new AgUiV3Error('NO_SUCH_INTERRUPT', `No pending interrupt ${interruptId}`);
    }
    const pending = this.pendingInterrupt;
    this.pendingInterrupt = null;
    this.status = 'running';
    pending.reject(new AgUiV3Error('INTERRUPT_CANCELLED', `Interrupt ${interruptId} ${reason}`));
    const type = reason === 'timeout' ? 'INTERRUPT_TIMEOUT' : 'INTERRUPT_CANCELLED';
    const event = this.emit(type, { interruptId } as ProtocolAgUiEventData);
    if (this.finishRequested) void this.finish();
    return event;
  }

  /**
   * Finish the run. When an interrupt is pending, the finish is
   * deferred until the interrupt resolves or cancels.
   */
  finish(): ProtocolAgUiEvent | null {
    if (this.pendingInterrupt) {
      this.finishRequested = true;
      return null;
    }
    if (this.status !== 'running' && this.status !== 'paused') {
      throw new AgUiV3Error('BAD_STATE', `Cannot finish a run in state ${this.status}`);
    }
    this.status = 'finished';
    this.emit('TEXT_MESSAGE_END', {} as ProtocolAgUiEventData);
    return this.emit('RUN_FINISHED', {} as ProtocolAgUiEventData);
  }

  /** Fail the run (also rejects a pending interrupt). */
  fail(error: string): ProtocolAgUiEvent {
    if (this.pendingInterrupt) {
      const pending = this.pendingInterrupt;
      this.pendingInterrupt = null;
      pending.reject(new AgUiV3Error('RUN_FAILED', `Run failed while interrupt was pending: ${error}`));
    }
    this.status = 'error';
    return this.emit('RUN_ERROR', { error } as ProtocolAgUiEventData);
  }

  /** Cancel the run (also rejects a pending interrupt). */
  cancel(): ProtocolAgUiEvent {
    if (this.pendingInterrupt) {
      const pending = this.pendingInterrupt;
      this.pendingInterrupt = null;
      pending.reject(new AgUiV3Error('RUN_CANCELLED', 'Run cancelled while interrupt was pending'));
    }
    this.status = 'cancelled';
    return this.emit('RUN_CANCELLED', {} as ProtocolAgUiEventData);
  }

  /** Re-emit buffered events after a sequence number (reconnect replay). */
  replayFrom(sequence: number): ProtocolAgUiEvent[] {
    return this.events.filter((e) => e.sequence >= sequence);
  }

  /** Snapshot of the run for a reconnecting client. */
  snapshot(): AgUiV3RunSnapshot {
    return {
      runId: this.runId,
      status: this.status,
      sequence: this.sequence,
      ...(this.title ? { title: this.title } : {}),
      text: this.text,
      thinkingText: this.thinkingText,
      toolCalls: [...this.toolCalls.values()],
      subagents: [...this.subagents.values()],
      state: { ...this.state },
      ...(this.pendingInterrupt ? { pendingInterruptId: this.pendingInterrupt.interruptId } : {}),
      eventCount: this.events.length,
    };
  }

  private requireRunning(caller: string): void {
    if (this.status !== 'running' && this.status !== 'paused') {
      throw new AgUiV3Error('BAD_STATE', `Cannot call ${caller} while the run is ${this.status}`);
    }
    if (this.status === 'paused' && caller !== 'resolveInterrupt' && caller !== 'cancelInterrupt') {
      throw new AgUiV3Error('PAUSED', `Run is paused by an interrupt; resolve or cancel it before ${caller}`);
    }
  }
}

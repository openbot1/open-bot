/**
 * Protocols v2 — AG-UI event stream v2 (v1.16, Team T2).
 *
 * Idea only, learned from the public AG-UI 1.0 description in
 * docs/repo-survey-v116.md section 7: one request, one ordered
 * event stream (31 event types, 8 groups); interrupt-and-resume
 * as a first-class feature; subagent events. No code, text or
 * asset from any other repo is copied here. This builds on the
 * v1.15 stream (`protocols/aguiEvents.ts` + `protocols/interrupt.ts`)
 * without touching them: v1.15 has the 31-type vocabulary and a
 * standalone interrupt manager; v2 wires them into one run
 * state machine — the stream itself pauses, waits for the user,
 * and resumes — and adds replay/resume from a sequence number
 * so a client that reconnects mid-run sees exactly what it
 * missed.
 *
 * Run state machine:
 *   idle -> running -> paused (interrupt) -> running -> finished
 *   running -> error | cancelled
 *   paused -> running (resume) | cancelled
 * An interrupt raised while the run is not `running` is refused;
 * resolving an interrupt that is not pending is refused; a run
 * that finishes while an interrupt is pending finishes only
 * after the interrupt is resolved or cancelled — the stream
 * never strands a user-facing question.
 *
 * Event ordering: every event carries a per-run monotonic
 * `sequence` (assigned by the emitter), a `runId`, and a
 * `stepId` when it belongs to a step. Consumers detect gaps by
 * sequence; `replayFrom(sequence)` re-emits buffered events
 * after a sequence number. Events are plain JSON objects so
 * they travel over NDJSON/IPC/SSE unchanged.
 *
 * Interrupts are first-class: `raiseInterrupt()` emits
 * INTERRUPT_STARTED, moves the run to `paused`, and returns a
 * promise that resolves with the user's answer (or rejects on
 * cancel/timeout). `resumeRun()` resolves it, emits
 * INTERRUPT_RESOLVED + RUN_RESUMED, and the run continues.
 * The interrupt payload is an approval, a form, or a choice —
 * validated the same way v1.15 validates them.
 */

import {
  PROTOCOL_AGUI_EVENT_TYPES,
  PROTOCOL_AGUI_TERMINAL_EVENT_TYPES,
  makeProtocolAgUiEvent,
  validateProtocolAgUiEvent,
  type ProtocolAgUiEvent,
  type ProtocolAgUiEventData,
  type ProtocolAgUiEventType,
} from '../protocols/aguiEvents';
import {
  ProtocolInterruptManager,
  validateProtocolInterruptPayload,
  type ProtocolInterruptPayload,
  type ProtocolInterruptResolution,
} from '../protocols/interrupt';

/** AG-UI v2 stream identifier. */
export const AGUI_V2_VERSION = 'agui/1.0';
export const AGUI_V2_MAX_BUFFERED_EVENTS = 1000;

export type AgUiV2RunStatus = 'idle' | 'running' | 'paused' | 'finished' | 'error' | 'cancelled';

/** One buffered event, with its delivery metadata. */
export interface AgUiV2BufferedEvent {
  event: ProtocolAgUiEvent;
  atMs: number;
}

/** Error raised by the v2 stream. */
export class AgUiV2StreamError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'AgUiV2StreamError';
    this.code = code;
  }
}

export interface AgUiV2StreamOptions {
  runId: string;
  /** Interrupt timeout in ms (default 5 minutes). */
  interruptTimeoutMs?: number;
  /** Events kept for replay (default 1000). */
  maxBufferedEvents?: number;
  /** Called for every emitted event (transport hook). */
  onEvent?: (event: ProtocolAgUiEvent) => void;
}

/**
 * One AG-UI v2 run: an ordered, replayable event stream with
 * interrupt-and-resume built into the run lifecycle.
 */
export class AgUiV2Stream {
  readonly runId: string;
  private readonly interruptManager: ProtocolInterruptManager;
  private readonly maxBuffered: number;
  private readonly onEvent?: (event: ProtocolAgUiEvent) => void;
  private readonly events: AgUiV2BufferedEvent[] = [];
  private readonly subagentRuns = new Map<string, { status: AgUiV2RunStatus; startedAtMs: number }>();
  private status: AgUiV2RunStatus = 'idle';
  private sequence = 0;
  private stepCounter = 0;
  private currentStepId: string | null = null;
  private tokenUsage: { inputTokens: number; outputTokens: number; provider: string; model: string } | null = null;
  private finishReason: string | null = null;

  constructor(options: AgUiV2StreamOptions) {
    this.runId = options.runId;
    this.maxBuffered = options.maxBufferedEvents ?? AGUI_V2_MAX_BUFFERED_EVENTS;
    this.onEvent = options.onEvent;
    this.interruptManager = new ProtocolInterruptManager({
      defaultTimeoutMs: options.interruptTimeoutMs ?? 300_000,
    });
  }

  /** Current run status. */
  getStatus(): AgUiV2RunStatus {
    return this.status;
  }

  /** Next sequence number that will be assigned. */
  nextSequence(): number {
    return this.sequence;
  }

  /** Events buffered so far (oldest first). */
  bufferedEvents(): ProtocolAgUiEvent[] {
    return this.events.map((e) => e.event);
  }

  /**
   * Replay events after `afterSequence` (exclusive). Used when a
   * client reconnects mid-run: it asks for everything after the
   * last sequence it saw.
   */
  replayFrom(afterSequence: number): ProtocolAgUiEvent[] {
    return this.events.filter((e) => e.event.sequence > afterSequence).map((e) => e.event);
  }

  /** True when the run has reached a terminal state. */
  isTerminal(): boolean {
    return this.status === 'finished' || this.status === 'error' || this.status === 'cancelled';
  }

  /** Interrupts currently pending on this run. */
  pendingInterrupts(): string[] {
    return this.interruptManager.pendingForRun(this.runId).map((i) => i.id);
  }

  private emitRaw(type: ProtocolAgUiEventType, data: Record<string, unknown>): ProtocolAgUiEvent {
    const event = makeProtocolAgUiEvent(
      type,
      this.runId,
      this.sequence,
      data as unknown as ProtocolAgUiEventData,
      this.currentStepId ?? undefined,
    );
    this.sequence += 1;
    this.events.push({ event, atMs: Date.now() });
    while (this.events.length > this.maxBuffered) this.events.shift();
    this.onEvent?.(event);
    return event;
  }

  /**
   * Emit one event. Validates the event shape first; refuses to
   * emit after a terminal event (the stream is over) and refuses
   * lifecycle events that contradict the run state (e.g. a second
   * RUN_STARTED). Returns the emitted event.
   */
  emit(type: ProtocolAgUiEventType, data: Record<string, unknown> = {}): ProtocolAgUiEvent {
    if (this.isTerminal() && !(PROTOCOL_AGUI_TERMINAL_EVENT_TYPES as readonly string[]).includes(type)) {
      throw new AgUiV2StreamError('STREAM_TERMINATED', `Run ${this.runId} is ${this.status}; the stream is over`);
    }
    if (type === 'RUN_STARTED' && this.status !== 'idle') {
      throw new AgUiV2StreamError('INVALID_RUN_STATE', `Cannot start run ${this.runId} while it is ${this.status}`);
    }
    const event = this.emitRaw(type, data);
    const problems = validateProtocolAgUiEvent(event);
    if (problems.length > 0) {
      // Roll the invalid event back out: a bad event must never
      // reach a consumer, and the sequence must stay gapless.
      this.events.pop();
      this.sequence -= 1;
      throw new AgUiV2StreamError('INVALID_EVENT', problems.join('; '));
    }
    if (type === 'RUN_STARTED') this.status = 'running';
    if (type === 'RUN_FINISHED') { this.status = 'finished'; this.finishReason = 'completed'; }
    if (type === 'RUN_ERROR') { this.status = 'error'; this.finishReason = 'error'; }
    if (type === 'RUN_CANCELLED') { this.status = 'cancelled'; this.finishReason = 'cancelled'; }
    if (type === 'RUN_PAUSED') this.status = 'paused';
    return event;
  }

  /** Start the run (emits RUN_STARTED). */
  startRun(data: Record<string, unknown> = {}): ProtocolAgUiEvent {
    return this.emit('RUN_STARTED', data);
  }

  /** Begin a step (tool call, message, thinking block). Returns the step id. */
  startStep(kind: string): string {
    this.stepCounter += 1;
    this.currentStepId = `step-${this.stepCounter}`;
    this.emit('TEXT_MESSAGE_START', { messageId: this.currentStepId, kind });
    return this.currentStepId;
  }

  /** End the current step. */
  endStep(): void {
    if (this.currentStepId === null) return;
    this.emit('TEXT_MESSAGE_END', { messageId: this.currentStepId });
    this.currentStepId = null;
  }

  /** Append streamed text to the current message. */
  textDelta(delta: string, messageId = 'm1'): ProtocolAgUiEvent {
    return this.emit('TEXT_MESSAGE_CONTENT', { messageId, delta });
  }

  /** Record token usage; attached to the terminal event. */
  setTokenUsage(usage: { inputTokens: number; outputTokens: number; provider: string; model: string }): void {
    this.tokenUsage = usage;
  }

  /** Finish the run successfully (emits RUN_FINISHED with usage when known). */
  finishRun(data: Record<string, unknown> = {}): ProtocolAgUiEvent {
    if (this.interruptManager.pendingForRun(this.runId).length > 0) {
      throw new AgUiV2StreamError(
        'INTERRUPT_PENDING',
        'Cannot finish the run while an interrupt is pending — resolve or cancel it first.',
      );
    }
    return this.emit('RUN_FINISHED', { ...(this.tokenUsage ? { usage: this.tokenUsage } : {}), ...data });
  }

  /** Fail the run (emits RUN_ERROR). */
  failRun(error: string, data: Record<string, unknown> = {}): ProtocolAgUiEvent {
    return this.emit('RUN_ERROR', { error, ...data });
  }

  /** Cancel the run (emits RUN_CANCELLED; also cancels pending interrupts). */
  cancelRun(reason = 'cancelled by user'): ProtocolAgUiEvent {
    this.interruptManager.cancelForRun(this.runId);
    return this.emit('RUN_CANCELLED', { reason });
  }

  /**
   * Raise an interrupt and pause the run. The returned promise
   * resolves with the user's answer (the validated answer
   * record); the run stays `paused` until `resolveInterrupt()`
   * (or cancel/timeout) resumes it. The payload is validated
   * exactly like v1.15 interrupts.
   */
  raiseInterrupt(payload: ProtocolInterruptPayload): Promise<Record<string, unknown>> {
    if (this.status !== 'running') {
      return Promise.reject(new AgUiV2StreamError('INVALID_RUN_STATE', `Cannot interrupt a ${this.status} run`));
    }
    const problems = validateProtocolInterruptPayload(payload);
    if (problems.length > 0) {
      return Promise.reject(new AgUiV2StreamError('INVALID_INTERRUPT', problems.join('; ')));
    }
    this.emit('RUN_PAUSED', { reason: 'interrupt', interruptKind: payload.kind });
    const promise = this.interruptManager.raise(this.runId, payload);
    return promise.then(
      (answer) => {
        this.status = 'running';
        return answer;
      },
      (error) => {
        // A cancelled/timed-out interrupt leaves the run paused;
        // the caller decides (cancelRun / resolveInterrupt).
        throw error;
      },
    );
  }

  /** Resolve a pending interrupt with the user's answer; resumes the run. */
  resolveInterrupt(interruptId: string, answer: Record<string, unknown>): ProtocolInterruptResolution {
    const resolution = this.interruptManager.resume(interruptId, answer);
    if (resolution.applied) {
      this.emitRaw('INTERRUPT_RESOLVED', { interruptId, answer });
      if (this.status === 'paused' && this.interruptManager.pendingForRun(this.runId).length === 0) {
        this.status = 'running';
        this.emitRaw('RUN_STARTED', { resumed: true });
      }
    }
    return resolution;
  }

  /** Cancel a pending interrupt; the run stays paused until cancelled or resumed. */
  cancelInterrupt(interruptId: string, reason = 'cancelled by user'): void {
    this.interruptManager.cancel(interruptId, reason);
  }

  /** Start a subagent run (emits SUBAGENT_STARTED). Returns the subagent run id. */
  startSubagent(subagentRunId: string, data: Record<string, unknown> = {}): ProtocolAgUiEvent {
    if (this.subagentRuns.has(subagentRunId)) {
      throw new AgUiV2StreamError('DUPLICATE_SUBAGENT', `Subagent run already exists: ${subagentRunId}`);
    }
    this.subagentRuns.set(subagentRunId, { status: 'running', startedAtMs: Date.now() });
    return this.emit('SUBAGENT_STARTED', { subagentRunId, ...data });
  }

  /** Finish a subagent run (emits SUBAGENT_FINISHED). */
  finishSubagent(subagentRunId: string, data: Record<string, unknown> = {}): ProtocolAgUiEvent {
    const sub = this.subagentRuns.get(subagentRunId);
    if (!sub) throw new AgUiV2StreamError('UNKNOWN_SUBAGENT', `Unknown subagent run: ${subagentRunId}`);
    sub.status = 'finished';
    return this.emit('SUBAGENT_FINISHED', { subagentRunId, ...data });
  }

  /** Fail a subagent run (emits SUBAGENT_ERROR). The parent run keeps going. */
  failSubagent(subagentRunId: string, error: string): ProtocolAgUiEvent {
    const sub = this.subagentRuns.get(subagentRunId);
    if (!sub) throw new AgUiV2StreamError('UNKNOWN_SUBAGENT', `Unknown subagent run: ${subagentRunId}`);
    sub.status = 'error';
    return this.emit('SUBAGENT_ERROR', { subagentRunId, error });
  }

  /** Subagent runs started under this run, with their status. */
  subagents(): Array<{ subagentRunId: string; status: AgUiV2RunStatus }> {
    return [...this.subagentRuns.entries()].map(([subagentRunId, sub]) => ({ subagentRunId, status: sub.status }));
  }

  /** The 31 event types this stream speaks (from the v1.15 vocabulary). */
  static eventTypes(): readonly ProtocolAgUiEventType[] {
    return PROTOCOL_AGUI_EVENT_TYPES;
  }
}

/**
 * Validate that a received event stream has no sequence gaps:
 * returns the missing sequence numbers (empty = gapless).
 * A gap means the transport dropped events and the client
 * should call `replayFrom(lastSeen)` instead of trusting the
 * stream as-is.
 */
export function findAgUiV2SequenceGaps(events: readonly ProtocolAgUiEvent[]): number[] {
  const gaps: number[] = [];
  let expected: number | null = null;
  for (const event of events) {
    if (expected === null) { expected = event.sequence + 1; continue; }
    while (expected < event.sequence) { gaps.push(expected); expected += 1; }
    expected = event.sequence + 1;
  }
  return gaps;
}

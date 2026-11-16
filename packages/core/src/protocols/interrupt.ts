/**
 * Interrupt-and-resume — protocol triad v1.15 (Team T2).
 *
 * Idea only, learned from the public AG-UI 1.0 description in
 * docs/repo-survey-v115.md section 1: interrupt-and-resume is a
 * first-class feature — the agent pauses mid-run, pushes a
 * form/approval up to the frontend, and blocks until the user
 * resumes or cancels. No code, text or asset from any other repo
 * is copied here.
 *
 * How it works:
 * - The agent calls `raise()` with an interrupt payload (kind
 *   `approval` / `form` / `choice`, plus the fields the frontend
 *   needs). The manager records the interrupt as `pending`,
 *   emits `INTERRUPT_STARTED` on the run's emitter when one is
 *   attached, and returns a promise that resolves with the
 *   user's answer — or rejects when the user cancels or the
 *   timeout elapses.
 * - The frontend answers through `resume()` (answer payload)
 *   or `cancel()` (reason). `resolve()` is the single entry
 *   point for both, so a double answer can never happen: the
 *   first resolution wins, later ones are reported as
 *   `already-resolved`.
 * - A timeout (`timeoutMs`, default 10 minutes) auto-cancels
 *   the interrupt with `INTERRUPT_TIMEOUT` so a run can never
 *   hang forever on a user who walked away.
 * - Form payloads are validated before they are accepted:
 *   field names must be safe identifiers, field kinds are from
 *   a fixed list, and no field may carry a default that looks
 *   like a secret. The answer is validated against the same
 *   field list (unknown fields rejected, required fields
 *   enforced) so a forged answer cannot smuggle extra data into
 *   the run.
 *
 * This manager is transport-agnostic: it never touches the
 * network or the DOM. The desktop renderer renders the payload
 * (see `a2ui.ts` surfaces) and calls `resume()`/`cancel()` via
 * IPC; the tools in `protocolV115Tools.ts` expose the same
 * operations to the agent.
 */

import {
  ProtocolAgUiEmitter,
  type ProtocolAgUiEvent,
  type ProtocolInterruptCancelledData,
  type ProtocolInterruptResolvedData,
  type ProtocolInterruptStartedData,
  type ProtocolInterruptTimeoutData,
} from './aguiEvents';

/** Kinds of interrupt the agent can raise. */
export type ProtocolInterruptKind = 'approval' | 'form' | 'choice';

/** Lifecycle of one interrupt. */
export type ProtocolInterruptStatus = 'pending' | 'resolved' | 'cancelled' | 'timed-out';

/** One field of a form interrupt. */
export interface ProtocolInterruptField {
  /** Safe identifier, e.g. `email`, `confirm_delete`. */
  name: string;
  /** Label shown to the user. */
  label: string;
  kind: 'text' | 'number' | 'boolean' | 'choice' | 'secret';
  required?: boolean;
  /** Options for `choice` fields. */
  options?: string[];
  /** Default value shown in the form (never a secret). */
  defaultValue?: string | number | boolean;
  /** Hint shown under the field. */
  hint?: string;
}

/** One option of a choice interrupt. */
export interface ProtocolInterruptChoice {
  id: string;
  label: string;
  /** Short description shown under the label. */
  description?: string;
}

/** Payload the agent sends when it raises an interrupt. */
export interface ProtocolInterruptPayload {
  kind: ProtocolInterruptKind;
  /** Short title shown to the user. */
  title: string;
  /** What the agent is waiting for (plain text, no secrets). */
  detail?: string;
  /** Form fields (kind `form`). */
  fields?: ProtocolInterruptField[];
  /** Options (kind `choice`). */
  choices?: ProtocolInterruptChoice[];
  /** Approval text (kind `approval`): what the user is approving. */
  approvalText?: string;
  /** Milliseconds before the interrupt auto-cancels (default 600_000). */
  timeoutMs?: number;
}

/** One recorded interrupt. */
export interface ProtocolInterrupt {
  id: string;
  runId: string;
  stepId?: string;
  payload: ProtocolInterruptPayload;
  status: ProtocolInterruptStatus;
  createdAt: string;
  resolvedAt?: string;
  /** The user's answer (status `resolved`). */
  answer?: Record<string, unknown>;
  /** Why it was cancelled / timed out. */
  reason?: string;
}

/** Outcome of a `resolve()` call. */
export interface ProtocolInterruptResolution {
  /** True when this call actually resolved the interrupt. */
  applied: boolean;
  /** `already-resolved` when a previous call won the race. */
  outcome: 'resolved' | 'cancelled' | 'already-resolved' | 'not-found';
  interrupt?: ProtocolInterrupt;
}

/** Options for the manager. */
export interface ProtocolInterruptManagerOptions {
  /** Default timeout for interrupts without their own `timeoutMs`. */
  defaultTimeoutMs?: number;
  /** Clock, injectable for tests. Defaults to the real timers. */
  now?: () => number;
}

/** Default interrupt timeout: 10 minutes. */
export const PROTOCOL_INTERRUPT_DEFAULT_TIMEOUT_MS = 600_000;
/** Hard ceiling: an interrupt may never wait longer than 1 hour. */
export const PROTOCOL_INTERRUPT_MAX_TIMEOUT_MS = 3_600_000;
/** Hard floor: shorter than 1 second is almost certainly a bug. */
export const PROTOCOL_INTERRUPT_MIN_TIMEOUT_MS = 1_000;

const FIELD_NAME_RE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const CHOICE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const SECRET_SHAPED_RE = /(api[_-]?key|secret|token|password|passwd|auth|credential|private[_-]?key)/i;

let interruptCounter = 0;

function nextInterruptId(): string {
  interruptCounter += 1;
  return `int-${Date.now().toString(36)}-${interruptCounter}`;
}

/** Validate an interrupt payload; returns the problems, empty = valid. */
export function validateProtocolInterruptPayload(payload: unknown): string[] {
  const problems: string[] = [];
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return ['interrupt payload is not an object'];
  }
  const record = payload as Record<string, unknown>;
  if (record['kind'] !== 'approval' && record['kind'] !== 'form' && record['kind'] !== 'choice') {
    problems.push('kind must be approval, form or choice');
  }
  if (typeof record['title'] !== 'string' || (record['title'] as string).trim() === '') {
    problems.push('title must be a non-empty string');
  }
  if (record['title'] !== undefined && typeof record['title'] === 'string' && (record['title'] as string).length > 200) {
    problems.push('title must be at most 200 characters');
  }
  if (record['detail'] !== undefined && typeof record['detail'] !== 'string') {
    problems.push('detail must be a string when present');
  }
  if (record['timeoutMs'] !== undefined) {
    const t = record['timeoutMs'];
    if (typeof t !== 'number' || !Number.isFinite(t) || t < PROTOCOL_INTERRUPT_MIN_TIMEOUT_MS || t > PROTOCOL_INTERRUPT_MAX_TIMEOUT_MS) {
      problems.push(`timeoutMs must be between ${PROTOCOL_INTERRUPT_MIN_TIMEOUT_MS} and ${PROTOCOL_INTERRUPT_MAX_TIMEOUT_MS}`);
    }
  }
  if (record['kind'] === 'form') {
    const fields = record['fields'];
    if (!Array.isArray(fields) || fields.length === 0) {
      problems.push('form interrupts need a non-empty fields array');
    } else {
      if (fields.length > 32) problems.push('form interrupts allow at most 32 fields');
      const seen = new Set<string>();
      for (const field of fields as unknown[]) {
        if (typeof field !== 'object' || field === null || Array.isArray(field)) {
          problems.push('each form field must be an object');
          continue;
        }
        const f = field as Record<string, unknown>;
        if (typeof f['name'] !== 'string' || !FIELD_NAME_RE.test(f['name'] as string)) {
          problems.push(`field name ${JSON.stringify(f['name'])} is not a safe identifier`);
        } else if (seen.has(f['name'] as string)) {
          problems.push(`duplicate field name ${f['name'] as string}`);
        } else {
          seen.add(f['name'] as string);
        }
        if (typeof f['label'] !== 'string' || (f['label'] as string).trim() === '') {
          problems.push(`field ${String(f['name'])} needs a non-empty label`);
        }
        if (!['text', 'number', 'boolean', 'choice', 'secret'].includes(String(f['kind']))) {
          problems.push(`field ${String(f['name'])} has an unknown kind`);
        }
        if (f['kind'] === 'choice') {
          if (!Array.isArray(f['options']) || (f['options'] as unknown[]).length === 0) {
            problems.push(`choice field ${String(f['name'])} needs a non-empty options array`);
          }
        }
        if (typeof f['defaultValue'] === 'string' && SECRET_SHAPED_RE.test(String(f['name']))) {
          problems.push(`field ${String(f['name'])} looks secret-shaped and must not carry a default`);
        }
      }
    }
  }
  if (record['kind'] === 'choice') {
    const choices = record['choices'];
    if (!Array.isArray(choices) || choices.length === 0) {
      problems.push('choice interrupts need a non-empty choices array');
    } else {
      if (choices.length > 16) problems.push('choice interrupts allow at most 16 choices');
      const seen = new Set<string>();
      for (const choice of choices as unknown[]) {
        if (typeof choice !== 'object' || choice === null || Array.isArray(choice)) {
          problems.push('each choice must be an object');
          continue;
        }
        const c = choice as Record<string, unknown>;
        if (typeof c['id'] !== 'string' || !CHOICE_ID_RE.test(c['id'] as string)) {
          problems.push(`choice id ${JSON.stringify(c['id'])} is not a safe identifier`);
        } else if (seen.has(c['id'] as string)) {
          problems.push(`duplicate choice id ${c['id'] as string}`);
        } else {
          seen.add(c['id'] as string);
        }
        if (typeof c['label'] !== 'string' || (c['label'] as string).trim() === '') {
          problems.push(`choice ${String(c['id'])} needs a non-empty label`);
        }
      }
    }
  }
  if (record['kind'] === 'approval' && record['approvalText'] !== undefined && typeof record['approvalText'] !== 'string') {
    problems.push('approvalText must be a string when present');
  }
  return problems;
}

/**
 * Validate a user's answer against the interrupt that asked for
 * it. Returns the problems, empty = valid.
 */
export function validateProtocolInterruptAnswer(
  interrupt: ProtocolInterrupt,
  answer: unknown,
): string[] {
  const problems: string[] = [];
  if (typeof answer !== 'object' || answer === null || Array.isArray(answer)) {
    return ['answer must be an object'];
  }
  const record = answer as Record<string, unknown>;
  const payload = interrupt.payload;
  if (payload.kind === 'approval') {
    if (typeof record['approved'] !== 'boolean') {
      problems.push('approval answer needs a boolean "approved" field');
    }
    if (typeof record['note'] !== 'undefined' && typeof record['note'] !== 'string') {
      problems.push('approval answer "note" must be a string when present');
    }
    for (const key of Object.keys(record)) {
      if (key !== 'approved' && key !== 'note') problems.push(`unexpected approval answer field ${key}`);
    }
    return problems;
  }
  if (payload.kind === 'choice') {
    if (typeof record['choiceId'] !== 'string') {
      problems.push('choice answer needs a string "choiceId" field');
    } else if (!(payload.choices ?? []).some((c) => c.id === record['choiceId'])) {
      problems.push(`choiceId ${record['choiceId'] as string} is not one of the offered choices`);
    }
    for (const key of Object.keys(record)) {
      if (key !== 'choiceId') problems.push(`unexpected choice answer field ${key}`);
    }
    return problems;
  }
  // form
  const fields = payload.fields ?? [];
  const byName = new Map(fields.map((f) => [f.name, f]));
  for (const key of Object.keys(record)) {
    if (!byName.has(key)) problems.push(`unexpected form answer field ${key}`);
  }
  for (const field of fields) {
    const value = record[field.name];
    if (value === undefined || value === null || value === '') {
      if (field.required) problems.push(`required field ${field.name} is missing`);
      continue;
    }
    switch (field.kind) {
      case 'text':
      case 'secret':
        if (typeof value !== 'string') problems.push(`field ${field.name} must be a string`);
        break;
      case 'number':
        if (typeof value !== 'number' || !Number.isFinite(value)) problems.push(`field ${field.name} must be a finite number`);
        break;
      case 'boolean':
        if (typeof value !== 'boolean') problems.push(`field ${field.name} must be a boolean`);
        break;
      case 'choice':
        if (typeof value !== 'string' || !(field.options ?? []).includes(value)) {
          problems.push(`field ${field.name} must be one of its options`);
        }
        break;
    }
  }
  return problems;
}

/** Error thrown when `raise()` rejects because the user cancelled. */
export class ProtocolInterruptCancelledError extends Error {
  readonly interruptId: string;
  constructor(interruptId: string, reason?: string) {
    super(reason ? `Interrupt ${interruptId} cancelled: ${reason}` : `Interrupt ${interruptId} cancelled.`);
    this.name = 'ProtocolInterruptCancelledError';
    this.interruptId = interruptId;
  }
}

/** Error thrown when `raise()` rejects because the timeout elapsed. */
export class ProtocolInterruptTimeoutError extends Error {
  readonly interruptId: string;
  readonly timeoutMs: number;
  constructor(interruptId: string, timeoutMs: number) {
    super(`Interrupt ${interruptId} timed out after ${timeoutMs}ms waiting for the user.`);
    this.name = 'ProtocolInterruptTimeoutError';
    this.interruptId = interruptId;
    this.timeoutMs = timeoutMs;
  }
}

interface PendingInterrupt {
  interrupt: ProtocolInterrupt;
  resolve: (answer: Record<string, unknown>) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Owns the pending interrupts of one or more runs.
 *
 * One manager per app process is the normal shape (the tools
 * factory creates a shared one); tests create a fresh manager
 * per case. An optional emitter hook lets the manager publish
 * INTERRUPT_STARTED / RESOLVED / CANCELLED / TIMEOUT events
 * onto the run's AG-UI stream.
 */
export class ProtocolInterruptManager {
  private readonly pending = new Map<string, PendingInterrupt>();
  private readonly history: ProtocolInterrupt[] = [];
  private readonly defaultTimeoutMs: number;
  private readonly now: () => number;
  private emitterForRun: ((runId: string) => ProtocolAgUiEmitter | undefined) | undefined;

  constructor(options: ProtocolInterruptManagerOptions = {}) {
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? PROTOCOL_INTERRUPT_DEFAULT_TIMEOUT_MS;
    this.now = options.now ?? Date.now;
  }

  /** Attach an emitter lookup so interrupts publish stream events. */
  attachEmitters(lookup: (runId: string) => ProtocolAgUiEmitter | undefined): void {
    this.emitterForRun = lookup;
  }

  /** Pending interrupts, oldest first. */
  pendingInterrupts(): ProtocolInterrupt[] {
    return [...this.pending.values()].map((p) => p.interrupt);
  }

  /** Pending interrupts of one run. */
  pendingForRun(runId: string): ProtocolInterrupt[] {
    return this.pendingInterrupts().filter((i) => i.runId === runId);
  }

  /** Every interrupt this manager has seen, in creation order. */
  allInterrupts(): ProtocolInterrupt[] {
    return [...this.history];
  }

  get(id: string): ProtocolInterrupt | undefined {
    return this.history.find((i) => i.id === id);
  }

  /**
   * Raise an interrupt and block until the user answers.
   *
   * Resolves with the validated answer. Rejects with
   * `ProtocolInterruptCancelledError` on cancel and
   * `ProtocolInterruptTimeoutError` on timeout. Throws
   * synchronously (before returning a promise) when the payload
   * is invalid.
   */
  raise(
    runId: string,
    payload: ProtocolInterruptPayload,
    stepId?: string,
  ): Promise<Record<string, unknown>> {
    const problems = validateProtocolInterruptPayload(payload);
    if (problems.length > 0) {
      throw new Error(`Invalid interrupt payload: ${problems.join('; ')}`);
    }
    if (!runId) throw new Error('raise() needs a non-empty runId.');
    const timeoutMs = payload.timeoutMs ?? this.defaultTimeoutMs;
    const interrupt: ProtocolInterrupt = {
      id: nextInterruptId(),
      runId,
      ...(stepId !== undefined ? { stepId } : {}),
      payload: { ...payload, timeoutMs },
      status: 'pending',
      createdAt: new Date(this.now()).toISOString(),
    };
    this.history.push(interrupt);
    const emitter = this.emitterForRun?.(runId);
    const started: ProtocolInterruptStartedData = {
      interruptId: interrupt.id,
      kind: payload.kind,
      title: payload.title,
      ...(payload.detail !== undefined ? { detail: payload.detail } : {}),
    };
    emitter?.emit('INTERRUPT_STARTED', started, stepId);
    emitter?.emit('RUN_PAUSED', { interruptId: interrupt.id, reason: payload.title }, stepId);
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => this.onTimeout(interrupt.id), timeoutMs);
      // `unref` so a pending interrupt never keeps the process alive in tests.
      if (typeof (timer as unknown as { unref?: () => void }).unref === 'function') {
        (timer as unknown as { unref: () => void }).unref();
      }
      this.pending.set(interrupt.id, { interrupt, resolve, reject, timer });
    });
  }

  /** The user answered: validate, record, resolve the waiting run. */
  resume(id: string, answer: Record<string, unknown>): ProtocolInterruptResolution {
    const entry = this.pending.get(id);
    if (!entry) {
      const known = this.get(id);
      return { applied: false, outcome: known ? 'already-resolved' : 'not-found', ...(known ? { interrupt: known } : {}) };
    }
    const problems = validateProtocolInterruptAnswer(entry.interrupt, answer);
    if (problems.length > 0) {
      throw new Error(`Invalid interrupt answer: ${problems.join('; ')}`);
    }
    this.finish(entry, 'resolved', answer);
    return { applied: true, outcome: 'resolved', interrupt: entry.interrupt };
  }

  /** The user declined: record, reject the waiting run. */
  cancel(id: string, reason?: string): ProtocolInterruptResolution {
    const entry = this.pending.get(id);
    if (!entry) {
      const known = this.get(id);
      return { applied: false, outcome: known ? 'already-resolved' : 'not-found', ...(known ? { interrupt: known } : {}) };
    }
    this.finish(entry, 'cancelled', undefined, reason ?? 'Cancelled by the user.');
    return { applied: true, outcome: 'cancelled', interrupt: entry.interrupt };
  }

  /** Resolve (answer) or cancel, from one call site. */
  resolve(
    id: string,
    outcome: 'resume' | 'cancel',
    answer?: Record<string, unknown>,
    reason?: string,
  ): ProtocolInterruptResolution {
    return outcome === 'resume'
      ? this.resume(id, answer ?? {})
      : this.cancel(id, reason);
  }

  /** Cancel every pending interrupt of a run (e.g. the run was aborted). */
  cancelForRun(runId: string, reason = 'Run ended.'): number {
    let count = 0;
    for (const entry of [...this.pending.values()]) {
      if (entry.interrupt.runId !== runId) continue;
      this.finish(entry, 'cancelled', undefined, reason);
      count += 1;
    }
    return count;
  }

  private onTimeout(id: string): void {
    const entry = this.pending.get(id);
    if (!entry) return;
    this.finish(entry, 'timed-out', undefined, `No answer within ${entry.interrupt.payload.timeoutMs}ms.`);
  }

  private finish(
    entry: PendingInterrupt,
    status: ProtocolInterruptStatus,
    answer?: Record<string, unknown>,
    reason?: string,
  ): void {
    const { interrupt } = entry;
    clearTimeout(entry.timer);
    this.pending.delete(interrupt.id);
    interrupt.status = status;
    interrupt.resolvedAt = new Date(this.now()).toISOString();
    if (answer !== undefined) interrupt.answer = answer;
    if (reason !== undefined) interrupt.reason = reason;
    const emitter = this.emitterForRun?.(interrupt.runId);
    const stepId = interrupt.stepId;
    if (status === 'resolved') {
      const data: ProtocolInterruptResolvedData = {
        interruptId: interrupt.id,
        answer: answer ?? {},
      };
      emitter?.emit('INTERRUPT_RESOLVED', data, stepId);
    } else if (status === 'cancelled') {
      const data: ProtocolInterruptCancelledData = {
        interruptId: interrupt.id,
        ...(reason !== undefined ? { reason } : {}),
      };
      emitter?.emit('INTERRUPT_CANCELLED', data, stepId);
    } else {
      const data: ProtocolInterruptTimeoutData = {
        interruptId: interrupt.id,
        timeoutMs: interrupt.payload.timeoutMs ?? this.defaultTimeoutMs,
      };
      emitter?.emit('INTERRUPT_TIMEOUT', data, stepId);
    }
    if (status === 'resolved') {
      entry.resolve(answer ?? {});
    } else if (status === 'cancelled') {
      entry.reject(new ProtocolInterruptCancelledError(interrupt.id, reason));
    } else {
      entry.reject(
        new ProtocolInterruptTimeoutError(interrupt.id, interrupt.payload.timeoutMs ?? this.defaultTimeoutMs),
      );
    }
  }
}

export type { ProtocolAgUiEvent };

/**
 * A2A v1.0 server (v11 generation) — in-process + JSON-RPC dispatch.
 *
 * The server implements all seven A2A 1.0 operations against a
 * V11TaskStore:
 *
 *  - SendMessage            — create a task (or answer inline) for a message.
 *  - SendStreamingMessage   — same, but yields SSE-style task events.
 *  - GetTask                — one task by id (with full history).
 *  - ListTasks              — cursor-paginated task list (new in 1.0).
 *  - CancelTask             — submitted/working/input-required -> cancelled.
 *  - SubscribeToTask        — async-iterator feed of a task's events.
 *  - GetExtendedAgentCard   — the card plus runtime details (skills
 *    with examples, limits, tenant views).
 *
 * Execution model: the server does NOT run a model. A `handler`
 * supplied by the host turns an inbound message into either a reply
 * message, an artifact, or a request for more input (`input-required`).
 * That keeps the server deterministic and testable, and keeps model
 * choice with the host. All inbound peer text runs through the
 * session guard first (guard.ts): a blocked message never reaches
 * the handler and never creates a task.
 *
 * The server also speaks JSON-RPC 2.0 (method names in types.ts):
 * `handleJsonRpc` dispatches one request object and returns the
 * response envelope. Streaming over JSON-RPC returns the event list
 * (the SSE wire framing itself lives in the HTTP layer / client).
 */

import { negotiateV11ProtocolVersion, validateV11AgentCard } from './card';
import { V11AuditLog } from './audit';
import { V11SessionGuard } from './guard';
import { V11TaskStore, transitionV11Task } from './taskStore';
import {
  V11_METHODS,
  V11_RPC_ERRORS,
  V11A2aError,
  isV11TerminalState,
  toV11WireState,
  v11PartsToText,
  v11TextMessage,
  type V11AgentCard,
  type V11Artifact,
  type V11JsonRpcRequest,
  type V11JsonRpcResponse,
  type V11ListTasksFilter,
  type V11Message,
  type V11SendResult,
  type V11Task,
  type V11TaskEvent,
  type V11TaskPage,
} from './types';

// Re-exported under a clearer name for callers that import from here.
export { V11_RPC_ERRORS as V11RpcErrors };

/** What the host's handler may return for one inbound message. */
export type V11HandlerOutcome =
  | { kind: 'reply'; text: string; artifacts?: V11Artifact[] }
  | { kind: 'needs-input'; question: string }
  | { kind: 'failed'; reason: string };

/** Host handler: turn an inbound (guard-cleaned) message into work. */
export type V11MessageHandler = (
  message: V11Message,
  task: V11Task,
) => Promise<V11HandlerOutcome> | V11HandlerOutcome;

/** Options for creating a v11 server. */
export interface V11ServerOptions {
  /** The card this server publishes (its identity). */
  card: V11AgentCard;
  /** Task store to use (a fresh one is created when omitted). */
  store?: V11TaskStore;
  /** Host handler. Default: echo the message back as a reply. */
  handler?: V11MessageHandler;
  /** Tenant this server instance serves (multi-tenancy). */
  tenantId?: string;
  /** Audit log to write to (a fresh one when omitted). */
  audit?: V11AuditLog;
  /** Max inbound message text length (DoS guard). Default 64 KiB. */
  maxMessageChars?: number;
  /** Max tasks the store keeps before refusing new ones. Default 1000. */
  maxTasks?: number;
}

/** Extended card: the card + runtime details for GetExtendedAgentCard. */
export interface V11ExtendedAgentCard {
  card: V11AgentCard;
  /** Negotiated version the server prefers. */
  protocolVersion: string;
  /** Supported versions, newest first. */
  supportedVersions: readonly string[];
  /** Limits the server enforces. */
  limits: { maxMessageChars: number; maxTasks: number; maxPageSize: number };
  /** Task counts by state (a live snapshot). */
  taskCounts: Record<string, number>;
  /** Tenants this server serves. */
  tenants: string[];
}

/** A subscriber waiting for a task's events. */
interface V11Subscriber {
  taskId: string;
  queue: V11TaskEvent[];
  resolveWait: (() => void) | null;
  closed: boolean;
}

/** Default handler: echo the inbound text back as a reply. */
export function v11EchoHandler(message: V11Message): V11HandlerOutcome {
  const text = v11PartsToText(message.parts);
  return { kind: 'reply', text: `echo: ${text}` };
}

export class V11A2aServer {
  readonly card: V11AgentCard;
  readonly store: V11TaskStore;
  readonly audit: V11AuditLog;
  private readonly handler: V11MessageHandler;
  private readonly tenantId?: string;
  private readonly maxMessageChars: number;
  private readonly maxTasks: number;
  private readonly subscribers = new Set<V11Subscriber>();
  private readonly guards = new Map<string, V11SessionGuard>();
  private started = false;

  constructor(options: V11ServerOptions) {
    this.card = options.card;
    this.store = options.store ?? new V11TaskStore();
    this.audit = options.audit ?? new V11AuditLog();
    this.handler = options.handler ?? v11EchoHandler;
    this.tenantId = options.tenantId;
    this.maxMessageChars = options.maxMessageChars ?? 64 * 1024;
    this.maxTasks = options.maxTasks ?? 1000;
  }

  get isStarted(): boolean {
    return this.started;
  }

  start(): void {
    this.started = true;
    this.audit.append('server.started', `A2A v11 server started for ${this.card.name} (${this.card.protocolVersion})`);
  }

  stop(): void {
    this.started = false;
    for (const sub of this.subscribers) sub.closed = true;
    this.subscribers.clear();
    this.audit.append('server.stopped', `A2A v11 server stopped for ${this.card.name}`);
  }

  /** The card this server publishes (a copy — callers cannot mutate it). */
  getAgentCard(): V11AgentCard {
    return JSON.parse(JSON.stringify(this.card)) as V11AgentCard;
  }

  /** Extended card: card + limits + live task counts + tenants. */
  getExtendedAgentCard(): V11ExtendedAgentCard {
    const counts: Record<string, number> = {};
    for (const task of this.store.all()) {
      counts[task.state] = (counts[task.state] ?? 0) + 1;
    }
    const tenants = (this.card.tenants ?? []).map((t) => t.tenantId);
    if (this.tenantId && !tenants.includes(this.tenantId)) tenants.push(this.tenantId);
    return {
      card: this.getAgentCard(),
      protocolVersion: this.card.protocolVersion,
      supportedVersions: this.card.supportedVersions ?? [this.card.protocolVersion],
      limits: { maxMessageChars: this.maxMessageChars, maxTasks: this.maxTasks, maxPageSize: 100 },
      taskCounts: counts,
      tenants,
    };
  }

  /** Guard for one conversation (created lazily, keyed by context id). */
  private guardFor(contextId: string): V11SessionGuard {
    let guard = this.guards.get(contextId);
    if (!guard) {
      guard = new V11SessionGuard();
      this.guards.set(contextId, guard);
    }
    return guard;
  }

  /** Validate + guard-scan an inbound message. Throws V11A2aError. */
  private checkInbound(message: V11Message): { cleaned: V11Message; contextId: string } {
    if (!message || typeof message !== 'object' || !Array.isArray(message.parts)) {
      throw new V11A2aError('message must have a parts array', V11_RPC_ERRORS.invalidParams);
    }
    const text = v11PartsToText(message.parts);
    if (text.length > this.maxMessageChars) {
      throw new V11A2aError(
        `message too long: ${text.length} chars (max ${this.maxMessageChars})`,
        V11_RPC_ERRORS.invalidParams,
      );
    }
    const contextId = message.contextId ?? `ctx-v11-${Date.now().toString(36)}`;
    const verdict = this.guardFor(contextId).scanTurn(text);
    if (verdict.decision === 'block') {
      this.audit.append('guard.block', `Blocked inbound message in ${contextId}: ${verdict.findings.map((f) => f.code).join(', ')}`, {
        data: { score: verdict.score, codes: verdict.findings.map((f) => f.code) },
      });
      throw new V11A2aError(
        `message blocked by injection guard: ${verdict.findings.map((f) => f.code).join(', ')}`,
        V11_RPC_ERRORS.injectionBlocked,
        { score: verdict.score, codes: verdict.findings.map((f) => f.code) },
      );
    }
    if (verdict.decision === 'sanitise') {
      this.audit.append('guard.sanitise', `Sanitised inbound message in ${contextId}`, {
        data: { score: verdict.score, codes: verdict.findings.map((f) => f.code) },
      });
    }
    const cleaned: V11Message = {
      ...message,
      contextId,
      parts: [{ kind: 'text', text: verdict.cleanedText }],
    };
    return { cleaned, contextId };
  }

  /**
   * SendMessage: run one message through the guard + handler and
   * return the resulting task. The task ends `completed` (reply),
   * `input-required` (needs input), or `failed` (handler failed).
   */
  async sendMessage(message: V11Message): Promise<V11SendResult> {
    this.requireStarted();
    if (this.store.count() >= this.maxTasks) {
      throw new V11A2aError(`task store full (${this.maxTasks} tasks)`, V11_RPC_ERRORS.internalError);
    }
    const { cleaned, contextId } = this.checkInbound(message);
    const task = this.store.create({
      contextId,
      tenantId: this.tenantId,
      initialMessage: cleaned,
    });
    this.audit.append('task.created', `Task ${task.id} created`, { taskId: task.id });
    let current = this.store.transition(task.id, 'working', 'processing message');
    this.emit({ kind: 'status-update', taskId: task.id, contextId, state: 'working', stateWire: toV11WireState('working'), final: false });
    const outcome = await this.handler(cleaned, current);
    if (outcome.kind === 'reply') {
      const reply = v11TextMessage('agent', outcome.text, { taskId: task.id, contextId });
      current = this.store.setMessage(task.id, reply);
      for (const artifact of outcome.artifacts ?? []) {
        current = this.store.addArtifact(task.id, artifact);
        this.emit({ kind: 'artifact-update', taskId: task.id, contextId, artifact, lastChunk: true });
      }
      current = this.store.transition(task.id, 'completed', 'reply sent');
      this.emit({ kind: 'status-update', taskId: task.id, contextId, state: 'completed', stateWire: toV11WireState('completed'), final: true, message: reply });
    } else if (outcome.kind === 'needs-input') {
      const question = v11TextMessage('agent', outcome.question, { taskId: task.id, contextId });
      current = this.store.setMessage(task.id, question);
      current = this.store.transition(task.id, 'input-required', outcome.question);
      this.emit({ kind: 'status-update', taskId: task.id, contextId, state: 'input-required', stateWire: toV11WireState('input-required'), final: false, message: question });
    } else {
      current = this.store.transition(task.id, 'failed', outcome.reason);
      this.emit({ kind: 'status-update', taskId: task.id, contextId, state: 'failed', stateWire: toV11WireState('failed'), final: true });
    }
    this.audit.append('task.transition', `Task ${task.id} -> ${current.state}`, { taskId: task.id });
    return { kind: 'task', task: current };
  }

  /**
   * SendStreamingMessage: same as SendMessage, but yields the task's
   * events as they happen (SSE-style). The final event is always a
   * terminal status update.
   */
  async *sendStreamingMessage(message: V11Message): AsyncGenerator<V11TaskEvent, V11SendResult, void> {
    this.requireStarted();
    const { cleaned, contextId } = this.checkInbound(message);
    const task = this.store.create({ contextId, tenantId: this.tenantId, initialMessage: cleaned });
    this.audit.append('task.created', `Task ${task.id} created (streaming)`, { taskId: task.id });
    yield { kind: 'status-update', taskId: task.id, contextId, state: 'submitted', stateWire: toV11WireState('submitted'), final: false };
    let current = this.store.transition(task.id, 'working', 'processing message');
    yield { kind: 'status-update', taskId: task.id, contextId, state: 'working', stateWire: toV11WireState('working'), final: false };
    const outcome = await this.handler(cleaned, current);
    if (outcome.kind === 'reply') {
      const reply = v11TextMessage('agent', outcome.text, { taskId: task.id, contextId });
      current = this.store.setMessage(task.id, reply);
      for (const artifact of outcome.artifacts ?? []) {
        current = this.store.addArtifact(task.id, artifact);
        yield { kind: 'artifact-update', taskId: task.id, contextId, artifact, lastChunk: true };
      }
      current = this.store.transition(task.id, 'completed', 'reply sent');
      yield { kind: 'status-update', taskId: task.id, contextId, state: 'completed', stateWire: toV11WireState('completed'), final: true, message: reply };
    } else if (outcome.kind === 'needs-input') {
      const question = v11TextMessage('agent', outcome.question, { taskId: task.id, contextId });
      current = this.store.setMessage(task.id, question);
      current = this.store.transition(task.id, 'input-required', outcome.question);
      yield { kind: 'status-update', taskId: task.id, contextId, state: 'input-required', stateWire: toV11WireState('input-required'), final: false, message: question };
    } else {
      current = this.store.transition(task.id, 'failed', outcome.reason);
      yield { kind: 'status-update', taskId: task.id, contextId, state: 'failed', stateWire: toV11WireState('failed'), final: true };
    }
    return { kind: 'task', task: current };
  }

  /** GetTask: one task by id, with full history. */
  getTask(taskId: string): V11Task {
    this.requireStarted();
    const task = this.store.get(taskId);
    if (!task) throw new V11A2aError(`task not found: ${taskId}`, V11_RPC_ERRORS.taskNotFound);
    return task;
  }

  /** ListTasks: cursor-paginated, optionally filtered. */
  listTasks(filter: V11ListTasksFilter = {}, cursor?: string, pageSize = 20): V11TaskPage {
    this.requireStarted();
    const page = this.store.list(filter, cursor, pageSize);
    this.audit.append('task.listed', `Listed ${page.tasks.length} tasks`, {
      data: { totalCount: page.totalCount, hasNext: page.nextCursor !== undefined },
    });
    return page;
  }

  /** CancelTask: only non-terminal tasks can be cancelled. */
  cancelTask(taskId: string, reason = 'cancelled by client'): V11Task {
    this.requireStarted();
    const task = this.store.get(taskId);
    if (!task) throw new V11A2aError(`task not found: ${taskId}`, V11_RPC_ERRORS.taskNotFound);
    if (isV11TerminalState(task.state)) {
      throw new V11A2aError(
        `task ${taskId} is ${task.state} and cannot be cancelled`,
        V11_RPC_ERRORS.taskNotCancellable,
      );
    }
    const next = transitionV11Task(task, 'cancelled', reason);
    this.store.put(next);
    this.emit({ kind: 'status-update', taskId, contextId: task.contextId, state: 'cancelled', stateWire: toV11WireState('cancelled'), final: true });
    this.audit.append('task.cancelled', `Task ${taskId} cancelled`, { taskId });
    return next;
  }

  /**
   * Prune terminal tasks older than `olderThanMs` (store hygiene —
   * live tasks are never touched). Returns the removed task ids.
   */
  pruneTerminalTasks(olderThanMs: number, now: Date = new Date()): string[] {
    this.requireStarted();
    const removed = this.store.pruneTerminal(olderThanMs, now);
    if (removed.length > 0) {
      this.audit.append('task.listed', `Pruned ${removed.length} terminal task(s) older than ${olderThanMs}ms`, {
        data: { removed },
      });
    }
    return removed;
  }

  /**
   * Resume a task that is waiting for input: the user (or caller)
   * supplies the missing input and the task goes back to `working`,
   * then the handler runs again on the combined text.
   */
  async resumeTask(taskId: string, input: V11Message): Promise<V11SendResult> {
    this.requireStarted();
    const task = this.store.get(taskId);
    if (!task) throw new V11A2aError(`task not found: ${taskId}`, V11_RPC_ERRORS.taskNotFound);
    if (task.state !== 'input-required') {
      throw new V11A2aError(`task ${taskId} is ${task.state}, not input-required`, V11_RPC_ERRORS.invalidParams);
    }
    const { cleaned } = this.checkInbound({ ...input, contextId: task.contextId });
    let current = this.store.transition(taskId, 'working', 'input received');
    const outcome = await this.handler(cleaned, current);
    if (outcome.kind === 'reply') {
      const reply = v11TextMessage('agent', outcome.text, { taskId, contextId: task.contextId });
      current = this.store.setMessage(taskId, reply);
      current = this.store.transition(taskId, 'completed', 'reply sent');
    } else if (outcome.kind === 'needs-input') {
      const question = v11TextMessage('agent', outcome.question, { taskId, contextId: task.contextId });
      current = this.store.setMessage(taskId, question);
      current = this.store.transition(taskId, 'input-required', outcome.question);
    } else {
      current = this.store.transition(taskId, 'failed', outcome.reason);
    }
    return { kind: 'task', task: current };
  }

  /**
   * SubscribeToTask: an async iterator of the task's future events.
   * The iterator ends when a terminal status update arrives, or when
   * the caller breaks out (unsubscribe). Past events are NOT replayed
   * — the caller should GetTask first for current state.
   */
  subscribeToTask(taskId: string): AsyncIterableIterator<V11TaskEvent> {
    this.requireStarted();
    const task = this.store.get(taskId);
    if (!task) throw new V11A2aError(`task not found: ${taskId}`, V11_RPC_ERRORS.taskNotFound);
    const sub: V11Subscriber = { taskId, queue: [], resolveWait: null, closed: false };
    this.subscribers.add(sub);
    const self = this;
    async function* gen(): AsyncIterableIterator<V11TaskEvent> {
      try {
        for (;;) {
          if (sub.closed) return;
          const event = sub.queue.shift();
          if (event) {
            yield event;
            if (event.kind === 'status-update' && event.final) return;
            continue;
          }
          await new Promise<void>((resolve) => {
            sub.resolveWait = resolve;
          });
        }
      } finally {
        sub.closed = true;
        self.subscribers.delete(sub);
      }
    }
    return gen();
  }

  /** Push an event to every subscriber of its task. */
  private emit(event: V11TaskEvent): void {
    for (const sub of this.subscribers) {
      if (sub.closed || sub.taskId !== event.taskId) continue;
      sub.queue.push(event);
      const resolve = sub.resolveWait;
      sub.resolveWait = null;
      if (resolve) resolve();
    }
  }

  /**
   * Negotiate the protocol version for a peer card, as the server
   * side of version negotiation. Returns the agreed version or throws
   * when there is no common version.
   */
  negotiateWith(peerCard: V11AgentCard): string {
    const validation = validateV11AgentCard(peerCard);
    if (!validation.valid) {
      throw new V11A2aError(
        `peer card invalid: ${validation.issues.map((i) => i.message).join('; ')}`,
        V11_RPC_ERRORS.cardInvalid,
      );
    }
    const result = negotiateV11ProtocolVersion(peerCard);
    if (!result.version) {
      throw new V11A2aError(result.reason ?? 'no common protocol version', V11_RPC_ERRORS.invalidParams);
    }
    return result.version;
  }

  /**
   * Dispatch one JSON-RPC 2.0 request (the JSON-RPC binding).
   * Streaming (`message/stream`) is answered with the collected
   * event list, since a single response object cannot stream.
   */
  async handleJsonRpc(request: V11JsonRpcRequest): Promise<V11JsonRpcResponse> {
    const id = request.id ?? 0;
    try {
      if (request.jsonrpc !== '2.0' || typeof request.method !== 'string') {
        throw new V11A2aError('invalid JSON-RPC request', V11_RPC_ERRORS.invalidRequest);
      }
      const params = (request.params ?? {}) as Record<string, unknown>;
      switch (request.method) {
        case V11_METHODS.getAgentCard: {
          return { jsonrpc: '2.0', id, result: this.getAgentCard() };
        }
        case V11_METHODS.getExtendedAgentCard: {
          return { jsonrpc: '2.0', id, result: this.getExtendedAgentCard() };
        }
        case V11_METHODS.sendMessage: {
          const message = params.message as V11Message;
          if (!message) throw new V11A2aError('params.message is required', V11_RPC_ERRORS.invalidParams);
          const result = await this.sendMessage(message);
          return { jsonrpc: '2.0', id, result };
        }
        case V11_METHODS.sendStreamingMessage: {
          const message = params.message as V11Message;
          if (!message) throw new V11A2aError('params.message is required', V11_RPC_ERRORS.invalidParams);
          const events: V11TaskEvent[] = [];
          const gen = this.sendStreamingMessage(message);
          let final: V11SendResult | undefined;
          for (;;) {
            const step = await gen.next();
            if (step.done) {
              final = step.value;
              break;
            }
            events.push(step.value);
          }
          return { jsonrpc: '2.0', id, result: { events, result: final } };
        }
        case V11_METHODS.getTask: {
          const taskId = params.taskId as string;
          if (typeof taskId !== 'string') throw new V11A2aError('params.taskId is required', V11_RPC_ERRORS.invalidParams);
          return { jsonrpc: '2.0', id, result: this.getTask(taskId) };
        }
        case V11_METHODS.listTasks: {
          const filter = (params.filter ?? {}) as V11ListTasksFilter;
          const cursor = params.cursor as string | undefined;
          const pageSize = typeof params.pageSize === 'number' ? params.pageSize : 20;
          return { jsonrpc: '2.0', id, result: this.listTasks(filter, cursor, pageSize) };
        }
        case V11_METHODS.cancelTask: {
          const taskId = params.taskId as string;
          if (typeof taskId !== 'string') throw new V11A2aError('params.taskId is required', V11_RPC_ERRORS.invalidParams);
          const reason = typeof params.reason === 'string' ? params.reason : undefined;
          return { jsonrpc: '2.0', id, result: this.cancelTask(taskId, reason) };
        }
        case V11_METHODS.subscribeToTask: {
          const taskId = params.taskId as string;
          if (typeof taskId !== 'string') throw new V11A2aError('params.taskId is required', V11_RPC_ERRORS.invalidParams);
          // Subscription over plain JSON-RPC is a long-poll: collect
          // events until the task terminates (or 5s passes).
          const task = this.getTask(taskId);
          if (isV11TerminalState(task.state)) {
            return { jsonrpc: '2.0', id, result: { taskId, events: [], terminal: true } };
          }
          const events: V11TaskEvent[] = [];
          const sub = this.subscribeToTask(taskId);
          const deadline = Date.now() + 5000;
          const iterator = sub[Symbol.asyncIterator]();
          for (;;) {
            const remaining = deadline - Date.now();
            if (remaining <= 0) break;
            const step = await Promise.race([
              iterator.next(),
              new Promise<{ done: true; value: undefined }>((resolve) =>
                setTimeout(() => resolve({ done: true, value: undefined }), remaining),
              ),
            ]);
            if (step.done) break;
            events.push(step.value);
            if (step.value.kind === 'status-update' && step.value.final) break;
          }
          return { jsonrpc: '2.0', id, result: { taskId, events, terminal: events.some((e) => e.kind === 'status-update' && e.final) } };
        }
        default:
          throw new V11A2aError(`method not found: ${request.method}`, V11_RPC_ERRORS.methodNotFound);
      }
    } catch (err) {
      const code = err instanceof V11A2aError ? err.code : V11_RPC_ERRORS.internalError;
      const message = err instanceof Error ? err.message : String(err);
      const data = err instanceof V11A2aError ? err.data : undefined;
      return { jsonrpc: '2.0', id, error: { code, message, ...(data !== undefined ? { data } : {}) } };
    }
  }

  private requireStarted(): void {
    if (!this.started) {
      throw new V11A2aError('A2A v11 server is not started', V11_RPC_ERRORS.internalError);
    }
  }
}

/** Backwards-friendly alias used by older import sites in this repo. */
export const V11_A2A_ERRORS_ALIAS = V11_RPC_ERRORS;

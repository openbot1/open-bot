/**
 * ACP v2 draft — sessions with message ids + out-of-turn updates
 * (v1.37, Team T2).
 *
 * Idea only, learned from the public protocol descriptions in
 * docs/repo-survey-v137.md: in the ACP v2 draft `session/prompt`
 * returns the id of the user message it created (instead of just
 * marking the turn done), and `session/update` can reach the
 * client OUTSIDE a prompt turn — the agent can report progress,
 * propose a file change or ask a follow-up without waiting for
 * the next user prompt. ACP v1 keeps running in parallel: a v1
 * session has no message ids and no out-of-turn updates, and
 * this module never pretends otherwise.
 *
 * This module is the open-bot implementation, built from scratch:
 *   - `AcpV6SessionEngine` — transport-free v2 session store.
 *     Every user message gets a stable id (`msg-…`) at prompt
 *     time; the prompt result returns that id so later updates,
 *     file changes and elicitations can reference the exact
 *     message they belong to. Turns, message lookup by id,
 *     replay from a message id, and resume after cancel are all
 *     keyed on those ids.
 *   - Out-of-turn updates: an update is a typed event
 *     (`progress` / `file-change` / `message` / `permission` /
 *     `completed`) with its own id, an optional
 *     `inReplyToMessageId`, and a delivery ledger (pending ->
 *     delivered / acknowledged). Subscribers get updates as they
 *     arrive, even between prompts; a client that was offline
 *     replays the pending ones.
 *   - Parallel v1: a v6 session may record the id of the v1
 *     session it mirrors (`v1SessionId`), and the engine can
 *     report which sessions run in both tracks at once. The v1
 *     track is owned by the v1 client — this engine only records
 *     the link, never drives v1.
 *
 * No code, text or asset from any other repo is copied here.
 */

/** Lifecycle of one ACP v2 session. */
export type AcpV6SessionStatus = 'active' | 'idle' | 'cancelled' | 'completed' | 'failed';
export const ACP_V6_SESSION_TERMINAL: readonly AcpV6SessionStatus[] = ['cancelled', 'completed', 'failed'];
export function isAcpV6SessionTerminal(status: AcpV6SessionStatus): boolean {
  return (ACP_V6_SESSION_TERMINAL as readonly AcpV6SessionStatus[]).includes(status);
}

/** One message inside a session — every message has a stable id. */
export interface AcpV6Message {
  messageId: string;
  role: 'user' | 'agent';
  text: string;
  at: number;
  /** Tool calls the agent made while answering this message (names only). */
  toolCalls?: string[];
  /** User message this agent message answers (agent messages only). */
  inReplyToMessageId?: string;
}

/** Kinds of out-of-turn update (`session/update` in the v2 draft). */
export type AcpV6UpdateKind = 'progress' | 'file-change' | 'message' | 'permission' | 'completed';
export const ACP_V6_UPDATE_KINDS: readonly AcpV6UpdateKind[] = [
  'progress',
  'file-change',
  'message',
  'permission',
  'completed',
];

/** Delivery state of one out-of-turn update. */
export type AcpV6UpdateDelivery = 'pending' | 'delivered' | 'acknowledged';
export const ACP_V6_UPDATE_DELIVERIES: readonly AcpV6UpdateDelivery[] = [
  'pending',
  'delivered',
  'acknowledged',
];

/** One out-of-turn update, delivered outside any prompt turn. */
export interface AcpV6Update {
  updateId: string;
  sessionId: string;
  kind: AcpV6UpdateKind;
  /** User message this update belongs to, when it has one. */
  inReplyToMessageId?: string;
  /** Free-form payload (progress percent, file change id, text…). */
  payload: Record<string, unknown>;
  createdAt: number;
  delivery: AcpV6UpdateDelivery;
  deliveredAt?: number;
  acknowledgedAt?: number;
}

/** One ACP v2 session, as the client reads it. */
export interface AcpV6Session {
  sessionId: string;
  agentId: string;
  /** Negotiated ACP version for this session (v2 draft or v1 in parallel). */
  acpVersion: string;
  status: AcpV6SessionStatus;
  createdAt: number;
  updatedAt: number;
  /** Ordered messages; every message carries its id. */
  messages: AcpV6Message[];
  /** Out-of-turn updates for this session (all delivery states). */
  updates: AcpV6Update[];
  /** Id of the parallel ACP v1 session, when this v2 session mirrors one. */
  v1SessionId?: string;
  /** True when this session runs alongside a v1 session. */
  runsParallelV1: boolean;
}

/** The agent's answer to one prompt: injected by the host. */
export type AcpV6AgentRunner = (
  sessionId: string,
  prompt: string,
  messageId: string,
  signal: AbortSignal,
) => Promise<{ text: string; toolCalls?: string[] }>;

/** A subscriber to out-of-turn updates. */
export type AcpV6UpdateSubscriber = (update: AcpV6Update) => void;

/** Error raised by ACP v2 session operations. */
export class AcpV6SessionError extends Error {
  readonly code:
    | 'unknown-session'
    | 'session-terminal'
    | 'unknown-message'
    | 'unknown-update'
    | 'no-runner'
    | 'cancelled'
    | 'method-not-advertised'
    | 'duplicate-subscriber';
  constructor(message: string, code: AcpV6SessionError['code']) {
    super(message);
    this.name = 'AcpV6SessionError';
    this.code = code;
  }
}

export interface AcpV6SessionOptions {
  /** Agent runner (the host wires the real agent behind it). */
  runner?: AcpV6AgentRunner;
  /** Clock override (tests). */
  now?: () => number;
  /** Id generator override (tests). */
  generateId?: (prefix: string) => string;
  /** Methods the peer advertised (default: the full v6 draft surface). */
  advertisedMethods?: readonly string[];
}

/** ACP v2 draft version this engine speaks. */
export const ACP_V6_DRAFT_VERSION = '2.0-draft';
/** ACP v1 — the stable track running in parallel. */
export const ACP_V6_V1_VERSION = '1.0';

/** Methods the v6 draft surface offers (incl. the new `session/update`). */
export const ACP_V6_SESSION_METHODS = [
  'session/new',
  'session/load',
  'session/prompt',
  'session/update',
  'session/cancel',
  'agent/authenticate',
  'fs/read_text_file',
  'fs/write_text_file',
] as const;

let acpV6SessionCounter = 0;
function defaultAcpV6SessionId(prefix: string): string {
  acpV6SessionCounter += 1;
  return `${prefix}-${Date.now().toString(36)}-${acpV6SessionCounter.toString(36)}`;
}

/** Result of `prompt()`: the answer AND the user message id. */
export interface AcpV6PromptResult {
  /** Id of the user message this prompt created — keep it to reference the turn later. */
  messageId: string;
  /** Id of the agent's answer message. */
  answerMessageId: string;
  text: string;
  toolCalls: string[];
}

/**
 * Transport-free ACP v2 draft session engine. The host injects
 * a runner (how prompts reach the agent); the engine owns
 * sessions, message ids, cancels, and the out-of-turn update
 * ledger, and refuses methods the peer did not advertise.
 */
export class AcpV6SessionEngine {
  private readonly sessions = new Map<string, AcpV6Session>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly subscribers = new Map<string, AcpV6UpdateSubscriber>();
  private readonly runner?: AcpV6AgentRunner;
  private readonly now: () => number;
  private readonly generateId: (prefix: string) => string;
  private readonly advertisedMethods: ReadonlySet<string>;

  constructor(options: AcpV6SessionOptions = {}) {
    this.runner = options.runner;
    this.now = options.now ?? Date.now;
    this.generateId = options.generateId ?? defaultAcpV6SessionId;
    this.advertisedMethods = new Set(options.advertisedMethods ?? [...ACP_V6_SESSION_METHODS]);
  }

  /** True when the peer advertised this ACP method. */
  supportsMethod(method: string): boolean {
    return this.advertisedMethods.has(method);
  }

  private requireMethod(method: string): void {
    if (!this.supportsMethod(method)) {
      throw new AcpV6SessionError(
        `ACP method "${method}" was not advertised by this agent; refusing to send it.`,
        'method-not-advertised',
      );
    }
  }

  /**
   * Start a session with one agent. Pass `v1SessionId` when this
   * v2 session mirrors a parallel ACP v1 session.
   */
  newSession(agentId: string, opts: { acpVersion?: string; v1SessionId?: string } = {}): string {
    this.requireMethod('session/new');
    const sessionId = this.generateId('acp6-session');
    const at = this.now();
    this.sessions.set(sessionId, {
      sessionId,
      agentId,
      acpVersion: opts.acpVersion ?? ACP_V6_DRAFT_VERSION,
      status: 'active',
      createdAt: at,
      updatedAt: at,
      messages: [],
      updates: [],
      v1SessionId: opts.v1SessionId,
      runsParallelV1: opts.v1SessionId !== undefined,
    });
    return sessionId;
  }

  /** Link an existing v6 session to its parallel v1 session. */
  linkParallelV1(sessionId: string, v1SessionId: string): void {
    const session = this.requireSession(sessionId);
    session.v1SessionId = v1SessionId;
    session.runsParallelV1 = true;
    session.updatedAt = this.now();
  }

  /** Unlink the parallel v1 session (the v2 session keeps running). */
  unlinkParallelV1(sessionId: string): void {
    const session = this.requireSession(sessionId);
    delete session.v1SessionId;
    session.runsParallelV1 = false;
    session.updatedAt = this.now();
  }

  /** Read one session (a copy), or undefined. */
  getSession(sessionId: string): AcpV6Session | undefined {
    const s = this.sessions.get(sessionId);
    if (!s) return undefined;
    return {
      ...s,
      messages: s.messages.map((m) => ({ ...m, toolCalls: m.toolCalls ? [...m.toolCalls] : undefined })),
      updates: s.updates.map((u) => ({ ...u, payload: { ...u.payload } })),
    };
  }

  /** Throwing variant of `getSession()`. */
  requireSession(sessionId: string): AcpV6Session {
    const s = this.sessions.get(sessionId);
    if (!s) throw new AcpV6SessionError(`Unknown ACP session "${sessionId}".`, 'unknown-session');
    return s;
  }

  /** All sessions, newest first. */
  listSessions(status?: AcpV6SessionStatus): AcpV6Session[] {
    const all = [...this.sessions.values()].sort((a, b) => b.createdAt - a.createdAt);
    return (status ? all.filter((s) => s.status === status) : all).map((s) => this.getSession(s.sessionId) as AcpV6Session);
  }

  /** Sessions running both the v2 draft and v1 in parallel. */
  listParallelSessions(): AcpV6Session[] {
    return this.listSessions().filter((s) => s.runsParallelV1);
  }

  /**
   * Send a prompt turn. Returns the answer AND the user message
   * id — the v2 draft change versus v1, where the caller got no
   * id back. The id is what later file changes, updates and
   * elicitations reference.
   */
  async prompt(sessionId: string, text: string): Promise<AcpV6PromptResult> {
    this.requireMethod('session/prompt');
    const session = this.requireSession(sessionId);
    if (isAcpV6SessionTerminal(session.status)) {
      throw new AcpV6SessionError(`ACP session "${sessionId}" is ${session.status}; start a new session.`, 'session-terminal');
    }
    if (!this.runner) {
      throw new AcpV6SessionError('No agent runner is bound to this ACP v2 engine.', 'no-runner');
    }
    const controller = new AbortController();
    this.controllers.set(sessionId, controller);
    const messageId = this.generateId('acp6-msg');
    const answerMessageId = this.generateId('acp6-msg');
    session.status = 'active';
    session.messages.push({ messageId, role: 'user', text, at: this.now() });
    try {
      const answer = await this.runner(sessionId, text, messageId, controller.signal);
      session.messages.push({
        messageId: answerMessageId,
        role: 'agent',
        text: answer.text,
        at: this.now(),
        toolCalls: answer.toolCalls ? [...answer.toolCalls] : undefined,
        inReplyToMessageId: messageId,
      });
      session.status = 'idle';
      session.updatedAt = this.now();
      return {
        messageId,
        answerMessageId,
        text: answer.text,
        toolCalls: answer.toolCalls ? [...answer.toolCalls] : [],
      };
    } catch (err) {
      if (controller.signal.aborted) {
        session.status = 'cancelled';
        session.updatedAt = this.now();
        throw new AcpV6SessionError(`ACP session "${sessionId}" prompt was cancelled.`, 'cancelled');
      }
      session.status = 'failed';
      session.updatedAt = this.now();
      throw err;
    } finally {
      this.controllers.delete(sessionId);
    }
  }

  /** Find one message by id, across all sessions (or within one session). */
  findMessage(messageId: string, sessionId?: string): { sessionId: string; message: AcpV6Message } | undefined {
    const sessions = sessionId ? [this.sessions.get(sessionId)].filter((s): s is AcpV6Session => s !== undefined) : [...this.sessions.values()];
    for (const session of sessions) {
      const message = session.messages.find((m) => m.messageId === messageId);
      if (message) {
        return { sessionId: session.sessionId, message: { ...message, toolCalls: message.toolCalls ? [...message.toolCalls] : undefined } };
      }
    }
    return undefined;
  }

  /** Throwing variant of `findMessage()`. */
  requireMessage(messageId: string, sessionId?: string): { sessionId: string; message: AcpV6Message } {
    const found = this.findMessage(messageId, sessionId);
    if (!found) throw new AcpV6SessionError(`Unknown ACP message "${messageId}".`, 'unknown-message');
    return found;
  }

  /**
   * Replay a session from a message id: all messages from that
   * id onward (inclusive), in order. Useful for a client that
   * reconnected and missed turns.
   */
  replayFrom(sessionId: string, messageId: string): AcpV6Message[] {
    const session = this.requireSession(sessionId);
    const idx = session.messages.findIndex((m) => m.messageId === messageId);
    if (idx === -1) throw new AcpV6SessionError(`Unknown ACP message "${messageId}" in session "${sessionId}".`, 'unknown-message');
    return session.messages.slice(idx).map((m) => ({ ...m, toolCalls: m.toolCalls ? [...m.toolCalls] : undefined }));
  }

  /** Cancel the running turn of a session (and the session itself). Returns false when nothing was running. */
  cancel(sessionId: string): boolean {
    this.requireMethod('session/cancel');
    const session = this.requireSession(sessionId);
    if (isAcpV6SessionTerminal(session.status)) return false;
    this.controllers.get(sessionId)?.abort();
    session.status = 'cancelled';
    session.updatedAt = this.now();
    return true;
  }

  /** Resume a cancelled session (back to idle) so it can take new prompts. */
  resume(sessionId: string): void {
    const session = this.requireSession(sessionId);
    if (session.status !== 'cancelled') {
      throw new AcpV6SessionError(`Only a cancelled session can resume; "${sessionId}" is ${session.status}.`, 'session-terminal');
    }
    session.status = 'idle';
    session.updatedAt = this.now();
  }

  /** Mark a session completed (the agent finished its work). */
  complete(sessionId: string): void {
    const session = this.requireSession(sessionId);
    if (isAcpV6SessionTerminal(session.status)) return;
    session.status = 'completed';
    session.updatedAt = this.now();
  }

  // ---- Out-of-turn updates (`session/update`) ----

  /** Subscribe to out-of-turn updates. Returns an unsubscribe function. */
  subscribe(subscriberId: string, subscriber: AcpV6UpdateSubscriber): () => void {
    if (this.subscribers.has(subscriberId)) {
      throw new AcpV6SessionError(`Subscriber "${subscriberId}" already exists.`, 'duplicate-subscriber');
    }
    this.subscribers.set(subscriberId, subscriber);
    return () => {
      this.subscribers.delete(subscriberId);
    };
  }

  get subscriberCount(): number {
    return this.subscribers.size;
  }

  private notify(update: AcpV6Update): void {
    for (const subscriber of [...this.subscribers.values()]) {
      try {
        subscriber({ ...update, payload: { ...update.payload } });
      } catch {
        // One failing subscriber must not break delivery to the rest.
      }
    }
  }

  /**
   * Send an out-of-turn update for a session — no prompt turn
   * needed. The update is recorded `pending`, delivered to all
   * subscribers, and marked `delivered`.
   */
  sendUpdate(
    sessionId: string,
    kind: AcpV6UpdateKind,
    payload: Record<string, unknown>,
    inReplyToMessageId?: string,
  ): AcpV6Update {
    this.requireMethod('session/update');
    const session = this.requireSession(sessionId);
    if (isAcpV6SessionTerminal(session.status)) {
      throw new AcpV6SessionError(`ACP session "${sessionId}" is ${session.status}; updates need a live session.`, 'session-terminal');
    }
    if (!ACP_V6_UPDATE_KINDS.includes(kind)) {
      throw new AcpV6SessionError(`Unknown ACP update kind "${kind}".`, 'method-not-advertised');
    }
    if (inReplyToMessageId !== undefined && !session.messages.some((m) => m.messageId === inReplyToMessageId)) {
      throw new AcpV6SessionError(`Unknown ACP message "${inReplyToMessageId}" in session "${sessionId}".`, 'unknown-message');
    }
    const update: AcpV6Update = {
      updateId: this.generateId('acp6-update'),
      sessionId,
      kind,
      inReplyToMessageId,
      payload: { ...payload },
      createdAt: this.now(),
      delivery: 'pending',
    };
    session.updates.push(update);
    session.updatedAt = this.now();
    this.notify(update);
    update.delivery = 'delivered';
    update.deliveredAt = this.now();
    return { ...update, payload: { ...update.payload } };
  }

  /** Mark an update acknowledged by the client. Returns false when unknown / already acknowledged. */
  acknowledgeUpdate(sessionId: string, updateId: string): boolean {
    const session = this.requireSession(sessionId);
    const update = session.updates.find((u) => u.updateId === updateId);
    if (!update || update.delivery === 'acknowledged') return false;
    update.delivery = 'acknowledged';
    update.acknowledgedAt = this.now();
    return true;
  }

  /** Pending (not yet delivered) updates for a session — the replay backlog. */
  pendingUpdates(sessionId: string): AcpV6Update[] {
    const session = this.requireSession(sessionId);
    return session.updates
      .filter((u) => u.delivery === 'pending')
      .map((u) => ({ ...u, payload: { ...u.payload } }));
  }

  /** Updates of one kind for a session, newest first. */
  updatesByKind(sessionId: string, kind: AcpV6UpdateKind): AcpV6Update[] {
    const session = this.requireSession(sessionId);
    return session.updates
      .filter((u) => u.kind === kind)
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((u) => ({ ...u, payload: { ...u.payload } }));
  }

  /** Updates that belong to one user message (by its id). */
  updatesForMessage(sessionId: string, messageId: string): AcpV6Update[] {
    const session = this.requireSession(sessionId);
    return session.updates
      .filter((u) => u.inReplyToMessageId === messageId)
      .map((u) => ({ ...u, payload: { ...u.payload } }));
  }

  /** Summary counts for the UI. */
  summary(): { sessions: number; parallelV1: number; messages: number; updates: number; pendingUpdates: number } {
    let messages = 0;
    let updates = 0;
    let pending = 0;
    let parallelV1 = 0;
    for (const session of this.sessions.values()) {
      messages += session.messages.length;
      updates += session.updates.length;
      pending += session.updates.filter((u) => u.delivery === 'pending').length;
      if (session.runsParallelV1) parallelV1 += 1;
    }
    return { sessions: this.sessions.size, parallelV1, messages, updates, pendingUpdates: pending };
  }
}

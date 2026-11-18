/**
 * Protocols v2 — A2A v1.0 client + server nội bộ, wave v1.17 (Team T2).
 *
 * Idea only, learned from the public A2A v1.0 / v1.1 RC descriptions
 * in docs/repo-survey-v117.md section 3: Agent Card discovery,
 * delegate task, artifact output, two-way streaming while a task
 * runs. No code, text or asset from any other repo is copied here.
 *
 * This builds on the existing A2A layers without touching them:
 *  - `a2a/card.ts` builds/validates the unsigned card;
 *  - `a2a/types.ts` is the shared task/message/artifact vocabulary;
 *  - `a2a/taskStream.ts` is the sequenced per-task event log
 *    (v1.09, v1.1-style replay/checkpoint);
 *  - `protocolsV2/a2aCardV2.ts` signs cards (HMAC/Ed25519).
 * v117 adds the missing product layer on top of those pieces:
 * a card store + discovery over the well-known paths, a real
 * in-process client/server pair joined by a transport interface
 * (so the same client code works against a loopback server in
 * tests and a remote JSON-RPC server in production), an artifact
 * store with chunked append, and two-way streaming sessions in
 * which the client can still send input / cancel / acks while
 * the task is running (the v1.1 RC direction).
 *
 * Nothing here touches the network: the transport is injected.
 * The loopback transport is `A2aV117Server.asTransport()`.
 */

import { buildAgentCard, validateAgentCard, A2A_WELL_KNOWN_CARD_PATHS, type AgentCardInput } from '../a2a/card';
import {
  A2A_TERMINAL_STATES,
  isA2aTerminalState,
  makeTextMessage,
  partsToText,
  type A2aAgentCard,
  type A2aArtifact,
  type A2aMessage,
  type A2aPart,
  type A2aTask,
  type A2aTaskState,
} from '../a2a/types';
import { TaskStreamLog, type A2aTaskStreamEvent } from '../a2a/taskStream';

/** A2A v1.0 version this layer speaks. */
export const A2A_V117_VERSION = '1.0';
/** Two-way streaming shape prepared for v1.1 RC. */
export const A2A_V117_TWO_WAY_VERSION = '1.1-rc';

/** Error raised by the v117 A2A layer. */
export class A2aV117Error extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'A2aV117Error';
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Agent Card discovery + store
// ---------------------------------------------------------------------------

/** Where a card came from (well-known path that answered). */
export type A2aV117CardSource = 'well-known' | 'well-known-alias' | 'direct' | 'store';

/** A discovered card plus how it was found. */
export interface A2aV117DiscoveredCard {
  card: A2aAgentCard;
  /** The URL that actually served the card. */
  fetchedFrom: string;
  source: A2aV117CardSource;
  /** True when the card carries no signature (see a2a/signing.ts). */
  unsigned: boolean;
  /** Protocol version the card declares (default '1.0'). */
  protocolVersion: string;
}

/** JSON fetcher injected by the caller (fetch, loopback, test fake). */
export type A2aV117JsonFetcher = (url: string) => Promise<unknown>;

/**
 * Discover an Agent Card at a base URL: try each well-known path
 * in order (`/.well-known/agent-card.json` first, then the
 * `agent.json` alias), validate what comes back, and return the
 * first valid card. A fetcher failure on one path is not fatal —
 * the next path is tried; when every path fails the last error
 * is reported. Cards served from a non-well-known URL can be
 * fetched with `fetchAgentCardDirect` instead.
 */
export async function discoverAgentCard(
  baseUrl: string,
  fetchJson: A2aV117JsonFetcher,
): Promise<A2aV117DiscoveredCard> {
  const base = baseUrl.replace(/\/+$/, '');
  let lastError: unknown = null;
  for (const cardPath of A2A_WELL_KNOWN_CARD_PATHS) {
    const url = `${base}${cardPath}`;
    try {
      const raw = await fetchJson(url);
      const problems = validateAgentCard(raw);
      if (problems.length > 0) {
        throw new A2aV117Error('INVALID_CARD', `Card at ${url} is invalid: ${problems.join('; ')}`);
      }
      const card = raw as A2aAgentCard;
      return {
        card,
        fetchedFrom: url,
        source: cardPath.endsWith('agent.json') ? 'well-known-alias' : 'well-known',
        unsigned: !card.signature,
        protocolVersion: card.protocolVersion ?? A2A_V117_VERSION,
      };
    } catch (err) {
      lastError = err;
    }
  }
  throw new A2aV117Error(
    'CARD_NOT_FOUND',
    `No valid Agent Card at ${base} (${A2A_WELL_KNOWN_CARD_PATHS.join(', ')}): ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
  );
}

/** Fetch + validate a card from one exact URL (no well-known walk). */
export async function fetchAgentCardDirect(
  url: string,
  fetchJson: A2aV117JsonFetcher,
): Promise<A2aV117DiscoveredCard> {
  const raw = await fetchJson(url);
  const problems = validateAgentCard(raw);
  if (problems.length > 0) {
    throw new A2aV117Error('INVALID_CARD', `Card at ${url} is invalid: ${problems.join('; ')}`);
  }
  const card = raw as A2aAgentCard;
  return {
    card,
    fetchedFrom: url,
    source: 'direct',
    unsigned: !card.signature,
    protocolVersion: card.protocolVersion ?? A2A_V117_VERSION,
  };
}

/**
 * In-memory Agent Card store: the client side of discovery.
 * `writeCard` builds (via `a2a/card.ts`) + validates + stores;
 * `storeCard` validates + stores a card received from elsewhere
 * (discovery, a signed card from `a2aCardV2.ts`); `readCard`
 * returns the stored card for an agent URL, if any.
 */
export class AgentCardStore {
  private readonly cards = new Map<string, A2aAgentCard>();

  /** Build, validate and store a card from its pieces. */
  writeCard(input: AgentCardInput): A2aAgentCard {
    const card = buildAgentCard(input);
    return this.storeCard(card);
  }

  /** Validate and store a card (e.g. one found by discovery). */
  storeCard(card: A2aAgentCard): A2aAgentCard {
    const problems = validateAgentCard(card);
    if (problems.length > 0) {
      throw new A2aV117Error('INVALID_CARD', `Cannot store card: ${problems.join('; ')}`);
    }
    this.cards.set(card.url, { ...card, skills: card.skills ? [...card.skills] : [] });
    return card;
  }

  /** Read a stored card by agent URL. */
  readCard(url: string): A2aAgentCard | undefined {
    const card = this.cards.get(url);
    return card ? { ...card, skills: card.skills ? [...card.skills] : [] } : undefined;
  }

  /** Remove a stored card. Returns true when one was stored. */
  removeCard(url: string): boolean {
    return this.cards.delete(url);
  }

  /**
   * Store a card only after an injected signature check passes.
   * The check is injected (e.g. `verifyA2aV2AgentCard` from
   * `protocolsV2/a2aCardV2.ts`) so this store never depends on
   * one signature scheme. `requireSignature` refuses unsigned
   * cards outright; otherwise an unsigned card is stored with
   * the caller warned by the returned `unsigned` flag.
   */
  storeVerifiedCard(
    card: A2aAgentCard,
    verifySignature: (card: A2aAgentCard) => boolean,
    options: { requireSignature?: boolean } = {},
  ): { card: A2aAgentCard; unsigned: boolean } {
    const problems = validateAgentCard(card);
    if (problems.length > 0) {
      throw new A2aV117Error('INVALID_CARD', `Cannot store card: ${problems.join('; ')}`);
    }
    const unsigned = !card.signature;
    if (unsigned && options.requireSignature) {
      throw new A2aV117Error('CARD_UNSIGNED', `Card for ${card.url} carries no signature`);
    }
    if (!unsigned && !verifySignature(card)) {
      throw new A2aV117Error('CARD_SIGNATURE_INVALID', `Signature check failed for card ${card.url}`);
    }
    this.storeCard(card);
    return { card, unsigned };
  }

  /** All stored cards, sorted by URL. */
  listCards(): A2aAgentCard[] {
    return [...this.cards.values()]
      .sort((a, b) => a.url.localeCompare(b.url))
      .map((c) => ({ ...c, skills: c.skills ? [...c.skills] : [] }));
  }

  /** Number of stored cards. */
  size(): number {
    return this.cards.size;
  }

  /**
   * Discover a card at a base URL and store it (keyed by the
   * card's own `url`, so a card that redirects to another
   * endpoint is still found under its real URL).
   */
  async discoverAndStore(baseUrl: string, fetchJson: A2aV117JsonFetcher): Promise<A2aV117DiscoveredCard> {
    const found = await discoverAgentCard(baseUrl, fetchJson);
    this.storeCard(found.card);
    return found;
  }
}

// ---------------------------------------------------------------------------
// Artifact store (task output)
// ---------------------------------------------------------------------------

/** Input for creating one artifact. */
export interface A2aV117ArtifactInput {
  name?: string;
  description?: string;
  parts: A2aPart[];
  metadata?: Record<string, unknown>;
}

/**
 * Artifact store for one server: artifacts live under their task,
 * are created complete or built up chunk by chunk
 * (`appendArtifactText` — the server side of the v1.09 chunked
 * artifact-update stream), and are read back whole or as text.
 * Artifact ids are unique per task.
 */
export class ArtifactStore {
  private readonly byTask = new Map<string, Map<string, A2aArtifact>>();
  private counter = 0;

  /** Create an artifact under a task. */
  createArtifact(taskId: string, input: A2aV117ArtifactInput): A2aArtifact {
    if (!taskId) throw new A2aV117Error('INVALID_TASK', 'createArtifact needs a task id');
    if (!Array.isArray(input.parts) || input.parts.length === 0) {
      throw new A2aV117Error('INVALID_ARTIFACT', 'Artifact needs at least one part');
    }
    this.counter += 1;
    const artifact: A2aArtifact = {
      artifactId: `artifact-${this.counter}`,
      ...(input.name ? { name: input.name } : {}),
      ...(input.description ? { description: input.description } : {}),
      parts: input.parts.map((p) => ({ ...p })),
      ...(input.metadata ? { metadata: { ...input.metadata } } : {}),
    };
    let taskArtifacts = this.byTask.get(taskId);
    if (!taskArtifacts) {
      taskArtifacts = new Map();
      this.byTask.set(taskId, taskArtifacts);
    }
    taskArtifacts.set(artifact.artifactId, artifact);
    return structuredCloneSafe(artifact);
  }

  /**
   * Append text to an artifact's first text part (creating one
   * when the artifact has none). Returns the updated artifact.
   * This is how a streaming runner builds a large artifact
   * without holding the whole text in one event.
   */
  appendArtifactText(taskId: string, artifactId: string, chunk: string): A2aArtifact {
    const artifact = this.require(taskId, artifactId);
    const textPart = artifact.parts.find((p) => p.kind === 'text');
    if (textPart && textPart.kind === 'text') {
      textPart.text += chunk;
    } else {
      artifact.parts.push({ kind: 'text', text: chunk });
    }
    return structuredCloneSafe(artifact);
  }

  /** Read one artifact. */
  getArtifact(taskId: string, artifactId: string): A2aArtifact {
    return structuredCloneSafe(this.require(taskId, artifactId));
  }

  /** All artifacts of a task, in creation order. */
  listArtifacts(taskId: string): A2aArtifact[] {
    const taskArtifacts = this.byTask.get(taskId);
    if (!taskArtifacts) return [];
    return [...taskArtifacts.values()].map((a) => structuredCloneSafe(a));
  }

  /** Text of an artifact (text parts joined, data parts as JSON). */
  readArtifactText(taskId: string, artifactId: string): string {
    return partsToText(this.require(taskId, artifactId).parts);
  }

  /** Remove all artifacts of a task. Returns how many were removed. */
  dropTask(taskId: string): number {
    const taskArtifacts = this.byTask.get(taskId);
    const count = taskArtifacts ? taskArtifacts.size : 0;
    this.byTask.delete(taskId);
    return count;
  }

  private require(taskId: string, artifactId: string): A2aArtifact {
    const artifact = this.byTask.get(taskId)?.get(artifactId);
    if (!artifact) {
      throw new A2aV117Error('ARTIFACT_NOT_FOUND', `No artifact ${artifactId} on task ${taskId}`);
    }
    return artifact;
  }
}

function structuredCloneSafe<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

// ---------------------------------------------------------------------------
// Two-way streaming session (v1.1 RC direction)
// ---------------------------------------------------------------------------

/** Events the client may send upstream while a task runs. */
export type A2aV117UpstreamEvent =
  | { type: 'input'; message: A2aMessage }
  | { type: 'cancel'; reason?: string }
  | { type: 'ack'; sequence: number }
  | { type: 'ping'; atMs?: number };

/** Events the server emits downstream (the sequenced task log). */
export type A2aV117DownstreamEvent = A2aTaskStreamEvent;

/** Status of a two-way session. */
export type A2aV117SessionStatus = 'open' | 'input-required' | 'closed';

/**
 * One two-way streaming session for a task.
 *
 * The v1.0 direction is server → client only (status/artifact
 * updates). v1.1 RC adds the reverse direction while the task is
 * still running: the client can send follow-up input (which the
 * runner sees as a new message), cancel the task, ack received
 * sequences (so the server knows what arrived), and ping. The
 * server side of the session is this class; the client side
 * drives it through the transport's `streamTask` handle.
 *
 * Lifecycle: `open` → (`input-required` while waiting on the
 * client) → `closed` once the task reaches a terminal state.
 * Sending upstream input to a closed session is refused; a
 * cancel upstream event closes the session and fails the task
 * with `cancelled`.
 */
export class TwoWayTaskSession {
  readonly taskId: string;
  private readonly log: TaskStreamLog;
  private readonly listeners = new Set<(event: A2aTaskStreamEvent) => void>();
  private readonly upstreamLog: A2aV117UpstreamEvent[] = [];
  private status: A2aV117SessionStatus = 'open';
  private lastAckedSequence = -1;
  private task: A2aTask;

  constructor(task: A2aTask, options: { tenantId?: string } = {}) {
    this.task = { ...task };
    this.taskId = task.id;
    this.log = new TaskStreamLog(task.id, options.tenantId ?? task.tenantId);
  }

  /** Current session status. */
  getStatus(): A2aV117SessionStatus {
    return this.status;
  }

  /** Current task snapshot (state + artifacts so far). */
  getTask(): A2aTask {
    return structuredCloneSafe(this.task);
  }

  /** Highest sequence the client has acked. */
  lastAcked(): number {
    return this.lastAckedSequence;
  }

  /** Upstream events received so far (oldest first). */
  upstreamEvents(): A2aV117UpstreamEvent[] {
    return [...this.upstreamLog];
  }

  /** Subscribe to downstream events. Returns an unsubscribe fn. */
  onEvent(listener: (event: A2aTaskStreamEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Server side: append a downstream event and fan it out. */
  emitDownstream(event: Omit<A2aTaskStreamEvent, 'taskId' | 'sequence' | 'timestamp'>): A2aTaskStreamEvent {
    let appended: A2aTaskStreamEvent;
    if (event.kind === 'status-update' && event.state) {
      appended = this.log.appendStatus(event.state, event.text);
    } else if (event.kind === 'artifact-complete' && event.artifact) {
      appended = this.log.appendArtifactComplete(event.artifact);
    } else if (event.kind === 'artifact-update' && event.artifact) {
      appended = this.log.appendArtifactChunk(event.artifact, event.isLastChunk ?? false);
    } else if (event.kind === 'message-append') {
      appended = this.log.appendMessage(event.messageText ?? '');
    } else if (event.kind === 'checkpoint') {
      appended = this.log.appendStatus(this.log.state, event.text);
    } else {
      appended = this.log.appendStatus(this.log.state, event.text);
    }
    if (event.kind === 'status-update' && event.state) {
      this.task = { ...this.task, status: { ...this.task.status, state: event.state } };
      if (isA2aTerminalState(event.state)) this.status = 'closed';
    }
    if (event.kind === 'artifact-complete' && event.artifact) {
      const artifacts = [...(this.task.artifacts ?? [])];
      const idx = artifacts.findIndex((a) => a.artifactId === event.artifact!.artifactId);
      if (idx >= 0) artifacts[idx] = event.artifact;
      else artifacts.push(event.artifact);
      this.task = { ...this.task, artifacts };
    }
    for (const listener of this.listeners) listener(appended);
    return appended;
  }

  /** Server side: replay downstream events from a sequence (inclusive). */
  replayFrom(sequence: number): A2aTaskStreamEvent[] {
    return this.log.replayFrom(sequence).events;
  }

  /** Server side: latest checkpoint snapshot, if one exists. */
  checkpoint(): ReturnType<TaskStreamLog['makeCheckpoint']> | null {
    return this.log.latestCheckpoint;
  }

  /** Server side: true when the requested sequence was already cut from the buffer. */
  replayTruncated(sequence: number): boolean {
    return this.log.replayFrom(sequence).truncated;
  }

  /**
   * Client side (via transport): send an upstream event into a
   * running session. `input` appends the message to the task
   * history and moves the session to `input-required` until the
   * runner consumes it; `cancel` closes the session; `ack`
   * records delivery; `ping` is a no-op liveness check.
   */
  sendUpstream(event: A2aV117UpstreamEvent): { accepted: boolean; sessionStatus: A2aV117SessionStatus } {
    if (this.status === 'closed' && event.type !== 'ack' && event.type !== 'ping') {
      throw new A2aV117Error('SESSION_CLOSED', `Task ${this.taskId} is finished; cannot send ${event.type}`);
    }
    this.upstreamLog.push(event);
    if (event.type === 'ack') {
      if (Number.isInteger(event.sequence) && event.sequence > this.lastAckedSequence) {
        this.lastAckedSequence = event.sequence;
      }
      return { accepted: true, sessionStatus: this.status };
    }
    if (event.type === 'ping') return { accepted: true, sessionStatus: this.status };
    if (event.type === 'cancel') {
      this.status = 'closed';
      this.task = { ...this.task, status: { ...this.task.status, state: 'cancelled' } };
      this.emitDownstream({ kind: 'status-update', state: 'cancelled', text: event.reason ?? 'cancelled by client' });
      return { accepted: true, sessionStatus: this.status };
    }
    // input
    const history = [...(this.task.history ?? []), event.message];
    this.task = { ...this.task, history };
    this.status = 'input-required';
    this.emitDownstream({ kind: 'message-append', messageText: partsToText(event.message.parts) });
    return { accepted: true, sessionStatus: this.status };
  }

  /** Runner consumed the pending input — back to `open`. */
  consumeInput(): A2aMessage[] {
    const inputs = this.upstreamLog
      .filter((e): e is { type: 'input'; message: A2aMessage } => e.type === 'input')
      .map((e) => e.message);
    if (this.status === 'input-required') this.status = 'open';
    return inputs;
  }

  /** Close the session with a terminal task state. */
  close(state: A2aTaskState, text?: string): void {
    if (!isA2aTerminalState(state)) {
      throw new A2aV117Error('INVALID_STATE', `close() needs a terminal state, got ${state}`);
    }
    this.emitDownstream({ kind: 'status-update', state, ...(text ? { text } : {}) });
    this.status = 'closed';
  }
}

// ---------------------------------------------------------------------------
// Transport + in-process server + client
// ---------------------------------------------------------------------------

/** Handle for a live two-way stream (client side). */
export interface A2aV117StreamHandle {
  session: TwoWayTaskSession;
  /** Send an upstream event into the running task. */
  sendUpstream: (event: A2aV117UpstreamEvent) => { accepted: boolean; sessionStatus: A2aV117SessionStatus };
  /** Close the stream (does not cancel the task). */
  close: () => void;
}

/**
 * Transport the v117 client drives. A remote JSON-RPC/SSE
 * implementation fills this in; `A2aV117Server.asTransport()`
 * is the in-process implementation used by tests and by the
 * loopback agent.
 */
export interface A2aV117Transport {
  fetchCard: (url: string) => Promise<A2aAgentCard>;
  sendTask: (card: A2aAgentCard, message: A2aMessage, options?: { contextId?: string }) => Promise<A2aTask>;
  getTask: (card: A2aAgentCard, taskId: string) => Promise<A2aTask>;
  cancelTask: (card: A2aAgentCard, taskId: string, reason?: string) => Promise<A2aTask>;
  streamTask: (card: A2aAgentCard, taskId: string, onEvent: (event: A2aTaskStreamEvent) => void) => A2aV117StreamHandle;
}

/** Runner the server calls to do the delegated work. */
export type A2aV117ServerRunner = (input: {
  task: A2aTask;
  text: string;
  message: A2aMessage;
  signal: AbortSignal;
  session: TwoWayTaskSession;
  artifacts: ArtifactStore;
}) => Promise<{ text?: string; artifacts?: A2aArtifact[]; needsInput?: string; error?: string }>;

/**
 * In-process A2A v1.0 server: owns tasks, runs the injected
 * runner, stores artifacts, and exposes two-way sessions. One
 * server instance serves one agent (one card); the client
 * discovers the card first and then delegates through the
 * transport this server exposes.
 */
export class A2aV117Server {
  readonly card: A2aAgentCard;
  private readonly tasks = new Map<string, A2aTask>();
  private readonly sessions = new Map<string, TwoWayTaskSession>();
  private readonly artifacts = new ArtifactStore();
  private readonly runner: A2aV117ServerRunner;
  private readonly aborters = new Map<string, AbortController>();
  private counter = 0;

  constructor(card: A2aAgentCard, runner: A2aV117ServerRunner) {
    const problems = validateAgentCard(card);
    if (problems.length > 0) throw new A2aV117Error('INVALID_CARD', `Server card invalid: ${problems.join('; ')}`);
    this.card = card;
    this.runner = runner;
  }

  /** Artifact store (read artifacts a task produced). */
  artifactStore(): ArtifactStore {
    return this.artifacts;
  }

  /** All tasks this server has seen. */
  listTasks(): A2aTask[] {
    return [...this.tasks.values()].map((t) => structuredCloneSafe(t));
  }

  /** The transport a client uses to talk to this server. */
  asTransport(): A2aV117Transport {
    return {
      fetchCard: async () => structuredCloneSafe(this.card),
      sendTask: (card, message, options) => this.sendTask(card, message, options),
      getTask: (card, taskId) => this.getTask(taskId),
      cancelTask: (card, taskId, reason) => this.cancelTask(taskId, reason),
      streamTask: (card, taskId, onEvent) => this.streamTask(taskId, onEvent),
    };
  }

  /** Handle `message:send` — create the task and run it. */
  async sendTask(
    card: A2aAgentCard,
    message: A2aMessage,
    options: { contextId?: string } = {},
  ): Promise<A2aTask> {
    if (card.url !== this.card.url) {
      throw new A2aV117Error('WRONG_AGENT', `This server is ${this.card.url}, not ${card.url}`);
    }
    const text = partsToText(message.parts);
    if (!text.trim()) throw new A2aV117Error('EMPTY_MESSAGE', 'Delegated message has no text');
    this.counter += 1;
    const taskId = `task-v117-${this.counter}`;
    const contextId = options.contextId ?? `ctx-v117-${this.counter}`;
    const now = new Date().toISOString();
    const task: A2aTask = {
      id: taskId,
      contextId,
      status: { state: 'submitted', timestamp: now },
      history: [message],
      createdAt: now,
      updatedAt: now,
    };
    this.tasks.set(taskId, task);
    const session = new TwoWayTaskSession(task);
    this.sessions.set(taskId, session);
    const aborter = new AbortController();
    this.aborters.set(taskId, aborter);
    // Snapshot the submitted task BEFORE the runner starts: the
    // caller gets `submitted`, and follows progress via getTask /
    // streamTask (the runner moves it to `working` immediately).
    const submitted = structuredCloneSafe(task);
    void this.runTask(taskId, message, text, session, aborter.signal);
    return submitted;
  }

  private async runTask(
    taskId: string,
    message: A2aMessage,
    text: string,
    session: TwoWayTaskSession,
    signal: AbortSignal,
  ): Promise<void> {
    const task = this.tasks.get(taskId);
    if (!task) return;
    const stamp = (state: A2aTaskState): void => {
      const current = this.tasks.get(taskId);
      if (!current) return;
      current.status = { ...current.status, state };
      current.updatedAt = new Date().toISOString();
      this.tasks.set(taskId, current);
    };
    stamp('working');
    session.emitDownstream({ kind: 'status-update', state: 'working' });
    try {
      const result = await this.runner({
        task: structuredCloneSafe(task),
        text,
        message,
        signal,
        session,
        artifacts: this.artifacts,
      });
      if (signal.aborted) {
        stamp('cancelled');
        session.close('cancelled', 'cancelled by client');
        return;
      }
      if (result.error) {
        stamp('failed');
        session.close('failed', result.error);
        return;
      }
      if (result.needsInput) {
        stamp('input-required');
        session.emitDownstream({
          kind: 'status-update',
          state: 'input-required',
          text: result.needsInput,
        });
        return;
      }
      const artifacts: A2aArtifact[] = [];
      if (result.text !== undefined) {
        artifacts.push(
          this.artifacts.createArtifact(taskId, {
            name: 'result',
            parts: [{ kind: 'text', text: result.text }],
          }),
        );
      }
      for (const extra of result.artifacts ?? []) {
        artifacts.push(this.artifacts.createArtifact(taskId, { name: extra.name, description: extra.description, parts: extra.parts }));
      }
      for (const artifact of artifacts) {
        session.emitDownstream({ kind: 'artifact-complete', artifact });
      }
      const current = this.tasks.get(taskId);
      if (current) {
        current.artifacts = this.artifacts.listArtifacts(taskId);
        this.tasks.set(taskId, current);
      }
      stamp('completed');
      session.close('completed');
    } catch (err) {
      const messageText = err instanceof Error ? err.message : String(err);
      stamp(signal.aborted ? 'cancelled' : 'failed');
      session.close(signal.aborted ? 'cancelled' : 'failed', messageText);
    } finally {
      this.aborters.delete(taskId);
    }
  }

  /** Handle `tasks/get`. */
  async getTask(taskId: string): Promise<A2aTask> {
    const task = this.tasks.get(taskId);
    if (!task) throw new A2aV117Error('TASK_NOT_FOUND', `No task ${taskId} on ${this.card.url}`);
    const stored = this.artifacts.listArtifacts(taskId);
    return structuredCloneSafe({ ...task, artifacts: stored.length > 0 ? stored : task.artifacts });
  }

  /** Handle `tasks/cancel`. */
  async cancelTask(taskId: string, reason?: string): Promise<A2aTask> {
    const task = this.tasks.get(taskId);
    if (!task) throw new A2aV117Error('TASK_NOT_FOUND', `No task ${taskId} on ${this.card.url}`);
    if (isA2aTerminalState(task.status.state)) return structuredCloneSafe(task);
    this.aborters.get(taskId)?.abort();
    const session = this.sessions.get(taskId);
    session?.sendUpstream({ type: 'cancel', reason });
    task.status = { ...task.status, state: 'cancelled' };
    task.updatedAt = new Date().toISOString();
    this.tasks.set(taskId, task);
    return structuredCloneSafe(task);
  }

  /** Open a two-way stream on a task (replays missed events). */
  streamTask(taskId: string, onEvent: (event: A2aTaskStreamEvent) => void): A2aV117StreamHandle {
    const session = this.sessions.get(taskId);
    if (!session) throw new A2aV117Error('TASK_NOT_FOUND', `No task ${taskId} on ${this.card.url}`);
    const unsubscribe = session.onEvent(onEvent);
    // Replay what already happened: a client that subscribes
    // just after delegating must still see the `working`
    // status and early artifacts, not only later events.
    for (const event of session.replayFrom(0)) onEvent(event);
    return {
      session,
      sendUpstream: (event) => session.sendUpstream(event),
      close: () => unsubscribe(),
    };
  }

  /** The two-way session for a task, if one exists. */
  sessionFor(taskId: string): TwoWayTaskSession | undefined {
    return this.sessions.get(taskId);
  }

  /**
   * Replay a task's stream from a sequence (inclusive). Returns
   * the events plus `truncated=true` when the sequence was
   * already cut from the buffer — then the caller should fetch
   * the full task with `getTask` instead of trusting the replay.
   */
  replayTask(taskId: string, fromSequence: number): { events: A2aTaskStreamEvent[]; truncated: boolean } {
    const session = this.sessions.get(taskId);
    if (!session) throw new A2aV117Error('TASK_NOT_FOUND', `No task ${taskId} on ${this.card.url}`);
    return { events: session.replayFrom(fromSequence), truncated: session.replayTruncated(fromSequence) };
  }
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

/** Options for `delegateAndWait`. */
export interface A2aV117WaitOptions {
  /** Poll interval in ms (default 25). */
  pollMs?: number;
  /** Give up after this many ms (default 10_000). */
  timeoutMs?: number;
}

/**
 * A2A v1.0 client: discovers cards (via a store + fetcher),
 * delegates tasks to another agent, reads artifacts back, and
 * opens two-way streams on running tasks.
 */
export class A2aV117Client {
  private readonly transport: A2aV117Transport;
  readonly cards: AgentCardStore;

  constructor(transport: A2aV117Transport, cards?: AgentCardStore) {
    this.transport = transport;
    this.cards = cards ?? new AgentCardStore();
  }

  /** Discover + store the card for an agent base URL. */
  async discover(baseUrl: string, fetchJson: A2aV117JsonFetcher): Promise<A2aV117DiscoveredCard> {
    return this.cards.discoverAndStore(baseUrl, fetchJson);
  }

  /** Fetch a card from its exact URL (no well-known walk). */
  async fetchCard(url: string): Promise<A2aAgentCard> {
    return this.transport.fetchCard(url);
  }

  /**
   * Delegate one message to an agent: the card must be known
   * (discovered/stored first) or passed explicitly. Returns the
   * submitted task; follow it with `getTask` / `waitFor` /
   * `streamTask`.
   */
  async delegate(
    cardOrUrl: A2aAgentCard | string,
    text: string,
    options: { contextId?: string } = {},
  ): Promise<A2aTask> {
    const card = typeof cardOrUrl === 'string' ? this.requireCard(cardOrUrl) : cardOrUrl;
    if (!text.trim()) throw new A2aV117Error('EMPTY_MESSAGE', 'Cannot delegate an empty message');
    const message = makeTextMessage('user', text);
    return this.transport.sendTask(card, message, options);
  }

  /** Delegate and poll until the task reaches a terminal state. */
  async delegateAndWait(
    cardOrUrl: A2aAgentCard | string,
    text: string,
    options: A2aV117WaitOptions & { contextId?: string } = {},
  ): Promise<A2aTask> {
    const card = typeof cardOrUrl === 'string' ? this.requireCard(cardOrUrl) : cardOrUrl;
    const task = await this.delegate(card, text, options);
    const pollMs = options.pollMs ?? 25;
    const timeoutMs = options.timeoutMs ?? 10_000;
    const started = Date.now();
    for (;;) {
      const current = await this.transport.getTask(card, task.id);
      if (isA2aTerminalState(current.status.state)) return current;
      if (Date.now() - started > timeoutMs) {
        throw new A2aV117Error('WAIT_TIMEOUT', `Task ${task.id} did not finish within ${timeoutMs}ms`);
      }
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  }

  /** Read one task back from the agent. */
  async getTask(card: A2aAgentCard, taskId: string): Promise<A2aTask> {
    return this.transport.getTask(card, taskId);
  }

  /** Cancel a task on the agent. */
  async cancelTask(card: A2aAgentCard, taskId: string, reason?: string): Promise<A2aTask> {
    return this.transport.cancelTask(card, taskId, reason);
  }

  /** Open a two-way stream on a running task. */
  streamTask(
    card: A2aAgentCard,
    taskId: string,
    onEvent: (event: A2aTaskStreamEvent) => void,
  ): A2aV117StreamHandle {
    return this.transport.streamTask(card, taskId, onEvent);
  }

  /**
   * Delegate and stream the task's downstream events as an async
   * generator: yields each status/artifact/message event in order
   * and finishes once the task reaches a terminal state. The
   * stream handle is closed when the generator ends (or the
   * consumer breaks out — breaking does NOT cancel the task;
   * call `cancelTask` for that).
   */
  async *delegateAndStream(
    cardOrUrl: A2aAgentCard | string,
    text: string,
    options: { contextId?: string; pollMs?: number; timeoutMs?: number } = {},
  ): AsyncGenerator<A2aTaskStreamEvent, A2aTask, void> {
    const card = typeof cardOrUrl === 'string' ? this.requireCard(cardOrUrl) : cardOrUrl;
    const task = await this.delegate(card, text, options);
    const pollMs = options.pollMs ?? 25;
    const timeoutMs = options.timeoutMs ?? 10_000;
    const started = Date.now();
    const queue: A2aTaskStreamEvent[] = [];
    let resolveWait: (() => void) | null = null;
    const wake = (): void => {
      if (resolveWait) {
        const r = resolveWait;
        resolveWait = null;
        r();
      }
    };
    const handle = this.transport.streamTask(card, task.id, (event) => {
      queue.push(event);
      wake();
    });
    try {
      let lastSequence = -1;
      for (;;) {
        while (queue.length > 0) {
          const event = queue.shift()!;
          if (event.sequence > lastSequence) {
            lastSequence = event.sequence;
            yield event;
          }
        }
        const current = await this.transport.getTask(card, task.id);
        if (isA2aTerminalState(current.status.state)) return current;
        if (Date.now() - started > timeoutMs) {
          throw new A2aV117Error('WAIT_TIMEOUT', `Task ${task.id} did not finish within ${timeoutMs}ms`);
        }
        await new Promise<void>((resolve) => {
          resolveWait = resolve;
          setTimeout(() => {
            if (resolveWait === resolve) {
              resolveWait = null;
              resolve();
            }
          }, pollMs);
        });
      }
    } finally {
      handle.close();
    }
  }

  /** Artifacts a finished task produced (read from the task). */
  async artifacts(card: A2aAgentCard, taskId: string): Promise<A2aArtifact[]> {
    const task = await this.transport.getTask(card, taskId);
    return task.artifacts ?? [];
  }

  /** Text of the first text artifact of a task ('' when none). */
  async artifactText(card: A2aAgentCard, taskId: string, artifactId?: string): Promise<string> {
    const artifacts = await this.artifacts(card, taskId);
    const artifact = artifactId
      ? artifacts.find((a) => a.artifactId === artifactId)
      : artifacts[0];
    if (!artifact) return '';
    return partsToText(artifact.parts);
  }

  private requireCard(url: string): A2aAgentCard {
    const card = this.cards.readCard(url);
    if (!card) {
      throw new A2aV117Error('CARD_UNKNOWN', `No stored card for ${url} — discover it first`);
    }
    return card;
  }
}

/** Terminal states, re-exported for callers that only import this module. */
export { A2A_TERMINAL_STATES };

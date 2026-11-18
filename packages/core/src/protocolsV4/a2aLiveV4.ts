/**
 * Protocols v4 — A2A v1.1 RC `SendLiveMessage` live session (v1.20, Team T2).
 *
 * Idea only, learned from the public A2A v1.1 RC description
 * researched for this wave (see docs/protocols-v120.md): the RC
 * tagged 29 Oct 2026 adds `SendLiveMessage` — bidirectional
 * interaction while a task runs — lets clients write artifacts
 * through `SendMessageRequest`, orders task history + artifacts
 * coherently, adds a `generation` field for ordering / long
 * polling / optimistic concurrency, and moves `SubscribeToTask`
 * from POST to GET in the HTTP binding. Stable is still 1.0.1,
 * so live streaming is negotiated as an opt-in capability, never
 * assumed. No code, text or asset from any other repo is copied
 * here.
 *
 * This builds on the v3 two-way channel without touching it:
 *  - `protocolsV3/a2aTwoWayV3.ts` — frame vocabulary, send window,
 *    ack / dedup / resume, loopback transport. v3 already speaks
 *    the frame layer; v4 adds what v1.1 RC adds on top of it:
 *   1. negotiation — a live session only starts when the peer
 *      negotiated A2A `1.1-rc`/`1.1` (see `protocolsV4/versions.ts`)
 *      AND advertises the `liveStreaming` capability;
 *   2. client-written artifacts — the client end may write an
 *      artifact mid-task (upstream `artifact` frame); the agent
 *      end records it and surfaces it through `onClientArtifact`;
 *   3. backpressure — an adaptive session-level gate on top of the
 *      v3 send window: past the high-water mark outbound frames
 *      queue in the session (never dropped) and a single
 *      `onBackpressure` fires until the window drains below the
 *      low-water mark;
 *   4. `generation` + coherent history — every status / message /
 *      artifact entry carries the session generation; a reconnect
 *      bumps the generation, and `history()` returns one timeline
 *      ordered by (generation, sequence) so a client can replay a
 *      task without seeing an artifact before the message that
 *      produced it;
 *   5. resume tokens — `live:<taskId>:<generation>:<sequence>`
 *      tokens for `SubscribeToTask`-style resume (GET binding):
 *      re-joining with a token re-sends only what the peer has
 *      not acked, in the new generation.
 *
 * Frames are the v3 wire format (same JSON shape, same sequence
 * space per direction), so a v4 peer interoperates with a v3
 * peer for the shared kinds; the new `artifact` kind is only
 * sent after live negotiation succeeded. Nothing here touches
 * the network: the transport is injected, in-process in tests.
 */

import {
  A2A_V3_DEFAULT_HEARTBEAT_MS,
  A2A_V3_DEFAULT_WINDOW,
  A2A_V3_MAX_CHUNK_BYTES,
  A2aV3SendWindow,
  validateA2aV3Frame,
  type A2aV3ArtifactChunkPayload,
  type A2aV3ChannelTransport,
  type A2aV3Frame,
} from '../protocolsV3/a2aTwoWayV3';
import {
  A2A_V4_SEND_LIVE_MESSAGE_METHOD,
  negotiateProtocolV4Version,
} from './versions';
import {
  A2A_TERMINAL_STATES,
  isA2aTerminalState,
  type A2aArtifact,
  type A2aMessage,
  type A2aTask,
  type A2aTaskState,
} from '../a2a/types';

/** A2A version this live session speaks. */
export const A2A_V4_LIVE_VERSION = '1.1-rc';
/** JSON-RPC method for `SendLiveMessage` (re-exported for callers). */
export const A2A_V4_LIVE_METHOD = A2A_V4_SEND_LIVE_MESSAGE_METHOD;
/** Default high-water mark: unacked frames at which backpressure starts. */
export const A2A_V4_LIVE_DEFAULT_HIGH_WATER = A2A_V3_DEFAULT_WINDOW;
/** Default low-water mark: unacked frames at which backpressure clears. */
export const A2A_V4_LIVE_DEFAULT_LOW_WATER = 4;
/** Max bytes of one client-written artifact payload (JSON text). */
export const A2A_V4_LIVE_MAX_CLIENT_ARTIFACT_BYTES = 256 * 1024;
/** Max history entries kept per live session. */
export const A2A_V4_LIVE_MAX_HISTORY = 2000;

/** Error raised by the v4 live session. */
export class A2aLiveV4Error extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'A2aLiveV4Error';
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Negotiation
// ---------------------------------------------------------------------------

/** Capabilities an A2A agent card may advertise for live streaming. */
export interface A2aLiveV4CardCapabilities {
  streaming?: boolean;
  liveStreaming?: boolean;
}

/** Result of negotiating a live session with a peer. */
export interface A2aLiveV4Negotiation {
  supported: boolean;
  negotiatedVersion: string | null;
  /** Why live streaming is unavailable (empty when supported). */
  reason: string;
}

/**
 * Negotiate a live session: the peer must speak A2A `1.1-rc` (or
 * final `1.1`) and advertise `liveStreaming`. A peer on stable
 * 1.0/1.0.1 negotiates fine for plain tasks but never gets a live
 * session — the caller falls back to `SendStreamingMessage`.
 */
export function negotiateA2aLiveV4(
  peerVersions: readonly string[] | undefined,
  capabilities: A2aLiveV4CardCapabilities | undefined,
): A2aLiveV4Negotiation {
  const version = negotiateProtocolV4Version('a2a', peerVersions);
  if (!version.negotiated || (version.negotiated !== '1.1-rc' && version.negotiated !== '1.1')) {
    return {
      supported: false,
      negotiatedVersion: version.negotiated,
      reason: `Peer does not speak A2A 1.1 (negotiated: ${version.negotiated ?? 'none'}); live streaming needs 1.1-rc or 1.1.`,
    };
  }
  if (!capabilities?.liveStreaming) {
    return {
      supported: false,
      negotiatedVersion: version.negotiated,
      reason: `Peer speaks A2A ${version.negotiated} but does not advertise liveStreaming; use SendStreamingMessage instead.`,
    };
  }
  return { supported: true, negotiatedVersion: version.negotiated, reason: '' };
}

// ---------------------------------------------------------------------------
// JSON-RPC envelope for `message/sendLive`
// ---------------------------------------------------------------------------

/** Params of a `message/sendLive` request. */
export interface A2aLiveV4SendLiveParams {
  message: A2aMessage;
  taskId?: string;
  contextId?: string;
  /** Resume token from a previous live session (re-join, not restart). */
  resumeToken?: string;
  /** Client-declared generation for optimistic concurrency (see below). */
  generation?: number;
}

/** A JSON-RPC 2.0 `message/sendLive` request. */
export interface A2aLiveV4SendLiveRequest {
  jsonrpc: '2.0';
  id: string | number;
  method: typeof A2A_V4_SEND_LIVE_MESSAGE_METHOD;
  params: A2aLiveV4SendLiveParams;
}

/** Build a `message/sendLive` request envelope (no network I/O). */
export function buildSendLiveRequest(
  id: string | number,
  params: A2aLiveV4SendLiveParams,
): A2aLiveV4SendLiveRequest {
  return { jsonrpc: '2.0', id, method: A2A_V4_SEND_LIVE_MESSAGE_METHOD, params };
}

/** Validate an inbound `message/sendLive` request (unknown fields ignored). */
export function parseSendLiveRequest(
  value: unknown,
): { ok: true; request: A2aLiveV4SendLiveRequest } | { ok: false; reason: string } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, reason: 'SendLive request must be an object' };
  }
  const req = value as Record<string, unknown>;
  if (req['jsonrpc'] !== '2.0') return { ok: false, reason: 'SendLive request jsonrpc must be "2.0"' };
  if (typeof req['id'] !== 'string' && typeof req['id'] !== 'number') {
    return { ok: false, reason: 'SendLive request id must be a string or number' };
  }
  if (req['method'] !== A2A_V4_SEND_LIVE_MESSAGE_METHOD) {
    return { ok: false, reason: `SendLive request method must be "${A2A_V4_SEND_LIVE_MESSAGE_METHOD}"` };
  }
  const params = req['params'];
  if (typeof params !== 'object' || params === null || Array.isArray(params)) {
    return { ok: false, reason: 'SendLive request params must be an object' };
  }
  const message = (params as Record<string, unknown>)['message'];
  if (typeof message !== 'object' || message === null || Array.isArray(message)) {
    return { ok: false, reason: 'SendLive request params.message must be an object' };
  }
  const msg = message as Record<string, unknown>;
  if (typeof msg['messageId'] !== 'string' || msg['messageId'] === '') {
    return { ok: false, reason: 'SendLive message.messageId must be a non-empty string' };
  }
  if (!Array.isArray(msg['parts'])) {
    return { ok: false, reason: 'SendLive message.parts must be an array' };
  }
  const resumeToken = (params as Record<string, unknown>)['resumeToken'];
  if (resumeToken !== undefined && typeof resumeToken !== 'string') {
    return { ok: false, reason: 'SendLive resumeToken must be a string' };
  }
  const generation = (params as Record<string, unknown>)['generation'];
  if (
    generation !== undefined &&
    (typeof generation !== 'number' || !Number.isInteger(generation) || generation < 0)
  ) {
    return { ok: false, reason: 'SendLive generation must be a non-negative integer' };
  }
  return { ok: true, request: value as A2aLiveV4SendLiveRequest };
}

// ---------------------------------------------------------------------------
// Resume tokens
// ---------------------------------------------------------------------------

/** A resume token: `live:<taskId>:<generation>:<lastAckedSequence>`. */
export function makeA2aLiveResumeToken(
  taskId: string,
  generation: number,
  lastAckedSequence: number,
): string {
  return `live:${taskId}:${Math.max(0, Math.floor(generation))}:${Math.max(-1, Math.floor(lastAckedSequence))}`;
}

/** Parse a resume token, or null when malformed. */
export function parseA2aLiveResumeToken(
  token: string,
): { taskId: string; generation: number; lastAckedSequence: number } | null {
  const m = /^live:([^:]+):(\d+):(-?\d+)$/.exec(token.trim());
  if (!m) return null;
  return {
    taskId: m[1]!,
    generation: Number(m[2]),
    lastAckedSequence: Number(m[3]),
  };
}

// ---------------------------------------------------------------------------
// Coherent history (ordered by generation, then sequence)
// ---------------------------------------------------------------------------

/** One entry in a live session's coherent history. */
export interface A2aLiveV4HistoryEntry {
  generation: number;
  sequence: number;
  kind: 'status' | 'message' | 'artifact' | 'clientArtifact' | 'done' | 'error';
  /** Human-readable summary (never a secret). */
  summary: string;
  at: string;
}

/** Ordered task history + artifacts for one live session. */
export class A2aLiveV4History {
  private readonly entries: A2aLiveV4HistoryEntry[] = [];

  /** Append one entry (oldest first internally; see `ordered()`). */
  append(entry: A2aLiveV4HistoryEntry): void {
    this.entries.push(entry);
    if (this.entries.length > A2A_V4_LIVE_MAX_HISTORY) {
      this.entries.splice(0, this.entries.length - A2A_V4_LIVE_MAX_HISTORY);
    }
  }

  /** Entries in coherent order: generation first, then sequence. */
  ordered(): A2aLiveV4HistoryEntry[] {
    return [...this.entries].sort(
      (a, b) => a.generation - b.generation || a.sequence - b.sequence,
    );
  }

  /** Entries of one generation, in sequence order. */
  atGeneration(generation: number): A2aLiveV4HistoryEntry[] {
    return this.ordered().filter((e) => e.generation === generation);
  }

  /** Number of entries kept. */
  size(): number {
    return this.entries.length;
  }
}

// ---------------------------------------------------------------------------
// Live channel (one end: client or agent)
// ---------------------------------------------------------------------------

/** One end of a live session. */
export type A2aLiveV4Role = 'client' | 'agent';

/** Live session status. */
export type A2aLiveV4Status = 'open' | 'backpressured' | 'paused' | 'closed';

/** Events a live session end emits to its owner. */
export interface A2aLiveV4Events {
  onFrame?: (frame: A2aV3Frame) => void;
  onStatus?: (status: A2aTaskState, note?: string) => void;
  onMessage?: (message: A2aMessage, generation: number) => void;
  onArtifactChunk?: (chunk: A2aV3ArtifactChunkPayload) => void;
  onArtifactDone?: (artifactId: string) => void;
  /** The peer wrote an artifact (v1.1 client-written artifacts). */
  onClientArtifact?: (artifact: A2aArtifact, generation: number) => void;
  onDone?: (task: A2aTask) => void;
  onError?: (error: string) => void;
  onInput?: (message: A2aMessage) => void;
  onInterrupt?: (reason: string, instructions?: string) => void;
  onCancel?: () => void;
  /** Fired once when backpressure starts, and once when it clears. */
  onBackpressure?: (backpressured: boolean, unacked: number) => void;
}

/**
 * One end of an A2A v1.1 RC live session.
 *
 * Wire format, send window, acking, dedup and resume are the v3
 * ones (`A2aV3SendWindow`, `validateA2aV3Frame`) — v4 adds the
 * live layer on top: negotiation-gated start (see
 * `negotiateA2aLiveV4`), client-written artifacts, a session-level
 * backpressure gate, per-generation history, and resume tokens.
 * A frame is never dropped: past the high-water mark it waits in
 * the session queue until the peer acks enough frames.
 */
export class A2aLiveV4Channel {
  readonly taskId: string;
  readonly role: A2aLiveV4Role;
  readonly negotiatedVersion: string;
  private readonly transport: A2aV3ChannelTransport;
  private readonly events: A2aLiveV4Events;
  private readonly window: A2aV3SendWindow;
  private readonly highWater: number;
  private readonly lowWater: number;
  private readonly heartbeatMs: number;
  private readonly historyLog = new A2aLiveV4History();
  private status: A2aLiveV4Status = 'open';
  private taskState: A2aTaskState;
  private generation = 0;
  private lastReceivedSequence = -1;
  private readonly seenSequences = new Set<number>();
  private readonly receivedFrames: A2aV3Frame[] = [];
  private readonly artifacts = new Map<string, string[]>();
  private readonly clientArtifacts: A2aArtifact[] = [];
  private backpressured = false;
  private backpressureEvents = 0;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private heartbeatsSent = 0;
  private heartbeatsReceived = 0;
  private unsubscribe: (() => void) | null = null;

  constructor(
    task: A2aTask,
    role: A2aLiveV4Role,
    transport: A2aV3ChannelTransport,
    events: A2aLiveV4Events = {},
    options: {
      negotiatedVersion?: string;
      windowSize?: number;
      highWaterMark?: number;
      lowWaterMark?: number;
      heartbeatMs?: number;
    } = {},
  ) {
    this.taskId = task.id;
    this.role = role;
    this.transport = transport;
    this.events = events;
    this.negotiatedVersion = options.negotiatedVersion ?? A2A_V4_LIVE_VERSION;
    this.window = new A2aV3SendWindow(options.windowSize ?? A2A_V3_DEFAULT_WINDOW);
    this.highWater = options.highWaterMark ?? A2A_V4_LIVE_DEFAULT_HIGH_WATER;
    this.lowWater = options.lowWaterMark ?? A2A_V4_LIVE_DEFAULT_LOW_WATER;
    if (this.lowWater >= this.highWater) {
      throw new A2aLiveV4Error('BAD_WATERMARKS', 'lowWaterMark must be below highWaterMark');
    }
    this.heartbeatMs = options.heartbeatMs ?? A2A_V3_DEFAULT_HEARTBEAT_MS;
    this.taskState = task.status.state;
    this.unsubscribe = transport.onFrame((frame) => this.handleInbound(frame));
    if (this.heartbeatMs > 0) {
      this.heartbeatTimer = setInterval(() => {
        if (this.status === 'open' || this.status === 'backpressured') void this.sendHeartbeat();
      }, this.heartbeatMs);
      if (typeof (this.heartbeatTimer as unknown as { unref?: unknown }).unref === 'function') {
        (this.heartbeatTimer as unknown as { unref: () => void }).unref();
      }
    }
  }

  /** Session status (`backpressured` is still open for inbound frames). */
  getStatus(): A2aLiveV4Status {
    return this.status;
  }

  /** Current task state (from the last status frame). */
  getTaskState(): A2aTaskState {
    return this.taskState;
  }

  /** Current generation (bumps on every reconnect). */
  getGeneration(): number {
    return this.generation;
  }

  /** Highest inbound sequence received. */
  lastReceived(): number {
    return this.lastReceivedSequence;
  }

  /** Coherent history (generation, then sequence). */
  history(): A2aLiveV4History {
    return this.historyLog;
  }

  /** Client-written artifacts received so far. */
  receivedClientArtifacts(): A2aArtifact[] {
    return [...this.clientArtifacts];
  }

  /** Assembled artifact text so far (chunks joined in order). */
  artifactText(artifactId: string): string {
    return (this.artifacts.get(artifactId) ?? []).join('');
  }

  /** Heartbeats sent / received. */
  heartbeatStats(): { sent: number; received: number } {
    return { sent: this.heartbeatsSent, received: this.heartbeatsReceived };
  }

  /** Backpressure state + counters. */
  backpressureStats(): {
    backpressured: boolean;
    unacked: number;
    queued: number;
    highWaterMark: number;
    lowWaterMark: number;
    backpressureEvents: number;
  } {
    return {
      backpressured: this.backpressured,
      unacked: this.window.unackedCount(),
      queued: this.window.queuedCount(),
      highWaterMark: this.highWater,
      lowWaterMark: this.lowWater,
      backpressureEvents: this.backpressureEvents,
    };
  }

  /** Resume token for re-joining this session (`SubscribeToTask` GET style). */
  resumeToken(): string {
    return makeA2aLiveResumeToken(this.taskId, this.generation, this.lastReceivedSequence);
  }

  /** Frames received so far (oldest first). */
  received(): A2aV3Frame[] {
    return [...this.receivedFrames];
  }

  private async emit(frame: A2aV3Frame): Promise<void> {
    await this.transport.send(frame);
  }

  /**
   * Register + send a frame through the window and the session
   * backpressure gate. When the window is full the v3 window
   * queues it (never dropped) and backpressure is reported; when
   * the unacked count is past the high-water mark the session
   * reports backpressure until acks drain it below the low-water
   * mark.
   */
  private async sendKind(kind: string, payload: Record<string, unknown>): Promise<A2aV3Frame> {
    if (this.status === 'closed') {
      throw new A2aLiveV4Error('CHANNEL_CLOSED', `Cannot send ${kind}: live session is closed`);
    }
    const direction: 'up' | 'down' = this.role === 'client' ? 'up' : 'down';
    const { sendNow, frame } = this.window.register(direction, this.taskId, kind, payload);
    if (!sendNow) {
      // Window full: the frame is already queued inside the window;
      // backpressure is reported, the window releases it on ack.
      this.setBackpressure(true);
      return frame;
    }
    if (this.window.unackedCount() >= this.highWater) {
      // Sent, but the peer is behind: hold further sends until drain.
      this.setBackpressure(true);
    }
    await this.emit(frame);
    return frame;
  }

  private setBackpressure(value: boolean): void {
    if (value === this.backpressured) return;
    this.backpressured = value;
    this.backpressureEvents += 1;
    if (value) this.status = 'backpressured';
    else if (this.status === 'backpressured') this.status = 'open';
    this.events.onBackpressure?.(value, this.window.unackedCount());
  }

  /** Drain the session queue after acks opened window slots. */
  private async drainAfterAck(sequence: number): Promise<void> {
    const releasable = this.window.ackThrough(sequence);
    for (const frame of releasable) await this.emit(frame);
    if (this.backpressured && this.window.unackedCount() <= this.lowWater) {
      this.setBackpressure(false);
    }
  }

  /** Client -> agent: send an input message mid-task. */
  async sendInput(message: A2aMessage): Promise<A2aV3Frame> {
    if (this.role !== 'client') throw new A2aLiveV4Error('WRONG_ROLE', 'Only the client end sends input');
    return this.sendKind('input', {
      message: message as unknown as Record<string, unknown>,
      generation: this.generation,
    });
  }

  /** Client -> agent: interrupt the task (new instructions). */
  async sendInterrupt(reason: string, instructions?: string): Promise<A2aV3Frame> {
    if (this.role !== 'client') throw new A2aLiveV4Error('WRONG_ROLE', 'Only the client end sends interrupts');
    return this.sendKind('interrupt', { reason, ...(instructions ? { instructions } : {}) });
  }

  /** Client -> agent: cancel the task. */
  async sendCancel(): Promise<A2aV3Frame> {
    if (this.role !== 'client') throw new A2aLiveV4Error('WRONG_ROLE', 'Only the client end sends cancel');
    return this.sendKind('cancel', {});
  }

  /**
   * Client -> agent: write an artifact mid-task (A2A v1.1: clients
   * can write artifacts). The artifact is validated structurally
   * and size-capped; the agent end surfaces it via
   * `onClientArtifact` and records it in its history.
   */
  async sendClientArtifact(artifact: A2aArtifact): Promise<A2aV3Frame> {
    if (this.role !== 'client') throw new A2aLiveV4Error('WRONG_ROLE', 'Only the client end writes artifacts');
    if (typeof artifact.artifactId !== 'string' || artifact.artifactId === '') {
      throw new A2aLiveV4Error('BAD_ARTIFACT', 'Client artifact needs a non-empty artifactId');
    }
    if (!Array.isArray(artifact.parts)) {
      throw new A2aLiveV4Error('BAD_ARTIFACT', 'Client artifact parts must be an array');
    }
    const bytes = JSON.stringify(artifact).length;
    if (bytes > A2A_V4_LIVE_MAX_CLIENT_ARTIFACT_BYTES) {
      throw new A2aLiveV4Error(
        'ARTIFACT_TOO_LARGE',
        `Client artifact exceeds ${A2A_V4_LIVE_MAX_CLIENT_ARTIFACT_BYTES} bytes`,
      );
    }
    return this.sendKind('artifact', {
      artifact: artifact as unknown as Record<string, unknown>,
      generation: this.generation,
    });
  }

  /** Agent -> client: report a task state change. */
  async sendStatus(state: A2aTaskState, note?: string): Promise<A2aV3Frame> {
    if (this.role !== 'agent') throw new A2aLiveV4Error('WRONG_ROLE', 'Only the agent end sends status');
    this.taskState = state;
    this.historyLog.append({
      generation: this.generation,
      sequence: this.window.peekSequence(),
      kind: 'status',
      summary: `status ${state}${note ? `: ${note}` : ''}`,
      at: new Date().toISOString(),
    });
    return this.sendKind('status', { state, generation: this.generation, ...(note ? { note } : {}) });
  }

  /** Agent -> client: send a message. */
  async sendMessage(message: A2aMessage): Promise<A2aV3Frame> {
    if (this.role !== 'agent') throw new A2aLiveV4Error('WRONG_ROLE', 'Only the agent end sends messages');
    this.historyLog.append({
      generation: this.generation,
      sequence: this.window.peekSequence(),
      kind: 'message',
      summary: `message ${message.messageId}`,
      at: new Date().toISOString(),
    });
    return this.sendKind('message', {
      message: message as unknown as Record<string, unknown>,
      generation: this.generation,
    });
  }

  /** Agent -> client: send one artifact chunk (size-capped). */
  async sendArtifactChunk(chunk: A2aV3ArtifactChunkPayload): Promise<A2aV3Frame> {
    if (this.role !== 'agent') throw new A2aLiveV4Error('WRONG_ROLE', 'Only the agent end sends artifact chunks');
    if (chunk.data.length > A2A_V3_MAX_CHUNK_BYTES) {
      throw new A2aLiveV4Error('CHUNK_TOO_LARGE', `Artifact chunk exceeds ${A2A_V3_MAX_CHUNK_BYTES} bytes`);
    }
    return this.sendKind('artifactChunk', chunk as unknown as Record<string, unknown>);
  }

  /** Agent -> client: mark an artifact complete. */
  async sendArtifactDone(artifactId: string): Promise<A2aV3Frame> {
    if (this.role !== 'agent') throw new A2aLiveV4Error('WRONG_ROLE', 'Only the agent end sends artifactDone');
    return this.sendKind('artifactDone', { artifactId });
  }

  /** Agent -> client: finish the task (terminal state). */
  async sendDone(task: A2aTask): Promise<A2aV3Frame> {
    if (this.role !== 'agent') throw new A2aLiveV4Error('WRONG_ROLE', 'Only the agent end sends done');
    if (!isA2aTerminalState(task.status.state)) {
      throw new A2aLiveV4Error('NOT_TERMINAL', `done requires a terminal task state, got ${task.status.state}`);
    }
    this.taskState = task.status.state;
    this.historyLog.append({
      generation: this.generation,
      sequence: this.window.peekSequence(),
      kind: 'done',
      summary: `done ${task.status.state}`,
      at: new Date().toISOString(),
    });
    return this.sendKind('done', { task: task as unknown as Record<string, unknown> });
  }

  /** Agent -> client: report a task error. */
  async sendError(message: string): Promise<A2aV3Frame> {
    if (this.role !== 'agent') throw new A2aLiveV4Error('WRONG_ROLE', 'Only the agent end sends errors');
    return this.sendKind('error', { message });
  }

  /** Either end: send a heartbeat frame. */
  async sendHeartbeat(): Promise<A2aV3Frame> {
    const frame = await this.sendKind('heartbeat', {});
    this.heartbeatsSent += 1;
    return frame;
  }

  /**
   * Re-send every unacked frame after a reconnect. The peer drops
   * duplicates by sequence, so re-sending is safe. Does NOT bump
   * the generation — use `reconnect()` for a new generation.
   */
  async resume(): Promise<number> {
    const pending = this.window.pendingFrames();
    for (const frame of pending) await this.emit(frame);
    return pending.length;
  }

  /**
   * Re-join after a dropped connection: bump the generation (so
   * the peer can tell pre- and post-reconnect frames apart for
   * ordering / optimistic concurrency), then re-send unacked
   * frames. Returns the new resume token.
   */
  async reconnect(): Promise<string> {
    this.generation += 1;
    await this.resume();
    return this.resumeToken();
  }

  private handleInbound(frame: A2aV3Frame): void {
    const checked = validateA2aV3Frame(frame);
    if (!checked.ok) return;
    if (frame.taskId !== this.taskId) return;
    if (this.seenSequences.has(frame.sequence)) return;
    this.seenSequences.add(frame.sequence);
    this.receivedFrames.push(frame);
    if (frame.sequence > this.lastReceivedSequence) {
      this.lastReceivedSequence = frame.sequence;
    }
    const payload = frame.payload;
    const generation =
      typeof payload['generation'] === 'number' ? (payload['generation'] as number) : this.generation;
    switch (frame.kind) {
      case 'ack': {
        const ackSequence = payload['ackSequence'];
        if (typeof ackSequence === 'number') void this.drainAfterAck(ackSequence);
        break;
      }
      case 'heartbeat': {
        this.heartbeatsReceived += 1;
        break;
      }
      case 'status': {
        const state = payload['state'];
        if (typeof state === 'string') {
          this.taskState = state as A2aTaskState;
          this.historyLog.append({
            generation,
            sequence: frame.sequence,
            kind: 'status',
            summary: `status ${state}`,
            at: frame.at,
          });
          this.events.onStatus?.(state as A2aTaskState, typeof payload['note'] === 'string' ? payload['note'] : undefined);
        }
        break;
      }
      case 'message': {
        const message = payload['message'] as A2aMessage | undefined;
        if (message) {
          this.historyLog.append({
            generation,
            sequence: frame.sequence,
            kind: 'message',
            summary: `message ${message.messageId}`,
            at: frame.at,
          });
          this.events.onMessage?.(message, generation);
        }
        break;
      }
      case 'artifactChunk': {
        const chunk = payload as unknown as A2aV3ArtifactChunkPayload;
        if (typeof chunk.artifactId === 'string' && typeof chunk.data === 'string') {
          const list = this.artifacts.get(chunk.artifactId) ?? [];
          list[chunk.index] = chunk.data;
          this.artifacts.set(chunk.artifactId, list);
          this.events.onArtifactChunk?.(chunk);
        }
        break;
      }
      case 'artifactDone': {
        if (typeof payload['artifactId'] === 'string') this.events.onArtifactDone?.(payload['artifactId'] as string);
        break;
      }
      case 'artifact': {
        // Client-written artifact (v1.1): only the agent end accepts it.
        const artifact = payload['artifact'] as A2aArtifact | undefined;
        if (this.role === 'agent' && artifact && typeof artifact.artifactId === 'string' && Array.isArray(artifact.parts)) {
          this.clientArtifacts.push(artifact);
          this.historyLog.append({
            generation,
            sequence: frame.sequence,
            kind: 'clientArtifact',
            summary: `client artifact ${artifact.artifactId}`,
            at: frame.at,
          });
          this.events.onClientArtifact?.(artifact, generation);
        }
        break;
      }
      case 'done': {
        const task = payload['task'] as A2aTask | undefined;
        if (task) {
          this.taskState = task.status.state;
          this.historyLog.append({
            generation,
            sequence: frame.sequence,
            kind: 'done',
            summary: `done ${task.status.state}`,
            at: frame.at,
          });
          this.events.onDone?.(task);
        }
        break;
      }
      case 'error': {
        if (typeof payload['message'] === 'string') {
          this.historyLog.append({
            generation,
            sequence: frame.sequence,
            kind: 'error',
            summary: `error: ${payload['message']}`,
            at: frame.at,
          });
          this.events.onError?.(payload['message']);
        }
        break;
      }
      case 'input': {
        const message = payload['message'] as A2aMessage | undefined;
        if (message) this.events.onInput?.(message);
        break;
      }
      case 'interrupt': {
        const reason = payload['reason'];
        if (typeof reason === 'string') {
          this.events.onInterrupt?.(
            reason,
            typeof payload['instructions'] === 'string' ? (payload['instructions'] as string) : undefined,
          );
        }
        break;
      }
      case 'cancel': {
        this.events.onCancel?.();
        break;
      }
      default:
        break;
    }
    this.events.onFrame?.(frame);
    // Ack the peer's frame so its window can advance. Acks and
    // heartbeats are never acked themselves (that would ping-pong).
    if (
      frame.kind !== 'ack' &&
      frame.kind !== 'heartbeat' &&
      frame.direction !== (this.role === 'client' ? 'up' : 'down')
    ) {
      void this.sendAck(frame.sequence);
    }
  }

  /** Send an ack for the peer's sequence (best-effort, never throws). */
  private async sendAck(sequence: number): Promise<void> {
    try {
      const direction: 'up' | 'down' = this.role === 'client' ? 'up' : 'down';
      const frame = this.window.registerUntracked(direction, this.taskId, 'ack', { ackSequence: sequence });
      await this.emit(frame);
    } catch {
      // Ack loss is harmless: the peer re-sends on resume.
    }
  }

  /** Pause the session (stops heartbeats; inbound frames still recorded). */
  pause(): void {
    if (this.status !== 'closed') this.status = 'paused';
  }

  /** Resume a paused session. */
  unpause(): void {
    if (this.status === 'paused') this.status = 'open';
  }

  /** Close the session (stops heartbeats, unsubscribes, refuses sends). */
  close(): void {
    this.status = 'closed';
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    this.unsubscribe?.();
    this.unsubscribe = null;
  }
}

/**
 * Join two live session ends in-process (tests / loopback): returns
 * the client end and the agent end wired to each other through two
 * in-memory transports. Each direction delivers frames synchronously
 * to the peer's handler.
 */
export function createLoopbackLiveSession(
  task: A2aTask,
  clientEvents: A2aLiveV4Events = {},
  agentEvents: A2aLiveV4Events = {},
  options: {
    negotiatedVersion?: string;
    windowSize?: number;
    highWaterMark?: number;
    lowWaterMark?: number;
    heartbeatMs?: number;
  } = {},
): { client: A2aLiveV4Channel; agent: A2aLiveV4Channel } {
  const clientHandlers = new Set<(frame: A2aV3Frame) => void>();
  const agentHandlers = new Set<(frame: A2aV3Frame) => void>();
  const clientTransport: A2aV3ChannelTransport = {
    send: (frame) => {
      for (const handler of [...agentHandlers]) handler(frame);
    },
    onFrame: (handler) => {
      clientHandlers.add(handler);
      return () => {
        clientHandlers.delete(handler);
      };
    },
  };
  const agentTransport: A2aV3ChannelTransport = {
    send: (frame) => {
      for (const handler of [...clientHandlers]) handler(frame);
    },
    onFrame: (handler) => {
      agentHandlers.add(handler);
      return () => {
        agentHandlers.delete(handler);
      };
    },
  };
  const client = new A2aLiveV4Channel(task, 'client', clientTransport, clientEvents, options);
  const agent = new A2aLiveV4Channel(task, 'agent', agentTransport, agentEvents, options);
  return { client, agent };
}

/** Terminal states, re-exported for callers that only import v4. */
export { A2A_TERMINAL_STATES };

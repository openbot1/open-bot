/**
 * Protocols v3 — A2A v1.1 two-way streaming (v1.19, Team T3).
 *
 * Idea only, learned from the public A2A v1.1 description in
 * docs/repo-survey-v119.md section 2: v1.1 finalises two-way
 * streaming — the client and the agent stream to each other at the
 * same time while a task runs (client input, interrupts and acks
 * flow up; status, artifact chunks and messages flow down), with
 * flow control and resume after a dropped connection. No code, text
 * or asset from any other repo is copied here.
 *
 * This builds on the existing A2A layers without touching them:
 *  - `a2a/types.ts` — task / message / artifact vocabulary;
 *  - `a2a/taskStream.ts` — the sequenced per-task event log;
 *  - `a2a/version11.ts` — v1.1 feature flags;
 *  - `protocolsV2/a2aV117.ts` — v117 client/server pair + the
 *    `TwoWayTaskSession` (client input / cancel / ack while a task
 *    runs, replay from the log).
 * v3 is the full duplex channel on top of that session idea:
 *   1. a frame vocabulary — client→agent frames (`input`,
 *      `interrupt`, `cancel`, `ack`, `heartbeat`) and agent→client
 *      frames (`status`, `message`, `artifactChunk`, `artifactDone`,
 *      `error`, `done`, `heartbeat`);
 *   2. flow control — a send window: the sender may have at most
 *      `windowSize` unacked frames in flight; the receiver acks by
 *      sequence, and the sender pauses (queues) past the window
 *      instead of dropping frames;
 *   3. reconnect + resume — both directions carry a monotonic
 *      sequence; on reconnect the peer re-sends everything after
 *      the last acked sequence, so no frame is lost or duplicated
 *      (duplicates are detected by sequence and dropped);
 *   4. a `TwoWayChannelV3` that joins a client end and an agent end
 *      over an injected transport (two functions: `send` + `onFrame`),
 *      so the same code works in-process in tests and over JSON-RPC
 *      in production — nothing here touches the network.
 *
 * Frames are plain JSON. Artifact chunks carry base64 text only in
 * tests; production chunks carry the same shape over the wire.
 */

import {
  A2A_TERMINAL_STATES,
  isA2aTerminalState,
  type A2aArtifact,
  type A2aMessage,
  type A2aTask,
  type A2aTaskState,
} from '../a2a/types';

/** A2A version this channel speaks. */
export const A2A_V3_VERSION = '1.1';
/** Default flow-control window (max unacked frames in flight). */
export const A2A_V3_DEFAULT_WINDOW = 16;
/** Default heartbeat interval in ms. */
export const A2A_V3_DEFAULT_HEARTBEAT_MS = 15_000;
/** Max buffered outbound frames while the window is full. */
export const A2A_V3_MAX_QUEUED_FRAMES = 256;
/** Max bytes of one artifact chunk payload. */
export const A2A_V3_MAX_CHUNK_BYTES = 256 * 1024;

/** Error raised by the v3 two-way channel. */
export class A2aV3Error extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'A2aV3Error';
    this.code = code;
  }
}

/** Back-compat alias for the pre-rename error name. */
export const A2aTwoWayV3Error = A2aV3Error;

// ---------------------------------------------------------------------------
// Frames
// ---------------------------------------------------------------------------

/** Client -> agent frame kinds. */
export type A2aV3UpstreamKind = 'input' | 'interrupt' | 'cancel' | 'ack' | 'heartbeat';
/** Agent -> client frame kinds. */
export type A2aV3DownstreamKind =
  | 'status'
  | 'message'
  | 'artifactChunk'
  | 'artifactDone'
  | 'error'
  | 'done'
  | 'heartbeat';

/** One frame on the wire (either direction). */
export interface A2aV3Frame {
  /** Direction of the frame. */
  direction: 'up' | 'down';
  /** Kind of the frame. */
  kind: string;
  /** Task this frame belongs to. */
  taskId: string;
  /** Monotonic per-direction sequence (starts at 0). */
  sequence: number;
  /** Payload (kind-specific, plain JSON). */
  payload: Record<string, unknown>;
  /** Wall-clock send time (ISO). */
  at: string;
}

/** Upstream payloads. */
export interface A2aV3InputPayload {
  message: A2aMessage;
}
export interface A2aV3InterruptPayload {
  /** What the client wants changed (free-form, e.g. new instructions). */
  reason: string;
  instructions?: string;
}
export interface A2aV3AckPayload {
  /** Highest downstream sequence the client has received. */
  ackSequence: number;
}

/** Downstream payloads. */
export interface A2aV3StatusPayload {
  state: A2aTaskState;
  note?: string;
}
export interface A2aV3ArtifactChunkPayload {
  artifactId: string;
  /** Chunk index (0-based, in order). */
  index: number;
  /** Chunk bytes as text (UTF-8; binary artifacts use base64). */
  data: string;
  /** Encoding of `data`: `utf8` or `base64`. */
  encoding: 'utf8' | 'base64';
}
export interface A2aV3MessagePayload {
  message: A2aMessage;
}

/** Validate a frame's shape (unknown fields ignored). */
export function validateA2aV3Frame(value: unknown): { ok: true; frame: A2aV3Frame } | { ok: false; reason: string } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, reason: 'Frame must be an object' };
  }
  const frame = value as Record<string, unknown>;
  if (frame['direction'] !== 'up' && frame['direction'] !== 'down') {
    return { ok: false, reason: 'Frame direction must be "up" or "down"' };
  }
  if (typeof frame['kind'] !== 'string' || frame['kind'] === '') {
    return { ok: false, reason: 'Frame kind must be a non-empty string' };
  }
  if (typeof frame['taskId'] !== 'string' || frame['taskId'] === '') {
    return { ok: false, reason: 'Frame taskId must be a non-empty string' };
  }
  if (typeof frame['sequence'] !== 'number' || !Number.isInteger(frame['sequence']) || frame['sequence'] < 0) {
    return { ok: false, reason: 'Frame sequence must be a non-negative integer' };
  }
  if (typeof frame['payload'] !== 'object' || frame['payload'] === null || Array.isArray(frame['payload'])) {
    return { ok: false, reason: 'Frame payload must be an object' };
  }
  return { ok: true, frame: frame as unknown as A2aV3Frame };
}

/** True when a frame kind belongs to the upstream vocabulary. */
export function isA2aV3UpstreamKind(kind: string): kind is A2aV3UpstreamKind {
  return kind === 'input' || kind === 'interrupt' || kind === 'cancel' || kind === 'ack' || kind === 'heartbeat';
}

/** True when a frame kind belongs to the downstream vocabulary. */
export function isA2aV3DownstreamKind(kind: string): kind is A2aV3DownstreamKind {
  return (
    kind === 'status' ||
    kind === 'message' ||
    kind === 'artifactChunk' ||
    kind === 'artifactDone' ||
    kind === 'error' ||
    kind === 'done' ||
    kind === 'heartbeat'
  );
}

// ---------------------------------------------------------------------------
// Flow control: send window
// ---------------------------------------------------------------------------

/** Flow-control window: at most `size` unacked frames in flight. */
export class A2aV3SendWindow {
  private readonly size: number;
  private readonly unacked = new Map<number, A2aV3Frame>();
  private readonly queued: A2aV3Frame[] = [];
  private nextSequence = 0;

  constructor(size: number = A2A_V3_DEFAULT_WINDOW) {
    if (size < 1) throw new A2aTwoWayV3Error('BAD_WINDOW', 'Send window size must be >= 1');
    this.size = size;
  }

  /** Window size. */
  getSize(): number {
    return this.size;
  }

  /** Next sequence to assign. */
  peekSequence(): number {
    return this.nextSequence;
  }

  /** Frames still unacked. */
  unackedCount(): number {
    return this.unacked.size;
  }

  /** Frames queued while the window was full. */
  queuedCount(): number {
    return this.queued.length;
  }

  /** True when another frame may be sent immediately. */
  canSend(): boolean {
    return this.unacked.size < this.size;
  }

  /**
   * Register a frame for sending: assigns the next sequence and
   * either sends it now (window open) or queues it (window full).
   * Returns `{ sendNow, frame }`.
   */
  register(direction: 'up' | 'down', taskId: string, kind: string, payload: Record<string, unknown>): { sendNow: boolean; frame: A2aV3Frame } {
    const frame: A2aV3Frame = {
      direction,
      kind,
      taskId,
      sequence: this.nextSequence,
      payload,
      at: new Date().toISOString(),
    };
    this.nextSequence += 1;
    if (this.unacked.size < this.size) {
      this.unacked.set(frame.sequence, frame);
      return { sendNow: true, frame };
    }
    if (this.queued.length >= A2A_V3_MAX_QUEUED_FRAMES) {
      throw new A2aTwoWayV3Error('WINDOW_QUEUE_FULL', `Send window queue is full (${A2A_V3_MAX_QUEUED_FRAMES} frames)`);
    }
    this.queued.push(frame);
    return { sendNow: false, frame };
  }

  /**
   * Ack everything up to and including `sequence`. Returns the
   * queued frames that may now be sent (in order).
   */
  ackThrough(sequence: number): A2aV3Frame[] {
    for (const seq of [...this.unacked.keys()]) {
      if (seq <= sequence) this.unacked.delete(seq);
    }
    const releasable: A2aV3Frame[] = [];
    while (this.unacked.size < this.size && this.queued.length > 0) {
      const next = this.queued.shift()!;
      this.unacked.set(next.sequence, next);
      releasable.push(next);
    }
    return releasable;
  }

  /**
   * Register a frame that needs no ack (acks and heartbeats): assigns
   * the next sequence but does not occupy a window slot, so an ack
   * can never deadlock behind a full window.
   */
  registerUntracked(direction: 'up' | 'down', taskId: string, kind: string, payload: Record<string, unknown>): A2aV3Frame {
    const frame: A2aV3Frame = {
      direction,
      kind,
      taskId,
      sequence: this.nextSequence,
      payload,
      at: new Date().toISOString(),
    };
    this.nextSequence += 1;
    return frame;
  }

  /** Frames that still need an ack (for resume after reconnect). */
  pendingFrames(): A2aV3Frame[] {
    return [...this.unacked.values(), ...this.queued].sort((a, b) => a.sequence - b.sequence);
  }
}

// ---------------------------------------------------------------------------
// Two-way channel
// ---------------------------------------------------------------------------

/** Transport the channel runs over (injected; in-process in tests). */
export interface A2aV3ChannelTransport {
  /** Send one frame to the peer. */
  send(frame: A2aV3Frame): void | Promise<void>;
  /** Register the inbound-frame handler. */
  onFrame(handler: (frame: A2aV3Frame) => void): () => void;
}

/** One end of a two-way channel (client end or agent end). */
export type A2aV3ChannelRole = 'client' | 'agent';

/** Channel status. */
export type A2aV3ChannelStatus = 'open' | 'paused' | 'closed';

/** Events a channel end emits to its owner. */
export interface A2aV3ChannelEvents {
  onFrame?: (frame: A2aV3Frame) => void;
  onStatus?: (status: A2aTaskState, note?: string) => void;
  onMessage?: (message: A2aMessage) => void;
  onArtifactChunk?: (chunk: A2aV3ArtifactChunkPayload) => void;
  onArtifactDone?: (artifactId: string) => void;
  onDone?: (task: A2aTask) => void;
  onError?: (error: string) => void;
  onInput?: (message: A2aMessage) => void;
  onInterrupt?: (payload: A2aV3InterruptPayload) => void;
  onCancel?: () => void;
}

/**
 * One end of an A2A v1.1 two-way channel.
 *
 * - The client end sends `input` / `interrupt` / `cancel` / `ack`
 *   frames and receives `status` / `message` / `artifactChunk` /
 *   `done` frames; the agent end does the reverse.
 * - Both directions are flow-controlled by a send window and acked
 *   by sequence; `resume()` re-sends every unacked frame after a
 *   reconnect, and inbound duplicates (sequence already seen) are
 *   dropped.
 * - Heartbeats are sent on a timer when the channel is idle; a
 *   missed heartbeat does not close the channel (the transport owns
 *   liveness) — it is recorded for the UI instead.
 */
export class A2aV3TwoWayChannel {
  readonly taskId: string;
  readonly role: A2aV3ChannelRole;
  private readonly transport: A2aV3ChannelTransport;
  private readonly events: A2aV3ChannelEvents;
  private readonly window: A2aV3SendWindow;
  private readonly heartbeatMs: number;
  private status: A2aV3ChannelStatus = 'open';
  private taskState: A2aTaskState;
  private lastReceivedSequence = -1;
  private readonly seenSequences = new Set<number>();
  private readonly receivedFrames: A2aV3Frame[] = [];
  private readonly artifacts = new Map<string, string[]>();
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private heartbeatsSent = 0;
  private heartbeatsReceived = 0;
  private unsubscribe: (() => void) | null = null;

  constructor(
    task: A2aTask,
    role: A2aV3ChannelRole,
    transport: A2aV3ChannelTransport,
    events: A2aV3ChannelEvents = {},
    options: { windowSize?: number; heartbeatMs?: number } = {},
  ) {
    this.taskId = task.id;
    this.role = role;
    this.transport = transport;
    this.events = events;
    this.window = new A2aV3SendWindow(options.windowSize ?? A2A_V3_DEFAULT_WINDOW);
    this.heartbeatMs = options.heartbeatMs ?? A2A_V3_DEFAULT_HEARTBEAT_MS;
    this.taskState = task.status.state;
    this.unsubscribe = transport.onFrame((frame) => this.handleInbound(frame));
    if (this.heartbeatMs > 0) {
      this.heartbeatTimer = setInterval(() => {
        if (this.status === 'open') void this.sendHeartbeat();
      }, this.heartbeatMs);
      // Do not keep the process alive for heartbeats alone.
      if (typeof (this.heartbeatTimer as unknown as { unref?: unknown }).unref === 'function') {
        (this.heartbeatTimer as unknown as { unref: () => void }).unref();
      }
    }
  }

  /** Channel status. */
  getStatus(): A2aV3ChannelStatus {
    return this.status;
  }

  /** Current task state (from the last status frame). */
  getTaskState(): A2aTaskState {
    return this.taskState;
  }

  /** Highest inbound sequence received. */
  lastReceived(): number {
    return this.lastReceivedSequence;
  }

  /** Frames received so far (oldest first). */
  received(): A2aV3Frame[] {
    return [...this.receivedFrames];
  }

  /** Heartbeats sent / received. */
  heartbeatStats(): { sent: number; received: number } {
    return { sent: this.heartbeatsSent, received: this.heartbeatsReceived };
  }

  /** Assembled artifact text so far (chunks joined in order). */
  artifactText(artifactId: string): string {
    return (this.artifacts.get(artifactId) ?? []).join('');
  }

  /** Artifact ids with at least one chunk. */
  artifactIds(): string[] {
    return [...this.artifacts.keys()];
  }

  /** Send window (for inspection / tests). */
  getWindow(): A2aV3SendWindow {
    return this.window;
  }

  private async emit(frame: A2aV3Frame): Promise<void> {
    await this.transport.send(frame);
  }

  private async sendKind(kind: string, payload: Record<string, unknown>): Promise<A2aV3Frame> {
    if (this.status === 'closed') {
      throw new A2aTwoWayV3Error('CHANNEL_CLOSED', `Cannot send ${kind}: channel is closed`);
    }
    const direction: 'up' | 'down' = this.role === 'client' ? 'up' : 'down';
    const { sendNow, frame } = this.window.register(direction, this.taskId, kind, payload);
    if (sendNow) await this.emit(frame);
    return frame;
  }

  /** Client -> agent: send an input message mid-task. */
  async sendInput(message: A2aMessage): Promise<A2aV3Frame> {
    if (this.role !== 'client') throw new A2aTwoWayV3Error('WRONG_ROLE', 'Only the client end sends input');
    return this.sendKind('input', { message: message as unknown as Record<string, unknown> });
  }

  /** Client -> agent: interrupt the task (new instructions). */
  async sendInterrupt(reason: string, instructions?: string): Promise<A2aV3Frame> {
    if (this.role !== 'client') throw new A2aTwoWayV3Error('WRONG_ROLE', 'Only the client end sends interrupts');
    return this.sendKind('interrupt', { reason, ...(instructions ? { instructions } : {}) });
  }

  /** Client -> agent: cancel the task. */
  async sendCancel(): Promise<A2aV3Frame> {
    if (this.role !== 'client') throw new A2aTwoWayV3Error('WRONG_ROLE', 'Only the client end sends cancel');
    return this.sendKind('cancel', {});
  }

  /** Agent -> client: report a task state change. */
  async sendStatus(state: A2aTaskState, note?: string): Promise<A2aV3Frame> {
    if (this.role !== 'agent') throw new A2aTwoWayV3Error('WRONG_ROLE', 'Only the agent end sends status');
    this.taskState = state;
    return this.sendKind('status', { state, ...(note ? { note } : {}) });
  }

  /** Agent -> client: send a message. */
  async sendMessage(message: A2aMessage): Promise<A2aV3Frame> {
    if (this.role !== 'agent') throw new A2aTwoWayV3Error('WRONG_ROLE', 'Only the agent end sends messages');
    return this.sendKind('message', { message: message as unknown as Record<string, unknown> });
  }

  /** Agent -> client: send one artifact chunk (size-capped). */
  async sendArtifactChunk(chunk: A2aV3ArtifactChunkPayload): Promise<A2aV3Frame> {
    if (this.role !== 'agent') throw new A2aTwoWayV3Error('WRONG_ROLE', 'Only the agent end sends artifact chunks');
    if (chunk.data.length > A2A_V3_MAX_CHUNK_BYTES) {
      throw new A2aTwoWayV3Error('CHUNK_TOO_LARGE', `Artifact chunk exceeds ${A2A_V3_MAX_CHUNK_BYTES} bytes`);
    }
    return this.sendKind('artifactChunk', chunk as unknown as Record<string, unknown>);
  }

  /** Agent -> client: mark an artifact complete. */
  async sendArtifactDone(artifactId: string): Promise<A2aV3Frame> {
    if (this.role !== 'agent') throw new A2aTwoWayV3Error('WRONG_ROLE', 'Only the agent end sends artifactDone');
    return this.sendKind('artifactDone', { artifactId });
  }

  /** Agent -> client: finish the task (terminal state). */
  async sendDone(task: A2aTask): Promise<A2aV3Frame> {
    if (this.role !== 'agent') throw new A2aTwoWayV3Error('WRONG_ROLE', 'Only the agent end sends done');
    if (!isA2aTerminalState(task.status.state)) {
      throw new A2aTwoWayV3Error('NOT_TERMINAL', `done requires a terminal task state, got ${task.status.state}`);
    }
    this.taskState = task.status.state;
    return this.sendKind('done', { task: task as unknown as Record<string, unknown> });
  }

  /** Agent -> client: report a task error. */
  async sendError(message: string): Promise<A2aV3Frame> {
    if (this.role !== 'agent') throw new A2aTwoWayV3Error('WRONG_ROLE', 'Only the agent end sends errors');
    return this.sendKind('error', { message });
  }

  /** Either end: send a heartbeat frame. */
  async sendHeartbeat(): Promise<A2aV3Frame> {
    const frame = await this.sendKind('heartbeat', {});
    this.heartbeatsSent += 1;
    return frame;
  }

  /**
   * Ack the peer's frames up to `sequence` and release queued
   * frames whose window slots opened. Called when an `ack` frame
   * arrives (and by the owner after processing inbound frames).
   */
  private async releaseAfterAck(sequence: number): Promise<void> {
    const releasable = this.window.ackThrough(sequence);
    for (const frame of releasable) await this.emit(frame);
  }

  /**
   * Re-send every unacked frame after a reconnect. The peer drops
   * duplicates by sequence, so re-sending is safe.
   */
  async resume(): Promise<number> {
    const pending = this.window.pendingFrames();
    for (const frame of pending) await this.emit(frame);
    return pending.length;
  }

  private handleInbound(frame: A2aV3Frame): void {
    const checked = validateA2aV3Frame(frame);
    if (!checked.ok) return;
    if (frame.taskId !== this.taskId) return;
    // Duplicate (already seen sequence) — drop silently.
    if (this.seenSequences.has(frame.sequence)) return;
    this.seenSequences.add(frame.sequence);
    this.receivedFrames.push(frame);
    if (frame.sequence > this.lastReceivedSequence) {
      this.lastReceivedSequence = frame.sequence;
    }
    const payload = frame.payload;
    switch (frame.kind) {
      case 'ack': {
        const ackSequence = payload['ackSequence'];
        if (typeof ackSequence === 'number') void this.releaseAfterAck(ackSequence);
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
          this.events.onStatus?.(state as A2aTaskState, typeof payload['note'] === 'string' ? payload['note'] : undefined);
        }
        break;
      }
      case 'message': {
        const message = payload['message'] as A2aMessage | undefined;
        if (message) this.events.onMessage?.(message);
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
      case 'done': {
        const task = payload['task'] as A2aTask | undefined;
        if (task) {
          this.taskState = task.status.state;
          this.events.onDone?.(task);
        }
        break;
      }
      case 'error': {
        if (typeof payload['message'] === 'string') this.events.onError?.(payload['message']);
        break;
      }
      case 'input': {
        const message = payload['message'] as A2aMessage | undefined;
        if (message) this.events.onInput?.(message);
        break;
      }
      case 'interrupt': {
        this.events.onInterrupt?.(payload as unknown as A2aV3InterruptPayload);
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

  /** Pause the channel (stops heartbeats; inbound frames still recorded). */
  pause(): void {
    this.status = 'paused';
  }

  /** Resume a paused channel. */
  unpause(): void {
    if (this.status === 'paused') this.status = 'open';
  }

  /** Close the channel (stops heartbeats, unsubscribes, refuses sends). */
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
 * Join two channel ends in-process (tests / loopback): returns the
 * client end and the agent end wired to each other through two
 * in-memory transports. Each direction delivers frames synchronously
 * to the peer's handler.
 */
export function createLoopbackTwoWayChannel(
  task: A2aTask,
  clientEvents: A2aV3ChannelEvents = {},
  agentEvents: A2aV3ChannelEvents = {},
  options: { windowSize?: number; heartbeatMs?: number } = {},
): { client: A2aV3TwoWayChannel; agent: A2aV3TwoWayChannel } {
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
  const client = new A2aV3TwoWayChannel(task, 'client', clientTransport, clientEvents, options);
  const agent = new A2aV3TwoWayChannel(task, 'agent', agentTransport, agentEvents, options);
  return { client, agent };
}

/** Terminal states, re-exported for callers that only import v3. */
export { A2A_TERMINAL_STATES };
export type { A2aArtifact };

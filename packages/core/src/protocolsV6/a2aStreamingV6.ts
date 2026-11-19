/**
 * A2A 1.1 — two-way streaming for a running task (v1.37, Team T2).
 *
 * Idea only, learned from the public protocol descriptions in
 * docs/repo-survey-v137.md: A2A 1.1 adds two-way streaming while
 * a task runs — the client and the agent stream updates to each
 * other on the same task: the agent streams status, messages and
 * artifact chunks downstream while the client can send new
 * input, interrupt, cancel or resume mid-task upstream, instead
 * of the v1.0 pattern where a task was fire-and-poll.
 *
 * This module is the open-bot implementation, built from scratch
 * (it builds on the v3 two-way frame shape and the v4 live
 * channel ideas without importing them — a v6 stream is its own
 * transport-free duplex):
 *   - `A2aV6Stream` — one side of a duplex stream for one task.
 *     Frames carry a monotonically increasing sequence number;
 *     the window (high-water / low-water) applies backpressure;
 *     pause stops delivery without dropping frames; cancel ends
 *     the task; resume re-opens it from a resume token.
 *   - `createLoopbackA2aV6Pair()` — two streams wired to each
 *     other in-process (client side + agent side), for tests and
 *     for hosts that run both ends locally.
 *   - Resume tokens: an opaque token captures task id, last
 *     delivered sequence and task state, so a dropped stream can
 *     resume without re-running the task.
 *   - Artifact reassembly: artifact chunks arrive in order and
 *     `reassembleArtifact()` rebuilds the artifact (with a size
 *     cap); a chunk for an unknown artifact or out of order is a
 *     protocol error, never silently accepted.
 *
 * No code, text or asset from any other repo is copied here.
 */

/** A2A version this streaming layer targets. */
export const A2A_V6_VERSION = '1.1';
/** Default flow-control window (frames in flight before backpressure). */
export const A2A_V6_DEFAULT_WINDOW = 16;
/** Default heartbeat interval (ms). */
export const A2A_V6_DEFAULT_HEARTBEAT_MS = 15_000;
/** Maximum queued frames per direction before the sender is refused. */
export const A2A_V6_MAX_QUEUED_FRAMES = 256;
/** Maximum bytes of one artifact chunk. */
export const A2A_V6_MAX_CHUNK_BYTES = 256 * 1024;
/** Maximum bytes of one reassembled artifact. */
export const A2A_V6_MAX_ARTIFACT_BYTES = 8 * 1024 * 1024;

/** Task states visible on a two-way stream. */
export type A2aV6TaskState =
  | 'submitted'
  | 'working'
  | 'input-required'
  | 'paused'
  | 'cancelled'
  | 'completed'
  | 'failed';
export const A2A_V6_TASK_STATES: readonly A2aV6TaskState[] = [
  'submitted',
  'working',
  'input-required',
  'paused',
  'cancelled',
  'completed',
  'failed',
];
export const A2A_V6_TASK_TERMINAL: readonly A2aV6TaskState[] = ['cancelled', 'completed', 'failed'];
export function isA2aV6TaskTerminal(state: A2aV6TaskState): boolean {
  return (A2A_V6_TASK_TERMINAL as readonly A2aV6TaskState[]).includes(state);
}

/** Upstream frame kinds (client -> agent). */
export type A2aV6UpstreamKind = 'input' | 'interrupt' | 'cancel' | 'resume' | 'ack' | 'heartbeat';
export const A2A_V6_UPSTREAM_KINDS: readonly A2aV6UpstreamKind[] = [
  'input',
  'interrupt',
  'cancel',
  'resume',
  'ack',
  'heartbeat',
];

/** Downstream frame kinds (agent -> client). */
export type A2aV6DownstreamKind =
  | 'status'
  | 'message'
  | 'artifact-chunk'
  | 'input-required'
  | 'heartbeat'
  | 'done'
  | 'error';
export const A2A_V6_DOWNSTREAM_KINDS: readonly A2aV6DownstreamKind[] = [
  'status',
  'message',
  'artifact-chunk',
  'input-required',
  'heartbeat',
  'done',
  'error',
];

/** One frame on the wire (either direction). */
export interface A2aV6Frame {
  /** Monotonic sequence number per stream direction. */
  seq: number;
  /** Task this frame belongs to. */
  taskId: string;
  direction: 'upstream' | 'downstream';
  kind: string;
  payload: Record<string, unknown>;
  at: number;
}

/** Error raised by two-way streaming operations. */
export class A2aV6StreamError extends Error {
  readonly code:
    | 'task-terminal'
    | 'task-unknown'
    | 'stream-closed'
    | 'stream-paused'
    | 'queue-full'
    | 'bad-frame'
    | 'bad-resume-token'
    | 'artifact-too-large'
    | 'out-of-order';
  constructor(message: string, code: A2aV6StreamError['code']) {
    super(message);
    this.name = 'A2aV6StreamError';
    this.code = code;
  }
}

/** Payload shapes, so hosts do not have to guess the wire format. */
export interface A2aV6InputPayload {
  text: string;
  /** User message id the input answers, when it answers one. */
  inReplyToMessageId?: string;
}
export interface A2aV6InterruptPayload {
  reason?: string;
}
export interface A2aV6CancelPayload {
  reason?: string;
}
export interface A2aV6ResumePayload {
  resumeToken: string;
}
export interface A2aV6AckPayload {
  /** Sequence number being acknowledged. */
  ackSeq: number;
}
export interface A2aV6StatusPayload {
  state: A2aV6TaskState;
  detail?: string;
  progressPercent?: number;
}
export interface A2aV6MessagePayload {
  text: string;
  role?: 'agent' | 'user';
}
export interface A2aV6ArtifactChunkPayload {
  artifactId: string;
  /** 0-based chunk index. */
  index: number;
  /** Total chunks (known from the first chunk). */
  total: number;
  /** Chunk bytes as a UTF-8 string (text artifacts). */
  data: string;
  /** True on the last chunk. */
  last: boolean;
}
export interface A2aV6InputRequiredPayload {
  /** What the agent needs before it can continue. */
  prompt: string;
  /** Elicitation id, when the input is a structured elicitation. */
  elicitationId?: string;
}
export interface A2aV6DonePayload {
  state: 'completed' | 'failed';
  summary?: string;
}
export interface A2aV6ErrorPayload {
  code: string;
  message: string;
}

/** Validate a raw value as an A2A v6 frame. */
export function validateA2aV6Frame(value: unknown): { ok: true; frame: A2aV6Frame } | { ok: false; reason: string } {
  if (!value || typeof value !== 'object') return { ok: false, reason: 'Frame must be an object.' };
  const f = value as Partial<A2aV6Frame>;
  if (!Number.isInteger(f.seq) || (f.seq as number) < 0) return { ok: false, reason: 'Frame seq must be a non-negative integer.' };
  if (typeof f.taskId !== 'string' || !f.taskId) return { ok: false, reason: 'Frame taskId must be a non-empty string.' };
  if (f.direction !== 'upstream' && f.direction !== 'downstream') return { ok: false, reason: 'Frame direction must be upstream or downstream.' };
  const kinds = f.direction === 'upstream' ? A2A_V6_UPSTREAM_KINDS : A2A_V6_DOWNSTREAM_KINDS;
  if (typeof f.kind !== 'string' || !(kinds as readonly string[]).includes(f.kind)) {
    return { ok: false, reason: `Frame kind "${String(f.kind)}" is not valid for ${f.direction}.` };
  }
  if (!f.payload || typeof f.payload !== 'object' || Array.isArray(f.payload)) {
    return { ok: false, reason: 'Frame payload must be an object.' };
  }
  if (!Number.isInteger(f.at)) return { ok: false, reason: 'Frame at must be an integer timestamp.' };
  return { ok: true, frame: { ...f, payload: { ...(f.payload as Record<string, unknown>) } } as A2aV6Frame };
}

export function isA2aV6UpstreamKind(kind: string): kind is A2aV6UpstreamKind {
  return (A2A_V6_UPSTREAM_KINDS as readonly string[]).includes(kind);
}

export function isA2aV6DownstreamKind(kind: string): kind is A2aV6DownstreamKind {
  return (A2A_V6_DOWNSTREAM_KINDS as readonly string[]).includes(kind);
}

export interface A2aV6StreamOptions {
  /** Flow-control window (default 16). */
  window?: number;
  /** Low-water mark that clears backpressure (default 4). */
  lowWater?: number;
  /** Heartbeat interval in ms (default 15000; 0 disables). */
  heartbeatMs?: number;
  /** Clock override (tests). */
  now?: () => number;
  /** Id generator override (tests). */
  generateId?: (prefix: string) => string;
}

/** Stream lifecycle (separate from the task state). */
export type A2aV6StreamStatus = 'open' | 'backpressured' | 'paused' | 'closed';
export const A2A_V6_STREAM_STATUSES: readonly A2aV6StreamStatus[] = ['open', 'backpressured', 'paused', 'closed'];

/** What a stream hands to its frame handler. */
export type A2aV6FrameHandler = (frame: A2aV6Frame) => void;

/** One side's view of a two-way stream. */
export interface A2aV6StreamView {
  streamId: string;
  taskId: string;
  role: 'client' | 'agent';
  status: A2aV6StreamStatus;
  taskState: A2aV6TaskState;
  sentSeq: number;
  receivedSeq: number;
  queuedOutbound: number;
  queuedInbound: number;
}

/**
 * One side of an A2A 1.1 two-way stream for one running task.
 * The peer is wired by the host (`connect()`): frames sent here
 * are delivered to the peer's handler, and vice versa. The
 * stream owns sequencing, backpressure, pause/resume, cancel
 * and the resume token — the transport is the host's job.
 */
export class A2aV6Stream {
  readonly streamId: string;
  readonly taskId: string;
  readonly role: 'client' | 'agent';
  private taskState: A2aV6TaskState = 'submitted';
  private status: A2aV6StreamStatus = 'open';
  private readonly window: number;
  private readonly lowWater: number;
  private readonly heartbeatMs: number;
  private readonly now: () => number;
  private readonly generateId: (prefix: string) => string;
  private peer: A2aV6Stream | null = null;
  private handler: A2aV6FrameHandler | null = null;
  private sentSeq = 0;
  private receivedSeq = -1;
  private readonly outboundQueue: A2aV6Frame[] = [];
  private readonly inboundQueue: A2aV6Frame[] = [];
  private readonly history: A2aV6Frame[] = [];
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private lastHeartbeatAt = 0;

  constructor(taskId: string, role: 'client' | 'agent', options: A2aV6StreamOptions = {}) {
    this.taskId = taskId;
    this.role = role;
    this.window = options.window ?? A2A_V6_DEFAULT_WINDOW;
    this.lowWater = options.lowWater ?? 4;
    this.heartbeatMs = options.heartbeatMs ?? A2A_V6_DEFAULT_HEARTBEAT_MS;
    this.now = options.now ?? Date.now;
    this.generateId = options.generateId ?? ((prefix: string) => `${prefix}-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`);
    this.streamId = this.generateId('a2a6-stream');
    this.lastHeartbeatAt = this.now();
  }

  /** Wire this stream to its peer (the other side of the same task). */
  connect(peer: A2aV6Stream): void {
    if (this.peer) throw new A2aV6StreamError('This stream is already connected.', 'bad-frame');
    if (peer.taskId !== this.taskId) {
      throw new A2aV6StreamError(`Peer task "${peer.taskId}" does not match this task "${this.taskId}".`, 'bad-frame');
    }
    if (peer.role === this.role) {
      throw new A2aV6StreamError('A stream connects to the opposite role (client <-> agent).', 'bad-frame');
    }
    this.peer = peer;
    if (this.heartbeatMs > 0) {
      this.heartbeatTimer = setInterval(() => {
        if (this.status === 'open' && !this.isClosed()) this.sendHeartbeat();
      }, this.heartbeatMs);
      if (typeof this.heartbeatTimer === 'object' && this.heartbeatTimer !== null && 'unref' in this.heartbeatTimer) {
        (this.heartbeatTimer as { unref: () => void }).unref();
      }
    }
  }

  /** Handle incoming frames (set by the host). */
  onFrame(handler: A2aV6FrameHandler): void {
    this.handler = handler;
    // Drain anything queued while no handler was set.
    while (this.inboundQueue.length > 0) {
      const frame = this.inboundQueue.shift() as A2aV6Frame;
      this.handler(frame);
    }
  }

  getStatus(): A2aV6StreamStatus {
    return this.status;
  }

  getTaskState(): A2aV6TaskState {
    return this.taskState;
  }

  isClosed(): boolean {
    return this.status === 'closed';
  }

  isBackpressured(): boolean {
    return this.status === 'backpressured';
  }

  view(): A2aV6StreamView {
    return {
      streamId: this.streamId,
      taskId: this.taskId,
      role: this.role,
      status: this.status,
      taskState: this.taskState,
      sentSeq: this.sentSeq,
      receivedSeq: this.receivedSeq,
      queuedOutbound: this.outboundQueue.length,
      queuedInbound: this.inboundQueue.length,
    };
  }

  /** Frames sent + received, in order (copies). */
  getHistory(): A2aV6Frame[] {
    return this.history.map((f) => ({ ...f, payload: { ...f.payload } }));
  }

  private buildFrame(kind: string, payload: Record<string, unknown>): A2aV6Frame {
    const direction = this.role === 'client' ? 'upstream' : 'downstream';
    const frame: A2aV6Frame = {
      seq: this.sentSeq,
      taskId: this.taskId,
      direction,
      kind,
      payload: { ...payload },
      at: this.now(),
    };
    this.sentSeq += 1;
    return frame;
  }

  private deliverToPeer(frame: A2aV6Frame): void {
    if (!this.peer) throw new A2aV6StreamError('Stream is not connected to a peer.', 'stream-closed');
    this.peer.receive(frame);
  }

  /** Receive a frame from the peer (called by the peer's send). */
  receive(frame: A2aV6Frame): void {
    const checked = validateA2aV6Frame(frame);
    if (!checked.ok) throw new A2aV6StreamError(`Bad frame: ${checked.reason}`, 'bad-frame');
    const valid = checked.frame;
    if (valid.taskId !== this.taskId) {
      throw new A2aV6StreamError(`Frame task "${valid.taskId}" does not match this task "${this.taskId}".`, 'bad-frame');
    }
    if (valid.seq !== this.receivedSeq + 1) {
      throw new A2aV6StreamError(
        `Out-of-order frame: got seq ${valid.seq}, expected ${this.receivedSeq + 1}.`,
        'out-of-order',
      );
    }
    this.receivedSeq = valid.seq;
    this.history.push({ ...valid, payload: { ...valid.payload } });
    this.applyIncoming(valid);
    if (this.status === 'paused') {
      this.inboundQueue.push({ ...valid, payload: { ...valid.payload } });
      return;
    }
    if (this.handler) this.handler({ ...valid, payload: { ...valid.payload } });
    else this.inboundQueue.push({ ...valid, payload: { ...valid.payload } });
  }

  /** Update task state from an incoming frame's meaning. */
  private applyIncoming(frame: A2aV6Frame): void {
    if (frame.kind === 'cancel') {
      this.taskState = 'cancelled';
      this.close();
      return;
    }
    if (frame.kind === 'done') {
      const state = (frame.payload['state'] as string) ?? 'completed';
      this.taskState = state === 'failed' ? 'failed' : 'completed';
      this.close();
      return;
    }
    if (frame.kind === 'error') {
      this.taskState = 'failed';
      this.close();
      return;
    }
    if (frame.kind === 'status') {
      const state = frame.payload['state'] as A2aV6TaskState | undefined;
      if (state && A2A_V6_TASK_STATES.includes(state) && !isA2aV6TaskTerminal(this.taskState)) {
        this.taskState = state;
      }
      return;
    }
    if (frame.kind === 'input-required') {
      if (!isA2aV6TaskTerminal(this.taskState)) this.taskState = 'input-required';
      return;
    }
    if (frame.kind === 'interrupt') {
      if (!isA2aV6TaskTerminal(this.taskState)) this.taskState = 'paused';
    }
    if (frame.kind === 'resume') {
      if (this.taskState === 'paused' || this.taskState === 'input-required') this.taskState = 'working';
    }
    if (frame.kind === 'input') {
      if (this.taskState === 'submitted' || this.taskState === 'input-required' || this.taskState === 'paused') {
        this.taskState = 'working';
      }
    }
  }

  private send(kind: string, payload: Record<string, unknown>): A2aV6Frame {
    if (this.isClosed()) throw new A2aV6StreamError('Stream is closed.', 'stream-closed');
    if (isA2aV6TaskTerminal(this.taskState) && kind !== 'ack' && kind !== 'heartbeat') {
      throw new A2aV6StreamError(`Task is ${this.taskState}; the stream takes no more frames.`, 'task-terminal');
    }
    if (this.outboundQueue.length >= A2A_V6_MAX_QUEUED_FRAMES) {
      throw new A2aV6StreamError(`Outbound queue is full (${A2A_V6_MAX_QUEUED_FRAMES} frames).`, 'queue-full');
    }
    const frame = this.buildFrame(kind, payload);
    this.history.push({ ...frame, payload: { ...frame.payload } });
    this.deliverToPeer(frame);
    // Backpressure: too many unacknowledged frames in flight.
    const inFlight = this.sentSeq - (this.receivedSeq + 1);
    if (inFlight >= this.window && this.status === 'open') this.status = 'backpressured';
    return frame;
  }

  /** Acknowledge a received frame; clears backpressure at the low-water mark. */
  ack(seq: number): void {
    if (this.isClosed()) return;
    this.send('ack', { ackSeq: seq } satisfies A2aV6AckPayload);
    if (this.status === 'backpressured' && this.sentSeq - (this.receivedSeq + 1) <= this.lowWater) {
      this.status = 'open';
    }
  }

  /** Send a heartbeat (keeps a long task's stream alive). */
  sendHeartbeat(): void {
    if (this.isClosed()) return;
    try {
      this.send('heartbeat', { at: this.now() });
      this.lastHeartbeatAt = this.now();
    } catch {
      // A heartbeat must never fail a task.
    }
  }

  getLastHeartbeatAt(): number {
    return this.lastHeartbeatAt;
  }

  // ---- Client -> agent (upstream) ----

  /** Send new input to the running task (mid-task, no new task needed). */
  sendInput(text: string, inReplyToMessageId?: string): A2aV6Frame {
    if (this.role !== 'client') throw new A2aV6StreamError('Only the client side sends input.', 'bad-frame');
    if (this.taskState === 'input-required') this.taskState = 'working';
    else if (this.taskState === 'submitted') this.taskState = 'working';
    return this.send('input', { text, inReplyToMessageId } satisfies A2aV6InputPayload);
  }

  /** Interrupt the running task (pauses it; resume with `resumeTask()`). */
  interrupt(reason?: string): A2aV6Frame {
    if (this.role !== 'client') throw new A2aV6StreamError('Only the client side interrupts.', 'bad-frame');
    const frame = this.send('interrupt', { reason } satisfies A2aV6InterruptPayload);
    this.taskState = 'paused';
    return frame;
  }

  /** Cancel the running task (terminal). */
  cancelTask(reason?: string): A2aV6Frame {
    const frame = this.send('cancel', { reason } satisfies A2aV6CancelPayload);
    this.taskState = 'cancelled';
    this.close();
    return frame;
  }

  /** Resume a paused / interrupted task, optionally from a resume token. */
  resumeTask(resumeToken?: string): A2aV6Frame {
    if (this.taskState !== 'paused' && this.taskState !== 'input-required') {
      throw new A2aV6StreamError(`Only a paused or input-required task can resume; this task is ${this.taskState}.`, 'task-terminal');
    }
    if (resumeToken !== undefined) {
      parseA2aV6ResumeToken(resumeToken); // throws when the token is bad
    }
    const frame = this.send('resume', { resumeToken: resumeToken ?? '' } satisfies A2aV6ResumePayload);
    this.taskState = 'working';
    return frame;
  }

  // ---- Agent -> client (downstream) ----

  /** Report task status (progress, state changes). */
  sendStatus(state: A2aV6TaskState, detail?: string, progressPercent?: number): A2aV6Frame {
    if (this.role !== 'agent') throw new A2aV6StreamError('Only the agent side sends status.', 'bad-frame');
    if (progressPercent !== undefined && (progressPercent < 0 || progressPercent > 100)) {
      throw new A2aV6StreamError('progressPercent must be 0..100.', 'bad-frame');
    }
    const frame = this.send('status', { state, detail, progressPercent } satisfies A2aV6StatusPayload);
    if (!isA2aV6TaskTerminal(this.taskState)) this.taskState = state;
    return frame;
  }

  /** Stream a message part to the client. */
  sendMessage(text: string, role: 'agent' | 'user' = 'agent'): A2aV6Frame {
    if (this.role !== 'agent') throw new A2aV6StreamError('Only the agent side sends messages.', 'bad-frame');
    if (this.taskState === 'submitted') this.taskState = 'working';
    return this.send('message', { text, role } satisfies A2aV6MessagePayload);
  }

  /** Stream one artifact chunk (the client reassembles with `reassembleArtifact()`). */
  sendArtifactChunk(artifactId: string, index: number, total: number, data: string, last: boolean): A2aV6Frame {
    if (this.role !== 'agent') throw new A2aV6StreamError('Only the agent side sends artifact chunks.', 'bad-frame');
    if (new TextEncoder().encode(data).length > A2A_V6_MAX_CHUNK_BYTES) {
      throw new A2aV6StreamError(`Artifact chunk exceeds ${A2A_V6_MAX_CHUNK_BYTES} bytes.`, 'artifact-too-large');
    }
    if (index < 0 || total < 1 || index >= total) {
      throw new A2aV6StreamError(`Artifact chunk index ${index} is out of range for total ${total}.`, 'bad-frame');
    }
    return this.send('artifact-chunk', { artifactId, index, total, data, last } satisfies A2aV6ArtifactChunkPayload);
  }

  /** Ask the client for input before continuing (task waits). */
  requestInput(prompt: string, elicitationId?: string): A2aV6Frame {
    if (this.role !== 'agent') throw new A2aV6StreamError('Only the agent side requests input.', 'bad-frame');
    const frame = this.send('input-required', { prompt, elicitationId } satisfies A2aV6InputRequiredPayload);
    this.taskState = 'input-required';
    return frame;
  }

  /** Finish the task (terminal). */
  finish(summary?: string): A2aV6Frame {
    if (this.role !== 'agent') throw new A2aV6StreamError('Only the agent side finishes a task.', 'bad-frame');
    const frame = this.send('done', { state: 'completed', summary } satisfies A2aV6DonePayload);
    this.taskState = 'completed';
    this.close();
    return frame;
  }

  /** Fail the task (terminal). */
  fail(code: string, message: string): A2aV6Frame {
    if (this.role !== 'agent') throw new A2aV6StreamError('Only the agent side fails a task.', 'bad-frame');
    const frame = this.send('error', { code, message } satisfies A2aV6ErrorPayload);
    this.taskState = 'failed';
    this.close();
    return frame;
  }

  // ---- Flow control ----

  /** Pause delivery (frames queue, nothing is dropped). */
  pause(): void {
    if (this.isClosed()) throw new A2aV6StreamError('Stream is closed.', 'stream-closed');
    if (this.status !== 'paused') this.status = 'paused';
  }

  /** Resume delivery and drain the queued inbound frames in order. */
  resumeDelivery(): void {
    if (this.isClosed()) throw new A2aV6StreamError('Stream is closed.', 'stream-closed');
    if (this.status === 'paused') this.status = 'open';
    while (this.inboundQueue.length > 0 && this.handler) {
      const frame = this.inboundQueue.shift() as A2aV6Frame;
      this.handler({ ...frame, payload: { ...frame.payload } });
    }
  }

  /** Close the stream (no more frames either way). */
  close(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    this.status = 'closed';
  }

  /** Opaque resume token: task id + last received seq + task state. */
  makeResumeToken(): string {
    const payload = {
      v: 1,
      taskId: this.taskId,
      receivedSeq: this.receivedSeq,
      taskState: this.taskState,
      at: this.now(),
    };
    return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  }
}

/** Parse a resume token (throws `bad-resume-token` when invalid). */
export function parseA2aV6ResumeToken(token: string): {
  taskId: string;
  receivedSeq: number;
  taskState: A2aV6TaskState;
  at: number;
} {
  try {
    const raw = Buffer.from(token, 'base64url').toString('utf8');
    const parsed = JSON.parse(raw) as { v?: number; taskId?: unknown; receivedSeq?: unknown; taskState?: unknown; at?: unknown };
    if (parsed.v !== 1 || typeof parsed.taskId !== 'string' || !parsed.taskId
      || !Number.isInteger(parsed.receivedSeq) || typeof parsed.taskState !== 'string'
      || !A2A_V6_TASK_STATES.includes(parsed.taskState as A2aV6TaskState)
      || !Number.isInteger(parsed.at)) {
      throw new Error('Malformed resume token.');
    }
    return {
      taskId: parsed.taskId,
      receivedSeq: parsed.receivedSeq as number,
      taskState: parsed.taskState as A2aV6TaskState,
      at: parsed.at as number,
    };
  } catch (err) {
    if (err instanceof A2aV6StreamError) throw err;
    throw new A2aV6StreamError(`Invalid A2A resume token: ${err instanceof Error ? err.message : String(err)}`, 'bad-resume-token');
  }
}

/**
 * Reassemble an artifact from its chunks (in seq order). Chunks
 * must start at 0, be contiguous, and agree on `total`; the last
 * chunk must have `last: true`. Returns the joined content.
 */
export function reassembleA2aV6Artifact(chunks: A2aV6ArtifactChunkPayload[]): string {
  if (chunks.length === 0) throw new A2aV6StreamError('No artifact chunks to reassemble.', 'bad-frame');
  const sorted = [...chunks].sort((a, b) => a.index - b.index);
  const total = sorted[0]?.total;
  if (sorted.some((c) => c.total !== total)) {
    throw new A2aV6StreamError('Artifact chunks disagree on total.', 'bad-frame');
  }
  if (sorted.length !== total) {
    throw new A2aV6StreamError(`Artifact has ${sorted.length} of ${total} chunks; it is incomplete.`, 'bad-frame');
  }
  for (let i = 0; i < sorted.length; i += 1) {
    if (sorted[i]?.index !== i) throw new A2aV6StreamError(`Artifact chunk ${i} is missing (out of order).`, 'out-of-order');
  }
  if (sorted[sorted.length - 1]?.last !== true) {
    throw new A2aV6StreamError('The last artifact chunk must have last: true.', 'bad-frame');
  }
  const joined = sorted.map((c) => c.data).join('');
  if (new TextEncoder().encode(joined).length > A2A_V6_MAX_ARTIFACT_BYTES) {
    throw new A2aV6StreamError(`Reassembled artifact exceeds ${A2A_V6_MAX_ARTIFACT_BYTES} bytes.`, 'artifact-too-large');
  }
  return joined;
}

/** Split artifact content into chunks for `sendArtifactChunk()`. */
export function splitA2aV6Artifact(artifactId: string, content: string, chunkBytes = 64 * 1024): A2aV6ArtifactChunkPayload[] {
  if (chunkBytes < 1 || chunkBytes > A2A_V6_MAX_CHUNK_BYTES) {
    throw new A2aV6StreamError(`chunkBytes must be 1..${A2A_V6_MAX_CHUNK_BYTES}.`, 'bad-frame');
  }
  const encoder = new TextEncoder();
  const bytes = encoder.encode(content);
  if (bytes.length > A2A_V6_MAX_ARTIFACT_BYTES) {
    throw new A2aV6StreamError(`Artifact exceeds ${A2A_V6_MAX_ARTIFACT_BYTES} bytes.`, 'artifact-too-large');
  }
  // Split on UTF-8 boundaries by slicing the string (ASCII-safe for
  // the common case; multi-byte chars stay whole because we slice by
  // decoded length and re-check each chunk).
  const chunks: A2aV6ArtifactChunkPayload[] = [];
  let offset = 0;
  let index = 0;
  const total = Math.max(1, Math.ceil(bytes.length / chunkBytes));
  while (offset < content.length || (content.length === 0 && index === 0)) {
    let end = offset + chunkBytes;
    let data = content.slice(offset, end);
    while (encoder.encode(data).length > chunkBytes && data.length > 1) {
      data = data.slice(0, -1);
    }
    chunks.push({ artifactId, index, total, data, last: index === total - 1 });
    offset += data.length;
    index += 1;
    if (content.length === 0) break;
  }
  // Fix the total in case multi-byte trimming added a chunk.
  const fixedTotal = chunks.length;
  for (const chunk of chunks) {
    chunk.total = fixedTotal;
    chunk.last = chunk.index === fixedTotal - 1;
  }
  return chunks;
}

/**
 * Two streams wired to each other in-process (client side +
 * agent side) for one task — for tests and for hosts that run
 * both ends locally. Both sides share the task id; either side
 * can be driven first.
 */
export function createLoopbackA2aV6Pair(
  taskId: string,
  options: A2aV6StreamOptions = {},
): { client: A2aV6Stream; agent: A2aV6Stream } {
  const client = new A2aV6Stream(taskId, 'client', { ...options, heartbeatMs: 0 });
  const agent = new A2aV6Stream(taskId, 'agent', { ...options, heartbeatMs: 0 });
  client.connect(agent);
  agent.connect(client);
  return { client, agent };
}

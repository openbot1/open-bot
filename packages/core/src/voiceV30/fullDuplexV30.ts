/**
 * Realtime full-duplex engine v2 (v1.44, Team T4).
 *
 * v29 ran one turn at a time through the session: while the
 * agent spoke, user audio had nowhere to go, and a slow
 * consumer could stall the whole loop. v30 runs two
 * independent lanes at the same time:
 *
 *   - inbound lane (user -> agent): frames arrive through a
 *     jitter buffer (reordered by `atMs`, held up to
 *     `jitterBufferMs` so a late frame still lands in order),
 *     then drain into the turn detector. When the inbound
 *     queue is full the oldest frame is dropped (recorded,
 *     never silent) — backpressure, not a stall.
 *   - outbound lane (agent -> user): response chunks queue
 *     the same way; when full, the oldest chunk is dropped
 *     and the response is marked degraded.
 *
 * Both lanes active inside the same short window is
 * crosstalk (both parties talking at once): it is recorded
 * per turn, and a crosstalk storm (many overlapping windows
 * in a row) degrades the engine to half-duplex — the
 * outbound lane pauses until the user finishes — instead of
 * letting both sides talk over each other forever.
 *
 * Every turn is measured against two latency SLOs
 * (first-byte and total). Breaching the total SLO twice in
 * a row also degrades the engine. Recovery is explicit
 * (`recover()`), never automatic mid-turn, so a flapping
 * engine cannot oscillate.
 *
 * All clocks virtual (the caller passes `atMs`); all audio
 * is mock/synthetic frame energy; no provider is dialled.
 */

import {
  VOICE_V30_DUPLEX_CROSSTALK_WINDOW_MS_DEFAULT,
  VOICE_V30_DUPLEX_FIRST_BYTE_SLO_MS_DEFAULT,
  VOICE_V30_DUPLEX_INBOUND_QUEUE_MAX_DEFAULT,
  VOICE_V30_DUPLEX_JITTER_BUFFER_MS_DEFAULT,
  VOICE_V30_DUPLEX_OUTBOUND_QUEUE_MAX_DEFAULT,
  VOICE_V30_DUPLEX_TOTAL_SLO_MS_DEFAULT,
  type VoiceV30DegradationReason,
  type VoiceV30DuplexTurn,
  type VoiceV30Lane,
  type VoiceV30LaneFrame,
  type VoiceV30LaneState,
  type VoiceV30PipelineMode,
} from './types';

export interface FullDuplexEngineV30Options {
  /** Max inbound frames queued (oldest dropped past this). */
  inboundQueueMax?: number;
  /** Max outbound chunks queued (oldest dropped past this). */
  outboundQueueMax?: number;
  /** How long (ms) the jitter buffer holds frames for reordering. */
  jitterBufferMs?: number;
  /** First-byte latency SLO (ms). */
  firstByteSloMs?: number;
  /** Total turn latency SLO (ms). */
  totalSloMs?: number;
  /** Window (ms) in which both lanes active counts as crosstalk. */
  crosstalkWindowMs?: number;
  /** Consecutive total-SLO breaches before degrading. */
  sloBreachToDegrade?: number;
  /** Consecutive crosstalk windows before degrading. */
  crosstalkToDegrade?: number;
  /** Max turns kept in history. */
  maxTurns?: number;
  /** Called when the engine degrades. */
  onDegraded?: (reason: VoiceV30DegradationReason, atMs: number) => void;
  /** Called when the engine recovers to full duplex. */
  onRecovered?: (atMs: number) => void;
}

export interface VoiceV30DuplexStats {
  degraded: boolean;
  degradationReason: VoiceV30DegradationReason | null;
  inboundQueued: number;
  outboundQueued: number;
  inboundState: VoiceV30LaneState;
  outboundState: VoiceV30LaneState;
  inboundDropped: number;
  outboundDropped: number;
  inboundReceived: number;
  outboundSent: number;
  jitterReordered: number;
  crosstalkWindows: number;
  turns: number;
  sloBreaches: number;
  avgFirstByteLatencyMs: number;
  avgTotalLatencyMs: number;
  p95TotalLatencyMs: number;
}

export interface VoiceV30DuplexReport {
  stats: VoiceV30DuplexStats;
  turns: VoiceV30DuplexTurn[];
  firstByteSloMs: number;
  totalSloMs: number;
}

export function defaultFullDuplexEngineV30Options(): FullDuplexEngineV30Options {
  return {
    inboundQueueMax: VOICE_V30_DUPLEX_INBOUND_QUEUE_MAX_DEFAULT,
    outboundQueueMax: VOICE_V30_DUPLEX_OUTBOUND_QUEUE_MAX_DEFAULT,
    jitterBufferMs: VOICE_V30_DUPLEX_JITTER_BUFFER_MS_DEFAULT,
    firstByteSloMs: VOICE_V30_DUPLEX_FIRST_BYTE_SLO_MS_DEFAULT,
    totalSloMs: VOICE_V30_DUPLEX_TOTAL_SLO_MS_DEFAULT,
    crosstalkWindowMs: VOICE_V30_DUPLEX_CROSSTALK_WINDOW_MS_DEFAULT,
    sloBreachToDegrade: 2,
    crosstalkToDegrade: 3,
    maxTurns: 1000,
  };
}

export class FullDuplexEngineV30 {
  private readonly inboundQueueMax: number;
  private readonly outboundQueueMax: number;
  private readonly jitterBufferMs: number;
  private readonly firstByteSloMs: number;
  private readonly totalSloMs: number;
  private readonly crosstalkWindowMs: number;
  private readonly sloBreachToDegrade: number;
  private readonly crosstalkToDegrade: number;
  private readonly maxTurns: number;
  private readonly onDegraded?: (reason: VoiceV30DegradationReason, atMs: number) => void;
  private readonly onRecovered?: (atMs: number) => void;

  private readonly inboundQueue: VoiceV30LaneFrame[] = [];
  private readonly outboundQueue: VoiceV30LaneFrame[] = [];
  private inboundSeq = 0;
  private outboundSeq = 0;
  private inboundState: VoiceV30LaneState = 'idle';
  private outboundState: VoiceV30LaneState = 'idle';
  private inboundDropped = 0;
  private outboundDropped = 0;
  private inboundReceived = 0;
  private outboundSent = 0;
  private jitterReordered = 0;
  private crosstalkWindows = 0;
  private consecutiveCrosstalk = 0;
  private consecutiveSloBreaches = 0;
  private sloBreaches = 0;
  private degraded = false;
  private degradationReason: VoiceV30DegradationReason | null = null;
  private lastInboundAtMs: number | null = null;
  private lastOutboundAtMs: number | null = null;
  /** Newest atMs already drained from the inbound lane (late-frame cutoff). */
  private drainedWatermark: number | null = null;
  private readonly turns: VoiceV30DuplexTurn[] = [];
  private turnCount = 0;
  private currentTurn: {
    id: string;
    mode: VoiceV30PipelineMode;
    startedAtMs: number;
    firstByteAtMs: number | null;
    crosstalk: boolean;
    droppedAtStart: number;
  } | null = null;

  constructor(opts: FullDuplexEngineV30Options = {}) {
    const d = defaultFullDuplexEngineV30Options();
    this.inboundQueueMax = Math.max(1, opts.inboundQueueMax ?? d.inboundQueueMax ?? 200);
    this.outboundQueueMax = Math.max(1, opts.outboundQueueMax ?? d.outboundQueueMax ?? 200);
    this.jitterBufferMs = Math.max(0, opts.jitterBufferMs ?? d.jitterBufferMs ?? 120);
    this.firstByteSloMs = Math.max(1, opts.firstByteSloMs ?? d.firstByteSloMs ?? 500);
    this.totalSloMs = Math.max(1, opts.totalSloMs ?? d.totalSloMs ?? 900);
    this.crosstalkWindowMs = Math.max(0, opts.crosstalkWindowMs ?? d.crosstalkWindowMs ?? 300);
    this.sloBreachToDegrade = Math.max(1, opts.sloBreachToDegrade ?? d.sloBreachToDegrade ?? 2);
    this.crosstalkToDegrade = Math.max(1, opts.crosstalkToDegrade ?? d.crosstalkToDegrade ?? 3);
    this.maxTurns = Math.max(1, opts.maxTurns ?? d.maxTurns ?? 1000);
    this.onDegraded = opts.onDegraded;
    this.onRecovered = opts.onRecovered;
  }

  isDegraded(): boolean {
    return this.degraded;
  }

  getDegradationReason(): VoiceV30DegradationReason | null {
    return this.degradationReason;
  }

  /** Force degraded mode (e.g. the host measured overload elsewhere). */
  degrade(reason: VoiceV30DegradationReason, atMs: number): void {
    if (this.degraded) return;
    this.degraded = true;
    this.degradationReason = reason;
    this.outboundState = 'stalled';
    this.onDegraded?.(reason, atMs);
  }

  /** Return to full duplex. Queues are kept; the caller drains them. */
  recover(atMs: number): boolean {
    if (!this.degraded) return false;
    this.degraded = false;
    this.degradationReason = null;
    this.consecutiveSloBreaches = 0;
    this.consecutiveCrosstalk = 0;
    this.outboundState = this.outboundQueue.length > 0 ? 'active' : 'idle';
    this.onRecovered?.(atMs);
    return true;
  }

  /**
   * Push one inbound (user) frame. The jitter buffer reorders
   * by `atMs`: a frame that arrives late but within the buffer
   * window is inserted in order (counted as reordered); only
   * a frame older than the newest *drained* frame is too late
   * and is dropped. When the queue is full the oldest frame
   * is dropped.
   */
  pushInbound(atMs: number, energy: number, text: string | null = null): VoiceV30LaneFrame {
    this.inboundReceived += 1;
    this.lastInboundAtMs = atMs;
    const frame: VoiceV30LaneFrame = { atMs, energy, text, seq: this.inboundSeq += 1 };
    // Too late: older than the newest frame already drained.
    if (this.drainedWatermark !== null && atMs < this.drainedWatermark) {
      this.inboundDropped += 1;
      return frame;
    }
    // Insert in timestamp order (jitter buffer).
    let insertAt = this.inboundQueue.length;
    for (let i = this.inboundQueue.length - 1; i >= 0; i -= 1) {
      if (this.inboundQueue[i].atMs <= atMs) {
        insertAt = i + 1;
        break;
      }
      insertAt = i;
    }
    this.inboundQueue.splice(insertAt, 0, frame);
    if (insertAt < this.inboundQueue.length - 1) this.jitterReordered += 1;
    if (this.inboundQueue.length > this.inboundQueueMax) {
      this.inboundQueue.shift();
      this.inboundDropped += 1;
    }
    this.inboundState = this.inboundQueue.length >= this.inboundQueueMax ? 'backpressured' : 'active';
    this.noteCrosstalk();
    return frame;
  }

  /**
   * Push one outbound (agent) chunk. In degraded mode the
   * outbound lane is stalled: chunks are refused (the caller
   * keeps them for the resume) instead of queueing silently.
   */
  pushOutbound(atMs: number, energy: number, text: string | null = null): VoiceV30LaneFrame | null {
    if (this.degraded) return null;
    this.outboundSent += 1;
    this.lastOutboundAtMs = atMs;
    const frame: VoiceV30LaneFrame = { atMs, energy, text, seq: this.outboundSeq += 1 };
    this.outboundQueue.push(frame);
    if (this.outboundQueue.length > this.outboundQueueMax) {
      this.outboundQueue.shift();
      this.outboundDropped += 1;
    }
    this.outboundState = this.outboundQueue.length >= this.outboundQueueMax ? 'backpressured' : 'active';
    this.noteCrosstalk();
    return frame;
  }

  /** Drain up to `maxFrames` inbound frames in timestamp order. */
  drainInbound(maxFrames: number): VoiceV30LaneFrame[] {
    const out = this.inboundQueue.splice(0, Math.max(0, maxFrames));
    for (const f of out) {
      if (this.drainedWatermark === null || f.atMs > this.drainedWatermark) this.drainedWatermark = f.atMs;
    }
    if (this.inboundQueue.length === 0) this.inboundState = 'drained';
    else if (this.inboundQueue.length < this.inboundQueueMax) this.inboundState = 'active';
    return out.map((f) => ({ ...f }));
  }

  /** Drain up to `maxFrames` outbound chunks in order. */
  drainOutbound(maxFrames: number): VoiceV30LaneFrame[] {
    const out = this.outboundQueue.splice(0, Math.max(0, maxFrames));
    if (this.outboundQueue.length === 0) this.outboundState = this.degraded ? 'stalled' : 'drained';
    else if (this.outboundQueue.length < this.outboundQueueMax) this.outboundState = 'active';
    return out.map((f) => ({ ...f }));
  }

  inboundDepth(): number {
    return this.inboundQueue.length;
  }

  outboundDepth(): number {
    return this.outboundQueue.length;
  }

  laneState(lane: VoiceV30Lane): VoiceV30LaneState {
    return lane === 'inbound' ? this.inboundState : this.outboundState;
  }

  /** Start measuring one pipeline turn (STT -> LLM -> TTS or S2S). */
  startTurn(mode: VoiceV30PipelineMode, atMs: number): string {
    this.turnCount += 1;
    const id = `duplex-turn-${this.turnCount}`;
    this.currentTurn = {
      id,
      mode,
      startedAtMs: atMs,
      firstByteAtMs: null,
      crosstalk: this.lastInboundAtMs !== null && this.lastOutboundAtMs !== null &&
        Math.abs(this.lastInboundAtMs - this.lastOutboundAtMs) <= this.crosstalkWindowMs,
      droppedAtStart: this.inboundDropped + this.outboundDropped,
    };
    return id;
  }

  /** Mark the first byte of agent audio for the current turn. */
  markFirstByte(atMs: number): void {
    if (this.currentTurn && this.currentTurn.firstByteAtMs === null) {
      this.currentTurn.firstByteAtMs = atMs;
    }
  }

  /** Finish the current turn; returns the measured turn. */
  endTurn(atMs: number): VoiceV30DuplexTurn | null {
    const cur = this.currentTurn;
    if (!cur) return null;
    this.currentTurn = null;
    const firstByteLatencyMs = cur.firstByteAtMs === null ? null : Math.max(0, cur.firstByteAtMs - cur.startedAtMs);
    const totalLatencyMs = Math.max(0, atMs - cur.startedAtMs);
    const withinFirstByteSlo = firstByteLatencyMs === null || firstByteLatencyMs <= this.firstByteSloMs;
    const withinTotalSlo = totalLatencyMs <= this.totalSloMs;
    const turn: VoiceV30DuplexTurn = {
      id: cur.id,
      mode: cur.mode,
      startedAtMs: cur.startedAtMs,
      firstByteAtMs: cur.firstByteAtMs,
      endedAtMs: atMs,
      firstByteLatencyMs,
      totalLatencyMs,
      withinFirstByteSlo,
      withinTotalSlo,
      crosstalk: cur.crosstalk,
      droppedFrames: this.inboundDropped + this.outboundDropped - cur.droppedAtStart,
    };
    this.turns.push(turn);
    if (this.turns.length > this.maxTurns) this.turns.splice(0, this.turns.length - this.maxTurns);
    if (!withinTotalSlo) {
      this.sloBreaches += 1;
      this.consecutiveSloBreaches += 1;
      if (this.consecutiveSloBreaches >= this.sloBreachToDegrade && !this.degraded) {
        this.degrade('latency-slo-breach', atMs);
      }
    } else {
      this.consecutiveSloBreaches = 0;
    }
    return { ...turn };
  }

  /** Cancel the current turn without recording it. */
  cancelTurn(): boolean {
    if (!this.currentTurn) return false;
    this.currentTurn = null;
    return true;
  }

  turnsSoFar(): VoiceV30DuplexTurn[] {
    return this.turns.map((t) => ({ ...t }));
  }

  lastTurn(): VoiceV30DuplexTurn | null {
    const last = this.turns[this.turns.length - 1];
    return last ? { ...last } : null;
  }

  stats(): VoiceV30DuplexStats {
    const firstBytes = this.turns.map((t) => t.firstByteLatencyMs).filter((v): v is number => v !== null);
    const totals = this.turns.map((t) => t.totalLatencyMs);
    const sortedTotals = [...totals].sort((a, b) => a - b);
    const p95 = sortedTotals.length === 0 ? 0 : sortedTotals[Math.min(sortedTotals.length - 1, Math.floor(0.95 * sortedTotals.length))];
    return {
      degraded: this.degraded,
      degradationReason: this.degradationReason,
      inboundQueued: this.inboundQueue.length,
      outboundQueued: this.outboundQueue.length,
      inboundState: this.inboundState,
      outboundState: this.outboundState,
      inboundDropped: this.inboundDropped,
      outboundDropped: this.outboundDropped,
      inboundReceived: this.inboundReceived,
      outboundSent: this.outboundSent,
      jitterReordered: this.jitterReordered,
      crosstalkWindows: this.crosstalkWindows,
      turns: this.turns.length,
      sloBreaches: this.sloBreaches,
      avgFirstByteLatencyMs: firstBytes.length === 0 ? 0 : Math.round(firstBytes.reduce((a, b) => a + b, 0) / firstBytes.length),
      avgTotalLatencyMs: totals.length === 0 ? 0 : Math.round(totals.reduce((a, b) => a + b, 0) / totals.length),
      p95TotalLatencyMs: p95,
    };
  }

  report(): VoiceV30DuplexReport {
    return {
      stats: this.stats(),
      turns: this.turnsSoFar(),
      firstByteSloMs: this.firstByteSloMs,
      totalSloMs: this.totalSloMs,
    };
  }

  /** Markdown summary of the duplex engine state. */
  toMarkdown(): string {
    const s = this.stats();
    const lines = [
      '# Full-duplex v2 report (v30)',
      '',
      `- State: ${s.degraded ? `degraded (${s.degradationReason ?? 'unknown'})` : 'full duplex'}`,
      `- Inbound: ${s.inboundQueued} queued, ${s.inboundReceived} received, ${s.inboundDropped} dropped (${s.jitterReordered} reordered)`,
      `- Outbound: ${s.outboundQueued} queued, ${s.outboundSent} sent, ${s.outboundDropped} dropped`,
      `- Crosstalk windows: ${s.crosstalkWindows}`,
      `- Turns: ${s.turns}, SLO breaches: ${s.sloBreaches}`,
      `- Latency: avg first byte ${s.avgFirstByteLatencyMs} ms (SLO ${this.firstByteSloMs}), avg total ${s.avgTotalLatencyMs} ms, p95 total ${s.p95TotalLatencyMs} ms (SLO ${this.totalSloMs})`,
    ];
    return lines.join('\n');
  }

  reset(): void {
    this.inboundQueue.length = 0;
    this.outboundQueue.length = 0;
    this.inboundSeq = 0;
    this.outboundSeq = 0;
    this.inboundState = 'idle';
    this.outboundState = 'idle';
    this.inboundDropped = 0;
    this.outboundDropped = 0;
    this.inboundReceived = 0;
    this.outboundSent = 0;
    this.jitterReordered = 0;
    this.crosstalkWindows = 0;
    this.consecutiveCrosstalk = 0;
    this.consecutiveSloBreaches = 0;
    this.sloBreaches = 0;
    this.degraded = false;
    this.degradationReason = null;
    this.lastInboundAtMs = null;
    this.lastOutboundAtMs = null;
    this.drainedWatermark = null;
    this.turns.length = 0;
    this.turnCount = 0;
    this.currentTurn = null;
  }

  /**
   * Both lanes active inside the crosstalk window: count the
   * window, and degrade after enough consecutive windows.
   */
  private noteCrosstalk(): void {
    if (this.lastInboundAtMs === null || this.lastOutboundAtMs === null) return;
    if (Math.abs(this.lastInboundAtMs - this.lastOutboundAtMs) > this.crosstalkWindowMs) {
      this.consecutiveCrosstalk = 0;
      return;
    }
    this.crosstalkWindows += 1;
    this.consecutiveCrosstalk += 1;
    if (this.consecutiveCrosstalk >= this.crosstalkToDegrade && !this.degraded) {
      this.degrade('crosstalk-storm', this.lastOutboundAtMs);
    }
  }
}

export function createFullDuplexEngineV30(opts: FullDuplexEngineV30Options = {}): FullDuplexEngineV30 {
  return new FullDuplexEngineV30(opts);
}

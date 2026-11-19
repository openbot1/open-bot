/**
 * Per-tool-call timers for voice v24 (v1.37, Team T5).
 *
 * While a bot runs a voice session it calls tools (search,
 * calendar, files, ...). The operator used to see only the
 * session total; v24 gives every call its own timer:
 *
 *   - start() when the call is issued, end()/fail()/cancel()
 *     when it returns — the record keeps start, end and
 *     duration, so the UI can show a live running timer per
 *     call and a finished duration per call;
 *   - per-tool aggregates (count / mean / p50 / p95 / max /
 *     errors / slow calls) so the slowest tool in the session
 *     is visible, not guessed;
 *   - per-session aggregates (total calls, total tool time,
 *     slowest call, per-tool breakdown) for the session row;
 *   - threshold alerts: a call that runs past `slowThresholdMs`
 *     raises a `slow` alert, past `timeoutMs` a `timeout`
 *     alert, and 3 failed calls of the same tool in one
 *     session raise an `error-burst` alert — the UI can flag
 *     the call the moment it crosses the line, without
 *     waiting for it to finish (see `checkRunning`).
 *
 * All clocks virtual (the caller passes `atMs`); nothing
 * here touches audio, network or a provider.
 */
import {
  clampV24,
  durationBucketV24,
  formatDurationV24,
  isValidVoiceV24Id,
  meanV24,
  percentileV24,
  round2V24,
  VOICE_V24_SLOW_DEFAULT_MS,
  VOICE_V24_TIMEOUT_DEFAULT_MS,
  type VoiceV24DurationBucket,
  type VoiceV24TimerAlert,
  type VoiceV24TimerAlertKind,
  type VoiceV24ToolCallRecord,
  type VoiceV24ToolCallStatus,
} from './types';

export interface ToolCallTimerV24Options {
  /** A finished call past this is `slow` (default 5000 ms). */
  slowThresholdMs: number;
  /** A finished call past this is a `timeout` (default 30000 ms). */
  timeoutMs: number;
  /** Max records kept per registry (oldest finished dropped, default 1000). */
  maxRecords: number;
  /** Failed calls of one tool in one session that raise error-burst (default 3). */
  errorBurstCount: number;
}

export function defaultToolCallTimerV24Options(): ToolCallTimerV24Options {
  return {
    slowThresholdMs: VOICE_V24_SLOW_DEFAULT_MS,
    timeoutMs: VOICE_V24_TIMEOUT_DEFAULT_MS,
    maxRecords: 1000,
    errorBurstCount: 3,
  };
}

export function validateToolCallTimerV24Options(
  o: Partial<ToolCallTimerV24Options>,
): string[] {
  const errors: string[] = [];
  if (o.slowThresholdMs !== undefined && !(o.slowThresholdMs > 0 && o.slowThresholdMs <= 600000)) {
    errors.push('slowThresholdMs must be > 0 and <= 600000');
  }
  if (o.timeoutMs !== undefined && !(o.timeoutMs > 0 && o.timeoutMs <= 3600000)) {
    errors.push('timeoutMs must be > 0 and <= 3600000');
  }
  if (
    o.slowThresholdMs !== undefined &&
    o.timeoutMs !== undefined &&
    o.timeoutMs <= o.slowThresholdMs
  ) {
    errors.push('timeoutMs must be greater than slowThresholdMs');
  }
  if (o.maxRecords !== undefined && (!Number.isInteger(o.maxRecords) || o.maxRecords < 10 || o.maxRecords > 100000)) {
    errors.push('maxRecords must be an integer 10..100000');
  }
  if (o.errorBurstCount !== undefined && (!Number.isInteger(o.errorBurstCount) || o.errorBurstCount < 2 || o.errorBurstCount > 20)) {
    errors.push('errorBurstCount must be an integer 2..20');
  }
  return errors;
}

/** Aggregate over the finished calls of one tool. */
export interface VoiceV24ToolStats {
  toolName: string;
  calls: number;
  completed: number;
  failed: number;
  cancelled: number;
  timeouts: number;
  running: number;
  meanMs: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
  totalMs: number;
  slowCalls: number;
  /** 0..1 share of finished calls that were slow. */
  slowRate: number;
}

/** Aggregate over all calls of one session. */
export interface VoiceV24SessionTimerStats {
  sessionId: string;
  calls: number;
  running: number;
  completed: number;
  failed: number;
  totalMs: number;
  meanMs: number;
  p95Ms: number;
  slowest: VoiceV24ToolCallRecord | null;
  slowCalls: number;
  timeoutCalls: number;
  alerts: number;
  /** Per-tool breakdown, slowest tool first. */
  byTool: VoiceV24ToolStats[];
}

/** One live running call, as the UI row renders it. */
export interface VoiceV24RunningCall {
  record: VoiceV24ToolCallRecord;
  elapsedMs: number;
  bucket: VoiceV24DurationBucket;
  /** True once the call has crossed the slow threshold while running. */
  overSlowThreshold: boolean;
  /** True once the call has crossed the timeout while running. */
  overTimeout: boolean;
}

export function createToolCallTimerRegistryV24(
  opts: Partial<ToolCallTimerV24Options> = {},
): ToolCallTimerRegistryV24 {
  return new ToolCallTimerRegistryV24(opts);
}

export class ToolCallTimerRegistryV24 {
  private readonly opts: ToolCallTimerV24Options;
  private readonly records = new Map<string, VoiceV24ToolCallRecord>();
  private readonly order: string[] = [];
  private readonly alerts: VoiceV24TimerAlert[] = [];
  private readonly alertedSlow = new Set<string>();
  private readonly alertedTimeout = new Set<string>();
  private readonly alertedErrorBurst = new Set<string>();
  private seq = 0;
  private alertSeq = 0;

  constructor(opts: Partial<ToolCallTimerV24Options> = {}) {
    const errors = validateToolCallTimerV24Options(opts);
    if (errors.length > 0) {
      throw new Error(`Invalid ToolCallTimerRegistryV24 options: ${errors.join('; ')}`);
    }
    const merged = { ...defaultToolCallTimerV24Options(), ...opts };
    if (merged.timeoutMs <= merged.slowThresholdMs) {
      throw new Error('Invalid ToolCallTimerRegistryV24 options: timeoutMs must be greater than slowThresholdMs');
    }
    this.opts = merged;
  }

  options(): ToolCallTimerV24Options {
    return { ...this.opts };
  }

  /** Start a timer for one tool call. Returns the record id. */
  start(sessionId: string, toolName: string, atMs: number, turnIndex = 0): string {
    if (!isValidVoiceV24Id(sessionId)) throw new Error(`Invalid sessionId "${sessionId}"`);
    if (typeof toolName !== 'string' || toolName.length === 0) {
      throw new Error('toolName must be a non-empty string');
    }
    if (!Number.isFinite(atMs) || atMs < 0) throw new Error('atMs must be a finite number >= 0');
    if (!Number.isInteger(turnIndex) || turnIndex < 0) {
      throw new Error('turnIndex must be an integer >= 0');
    }
    this.seq += 1;
    const id = `tc-${this.seq}`;
    const record: VoiceV24ToolCallRecord = {
      id,
      sessionId,
      toolName,
      turnIndex,
      startedAtMs: atMs,
      endedAtMs: null,
      durationMs: null,
      status: 'running',
    };
    this.records.set(id, record);
    this.order.push(id);
    this.prune();
    return id;
  }

  /** Finish a call successfully. Returns the finished record. */
  end(id: string, atMs: number): VoiceV24ToolCallRecord {
    return this.finish(id, atMs, 'completed');
  }

  /** Finish a call as failed, keeping the error text on the record. */
  fail(id: string, atMs: number, error: string): VoiceV24ToolCallRecord {
    const record = this.finish(id, atMs, 'failed');
    record.error = error;
    this.maybeErrorBurstAlert(record);
    return record;
  }

  /** Finish a call as cancelled (user / session stopped it). */
  cancel(id: string, atMs: number): VoiceV24ToolCallRecord {
    return this.finish(id, atMs, 'cancelled');
  }

  private finish(id: string, atMs: number, status: VoiceV24ToolCallStatus): VoiceV24ToolCallRecord {
    const record = this.records.get(id);
    if (record === undefined) throw new Error(`No tool call "${id}"`);
    if (record.status !== 'running') {
      throw new Error(`Tool call "${id}" already finished (${record.status})`);
    }
    if (atMs < record.startedAtMs) {
      throw new Error(`end atMs ${atMs} is before start ${record.startedAtMs}`);
    }
    record.endedAtMs = atMs;
    record.durationMs = atMs - record.startedAtMs;
    record.status = status;
    if (status === 'completed' || status === 'failed') {
      this.maybeThresholdAlerts(record);
    }
    return { ...record };
  }

  private maybeThresholdAlerts(record: VoiceV24ToolCallRecord): void {
    const durationMs = record.durationMs ?? 0;
    if (durationMs >= this.opts.timeoutMs && !this.alertedTimeout.has(record.id)) {
      this.alertedTimeout.add(record.id);
      this.raiseAlert(record, 'timeout', this.opts.timeoutMs, durationMs);
      return;
    }
    if (durationMs >= this.opts.slowThresholdMs && !this.alertedSlow.has(record.id)) {
      this.alertedSlow.add(record.id);
      this.raiseAlert(record, 'slow', this.opts.slowThresholdMs, durationMs);
    }
  }

  private maybeErrorBurstAlert(record: VoiceV24ToolCallRecord): void {
    const key = `${record.sessionId}:${record.toolName}`;
    if (this.alertedErrorBurst.has(key)) return;
    const failures = this.list({ sessionId: record.sessionId, toolName: record.toolName }).filter(
      (r) => r.status === 'failed',
    ).length;
    if (failures >= this.opts.errorBurstCount) {
      this.alertedErrorBurst.add(key);
      this.alertSeq += 1;
      this.alerts.push({
        id: `alert-${this.alertSeq}`,
        callId: record.id,
        sessionId: record.sessionId,
        toolName: record.toolName,
        kind: 'error-burst',
        thresholdMs: this.opts.errorBurstCount,
        durationMs: failures,
        atMs: record.endedAtMs ?? record.startedAtMs,
        message: `${record.toolName} failed ${failures} times in session ${record.sessionId}`,
      });
    }
  }

  private raiseAlert(
    record: VoiceV24ToolCallRecord,
    kind: VoiceV24TimerAlertKind,
    thresholdMs: number,
    durationMs: number,
  ): void {
    this.alertSeq += 1;
    const label = kind === 'timeout' ? 'timed out' : 'ran slow';
    this.alerts.push({
      id: `alert-${this.alertSeq}`,
      callId: record.id,
      sessionId: record.sessionId,
      toolName: record.toolName,
      kind,
      thresholdMs,
      durationMs,
      atMs: record.endedAtMs ?? record.startedAtMs,
      message:
        `${record.toolName} ${label} after ${formatDurationV24(durationMs)} ` +
        `(threshold ${formatDurationV24(thresholdMs)}) in session ${record.sessionId}`,
    });
  }

  /**
   * Check running calls against the thresholds at `atMs` and
   * raise alerts for any that crossed a line while still
   * running — the UI does not have to wait for the call to
   * finish to flag it. Returns the newly raised alerts.
   */
  checkRunning(atMs: number): VoiceV24TimerAlert[] {
    const raised: VoiceV24TimerAlert[] = [];
    for (const record of this.records.values()) {
      if (record.status !== 'running') continue;
      const elapsed = atMs - record.startedAtMs;
      if (elapsed < 0) continue;
      const timedOut = elapsed >= this.opts.timeoutMs && !this.alertedTimeout.has(record.id);
      const slow = elapsed >= this.opts.slowThresholdMs && !this.alertedSlow.has(record.id);
      if (timedOut) {
        this.alertedTimeout.add(record.id);
        const alert = this.liveAlert(record, 'timeout', this.opts.timeoutMs, elapsed, atMs);
        raised.push(alert);
      } else if (slow) {
        this.alertedSlow.add(record.id);
        const alert = this.liveAlert(record, 'slow', this.opts.slowThresholdMs, elapsed, atMs);
        raised.push(alert);
      }
    }
    return raised;
  }

  private liveAlert(
    record: VoiceV24ToolCallRecord,
    kind: VoiceV24TimerAlertKind,
    thresholdMs: number,
    elapsedMs: number,
    atMs: number,
  ): VoiceV24TimerAlert {
    this.alertSeq += 1;
    const alert: VoiceV24TimerAlert = {
      id: `alert-${this.alertSeq}`,
      callId: record.id,
      sessionId: record.sessionId,
      toolName: record.toolName,
      kind,
      thresholdMs,
      durationMs: elapsedMs,
      atMs,
      message:
        `${record.toolName} still running after ${formatDurationV24(elapsedMs)} ` +
        `(threshold ${formatDurationV24(thresholdMs)}) in session ${record.sessionId}`,
    };
    this.alerts.push(alert);
    return alert;
  }

  get(id: string): VoiceV24ToolCallRecord | null {
    const record = this.records.get(id);
    return record === undefined ? null : { ...record };
  }

  list(filter: { sessionId?: string; toolName?: string; status?: VoiceV24ToolCallStatus } = {}): VoiceV24ToolCallRecord[] {
    const out: VoiceV24ToolCallRecord[] = [];
    for (const id of this.order) {
      const record = this.records.get(id);
      if (record === undefined) continue;
      if (filter.sessionId !== undefined && record.sessionId !== filter.sessionId) continue;
      if (filter.toolName !== undefined && record.toolName !== filter.toolName) continue;
      if (filter.status !== undefined && record.status !== filter.status) continue;
      out.push({ ...record });
    }
    return out;
  }

  /** Live running calls, with elapsed time and threshold state for the UI row. */
  running(sessionId?: string, atMs = 0): VoiceV24RunningCall[] {
    const out: VoiceV24RunningCall[] = [];
    for (const record of this.list({ status: 'running' })) {
      if (sessionId !== undefined && record.sessionId !== sessionId) continue;
      const elapsedMs = Math.max(0, atMs - record.startedAtMs);
      out.push({
        record,
        elapsedMs,
        bucket: durationBucketV24(elapsedMs, this.opts.slowThresholdMs, this.opts.timeoutMs),
        overSlowThreshold: elapsedMs >= this.opts.slowThresholdMs,
        overTimeout: elapsedMs >= this.opts.timeoutMs,
      });
    }
    return out;
  }

  /** Per-tool aggregate over finished calls (optionally one session). */
  toolStats(toolName: string, sessionId?: string): VoiceV24ToolStats {
    const calls = this.list({ toolName, sessionId });
    const finished = calls.filter((r) => r.durationMs !== null);
    const durations = finished.map((r) => r.durationMs as number);
    const slowCalls = finished.filter((r) => (r.durationMs ?? 0) >= this.opts.slowThresholdMs).length;
    return {
      toolName,
      calls: calls.length,
      completed: calls.filter((r) => r.status === 'completed').length,
      failed: calls.filter((r) => r.status === 'failed').length,
      cancelled: calls.filter((r) => r.status === 'cancelled').length,
      timeouts: calls.filter((r) => (r.durationMs ?? 0) >= this.opts.timeoutMs && r.status !== 'running').length,
      running: calls.filter((r) => r.status === 'running').length,
      meanMs: round2V24(meanV24(durations)),
      p50Ms: round2V24(percentileV24(durations, 50)),
      p95Ms: round2V24(percentileV24(durations, 95)),
      maxMs: durations.length === 0 ? 0 : Math.max(...durations),
      totalMs: durations.reduce((a, b) => a + b, 0),
      slowCalls,
      slowRate: finished.length === 0 ? 0 : round2V24(slowCalls / finished.length),
    };
  }

  /** All per-tool aggregates, slowest tool (p95) first. */
  allToolStats(sessionId?: string): VoiceV24ToolStats[] {
    const names = new Set<string>();
    for (const record of this.list({ sessionId })) names.add(record.toolName);
    return [...names]
      .map((name) => this.toolStats(name, sessionId))
      .sort((a, b) => b.p95Ms - a.p95Ms || b.totalMs - a.totalMs);
  }

  /** Per-session aggregate, with the per-tool breakdown inside. */
  sessionStats(sessionId: string): VoiceV24SessionTimerStats {
    const calls = this.list({ sessionId });
    const finished = calls.filter((r) => r.durationMs !== null);
    const durations = finished.map((r) => r.durationMs as number);
    let slowest: VoiceV24ToolCallRecord | null = null;
    for (const record of finished) {
      if (slowest === null || (record.durationMs ?? 0) > (slowest.durationMs ?? 0)) slowest = record;
    }
    return {
      sessionId,
      calls: calls.length,
      running: calls.filter((r) => r.status === 'running').length,
      completed: calls.filter((r) => r.status === 'completed').length,
      failed: calls.filter((r) => r.status === 'failed').length,
      totalMs: durations.reduce((a, b) => a + b, 0),
      meanMs: round2V24(meanV24(durations)),
      p95Ms: round2V24(percentileV24(durations, 95)),
      slowest: slowest === null ? null : { ...slowest },
      slowCalls: finished.filter((r) => (r.durationMs ?? 0) >= this.opts.slowThresholdMs).length,
      timeoutCalls: finished.filter((r) => (r.durationMs ?? 0) >= this.opts.timeoutMs).length,
      alerts: this.alerts.filter((a) => a.sessionId === sessionId).length,
      byTool: this.allToolStats(sessionId),
    };
  }

  alertsList(sessionId?: string): VoiceV24TimerAlert[] {
    return this.alerts
      .filter((a) => sessionId === undefined || a.sessionId === sessionId)
      .map((a) => ({ ...a }));
  }

  clearAlerts(sessionId?: string): number {
    if (sessionId === undefined) {
      const n = this.alerts.length;
      this.alerts.length = 0;
      return n;
    }
    const before = this.alerts.length;
    for (let i = this.alerts.length - 1; i >= 0; i -= 1) {
      if (this.alerts[i].sessionId === sessionId) this.alerts.splice(i, 1);
    }
    return before - this.alerts.length;
  }

  /** Cancel every running call of a session (session closed mid-call). */
  cancelSession(sessionId: string, atMs: number): number {
    let n = 0;
    for (const record of this.list({ sessionId, status: 'running' })) {
      this.cancel(record.id, atMs);
      n += 1;
    }
    return n;
  }

  count(): number {
    return this.records.size;
  }

  reset(): void {
    this.records.clear();
    this.order.length = 0;
    this.alerts.length = 0;
    this.alertedSlow.clear();
    this.alertedTimeout.clear();
    this.alertedErrorBurst.clear();
    this.seq = 0;
    this.alertSeq = 0;
  }

  private prune(): void {
    while (this.order.length > this.opts.maxRecords) {
      const oldestId = this.order[0];
      const oldest = this.records.get(oldestId);
      // Never prune a running call: drop the oldest *finished* one instead.
      if (oldest !== undefined && oldest.status === 'running') {
        const finishedIdx = this.order.findIndex(
          (id) => this.records.get(id)?.status !== 'running',
        );
        if (finishedIdx === -1) return;
        const dropId = this.order[finishedIdx];
        this.order.splice(finishedIdx, 1);
        this.records.delete(dropId);
      } else {
        this.order.shift();
        this.records.delete(oldestId);
      }
    }
  }

  summary(sessionId?: string): string {
    const stats = sessionId === undefined ? null : this.sessionStats(sessionId);
    if (stats === null) {
      const all = this.allToolStats();
      const total = all.reduce((a, t) => a + t.calls, 0);
      return `${total} tool calls across ${all.length} tools, ${this.alerts.length} alerts.`;
    }
    const slowest = stats.slowest === null ? 'none' : `${stats.slowest.toolName} ${formatDurationV24(stats.slowest.durationMs ?? 0)}`;
    return (
      `Session ${sessionId}: ${stats.calls} tool calls, ${formatDurationV24(stats.totalMs)} total tool time, ` +
      `mean ${formatDurationV24(stats.meanMs)}, p95 ${formatDurationV24(stats.p95Ms)}, ` +
      `slowest ${slowest}, ${stats.slowCalls} slow, ${stats.failed} failed, ${stats.alerts} alerts.`
    );
  }

  markdown(sessionId: string): string {
    const stats = this.sessionStats(sessionId);
    const lines: string[] = [`# Voice v24 tool-call timers — session ${sessionId}`, ''];
    lines.push(
      `Calls: ${stats.calls} (running ${stats.running}, completed ${stats.completed}, failed ${stats.failed})`,
    );
    lines.push(
      `Total tool time: ${formatDurationV24(stats.totalMs)}; mean ${formatDurationV24(stats.meanMs)}; p95 ${formatDurationV24(stats.p95Ms)}.`,
    );
    lines.push('');
    lines.push('| Tool | Calls | Mean | p95 | Max | Slow |');
    lines.push('| --- | ---: | ---: | ---: | ---: | ---: |');
    for (const t of stats.byTool) {
      lines.push(
        `| ${t.toolName} | ${t.calls} | ${formatDurationV24(t.meanMs)} | ${formatDurationV24(t.p95Ms)} | ${formatDurationV24(t.maxMs)} | ${t.slowCalls} |`,
      );
    }
    const alerts = this.alertsList(sessionId);
    if (alerts.length > 0) {
      lines.push('', '## Alerts');
      for (const a of alerts) lines.push(`- [${a.kind}] ${a.message}`);
    }
    return lines.join('\n');
  }
}

/** Clamp helper re-exported for callers that only import this module. */
export { clampV24 };

/**
 * Delegated tool calling v29 (v1.42, Team T4).
 *
 * A voice turn never blocks on a tool. When the agent
 * wants a tool, the call is handed to a separate text
 * model (idea: GPT-Live delegates tool calls to a
 * Responses model of its own; Gemini 3.8 Live makes async
 * function calling the default) and the conversation
 * carries on. The result is delivered back into the
 * append-only context when it is ready — or, for a sync
 * call, awaited with a timeout.
 *
 * The "separate text model" here is a mock executor the
 * host injects per tool: no provider is dialled, no key
 * is used. The runner owns the queue, the per-attempt
 * timeout, the retry budget (virtual clock — retries are
 * scheduled, not slept on), the concurrency cap, and the
 * approval gate for sensitive tools. A call that needs
 * approval waits in `awaiting-approval` until the host
 * approves or rejects it; it is never run on a guess.
 *
 * All clocks virtual (the caller passes `atMs`); the
 * executor is the only async boundary, and tests drive it
 * with already-resolved promises.
 */

import {
  VOICE_V29_DELEGATE_MAX_ATTEMPTS_DEFAULT,
  VOICE_V29_DELEGATE_MAX_CONCURRENT_DEFAULT,
  VOICE_V29_DELEGATE_RETRY_BASE_MS,
  VOICE_V29_DELEGATE_TIMEOUT_DEFAULT_MS,
  clampV29,
  type VoiceV29DelegatedCall,
  type VoiceV29DelegatedCallMode,
  type VoiceV29DelegatedCallState,
  type VoiceV29DelegatedToolDef,
} from './types';

export interface DelegatedToolRunnerV29Options {
  /** Timeout per attempt (ms). */
  timeoutMs?: number;
  /** Max attempts per call (1 = no retry). */
  maxAttempts?: number;
  /** Max calls running at once (extra calls queue). */
  maxConcurrent?: number;
  /** Base delay before a retry (ms, doubled each attempt). */
  retryBaseMs?: number;
  /** Max calls kept in history (oldest finished dropped first). */
  maxCalls?: number;
  /** Called when a call finishes (done, failed, timed out). */
  onFinished?: (call: VoiceV29DelegatedCall) => void;
  /** Called when a call result is ready to be written to context. */
  onResultReady?: (call: VoiceV29DelegatedCall) => void;
}

export interface VoiceV29DelegatedStats {
  registeredTools: number;
  calls: number;
  queued: number;
  running: number;
  awaitingApproval: number;
  done: number;
  failed: number;
  timedOut: number;
  rejected: number;
  avgAttempts: number;
  avgDurationMs: number;
}

export function defaultDelegatedToolRunnerV29Options(): DelegatedToolRunnerV29Options {
  return {
    timeoutMs: VOICE_V29_DELEGATE_TIMEOUT_DEFAULT_MS,
    maxAttempts: VOICE_V29_DELEGATE_MAX_ATTEMPTS_DEFAULT,
    maxConcurrent: VOICE_V29_DELEGATE_MAX_CONCURRENT_DEFAULT,
    retryBaseMs: VOICE_V29_DELEGATE_RETRY_BASE_MS,
    maxCalls: 500,
  };
}

let callCounter = 0;

export class DelegatedToolRunnerV29 {
  private readonly timeoutMs: number;
  private readonly maxAttempts: number;
  private readonly maxConcurrent: number;
  private readonly retryBaseMs: number;
  private readonly maxCalls: number;
  private readonly onFinished?: (call: VoiceV29DelegatedCall) => void;
  private readonly onResultReady?: (call: VoiceV29DelegatedCall) => void;

  private readonly tools = new Map<string, VoiceV29DelegatedToolDef>();
  private readonly calls = new Map<string, VoiceV29DelegatedCall>();
  private readonly order: string[] = [];
  private readonly running = new Set<string>();
  /** Virtual retry schedule: call id -> earliest atMs it may run again. */
  private readonly retryNotBefore = new Map<string, number>();

  constructor(opts: DelegatedToolRunnerV29Options = {}) {
    this.timeoutMs = opts.timeoutMs ?? VOICE_V29_DELEGATE_TIMEOUT_DEFAULT_MS;
    this.maxAttempts = Math.max(1, opts.maxAttempts ?? VOICE_V29_DELEGATE_MAX_ATTEMPTS_DEFAULT);
    this.maxConcurrent = Math.max(1, opts.maxConcurrent ?? VOICE_V29_DELEGATE_MAX_CONCURRENT_DEFAULT);
    this.retryBaseMs = opts.retryBaseMs ?? VOICE_V29_DELEGATE_RETRY_BASE_MS;
    this.maxCalls = opts.maxCalls ?? 500;
    this.onFinished = opts.onFinished;
    this.onResultReady = opts.onResultReady;
  }

  /** Register a tool the runner may delegate to (mock executor). */
  registerTool(def: VoiceV29DelegatedToolDef): void {
    if (!def.name || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(def.name)) {
      throw new Error(`Invalid delegated tool name: ${def.name}`);
    }
    if (typeof def.execute !== 'function') throw new Error(`Delegated tool ${def.name} needs an execute function`);
    this.tools.set(def.name, def);
  }

  unregisterTool(name: string): boolean {
    return this.tools.delete(name);
  }

  listTools(): VoiceV29DelegatedToolDef[] {
    return [...this.tools.values()].map((t) => ({ ...t }));
  }

  getTool(name: string): VoiceV29DelegatedToolDef | null {
    return this.tools.get(name) ?? null;
  }

  /**
   * Queue a call. Async (the default) returns immediately
   * and the result arrives via `onResultReady`; sync calls
   * are still queued but the caller is expected to `pump()`
   * and then read the call. Sensitive tools wait for
   * approval first.
   */
  delegate(
    sessionId: string,
    toolName: string,
    args: Record<string, unknown>,
    atMs: number,
    opts: { mode?: VoiceV29DelegatedCallMode; turnIndex?: number; maxAttempts?: number; timeoutMs?: number } = {},
  ): VoiceV29DelegatedCall {
    const def = this.tools.get(toolName);
    if (!def) throw new Error(`Unknown delegated tool: ${toolName}`);
    callCounter += 1;
    const call: VoiceV29DelegatedCall = {
      id: `dcall-${callCounter}`,
      sessionId,
      toolName,
      args: { ...args },
      mode: opts.mode ?? 'async',
      state: def.sensitive ? 'awaiting-approval' : 'queued',
      createdAtMs: atMs,
      startedAtMs: null,
      finishedAtMs: null,
      attempts: 0,
      maxAttempts: clampV29(Math.floor(opts.maxAttempts ?? this.maxAttempts), 1, 10),
      timeoutMs: opts.timeoutMs ?? this.timeoutMs,
      result: null,
      error: null,
      needsApproval: def.sensitive,
      turnIndex: opts.turnIndex ?? -1,
    };
    this.calls.set(call.id, call);
    this.order.push(call.id);
    this.enforceMaxCalls();
    return { ...call, args: { ...call.args } };
  }

  /** Approve a waiting call (it becomes queued and may run). */
  approve(callId: string, atMs: number): VoiceV29DelegatedCall | null {
    const call = this.calls.get(callId);
    if (!call || call.state !== 'awaiting-approval') return null;
    call.state = 'queued';
    void atMs;
    return { ...call, args: { ...call.args } };
  }

  /** Reject a waiting call (it never runs). */
  reject(callId: string, atMs: number, reason = 'Rejected by the user'): VoiceV29DelegatedCall | null {
    const call = this.calls.get(callId);
    if (!call || call.state !== 'awaiting-approval') return null;
    call.state = 'rejected';
    call.finishedAtMs = atMs;
    call.error = reason;
    this.onFinished?.({ ...call, args: { ...call.args } });
    return { ...call, args: { ...call.args } };
  }

  /** Cancel a queued call before it starts. */
  cancel(callId: string, atMs: number): boolean {
    const call = this.calls.get(callId);
    if (!call || call.state !== 'queued') return false;
    call.state = 'failed';
    call.finishedAtMs = atMs;
    call.error = 'Cancelled before start';
    this.onFinished?.({ ...call, args: { ...call.args } });
    return true;
  }

  get(callId: string): VoiceV29DelegatedCall | null {
    const call = this.calls.get(callId);
    return call ? { ...call, args: { ...call.args } } : null;
  }

  list(sessionId?: string): VoiceV29DelegatedCall[] {
    return this.order
      .map((id) => this.calls.get(id))
      .filter((c): c is VoiceV29DelegatedCall => c !== undefined)
      .filter((c) => sessionId === undefined || c.sessionId === sessionId)
      .map((c) => ({ ...c, args: { ...c.args } }));
  }

  pending(sessionId?: string): VoiceV29DelegatedCall[] {
    return this.list(sessionId).filter(
      (c) => c.state === 'queued' || c.state === 'running' || c.state === 'awaiting-approval',
    );
  }

  /**
   * Drive the queue at virtual time `atMs`: start queued
   * calls up to the concurrency cap, honour retry delays,
   * and time out calls that ran past their per-attempt
   * budget. Executors run as real promises; the caller
   * awaits `pump()` and then reads results.
   */
  async pump(atMs: number): Promise<VoiceV29DelegatedCall[]> {
    const finished: VoiceV29DelegatedCall[] = [];
    // Time out over-running calls first.
    for (const id of [...this.running]) {
      const call = this.calls.get(id);
      if (!call || call.startedAtMs === null) continue;
      if (atMs - call.startedAtMs >= call.timeoutMs) {
        this.running.delete(id);
        finished.push(this.finishAttempt(call, atMs, null, `Timed out after ${call.timeoutMs}ms`));
      }
    }
    // Start queued calls while slots are free.
    for (const id of this.order) {
      if (this.running.size >= this.maxConcurrent) break;
      const call = this.calls.get(id);
      if (!call || call.state !== 'queued') continue;
      const notBefore = this.retryNotBefore.get(id) ?? 0;
      if (atMs < notBefore) continue;
      call.state = 'running';
      call.startedAtMs = atMs;
      call.attempts += 1;
      this.running.add(id);
      const def = this.tools.get(call.toolName);
      if (!def) {
        this.running.delete(id);
        finished.push(this.finishAttempt(call, atMs, null, `Tool was unregistered: ${call.toolName}`));
        continue;
      }
      try {
        const result = await def.execute({ ...call.args });
        this.running.delete(id);
        finished.push(this.finishAttempt(call, atMs, String(result), null));
      } catch (err) {
        this.running.delete(id);
        finished.push(
          this.finishAttempt(call, atMs, null, err instanceof Error ? err.message : String(err)),
        );
      }
    }
    return finished;
  }

  stats(): VoiceV29DelegatedStats {
    const all = [...this.calls.values()];
    const done = all.filter((c) => c.state === 'done');
    const durations = done
      .filter((c) => c.startedAtMs !== null && c.finishedAtMs !== null)
      .map((c) => (c.finishedAtMs as number) - (c.startedAtMs as number));
    return {
      registeredTools: this.tools.size,
      calls: all.length,
      queued: all.filter((c) => c.state === 'queued').length,
      running: all.filter((c) => c.state === 'running').length,
      awaitingApproval: all.filter((c) => c.state === 'awaiting-approval').length,
      done: done.length,
      failed: all.filter((c) => c.state === 'failed').length,
      timedOut: all.filter((c) => c.state === 'timed-out').length,
      rejected: all.filter((c) => c.state === 'rejected').length,
      avgAttempts: all.length === 0 ? 0 : Math.round((all.reduce((a, c) => a + c.attempts, 0) / all.length) * 100) / 100,
      avgDurationMs: durations.length === 0 ? 0 : Math.round(durations.reduce((a, b) => a + b, 0) / durations.length),
    };
  }

  private finishAttempt(
    call: VoiceV29DelegatedCall,
    atMs: number,
    result: string | null,
    error: string | null,
  ): VoiceV29DelegatedCall {
    if (result !== null) {
      call.state = 'done';
      call.result = result;
      call.error = null;
      call.finishedAtMs = atMs;
      this.onFinished?.({ ...call, args: { ...call.args } });
      this.onResultReady?.({ ...call, args: { ...call.args } });
      return { ...call, args: { ...call.args } };
    }
    // Failure: retry while attempts remain, else fail for good.
    if (call.attempts < call.maxAttempts) {
      call.state = 'queued';
      call.error = error;
      const delay = this.retryBaseMs * 2 ** (call.attempts - 1);
      this.retryNotBefore.set(call.id, atMs + delay);
      return { ...call, args: { ...call.args } };
    }
    const timedOut = (error ?? '').toLowerCase().includes('timed out');
    call.state = timedOut ? 'timed-out' : 'failed';
    call.error = error;
    call.finishedAtMs = atMs;
    this.onFinished?.({ ...call, args: { ...call.args } });
    return { ...call, args: { ...call.args } };
  }

  private enforceMaxCalls(): void {
    while (this.order.length > this.maxCalls) {
      const oldest = this.order[0];
      const call = this.calls.get(oldest);
      if (call && (call.state === 'queued' || call.state === 'running' || call.state === 'awaiting-approval')) {
        // Never drop a live call to make room: drop the
        // oldest *finished* one instead, or stop.
        const finishedIdx = this.order.findIndex((id) => {
          const c = this.calls.get(id);
          return c !== undefined && c.state !== 'queued' && c.state !== 'running' && c.state !== 'awaiting-approval';
        });
        if (finishedIdx === -1) break;
        const dropId = this.order[finishedIdx];
        this.order.splice(finishedIdx, 1);
        this.calls.delete(dropId);
        this.retryNotBefore.delete(dropId);
      } else {
        this.order.shift();
        this.calls.delete(oldest);
        this.retryNotBefore.delete(oldest);
      }
    }
  }
}

export function createDelegatedToolRunnerV29(opts: DelegatedToolRunnerV29Options = {}): DelegatedToolRunnerV29 {
  return new DelegatedToolRunnerV29(opts);
}

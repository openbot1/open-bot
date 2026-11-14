/**
 * Session resilience (v1.03, Team T5 — realtime voice v3).
 *
 * v0.95/v0.98 reconnect redials inside the transport, blindly: the
 * session does not know whether it is on attempt 1 or attempt 20,
 * how long the call has been dark, or whether the server asked it
 * to go away. This module owns the *decision* to reconnect, so the
 * call can be honest about it:
 *
 *   connected ──▶ noteDisconnected(error) ──▶ reconnecting
 *        ▲               (backoff + jitter, capped)      │
 *        └──────────── dial() ok ◀── attempts left ─────┘
 *                      dial() fails / budget spent ──▶ exhausted
 *
 * `ReconnectController` is pure decision logic (injectable clock +
 * random, no timers, no socket): it answers `shouldRetry()` and
 * `nextDelayMs()` and records the downtime. `ResilientDialer` runs
 * the loop around an injected `dial` function with an injectable
 * `sleep`, so tests drive it without real timers. `goAway` (the
 * Gemini server telling the client the session is about to end) is
 * a *planned* reconnect: short delay, attempt budget untouched.
 *
 * Resuming after a reconnect re-seeds the model from the latest
 * checkpoint (`buildResumeInstructions`): the base instructions
 * plus the checkpoint's summaries + recent turns + media block, so
 * the model picks up where the call left off instead of starting
 * cold. The socket is always a fresh dial — checkpoints restore
 * context, never connections.
 */
import { Backoff } from './transportHealth';
import type { VoiceSessionCheckpoint } from './sessionCheckpoint';

/** Default max reconnect attempts per drop (matches the session's
 *  own budget so the two never disagree about giving up). */
export const RESILIENCE_DEFAULT_MAX_ATTEMPTS = 5;
/** Default first delay before redial (ms). */
export const RESILIENCE_DEFAULT_BASE_DELAY_MS = 1_000;
/** Default cap on the redial delay (ms). */
export const RESILIENCE_DEFAULT_MAX_DELAY_MS = 10_000;
/** A `goAway` with this much time left (s) redials almost at once. */
export const RESILIENCE_GOAWAY_SOON_SEC = 30;
/** Delay (ms) after a `goAway` that says "soon". */
export const RESILIENCE_GOAWAY_SOON_DELAY_MS = 500;
/** Delay (ms) after a `goAway` with plenty of time left. */
export const RESILIENCE_GOAWAY_LATER_DELAY_MS = 2_000;

export type ReconnectState = 'connected' | 'reconnecting' | 'exhausted';

export type ReconnectEvent =
  | { kind: 'reconnecting'; attempt: number; delayMs: number; error: string; at: number }
  | { kind: 'reconnected'; attempt: number; downtimeMs: number; at: number }
  | { kind: 'exhausted'; attempts: number; downtimeMs: number; error: string; at: number }
  | { kind: 'go-away'; timeLeftSec: number | null; delayMs: number; at: number };

export type ReconnectEventSink = (event: ReconnectEvent) => void;

/** Stats for the panel / diagnostics. */
export interface ReconnectStats {
  state: ReconnectState;
  /** Attempts spent on the current drop (0 while connected). */
  attempts: number;
  /** Max attempts allowed per drop. */
  maxAttempts: number;
  /** Drops handled so far in this call. */
  drops: number;
  /** Successful reconnects so far. */
  reconnects: number;
  /** Total ms the call has spent dark (all drops). */
  totalDowntimeMs: number;
  /** Last error that dropped the call ('' when none). */
  lastError: string;
  /** When the current drop started (0 while connected). */
  droppedAt: number;
}

export interface ReconnectControllerOptions {
  /** Max attempts per drop. Default 5. */
  maxAttempts?: number;
  /** First redial delay (ms). Default 1000. */
  baseDelayMs?: number;
  /** Cap on the redial delay (ms). Default 10000. */
  maxDelayMs?: number;
  /** Jitter fraction (0–1). Default 0.2 (same as `Backoff`). */
  jitter?: number;
  /** Inject the clock (tests). Defaults to `Date.now`. */
  clock?: () => number;
  /** Inject randomness (tests). Defaults to `Math.random`. */
  random?: () => number;
  /** Event sink. Never throws into the controller. */
  onEvent?: ReconnectEventSink;
}

/**
 * Decides whether — and when — to redial after a drop. The caller
 * owns the actual dial; this only answers the policy questions and
 * keeps the books. Terminal errors (a closed-by-user disconnect,
 * an auth failure) never retry: `noteDisconnected(err, {terminal:
 * true})` goes straight to `exhausted`.
 */
export class ReconnectController {
  private readonly maxAttempts: number;
  private readonly backoff: Backoff;
  private readonly clock: () => number;
  private readonly onEvent: ReconnectEventSink | undefined;
  private state: ReconnectState = 'connected';
  private attempts = 0;
  private drops = 0;
  private reconnects = 0;
  private totalDowntimeMs = 0;
  private lastError = '';
  private droppedAt = 0;

  constructor(options: ReconnectControllerOptions = {}) {
    this.maxAttempts = Math.max(0, options.maxAttempts ?? RESILIENCE_DEFAULT_MAX_ATTEMPTS);
    this.backoff = new Backoff({
      baseMs: options.baseDelayMs ?? RESILIENCE_DEFAULT_BASE_DELAY_MS,
      maxMs: options.maxDelayMs ?? RESILIENCE_DEFAULT_MAX_DELAY_MS,
      jitter: options.jitter ?? 0.2,
      random: options.random,
    });
    this.clock = options.clock ?? Date.now;
    this.onEvent = options.onEvent;
  }

  getState(): ReconnectState {
    return this.state;
  }

  getStats(): ReconnectStats {
    return {
      state: this.state,
      attempts: this.attempts,
      maxAttempts: this.maxAttempts,
      drops: this.drops,
      reconnects: this.reconnects,
      totalDowntimeMs: this.totalDowntimeMs,
      lastError: this.lastError,
      droppedAt: this.droppedAt,
    };
  }

  /** True while a redial is in progress (attempts remain). */
  isReconnecting(): boolean {
    return this.state === 'reconnecting';
  }

  /** The call is live (fresh connect or successful redial). */
  noteConnected(): void {
    if (this.state === 'reconnecting' && this.droppedAt > 0) {
      const downtime = this.clock() - this.droppedAt;
      this.totalDowntimeMs += downtime;
      this.reconnects += 1;
      this.emit({
        kind: 'reconnected',
        attempt: this.attempts,
        downtimeMs: downtime,
        at: this.clock(),
      });
    }
    this.state = 'connected';
    this.attempts = 0;
    this.backoff.reset();
    this.droppedAt = 0;
  }

  /**
   * The socket dropped. Returns the decision: retry with
   * `delayMs`, or give up (`retry: false`). A terminal error, or
   * a spent attempt budget, exhausts the controller immediately.
   */
  noteDisconnected(
    error: Error | string,
    opts: { terminal?: boolean } = {},
  ): { retry: boolean; delayMs: number; attempt: number } {
    const message = error instanceof Error ? error.message : String(error ?? '');
    this.lastError = message;
    if (this.state === 'connected') {
      this.drops += 1;
      this.droppedAt = this.clock();
    }
    if (opts.terminal || this.attempts >= this.maxAttempts) {
      const downtime = this.droppedAt > 0 ? this.clock() - this.droppedAt : 0;
      this.totalDowntimeMs += downtime;
      this.state = 'exhausted';
      this.emit({
        kind: 'exhausted',
        attempts: this.attempts,
        downtimeMs: downtime,
        error: message,
        at: this.clock(),
      });
      return { retry: false, delayMs: 0, attempt: this.attempts };
    }
    const delayMs = this.backoff.nextDelay();
    this.attempts += 1;
    this.state = 'reconnecting';
    this.emit({
      kind: 'reconnecting',
      attempt: this.attempts,
      delayMs,
      error: message,
      at: this.clock(),
    });
    return { retry: true, delayMs, attempt: this.attempts };
  }

  /**
   * The server said `goAway` (Gemini: the session is about to end,
   * usually the ~15-minute audio cap). This is a *planned*
   * reconnect: the delay is short, and the attempt budget is not
   * spent — the server asked for it, the network did not fail.
   * Returns the delay to wait before redialling.
   */
  noteGoAway(timeLeftSec: number | null): number {
    const delayMs =
      timeLeftSec === null || timeLeftSec <= RESILIENCE_GOAWAY_SOON_SEC
        ? RESILIENCE_GOAWAY_SOON_DELAY_MS
        : RESILIENCE_GOAWAY_LATER_DELAY_MS;
    this.emit({ kind: 'go-away', timeLeftSec, delayMs, at: this.clock() });
    return delayMs;
  }

  /** Reset all state (new call). */
  reset(): void {
    this.state = 'connected';
    this.attempts = 0;
    this.drops = 0;
    this.reconnects = 0;
    this.totalDowntimeMs = 0;
    this.lastError = '';
    this.droppedAt = 0;
    this.backoff.reset();
  }

  private emit(event: ReconnectEvent): void {
    try {
      this.onEvent?.(event);
    } catch {
      // A throwing sink must not break the call.
    }
  }
}

export interface ResilientDialerOptions {
  controller?: ReconnectController;
  /** Sleep between attempts (injectable — tests pass a no-op). */
  sleep?: (ms: number) => Promise<void>;
  /** Event sink (the controller's, plus dial outcomes). */
  onEvent?: ReconnectEventSink;
}

export interface ResilientDialResult {
  /** True when a dial finally succeeded. */
  ok: boolean;
  /** Attempts spent (1 = the first dial worked). */
  attempts: number;
  /** Total ms spent waiting between attempts. */
  waitedMs: number;
  /** Last error when `ok` is false. */
  error?: string;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Runs the reconnect loop around an injected `dial` function:
 * dial, and on failure ask the controller whether to wait and try
 * again. Terminal failures stop at once (the controller decides —
 * the dialer never guesses). Returns after the first success or
 * when the controller exhausts. Pure orchestration: no socket, no
 * timers of its own (the sleep is injected).
 */
export class ResilientDialer {
  private readonly controller: ReconnectController;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: ResilientDialerOptions = {}) {
    this.controller = options.controller ?? new ReconnectController({ onEvent: options.onEvent });
    this.sleep = options.sleep ?? defaultSleep;
  }

  getController(): ReconnectController {
    return this.controller;
  }

  async dialWithReconnect(
    dial: () => Promise<void>,
    opts: { isTerminalError?: (error: unknown) => boolean } = {},
  ): Promise<ResilientDialResult> {
    let attempts = 0;
    let waitedMs = 0;
    let lastError = '';
    for (;;) {
      attempts += 1;
      try {
        await dial();
        this.controller.noteConnected();
        return { ok: true, attempts, waitedMs };
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err ?? '');
        const terminal = opts.isTerminalError?.(err) ?? false;
        const decision = this.controller.noteDisconnected(lastError, { terminal });
        if (!decision.retry) {
          return { ok: false, attempts, waitedMs, error: lastError };
        }
        waitedMs += decision.delayMs;
        await this.sleep(decision.delayMs);
      }
    }
  }
}

/**
 * Instructions for a resumed call: the base instructions, then the
 * checkpoint's memory (summaries + recent turns, as the long
 * session renders them), then the media block, then a short note
 * telling the model the call dropped and it should continue — not
 * restart — from the summary. Empty sections are skipped, so a
 * checkpoint with no media and no turns degrades to the base
 * instructions plus the resume note.
 */
export function buildResumeInstructions(
  baseInstructions: string,
  checkpoint: VoiceSessionCheckpoint,
  opts: { contextBlock?: string; mediaBlock?: string } = {},
): string {
  const parts: string[] = [];
  const base = String(baseInstructions ?? '').trim();
  if (base) parts.push(base);
  const context = String(opts.contextBlock ?? '').trim();
  if (context) parts.push(`What happened so far in this call:\n${context}`);
  const media = String(opts.mediaBlock ?? '').trim();
  if (media) parts.push(media);
  parts.push(
    'This voice call was interrupted (the connection dropped) and has now ' +
      'resumed from a checkpoint. Continue the conversation from the summary ' +
      'above — do not restart it, do not re-introduce yourself, and do not ' +
      'repeat anything the user already heard.',
  );
  return parts.join('\n\n');
}

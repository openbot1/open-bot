/**
 * Bots v26 — per-bot registry + lifecycle (v1.39, Team T6).
 *
 * One bot = one agent process the fleet supervises. The registry owns
 * the bot's identity, its quota reference (granted by
 * `resources.ts` — this module never invents quotas), its lifecycle
 * state, and its heartbeat. State changes go through ONE transition
 * table (`FLEET_V26_BOT_TRANSITIONS`) so an illegal jump (e.g.
 * `stopped -> paused`) is a refusal with a reason, never a silent
 * no-op — the host can trust that `running` really means "started and
 * heartbeating".
 *
 * Lifecycle:
 *   registered -> starting -> running -> paused -> running
 *   running/paused -> stopping -> stopped -> starting (restart)
 *   any live state -> failed (heartbeat lost / crash reported)
 *   failed -> starting (restart) | removed
 *   stopped/registered/failed -> removed (terminal; the record stays
 *   in the removed list only as a tombstone count, never resurrected)
 *
 * Restarts are bounded: `maxRestarts` per window (`restartWindowMs`);
 * past the cap the bot goes `failed` and stays there until a human
 * (or a higher-level policy) restarts it — a crash-looping bot must
 * not eat the host alive. The registry never spawns anything; the
 * host drives real processes and reports back via `heartbeat()` /
 * `reportCrash()` / `markStarted()` / `markStopped()`.
 */

import type { FleetV26BotQuota } from './resources';

/** Lifecycle states a bot can be in. */
export type FleetV26BotState =
  | 'registered'
  | 'starting'
  | 'running'
  | 'paused'
  | 'stopping'
  | 'stopped'
  | 'failed';

/** States from which a bot may still come back (not terminal). */
export const FLEET_V26_BOT_LIVE_STATES: readonly FleetV26BotState[] = [
  'registered',
  'starting',
  'running',
  'paused',
  'stopping',
  'stopped',
  'failed',
];

/** Legal transitions (from -> allowed targets). */
export const FLEET_V26_BOT_TRANSITIONS: Readonly<Record<FleetV26BotState, readonly FleetV26BotState[]>> = {
  registered: ['starting', 'failed'],
  starting: ['running', 'failed', 'stopping'],
  running: ['paused', 'stopping', 'failed'],
  paused: ['running', 'stopping', 'failed'],
  stopping: ['stopped', 'failed'],
  stopped: ['starting'],
  failed: ['starting'],
};

/** How a bot was created / what it runs (host-supplied, opaque to us). */
export interface FleetV26BotSpec {
  id: string;
  name: string;
  /** Owner user id (fleet v25 user) or null for the local user. */
  ownerId: string | null;
  /** Tags for grouping / scoping (fleet v25 scope tags). */
  tags: string[];
  /** Command the host runs (kept for display; never executed here). */
  command: string;
  /** Working directory (display only). */
  cwd: string | null;
  /** Restart cap per window (0 = never auto-restart). */
  maxRestarts: number;
  /** Restart window, ms. */
  restartWindowMs: number;
}

/** One bot record. */
export interface FleetV26Bot {
  spec: FleetV26BotSpec;
  state: FleetV26BotState;
  /** Quota granted by the resource allocator (null = none yet). */
  quota: FleetV26BotQuota | null;
  createdAtMs: number;
  updatedAtMs: number;
  startedAtMs: number | null;
  lastHeartbeatMs: number | null;
  /** Consecutive restarts inside the current window. */
  restartsInWindow: number;
  /** Window start for the restart counter. */
  restartWindowStartMs: number;
  /** Total restarts since registration. */
  totalRestarts: number;
  /** Last failure reason (null = never failed). */
  lastError: string | null;
  /** Free-form note from the host/operator. */
  note: string | null;
}

/** Result of a lifecycle operation. */
export interface FleetV26BotOp {
  ok: boolean;
  botId: string;
  from: FleetV26BotState | null;
  to: FleetV26BotState | null;
  message: string;
}

/** Default restart policy: 3 restarts per 10 minutes, then stay failed. */
export const FLEET_V26_DEFAULT_MAX_RESTARTS = 3;
export const FLEET_V26_DEFAULT_RESTART_WINDOW_MS = 10 * 60 * 1000;
/** Heartbeat older than this (ms) counts as lost (5 minutes). */
export const FLEET_V26_HEARTBEAT_STALE_MS = 5 * 60 * 1000;

function isBotState(s: unknown): s is FleetV26BotState {
  return (
    typeof s === 'string' &&
    ['registered', 'starting', 'running', 'paused', 'stopping', 'stopped', 'failed'].includes(s)
  );
}

function normalizeSpec(input: {
  id: string;
  name?: string;
  ownerId?: string | null;
  tags?: string[];
  command?: string;
  cwd?: string | null;
  maxRestarts?: number;
  restartWindowMs?: number;
}): { ok: true; spec: FleetV26BotSpec } | { ok: false; message: string } {
  const id = typeof input.id === 'string' ? input.id.trim() : '';
  if (!id) return { ok: false, message: 'Bot id is required.' };
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(id)) {
    return { ok: false, message: `Bot id "${id}" must start alphanumerically and use only letters, digits, ".", "_" or "-".` };
  }
  const name = typeof input.name === 'string' && input.name.trim() ? input.name.trim() : id;
  const maxRestarts =
    input.maxRestarts === undefined ? FLEET_V26_DEFAULT_MAX_RESTARTS : Math.floor(input.maxRestarts);
  const restartWindowMs =
    input.restartWindowMs === undefined ? FLEET_V26_DEFAULT_RESTART_WINDOW_MS : Math.floor(input.restartWindowMs);
  if (!Number.isFinite(maxRestarts) || maxRestarts < 0) {
    return { ok: false, message: 'maxRestarts must be a number >= 0.' };
  }
  if (!Number.isFinite(restartWindowMs) || restartWindowMs <= 0) {
    return { ok: false, message: 'restartWindowMs must be a number > 0.' };
  }
  return {
    ok: true,
    spec: {
      id,
      name,
      ownerId: input.ownerId ?? null,
      tags: [...new Set((input.tags ?? []).map((t) => t.trim()).filter(Boolean))].sort(),
      command: input.command ?? '',
      cwd: input.cwd ?? null,
      maxRestarts,
      restartWindowMs,
    },
  };
}

/** Registry + lifecycle for fleet bots. */
export class FleetV26BotRegistry {
  private bots = new Map<string, FleetV26Bot>();
  private removedCount = 0;

  /** Register a bot (starts `registered`). Refuses duplicates. */
  register(
    input: Parameters<typeof normalizeSpec>[0],
    nowMs: number = Date.now(),
  ): FleetV26BotOp {
    const normalized = normalizeSpec(input);
    if (!normalized.ok) return { ok: false, botId: input.id ?? '', from: null, to: null, message: normalized.message };
    const spec = normalized.spec;
    if (this.bots.has(spec.id)) {
      return { ok: false, botId: spec.id, from: this.bots.get(spec.id)?.state ?? null, to: null, message: `Bot "${spec.id}" is already registered.` };
    }
    this.bots.set(spec.id, {
      spec,
      state: 'registered',
      quota: null,
      createdAtMs: nowMs,
      updatedAtMs: nowMs,
      startedAtMs: null,
      lastHeartbeatMs: null,
      restartsInWindow: 0,
      restartWindowStartMs: nowMs,
      totalRestarts: 0,
      lastError: null,
      note: null,
    });
    return { ok: true, botId: spec.id, from: null, to: 'registered', message: `Bot "${spec.id}" registered.` };
  }

  /** One bot (copy) or undefined. */
  get(botId: string): FleetV26Bot | undefined {
    const b = this.bots.get(botId);
    return b ? { ...b, spec: { ...b.spec, tags: [...b.spec.tags] }, quota: b.quota ? { ...b.quota } : null } : undefined;
  }

  /** All bots, sorted by id. */
  list(): FleetV26Bot[] {
    return [...this.bots.values()]
      .map((b) => this.get(b.spec.id) as FleetV26Bot)
      .sort((a, b) => a.spec.id.localeCompare(b.spec.id));
  }

  /** Bots in a given state. */
  listByState(state: FleetV26BotState): FleetV26Bot[] {
    return this.list().filter((b) => b.state === state);
  }

  /** Bots carrying a tag. */
  listByTag(tag: string): FleetV26Bot[] {
    return this.list().filter((b) => b.spec.tags.includes(tag));
  }

  /** Counts by state + totals. */
  counts(): Record<FleetV26BotState, number> & { total: number; removed: number } {
    const out: Record<string, number> = {
      registered: 0, starting: 0, running: 0, paused: 0, stopping: 0, stopped: 0, failed: 0,
    };
    for (const b of this.bots.values()) out[b.state] = (out[b.state] ?? 0) + 1;
    return { ...(out as Record<FleetV26BotState, number>), total: this.bots.size, removed: this.removedCount };
  }

  /** Attach a granted quota to a bot (the allocator owns the numbers). */
  attachQuota(botId: string, quota: FleetV26BotQuota, nowMs: number = Date.now()): boolean {
    const b = this.bots.get(botId);
    if (!b || quota.botId !== botId) return false;
    b.quota = { ...quota };
    b.updatedAtMs = nowMs;
    return true;
  }

  /** Detach a bot's quota record (the allocator must release separately). */
  detachQuota(botId: string, nowMs: number = Date.now()): boolean {
    const b = this.bots.get(botId);
    if (!b || !b.quota) return false;
    b.quota = null;
    b.updatedAtMs = nowMs;
    return true;
  }

  /** Single guarded transition (the only way state changes). */
  transition(botId: string, to: FleetV26BotState, nowMs: number = Date.now(), note?: string): FleetV26BotOp {
    const b = this.bots.get(botId);
    if (!b) return { ok: false, botId, from: null, to: null, message: `Bot "${botId}" is not registered.` };
    if (!isBotState(to)) return { ok: false, botId, from: b.state, to: null, message: `Unknown state "${String(to)}".` };
    if (!FLEET_V26_BOT_TRANSITIONS[b.state].includes(to)) {
      return {
        ok: false,
        botId,
        from: b.state,
        to: null,
        message: `Bot "${botId}" cannot go from ${b.state} to ${to}.`,
      };
    }
    const from = b.state;
    b.state = to;
    b.updatedAtMs = nowMs;
    if (note !== undefined) b.note = note;
    if (to === 'running' && b.startedAtMs === null) b.startedAtMs = nowMs;
    if (to === 'stopped' || to === 'failed') b.lastHeartbeatMs = b.lastHeartbeatMs; // keep last beat for diagnosis
    return { ok: true, botId, from, to, message: `Bot "${botId}" moved ${from} -> ${to}.` };
  }

  /** Request a start (registered/stopped/failed -> starting). */
  start(botId: string, nowMs: number = Date.now()): FleetV26BotOp {
    return this.transition(botId, 'starting', nowMs);
  }

  /** Host reports the process is up (starting -> running). */
  markStarted(botId: string, nowMs: number = Date.now()): FleetV26BotOp {
    const op = this.transition(botId, 'running', nowMs);
    if (op.ok) {
      const b = this.bots.get(botId);
      if (b) {
        b.startedAtMs = nowMs;
        b.lastHeartbeatMs = nowMs;
        b.lastError = null;
      }
    }
    return op;
  }

  /** Request a stop (running/paused/starting -> stopping). */
  stop(botId: string, nowMs: number = Date.now()): FleetV26BotOp {
    return this.transition(botId, 'stopping', nowMs);
  }

  /** Host reports the process exited cleanly (stopping -> stopped). */
  markStopped(botId: string, nowMs: number = Date.now()): FleetV26BotOp {
    return this.transition(botId, 'stopped', nowMs);
  }

  /** Pause a running bot. */
  pause(botId: string, nowMs: number = Date.now()): FleetV26BotOp {
    return this.transition(botId, 'paused', nowMs);
  }

  /** Resume a paused bot. */
  resume(botId: string, nowMs: number = Date.now()): FleetV26BotOp {
    return this.transition(botId, 'running', nowMs);
  }

  /** Record a heartbeat (running/paused only; refreshes liveness). */
  heartbeat(botId: string, nowMs: number = Date.now()): boolean {
    const b = this.bots.get(botId);
    if (!b || (b.state !== 'running' && b.state !== 'paused' && b.state !== 'starting')) return false;
    b.lastHeartbeatMs = nowMs;
    b.updatedAtMs = nowMs;
    return true;
  }

  /** Host reports a crash (any live state -> failed). */
  reportCrash(botId: string, error: string, nowMs: number = Date.now()): FleetV26BotOp {
    const b = this.bots.get(botId);
    if (!b) return { ok: false, botId, from: null, to: null, message: `Bot "${botId}" is not registered.` };
    if (b.state === 'stopped' || b.state === 'registered') {
      return { ok: false, botId, from: b.state, to: null, message: `Bot "${botId}" is ${b.state} and cannot crash.` };
    }
    const from = b.state;
    b.state = 'failed';
    b.lastError = error.slice(0, 500);
    b.updatedAtMs = nowMs;
    return { ok: true, botId, from, to: 'failed', message: `Bot "${botId}" failed: ${b.lastError}` };
  }

  /**
   * Restart a failed/stopped bot, honouring the restart cap. When the
   * cap is hit inside the window the bot stays `failed` and the op
   * explains why (a crash loop must not eat the host).
   */
  restart(botId: string, nowMs: number = Date.now()): FleetV26BotOp {
    const b = this.bots.get(botId);
    if (!b) return { ok: false, botId, from: null, to: null, message: `Bot "${botId}" is not registered.` };
    if (b.state !== 'failed' && b.state !== 'stopped') {
      return { ok: false, botId, from: b.state, to: null, message: `Bot "${botId}" is ${b.state}; only failed or stopped bots restart.` };
    }
    if (nowMs - b.restartWindowStartMs >= b.spec.restartWindowMs) {
      b.restartWindowStartMs = nowMs;
      b.restartsInWindow = 0;
    }
    if (b.state === 'failed' && b.restartsInWindow >= b.spec.maxRestarts) {
      return {
        ok: false,
        botId,
        from: b.state,
        to: null,
        message:
          `Bot "${botId}" hit its restart cap (${b.spec.maxRestarts} restarts in ` +
          `${Math.round(b.spec.restartWindowMs / 60000)} min) — manual restart required.`,
      };
    }
    b.restartsInWindow += 1;
    b.totalRestarts += 1;
    b.lastError = null;
    return this.transition(botId, 'starting', nowMs);
  }

  /** Remove a bot (stopped/registered/failed only; terminal). */
  remove(botId: string): FleetV26BotOp {
    const b = this.bots.get(botId);
    if (!b) return { ok: false, botId, from: null, to: null, message: `Bot "${botId}" is not registered.` };
    if (b.state === 'running' || b.state === 'paused' || b.state === 'starting' || b.state === 'stopping') {
      return { ok: false, botId, from: b.state, to: null, message: `Stop bot "${botId}" before removing it (it is ${b.state}).` };
    }
    this.bots.delete(botId);
    this.removedCount += 1;
    return { ok: true, botId, from: b.state, to: null, message: `Bot "${botId}" removed.` };
  }

  /** Bots whose heartbeat is stale (running/paused/starting, beat older than the threshold). */
  staleBots(nowMs: number = Date.now(), staleAfterMs: number = FLEET_V26_HEARTBEAT_STALE_MS): FleetV26Bot[] {
    return this.list().filter(
      (b) =>
        (b.state === 'running' || b.state === 'paused' || b.state === 'starting') &&
        (b.lastHeartbeatMs === null || nowMs - b.lastHeartbeatMs > staleAfterMs),
    );
  }

  /** Uptime of a running bot, ms (null when not running). */
  uptimeMs(botId: string, nowMs: number = Date.now()): number | null {
    const b = this.bots.get(botId);
    if (!b || b.state !== 'running' || b.startedAtMs === null) return null;
    return Math.max(0, nowMs - b.startedAtMs);
  }

  /** JSON round-trip. */
  toJSON(): { bots: FleetV26Bot[]; removedCount: number } {
    return { bots: this.list(), removedCount: this.removedCount };
  }

  static fromJSON(data: { bots?: FleetV26Bot[]; removedCount?: number }): FleetV26BotRegistry {
    const reg = new FleetV26BotRegistry();
    for (const b of data.bots ?? []) {
      if (b && b.spec && typeof b.spec.id === 'string' && isBotState(b.state)) {
        reg.bots.set(b.spec.id, {
          ...b,
          spec: { ...b.spec, tags: [...(b.spec.tags ?? [])] },
          quota: b.quota ? { ...b.quota } : null,
        });
      }
    }
    reg.removedCount = typeof data.removedCount === 'number' ? data.removedCount : 0;
    return reg;
  }
}

/** One-line summary for the bots panel. */
export function summarizeFleetV26Bots(reg: FleetV26BotRegistry): string {
  const c = reg.counts();
  return (
    `${c.total} bot(s): ${c.running} running, ${c.paused} paused, ` +
    `${c.starting} starting, ${c.stopped} stopped, ${c.failed} failed, ` +
    `${c.registered} registered (${c.removed} removed)`
  );
}

/**
 * Per-conversation sandbox runtime (v1.41, Team T6) — fleet v28.
 *
 * OpenHands SDK v1.60 (survey `docs/repo-survey-v141.md` §3): from
 * v1.49 each conversation can run in its own Docker runtime with
 * limits, keeping the conversation API unchanged; v1.49.5 adds idle
 * Docker runtime eviction. This module is the open-bot equivalent,
 * at the decision/state layer (it never spawns a process or touches
 * cgroups/Docker itself — the host enforces limits; this module
 * decides, tracks, and persists state so the host can enforce):
 *
 * - One runtime per conversation: `FleetV28RuntimeStore` holds one
 *   `ConversationRuntime` per conversation id, with its own limits
 *   (CPU cores / RAM / disk / wall-clock timeout / idle timeout).
 * - Lifecycle: start / stop / restart, with explicit states
 *   (`starting` -> `running` -> `stopped`, plus `evicted`,
 *   `failed`, `restarting`). Restart keeps the conversation id and
 *   bumps a restart counter; a restart after eviction restores the
 *   state snapshot saved at eviction time.
 * - Idle eviction: `sweepIdle(nowMs)` evicts every running runtime
 *   whose last activity is older than its idle timeout. Eviction is
 *   clean: the runtime's state snapshot is saved first
 *   (`savedState`), the eviction is recorded in the eviction ledger
 *   (conversation, reason, idle time), and the slot is freed.
 * - Concurrency cap: `maxConcurrentRuntimes` bounds how many
 *   runtimes run at once. A start past the cap is queued (bounded
 *   waiting queue, FIFO) and promoted automatically when a slot
 *   frees; a queued start that waits past `queueMaxWaitMs` expires.
 * - Health probe + auto-restart: `probe(conversationId, healthy,
 *   nowMs)` records a probe result. A failed probe marks the
 *   runtime `degraded`; consecutive failures trigger an automatic
 *   restart (up to `maxRestarts` per runtime); past that the
 *   runtime is `failed` with a reason and its slot is freed.
 * - Usage: the host reports live usage (`recordUsage`); usage past
 *   a limit is flagged per resource (`overLimit` list) but never
 *   silently dropped — the caller decides whether to stop the
 *   runtime.
 *
 * The conversation API is untouched: callers keep addressing a
 * conversation by id; the runtime is an attached, per-conversation
 * execution context. All time flows through an explicit `nowMs`
 * parameter (default `Date.now()`) so tests are deterministic.
 * Self-contained: no imports from fleet v24–v27.
 */

/** Resource limits for one conversation runtime. */
export interface FleetV28RuntimeLimits {
  /** Max CPU cores this runtime may use (> 0, <= 64). */
  cpuCores: number;
  /** Max RAM, MiB (> 0, <= 65536). */
  ramMB: number;
  /** Max disk, MiB (> 0, <= 1048576). */
  diskMB: number;
  /** Wall-clock timeout for one run, ms (>= 1000). */
  timeoutMs: number;
  /** Idle time after which the runtime is evicted, ms (>= 1000). */
  idleTimeoutMs: number;
  /** Max automatic restarts after failed health probes (>= 0). */
  maxRestarts: number;
}

/** Default limits for a conversation runtime (medium preset). */
export const FLEET_V28_DEFAULT_RUNTIME_LIMITS: FleetV28RuntimeLimits = {
  cpuCores: 1,
  ramMB: 2048,
  diskMB: 5120,
  timeoutMs: 30 * 60 * 1000,
  idleTimeoutMs: 15 * 60 * 1000,
  maxRestarts: 3,
};

/** Hard bounds for limit validation (host sanity caps). */
export const FLEET_V28_RUNTIME_LIMIT_BOUNDS = {
  cpuCores: { min: 0.1, max: 64 },
  ramMB: { min: 64, max: 65536 },
  diskMB: { min: 64, max: 1048576 },
  timeoutMs: { min: 1000, max: 24 * 60 * 60 * 1000 },
  idleTimeoutMs: { min: 1000, max: 24 * 60 * 60 * 1000 },
  maxRestarts: { min: 0, max: 10 },
} as const;

/** Lifecycle state of one conversation runtime. */
export type FleetV28RuntimeState =
  | 'starting'
  | 'running'
  | 'stopped'
  | 'evicted'
  | 'failed'
  | 'restarting';

/** Health of one conversation runtime (from probes). */
export type FleetV28RuntimeHealth = 'ok' | 'degraded' | 'failed' | 'unknown';

/** Live resource usage the host reports for a runtime. */
export interface FleetV28RuntimeUsage {
  /** CPU cores currently used. */
  cpuCores: number;
  /** RAM, MiB, currently used. */
  ramMB: number;
  /** Disk, MiB, currently used. */
  diskMB: number;
}

/** One per-conversation sandbox runtime. */
export interface ConversationRuntime {
  /** Conversation this runtime belongs to (unique). */
  conversationId: string;
  /** Bot/profile that owns the conversation. */
  profileId: string;
  /** Optional bot id (empty when the conversation has no bot). */
  botId: string;
  /** Lifecycle state. */
  state: FleetV28RuntimeState;
  /** Last probe health. */
  health: FleetV28RuntimeHealth;
  /** Limits this runtime runs under. */
  limits: FleetV28RuntimeLimits;
  /** Live usage (host-reported; zeros until reported). */
  usage: FleetV28RuntimeUsage;
  /** Resources currently over their limit (empty = within limits). */
  overLimit: Array<'cpu' | 'ram' | 'disk'>;
  /** When the runtime started (ms epoch). */
  startedAtMs: number;
  /** Last activity (message/tool call/probe), ms epoch. */
  lastActivityMs: number;
  /** When the runtime stopped / was evicted / failed (null = active). */
  endedAtMs: number | null;
  /** How many times this runtime auto/manual-restarted. */
  restarts: number;
  /** Consecutive failed health probes (resets on a healthy probe). */
  consecutiveFailures: number;
  /** When the last probe ran (null = never probed). */
  lastProbeMs: number | null;
  /** State snapshot saved at eviction/stop (JSON string, null = none). */
  savedState: string | null;
  /** Why the runtime failed / was evicted (null = n/a). */
  failureReason: string | null;
}

/** One eviction ledger entry (audit trail for idle evictions). */
export interface FleetV28EvictionRecord {
  /** Conversation that was evicted. */
  conversationId: string;
  /** Owning profile. */
  profileId: string;
  /** When the eviction happened, ms epoch. */
  evictedAtMs: number;
  /** How long the runtime had been idle, ms. */
  idleMs: number;
  /** Idle timeout that was exceeded, ms. */
  idleTimeoutMs: number;
  /** Whether a state snapshot was saved before eviction. */
  stateSaved: boolean;
  /** Human-readable reason (English). */
  reason: string;
}

/** One entry in the waiting queue (start past the concurrency cap). */
export interface FleetV28RuntimeQueuedStart {
  /** Conversation waiting for a slot. */
  conversationId: string;
  /** Owning profile. */
  profileId: string;
  /** Optional bot id. */
  botId: string;
  /** Limits the queued start wants. */
  limits: FleetV28RuntimeLimits;
  /** When the start was queued, ms epoch. */
  queuedAtMs: number;
  /** Queue position (1 = head). */
  position: number;
}

/** Store-level configuration. */
export interface FleetV28RuntimeStoreConfig {
  /** Max runtimes running at once (> 0). */
  maxConcurrentRuntimes: number;
  /** Default limits for starts that pass none. */
  defaultLimits: FleetV28RuntimeLimits;
  /** Max ms a queued start waits before it expires (>= 0; 0 = never). */
  queueMaxWaitMs: number;
  /** Max queued starts waiting (0 = queue disabled, excess rejected). */
  queueMaxLength: number;
}

/** Default store configuration. */
export const FLEET_V28_DEFAULT_RUNTIME_STORE_CONFIG: FleetV28RuntimeStoreConfig = {
  maxConcurrentRuntimes: 8,
  defaultLimits: FLEET_V28_DEFAULT_RUNTIME_LIMITS,
  queueMaxWaitMs: 5 * 60 * 1000,
  queueMaxLength: 32,
};

/** Result of `startRuntime` (started now, or queued, or refused). */
export type FleetV28StartResult =
  | { ok: true; status: 'started'; runtime: ConversationRuntime }
  | { ok: true; status: 'queued'; position: number; conversationId: string }
  | { ok: false; status: 'refused'; reasons: string[] };

/** Result of `sweepIdle` (which runtimes were evicted). */
export interface FleetV28SweepResult {
  /** Conversations evicted by this sweep. */
  evicted: string[];
  /** Eviction records written by this sweep. */
  records: FleetV28EvictionRecord[];
  /** Queued starts promoted into the freed slots. */
  promoted: string[];
}

/** Validate runtime limits; returns reasons (empty = valid). */
export function validateFleetV28RuntimeLimits(
  limits: Partial<FleetV28RuntimeLimits> | null | undefined,
): string[] {
  const reasons: string[] = [];
  if (!limits || typeof limits !== 'object') return ['Limits must be an object.'];
  const b = FLEET_V28_RUNTIME_LIMIT_BOUNDS;
  const check = (key: keyof FleetV28RuntimeLimits, label: string): void => {
    const v = limits[key];
    if (v === undefined || v === null) {
      reasons.push(`${label} is required.`);
      return;
    }
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      reasons.push(`${label} must be a number.`);
      return;
    }
    const bound = b[key] as { min: number; max: number };
    if (v < bound.min || v > bound.max) {
      reasons.push(`${label} must be between ${bound.min} and ${bound.max}.`);
    }
  };
  check('cpuCores', 'cpuCores');
  check('ramMB', 'ramMB');
  check('diskMB', 'diskMB');
  check('timeoutMs', 'timeoutMs');
  check('idleTimeoutMs', 'idleTimeoutMs');
  check('maxRestarts', 'maxRestarts');
  if (
    typeof limits.maxRestarts === 'number' &&
    Number.isFinite(limits.maxRestarts) &&
    !Number.isInteger(limits.maxRestarts)
  ) {
    reasons.push('maxRestarts must be an integer.');
  }
  return reasons;
}

/** Merge partial limits over defaults (missing fields fall back). */
export function resolveFleetV28RuntimeLimits(
  partial: Partial<FleetV28RuntimeLimits> | null | undefined,
  defaults: FleetV28RuntimeLimits = FLEET_V28_DEFAULT_RUNTIME_LIMITS,
): FleetV28RuntimeLimits {
  return {
    cpuCores: partial?.cpuCores ?? defaults.cpuCores,
    ramMB: partial?.ramMB ?? defaults.ramMB,
    diskMB: partial?.diskMB ?? defaults.diskMB,
    timeoutMs: partial?.timeoutMs ?? defaults.timeoutMs,
    idleTimeoutMs: partial?.idleTimeoutMs ?? defaults.idleTimeoutMs,
    maxRestarts: partial?.maxRestarts ?? defaults.maxRestarts,
  };
}

/** Validate a conversation id / profile id (non-empty, no whitespace). */
export function fleetV28IdValid(id: string | null | undefined): boolean {
  return typeof id === 'string' && id.trim() !== '' && !/\s/.test(id);
}

/** Build the state snapshot saved at eviction/stop (JSON string). */
export function buildFleetV28SavedState(runtime: ConversationRuntime): string {
  return JSON.stringify({
    conversationId: runtime.conversationId,
    profileId: runtime.profileId,
    botId: runtime.botId,
    usage: runtime.usage,
    restarts: runtime.restarts,
    lastActivityMs: runtime.lastActivityMs,
    savedAtMs: Date.now(),
    version: 1,
  });
}

/**
 * Per-conversation sandbox runtime store.
 *
 * Owns the lifecycle of every conversation runtime: start/stop/
 * restart, idle eviction with a saved state snapshot, the bounded
 * concurrency cap + waiting queue, and health probes with
 * auto-restart. Pure state + decisions — the host enforces limits
 * (cgroups/Docker) and restores snapshots; this store only records
 * what the host must do and what already happened.
 */
export class FleetV28RuntimeStore {
  private readonly config: FleetV28RuntimeStoreConfig;
  private readonly runtimes = new Map<string, ConversationRuntime>();
  private readonly queue: FleetV28RuntimeQueuedStart[] = [];
  private readonly evictions: FleetV28EvictionRecord[] = [];

  constructor(config: Partial<FleetV28RuntimeStoreConfig> = {}) {
    const merged: FleetV28RuntimeStoreConfig = {
      maxConcurrentRuntimes:
        config.maxConcurrentRuntimes ?? FLEET_V28_DEFAULT_RUNTIME_STORE_CONFIG.maxConcurrentRuntimes,
      defaultLimits: config.defaultLimits ?? FLEET_V28_DEFAULT_RUNTIME_STORE_CONFIG.defaultLimits,
      queueMaxWaitMs: config.queueMaxWaitMs ?? FLEET_V28_DEFAULT_RUNTIME_STORE_CONFIG.queueMaxWaitMs,
      queueMaxLength: config.queueMaxLength ?? FLEET_V28_DEFAULT_RUNTIME_STORE_CONFIG.queueMaxLength,
    };
    if (!Number.isInteger(merged.maxConcurrentRuntimes) || merged.maxConcurrentRuntimes < 1) {
      throw new Error('maxConcurrentRuntimes must be an integer >= 1.');
    }
    if (!Number.isInteger(merged.queueMaxLength) || merged.queueMaxLength < 0) {
      throw new Error('queueMaxLength must be an integer >= 0.');
    }
    if (typeof merged.queueMaxWaitMs !== 'number' || merged.queueMaxWaitMs < 0) {
      throw new Error('queueMaxWaitMs must be a number >= 0.');
    }
    const limitReasons = validateFleetV28RuntimeLimits(merged.defaultLimits);
    if (limitReasons.length > 0) {
      throw new Error(`Invalid defaultLimits: ${limitReasons.join(', ')}`);
    }
    this.config = merged;
  }

  /** Store configuration (copy). */
  getConfig(): FleetV28RuntimeStoreConfig {
    return { ...this.config, defaultLimits: { ...this.config.defaultLimits } };
  }

  /** How many runtimes are currently running/starting. */
  runningCount(): number {
    let n = 0;
    for (const r of this.runtimes.values()) {
      if (r.state === 'running' || r.state === 'starting' || r.state === 'restarting') n += 1;
    }
    return n;
  }

  /** How many runtimes the store holds in total (any state). */
  totalCount(): number {
    return this.runtimes.size;
  }

  /** Get one runtime (undefined when absent). Returns a copy. */
  getRuntime(conversationId: string): ConversationRuntime | undefined {
    const r = this.runtimes.get(conversationId);
    return r ? copyRuntime(r) : undefined;
  }

  /** List runtimes (running first, then by start time, newest first). */
  listRuntimes(state?: FleetV28RuntimeState): ConversationRuntime[] {
    const all = [...this.runtimes.values()].map(copyRuntime);
    const filtered = state ? all.filter((r) => r.state === state) : all;
    const rank = (s: FleetV28RuntimeState): number =>
      s === 'running' ? 0 : s === 'starting' ? 1 : s === 'restarting' ? 2 : s === 'evicted' ? 3 : s === 'failed' ? 4 : 5;
    return filtered.sort((a, b) => rank(a.state) - rank(b.state) || b.startedAtMs - a.startedAtMs);
  }

  /** List runtimes owned by one profile. */
  listRuntimesByProfile(profileId: string): ConversationRuntime[] {
    return this.listRuntimes().filter((r) => r.profileId === profileId);
  }

  /**
   * Start a runtime for a conversation.
   *
   * - Refused when the ids are invalid, the limits are invalid, or a
   *   live runtime already exists for the conversation.
   * - A stopped/evicted/failed runtime for the same conversation is
   *   revived: a fresh start that restores `savedState` when present.
   * - Past the concurrency cap the start is queued (bounded queue);
   *   past the queue it is refused.
   */
  startRuntime(
    conversationId: string,
    profileId: string,
    opts: {
      botId?: string;
      limits?: Partial<FleetV28RuntimeLimits>;
      nowMs?: number;
    } = {},
  ): FleetV28StartResult {
    const nowMs = opts.nowMs ?? Date.now();
    const reasons: string[] = [];
    if (!fleetV28IdValid(conversationId)) reasons.push('conversationId must be a non-empty id without whitespace.');
    if (!fleetV28IdValid(profileId)) reasons.push('profileId must be a non-empty id without whitespace.');
    const limits = resolveFleetV28RuntimeLimits(opts.limits, this.config.defaultLimits);
    reasons.push(...validateFleetV28RuntimeLimits(limits));
    if (reasons.length > 0) return { ok: false, status: 'refused', reasons };
    const existing = this.runtimes.get(conversationId);
    if (existing && (existing.state === 'running' || existing.state === 'starting' || existing.state === 'restarting')) {
      return { ok: false, status: 'refused', reasons: [`Runtime for conversation "${conversationId}" is already ${existing.state}.`] };
    }
    this.expireQueue(nowMs);
    if (this.runningCount() >= this.config.maxConcurrentRuntimes) {
      if (this.config.queueMaxLength === 0 || this.queue.length >= this.config.queueMaxLength) {
        return { ok: false, status: 'refused', reasons: ['Concurrency cap reached and the waiting queue is full.'] };
      }
      const queued: FleetV28RuntimeQueuedStart = {
        conversationId,
        profileId,
        botId: opts.botId ?? '',
        limits,
        queuedAtMs: nowMs,
        position: this.queue.length + 1,
      };
      this.queue.push(queued);
      return { ok: true, status: 'queued', position: queued.position, conversationId };
    }
    const runtime = this.createRuntime(conversationId, profileId, opts.botId ?? '', limits, nowMs, existing?.savedState ?? null, existing?.restarts ?? 0);
    this.runtimes.set(conversationId, runtime);
    return { ok: true, status: 'started', runtime: copyRuntime(runtime) };
  }

  /** Stop a runtime (saves a state snapshot first). */
  stopRuntime(conversationId: string, nowMs: number = Date.now()): ConversationRuntime | null {
    const r = this.runtimes.get(conversationId);
    if (!r) return null;
    if (r.state === 'stopped' || r.state === 'evicted' || r.state === 'failed') return copyRuntime(r);
    r.savedState = buildFleetV28SavedState(r);
    r.state = 'stopped';
    r.endedAtMs = nowMs;
    r.health = 'unknown';
    this.promoteQueue(nowMs);
    return copyRuntime(r);
  }

  /**
   * Restart a runtime: stopped/evicted/failed runtimes start again
   * (restoring the saved snapshot when one exists); a running
   * runtime is restarted in place (state `restarting` -> `running`,
   * restarts + 1).
   */
  restartRuntime(conversationId: string, nowMs: number = Date.now()): ConversationRuntime | null {
    const r = this.runtimes.get(conversationId);
    if (!r) return null;
    if (r.state === 'running' || r.state === 'starting') {
      r.state = 'restarting';
      r.restarts += 1;
      r.consecutiveFailures = 0;
      r.health = 'unknown';
      r.lastActivityMs = nowMs;
      r.state = 'running';
      return copyRuntime(r);
    }
    if (this.runningCount() >= this.config.maxConcurrentRuntimes) {
      // No free slot: queue the restart instead of dropping it.
      if (this.config.queueMaxLength > 0 && this.queue.length < this.config.queueMaxLength) {
        this.queue.push({
          conversationId,
          profileId: r.profileId,
          botId: r.botId,
          limits: { ...r.limits },
          queuedAtMs: nowMs,
          position: this.queue.length + 1,
        });
      }
      return copyRuntime(r);
    }
    const revived = this.createRuntime(
      conversationId,
      r.profileId,
      r.botId,
      { ...r.limits },
      nowMs,
      r.savedState,
      r.restarts + 1,
    );
    this.runtimes.set(conversationId, revived);
    return copyRuntime(revived);
  }

  /** Record activity (message / tool call) — resets the idle clock. */
  touch(conversationId: string, nowMs: number = Date.now()): boolean {
    const r = this.runtimes.get(conversationId);
    if (!r || r.state !== 'running') return false;
    r.lastActivityMs = nowMs;
    return true;
  }

  /** Host-reported live usage; flags resources over their limit. */
  recordUsage(conversationId: string, usage: FleetV28RuntimeUsage, nowMs: number = Date.now()): ConversationRuntime | null {
    const r = this.runtimes.get(conversationId);
    if (!r) return null;
    r.usage = { ...usage };
    r.lastActivityMs = nowMs;
    const over: Array<'cpu' | 'ram' | 'disk'> = [];
    if (usage.cpuCores > r.limits.cpuCores) over.push('cpu');
    if (usage.ramMB > r.limits.ramMB) over.push('ram');
    if (usage.diskMB > r.limits.diskMB) over.push('disk');
    r.overLimit = over;
    return copyRuntime(r);
  }

  /** Update one runtime's limits (validated; refused when invalid). */
  setLimits(
    conversationId: string,
    partial: Partial<FleetV28RuntimeLimits>,
  ): { ok: boolean; runtime?: ConversationRuntime; reasons?: string[] } {
    const r = this.runtimes.get(conversationId);
    if (!r) return { ok: false, reasons: [`No runtime for conversation "${conversationId}".`] };
    const merged = resolveFleetV28RuntimeLimits(partial, r.limits);
    const reasons = validateFleetV28RuntimeLimits(merged);
    if (reasons.length > 0) return { ok: false, reasons };
    r.limits = merged;
    r.overLimit = computeOverLimit(r.usage, merged);
    return { ok: true, runtime: copyRuntime(r) };
  }

  /**
   * Record a health probe.
   *
   * - Healthy: health `ok`, consecutive failures reset, activity
   *   clock touched.
   * - Failed: health `degraded`, failures + 1. `maxRestarts` is a
   *   TOTAL auto-restart budget for the runtime: while restarts
   *   remain, the runtime auto-restarts in place (restarts + 1,
   *   failures reset) and stays `running`; once the budget is
   *   spent, the next failed probe marks the runtime `failed`
   *   with a reason and frees its slot.
   * Returns the runtime after the probe (null when absent).
   */
  probe(conversationId: string, healthy: boolean, nowMs: number = Date.now()): ConversationRuntime | null {
    const r = this.runtimes.get(conversationId);
    if (!r) return null;
    if (r.state !== 'running' && r.state !== 'starting') return copyRuntime(r);
    r.lastProbeMs = nowMs;
    if (healthy) {
      r.health = 'ok';
      r.consecutiveFailures = 0;
      r.lastActivityMs = nowMs;
      return copyRuntime(r);
    }
    r.consecutiveFailures += 1;
    if (r.restarts >= r.limits.maxRestarts) {
      r.health = 'failed';
      r.state = 'failed';
      r.endedAtMs = nowMs;
      r.failureReason = `Health probe failed ${r.consecutiveFailures} time(s) in a row (maxRestarts ${r.limits.maxRestarts} already used).`;
      r.savedState = buildFleetV28SavedState(r);
      this.promoteQueue(nowMs);
      return copyRuntime(r);
    }
    r.health = 'degraded';
    r.state = 'restarting';
    r.restarts += 1;
    r.consecutiveFailures = 0;
    r.state = 'running';
    r.lastActivityMs = nowMs;
    return copyRuntime(r);
  }

  /**
   * Evict every running runtime idle past its idle timeout.
   * Eviction saves a state snapshot first, writes the eviction
   * ledger, frees the slot, and promotes queued starts.
   */
  sweepIdle(nowMs: number = Date.now()): FleetV28SweepResult {
    const evicted: string[] = [];
    const records: FleetV28EvictionRecord[] = [];
    for (const r of this.runtimes.values()) {
      if (r.state !== 'running') continue;
      const idleMs = nowMs - r.lastActivityMs;
      if (idleMs < r.limits.idleTimeoutMs) continue;
      r.savedState = buildFleetV28SavedState(r);
      r.state = 'evicted';
      r.endedAtMs = nowMs;
      r.health = 'unknown';
      r.failureReason = `Evicted after ${idleMs}ms idle (idleTimeoutMs ${r.limits.idleTimeoutMs}).`;
      const record: FleetV28EvictionRecord = {
        conversationId: r.conversationId,
        profileId: r.profileId,
        evictedAtMs: nowMs,
        idleMs,
        idleTimeoutMs: r.limits.idleTimeoutMs,
        stateSaved: r.savedState !== null,
        reason: r.failureReason,
      };
      this.evictions.push(record);
      records.push(record);
      evicted.push(r.conversationId);
    }
    const promoted = this.promoteQueue(nowMs);
    return { evicted, records, promoted };
  }

  /** Eviction ledger (newest first). */
  listEvictions(): FleetV28EvictionRecord[] {
    return [...this.evictions].reverse();
  }

  /** Waiting queue (head first, positions recomputed). */
  listQueue(): FleetV28RuntimeQueuedStart[] {
    return this.queue.map((q, i) => ({ ...q, limits: { ...q.limits }, position: i + 1 }));
  }

  /** Expire queued starts older than `queueMaxWaitMs` (0 = never). */
  expireQueue(nowMs: number = Date.now()): string[] {
    if (this.config.queueMaxWaitMs === 0) return [];
    const expired: string[] = [];
    for (let i = this.queue.length - 1; i >= 0; i -= 1) {
      if (nowMs - this.queue[i].queuedAtMs > this.config.queueMaxWaitMs) {
        expired.push(this.queue[i].conversationId);
        this.queue.splice(i, 1);
      }
    }
    return expired.reverse();
  }

  /** Promote queued starts into free slots (FIFO). Returns promoted ids. */
  promoteQueue(nowMs: number = Date.now()): string[] {
    this.expireQueue(nowMs);
    const promoted: string[] = [];
    while (this.queue.length > 0 && this.runningCount() < this.config.maxConcurrentRuntimes) {
      const next = this.queue.shift();
      if (!next) break;
      const existing = this.runtimes.get(next.conversationId);
      const runtime = this.createRuntime(
        next.conversationId,
        next.profileId,
        next.botId,
        next.limits,
        nowMs,
        existing?.savedState ?? null,
        existing?.restarts ?? 0,
      );
      this.runtimes.set(next.conversationId, runtime);
      promoted.push(next.conversationId);
    }
    return promoted;
  }

  /** Aggregate usage across running runtimes (for the dashboard). */
  aggregateUsage(): FleetV28RuntimeUsage & { running: number; queued: number } {
    let cpuCores = 0;
    let ramMB = 0;
    let diskMB = 0;
    for (const r of this.runtimes.values()) {
      if (r.state !== 'running') continue;
      cpuCores += r.usage.cpuCores;
      ramMB += r.usage.ramMB;
      diskMB += r.usage.diskMB;
    }
    return { cpuCores, ramMB, diskMB, running: this.runningCount(), queued: this.queue.length };
  }

  private createRuntime(
    conversationId: string,
    profileId: string,
    botId: string,
    limits: FleetV28RuntimeLimits,
    nowMs: number,
    savedState: string | null,
    restarts: number,
  ): ConversationRuntime {
    return {
      conversationId,
      profileId,
      botId,
      state: 'running',
      health: 'unknown',
      limits: { ...limits },
      usage: { cpuCores: 0, ramMB: 0, diskMB: 0 },
      overLimit: [],
      startedAtMs: nowMs,
      lastActivityMs: nowMs,
      endedAtMs: null,
      restarts,
      consecutiveFailures: 0,
      lastProbeMs: null,
      savedState,
      failureReason: null,
    };
  }
}

function computeOverLimit(usage: FleetV28RuntimeUsage, limits: FleetV28RuntimeLimits): Array<'cpu' | 'ram' | 'disk'> {
  const over: Array<'cpu' | 'ram' | 'disk'> = [];
  if (usage.cpuCores > limits.cpuCores) over.push('cpu');
  if (usage.ramMB > limits.ramMB) over.push('ram');
  if (usage.diskMB > limits.diskMB) over.push('disk');
  return over;
}

function copyRuntime(r: ConversationRuntime): ConversationRuntime {
  return {
    ...r,
    limits: { ...r.limits },
    usage: { ...r.usage },
    overLimit: [...r.overLimit],
  };
}

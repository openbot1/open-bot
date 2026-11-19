/**
 * Fleet quota v2 — fleet-level quotas + alerts + exhaustion policy (v1.40, Team T6).
 *
 * Fleet v26 grants quotas PER BOT (what one bot may hold). Quota v2
 * answers the fleet-level question: how much may the FLEET as a whole
 * use, and what happens when it runs out? The fleet quota caps CPU /
 * RAM / disk, concurrent bots, active campaigns, runs per day, and
 * total bots — and every admission decision carries its reasons.
 *
 * Three pieces:
 * - Limits + live usage snapshot -> per-resource ratios and alert
 *   levels (ok < warn 80% < critical 95%).
 * - Admission: `evaluateFleetV27Quota` decides admit / queue / defer /
 *   reject for one request, honouring the operator's exhaustion
 *   policy (queue it, defer it to later, or reject it with a reason).
 * - A bounded waiting queue for queued requests (position, expiry,
 *   promotion when capacity frees) + a decision ledger for audit.
 *
 * This module only DECIDES — it never kills a process, never touches
 * cgroups, and never spawns anything. Enforcement stays with the host.
 * Self-contained: no imports from fleet v24/v25/v26.
 */

/** Fleet-level resource limits (null disk = disk unknown, disk capped at 0). */
export interface FleetV27QuotaLimits {
  /** Max CPU cores the fleet may use (total, across bots). */
  cpuCores: number;
  /** Max RAM, MiB, the fleet may use. */
  ramMB: number;
  /** Max disk, MiB (null = unknown host disk, disk requests refused). */
  diskMB: number | null;
  /** Max bots running at once. */
  maxConcurrentBots: number;
  /** Max campaigns active at once. */
  maxCampaigns: number;
  /** Max campaign runs started per day. */
  maxRunsPerDay: number;
  /** Max bots registered in the fleet. */
  maxBotsTotal: number;
}

/** Live usage snapshot the host reports. */
export interface FleetV27QuotaUsage {
  /** CPU cores currently used. */
  cpuCores: number;
  /** RAM, MiB, currently used. */
  ramMB: number;
  /** Disk, MiB, currently used. */
  diskMB: number;
  /** Bots currently running. */
  runningBots: number;
  /** Campaigns currently active. */
  activeCampaigns: number;
  /** Campaign runs started today. */
  runsToday: number;
  /** Bots registered in total. */
  totalBots: number;
}

/** One admission request (what the caller wants to add). */
export interface FleetV27QuotaRequest {
  /** What is being admitted (for the ledger + messages). */
  kind: 'bot-start' | 'campaign-start' | 'campaign-run' | 'bot-register';
  /** CPU cores the request needs (0 = none). */
  cpuCores?: number;
  /** RAM, MiB, the request needs (0 = none). */
  ramMB?: number;
  /** Disk, MiB, the request needs (0 = none). */
  diskMB?: number;
  /** Extra bots it would run (+1 for a bot start). */
  extraRunningBots?: number;
  /** Extra active campaigns (+1 for a campaign start). */
  extraCampaigns?: number;
  /** Extra runs today (+1 for a campaign run). */
  extraRunsToday?: number;
  /** Extra registered bots (+1 for a bot register). */
  extraTotalBots?: number;
}

/** What to do when a resource is exhausted. */
export type FleetV27ExhaustionAction = 'queue' | 'defer' | 'reject';

/** The operator's policy for each exhausted resource. */
export interface FleetV27QuotaPolicy {
  /** When CPU is exhausted. */
  onCpuExhausted: FleetV27ExhaustionAction;
  /** When RAM is exhausted. */
  onRamExhausted: FleetV27ExhaustionAction;
  /** When disk is exhausted (or unknown). */
  onDiskExhausted: FleetV27ExhaustionAction;
  /** When the concurrent-bot cap is hit. */
  onBotCountExhausted: FleetV27ExhaustionAction;
  /** When the active-campaign cap is hit. */
  onCampaignExhausted: FleetV27ExhaustionAction;
  /** When the daily-run cap is hit. */
  onRunsExhausted: FleetV27ExhaustionAction;
  /** When the total-bot cap is hit. */
  onTotalBotsExhausted: FleetV27ExhaustionAction;
  /** Max ms a queued request waits before it expires. */
  queueMaxWaitMs: number;
  /** Max requests waiting in the queue. */
  queueMaxLength: number;
}

/** Alert level for one resource. */
export type FleetV27AlertLevel = 'ok' | 'warn' | 'critical';

/** One resource's alert. */
export interface FleetV27QuotaAlert {
  /** Resource name. */
  resource: 'cpu' | 'ram' | 'disk' | 'concurrent-bots' | 'campaigns' | 'runs-today' | 'total-bots';
  /** Used / limit (0..1+, null when the limit is unknown). */
  ratio: number | null;
  /** Alert level. */
  level: FleetV27AlertLevel;
  /** Human-readable one-liner (English). */
  message: string;
}

/** Why an admission was refused / queued / deferred. */
export type FleetV27QuotaReason =
  | 'ok'
  | 'cpu-over-limit'
  | 'ram-over-limit'
  | 'disk-over-limit'
  | 'disk-unknown'
  | 'concurrent-bots-over-limit'
  | 'campaigns-over-limit'
  | 'runs-today-over-limit'
  | 'total-bots-over-limit'
  | 'invalid-request'
  | 'queue-full';

/** Outcome of one admission decision. */
export type FleetV27QuotaDecision = 'admit' | 'queue' | 'defer' | 'reject';

/** Result of evaluating one request. */
export interface FleetV27QuotaEvaluation {
  /** The decision. */
  decision: FleetV27QuotaDecision;
  /** The request kind. */
  kind: FleetV27QuotaRequest['kind'];
  /** Reasons (['ok'] when admitted). */
  reasons: FleetV27QuotaReason[];
  /** Human-readable one-liners (English; UI uses i18n keys). */
  messages: string[];
  /** Usage after the request (null when not admitted). */
  usageAfter: FleetV27QuotaUsage | null;
  /** Alerts that fire at the post-request usage. */
  alerts: FleetV27QuotaAlert[];
}

/** One queued request. */
export interface FleetV27QueuedRequest {
  /** Queue entry id. */
  id: string;
  /** The request waiting. */
  request: FleetV27QuotaRequest;
  /** When it was queued. */
  enqueuedAtMs: number;
  /** When it expires (enqueuedAtMs + queueMaxWaitMs). */
  expiresAtMs: number;
  /** Position in the queue (0 = head). */
  position: number;
}

/** One ledger line (bounded, newest last). */
export interface FleetV27QuotaLedgerEntry {
  /** When the decision was made. */
  atMs: number;
  /** Request kind. */
  kind: FleetV27QuotaRequest['kind'];
  /** Decision taken. */
  decision: FleetV27QuotaDecision;
  /** Reasons. */
  reasons: FleetV27QuotaReason[];
}

/** Warn at 80% of a limit. */
export const FLEET_V27_QUOTA_WARN_RATIO = 0.8;
/** Critical at 95% of a limit. */
export const FLEET_V27_QUOTA_CRITICAL_RATIO = 0.95;
/** Default limits (a modest laptop fleet: 4 cores / 8 GiB / 50 GiB). */
export const FLEET_V27_DEFAULT_LIMITS: FleetV27QuotaLimits = {
  cpuCores: 4,
  ramMB: 8192,
  diskMB: 51200,
  maxConcurrentBots: 8,
  maxCampaigns: 4,
  maxRunsPerDay: 50,
  maxBotsTotal: 50,
};
/** Default policy: queue bots/campaigns, defer runs, reject over-register. */
export const FLEET_V27_DEFAULT_POLICY: FleetV27QuotaPolicy = {
  onCpuExhausted: 'queue',
  onRamExhausted: 'queue',
  onDiskExhausted: 'reject',
  onBotCountExhausted: 'queue',
  onCampaignExhausted: 'queue',
  onRunsExhausted: 'defer',
  onTotalBotsExhausted: 'reject',
  queueMaxWaitMs: 30 * 60 * 1000,
  queueMaxLength: 20,
};
/** Max ledger lines kept (oldest drop first). */
export const FLEET_V27_LEDGER_MAX = 200;

/** Level for a ratio (null ratio = unknown -> ok, disk handled separately). */
export function fleetV27AlertLevelForRatio(ratio: number | null): FleetV27AlertLevel {
  if (ratio === null) return 'ok';
  if (ratio >= FLEET_V27_QUOTA_CRITICAL_RATIO) return 'critical';
  if (ratio >= FLEET_V27_QUOTA_WARN_RATIO) return 'warn';
  return 'ok';
}

/** Alerts for every resource at one usage snapshot. */
export function checkFleetV27QuotaAlerts(
  limits: FleetV27QuotaLimits,
  usage: FleetV27QuotaUsage,
): FleetV27QuotaAlert[] {
  const ratio = (used: number, limit: number): number | null => (limit <= 0 ? null : used / limit);
  const rows: Array<{ resource: FleetV27QuotaAlert['resource']; r: number | null; used: string; limit: string }> = [
    { resource: 'cpu', r: ratio(usage.cpuCores, limits.cpuCores), used: `${usage.cpuCores} cores`, limit: `${limits.cpuCores} cores` },
    { resource: 'ram', r: ratio(usage.ramMB, limits.ramMB), used: `${usage.ramMB} MiB`, limit: `${limits.ramMB} MiB` },
    { resource: 'disk', r: limits.diskMB === null ? null : ratio(usage.diskMB, limits.diskMB), used: `${usage.diskMB} MiB`, limit: limits.diskMB === null ? 'unknown' : `${limits.diskMB} MiB` },
    { resource: 'concurrent-bots', r: ratio(usage.runningBots, limits.maxConcurrentBots), used: `${usage.runningBots}`, limit: `${limits.maxConcurrentBots}` },
    { resource: 'campaigns', r: ratio(usage.activeCampaigns, limits.maxCampaigns), used: `${usage.activeCampaigns}`, limit: `${limits.maxCampaigns}` },
    { resource: 'runs-today', r: ratio(usage.runsToday, limits.maxRunsPerDay), used: `${usage.runsToday}`, limit: `${limits.maxRunsPerDay}` },
    { resource: 'total-bots', r: ratio(usage.totalBots, limits.maxBotsTotal), used: `${usage.totalBots}`, limit: `${limits.maxBotsTotal}` },
  ];
  return rows.map(({ resource, r, used, limit }) => {
    const level = resource === 'disk' && limits.diskMB === null
      ? 'warn'
      : fleetV27AlertLevelForRatio(r);
    const pct = r === null ? 'unknown' : `${Math.round(r * 100)}%`;
    const message = resource === 'disk' && limits.diskMB === null
      ? 'Disk limit unknown: disk-heavy requests are refused, not guessed.'
      : `${resource}: ${used} of ${limit} (${pct}) — ${level}.`;
    return { resource, ratio: r, level, message };
  });
}

/**
 * Evaluate one request against limits + current usage + policy.
 * Pure: no state, no side effects. The caller applies the result
 * (admit -> add usage; queue -> enqueue; defer/reject -> tell the user why).
 */
export function evaluateFleetV27Quota(
  limits: FleetV27QuotaLimits,
  usage: FleetV27QuotaUsage,
  request: FleetV27QuotaRequest,
  policy: FleetV27QuotaPolicy = FLEET_V27_DEFAULT_POLICY,
): FleetV27QuotaEvaluation {
  const reasons: FleetV27QuotaReason[] = [];
  const messages: string[] = [];
  const need = {
    cpu: request.cpuCores ?? 0,
    ram: request.ramMB ?? 0,
    disk: request.diskMB ?? 0,
    bots: request.extraRunningBots ?? 0,
    campaigns: request.extraCampaigns ?? 0,
    runs: request.extraRunsToday ?? 0,
    total: request.extraTotalBots ?? 0,
  };
  if (Object.values(need).some((v) => !Number.isFinite(v) || v < 0)) {
    return {
      decision: 'reject',
      kind: request.kind,
      reasons: ['invalid-request'],
      messages: ['Invalid request: all amounts must be finite numbers >= 0.'],
      usageAfter: null,
      alerts: checkFleetV27QuotaAlerts(limits, usage),
    };
  }
  const after: FleetV27QuotaUsage = {
    cpuCores: usage.cpuCores + need.cpu,
    ramMB: usage.ramMB + need.ram,
    diskMB: usage.diskMB + need.disk,
    runningBots: usage.runningBots + need.bots,
    activeCampaigns: usage.activeCampaigns + need.campaigns,
    runsToday: usage.runsToday + need.runs,
    totalBots: usage.totalBots + need.total,
  };
  // Per-resource breaches, in priority order (hardest first).
  const breaches: Array<{ reason: FleetV27QuotaReason; action: FleetV27ExhaustionAction; message: string }> = [];
  if (after.cpuCores > limits.cpuCores) {
    breaches.push({ reason: 'cpu-over-limit', action: policy.onCpuExhausted, message: `CPU ${after.cpuCores} cores would exceed the fleet limit of ${limits.cpuCores} cores.` });
  }
  if (after.ramMB > limits.ramMB) {
    breaches.push({ reason: 'ram-over-limit', action: policy.onRamExhausted, message: `RAM ${after.ramMB} MiB would exceed the fleet limit of ${limits.ramMB} MiB.` });
  }
  if (need.disk > 0 && limits.diskMB === null) {
    breaches.push({ reason: 'disk-unknown', action: policy.onDiskExhausted, message: 'Disk limit is unknown: disk requests are refused, not guessed.' });
  } else if (limits.diskMB !== null && after.diskMB > limits.diskMB) {
    breaches.push({ reason: 'disk-over-limit', action: policy.onDiskExhausted, message: `Disk ${after.diskMB} MiB would exceed the fleet limit of ${limits.diskMB} MiB.` });
  }
  if (after.runningBots > limits.maxConcurrentBots) {
    breaches.push({ reason: 'concurrent-bots-over-limit', action: policy.onBotCountExhausted, message: `${after.runningBots} running bots would exceed the cap of ${limits.maxConcurrentBots}.` });
  }
  if (after.activeCampaigns > limits.maxCampaigns) {
    breaches.push({ reason: 'campaigns-over-limit', action: policy.onCampaignExhausted, message: `${after.activeCampaigns} active campaigns would exceed the cap of ${limits.maxCampaigns}.` });
  }
  if (after.runsToday > limits.maxRunsPerDay) {
    breaches.push({ reason: 'runs-today-over-limit', action: policy.onRunsExhausted, message: `${after.runsToday} runs today would exceed the daily cap of ${limits.maxRunsPerDay}.` });
  }
  if (after.totalBots > limits.maxBotsTotal) {
    breaches.push({ reason: 'total-bots-over-limit', action: policy.onTotalBotsExhausted, message: `${after.totalBots} bots would exceed the fleet cap of ${limits.maxBotsTotal}.` });
  }
  if (breaches.length === 0) {
    return {
      decision: 'admit',
      kind: request.kind,
      reasons: ['ok'],
      messages: ['Admitted: fits inside the fleet quota.'],
      usageAfter: after,
      alerts: checkFleetV27QuotaAlerts(limits, after),
    };
  }
  // Worst action wins: reject > defer > queue.
  const rank: Record<FleetV27ExhaustionAction, number> = { queue: 0, defer: 1, reject: 2 };
  const worst = breaches.reduce((a, b) => (rank[b.action] > rank[a.action] ? b : a));
  const decision: FleetV27QuotaDecision = worst.action === 'reject' ? 'reject' : worst.action === 'defer' ? 'defer' : 'queue';
  for (const b of breaches) {
    reasons.push(b.reason);
    messages.push(`${b.message} Policy: ${b.action}.`);
  }
  return {
    decision,
    kind: request.kind,
    reasons,
    messages,
    usageAfter: null,
    alerts: checkFleetV27QuotaAlerts(limits, usage),
  };
}

/** Validate limits (all amounts finite and >= 0; counts are integers). */
export function validateFleetV27Limits(limits: Partial<FleetV27QuotaLimits>): string[] {
  const errors: string[] = [];
  const checkNum = (key: string, v: unknown, integer = false): void => {
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) errors.push(`${key} must be a number >= 0`);
    else if (integer && !Number.isInteger(v)) errors.push(`${key} must be an integer`);
  };
  if (limits.cpuCores !== undefined) checkNum('cpuCores', limits.cpuCores);
  if (limits.ramMB !== undefined) checkNum('ramMB', limits.ramMB);
  if (limits.diskMB !== undefined && limits.diskMB !== null) checkNum('diskMB', limits.diskMB);
  if (limits.maxConcurrentBots !== undefined) checkNum('maxConcurrentBots', limits.maxConcurrentBots, true);
  if (limits.maxCampaigns !== undefined) checkNum('maxCampaigns', limits.maxCampaigns, true);
  if (limits.maxRunsPerDay !== undefined) checkNum('maxRunsPerDay', limits.maxRunsPerDay, true);
  if (limits.maxBotsTotal !== undefined) checkNum('maxBotsTotal', limits.maxBotsTotal, true);
  return errors;
}

/**
 * Store for fleet quota v2: limits + policy + live usage + the
 * waiting queue + a bounded decision ledger (in-memory, JSON round-trip).
 */
export class FleetV27QuotaStore {
  private limits: FleetV27QuotaLimits = { ...FLEET_V27_DEFAULT_LIMITS };
  private policy: FleetV27QuotaPolicy = { ...FLEET_V27_DEFAULT_POLICY };
  private usage: FleetV27QuotaUsage = {
    cpuCores: 0, ramMB: 0, diskMB: 0, runningBots: 0, activeCampaigns: 0, runsToday: 0, totalBots: 0,
  };
  private queue: FleetV27QueuedRequest[] = [];
  private ledger: FleetV27QuotaLedgerEntry[] = [];
  private queueSeq = 0;

  /** Current limits. */
  getLimits(): FleetV27QuotaLimits {
    return { ...this.limits };
  }

  /** Replace limits (validated; returns errors, keeps old limits on error). */
  setLimits(next: Partial<FleetV27QuotaLimits>): { ok: boolean; errors: string[] } {
    const errors = validateFleetV27Limits(next);
    if (errors.length > 0) return { ok: false, errors };
    this.limits = { ...this.limits, ...next };
    return { ok: true, errors: [] };
  }

  /** Current policy. */
  getPolicy(): FleetV27QuotaPolicy {
    return { ...this.policy };
  }

  /** Replace the exhaustion policy. */
  setPolicy(next: Partial<FleetV27QuotaPolicy>): FleetV27QuotaPolicy {
    this.policy = { ...this.policy, ...next };
    return { ...this.policy };
  }

  /** Current usage snapshot. */
  getUsage(): FleetV27QuotaUsage {
    return { ...this.usage };
  }

  /** Replace the usage snapshot (the host reports real numbers). */
  setUsage(next: Partial<FleetV27QuotaUsage>): FleetV27QuotaUsage {
    this.usage = { ...this.usage, ...next };
    return { ...this.usage };
  }

  /** Alerts at the current usage. */
  alerts(): FleetV27QuotaAlert[] {
    return checkFleetV27QuotaAlerts(this.limits, this.usage);
  }

  /** Evaluate a request against the store's limits/usage/policy + ledger it. */
  evaluate(request: FleetV27QuotaRequest, nowMs: number = Date.now()): FleetV27QuotaEvaluation {
    const result = evaluateFleetV27Quota(this.limits, this.usage, request, this.policy);
    this.ledger.push({ atMs: nowMs, kind: request.kind, decision: result.decision, reasons: result.reasons });
    if (this.ledger.length > FLEET_V27_LEDGER_MAX) {
      this.ledger.splice(0, this.ledger.length - FLEET_V27_LEDGER_MAX);
    }
    if (result.decision === 'admit' && result.usageAfter) this.usage = result.usageAfter;
    return result;
  }

  /** Enqueue a request the policy says to queue (refused when full). */
  enqueue(
    request: FleetV27QuotaRequest,
    nowMs: number = Date.now(),
  ): { ok: boolean; entry?: FleetV27QueuedRequest; reason?: FleetV27QuotaReason } {
    if (this.queue.length >= this.policy.queueMaxLength) {
      return { ok: false, reason: 'queue-full' };
    }
    this.queueSeq += 1;
    const entry: FleetV27QueuedRequest = {
      id: `q-${String(this.queueSeq).padStart(4, '0')}`,
      request,
      enqueuedAtMs: nowMs,
      expiresAtMs: nowMs + this.policy.queueMaxWaitMs,
      position: this.queue.length,
    };
    this.queue.push(entry);
    return { ok: true, entry };
  }

  /** Current queue (head first). */
  listQueue(): FleetV27QueuedRequest[] {
    return this.queue.map((q, i) => ({ ...q, position: i }));
  }

  /** Drop expired entries (returns how many were dropped). */
  expireQueue(nowMs: number = Date.now()): number {
    const before = this.queue.length;
    this.queue = this.queue.filter((q) => q.expiresAtMs > nowMs);
    return before - this.queue.length;
  }

  /**
   * Promote the head of the queue when capacity freed: re-evaluate
   * it; admitted -> removed from the queue and usage applied;
   * still blocked -> stays queued (returns the evaluation).
   */
  promoteHead(nowMs: number = Date.now()): { ok: boolean; evaluation?: FleetV27QuotaEvaluation; reason?: string } {
    this.expireQueue(nowMs);
    const head = this.queue[0];
    if (!head) return { ok: false, reason: 'queue-empty' };
    const evaluation = evaluateFleetV27Quota(this.limits, this.usage, head.request, this.policy);
    this.ledger.push({ atMs: nowMs, kind: head.request.kind, decision: evaluation.decision, reasons: evaluation.reasons });
    if (this.ledger.length > FLEET_V27_LEDGER_MAX) {
      this.ledger.splice(0, this.ledger.length - FLEET_V27_LEDGER_MAX);
    }
    if (evaluation.decision === 'admit' && evaluation.usageAfter) {
      this.usage = evaluation.usageAfter;
      this.queue.shift();
      return { ok: true, evaluation };
    }
    return { ok: false, evaluation, reason: 'still-blocked' };
  }

  /** Decision ledger (oldest first, bounded). */
  getLedger(): FleetV27QuotaLedgerEntry[] {
    return [...this.ledger];
  }

  /** One-line summary (for the UI). */
  summarize(): string {
    const alerts = this.alerts();
    const critical = alerts.filter((a) => a.level === 'critical').length;
    const warn = alerts.filter((a) => a.level === 'warn').length;
    return `Quota: ${this.usage.runningBots}/${this.limits.maxConcurrentBots} bots, ${this.usage.cpuCores}/${this.limits.cpuCores} cores, ${this.usage.ramMB}/${this.limits.ramMB} MiB RAM — ${critical} critical, ${warn} warning, ${this.queue.length} queued.`;
  }

  /** JSON round-trip. */
  toJSON(): {
    limits: FleetV27QuotaLimits;
    policy: FleetV27QuotaPolicy;
    usage: FleetV27QuotaUsage;
    queue: FleetV27QueuedRequest[];
    ledger: FleetV27QuotaLedgerEntry[];
    queueSeq: number;
  } {
    return {
      limits: { ...this.limits },
      policy: { ...this.policy },
      usage: { ...this.usage },
      queue: [...this.queue],
      ledger: [...this.ledger],
      queueSeq: this.queueSeq,
    };
  }

  /** Restore from `toJSON` output (replaces current state). */
  static fromJSON(data: {
    limits?: FleetV27QuotaLimits;
    policy?: FleetV27QuotaPolicy;
    usage?: FleetV27QuotaUsage;
    queue?: FleetV27QueuedRequest[];
    ledger?: FleetV27QuotaLedgerEntry[];
    queueSeq?: number;
  }): FleetV27QuotaStore {
    const store = new FleetV27QuotaStore();
    if (data.limits) store.limits = { ...data.limits };
    if (data.policy) store.policy = { ...data.policy };
    if (data.usage) store.usage = { ...data.usage };
    store.queue = [...(data.queue ?? [])];
    store.ledger = [...(data.ledger ?? [])];
    store.queueSeq = data.queueSeq ?? store.queue.length;
    return store;
  }
}

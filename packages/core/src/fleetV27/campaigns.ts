/**
 * Campaigns v27 — async run campaigns (v1.40, Team T6).
 *
 * A campaign runs the SAME task across MANY bots in the background:
 * the operator defines the campaign (bots + task + concurrency), starts
 * it, and watches each bot's progress while the fleet works. This
 * module is the state machine + store only: it never runs a model,
 * never spawns a process, and never touches the network. The host
 * drives real bot execution and reports each bot's outcome back via
 * `advanceCampaignRun`; the engine decides what runs next, what
 * retries, what times out, and when the campaign is done.
 *
 * Lifecycle of one campaign run:
 *   pending -> running -> succeeded | partial | failed | cancelled
 * Lifecycle of one bot entry inside a run:
 *   queued -> running -> succeeded | failed | timed-out | skipped
 *   (failed may retry up to `maxRetries`, then stays failed)
 *   queued/running -> cancelled (when the run is cancelled)
 *
 * A finished run is kept as history: `listFinishedRuns` replays
 * results of campaigns that already ended (summary + per-bot rows),
 * so an operator can audit what happened without re-running anything.
 *
 * Follows the `fleetV26/bots.ts` + `fleetV25/scheduledRuns.ts` style:
 * small validated value objects, a store class with JSON round-trip,
 * and a one-line summary for the UI. Self-contained: no imports from
 * fleet v24/v25/v26 (v27 keeps its own stores).
 */

/** What a campaign asks every bot to do. */
export interface FleetV27CampaignTask {
  /** Task kind: a prompt for the bot's model, or a shell command. */
  kind: 'prompt' | 'command';
  /** The prompt text or command line. */
  text: string;
  /** Per-bot wall-clock timeout, ms (0 = no timeout). */
  timeoutMs?: number;
  /** Retries per bot after a failure (0 = no retry). */
  maxRetries?: number;
}

/** One bot inside a campaign definition. */
export interface FleetV27CampaignBot {
  /** Bot id (must be registered with the fleet by the host). */
  botId: string;
  /** Optional per-bot task override (replaces the campaign task). */
  taskOverride?: FleetV27CampaignTask;
}

/** A campaign definition (created once, run many times). */
export interface FleetV27Campaign {
  /** Stable id, e.g. `cmp-review-sprint-12`. */
  id: string;
  /** Human name. */
  name: string;
  /** Optional description. */
  description?: string;
  /** Bots the campaign runs on (at least 1). */
  bots: FleetV27CampaignBot[];
  /** The task every bot runs (unless overridden per bot). */
  task: FleetV27CampaignTask;
  /** How many bots run at once (1 = serial, >1 = parallel). */
  concurrency: number;
  /** Tags for filtering (e.g. `review`, `nightly`). */
  tags: string[];
  /** Who created it (user id or `local-user`). */
  createdBy: string;
  /** Creation time, ms since epoch. */
  createdAtMs: number;
}

/** Per-bot state inside one run. */
export type FleetV27BotRunState =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'timed-out'
  | 'skipped'
  | 'cancelled';

/** One bot's progress row inside a run. */
export interface FleetV27BotRunEntry {
  /** Bot id. */
  botId: string;
  /** Current state. */
  state: FleetV27BotRunState;
  /** Attempts used so far (1 = first try). */
  attempts: number;
  /** When the current attempt started (null = never started). */
  startedAtMs: number | null;
  /** When the entry reached a terminal state (null = not finished). */
  finishedAtMs: number | null;
  /** Outcome text from the bot (summary / error). */
  outcome: string | null;
  /** Error text when failed / timed-out. */
  error: string | null;
  /** Duration of the last finished attempt, ms (null = not finished). */
  durationMs: number | null;
}

/** Overall status of one campaign run. */
export type FleetV27CampaignRunStatus =
  | 'pending'
  | 'running'
  | 'succeeded'
  | 'partial'
  | 'failed'
  | 'cancelled';

/** One execution of a campaign (a run has many bot entries). */
export interface FleetV27CampaignRun {
  /** Run id, e.g. `run-0001`. */
  id: string;
  /** Campaign this run belongs to. */
  campaignId: string;
  /** Overall status. */
  status: FleetV27CampaignRunStatus;
  /** Per-bot progress rows (one per campaign bot, same order). */
  entries: FleetV27BotRunEntry[];
  /** When the run started (null = not started yet). */
  startedAtMs: number | null;
  /** When the run reached a terminal status (null = still active). */
  finishedAtMs: number | null;
  /** Who started it. */
  startedBy: string;
  /** Why a run was cancelled (null unless cancelled). */
  cancelReason: string | null;
}

/** Aggregate counts for one run. */
export interface FleetV27RunAggregate {
  /** Total bots in the run. */
  total: number;
  /** Still queued (never started). */
  queued: number;
  /** Currently running. */
  running: number;
  /** Finished successfully. */
  succeeded: number;
  /** Finished with failure (after retries). */
  failed: number;
  /** Timed out. */
  timedOut: number;
  /** Skipped (host reported the bot unavailable). */
  skipped: number;
  /** Cancelled with the run. */
  cancelled: number;
  /** Finished (any terminal state). */
  finished: number;
  /** Progress 0..1 (finished / total). */
  progress: number;
}

/** Validation problems for a campaign definition. */
export type FleetV27CampaignValidationReason =
  | 'ok'
  | 'missing-id'
  | 'missing-name'
  | 'no-bots'
  | 'duplicate-bot'
  | 'empty-bot-id'
  | 'empty-task'
  | 'bad-concurrency'
  | 'bad-timeout'
  | 'bad-retries'
  | 'campaign-exists'
  | 'campaign-not-found'
  | 'run-not-found'
  | 'run-not-active'
  | 'run-already-finished';

/** Default per-bot timeout, ms (10 minutes). */
export const FLEET_V27_DEFAULT_TIMEOUT_MS = 600_000;
/** Default retries per bot. */
export const FLEET_V27_DEFAULT_RETRIES = 1;
/** Default concurrency (2 bots at once). */
export const FLEET_V27_DEFAULT_CONCURRENCY = 2;
/** Maximum bots in one campaign (a campaign is a batch, not the fleet). */
export const FLEET_V27_MAX_BOTS_PER_CAMPAIGN = 200;
/** Maximum concurrency (never starve the host). */
export const FLEET_V27_MAX_CONCURRENCY = 16;

/** Validate a campaign definition (pure, no store needed). */
export function validateFleetV27Campaign(c: Partial<FleetV27Campaign>): FleetV27CampaignValidationReason[] {
  const reasons: FleetV27CampaignValidationReason[] = [];
  if (!c.id || !c.id.trim()) reasons.push('missing-id');
  if (!c.name || !c.name.trim()) reasons.push('missing-name');
  if (!c.bots || c.bots.length === 0) reasons.push('no-bots');
  if (c.bots && c.bots.length > FLEET_V27_MAX_BOTS_PER_CAMPAIGN) reasons.push('no-bots');
  if (c.bots) {
    const seen = new Set<string>();
    for (const b of c.bots) {
      if (!b.botId || !b.botId.trim()) reasons.push('empty-bot-id');
      else if (seen.has(b.botId)) reasons.push('duplicate-bot');
      else seen.add(b.botId);
      const task = b.taskOverride ?? c.task;
      if (task && task.timeoutMs !== undefined && task.timeoutMs < 0) reasons.push('bad-timeout');
      if (task && task.maxRetries !== undefined && (task.maxRetries < 0 || !Number.isInteger(task.maxRetries))) {
        reasons.push('bad-retries');
      }
    }
  }
  if (!c.task || !c.task.text || !c.task.text.trim()) reasons.push('empty-task');
  if (c.task && c.task.timeoutMs !== undefined && c.task.timeoutMs < 0) reasons.push('bad-timeout');
  if (c.task && c.task.maxRetries !== undefined && (c.task.maxRetries < 0 || !Number.isInteger(c.task.maxRetries))) {
    reasons.push('bad-retries');
  }
  if (c.concurrency !== undefined && (!Number.isInteger(c.concurrency) || c.concurrency < 1 || c.concurrency > FLEET_V27_MAX_CONCURRENCY)) {
    reasons.push('bad-concurrency');
  }
  return [...new Set(reasons)];
}

/** Aggregate the per-bot entries of a run into counts. */
export function aggregateFleetV27Run(entries: readonly FleetV27BotRunEntry[]): FleetV27RunAggregate {
  const agg: FleetV27RunAggregate = {
    total: entries.length,
    queued: 0,
    running: 0,
    succeeded: 0,
    failed: 0,
    timedOut: 0,
    skipped: 0,
    cancelled: 0,
    finished: 0,
    progress: 0,
  };
  for (const e of entries) {
    if (e.state === 'queued') agg.queued += 1;
    else if (e.state === 'running') agg.running += 1;
    else if (e.state === 'succeeded') { agg.succeeded += 1; agg.finished += 1; }
    else if (e.state === 'failed') { agg.failed += 1; agg.finished += 1; }
    else if (e.state === 'timed-out') { agg.timedOut += 1; agg.finished += 1; }
    else if (e.state === 'skipped') { agg.skipped += 1; agg.finished += 1; }
    else if (e.state === 'cancelled') { agg.cancelled += 1; agg.finished += 1; }
  }
  agg.progress = agg.total === 0 ? 1 : agg.finished / agg.total;
  return agg;
}

/** Derive the run status from its entries (pure). */
export function deriveFleetV27RunStatus(
  entries: readonly FleetV27BotRunEntry[],
  cancelled: boolean,
): FleetV27CampaignRunStatus {
  if (cancelled) return 'cancelled';
  const agg = aggregateFleetV27Run(entries);
  if (agg.total === 0) return 'succeeded';
  if (agg.finished < agg.total) {
    return agg.running > 0 || agg.queued > 0 ? 'running' : 'running';
  }
  if (agg.succeeded === agg.total) return 'succeeded';
  if (agg.succeeded === 0) return 'failed';
  return 'partial';
}

/** One-line summary of a run aggregate (English; UI uses i18n keys). */
export function summarizeFleetV27Run(agg: FleetV27RunAggregate): string {
  return `${agg.finished}/${agg.total} finished (${agg.succeeded} succeeded, ${agg.failed} failed, ${agg.timedOut} timed out, ${agg.skipped} skipped, ${agg.cancelled} cancelled, ${agg.running} running, ${agg.queued} queued)`;
}

/** Outcome the host reports for one bot (one advance tick). */
export interface FleetV27BotOutcome {
  /** Bot id. */
  botId: string;
  /** What happened to this bot's current attempt. */
  outcome: 'succeeded' | 'failed' | 'timed-out' | 'skipped';
  /** Outcome / result text. */
  text?: string;
  /** Error text (for failed / timed-out). */
  error?: string;
}

/** Result of advancing a run by one tick. */
export interface FleetV27AdvanceResult {
  /** Run id. */
  runId: string;
  /** Status after the tick. */
  status: FleetV27CampaignRunStatus;
  /** Aggregate after the tick. */
  aggregate: FleetV27RunAggregate;
  /** Bot ids started this tick (queued -> running). */
  started: string[];
  /** Bot ids retried this tick (failed -> running again). */
  retried: string[];
  /** Bot ids that finished this tick. */
  finished: string[];
  /** Human-readable notes (English). */
  notes: string[];
}

/**
 * Store for campaign definitions + runs (in-memory, JSON round-trip).
 * One store per fleet; the host holds one instance.
 */
export class FleetV27CampaignStore {
  private campaigns = new Map<string, FleetV27Campaign>();
  private runs = new Map<string, FleetV27CampaignRun>();
  private runSeq = 0;

  /** Create a campaign (refused when invalid or the id exists). */
  createCampaign(input: {
    id: string;
    name: string;
    description?: string;
    bots: FleetV27CampaignBot[];
    task: FleetV27CampaignTask;
    concurrency?: number;
    tags?: string[];
    createdBy?: string;
    createdAtMs?: number;
  }): { ok: boolean; campaign?: FleetV27Campaign; reasons: FleetV27CampaignValidationReason[] } {
    const campaign: FleetV27Campaign = {
      id: input.id.trim(),
      name: input.name.trim(),
      description: input.description?.trim() || undefined,
      bots: input.bots.map((b) => ({
        botId: b.botId.trim(),
        taskOverride: b.taskOverride ? { ...b.taskOverride } : undefined,
      })),
      task: { ...input.task, text: input.task.text.trim() },
      concurrency: input.concurrency ?? FLEET_V27_DEFAULT_CONCURRENCY,
      tags: [...(input.tags ?? [])].map((t) => t.trim()).filter(Boolean),
      createdBy: input.createdBy ?? 'local-user',
      createdAtMs: input.createdAtMs ?? Date.now(),
    };
    const reasons = validateFleetV27Campaign(campaign);
    if (this.campaigns.has(campaign.id)) reasons.push('campaign-exists');
    if (reasons.length > 0) return { ok: false, reasons };
    this.campaigns.set(campaign.id, campaign);
    return { ok: true, campaign, reasons: [] };
  }

  /** Get a campaign by id (undefined when absent). */
  getCampaign(id: string): FleetV27Campaign | undefined {
    return this.campaigns.get(id);
  }

  /** List campaigns, optionally filtered by tag. */
  listCampaigns(tag?: string | null): FleetV27Campaign[] {
    const all = [...this.campaigns.values()].sort((a, b) => a.createdAtMs - b.createdAtMs);
    if (!tag) return all;
    return all.filter((c) => c.tags.includes(tag));
  }

  /** Remove a campaign (runs of it stay in history). */
  removeCampaign(id: string): boolean {
    return this.campaigns.delete(id);
  }

  /** Start a run of a campaign (entries start queued; concurrency fills). */
  startRun(
    campaignId: string,
    opts: { startedBy?: string; nowMs?: number } = {},
  ): { ok: boolean; run?: FleetV27CampaignRun; reasons: FleetV27CampaignValidationReason[] } {
    const campaign = this.campaigns.get(campaignId);
    if (!campaign) return { ok: false, reasons: ['campaign-not-found'] };
    const nowMs = opts.nowMs ?? Date.now();
    this.runSeq += 1;
    const run: FleetV27CampaignRun = {
      id: `run-${String(this.runSeq).padStart(4, '0')}`,
      campaignId,
      status: 'running',
      entries: campaign.bots.map((b) => ({
        botId: b.botId,
        state: 'queued' as FleetV27BotRunState,
        attempts: 0,
        startedAtMs: null,
        finishedAtMs: null,
        outcome: null,
        error: null,
        durationMs: null,
      })),
      startedAtMs: nowMs,
      finishedAtMs: null,
      startedBy: opts.startedBy ?? 'local-user',
      cancelReason: null,
    };
    // Fill the first concurrency slots immediately.
    const slots = Math.min(campaign.concurrency, run.entries.length);
    for (let i = 0; i < slots; i += 1) {
      run.entries[i].state = 'running';
      run.entries[i].attempts = 1;
      run.entries[i].startedAtMs = nowMs;
    }
    this.runs.set(run.id, run);
    return { ok: true, run, reasons: [] };
  }

  /** Get a run by id (undefined when absent). */
  getRun(runId: string): FleetV27CampaignRun | undefined {
    return this.runs.get(runId);
  }

  /** List runs of one campaign (newest first), or all runs when no id. */
  listRuns(campaignId?: string | null): FleetV27CampaignRun[] {
    const all = [...this.runs.values()].sort((a, b) => (b.startedAtMs ?? 0) - (a.startedAtMs ?? 0));
    if (!campaignId) return all;
    return all.filter((r) => r.campaignId === campaignId);
  }

  /** List finished runs (history) — newest first, optional status filter. */
  listFinishedRuns(status?: FleetV27CampaignRunStatus | null): FleetV27CampaignRun[] {
    const terminal = new Set(['succeeded', 'partial', 'failed', 'cancelled']);
    const all = [...this.runs.values()]
      .filter((r) => terminal.has(r.status))
      .sort((a, b) => (b.finishedAtMs ?? 0) - (a.finishedAtMs ?? 0));
    if (!status) return all;
    return all.filter((r) => r.status === status);
  }

  /** Aggregate + status snapshot of one run. */
  progress(runId: string): { ok: boolean; aggregate?: FleetV27RunAggregate; status?: FleetV27CampaignRunStatus; reasons: FleetV27CampaignValidationReason[] } {
    const run = this.runs.get(runId);
    if (!run) return { ok: false, reasons: ['run-not-found'] };
    return { ok: true, aggregate: aggregateFleetV27Run(run.entries), status: run.status, reasons: [] };
  }

  /**
   * Advance a run one tick: apply the host-reported outcomes, retry
   * failures that still have attempts left, fill freed concurrency
   * slots from the queue, and close the run when nothing is left.
   */
  advanceRun(
    runId: string,
    outcomes: readonly FleetV27BotOutcome[],
    opts: { nowMs?: number } = {},
  ): { ok: boolean; result?: FleetV27AdvanceResult; reasons: FleetV27CampaignValidationReason[] } {
    const run = this.runs.get(runId);
    if (!run) return { ok: false, reasons: ['run-not-found'] };
    const terminal = new Set(['succeeded', 'partial', 'failed', 'cancelled']);
    if (terminal.has(run.status)) return { ok: false, reasons: ['run-already-finished'] };
    const campaign = this.campaigns.get(run.campaignId);
    const nowMs = opts.nowMs ?? Date.now();
    const notes: string[] = [];
    const finished: string[] = [];
    const retried: string[] = [];

    for (const outcome of outcomes) {
      const entry = run.entries.find((e) => e.botId === outcome.botId);
      if (!entry || entry.state !== 'running') {
        notes.push(`ignored outcome for ${outcome.botId} (not running)`);
        continue;
      }
      const task = campaign?.bots.find((b) => b.botId === outcome.botId)?.taskOverride
        ?? campaign?.task;
      const maxRetries = task?.maxRetries ?? FLEET_V27_DEFAULT_RETRIES;
      if (outcome.outcome === 'succeeded') {
        entry.state = 'succeeded';
        entry.outcome = outcome.text ?? null;
        entry.finishedAtMs = nowMs;
        entry.durationMs = entry.startedAtMs === null ? null : nowMs - entry.startedAtMs;
        finished.push(entry.botId);
      } else if (outcome.outcome === 'skipped') {
        entry.state = 'skipped';
        entry.outcome = outcome.text ?? null;
        entry.finishedAtMs = nowMs;
        entry.durationMs = entry.startedAtMs === null ? null : nowMs - entry.startedAtMs;
        finished.push(entry.botId);
      } else {
        // failed / timed-out: retry while attempts remain.
        const nextState: FleetV27BotRunState = outcome.outcome === 'timed-out' ? 'timed-out' : 'failed';
        if (entry.attempts <= maxRetries) {
          entry.attempts += 1;
          entry.startedAtMs = nowMs;
          entry.error = outcome.error ?? null;
          entry.outcome = outcome.text ?? null;
          retried.push(entry.botId);
          notes.push(`${entry.botId} ${nextState} (attempt ${entry.attempts - 1}/${maxRetries + 1}), retrying`);
        } else {
          entry.state = nextState;
          entry.error = outcome.error ?? null;
          entry.outcome = outcome.text ?? null;
          entry.finishedAtMs = nowMs;
          entry.durationMs = entry.startedAtMs === null ? null : nowMs - entry.startedAtMs;
          finished.push(entry.botId);
        }
      }
    }

    // Fill freed concurrency slots from the queue.
    const concurrency = campaign?.concurrency ?? FLEET_V27_DEFAULT_CONCURRENCY;
    const runningCount = run.entries.filter((e) => e.state === 'running').length;
    const freeSlots = Math.max(0, concurrency - runningCount);
    const started: string[] = [];
    for (const entry of run.entries) {
      if (started.length >= freeSlots) break;
      if (entry.state !== 'queued') continue;
      entry.state = 'running';
      entry.attempts = 1;
      entry.startedAtMs = nowMs;
      started.push(entry.botId);
    }

    const aggregate = aggregateFleetV27Run(run.entries);
    run.status = deriveFleetV27RunStatus(run.entries, false);
    if (terminal.has(run.status)) run.finishedAtMs = nowMs;
    return {
      ok: true,
      result: { runId, status: run.status, aggregate, started, retried, finished, notes },
      reasons: [],
    };
  }

  /** Cancel a run: queued/running entries become cancelled, run closes. */
  cancelRun(
    runId: string,
    reason: string,
    opts: { nowMs?: number } = {},
  ): { ok: boolean; run?: FleetV27CampaignRun; reasons: FleetV27CampaignValidationReason[] } {
    const run = this.runs.get(runId);
    if (!run) return { ok: false, reasons: ['run-not-found'] };
    const terminal = new Set(['succeeded', 'partial', 'failed', 'cancelled']);
    if (terminal.has(run.status)) return { ok: false, reasons: ['run-already-finished'] };
    const nowMs = opts.nowMs ?? Date.now();
    for (const entry of run.entries) {
      if (entry.state === 'queued' || entry.state === 'running') {
        entry.state = 'cancelled';
        entry.finishedAtMs = nowMs;
        entry.durationMs = entry.startedAtMs === null ? null : nowMs - entry.startedAtMs;
      }
    }
    run.status = 'cancelled';
    run.finishedAtMs = nowMs;
    run.cancelReason = reason;
    return { ok: true, run, reasons: [] };
  }

  /**
   * Retry the failed / timed-out bots of a finished run as a NEW run
   * (only those bots; the original run stays in history untouched).
   */
  retryFailed(
    runId: string,
    opts: { startedBy?: string; nowMs?: number } = {},
  ): { ok: boolean; run?: FleetV27CampaignRun; reasons: FleetV27CampaignValidationReason[] } {
    const run = this.runs.get(runId);
    if (!run) return { ok: false, reasons: ['run-not-found'] };
    const campaign = this.campaigns.get(run.campaignId);
    if (!campaign) return { ok: false, reasons: ['campaign-not-found'] };
    const failedIds = run.entries
      .filter((e) => e.state === 'failed' || e.state === 'timed-out')
      .map((e) => e.botId);
    if (failedIds.length === 0) return { ok: false, reasons: ['run-not-active'] };
    const nowMs = opts.nowMs ?? Date.now();
    this.runSeq += 1;
    const retry: FleetV27CampaignRun = {
      id: `run-${String(this.runSeq).padStart(4, '0')}`,
      campaignId: run.campaignId,
      status: 'running',
      entries: failedIds.map((botId) => ({
        botId,
        state: 'queued' as FleetV27BotRunState,
        attempts: 0,
        startedAtMs: null,
        finishedAtMs: null,
        outcome: null,
        error: null,
        durationMs: null,
      })),
      startedAtMs: nowMs,
      finishedAtMs: null,
      startedBy: opts.startedBy ?? 'local-user',
      cancelReason: null,
    };
    const slots = Math.min(campaign.concurrency, retry.entries.length);
    for (let i = 0; i < slots; i += 1) {
      retry.entries[i].state = 'running';
      retry.entries[i].attempts = 1;
      retry.entries[i].startedAtMs = nowMs;
    }
    this.runs.set(retry.id, retry);
    return { ok: true, run: retry, reasons: [] };
  }

  /** One-line summary of a run (for the UI). */
  summarizeRun(runId: string): string | null {
    const run = this.runs.get(runId);
    if (!run) return null;
    return `Campaign ${run.campaignId} ${run.id}: ${run.status} — ${summarizeFleetV27Run(aggregateFleetV27Run(run.entries))}`;
  }

  /** JSON round-trip (definitions + runs; run sequence preserved). */
  toJSON(): { campaigns: FleetV27Campaign[]; runs: FleetV27CampaignRun[]; runSeq: number } {
    return {
      campaigns: [...this.campaigns.values()],
      runs: [...this.runs.values()],
      runSeq: this.runSeq,
    };
  }

  /** Restore from `toJSON` output (replaces current state). */
  static fromJSON(data: { campaigns?: FleetV27Campaign[]; runs?: FleetV27CampaignRun[]; runSeq?: number }): FleetV27CampaignStore {
    const store = new FleetV27CampaignStore();
    for (const c of data.campaigns ?? []) store.campaigns.set(c.id, c);
    for (const r of data.runs ?? []) store.runs.set(r.id, r);
    store.runSeq = data.runSeq ?? store.runs.size;
    return store;
  }
}

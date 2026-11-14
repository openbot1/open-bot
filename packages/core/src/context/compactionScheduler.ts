/**
 * Compaction scheduler — enforce the policy `frequency`
 * (context engineering v2, v1.05 Team T4).
 *
 * A policy says *when* compaction may run:
 *
 *   per-turn — every turn, as soon as usage is at/over the trigger.
 *   hourly   — at most once an hour per bot, however tight the
 *              window gets (long runs compact in calm, regular
 *              rounds instead of every turn).
 *   manual   — never automatic; only an explicit tool call or UI
 *              action compacts.
 *
 * `CompactionScheduler` keeps the last-run timestamp per bot in one
 * JSON file (atomic write, mode 0600, corrupt file loads as empty —
 * same pattern as `CompactionHistory`). `shouldCompact` is the
 * single gate the loop calls each turn; `recordRun` is called after
 * a round actually runs. `status` reports the next allowed time so
 * the UI can show "next compaction in 23m" instead of silence.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import type { CompactionPolicy } from './compactionPolicy';

/** One hour in milliseconds. */
export const HOURLY_COMPACTION_INTERVAL_MS = 60 * 60 * 1000;

/** Why a compaction round may or may not run. */
export type ScheduleDecision =
  | { allowed: true; reason: 'over-trigger' }
  | { allowed: false; reason: 'under-trigger' | 'manual-only' | 'too-soon'; nextAllowedAt?: string };

/** Scheduler state for one bot. */
export interface BotScheduleStatus {
  botId: string;
  frequency: CompactionPolicy['frequency'];
  lastRunAt: string | null;
  nextAllowedAt: string | null;
  runsTotal: number;
  /** True when a round may run right now (ignoring the trigger). */
  due: boolean;
}

export class CompactionScheduler {
  private readonly filePath?: string;
  private state = new Map<string, { lastRunAt: string | null; runsTotal: number }>();

  /** `filePath` optional: without it the scheduler is in-memory only. */
  constructor(filePath?: string) {
    this.filePath = filePath;
    this.load();
  }

  /**
   * Gate for one turn: allowed only when usage is at/over the
   * policy trigger AND the frequency allows a round now.
   */
  shouldCompact(botId: string, policy: CompactionPolicy, usageRatio: number): ScheduleDecision {
    if (usageRatio < policy.triggerRatio) return { allowed: false, reason: 'under-trigger' };
    if (policy.frequency === 'manual') return { allowed: false, reason: 'manual-only' };
    if (policy.frequency === 'hourly') {
      const entry = this.state.get(botId);
      if (entry?.lastRunAt) {
        const next = Date.parse(entry.lastRunAt) + HOURLY_COMPACTION_INTERVAL_MS;
        if (Date.now() < next) {
          return { allowed: false, reason: 'too-soon', nextAllowedAt: new Date(next).toISOString() };
        }
      }
    }
    return { allowed: true, reason: 'over-trigger' };
  }

  /** Record that a round ran for a bot (updates last-run + count). */
  recordRun(botId: string, at: string = new Date().toISOString()): void {
    const entry = this.state.get(botId) ?? { lastRunAt: null, runsTotal: 0 };
    entry.lastRunAt = at;
    entry.runsTotal += 1;
    this.state.set(botId, entry);
    this.persist();
  }

  /** Status for one bot (for the UI / the schedule_status tool). */
  status(botId: string, policy: CompactionPolicy): BotScheduleStatus {
    const entry = this.state.get(botId);
    const lastRunAt = entry?.lastRunAt ?? null;
    let nextAllowedAt: string | null = null;
    let due = true;
    if (policy.frequency === 'manual') {
      due = false;
    } else if (policy.frequency === 'hourly' && lastRunAt) {
      const next = Date.parse(lastRunAt) + HOURLY_COMPACTION_INTERVAL_MS;
      nextAllowedAt = new Date(next).toISOString();
      due = Date.now() >= next;
    }
    return {
      botId,
      frequency: policy.frequency,
      lastRunAt,
      nextAllowedAt,
      runsTotal: entry?.runsTotal ?? 0,
      due,
    };
  }

  /** Bot ids the scheduler has ever seen (for admin views). */
  botIds(): string[] {
    return [...this.state.keys()].sort();
  }

  private load(): void {
    if (!this.filePath) return;
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8');
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        for (const [botId, entry] of Object.entries(parsed as Record<string, unknown>)) {
          if (typeof entry === 'object' && entry !== null) {
            const e = entry as { lastRunAt?: unknown; runsTotal?: unknown };
            this.state.set(botId, {
              lastRunAt: typeof e.lastRunAt === 'string' ? e.lastRunAt : null,
              runsTotal: typeof e.runsTotal === 'number' ? e.runsTotal : 0,
            });
          }
        }
      }
    } catch {
      this.state = new Map();
    }
  }

  private persist(): void {
    if (!this.filePath) return;
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      const tmp = `${this.filePath}.tmp-${process.pid}`;
      fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.state), null, 2), { mode: 0o600 });
      fs.renameSync(tmp, this.filePath);
    } catch {
      // Scheduler state is best-effort; a failed write must not break the run.
    }
  }
}

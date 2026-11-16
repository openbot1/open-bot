/**
 * Usage store for the ACP Control Center (v1.12, Team T4).
 *
 * Append-mostly log of prompt turns + summaries, persisted as one
 * plain JSON file (same shape choice as `packages/core/src/usage/`:
 * small log, read whole on every call, atomic temp-file + rename,
 * mode 0600). No secrets: turns carry only token counts, cost
 * estimates, durations and stop reasons — never prompt text.
 *
 * Windows use the machine's LOCAL calendar day (same contract as
 * the core spend limits).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

import { emptyUsageSummary, localDay, type AgentUsageSummary, type AgentUsageTurn } from './types';

/** On-disk shape (versioned so a future format can migrate). */
export interface ControlUsageFile {
  version: 1;
  turns: AgentUsageTurn[];
}

export interface RecordTurnInput {
  agentId: string;
  sessionId: string;
  inputTokens?: number;
  outputTokens?: number;
  /** null = unpriced (counts as 0 cost, flagged in unpricedCalls). */
  costUsd?: number | null;
  durationMs: number;
  stopReason: string;
  status?: AgentUsageTurn['status'];
  toolCalls?: number;
  /** ISO timestamp; defaults to now. */
  at?: string;
}

export interface UsageStoreOptions {
  /** Directory holding `acp-control-usage.json`. Omit = memory only. */
  stateDir?: string;
  /** Max turns kept (oldest pruned first, default 5000). */
  maxTurns?: number;
}

export const CONTROL_USAGE_FILENAME = 'acp-control-usage.json';
export const CONTROL_USAGE_MAX_TURNS = 5000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isValidTurn(value: unknown): value is AgentUsageTurn {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === 'string' &&
    typeof value.agentId === 'string' &&
    typeof value.sessionId === 'string' &&
    typeof value.at === 'string' &&
    typeof value.inputTokens === 'number' &&
    typeof value.outputTokens === 'number' &&
    typeof value.durationMs === 'number' &&
    typeof value.stopReason === 'string'
  );
}

/** Sum a list of turns into one summary. */
export function summarizeTurns(turns: AgentUsageTurn[]): AgentUsageSummary {
  const summary = emptyUsageSummary();
  let costTotal = 0;
  let anyUnpriced = false;
  for (const turn of turns) {
    summary.inputTokens += turn.inputTokens;
    summary.outputTokens += turn.outputTokens;
    summary.calls += 1;
    summary.wallMs += turn.durationMs;
    summary.toolCalls += turn.toolCalls;
    if (turn.costUsd === null || turn.costUsd === undefined) {
      summary.unpricedCalls += 1;
      anyUnpriced = true;
    } else {
      costTotal += turn.costUsd;
    }
  }
  summary.totalTokens = summary.inputTokens + summary.outputTokens;
  summary.costUsd = anyUnpriced ? null : costTotal;
  return summary;
}

/** In-memory usage log with optional JSON persistence. */
export class AcpControlUsageStore {
  private turns: AgentUsageTurn[] = [];
  private readonly stateDir?: string;
  private readonly maxTurns: number;
  private loaded = false;

  constructor(options: UsageStoreOptions = {}) {
    this.stateDir = options.stateDir;
    this.maxTurns = options.maxTurns ?? CONTROL_USAGE_MAX_TURNS;
  }

  get filePath(): string | undefined {
    return this.stateDir ? path.join(this.stateDir, CONTROL_USAGE_FILENAME) : undefined;
  }

  /** Load persisted turns (no-op when memory-only or file missing). */
  load(): void {
    if (this.loaded) return;
    this.loaded = true;
    if (!this.filePath) return;
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8');
      const parsed: unknown = JSON.parse(raw);
      if (isRecord(parsed) && Array.isArray(parsed.turns)) {
        this.turns = parsed.turns.filter(isValidTurn).slice(-this.maxTurns);
      }
    } catch {
      // Missing / corrupt file: start empty, never crash the center.
      this.turns = [];
    }
  }

  /** Persist turns atomically (temp file + rename, mode 0600). */
  save(): void {
    if (!this.filePath || !this.stateDir) return;
    try {
      fs.mkdirSync(this.stateDir, { recursive: true });
      const tmp = path.join(this.stateDir, `${CONTROL_USAGE_FILENAME}.tmp-${process.pid}`);
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, turns: this.turns } satisfies ControlUsageFile), {
        mode: 0o600,
      });
      fs.renameSync(tmp, this.filePath);
    } catch {
      // Persistence is best-effort; in-memory data still works.
    }
  }

  /** Record one turn and persist. Returns the stored turn. */
  recordTurn(input: RecordTurnInput): AgentUsageTurn {
    this.load();
    const turn: AgentUsageTurn = {
      id: randomUUID(),
      agentId: input.agentId,
      sessionId: input.sessionId,
      at: input.at ?? new Date().toISOString(),
      inputTokens: Math.max(0, Math.floor(input.inputTokens ?? 0)),
      outputTokens: Math.max(0, Math.floor(input.outputTokens ?? 0)),
      costUsd: input.costUsd ?? null,
      durationMs: Math.max(0, Math.floor(input.durationMs)),
      stopReason: input.stopReason,
      status: input.status ?? 'completed',
      toolCalls: Math.max(0, Math.floor(input.toolCalls ?? 0)),
    };
    this.turns.push(turn);
    if (this.turns.length > this.maxTurns) {
      this.turns.splice(0, this.turns.length - this.maxTurns);
    }
    this.save();
    return turn;
  }

  /** All turns for one agent, oldest first. */
  history(agentId: string, limit?: number): AgentUsageTurn[] {
    this.load();
    const rows = this.turns.filter((t) => t.agentId === agentId);
    return limit === undefined ? rows : rows.slice(-limit);
  }

  /** All turns (any agent), oldest first. */
  allTurns(): AgentUsageTurn[] {
    this.load();
    return [...this.turns];
  }

  /** Summary for one agent over a local-day window, or all time. */
  summary(agentId: string, day?: string): AgentUsageSummary {
    this.load();
    const rows = this.turns.filter(
      (t) => t.agentId === agentId && (day === undefined || localDay(new Date(t.at)) === day),
    );
    return summarizeTurns(rows);
  }

  /** Today's summary for one agent. */
  today(agentId: string, now: Date = new Date()): AgentUsageSummary {
    return this.summary(agentId, localDay(now));
  }

  /** Summary across ALL managed agents (today / all time). */
  summaryAll(day?: string): AgentUsageSummary {
    this.load();
    const rows = this.turns.filter((t) => day === undefined || localDay(new Date(t.at)) === day);
    return summarizeTurns(rows);
  }

  /** Drop turns older than `days` (keeps today + recent). Returns how many were removed. */
  prune(days: number): number {
    this.load();
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    const before = this.turns.length;
    this.turns = this.turns.filter((t) => {
      const at = Date.parse(t.at);
      return Number.isNaN(at) || at >= cutoff;
    });
    const removed = before - this.turns.length;
    if (removed > 0) this.save();
    return removed;
  }

  /** Drop every turn for one agent (used on deregister). Returns how many were removed. */
  clearAgent(agentId: string): number {
    this.load();
    const before = this.turns.length;
    this.turns = this.turns.filter((t) => t.agentId !== agentId);
    const removed = before - this.turns.length;
    if (removed > 0) this.save();
    return removed;
  }

  get size(): number {
    this.load();
    return this.turns.length;
  }
}

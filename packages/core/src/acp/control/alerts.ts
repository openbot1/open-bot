/**
 * Budget alert log for the ACP Control Center (v1.12, Team T4).
 *
 * Every budget warning / exceed / block the center emits is also
 * written here (persisted JSON, same atomic-write pattern as the
 * usage store), so the UI and the tools can show *when* an agent hit
 * its caps — not just that it is currently over. No secrets: alerts
 * carry only the dimension reasons, which are counts and caps.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

export type AcpControlBudgetAlertKind = 'warned' | 'exceeded' | 'blocked';

export interface AcpControlBudgetAlert {
  id: string;
  agentId: string;
  kind: AcpControlBudgetAlertKind;
  /** Human-readable reasons (e.g. "tokens exceeded: 120 of 100"). */
  reasons: string[];
  /** Local calendar day the alert belongs to (YYYY-MM-DD). */
  day: string;
  /** ISO timestamp. */
  at: string;
}

export interface AlertStoreOptions {
  /** Directory holding `acp-control-alerts.json`. Omit = memory only. */
  stateDir?: string;
  /** Max alerts kept (oldest pruned first, default 500). */
  maxAlerts?: number;
}

export const CONTROL_ALERTS_FILENAME = 'acp-control-alerts.json';
export const CONTROL_ALERTS_MAX = 500;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isValidAlert(value: unknown): value is AcpControlBudgetAlert {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === 'string' &&
    typeof value.agentId === 'string' &&
    (value.kind === 'warned' || value.kind === 'exceeded' || value.kind === 'blocked') &&
    Array.isArray(value.reasons) &&
    typeof value.day === 'string' &&
    typeof value.at === 'string'
  );
}

/** In-memory budget-alert log with optional JSON persistence. */
export class AcpControlAlertStore {
  private alerts: AcpControlBudgetAlert[] = [];
  private readonly stateDir?: string;
  private readonly maxAlerts: number;
  private loaded = false;

  constructor(options: AlertStoreOptions = {}) {
    this.stateDir = options.stateDir;
    this.maxAlerts = options.maxAlerts ?? CONTROL_ALERTS_MAX;
  }

  get filePath(): string | undefined {
    return this.stateDir ? path.join(this.stateDir, CONTROL_ALERTS_FILENAME) : undefined;
  }

  load(): void {
    if (this.loaded) return;
    this.loaded = true;
    if (!this.filePath) return;
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      if (isRecord(parsed) && Array.isArray(parsed.alerts)) {
        this.alerts = parsed.alerts.filter(isValidAlert).slice(-this.maxAlerts);
      }
    } catch {
      this.alerts = [];
    }
  }

  save(): void {
    if (!this.filePath || !this.stateDir) return;
    try {
      fs.mkdirSync(this.stateDir, { recursive: true });
      const tmp = path.join(this.stateDir, `${CONTROL_ALERTS_FILENAME}.tmp-${process.pid}`);
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, alerts: this.alerts }), { mode: 0o600 });
      fs.renameSync(tmp, this.filePath);
    } catch {
      // Persistence is best-effort.
    }
  }

  /** Record one alert (deduplicated: same agent + kind + day + reasons within 60s is one alert). */
  record(input: { agentId: string; kind: AcpControlBudgetAlertKind; reasons: string[]; day: string; at?: string }): AcpControlBudgetAlert {
    this.load();
    const at = input.at ?? new Date().toISOString();
    const reasonsKey = input.reasons.join('|');
    const recent = this.alerts.find(
      (a) =>
        a.agentId === input.agentId &&
        a.kind === input.kind &&
        a.day === input.day &&
        a.reasons.join('|') === reasonsKey &&
        Date.parse(at) - Date.parse(a.at) < 60_000,
    );
    if (recent) return recent;
    const alert: AcpControlBudgetAlert = { id: randomUUID(), agentId: input.agentId, kind: input.kind, reasons: [...input.reasons], day: input.day, at };
    this.alerts.push(alert);
    if (this.alerts.length > this.maxAlerts) {
      this.alerts.splice(0, this.alerts.length - this.maxAlerts);
    }
    this.save();
    return alert;
  }

  /** Alerts for one agent, newest first. */
  forAgent(agentId: string, limit?: number): AcpControlBudgetAlert[] {
    this.load();
    const rows = this.alerts.filter((a) => a.agentId === agentId).slice().reverse();
    return limit === undefined ? rows : rows.slice(0, limit);
  }

  /** All alerts, newest first. */
  all(limit?: number): AcpControlBudgetAlert[] {
    this.load();
    const rows = this.alerts.slice().reverse();
    return limit === undefined ? rows : rows.slice(0, limit);
  }

  clearAgent(agentId: string): number {
    this.load();
    const before = this.alerts.length;
    this.alerts = this.alerts.filter((a) => a.agentId !== agentId);
    const removed = before - this.alerts.length;
    if (removed > 0) this.save();
    return removed;
  }

  get size(): number {
    this.load();
    return this.alerts.length;
  }
}

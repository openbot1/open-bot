/**
 * ACP Control Center manager (v1.12, Team T4).
 *
 * Owns the registered managed agents: their lifecycle (register /
 * start / stop), their budgets (checked before every turn), and
 * their usage history (recorded after every turn). Spawning reuses
 * the existing `ExternalAgentManager` — the center adds the control
 * plane (registry + budget + usage + events), not a second spawner.
 *
 * State file `<stateDir>/acp-control-agents.json` holds registrations
 * (id, backend, command, budget, enabled, status...). Usage lives in
 * `AcpControlUsageStore` (`acp-control-usage.json`). Neither file
 * ever holds a secret.
 *
 * A process never survives a restart: records loaded with status
 * `running`/`starting` are reset to `stopped` on load.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

import { ExternalAgentManager } from '../externalAgent';
import type { AcpContentBlock, AcpSessionInfo, AcpSessionUpdate } from '../types';
import { AcpControlAlertStore, type AcpControlBudgetAlert, type AcpControlBudgetAlertKind } from './alerts';
import { evaluateBudget, validateBudget } from './budgets';
import { discoverControlCenterAgents, type DiscoverOptions, type DiscoveryDeps } from './discovery';
import { AcpControlUsageStore } from './usageStore';
import {
  defaultBudget,
  emptyUsageSummary,
  localDay,
  type AgentBudget,
  type AgentUsageReport,
  type AgentUsageSummary,
  type AgentUsageTurn,
  type BudgetEvaluation,
  type ControlCenterBackendId,
  type ControlCenterEvent,
  type ControlCenterEventListener,
  type DiscoveredControlAgent,
  type ManagedAgentRecord,
  type ManagedAgentStatus,
  type ManagedAgentView,
} from './types';

export const CONTROL_AGENTS_FILENAME = 'acp-control-agents.json';

/** Error codes surfaced by the center (tools + UI switch on `code`). */
export type AcpControlErrorCode =
  | 'not-found'
  | 'not-enabled'
  | 'budget-blocked'
  | 'already-running'
  | 'not-running'
  | 'duplicate'
  | 'invalid-budget'
  | 'invalid-registration'
  | 'spawn-failed';

export class AcpControlError extends Error {
  readonly code: AcpControlErrorCode;
  readonly agentId?: string;
  readonly reasons?: string[];
  constructor(message: string, code: AcpControlErrorCode, agentId?: string, reasons?: string[]) {
    super(message);
    this.name = 'AcpControlError';
    this.code = code;
    this.agentId = agentId;
    this.reasons = reasons;
  }
}

export interface AcpControlCenterOptions {
  /** Directory for `acp-control-agents.json` + usage file. Omit = memory only. */
  stateDir?: string;
  /** Pre-built usage store (default: one backed by stateDir). */
  usageStore?: AcpControlUsageStore;
  /** Pre-built budget-alert store (default: one backed by stateDir). */
  alertStore?: AcpControlAlertStore;
  /** Pre-built process manager (default: new ExternalAgentManager). Tests inject a fake-backed one. */
  agentManager?: ExternalAgentManager;
  /** Logger (default: silent). */
  logger?: (message: string) => void;
}

export interface RegisterAgentInput {
  backendId: ControlCenterBackendId;
  name: string;
  command: string;
  args?: string[];
  resolvedPath?: string;
  speaksAcp?: boolean;
  agentName?: string;
  agentVersion?: string;
  loginLabel?: string;
  loginMethod?: ManagedAgentRecord['loginMethod'];
  loggedIn?: boolean;
  budget?: AgentBudget;
  enabled?: boolean;
}

export interface PromptTurnResult {
  agentId: string;
  sessionId: string;
  stopReason: string;
  /** Concatenated agent_message_chunk text of the turn. */
  text: string;
  turn: AgentUsageTurn;
  budget: BudgetEvaluation;
}

interface ControlAgentsFile {
  version: 1;
  agents: ManagedAgentRecord[];
}

interface TurnAccumulator {
  text: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
  toolCalls: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isValidRecord(value: unknown): value is ManagedAgentRecord {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === 'string' &&
    typeof value.backendId === 'string' &&
    typeof value.name === 'string' &&
    typeof value.command === 'string' &&
    Array.isArray(value.args) &&
    isRecord(value.budget) &&
    typeof value.enabled === 'boolean' &&
    typeof value.createdAt === 'string'
  );
}

/** Pull token/cost numbers out of a `usage_update` payload (tolerant of key spellings). */
export function extractUsageNumbers(usage: unknown): {
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
} {
  const out = { inputTokens: 0, outputTokens: 0, costUsd: null as number | null };
  if (!isRecord(usage)) return out;
  const num = (keys: string[]): number | undefined => {
    for (const key of keys) {
      const v = usage[key];
      if (typeof v === 'number' && Number.isFinite(v)) return v;
    }
    return undefined;
  };
  // Nested `tokens: { input, output }` shape used by some agents.
  const nested = isRecord(usage.tokens) ? usage.tokens : isRecord(usage.usage) ? usage.usage : undefined;
  const read = (keys: string[]): number | undefined => num(keys) ?? (nested ? (() => {
    for (const key of keys) {
      const v = nested[key];
      if (typeof v === 'number' && Number.isFinite(v)) return v;
    }
    return undefined;
  })() : undefined);
  const input = read(['inputTokens', 'input_tokens', 'promptTokens', 'prompt_tokens', 'input', 'prompt']);
  const output = read(['outputTokens', 'output_tokens', 'completionTokens', 'completion_tokens', 'output', 'completion']);
  const total = read(['totalTokens', 'total_tokens', 'total']);
  if (input !== undefined) out.inputTokens = Math.max(0, Math.floor(input));
  if (output !== undefined) out.outputTokens = Math.max(0, Math.floor(output));
  if (out.inputTokens === 0 && out.outputTokens === 0 && total !== undefined) {
    out.inputTokens = Math.max(0, Math.floor(total));
  }
  const cost = read(['costUsd', 'cost_usd', 'cost', 'totalCostUsd', 'estimatedCostUsd']);
  if (cost !== undefined) out.costUsd = Math.max(0, cost);
  return out;
}

/** The Control Center itself. */
export class AcpControlCenter {
  private readonly stateDir?: string;
  private readonly usage: AcpControlUsageStore;
  private readonly alerts: AcpControlAlertStore;
  private readonly manager: ExternalAgentManager;
  private readonly logger?: (message: string) => void;
  private readonly agents = new Map<string, ManagedAgentRecord>();
  /** Managed-agent id -> ExternalAgentManager agent id. */
  private readonly running = new Map<string, string>();
  private readonly listeners = new Set<ControlCenterEventListener>();
  private loaded = false;

  constructor(options: AcpControlCenterOptions = {}) {
    this.stateDir = options.stateDir;
    this.usage = options.usageStore ?? new AcpControlUsageStore({ stateDir: options.stateDir });
    this.alerts = options.alertStore ?? new AcpControlAlertStore({ stateDir: options.stateDir });
    this.manager = options.agentManager ?? new ExternalAgentManager();
    this.logger = options.logger;
  }

  get usageStore(): AcpControlUsageStore {
    return this.usage;
  }

  get alertStore(): AcpControlAlertStore {
    return this.alerts;
  }

  get stateFilePath(): string | undefined {
    return this.stateDir ? path.join(this.stateDir, CONTROL_AGENTS_FILENAME) : undefined;
  }

  // ------------------------------------------------------------------
  // Persistence
  // ------------------------------------------------------------------

  load(): void {
    if (this.loaded) return;
    this.loaded = true;
    if (!this.stateFilePath) return;
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(this.stateFilePath, 'utf8'));
      if (isRecord(parsed) && Array.isArray(parsed.agents)) {
        for (const raw of parsed.agents) {
          if (!isValidRecord(raw)) continue;
          const record: ManagedAgentRecord = {
            ...raw,
            sessions: isRecord(raw.sessions) ? (raw.sessions as Record<string, string>) : {},
            restarts: typeof raw.restarts === 'number' ? raw.restarts : 0,
            status: raw.status === 'running' || raw.status === 'starting' ? 'stopped' : (raw.status as ManagedAgentStatus),
            lastError:
              raw.status === 'running' || raw.status === 'starting'
                ? 'agent process did not survive restart'
                : raw.lastError,
          };
          this.agents.set(record.id, record);
        }
      }
    } catch {
      // Missing / corrupt file: start empty, never crash.
    }
  }

  save(): void {
    if (!this.stateFilePath || !this.stateDir) return;
    try {
      fs.mkdirSync(this.stateDir, { recursive: true });
      const tmp = path.join(this.stateDir, `${CONTROL_AGENTS_FILENAME}.tmp-${process.pid}`);
      const file: ControlAgentsFile = { version: 1, agents: [...this.agents.values()] };
      fs.writeFileSync(tmp, JSON.stringify(file, null, 2), { mode: 0o600 });
      fs.renameSync(tmp, this.stateFilePath);
    } catch (error) {
      this.logger?.(`[acp-control] could not save state: ${(error as Error).message}`);
    }
  }

  // ------------------------------------------------------------------
  // Events
  // ------------------------------------------------------------------

  on(listener: ControlCenterEventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(event: ControlCenterEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch {
        // A listener must never break the center.
      }
    }
  }

  // ------------------------------------------------------------------
  // Registry
  // ------------------------------------------------------------------

  /** Discover installed CLI agents (PATH + optional ACP probe + login). */
  async discover(options: DiscoverOptions = {}, deps: DiscoveryDeps = {}): Promise<DiscoveredControlAgent[]> {
    this.load();
    return discoverControlCenterAgents(
      { ...options, registeredBackendIds: [...this.agents.values()].map((a) => a.backendId) },
      deps,
    );
  }

  /** Register a discovered agent. The id is `cc-<backendId>` (stable, one row per backend). */
  register(input: RegisterAgentInput): ManagedAgentRecord {
    this.load();
    if (!input.command.trim()) {
      throw new AcpControlError('command must be a non-empty binary name.', 'invalid-registration');
    }
    if (input.backendId !== 'custom') {
      const clash = [...this.agents.values()].find((a) => a.backendId === input.backendId);
      if (clash) {
        throw new AcpControlError(`backend ${input.backendId} is already registered as ${clash.id}.`, 'duplicate', clash.id);
      }
    }
    const budgetErrors = input.budget ? validateBudget(input.budget) : [];
    if (budgetErrors.length > 0) {
      throw new AcpControlError(`invalid budget: ${budgetErrors.join(' ')}`, 'invalid-budget');
    }
    const id = input.backendId === 'custom' ? `cc-custom-${randomUUID().slice(0, 8)}` : `cc-${input.backendId}`;
    const record: ManagedAgentRecord = {
      id,
      backendId: input.backendId,
      name: input.name,
      command: input.command,
      args: input.args ?? [],
      resolvedPath: input.resolvedPath,
      agentName: input.agentName,
      agentVersion: input.agentVersion,
      speaksAcp: input.speaksAcp ?? false,
      loginLabel: input.loginLabel,
      loginMethod: input.loginMethod ?? 'unknown',
      loggedIn: input.loggedIn ?? false,
      enabled: input.enabled ?? false,
      status: 'registered',
      budget: input.budget ?? defaultBudget(),
      createdAt: new Date().toISOString(),
      restarts: 0,
      sessions: {},
    };
    this.agents.set(id, record);
    this.save();
    this.emit({ type: 'agent-registered', agentId: id });
    return record;
  }

  /** Register straight from a discovery row (one call from the UI). */
  registerDiscovered(found: DiscoveredControlAgent, budget?: AgentBudget): ManagedAgentRecord {
    return this.register({
      backendId: found.backendId,
      name: found.name,
      command: found.command,
      args: found.args,
      resolvedPath: found.resolvedPath,
      speaksAcp: found.speaksAcp,
      agentName: found.agentName,
      agentVersion: found.agentVersion,
      loginLabel: found.loginLabel,
      loginMethod: found.loginMethod,
      loggedIn: found.loggedIn,
      budget,
    });
  }

  /** Remove a registration (stops a running agent first). Usage history is kept unless `clearUsage` is set. */
  deregister(agentId: string, options: { clearUsage?: boolean } = {}): boolean {
    this.load();
    const record = this.agents.get(agentId);
    if (!record) return false;
    if (this.running.has(agentId)) this.stop(agentId, 'deregistered');
    this.agents.delete(agentId);
    if (options.clearUsage) {
      this.usage.clearAgent(agentId);
      this.alerts.clearAgent(agentId);
    }
    this.save();
    this.emit({ type: 'agent-removed', agentId });
    return true;
  }

  get(agentId: string): ManagedAgentRecord | undefined {
    this.load();
    const record = this.agents.get(agentId);
    return record ? { ...record, sessions: { ...record.sessions }, budget: { ...record.budget } } : undefined;
  }

  list(): ManagedAgentRecord[] {
    this.load();
    return [...this.agents.values()].map((r) => ({ ...r, sessions: { ...r.sessions }, budget: { ...r.budget } }));
  }

  setEnabled(agentId: string, enabled: boolean): ManagedAgentRecord {
    const record = this.requireRecord(agentId);
    record.enabled = enabled;
    if (!enabled && this.running.has(agentId)) this.stop(agentId, 'disabled');
    this.save();
    return { ...record };
  }

  setBudget(agentId: string, patch: Partial<AgentBudget>): { record: ManagedAgentRecord; evaluation: BudgetEvaluation } {
    const record = this.requireRecord(agentId);
    const next: AgentBudget = { ...record.budget, ...patch };
    const errors = validateBudget(next);
    if (errors.length > 0) {
      throw new AcpControlError(`invalid budget: ${errors.join(' ')}`, 'invalid-budget', agentId);
    }
    record.budget = next;
    // A tighter budget can block an already-running agent on its next turn;
    // an emptied budget un-blocks a `blocked` agent back to `registered`.
    if (record.status === 'blocked' && !this.evaluate(agentId).blocked) {
      record.status = this.running.has(agentId) ? 'running' : 'registered';
    }
    this.save();
    this.emit({ type: 'budget-updated', agentId });
    return { record: { ...record }, evaluation: this.evaluate(agentId) };
  }

  // ------------------------------------------------------------------
  // Budget + usage views
  // ------------------------------------------------------------------

  /** Today's budget evaluation for one agent. */
  evaluate(agentId: string, now: Date = new Date()): BudgetEvaluation {
    const record = this.requireRecord(agentId);
    return evaluateBudget(agentId, record.budget, this.usage.today(agentId, now), localDay(now));
  }

  todayUsage(agentId: string, now: Date = new Date()): AgentUsageSummary {
    this.requireRecord(agentId);
    return this.usage.today(agentId, now);
  }

  totalUsage(agentId: string): AgentUsageSummary {
    this.requireRecord(agentId);
    return this.usage.summary(agentId);
  }

  history(agentId: string, limit?: number): AgentUsageTurn[] {
    this.requireRecord(agentId);
    return this.usage.history(agentId, limit);
  }

  /**
   * Per-day usage for the last `days` local days (oldest first) plus
   * the all-time total. Days with no turns still appear (zero usage)
   * so the UI can render a continuous table.
   */
  usageReport(agentId: string, days = 7, now: Date = new Date()): AgentUsageReport {
    this.requireRecord(agentId);
    const blockedDays = new Set(
      this.alerts
        .forAgent(agentId)
        .filter((a) => a.kind === 'exceeded' || a.kind === 'blocked')
        .map((a) => a.day),
    );
    const reportDays: AgentUsageReport['days'] = [];
    for (let i = days - 1; i >= 0; i -= 1) {
      const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
      const day = localDay(date);
      const summary = this.usage.summary(agentId, day);
      reportDays.push({ day, summary, blocked: blockedDays.has(day) });
    }
    return { agentId, days: reportDays, total: this.usage.summary(agentId) };
  }

  /** Budget alerts for one agent, newest first. */
  alertsFor(agentId: string, limit?: number): AcpControlBudgetAlert[] {
    this.requireRecord(agentId);
    return this.alerts.forAgent(agentId, limit);
  }

  /** All budget alerts, newest first. */
  allAlerts(limit?: number): AcpControlBudgetAlert[] {
    return this.alerts.all(limit);
  }

  /** List the agent-side sessions of a running agent. */
  async listSessions(agentId: string): Promise<AcpSessionInfo[]> {
    const record = this.requireRecord(agentId);
    const managed = this.manager.get(this.running.get(agentId) ?? '');
    if (!managed) {
      throw new AcpControlError(`agent ${record.name} is not running.`, 'not-running', agentId);
    }
    return managed.client.listSessions();
  }

  /** Close one session on a running agent. */
  async closeSession(agentId: string, sessionId: string): Promise<boolean> {
    const record = this.requireRecord(agentId);
    const managed = this.manager.get(this.running.get(agentId) ?? '');
    if (!managed) {
      throw new AcpControlError(`agent ${record.name} is not running.`, 'not-running', agentId);
    }
    return managed.client.closeSession(sessionId);
  }

  /** Cancel the running turn of a session. */
  async cancelTurn(agentId: string, sessionId: string): Promise<boolean> {
    const record = this.requireRecord(agentId);
    const managed = this.manager.get(this.running.get(agentId) ?? '');
    if (!managed) {
      throw new AcpControlError(`agent ${record.name} is not running.`, 'not-running', agentId);
    }
    return managed.client.cancelSession(sessionId);
  }

  /** One UI row per managed agent (record + today/total usage + budget). */
  views(now: Date = new Date()): ManagedAgentView[] {
    return this.list().map((record) => ({
      record,
      today: this.usage.today(record.id, now),
      total: this.usage.summary(record.id),
      budget: evaluateBudget(record.id, record.budget, this.usage.today(record.id, now), localDay(now)),
    }));
  }

  /** Center-wide totals (all agents, today + all time). */
  totals(now: Date = new Date()): { today: AgentUsageSummary; total: AgentUsageSummary } {
    return {
      today: this.usage.summaryAll(localDay(now)),
      total: this.usage.summaryAll(),
    };
  }

  // ------------------------------------------------------------------
  // Lifecycle
  // ------------------------------------------------------------------

  isRunning(agentId: string): boolean {
    return this.running.has(agentId) && this.manager.get(this.running.get(agentId) ?? '') !== undefined;
  }

  /** Start (spawn + ACP handshake) a registered agent. */
  async start(agentId: string): Promise<ManagedAgentRecord> {
    const record = this.requireRecord(agentId);
    if (!record.enabled) {
      throw new AcpControlError(`agent ${record.name} is disabled — enable it first.`, 'not-enabled', agentId);
    }
    if (this.running.has(agentId)) {
      throw new AcpControlError(`agent ${record.name} is already running.`, 'already-running', agentId);
    }
    const evaluation = this.evaluate(agentId);
    if (evaluation.blocked) {
      record.status = 'blocked';
      record.lastError = `budget exceeded: ${evaluation.reasons.join('; ')}`;
      this.save();
      this.recordAlert('blocked', agentId, evaluation);
      this.emit({ type: 'budget-exceeded', agentId, reasons: evaluation.reasons });
      throw new AcpControlError(
        `budget exceeded for ${record.name}: ${evaluation.reasons.join('; ')}`,
        'budget-blocked',
        agentId,
        evaluation.reasons,
      );
    }
    record.status = 'starting';
    record.lastError = undefined;
    this.save();
    try {
      const managed = await this.manager.spawn(record.name, record.command, record.args);
      this.running.set(agentId, managed.id);
      record.status = 'running';
      record.startedAt = new Date().toISOString();
      record.agentName = managed.client.agentInfo?.agentInfo.name ?? record.agentName;
      record.agentVersion = managed.client.agentInfo?.agentInfo.version ?? record.agentVersion;
      record.speaksAcp = true;
      record.lastError = undefined;
      managed.process.on('exit', () => {
        // Unexpected exit while still registered as running: mark stopped.
        if (this.running.get(agentId) === managed.id) {
          this.running.delete(agentId);
          const current = this.agents.get(agentId);
          if (current && current.status === 'running') {
            current.status = 'stopped';
            current.stoppedAt = new Date().toISOString();
            current.restarts += 1;
            this.save();
            this.emit({ type: 'agent-stopped', agentId, reason: 'process exited' });
          }
        }
      });
    } catch (error) {
      record.status = 'error';
      record.lastError = error instanceof Error ? error.message : String(error);
      this.save();
      this.emit({ type: 'agent-error', agentId, error: record.lastError });
      throw new AcpControlError(`failed to start ${record.name}: ${record.lastError}`, 'spawn-failed', agentId);
    }
    this.save();
    this.emit({ type: 'agent-started', agentId });
    return { ...record };
  }

  /** Stop a running agent (kills the process). */
  stop(agentId: string, reason?: string): boolean {
    const record = this.requireRecord(agentId);
    const managedId = this.running.get(agentId);
    if (!managedId) {
      if (record.status === 'running' || record.status === 'starting') {
        record.status = 'stopped';
        record.stoppedAt = new Date().toISOString();
        this.save();
      }
      return false;
    }
    this.running.delete(agentId);
    this.manager.kill(managedId);
    record.status = 'stopped';
    record.stoppedAt = new Date().toISOString();
    record.restarts = 0;
    this.save();
    this.emit({ type: 'agent-stopped', agentId, reason });
    return true;
  }

  /** Create a session on a running agent. */
  async newSession(agentId: string, cwd: string) {
    const record = this.requireRecord(agentId);
    const managedId = this.running.get(agentId);
    if (!managedId) {
      throw new AcpControlError(`agent ${record.name} is not running.`, 'not-running', agentId);
    }
    const session = await this.manager.newSession(managedId, cwd);
    record.sessions[cwd] = session.sessionId;
    this.save();
    return session;
  }

  /**
   * Send one prompt turn to a running agent, with budget enforcement.
   * The turn is refused (and recorded as `blocked`, 0 tokens) when
   * today's budget is already exceeded; usage is accumulated from
   * the agent's `usage_update` notifications + `tool_call` updates
   * and recorded when the turn finishes (or fails).
   */
  async prompt(agentId: string, sessionId: string, text: string): Promise<PromptTurnResult> {
    const record = this.requireRecord(agentId);
    const managedId = this.running.get(agentId);
    if (!managedId) {
      throw new AcpControlError(`agent ${record.name} is not running.`, 'not-running', agentId);
    }
    const evaluation = this.evaluate(agentId);
    if (evaluation.blocked) {
      const blockedTurn = this.usage.recordTurn({
        agentId,
        sessionId,
        durationMs: 0,
        stopReason: 'cancelled',
        status: 'blocked',
      });
      record.status = 'blocked';
      this.save();
      this.recordAlert('blocked', agentId, evaluation);
      this.emit({ type: 'turn-blocked', agentId, reasons: evaluation.reasons });
      this.emit({ type: 'budget-exceeded', agentId, reasons: evaluation.reasons });
      throw new AcpControlError(
        `budget exceeded for ${record.name}: ${evaluation.reasons.join('; ')}`,
        'budget-blocked',
        agentId,
        evaluation.reasons,
      );
    }
    const startedAt = Date.now();
    const acc: TurnAccumulator = { text: '', inputTokens: 0, outputTokens: 0, costUsd: null, toolCalls: 0 };
    const onUpdate = (update: AcpSessionUpdate) => {
      if (update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text') {
        acc.text += update.content.text;
      } else if (update.sessionUpdate === 'tool_call') {
        acc.toolCalls += 1;
      } else if (update.sessionUpdate === 'usage_update' && update.usage) {
        const numbers = extractUsageNumbers(update.usage);
        acc.inputTokens = Math.max(acc.inputTokens, numbers.inputTokens);
        acc.outputTokens = Math.max(acc.outputTokens, numbers.outputTokens);
        if (numbers.costUsd !== null) acc.costUsd = numbers.costUsd;
      }
    };
    let stopReason = 'end_turn';
    let status: AgentUsageTurn['status'] = 'completed';
    // NOTE: ExternalAgentManager.prompt() has no per-turn update slot,
    // so the turn goes through the managed agent's AcpClient directly
    // (same process, same session) to capture streamed text + usage.
    const managed = this.manager.get(managedId);
    if (!managed) {
      throw new AcpControlError(`agent ${record.name} is not running.`, 'not-running', agentId);
    }
    try {
      const result = await managed.client.prompt(sessionId, [{ type: 'text', text }] as AcpContentBlock[], onUpdate);
      stopReason = result.stopReason;
    } catch (error) {
      status = 'failed';
      stopReason = 'cancelled';
      const turn = this.usage.recordTurn({
        agentId,
        sessionId,
        inputTokens: acc.inputTokens,
        outputTokens: acc.outputTokens,
        costUsd: acc.costUsd,
        durationMs: Date.now() - startedAt,
        stopReason,
        status,
        toolCalls: acc.toolCalls,
      });
      this.emit({ type: 'turn-recorded', agentId, turnId: turn.id });
      throw error;
    }
    const turn = this.usage.recordTurn({
      agentId,
      sessionId,
      inputTokens: acc.inputTokens,
      outputTokens: acc.outputTokens,
      costUsd: acc.costUsd,
      durationMs: Date.now() - startedAt,
      stopReason,
      status,
      toolCalls: acc.toolCalls,
    });
    this.emit({ type: 'turn-recorded', agentId, turnId: turn.id });
    const after = this.evaluate(agentId);
    if (after.blocked) {
      record.status = 'blocked';
      this.save();
      this.recordAlert('exceeded', agentId, after);
      this.emit({ type: 'budget-exceeded', agentId, reasons: after.reasons });
      // Opt-in hard stop: kill the process the moment a turn pushes
      // it over budget, instead of only refusing the next turn. The
      // status stays 'blocked' (not 'stopped') so the UI still shows
      // WHY the agent is down — stop() runs first, then blocked wins.
      if (record.budget.stopOnExceed && this.running.has(agentId)) {
        this.stop(agentId, 'budget exceeded (stopOnExceed)');
        record.status = 'blocked';
        this.save();
      }
    } else if (after.warned) {
      this.recordAlert('warned', agentId, after);
      this.emit({ type: 'budget-warned', agentId, reasons: after.reasons });
    }
    return { agentId, sessionId, stopReason, text: acc.text, turn, budget: after };
  }

  /** Stop every running agent. */
  dispose(): void {
    for (const agentId of [...this.running.keys()]) this.stop(agentId, 'disposed');
  }

  /** Re-run discovery and refresh installed/login/probe fields on registered agents (budgets + status untouched). */
  async refreshDiscovery(options: DiscoverOptions = {}, deps: DiscoveryDeps = {}): Promise<DiscoveredControlAgent[]> {
    const found = await this.discover(options, deps);
    const byBackend = new Map(found.map((f) => [f.backendId, f]));
    for (const record of this.agents.values()) {
      const match = byBackend.get(record.backendId);
      if (!match) continue;
      record.resolvedPath = match.resolvedPath;
      record.speaksAcp = match.speaksAcp || record.speaksAcp;
      record.agentName = match.agentName ?? record.agentName;
      record.agentVersion = match.agentVersion ?? record.agentVersion;
      record.loginLabel = match.loginLabel ?? record.loginLabel;
      record.loginMethod = match.loginMethod ?? record.loginMethod;
      record.loggedIn = match.loggedIn;
    }
    this.save();
    return found;
  }

  private requireRecord(agentId: string): ManagedAgentRecord {
    this.load();
    const record = this.agents.get(agentId);
    if (!record) throw new AcpControlError(`unknown managed agent: ${agentId}`, 'not-found', agentId);
    return record;
  }

  private recordAlert(kind: AcpControlBudgetAlertKind, agentId: string, evaluation: BudgetEvaluation): void {
    this.alerts.record({ agentId, kind, reasons: evaluation.reasons, day: evaluation.day });
  }
}

/** Empty usage summary re-exported for callers that only import the manager. */
export { emptyUsageSummary };

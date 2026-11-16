/**
 * ACP Control Center (v1.12, Team T4) — managed external CLI agents.
 *
 * OpenHands-style "Agent Control Center" idea, re-implemented for
 * open-bot: an external coding CLI (Claude Code, Codex, Gemini CLI,
 * OpenCode, ...) is treated as a *managed agent* — discovered on the
 * machine, registered by the user, started/stopped, given a budget,
 * and watched for usage. Only the IDEA is borrowed (a control plane
 * over already-installed CLI agents); every line here is fresh
 * open-bot code on top of the existing ACP stack
 * (`packages/core/src/acp/`).
 *
 * SAFETY — the same rules as the existing ACP client side and the
 * detected-CLI registry:
 * - Nothing is auto-executed: an agent only spawns when the user
 *   explicitly starts it (or a tool call with approval does).
 * - The agent runs through ITS OWN CLI binary and ITS OWN login
 *   session on this machine. open-bot never reads, copies, or sends
 *   any credential anywhere. Login state is only ever reported by
 *   the CLI itself (`detected/` registry) or by a successful ACP
 *   `initialize` handshake — never by reading a token file.
 * - Budgets are enforced locally before a turn is sent; a turn that
 *   would start over budget is refused, never silently run.
 * - All persistence is plain JSON under the caller's state dir
 *   (registrations, budgets, usage history). No secrets are stored.
 */

export type ManagedAgentStatus =
  | 'registered' // known + registered, never started (or stopped by user)
  | 'starting' // spawn in progress
  | 'running' // process alive, ACP handshake done
  | 'stopped' // was running, stopped by user (or exited cleanly)
  | 'error' // last start/probe failed; see lastError
  | 'blocked'; // budget exceeded — start/prompt refused until budget changes

/** Which external CLI this managed agent wraps. */
export type ControlCenterBackendId =
  | 'claude'
  | 'codex'
  | 'gemini'
  | 'opencode'
  | 'grok'
  | 'cursor'
  | 'copilot'
  | 'devin'
  | 'zed'
  | 'custom';

/** How the agent's login was established (label only, never a secret). */
export type ControlCenterLoginMethod = 'oauth' | 'subscription' | 'api-key' | 'env-present' | 'unknown';

/**
 * Budget policy for one managed agent. Every field is optional:
 * an unset dimension is unlimited. Windows are per local calendar
 * day (tokens / cost / calls / wall time), reset at local midnight.
 */
export interface AgentBudget {
  /** Max input+output tokens per local day. */
  maxTokensPerDay?: number;
  /** Max estimated USD cost per local day (null cost = unpriced, counts as 0). */
  maxCostUsdPerDay?: number;
  /** Max prompt turns per local day. */
  maxCallsPerDay?: number;
  /** Max total turn wall time per local day, milliseconds. */
  maxWallMsPerDay?: number;
  /** Warn (don't block) when usage reaches this fraction of a cap (default 0.8). */
  warnAtFraction?: number;
  /**
   * When true, the center stops the agent's process the moment a
   * turn pushes it over budget (instead of only refusing the next
   * turn). Default false.
   */
  stopOnExceed?: boolean;
}

/** One recorded prompt turn (one `session/prompt` round trip). */
export interface AgentUsageTurn {
  id: string;
  agentId: string;
  sessionId: string;
  /** ISO timestamp when the turn started. */
  at: string;
  inputTokens: number;
  outputTokens: number;
  /** Estimated USD cost; null when the model/usage is unpriced. */
  costUsd: number | null;
  /** Wall time of the turn, milliseconds. */
  durationMs: number;
  /** ACP stop reason of the turn. */
  stopReason: string;
  /** 'completed' | 'blocked' (refused by budget) | 'failed' (agent error). */
  status: 'completed' | 'blocked' | 'failed';
  /** Number of tool calls the agent reported during the turn. */
  toolCalls: number;
}

/** Aggregated usage over a window (today / all time / one agent). */
export interface AgentUsageSummary {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  /** Sum of known costs, or null when ANY turn in scope is unpriced. */
  costUsd: number | null;
  /** Number of prompt turns in scope. */
  calls: number;
  /** Turns whose cost is unknown (unpriced). */
  unpricedCalls: number;
  /** Total turn wall time, milliseconds. */
  wallMs: number;
  /** Total tool calls reported. */
  toolCalls: number;
}

/** One budget dimension's state: used vs cap. */
export interface BudgetDimensionState {
  dimension: 'tokens' | 'cost' | 'calls' | 'wallMs';
  used: number;
  /** Undefined = unlimited. */
  limit?: number;
  /** used / limit, or null when unlimited. */
  fractionUsed: number | null;
  /** True when usage reached the warn threshold (default 80%). */
  warned: boolean;
  /** True when usage reached or passed the cap. */
  exceeded: boolean;
}

/** Full budget evaluation for one agent (today's window). */
export interface BudgetEvaluation {
  agentId: string;
  /** Local calendar day the evaluation covers (YYYY-MM-DD). */
  day: string;
  dimensions: BudgetDimensionState[];
  /** True when any dimension is exceeded — turns must be refused. */
  blocked: boolean;
  /** True when any dimension is warned but not exceeded. */
  warned: boolean;
  /** Human-readable reasons, one per warned/exceeded dimension. */
  reasons: string[];
}

/** One managed agent — the unit the Control Center tracks. */
export interface ManagedAgentRecord {
  /** Stable id: `cc-<backendId>` for built-ins, uuid for custom. */
  id: string;
  backendId: ControlCenterBackendId;
  /** Display name (e.g. "Claude Code"). */
  name: string;
  /** Binary name (e.g. "claude"). */
  command: string;
  /** Argv that puts the binary into ACP stdio mode. */
  args: string[];
  /** Absolute path resolved from PATH, when installed. */
  resolvedPath?: string;
  /** Agent name/version reported by the ACP handshake, when probed. */
  agentName?: string;
  agentVersion?: string;
  /** True when the binary answered a real ACP `initialize`. */
  speaksAcp: boolean;
  /** Login label reported by the CLI itself (email / username / provider list). Never a secret. */
  loginLabel?: string;
  loginMethod?: ControlCenterLoginMethod;
  /** True when the CLI reports a logged-in account. */
  loggedIn: boolean;
  /** User opt-in: only enabled agents may be started. Default false. */
  enabled: boolean;
  status: ManagedAgentStatus;
  budget: AgentBudget;
  /** ISO timestamp of registration. */
  createdAt: string;
  /** ISO timestamp of the last successful start. */
  startedAt?: string;
  /** ISO timestamp of the last stop. */
  stoppedAt?: string;
  /** Last start/probe error message (no secrets). */
  lastError?: string;
  /** Lazy restarts after unexpected exits (reset on clean stop). */
  restarts: number;
  /** Session ids created on this agent, by cwd. */
  sessions: Record<string, string>;
}

/** A discovered (not yet registered) external CLI agent. */
export interface DiscoveredControlAgent {
  backendId: ControlCenterBackendId;
  name: string;
  command: string;
  args: string[];
  resolvedPath?: string;
  /** True when the binary exists on PATH. */
  installed: boolean;
  /** True when the binary answered a real ACP `initialize` (probe-gated). */
  speaksAcp: boolean;
  agentName?: string;
  agentVersion?: string;
  /** Login label from the CLI's own status check (never a secret). */
  loginLabel?: string;
  loginMethod?: ControlCenterLoginMethod;
  loggedIn: boolean;
  /** True when open-bot already ships a driver for this backend. */
  verifiedInRepo: boolean;
  /** Why discovery/probe failed, when it did. */
  error?: string;
  /** True when this backend is already registered in the center. */
  alreadyRegistered: boolean;
}

/** Snapshot the UI / tools render: one row per managed agent. */
export interface ManagedAgentView {
  record: ManagedAgentRecord;
  /** Today's usage for this agent. */
  today: AgentUsageSummary;
  /** All-time usage for this agent. */
  total: AgentUsageSummary;
  /** Budget evaluation for today. */
  budget: BudgetEvaluation;
}

/** One day of usage inside a multi-day report. */
export interface AgentUsageDay {
  /** Local calendar day (YYYY-MM-DD). */
  day: string;
  summary: AgentUsageSummary;
  /** True when any budget dimension was exceeded that day. */
  blocked: boolean;
}

/** Multi-day usage report for one agent (newest day last). */
export interface AgentUsageReport {
  agentId: string;
  days: AgentUsageDay[];
  total: AgentUsageSummary;
}

/** Events emitted by the Control Center (subscribe for UI refresh). */
export type ControlCenterEvent =
  | { type: 'agent-registered'; agentId: string }
  | { type: 'agent-removed'; agentId: string }
  | { type: 'agent-started'; agentId: string }
  | { type: 'agent-stopped'; agentId: string; reason?: string }
  | { type: 'agent-error'; agentId: string; error: string }
  | { type: 'budget-updated'; agentId: string }
  | { type: 'budget-exceeded'; agentId: string; reasons: string[] }
  | { type: 'budget-warned'; agentId: string; reasons: string[] }
  | { type: 'turn-recorded'; agentId: string; turnId: string }
  | { type: 'turn-blocked'; agentId: string; reasons: string[] };

export type ControlCenterEventListener = (event: ControlCenterEvent) => void;

/** Local calendar day (YYYY-MM-DD) for a Date in the machine's timezone. */
export function localDay(date: Date = new Date()): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** Empty usage summary (zero turns). */
export function emptyUsageSummary(): AgentUsageSummary {
  return {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    costUsd: 0,
    calls: 0,
    unpricedCalls: 0,
    wallMs: 0,
    toolCalls: 0,
  };
}

/** Default budget: no caps, warn at 80% of any cap that is set. */
export const DEFAULT_BUDGET_WARN_FRACTION = 0.8;

export function defaultBudget(): AgentBudget {
  return { warnAtFraction: DEFAULT_BUDGET_WARN_FRACTION };
}

/**
 * Sandbox v4 — shared types (v1.36, Team T4).
 *
 * One layer above sandbox v3: v3 gives a single deep sandbox
 * session (syscall allowlist, egress gate, lifetime, snapshots,
 * hooks); v4 ties that session to a *conversation* and to the
 * agent that works inside it:
 *
 *  - per-conversation runtime (`conversationRuntime.ts`) — every
 *    conversation gets its own isolated runtime: its own v3
 *    session, its own workspace directory, its own process
 *    registry. Stopping a runtime kills its processes and,
 *    on cleanup, removes its workspace. Nothing leaks across
 *    conversations.
 *  - agent profiles (`agentProfiles.ts`) — a profile is a
 *    persona + instructions + a skill selection from the
 *    server skill catalog + its own LLM profile (model and
 *    sampling parameters). A runtime runs under exactly one
 *    profile at a time.
 *  - conversation budget meter (`budgetMeter.ts`) — token /
 *    dollar / wall-time budget per conversation, with a
 *    warning threshold and a soft block when a hard limit is
 *    crossed. The meter never silently lets a run past its
 *    budget: it reports `soft-blocked` and the runtime
 *    refuses new steps until the budget is raised or reset.
 *  - secret requests (`secretRequests.ts`) — an agent may ask
 *    for a secret mid-conversation (API key, token, password).
 *    The value lives in memory only, is single-use, and is
 *    NEVER written to any log, context, history or report:
 *    every describe / list / audit entry carries metadata
 *    only, and `redactText` scrubs known values out of text
 *    before it is logged.
 *  - dependency map (`dependencyMap.ts`) — Large-Codebase-style
 *    map for the coding agent: the import graph of a whole
 *    tree, topological change order, reverse-dependency
 *    impact sets, and conflict detection when several agents
 *    edit overlapping regions at the same time.
 *
 * Ideas only from the OpenHands 1.38 release notes (per-
 * conversation runtime, agent profiles, secret requests,
 * conversation budget meters, Large Codebase SDK) as
 * summarised in docs/repo-survey-v136.md — no code, text or
 * asset copied from any repo, xAI or Cursor.
 *
 * Fail-closed everywhere: an unknown conversation, an unknown
 * profile, an unknown skill, a budget already blown, a secret
 * request that is not pending, or a dependency cycle all stop
 * the operation, never let it through silently.
 */

import type { SandboxV2Tier, SandboxV2TrustLevel } from '../sandboxV2/types';

/** Re-exported so v4 callers never need to import v2 types directly. */
export type { SandboxV2Tier, SandboxV2TrustLevel };

/** A conversation id is a safe path segment: letters, digits, `_`, `-`. */
export const SANDBOX_V4_CONVERSATION_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

/** A profile id is a safe slug: lowercase letters, digits, `_`, `-`. */
export const SANDBOX_V4_PROFILE_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** A skill id is a safe slug: lowercase letters, digits, `_`, `-`, `.` not allowed. */
export const SANDBOX_V4_SKILL_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** Runtime lifecycle states. `cleaned` is terminal: the workspace is gone. */
export type SandboxV4RuntimeState =
  | 'created'
  | 'running'
  | 'paused'
  | 'stopped'
  | 'expired'
  | 'cleaned';

/** Why a runtime ended. */
export type SandboxV4RuntimeEndReason =
  | 'completed'
  | 'stopped-by-user'
  | 'budget-exceeded'
  | 'lifetime-cap'
  | 'idle-timeout'
  | 'error'
  | 'killed';

/** How a spawned process inside a runtime ended (best-effort report). */
export type SandboxV4ProcessEndKind = 'exited' | 'killed' | 'unknown';

/** One process spawned inside a conversation runtime. */
export interface SandboxV4RuntimeProcess {
  /** OS pid (0 when the process was never actually spawned). */
  pid: number;
  /** Human label, e.g. `npm test` or `dev-server`. */
  label: string;
  /** Command line that was spawned (no secrets — callers must scrub first). */
  command: string;
  /** When the process was registered (ms since epoch). */
  startedAtMs: number;
  /** When the process ended (0 while running). */
  endedAtMs: number;
  /** Exit code (null while running or when unknown). */
  exitCode: number | null;
  /** How it ended. */
  endKind: SandboxV4ProcessEndKind;
}

/** A per-conversation runtime: one v3 session + isolation around it. */
export interface SandboxV4ConversationRuntime {
  /** Runtime id (uuid). */
  id: string;
  /** Conversation this runtime belongs to. */
  conversationId: string;
  /** Underlying sandbox v3 session id. */
  sessionId: string;
  /** Current lifecycle state. */
  state: SandboxV4RuntimeState;
  /** Agent profile id the runtime runs under ('' = none assigned). */
  profileId: string;
  /** Trust level the runtime was created for. */
  trust: SandboxV2TrustLevel;
  /** Isolation tier of the underlying v3 session. */
  tier: SandboxV2Tier;
  /** Workspace directory for this conversation (under the v4 base dir). */
  workdir: string;
  /** When the runtime was created (ms since epoch). */
  createdAtMs: number;
  /** Hard deadline (ms since epoch). 0 = no lifetime cap. */
  deadlineMs: number;
  /** Last activity (ms since epoch) — heartbeat / step / tool call. */
  lastActivityAtMs: number;
  /** Processes spawned inside this runtime (live + finished). */
  processes: SandboxV4RuntimeProcess[];
  /** Why the runtime ended (present once stopped / expired / cleaned). */
  endReason?: SandboxV4RuntimeEndReason;
  /** When the runtime ended (ms since epoch). 0 while live. */
  endedAtMs: number;
}

/** Summary of a runtime for list / report endpoints. */
export interface SandboxV4RuntimeSummary {
  id: string;
  conversationId: string;
  sessionId: string;
  state: SandboxV4RuntimeState;
  profileId: string;
  trust: SandboxV2TrustLevel;
  tier: SandboxV2Tier;
  workdir: string;
  createdAtMs: number;
  deadlineMs: number;
  lastActivityAtMs: number;
  liveProcesses: number;
  totalProcesses: number;
  endReason?: SandboxV4RuntimeEndReason;
  endedAtMs: number;
}

/** LLM parameters that belong to one agent profile. */
export interface SandboxV4LlmProfile {
  /** Model id, e.g. `gpt-4o`, `claude-sonnet-4`, `gemini-2.5-flash`, `ollama/llama3`. */
  model: string;
  /** Sampling temperature 0..2. Default 0.2 for coding profiles. */
  temperature: number;
  /** Max output tokens per turn (0 = provider default). */
  maxTokens: number;
  /** Nucleus sampling 0..1. Default 1 (off). */
  topP: number;
  /** Per-turn timeout in ms (0 = no timeout). */
  timeoutMs: number;
}

/** One skill in the v4 skill catalog. */
export interface SandboxV4Skill {
  /** Skill id (slug). */
  id: string;
  /** Display name. */
  name: string;
  /** One-line description of what the skill lets the agent do. */
  description: string;
  /** Tool names the skill unlocks (tool registry names). */
  toolNames: string[];
  /** Whether the skill touches the network. */
  needsNetwork: boolean;
  /** Whether the skill touches the host filesystem outside the workspace. */
  needsHostFs: boolean;
}

/** An agent profile: persona + instructions + skills + LLM profile. */
export interface SandboxV4AgentProfile {
  /** Profile id (slug). */
  id: string;
  /** Display name. */
  name: string;
  /** Who the agent is (one or two sentences, goes into the system prompt). */
  persona: string;
  /** Working instructions for this profile (rules the agent must follow). */
  instructions: string;
  /** Skill ids from the catalog this profile may use. */
  skillIds: string[];
  /** LLM profile for this agent (model + sampling). */
  llm: SandboxV4LlmProfile;
  /** True for the profiles shipped with open-bot. */
  builtin: boolean;
  /** Profile version (bumped on every edit). */
  version: number;
  /** When the profile was created (ms since epoch). */
  createdAtMs: number;
  /** When the profile was last edited (ms since epoch). */
  updatedAtMs: number;
}

/** Budget limits for one conversation. 0 = that dimension is unlimited. */
export interface SandboxV4BudgetLimits {
  /** Max input (prompt) tokens for the conversation. */
  maxInputTokens: number;
  /** Max output (completion) tokens for the conversation. */
  maxOutputTokens: number;
  /** Max spend in USD for the conversation. */
  maxCostUsd: number;
  /** Max wall-clock time in ms for the conversation. */
  maxWallMs: number;
  /** Warn when any used ratio reaches this (0..1, default 0.8). */
  warnAtRatio: number;
}

/** Usage accumulated by one conversation so far. */
export interface SandboxV4BudgetUsage {
  /** Input tokens consumed. */
  inputTokens: number;
  /** Output tokens consumed. */
  outputTokens: number;
  /** Spend in USD (estimated from the model price table). */
  costUsd: number;
  /** Wall-clock time spent in ms. */
  wallMs: number;
  /** Number of recorded steps / turns. */
  steps: number;
}

/** Budget status. `soft-blocked` means a hard limit was crossed. */
export type SandboxV4BudgetStatus = 'ok' | 'warning' | 'soft-blocked';

/** Which dimension(s) crossed a limit or the warning threshold. */
export type SandboxV4BudgetDimension = 'inputTokens' | 'outputTokens' | 'costUsd' | 'wallMs';

/** One recorded usage step (ring-buffered, newest last). */
export interface SandboxV4BudgetStep {
  /** Sequence number inside the conversation (starts at 1). */
  seq: number;
  /** When the step was recorded (ms since epoch). */
  atMs: number;
  /** Model the step ran on ('' when unknown). */
  model: string;
  /** Input tokens in this step. */
  inputTokens: number;
  /** Output tokens in this step. */
  outputTokens: number;
  /** Cost in USD for this step. */
  costUsd: number;
  /** Wall time in ms for this step. */
  wallMs: number;
}

/** Full state of one conversation's budget meter. */
export interface SandboxV4BudgetState {
  /** Conversation the meter belongs to. */
  conversationId: string;
  /** Active limits. */
  limits: SandboxV4BudgetLimits;
  /** Usage so far. */
  usage: SandboxV4BudgetUsage;
  /** Current status. */
  status: SandboxV4BudgetStatus;
  /** Dimensions at or over the warning ratio (sorted). */
  warningDimensions: SandboxV4BudgetDimension[];
  /** Dimensions over a hard limit (sorted, empty unless soft-blocked). */
  blockedDimensions: SandboxV4BudgetDimension[];
  /** Used ratios per dimension (0..1+, capped display at 10). */
  ratios: Record<SandboxV4BudgetDimension, number>;
  /** Remaining headroom per dimension (null when unlimited). */
  remaining: {
    inputTokens: number | null;
    outputTokens: number | null;
    costUsd: number | null;
    wallMs: number | null;
  };
  /** Steps recorded so far (ring buffer, see budgetMeter.ts). */
  steps: SandboxV4BudgetStep[];
  /** When the meter was created (ms since epoch). */
  createdAtMs: number;
  /** When the meter was last reset (ms since epoch, 0 = never). */
  lastResetAtMs: number;
}

/** Secret request lifecycle states. */
export type SandboxV4SecretRequestStatus = 'pending' | 'fulfilled' | 'denied' | 'expired';

/** A secret request (metadata ONLY — the value is never stored here). */
export interface SandboxV4SecretRequest {
  /** Request id (uuid). */
  id: string;
  /** Conversation the request belongs to. */
  conversationId: string;
  /** Secret name, e.g. `GITHUB_TOKEN` or `api-key`. Never the value. */
  name: string;
  /** Why the agent needs it (shown to the user). */
  purpose: string;
  /** Which agent / tool asked ('' when unknown). */
  requestedBy: string;
  /** Current status. */
  status: SandboxV4SecretRequestStatus;
  /** When the request was created (ms since epoch). */
  createdAtMs: number;
  /** When the request expires if still pending (ms since epoch). */
  expiresAtMs: number;
  /** When the request was resolved (ms since epoch, 0 while pending). */
  resolvedAtMs: number;
  /** Who resolved it ('' while pending). Never the value. */
  resolvedBy: string;
  /** Operator note recorded on deny ('' otherwise). Never the value. */
  note: string;
}

/** One audit entry for a secret request. Metadata only, hash-chained. */
export interface SandboxV4SecretAuditEntry {
  /** Sequence number inside the audit log (starts at 1). */
  seq: number;
  /** When the event happened (ms since epoch). */
  atMs: number;
  /** Request the event belongs to. */
  requestId: string;
  /** What happened. */
  event: 'requested' | 'fulfilled' | 'consumed' | 'denied' | 'expired';
  /** Who did it (agent id, user id, or `system`). Never a secret value. */
  actor: string;
  /** Short human-readable detail. Never a secret value. */
  detail: string;
  /** sha-256 chain hash over (prevHash + this entry without its own hash). */
  hash: string;
  /** Hash of the previous entry ('' for seq 1). */
  prevHash: string;
}

/** A node in the dependency map: one source file. */
export interface SandboxV4DepNode {
  /** Path relative to the scanned root (posix separators). */
  path: string;
  /** Language kind, from the extension. */
  kind: 'ts' | 'tsx' | 'js' | 'jsx' | 'py' | 'other';
  /** Files this file imports (relative paths, only in-tree ones). */
  imports: string[];
  /** Files that import this file (reverse edges, computed). */
  importedBy: string[];
  /** External (non-relative) imports, e.g. `react`, `node:fs`. */
  externalImports: string[];
  /** File size in bytes. */
  sizeBytes: number;
  /** Last-modified time (ms since epoch). */
  mtimeMs: number;
}

/** A cycle in the dependency graph (closed loop of imports). */
export interface SandboxV4DepCycle {
  /** Files in the cycle, in import order (first == last is implied). */
  files: string[];
}

/** The full dependency map of one scanned tree. */
export interface SandboxV4DependencyMap {
  /** Root directory that was scanned (absolute). */
  rootDir: string;
  /** When the map was built (ms since epoch). */
  builtAtMs: number;
  /** Nodes keyed by relative path. */
  nodes: Record<string, SandboxV4DepNode>;
  /** Number of files scanned. */
  fileCount: number;
  /** Number of in-tree import edges. */
  edgeCount: number;
  /** Cycles found (empty when the graph is acyclic). */
  cycles: SandboxV4DepCycle[];
}

/** One agent's planned change set, for conflict detection. */
export interface SandboxV4ChangeSet {
  /** Agent id (must be unique per detection call). */
  agentId: string;
  /** Files the agent plans to edit (relative paths). */
  files: string[];
  /** Short description of the change (for the report). */
  description: string;
}

/** One detected conflict between two agents' change sets. */
export interface SandboxV4DepConflict {
  /** Kind of overlap. */
  kind: 'same-file' | 'overlapping-impact';
  /** First agent involved. */
  agentA: string;
  /** Second agent involved. */
  agentB: string;
  /** Files both agents touch directly (same-file) or the shared impact file. */
  files: string[];
  /** Human-readable explanation. */
  detail: string;
}

/** A topological execution plan: waves of files, safe to run in order. */
export interface SandboxV4ChangePlan {
  /** Waves: files in one wave have no dependency between each other. */
  waves: string[][];
  /** Files that could not be ordered (part of a cycle). */
  unordered: string[];
  /** Whether the underlying graph had cycles. */
  hasCycles: boolean;
}

/** Result of `recordUsage` on a budget meter. */
export interface SandboxV4BudgetRecordResult {
  /** Status after this recording. */
  status: SandboxV4BudgetStatus;
  /** True when this recording crossed into soft-blocked. */
  newlyBlocked: boolean;
  /** Dimensions that crossed a hard limit in this recording. */
  blockedDimensions: SandboxV4BudgetDimension[];
  /** Cost of this step in USD. */
  stepCostUsd: number;
  /** Full meter state after this recording. */
  state: SandboxV4BudgetState;
}

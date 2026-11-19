/**
 * Fleet v30 types (v1.44, Team T6) — fleet/UI v30.
 *
 * The v30 layer sits on top of fleet v28 (per-conversation sandbox
 * runtime) and fleet v29 (A2A peer registry, task board, allowlist)
 * and adds the four things the v1.44 survey asks for
 * (`docs/repo-survey-v144.md` §1 — OpenHands Agent Server
 * per-conversation isolation, ideas only, no copied code):
 *
 * 1. Per-conversation runtime isolation (`isolation.ts` + `drivers.ts`):
 *    one isolated runtime per conversation, with a driver kind
 *    (bwrap sandbox local-first, Docker when available, labelled
 *    local-process fallback with NO isolation), a per-conversation
 *    workspace root, a network mode, and cleanup when the
 *    conversation ends — the binding is destroyed, the scratch
 *    workspace is wiped, and the v28 runtime is stopped.
 * 2. A2A task board v2 (`boardV2.ts`): saved views, assignment /
 *    reassignment between peers, task dependencies, deadlines + SLA
 *    (overdue / escalation), retry policy with backoff, bulk
 *    operations, a per-task timeline, and kanban columns — built on
 *    the v29 board, which still owns the A2A state machine and the
 *    delegation gate.
 * 3. Peer groups + capability routing (`peerGroups.ts`): peers
 *    organised into groups, discovery probes, capability scoring
 *    for a task, load-balanced pick, and failover pick — built on
 *    the v29 registry, which still owns cards and verification.
 * 4. Allowlist admin v2 (`adminPolicy.ts`): admin roles, policy
 *    rules (time windows, runtime kinds, task types, cost caps),
 *    an approval workflow for out-of-scope work, and a single
 *    pre-flight permission check that runs before any execution:
 *    allowlist AND card AND policy AND runtime — fail-closed.
 *
 * Local-first, no cloud VM: every driver here runs on this host.
 * Nothing in this file calls the network, spawns a process, or
 * runs a model. Stores are in-memory and synchronous; the host
 * persists snapshots if it wants durability.
 */

import type { A2aTaskState } from '../a2a/types';
import type { FleetV29BoardTask } from '../fleetV29/types';

export const FLEET_V30_VERSION = 'v30';

/* ------------------------------------------------------------------ */
/* 1. Per-conversation runtime isolation                               */
/* ------------------------------------------------------------------ */

/** Isolation driver kind for one conversation runtime. */
export type FleetV30RuntimeDriverKind = 'bwrap' | 'docker' | 'local';

/** Network mode for an isolated conversation runtime. */
export type FleetV30NetworkMode = 'none' | 'loopback' | 'host';

/** Lifecycle status of one isolation binding. */
export type FleetV30BindingStatus = 'active' | 'suspended' | 'cleaned';

/** One conversation → isolated runtime binding. */
export interface FleetV30IsolationBinding {
  /** Conversation this binding isolates (unique). */
  conversationId: string;
  /** Bot/profile that owns the conversation. */
  profileId: string;
  /** Optional bot id (empty when the conversation has no bot). */
  botId: string;
  /** Driver that enforces the isolation. */
  driverKind: FleetV30RuntimeDriverKind;
  /** True when the driver actually isolates (false = local fallback, labelled). */
  isolated: boolean;
  /** v28 runtime id for this conversation (same as conversationId). */
  runtimeId: string;
  /** Workspace root: every file access must stay under it. */
  workspaceRoot: string;
  /** Network mode for the runtime. */
  networkMode: FleetV30NetworkMode;
  /** Binding status. */
  status: FleetV30BindingStatus;
  /** When the binding was created (ms epoch). */
  createdAtMs: number;
  /** Last activity (message / tool call / probe), ms epoch. */
  lastActivityMs: number;
  /** When the binding was cleaned up (null = not cleaned). */
  cleanedAtMs: number | null;
  /** Why the binding was cleaned (null = not cleaned). */
  cleanupReason: string | null;
  /** Scratch paths wiped at cleanup (empty until cleaned). */
  wipedPaths: string[];
  /** Whether the driver was verified available at bind time. */
  driverVerified: boolean;
}

/** One isolation audit event (ids + states only, never prompt text). */
export interface FleetV30IsolationEvent {
  /** Monotonic sequence (1-based). */
  seq: number;
  /** When the event happened (ISO). */
  at: string;
  /** Event kind. */
  kind:
    | 'binding-created'
    | 'binding-suspended'
    | 'binding-resumed'
    | 'binding-cleaned'
    | 'binding-orphaned'
    | 'driver-unavailable'
    | 'cleanup-failed';
  /** Conversation the event concerns. */
  conversationId: string;
  /** Owning profile. */
  profileId: string;
  /** Human-readable detail (ids + states only). */
  detail: string;
}

/** Default network mode for a new binding. */
export const FLEET_V30_DEFAULT_NETWORK_MODE: FleetV30NetworkMode = 'loopback';

/** Driver preference order when the caller does not pick one. */
export const FLEET_V30_DRIVER_PREFERENCE: readonly FleetV30RuntimeDriverKind[] = [
  'bwrap',
  'docker',
  'local',
];

/** Scratch subdirectories created under a conversation workspace. */
export const FLEET_V30_SCRATCH_DIRS: readonly string[] = ['scratch', 'tmp', 'downloads'];

/* ------------------------------------------------------------------ */
/* 2. A2A task board v2                                                */
/* ------------------------------------------------------------------ */

/** Priority of a board v2 task. */
export type FleetV30TaskPriority = 'low' | 'normal' | 'high' | 'urgent';

/** SLA state of a board v2 task (derived from its deadline). */
export type FleetV30SlaState = 'on-track' | 'at-risk' | 'overdue' | 'no-deadline';

/** One timeline event on a board v2 task. */
export interface FleetV30TaskTimelineEvent {
  /** When the event happened (ISO). */
  at: string;
  /** Event kind. */
  kind:
    | 'created'
    | 'assigned'
    | 'reassigned'
    | 'state-changed'
    | 'progress'
    | 'input-required'
    | 'input-provided'
    | 'retry'
    | 'deadline-set'
    | 'deadline-missed'
    | 'escalated'
    | 'cancelled'
    | 'completed'
    | 'failed';
  /** Who/what caused it (peer id, admin id, or 'system'). */
  actor: string;
  /** Short human-readable note. */
  note: string;
}

/** v30 metadata attached to one v29 board task. */
export interface FleetV30TaskMeta {
  /** Board task id (same as the v29 A2A task id). */
  taskId: string;
  /** Priority. */
  priority: FleetV30TaskPriority;
  /** Deadline (ISO, null = none). */
  dueAt: string | null;
  /** SLA budget in minutes from creation (null = no SLA). */
  slaMinutes: number | null;
  /** Task ids this task is blocked by (must complete first). */
  blockedBy: string[];
  /** Task ids blocked by this task (derived, kept in sync). */
  blocks: string[];
  /** How many times this task has been retried. */
  retryCount: number;
  /** Max retries after a failure (>= 0). */
  maxRetries: number;
  /** Backoff between retries, ms. */
  retryBackoffMs: number;
  /** Peer ids this task has been assigned to, in order. */
  assignmentHistory: string[];
  /** Timeline of v30 events for this task. */
  timeline: FleetV30TaskTimelineEvent[];
  /** True when the task was escalated for missing its SLA. */
  escalated: boolean;
  /** Escalation reason (null = not escalated). */
  escalationReason: string | null;
}

/** One saved board view (a named filter preset). */
export interface FleetV30BoardView {
  /** Stable view id (e.g. `view-urgent`). */
  viewId: string;
  /** Human name shown in the UI. */
  name: string;
  /** Who created the view. */
  createdBy: string;
  /** When the view was created (ISO). */
  createdAt: string;
  /** Peer filter (null = all peers). */
  peerId: string | null;
  /** A2A state filter (null = all states). */
  state: A2aTaskState | null;
  /** Priority filter (null = all priorities). */
  priority: FleetV30TaskPriority | null;
  /** Free-text query (null = none). */
  query: string | null;
  /** Only tasks that are active (non-terminal). */
  activeOnly: boolean;
  /** Only tasks past their deadline. */
  overdueOnly: boolean;
  /** Only tasks assigned to a group (null = any group). */
  groupId: string | null;
}

/** One kanban column (a named bucket of A2A states). */
export interface FleetV30KanbanColumn {
  /** Column id. */
  columnId: string;
  /** Human title. */
  title: string;
  /** A2A states shown in this column. */
  states: A2aTaskState[];
}

/** Default kanban columns for board v2. */
export const FLEET_V30_DEFAULT_KANBAN: readonly FleetV30KanbanColumn[] = [
  { columnId: 'queued', title: 'Queued', states: ['submitted', 'rejected'] },
  { columnId: 'working', title: 'Working', states: ['working', 'input-required', 'auth-required'] },
  { columnId: 'done', title: 'Done', states: ['completed', 'failed', 'cancelled'] },
];

/** A v29 board task joined with its v30 metadata. */
export interface FleetV30BoardTaskView {
  /** The underlying v29 board task. */
  boardTask: FleetV29BoardTask;
  /** v30 metadata (created lazily on first access). */
  meta: FleetV30TaskMeta;
  /** Derived SLA state at read time. */
  slaState: FleetV30SlaState;
  /** True when another task blocks this one (not all blockers completed). */
  blocked: boolean;
}

/** Result of a bulk board operation. */
export interface FleetV30BulkResult {
  /** Task ids the operation applied to. */
  applied: string[];
  /** Tasks the operation refused, with reasons. */
  refused: Array<{ taskId: string; reasons: string[] }>;
}

/* ------------------------------------------------------------------ */
/* 3. Peer groups + capability routing                                 */
/* ------------------------------------------------------------------ */

/** One peer group (a named set of peers, e.g. a team or a region). */
export interface FleetV30PeerGroup {
  /** Stable group id (e.g. `group-coding`). */
  groupId: string;
  /** Human name. */
  name: string;
  /** Optional description. */
  description: string;
  /** Peer ids in the group (sorted, unique). */
  peerIds: string[];
  /** Who created the group. */
  createdBy: string;
  /** When the group was created (ISO). */
  createdAt: string;
  /** Default max concurrent tasks per peer in this group (null = peer scope). */
  defaultMaxConcurrent: number | null;
}

/** One discovery probe result for a peer endpoint. */
export interface FleetV30DiscoveryProbe {
  /** Peer id probed. */
  peerId: string;
  /** Endpoint probed (URL). */
  endpoint: string;
  /** True when the endpoint answered. */
  reachable: boolean;
  /** Round-trip latency, ms (null when unreachable). */
  latencyMs: number | null;
  /** When the probe ran (ISO). */
  at: string;
  /** Probe failure reason (null when reachable). */
  error: string | null;
}

/** Capability score breakdown for one peer against one task. */
export interface FleetV30CapabilityScore {
  /** Peer scored. */
  peerId: string;
  /** Total score 0–100 (higher = better fit). */
  score: number;
  /** 0–40: how many required skills the peer's card advertises. */
  skillScore: number;
  /** 0–25: health (score from the v29 health rollup). */
  healthScore: number;
  /** 0–20: free capacity (concurrency headroom). */
  capacityScore: number;
  /** 0–15: latency (p50 vs the task's latency budget). */
  latencyScore: number;
  /** Reasons the score was lowered (empty = perfect fit). */
  reasons: string[];
}

/** What a task needs from a peer (for capability matching). */
export interface FleetV30TaskRequirement {
  /** Skill ids the task needs (empty = any skill). */
  requiredSkills: string[];
  /** Latency budget, p50 ms (null = no budget). */
  latencyBudgetMs: number | null;
  /** Whether streaming is required. */
  streamingRequired: boolean;
  /** Group the peer must belong to (null = any group). */
  groupId: string | null;
  /** Peer ids to exclude (e.g. the peer that just failed). */
  excludePeerIds: string[];
}

/* ------------------------------------------------------------------ */
/* 4. Allowlist admin v2                                               */
/* ------------------------------------------------------------------ */

/** Admin role (least privilege: viewer < operator < admin). */
export type FleetV30AdminRole = 'viewer' | 'operator' | 'admin';

/** One admin (a local user id with a role). */
export interface FleetV30Admin {
  /** Local user id. */
  userId: string;
  /** Role. */
  role: FleetV30AdminRole;
  /** Who granted the role. */
  grantedBy: string;
  /** When the role was granted (ISO). */
  grantedAt: string;
}

/** Task types a policy rule governs (open vocabulary, validated). */
export type FleetV30TaskType =
  | 'code'
  | 'research'
  | 'write'
  | 'data'
  | 'automation'
  | 'sensitive'
  | 'other';

/** Well-known task types (for validation + the UI picker). */
export const FLEET_V30_TASK_TYPES: readonly FleetV30TaskType[] = [
  'code',
  'research',
  'write',
  'data',
  'automation',
  'sensitive',
  'other',
];

/** A time window (local hour range + days of week, 0 = Sunday). */
export interface FleetV30TimeWindow {
  /** Start hour, 0–23. */
  startHour: number;
  /** End hour, 0–23 (end > start; no overnight windows). */
  endHour: number;
  /** Days of week the window applies to (0–6). */
  days: number[];
}

/** One admin policy rule. */
export interface FleetV30PolicyRule {
  /** Stable rule id. */
  ruleId: string;
  /** Human name. */
  name: string;
  /** Task types the rule applies to (empty = all types). */
  taskTypes: FleetV30TaskType[];
  /** Runtime driver kinds the rule allows (empty = all kinds). */
  runtimeKinds: FleetV30RuntimeDriverKind[];
  /** Peer ids the rule applies to (empty = all peers). */
  peerIds: string[];
  /** Time window the rule applies in (null = always). */
  timeWindow: FleetV30TimeWindow | null;
  /** Max cost USD per task under this rule (null = no cap). */
  maxCostUsdPerTask: number | null;
  /** Max concurrent tasks under this rule (null = no cap). */
  maxConcurrentTasks: number | null;
  /** Task types that need an approved approval request first. */
  requiresApprovalFor: FleetV30TaskType[];
  /** Whether the rule is active (inactive rules are ignored). */
  enabled: boolean;
  /** Who created the rule. */
  createdBy: string;
  /** When the rule was created (ISO). */
  createdAt: string;
}

/** Status of an approval request. */
export type FleetV30ApprovalStatus = 'pending' | 'approved' | 'denied' | 'expired';

/** One approval request (out-of-scope work needs an admin to approve). */
export interface FleetV30ApprovalRequest {
  /** Stable request id. */
  requestId: string;
  /** Peer the work would run on. */
  peerId: string;
  /** Task type requested. */
  taskType: FleetV30TaskType;
  /** Short description of the work. */
  summary: string;
  /** Who requested it. */
  requestedBy: string;
  /** When it was requested (ISO). */
  requestedAt: string;
  /** Expiry (ISO, null = never expires). */
  expiresAt: string | null;
  /** Status. */
  status: FleetV30ApprovalStatus;
  /** Who decided (null = undecided). */
  decidedBy: string | null;
  /** When it was decided (ISO, null = undecided). */
  decidedAt: string | null;
  /** Decision reason (null = none). */
  decisionReason: string | null;
}

/** One check inside a pre-flight decision. */
export interface FleetV30PreflightCheck {
  /** Check name. */
  name: string;
  /** True when the check passed. */
  passed: boolean;
  /** Human-readable detail. */
  detail: string;
}

/** Result of the pre-flight permission check (runs before execution). */
export interface FleetV30PreflightDecision {
  /** True only when EVERY check passed. */
  allowed: boolean;
  /** Every check that ran (in order). */
  checks: FleetV30PreflightCheck[];
  /** Blocking reasons (empty when allowed). */
  reasons: string[];
  /** Approval request id when an approval would unblock this (null = none). */
  approvalRequired: string | null;
}

/** One admin audit event (ids + states only). */
export interface FleetV30AdminEvent {
  /** Monotonic sequence (1-based). */
  seq: number;
  /** When the event happened (ISO). */
  at: string;
  /** Event kind. */
  kind:
    | 'admin-granted'
    | 'admin-revoked'
    | 'rule-created'
    | 'rule-updated'
    | 'rule-deleted'
    | 'approval-requested'
    | 'approval-approved'
    | 'approval-denied'
    | 'approval-expired'
    | 'preflight-denied';
  /** Actor (user id). */
  actor: string;
  /** Peer the event concerns (null = fleet-wide). */
  peerId: string | null;
  /** Human-readable detail (ids + states only). */
  detail: string;
}

/** Default retry policy for board v2 tasks. */
export const FLEET_V30_DEFAULT_MAX_RETRIES = 2;
export const FLEET_V30_DEFAULT_RETRY_BACKOFF_MS = 5000;

/** Max saved views / groups / rules (keeps the stores bounded). */
export const FLEET_V30_MAX_VIEWS = 50;
export const FLEET_V30_MAX_GROUPS = 100;
export const FLEET_V30_MAX_RULES = 100;
export const FLEET_V30_MAX_APPROVALS = 500;
export const FLEET_V30_MAX_TIMELINE_EVENTS = 200;

/**
 * Fleet v29 — A2A task board types (v1.42, Team T6).
 *
 * Fleet/UI v29 is the coordination layer on top of the A2A wire
 * protocol (survey `docs/repo-survey-v142.md` §1 — A2A v1.0.0 /
 * v1.0.1, ideas only, no copied code): it does NOT re-implement the
 * A2A client/server (that is Team T1's A2A v11 work this wave, in
 * `packages/core/src/a2a/*`). It owns the fleet-side view of that
 * protocol: which peers may be delegated to, which tasks are in
 * flight, how healthy each peer is, and an audit trail of every
 * delegation.
 *
 * Security model (Palo Alto Unit 42, 31/10/2025 — a malicious agent
 * reached over an A2A session can inject multi-turn instructions,
 * leak system prompt / tools / history, and trigger unauthorised
 * purchases): every rule here is fail-closed.
 *   - A peer is usable only when it is BOTH on the allowlist AND
 *     its Agent Card verifies (see `cardVerify.ts`).
 *   - A task is never delegated to a peer that fails either check,
 *     even if the caller already holds the peer id.
 *   - Sensitive actions (purchase, payment, secret access, file
 *     write outside the sandbox, external send) need an explicit
 *     user confirmation (`sensitiveConfirm.ts`) — a peer can request
 *     one, never grant one to itself.
 *   - The audit log never carries prompt text, tool arguments, or
 *     secret values — only ids, states, and hashes.
 *
 * All stores are in-memory and synchronous; the host persists
 * snapshots if it wants durability. Nothing here calls the network
 * or runs a model.
 */

import type { A2aAgentCard, A2aTask, A2aTaskState } from '../a2a/types';

/** A2A protocol versions fleet v29 negotiates (1.0.0 / 1.0.1). */
export const FLEET_V29_A2A_VERSIONS: readonly string[] = ['1.0', '1.0.1'];
export const FLEET_V29_A2A_VERSION = '1.0.1';
export const FLEET_V29_VERSION = 'v29';

/** Card verification outcome for one peer (fleet-side summary). */
export type FleetV29CardStatus =
  | 'verified' // card valid + signature verifies + version negotiable
  | 'unsigned' // card valid but no signature (usable only if policy allows)
  | 'invalid' // card fails validation (bad fields / bad signature / expired)
  | 'unverified' // never checked, or check failed to run
  | 'stale'; // verified before, but the card changed since (key/url changed)

/** How a peer was verified (for the UI + audit). */
export type FleetV29VerifyMethod = 'signature' | 'unsigned-allowed' | 'none';

/** One A2A peer known to the fleet. */
export interface FleetV29Peer {
  /** Stable peer id (fleet-assigned, e.g. `peer-<slug>`). */
  peerId: string;
  /** Agent Card as last seen (a copy; the registry owns it). */
  card: A2aAgentCard;
  /** SHA-256 hex (or `unsigned:<sha>` fallback) of the canonical card. */
  cardFingerprint: string;
  /** Verification outcome of the last check. */
  cardStatus: FleetV29CardStatus;
  /** How the last check verified the card. */
  verifyMethod: FleetV29VerifyMethod;
  /** Human-readable reasons for the last check (empty when verified). */
  verifyProblems: string[];
  /** ISO-8601 of the last verification check. */
  verifiedAt: string | null;
  /** ISO-8601 the peer was first registered. */
  registeredAt: string;
  /** ISO-8601 the peer was last seen healthy (probe / task success). */
  lastSeenAt: string | null;
  /** Tenant that owns this peer registration (multi-tenancy, A2A 1.0). */
  tenantId?: string;
  /** Free-form tags (e.g. `coding`, `research`) for board filtering. */
  tags: string[];
  /** Whether the peer is currently reachable (last probe). */
  reachable: boolean;
  /** Consecutive failed probes (health scoring input). */
  consecutiveFailures: number;
}

/** A peer's allowed scope once it passes allowlist + card checks. */
export interface FleetV29PeerScope {
  /** Skill ids from the peer's card this peer may be asked for. Empty = all card skills. */
  allowedSkills: string[];
  /** A2A operations the peer may be asked to perform. */
  allowedOperations: FleetV29Operation[];
  /** Max USD cost for one delegated task (null = no per-task cap). */
  maxCostUsdPerTask: number | null;
  /** Max concurrent tasks for this peer. */
  maxConcurrentTasks: number;
  /** Sensitive actions the peer may request (each still needs user confirmation). */
  sensitiveActionsAllowed: FleetV29SensitiveAction[];
}

/** A2A operations (v1.0) the board can ask a peer to perform. */
export type FleetV29Operation =
  | 'SendMessage'
  | 'SendStreamingMessage'
  | 'GetTask'
  | 'ListTasks'
  | 'CancelTask'
  | 'SubscribeToTask'
  | 'GetExtendedAgentCard';

/** All A2A v1.0 operations (for allowlist scope pickers). */
export const FLEET_V29_OPERATIONS: readonly FleetV29Operation[] = [
  'SendMessage',
  'SendStreamingMessage',
  'GetTask',
  'ListTasks',
  'CancelTask',
  'SubscribeToTask',
  'GetExtendedAgentCard',
];

/** Sensitive action kinds — always need user confirmation. */
export type FleetV29SensitiveAction =
  | 'purchase'
  | 'payment'
  | 'secret-access'
  | 'file-write-outside-sandbox'
  | 'external-send'
  | 'account-change';

/** All sensitive action kinds. */
export const FLEET_V29_SENSITIVE_ACTIONS: readonly FleetV29SensitiveAction[] = [
  'purchase',
  'payment',
  'secret-access',
  'file-write-outside-sandbox',
  'external-send',
  'account-change',
];

/** One allowlist entry: a peer id + its scope + who approved it. */
export interface FleetV29AllowlistEntry {
  peerId: string;
  scope: FleetV29PeerScope;
  /** Who added the peer (user id / `local-user`). */
  addedBy: string;
  /** ISO-8601 the entry was added. */
  addedAt: string;
  /** ISO-8601 the entry expires (null = no expiry). */
  expiresAt: string | null;
  /** Why the peer was allowed (shown in the admin panel). */
  reason: string;
  /** True when the entry is paused (peer kept, but not usable). */
  suspended: boolean;
}

/** A board task: one A2A task plus fleet-side coordination metadata. */
export interface FleetV29BoardTask {
  /** The A2A task itself (id, contextId, status, artifacts, history). */
  task: A2aTask;
  /** Peer the task was delegated to. */
  peerId: string;
  /** Who delegated (local bot/profile id). */
  delegatedBy: string;
  /** Short human label for the board (never prompt text). */
  title: string;
  /** ISO-8601 the delegation was created. */
  createdAt: string;
  /** ISO-8601 the task last changed state. */
  updatedAt: string;
  /** Streaming progress 0..1 (null when the peer reports no progress). */
  progress: number | null;
  /** Latest streaming partial text (truncated, max 500 chars — never prompt text). */
  partialText: string;
  /** Number of streaming progress events received. */
  progressEvents: number;
  /** USD cost accrued for this task (from peer latency/cost accounting). */
  costUsd: number;
  /** Latency of the last peer round-trip in ms (null = not measured). */
  lastLatencyMs: number | null;
  /** Whether the task needed user input (`input-required` seen). */
  awaitingInput: boolean;
  /** Question the peer asked while `input-required` (shown to the user). */
  inputQuestion: string | null;
  /** Sensitive-action confirmation ids requested by this task. */
  confirmationIds: string[];
  /** True when the task was cancelled by the user (vs peer failure). */
  cancelledByUser: boolean;
  /** Cancellation reason (user text or peer reason). */
  cancelReason: string | null;
  /** Cursor for ListTasks pagination of this peer's tasks (opaque). */
  pageCursor: string | null;
}

/** Filter for listing board tasks. */
export interface FleetV29BoardFilter {
  peerId?: string;
  state?: A2aTaskState;
  /** Only tasks that are not in a terminal state. */
  activeOnly?: boolean;
  delegatedBy?: string;
  tenantId?: string;
  /** Free text matched against title / task id only (never prompt text). */
  query?: string;
}

/** One page of ListTasks results (A2A 1.0 cursor pagination). */
export interface FleetV29TaskPage {
  tasks: FleetV29BoardTask[];
  /** Opaque cursor for the next page (null = last page). */
  nextCursor: string | null;
  /** Total matching tasks (before pagination). */
  total: number;
}

/** One latency/cost sample for a peer round-trip. */
export interface FleetV29LatencySample {
  peerId: string;
  /** Round-trip latency in ms. */
  latencyMs: number;
  /** USD cost of the round-trip (0 when the peer reports none). */
  costUsd: number;
  /** True when the round-trip failed (timeout / error). */
  failed: boolean;
  /** ISO-8601 the sample was taken. */
  at: string;
  /** Task id the sample belongs to (when known). */
  taskId?: string;
}

/** Per-peer health rollup shown on the board. */
export interface FleetV29PeerHealth {
  peerId: string;
  /** 0..100 health score (100 = perfect). */
  score: number;
  /** 'healthy' | 'degraded' | 'down' | 'unknown'. */
  level: 'healthy' | 'degraded' | 'down' | 'unknown';
  /** Median latency over recent samples (null = no samples). */
  p50Ms: number | null;
  /** 95th percentile latency (null = no samples). */
  p95Ms: number | null;
  /** Error rate over recent samples, 0..1. */
  errorRate: number;
  /** Total USD cost over the sampled window. */
  totalCostUsd: number;
  /** Tasks currently in flight for this peer. */
  activeTasks: number;
  /** Tasks completed for this peer (all time, in this store). */
  completedTasks: number;
  /** Tasks failed for this peer (all time, in this store). */
  failedTasks: number;
  /** ISO-8601 of the last sample. */
  lastSampleAt: string | null;
}

/** Fleet-wide health rollup for the dashboard. */
export interface FleetV29HealthSummary {
  peersTotal: number;
  peersHealthy: number;
  peersDegraded: number;
  peersDown: number;
  peersUnknown: number;
  tasksActive: number;
  tasksCompleted: number;
  tasksFailed: number;
  tasksCancelled: number;
  tasksAwaitingInput: number;
  totalCostUsd: number;
  /** Median latency across all peers with samples (null = none). */
  medianLatencyMs: number | null;
  /** Pending sensitive confirmations awaiting the user. */
  pendingConfirmations: number;
  /** Allowlisted peers whose card is not currently verified. */
  allowlistedUnverified: number;
}

/** One audit entry — append-only, never carries prompt/secret data. */
export type FleetV29AuditKind =
  | 'delegation-created'
  | 'delegation-state-changed'
  | 'delegation-cancelled'
  | 'delegation-completed'
  | 'delegation-failed'
  | 'peer-registered'
  | 'peer-removed'
  | 'peer-card-verified'
  | 'peer-card-rejected'
  | 'allowlist-added'
  | 'allowlist-removed'
  | 'allowlist-suspended'
  | 'allowlist-resumed'
  | 'allowlist-expired'
  | 'sensitive-requested'
  | 'sensitive-approved'
  | 'sensitive-denied'
  | 'sensitive-expired'
  | 'task-input-provided'
  | 'task-stream-progress';

/** Audit entry kinds that are delegation lifecycle events. */
export const FLEET_V29_DELEGATION_AUDIT_KINDS: readonly FleetV29AuditKind[] = [
  'delegation-created',
  'delegation-state-changed',
  'delegation-cancelled',
  'delegation-completed',
  'delegation-failed',
];

export interface FleetV29AuditEntry {
  /** Monotonic sequence number (1-based, never reused). */
  seq: number;
  /** Short hash chain: hash of (prevHash + this entry's public fields). */
  hash: string;
  /** Hash of the previous entry ('' for the first). */
  prevHash: string;
  kind: FleetV29AuditKind;
  /** ISO-8601 the event happened. */
  at: string;
  /** Actor: user id, peer id, or `system`. */
  actor: string;
  /** Peer involved (when any). */
  peerId?: string;
  /** Task involved (when any). */
  taskId?: string;
  /** Short, safe detail (ids + states only — never prompt/secret text). */
  detail: string;
  /** Extra structured fields (ids, states, amounts — never secrets). */
  meta?: Record<string, string | number | boolean>;
}

/** A sensitive-action confirmation request. */
export type FleetV29ConfirmationStatus = 'pending' | 'approved' | 'denied' | 'expired';

export interface FleetV29Confirmation {
  id: string;
  peerId: string;
  taskId: string;
  action: FleetV29SensitiveAction;
  /** What the peer wants to do, in the user's words (no secret values). */
  summary: string;
  /** USD amount involved (purchases/payments only, null otherwise). */
  amountUsd: number | null;
  status: FleetV29ConfirmationStatus;
  requestedAt: string;
  /** ISO-8601 the request expires (unanswered past this = expired). */
  expiresAt: string;
  decidedAt: string | null;
  decidedBy: string | null;
}

/** Delegation request the board validates before sending to a peer. */
export interface FleetV29DelegateRequest {
  peerId: string;
  delegatedBy: string;
  title: string;
  /** The message text to send (kept out of the audit log). */
  messageText: string;
  contextId?: string;
  tenantId?: string;
  /** Skill the task needs (must be in the peer's allowlist scope). */
  skillId?: string;
  /** Operation to use (default `SendStreamingMessage` when the peer supports it). */
  operation?: FleetV29Operation;
}

/** Result of a delegation attempt (fail-closed: reasons, never a partial send). */
export type FleetV29DelegateResult =
  | { ok: true; boardTask: FleetV29BoardTask }
  | { ok: false; reasons: string[] };

/** Point where fleet v29 hands off to Team T1's A2A v11 transport. */
export interface FleetV29TransportPort {
  /**
   * Send one message to a peer and return the created A2A task.
   * Implemented by T1's A2A v11 client (`packages/core/src/a2a/*`
   * v11 additions) once it lands; until then the board runs in
   * local-simulation mode (see `taskBoard.ts` — the board never
   * pretends a simulated task reached a real peer).
   */
  sendMessage?: (input: {
    peerId: string;
    peerUrl: string;
    messageText: string;
    contextId: string;
    streaming: boolean;
  }) => Promise<A2aTask>;
  /** Cancel a task on a peer. */
  cancelTask?: (input: { peerId: string; peerUrl: string; taskId: string }) => Promise<void>;
  /** List a peer's tasks with cursor pagination (A2A 1.0 ListTasks). */
  listTasks?: (input: {
    peerId: string;
    peerUrl: string;
    cursor?: string | null;
    pageSize?: number;
  }) => Promise<{ tasks: A2aTask[]; nextCursor: string | null }>;
}

/** Default per-peer scope for a newly allowlisted peer (least privilege). */
export const FLEET_V29_DEFAULT_SCOPE: FleetV29PeerScope = {
  allowedSkills: [],
  allowedOperations: ['SendMessage', 'SendStreamingMessage', 'GetTask', 'ListTasks', 'CancelTask'],
  maxCostUsdPerTask: 5,
  maxConcurrentTasks: 3,
  sensitiveActionsAllowed: [],
};

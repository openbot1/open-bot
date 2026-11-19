/**
 * Tools v29 — pure definitions for fleet v29 (v1.42, Team T6).
 *
 * Follows the `fleetV28/toolsV28.ts` pattern: a separate pure
 * registry (this file) that defines each tool (name, description,
 * params, whether it writes) — this module does NOT run tools and
 * does NOT register into the central registry. The runnable tools
 * live in `packages/tools/src/fleetV29Tools.ts`.
 *
 * Naming (snake_case, NO dots — v21/v22 broke `defaultToolFactory`
 * with dotted names, never again). Groups (37 tools):
 * - `fleet_v29_peer_*` — peer registry (register/list/get/remove/
 *   verify/health/samples/record-sample).
 * - `fleet_v29_board_*` — A2A task board (submit/list/get/start/
 *   progress/complete/fail/cancel/cancel-all/input/cost).
 * - `fleet_v29_allowlist_*` — allowlist admin (add/list/get/remove/
 *   suspend/resume/scope).
 * - `fleet_v29_audit_*` — audit log (list/query/verify/export).
 * - `fleet_v29_confirm_*` — sensitive confirmations (request/list/
 *   approve/deny/pending).
 * - `fleet_v29_snapshot_*` — host persistence (save/load).
 * - `fleet_v29_health` + `fleet_v29_dashboard` — rollups.
 *
 * Write tools need approval (`write: true`). They never run a
 * model, never spawn a process, and never touch the network. The
 * board in simulation mode never claims a task reached a real peer.
 */

/** Definition of one v29 tool (pure, JSON-able). */
export interface FleetV29ToolDef {
  /** Tool name, e.g. `fleet_v29_peer_register`. */
  name: string;
  description: string;
  /** true = a write action (needs approval). */
  write: boolean;
  /** Parameter names (for the UI form; no type validation here). */
  params: string[];
}

/** All v29 tools (pure definitions). */
export const FLEET_V29_TOOLS: readonly FleetV29ToolDef[] = [
  // Peer registry.
  { name: 'fleet_v29_peer_register', description: 'Register an A2A peer from its Agent Card (unverified until the card check passes).', write: true, params: ['peerId', 'name', 'description', 'url', 'version', 'protocolVersion', 'tags', 'tenantId'] },
  { name: 'fleet_v29_peer_list', description: 'List registered A2A peers, optionally filtered by tenant, tag, card status, or reachability.', write: false, params: ['tenantId', 'tag', 'cardStatus', 'reachableOnly'] },
  { name: 'fleet_v29_peer_get', description: 'Show one registered A2A peer (card, verification status, reachability).', write: false, params: ['peerId'] },
  { name: 'fleet_v29_peer_remove', description: 'Remove a registered A2A peer (does not remove its allowlist entry — remove that separately).', write: true, params: ['peerId'] },
  { name: 'fleet_v29_peer_verify', description: 'Verify a peer Agent Card (shape + version negotiation + signature) and record the outcome.', write: true, params: ['peerId', 'requireSigned'] },
  { name: 'fleet_v29_peer_health', description: 'Show per-peer health (score, p50/p95 latency, error rate, cost, task counts).', write: false, params: ['peerId'] },
  { name: 'fleet_v29_peer_samples', description: 'List recent latency/cost samples for a peer.', write: false, params: ['peerId', 'limit'] },
  { name: 'fleet_v29_peer_record_sample', description: 'Record one latency/cost sample for a peer (feeds health scoring).', write: true, params: ['peerId', 'latencyMs', 'costUsd', 'failed', 'taskId'] },
  // A2A task board.
  { name: 'fleet_v29_board_submit', description: 'Delegate a task to an allowlisted, card-verified peer (gate fails closed; simulation mode when no A2A transport is wired).', write: true, params: ['peerId', 'delegatedBy', 'title', 'messageText', 'contextId', 'tenantId', 'skillId', 'operation'] },
  { name: 'fleet_v29_board_list', description: 'List board tasks with cursor pagination, optionally filtered by peer, state, or query.', write: false, params: ['peerId', 'state', 'activeOnly', 'query', 'cursor', 'pageSize'] },
  { name: 'fleet_v29_board_get', description: 'Show one board task (A2A state, streaming progress, cost, latency).', write: false, params: ['taskId'] },
  { name: 'fleet_v29_board_start', description: 'Start a submitted board task (submitted → working).', write: true, params: ['taskId'] },
  { name: 'fleet_v29_board_progress', description: 'Record streaming progress for a working board task.', write: true, params: ['taskId', 'partialText', 'progress'] },
  { name: 'fleet_v29_board_complete', description: 'Complete a board task with an optional result text.', write: true, params: ['taskId', 'resultText'] },
  { name: 'fleet_v29_board_fail', description: 'Fail a board task with a reason.', write: true, params: ['taskId', 'reason'] },
  { name: 'fleet_v29_board_cancel', description: 'Cancel a board task (user-initiated by default).', write: true, params: ['taskId', 'byUser', 'reason'] },
  { name: 'fleet_v29_board_input', description: 'Answer a board task waiting for input (input-required → working).', write: true, params: ['taskId', 'answer'] },
  { name: 'fleet_v29_board_cost', description: 'Record cost/latency for a board task and check its per-task cost cap.', write: true, params: ['taskId', 'costUsd', 'latencyMs'] },
  { name: 'fleet_v29_board_cancel_all', description: 'Cancel every active board task for one peer (e.g. the peer is going down).', write: true, params: ['peerId', 'byUser', 'reason'] },
  // Allowlist admin.
  { name: 'fleet_v29_allowlist_add', description: 'Add a peer to the allowlist with a least-privilege scope.', write: true, params: ['peerId', 'addedBy', 'reason', 'expiresAt', 'allowedSkills', 'allowedOperations', 'maxCostUsdPerTask', 'maxConcurrentTasks', 'sensitiveActionsAllowed'] },
  { name: 'fleet_v29_allowlist_list', description: 'List allowlist entries with their scopes and expiry.', write: false, params: [] },
  { name: 'fleet_v29_allowlist_get', description: 'Show one allowlist entry (scope, added by, expiry, suspended).', write: false, params: ['peerId'] },
  { name: 'fleet_v29_allowlist_remove', description: 'Remove a peer from the allowlist (delegation to it stops immediately).', write: true, params: ['peerId'] },
  { name: 'fleet_v29_allowlist_suspend', description: 'Suspend an allowlist entry (peer kept, but not usable).', write: true, params: ['peerId'] },
  { name: 'fleet_v29_allowlist_resume', description: 'Resume a suspended allowlist entry.', write: true, params: ['peerId'] },
  { name: 'fleet_v29_allowlist_scope', description: 'Update a peer allowlist scope (skills, operations, caps, sensitive actions).', write: true, params: ['peerId', 'allowedSkills', 'allowedOperations', 'maxCostUsdPerTask', 'maxConcurrentTasks', 'sensitiveActionsAllowed'] },
  // Audit log.
  { name: 'fleet_v29_audit_list', description: 'List audit entries (delegation, allowlist, card, sensitive decisions), newest last.', write: false, params: ['kind', 'peerId', 'taskId', 'limit'] },
  { name: 'fleet_v29_audit_verify', description: 'Verify the audit log hash chain (detects edits, deletions, reordering).', write: false, params: [] },
  { name: 'fleet_v29_audit_export', description: 'Export the audit log as newline-delimited JSON.', write: false, params: [] },
  // Sensitive confirmations.
  { name: 'fleet_v29_confirm_request', description: 'Request user confirmation for a sensitive action on a task (peer requests, never approves).', write: true, params: ['peerId', 'taskId', 'action', 'summary', 'amountUsd'] },
  { name: 'fleet_v29_confirm_list', description: 'List sensitive confirmation requests, optionally filtered by status, peer, or task.', write: false, params: ['status', 'peerId', 'taskId'] },
  { name: 'fleet_v29_confirm_approve', description: 'Approve a pending sensitive-action request (user only).', write: true, params: ['id', 'decidedBy'] },
  { name: 'fleet_v29_confirm_deny', description: 'Deny a pending sensitive-action request (user only).', write: true, params: ['id', 'decidedBy'] },
  // Snapshot (host persistence).
  { name: 'fleet_v29_snapshot_save', description: 'Save the fleet v29 snapshot (peer registry + allowlist + samples) as JSON.', write: false, params: [] },
  { name: 'fleet_v29_snapshot_load', description: 'Load a fleet v29 snapshot JSON (peers restore as unverified — trust is re-earned).', write: true, params: ['snapshotJson'] },
  // Rollups.
  { name: 'fleet_v29_health', description: 'Fleet health summary (peers by level, task counts, cost, pending confirmations, alerts).', write: false, params: [] },
  { name: 'fleet_v29_dashboard', description: 'Combined fleet v29 dashboard (health + board summary + allowlist + audit counts).', write: false, params: [] },
];

/** Names of all v29 tools. */
export const FLEET_V29_TOOL_NAMES: readonly string[] = FLEET_V29_TOOLS.map((t) => t.name);

/** Find one v29 tool definition by name. */
export function findFleetV29Tool(name: string): FleetV29ToolDef | null {
  return FLEET_V29_TOOLS.find((t) => t.name === name) ?? null;
}

/** true when every v29 tool name is unique. */
export function fleetV29ToolNamesUnique(): boolean {
  return new Set(FLEET_V29_TOOL_NAMES).size === FLEET_V29_TOOL_NAMES.length;
}

/** true when every v29 tool name is snake_case with no dots. */
export function fleetV29ToolNamesValid(): boolean {
  return FLEET_V29_TOOLS.every((t) => /^[a-z][a-z0-9_]*$/.test(t.name) && !t.name.includes('.'));
}

/** Read-only (no approval) v29 tools. */
export function fleetV29ReadTools(): FleetV29ToolDef[] {
  return FLEET_V29_TOOLS.filter((t) => !t.write);
}

/** Write (approval-needed) v29 tools. */
export function fleetV29WriteTools(): FleetV29ToolDef[] {
  return FLEET_V29_TOOLS.filter((t) => t.write);
}

/** v29 tools grouped by area (peer / board / allowlist / audit / confirm / health). */
export function fleetV29ToolsByGroup(): Record<string, FleetV29ToolDef[]> {
  const groups: Record<string, FleetV29ToolDef[]> = {
    peer: [],
    board: [],
    allowlist: [],
    audit: [],
    confirm: [],
    snapshot: [],
    health: [],
  };
  for (const tool of FLEET_V29_TOOLS) {
    if (tool.name.startsWith('fleet_v29_peer_')) groups['peer']?.push(tool);
    else if (tool.name.startsWith('fleet_v29_board_')) groups['board']?.push(tool);
    else if (tool.name.startsWith('fleet_v29_allowlist_')) groups['allowlist']?.push(tool);
    else if (tool.name.startsWith('fleet_v29_audit_')) groups['audit']?.push(tool);
    else if (tool.name.startsWith('fleet_v29_confirm_')) groups['confirm']?.push(tool);
    else if (tool.name.startsWith('fleet_v29_snapshot_')) groups['snapshot']?.push(tool);
    else groups['health']?.push(tool);
  }
  return groups;
}

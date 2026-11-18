/**
 * Tools v22 — định nghĩa tool riêng của fleet v22 (v1.35, Đội T6).
 *
 * Theo pattern tools v21 (`fleetV21/toolsV21.ts`): registry riêng của
 * đội T6 (không sửa registry trung tâm của các đội khác): mỗi tool là
 * một định nghĩa thuần (tên, mô tả, params, cần quyền gì, có ghi hay
 * không) để agent loop / UI gọi qua các hàm core ở `fleetV22/` —
 * module này KHÔNG tự đăng ký vào registry trung tâm, KHÔNG chạy tool.
 * Tool chạy thật nằm ở `packages/tools/src/fleetV22Tools.ts`.
 *
 * Quy ước tên (snake_case, theo validateToolDefinition — ten dotted
 * `fleetV22.createUser` cu bi ToolRegistry tu choi khi build factory,
 * xem v1.35):
 * - `fleet_v22_*` — user/quota/computer/probe/dashboard tổng hợp.
 * - `delegate_v22_*` — subagent delegation (giữ quyền kiểm soát).
 * - `handoff_v22_*` — handoff chuyển giao toàn bộ hội thoại.
 * - `orchestrate_v22_*` — router + escalation + audit.
 * Tool ghi (write: true) luôn cần duyệt trước khi chạy thật.
 */

/** Định nghĩa một tool v22 (thuần, JSON-able). */
export interface FleetV22ToolDef {
  /** Tên tool, vd `delegate_v22_create`. */
  name: string;
  description: string;
  /** true = hành động ghi (cần duyệt + ghi audit). */
  write: boolean;
  /** Quyền team cần có (xem `users.ts` FLEET_V22_ACTION_MIN_ROLE). */
  requiresAction: string;
  /** Tên param (để UI render form, không validate kiểu ở đây). */
  params: string[];
}

/** Toàn bộ tool v22 (định nghĩa thuần). */
export const FLEET_V22_TOOLS: readonly FleetV22ToolDef[] = [
  // Multi-user: user + quota.
  {
    name: 'fleet_v22_create_user',
    description: 'Create a fleet user (display name, email, role viewer/member/operator/admin) with the default quota for that role; admins only, email must be unique.',
    write: true,
    requiresAction: 'manage-users',
    params: ['id', 'displayName', 'email', 'role'],
  },
  {
    name: 'fleet_v22_list_users',
    description: 'List fleet users with role, active flag, team and quota usage fraction (who is near their limit).',
    write: false,
    requiresAction: 'manage-users',
    params: ['team', 'role'],
  },
  {
    name: 'fleet_v22_set_user_role',
    description: 'Change a user role (cannot demote the last admin); the new role changes the minimum permissions immediately.',
    write: true,
    requiresAction: 'manage-users',
    params: ['userId', 'role'],
  },
  {
    name: 'fleet_v22_set_user_active',
    description: 'Lock or unlock a fleet user (locked users cannot run anything until reactivated).',
    write: true,
    requiresAction: 'manage-users',
    params: ['userId', 'active'],
  },
  {
    name: 'fleet_v22_user_quota',
    description: 'Show one user quota usage (CPU/RAM/disk/bots/runs/computers reserved vs limit, fractions, near-limit flag) and what a new request would exceed.',
    write: false,
    requiresAction: 'view-own',
    params: ['userId', 'extraCpuCores', 'extraRamBytes', 'extraDiskBytes'],
  },
  // Per-bot computers.
  {
    name: 'fleet_v22_create_computer',
    description: 'Create a per-bot computer (cloud-linux-desktop, local-vm or own-computer) from a granted resource share; one active computer per bot.',
    write: true,
    requiresAction: 'manage-own-computers',
    params: ['id', 'botId', 'ownerId', 'kind', 'cpuCores', 'ramBytes', 'diskBytes'],
  },
  {
    name: 'fleet_v22_list_computers',
    description: 'List per-bot computers with kind, status, node, granted vs used CPU/RAM/disk and pressure flag.',
    write: false,
    requiresAction: 'view-own',
    params: ['ownerId', 'kind', 'status'],
  },
  {
    name: 'fleet_v22_computer_status',
    description: 'Move a bot computer through its lifecycle (provisioning/ready/running/paused/draining/stopped/failed); illegal transitions are rejected with the allowed list.',
    write: true,
    requiresAction: 'manage-own-computers',
    params: ['computerId', 'toStatus', 'reason'],
  },
  // Resource probe + partitioning.
  {
    name: 'fleet_v22_probe_host',
    description: 'Probe the host machine CPU/RAM/disk right now (real measurement via the OS module) and report how fresh the measurement is.',
    write: false,
    requiresAction: 'view-fleet',
    params: [],
  },
  {
    name: 'fleet_v22_allocatable',
    description: 'Show how much CPU/RAM/disk can be shared with bots after reserving headroom for the host (25% CPU, 2 GB RAM, 10% disk minimum 5 GB).',
    write: false,
    requiresAction: 'view-fleet',
    params: [],
  },
  {
    name: 'fleet_v22_partition',
    description: 'Partition the allocatable resources across many share requests (priority order, all-or-nothing per request) and report granted/denied with reasons.',
    write: false,
    requiresAction: 'view-fleet',
    params: ['requests'],
  },
  // Subagent delegation (parent-controlled).
  {
    name: 'delegate_v22_create',
    description: 'Delegate a task to a subagent: the subagent runs in its own context with only the given task, an allowlisted tool set and a budget (max tool calls, duration, depth, cost); the parent keeps control and can cancel.',
    write: true,
    requiresAction: 'run-bot',
    params: ['id', 'subagentId', 'subagentName', 'task', 'allowedTools', 'runId', 'ownerId'],
  },
  {
    name: 'delegate_v22_finish',
    description: 'Record a subagent finishing its work with a summary and artifacts; the delegation waits for parent verification before it counts as completed.',
    write: true,
    requiresAction: 'run-bot',
    params: ['delegationId', 'summary'],
  },
  {
    name: 'delegate_v22_verify',
    description: 'Parent verifies (or rejects) a finished subagent result with a note; verified becomes completed, rejected becomes failed.',
    write: true,
    requiresAction: 'run-bot',
    params: ['delegationId', 'verified', 'note'],
  },
  {
    name: 'delegate_v22_cancel',
    description: 'Cancel a pending or running delegation (the subagent stops; its partial work is kept for audit).',
    write: true,
    requiresAction: 'run-bot',
    params: ['delegationId'],
  },
  {
    name: 'delegate_v22_list',
    description: 'List delegations with status, budget used (tool calls, cost, elapsed time) and verification state; awaiting-verification first.',
    write: false,
    requiresAction: 'view-own',
    params: ['runId', 'ownerId'],
  },
  // Handoff (full conversation transfer).
  {
    name: 'handoff_v22_register_agent',
    description: 'Register an agent that can receive handoffs (id, specialty, instructions, allowed tools, whether approval is required); its transfer tool is transfer_to_<id>.',
    write: true,
    requiresAction: 'manage-users',
    params: ['id', 'name', 'description', 'instructions', 'specialty'],
  },
  {
    name: 'handoff_v22_transfer',
    description: 'Hand the whole conversation over to a registered specialist agent (full history moves with it); loop guards reject ping-pong and over-limit chains, approval-gated agents wait for approval.',
    write: true,
    requiresAction: 'run-bot',
    params: ['conversationId', 'fromAgentId', 'toAgentId', 'reason'],
  },
  {
    name: 'handoff_v22_approve',
    description: 'Approve a pending handoff (the specialist agent takes over the conversation).',
    write: true,
    requiresAction: 'run-bot',
    params: ['handoffId', 'approvedBy'],
  },
  {
    name: 'handoff_v22_chain',
    description: 'Show the handoff chain of a conversation (which agents held it, in order) and whether the next handoff would loop.',
    write: false,
    requiresAction: 'view-own',
    params: ['conversationId'],
  },
  // Orchestration: router + escalation + audit + dashboard.
  {
    name: 'orchestrate_v22_route',
    description: 'Route a task through the rule router: keyword rules pick delegation (background work, parent keeps the conversation) or handoff (specialist takes over); no rule matches defaults to delegation.',
    write: false,
    requiresAction: 'view-own',
    params: ['message'],
  },
  {
    name: 'orchestrate_v22_escalation',
    description: 'Check whether repeated delegation failures should escalate (notify the parent or hand off to a specialist) under the escalation policy.',
    write: false,
    requiresAction: 'view-own',
    params: [],
  },
  {
    name: 'orchestrate_v22_audit',
    description: 'Show the orchestration audit trail (routing, delegation, handoff, escalation, verification decisions), newest first.',
    write: false,
    requiresAction: 'view-audit',
    params: ['conversationId', 'limit'],
  },
  {
    name: 'fleet_v22_dashboard',
    description: 'Show the aggregated fleet v22 dashboard: users (roles, quota pressure), computers (kinds, statuses, pressure), orchestration (delegations, handoffs, pending approvals/verifications) and alerts.',
    write: false,
    requiresAction: 'view-fleet',
    params: [],
  },
];

/** Tìm tool v22 theo tên; không có → undefined (không throw). */
export function findFleetV22Tool(name: string): FleetV22ToolDef | undefined {
  return FLEET_V22_TOOLS.find((t) => t.name === name);
}

/** true khi mọi tên tool v22 là duy nhất. */
export function fleetV22ToolNamesUnique(): boolean {
  return new Set(FLEET_V22_TOOLS.map((t) => t.name)).size === FLEET_V22_TOOLS.length;
}

/** Tool ghi của v22 (cần duyệt + audit khi chạy thật). */
export function fleetV22WriteTools(): FleetV22ToolDef[] {
  return FLEET_V22_TOOLS.filter((t) => t.write);
}

/** Tool v22 theo tiền tố nhóm (`fleet_v22` / `delegate_v22` / `handoff_v22` / `orchestrate_v22`). */
export function fleetV22ToolsByGroup(
  group: 'fleet_v22' | 'delegate_v22' | 'handoff_v22' | 'orchestrate_v22',
): FleetV22ToolDef[] {
  return FLEET_V22_TOOLS.filter((t) => t.name.startsWith(`${group}_`));
}

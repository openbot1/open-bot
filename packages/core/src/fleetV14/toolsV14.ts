/**
 * Tools v14 — định nghĩa tool riêng của platform/fleet v14
 * (v1.17, Đội T6).
 *
 * Theo pattern tools v13 (`fleetV13/toolsV13.ts`): registry riêng
 * của đội T6 (không sửa registry trung tâm của các đội khác): mỗi
 * tool là một định nghĩa thuần (tên, mô tả, params, cần quyền gì,
 * có ghi hay không) để agent loop / UI gọi qua các hàm core ở
 * `fleetV14/` — module này KHÔNG tự đăng ký vào registry trung tâm,
 * KHÔNG chạy tool. Coordinator gộp sẽ quyết định có merge các def
 * này vào registry trung tâm hay không; số đếm tool được pin trong
 * test của đội (`tests/fleet-v117-tools.test.mjs`).
 *
 * Quy ước tên: `fleetV14.*` cho fleet, `teamV14.*` cho multi-user,
 * `rolloutV14.*` cho rollout, `composioV14.*` cho polling.
 * Tool ghi (write: true) luôn cần duyệt trước khi chạy thật.
 */

/** Định nghĩa một tool v14 (thuần, JSON-able). */
export interface FleetV14ToolDef {
  /** Tên tool, vd `fleetV14.allocateTask`. */
  name: string;
  description: string;
  /** true = hành động ghi (cần duyệt + ghi audit). */
  write: boolean;
  /** Quyền team cần có (xem `multiUserV13.ts` TEAM_V13_ACTIONS). */
  requiresAction: string;
  /** Tên param (để UI render form, không validate kiểu ở đây). */
  params: string[];
}

/** Toàn bộ tool v14 (định nghĩa thuần). */
export const FLEET_V14_TOOLS: readonly FleetV14ToolDef[] = [
  // Multi-user v3: quota + phân quyền + audit theo user.
  {
    name: 'teamV14.quotaSummary',
    description: 'Summarize quota usage of a user (limit / used / remaining per kind).',
    write: false,
    requiresAction: 'view-members',
    params: ['userId'],
  },
  {
    name: 'teamV14.consumeQuota',
    description: 'Consume quota for a user before running a metered action (tokens / tool calls / voice minutes).',
    write: true,
    requiresAction: 'manage-own-vault',
    params: ['userId', 'kind', 'amount'],
  },
  {
    name: 'teamV14.setQuotaOverride',
    description: 'Set or clear a per-user quota override (owner/admin only).',
    write: true,
    requiresAction: 'change-role',
    params: ['userId', 'kind', 'limit'],
  },
  {
    name: 'teamV14.grantAccess',
    description: 'Grant a user access to a specific bot or tool (allow, optionally expiring).',
    write: true,
    requiresAction: 'invite-member',
    params: ['userId', 'kind', 'targetId', 'access'],
  },
  {
    name: 'teamV14.revokeAccess',
    description: 'Revoke a user access to a specific bot or tool (deny wins over role defaults).',
    write: true,
    requiresAction: 'invite-member',
    params: ['userId', 'kind', 'targetId'],
  },
  {
    name: 'teamV14.listAccessible',
    description: 'List bots or tools a user can access (grants + role defaults).',
    write: false,
    requiresAction: 'view-members',
    params: ['userId', 'kind'],
  },
  {
    name: 'teamV14.userAudit',
    description: 'List audit events for one user (hash-chained, filter by action / time).',
    write: false,
    requiresAction: 'view-audit',
    params: ['userId', 'action'],
  },
  {
    name: 'teamV14.verifyUserAudit',
    description: 'Verify the hash chain of the per-user audit log (detect tampering).',
    write: false,
    requiresAction: 'view-audit',
    params: [],
  },
  // Rollout v3.
  {
    name: 'rolloutV14.create',
    description: 'Create a staged rollout with a custom stage plan and user groups.',
    write: true,
    requiresAction: 'manage-rollout',
    params: ['feature', 'version', 'previousVersion'],
  },
  {
    name: 'rolloutV14.advance',
    description: 'Advance a rollout to the next stage (blocked by dwell time or health gate).',
    write: true,
    requiresAction: 'manage-rollout',
    params: ['rolloutId'],
  },
  {
    name: 'rolloutV14.pause',
    description: 'Pause a rollout (resumable to the same stage).',
    write: true,
    requiresAction: 'manage-rollout',
    params: ['rolloutId', 'reason'],
  },
  {
    name: 'rolloutV14.resume',
    description: 'Resume a paused rollout to its pre-pause stage.',
    write: true,
    requiresAction: 'manage-rollout',
    params: ['rolloutId'],
  },
  {
    name: 'rolloutV14.rollback',
    description: 'Roll back a rollout to its previous version.',
    write: true,
    requiresAction: 'manage-rollout',
    params: ['rolloutId', 'reason'],
  },
  {
    name: 'rolloutV14.autoRollback',
    description: 'Apply the automatic pause/rollback decision from current error metrics.',
    write: true,
    requiresAction: 'manage-rollout',
    params: ['rolloutId'],
  },
  {
    name: 'rolloutV14.cohort',
    description: 'List users in the current cohort of a rollout stage (group filter + hash cohort).',
    write: false,
    requiresAction: 'manage-rollout',
    params: ['rolloutId'],
  },
  // Composio polling v4.
  {
    name: 'composioV14.addTrigger',
    description: 'Add a Composio polling trigger with dynamic-interval config.',
    write: true,
    requiresAction: 'manage-fleet',
    params: ['triggerId', 'connectionId', 'toolkit', 'triggerSlug', 'baseIntervalMs'],
  },
  {
    name: 'composioV14.tick',
    description: 'Poll all due Composio triggers (dynamic interval, backoff, 3-layer dedupe).',
    write: true,
    requiresAction: 'manage-fleet',
    params: [],
  },
  {
    name: 'composioV14.resume',
    description: 'Resume polling state after restart from checkpoint (catch-up list).',
    write: true,
    requiresAction: 'manage-fleet',
    params: [],
  },
  {
    name: 'composioV14.triggerSummary',
    description: 'Summarize one polling trigger (interval, errors, events, duplicates).',
    write: false,
    requiresAction: 'manage-fleet',
    params: ['triggerId'],
  },
  // Fleet v14.
  {
    name: 'fleetV14.registerNode',
    description: 'Register a fleet node (id, hostname, fingerprint, labels, capacity).',
    write: true,
    requiresAction: 'manage-fleet',
    params: ['nodeId', 'hostname', 'fingerprint'],
  },
  {
    name: 'fleetV14.heartbeat',
    description: 'Record a node heartbeat (joining becomes active).',
    write: true,
    requiresAction: 'manage-fleet',
    params: ['nodeId'],
  },
  {
    name: 'fleetV14.checkNodeHealth',
    description: 'Check one node health from a sample (CPU/RAM/VRAM/disk/heartbeat).',
    write: false,
    requiresAction: 'manage-fleet',
    params: ['nodeId'],
  },
  {
    name: 'fleetV14.allocateTask',
    description: 'Allocate a task to the least-loaded eligible node (load + labels + health scoring).',
    write: true,
    requiresAction: 'manage-fleet',
    params: ['taskId', 'kind', 'cpuCores', 'ramMb', 'vramMb'],
  },
  {
    name: 'fleetV14.releaseTask',
    description: 'Release a finished/failed/cancelled task from its node.',
    write: true,
    requiresAction: 'manage-fleet',
    params: ['taskId', 'status'],
  },
  {
    name: 'fleetV14.drainNode',
    description: 'Drain a node for maintenance (block new tasks, plan migrations).',
    write: true,
    requiresAction: 'manage-fleet',
    params: ['nodeId', 'reason'],
  },
  {
    name: 'fleetV14.migrateTask',
    description: 'Migrate a running task from a draining node to another node.',
    write: true,
    requiresAction: 'manage-fleet',
    params: ['taskId', 'toNodeId'],
  },
  {
    name: 'fleetV14.completeDrain',
    description: 'Finish draining a node (only when no task is left) into maintenance.',
    write: true,
    requiresAction: 'manage-fleet',
    params: ['nodeId'],
  },
  {
    name: 'fleetV14.undrainNode',
    description: 'Bring a drained/maintenance node back to active.',
    write: true,
    requiresAction: 'manage-fleet',
    params: ['nodeId'],
  },
  {
    name: 'fleetV14.capacityReport',
    description: 'Report fleet capacity (CPU/RAM/VRAM/task slots, overloaded nodes).',
    write: false,
    requiresAction: 'manage-fleet',
    params: [],
  },
  {
    name: 'fleetV14.panels',
    description: 'Build the v1.17 system panels (memory v16, protocol v2, router v2, coding v9, voice v16, fleet v14).',
    write: false,
    requiresAction: 'view-members',
    params: [],
  },
];

/** Số tool v14 (pin trong test của đội). */
export const FLEET_V14_TOOL_COUNT = FLEET_V14_TOOLS.length;

/** Tìm tool theo tên (null khi không có). */
export function findFleetV14Tool(name: string): FleetV14ToolDef | null {
  return FLEET_V14_TOOLS.find((t) => t.name === name) ?? null;
}

/** Validate định nghĩa tool v14 (tên đúng prefix, params không trùng). */
export function validateFleetV14Tools(): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const tool of FLEET_V14_TOOLS) {
    if (!/^(teamV14|rolloutV14|composioV14|fleetV14)\./.test(tool.name)) {
      problems.push(`bad tool name: ${tool.name}`);
    }
    if (seen.has(tool.name)) problems.push(`duplicate tool name: ${tool.name}`);
    seen.add(tool.name);
    if (new Set(tool.params).size !== tool.params.length) {
      problems.push(`duplicate params in ${tool.name}`);
    }
    if (!tool.description || !tool.description.trim()) {
      problems.push(`empty description: ${tool.name}`);
    }
    if (!tool.requiresAction || !tool.requiresAction.trim()) {
      problems.push(`empty requiresAction: ${tool.name}`);
    }
  }
  return problems;
}

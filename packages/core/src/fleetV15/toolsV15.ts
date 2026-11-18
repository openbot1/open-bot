/**
 * Tools v15 — định nghĩa tool riêng của platform/fleet v15
 * (v1.18, Đội T6).
 *
 * Theo pattern tools v14 (`fleetV14/toolsV14.ts`): registry riêng
 * của đội T6 (không sửa registry trung tâm của các đội khác): mỗi
 * tool là một định nghĩa thuần (tên, mô tả, params, cần quyền gì,
 * có ghi hay không) để agent loop / UI gọi qua các hàm core ở
 * `fleetV15/` — module này KHÔNG tự đăng ký vào registry trung tâm,
 * KHÔNG chạy tool. Coordinator gộp sẽ quyết định có merge các def
 * này vào registry trung tâm hay không; số đếm tool được pin trong
 * test của đội (`tests/fleet-v118-tools.test.mjs`).
 *
 * Quy ước tên: `teamV15.*` cho multi-user v4, `rolloutV15.*` cho
 * rollout v4, `fleetV15.*` cho fleet v15, `auditV15.*` cho audit
 * log, `adminV15.*` cho admin panels.
 * Tool ghi (write: true) luôn cần duyệt trước khi chạy thật.
 */

/** Định nghĩa một tool v15 (thuần, JSON-able). */
export interface FleetV15ToolDef {
  /** Tên tool, vd `fleetV15.healthScore`. */
  name: string;
  description: string;
  /** true = hành động ghi (cần duyệt + ghi audit). */
  write: boolean;
  /** Quyền team cần có (xem `multiUserV13.ts` TEAM_V13_ACTIONS). */
  requiresAction: string;
  /** Tên param (để UI render form, không validate kiểu ở đây). */
  params: string[];
}

/** Toàn bộ tool v15 (định nghĩa thuần). */
export const FLEET_V15_TOOLS: readonly FleetV15ToolDef[] = [
  // Multi-user v4: custom role + quota tài nguyên + session + switch.
  {
    name: 'teamV15.createCustomRole',
    description: 'Create a custom role from a base role plus extra/denied actions (owner-only actions cannot leak).',
    write: true,
    requiresAction: 'change-role',
    params: ['id', 'name', 'baseRole'],
  },
  {
    name: 'teamV15.listCustomRoles',
    description: 'List custom roles with their effective actions.',
    write: false,
    requiresAction: 'view-members',
    params: [],
  },
  {
    name: 'teamV15.effectiveActions',
    description: 'List the effective actions of a role ref (built-in role or custom:<id>).',
    write: false,
    requiresAction: 'view-members',
    params: ['roleRef'],
  },
  {
    name: 'teamV15.quotaSummary',
    description: 'Summarize quota usage of a user across all 9 quota kinds (incl. CPU/RAM/disk).',
    write: false,
    requiresAction: 'view-members',
    params: ['userId'],
  },
  {
    name: 'teamV15.consumeQuota',
    description: 'Consume quota for a user before a metered action (tokens, tool calls, CPU, RAM, disk).',
    write: true,
    requiresAction: 'manage-own-vault',
    params: ['userId', 'kind', 'amount'],
  },
  {
    name: 'teamV15.setResourceQuotaOverride',
    description: 'Set or clear a per-user CPU/RAM/disk quota override (owner/admin only).',
    write: true,
    requiresAction: 'change-role',
    params: ['userId', 'kind', 'limit'],
  },
  {
    name: 'teamV15.createSession',
    description: 'Create an isolated session for a user (own working directory, expiry).',
    write: true,
    requiresAction: 'manage-own-vault',
    params: ['userId', 'roleRef', 'deviceLabel'],
  },
  {
    name: 'teamV15.revokeSession',
    description: 'Revoke one session (or all sessions of a user).',
    write: true,
    requiresAction: 'deactivate-member',
    params: ['sessionId'],
  },
  {
    name: 'teamV15.listSessions',
    description: 'List active sessions of a user.',
    write: false,
    requiresAction: 'view-members',
    params: ['userId'],
  },
  {
    name: 'teamV15.switchUser',
    description: 'Switch the active user (recorded in the hash-chained audit log).',
    write: true,
    requiresAction: 'manage-own-vault',
    params: ['fromUserId', 'toUserId'],
  },
  // Rollout v4: theo node + approve step + history.
  {
    name: 'rolloutV15.create',
    description: 'Create a rollout v4 with node targeting and approval requirements.',
    write: true,
    requiresAction: 'manage-rollout',
    params: ['feature', 'version', 'previousVersion'],
  },
  {
    name: 'rolloutV15.approve',
    description: 'Approve advancing a rollout to its next stage (distinct approvers required).',
    write: true,
    requiresAction: 'manage-rollout',
    params: ['rolloutId'],
  },
  {
    name: 'rolloutV15.advance',
    description: 'Advance a rollout to the next stage (blocked until approvals + dwell + health gate pass).',
    write: true,
    requiresAction: 'manage-rollout',
    params: ['rolloutId'],
  },
  {
    name: 'rolloutV15.setNodeTarget',
    description: 'Set the node target of a draft rollout (all nodes / label selector / node ids).',
    write: true,
    requiresAction: 'manage-rollout',
    params: ['rolloutId', 'kind'],
  },
  {
    name: 'rolloutV15.nodeStatus',
    description: 'List per-node rollout status (which version each node runs).',
    write: false,
    requiresAction: 'manage-rollout',
    params: ['rolloutId'],
  },
  {
    name: 'rolloutV15.history',
    description: 'Show the merged rollout timeline (stage changes + approvals + node version changes).',
    write: false,
    requiresAction: 'manage-rollout',
    params: ['rolloutId'],
  },
  {
    name: 'rolloutV15.autoRollback',
    description: 'Apply the automatic pause/rollback decision from current error metrics.',
    write: true,
    requiresAction: 'manage-rollout',
    params: ['rolloutId'],
  },
  // Fleet v15: health scoring + forecast + safe drain + rebalance.
  {
    name: 'fleetV15.healthScore',
    description: 'Score one node health 0-100 with per-factor breakdown and trend.',
    write: false,
    requiresAction: 'manage-fleet',
    params: ['nodeId'],
  },
  {
    name: 'fleetV15.forecastCapacity',
    description: 'Forecast when each fleet resource fills at current daily growth.',
    write: false,
    requiresAction: 'manage-fleet',
    params: [],
  },
  {
    name: 'fleetV15.safeDrain',
    description: 'Drain a node only when every running task has a destination with enough headroom.',
    write: true,
    requiresAction: 'manage-fleet',
    params: ['nodeId', 'reason'],
  },
  {
    name: 'fleetV15.rebalancePlan',
    description: 'Plan moving bots from overloaded nodes to least-loaded nodes.',
    write: false,
    requiresAction: 'manage-fleet',
    params: [],
  },
  {
    name: 'fleetV15.applyRebalance',
    description: 'Apply a rebalance plan step by step (stops at the first failing move).',
    write: true,
    requiresAction: 'manage-fleet',
    params: [],
  },
  {
    name: 'fleetV15.overview',
    description: 'Summarize fleet v15: nodes, health, capacity forecast, rebalance.',
    write: false,
    requiresAction: 'manage-fleet',
    params: [],
  },
  // Audit log v15.
  {
    name: 'auditV15.list',
    description: 'List unified audit rows (user/fleet/team) filtered by user, action, time, source, with pagination.',
    write: false,
    requiresAction: 'view-audit',
    params: ['userId', 'action', 'page'],
  },
  {
    name: 'auditV15.exportJson',
    description: 'Export filtered audit rows as JSON.',
    write: false,
    requiresAction: 'view-audit',
    params: [],
  },
  {
    name: 'auditV15.exportCsv',
    description: 'Export filtered audit rows as CSV.',
    write: false,
    requiresAction: 'view-audit',
    params: [],
  },
  {
    name: 'auditV15.verify',
    description: 'Verify the hash chain of the per-user audit log (detect tampering).',
    write: false,
    requiresAction: 'view-audit',
    params: [],
  },
  // Admin panels v15.
  {
    name: 'adminV15.panels',
    description: 'Build the v1.18 admin panels (memory v17, router v3, Composio v3, voice v17) plus audit and fleet v15 panels.',
    write: false,
    requiresAction: 'view-members',
    params: [],
  },
];

/** Số tool v15 (pin trong test của đội). */
export const FLEET_V15_TOOL_COUNT = FLEET_V15_TOOLS.length;

/** Tìm tool theo tên (null khi không có). */
export function findFleetV15Tool(name: string): FleetV15ToolDef | null {
  return FLEET_V15_TOOLS.find((t) => t.name === name) ?? null;
}

/** Validate định nghĩa tool v15 (tên đúng prefix, params không trùng). */
export function validateFleetV15Tools(): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const tool of FLEET_V15_TOOLS) {
    if (!/^(teamV15|rolloutV15|fleetV15|auditV15|adminV15)\./.test(tool.name)) {
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

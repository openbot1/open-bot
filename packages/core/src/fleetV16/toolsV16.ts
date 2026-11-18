/**
 * Tools v16 — định nghĩa tool riêng của platform/fleet v16
 * (v1.19, Đội T6).
 *
 * Theo pattern tools v15 (`fleetV15/toolsV15.ts`): registry riêng
 * của đội T6 (không sửa registry trung tâm của các đội khác): mỗi
 * tool là một định nghĩa thuần (tên, mô tả, params, cần quyền gì,
 * có ghi hay không) để agent loop / UI gọi qua các hàm core ở
 * `fleetV16/` — module này KHÔNG tự đăng ký vào registry trung tâm,
 * KHÔNG chạy tool. Coordinator gộp sẽ quyết định có merge các def
 * này vào registry trung tâm hay không; số đếm tool được pin trong
 * test của đội (`tests/fleet-v119-tools.test.mjs`).
 *
 * Quy ước tên: `teamV16.*` cho multi-user v5, `rolloutV16.*` cho
 * rollout v5, `fleetV16.*` cho fleet v16, `auditV16.*` cho audit
 * log v2, `adminV16.*` cho admin panels v2, `gatewayV16.*` cho
 * rate limiting, `tenantV16.*` cho tenant quotas.
 * Tool ghi (write: true) luôn cần duyệt trước khi chạy thật.
 */

/** Định nghĩa một tool v16 (thuần, JSON-able). */
export interface FleetV16ToolDef {
  /** Tên tool, vd `fleetV16.healthCheck`. */
  name: string;
  description: string;
  /** true = hành động ghi (cần duyệt + ghi audit). */
  write: boolean;
  /** Quyền team cần có (xem `multiUserV13.ts` TEAM_V13_ACTIONS). */
  requiresAction: string;
  /** Tên param (để UI render form, không validate kiểu ở đây). */
  params: string[];
}

/** Toàn bộ tool v16 (định nghĩa thuần). */
export const FLEET_V16_TOOLS: readonly FleetV16ToolDef[] = [
  // Multi-user v5: feature access + vòng đời user + session limit.
  {
    name: 'teamV16.createUser',
    description: 'Create an active user with a role ref (built-in role or custom:<id>).',
    write: true,
    requiresAction: 'invite-member',
    params: ['userId', 'displayName', 'roleRef'],
  },
  {
    name: 'teamV16.inviteUser',
    description: 'Invite a user with a 7-day token (user starts as invited).',
    write: true,
    requiresAction: 'invite-member',
    params: ['userId', 'displayName', 'roleRef'],
  },
  {
    name: 'teamV16.acceptInvite',
    description: 'Accept a pending invite with its token (invited -> active).',
    write: true,
    requiresAction: 'manage-own-vault',
    params: ['userId', 'token'],
  },
  {
    name: 'teamV16.suspendUser',
    description: 'Suspend a user (keeps data, blocks new logins).',
    write: true,
    requiresAction: 'deactivate-member',
    params: ['userId'],
  },
  {
    name: 'teamV16.reactivateUser',
    description: 'Reactivate a suspended or deactivated user.',
    write: true,
    requiresAction: 'reactivate-member',
    params: ['userId'],
  },
  {
    name: 'teamV16.changeUserRole',
    description: 'Change a user role (cannot demote the last active owner).',
    write: true,
    requiresAction: 'change-role',
    params: ['userId', 'roleRef'],
  },
  {
    name: 'teamV16.setUserFeatureAccess',
    description: 'Set per-user feature grants/denies (deny wins; admin grant needs owner base).',
    write: true,
    requiresAction: 'change-role',
    params: ['userId', 'grants', 'denies'],
  },
  {
    name: 'teamV16.canUseFeature',
    description: 'Check whether a user may use a feature (role + grants - denies, fail-closed).',
    write: false,
    requiresAction: 'view-members',
    params: ['userId', 'feature'],
  },
  {
    name: 'teamV16.checkSessionLimit',
    description: 'Check the concurrent session limit for a user before creating a session.',
    write: false,
    requiresAction: 'view-members',
    params: ['userId', 'activeSessionCount'],
  },
  // Rollout v5: canary + feature flag + auto-rollback.
  {
    name: 'rolloutV16.create',
    description: 'Create a rollout v5 with a canary ramp plan and error budget.',
    write: true,
    requiresAction: 'manage-rollout',
    params: ['id', 'feature', 'version'],
  },
  {
    name: 'rolloutV16.startCanary',
    description: 'Start the canary ramp of a draft rollout v5.',
    write: true,
    requiresAction: 'manage-rollout',
    params: ['rolloutId'],
  },
  {
    name: 'rolloutV16.canaryPercent',
    description: 'Current canary percent of a rollout v5 at a given time.',
    write: false,
    requiresAction: 'manage-rollout',
    params: ['rolloutId'],
  },
  {
    name: 'rolloutV16.createFlag',
    description: 'Create a feature flag with targeting and rollout percent.',
    write: true,
    requiresAction: 'manage-rollout',
    params: ['id', 'name'],
  },
  {
    name: 'rolloutV16.killFlag',
    description: 'Kill-switch a feature flag immediately (overrides everything).',
    write: true,
    requiresAction: 'manage-rollout',
    params: ['flagId'],
  },
  {
    name: 'rolloutV16.evaluateAutoRollback',
    description: 'Evaluate auto-rollback/pause from error metrics and budget.',
    write: false,
    requiresAction: 'manage-rollout',
    params: ['rolloutId', 'samples', 'errors', 'consecutiveFailures'],
  },
  // Fleet v16: đăng ký node + health + phân phối tải + vòng đời.
  {
    name: 'fleetV16.createRegistrationToken',
    description: 'Create a one-time node registration token (optionally bound to a hostname).',
    write: true,
    requiresAction: 'manage-fleet',
    params: ['expectedHostname'],
  },
  {
    name: 'fleetV16.registerNode',
    description: 'Register a fleet node with a registration token, labels and capacity.',
    write: true,
    requiresAction: 'manage-fleet',
    params: ['nodeId', 'hostname', 'registrationToken'],
  },
  {
    name: 'fleetV16.healthCheck',
    description: 'Health-check a node (heartbeat staleness + sample).',
    write: false,
    requiresAction: 'manage-fleet',
    params: ['nodeId'],
  },
  {
    name: 'fleetV16.pickNode',
    description: 'Pick a node for a task (least-loaded / least-connections / weighted-round-robin).',
    write: false,
    requiresAction: 'manage-fleet',
    params: ['taskId', 'strategy'],
  },
  {
    name: 'fleetV16.decommissionNode',
    description: 'Decommission a node (blocked while tasks run unless forced).',
    write: true,
    requiresAction: 'manage-fleet',
    params: ['nodeId', 'force'],
  },
  // Audit log v2: tìm kiếm + preset + export.
  {
    name: 'auditV16.search',
    description: 'Search audit rows with a multi-term, field-scoped query.',
    write: false,
    requiresAction: 'view-audit',
    params: ['query'],
  },
  {
    name: 'auditV16.savePreset',
    description: 'Save a named audit filter preset for reuse.',
    write: true,
    requiresAction: 'view-audit',
    params: ['name', 'filter'],
  },
  {
    name: 'auditV16.exportNdjson',
    description: 'Export audit rows as NDJSON (one JSON object per line).',
    write: false,
    requiresAction: 'view-audit',
    params: ['filter'],
  },
  // Gateway rate limiting + tenant quotas.
  {
    name: 'gatewayV16.checkRateLimit',
    description: 'Check gateway rate limit for a user/tenant/route call (no consume).',
    write: false,
    requiresAction: 'view-members',
    params: ['userId', 'tenantId', 'route'],
  },
  {
    name: 'gatewayV16.resetRateLimit',
    description: 'Reset rate-limit buckets for a user or tenant scope.',
    write: true,
    requiresAction: 'manage-team-settings',
    params: ['scope', 'scopeId'],
  },
  {
    name: 'tenantV16.createTenant',
    description: 'Create a tenant for quota tracking.',
    write: true,
    requiresAction: 'manage-team-settings',
    params: ['tenantId', 'displayName'],
  },
  {
    name: 'tenantV16.consumeQuota',
    description: 'Consume tenant quota (model calls, tokens, tool calls, storage, bots).',
    write: true,
    requiresAction: 'manage-team-settings',
    params: ['tenantId', 'kind', 'amount'],
  },
  {
    name: 'tenantV16.quotaSummary',
    description: 'Summarize tenant quota usage with warning levels and reset times.',
    write: false,
    requiresAction: 'view-members',
    params: ['tenantId'],
  },
  // Admin panels v2.
  {
    name: 'adminV16.userPanel',
    description: 'Build the user management admin panel view-model.',
    write: false,
    requiresAction: 'view-members',
    params: [],
  },
  {
    name: 'adminV16.quotaPanel',
    description: 'Build the tenant quota admin panel view-model with alerts.',
    write: false,
    requiresAction: 'view-members',
    params: [],
  },
  {
    name: 'adminV16.setConfig',
    description: 'Apply one system config value (validated; may require restart).',
    write: true,
    requiresAction: 'manage-team-settings',
    params: ['key', 'value'],
  },
];

/** Số tool v16 (pin trong test của đội). */
export const FLEET_V16_TOOL_COUNT = FLEET_V16_TOOLS.length;

/** Tìm tool theo tên (null khi không có — cùng quy ước v15). */
export function findFleetV16Tool(name: string): FleetV16ToolDef | null {
  return FLEET_V16_TOOLS.find((t) => t.name === name) ?? null;
}

/** Kiểm tra toàn bộ định nghĩa tool v16, trả về danh sách lỗi (rỗng = OK). */
export function validateFleetV16Tools(): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const tool of FLEET_V16_TOOLS) {
    if (!/^(teamV16|rolloutV16|fleetV16|auditV16|gatewayV16|tenantV16|adminV16)\./.test(tool.name)) {
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

/**
 * Tools v17 — định nghĩa tool riêng của platform/fleet v17
 * (v1.20, Đội T6).
 *
 * Theo pattern tools v16 (`fleetV16/toolsV16.ts`): registry riêng
 * của đội T6 (không sửa registry trung tâm của các đội khác): mỗi
 * tool là một định nghĩa thuần (tên, mô tả, params, cần quyền gì,
 * có ghi hay không) để agent loop / UI gọi qua các hàm core ở
 * `fleetV17/` — module này KHÔNG tự đăng ký vào registry trung tâm,
 * KHÔNG chạy tool. Coordinator gộp sẽ quyết định có merge các def
 * này vào registry trung tâm hay không; số đếm tool được pin trong
 * test của đội (`tests/fleet-v120-tools.test.mjs`).
 *
 * Quy ước tên: `fleetV17.*` cho fleet v17, `tenantV17.*` cho tenant
 * quotas v2, `gatewayV17.*` cho rate limiting v2, `auditV17.*` cho
 * audit log UI v3, `adminV17.*` cho admin panels v3,
 * `fleetVizV17.*` cho sub-agent visualizer.
 * Tool ghi (write: true) luôn cần duyệt trước khi chạy thật.
 */

/** Định nghĩa một tool v17 (thuần, JSON-able). */
export interface FleetV17ToolDef {
  /** Tên tool, vd `fleetV17.healthCheck`. */
  name: string;
  description: string;
  /** true = hành động ghi (cần duyệt + ghi audit). */
  write: boolean;
  /** Quyền team cần có (xem `multiUserV13.ts` TEAM_V13_ACTIONS). */
  requiresAction: string;
  /** Tên param (để UI render form, không validate kiểu ở đây). */
  params: string[];
}

/** Toàn bộ tool v17 (định nghĩa thuần). */
export const FLEET_V17_TOOLS: readonly FleetV17ToolDef[] = [
  // Fleet v17: health probe + capacity + drain plan + auto-scale + labels/taints.
  {
    name: 'fleetV17.healthCheck',
    description: 'Probe-based health check of a fleet node (score 0-100, level, reasons).',
    write: false,
    requiresAction: 'view-fleet',
    params: ['nodeId', 'probes'],
  },
  {
    name: 'fleetV17.capacitySummary',
    description: 'Fleet-wide capacity summary (totals, free, bottleneck, medium-task headroom).',
    write: false,
    requiresAction: 'view-fleet',
    params: [],
  },
  {
    name: 'fleetV17.planDrain',
    description: 'Plan draining a node: moves each running task to a fitting destination node.',
    write: false,
    requiresAction: 'manage-fleet',
    params: ['nodeId', 'nodeTaints', 'taskTolerations'],
  },
  {
    name: 'fleetV17.noExecuteEvictions',
    description: 'List running tasks that must move off nodes with a NoExecute taint they do not tolerate.',
    write: false,
    requiresAction: 'view-fleet',
    params: ['nodeTaints', 'taskTolerations'],
  },
  {
    name: 'fleetV17.evaluateScaleRule',
    description: 'Evaluate an auto-scale rule on fleet metrics (returns up/down/none decision).',
    write: false,
    requiresAction: 'manage-fleet',
    params: ['rule', 'samples', 'lastScaleAt'],
  },
  {
    name: 'fleetV17.validateLabels',
    description: 'Validate node label map (slug keys, max 32 labels per node).',
    write: false,
    requiresAction: 'manage-fleet',
    params: ['labels'],
  },
  {
    name: 'fleetV17.validateTaint',
    description: 'Validate a node taint (key=value:effect, NoSchedule/PreferNoSchedule/NoExecute).',
    write: false,
    requiresAction: 'manage-fleet',
    params: ['taint'],
  },
  // Tenant quotas v2: resource quotas + soft/hard enforcement + audited override.
  {
    name: 'tenantV17.checkQuota',
    description: 'Check a tenant quota (cpu/ram/disk/api-calls) before consuming it.',
    write: false,
    requiresAction: 'view-quotas',
    params: ['tenantId', 'kind', 'amount'],
  },
  {
    name: 'tenantV17.consumeQuota',
    description: 'Consume tenant quota (soft overage allowed with a warning, hard overage blocked).',
    write: true,
    requiresAction: 'manage-quotas',
    params: ['tenantId', 'kind', 'amount'],
  },
  {
    name: 'tenantV17.releaseQuota',
    description: 'Release level quota (cpu/ram/disk) previously consumed by a tenant.',
    write: true,
    requiresAction: 'manage-quotas',
    params: ['tenantId', 'kind', 'amount'],
  },
  {
    name: 'tenantV17.setQuotaOverride',
    description: 'Override a tenant quota limit/enforcement (audited, reason required).',
    write: true,
    requiresAction: 'manage-quotas',
    params: ['tenantId', 'kind', 'newLimit', 'newEnforcement', 'actorUserId', 'reason'],
  },
  {
    name: 'tenantV17.listOverrideAudit',
    description: 'List quota override audit entries, filterable by tenant/kind/actor/time.',
    write: false,
    requiresAction: 'view-quotas',
    params: ['tenantId', 'kind', 'actorUserId', 'fromAt', 'toAt'],
  },
  {
    name: 'tenantV17.alerts',
    description: 'List quota alerts for all tenants, worst first.',
    write: false,
    requiresAction: 'view-quotas',
    params: [],
  },
  // Gateway rate limiting v2: token bucket + sliding window + load sim.
  {
    name: 'gatewayV17.checkRateLimit',
    description: 'Check a gateway call against token bucket + sliding window limits (user/tenant/route).',
    write: false,
    requiresAction: 'view-gateway',
    params: ['userId', 'tenantId', 'route'],
  },
  {
    name: 'gatewayV17.consumeRateLimit',
    description: 'Record a gateway call (token + sliding window) and return the decision.',
    write: true,
    requiresAction: 'manage-gateway',
    params: ['userId', 'tenantId', 'route'],
  },
  {
    name: 'gatewayV17.rateLimitHeaders',
    description: 'Build standard rate-limit headers (Retry-After, X-RateLimit-*) for a decision.',
    write: false,
    requiresAction: 'view-gateway',
    params: ['decision'],
  },
  {
    name: 'gatewayV17.simulateLoad',
    description: 'Run a light load simulation (even/burst-start/ramp-up) against the limiter and report allowed/blocked.',
    write: false,
    requiresAction: 'manage-gateway',
    params: ['userId', 'tenantId', 'route', 'totalRequests', 'durationMs', 'pattern'],
  },
  {
    name: 'gatewayV17.resetRateLimit',
    description: 'Reset rate-limit buckets for a scope (admin reset for a user/tenant/route).',
    write: true,
    requiresAction: 'manage-gateway',
    params: ['scope', 'scopeId', 'route'],
  },
  // Audit log UI v3: multi-dimension filter + entry detail + filtered export + timeline.
  {
    name: 'auditV17.filter',
    description: 'Filter audit rows by user/action/resource/time/severity/source/verified.',
    write: false,
    requiresAction: 'view-audit',
    params: ['filter'],
  },
  {
    name: 'auditV17.detail',
    description: 'Detail of one audit entry with context (previous/next for the resource, recent actor actions).',
    write: false,
    requiresAction: 'view-audit',
    params: ['source', 'seq'],
  },
  {
    name: 'auditV17.exportFiltered',
    description: 'Export filtered audit rows as JSON/CSV/NDJSON with metadata header.',
    write: false,
    requiresAction: 'view-audit',
    params: ['filter', 'format'],
  },
  {
    name: 'auditV17.timeline',
    description: 'Audit timeline buckets (per hour/day) with top actors/actions/resources.',
    write: false,
    requiresAction: 'view-audit',
    params: ['filter', 'bucketMs'],
  },
  // Admin panels v3: dashboard + quota management + rollout management.
  {
    name: 'adminV17.dashboard',
    description: 'Build the fleet+tenant overview dashboard panel (fleet, tenants, gateway, audit, rollouts, sub-agents).',
    write: false,
    requiresAction: 'view-admin',
    params: ['capacity', 'healthChecks', 'quotaState', 'gatewayBucketCount', 'auditTimeline', 'rolloutStore', 'subAgentMap'],
  },
  {
    name: 'adminV17.quotaPanel',
    description: 'Build the tenant quota management panel (usage rows, worst level, recent overrides).',
    write: false,
    requiresAction: 'view-quotas',
    params: ['quotaState'],
  },
  {
    name: 'adminV17.rolloutPanel',
    description: 'Build the rollout management panel (stage, percent, status, needs-attention).',
    write: false,
    requiresAction: 'manage-rollout',
    params: ['rolloutStore'],
  },
  // Sub-agent visualizer: node map + parent tree + overload flags.
  {
    name: 'fleetVizV17.buildMap',
    description: 'Build the fleet sub-agent map (nodes, agents, parent edges, layout, summary).',
    write: false,
    requiresAction: 'view-fleet',
    params: ['snapshot', 'healthChecks', 'capacity', 'parentLinks'],
  },
  {
    name: 'fleetVizV17.summaryText',
    description: 'One-line text summary of a fleet sub-agent map.',
    write: false,
    requiresAction: 'view-fleet',
    params: ['map'],
  },
];

/** Tìm tool v17 theo tên (null = không có). */
export function findFleetV17Tool(name: string): FleetV17ToolDef | null {
  return FLEET_V17_TOOLS.find((t) => t.name === name) ?? null;
}

/** Lỗi validate danh sách tool (trùng tên / tên sai prefix / thiếu field), '' = hợp lệ. */
export function validateFleetV17Tools(tools: readonly FleetV17ToolDef[]): string {
  const seen = new Set<string>();
  for (const tool of tools) {
    if (!/^(fleetV17|tenantV17|gatewayV17|auditV17|adminV17|fleetVizV17)\./.test(tool.name)) {
      return `tool name không đúng prefix v17: ${tool.name}`;
    }
    if (seen.has(tool.name)) return `trùng tên tool: ${tool.name}`;
    seen.add(tool.name);
    if (tool.description.trim() === '') return `tool ${tool.name} thiếu description`;
    if (tool.requiresAction.trim() === '') return `tool ${tool.name} thiếu requiresAction`;
  }
  return '';
}

/** Số tool v17 (pin trong test). */
export const FLEET_V17_TOOL_COUNT = FLEET_V17_TOOLS.length;

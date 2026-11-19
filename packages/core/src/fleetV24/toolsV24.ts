/**
 * Tools v24 — định nghĩa tool riêng của fleet v24 (v1.37, Đội T6).
 *
 * Theo pattern tools v23 (`fleetV23/toolsV23.ts`): registry riêng của
 * đội T6 (không sửa registry trung tâm của các đội khác): mỗi tool là
 * một định nghĩa thuần (tên, mô tả, params, cần quyền gì, có ghi hay
 * không) để agent loop / UI gọi qua các hàm core ở `fleetV24/` —
 * module này KHÔNG tự đăng ký vào registry trung tâm, KHÔNG chạy tool.
 * Tool chạy thật nằm ở `packages/tools/src/fleetV24Tools.ts`.
 *
 * Quy ước tên (snake_case, KHÔNG dấu chấm — v21/v22 đã nổ
 * `defaultToolFactory` vì tên dotted, không lặp lại):
 * - `fleet_v24_*` — automation dashboard: đăng ký automation, gom theo
 *   tag, lọc theo owner, thống kê tag/owner, bật/tắt/pause theo nhóm tag.
 * - `stophook_v24_*` — stop hook feedback: ghi feedback khi hook kích
 *   hoạt, truy vấn theo run/automation, xác nhận đã xem, tóm tắt.
 * - `cidr_v24_*` — CIDR sandbox rules trong router: thêm/sửa/bật/tắt
 *   rule, validate CIDR, đánh giá (route, IP), xem rule theo route,
 *   phát hiện chồng lấn, xem audit.
 * Tool ghi (write: true) luôn cần duyệt trước khi chạy thật.
 */

/** Định nghĩa một tool v24 (thuần, JSON-able). */
export interface FleetV24ToolDef {
  /** Tên tool, vd `fleet_v24_register`. */
  name: string;
  description: string;
  /** true = hành động ghi (cần duyệt + ghi audit). */
  write: boolean;
  /** Quyền team cần có (xem `users.ts` v22 FLEET_V22_ACTION_MIN_ROLE). */
  requiresAction: string;
  /** Tên param (để UI render form, không validate kiểu ở đây). */
  params: string[];
}

/** Toàn bộ tool v24 (định nghĩa thuần). */
export const FLEET_V24_TOOLS: readonly FleetV24ToolDef[] = [
  // Automation dashboard: register + group + filter + stats + bulk.
  {
    name: 'fleet_v24_register',
    description: 'Register an automation in the fleet v24 dashboard with an owner, tags and an optional schedule; ids must be unique.',
    write: true,
    requiresAction: 'manage-fleet',
    params: ['id', 'name', 'owner', 'tags', 'schedule'],
  },
  {
    name: 'fleet_v24_list',
    description: 'List automations in the fleet v24 dashboard, optionally filtered by tag, owner or status.',
    write: false,
    requiresAction: 'view-fleet',
    params: ['tag', 'owner', 'status'],
  },
  {
    name: 'fleet_v24_group_by_tag',
    description: 'Group automations by tag with per-tag stats (total, running, failed, paused, completed) and the owners inside each tag group.',
    write: false,
    requiresAction: 'view-fleet',
    params: [],
  },
  {
    name: 'fleet_v24_group_by_owner',
    description: 'Slice automations by owner with per-owner stats and the tags each owner uses.',
    write: false,
    requiresAction: 'view-fleet',
    params: [],
  },
  {
    name: 'fleet_v24_stats',
    description: 'Fleet-wide automation stats, or stats for one tag or one owner (total, running, failed, paused, success/failure rate).',
    write: false,
    requiresAction: 'view-fleet',
    params: ['tag', 'owner'],
  },
  {
    name: 'fleet_v24_enable_tag',
    description: 'Enable every automation carrying a tag (disabled automations become idle); reports per-automation applied/skipped results.',
    write: true,
    requiresAction: 'manage-fleet',
    params: ['tag'],
  },
  {
    name: 'fleet_v24_disable_tag',
    description: 'Disable every automation carrying a tag; reports per-automation applied/skipped results.',
    write: true,
    requiresAction: 'manage-fleet',
    params: ['tag'],
  },
  {
    name: 'fleet_v24_pause_tag',
    description: 'Pause every running or idle automation carrying a tag; reports per-automation applied/skipped results.',
    write: true,
    requiresAction: 'manage-fleet',
    params: ['tag'],
  },
  {
    name: 'fleet_v24_resume_tag',
    description: 'Resume every paused automation carrying a tag; reports per-automation applied/skipped results.',
    write: true,
    requiresAction: 'manage-fleet',
    params: ['tag'],
  },
  {
    name: 'fleet_v24_dashboard',
    description: 'Build the fleet v24 automation dashboard: tag groups, owner slices, fleet stats, failed/running lists and stop-hook summary.',
    write: false,
    requiresAction: 'view-fleet',
    params: [],
  },
  {
    name: 'fleet_v24_run_start',
    description: 'Start a run of an automation in the run ledger (copies owner/tags at start time) and mark the automation running.',
    write: true,
    requiresAction: 'run-bot',
    params: ['id', 'automationId', 'trigger'],
  },
  {
    name: 'fleet_v24_run_finish',
    description: 'Finish a run as completed, failed, stopped or cancelled; a stopped run may link its stop-hook feedback id.',
    write: true,
    requiresAction: 'run-bot',
    params: ['id', 'outcome', 'error', 'stopHookFeedbackId'],
  },
  {
    name: 'fleet_v24_runs',
    description: 'Query runs by automation, tag, owner, outcome or time window; also lists stuck runs still in flight past a max age.',
    write: false,
    requiresAction: 'view-fleet',
    params: ['automationId', 'tag', 'owner', 'outcome', 'fromMs', 'toMs'],
  },
  // Stop hook feedback: record + query + acknowledge + summaries.
  {
    name: 'stophook_v24_record',
    description: 'Record stop-hook feedback when a stop hook fires: run + automation, reason, who/what triggered it, action taken, and a suggested next action (derived when not given).',
    write: true,
    requiresAction: 'run-bot',
    params: ['id', 'runId', 'automationId', 'reason', 'triggeredBy', 'triggeredByName', 'action'],
  },
  {
    name: 'stophook_v24_for_run',
    description: 'Show stop-hook feedback for one run, newest first.',
    write: false,
    requiresAction: 'view-fleet',
    params: ['runId'],
  },
  {
    name: 'stophook_v24_for_automation',
    description: 'Show stop-hook feedback for one automation, newest first, with a per-automation summary.',
    write: false,
    requiresAction: 'view-fleet',
    params: ['automationId'],
  },
  {
    name: 'stophook_v24_unacknowledged',
    description: 'List stop-hook feedback not yet acknowledged by an operator — the review to-do list.',
    write: false,
    requiresAction: 'view-fleet',
    params: [],
  },
  {
    name: 'stophook_v24_acknowledge',
    description: 'Acknowledge a stop-hook feedback record as reviewed, with an optional operator note.',
    write: true,
    requiresAction: 'manage-fleet',
    params: ['id', 'acknowledgedBy', 'note'],
  },
  {
    name: 'stophook_v24_summary',
    description: 'Summarise stop-hook feedback fleet-wide or per automation: totals, unacknowledged count, breakdown by trigger and action.',
    write: false,
    requiresAction: 'view-fleet',
    params: ['automationId'],
  },
  // CIDR sandbox rules in the router UI.
  {
    name: 'cidr_v24_add_rule',
    description: 'Add a CIDR sandbox rule for the router (allow/deny a CIDR range, optionally bound to one route, with a priority); the CIDR is validated and stored normalised.',
    write: true,
    requiresAction: 'manage-fleet',
    params: ['id', 'cidr', 'action', 'routeId', 'priority', 'description'],
  },
  {
    name: 'cidr_v24_remove_rule',
    description: 'Remove a CIDR sandbox rule from the router rule set.',
    write: true,
    requiresAction: 'manage-fleet',
    params: ['id'],
  },
  {
    name: 'cidr_v24_validate',
    description: 'Validate a CIDR string for the router UI (valid IPv4/IPv6 range, host-bits warning, /0 warning) and return the normalised form.',
    write: false,
    requiresAction: 'view-fleet',
    params: ['cidr'],
  },
  {
    name: 'cidr_v24_evaluate',
    description: 'Evaluate one (route, IP) pair against the CIDR rules: the most specific matching rule decides (longest prefix, then priority, deny wins ties); no match falls back to the default.',
    write: false,
    requiresAction: 'view-fleet',
    params: ['routeId', 'ip'],
  },
  {
    name: 'cidr_v24_rules_for_route',
    description: 'List the CIDR rules that apply to one route (route-bound rules plus global rules), in evaluation order.',
    write: false,
    requiresAction: 'view-fleet',
    params: ['routeId'],
  },
  {
    name: 'cidr_v24_overlaps',
    description: 'Detect overlapping enabled CIDR rules and flag the ones that disagree (one allow, one deny).',
    write: false,
    requiresAction: 'view-fleet',
    params: [],
  },
  {
    name: 'cidr_v24_audit',
    description: 'Show the CIDR rule audit trail (rule changes, who made them, when), optionally for one rule.',
    write: false,
    requiresAction: 'view-fleet',
    params: ['ruleId'],
  },
];

/** Tìm một tool v24 theo tên (undefined khi không có). */
export function findFleetV24Tool(name: string): FleetV24ToolDef | undefined {
  return FLEET_V24_TOOLS.find((t) => t.name === name);
}

/** true khi mọi tên tool v24 hợp lệ: duy nhất, snake_case, không dấu chấm. */
export function fleetV24ToolNamesValid(): boolean {
  const seen = new Set<string>();
  for (const t of FLEET_V24_TOOLS) {
    if (t.name.includes('.')) return false;
    if (!/^[a-z][a-z0-9_]*$/.test(t.name)) return false;
    if (seen.has(t.name)) return false;
    seen.add(t.name);
  }
  return true;
}

/** Tool v24 theo nhóm prefix (`fleet_v24`, `stophook_v24`, `cidr_v24`). */
export function fleetV24ToolsByGroup(prefix: string): FleetV24ToolDef[] {
  return FLEET_V24_TOOLS.filter((t) => t.name.startsWith(`${prefix}_`));
}

/** Tool v24 là hành động ghi (cần duyệt). */
export function fleetV24WriteTools(): FleetV24ToolDef[] {
  return FLEET_V24_TOOLS.filter((t) => t.write);
}

/** Tool v24 chỉ đọc. */
export function fleetV24ReadTools(): FleetV24ToolDef[] {
  return FLEET_V24_TOOLS.filter((t) => !t.write);
}

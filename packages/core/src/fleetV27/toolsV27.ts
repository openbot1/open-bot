/**
 * Tools v27 — pure definitions for fleet v27 (v1.40, Team T6).
 *
 * Follows the `fleetV26/toolsV26.ts` pattern: a separate pure
 * registry (this file) that defines each tool (name, description,
 * params, whether it writes) — this module does NOT run tools and
 * does NOT register into the central registry. The runnable tools
 * live in `packages/tools/src/fleetV27Tools.ts`.
 *
 * Naming (snake_case, NO dots — v21/v22 broke `defaultToolFactory`
 * with dotted names, never again). Groups (30 tools):
 * - `fleet_v27_campaign_*` — async run campaigns (create/list/get/
 *   start/progress/cancel/results/remove/retry/summary).
 * - `fleet_v27_template_*` — automation templates (list/get/suggest)
 *   + automations created from them (create/list/get/enable/remove/
 *   due/mark-ran).
 * - `fleet_v27_quota_*` — fleet quota v2 (limits/usage/evaluate/
 *   alerts/policy/queue).
 * - `fleet_v27_dashboard` — combined dashboard.
 *
 * Write tools need approval (`write: true`). They never run a model,
 * never spawn a process, and never touch the network.
 */

/** Definition of one v27 tool (pure, JSON-able). */
export interface FleetV27ToolDef {
  /** Tool name, e.g. `fleet_v27_campaign_create`. */
  name: string;
  description: string;
  /** true = a write action (needs approval). */
  write: boolean;
  /** Parameter names (for the UI form; no type validation here). */
  params: string[];
}

/** All v27 tools (pure definitions). */
export const FLEET_V27_TOOLS: readonly FleetV27ToolDef[] = [
  // Campaigns: async run campaigns.
  {
    name: 'fleet_v27_campaign_create',
    description: 'Create an async run campaign (bots + task + concurrency).',
    write: true,
    params: ['id', 'name', 'description', 'bots', 'task', 'concurrency', 'tags', 'createdBy'],
  },
  {
    name: 'fleet_v27_campaign_list',
    description: 'List campaigns, optionally filtered by tag.',
    write: false,
    params: ['tag'],
  },
  {
    name: 'fleet_v27_campaign_get',
    description: 'Show one campaign definition.',
    write: false,
    params: ['id'],
  },
  {
    name: 'fleet_v27_campaign_start',
    description: 'Start a run of a campaign (bots start up to the concurrency cap).',
    write: true,
    params: ['campaignId', 'startedBy'],
  },
  {
    name: 'fleet_v27_campaign_progress',
    description: 'Show one run progress: per-bot states, aggregate counts, overall status.',
    write: false,
    params: ['runId'],
  },
  {
    name: 'fleet_v27_campaign_advance',
    description: 'Advance a run one tick with host-reported per-bot outcomes (retries + fills freed slots).',
    write: true,
    params: ['runId', 'outcomes'],
  },
  {
    name: 'fleet_v27_campaign_cancel',
    description: 'Cancel a running campaign run (queued/running bots become cancelled).',
    write: true,
    params: ['runId', 'reason'],
  },
  {
    name: 'fleet_v27_campaign_results',
    description: 'Show finished campaign runs (history) with per-bot results, optionally filtered by status.',
    write: false,
    params: ['status', 'campaignId'],
  },
  {
    name: 'fleet_v27_campaign_retry_failed',
    description: 'Retry the failed / timed-out bots of a finished run as a new run.',
    write: true,
    params: ['runId', 'startedBy'],
  },
  {
    name: 'fleet_v27_campaign_remove',
    description: 'Remove a campaign definition (its runs stay in history).',
    write: true,
    params: ['id'],
  },
  // Templates + automations.
  {
    name: 'fleet_v27_template_list',
    description: 'List built-in automation templates, optionally filtered by category.',
    write: false,
    params: ['category'],
  },
  {
    name: 'fleet_v27_template_get',
    description: 'Show one automation template (default cron, task, params).',
    write: false,
    params: ['id'],
  },
  {
    name: 'fleet_v27_template_suggest',
    description: 'Suggest automation templates ranked for the current repo/bot context.',
    write: false,
    params: ['repoPath', 'hasGit', 'botTags', 'botCount', 'capabilities', 'hourOfDay', 'limit'],
  },
  {
    name: 'fleet_v27_automation_create',
    description: 'Create a scheduled automation from a template (bot + repo + cron + params).',
    write: true,
    params: ['templateId', 'botId', 'repoPath', 'cron', 'name', 'params'],
  },
  {
    name: 'fleet_v27_automation_list',
    description: 'List automations created from templates, optionally filtered.',
    write: false,
    params: ['templateId', 'botId', 'enabled'],
  },
  {
    name: 'fleet_v27_automation_get',
    description: 'Show one automation (schedule, next run, run count).',
    write: false,
    params: ['id'],
  },
  {
    name: 'fleet_v27_automation_set_enabled',
    description: 'Enable or disable a scheduled automation.',
    write: true,
    params: ['id', 'enabled'],
  },
  {
    name: 'fleet_v27_automation_remove',
    description: 'Remove a scheduled automation.',
    write: true,
    params: ['id'],
  },
  {
    name: 'fleet_v27_automation_due',
    description: 'List automations that are enabled and due to run now.',
    write: false,
    params: [],
  },
  {
    name: 'fleet_v27_automation_mark_ran',
    description: 'Record that an automation ran (bumps its count, recomputes its next run).',
    write: true,
    params: ['id'],
  },
  // Fleet quota v2.
  {
    name: 'fleet_v27_quota_limits',
    description: 'Show the fleet quota v2 limits (CPU/RAM/disk, caps).',
    write: false,
    params: [],
  },
  {
    name: 'fleet_v27_quota_set_limits',
    description: 'Set fleet quota v2 limits (validated; bad values are refused).',
    write: true,
    params: ['cpuCores', 'ramMB', 'diskMB', 'maxConcurrentBots', 'maxCampaigns', 'maxRunsPerDay', 'maxBotsTotal'],
  },
  {
    name: 'fleet_v27_quota_usage',
    description: 'Show live fleet usage against the quota (with per-resource ratios).',
    write: false,
    params: [],
  },
  {
    name: 'fleet_v27_quota_evaluate',
    description: 'Evaluate one admission request: admit, queue, defer, or reject — with reasons.',
    write: false,
    params: ['kind', 'cpuCores', 'ramMB', 'diskMB', 'extraRunningBots', 'extraCampaigns', 'extraRunsToday', 'extraTotalBots'],
  },
  {
    name: 'fleet_v27_quota_alerts',
    description: 'Show quota alerts per resource (ok / warn at 80% / critical at 95%).',
    write: false,
    params: [],
  },
  {
    name: 'fleet_v27_quota_policy',
    description: 'Show the exhaustion policy (what happens per resource when quota runs out).',
    write: false,
    params: [],
  },
  {
    name: 'fleet_v27_quota_set_policy',
    description: 'Set the exhaustion policy (queue / defer / reject per resource).',
    write: true,
    params: ['onCpuExhausted', 'onRamExhausted', 'onDiskExhausted', 'onBotCountExhausted', 'onCampaignExhausted', 'onRunsExhausted', 'onTotalBotsExhausted', 'queueMaxWaitMs', 'queueMaxLength'],
  },
  {
    name: 'fleet_v27_quota_queue_list',
    description: 'List requests waiting in the quota queue (head first).',
    write: false,
    params: [],
  },
  {
    name: 'fleet_v27_quota_queue_promote',
    description: 'Try to promote the head of the quota queue now that capacity may have freed.',
    write: true,
    params: [],
  },
  // Combined dashboard.
  {
    name: 'fleet_v27_dashboard',
    description: 'Build the combined fleet v27 dashboard: campaigns, automations, quota.',
    write: false,
    params: [],
  },
];

/** Find a v27 tool by name (undefined when absent). */
export function findFleetV27Tool(name: string): FleetV27ToolDef | undefined {
  return FLEET_V27_TOOLS.find((t) => t.name === name);
}

/** true when every v27 tool name is valid: unique, snake_case, no dots. */
export function fleetV27ToolNamesValid(): boolean {
  const seen = new Set<string>();
  for (const t of FLEET_V27_TOOLS) {
    if (t.name.includes('.')) return false;
    if (!/^[a-z][a-z0-9_]*$/.test(t.name)) return false;
    if (seen.has(t.name)) return false;
    seen.add(t.name);
  }
  return true;
}

/** v27 tools by name prefix (`fleet_v27`). */
export function fleetV27ToolsByGroup(prefix: string): FleetV27ToolDef[] {
  return FLEET_V27_TOOLS.filter((t) => t.name.startsWith(`${prefix}_`));
}

/** v27 tools that write (need approval). */
export function fleetV27WriteTools(): FleetV27ToolDef[] {
  return FLEET_V27_TOOLS.filter((t) => t.write);
}

/** v27 tools that only read. */
export function fleetV27ReadTools(): FleetV27ToolDef[] {
  return FLEET_V27_TOOLS.filter((t) => !t.write);
}

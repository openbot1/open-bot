/**
 * Tools v28 — pure definitions for fleet v28 (v1.41, Team T6).
 *
 * Follows the `fleetV27/toolsV27.ts` pattern: a separate pure
 * registry (this file) that defines each tool (name, description,
 * params, whether it writes) — this module does NOT run tools and
 * does NOT register into the central registry. The runnable tools
 * live in `packages/tools/src/fleetV28Tools.ts`.
 *
 * Naming (snake_case, NO dots — v21/v22 broke `defaultToolFactory`
 * with dotted names, never again). Groups (40 tools):
 * - `fleet_v28_runtime_*` — per-conversation sandbox runtime
 *   (start/list/get/stop/restart/limits/set-limits/usage/
 *   evict-idle/health/probe).
 * - `fleet_v28_secret_*` — profile-scoped secrets (set/get/list/
 *   delete/rotate/redact/audit).
 * - `fleet_v28_budget_*` — conversation budget meter (record/get/
 *   set-cap/list/reset/report-daily/report-weekly/alerts) + forecast
 *   (forecast/burn-rate/model-breakdown).
 * - `fleet_v28_sandbox_*` — sandbox policy (policy/validate-path/
 *   validate-command/watchdog).
 * - `fleet_v28_conversation_*` — conversation <-> runtime adapter
 *   (attach/event/list).
 * - `fleet_v28_preset_*` — runtime/budget presets per profile
 *   (list/get/set).
 * - `fleet_v28_dashboard` — combined dashboard.
 *
 * Write tools need approval (`write: true`). They never run a model,
 * never spawn a process, and never touch the network. Secret values
 * are only ever returned by `fleet_v28_secret_get` to the owning
 * profile; listings and audit entries never carry values.
 */

/** Definition of one v28 tool (pure, JSON-able). */
export interface FleetV28ToolDef {
  /** Tool name, e.g. `fleet_v28_runtime_start`. */
  name: string;
  description: string;
  /** true = a write action (needs approval). */
  write: boolean;
  /** Parameter names (for the UI form; no type validation here). */
  params: string[];
}

/** All v28 tools (pure definitions). */
export const FLEET_V28_TOOLS: readonly FleetV28ToolDef[] = [
  // Per-conversation sandbox runtime.
  {
    name: 'fleet_v28_runtime_start',
    description: 'Start a per-conversation sandbox runtime (limits + concurrency cap; queues when full).',
    write: true,
    params: ['conversationId', 'profileId', 'botId', 'cpuCores', 'ramMB', 'diskMB', 'timeoutMs', 'idleTimeoutMs', 'maxRestarts'],
  },
  {
    name: 'fleet_v28_runtime_list',
    description: 'List conversation runtimes, optionally filtered by state or profile.',
    write: false,
    params: ['state', 'profileId'],
  },
  {
    name: 'fleet_v28_runtime_get',
    description: 'Show one conversation runtime (state, health, limits, usage).',
    write: false,
    params: ['conversationId'],
  },
  {
    name: 'fleet_v28_runtime_stop',
    description: 'Stop a conversation runtime (saves a state snapshot first).',
    write: true,
    params: ['conversationId'],
  },
  {
    name: 'fleet_v28_runtime_restart',
    description: 'Restart a conversation runtime (restores the saved snapshot when present).',
    write: true,
    params: ['conversationId'],
  },
  {
    name: 'fleet_v28_runtime_limits',
    description: 'Show the default runtime limits and the store concurrency config.',
    write: false,
    params: [],
  },
  {
    name: 'fleet_v28_runtime_set_limits',
    description: 'Set one runtime limits (validated; bad values are refused).',
    write: true,
    params: ['conversationId', 'cpuCores', 'ramMB', 'diskMB', 'timeoutMs', 'idleTimeoutMs', 'maxRestarts'],
  },
  {
    name: 'fleet_v28_runtime_usage',
    description: 'Show live usage of one runtime against its limits (with over-limit flags).',
    write: false,
    params: ['conversationId'],
  },
  {
    name: 'fleet_v28_runtime_evict_idle',
    description: 'Evict runtimes idle past their idle timeout (saves state, frees slots, promotes the queue).',
    write: true,
    params: [],
  },
  {
    name: 'fleet_v28_runtime_health',
    description: 'Show health of one runtime (probe state, restarts, failures) or all runtimes.',
    write: false,
    params: ['conversationId'],
  },
  {
    name: 'fleet_v28_runtime_probe',
    description: 'Record a health probe for a runtime (failed probes auto-restart up to maxRestarts).',
    write: true,
    params: ['conversationId', 'healthy'],
  },
  // Profile-scoped secrets.
  {
    name: 'fleet_v28_secret_set',
    description: 'Set a secret for a profile (scoped: no other profile can read it).',
    write: true,
    params: ['profileId', 'name', 'value'],
  },
  {
    name: 'fleet_v28_secret_get',
    description: 'Get a secret value — only for its owning profile.',
    write: false,
    params: ['profileId', 'name'],
  },
  {
    name: 'fleet_v28_secret_list',
    description: 'List a profile secret names + metadata (values are never listed).',
    write: false,
    params: ['profileId'],
  },
  {
    name: 'fleet_v28_secret_delete',
    description: 'Delete a profile secret.',
    write: true,
    params: ['profileId', 'name'],
  },
  {
    name: 'fleet_v28_secret_rotate',
    description: 'Rotate a profile secret (new value, version +1, old value kept during a grace window).',
    write: true,
    params: ['profileId', 'name', 'newValue', 'graceMs'],
  },
  {
    name: 'fleet_v28_secret_redact',
    description: 'Redact a profile secret values out of free text (for safe logging).',
    write: false,
    params: ['profileId', 'text'],
  },
  {
    name: 'fleet_v28_secret_audit',
    description: 'Show a profile secret audit ledger (actions only — values are never logged).',
    write: false,
    params: ['profileId'],
  },
  // Conversation budget meter.
  {
    name: 'fleet_v28_budget_record',
    description: 'Record token usage for a conversation (refused when past the hard cap).',
    write: true,
    params: ['conversationId', 'profileId', 'model', 'inputTokens', 'outputTokens'],
  },
  {
    name: 'fleet_v28_budget_get',
    description: 'Show one conversation budget meter (tokens, cost, cap, level, remaining).',
    write: false,
    params: ['conversationId'],
  },
  {
    name: 'fleet_v28_budget_set_cap',
    description: 'Set (or clear) a conversation hard budget cap in USD.',
    write: true,
    params: ['conversationId', 'capUsd'],
  },
  {
    name: 'fleet_v28_budget_list',
    description: 'List budget meters, optionally filtered by profile (highest cost first).',
    write: false,
    params: ['profileId'],
  },
  {
    name: 'fleet_v28_budget_reset',
    description: 'Reset one conversation budget meter (counters to zero; history kept for reports).',
    write: true,
    params: ['conversationId'],
  },
  {
    name: 'fleet_v28_budget_report_daily',
    description: 'Daily budget report for one UTC date (per-profile + top conversations).',
    write: false,
    params: ['day'],
  },
  {
    name: 'fleet_v28_budget_report_weekly',
    description: 'Weekly budget report for the 7 days starting at a UTC date.',
    write: false,
    params: ['weekStart'],
  },
  {
    name: 'fleet_v28_budget_alerts',
    description: 'Show budget meters at or over their warn threshold.',
    write: false,
    params: [],
  },
  {
    name: 'fleet_v28_budget_forecast',
    description: 'Forecast a profile spend to a horizon date from its burn rate.',
    write: false,
    params: ['profileId', 'windowStart', 'windowEnd', 'horizon'],
  },
  {
    name: 'fleet_v28_budget_burn_rate',
    description: 'Show a profile burn rate (cost per active day) over a window.',
    write: false,
    params: ['profileId', 'windowStart', 'windowEnd'],
  },
  {
    name: 'fleet_v28_budget_model_breakdown',
    description: 'Show per-model cost breakdown over a window (optionally one profile).',
    write: false,
    params: ['windowStart', 'windowEnd', 'profileId'],
  },
  // Sandbox policy.
  {
    name: 'fleet_v28_sandbox_policy',
    description: 'Show the default sandbox policy + cgroup limits for a conversation runtime.',
    write: false,
    params: ['conversationId', 'workspaceRoot'],
  },
  {
    name: 'fleet_v28_sandbox_validate_path',
    description: 'Check whether a path stays inside a conversation workspace root.',
    write: false,
    params: ['workspaceRoot', 'targetPath'],
  },
  {
    name: 'fleet_v28_sandbox_validate_command',
    description: 'Validate an exec request (command/args/cwd/timeout) against the sandbox policy.',
    write: false,
    params: ['conversationId', 'workspaceRoot', 'command', 'args', 'cwd', 'timeoutMs'],
  },
  {
    name: 'fleet_v28_sandbox_watchdog',
    description: 'Show the watchdog deadline/status for an exec started at a given time.',
    write: false,
    params: ['startedAtMs', 'timeoutMs'],
  },
  // Conversation <-> runtime adapter.
  {
    name: 'fleet_v28_conversation_attach',
    description: 'Attach a conversation to its runtime (preset limits + budget cap).',
    write: true,
    params: ['conversationId', 'profileId', 'botId'],
  },
  {
    name: 'fleet_v28_conversation_event',
    description: 'Forward a conversation event (message/toolcall/idle/end) to the runtime adapter.',
    write: true,
    params: ['conversationId', 'kind', 'model', 'inputTokens', 'outputTokens', 'resultText', 'healthy'],
  },
  {
    name: 'fleet_v28_conversation_list',
    description: 'List conversations attached to runtimes by the adapter.',
    write: false,
    params: [],
  },
  // Presets per profile.
  {
    name: 'fleet_v28_preset_list',
    description: 'List the built-in runtime/budget presets (small/medium/large).',
    write: false,
    params: [],
  },
  {
    name: 'fleet_v28_preset_get',
    description: 'Show the preset bundle a profile currently resolves to.',
    write: false,
    params: ['profileId'],
  },
  {
    name: 'fleet_v28_preset_set',
    description: 'Set a profile preset (built-in name, or custom with hand-tuned limits + cap).',
    write: true,
    params: ['profileId', 'presetName', 'cpuCores', 'ramMB', 'diskMB', 'timeoutMs', 'idleTimeoutMs', 'maxRestarts', 'capUsd'],
  },
  // Combined dashboard.
  {
    name: 'fleet_v28_dashboard',
    description: 'Build the combined fleet v28 dashboard: runtimes, secrets, budget, presets (plus forecast when a window is given).',
    write: false,
    params: ['profileId', 'windowStart', 'windowEnd', 'horizon'],
  },
];

/** Find a v28 tool by name (undefined when absent). */
export function findFleetV28Tool(name: string): FleetV28ToolDef | undefined {
  return FLEET_V28_TOOLS.find((t) => t.name === name);
}

/** true when every v28 tool name is valid: unique, snake_case, no dots. */
export function fleetV28ToolNamesValid(): boolean {
  const seen = new Set<string>();
  for (const t of FLEET_V28_TOOLS) {
    if (t.name.includes('.')) return false;
    if (!/^[a-z][a-z0-9_]*$/.test(t.name)) return false;
    if (seen.has(t.name)) return false;
    seen.add(t.name);
  }
  return true;
}

/** v28 tools by name prefix (`fleet_v28`). */
export function fleetV28ToolsByGroup(prefix: string): FleetV28ToolDef[] {
  return FLEET_V28_TOOLS.filter((t) => t.name.startsWith(`${prefix}_`));
}

/** v28 tools that write (need approval). */
export function fleetV28WriteTools(): FleetV28ToolDef[] {
  return FLEET_V28_TOOLS.filter((t) => t.write);
}

/** v28 tools that only read. */
export function fleetV28ReadTools(): FleetV28ToolDef[] {
  return FLEET_V28_TOOLS.filter((t) => !t.write);
}

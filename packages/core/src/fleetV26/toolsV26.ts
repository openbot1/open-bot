/**
 * Tools v26 — pure definitions for fleet v26 (v1.39, Team T6).
 *
 * Follows the `fleetV25/toolsV25.ts` pattern: a separate pure
 * registry (this file) that defines each tool (name, description,
 * params, whether it writes) — this module does NOT run tools and
 * does NOT register into the central registry. The runnable tools
 * live in `packages/tools/src/fleetV26Tools.ts`.
 *
 * Naming (snake_case, NO dots — v21/v22 broke `defaultToolFactory`
 * with dotted names, never again). Groups (34 tools):
 * - `fleet_v26_resources_*` — host capacity + allocate/release.
 * - `fleet_v26_bot_*` — bot register/list/lifecycle/remove.
 * - `fleet_v26_health_*` — per-bot + fleet health.
 * - `fleet_v26_block_*` — shared memory blocks (create/attach/
 *   detach/write/read/history).
 * - `fleet_v26_skill_*` — skill pack (list metadata/load body/
 *   match/install).
 * - `fleet_v26_hook_*` — deterministic hooks (list/evaluate/add).
 * - `fleet_v26_plugin_*` — plugin bundles (install/list/enable).
 * - `fleet_v26_mcp_app_*` — MCP Apps (list/CSP).
 * - `fleet_v26_admission_*` — admission policy (evaluate/settings).
 * - `fleet_v26_dashboard` — combined dashboard.
 *
 * Write tools need approval (`write: true`). They never run a model,
 * never spawn a process, and never touch the network.
 */

/** Definition of one v26 tool (pure, JSON-able). */
export interface FleetV26ToolDef {
  /** Tool name, e.g. `fleet_v26_bot_register`. */
  name: string;
  description: string;
  /** true = a write action (needs approval). */
  write: boolean;
  /** Parameter names (for the UI form; no type validation here). */
  params: string[];
}

/** All v26 tools (pure definitions). */
export const FLEET_V26_TOOLS: readonly FleetV26ToolDef[] = [
  // Resources: capacity + allocate/release.
  {
    name: 'fleet_v26_resources_capacity',
    description: 'Show host capacity (CPU/RAM/disk), the host reserve, and what is left for bots.',
    write: false,
    params: [],
  },
  {
    name: 'fleet_v26_resources_allocate',
    description: 'Grant a per-bot CPU/RAM/disk quota (refused when it would exceed what the host can spare).',
    write: true,
    params: ['botId', 'cpuCores', 'ramMB', 'diskMB'],
  },
  {
    name: 'fleet_v26_resources_release',
    description: 'Release a bot quota back to the pool.',
    write: true,
    params: ['botId'],
  },
  // Bots: register/list/lifecycle/remove.
  {
    name: 'fleet_v26_bot_register',
    description: 'Register a bot with the fleet (name, owner, tags, command, restart policy).',
    write: true,
    params: ['id', 'name', 'ownerId', 'tags', 'command', 'cwd', 'maxRestarts', 'restartWindowMs'],
  },
  {
    name: 'fleet_v26_bot_list',
    description: 'List bots, optionally filtered by state or tag.',
    write: false,
    params: ['state', 'tag'],
  },
  {
    name: 'fleet_v26_bot_start',
    description: 'Start a registered, stopped or failed bot (moves it to starting).',
    write: true,
    params: ['id'],
  },
  {
    name: 'fleet_v26_bot_stop',
    description: 'Ask a running, paused or starting bot to stop.',
    write: true,
    params: ['id'],
  },
  {
    name: 'fleet_v26_bot_pause',
    description: 'Pause a running bot.',
    write: true,
    params: ['id'],
  },
  {
    name: 'fleet_v26_bot_resume',
    description: 'Resume a paused bot.',
    write: true,
    params: ['id'],
  },
  {
    name: 'fleet_v26_bot_restart',
    description: 'Restart a failed or stopped bot (honours the restart cap).',
    write: true,
    params: ['id'],
  },
  {
    name: 'fleet_v26_bot_remove',
    description: 'Remove a stopped, registered or failed bot permanently.',
    write: true,
    params: ['id'],
  },
  // Health.
  {
    name: 'fleet_v26_health_check',
    description: 'Check one bot health (heartbeat, state, quota usage, restarts, errors) with a 0-100 score.',
    write: false,
    params: ['id'],
  },
  {
    name: 'fleet_v26_health_summary',
    description: 'Fleet health roll-up: band, counts per band, worst bots, average score.',
    write: false,
    params: [],
  },
  // Shared memory blocks.
  {
    name: 'fleet_v26_block_create',
    description: 'Create a shared memory block (one block, many bots).',
    write: true,
    params: ['id', 'name', 'title', 'text', 'createdBy', 'tags'],
  },
  {
    name: 'fleet_v26_block_attach',
    description: 'Attach a bot to a shared block so it reads and writes it.',
    write: true,
    params: ['id', 'botId'],
  },
  {
    name: 'fleet_v26_block_detach',
    description: 'Detach a bot from a shared block.',
    write: true,
    params: ['id', 'botId'],
  },
  {
    name: 'fleet_v26_block_write',
    description: 'Write a shared block (needs the current version; stale writers are refused).',
    write: true,
    params: ['id', 'text', 'byBotId', 'expectedVersion', 'reason'],
  },
  {
    name: 'fleet_v26_block_read',
    description: 'Read a shared block (current text, version, attached bots, lease).',
    write: false,
    params: ['id'],
  },
  {
    name: 'fleet_v26_block_history',
    description: 'Show a shared block version history (who wrote what, when).',
    write: false,
    params: ['id'],
  },
  // Skill pack.
  {
    name: 'fleet_v26_skill_list',
    description: 'List skill-pack metadata only (tier 1: name + description, ~100 tokens each).',
    write: false,
    params: [],
  },
  {
    name: 'fleet_v26_skill_load',
    description: 'Load one skill body on demand (tier 2, under 5k tokens).',
    write: false,
    params: ['name'],
  },
  {
    name: 'fleet_v26_skill_match',
    description: 'Match a request against skill metadata (tier 1 only — bodies are never read).',
    write: false,
    params: ['request', 'limit'],
  },
  {
    name: 'fleet_v26_skill_install',
    description: 'Install a skill from SKILL.md text (validates the token budgets).',
    write: true,
    params: ['markdown', 'name'],
  },
  // Hooks.
  {
    name: 'fleet_v26_hook_list',
    description: 'List deterministic hooks (PreToolUse / PostToolUse / Stop) with their actions.',
    write: false,
    params: ['event'],
  },
  {
    name: 'fleet_v26_hook_evaluate',
    description: 'Evaluate hooks for one event + tool (first deny wins) and log the decision.',
    write: false,
    params: ['event', 'toolName', 'botId', 'botTags'],
  },
  {
    name: 'fleet_v26_hook_add',
    description: 'Add a deterministic hook (event, tool glob, action, message, priority).',
    write: true,
    params: ['id', 'event', 'toolPattern', 'botTag', 'action', 'message', 'priority'],
  },
  // Plugins.
  {
    name: 'fleet_v26_plugin_install',
    description: 'Install a plugin bundle (checksum + dependency + skill checks; never runs anything).',
    write: true,
    params: ['bundle'],
  },
  {
    name: 'fleet_v26_plugin_list',
    description: 'List installed plugin bundles with their skills, hooks and MCP servers.',
    write: false,
    params: [],
  },
  {
    name: 'fleet_v26_plugin_set_enabled',
    description: 'Enable or disable a plugin bundle as a unit (disables its hooks too).',
    write: true,
    params: ['id', 'enabled'],
  },
  // MCP Apps.
  {
    name: 'fleet_v26_mcp_app_list',
    description: 'List registered MCP App (ui://) resources with their declared domains.',
    write: false,
    params: ['serverId'],
  },
  {
    name: 'fleet_v26_mcp_app_csp',
    description: 'Show the Content Security Policy built for one MCP App resource.',
    write: false,
    params: ['uri'],
  },
  // Admission.
  {
    name: 'fleet_v26_admission_evaluate',
    description: 'Evaluate admission for one piece of content (memory fact, app, skill, plugin).',
    write: false,
    params: ['source', 'text', 'evidence', 'offeredBy'],
  },
  {
    name: 'fleet_v26_admission_settings',
    description: 'Show the admission policy (default action, per-source rules, evidence rule, caps).',
    write: false,
    params: [],
  },
  // Combined dashboard.
  {
    name: 'fleet_v26_dashboard',
    description: 'Build the combined fleet v26 dashboard: resources, bots, health, shared blocks, skills, hooks, plugins, MCP Apps, admission.',
    write: false,
    params: [],
  },
];

/** Find a v26 tool by name (undefined when absent). */
export function findFleetV26Tool(name: string): FleetV26ToolDef | undefined {
  return FLEET_V26_TOOLS.find((t) => t.name === name);
}

/** true when every v26 tool name is valid: unique, snake_case, no dots. */
export function fleetV26ToolNamesValid(): boolean {
  const seen = new Set<string>();
  for (const t of FLEET_V26_TOOLS) {
    if (t.name.includes('.')) return false;
    if (!/^[a-z][a-z0-9_]*$/.test(t.name)) return false;
    if (seen.has(t.name)) return false;
    seen.add(t.name);
  }
  return true;
}

/** v26 tools by name prefix (`fleet_v26`). */
export function fleetV26ToolsByGroup(prefix: string): FleetV26ToolDef[] {
  return FLEET_V26_TOOLS.filter((t) => t.name.startsWith(`${prefix}_`));
}

/** v26 tools that write (need approval). */
export function fleetV26WriteTools(): FleetV26ToolDef[] {
  return FLEET_V26_TOOLS.filter((t) => t.write);
}

/** v26 tools that only read. */
export function fleetV26ReadTools(): FleetV26ToolDef[] {
  return FLEET_V26_TOOLS.filter((t) => !t.write);
}

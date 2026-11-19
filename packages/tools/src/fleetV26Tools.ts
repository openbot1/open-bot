/**
 * Fleet v26 tools (v1.39, Team T6) — registered in ALL_TOOLS (see tools.ts).
 *
 * Runnable tools for fleet v26 (pure definitions live in
 * `packages/core/src/fleetV26/toolsV26.ts` — 34 tools, 10 groups; this
 * file is the runnable version, wired to core via `@open-bot/core`):
 *
 * - `fleet_v26_resources_*` — host capacity + per-bot quota allocate/release.
 * - `fleet_v26_bot_*` — bot register/list/start/stop/pause/resume/restart/remove.
 * - `fleet_v26_health_*` — per-bot health check + fleet summary.
 * - `fleet_v26_block_*` — shared memory blocks (create/attach/detach/write/read/history).
 * - `fleet_v26_skill_*` — skill pack (list metadata/load body/match/install).
 * - `fleet_v26_hook_*` — deterministic hooks (list/evaluate/add).
 * - `fleet_v26_plugin_*` — plugin bundles (install/list/enable).
 * - `fleet_v26_mcp_app_*` — MCP Apps (list/CSP).
 * - `fleet_v26_admission_*` — admission policy (evaluate/settings).
 * - `fleet_v26_dashboard` — combined dashboard.
 *
 * Like fleet v25, this is a placeholder in ALL_TOOLS until the host
 * binds: `createFleetV26Tools(getState)` with the host's state
 * (resource allocator + bot registry + skill pack + hook registry +
 * plugin registry + MCP Apps registry + admission store + shared
 * blocks + MemFS snapshot). Unbound, tools return a clear "not
 * configured" message instead of guessing state. Write tools need
 * approval (`needsApproval: true`). Tools never run a model, never
 * spawn a process, and never touch the network.
 */

import type { Tool } from '@open-bot/core';
import {
  FleetV26AdmissionStore,
  FleetV26BotRegistry,
  FleetV26HookRegistry,
  FleetV26McpAppRegistry,
  FleetV26PluginRegistry,
  FleetV26ResourceAllocator,
  FleetV26SharedBlockRegistry,
  FleetV26SkillPack,
  buildFleetV26Dashboard,
  buildFleetV26HealthPanel,
  checkFleetV26BotHealth,
  checkFleetV26FleetHealth,
  checksumFleetV26PluginBundle,
  probeFleetV26HostCapacity,
} from '@open-bot/core';
import type {
  FleetV26AdmissionSource,
  FleetV26BotUsage,
  FleetV26HookEvent,
  FleetV26MemFsNode,
  FleetV26PluginBundle,
} from '@open-bot/core';

/** State fleet v26 host provides for the tools (resolved lazily per call). */
export interface FleetV26ToolState {
  /** Resource allocator (host holds 1 instance). */
  allocator: FleetV26ResourceAllocator;
  /** Bot registry (host holds 1 instance). */
  bots: FleetV26BotRegistry;
  /** Shared-block registry (host holds 1 instance). */
  blocks: FleetV26SharedBlockRegistry;
  /** Skill pack (host holds 1 instance). */
  skills: FleetV26SkillPack;
  /** Hook registry (host holds 1 instance). */
  hooks: FleetV26HookRegistry;
  /** Plugin registry (host holds 1 instance). */
  plugins: FleetV26PluginRegistry;
  /** MCP Apps registry (host holds 1 instance). */
  mcpApps: FleetV26McpAppRegistry;
  /** Admission store (host holds 1 instance). */
  admission: FleetV26AdmissionStore;
  /** MemFS snapshot the host hands the memory panel (empty = no memory wired). */
  memFsNodes: FleetV26MemFsNode[];
  /** Host-reported usage by bot id (for health checks). */
  usageByBot: Map<string, FleetV26BotUsage>;
}

export const FLEET_V26_TOOL_NAMES = [
  'fleet_v26_resources_capacity',
  'fleet_v26_resources_allocate',
  'fleet_v26_resources_release',
  'fleet_v26_bot_register',
  'fleet_v26_bot_list',
  'fleet_v26_bot_start',
  'fleet_v26_bot_stop',
  'fleet_v26_bot_pause',
  'fleet_v26_bot_resume',
  'fleet_v26_bot_restart',
  'fleet_v26_bot_remove',
  'fleet_v26_health_check',
  'fleet_v26_health_summary',
  'fleet_v26_block_create',
  'fleet_v26_block_attach',
  'fleet_v26_block_detach',
  'fleet_v26_block_write',
  'fleet_v26_block_read',
  'fleet_v26_block_history',
  'fleet_v26_skill_list',
  'fleet_v26_skill_load',
  'fleet_v26_skill_match',
  'fleet_v26_skill_install',
  'fleet_v26_hook_list',
  'fleet_v26_hook_evaluate',
  'fleet_v26_hook_add',
  'fleet_v26_plugin_install',
  'fleet_v26_plugin_list',
  'fleet_v26_plugin_set_enabled',
  'fleet_v26_mcp_app_list',
  'fleet_v26_mcp_app_csp',
  'fleet_v26_admission_evaluate',
  'fleet_v26_admission_settings',
  'fleet_v26_dashboard',
] as const;

const NOT_WIRED =
  'Fleet v26 is not configured: the host has not wired fleet state (resource allocator, bot registry, shared blocks, skill pack, hook registry, plugin registry, MCP Apps registry, admission store) into the v26 tools.';

function toolDef(
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[],
): Tool['definition'] {
  return {
    name,
    description,
    parameters: { type: 'object', properties, required, additionalProperties: false },
  };
}

function errorResult(message: string): string {
  return `Error: ${message}`;
}

function jsonResult(value: unknown): string {
  return JSON.stringify(value, null, 2).slice(0, 20000);
}

function getStringArg(args: Record<string, unknown>, name: string, required = true): string {
  const value = args[name];
  if (value === undefined || value === null) {
    if (required) throw new Error(`Missing required argument: "${name}"`);
    return '';
  }
  if (typeof value !== 'string') {
    throw new Error(`Argument "${name}" must be a string, got ${typeof value}`);
  }
  return value;
}

function getOptionalStringArg(args: Record<string, unknown>, name: string): string | null {
  const value = args[name];
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') {
    throw new Error(`Argument "${name}" must be a string, got ${typeof value}`);
  }
  return value.trim() ? value : null;
}

function getNumberArg(args: Record<string, unknown>, name: string, fallback: number): number {
  const value = args[name];
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`Argument "${name}" must be a number >= 0.`);
  }
  return value;
}

function getBooleanArg(args: Record<string, unknown>, name: string, fallback = false): boolean {
  const value = args[name];
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'boolean') {
    throw new Error(`Argument "${name}" must be a boolean.`);
  }
  return value;
}

function getStringArrayArg(args: Record<string, unknown>, name: string): string[] {
  const value = args[name];
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
    throw new Error(`Argument "${name}" must be an array of strings.`);
  }
  return value as string[];
}

/** Parse an object argument (object, or a JSON string of one). */
function getObjectArg(args: Record<string, unknown>, name: string): Record<string, unknown> {
  const value = args[name];
  if (value === undefined || value === null) throw new Error(`Missing required argument: "${name}"`);
  let parsed: unknown = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value);
    } catch {
      throw new Error(`Argument "${name}" must be an object or a JSON string of one.`);
    }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Argument "${name}" must be an object.`);
  }
  return parsed as Record<string, unknown>;
}

/** Build an empty state for hosts without their own state (tests + demo). */
export function createEmptyFleetV26ToolState(): FleetV26ToolState {
  return {
    allocator: new FleetV26ResourceAllocator(probeFleetV26HostCapacity()),
    bots: new FleetV26BotRegistry(),
    blocks: new FleetV26SharedBlockRegistry(),
    skills: new FleetV26SkillPack(),
    hooks: new FleetV26HookRegistry(),
    plugins: new FleetV26PluginRegistry(),
    mcpApps: new FleetV26McpAppRegistry(),
    admission: new FleetV26AdmissionStore(),
    memFsNodes: [],
    usageByBot: new Map<string, FleetV26BotUsage>(),
  };
}

/** true when every runnable v26 tool name is unique. */
export function fleetV26ToolNamesUnique(): boolean {
  return new Set(FLEET_V26_TOOL_NAMES).size === FLEET_V26_TOOL_NAMES.length;
}

export function createFleetV26Tools(
  getState?: () => FleetV26ToolState | null | undefined,
): Tool[] {
  const resolveState = (): FleetV26ToolState | null => {
    try {
      return getState?.() ?? null;
    } catch {
      return null;
    }
  };

  const requireState = (): FleetV26ToolState => {
    const state = resolveState();
    if (!state) throw new Error(NOT_WIRED);
    return state;
  };

  const nowMs = (): number => Date.now();

  const tools: Tool[] = [
    // -- resources ----------------------------------------------------------
    {
      definition: toolDef(
        'fleet_v26_resources_capacity',
        'Show host capacity (CPU/RAM/disk), the host reserve, and what is left for bots.',
        {},
        [],
      ),
      needsApproval: false,
      execute: async () => {
        try {
          const state = requireState();
          return jsonResult({
            capacity: state.allocator.getCapacity(),
            reserve: state.allocator.getReserve(),
            remaining: state.allocator.remaining(),
            granted: state.allocator.grantedTotals(),
            utilization: state.allocator.utilization(),
            quotas: state.allocator.list(),
          });
        } catch (err) {
          return errorResult(err instanceof Error ? err.message : String(err));
        }
      },
    },
    {
      definition: toolDef(
        'fleet_v26_resources_allocate',
        'Grant a per-bot CPU/RAM/disk quota (refused when it would exceed what the host can spare).',
        {
          botId: { type: 'string' },
          cpuCores: { type: 'number' },
          ramMB: { type: 'number' },
          diskMB: { type: 'number' },
        },
        ['botId'],
      ),
      needsApproval: true,
      execute: async (args) => {
        try {
          const state = requireState();
          const decision = state.allocator.allocate(
            {
              botId: getStringArg(args, 'botId'),
              cpuCores: getNumberArg(args, 'cpuCores', 0),
              ramMB: getNumberArg(args, 'ramMB', 0),
              diskMB: getNumberArg(args, 'diskMB', 0),
            },
            nowMs(),
          );
          if (decision.admitted) {
            const quota = state.allocator.get(decision.botId);
            if (quota) state.bots.attachQuota(decision.botId, quota, nowMs());
          }
          return jsonResult(decision);
        } catch (err) {
          return errorResult(err instanceof Error ? err.message : String(err));
        }
      },
    },
    {
      definition: toolDef(
        'fleet_v26_resources_release',
        'Release a bot quota back to the pool.',
        { botId: { type: 'string' } },
        ['botId'],
      ),
      needsApproval: true,
      execute: async (args) => {
        try {
          const state = requireState();
          const botId = getStringArg(args, 'botId');
          const released = state.allocator.release(botId);
          state.bots.detachQuota(botId, nowMs());
          return jsonResult({ botId, released, remaining: state.allocator.remaining() });
        } catch (err) {
          return errorResult(err instanceof Error ? err.message : String(err));
        }
      },
    },
    // -- bots ---------------------------------------------------------------
    {
      definition: toolDef(
        'fleet_v26_bot_register',
        'Register a bot with the fleet (name, owner, tags, command, restart policy).',
        {
          id: { type: 'string' },
          name: { type: 'string' },
          ownerId: { type: 'string' },
          tags: { type: 'array', items: { type: 'string' } },
          command: { type: 'string' },
          cwd: { type: 'string' },
          maxRestarts: { type: 'number' },
          restartWindowMs: { type: 'number' },
        },
        ['id'],
      ),
      needsApproval: true,
      execute: async (args) => {
        try {
          const state = requireState();
          const op = state.bots.register(
            {
              id: getStringArg(args, 'id'),
              name: getOptionalStringArg(args, 'name') ?? undefined,
              ownerId: getOptionalStringArg(args, 'ownerId'),
              tags: getStringArrayArg(args, 'tags'),
              command: getOptionalStringArg(args, 'command') ?? '',
              cwd: getOptionalStringArg(args, 'cwd'),
              maxRestarts: args['maxRestarts'] === undefined ? undefined : getNumberArg(args, 'maxRestarts', 3),
              restartWindowMs: args['restartWindowMs'] === undefined ? undefined : getNumberArg(args, 'restartWindowMs', 600000),
            },
            nowMs(),
          );
          return jsonResult(op);
        } catch (err) {
          return errorResult(err instanceof Error ? err.message : String(err));
        }
      },
    },
    {
      definition: toolDef(
        'fleet_v26_bot_list',
        'List bots, optionally filtered by state or tag.',
        {
          state: { type: 'string' },
          tag: { type: 'string' },
        },
        [],
      ),
      needsApproval: false,
      execute: async (args) => {
        try {
          const state = requireState();
          const byState = getOptionalStringArg(args, 'state');
          const tag = getOptionalStringArg(args, 'tag');
          let bots = state.bots.list();
          if (byState) bots = bots.filter((b) => b.state === byState);
          if (tag) bots = bots.filter((b) => b.spec.tags.includes(tag));
          return jsonResult({ bots, counts: state.bots.counts() });
        } catch (err) {
          return errorResult(err instanceof Error ? err.message : String(err));
        }
      },
    },
    ...(['start', 'stop', 'pause', 'resume', 'restart', 'remove'] as const).map((verb) => ({
      definition: toolDef(
        `fleet_v26_bot_${verb}`,
        verb === 'start'
          ? 'Start a registered, stopped or failed bot (moves it to starting).'
          : verb === 'stop'
            ? 'Ask a running, paused or starting bot to stop.'
            : verb === 'pause'
              ? 'Pause a running bot.'
              : verb === 'resume'
                ? 'Resume a paused bot.'
                : verb === 'restart'
                  ? 'Restart a failed or stopped bot (honours the restart cap).'
                  : 'Remove a stopped, registered or failed bot permanently.',
        { id: { type: 'string' } },
        ['id'],
      ),
      needsApproval: true,
      execute: async (args: Record<string, unknown>) => {
        try {
          const state = requireState();
          const id = getStringArg(args, 'id');
          const op = state.bots[verb](id, nowMs());
          if (verb === 'remove' && op.ok) {
            state.allocator.release(id);
            state.usageByBot.delete(id);
          }
          return jsonResult(op);
        } catch (err) {
          return errorResult(err instanceof Error ? err.message : String(err));
        }
      },
    })),
    // -- health -------------------------------------------------------------
    {
      definition: toolDef(
        'fleet_v26_health_check',
        'Check one bot health (heartbeat, state, quota usage, restarts, errors) with a 0-100 score.',
        { id: { type: 'string' } },
        ['id'],
      ),
      needsApproval: false,
      execute: async (args) => {
        try {
          const state = requireState();
          const bot = state.bots.get(getStringArg(args, 'id'));
          if (!bot) return errorResult(`Bot "${getStringArg(args, 'id')}" is not registered.`);
          return jsonResult(checkFleetV26BotHealth(bot, state.usageByBot.get(bot.spec.id) ?? null, nowMs()));
        } catch (err) {
          return errorResult(err instanceof Error ? err.message : String(err));
        }
      },
    },
    {
      definition: toolDef(
        'fleet_v26_health_summary',
        'Fleet health roll-up: band, counts per band, worst bots, average score.',
        {},
        [],
      ),
      needsApproval: false,
      execute: async () => {
        try {
          const state = requireState();
          const health = checkFleetV26FleetHealth(state.bots, state.usageByBot, nowMs());
          return jsonResult(buildFleetV26HealthPanel(health));
        } catch (err) {
          return errorResult(err instanceof Error ? err.message : String(err));
        }
      },
    },
    // -- shared blocks --------------------------------------------------------
    {
      definition: toolDef(
        'fleet_v26_block_create',
        'Create a shared memory block (one block, many bots).',
        {
          id: { type: 'string' },
          name: { type: 'string' },
          title: { type: 'string' },
          text: { type: 'string' },
          createdBy: { type: 'string' },
          tags: { type: 'array', items: { type: 'string' } },
        },
        ['id'],
      ),
      needsApproval: true,
      execute: async (args) => {
        try {
          const state = requireState();
          return jsonResult(
            state.blocks.create(
              {
                id: getStringArg(args, 'id'),
                name: getOptionalStringArg(args, 'name') ?? undefined,
                title: getOptionalStringArg(args, 'title') ?? undefined,
                text: getOptionalStringArg(args, 'text') ?? '',
                createdBy: getOptionalStringArg(args, 'createdBy') ?? 'operator',
                tags: getStringArrayArg(args, 'tags'),
              },
              nowMs(),
            ),
          );
        } catch (err) {
          return errorResult(err instanceof Error ? err.message : String(err));
        }
      },
    },
    {
      definition: toolDef(
        'fleet_v26_block_attach',
        'Attach a bot to a shared block so it reads and writes it.',
        {
          id: { type: 'string' },
          botId: { type: 'string' },
        },
        ['id', 'botId'],
      ),
      needsApproval: true,
      execute: async (args) => {
        try {
          const state = requireState();
          return jsonResult(state.blocks.attach(getStringArg(args, 'id'), getStringArg(args, 'botId'), state.bots));
        } catch (err) {
          return errorResult(err instanceof Error ? err.message : String(err));
        }
      },
    },
    {
      definition: toolDef(
        'fleet_v26_block_detach',
        'Detach a bot from a shared block.',
        {
          id: { type: 'string' },
          botId: { type: 'string' },
        },
        ['id', 'botId'],
      ),
      needsApproval: true,
      execute: async (args) => {
        try {
          const state = requireState();
          return jsonResult(state.blocks.detach(getStringArg(args, 'id'), getStringArg(args, 'botId')));
        } catch (err) {
          return errorResult(err instanceof Error ? err.message : String(err));
        }
      },
    },
    {
      definition: toolDef(
        'fleet_v26_block_write',
        'Write a shared block (needs the current version; stale writers are refused).',
        {
          id: { type: 'string' },
          text: { type: 'string' },
          byBotId: { type: 'string' },
          expectedVersion: { type: 'number' },
          reason: { type: 'string' },
        },
        ['id', 'text', 'byBotId', 'expectedVersion'],
      ),
      needsApproval: true,
      execute: async (args) => {
        try {
          const state = requireState();
          return jsonResult(
            state.blocks.write(
              getStringArg(args, 'id'),
              {
                text: getStringArg(args, 'text'),
                byBotId: getStringArg(args, 'byBotId'),
                expectedVersion: getNumberArg(args, 'expectedVersion', 0),
                reason: getOptionalStringArg(args, 'reason'),
              },
              nowMs(),
            ),
          );
        } catch (err) {
          return errorResult(err instanceof Error ? err.message : String(err));
        }
      },
    },
    {
      definition: toolDef(
        'fleet_v26_block_read',
        'Read a shared block (current text, version, attached bots, lease).',
        { id: { type: 'string' } },
        ['id'],
      ),
      needsApproval: false,
      execute: async (args) => {
        try {
          const state = requireState();
          return jsonResult(state.blocks.read(getStringArg(args, 'id')));
        } catch (err) {
          return errorResult(err instanceof Error ? err.message : String(err));
        }
      },
    },
    {
      definition: toolDef(
        'fleet_v26_block_history',
        'Show a shared block version history (who wrote what, when).',
        { id: { type: 'string' } },
        ['id'],
      ),
      needsApproval: false,
      execute: async (args) => {
        try {
          const state = requireState();
          const id = getStringArg(args, 'id');
          return jsonResult({ blockId: id, history: state.blocks.history(id) });
        } catch (err) {
          return errorResult(err instanceof Error ? err.message : String(err));
        }
      },
    },
    // -- skill pack -----------------------------------------------------------
    {
      definition: toolDef(
        'fleet_v26_skill_list',
        'List skill-pack metadata only (tier 1: name + description, ~100 tokens each).',
        {},
        [],
      ),
      needsApproval: false,
      execute: async () => {
        try {
          const state = requireState();
          return jsonResult({ metadata: state.skills.listMetadata(), counts: state.skills.counts() });
        } catch (err) {
          return errorResult(err instanceof Error ? err.message : String(err));
        }
      },
    },
    {
      definition: toolDef(
        'fleet_v26_skill_load',
        'Load one skill body on demand (tier 2, under 5k tokens).',
        { name: { type: 'string' } },
        ['name'],
      ),
      needsApproval: false,
      execute: async (args) => {
        try {
          const state = requireState();
          return jsonResult(state.skills.loadBody(getStringArg(args, 'name')));
        } catch (err) {
          return errorResult(err instanceof Error ? err.message : String(err));
        }
      },
    },
    {
      definition: toolDef(
        'fleet_v26_skill_match',
        'Match a request against skill metadata (tier 1 only — bodies are never read).',
        {
          request: { type: 'string' },
          limit: { type: 'number' },
        },
        ['request'],
      ),
      needsApproval: false,
      execute: async (args) => {
        try {
          const state = requireState();
          return jsonResult({
            matches: state.skills.match(getStringArg(args, 'request'), getNumberArg(args, 'limit', 5)),
          });
        } catch (err) {
          return errorResult(err instanceof Error ? err.message : String(err));
        }
      },
    },
    {
      definition: toolDef(
        'fleet_v26_skill_install',
        'Install a skill from SKILL.md text (validates the token budgets).',
        {
          markdown: { type: 'string' },
          name: { type: 'string' },
        },
        ['markdown', 'name'],
      ),
      needsApproval: true,
      execute: async (args) => {
        try {
          const state = requireState();
          return jsonResult(
            state.skills.installFromMd(getStringArg(args, 'markdown'), getStringArg(args, 'name'), [], {}, nowMs()),
          );
        } catch (err) {
          return errorResult(err instanceof Error ? err.message : String(err));
        }
      },
    },
    // -- hooks ---------------------------------------------------------------
    {
      definition: toolDef(
        'fleet_v26_hook_list',
        'List deterministic hooks (PreToolUse / PostToolUse / Stop) with their actions.',
        { event: { type: 'string' } },
        [],
      ),
      needsApproval: false,
      execute: async (args) => {
        try {
          const state = requireState();
          const event = getOptionalStringArg(args, 'event') as FleetV26HookEvent | null;
          const hooks = event ? state.hooks.listForEvent(event) : state.hooks.list();
          return jsonResult({ hooks, counts: state.hooks.counts(), logCounts: state.hooks.logCounts() });
        } catch (err) {
          return errorResult(err instanceof Error ? err.message : String(err));
        }
      },
    },
    {
      definition: toolDef(
        'fleet_v26_hook_evaluate',
        'Evaluate hooks for one event + tool (first deny wins) and log the decision.',
        {
          event: { type: 'string' },
          toolName: { type: 'string' },
          botId: { type: 'string' },
          botTags: { type: 'array', items: { type: 'string' } },
        },
        ['event', 'toolName', 'botId'],
      ),
      needsApproval: false,
      execute: async (args) => {
        try {
          const state = requireState();
          const event = getStringArg(args, 'event') as FleetV26HookEvent;
          if (event !== 'PreToolUse' && event !== 'PostToolUse' && event !== 'Stop') {
            throw new Error(`Unknown hook event "${event}".`);
          }
          return jsonResult(
            state.hooks.evaluate(
              {
                event,
                toolName: getStringArg(args, 'toolName'),
                botId: getStringArg(args, 'botId'),
                botTags: getStringArrayArg(args, 'botTags'),
              },
              nowMs(),
            ),
          );
        } catch (err) {
          return errorResult(err instanceof Error ? err.message : String(err));
        }
      },
    },
    {
      definition: toolDef(
        'fleet_v26_hook_add',
        'Add a deterministic hook (event, tool glob, action, message, priority).',
        {
          id: { type: 'string' },
          event: { type: 'string' },
          toolPattern: { type: 'string' },
          botTag: { type: 'string' },
          action: { type: 'string' },
          message: { type: 'string' },
          priority: { type: 'number' },
        },
        ['id', 'event', 'action'],
      ),
      needsApproval: true,
      execute: async (args) => {
        try {
          const state = requireState();
          const event = getStringArg(args, 'event') as FleetV26HookEvent;
          const action = getStringArg(args, 'action') as 'allow' | 'deny' | 'ask';
          return jsonResult(
            state.hooks.add(
              {
                id: getStringArg(args, 'id'),
                event,
                toolPattern: getOptionalStringArg(args, 'toolPattern') ?? '*',
                botTag: getOptionalStringArg(args, 'botTag'),
                action,
                message: getOptionalStringArg(args, 'message') ?? '',
                priority: args['priority'] === undefined ? undefined : getNumberArg(args, 'priority', 100),
              },
              nowMs(),
            ),
          );
        } catch (err) {
          return errorResult(err instanceof Error ? err.message : String(err));
        }
      },
    },
    // -- plugins --------------------------------------------------------------
    {
      definition: toolDef(
        'fleet_v26_plugin_install',
        'Install a plugin bundle (checksum + dependency + skill checks; never runs anything).',
        { bundle: { type: 'object' } },
        ['bundle'],
      ),
      needsApproval: true,
      execute: async (args) => {
        try {
          const state = requireState();
          const raw = getObjectArg(args, 'bundle');
          const bundle = raw as unknown as FleetV26PluginBundle;
          // Recompute the checksum when the caller omitted it (demo bundles):
          // a caller-supplied checksum is always verified, never overwritten.
          if (typeof bundle.checksum !== 'string' || !bundle.checksum) {
            bundle.checksum = checksumFleetV26PluginBundle(bundle);
          }
          return jsonResult(state.plugins.install(bundle, { skills: state.skills, hooks: state.hooks }, {}, nowMs()));
        } catch (err) {
          return errorResult(err instanceof Error ? err.message : String(err));
        }
      },
    },
    {
      definition: toolDef(
        'fleet_v26_plugin_list',
        'List installed plugin bundles with their skills, hooks and MCP servers.',
        {},
        [],
      ),
      needsApproval: false,
      execute: async () => {
        try {
          const state = requireState();
          return jsonResult({ plugins: state.plugins.list(), counts: state.plugins.counts() });
        } catch (err) {
          return errorResult(err instanceof Error ? err.message : String(err));
        }
      },
    },
    {
      definition: toolDef(
        'fleet_v26_plugin_set_enabled',
        'Enable or disable a plugin bundle as a unit (disables its hooks too).',
        {
          id: { type: 'string' },
          enabled: { type: 'boolean' },
        },
        ['id', 'enabled'],
      ),
      needsApproval: true,
      execute: async (args) => {
        try {
          const state = requireState();
          return jsonResult(
            state.plugins.setEnabled(getStringArg(args, 'id'), getBooleanArg(args, 'enabled'), state.hooks),
          );
        } catch (err) {
          return errorResult(err instanceof Error ? err.message : String(err));
        }
      },
    },
    // -- MCP Apps -------------------------------------------------------------
    {
      definition: toolDef(
        'fleet_v26_mcp_app_list',
        'List registered MCP App (ui://) resources with their declared domains.',
        { serverId: { type: 'string' } },
        [],
      ),
      needsApproval: false,
      execute: async (args) => {
        try {
          const state = requireState();
          const serverId = getOptionalStringArg(args, 'serverId');
          const apps = serverId ? state.mcpApps.listByServer(serverId) : state.mcpApps.list();
          return jsonResult({ apps, counts: state.mcpApps.counts(), settings: state.mcpApps.getSettings() });
        } catch (err) {
          return errorResult(err instanceof Error ? err.message : String(err));
        }
      },
    },
    {
      definition: toolDef(
        'fleet_v26_mcp_app_csp',
        'Show the Content Security Policy built for one MCP App resource.',
        { uri: { type: 'string' } },
        ['uri'],
      ),
      needsApproval: false,
      execute: async (args) => {
        try {
          const state = requireState();
          const uri = getStringArg(args, 'uri');
          const csp = state.mcpApps.cspFor(uri);
          if (csp === null) return errorResult(`App resource "${uri}" is not registered.`);
          return jsonResult({ uri, csp, decision: state.mcpApps.renderDecision(uri) });
        } catch (err) {
          return errorResult(err instanceof Error ? err.message : String(err));
        }
      },
    },
    // -- admission ------------------------------------------------------------
    {
      definition: toolDef(
        'fleet_v26_admission_evaluate',
        'Evaluate admission for one piece of content (memory fact, app, skill, plugin).',
        {
          source: { type: 'string' },
          text: { type: 'string' },
          evidence: { type: 'string' },
          offeredBy: { type: 'string' },
        },
        ['source', 'text'],
      ),
      needsApproval: false,
      execute: async (args) => {
        try {
          const state = requireState();
          const source = getStringArg(args, 'source') as FleetV26AdmissionSource;
          if (!['memory-v24', 'mcp-app', 'skill-pack', 'plugin', 'operator'].includes(source)) {
            throw new Error(`Unknown admission source "${source}".`);
          }
          return jsonResult(
            state.admission.evaluate(
              {
                source,
                text: getStringArg(args, 'text'),
                evidence: getOptionalStringArg(args, 'evidence'),
                offeredBy: getOptionalStringArg(args, 'offeredBy') ?? 'operator',
              },
              nowMs(),
            ),
          );
        } catch (err) {
          return errorResult(err instanceof Error ? err.message : String(err));
        }
      },
    },
    {
      definition: toolDef(
        'fleet_v26_admission_settings',
        'Show the admission policy (default action, per-source rules, evidence rule, caps).',
        {},
        [],
      ),
      needsApproval: false,
      execute: async () => {
        try {
          const state = requireState();
          return jsonResult({ policy: state.admission.getPolicy(), counts: state.admission.counts() });
        } catch (err) {
          return errorResult(err instanceof Error ? err.message : String(err));
        }
      },
    },
    // -- dashboard ------------------------------------------------------------
    {
      definition: toolDef(
        'fleet_v26_dashboard',
        'Build the combined fleet v26 dashboard (resources, bots, health, shared blocks, skills, hooks, plugins, MCP Apps, memory, settings).',
        {},
        [],
      ),
      needsApproval: false,
      execute: async () => {
        try {
          const state = requireState();
          return jsonResult(
            buildFleetV26Dashboard({
              allocator: state.allocator,
              bots: state.bots,
              health: checkFleetV26FleetHealth(state.bots, state.usageByBot, nowMs()),
              sharedBlocks: state.blocks,
              skills: state.skills,
              hooks: state.hooks,
              plugins: state.plugins,
              mcpApps: state.mcpApps,
              memFsNodes: state.memFsNodes,
              admission: state.admission,
              nowMs: nowMs(),
            }),
          );
        } catch (err) {
          return errorResult(err instanceof Error ? err.message : String(err));
        }
      },
    },
  ];

  return tools;
}

/** The runnable v26 tools, for ALL_TOOLS (unbound until the host wires state). */
export const FLEET_V26_TOOLS: Tool[] = createFleetV26Tools();

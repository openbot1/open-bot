/**
 * Fleet v28 tools (v1.41, Team T6) — registered in ALL_TOOLS (see tools.ts).
 *
 * Runnable tools for fleet v28 (pure definitions live in
 * `packages/core/src/fleetV28/toolsV28.ts` — 40 tools, 8 groups; this
 * file is the runnable version, wired to core via `@open-bot/core`):
 *
 * - `fleet_v28_runtime_*` — per-conversation sandbox runtime
 *   (start/list/get/stop/restart/limits/set-limits/usage/
 *   evict-idle/health/probe).
 * - `fleet_v28_secret_*` — profile-scoped secrets (set/get/list/
 *   delete/rotate/redact/audit). `secret_get` returns the value only
 *   to the owning profile; listings and audit entries never carry
 *   values.
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
 * Like fleet v27, this is a placeholder in ALL_TOOLS until the host
 * binds: `createFleetV28Tools(getState)` with the host's state
 * (runtime store + secret store + budget store + preset store).
 * Unbound, tools return a clear "not configured" message instead of
 * guessing state. Write tools need approval (`needsApproval: true`).
 * Tools never run a model, never spawn a process, and never touch
 * the network.
 */

import type { Tool } from '@open-bot/core';
import {
  FleetV28BudgetStore,
  FleetV28ConversationAdapter,
  FleetV28PresetStore,
  FleetV28RuntimeStore,
  FleetV28SecretStore,
  FLEET_V28_DEFAULT_RUNTIME_LIMITS,
  breakdownFleetV28ByModel,
  buildFleetV28Dashboard,
  checkFleetV28WorkspacePath,
  computeFleetV28BurnRate,
  defaultFleetV28SandboxPolicy,
  deriveFleetV28CgroupLimits,
  fleetV28DayOf,
  forecastFleetV28Spend,
  listFleetV28Presets,
  resolveFleetV28RuntimeLimits,
  validateFleetV28ExecRequest,
  watchdogStatus,
  type FleetV28RuntimeState,
} from '@open-bot/core';

/** State fleet v28 host provides for the tools (resolved lazily per call). */
export interface FleetV28ToolState {
  /** Per-conversation runtime store (host holds 1 instance). */
  runtimes: FleetV28RuntimeStore;
  /** Profile-scoped secret store (host holds 1 instance). */
  secrets: FleetV28SecretStore;
  /** Conversation budget store (host holds 1 instance). */
  budget: FleetV28BudgetStore;
  /** Per-profile preset store (host holds 1 instance). */
  presets: FleetV28PresetStore;
  /** Conversation adapter (optional: built lazily from the stores when absent). */
  adapter?: FleetV28ConversationAdapter;
}

export const FLEET_V28_TOOL_NAMES = [
  'fleet_v28_runtime_start',
  'fleet_v28_runtime_list',
  'fleet_v28_runtime_get',
  'fleet_v28_runtime_stop',
  'fleet_v28_runtime_restart',
  'fleet_v28_runtime_limits',
  'fleet_v28_runtime_set_limits',
  'fleet_v28_runtime_usage',
  'fleet_v28_runtime_evict_idle',
  'fleet_v28_runtime_health',
  'fleet_v28_runtime_probe',
  'fleet_v28_secret_set',
  'fleet_v28_secret_get',
  'fleet_v28_secret_list',
  'fleet_v28_secret_delete',
  'fleet_v28_secret_rotate',
  'fleet_v28_secret_redact',
  'fleet_v28_secret_audit',
  'fleet_v28_budget_record',
  'fleet_v28_budget_get',
  'fleet_v28_budget_set_cap',
  'fleet_v28_budget_list',
  'fleet_v28_budget_reset',
  'fleet_v28_budget_report_daily',
  'fleet_v28_budget_report_weekly',
  'fleet_v28_budget_alerts',
  'fleet_v28_budget_forecast',
  'fleet_v28_budget_burn_rate',
  'fleet_v28_budget_model_breakdown',
  'fleet_v28_sandbox_policy',
  'fleet_v28_sandbox_validate_path',
  'fleet_v28_sandbox_validate_command',
  'fleet_v28_sandbox_watchdog',
  'fleet_v28_conversation_attach',
  'fleet_v28_conversation_event',
  'fleet_v28_conversation_list',
  'fleet_v28_preset_list',
  'fleet_v28_preset_get',
  'fleet_v28_preset_set',
  'fleet_v28_dashboard',
] as const;

const NOT_WIRED =
  'Fleet v28 is not configured: the host has not wired fleet state (runtime store, secret store, budget store, preset store) into the v28 tools.';

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

function getOptionalNumberArg(args: Record<string, unknown>, name: string): number | null {
  const value = args[name];
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Argument "${name}" must be a number.`);
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

/** Parse a partial runtime-limits object from tool args (only present fields). */
function getLimitsArg(args: Record<string, unknown>): Record<string, number> {
  const limits: Record<string, number> = {};
  for (const key of ['cpuCores', 'ramMB', 'diskMB', 'timeoutMs', 'idleTimeoutMs', 'maxRestarts']) {
    const v = getOptionalNumberArg(args, key);
    if (v !== null) limits[key] = v;
  }
  return limits;
}

/** Build an empty state for hosts without their own state (tests + demo). */
export function createEmptyFleetV28ToolState(): FleetV28ToolState {
  const runtimes = new FleetV28RuntimeStore();
  const secrets = new FleetV28SecretStore();
  const budget = new FleetV28BudgetStore();
  const presets = new FleetV28PresetStore();
  return {
    runtimes,
    secrets,
    budget,
    presets,
    adapter: new FleetV28ConversationAdapter(runtimes, secrets, budget, presets),
  };
}

/** Resolve the conversation adapter for a state (built lazily when absent). */
function getAdapter(state: FleetV28ToolState): FleetV28ConversationAdapter {
  if (!state.adapter) {
    state.adapter = new FleetV28ConversationAdapter(
      state.runtimes,
      state.secrets,
      state.budget,
      state.presets,
    );
  }
  return state.adapter;
}

/** true when every runnable v28 tool name is unique. */
export function fleetV28ToolNamesUnique(): boolean {
  return new Set(FLEET_V28_TOOL_NAMES).size === FLEET_V28_TOOL_NAMES.length;
}

export function createFleetV28Tools(
  getState?: () => FleetV28ToolState | null | undefined,
): Tool[] {
  const resolveState = (): FleetV28ToolState | null => {
    try {
      return getState?.() ?? null;
    } catch {
      return null;
    }
  };

  const requireState = (): FleetV28ToolState => {
    const state = resolveState();
    if (!state) throw new Error(NOT_WIRED);
    return state;
  };

  const nowMs = (): number => Date.now();

  const tools: Tool[] = [
    // -- per-conversation sandbox runtime ---------------------------------
    {
      definition: toolDef(
        'fleet_v28_runtime_start',
        'Start a per-conversation sandbox runtime (limits + concurrency cap; queues when full).',
        {
          conversationId: { type: 'string' },
          profileId: { type: 'string' },
          botId: { type: 'string' },
          cpuCores: { type: 'number' },
          ramMB: { type: 'number' },
          diskMB: { type: 'number' },
          timeoutMs: { type: 'number' },
          idleTimeoutMs: { type: 'number' },
          maxRestarts: { type: 'number' },
        },
        ['conversationId', 'profileId'],
      ),
      needsApproval: true,
      execute: async (args) => {
        try {
          const state = requireState();
          const result = state.runtimes.startRuntime(getStringArg(args, 'conversationId'), getStringArg(args, 'profileId'), {
            botId: getOptionalStringArg(args, 'botId') ?? undefined,
            limits: getLimitsArg(args),
            nowMs: nowMs(),
          });
          if (!result.ok) return errorResult(`Cannot start runtime: ${result.reasons.join(', ')}`);
          return jsonResult(result);
        } catch (err) {
          return errorResult(err instanceof Error ? err.message : String(err));
        }
      },
    },
    {
      definition: toolDef(
        'fleet_v28_runtime_list',
        'List conversation runtimes, optionally filtered by state or profile.',
        {
          state: { type: 'string' },
          profileId: { type: 'string' },
        },
        [],
      ),
      needsApproval: false,
      execute: async (args) => {
        try {
          const state = requireState();
          const stateFilter = getOptionalStringArg(args, 'state');
          const profileId = getOptionalStringArg(args, 'profileId');
          if (stateFilter && !['starting', 'running', 'stopped', 'evicted', 'failed', 'restarting'].includes(stateFilter)) {
            return errorResult(`Unknown runtime state "${stateFilter}".`);
          }
          const runtimes = profileId
            ? state.runtimes.listRuntimesByProfile(profileId)
            : state.runtimes.listRuntimes(stateFilter as FleetV28RuntimeState | undefined);
          return jsonResult({ runtimes });
        } catch (err) {
          return errorResult(err instanceof Error ? err.message : String(err));
        }
      },
    },
    {
      definition: toolDef(
        'fleet_v28_runtime_get',
        'Show one conversation runtime (state, health, limits, usage).',
        { conversationId: { type: 'string' } },
        ['conversationId'],
      ),
      needsApproval: false,
      execute: async (args) => {
        try {
          const state = requireState();
          const runtime = state.runtimes.getRuntime(getStringArg(args, 'conversationId'));
          if (!runtime) return errorResult(`No runtime for conversation "${getStringArg(args, 'conversationId')}".`);
          return jsonResult({ runtime });
        } catch (err) {
          return errorResult(err instanceof Error ? err.message : String(err));
        }
      },
    },
    {
      definition: toolDef(
        'fleet_v28_runtime_stop',
        'Stop a conversation runtime (saves a state snapshot first).',
        { conversationId: { type: 'string' } },
        ['conversationId'],
      ),
      needsApproval: true,
      execute: async (args) => {
        try {
          const state = requireState();
          const runtime = state.runtimes.stopRuntime(getStringArg(args, 'conversationId'), nowMs());
          if (!runtime) return errorResult(`No runtime for conversation "${getStringArg(args, 'conversationId')}".`);
          return jsonResult({ stopped: true, runtime });
        } catch (err) {
          return errorResult(err instanceof Error ? err.message : String(err));
        }
      },
    },
    {
      definition: toolDef(
        'fleet_v28_runtime_restart',
        'Restart a conversation runtime (restores the saved snapshot when present).',
        { conversationId: { type: 'string' } },
        ['conversationId'],
      ),
      needsApproval: true,
      execute: async (args) => {
        try {
          const state = requireState();
          const runtime = state.runtimes.restartRuntime(getStringArg(args, 'conversationId'), nowMs());
          if (!runtime) return errorResult(`No runtime for conversation "${getStringArg(args, 'conversationId')}".`);
          return jsonResult({ restarted: true, runtime });
        } catch (err) {
          return errorResult(err instanceof Error ? err.message : String(err));
        }
      },
    },
    {
      definition: toolDef(
        'fleet_v28_runtime_limits',
        'Show the default runtime limits and the store concurrency config.',
        {},
        [],
      ),
      needsApproval: false,
      execute: async () => {
        try {
          const state = requireState();
          return jsonResult({
            defaultLimits: FLEET_V28_DEFAULT_RUNTIME_LIMITS,
            config: state.runtimes.getConfig(),
            running: state.runtimes.runningCount(),
            queued: state.runtimes.listQueue().length,
          });
        } catch (err) {
          return errorResult(err instanceof Error ? err.message : String(err));
        }
      },
    },
    {
      definition: toolDef(
        'fleet_v28_runtime_set_limits',
        'Set one runtime limits (validated; bad values are refused).',
        {
          conversationId: { type: 'string' },
          cpuCores: { type: 'number' },
          ramMB: { type: 'number' },
          diskMB: { type: 'number' },
          timeoutMs: { type: 'number' },
          idleTimeoutMs: { type: 'number' },
          maxRestarts: { type: 'number' },
        },
        ['conversationId'],
      ),
      needsApproval: true,
      execute: async (args) => {
        try {
          const state = requireState();
          const result = state.runtimes.setLimits(getStringArg(args, 'conversationId'), getLimitsArg(args));
          if (!result.ok) return errorResult(`Cannot set limits: ${(result.reasons ?? []).join(', ')}`);
          return jsonResult({ updated: true, runtime: result.runtime });
        } catch (err) {
          return errorResult(err instanceof Error ? err.message : String(err));
        }
      },
    },
    {
      definition: toolDef(
        'fleet_v28_runtime_usage',
        'Show live usage of one runtime against its limits (with over-limit flags).',
        { conversationId: { type: 'string' } },
        ['conversationId'],
      ),
      needsApproval: false,
      execute: async (args) => {
        try {
          const state = requireState();
          const runtime = state.runtimes.getRuntime(getStringArg(args, 'conversationId'));
          if (!runtime) return errorResult(`No runtime for conversation "${getStringArg(args, 'conversationId')}".`);
          return jsonResult({
            conversationId: runtime.conversationId,
            usage: runtime.usage,
            limits: runtime.limits,
            overLimit: runtime.overLimit,
            aggregate: state.runtimes.aggregateUsage(),
          });
        } catch (err) {
          return errorResult(err instanceof Error ? err.message : String(err));
        }
      },
    },
    {
      definition: toolDef(
        'fleet_v28_runtime_evict_idle',
        'Evict runtimes idle past their idle timeout (saves state, frees slots, promotes the queue).',
        {},
        [],
      ),
      needsApproval: true,
      execute: async () => {
        try {
          const state = requireState();
          const result = state.runtimes.sweepIdle(nowMs());
          return jsonResult({ evicted: result.evicted, promoted: result.promoted, records: result.records });
        } catch (err) {
          return errorResult(err instanceof Error ? err.message : String(err));
        }
      },
    },
    {
      definition: toolDef(
        'fleet_v28_runtime_health',
        'Show health of one runtime (probe state, restarts, failures) or all runtimes.',
        { conversationId: { type: 'string' } },
        [],
      ),
      needsApproval: false,
      execute: async (args) => {
        try {
          const state = requireState();
          const conversationId = getOptionalStringArg(args, 'conversationId');
          if (conversationId) {
            const runtime = state.runtimes.getRuntime(conversationId);
            if (!runtime) return errorResult(`No runtime for conversation "${conversationId}".`);
            return jsonResult({
              conversationId: runtime.conversationId,
              state: runtime.state,
              health: runtime.health,
              restarts: runtime.restarts,
              consecutiveFailures: runtime.consecutiveFailures,
              lastProbeMs: runtime.lastProbeMs,
              failureReason: runtime.failureReason,
            });
          }
          return jsonResult({
            runtimes: state.runtimes.listRuntimes().map((r) => ({
              conversationId: r.conversationId,
              state: r.state,
              health: r.health,
              restarts: r.restarts,
              consecutiveFailures: r.consecutiveFailures,
              lastProbeMs: r.lastProbeMs,
              failureReason: r.failureReason,
            })),
          });
        } catch (err) {
          return errorResult(err instanceof Error ? err.message : String(err));
        }
      },
    },
    {
      definition: toolDef(
        'fleet_v28_runtime_probe',
        'Record a health probe for a runtime (failed probes auto-restart up to maxRestarts).',
        {
          conversationId: { type: 'string' },
          healthy: { type: 'boolean' },
        },
        ['conversationId', 'healthy'],
      ),
      needsApproval: true,
      execute: async (args) => {
        try {
          const state = requireState();
          const runtime = state.runtimes.probe(
            getStringArg(args, 'conversationId'),
            getBooleanArg(args, 'healthy'),
            nowMs(),
          );
          if (!runtime) return errorResult(`No runtime for conversation "${getStringArg(args, 'conversationId')}".`);
          return jsonResult({ probed: true, runtime });
        } catch (err) {
          return errorResult(err instanceof Error ? err.message : String(err));
        }
      },
    },
    // -- profile-scoped secrets --------------------------------------------
    {
      definition: toolDef(
        'fleet_v28_secret_set',
        'Set a secret for a profile (scoped: no other profile can read it).',
        {
          profileId: { type: 'string' },
          name: { type: 'string' },
          value: { type: 'string' },
        },
        ['profileId', 'name', 'value'],
      ),
      needsApproval: true,
      execute: async (args) => {
        try {
          const state = requireState();
          const result = state.secrets.setSecret(
            getStringArg(args, 'profileId'),
            getStringArg(args, 'name'),
            getStringArg(args, 'value'),
            nowMs(),
          );
          if (!result.ok) return errorResult(`Cannot set secret: ${(result.reasons ?? []).join(', ')}`);
          return jsonResult({ set: true, meta: result.meta });
        } catch (err) {
          return errorResult(err instanceof Error ? err.message : String(err));
        }
      },
    },
    {
      definition: toolDef(
        'fleet_v28_secret_get',
        'Get a secret value — only for its owning profile.',
        {
          profileId: { type: 'string' },
          name: { type: 'string' },
        },
        ['profileId', 'name'],
      ),
      needsApproval: false,
      execute: async (args) => {
        try {
          const state = requireState();
          const value = state.secrets.getSecret(getStringArg(args, 'profileId'), getStringArg(args, 'name'));
          if (value === undefined) {
            return errorResult(
              `No secret "${getStringArg(args, 'name')}" for profile "${getStringArg(args, 'profileId')}".`,
            );
          }
          return jsonResult({ profileId: getStringArg(args, 'profileId'), name: getStringArg(args, 'name'), value });
        } catch (err) {
          return errorResult(err instanceof Error ? err.message : String(err));
        }
      },
    },
    {
      definition: toolDef(
        'fleet_v28_secret_list',
        'List a profile secret names + metadata (values are never listed).',
        { profileId: { type: 'string' } },
        ['profileId'],
      ),
      needsApproval: false,
      execute: async (args) => {
        try {
          const state = requireState();
          return jsonResult({ secrets: state.secrets.listSecrets(getStringArg(args, 'profileId'), nowMs()) });
        } catch (err) {
          return errorResult(err instanceof Error ? err.message : String(err));
        }
      },
    },
    {
      definition: toolDef(
        'fleet_v28_secret_delete',
        'Delete a profile secret.',
        {
          profileId: { type: 'string' },
          name: { type: 'string' },
        },
        ['profileId', 'name'],
      ),
      needsApproval: true,
      execute: async (args) => {
        try {
          const state = requireState();
          const deleted = state.secrets.deleteSecret(
            getStringArg(args, 'profileId'),
            getStringArg(args, 'name'),
            nowMs(),
          );
          if (!deleted) {
            return errorResult(
              `No secret "${getStringArg(args, 'name')}" for profile "${getStringArg(args, 'profileId')}".`,
            );
          }
          return jsonResult({ deleted: true });
        } catch (err) {
          return errorResult(err instanceof Error ? err.message : String(err));
        }
      },
    },
    {
      definition: toolDef(
        'fleet_v28_secret_rotate',
        'Rotate a profile secret (new value, version +1, old value kept during a grace window).',
        {
          profileId: { type: 'string' },
          name: { type: 'string' },
          newValue: { type: 'string' },
          graceMs: { type: 'number' },
        },
        ['profileId', 'name', 'newValue'],
      ),
      needsApproval: true,
      execute: async (args) => {
        try {
          const state = requireState();
          const result = state.secrets.rotateSecret(
            getStringArg(args, 'profileId'),
            getStringArg(args, 'name'),
            getStringArg(args, 'newValue'),
            { nowMs: nowMs(), graceMs: getOptionalNumberArg(args, 'graceMs') ?? undefined },
          );
          if (!result.ok) return errorResult(`Cannot rotate secret: ${(result.reasons ?? []).join(', ')}`);
          return jsonResult({ rotated: true, meta: result.meta });
        } catch (err) {
          return errorResult(err instanceof Error ? err.message : String(err));
        }
      },
    },
    {
      definition: toolDef(
        'fleet_v28_secret_redact',
        'Redact a profile secret values out of free text (for safe logging).',
        {
          profileId: { type: 'string' },
          text: { type: 'string' },
        },
        ['profileId', 'text'],
      ),
      needsApproval: false,
      execute: async (args) => {
        try {
          const state = requireState();
          const result = state.secrets.redactText(getStringArg(args, 'profileId'), getStringArg(args, 'text'));
          return jsonResult(result);
        } catch (err) {
          return errorResult(err instanceof Error ? err.message : String(err));
        }
      },
    },
    {
      definition: toolDef(
        'fleet_v28_secret_audit',
        'Show a profile secret audit ledger (actions only — values are never logged).',
        { profileId: { type: 'string' } },
        ['profileId'],
      ),
      needsApproval: false,
      execute: async (args) => {
        try {
          const state = requireState();
          return jsonResult({ audit: state.secrets.listAudit(getStringArg(args, 'profileId')) });
        } catch (err) {
          return errorResult(err instanceof Error ? err.message : String(err));
        }
      },
    },
    // -- conversation budget meter ------------------------------------------
    {
      definition: toolDef(
        'fleet_v28_budget_record',
        'Record token usage for a conversation (refused when past the hard cap).',
        {
          conversationId: { type: 'string' },
          profileId: { type: 'string' },
          model: { type: 'string' },
          inputTokens: { type: 'number' },
          outputTokens: { type: 'number' },
        },
        ['conversationId', 'profileId', 'model', 'inputTokens', 'outputTokens'],
      ),
      needsApproval: true,
      execute: async (args) => {
        try {
          const state = requireState();
          const result = state.budget.recordUsage(
            getStringArg(args, 'conversationId'),
            getStringArg(args, 'profileId'),
            getStringArg(args, 'model'),
            getNumberArg(args, 'inputTokens', 0),
            getNumberArg(args, 'outputTokens', 0),
            nowMs(),
          );
          if (!result.accepted) return errorResult(result.reason ?? 'Record refused.');
          return jsonResult({ recorded: true, costUsd: result.costUsd, meter: result.meter });
        } catch (err) {
          return errorResult(err instanceof Error ? err.message : String(err));
        }
      },
    },
    {
      definition: toolDef(
        'fleet_v28_budget_get',
        'Show one conversation budget meter (tokens, cost, cap, level, remaining).',
        { conversationId: { type: 'string' } },
        ['conversationId'],
      ),
      needsApproval: false,
      execute: async (args) => {
        try {
          const state = requireState();
          const meter = state.budget.getMeter(getStringArg(args, 'conversationId'));
          if (!meter) return errorResult(`No budget meter for conversation "${getStringArg(args, 'conversationId')}".`);
          return jsonResult({ meter });
        } catch (err) {
          return errorResult(err instanceof Error ? err.message : String(err));
        }
      },
    },
    {
      definition: toolDef(
        'fleet_v28_budget_set_cap',
        'Set (or clear) a conversation hard budget cap in USD.',
        {
          conversationId: { type: 'string' },
          capUsd: { type: 'number' },
        },
        ['conversationId'],
      ),
      needsApproval: true,
      execute: async (args) => {
        try {
          const state = requireState();
          const cap = getOptionalNumberArg(args, 'capUsd');
          const result = state.budget.setCap(getStringArg(args, 'conversationId'), cap, nowMs());
          if (!result.ok) return errorResult(`Cannot set cap: ${(result.reasons ?? []).join(', ')}`);
          return jsonResult({ updated: true, meter: result.meter });
        } catch (err) {
          return errorResult(err instanceof Error ? err.message : String(err));
        }
      },
    },
    {
      definition: toolDef(
        'fleet_v28_budget_list',
        'List budget meters, optionally filtered by profile (highest cost first).',
        { profileId: { type: 'string' } },
        [],
      ),
      needsApproval: false,
      execute: async (args) => {
        try {
          const state = requireState();
          const profileId = getOptionalStringArg(args, 'profileId');
          return jsonResult({ meters: state.budget.listMeters(profileId ?? undefined) });
        } catch (err) {
          return errorResult(err instanceof Error ? err.message : String(err));
        }
      },
    },
    {
      definition: toolDef(
        'fleet_v28_budget_reset',
        'Reset one conversation budget meter (counters to zero; history kept for reports).',
        { conversationId: { type: 'string' } },
        ['conversationId'],
      ),
      needsApproval: true,
      execute: async (args) => {
        try {
          const state = requireState();
          const ok = state.budget.resetMeter(getStringArg(args, 'conversationId'), nowMs());
          if (!ok) return errorResult(`No budget meter for conversation "${getStringArg(args, 'conversationId')}".`);
          return jsonResult({ reset: true, meter: state.budget.getMeter(getStringArg(args, 'conversationId')) });
        } catch (err) {
          return errorResult(err instanceof Error ? err.message : String(err));
        }
      },
    },
    {
      definition: toolDef(
        'fleet_v28_budget_report_daily',
        'Daily budget report for one UTC date (per-profile + top conversations).',
        { day: { type: 'string' } },
        [],
      ),
      needsApproval: false,
      execute: async (args) => {
        try {
          const state = requireState();
          const day = getOptionalStringArg(args, 'day') ?? fleetV28DayOf(nowMs());
          if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return errorResult(`day must be YYYY-MM-DD, got "${day}".`);
          return jsonResult({ report: state.budget.dailyReport(day) });
        } catch (err) {
          return errorResult(err instanceof Error ? err.message : String(err));
        }
      },
    },
    {
      definition: toolDef(
        'fleet_v28_budget_report_weekly',
        'Weekly budget report for the 7 days starting at a UTC date.',
        { weekStart: { type: 'string' } },
        [],
      ),
      needsApproval: false,
      execute: async (args) => {
        try {
          const state = requireState();
          const weekStart = getOptionalStringArg(args, 'weekStart') ?? fleetV28DayOf(nowMs());
          if (!/^\d{4}-\d{2}-\d{2}$/.test(weekStart)) {
            return errorResult(`weekStart must be YYYY-MM-DD, got "${weekStart}".`);
          }
          return jsonResult({ report: state.budget.weeklyReport(weekStart) });
        } catch (err) {
          return errorResult(err instanceof Error ? err.message : String(err));
        }
      },
    },
    {
      definition: toolDef(
        'fleet_v28_budget_alerts',
        'Show budget meters at or over their warn threshold.',
        {},
        [],
      ),
      needsApproval: false,
      execute: async () => {
        try {
          const state = requireState();
          return jsonResult({ alerts: state.budget.listAlerts() });
        } catch (err) {
          return errorResult(err instanceof Error ? err.message : String(err));
        }
      },
    },
    // -- budget forecast + sandbox policy + conversation adapter -------------
    {
      definition: toolDef(
        'fleet_v28_budget_forecast',
        'Forecast a profile spend to a horizon date from its burn rate.',
        {
          profileId: { type: 'string' },
          windowStart: { type: 'string' },
          windowEnd: { type: 'string' },
          horizon: { type: 'string' },
        },
        ['profileId', 'windowStart', 'windowEnd', 'horizon'],
      ),
      needsApproval: false,
      execute: async (args) => {
        try {
          const state = requireState();
          const profileId = getStringArg(args, 'profileId');
          const windowStart = getStringArg(args, 'windowStart');
          const windowEnd = getStringArg(args, 'windowEnd');
          const horizon = getStringArg(args, 'horizon');
          for (const [label, day] of [['windowStart', windowStart], ['windowEnd', windowEnd], ['horizon', horizon]] as const) {
            if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return errorResult(`${label} must be YYYY-MM-DD, got "${day}".`);
          }
          const entries = state.budget.listEntries({ profileId });
          const rate = computeFleetV28BurnRate(profileId, entries, windowStart, windowEnd);
          return jsonResult({ forecast: forecastFleetV28Spend(rate, horizon), burnRate: rate });
        } catch (err) {
          return errorResult(err instanceof Error ? err.message : String(err));
        }
      },
    },
    {
      definition: toolDef(
        'fleet_v28_budget_burn_rate',
        'Show a profile burn rate (cost per active day) over a window.',
        {
          profileId: { type: 'string' },
          windowStart: { type: 'string' },
          windowEnd: { type: 'string' },
        },
        ['profileId', 'windowStart', 'windowEnd'],
      ),
      needsApproval: false,
      execute: async (args) => {
        try {
          const state = requireState();
          const profileId = getStringArg(args, 'profileId');
          const windowStart = getStringArg(args, 'windowStart');
          const windowEnd = getStringArg(args, 'windowEnd');
          const entries = state.budget.listEntries({ profileId });
          return jsonResult({ burnRate: computeFleetV28BurnRate(profileId, entries, windowStart, windowEnd) });
        } catch (err) {
          return errorResult(err instanceof Error ? err.message : String(err));
        }
      },
    },
    {
      definition: toolDef(
        'fleet_v28_budget_model_breakdown',
        'Show per-model cost breakdown over a window (optionally one profile).',
        {
          windowStart: { type: 'string' },
          windowEnd: { type: 'string' },
          profileId: { type: 'string' },
        },
        ['windowStart', 'windowEnd'],
      ),
      needsApproval: false,
      execute: async (args) => {
        try {
          const state = requireState();
          const windowStart = getStringArg(args, 'windowStart');
          const windowEnd = getStringArg(args, 'windowEnd');
          const profileId = getOptionalStringArg(args, 'profileId');
          const entries = state.budget.listEntries(profileId ? { profileId } : {});
          return jsonResult({ models: breakdownFleetV28ByModel(entries, windowStart, windowEnd) });
        } catch (err) {
          return errorResult(err instanceof Error ? err.message : String(err));
        }
      },
    },
    {
      definition: toolDef(
        'fleet_v28_sandbox_policy',
        'Show the default sandbox policy + cgroup limits for a conversation runtime.',
        {
          conversationId: { type: 'string' },
          workspaceRoot: { type: 'string' },
        },
        ['conversationId', 'workspaceRoot'],
      ),
      needsApproval: false,
      execute: async (args) => {
        try {
          const state = requireState();
          const conversationId = getStringArg(args, 'conversationId');
          const workspaceRoot = getStringArg(args, 'workspaceRoot');
          const runtime = state.runtimes.getRuntime(conversationId);
          const limits = runtime ? runtime.limits : FLEET_V28_DEFAULT_RUNTIME_LIMITS;
          return jsonResult({
            policy: defaultFleetV28SandboxPolicy(conversationId, workspaceRoot),
            cgroup: deriveFleetV28CgroupLimits(limits),
            limits,
          });
        } catch (err) {
          return errorResult(err instanceof Error ? err.message : String(err));
        }
      },
    },
    {
      definition: toolDef(
        'fleet_v28_sandbox_validate_path',
        'Check whether a path stays inside a conversation workspace root.',
        {
          workspaceRoot: { type: 'string' },
          targetPath: { type: 'string' },
        },
        ['workspaceRoot', 'targetPath'],
      ),
      needsApproval: false,
      execute: async (args) => {
        try {
          requireState();
          return jsonResult(checkFleetV28WorkspacePath(getStringArg(args, 'workspaceRoot'), getStringArg(args, 'targetPath')));
        } catch (err) {
          return errorResult(err instanceof Error ? err.message : String(err));
        }
      },
    },
    {
      definition: toolDef(
        'fleet_v28_sandbox_validate_command',
        'Validate an exec request (command/args/cwd/timeout) against the sandbox policy.',
        {
          conversationId: { type: 'string' },
          workspaceRoot: { type: 'string' },
          command: { type: 'string' },
          args: { type: 'array', items: { type: 'string' } },
          cwd: { type: 'string' },
          timeoutMs: { type: 'number' },
        },
        ['conversationId', 'workspaceRoot', 'command', 'cwd', 'timeoutMs'],
      ),
      needsApproval: false,
      execute: async (args) => {
        try {
          const state = requireState();
          const conversationId = getStringArg(args, 'conversationId');
          const runtime = state.runtimes.getRuntime(conversationId);
          const limits = runtime
            ? runtime.limits
            : resolveFleetV28RuntimeLimits(null, FLEET_V28_DEFAULT_RUNTIME_LIMITS);
          const policy = defaultFleetV28SandboxPolicy(conversationId, getStringArg(args, 'workspaceRoot'));
          const reasons = validateFleetV28ExecRequest(policy, limits, {
            command: getStringArg(args, 'command'),
            args: getStringArrayArg(args, 'args'),
            cwd: getStringArg(args, 'cwd'),
            timeoutMs: getNumberArg(args, 'timeoutMs', 0),
            env: {},
          });
          return jsonResult({ allowed: reasons.length === 0, reasons });
        } catch (err) {
          return errorResult(err instanceof Error ? err.message : String(err));
        }
      },
    },
    {
      definition: toolDef(
        'fleet_v28_sandbox_watchdog',
        'Show the watchdog deadline/status for an exec started at a given time.',
        {
          startedAtMs: { type: 'number' },
          timeoutMs: { type: 'number' },
        },
        ['startedAtMs', 'timeoutMs'],
      ),
      needsApproval: false,
      execute: async (args) => {
        try {
          requireState();
          return jsonResult(
            watchdogStatus(getNumberArg(args, 'startedAtMs', 0), getNumberArg(args, 'timeoutMs', 0), nowMs()),
          );
        } catch (err) {
          return errorResult(err instanceof Error ? err.message : String(err));
        }
      },
    },
    {
      definition: toolDef(
        'fleet_v28_conversation_attach',
        'Attach a conversation to its runtime (preset limits + budget cap).',
        {
          conversationId: { type: 'string' },
          profileId: { type: 'string' },
          botId: { type: 'string' },
        },
        ['conversationId', 'profileId'],
      ),
      needsApproval: true,
      execute: async (args) => {
        try {
          const state = requireState();
          const result = getAdapter(state).attachConversation(
            getStringArg(args, 'conversationId'),
            getStringArg(args, 'profileId'),
            { botId: getOptionalStringArg(args, 'botId') ?? undefined, nowMs: nowMs() },
          );
          if (!result.ok) return errorResult(`Cannot attach conversation: ${(result.reasons ?? []).join(', ')}`);
          return jsonResult({ attached: true, attachment: result.attachment, runtime: result.runtime ?? null });
        } catch (err) {
          return errorResult(err instanceof Error ? err.message : String(err));
        }
      },
    },
    {
      definition: toolDef(
        'fleet_v28_conversation_event',
        'Forward a conversation event (message/toolcall/idle/end) to the runtime adapter.',
        {
          conversationId: { type: 'string' },
          kind: { type: 'string' },
          model: { type: 'string' },
          inputTokens: { type: 'number' },
          outputTokens: { type: 'number' },
          resultText: { type: 'string' },
          healthy: { type: 'boolean' },
        },
        ['conversationId', 'kind'],
      ),
      needsApproval: true,
      execute: async (args) => {
        try {
          const state = requireState();
          const adapter = getAdapter(state);
          const conversationId = getStringArg(args, 'conversationId');
          const kind = getStringArg(args, 'kind');
          if (kind === 'message') {
            return jsonResult(adapter.onMessage(conversationId, {
              healthy: args.healthy === undefined || args.healthy === null ? undefined : getBooleanArg(args, 'healthy'),
              nowMs: nowMs(),
            }));
          }
          if (kind === 'toolcall') {
            return jsonResult(adapter.onToolCall(conversationId, {
              model: getStringArg(args, 'model'),
              inputTokens: getNumberArg(args, 'inputTokens', 0),
              outputTokens: getNumberArg(args, 'outputTokens', 0),
              resultText: getOptionalStringArg(args, 'resultText') ?? '',
              nowMs: nowMs(),
            }));
          }
          if (kind === 'idle') {
            return jsonResult(adapter.onIdle(nowMs()));
          }
          if (kind === 'end') {
            return jsonResult(adapter.onEnd(conversationId, nowMs()));
          }
          return errorResult(`Unknown conversation event kind "${kind}" (expected message|toolcall|idle|end).`);
        } catch (err) {
          return errorResult(err instanceof Error ? err.message : String(err));
        }
      },
    },
    {
      definition: toolDef(
        'fleet_v28_conversation_list',
        'List conversations attached to runtimes by the adapter.',
        {},
        [],
      ),
      needsApproval: false,
      execute: async () => {
        try {
          const state = requireState();
          return jsonResult({ attachments: getAdapter(state).listAttachments() });
        } catch (err) {
          return errorResult(err instanceof Error ? err.message : String(err));
        }
      },
    },
    // -- presets per profile --------------------------------------------------
    {
      definition: toolDef(
        'fleet_v28_preset_list',
        'List the built-in runtime/budget presets (small/medium/large).',
        {},
        [],
      ),
      needsApproval: false,
      execute: async () => {
        try {
          requireState();
          return jsonResult({ presets: listFleetV28Presets() });
        } catch (err) {
          return errorResult(err instanceof Error ? err.message : String(err));
        }
      },
    },
    {
      definition: toolDef(
        'fleet_v28_preset_get',
        'Show the preset bundle a profile currently resolves to.',
        { profileId: { type: 'string' } },
        ['profileId'],
      ),
      needsApproval: false,
      execute: async (args) => {
        try {
          const state = requireState();
          const profileId = getStringArg(args, 'profileId');
          return jsonResult({
            profileId,
            choice: state.presets.getPreset(profileId) ?? null,
            resolved: state.presets.resolveForProfile(profileId),
          });
        } catch (err) {
          return errorResult(err instanceof Error ? err.message : String(err));
        }
      },
    },
    {
      definition: toolDef(
        'fleet_v28_preset_set',
        'Set a profile preset (built-in name, or custom with hand-tuned limits + cap).',
        {
          profileId: { type: 'string' },
          presetName: { type: 'string' },
          cpuCores: { type: 'number' },
          ramMB: { type: 'number' },
          diskMB: { type: 'number' },
          timeoutMs: { type: 'number' },
          idleTimeoutMs: { type: 'number' },
          maxRestarts: { type: 'number' },
          capUsd: { type: 'number' },
        },
        ['profileId', 'presetName'],
      ),
      needsApproval: true,
      execute: async (args) => {
        try {
          const state = requireState();
          const result = state.presets.setPreset(getStringArg(args, 'profileId'), getStringArg(args, 'presetName'), {
            customLimits: getLimitsArg(args),
            customCapUsd: getOptionalNumberArg(args, 'capUsd'),
            nowMs: nowMs(),
          });
          if (!result.ok) return errorResult(`Cannot set preset: ${(result.reasons ?? []).join(', ')}`);
          return jsonResult({ set: true, choice: result.choice });
        } catch (err) {
          return errorResult(err instanceof Error ? err.message : String(err));
        }
      },
    },
    // -- combined dashboard ---------------------------------------------------
    {
      definition: toolDef(
        'fleet_v28_dashboard',
        'Build the combined fleet v28 dashboard: runtimes, secrets, budget, presets (plus forecast when a window is given).',
        {
          profileId: { type: 'string' },
          windowStart: { type: 'string' },
          windowEnd: { type: 'string' },
          horizon: { type: 'string' },
        },
        [],
      ),
      needsApproval: false,
      execute: async (args) => {
        try {
          const state = requireState();
          const profileId = getOptionalStringArg(args, 'profileId');
          const windowStart = getOptionalStringArg(args, 'windowStart');
          const windowEnd = getOptionalStringArg(args, 'windowEnd');
          const horizon = getOptionalStringArg(args, 'horizon');
          const forecastWindow =
            windowStart && windowEnd && horizon ? { windowStart, windowEnd, horizon } : undefined;
          if (forecastWindow) {
            for (const [label, day] of [
              ['windowStart', windowStart],
              ['windowEnd', windowEnd],
              ['horizon', horizon],
            ] as const) {
              if (!/^\d{4}-\d{2}-\d{2}$/.test(day as string)) {
                return errorResult(`${label} must be YYYY-MM-DD, got "${day}".`);
              }
            }
          }
          return jsonResult({
            dashboard: buildFleetV28Dashboard({
              runtimes: state.runtimes,
              secrets: state.secrets,
              budget: state.budget,
              presets: state.presets,
              profileId: profileId ?? undefined,
              nowMs: nowMs(),
              forecastWindow,
            }),
          });
        } catch (err) {
          return errorResult(err instanceof Error ? err.message : String(err));
        }
      },
    },
  ];

  return tools;
}

/** The runnable v28 tools, for ALL_TOOLS (unbound until the host wires state). */
export const FLEET_V28_TOOLS: Tool[] = createFleetV28Tools();

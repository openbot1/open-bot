/**
 * Fleet v27 tools (v1.40, Team T6) — registered in ALL_TOOLS (see tools.ts).
 *
 * Runnable tools for fleet v27 (pure definitions live in
 * `packages/core/src/fleetV27/toolsV27.ts` — 30 tools, 4 groups; this
 * file is the runnable version, wired to core via `@open-bot/core`):
 *
 * - `fleet_v27_campaign_*` — async run campaigns (create/list/get/
 *   start/progress/advance/cancel/results/retry-failed/remove).
 * - `fleet_v27_template_*` — automation templates (list/get/suggest)
 *   + `fleet_v27_automation_*` — automations from templates.
 * - `fleet_v27_quota_*` — fleet quota v2 (limits/usage/evaluate/
 *   alerts/policy/queue).
 * - `fleet_v27_dashboard` — combined dashboard.
 *
 * Like fleet v26, this is a placeholder in ALL_TOOLS until the host
 * binds: `createFleetV27Tools(getState)` with the host's state
 * (campaign store + automation store + quota store). Unbound, tools
 * return a clear "not configured" message instead of guessing state.
 * Write tools need approval (`needsApproval: true`). Tools never run
 * a model, never spawn a process, and never touch the network.
 */

import type { Tool } from '@open-bot/core';
import {
  FleetV27AutomationStore,
  FleetV27CampaignStore,
  FleetV27QuotaStore,
  aggregateFleetV27Run,
  buildFleetV27Dashboard,
  findFleetV27Template,
  listFleetV27Templates,
  suggestFleetV27Templates,
  type FleetV27BotOutcome,
  type FleetV27CampaignRunStatus,
  type FleetV27CampaignTask,
  type FleetV27ExhaustionAction,
  type FleetV27QuotaRequest,
  type FleetV27TemplateCategory,
} from '@open-bot/core';

/** State fleet v27 host provides for the tools (resolved lazily per call). */
export interface FleetV27ToolState {
  /** Campaign store (host holds 1 instance). */
  campaigns: FleetV27CampaignStore;
  /** Automation store (host holds 1 instance). */
  automations: FleetV27AutomationStore;
  /** Quota v2 store (host holds 1 instance). */
  quota: FleetV27QuotaStore;
}

export const FLEET_V27_TOOL_NAMES = [
  'fleet_v27_campaign_create',
  'fleet_v27_campaign_list',
  'fleet_v27_campaign_get',
  'fleet_v27_campaign_start',
  'fleet_v27_campaign_progress',
  'fleet_v27_campaign_advance',
  'fleet_v27_campaign_cancel',
  'fleet_v27_campaign_results',
  'fleet_v27_campaign_retry_failed',
  'fleet_v27_campaign_remove',
  'fleet_v27_template_list',
  'fleet_v27_template_get',
  'fleet_v27_template_suggest',
  'fleet_v27_automation_create',
  'fleet_v27_automation_list',
  'fleet_v27_automation_get',
  'fleet_v27_automation_set_enabled',
  'fleet_v27_automation_remove',
  'fleet_v27_automation_due',
  'fleet_v27_automation_mark_ran',
  'fleet_v27_quota_limits',
  'fleet_v27_quota_set_limits',
  'fleet_v27_quota_usage',
  'fleet_v27_quota_evaluate',
  'fleet_v27_quota_alerts',
  'fleet_v27_quota_policy',
  'fleet_v27_quota_set_policy',
  'fleet_v27_quota_queue_list',
  'fleet_v27_quota_queue_promote',
  'fleet_v27_dashboard',
] as const;

const NOT_WIRED =
  'Fleet v27 is not configured: the host has not wired fleet state (campaign store, automation store, quota store) into the v27 tools.';

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

/** Parse a campaign task argument (object, or a JSON string of one). */
function getTaskArg(args: Record<string, unknown>, name: string): FleetV27CampaignTask {
  const obj = getObjectArg(args, name);
  const kind = obj.kind === 'command' ? 'command' : 'prompt';
  const text = typeof obj.text === 'string' ? obj.text : '';
  if (!text.trim()) throw new Error(`Argument "${name}.text" must be a non-empty string.`);
  const task: FleetV27CampaignTask = { kind, text };
  if (typeof obj.timeoutMs === 'number') task.timeoutMs = obj.timeoutMs;
  if (typeof obj.maxRetries === 'number') task.maxRetries = obj.maxRetries;
  return task;
}

/** Parse the per-bot outcomes argument for campaign_advance. */
function getOutcomesArg(args: Record<string, unknown>, name: string): FleetV27BotOutcome[] {
  const value = args[name];
  if (value === undefined || value === null) throw new Error(`Missing required argument: "${name}"`);
  let parsed: unknown = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value);
    } catch {
      throw new Error(`Argument "${name}" must be an array or a JSON string of one.`);
    }
  }
  if (!Array.isArray(parsed)) throw new Error(`Argument "${name}" must be an array.`);
  return (parsed as Array<Record<string, unknown>>).map((o) => {
    if (typeof o !== 'object' || o === null || typeof o.botId !== 'string') {
      throw new Error(`Each outcome needs a string "botId".`);
    }
    const outcome = o.outcome;
    if (outcome !== 'succeeded' && outcome !== 'failed' && outcome !== 'timed-out' && outcome !== 'skipped') {
      throw new Error(`Each outcome needs "outcome" of succeeded|failed|timed-out|skipped.`);
    }
    return {
      botId: o.botId,
      outcome,
      text: typeof o.text === 'string' ? o.text : undefined,
      error: typeof o.error === 'string' ? o.error : undefined,
    } as FleetV27BotOutcome;
  });
}

function getExhaustionArg(args: Record<string, unknown>, name: string): FleetV27ExhaustionAction | null {
  const value = args[name];
  if (value === undefined || value === null) return null;
  if (value !== 'queue' && value !== 'defer' && value !== 'reject') {
    throw new Error(`Argument "${name}" must be queue|defer|reject.`);
  }
  return value;
}

/** Build an empty state for hosts without their own state (tests + demo). */
export function createEmptyFleetV27ToolState(): FleetV27ToolState {
  return {
    campaigns: new FleetV27CampaignStore(),
    automations: new FleetV27AutomationStore(),
    quota: new FleetV27QuotaStore(),
  };
}

/** true when every runnable v27 tool name is unique. */
export function fleetV27ToolNamesUnique(): boolean {
  return new Set(FLEET_V27_TOOL_NAMES).size === FLEET_V27_TOOL_NAMES.length;
}

export function createFleetV27Tools(
  getState?: () => FleetV27ToolState | null | undefined,
): Tool[] {
  const resolveState = (): FleetV27ToolState | null => {
    try {
      return getState?.() ?? null;
    } catch {
      return null;
    }
  };

  const requireState = (): FleetV27ToolState => {
    const state = resolveState();
    if (!state) throw new Error(NOT_WIRED);
    return state;
  };

  const nowMs = (): number => Date.now();

  const tools: Tool[] = [
    // -- campaigns ----------------------------------------------------------
    {
      definition: toolDef(
        'fleet_v27_campaign_create',
        'Create an async run campaign (bots + task + concurrency).',
        {
          id: { type: 'string' },
          name: { type: 'string' },
          description: { type: 'string' },
          bots: { type: 'array', items: { type: 'string' } },
          task: { type: 'object' },
          concurrency: { type: 'number' },
          tags: { type: 'array', items: { type: 'string' } },
          createdBy: { type: 'string' },
        },
        ['id', 'name', 'bots', 'task'],
      ),
      needsApproval: true,
      execute: async (args) => {
        try {
          const state = requireState();
          const task = getTaskArg(args, 'task');
          const botIds = getStringArrayArg(args, 'bots');
          const result = state.campaigns.createCampaign({
            id: getStringArg(args, 'id'),
            name: getStringArg(args, 'name'),
            description: getOptionalStringArg(args, 'description') ?? undefined,
            bots: botIds.map((botId) => ({ botId })),
            task,
            concurrency: getOptionalNumberArg(args, 'concurrency') ?? undefined,
            tags: getStringArrayArg(args, 'tags'),
            createdBy: getOptionalStringArg(args, 'createdBy') ?? undefined,
          });
          if (!result.ok) return errorResult(`Invalid campaign: ${result.reasons.join(', ')}`);
          return jsonResult({ created: true, campaign: result.campaign });
        } catch (err) {
          return errorResult(err instanceof Error ? err.message : String(err));
        }
      },
    },
    {
      definition: toolDef(
        'fleet_v27_campaign_list',
        'List campaigns, optionally filtered by tag.',
        { tag: { type: 'string' } },
        [],
      ),
      needsApproval: false,
      execute: async (args) => {
        try {
          const state = requireState();
          return jsonResult({ campaigns: state.campaigns.listCampaigns(getOptionalStringArg(args, 'tag')) });
        } catch (err) {
          return errorResult(err instanceof Error ? err.message : String(err));
        }
      },
    },
    {
      definition: toolDef(
        'fleet_v27_campaign_get',
        'Show one campaign definition.',
        { id: { type: 'string' } },
        ['id'],
      ),
      needsApproval: false,
      execute: async (args) => {
        try {
          const state = requireState();
          const campaign = state.campaigns.getCampaign(getStringArg(args, 'id'));
          if (!campaign) return errorResult('Campaign not found.');
          return jsonResult({ campaign });
        } catch (err) {
          return errorResult(err instanceof Error ? err.message : String(err));
        }
      },
    },
    {
      definition: toolDef(
        'fleet_v27_campaign_start',
        'Start a run of a campaign (bots start up to the concurrency cap).',
        { campaignId: { type: 'string' }, startedBy: { type: 'string' } },
        ['campaignId'],
      ),
      needsApproval: true,
      execute: async (args) => {
        try {
          const state = requireState();
          const result = state.campaigns.startRun(getStringArg(args, 'campaignId'), {
            startedBy: getOptionalStringArg(args, 'startedBy') ?? undefined,
            nowMs: nowMs(),
          });
          if (!result.ok) return errorResult(`Cannot start run: ${result.reasons.join(', ')}`);
          return jsonResult({ started: true, run: result.run });
        } catch (err) {
          return errorResult(err instanceof Error ? err.message : String(err));
        }
      },
    },
    {
      definition: toolDef(
        'fleet_v27_campaign_progress',
        'Show one run progress: per-bot states, aggregate counts, overall status.',
        { runId: { type: 'string' } },
        ['runId'],
      ),
      needsApproval: false,
      execute: async (args) => {
        try {
          const state = requireState();
          const runId = getStringArg(args, 'runId');
          const run = state.campaigns.getRun(runId);
          if (!run) return errorResult('Run not found.');
          return jsonResult({
            runId,
            campaignId: run.campaignId,
            status: run.status,
            aggregate: aggregateFleetV27Run(run.entries),
            entries: run.entries,
            summary: state.campaigns.summarizeRun(runId),
          });
        } catch (err) {
          return errorResult(err instanceof Error ? err.message : String(err));
        }
      },
    },
    {
      definition: toolDef(
        'fleet_v27_campaign_advance',
        'Advance a run one tick with host-reported per-bot outcomes (retries + fills freed slots).',
        { runId: { type: 'string' }, outcomes: { type: 'array' } },
        ['runId', 'outcomes'],
      ),
      needsApproval: true,
      execute: async (args) => {
        try {
          const state = requireState();
          const result = state.campaigns.advanceRun(getStringArg(args, 'runId'), getOutcomesArg(args, 'outcomes'), { nowMs: nowMs() });
          if (!result.ok) return errorResult(`Cannot advance run: ${result.reasons.join(', ')}`);
          return jsonResult(result.result);
        } catch (err) {
          return errorResult(err instanceof Error ? err.message : String(err));
        }
      },
    },
    {
      definition: toolDef(
        'fleet_v27_campaign_cancel',
        'Cancel a running campaign run (queued/running bots become cancelled).',
        { runId: { type: 'string' }, reason: { type: 'string' } },
        ['runId', 'reason'],
      ),
      needsApproval: true,
      execute: async (args) => {
        try {
          const state = requireState();
          const result = state.campaigns.cancelRun(
            getStringArg(args, 'runId'),
            getStringArg(args, 'reason'),
            { nowMs: nowMs() },
          );
          if (!result.ok) return errorResult(`Cannot cancel run: ${result.reasons.join(', ')}`);
          return jsonResult({ cancelled: true, run: result.run });
        } catch (err) {
          return errorResult(err instanceof Error ? err.message : String(err));
        }
      },
    },
    {
      definition: toolDef(
        'fleet_v27_campaign_results',
        'Show finished campaign runs (history) with per-bot results, optionally filtered by status.',
        { status: { type: 'string' }, campaignId: { type: 'string' } },
        [],
      ),
      needsApproval: false,
      execute: async (args) => {
        try {
          const state = requireState();
          const status = getOptionalStringArg(args, 'status') as FleetV27CampaignRunStatus | null;
          const campaignId = getOptionalStringArg(args, 'campaignId');
          const runs = state.campaigns.listFinishedRuns(status)
            .filter((r) => !campaignId || r.campaignId === campaignId)
            .map((r) => ({
              ...r,
              aggregate: aggregateFleetV27Run(r.entries),
              summary: state.campaigns.summarizeRun(r.id),
            }));
          return jsonResult({ runs });
        } catch (err) {
          return errorResult(err instanceof Error ? err.message : String(err));
        }
      },
    },
    {
      definition: toolDef(
        'fleet_v27_campaign_retry_failed',
        'Retry the failed / timed-out bots of a finished run as a new run.',
        { runId: { type: 'string' }, startedBy: { type: 'string' } },
        ['runId'],
      ),
      needsApproval: true,
      execute: async (args) => {
        try {
          const state = requireState();
          const result = state.campaigns.retryFailed(getStringArg(args, 'runId'), {
            startedBy: getOptionalStringArg(args, 'startedBy') ?? undefined,
            nowMs: nowMs(),
          });
          if (!result.ok) return errorResult(`Cannot retry failed bots: ${result.reasons.join(', ')}`);
          return jsonResult({ retried: true, run: result.run });
        } catch (err) {
          return errorResult(err instanceof Error ? err.message : String(err));
        }
      },
    },
    {
      definition: toolDef(
        'fleet_v27_campaign_remove',
        'Remove a campaign definition (its runs stay in history).',
        { id: { type: 'string' } },
        ['id'],
      ),
      needsApproval: true,
      execute: async (args) => {
        try {
          const state = requireState();
          const removed = state.campaigns.removeCampaign(getStringArg(args, 'id'));
          if (!removed) return errorResult('Campaign not found.');
          return jsonResult({ removed: true });
        } catch (err) {
          return errorResult(err instanceof Error ? err.message : String(err));
        }
      },
    },
    // -- templates + automations --------------------------------------------
    {
      definition: toolDef(
        'fleet_v27_template_list',
        'List built-in automation templates, optionally filtered by category.',
        { category: { type: 'string' } },
        [],
      ),
      needsApproval: false,
      execute: async (args) => {
        try {
          const category = getOptionalStringArg(args, 'category') as FleetV27TemplateCategory | null;
          return jsonResult({ templates: listFleetV27Templates(category) });
        } catch (err) {
          return errorResult(err instanceof Error ? err.message : String(err));
        }
      },
    },
    {
      definition: toolDef(
        'fleet_v27_template_get',
        'Show one automation template (default cron, task, params).',
        { id: { type: 'string' } },
        ['id'],
      ),
      needsApproval: false,
      execute: async (args) => {
        try {
          const template = findFleetV27Template(getStringArg(args, 'id'));
          if (!template) return errorResult('Template not found.');
          return jsonResult({ template });
        } catch (err) {
          return errorResult(err instanceof Error ? err.message : String(err));
        }
      },
    },
    {
      definition: toolDef(
        'fleet_v27_template_suggest',
        'Suggest automation templates ranked for the current repo/bot context.',
        {
          repoPath: { type: 'string' },
          hasGit: { type: 'boolean' },
          botTags: { type: 'array', items: { type: 'string' } },
          botCount: { type: 'number' },
          capabilities: { type: 'array', items: { type: 'string' } },
          hourOfDay: { type: 'number' },
          limit: { type: 'number' },
        },
        [],
      ),
      needsApproval: false,
      execute: async (args) => {
        try {
          const suggestions = suggestFleetV27Templates(
            {
              repoPath: getOptionalStringArg(args, 'repoPath'),
              hasGit: getBooleanArg(args, 'hasGit', false),
              botTags: getStringArrayArg(args, 'botTags'),
              botCount: getNumberArg(args, 'botCount', 0),
              capabilities: getStringArrayArg(args, 'capabilities'),
              hourOfDay: getOptionalNumberArg(args, 'hourOfDay') ?? undefined,
            },
            getNumberArg(args, 'limit', 5),
          );
          return jsonResult({ suggestions });
        } catch (err) {
          return errorResult(err instanceof Error ? err.message : String(err));
        }
      },
    },
    {
      definition: toolDef(
        'fleet_v27_automation_create',
        'Create a scheduled automation from a template (bot + repo + cron + params).',
        {
          templateId: { type: 'string' },
          botId: { type: 'string' },
          repoPath: { type: 'string' },
          cron: { type: 'string' },
          name: { type: 'string' },
          params: { type: 'object' },
        },
        ['templateId', 'botId'],
      ),
      needsApproval: true,
      execute: async (args) => {
        try {
          const state = requireState();
          const paramsObj = args.params === undefined || args.params === null
            ? {}
            : getObjectArg(args, 'params');
          const params: Record<string, string> = {};
          for (const [k, v] of Object.entries(paramsObj)) {
            if (typeof v === 'string') params[k] = v;
            else if (typeof v === 'number' || typeof v === 'boolean') params[k] = String(v);
          }
          const result = state.automations.createFromTemplate({
            templateId: getStringArg(args, 'templateId'),
            botId: getStringArg(args, 'botId'),
            repoPath: getOptionalStringArg(args, 'repoPath'),
            cron: getOptionalStringArg(args, 'cron'),
            name: getOptionalStringArg(args, 'name'),
            params,
            createdAtMs: nowMs(),
          });
          if (!result.ok) return errorResult(`Invalid automation: ${result.reasons.join(', ')}`);
          return jsonResult({ created: true, automation: result.automation });
        } catch (err) {
          return errorResult(err instanceof Error ? err.message : String(err));
        }
      },
    },
    {
      definition: toolDef(
        'fleet_v27_automation_list',
        'List automations created from templates, optionally filtered.',
        {
          templateId: { type: 'string' },
          botId: { type: 'string' },
          enabled: { type: 'boolean' },
        },
        [],
      ),
      needsApproval: false,
      execute: async (args) => {
        try {
          const state = requireState();
          const enabled = args.enabled === undefined || args.enabled === null
            ? null
            : getBooleanArg(args, 'enabled');
          return jsonResult({
            automations: state.automations.listAutomations({
              templateId: getOptionalStringArg(args, 'templateId'),
              botId: getOptionalStringArg(args, 'botId'),
              enabled,
            }),
          });
        } catch (err) {
          return errorResult(err instanceof Error ? err.message : String(err));
        }
      },
    },
    {
      definition: toolDef(
        'fleet_v27_automation_get',
        'Show one automation (schedule, next run, run count).',
        { id: { type: 'string' } },
        ['id'],
      ),
      needsApproval: false,
      execute: async (args) => {
        try {
          const state = requireState();
          const automation = state.automations.getAutomation(getStringArg(args, 'id'));
          if (!automation) return errorResult('Automation not found.');
          return jsonResult({ automation });
        } catch (err) {
          return errorResult(err instanceof Error ? err.message : String(err));
        }
      },
    },
    {
      definition: toolDef(
        'fleet_v27_automation_set_enabled',
        'Enable or disable a scheduled automation.',
        { id: { type: 'string' }, enabled: { type: 'boolean' } },
        ['id', 'enabled'],
      ),
      needsApproval: true,
      execute: async (args) => {
        try {
          const state = requireState();
          const ok = state.automations.setEnabled(getStringArg(args, 'id'), getBooleanArg(args, 'enabled'));
          if (!ok) return errorResult('Automation not found.');
          return jsonResult({ updated: true, enabled: getBooleanArg(args, 'enabled') });
        } catch (err) {
          return errorResult(err instanceof Error ? err.message : String(err));
        }
      },
    },
    {
      definition: toolDef(
        'fleet_v27_automation_remove',
        'Remove a scheduled automation.',
        { id: { type: 'string' } },
        ['id'],
      ),
      needsApproval: true,
      execute: async (args) => {
        try {
          const state = requireState();
          const removed = state.automations.removeAutomation(getStringArg(args, 'id'));
          if (!removed) return errorResult('Automation not found.');
          return jsonResult({ removed: true });
        } catch (err) {
          return errorResult(err instanceof Error ? err.message : String(err));
        }
      },
    },
    {
      definition: toolDef(
        'fleet_v27_automation_due',
        'List automations that are enabled and due to run now.',
        {},
        [],
      ),
      needsApproval: false,
      execute: async () => {
        try {
          const state = requireState();
          return jsonResult({ due: state.automations.dueAutomations(nowMs()) });
        } catch (err) {
          return errorResult(err instanceof Error ? err.message : String(err));
        }
      },
    },
    {
      definition: toolDef(
        'fleet_v27_automation_mark_ran',
        'Record that an automation ran (bumps its count, recomputes its next run).',
        { id: { type: 'string' } },
        ['id'],
      ),
      needsApproval: true,
      execute: async (args) => {
        try {
          const state = requireState();
          const automation = state.automations.markRan(getStringArg(args, 'id'), nowMs());
          if (!automation) return errorResult('Automation not found.');
          return jsonResult({ marked: true, automation });
        } catch (err) {
          return errorResult(err instanceof Error ? err.message : String(err));
        }
      },
    },
    // -- quota v2 -------------------------------------------------------------
    {
      definition: toolDef(
        'fleet_v27_quota_limits',
        'Show the fleet quota v2 limits (CPU/RAM/disk, caps).',
        {},
        [],
      ),
      needsApproval: false,
      execute: async () => {
        try {
          const state = requireState();
          return jsonResult({ limits: state.quota.getLimits(), policy: state.quota.getPolicy() });
        } catch (err) {
          return errorResult(err instanceof Error ? err.message : String(err));
        }
      },
    },
    {
      definition: toolDef(
        'fleet_v27_quota_set_limits',
        'Set fleet quota v2 limits (validated; bad values are refused).',
        {
          cpuCores: { type: 'number' },
          ramMB: { type: 'number' },
          diskMB: { type: 'number' },
          maxConcurrentBots: { type: 'number' },
          maxCampaigns: { type: 'number' },
          maxRunsPerDay: { type: 'number' },
          maxBotsTotal: { type: 'number' },
        },
        [],
      ),
      needsApproval: true,
      execute: async (args) => {
        try {
          const state = requireState();
          const next: { cpuCores?: number; ramMB?: number; diskMB?: number | null; maxConcurrentBots?: number; maxCampaigns?: number; maxRunsPerDay?: number; maxBotsTotal?: number } = {};
          for (const key of ['cpuCores', 'ramMB', 'maxConcurrentBots', 'maxCampaigns', 'maxRunsPerDay', 'maxBotsTotal'] as const) {
            const v = getOptionalNumberArg(args, key);
            if (v !== null) next[key] = v;
          }
          const disk = args.diskMB;
          if (disk !== undefined && disk !== null) {
            if (typeof disk !== 'number' || !Number.isFinite(disk) || disk < 0) {
              throw new Error('Argument "diskMB" must be a number >= 0.');
            }
            next.diskMB = disk;
          }
          const result = state.quota.setLimits(next);
          if (!result.ok) return errorResult(`Invalid limits: ${result.errors.join('; ')}`);
          return jsonResult({ updated: true, limits: state.quota.getLimits() });
        } catch (err) {
          return errorResult(err instanceof Error ? err.message : String(err));
        }
      },
    },
    {
      definition: toolDef(
        'fleet_v27_quota_usage',
        'Show live fleet usage against the quota (with per-resource ratios).',
        {},
        [],
      ),
      needsApproval: false,
      execute: async () => {
        try {
          const state = requireState();
          return jsonResult({
            usage: state.quota.getUsage(),
            limits: state.quota.getLimits(),
            alerts: state.quota.alerts(),
            summary: state.quota.summarize(),
          });
        } catch (err) {
          return errorResult(err instanceof Error ? err.message : String(err));
        }
      },
    },
    {
      definition: toolDef(
        'fleet_v27_quota_evaluate',
        'Evaluate one admission request: admit, queue, defer, or reject — with reasons.',
        {
          kind: { type: 'string' },
          cpuCores: { type: 'number' },
          ramMB: { type: 'number' },
          diskMB: { type: 'number' },
          extraRunningBots: { type: 'number' },
          extraCampaigns: { type: 'number' },
          extraRunsToday: { type: 'number' },
          extraTotalBots: { type: 'number' },
        },
        ['kind'],
      ),
      needsApproval: false,
      execute: async (args) => {
        try {
          const state = requireState();
          const kind = getStringArg(args, 'kind');
          if (kind !== 'bot-start' && kind !== 'campaign-start' && kind !== 'campaign-run' && kind !== 'bot-register') {
            throw new Error('Argument "kind" must be bot-start|campaign-start|campaign-run|bot-register.');
          }
          const request: FleetV27QuotaRequest = {
            kind,
            cpuCores: getNumberArg(args, 'cpuCores', 0),
            ramMB: getNumberArg(args, 'ramMB', 0),
            diskMB: getNumberArg(args, 'diskMB', 0),
            extraRunningBots: getNumberArg(args, 'extraRunningBots', 0),
            extraCampaigns: getNumberArg(args, 'extraCampaigns', 0),
            extraRunsToday: getNumberArg(args, 'extraRunsToday', 0),
            extraTotalBots: getNumberArg(args, 'extraTotalBots', 0),
          };
          return jsonResult(state.quota.evaluate(request, nowMs()));
        } catch (err) {
          return errorResult(err instanceof Error ? err.message : String(err));
        }
      },
    },
    {
      definition: toolDef(
        'fleet_v27_quota_alerts',
        'Show quota alerts per resource (ok / warn at 80% / critical at 95%).',
        {},
        [],
      ),
      needsApproval: false,
      execute: async () => {
        try {
          const state = requireState();
          return jsonResult({ alerts: state.quota.alerts() });
        } catch (err) {
          return errorResult(err instanceof Error ? err.message : String(err));
        }
      },
    },
    {
      definition: toolDef(
        'fleet_v27_quota_policy',
        'Show the exhaustion policy (what happens per resource when quota runs out).',
        {},
        [],
      ),
      needsApproval: false,
      execute: async () => {
        try {
          const state = requireState();
          return jsonResult({ policy: state.quota.getPolicy() });
        } catch (err) {
          return errorResult(err instanceof Error ? err.message : String(err));
        }
      },
    },
    {
      definition: toolDef(
        'fleet_v27_quota_set_policy',
        'Set the exhaustion policy (queue / defer / reject per resource).',
        {
          onCpuExhausted: { type: 'string' },
          onRamExhausted: { type: 'string' },
          onDiskExhausted: { type: 'string' },
          onBotCountExhausted: { type: 'string' },
          onCampaignExhausted: { type: 'string' },
          onRunsExhausted: { type: 'string' },
          onTotalBotsExhausted: { type: 'string' },
          queueMaxWaitMs: { type: 'number' },
          queueMaxLength: { type: 'number' },
        },
        [],
      ),
      needsApproval: true,
      execute: async (args) => {
        try {
          const state = requireState();
          const next: { onCpuExhausted?: FleetV27ExhaustionAction; onRamExhausted?: FleetV27ExhaustionAction; onDiskExhausted?: FleetV27ExhaustionAction; onBotCountExhausted?: FleetV27ExhaustionAction; onCampaignExhausted?: FleetV27ExhaustionAction; onRunsExhausted?: FleetV27ExhaustionAction; onTotalBotsExhausted?: FleetV27ExhaustionAction; queueMaxWaitMs?: number; queueMaxLength?: number } = {};
          for (const key of ['onCpuExhausted', 'onRamExhausted', 'onDiskExhausted', 'onBotCountExhausted', 'onCampaignExhausted', 'onRunsExhausted', 'onTotalBotsExhausted'] as const) {
            const v = getExhaustionArg(args, key);
            if (v !== null) next[key] = v;
          }
          const wait = getOptionalNumberArg(args, 'queueMaxWaitMs');
          if (wait !== null) next.queueMaxWaitMs = wait;
          const len = getOptionalNumberArg(args, 'queueMaxLength');
          if (len !== null) next.queueMaxLength = len;
          const policy = state.quota.setPolicy(next);
          return jsonResult({ updated: true, policy });
        } catch (err) {
          return errorResult(err instanceof Error ? err.message : String(err));
        }
      },
    },
    {
      definition: toolDef(
        'fleet_v27_quota_queue_list',
        'List requests waiting in the quota queue (head first).',
        {},
        [],
      ),
      needsApproval: false,
      execute: async () => {
        try {
          const state = requireState();
          return jsonResult({ queue: state.quota.listQueue() });
        } catch (err) {
          return errorResult(err instanceof Error ? err.message : String(err));
        }
      },
    },
    {
      definition: toolDef(
        'fleet_v27_quota_queue_promote',
        'Try to promote the head of the quota queue now that capacity may have freed.',
        {},
        [],
      ),
      needsApproval: true,
      execute: async () => {
        try {
          const state = requireState();
          const result = state.quota.promoteHead(nowMs());
          // Empty queue / still blocked are normal states, not errors:
          // report them as JSON so callers can poll the queue.
          return jsonResult({ promoted: result.ok, evaluation: result.evaluation ?? null, reason: result.reason ?? null });
        } catch (err) {
          return errorResult(err instanceof Error ? err.message : String(err));
        }
      },
    },
    // -- dashboard ------------------------------------------------------------
    {
      definition: toolDef(
        'fleet_v27_dashboard',
        'Build the combined fleet v27 dashboard: campaigns, automations, quota.',
        {},
        [],
      ),
      needsApproval: false,
      execute: async () => {
        try {
          const state = requireState();
          return jsonResult(
            buildFleetV27Dashboard({
              campaigns: state.campaigns,
              automations: state.automations,
              quota: state.quota,
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

/** The runnable v27 tools, for ALL_TOOLS (unbound until the host wires state). */
export const FLEET_V27_TOOLS: Tool[] = createFleetV27Tools();

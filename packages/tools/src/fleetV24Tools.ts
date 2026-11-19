/**
 * Fleet v24 tools (v1.37, Đội T6) — registered in ALL_TOOLS (see tools.ts).
 *
 * Tool chạy thật cho fleet v24 (định nghĩa thuần nằm ở
 * `packages/core/src/fleetV24/toolsV24.ts` — 26 tool, 3 nhóm; file này
 * là bản chạy được, nối vào core qua `@open-bot/core`):
 *
 * - `fleet_v24_register` / `fleet_v24_list` / `fleet_v24_group_by_tag` /
 *   `fleet_v24_group_by_owner` / `fleet_v24_stats` /
 *   `fleet_v24_enable_tag` / `fleet_v24_disable_tag` /
 *   `fleet_v24_pause_tag` / `fleet_v24_resume_tag` /
 *   `fleet_v24_dashboard` — automation dashboard (gom theo tag, lọc
 *   theo owner, thống kê, bật/tắt/pause theo nhóm tag).
 * - `fleet_v24_run_start` / `fleet_v24_run_finish` / `fleet_v24_runs` —
 *   run ledger.
 * - `stophook_v24_record` / `stophook_v24_for_run` /
 *   `stophook_v24_for_automation` / `stophook_v24_unacknowledged` /
 *   `stophook_v24_acknowledge` / `stophook_v24_summary` — stop hook
 *   feedback.
 * - `cidr_v24_add_rule` / `cidr_v24_remove_rule` / `cidr_v24_validate` /
 *   `cidr_v24_evaluate` / `cidr_v24_rules_for_route` /
 *   `cidr_v24_overlaps` / `cidr_v24_audit` — CIDR sandbox rules trong
 *   router UI.
 *
 * Như fleet v23, đây là placeholder trong ALL_TOOLS cho tới khi host
 * bind: `createFleetV24Tools(getState)` với state của host (registry +
 * run ledger + stop-hook store + CIDR rule set). Unbound, tool trả về
 * thông báo "not configured" rõ ràng thay vì đoán state. Tool ghi cần
 * duyệt (`needsApproval: true`); tool KHÔNG tự chạy model hay spawn VM.
 * Thay đổi CIDR rule có hiệu lực ngay cho lần evaluate tiếp theo và
 * được ghi audit trong rule set.
 */

import type { Tool } from '@open-bot/core';
import {
  FleetV24AutomationRegistry,
  FleetV24CidrRuleSet,
  FleetV24RunLedger,
  FleetV24StopHookFeedbackStore,
  buildFleetV24AutomationDashboardPanel,
  buildFleetV24CidrRouterPanel,
  buildFleetV24Dashboard,
  buildFleetV24RunsPanel,
  buildFleetV24StopHookPanel,
  createFleetV24AutomationRegistry,
  createFleetV24CidrRuleSet,
  createFleetV24RunLedger,
  createFleetV24StopHookFeedbackStore,
  parseFleetV24Cidr,
  summarizeFleetV24StopHookFeedback,
  validateFleetV24CidrInput,
} from '@open-bot/core';
import type {
  FleetV24AutomationStatus,
  FleetV24CidrAction,
  FleetV24RunOutcome,
  FleetV24StopAction,
  FleetV24StopTrigger,
} from '@open-bot/core';

/** State fleet v24 host cung cấp cho tools (đọc lười mỗi lần tool chạy). */
export interface FleetV24ToolState {
  /** Registry automation của dashboard (host giữ 1 instance). */
  registry: FleetV24AutomationRegistry;
  /** Run ledger (host giữ 1 instance). */
  ledger: FleetV24RunLedger;
  /** Stop-hook feedback store (host giữ 1 instance). */
  feedback: FleetV24StopHookFeedbackStore;
  /** CIDR rule set của router (host giữ 1 instance). */
  cidr: FleetV24CidrRuleSet;
  /** Dashboard đã build gần nhất (để tool dashboard đọc nhanh). */
  lastDashboard: ReturnType<typeof buildFleetV24Dashboard> | null;
}

export const FLEET_V24_TOOL_NAMES = [
  'fleet_v24_register',
  'fleet_v24_list',
  'fleet_v24_group_by_tag',
  'fleet_v24_group_by_owner',
  'fleet_v24_stats',
  'fleet_v24_enable_tag',
  'fleet_v24_disable_tag',
  'fleet_v24_pause_tag',
  'fleet_v24_resume_tag',
  'fleet_v24_dashboard',
  'fleet_v24_run_start',
  'fleet_v24_run_finish',
  'fleet_v24_runs',
  'stophook_v24_record',
  'stophook_v24_for_run',
  'stophook_v24_for_automation',
  'stophook_v24_unacknowledged',
  'stophook_v24_acknowledge',
  'stophook_v24_summary',
  'cidr_v24_add_rule',
  'cidr_v24_remove_rule',
  'cidr_v24_validate',
  'cidr_v24_evaluate',
  'cidr_v24_rules_for_route',
  'cidr_v24_overlaps',
  'cidr_v24_audit',
] as const;

const NOT_WIRED =
  'Fleet v24 is not configured: the host has not wired fleet state (automation registry, run ledger, stop-hook feedback store, CIDR rule set) into the v24 tools.';

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

function getStringArrayArg(args: Record<string, unknown>, name: string): string[] {
  const value = args[name];
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
    throw new Error(`Argument "${name}" must be an array of strings.`);
  }
  return value as string[];
}

/** Build state trống cho host chưa có state riêng (test + demo). */
export function createEmptyFleetV24ToolState(): FleetV24ToolState {
  return {
    registry: createFleetV24AutomationRegistry(),
    ledger: createFleetV24RunLedger(),
    feedback: createFleetV24StopHookFeedbackStore(),
    cidr: createFleetV24CidrRuleSet('deny'),
    lastDashboard: null,
  };
}

/** true khi mọi tên tool v24 chạy được là duy nhất. */
export function fleetV24ToolNamesUnique(): boolean {
  return new Set(FLEET_V24_TOOL_NAMES).size === FLEET_V24_TOOL_NAMES.length;
}

export function createFleetV24Tools(
  getState?: () => FleetV24ToolState | null | undefined,
): Tool[] {
  const resolveState = (): FleetV24ToolState | null => {
    try {
      return getState?.() ?? null;
    } catch {
      return null;
    }
  };

  const requireState = (): FleetV24ToolState => {
    const state = resolveState();
    if (!state) throw new Error(NOT_WIRED);
    return state;
  };

  const nowMs = (): number => Date.now();

  const tools: Tool[] = [
    // -- automation dashboard ------------------------------------------------
    {
      definition: toolDef(
        'fleet_v24_register',
        'Register an automation in the fleet v24 dashboard with an owner, tags and an optional schedule.',
        {
          id: { type: 'string' },
          name: { type: 'string' },
          owner: { type: 'string' },
          tags: { type: 'array', items: { type: 'string' } },
          schedule: { type: 'string' },
        },
        ['id', 'name', 'owner'],
      ),
      needsApproval: true,
      execute: async (args) => {
        try {
          const state = requireState();
          const automation = state.registry.register(
            {
              id: getStringArg(args, 'id'),
              name: getStringArg(args, 'name'),
              owner: getStringArg(args, 'owner'),
              tags: getStringArrayArg(args, 'tags'),
              schedule: getOptionalStringArg(args, 'schedule'),
            },
            nowMs(),
            'tool',
          );
          return jsonResult(automation);
        } catch (err) {
          return errorResult(err instanceof Error ? err.message : String(err));
        }
      },
    },
    {
      definition: toolDef(
        'fleet_v24_list',
        'List automations, optionally filtered by tag, owner or status.',
        {
          tag: { type: 'string' },
          owner: { type: 'string' },
          status: { type: 'string' },
        },
        [],
      ),
      needsApproval: false,
      execute: async (args) => {
        try {
          const state = requireState();
          const tag = getOptionalStringArg(args, 'tag');
          const owner = getOptionalStringArg(args, 'owner');
          const status = getOptionalStringArg(args, 'status') as FleetV24AutomationStatus | null;
          let list = state.registry.list();
          if (tag) list = list.filter((a) => a.tags.includes(tag.toLowerCase()));
          if (owner) list = list.filter((a) => a.owner === owner);
          if (status) list = list.filter((a) => a.status === status);
          return jsonResult({ total: list.length, automations: list });
        } catch (err) {
          return errorResult(err instanceof Error ? err.message : String(err));
        }
      },
    },
    {
      definition: toolDef(
        'fleet_v24_group_by_tag',
        'Group automations by tag with per-tag stats and owners.',
        {},
        [],
      ),
      needsApproval: false,
      execute: async () => {
        try {
          const state = requireState();
          return jsonResult(state.registry.groupByTag());
        } catch (err) {
          return errorResult(err instanceof Error ? err.message : String(err));
        }
      },
    },
    {
      definition: toolDef(
        'fleet_v24_group_by_owner',
        'Slice automations by owner with per-owner stats and tags.',
        {},
        [],
      ),
      needsApproval: false,
      execute: async () => {
        try {
          const state = requireState();
          return jsonResult(state.registry.groupByOwner());
        } catch (err) {
          return errorResult(err instanceof Error ? err.message : String(err));
        }
      },
    },
    {
      definition: toolDef(
        'fleet_v24_stats',
        'Fleet-wide automation stats, or stats for one tag or one owner.',
        {
          tag: { type: 'string' },
          owner: { type: 'string' },
        },
        [],
      ),
      needsApproval: false,
      execute: async (args) => {
        try {
          const state = requireState();
          const tag = getOptionalStringArg(args, 'tag');
          const owner = getOptionalStringArg(args, 'owner');
          if (tag && owner) {
            return jsonResult({
              scope: `tag=${tag} owner=${owner}`,
              stats: state.registry.statsByTag(tag),
              filtered: state.registry.byTagAndOwner(tag, owner),
            });
          }
          if (tag) return jsonResult({ scope: `tag=${tag}`, stats: state.registry.statsByTag(tag) });
          if (owner) return jsonResult({ scope: `owner=${owner}`, stats: state.registry.statsByOwner(owner) });
          return jsonResult({ scope: 'fleet', stats: state.registry.stats() });
        } catch (err) {
          return errorResult(err instanceof Error ? err.message : String(err));
        }
      },
    },
    {
      definition: toolDef(
        'fleet_v24_enable_tag',
        'Enable every automation carrying a tag.',
        { tag: { type: 'string' } },
        ['tag'],
      ),
      needsApproval: true,
      execute: async (args) => {
        try {
          const state = requireState();
          return jsonResult(state.registry.enableTag(getStringArg(args, 'tag'), nowMs(), 'tool'));
        } catch (err) {
          return errorResult(err instanceof Error ? err.message : String(err));
        }
      },
    },
    {
      definition: toolDef(
        'fleet_v24_disable_tag',
        'Disable every automation carrying a tag.',
        { tag: { type: 'string' } },
        ['tag'],
      ),
      needsApproval: true,
      execute: async (args) => {
        try {
          const state = requireState();
          return jsonResult(state.registry.disableTag(getStringArg(args, 'tag'), nowMs(), 'tool'));
        } catch (err) {
          return errorResult(err instanceof Error ? err.message : String(err));
        }
      },
    },
    {
      definition: toolDef(
        'fleet_v24_pause_tag',
        'Pause every running or idle automation carrying a tag.',
        { tag: { type: 'string' } },
        ['tag'],
      ),
      needsApproval: true,
      execute: async (args) => {
        try {
          const state = requireState();
          return jsonResult(state.registry.pauseTag(getStringArg(args, 'tag'), nowMs(), 'tool'));
        } catch (err) {
          return errorResult(err instanceof Error ? err.message : String(err));
        }
      },
    },
    {
      definition: toolDef(
        'fleet_v24_resume_tag',
        'Resume every paused automation carrying a tag.',
        { tag: { type: 'string' } },
        ['tag'],
      ),
      needsApproval: true,
      execute: async (args) => {
        try {
          const state = requireState();
          return jsonResult(state.registry.resumeTag(getStringArg(args, 'tag'), nowMs(), 'tool'));
        } catch (err) {
          return errorResult(err instanceof Error ? err.message : String(err));
        }
      },
    },
    {
      definition: toolDef(
        'fleet_v24_dashboard',
        'Build the fleet v24 automation dashboard (tag groups, owner slices, stats, runs, stop-hook summary, CIDR rules).',
        {
          tag: { type: 'string' },
          owner: { type: 'string' },
        },
        [],
      ),
      needsApproval: false,
      execute: async (args) => {
        try {
          const state = requireState();
          const tag = getOptionalStringArg(args, 'tag');
          const owner = getOptionalStringArg(args, 'owner');
          const dashboard = buildFleetV24Dashboard(
            state.registry,
            state.ledger,
            state.feedback,
            state.cidr,
            nowMs(),
          );
          // Keep the filtered view alongside the full dashboard when asked.
          const automation = tag || owner
            ? buildFleetV24AutomationDashboardPanel(state.registry, tag, owner)
            : dashboard.automation;
          state.lastDashboard = dashboard;
          return jsonResult({ ...dashboard, automation });
        } catch (err) {
          return errorResult(err instanceof Error ? err.message : String(err));
        }
      },
    },
    // -- run ledger ------------------------------------------------------------
    {
      definition: toolDef(
        'fleet_v24_run_start',
        'Start a run of an automation in the run ledger and mark the automation running.',
        {
          id: { type: 'string' },
          automationId: { type: 'string' },
          trigger: { type: 'string' },
        },
        ['id', 'automationId'],
      ),
      needsApproval: true,
      execute: async (args) => {
        try {
          const state = requireState();
          const automationId = getStringArg(args, 'automationId');
          const automation = state.registry.get(automationId);
          if (!automation) {
            return errorResult(`Automation "${automationId}" is not registered.`);
          }
          const run = state.ledger.start(
            {
              id: getStringArg(args, 'id'),
              automationId,
              owner: automation.owner,
              tags: automation.tags,
              trigger: getOptionalStringArg(args, 'trigger'),
            },
            nowMs(),
          );
          state.registry.setStatus(automationId, 'running', nowMs(), 'tool');
          return jsonResult(run);
        } catch (err) {
          return errorResult(err instanceof Error ? err.message : String(err));
        }
      },
    },
    {
      definition: toolDef(
        'fleet_v24_run_finish',
        'Finish a run as completed, failed, stopped or cancelled.',
        {
          id: { type: 'string' },
          outcome: { type: 'string' },
          error: { type: 'string' },
          stopHookFeedbackId: { type: 'string' },
        },
        ['id', 'outcome'],
      ),
      needsApproval: true,
      execute: async (args) => {
        try {
          const state = requireState();
          const outcome = getStringArg(args, 'outcome') as FleetV24RunOutcome;
          if (outcome === 'running') {
            return errorResult('Outcome "running" is not a finish state.');
          }
          const run = state.ledger.finish(
            getStringArg(args, 'id'),
            outcome,
            nowMs(),
            getOptionalStringArg(args, 'error'),
            getOptionalStringArg(args, 'stopHookFeedbackId'),
          );
          if (!run) {
            return errorResult('Run not found or already finished.');
          }
          state.registry.recordRunOutcome(
            run.automationId,
            outcome === 'cancelled' ? 'stopped' : outcome,
            nowMs(),
            'tool',
          );
          return jsonResult(run);
        } catch (err) {
          return errorResult(err instanceof Error ? err.message : String(err));
        }
      },
    },
    {
      definition: toolDef(
        'fleet_v24_runs',
        'Query runs by automation, tag, owner, outcome or time window; also lists stuck runs.',
        {
          automationId: { type: 'string' },
          tag: { type: 'string' },
          owner: { type: 'string' },
          outcome: { type: 'string' },
          fromMs: { type: 'number' },
          toMs: { type: 'number' },
          stuckAfterMs: { type: 'number' },
        },
        [],
      ),
      needsApproval: false,
      execute: async (args) => {
        try {
          const state = requireState();
          const stuckAfterMs = getNumberArg(args, 'stuckAfterMs', 30 * 60 * 1000);
          const runs = state.ledger.query({
            automationId: getOptionalStringArg(args, 'automationId') ?? undefined,
            tag: getOptionalStringArg(args, 'tag') ?? undefined,
            owner: getOptionalStringArg(args, 'owner') ?? undefined,
            outcome: (getOptionalStringArg(args, 'outcome') as FleetV24RunOutcome | null) ?? undefined,
            fromMs: args.fromMs === undefined ? undefined : getNumberArg(args, 'fromMs', 0),
            toMs: args.toMs === undefined ? undefined : getNumberArg(args, 'toMs', 0),
          });
          return jsonResult({
            total: runs.length,
            runs,
            stuck: state.ledger.stuckRuns(nowMs(), stuckAfterMs),
            panel: buildFleetV24RunsPanel(state.ledger, nowMs(), stuckAfterMs),
          });
        } catch (err) {
          return errorResult(err instanceof Error ? err.message : String(err));
        }
      },
    },
    // -- stop hook feedback ------------------------------------------------------
    {
      definition: toolDef(
        'stophook_v24_record',
        'Record stop-hook feedback when a stop hook fires (reason, trigger, action, suggested next action).',
        {
          id: { type: 'string' },
          runId: { type: 'string' },
          automationId: { type: 'string' },
          reason: { type: 'string' },
          triggeredBy: { type: 'string' },
          triggeredByName: { type: 'string' },
          action: { type: 'string' },
          suggestedNextAction: { type: 'string' },
        },
        ['id', 'runId', 'automationId', 'reason', 'triggeredBy', 'triggeredByName', 'action'],
      ),
      needsApproval: true,
      execute: async (args) => {
        try {
          const state = requireState();
          const record = state.feedback.record(
            {
              id: getStringArg(args, 'id'),
              runId: getStringArg(args, 'runId'),
              automationId: getStringArg(args, 'automationId'),
              reason: getStringArg(args, 'reason'),
              triggeredBy: getStringArg(args, 'triggeredBy') as FleetV24StopTrigger,
              triggeredByName: getStringArg(args, 'triggeredByName'),
              action: getStringArg(args, 'action') as FleetV24StopAction,
              suggestedNextAction: getOptionalStringArg(args, 'suggestedNextAction'),
            },
            nowMs(),
          );
          return jsonResult(record);
        } catch (err) {
          return errorResult(err instanceof Error ? err.message : String(err));
        }
      },
    },
    {
      definition: toolDef(
        'stophook_v24_for_run',
        'Show stop-hook feedback for one run, newest first.',
        { runId: { type: 'string' } },
        ['runId'],
      ),
      needsApproval: false,
      execute: async (args) => {
        try {
          const state = requireState();
          return jsonResult(state.feedback.forRun(getStringArg(args, 'runId')));
        } catch (err) {
          return errorResult(err instanceof Error ? err.message : String(err));
        }
      },
    },
    {
      definition: toolDef(
        'stophook_v24_for_automation',
        'Show stop-hook feedback for one automation with a per-automation summary.',
        { automationId: { type: 'string' } },
        ['automationId'],
      ),
      needsApproval: false,
      execute: async (args) => {
        try {
          const state = requireState();
          const automationId = getStringArg(args, 'automationId');
          return jsonResult({
            automationId,
            feedback: state.feedback.forAutomation(automationId),
            summary: state.feedback.summaryForAutomation(automationId),
          });
        } catch (err) {
          return errorResult(err instanceof Error ? err.message : String(err));
        }
      },
    },
    {
      definition: toolDef(
        'stophook_v24_unacknowledged',
        'List stop-hook feedback not yet acknowledged by an operator.',
        {},
        [],
      ),
      needsApproval: false,
      execute: async () => {
        try {
          const state = requireState();
          return jsonResult(state.feedback.unacknowledged());
        } catch (err) {
          return errorResult(err instanceof Error ? err.message : String(err));
        }
      },
    },
    {
      definition: toolDef(
        'stophook_v24_acknowledge',
        'Acknowledge a stop-hook feedback record as reviewed.',
        {
          id: { type: 'string' },
          acknowledgedBy: { type: 'string' },
          note: { type: 'string' },
        },
        ['id', 'acknowledgedBy'],
      ),
      needsApproval: true,
      execute: async (args) => {
        try {
          const state = requireState();
          const record = state.feedback.acknowledge(
            getStringArg(args, 'id'),
            getStringArg(args, 'acknowledgedBy'),
            nowMs(),
            getOptionalStringArg(args, 'note'),
          );
          if (!record) return errorResult('Stop-hook feedback not found.');
          return jsonResult(record);
        } catch (err) {
          return errorResult(err instanceof Error ? err.message : String(err));
        }
      },
    },
    {
      definition: toolDef(
        'stophook_v24_summary',
        'Summarise stop-hook feedback fleet-wide or per automation.',
        { automationId: { type: 'string' } },
        [],
      ),
      needsApproval: false,
      execute: async (args) => {
        try {
          const state = requireState();
          const automationId = getOptionalStringArg(args, 'automationId');
          if (automationId) {
            return jsonResult(state.feedback.summaryForAutomation(automationId));
          }
          return jsonResult({
            fleet: state.feedback.summary(),
            byAutomation: state.feedback.summariesByAutomation(),
            byTrigger: state.feedback.summariesByTrigger(),
          });
        } catch (err) {
          return errorResult(err instanceof Error ? err.message : String(err));
        }
      },
    },
    // -- CIDR sandbox rules ------------------------------------------------------
    {
      definition: toolDef(
        'cidr_v24_add_rule',
        'Add a CIDR sandbox rule for the router (allow/deny a CIDR range, optionally bound to one route).',
        {
          id: { type: 'string' },
          cidr: { type: 'string' },
          action: { type: 'string' },
          routeId: { type: 'string' },
          priority: { type: 'number' },
          description: { type: 'string' },
        },
        ['id', 'cidr', 'action'],
      ),
      needsApproval: true,
      execute: async (args) => {
        try {
          const state = requireState();
          const rule = state.cidr.add(
            {
              id: getStringArg(args, 'id'),
              cidr: getStringArg(args, 'cidr'),
              action: getStringArg(args, 'action') as FleetV24CidrAction,
              routeId: getOptionalStringArg(args, 'routeId'),
              priority: args.priority === undefined ? undefined : getNumberArg(args, 'priority', 100),
              description: getOptionalStringArg(args, 'description') ?? undefined,
              createdBy: 'tool',
            },
            nowMs(),
            'tool',
          );
          return jsonResult(rule);
        } catch (err) {
          return errorResult(err instanceof Error ? err.message : String(err));
        }
      },
    },
    {
      definition: toolDef(
        'cidr_v24_remove_rule',
        'Remove a CIDR sandbox rule from the router rule set.',
        { id: { type: 'string' } },
        ['id'],
      ),
      needsApproval: true,
      execute: async (args) => {
        try {
          const state = requireState();
          const removed = state.cidr.remove(getStringArg(args, 'id'), nowMs(), 'tool');
          if (!removed) return errorResult('CIDR rule not found.');
          return jsonResult({ removed: true });
        } catch (err) {
          return errorResult(err instanceof Error ? err.message : String(err));
        }
      },
    },
    {
      definition: toolDef(
        'cidr_v24_validate',
        'Validate a CIDR string for the router UI and return the normalised form.',
        { cidr: { type: 'string' } },
        ['cidr'],
      ),
      needsApproval: false,
      execute: async (args) => {
        try {
          const cidr = getStringArg(args, 'cidr');
          const problems = validateFleetV24CidrInput(cidr);
          const parsed = parseFleetV24Cidr(cidr);
          return jsonResult({
            cidr,
            valid: problems.length === 0,
            problems,
            normalised: parsed?.text ?? null,
            prefix: parsed?.prefix ?? null,
            bits: parsed?.bits ?? null,
          });
        } catch (err) {
          return errorResult(err instanceof Error ? err.message : String(err));
        }
      },
    },
    {
      definition: toolDef(
        'cidr_v24_evaluate',
        'Evaluate one (route, IP) pair against the CIDR rules.',
        {
          routeId: { type: 'string' },
          ip: { type: 'string' },
        },
        ['ip'],
      ),
      needsApproval: false,
      execute: async (args) => {
        try {
          const state = requireState();
          return jsonResult(
            state.cidr.evaluate(getOptionalStringArg(args, 'routeId'), getStringArg(args, 'ip')),
          );
        } catch (err) {
          return errorResult(err instanceof Error ? err.message : String(err));
        }
      },
    },
    {
      definition: toolDef(
        'cidr_v24_rules_for_route',
        'List the CIDR rules that apply to one route, in evaluation order.',
        { routeId: { type: 'string' } },
        ['routeId'],
      ),
      needsApproval: false,
      execute: async (args) => {
        try {
          const state = requireState();
          const routeId = getStringArg(args, 'routeId');
          return jsonResult({
            routeId,
            rules: state.cidr.rulesForRoute(routeId),
            panel: buildFleetV24CidrRouterPanel(state.cidr, routeId),
          });
        } catch (err) {
          return errorResult(err instanceof Error ? err.message : String(err));
        }
      },
    },
    {
      definition: toolDef(
        'cidr_v24_overlaps',
        'Detect overlapping enabled CIDR rules and flag conflicting ones.',
        {},
        [],
      ),
      needsApproval: false,
      execute: async () => {
        try {
          const state = requireState();
          return jsonResult(state.cidr.overlaps());
        } catch (err) {
          return errorResult(err instanceof Error ? err.message : String(err));
        }
      },
    },
    {
      definition: toolDef(
        'cidr_v24_audit',
        'Show the CIDR rule audit trail, optionally for one rule.',
        { ruleId: { type: 'string' } },
        [],
      ),
      needsApproval: false,
      execute: async (args) => {
        try {
          const state = requireState();
          const ruleId = getOptionalStringArg(args, 'ruleId');
          return jsonResult(ruleId ? state.cidr.auditFor(ruleId) : state.cidr.auditTrail());
        } catch (err) {
          return errorResult(err instanceof Error ? err.message : String(err));
        }
      },
    },
  ];

  return tools;
}

/** The runnable v24 tools, for ALL_TOOLS (unbound until the host wires state). */
export const FLEET_V24_TOOLS: Tool[] = createFleetV24Tools();

/** Re-export the summary helper for hosts that need it without the store. */
export { summarizeFleetV24StopHookFeedback };

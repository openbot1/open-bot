/**
 * Fleet scheduling v2 + Automations v2 + Composio v112 + MCP Apps v112
 * tools (v1.12, Doi T6) — registered in ALL_TOOLS (see tools.ts).
 *
 * Fleet scheduling v2 (6):
 * - `fleet_schedule_create_v9` — tao lich cron/interval/once/window
 *   (can approval, can bind). Luu vao <userData>/fleet/
 *   fleet-schedules-v112.json.
 * - `fleet_schedule_list_v9` — liet ke lich + tom tat queue (can bind, chi doc).
 * - `fleet_schedule_enable_v9` — bat/tat mot lich (can approval, can bind).
 * - `fleet_queue_tick_v9` — chay 1 tick: schedule toi gio -> enqueue,
 *   mo retry, chon entry start theo CPU/RAM host (can approval, can bind).
 * - `fleet_queue_list_v9` — liet ke hang doi (can bind, chi doc).
 * - `fleet_day_plan_v9` — lap lich ngay (timeslot) tu danh sach entry
 *   truyen vao — ham thuan, chay duoc ngay ca khi chua bind.
 *
 * Automations v2 (4):
 * - `automation_v2_create` — tao automation (trigger time/file/
 *   webhook-local/manual + chain step) (can approval, can bind).
 * - `automation_v2_list` — liet ke automation (can bind, chi doc).
 * - `automation_v2_dry_run` — preview mot automation voi mot event ma
 *   khong thuc thi — ham thuan, chay duoc ngay ca khi chua bind.
 * - `automation_v2_run_log` — doc run log v2 (can bind, chi doc).
 *
 * Composio v112 (2, mock-only):
 * - `composio_mock_toolkit_list_v112` — liet ke 6 toolkit Composio
 *   MOCK v112 (grafana/elasticsearch/bigquery/clickhouse/
 *   launchdarkly/greenhouse) + slug ung vien. Chay duoc ngay, khong can key.
 * - `composio_mock_toolkit_execute_v112` — chay mot tool mock bang
 *   du lieu mau local (khong goi mang, khong can key). Response luon
 *   mang `mock: true, live: false`.
 *
 * MCP Apps v112 (3):
 * - `mcp_app_catalogue_v112` — tim kiem/loc catalogue 12 app + kiem
 *   tra tuong thich tren host (ham thuan, chay duoc ngay).
 * - `mcp_app_install_v112` — cai app (can approval, can bind; tu choi
 *   app khong tuong thich).
 * - `mcp_app_uninstall_v112` — go app (can approval, can bind).
 *
 * Nhu cac tool fleet truoc, tool can file la placeholder trong
 * ALL_TOOLS cho toi khi host bind: `createFleetV9Tools(getBaseDir)`
 * voi userData dir cua app. Tool ghi file can approval; tool chi doc
 * thi khong.
 */

import * as path from 'node:path';
import type { Tool } from '@open-bot/core';
import {
  AUTOMATION_V2_TRIGGER_KINDS,
  COMPOSIO_V112_MOCK_TOOLKITS,
  DEFAULT_FLEET_V9_HOST_CAPACITY,
  DEFAULT_FLEET_V9_SCHEDULER_POLICY,
  DEFAULT_MCP_APP_V112_HOST_CAPS,
  FLEET_V9_SCHEDULE_KINDS,
  MCP_APPS_V112_CATALOGUE,
  MCP_APP_V112_CATEGORIES,
  createAutomationV2,
  createFleetV9Schedule,
  dryRunAutomationV2,
  executeMockComposioV112Tool,
  findFleetV9Schedule,
  installMcpAppV112,
  listAutomationV2Runs,
  loadAutomationsV2,
  loadFleetV9Queue,
  loadFleetV9Schedules,
  loadMcpAppV112Installs,
  parseFleetV9CronString,
  planFleetV9Day,
  saveAutomationsV2,
  saveFleetV9Queue,
  saveFleetV9Schedules,
  saveMcpAppV112Installs,
  searchMcpAppsV112,
  setFleetV9ScheduleEnabled,
  summarizeAutomationV2Runs,
  summarizeFleetV9Scheduling,
  summarizeMcpAppsV112,
  tickFleetV9Scheduler,
  uninstallMcpAppV112,
  validateAutomationV2,
  validateFleetV9HostCapacity,
  validateFleetV9QueueEntry,
  validateFleetV9SchedulerPolicy,
  validateFleetV9TimeWindow,
  type AutomationV2,
  type AutomationV2Event,
  type AutomationV2Trigger,
  type FleetV9HostCapacity,
  type FleetV9QueueEntry,
  type FleetV9ScheduleKind,
  type FleetV9SchedulerPolicy,
  type FleetV9TimeWindow,
  type McpAppV112Category,
  type McpAppV112HostCaps,
} from '@open-bot/core';

export const FLEET_V9_TOOL_NAMES = [
  'fleet_schedule_create_v9',
  'fleet_schedule_list_v9',
  'fleet_schedule_enable_v9',
  'fleet_queue_tick_v9',
  'fleet_queue_list_v9',
  'fleet_day_plan_v9',
  'automation_v2_create',
  'automation_v2_list',
  'automation_v2_dry_run',
  'automation_v2_run_log',
  'composio_mock_toolkit_list_v112',
  'composio_mock_toolkit_execute_v112',
  'mcp_app_catalogue_v112',
  'mcp_app_install_v112',
  'mcp_app_uninstall_v112',
] as const;

export function isFleetV9ToolName(name: string): boolean {
  return (FLEET_V9_TOOL_NAMES as readonly string[]).includes(name);
}

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

function okResult(value: unknown): string {
  return JSON.stringify(value, null, 2);
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

function getNumberArg(args: Record<string, unknown>, name: string, fallback: number): number {
  const value = args[name];
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Argument "${name}" must be a number.`);
  }
  return value;
}

function getBooleanArg(args: Record<string, unknown>, name: string, fallback: boolean): boolean {
  const value = args[name];
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'boolean') {
    throw new Error(`Argument "${name}" must be a boolean.`);
  }
  return value;
}

function getObjectArg(args: Record<string, unknown>, name: string, required = false): Record<string, unknown> {
  const value = args[name];
  if (value === undefined || value === null) {
    if (required) throw new Error(`Missing required argument: "${name}"`);
    return {};
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Argument "${name}" must be an object.`);
  }
  return value as Record<string, unknown>;
}

function getObjectArrayArg(args: Record<string, unknown>, name: string, required = false): Record<string, unknown>[] {
  const value = args[name];
  if (value === undefined || value === null) {
    if (required) throw new Error(`Missing required argument: "${name}"`);
    return [];
  }
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'object' || v === null || Array.isArray(v))) {
    throw new Error(`Argument "${name}" must be an array of objects.`);
  }
  return [...(value as Record<string, unknown>[])];
}

function getStringArrayArg(args: Record<string, unknown>, name: string): string[] {
  const value = args[name];
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
    throw new Error(`Argument "${name}" must be an array of strings.`);
  }
  return [...(value as string[])];
}

const NOT_WIRED =
  'fleet v9 tools are not wired in this host (no userData dir configured) — open the fleet console UI instead.';

/** Fleet root + automations dir + userData dir derived from the app userData dir. */
function dirs(baseDir: string): { fleetRoot: string; automationsDir: string; userDataDir: string } {
  return {
    fleetRoot: path.join(baseDir, 'fleet'),
    automationsDir: path.join(baseDir, 'automations'),
    userDataDir: baseDir,
  };
}

function parseHostCapacity(args: Record<string, unknown>): FleetV9HostCapacity {
  return validateFleetV9HostCapacity({
    cpuCores: getNumberArg(args, 'hostCpuCores', DEFAULT_FLEET_V9_HOST_CAPACITY.cpuCores),
    ramBytes: getNumberArg(args, 'hostRamBytes', DEFAULT_FLEET_V9_HOST_CAPACITY.ramBytes),
    maxConcurrent: getNumberArg(args, 'hostMaxConcurrent', 0),
  });
}

function parsePolicy(args: Record<string, unknown>): FleetV9SchedulerPolicy {
  return validateFleetV9SchedulerPolicy({
    maxConcurrent: getNumberArg(args, 'maxConcurrent', DEFAULT_FLEET_V9_SCHEDULER_POLICY.maxConcurrent),
    maxConcurrentPerBot: getNumberArg(args, 'maxConcurrentPerBot', DEFAULT_FLEET_V9_SCHEDULER_POLICY.maxConcurrentPerBot),
    maxHeavyConcurrent: getNumberArg(args, 'maxHeavyConcurrent', DEFAULT_FLEET_V9_SCHEDULER_POLICY.maxHeavyConcurrent),
    agingMs: getNumberArg(args, 'agingMs', DEFAULT_FLEET_V9_SCHEDULER_POLICY.agingMs),
    defaultMaxAttempts: getNumberArg(args, 'defaultMaxAttempts', DEFAULT_FLEET_V9_SCHEDULER_POLICY.defaultMaxAttempts),
    defaultBackoffMs: getNumberArg(args, 'defaultBackoffMs', DEFAULT_FLEET_V9_SCHEDULER_POLICY.defaultBackoffMs),
    backoffMultiplier: getNumberArg(args, 'backoffMultiplier', DEFAULT_FLEET_V9_SCHEDULER_POLICY.backoffMultiplier),
    maxBackoffMs: getNumberArg(args, 'maxBackoffMs', DEFAULT_FLEET_V9_SCHEDULER_POLICY.maxBackoffMs),
  });
}

function parseTimeWindow(args: Record<string, unknown>): FleetV9TimeWindow {
  const raw = getObjectArg(args, 'window', true);
  const window: FleetV9TimeWindow = {
    startHour: typeof raw['startHour'] === 'number' ? raw['startHour'] : NaN,
    startMinute: typeof raw['startMinute'] === 'number' ? raw['startMinute'] : NaN,
    endHour: typeof raw['endHour'] === 'number' ? raw['endHour'] : NaN,
    endMinute: typeof raw['endMinute'] === 'number' ? raw['endMinute'] : NaN,
  };
  return validateFleetV9TimeWindow(window);
}

function parseQueueEntries(args: Record<string, unknown>): FleetV9QueueEntry[] {
  const raw = getObjectArrayArg(args, 'entries', true);
  if (raw.length === 0) throw new Error('Argument "entries" must be a non-empty array.');
  return raw.map((entry, i) => {
    try {
      return validateFleetV9QueueEntry(entry);
    } catch (err) {
      throw new Error(`entries[${i}] is invalid: ${(err as Error).message}`);
    }
  });
}

function parseHostCaps(args: Record<string, unknown>): McpAppV112HostCaps {
  const granted = getStringArrayArg(args, 'grantedPermissions');
  return {
    hostVersion: getStringArg(args, 'hostVersion', false) || DEFAULT_MCP_APP_V112_HOST_CAPS.hostVersion,
    grantedPermissions: (granted.length > 0 ? granted : [...DEFAULT_MCP_APP_V112_HOST_CAPS.grantedPermissions]) as McpAppV112HostCaps['grantedPermissions'],
    allowNetwork: getBooleanArg(args, 'allowNetwork', DEFAULT_MCP_APP_V112_HOST_CAPS.allowNetwork),
    sandboxStrict: getBooleanArg(args, 'sandboxStrict', DEFAULT_MCP_APP_V112_HOST_CAPS.sandboxStrict),
  };
}

export function createFleetV9Tools(
  getBaseDir?: () => string | null | undefined,
): Tool[] {
  const resolveBase = (): string | null => {
    try {
      const dir = getBaseDir?.();
      return typeof dir === 'string' && dir.trim().length > 0 ? dir : null;
    } catch {
      return null;
    }
  };

  const scheduleCreateTool: Tool = {
    definition: toolDef(
      'fleet_schedule_create_v9',
      'Create a fleet v9 schedule (cron / interval / once / daily time-window) for a bot. The schedule is persisted to <userData>/fleet/fleet-schedules-v112.json. Needs approval; needs the fleet tools wired.',
      {
        botId: { type: 'string', description: 'Bot id the schedule runs.' },
        name: { type: 'string', description: 'Schedule name (non-empty).' },
        kind: { type: 'string', enum: [...FLEET_V9_SCHEDULE_KINDS], description: 'Schedule kind.' },
        cron: { type: 'string', description: 'Cron expression "m h dom mon dow" (kind cron only).' },
        intervalMs: { type: 'number', description: 'Repeat every N ms (kind interval only).' },
        runAtMs: { type: 'number', description: 'Epoch ms to run once (kind once only).' },
        window: {
          type: 'object',
          properties: {
            startHour: { type: 'number', description: 'Window start hour 0-23.' },
            startMinute: { type: 'number', description: 'Window start minute 0-59.' },
            endHour: { type: 'number', description: 'Window end hour 0-23.' },
            endMinute: { type: 'number', description: 'Window end minute 0-59.' },
          },
          required: ['startHour', 'startMinute', 'endHour', 'endMinute'],
          additionalProperties: false,
          description: 'Daily time window (kind window only).',
        },
        priority: { type: 'string', enum: ['critical', 'high', 'normal', 'low'], description: 'Priority (default normal).' },
        cpuCores: { type: 'number', description: 'CPU cores the run reserves (default 1).' },
        ramBytes: { type: 'number', description: 'RAM in bytes the run reserves (default 512MB).' },
        maxAttempts: { type: 'number', description: 'Retries on failure (default 3).' },
        backoffMs: { type: 'number', description: 'Base retry backoff in ms (default 30000).' },
        enabled: { type: 'boolean', description: 'Whether the schedule is active (default true).' },
      },
      ['botId', 'name', 'kind'],
    ),
    needsApproval: true,
    execute: async (args) => {
      const base = resolveBase();
      if (!base) return errorResult(NOT_WIRED);
      try {
        const kind = getStringArg(args, 'kind') as FleetV9ScheduleKind;
        const schedule = createFleetV9Schedule({
          botId: getStringArg(args, 'botId'),
          name: getStringArg(args, 'name'),
          kind,
          cron: args['cron'] === undefined || args['cron'] === null ? undefined : parseFleetV9CronString(getStringArg(args, 'cron')),
          intervalMs: args['intervalMs'] === undefined ? undefined : getNumberArg(args, 'intervalMs', 0),
          runAtMs: args['runAtMs'] === undefined ? undefined : getNumberArg(args, 'runAtMs', 0),
          window: args['window'] === undefined ? undefined : parseTimeWindow(args),
          priority: (args['priority'] as 'critical' | 'high' | 'normal' | 'low' | undefined) ?? undefined,
          resources: {
            cpuCores: getNumberArg(args, 'cpuCores', 1),
            ramBytes: getNumberArg(args, 'ramBytes', 512 * 1024 * 1024),
          },
          maxAttempts: args['maxAttempts'] === undefined ? undefined : getNumberArg(args, 'maxAttempts', 3),
          backoffMs: args['backoffMs'] === undefined ? undefined : getNumberArg(args, 'backoffMs', 30000),
          enabled: getBooleanArg(args, 'enabled', true),
        });
        const { fleetRoot } = dirs(base);
        const schedules = loadFleetV9Schedules(fleetRoot);
        schedules.push(schedule);
        saveFleetV9Schedules(fleetRoot, schedules);
        return okResult(schedule);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const scheduleListTool: Tool = {
    definition: toolDef(
      'fleet_schedule_list_v9',
      'List fleet v9 schedules + queue summary from <userData>/fleet. Read-only; needs the fleet tools wired.',
      {},
      [],
    ),
    needsApproval: false,
    execute: async () => {
      const base = resolveBase();
      if (!base) return errorResult(NOT_WIRED);
      try {
        const { fleetRoot } = dirs(base);
        const schedules = loadFleetV9Schedules(fleetRoot);
        const queue = loadFleetV9Queue(fleetRoot);
        return okResult({ schedules, summary: summarizeFleetV9Scheduling(schedules, queue) });
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const scheduleEnableTool: Tool = {
    definition: toolDef(
      'fleet_schedule_enable_v9',
      'Enable or disable one fleet v9 schedule by id. Needs approval; needs the fleet tools wired.',
      {
        scheduleId: { type: 'string', description: 'Schedule id.' },
        enabled: { type: 'boolean', description: 'True to enable, false to disable.' },
      },
      ['scheduleId', 'enabled'],
    ),
    needsApproval: true,
    execute: async (args) => {
      const base = resolveBase();
      if (!base) return errorResult(NOT_WIRED);
      try {
        const { fleetRoot } = dirs(base);
        const schedules = loadFleetV9Schedules(fleetRoot);
        const updated = setFleetV9ScheduleEnabled(schedules, getStringArg(args, 'scheduleId'), getBooleanArg(args, 'enabled', true));
        saveFleetV9Schedules(fleetRoot, updated);
        return okResult(findFleetV9Schedule(updated, getStringArg(args, 'scheduleId')));
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const queueTickTool: Tool = {
    definition: toolDef(
      'fleet_queue_tick_v9',
      'Run one fleet v9 scheduler tick: enqueue due schedules (at most one per schedule, missed runs past the grace window are recorded not enqueued), reopen due retries, and start ready entries that fit host CPU/RAM/concurrency limits. Needs approval; needs the fleet tools wired.',
      {
        hostCpuCores: { type: 'number', description: 'Host CPU cores (0 = unknown, no CPU limit).' },
        hostRamBytes: { type: 'number', description: 'Host RAM in bytes (0 = unknown, no RAM limit).' },
        hostMaxConcurrent: { type: 'number', description: 'Max concurrent bots on the host (0 = use policy).' },
        maxConcurrent: { type: 'number', description: 'Policy max concurrent (default 4).' },
        maxConcurrentPerBot: { type: 'number', description: 'Policy max concurrent per bot (default 1).' },
        missedGraceMs: { type: 'number', description: 'Missed-run grace in ms (default 3600000).' },
      },
      [],
    ),
    needsApproval: true,
    execute: async (args) => {
      const base = resolveBase();
      if (!base) return errorResult(NOT_WIRED);
      try {
        const { fleetRoot } = dirs(base);
        const schedules = loadFleetV9Schedules(fleetRoot);
        const queue = loadFleetV9Queue(fleetRoot);
        const { schedules: nextSchedules, result } = tickFleetV9Scheduler(schedules, queue, Date.now(), {
          policy: parsePolicy(args),
          host: parseHostCapacity(args),
          missedGraceMs: getNumberArg(args, 'missedGraceMs', 60 * 60 * 1000),
        });
        saveFleetV9Schedules(fleetRoot, nextSchedules);
        saveFleetV9Queue(fleetRoot, result.queue);
        return okResult({
          enqueued: result.enqueued,
          started: result.started,
          reopened: result.reopened,
          missed: result.missed,
          summary: summarizeFleetV9Scheduling(nextSchedules, result.queue, result.missed.length),
        });
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const queueListTool: Tool = {
    definition: toolDef(
      'fleet_queue_list_v9',
      'List the fleet v9 run queue from <userData>/fleet/fleet-queue-v112.json. Read-only; needs the fleet tools wired.',
      {
        status: { type: 'string', enum: ['queued', 'running', 'retry-waiting', 'done', 'failed', 'cancelled'], description: 'Filter by status.' },
      },
      [],
    ),
    needsApproval: false,
    execute: async (args) => {
      const base = resolveBase();
      if (!base) return errorResult(NOT_WIRED);
      try {
        const { fleetRoot } = dirs(base);
        const queue = loadFleetV9Queue(fleetRoot);
        const status = args['status'] === undefined ? undefined : getStringArg(args, 'status', false);
        return okResult(status ? queue.filter((e) => e.status === status) : queue);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const dayPlanTool: Tool = {
    definition: toolDef(
      'fleet_day_plan_v9',
      'Plan one day of fleet v9 runs into timeslots from a list of queue entries (priority order, heavy bots never overlap, per-slot CPU/RAM/concurrency caps). Pure function — runs even before the fleet tools are wired.',
      {
        entries: {
          type: 'array',
          items: { type: 'object', description: 'A fleet v9 queue entry object.' },
          description: 'Queue entries to plan (non-empty).',
        },
        dayStartMs: { type: 'number', description: 'Epoch ms of the start of the day to plan.' },
        slotMs: { type: 'number', description: 'Timeslot length in ms (default 900000 = 15 min).' },
        hostCpuCores: { type: 'number', description: 'Host CPU cores (0 = unknown).' },
        hostRamBytes: { type: 'number', description: 'Host RAM in bytes (0 = unknown).' },
        hostMaxConcurrent: { type: 'number', description: 'Max concurrent bots (0 = use policy).' },
      },
      ['entries', 'dayStartMs'],
    ),
    needsApproval: false,
    execute: async (args) => {
      try {
        const plan = planFleetV9Day(parseQueueEntries(args), getNumberArg(args, 'dayStartMs', 0), {
          slotMs: getNumberArg(args, 'slotMs', 15 * 60 * 1000),
          host: parseHostCapacity(args),
        });
        return okResult(plan);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const automationCreateTool: Tool = {
    definition: toolDef(
      'automation_v2_create',
      'Create an automation v2 (trigger: time-cron / time-interval / time-once / file glob / webhook-local / manual; then a conditional action chain of run-agent / run-tool / notify / create-task / set-variable / wait steps). Persisted to <userData>/automations/automations-v112.json. Needs approval; needs the fleet tools wired.',
      {
        botId: { type: 'string', description: 'Bot the automation belongs to.' },
        name: { type: 'string', description: 'Automation name (non-empty).' },
        description: { type: 'string', description: 'Short description.' },
        trigger: { type: 'object', description: 'Trigger object, e.g. {"kind":"time-cron","expression":"0 9 * * *"} or {"kind":"file","pathPattern":"notes/**.md","events":["modified"]}.' },
        condition: { type: 'object', description: 'Optional condition tree, e.g. {"op":"contains","field":"path","value":".md"}.' },
        steps: {
          type: 'array',
          items: { type: 'object', description: 'An action step, e.g. {"id":"s1","kind":"notify","message":"hi","onError":"continue"}.' },
          description: 'Action chain steps (non-empty, max 20).',
        },
        cooldownMs: { type: 'number', description: 'Cooldown between runs in ms (default 60000).' },
        enabled: { type: 'boolean', description: 'Whether the automation is active (default true).' },
      },
      ['botId', 'name', 'trigger', 'steps'],
    ),
    needsApproval: true,
    execute: async (args) => {
      const base = resolveBase();
      if (!base) return errorResult(NOT_WIRED);
      try {
        const trigger = getObjectArg(args, 'trigger', true) as unknown as AutomationV2Trigger;
        if (!AUTOMATION_V2_TRIGGER_KINDS.includes((trigger as { kind?: string }).kind as string)) {
          throw new Error(`trigger.kind must be one of: ${AUTOMATION_V2_TRIGGER_KINDS.join(', ')}.`);
        }
        const steps = getObjectArrayArg(args, 'steps', true) as unknown as AutomationV2['steps'];
        const automation = createAutomationV2({
          botId: getStringArg(args, 'botId'),
          name: getStringArg(args, 'name'),
          description: getStringArg(args, 'description', false),
          trigger,
          condition: args['condition'] === undefined ? undefined : (getObjectArg(args, 'condition') as unknown as AutomationV2['condition']),
          steps,
          cooldownMs: args['cooldownMs'] === undefined ? undefined : getNumberArg(args, 'cooldownMs', 60000),
          enabled: getBooleanArg(args, 'enabled', true),
        });
        const { automationsDir } = dirs(base);
        const automations = loadAutomationsV2(automationsDir);
        automations.push(automation);
        saveAutomationsV2(automationsDir, automations);
        return okResult(automation);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const automationListTool: Tool = {
    definition: toolDef(
      'automation_v2_list',
      'List automations v2 from <userData>/automations/automations-v112.json. Read-only; needs the fleet tools wired.',
      {
        enabledOnly: { type: 'boolean', description: 'Only list enabled automations (default false).' },
      },
      [],
    ),
    needsApproval: false,
    execute: async (args) => {
      const base = resolveBase();
      if (!base) return errorResult(NOT_WIRED);
      try {
        const { automationsDir } = dirs(base);
        const automations = loadAutomationsV2(automationsDir);
        const enabledOnly = getBooleanArg(args, 'enabledOnly', false);
        return okResult(enabledOnly ? automations.filter((a) => a.enabled) : automations);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const automationDryRunTool: Tool = {
    definition: toolDef(
      'automation_v2_dry_run',
      'Dry-run an automation v2 against an event: reports whether it would run and which steps would run, without executing anything. Pure function — runs even before the fleet tools are wired.',
      {
        automation: { type: 'object', description: 'The automation v2 object.' },
        event: { type: 'object', description: 'The event object, e.g. {"type":"file","path":"notes/a.md","eventKind":"modified","atMs":0}.' },
      },
      ['automation', 'event'],
    ),
    needsApproval: false,
    execute: async (args) => {
      try {
        const automation = validateAutomationV2(getObjectArg(args, 'automation', true));
        const event = getObjectArg(args, 'event', true) as unknown as AutomationV2Event;
        if (typeof event.type !== 'string') throw new Error('event.type must be a string.');
        return okResult(dryRunAutomationV2(automation, event));
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const automationRunLogTool: Tool = {
    definition: toolDef(
      'automation_v2_run_log',
      'Read the automations v2 run log (<userData>/automations/automations-v112-runs.jsonl) with a status summary. Read-only; needs the fleet tools wired.',
      {
        automationId: { type: 'string', description: 'Filter by automation id.' },
        limit: { type: 'number', description: 'Max runs to return (default 20, newest last).' },
      },
      [],
    ),
    needsApproval: false,
    execute: async (args) => {
      const base = resolveBase();
      if (!base) return errorResult(NOT_WIRED);
      try {
        const { automationsDir } = dirs(base);
        const runs = listAutomationV2Runs(automationsDir);
        const automationId = args['automationId'] === undefined ? undefined : getStringArg(args, 'automationId', false);
        const filtered = automationId ? runs.filter((r) => r.automationId === automationId) : runs;
        const limit = Math.max(0, Math.floor(getNumberArg(args, 'limit', 20)));
        const trimmed = limit > 0 ? filtered.slice(-limit) : filtered;
        return okResult({ runs: trimmed, summary: summarizeAutomationV2Runs(filtered) });
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const composioListTool: Tool = {
    definition: toolDef(
      'composio_mock_toolkit_list_v112',
      'List the 6 Composio MOCK toolkits v112 (grafana, elasticsearch, bigquery, clickhouse, launchdarkly, greenhouse) with their candidate tool slugs. Mock-only: no live call, no API key needed.',
      {},
      [],
    ),
    needsApproval: false,
    execute: async () => {
      try {
        return okResult(
          COMPOSIO_V112_MOCK_TOOLKITS.map((t) => ({
            slug: t.slug,
            label: t.label,
            icon: t.icon,
            description: t.description,
            candidateToolSlugs: [...t.candidateToolSlugs],
            mockOnly: t.mockOnly,
            liveVerified: t.liveVerified,
          })),
        );
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const composioExecuteTool: Tool = {
    definition: toolDef(
      'composio_mock_toolkit_execute_v112',
      'Run one Composio MOCK toolkit tool v112 with deterministic local sample data (no network, no API key). The response always carries mock:true, live:false. Unknown toolkit/slug returns an Error string.',
      {
        toolkit: { type: 'string', description: 'Mock toolkit slug, e.g. grafana.' },
        slug: { type: 'string', description: 'Candidate tool slug, e.g. GRAFANA_LIST_DASHBOARDS.' },
        args: { type: 'object', description: 'Tool arguments (echoed back in data.echo).' },
      },
      ['toolkit', 'slug'],
    ),
    needsApproval: false,
    execute: async (args) => {
      try {
        const result = executeMockComposioV112Tool(
          getStringArg(args, 'toolkit'),
          getStringArg(args, 'slug'),
          getObjectArg(args, 'args'),
        );
        return okResult(result);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const mcpCatalogueTool: Tool = {
    definition: toolDef(
      'mcp_app_catalogue_v112',
      'Search the MCP Apps v112 catalogue (12 built-in apps) with per-app install state and host compatibility. Pure function — runs even before the fleet tools are wired.',
      {
        query: { type: 'string', description: 'Search text (name/description/tags, empty = all).' },
        category: { type: 'string', enum: [...MCP_APP_V112_CATEGORIES], description: 'Filter by category.' },
        onlyCompatible: { type: 'boolean', description: 'Only show apps compatible with this host (default false).' },
        hostVersion: { type: 'string', description: 'Host version for compatibility (default 0.2.0).' },
        grantedPermissions: { type: 'array', items: { type: 'string' }, description: 'Permissions the host grants (default read-files, clipboard, notifications).' },
        allowNetwork: { type: 'boolean', description: 'Whether the host allows app network access (default false).' },
        sandboxStrict: { type: 'boolean', description: 'Whether the host sandbox is strict (default true).' },
      },
      [],
    ),
    needsApproval: false,
    execute: async (args) => {
      try {
        const hostCaps = parseHostCaps(args);
        const query = getStringArg(args, 'query', false);
        const category = args['category'] === undefined ? undefined : (getStringArg(args, 'category') as McpAppV112Category);
        const onlyCompatible = getBooleanArg(args, 'onlyCompatible', false);
        const matched = searchMcpAppsV112(query, { category, onlyCompatible, hostCaps });
        const base = resolveBase();
        const installs = base ? loadMcpAppV112Installs(base) : [];
        const summary = summarizeMcpAppsV112(MCP_APPS_V112_CATALOGUE, installs, hostCaps);
        const byId = new Map(summary.map((s) => [s.app.id, s]));
        return okResult(
          matched.map((app) => {
            const s = byId.get(app.id) as ReturnType<typeof summarizeMcpAppsV112>[number];
            return {
              app,
              installed: s.installed,
              enabled: s.enabled,
              compatible: s.compatible,
              incompatibilityReasons: s.incompatibilityReasons,
            };
          }),
        );
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const mcpInstallTool: Tool = {
    definition: toolDef(
      'mcp_app_install_v112',
      'Install one MCP App v112 from the catalogue. Refuses incompatible apps (fail-closed). State is saved to <userData>/mcp-apps-v112.json. Needs approval; needs the fleet tools wired.',
      {
        appId: { type: 'string', description: 'App id from the catalogue, e.g. kanban-board.' },
        hostVersion: { type: 'string', description: 'Host version for compatibility (default 0.2.0).' },
        grantedPermissions: { type: 'array', items: { type: 'string' }, description: 'Permissions the host grants.' },
        allowNetwork: { type: 'boolean', description: 'Whether the host allows app network access (default false).' },
        sandboxStrict: { type: 'boolean', description: 'Whether the host sandbox is strict (default true).' },
      },
      ['appId'],
    ),
    needsApproval: true,
    execute: async (args) => {
      const base = resolveBase();
      if (!base) return errorResult(NOT_WIRED);
      try {
        const hostCaps = parseHostCaps(args);
        const installs = loadMcpAppV112Installs(base);
        const { installs: next, install } = installMcpAppV112(
          installs,
          MCP_APPS_V112_CATALOGUE,
          getStringArg(args, 'appId'),
          hostCaps,
        );
        saveMcpAppV112Installs(base, next);
        return okResult(install);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const mcpUninstallTool: Tool = {
    definition: toolDef(
      'mcp_app_uninstall_v112',
      'Uninstall one MCP App v112 (removes its install state from <userData>/mcp-apps-v112.json). Needs approval; needs the fleet tools wired.',
      {
        appId: { type: 'string', description: 'App id to uninstall.' },
      },
      ['appId'],
    ),
    needsApproval: true,
    execute: async (args) => {
      const base = resolveBase();
      if (!base) return errorResult(NOT_WIRED);
      try {
        const installs = loadMcpAppV112Installs(base);
        const next = uninstallMcpAppV112(installs, getStringArg(args, 'appId'));
        saveMcpAppV112Installs(base, next);
        return okResult({ uninstalled: getStringArg(args, 'appId'), remaining: next.length });
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  return [
    scheduleCreateTool,
    scheduleListTool,
    scheduleEnableTool,
    queueTickTool,
    queueListTool,
    dayPlanTool,
    automationCreateTool,
    automationListTool,
    automationDryRunTool,
    automationRunLogTool,
    composioListTool,
    composioExecuteTool,
    mcpCatalogueTool,
    mcpInstallTool,
    mcpUninstallTool,
  ];
}

export const FLEET_V9_TOOLS: Tool[] = createFleetV9Tools();

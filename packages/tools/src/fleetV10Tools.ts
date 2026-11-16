/**
 * Fleet platform v10 tools (v1.13, Doi T6) — KHONG dang ky trong
 * ALL_TOOLS (coordinator se noi sau, xem ghi chu o cuoi file).
 *
 * Event-triggered agents (3):
 * - `fleet_trigger_create_v10` — tao trigger (file-changed /
 *   webhook-local / calendar-due / message-inbound / agent-done /
 *   queue-depth) voi dieu kien loc + debounce/throttle/cooldown/
 *   gioi han theo gio. Luu vao <userData>/fleet/
 *   fleet-triggers-v113.json. Can approval, can bind.
 * - `fleet_trigger_list_v10` — liet ke trigger + tom tat lich su
 *   chay (can bind, chi doc).
 * - `fleet_trigger_evaluate_v10` — danh gia 1 su kien cho cac
 *   trigger: tra ve quyet dinh fire/debounced/throttled/filtered
 *   ma khong chay agent (ham thuan, chay duoc ngay ca khi chua bind
 *   neu truyen `triggers` vao).
 *
 * Scheduled agents, timezone-aware (3):
 * - `fleet_schedule_create_v10` — tao lich cron (mui gio IANA) /
 *   interval / once. Luu vao <userData>/fleet/
 *   fleet-schedules-v113.json. Can approval, can bind.
 * - `fleet_schedule_list_v10` — liet ke lich + tom tat chay 24h
 *   (can bind, chi doc).
 * - `fleet_schedule_tick_v10` — chay 1 tick: lich toi gio -> start,
 *   skip khi agent dang chay, ghi missed khi lo qua grace, mo lai
 *   retry toi gio (can approval, can bind).
 *
 * Multi-user fleet (2):
 * - `fleet_user_create_v10` — tao user noi bo (local, khong phai
 *   tai khoan cloud) + quota mac dinh. Luu vao <userData>/fleet/
 *   fleet-users-v113.json. Can approval, can bind.
 * - `fleet_user_quota_check_v10` — kiem tra muc su dung cua user co
 *   vuot quota khong (ham thuan, chay duoc ngay ca khi chua bind
 *   neu truyen `quota` + `usage` vao).
 *
 * ACP Control Center — fleet dashboard (3):
 * - `fleet_dashboard_snapshot_v10` — xay snapshot dashboard fleet
 *   (agent dang chay, hang doi, tai nguyen, theo user, canh bao) tu
 *   du lieu truyen vao (ham thuan, chay duoc ngay, khong can bind).
 * - `fleet_agent_control_v10` — dieu khien agent tu xa (start /
 *   stop / pause / resume) theo may trang thai, luu trang thai
 *   runtime vao <userData>/fleet/fleet-agent-runtime-v113.json.
 *   Can approval, can bind.
 * - `fleet_log_tail_v10` — doc N dong cuoi log cua mot agent (duong
 *   dan phai nam trong <userData>/fleet, can bind, chi doc).
 *
 * Nhu cac tool fleet truoc, tool can file la placeholder trong
 * ALL_TOOLS cho toi khi host bind: `createFleetV10Tools(getBaseDir)`
 * voi userData dir cua app. Tool ghi file can approval; tool chi doc
 * thi khong. KHONG chua secret trong bat ky file nao o tren.
 */

import * as path from 'node:path';
import type { Tool } from '@open-bot/core';
import {
  FLEET_V10_CONTROL_ACTIONS,
  FLEET_V10_EVENT_KINDS,
  FLEET_V10_SCHEDULE_KINDS,
  applyFleetV10ControlAction,
  buildFleetV10Dashboard,
  checkFleetV10UserQuota,
  createFleetV10Schedule,
  createFleetV10Trigger,
  createFleetV10User,
  defaultFleetV10UserQuota,
  evaluateFleetV10Triggers,
  loadFleetV10AgentRuntimeStates,
  loadFleetV10ScheduledRuns,
  loadFleetV10Schedules,
  loadFleetV10TriggerRuns,
  loadFleetV10Triggers,
  loadFleetV10UserQuotas,
  loadFleetV10Users,
  readFleetV10LogTail,
  saveFleetV10AgentRuntimeStates,
  saveFleetV10ScheduledRuns,
  saveFleetV10Schedules,
  saveFleetV10TriggerRuns,
  saveFleetV10Triggers,
  saveFleetV10UserQuotas,
  saveFleetV10Users,
  summarizeFleetV10Scheduling,
  summarizeFleetV10Triggers,
  tickFleetV10Scheduler,
  validateFleetV10Event,
  validateFleetV10Trigger,
  validateFleetV10UserQuota,
  type FleetV10AgentRuntimeState,
  type FleetV10ControlAction,
  type FleetV10EventKind,
  type FleetV10ScheduleKind,
  type FleetV10UserQuota,
  type FleetV10UserUsage,
} from '@open-bot/core';

export const FLEET_V10_TOOL_NAMES = [
  'fleet_trigger_create_v10',
  'fleet_trigger_list_v10',
  'fleet_trigger_evaluate_v10',
  'fleet_schedule_create_v10',
  'fleet_schedule_list_v10',
  'fleet_schedule_tick_v10',
  'fleet_user_create_v10',
  'fleet_user_quota_check_v10',
  'fleet_dashboard_snapshot_v10',
  'fleet_agent_control_v10',
  'fleet_log_tail_v10',
] as const;

export function isFleetV10ToolName(name: string): boolean {
  return (FLEET_V10_TOOL_NAMES as readonly string[]).includes(name);
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

const NOT_WIRED =
  'fleet v10 tools are not wired in this host (no userData dir configured) — open the fleet console UI instead.';

/** Fleet root derived from the app userData dir. */
function fleetRoot(baseDir: string): string {
  return path.join(baseDir, 'fleet');
}

export function createFleetV10Tools(
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

  const triggerCreateTool: Tool = {
    definition: toolDef(
      'fleet_trigger_create_v10',
      'Create a fleet v10 event trigger (file-changed / webhook-local / calendar-due / message-inbound / agent-done / queue-depth) that runs an agent when an event matches its filter, with debounce / throttle / cooldown / hourly run limit. Persisted to <userData>/fleet/fleet-triggers-v113.json. Needs approval; needs the fleet tools wired.',
      {
        name: { type: 'string', description: 'Trigger name (non-empty, unique in the fleet).' },
        agentId: { type: 'string', description: 'Agent (bot) id to run when the trigger fires.' },
        ownerUserId: { type: 'string', description: 'User id that owns the trigger.' },
        eventKind: { type: 'string', enum: [...FLEET_V10_EVENT_KINDS], description: 'Event kind to listen for.' },
        condition: {
          type: 'object',
          properties: {
            pathGlob: { type: 'string', description: 'File path glob, e.g. notes/**.md (file-changed only).' },
            sources: { type: 'array', items: { type: 'string' }, description: 'Only accept events from these sources.' },
            payloadMatch: { type: 'object', description: 'Payload fields that must match (string values support * glob).' },
            userId: { type: 'string', description: 'Only accept events from this user.' },
            minQueueDepth: { type: 'number', description: 'Minimum queue depth (queue-depth only).' },
          },
          additionalProperties: false,
          description: 'Optional filter condition.',
        },
        debounceMs: { type: 'number', description: 'Debounce window in ms (default 5000, 0 = off).' },
        throttleMs: { type: 'number', description: 'Minimum ms between runs (default 60000, 0 = off).' },
        cooldownMs: { type: 'number', description: 'Rest ms after each run (default 0).' },
        maxRunsPerHour: { type: 'number', description: 'Max runs per hour (default 20, 0 = unlimited).' },
        enabled: { type: 'boolean', description: 'Whether the trigger is active (default true).' },
      },
      ['name', 'agentId', 'ownerUserId', 'eventKind'],
    ),
    needsApproval: true,
    execute: async (args) => {
      const base = resolveBase();
      if (!base) return errorResult(NOT_WIRED);
      try {
        const condition = getObjectArg(args, 'condition');
        const trigger = createFleetV10Trigger({
          name: getStringArg(args, 'name'),
          agentId: getStringArg(args, 'agentId'),
          ownerUserId: getStringArg(args, 'ownerUserId'),
          eventKind: getStringArg(args, 'eventKind') as FleetV10EventKind,
          condition: Object.keys(condition).length > 0 ? (condition as never) : undefined,
          debounceMs: args['debounceMs'] === undefined ? undefined : getNumberArg(args, 'debounceMs', 0),
          throttleMs: args['throttleMs'] === undefined ? undefined : getNumberArg(args, 'throttleMs', 0),
          cooldownMs: args['cooldownMs'] === undefined ? undefined : getNumberArg(args, 'cooldownMs', 0),
          maxRunsPerHour: args['maxRunsPerHour'] === undefined ? undefined : getNumberArg(args, 'maxRunsPerHour', 0),
          enabled: getBooleanArg(args, 'enabled', true),
        });
        const root = fleetRoot(base);
        const triggers = loadFleetV10Triggers(root);
        if (triggers.some((t) => t.name === trigger.name)) {
          return errorResult(`a trigger named "${trigger.name}" already exists`);
        }
        triggers.push(trigger);
        saveFleetV10Triggers(root, triggers);
        return okResult(trigger);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const triggerListTool: Tool = {
    definition: toolDef(
      'fleet_trigger_list_v10',
      'List fleet v10 event triggers + a summary of trigger runs in the last hour. Read-only; needs the fleet tools wired.',
      {},
      [],
    ),
    needsApproval: false,
    execute: async () => {
      const base = resolveBase();
      if (!base) return errorResult(NOT_WIRED);
      try {
        const root = fleetRoot(base);
        const triggers = loadFleetV10Triggers(root);
        const runs = loadFleetV10TriggerRuns(root);
        return okResult({ triggers, summary: summarizeFleetV10Triggers(triggers, runs, Date.now()) });
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const triggerEvaluateTool: Tool = {
    definition: toolDef(
      'fleet_trigger_evaluate_v10',
      'Evaluate one fleet v10 event against the triggers: returns fire / debounced / throttled / filtered decisions per trigger without running any agent. Pure: works without the fleet tools wired when "triggers" is passed.',
      {
        event: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Event id (dedup key).' },
            kind: { type: 'string', enum: [...FLEET_V10_EVENT_KINDS], description: 'Event kind.' },
            at: { type: 'number', description: 'Epoch ms the event happened.' },
            source: { type: 'string', description: 'Event source.' },
            filePath: { type: 'string', description: 'File path (file-changed only).' },
            userId: { type: 'string', description: 'User the event belongs to.' },
            payload: { type: 'object', description: 'Event payload (string/number/boolean values).' },
          },
          required: ['id', 'kind', 'at', 'source'],
          additionalProperties: false,
          description: 'The event to evaluate.',
        },
        triggers: { type: 'array', items: { type: 'object' }, description: 'Triggers to evaluate against (optional when wired; overrides the stored list).' },
        now: { type: 'number', description: 'Evaluation time in epoch ms (default now).' },
      },
      ['event'],
    ),
    needsApproval: false,
    execute: async (args) => {
      try {
        const now = getNumberArg(args, 'now', Date.now());
        const event = validateFleetV10Event(getObjectArg(args, 'event', true));
        let triggers;
        const passed = getObjectArrayArg(args, 'triggers');
        if (passed.length > 0) {
          triggers = passed.map((t, i) => {
            try {
              return validateFleetV10Trigger(t);
            } catch (err) {
              throw new Error(`triggers[${i}] is invalid: ${(err as Error).message}`);
            }
          });
        } else {
          const base = resolveBase();
          if (!base) return errorResult(NOT_WIRED);
          triggers = loadFleetV10Triggers(fleetRoot(base));
        }
        const runs = (() => {
          const base = resolveBase();
          return base ? loadFleetV10TriggerRuns(fleetRoot(base)) : [];
        })();
        const decisions = evaluateFleetV10Triggers([event], triggers, runs, now);
        return okResult({ event, decisions });
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const scheduleCreateTool: Tool = {
    definition: toolDef(
      'fleet_schedule_create_v10',
      'Create a fleet v10 scheduled agent run (cron with its own IANA timezone / interval / once). Persisted to <userData>/fleet/fleet-schedules-v113.json. Needs approval; needs the fleet tools wired.',
      {
        name: { type: 'string', description: 'Schedule name (non-empty, unique in the fleet).' },
        agentId: { type: 'string', description: 'Agent (bot) id to run.' },
        ownerUserId: { type: 'string', description: 'User id that owns the schedule.' },
        kind: { type: 'string', enum: [...FLEET_V10_SCHEDULE_KINDS], description: 'Schedule kind.' },
        cron: { type: 'string', description: 'Cron expression "m h dom mon dow" (kind cron only).' },
        timezone: { type: 'string', description: 'IANA timezone for the cron expression (default UTC).' },
        intervalMs: { type: 'number', description: 'Repeat every N ms (kind interval only).' },
        runAtMs: { type: 'number', description: 'Epoch ms to run once (kind once only, must be in the future).' },
        skipIfRunning: { type: 'boolean', description: 'Skip the run when the agent is already running (default true).' },
        maxAttempts: { type: 'number', description: 'Retries on failure, including the first try (default 3).' },
        backoffMs: { type: 'number', description: 'Base retry backoff in ms (default 30000).' },
        enabled: { type: 'boolean', description: 'Whether the schedule is active (default true).' },
      },
      ['name', 'agentId', 'ownerUserId', 'kind'],
    ),
    needsApproval: true,
    execute: async (args) => {
      const base = resolveBase();
      if (!base) return errorResult(NOT_WIRED);
      try {
        const kind = getStringArg(args, 'kind') as FleetV10ScheduleKind;
        const schedule = createFleetV10Schedule({
          name: getStringArg(args, 'name'),
          agentId: getStringArg(args, 'agentId'),
          ownerUserId: getStringArg(args, 'ownerUserId'),
          kind,
          cron: args['cron'] === undefined ? undefined : getStringArg(args, 'cron'),
          timezone: args['timezone'] === undefined ? undefined : getStringArg(args, 'timezone'),
          intervalMs: args['intervalMs'] === undefined ? undefined : getNumberArg(args, 'intervalMs', 0),
          runAtMs: args['runAtMs'] === undefined ? undefined : getNumberArg(args, 'runAtMs', 0),
          skipIfRunning: getBooleanArg(args, 'skipIfRunning', true),
          maxAttempts: args['maxAttempts'] === undefined ? undefined : getNumberArg(args, 'maxAttempts', 3),
          backoffMs: args['backoffMs'] === undefined ? undefined : getNumberArg(args, 'backoffMs', 30000),
          enabled: getBooleanArg(args, 'enabled', true),
        });
        const root = fleetRoot(base);
        const schedules = loadFleetV10Schedules(root);
        if (schedules.some((s) => s.name === schedule.name)) {
          return errorResult(`a schedule named "${schedule.name}" already exists`);
        }
        schedules.push(schedule);
        saveFleetV10Schedules(root, schedules);
        return okResult(schedule);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const scheduleListTool: Tool = {
    definition: toolDef(
      'fleet_schedule_list_v10',
      'List fleet v10 schedules + a 24h run summary. Read-only; needs the fleet tools wired.',
      {},
      [],
    ),
    needsApproval: false,
    execute: async () => {
      const base = resolveBase();
      if (!base) return errorResult(NOT_WIRED);
      try {
        const root = fleetRoot(base);
        const schedules = loadFleetV10Schedules(root);
        const runs = loadFleetV10ScheduledRuns(root);
        return okResult({ schedules, summary: summarizeFleetV10Scheduling(schedules, runs, Date.now()) });
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const scheduleTickTool: Tool = {
    definition: toolDef(
      'fleet_schedule_tick_v10',
      'Run one fleet v10 scheduler tick: due schedules start, runs are skipped when the agent is already running (skipIfRunning), missed runs past the grace window are recorded not executed, and due retries reopen. Needs approval; needs the fleet tools wired.',
      {
        runningAgentIds: { type: 'array', items: { type: 'string' }, description: 'Agent ids currently running.' },
        missedGraceMs: { type: 'number', description: 'Missed-run grace in ms (default 300000).' },
      },
      [],
    ),
    needsApproval: true,
    execute: async (args) => {
      const base = resolveBase();
      if (!base) return errorResult(NOT_WIRED);
      try {
        const root = fleetRoot(base);
        const schedules = loadFleetV10Schedules(root);
        const runs = loadFleetV10ScheduledRuns(root);
        const running = new Set<string>();
        const rawIds = args['runningAgentIds'];
        if (Array.isArray(rawIds)) {
          for (const id of rawIds) {
            if (typeof id === 'string') running.add(id);
          }
        }
        const { state, result } = tickFleetV10Scheduler(
          Date.now(),
          { schedules, runs },
          running,
          getNumberArg(args, 'missedGraceMs', 5 * 60 * 1000),
        );
        saveFleetV10Schedules(root, state.schedules);
        saveFleetV10ScheduledRuns(root, state.runs);
        return okResult(result);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const userCreateTool: Tool = {
    definition: toolDef(
      'fleet_user_create_v10',
      'Create a local fleet user (internal user of this machine — NOT a cloud account) with a default resource quota. Persisted to <userData>/fleet/fleet-users-v113.json. Needs approval; needs the fleet tools wired.',
      {
        id: { type: 'string', description: 'User id, lowercase letters/digits/_/- (e.g. alice).' },
        displayName: { type: 'string', description: 'Display name.' },
        role: { type: 'string', enum: ['admin', 'member', 'chat-only'], description: 'Fleet role.' },
        createdBy: { type: 'string', description: 'Who creates the user (default system).' },
      },
      ['id', 'displayName', 'role'],
    ),
    needsApproval: true,
    execute: async (args) => {
      const base = resolveBase();
      if (!base) return errorResult(NOT_WIRED);
      try {
        const root = fleetRoot(base);
        const users = loadFleetV10Users(root);
        const user = createFleetV10User(users, {
          id: getStringArg(args, 'id'),
          displayName: getStringArg(args, 'displayName'),
          role: getStringArg(args, 'role') as 'admin' | 'member' | 'chat-only',
          createdBy: args['createdBy'] === undefined ? undefined : getStringArg(args, 'createdBy'),
        });
        const quotas = loadFleetV10UserQuotas(root);
        quotas.push(defaultFleetV10UserQuota(user.id, user.createdBy));
        users.push(user);
        saveFleetV10Users(root, users);
        saveFleetV10UserQuotas(root, quotas);
        return okResult({ user, quota: quotas[quotas.length - 1] });
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const userQuotaCheckTool: Tool = {
    definition: toolDef(
      'fleet_user_quota_check_v10',
      'Check whether a user\'s current usage exceeds their quota. Pure: works without the fleet tools wired when "quota" and "usage" are passed.',
      {
        userId: { type: 'string', description: 'User id to check.' },
        quota: { type: 'object', description: 'User quota object (optional when wired — loaded from disk).' },
        usage: {
          type: 'object',
          properties: {
            agents: { type: 'number' },
            concurrentRuns: { type: 'number' },
            triggers: { type: 'number' },
            schedules: { type: 'number' },
            cpuCores: { type: 'number' },
            ramBytes: { type: 'number' },
            diskBytes: { type: 'number' },
            runsToday: { type: 'number' },
          },
          required: ['agents', 'concurrentRuns', 'triggers', 'schedules', 'cpuCores', 'ramBytes', 'diskBytes', 'runsToday'],
          additionalProperties: false,
          description: 'Current usage of the user.',
        },
      },
      ['userId', 'usage'],
    ),
    needsApproval: false,
    execute: async (args) => {
      try {
        const userId = getStringArg(args, 'userId');
        const usageRaw = getObjectArg(args, 'usage', true);
        const usage: FleetV10UserUsage = {
          userId,
          agents: typeof usageRaw['agents'] === 'number' ? usageRaw['agents'] : 0,
          concurrentRuns: typeof usageRaw['concurrentRuns'] === 'number' ? usageRaw['concurrentRuns'] : 0,
          triggers: typeof usageRaw['triggers'] === 'number' ? usageRaw['triggers'] : 0,
          schedules: typeof usageRaw['schedules'] === 'number' ? usageRaw['schedules'] : 0,
          cpuCores: typeof usageRaw['cpuCores'] === 'number' ? usageRaw['cpuCores'] : 0,
          ramBytes: typeof usageRaw['ramBytes'] === 'number' ? usageRaw['ramBytes'] : 0,
          diskBytes: typeof usageRaw['diskBytes'] === 'number' ? usageRaw['diskBytes'] : 0,
          runsToday: typeof usageRaw['runsToday'] === 'number' ? usageRaw['runsToday'] : 0,
        };
        let quota: FleetV10UserQuota;
        const quotaRaw = getObjectArg(args, 'quota');
        if (Object.keys(quotaRaw).length > 0) {
          quota = validateFleetV10UserQuota({ ...quotaRaw, userId });
        } else {
          const base = resolveBase();
          if (!base) return errorResult(NOT_WIRED);
          const quotas = loadFleetV10UserQuotas(fleetRoot(base));
          const found = quotas.find((q) => q.userId === userId);
          quota = found ?? defaultFleetV10UserQuota(userId, 'system');
        }
        return okResult({ userId, quota, usage, check: checkFleetV10UserQuota(quota, usage) });
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const dashboardSnapshotTool: Tool = {
    definition: toolDef(
      'fleet_dashboard_snapshot_v10',
      'Build a fleet v10 dashboard snapshot (agents running/paused/stopped/error, queue, host resources, per-user usage, alerts) from the data passed in. Pure: works without the fleet tools wired.',
      {
        agents: { type: 'array', items: { type: 'object' }, description: 'Agent runtime states (agentId, name, ownerUserId, status, cpuCores, ramBytes, queueDepth, ...).' },
        queue: {
          type: 'object',
          properties: {
            waiting: { type: 'number' },
            running: { type: 'number' },
            doneLast24h: { type: 'number' },
            failedLast24h: { type: 'number' },
            oldestWaitingAt: { type: 'number' },
          },
          required: ['waiting', 'running', 'doneLast24h', 'failedLast24h'],
          additionalProperties: false,
          description: 'Queue snapshot.',
        },
        resources: {
          type: 'object',
          properties: {
            cpuCoresTotal: { type: 'number' },
            cpuCoresUsed: { type: 'number' },
            ramBytesTotal: { type: 'number' },
            ramBytesUsed: { type: 'number' },
            diskBytesTotal: { type: 'number' },
            diskBytesUsed: { type: 'number' },
          },
          required: ['cpuCoresTotal', 'cpuCoresUsed', 'ramBytesTotal', 'ramBytesUsed', 'diskBytesTotal', 'diskBytesUsed'],
          additionalProperties: false,
          description: 'Host resources.',
        },
      },
      ['agents', 'queue', 'resources'],
    ),
    needsApproval: false,
    execute: async (args) => {
      try {
        const agentsRaw = getObjectArrayArg(args, 'agents', true);
        const agents: FleetV10AgentRuntimeState[] = agentsRaw.map((a, i) => {
          try {
            return {
              agentId: typeof a['agentId'] === 'string' ? a['agentId'] : '',
              name: typeof a['name'] === 'string' ? a['name'] : '',
              ownerUserId: typeof a['ownerUserId'] === 'string' ? a['ownerUserId'] : '',
              status: (a['status'] as FleetV10AgentRuntimeState['status']) ?? 'stopped',
              startedAt: typeof a['startedAt'] === 'number' ? a['startedAt'] : null,
              lastHeartbeatAt: typeof a['lastHeartbeatAt'] === 'number' ? a['lastHeartbeatAt'] : null,
              cpuCores: typeof a['cpuCores'] === 'number' ? a['cpuCores'] : 0,
              ramBytes: typeof a['ramBytes'] === 'number' ? a['ramBytes'] : 0,
              queueDepth: typeof a['queueDepth'] === 'number' ? a['queueDepth'] : 0,
              restarts: typeof a['restarts'] === 'number' ? a['restarts'] : 0,
            };
          } catch (err) {
            throw new Error(`agents[${i}] is invalid: ${(err as Error).message}`);
          }
        });
        const queueRaw = getObjectArg(args, 'queue', true);
        const resourcesRaw = getObjectArg(args, 'resources', true);
        const snapshot = buildFleetV10Dashboard({
          agents,
          queue: {
            waiting: typeof queueRaw['waiting'] === 'number' ? queueRaw['waiting'] : 0,
            running: typeof queueRaw['running'] === 'number' ? queueRaw['running'] : 0,
            doneLast24h: typeof queueRaw['doneLast24h'] === 'number' ? queueRaw['doneLast24h'] : 0,
            failedLast24h: typeof queueRaw['failedLast24h'] === 'number' ? queueRaw['failedLast24h'] : 0,
            oldestWaitingAt: typeof queueRaw['oldestWaitingAt'] === 'number' ? queueRaw['oldestWaitingAt'] : null,
          },
          resources: {
            cpuCoresTotal: typeof resourcesRaw['cpuCoresTotal'] === 'number' ? resourcesRaw['cpuCoresTotal'] : 0,
            cpuCoresUsed: typeof resourcesRaw['cpuCoresUsed'] === 'number' ? resourcesRaw['cpuCoresUsed'] : 0,
            ramBytesTotal: typeof resourcesRaw['ramBytesTotal'] === 'number' ? resourcesRaw['ramBytesTotal'] : 0,
            ramBytesUsed: typeof resourcesRaw['ramBytesUsed'] === 'number' ? resourcesRaw['ramBytesUsed'] : 0,
            diskBytesTotal: typeof resourcesRaw['diskBytesTotal'] === 'number' ? resourcesRaw['diskBytesTotal'] : 0,
            diskBytesUsed: typeof resourcesRaw['diskBytesUsed'] === 'number' ? resourcesRaw['diskBytesUsed'] : 0,
          },
        });
        return okResult(snapshot);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const agentControlTool: Tool = {
    definition: toolDef(
      'fleet_agent_control_v10',
      'Control a fleet agent remotely (start / stop / pause / resume) following the runtime state machine; invalid transitions are rejected with a reason. Runtime states live in <userData>/fleet/fleet-agent-runtime-v113.json. Needs approval; needs the fleet tools wired.',
      {
        agentId: { type: 'string', description: 'Agent id to control.' },
        action: { type: 'string', enum: [...FLEET_V10_CONTROL_ACTIONS], description: 'Control action.' },
        actorUserId: { type: 'string', description: 'User issuing the command (for the audit event).' },
        reason: { type: 'string', description: 'Reason for the command.' },
      },
      ['agentId', 'action', 'actorUserId'],
    ),
    needsApproval: true,
    execute: async (args) => {
      const base = resolveBase();
      if (!base) return errorResult(NOT_WIRED);
      try {
        const root = fleetRoot(base);
        const states = loadFleetV10AgentRuntimeStates(root);
        const agentId = getStringArg(args, 'agentId');
        const state = states.find((s) => s.agentId === agentId);
        if (!state) return errorResult(`agent not found in runtime states: ${agentId}`);
        const result = applyFleetV10ControlAction(
          state,
          getStringArg(args, 'action') as FleetV10ControlAction,
          getStringArg(args, 'actorUserId'),
          getStringArg(args, 'reason', false),
          Date.now(),
        );
        if (!result.ok) return errorResult(result.error);
        saveFleetV10AgentRuntimeStates(
          root,
          states.map((s) => (s.agentId === agentId ? result.state : s)),
        );
        return okResult({ state: result.state, event: result.event });
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const logTailTool: Tool = {
    definition: toolDef(
      'fleet_log_tail_v10',
      'Read the last N lines of an agent log file for live log viewing. The log path must be inside <userData>/fleet. Read-only; needs the fleet tools wired.',
      {
        logPath: { type: 'string', description: 'Log file path (must be inside <userData>/fleet).' },
        maxLines: { type: 'number', description: 'Max lines to return (default 100).' },
      },
      ['logPath'],
    ),
    needsApproval: false,
    execute: async (args) => {
      const base = resolveBase();
      if (!base) return errorResult(NOT_WIRED);
      try {
        const logPath = getStringArg(args, 'logPath');
        const root = fleetRoot(base);
        const resolved = path.resolve(logPath);
        const rel = path.relative(path.resolve(root), resolved);
        if (rel.startsWith('..') || path.isAbsolute(rel)) {
          return errorResult('log path must be inside the fleet directory');
        }
        return okResult(readFleetV10LogTail(resolved, getNumberArg(args, 'maxLines', 100)));
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  return [
    triggerCreateTool,
    triggerListTool,
    triggerEvaluateTool,
    scheduleCreateTool,
    scheduleListTool,
    scheduleTickTool,
    userCreateTool,
    userQuotaCheckTool,
    dashboardSnapshotTool,
    agentControlTool,
    logTailTool,
  ];
}

export const FLEET_V10_TOOLS: Tool[] = createFleetV10Tools();

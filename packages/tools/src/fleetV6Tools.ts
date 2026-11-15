/**
 * Fleet v6 tools (v1.09, Đội T6) — registered in ALL_TOOLS
 * (see tools.ts).
 *
 * - `fleet_schedule_create` — tạo lịch cho một bot: `cron` (5 trường),
 *   `interval` (lặp mỗi N ms), hoặc `event` (khi bot khác xong / bot
 *   idle / hàng đợi đông). Lưu vào
 *   `<userData>/fleet/fleet-schedules-v109.json`.
 * - `fleet_schedule_list` — liệt kê lịch (+ kế hoạch timeslot hôm nay:
 *   slot nào xếp được, lịch nào không xếp được và lý do).
 * - `fleet_schedule_run_now` — enqueue một lần chạy ngay cho bot (vào
 *   hàng đợi ưu tiên v6, tick sẽ start theo maxConcurrent).
 * - `fleet_schedule_queue` — hàng đợi v6: liệt kê hoặc xem entry tiếp
 *   theo (ưu tiên + aging, entry nào đang chờ backoff sau preempt).
 * - `fleet_quota_group_set` — đặt quota cho một nhóm bot (trần chung
 *   CPU/RAM/đĩa + ngưỡng cảnh báo + throttle cap). Lưu vào
 *   `<userData>/fleet/fleet-quota-groups-v109.json`.
 * - `fleet_quota_group_list` — liệt kê các nhóm quota.
 * - `fleet_quota_group_check` — đánh giá quota nhóm + quota bot với
 *   mức dùng đo thật từ usage ledger: mức từng tài nguyên, action
 *   (none/warn/throttle/pause), bot bị pause, cap concurrency sau
 *   throttle.
 * - `fleet_health_check` — health check một bot: heartbeat, service,
 *   mức dùng vs quota, lỗi gần đây — trạng thái healthy/degraded/
 *   unhealthy/down + từng check riêng lẻ.
 * - `fleet_health_incidents` — incident log: crash / degraded /
 *   unhealthy / restart / restart-exhausted / quota-over (lọc theo
 *   bot/kind, mới nhất trước).
 * - `fleet_health_restart` — ghi một lần crash cho bot rồi quyết định
 *   restart (backoff tăng dần, hết lượt thì exhausted, bot unhealthy
 *   thì không tự restart); hoặc ghi một lần restart thành công.
 *
 * Như các tool fleet trước, đây là placeholder trong ALL_TOOLS cho
 * tới khi host bind: `createFleetV6Tools(getBaseDir)` với userData
 * dir của app. Tool ghi file cần approval; tool chỉ đọc thì không.
 */

import * as path from 'node:path';
import type { Tool } from '@open-bot/core';
import {
  DEFAULT_FLEET_V6_RESTART_POLICY,
  addFleetV6Schedule,
  appendFleetV6Incident,
  checkFleetV6BotHealth,
  cpuRateFromSamples,
  createFleetV6Incident,
  decideFleetV6Restart,
  enqueueFleetV6,
  evaluateFleetV6Quotas,
  listFleetV6Incidents,
  loadBotQuotas,
  loadFleetV6HealthStates,
  loadFleetV6QuotaGroups,
  loadFleetV6Queue,
  loadFleetV6Schedules,
  pickNextFleetV6Entry,
  planFleetV6Day,
  readUsageSamplesFor,
  recordFleetV6Crash,
  recordFleetV6Restart,
  saveFleetV6HealthStates,
  saveFleetV6Queue,
  setFleetV6QuotaGroup,
  summarizeBotUsage,
  type BotPriority,
  type FleetV6CronExpression,
  type FleetV6EventTrigger,
  type FleetV6IncidentKind,
  type FleetV6RunResources,
} from '@open-bot/core';

export const FLEET_V6_TOOL_NAMES = [
  'fleet_schedule_create',
  'fleet_schedule_list',
  'fleet_schedule_run_now',
  'fleet_schedule_queue',
  'fleet_quota_group_set',
  'fleet_quota_group_list',
  'fleet_quota_group_check',
  'fleet_health_check',
  'fleet_health_incidents',
  'fleet_health_restart',
] as const;

export function isFleetV6ToolName(name: string): boolean {
  return (FLEET_V6_TOOL_NAMES as readonly string[]).includes(name);
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

function getStringArrayArg(args: Record<string, unknown>, name: string, required = false): string[] {
  const value = args[name];
  if (value === undefined || value === null) {
    if (required) throw new Error(`Missing required argument: "${name}"`);
    return [];
  }
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
    throw new Error(`Argument "${name}" must be an array of strings.`);
  }
  return [...(value as string[])];
}

const NOT_WIRED =
  'fleet v6 tools are not wired in this host (no userData dir configured) — open the fleet console UI instead.';

/** Fleet root derived from the app userData dir. */
function dirs(baseDir: string): { fleetRoot: string } {
  return { fleetRoot: path.join(baseDir, 'fleet') };
}

const FLEET_V6_PRIORITIES: BotPriority[] = ['critical', 'high', 'normal', 'low'];

function parsePriority(value: unknown, fallback: BotPriority = 'normal'): BotPriority {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'string' || !(FLEET_V6_PRIORITIES as string[]).includes(value)) {
    throw new Error(`priority phải là một trong: ${FLEET_V6_PRIORITIES.join(', ')}.`);
  }
  return value as BotPriority;
}

function parseResources(obj: Record<string, unknown>, name: string): FleetV6RunResources {
  const cpu = obj['cpuCores'];
  const ram = obj['ramBytes'];
  const disk = obj['diskBytes'];
  if (typeof cpu !== 'number' || !Number.isFinite(cpu) || cpu <= 0) {
    throw new Error(`${name}.cpuCores phải là số > 0.`);
  }
  if (typeof ram !== 'number' || !Number.isFinite(ram) || ram <= 0) {
    throw new Error(`${name}.ramBytes phải là số > 0.`);
  }
  if (typeof disk !== 'number' || !Number.isFinite(disk) || disk <= 0) {
    throw new Error(`${name}.diskBytes phải là số > 0.`);
  }
  return { cpuCores: cpu, ramBytes: ram, diskBytes: disk };
}

function parseResourcesArg(args: Record<string, unknown>, name: string): FleetV6RunResources {
  const value = args[name];
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`Argument "${name}" must be an object { cpuCores, ramBytes, diskBytes }.`);
  }
  return parseResources(value as Record<string, unknown>, name);
}

function parseCronArg(args: Record<string, unknown>): FleetV6CronExpression {
  const value = args['cron'];
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Argument "cron" must be an object { minute, hour, dayOfMonth, month, dayOfWeek }.');
  }
  const obj = value as Record<string, unknown>;
  for (const field of ['minute', 'hour', 'dayOfMonth', 'month', 'dayOfWeek']) {
    if (typeof obj[field] !== 'string' || (obj[field] as string).trim().length === 0) {
      throw new Error(`cron.${field} must be a non-empty string.`);
    }
  }
  return {
    minute: obj['minute'] as string,
    hour: obj['hour'] as string,
    dayOfMonth: obj['dayOfMonth'] as string,
    month: obj['month'] as string,
    dayOfWeek: obj['dayOfWeek'] as string,
  };
}

function parseEventArg(args: Record<string, unknown>): FleetV6EventTrigger {
  const value = args['event'];
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Argument "event" must be an object { type, ... }.');
  }
  const obj = value as Record<string, unknown>;
  if (obj['type'] === 'on-bot-done' || obj['type'] === 'on-bot-idle') {
    if (typeof obj['botId'] !== 'string' || (obj['botId'] as string).trim().length === 0) {
      throw new Error('event trigger needs a non-empty botId.');
    }
    if (obj['type'] === 'on-bot-idle') {
      if (typeof obj['idleMs'] !== 'number' || (obj['idleMs'] as number) <= 0) {
        throw new Error('on-bot-idle trigger needs idleMs > 0.');
      }
      return { type: 'on-bot-idle', botId: (obj['botId'] as string).trim(), idleMs: obj['idleMs'] as number };
    }
    return { type: 'on-bot-done', botId: (obj['botId'] as string).trim() };
  }
  if (obj['type'] === 'on-queue-depth') {
    if (typeof obj['minWaiting'] !== 'number' || (obj['minWaiting'] as number) <= 0) {
      throw new Error('on-queue-depth trigger needs minWaiting > 0.');
    }
    return { type: 'on-queue-depth', minWaiting: obj['minWaiting'] as number };
  }
  throw new Error(`unknown event trigger type: ${String(obj['type'])}.`);
}

const RESOURCES_SCHEMA = {
  type: 'object',
  properties: {
    cpuCores: { type: 'number', description: 'CPU cores needed (> 0).' },
    ramBytes: { type: 'number', description: 'RAM in bytes (> 0).' },
    diskBytes: { type: 'number', description: 'Disk in bytes (> 0).' },
  },
  required: ['cpuCores', 'ramBytes', 'diskBytes'],
  additionalProperties: false,
};

/** Mức dùng đã đo của một bot từ usage ledger (null = chưa đo được). */
function usageFromLedger(
  fleetRoot: string,
  botId: string,
): { cpuCoresUsed: number | null; ramBytesUsed: number | null; diskBytesUsed: number | null } {
  let samples: ReturnType<typeof readUsageSamplesFor> = [];
  try {
    samples = readUsageSamplesFor(fleetRoot, botId);
  } catch {
    samples = [];
  }
  const summary = summarizeBotUsage(botId, samples);
  return {
    cpuCoresUsed: cpuRateFromSamples(samples),
    ramBytesUsed: summary?.latestRssBytes ?? null,
    diskBytesUsed: summary?.latestDiskBytes ?? null,
  };
}

/**
 * Build the 10 fleet v6 tools. `getBaseDir` resolves the app userData
 * dir (null/undefined = unbound placeholders that explain themselves
 * instead of guessing paths).
 */
export function createFleetV6Tools(
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
      'fleet_schedule_create',
      'Create a fleet v6 schedule for a bot: cron (5 fields: minute/hour/dayOfMonth/month/dayOfWeek), interval (repeat every N ms), or event (on-bot-done / on-bot-idle / on-queue-depth). Heavy bots (>= 2 CPU cores or >= 4 GB RAM) never overlap in the day plan. Saved to <userData>/fleet/fleet-schedules-v109.json.',
      {
        botId: { type: 'string', description: 'Bot the schedule runs for.' },
        summary: { type: 'string', description: 'Short description (shown in UI/log, no secrets).' },
        kind: { type: 'string', enum: ['cron', 'interval', 'event'], description: 'Schedule kind.' },
        cron: {
          type: 'object',
          properties: {
            minute: { type: 'string', description: 'Cron minute field (e.g. "0", "*/15").' },
            hour: { type: 'string', description: 'Cron hour field (e.g. "9", "9-17").' },
            dayOfMonth: { type: 'string', description: 'Cron day-of-month field.' },
            month: { type: 'string', description: 'Cron month field.' },
            dayOfWeek: { type: 'string', description: 'Cron day-of-week field (0 = Sunday).' },
          },
          required: ['minute', 'hour', 'dayOfMonth', 'month', 'dayOfWeek'],
          additionalProperties: false,
          description: 'Required when kind=cron.',
        },
        intervalMs: { type: 'number', description: 'Repeat interval in ms (required when kind=interval).' },
        event: {
          type: 'object',
          properties: {
            type: { type: 'string', enum: ['on-bot-done', 'on-bot-idle', 'on-queue-depth'] },
            botId: { type: 'string', description: 'Bot for on-bot-done / on-bot-idle.' },
            idleMs: { type: 'number', description: 'Idle time in ms (on-bot-idle).' },
            minWaiting: { type: 'number', description: 'Minimum waiting entries (on-queue-depth).' },
          },
          required: ['type'],
          additionalProperties: false,
          description: 'Required when kind=event.',
        },
        priority: { type: 'string', enum: [...FLEET_V6_PRIORITIES], description: 'Run priority (default normal).' },
        resources: { ...RESOURCES_SCHEMA, description: 'Resources one run needs.' },
        enabled: { type: 'boolean', description: 'Enabled (default true).' },
      },
      ['botId', 'summary', 'kind', 'resources'],
    ),
    needsApproval: true,
    execute: async (args) => {
      const base = resolveBase();
      if (!base) return errorResult(NOT_WIRED);
      try {
        const { fleetRoot } = dirs(base);
        const kind = getStringArg(args, 'kind');
        if (kind !== 'cron' && kind !== 'interval' && kind !== 'event') {
          return errorResult('kind must be one of: cron, interval, event.');
        }
        const schedule = addFleetV6Schedule(fleetRoot, {
          botId: getStringArg(args, 'botId'),
          summary: getStringArg(args, 'summary'),
          kind,
          ...(kind === 'cron' ? { cron: parseCronArg(args) } : {}),
          ...(kind === 'interval' ? { intervalMs: getNumberArg(args, 'intervalMs', 0) } : {}),
          ...(kind === 'event' ? { event: parseEventArg(args) } : {}),
          priority: parsePriority(args['priority']),
          resources: parseResourcesArg(args, 'resources'),
          enabled: getBooleanArg(args, 'enabled', true),
        });
        return JSON.stringify({ schedule }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const scheduleListTool: Tool = {
    definition: toolDef(
      'fleet_schedule_list',
      'List fleet v6 schedules (optionally for one bot) plus today\'s timeslot plan: which schedules got a slot, which could not be placed and why, peak CPU/RAM. Read-only, local only.',
      {
        botId: { type: 'string', description: 'Optional: only schedules for this bot.' },
      },
      [],
    ),
    needsApproval: false,
    execute: async (args) => {
      const base = resolveBase();
      if (!base) return errorResult(NOT_WIRED);
      try {
        const { fleetRoot } = dirs(base);
        const botId = getStringArg(args, 'botId', false);
        const schedules = loadFleetV6Schedules(fleetRoot).filter((s) => !botId || s.botId === botId);
        const dayStart = new Date();
        dayStart.setHours(0, 0, 0, 0);
        const dayPlan = planFleetV6Day(schedules, dayStart.getTime());
        return JSON.stringify({ count: schedules.length, schedules, dayPlan }, null, 2).slice(0, 20000);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const scheduleRunNowTool: Tool = {
    definition: toolDef(
      'fleet_schedule_run_now',
      'Enqueue a run for a bot right now into the fleet v6 priority queue (the scheduler tick starts it respecting priority, aging and maxConcurrent). Returns the queue entry.',
      {
        botId: { type: 'string', description: 'Bot to run.' },
        summary: { type: 'string', description: 'Short description (no secrets).' },
        priority: { type: 'string', enum: [...FLEET_V6_PRIORITIES], description: 'Run priority (default normal).' },
        resources: { ...RESOURCES_SCHEMA, description: 'Resources the run needs.' },
        preemptible: { type: 'boolean', description: 'May this run be preempted by a higher-priority run (default true).' },
      },
      ['botId', 'summary', 'resources'],
    ),
    needsApproval: true,
    execute: async (args) => {
      const base = resolveBase();
      if (!base) return errorResult(NOT_WIRED);
      try {
        const { fleetRoot } = dirs(base);
        const queue = loadFleetV6Queue(fleetRoot);
        const entry = enqueueFleetV6(queue, {
          botId: getStringArg(args, 'botId'),
          summary: getStringArg(args, 'summary'),
          priority: parsePriority(args['priority']),
          resources: parseResourcesArg(args, 'resources'),
          preemptible: getBooleanArg(args, 'preemptible', true),
        });
        saveFleetV6Queue(fleetRoot, [...queue, entry]);
        return JSON.stringify({ entry }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const scheduleQueueTool: Tool = {
    definition: toolDef(
      'fleet_schedule_queue',
      'Fleet v6 priority queue: list waiting/running entries (action=list) or show the next entry the scheduler would start (action=next, priority + aging). Read-only, local only.',
      {
        action: { type: 'string', enum: ['list', 'next'], description: 'list (default) or next.' },
        limit: { type: 'number', description: 'Max entries to return (default 20).' },
      },
      [],
    ),
    needsApproval: false,
    execute: async (args) => {
      const base = resolveBase();
      if (!base) return errorResult(NOT_WIRED);
      try {
        const { fleetRoot } = dirs(base);
        const queue = loadFleetV6Queue(fleetRoot);
        const action = getStringArg(args, 'action', false) || 'list';
        if (action !== 'list' && action !== 'next') {
          return errorResult('action must be one of: list, next.');
        }
        if (action === 'next') {
          const next = pickNextFleetV6Entry(queue, Date.now());
          return JSON.stringify({ next }, null, 2);
        }
        const limit = getNumberArg(args, 'limit', 20);
        const waiting = queue.filter((e) => e.status === 'waiting');
        const running = queue.filter((e) => e.status === 'running');
        return JSON.stringify(
          { waiting: waiting.slice(0, limit), running, totalWaiting: waiting.length, totalRunning: running.length },
          null,
          2,
        ).slice(0, 20000);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const quotaGroupSetTool: Tool = {
    definition: toolDef(
      'fleet_quota_group_set',
      'Create or update a fleet v6 quota group: several bots share one CPU/RAM/disk ceiling plus a warn threshold and a throttle cap (max concurrent runs per bot while throttled). Over the ceiling pauses the group\'s bots (no new tasks). Saved to <userData>/fleet/fleet-quota-groups-v109.json.',
      {
        name: { type: 'string', description: 'Group name (unique).' },
        botIds: { type: 'array', items: { type: 'string' }, description: 'Bots in the group (at least 1).' },
        cpuCoresMax: { type: 'number', description: 'Shared CPU ceiling in cores (> 0).' },
        ramBytesMax: { type: 'number', description: 'Shared RAM ceiling in bytes (> 0).' },
        diskBytesMax: { type: 'number', description: 'Shared disk ceiling in bytes (> 0).' },
        warnPercent: { type: 'number', description: 'Warn at this fraction of the ceiling (0..1, default 0.8).' },
        enabled: { type: 'boolean', description: 'Enabled (default true).' },
        throttleMaxConcurrent: { type: 'number', description: 'Max concurrent runs per bot while throttled (default 1).' },
      },
      ['name', 'botIds', 'cpuCoresMax', 'ramBytesMax', 'diskBytesMax'],
    ),
    needsApproval: true,
    execute: async (args) => {
      const base = resolveBase();
      if (!base) return errorResult(NOT_WIRED);
      try {
        const { fleetRoot } = dirs(base);
        const group = setFleetV6QuotaGroup(
          fleetRoot,
          {
            name: getStringArg(args, 'name'),
            botIds: getStringArrayArg(args, 'botIds', true),
            cpuCoresMax: getNumberArg(args, 'cpuCoresMax', 0),
            ramBytesMax: getNumberArg(args, 'ramBytesMax', 0),
            diskBytesMax: getNumberArg(args, 'diskBytesMax', 0),
            ...(args['warnPercent'] !== undefined ? { warnPercent: getNumberArg(args, 'warnPercent', 0.8) } : {}),
            ...(args['enabled'] !== undefined ? { enabled: getBooleanArg(args, 'enabled', true) } : {}),
            ...(args['throttleMaxConcurrent'] !== undefined
              ? { throttleMaxConcurrent: getNumberArg(args, 'throttleMaxConcurrent', 1) }
              : {}),
          },
          'fleet-v6-tool',
        );
        return JSON.stringify({ group }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const quotaGroupListTool: Tool = {
    definition: toolDef(
      'fleet_quota_group_list',
      'List fleet v6 quota groups (name, bots, ceilings, warn threshold, throttle cap, enabled). Read-only, local only.',
      {},
      [],
    ),
    needsApproval: false,
    execute: async () => {
      const base = resolveBase();
      if (!base) return errorResult(NOT_WIRED);
      try {
        const { fleetRoot } = dirs(base);
        const groups = loadFleetV6QuotaGroups(fleetRoot);
        return JSON.stringify({ count: groups.length, groups }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const quotaGroupCheckTool: Tool = {
    definition: toolDef(
      'fleet_quota_group_check',
      'Evaluate fleet v6 quota groups (and per-bot quotas) against measured usage from the usage ledger: level per resource, action (none/warn/throttle/pause), paused bots, throttle caps. Read-only, local only.',
      {
        groupId: { type: 'string', description: 'Optional: only evaluate this group.' },
        botId: { type: 'string', description: 'Optional: only evaluate quotas covering this bot.' },
      },
      [],
    ),
    needsApproval: false,
    execute: async (args) => {
      const base = resolveBase();
      if (!base) return errorResult(NOT_WIRED);
      try {
        const { fleetRoot } = dirs(base);
        const groupId = getStringArg(args, 'groupId', false);
        const botId = getStringArg(args, 'botId', false);
        let groups = loadFleetV6QuotaGroups(fleetRoot);
        if (groupId) groups = groups.filter((g) => g.id === groupId);
        if (botId) groups = groups.filter((g) => g.botIds.includes(botId));
        const botQuotas = loadBotQuotas(fleetRoot).filter((q) => !botId || q.botId === botId);
        const botIds = new Set<string>();
        for (const g of groups) for (const id of g.botIds) botIds.add(id);
        for (const q of botQuotas) botIds.add(q.botId);
        const usageByBot: Record<string, { cpuCoresUsed: number | null; ramBytesUsed: number | null; diskBytesUsed: number | null }> = {};
        for (const id of botIds) usageByBot[id] = usageFromLedger(fleetRoot, id);
        const evaluations = evaluateFleetV6Quotas(groups, usageByBot, botQuotas);
        const paused = evaluations.flatMap((e) => e.pausedBotIds);
        return JSON.stringify(
          { evaluations, pausedBotIds: [...new Set(paused)], usageByBot },
          null,
          2,
        ).slice(0, 20000);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const healthCheckTool: Tool = {
    definition: toolDef(
      'fleet_health_check',
      'Health-check one fleet bot: heartbeat freshness, service state, measured usage vs quota, recent errors. Status: healthy / degraded / unhealthy / down, with per-check details. Read-only, local only.',
      {
        botId: { type: 'string', description: 'Bot to check.' },
      },
      ['botId'],
    ),
    needsApproval: false,
    execute: async (args) => {
      const base = resolveBase();
      if (!base) return errorResult(NOT_WIRED);
      try {
        const { fleetRoot } = dirs(base);
        const botId = getStringArg(args, 'botId');
        const states = loadFleetV6HealthStates(fleetRoot);
        const state = states.find((s) => s.botId === botId);
        const samples = readUsageSamplesFor(fleetRoot, botId);
        const lastSample = samples[samples.length - 1];
        const incidents = listFleetV6Incidents(fleetRoot, { botId, kind: 'crash', limit: 10 });
        const quota = loadBotQuotas(fleetRoot).find((q) => q.botId === botId);
        const summary = summarizeBotUsage(botId, samples);
        const result = checkFleetV6BotHealth(
          {
            botId,
            lastHeartbeatAt: lastSample ? lastSample.at : null,
            serviceState: lastSample?.servicePid ? 'running' : state?.lastStatus === 'down' ? 'error' : 'stopped',
            usage: summary
              ? { cpuCoresUsed: cpuRateFromSamples(samples), ramBytesUsed: summary.latestRssBytes, diskBytesUsed: summary.latestDiskBytes }
              : null,
            ...(quota ? { quota } : {}),
            recentErrors: incidents.map((i) => ({ at: i.at, message: i.message })),
            consecutiveFailures: state?.consecutiveFailures ?? 0,
          },
          Date.now(),
        );
        return JSON.stringify({ health: result }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const healthIncidentsTool: Tool = {
    definition: toolDef(
      'fleet_health_incidents',
      'List fleet v6 health incidents (crash / health-degraded / health-unhealthy / health-down / restart / restart-exhausted / quota-over / recovered), newest first. Read-only, local only.',
      {
        botId: { type: 'string', description: 'Optional: only incidents for this bot.' },
        kind: {
          type: 'string',
          enum: ['crash', 'health-degraded', 'health-unhealthy', 'health-down', 'restart', 'restart-exhausted', 'quota-over', 'recovered'],
          description: 'Optional: only incidents of this kind.',
        },
        limit: { type: 'number', description: 'Max incidents to return (default 20).' },
      },
      [],
    ),
    needsApproval: false,
    execute: async (args) => {
      const base = resolveBase();
      if (!base) return errorResult(NOT_WIRED);
      try {
        const { fleetRoot } = dirs(base);
        const botId = getStringArg(args, 'botId', false);
        const kind = getStringArg(args, 'kind', false);
        const kinds: FleetV6IncidentKind[] = ['crash', 'health-degraded', 'health-unhealthy', 'health-down', 'restart', 'restart-exhausted', 'quota-over', 'recovered'];
        if (kind && !kinds.includes(kind as FleetV6IncidentKind)) {
          return errorResult(`kind must be one of: ${kinds.join(', ')}.`);
        }
        const incidents = listFleetV6Incidents(fleetRoot, {
          ...(botId ? { botId } : {}),
          ...(kind ? { kind: kind as FleetV6IncidentKind } : {}),
          limit: getNumberArg(args, 'limit', 20),
        });
        return JSON.stringify({ count: incidents.length, incidents }, null, 2).slice(0, 20000);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const healthRestartTool: Tool = {
    definition: toolDef(
      'fleet_health_restart',
      'Record a bot crash and decide the restart (action=record-crash: exponential backoff, exhausted after max restarts in the window, no auto-restart once unhealthy), or record a successful restart (action=record-restart). Writes the health state + incident log.',
      {
        botId: { type: 'string', description: 'Bot that crashed / restarted.' },
        action: { type: 'string', enum: ['record-crash', 'record-restart'], description: 'record-crash (default) or record-restart.' },
        message: { type: 'string', description: 'Crash message (record-crash; short, no secrets).' },
      },
      ['botId'],
    ),
    needsApproval: true,
    execute: async (args) => {
      const base = resolveBase();
      if (!base) return errorResult(NOT_WIRED);
      try {
        const { fleetRoot } = dirs(base);
        const botId = getStringArg(args, 'botId');
        const action = getStringArg(args, 'action', false) || 'record-crash';
        if (action !== 'record-crash' && action !== 'record-restart') {
          return errorResult('action must be one of: record-crash, record-restart.');
        }
        const now = Date.now();
        let states = loadFleetV6HealthStates(fleetRoot);
        if (action === 'record-restart') {
          states = recordFleetV6Restart(states, botId, now);
          saveFleetV6HealthStates(fleetRoot, states);
          appendFleetV6Incident(fleetRoot, createFleetV6Incident(botId, 'restart', 'Bot restarted successfully.', now));
          return JSON.stringify({ action, botId, recorded: true }, null, 2);
        }
        const message = getStringArg(args, 'message', false) || 'Bot crashed.';
        states = recordFleetV6Crash(states, botId, now, message);
        saveFleetV6HealthStates(fleetRoot, states);
        const state = states.find((s) => s.botId === botId);
        const decision = decideFleetV6Restart(
          DEFAULT_FLEET_V6_RESTART_POLICY,
          state?.crashHistory ?? [],
          state?.consecutiveFailures ?? 0,
          now,
        );
        appendFleetV6Incident(
          fleetRoot,
          createFleetV6Incident(botId, 'crash', message, now, { decision: decision.reason, delayMs: decision.delayMs }),
        );
        if (decision.exhausted) {
          appendFleetV6Incident(fleetRoot, createFleetV6Incident(botId, 'restart-exhausted', 'Bot exhausted its restarts in the window.', now));
        }
        return JSON.stringify({ action, botId, decision, consecutiveFailures: state?.consecutiveFailures ?? 0 }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  return [
    scheduleCreateTool,
    scheduleListTool,
    scheduleRunNowTool,
    scheduleQueueTool,
    quotaGroupSetTool,
    quotaGroupListTool,
    quotaGroupCheckTool,
    healthCheckTool,
    healthIncidentsTool,
    healthRestartTool,
  ];
}

/**
 * Unbound placeholders, registered in ALL_TOOLS (see tools.ts).
 * All ten are file-backed and answer NOT_WIRED until the host binds
 * a base dir.
 */
export const FLEET_V6_TOOLS: Tool[] = createFleetV6Tools();

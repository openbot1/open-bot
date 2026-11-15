/**
 * Fleet overview v6 — một cái nhìn duy nhất cho UI fleet v6 (v1.09, Đội T6).
 *
 * Ghép dữ liệu từ ba module v6 đã có — không phát minh số:
 * - lịch: `fleet/fleetV6Scheduler.ts` (schedule + queue + timeslot);
 * - quota: `fleet/fleetV6Quotas.ts` (đánh giá nhóm/bot + throttle/pause);
 * - health: `fleet/fleetV6Health.ts` (health check + incident log).
 *
 * `aggregateFleetV6Overview` là hàm thuần (nhận dữ liệu đã load — dễ
 * test, dễ dùng cho UI mock); `buildFleetV6Overview` là wrapper đọc
 * file từ fleetRoot (lịch + queue + nhóm quota + health states +
 * incidents + usage ledger của quotas v2 để tính mức dùng thật).
 *
 * Số nào không đo được thì báo `null` / `usageKnown: false`, không đoán
 * là 0 — cùng nguyên tắc trung thực với fleetV5Health.
 */

import { cpuRateFromSamples, loadBotQuotas, summarizeBotUsage, type BotQuota } from './quotas';
import type { FleetUsageSample } from './types';
import { readUsageSamplesFor } from './usage';
import {
  loadFleetV6Queue,
  loadFleetV6Schedules,
  planFleetV6Day,
  type FleetV6DayPlan,
  type FleetV6QueueEntry,
  type FleetV6Schedule,
} from './fleetV6Scheduler';
import {
  evaluateFleetV6Quotas,
  loadFleetV6QuotaGroups,
  type FleetV6QuotaAlert,
  type FleetV6QuotaEvaluation,
  type FleetV6QuotaGroup,
} from './fleetV6Quotas';
import {
  checkFleetV6BotHealth,
  listFleetV6Incidents,
  loadFleetV6HealthStates,
  type FleetV6BotHealthResult,
  type FleetV6BotHealthState,
  type FleetV6HealthStatus,
  type FleetV6Incident,
} from './fleetV6Health';

/** Một bot trong dashboard v6 (ghép health + quota + lịch + queue). */
export interface FleetV6BotOverview {
  botId: string;
  status: FleetV6HealthStatus;
  /** Bot có đang chạy (có queue entry running) không. */
  running: boolean;
  /** Số queue entry đang chờ của bot. */
  waiting: number;
  /** Số lần restart gần đây (trong cửa sổ restart). */
  restarts: number;
  /** Số lỗi liên tiếp hiện tại. */
  consecutiveFailures: number;
  /** Bot có đang bị đánh dấu unhealthy không. */
  unhealthy: boolean;
  /** Bot có đang bị pause bởi quota không. */
  pausedByQuota: boolean;
  /** Concurrency tối đa sau throttle (null = không bị throttle). */
  throttleMaxConcurrent: number | null;
  /** Mức dùng đã đo (null = chưa đo được). */
  usage: { cpuCores: number | null; ramBytes: number | null; diskBytes: number | null };
  usageKnown: boolean;
  /** Mức quota nghiêm trọng nhất (null khi chưa đặt quota). */
  quotaLevel: FleetV6QuotaEvaluation['overall'] | null;
  /** Lần chạy theo lịch kế tiếp (epoch ms, null khi không có lịch bật). */
  nextRunAt: number | null;
  /** Lỗi gần nhất. */
  lastError: string | null;
  /** Lần health check gần nhất (epoch ms, null khi chưa check). */
  lastCheckAt: number | null;
}

/** Cảnh báo dashboard v6 (để UI vẽ banner). */
export interface FleetV6OverviewWarning {
  level: 'warning' | 'critical';
  code:
    | 'bot-unhealthy'
    | 'bot-down'
    | 'bot-over-quota'
    | 'bot-throttled'
    | 'bot-paused-by-quota'
    | 'queue-backlog'
    | 'schedule-unscheduled'
    | 'no-schedules';
  message: string;
  botId?: string;
  groupId?: string;
}

/** Tổng số dashboard v6. */
export interface FleetV6OverviewTotals {
  botsTotal: number;
  botsHealthy: number;
  botsDegraded: number;
  botsUnhealthy: number;
  botsDown: number;
  botsPaused: number;
  botsThrottled: number;
  schedulesTotal: number;
  schedulesEnabled: number;
  schedulesUnscheduled: number;
  queueWaiting: number;
  queueRunning: number;
  queueDone: number;
  incidentsTotal: number;
  incidentsLastHour: number;
}

/** Dashboard v6 đầy đủ cho UI. */
export interface FleetV6Overview {
  at: number;
  bots: FleetV6BotOverview[];
  totals: FleetV6OverviewTotals;
  warnings: FleetV6OverviewWarning[];
  /** Kế hoạch timeslot hôm nay (null khi không có lịch nào). */
  dayPlan: FleetV6DayPlan | null;
  quotaEvaluations: FleetV6QuotaEvaluation[];
  quotaAlerts: FleetV6QuotaAlert[];
  incidents: FleetV6Incident[];
  queue: FleetV6QueueEntry[];
}

/** Đầu vào hàm thuần aggregate (dữ liệu đã load sẵn). */
export interface FleetV6OverviewInput {
  schedules: FleetV6Schedule[];
  queue: FleetV6QueueEntry[];
  quotaGroups: FleetV6QuotaGroup[];
  botQuotas: BotQuota[];
  /** Mức dùng đã đo theo bot (null = chưa đo được). */
  usageByBot: Record<string, { cpuCores: number | null; ramBytes: number | null; diskBytes: number | null }>;
  /** Kết quả health check theo bot (mới nhất). */
  healthByBot: Record<string, FleetV6BotHealthResult>;
  healthStates: FleetV6BotHealthState[];
  incidents: FleetV6Incident[];
  /** Bot đang bị pause bởi quota (từ lần đánh giá trước / store ngoài). */
  pausedBotIds?: string[];
  now?: number;
}

/** Ngưỡng backlog: hàng đợi chờ vượt từng này thì cảnh báo. */
export const FLEET_V6_QUEUE_BACKLOG_WARN = 10;

function emptyTotals(): FleetV6OverviewTotals {
  return {
    botsTotal: 0,
    botsHealthy: 0,
    botsDegraded: 0,
    botsUnhealthy: 0,
    botsDown: 0,
    botsPaused: 0,
    botsThrottled: 0,
    schedulesTotal: 0,
    schedulesEnabled: 0,
    schedulesUnscheduled: 0,
    queueWaiting: 0,
    queueRunning: 0,
    queueDone: 0,
    incidentsTotal: 0,
    incidentsLastHour: 0,
  };
}

/**
 * Ghép dashboard v6 từ dữ liệu đã load. Bot nào không có health check
 * thì status `down` với usageKnown false — không đoán là healthy.
 */
export function aggregateFleetV6Overview(input: FleetV6OverviewInput): FleetV6Overview {
  const now = input.now ?? Date.now();
  const pausedSet = new Set(input.pausedBotIds ?? []);
  const usageByBot = input.usageByBot;
  const quotaEvaluations = evaluateFleetV6Quotas(
    input.quotaGroups,
    Object.fromEntries(
      Object.entries(usageByBot).map(([botId, usage]) => [
        botId,
        { cpuCoresUsed: usage.cpuCores, ramBytesUsed: usage.ramBytes, diskBytesUsed: usage.diskBytes },
      ]),
    ),
    input.botQuotas,
    now,
  );
  const quotaAlerts: FleetV6QuotaAlert[] = [];
  for (const evaluation of quotaEvaluations) {
    for (const resource of evaluation.resources) {
      if (resource.level === 'ok' || resource.level === 'unknown') continue;
      const percentText = resource.percent === null ? 'unknown' : `${Math.round(resource.percent * 100)}%`;
      quotaAlerts.push({
        at: now,
        scope: evaluation.scope,
        id: evaluation.id,
        name: evaluation.name,
        resource: resource.resource,
        percent: resource.percent,
        level: resource.level,
        action: evaluation.action,
        message:
          evaluation.scope === 'group'
            ? `Quota group "${evaluation.name}" ${resource.resource} at ${percentText} of limit (${resource.level}, action ${evaluation.action}).`
            : `Bot "${evaluation.name}" ${resource.resource} at ${percentText} of quota (${resource.level}, action ${evaluation.action}).`,
      });
    }
  }

  // Throttle cap + paused set từ đánh giá quota.
  const throttleCap = new Map<string, number>();
  const pausedByQuota = new Set<string>(pausedSet);
  for (const evaluation of quotaEvaluations) {
    if (evaluation.action === 'throttle' && evaluation.throttleMaxConcurrent !== null) {
      for (const botId of evaluation.botIds) {
        const current = throttleCap.get(botId);
        throttleCap.set(
          botId,
          current === undefined ? evaluation.throttleMaxConcurrent : Math.min(current, evaluation.throttleMaxConcurrent),
        );
      }
    }
    if (evaluation.action === 'pause') {
      for (const botId of evaluation.pausedBotIds) pausedByQuota.add(botId);
    }
  }

  // Tập bot = hợp của schedule bot + queue bot + health bot + quota bot.
  const botIds = new Set<string>();
  for (const s of input.schedules) botIds.add(s.botId);
  for (const e of input.queue) botIds.add(e.botId);
  for (const botId of Object.keys(input.healthByBot)) botIds.add(botId);
  for (const state of input.healthStates) botIds.add(state.botId);
  for (const q of input.botQuotas) botIds.add(q.botId);
  for (const group of input.quotaGroups) for (const botId of group.botIds) botIds.add(botId);

  const dayStart = new Date(now);
  dayStart.setHours(0, 0, 0, 0);
  const dayPlan = input.schedules.length > 0 ? planFleetV6Day(input.schedules, dayStart.getTime()) : null;

  const totals = emptyTotals();
  totals.schedulesTotal = input.schedules.length;
  totals.schedulesEnabled = input.schedules.filter((s) => s.enabled).length;
  totals.schedulesUnscheduled = dayPlan ? dayPlan.unscheduled.length : 0;
  totals.queueWaiting = input.queue.filter((e) => e.status === 'waiting').length;
  totals.queueRunning = input.queue.filter((e) => e.status === 'running').length;
  totals.queueDone = input.queue.filter((e) => e.status === 'done').length;
  totals.incidentsTotal = input.incidents.length;
  totals.incidentsLastHour = input.incidents.filter((i) => now - i.at <= 60 * 60 * 1000).length;

  const bots: FleetV6BotOverview[] = [];
  const warnings: FleetV6OverviewWarning[] = [];

  for (const botId of [...botIds].sort()) {
    const health = input.healthByBot[botId];
    const state = input.healthStates.find((s) => s.botId === botId);
    const usage = usageByBot[botId] ?? { cpuCores: null, ramBytes: null, diskBytes: null };
    const usageKnown = usage.cpuCores !== null || usage.ramBytes !== null || usage.diskBytes !== null;
    const status: FleetV6HealthStatus = health ? health.status : state?.lastStatus ?? 'down';
    const running = input.queue.some((e) => e.botId === botId && e.status === 'running');
    const waiting = input.queue.filter((e) => e.botId === botId && e.status === 'waiting').length;
    const quotaForBot = quotaEvaluations.filter((e) => e.botIds.includes(botId));
    const worstQuota = quotaForBot.reduce<FleetV6QuotaEvaluation['overall'] | null>((worst, evaluation) => {
      if (worst === null) return evaluation.overall;
      const rank: Record<string, number> = { ok: 0, unknown: 1, warning: 2, breach: 3 };
      return rank[evaluation.overall] > rank[worst] ? evaluation.overall : worst;
    }, null);
    const nextRunAt = input.schedules
      .filter((s) => s.botId === botId && s.enabled && s.nextRunAt !== null)
      .map((s) => s.nextRunAt as number)
      .sort((a, b) => a - b)[0] ?? null;
    const paused = pausedByQuota.has(botId);
    const throttle = throttleCap.get(botId) ?? null;
    bots.push({
      botId,
      status,
      running,
      waiting,
      restarts: state?.restartHistory.length ?? 0,
      consecutiveFailures: state?.consecutiveFailures ?? 0,
      unhealthy: state?.unhealthy ?? health?.markedUnhealthy ?? false,
      pausedByQuota: paused,
      throttleMaxConcurrent: throttle,
      usage,
      usageKnown,
      quotaLevel: worstQuota,
      nextRunAt,
      lastError: health?.lastError ?? state?.lastError ?? null,
      lastCheckAt: state?.lastCheckAt ?? health?.at ?? null,
    });

    if (status === 'unhealthy') {
      warnings.push({ level: 'critical', code: 'bot-unhealthy', message: `Bot "${botId}" is unhealthy after repeated failures.`, botId });
    } else if (status === 'down') {
      warnings.push({ level: 'critical', code: 'bot-down', message: `Bot "${botId}" is down (no heartbeat / service error).`, botId });
    }
    if (worstQuota === 'breach') {
      warnings.push({ level: 'critical', code: 'bot-over-quota', message: `Bot "${botId}" is over quota.`, botId });
    }
    if (throttle !== null) {
      warnings.push({ level: 'warning', code: 'bot-throttled', message: `Bot "${botId}" is throttled to ${throttle} concurrent run(s).`, botId });
    }
    if (paused) {
      warnings.push({ level: 'warning', code: 'bot-paused-by-quota', message: `Bot "${botId}" is paused by quota (no new tasks).`, botId });
    }
  }

  totals.botsTotal = bots.length;
  totals.botsHealthy = bots.filter((b) => b.status === 'healthy').length;
  totals.botsDegraded = bots.filter((b) => b.status === 'degraded').length;
  totals.botsUnhealthy = bots.filter((b) => b.status === 'unhealthy').length;
  totals.botsDown = bots.filter((b) => b.status === 'down').length;
  totals.botsPaused = bots.filter((b) => b.pausedByQuota).length;
  totals.botsThrottled = bots.filter((b) => b.throttleMaxConcurrent !== null).length;

  if (totals.queueWaiting > FLEET_V6_QUEUE_BACKLOG_WARN) {
    warnings.push({
      level: 'warning',
      code: 'queue-backlog',
      message: `Queue backlog: ${totals.queueWaiting} entries waiting (over ${FLEET_V6_QUEUE_BACKLOG_WARN}).`,
    });
  }
  if (dayPlan && dayPlan.unscheduled.length > 0) {
    warnings.push({
      level: 'warning',
      code: 'schedule-unscheduled',
      message: `${dayPlan.unscheduled.length} schedule(s) could not be placed in today's timeslots.`,
    });
  }
  if (input.schedules.length === 0) {
    warnings.push({ level: 'warning', code: 'no-schedules', message: 'No fleet v6 schedules yet.' });
  }

  return {
    at: now,
    bots,
    totals,
    warnings,
    dayPlan,
    quotaEvaluations,
    quotaAlerts,
    incidents: [...input.incidents].sort((a, b) => b.at - a.at),
    queue: [...input.queue].sort((a, b) => a.enqueuedAt - b.enqueuedAt),
  };
}

/** Mức dùng đã đo từ usage ledger của quotas v2 (RSS mới nhất + CPU rate). */
export function fleetV6UsageFromLedger(
  samplesByBot: Record<string, FleetUsageSample[]>,
): Record<string, { cpuCores: number | null; ramBytes: number | null; diskBytes: number | null }> {
  const out: Record<string, { cpuCores: number | null; ramBytes: number | null; diskBytes: number | null }> = {};
  for (const [botId, samples] of Object.entries(samplesByBot)) {
    const summary = summarizeBotUsage(botId, samples);
    out[botId] = {
      cpuCores: cpuRateFromSamples(samples),
      ramBytes: summary?.latestRssBytes ?? null,
      diskBytes: summary?.latestDiskBytes ?? null,
    };
  }
  return out;
}

/**
 * Wrapper đọc file từ fleetRoot rồi aggregate. Health check được chạy
 * lại từ dữ liệu mới nhất: heartbeat lấy từ usage ledger (sample mới
 * nhất), lỗi gần đây lấy từ incident log (kind crash trong 1 giờ).
 */
export function buildFleetV6Overview(
  rootDir: string,
  now: number = Date.now(),
  options: { incidentLimit?: number } = {},
): FleetV6Overview {
  const schedules = loadFleetV6Schedules(rootDir);
  const queue = loadFleetV6Queue(rootDir);
  const quotaGroups = loadFleetV6QuotaGroups(rootDir);
  const botQuotas = loadBotQuotas(rootDir);
  const healthStates = loadFleetV6HealthStates(rootDir);
  const incidents = listFleetV6Incidents(rootDir, { limit: options.incidentLimit ?? 50 });

  // Mức dùng thật từ usage ledger (samples theo bot).
  const usageByBot: Record<string, { cpuCores: number | null; ramBytes: number | null; diskBytes: number | null }> = {};
  const samplesByBot: Record<string, FleetUsageSample[]> = {};
  for (const botId of new Set([
    ...schedules.map((s) => s.botId),
    ...queue.map((e) => e.botId),
    ...healthStates.map((s) => s.botId),
  ])) {
    try {
      const samples = readUsageSamplesFor(rootDir, botId);
      samplesByBot[botId] = samples;
    } catch {
      samplesByBot[botId] = [];
    }
  }
  Object.assign(usageByBot, fleetV6UsageFromLedger(samplesByBot));

  // Health check mỗi bot từ heartbeat (sample mới nhất) + lỗi gần đây.
  const healthByBot: Record<string, FleetV6BotHealthResult> = {};
  for (const botId of Object.keys(samplesByBot)) {
    const state = healthStates.find((s) => s.botId === botId);
    const samples = samplesByBot[botId] ?? [];
    const lastSample = samples[samples.length - 1];
    const recentErrors = incidents
      .filter((i) => i.botId === botId && i.kind === 'crash')
      .map((i) => ({ at: i.at, message: i.message }));
    const summary = summarizeBotUsage(botId, samples);
    const quota = botQuotas.find((q) => q.botId === botId);
    healthByBot[botId] = checkFleetV6BotHealth(
      {
        botId,
        lastHeartbeatAt: lastSample ? lastSample.at : null,
        serviceState: lastSample?.servicePid ? 'running' : state?.lastStatus === 'down' ? 'error' : 'stopped',
        usage: summary
          ? { cpuCoresUsed: cpuRateFromSamples(samples), ramBytesUsed: summary.latestRssBytes, diskBytesUsed: summary.latestDiskBytes }
          : null,
        ...(quota ? { quota } : {}),
        recentErrors,
        consecutiveFailures: state?.consecutiveFailures ?? 0,
      },
      now,
    );
  }

  return aggregateFleetV6Overview({
    schedules,
    queue,
    quotaGroups,
    botQuotas,
    usageByBot,
    healthByBot,
    healthStates,
    incidents,
    now,
  });
}

/** Một dòng tóm tắt dashboard cho log/CLI. */
export function formatFleetV6OverviewLine(overview: FleetV6Overview): string {
  const t = overview.totals;
  return (
    `fleet v6: ${t.botsHealthy}/${t.botsTotal} healthy, ${t.botsDegraded} degraded, ` +
    `${t.botsUnhealthy} unhealthy, ${t.botsDown} down; queue ${t.queueWaiting} waiting / ` +
    `${t.queueRunning} running; ${t.schedulesEnabled}/${t.schedulesTotal} schedules enabled; ` +
    `${t.incidentsLastHour} incident(s) in the last hour`
  );
}

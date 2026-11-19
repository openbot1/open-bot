/**
 * Health v26 — per-bot health checks + fleet health summary (v1.39, Team T6).
 *
 * Health is a SCORE, not a vibe: every check is a named probe with a
 * pass/warn/fail verdict and a point cost, so the UI can show WHY a
 * bot is degraded instead of just colouring it red. Checks:
 *
 * - `heartbeat`: the bot heartbeated recently (stale beat = fail).
 * - `state`: the bot is in a healthy state (running = pass, paused =
 *   warn, failed = fail, registered/stopped = warn "not running").
 * - `quota-usage`: reported CPU/RAM use vs the granted quota (over
 *   quota = fail, over 85% = warn). Usage is host-reported; when the
 *   host reports nothing the check is `unknown` and costs nothing.
 * - `restarts`: restart count inside the window (at cap = fail).
 * - `errors`: a recorded last error (present = warn, it explains the
 *   failure but the state check already fails the bot).
 *
 * Scores: 100 start, warn -10, fail -40 (floor 0). Bands: >= 90
 * healthy, >= 60 degraded, else unhealthy. The fleet summary rolls
 * the worst band up and counts bots per band, so one sick bot never
 * hides behind a fleet average.
 */

import type { FleetV26Bot, FleetV26BotRegistry } from './bots';
import { FLEET_V26_HEARTBEAT_STALE_MS } from './bots';

/** One health probe verdict. */
export type FleetV26CheckVerdict = 'pass' | 'warn' | 'fail' | 'unknown';

/** One health check result. */
export interface FleetV26HealthCheck {
  name: string;
  verdict: FleetV26CheckVerdict;
  /** Points deducted from 100 (0 for pass/unknown). */
  cost: number;
  detail: string;
}

/** Health band for a bot. */
export type FleetV26HealthBand = 'healthy' | 'degraded' | 'unhealthy' | 'unknown';

/** Host-reported resource use for one bot (null fields = not reported). */
export interface FleetV26BotUsage {
  botId: string;
  /** CPU cores in use right now. */
  cpuCores: number | null;
  /** RAM, MiB, in use right now. */
  ramMB: number | null;
  /** Disk, MiB, in use right now. */
  diskMB: number | null;
  reportedAtMs: number;
}

/** Full health report for one bot. */
export interface FleetV26BotHealth {
  botId: string;
  state: FleetV26Bot['state'];
  score: number;
  band: FleetV26HealthBand;
  checks: FleetV26HealthCheck[];
  /** One-line cause (the worst failing check, or "healthy"). */
  cause: string;
  checkedAtMs: number;
}

/** Fleet-wide health roll-up. */
export interface FleetV26FleetHealth {
  band: FleetV26HealthBand;
  bots: number;
  healthy: number;
  degraded: number;
  unhealthy: number;
  unknown: number;
  /** Worst-scoring bots first (top 5). */
  worst: FleetV26BotHealth[];
  averageScore: number | null;
  checkedAtMs: number;
}

export const FLEET_V26_HEALTHY_MIN = 90;
export const FLEET_V26_DEGRADED_MIN = 60;
/** Usage at/above this fraction of quota warns (85%). */
export const FLEET_V26_QUOTA_WARN_FRACTION = 0.85;

function bandFor(score: number, hasChecks: boolean): FleetV26HealthBand {
  if (!hasChecks) return 'unknown';
  if (score >= FLEET_V26_HEALTHY_MIN) return 'healthy';
  if (score >= FLEET_V26_DEGRADED_MIN) return 'degraded';
  return 'unhealthy';
}

function checkHeartbeat(bot: FleetV26Bot, nowMs: number): FleetV26HealthCheck {
  if (bot.state === 'stopped' || bot.state === 'registered') {
    return { name: 'heartbeat', verdict: 'unknown', cost: 0, detail: `Bot is ${bot.state}; no heartbeat expected.` };
  }
  if (bot.lastHeartbeatMs === null) {
    return { name: 'heartbeat', verdict: 'fail', cost: 40, detail: 'No heartbeat received yet.' };
  }
  const ageMs = nowMs - bot.lastHeartbeatMs;
  if (ageMs > FLEET_V26_HEARTBEAT_STALE_MS) {
    return {
      name: 'heartbeat',
      verdict: 'fail',
      cost: 40,
      detail: `Heartbeat is ${Math.round(ageMs / 1000)}s old (stale after ${FLEET_V26_HEARTBEAT_STALE_MS / 1000}s).`,
    };
  }
  return { name: 'heartbeat', verdict: 'pass', cost: 0, detail: `Heartbeat ${Math.round(ageMs / 1000)}s ago.` };
}

function checkState(bot: FleetV26Bot): FleetV26HealthCheck {
  switch (bot.state) {
    case 'running':
      return { name: 'state', verdict: 'pass', cost: 0, detail: 'Bot is running.' };
    case 'starting':
    case 'stopping':
      return { name: 'state', verdict: 'warn', cost: 10, detail: `Bot is ${bot.state} (transitional).` };
    case 'paused':
      return { name: 'state', verdict: 'warn', cost: 10, detail: 'Bot is paused (not working).' };
    case 'registered':
    case 'stopped':
      return { name: 'state', verdict: 'warn', cost: 10, detail: `Bot is ${bot.state} (not running).` };
    case 'failed':
      return {
        name: 'state',
        verdict: 'fail',
        cost: 40,
        detail: bot.lastError ? `Bot failed: ${bot.lastError}` : 'Bot failed.',
      };
  }
}

function checkQuotaUsage(bot: FleetV26Bot, usage: FleetV26BotUsage | null): FleetV26HealthCheck {
  if (!bot.quota) {
    return { name: 'quota-usage', verdict: 'unknown', cost: 0, detail: 'No quota granted; nothing to compare.' };
  }
  if (!usage) {
    return { name: 'quota-usage', verdict: 'unknown', cost: 0, detail: 'Host reported no usage yet.' };
  }
  const over: string[] = [];
  const near: string[] = [];
  const pairs: Array<[string, number | null, number, string]> = [
    ['CPU', usage.cpuCores, bot.quota.cpuCores, 'cores'],
    ['RAM', usage.ramMB, bot.quota.ramMB, 'MiB'],
    ['disk', usage.diskMB, bot.quota.diskMB, 'MiB'],
  ];
  for (const [label, used, quota, unit] of pairs) {
    if (used === null || quota <= 0) continue;
    if (used > quota) over.push(`${label} ${used}${unit} > ${quota}${unit} quota`);
    else if (used >= quota * FLEET_V26_QUOTA_WARN_FRACTION) {
      near.push(`${label} ${used}${unit} of ${quota}${unit}`);
    }
  }
  if (over.length > 0) {
    return { name: 'quota-usage', verdict: 'fail', cost: 40, detail: `Over quota: ${over.join('; ')}.` };
  }
  if (near.length > 0) {
    return { name: 'quota-usage', verdict: 'warn', cost: 10, detail: `Near quota: ${near.join('; ')}.` };
  }
  return { name: 'quota-usage', verdict: 'pass', cost: 0, detail: 'Usage is inside quota.' };
}

function checkRestarts(bot: FleetV26Bot): FleetV26HealthCheck {
  if (bot.totalRestarts === 0) {
    return { name: 'restarts', verdict: 'pass', cost: 0, detail: 'Never restarted.' };
  }
  if (bot.state === 'failed' && bot.restartsInWindow >= bot.spec.maxRestarts) {
    return {
      name: 'restarts',
      verdict: 'fail',
      cost: 40,
      detail: `Restart cap hit (${bot.restartsInWindow}/${bot.spec.maxRestarts} in this window).`,
    };
  }
  if (bot.restartsInWindow > 0) {
    return {
      name: 'restarts',
      verdict: 'warn',
      cost: 10,
      detail: `${bot.restartsInWindow} restart(s) in this window, ${bot.totalRestarts} total.`,
    };
  }
  return { name: 'restarts', verdict: 'pass', cost: 0, detail: `${bot.totalRestarts} restart(s) total, none in this window.` };
}

function checkErrors(bot: FleetV26Bot): FleetV26HealthCheck {
  if (!bot.lastError) return { name: 'errors', verdict: 'pass', cost: 0, detail: 'No recorded error.' };
  return { name: 'errors', verdict: 'warn', cost: 10, detail: `Last error: ${bot.lastError}` };
}

/** Run all health checks for one bot. */
export function checkFleetV26BotHealth(
  bot: FleetV26Bot,
  usage: FleetV26BotUsage | null = null,
  nowMs: number = Date.now(),
): FleetV26BotHealth {
  const checks = [
    checkHeartbeat(bot, nowMs),
    checkState(bot),
    checkQuotaUsage(bot, usage),
    checkRestarts(bot),
    checkErrors(bot),
  ];
  const known = checks.filter((c) => c.verdict !== 'unknown');
  const cost = checks.reduce((sum, c) => sum + c.cost, 0);
  const score = Math.max(0, 100 - cost);
  const worst = checks
    .filter((c) => c.verdict === 'fail')
    .concat(checks.filter((c) => c.verdict === 'warn'))[0];
  return {
    botId: bot.spec.id,
    state: bot.state,
    score,
    band: bandFor(score, known.length > 0),
    checks,
    cause: worst ? worst.detail : 'Healthy.',
    checkedAtMs: nowMs,
  };
}

/** Health for every bot in a registry (usage keyed by bot id). */
export function checkFleetV26FleetHealth(
  reg: FleetV26BotRegistry,
  usageByBot: ReadonlyMap<string, FleetV26BotUsage> | Record<string, FleetV26BotUsage> = {},
  nowMs: number = Date.now(),
): FleetV26FleetHealth {
  const bots = reg.list();
  const getUsage = (id: string): FleetV26BotUsage | null => {
    if (usageByBot instanceof Map) return usageByBot.get(id) ?? null;
    return (usageByBot as Record<string, FleetV26BotUsage>)[id] ?? null;
  };
  const reports = bots.map((b) => checkFleetV26BotHealth(b, getUsage(b.spec.id), nowMs));
  let healthy = 0;
  let degraded = 0;
  let unhealthy = 0;
  let unknown = 0;
  let scoreSum = 0;
  let scored = 0;
  for (const r of reports) {
    if (r.band === 'healthy') healthy += 1;
    else if (r.band === 'degraded') degraded += 1;
    else if (r.band === 'unhealthy') unhealthy += 1;
    else unknown += 1;
    if (r.band !== 'unknown') {
      scoreSum += r.score;
      scored += 1;
    }
  }
  const band: FleetV26HealthBand =
    reports.length === 0 ? 'unknown' : unhealthy > 0 ? 'unhealthy' : degraded > 0 ? 'degraded' : unknown === reports.length ? 'unknown' : 'healthy';
  return {
    band,
    bots: reports.length,
    healthy,
    degraded,
    unhealthy,
    unknown,
    worst: [...reports].sort((a, b) => a.score - b.score).slice(0, 5),
    averageScore: scored === 0 ? null : Math.round((scoreSum / scored) * 10) / 10,
    checkedAtMs: nowMs,
  };
}

/** One-line summary for the health panel. */
export function summarizeFleetV26Health(health: FleetV26FleetHealth): string {
  if (health.bots === 0) return 'No bots registered yet.';
  const avg = health.averageScore === null ? 'n/a' : `${health.averageScore}`;
  return (
    `Fleet ${health.band} (avg score ${avg}): ${health.healthy} healthy, ` +
    `${health.degraded} degraded, ${health.unhealthy} unhealthy, ${health.unknown} unknown ` +
    `of ${health.bots} bot(s)`
  );
}

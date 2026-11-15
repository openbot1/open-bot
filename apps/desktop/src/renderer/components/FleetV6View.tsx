import { useCallback, useEffect, useState } from 'react';
import type { FleetV6OverviewView } from '../types';
import { useT } from '../i18n/useT';

/**
 * Fleet v6 view (v1.09) — scheduler + group quotas + health in the fleet
 * console: bot table (status, quota, usage, next run), priority queue,
 * today's timeslot plan, health/incident log.
 *
 * Data via IPC `fleet:v6-overview` (main.ts -> buildFleetV6Overview reads
 * files under <userData>/fleet). Outside desktop (no IPC) it receives
 * `overview` via props — the component never guesses numbers.
 */

async function callOpenBot<T>(channel: string, camel: string): Promise<T | null> {
  const api = window.openBot as unknown as Record<string, unknown>;
  const fn = api[channel] ?? api[camel];
  if (typeof fn !== 'function') return null;
  return (fn as () => Promise<T>).call(window.openBot);
}

function formatBytes(bytes: number | null): string {
  if (bytes === null) return '—';
  const gb = bytes / 1024 ** 3;
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  const mb = bytes / 1024 ** 2;
  if (mb >= 1) return `${mb.toFixed(0)} MB`;
  return `${Math.round(bytes / 1024)} KB`;
}

function formatTime(at: number | null): string {
  if (at === null) return '—';
  return new Date(at).toLocaleString();
}

function formatClock(at: number): string {
  const d = new Date(at);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

export default function FleetV6View({ overview: overviewProp }: { overview?: FleetV6OverviewView | null }) {
  const t = useT();
  const [overview, setOverview] = useState<FleetV6OverviewView | null>(overviewProp ?? null);
  const [loading, setLoading] = useState(!overviewProp);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await callOpenBot<FleetV6OverviewView>('fleet:v6-overview', 'getFleetV6Overview');
      if (data) setOverview(data);
      else setError(t('fleetV6.loadError'));
    } catch (err) {
      setError((err as Error).message || t('fleetV6.loadError'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    if (overviewProp) {
      setOverview(overviewProp);
      setLoading(false);
      return;
    }
    void load();
  }, [load, overviewProp]);

  if (loading) return <p>{t('marketplace.loading')}</p>;
  if (error) return <p style={{ color: '#c00' }}>{error}</p>;
  if (!overview) return <p>{t('fleetV6.noBots')}</p>;

  const { totals } = overview;
  return (
    <div>
      <h3>{t('fleetV6.title')}</h3>
      <p style={{ color: '#666' }}>{t('fleetV6.subtitle')}</p>
      <div className="row" style={{ gap: 8, marginBottom: 12 }}>
        <button className="btn secondary" onClick={() => void load()}>
          {t('fleetV6.refresh')}
        </button>
        <span style={{ alignSelf: 'center', color: '#666' }}>
          {totals.botsHealthy}/{totals.botsTotal} {t('fleetV6.healthy')} · {totals.botsDegraded}{' '}
          {t('fleetV6.degraded')} · {totals.botsUnhealthy} {t('fleetV6.unhealthy')} · {totals.botsDown}{' '}
          {t('fleetV6.down')} · {t('fleetV6.queueTitle')}: {totals.queueWaiting} {t('fleetV6.waiting')} /{' '}
          {totals.queueRunning} {t('fleetV6.running')}
        </span>
      </div>

      {overview.warnings.length > 0 && (
        <div style={{ marginBottom: 12 }}>
          <h4>{t('fleetV6.healthTitle')}</h4>
          {overview.warnings.map((w, i) => (
            <p key={i} style={{ color: w.level === 'critical' ? '#c00' : '#a60', margin: '2px 0' }}>
              {w.level === 'critical' ? '⛔ ' : '⚠️ '}
              {w.message}
            </p>
          ))}
        </div>
      )}

      <h4>{t('fleetV6.botsTitle')}</h4>
      {overview.bots.length === 0 ? (
        <p>{t('fleetV6.noBots')}</p>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>{t('fleetV6.bot')}</th>
              <th>{t('fleetV6.status')}</th>
              <th>{t('fleetV6.quota')}</th>
              <th>{t('fleetV6.usage')}</th>
              <th>{t('fleetV6.nextRun')}</th>
              <th>{t('fleetV6.restarts')}</th>
            </tr>
          </thead>
          <tbody>
            {overview.bots.map((bot) => (
              <tr key={bot.botId}>
                <td>
                  {bot.botId}
                  {bot.pausedByQuota ? ` (${t('fleetV6.paused')})` : ''}
                  {bot.throttleMaxConcurrent !== null ? ` (${t('fleetV6.throttled')} ≤ ${bot.throttleMaxConcurrent})` : ''}
                </td>
                <td>
                  {bot.status === 'healthy' && t('fleetV6.healthy')}
                  {bot.status === 'degraded' && t('fleetV6.degraded')}
                  {bot.status === 'unhealthy' && t('fleetV6.unhealthy')}
                  {bot.status === 'down' && t('fleetV6.down')}
                  {bot.running ? ` · ${t('fleetV6.running')}` : ''}
                  {bot.waiting > 0 ? ` · ${bot.waiting} ${t('fleetV6.waiting')}` : ''}
                </td>
                <td>
                  {bot.quotaLevel === null && '—'}
                  {bot.quotaLevel === 'ok' && t('fleetV6.withinQuota')}
                  {bot.quotaLevel === 'warning' && t('fleetV6.overQuota')}
                  {bot.quotaLevel === 'breach' && t('fleetV6.overQuota')}
                  {bot.quotaLevel === 'unknown' && '—'}
                </td>
                <td>
                  {bot.usageKnown
                    ? `${bot.usage.cpuCores === null ? '—' : `${bot.usage.cpuCores.toFixed(2)} CPU`} · ${formatBytes(bot.usage.ramBytes)} · ${formatBytes(bot.usage.diskBytes)}`
                    : '—'}
                </td>
                <td>{bot.nextRunAt === null ? '—' : formatTime(bot.nextRunAt)}</td>
                <td>
                  {bot.restarts}
                  {bot.lastError ? ` · ${t('fleetV6.lastCrash')}: ${bot.lastError}` : ''}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h4>{t('fleetV6.group')}</h4>
      {overview.quotaEvaluations.filter((e) => e.scope === 'group').length === 0 ? (
        <p>{t('fleetV6.withinQuota')}</p>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>{t('fleetV6.group')}</th>
              <th>{t('fleetV6.status')}</th>
              <th>{t('fleetV6.quota')}</th>
            </tr>
          </thead>
          <tbody>
            {overview.quotaEvaluations
              .filter((e) => e.scope === 'group')
              .map((evaluation) => (
                <tr key={evaluation.id}>
                  <td>{evaluation.name}</td>
                  <td>
                    {evaluation.overall === 'ok' && t('fleetV6.withinQuota')}
                    {evaluation.overall === 'warning' && t('fleetV6.overQuota')}
                    {evaluation.overall === 'breach' && t('fleetV6.overQuota')}
                    {evaluation.overall === 'unknown' && '—'}
                  </td>
                  <td>
                    {evaluation.action === 'none' && '—'}
                    {evaluation.action === 'warn' && t('fleetV6.overQuota')}
                    {evaluation.action === 'throttle' && t('fleetV6.throttled')}
                    {evaluation.action === 'pause' && t('fleetV6.paused')}
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      )}

      <h4>{t('fleetV6.queueTitle')}</h4>
      {overview.queue.length === 0 ? (
        <p>{t('fleetV6.noQueue')}</p>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>{t('fleetV6.bot')}</th>
              <th>{t('fleetV6.priority')}</th>
              <th>{t('fleetV6.status')}</th>
              <th>{t('fleetV6.schedule')}</th>
            </tr>
          </thead>
          <tbody>
            {overview.queue.map((entry) => (
              <tr key={entry.id}>
                <td>{entry.botId}</td>
                <td>
                  {entry.priority === 'critical' && t('fleetV6.priorityCritical')}
                  {entry.priority === 'high' && t('fleetV6.priorityHigh')}
                  {entry.priority === 'normal' && t('fleetV6.priorityNormal')}
                  {entry.priority === 'low' && t('fleetV6.priorityLow')}
                </td>
                <td>
                  {entry.status === 'waiting' && t('fleetV6.waiting')}
                  {entry.status === 'running' && t('fleetV6.running')}
                  {entry.status === 'done' && '✓'}
                  {entry.status === 'cancelled' && '✕'}
                  {entry.preemptions > 0 ? ` (preempted ${entry.preemptions}/${entry.maxPreemptions})` : ''}
                </td>
                <td>{entry.summary}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {overview.dayPlan && (
        <div>
          <h4>{t('fleetV6.timeslot')}</h4>
          {overview.dayPlan.slots.length === 0 ? (
            <p>{t('fleetV6.noBots')}</p>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>{t('fleetV6.timeslot')}</th>
                  <th>{t('fleetV6.bot')}</th>
                  <th>{t('fleetV6.priority')}</th>
                  <th>{t('fleetV6.heavy')}</th>
                </tr>
              </thead>
              <tbody>
                {overview.dayPlan.slots.map((slot, i) => (
                  <tr key={i}>
                    <td>
                      {formatClock(slot.start)} – {formatClock(slot.end)}
                    </td>
                    <td>{slot.botId}</td>
                    <td>{slot.priority}</td>
                    <td>{slot.heavy ? '★' : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {overview.dayPlan.unscheduled.length > 0 && (
            <p style={{ color: '#a60' }}>
              {overview.dayPlan.unscheduled.map((u) => `${u.botId}: ${u.reason}`).join('; ')}
            </p>
          )}
        </div>
      )}

      <h4>{t('fleetV6.incidentsTitle')}</h4>
      {overview.incidents.length === 0 ? (
        <p>{t('fleetV6.noIncidents')}</p>
      ) : (
        <ul>
          {overview.incidents.slice(0, 20).map((incident) => (
            <li key={incident.id}>
              {formatTime(incident.at)} · {incident.botId} · {incident.kind}: {incident.message}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

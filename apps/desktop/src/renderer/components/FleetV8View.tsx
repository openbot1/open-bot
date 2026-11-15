import { useCallback, useEffect, useState } from 'react';
import type { FleetV8DashboardView } from '../types';
import { useT } from '../i18n/useT';

/**
 * Fleet v8 view (v1.11, Team T6) — node health + aggregated dashboard:
 * v8 node rollup (healthy/degraded/unhealthy/down), local resource probe
 * (CPU/RAM/disk), v6 bots with issues, v7 running campaigns,
 * latest v8 incidents + warnings.
 *
 * Data via IPC `fleet:v8-dashboard` (main.ts -> buildFleetV8Dashboard
 * reads files under <userData>/fleet). Outside desktop (no IPC) it
 * receives `snapshot` via props — the component never guesses numbers.
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

function statusLabel(t: (key: string) => string, status: string): string {
  if (status === 'healthy') return t('fleetV8.statusHealthy');
  if (status === 'degraded') return t('fleetV8.statusDegraded');
  if (status === 'unhealthy') return t('fleetV8.statusUnhealthy');
  if (status === 'down') return t('fleetV8.statusDown');
  return status;
}

export default function FleetV8View({ snapshot: snapshotProp }: { snapshot?: FleetV8DashboardView | null }) {
  const t = useT();
  const [snapshot, setSnapshot] = useState<FleetV8DashboardView | null>(snapshotProp ?? null);
  const [loading, setLoading] = useState(!snapshotProp);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await callOpenBot<FleetV8DashboardView>('fleet:v8-dashboard', 'getFleetV8Dashboard');
      if (data) setSnapshot(data);
      else setError(t('fleetV8.loadError'));
    } catch (err) {
      setError((err as Error).message || t('fleetV8.loadError'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    if (!snapshotProp) void load();
  }, [load, snapshotProp]);

  if (loading) return <div className="fleet-v8">{t('fleetV8.loading')}</div>;
  if (error) {
    return (
      <div className="fleet-v8">
        <p className="error">{error}</p>
        <button type="button" onClick={() => void load()}>
          {t('fleetV8.retry')}
        </button>
      </div>
    );
  }
  if (!snapshot) return <div className="fleet-v8">{t('fleetV8.empty')}</div>;

  const probe = snapshot.localProbe;
  const ramFreePercent =
    probe && probe.ramTotalBytes > 0 ? Math.round((probe.ramFreeBytes / probe.ramTotalBytes) * 1000) / 10 : null;
  const diskFreePercent =
    probe && probe.diskTotalBytes !== null && probe.diskFreeBytes !== null && probe.diskTotalBytes > 0
      ? Math.round((probe.diskFreeBytes / probe.diskTotalBytes) * 1000) / 10
      : null;

  return (
    <div className="fleet-v8">
      <div className="fleet-v8-header">
        <h3>{t('fleetV8.title')}</h3>
        <span>{t('fleetV8.builtAt', { time: formatTime(snapshot.builtAtMs) })}</span>
        <button type="button" onClick={() => void load()}>
          {t('fleetV8.refresh')}
        </button>
      </div>

      {snapshot.alerts.length > 0 && (
        <ul className="fleet-v8-alerts">
          {snapshot.alerts.map((alert, i) => (
            <li key={i} className="warning">
              {alert}
            </li>
          ))}
        </ul>
      )}

      <section>
        <h4>{t('fleetV8.nodesTitle', { count: snapshot.nodes.totalNodes })}</h4>
        <p>
          {t('fleetV8.nodesSummary', {
            healthy: snapshot.nodes.healthy,
            degraded: snapshot.nodes.degraded,
            unhealthy: snapshot.nodes.unhealthy,
            down: snapshot.nodes.down,
          })}
        </p>
        {snapshot.nodeRows.length > 0 && (
          <table>
            <thead>
              <tr>
                <th>{t('fleetV8.colNode')}</th>
                <th>{t('fleetV8.colStatus')}</th>
                <th>{t('fleetV8.colDowns')}</th>
                <th>{t('fleetV8.colRestarts')}</th>
                <th>{t('fleetV8.colLastCheck')}</th>
              </tr>
            </thead>
            <tbody>
              {snapshot.nodeRows.map((row) => (
                <tr key={row.nodeId}>
                  <td>
                    {row.nodeId}
                    {row.isLocal ? ` (${t('fleetV8.localMachine')})` : ''}
                  </td>
                  <td>{statusLabel(t, row.status)}</td>
                  <td>{row.consecutiveDowns}</td>
                  <td>{row.restartAttempts}</td>
                  <td>{formatTime(row.lastCheckedAtMs)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {probe && (
        <section>
          <h4>{t('fleetV8.localProbeTitle')}</h4>
          <p>
            {t('fleetV8.localProbeLine', {
              cores: probe.cpuCores,
              load: probe.cpuLoad1m === null ? '—' : probe.cpuLoad1m.toFixed(2),
              ramFree: ramFreePercent === null ? '—' : `${ramFreePercent}%`,
              diskFree: diskFreePercent === null ? '—' : `${diskFreePercent}%`,
            })}
          </p>
          <p>
            {t('fleetV8.localProbeDetail', {
              ramFree: formatBytes(probe.ramFreeBytes),
              ramTotal: formatBytes(probe.ramTotalBytes),
              diskFree: formatBytes(probe.diskFreeBytes),
              diskTotal: formatBytes(probe.diskTotalBytes),
            })}
          </p>
        </section>
      )}

      <section>
        <h4>{t('fleetV8.problemBotsTitle', { count: snapshot.problemBots.length })}</h4>
        {snapshot.problemBots.length === 0 ? (
          <p>{t('fleetV8.noProblemBots')}</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>{t('fleetV8.colBot')}</th>
                <th>{t('fleetV8.colStatus')}</th>
                <th>{t('fleetV8.colFailures')}</th>
                <th>{t('fleetV8.colCrashes')}</th>
                <th>{t('fleetV8.colLastError')}</th>
              </tr>
            </thead>
            <tbody>
              {snapshot.problemBots.map((bot) => (
                <tr key={bot.botId}>
                  <td>{bot.botId}</td>
                  <td>{bot.unhealthy ? t('fleetV8.statusUnhealthy') : bot.status}</td>
                  <td>{bot.consecutiveFailures}</td>
                  <td>{bot.recentCrashes}</td>
                  <td>{bot.lastError ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section>
        <h4>{t('fleetV8.campaignsTitle', { count: snapshot.activeCampaigns.length })}</h4>
        {snapshot.activeCampaigns.length === 0 ? (
          <p>{t('fleetV8.noActiveCampaigns')}</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>{t('fleetV8.colCampaign')}</th>
                <th>{t('fleetV8.colStatus')}</th>
                <th>{t('fleetV8.colProgress')}</th>
                <th>{t('fleetV8.colSuccess')}</th>
              </tr>
            </thead>
            <tbody>
              {snapshot.activeCampaigns.map((campaign) => (
                <tr key={campaign.id}>
                  <td>{campaign.goal}</td>
                  <td>{campaign.status}</td>
                  <td>
                    {campaign.done}/{campaign.totalBots} ({campaign.progressPercent}%)
                  </td>
                  <td>{campaign.successRate === null ? '—' : `${Math.round(campaign.successRate * 100)}%`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section>
        <h4>{t('fleetV8.incidentsTitle', { count: snapshot.recentIncidents.length })}</h4>
        {snapshot.recentIncidents.length === 0 ? (
          <p>{t('fleetV8.noIncidents')}</p>
        ) : (
          <ul>
            {snapshot.recentIncidents.map((incident) => (
              <li key={incident.id}>
                [{formatTime(incident.atMs)}] {incident.kind} — {incident.nodeId}: {incident.message}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

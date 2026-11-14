import { useCallback, useEffect, useState } from 'react';
import type { FleetOverviewView } from '../types';
import { useT } from '../i18n/useT';

/**
 * Fleet overview tab (v1.03) — the fleet-wide picture inside the
 * console: workspace counts by state, allocated vs actually used
 * CPU/RAM/disk, top consumers, quota alerts, and the capacity
 * forecast (linear projection — labelled as an estimate, with the
 * reason shown when the data cannot support one).
 *
 * Data flows over IPC `fleet:overview` (see main.ts): a pure
 * projection of fleet status + quotas + usage samples. Nothing here
 * writes anything.
 */

async function callOpenBot<T>(channel: string, camel: string, ...args: unknown[]): Promise<T | null> {
  const api = window.openBot as unknown as Record<string, unknown>;
  const fn = api[channel] ?? api[camel];
  if (typeof fn !== 'function') return null;
  return (fn as (...a: unknown[]) => Promise<T>).apply(window.openBot, args);
}

function formatBytes(bytes: number): string {
  const gb = bytes / 1024 ** 3;
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  const mb = bytes / 1024 ** 2;
  if (mb >= 1) return `${mb.toFixed(0)} MB`;
  return `${Math.round(bytes / 1024)} KB`;
}

function forecastReasonLabel(
  t: (key: string, vars?: Record<string, string | number>) => string,
  reason?: string,
): string {
  if (reason === 'not-enough-samples') return t('fleetOverview.forecastNotEnoughSamples');
  if (reason === 'not-enough-timespan') return t('fleetOverview.forecastNotEnoughTimespan');
  if (reason === 'not-growing') return t('fleetOverview.forecastNotGrowing');
  if (reason === 'already-full') return t('fleetOverview.forecastAlreadyFull');
  return t('fleetOverview.forecastUnknown');
}

export default function FleetOverviewTab() {
  const t = useT();
  const [overview, setOverview] = useState<FleetOverviewView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await callOpenBot<FleetOverviewView>('fleet:overview', 'getFleetOverview');
      if (!data) {
        setError(t('fleetOverview.loadError'));
        return;
      }
      setOverview(data);
    } catch (err) {
      setError((err as Error).message || t('fleetOverview.loadError'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) return <p>{t('marketplace.loading')}</p>;
  if (error || !overview) return <p style={{ color: '#c00' }}>{error ?? t('fleetOverview.loadError')}</p>;

  const ramPct = overview.ram.usedPercent === null ? null : Math.round(overview.ram.usedPercent * 100);
  const diskPct = overview.disk.usedPercent === null ? null : Math.round(overview.disk.usedPercent * 100);

  return (
    <div>
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
        <h3 style={{ margin: 0 }}>{t('fleetOverview.title')}</h3>
        <button className="btn secondary" onClick={() => void load()}>
          {t('fleet.refresh')}
        </button>
      </div>
      <p style={{ color: '#666' }}>
        {t('fleetOverview.workspaces', { count: overview.workspaces })} ·{' '}
        {t('fleetOverview.running', { count: overview.byServiceState.running ?? 0 })} ·{' '}
        {t('fleetOverview.alerts', { warning: overview.alerts.warning, breach: overview.alerts.breach })}
      </p>

      <div style={{ border: '1px solid #ddd', borderRadius: 8, padding: 12, marginBottom: 10 }}>
        <strong>{t('fleetOverview.resources')}</strong>
        <div style={{ marginTop: 6 }}>
          {t('fleet.ram')}:{' '}
          {overview.ram.used === null
            ? t('fleetConsole.unmeasured')
            : t('fleetConsole.usedOf', { used: formatBytes(overview.ram.used), limit: formatBytes(overview.ram.allocated) })}
          {ramPct !== null ? ` (${ramPct}%)` : ''}
        </div>
        <div style={{ marginTop: 4 }}>
          {t('fleet.disk')}:{' '}
          {overview.disk.used === null
            ? t('fleetConsole.unmeasured')
            : t('fleetConsole.usedOf', { used: formatBytes(overview.disk.used), limit: formatBytes(overview.disk.allocated) })}
          {diskPct !== null ? ` (${diskPct}%)` : ''}
        </div>
        <div style={{ marginTop: 4 }}>
          {t('fleet.cpu')}:{' '}
          {overview.cpu.used === null
            ? t('fleetConsole.unmeasured')
            : t('fleetOverview.cpuSeconds', { seconds: Math.round(overview.cpu.used) })}
          {' · '}
          {t('fleetOverview.allocatedCpu', { cores: overview.cpu.allocated })}
        </div>
        <div style={{ marginTop: 4, color: '#666', fontSize: 13 }}>
          {t('fleetOverview.quotas', { total: overview.quotas.total, enabled: overview.quotas.enabled })}
        </div>
      </div>

      {overview.topRam.length > 0 && (
        <div style={{ border: '1px solid #ddd', borderRadius: 8, padding: 12, marginBottom: 10 }}>
          <strong>{t('fleetOverview.topRam')}</strong>
          {overview.topRam.map((row) => (
            <div key={row.workspaceId} style={{ fontSize: 14, marginTop: 4 }}>
              {row.name} — {formatBytes(row.used)} ({Math.round(row.share * 100)}%)
            </div>
          ))}
        </div>
      )}
      {overview.topDisk.length > 0 && (
        <div style={{ border: '1px solid #ddd', borderRadius: 8, padding: 12, marginBottom: 10 }}>
          <strong>{t('fleetOverview.topDisk')}</strong>
          {overview.topDisk.map((row) => (
            <div key={row.workspaceId} style={{ fontSize: 14, marginTop: 4 }}>
              {row.name} — {formatBytes(row.used)} ({Math.round(row.share * 100)}%)
            </div>
          ))}
        </div>
      )}

      <div style={{ border: '1px solid #ddd', borderRadius: 8, padding: 12 }}>
        <strong>{t('fleetOverview.forecast')}</strong>
        <p style={{ color: '#666', fontSize: 13, margin: '4px 0' }}>{t('fleetOverview.forecastNote')}</p>
        {overview.forecasts.map((f) => (
          <div key={f.resource} style={{ fontSize: 14, marginTop: 4 }}>
            {f.resource === 'ram' ? t('fleet.ram') : t('fleet.disk')}:{' '}
            {f.daysUntilFull === null
              ? forecastReasonLabel(t, f.reason)
              : t('fleetOverview.forecastDays', { days: f.daysUntilFull })}
          </div>
        ))}
      </div>
    </div>
  );
}

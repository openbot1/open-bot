import { useMemo, useState } from 'react';
import { useT } from '../i18n/useT';

/**
 * Fleet v27 quota panel (v1.40, Team T6) — fleet quota v2: limits,
 * live usage, per-resource alerts (warn at 80%, critical at 95%),
 * the waiting queue, and the exhaustion policy. Progressive
 * disclosure: the top shows the worst alert level + one summary line;
 * usage, alerts, queue, and policy expand on demand.
 *
 * Data comes via props (host builds the view-model from core
 * `buildFleetV27QuotaPanel` via IPC); when there is no host wiring
 * yet it uses an internal demo store — the component never guesses
 * real numbers; the demo is clearly labelled in code.
 */

export interface FleetV27QuotaAlertRow {
  resource: string;
  ratio: number | null;
  level: 'ok' | 'warn' | 'critical';
  message: string;
}

export interface FleetV27QuotaPanelView {
  summary: string;
  limits: {
    cpuCores: number;
    ramMB: number;
    diskMB: number | null;
    maxConcurrentBots: number;
    maxCampaigns: number;
    maxRunsPerDay: number;
    maxBotsTotal: number;
  };
  usage: {
    cpuCores: number;
    ramMB: number;
    diskMB: number;
    runningBots: number;
    activeCampaigns: number;
    runsToday: number;
    totalBots: number;
  };
  alerts: FleetV27QuotaAlertRow[];
  worstLevel: 'ok' | 'warn' | 'critical';
  queue: Array<{ id: string; kind: string; position: number; expiresAtMs: number }>;
  recentDecisions: Array<{ atMs: number; kind: string; decision: string; reasons: string[] }>;
}

export function demoFleetV27QuotaPanel(): FleetV27QuotaPanelView {
  return {
    summary: 'Demo fleet v27 quota panel (no host wiring yet).',
    limits: { cpuCores: 4, ramMB: 8192, diskMB: 51200, maxConcurrentBots: 8, maxCampaigns: 4, maxRunsPerDay: 50, maxBotsTotal: 50 },
    usage: { cpuCores: 2, ramMB: 4096, diskMB: 10240, runningBots: 3, activeCampaigns: 1, runsToday: 5, totalBots: 6 },
    alerts: [
      { resource: 'cpu', ratio: 0.5, level: 'ok', message: 'cpu: 2 cores of 4 cores (50%) — ok.' },
      { resource: 'ram', ratio: 0.5, level: 'ok', message: 'ram: 4096 MiB of 8192 MiB (50%) — ok.' },
      { resource: 'disk', ratio: 0.2, level: 'ok', message: 'disk: 10240 MiB of 51200 MiB (20%) — ok.' },
    ],
    worstLevel: 'ok',
    queue: [],
    recentDecisions: [
      { atMs: Date.now(), kind: 'bot-start', decision: 'admit', reasons: ['ok'] },
    ],
  };
}

type QuotaTab = 'usage' | 'alerts' | 'queue' | 'policy';

export default function FleetV27QuotaPanel({ panel }: { panel?: FleetV27QuotaPanelView }) {
  const t = useT();
  const view = useMemo(() => panel ?? demoFleetV27QuotaPanel(), [panel]);
  const [tab, setTab] = useState<QuotaTab>('usage');

  const usageRows: Array<{ label: string; used: string; limit: string; ratio: number | null }> = [
    { label: t('fleet.v27.cpu'), used: `${view.usage.cpuCores}`, limit: `${view.limits.cpuCores}`, ratio: view.limits.cpuCores > 0 ? view.usage.cpuCores / view.limits.cpuCores : null },
    { label: t('fleet.v27.ram'), used: `${view.usage.ramMB} MiB`, limit: `${view.limits.ramMB} MiB`, ratio: view.limits.ramMB > 0 ? view.usage.ramMB / view.limits.ramMB : null },
    { label: t('fleet.v27.disk'), used: `${view.usage.diskMB} MiB`, limit: view.limits.diskMB === null ? t('fleet.v27.diskUnknown') : `${view.limits.diskMB} MiB`, ratio: view.limits.diskMB === null ? null : view.usage.diskMB / view.limits.diskMB },
    { label: t('fleet.v27.concurrentBots'), used: `${view.usage.runningBots}`, limit: `${view.limits.maxConcurrentBots}`, ratio: view.usage.runningBots / view.limits.maxConcurrentBots },
    { label: t('fleet.v27.campaigns'), used: `${view.usage.activeCampaigns}`, limit: `${view.limits.maxCampaigns}`, ratio: view.usage.activeCampaigns / view.limits.maxCampaigns },
    { label: t('fleet.v27.runsToday'), used: `${view.usage.runsToday}`, limit: `${view.limits.maxRunsPerDay}`, ratio: view.usage.runsToday / view.limits.maxRunsPerDay },
    { label: t('fleet.v27.totalBots'), used: `${view.usage.totalBots}`, limit: `${view.limits.maxBotsTotal}`, ratio: view.usage.totalBots / view.limits.maxBotsTotal },
  ];

  return (
    <section aria-label={t('fleet.v27.quotaTitle')} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <header style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
        <h2 style={{ margin: 0 }}>{t('fleet.v27.quotaTitle')}</h2>
        <span style={{ fontSize: 12, opacity: 0.7 }}>{view.summary}</span>
        <span style={{ marginLeft: 'auto', fontSize: 12 }}>
          {t('fleet.v27.worstLevel')}: {t(`fleet.v27.level.${view.worstLevel}`)}
        </span>
      </header>

      <nav aria-label={t('fleet.v27.sections')} style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
        {(['usage', 'alerts', 'queue', 'policy'] as QuotaTab[]).map((key) => (
          <button
            key={key}
            type="button"
            aria-pressed={tab === key}
            onClick={() => setTab(key)}
            style={{
              padding: '4px 10px', borderRadius: 999, border: '1px solid var(--border, #ccc)',
              background: tab === key ? 'var(--hatch-widget-accent, #2f6feb)' : 'transparent',
              color: tab === key ? 'var(--hatch-widget-on-accent, #fff)' : 'inherit',
              cursor: 'pointer',
            }}
          >
            {t(`fleet.v27.tab.${key}`)}
          </button>
        ))}
      </nav>

      {tab === 'usage' ? (
        <dl style={{ margin: 0, display: 'grid', gridTemplateColumns: 'auto 1fr auto', gap: '2px 12px', fontSize: 13 }}>
          {usageRows.map((row) => (
            <div key={row.label} style={{ display: 'contents' }}>
              <dt>{row.label}</dt>
              <dd style={{ margin: 0 }}>{row.used} / {row.limit}</dd>
              <dd style={{ margin: 0, textAlign: 'right' }}>{row.ratio === null ? '—' : `${Math.round(row.ratio * 100)}%`}</dd>
            </div>
          ))}
        </dl>
      ) : null}

      {tab === 'alerts' ? (
        <ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 6 }}>
          {view.alerts.map((a) => (
            <li key={a.resource} style={{ border: '1px solid var(--border, #ddd)', borderRadius: 8, padding: '8px 10px', fontSize: 13 }}>
              <strong>{a.resource}</strong> — {t(`fleet.v27.level.${a.level}`)}
              <span style={{ display: 'block', opacity: 0.85 }}>{a.message}</span>
            </li>
          ))}
        </ul>
      ) : null}

      {tab === 'queue' ? (
        view.queue.length === 0 ? (
          <p style={{ margin: 0, fontSize: 13, opacity: 0.8 }}>{t('fleet.v27.queueEmpty')}</p>
        ) : (
          <ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 6 }}>
            {view.queue.map((q) => (
              <li key={q.id} style={{ border: '1px solid var(--border, #ddd)', borderRadius: 8, padding: '8px 10px', fontSize: 13 }}>
                <strong>{q.id}</strong> — {q.kind} · {t('fleet.v27.queuePosition', { position: q.position })}
                <span style={{ display: 'block', opacity: 0.85 }}>
                  {t('fleet.v27.expiresAt')}: {new Date(q.expiresAtMs).toLocaleString()}
                </span>
              </li>
            ))}
          </ul>
        )
      ) : null}

      {tab === 'policy' ? (
        view.recentDecisions.length === 0 ? (
          <p style={{ margin: 0, fontSize: 13, opacity: 0.8 }}>{t('fleet.v27.noDecisions')}</p>
        ) : (
          <ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 6 }}>
            {view.recentDecisions.map((d, i) => (
              <li key={`${d.atMs}-${i}`} style={{ border: '1px solid var(--border, #ddd)', borderRadius: 8, padding: '8px 10px', fontSize: 13 }}>
                <strong>{d.kind}</strong> — {t(`fleet.v27.decision.${d.decision}`)}
                <span style={{ display: 'block', opacity: 0.85 }}>
                  {new Date(d.atMs).toLocaleString()} · {d.reasons.join(', ')}
                </span>
              </li>
            ))}
          </ul>
        )
      ) : null}
    </section>
  );
}

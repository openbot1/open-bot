import { useT } from '../i18n/useT';

/**
 * Fleet v29 dashboard panel (v1.42, Team T6).
 *
 * One-screen rollup for the A2A task board: fleet health (peers by
 * level, task counts, cost, pending confirmations), alerts that need
 * attention, and the board summary. Detail lives in the dedicated
 * panels (task board, peer registry, allowlist, audit) — this panel
 * only answers "is the fleet healthy right now, and what needs me".
 *
 * Data comes via props (host builds the view-model from core
 * `buildFleetV29HealthSummary` via IPC); with no host wiring yet it
 * uses an internal demo store — the component never guesses real
 * numbers, and the demo is clearly labelled in code.
 */

export interface A2aFleetV29DashboardView {
  summary: string;
  peersTotal: number;
  peersHealthy: number;
  peersDegraded: number;
  peersDown: number;
  peersUnknown: number;
  tasksActive: number;
  tasksCompleted: number;
  tasksFailed: number;
  tasksCancelled: number;
  tasksAwaitingInput: number;
  totalCostUsd: number;
  medianLatencyMs: number | null;
  pendingConfirmations: number;
  allowlistedUnverified: number;
  alerts: string[];
}

export function demoA2aFleetV29Dashboard(): A2aFleetV29DashboardView {
  return {
    summary: 'Demo fleet v29 dashboard (no host wiring yet).',
    peersTotal: 2,
    peersHealthy: 1,
    peersDegraded: 0,
    peersDown: 0,
    peersUnknown: 1,
    tasksActive: 2,
    tasksCompleted: 1,
    tasksFailed: 0,
    tasksCancelled: 0,
    tasksAwaitingInput: 1,
    totalCostUsd: 0.0656,
    medianLatencyMs: 812,
    pendingConfirmations: 1,
    allowlistedUnverified: 0,
    alerts: ['1 sensitive action(s) awaiting your confirmation.', '1 task(s) waiting for your input.'],
  };
}

export default function A2aFleetV29DashboardPanel({ dashboard }: { dashboard?: A2aFleetV29DashboardView }) {
  const t = useT();
  const view = dashboard ?? demoA2aFleetV29Dashboard();
  return (
    <section aria-label={t('fleet.v29.dashboardTitle')} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <h2 style={{ margin: 0 }}>{t('fleet.v29.dashboardTitle')}</h2>
      <p style={{ margin: 0, fontSize: 13, opacity: 0.8 }}>{view.summary}</p>
      <dl style={{ margin: 0, fontSize: 13, display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '2px 10px' }}>
        <dt>{t('fleet.v29.peers')}</dt>
        <dd style={{ margin: 0 }}>
          {view.peersTotal} ({t('fleet.v29.health.healthy')}: {view.peersHealthy} · {t('fleet.v29.health.degraded')}: {view.peersDegraded} ·{' '}
          {t('fleet.v29.health.down')}: {view.peersDown} · {t('fleet.v29.health.unknown')}: {view.peersUnknown})
        </dd>
        <dt>{t('fleet.v29.tasks')}</dt>
        <dd style={{ margin: 0 }}>
          {t('fleet.v29.activeTasks')}: {view.tasksActive} · {t('fleet.v29.completed')}: {view.tasksCompleted} ·{' '}
          {t('fleet.v29.failed')}: {view.tasksFailed} · {t('fleet.v29.cancelled')}: {view.tasksCancelled} ·{' '}
          {t('fleet.v29.awaitingInput')}: {view.tasksAwaitingInput}
        </dd>
        <dt>{t('fleet.v29.totalCost')}</dt><dd style={{ margin: 0 }}>${view.totalCostUsd.toFixed(4)}</dd>
        <dt>{t('fleet.v29.medianLatency')}</dt><dd style={{ margin: 0 }}>{view.medianLatencyMs === null ? '—' : `${view.medianLatencyMs} ms`}</dd>
        <dt>{t('fleet.v29.pendingConfirmations')}</dt><dd style={{ margin: 0 }}>{view.pendingConfirmations}</dd>
        <dt>{t('fleet.v29.allowlistedUnverified')}</dt><dd style={{ margin: 0 }}>{view.allowlistedUnverified}</dd>
      </dl>
      <h3 style={{ margin: '4px 0 0', fontSize: 14 }}>{t('fleet.v29.alerts')}</h3>
      {view.alerts.length === 0 ? (
        <p style={{ margin: 0, fontSize: 13, opacity: 0.8 }}>{t('fleet.v29.noAlerts')}</p>
      ) : (
        <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13 }}>
          {view.alerts.map((alert) => (
            <li key={alert}>{alert}</li>
          ))}
        </ul>
      )}
    </section>
  );
}

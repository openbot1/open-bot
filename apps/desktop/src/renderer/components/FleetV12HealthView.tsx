import { useMemo, useState } from 'react';
import { useT } from '../i18n/useT';

/**
 * Fleet health v12 view (v1.15, Team T6) — extended health dashboard:
 * per-node CPU/RAM/disk/model, alert rules, short-term history, pinned
 * models and percentage rollout.
 *
 * Continues FleetV11HealthView (fixed-threshold alerts): v12 adds the
 * local model loaded on each node (verified/drift/unverified),
 * configurable alert rules, short-term history (CPU/RAM trend) and the
 * list of pinned models + rollouts. Data comes via props (host builds it
 * from core `buildFleetV12HealthDashboard` + pin manifest + rollouts
 * via IPC); when there is no host wiring yet it uses an internal demo
 * store — the component never guesses real numbers; the demo is
 * clearly labelled in code.
 */

export type FleetV12HealthStatus = 'healthy' | 'degraded' | 'unhealthy' | 'down';
export type FleetV12ModelStatus = 'verified' | 'drift' | 'unverified' | 'none';
export type FleetV12Trend = 'rising' | 'falling' | 'stable' | 'unknown';

export interface FleetV12NodeRow {
  id: string;
  name: string;
  status: FleetV12HealthStatus;
  cpuPct: number | null;
  ramPct: number | null;
  diskPct: number | null;
  loadedModelId: string;
  modelStatus: FleetV12ModelStatus;
  tokensPerSec: number | null;
  pendingRequests: number;
  worstReason: string;
  cpuTrend: FleetV12Trend;
  ramTrend: FleetV12Trend;
}

export interface FleetV12AlertRow {
  id: string;
  ruleName: string;
  nodeId: string;
  level: 'info' | 'warning' | 'critical';
  message: string;
  acknowledged: boolean;
}

export interface FleetV12PinRow {
  nodeId: string;
  modelId: string;
  verifiedSha256: string | null;
  status: 'pinned' | 'drift' | 'unpinned';
  driftReason: string;
}

export interface FleetV12RolloutRow {
  id: string;
  name: string;
  feature: string;
  version: string;
  stage: 'draft' | 'canary' | 'expanding' | 'paused' | 'complete' | 'rolled-back';
  activePercentage: number | null;
  fraction: number;
}

export interface FleetV12HealthDashboardView {
  summary: string;
  nodes: FleetV12NodeRow[];
  alerts: FleetV12AlertRow[];
  pins: FleetV12PinRow[];
  rollouts: FleetV12RolloutRow[];
}

const T0 = Date.UTC(2026, 10, 16, 0, 0, 0);

export function demoFleetV12HealthDashboard(): FleetV12HealthDashboardView {
  return {
    summary: 'Demo: 3 nodes — 1 healthy, 1 degraded (model drift), 1 down; 2 alerts open.',
    nodes: [
      {
        id: 'node-local', name: 'Local machine', status: 'healthy',
        cpuPct: 42, ramPct: 61, diskPct: 55, loadedModelId: 'qwen3-4b-q4_k_m',
        modelStatus: 'verified', tokensPerSec: 38, pendingRequests: 0,
        worstReason: '', cpuTrend: 'stable', ramTrend: 'rising',
      },
      {
        id: 'node-lan-1', name: 'LAN machine 1', status: 'degraded',
        cpuPct: 71, ramPct: 86, diskPct: 62, loadedModelId: 'llama-3.2-3b-q4_k_m',
        modelStatus: 'drift', tokensPerSec: 12, pendingRequests: 3,
        worstReason: 'model llama-3.2-3b-q4_k_m changed vs the pinned copy',
        cpuTrend: 'rising', ramTrend: 'rising',
      },
      {
        id: 'node-lan-2', name: 'LAN machine 2', status: 'down',
        cpuPct: null, ramPct: null, diskPct: null, loadedModelId: '',
        modelStatus: 'none', tokensPerSec: null, pendingRequests: 0,
        worstReason: 'no heartbeat for over 5 minutes', cpuTrend: 'unknown', ramTrend: 'unknown',
      },
    ],
    alerts: [
      {
        id: 'al-cpu-lan1', ruleName: 'CPU cao', nodeId: 'node-lan-1',
        level: 'warning', message: 'High CPU on node node-lan-1: 71 > 80? (demo)',
        acknowledged: false,
      },
      {
        id: 'al-drift-lan1', ruleName: 'Model changed', nodeId: 'node-lan-1',
        level: 'critical', message: 'Model changed on node node-lan-1',
        acknowledged: false,
      },
    ],
    pins: [
      { nodeId: 'node-local', modelId: 'qwen3-4b-q4_k_m', verifiedSha256: 'a'.repeat(64), status: 'pinned', driftReason: '' },
      { nodeId: 'node-lan-1', modelId: 'llama-3.2-3b-q4_k_m', verifiedSha256: null, status: 'drift', driftReason: 'hash differs from the pinned copy' },
    ],
    rollouts: [
      {
        id: 'ro12-model-qwen3', name: 'Model qwen3-4b', feature: 'local-model-qwen3-4b',
        version: '2.4.0', stage: 'expanding', activePercentage: 25, fraction: 0.25,
      },
    ],
  };
}

function formatPct(v: number | null): string {
  return v === null ? '—' : `${Math.round(v)}%`;
}

export default function FleetV12HealthView({
  dashboard: dashboardProp,
}: {
  dashboard?: FleetV12HealthDashboardView | null;
}) {
  const t = useT();
  const [dashboard, setDashboard] = useState<FleetV12HealthDashboardView>(
    () => dashboardProp ?? demoFleetV12HealthDashboard(),
  );
  const [showPins, setShowPins] = useState(true);
  const [showRollouts, setShowRollouts] = useState(true);

  const counts = useMemo(() => {
    const c = { healthy: 0, degraded: 0, unhealthy: 0, down: 0 };
    for (const n of dashboard.nodes) c[n.status] += 1;
    return c;
  }, [dashboard]);

  const statusLabel = (status: FleetV12HealthStatus): string => {
    if (status === 'healthy') return t('fleetV12.statusHealthy');
    if (status === 'degraded') return t('fleetV12.statusDegraded');
    if (status === 'unhealthy') return t('fleetV12.statusUnhealthy');
    return t('fleetV12.statusDown');
  };

  const modelLabel = (status: FleetV12ModelStatus): string => {
    if (status === 'verified') return t('fleetV12.modelVerified');
    if (status === 'drift') return t('fleetV12.modelDrift');
    if (status === 'unverified') return t('fleetV12.modelUnverified');
    return t('fleetV12.modelNone');
  };

  const trendLabel = (trend: FleetV12Trend): string => {
    if (trend === 'rising') return t('fleetV12.trendRising');
    if (trend === 'falling') return t('fleetV12.trendFalling');
    if (trend === 'stable') return t('fleetV12.trendStable');
    return t('fleetV12.trendUnknown');
  };

  const stageLabel = (stage: FleetV12RolloutRow['stage']): string => {
    if (stage === 'draft') return t('fleetV12.stageDraft');
    if (stage === 'canary') return t('fleetV12.stageCanary');
    if (stage === 'expanding') return t('fleetV12.stageExpanding');
    if (stage === 'paused') return t('fleetV12.stagePaused');
    if (stage === 'complete') return t('fleetV12.stageComplete');
    return t('fleetV12.stageRolledBack');
  };

  const refresh = () => {
    // Demo store: reload the demo dashboard (the real host calls IPC then setDashboard).
    setDashboard(demoFleetV12HealthDashboard());
  };

  const acknowledge = (id: string) => {
    setDashboard((prev) => ({
      ...prev,
      alerts: prev.alerts.map((a) => (a.id === id ? { ...a, acknowledged: true } : a)),
    }));
  };

  const openAlerts = dashboard.alerts.filter((a) => !a.acknowledged);
  const driftNodes = dashboard.nodes.filter((n) => n.modelStatus === 'drift').length;
  const downNodes = dashboard.nodes.filter((n) => n.status === 'down').length;

  return (
    <div>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h3>{t('fleetV12.title')}</h3>
        <button type="button" onClick={refresh}>{t('fleetV12.refresh')}</button>
      </div>
      <p>{t('fleetV12.subtitle')}</p>
      <p>{dashboard.summary}</p>
      <p>
        {counts.healthy} {t('fleetV12.statusHealthy')} · {counts.degraded} {t('fleetV12.statusDegraded')} ·{' '}
        {counts.unhealthy} {t('fleetV12.statusUnhealthy')} · {counts.down} {t('fleetV12.statusDown')} ·{' '}
        {driftNodes} {t('fleetV12.driftNodes')} · {downNodes} {t('fleetV12.downNodes')}
      </p>

      <h4>{t('fleetV12.nodesTitle')}</h4>
      {dashboard.nodes.length === 0 ? (
        <p>{t('fleetV12.loadError')}</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Node</th>
              <th>{t('fleetV12.statusHealthy')}</th>
              <th>{t('fleetV12.cpu')}</th>
              <th>{t('fleetV12.ram')}</th>
              <th>{t('fleetV12.disk')}</th>
              <th>{t('fleetV12.model')}</th>
              <th>{t('fleetV12.modelStatus')}</th>
              <th>{t('fleetV12.tokensPerSec')}</th>
              <th>{t('fleetV12.pendingRequests')}</th>
            </tr>
          </thead>
          <tbody>
            {dashboard.nodes.map((n) => (
              <tr key={n.id}>
                <td>{n.name}</td>
                <td>{statusLabel(n.status)}{n.worstReason ? ` — ${n.worstReason}` : ''}</td>
                <td>{formatPct(n.cpuPct)} ({trendLabel(n.cpuTrend)})</td>
                <td>{formatPct(n.ramPct)} ({trendLabel(n.ramTrend)})</td>
                <td>{formatPct(n.diskPct)}</td>
                <td>{n.loadedModelId || '—'}</td>
                <td>{modelLabel(n.modelStatus)}</td>
                <td>{n.tokensPerSec === null ? '—' : `${n.tokensPerSec} tok/s`}</td>
                <td>{n.pendingRequests}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h4>{t('fleetV12.alertsTitle')}</h4>
      {openAlerts.length === 0 ? (
        <p>{t('fleetV12.noAlerts')}</p>
      ) : (
        <ul>
          {openAlerts.map((a) => (
            <li key={a.id}>
              [{a.level}] {a.ruleName} — {a.message}{' '}
              <button type="button" onClick={() => acknowledge(a.id)}>{t('fleetV12.acknowledge')}</button>
            </li>
          ))}
        </ul>
      )}

      <h4>
        {t('fleetV12.pinsTitle')}{' '}
        <button type="button" onClick={() => setShowPins((v) => !v)}>
          {showPins ? t('fleetV12.hidePanels') : t('fleetV12.showPanels')}
        </button>
      </h4>
      {showPins && (
        dashboard.pins.length === 0 ? (
          <p>{t('fleetV12.pinsEmpty')}</p>
        ) : (
          <ul>
            {dashboard.pins.map((p) => (
              <li key={p.nodeId}>
                {t('fleetV12.pinNode')}: {p.nodeId} — {t('fleetV12.pinModel')}: {p.modelId} —{' '}
                {p.status === 'drift' ? t('fleetV12.modelDrift') : p.verifiedSha256 ? t('fleetV12.modelVerified') : t('fleetV12.modelUnverified')}
                {p.driftReason ? ` — ${p.driftReason}` : ''}
              </li>
            ))}
          </ul>
        )
      )}

      <h4>
        {t('fleetV12.rolloutTitle')}{' '}
        <button type="button" onClick={() => setShowRollouts((v) => !v)}>
          {showRollouts ? t('fleetV12.hidePanels') : t('fleetV12.showPanels')}
        </button>
      </h4>
      {showRollouts && (
        dashboard.rollouts.length === 0 ? (
          <p>{t('fleetV12.rolloutEmpty')}</p>
        ) : (
          <ul>
            {dashboard.rollouts.map((r) => (
              <li key={r.id}>
                {r.name} ({r.feature} {r.version}) — {t('fleetV12.rolloutStage')}: {stageLabel(r.stage)}
                {r.activePercentage !== null ? ` — ${r.activePercentage}%` : ''} —{' '}
                {Math.round(r.fraction * 100)}%
              </li>
            ))}
          </ul>
        )
      )}
    </div>
  );
}

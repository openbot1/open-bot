import { useState } from 'react';
import { useT } from '../i18n/useT';

/**
 * Fleet v19 health panel (v1.29, Team T6) — fleet score, node health
 * history/trend, open alerts.
 *
 * Data comes via props (host builds the view-model from core
 * `buildFleetV19HealthPanel` via IPC); when there is no host wiring
 * yet it uses an internal demo store — the component never guesses
 * real numbers; the demo is clearly labelled in code.
 */

export interface FleetV19HealthPanelAlertView {
  id: string;
  level: string;
  nodeId: string;
  message: string;
  status: string;
  raisedAt: number;
  retriggerCount: number;
}

export interface FleetV19HealthPanelNodeView {
  nodeId: string;
  latestScore: number | null;
  latestHealth: string;
  avgScore: number | null;
  uptimePct: number | null;
  trend: string;
  levelChanges: number;
  flapping: boolean;
}

export interface FleetV19HealthPanelView {
  fleetScore: number;
  nodeCount: number;
  healthyPct: number;
  worstNodeId: string | null;
  worstScore: number | null;
  bestNodeId: string | null;
  bestScore: number | null;
  nodes: FleetV19HealthPanelNodeView[];
  degradingNodeIds: string[];
  flappingNodeIds: string[];
  openAlerts: FleetV19HealthPanelAlertView[];
  openAlertCount: number;
  criticalAlertCount: number;
  summary: string;
}

const T0 = Date.UTC(2026, 10, 17, 0, 0, 0);

export function demoFleetV19HealthPanel(): FleetV19HealthPanelView {
  return {
    fleetScore: 87.5,
    nodeCount: 3,
    healthyPct: 66.7,
    worstNodeId: 'node-c',
    worstScore: 61,
    bestNodeId: 'node-a',
    bestScore: 96,
    nodes: [
      {
        nodeId: 'node-a', latestScore: 96, latestHealth: 'healthy', avgScore: 94.2,
        uptimePct: 100, trend: 'stable', levelChanges: 0, flapping: false,
      },
      {
        nodeId: 'node-b', latestScore: 88, latestHealth: 'healthy', avgScore: 91.5,
        uptimePct: 96.4, trend: 'improving', levelChanges: 1, flapping: false,
      },
      {
        nodeId: 'node-c', latestScore: 61, latestHealth: 'degraded', avgScore: 68.3,
        uptimePct: 71.2, trend: 'degrading', levelChanges: 3, flapping: false,
      },
    ],
    degradingNodeIds: ['node-c'],
    flappingNodeIds: [],
    openAlerts: [
      {
        id: 'alert-1', level: 'warning', nodeId: 'node-c',
        message: 'Node node-c degrading (score 61 < 70)',
        status: 'open', raisedAt: T0, retriggerCount: 1,
      },
    ],
    openAlertCount: 1,
    criticalAlertCount: 0,
    summary: 'fleet score 87.5 (3 nodes, 66.7% healthy) · 1 node degrading · 1 open alert (0 critical)',
  };
}

function trendLabel(t: (key: string) => string, trend: string): string {
  switch (trend) {
    case 'improving':
      return t('fleetV19.improving');
    case 'degrading':
      return t('fleetV19.degrading');
    case 'volatile':
      return t('fleetV19.volatile');
    case 'unknown':
      return t('fleetV19.unknown');
    default:
      return t('fleetV19.stable');
  }
}

export interface FleetV19HealthPanelProps {
  view?: FleetV19HealthPanelView;
  onBack?: () => void;
  onAckAlert?: (alertId: string) => void;
  onResolveAlert?: (alertId: string) => void;
}

export default function FleetV19HealthPanel(props: FleetV19HealthPanelProps) {
  const t = useT();
  const [view] = useState<FleetV19HealthPanelView>(() => props.view ?? demoFleetV19HealthPanel());
  const [filter, setFilter] = useState<'all' | 'attention'>('all');
  const shownNodes =
    filter === 'attention'
      ? view.nodes.filter((n) => n.trend === 'degrading' || n.flapping)
      : view.nodes;

  return (
    <div className="panel fleet-v19-health-panel">
      <div className="panel-header">
        {props.onBack ? (
          <button type="button" className="btn-ghost" onClick={props.onBack}>
            ← {t('fleetV19.back')}
          </button>
        ) : null}
        <h2>{t('fleetV19.healthPanel')}</h2>
      </div>

      <p className="panel-summary">{view.summary}</p>

      <div className="fleet-v19-score-cards">
        <div className="score-card">
          <span className="score-label">{t('fleetV19.fleetScore')}</span>
          <strong className="score-value">{view.fleetScore}</strong>
        </div>
        <div className="score-card">
          <span className="score-label">{t('fleetV19.nodeHealth')}</span>
          <strong className="score-value">{view.healthyPct}%</strong>
          <span className="score-sub">
            {view.nodeCount} node · {t('fleetV19.worstNode')}: {view.worstNodeId ?? '—'} ({view.worstScore ?? '—'})
          </span>
        </div>
        <div className="score-card">
          <span className="score-label">{t('fleetV19.openAlerts')}</span>
          <strong className="score-value">{view.openAlertCount}</strong>
          <span className="score-sub">
            {view.criticalAlertCount} {t('fleetV19.criticalAlerts')}
          </span>
        </div>
      </div>

      <div className="fleet-v19-filter">
        <button
          type="button"
          className={filter === 'all' ? 'btn-active' : 'btn-ghost'}
          onClick={() => setFilter('all')}
        >
          {t('fleetV19.allNodes')}
        </button>
        <button
          type="button"
          className={filter === 'attention' ? 'btn-active' : 'btn-ghost'}
          onClick={() => setFilter('attention')}
        >
          {t('fleetV19.attentionNodes')} ({view.degradingNodeIds.length + view.flappingNodeIds.length})
        </button>
      </div>

      <table className="table">
        <thead>
          <tr>
            <th>Node</th>
            <th>{t('fleetV19.healthScore')}</th>
            <th>{t('fleetV19.avgScore')}</th>
            <th>{t('fleetV19.uptime')}</th>
            <th>{t('fleetV19.trend')}</th>
            <th>{t('fleetV19.levelChanges')}</th>
            <th>{t('fleetV19.flapping')}</th>
          </tr>
        </thead>
        <tbody>
          {shownNodes.map((n) => (
            <tr key={n.nodeId} className={n.trend === 'degrading' || n.flapping ? 'row-attention' : ''}>
              <td>{n.nodeId}</td>
              <td>
                {n.latestScore ?? '—'} ({n.latestHealth})
              </td>
              <td>{n.avgScore ?? '—'}</td>
              <td>{n.uptimePct === null ? '—' : `${n.uptimePct}%`}</td>
              <td>{trendLabel(t, n.trend)}</td>
              <td>{n.levelChanges}</td>
              <td>{n.flapping ? t('fleetV19.yes') : t('fleetV19.no')}</td>
            </tr>
          ))}
          {shownNodes.length === 0 ? (
            <tr>
              <td colSpan={7}>{t('fleetV19.noAttentionNodes')}</td>
            </tr>
          ) : null}
        </tbody>
      </table>

      <h3>
        {t('fleetV19.openAlerts')} ({view.openAlertCount})
      </h3>
      {view.openAlerts.length === 0 ? (
        <p>{t('fleetV19.noOpenAlerts')}</p>
      ) : (
        <ul className="alert-list">
          {view.openAlerts.map((a) => (
            <li key={a.id} className={`alert-item alert-${a.level}`}>
              <strong>[{a.level}]</strong> {a.message}
              {a.retriggerCount > 0 ? <span> (x{a.retriggerCount + 1})</span> : null}
              <span className="alert-meta">
                {' '}
                · {a.status} · {new Date(a.raisedAt).toLocaleString()}
              </span>
              {a.status === 'open' && props.onAckAlert ? (
                <button type="button" className="btn-ghost" onClick={() => props.onAckAlert?.(a.id)}>
                  {t('fleetV19.ackAlert')}
                </button>
              ) : null}
              {a.status !== 'resolved' && props.onResolveAlert ? (
                <button type="button" className="btn-ghost" onClick={() => props.onResolveAlert?.(a.id)}>
                  {t('fleetV19.resolveAlert')}
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

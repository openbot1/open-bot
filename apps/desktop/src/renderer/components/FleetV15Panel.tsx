import { useState } from 'react';
import { useT } from '../i18n/useT';

/**
 * Fleet v15 panel (v1.18, Team T6) — node table with health score /
 * grade / trend, capacity forecast, rebalance moves, users (quota
 * v4 + sessions), rollouts (approvals + nodes on new version).
 *
 * Data comes via props (host builds the view-model from core
 * `buildFleetV15Panel` via IPC); when there is no host wiring yet
 * it uses an internal demo store — the component never guesses real
 * numbers; the demo is clearly labelled in code.
 */

export interface FleetV15PanelNodeView {
  nodeId: string;
  hostname: string;
  status: string;
  healthScore: number;
  healthGrade: string;
  healthTrend: string;
  load: number;
  runningTasks: number;
  maxTasks: number;
}

export interface FleetV15PanelUserView {
  userId: string;
  roleRef: string;
  tightestQuota: string;
  tightestFraction: number;
  activeSessions: number;
  switchCount: number;
}

export interface FleetV15PanelRolloutView {
  id: string;
  feature: string;
  version: string;
  stage: string;
  stageLabel: string;
  percent: number;
  approvalsHave: number;
  approvalsNeed: number;
  targetedNodeCount: number;
  nodesOnNewVersion: number;
  autoAction: string;
}

export interface FleetV15PanelMoveView {
  taskId: string;
  fromNodeId: string;
  toNodeId: string;
  reason: string;
}

export interface FleetV15PanelView {
  nodes: FleetV15PanelNodeView[];
  nodeCount: number;
  activeNodeCount: number;
  overloadedNodeIds: string[];
  capacitySummary: string;
  forecastSummary: string;
  tightestResource: string;
  daysUntilFirstFull: number | null;
  rebalanceMoves: FleetV15PanelMoveView[];
  stillOverloaded: string[];
  users: FleetV15PanelUserView[];
  rollouts: FleetV15PanelRolloutView[];
  summary: string;
}

const T0 = Date.UTC(2026, 10, 16, 0, 0, 0);

export function demoFleetV15Panel(): FleetV15PanelView {
  return {
    nodes: [
      {
        nodeId: 'node-a', hostname: 'node-a.local', status: 'active', healthScore: 92,
        healthGrade: 'excellent', healthTrend: 'stable', load: 0.4, runningTasks: 2, maxTasks: 4,
      },
      {
        nodeId: 'node-b', hostname: 'node-b.local', status: 'active', healthScore: 48,
        healthGrade: 'poor', healthTrend: 'declining', load: 0.95, runningTasks: 4, maxTasks: 4,
      },
    ],
    nodeCount: 2,
    activeNodeCount: 2,
    overloadedNodeIds: ['node-b'],
    capacitySummary: 'Demo: fleet 2 nodes (2 active), 6 running tasks, CPU 8/16 cores, RAM 24000/65536 MB.',
    forecastSummary: 'Demo: RAM fills first in ~32 days (watch).',
    tightestResource: 'ram',
    daysUntilFirstFull: 32,
    rebalanceMoves: [
      { taskId: 'bot-support', fromNodeId: 'node-b', toNodeId: 'node-a', reason: 'move bot-support from overloaded node-b to node-a' },
    ],
    stillOverloaded: [],
    users: [
      { userId: 'u_member', roleRef: 'member', tightestQuota: 'ram-mb', tightestFraction: 0.6, activeSessions: 1, switchCount: 2 },
    ],
    rollouts: [
      { id: 'roll-voice-v17', feature: 'voice-v17', version: 'v17', stage: 'canary', stageLabel: 'canary (1% users)', percent: 1, approvalsHave: 1, approvalsNeed: 1, targetedNodeCount: 2, nodesOnNewVersion: 1, autoAction: 'none' },
    ],
    summary: 'Demo: fleet v15: 2 nodes (2 active, 1 overloaded), avg health 70/100, worst node-b 48/100 (poor).',
  };
}

export default function FleetV15Panel({
  panel: panelProp,
}: {
  panel?: FleetV15PanelView | null;
}) {
  const t = useT();
  const [panel] = useState<FleetV15PanelView>(() => panelProp ?? demoFleetV15Panel());

  return (
    <div>
      <h3>{t('fleetV15.fleetTitle')}</h3>
      <p>{panel.summary}</p>
      <p>{t('fleetV15.demo')}</p>
      <h4>{t('fleetV15.fleetNodes')} ({panel.nodes.length})</h4>
      {panel.nodes.length === 0 ? (
        <p>{t('fleetV15.fleetNoNodes')}</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Node</th>
              <th>{t('fleetV15.fleetStatus')}</th>
              <th>{t('fleetV15.healthScore')}</th>
              <th>{t('fleetV15.healthGrade')}</th>
              <th>{t('fleetV15.healthTrend')}</th>
              <th>{t('fleetV15.fleetLoad')}</th>
              <th>{t('fleetV15.fleetTasks')}</th>
            </tr>
          </thead>
          <tbody>
            {panel.nodes.map((n) => (
              <tr key={n.nodeId}>
                <td>{n.nodeId}{n.status === 'draining' ? ` (${n.status})` : ''}</td>
                <td>{n.status}</td>
                <td>{n.healthScore < 0 ? t('fleetV15.unknown') : `${n.healthScore}/100`}</td>
                <td>{n.healthGrade}</td>
                <td>{n.healthTrend}</td>
                <td>{Math.round(n.load * 100)}%</td>
                <td>{n.runningTasks}/{n.maxTasks}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p>{panel.capacitySummary}</p>

      <h4>{t('fleetV15.forecast')}</h4>
      <p>{panel.forecastSummary}</p>
      <p>
        {t('fleetV15.forecastTightest')}: {panel.tightestResource || '—'} — {t('fleetV15.forecastDays')}:{' '}
        {panel.daysUntilFirstFull === null ? '—' : panel.daysUntilFirstFull === Number.POSITIVE_INFINITY ? '∞' : `${panel.daysUntilFirstFull}`}
      </p>

      <h4>{t('fleetV15.rebalance')} ({panel.rebalanceMoves.length})</h4>
      {panel.rebalanceMoves.length === 0 ? (
        <p>{t('fleetV15.rebalanceNoMoves')}</p>
      ) : (
        <ul>
          {panel.rebalanceMoves.map((m) => (
            <li key={m.taskId}>
              {m.taskId}: {m.fromNodeId} → {m.toNodeId}
            </li>
          ))}
        </ul>
      )}
      {panel.stillOverloaded.length > 0 && (
        <p>{t('fleetV15.rebalanceStillOverloaded')}: {panel.stillOverloaded.join(', ')}</p>
      )}

      <h4>{t('fleetV15.users')} ({panel.users.length})</h4>
      {panel.users.length === 0 ? (
        <p>—</p>
      ) : (
        <ul>
          {panel.users.map((u) => (
            <li key={u.userId}>
              {u.userId} ({u.roleRef}) — {t('fleetV15.userQuota')}: {u.tightestQuota || '—'} {Math.round(u.tightestFraction * 100)}% — {t('fleetV15.userSessions')}: {u.activeSessions} — {t('fleetV15.userSwitches')}: {u.switchCount}
            </li>
          ))}
        </ul>
      )}

      <h4>{t('fleetV15.rollouts')} ({panel.rollouts.length})</h4>
      {panel.rollouts.length === 0 ? (
        <p>—</p>
      ) : (
        <ul>
          {panel.rollouts.map((r) => (
            <li key={r.id}>
              {r.feature} {r.version} — {r.stageLabel} — {t('fleetV15.rolloutApprovals')}: {r.approvalsHave}/{r.approvalsNeed} — {t('fleetV15.rolloutNodes')}: {r.nodesOnNewVersion}/{r.targetedNodeCount} — {t('fleetV15.rolloutAuto')}: {r.autoAction}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

import { useState } from 'react';
import { useT } from '../i18n/useT';

/**
 * Fleet v14 panel (v1.17, Team T6) — node table (registration,
 * health, load, drain), capacity, user quotas, rollouts, polling
 * triggers.
 *
 * Data comes via props (host builds the view-model from core
 * `buildFleetV14Panel` via IPC); when there is no host wiring yet
 * it uses an internal demo store — the component never guesses real
 * numbers; the demo is clearly labelled in code.
 */

export interface FleetV14PanelNodeView {
  nodeId: string;
  hostname: string;
  status: string;
  health: string;
  load: number;
  runningTasks: number;
  maxTasks: number;
  ramUsedFraction: number;
  vramUsedFraction: number;
  labels: string[];
}

export interface FleetV14PanelUserView {
  userId: string;
  role: string;
  tightestQuota: string;
  tightestFraction: number;
  activeGrants: number;
  deniedTargets: number;
  auditEventCount: number;
}

export interface FleetV14PanelRolloutView {
  id: string;
  feature: string;
  version: string;
  stage: string;
  stageLabel: string;
  percent: number;
  gatePass: boolean;
  autoAction: string;
}

export interface FleetV14PanelPollView {
  triggerId: string;
  toolkit: string;
  triggerSlug: string;
  status: string;
  currentIntervalMs: number;
  totalNewEvents: number;
  totalDuplicates: number;
  consecutiveErrors: number;
}

export interface FleetV14PanelView {
  nodes: FleetV14PanelNodeView[];
  nodeCount: number;
  activeNodeCount: number;
  overloadedNodeIds: string[];
  capacitySummary: string;
  users: FleetV14PanelUserView[];
  rollouts: FleetV14PanelRolloutView[];
  polls: FleetV14PanelPollView[];
  summary: string;
}

const T0 = Date.UTC(2026, 10, 16, 0, 0, 0);

export function demoFleetV14Panel(): FleetV14PanelView {
  return {
    nodes: [
      {
        nodeId: 'node-a', hostname: 'node-a.local', status: 'active', health: 'healthy',
        load: 0.4, runningTasks: 2, maxTasks: 4, ramUsedFraction: 0.4, vramUsedFraction: 0.2, labels: ['gpu=true'],
      },
      {
        nodeId: 'node-b', hostname: 'node-b.local', status: 'draining', health: 'degraded',
        load: 0.9, runningTasks: 1, maxTasks: 4, ramUsedFraction: 0.9, vramUsedFraction: 0.1, labels: [],
      },
    ],
    nodeCount: 2,
    activeNodeCount: 1,
    overloadedNodeIds: ['node-b'],
    capacitySummary: 'Demo: fleet 2 nodes (1 active), 3 running tasks, CPU 4/16 cores, RAM 12000/49152 MB.',
    users: [
      { userId: 'u_member', role: 'member', tightestQuota: 'tokens-per-day', tightestFraction: 0.9, activeGrants: 2, deniedTargets: 0, auditEventCount: 5 },
    ],
    rollouts: [
      { id: 'roll-voice-v16', feature: 'voice-v16', version: 'v16', stage: 'canary', stageLabel: 'canary (1% users)', percent: 1, gatePass: true, autoAction: 'none' },
    ],
    polls: [
      { triggerId: 'trig-gmail', toolkit: 'gmail', triggerSlug: 'new-email', status: 'idle', currentIntervalMs: 60000, totalNewEvents: 12, totalDuplicates: 3, consecutiveErrors: 0 },
    ],
    summary: 'Demo: fleet v14: 2 nodes (1 active, 1 overloaded), 1 user tracked, 1 rollout, 1 polling trigger.',
  };
}

export default function FleetV14Panel({
  panel: panelProp,
}: {
  panel?: FleetV14PanelView | null;
}) {
  const t = useT();
  const [panel] = useState<FleetV14PanelView>(() => panelProp ?? demoFleetV14Panel());

  return (
    <div>
      <h3>{t('fleetV14.fleetTitle')}</h3>
      <p>{panel.summary}</p>
      <p>{t('fleetV14.demo')}</p>
      <h4>{t('fleetV14.fleetNodes')} ({panel.nodes.length})</h4>
      {panel.nodes.length === 0 ? (
        <p>{t('fleetV14.fleetNoNodes')}</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Node</th>
              <th>{t('fleetV14.fleetStatus')}</th>
              <th>{t('fleetV14.fleetHealth')}</th>
              <th>{t('fleetV14.fleetLoad')}</th>
              <th>{t('fleetV14.fleetTasks')}</th>
              <th>{t('fleetV14.ram')}</th>
              <th>{t('fleetV14.vram')}</th>
              <th>{t('fleetV14.fleetLabels')}</th>
            </tr>
          </thead>
          <tbody>
            {panel.nodes.map((n) => (
              <tr key={n.nodeId}>
                <td>{n.nodeId}{n.status === 'draining' ? ` (${n.status})` : ''}</td>
                <td>{n.status}</td>
                <td>{n.health}</td>
                <td>{Math.round(n.load * 100)}%</td>
                <td>{n.runningTasks}/{n.maxTasks}</td>
                <td>{Math.round(n.ramUsedFraction * 100)}%</td>
                <td>{Math.round(n.vramUsedFraction * 100)}%</td>
                <td>{n.labels.join(', ') || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p>{panel.capacitySummary}</p>

      <h4>{t('fleetV14.fleetUsers')} ({panel.users.length})</h4>
      {panel.users.length === 0 ? (
        <p>—</p>
      ) : (
        <ul>
          {panel.users.map((u) => (
            <li key={u.userId}>
              {u.userId} ({u.role}) — {t('fleetV14.fleetQuota')}: {u.tightestQuota || '—'} {Math.round(u.tightestFraction * 100)}% — {t('fleetV14.fleetGrants')}: {u.activeGrants}, {t('fleetV14.fleetDenied')}: {u.deniedTargets}
            </li>
          ))}
        </ul>
      )}

      <h4>{t('fleetV14.fleetRollouts')} ({panel.rollouts.length})</h4>
      {panel.rollouts.length === 0 ? (
        <p>—</p>
      ) : (
        <ul>
          {panel.rollouts.map((r) => (
            <li key={r.id}>
              {r.feature} {r.version} — {r.stageLabel} — {t('fleetV14.fleetGate')}: {r.gatePass ? 'pass' : 'fail'} — {t('fleetV14.fleetAuto')}: {r.autoAction}
            </li>
          ))}
        </ul>
      )}

      <h4>{t('fleetV14.fleetPolls')} ({panel.polls.length})</h4>
      {panel.polls.length === 0 ? (
        <p>—</p>
      ) : (
        <ul>
          {panel.polls.map((p) => (
            <li key={p.triggerId}>
              {p.toolkit}/{p.triggerSlug} — {p.status} — {t('fleetV14.fleetPollInterval')}: {Math.round(p.currentIntervalMs / 1000)}s — {p.totalNewEvents} new, {p.totalDuplicates} duplicates
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

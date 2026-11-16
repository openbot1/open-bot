import { useState } from 'react';
import { useT } from '../i18n/useT';

/**
 * Fleet v13 panel (v1.16, Team T6) — node table (pin, RAM/VRAM,
 * health), capacity, rebalance suggestions, event log, active rollouts.
 *
 * Data comes via props (host builds the view-model from core
 * `buildFleetV13Panel` via IPC); when there is no host wiring yet
 * it uses an internal demo store — the component never guesses real
 * numbers; the demo is clearly labelled in code.
 */

export interface FleetV13PanelNodeView {
  nodeId: string;
  pinnedModels: string[];
  modelCount: number;
  ramUsedFraction: number;
  vramUsedFraction: number;
  overloaded: boolean;
  headroomRamMb: number;
}

export interface FleetV13PanelRebalanceView {
  fromNodeId: string;
  toNodeId: string;
  modelId: string;
  reason: string;
}

export interface FleetV13PanelEventView {
  seq: number;
  at: number;
  kind: string;
  nodeId: string;
  actorUserId: string;
  detail: string;
}

export interface FleetV13PanelRolloutView {
  id: string;
  feature: string;
  version: string;
  stage: string;
  stageLabel: string;
}

export interface FleetV13PanelView {
  nodes: FleetV13PanelNodeView[];
  capacitySummary: string;
  rebalance: FleetV13PanelRebalanceView[];
  events: FleetV13PanelEventView[];
  rollouts: FleetV13PanelRolloutView[];
  summary: string;
}

const T0 = Date.UTC(2026, 10, 16, 0, 0, 0);

export function demoFleetV13Panel(): FleetV13PanelView {
  return {
    nodes: [
      {
        nodeId: 'node-a', pinnedModels: ['qwen3-4b-q4_k_m'], modelCount: 1,
        ramUsedFraction: 0.85, vramUsedFraction: 0.3, overloaded: true, headroomRamMb: 1200,
      },
      {
        nodeId: 'node-b', pinnedModels: [], modelCount: 0,
        ramUsedFraction: 0.1, vramUsedFraction: 0.05, overloaded: false, headroomRamMb: 14000,
      },
    ],
    capacitySummary: 'Demo: fleet 2 nodes: pinned 2600/32768 MB RAM, 2500/16384 MB VRAM; 1 node overloaded.',
    rebalance: [
      {
        fromNodeId: 'node-a', toNodeId: 'node-b', modelId: 'qwen3-4b-q4_k_m',
        reason: 'Demo: node "node-a" overloaded (85% RAM pinned) — move model "qwen3-4b-q4_k_m" to node "node-b".',
      },
    ],
    events: [
      { seq: 1, at: T0, kind: 'pin', nodeId: 'node-a', actorUserId: 'u_owner', detail: 'pinned qwen3-4b-q4_k_m' },
      { seq: 2, at: T0 + 1, kind: 'node-join', nodeId: 'node-b', actorUserId: 'system', detail: 'node-b joined' },
    ],
    rollouts: [
      { id: 'rollout-voice-v15', feature: 'voice-v15', version: 'v15', stage: 'canary', stageLabel: 'canary (1% user)' },
    ],
    summary: 'Demo: fleet v13: 2 nodes, 1 pinned model, 1 overloaded node, 1 rebalance suggestion, 1 rollout being tracked.',
  };
}

export default function FleetV13Panel({
  panel: panelProp,
}: {
  panel?: FleetV13PanelView | null;
}) {
  const t = useT();
  const [panel] = useState<FleetV13PanelView>(() => panelProp ?? demoFleetV13Panel());

  return (
    <div>
      <h3>{t('fleetV13.fleetTitle')}</h3>
      <p>{panel.summary}</p>
      <p>{t('fleetV13.demo')}</p>
      <h4>{t('fleetV13.fleetNodes')} ({panel.nodes.length})</h4>
      {panel.nodes.length === 0 ? (
        <p>{t('fleetV13.fleetNoNodes')}</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Node</th>
              <th>Models</th>
              <th>{t('fleetV13.ram')}</th>
              <th>{t('fleetV13.vram')}</th>
              <th>{t('fleetV13.capacity')}</th>
            </tr>
          </thead>
          <tbody>
            {panel.nodes.map((n) => (
              <tr key={n.nodeId}>
                <td>{n.nodeId}{n.overloaded ? ` (${t('fleetV13.overloaded')})` : ''}</td>
                <td>{n.pinnedModels.join(', ') || '—'}</td>
                <td>{Math.round(n.ramUsedFraction * 100)}%</td>
                <td>{Math.round(n.vramUsedFraction * 100)}%</td>
                <td>{t('fleetV13.capacity')}: {n.headroomRamMb} MB {t('fleetV13.ram')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p>{panel.capacitySummary}</p>

      <h4>{t('fleetV13.fleetRebalance')}</h4>
      {panel.rebalance.length === 0 ? (
        <p>—</p>
      ) : (
        <ul>
          {panel.rebalance.map((r, i) => (
            <li key={`${r.fromNodeId}-${r.toNodeId}-${r.modelId}-${i}`}>
              {r.modelId}: {r.fromNodeId} → {r.toNodeId} — {r.reason}
            </li>
          ))}
        </ul>
      )}

      <h4>{t('fleetV13.fleetEvents')}</h4>
      {panel.events.length === 0 ? (
        <p>—</p>
      ) : (
        <ul>
          {panel.events.map((e) => (
            <li key={e.seq}>
              #{e.seq} [{e.kind}] {e.nodeId ? `${e.nodeId}: ` : ''}{e.detail} ({e.actorUserId})
            </li>
          ))}
        </ul>
      )}

      <h4>{t('fleetV13.fleetRollouts')}</h4>
      {panel.rollouts.length === 0 ? (
        <p>—</p>
      ) : (
        <ul>
          {panel.rollouts.map((r) => (
            <li key={r.id}>
              {r.feature} {r.version} — {r.stageLabel}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

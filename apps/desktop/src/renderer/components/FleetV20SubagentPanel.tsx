import { useState } from 'react';
import { useT } from '../i18n/useT';

/**
 * Fleet v20 subagent panel (v1.33, Team T6) — status of the specialised
 * subagent wave: how many are running, which kinds, which contexts, and
 * whether any was refused because the pool is full.
 *
 * Data comes via props (host builds the view-model from core
 * `buildSubagentV20Panel` via IPC); when there is no host wiring yet
 * it uses an internal demo store — the component never guesses real
 * numbers; the demo is clearly labelled in code. The panel never
 * shows transcripts — only ids, kinds, parent task ids and ages.
 */

export interface FleetV20SubagentPanelContextView {
  id: string;
  kind: string;
  parentTaskId: string;
  ageMs: number;
  sealed: boolean;
}

export interface FleetV20SubagentPanelView {
  summary: string;
  active: number;
  maxParallel: number;
  totalAllocated: number;
  rejectedFull: number;
  byKind: Record<string, number>;
  activeContexts: FleetV20SubagentPanelContextView[];
}

const T0 = Date.UTC(2026, 10, 17, 0, 0, 0);

export function demoFleetV20SubagentPanel(): FleetV20SubagentPanelView {
  return {
    summary: 'Subagent v20: 2/4 running (explore x1, verify x1)',
    active: 2,
    maxParallel: 4,
    totalAllocated: 5,
    rejectedFull: 1,
    byKind: { explore: 1, verify: 1 },
    activeContexts: [
      { id: 'explore-abc123', kind: 'explore', parentTaskId: 'task-1', ageMs: 45000, sealed: false },
      { id: 'verify-def456', kind: 'verify', parentTaskId: 'task-1', ageMs: 12000, sealed: false },
    ],
  };
}

function formatAge(ageMs: number): string {
  if (ageMs < 1000) return `${ageMs}ms`;
  const seconds = Math.round(ageMs / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s`;
}

export interface FleetV20SubagentPanelProps {
  view?: FleetV20SubagentPanelView;
  onBack?: () => void;
}

export default function FleetV20SubagentPanel(props: FleetV20SubagentPanelProps) {
  const t = useT();
  const [view] = useState<FleetV20SubagentPanelView>(() => props.view ?? demoFleetV20SubagentPanel());

  return (
    <div className="panel fleet-v20-subagent-panel">
      <div className="panel-header">
        {props.onBack ? (
          <button type="button" className="btn-ghost" onClick={props.onBack}>
            ← {t('fleetV20.back')}
          </button>
        ) : null}
        <h2>{t('fleetV20.subagentPanel')}</h2>
      </div>

      <p className="panel-summary">{view.summary}</p>

      <div className="fleet-v20-score-cards">
        <div className="score-card">
          <span className="score-label">{t('fleetV20.activeContexts')}</span>
          <strong className="score-value">{view.active}/{view.maxParallel}</strong>
          <span className="score-sub">
            {Object.entries(view.byKind).map(([kind, n]) => `${kind}x${n}`).join(', ') || '—'}
          </span>
        </div>
        <div className="score-card">
          <span className="score-label">{t('fleetV20.subagentPanel')}</span>
          <strong className="score-value">{view.totalAllocated}</strong>
          <span className="score-sub">{t('fleetV20.rejectedFull')}: {view.rejectedFull}</span>
        </div>
      </div>

      <table className="table">
        <thead>
          <tr>
            <th>Context</th>
            <th>{t('fleetV20.kind')}</th>
            <th>{t('fleetV20.parentTask')}</th>
            <th>{t('fleetV20.age')}</th>
            <th>{t('fleetV20.status')}</th>
          </tr>
        </thead>
        <tbody>
          {view.activeContexts.map((c) => (
            <tr key={c.id}>
              <td>{c.id}</td>
              <td>{c.kind}</td>
              <td>{c.parentTaskId}</td>
              <td>{formatAge(c.ageMs)}</td>
              <td>{c.sealed ? t('fleetV20.disabled') : t('fleetV20.enabled')}</td>
            </tr>
          ))}
          {view.activeContexts.length === 0 ? (
            <tr>
              <td colSpan={5}>{t('fleetV20.noResults')}</td>
            </tr>
          ) : null}
        </tbody>
      </table>
    </div>
  );
}

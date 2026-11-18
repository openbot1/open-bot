import { useState } from 'react';
import { useT } from '../i18n/useT';

/**
 * Fleet v20 dashboard (v1.33, Team T6) — the single entry screen for
 * the v20 panel group (progressive disclosure): 4 summary lines Plugin /
 * Hook / Eval / Subagent + the attention list. Clicking a panel opens
 * the right child panel; the dashboard edits nothing.
 *
 * Data comes via props (host builds the view-model from core
 * `buildFleetV20Dashboard` via IPC); when there is no host wiring yet
 * it uses an internal demo store — the component never guesses real
 * numbers; the demo is clearly labelled in code.
 */

export interface FleetV20DashboardAttentionView {
  panel: 'plugin' | 'hook' | 'eval' | 'subagent';
  level: 'error' | 'warning' | 'info';
  message: string;
}

export interface FleetV20DashboardView {
  summary: string;
  pluginSummary: string;
  hookSummary: string;
  evalSummary: string;
  subagentSummary: string;
  attentionCount: number;
  attention: FleetV20DashboardAttentionView[];
  counts: {
    pluginsEnabled: number;
    pluginsErrored: number;
    hooksErrored: number;
    hooksBlockedTotal: number;
    evalResolvedPct: number | null;
    evalPending: number;
    subagentsActive: number;
  };
}

export function demoFleetV20Dashboard(): FleetV20DashboardView {
  return {
    summary: 'Plugin: 1 enabled / 3 total, 1 dangerous permission unapproved · Hook: 2/3 enabled, blocked 2 times · Eval: 2/3 resolved · Subagent v20: 2/4 running',
    pluginSummary: 'Plugin: 1 enabled / 3 total, 1 dangerous permission unapproved',
    hookSummary: 'Hook: 2/3 enabled, blocked 2 times',
    evalSummary: 'Eval fleet-v20-smoke (gemini-2.5-flash): 2/3 resolved (66.7% resolved), 1 failed',
    subagentSummary: 'Subagent v20: 2/4 running (explore x1, verify x1)',
    attentionCount: 2,
    attention: [
      { panel: 'plugin', level: 'warning', message: 'Plugin "shell-runner" has 1 unapproved dangerous permission: shell.exec.' },
      { panel: 'eval', level: 'warning', message: 'Eval task "swe-task-002" failed: Assertion failed.' },
    ],
    counts: {
      pluginsEnabled: 1,
      pluginsErrored: 0,
      hooksErrored: 0,
      hooksBlockedTotal: 2,
      evalResolvedPct: 66.7,
      evalPending: 0,
      subagentsActive: 2,
    },
  };
}

function panelLabel(t: (key: string) => string, panel: string): string {
  switch (panel) {
    case 'plugin':
      return t('fleetV20.pluginPanel');
    case 'hook':
      return t('fleetV20.hookPanel');
    case 'eval':
      return t('fleetV20.evalPanel');
    default:
      return t('fleetV20.subagentPanel');
  }
}

export interface FleetV20DashboardProps {
  view?: FleetV20DashboardView;
  onBack?: () => void;
  onOpenPanel?: (panel: 'plugin' | 'hook' | 'eval' | 'subagent') => void;
}

export default function FleetV20Dashboard(props: FleetV20DashboardProps) {
  const t = useT();
  const [view] = useState<FleetV20DashboardView>(() => props.view ?? demoFleetV20Dashboard());

  const cards: { panel: 'plugin' | 'hook' | 'eval' | 'subagent'; title: string; body: string; badge: string }[] = [
    {
      panel: 'plugin', title: t('pluginV20.title'), body: view.pluginSummary,
      badge: `${view.counts.pluginsEnabled} ${t('fleetV20.enabled')}`,
    },
    {
      panel: 'hook', title: t('hookV20.title'), body: view.hookSummary,
      badge: `${view.counts.hooksBlockedTotal} ${t('hookV20.totalBlocks')}`,
    },
    {
      panel: 'eval', title: t('evalV20.title'), body: view.evalSummary,
      badge: view.counts.evalResolvedPct === null ? '—' : `${view.counts.evalResolvedPct.toFixed(1)}% ${t('evalV20.resolved')}`,
    },
    {
      panel: 'subagent', title: t('fleetV20.subagentPanel'), body: view.subagentSummary,
      badge: `${view.counts.subagentsActive} ${t('fleetV20.activeContexts')}`,
    },
  ];

  return (
    <div className="panel fleet-v20-dashboard">
      <div className="panel-header">
        {props.onBack ? (
          <button type="button" className="btn-ghost" onClick={props.onBack}>
            ← {t('fleetV20.back')}
          </button>
        ) : null}
        <h2>{t('fleetV20.pluginPanel')} / {t('fleetV20.hookPanel')} / {t('fleetV20.evalPanel')}</h2>
      </div>

      <p className="panel-summary">{view.summary}</p>

      <div className="fleet-v20-score-cards">
        {cards.map((card) => (
          <div key={card.panel} className="score-card">
            <span className="score-label">{card.title}</span>
            <strong className="score-value">{card.badge}</strong>
            <span className="score-sub">{card.body}</span>
            {props.onOpenPanel ? (
              <button type="button" className="btn-ghost" onClick={() => props.onOpenPanel?.(card.panel)}>
                {panelLabel(t, card.panel)} →
              </button>
            ) : null}
          </div>
        ))}
      </div>

      <h3>
        {t('fleetV20.attention')} ({view.attentionCount})
      </h3>
      {view.attention.length === 0 ? (
        <p>{t('fleetV20.noResults')}</p>
      ) : (
        <ul className="alert-list">
          {view.attention.map((a, i) => (
            <li key={`${a.panel}-${i}`} className={`alert-item alert-${a.level === 'error' ? 'error' : 'warning'}`}>
              <strong>[{panelLabel(t, a.panel)}]</strong> {a.message}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

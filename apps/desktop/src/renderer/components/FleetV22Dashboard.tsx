import { useState } from 'react';
import { useT } from '../i18n/useT';

/**
 * Fleet v22 dashboard (v1.35, Team T6) — the single entry screen for
 * the v22 panel group (progressive disclosure): 4 summary lines User /
 * Computer / Orchestration / Probe + attention list. Clicking a panel
 * opens the right child panel on the host; the dashboard edits nothing.
 *
 * Data comes via props (host builds the view-model from core
 * `buildFleetV22Dashboard` via IPC); when there is no host wiring yet
 * it uses an internal demo store — the component never guesses real
 * numbers; the demo is clearly labelled in code.
 */

export interface FleetV22DashboardAttentionView {
  panel: 'user' | 'computer' | 'orchestration' | 'probe';
  level: 'error' | 'warning' | 'info';
  message: string;
}

export interface FleetV22DashboardView {
  summary: string;
  userSummary: string;
  computerSummary: string;
  orchestrationSummary: string;
  probeSummary: string | null;
  attentionCount: number;
  attention: FleetV22DashboardAttentionView[];
  counts: {
    usersTotal: number;
    usersNearLimit: number;
    usersLocked: number;
    computersTotal: number;
    computersRunning: number;
    computersFailed: number;
    computersPressured: number;
    delegationsRunning: number;
    delegationsAwaitingVerification: number;
    handoffsPendingApproval: number;
  };
}

export function demoFleetV22Dashboard(): FleetV22DashboardView {
  return {
    summary:
      '3 users (1 admin, 1 operator, 1 member), 1 user nearly out of quota · ' +
      '3 computers: 1 running, 1 failed · ' +
      'Delegation: 3 total, 1 running, 1 awaiting verification. Handoff: 2 total, 1 awaiting approval. Audit: 1 entry. · ' +
      'Host 8 CPU cores, 32 GB RAM — 4 CPU cores, 22 GB RAM allocatable after headroom.',
    userSummary: '3 users (1 admin, 1 operator, 1 member), 1 user nearly out of quota.',
    computerSummary: '3 computers: 1 running, 1 failed, 1 under resource pressure.',
    orchestrationSummary: 'Delegation: 3 total, 1 running, 1 awaiting verification. Handoff: 2 total, 1 awaiting approval. Audit: 1 entry.',
    probeSummary: 'Host 8 CPU cores, 32 GB RAM — 4 CPU cores, 22 GB RAM allocatable after headroom.',
    attentionCount: 4,
    attention: [
      { panel: 'computer', level: 'error', message: 'Computer "c2" (bot b2) failed: vm crashed — review and recreate it.' },
      { panel: 'user', level: 'warning', message: 'User "U1" nearly out of quota (highest usage 88%).' },
      { panel: 'orchestration', level: 'warning', message: 'Delegation "d2" finished and is awaiting parent verification of the result.' },
      { panel: 'orchestration', level: 'warning', message: 'Handoff "h2" awaiting approval — the conversation has not moved to the specialist agent yet.' },
    ],
    counts: {
      usersTotal: 3,
      usersNearLimit: 1,
      usersLocked: 0,
      computersTotal: 3,
      computersRunning: 1,
      computersFailed: 1,
      computersPressured: 1,
      delegationsRunning: 1,
      delegationsAwaitingVerification: 1,
      handoffsPendingApproval: 1,
    },
  };
}

function panelLabel(t: (key: string) => string, panel: string): string {
  switch (panel) {
    case 'user':
      return t('fleet.v22.users');
    case 'computer':
      return t('fleet.v22.computers');
    case 'orchestration':
      return t('fleet.v22.orchestration');
    default:
      return t('fleet.v22.probe');
  }
}

export interface FleetV22DashboardProps {
  view?: FleetV22DashboardView;
  onBack?: () => void;
  onOpenPanel?: (panel: 'user' | 'computer' | 'orchestration' | 'probe') => void;
}

export default function FleetV22Dashboard(props: FleetV22DashboardProps) {
  const t = useT();
  const [view] = useState<FleetV22DashboardView>(() => props.view ?? demoFleetV22Dashboard());

  const cards: { panel: 'user' | 'computer' | 'orchestration' | 'probe'; title: string; body: string; badge: string }[] = [
    {
      panel: 'user', title: t('fleet.v22.users'), body: view.userSummary,
      badge: `${view.counts.usersTotal} ${t('fleet.v22.user')}`,
    },
    {
      panel: 'computer', title: t('fleet.v22.computers'), body: view.computerSummary,
      badge: `${view.counts.computersRunning}/${view.counts.computersTotal} ${t('fleet.v22.running')}`,
    },
    {
      panel: 'orchestration', title: t('fleet.v22.orchestration'), body: view.orchestrationSummary,
      badge: `${view.counts.delegationsAwaitingVerification} ${t('fleet.v22.awaitingVerification')}`,
    },
    {
      panel: 'probe', title: t('fleet.v22.probe'), body: view.probeSummary ?? t('fleet.v22.staleProbe'),
      badge: t('fleet.v22.allocatable'),
    },
  ];

  return (
    <div className="panel fleet-v22-dashboard">
      <div className="panel-header">
        {props.onBack ? (
          <button type="button" className="btn-ghost" onClick={props.onBack}>
            ← {t('fleet.v22.dashboard')}
          </button>
        ) : null}
        <h2>{t('fleet.v22.title')}</h2>
      </div>

      <p className="panel-summary">{view.summary}</p>

      <div className="fleet-v22-score-cards">
        {cards.map((card) => (
          <button
            key={card.panel}
            type="button"
            className="score-card"
            onClick={() => props.onOpenPanel?.(card.panel)}
          >
            <div className="score-card-title">{card.title}</div>
            <div className="score-card-body">{card.body}</div>
            <div className="score-card-badge">{card.badge}</div>
          </button>
        ))}
      </div>

      <h3>
        {t('fleet.v22.attention')}
        {view.attentionCount > 0 ? ` (${view.attentionCount})` : ''}
      </h3>
      {view.attention.length === 0 ? (
        <p className="panel-empty">{t('fleet.v22.dashboard')}</p>
      ) : (
        <ul className="attention-list">
          {view.attention.map((item, idx) => (
            <li key={`${item.panel}-${idx}`} className={`attention-${item.level}`}>
              <button
                type="button"
                className="attention-panel"
                onClick={() => props.onOpenPanel?.(item.panel)}
              >
                {panelLabel(t, item.panel)}
              </button>
              <span>{item.message}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

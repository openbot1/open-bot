import { useState } from 'react';
import { useT } from '../i18n/useT';

/**
 * Fleet v22 orchestration panel (v1.35, Team T6) — 2 orchestration
 * patterns in one screen: delegation (subagent, parent keeps control,
 * awaits verification) + handoff (hands the whole conversation to a
 * specialist agent, awaits approval) + latest audit trail.
 *
 * Data comes via props (host builds the view-model from core
 * `buildFleetV22OrchestrationPanel` via IPC); when there is no host
 * wiring yet it uses an internal demo store — the component never
 * guesses real numbers; the demo is clearly labelled in code.
 */

export interface FleetV22OrchestrationAuditView {
  id: string;
  kind: string;
  conversationId: string;
  runId: string;
  ownerId: string;
  summary: string;
  detail: Record<string, string>;
  at: number;
}

export interface FleetV22OrchestrationPanelView {
  summary: string;
  delegationsTotal: number;
  delegationsRunning: number;
  delegationsAwaitingVerification: number;
  delegationsCompleted: number;
  delegationsFailed: number;
  delegationsTimedOut: number;
  handoffsTotal: number;
  handoffsPendingApproval: number;
  handoffsTransferred: number;
  handoffsRejected: number;
  handoffsFailed: number;
  auditEntries: number;
  oldestAwaitingVerificationMs: number | null;
  awaitingVerificationIds: string[];
  pendingApprovalHandoffIds: string[];
  recentAudit: FleetV22OrchestrationAuditView[];
}

export function demoFleetV22OrchestrationPanel(): FleetV22OrchestrationPanelView {
  return {
    summary:
      'Delegation: 3 total, 1 running, 1 awaiting verification, 1 done. ' +
      'Handoff: 2 total, 1 transferred, 1 awaiting approval. Audit: 1 entry.',
    delegationsTotal: 3,
    delegationsRunning: 1,
    delegationsAwaitingVerification: 1,
    delegationsCompleted: 1,
    delegationsFailed: 0,
    delegationsTimedOut: 0,
    handoffsTotal: 2,
    handoffsPendingApproval: 1,
    handoffsTransferred: 1,
    handoffsRejected: 0,
    handoffsFailed: 0,
    auditEntries: 1,
    oldestAwaitingVerificationMs: 60_000,
    awaitingVerificationIds: ['d2'],
    pendingApprovalHandoffIds: ['h2'],
    recentAudit: [
      {
        id: 'orc-1', kind: 'handoff', conversationId: 'conv-1', runId: 'run-1', ownerId: 'u1',
        summary: 'Handoff triage → billing qua transfer_to_billing (transferred).',
        detail: { handoffId: 'h1', from: 'triage', to: 'billing' }, at: 1780000000000,
      },
    ],
  };
}

export interface FleetV22OrchestrationPanelProps {
  view?: FleetV22OrchestrationPanelView;
  onBack?: () => void;
}

export default function FleetV22OrchestrationPanel(props: FleetV22OrchestrationPanelProps) {
  const t = useT();
  const [view] = useState<FleetV22OrchestrationPanelView>(() => props.view ?? demoFleetV22OrchestrationPanel());

  return (
    <div className="panel fleet-v22-orchestration-panel">
      <div className="panel-header">
        {props.onBack ? (
          <button type="button" className="btn-ghost" onClick={props.onBack}>
            ← {t('fleet.v22.dashboard')}
          </button>
        ) : null}
        <h2>{t('fleet.v22.orchestration')}</h2>
      </div>

      <p className="panel-summary">{view.summary}</p>

      <div className="fleet-v22-score-cards">
        <div className="score-card">
          <div className="score-card-title">{t('fleet.v22.delegation')}</div>
          <div className="score-card-body">
            {`${view.delegationsRunning} ${t('fleet.v22.running')} / ${view.delegationsTotal}`}
          </div>
          <div className="score-card-badge">
            {`${view.delegationsAwaitingVerification} ${t('fleet.v22.awaitingVerification')}`}
          </div>
        </div>
        <div className="score-card">
          <div className="score-card-title">{t('fleet.v22.handoff')}</div>
          <div className="score-card-body">
            {`${view.handoffsTransferred} ${t('fleet.v22.transferred')} / ${view.handoffsTotal}`}
          </div>
          <div className="score-card-badge">
            {`${view.handoffsPendingApproval} ${t('fleet.v22.pendingApproval')}`}
          </div>
        </div>
        <div className="score-card">
          <div className="score-card-title">{t('fleet.v22.audit')}</div>
          <div className="score-card-body">{view.auditEntries}</div>
        </div>
      </div>

      <h3>{t('fleet.v22.awaitingVerification')}</h3>
      {view.awaitingVerificationIds.length === 0 ? (
        <p className="panel-empty">{t('fleet.v22.noDelegations')}</p>
      ) : (
        <ul className="attention-list">
          {view.awaitingVerificationIds.map((id) => (
            <li key={id} className="attention-warning">
              <span>{`Delegation "${id}" — ${t('fleet.v22.awaitingVerification')}.`}</span>
            </li>
          ))}
        </ul>
      )}

      <h3>{t('fleet.v22.pendingApproval')}</h3>
      {view.pendingApprovalHandoffIds.length === 0 ? (
        <p className="panel-empty">{t('fleet.v22.noHandoffs')}</p>
      ) : (
        <ul className="attention-list">
          {view.pendingApprovalHandoffIds.map((id) => (
            <li key={id} className="attention-warning">
              <span>{`Handoff "${id}" — ${t('fleet.v22.pendingApproval')}.`}</span>
            </li>
          ))}
        </ul>
      )}

      <h3>{t('fleet.v22.audit')}</h3>
      {view.recentAudit.length === 0 ? (
        <p className="panel-empty">{t('fleet.v22.audit')}</p>
      ) : (
        <ul className="attention-list">
          {view.recentAudit.map((entry) => (
            <li key={entry.id} className="attention-info">
              <span>
                {`[${entry.kind}] ${entry.summary}`}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

import { useMemo, useState } from 'react';
import { useT } from '../i18n/useT';

/**
 * Fleet v24 stop hook panel (v1.37, Team T6) — feedback recorded when a
 * stop hook fires: why the run stopped, who/what triggered it, what the
 * hook decided, and the suggested next action. Queryable by run or
 * automation; unacknowledged feedback is the operator's review list.
 *
 * Data comes via props (host builds the view-model from core
 * `buildFleetV24StopHookPanel` via IPC); when there is no host wiring
 * yet it uses an internal demo store — the component never guesses real
 * numbers; the demo is clearly labelled in code.
 */

export type FleetV24StopTrigger = 'user' | 'process' | 'rule' | 'timeout' | 'approval' | 'system';
export type FleetV24StopAction = 'stop' | 'pause' | 'retry' | 'escalate' | 'ignore';

export interface FleetV24StopHookRowView {
  id: string;
  runId: string;
  automationId: string;
  reason: string;
  triggeredBy: FleetV24StopTrigger;
  triggeredByName: string;
  action: FleetV24StopAction;
  suggestedNextAction: string;
  stoppedAtMs: number;
  acknowledged: boolean;
  acknowledgedBy: string | null;
  acknowledgedAtMs: number | null;
}

export interface FleetV24StopHookSummaryView {
  key: string;
  total: number;
  unacknowledged: number;
  byTrigger: Record<FleetV24StopTrigger, number>;
  byAction: Record<FleetV24StopAction, number>;
  latestAtMs: number | null;
}

export interface FleetV24StopHookPanelView {
  summary: string;
  stats: FleetV24StopHookSummaryView;
  unacknowledged: FleetV24StopHookRowView[];
  recent: FleetV24StopHookRowView[];
  byAutomation: FleetV24StopHookSummaryView[];
  byTrigger: FleetV24StopHookSummaryView[];
}

export function demoFleetV24StopHookPanel(): FleetV24StopHookPanelView {
  const rows: FleetV24StopHookRowView[] = [
    {
      id: 'sh-001', runId: 'run-20261118-0007', automationId: 'auto-cleanup',
      reason: 'max-steps reached (120 steps)', triggeredBy: 'system',
      triggeredByName: 'agent-loop', action: 'stop',
      suggestedNextAction: 'Reduce the scope of the task or raise the step limit, then resume from the last checkpoint.',
      stoppedAtMs: 1794391800000, acknowledged: false, acknowledgedBy: null, acknowledgedAtMs: null,
    },
    {
      id: 'sh-002', runId: 'run-20261118-0005', automationId: 'auto-weekly-report',
      reason: 'User pressed Stop', triggeredBy: 'user', triggeredByName: 'huy',
      action: 'pause',
      suggestedNextAction: 'Resume the run manually when ready, or cancel it if it is no longer needed.',
      stoppedAtMs: 1794389000000, acknowledged: true, acknowledgedBy: 'huy', acknowledgedAtMs: 1794389600000,
    },
    {
      id: 'sh-003', runId: 'run-20261118-0003', automationId: 'auto-nightly-backup',
      reason: 'Rule nightly-guard tripped: backup overlapped the report window',
      triggeredBy: 'rule', triggeredByName: 'nightly-guard', action: 'retry',
      suggestedNextAction: 'Review the rule that fired; if the stop was wrong, tune the rule before re-running.',
      stoppedAtMs: 1794384000000, acknowledged: true, acknowledgedBy: 'team-data', acknowledgedAtMs: 1794385000000,
    },
  ];
  const summary: FleetV24StopHookSummaryView = {
    key: '*', total: 3, unacknowledged: 1,
    byTrigger: { user: 1, process: 0, rule: 1, timeout: 0, approval: 0, system: 1 },
    byAction: { stop: 1, pause: 1, retry: 1, escalate: 0, ignore: 0 },
    latestAtMs: 1794391800000,
  };
  return {
    summary: '3 stop-hook events · 1 unacknowledged · user 1 · process 0 · rule 1 · timeout 0 · approval 0 · system 1',
    stats: summary,
    unacknowledged: rows.filter((r) => !r.acknowledged),
    recent: rows,
    byAutomation: [
      { ...summary, key: 'auto-cleanup', total: 1, unacknowledged: 1, byTrigger: { user: 0, process: 0, rule: 0, timeout: 0, approval: 0, system: 1 }, byAction: { stop: 1, pause: 0, retry: 0, escalate: 0, ignore: 0 } },
      { ...summary, key: 'auto-weekly-report', total: 1, unacknowledged: 0, byTrigger: { user: 1, process: 0, rule: 0, timeout: 0, approval: 0, system: 0 }, byAction: { stop: 0, pause: 1, retry: 0, escalate: 0, ignore: 0 } },
      { ...summary, key: 'auto-nightly-backup', total: 1, unacknowledged: 0, byTrigger: { user: 0, process: 0, rule: 1, timeout: 0, approval: 0, system: 0 }, byAction: { stop: 0, pause: 0, retry: 1, escalate: 0, ignore: 0 } },
    ],
    byTrigger: [
      { ...summary, key: 'user', total: 1, unacknowledged: 0, byTrigger: { user: 1, process: 0, rule: 0, timeout: 0, approval: 0, system: 0 }, byAction: { stop: 0, pause: 1, retry: 0, escalate: 0, ignore: 0 } },
      { ...summary, key: 'rule', total: 1, unacknowledged: 0, byTrigger: { user: 0, process: 0, rule: 1, timeout: 0, approval: 0, system: 0 }, byAction: { stop: 0, pause: 0, retry: 1, escalate: 0, ignore: 0 } },
      { ...summary, key: 'system', total: 1, unacknowledged: 1, byTrigger: { user: 0, process: 0, rule: 0, timeout: 0, approval: 0, system: 1 }, byAction: { stop: 1, pause: 0, retry: 0, escalate: 0, ignore: 0 } },
    ],
  };
}

function triggerLabel(t: (key: string) => string, trigger: FleetV24StopTrigger): string {
  return t(`fleet.v24.trigger${trigger[0].toUpperCase()}${trigger.slice(1)}`);
}

function actionLabel(t: (key: string) => string, action: FleetV24StopAction): string {
  return t(`fleet.v24.action${action[0].toUpperCase()}${action.slice(1)}`);
}

export interface FleetV24StopHookPanelProps {
  view?: FleetV24StopHookPanelView;
  onBack?: () => void;
  onAcknowledge?: (id: string) => void;
}

export default function FleetV24StopHookPanel(props: FleetV24StopHookPanelProps) {
  const t = useT();
  const [view, setView] = useState<FleetV24StopHookPanelView>(() => props.view ?? demoFleetV24StopHookPanel());
  const [automationFilter, setAutomationFilter] = useState<string>('');
  const [showAcknowledged, setShowAcknowledged] = useState<boolean>(false);

  const automationIds = useMemo(
    () => view.byAutomation.map((s) => s.key),
    [view],
  );

  const visible = useMemo(() => {
    const base = showAcknowledged ? view.recent : view.unacknowledged;
    return automationFilter === '' ? base : base.filter((r) => r.automationId === automationFilter);
  }, [view, automationFilter, showAcknowledged]);

  const handleAcknowledge = (id: string) => {
    props.onAcknowledge?.(id);
    // Optimistic local update for the demo store (host re-renders with real data).
    setView((prev) => {
      const mark = (rows: FleetV24StopHookRowView[]) =>
        rows.map((r) => (r.id === id ? { ...r, acknowledged: true } : r));
      return {
        ...prev,
        unacknowledged: prev.unacknowledged.filter((r) => r.id !== id),
        recent: mark(prev.recent),
      };
    });
  };

  return (
    <div className="panel fleet-v24-stop-hook">
      <div className="panel-header">
        {props.onBack ? (
          <button type="button" className="btn-ghost" onClick={props.onBack}>
            ← {t('fleet.v24.dashboard')}
          </button>
        ) : null}
        <h2>{t('fleet.v24.stopHook')}</h2>
      </div>

      <p className="panel-summary">{view.summary}</p>

      <div className="fleet-v24-filters">
        <label>
          {t('fleet.v24.filterByAutomation')}
          <select value={automationFilter} onChange={(e) => setAutomationFilter(e.target.value)}>
            <option value="">{t('fleet.v24.allAutomations')}</option>
            {automationIds.map((id) => (
              <option key={id} value={id}>{id}</option>
            ))}
          </select>
        </label>
        <label className="fleet-v24-checkbox">
          <input
            type="checkbox"
            checked={showAcknowledged}
            onChange={(e) => setShowAcknowledged(e.target.checked)}
          />
          {t('fleet.v24.showAcknowledged')}
        </label>
      </div>

      <h3>
        {showAcknowledged ? t('fleet.v24.recent') : t('fleet.v24.unacknowledged')}
        {` (${visible.length})`}
      </h3>
      {visible.length === 0 ? (
        <p className="panel-empty">{t('fleet.v24.noFeedback')}</p>
      ) : (
        <ul className="fleet-v24-stop-list">
          {visible.map((f) => (
            <li key={f.id} className="fleet-v24-stop-item">
              <div className="fleet-v24-stop-head">
                <strong>{f.automationId}</strong>
                <span className="fleet-v24-muted">{f.runId}</span>
                <span>{triggerLabel(t, f.triggeredBy)}: {f.triggeredByName}</span>
                <span>{actionLabel(t, f.action)}</span>
              </div>
              <div>{t('fleet.v24.stopReason')}: {f.reason}</div>
              <div>{t('fleet.v24.suggestedNextAction')}: {f.suggestedNextAction}</div>
              <div className="fleet-v24-muted">
                {new Date(f.stoppedAtMs).toLocaleString()}
                {f.acknowledged
                  ? ` · ${t('fleet.v24.acknowledged')} (${f.acknowledgedBy ?? ''})`
                  : ''}
              </div>
              {!f.acknowledged ? (
                <button type="button" className="btn-ghost" onClick={() => handleAcknowledge(f.id)}>
                  {t('fleet.v24.acknowledge')}
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      <h3>{t('fleet.v24.byAutomation')}</h3>
      <table className="fleet-v24-table">
        <thead>
          <tr>
            <th>{t('fleet.v24.automation')}</th>
            <th>{t('fleet.v24.total')}</th>
            <th>{t('fleet.v24.unacknowledged')}</th>
          </tr>
        </thead>
        <tbody>
          {view.byAutomation.map((s) => (
            <tr key={s.key}>
              <td>{s.key}</td>
              <td>{String(s.total)}</td>
              <td>{String(s.unacknowledged)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

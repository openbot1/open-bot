import { useState } from 'react';
import { useT } from '../i18n/useT';

/**
 * Fleet v19 job queue panel (v1.29, Team T6) — queue stats, next job
 * + target node, retrying jobs, dead-letter.
 *
 * Data comes via props (host builds the view-model from core
 * `buildFleetV19JobQueuePanel` via IPC); when there is no host wiring
 * yet it uses an internal demo store — the component never guesses
 * real numbers; the demo is clearly labelled in code.
 */

export interface FleetV19JobQueuePanelJobView {
  jobId: string;
  taskId: string;
  priority: number;
  effectivePriority: number;
  status: string;
  attempts: number;
  maxAttempts: number;
  nodeId: string;
  createdAt: number;
  lastError: string;
}

export interface FleetV19JobQueuePanelRetryView {
  jobId: string;
  attempts: number;
  maxAttempts: number;
  lastError: string;
  retryInMs: number;
}

export interface FleetV19JobQueuePanelView {
  queued: number;
  running: number;
  retrying: number;
  done: number;
  dead: number;
  cancelled: number;
  oldestWaitMs: number | null;
  avgWaitMs: number | null;
  doneLastHour: number;
  estimatedWaitMs: number | null;
  nextJob: FleetV19JobQueuePanelJobView | null;
  nextJobNodeId: string | null;
  nextJobBlockedReasons: string[];
  retryingJobs: FleetV19JobQueuePanelRetryView[];
  deadJobs: FleetV19JobQueuePanelJobView[];
  summary: string;
}

const T0 = Date.UTC(2026, 10, 17, 0, 0, 0);
const MIN = 60 * 1000;

export function demoFleetV19JobQueuePanel(): FleetV19JobQueuePanelView {
  return {
    queued: 2,
    running: 1,
    retrying: 1,
    done: 5,
    dead: 1,
    cancelled: 0,
    oldestWaitMs: 12 * MIN,
    avgWaitMs: 7 * MIN,
    doneLastHour: 5,
    estimatedWaitMs: 24 * MIN,
    nextJob: {
      jobId: 'job-101', taskId: 'task-101', priority: 7, effectivePriority: 8.5,
      status: 'queued', attempts: 0, maxAttempts: 3, nodeId: '', createdAt: T0, lastError: '',
    },
    nextJobNodeId: 'node-a',
    nextJobBlockedReasons: [],
    retryingJobs: [
      {
        jobId: 'job-097', attempts: 2, maxAttempts: 3,
        lastError: 'model server timeout', retryInMs: 2 * MIN,
      },
    ],
    deadJobs: [
      {
        jobId: 'job-088', taskId: 'task-088', priority: 3, effectivePriority: 3,
        status: 'dead', attempts: 3, maxAttempts: 3, nodeId: 'node-b',
        createdAt: T0 - 60 * MIN, lastError: 'disk full',
      },
    ],
    summary: '2 queued, 1 running, 1 retrying, 1 dead · longest wait 720s · estimated wait 1440s',
  };
}

function formatWait(t: (key: string) => string, ms: number | null): string {
  if (ms === null) return '—';
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

export interface FleetV19JobQueuePanelProps {
  view?: FleetV19JobQueuePanelView;
  onBack?: () => void;
  onCancelJob?: (jobId: string) => void;
  onRequeueDeadJob?: (jobId: string) => void;
}

export default function FleetV19JobQueuePanel(props: FleetV19JobQueuePanelProps) {
  const t = useT();
  const [view] = useState<FleetV19JobQueuePanelView>(() => props.view ?? demoFleetV19JobQueuePanel());
  const [showDead, setShowDead] = useState(true);

  return (
    <div className="panel fleet-v19-queue-panel">
      <div className="panel-header">
        {props.onBack ? (
          <button type="button" className="btn-ghost" onClick={props.onBack}>
            ← {t('fleetV19.back')}
          </button>
        ) : null}
        <h2>{t('fleetV19.jobQueue')}</h2>
      </div>

      <p className="panel-summary">{view.summary}</p>

      <div className="fleet-v19-score-cards">
        <div className="score-card">
          <span className="score-label">{t('fleetV19.queuedJobs')}</span>
          <strong className="score-value">{view.queued}</strong>
          <span className="score-sub">
            {view.running} running · {view.retrying} retrying
          </span>
        </div>
        <div className="score-card">
          <span className="score-label">{t('fleetV19.oldestWait')}</span>
          <strong className="score-value">{formatWait(t, view.oldestWaitMs)}</strong>
          <span className="score-sub">
            {t('fleetV19.avgWait')}: {formatWait(t, view.avgWaitMs)}
          </span>
        </div>
        <div className="score-card">
          <span className="score-label">{t('fleetV19.estimatedWait')}</span>
          <strong className="score-value">{formatWait(t, view.estimatedWaitMs)}</strong>
          <span className="score-sub">
            {view.doneLastHour} {t('fleetV19.doneLastHour')}
          </span>
        </div>
      </div>

      <h3>{t('fleetV19.nextJob')}</h3>
      {view.nextJob === null ? (
        <p>{t('fleetV19.noNextJob')}</p>
      ) : (
        <div className="next-job">
          <strong>{view.nextJob.jobId}</strong> · task {view.nextJob.taskId} ·{' '}
          {t('fleetV19.priority')}: {view.nextJob.priority} (
          {t('fleetV19.effectivePriority')}: {view.nextJob.effectivePriority}) ·{' '}
          {t('fleetV19.targetNode')}: {view.nextJobNodeId ?? '—'}
          {view.nextJobBlockedReasons.length > 0 ? (
            <ul>
              {view.nextJobBlockedReasons.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
          ) : null}
          {props.onCancelJob ? (
            <button type="button" className="btn-ghost" onClick={() => props.onCancelJob?.(view.nextJob?.jobId ?? '')}>
              {t('fleetV19.cancelJob')}
            </button>
          ) : null}
        </div>
      )}

      <h3>
        {t('fleetV19.retrying')} ({view.retryingJobs.length})
      </h3>
      {view.retryingJobs.length === 0 ? (
        <p>{t('fleetV19.noRetryingJobs')}</p>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>Job</th>
              <th>{t('fleetV19.attempts')}</th>
              <th>{t('fleetV19.lastError')}</th>
              <th>{t('fleetV19.retryIn')}</th>
            </tr>
          </thead>
          <tbody>
            {view.retryingJobs.map((j) => (
              <tr key={j.jobId}>
                <td>{j.jobId}</td>
                <td>
                  {j.attempts}/{j.maxAttempts}
                </td>
                <td>{j.lastError}</td>
                <td>{formatWait(t, j.retryInMs)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h3>
        <button type="button" className="btn-ghost" onClick={() => setShowDead((v) => !v)}>
          {showDead ? '▾' : '▸'} {t('fleetV19.deadLetter')} ({view.dead})
        </button>
      </h3>
      {showDead ? (
        view.deadJobs.length === 0 ? (
          <p>{t('fleetV19.noDeadJobs')}</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Job</th>
                <th>{t('fleetV19.attempts')}</th>
                <th>{t('fleetV19.lastError')}</th>
                <th>{t('fleetV19.requeue')}</th>
              </tr>
            </thead>
            <tbody>
              {view.deadJobs.map((j) => (
                <tr key={j.jobId}>
                  <td>{j.jobId}</td>
                  <td>
                    {j.attempts}/{j.maxAttempts}
                  </td>
                  <td>{j.lastError}</td>
                  <td>
                    {props.onRequeueDeadJob ? (
                      <button type="button" className="btn-ghost" onClick={() => props.onRequeueDeadJob?.(j.jobId)}>
                        {t('fleetV19.requeue')}
                      </button>
                    ) : (
                      '—'
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )
      ) : null}
    </div>
  );
}

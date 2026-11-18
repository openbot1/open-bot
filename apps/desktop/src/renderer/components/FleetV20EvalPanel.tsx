import { useState } from 'react';
import { useT } from '../i18n/useT';

/**
 * Fleet v20 eval panel (v1.33, Team T6) — run the eval harness, view
 * % resolved + cost/task, slowest/most expensive failed tasks, regressions vs baseline.
 *
 * Data comes via props (host builds the view-model from core
 * `buildEvalV20Panel` via IPC); when there is no host wiring yet it
 * uses an internal demo store — the component never guesses real
 * numbers; the demo is clearly labelled in code.
 */

export interface FleetV20EvalPanelTaskView {
  taskId: string;
  description: string;
  category: string;
  difficulty: number;
  verdict: string;
  testsPassed?: number;
  testsTotal?: number;
  cost: number;
  durationMs: number;
  outputExcerpt?: string;
  error?: string;
}

export interface FleetV20EvalPanelRegressionView {
  regressed: boolean;
  resolvedPctDelta: number | null;
  avgCostDeltaPct: number | null;
  newlyFailedTaskIds: string[];
  newlyResolvedTaskIds: string[];
  summary: string;
}

export interface FleetV20EvalPanelView {
  runId: string;
  suiteName: string;
  model: string;
  complete: boolean;
  summary: string;
  resolvedPct: number | null;
  resolved: number;
  completed: number;
  total: number;
  failed: number;
  timeout: number;
  error: number;
  avgCostPerTask: number | null;
  medianCostPerTask: number | null;
  maxCostPerTask: number | null;
  avgDurationMs: number | null;
  mostExpensiveTaskId: string | null;
  slowestTaskId: string | null;
  byCategory: Record<string, { completed: number; resolved: number; resolvedPct: number | null }>;
  rows: FleetV20EvalPanelTaskView[];
  pendingTaskIds: string[];
  retryableTaskIds: string[];
  regression: FleetV20EvalPanelRegressionView | null;
}

export function demoFleetV20EvalPanel(): FleetV20EvalPanelView {
  return {
    runId: 'eval-2026-11-17-001',
    suiteName: 'fleet-v20-smoke',
    model: 'gemini-2.5-flash',
    complete: true,
    summary: 'Eval fleet-v20-smoke (gemini-2.5-flash): 2/3 resolved (66.7% resolved), 1 failed, 0 timeout, 0 error, 0.0120 cost/task',
    resolvedPct: 66.7,
    resolved: 2,
    completed: 3,
    total: 3,
    failed: 1,
    timeout: 0,
    error: 0,
    avgCostPerTask: 0.012,
    medianCostPerTask: 0.01,
    maxCostPerTask: 0.02,
    avgDurationMs: 1200,
    mostExpensiveTaskId: 'swe-task-003',
    slowestTaskId: 'swe-task-003',
    byCategory: {
      coding: { completed: 2, resolved: 1, resolvedPct: 50 },
      'tool-use': { completed: 1, resolved: 1, resolvedPct: 100 },
    },
    rows: [
      {
        taskId: 'swe-task-002', description: 'Fix the null check bug.', category: 'coding',
        difficulty: 2, verdict: 'failed', testsPassed: 1, testsTotal: 3, cost: 0.006,
        durationMs: 800, outputExcerpt: '1 failed: expected true, got false', error: 'Assertion failed',
      },
      {
        taskId: 'swe-task-001', description: 'Add a test for the plugin manager.', category: 'coding',
        difficulty: 1, verdict: 'resolved', testsPassed: 2, testsTotal: 2, cost: 0.01, durationMs: 1000,
        outputExcerpt: '2 passed',
      },
      {
        taskId: 'swe-task-003', description: 'Call the right tool per the plan.', category: 'tool-use',
        difficulty: 3, verdict: 'resolved', testsPassed: 1, testsTotal: 1, cost: 0.02, durationMs: 1800,
        outputExcerpt: '1 passed',
      },
    ],
    pendingTaskIds: [],
    retryableTaskIds: ['swe-task-002'],
    regression: {
      regressed: false,
      resolvedPctDelta: 16.7,
      avgCostDeltaPct: -5,
      newlyFailedTaskIds: [],
      newlyResolvedTaskIds: ['swe-task-001'],
      summary: 'No regression vs baseline eval-2026-11-16-001: resolved +16.7 points %; cost/task -5.0%; 1 newly resolved task: swe-task-001',
    },
  };
}

function verdictLabel(t: (key: string) => string, verdict: string): string {
  switch (verdict) {
    case 'resolved':
      return t('evalV20.resolved');
    case 'failed':
      return t('evalV20.failed');
    case 'timeout':
      return t('evalV20.timeout');
    case 'error':
      return t('evalV20.error');
    default:
      return t('evalV20.pending');
  }
}

export interface FleetV20EvalPanelProps {
  view?: FleetV20EvalPanelView;
  onBack?: () => void;
  onRunEval?: (suiteName: string) => void;
  onRetryTask?: (taskId: string) => void;
}

export default function FleetV20EvalPanel(props: FleetV20EvalPanelProps) {
  const t = useT();
  const [view] = useState<FleetV20EvalPanelView>(() => props.view ?? demoFleetV20EvalPanel());
  const [filter, setFilter] = useState<'all' | 'failed' | 'resolved'>('all');
  const shownRows =
    filter === 'failed'
      ? view.rows.filter((r) => r.verdict === 'failed' || r.verdict === 'timeout' || r.verdict === 'error')
      : filter === 'resolved'
        ? view.rows.filter((r) => r.verdict === 'resolved')
        : view.rows;

  return (
    <div className="panel fleet-v20-eval-panel">
      <div className="panel-header">
        {props.onBack ? (
          <button type="button" className="btn-ghost" onClick={props.onBack}>
            ← {t('fleetV20.back')}
          </button>
        ) : null}
        <h2>{t('evalV20.title')}</h2>
      </div>

      <p className="panel-summary">{view.summary}</p>

      <div className="fleet-v20-score-cards">
        <div className="score-card">
          <span className="score-label">{t('evalV20.resolvedPct')}</span>
          <strong className="score-value">{view.resolvedPct === null ? '—' : `${view.resolvedPct.toFixed(1)}%`}</strong>
          <span className="score-sub">
            {view.resolved}/{view.completed} {t('evalV20.resolved')} · {view.complete ? t('evalV20.complete') : t('evalV20.incomplete')}
          </span>
        </div>
        <div className="score-card">
          <span className="score-label">{t('evalV20.costPerTask')}</span>
          <strong className="score-value">{view.avgCostPerTask === null ? '—' : view.avgCostPerTask.toFixed(4)}</strong>
          <span className="score-sub">
            {t('evalV20.medianCost')}: {view.medianCostPerTask === null ? '—' : view.medianCostPerTask.toFixed(4)} ·{' '}
            {t('evalV20.maxCost')}: {view.maxCostPerTask === null ? '—' : view.maxCostPerTask.toFixed(4)}
          </span>
        </div>
        <div className="score-card">
          <span className="score-label">{t('evalV20.avgDuration')}</span>
          <strong className="score-value">{view.avgDurationMs === null ? '—' : `${Math.round(view.avgDurationMs)}ms`}</strong>
          <span className="score-sub">
            {t('evalV20.mostExpensive')}: {view.mostExpensiveTaskId ?? '—'} · {t('evalV20.slowest')}: {view.slowestTaskId ?? '—'}
          </span>
        </div>
      </div>

      {view.regression ? (
        <p className={view.regression.regressed ? 'row-error' : 'panel-summary'}>
          {view.regression.regressed ? t('evalV20.regression') : t('evalV20.noRegression')}: {view.regression.summary}
        </p>
      ) : null}

      <div className="fleet-v20-filter">
        <button type="button" className={filter === 'all' ? 'btn-active' : 'btn-ghost'} onClick={() => setFilter('all')}>
          {t('fleetV20.all')} ({view.rows.length})
        </button>
        <button type="button" className={filter === 'failed' ? 'btn-active' : 'btn-ghost'} onClick={() => setFilter('failed')}>
          {t('evalV20.failed')} ({view.failed + view.timeout + view.error})
        </button>
        <button type="button" className={filter === 'resolved' ? 'btn-active' : 'btn-ghost'} onClick={() => setFilter('resolved')}>
          {t('evalV20.resolved')} ({view.resolved})
        </button>
        {props.onRunEval ? (
          <button type="button" className="btn-ghost" onClick={() => props.onRunEval?.(view.suiteName)}>
            {t('evalV20.title')}
          </button>
        ) : null}
      </div>

      <table className="table">
        <thead>
          <tr>
            <th>{t('evalV20.task')}</th>
            <th>{t('evalV20.category')}</th>
            <th>{t('evalV20.verdict')}</th>
            <th>{t('evalV20.tests')}</th>
            <th>{t('evalV20.costPerTask')}</th>
            <th>{t('evalV20.duration')}</th>
            <th>{t('fleetV20.actions')}</th>
          </tr>
        </thead>
        <tbody>
          {shownRows.map((r) => (
            <tr key={r.taskId} className={r.verdict === 'resolved' ? '' : 'row-attention'}>
              <td>
                <strong>{r.taskId}</strong>
                <div className="row-sub">{r.description}</div>
                {r.outputExcerpt ? <div className="row-sub">{r.outputExcerpt}</div> : null}
                {r.error ? <div className="row-error">{r.error}</div> : null}
              </td>
              <td>{r.category} · {t('evalV20.difficulty')} {r.difficulty}</td>
              <td>{verdictLabel(t, r.verdict)}</td>
              <td>{r.testsPassed !== undefined && r.testsTotal !== undefined ? `${r.testsPassed}/${r.testsTotal}` : '—'}</td>
              <td>{r.cost.toFixed(4)}</td>
              <td>{r.durationMs}ms</td>
              <td>
                {r.verdict !== 'resolved' && r.verdict !== 'pending' && props.onRetryTask ? (
                  <button type="button" className="btn-ghost" onClick={() => props.onRetryTask?.(r.taskId)}>
                    {t('evalV20.retryable')}
                  </button>
                ) : (
                  '—'
                )}
              </td>
            </tr>
          ))}
          {shownRows.length === 0 ? (
            <tr>
              <td colSpan={7}>{t('fleetV20.noResults')}</td>
            </tr>
          ) : null}
        </tbody>
      </table>

      {view.pendingTaskIds.length > 0 ? (
        <p className="panel-summary">
          {t('evalV20.pending')}: {view.pendingTaskIds.join(', ')}
        </p>
      ) : null}
    </div>
  );
}

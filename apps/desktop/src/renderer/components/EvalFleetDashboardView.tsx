import { useCallback, useEffect, useState } from 'react';
import type { FleetPolicyV4, FleetStatusView, FleetTaskV4, RegressionAlert } from '@open-bot/core';
import { useT } from '../i18n/useT';

/**
 * Eval + fleet dashboard (v1.05, Team T6) — one screen for two things:
 *
 * - Latest memory eval score (offline fixture dataset + mock
 *   embedding, run locally via IPC `memoryEval:*`): overall score +
 *   per question kind (recall / temporal / multi-hop), F1/recall
 *   history chart, regression alerts when scores drop past threshold;
 * - Fleet status (IPC `fleet:list` already exists): which bots are
 *   running, service state, allocated resources; plus the v4
 *   allocation policy (IPC `fleetV4:policy-get`).
 *
 * No fake data: before the first eval run, the panel shows an empty
 * state + a "Run eval" button (runs the local mock retriever, writes
 * real history to `<userData>/eval-memory-history.json`). The chart
 * is drawn from that real history.
 */

async function callOpenBot<T>(channel: string, camel: string, ...args: unknown[]): Promise<T | null> {
  const api = window.openBot as unknown as Record<string, unknown>;
  const fn = api[channel] ?? api[camel];
  if (typeof fn !== 'function') return null;
  return (fn as (...a: unknown[]) => Promise<T>).apply(window.openBot, args);
}

interface CategoryScoreView {
  category: string;
  count: number;
  recall: number;
  precision: number;
  f1: number;
  temporalAccuracy: number | null;
  multiHopScore: number | null;
  judgeScore: number;
}

interface MemoryEvalReportView {
  datasetId: string;
  retrieverVersion: string;
  topK: number;
  at: number;
  byCategory: CategoryScoreView[];
  overall: CategoryScoreView;
}

interface EvalHistoryView {
  runs: number;
  latest: MemoryEvalReportView | null;
  history: Array<{
    at: number;
    retrieverVersion: string;
    f1: number;
    recall: number;
    temporalAccuracy: number | null;
    multiHopScore: number | null;
    judgeScore: number;
  }>;
  regressionAlerts: RegressionAlert[];
}

interface EvalComparisonView {
  baseline: { retrieverVersion: string; at: number };
  current: { retrieverVersion: string; at: number };
  overallDelta: {
    f1: number;
    recall: number;
    precision: number;
    temporalAccuracy: number | null;
    multiHopScore: number | null;
    judgeScore: number;
  };
  byCategoryDelta: Array<{
    category: string;
    f1: number;
    recall: number;
    temporalAccuracy: number | null;
    multiHopScore: number | null;
    judgeScore: number;
  }>;
  questionMoves: { improved: number; worsened: number; unchanged: number };
}

interface Props {
  onBack: () => void;
}

function pct(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function fmtDate(at: number): string {
  try {
    return new Date(at).toLocaleString();
  } catch {
    return String(at);
  }
}

function fmtBytes(bytes: number): string {
  if (bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

/**
 * Simple SVG line chart: F1 (blue) + recall (orange) over time,
 * drawn from real history. No external chart library.
 */
function ScoreChart({ history }: { history: EvalHistoryView['history'] }) {
  const t = useT();
  const width = 560;
  const height = 180;
  const pad = 28;
  if (history.length === 0) return null;
  const points = history.map((h, i) => ({
    x: history.length === 1 ? width / 2 : pad + (i * (width - pad * 2)) / (history.length - 1),
    f1: h.f1,
    recall: h.recall,
    label: h.retrieverVersion,
  }));
  const y = (v: number) => height - pad - v * (height - pad * 2);
  const line = (pick: (p: (typeof points)[number]) => number) =>
    points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${y(pick(p)).toFixed(1)}`).join(' ');
  return (
    <div>
      <svg width={width} height={height} role="img" aria-label={t('evalFleet.historyChart')}>
        <line x1={pad} y1={height - pad} x2={width - pad} y2={height - pad} stroke="#888" strokeWidth="1" />
        <line x1={pad} y1={pad} x2={pad} y2={height - pad} stroke="#888" strokeWidth="1" />
        {[0, 0.5, 1].map((v) => (
          <text key={v} x={4} y={y(v) + 4} fontSize="10" fill="#888">
            {pct(v)}
          </text>
        ))}
        <path d={line((p) => p.f1)} fill="none" stroke="#2563eb" strokeWidth="2" />
        <path d={line((p) => p.recall)} fill="none" stroke="#ea580c" strokeWidth="2" />
        {points.map((p) => (
          <g key={p.label + p.x}>
            <circle cx={p.x} cy={y(p.f1)} r="3" fill="#2563eb" />
            <circle cx={p.x} cy={y(p.recall)} r="3" fill="#ea580c" />
            <text x={p.x} y={height - 8} fontSize="10" fill="#888" textAnchor="middle">
              {p.label.slice(0, 12)}
            </text>
          </g>
        ))}
      </svg>
      <div style={{ fontSize: 12, color: '#666' }}>
        <span style={{ color: '#2563eb' }}>— {t('evalFleet.f1')}</span>
        {'  '}
        <span style={{ color: '#ea580c' }}>— {t('evalFleet.recall')}</span>
      </div>
    </div>
  );
}

export default function EvalFleetDashboardView({ onBack }: Props) {
  const t = useT();
  const [data, setData] = useState<EvalHistoryView | null>(null);
  const [fleet, setFleet] = useState<FleetStatusView[]>([]);
  const [policy, setPolicy] = useState<FleetPolicyV4 | null>(null);
  const [tasks, setTasks] = useState<FleetTaskV4[]>([]);
  const [versionLabel, setVersionLabel] = useState('mock-embedding-v1');
  const [datasets, setDatasets] = useState<Array<{ id: string; name: string; version: number; facts: number; questions: number }>>([]);
  const [datasetId, setDatasetId] = useState('builtin-memory-v1');
  const [running, setRunning] = useState(false);
  const [comparison, setComparison] = useState<EvalComparisonView | null>(null);
  const [comparing, setComparing] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    const [datasetList, history, fleetList, policyValue, taskList] = await Promise.all([
      callOpenBot<Array<{ id: string; name: string; version: number; facts: number; questions: number }>>('memoryEval:datasets', 'memoryEvalDatasets'),
      callOpenBot<EvalHistoryView>('memoryEval:history', 'memoryEvalHistory'),
      callOpenBot<FleetStatusView[]>('fleet:list', 'listFleet'),
      callOpenBot<FleetPolicyV4>('fleetV4:policy-get', 'fleetV4PolicyGet'),
      callOpenBot<FleetTaskV4[]>('fleetV4:tasks-list', 'fleetV4TasksList'),
    ]);
    if (datasetList) setDatasets(datasetList);
    if (history) setData(history);
    if (fleetList) setFleet(fleetList);
    if (policyValue) setPolicy(policyValue);
    if (taskList) setTasks(taskList);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const runEval = useCallback(async () => {
    setRunning(true);
    setError('');
    try {
      const result = await callOpenBot<{ report: MemoryEvalReportView; alerts: RegressionAlert[] }>(
        'memoryEval:run',
        'memoryEvalRun',
        { datasetId, retrieverVersion: versionLabel.trim() || 'mock-embedding-v1', topK: 5 },
      );
      if (!result) {
        setError(t('evalFleet.ipcUnavailable'));
      } else {
        await load();
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setRunning(false);
    }
  }, [load, datasetId, versionLabel, t]);

  const compareRuns = useCallback(async () => {
    setComparing(true);
    setError('');
    try {
      const result = await callOpenBot<EvalComparisonView>('memoryEval:compare', 'memoryEvalCompare', {});
      if (!result) {
        setError(t('evalFleet.ipcUnavailable'));
      } else {
        setComparison(result);
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setComparing(false);
    }
  }, [t]);

  const latest = data?.latest ?? null;
  const alerts = data?.regressionAlerts ?? [];

  return (
    <div style={{ padding: 16, maxWidth: 900 }}>
      <button type="button" onClick={onBack}>
        ← {t('marketplace.back')}
      </button>
      <h2>{t('evalFleet.title')}</h2>
      <p style={{ color: '#666' }}>{t('evalFleet.subtitle')}</p>

      {error !== '' && (
        <div style={{ background: '#fee2e2', padding: 10, borderRadius: 6, marginBottom: 12 }}>{error}</div>
      )}

      {alerts.length > 0 && (
        <div style={{ background: '#fef3c7', padding: 10, borderRadius: 6, marginBottom: 12 }}>
          <strong>{t('evalFleet.regressionAlert')}</strong>
          <ul>
            {alerts.map((a, i) => (
              <li key={`${a.metric}-${a.category}-${i}`}>{a.message}</li>
            ))}
          </ul>
        </div>
      )}

      <section style={{ marginBottom: 24 }}>
        <h3>{t('evalFleet.latestScores')}</h3>
        {latest === null ? (
          <p>{t('evalFleet.noRuns')}</p>
        ) : (
          <>
            <p>
              {latest.datasetId} · {latest.retrieverVersion} · {fmtDate(latest.at)} · topK {latest.topK}
            </p>
            <table style={{ borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <th style={{ textAlign: 'left', padding: '4px 12px 4px 0' }}>{t('evalFleet.category')}</th>
                  <th style={{ padding: '4px 12px' }}>{t('evalFleet.f1')}</th>
                  <th style={{ padding: '4px 12px' }}>{t('evalFleet.recall')}</th>
                  <th style={{ padding: '4px 12px' }}>{t('evalFleet.precision')}</th>
                  <th style={{ padding: '4px 12px' }}>{t('evalFleet.temporal')}</th>
                  <th style={{ padding: '4px 12px' }}>{t('evalFleet.multihop')}</th>
                  <th style={{ padding: '4px 12px' }}>{t('evalFleet.judge')}</th>
                </tr>
              </thead>
              <tbody>
                {[...latest.byCategory, latest.overall].map((row) => (
                  <tr key={row.category}>
                    <td style={{ padding: '4px 12px 4px 0' }}>
                      {row.category} ({row.count})
                    </td>
                    <td style={{ padding: '4px 12px' }}>{pct(row.f1)}</td>
                    <td style={{ padding: '4px 12px' }}>{pct(row.recall)}</td>
                    <td style={{ padding: '4px 12px' }}>{pct(row.precision)}</td>
                    <td style={{ padding: '4px 12px' }}>{row.temporalAccuracy === null ? '—' : pct(row.temporalAccuracy)}</td>
                    <td style={{ padding: '4px 12px' }}>{row.multiHopScore === null ? '—' : pct(row.multiHopScore)}</td>
                    <td style={{ padding: '4px 12px' }}>{pct(row.judgeScore)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
        <div style={{ marginTop: 12, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <label>
            {t('evalFleet.dataset')}{' '}
            <select value={datasetId} onChange={(e) => setDatasetId(e.target.value)} disabled={running}>
              {datasets.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name} ({d.questions} Q)
                </option>
              ))}
            </select>
          </label>
          <label>
            {t('evalFleet.runVersion')}{' '}
            <input value={versionLabel} onChange={(e) => setVersionLabel(e.target.value)} disabled={running} />
          </label>
          <button type="button" onClick={() => void runEval()} disabled={running}>
            {running ? t('evalFleet.running') : t('evalFleet.runEval')}
          </button>
        </div>
      </section>

      <section style={{ marginBottom: 24 }}>
        <h3>{t('evalFleet.history')}</h3>
        {data && data.history.length > 0 ? (
          <ScoreChart history={data.history} />
        ) : (
          <p>{t('evalFleet.noHistory')}</p>
        )}
      </section>

      <section style={{ marginBottom: 24 }}>
        <h3>{t('evalFleet.compareTitle')}</h3>
        <button type="button" onClick={() => void compareRuns()} disabled={comparing || (data?.runs ?? 0) < 2}>
          {comparing ? t('evalFleet.comparing') : t('evalFleet.compare')}
        </button>
        {(data?.runs ?? 0) < 2 && <p>{t('evalFleet.noComparison')}</p>}
        {comparison !== null && (
          <>
            <p>
              {comparison.baseline.retrieverVersion} ({fmtDate(comparison.baseline.at)}) →{' '}
              {comparison.current.retrieverVersion} ({fmtDate(comparison.current.at)})
            </p>
            <p>
              {t('evalFleet.improved')}: {comparison.questionMoves.improved} · {t('evalFleet.worsened')}:{' '}
              {comparison.questionMoves.worsened} · {t('evalFleet.unchanged')}: {comparison.questionMoves.unchanged}
            </p>
            <table style={{ borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <th style={{ textAlign: 'left', padding: '4px 12px 4px 0' }}>{t('evalFleet.category')}</th>
                  <th style={{ padding: '4px 12px' }}>{t('evalFleet.f1')} (change)</th>
                  <th style={{ padding: '4px 12px' }}>{t('evalFleet.recall')} (change)</th>
                </tr>
              </thead>
              <tbody>
                {comparison.byCategoryDelta.map((row) => (
                  <tr key={row.category}>
                    <td style={{ padding: '4px 12px 4px 0' }}>{row.category}</td>
                    <td style={{ padding: '4px 12px' }}>{(row.f1 * 100).toFixed(1)}pp</td>
                    <td style={{ padding: '4px 12px' }}>{(row.recall * 100).toFixed(1)}pp</td>
                  </tr>
                ))}
                <tr>
                  <td style={{ padding: '4px 12px 4px 0' }}>
                    <strong>overall</strong>
                  </td>
                  <td style={{ padding: '4px 12px' }}>
                    <strong>{(comparison.overallDelta.f1 * 100).toFixed(1)}pp</strong>
                  </td>
                  <td style={{ padding: '4px 12px' }}>
                    <strong>{(comparison.overallDelta.recall * 100).toFixed(1)}pp</strong>
                  </td>
                </tr>
              </tbody>
            </table>
          </>
        )}
      </section>

      <section style={{ marginBottom: 24 }}>
        <h3>{t('evalFleet.fleetStatus')}</h3>
        {fleet.length === 0 ? (
          <p>{t('evalFleet.noFleet')}</p>
        ) : (
          <table style={{ borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={{ textAlign: 'left', padding: '4px 12px 4px 0' }}>{t('evalFleet.bot')}</th>
                <th style={{ padding: '4px 12px' }}>{t('evalFleet.state')}</th>
                <th style={{ padding: '4px 12px' }}>{t('evalFleet.cpu')}</th>
                <th style={{ padding: '4px 12px' }}>{t('evalFleet.ram')}</th>
                <th style={{ padding: '4px 12px' }}>{t('evalFleet.uptime')}</th>
              </tr>
            </thead>
            <tbody>
              {fleet.map((s) => (
                <tr key={s.workspace.id}>
                  <td style={{ padding: '4px 12px 4px 0' }}>{s.workspace.name}</td>
                  <td style={{ padding: '4px 12px' }}>
                    {s.workspace.status} / {s.service.state}
                  </td>
                  <td style={{ padding: '4px 12px' }}>{s.workspace.cpuCores}</td>
                  <td style={{ padding: '4px 12px' }}>{fmtBytes(s.workspace.ramBytes)}</td>
                  <td style={{ padding: '4px 12px' }}>
                    {s.service.uptimeMs === null ? '—' : `${Math.round(s.service.uptimeMs / 1000)}s`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section style={{ marginBottom: 24 }}>
        <h3>{t('evalFleet.taskQueue')}</h3>
        {tasks.length === 0 ? (
          <p>{t('evalFleet.noTasks')}</p>
        ) : (
          <table style={{ borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={{ textAlign: 'left', padding: '4px 12px 4px 0' }}>{t('evalFleet.taskTitle')}</th>
                <th style={{ padding: '4px 12px' }}>{t('evalFleet.taskPriority')}</th>
                <th style={{ padding: '4px 12px' }}>{t('evalFleet.taskStatus')}</th>
                <th style={{ padding: '4px 12px' }}>{t('evalFleet.taskBot')}</th>
              </tr>
            </thead>
            <tbody>
              {tasks.map((task) => (
                <tr key={task.id}>
                  <td style={{ padding: '4px 12px 4px 0' }}>{task.title}</td>
                  <td style={{ padding: '4px 12px' }}>{task.priority}</td>
                  <td style={{ padding: '4px 12px' }}>{task.status}</td>
                  <td style={{ padding: '4px 12px' }}>{task.assignedBotId ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section style={{ marginBottom: 24 }}>
        <h3>{t('evalFleet.policy')}</h3>
        {policy === null ? (
          <p>{t('evalFleet.noPolicy')}</p>
        ) : (
          <ul>
            <li>
              {t('evalFleet.maxBots')}: {policy.maxConcurrentBots === 0 ? '∞' : policy.maxConcurrentBots}
            </li>
            <li>
              {t('evalFleet.tokenQuota')}: {policy.perBotTokenQuota === 0 ? '∞' : policy.perBotTokenQuota.toLocaleString()}
            </li>
            <li>
              {t('evalFleet.defaultPriority')}: {policy.defaultPriority}
            </li>
            <li>
              {t('evalFleet.maxRestarts')}: {policy.maxRestartsPerHour}
            </li>
            <li>
              {t('evalFleet.maxTasksPerBot')}: {policy.maxTasksPerBot === 0 ? '∞' : policy.maxTasksPerBot}
            </li>
            <li>
              {t('evalFleet.requireCapability')}: {policy.requireCapabilityMatch ? t('evalFleet.yes') : t('evalFleet.no')}
            </li>
          </ul>
        )}
      </section>
    </div>
  );
}

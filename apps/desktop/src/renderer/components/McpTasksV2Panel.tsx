/**
 * MCP Tasks v2 panel (v1.44, Team T3).
 *
 * One panel for the whole v2 surface the user can see:
 *   - Tasks v2 jobs: DAG progress (done/total, mean progress),
 *     per-node status / progress / attempts / error, retry for
 *     failed nodes, cancel for a running job, artifact ids for
 *     completed nodes.
 *   - Server discovery (v2): per-server inventory summary —
 *     verdict (ready / degraded / incompatible), score, tool /
 *     resource / prompt counts, findings.
 *   - Memory KG (JSONL): live counts + recall hits.
 *
 * Purely presentational: data comes in via props, every action
 * goes out via callbacks — the coordinator wires the real
 * `TaskV2Orchestrator` / `McpAppsV2ToolHost` one layer up, the
 * same way `McpAppsTasksPanel` does. That keeps the panel
 * testable without Electron.
 */
import { useState } from 'react';
import { useT } from '../i18n/useT';

export type McpTasksV2NodeStatus =
  | 'queued'
  | 'waiting'
  | 'running'
  | 'input_required'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'skipped';

export type McpTasksV2JobStatus = 'idle' | 'running' | 'completed' | 'failed' | 'cancelled' | 'partial';

export interface McpTasksV2Node {
  id: string;
  label: string;
  serverName: string;
  status: McpTasksV2NodeStatus;
  progress: number;
  attempts: number;
  maxAttempts: number;
  error?: string;
  artifactId?: string;
}

export interface McpTasksV2Job {
  jobId: string;
  status: McpTasksV2JobStatus;
  total: number;
  done: number;
  failed: number;
  skipped: number;
  meanProgress: number;
  nodes: McpTasksV2Node[];
}

export type McpDiscoverV2Verdict = 'ready' | 'degraded' | 'incompatible';

export interface McpDiscoverV2Summary {
  serverName: string;
  serverVersion: string;
  protocolVersion: string;
  verdict: McpDiscoverV2Verdict;
  score: number;
  tools: number;
  resources: number;
  prompts: number;
  findings: { severity: 'warning' | 'error'; code: string; message: string }[];
}

export interface McpMemoryKgSummary {
  events: number;
  liveEntities: number;
  liveRelations: number;
  notes: number;
}

export interface McpMemoryKgHit {
  kind: 'entity' | 'relation' | 'note';
  id: string;
  text: string;
  score: number;
}

interface Props {
  jobs: McpTasksV2Job[];
  discoveries: McpDiscoverV2Summary[];
  kg?: McpMemoryKgSummary;
  recallHits?: McpMemoryKgHit[];
  onRetryTask?: (jobId: string, taskId: string) => void;
  onCancelJob?: (jobId: string) => void;
  onRecall?: (query: string) => void;
  onBack?: () => void;
}

const JOB_STATUS_KEYS: Record<McpTasksV2JobStatus, string> = {
  idle: 'mcpV144T3.jobStatus.idle',
  running: 'mcpV144T3.jobStatus.running',
  completed: 'mcpV144T3.jobStatus.completed',
  failed: 'mcpV144T3.jobStatus.failed',
  cancelled: 'mcpV144T3.jobStatus.cancelled',
  partial: 'mcpV144T3.jobStatus.partial',
};

const NODE_STATUS_KEYS: Record<McpTasksV2NodeStatus, string> = {
  queued: 'mcpV144T3.nodeStatus.queued',
  waiting: 'mcpV144T3.nodeStatus.waiting',
  running: 'mcpV144T3.nodeStatus.running',
  input_required: 'mcpV144T3.nodeStatus.input_required',
  completed: 'mcpV144T3.nodeStatus.completed',
  failed: 'mcpV144T3.nodeStatus.failed',
  cancelled: 'mcpV144T3.nodeStatus.cancelled',
  skipped: 'mcpV144T3.nodeStatus.skipped',
};

const VERDICT_KEYS: Record<McpDiscoverV2Verdict, string> = {
  ready: 'mcpV144T3.verdict.ready',
  degraded: 'mcpV144T3.verdict.degraded',
  incompatible: 'mcpV144T3.verdict.incompatible',
};

export default function McpTasksV2Panel({
  jobs,
  discoveries,
  kg,
  recallHits,
  onRetryTask,
  onCancelJob,
  onRecall,
  onBack,
}: Props) {
  const t = useT();
  const [query, setQuery] = useState('');
  const [busyJob, setBusyJob] = useState<string | null>(null);
  const [busyNode, setBusyNode] = useState<string | null>(null);

  return (
    <section aria-label={t('mcpV144T3.tasksPanelTitle')}>
      <header style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        {onBack ? <button type="button" onClick={onBack}>{t('mcpV144T3.back')}</button> : null}
        <h2 style={{ margin: 0 }}>{t('mcpV144T3.tasksPanelTitle')}</h2>
        <span style={{ fontSize: 12, opacity: 0.7 }}>
          {t('mcpV144T3.jobsSummary', { jobs: jobs.length, running: jobs.filter((j) => j.status === 'running').length })}
        </span>
      </header>

      <h3>{t('mcpV144T3.jobsTitle')}</h3>
      {jobs.length === 0 ? (
        <p>{t('mcpV144T3.jobsEmpty')}</p>
      ) : (
        <ul style={{ listStyle: 'none', padding: 0 }}>
          {jobs.map((job) => {
            const pct = Math.max(0, Math.min(100, Math.round(job.meanProgress * 100)));
            return (
              <li key={job.jobId} style={{ border: '1px solid #ddd', borderRadius: 6, padding: 10, marginBottom: 10 }}>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                  <strong>{job.jobId}</strong>
                  <span style={{ fontSize: 12, opacity: 0.7 }}>
                    {t(JOB_STATUS_KEYS[job.status])}
                    {' · '}
                    {t('mcpV144T3.jobProgress', { done: job.done, total: job.total })}
                    {job.failed > 0 ? ` · ${t('mcpV144T3.jobFailed', { count: job.failed })}` : ''}
                    {job.skipped > 0 ? ` · ${t('mcpV144T3.jobSkipped', { count: job.skipped })}` : ''}
                  </span>
                  <span style={{ flex: 1 }} />
                  {job.status === 'running' ? (
                    <button
                      type="button"
                      disabled={busyJob === job.jobId}
                      onClick={() => {
                        setBusyJob(job.jobId);
                        onCancelJob?.(job.jobId);
                        setBusyJob(null);
                      }}
                    >
                      {t('mcpV144T3.cancelJob')}
                    </button>
                  ) : null}
                </div>
                <div
                  role="progressbar"
                  aria-valuenow={pct}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-label={job.jobId}
                  style={{ height: 8, background: '#eee', borderRadius: 4, overflow: 'hidden', marginTop: 6 }}
                >
                  <div
                    style={{
                      width: `${pct}%`,
                      height: '100%',
                      background: job.status === 'failed' || job.status === 'partial' ? '#c0392b' : '#2e7d32',
                    }}
                  />
                </div>
                <ul style={{ marginTop: 8, paddingLeft: 16 }}>
                  {job.nodes.map((node) => {
                    const nodePct = Math.max(0, Math.min(100, Math.round(node.progress * 100)));
                    return (
                      <li key={node.id} style={{ marginBottom: 6 }}>
                        <div>
                          <strong>{node.label}</strong>{' '}
                          <span style={{ fontSize: 12, opacity: 0.7 }}>
                            {node.serverName} · {t(NODE_STATUS_KEYS[node.status])}
                            {node.status === 'running' ? ` · ${nodePct}%` : ''}
                            {` · ${t('mcpV144T3.attempts', { current: node.attempts, max: node.maxAttempts })}`}
                            {node.artifactId ? ` · ${t('mcpV144T3.artifact', { id: node.artifactId })}` : ''}
                          </span>{' '}
                          {node.status === 'failed' ? (
                            <button
                              type="button"
                              disabled={busyNode === node.id}
                              onClick={() => {
                                setBusyNode(node.id);
                                onRetryTask?.(job.jobId, node.id);
                                setBusyNode(null);
                              }}
                            >
                              {t('mcpV144T3.retry')}
                            </button>
                          ) : null}
                        </div>
                        {node.error ? (
                          <div style={{ fontSize: 12, color: '#c0392b' }}>{node.error}</div>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              </li>
            );
          })}
        </ul>
      )}

      <h3>{t('mcpV144T3.discoverTitle')}</h3>
      {discoveries.length === 0 ? (
        <p>{t('mcpV144T3.discoverEmpty')}</p>
      ) : (
        <ul>
          {discoveries.map((d) => (
            <li key={d.serverName} style={{ marginBottom: 8 }}>
              <strong>{d.serverName}</strong>{' '}
              <span style={{ fontSize: 12, opacity: 0.7 }}>
                v{d.serverVersion} · {d.protocolVersion} · {t(VERDICT_KEYS[d.verdict])}
                {' · '}
                {t('mcpV144T3.discoverScore', { score: d.score })}
                {' · '}
                {t('mcpV144T3.discoverCounts', { tools: d.tools, resources: d.resources, prompts: d.prompts })}
              </span>
              {d.findings.length > 0 ? (
                <ul style={{ fontSize: 12, marginTop: 4 }}>
                  {d.findings.map((f, index) => (
                    <li key={`${d.serverName}-${f.code}-${index}`}>
                      [{f.severity}] {f.message}
                    </li>
                  ))}
                </ul>
              ) : (
                <div style={{ fontSize: 12, opacity: 0.7 }}>{t('mcpV144T3.noFindings')}</div>
              )}
            </li>
          ))}
        </ul>
      )}

      <h3>{t('mcpV144T3.kgTitle')}</h3>
      {kg ? (
        <p style={{ fontSize: 13 }}>
          {t('mcpV144T3.kgStats', {
            events: kg.events,
            entities: kg.liveEntities,
            relations: kg.liveRelations,
            notes: kg.notes,
          })}
        </p>
      ) : (
        <p>{t('mcpV144T3.kgEmpty')}</p>
      )}
      <div style={{ display: 'flex', gap: 8 }}>
        <input
          type="text"
          value={query}
          placeholder={t('mcpV144T3.recallPlaceholder')}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && query.trim()) onRecall?.(query.trim());
          }}
          style={{ flex: 1, padding: '6px 8px', borderRadius: 4, border: '1px solid #aaa' }}
        />
        <button type="button" disabled={!query.trim()} onClick={() => onRecall?.(query.trim())}>
          {t('mcpV144T3.recallSearch')}
        </button>
      </div>
      {recallHits !== undefined ? (
        recallHits.length === 0 ? (
          <p>{t('mcpV144T3.recallEmpty')}</p>
        ) : (
          <ul style={{ marginTop: 8 }}>
            {recallHits.map((hit) => (
              <li key={`${hit.kind}-${hit.id}`} style={{ marginBottom: 4 }}>
                <strong>[{hit.kind}]</strong> {hit.text}{' '}
                <span style={{ fontSize: 12, opacity: 0.7 }}>
                  {t('mcpV144T3.recallScore', { score: Math.round(hit.score * 100) })}
                </span>
              </li>
            ))}
          </ul>
        )
      ) : null}
    </section>
  );
}

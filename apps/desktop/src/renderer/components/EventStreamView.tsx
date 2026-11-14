import { useCallback, useEffect, useState } from 'react';
import type {
  EventStreamBucketView,
  EventStreamSummaryView,
  RunLogEventView,
  RunLogMetaView,
} from '../types';
import { useT } from '../i18n/useT';

/**
 * Event-stream viewer (v1.03) — the cross-run lens over the
 * event-sourced run log.
 *
 * Left: run list (newest first). Main: a text/type filter over the
 * events of the selected runs, a summary (counts per type, errors,
 * tokens, tool calls), per-minute buckets (burst shape), and the
 * newest events first. Events are already sanitised in core (no
 * secrets, tool args keep key names only), so the UI renders them
 * directly. Data flows over IPC `runlog:list` + `runlog:event-stream`
 * (see main.ts) — this view reads no T1 code directly.
 */

async function callOpenBot<T>(channel: string, camel: string, ...args: unknown[]): Promise<T | null> {
  const api = window.openBot as unknown as Record<string, unknown>;
  const fn = api[channel] ?? api[camel];
  if (typeof fn !== 'function') return null;
  return (fn as (...a: unknown[]) => Promise<T>).apply(window.openBot, args);
}

interface Props {
  onBack: () => void;
}

const ALL_TYPES = [
  'run.started',
  'run.prompt',
  'model.response',
  'tool.call',
  'tool.result',
  'file.change',
  'compile.error',
  'run.paused',
  'run.resumed',
  'run.forked',
  'run.completed',
  'run.failed',
  'run.aborted',
  'approval.request',
  'approval.decision',
  'checkpoint.saved',
] as const;

export default function EventStreamView({ onBack }: Props) {
  const t = useT();
  const [runs, setRuns] = useState<RunLogMetaView[]>([]);
  const [selectedRunIds, setSelectedRunIds] = useState<string[]>([]);
  const [typeFilter, setTypeFilter] = useState('');
  const [text, setText] = useState('');
  const [events, setEvents] = useState<RunLogEventView[]>([]);
  const [summary, setSummary] = useState<EventStreamSummaryView | null>(null);
  const [buckets, setBuckets] = useState<EventStreamBucketView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadRuns = useCallback(async () => {
    try {
      const list = await callOpenBot<RunLogMetaView[]>('runlog:list', 'listRunLogs');
      if (list) setRuns(list);
    } catch {
      // Runs are best-effort; the stream still works with no filter.
    }
  }, []);

  useEffect(() => {
    void loadRuns();
  }, [loadRuns]);

  const loadStream = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await callOpenBot<{
        events: RunLogEventView[];
        summary: EventStreamSummaryView;
        buckets: EventStreamBucketView[];
      }>('runlog:event-stream', 'readEventStream', {
        ...(selectedRunIds.length > 0 ? { runIds: selectedRunIds } : {}),
        ...(typeFilter ? { types: [typeFilter] } : {}),
        ...(text.trim() ? { text: text.trim() } : {}),
        limit: 500,
      });
      if (!result) {
        setError(t('eventStream.loadError'));
        return;
      }
      setEvents(result.events);
      setSummary(result.summary);
      setBuckets(result.buckets);
    } catch (err) {
      setError((err as Error).message || t('eventStream.loadError'));
    } finally {
      setLoading(false);
    }
  }, [selectedRunIds, typeFilter, text, t]);

  useEffect(() => {
    void loadStream();
  }, [loadStream]);

  function toggleRun(runId: string) {
    setSelectedRunIds((prev) =>
      prev.includes(runId) ? prev.filter((id) => id !== runId) : [...prev, runId],
    );
  }

  const maxBucket = buckets.reduce((m, b) => Math.max(m, b.count), 0);

  return (
    <div>
      <div className="row" style={{ alignItems: 'center', gap: 8 }}>
        <button className="btn secondary" onClick={onBack}>
          {t('marketplace.back')}
        </button>
        <h2 style={{ margin: 0, flex: 1 }}>{t('eventStream.title')}</h2>
        <button className="btn secondary" onClick={() => void loadStream()} disabled={loading}>
          {t('fleet.refresh')}
        </button>
      </div>
      <p style={{ color: '#666', marginTop: 4 }}>{t('eventStream.subtitle')}</p>

      <div className="row" style={{ gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={t('eventStream.textPlaceholder')}
          style={{ flex: 1, minWidth: 180 }}
        />
        <label>
          {t('eventStream.typeLabel')}{' '}
          <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)}>
            <option value="">{t('eventStream.typeAll')}</option>
            {ALL_TYPES.map((type) => (
              <option key={type} value={type}>
                {type}
              </option>
            ))}
          </select>
        </label>
      </div>

      {runs.length > 0 && (
        <div style={{ marginBottom: 12 }}>
          <strong style={{ fontSize: 13 }}>{t('eventStream.runs')}</strong>
          <div className="row" style={{ gap: 6, flexWrap: 'wrap', marginTop: 6 }}>
            {runs.slice(0, 12).map((run) => (
              <button
                key={run.runId}
                className={selectedRunIds.includes(run.runId) ? 'btn' : 'btn secondary'}
                style={{ fontSize: 12, padding: '2px 8px' }}
                onClick={() => toggleRun(run.runId)}
              >
                {run.title ?? run.runId.slice(0, 8)} · {run.status}
              </button>
            ))}
          </div>
          {selectedRunIds.length === 0 && (
            <div style={{ color: '#666', fontSize: 13, marginTop: 4 }}>{t('eventStream.allRuns')}</div>
          )}
        </div>
      )}

      {loading && <p>{t('marketplace.loading')}</p>}
      {error && <p style={{ color: '#c00' }}>{error}</p>}

      {!loading && !error && summary && (
        <div style={{ border: '1px solid #ddd', borderRadius: 8, padding: 12, marginBottom: 10 }}>
          <div>
            {t('eventStream.total', { count: summary.total })} ·{' '}
            {t('eventStream.runsCount', { count: summary.runs })} ·{' '}
            {t('eventStream.errors', { count: summary.errors })} ·{' '}
            {t('eventStream.toolCalls', { count: summary.toolCalls })} ·{' '}
            {t('eventStream.tokens', { count: summary.tokensUsed })}
          </div>
          <div style={{ marginTop: 6, fontSize: 13, color: '#555' }}>
            {Object.entries(summary.byType)
              .sort((a, b) => b[1] - a[1])
              .slice(0, 8)
              .map(([type, count]) => `${type}: ${count}`)
              .join(' · ')}
          </div>
          {buckets.length > 0 && (
            <div style={{ marginTop: 10 }}>
              {buckets.map((b) => (
                <div key={b.at} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
                  <span style={{ width: 90, color: '#666' }}>
                    {new Date(b.at).toLocaleTimeString()}
                  </span>
                  <div
                    style={{
                      height: 10,
                      width: `${maxBucket === 0 ? 0 : Math.round((b.count / maxBucket) * 100)}%`,
                      minWidth: b.count > 0 ? 4 : 0,
                      background: b.errors > 0 ? '#d33' : '#4a4',
                      borderRadius: 2,
                    }}
                  />
                  <span>
                    {b.count}
                    {b.errors > 0 ? ` (${b.errors} ${t('eventStream.errorsShort')})` : ''}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {!loading && !error && events.length === 0 && <p>{t('eventStream.noEvents')}</p>}
      {!loading &&
        !error &&
        events
          .slice(-100)
          .reverse()
          .map((event) => (
            <div key={`${event.runId}:${event.seq}`} style={{ borderBottom: '1px solid #eee', padding: '6px 0', fontSize: 13 }}>
              <strong>{event.type}</strong>{' '}
              <span style={{ color: '#666' }}>
                #{event.seq} · {event.runId.slice(0, 8)} · {new Date(event.at).toLocaleTimeString()}
              </span>
              <div style={{ color: '#555', wordBreak: 'break-word' }}>
                {JSON.stringify(event.payload).slice(0, 300)}
              </div>
            </div>
          ))}
    </div>
  );
}

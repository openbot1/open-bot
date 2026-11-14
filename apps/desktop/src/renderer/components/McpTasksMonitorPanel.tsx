/**
 * McpTasksMonitorPanel — MCP Tasks monitor (v1.06, Team T5 — UI v3).
 *
 * The existing McpTasksView lists every task in one flat list. This
 * panel adds what an operator needs while tasks run: an Active /
 * History split, a progress bar (elapsed vs the task timeout, with an
 * overdue flag), status chips, search, expandable result/error detail,
 * and cancel — all over the same `mcp-tasks:list` /
 * `mcp-tasks:cancel` IPC plus the `mcp-tasks:changed` push. Polls
 * every 5s while any task is active.
 */
import { useCallback, useEffect, useState } from 'react';
import type { McpTaskStatusView, McpTaskViewLike } from '../types';
import { useT } from '../i18n/useT';
import {
  filterMcpTasks,
  formatMcpElapsed,
  isMcpTaskActive,
  isMcpTaskOverdue,
  mcpTaskProgress,
  splitMcpTasks,
} from './mcpTasksMonitor';

interface Props {
  onBack: () => void;
}

/** Static status -> i18n key map (kept literal so the i18n key scan finds every key). */
const STATUS_KEYS: Record<McpTaskStatusView, string> = {
  working: 'mcpMonitor.status.working',
  input_required: 'mcpMonitor.status.input_required',
  completed: 'mcpMonitor.status.completed',
  failed: 'mcpMonitor.status.failed',
  cancelled: 'mcpMonitor.status.cancelled',
};

const STATUSES: McpTaskStatusView[] = ['working', 'input_required', 'completed', 'failed', 'cancelled'];

function formatResult(result: unknown): string {
  if (result === undefined) return '';
  const text = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
  return text.length > 2000 ? `${text.slice(0, 2000)}\n[…]` : text;
}

export default function McpTasksMonitorPanel({ onBack }: Props) {
  const t = useT();
  const [tasks, setTasks] = useState<McpTaskViewLike[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [tab, setTab] = useState<'active' | 'history'>('active');
  const [status, setStatus] = useState<McpTaskStatusView | 'all'>('all');
  const [query, setQuery] = useState('');
  const [expandedKey, setExpandedKey] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (typeof window.openBot.listMcpTasks !== 'function') {
      setLoading(false);
      return;
    }
    try {
      setTasks(await window.openBot.listMcpTasks());
    } catch {
      setError(t('mcpMonitor.loadError'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (typeof window.openBot.onMcpTasksChanged !== 'function') return undefined;
    return window.openBot.onMcpTasksChanged((next) => setTasks(next));
  }, []);

  useEffect(() => {
    if (!tasks.some(isMcpTaskActive)) return undefined;
    const timer = setInterval(() => {
      setNow(Date.now());
      void refresh();
    }, 5000);
    return () => clearInterval(timer);
  }, [tasks, refresh]);

  const cancelTask = async (task: McpTaskViewLike) => {
    if (typeof window.openBot.cancelMcpTask !== 'function') return;
    setBusyKey(task.key);
    setError('');
    try {
      await window.openBot.cancelMcpTask(task.workspaceDir, task.key);
      await refresh();
    } catch (err) {
      setError(t('mcpMonitor.cancelFailed', { message: (err as Error).message }));
    } finally {
      setBusyKey(null);
    }
  };

  const { active, history } = splitMcpTasks(tasks);
  const shown = filterMcpTasks(tab === 'active' ? active : history, { status, query });

  return (
    <div className="panel" data-testid="mcp-tasks-monitor">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h2>{t('mcpMonitor.title')}</h2>
        <button className="btn secondary" onClick={onBack}>
          {t('mcp.back')}
        </button>
      </div>
      <p className="hint">{t('mcpMonitor.intro')}</p>
      <div className="row" data-testid="mcp-monitor-tabs">
        <button
          className="btn secondary"
          data-testid="mcp-monitor-tab-active"
          onClick={() => setTab('active')}
          disabled={tab === 'active'}
        >
          {t('mcpMonitor.tabActive', { count: active.length })}
        </button>
        <button
          className="btn secondary"
          data-testid="mcp-monitor-tab-history"
          onClick={() => setTab('history')}
          disabled={tab === 'history'}
        >
          {t('mcpMonitor.tabHistory', { count: history.length })}
        </button>
        <button className="btn secondary" onClick={() => void refresh()} disabled={loading}>
          {loading ? t('mcpMonitor.loading') : t('mcpMonitor.refresh')}
        </button>
      </div>
      <div className="row">
        <label>
          {t('mcpMonitor.statusFilter')}
          <select
            value={status}
            onChange={(e) => setStatus(e.target.value as McpTaskStatusView | 'all')}
            data-testid="mcp-monitor-status-filter"
          >
            <option value="all">{t('mcpMonitor.statusAll')}</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {t(STATUS_KEYS[s])}
              </option>
            ))}
          </select>
        </label>
        <label style={{ flex: 1 }}>
          {t('mcpMonitor.search')}
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('mcpMonitor.searchPlaceholder')}
            data-testid="mcp-monitor-search"
          />
        </label>
      </div>
      {error !== '' && (
        <p className="error" data-testid="mcp-monitor-error">
          {error}
        </p>
      )}
      {loading ? (
        <p className="empty">{t('mcpMonitor.loading')}</p>
      ) : shown.length === 0 ? (
        <p className="empty" data-testid="mcp-monitor-empty">
          {tab === 'active' ? t('mcpMonitor.emptyActive') : t('mcpMonitor.emptyHistory')}
        </p>
      ) : (
        <ul className="task-list" data-testid="mcp-monitor-list">
          {shown.map((task) => {
            const progress = mcpTaskProgress(task, now);
            const overdue = isMcpTaskOverdue(task, now);
            const key = `${task.workspaceDir}:${task.key}`;
            const expanded = expandedKey === key;
            return (
              <li key={key}>
                <div className="row" style={{ justifyContent: 'space-between' }}>
                  <strong>{task.label}</strong>
                  <span className={`badge ${task.status}`}>{t(STATUS_KEYS[task.status])}</span>
                </div>
                <p style={{ margin: '6px 0 0', color: 'var(--text-dim)' }}>
                  {t('mcpMonitor.server', { name: task.serverName })} ·{' '}
                  {t('mcpMonitor.method', { name: task.method })} ·{' '}
                  {t('mcpMonitor.elapsed', { time: formatMcpElapsed(task, now) })} ·{' '}
                  {t('mcpMonitor.pollInterval', { ms: String(task.pollIntervalMs) })}
                </p>
                <p style={{ margin: '4px 0 0', color: 'var(--text-dim)' }}>
                  {task.timeoutMs !== undefined
                    ? t('mcpMonitor.timeout', { seconds: String(Math.round(task.timeoutMs / 1000)) })
                    : t('mcpMonitor.noTimeout')}
                  {task.timedOut ? ` · ${t('mcpMonitor.timedOut')}` : ''}
                  {overdue ? ` · ${t('mcpMonitor.overdue')}` : ''}
                </p>
                {progress !== null && (
                  <div
                    data-testid={`mcp-monitor-progress-${task.key}`}
                    role="progressbar"
                    aria-valuenow={progress}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    title={t('mcpMonitor.progress', { percent: progress })}
                    style={{
                      marginTop: 6,
                      height: 8,
                      borderRadius: 4,
                      background: 'var(--bg-dim)',
                      overflow: 'hidden',
                    }}
                  >
                    <div
                      style={{
                        width: `${progress}%`,
                        height: '100%',
                        background: overdue ? 'var(--danger, #c0392b)' : 'var(--accent, #2f7cf6)',
                      }}
                    />
                  </div>
                )}
                {task.error !== undefined && task.error !== '' && (
                  <p style={{ margin: '6px 0 0', color: 'var(--text-dim)' }}>
                    {t('mcpMonitor.error', { message: task.error })}
                  </p>
                )}
                <div className="row" style={{ marginTop: 8 }}>
                  {(task.status === 'completed' || task.error) && (
                    <button
                      className="btn secondary"
                      onClick={() => setExpandedKey(expanded ? null : key)}
                      data-testid={`mcp-monitor-details-${task.key}`}
                    >
                      {expanded ? t('mcpMonitor.hideDetails') : t('mcpMonitor.details')}
                    </button>
                  )}
                  {isMcpTaskActive(task) && (
                    <button
                      className="btn secondary"
                      onClick={() => void cancelTask(task)}
                      disabled={busyKey === task.key}
                      data-testid={`mcp-monitor-cancel-${task.key}`}
                    >
                      {t('mcpMonitor.cancel')}
                    </button>
                  )}
                </div>
                {expanded && task.status === 'completed' && task.result !== undefined && (
                  <pre
                    style={{
                      margin: '6px 0 0',
                      padding: 8,
                      background: 'var(--bg-dim)',
                      borderRadius: 6,
                      whiteSpace: 'pre-wrap',
                      wordBreak: 'break-word',
                    }}
                  >
                    {formatResult(task.result)}
                  </pre>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

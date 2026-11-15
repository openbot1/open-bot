import { useState } from 'react';
import { useT } from '../i18n/useT';

/**
 * MCP Apps + Tasks panel (v1.09, Team T3).
 *
 * One shared panel for both extensions, so the user sees at once:
 *   - Open apps (title, URI, ready state, close button).
 *   - Running tasks (label, server, 0-100% progress bar, status
 *     message, cancel button; finished tasks show a short result / error).
 *
 * Purely presentational: data comes in via props, every action goes
 * out via callbacks — the coordinator wires the real IPC
 * (`mcp-apps:list`, `mcp-tasks:list` / cancel) one layer up, the same
 * way `McpTasksView` does. That keeps the panel testable without Electron.
 */

export interface McpAppsTasksPanelApp {
  sessionId: string;
  title: string;
  uri: string;
  toolName?: string;
  serverName?: string;
  ready: boolean;
  dropped?: number;
}

export type McpAppsTasksPanelTaskStatus = 'working' | 'input_required' | 'completed' | 'failed' | 'cancelled';

export interface McpAppsTasksPanelTask {
  taskId: string;
  label: string;
  serverName: string;
  status: McpAppsTasksPanelTaskStatus;
  progress?: number;
  message?: string;
  error?: string;
  resultPreview?: string;
}

interface Props {
  apps: McpAppsTasksPanelApp[];
  tasks: McpAppsTasksPanelTask[];
  onCloseApp?: (sessionId: string) => void;
  onCancelTask?: (taskId: string) => void;
  onBack?: () => void;
}

const TASK_STATUS_KEYS: Record<McpAppsTasksPanelTaskStatus, string> = {
  working: 'mcpAppsTasks.taskStatus.working',
  input_required: 'mcpAppsTasks.taskStatus.input_required',
  completed: 'mcpAppsTasks.taskStatus.completed',
  failed: 'mcpAppsTasks.taskStatus.failed',
  cancelled: 'mcpAppsTasks.taskStatus.cancelled',
};

function isActiveTask(task: McpAppsTasksPanelTask): boolean {
  return task.status === 'working' || task.status === 'input_required';
}

export default function McpAppsTasksPanel({ apps, tasks, onCloseApp, onCancelTask, onBack }: Props) {
  const t = useT();
  const [busyTask, setBusyTask] = useState<string | null>(null);
  const activeTasks = tasks.filter(isActiveTask);
  const doneTasks = tasks.filter((task) => !isActiveTask(task));

  return (
    <section aria-label={t('mcpAppsTasks.panelTitle')}>
      <header style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        {onBack ? <button type="button" onClick={onBack}>{t('mcpAppsTasks.back')}</button> : null}
        <h2 style={{ margin: 0 }}>{t('mcpAppsTasks.panelTitle')}</h2>
        <span style={{ fontSize: 12, opacity: 0.7 }}>
          {t('mcpAppsTasks.summary', { apps: apps.length, tasks: activeTasks.length })}
        </span>
      </header>

      <h3>{t('mcpAppsTasks.appsTitle')}</h3>
      {apps.length === 0 ? (
        <p>{t('mcpAppsTasks.appsEmpty')}</p>
      ) : (
        <ul>
          {apps.map((app) => (
            <li key={app.sessionId} style={{ marginBottom: 6 }}>
              <strong>{app.title}</strong>{' '}
              <span style={{ fontSize: 12, opacity: 0.7 }}>
                {app.uri}
                {app.serverName ? ` · ${app.serverName}` : ''}
                {app.toolName ? ` · ${app.toolName}` : ''}
                {' · '}
                {app.ready ? t('mcpAppsTasks.appReady') : t('mcpAppsTasks.appLoading')}
                {app.dropped ? ` · ${t('mcpAppsTasks.droppedMessages', { count: app.dropped })}` : ''}
              </span>{' '}
              <button type="button" onClick={() => onCloseApp?.(app.sessionId)}>
                {t('mcpAppsTasks.close')}
              </button>
            </li>
          ))}
        </ul>
      )}

      <h3>{t('mcpAppsTasks.tasksTitle')}</h3>
      {tasks.length === 0 ? (
        <p>{t('mcpAppsTasks.tasksEmpty')}</p>
      ) : (
        <ul>
          {[...activeTasks, ...doneTasks].map((task) => {
            const pct =
              task.progress !== undefined ? Math.max(0, Math.min(100, Math.round(task.progress))) : undefined;
            return (
              <li key={task.taskId} style={{ marginBottom: 10 }}>
                <div>
                  <strong>{task.label}</strong>{' '}
                  <span style={{ fontSize: 12, opacity: 0.7 }}>
                    {task.serverName} · {t(TASK_STATUS_KEYS[task.status])}
                    {task.message ? ` · ${task.message}` : ''}
                  </span>{' '}
                  {isActiveTask(task) ? (
                    <button
                      type="button"
                      disabled={busyTask === task.taskId}
                      onClick={() => {
                        setBusyTask(task.taskId);
                        onCancelTask?.(task.taskId);
                        setBusyTask(null);
                      }}
                    >
                      {t('mcpAppsTasks.cancel')}
                    </button>
                  ) : null}
                </div>
                {pct !== undefined ? (
                  <div
                    role="progressbar"
                    aria-valuenow={pct}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-label={task.label}
                    style={{ height: 8, background: '#eee', borderRadius: 4, overflow: 'hidden', marginTop: 4 }}
                  >
                    <div style={{ width: `${pct}%`, height: '100%', background: task.status === 'failed' ? '#c0392b' : '#2e7d32' }} />
                  </div>
                ) : null}
                {pct !== undefined ? <div style={{ fontSize: 12 }}>{pct}%</div> : null}
                {task.status === 'failed' && task.error ? (
                  <p role="alert" style={{ margin: '4px 0 0', color: '#c0392b' }}>{task.error}</p>
                ) : null}
                {task.status === 'completed' && task.resultPreview ? (
                  <pre style={{ margin: '4px 0 0', whiteSpace: 'pre-wrap', fontSize: 12 }}>{task.resultPreview}</pre>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

import { useCallback, useEffect, useState } from 'react';
import type { TeamV2Dashboard } from '@open-bot/core';
import { useT } from '../i18n/useT';

/**
 * Agent Teams v2 - dashboard (v1.10, Team T3).
 *
 * Team board v2: team list + detail of the selected team - teammates
 * (status, current task, session open/closed, assigned tasks),
 * task list, disk locks (who holds what, lease until when, stale or
 * not), token-cost estimate + warnings, fork subagents, newest disk
 * mailbox messages, reviewer feedback, activity log.
 *
 * Data is read over IPC `agent-teams-v2:dashboard` (read-only -
 * teams are created and tasks claimed by agents through the
 * teams_v2_* tools); when IPC is unavailable (running outside
 * Electron) it shows the empty state instead of crashing.
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

export default function AgentTeamsV2View({ onBack }: Props) {
  const t = useT();
  const [dashboards, setDashboards] = useState<TeamV2Dashboard[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const list = await callOpenBot<TeamV2Dashboard[]>(
        'agent-teams-v2:dashboard',
        'agentTeamsV2Dashboard',
      );
      const next = list ?? [];
      setDashboards(next);
      if (next.length > 0 && !next.some((d) => d.teamId === selectedId)) {
        setSelectedId(next[0].teamId);
      } else if (next.length === 0) {
        setSelectedId(null);
      }
    } catch {
      setError(t('teamsV2.loadError'));
    } finally {
      setLoading(false);
    }
  }, [selectedId, t]);

  useEffect(() => {
    void load();
  }, [load]);

  const selected = dashboards.find((d) => d.teamId === selectedId) ?? null;
  const teammateName = (id?: string): string => {
    if (!id) return t('teamsV109.unclaimed');
    return selected?.teammates.find((m) => m.id === id)?.name ?? id;
  };

  return (
    <div>
      <button type="button" onClick={onBack}>
        {t('teamsV2.back')}
      </button>
      <h2>{t('teamsV2.title')}</h2>
      <button type="button" onClick={() => void load()} disabled={loading}>
        {t('teamsV2.refresh')}
      </button>
      {loading ? (
        <p>{t('teamsV2.loading')}</p>
      ) : error ? (
        <p>{error}</p>
      ) : dashboards.length === 0 ? (
        <div>
          <p>{t('teamsV2.empty')}</p>
          <p>{t('teamsV2.emptyHint')}</p>
        </div>
      ) : (
        <div>
          <p>{t('teamsV2.teamsCount', { count: dashboards.length })}</p>
          <ul>
            {dashboards.map((d) => (
              <li key={d.teamId}>
                <button type="button" onClick={() => setSelectedId(d.teamId)}>
                  {d.teamName} — {d.status} —{' '}
                  {t('teamsV2.tasksDone', {
                    done: d.tasks.filter((task) => task.status === 'done').length,
                    total: d.tasks.length,
                  })}{' '}
                  — {t('teamsV109.lead')}: {d.leadName} — {d.cost.estimatedTokens}{' '}
                  {t('teamsV2.tokens')}
                </button>
              </li>
            ))}
          </ul>
          {selected && (
            <section>
              <h3>{selected.teamName}</h3>
              <p>
                {t('teamsV2.goal')}: {selected.goal}
              </p>
              <p>
                {t('teamsV2.status')}: {selected.status} —{' '}
                {t('teamsV2.tasksDone', {
                  done: selected.tasks.filter((task) => task.status === 'done').length,
                  total: selected.tasks.length,
                })}
              </p>

              <h4>
                {t('teamsV2.cost')}: {t('teamsV2.costEstimate')}{' '}
                {selected.cost.estimatedTokens.toLocaleString('en-US')} /{' '}
                {selected.cost.budget.toLocaleString('en-US')} {t('teamsV2.tokens')} (
                {Math.round(selected.cost.usageRatio * 100)}% — {selected.cost.level})
              </h4>
              {selected.cost.warnings.length > 0 && (
                <ul>
                  {selected.cost.warnings.map((w) => (
                    <li key={w}>⚠️ {w}</li>
                  ))}
                </ul>
              )}
              {selected.sizeCheck.warnings.length > 0 && (
                <ul>
                  {selected.sizeCheck.warnings.map((w) => (
                    <li key={w}>
                      ⚠️ {t('teamsV2.sizeWarning')}: {w}
                    </li>
                  ))}
                </ul>
              )}

              <h4>{t('teamsV2.teammates')}</h4>
              <table>
                <thead>
                  <tr>
                    <th>{t('teamsV2.name')}</th>
                    <th>{t('teamsV2.role')}</th>
                    <th>{t('teamsV2.status')}</th>
                    <th>{t('teamsV2.currentTask')}</th>
                    <th>{t('teamsV2.session')}</th>
                    <th>{t('teamsV2.assigned')}</th>
                    <th>{t('teamsV2.results')}</th>
                  </tr>
                </thead>
                <tbody>
                  {selected.teammates.map((m) => (
                    <tr key={m.id}>
                      <td>
                        {m.name}
                        {m.specialty ? ` (${m.specialty})` : ''}
                      </td>
                      <td>{m.role}</td>
                      <td>{m.status}</td>
                      <td>{m.currentTaskTitle ?? '—'}</td>
                      <td>{m.sessionOpen ? t('teamsV2.sessionOpen') : t('teamsV2.sessionClosed')}</td>
                      <td>{m.assignedTaskIds.length}</td>
                      <td>
                        {t('teamsV109.doneCount', { done: m.tasksDone })} /{' '}
                        {t('teamsV109.failedCount', { failed: m.tasksFailed })}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>

              <h4>{t('teamsV2.tasks')}</h4>
              {selected.tasks.length === 0 ? (
                <p>{t('teamsV2.noTasks')}</p>
              ) : (
                <ul>
                  {selected.tasks.map((task) => (
                    <li key={task.id}>
                      {task.title} — {task.status} — {t('teamsV2.priority')}: {task.priority}
                      {task.dependsOn.length > 0
                        ? ` — ${t('teamsV2.dependsOn')}: ${task.dependsOn.join(', ')}`
                        : ''}
                      {` — ${t('teamsV2.claimedBy')}: ${teammateName(task.claimedBy)}`}
                      {task.status === 'pending' &&
                      task.dependsOn.every(
                        (dep) => selected.tasks.find((x) => x.id === dep)?.status === 'done',
                      )
                        ? ` (${t('teamsV2.ready')})`
                        : ''}
                      {task.resultSummary ? ` — ${task.resultSummary}` : ''}
                      {task.error ? ` — ${task.error}` : ''}
                    </li>
                  ))}
                </ul>
              )}

              <h4>{t('teamsV2.locks')}</h4>
              {selected.locks.length === 0 ? (
                <p>{t('teamsV2.noLocks')}</p>
              ) : (
                <ul>
                  {selected.locks.map((lock) => (
                    <li key={lock.taskId}>
                      “{lock.taskTitle}” — {lock.ownerName} — {t('teamsV2.leaseUntil')}:{' '}
                      {new Date(lock.leaseUntil).toLocaleString()}
                      {lock.stale ? ` (${t('teamsV2.lockStale')})` : ''}
                    </li>
                  ))}
                </ul>
              )}

              <h4>{t('teamsV2.forks')}</h4>
              {selected.forks.length === 0 ? (
                <p>{t('teamsV2.noForks')}</p>
              ) : (
                <ul>
                  {selected.forks.map((fork) => (
                    <li key={fork.id}>
                      {fork.name} — {t('teamsV2.forkDepth', { depth: fork.depth })} — {fork.status}
                      {fork.merged ? ` (${t('teamsV2.merged')})` : ''} — {fork.task}
                      {fork.resultSummary ? ` — ${fork.resultSummary}` : ''}
                      {fork.artifacts.length > 0 ? ` — ${fork.artifacts.join(', ')}` : ''}
                    </li>
                  ))}
                </ul>
              )}

              <h4>
                {t('teamsV2.mailbox')} ({selected.recentMessages.length})
              </h4>
              {selected.recentMessages.length === 0 ? (
                <p>{t('teamsV2.noMessages')}</p>
              ) : (
                <ul>
                  {selected.recentMessages.map((m) => (
                    <li key={m.id}>
                      [{m.kind}] {t('teamsV2.from')}: {m.fromName} →{' '}
                      {m.toName === '*' ? '★' : m.toName}: {m.body}
                      {m.read ? '' : ` (${t('teamsV2.unread')})`}
                    </li>
                  ))}
                </ul>
              )}

              <h4>{t('teamsV2.reviewFeedback')}</h4>
              {selected.reviewFeedback.length === 0 ? (
                <p>{t('teamsV2.noFeedback')}</p>
              ) : (
                <ul>
                  {selected.reviewFeedback.map((review) => (
                    <li key={review.taskId}>
                      {review.taskId}: {review.feedback} ({review.reviewer})
                    </li>
                  ))}
                </ul>
              )}

              <h4>{t('teamsV2.activityLog')}</h4>
              {selected.events.length === 0 ? (
                <p>{t('teamsV2.noEvents')}</p>
              ) : (
                <ul>
                  {selected.events.slice(-20).map((e, i) => (
                    <li key={`${e.at}-${i}`}>
                      {new Date(e.at).toLocaleString()} [{e.type}] {e.message}
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}
        </div>
      )}
    </div>
  );
}

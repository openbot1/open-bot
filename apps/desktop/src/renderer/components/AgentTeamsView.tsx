import { useCallback, useEffect, useState } from 'react';
import type { AgentTeamV109, TeamV109Summary } from '@open-bot/core';
import { useT } from '../i18n/useT';

/**
 * Agent Teams v1 — team tracking view (v1.09, Team T1).
 *
 * Team board: team list (lead, status, tasks done/total, idle vs
 * working teammates, unread messages) + detail of the selected team
 * (each teammate's status, task list by status, mailbox, file
 * conflicts). Data is read over IPC `agent-teams-v109:*` (read-only
 * — teams are created and tasks claimed by agents through the team_*
 * tools); when IPC is unavailable (running outside Electron) it
 * shows the empty state instead of crashing.
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

/** Task ready to claim: pending + every dependency done. */
function isReady(team: AgentTeamV109, taskId: string): boolean {
  const task = team.tasks.find((t) => t.id === taskId);
  if (!task || task.status !== 'pending') return false;
  if (task.attempts >= task.maxAttempts) return false;
  return task.dependsOn.every((dep) => team.tasks.find((t) => t.id === dep)?.status === 'done');
}

/** File conflict: two active tasks touching the same file. */
function findConflicts(team: AgentTeamV109): { file: string; teammateIds: string[] }[] {
  const byFile = new Map<string, Set<string>>();
  for (const task of team.tasks) {
    if (task.status !== 'claimed' && task.status !== 'in-progress') continue;
    if (!task.claimedBy) continue;
    for (const file of task.touchesFiles) {
      const set = byFile.get(file) ?? new Set<string>();
      set.add(task.claimedBy);
      byFile.set(file, set);
    }
  }
  return [...byFile.entries()]
    .filter(([, mates]) => mates.size > 1)
    .map(([file, mates]) => ({ file, teammateIds: [...mates] }));
}

/** Unanswered question: a question to the lead with no result reply yet. */
function countUnanswered(team: AgentTeamV109): number {
  return team.messages.filter((q) => {
    if (q.kind !== 'question') return false;
    return !team.messages.some(
      (m) =>
        m.createdAt >= q.createdAt &&
        m.id !== q.id &&
        (m.toId === q.fromId || m.toId === '*') &&
        m.kind === 'result' &&
        (m.taskId === q.taskId || !q.taskId),
    );
  }).length;
}

export default function AgentTeamsView({ onBack }: Props) {
  const t = useT();
  const [teams, setTeams] = useState<TeamV109Summary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<AgentTeamV109 | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const list = await callOpenBot<TeamV109Summary[]>(
        'agent-teams-v109:list',
        'agentTeamsV109List',
      );
      const next = list ?? [];
      setTeams(next);
      if (next.length > 0 && !next.some((s) => s.id === selectedId)) {
        setSelectedId(next[0].id);
      } else if (next.length === 0) {
        setSelectedId(null);
        setDetail(null);
      }
    } catch {
      setError(t('teamsV109.loadError'));
    } finally {
      setLoading(false);
    }
  }, [selectedId, t]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    void callOpenBot<AgentTeamV109>(
      'agent-teams-v109:status',
      'agentTeamsV109Status',
      selectedId,
    ).then((d) => {
      if (!cancelled) setDetail(d);
    });
    return () => {
      cancelled = true;
    };
  }, [selectedId, teams]);

  const selected = teams.find((s) => s.id === selectedId) ?? null;
  const teammateName = (id?: string): string => {
    if (!id) return t('teamsV109.unclaimed');
    return detail?.teammates.find((m) => m.id === id)?.name ?? id;
  };
  const conflicts = detail ? findConflicts(detail) : [];
  const unanswered = detail ? countUnanswered(detail) : 0;

  return (
    <div>
      <button type="button" onClick={onBack}>
        {t('teamsV109.back')}
      </button>
      <h2>{t('teamsV109.title')}</h2>
      <button type="button" onClick={() => void load()} disabled={loading}>
        {t('teamsV109.refresh')}
      </button>
      {loading ? (
        <p>{t('teamsV109.loading')}</p>
      ) : error ? (
        <p>{error}</p>
      ) : teams.length === 0 ? (
        <div>
          <p>{t('teamsV109.empty')}</p>
          <p>{t('teamsV109.emptyHint')}</p>
        </div>
      ) : (
        <div>
          <p>{t('teamsV109.teamsCount', { count: teams.length })}</p>
          <ul>
            {teams.map((s) => (
              <li key={s.id}>
                <button type="button" onClick={() => setSelectedId(s.id)}>
                  {s.name} — {s.status} —{' '}
                  {t('teamsV109.tasksDone', { done: s.tasksDone, total: s.tasksTotal })} —{' '}
                  {t('teamsV109.lead')}: {s.leadName} — {s.unreadMessages}{' '}
                  {t('teamsV109.unread')}
                </button>
              </li>
            ))}
          </ul>
          {selected && (
            <section>
              <h3>{selected.name}</h3>
              <p>
                {t('teamsV109.goal')}: {selected.goal}
              </p>
              <p>
                {t('teamsV109.status')}: {selected.status} —{' '}
                {t('teamsV109.tasksDone', { done: selected.tasksDone, total: selected.tasksTotal })}
              </p>
              {!detail ? (
                <p>{t('teamsV109.loading')}</p>
              ) : (
                <div>
                  <h4>{t('teamsV109.teammates')}</h4>
                  <table>
                    <thead>
                      <tr>
                        <th>{t('teamsV109.name')}</th>
                        <th>{t('teamsV109.role')}</th>
                        <th>{t('teamsV109.status')}</th>
                        <th>{t('teamsV109.currentTask')}</th>
                        <th>{t('teamsV109.partition')}</th>
                        <th>{t('teamsV109.results')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {detail.teammates.map((m) => (
                        <tr key={m.id}>
                          <td>
                            {m.name}
                            {m.specialty ? ` (${m.specialty})` : ''}
                          </td>
                          <td>{m.role}</td>
                          <td>{m.status}</td>
                          <td>
                            {m.currentTaskId
                              ? detail.tasks.find((task) => task.id === m.currentTaskId)?.title ?? m.currentTaskId
                              : '—'}
                          </td>
                          <td>{m.partition ?? m.worktreePath ?? '—'}</td>
                          <td>
                            {t('teamsV109.doneCount', { done: m.tasksDone })} /{' '}
                            {t('teamsV109.failedCount', { failed: m.tasksFailed })}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>

                  <h4>{t('teamsV109.tasks')}</h4>
                  {detail.tasks.length === 0 ? (
                    <p>{t('teamsV109.noTasks')}</p>
                  ) : (
                    <ul>
                      {detail.tasks.map((task) => (
                        <li key={task.id}>
                          {task.title} — {task.status} — {t('teamsV109.priority')}: {task.priority}
                          {task.dependsOn.length > 0
                            ? ` — ${t('teamsV109.dependsOn')}: ${task.dependsOn.join(', ')}`
                            : ''}
                          {` — ${t('teamsV109.claimedBy')}: ${teammateName(task.claimedBy)}`}
                          {isReady(detail, task.id) ? ` (${t('teamsV109.ready')})` : ''}
                          {task.resultSummary ? ` — ${task.resultSummary}` : ''}
                          {task.error ? ` — ${task.error}` : ''}
                        </li>
                      ))}
                    </ul>
                  )}

                  <h4>{t('teamsV109.conflicts')}</h4>
                  {conflicts.length === 0 ? (
                    <p>{t('teamsV109.noConflicts')}</p>
                  ) : (
                    <ul>
                      {conflicts.map((c) => (
                        <li key={c.file}>
                          {c.file} — {c.teammateIds.join(', ')}
                        </li>
                      ))}
                    </ul>
                  )}

                  <h4>
                    {t('teamsV109.mailbox')} ({detail.messages.length})
                  </h4>
                  {unanswered > 0 && (
                    <p>
                      {t('teamsV109.unanswered')}: {unanswered}
                    </p>
                  )}
                  {detail.messages.length === 0 ? (
                    <p>{t('teamsV109.noMessages')}</p>
                  ) : (
                    <ul>
                      {detail.messages.slice(-20).map((m) => (
                        <li key={m.id}>
                          [{m.kind}] {t('teamsV109.from')}: {m.fromName} →{' '}
                          {m.toId === '*' ? '★' : teammateName(m.toId)}: {m.body}
                          {m.read ? '' : ` (${t('teamsV109.unread')})`}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </section>
          )}
        </div>
      )}
    </div>
  );
}

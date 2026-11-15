import { useCallback, useEffect, useState } from 'react';
import type { TeamV3Dashboard } from '@open-bot/core';
import { useT } from '../i18n/useT';

/**
 * Agent Teams v3 - dashboard (v1.11, Team T3).
 *
 * Team board v3: team list + detail of the selected team - lead mode
 * (delegate/implement) + lead status board, dependency waves, teammate
 * panes in tmux style (one pane per teammate, watch their log/output
 * directly), challenges between teammates, team conversation log,
 * linear token-cost warning (shown before creating a team), agent-view
 * background sessions.
 *
 * Data is read over IPC `agent-teams-v3:dashboard` (read-only -
 * teams are created and tasks claimed by agents through the
 * teams_v3_* tools); when IPC is unavailable (running outside
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

export default function AgentTeamsV3View({ onBack }: Props) {
  const t = useT();
  const [dashboards, setDashboards] = useState<TeamV3Dashboard[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const list = await callOpenBot<TeamV3Dashboard[]>(
        'agent-teams-v3:dashboard',
        'agentTeamsV3Dashboard',
      );
      const next = list ?? [];
      setDashboards(next);
      if (next.length > 0 && !next.some((d) => d.teamId === selectedId)) {
        setSelectedId(next[0].teamId);
      } else if (next.length === 0) {
        setSelectedId(null);
      }
    } catch {
      setError(t('teamsV3.loadError'));
    } finally {
      setLoading(false);
    }
  }, [selectedId, t]);

  useEffect(() => {
    void load();
  }, [load]);

  const selected = dashboards.find((d) => d.teamId === selectedId) ?? null;

  return (
    <div>
      <button type="button" onClick={onBack}>
        {t('teamsV3.back')}
      </button>
      <h2>{t('teamsV3.title')}</h2>
      <button type="button" onClick={() => void load()} disabled={loading}>
        {t('teamsV3.refresh')}
      </button>
      {loading ? (
        <p>{t('teamsV3.loading')}</p>
      ) : error ? (
        <p>{error}</p>
      ) : dashboards.length === 0 ? (
        <div>
          <p>{t('teamsV3.empty')}</p>
          <p>{t('teamsV3.emptyHint')}</p>
          <p>
            {t('teamsV3.costWarning')} {t('teamsV3.oneTeamPerSession')} {t('teamsV3.noSubTeams')}
          </p>
        </div>
      ) : (
        <div>
          <div>
            {dashboards.map((d) => (
              <button
                key={d.teamId}
                type="button"
                onClick={() => setSelectedId(d.teamId)}
                disabled={d.teamId === selectedId}
              >
                {d.teamName} ({d.status})
              </button>
            ))}
          </div>
          {selected && (
            <div>
              <h3>
                {selected.teamName} — {selected.goal}
              </h3>
              <p>
                {t('teamsV3.leadMode')}:{' '}
                {selected.leadMode === 'delegate' ? t('teamsV3.delegateMode') : t('teamsV3.implementMode')}.{' '}
                {t('teamsV3.switchModeHint')}
              </p>
              <p>
                {t('teamsV3.costLinear')}: {t('teamsV3.costTotal')}{' '}
                {selected.cost.estimatedTokens.toLocaleString('en-US')} token ({t('teamsV3.costEstimate')}), x
                {selected.cost.multiplier} — {t('teamsV3.costWarning')}
              </p>
              {selected.cost.warnings.map((w) => (
                <p key={w}>{w}</p>
              ))}
              {selected.sizeWarnings.map((w) => (
                <p key={w}>{w}</p>
              ))}

              <h4>
                {t('teamsV3.teammateStatus')} ({selected.leadBoard.length})
              </h4>
              <ul>
                {selected.leadBoard.map((b) => (
                  <li key={b.id}>
                    {b.name} ({b.role === 'lead' ? 'lead' : b.status})
                    {b.currentTaskTitle ? ` — ${b.currentTaskTitle}` : ''}
                    {b.currentWave !== undefined ? ` — ${t('teamsV3.wave')} ${b.currentWave + 1}` : ''}
                    {b.unreadMessages > 0 ? ` — ${b.unreadMessages} ${t('teamsV2.unread')}` : ''}
                    {b.openChallenges > 0 ? ` — ${b.openChallenges} ${t('teamsV3.challenge')}` : ''}
                  </li>
                ))}
              </ul>

              <h4>
                {t('teamsV3.waves')} — {t('teamsV3.currentWave')} {selected.currentWaveIndex + 1}/
                {selected.waves.length}
              </h4>
              <ul>
                {selected.waves.map((w) => (
                  <li key={w.index}>
                    {t('teamsV3.wave')} {w.index + 1}: {w.status} — {w.closedCount}/{w.taskIds.length}{' '}
                    {t('teamsV3.lifecycle')} closed
                    {w.claimable ? ` — ${t('teamsV3.waveReady')}` : ` — ${t('teamsV3.waveBlocked')}`}
                  </li>
                ))}
              </ul>

              <h4>
                {t('teamsV3.panes')} ({selected.paneGrid.rows}x{selected.paneGrid.cols})
              </h4>
              <div>
                {selected.panes.map((pane) => (
                  <div key={pane.teammateId}>
                    <strong>
                      [{pane.row},{pane.col}] {pane.name}
                    </strong>{' '}
                    ({pane.role === 'lead' ? 'lead' : pane.status})
                    {pane.currentTaskTitle ? ` — ${pane.currentTaskTitle}` : ''}
                    {pane.logLines.length > 0 && (
                      <pre>{pane.logLines.slice(-5).map((l) => l.line).join('\n')}</pre>
                    )}
                  </div>
                ))}
              </div>

              <h4>
                {t('teamsV3.challenges')} — {selected.challengeSummary}
              </h4>
              <ul>
                {selected.challenges.map((c) => (
                  <li key={c.id}>
                    {c.challengerName} → {c.targetName} ({c.taskTitle}): {c.body} —{' '}
                    {c.status === 'resolved' ? t('teamsV3.challengeResolved') : t('teamsV3.challengeOpen')}
                  </li>
                ))}
              </ul>

              <h4>{t('teamsV2.activityLog')}</h4>
              <ul>
                {selected.conversation.slice(-10).map((entry, i) => (
                  <li key={`${entry.at}-${i}`}>
                    {new Date(entry.at).toLocaleString()} [{entry.kind}] {entry.fromName}: {entry.body}
                  </li>
                ))}
              </ul>

              <h4>{t('teamsV3.agentView')}</h4>
              <ul>
                {selected.backgroundSessions.map((s) => (
                  <li key={s.sessionId}>
                    {s.sessionId} → {s.teamName} ({s.status}) — {t('teamsV3.wave')}{' '}
                    {s.currentWave + 1}/{s.totalWaves}, {s.tasksDone}/{s.tasksTotal} task
                  </li>
                ))}
              </ul>
              <p>
                {t('teamsV3.oneTeamPerSession')} {t('teamsV3.noSubTeams')}
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

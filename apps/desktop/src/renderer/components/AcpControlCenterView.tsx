import { useCallback, useEffect, useState } from 'react';
import type {
  AcpControlAgentView,
  AcpControlBudgetView,
  AcpControlDiscoveredView,
  AcpControlReportView,
  AcpControlSnapshot,
  AcpControlTurnView,
} from '../types';
import { useT } from '../i18n/useT';

/**
 * ACP Control Center view (v1.12, Team T4) — managed external CLI
 * agents (Claude Code, Codex, Gemini CLI, OpenCode, ...).
 *
 * Data flows over IPC `acp-control:*` (main.ts -> AcpControlCenter
 * in the main process, state under <userData>/acp-control). Outside
 * desktop (no IPC) it receives `snapshot` via props — the component
 * never guesses numbers and never shows fake agents.
 *
 * Nothing here spawns a process directly: Start/Stop/Register go
 * through the main-process center, which spawns the CLI binary with
 * that CLI's own login. Budgets are enforced by the center before
 * every turn; this view only displays the evaluation it returns.
 */

/** Call a window.openBot method by IPC channel, falling back to camelCase. */
async function callOpenBot<T>(channel: string, camel: string, ...args: unknown[]): Promise<T | null> {
  const api = window.openBot as unknown as Record<string, unknown>;
  const fn = api[channel] ?? api[camel];
  if (typeof fn !== 'function') return null;
  return (fn as (...a: unknown[]) => Promise<T>).apply(window.openBot, args);
}

function formatCost(costUsd: number | null): string {
  return costUsd === null ? '—' : `$${costUsd.toFixed(4)}`;
}

function formatWallMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  if (minutes < 60) return `${minutes}m ${totalSeconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function alertKindLabel(t: (key: string) => string, kind: string): string {
  if (kind === 'exceeded') return t('acpControl.alertExceeded');
  if (kind === 'blocked') return t('acpControl.alertBlocked');
  return t('acpControl.alertWarned');
}
function statusLabel(t: (key: string) => string, status: string): string {
  if (status === 'starting') return t('acpControl.statusStarting');
  if (status === 'running') return t('acpControl.statusRunning');
  if (status === 'stopped') return t('acpControl.statusStopped');
  if (status === 'error') return t('acpControl.statusError');
  if (status === 'blocked') return t('acpControl.statusBlocked');
  return t('acpControl.statusRegistered');
}

function budgetCapText(budget: AcpControlBudgetView): string {
  const parts: string[] = [];
  if (budget.maxTokensPerDay !== undefined) parts.push(`≤ ${budget.maxTokensPerDay} tok/day`);
  if (budget.maxCostUsdPerDay !== undefined) parts.push(`≤ $${budget.maxCostUsdPerDay}/day`);
  if (budget.maxCallsPerDay !== undefined) parts.push(`≤ ${budget.maxCallsPerDay} calls/day`);
  if (budget.maxWallMsPerDay !== undefined) parts.push(`≤ ${formatWallMs(budget.maxWallMsPerDay)}/day`);
  return parts.join(' · ');
}

function percentBar(fraction: number | null): { width: string; color: string } {
  if (fraction === null) return { width: '0%', color: '#888' };
  const pct = Math.min(100, Math.round(fraction * 100));
  return {
    width: `${pct}%`,
    color: fraction >= 1 ? '#c0392b' : fraction >= 0.8 ? '#e67e22' : '#27ae60',
  };
}

export default function AcpControlCenterView({
  snapshot: snapshotProp,
  onBack,
}: {
  snapshot?: AcpControlSnapshot | null;
  onBack: () => void;
}) {
  const t = useT();
  const [snapshot, setSnapshot] = useState<AcpControlSnapshot | null>(snapshotProp ?? null);
  const [discovered, setDiscovered] = useState<AcpControlDiscoveredView[]>([]);
  const [loading, setLoading] = useState(!snapshotProp);
  const [discovering, setDiscovering] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [budgetEditor, setBudgetEditor] = useState<string | null>(null);
  const [budgetForm, setBudgetForm] = useState({ maxTokensPerDay: '', maxCostUsdPerDay: '', maxCallsPerDay: '', maxWallMsPerDay: '' });
  const [history, setHistory] = useState<Record<string, AcpControlTurnView[]>>({});
  const [reports, setReports] = useState<Record<string, AcpControlReportView>>({});

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await callOpenBot<AcpControlSnapshot>('acp-control:list', 'getAcpControlSnapshot');
      if (data) setSnapshot(data);
      else setError(t('acpControl.loadError'));
    } catch (err) {
      setError((err as Error).message || t('acpControl.loadError'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    if (!snapshotProp) void load();
  }, [snapshotProp, load]);

  const discover = useCallback(async () => {
    setDiscovering(true);
    setError(null);
    try {
      const found = await callOpenBot<AcpControlDiscoveredView[]>('acp-control:discover', 'discoverAcpControlAgents', { probeAcp: false });
      if (found) setDiscovered(found);
      else setError(t('acpControl.loadError'));
    } catch (err) {
      setError((err as Error).message || t('acpControl.loadError'));
    } finally {
      setDiscovering(false);
    }
  }, [t]);

  const runAction = useCallback(
    async (agentId: string, channel: string, camel: string, ...args: unknown[]) => {
      setBusy(agentId);
      setError(null);
      try {
        await callOpenBot(channel, camel, ...args);
        await load();
      } catch (err) {
        setError((err as Error).message || t('acpControl.actionError'));
      } finally {
        setBusy(null);
      }
    },
    [load, t],
  );

  const openBudgetEditor = (agent: AcpControlAgentView) => {
    setBudgetEditor(agent.id);
    setBudgetForm({
      maxTokensPerDay: agent.budget.maxTokensPerDay?.toString() ?? '',
      maxCostUsdPerDay: agent.budget.maxCostUsdPerDay?.toString() ?? '',
      maxCallsPerDay: agent.budget.maxCallsPerDay?.toString() ?? '',
      maxWallMsPerDay: agent.budget.maxWallMsPerDay?.toString() ?? '',
    });
  };

  const saveBudget = async (agentId: string) => {
    const parse = (raw: string): number | undefined => {
      const trimmed = raw.trim();
      if (trimmed === '') return undefined;
      const n = Number(trimmed);
      return Number.isFinite(n) ? n : undefined;
    };
    const budget: AcpControlBudgetView = {
      maxTokensPerDay: parse(budgetForm.maxTokensPerDay),
      maxCostUsdPerDay: parse(budgetForm.maxCostUsdPerDay),
      maxCallsPerDay: parse(budgetForm.maxCallsPerDay),
      maxWallMsPerDay: parse(budgetForm.maxWallMsPerDay),
    };
    setBusy(agentId);
    setError(null);
    try {
      await callOpenBot('acp-control:set-budget', 'setAcpControlBudget', { agentId, budget });
      setBudgetEditor(null);
      await load();
    } catch (err) {
      setError((err as Error).message || t('acpControl.actionError'));
    } finally {
      setBusy(null);
    }
  };

  const loadHistory = async (agentId: string) => {
    try {
      const turns = await callOpenBot<AcpControlTurnView[]>('acp-control:usage', 'getAcpControlUsage', agentId);
      if (turns) setHistory((prev) => ({ ...prev, [agentId]: turns }));
    } catch {
      // History is advisory; a failure must not break the panel.
    }
  };

  const loadReport = async (agentId: string) => {
    try {
      const report = await callOpenBot<AcpControlReportView>('acp-control:report', 'getAcpControlReport', agentId, 7);
      if (report) setReports((prev) => ({ ...prev, [agentId]: report }));
    } catch {
      // Report is advisory; a failure must not break the panel.
    }
  };

  const agents = snapshot?.agents ?? [];

  return (
    <div className="acp-control-view">
      <div className="view-header">
        <button type="button" onClick={onBack}>←</button>
        <h2>{t('acpControl.title')}</h2>
        <button type="button" onClick={() => void load()} disabled={loading}>
          {t('acpControl.refresh')}
        </button>
        <button type="button" onClick={() => void discover()} disabled={discovering}>
          {discovering ? t('acpControl.discovering') : t('acpControl.discover')}
        </button>
      </div>
      <p className="view-subtitle">{t('acpControl.subtitle')}</p>
      {error && <div className="error-banner">{error}</div>}
      {loading && <p>{t('acpControl.refresh')}…</p>}

      {snapshot && (
        <p className="acp-control-totals">
          {t('acpControl.usageToday')}: {snapshot.today.totalTokens} {t('acpControl.tokens')}, {formatCost(snapshot.today.costUsd)}, {snapshot.today.calls} {t('acpControl.calls')}
          {' · '}
          {t('acpControl.usageTotal')}: {snapshot.total.totalTokens} {t('acpControl.tokens')}, {formatCost(snapshot.total.costUsd)}, {snapshot.total.calls} {t('acpControl.calls')}
        </p>
      )}

      {agents.length === 0 && !loading && (
        <div className="empty-state">
          <p>{t('acpControl.noAgents')}</p>
          <p>{t('acpControl.noAgentsHint')}</p>
        </div>
      )}

      {agents.map((agent) => (
        <section key={agent.id} className="acp-control-agent">
          <div className="acp-control-agent-head">
            <strong>{agent.name}</strong>
            <span className={`status-badge status-${agent.status}`}>{statusLabel(t, agent.status)}</span>
            <span>{agent.enabled ? t('acpControl.enabled') : t('acpControl.disabled')}</span>
            <span>
              {t('acpControl.loginLabel')}: {agent.loggedIn ? `${t('acpControl.loggedIn')}${agent.loginLabel ? ` (${agent.loginLabel})` : ''}` : t('acpControl.notLoggedIn')}
            </span>
            {agent.agentVersion && <span>v{agent.agentVersion}</span>}
          </div>
          {agent.lastError && <p className="acp-control-error">{agent.lastError}</p>}
          {agent.blocked && <p className="acp-control-blocked">{t('acpControl.blockedReason', { reasons: agent.reasons.join('; ') })}</p>}

          <div className="acp-control-usage">
            <span>
              {t('acpControl.usageToday')}: {agent.today.totalTokens} {t('acpControl.tokens')}, {formatCost(agent.today.costUsd)}, {agent.today.calls} {t('acpControl.calls')}, {formatWallMs(agent.today.wallMs)}
            </span>
            <span>
              {t('acpControl.usageTotal')}: {agent.total.totalTokens} {t('acpControl.tokens')}, {formatCost(agent.total.costUsd)}, {agent.total.calls} {t('acpControl.calls')}
            </span>
          </div>

          <div className="acp-control-budget">
            <strong>{t('acpControl.budgetCaps')}: </strong>
            <span>{budgetCapText(agent.budget) || '—'}</span>
            {agent.dimensions
              .filter((d) => d.limit !== undefined)
              .map((d) => {
                const bar = percentBar(d.fractionUsed);
                return (
                  <div key={d.dimension} className="budget-meter-row">
                    <span>{d.dimension}: {d.used} / {d.limit}</span>
                    <div className="budget-meter-track">
                      <div className="budget-meter-fill" style={{ width: bar.width, backgroundColor: bar.color }} />
                    </div>
                  </div>
                );
              })}
          </div>

          <div className="acp-control-actions">
            <button type="button" disabled={busy === agent.id} onClick={() => void runAction(agent.id, 'acp-control:set-enabled', 'setAcpControlEnabled', { agentId: agent.id, enabled: !agent.enabled })}>
              {agent.enabled ? t('acpControl.disable') : t('acpControl.enable')}
            </button>
            {agent.status !== 'running' ? (
              <button type="button" disabled={busy === agent.id || !agent.enabled} onClick={() => void runAction(agent.id, 'acp-control:start', 'startAcpControlAgent', agent.id)}>
                {busy === agent.id ? t('acpControl.starting') : t('acpControl.start')}
              </button>
            ) : (
              <button type="button" disabled={busy === agent.id} onClick={() => void runAction(agent.id, 'acp-control:stop', 'stopAcpControlAgent', agent.id)}>
                {busy === agent.id ? t('acpControl.stopping') : t('acpControl.stop')}
              </button>
            )}
            <button type="button" onClick={() => openBudgetEditor(agent)}>{t('acpControl.setBudget')}</button>
            <button type="button" onClick={() => void loadHistory(agent.id)}>{t('acpControl.historyTitle')}</button>
            <button type="button" onClick={() => void loadReport(agent.id)}>{t('acpControl.report')}</button>
          </div>

          {budgetEditor === agent.id && (
            <div className="acp-control-budget-form">
              <label>
                {t('acpControl.tokensPerDay')}
                <input type="number" min="1" value={budgetForm.maxTokensPerDay} onChange={(e) => setBudgetForm((f) => ({ ...f, maxTokensPerDay: e.target.value }))} />
              </label>
              <label>
                {t('acpControl.costPerDay')}
                <input type="number" min="0" step="0.01" value={budgetForm.maxCostUsdPerDay} onChange={(e) => setBudgetForm((f) => ({ ...f, maxCostUsdPerDay: e.target.value }))} />
              </label>
              <label>
                {t('acpControl.callsPerDay')}
                <input type="number" min="1" value={budgetForm.maxCallsPerDay} onChange={(e) => setBudgetForm((f) => ({ ...f, maxCallsPerDay: e.target.value }))} />
              </label>
              <label>
                {t('acpControl.wallPerDay')}
                <input type="number" min="1" value={budgetForm.maxWallMsPerDay} onChange={(e) => setBudgetForm((f) => ({ ...f, maxWallMsPerDay: e.target.value }))} />
              </label>
              <button type="button" disabled={busy === agent.id} onClick={() => void saveBudget(agent.id)}>{t('acpControl.setBudget')}</button>
            </div>
          )}

          {reports[agent.id] && (
            <div className="acp-control-report">
              <strong>{t('acpControl.reportTitle', { days: 7 })}</strong>
              <table>
                <thead>
                  <tr>
                    <th>{t('acpControl.day')}</th>
                    <th>{t('acpControl.tokens')}</th>
                    <th>{t('acpControl.cost')}</th>
                    <th>{t('acpControl.calls')}</th>
                    <th>{t('acpControl.wallTime')}</th>
                  </tr>
                </thead>
                <tbody>
                  {reports[agent.id].days.map((day) => (
                    <tr key={day.day}>
                      <td>{day.day}{day.blocked ? ` (${t('acpControl.statusBlocked')})` : ''}</td>
                      <td>{day.summary.totalTokens}</td>
                      <td>{formatCost(day.summary.costUsd)}</td>
                      <td>{day.summary.calls}</td>
                      <td>{formatWallMs(day.summary.wallMs)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <strong>{t('acpControl.alertsTitle')}</strong>
              {reports[agent.id].alerts.length === 0 ? (
                <p>{t('acpControl.emptyAlerts')}</p>
              ) : (
                <ul>
                  {reports[agent.id].alerts.map((alert) => (
                    <li key={alert.id}>
                      {new Date(alert.at).toLocaleString()} [{alertKindLabel(t, alert.kind)}] {alert.reasons.join('; ')}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {history[agent.id] && (
            <div className="acp-control-history">
              <strong>{t('acpControl.historyTitle')}</strong>
              {history[agent.id].length === 0 ? (
                <p>{t('acpControl.emptyHistory')}</p>
              ) : (
                <ul>
                  {history[agent.id].slice(-5).reverse().map((turn) => (
                    <li key={turn.id}>
                      {new Date(turn.at).toLocaleString()} [{turn.status}] {turn.inputTokens + turn.outputTokens} {t('acpControl.tokens')}, {formatCost(turn.costUsd)}, {formatWallMs(turn.durationMs)}, {turn.stopReason}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </section>
      ))}

      {discovered.length > 0 && (
        <section className="acp-control-discovered">
          <h3>{t('acpControl.discover')}</h3>
          <ul>
            {discovered.map((found) => (
              <li key={found.backendId}>
                <strong>{found.name}</strong>
                {' — '}
                {found.installed ? found.resolvedPath ?? found.command : t('acpControl.notInstalled')}
                {found.speaksAcp && ` — ${t('acpControl.speaksAcp')}`}
                {found.loggedIn ? ` — ${t('acpControl.loggedIn')}${found.loginLabel ? ` (${found.loginLabel})` : ''}` : ` — ${t('acpControl.notLoggedIn')}`}
                {found.alreadyRegistered ? (
                  <span> — {t('acpControl.registered')}</span>
                ) : (
                  found.installed && (
                    <button type="button" disabled={busy === found.backendId} onClick={() => void runAction(found.backendId, 'acp-control:register', 'registerAcpControlAgent', found.backendId)}>
                      {t('acpControl.register')}
                    </button>
                  )
                )}
                {found.error && <span> — {found.error}</span>}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

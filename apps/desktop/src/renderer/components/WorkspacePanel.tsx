/**
 * Workspace panel (v1.03, Team T4) — presentational list of agent
 * workspaces (local sandbox / container) with quota + snapshots.
 *
 * Props only — no IPC wiring yet: the host (T6/UI) mounts this panel
 * and passes workspaces + callbacks (IPC `workspace:*` is a
 * follow-up). Shapes mirror core `WorkspaceStatusView` (plain JSON,
 * no secrets). The panel never claims container isolation it does
 * not have: a workspace whose container backend fell back to local
 * shows `degraded` + `workspace.containerUnavailable`.
 */
import { useT } from '../i18n/useT';

/** Plain-JSON mirror of core WorkspaceStatusView (subset the panel shows). */
export interface WorkspacePanelItem {
  id: string;
  name: string;
  backend: 'local' | 'container';
  status: 'active' | 'degraded' | 'stopped' | 'destroyed';
  degradedReason?: string;
  profile: string;
  isolation: { kind: string; isolated: boolean; detail: string } | null;
  quota: { cpuCores: number; ramBytes: number; diskBytes: number };
  usage: { diskBytes: number; fileCount: number; runs: number };
  snapshotCount: number;
}

export interface WorkspacePanelProps {
  workspaces: WorkspacePanelItem[];
  /** Most recent exec error (if any) — shown via workspace.execDenied. */
  lastError?: string;
  onCreate?: (backend: 'local' | 'container') => void;
  onSnapshot?: (id: string) => void;
  onRestore?: (id: string) => void;
}

function formatBytes(bytes: number): string {
  const gb = bytes / 1024 ** 3;
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  const mb = bytes / 1024 ** 2;
  if (mb >= 1) return `${mb.toFixed(0)} MB`;
  return `${Math.round(bytes / 1024)} KB`;
}

export default function WorkspacePanel({ workspaces, lastError, onCreate, onSnapshot, onRestore }: WorkspacePanelProps) {
  const t = useT();
  return (
    <section>
      <h2>{t('workspace.title')}</h2>
      {lastError ? <p>{t('workspace.execDenied', { reason: lastError })}</p> : null}
      <div>
        <button type="button" onClick={() => onCreate?.('local')}>
          {t('workspace.create')} — {t('workspace.backendLocal')}
        </button>{' '}
        <button type="button" onClick={() => onCreate?.('container')}>
          {t('workspace.create')} — {t('workspace.backendContainer')}
        </button>
      </div>
      {workspaces.length === 0 ? (
        <p>{t('workspace.empty')}</p>
      ) : (
        <ul>
          {workspaces.map((ws) => (
            <li key={ws.id}>
              <strong>{ws.name}</strong> ({ws.id}) —{' '}
              {ws.backend === 'container' ? t('workspace.backendContainer') : t('workspace.backendLocal')} —{' '}
              {ws.status}
              {ws.status === 'degraded' && ws.degradedReason ? (
                <span> — {t('workspace.containerUnavailable')}</span>
              ) : null}
              <div>
                {t('workspace.backend')}: {ws.backend} · {t('workspace.quota')}: {ws.quota.cpuCores} CPU /{' '}
                {formatBytes(ws.quota.ramBytes)} RAM / {formatBytes(ws.quota.diskBytes)} disk ·{' '}
                {t('workspace.snapshot')}: {ws.snapshotCount}
              </div>
              <div>
                {t('workspace.quota')}: {formatBytes(ws.usage.diskBytes)} used · {ws.usage.fileCount} files ·{' '}
                {ws.usage.runs} runs
                {ws.usage.diskBytes > ws.quota.diskBytes ? (
                  <span> — {t('workspace.quotaExceeded', { reason: 'disk' })}</span>
                ) : null}
              </div>
              <div>
                {ws.isolation
                  ? `${ws.isolation.kind} (${ws.isolation.isolated ? 'isolated' : 'not isolated'}) — ${ws.isolation.detail}`
                  : '—'}
              </div>
              <div>
                <button type="button" onClick={() => onSnapshot?.(ws.id)}>
                  {t('workspace.snapshotCreate')}
                </button>{' '}
                <button type="button" onClick={() => onRestore?.(ws.id)} disabled={ws.snapshotCount === 0}>
                  {t('workspace.snapshotRestore')}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

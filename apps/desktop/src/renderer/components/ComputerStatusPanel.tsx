import { useEffect, useState } from 'react';
import { useT } from '../i18n/useT';

/**
 * ComputerStatusPanel (v1.05, Team T3) — per-bot computer status
 * dashboard: level, configured quota, workspace disk measured for
 * real, warnings when near/over quota.
 *
 * Data comes from IPC 'computers:status' (main reads the quota from
 * team-computers.json + measures the workspace disk). Anything that
 * cannot be measured renders as "—" (never made up). Read-only panel:
 * set quotas with the `openmausbot_v105_computer_quota` tool or team YAML.
 */

interface ComputerStatus {
  botId: string;
  level: string | null;
  quota: {
    botId: string;
    level?: string;
    cpuCores?: number;
    memoryMb?: number;
    diskMb?: number;
    maxProcesses?: number;
  } | null;
  usage: {
    cpuCores: number | null;
    memoryMb: number | null;
    diskMb: number | null;
    processes: number | null;
    measuredAt: string;
  };
  warnings: Array<{ field: string; severity: string; ratio: number; message: string }>;
  status: 'ok' | 'warn' | 'over';
  levelFeasible: boolean | null;
  levelNote?: string;
}

interface Props {
  botId: string;
  workspaceDir: string;
}

function formatMb(value: number | null): string {
  if (value === null) return '—';
  if (value >= 1024) return `${(value / 1024).toFixed(1)} GB`;
  return `${value} MB`;
}

export default function ComputerStatusPanel({ botId, workspaceDir }: Props) {
  const t = useT();
  const [status, setStatus] = useState<ComputerStatus | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  const load = async () => {
    if (typeof window.openBot.getComputerStatus !== 'function') return;
    setLoading(true);
    try {
      const res = await window.openBot.getComputerStatus({ botId, workspaceDir });
      setStatus(res);
      setError('');
    } catch {
      setStatus(null);
      setError(t('computerStatus.error'));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [botId, workspaceDir]);

  if (loading && !status) {
    return <p className="hint">{t('computerStatus.loading')}</p>;
  }
  if (error) {
    return (
      <div>
        <p className="error">{error}</p>
        <button type="button" className="btn secondary" onClick={() => void load()}>
          {t('computerStatus.retry')}
        </button>
      </div>
    );
  }
  if (!status) return null;

  const statusText =
    status.status === 'ok'
      ? t('computerStatus.statusOk')
      : status.status === 'warn'
        ? t('computerStatus.statusWarn')
        : t('computerStatus.statusOver');

  return (
    <div data-testid="computer-status-panel">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <strong>{t('computerStatus.title')}</strong>
        <span className={status.status === 'ok' ? 'hint' : 'error'}>{statusText}</span>
      </div>
      {!status.quota && <p className="hint">{t('computerStatus.noQuota')}</p>}
      {status.quota && (
        <dl style={{ margin: '8px 0', fontSize: 13 }}>
          {status.level && (
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <dt>{t('computerStatus.level')}</dt>
              <dd style={{ margin: 0 }}>{status.level}</dd>
            </div>
          )}
          {status.quota.cpuCores !== undefined && (
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <dt>{t('computerStatus.cpu')}</dt>
              <dd style={{ margin: 0 }}>
                {status.usage.cpuCores ?? '—'} / {status.quota.cpuCores} cores
              </dd>
            </div>
          )}
          {status.quota.memoryMb !== undefined && (
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <dt>{t('computerStatus.memory')}</dt>
              <dd style={{ margin: 0 }}>
                {formatMb(status.usage.memoryMb)} / {formatMb(status.quota.memoryMb)}
              </dd>
            </div>
          )}
          {status.quota.diskMb !== undefined && (
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <dt>{t('computerStatus.disk')}</dt>
              <dd style={{ margin: 0 }}>
                {formatMb(status.usage.diskMb)} / {formatMb(status.quota.diskMb)}
              </dd>
            </div>
          )}
          {status.quota.maxProcesses !== undefined && (
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <dt>{t('computerStatus.processes')}</dt>
              <dd style={{ margin: 0 }}>
                {status.usage.processes ?? '—'} / {status.quota.maxProcesses}
              </dd>
            </div>
          )}
        </dl>
      )}
      {status.levelFeasible === false && status.levelNote && (
        <p className="error" style={{ margin: '4px 0' }}>{status.levelNote}</p>
      )}
      {status.warnings.map((w) => (
        <p key={w.field} className={w.severity === 'over' ? 'error' : 'hint'} style={{ margin: '4px 0' }}>
          {w.message}
        </p>
      ))}
      <p className="hint" style={{ margin: '4px 0 0' }}>
        {t('computerStatus.measuredAt', { time: new Date(status.usage.measuredAt).toLocaleTimeString() })}
      </p>
      <button type="button" className="btn secondary" onClick={() => void load()}>
        {t('computerStatus.refresh')}
      </button>
    </div>
  );
}

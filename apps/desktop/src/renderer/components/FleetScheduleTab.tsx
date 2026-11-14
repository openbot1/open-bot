import { useCallback, useEffect, useState } from 'react';
import type { PlacementPlanView, QueuedPlacementView } from '../types';
import { useT } from '../i18n/useT';

/**
 * Fleet scheduling tab (v1.03) — placement planning + the durable
 * placement queue, inside the fleet console.
 *
 * Plan: describe what a new bot needs (CPU/RAM/disk + strategy) and
 * the scheduler ranks every workspace by fit — the plan is
 * read-only, it never moves a bot. Queue: requests that fit nowhere
 * right now wait here until capacity frees up; an admin claims or
 * cancels them. Data flows over IPC `fleet:schedule-*` (see main.ts).
 */

async function callOpenBot<T>(channel: string, camel: string, ...args: unknown[]): Promise<T | null> {
  const api = window.openBot as unknown as Record<string, unknown>;
  const fn = api[channel] ?? api[camel];
  if (typeof fn !== 'function') return null;
  return (fn as (...a: unknown[]) => Promise<T>).apply(window.openBot, args);
}

function formatBytes(bytes: number): string {
  const gb = bytes / 1024 ** 3;
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  const mb = bytes / 1024 ** 2;
  if (mb >= 1) return `${mb.toFixed(0)} MB`;
  return `${Math.round(bytes / 1024)} KB`;
}

const MB = 1024 ** 2;
const GB = 1024 ** 3;

export default function FleetScheduleTab() {
  const t = useT();
  const [botId, setBotId] = useState('');
  const [cpu, setCpu] = useState('1');
  const [ramMb, setRamMb] = useState('1024');
  const [diskGb, setDiskGb] = useState('10');
  const [strategy, setStrategy] = useState<'spread' | 'binpack'>('spread');
  const [plan, setPlan] = useState<PlacementPlanView | null>(null);
  const [queue, setQueue] = useState<QueuedPlacementView[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const loadQueue = useCallback(async () => {
    try {
      const data = await callOpenBot<QueuedPlacementView[]>('fleet:schedule-queue', 'listScheduleQueue');
      if (data) setQueue(data);
    } catch {
      // Queue is best-effort on load; planning still works without it.
    }
  }, []);

  useEffect(() => {
    void loadQueue();
  }, [loadQueue]);

  function parsedRequest(): { botId: string; cpuCores: number; ramBytes: number; diskBytes: number } | null {
    const cpuCores = Number(cpu);
    const ramBytes = Number(ramMb) * MB;
    const diskBytes = Number(diskGb) * GB;
    if (!botId.trim() || !Number.isFinite(cpuCores) || cpuCores <= 0 || !Number.isFinite(ramBytes) || ramBytes <= 0 || !Number.isFinite(diskBytes) || diskBytes <= 0) {
      return null;
    }
    return { botId: botId.trim(), cpuCores, ramBytes, diskBytes };
  }

  async function handlePlan() {
    const request = parsedRequest();
    setError(null);
    setNotice(null);
    if (!request) {
      setError(t('fleetSchedule.invalidRequest'));
      return;
    }
    setLoading(true);
    try {
      const result = await callOpenBot<PlacementPlanView>('fleet:schedule-plan', 'planFleetPlacement', {
        ...request,
        strategy,
      });
      if (!result) throw new Error(t('fleetSchedule.planError'));
      setPlan(result);
    } catch (err) {
      setError((err as Error).message || t('fleetSchedule.planError'));
    } finally {
      setLoading(false);
    }
  }

  async function handleEnqueue() {
    const request = parsedRequest();
    setError(null);
    setNotice(null);
    if (!request) {
      setError(t('fleetSchedule.invalidRequest'));
      return;
    }
    setBusy(true);
    try {
      const entry = await callOpenBot<QueuedPlacementView>('fleet:schedule-enqueue', 'enqueuePlacement', {
        ...request,
        strategy,
      });
      if (!entry) throw new Error(t('fleetSchedule.enqueueError'));
      setNotice(t('fleetSchedule.enqueued'));
      await loadQueue();
    } catch (err) {
      setError((err as Error).message || t('fleetSchedule.enqueueError'));
    } finally {
      setBusy(false);
    }
  }

  async function handleClaim(id: string) {
    setError(null);
    setNotice(null);
    try {
      await callOpenBot<QueuedPlacementView>('fleet:schedule-claim', 'claimPlacement', id);
      setNotice(t('fleetSchedule.claimed'));
      await loadQueue();
    } catch (err) {
      setError((err as Error).message || t('fleetSchedule.planError'));
    }
  }

  async function handleCancel(id: string) {
    setError(null);
    setNotice(null);
    try {
      await callOpenBot<QueuedPlacementView>('fleet:schedule-cancel', 'cancelPlacement', { id });
      setNotice(t('fleetSchedule.cancelled'));
      await loadQueue();
    } catch (err) {
      setError((err as Error).message || t('fleetSchedule.planError'));
    }
  }

  const waiting = queue.filter((q) => q.status === 'waiting');

  return (
    <div>
      <h3 style={{ marginTop: 0 }}>{t('fleetSchedule.title')}</h3>
      <p style={{ color: '#666', marginTop: 4 }}>{t('fleetSchedule.subtitle')}</p>

      <div style={{ border: '1px solid #ddd', borderRadius: 8, padding: 12 }}>
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          <input
            value={botId}
            onChange={(e) => setBotId(e.target.value)}
            placeholder={t('fleetSchedule.botIdPlaceholder')}
            style={{ flex: 1, minWidth: 140 }}
          />
          <label>
            {t('fleetConsole.quotaCpu')}{' '}
            <input value={cpu} onChange={(e) => setCpu(e.target.value)} style={{ width: 60 }} />
          </label>
          <label>
            {t('fleetConsole.quotaRam')}{' '}
            <input value={ramMb} onChange={(e) => setRamMb(e.target.value)} style={{ width: 80 }} />
          </label>
          <label>
            {t('fleetConsole.quotaDisk')}{' '}
            <input value={diskGb} onChange={(e) => setDiskGb(e.target.value)} style={{ width: 60 }} />
          </label>
          <label>
            {t('fleetSchedule.strategy')}{' '}
            <select value={strategy} onChange={(e) => setStrategy(e.target.value as 'spread' | 'binpack')}>
              <option value="spread">{t('fleetSchedule.strategySpread')}</option>
              <option value="binpack">{t('fleetSchedule.strategyBinpack')}</option>
            </select>
          </label>
        </div>
        <div className="row" style={{ gap: 8, marginTop: 8 }}>
          <button className="btn" disabled={loading || busy} onClick={() => void handlePlan()}>
            {t('fleetSchedule.plan')}
          </button>
          <button className="btn secondary" disabled={loading || busy} onClick={() => void handleEnqueue()}>
            {t('fleetSchedule.enqueue')}
          </button>
        </div>
      </div>

      {error && <p style={{ color: '#c00' }}>{error}</p>}
      {notice && <p style={{ color: '#080' }}>{notice}</p>}

      {plan && (
        <div style={{ marginTop: 12 }}>
          <h4 style={{ margin: '0 0 8px' }}>{t('fleetSchedule.planResult')}</h4>
          {plan.best ? (
            <p style={{ color: '#080' }}>
              {t('fleetSchedule.best', { name: plan.best.workspaceName })} — {plan.best.reason}
            </p>
          ) : (
            <p style={{ color: '#c80' }}>{t('fleetSchedule.noFit')}</p>
          )}
          {plan.candidates.map((c) => (
            <div key={c.workspaceId} style={{ border: '1px solid #ddd', borderRadius: 8, padding: 10, marginBottom: 8 }}>
              <div className="row" style={{ justifyContent: 'space-between', gap: 8 }}>
                <strong>{c.workspaceName}</strong>
                <span>
                  {c.fit === 'fits'
                    ? t('fleetSchedule.fits')
                    : c.fit === 'no-fit'
                      ? t('fleetSchedule.noFitShort')
                      : t('fleetSchedule.notEligible')}{' '}
                  · {t('fleetSchedule.score', { score: Math.round(c.score * 100) })}
                </span>
              </div>
              <div style={{ color: '#666', fontSize: 13, marginTop: 4 }}>{c.reason}</div>
              <div style={{ color: '#666', fontSize: 13 }}>
                {t('fleetSchedule.headroomAfter')}: {c.headroomAfter.cpuCores} CPU ·{' '}
                {formatBytes(c.headroomAfter.ramBytes)} {t('fleet.ram')} · {formatBytes(c.headroomAfter.diskBytes)}{' '}
                {t('fleet.disk')}
              </div>
            </div>
          ))}
        </div>
      )}

      <h4 style={{ margin: '16px 0 8px' }}>
        {t('fleetSchedule.queue')} {waiting.length > 0 ? `(${waiting.length})` : ''}
      </h4>
      {waiting.length === 0 && <p>{t('fleetSchedule.queueEmpty')}</p>}
      {waiting.map((q) => (
        <div key={q.id} style={{ border: '1px solid #ddd', borderRadius: 8, padding: 10, marginBottom: 8 }}>
          <div className="row" style={{ justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
            <div>
              <strong>{q.request.botId}</strong>{' '}
              <span style={{ color: '#666', fontSize: 13 }}>
                · {q.request.cpuCores} CPU · {formatBytes(q.request.ramBytes)} {t('fleet.ram')} ·{' '}
                {formatBytes(q.request.diskBytes)} {t('fleet.disk')} · {q.requestedBy} ·{' '}
                {new Date(q.requestedAt).toLocaleString()}
              </span>
            </div>
            <div className="row" style={{ gap: 8 }}>
              <button className="btn secondary" onClick={() => void handleClaim(q.id)}>
                {t('fleetSchedule.claim')}
              </button>
              <button className="btn secondary" onClick={() => void handleCancel(q.id)}>
                {t('fleetSchedule.cancel')}
              </button>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

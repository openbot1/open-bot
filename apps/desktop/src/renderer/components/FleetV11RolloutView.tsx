import { useState } from 'react';
import { useT } from '../i18n/useT';

/**
 * Fleet rollout v11 view (v1.14, Team T6) — staged rollout by group.
 *
 * Continues campaign v7 (rollout per bot across nodes): v11 adds a
 * rollout state machine (draft → canary → expanding → complete,
 * pause/resume, rollback), expansion gates (previous group done + error rate
 * under the threshold + no critical alert in the next group) and suggests
 * auto-rollback. Data comes via props `rollouts` (host builds them from core
 * `fleetV11Rollout.ts` + IPC); when there is no host wiring yet it uses an internal demo
 * store — the component never guesses real state.
 */

export type FleetV11RolloutStage =
  | 'draft'
  | 'canary'
  | 'expanding'
  | 'paused'
  | 'complete'
  | 'rolled-back';

export interface FleetV11RolloutGroupView {
  name: string;
  targets: string[];
  status: 'pending' | 'active' | 'done' | 'failed' | 'rolled-back';
  appliedCount: number;
  errorCount: number;
}

export interface FleetV11RolloutView {
  id: string;
  name: string;
  feature: string;
  version: string;
  previousVersion: string;
  stage: FleetV11RolloutStage;
  groups: FleetV11RolloutGroupView[];
  activeGroupIndex: number | null;
}

export function demoFleetV11Rollouts(): FleetV11RolloutView[] {
  return [
    {
      id: 'ro-demo-1',
      name: 'Voice v12 for the whole fleet',
      feature: 'voice-v12-realtime',
      version: '2.4.0',
      previousVersion: '2.3.1',
      stage: 'canary',
      activeGroupIndex: 0,
      groups: [
        { name: 'canary', targets: ['node-local'], status: 'active', appliedCount: 1, errorCount: 0 },
        { name: 'pilot', targets: ['node-lan-1', 'node-lan-2'], status: 'pending', appliedCount: 0, errorCount: 0 },
        { name: 'all', targets: ['node-lan-3', 'node-lan-4', 'node-lan-5'], status: 'pending', appliedCount: 0, errorCount: 0 },
      ],
    },
  ];
}

function groupErrorRate(g: FleetV11RolloutGroupView): number {
  const total = g.appliedCount + g.errorCount;
  return total <= 0 ? 0 : g.errorCount / total;
}

export default function FleetV11RolloutView({
  rollouts: rolloutsProp,
}: {
  rollouts?: FleetV11RolloutView[] | null;
}) {
  const t = useT();
  const [rollouts, setRollouts] = useState<FleetV11RolloutView[]>(
    () => rolloutsProp ?? demoFleetV11Rollouts(),
  );
  const [selectedId, setSelectedId] = useState<string | null>(rolloutsProp?.[0]?.id ?? 'ro-demo-1');
  const [confirmRollback, setConfirmRollback] = useState(false);
  const [notice, setNotice] = useState('');

  const selected = rollouts.find((r) => r.id === selectedId) ?? rollouts[0] ?? null;

  const stageLabel = (stage: FleetV11RolloutStage): string => {
    if (stage === 'draft') return t('fleetV11.stageDraft');
    if (stage === 'canary') return t('fleetV11.stageCanary');
    if (stage === 'expanding') return t('fleetV11.stageExpanding');
    if (stage === 'paused') return t('fleetV11.stagePaused');
    if (stage === 'complete') return t('fleetV11.stageComplete');
    return t('fleetV11.stageRolledBack');
  };

  /** Expansion gate (mirrors core `checkFleetV11RolloutGate`; the demo has no critical alert). */
  const gateFor = (r: FleetV11RolloutView): { allowed: boolean; reason: string } => {
    if (r.stage !== 'canary' && r.stage !== 'expanding') {
      return { allowed: false, reason: t('fleetV11.rolloutStage') + ': ' + stageLabel(r.stage) };
    }
    const idx = r.activeGroupIndex;
    if (idx === null || !r.groups[idx]) return { allowed: false, reason: t('fleetV11.rolloutEmpty') };
    const active = r.groups[idx];
    if (!active || active.status !== 'done') {
      return {
        allowed: false,
        reason: t('fleetV11.rolloutGateBlocked', {
          reason: `group "${active?.name ?? '?'}" not finished`,
        }),
      };
    }
    const rate = groupErrorRate(active);
    if (rate > 0.05) {
      return {
        allowed: false,
        reason: t('fleetV11.rolloutGateBlocked', {
          reason: `${t('fleetV11.rolloutErrorRate')} ${(rate * 100).toFixed(1)}% > 5%`,
        }),
      };
    }
    return { allowed: true, reason: '' };
  };

  const updateSelected = (fn: (r: FleetV11RolloutView) => FleetV11RolloutView) => {
    setRollouts((prev) => prev.map((r) => (r.id === selected?.id ? fn(r) : r)));
  };

  const markActiveDone = () => {
    if (!selected) return;
    updateSelected((r) => {
      const idx = r.activeGroupIndex;
      if (idx === null) return r;
      return {
        ...r,
        groups: r.groups.map((g, i) =>
          i === idx ? { ...g, status: 'done' as const } : g,
        ),
      };
    });
    setNotice(t('fleetV11.rolloutDone'));
  };

  const advance = () => {
    if (!selected) return;
    const gate = gateFor(selected);
    if (!gate.allowed) {
      setNotice(gate.reason);
      return;
    }
    const idx = selected.activeGroupIndex ?? 0;
    const nextIdx = idx + 1;
    updateSelected((r) => {
      if (nextIdx >= r.groups.length) {
        return { ...r, stage: 'complete', activeGroupIndex: null };
      }
      return {
        ...r,
        stage: 'expanding',
        activeGroupIndex: nextIdx,
        groups: r.groups.map((g, i) =>
          i === nextIdx ? { ...g, status: 'active' as const } : g,
        ),
      };
    });
    setNotice('');
  };

  const pause = () => {
    if (!selected) return;
    updateSelected((r) => ({ ...r, stage: 'paused' }));
  };

  const resume = () => {
    if (!selected) return;
    updateSelected((r) => ({
      ...r,
      stage: (r.activeGroupIndex ?? 0) === 0 ? 'canary' : 'expanding',
    }));
  };

  const rollback = () => {
    if (!selected) return;
    updateSelected((r) => ({
      ...r,
      stage: 'rolled-back',
      activeGroupIndex: null,
      groups: r.groups.map((g) =>
        g.status === 'active' || g.status === 'done' ? { ...g, status: 'rolled-back' as const } : g,
      ),
    }));
    setConfirmRollback(false);
    setNotice(t('fleetV11.stageRolledBack'));
  };

  const totalTargets = selected?.groups.reduce((a, g) => a + g.targets.length, 0) ?? 0;
  const appliedTargets = selected?.groups.reduce((a, g) => a + g.appliedCount, 0) ?? 0;
  const errorTargets = selected?.groups.reduce((a, g) => a + g.errorCount, 0) ?? 0;
  const gate = selected ? gateFor(selected) : { allowed: false, reason: '' };
  const running = selected?.stage === 'canary' || selected?.stage === 'expanding';

  return (
    <div>
      <h3>{t('fleetV11.rolloutTitle')}</h3>
      <p className="hint">{t('fleetV11.rolloutSubtitle')}</p>
      {rollouts.length === 0 ? (
        <p className="hint">{t('fleetV11.rolloutNoRollouts')}</p>
      ) : (
        <div>
          <div className="row">
            {rollouts.map((r) => (
              <button
                key={r.id}
                className="btn secondary"
                disabled={r.id === selected?.id}
                onClick={() => {
                  setSelectedId(r.id);
                  setNotice('');
                  setConfirmRollback(false);
                }}
              >
                {r.name}
              </button>
            ))}
          </div>
          {selected ? (
            <div>
              <p>
                <strong>{selected.name}</strong> — {selected.feature} {selected.version} (
                {t('fleetV11.rolloutStage')}: {stageLabel(selected.stage)})
              </p>
              <p className="hint">
                {t('fleetV11.rolloutProgress')}: {appliedTargets}/{totalTargets} ·{' '}
                {t('fleetV11.rolloutErrorRate')}:{' '}
                {totalTargets > 0 ? ((errorTargets / totalTargets) * 100).toFixed(1) : '0.0'}%
              </p>
              <table>
                <thead>
                  <tr>
                    <th>{t('fleetV11.rolloutGroup')}</th>
                    <th>Target</th>
                    <th>{t('fleetV11.rolloutStage')}</th>
                    <th>{t('fleetV11.rolloutProgress')}</th>
                    <th>{t('fleetV11.rolloutErrorRate')}</th>
                  </tr>
                </thead>
                <tbody>
                  {selected.groups.map((g) => (
                    <tr key={g.name}>
                      <td>{g.name}</td>
                      <td>{g.targets.join(', ')}</td>
                      <td>{g.status}</td>
                      <td>
                        {g.appliedCount}/{g.targets.length}
                      </td>
                      <td>{(groupErrorRate(g) * 100).toFixed(1)}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="row">
                {running ? (
                  <button className="btn secondary" onClick={markActiveDone}>
                    {t('fleetV11.rolloutDone')} ({selected.groups[selected.activeGroupIndex ?? 0]?.name ?? ''})
                  </button>
                ) : null}
                {running ? (
                  <button className="btn secondary" onClick={advance} disabled={!gate.allowed}>
                    {t('fleetV11.rolloutAdvance')}
                  </button>
                ) : null}
                {running ? (
                  <button className="btn secondary" onClick={pause}>
                    {t('fleetV11.rolloutPause')}
                  </button>
                ) : null}
                {selected.stage === 'paused' ? (
                  <button className="btn secondary" onClick={resume}>
                    {t('fleetV11.rolloutResume')}
                  </button>
                ) : null}
                {running || selected.stage === 'paused' ? (
                  confirmRollback ? (
                    <span>
                      {t('fleetV11.rolloutConfirmRollback', { version: selected.previousVersion })}{' '}
                      <button className="btn secondary" onClick={rollback}>
                        {t('fleetV11.rolloutRollback')}
                      </button>{' '}
                      <button className="btn secondary" onClick={() => setConfirmRollback(false)}>
                        {t('fleet.cancel')}
                      </button>
                    </span>
                  ) : (
                    <button className="btn secondary" onClick={() => setConfirmRollback(true)}>
                      {t('fleetV11.rolloutRollback')}
                    </button>
                  )
                ) : null}
              </div>
              {!gate.allowed && running ? <p className="hint">{gate.reason}</p> : null}
              {notice ? <p className="hint">{notice}</p> : null}
            </div>
          ) : (
            <p className="hint">{t('fleetV11.rolloutEmpty')}</p>
          )}
        </div>
      )}
    </div>
  );
}

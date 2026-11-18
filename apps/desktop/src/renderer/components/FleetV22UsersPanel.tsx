import { useState } from 'react';
import { useT } from '../i18n/useT';

/**
 * Fleet v22 users panel (v1.35, Team T6) — multi-user list: roles,
 * quota usage (heaviest first), who is nearly out of quota, who is
 * locked.
 *
 * Data comes via props (host builds the view-model from core
 * `buildFleetV22UserPanel` via IPC); when there is no host wiring yet
 * it uses an internal demo store — the component never guesses real
 * numbers; the demo is clearly labelled in code.
 */

export interface FleetV22UserRowView {
  id: string;
  displayName: string;
  email: string;
  role: string;
  active: boolean;
  team?: string;
  maxQuotaFraction: number;
  quotaFractions: Record<string, number>;
  nearLimit: boolean;
  idleMs: number | null;
}

export interface FleetV22UsersPanelView {
  summary: string;
  total: number;
  active: number;
  locked: number;
  admins: number;
  operators: number;
  members: number;
  viewers: number;
  nearLimit: number;
  rows: FleetV22UserRowView[];
  nearLimitUserIds: string[];
  lockedUserIds: string[];
}

export function demoFleetV22UsersPanel(): FleetV22UsersPanelView {
  return {
    summary: '3 users (1 admin, 1 operator, 1 member), 1 user nearly out of quota.',
    total: 3,
    active: 3,
    locked: 0,
    admins: 1,
    operators: 1,
    members: 1,
    viewers: 0,
    nearLimit: 1,
    rows: [
      {
        id: 'u1', displayName: 'U1', email: 'u1@example.com', role: 'member', active: true,
        maxQuotaFraction: 0.875,
        quotaFractions: { cpuCores: 0.875, ramBytes: 0.25, diskBytes: 0.1, bots: 0.4, concurrentRuns: 0.3, computers: 0.33 },
        nearLimit: true, idleMs: 60_000,
      },
      {
        id: 'op1', displayName: 'Op', email: 'op@example.com', role: 'operator', active: true,
        maxQuotaFraction: 0.25,
        quotaFractions: { cpuCores: 0.25, ramBytes: 0.125, diskBytes: 0.05, bots: 0.2, concurrentRuns: 0.1, computers: 0 },
        nearLimit: false, idleMs: 3_600_000,
      },
      {
        id: 'admin', displayName: 'Admin', email: 'admin@example.com', role: 'admin', active: true,
        maxQuotaFraction: 0,
        quotaFractions: { cpuCores: 0, ramBytes: 0, diskBytes: 0, bots: 0, concurrentRuns: 0, computers: 0 },
        nearLimit: false, idleMs: null,
      },
    ],
    nearLimitUserIds: ['u1'],
    lockedUserIds: [],
  };
}

export interface FleetV22UsersPanelProps {
  view?: FleetV22UsersPanelView;
  onBack?: () => void;
}

function pct(frac: number): string {
  return `${Math.round(frac * 100)}%`;
}

export default function FleetV22UsersPanel(props: FleetV22UsersPanelProps) {
  const t = useT();
  const [view] = useState<FleetV22UsersPanelView>(() => props.view ?? demoFleetV22UsersPanel());

  return (
    <div className="panel fleet-v22-users-panel">
      <div className="panel-header">
        {props.onBack ? (
          <button type="button" className="btn-ghost" onClick={props.onBack}>
            ← {t('fleet.v22.dashboard')}
          </button>
        ) : null}
        <h2>{t('fleet.v22.users')}</h2>
      </div>

      <p className="panel-summary">{view.summary}</p>

      <div className="fleet-v22-score-cards">
        <div className="score-card">
          <div className="score-card-title">{t('fleet.v22.user')}</div>
          <div className="score-card-body">{`${view.active}/${view.total}`}</div>
        </div>
        <div className="score-card">
          <div className="score-card-title">{t('fleet.v22.nearLimit')}</div>
          <div className="score-card-body">{view.nearLimit}</div>
        </div>
        <div className="score-card">
          <div className="score-card-title">{t('fleet.v22.locked')}</div>
          <div className="score-card-body">{view.locked}</div>
        </div>
      </div>

      {view.rows.length === 0 ? (
        <p className="panel-empty">{t('fleet.v22.noUsers')}</p>
      ) : (
        <table className="fleet-table">
          <thead>
            <tr>
              <th>{t('fleet.v22.user')}</th>
              <th>{t('fleet.v22.role')}</th>
              <th>{t('fleet.v22.quota')}</th>
              <th>CPU</th>
              <th>RAM</th>
              <th>{t('fleet.v22.status')}</th>
            </tr>
          </thead>
          <tbody>
            {view.rows.map((row) => (
              <tr key={row.id} className={row.nearLimit ? 'row-warning' : row.active ? '' : 'row-error'}>
                <td>
                  {row.displayName}
                  <div className="row-sub">{row.email}</div>
                </td>
                <td>{row.role}</td>
                <td>
                  {pct(row.maxQuotaFraction)}
                  {row.nearLimit ? ` (${t('fleet.v22.nearLimit')})` : ''}
                </td>
                <td>{pct(row.quotaFractions.cpuCores ?? 0)}</td>
                <td>{pct(row.quotaFractions.ramBytes ?? 0)}</td>
                <td>{row.active ? t('fleet.v22.running') : t('fleet.v22.locked')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

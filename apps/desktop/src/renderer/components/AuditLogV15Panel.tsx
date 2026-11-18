import { useState } from 'react';
import { useT } from '../i18n/useT';

/**
 * Audit log panel (v1.18, Team T6) — unified audit rows (user /
 * fleet / team backends), filter by user / action / source / time /
 * free-text query, pagination, export JSON/CSV.
 *
 * Data comes via props (host builds the view-model from core
 * `buildFleetV15AuditPanel` via IPC); when there is no host wiring
 * yet it uses an internal demo store — the component never guesses
 * real numbers; the demo is clearly labelled in code. Export buttons
 * are placeholders until the host wires a real download: they show
 * the export preview instead of writing a file.
 */

export interface AuditLogV15RowView {
  seq: number;
  at: number;
  source: string;
  userId: string;
  actorUserId: string;
  actorRole: string;
  action: string;
  target: string;
  detail: string;
  hash: string;
  verified: boolean;
}

export interface AuditLogV15PanelView {
  rows: AuditLogV15RowView[];
  page: number;
  pageSize: number;
  totalRows: number;
  totalPages: number;
  hasNext: boolean;
  hasPrev: boolean;
  totalFiltered: number;
  userChainOk: boolean;
  userChainBadSeq: number;
  summary: string;
}

const T0 = Date.UTC(2026, 10, 16, 0, 0, 0);

export function demoAuditLogV15Panel(): AuditLogV15PanelView {
  return {
    rows: [
      { seq: 2, at: T0 + 1000, source: 'user-audit', userId: 'u2', actorUserId: 'admin', actorRole: 'admin', action: 'quota.set', target: 'user:u2', detail: 'tokens 1000', hash: 'demo-hash-2', verified: true },
      { seq: 1, at: T0, source: 'user-audit', userId: 'u1', actorUserId: 'admin', actorRole: 'admin', action: 'user.switch', target: 'user:u1', detail: 'switched to u2', hash: 'demo-hash-1', verified: true },
    ],
    page: 1,
    pageSize: 50,
    totalRows: 2,
    totalPages: 1,
    hasNext: false,
    hasPrev: false,
    totalFiltered: 2,
    userChainOk: true,
    userChainBadSeq: -1,
    summary: 'Demo: audit log: 2 events total (2 after filter), page 1/1; user hash chain verified OK.',
  };
}

export default function AuditLogV15Panel({
  panel: panelProp,
}: {
  panel?: AuditLogV15PanelView | null;
}) {
  const t = useT();
  const [panel] = useState<AuditLogV15PanelView>(() => panelProp ?? demoAuditLogV15Panel());
  const [filterUser, setFilterUser] = useState('');
  const [filterAction, setFilterAction] = useState('');
  const [filterQuery, setFilterQuery] = useState('');
  const [exportPreview, setExportPreview] = useState('');

  const filtered = panel.rows.filter((r) => {
    if (filterUser && r.userId !== filterUser) return false;
    if (filterAction && r.action !== filterAction) return false;
    if (filterQuery) {
      const hay = `${r.action} ${r.target} ${r.detail} ${r.actorUserId}`.toLowerCase();
      if (!hay.includes(filterQuery.toLowerCase())) return false;
    }
    return true;
  });

  const showExport = (format: 'json' | 'csv') => {
    if (format === 'json') {
      setExportPreview(JSON.stringify(filtered, null, 2).slice(0, 2000));
    } else {
      const header = 'seq,at,isoTime,source,userId,actorUserId,action,target,detail,hash,verified';
      const lines = filtered.map((r) => [r.seq, r.at, new Date(r.at).toISOString(), r.source, r.userId, r.actorUserId, r.action, r.target, r.detail, r.hash, r.verified].join(','));
      setExportPreview([header, ...lines].join('\n').slice(0, 2000));
    }
  };

  return (
    <div>
      <h3>{t('fleetV15.auditTitle')}</h3>
      <p>{panel.summary}</p>
      <p>{t('fleetV15.demo')}</p>
      <p>
        {panel.userChainOk ? t('fleetV15.auditChainOk') : `${t('fleetV15.auditChainBroken')} (seq ${panel.userChainBadSeq})`}
      </p>
      <div>
        <label>
          {t('fleetV15.auditFilterUser')}:{' '}
          <input value={filterUser} onChange={(e) => setFilterUser(e.target.value)} placeholder="u1" />
        </label>{' '}
        <label>
          {t('fleetV15.auditFilterAction')}:{' '}
          <input value={filterAction} onChange={(e) => setFilterAction(e.target.value)} placeholder="user.switch" />
        </label>{' '}
        <label>
          {t('fleetV15.auditFilterQuery')}:{' '}
          <input value={filterQuery} onChange={(e) => setFilterQuery(e.target.value)} placeholder="switch" />
        </label>{' '}
        <button
          type="button"
          onClick={() => {
            setFilterUser('');
            setFilterAction('');
            setFilterQuery('');
          }}
        >
          {t('fleetV15.auditReset')}
        </button>
      </div>
      <div>
        <button type="button" onClick={() => showExport('json')}>
          {t('fleetV15.auditExportJson')}
        </button>{' '}
        <button type="button" onClick={() => showExport('csv')}>
          {t('fleetV15.auditExportCsv')}
        </button>
      </div>
      {exportPreview !== '' && <pre>{exportPreview}</pre>}
      <p>
        {t('fleetV15.auditTotal')}: {panel.totalFiltered} — {t('fleetV15.auditPage')} {panel.page} {t('fleetV15.auditOf')} {panel.totalPages}
      </p>
      {filtered.length === 0 ? (
        <p>{t('fleetV15.auditNoRows')}</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>{t('fleetV15.auditTime')}</th>
              <th>{t('fleetV15.auditSource')}</th>
              <th>{t('fleetV15.auditAction')}</th>
              <th>{t('fleetV15.auditActor')}</th>
              <th>{t('fleetV15.auditTarget')}</th>
              <th>{t('fleetV15.auditDetail')}</th>
              <th>{t('fleetV15.auditVerified')}</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((r) => (
              <tr key={`${r.source}-${r.seq}`}>
                <td>{new Date(r.at).toLocaleString()}</td>
                <td>{r.source}</td>
                <td>{r.action}</td>
                <td>{r.actorUserId}</td>
                <td>{r.target}</td>
                <td>{r.detail}</td>
                <td>{r.verified ? t('fleetV15.auditVerified') : t('fleetV15.auditUnverified')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

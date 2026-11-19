import { useState } from 'react';
import { useT } from '../i18n/useT';

/**
 * A2A audit + sensitive-confirmation panel — fleet v29 (v1.42,
 * Team T6).
 *
 * Two halves of the same accountability story. The audit half lists
 * every delegation, allowlist change, card check, and sensitive
 * decision (ids + states only — never prompt text or secrets) and
 * shows whether the hash chain is intact. The confirmation half
 * lists sensitive actions peers have requested (purchase, payment,
 * secret access, file write outside the sandbox, external send,
 * account change): a peer can only request, only the user approves
 * or denies, and unanswered requests expire.
 *
 * Data comes via props (host builds the view-models from core
 * `buildFleetV29AuditPanel` / `buildFleetV29ConfirmPanel` via IPC);
 * with no host wiring yet it uses an internal demo store — the
 * component never guesses real numbers, and the demo is clearly
 * labelled in code.
 */

export interface A2aAuditV29EntryView {
  seq: number;
  kind: string;
  at: string;
  actor: string;
  peerId?: string;
  taskId?: string;
  detail: string;
}

export interface A2aAuditV29PanelView {
  summary: string;
  entries: A2aAuditV29EntryView[];
  total: number;
  chainOk: boolean;
  brokenSeq: number | null;
  countsByKind: Record<string, number>;
}

export interface A2aConfirmV29RequestView {
  id: string;
  peerId: string;
  taskId: string;
  action: string;
  summary: string;
  amountUsd: number | null;
  status: 'pending' | 'approved' | 'denied' | 'expired';
  requestedAt: string;
  expiresAt: string;
}

export interface A2aAuditV29PanelProps {
  audit?: A2aAuditV29PanelView;
  pending?: A2aConfirmV29RequestView[];
  decided?: A2aConfirmV29RequestView[];
  onApprove?: (id: string) => void;
  onDeny?: (id: string) => void;
}

export function demoA2aAuditV29Panel(): A2aAuditV29PanelView {
  return {
    summary: 'Demo audit log (no host wiring yet).',
    entries: [
      { seq: 1, kind: 'peer-registered', at: '2026-11-19T00:00:00.000Z', actor: 'local-user', peerId: 'peer-research', detail: 'Peer peer-research registered (card unverified).' },
      { seq: 2, kind: 'peer-card-verified', at: '2026-11-19T00:00:10.000Z', actor: 'local-user', peerId: 'peer-research', detail: 'Peer peer-research card check: verified.' },
      { seq: 3, kind: 'allowlist-added', at: '2026-11-19T00:00:20.000Z', actor: 'local-user', peerId: 'peer-research', detail: 'Peer peer-research added to the allowlist by local-user.' },
      { seq: 4, kind: 'delegation-created', at: '2026-11-19T00:01:00.000Z', actor: 'bot-main', peerId: 'peer-research', taskId: 'task-demo-1', detail: 'Task task-demo-1 delegated to peer peer-research (local simulation — no A2A transport wired).' },
    ],
    total: 4,
    chainOk: true,
    brokenSeq: null,
    countsByKind: { 'peer-registered': 1, 'peer-card-verified': 1, 'allowlist-added': 1, 'delegation-created': 1 },
  };
}

export function demoA2aConfirmV29Requests(): A2aConfirmV29RequestView[] {
  return [
    {
      id: 'cfm-demo-1',
      peerId: 'peer-research',
      taskId: 'task-demo-1',
      action: 'purchase',
      summary: 'Buy the dataset licence ($12) for the research task.',
      amountUsd: 12,
      status: 'pending',
      requestedAt: '2026-11-19T00:02:00.000Z',
      expiresAt: '2026-11-19T00:17:00.000Z',
    },
  ];
}

export default function A2aAuditV29Panel({ audit, pending, decided, onApprove, onDeny }: A2aAuditV29PanelProps) {
  const t = useT();
  const [kindFilter, setKindFilter] = useState<string>('all');
  const view = audit ?? demoA2aAuditV29Panel();
  const pendingList = pending ?? demoA2aConfirmV29Requests();
  const decidedList = decided ?? [];
  const kinds = [...new Set(view.entries.map((e) => e.kind))].sort();
  const filtered = kindFilter === 'all' ? view.entries : view.entries.filter((e) => e.kind === kindFilter);
  return (
    <section aria-label={t('fleet.v29.auditTitle')} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <h2 style={{ margin: 0 }}>{t('fleet.v29.auditTitle')}</h2>
      <p style={{ margin: 0, fontSize: 13, opacity: 0.8 }}>{view.summary}</p>
      <p style={{ margin: 0, fontSize: 13, fontWeight: 600 }}>
        {view.chainOk ? t('fleet.v29.chainIntact') : `${t('fleet.v29.chainBroken')} (#${view.brokenSeq ?? '?'})`}
      </p>
      <div style={{ fontSize: 13 }}>
        <label>
          {t('fleet.v29.filterByKind')}{' '}
          <select value={kindFilter} onChange={(e) => setKindFilter(e.target.value)}>
            <option value="all">{t('fleet.v29.allKinds')}</option>
            {kinds.map((kind) => (
              <option key={kind} value={kind}>
                {kind}
              </option>
            ))}
          </select>
        </label>
      </div>
      {filtered.length === 0 ? (
        <p style={{ margin: 0, fontSize: 13, opacity: 0.8 }}>{t('fleet.v29.noAuditEntries')}</p>
      ) : (
        <ol style={{ margin: 0, paddingLeft: 18, fontSize: 13, display: 'flex', flexDirection: 'column', gap: 4 }}>
          {filtered.map((entry) => (
            <li key={entry.seq}>
              <strong>#{entry.seq}</strong> {entry.kind} — {entry.detail}{' '}
              <span style={{ opacity: 0.7 }}>
                ({entry.actor}
                {entry.peerId ? ` · ${entry.peerId}` : ''}
                {entry.taskId ? ` · ${entry.taskId}` : ''} · {entry.at})
              </span>
            </li>
          ))}
        </ol>
      )}
      <h3 style={{ margin: '4px 0 0', fontSize: 14 }}>{t('fleet.v29.confirmTitle')}</h3>
      {pendingList.length === 0 ? (
        <p style={{ margin: 0, fontSize: 13, opacity: 0.8 }}>{t('fleet.v29.noPendingConfirmations')}</p>
      ) : (
        <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, display: 'flex', flexDirection: 'column', gap: 8 }}>
          {pendingList.map((request) => (
            <li key={request.id}>
              <strong>{t(`fleet.v29.sensitive.${request.action}`) ?? request.action}</strong> — {request.summary}
              {request.amountUsd !== null ? ` ($${request.amountUsd.toFixed(2)})` : ''}{' '}
              <span style={{ opacity: 0.7 }}>
                ({request.peerId} · {request.taskId} · {t('fleet.v29.expiresAt')}: {request.expiresAt})
              </span>
              <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
                {onApprove && (
                  <button type="button" onClick={() => onApprove(request.id)} style={{ fontSize: 13, cursor: 'pointer' }}>
                    {t('fleet.v29.approve')}
                  </button>
                )}
                {onDeny && (
                  <button type="button" onClick={() => onDeny(request.id)} style={{ fontSize: 13, cursor: 'pointer' }}>
                    {t('fleet.v29.deny')}
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      {decidedList.length > 0 && (
        <>
          <h3 style={{ margin: '4px 0 0', fontSize: 14 }}>{t('fleet.v29.decidedConfirmations')}</h3>
          <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13 }}>
            {decidedList.map((request) => (
              <li key={request.id}>
                {request.action} — {request.summary} · {t(`fleet.v29.confirm.${request.status}`)}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

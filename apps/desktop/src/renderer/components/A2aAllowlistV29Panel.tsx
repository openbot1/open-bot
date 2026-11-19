import { useState } from 'react';
import { useT } from '../i18n/useT';

/**
 * A2A allowlist admin panel — fleet v29 (v1.42, Team T6).
 *
 * The allowlist is the fleet's explicit consent list: a peer may be
 * delegated to only when it is allowlisted AND its card verifies.
 * This panel shows every entry with its least-privilege scope
 * (skills, operations, per-task cost cap, concurrency cap, sensitive
 * actions the peer may even request), who added it, and whether it
 * is suspended or expired. Suspend pauses a peer instantly without
 * deleting the record; remove ends delegation immediately.
 *
 * Data comes via props (host builds the view-model from core
 * `buildFleetV29AllowlistPanel` via IPC); with no host wiring yet
 * it uses an internal demo store — the component never guesses real
 * numbers, and the demo is clearly labelled in code.
 */

export interface A2aAllowlistV29EntryView {
  peerId: string;
  addedBy: string;
  addedAt: string;
  expiresAt: string | null;
  reason: string;
  suspended: boolean;
  expired: boolean;
  cardStatus: 'verified' | 'unsigned' | 'invalid' | 'unverified' | 'stale';
  allowedSkills: string[];
  allowedOperations: string[];
  maxCostUsdPerTask: number | null;
  maxConcurrentTasks: number;
  sensitiveActionsAllowed: string[];
}

export interface A2aAllowlistV29PanelView {
  summary: string;
  entries: A2aAllowlistV29EntryView[];
  activeCount: number;
  suspendedCount: number;
  expiredCount: number;
}

export function demoA2aAllowlistV29Panel(): A2aAllowlistV29PanelView {
  return {
    summary: 'Demo allowlist (no host wiring yet).',
    entries: [
      {
        peerId: 'peer-research',
        addedBy: 'local-user',
        addedAt: '2026-11-19T00:00:00.000Z',
        expiresAt: null,
        reason: 'Trusted research peer on this machine.',
        suspended: false,
        expired: false,
        cardStatus: 'verified',
        allowedSkills: ['research', 'summarise'],
        allowedOperations: ['SendMessage', 'SendStreamingMessage', 'GetTask', 'ListTasks', 'CancelTask'],
        maxCostUsdPerTask: 5,
        maxConcurrentTasks: 3,
        sensitiveActionsAllowed: [],
      },
      {
        peerId: 'peer-writer',
        addedBy: 'local-user',
        addedAt: '2026-11-18T00:00:00.000Z',
        expiresAt: '2026-11-18T12:00:00.000Z',
        reason: 'Trial peer, one-day access.',
        suspended: false,
        expired: true,
        cardStatus: 'unsigned',
        allowedSkills: [],
        allowedOperations: ['SendMessage', 'GetTask', 'ListTasks', 'CancelTask'],
        maxCostUsdPerTask: 1,
        maxConcurrentTasks: 1,
        sensitiveActionsAllowed: [],
      },
    ],
    activeCount: 1,
    suspendedCount: 0,
    expiredCount: 1,
  };
}

export interface A2aAllowlistV29PanelProps {
  panel?: A2aAllowlistV29PanelView;
  onSuspend?: (peerId: string) => void;
  onResume?: (peerId: string) => void;
  onRemove?: (peerId: string) => void;
}

export default function A2aAllowlistV29Panel({ panel, onSuspend, onResume, onRemove }: A2aAllowlistV29PanelProps) {
  const t = useT();
  const [expanded, setExpanded] = useState<string | null>(null);
  const view = panel ?? demoA2aAllowlistV29Panel();
  return (
    <section aria-label={t('fleet.v29.allowlistTitle')} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <h2 style={{ margin: 0 }}>{t('fleet.v29.allowlistTitle')}</h2>
      <p style={{ margin: 0, fontSize: 13, opacity: 0.8 }}>{view.summary}</p>
      <p style={{ margin: 0, fontSize: 13 }}>
        {t('fleet.v29.allowlistActive')}: {view.activeCount} · {t('fleet.v29.allowlistSuspended')}: {view.suspendedCount} ·{' '}
        {t('fleet.v29.allowlistExpired')}: {view.expiredCount}
      </p>
      <p style={{ margin: 0, fontSize: 13, opacity: 0.8 }}>{t('fleet.v29.allowlistHint')}</p>
      {view.entries.length === 0 ? (
        <p style={{ margin: 0, fontSize: 13, opacity: 0.8 }}>{t('fleet.v29.noAllowlistEntries')}</p>
      ) : (
        <ul style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 8 }}>
          {view.entries.map((entry) => {
            const isOpen = expanded === entry.peerId;
            const status = entry.expired
              ? t('fleet.v29.allowlistExpired')
              : entry.suspended
                ? t('fleet.v29.allowlistSuspended')
                : t('fleet.v29.allowlistActive');
            return (
              <li key={entry.peerId}>
                <button
                  type="button"
                  onClick={() => setExpanded(isOpen ? null : entry.peerId)}
                  style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontSize: 13, textAlign: 'left' }}
                >
                  <strong>{entry.peerId}</strong> — {status} · {t(`fleet.v29.card.${entry.cardStatus}`)}
                </button>
                {isOpen && (
                  <dl style={{ margin: '4px 0 0', fontSize: 13, display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '2px 10px' }}>
                    <dt>{t('fleet.v29.addedBy')}</dt><dd style={{ margin: 0 }}>{entry.addedBy}</dd>
                    <dt>{t('fleet.v29.addedAt')}</dt><dd style={{ margin: 0 }}>{entry.addedAt}</dd>
                    <dt>{t('fleet.v29.expiresAt')}</dt><dd style={{ margin: 0 }}>{entry.expiresAt ?? '—'}</dd>
                    <dt>{t('fleet.v29.allowlistReason')}</dt><dd style={{ margin: 0 }}>{entry.reason || '—'}</dd>
                    <dt>{t('fleet.v29.scopeSkills')}</dt><dd style={{ margin: 0 }}>{entry.allowedSkills.length > 0 ? entry.allowedSkills.join(', ') : t('fleet.v29.allSkills')}</dd>
                    <dt>{t('fleet.v29.scopeOperations')}</dt><dd style={{ margin: 0 }}>{entry.allowedOperations.join(', ')}</dd>
                    <dt>{t('fleet.v29.maxCostPerTask')}</dt><dd style={{ margin: 0 }}>{entry.maxCostUsdPerTask === null ? '—' : `$${entry.maxCostUsdPerTask.toFixed(2)}`}</dd>
                    <dt>{t('fleet.v29.maxConcurrentTasks')}</dt><dd style={{ margin: 0 }}>{entry.maxConcurrentTasks}</dd>
                    <dt>{t('fleet.v29.sensitiveActions')}</dt>
                    <dd style={{ margin: 0 }}>{entry.sensitiveActionsAllowed.length > 0 ? entry.sensitiveActionsAllowed.join(', ') : '—'}</dd>
                  </dl>
                )}
                <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
                  {entry.suspended && onResume && (
                    <button type="button" onClick={() => onResume(entry.peerId)} style={{ fontSize: 13, cursor: 'pointer' }}>
                      {t('fleet.v29.resume')}
                    </button>
                  )}
                  {!entry.suspended && !entry.expired && onSuspend && (
                    <button type="button" onClick={() => onSuspend(entry.peerId)} style={{ fontSize: 13, cursor: 'pointer' }}>
                      {t('fleet.v29.suspend')}
                    </button>
                  )}
                  {onRemove && (
                    <button type="button" onClick={() => onRemove(entry.peerId)} style={{ fontSize: 13, cursor: 'pointer' }}>
                      {t('fleet.v29.removeFromAllowlist')}
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

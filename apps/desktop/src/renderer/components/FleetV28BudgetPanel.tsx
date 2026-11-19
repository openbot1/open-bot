import { useState } from 'react';
import { useT } from '../i18n/useT';

/**
 * Fleet v28 budget panel (v1.41, Team T6) — conversation budget meter:
 * token/$ per session, the stacked meter (used vs cap), the session
 * cost, and warnings when a conversation nears its cap. A meter at
 * 70%+ shows "watch", 80%+ "warning", 90%+ "critical", 100%+
 * "exceeded" (hard cap: further records are refused). Meters that
 * used an unpriced model are labelled estimated, never exact.
 *
 * Data comes via props (host builds the view-model from core
 * `buildFleetV28BudgetPanel` via IPC); when there is no host wiring
 * yet it uses an internal demo store — the component never guesses
 * real numbers; the demo is clearly labelled in code.
 */

export interface FleetV28BudgetRowView {
  conversationId: string;
  profileId: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  capUsd: number | null;
  level: 'ok' | 'watch' | 'warning' | 'critical' | 'exceeded';
  percentUsed: number | null;
  remainingUsd: number | null;
  hasUnpricedUsage: boolean;
  blockedRecords: number;
}

export interface FleetV28BudgetPanelView {
  summary: string;
  totalCostUsd: number;
  totalTokens: number;
  meters: FleetV28BudgetRowView[];
  alerts: Array<{
    conversationId: string;
    profileId: string;
    level: string;
    costUsd: number;
    capUsd: number | null;
    percentUsed: number;
    message: string;
  }>;
  today: { totalCostUsd: number; totalTokens: number; records: number; conversations: number } | null;
}

export function demoFleetV28BudgetPanel(): FleetV28BudgetPanelView {
  return {
    summary: 'Demo fleet v28 budget panel (no host wiring yet).',
    totalCostUsd: 1.2345,
    totalTokens: 120000,
    meters: [
      {
        conversationId: 'conv-demo-1',
        profileId: 'bot-demo',
        model: 'gpt-4o-mini',
        inputTokens: 80000,
        outputTokens: 40000,
        costUsd: 1.2345,
        capUsd: 5,
        level: 'watch',
        percentUsed: 24.7,
        remainingUsd: 3.7655,
        hasUnpricedUsage: false,
        blockedRecords: 0,
      },
      {
        conversationId: 'conv-demo-2',
        profileId: 'bot-demo',
        model: 'unknown-model',
        inputTokens: 10000,
        outputTokens: 5000,
        costUsd: 0.06,
        capUsd: null,
        level: 'ok',
        percentUsed: null,
        remainingUsd: null,
        hasUnpricedUsage: true,
        blockedRecords: 2,
      },
    ],
    alerts: [],
    today: { totalCostUsd: 1.2945, totalTokens: 135000, records: 12, conversations: 2 },
  };
}

function meterBarColor(level: FleetV28BudgetRowView['level']): string {
  if (level === 'exceeded' || level === 'critical') return '#c0392b';
  if (level === 'warning') return '#d97706';
  if (level === 'watch') return '#2563eb';
  return '#16a34a';
}

export default function FleetV28BudgetPanel({ panel }: { panel?: FleetV28BudgetPanelView }) {
  const t = useT();
  const [expanded, setExpanded] = useState<string | null>(null);
  const view = panel ?? demoFleetV28BudgetPanel();
  const topSpender = view.meters.length > 0 ? view.meters[0] : null;
  return (
    <section aria-label={t('fleet.v28.budgetTitle')} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <h2 style={{ margin: 0 }}>{t('fleet.v28.budgetTitle')}</h2>
      <p style={{ margin: 0, fontSize: 13, opacity: 0.8 }}>{view.summary}</p>
      <p style={{ margin: 0, fontSize: 13 }}>
        {t('fleet.v28.totalCost')}: ${view.totalCostUsd.toFixed(4)} · {t('fleet.v28.totalTokens')}:{' '}
        {view.totalTokens.toLocaleString()}
      </p>
      {view.today && (
        <p style={{ margin: 0, fontSize: 13 }}>
          {t('fleet.v28.dailyTotal')}: ${view.today.totalCostUsd.toFixed(4)} · {view.today.totalTokens.toLocaleString()}{' '}
          {t('fleet.v28.tokens')} · {view.today.conversations} {t('fleet.v28.conversations')}
        </p>
      )}
      {topSpender && (
        <p style={{ margin: 0, fontSize: 13 }}>
          {t('fleet.v28.topSpender')}: <strong>{topSpender.conversationId}</strong> (${topSpender.costUsd.toFixed(4)})
        </p>
      )}
      {view.meters.length === 0 ? (
        <p style={{ margin: 0, fontSize: 13, opacity: 0.8 }}>{t('fleet.v28.noBudget')}</p>
      ) : (
        <ul style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 8 }}>
          {view.meters.map((row) => {
            const isOpen = expanded === row.conversationId;
            const pct = row.percentUsed ?? 0;
            return (
              <li key={row.conversationId}>
                <button
                  type="button"
                  onClick={() => setExpanded(isOpen ? null : row.conversationId)}
                  style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontSize: 13, textAlign: 'left' }}
                >
                  <strong>{row.conversationId}</strong> — {t('fleet.v28.sessionCost')}: ${row.costUsd.toFixed(4)} ·{' '}
                  {t(`fleet.v28.level.${row.level}`)}
                  {row.level === 'exceeded' ? ` (${t('fleet.v28.capReached')})` : ''}
                  {row.level === 'warning' || row.level === 'critical' ? ` (${t('fleet.v28.nearCap')})` : ''}
                </button>
                <div
                  role="meter"
                  aria-valuenow={row.capUsd === null ? undefined : Math.min(100, pct)}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  title={`${t('fleet.v28.used')}: ${pct}%`}
                  style={{ height: 8, borderRadius: 4, background: '#8883', overflow: 'hidden', marginTop: 4, maxWidth: 320 }}
                >
                  <div style={{ width: `${row.capUsd === null ? 100 : Math.min(100, pct)}%`, height: '100%', background: meterBarColor(row.level) }} />
                </div>
                {isOpen && (
                  <dl style={{ margin: '4px 0 0', fontSize: 13, display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '2px 10px' }}>
                    <dt>{t('fleet.v28.conversation')}</dt><dd style={{ margin: 0 }}>{row.conversationId}</dd>
                    <dt>{t('fleet.v28.profile')}</dt><dd style={{ margin: 0 }}>{row.profileId}</dd>
                    <dt>{t('fleet.v28.inputTokens')}</dt><dd style={{ margin: 0 }}>{row.inputTokens.toLocaleString()}</dd>
                    <dt>{t('fleet.v28.outputTokens')}</dt><dd style={{ margin: 0 }}>{row.outputTokens.toLocaleString()}</dd>
                    <dt>{t('fleet.v28.cost')}</dt><dd style={{ margin: 0 }}>${row.costUsd.toFixed(4)}{row.hasUnpricedUsage ? ` (${t('fleet.v28.unpriced')})` : ''}</dd>
                    <dt>{t('fleet.v28.cap')}</dt><dd style={{ margin: 0 }}>{row.capUsd === null ? '—' : `$${row.capUsd.toFixed(2)}`}</dd>
                    <dt>{t('fleet.v28.used')}</dt><dd style={{ margin: 0 }}>{row.percentUsed === null ? '—' : `${row.percentUsed}%`}</dd>
                    <dt>{t('fleet.v28.remaining')}</dt><dd style={{ margin: 0 }}>{row.remainingUsd === null ? '—' : `$${row.remainingUsd.toFixed(4)}`}</dd>
                    {row.blockedRecords > 0 && (
                      <>
                        <dt>{t('fleet.v28.blockedRecords')}</dt><dd style={{ margin: 0 }}>{row.blockedRecords}</dd>
                      </>
                    )}
                  </dl>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <h3 style={{ margin: '4px 0 0', fontSize: 14 }}>{t('fleet.v28.alerts')}</h3>
      {view.alerts.length === 0 ? (
        <p style={{ margin: 0, fontSize: 13, opacity: 0.8 }}>{t('fleet.v28.noAlerts')}</p>
      ) : (
        <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13 }}>
          {view.alerts.map((a) => (
            <li key={`${a.conversationId}-${a.percentUsed}`}>
              <strong>{a.conversationId}</strong> — {a.message}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

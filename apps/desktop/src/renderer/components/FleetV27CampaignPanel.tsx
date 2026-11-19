import { useMemo, useState } from 'react';
import { useT } from '../i18n/useT';

/**
 * Fleet v27 campaign panel (v1.40, Team T6) — tracks async run
 * campaigns: one task across many bots, with per-bot progress and a
 * finished-run history. Progressive disclosure: the top shows one
 * summary line per campaign; each campaign expands to its latest run
 * and per-bot rows on demand.
 *
 * Data comes via props (host builds the view-model from core
 * `buildFleetV27CampaignPanel` via IPC); when there is no host wiring
 * yet it uses an internal demo store — the component never guesses
 * real numbers; the demo is clearly labelled in code.
 */

export type FleetV27CampaignRunStatus =
  | 'pending'
  | 'running'
  | 'succeeded'
  | 'partial'
  | 'failed'
  | 'cancelled';

export interface FleetV27CampaignRow {
  id: string;
  name: string;
  bots: number;
  concurrency: number;
  tags: string[];
  latestRunId: string | null;
  latestStatus: FleetV27CampaignRunStatus | null;
  latestAggregate: {
    total: number;
    queued: number;
    running: number;
    succeeded: number;
    failed: number;
    timedOut: number;
    skipped: number;
    cancelled: number;
    finished: number;
    progress: number;
  } | null;
  summary: string;
}

export interface FleetV27CampaignPanelView {
  summary: string;
  campaigns: FleetV27CampaignRow[];
  activeRuns: Array<{
    runId: string;
    campaignId: string;
    status: FleetV27CampaignRunStatus;
    aggregate: FleetV27CampaignRow['latestAggregate'];
    summary: string;
  }>;
  finishedRuns: Array<{
    runId: string;
    campaignId: string;
    status: FleetV27CampaignRunStatus;
    aggregate: FleetV27CampaignRow['latestAggregate'];
    summary: string;
  }>;
}

export function demoFleetV27CampaignPanel(): FleetV27CampaignPanelView {
  return {
    summary: 'Demo fleet v27 campaign panel (no host wiring yet).',
    campaigns: [
      {
        id: 'cmp-review-sprint-12',
        name: 'Review sprint 12 PRs',
        bots: 3,
        concurrency: 2,
        tags: ['review'],
        latestRunId: 'run-0001',
        latestStatus: 'partial',
        latestAggregate: {
          total: 3, queued: 0, running: 0, succeeded: 2, failed: 1,
          timedOut: 0, skipped: 0, cancelled: 0, finished: 3, progress: 1,
        },
        summary: 'Review sprint 12 PRs: partial — 3/3 finished (2 succeeded, 1 failed, 0 timed out, 0 skipped, 0 cancelled, 0 running, 0 queued)',
      },
    ],
    activeRuns: [],
    finishedRuns: [
      {
        runId: 'run-0001',
        campaignId: 'cmp-review-sprint-12',
        status: 'partial',
        aggregate: {
          total: 3, queued: 0, running: 0, succeeded: 2, failed: 1,
          timedOut: 0, skipped: 0, cancelled: 0, finished: 3, progress: 1,
        },
        summary: 'Campaign cmp-review-sprint-12 run-0001: partial — 3/3 finished (2 succeeded, 1 failed, 0 timed out, 0 skipped, 0 cancelled, 0 running, 0 queued)',
      },
    ],
  };
}

export default function FleetV27CampaignPanel({ panel }: { panel?: FleetV27CampaignPanelView }) {
  const t = useT();
  const view = useMemo(() => panel ?? demoFleetV27CampaignPanel(), [panel]);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  return (
    <section aria-label={t('fleet.v27.campaignTitle')} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <header style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
        <h2 style={{ margin: 0 }}>{t('fleet.v27.campaignTitle')}</h2>
        <span style={{ fontSize: 12, opacity: 0.7 }}>{view.summary}</span>
        <span style={{ marginLeft: 'auto', fontSize: 12 }}>
          {t('fleet.v27.activeRuns', { count: view.activeRuns.length })} · {t('fleet.v27.finishedRuns', { count: view.finishedRuns.length })}
        </span>
      </header>

      {view.campaigns.length === 0 ? (
        <p style={{ margin: 0, fontSize: 13, opacity: 0.8 }}>{t('fleet.v27.noCampaigns')}</p>
      ) : (
        <ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 6 }}>
          {view.campaigns.map((row) => (
            <li key={row.id} style={{ border: '1px solid var(--border, #ddd)', borderRadius: 8, padding: '8px 10px' }}>
              <button
                type="button"
                onClick={() => setExpandedId(expandedId === row.id ? null : row.id)}
                style={{ all: 'unset', cursor: 'pointer', display: 'block', width: '100%' }}
              >
                <strong>{row.name}</strong>
                <span style={{ display: 'block', fontSize: 13, opacity: 0.85 }}>{row.summary}</span>
                <span style={{ display: 'block', fontSize: 12, opacity: 0.7 }}>
                  {t('fleet.v27.bots', { count: row.bots })} · {t('fleet.v27.concurrency', { count: row.concurrency })}
                  {row.tags.length > 0 ? ` · ${row.tags.join(', ')}` : ''}
                </span>
              </button>
              {expandedId === row.id && row.latestAggregate ? (
                <dl style={{ margin: '8px 0 0', display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '2px 12px', fontSize: 13 }}>
                  <dt>{t('fleet.v27.latestRun')}</dt><dd style={{ margin: 0 }}>{row.latestRunId ?? '—'}</dd>
                  <dt>{t('fleet.v27.status')}</dt><dd style={{ margin: 0 }}>{row.latestStatus ? t(`fleet.v27.status.${row.latestStatus}`) : '—'}</dd>
                  <dt>{t('fleet.v27.progress')}</dt><dd style={{ margin: 0 }}>{Math.round(row.latestAggregate.progress * 100)}% ({row.latestAggregate.finished}/{row.latestAggregate.total})</dd>
                  <dt>{t('fleet.v27.succeeded')}</dt><dd style={{ margin: 0 }}>{row.latestAggregate.succeeded}</dd>
                  <dt>{t('fleet.v27.failed')}</dt><dd style={{ margin: 0 }}>{row.latestAggregate.failed}</dd>
                  <dt>{t('fleet.v27.timedOut')}</dt><dd style={{ margin: 0 }}>{row.latestAggregate.timedOut}</dd>
                  <dt>{t('fleet.v27.skipped')}</dt><dd style={{ margin: 0 }}>{row.latestAggregate.skipped}</dd>
                  <dt>{t('fleet.v27.cancelled')}</dt><dd style={{ margin: 0 }}>{row.latestAggregate.cancelled}</dd>
                  <dt>{t('fleet.v27.running')}</dt><dd style={{ margin: 0 }}>{row.latestAggregate.running}</dd>
                  <dt>{t('fleet.v27.queued')}</dt><dd style={{ margin: 0 }}>{row.latestAggregate.queued}</dd>
                </dl>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      <h3 style={{ margin: '4px 0 0', fontSize: 14 }}>{t('fleet.v27.history')}</h3>
      {view.finishedRuns.length === 0 ? (
        <p style={{ margin: 0, fontSize: 13, opacity: 0.8 }}>{t('fleet.v27.noFinishedRuns')}</p>
      ) : (
        <ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 6 }}>
          {view.finishedRuns.map((run) => (
            <li key={run.runId} style={{ border: '1px solid var(--border, #ddd)', borderRadius: 8, padding: '8px 10px', fontSize: 13 }}>
              <strong>{run.runId}</strong> — {t(`fleet.v27.status.${run.status}`)}
              <span style={{ display: 'block', opacity: 0.85 }}>{run.summary}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

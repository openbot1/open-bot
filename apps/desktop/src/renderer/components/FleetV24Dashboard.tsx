import { useMemo, useState } from 'react';
import { useT } from '../i18n/useT';

/**
 * Fleet v24 automation dashboard (v1.37, Team T6) — the single entry
 * screen for the v24 panel group (progressive disclosure): automations
 * grouped by tag, filterable by owner, with per-tag/per-owner stats and
 * bulk enable/disable/pause/resume per tag group.
 *
 * Data comes via props (host builds the view-model from core
 * `buildFleetV24AutomationDashboardPanel` via IPC); when there is no
 * host wiring yet it uses an internal demo store — the component never
 * guesses real numbers; the demo is clearly labelled in code.
 */

export type FleetV24AutomationStatus =
  | 'idle'
  | 'running'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'disabled';

export interface FleetV24AutomationRowView {
  id: string;
  name: string;
  owner: string;
  tags: string[];
  status: FleetV24AutomationStatus;
  schedule: string | null;
  runs: number;
  successes: number;
  failures: number;
  stopped: number;
  successRatePct: number;
  lastRunAtMs: number | null;
  lastFinishedAtMs: number | null;
  note: string | null;
}

export interface FleetV24TagGroupView {
  tag: string;
  automations: FleetV24AutomationRowView[];
  stats: {
    total: number;
    running: number;
    failed: number;
    paused: number;
    idle: number;
    completed: number;
    disabled: number;
    runs: number;
    successes: number;
    failures: number;
    stopped: number;
    successRate: number;
    failureRate: number;
  };
  owners: string[];
}

export interface FleetV24OwnerSliceView {
  owner: string;
  automations: FleetV24AutomationRowView[];
  stats: FleetV24TagGroupView['stats'];
  tags: string[];
}

export interface FleetV24AutomationDashboardView {
  summary: string;
  stats: FleetV24TagGroupView['stats'];
  tagGroups: FleetV24TagGroupView[];
  ownerSlices: FleetV24OwnerSliceView[];
  running: FleetV24AutomationRowView[];
  failed: FleetV24AutomationRowView[];
  paused: FleetV24AutomationRowView[];
  all: FleetV24AutomationRowView[];
}

export function demoFleetV24AutomationDashboard(): FleetV24AutomationDashboardView {
  const nightly: FleetV24AutomationRowView = {
    id: 'auto-nightly-backup', name: 'Nightly backup', owner: 'team-data',
    tags: ['nightly', 'backup'], status: 'completed', schedule: '0 2 * * *',
    runs: 42, successes: 40, failures: 1, stopped: 1, successRatePct: 98,
    lastRunAtMs: 1794393600000, lastFinishedAtMs: 1794397200000, note: null,
  };
  const report: FleetV24AutomationRowView = {
    id: 'auto-weekly-report', name: 'Weekly report', owner: 'team-data',
    tags: ['nightly', 'report'], status: 'running', schedule: '0 6 * * 1',
    runs: 12, successes: 11, failures: 1, stopped: 0, successRatePct: 92,
    lastRunAtMs: 1794393600000, lastFinishedAtMs: null, note: null,
  };
  const cleanup: FleetV24AutomationRowView = {
    id: 'auto-cleanup', name: 'Temp cleanup', owner: 'team-ops',
    tags: ['maintenance'], status: 'failed', schedule: '0 3 * * *',
    runs: 30, successes: 27, failures: 3, stopped: 0, successRatePct: 90,
    lastRunAtMs: 1794390000000, lastFinishedAtMs: 1794391800000,
    note: 'Disk full on node-2 — paused until the node is fixed.',
  };
  const stats = {
    total: 3, running: 1, failed: 1, paused: 0, idle: 0, completed: 1, disabled: 0,
    runs: 84, successes: 78, failures: 5, stopped: 1,
    successRate: 0.94, failureRate: 0.06,
  };
  return {
    summary: '3 automations · 1 running · 1 failed · 0 paused · 0 disabled · 84 runs (78 ok, 5 failed, 1 stopped)',
    stats,
    tagGroups: [
      { tag: 'backup', automations: [nightly], stats: { ...stats, total: 1, running: 0, failed: 0, completed: 1, runs: 42, successes: 40, failures: 1, stopped: 1, successRate: 0.98, failureRate: 0.02 }, owners: ['team-data'] },
      { tag: 'maintenance', automations: [cleanup], stats: { ...stats, total: 1, running: 0, failed: 1, completed: 0, runs: 30, successes: 27, failures: 3, stopped: 0, successRate: 0.9, failureRate: 0.1 }, owners: ['team-ops'] },
      { tag: 'nightly', automations: [nightly, report], stats: { ...stats, total: 2, running: 1, failed: 0, completed: 1, runs: 54, successes: 51, failures: 2, stopped: 1, successRate: 0.96, failureRate: 0.04 }, owners: ['team-data'] },
      { tag: 'report', automations: [report], stats: { ...stats, total: 1, running: 1, failed: 0, completed: 0, runs: 12, successes: 11, failures: 1, stopped: 0, successRate: 0.92, failureRate: 0.08 }, owners: ['team-data'] },
    ],
    ownerSlices: [
      { owner: 'team-data', automations: [nightly, report], stats: { ...stats, total: 2, running: 1, failed: 0, completed: 1, runs: 54, successes: 51, failures: 2, stopped: 1, successRate: 0.96, failureRate: 0.04 }, tags: ['backup', 'nightly', 'report'] },
      { owner: 'team-ops', automations: [cleanup], stats: { ...stats, total: 1, running: 0, failed: 1, completed: 0, runs: 30, successes: 27, failures: 3, stopped: 0, successRate: 0.9, failureRate: 0.1 }, tags: ['maintenance'] },
    ],
    running: [report],
    failed: [cleanup],
    paused: [],
    all: [cleanup, nightly, report],
  };
}

function statusLabel(t: (key: string) => string, status: FleetV24AutomationStatus): string {
  return t(`fleet.v24.${status}`);
}

export interface FleetV24DashboardProps {
  view?: FleetV24AutomationDashboardView;
  onBack?: () => void;
  onOpenStopHook?: () => void;
  onOpenCidr?: () => void;
  onEnableTag?: (tag: string) => void;
  onDisableTag?: (tag: string) => void;
  onPauseTag?: (tag: string) => void;
  onResumeTag?: (tag: string) => void;
}

export default function FleetV24Dashboard(props: FleetV24DashboardProps) {
  const t = useT();
  const [view] = useState<FleetV24AutomationDashboardView>(() => props.view ?? demoFleetV24AutomationDashboard());
  const [tagFilter, setTagFilter] = useState<string>('');
  const [ownerFilter, setOwnerFilter] = useState<string>('');

  const tags = useMemo(() => view.tagGroups.map((g) => g.tag), [view]);
  const owners = useMemo(() => view.ownerSlices.map((s) => s.owner), [view]);

  const filtered = useMemo(() => {
    return view.all.filter(
      (a) =>
        (tagFilter === '' || a.tags.includes(tagFilter)) &&
        (ownerFilter === '' || a.owner === ownerFilter),
    );
  }, [view, tagFilter, ownerFilter]);

  const filtering = tagFilter !== '' || ownerFilter !== '';

  return (
    <div className="panel fleet-v24-dashboard">
      <div className="panel-header">
        {props.onBack ? (
          <button type="button" className="btn-ghost" onClick={props.onBack}>
            ← {t('fleet.v24.dashboard')}
          </button>
        ) : null}
        <h2>{t('fleet.v24.automationDashboard')}</h2>
      </div>

      <p className="panel-summary">{view.summary}</p>

      <div className="fleet-v24-score-cards">
        <div className="score-card">
          <div className="score-card-title">{t('fleet.v24.total')}</div>
          <div className="score-card-body">{String(view.stats.total)}</div>
          <div className="score-card-badge">
            {`${view.stats.running} ${t('fleet.v24.running')} · ${view.stats.failed} ${t('fleet.v24.failed')}`}
          </div>
        </div>
        <div className="score-card">
          <div className="score-card-title">{t('fleet.v24.runs')}</div>
          <div className="score-card-body">{String(view.stats.runs)}</div>
          <div className="score-card-badge">
            {`${view.stats.successes} ${t('fleet.v24.successes')} · ${view.stats.failures} ${t('fleet.v24.failures')} · ${view.stats.stopped} ${t('fleet.v24.stopped')}`}
          </div>
        </div>
        <div className="score-card">
          <div className="score-card-title">{t('fleet.v24.successRate')}</div>
          <div className="score-card-body">{`${Math.round(view.stats.successRate * 100)}%`}</div>
          <div className="score-card-badge">{t('fleet.v24.failureRate') + `: ${Math.round(view.stats.failureRate * 100)}%`}</div>
        </div>
      </div>

      <div className="fleet-v24-filters">
        <label>
          {t('fleet.v24.filterByTag')}
          <select value={tagFilter} onChange={(e) => setTagFilter(e.target.value)}>
            <option value="">{t('fleet.v24.allTags')}</option>
            {tags.map((tag) => (
              <option key={tag} value={tag}>{tag}</option>
            ))}
          </select>
        </label>
        <label>
          {t('fleet.v24.filterByOwner')}
          <select value={ownerFilter} onChange={(e) => setOwnerFilter(e.target.value)}>
            <option value="">{t('fleet.v24.allOwners')}</option>
            {owners.map((owner) => (
              <option key={owner} value={owner}>{owner}</option>
            ))}
          </select>
        </label>
        {filtering ? (
          <button
            type="button"
            className="btn-ghost"
            onClick={() => {
              setTagFilter('');
              setOwnerFilter('');
            }}
          >
            {t('fleet.v24.clearFilter')}
          </button>
        ) : null}
      </div>

      <h3>{t('fleet.v24.tags')}</h3>
      {view.tagGroups.length === 0 ? (
        <p className="panel-empty">{t('fleet.v24.noAutomations')}</p>
      ) : (
        <ul className="fleet-v24-tag-groups">
          {view.tagGroups.map((group) => (
            <li key={group.tag} className="fleet-v24-tag-group">
              <div className="fleet-v24-tag-group-head">
                <strong>{group.tag}</strong>
                <span>
                  {`${group.stats.total} · ${group.stats.running} ${t('fleet.v24.running')} · ${group.stats.failed} ${t('fleet.v24.failed')} · ${group.stats.paused} ${t('fleet.v24.paused')}`}
                </span>
              </div>
              <div className="fleet-v24-tag-group-owners">
                {t('fleet.v24.owners')}: {group.owners.join(', ')}
              </div>
              <div className="fleet-v24-tag-group-actions">
                <button type="button" className="btn-ghost" onClick={() => props.onEnableTag?.(group.tag)}>
                  {t('fleet.v24.enableTag')}
                </button>
                <button type="button" className="btn-ghost" onClick={() => props.onDisableTag?.(group.tag)}>
                  {t('fleet.v24.disableTag')}
                </button>
                <button type="button" className="btn-ghost" onClick={() => props.onPauseTag?.(group.tag)}>
                  {t('fleet.v24.pauseTag')}
                </button>
                <button type="button" className="btn-ghost" onClick={() => props.onResumeTag?.(group.tag)}>
                  {t('fleet.v24.resumeTag')}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <h3>
        {t('fleet.v24.automations')}
        {filtering ? ` (${filtered.length})` : ''}
      </h3>
      {filtered.length === 0 ? (
        <p className="panel-empty">{t('fleet.v24.noAutomations')}</p>
      ) : (
        <table className="fleet-v24-table">
          <thead>
            <tr>
              <th>{t('fleet.v24.automation')}</th>
              <th>{t('fleet.v24.owner')}</th>
              <th>{t('fleet.v24.tags')}</th>
              <th>{t('fleet.v24.status')}</th>
              <th>{t('fleet.v24.runs')}</th>
              <th>{t('fleet.v24.successRate')}</th>
              <th>{t('fleet.v24.schedule')}</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((a) => (
              <tr key={a.id}>
                <td>
                  <div>{a.name}</div>
                  <div className="fleet-v24-muted">{a.id}</div>
                  {a.note ? <div className="fleet-v24-muted">{a.note}</div> : null}
                </td>
                <td>{a.owner}</td>
                <td>{a.tags.join(', ')}</td>
                <td>{statusLabel(t, a.status)}</td>
                <td>{`${a.runs} (${a.successes}/${a.failures}/${a.stopped})`}</td>
                <td>{`${a.successRatePct}%`}</td>
                <td>{a.schedule ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <div className="fleet-v24-links">
        {props.onOpenStopHook ? (
          <button type="button" className="btn-ghost" onClick={props.onOpenStopHook}>
            {t('fleet.v24.stopHook')}
          </button>
        ) : null}
        {props.onOpenCidr ? (
          <button type="button" className="btn-ghost" onClick={props.onOpenCidr}>
            {t('fleet.v24.cidrRouter')}
          </button>
        ) : null}
      </div>
    </div>
  );
}

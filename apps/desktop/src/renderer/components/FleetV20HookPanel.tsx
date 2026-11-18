import { useState } from 'react';
import { useT } from '../i18n/useT';

/**
 * Fleet v20 hook panel (v1.33, Team T6) — manage hooks: hook list,
 * events, enable/disable, reset errors, latest block log.
 *
 * Data comes via props (host builds the view-model from core
 * `buildHookV20Panel` via IPC); when there is no host wiring yet it
 * uses an internal demo store — the component never guesses real
 * numbers; the demo is clearly labelled in code.
 */

export interface FleetV20HookPanelRowView {
  id: string;
  name: string;
  description: string;
  eventPattern: string;
  blocking: boolean;
  priority: number;
  enabled: boolean;
  errored: boolean;
  lastError?: string;
  runCount: number;
  blockCount: number;
  consecutiveErrors: number;
}

export interface FleetV20HookPanelBlockView {
  id: string;
  hookId: string;
  event: string;
  reason: string;
  durationMs: number;
  at: number;
}

export interface FleetV20HookPanelView {
  summary: string;
  total: number;
  enabled: number;
  blocking: number;
  errored: number;
  totalRuns: number;
  totalBlocks: number;
  rows: FleetV20HookPanelRowView[];
  recentBlocks: FleetV20HookPanelBlockView[];
  erroredHookIds: string[];
}

const T0 = Date.UTC(2026, 10, 17, 0, 0, 0);

export function demoFleetV20HookPanel(): FleetV20HookPanelView {
  return {
    summary: 'Hook: 2/3 enabled, blocked 2 times',
    total: 3,
    enabled: 2,
    blocking: 2,
    errored: 0,
    totalRuns: 12,
    totalBlocks: 2,
    rows: [
      {
        id: 'guard-no-shell', name: 'Guard No Shell', description: 'Block shell_exec outside the allowlist.',
        eventPattern: 'tool.before', blocking: true, priority: 10, enabled: true, errored: false,
        runCount: 8, blockCount: 2, consecutiveErrors: 0,
      },
      {
        id: 'log-file-write', name: 'Log File Write', description: 'Log every file write.',
        eventPattern: 'file.write', blocking: false, priority: 50, enabled: true, errored: false,
        runCount: 4, blockCount: 0, consecutiveErrors: 0,
      },
      {
        id: 'notify-eval', name: 'Notify Eval', description: 'Notify when an eval finishes.',
        eventPattern: 'eval.run', blocking: false, priority: 90, enabled: false, errored: false,
        runCount: 0, blockCount: 0, consecutiveErrors: 0,
      },
    ],
    recentBlocks: [
      {
        id: 'guard-no-shell-2', hookId: 'guard-no-shell', event: 'tool.before:shell_exec',
        reason: 'Command "rm -rf /" is not in the allowlist.', durationMs: 3, at: T0,
      },
      {
        id: 'guard-no-shell-1', hookId: 'guard-no-shell', event: 'tool.before:shell_exec',
        reason: 'Command "curl http://x" targets an unapproved host.', durationMs: 2, at: T0 - 60000,
      },
    ],
    erroredHookIds: [],
  };
}

export interface FleetV20HookPanelProps {
  view?: FleetV20HookPanelView;
  onBack?: () => void;
  onEnable?: (hookId: string) => void;
  onDisable?: (hookId: string) => void;
  onResetError?: (hookId: string) => void;
}

export default function FleetV20HookPanel(props: FleetV20HookPanelProps) {
  const t = useT();
  const [view] = useState<FleetV20HookPanelView>(() => props.view ?? demoFleetV20HookPanel());
  const [filter, setFilter] = useState<'all' | 'blocking' | 'errored'>('all');
  const shownRows =
    filter === 'blocking'
      ? view.rows.filter((r) => r.blocking)
      : filter === 'errored'
        ? view.rows.filter((r) => r.errored)
        : view.rows;

  return (
    <div className="panel fleet-v20-hook-panel">
      <div className="panel-header">
        {props.onBack ? (
          <button type="button" className="btn-ghost" onClick={props.onBack}>
            ← {t('fleetV20.back')}
          </button>
        ) : null}
        <h2>{t('hookV20.title')}</h2>
      </div>

      <p className="panel-summary">{view.summary}</p>

      <div className="fleet-v20-score-cards">
        <div className="score-card">
          <span className="score-label">{t('fleetV20.enabled')}</span>
          <strong className="score-value">{view.enabled}/{view.total}</strong>
        </div>
        <div className="score-card">
          <span className="score-label">{t('hookV20.totalBlocks')}</span>
          <strong className="score-value">{view.totalBlocks}</strong>
          <span className="score-sub">{view.totalRuns} {t('hookV20.totalRuns')}</span>
        </div>
        <div className="score-card">
          <span className="score-label">{t('hookV20.erroredHooks')}</span>
          <strong className="score-value">{view.errored}</strong>
        </div>
      </div>

      <div className="fleet-v20-filter">
        <button type="button" className={filter === 'all' ? 'btn-active' : 'btn-ghost'} onClick={() => setFilter('all')}>
          {t('fleetV20.all')} ({view.rows.length})
        </button>
        <button type="button" className={filter === 'blocking' ? 'btn-active' : 'btn-ghost'} onClick={() => setFilter('blocking')}>
          {t('hookV20.blocking')} ({view.blocking})
        </button>
        <button type="button" className={filter === 'errored' ? 'btn-active' : 'btn-ghost'} onClick={() => setFilter('errored')}>
          {t('fleetV20.error')} ({view.errored})
        </button>
      </div>

      <table className="table">
        <thead>
          <tr>
            <th>Hook</th>
            <th>{t('hookV20.eventPattern')}</th>
            <th>{t('hookV20.blocking')}</th>
            <th>{t('hookV20.priority')}</th>
            <th>{t('hookV20.runCount')}</th>
            <th>{t('hookV20.blockCount')}</th>
            <th>{t('fleetV20.status')}</th>
            <th>{t('fleetV20.actions')}</th>
          </tr>
        </thead>
        <tbody>
          {shownRows.map((r) => (
            <tr key={r.id} className={r.errored ? 'row-attention' : ''}>
              <td>
                <strong>{r.name}</strong>
                <div className="row-sub">{r.id}</div>
                <div className="row-sub">{r.description}</div>
                {r.lastError ? <div className="row-error">{r.lastError}</div> : null}
              </td>
              <td>{r.eventPattern}</td>
              <td>{r.blocking ? t('fleetV20.yes') : t('fleetV20.no')}</td>
              <td>{r.priority}</td>
              <td>{r.runCount}</td>
              <td>{r.blockCount}</td>
              <td>{r.errored ? t('fleetV20.error') : r.enabled ? t('fleetV20.enabled') : t('fleetV20.disabled')}</td>
              <td>
                {r.errored ? (
                  <button type="button" className="btn-ghost" onClick={() => props.onResetError?.(r.id)}>
                    {t('hookV20.resetError')}
                  </button>
                ) : r.enabled ? (
                  <button type="button" className="btn-ghost" onClick={() => props.onDisable?.(r.id)}>
                    {t('pluginV20.disable')}
                  </button>
                ) : (
                  <button type="button" className="btn-ghost" onClick={() => props.onEnable?.(r.id)}>
                    {t('pluginV20.enable')}
                  </button>
                )}
              </td>
            </tr>
          ))}
          {shownRows.length === 0 ? (
            <tr>
              <td colSpan={8}>{t('fleetV20.noResults')}</td>
            </tr>
          ) : null}
        </tbody>
      </table>

      <h3>
        {t('hookV20.recentBlocks')} ({view.recentBlocks.length})
      </h3>
      {view.recentBlocks.length === 0 ? (
        <p>{t('fleetV20.noResults')}</p>
      ) : (
        <ul className="alert-list">
          {view.recentBlocks.map((b) => (
            <li key={b.id} className="alert-item alert-warning">
              <strong>[{b.hookId}]</strong> {b.event} — {b.reason}
              <span className="alert-meta"> {b.durationMs}ms · {new Date(b.at).toLocaleString()}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

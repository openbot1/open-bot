import { useMemo, useState } from 'react';
import { useT } from '../i18n/useT';

/**
 * Fleet v20 plugin panel (v1.33, Team T6) — manage plugins: list,
 * install/remove/enable/disable, approve dangerous permissions, dependency warnings.
 *
 * Data comes via props (host builds the view-model from core
 * `buildPluginV20Panel` via IPC); when there is no host wiring yet it
 * uses an internal demo store — the component never guesses real
 * numbers; the demo is clearly labelled in code. Only actions the core
 * allows (`allowedActions`) are shown as buttons.
 */

export interface FleetV20PluginPanelRowView {
  id: string;
  name: string;
  description: string;
  version: string;
  author: string;
  capabilities: string[];
  status: string;
  risk: string;
  unapprovedDangerous: string[];
  dependencyProblems: string[];
  allowedActions: string[];
  installedAt?: number;
  enabledAt?: number;
  errorReason?: string;
}

export interface FleetV20PluginPanelView {
  summary: string;
  total: number;
  enabled: number;
  errored: number;
  highRisk: number;
  unapprovedDangerous: number;
  dependencyProblems: number;
  rows: FleetV20PluginPanelRowView[];
  dependencyErrorPluginIds: string[];
}

const T0 = Date.UTC(2026, 10, 17, 0, 0, 0);

export function demoFleetV20PluginPanel(): FleetV20PluginPanelView {
  return {
    summary: 'Plugin: 1 enabled / 3 total, 1 dangerous permission unapproved, 1 dependency error',
    total: 3,
    enabled: 1,
    errored: 0,
    highRisk: 0,
    unapprovedDangerous: 1,
    dependencyProblems: 1,
    rows: [
      {
        id: 'weather-tools', name: 'Weather Tools', description: 'Multi-source weather tool.',
        version: '1.2.0', author: 'open-bot', capabilities: ['tools'], status: 'enabled',
        risk: 'low', unapprovedDangerous: [], dependencyProblems: [],
        allowedActions: ['disable', 'uninstall'], installedAt: T0, enabledAt: T0,
      },
      {
        id: 'shell-runner', name: 'Shell Runner', description: 'Run shell from the agent.',
        version: '0.9.0', author: 'open-bot', capabilities: ['tools'], status: 'installed',
        risk: 'medium', unapprovedDangerous: ['shell.exec'], dependencyProblems: [],
        allowedActions: ['enable', 'uninstall', 'approve-permission'], installedAt: T0,
      },
      {
        id: 'report-pack', name: 'Report Pack', description: 'Export a PDF report.',
        version: '2.0.0', author: 'open-bot', capabilities: ['commands'], status: 'available',
        risk: 'low', unapprovedDangerous: [], dependencyProblems: ['Missing core-utils (^2.0.0)'],
        allowedActions: ['install'],
      },
    ],
    dependencyErrorPluginIds: ['report-pack'],
  };
}

function statusLabel(t: (key: string) => string, status: string): string {
  switch (status) {
    case 'enabled':
      return t('fleetV20.enabled');
    case 'disabled':
      return t('fleetV20.disabled');
    case 'installed':
      return t('fleetV20.installed');
    case 'error':
      return t('fleetV20.error');
    case 'uninstalled':
      return t('pluginV20.uninstall');
    default:
      return t('fleetV20.available');
  }
}

function actionLabel(t: (key: string) => string, action: string): string {
  switch (action) {
    case 'install':
      return t('pluginV20.install');
    case 'enable':
      return t('pluginV20.enable');
    case 'disable':
      return t('pluginV20.disable');
    case 'uninstall':
      return t('pluginV20.uninstall');
    case 'approve-permission':
      return t('pluginV20.approvePermission');
    default:
      return action;
  }
}

export interface FleetV20PluginPanelProps {
  view?: FleetV20PluginPanelView;
  onBack?: () => void;
  onInstall?: (pluginId: string) => void;
  onEnable?: (pluginId: string) => void;
  onDisable?: (pluginId: string) => void;
  onUninstall?: (pluginId: string) => void;
  onApprovePermission?: (pluginId: string, permissionName: string) => void;
}

export default function FleetV20PluginPanel(props: FleetV20PluginPanelProps) {
  const t = useT();
  const [view] = useState<FleetV20PluginPanelView>(() => props.view ?? demoFleetV20PluginPanel());
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<'all' | 'attention'>('all');
  const shownRows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return view.rows.filter((r) => {
      if (filter === 'attention' && !(r.status === 'error' || r.unapprovedDangerous.length > 0 || r.dependencyProblems.length > 0)) return false;
      if (q && !`${r.id} ${r.name} ${r.description}`.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [view.rows, query, filter]);

  const fireAction = (row: FleetV20PluginPanelRowView, action: string) => {
    if (action === 'install') props.onInstall?.(row.id);
    else if (action === 'enable') props.onEnable?.(row.id);
    else if (action === 'disable') props.onDisable?.(row.id);
    else if (action === 'uninstall') props.onUninstall?.(row.id);
    else if (action === 'approve-permission' && row.unapprovedDangerous[0]) {
      props.onApprovePermission?.(row.id, row.unapprovedDangerous[0]);
    }
  };

  return (
    <div className="panel fleet-v20-plugin-panel">
      <div className="panel-header">
        {props.onBack ? (
          <button type="button" className="btn-ghost" onClick={props.onBack}>
            ← {t('fleetV20.back')}
          </button>
        ) : null}
        <h2>{t('pluginV20.title')}</h2>
      </div>

      <p className="panel-summary">{view.summary}</p>

      <div className="fleet-v20-score-cards">
        <div className="score-card">
          <span className="score-label">{t('fleetV20.enabled')}</span>
          <strong className="score-value">{view.enabled}/{view.total}</strong>
        </div>
        <div className="score-card">
          <span className="score-label">{t('pluginV20.unapprovedPermissions')}</span>
          <strong className="score-value">{view.unapprovedDangerous}</strong>
        </div>
        <div className="score-card">
          <span className="score-label">{t('pluginV20.dependencyProblems')}</span>
          <strong className="score-value">{view.dependencyProblems}</strong>
        </div>
      </div>

      <div className="fleet-v20-filter">
        <input
          type="search"
          value={query}
          placeholder={t('fleetV20.searchPlaceholder')}
          onChange={(e) => setQuery(e.target.value)}
        />
        <button type="button" className={filter === 'all' ? 'btn-active' : 'btn-ghost'} onClick={() => setFilter('all')}>
          {t('fleetV20.all')} ({view.rows.length})
        </button>
        <button type="button" className={filter === 'attention' ? 'btn-active' : 'btn-ghost'} onClick={() => setFilter('attention')}>
          {t('fleetV20.attention')} ({view.dependencyErrorPluginIds.length + view.rows.filter((r) => r.unapprovedDangerous.length > 0).length})
        </button>
      </div>

      <table className="table">
        <thead>
          <tr>
            <th>Plugin</th>
            <th>{t('pluginV20.version')}</th>
            <th>{t('fleetV20.status')}</th>
            <th>{t('pluginV20.risk')}</th>
            <th>{t('pluginV20.unapprovedPermissions')}</th>
            <th>{t('pluginV20.dependencyProblems')}</th>
            <th>{t('fleetV20.actions')}</th>
          </tr>
        </thead>
        <tbody>
          {shownRows.map((r) => (
            <tr key={r.id} className={r.status === 'error' || r.dependencyProblems.length > 0 ? 'row-attention' : ''}>
              <td>
                <strong>{r.name}</strong>
                <div className="row-sub">{r.id} · {r.author} · {r.capabilities.join(', ')}</div>
                <div className="row-sub">{r.description}</div>
                {r.errorReason ? <div className="row-error">{r.errorReason}</div> : null}
              </td>
              <td>{r.version}</td>
              <td>{statusLabel(t, r.status)}</td>
              <td>{r.risk}</td>
              <td>{r.unapprovedDangerous.length > 0 ? r.unapprovedDangerous.join(', ') : '—'}</td>
              <td>{r.dependencyProblems.length > 0 ? r.dependencyProblems.join('; ') : '—'}</td>
              <td>
                {r.allowedActions.map((a) => (
                  <button key={a} type="button" className="btn-ghost" onClick={() => fireAction(r, a)}>
                    {actionLabel(t, a)}
                  </button>
                ))}
              </td>
            </tr>
          ))}
          {shownRows.length === 0 ? (
            <tr>
              <td colSpan={7}>{t('fleetV20.noResults')}</td>
            </tr>
          ) : null}
        </tbody>
      </table>
    </div>
  );
}

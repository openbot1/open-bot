import { Fragment, useMemo, useState } from 'react';
import { useT } from '../i18n/useT';

/**
 * Plugin store v19 (v1.29, Team T6) — plugin list with SDK v4
 * lifecycle, capabilities, permission approvals, sandbox limits,
 * load order.
 *
 * Data comes via props (host builds the view-model from core
 * `buildFleetV19PluginStorePanel` via IPC); when there is no host
 * wiring yet it uses an internal demo store — the component never
 * guesses real numbers; the demo is clearly labelled in code.
 */

export interface PluginStoreV19PluginView {
  pluginId: string;
  name: string;
  version: string;
  sdkVersion: number;
  lifecycle: string;
  capabilities: string[];
  permissions: string[];
  approvedPermissions: string[];
  unapprovedPermissions: string[];
  tools: string[];
  dependsOn: string[];
  dependencyErrors: string[];
  lastReason: string;
}

export interface PluginStoreV19ViewModel {
  total: number;
  enabled: number;
  disabled: number;
  installed: number;
  uninstalled: number;
  enabledWithHighRiskApproved: number;
  loadOrder: string[];
  loadOrderOk: boolean;
  loadOrderError: string;
  plugins: PluginStoreV19PluginView[];
  summary: string;
}

export function demoPluginStoreV19(): PluginStoreV19ViewModel {
  return {
    total: 3,
    enabled: 1,
    disabled: 1,
    installed: 1,
    uninstalled: 0,
    enabledWithHighRiskApproved: 0,
    loadOrder: ['notes-tools'],
    loadOrderOk: true,
    loadOrderError: '',
    plugins: [
      {
        pluginId: 'notes-tools', name: 'Notes Tools', version: '1.2.0', sdkVersion: 4,
        lifecycle: 'enabled', capabilities: ['tools@1.2', 'fs.read@2.1'],
        permissions: ['fs'], approvedPermissions: [], unapprovedPermissions: ['fs'],
        tools: ['notes.search', 'notes.create'], dependsOn: [], dependencyErrors: [],
        lastReason: 'enabled',
      },
      {
        pluginId: 'web-fetch', name: 'Web Fetch', version: '0.9.0', sdkVersion: 4,
        lifecycle: 'installed', capabilities: ['tools@1.0', 'network.fetch@1.3'],
        permissions: ['network'], approvedPermissions: [], unapprovedPermissions: ['network'],
        tools: ['web.fetch'], dependsOn: [], dependencyErrors: [],
        lastReason: 'installed',
      },
      {
        pluginId: 'shell-runner', name: 'Shell Runner', version: '2.0.1', sdkVersion: 4,
        lifecycle: 'disabled', capabilities: ['tools@1.0', 'shell.exec@1.1'],
        permissions: ['shell'], approvedPermissions: [], unapprovedPermissions: ['shell'],
        tools: ['shell.run'], dependsOn: ['notes-tools ^1.0.0'],
        dependencyErrors: [],
        lastReason: 'disabled by user',
      },
    ],
    summary: '3 plugins: 1 enabled, 1 disabled, 1 installed, 0 uninstalled, load order 1 plugin',
  };
}

export interface PluginStoreV19ViewProps {
  view?: PluginStoreV19ViewModel;
  onBack?: () => void;
  onInstall?: () => void;
  onEnable?: (pluginId: string) => void;
  onDisable?: (pluginId: string) => void;
  onUninstall?: (pluginId: string) => void;
  onApprovePermission?: (pluginId: string, permission: string) => void;
}

export default function PluginStoreV19View(props: PluginStoreV19ViewProps) {
  const t = useT();
  const [view] = useState<PluginStoreV19ViewModel>(() => props.view ?? demoPluginStoreV19());
  const [query, setQuery] = useState('');
  const [lifecycleFilter, setLifecycleFilter] = useState<'all' | 'enabled' | 'disabled' | 'installed' | 'uninstalled'>('all');
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return view.plugins.filter((p) => {
      if (lifecycleFilter !== 'all' && p.lifecycle !== lifecycleFilter) return false;
      if (q === '') return true;
      return (
        p.pluginId.toLowerCase().includes(q) ||
        p.name.toLowerCase().includes(q) ||
        p.tools.some((tool) => tool.toLowerCase().includes(q))
      );
    });
  }, [view.plugins, query, lifecycleFilter]);

  return (
    <div className="panel plugin-store-v19-view">
      <div className="panel-header">
        {props.onBack ? (
          <button type="button" className="btn-ghost" onClick={props.onBack}>
            ← {t('pluginV19.back')}
          </button>
        ) : null}
        <h2>{t('pluginV19.pluginStore')}</h2>
        {props.onInstall ? (
          <button type="button" className="btn-primary" onClick={props.onInstall}>
            {t('pluginV19.installPlugin')}
          </button>
        ) : null}
      </div>

      <p className="panel-summary">{view.summary}</p>

      <div className="fleet-v19-score-cards">
        <div className="score-card">
          <span className="score-label">{t('pluginV19.pluginCount')}</span>
          <strong className="score-value">{view.total}</strong>
          <span className="score-sub">
            {view.enabled} {t('pluginV19.enabled')} · {view.disabled} {t('pluginV19.disabled')}
          </span>
        </div>
        <div className="score-card">
          <span className="score-label">{t('pluginV19.loadOrder')}</span>
          <strong className="score-value">{view.loadOrder.length}</strong>
          <span className="score-sub">
            {view.loadOrderOk ? view.loadOrder.join(' → ') : view.loadOrderError}
          </span>
        </div>
        <div className="score-card">
          <span className="score-label">{t('pluginV19.highRiskApproved')}</span>
          <strong className="score-value">{view.enabledWithHighRiskApproved}</strong>
        </div>
      </div>

      <div className="plugin-store-v19-filters">
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('pluginV19.searchPlugins')}
        />
        <select value={lifecycleFilter} onChange={(e) => setLifecycleFilter(e.target.value as typeof lifecycleFilter)}>
          <option value="all">{t('pluginV19.allLifecycles')}</option>
          <option value="enabled">{t('pluginV19.enabled')}</option>
          <option value="disabled">{t('pluginV19.disabled')}</option>
          <option value="installed">{t('pluginV19.installed')}</option>
          <option value="uninstalled">{t('pluginV19.uninstalled')}</option>
        </select>
      </div>

      {filtered.length === 0 ? (
        <p>{t('pluginV19.noPlugins')}</p>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>Plugin</th>
              <th>{t('pluginV19.version')}</th>
              <th>{t('pluginV19.lifecycle')}</th>
              <th>{t('pluginV19.capabilities')}</th>
              <th>{t('pluginV19.permissions')}</th>
              <th>{t('pluginV19.actions')}</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((p) => (
              <Fragment key={p.pluginId}>
                <tr>
                  <td>
                    <button type="button" className="btn-ghost" onClick={() => setExpandedId(expandedId === p.pluginId ? null : p.pluginId)}>
                      {expandedId === p.pluginId ? '▾' : '▸'} {p.name}
                    </button>
                    <div className="plugin-id">{p.pluginId}</div>
                  </td>
                  <td>
                    {p.version} (SDK {p.sdkVersion})
                  </td>
                  <td>{t(`pluginV19.${p.lifecycle}`)}</td>
                  <td>{p.capabilities.join(', ')}</td>
                  <td>
                    {p.permissions.map((perm) => (
                      <span key={perm} className={p.approvedPermissions.includes(perm) ? 'perm-approved' : 'perm-unapproved'}>
                        {perm}
                        {p.approvedPermissions.includes(perm) ? ' ✓' : ''}
                      </span>
                    ))}
                    {p.unapprovedPermissions.length > 0 && props.onApprovePermission ? (
                      <button
                        type="button"
                        className="btn-ghost"
                        onClick={() => props.onApprovePermission?.(p.pluginId, p.unapprovedPermissions[0])}
                      >
                        {t('pluginV19.approvePermission')}
                      </button>
                    ) : null}
                  </td>
                  <td>
                    {p.lifecycle !== 'enabled' && p.lifecycle !== 'uninstalled' && props.onEnable ? (
                      <button type="button" className="btn-ghost" onClick={() => props.onEnable?.(p.pluginId)}>
                        {t('pluginV19.enablePlugin')}
                      </button>
                    ) : null}
                    {p.lifecycle === 'enabled' && props.onDisable ? (
                      <button type="button" className="btn-ghost" onClick={() => props.onDisable?.(p.pluginId)}>
                        {t('pluginV19.disablePlugin')}
                      </button>
                    ) : null}
                    {p.lifecycle !== 'enabled' && p.lifecycle !== 'uninstalled' && props.onUninstall ? (
                      <button type="button" className="btn-ghost" onClick={() => props.onUninstall?.(p.pluginId)}>
                        {t('pluginV19.uninstallPlugin')}
                      </button>
                    ) : null}
                  </td>
                </tr>
                {expandedId === p.pluginId ? (
                  <tr key={`${p.pluginId}-detail`}>
                    <td colSpan={6}>
                      <div>
                        <strong>{t('pluginV19.tools')}:</strong> {p.tools.join(', ') || '—'}
                      </div>
                      <div>
                        <strong>{t('pluginV19.dependsOn')}:</strong> {p.dependsOn.join(', ') || '—'}
                      </div>
                      <div>
                        <strong>{t('pluginV19.lastReason')}:</strong> {p.lastReason}
                      </div>
                      {p.dependencyErrors.length > 0 ? (
                        <div className="plugin-dep-errors">
                          <strong>{t('pluginV19.dependencyErrors')}:</strong>
                          <ul>
                            {p.dependencyErrors.map((e) => (
                              <li key={e}>{e}</li>
                            ))}
                          </ul>
                        </div>
                      ) : null}
                    </td>
                  </tr>
                ) : null}
              </Fragment>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

import { useMemo, useState } from 'react';
import { useT } from '../i18n/useT';

/**
 * MCP Apps panel v11 (v1.14, Team T6) — a SEPARATE panel for MCP Apps, not
 * crammed into the main chat screen: gallery, templates, mic/camera permissions (here
 * these are file/network/clipboard/notification permissions per catalogue v112), CSP.
 *
 * Continues McpAppsView + catalogue v112 (`mcp/appsCatalogV112.ts`):
 * gallery (search/filter by category/compatible apps only), templates to create a
 * new app (blank/note/dashboard — manifest + sample files), permission review
 * (what the app asks for vs what the host granted; high-risk permissions are flagged) and
 * a CSP/sandbox summary for the iframe host. Data comes via props `apps` +
 * `installs` (host builds them from core `buildFleetV11McpAppsPanel` + IPC);
 * when there is no host wiring yet it uses an internal demo store.
 */

export type McpAppsPanelV11Category =
  | 'productivity'
  | 'data'
  | 'developer'
  | 'communication'
  | 'utility';

export type McpAppsPanelV11Permission =
  | 'read-files'
  | 'write-files'
  | 'network'
  | 'clipboard'
  | 'notifications';

export interface McpAppsPanelV11App {
  id: string;
  name: string;
  version: string;
  description: string;
  serverId: string;
  category: McpAppsPanelV11Category;
  permissions: McpAppsPanelV11Permission[];
  minHostVersion: string;
  maxHostVersion: string | null;
  needsNetwork: boolean;
  needsScripts: boolean;
  tags: string[];
  installSizeKb: number;
}

export interface McpAppsPanelV11Install {
  appId: string;
  version: string;
  enabled: boolean;
}

const ALL_PERMISSIONS: McpAppsPanelV11Permission[] = [
  'read-files',
  'write-files',
  'network',
  'clipboard',
  'notifications',
];

const RISKY: McpAppsPanelV11Permission[] = ['write-files', 'network'];

export function demoMcpAppsPanelV11Apps(): McpAppsPanelV11App[] {
  return [
    {
      id: 'kanban-board', name: 'Kanban Board', version: '1.2.0',
      description: 'Drag-and-drop kanban board for tasks.', serverId: 'open-bot-apps',
      category: 'productivity', permissions: ['read-files', 'clipboard'],
      minHostVersion: '0.1.0', maxHostVersion: null, needsNetwork: false, needsScripts: true,
      tags: ['board', 'tasks'], installSizeKb: 180,
    },
    {
      id: 'markdown-notes', name: 'Markdown Notes', version: '0.9.1',
      description: 'Markdown notes stored locally.', serverId: 'open-bot-apps',
      category: 'productivity', permissions: ['read-files', 'write-files'],
      minHostVersion: '0.1.0', maxHostVersion: null, needsNetwork: false, needsScripts: true,
      tags: ['notes', 'markdown'], installSizeKb: 96,
    },
    {
      id: 'csv-explorer', name: 'CSV Explorer', version: '1.0.0',
      description: 'Open and filter large CSV files.', serverId: 'open-bot-apps',
      category: 'data', permissions: ['read-files', 'network'],
      minHostVersion: '0.2.0', maxHostVersion: null, needsNetwork: true, needsScripts: true,
      tags: ['csv', 'data'], installSizeKb: 240,
    },
    {
      id: 'code-snippets', name: 'Code Snippets', version: '2.1.0',
      description: 'Save and search code snippets.', serverId: 'open-bot-apps',
      category: 'developer', permissions: ['read-files', 'write-files', 'clipboard'],
      minHostVersion: '0.1.0', maxHostVersion: null, needsNetwork: false, needsScripts: true,
      tags: ['code'], installSizeKb: 140,
    },
  ];
}

function permissionLabel(t: (key: string) => string, p: McpAppsPanelV11Permission): string {
  if (p === 'read-files') return t('mcpAppsPanelV11.permissionReadFiles');
  if (p === 'write-files') return t('mcpAppsPanelV11.permissionWriteFiles');
  if (p === 'network') return t('mcpAppsPanelV11.permissionNetwork');
  if (p === 'clipboard') return t('mcpAppsPanelV11.permissionClipboard');
  return t('mcpAppsPanelV11.permissionNotifications');
}

export default function McpAppsPanelV11({
  apps: appsProp,
  installs: installsProp,
}: {
  apps?: McpAppsPanelV11App[] | null;
  installs?: McpAppsPanelV11Install[] | null;
}) {
  const t = useT();
  const [apps] = useState<McpAppsPanelV11App[]>(() => appsProp ?? demoMcpAppsPanelV11Apps());
  const [installs, setInstalls] = useState<McpAppsPanelV11Install[]>(() => installsProp ?? [
    { appId: 'kanban-board', version: '1.2.0', enabled: true },
  ]);
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<McpAppsPanelV11Category | 'all'>('all');
  const [onlyCompatible, setOnlyCompatible] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [template, setTemplate] = useState<'blank' | 'note' | 'dashboard' | null>(null);

  // Host caps demo: grants read-files/clipboard/notifications, blocks network, strict sandbox.
  const granted: McpAppsPanelV11Permission[] = ['read-files', 'clipboard', 'notifications'];
  const allowNetwork = false;

  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return apps.filter((a) => {
      if (category !== 'all' && a.category !== category) return false;
      if (needle && !`${a.name} ${a.description} ${a.tags.join(' ')}`.toLowerCase().includes(needle)) return false;
      if (onlyCompatible && a.needsNetwork && !allowNetwork) return false;
      return true;
    });
  }, [apps, query, category, onlyCompatible]);

  const selected = apps.find((a) => a.id === selectedId) ?? null;
  const selectedInstall = selected ? installs.find((i) => i.appId === selected.id) : undefined;
  const categories = useMemo(() => {
    const counts = new Map<McpAppsPanelV11Category, number>();
    for (const a of apps) counts.set(a.category, (counts.get(a.category) ?? 0) + 1);
    return [...counts.entries()].sort((x, y) => x[0].localeCompare(y[0]));
  }, [apps]);

  const install = (appId: string, version: string) => {
    setInstalls((prev) =>
      prev.some((i) => i.appId === appId)
        ? prev
        : [...prev, { appId, version, enabled: true }],
    );
  };

  const toggleEnabled = (appId: string) => {
    setInstalls((prev) =>
      prev.map((i) => (i.appId === appId ? { ...i, enabled: !i.enabled } : i)),
    );
  };

  const templateManifest = (kind: 'blank' | 'note' | 'dashboard'): string => {
    const name = kind === 'note' ? 'Note' : kind === 'dashboard' ? 'Dashboard' : 'Blank app';
    return JSON.stringify(
      { id: `my-${kind}-app`, name, version: '0.1.0', description: `${name} (template v11)`, category: 'productivity', permissions: [] },
      null,
      2,
    );
  };

  return (
    <div>
      <h3>{t('mcpAppsPanelV11.title')}</h3>
      <p className="hint">{t('mcpAppsPanelV11.subtitle')}</p>

      <h4>{t('mcpAppsPanelV11.gallery')}</h4>
      <div className="row">
        <input
          type="text"
          value={query}
          placeholder={t('mcpAppsPanelV11.searchPlaceholder')}
          onChange={(e) => setQuery(e.target.value)}
          aria-label={t('mcpAppsPanelV11.searchPlaceholder')}
        />
        <select
          value={category}
          onChange={(e) => setCategory(e.target.value as McpAppsPanelV11Category | 'all')}
          aria-label={t('mcpAppsPanelV11.category')}
        >
          <option value="all">{t('mcpAppsPanelV11.allCategories')}</option>
          {categories.map(([c, n]) => (
            <option key={c} value={c}>
              {c} ({n})
            </option>
          ))}
        </select>
        <label>
          <input type="checkbox" checked={onlyCompatible} onChange={(e) => setOnlyCompatible(e.target.checked)} />{' '}
          {t('mcpAppsPanelV11.compatible')}
        </label>
      </div>
      <p className="hint">
        {rows.length}/{apps.length} · {installs.length} {t('mcpAppsPanelV11.installed').toLowerCase()}
      </p>
      {rows.length === 0 ? (
        <p className="hint">{t('mcpAppsPanelV11.noApps')}</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>App</th>
              <th>{t('mcpAppsPanelV11.category')}</th>
              <th>{t('mcpAppsPanelV11.compatible')}</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((a) => {
              const compatible = !(a.needsNetwork && !allowNetwork);
              const installed = installs.some((i) => i.appId === a.id);
              return (
                <tr key={a.id} onClick={() => setSelectedId(a.id)} style={{ cursor: 'pointer' }}>
                  <td>
                    <strong>{a.name}</strong> v{a.version}
                    <div className="hint">{a.description}</div>
                    {a.needsNetwork ? <div className="hint">{t('mcpAppsPanelV11.needsNetwork')}</div> : null}
                    {a.needsScripts ? <div className="hint">{t('mcpAppsPanelV11.needsScripts')}</div> : null}
                  </td>
                  <td>{a.category}</td>
                  <td>{compatible ? t('mcpAppsPanelV11.compatible') : t('mcpAppsPanelV11.incompatible')}</td>
                  <td>{installed ? t('mcpAppsPanelV11.installed') : ''}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      {selected ? (
        <div>
          <h4>{selected.name}</h4>
          <p className="hint">
            {t('mcpAppsPanelV11.cspTitle')}: sandbox allow-scripts
            {allowNetwork ? '' : ' · connect-src none'}
            {selected.needsNetwork && !allowNetwork ? ` · ${t('mcpAppsPanelV11.needsNetwork')}` : ''}
          </p>
          <h4>{t('mcpAppsPanelV11.permissions')}</h4>
          <ul>
            {ALL_PERMISSIONS.map((p) => {
              const requested = selected.permissions.includes(p);
              const isGranted = granted.includes(p);
              if (!requested) return null;
              return (
                <li key={p}>
                  {permissionLabel(t, p)} —{' '}
                  {isGranted ? t('mcpAppsPanelV11.compatible') : t('mcpAppsPanelV11.incompatible')}
                  {RISKY.includes(p) ? ' (risky)' : ''}
                </li>
              );
            })}
          </ul>
          <div className="row">
            {selectedInstall ? (
              <button className="btn secondary" onClick={() => toggleEnabled(selected.id)}>
                {selectedInstall.enabled ? t('mcpAppsPanelV11.disable') : t('mcpAppsPanelV11.enable')}
              </button>
            ) : (
              <button className="btn secondary" onClick={() => install(selected.id, selected.version)}>
                {t('mcpAppsPanelV11.install')}
              </button>
            )}
          </div>
        </div>
      ) : null}

      <h4>{t('mcpAppsPanelV11.templates')}</h4>
      <div className="row">
        {(['blank', 'note', 'dashboard'] as const).map((kind) => (
          <button
            key={kind}
            className="btn secondary"
            disabled={template === kind}
            onClick={() => setTemplate(kind)}
          >
            {kind === 'blank'
              ? t('mcpAppsPanelV11.templateBlank')
              : kind === 'note'
                ? t('mcpAppsPanelV11.templateNote')
                : t('mcpAppsPanelV11.templateDashboard')}
          </button>
        ))}
      </div>
      {template ? <pre>{templateManifest(template)}</pre> : null}
    </div>
  );
}

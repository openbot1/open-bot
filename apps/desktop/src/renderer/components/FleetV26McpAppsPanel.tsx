import { useMemo, useState } from 'react';
import { useT } from '../i18n/useT';
import McpAppFrame from './McpAppFrame';

/**
 * Fleet v26 MCP Apps panel (v1.39, Team T6) — render a `ui://`
 * resource in a sandboxed iframe + CSP, with the Apps settings.
 *
 * Rendering goes through the existing `McpAppFrame` (sandbox
 * `allow-scripts` only, opaque origin, session + nonce, tool-call
 * allowlist, dropped-message log). This panel adds the fleet v26
 * host side around it: the render decision (Apps on/off, trusted /
 * blocked server, ask-first default), the CSP built from declared +
 * allowlisted domains (collapsible, so the user can see exactly what
 * the app may load), and the settings themselves — Apps toggle,
 * default policy, domain allowlist, trusted/blocked servers.
 *
 * Nothing renders until the decision says so: a blocked server or a
 * disabled master switch shows the reason instead of a frame.
 */

export interface FleetV26McpAppRowView {
  uri: string;
  serverId: string;
  toolName: string;
  title: string;
  declaredDomains: string[];
  allowedTools: string[];
  renderAllowed: boolean;
  renderReason: string;
  needsAsk: boolean;
  csp: string;
  /** HTML to render (host supplies it after fetching the resource; empty = list only). */
  html: string;
}

export interface FleetV26McpAppsSettingsView {
  appsEnabled: boolean;
  domainAllowlist: string[];
  defaultPolicy: 'ask' | 'allow' | 'deny';
  trustedServers: string[];
  blockedServers: string[];
}

export interface FleetV26McpAppsPanelView {
  summary: string;
  settings: FleetV26McpAppsSettingsView;
  apps: FleetV26McpAppRowView[];
  needsAsk: FleetV26McpAppRowView[];
}

export function demoFleetV26McpAppsPanel(): FleetV26McpAppsPanelView {
  const app: FleetV26McpAppRowView = {
    uri: 'ui://weather-server/current-weather',
    serverId: 'weather-server',
    toolName: 'get-current-weather',
    title: 'Current weather',
    declaredDomains: [],
    allowedTools: ['get-current-weather'],
    renderAllowed: false,
    renderReason: 'Default policy is ask — needs a user decision.',
    needsAsk: true,
    csp: "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; navigate-to 'none'; base-uri 'none'; form-action 'none'",
    html: '',
  };
  return {
    summary: 'MCP Apps enabled: 1 resource(s) from 1 server(s), 0 declared domain(s); default policy ask, 0 trusted / 0 blocked server(s)',
    settings: { appsEnabled: true, domainAllowlist: [], defaultPolicy: 'ask', trustedServers: [], blockedServers: [] },
    apps: [app],
    needsAsk: [app],
  };
}

export interface FleetV26McpAppsPanelProps {
  panel?: FleetV26McpAppsPanelView;
  /** Host applies a settings change (the panel never writes settings itself). */
  onSettingsChange?: (next: FleetV26McpAppsSettingsView) => void;
  /** Host approves rendering one app (trusts its server for this session). */
  onApproveApp?: (uri: string) => void;
  onToolCall?: (toolName: string, args: Record<string, unknown>) => Promise<unknown>;
}

export default function FleetV26McpAppsPanel({ panel, onSettingsChange, onApproveApp, onToolCall }: FleetV26McpAppsPanelProps) {
  const t = useT();
  const view = useMemo(() => panel ?? demoFleetV26McpAppsPanel(), [panel]);
  const [selectedUri, setSelectedUri] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [showCsp, setShowCsp] = useState<string | null>(null);
  const [newDomain, setNewDomain] = useState('');

  const selected = view.apps.find((a) => a.uri === selectedUri) ?? null;
  const settings = view.settings;

  const updateSettings = (patch: Partial<FleetV26McpAppsSettingsView>) => {
    onSettingsChange?.({ ...settings, ...patch });
  };

  const addDomain = () => {
    const d = newDomain.trim().toLowerCase();
    if (!d || settings.domainAllowlist.includes(d)) return;
    updateSettings({ domainAllowlist: [...settings.domainAllowlist, d].sort() });
    setNewDomain('');
  };

  return (
    <section aria-label={t('fleet.v26.mcpApps')} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <header style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
        <h2 style={{ margin: 0 }}>{t('fleet.v26.mcpApps')}</h2>
        <span style={{ fontSize: 12, opacity: 0.7 }}>{view.summary}</span>
        <button type="button" onClick={() => setShowSettings((v) => !v)} style={{ marginLeft: 'auto' }}>
          {showSettings ? t('fleet.v26.hideSettings') : t('fleet.v26.showSettings')}
        </button>
      </header>

      {showSettings ? (
        <article style={{ border: '1px solid var(--border, #ddd)', borderRadius: 8, padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 8, fontSize: 13 }}>
          <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input
              type="checkbox"
              checked={settings.appsEnabled}
              onChange={(e) => updateSettings({ appsEnabled: e.target.checked })}
            />
            {t('fleet.v26.appsEnabled')}
          </label>
          <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            {t('fleet.v26.appsDefaultPolicy')}{' '}
            <select
              value={settings.defaultPolicy}
              onChange={(e) => updateSettings({ defaultPolicy: e.target.value as FleetV26McpAppsSettingsView['defaultPolicy'] })}
            >
              <option value="ask">{t('fleet.v26.policy.ask')}</option>
              <option value="allow">{t('fleet.v26.policy.allow')}</option>
              <option value="deny">{t('fleet.v26.policy.deny')}</option>
            </select>
          </label>
          <div>
            <p style={{ margin: '0 0 4px' }}>{t('fleet.v26.appsDomainAllowlist')}</p>
            <ul style={{ margin: '0 0 6px', paddingLeft: 16 }}>
              {settings.domainAllowlist.map((d) => (
                <li key={d}>
                  {d}{' '}
                  <button type="button" onClick={() => updateSettings({ domainAllowlist: settings.domainAllowlist.filter((x) => x !== d) })}>
                    {t('fleet.v26.remove')}
                  </button>
                </li>
              ))}
              {settings.domainAllowlist.length === 0 ? <li style={{ opacity: 0.7 }}>{t('fleet.v26.appsDomainAllowlistEmpty')}</li> : null}
            </ul>
            <div style={{ display: 'flex', gap: 6 }}>
              <input
                value={newDomain}
                onChange={(e) => setNewDomain(e.target.value)}
                placeholder="example.com"
                aria-label={t('fleet.v26.appsDomainAllowlist')}
                style={{ flex: 1 }}
              />
              <button type="button" onClick={addDomain}>{t('fleet.v26.add')}</button>
            </div>
          </div>
          <p style={{ margin: 0, fontSize: 12, opacity: 0.8 }}>
            {t('fleet.v26.appsTrustSummary', { trusted: settings.trustedServers.length, blocked: settings.blockedServers.length })}
          </p>
        </article>
      ) : null}

      {view.needsAsk.length > 0 ? (
        <p role="note" style={{ margin: 0, fontSize: 13, border: '1px solid var(--border, #ddd)', borderRadius: 8, padding: '8px 10px' }}>
          {t('fleet.v26.appsNeedsAsk', { count: view.needsAsk.length })}
        </p>
      ) : null}

      <ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 6 }}>
        {view.apps.map((app) => (
          <li key={app.uri} style={{ border: '1px solid var(--border, #ddd)', borderRadius: 8, padding: '8px 10px' }}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <strong>{app.title}</strong>
              <span style={{ fontSize: 12, opacity: 0.7 }}>{app.uri}</span>
              <span style={{ marginLeft: 'auto', fontSize: 12 }}>
                {app.renderAllowed ? t('fleet.v26.appsRenderAllowed') : t('fleet.v26.appsRenderBlocked')}
              </span>
            </div>
            <p style={{ margin: '4px 0', fontSize: 13 }}>{app.renderReason}</p>
            <p style={{ margin: '0 0 6px', fontSize: 12, opacity: 0.8 }}>
              {t('fleet.v26.appsDeclaredDomains', { domains: app.declaredDomains.length === 0 ? '—' : app.declaredDomains.join(', ') })}
              {' · '}
              {t('fleet.v26.appsAllowedTools', { tools: app.allowedTools.length === 0 ? '—' : app.allowedTools.join(', ') })}
            </p>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              <button type="button" onClick={() => setShowCsp((u) => (u === app.uri ? null : app.uri))}>
                {showCsp === app.uri ? t('fleet.v26.hideCsp') : t('fleet.v26.showCsp')}
              </button>
              {app.needsAsk ? (
                <button type="button" onClick={() => onApproveApp?.(app.uri)}>{t('fleet.v26.appsApprove')}</button>
              ) : null}
              {app.renderAllowed && app.html ? (
                <button type="button" onClick={() => setSelectedUri(app.uri)}>{t('fleet.v26.appsOpen')}</button>
              ) : null}
            </div>
            {showCsp === app.uri ? (
              <pre style={{ margin: '8px 0 0', padding: 8, background: 'var(--hatch-widget-surface-muted, #f5f5f5)', borderRadius: 6, fontSize: 12, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{app.csp}</pre>
            ) : null}
          </li>
        ))}
        {view.apps.length === 0 ? <li style={{ fontSize: 13, opacity: 0.8 }}>{t('fleet.v26.appsEmpty')}</li> : null}
      </ul>

      {selected && selected.html ? (
        <McpAppFrame
          html={selected.html}
          title={selected.title}
          uri={selected.uri}
          allowedTools={selected.allowedTools}
          onClose={() => setSelectedUri(null)}
          onToolCall={onToolCall}
          onLinkOpen={() => false}
        />
      ) : null}
    </section>
  );
}

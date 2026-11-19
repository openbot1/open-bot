import { useMemo, useState } from 'react';
import { useT } from '../i18n/useT';

/**
 * Fleet v24 CIDR router panel (v1.37, Team T6) — CIDR sandbox rules
 * configured right in the router UI: add an allow/deny rule for a CIDR
 * range, bind it to a route (or all routes), validate the CIDR inline,
 * see which rule applies to which route, probe a (route, IP) pair, and
 * read the audit trail of every rule change.
 *
 * Data comes via props (host builds the view-model from core
 * `buildFleetV24CidrRouterPanel` via IPC); when there is no host wiring
 * yet it uses an internal demo store — the component never guesses real
 * numbers; the demo is clearly labelled in code. Rule changes made in
 * the demo store only affect the demo; the host wires the callbacks to
 * the real rule set.
 */

export type FleetV24CidrAction = 'allow' | 'deny';

export interface FleetV24CidrRuleRowView {
  id: string;
  cidr: string;
  action: FleetV24CidrAction;
  routeId: string | null;
  priority: number;
  enabled: boolean;
  description: string;
  createdBy: string;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface FleetV24CidrOverlapView {
  ruleIdA: string;
  ruleIdB: string;
  overlapCidr: string;
  conflicting: boolean;
  detail: string;
}

export interface FleetV24CidrAuditRowView {
  seq: number;
  atMs: number;
  ruleId: string;
  action: string;
  actor: string;
  detail: string;
}

export interface FleetV24CidrDecisionView {
  action: FleetV24CidrAction;
  ruleId: string | null;
  reason: string;
  ip: string;
  routeId: string | null;
  fromDefault: boolean;
}

export interface FleetV24CidrRouterPanelView {
  summary: string;
  defaultAction: FleetV24CidrAction;
  rules: FleetV24CidrRuleRowView[];
  enabledRules: FleetV24CidrRuleRowView[];
  overlaps: FleetV24CidrOverlapView[];
  audit: FleetV24CidrAuditRowView[];
}

export function demoFleetV24CidrRouterPanel(): FleetV24CidrRouterPanelView {
  const rules: FleetV24CidrRuleRowView[] = [
    {
      id: 'rule-deny-rfc1918', cidr: '10.0.0.0/8', action: 'deny', routeId: null,
      priority: 10, enabled: true, description: 'Block private IPv4 space on every route',
      createdBy: 'team-ops', createdAtMs: 1794300000000, updatedAtMs: 1794300000000,
    },
    {
      id: 'rule-allow-public', cidr: '203.0.113.0/24', action: 'allow', routeId: 'route-public',
      priority: 100, enabled: true, description: 'Allow the public docs range on the public route',
      createdBy: 'team-ops', createdAtMs: 1794301000000, updatedAtMs: 1794301000000,
    },
    {
      id: 'rule-deny-v6-doc', cidr: '2001:db8::/32', action: 'deny', routeId: 'route-public',
      priority: 10, enabled: false, description: 'Disabled example: documentation IPv6 range',
      createdBy: 'team-ops', createdAtMs: 1794302000000, updatedAtMs: 1794302000000,
    },
  ];
  return {
    summary: '3 rules (2 enabled) · default deny · 0 overlaps (0 conflicting)',
    defaultAction: 'deny',
    rules,
    enabledRules: rules.filter((r) => r.enabled),
    overlaps: [],
    audit: [
      { seq: 3, atMs: 1794302000000, ruleId: 'rule-deny-v6-doc', action: 'disable', actor: 'team-ops', detail: '2001:db8::/32 disabled' },
      { seq: 2, atMs: 1794301000000, ruleId: 'rule-allow-public', action: 'create', actor: 'team-ops', detail: 'allow 203.0.113.0/24 on route route-public' },
      { seq: 1, atMs: 1794300000000, ruleId: 'rule-deny-rfc1918', action: 'create', actor: 'team-ops', detail: 'deny 10.0.0.0/8 on all routes' },
    ],
  };
}

/** Minimal client-side CIDR sanity check (the core validator is authoritative). */
function clientValidateCidr(cidr: string): string | null {
  const trimmed = cidr.trim();
  if (trimmed.length === 0) return 'empty';
  if (/\s/.test(trimmed)) return 'spaces';
  const slash = trimmed.indexOf('/');
  const ipPart = slash === -1 ? trimmed : trimmed.slice(0, slash);
  if (ipPart.includes(':')) {
    if (!/^[0-9a-fA-F:]+$/.test(ipPart)) return 'invalid';
    return null;
  }
  const parts = ipPart.split('.');
  if (parts.length !== 4) return 'invalid';
  for (const part of parts) {
    if (!/^\d+$/.test(part)) return 'invalid';
    const n = Number(part);
    if (n < 0 || n > 255) return 'invalid';
  }
  if (slash !== -1) {
    const prefix = trimmed.slice(slash + 1);
    if (!/^\d+$/.test(prefix) || Number(prefix) < 0 || Number(prefix) > 32) return 'invalid';
  }
  return null;
}

export interface FleetV24CidrRouterPanelProps {
  view?: FleetV24CidrRouterPanelView;
  onBack?: () => void;
  onAddRule?: (rule: { id: string; cidr: string; action: FleetV24CidrAction; routeId: string | null; priority: number; description: string }) => void;
  onRemoveRule?: (id: string) => void;
  onToggleRule?: (id: string, enabled: boolean) => void;
  onProbe?: (routeId: string | null, ip: string) => FleetV24CidrDecisionView | null;
}

export default function FleetV24CidrRouterPanel(props: FleetV24CidrRouterPanelProps) {
  const t = useT();
  const [view, setView] = useState<FleetV24CidrRouterPanelView>(() => props.view ?? demoFleetV24CidrRouterPanel());
  const [routeFilter, setRouteFilter] = useState<string>('');
  const [newId, setNewId] = useState<string>('');
  const [newCidr, setNewCidr] = useState<string>('');
  const [newAction, setNewAction] = useState<FleetV24CidrAction>('deny');
  const [newRoute, setNewRoute] = useState<string>('');
  const [newPriority, setNewPriority] = useState<string>('100');
  const [newDescription, setNewDescription] = useState<string>('');
  const [formError, setFormError] = useState<string>('');
  const [probeIp, setProbeIp] = useState<string>('');
  const [probeRoute, setProbeRoute] = useState<string>('');
  const [probeResult, setProbeResult] = useState<FleetV24CidrDecisionView | null>(null);

  const routes = useMemo(() => {
    const seen = new Set<string>();
    for (const r of view.rules) if (r.routeId) seen.add(r.routeId);
    return [...seen].sort();
  }, [view]);

  const visibleRules = useMemo(() => {
    if (routeFilter === '') return view.rules;
    return view.rules.filter((r) => r.routeId === null || r.routeId === routeFilter);
  }, [view, routeFilter]);

  const handleAddRule = () => {
    const cidrProblem = clientValidateCidr(newCidr);
    if (newId.trim().length === 0) {
      setFormError(t('fleet.v24.ruleIdRequired'));
      return;
    }
    if (cidrProblem !== null) {
      setFormError(t('fleet.v24.invalidCidr'));
      return;
    }
    if (view.rules.some((r) => r.id === newId.trim())) {
      setFormError(t('fleet.v24.ruleExists'));
      return;
    }
    const priority = Number(newPriority);
    if (!Number.isInteger(priority) || priority < 0) {
      setFormError(t('fleet.v24.invalidPriority'));
      return;
    }
    const rule = {
      id: newId.trim(),
      cidr: newCidr.trim(),
      action: newAction,
      routeId: newRoute.trim() ? newRoute.trim() : null,
      priority,
      description: newDescription.trim(),
    };
    props.onAddRule?.(rule);
    // Optimistic local update for the demo store (host re-renders with real data).
    setView((prev) => ({
      ...prev,
      rules: [...prev.rules, { ...rule, enabled: true, createdBy: 'ui', createdAtMs: Date.now(), updatedAtMs: Date.now() }],
    }));
    setFormError('');
    setNewId('');
    setNewCidr('');
    setNewDescription('');
  };

  const handleRemoveRule = (id: string) => {
    props.onRemoveRule?.(id);
    setView((prev) => ({ ...prev, rules: prev.rules.filter((r) => r.id !== id) }));
  };

  const handleToggleRule = (id: string, enabled: boolean) => {
    props.onToggleRule?.(id, enabled);
    setView((prev) => ({
      ...prev,
      rules: prev.rules.map((r) => (r.id === id ? { ...r, enabled } : r)),
    }));
  };

  const handleProbe = () => {
    const ip = probeIp.trim();
    if (ip.length === 0) return;
    const route = probeRoute.trim() ? probeRoute.trim() : null;
    const fromHost = props.onProbe?.(route, ip) ?? null;
    if (fromHost) {
      setProbeResult(fromHost);
      return;
    }
    // Demo fallback: longest-prefix match over the local rule list.
    const parseIp = (text: string): number[] | null => {
      const parts = text.split('.');
      if (parts.length !== 4) return null;
      const nums = parts.map(Number);
      if (nums.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
      return nums;
    };
    const ipNums = parseIp(ip);
    if (!ipNums) {
      setProbeResult({ action: 'deny', ruleId: null, reason: t('fleet.v24.invalidCidr'), ip, routeId: route, fromDefault: true });
      return;
    }
    let winner: FleetV24CidrRuleRowView | null = null;
    let winnerPrefix = -1;
    for (const rule of view.rules) {
      if (!rule.enabled) continue;
      if (rule.routeId !== null && rule.routeId !== route) continue;
      const [range, prefixText] = rule.cidr.split('/');
      const prefix = Number(prefixText);
      const rangeNums = parseIp(range);
      if (!rangeNums || !Number.isInteger(prefix)) continue;
      const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
      const ipInt = ((ipNums[0] << 24) | (ipNums[1] << 16) | (ipNums[2] << 8) | ipNums[3]) >>> 0;
      const rangeInt = ((rangeNums[0] << 24) | (rangeNums[1] << 16) | (rangeNums[2] << 8) | rangeNums[3]) >>> 0;
      if ((ipInt & mask) === (rangeInt & mask) && prefix > winnerPrefix) {
        winner = rule;
        winnerPrefix = prefix;
      }
    }
    setProbeResult(
      winner
        ? { action: winner.action, ruleId: winner.id, reason: `${winner.action} ${winner.cidr}`, ip, routeId: route, fromDefault: false }
        : { action: view.defaultAction, ruleId: null, reason: t('fleet.v24.noRuleMatched'), ip, routeId: route, fromDefault: true },
    );
  };

  return (
    <div className="panel fleet-v24-cidr-router">
      <div className="panel-header">
        {props.onBack ? (
          <button type="button" className="btn-ghost" onClick={props.onBack}>
            ← {t('fleet.v24.dashboard')}
          </button>
        ) : null}
        <h2>{t('fleet.v24.cidrRouter')}</h2>
      </div>

      <p className="panel-summary">{view.summary}</p>

      <div className="fleet-v24-filters">
        <label>
          {t('fleet.v24.filterByRoute')}
          <select value={routeFilter} onChange={(e) => setRouteFilter(e.target.value)}>
            <option value="">{t('fleet.v24.allRoutes')}</option>
            {routes.map((route) => (
              <option key={route} value={route}>{route}</option>
            ))}
          </select>
        </label>
        <span className="fleet-v24-muted">
          {t('fleet.v24.defaultAction')}: {view.defaultAction === 'allow' ? t('fleet.v24.allow') : t('fleet.v24.deny')}
        </span>
      </div>

      <h3>{t('fleet.v24.addRule')}</h3>
      <div className="fleet-v24-form">
        <label>
          {t('fleet.v24.ruleId')}
          <input value={newId} onChange={(e) => setNewId(e.target.value)} placeholder="rule-allow-docs" />
        </label>
        <label>
          {t('fleet.v24.cidr')}
          <input value={newCidr} onChange={(e) => setNewCidr(e.target.value)} placeholder="203.0.113.0/24" />
        </label>
        <label>
          {t('fleet.v24.action')}
          <select value={newAction} onChange={(e) => setNewAction(e.target.value as FleetV24CidrAction)}>
            <option value="allow">{t('fleet.v24.allow')}</option>
            <option value="deny">{t('fleet.v24.deny')}</option>
          </select>
        </label>
        <label>
          {t('fleet.v24.routeId')}
          <input value={newRoute} onChange={(e) => setNewRoute(e.target.value)} placeholder={t('fleet.v24.allRoutes')} />
        </label>
        <label>
          {t('fleet.v24.priority')}
          <input value={newPriority} onChange={(e) => setNewPriority(e.target.value)} inputMode="numeric" />
        </label>
        <label>
          {t('fleet.v24.description')}
          <input value={newDescription} onChange={(e) => setNewDescription(e.target.value)} />
        </label>
        <button type="button" className="btn-ghost" onClick={handleAddRule}>
          {t('fleet.v24.addRule')}
        </button>
        {formError ? <div className="fleet-v24-error">{formError}</div> : null}
      </div>

      <h3>
        {t('fleet.v24.cidrRules')}
        {` (${visibleRules.length})`}
      </h3>
      {visibleRules.length === 0 ? (
        <p className="panel-empty">{t('fleet.v24.noRules')}</p>
      ) : (
        <table className="fleet-v24-table">
          <thead>
            <tr>
              <th>{t('fleet.v24.ruleId')}</th>
              <th>{t('fleet.v24.cidr')}</th>
              <th>{t('fleet.v24.action')}</th>
              <th>{t('fleet.v24.route')}</th>
              <th>{t('fleet.v24.priority')}</th>
              <th>{t('fleet.v24.enabled')}</th>
              <th>{t('fleet.v24.description')}</th>
              <th>{t('fleet.v24.actions')}</th>
            </tr>
          </thead>
          <tbody>
            {visibleRules.map((r) => (
              <tr key={r.id}>
                <td>{r.id}</td>
                <td>{r.cidr}</td>
                <td>{r.action === 'allow' ? t('fleet.v24.allow') : t('fleet.v24.deny')}</td>
                <td>{r.routeId ?? t('fleet.v24.allRoutes')}</td>
                <td>{String(r.priority)}</td>
                <td>{r.enabled ? t('fleet.v24.yes') : t('fleet.v24.no')}</td>
                <td>{r.description}</td>
                <td>
                  <button type="button" className="btn-ghost" onClick={() => handleToggleRule(r.id, !r.enabled)}>
                    {r.enabled ? t('fleet.v24.disable') : t('fleet.v24.enable')}
                  </button>
                  <button type="button" className="btn-ghost" onClick={() => handleRemoveRule(r.id)}>
                    {t('fleet.v24.removeRule')}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h3>{t('fleet.v24.probe')}</h3>
      <div className="fleet-v24-form">
        <label>
          {t('fleet.v24.routeId')}
          <input value={probeRoute} onChange={(e) => setProbeRoute(e.target.value)} placeholder="route-public" />
        </label>
        <label>
          {t('fleet.v24.probeIp')}
          <input value={probeIp} onChange={(e) => setProbeIp(e.target.value)} placeholder="203.0.113.10" />
        </label>
        <button type="button" className="btn-ghost" onClick={handleProbe}>
          {t('fleet.v24.evaluate')}
        </button>
      </div>
      {probeResult ? (
        <p className="fleet-v24-probe-result">
          {`${probeResult.ip} → ${probeResult.action === 'allow' ? t('fleet.v24.allow') : t('fleet.v24.deny')}`}
          {probeResult.ruleId ? ` (${probeResult.ruleId})` : ` (${t('fleet.v24.noRuleMatched')})`}
          {` — ${probeResult.reason}`}
        </p>
      ) : null}

      {view.overlaps.length > 0 ? (
        <>
          <h3>{t('fleet.v24.overlaps')}</h3>
          <ul className="fleet-v24-overlap-list">
            {view.overlaps.map((o) => (
              <li key={`${o.ruleIdA}-${o.ruleIdB}`} className={o.conflicting ? 'fleet-v24-overlap-conflict' : ''}>
                {o.detail}
              </li>
            ))}
          </ul>
        </>
      ) : null}

      <h3>{t('fleet.v24.auditTrail')}</h3>
      {view.audit.length === 0 ? (
        <p className="panel-empty">{t('fleet.v24.noAudit')}</p>
      ) : (
        <ul className="fleet-v24-audit-list">
          {view.audit.slice(0, 20).map((e) => (
            <li key={e.seq}>
              <span className="fleet-v24-muted">{new Date(e.atMs).toLocaleString()}</span>
              {` ${e.ruleId} · ${e.action} · ${e.actor} · ${e.detail}`}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

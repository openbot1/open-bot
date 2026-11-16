import { useMemo, useState } from 'react';
import { useT } from '../i18n/useT';

/**
 * Fleet health v11 view (v1.14, Team T6) — health of each node/bot + alerts.
 *
 * Continues FleetV8View (node health + rebalance): v11 adds alerts by
 * threshold for each node/bot (CPU/RAM/disk, uptime, stale heartbeat) with
 * ack, and a fleet-wide rollup. Data comes via props `snapshot` (host builds it
 * from core `buildFleetV11HealthSnapshot` + IPC); when there is no host wiring yet
 * it uses an internal demo store — the component never guesses real numbers; the demo
 * is clearly labelled in code.
 */

export type FleetV11HealthStatus = 'healthy' | 'degraded' | 'unhealthy' | 'down';

export interface FleetV11NodeRow {
  id: string;
  name: string;
  status: FleetV11HealthStatus;
  cpuPct: number | null;
  ramPct: number | null;
  diskPct: number | null;
  uptimeMs: number | null;
  lastHeartbeatAt: number | null;
  botCount: number;
  worstReason: string;
}

export interface FleetV11BotRow {
  id: string;
  name: string;
  nodeId: string;
  status: FleetV11HealthStatus;
  cpuPct: number | null;
  ramPct: number | null;
  lastHeartbeatAt: number | null;
  worstReason: string;
}

export interface FleetV11AlertRow {
  id: string;
  targetName: string;
  level: 'info' | 'warning' | 'critical';
  message: string;
  acknowledged: boolean;
}

export interface FleetV11HealthSnapshotView {
  summary: string;
  nodes: FleetV11NodeRow[];
  bots: FleetV11BotRow[];
  alerts: FleetV11AlertRow[];
}

const T0 = Date.UTC(2026, 10, 16, 0, 0, 0);

export function demoFleetV11HealthSnapshot(): FleetV11HealthSnapshotView {
  return {
    summary: 'Demo: 2 nodes, 3 bots — 1 node degraded (high RAM), 1 alert open.',
    nodes: [
      {
        id: 'node-local', name: 'Local machine', status: 'healthy',
        cpuPct: 42, ramPct: 61, diskPct: 55, uptimeMs: 3 * 24 * 3600 * 1000,
        lastHeartbeatAt: T0, botCount: 2, worstReason: '',
      },
      {
        id: 'node-lan-1', name: 'LAN machine 1', status: 'degraded',
        cpuPct: 71, ramPct: 86, diskPct: 62, uptimeMs: 5 * 3600 * 1000,
        lastHeartbeatAt: T0 - 45_000, botCount: 1, worstReason: 'RAM 86% above the 80% warning threshold',
      },
    ],
    bots: [
      {
        id: 'bot-main', name: 'Main bot', nodeId: 'node-local', status: 'healthy',
        cpuPct: 12, ramPct: 22, lastHeartbeatAt: T0, worstReason: '',
      },
      {
        id: 'bot-research', name: 'Research bot', nodeId: 'node-local', status: 'healthy',
        cpuPct: 30, ramPct: 41, lastHeartbeatAt: T0, worstReason: '',
      },
      {
        id: 'bot-night', name: 'Night bot', nodeId: 'node-lan-1', status: 'degraded',
        cpuPct: 55, ramPct: 82, lastHeartbeatAt: T0 - 45_000, worstReason: 'RAM 82% above the 80% warning threshold',
      },
    ],
    alerts: [
      {
        id: 'node:node-lan-1:ram', targetName: 'LAN machine 1', level: 'warning',
        message: 'LAN machine 1: RAM 86% above the 80% warning threshold', acknowledged: false,
      },
      {
        id: 'bot:bot-night:ram', targetName: 'Night bot', level: 'warning',
        message: 'Night bot: RAM 82% above the 80% warning threshold', acknowledged: false,
      },
    ],
  };
}

function formatPct(v: number | null): string {
  return v === null ? '—' : `${Math.round(v)}%`;
}

function formatUptime(ms: number | null): string {
  if (ms === null) return '—';
  const hours = Math.floor(ms / 3600_000);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

function formatHeartbeat(at: number | null, t: (key: string) => string): string {
  if (at === null) return '—';
  const ageS = Math.max(0, Math.round((Date.now() - at) / 1000));
  return ageS < 60 ? `${ageS}s` : `${Math.floor(ageS / 60)}m ${t('fleetV11.stale')}`;
}

export default function FleetV11HealthView({
  snapshot: snapshotProp,
}: {
  snapshot?: FleetV11HealthSnapshotView | null;
}) {
  const t = useT();
  const [snapshot, setSnapshot] = useState<FleetV11HealthSnapshotView>(
    () => snapshotProp ?? demoFleetV11HealthSnapshot(),
  );
  const [acked, setAcked] = useState<Set<string>>(new Set());

  const counts = useMemo(() => {
    const c = { healthy: 0, degraded: 0, unhealthy: 0, down: 0 };
    for (const n of snapshot.nodes) c[n.status] += 1;
    for (const b of snapshot.bots) c[b.status] += 1;
    return c;
  }, [snapshot]);

  const statusLabel = (status: FleetV11HealthStatus): string => {
    if (status === 'healthy') return t('fleetV11.statusHealthy');
    if (status === 'degraded') return t('fleetV11.statusDegraded');
    if (status === 'unhealthy') return t('fleetV11.statusUnhealthy');
    return t('fleetV11.statusDown');
  };

  const refresh = () => {
    // Demo store: reload the demo snapshot (the real host calls IPC then setSnapshot).
    setSnapshot(demoFleetV11HealthSnapshot());
  };

  const acknowledge = (id: string) => {
    setAcked((prev) => new Set(prev).add(id));
    setSnapshot((prev) => ({
      ...prev,
      alerts: prev.alerts.map((a) => (a.id === id ? { ...a, acknowledged: true } : a)),
    }));
  };

  const openAlerts = snapshot.alerts.filter((a) => !a.acknowledged);

  return (
    <div>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h3>{t('fleetV11.title')}</h3>
        <button className="btn secondary" onClick={refresh}>
          {t('fleetV11.refresh')}
        </button>
      </div>
      <p className="hint">{t('fleetV11.subtitle')}</p>
      <p className="hint">{snapshot.summary}</p>
      <p className="hint">
        {t('fleetV11.statusHealthy')}: {counts.healthy} · {t('fleetV11.statusDegraded')}:{' '}
        {counts.degraded} · {t('fleetV11.statusUnhealthy')}: {counts.unhealthy} ·{' '}
        {t('fleetV11.statusDown')}: {counts.down}
      </p>

      <h4>{t('fleetV11.nodesTitle')}</h4>
      {snapshot.nodes.length === 0 ? (
        <p className="hint">{t('fleetV11.noAlerts')}</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Node</th>
              <th>{t('fleetV11.title')}</th>
              <th>{t('fleetV11.cpu')}</th>
              <th>{t('fleetV11.ram')}</th>
              <th>{t('fleetV11.disk')}</th>
              <th>{t('fleetV11.uptime')}</th>
              <th>{t('fleetV11.lastHeartbeat')}</th>
            </tr>
          </thead>
          <tbody>
            {snapshot.nodes.map((n) => (
              <tr key={n.id}>
                <td>
                  {n.name} ({n.botCount} bot)
                  {n.worstReason ? <div className="hint">{n.worstReason}</div> : null}
                </td>
                <td>{statusLabel(n.status)}</td>
                <td>{formatPct(n.cpuPct)}</td>
                <td>{formatPct(n.ramPct)}</td>
                <td>{formatPct(n.diskPct)}</td>
                <td>{formatUptime(n.uptimeMs)}</td>
                <td>{formatHeartbeat(n.lastHeartbeatAt, t)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h4>{t('fleetV11.botsTitle')}</h4>
      <table>
        <thead>
          <tr>
            <th>Bot</th>
            <th>Node</th>
            <th>{t('fleetV11.title')}</th>
            <th>{t('fleetV11.cpu')}</th>
            <th>{t('fleetV11.ram')}</th>
            <th>{t('fleetV11.lastHeartbeat')}</th>
          </tr>
        </thead>
        <tbody>
          {snapshot.bots.map((b) => (
            <tr key={b.id}>
              <td>
                {b.name}
                {b.worstReason ? <div className="hint">{b.worstReason}</div> : null}
              </td>
              <td>{b.nodeId}</td>
              <td>{statusLabel(b.status)}</td>
              <td>{formatPct(b.cpuPct)}</td>
              <td>{formatPct(b.ramPct)}</td>
              <td>{formatHeartbeat(b.lastHeartbeatAt, t)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h4>{t('fleetV11.alertsTitle')}</h4>
      {snapshot.alerts.length === 0 ? (
        <p className="hint">{t('fleetV11.noAlerts')}</p>
      ) : (
        <ul>
          {snapshot.alerts.map((a) => {
            const isAcked = a.acknowledged || acked.has(a.id);
            return (
              <li key={a.id}>
                <strong>[{a.level}]</strong> {a.message}{' '}
                {isAcked ? (
                  <span className="hint">— {t('fleetV11.acknowledged')}</span>
                ) : (
                  <button className="btn secondary" onClick={() => acknowledge(a.id)}>
                    {t('fleetV11.acknowledge')}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {openAlerts.length === 0 && snapshot.alerts.length > 0 ? (
        <p className="hint">{t('fleetV11.summaryHealthy')}</p>
      ) : null}
    </div>
  );
}

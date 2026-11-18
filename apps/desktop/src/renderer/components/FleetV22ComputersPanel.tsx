import { useState } from 'react';
import { useT } from '../i18n/useT';

/**
 * Fleet v22 computers panel (v1.35, Team T6) — per-bot computer: machine
 * type (cloud-linux-desktop / local-vm / own-computer), lifecycle
 * state, allocated vs used, which computers are under resource
 * pressure, which computers failed.
 *
 * Data comes via props (host builds the view-model from core
 * `buildFleetV22ComputerPanel` via IPC); when there is no host wiring
 * yet it uses an internal demo store — the component never guesses
 * real numbers; the demo is clearly labelled in code.
 */

export interface FleetV22ComputerRowView {
  id: string;
  botId: string;
  ownerId: string;
  kind: string;
  status: string;
  statusReason?: string;
  name: string;
  nodeId: string | null;
  cpuCores: number;
  cpuUsed: number | null;
  cpuFraction: number | null;
  ramBytes: number;
  ramUsed: number | null;
  ramFraction: number | null;
  diskBytes: number;
  diskUsed: number | null;
  diskFraction: number | null;
  pressured: boolean;
  endpoint: string | null;
  consecutiveFailures: number;
  ageMs: number;
}

export interface FleetV22ComputersPanelView {
  summary: string;
  total: number;
  running: number;
  provisioning: number;
  paused: number;
  failed: number;
  stopped: number;
  pressured: number;
  totalCpuCores: number;
  totalRamBytes: number;
  totalDiskBytes: number;
  byKind: Record<string, number>;
  byStatus: Record<string, number>;
  rows: FleetV22ComputerRowView[];
  pressuredComputerIds: string[];
  failedComputerIds: string[];
}

export function demoFleetV22ComputersPanel(): FleetV22ComputersPanelView {
  return {
    summary: '3 computers: 1 running, 1 failed, 1 under resource pressure.',
    total: 3,
    running: 1,
    provisioning: 0,
    paused: 1,
    failed: 1,
    stopped: 0,
    pressured: 1,
    totalCpuCores: 7,
    totalRamBytes: 14 * 1024 ** 3,
    totalDiskBytes: 80 * 1024 ** 3,
    byKind: { 'local-vm': 1, 'cloud-linux-desktop': 1, 'own-computer': 1 },
    byStatus: { running: 1, paused: 1, failed: 1 },
    rows: [
      {
        id: 'c1', botId: 'b1', ownerId: 'u1', kind: 'local-vm', status: 'running', name: 'bot-ghi-chep-vm',
        nodeId: 'node-1', cpuCores: 2, cpuUsed: 0.6, cpuFraction: 0.3,
        ramBytes: 4 * 1024 ** 3, ramUsed: 1 * 1024 ** 3, ramFraction: 0.25,
        diskBytes: 20 * 1024 ** 3, diskUsed: 2 * 1024 ** 3, diskFraction: 0.1,
        pressured: false, endpoint: '127.0.0.1:51234', consecutiveFailures: 0, ageMs: 3_600_000,
      },
      {
        id: 'c2', botId: 'b2', ownerId: 'u1', kind: 'cloud-linux-desktop', status: 'failed', statusReason: 'vm crashed',
        name: 'bot-bao-cao-cloud', nodeId: null, cpuCores: 4, cpuUsed: null, cpuFraction: null,
        ramBytes: 8 * 1024 ** 3, ramUsed: null, ramFraction: null,
        diskBytes: 50 * 1024 ** 3, diskUsed: null, diskFraction: null,
        pressured: false, endpoint: null, consecutiveFailures: 2, ageMs: 7_200_000,
      },
      {
        id: 'c3', botId: 'b3', ownerId: 'u2', kind: 'own-computer', status: 'running', name: 'bot-nhac-nho',
        nodeId: 'node-1', cpuCores: 1, cpuUsed: 0.95, cpuFraction: 0.95,
        ramBytes: 2 * 1024 ** 3, ramUsed: 1 * 1024 ** 3, ramFraction: 0.5,
        diskBytes: 10 * 1024 ** 3, diskUsed: 1 * 1024 ** 3, diskFraction: 0.1,
        pressured: true, endpoint: null, consecutiveFailures: 0, ageMs: 1_800_000,
      },
    ],
    pressuredComputerIds: ['c3'],
    failedComputerIds: ['c2'],
  };
}

export interface FleetV22ComputersPanelProps {
  view?: FleetV22ComputersPanelView;
  onBack?: () => void;
}

function pct(frac: number | null): string {
  return frac === null ? '—' : `${Math.round(frac * 100)}%`;
}

export default function FleetV22ComputersPanel(props: FleetV22ComputersPanelProps) {
  const t = useT();
  const [view] = useState<FleetV22ComputersPanelView>(() => props.view ?? demoFleetV22ComputersPanel());

  return (
    <div className="panel fleet-v22-computers-panel">
      <div className="panel-header">
        {props.onBack ? (
          <button type="button" className="btn-ghost" onClick={props.onBack}>
            ← {t('fleet.v22.dashboard')}
          </button>
        ) : null}
        <h2>{t('fleet.v22.computers')}</h2>
      </div>

      <p className="panel-summary">{view.summary}</p>

      <div className="fleet-v22-score-cards">
        <div className="score-card">
          <div className="score-card-title">{t('fleet.v22.running')}</div>
          <div className="score-card-body">{`${view.running}/${view.total}`}</div>
        </div>
        <div className="score-card">
          <div className="score-card-title">{t('fleet.v22.failed')}</div>
          <div className="score-card-body">{view.failed}</div>
        </div>
        <div className="score-card">
          <div className="score-card-title">{t('fleet.v22.pressured')}</div>
          <div className="score-card-body">{view.pressured}</div>
        </div>
      </div>

      {view.rows.length === 0 ? (
        <p className="panel-empty">{t('fleet.v22.noComputers')}</p>
      ) : (
        <table className="fleet-table">
          <thead>
            <tr>
              <th>{t('fleet.v22.computer')}</th>
              <th>{t('fleet.v22.kind')}</th>
              <th>{t('fleet.v22.status')}</th>
              <th>CPU</th>
              <th>RAM</th>
              <th>Disk</th>
            </tr>
          </thead>
          <tbody>
            {view.rows.map((row) => (
              <tr key={row.id} className={row.status === 'failed' ? 'row-error' : row.pressured ? 'row-warning' : ''}>
                <td>
                  {row.name}
                  <div className="row-sub">
                    {row.botId}
                    {row.nodeId ? ` · ${row.nodeId}` : ''}
                  </div>
                </td>
                <td>{row.kind}</td>
                <td>
                  {row.status}
                  {row.statusReason ? ` (${row.statusReason})` : ''}
                </td>
                <td>{pct(row.cpuFraction)}</td>
                <td>{pct(row.ramFraction)}</td>
                <td>{pct(row.diskFraction)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

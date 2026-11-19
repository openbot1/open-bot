import { useState } from 'react';
import { useT } from '../i18n/useT';

/**
 * Fleet v28 runtime panel (v1.41, Team T6) — per-conversation sandbox
 * runtime: one runtime per conversation with CPU/RAM/disk limits,
 * lifecycle state, health from probes, idle time, and recent
 * evictions. Progressive disclosure: the top shows running/queued
 * counts + aggregate usage; each runtime row expands to limits,
 * usage, health, and eviction history.
 *
 * Data comes via props (host builds the view-model from core
 * `buildFleetV28RuntimePanel` via IPC); when there is no host wiring
 * yet it uses an internal demo store — the component never guesses
 * real numbers; the demo is clearly labelled in code.
 */

export interface FleetV28RuntimeRowView {
  conversationId: string;
  profileId: string;
  botId: string;
  state: 'starting' | 'running' | 'stopped' | 'evicted' | 'failed' | 'restarting';
  health: 'ok' | 'degraded' | 'failed' | 'unknown';
  cpuLimit: number;
  cpuUsed: number;
  ramLimitMB: number;
  ramUsedMB: number;
  diskLimitMB: number;
  diskUsedMB: number;
  overLimit: string[];
  idleMs: number | null;
  idleTimeoutMs: number;
  restarts: number;
  hasSavedState: boolean;
}

export interface FleetV28RuntimePanelView {
  summary: string;
  maxConcurrent: number;
  running: number;
  queued: number;
  totalCpuUsed: number;
  totalRamUsedMB: number;
  totalDiskUsedMB: number;
  runtimes: FleetV28RuntimeRowView[];
  queue: string[];
  recentEvictions: Array<{
    conversationId: string;
    profileId: string;
    evictedAtMs: number;
    idleMs: number;
    stateSaved: boolean;
  }>;
}

export function demoFleetV28RuntimePanel(): FleetV28RuntimePanelView {
  return {
    summary: 'Demo fleet v28 runtime panel (no host wiring yet).',
    maxConcurrent: 8,
    running: 1,
    queued: 0,
    totalCpuUsed: 1,
    totalRamUsedMB: 1024,
    totalDiskUsedMB: 2048,
    runtimes: [
      {
        conversationId: 'conv-demo-1',
        profileId: 'bot-demo',
        botId: 'bot-demo',
        state: 'running',
        health: 'ok',
        cpuLimit: 1,
        cpuUsed: 0.6,
        ramLimitMB: 2048,
        ramUsedMB: 1024,
        diskLimitMB: 5120,
        diskUsedMB: 2048,
        overLimit: [],
        idleMs: 42_000,
        idleTimeoutMs: 15 * 60 * 1000,
        restarts: 0,
        hasSavedState: false,
      },
      {
        conversationId: 'conv-demo-2',
        profileId: 'bot-demo',
        botId: '',
        state: 'evicted',
        health: 'unknown',
        cpuLimit: 1,
        cpuUsed: 0,
        ramLimitMB: 2048,
        ramUsedMB: 0,
        diskLimitMB: 5120,
        diskUsedMB: 0,
        overLimit: [],
        idleMs: null,
        idleTimeoutMs: 15 * 60 * 1000,
        restarts: 1,
        hasSavedState: true,
      },
    ],
    queue: [],
    recentEvictions: [
      {
        conversationId: 'conv-demo-2',
        profileId: 'bot-demo',
        evictedAtMs: Date.now() - 60_000,
        idleMs: 15 * 60 * 1000,
        stateSaved: true,
      },
    ],
  };
}

function formatIdle(ms: number | null): string {
  if (ms === null) return '—';
  if (ms < 1000) return `${ms}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

export default function FleetV28RuntimePanel({ panel }: { panel?: FleetV28RuntimePanelView }) {
  const t = useT();
  const [expanded, setExpanded] = useState<string | null>(null);
  const view = panel ?? demoFleetV28RuntimePanel();
  return (
    <section aria-label={t('fleet.v28.runtimeTitle')} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <h2 style={{ margin: 0 }}>{t('fleet.v28.runtimeTitle')}</h2>
      <p style={{ margin: 0, fontSize: 13, opacity: 0.8 }}>{view.summary}</p>
      <p style={{ margin: 0, fontSize: 13 }}>
        {t('fleet.v28.running')}: {view.running} · {t('fleet.v28.queued')}: {view.queued} ·{' '}
        {t('fleet.v28.maxConcurrent')}: {view.maxConcurrent}
      </p>
      <p style={{ margin: 0, fontSize: 13 }}>
        {t('fleet.v28.usage')}: {t('fleet.v28.cpu')} {view.totalCpuUsed} · {t('fleet.v28.ram')}{' '}
        {view.totalRamUsedMB} MiB · {t('fleet.v28.disk')} {view.totalDiskUsedMB} MiB
      </p>
      {view.runtimes.length === 0 ? (
        <p style={{ margin: 0, fontSize: 13, opacity: 0.8 }}>{t('fleet.v28.noRuntimes')}</p>
      ) : (
        <ul style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 8 }}>
          {view.runtimes.map((row) => {
            const isOpen = expanded === row.conversationId;
            return (
              <li key={row.conversationId}>
                <button
                  type="button"
                  onClick={() => setExpanded(isOpen ? null : row.conversationId)}
                  style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontSize: 13, textAlign: 'left' }}
                >
                  <strong>{row.conversationId}</strong> — {t(`fleet.v28.status.${row.state}`)} ·{' '}
                  {t('fleet.v28.health')}: {t(`fleet.v28.health.${row.health}`)}
                </button>
                {isOpen && (
                  <dl style={{ margin: '4px 0 0', fontSize: 13, display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '2px 10px' }}>
                    <dt>{t('fleet.v28.conversation')}</dt><dd style={{ margin: 0 }}>{row.conversationId}</dd>
                    <dt>{t('fleet.v28.profile')}</dt><dd style={{ margin: 0 }}>{row.profileId}</dd>
                    <dt>{t('fleet.v28.status')}</dt><dd style={{ margin: 0 }}>{t(`fleet.v28.status.${row.state}`)}</dd>
                    <dt>{t('fleet.v28.health')}</dt><dd style={{ margin: 0 }}>{t(`fleet.v28.health.${row.health}`)}</dd>
                    <dt>{t('fleet.v28.cpu')}</dt><dd style={{ margin: 0 }}>{row.cpuUsed} / {row.cpuLimit}</dd>
                    <dt>{t('fleet.v28.ram')}</dt><dd style={{ margin: 0 }}>{row.ramUsedMB} / {row.ramLimitMB} MiB</dd>
                    <dt>{t('fleet.v28.disk')}</dt><dd style={{ margin: 0 }}>{row.diskUsedMB} / {row.diskLimitMB} MiB</dd>
                    <dt>{t('fleet.v28.idleFor')}</dt><dd style={{ margin: 0 }}>{formatIdle(row.idleMs)}</dd>
                    <dt>{t('fleet.v28.restarts')}</dt><dd style={{ margin: 0 }}>{row.restarts}</dd>
                    <dt>{t('fleet.v28.savedState')}</dt><dd style={{ margin: 0 }}>{row.hasSavedState ? '✓' : '—'}</dd>
                    {row.overLimit.length > 0 && (
                      <>
                        <dt>{t('fleet.v28.overLimit')}</dt><dd style={{ margin: 0 }}>{row.overLimit.join(', ')}</dd>
                      </>
                    )}
                  </dl>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <h3 style={{ margin: '4px 0 0', fontSize: 14 }}>{t('fleet.v28.recentEvictions')}</h3>
      {view.recentEvictions.length === 0 ? (
        <p style={{ margin: 0, fontSize: 13, opacity: 0.8 }}>{t('fleet.v28.noEvictions')}</p>
      ) : (
        <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13 }}>
          {view.recentEvictions.map((e) => (
            <li key={`${e.conversationId}-${e.evictedAtMs}`}>
              <strong>{e.conversationId}</strong> — {t('fleet.v28.evicted')} ({formatIdle(e.idleMs)}) ·{' '}
              {t('fleet.v28.savedState')}: {e.stateSaved ? '✓' : '—'}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

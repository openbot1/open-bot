import { useState } from 'react';
import { useT } from '../i18n/useT';

/**
 * Voice v24 tool-call timers panel (v1.37, Team T5) — one
 * live timer row per running tool call in a voice session
 * (tool, elapsed, threshold state), the finished-call table
 * (per-tool mean / p95 / max / slow / failed), the session
 * totals and the threshold alerts (slow / timeout /
 * error-burst).
 *
 * Data comes via props (host builds the view-model from the
 * core `TimerPanelV24` snapshot via IPC); when there is no
 * host wiring yet it uses an internal demo store — the
 * component never guesses real numbers; the demo is clearly
 * labelled in code.
 */

export interface VoiceV24RunningCallView {
  callId: string;
  toolName: string;
  startedAtMs: number;
  elapsedMs: number;
  /** 'fast' | 'normal' | 'slow' | 'very-slow' | 'timeout' (live state). */
  state: string;
  overSlowThreshold: boolean;
  overTimeout: boolean;
}

export interface VoiceV24FinishedCallView {
  toolName: string;
  calls: number;
  meanMs: number;
  p95Ms: number;
  maxMs: number;
  slowCalls: number;
  failed: number;
}

export interface VoiceV24TimerAlertView {
  id: string;
  toolName: string;
  kind: 'slow' | 'timeout' | 'error-burst';
  thresholdMs: number;
  durationMs: number;
  atMs: number;
  message: string;
}

export interface VoiceV24ToolTimersPanelView {
  sessionId: string;
  running: VoiceV24RunningCallView[];
  finished: VoiceV24FinishedCallView[];
  totalCalls: number;
  totalMs: number;
  meanMs: number;
  p95Ms: number;
  slowCalls: number;
  failedCalls: number;
  alerts: VoiceV24TimerAlertView[];
  summary: string;
}

export function formatDurationV24View(ms: number): string {
  if (!Number.isFinite(ms)) return '—';
  const clamped = Math.max(0, Math.round(ms));
  if (clamped < 1000) return `${clamped}ms`;
  if (clamped < 60000) return `${(clamped / 1000).toFixed(2)}s`;
  const minutes = Math.floor(clamped / 60000);
  const seconds = Math.floor((clamped % 60000) / 1000);
  return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
}

export function demoVoiceV24ToolTimersPanel(): VoiceV24ToolTimersPanelView {
  return {
    sessionId: 'demo-session',
    running: [
      {
        callId: 'tc-3',
        toolName: 'web_search',
        startedAtMs: 12000,
        elapsedMs: 6400,
        state: 'slow',
        overSlowThreshold: true,
        overTimeout: false,
      },
    ],
    finished: [
      { toolName: 'web_search', calls: 3, meanMs: 2100, p95Ms: 5900, maxMs: 6400, slowCalls: 1, failed: 0 },
      { toolName: 'calendar_read', calls: 2, meanMs: 420, p95Ms: 480, maxMs: 480, slowCalls: 0, failed: 0 },
      { toolName: 'file_read', calls: 1, meanMs: 180, p95Ms: 180, maxMs: 180, slowCalls: 0, failed: 0 },
    ],
    totalCalls: 7,
    totalMs: 7620,
    meanMs: 1270,
    p95Ms: 5900,
    slowCalls: 1,
    failedCalls: 0,
    alerts: [
      {
        id: 'alert-1',
        toolName: 'web_search',
        kind: 'slow',
        thresholdMs: 5000,
        durationMs: 6400,
        atMs: 18400,
        message: 'web_search ran slow after 6.40s (threshold 5.00s) in session demo-session',
      },
    ],
    summary: 'Demo: 7 tool calls, 7.62s total tool time, 1 slow, 0 failed, 1 alert.',
  };
}

function alertKindLabel(kind: VoiceV24TimerAlertView['kind'], t: ReturnType<typeof useT>): string {
  switch (kind) {
    case 'slow':
      return t('voice.v24.panel.slow');
    case 'timeout':
      return t('voice.v24.panel.timeout');
    case 'error-burst':
      return t('voice.v24.timers.errorBurstAlert');
  }
}

export default function VoiceV24ToolTimersPanel({
  panel: panelProp,
}: {
  panel?: VoiceV24ToolTimersPanelView | null;
}) {
  const t = useT();
  const [panel] = useState<VoiceV24ToolTimersPanelView>(() => panelProp ?? demoVoiceV24ToolTimersPanel());
  const [showAlerts, setShowAlerts] = useState(true);

  return (
    <section aria-label={t('voice.v24.panel.title')}>
      <h2>{t('voice.v24.panel.title')}</h2>
      <p>{t('voice.v24.panel.session')}: {panel.sessionId}</p>
      <p>{panel.summary}</p>

      <h3>{t('voice.v24.panel.timers')}</h3>
      {panel.running.length === 0 ? (
        <p>{t('voice.v24.panel.noRunning')}</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>{t('voice.v24.panel.tool')}</th>
              <th>{t('voice.v24.panel.started')}</th>
              <th>{t('voice.v24.panel.elapsed')}</th>
              <th>{t('voice.v24.panel.status')}</th>
            </tr>
          </thead>
          <tbody>
            {panel.running.map((call) => (
              <tr key={call.callId} data-over-timeout={call.overTimeout} data-over-slow={call.overSlowThreshold}>
                <td>{call.toolName}</td>
                <td>{formatDurationV24View(call.startedAtMs)}</td>
                <td>{formatDurationV24View(call.elapsedMs)}</td>
                <td>{call.state}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h3>{t('voice.v24.panel.totalTime')}: {formatDurationV24View(panel.totalMs)}</h3>
      {panel.finished.length === 0 ? (
        <p>{t('voice.v24.panel.noCalls')}</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>{t('voice.v24.panel.tool')}</th>
              <th>{t('voice.v24.panel.calls')}</th>
              <th>{t('voice.v24.panel.mean')}</th>
              <th>{t('voice.v24.panel.p95')}</th>
              <th>{t('voice.v24.panel.max')}</th>
              <th>{t('voice.v24.panel.slow')}</th>
              <th>{t('voice.v24.panel.failed')}</th>
            </tr>
          </thead>
          <tbody>
            {panel.finished.map((row) => (
              <tr key={row.toolName}>
                <td>{row.toolName}</td>
                <td>{row.calls}</td>
                <td>{formatDurationV24View(row.meanMs)}</td>
                <td>{formatDurationV24View(row.p95Ms)}</td>
                <td>{formatDurationV24View(row.maxMs)}</td>
                <td>{row.slowCalls}</td>
                <td>{row.failed}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h3>
        <button type="button" onClick={() => setShowAlerts((v) => !v)} aria-expanded={showAlerts}>
          {t('voice.v24.panel.alerts')} ({panel.alerts.length})
        </button>
      </h3>
      {showAlerts && (
        panel.alerts.length === 0 ? (
          <p>{t('voice.v24.panel.noAlerts')}</p>
        ) : (
          <ul>
            {panel.alerts.map((alert) => (
              <li key={alert.id}>
                [{alertKindLabel(alert.kind, t)}] {alert.message}
              </li>
            ))}
          </ul>
        )
      )}
    </section>
  );
}

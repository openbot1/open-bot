import { useState } from 'react';
import { useT } from '../i18n/useT';

/**
 * AG-UI / A2UI panel v12 (v1.15, Team T6) — live AG-UI event stream
 * (run/step/tool/interrupt timeline), A2UI generative surfaces, and
 * approve/reject buttons for interrupts.
 *
 * Data comes via props (host builds the view-model from core
 * `buildFleetV12AguiPanel` over the AG-UI event stream via IPC); when
 * there is no host wiring yet it uses an internal demo store — the
 * component never guesses real numbers; the demo is clearly labelled
 * in code. `onDecide` is called with (interruptId, 'approve' |
 * 'reject') when the user decides; the host validates (only `user`
 * may decide) and sends GENERATIVE_UI_RESPONSE back to the agent.
 */

export interface FleetV12AguiTimelineRowView {
  sequence: number;
  at: string;
  kind: 'run' | 'text' | 'tool' | 'state' | 'genui' | 'activity' | 'custom';
  label: string;
  detail: string;
  status: 'ok' | 'error' | 'pending' | 'info';
}

export interface FleetV12AguiRunRowView {
  runId: string;
  botId: string;
  title: string;
  status: 'running' | 'completed' | 'failed' | 'stopped' | 'cancelled' | 'waiting';
  startedAt: string | null;
  finishedAt: string | null;
  steps: number;
  toolCalls: number;
  tokensUsed: number | null;
  textPreview: string;
  timeline: FleetV12AguiTimelineRowView[];
}

export interface FleetV12AguiInterruptView {
  id: string;
  runId: string;
  kind: 'confirm' | 'approval' | 'form' | 'options';
  title: string;
  description: string;
  blocking: boolean;
  at: string;
}

export interface FleetV12A2uiSurfaceView {
  componentId: string;
  runId: string;
  kind: string;
  title: string;
  description: string;
  answered: boolean;
  blocking: boolean;
}

export interface FleetV12AguiPanelView {
  runs: FleetV12AguiRunRowView[];
  interrupts: FleetV12AguiInterruptView[];
  surfaces: FleetV12A2uiSurfaceView[];
  pendingInterruptCount: number;
  runningRunCount: number;
  summary: string;
}

const T0 = '2026-11-16T00:00:00.000Z';

export function demoFleetV12AguiPanel(): FleetV12AguiPanelView {
  return {
    runs: [
      {
        runId: 'run-1', botId: 'bot-1', title: 'Write report', status: 'waiting',
        startedAt: T0, finishedAt: null, steps: 2, toolCalls: 1, tokensUsed: null,
        textPreview: 'Hello open-bot!',
        timeline: [
          { sequence: 0, at: T0, kind: 'run', label: 'Run started', detail: 'Write report', status: 'info' },
          { sequence: 1, at: T0, kind: 'text', label: 'Text', detail: 'Hello open-bot!', status: 'info' },
          { sequence: 2, at: T0, kind: 'tool', label: 'Tool: read_file', detail: '', status: 'ok' },
          { sequence: 3, at: T0, kind: 'genui', label: 'Generative UI: confirm — Send mail to Huy?', detail: 'Mail will go to huy@example.com', status: 'pending' },
        ],
      },
      {
        runId: 'run-2', botId: 'bot-1', title: 'Unfinished', status: 'running',
        startedAt: T0, finishedAt: null, steps: 0, toolCalls: 0, tokensUsed: null,
        textPreview: '', timeline: [],
      },
    ],
    interrupts: [
      {
        id: 'c1', runId: 'run-1', kind: 'confirm', title: 'Send mail to Huy?',
        description: 'Mail will go to huy@example.com', blocking: true, at: T0,
      },
    ],
    surfaces: [
      {
        componentId: 'c1', runId: 'run-1', kind: 'confirm', title: 'Send mail to Huy?',
        description: 'Mail will go to huy@example.com', answered: false, blocking: true,
      },
      {
        componentId: 'c2', runId: 'run-1', kind: 'options', title: 'Pick a voice',
        description: '', answered: true, blocking: false,
      },
    ],
    pendingInterruptCount: 1,
    runningRunCount: 2,
    summary: 'Demo: 2 runs (1 waiting), 1 interrupt awaiting a decision, 2 generative surfaces.',
  };
}

export default function FleetV12AguiPanel({
  panel: panelProp,
  onDecide,
}: {
  panel?: FleetV12AguiPanelView | null;
  onDecide?: (interruptId: string, decision: 'approve' | 'reject') => void;
}) {
  const t = useT();
  const [panel, setPanel] = useState<FleetV12AguiPanelView>(
    () => panelProp ?? demoFleetV12AguiPanel(),
  );
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [decided, setDecided] = useState<Record<string, 'approve' | 'reject'>>({});

  const statusLabel = (status: FleetV12AguiRunRowView['status']): string => {
    if (status === 'running') return t('fleetV12.aguiRunning');
    if (status === 'waiting') return t('fleetV12.aguiWaiting');
    if (status === 'completed') return t('fleetV12.aguiCompleted');
    if (status === 'failed') return t('fleetV12.aguiFailed');
    if (status === 'stopped') return t('fleetV12.aguiStopped');
    return t('fleetV12.aguiCancelled');
  };

  const decide = (interruptId: string, decision: 'approve' | 'reject') => {
    setDecided((prev) => ({ ...prev, [interruptId]: decision }));
    setPanel((prev) => ({
      ...prev,
      interrupts: prev.interrupts.filter((i) => i.id !== interruptId),
      pendingInterruptCount: Math.max(0, prev.pendingInterruptCount - 1),
    }));
    onDecide?.(interruptId, decision);
  };

  const selectedRun =
    panel.runs.find((r) => r.runId === selectedRunId) ?? panel.runs[0] ?? null;

  return (
    <div>
      <h3>{t('fleetV12.aguiTitle')}</h3>
      <p>{panel.summary}</p>

      <h4>{t('fleetV12.aguiInterrupts')}</h4>
      {panel.interrupts.length === 0 ? (
        <p>{t('fleetV12.aguiNoInterrupts')}</p>
      ) : (
        <ul>
          {panel.interrupts.map((i) => (
            <li key={i.id}>
              <strong>{i.title}</strong>
              {i.description ? ` — ${i.description}` : ''}{' '}
              {decided[i.id] ? (
                <span>({decided[i.id] === 'approve' ? t('fleetV12.aguiApprove') : t('fleetV12.aguiReject')})</span>
              ) : (
                <>
                  <button type="button" onClick={() => decide(i.id, 'approve')}>{t('fleetV12.aguiApprove')}</button>{' '}
                  <button type="button" onClick={() => decide(i.id, 'reject')}>{t('fleetV12.aguiReject')}</button>
                </>
              )}
            </li>
          ))}
        </ul>
      )}

      <h4>{t('fleetV12.aguiSurfaces')}</h4>
      {panel.surfaces.length === 0 ? (
        <p>—</p>
      ) : (
        <ul>
          {panel.surfaces.map((s) => (
            <li key={s.componentId}>
              {s.kind} — {s.title}
              {s.description ? ` — ${s.description}` : ''}
              {s.answered ? ' ✓' : s.blocking ? ` (${t('fleetV12.aguiWaiting')})` : ''}
            </li>
          ))}
        </ul>
      )}

      <h4>{t('fleetV12.aguiRuns')}</h4>
      {panel.runs.length === 0 ? (
        <p>{t('fleetV12.aguiNoRuns')}</p>
      ) : (
        <div>
          <ul>
            {panel.runs.map((r) => (
              <li key={r.runId}>
                <button type="button" onClick={() => setSelectedRunId(r.runId)}>
                  {r.title || r.runId} — {statusLabel(r.status)}
                </button>
                {r.toolCalls > 0 ? ` (${r.toolCalls} tool)` : ''}
                {r.tokensUsed !== null ? ` · ${r.tokensUsed} tokens` : ''}
              </li>
            ))}
          </ul>
          {selectedRun && (
            <div>
              <h4>{t('fleetV12.aguiTimeline')}: {selectedRun.title || selectedRun.runId}</h4>
              {selectedRun.textPreview ? <p>{selectedRun.textPreview}</p> : null}
              {selectedRun.timeline.length === 0 ? (
                <p>—</p>
              ) : (
                <ol>
                  {selectedRun.timeline.map((row) => (
                    <li key={row.sequence}>
                      [{row.kind}] {row.label}
                      {row.detail ? ` — ${row.detail}` : ''}
                    </li>
                  ))}
                </ol>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

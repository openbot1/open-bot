import { useMemo, useState } from 'react';
import { useT } from '../i18n/useT';

/**
 * A2A task board panel — fleet v29 (v1.42, Team T6).
 *
 * The multi-agent coordination board: every A2A task delegated to a
 * peer, its state (submitted → working → input-required / completed /
 * failed / cancelled), streaming progress, cost and latency. Tasks
 * waiting for user input are surfaced first — an `input-required`
 * task cannot finish until the user answers.
 *
 * Data comes via props (host builds the view-model from core
 * `buildFleetV29BoardPanel` via IPC); with no host wiring yet it
 * uses an internal demo store — the component never guesses real
 * numbers, and the demo is clearly labelled in code. When the board
 * runs in local-simulation mode (no A2A transport wired — Team T1's
 * A2A v11 client not connected yet) the panel says so up front and
 * marks simulated tasks; it never presents a simulated task as a
 * task that reached a real peer.
 */

export type A2aTaskBoardV29State =
  | 'submitted'
  | 'working'
  | 'input-required'
  | 'auth-required'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'rejected';

export interface A2aTaskBoardV29TaskView {
  taskId: string;
  contextId: string;
  peerId: string;
  delegatedBy: string;
  title: string;
  state: A2aTaskBoardV29State;
  progress: number | null;
  partialText: string;
  progressEvents: number;
  costUsd: number;
  lastLatencyMs: number | null;
  awaitingInput: boolean;
  inputQuestion: string | null;
  createdAt: string;
  updatedAt: string;
  simulated: boolean;
  costCapBreached: boolean;
}

export interface A2aTaskBoardV29PanelView {
  summary: string;
  transportWired: boolean;
  totalTasks: number;
  activeTasks: number;
  awaitingInput: number;
  countsByState: Record<string, number>;
  tasks: A2aTaskBoardV29TaskView[];
  nextCursor: string | null;
}

export function demoA2aTaskBoardV29Panel(): A2aTaskBoardV29PanelView {
  return {
    summary: 'Demo A2A task board (no host wiring yet).',
    transportWired: false,
    totalTasks: 3,
    activeTasks: 2,
    awaitingInput: 1,
    countsByState: { working: 1, 'input-required': 1, completed: 1 },
    tasks: [
      {
        taskId: 'task-demo-1',
        contextId: 'ctx-demo-1',
        peerId: 'peer-research',
        delegatedBy: 'bot-main',
        title: 'Research competitor pricing',
        state: 'working',
        progress: 0.45,
        partialText: 'Found 3 of 5 competitors…',
        progressEvents: 12,
        costUsd: 0.0234,
        lastLatencyMs: 812,
        awaitingInput: false,
        inputQuestion: null,
        createdAt: '2026-11-19T00:00:00.000Z',
        updatedAt: '2026-11-19T00:05:00.000Z',
        simulated: true,
        costCapBreached: false,
      },
      {
        taskId: 'task-demo-2',
        contextId: 'ctx-demo-2',
        peerId: 'peer-writer',
        delegatedBy: 'bot-main',
        title: 'Draft release notes',
        state: 'input-required',
        progress: null,
        partialText: '',
        progressEvents: 4,
        costUsd: 0.011,
        lastLatencyMs: 640,
        awaitingInput: true,
        inputQuestion: 'Which version number should the notes target?',
        createdAt: '2026-11-19T00:01:00.000Z',
        updatedAt: '2026-11-19T00:06:00.000Z',
        simulated: true,
        costCapBreached: false,
      },
      {
        taskId: 'task-demo-3',
        contextId: 'ctx-demo-3',
        peerId: 'peer-research',
        delegatedBy: 'bot-main',
        title: 'Summarise survey results',
        state: 'completed',
        progress: 1,
        partialText: 'Done — 4 findings.',
        progressEvents: 9,
        costUsd: 0.0312,
        lastLatencyMs: 905,
        awaitingInput: false,
        inputQuestion: null,
        createdAt: '2026-11-18T23:00:00.000Z',
        updatedAt: '2026-11-18T23:04:00.000Z',
        simulated: true,
        costCapBreached: false,
      },
    ],
    nextCursor: null,
  };
}

const STATE_ORDER: A2aTaskBoardV29State[] = [
  'submitted',
  'working',
  'input-required',
  'auth-required',
  'completed',
  'failed',
  'cancelled',
  'rejected',
];

function stateColor(state: A2aTaskBoardV29State): string {
  if (state === 'completed') return '#16a34a';
  if (state === 'failed' || state === 'rejected') return '#c0392b';
  if (state === 'cancelled') return '#6b7280';
  if (state === 'input-required' || state === 'auth-required') return '#d97706';
  return '#2563eb';
}

export interface A2aTaskBoardV29PanelProps {
  panel?: A2aTaskBoardV29PanelView;
  /** Called when the user cancels a task (host wires the tool call). */
  onCancelTask?: (taskId: string) => void;
  /** Called when the user answers an input-required task. */
  onProvideInput?: (taskId: string, answer: string) => void;
  /** Called when the user asks for the next page (cursor pagination). */
  onNextPage?: (cursor: string) => void;
}

export default function A2aTaskBoardV29Panel({ panel, onCancelTask, onProvideInput, onNextPage }: A2aTaskBoardV29PanelProps) {
  const t = useT();
  const [stateFilter, setStateFilter] = useState<string>('all');
  const [peerFilter, setPeerFilter] = useState<string>('all');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [answer, setAnswer] = useState('');
  const view = panel ?? demoA2aTaskBoardV29Panel();
  const peers = useMemo(() => [...new Set(view.tasks.map((task) => task.peerId))].sort(), [view.tasks]);
  const filtered = view.tasks.filter((task) => {
    if (stateFilter !== 'all' && task.state !== stateFilter) return false;
    if (peerFilter !== 'all' && task.peerId !== peerFilter) return false;
    return true;
  });
  const awaiting = view.tasks.filter((task) => task.awaitingInput);
  const totalCost = view.tasks.reduce((sum, task) => sum + task.costUsd, 0);
  return (
    <section aria-label={t('fleet.v29.boardTitle')} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <h2 style={{ margin: 0 }}>{t('fleet.v29.boardTitle')}</h2>
      <p style={{ margin: 0, fontSize: 13, opacity: 0.8 }}>{view.summary}</p>
      <p style={{ margin: 0, fontSize: 13, fontWeight: 600 }}>
        {view.transportWired ? t('fleet.v29.liveMode') : t('fleet.v29.simulationMode')}
      </p>
      <p style={{ margin: 0, fontSize: 13 }}>
        {t('fleet.v29.activeTasks')}: {view.activeTasks} · {t('fleet.v29.totalTasks')}: {view.totalTasks} ·{' '}
        {t('fleet.v29.awaitingInput')}: {view.awaitingInput} · {t('fleet.v29.totalCost')}: ${totalCost.toFixed(4)}
      </p>
      {awaiting.length > 0 && (
        <div style={{ border: '1px solid #d97706', borderRadius: 6, padding: 8 }}>
          <strong style={{ fontSize: 13 }}>{t('fleet.v29.awaitingInput')} ({awaiting.length})</strong>
          <ul style={{ margin: '4px 0 0', paddingLeft: 18, fontSize: 13 }}>
            {awaiting.map((task) => (
              <li key={task.taskId}>
                <strong>{task.title}</strong> — {task.inputQuestion ?? ''}
              </li>
            ))}
          </ul>
        </div>
      )}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', fontSize: 13 }}>
        <label>
          {t('fleet.v29.filterByState')}{' '}
          <select value={stateFilter} onChange={(e) => setStateFilter(e.target.value)}>
            <option value="all">{t('fleet.v29.allStates')}</option>
            {STATE_ORDER.map((state) => (
              <option key={state} value={state}>
                {t(`fleet.v29.state.${state}`)}
              </option>
            ))}
          </select>
        </label>
        <label>
          {t('fleet.v29.filterByPeer')}{' '}
          <select value={peerFilter} onChange={(e) => setPeerFilter(e.target.value)}>
            <option value="all">{t('fleet.v29.allPeers')}</option>
            {peers.map((peerId) => (
              <option key={peerId} value={peerId}>
                {peerId}
              </option>
            ))}
          </select>
        </label>
      </div>
      {filtered.length === 0 ? (
        <p style={{ margin: 0, fontSize: 13, opacity: 0.8 }}>{t('fleet.v29.noTasks')}</p>
      ) : (
        <ul style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 8 }}>
          {filtered.map((task) => {
            const isOpen = expanded === task.taskId;
            const isTerminal = ['completed', 'failed', 'cancelled', 'rejected'].includes(task.state);
            return (
              <li key={task.taskId}>
                <button
                  type="button"
                  onClick={() => setExpanded(isOpen ? null : task.taskId)}
                  style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontSize: 13, textAlign: 'left' }}
                >
                  <strong>{task.title}</strong> —{' '}
                  <span style={{ color: stateColor(task.state) }}>{t(`fleet.v29.state.${task.state}`)}</span>
                  {task.simulated ? ` (${t('fleet.v29.simulated')})` : ''}
                  {task.costCapBreached ? ` (${t('fleet.v29.costCapBreached')})` : ''}
                </button>
                {task.progress !== null && task.state === 'working' && (
                  <div role="meter" aria-valuenow={Math.round(task.progress * 100)} aria-valuemin={0} aria-valuemax={100} style={{ height: 8, borderRadius: 4, background: '#8883', overflow: 'hidden', marginTop: 4, maxWidth: 320 }}>
                    <div style={{ width: `${Math.round(task.progress * 100)}%`, height: '100%', background: '#2563eb' }} />
                  </div>
                )}
                {isOpen && (
                  <dl style={{ margin: '4px 0 0', fontSize: 13, display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '2px 10px' }}>
                    <dt>{t('fleet.v29.taskId')}</dt><dd style={{ margin: 0 }}>{task.taskId}</dd>
                    <dt>{t('fleet.v29.peer')}</dt><dd style={{ margin: 0 }}>{task.peerId}</dd>
                    <dt>{t('fleet.v29.delegatedBy')}</dt><dd style={{ margin: 0 }}>{task.delegatedBy}</dd>
                    <dt>{t('fleet.v29.cost')}</dt><dd style={{ margin: 0 }}>${task.costUsd.toFixed(4)}</dd>
                    <dt>{t('fleet.v29.latency')}</dt><dd style={{ margin: 0 }}>{task.lastLatencyMs === null ? '—' : `${task.lastLatencyMs} ms`}</dd>
                    <dt>{t('fleet.v29.progressEvents')}</dt><dd style={{ margin: 0 }}>{task.progressEvents}</dd>
                    {task.partialText && (<><dt>{t('fleet.v29.partialText')}</dt><dd style={{ margin: 0 }}>{task.partialText}</dd></>)}
                    {task.inputQuestion && (<><dt>{t('fleet.v29.inputQuestion')}</dt><dd style={{ margin: 0 }}>{task.inputQuestion}</dd></>)}
                  </dl>
                )}
                {task.awaitingInput && onProvideInput && (
                  <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
                    <input
                      type="text"
                      value={expanded === task.taskId ? answer : ''}
                      onChange={(e) => {
                        setExpanded(task.taskId);
                        setAnswer(e.target.value);
                      }}
                      placeholder={t('fleet.v29.answerPlaceholder')}
                      aria-label={t('fleet.v29.inputQuestion')}
                      style={{ fontSize: 13, flex: 1, minWidth: 120 }}
                    />
                    <button
                      type="button"
                      onClick={() => {
                        if (answer.trim()) {
                          onProvideInput(task.taskId, answer.trim());
                          setAnswer('');
                        }
                      }}
                      style={{ fontSize: 13, cursor: 'pointer' }}
                    >
                      {t('fleet.v29.submitInput')}
                    </button>
                  </div>
                )}
                {!isTerminal && onCancelTask && (
                  <button type="button" onClick={() => onCancelTask(task.taskId)} style={{ fontSize: 13, cursor: 'pointer', marginTop: 4 }}>
                    {t('fleet.v29.cancel')}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {view.nextCursor && onNextPage && (
        <button type="button" onClick={() => onNextPage(view.nextCursor as string)} style={{ fontSize: 13, cursor: 'pointer', alignSelf: 'flex-start' }}>
          {t('fleet.v29.nextPage')}
        </button>
      )}
    </section>
  );
}

/**
 * Event-log time-travel viewer (v1.08, Team T5 — voice v7 + UI).
 *
 * The v0.90 `EventLogView` shows the harness log as a list; this
 * viewer replays it as a run: jump to step N, watch the state at
 * that step (counts by kind, last tool called, last model text,
 * errors so far, time covered), and replay from there at 100–
 * 1000 ms per step. It reads the entries the existing view
 * already loaded (props — no new IPC, no copy of the T3 harness
 * EventLog) and computes the replay state locally through
 * `./eventLogTimeTravel`. Entries past the current step are
 * shown dimmed as "the future" so the cut between what had
 * happened and what had not is visible at a glance.
 *
 * Advanced feature behind the EventLog screen's "Time travel"
 * toggle — the list view stays the default.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { HarnessEventKindView, HarnessThreadLogEntryView } from '../types';
import { useT } from '../i18n/useT';
import {
  buildTimeTravelSteps,
  formatTimeTravelSpan,
  isTimeTravelSpeed,
  replaySchedule,
  stateAtStep,
  timeTravelStepLabel,
  TIME_TRAVEL_SPEEDS,
} from './eventLogTimeTravel';

const KIND_COLORS: Record<HarnessEventKindView, string> = {
  text: '#0369a1',
  tool_call: '#7c3aed',
  result: '#15803d',
  error: '#b91c1c',
  abort: '#b45309',
  approval_request: '#be185d',
  approval_denied: '#b91c1c',
  permission_request: '#be185d',
  permission_denied: '#b91c1c',
  approval_decision: '#15803d',
  lifecycle: '#475569',
};

function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

interface Props {
  entries: HarnessThreadLogEntryView[];
  total: number;
  onBack: () => void;
}

export default function EventLogViewer({ entries, total, onBack }: Props) {
  const t = useT();
  const [step, setStep] = useState(entries.length);
  const [playing, setPlaying] = useState(false);
  const [speedMs, setSpeedMs] = useState<number>(250);
  const [showFuture, setShowFuture] = useState(true);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const playingRef = useRef(false);
  playingRef.current = playing;
  const stepRef = useRef(0);
  stepRef.current = step;

  // Steps are derived from the entries (pure): a new page of
  // entries rebuilds them, and the step clamps to the new total.
  const steps = useMemo(() => buildTimeTravelSteps(entries), [entries]);
  const state = useMemo(() => stateAtStep(entries, steps, step), [entries, steps, step]);

  useEffect(() => {
    if (step > entries.length) setStep(entries.length);
  }, [entries.length, step]);

  // Replay: one step per `speedMs` tick until the end (or until
  // the user pauses / jumps). The timer reads the refs so a tick
  // never uses a stale step.
  useEffect(() => {
    if (!playing) return undefined;
    const timer = setInterval(() => {
      if (!playingRef.current) return;
      if (stepRef.current >= entries.length) {
        setPlaying(false);
        return;
      }
      setStep((prev) => Math.min(entries.length, prev + 1));
    }, speedMs);
    return () => clearInterval(timer);
  }, [playing, speedMs, entries.length]);

  const jumpTo = (n: number): void => {
    setPlaying(false);
    setStep(Math.max(0, Math.min(entries.length, Math.floor(n))));
  };

  const playFromHere = (): void => {
    if (step >= entries.length) setStep(0);
    setPlaying(true);
  };

  const remaining = replaySchedule(step, entries.length);
  const toggleExpanded = (key: string): void => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const kindCounts = Object.entries(state.countsByKind).sort((a, b) => b[1] - a[1]);

  return (
    <div className="panel">
      <button className="btn secondary" onClick={onBack}>
        {t('eventLogTravel.back')}
      </button>
      <h2>{t('eventLogTravel.title')}</h2>
      <p>{t('eventLogTravel.intro')}</p>
      <p style={{ color: 'var(--text-dim)', fontSize: 13 }}>
        {t('eventLogTravel.count', { count: String(entries.length), total: String(total) })}
      </p>

      {entries.length === 0 && <p className="empty">{t('eventLogTravel.empty')}</p>}
      {entries.length > 0 && (
        <>
          <div className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 8 }}>
            <button
              type="button"
              className="btn"
              data-testid="eventlog-travel-play"
              onClick={() => (playing ? setPlaying(false) : playFromHere())}
            >
              {playing ? t('eventLogTravel.pause') : t('eventLogTravel.play')}
            </button>
            <button
              type="button"
              className="btn secondary"
              data-testid="eventlog-travel-restart"
              onClick={() => jumpTo(0)}
            >
              {t('eventLogTravel.restart')}
            </button>
            <button
              type="button"
              className="btn secondary"
              data-testid="eventlog-travel-end"
              onClick={() => jumpTo(entries.length)}
            >
              {t('eventLogTravel.jumpToEnd')}
            </button>
            <label>
              {t('eventLogTravel.speed')}{' '}
              <select
                value={String(speedMs)}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  if (isTimeTravelSpeed(v)) setSpeedMs(v);
                }}
                data-testid="eventlog-travel-speed"
              >
                {TIME_TRAVEL_SPEEDS.map((s) => (
                  <option key={s} value={String(s)}>
                    {s}ms
                  </option>
                ))}
              </select>
            </label>
            <label>
              <input
                type="checkbox"
                checked={showFuture}
                onChange={(e) => setShowFuture(e.target.checked)}
              />{' '}
              {t('eventLogTravel.showFuture')}
            </label>
          </div>

          <div className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 8 }}>
            <label htmlFor="eventlog-travel-step">{t('eventLogTravel.step')}</label>
            <input
              id="eventlog-travel-step"
              type="range"
              min={0}
              max={entries.length}
              step={1}
              value={step}
              data-testid="eventlog-travel-slider"
              onChange={(e) => jumpTo(Number(e.target.value))}
              style={{ flex: 1, minWidth: 160 }}
            />
            <input
              type="number"
              min={0}
              max={entries.length}
              value={step}
              data-testid="eventlog-travel-step-input"
              onChange={(e) => jumpTo(Number(e.target.value))}
              style={{ width: 72 }}
            />
            <span data-testid="eventlog-travel-step-label">
              {t('eventLogTravel.stepOf', { step: String(step), total: String(entries.length) })}
            </span>
            {playing && remaining.length > 0 && (
              <span style={{ color: 'var(--text-dim)', fontSize: 13 }}>
                {t('eventLogTravel.remaining', { count: String(remaining.length) })}
              </span>
            )}
          </div>

          <div
            data-testid="eventlog-travel-state"
            style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 8, marginBottom: 12 }}
          >
            <p style={{ margin: '0 0 4px' }}>
              <strong>{t('eventLogTravel.stateAtStep', { step: String(state.step) })}</strong>
            </p>
            <p style={{ margin: '0 0 4px', color: 'var(--text-dim)', fontSize: 13 }}>
              {t('eventLogTravel.stateLine', {
                tools: String(state.toolCalls),
                errors: String(state.errors),
                span: formatTimeTravelSpan(state.spanMs),
              })}
            </p>
            {kindCounts.length > 0 && (
              <p style={{ margin: '0 0 4px', color: 'var(--text-dim)', fontSize: 13 }}>
                {kindCounts.map(([kind, count]) => `${kind}: ${count}`).join(' · ')}
              </p>
            )}
            {state.lastTool && (
              <p style={{ margin: '0 0 4px' }}>
                {t('eventLogTravel.lastTool')}: <code>{state.lastTool}</code>
              </p>
            )}
            {state.lastText && (
              <p style={{ margin: 0 }}>
                {t('eventLogTravel.lastText')}: “{state.lastText.slice(0, 200)}”
              </p>
            )}
            {state.step === 0 && <p style={{ margin: 0 }}>{t('eventLogTravel.nothingYet')}</p>}
          </div>

          <div style={{ maxHeight: 480, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 8, padding: 8 }}>
            <ul className="task-list" style={{ margin: 0 }}>
              {state.visibleEntries.map((entry, i) => {
                const key = `${entry.at}|${entry.kind}|${i}`;
                const isOpen = expanded.has(key);
                return (
                  <li key={key}>
                    <div className="row" style={{ justifyContent: 'space-between' }}>
                      <span>
                        <span
                          className="badge"
                          style={{ background: KIND_COLORS[entry.kind], color: '#fff', marginRight: 8 }}
                        >
                          {entry.kind}
                        </span>
                        <strong>{timeTravelStepLabel(entry)}</strong>
                      </span>
                      <span style={{ fontSize: 12, color: 'var(--text-dim)', whiteSpace: 'nowrap' }}>
                        #{i + 1} · {formatTime(entry.at)}
                      </span>
                    </div>
                    <button
                      type="button"
                      className="btn secondary"
                      style={{ marginTop: 6, padding: '2px 8px', fontSize: 12 }}
                      onClick={() => toggleExpanded(key)}
                    >
                      {isOpen ? t('eventLogTravel.hidePayload') : t('eventLogTravel.showPayload')}
                    </button>
                    {isOpen && (
                      <pre
                        style={{
                          margin: '8px 0 0',
                          padding: 8,
                          background: 'var(--bg)',
                          borderRadius: 6,
                          fontSize: 12,
                          overflowX: 'auto',
                          whiteSpace: 'pre-wrap',
                          wordBreak: 'break-word',
                        }}
                      >
                        {JSON.stringify(entry.payload, null, 2)}
                      </pre>
                    )}
                  </li>
                );
              })}
              {showFuture &&
                entries.slice(state.step).map((entry, j) => {
                  const i = state.step + j;
                  return (
                    <li key={`future-${i}`} style={{ opacity: 0.45 }}>
                      <div className="row" style={{ justifyContent: 'space-between' }}>
                        <span>
                          <span
                            className="badge"
                            style={{ background: KIND_COLORS[entry.kind], color: '#fff', marginRight: 8 }}
                          >
                            {entry.kind}
                          </span>
                          <span>{timeTravelStepLabel(entry)}</span>
                        </span>
                        <span style={{ fontSize: 12, color: 'var(--text-dim)', whiteSpace: 'nowrap' }}>
                          #{i + 1} · {formatTime(entry.at)} · {t('eventLogTravel.future')}
                        </span>
                      </div>
                    </li>
                  );
                })}
            </ul>
          </div>
        </>
      )}
    </div>
  );
}

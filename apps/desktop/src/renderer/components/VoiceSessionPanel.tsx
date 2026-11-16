/**
 * Voice session panel (v1.08, Team T5 — voice v7 + UI).
 *
 * Manages the mock v7 voice sessions that live in the main
 * process (IPC `voice-v7:*`, backed by a `VoiceV7Manager` there):
 * list running / finished sessions, open one to watch its
 * streaming transcript live (word by word, user vs agent,
 * listening / thinking / speaking), stop or delete it, and see
 * duration + token totals. Advanced controls live behind this
 * panel, not in the chat composer: VAD preset switching,
 * barge-in (interrupt / duck / resume the cut reply) and a
 * scripted mock turn (type what the user says, watch the agent
 * reply stream in).
 *
 * Self-contained like MemoryBlocksView: it loads its own data
 * through `window.openBot.voiceV7*` and polls (list every 2s,
 * transcript every 700ms while a live session is selected). When
 * the preload has not exposed the methods yet it reports
 * "unavailable" instead of crashing. All sessions are mock
 * (no provider, no key, no network) unless the host wires a live
 * transport — the panel says so.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useT } from '../i18n/useT';
import VoicePanelV11 from './VoicePanelV11';
import {
  filterTranscriptV7Lines,
  formatVoiceV7Duration,
  formatVoiceV7Tokens,
  isVoiceV7VadPreset,
  splitVoiceV7Sessions,
  toTranscriptV7LineViews,
  toVoiceSessionV7RowViews,
  toVoiceV7VadView,
  voiceV7SessionRowSummary,
  type TranscriptV7LineView,
  type VoiceSessionV7RowView,
  type VoiceV7VadView,
} from './voiceSessionV7View';

const LIST_POLL_MS = 2000;
const TRANSCRIPT_POLL_MS = 700;

interface VoiceV7Api {
  voiceV7List?: () => Promise<{ sessions?: unknown; manager?: unknown }>;
  voiceV7Create?: (payload: {
    id?: string;
    provider?: string;
    voiceId?: string;
    vadPreset?: string;
    connect?: boolean;
  }) => Promise<{ ok: boolean; sessionId?: string; summary?: unknown; error?: string }>;
  voiceV7Connect?: (payload: { id: string }) => Promise<{ ok: boolean; error?: string }>;
  voiceV7Stop?: (payload: { id: string }) => Promise<{ ok: boolean; error?: string }>;
  voiceV7Delete?: (payload: { id: string }) => Promise<{ ok: boolean; deleted?: boolean; error?: string }>;
  voiceV7Transcript?: (payload: {
    id: string;
    limit?: number;
  }) => Promise<{ ok: boolean; phase?: string; lines?: unknown; stats?: unknown; error?: string }>;
  voiceV7Simulate?: (payload: {
    id: string;
    userText: string;
    modelReply?: string;
  }) => Promise<{ ok: boolean; simulated?: boolean; error?: string }>;
  voiceV7Vad?: (payload: {
    id: string;
    action: 'status' | 'config';
    preset?: string;
  }) => Promise<{ ok: boolean; stats?: unknown; config?: unknown; error?: string }>;
  voiceV7BargeIn?: (payload: {
    id: string;
    action: 'status' | 'interrupt' | 'duck' | 'resume';
    rms?: number;
  }) => Promise<{ ok: boolean; result?: unknown; partial?: unknown; resumePrompt?: string; error?: string }>;
}

function voiceV7Api(): VoiceV7Api | null {
  const api = window.openBot as unknown as VoiceV7Api | undefined;
  if (!api || typeof api.voiceV7List !== 'function') return null;
  return api;
}

function newSessionId(): string {
  return `call-${Date.now().toString(36)}`;
}

interface Props {
  onBack?: () => void;
}

export default function VoiceSessionPanel({ onBack }: Props) {
  const t = useT();
  const [sessions, setSessions] = useState<VoiceSessionV7RowView[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [transcript, setTranscript] = useState<TranscriptV7LineView[]>([]);
  const [phase, setPhase] = useState('idle');
  const [vad, setVad] = useState<VoiceV7VadView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [newProvider, setNewProvider] = useState('openai');
  const [newPreset, setNewPreset] = useState('office');
  const [newConnect, setNewConnect] = useState(true);
  const [simulateText, setSimulateText] = useState('');
  const [simulateReply, setSimulateReply] = useState('');
  const [transcriptFilter, setTranscriptFilter] = useState<'all' | 'user' | 'agent'>('all');
  // v1.14 (Team T6): toggle the voice panel v11 (latency, barge-in,
  // wake word, provider picker). Hidden by default (progressive disclosure).
  const [showV11Panel, setShowV11Panel] = useState(false);
  const [lastPartial, setLastPartial] = useState('');
  const selectedIdRef = useRef('');
  selectedIdRef.current = selectedId;
  const transcriptRef = useRef<HTMLDivElement | null>(null);

  const loadList = useCallback(async () => {
    const api = voiceV7Api();
    if (!api) {
      setLoading(false);
      setError(t('voice.v7.unavailable'));
      return;
    }
    try {
      const res = await api.voiceV7List!();
      const rows = toVoiceSessionV7RowViews(res.sessions);
      setSessions(rows);
      setError('');
      if (selectedIdRef.current === '' && rows.length > 0) {
        setSelectedId(rows[0]!.id);
      } else if (selectedIdRef.current !== '' && !rows.some((r) => r.id === selectedIdRef.current)) {
        setSelectedId(rows.length > 0 ? rows[0]!.id : '');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : t('voice.v7.loadError'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  const loadTranscript = useCallback(async () => {
    const id = selectedIdRef.current;
    if (id === '') return;
    const api = voiceV7Api();
    if (!api || typeof api.voiceV7Transcript !== 'function') return;
    try {
      const res = await api.voiceV7Transcript({ id, limit: 100 });
      if (!res.ok) return;
      setTranscript(toTranscriptV7LineViews(res.lines));
      if (typeof res.phase === 'string') setPhase(res.phase);
    } catch {
      // Best-effort poll — the list poll reports real errors.
    }
  }, []);

  const loadVad = useCallback(async () => {
    const id = selectedIdRef.current;
    if (id === '') return;
    const api = voiceV7Api();
    if (!api || typeof api.voiceV7Vad !== 'function') return;
    try {
      const res = await api.voiceV7Vad({ id, action: 'status' });
      if (res.ok) setVad(toVoiceV7VadView(res));
    } catch {
      // Best-effort — the panel works without the VAD line.
    }
  }, []);

  useEffect(() => {
    void loadList();
    const timer = setInterval(() => void loadList(), LIST_POLL_MS);
    return () => clearInterval(timer);
  }, [loadList]);

  useEffect(() => {
    if (selectedId === '') return;
    void loadTranscript();
    void loadVad();
    const timer = setInterval(() => {
      void loadTranscript();
      void loadVad();
    }, TRANSCRIPT_POLL_MS);
    return () => clearInterval(timer);
  }, [selectedId, loadTranscript, loadVad]);

  useEffect(() => {
    const el = transcriptRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [transcript]);

  const selected = sessions.find((s) => s.id === selectedId) ?? null;
  const { running, finished } = splitVoiceV7Sessions(sessions);
  const shownLines = filterTranscriptV7Lines(
    transcript,
    transcriptFilter === 'all' ? undefined : transcriptFilter,
  );

  const create = async () => {
    const api = voiceV7Api();
    if (!api || typeof api.voiceV7Create !== 'function') {
      setError(t('voice.v7.unavailable'));
      return;
    }
    setError('');
    try {
      const id = newSessionId();
      const res = await api.voiceV7Create({
        id,
        provider: newProvider,
        vadPreset: newPreset,
        connect: newConnect,
      });
      if (!res.ok) {
        setError(res.error ?? t('voice.v7.createError'));
        return;
      }
      setNotice(t('voice.v7.created', { id: res.sessionId ?? id }));
      setSelectedId(res.sessionId ?? id);
      await loadList();
    } catch (e) {
      setError(e instanceof Error ? e.message : t('voice.v7.createError'));
    }
  };

  const connect = async (id: string) => {
    const api = voiceV7Api();
    if (!api || typeof api.voiceV7Connect !== 'function') return;
    setError('');
    try {
      const res = await api.voiceV7Connect({ id });
      if (!res.ok) setError(res.error ?? t('voice.v7.connectError'));
      else setNotice(t('voice.v7.connected', { id }));
      await loadList();
    } catch (e) {
      setError(e instanceof Error ? e.message : t('voice.v7.connectError'));
    }
  };

  const stop = async (id: string) => {
    const api = voiceV7Api();
    if (!api || typeof api.voiceV7Stop !== 'function') return;
    setError('');
    try {
      const res = await api.voiceV7Stop({ id });
      if (!res.ok) setError(res.error ?? t('voice.v7.stopError'));
      else setNotice(t('voice.v7.stopped', { id }));
      await loadList();
    } catch (e) {
      setError(e instanceof Error ? e.message : t('voice.v7.stopError'));
    }
  };

  const remove = async (id: string) => {
    const api = voiceV7Api();
    if (!api || typeof api.voiceV7Delete !== 'function') return;
    setError('');
    try {
      const res = await api.voiceV7Delete({ id });
      if (!res.ok) setError(res.error ?? t('voice.v7.deleteError'));
      else {
        setNotice(t('voice.v7.deleted', { id }));
        if (selectedIdRef.current === id) {
          setSelectedId('');
          setTranscript([]);
        }
      }
      await loadList();
    } catch (e) {
      setError(e instanceof Error ? e.message : t('voice.v7.deleteError'));
    }
  };

  const simulate = async () => {
    const id = selectedIdRef.current;
    const api = voiceV7Api();
    if (id === '' || !api || typeof api.voiceV7Simulate !== 'function') return;
    setError('');
    try {
      const res = await api.voiceV7Simulate({
        id,
        userText: simulateText.trim(),
        ...(simulateReply.trim() ? { modelReply: simulateReply.trim() } : {}),
      });
      if (!res.ok) {
        setError(res.error ?? t('voice.v7.simulateError'));
        return;
      }
      if (res.simulated === false) {
        setError(t('voice.v7.simulateBusy'));
        return;
      }
      setSimulateText('');
      setNotice(t('voice.v7.simulated', { id }));
      await loadTranscript();
    } catch (e) {
      setError(e instanceof Error ? e.message : t('voice.v7.simulateError'));
    }
  };

  const bargeIn = async (action: 'interrupt' | 'duck' | 'resume') => {
    const id = selectedIdRef.current;
    const api = voiceV7Api();
    if (id === '' || !api || typeof api.voiceV7BargeIn !== 'function') return;
    setError('');
    try {
      const res = await api.voiceV7BargeIn({ id, action });
      if (!res.ok) {
        setError(res.error ?? t('voice.v7.bargeInError'));
        return;
      }
      if (action === 'interrupt') {
        const partial = (res.result as { partialText?: string } | undefined)?.partialText ?? '';
        setLastPartial(partial);
        setNotice(t('voice.v7.interrupted', { id }));
      } else if (action === 'duck') {
        setNotice(t('voice.v7.ducked', { id }));
      } else {
        setNotice(t('voice.v7.resumed', { id }));
        if (typeof res.resumePrompt === 'string' && res.resumePrompt !== '') {
          setLastPartial(res.resumePrompt);
        }
      }
      await loadTranscript();
      await loadList();
    } catch (e) {
      setError(e instanceof Error ? e.message : t('voice.v7.bargeInError'));
    }
  };

  const changeVadPreset = async (preset: string) => {
    const id = selectedIdRef.current;
    const api = voiceV7Api();
    if (id === '' || !isVoiceV7VadPreset(preset) || !api || typeof api.voiceV7Vad !== 'function') return;
    setNewPreset(preset);
    setError('');
    try {
      const res = await api.voiceV7Vad({ id, action: 'config', preset });
      if (!res.ok) setError(res.error ?? t('voice.v7.vadError'));
      else {
        setVad(toVoiceV7VadView(res));
        setNotice(t('voice.v7.vadPresetSet', { preset }));
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : t('voice.v7.vadError'));
    }
  };

  const phaseText =
    phase === 'listening'
      ? t('voice.v7.phaseListening')
      : phase === 'thinking'
        ? t('voice.v7.phaseThinking')
        : phase === 'speaking'
          ? t('voice.v7.phaseSpeaking')
          : t('voice.v7.phaseIdle');

  return (
    <div className="panel">
      {onBack && (
        <button className="btn secondary" onClick={onBack}>
          {t('voice.v7.back')}
        </button>
      )}
      <h2>{t('voice.v7.title')}</h2>
      <p className="hint">{t('voice.v7.intro')}</p>
      <p className="hint">{t('voice.v7.mockOnly')}</p>
      <button className="btn secondary" onClick={() => setShowV11Panel((v) => !v)}>
        {t('voicePanelV11.title')}
      </button>
      {showV11Panel && <VoicePanelV11 />}
      {loading && <p className="hint">{t('voice.v7.loading')}</p>}
      {error && <p className="error">{error}</p>}
      {notice && <p className="hint" data-testid="voice-v7-notice">{notice}</p>}

      <h3>{t('voice.v7.createTitle')}</h3>
      <div className="row">
        <label>
          {t('voice.v7.provider')}{' '}
          <select value={newProvider} onChange={(e) => setNewProvider(e.target.value)} data-testid="voice-v7-new-provider">
            <option value="openai">openai</option>
            <option value="gemini">gemini</option>
            <option value="openai-compatible">openai-compatible</option>
          </select>
        </label>
        <label>
          {t('voice.v7.vadPreset')}{' '}
          <select value={newPreset} onChange={(e) => setNewPreset(e.target.value)} data-testid="voice-v7-new-preset">
            <option value="quiet">{t('voice.v7.presetQuiet')}</option>
            <option value="office">{t('voice.v7.presetOffice')}</option>
            <option value="noisy">{t('voice.v7.presetNoisy')}</option>
            <option value="very-noisy">{t('voice.v7.presetVeryNoisy')}</option>
          </select>
        </label>
        <label>
          <input type="checkbox" checked={newConnect} onChange={(e) => setNewConnect(e.target.checked)} />{' '}
          {t('voice.v7.connectNow')}
        </label>
        <button className="btn" data-testid="voice-v7-create" onClick={() => void create()}>
          {t('voice.v7.create')}
        </button>
      </div>

      {!loading && sessions.length === 0 && !error && (
        <p className="hint" data-testid="voice-v7-empty">{t('voice.v7.empty')}</p>
      )}
      {running.length > 0 && (
        <>
          <h3>{t('voice.v7.runningTitle')}</h3>
          <ul data-testid="voice-v7-running-list">
            {running.map((row) => (
              <SessionRow
                key={row.id}
                row={row}
                selected={row.id === selectedId}
                onSelect={() => setSelectedId(row.id)}
                onStop={() => void stop(row.id)}
                onDelete={() => void remove(row.id)}
              />
            ))}
          </ul>
        </>
      )}
      {finished.length > 0 && (
        <>
          <h3>{t('voice.v7.finishedTitle')}</h3>
          <ul data-testid="voice-v7-finished-list">
            {finished.map((row) => (
              <SessionRow
                key={row.id}
                row={row}
                selected={row.id === selectedId}
                onSelect={() => setSelectedId(row.id)}
                onConnect={() => void connect(row.id)}
                onDelete={() => void remove(row.id)}
              />
            ))}
          </ul>
        </>
      )}

      {selected && (
        <div data-testid="voice-v7-detail">
          <h3>{t('voice.v7.detailTitle', { id: selected.id })}</h3>
          <p className="hint" data-testid="voice-v7-summary">
            {voiceV7SessionRowSummary(selected)}
          </p>
          <p className="hint">
            <strong>{t('voice.v7.phase')}:</strong> {phaseText}
          </p>
          {vad && (
            <p className="hint" data-testid="voice-v7-vad">
              {t('voice.v7.vadStatus', {
                preset: vad.preset,
                threshold: vad.threshold.toFixed(3),
                floor: vad.noiseFloor.toFixed(4),
                fp: String(vad.falsePositives),
              })}
            </p>
          )}
          <div className="row">
            <label>
              {t('voice.v7.vadPreset')}{' '}
              <select
                value={vad?.preset ?? newPreset}
                onChange={(e) => void changeVadPreset(e.target.value)}
                data-testid="voice-v7-vad-preset"
              >
                <option value="quiet">{t('voice.v7.presetQuiet')}</option>
                <option value="office">{t('voice.v7.presetOffice')}</option>
                <option value="noisy">{t('voice.v7.presetNoisy')}</option>
                <option value="very-noisy">{t('voice.v7.presetVeryNoisy')}</option>
              </select>
            </label>
            {selected.callState === 'speaking' && (
              <>
                <button className="btn" data-testid="voice-v7-interrupt" onClick={() => void bargeIn('interrupt')}>
                  {t('voice.v7.interrupt')}
                </button>
                <button className="btn secondary" data-testid="voice-v7-duck" onClick={() => void bargeIn('duck')}>
                  {t('voice.v7.duck')}
                </button>
              </>
            )}
            {lastPartial !== '' && (
              <button className="btn secondary" data-testid="voice-v7-resume" onClick={() => void bargeIn('resume')}>
                {t('voice.v7.resume')}
              </button>
            )}
          </div>
          {lastPartial !== '' && (
            <p className="hint" data-testid="voice-v7-partial">
              {t('voice.v7.lastPartial')}: “{lastPartial}”
            </p>
          )}

          <h3>{t('voice.v7.transcriptTitle')}</h3>
          <div className="row">
            <button
              type="button"
              className="btn secondary"
              aria-pressed={transcriptFilter === 'all'}
              onClick={() => setTranscriptFilter('all')}
            >
              {t('voice.v7.filterAll')}
            </button>
            <button
              type="button"
              className="btn secondary"
              aria-pressed={transcriptFilter === 'user'}
              onClick={() => setTranscriptFilter('user')}
            >
              {t('voice.v7.filterUser')}
            </button>
            <button
              type="button"
              className="btn secondary"
              aria-pressed={transcriptFilter === 'agent'}
              onClick={() => setTranscriptFilter('agent')}
            >
              {t('voice.v7.filterAgent')}
            </button>
          </div>
          <div
            ref={transcriptRef}
            data-testid="voice-v7-transcript"
            style={{ maxHeight: 320, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 8, padding: 8 }}
          >
            {shownLines.length === 0 && <p className="empty">{t('voice.v7.transcriptEmpty')}</p>}
            {shownLines.map((line) => (
              <p
                key={line.id}
                className={line.speaker === 'user' ? 'msg user' : 'msg assistant'}
                style={line.interrupted ? { opacity: 0.75 } : undefined}
              >
                <strong>{line.speaker === 'user' ? t('voice.v7.user') : t('voice.v7.agent')}: </strong>
                {line.text}
                {!line.isFinal && ` ${t('voice.v7.interim')}`}
                {line.interrupted && ` (${t('voice.v7.interruptedLine')})`}
              </p>
            ))}
          </div>

          <h3>{t('voice.v7.simulateTitle')}</h3>
          <label>
            {t('voice.v7.simulateUser')}
            <input
              type="text"
              value={simulateText}
              data-testid="voice-v7-simulate-user"
              onChange={(e) => setSimulateText(e.target.value)}
              placeholder={t('voice.v7.simulateUserPlaceholder')}
            />
          </label>
          <label>
            {t('voice.v7.simulateReply')}
            <input
              type="text"
              value={simulateReply}
              data-testid="voice-v7-simulate-reply"
              onChange={(e) => setSimulateReply(e.target.value)}
              placeholder={t('voice.v7.simulateReplyPlaceholder')}
            />
          </label>
          <div className="row">
            <button
              className="btn"
              data-testid="voice-v7-simulate"
              onClick={() => void simulate()}
              disabled={simulateText.trim() === '' || !selected.connected}
            >
              {t('voice.v7.simulate')}
            </button>
          </div>
          {!selected.connected && <p className="hint">{t('voice.v7.simulateNeedsConnection')}</p>}
        </div>
      )}
    </div>
  );
}

interface SessionRowProps {
  row: VoiceSessionV7RowView;
  selected: boolean;
  onSelect: () => void;
  onStop?: () => void;
  onConnect?: () => void;
  onDelete: () => void;
}

function SessionRow({ row, selected, onSelect, onStop, onConnect, onDelete }: SessionRowProps) {
  const t = useT();
  return (
    <li key={row.id} className="card" data-testid={`voice-v7-row-${row.id}`}>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <strong>{row.id}</strong>
        <span className="hint">
          {row.callState} · {row.phase}
          {row.restoredFrom ? ` · ${t('voice.v7.restored')}` : ''}
        </span>
      </div>
      <p className="hint">
        {row.provider}
        {row.voiceName ? ` · ${row.voiceName}` : ''} ·{' '}
        {t('voice.v7.rowStats', {
          duration: formatVoiceV7Duration(row.durationMs),
          tokens: formatVoiceV7Tokens(row.inputTokens + row.outputTokens),
          lines: String(row.lines),
          interrupts: String(row.interrupts),
        })}
      </p>
      <div className="row">
        <button className="btn secondary" data-testid={`voice-v7-select-${row.id}`} onClick={onSelect}>
          {selected ? t('voice.v7.selected') : t('voice.v7.select')}
        </button>
        {onConnect && (
          <button className="btn secondary" data-testid={`voice-v7-connect-${row.id}`} onClick={onConnect}>
            {t('voice.v7.connect')}
          </button>
        )}
        {onStop && (
          <button className="btn secondary" data-testid={`voice-v7-stop-${row.id}`} onClick={onStop}>
            {t('voice.v7.stop')}
          </button>
        )}
        <button className="btn secondary" data-testid={`voice-v7-delete-${row.id}`} onClick={onDelete}>
          {t('voice.v7.delete')}
        </button>
      </div>
    </li>
  );
}

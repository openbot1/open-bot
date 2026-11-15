/**
 * Voice session v8 status panel (v1.09, Team T5 — voice v8 + UI).
 *
 * Presentational panel for one v8 voice session: the live status
 * (listening / speaking / thinking / reconnecting / disconnected),
 * the waveform (mic RMS levels as bars), the push-to-talk button
 * (hold to talk in push-to-talk mode, mic always open in auto),
 * the VAD readout (engine, preset, noise kind, false positives)
 * and the barge-in readout (interrupts, echo-only rejections,
 * discarded audio). The reconnect banner shows while the session
 * redials, with the attempt count.
 *
 * Deliberately presentational: the host owns the data (it passes
 * parsed rows + stats from `voiceSessionV8View` and wires the
 * callbacks to its own IPC / tools). There is no `voice-v8:*`
 * preload API yet — inventing IPC calls here would be dead code,
 * so the panel takes callbacks and the host binds them when the
 * main-process v8 API lands. All strings go through `useT()` and
 * the `voice.v8.*` keys (6 locales).
 */
import { useCallback } from 'react';
import { useT } from '../i18n/useT';
import {
  formatVoiceV8AudioMs,
  formatVoiceV8Duration,
  pttView,
  voiceV8InputModeLabelKey,
  voiceV8NoiseKindLabelKey,
  voiceV8StatusLabelKey,
  waveformBars,
  type VoiceSessionV8RowView,
  type VoiceV8BargeInView,
  type VoiceV8VadView,
} from '../voice/voiceSessionV8View';

export interface VoiceSessionV8PanelProps {
  /** Sessions to list (already parsed by `toVoiceSessionV8RowViews`). */
  sessions: readonly VoiceSessionV8RowView[];
  /** Selected session id (null = none). */
  selectedId: string | null;
  onSelect: (id: string) => void;
  onStop: (id: string) => void;
  onDelete: (id: string) => void;
  onInterrupt: (id: string) => void;
  onDuck: (id: string) => void;
  onResume: (id: string) => void;
  onPttPress: (id: string) => void;
  onPttRelease: (id: string) => void;
  onModeChange: (id: string, mode: 'auto' | 'push-to-talk') => void;
  /** VAD stats of the selected session (null while loading). */
  vad: VoiceV8VadView | null;
  /** Barge-in stats of the selected session (null while loading). */
  bargeIn: VoiceV8BargeInView | null;
  /** Recent mic RMS levels (0..1) for the waveform. */
  levels: readonly number[];
  /** Reconnect attempt in progress (null when not reconnecting). */
  reconnectAttempt: number | null;
  onBack: () => void;
}

/** Status dot colour (CSS class suffix). */
export function voiceV8StatusTone(status: VoiceSessionV8RowView['status']): string {
  switch (status) {
    case 'listening':
      return 'ok';
    case 'speaking':
      return 'active';
    case 'thinking':
      return 'busy';
    case 'reconnecting':
      return 'warn';
    case 'disconnected':
      return 'bad';
    default:
      return 'idle';
  }
}

export default function VoiceSessionV8Panel(props: VoiceSessionV8PanelProps) {
  const t = useT();
  const {
    sessions,
    selectedId,
    onSelect,
    onStop,
    onDelete,
    onInterrupt,
    onDuck,
    onResume,
    onPttPress,
    onPttRelease,
    onModeChange,
    vad,
    bargeIn,
    levels,
    reconnectAttempt,
    onBack,
  } = props;
  const selected = sessions.find((s) => s.id === selectedId) ?? null;
  const bars = waveformBars(levels, 24);
  const ptt = selected ? pttView(selected) : null;

  const handlePress = useCallback(() => {
    if (selected) onPttPress(selected.id);
  }, [onPttPress, selected]);
  const handleRelease = useCallback(() => {
    if (selected) onPttRelease(selected.id);
  }, [onPttRelease, selected]);

  return (
    <div className="voice-v8-panel">
      <div className="voice-v8-panel__header">
        <button type="button" onClick={onBack} className="voice-v8-panel__back">
          ←
        </button>
        <h2>{t('voice.v8.title')}</h2>
      </div>

      {sessions.length === 0 ? (
        <p className="voice-v8-panel__empty">{t('voice.v8.status.idle')}</p>
      ) : (
        <ul className="voice-v8-panel__list">
          {sessions.map((row) => (
            <li key={row.id}>
              <button
                type="button"
                className={row.id === selectedId ? 'voice-v8-panel__row voice-v8-panel__row--selected' : 'voice-v8-panel__row'}
                onClick={() => onSelect(row.id)}
              >
                <span className={`voice-v8-panel__dot voice-v8-panel__dot--${voiceV8StatusTone(row.status)}`} />
                <span className="voice-v8-panel__id">{row.id}</span>
                <span className="voice-v8-panel__status">{t(voiceV8StatusLabelKey(row.status))}</span>
                <span className="voice-v8-panel__duration">{formatVoiceV8Duration(row.durationMs)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {selected ? (
        <div className="voice-v8-panel__detail">
          {selected.status === 'reconnecting' ? (
            <p className="voice-v8-panel__banner">
              {t('voice.v8.status.reconnecting')}
              {reconnectAttempt !== null ? ` · #${reconnectAttempt}` : ''}
            </p>
          ) : null}
          {selected.restoredFrom ? <p className="voice-v8-panel__banner">{t('voice.v8.session.restored')}</p> : null}

          <div className="voice-v8-panel__waveform" aria-label={t(voiceV8StatusLabelKey(selected.status))}>
            {bars.map((bar) => (
              <span
                key={bar.index}
                className={bar.live ? 'voice-v8-panel__bar voice-v8-panel__bar--live' : 'voice-v8-panel__bar'}
                style={{ height: `${Math.max(4, Math.round(bar.height * 100))}%` }}
              />
            ))}
          </div>

          <p className="voice-v8-panel__mode">
            {t(voiceV8InputModeLabelKey(selected.inputMode))}
            {' · '}
            {selected.provider}
            {selected.voiceName ? ` · ${selected.voiceName}` : ''}
            {selected.snapshotSaved ? ` · ${t('voice.v8.session.saved')}` : ''}
          </p>

          <div className="voice-v8-panel__ptt">
            <button
              type="button"
              disabled={!ptt?.enabled}
              onMouseDown={handlePress}
              onMouseUp={handleRelease}
              onMouseLeave={handleRelease}
              onTouchStart={handlePress}
              onTouchEnd={handleRelease}
              className={ptt?.pressed ? 'voice-v8-panel__ptt-btn voice-v8-panel__ptt-btn--held' : 'voice-v8-panel__ptt-btn'}
            >
              {ptt ? t(ptt.labelKey) : t('voice.v8.ptt.auto')}
            </button>
            <select
              value={selected.inputMode}
              onChange={(e) => onModeChange(selected.id, e.target.value as 'auto' | 'push-to-talk')}
              aria-label={t('voice.v8.inputMode.auto')}
            >
              <option value="auto">{t('voice.v8.inputMode.auto')}</option>
              <option value="push-to-talk">{t('voice.v8.inputMode.push-to-talk')}</option>
            </select>
          </div>

          <div className="voice-v8-panel__actions">
            <button type="button" onClick={() => onInterrupt(selected.id)} disabled={selected.status !== 'speaking'}>
              {t('voice.realtime.interrupt')}
            </button>
            <button type="button" onClick={() => onDuck(selected.id)} disabled={selected.status !== 'speaking'}>
              {t('voice.v7.duck')}
            </button>
            <button type="button" onClick={() => onResume(selected.id)}>
              {t('voice.v8.session.resumed')}
            </button>
            <button type="button" onClick={() => onStop(selected.id)}>
              {t('voice.callEnd')}
            </button>
            <button type="button" onClick={() => onDelete(selected.id)}>
              {t('voice.callEnded')}
            </button>
          </div>

          {vad ? (
            <dl className="voice-v8-panel__vad">
              <dt>{t('voice.v8.vad.calibrating')}</dt>
              <dd>{vad.calibrating ? t('voice.v8.vad.calibrating') : t(voiceV8NoiseKindLabelKey(vad.noiseKind))}</dd>
              <dt>VAD</dt>
              <dd>
                {vad.engine}/{vad.preset} · {t(voiceV8NoiseKindLabelKey(vad.noiseKind))} · flat {vad.spectralFlatness.toFixed(2)} ·{' '}
                {vad.turns} turns · {vad.falsePositives} fp
              </dd>
            </dl>
          ) : null}

          {bargeIn ? (
            <dl className="voice-v8-panel__bargein">
              <dt>{t('voice.v8.bargeIn.interrupted')}</dt>
              <dd>
                {bargeIn.interrupts} ({bargeIn.thinkingInterrupts} {t('voice.v8.status.thinking')}) · {bargeIn.ducks} duck ·{' '}
                {bargeIn.echoOnlyFrames} echo-only · {formatVoiceV8AudioMs(bargeIn.totalAudioDiscardedMs)}/
                {bargeIn.totalWordsDiscarded}w discarded
              </dd>
            </dl>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

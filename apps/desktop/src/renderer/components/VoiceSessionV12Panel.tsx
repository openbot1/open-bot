/**
 * Voice session v12 status panel (v1.13, Team T5 — voice v12 + UI).
 *
 * Presentational panel for v12 voice sessions: the unified turn
 * machine state (listening / thinking / speaking / interrupted /
 * cooldown), the overlap list (who won, agent words lost, duck
 * depth), the interrupt-context card (cut word, played vs
 * remaining text, user interruption, resume strategy + the
 * resume button), the end-of-turn readout (turns, backchannels,
 * false starts, merged pauses) and the planned TTS chunks with
 * per-word timings (the word being spoken is highlighted).
 *
 * Deliberately presentational: the host owns the data (it passes
 * parsed rows + stats from `voiceSessionV12View` and wires the
 * callbacks to its own IPC / tools). There is no `voice-v12:*`
 * preload API yet — inventing IPC calls here would be dead code,
 * so the panel takes callbacks and the host binds them when the
 * main-process v12 API lands. All strings go through `useT()` and
 * the `voice.realtime.v12.*` keys (6 locales).
 */
import { useCallback } from 'react';
import { useT } from '../i18n/useT';
import {
  formatVoiceV12Duration,
  formatVoiceV12Volume,
  voiceV12OverlapWinnerKey,
  voiceV12ResumeStrategyKey,
  voiceV12StatusKey,
  type VoiceV12EndOfTurnView,
  type VoiceV12InterruptContextView,
  type VoiceV12OverlapRowView,
  type VoiceV12OverlapView,
  type VoiceV12PlannedChunkRowView,
  type VoiceV12TurnMachineView,
  type VoiceSessionV12RowView,
} from '../voice/voiceSessionV12View';

export interface VoiceSessionV12PanelProps {
  /** Sessions to list (already parsed by `parseVoiceSessionV12Row`). */
  sessions: readonly VoiceSessionV12RowView[];
  /** Selected session id (null = none). */
  selectedId: string | null;
  onSelect: (id: string) => void;
  onStop: (id: string) => void;
  onDelete: (id: string) => void;
  onInterrupt: (id: string) => void;
  onDuck: (id: string) => void;
  onResume: (id: string) => void;
  /** Resume the last interrupted reply (null when nothing to resume). */
  onResumeReply: (id: string) => void;
  /** Turn-machine stats of the selected session (null while loading). */
  turnMachine: VoiceV12TurnMachineView | null;
  /** End-of-turn stats of the selected session (null while loading). */
  endOfTurn: VoiceV12EndOfTurnView | null;
  /** Overlap stats of the selected session (null while loading). */
  overlap: VoiceV12OverlapView | null;
  /** Overlap segments of the selected session (newest last). */
  overlapRows: readonly VoiceV12OverlapRowView[];
  /** Interrupt-context card of the selected session (null when nothing cut yet). */
  interruptContext: VoiceV12InterruptContextView | null;
  /** Planned TTS chunks of the last reply. */
  plannedChunks: readonly VoiceV12PlannedChunkRowView[];
  onBack: () => void;
}

/** Status dot colour (CSS class suffix). */
export function voiceV12StatusTone(status: VoiceSessionV12RowView['status']): string {
  switch (status) {
    case 'listening':
      return 'ok';
    case 'speaking':
      return 'active';
    case 'thinking':
      return 'busy';
    case 'interrupted':
      return 'warn';
    case 'cooldown':
      return 'warn';
    case 'closed':
      return 'bad';
    default:
      return 'idle';
  }
}

export default function VoiceSessionV12Panel(props: VoiceSessionV12PanelProps) {
  const t = useT();
  const {
    sessions, selectedId, onSelect, onStop, onDelete, onInterrupt,
    onDuck, onResume, onResumeReply, turnMachine, endOfTurn, overlap,
    overlapRows, interruptContext, plannedChunks, onBack,
  } = props;
  const selected = sessions.find((s) => s.id === selectedId) ?? null;

  const handleInterrupt = useCallback(() => {
    if (selected) onInterrupt(selected.id);
  }, [selected, onInterrupt]);
  const handleDuck = useCallback(() => {
    if (selected) onDuck(selected.id);
  }, [selected, onDuck]);
  const handleResume = useCallback(() => {
    if (selected) onResume(selected.id);
  }, [selected, onResume]);
  const handleResumeReply = useCallback(() => {
    if (selected) onResumeReply(selected.id);
  }, [selected, onResumeReply]);
  const handleStop = useCallback(() => {
    if (selected) onStop(selected.id);
  }, [selected, onStop]);
  const handleDelete = useCallback(() => {
    if (selected) onDelete(selected.id);
  }, [selected, onDelete]);

  return (
    <section className="voice-v12-panel">
      <header className="voice-v12-panel__header">
        <button type="button" onClick={onBack} className="voice-v12-panel__back">←</button>
        <h2>{t('voice.realtime.v12.title')}</h2>
        <p className="voice-v12-panel__subtitle">{t('voice.realtime.v12.subtitle')}</p>
      </header>

      {sessions.length === 0 ? (
        <p className="voice-v12-panel__empty">{t('voice.realtime.v12.status.idle')}</p>
      ) : (
        <ul className="voice-v12-panel__list">
          {sessions.map((session) => (
            <li key={session.id}>
              <button
                type="button"
                onClick={() => onSelect(session.id)}
                className={`voice-v12-panel__row${session.id === selectedId ? ' voice-v12-panel__row--selected' : ''}`}
                aria-pressed={session.id === selectedId}
              >
                <span className={`voice-v12-panel__dot voice-v12-panel__dot--${voiceV12StatusTone(session.status)}`} />
                <span className="voice-v12-panel__id">{session.id}</span>
                <span>{t(voiceV12StatusKey(session.status))}</span>
                <span>{t('voice.realtime.v12.turns')}: {session.turns}</span>
                <span>{t('voice.realtime.v12.overlaps')}: {session.overlaps}</span>
                <span>{t('voice.realtime.v12.volume')}: {formatVoiceV12Volume(session.volume)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {selected ? (
        <div className="voice-v12-panel__detail">
          <h3>{selected.id}</h3>
          <p>
            {t(voiceV12StatusKey(selected.status))}
            {turnMachine ? ` · ${t('voice.realtime.v12.turnMachine')}: ${t(voiceV12StatusKey(turnMachine.state))}` : ''}
            {` · ${t('voice.realtime.v12.turns')}: ${selected.turns}`}
          </p>

          <div className="voice-v12-panel__actions">
            <button type="button" onClick={handleInterrupt}>{t('voice.realtime.v12.interrupt')}</button>
            <button type="button" onClick={handleDuck}>{t('voice.realtime.v12.duck')}</button>
            <button type="button" onClick={handleResume}>{t('voice.realtime.v12.resumePlayback')}</button>
            <button type="button" onClick={handleStop}>{t('voice.realtime.v12.stop')}</button>
            <button type="button" onClick={handleDelete}>{t('voice.realtime.v12.delete')}</button>
          </div>

          {endOfTurn ? (
            <p className="voice-v12-panel__eot">
              {t('voice.realtime.v12.endOfTurn')}: {t('voice.realtime.v12.turns')} {endOfTurn.turns}
              {` · ${t('voice.realtime.v12.backchannels')} ${endOfTurn.backchannels}`}
              {` · ${t('voice.realtime.v12.falseStarts')} ${endOfTurn.falseStarts}`}
              {` · ${t('voice.realtime.v12.mergedPauses')} ${endOfTurn.merged}`}
              {endOfTurn.speaking ? ` · ${t('voice.realtime.v12.speakingNow')}` : ''}
            </p>
          ) : null}

          {overlap ? (
            <p className="voice-v12-panel__overlap-summary">
              {t('voice.realtime.v12.overlaps')}: {overlap.overlaps}
              {` (${t(voiceV12OverlapWinnerKey('user'))} ${overlap.userWins}, ${t(voiceV12OverlapWinnerKey('agent'))} ${overlap.agentKeeps})`}
              {` · ${t('voice.realtime.v12.volume')}: ${formatVoiceV12Volume(overlap.volume)}`}
              {overlap.open ? ` · ${t('voice.realtime.v12.overlapOpen')}` : ''}
            </p>
          ) : null}

          {overlapRows.length > 0 ? (
            <ul className="voice-v12-panel__overlaps">
              {overlapRows.map((row) => (
                <li key={row.id}>
                  <strong>{row.label}</strong>
                  {' — '}{t(voiceV12OverlapWinnerKey(row.winner))}
                  {row.agentWordsLost.length > 0 ? ` · ${t('voice.realtime.v12.agentWordsLost')}: “${row.agentWordsLost.join(' ')}”` : ''}
                  {row.userWords.length > 0 ? ` · ${t('voice.realtime.v12.userWords')}: “${row.userWords.join(' ')}”` : ''}
                  {row.resolutionReason ? ` · ${row.resolutionReason}` : ''}
                </li>
              ))}
            </ul>
          ) : null}

          {interruptContext ? (
            <div className="voice-v12-panel__interrupt">
              <h4>{t('voice.realtime.v12.interruptContext')}</h4>
              <p>
                {t('voice.realtime.v12.cutAt', { word: interruptContext.cutWord })}
                {` · ${t('voice.realtime.v12.played')}: “${interruptContext.playedText}”`}
                {` · ${t('voice.realtime.v12.remaining')}: “${interruptContext.remainingText}”`}
              </p>
              {interruptContext.userText ? (
                <p>{t('voice.realtime.v12.userInterrupted')}: “{interruptContext.userText}”</p>
              ) : null}
              <p>
                {t('voice.realtime.v12.resumeStrategy')}: {t(voiceV12ResumeStrategyKey(interruptContext.resumeStrategy))}
                {interruptContext.resumeText ? ` — “${interruptContext.resumeText}”` : ''}
              </p>
              {interruptContext.resumeStrategy !== 'drop' && interruptContext.resumeText ? (
                <button type="button" onClick={handleResumeReply}>{t('voice.realtime.v12.resumeReply')}</button>
              ) : null}
            </div>
          ) : null}

          {plannedChunks.length > 0 ? (
            <ul className="voice-v12-panel__chunks">
              {plannedChunks.map((chunk) => (
                <li key={chunk.id}>
                  <strong>{chunk.urgent ? `! ${chunk.shortText}` : chunk.shortText}</strong>
                  {` · ${formatVoiceV12Duration(chunk.estDurationMs)} · x${chunk.pacingFactor}`}
                  {chunk.currentWord ? ` · ▶ ${chunk.currentWord}` : ''}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

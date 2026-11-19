import { useState } from 'react';
import { useT } from '../i18n/useT';
import type { VoiceV28SessionSnapshot } from '@open-bot/core';

/**
 * Voice v28 realtime session panel (v1.41, Team T5) — the small
 * strip a user watches while talking in a realtime session:
 *
 *   - session state: listening / thinking / speaking / paused
 *     (with the floor holder);
 *   - speaking style in use (formal / intimate / concise /
 *     storyteller / default) + voice id, rate and pitch —
 *     derived from the persona/human memory blocks, with the
 *     fallback preset when no block exists;
 *   - greeting rendered from the memory blocks;
 *   - live counters: turns, interruptions, chunks in/out,
 *     dropped chunks, transport latency p50.
 *
 * Data comes via props (the host builds the snapshot from core
 * `RealtimeVoiceSessionV28.snapshot` via IPC); when there is no
 * host wiring yet it uses an internal demo snapshot — the
 * component never guesses real numbers; the demo is clearly
 * labelled in code. The component never opens a mic and never
 * plays audio.
 */

export function demoVoiceV28SessionSnapshot(): VoiceV28SessionSnapshot {
  return {
    sessionId: 'demo-session-v28',
    botId: 'demo-bot',
    state: 'speaking',
    floor: 'agent',
    style: 'formal',
    voiceId: 'mock-formal',
    rate: 0.95,
    pitch: -1,
    language: 'en',
    addressForm: 'you',
    userName: 'Huy',
    turnIndex: 2,
    turns: 3,
    interruptions: 1,
    chunksIn: 42,
    chunksOut: 38,
    chunksDropped: 0,
    startedAtMs: 0,
    updatedAtMs: 1200,
    endedAtMs: null,
    stopReason: null,
    agentSpeaking: true,
    currentReply: 'Good day. Here is the summary you asked for.',
    spokenChars: 12,
    remainingChars: 28,
    events: 9,
  };
}

function stateTone(state: VoiceV28SessionSnapshot['state']): string {
  if (state === 'ended') return 'bad';
  if (state === 'paused') return 'warn';
  return 'ok';
}

export default function VoiceSessionV28Panel({
  snapshot: snapshotProp,
  greeting: greetingProp,
  latencyP50Ms,
  onPause,
  onResume,
  onStop,
}: {
  snapshot?: VoiceV28SessionSnapshot | null;
  greeting?: string | null;
  latencyP50Ms?: number | null;
  onPause?: (sessionId: string) => void;
  onResume?: (sessionId: string) => void;
  onStop?: (sessionId: string) => void;
}) {
  const t = useT();
  const [snapshot] = useState<VoiceV28SessionSnapshot>(
    () => snapshotProp ?? demoVoiceV28SessionSnapshot(),
  );
  const isDemo = !snapshotProp;
  const tone = stateTone(snapshot.state);
  const greeting = greetingProp ?? null;
  const styleKey = `voice.v28.style.${snapshot.style}` as const;

  return (
    <div data-testid="voice-v28-panel" data-tone={tone}>
      <h2>{t('voice.v28.panel.title')}</h2>
      {isDemo ? <p>{t('voice.v28.style.fallback')}</p> : null}
      <p>
        <strong>{t('voice.v28.panel.state')}:</strong>{' '}
        {t(`voice.v28.panel.${snapshot.state}`)}
        {' · '}
        {t('voice.v28.panel.floor')}: {snapshot.floor}
      </p>
      <p>
        <strong>{t('voice.v28.panel.style')}:</strong>{' '}
        {t(styleKey)}
        {' · '}
        {t('voice.v28.panel.voice')}: {snapshot.voiceId ?? '—'}
        {' · '}
        {t('voice.v28.style.rate')}: {snapshot.rate}
        {' · '}
        {t('voice.v28.style.pitch')}: {snapshot.pitch}
      </p>
      {greeting ? (
        <p>
          <strong>{t('voice.v28.panel.greeting')}:</strong> <q>{greeting}</q>
        </p>
      ) : null}
      <table>
        <thead>
          <tr>
            <th>{t('voice.v28.panel.turns')}</th>
            <th>{t('voice.v28.panel.bargeIn')}</th>
            <th>{t('voice.v28.panel.chunks')}</th>
            <th>{t('voice.v28.panel.dropped')}</th>
            <th>{t('voice.v28.panel.latency')}</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>{snapshot.turns}</td>
            <td>{snapshot.interruptions}</td>
            <td>
              {snapshot.chunksIn} / {snapshot.chunksOut}
            </td>
            <td>{snapshot.chunksDropped}</td>
            <td>{latencyP50Ms === null || latencyP50Ms === undefined ? '—' : `${latencyP50Ms}ms`}</td>
          </tr>
        </tbody>
      </table>
      <div>
        {snapshot.state !== 'paused' && snapshot.state !== 'ended' && onPause ? (
          <button type="button" onClick={() => onPause(snapshot.sessionId)}>
            {t('voice.v28.session.paused')}
          </button>
        ) : null}
        {snapshot.state === 'paused' && onResume ? (
          <button type="button" onClick={() => onResume(snapshot.sessionId)}>
            {t('voice.v28.session.resumed')}
          </button>
        ) : null}
        {snapshot.state !== 'ended' && onStop ? (
          <button type="button" onClick={() => onStop(snapshot.sessionId)}>
            {t('voice.v28.session.stopped')}
          </button>
        ) : null}
      </div>
    </div>
  );
}

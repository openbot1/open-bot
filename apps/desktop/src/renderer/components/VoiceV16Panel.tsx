import { useState } from 'react';
import { useT } from '../i18n/useT';

/**
 * Voice v16 panel (v1.17, Team T6) — realtime v4 sessions
 * (speech-to-speech, barge-in, semantic turn-taking), wake-word v4,
 * TTS streaming v2.
 *
 * Data comes via props (host builds the view-model from core
 * `buildFleetV14VoicePanel` via IPC); when there is no host wiring
 * yet it uses an internal demo store — the component never guesses
 * real numbers; the demo is clearly labelled in code.
 */

export interface VoiceV16SessionView {
  sessionId: string;
  startedAt: number;
  endedAt: number;
  bargeIns: number;
  turnTakes: number;
  wakeWordHits: number;
  ttsOnTimeFraction: number;
  status: string;
}

export interface VoiceV16PanelView {
  sessions: VoiceV16SessionView[];
  activeSessions: number;
  totalBargeIns: number;
  totalTurnTakes: number;
  totalWakeWordHits: number;
  avgTtsOnTime: number;
  summary: string;
}

const T0 = Date.UTC(2026, 10, 16, 0, 0, 0);

export function demoVoiceV16Panel(): VoiceV16PanelView {
  return {
    sessions: [
      {
        sessionId: 'v1', startedAt: T0, endedAt: T0 + 60000, bargeIns: 2, turnTakes: 5,
        wakeWordHits: 1, ttsOnTimeFraction: 0.95, status: 'ended',
      },
    ],
    activeSessions: 0,
    totalBargeIns: 2,
    totalTurnTakes: 5,
    totalWakeWordHits: 1,
    avgTtsOnTime: 0.95,
    summary: 'Demo: voice v16: 1 realtime session (0 active), 2 barge-ins, 5 semantic turn-takes, 1 wake-word hit.',
  };
}

export default function VoiceV16Panel({
  panel: panelProp,
}: {
  panel?: VoiceV16PanelView | null;
}) {
  const t = useT();
  const [panel] = useState<VoiceV16PanelView>(() => panelProp ?? demoVoiceV16Panel());

  return (
    <div>
      <h3>{t('fleetV14.voiceTitle')}</h3>
      <p>{panel.summary}</p>
      <p>{t('fleetV14.demo')}</p>
      <h4>{t('fleetV14.voiceSessions')} ({panel.sessions.length})</h4>
      {panel.sessions.length === 0 ? (
        <p>{t('fleetV14.voiceNoSessions')}</p>
      ) : (
        <ul>
          {panel.sessions.map((s) => (
            <li key={s.sessionId}>
              {s.sessionId} — {t('fleetV14.voiceStatus')}: {s.status} ({t('fleetV14.voiceActive')}: {panel.activeSessions}) — {t('fleetV14.voiceBargeIns')}: {s.bargeIns} — {t('fleetV14.voiceTurnTakes')}: {s.turnTakes} — {t('fleetV14.voiceWakeWord')}: {s.wakeWordHits} — {t('fleetV14.voiceTts')}: {Math.round(s.ttsOnTimeFraction * 100)}%
            </li>
          ))}
        </ul>
      )}
      <p>
        {t('fleetV14.voiceBargeIns')}: {panel.totalBargeIns} — {t('fleetV14.voiceTurnTakes')}: {panel.totalTurnTakes} — {t('fleetV14.voiceWakeWord')}: {panel.totalWakeWordHits}
      </p>
    </div>
  );
}

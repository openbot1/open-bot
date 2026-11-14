import { useT } from '../i18n/useT';
import type { VoiceCallState } from '@open-bot/core';

/** One voice offered in the v6 switcher. */
export interface VoiceStateBadgeVoice {
  id: string;
  name: string;
  lang: string;
}

interface Props {
  /** Explicit v6 call state (what the panel shows, never a guess). */
  callState: VoiceCallState;
  /** Display name of the current voice (null when none picked yet). */
  voiceName: string | null;
  /** True when the network guard degraded the call to local-only. */
  networkDegraded: boolean;
  /** Voices the user can switch to (null/empty = no switcher). */
  voices?: VoiceStateBadgeVoice[] | null;
  /** Id of the current voice (for the select value). */
  voiceId?: string | null;
  /** Fired when the user picks another voice. */
  onVoiceChange?: (id: string) => void;
}

const STATE_COLORS: Record<VoiceCallState, string> = {
  idle: '#6b7280',
  connecting: '#d48806',
  listening: '#2e7d32',
  speaking: '#2563eb',
  interrupted: '#d48806',
  reconnecting: '#d48806',
  degraded: '#c0392b',
  ended: '#6b7280',
};

const STATE_KEYS: Record<VoiceCallState, string> = {
  idle: 'voice.realtime.v6.stateIdle',
  connecting: 'voice.realtime.v6.stateConnecting',
  listening: 'voice.realtime.v6.stateListening',
  speaking: 'voice.realtime.v6.stateSpeaking',
  interrupted: 'voice.realtime.v6.stateInterrupted',
  reconnecting: 'voice.realtime.v6.stateReconnecting',
  degraded: 'voice.realtime.v6.stateDegraded',
  ended: 'voice.realtime.v6.stateEnded',
};

/**
 * VoiceStateBadge (v1.07, Team T5) — the v6 call state + voice,
 * rendered inside RealtimeVoicePanel under the panel state line.
 *
 * Presentational: the state comes from the v6 session's explicit
 * state machine (never guessed from the last event), the voice
 * switch is a plain select over the switchable voices, and the
 * degraded notice appears only while the network guard has the
 * call in degraded mode (local STT/TTS only). No callbacks without
 * `onVoiceChange` — the select simply does not render.
 */
export default function VoiceStateBadge({
  callState,
  voiceName,
  networkDegraded,
  voices,
  voiceId,
  onVoiceChange,
}: Props) {
  const t = useT();
  const color = STATE_COLORS[callState];
  const showSwitcher = onVoiceChange && voices && voices.length > 0;
  return (
    <div data-testid="voice-state-badge" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span
          style={{
            display: 'inline-block',
            width: 10,
            height: 10,
            borderRadius: '50%',
            background: color,
          }}
        />
        <strong style={{ color }}>{t(STATE_KEYS[callState])}</strong>
        {voiceName && (
          <span style={{ color: '#6b7280' }}>
            {t('voice.v6.currentVoice', { name: voiceName })}
          </span>
        )}
      </div>
      {networkDegraded && (
        <div style={{ color: '#c0392b', fontSize: 12 }}>{t('voice.v6.networkDegraded')}</div>
      )}
      {showSwitcher && (
        <div className="field" style={{ maxWidth: 320 }}>
          <label htmlFor="voice-v6-switch">{t('voice.v6.voiceLabel')}</label>
          <select
            id="voice-v6-switch"
            data-testid="voice-v6-switch"
            value={voiceId ?? ''}
            onChange={(e) => onVoiceChange(e.target.value)}
          >
            {voices.map((voice) => (
              <option key={voice.id} value={voice.id}>
                {voice.name} ({voice.lang})
              </option>
            ))}
          </select>
        </div>
      )}
    </div>
  );
}

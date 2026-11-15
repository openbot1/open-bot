/**
 * VoiceWaveformV10 — realtime voice waveform + status (v1.11, Team T5).
 *
 * The v10 voice panel's live strip: a row of vertical bars drawn
 * from the smoothed mic levels (`VoiceV10WaveformBarView`), a level
 * meter with a peak marker, and the realtime status badge (state +
 * mode + fallback). Props only — the parent owns the level history
 * (see `voiceSessionV10View.ts`: `waveformBarsV10` +
 * `appendWaveformLevelV10`) and passes the bars in, so this
 * component never touches IPC, the core, or a sound card. The
 * interim transcript (when present) renders under the waveform
 * with its stability shown ("…" while unstable, no marker once
 * stable), and a batch-mode fallback shows the fallback banner
 * instead of the realtime badge.
 */
import type { VoiceV10WaveformBarView } from '../../voice/voiceSessionV10View';
import { formatVoiceV10Latency, type VoiceV10FallbackView, type VoiceV10LatencyView } from '../../voice/voiceSessionV10View';
import { useT } from '../../i18n/useT';

export interface VoiceWaveformV10Props {
  /** Waveform bars (level + peak per bar). */
  bars: VoiceV10WaveformBarView[];
  /** Current smoothed mic level 0..1. */
  level: number;
  /** Current peak hold 0..1. */
  peak: number;
  /** Session status, e.g. `listening`, `speaking`, `degraded`. */
  status: string;
  /** Pipeline mode: `realtime` or `batch`. */
  mode: 'realtime' | 'batch';
  /** Live interim hypothesis (empty when none). */
  interimText: string;
  /** True when the interim hypothesis is stable. */
  interimStable: boolean;
  /** Latencies (first partial / turn), null when unknown. */
  latency: VoiceV10LatencyView;
  /** Fallback banner (visible only in batch mode after a drop). */
  fallback: VoiceV10FallbackView;
  /** True when the agent is ducked (user speaking over it). */
  ducked: boolean;
}

function statusClass(status: string): string {
  switch (status) {
    case 'listening':
      return 'voice-waveform-v10--listening';
    case 'speaking':
      return 'voice-waveform-v10--speaking';
    case 'processing':
      return 'voice-waveform-v10--processing';
    case 'degraded':
      return 'voice-waveform-v10--degraded';
    case 'closed':
      return 'voice-waveform-v10--closed';
    default:
      return 'voice-waveform-v10--idle';
  }
}

export default function VoiceWaveformV10(props: VoiceWaveformV10Props): React.ReactElement {
  const t = useT();
  const { bars, level, peak, status, mode, interimText, interimStable, latency, fallback, ducked } = props;
  const levelPct = Math.round(Math.min(1, Math.max(0, level)) * 100);
  const peakPct = Math.round(Math.min(1, Math.max(0, peak)) * 100);
  return (
    <div className={`voice-waveform-v10 ${statusClass(status)}`} data-testid="voice-waveform-v10">
      <div className="voice-waveform-v10__header">
        <span className="voice-waveform-v10__status" data-testid="voice-waveform-v10-status">
          {t(`voice.realtime.v10.status.${status}` as never)}
        </span>
        <span className="voice-waveform-v10__mode" data-testid="voice-waveform-v10-mode">
          {mode === 'batch' ? t('voice.realtime.v10.batchMode') : t('voice.realtime.v10.realtimeMode')}
        </span>
        {ducked ? (
          <span className="voice-waveform-v10__ducked" data-testid="voice-waveform-v10-ducked">
            {t('voice.realtime.v10.ducked')}
          </span>
        ) : null}
      </div>
      <div className="voice-waveform-v10__bars" aria-hidden="true">
        {bars.map((bar) => (
          <span
            key={bar.index}
            className="voice-waveform-v10__bar"
            style={{ height: `${Math.round(Math.max(0.06, bar.level) * 100)}%` }}
            title={`bar ${bar.index}: level ${bar.level.toFixed(2)}, peak ${bar.peak.toFixed(2)}`}
          />
        ))}
      </div>
      <div className="voice-waveform-v10__meter" role="meter" aria-valuenow={levelPct} aria-valuemin={0} aria-valuemax={100}>
        <span className="voice-waveform-v10__meter-fill" style={{ width: `${levelPct}%` }} />
        <span className="voice-waveform-v10__meter-peak" style={{ left: `${peakPct}%` }} />
      </div>
      <div className="voice-waveform-v10__latency" data-testid="voice-waveform-v10-latency">
        {t('voice.realtime.v10.firstPartial')}: {formatVoiceV10Latency(latency.firstPartialMs)}
        {' · '}
        {t('voice.realtime.v10.turnLatency')}: {formatVoiceV10Latency(latency.turnMs)}
      </div>
      {interimText.trim().length > 0 ? (
        <div className="voice-waveform-v10__interim" data-testid="voice-waveform-v10-interim">
          {interimText}
          {interimStable ? '' : ' …'}
        </div>
      ) : null}
      {fallback.visible ? (
        <div className="voice-waveform-v10__fallback" data-testid="voice-waveform-v10-fallback">
          {t('voice.realtime.v10.fallbackNotice')}: {fallback.detail}
          {fallback.willRetry ? ` (${t('voice.realtime.v10.willRetry')})` : ''}
        </div>
      ) : null}
    </div>
  );
}
